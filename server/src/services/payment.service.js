'use strict';
const crypto = require('crypto');
/**
 * 리뷰비 입금 자동화 M1 — 입금대상 추출 · 은행별 분류 · 회차(다운로드) 기록
 *
 * 설계 문서: frontend/docs/prd-payment-transfer.html (v1.4)
 *
 * ★★ 이 서비스의 쓰기 표면은 payment_batches / payment_batch_items **두 테이블뿐**이다.
 *    review_index·order_submissions·recruit_campaigns·시트는 **읽기만** 한다.
 *    (시트 입금칸 기록은 M2 이며 이 파일에 없다 — 라이브 경로 무접촉)
 *
 * ★★ 확정 규칙(완화 금지)
 *   ① 이체 단위 = **건별(A안)**. 시트 행 1개 = 이체 1줄. 합산하지 않는다.
 *   ② 대상 = 리뷰 제출완료 ∧ 미입금 ∧ **다운로드 이력 없음**.
 *      "다운로드 이력 있으면 무조건 제외"가 이중입금 방지의 핵심이고,
 *      DB 부분유니크(uq_payment_items_active)가 코드 실수까지 막는 최종 방어선이다.
 *   ③ 금액·통장표시·계좌는 **회차 생성 시점 값을 박제**한다(스냅샷). 나중에 규칙이
 *      바뀌어도 과거 표기가 흔들리지 않는다(기간별 리뷰비 사고와 같은 함정).
 *   ④ 판정 실패는 **추측하지 않는다** — 은행 미지정·계좌미비로 분류해 화면에 드러낸다
 *      (조용한 누락 금지).
 */

const pool = require('../db/pool');           // ★ 이 모듈은 pool 을 직접 export 한다(구조분해 금지)
const { logger } = require('../utils/logger'); // ★ 반대로 logger 는 { logger } 구조분해다
const { PAYMENT_COL_KEYWORDS } = require('./search.service');
const { resolveReviewFee, sheetDateToIso, toKstDate } = require('../utils/campaignFee');
const { resolveBank, bankFormLabel, normalizeAccount, normalizeMemo } = require('../utils/bankCodes');
const _bankOv = require('./bankNameOverride.service');   // 화면에서 고친 은행 표기 → 판정 표에 적용
const { extractAmountNumber, EXACT_KEYS: AMOUNT_EXACT_KEYS } = require('../utils/paymentAmount');
// 시트 링크를 만들 수 있는지(= 진짜 구글시트가 있는지) 판정 — 접두 사본 금지
const { isVirtualSheetId } = require('./sheetlessAccept.service');
// 이름 정규화는 신원 판정(identity.service)과 **같은 함수**를 쓴다(사본 금지 — 판정이 갈리면 안 된다)
const { normName } = require('./identity.service');
// 작업담당 실명 → 리뷰웹 닉네임(만두·망고) 매핑 단일 출처(065). 사본을 두면 화면마다 담당자가 갈린다.
const { mapWorkManager } = require('../utils/workManager');
// 작업 조건 카드가 담당자를 닉네임으로 바꿀 때 쓰는 그 맵(사본 금지 — 두 화면의 이름이 갈린다).
const { getNicknameMap } = require('./adminNickname.service');

const BANK_LABEL = { kbank: '케이뱅크', hana: '하나은행', manual: '수동 이력' };

function accountFingerprint(value) {
  const account = normalizeAccount(value);
  return account ? crypto.createHash('sha256').update(account).digest('hex') : '';
}
function snapshotFingerprint(bankName, account, holder) {
  return crypto.createHash('sha256').update([String(bankName || '').trim(), normalizeAccount(account), String(holder || '').trim()].join('\u0000')).digest('hex');
}

function compareAccountSnapshot(item, current) {
  const itemId = item && item.id;
  const reviewerId = item && (item.account_reviewer_id || item.accountReviewerId);
  const source = item && (item.account_source || item.accountSource);
  const subPhone8 = item && (item.account_sub_phone8 || item.accountSubPhone8 || '');
  const snapshotAccount = item && (item.bank_account || item.bankAccount);
  const savedFingerprint = item && (item.account_snapshot_fingerprint || item.accountSnapshotFingerprint)
    || snapshotFingerprint(item && (item.bank_name || item.bankName), snapshotAccount, item && (item.account_holder || item.accountHolder));
  if (!item || !reviewerId || !source || !savedFingerprint || !current) return { state: 'unverifiable', itemId };
  const sameIdentity = String(reviewerId) === String(current.reviewerId)
    && String(source) === (current.isSub ? 'sub' : 'self')
    && String(subPhone8) === (current.isSub ? String(current.subPhone8 || '') : '');
  if (!sameIdentity) return { state: 'mismatch', itemId };
  return savedFingerprint === snapshotFingerprint(current.bankName, current.bankAccount, current.accountHolder)
    ? { state: 'match', itemId } : { state: 'mismatch', itemId };
}

/** 작업오더 물건비 수취방식 → 이체 은행 (사용자 확정 규칙)
 *  현금이체 → 하나은행 / 수수료(세금계산서) → 케이뱅크 */
function bankFromGoodsCostType(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/현금/.test(s)) return 'hana';
  if (/계산서|세금|수수료/.test(s)) return 'kbank';
  return null;
}

/**
 * 어떤 표기로 저장돼 있든 `kbank` | `hana` 로 해석 — **판정 단일 출처**.
 *
 * ★★ 저장소가 둘이고 표기가 다르다:
 *    · `recruit_campaigns.transfer_bank` = 코드값(`kbank`/`hana`, 086 이 그렇게 저장)
 *    · `tab_configs.transfer_bank`       = **한글 라벨**(`케이뱅크`/`하나은행`) —
 *      관리자 대시보드 탭설정 팝오버가 예전부터 그 형식으로 저장해 왔고,
 *      그 화면이 `t.transferBank === '케이뱅크'` 로 **문자열을 그대로 비교**하므로
 *      형식을 바꾸면 남의 화면 배지가 조용히 죽는다(index-app.js).
 *
 * ★ 확실히 해석되는 값만 인정하고 **모르는 값은 null**(추측 금지) — 옛 자유입력이
 *   엉뚱한 은행으로 해석돼 남의 계좌로 송금되는 것보다 "미지정"이 낫다.
 */
function normalizeBankChoice(v) {
  const s = String(v == null ? '' : v).replace(/\s/g, '');
  if (!s) return null;
  if (s === 'kbank' || s === 'hana') return s;
  if (/^케이뱅크$|^케뱅$|^kbank$/i.test(s)) return 'kbank';
  if (/^하나은행$|^하나$|^KEB하나은행$|^KEB하나$|^hana$/i.test(s)) return 'hana';
  return null;
}

/** `tab_configs.transfer_bank` 에 **되돌려 쓸 때** 의 표기(= 기존 화면이 읽는 한글 라벨) */
function tabBankLabel(bank) { return BANK_LABEL[bank] || ''; }

/**
 * 입금관리의 **담당자** — 작업 화면(작업 조건 카드)이 보여주는 그 값과 같아야 한다.
 *
 * ★★ 사고(2026-08-24 회차 #18): 입금관리 담당자 필터는 `tab_configs.manager` 만 봤고,
 *    작업 화면은 작업오더(`work_orders.manager_name`)를 닉네임으로 바꿔 보여줬다.
 *    출처가 둘이라 오더 담당자가 나중에 바뀐 작업은 **탭 값이 옛 담당자로 남아**,
 *    "망고만 선택했는데 만두 작업의 이체건이 서식에 딸려오는" 상태가 됐다.
 *    → 판정 출처를 작업오더로 맞추고(작업 화면과 한 벌), 탭 설정은 **오더가 담당자를
 *      말해주지 않을 때(랜덤·미매핑·오더 없음)만** 쓰는 폴백으로 내린다.
 *
 * ★★ 탭 값이 낡는 이유는 접수 업서트가 **blank-only**(`manager = COALESCE(NULLIF(tab_configs.manager,''), …)`)
 *    이기 때문이다 — 한 번 채워진 뒤로는 재접수로도 영영 안 바뀐다. 그래서 폴백이지 기준이 아니다.
 *
 * ★ 오더 쪽 원천은 둘: `work_manager`(인트라넷 작업담당, 065 표준키) → `manager_name`
 *   (라벨은 '담당AE' 지만 실제 값이 리뷰웹 관리자 — 작업 조건 카드가 읽는 그 칸).
 * ★ 닉네임 치환은 `adminNickname` 맵 → `mapWorkManager`(065) 순서 — 둘 다 기존 단일 출처이고,
 *   어느 쪽도 모르는 값은 **원문을 그대로** 둔다(임의 해석 금지 · 조용한 담당자 변경 금지).
 *
 * @returns {{manager:string, managerSource:('order'|'tab'|null)}}
 */
function resolveWorkManager({ orderWorkManager, orderManager, tabManager, nickMap } = {}) {
  const nick = v => {
    const raw = String(v == null ? '' : v).trim();
    return raw ? ((nickMap && nickMap[raw]) || mapWorkManager(raw) || '') : '';
  };
  const fromOrder = nick(orderWorkManager) || nick(orderManager);
  if (fromOrder) return { manager: fromOrder, managerSource: 'order' };
  const tab = String(tabManager == null ? '' : tabManager).trim();
  if (!tab) return { manager: '', managerSource: null };
  // 탭에 실명이 저장돼 있어도 화면에는 닉네임 하나로 보인다(같은 사람이 칩 둘로 갈리지 않게).
  return { manager: mapWorkManager(tab) || tab, managerSource: 'tab' };
}

function _int(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/* ══════════════════════════════════════════════════════════
   1) 입금대상 추출
   ══════════════════════════════════════════════════════════ */

/**
 * 오늘 입금해야 할 건 목록.
 * @param {object} opts { sheetId?, tabName? } 특정 탭만 보고 싶을 때(선택)
 * @returns {{items:Array, summary:object}}
 */
async function listPaymentTargets(opts = {}) {
  // ★ 은행 표기 오버레이(화면에서 고친 정식명·자동인식 표기)를 판정 **전에** 적용한다.
  //   실패해도 throw 하지 않고 기본 표로 진행한다(fail-open — 조회 하나 때문에 입금대상이 통째로 죽지 않게).
  await _bankOv.ensureBankOverrides();
  const payPatterns = PAYMENT_COL_KEYWORDS.map(k => '%' + k + '%');
  // $1 = 입금열 키워드(미입금 판정) · $2 = 결제금액 정확일치 후보(상품비 폴백 필터)
  // ★ 선택 필터(sheetId·tabName)는 뒤에 push 되어 $3·$4 가 된다 — 자리표시자는 params.length 로 뽑으므로
  //   여기 순서만 지키면 어긋나지 않는다.
  const params = [payPatterns, AMOUNT_EXACT_KEYS];
  const where = [
    'ri.is_submitted = TRUE',
    'ri.row_index IS NOT NULL',
    "COALESCE(ri.phone8,'') <> ''",
    // 미입금 — search.service._isPaid 와 동일 규칙(SQL 판)
    `NOT (ri.is_submitted2 = 'PAID' OR EXISTS (
        SELECT 1 FROM jsonb_each_text(COALESCE(ri.row_json, '{}'::jsonb)) kv
         WHERE kv.key ILIKE ANY($1) AND btrim(kv.value) <> ''))`,
    // 작업보드에서 수동으로 `8/11`을 입력한 행은 실제 입금완료로 간주한다.
    // 취소·공란·오류 문구는 제외하지 않으며, participant seq로 같은 행만 연결한다.
    `NOT EXISTS (
        SELECT 1
          FROM campaign_participants cp
          JOIN participant_edits pe
            ON pe.sheet_id = cp.sheet_id AND pe.tab_name = cp.tab_name
           AND ((pe.anchor_type = 'order' AND cp.order_submission_id::text = pe.anchor_value)
             OR (pe.anchor_type = 'manual' AND cp.id::text = pe.anchor_value)
             OR (pe.anchor_type = 'identity' AND cp.identity_key = pe.anchor_value))
         WHERE cp.sheet_id = ri.sheet_id AND cp.tab_name = ri.tab_name
           AND cp.seq = ri.row_index AND cp.deleted_at IS NULL AND cp.active = TRUE
           AND pe.field = 'col:입금' AND pe.kind = 'text' AND pe.reverted_at IS NULL
           AND btrim(pe.value_text) = '8/11')`,
    // ★ 다운로드 이력 잠금 — 살아있는 회차 항목이 있으면 제외
    `NOT EXISTS (
        SELECT 1 FROM payment_batch_items pi
         WHERE pi.sheet_id = ri.sheet_id AND pi.tab_name = ri.tab_name
           AND pi.row_index = ri.row_index AND pi.status IN ('pending','paid'))`,
  ];
  if (opts.sheetId) { params.push(opts.sheetId); where.push(`ri.sheet_id = $${params.length}`); }
  if (opts.tabName) { params.push(opts.tabName); where.push(`ri.tab_name = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName", ri.row_index AS "rowIndex",
            ri.reviewer_name AS "reviewerName", ri.phone8 AS "phone8",
            ri.start_date AS "startDate", ri.product_name AS "productName",
            -- 상품비 폴백 재료(주문 원장에 없는 행용). ★ row_json 을 통째로 끌어오지 않는다 —
            --   '금액' 이 든 칸만 남긴 작은 객체를 만들고 **최종 판정은 extractAmountNumber** 가 한다
            --   (SQL 에 판정 사본을 두면 레거시 화면과 금액이 갈린다).
            (SELECT jsonb_object_agg(kv.key, kv.value)
               FROM jsonb_each_text(COALESCE(ri.row_json, '{}'::jsonb)) kv
              WHERE replace(kv.key, ' ', '') LIKE '%금액%'
                 OR replace(kv.key, ' ', '') = ANY($2)) AS "amountCells"
       FROM review_index ri
      WHERE ${where.join(' AND ')}
      ORDER BY ri.sheet_id, ri.tab_name, ri.row_index
      LIMIT 2000`,
    params
  );
  if (!rows.length) return { items: [], summary: _summarize([]) };

  const sheetIds = [...new Set(rows.map(r => r.sheetId))];
  const tabNames = [...new Set(rows.map(r => r.tabName))];
  const phone8s = [...new Set(rows.map(r => r.phone8).filter(Boolean))];

  const [campMap, orderMap, acctMap, tabMap] = await Promise.all([
    _loadCampaigns(sheetIds, tabNames),
    _loadOrderPrices(sheetIds, tabNames),
    _loadAccounts(phone8s),
    _loadTabMeta(sheetIds, tabNames),
  ]);

  // ★ 연락처(뒤 8자리)로 계좌를 못 찾은 행만 **소유자 링크**로 한 번 더 찾는다.
  //   (타계정을 이름만 등록했거나 번호가 다르게 적힌 경우 — 실사고 2026-08-19)
  const unresolved = rows.filter(r => !acctMap[r.phone8]);
  const ownerAcctMap = unresolved.length ? await _loadOwnerAccountsByRow(unresolved) : {};

  const items = rows.map(r => {
    const key = r.sheetId + '||' + r.tabName;
    const camp = campMap[key] || null;
    const tab = tabMap[key] || null;
    const ord = orderMap[key + '||' + r.rowIndex] || null;
    // 계좌 해석 순서 = ① 등록 계좌(연락처 매칭) → ② 소유자 링크 → ③ **그 건의 제출 계좌**
    // ★ 등록 계좌가 언제나 이긴다(관리 원장이 진실원본 — 기존 동작 보존). ③ 은 등록된 계좌를
    //   어디서도 못 찾았을 때만 쓰는 마지막 근거이고, accountRef 가 없어 화면 보완 대상이 아니다.
    const acct = acctMap[r.phone8] || ownerAcctMap[key + '||' + r.rowIndex] || _orderAccount(ord, r) || null;

    // 상품비 = 그 행의 실제 제출 결제금액(주문 원장).
    // ★ 주문 원장에 없는 행(옛 작업·직원 수기 입력)은 **시트 결제금액 칸**으로 폴백한다 —
    //   그 칸이 그 행의 실제 결제금액이고, 폴백이 없으면 그런 행은 영영 0원 보류로 남는다.
    //   출처(priceSource)를 함께 실어 화면이 "시트에서 읽음"을 드러낸다(조용한 추정 금지).
    const orderPrice = ord ? _int(ord.price) : 0;
    const sheetPrice = orderPrice ? 0 : extractAmountNumber(r.amountCells);
    const productPrice = orderPrice || sheetPrice;
    const priceSource = orderPrice ? 'order' : (sheetPrice ? 'sheet' : null);

    // 리뷰비 = 082 단일 출처(스냅샷 → 구간표 → 폴백). 판정 자체는 `resolveReviewFee` 가 한다.
    // ★ 폴백 순서만 이체은행·통장표시와 **같은 규율**로 넓혔다: 공고 값 → **탭 값**(128).
    //   공고가 없는 작업(옛 작업·외부모집)은 리뷰비를 넣을 칸이 아예 없어 상품비만 이체돼 왔다.
    // ★ 스냅샷·구간표는 여전히 최우선(완화 금지) — 탭 값은 그 뒤의 폴백일 뿐이다.
    const tabFee = tab && tab.reviewFee != null ? tab.reviewFee : null;
    const campFee = camp && camp.reviewFee != null ? camp.reviewFee : null;
    const feeInfo = resolveReviewFee({
      snapshot: ord ? ord.feeSnapshot : null,
      schedules: camp ? camp.schedules : [],
      orderDate: ord ? ord.orderDate : null,
      sheetDate: camp ? sheetDateToIso(r.startDate, camp.campStartDate) : null,
      fallback: campFee != null ? campFee : (tabFee != null ? tabFee : 0),
    });
    const fee = feeInfo.fee;
    // 이 금액이 **어디서 왔는지** — 화면이 "공고 값" / "탭 설정" 을 구분해 말한다(조용한 추정 금지).
    const feeSource = feeInfo.source === 'snapshot' ? 'snapshot'
      : feeInfo.source === 'schedule' ? 'schedule'
      : campFee != null ? 'campaign'
      : tabFee != null ? 'tab' : null;

    // 은행 우선순위 = 공고(사람이 정한 값) → **탭 설정** → 작업오더 물건비 자동판정.
    // ★ 탭 설정(`tab_configs.transfer_bank`)은 관리자 대시보드 탭설정에서 예전부터 채워 온 칸인데
    //   M1 이 그것을 안 봐서, 공고가 없는 옛 작업이 전부 '이체은행 미지정' 으로 잠겨 있었다.
    const campBank = normalizeBankChoice(camp && camp.transferBank);
    const tabBank = normalizeBankChoice(tab && tab.transferBank);
    const autoBank = bankFromGoodsCostType((camp && camp.goodsCostType) || (tab && tab.goodsCostType));
    const bank = campBank || tabBank || autoBank || null;
    const bankSource = campBank ? 'campaign' : tabBank ? 'tab' : bank ? 'auto' : null;
    const bankAuto = bankSource === 'auto';

    const resolved = acct ? resolveBank(acct.bankName) : null;
    const account = acct ? normalizeAccount(acct.bankAccount) : '';
    // 통장표시도 같은 순서(공고 → 탭 `deposit_name`)
    const campMemo = normalizeMemo((camp && camp.transferMemo) || '');
    const tabMemo = normalizeMemo((tab && tab.depositName) || '');
    const memo = campMemo || tabMemo;
    const memoSource = campMemo ? 'campaign' : tabMemo ? 'tab' : null;
    const amount = productPrice + fee;

    const issues = [];      // 있으면 다운로드에서 제외(막는 사유)
    const warnings = [];    // 진행은 되지만 사람이 알아야 하는 것
    if (!bank) issues.push('no_bank');
    if (!acct) issues.push('no_reviewer');
    else {
      if (!resolved) issues.push('bank_unknown');
      if (!account) issues.push('no_account');
      if (!String(acct.accountHolder || '').trim()) issues.push('no_holder');
    }
    if (!productPrice) issues.push('no_price');
    if (amount <= 0) issues.push('zero_amount');
    // 통장표시가 없어도 이체 자체는 되지만(양식상 필수 아님) 리뷰어가 무슨 돈인지 모른다 → 경고만.
    if (!memo) warnings.push('no_memo');
    /* 리뷰비 경고는 **금액이 0이라서**가 아니라 **근거를 못 찾아서** 띄운다.
         이 계정은 상품비만 주는 작업이 다수(실측 공고 32건 중 27건이 0원)라, 0 을 경고로 두면
         입금관리가 상시 경고로 뒤덮여 진짜 신호(계좌·은행 미비)가 묻힌다.
       ★ 공고·탭·스냅샷·구간표 어디서든 값이 왔으면(feeSource) 그 0 은 사람이 정한 무상이다.
       ⚠ 한계: 발행 폼에서 리뷰비 칸을 비우면 서버가 0 으로 저장하므로 "0원으로 정함"과
         "안 넣음"은 DB 에서 구분되지 않는다 — 사용자 확정(2026-08-19)으로 0 = 무상으로 읽는다. */
    if (!fee && !feeSource) warnings.push('no_review_fee');

    return {
      sheetId: r.sheetId, tabName: r.tabName, rowIndex: r.rowIndex,
      tabLabel: (tab && tab.label) || r.tabName,
      // 시트 바로가기 — 아직 구글시트를 직접 열어 확인해야 하는 데이터가 있다(결제금액 칸 등).
      // ★ 무시트/미등록이면 빈 값 = 화면이 버튼을 비활성으로 두고 **사유를 말한다**(죽은 링크 금지).
      sheetUrl: tab ? tab.sheetUrl : '',
      sheetless: !!(tab && tab.sheetless),
      // 작업보드 바로가기 재료 — ★ 화면이 gid 를 추측하지 않게 서버가 실어 준다(리네임 대비).
      tabGid: tab ? (tab.tabGid || '') : '',
      manager: tab ? (tab.manager || '') : '',
      // 담당자를 어디서 읽었는지 — 'order' = 작업 화면과 같은 값 / 'tab' = 탭 설정 폴백
      managerSource: tab ? (tab.managerSource || null) : null,
      reviewerName: r.reviewerName || '', phone8: r.phone8 || '',
      startDate: r.startDate || '', productName: r.productName || '',
      campaignId: camp ? camp.id : null,
      campaignTitle: camp ? camp.title : '',
      bank, bankAuto, bankSource, bankLabel: bank ? BANK_LABEL[bank] : '',
      bankName: acct ? (acct.bankName || '') : '',
      bankCode: resolved ? resolved.code : '',
      bankOfficial: resolved ? resolved.name : '',
      bankAccount: account,
      accountHolder: acct ? (acct.accountHolder || '') : '',
      isSub: acct ? !!acct.isSub : false,
      // ★ 계좌 **명의**(누구 이름으로 등록된 계좌인가) — 시트의 이름 칸(`reviewerName`)은
      //   탭마다 주문자/수취인 중 무엇이 잡혔는지 달라 명의 판별에 쓸 수 없다.
      //   타계정이면 `accountOwner` 가 그 명의를 등록한 소유자(본계정) 이름.
      accountName: acct ? (acct.name || '') : '',
      accountOwner: acct ? (acct.ownerName || '') : '',
      // 계좌를 고칠 대상 지목 — ★ phone8 은 GENERATED·비유니크라 키로 쓰지 않는다(같은 뒤8자리 타인 행 오염).
      //   본계정은 reviewers.id, 타계정은 소유자 id + 그 명의 phone8.
      // ★ 폴백(소유자 링크)로 찾은 건은 그 명의가 `sub_accounts` 에 **실제로 등록돼 있을 때만**
      //   타계정으로 지목한다 — 없는 명의를 지목하면 보완 저장이 `sub_not_found` 로 죽는다.
      accountRef: acct && acct.reviewerId
        ? { reviewerId: acct.reviewerId,
            subPhone8: acct.isSub ? (acct.subPhone8 === undefined ? r.phone8 : acct.subPhone8) : null }
        : null,
      // 계좌를 어떻게 찾았는지 — self/sub(연락처 매칭) · owner_order/owner_link(소유자 링크 폴백)
      accountSource: acct ? (acct.source || (acct.isSub ? 'sub' : 'self')) : null,
      productPrice, reviewFee: fee, amount, priceSource, feeSource,
      tabReviewFee: tabFee, campaignReviewFee: campFee,
      transferMemo: memo, memoSource,
      issues, warnings,
      payable: issues.length === 0,
    };
  });

  return { items, summary: _summarize(items) };
}

function _summarize(items) {
  const s = {
    total: items.length, totalAmount: 0,
    kbank: 0, kbankAmount: 0, hana: 0, hanaAmount: 0,
    noBank: 0, noAccount: 0, blocked: 0, noMemo: 0,
  };
  for (const it of items) {
    if (it.payable) {
      s.totalAmount += it.amount;
      if ((it.warnings || []).includes('no_memo')) s.noMemo++;
      if (it.bank === 'kbank') { s.kbank++; s.kbankAmount += it.amount; }
      else if (it.bank === 'hana') { s.hana++; s.hanaAmount += it.amount; }
    } else {
      s.blocked++;
      if (it.issues.includes('no_bank')) s.noBank++;
      if (it.issues.some(k => ['no_reviewer', 'bank_unknown', 'no_account', 'no_holder'].includes(k))) s.noAccount++;
    }
  }
  return s;
}

/** 탭별 연결 공고(이체설정·리뷰비·구간) + 작업오더 물건비 수취방식 */
async function _loadCampaigns(sheetIds, tabNames) {
  const map = {};
  if (!sheetIds.length) return map;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.linked_sheet_id, c.linked_tab_name)
            c.id, c.title, c.linked_sheet_id AS "sheetId", c.linked_tab_name AS "tabName",
            c.review_fee AS "reviewFee",
            c.transfer_bank AS "transferBank", c.transfer_memo AS "transferMemo",
            to_char(c.start_date,'YYYY-MM-DD') AS "campStartDate",
            wo.goods_cost_type AS "goodsCostType"
       FROM recruit_campaigns c
       LEFT JOIN LATERAL (
            SELECT w.goods_cost_type FROM work_orders w
             WHERE w.deleted_at IS NULL
               AND w.linked_tab_sheet_id = c.linked_sheet_id
               AND w.linked_tab_name = c.linked_tab_name
             ORDER BY w.created_at DESC LIMIT 1) wo ON TRUE
      WHERE c.linked_sheet_id = ANY($1) AND c.linked_tab_name = ANY($2)
      ORDER BY c.linked_sheet_id, c.linked_tab_name, c.created_at DESC`,
    [sheetIds, tabNames]
  );
  for (const c of rows) {
    map[c.sheetId + '||' + c.tabName] = {
      /* 0 을 NULL 로 접지 말 것 — "0원으로 정한 무상 작업"과 "값이 없는 공고"는 다르다.
         종전 COALESCE(...,0) + || 0 이 둘을 같은 값으로 만들어, 무상 작업 전건이
         no_review_fee 경고를 달았다(실측 2026-08-19 위프 800건 24/24). */
      id: c.id, title: c.title || '', reviewFee: (c.reviewFee == null ? null : Number(c.reviewFee)),
      transferBank: c.transferBank || null, transferMemo: c.transferMemo || '',
      campStartDate: c.campStartDate || null, goodsCostType: c.goodsCostType || '',
      schedules: [],
    };
  }
  // 기간별 리뷰비 구간(082) — 실패해도 기존 review_fee 로 계산된다(fail-soft)
  try {
    const ids = rows.map(r => r.id).filter(Boolean);
    if (ids.length) {
      const { rows: fs } = await pool.query(
        `SELECT campaign_id AS "campaignId", to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom",
                review_fee AS "reviewFee"
           FROM campaign_fee_schedules WHERE campaign_id = ANY($1) ORDER BY campaign_id, effective_from`,
        [ids]);
      const by = new Map();
      for (const f of fs) {
        if (!by.has(f.campaignId)) by.set(f.campaignId, []);
        by.get(f.campaignId).push({ effectiveFrom: f.effectiveFrom, reviewFee: f.reviewFee });
      }
      for (const k of Object.keys(map)) map[k].schedules = by.get(map[k].id) || [];
    }
  } catch (e) { logger.warn('[payment] 리뷰비 구간 조회 실패(기존 값 사용): ' + e.message); }
  return map;
}

/** 행별 실제 결제금액(상품비) + 리뷰비 스냅샷 근거 — 주문 원장 */
async function _loadOrderPrices(sheetIds, tabNames) {
  const map = {};
  if (!sheetIds.length) return map;
  const { rows } = await pool.query(
    // ★ order_submissions 의 제출 시각 컬럼은 **submitted_at** 이다(created_at 이 아니다 — 001:179).
    //   틀리면 42703 으로 이 쿼리가 통째로 죽어 입금대상 화면이 서버오류가 된다.
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", sheet_row AS "sheetRow",
            price, review_fee_snapshot AS "feeSnapshot", submitted_at AS "orderedAt",
            -- ★ 그 건의 구매양식으로 **리뷰어가 직접 적어 낸 계좌**(035). 등록 계좌를 못 찾을 때의
            --   마지막 근거다 — 이걸 안 보면 시트에 계좌가 멀쩡히 있는 건도 영구 보류된다.
            bank AS "bank", account AS "account", depositor AS "depositor"
       FROM order_submissions
      WHERE deleted_at IS NULL AND sheet_row IS NOT NULL
        AND sheet_id = ANY($1) AND tab_name = ANY($2)`,
    [sheetIds, tabNames]
  );
  for (const o of rows) {
    map[o.sheetId + '||' + o.tabName + '||' + o.sheetRow] = {
      price: o.price, feeSnapshot: o.feeSnapshot, orderDate: toKstDate(o.orderedAt),
      bank: o.bank || '', account: o.account || '', depositor: o.depositor || '',
    };
  }
  return map;
}

/**
 * 그 건의 구매양식으로 제출된 계좌(order_submissions.bank/account/depositor).
 *
 * ★★ 등록리뷰어DB에 계좌가 없어도 **그 건 자체에는 리뷰어가 적어 낸 계좌가 있다**(작업보드 표에
 *    보이는 은행·계좌번호·예금주가 그 값이다). 이걸 안 보면 "시트엔 계좌가 멀쩡히 있는데
 *    입금관리는 리뷰어 정보 없음" 이 된다(실사고 2026-08-19 최영순7).
 * ★ **지목할 리뷰어가 없으므로 `reviewerId` 를 만들지 않는다** — 화면 계좌 보완 팝업의 대상이
 *   아니고(고칠 대상은 등록리뷰어DB다) 회차 스냅샷 대조에서도 가드 밖(unverifiable)이다.
 * ★ 세 값이 다 있어야 인정한다 — 반쪽 값으로 이체 파일을 만들면 은행이 통째로 거부한다.
 */
function _orderAccount(ord, row) {
  if (!ord) return null;
  const bankName = String(ord.bank || '').trim();
  const account = normalizeAccount(ord.account || '');
  const holder = String(ord.depositor || '').trim();
  if (!bankName || !account || !holder) return null;
  return {
    reviewerId: null, bankName, bankAccount: account, accountHolder: holder,
    isSub: false, source: 'order',
    name: String((row && row.reviewerName) || ''), ownerName: '',
  };
}

/**
 * phone8 → 계좌 정보.
 * ① 본계정(reviewers) ② 타계정(sub_accounts) — 타계정 전용계좌가 없으면 소유자 공통계좌.
 * ★ 본계정을 먼저 넣고 타계정으로 덮지 않는다(같은 번호가 양쪽에 있으면 본인이 우선).
 */
async function _loadAccounts(phone8s) {
  const map = {};
  if (!phone8s.length) return map;
  const { rows: subs } = await pool.query(
    `SELECT RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) AS "phone8",
            r.id                                                             AS "reviewerId",
            COALESCE(NULLIF(btrim(s->>'name'),''), '')                       AS "name",
            COALESCE(r.name, '')                                             AS "ownerName",
            COALESCE(NULLIF(btrim(s->>'bankName'),''),   r.bank_name)        AS "bankName",
            COALESCE(NULLIF(btrim(s->>'bankAccount'),''), r.bank_account)    AS "bankAccount",
            COALESCE(NULLIF(btrim(s->>'accountHolder'),''), r.account_holder) AS "accountHolder"
       FROM reviewers r, jsonb_array_elements(
              CASE WHEN jsonb_typeof(r.sub_accounts) = 'array' THEN r.sub_accounts ELSE '[]'::jsonb END) s
      WHERE RIGHT(regexp_replace(COALESCE(s->>'phone',''), '[^0-9]', '', 'g'), 8) = ANY($1)`,
    [phone8s]
  );
  for (const s of subs) {
    if (s.phone8 && !map[s.phone8]) {
      // ★ 명의 이름(sub_accounts[].name)과 소유자 이름을 함께 싣는다 —
      //   같은 소유자가 본인 명의 + 타계정 명의로 여러 건 참여하면 화면이 "누구 계좌인지" 말할 수 없다(실사고).
      map[s.phone8] = { reviewerId: s.reviewerId, bankName: s.bankName || '', bankAccount: s.bankAccount || '', accountHolder: s.accountHolder || '',
                        isSub: true, name: s.name || '', ownerName: s.ownerName || '' };
    }
  }
  const { rows: own } = await pool.query(
    `SELECT id AS "reviewerId", phone8, COALESCE(name,'') AS "name",
            bank_name AS "bankName", bank_account AS "bankAccount", account_holder AS "accountHolder"
       FROM reviewers WHERE phone8 = ANY($1)`,
    [phone8s]
  );
  for (const r of own) {
    map[r.phone8] = { reviewerId: r.reviewerId, bankName: r.bankName || '', bankAccount: r.bankAccount || '', accountHolder: r.accountHolder || '',
                      isSub: false, name: r.name || '', ownerName: r.name || '' };
  }
  return map;
}

/**
 * 계좌를 phone8 으로 못 찾은 행 → **소유자(로그인 리뷰어) 링크**로 역조회.
 *
 * ★★ 왜 필요한가(실사고 2026-08-19 "김수만/명지수"): 타계정 매칭 키는 `sub_accounts[].phone`
 *    하나뿐이라, 소유자가 타계정을 **이름만** 등록했거나 번호를 다르게 적어 두면 그 참여 건이
 *    `리뷰어 정보 없음` 으로 **영구 보류**된다. 계좌(김수만)는 멀쩡히 있는데 지목할 길이 없었다.
 *
 * ★★ **이름으로 소유자를 추측하지 않는다(완화 금지)** — 동명이인 한 번이면 남의 계좌로 송금이다.
 *    근거는 그 행에 이미 박제된 **하드 링크 두 개**뿐:
 *      ① 참여 원장 `campaign_applications.owner_phone8`(주문 id 로 그 행에 결속 — 홀드 생성 시
 *         서버가 명의 검증을 거쳐 기록한 값이라 "이 명의는 이 소유자의 것"이 확정돼 있다)
 *      ② 제출 신원 링크 `participation_links.phone8`(= 로그인 phone8). ★ 이쪽은 명의 대조가
 *         없으므로 **소유자의 타계정 목록에 그 행 이름이 정확히 등록돼 있을 때만** 인정한다
 *         (재배정된 행의 stale 링크가 엉뚱한 사람 계좌를 열지 못하게 — 검색 게이트와 같은 규율).
 * ★ ① 이 ② 를 이긴다(원장이 더 강한 근거).
 * ★ `reviewers.phone8` 은 GENERATED·비유니크 → **후보가 유일할 때만** 채택(모호 = 미채택).
 * ★ 조회 실패는 throw 하지 않는다 — 폴백이 죽어도 입금대상 목록은 종전대로 나온다.
 */
async function _loadOwnerAccountsByRow(rows) {
  const out = {};
  if (!rows.length) return out;
  const key = r => r.sheetId + '||' + r.tabName + '||' + r.rowIndex;
  const sheetIds = rows.map(r => r.sheetId);
  const tabNames = rows.map(r => r.tabName);
  const rowIdx = rows.map(r => r.rowIndex);
  const nameByRow = new Map(rows.map(r => [key(r), String(r.reviewerName || '')]));

  try {
    // ① 참여 원장 — 주문 id 로 그 행에 결속된 타계정 홀드의 소유자
    const { rows: viaOrder } = await pool.query(
      `SELECT t.sheet_id AS "sheetId", t.tab_name AS "tabName", t.row_index AS "rowIndex",
              ca.owner_phone8 AS "ownerPhone8", ca.phone8 AS "subPhone8"
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(sheet_id, tab_name, row_index)
         JOIN order_submissions os
           ON os.sheet_id = t.sheet_id AND os.tab_name = t.tab_name
          AND os.sheet_row = t.row_index AND os.deleted_at IS NULL
         JOIN campaign_applications ca ON ca.order_submission_id = os.id
        WHERE COALESCE(ca.owner_phone8, '') <> ''`,
      [sheetIds, tabNames, rowIdx]);

    // ② 제출 신원 링크 — 그 행을 제출한 로그인 리뷰어(= 소유자)
    const { rows: viaLink } = await pool.query(
      `SELECT pl.sheet_id AS "sheetId", pl.tab_name AS "tabName", pl.row_index AS "rowIndex",
              pl.phone8 AS "ownerPhone8"
         FROM participation_links pl
         JOIN unnest($1::text[], $2::text[], $3::int[]) AS t(sheet_id, tab_name, row_index)
           ON pl.sheet_id = t.sheet_id AND pl.tab_name = t.tab_name AND pl.row_index = t.row_index
        WHERE COALESCE(pl.phone8, '') <> ''`,
      [sheetIds, tabNames, rowIdx]);

    const owners = [...new Set([...viaOrder, ...viaLink].map(x => x.ownerPhone8).filter(Boolean))];
    if (!owners.length) return out;

    const { rows: revs } = await pool.query(
      `SELECT id AS "reviewerId", phone8, COALESCE(name,'') AS "name",
              bank_name AS "bankName", bank_account AS "bankAccount", account_holder AS "accountHolder",
              CASE WHEN jsonb_typeof(sub_accounts) = 'array' THEN sub_accounts ELSE '[]'::jsonb END AS "subAccounts"
         FROM reviewers WHERE phone8 = ANY($1)`, [owners]);
    const byOwner = new Map();
    for (const r of revs) {
      if (!byOwner.has(r.phone8)) byOwner.set(r.phone8, []);
      byOwner.get(r.phone8).push(r);
    }
    // ★ 소유자 후보가 둘 이상인 번호는 통째로 버린다(누구 계좌인지 정할 수 없다).
    const uniqueOwner = p8 => {
      const list = byOwner.get(p8) || [];
      return list.length === 1 ? list[0] : null;
    };
    const pack = (owner, sub, source) => ({
      reviewerId: owner.reviewerId,
      bankName:      (sub && String(sub.bankName || '').trim())      || owner.bankName || '',
      bankAccount:   (sub && String(sub.bankAccount || '').trim())   || owner.bankAccount || '',
      accountHolder: (sub && String(sub.accountHolder || '').trim()) || owner.accountHolder || '',
      isSub: true, source,
      name: (sub && String(sub.name || '').trim()) || '',
      ownerName: owner.name || '',
      // ★ 지목 대상 = 그 명의 항목이 실제로 등록돼 있을 때만 타계정, 아니면 소유자 본계좌.
      //   (등록돼 있지 않은 명의를 subPhone8 로 지목하면 보완 저장이 `sub_not_found` 로 죽는다)
      subPhone8: (sub && sub.__phone8) || null,
    });
    const findSub = (owner, { subPhone8, name }) => {
      const arr = Array.isArray(owner.subAccounts) ? owner.subAccounts : [];
      const p8 = String(subPhone8 || '').replace(/[^0-9]/g, '').slice(-8);
      for (const s of arr) {
        if (!s) continue;
        const sp8 = String(s.phone || '').replace(/[^0-9]/g, '').slice(-8);
        if (p8 && sp8 === p8) return { ...s, __phone8: sp8 };
      }
      const n = normName(name);
      if (!n) return null;
      const hits = arr.filter(s => s && normName(s.name) === n);
      // ★ 같은 이름이 두 개면 어느 명의인지 정할 수 없다 → 미채택
      if (hits.length !== 1) return null;
      const sp8 = String(hits[0].phone || '').replace(/[^0-9]/g, '').slice(-8);
      return { ...hits[0], __phone8: sp8 || null };
    };

    // ② 먼저 깔고 ① 로 덮는다(원장이 이긴다)
    for (const x of viaLink) {
      const k = x.sheetId + '||' + x.tabName + '||' + x.rowIndex;
      if (out[k]) continue;
      const owner = uniqueOwner(x.ownerPhone8);
      if (!owner) continue;
      // ★ 명의 대조 필수 — 소유자의 타계정 목록에 그 행 이름이 있어야 한다
      const sub = findSub(owner, { name: nameByRow.get(k) });
      if (!sub) continue;
      out[k] = pack(owner, sub, 'owner_link');
    }
    for (const x of viaOrder) {
      const k = x.sheetId + '||' + x.tabName + '||' + x.rowIndex;
      const owner = uniqueOwner(x.ownerPhone8);
      if (!owner) continue;
      out[k] = pack(owner, findSub(owner, { subPhone8: x.subPhone8, name: nameByRow.get(k) }), 'owner_order');
    }
  } catch (e) {
    logger.warn('[payment] 소유자 링크 계좌 폴백 실패(종전대로 보류): ' + e.message);
  }
  return out;
}

/**
 * 탭 메타 — 표시명(리뷰어 노출 규칙과 동일, 시트제목 미사용) + **탭 단위 이체설정** + 작업오더 물건비.
 *
 * ★ 이체설정(`transfer_bank`·`deposit_name`)은 **이미 있는 컬럼**이다(001 스키마, 관리자 대시보드
 *   탭설정 팝오버가 채운다) — 마이그레이션 없이 그대로 읽는다.
 * ★ 작업오더 물건비를 **탭 기준**으로도 읽는 이유: `_loadCampaigns` 의 LATERAL 은 공고를 거치므로
 *   공고가 없는 작업은 자동판정까지 통째로 죽는다. 같은 조인이라 쿼리 순증은 0.
 */
async function _loadTabMeta(sheetIds, tabNames) {
  const map = {};
  try {
    const { rows } = await pool.query(
      `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
              COALESCE(NULLIF(btrim(tc.display_name),''), tc.tab_name) AS "label",
              tc.manager AS "manager",
              tc.transfer_bank AS "transferBank", tc.deposit_name AS "depositName",
              tc.review_fee AS "reviewFee",
              tc.tab_gid AS "tabGid", tc.sheetless AS "sheetless",
              wo.goods_cost_type AS "goodsCostType",
              -- ★ 담당자 판정 원천 — 인트라넷 작업담당(065) + 작업 화면이 읽는 칸
              wo.work_manager AS "orderWorkManager", wo.manager_name AS "orderManager"
         FROM tab_configs tc
         LEFT JOIN LATERAL (
              SELECT w.goods_cost_type, w.work_manager, w.manager_name FROM work_orders w
               WHERE w.deleted_at IS NULL
                 AND w.linked_tab_sheet_id = tc.sheet_id
                 AND w.linked_tab_name = tc.tab_name
               ORDER BY w.created_at DESC LIMIT 1) wo ON TRUE
        WHERE tc.sheet_id = ANY($1) AND tc.tab_name = ANY($2)`,
      [sheetIds, tabNames]);
    // 담당자 닉네임 맵 — 조회 실패는 빈 맵(fail-soft, 작업 카드와 같은 규율)
    let nickMap = {};
    try { nickMap = await getNicknameMap(); } catch (_) { nickMap = {}; }
    for (const t of rows) {
      const mgr = resolveWorkManager({
        orderWorkManager: t.orderWorkManager, orderManager: t.orderManager, tabManager: t.manager, nickMap });
      map[t.sheetId + '||' + t.tabName] = {
        label: t.label, manager: mgr.manager, managerSource: mgr.managerSource,
        transferBank: t.transferBank || '', depositName: t.depositName || '',
        // ★ 리뷰비는 **NULL(미설정)과 0(무상 지정)을 구분**한다 — `|| 0` 으로 접으면
        //   미설정이 조용히 0원이 되어 공고 값이 있는데도 탭 폴백이 이긴 것처럼 보인다.
        reviewFee: (t.reviewFee == null || t.reviewFee === '') ? null : Number(t.reviewFee),
        goodsCostType: t.goodsCostType || '',
        sheetless: t.sheetless === true,
        tabGid: String(t.tabGid == null ? '' : t.tabGid),
        sheetUrl: tabSheetUrl({ sheetId: t.sheetId, tabGid: t.tabGid }),
      };
    }
  } catch (e) { logger.warn('[payment] 탭 메타 조회 실패(탭명 사용): ' + e.message); }
  return map;
}

/**
 * 그 탭을 여는 구글시트 링크(없으면 빈 문자열).
 *
 * ★★ **이관된 작업(sheetless)도 링크를 만든다 (사용자 확정 2026-08-10)** — 초도 보완에는
 *   아직 구글시트를 봐야 하는 값(결제금액 칸 등)이 있다. 시스템 표가 진실원본이라는 사실은
 *   **링크를 막는 근거가 아니라 경고문의 근거**다 → 화면이 "편집하지 말고 참고만" 팝업을
 *   띄운 뒤 연다(`sheetless` 플래그는 그 경고 조건으로만 쓴다).
 * ★★ **열 시트가 애초에 없는 경우만 빈 값** = 시스템이 만든 가상 시트ID(`wt_…`).
 *   구글 URL 로 조립하면 **죽은 링크**가 된다(반영 점검 `_gidOut` 과 같은 규율: 빈 링크 > 죽은 링크).
 *   판정은 `sheetlessAccept.isVirtualSheetId` 단일 출처(사본 금지) — 이 접두는 스코프 게이트가
 *   아니라 **표시용 판정**이라 여기 쓰는 것이 맞다(게이트는 여전히 `tab_configs.sheetless`).
 * ★ gid 를 알면 그 탭까지 열고, 모르면 시트만 연다("열리는데 엉뚱한 탭"보다 정직하다).
 */
function tabSheetUrl({ sheetId, tabGid }) {
  const id = String(sheetId == null ? '' : sheetId).trim();
  if (!id || isVirtualSheetId(id)) return '';
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
  const gid = String(tabGid == null ? '' : tabGid).trim();
  return gid ? `${base}#gid=${encodeURIComponent(gid)}` : base;
}

/* ══════════════════════════════════════════════════════════
   2) 회차 생성 (= 다운로드 · 잠금)
   ══════════════════════════════════════════════════════════ */

/**
 * 선택한 건들을 한 회차로 묶어 잠근다.
 * @param {object} p { bank, rows:[{sheetId,tabName,rowIndex}], by }
 * @returns {{ok:boolean, batch?:object, items?:Array, error?:string, skipped?:Array}}
 *
 * ★ 단일 트랜잭션. 부분유니크(uq_payment_items_active) 위반(23505)은
 *   "그 사이 다른 담당자가 먼저 담았다"는 뜻이라 **그 건만 건너뛰고** 나머지는 진행한다
 *   (전체 실패로 만들면 매번 처음부터 다시 골라야 한다).
 */
async function createBatch({ bank, rows, by }) {
  if (!BANK_LABEL[bank]) return { ok: false, error: '이체 은행이 올바르지 않습니다.' };
  const want = Array.isArray(rows) ? rows : [];
  if (!want.length) return { ok: false, error: '선택된 건이 없습니다.' };

  // 화면 값은 신뢰하지 않는다 — 대상 목록을 서버에서 다시 계산해 교집합만 담는다.
  const { items: fresh } = await listPaymentTargets();
  const freshMap = new Map(fresh.map(it => [it.sheetId + '||' + it.tabName + '||' + it.rowIndex, it]));

  const picked = [];
  const skipped = [];
  for (const w of want) {
    const k = String(w.sheetId) + '||' + String(w.tabName) + '||' + String(w.rowIndex);
    const it = freshMap.get(k);
    if (!it) { skipped.push({ key: k, reason: 'not_target' }); continue; }
    if (!it.payable) { skipped.push({ key: k, reason: it.issues[0] || 'blocked' }); continue; }
    if (it.bank !== bank) { skipped.push({ key: k, reason: 'other_bank' }); continue; }
    picked.push(it);
  }
  if (!picked.length) return { ok: false, error: '담을 수 있는 건이 없습니다.', skipped };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [batch] } = await client.query(
      `INSERT INTO payment_batches (bank, created_by) VALUES ($1, $2) RETURNING *`, [bank, by || '']);

    const saved = [];
    for (const it of picked) {
      // 건별 SAVEPOINT — 23505(다른 담당자가 먼저 담음)는 그 건만 건너뛴다.
      await client.query('SAVEPOINT sp_item');
      try {
        const { rows: [row] } = await client.query(
          `INSERT INTO payment_batch_items
             (batch_id, sheet_id, tab_name, row_index, campaign_id, reviewer_name, phone8,
              bank_name, bank_code, bank_account, account_holder,
              account_reviewer_id, account_source, account_sub_phone8, account_fingerprint, account_snapshot_fingerprint,
              product_price, review_fee, amount, transfer_memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
          [batch.id, it.sheetId, it.tabName, it.rowIndex, it.campaignId, it.reviewerName, it.phone8,
           it.bankName, it.bankCode, it.bankAccount, it.accountHolder,
           it.accountRef && it.accountRef.reviewerId || null,
           // ★ 'sub' 은 **등록된 명의**(subPhone8)를 가리킬 때만 — 없으면 값은 소유자 본계좌이므로
           //   'self' 로 박제해야 다음 대조(reconcileAccountSnapshots)가 같은 곳을 본다.
           it.accountRef ? (it.accountRef.subPhone8 ? 'sub' : 'self') : null,
           it.accountRef && it.accountRef.subPhone8 || null, accountFingerprint(it.bankAccount), snapshotFingerprint(it.bankName, it.bankAccount, it.accountHolder),
           it.productPrice, it.reviewFee, it.amount, it.transferMemo]);
        await client.query('RELEASE SAVEPOINT sp_item');
        saved.push({ ...it, id: row.id });
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_item');
        if (e && e.code === '23505') skipped.push({ key: it.sheetId + '||' + it.tabName + '||' + it.rowIndex, reason: 'already_locked' });
        else throw e;
      }
    }
    if (!saved.length) {
      await client.query('ROLLBACK');
      return { ok: false, error: '담을 수 있는 건이 없습니다(이미 다른 회차에 포함).', skipped };
    }
    const total = saved.reduce((a, b) => a + b.amount, 0);
    const { rows: [updated] } = await client.query(
      `UPDATE payment_batches SET item_count = $2, total_amount = $3 WHERE id = $1 RETURNING *`,
      [batch.id, saved.length, total]);
    await client.query('COMMIT');
    return { ok: true, batch: _batchView(updated), items: saved, skipped };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** 회차 취소 — 잠금 해제(항목 cancelled). 이미 반영된 회차는 취소 불가. */
async function cancelBatch(batchId, by) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [b] } = await client.query(
      `SELECT * FROM payment_batches WHERE id = $1 FOR UPDATE`, [batchId]);
    if (!b) { await client.query('ROLLBACK'); return { ok: false, error: '회차를 찾을 수 없습니다.' }; }
    if (b.status === 'cancelled') { await client.query('ROLLBACK'); return { ok: false, error: '이미 취소된 회차입니다.' }; }
    if (b.status === 'applied') { await client.query('ROLLBACK'); return { ok: false, error: '이미 이체결과가 반영된 회차는 취소할 수 없습니다.' }; }
    // 입금 기록된 항목이 하나라도 있으면 취소 금지(M2 대비 안전장치)
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE batch_id = $1 AND status = 'paid'`, [batchId]);
    if (n > 0) { await client.query('ROLLBACK'); return { ok: false, error: '입금 완료된 건이 포함되어 취소할 수 없습니다.' }; }

    await client.query(
      `UPDATE payment_batch_items SET status = 'cancelled' WHERE batch_id = $1 AND status = 'pending'`, [batchId]);
    const { rows: [updated] } = await client.query(
      `UPDATE payment_batches SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2
        WHERE id = $1 RETURNING *`, [batchId, by || '']);
    await client.query('COMMIT');
    return { ok: true, batch: _batchView(updated) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/** 회차 목록 */
async function listBatches(limit = 50) {
  const { rows } = await pool.query(
    `SELECT b.*,
            (SELECT COUNT(*)::int FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'paid')   AS paid_count,
            (SELECT COUNT(*)::int FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'failed') AS failed_count,
            (SELECT COUNT(*)::int FROM payment_batch_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count,
            ru.id AS result_upload_id, ru.file_name AS result_file_name, ru.row_count AS result_row_count,
            ru.success_count AS result_success_count, ru.failed_count AS result_failed_count,
            ru.applied_count AS result_applied_count, ru.applied AS result_applied,
            ru.uploaded_at AS result_uploaded_at, ru.applied_at AS result_applied_at,
            (ru.file_blob IS NOT NULL) AS result_has_file, ru.summary AS result_summary
       FROM payment_batches b
       LEFT JOIN LATERAL (
         SELECT id, file_name, row_count, success_count, failed_count, applied_count, applied,
                uploaded_at, applied_at, file_blob, summary
           FROM payment_result_uploads WHERE batch_id = b.id
          -- 실제 반영 이력은 이후의 단순 미리보기보다 우선한다.
          ORDER BY (applied = TRUE) DESC, applied_at DESC NULLS LAST, uploaded_at DESC, id DESC LIMIT 1
       ) ru ON TRUE
       ORDER BY b.created_at DESC LIMIT $1`, [Math.min(200, Math.max(1, limit))]);
  return rows.map(_batchView);
}

/** 회차 상세(항목 포함) */
async function getBatch(batchId) {
  const { rows: [b] } = await pool.query(`SELECT * FROM payment_batches WHERE id = $1`, [batchId]);
  if (!b) return null;
  const { rows: items } = await pool.query(
    `SELECT * FROM payment_batch_items WHERE batch_id = $1 ORDER BY created_at, id`, [batchId]);
  return { batch: _batchView(b), items };
}

/** 재다운로드 이력 기록(사용자 확정: 재다운로드도 이력에 남는다) */
async function markDownloaded(batchId, by) {
  await pool.query(
    `UPDATE payment_batches
        SET download_count = download_count + 1, last_downloaded_at = NOW(), last_downloaded_by = $2
      WHERE id = $1`, [batchId, by || '']);
}

async function checkBatchAccountSnapshots({ batch, items }) {
  const guarded = (items || []).filter(i => i.account_reviewer_id && i.account_source);
  if (!guarded.length) return { ok: true, mismatches: [], unverifiable: (items || []).length };
  const ids = [...new Set(guarded.map(i => String(i.account_reviewer_id)))];
  const { rows } = await pool.query(
    `SELECT id AS "reviewerId", bank_name AS "bankName", bank_account AS "bankAccount", account_holder AS "accountHolder", sub_accounts AS "subAccounts"
       FROM reviewers WHERE id::text = ANY($1::text[])`, [ids]);
  const byId = new Map(rows.map(r => [String(r.reviewerId), r]));
  return reconcileAccountSnapshots(guarded, byId);
}

function reconcileAccountSnapshots(items, ownersById) {
  const mismatches = [];
  let unverifiable = 0;
  for (const item of items || []) {
    const owner = ownersById.get(String(item.account_reviewer_id));
    let current = null;
    if (owner && item.account_source === 'self') {
      current = { reviewerId: owner.reviewerId, isSub: false, bankName: owner.bankName || '', bankAccount: owner.bankAccount || '', accountHolder: owner.accountHolder || '' };
    } else if (owner && item.account_source === 'sub') {
      const subs = Array.isArray(owner.subAccounts) ? owner.subAccounts : [];
      const sub = subs.find(s => String((s && s.phone) || '').replace(/[^0-9]/g, '').slice(-8) === String(item.account_sub_phone8 || ''));
      if (sub) current = { reviewerId: owner.reviewerId, isSub: true, subPhone8: item.account_sub_phone8 || '', bankName: sub.bankName || owner.bankName || '', bankAccount: sub.bankAccount || owner.bankAccount || '', accountHolder: sub.accountHolder || owner.accountHolder || '' };
    }
    const comparison = compareAccountSnapshot(item, current);
    if (comparison.state !== 'match') mismatches.push({ itemId: item.id, reviewerName: item.reviewer_name || '', accountTail: String(item.bank_account || '').replace(/[^0-9]/g, '').slice(-4) });
    if (comparison.state === 'unverifiable') unverifiable++;
  }
  return { ok: mismatches.length === 0, mismatches, unverifiable };
}

function _batchView(b) {
  const preview = b.result_summary && b.result_summary.preview;
  const unmatched = Array.isArray(preview && preview.unmatchedResults) ? preview.unmatchedResults : [];
  const paidCount = b.paid_count == null ? undefined : Number(b.paid_count);
  const failedCount = b.failed_count == null ? undefined : Number(b.failed_count);
  const itemCount = Number(b.item_count || 0);
  // 미확인 이체는 이 회차 밖 결과다. 회차 성공/실패 수에 섞지 않고 별도로 보여 준다.
  const resultSuccessCount = Math.min(itemCount, Math.max(Number(b.result_success_count || 0), Number(paidCount || 0)));
  // 결과 파일이 있으면 성공으로 매칭되지 않은 회차 항목은 이체실패(결과없음)로 처리한다.
  const resultFailedCount = b.result_upload_id
    ? Math.max(Number(b.result_failed_count || 0), Number(failedCount || 0), Math.max(0, itemCount - resultSuccessCount))
    : Math.max(Number(b.result_failed_count || 0), Number(failedCount || 0));
  return {
    id: b.id, seq: Number(b.seq), bank: b.bank, bankLabel: BANK_LABEL[b.bank] || b.bank,
    status: b.status, itemCount: b.item_count, totalAmount: Number(b.total_amount || 0),
    createdBy: b.created_by || '', createdAt: b.created_at,
    downloadCount: b.download_count, lastDownloadedAt: b.last_downloaded_at,
    lastDownloadedBy: b.last_downloaded_by || '',
    cancelledAt: b.cancelled_at, cancelledBy: b.cancelled_by || '',
    paidCount,
    failedCount,
    pendingCount: b.pending_count == null ? undefined : Number(b.pending_count),
    resultUploadId: b.result_upload_id || '',
    resultFileName: b.result_file_name || '',
    resultRowCount: b.result_row_count == null ? undefined : Number(b.result_row_count),
    resultSuccessCount,
    resultFailedCount,
    resultUnconfirmedCount: unmatched.length,
    resultAppliedCount: Math.max(Number(b.result_applied_count || 0), Number(paidCount || 0)),
    resultApplied: b.result_applied === true,
    boardRecordedCount: Number(b.board_recorded_count || 0),
    boardQueuedCount: Number(b.board_queued_count || 0),
    boardSkippedCount: Number(b.board_skipped_count || 0),
    boardFailedCount: Number(b.board_failed_count || 0),
    boardStamp: b.board_stamp || '',
    boardRecordedAt: b.board_recorded_at || null,
    resultCanApply: !!(b.result_upload_id && b.result_has_file && b.result_applied !== true
      && (Number(b.result_success_count || 0) + Number(b.result_failed_count || 0) > 0)),
  };
}

/* ══════════════════════════════════════════════════════════
   3) 은행 서식 엑셀 생성
   ══════════════════════════════════════════════════════════ */


/**
 * 은행별 다건이체 등록 서식.
 * ★ 헤더·열 순서는 각 은행 **공식 양식 그대로**다(케이뱅크는 공유받은 원본 양식 기준).
 *   임의로 바꾸면 은행 사이트가 파일을 거부한다.
 *
 * ★★ **파일 형식이 은행마다 다르다(완화 금지 — 2026-08-19 실측 사고)**
 *   · 케이뱅크 = **.xlsx**(OOXML) — 종전 그대로.
 *   · 하나은행 = **.xls(BIFF8 · OLE2)** — 하나 기업뱅킹 다건이체 업로드가 xlsx 를
 *     `해당 파일은 엑셀파일이 아닙니다. 다시 올려주십시오.` 로 **통째로 거부**했다.
 *     엑셀로 열어 다시 저장한 정상 xlsx 도 같은 거부였다 = 우리 파일이 깨진 게 아니라
 *     그쪽이 **구형 형식만 읽는다**. 하나가 돌려주는 이체결과 파일도 실측상 OLE2 .xls
 *     (`utils/paymentResultParse.js` 주석) — 같은 계열이다.
 *   되돌리기 = env `PAYMENT_HANA_XLS=0`(하나도 종전 xlsx 로 생성).
 *
 * ★ 형식·확장자·MIME 는 `BANK_FILE_FORMAT` **단일 출처**다 — 내용은 .xls 인데 파일명만
 *   .xlsx 로 나가면 은행 화면이 확장자만 보고 다시 거부한다(둘이 갈리면 안 된다).
 */
const BANK_FILE_FORMAT = {
  kbank: { kind: 'xlsx', ext: 'xlsx', sheet: '대량이체등록정보',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  hana: { kind: 'xls', ext: 'xls', sheet: '다건이체',
    mime: 'application/vnd.ms-excel' },
};

/** 그 회차 파일의 형식(확장자·MIME) — 파일명·응답 헤더·본문 생성이 같은 값을 본다. */
function batchFileFormat(bank) {
  const f = BANK_FILE_FORMAT[bank] || BANK_FILE_FORMAT.kbank;
  if (bank === 'hana' && process.env.PAYMENT_HANA_XLS === '0') {
    return { ...f, kind: 'xlsx', ext: 'xlsx', mime: BANK_FILE_FORMAT.kbank.mime };
  }
  return f;
}

/**
 * OOXML(.xlsx) 직렬화 — 케이뱅크(+하나 킬스위치 복귀분).
 * ★★ 계좌·은행코드는 **문자열 셀 + 텍스트 서식(`@`)** 으로 나간다 —
 *    숫자로 해석되면 `0123…` 의 앞 0 이 날아가거나 긴 계좌가 지수표기(1.23E+12)로 바뀌어
 *    은행 업로드가 통째로 거부된다(담당자가 매번 `'0123` 처럼 손으로 고치던 지점).
 *    금액만 숫자 그대로 둔다(은행 양식이 수치를 요구).
 */
async function _writeXlsx(sheetName, rows, widths) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'review-web-system';
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  ws.columns = widths.map(w => ({ width: w }));
  ws.eachRow((row, i) => {
    if (i === 1) return;
    row.eachCell(cell => { if (typeof cell.value === 'string') cell.numFmt = '@'; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * 구형 엑셀(.xls · BIFF8/OLE2) 직렬화 — 하나은행 전용.
 * ★ 문자열/숫자 구분과 텍스트 서식(`@`) 규칙은 xlsx 경로와 **같다**(계좌 앞 0 보존).
 * ★ SheetJS(`@e965/xlsx`)는 이미 이체결과 해석에 쓰는 의존성이라 신규 의존 0.
 */
function _writeXls(sheetName, rows, widths) {
  const XLSX = require('@e965/xlsx');
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++) {           // 헤더(0행) 제외
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.t === 's') cell.z = '@';
    }
  }
  ws['!cols'] = widths.map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return Buffer.from(XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
}

async function buildWorkbook(bank, items) {
  // ★ 서식에 찍히는 **정식 명칭**(`bankFormLabel`)이 오버레이 값이어야 한다 —
  //   화면에서 이름을 고쳐 놓고 파일엔 옛 이름이 나가면 은행이 거부한다.
  await _bankOv.ensureBankOverrides();
  const fmt = batchFileFormat(bank);
  const rows = [];
  let widths;

  if (bank === 'kbank') {
    rows.push(['* 입금은행(코드/은행명/증권사명)', '* 입금계좌', '* 이체금액(원)', '받는분 통장표시 ', '예금주']);
    for (const it of items) {
      // ★ 리뷰어가 적은 원문('신한')이 아니라 **표준코드에서 파생한 정식명**('신한은행')을 쓴다.
      //   양식 가이드가 "형식에 맞는 은행/증권사명 혹은 코드만" 허용하므로 원문은 거부될 수 있다.
      // ★★ 케이뱅크가 이름을 인식 못 하는 기관(031 대구은행 — 2026-08-21 실측)은
      //   `bankFormLabel` 이 **코드**를 돌려준다. 판정은 `utils/bankCodes` 단일 출처이고
      //   여기에 예외 사본을 만들지 않는다.
      const code = String(it.bank_code || it.bankCode || '');
      rows.push([
        bankFormLabel(code) || code,
        // ★ 계좌는 마지막까지 `normalizeAccount` 단일 출처로 숫자만 남긴다 —
        //   옛 원장 스냅샷에 '-' 가 섞여 있어도 은행 서식에는 절대 나가지 않게(업로드 거부 방지).
        normalizeAccount(it.bank_account || it.bankAccount || ''),
        _int(it.amount),
        it.transfer_memo || it.transferMemo || '',
        it.account_holder || it.accountHolder || '',
      ]);
    }
    widths = [28, 20, 14, 18, 14];
  } else {
    rows.push(['입금은행코드', '입금계좌번호', '이체금액', '예상예금주', '보내는분 통장표시내용', '받는분 통장표시내용', 'CMS/모집인코드']);
    for (const it of items) {
      rows.push([
        String(it.bank_code || it.bankCode || ''),     // ★ 문자열 — '045'의 앞 0이 사라지면 안 됨
        normalizeAccount(it.bank_account || it.bankAccount || ''),   // ★ 위와 같은 이유(숫자만 · 앞 0 보존)
        _int(it.amount),
        it.account_holder || it.accountHolder || '',
        '',
        it.transfer_memo || it.transferMemo || '',
        '',
      ]);
    }
    widths = [14, 22, 14, 14, 20, 20, 16];
  }

  return fmt.kind === 'xls' ? _writeXls(fmt.sheet, rows, widths) : _writeXlsx(fmt.sheet, rows, widths);
}

/** 다운로드 파일명 — 예) 하나은행_다건이체_20260819_124.xls / 케이뱅크_…_124.xlsx */
function batchFileName(batch) {
  const d = new Date(batch.createdAt || Date.now());
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const ymd = kst.toISOString().slice(0, 10).replace(/-/g, '');
  return `${BANK_LABEL[batch.bank] || batch.bank}_다건이체_${ymd}_${batch.seq}.${batchFileFormat(batch.bank).ext}`;
}

/* ══════════════════════════════════════════════════════════
   4) 보류 사유 보완 (화면에서 그 자리에서 고치기)
   ──────────────────────────────────────────────────────────
   ★ 쓰기 표면은 딱 세 곳 — `recruit_campaigns`(이체설정 2칸) ·
     `tab_configs`(이체설정 2칸) · `reviewers`(계좌 3칸/타계정 배열).
     주문 원장·시트·회차 테이블은 여기서 건드리지 않는다.
   ══════════════════════════════════════════════════════════ */

class PaymentFixError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * 작업 단위 이체설정 저장 → **그 작업의 보류가 한 번에 풀린다**.
 *
 * 저장처(사용자 확정): 연결 공고가 있으면 공고, 없으면 **탭 설정**.
 * ★ 공고 값이 탭 값을 이기므로(판정 순서와 같다) 공고가 있는데 탭에 쓰면 화면이 안 바뀐다 —
 *   그래서 대상 선택을 서버가 정한다(화면이 고른 저장처를 믿지 않는다).
 * ★ `campaignId` 는 **그 탭에 연결된 공고인지 재검증**한다 — 낡은 화면이 남의 공고 이체설정을
 *   덮는 것을 막는다(계약 오링크와 같은 규율).
 *
 * @param {{sheetId:string, tabName:string, campaignId?:string|null,
 *          bank?:string|null, memo?:string|null, reviewFee?:number|string|null}} p
 *        bank/memo/reviewFee 는 **undefined = 변경 없음**, `''`(또는 null) = 지움(자동/미설정으로 되돌림).
 * @returns {{ok:true, target:'campaign'|'tab', bank:string|null, memo:string, reviewFee:number|null}}
 */
async function saveTransferSetting({ sheetId, tabName, campaignId, bank, memo, reviewFee }) {
  const sid = String(sheetId || '').trim();
  const tab = String(tabName || '').trim();
  if (!sid || !tab) throw new PaymentFixError('bad_target', '작업(시트·탭)이 지정되지 않았습니다.');

  const touchBank = bank !== undefined;
  const touchMemo = memo !== undefined;
  const touchFee = reviewFee !== undefined;
  if (!touchBank && !touchMemo && !touchFee) throw new PaymentFixError('empty', '변경할 값이 없습니다.');

  // 빈 값 = 지움(자동 판정으로 되돌림) / 모르는 표기는 거부(추측 저장 금지)
  let bankCode = null;
  if (touchBank && String(bank || '').trim() !== '') {
    bankCode = normalizeBankChoice(bank);
    if (!bankCode) throw new PaymentFixError('bad_bank', '이체은행은 케이뱅크 또는 하나은행만 지정할 수 있습니다.');
  }
  const memoText = touchMemo ? normalizeMemo(String(memo || '')) : null;

  // 리뷰비 — 빈 값(''·null) = **미설정으로 되돌림**(0원 지정과 구분).
  // ★ 숫자가 아니거나 음수는 거부한다(추측 저장 금지 — 잘못 넣으면 리뷰어에게 잘못된 금액이 나간다).
  let feeVal = null;
  if (touchFee && !(reviewFee === null || String(reviewFee).trim() === '')) {
    const n = Number(String(reviewFee).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) throw new PaymentFixError('bad_fee', '리뷰비는 0 이상의 숫자로 입력해 주세요.');
    if (n > 10000000) throw new PaymentFixError('bad_fee', '리뷰비가 너무 큽니다(1천만원 이하).');
    feeVal = Math.floor(n);
  }

  // 공고 대상 검증 — 그 탭에 연결된 공고만 인정
  let campId = null;
  if (campaignId) {
    const { rows } = await pool.query(
      `SELECT id FROM recruit_campaigns
        WHERE id = $1 AND linked_sheet_id = $2 AND linked_tab_name = $3 LIMIT 1`,
      [String(campaignId), sid, tab]);
    if (!rows.length) throw new PaymentFixError('campaign_mismatch', '그 작업에 연결된 공고가 아닙니다. 화면을 새로고침해 주세요.');
    campId = rows[0].id;
  }

  if (campId) {
    // ★ 이 두 칸만 UPDATE — 공고의 다른 설정은 절대 건드리지 않는다(축약 폼 클로버 금지).
    // ★ 공고의 `review_fee` 는 **구간표(082)가 없을 때의 그 공고 금액**이다 — 구간이 있으면
    //   구간이 계속 이긴다(그 사실을 화면이 문장으로 말한다). 0 은 무상 지정이라 그대로 저장한다.
    await pool.query(
      `UPDATE recruit_campaigns
          SET transfer_bank = CASE WHEN $2::bool THEN $3::text ELSE transfer_bank END,
              transfer_memo = CASE WHEN $4::bool THEN $5::text ELSE transfer_memo END,
              review_fee    = CASE WHEN $6::bool THEN COALESCE($7::int, 0) ELSE review_fee END
        WHERE id = $1`,
      [campId, touchBank, bankCode, touchMemo, memoText, touchFee, feeVal]);
    return { ok: true, target: 'campaign', bank: bankCode, memo: memoText || '', reviewFee: touchFee ? (feeVal == null ? 0 : feeVal) : undefined };
  }

  // 탭 설정 — ★ 표기는 **한글 라벨**(관리자 대시보드 탭설정이 그 형식을 그대로 비교해 배지를 그린다)
  // ★ 탭 리뷰비(128)는 **NULL = 미설정**을 유지한다(0 으로 접으면 공고 폴백과 구분이 사라진다).
  const { rowCount } = await pool.query(
    `UPDATE tab_configs
        SET transfer_bank = CASE WHEN $3::bool THEN $4::text ELSE transfer_bank END,
            deposit_name  = CASE WHEN $5::bool THEN $6::text ELSE deposit_name END,
            review_fee    = CASE WHEN $7::bool THEN $8::int ELSE review_fee END,
            updated_at    = NOW()
      WHERE sheet_id = $1 AND tab_name = $2`,
    [sid, tab, touchBank, bankCode ? tabBankLabel(bankCode) : '', touchMemo, memoText, touchFee, feeVal]);
  if (!rowCount) throw new PaymentFixError('tab_not_found', '탭 설정이 없어 저장하지 못했습니다(작업오더 접수 전 탭일 수 있습니다).');
  return { ok: true, target: 'tab', bank: bankCode, memo: memoText || '', reviewFee: touchFee ? feeVal : undefined };
}

/**
 * 리뷰어 계좌 저장 → **그 리뷰어의 보류가 한 번에 풀린다**.
 *
 * ★ 대상은 `reviewers.id`(UNIQUE) — phone8 은 GENERATED·비유니크라 키로 쓰면
 *   같은 뒤8자리 타인 계좌를 덮는다(외부모집 수동제출에서 이미 밟은 함정).
 * ★ 타계정(`subPhone8`)이면 소유자 행의 `sub_accounts` 배열에서 **그 명의 항목만** 갱신한다 —
 *   소유자 공통계좌를 덮지 않는다(타계정 전용계좌 규약 유지).
 * ★ 빈 값은 **덮지 않는다**(부분 보완 허용) — 지우려면 화면이 아니라 등록리뷰어DB에서.
 */
async function saveReviewerAccount({ reviewerId, subPhone8, bankName, bankAccount, accountHolder, by }) {
  // ★ 아래 `resolveBank` 검증이 화면에서 방금 등록한 표기를 알아야 한다(안 그러면
  //   표기를 넣어 두고도 계좌 저장이 '인식불가'로 거부되는 막다른 길).
  await _bankOv.ensureBankOverrides();
  const id = String(reviewerId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PaymentFixError('bad_reviewer', '리뷰어를 지목할 수 없습니다.');

  const bn = String(bankName == null ? '' : bankName).trim();
  const ba = normalizeAccount(bankAccount == null ? '' : bankAccount);
  const ah = String(accountHolder == null ? '' : accountHolder).trim();
  if (!bn && !ba && !ah) throw new PaymentFixError('empty', '입력한 값이 없습니다.');
  // 은행명은 이체 서식의 은행코드로 해석돼야 한다 — 못 읽는 이름이면 저장 시점에 막는다
  // (저장은 됐는데 다음 회차에도 '은행명 인식불가'로 남는 막다른 길 방지).
  if (bn && !resolveBank(bn)) throw new PaymentFixError('bad_bank_name', `'${bn}' 은행명을 인식할 수 없습니다. 정식 은행명으로 입력해 주세요(예: 국민은행 · 카카오뱅크).`);

  const sub = String(subPhone8 || '').replace(/[^0-9]/g, '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.changed_by', $1, true)", [String(by || 'payment-workdesk')]);
    if (sub) {
      // 타계정 — 소유자 행의 배열에서 그 명의 항목만 병합
      const { rows } = await client.query(`SELECT sub_accounts FROM reviewers WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows.length) throw new PaymentFixError('reviewer_not_found', '리뷰어를 찾지 못했습니다.');
      const arr = Array.isArray(rows[0].sub_accounts) ? rows[0].sub_accounts : [];
      let hit = false;
      const next = arr.map(s => {
        const p8 = String((s && s.phone) || '').replace(/[^0-9]/g, '').slice(-8);
        if (p8 !== sub || hit) return s;
        hit = true;
        return { ...s, ...(bn ? { bankName: bn } : {}), ...(ba ? { bankAccount: ba } : {}), ...(ah ? { accountHolder: ah } : {}) };
      });
      if (!hit) throw new PaymentFixError('sub_not_found', '그 타계정을 찾지 못했습니다. 화면을 새로고침해 주세요.');
      await client.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`, [id, JSON.stringify(next)]);
      await client.query('COMMIT');
      return { ok: true, target: 'sub' };
    }

    const { rows: [existing] } = await client.query(`SELECT bank_name, bank_account FROM reviewers WHERE id = $1 FOR UPDATE`, [id]);
    if (!existing) throw new PaymentFixError('reviewer_not_found', '리뷰어를 찾지 못했습니다.');
    const { rowCount } = await client.query(
      `UPDATE reviewers
          SET bank_name      = CASE WHEN $2::text <> '' THEN $2::text ELSE bank_name END,
              bank_account   = CASE WHEN $3::text <> '' THEN $3::text ELSE bank_account END,
              account_holder = CASE WHEN $4::text <> '' THEN $4::text ELSE account_holder END
        WHERE id = $1`,
      [id, bn, ba, ah]);
    if (!rowCount) throw new PaymentFixError('reviewer_not_found', '리뷰어를 찾지 못했습니다.');
    await client.query('COMMIT');
    return { ok: true, target: 'self' };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* best effort */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  BANK_LABEL, bankFromGoodsCostType, normalizeBankChoice, tabBankLabel, tabSheetUrl,
  listPaymentTargets, createBatch, cancelBatch, listBatches, getBatch, markDownloaded,
  buildWorkbook, batchFileName, batchFileFormat,
  saveTransferSetting, saveReviewerAccount, checkBatchAccountSnapshots, reconcileAccountSnapshots,
  compareAccountSnapshot, accountFingerprint, resolveWorkManager, PaymentFixError,
};
