'use strict';
/**
 * 이체은행 [자동] + 리뷰오더 물건비 「업체입금」 → 입금 방식을 **자동으로 저장**한다 (결정 369 2단계 · 사용자 확정 2026-11-13).
 *
 *   리뷰비가 있는 작업 → 「제품비 업체 · 리뷰비 케이뱅크」(split_kbank)
 *   리뷰비가 없는 작업 → 「업체입금」(advertiser · 업체가 전부)
 *   공고 없는 작업도 적용(탭 설정에 저장) — 사용자 확정.
 *
 * ★ 새 저장 칸·새 판정을 만들지 않는다(결정 247 완화 금지) — 값은 기존 이체은행 칸 하나에, 저장은 기존 창구
 *   `payment.saveTransferSetting`(→ `advertiserPayout.guardTransferBankWrite`)로만 한다. 그래서 고를 수 없는 작업
 *   (시트 기반 · 주인 업체 없음)은 저장되지 않고, 업체가 연결되는 순간(소유 지정 훅 · 매시 점검) 다시 시도해 저장된다.
 * ★ 사람이 고른 값은 건드리지 않는다 — 공고 이체은행·탭 이체은행이 **둘 다 비어 있을 때(=[자동])만**.
 *   케이뱅크·하나은행을 직접 고른 작업은 종전대로 경고 + 입금관리 보류(order_goods_by_advertiser)로 사람에게 맡긴다.
 * ★ 우리가 이미 이 작업에 이체 회차를 담은 줄이 있으면(pending/paid) 바꾸지 않는다(fail-closed) — 제품비를 이미 보냈을 수 있다.
 * ★ 조회·저장 실패는 아무것도 바꾸지 않고 넘어간다(다음 점검에서 다시) — [자동] 상태는 입금관리가 이미 보류하므로 돈은 안 나간다.
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const AUTO_BY = '자동(리뷰오더 업체입금)';

/** 리뷰비가 있는 작업인가 — 공고 금액·기간별 구간·배송유형별 금액·탭 금액 중 하나라도 0 보다 크면. */
function hasReviewFee({ campaignFee, tabFee, scheduleMax, deliveryMix }) {
  const pos = v => v != null && Number.isFinite(Number(v)) && Number(v) > 0;
  if (pos(campaignFee) || pos(tabFee) || pos(scheduleMax)) return true;
  try {
    const { normalizeDeliveryReviewFeeMix } = require('../utils/deliveryReviewFee');
    const st = normalizeDeliveryReviewFeeMix(deliveryMix);
    if (!st.error && (st.mix || []).some(r => pos(r.reviewFee))) return true;
  } catch (_) {}
  return false;
}

/** 물건비·리뷰비로 고를 값 — null = 자동 대상 아님 */
function autoPayoutChoice({ goodsCostType, feePositive }) {
  if (!require('./payment.service').goodsCostSaysAdvertiser(goodsCostType)) return null;
  return feePositive ? 'split_kbank' : 'advertiser';
}

/* 대상 후보 — 리뷰오더 물건비가 업체입금이고, 그 작업의 실제 기준 공고(가장 최근) 이체은행과 탭 이체은행이 둘 다 비어 있는 탭.
   ★ 공고 고르기 = 입금관리 _loadCampaigns 와 같은 순서(연결 탭의 가장 최근 공고) · 리뷰오더 = 같은 lateral(가장 최근 작업오더). */
const CANDIDATE_SQL = `
  SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
         c.id AS "campaignId", c.review_fee AS "campaignFee", c.delivery_review_fee_mix AS "deliveryMix",
         (SELECT MAX(s.review_fee) FROM campaign_fee_schedules s WHERE s.campaign_id = c.id) AS "scheduleMax",
         tc.review_fee AS "tabFee", wo.goods_cost_type AS "goodsCostType"
    FROM tab_configs tc
    JOIN LATERAL (
         SELECT w.goods_cost_type FROM work_orders w
          WHERE w.deleted_at IS NULL AND w.linked_tab_sheet_id = tc.sheet_id AND w.linked_tab_name = tc.tab_name
          ORDER BY w.created_at DESC LIMIT 1) wo ON TRUE
    LEFT JOIN LATERAL (
         SELECT rc.id, rc.review_fee, rc.delivery_review_fee_mix, rc.transfer_bank FROM recruit_campaigns rc
          WHERE rc.linked_sheet_id = tc.sheet_id AND rc.linked_tab_name = tc.tab_name
          ORDER BY rc.created_at DESC LIMIT 1) c ON TRUE
   WHERE wo.goods_cost_type ~ '업체\\s*입금'
     AND btrim(COALESCE(c.transfer_bank, '')) = ''
     AND btrim(COALESCE(tc.transfer_bank, '')) = ''
     AND ($1::text IS NULL OR tc.sheet_id = $1)
     AND ($2::text IS NULL OR tc.tab_name = $2)
   ORDER BY tc.sheet_id, tc.tab_name
   LIMIT 200`;

/**
 * 후보를 찾아 저장한다. sheetId/tabName 을 주면 그 범위만(소유 지정·공고 저장 직후 훅).
 * @returns {Promise<{applied:Array, skipped:Array}>}
 */
async function applyAutoPayout({ sheetId = null, tabName = null, db = pool } = {}) {
  const out = { applied: [], skipped: [] };
  const { rows } = await db.query(CANDIDATE_SQL, [sheetId || null, tabName || null]);
  if (!rows.length) return out;
  const pay = require('./payment.service');
  const adv = require('./advertiserPayout.service');
  for (const r of rows) {
    const key = { sheetId: r.sheetId, tabName: r.tabName };
    try {
      const choice = autoPayoutChoice({ goodsCostType: r.goodsCostType,
        feePositive: hasReviewFee({ campaignFee: r.campaignFee, tabFee: r.tabFee, scheduleMax: r.scheduleMax, deliveryMix: r.deliveryMix }) });
      if (!choice) { out.skipped.push({ ...key, reason: 'not_advertiser_goods' }); continue; }
      const g = await adv.checkAdvertiserPayoutAllowed(key);
      if (!g.ok) { out.skipped.push({ ...key, reason: g.error }); continue; }   // 업체 연결 전 등 — 연결되면 다시
      const { rows: [paid] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM payment_batch_items WHERE sheet_id = $1 AND tab_name = $2 AND status IN ('pending','paid')`,
        [r.sheetId, r.tabName]);
      if (paid && paid.n > 0) { out.skipped.push({ ...key, reason: 'our_payout_exists' }); continue; }
      const saved = await pay.saveTransferSetting({ ...key, campaignId: r.campaignId || null, bank: choice });
      if (saved && saved.transferBankKept) { out.skipped.push({ ...key, reason: 'kept' }); continue; }
      out.applied.push({ ...key, choice, target: saved && saved.target, advertiserName: g.advertiserName || '' });
      logger.info(`[auto-payout] ${AUTO_BY} ${r.tabName} → ${choice} (${saved && saved.target} · 업체 ${g.advertiserName || '?'})`);
    } catch (e) {
      out.skipped.push({ ...key, reason: 'error', message: e && e.message });
      logger.warn(`[auto-payout] ${r.tabName} 자동 설정 실패(다음 점검에서 다시): ${e && e.message}`);
    }
  }
  return out;
}

/** 저장·소유 지정 직후 훅 — 응답을 늦추지 않게 뒤에서 돌리고, 실패는 로그만(매시 점검이 다시 본다). */
function kickAutoPayout(scope = {}) {
  if (process.env.NODE_ENV === 'test' && !kickAutoPayout.enabledForTest) return;   // 단위시험의 가짜 pool 에 뒤늦은 조회가 섞이지 않게
  setImmediate(() => { applyAutoPayout(scope).catch(e => logger.warn(`[auto-payout] 훅 실패: ${e && e.message}`)); });
}

module.exports = { AUTO_BY, CANDIDATE_SQL, hasReviewFee, autoPayoutChoice, applyAutoPayout, kickAutoPayout };
