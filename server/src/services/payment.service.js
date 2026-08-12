'use strict';
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
const { resolveBank, bankNameByCode, normalizeAccount, normalizeMemo } = require('../utils/bankCodes');
const _bankOv = require('./bankNameOverride.service');   // 화면에서 고친 은행 표기 → 판정 표에 적용
const { extractAmountNumber, EXACT_KEYS: AMOUNT_EXACT_KEYS } = require('../utils/paymentAmount');
// 시트 링크를 만들 수 있는지(= 진짜 구글시트가 있는지) 판정 — 접두 사본 금지
const { isVirtualSheetId } = require('./sheetlessAccept.service');

const BANK_LABEL = { kbank: '케이뱅크', hana: '하나은행' };

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

  const items = rows.map(r => {
    const key = r.sheetId + '||' + r.tabName;
    const camp = campMap[key] || null;
    const tab = tabMap[key] || null;
    const ord = orderMap[key + '||' + r.rowIndex] || null;
    const acct = acctMap[r.phone8] || null;

    // 상품비 = 그 행의 실제 제출 결제금액(주문 원장).
    // ★ 주문 원장에 없는 행(옛 작업·직원 수기 입력)은 **시트 결제금액 칸**으로 폴백한다 —
    //   그 칸이 그 행의 실제 결제금액이고, 폴백이 없으면 그런 행은 영영 0원 보류로 남는다.
    //   출처(priceSource)를 함께 실어 화면이 "시트에서 읽음"을 드러낸다(조용한 추정 금지).
    const orderPrice = ord ? _int(ord.price) : 0;
    const sheetPrice = orderPrice ? 0 : extractAmountNumber(r.amountCells);
    const productPrice = orderPrice || sheetPrice;
    const priceSource = orderPrice ? 'order' : (sheetPrice ? 'sheet' : null);

    // 리뷰비 = 082 단일 출처(스냅샷 → 주문일 → 시트 구매일자 → 오늘 → 폴백)
    const fee = camp
      ? resolveReviewFee({
          snapshot: ord ? ord.feeSnapshot : null,
          schedules: camp.schedules,
          orderDate: ord ? ord.orderDate : null,
          sheetDate: sheetDateToIso(r.startDate, camp.campStartDate),
          fallback: camp.reviewFee,
        }).fee
      : 0;

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
    if (!fee) warnings.push('no_review_fee');

    return {
      sheetId: r.sheetId, tabName: r.tabName, rowIndex: r.rowIndex,
      tabLabel: (tab && tab.label) || r.tabName,
      // 시트 바로가기 — 아직 구글시트를 직접 열어 확인해야 하는 데이터가 있다(결제금액 칸 등).
      // ★ 무시트/미등록이면 빈 값 = 화면이 버튼을 비활성으로 두고 **사유를 말한다**(죽은 링크 금지).
      sheetUrl: tab ? tab.sheetUrl : '',
      sheetless: !!(tab && tab.sheetless),
      manager: tab ? (tab.manager || '') : '',
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
      accountRef: acct && acct.reviewerId
        ? { reviewerId: acct.reviewerId, subPhone8: acct.isSub ? r.phone8 : null }
        : null,
      productPrice, reviewFee: fee, amount, priceSource,
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
            COALESCE(c.review_fee, 0) AS "reviewFee",
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
      id: c.id, title: c.title || '', reviewFee: c.reviewFee || 0,
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
            price, review_fee_snapshot AS "feeSnapshot", submitted_at AS "orderedAt"
       FROM order_submissions
      WHERE deleted_at IS NULL AND sheet_row IS NOT NULL
        AND sheet_id = ANY($1) AND tab_name = ANY($2)`,
    [sheetIds, tabNames]
  );
  for (const o of rows) {
    map[o.sheetId + '||' + o.tabName + '||' + o.sheetRow] = {
      price: o.price, feeSnapshot: o.feeSnapshot, orderDate: toKstDate(o.orderedAt),
    };
  }
  return map;
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
              tc.tab_gid AS "tabGid", tc.sheetless AS "sheetless",
              wo.goods_cost_type AS "goodsCostType"
         FROM tab_configs tc
         LEFT JOIN LATERAL (
              SELECT w.goods_cost_type FROM work_orders w
               WHERE w.deleted_at IS NULL
                 AND w.linked_tab_sheet_id = tc.sheet_id
                 AND w.linked_tab_name = tc.tab_name
               ORDER BY w.created_at DESC LIMIT 1) wo ON TRUE
        WHERE tc.sheet_id = ANY($1) AND tc.tab_name = ANY($2)`,
      [sheetIds, tabNames]);
    for (const t of rows) {
      map[t.sheetId + '||' + t.tabName] = {
        label: t.label, manager: t.manager || '', transferBank: t.transferBank || '', depositName: t.depositName || '',
        goodsCostType: t.goodsCostType || '',
        sheetless: t.sheetless === true,
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
              product_price, review_fee, amount, transfer_memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [batch.id, it.sheetId, it.tabName, it.rowIndex, it.campaignId, it.reviewerName, it.phone8,
           it.bankName, it.bankCode, it.bankAccount, it.accountHolder,
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
            ru.id AS result_upload_id, ru.file_name AS result_file_name, ru.row_count AS result_row_count,
            ru.success_count AS result_success_count, ru.failed_count AS result_failed_count,
            ru.applied_count AS result_applied_count, ru.applied AS result_applied,
            ru.uploaded_at AS result_uploaded_at, ru.applied_at AS result_applied_at,
            (ru.file_blob IS NOT NULL) AS result_has_file
       FROM payment_batches b
       LEFT JOIN LATERAL (
         SELECT id, file_name, row_count, success_count, failed_count, applied_count, applied,
                uploaded_at, applied_at, file_blob
           FROM payment_result_uploads WHERE batch_id = b.id
          ORDER BY uploaded_at DESC, id DESC LIMIT 1
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

function _batchView(b) {
  return {
    id: b.id, seq: Number(b.seq), bank: b.bank, bankLabel: BANK_LABEL[b.bank] || b.bank,
    status: b.status, itemCount: b.item_count, totalAmount: Number(b.total_amount || 0),
    createdBy: b.created_by || '', createdAt: b.created_at,
    downloadCount: b.download_count, lastDownloadedAt: b.last_downloaded_at,
    lastDownloadedBy: b.last_downloaded_by || '',
    cancelledAt: b.cancelled_at, cancelledBy: b.cancelled_by || '',
    paidCount: b.paid_count == null ? undefined : b.paid_count,
    failedCount: b.failed_count == null ? undefined : b.failed_count,
    resultUploadId: b.result_upload_id || '',
    resultFileName: b.result_file_name || '',
    resultRowCount: b.result_row_count == null ? undefined : Number(b.result_row_count),
    resultSuccessCount: b.result_success_count == null ? undefined : Number(b.result_success_count),
    resultFailedCount: b.result_failed_count == null ? undefined : Number(b.result_failed_count),
    resultAppliedCount: b.result_applied_count == null ? undefined : Number(b.result_applied_count),
    resultApplied: b.result_applied === true,
    resultCanApply: !!(b.result_upload_id && b.result_has_file && b.result_applied !== true
      && (Number(b.result_success_count || 0) + Number(b.result_failed_count || 0) > 0)),
  };
}

/* ══════════════════════════════════════════════════════════
   3) 은행 서식 엑셀 생성
   ══════════════════════════════════════════════════════════ */

/**
 * 은행별 다건이체 등록 서식(.xlsx).
 * ★ 헤더·열 순서는 각 은행 **공식 양식 그대로**다(케이뱅크는 공유받은 원본 양식 기준).
 *   임의로 바꾸면 은행 사이트가 파일을 거부한다.
 */
async function buildWorkbook(bank, items) {
  // ★ 서식에 찍히는 **정식 명칭**(`bankNameByCode`)이 오버레이 값이어야 한다 —
  //   화면에서 이름을 고쳐 놓고 파일엔 옛 이름이 나가면 은행이 거부한다.
  await _bankOv.ensureBankOverrides();
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'review-web-system';

  if (bank === 'kbank') {
    const ws = wb.addWorksheet('대량이체등록정보');
    ws.addRow(['* 입금은행(코드/은행명/증권사명)', '* 입금계좌', '* 이체금액(원)', '받는분 통장표시 ', '예금주']);
    for (const it of items) {
      // ★ 리뷰어가 적은 원문('신한')이 아니라 **표준코드에서 파생한 정식명**('신한은행')을 쓴다.
      //   양식 가이드가 "형식에 맞는 은행/증권사명 혹은 코드만" 허용하므로 원문은 거부될 수 있다.
      const code = String(it.bank_code || it.bankCode || '');
      ws.addRow([
        bankNameByCode(code) || code,
        // ★ 계좌는 마지막까지 `normalizeAccount` 단일 출처로 숫자만 남긴다 —
        //   옛 원장 스냅샷에 '-' 가 섞여 있어도 은행 서식에는 절대 나가지 않게(업로드 거부 방지).
        normalizeAccount(it.bank_account || it.bankAccount || ''),
        _int(it.amount),
        it.transfer_memo || it.transferMemo || '',
        it.account_holder || it.accountHolder || '',
      ]);
    }
    ws.columns = [{ width: 28 }, { width: 20 }, { width: 14 }, { width: 18 }, { width: 14 }];
  } else {
    const ws = wb.addWorksheet('다건이체');
    ws.addRow(['입금은행코드', '입금계좌번호', '이체금액', '예상예금주', '보내는분 통장표시내용', '받는분 통장표시내용', 'CMS/모집인코드']);
    for (const it of items) {
      ws.addRow([
        String(it.bank_code || it.bankCode || ''),     // ★ 문자열 — '045'의 앞 0이 사라지면 안 됨
        normalizeAccount(it.bank_account || it.bankAccount || ''),   // ★ 위와 같은 이유(숫자만 · 앞 0 보존)
        _int(it.amount),
        it.account_holder || it.accountHolder || '',
        '',
        it.transfer_memo || it.transferMemo || '',
        '',
      ]);
    }
    ws.columns = [{ width: 14 }, { width: 22 }, { width: 14 }, { width: 14 }, { width: 20 }, { width: 20 }, { width: 16 }];
  }
  // ★★ 계좌·은행코드는 **문자열 셀 + 텍스트 서식(`@`)** 으로 나간다 —
  //    숫자로 해석되면 `0123…` 의 앞 0 이 날아가거나 긴 계좌가 지수표기(1.23E+12)로 바뀌어
  //    은행 업로드가 통째로 거부된다(담당자가 매번 `'0123` 처럼 손으로 고치던 지점).
  //    금액만 숫자 그대로 둔다(은행 양식이 수치를 요구).
  wb.worksheets[0].eachRow((row, i) => {
    if (i === 1) return;
    row.eachCell(cell => { if (typeof cell.value === 'string') cell.numFmt = '@'; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 다운로드 파일명 — 예) 케이뱅크_다건이체_20260804_124.xlsx */
function batchFileName(batch) {
  const d = new Date(batch.createdAt || Date.now());
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const ymd = kst.toISOString().slice(0, 10).replace(/-/g, '');
  return `${BANK_LABEL[batch.bank] || batch.bank}_다건이체_${ymd}_${batch.seq}.xlsx`;
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
 *          bank?:string|null, memo?:string|null}} p
 *        bank/memo 는 **undefined = 변경 없음**, `''` = 지움(자동으로 되돌림).
 * @returns {{ok:true, target:'campaign'|'tab', bank:string|null, memo:string}}
 */
async function saveTransferSetting({ sheetId, tabName, campaignId, bank, memo }) {
  const sid = String(sheetId || '').trim();
  const tab = String(tabName || '').trim();
  if (!sid || !tab) throw new PaymentFixError('bad_target', '작업(시트·탭)이 지정되지 않았습니다.');

  const touchBank = bank !== undefined;
  const touchMemo = memo !== undefined;
  if (!touchBank && !touchMemo) throw new PaymentFixError('empty', '변경할 값이 없습니다.');

  // 빈 값 = 지움(자동 판정으로 되돌림) / 모르는 표기는 거부(추측 저장 금지)
  let bankCode = null;
  if (touchBank && String(bank || '').trim() !== '') {
    bankCode = normalizeBankChoice(bank);
    if (!bankCode) throw new PaymentFixError('bad_bank', '이체은행은 케이뱅크 또는 하나은행만 지정할 수 있습니다.');
  }
  const memoText = touchMemo ? normalizeMemo(String(memo || '')) : null;

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
    await pool.query(
      `UPDATE recruit_campaigns
          SET transfer_bank = CASE WHEN $2::bool THEN $3::text ELSE transfer_bank END,
              transfer_memo = CASE WHEN $4::bool THEN $5::text ELSE transfer_memo END
        WHERE id = $1`,
      [campId, touchBank, bankCode, touchMemo, memoText]);
    return { ok: true, target: 'campaign', bank: bankCode, memo: memoText || '' };
  }

  // 탭 설정 — ★ 표기는 **한글 라벨**(관리자 대시보드 탭설정이 그 형식을 그대로 비교해 배지를 그린다)
  const { rowCount } = await pool.query(
    `UPDATE tab_configs
        SET transfer_bank = CASE WHEN $3::bool THEN $4::text ELSE transfer_bank END,
            deposit_name  = CASE WHEN $5::bool THEN $6::text ELSE deposit_name END,
            updated_at    = NOW()
      WHERE sheet_id = $1 AND tab_name = $2`,
    [sid, tab, touchBank, bankCode ? tabBankLabel(bankCode) : '', touchMemo, memoText]);
  if (!rowCount) throw new PaymentFixError('tab_not_found', '탭 설정이 없어 저장하지 못했습니다(작업오더 접수 전 탭일 수 있습니다).');
  return { ok: true, target: 'tab', bank: bankCode, memo: memoText || '' };
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
async function saveReviewerAccount({ reviewerId, subPhone8, bankName, bankAccount, accountHolder }) {
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
  if (sub) {
    // 타계정 — 소유자 행의 배열에서 그 명의 항목만 병합
    const { rows } = await pool.query(`SELECT sub_accounts FROM reviewers WHERE id = $1`, [id]);
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
    await pool.query(`UPDATE reviewers SET sub_accounts = $2::jsonb WHERE id = $1`, [id, JSON.stringify(next)]);
    return { ok: true, target: 'sub' };
  }

  const { rowCount } = await pool.query(
    `UPDATE reviewers
        SET bank_name      = CASE WHEN $2::text <> '' THEN $2::text ELSE bank_name END,
            bank_account   = CASE WHEN $3::text <> '' THEN $3::text ELSE bank_account END,
            account_holder = CASE WHEN $4::text <> '' THEN $4::text ELSE account_holder END
      WHERE id = $1`,
    [id, bn, ba, ah]);
  if (!rowCount) throw new PaymentFixError('reviewer_not_found', '리뷰어를 찾지 못했습니다.');
  return { ok: true, target: 'self' };
}

module.exports = {
  BANK_LABEL, bankFromGoodsCostType, normalizeBankChoice, tabBankLabel, tabSheetUrl,
  listPaymentTargets, createBatch, cancelBatch, listBatches, getBatch, markDownloaded,
  buildWorkbook, batchFileName,
  saveTransferSetting, saveReviewerAccount, PaymentFixError,
};
