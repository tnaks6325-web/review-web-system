/**
 * productMismatchVerify.service.js — 고른 상품 ≠ 실제 산 상품 (결정 230 · 사용자 확정 2026-10-12)
 *
 * ★ 사고(2026-10-12 위드프렌즈 실측): 공고에서 상품을 골라 참여한 리뷰어는 주문서를 낼 때 **처음 고른 상품이
 *   무조건 기록**된다(061 옵션 서버권위). 실제로 다른 상품을 사면 담당자가 캡처·금액을 보고 작업표를 손으로 고쳤고,
 *   참여 기록은 옛 상품 그대로 남아 상품별 인원 세기가 어긋났다(45일 1,022건 중 4건 — 탄소매트 퀸더블→킹 등).
 *
 * 사용자 확정(2026-10-12, 같은 날 ①·② 를 아래로 바꿈):
 *   ① 캡처에서 읽은 상품이 공고의 **다른 상품 하나**를 분명히 가리키면(글자 — 못 정하면 결제금액이 다른 상품 하나의 가격과
 *      정확히 같을 때), 아무것도 쓰기 전에
 *      "잘못 구매한 것 같아요" 경고로 실제로 산 상품을 묻는다(캡처 상품 / 참여할 때 고른 상품).
 *   ② 리뷰어가 **고른 상품과 다른 상품**을 샀다고 답하면 = 잘못 구매 → **제출 불가**(담당자 문의 안내 + 이상로그).
 *      고른 상품을 샀다고 답하면(AI 가 잘못 읽음) 그대로 접수하고, 담당자가 볼 수 있게 이상로그(warn)를 남긴다.
 *      ⇒ 참여 기록·원장의 상품은 **언제나 참여할 때 고른 상품**이다(홀드를 다른 상품으로 옮기지 않는다).
 *   ③ (가) 담당자가 작업표 「상품」(·상품옵션) 칸을 고치면 그 리뷰어의 참여 기록도 따라 바꾼다(되돌리면 같이 돌아간다).
 *
 * ★★ 완화 금지
 *   · 글자 → 상품은 `utils/productCaptureMatch` 하나 — **둘 이상 걸리면 묻지 않는다**(모르면 아무 일도 안 일어난다).
 *   · ② 의 판정은 **서버가** 한다 — 화면이 보낸 `confirmedProductKey` 가 홀드 상품과 다르면 막는다(화면을 믿지 않는다).
 *   · ③ 은 **참여 기록만** 바꾼다. 주문 원장(`order_submissions.selected_opt_key·selected_product`)에 작업표 값을
 *     되쓰지 않는다 — 결정 018 「원장은 리뷰어가 고른 값이 진실」(역주입 금지) 그대로.
 *   · 판정 실패·조회 실패·판독값 없음은 **종전 동작**(fail-open) — 막는 것은 리뷰어가 "다른 상품을 샀다"고 답한 경우뿐.
 * 끄는 스위치(env): `CAMPAIGN_PRODUCT_VERIFY=0` → ①②③④⑤ 모두 즉시 종전.
 *
 * 결정 236 (사용자 확정 2026-10-13 — 위드프렌즈 재현 뒤 남은 틈 두 개):
 *   ④ 리뷰어가 "고른 상품이 맞다"고 답했는데 **결제금액이 다른 상품 하나의 가격과 정확히 같으면**(상품 가격 2종 이상 ·
 *      고른 상품 가격과 다름) 한 번 더 묻는다 — "○○를 주문했다고 하셨지만 결제금액 N원은 △△ 결제금액이에요"
 *      (PRODUCT_PRICE_RECHECK). 다시 확인한 뒤에도 "맞다"(priceRecheckAck)면 (가) 접수 + 담당자 확인용 이상로그
 *      — 쿠폰 할인으로 다른 상품 가격과 우연히 같아지는 정상 구매가 있어(117건 시험 중 의류 5건) 막지 않는다.
 *   ⑤ 담당자 수동 입력(외부모집 수동제출)도 같은 판정을 거친다 — 결제금액 · 붙인 캡처의 글자 · 그 연락처가 최근 참여
 *      신청 때 고른 상품(다른 공고 포함). 걸리면 **쓰기 0건**으로 되돌려 확인을 받고(needConfirm:'product_check'),
 *      확인하면 (가) 접수 + 이상로그(리뷰어가 "담당자에게 문의"로 오는 길이라 담당자까지 막으면 넣을 길이 없다).
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { mentionedOptions, capturedOtherOption, matchOption } = require('../utils/productCaptureMatch');
const _won = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : 0; };

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }

function isEnabled() { return String(process.env.CAMPAIGN_PRODUCT_VERIFY || '').trim() !== '0'; }

/**
 * @param {Date|string|null} [at] 신청 시각 — 주면 결제금액을 **그 시각의 금액**으로 바꿔 돌려준다(결정 274 5단계 · D3).
 *   금액을 중간에 바꾼 공고에서, 바꾸기 전에 신청해 옛 금액으로 정상 구매한 리뷰어가 "다른 상품 가격" 으로 걸리지 않게.
 *   이력이 없는 옵션·조회 실패 = 지금 금액(종전 동작).
 */
async function _loadOptions(db, campaignId, at = null) {
  const { rows } = await db.query(
    `SELECT id, opt_key, product_name, status, pay_amount FROM campaign_options WHERE campaign_id = $1 ORDER BY (status='closed'), sort_order, id`,
    [String(campaignId)]);
  if (!at || !rows.length) return rows;
  const hist = await require('./campaignPriceHistory.service').optionPricesAt(db, campaignId, at);
  if (!hist.size) return rows;
  return rows.map(r => (hist.has(Number(r.id)) ? { ...r, pay_amount: hist.get(Number(r.id)) } : r));
}

/** 화면에 보일 상품 이름 — 공고에 적힌 이름 그대로(리뷰어가 참여할 때 본 이름). */
function _label(key) { return String(key || ''); }
const _wonText = (n) => Number(n || 0).toLocaleString('ko-KR');

/**
 * 결제금액 근거 — 단일 출처(리뷰어 제출 ①④ · 담당자 수동 입력 ⑤가 같이 쓴다).
 * 상품 가격이 2종 이상이고, 결제금액이 고른 상품 가격과 다르며, **다른 상품 하나의 가격과 정확히 같을 때만** 그 상품을 돌려준다.
 * 가격이 같은 상품끼리·어느 가격과도 안 맞는 금액(쿠폰 등)·고른 상품 가격 모름 = null(근거 없음 — 묻지 않는다).
 */
function priceOtherOption(opts, heldKey, paidRaw) {
  const paid = _won(paidRaw);
  if (!paid || !Array.isArray(opts)) return null;
  if (new Set(opts.map(o => _won(o.pay_amount)).filter(Boolean)).size < 2) return null;
  const heldPay = _won((opts.find(o => o.opt_key === heldKey) || {}).pay_amount);
  if (!heldPay || paid === heldPay) return null;
  const same = opts.filter(o => o.opt_key !== heldKey && _won(o.pay_amount) === paid);
  return same.length === 1 ? { key: same[0].opt_key, paid, heldPay } : null;
}

/**
 * ①② 주문 제출 때 판정 — 쓰기 0.
 * @returns {Promise<{action:'none'}|{action:'keep', capturedKey, priceOther?, paid?}|{action:'recheck',paid,chosen,captured,error}|{action:'prompt',basis:'text'|'price',paid?,chosen,captured}|{action:'wrong',chosen,bought,error}>}
 *   keep    = 리뷰어가 "고른 상품을 샀다"고 확인(캡처를 AI 가 다르게 읽음) → 접수 + 이상로그
 *             (priceOther 가 있으면 = 결제금액이 다른 상품 가격인데 다시 확인하고도 "맞다" — ④)
 *   recheck = "고른 상품을 샀다"고 했는데 결제금액이 다른 상품 하나의 가격 → 한 번 더 묻는다(④ · 쓰기 0)
 *   wrong   = 리뷰어가 "다른 상품을 샀다"고 확인 → 잘못 구매 · 제출 불가
 */
async function decideAtSubmit({ holdCtx, captureText, captureOption = '', capturePrice = '', confirmedKey, priceAck = false, db = getPool() }) {
  if (!isEnabled()) return { action: 'none' };
  if (!holdCtx || !holdCtx.verified || !holdCtx.optionKey || holdCtx.doneKind) return { action: 'none' };
  try {
    const opts = await _loadOptions(db, holdCtx.campaignId, holdCtx.appliedAt || null);
    if (opts.length < 2) return { action: 'none' };
    const held = String(holdCtx.optionKey);
    // 화면이 보낸 값은 **그 공고의 상품일 때만** 답으로 받는다 — 아니면 답이 없는 것으로 보고 아래 판정을 그대로 한다
    // (결정 236 코드리뷰: 지어낸 값으로 경고·다시 묻기를 기록 없이 건너뛰지 못하게).
    const _c = String(confirmedKey == null ? '' : confirmedKey).trim();
    const confirmed = _c && opts.some(o => o.opt_key === _c) ? _c : '';
    if (confirmed) {
      if (confirmed === held) {
        const capturedKey = capturedOtherOption(captureText, opts, held, { shortText: captureOption }) || '';
        // ④ "고른 상품이 맞다"는 답을 결제금액으로 한 번 더 확인한다 — 다시 확인하고도 맞다면(priceAck) 접수 + 이상로그.
        const po = priceOtherOption(opts, held, capturePrice);
        if (po && !priceAck) {
          return {
            action: 'recheck', paid: po.paid, chosen: { key: held, label: _label(held) }, captured: { key: po.key, label: _label(po.key) },
            error: `「${_label(held)}」를 주문했다고 하셨지만, 결제금액 ${_wonText(po.paid)}원은 「${_label(po.key)}」 결제금액이에요. 잘못 구매한 것으로 보여요. 주문 내역을 다시 확인해 주세요.`,
          };
        }
        return { action: 'keep', capturedKey, priceOther: po ? po.key : '', paid: po ? po.paid : 0 };
      }
      return {
        action: 'wrong', chosen: { key: held, label: _label(held) }, bought: { key: confirmed, label: _label(confirmed) },
        error: `참여할 때 고른 「${_label(held)}」와 다른 「${_label(confirmed)}」를 구매했어요. 잘못 구매한 주문은 제출할 수 없어요. 담당자에게 문의해 주세요.`,
      };
    }
    // 약한 이름(사이즈 `L`·`100`·`킹`)은 캡처의 **옵션 글자**에서만 낱말 일치로 본다 — 상품명 속 모델번호로 걸리지 않게.
    const other = capturedOtherOption(captureText, opts, held, { shortText: captureOption });
    if (other) return { action: 'prompt', basis: 'text', chosen: { key: held, label: _label(held) }, captured: { key: other, label: _label(other) } };
    // ② 결제금액 — 글자로 **어느 상품인지 못 정했을 때만**, 캡처 금액이 고른 상품 가격과 다르고 **다른 상품 하나의 가격과 정확히 같으면**.
    //   (운영 캡처 117건 실측: 글자만 = 실제 잘못 구매 4건 중 2건 · 글자+금액 = 4건 모두 · 정상 113건 경고 0.
    //    금액만 쓰면 쿠폰 3,000원이 다른 상품 가격과 우연히 같아진 정상 5건이 걸렸다 — 글자가 고른 상품을 말하면 금액은 보지 않는다.)
    const read = matchOption(captureText, opts, { shortText: captureOption });
    const po = read ? null : priceOtherOption(opts, held, capturePrice);
    if (po) {
      return { action: 'prompt', basis: 'price', paid: po.paid, chosen: { key: held, label: _label(held) }, captured: { key: po.key, label: _label(po.key) } };
    }
    return { action: 'none' };
  } catch (e) {
    logger.warn(`[product-verify] 판정 실패 — 종전대로 접수: ${(e && e.message) || e}`);
    return { action: 'none' };
  }
}

/** ③ 이 칸이 "상품을 가리키는 칸"인가 — 「상품」 칸 또는 상품옵션 칸(리뷰옵션=작업지시 칸 제외). 매퍼 파생 단일 출처. */
function isProductColumn(header) {
  const h = String(header || '').trim();
  if (!h) return false;
  const ledger = require('./orderLedger.service');
  if (ledger.productWriteColumns([h]).includes(0)) return true;   // 「상품」 칸 — 매퍼 파생(사본 금지)
  const { isReviewOptionHeader } = require('../utils/reviewType');
  return ledger.optionWriteColumns([h]).includes(0) && !isReviewOptionHeader(h);
}

/**
 * ③ 담당자가 작업표 상품 칸을 고치거나 되돌린 **뒤**(그 트랜잭션 커밋 뒤) 부른다.
 *   그 줄의 지금 보이는 값(주문 앵커 편집 > 물리행 앵커 편집 > 원래 값)이 가리키는 상품으로 참여 기록을 맞춘다.
 *   ★ 정원 검사는 하지 않는다 — 담당자가 실제 구매를 확인하고 고친 값이다(막으면 담당자가 고칠 길이 없다).
 * @returns {Promise<{synced:false, reason}|{synced:true, from, to, applicationId}>}
 */
async function syncApplicationFromWorkboard({ sheetId, tabName, rowId, field, by = 'admin', db = getPool() }) {
  if (!isEnabled()) return { synced: false, reason: 'disabled' };
  const header = typeof field === 'string' && field.startsWith('col:') ? field.slice(4) : '';
  if (!isProductColumn(header)) return { synced: false, reason: 'not_product_column' };
  let client = null;
  try {
    client = await db.connect();   // ★ try 안 — 연결 실패가 이미 저장된 편집을 "저장 실패"로 보이게 하지 않게(코드리뷰)
    const { rows: pr } = await client.query(
      `SELECT id, order_submission_id, row_json FROM campaign_participants
        WHERE id = $1 AND sheet_id = $2 AND tab_name = $3 AND deleted_at IS NULL`, [rowId, sheetId, tabName]);
    const row = pr[0];
    if (!row || !row.order_submission_id) return { synced: false, reason: 'no_order' };
    // 어느 공고인지만 먼저(잠금 없이) — 잠글 행을 알아야 한다.
    const { rows: ap0 } = await client.query(
      `SELECT DISTINCT campaign_id FROM campaign_applications
        WHERE order_submission_id = $1 AND status = 'submitted' AND option_key IS NOT NULL`, [row.order_submission_id]);
    if (ap0.length !== 1) return { synced: false, reason: ap0.length ? 'ambiguous_application' : 'no_application' };
    // ★ 잠금 순서 = 다른 옵션 쓰기와 같다(공고 행 → 신청 행). 참여 기록·지금 보이는 값은 **잠근 뒤에** 읽는다 —
    //   두 담당자가 같은 칸을 거의 동시에 고치면 뒤에 들어온 맞추기가 앞의 것을 기다렸다가 **마지막 편집**을 읽는다(Codex P2).
    await client.query('BEGIN');
    await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [ap0[0].campaign_id]);
    const done = async (out) => { await client.query('COMMIT'); return out; };
    const { rows: ap } = await client.query(
      `SELECT id, campaign_id, option_key FROM campaign_applications
        WHERE order_submission_id = $1 AND status = 'submitted' AND option_key IS NOT NULL
        ORDER BY id DESC LIMIT 2 FOR UPDATE`, [row.order_submission_id]);
    if (ap.length !== 1) return done({ synced: false, reason: ap.length ? 'ambiguous_application' : 'no_application' });
    const app = ap[0];
    // 지금 보이는 값 — 읽는 쪽(workdeskTab)과 같은 순서: 주문 앵커 편집 위에 물리행 앵커 편집을 밑에 깐다.
    const { rows: ed } = await client.query(
      `SELECT anchor_type, value_text FROM participant_edits
        WHERE sheet_id = $1 AND tab_name = $2 AND field = $3 AND reverted_at IS NULL AND kind = 'text'
          AND ((anchor_type = 'order' AND anchor_value = $4) OR (anchor_type = 'manual' AND anchor_value = $5))
        ORDER BY (anchor_type = 'order') DESC, created_at DESC LIMIT 1`,
      [sheetId, tabName, field, String(row.order_submission_id), String(row.id)]);
    const rj = row.row_json && typeof row.row_json === 'object' ? row.row_json : {};
    const shown = ed.length ? ed[0].value_text : rj[header];
    const opts = await _loadOptions(client, app.campaign_id);
    if (opts.length < 2) return done({ synced: false, reason: 'single_option' });
    const target = matchOption(shown, opts);
    if (!target) return done({ synced: false, reason: 'unmatched', mentioned: [...mentionedOptions(shown, opts)].length });
    if (target === app.option_key) return done({ synced: false, reason: 'same' });
    const upd = await client.query(
      `UPDATE campaign_applications SET option_key = $3
        WHERE id = $1 AND option_key = $2 AND status = 'submitted' RETURNING id`, [app.id, app.option_key, target]);
    await client.query('COMMIT');
    if (!upd.rows.length) return { synced: false, reason: 'changed_meanwhile' };
    logger.info(`[product-verify] 작업표 수정 → 참여 기록 상품 변경 camp=${app.campaign_id} app=${app.id} ` +
      `${app.option_key} → ${target} by ${String(by).slice(0, 40)}`);
    try { require('../routes/campaign.routes').invalidateListCache(); } catch (_) { /* noop */ }
    return { synced: true, from: app.option_key, to: target, applicationId: app.id };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* noop */ } }
    logger.warn(`[product-verify] 참여 기록 맞추기 실패(무시): ${(e && e.message) || e}`);
    return { synced: false, reason: 'exception' };
  } finally {
    if (client) client.release();
  }
}

/**
 * ⑤ 담당자 수동 입력(외부모집 수동제출) 상품 확인 — 쓰기 0. 결정 236.
 * @param {{campaignId:string, items:Array<{index:number, name?:string, chosenKey?:string, targetApplicationId?:string|number,
 *          price?:string, captureName?:string, captureOption?:string, phone8?:string}>}} p
 * @returns {Promise<Array<{index:number, name:string, chosen:string, notes:string[], kinds:string[], suggestKey:string}>>} 걸린 줄만
 *   kinds ⊂ price | capture | application — 화면이 확인창 첫 줄을 고른다(신청 기록만이면 "산 상품이 다르다"고 말하지 않는다).
 * ★ 12시간(운영 실측 2026-10-13 · 지난 30일 수동 입력 145건): 3일이면 14건이 걸리고 그중 12건이 20~68시간 전 무관한 공고의
 *   만료 신청이었다(오경고). 12시간이면 2건 — 둘 다 확인할 만한 건(1시간 전 다른 공고 신청 · 4시간 전 같은 브랜드 다른 맛).
 * 근거 세 가지(하나라도 걸리면 그 줄):
 *   · 결제금액 — priceOtherOption(리뷰어 제출과 같은 규칙)
 *   · 붙인 캡처의 글자 — capturedOtherOption(리뷰어 제출과 같은 규칙 · 둘 이상 걸리면 모름)
 *   · 참여 신청 기록 — 그 연락처가 최근 12시간 안에 신청만 하고 접수되지 않은 신청(applied·expired)이 있는데
 *     **이 공고·이 상품과 맞는 것이 하나도 없으면** 가장 최근 신청을 알린다(다른 공고 포함 — 조○○ 사례).
 *     공고 화면에서 신청을 골라 확정하는 경우(targetApplicationId)는 그 신청이 곧 고른 상품이라 보지 않는다.
 * ★ fail-open — 조회 실패·근거 없음은 걸지 않는다(종전대로 접수).
 */
async function checkManualEntries({ campaignId, items, db = getPool() }) {
  if (!isEnabled() || !campaignId || !Array.isArray(items) || !items.length) return [];
  let opts = [];
  try { opts = await _loadOptions(db, campaignId); } catch (e) {
    logger.warn(`[product-verify] 수동 입력 상품 목록 조회 실패 — 종전대로 접수: ${(e && e.message) || e}`);
    return [];
  }
  const out = [];
  for (const it of items) {
    try {
      let chosen = String(it.chosenKey || '');
      if (it.targetApplicationId) {
        const { rows } = await db.query(`SELECT option_key FROM campaign_applications WHERE id = $1 AND campaign_id = $2`,
          [String(it.targetApplicationId), String(campaignId)]);
        if (rows[0] && rows[0].option_key) chosen = String(rows[0].option_key);
      }
      const notes = [], kinds = [];
      let suggestKey = '';
      // 고른 상품이 이 공고 목록에 없으면(삭제·오타) 금액·캡처 근거는 보지 않는다 — 그 줄은 접수 단계가 따로 거른다.
      if (chosen && opts.length >= 2 && opts.some(o => o.opt_key === chosen)) {
        const po = priceOtherOption(opts, chosen, it.price);
        if (po) {
          notes.push(`결제금액 ${_wonText(po.paid)}원은 「${_label(po.key)}」 가격입니다(고른 상품 가격 ${_wonText(po.heldPay)}원)`); kinds.push('price');
          suggestKey = po.key;
        }
        const capText = [it.captureName, it.captureOption].map(v => String(v == null ? '' : v).slice(0, 300).trim()).filter(Boolean).join(' ');
        const other = capText ? capturedOtherOption(capText, opts, chosen, { shortText: String(it.captureOption || '').slice(0, 300) }) : '';
        if (other) {
          notes.push(`구매 캡처에는 「${_label(other)}」로 보입니다`); kinds.push('capture');
          if (!suggestKey) suggestKey = other;
        }
      }
      const p8 = String(it.phone8 || '').replace(/\D/g, '').slice(-8);
      if (!it.targetApplicationId && p8.length === 8) {
        const { rows: apps } = await db.query(
          `SELECT a.campaign_id, a.option_key, a.applied_at, rc.title
             FROM campaign_applications a JOIN recruit_campaigns rc ON rc.id = a.campaign_id
            WHERE a.phone8 = $1 AND a.status IN ('applied','expired') AND a.applied_at > NOW() - interval '12 hours'
              AND a.order_submission_id IS NULL AND a.late_order_id IS NULL
            ORDER BY a.applied_at DESC`, [p8]);   // ★ 늦게라도 주문이 붙은 만료 신청은 "신청만 한 기록"이 아니다(Codex 리뷰) · 12시간 창 전체를 본다
        const fits = (a) => String(a.campaign_id) === String(campaignId)
          && (!chosen || !a.option_key || String(a.option_key) === chosen);
        if (apps.length && !apps.some(fits)) {
          const a = apps[0];
          const kst = a.applied_at ? new Date(new Date(a.applied_at).getTime() + 9 * 3600 * 1000) : null;   // 한국 날짜(서버 시간대 무관)
          const when = kst && !isNaN(kst) ? `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}` : '최근';
          const opt = a.option_key ? `「${_label(a.option_key)}」` : '';
          notes.push(String(a.campaign_id) === String(campaignId)
            ? `이 연락처는 ${when} 참여 신청 때 ${opt}을(를) 골랐습니다`
            : `이 연락처는 ${when} 다른 공고 「${String(a.title || '').slice(0, 30)}」에 ${opt ? opt + '(으)로 ' : ''}참여 신청했습니다`);
          kinds.push('application');
        }
      }
      if (notes.length) out.push({ index: it.index, name: String(it.name || ''), chosen, notes, kinds, suggestKey });
    } catch (e) {
      logger.warn(`[product-verify] 수동 입력 상품 확인 실패(그 줄은 종전대로): ${(e && e.message) || e}`);
    }
  }
  return out;
}

module.exports = {
  isEnabled, decideAtSubmit, syncApplicationFromWorkboard, isProductColumn, priceOtherOption, checkManualEntries, __setPoolForTest,
};
