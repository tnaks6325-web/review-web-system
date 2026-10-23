// ═══════════════════════════════════════════════════════════════════════════
// 공고 옵션 결제금액 이력 (결정 275 · 양방향 5단계 · 사용자 확정 D3·2026-10-20 「모든 공고에 적용」)
//
// 결제금액을 바꾸면 그 순간부터 리뷰어 화면 금액이 바뀐다. 그런데 잘못구매 판정(결정 230·236)은 "결제금액이 다른 상품
// 하나의 가격과 정확히 같은가" 를 공고의 **지금** 금액으로 본다 — 금액을 중간에 바꾸면, 바꾸기 전에 신청해 옛 금액으로
// 정상 구매한 리뷰어가 "잘못 구매" 로 걸린다. 그래서 금액이 바뀔 때마다 이력을 남기고 판정은 **신청한 시각의 금액**으로 한다.
//
// ★★ 첫 변경 때는 "변경 전 금액" 을 아주 옛 시각(1970-01-01)으로 먼저 적는다 — 그래야 이력이 생기기 전에 신청한 건도
//    옛 금액을 찾는다. 이력이 없는 옵션 = 한 번도 안 바뀜 = 지금 금액(종전 동작 그대로).
// ★★ 이력 쓰기 실패는 저장을 막지 않는다(SAVEPOINT 격리 · 표가 아직 없는 배포 창 포함) — 판정이 지금 금액으로 접힐 뿐이다.
// ★ 반드시 호출부의 트랜잭션 안에서 부른다(옵션 행 잠금과 같은 트랜잭션 — 금액과 이력이 갈리지 않게).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { logger } = require('../utils/logger');

const FLOOR_AT = '1970-01-01T00:00:00Z';

/**
 * @param {object} client 트랜잭션 중인 연결
 * @param {{ campaignId:string, optionId:number, oldPay:number, newPay:number, actor?:string }} p
 * @returns {Promise<boolean>} 적었는가
 */
async function recordOptionPriceChangeInTx(client, { campaignId, optionId, oldPay, newPay, actor = '' }) {
  const id = Number(optionId);
  const before = Math.max(0, Math.floor(Number(oldPay) || 0));
  const after = Math.max(0, Math.floor(Number(newPay) || 0));
  if (!Number.isSafeInteger(id) || id <= 0 || before === after) return false;
  try {
    await client.query('SAVEPOINT opt_price_hist');
    const { rows } = await client.query('SELECT 1 FROM campaign_option_price_history WHERE option_id = $1 LIMIT 1', [id]);
    if (!rows.length) {
      await client.query(
        `INSERT INTO campaign_option_price_history (campaign_id, option_id, pay_amount, effective_at, actor)
         VALUES ($1, $2, $3, $4::timestamptz, '변경 전 금액(자동)')`, [String(campaignId), id, before, FLOOR_AT]);
    }
    await client.query(
      `INSERT INTO campaign_option_price_history (campaign_id, option_id, pay_amount, effective_at, actor)
       VALUES ($1, $2, $3, clock_timestamp(), $4)`, [String(campaignId), id, after, String(actor || '').slice(0, 120)]);
    await client.query('RELEASE SAVEPOINT opt_price_hist');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK TO SAVEPOINT opt_price_hist'); } catch (_) { /* noop */ }
    logger.warn(`[campaign/price-history] ${campaignId}/${id} 금액 이력 기록 실패(저장은 계속): ${(e && e.message) || e}`);
    return false;
  }
}

/**
 * 그 시각에 적용되던 옵션별 금액. 이력이 없는 옵션은 들어 있지 않다(= 지금 금액을 쓴다).
 * 조회 실패는 빈 Map(종전 동작 — 지금 금액).
 * @returns {Promise<Map<number, number>>}
 */
async function optionPricesAt(db, campaignId, at) {
  const t = at instanceof Date ? at : new Date(at);
  if (!at || Number.isNaN(t.getTime())) return new Map();
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (option_id) option_id, pay_amount
         FROM campaign_option_price_history
        WHERE campaign_id = $1 AND effective_at <= $2
        ORDER BY option_id, effective_at DESC, id DESC`, [String(campaignId), t.toISOString()]);
    return new Map(rows.map(r => [Number(r.option_id), Number(r.pay_amount)]));
  } catch (e) {
    logger.warn(`[campaign/price-history] ${campaignId} 금액 이력 조회 실패(지금 금액으로 판정): ${(e && e.message) || e}`);
    return new Map();
  }
}

module.exports = { recordOptionPriceChangeInTx, optionPricesAt, FLOOR_AT };
