/**
 * campaignQuotaBalance.service.js — 공고 총원 ↔ 상품별 남은 자리 합 어긋남 조회 (결정 227 · 2026-10-12)
 *
 * 왜 필요한가(위드프렌즈 가습기·온풍기 50건): 수정 배포 전 1번 상품이 6/5명으로 팔렸고, 그 1명이 공고 총원 50 을 먼저
 * 차지해 마지막 날 HD2200 이 10명이 아니라 9명에서 닫혔다. 담당자는 이유를 모른 채 총원을 손으로 늘렸다.
 * → 작업보드를 열 때마다 이 값을 물어 어긋났으면 팝업으로 알린다(사용자 확정 — 화면에 상시 줄을 차지하지 않는다).
 *
 * ★ 판정은 `campaignState.optionTotalBalance` 하나(재료 = `totalQuotaUsage` · `computeOptionViews` — 공고 밖 주문 포함 · 210).
 * ★ 게시 중(status='active')인 참여형 공고만 — 끝났거나 멈춘 공고를 열 때마다 묻지 않는다. 보관 공고 제외.
 * ★ 모르면 말하지 않는다(null) — 판정 함수 규칙 그대로. 조회 실패는 호출부가 fail-soft(팝업 미표시).
 */
'use strict';

const {
  fetchCampaignCounts, fetchOptionCounts, fetchSequentialCampaignIds, sequentialFor,
  computeOptionViews, totalQuotaUsage, optionTotalBalance,
} = require('./campaignState.service');
const { deriveSchedules, tabsOfCampaigns, scheduleFor } = require('./campaignSchedule.service');

/**
 * @returns {Promise<null|{campaignId:string, title:string, cap:number, used:number, totalRemaining:number,
 *   optionRemaining:number, gap:number, over:Array}>}
 */
async function loadQuotaBalance(db, campaignId, now = new Date()) {
  const id = String(campaignId || '');
  if (!db || !id) return null;
  const { rows: camps } = await db.query('SELECT * FROM recruit_campaigns WHERE id = $1', [id]);
  const c = camps[0];
  if (!c || !c.participation_mode || c.archived_at || c.status !== 'active') return null;
  // 정렬은 목록 뷰 단일 출처와 같게(closed 맨 뒤 · sort_order · id — 결정 212 순차 판정이 이 순서를 본다)
  const { rows: optRows } = await db.query(
    `SELECT opt_key, option_url, pay_amount, recruit_total, daily_limit, status,
            product_name, unit_kind, thumbnail_url
       FROM campaign_options WHERE campaign_id = $1 ORDER BY (status='closed'), sort_order, id`, [id]);
  if (!optRows.length) return null;
  const sm = await deriveSchedules(db, tabsOfCampaigns([c]), now);
  const sch = scheduleFor(sm, c);
  const cnt = (await fetchCampaignCounts(db, [id], now)).get(id) || {};
  const counts = await fetchOptionCounts(db, id, now);
  const sequential = sequentialFor(await fetchSequentialCampaignIds(db, [id]), id);   // ★ 결정 228
  const views = computeOptionViews(optRows, counts, null, { sequential });
  const bal = optionTotalBalance(totalQuotaUsage(c, cnt, sch), views);
  return bal ? { campaignId: id, title: String(c.title || ''), ...bal } : null;
}

module.exports = { loadQuotaBalance };
