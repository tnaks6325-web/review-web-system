/**
 * productMismatchVerify.service.js — 고른 상품 ≠ 실제 산 상품 (결정 230 · 사용자 확정 2026-10-12)
 *
 * ★ 사고(2026-10-12 위드프렌즈 실측): 공고에서 상품을 골라 참여한 리뷰어는 주문서를 낼 때 **처음 고른 상품이
 *   무조건 기록**된다(061 옵션 서버권위). 실제로 다른 상품을 사면 담당자가 캡처·금액을 보고 작업표를 손으로 고쳤고,
 *   참여 기록은 옛 상품 그대로 남아 상품별 인원 세기가 어긋났다(45일 1,022건 중 4건 — 탄소매트 퀸더블→킹 등).
 *
 * 사용자 확정:
 *   ① (가) 캡처에서 읽은 상품이 **다른 상품 하나**를 분명히 가리키면 제출 전에 리뷰어에게 묻고,
 *          리뷰어가 고른 "실제로 산 상품"으로 참여 기록·주문·작업표를 함께 기록한다.
 *   ② (나) 그 상품 자리가 없으면(정원·하루 한도·품절 멈춤·차례 아님·마감) **제출을 막고** 담당자 문의로 안내한다.
 *   ③ (가) 담당자가 작업표 「상품」(·상품옵션) 칸을 고치면 그 리뷰어의 참여 기록도 따라 바꾼다(되돌리면 같이 돌아간다).
 *
 * ★★ 완화 금지
 *   · 상품 바꾸기 판정은 구매 전 옵션 변경(`campaign.routes` `changeHoldOption`)을 **그대로** 탄다 — 정원·하루 한도·
 *     순차진행 차례(212·228)·품절 멈춤(229)·잠금 순서가 한 곳에 있다. 여기서 자리 판정을 다시 만들지 말 것.
 *   · 글자 → 상품은 `utils/productCaptureMatch` 하나 — **둘 이상 걸리면 묻지 않는다**(모르면 아무 일도 안 일어난다).
 *   · ③ 은 **참여 기록만** 바꾼다. 주문 원장(`order_submissions.selected_opt_key·selected_product`)에 작업표 값을
 *     되쓰지 않는다 — 결정 018 「원장은 리뷰어가 고른 값이 진실」(역주입 금지) 그대로.
 *   · 판정 실패·조회 실패는 **종전 동작**(fail-open) — 접수를 막는 것은 ② 하나뿐이다.
 * 끄는 스위치(env): `CAMPAIGN_PRODUCT_VERIFY=0` → ①·③ 모두 즉시 종전.
 */
'use strict';

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { mentionedOptions, capturedOtherOption, matchOption } = require('../utils/productCaptureMatch');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(p) { _pool = p; }
let _campRoutes = null;
function _changeHoldOption(args) {
  const fn = _campRoutes ? _campRoutes.changeHoldOption : require('../routes/campaign.routes').changeHoldOption;
  return fn(args);
}
function __setCampaignRoutesForTest(r) { _campRoutes = r; }

function isEnabled() { return String(process.env.CAMPAIGN_PRODUCT_VERIFY || '').trim() !== '0'; }

/** 자리가 없어 막는 거절 사유(②) — change-option 의 거절 사유와 같은 말. */
const UNAVAILABLE_REASONS = new Set(['option_soldout', 'option_today_done', 'option_closed', 'option_paused', 'option_waiting', 'option_invalid']);

async function _loadOptions(db, campaignId) {
  const { rows } = await db.query(
    `SELECT opt_key, product_name, status FROM campaign_options WHERE campaign_id = $1 ORDER BY (status='closed'), sort_order, id`,
    [String(campaignId)]);
  return rows;
}

/** 화면에 보일 상품 이름 — 공고에 적힌 이름 그대로(리뷰어가 참여할 때 본 이름). */
function _label(key) { return String(key || ''); }

/**
 * ① 주문 제출 때 판정 — 쓰기 0.
 * @returns {Promise<{action:'none'}|{action:'keep'}|{action:'prompt',chosen,captured}|{action:'switch',newKey}>}
 */
async function decideAtSubmit({ holdCtx, captureText, confirmedKey, db = getPool() }) {
  if (!isEnabled()) return { action: 'none' };
  if (!holdCtx || !holdCtx.verified || !holdCtx.optionKey || holdCtx.doneKind) return { action: 'none' };
  try {
    const opts = await _loadOptions(db, holdCtx.campaignId);
    if (opts.length < 2) return { action: 'none' };
    const held = String(holdCtx.optionKey);
    const confirmed = String(confirmedKey == null ? '' : confirmedKey).trim();
    if (confirmed) {
      if (confirmed === held) return { action: 'keep' };
      // 화면이 보낸 값은 **그 공고의 상품일 때만** 받는다(지어낸 값 차단) — 아니면 종전대로 고른 상품.
      return opts.some(o => o.opt_key === confirmed) ? { action: 'switch', newKey: confirmed } : { action: 'none' };
    }
    const other = capturedOtherOption(captureText, opts, held);
    if (!other) return { action: 'none' };
    return { action: 'prompt', chosen: { key: held, label: _label(held) }, captured: { key: other, label: _label(other) } };
  } catch (e) {
    logger.warn(`[product-verify] 판정 실패 — 종전대로 접수: ${(e && e.message) || e}`);
    return { action: 'none' };
  }
}

/**
 * ① 리뷰어가 "실제로 산 상품"을 골랐을 때 홀드를 그 상품으로 옮긴다(구매 전 옵션 변경과 같은 판정·잠금).
 * @returns {Promise<{ok:true}|{ok:false, blocked:true, reason, error}|{ok:false, blocked:false, reason}>}
 *   blocked = ② 자리가 없어 제출을 막아야 함 / blocked:false = 옮기지 못했지만 막을 일은 아님(만료 등 → 종전대로 접수)
 */
async function switchToActual({ holdCtx, newKey }) {
  try {
    const out = await _changeHoldOption({ id: holdCtx.campaignId, p8: holdCtx.phone8, token: holdCtx.holdToken, newKey, via: 'order-actual-product' });
    const body = (out && out.body) || {};
    if (body.ok) return { ok: true };
    if (UNAVAILABLE_REASONS.has(body.reason)) {
      return {
        ok: false, blocked: true, reason: body.reason,
        error: `실제로 산 「${_label(newKey)}」는 지금 자리가 없어 접수할 수 없어요. 담당자에게 문의해 주세요.`,
      };
    }
    return { ok: false, blocked: false, reason: body.reason || ('http_' + (out && out.code)) };
  } catch (e) {
    return { ok: false, blocked: false, reason: 'exception', message: (e && e.message) || String(e) };
  }
}

/** ③ 이 칸이 "상품을 가리키는 칸"인가 — 「상품」 칸 또는 상품옵션 칸(리뷰옵션=작업지시 칸 제외). 매퍼 파생 단일 출처. */
function isProductColumn(header) {
  const h = String(header || '').trim();
  if (!h) return false;
  const ledger = require('./orderLedger.service');
  if (h === ledger.PRODUCT_HEADER) return true;
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
  const client = await db.connect();
  try {
    const { rows: pr } = await client.query(
      `SELECT id, order_submission_id, row_json FROM campaign_participants
        WHERE id = $1 AND sheet_id = $2 AND tab_name = $3 AND deleted_at IS NULL`, [rowId, sheetId, tabName]);
    const row = pr[0];
    if (!row || !row.order_submission_id) return { synced: false, reason: 'no_order' };
    const { rows: ap } = await client.query(
      `SELECT id, campaign_id, option_key FROM campaign_applications
        WHERE order_submission_id = $1 AND status = 'submitted' AND option_key IS NOT NULL
        ORDER BY id DESC LIMIT 2`, [row.order_submission_id]);
    if (ap.length !== 1) return { synced: false, reason: ap.length ? 'ambiguous_application' : 'no_application' };
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
    if (opts.length < 2) return { synced: false, reason: 'single_option' };
    const target = matchOption(shown, opts);
    if (!target) return { synced: false, reason: 'unmatched', mentioned: [...mentionedOptions(shown, opts)].length };
    if (target === app.option_key) return { synced: false, reason: 'same' };
    // 잠금 순서 = 다른 옵션 쓰기와 같다(공고 행 → 신청 행). 조건부 UPDATE — 그 사이 누가 바꿨으면 0행(덮지 않는다).
    await client.query('BEGIN');
    await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [app.campaign_id]);
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
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    logger.warn(`[product-verify] 참여 기록 맞추기 실패(무시): ${(e && e.message) || e}`);
    return { synced: false, reason: 'exception' };
  } finally {
    client.release();
  }
}

module.exports = {
  isEnabled, decideAtSubmit, switchToActual, syncApplicationFromWorkboard, isProductColumn,
  UNAVAILABLE_REASONS, __setPoolForTest, __setCampaignRoutesForTest,
};
