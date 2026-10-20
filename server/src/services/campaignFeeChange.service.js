// ═══════════════════════════════════════════════════════════════════════════
// 연결 공고의 리뷰비 변경 — "바꾸는 순간 지난 참여는 옛 금액으로 고정" (결정 263 · 양방향 5단계 · 사용자 확정 D2·2026-10-20)
//
// 사고 재료(운영 읽기 조회 2026-10-20): 진행 중 공고 참여 2,570건 전부에 참여 당시 리뷰비(스냅숏)가 없다 — 리뷰비 구간표가
// 없는 공고는 참여할 때 스냅숏을 남기지 않기 때문이다(campaign.routes apply). 그 상태에서 공고 리뷰비 한 칸을 바꾸면
// 이미 참여한 사람의 입금액·리뷰 내역 금액까지 같이 바뀐다(결정 082 가 막으려던 바로 그 사고).
//
// 그래서 양방향 저장이 리뷰비를 바꿀 때는 같은 트랜잭션에서:
//   ① 스냅숏이 비어 있는 참여·주문을 "지금 적용 중인 금액(옛 금액)" 으로 고정한다
//      (구간표가 이미 있던 공고는 날짜로 금액이 갈리므로 **오늘 이후** 건만 — 그 전 건은 구간표가 날짜로 지킨다)
//   ② 구간표에 "옛 금액(바닥 구간 2000-01-01)" + "오늘부터 새 금액" 을 넣는다 — 스냅숏이 닿지 않는 작업표 줄(주문 없는 줄)도
//      날짜로 옛 금액을 받는다
//   ③ 공고 리뷰비 칸을 새 금액으로 바꾼다
// ★★ 판정은 기존 단일 출처(`utils/campaignFee` · `utils/deliveryReviewFee`)를 태운다 — 규칙을 새로 만들지 않는다.
// ★★ 거부(fail-closed · 호출부가 오더 쓰기까지 통째로 되돌린다):
//   · 구간표 스위치가 꺼져 있음(CAMPAIGN_FEE_SCHEDULE=0) — 구간표를 무시하는 서버에서는 ② 가 효과가 없다
//   · 배송유형별 리뷰비를 쓰는 공고 — 금액이 유형마다 달라 한 칸으로 옮길 수 없다(운영 연결 대상 0건 · 2026-10-20 조회)
//   · 앞으로 바뀔 금액을 예약해 둔 공고(오늘 뒤 구간) — 어느 금액이 이기는지 사람이 정해야 한다(운영 0건)
// ★ 반드시 호출부 트랜잭션 안에서 — 공고 행은 호출부가 이미 잠갔다(apply·옵션 저장과 같은 잠금 계층).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { scheduleEnabled, kstDateStr, resolveReviewFee } = require('../utils/campaignFee');
const { normalizeDeliveryReviewFeeMix } = require('../utils/deliveryReviewFee');

const FLOOR_DATE = '2000-01-01';
const FLOOR_MEMO = '변경 전 금액(자동)';
const CHANGE_MEMO = '리뷰오더와 맞춘 변경(자동)';

const REJECT_TEXT = {
  fee_invalid: '리뷰비는 0 이상의 숫자여야 합니다.',
  fee_schedule_disabled: '리뷰비 기간 기능이 꺼져 있어, 리뷰비를 바꾸면 이미 참여한 분 금액까지 바뀝니다. 그래서 저장하지 않았습니다. 관리자에게 문의해 주세요.',
  fee_delivery_mix: '이 공고는 배송유형별로 리뷰비를 따로 정해 두어 리뷰비 한 칸으로 바꿀 수 없습니다. 모집공고 편집 창에서 배송유형별 금액을 고쳐 주세요.',
  fee_future_segment: '이 공고에는 앞으로 바뀔 리뷰비가 예약돼 있어 지금 바꾸면 어느 금액이 맞는지 정할 수 없습니다. 모집공고의 기간별 리뷰비를 먼저 정리해 주세요.',
};

function _int(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** 공고 리뷰비를 바꿀 수 있는가(쓰기 없음) — 거부 사유 또는 null. 공고 창이 저장 전에 같은 판정을 쓴다. */
function feeChangeBlockReason(camp) {
  if (!scheduleEnabled()) return 'fee_schedule_disabled';
  const mix = normalizeDeliveryReviewFeeMix(camp && camp.delivery_review_fee_mix);
  if (!mix.error && Array.isArray(mix.mix) && mix.mix.length) return 'fee_delivery_mix';
  return null;
}

/**
 * @param {object} client 트랜잭션 중인 연결(공고 행 잠금 보유)
 * @param {object} camp   공고 행(SELECT *)
 * @param {number} nextFeeRaw
 * @returns {Promise<{reject:{reason:string,error:string}} | {applied:boolean, reason?:string, oldFee?:number, newFee?:number, frozenApplications?:number, frozenOrders?:number}>}
 */
async function applyFeeChangeInTx(client, camp, nextFeeRaw, { now = new Date() } = {}) {
  const next = _int(nextFeeRaw);
  const reject = (reason) => ({ reject: { reason, error: REJECT_TEXT[reason] || '리뷰비를 바꿀 수 없어 저장하지 않았습니다.' } });
  if (next == null) return reject('fee_invalid');
  const blocked = feeChangeBlockReason(camp);
  if (blocked) return reject(blocked);
  const today = kstDateStr(now);
  const { rows: sched } = await client.query(
    `SELECT to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom", review_fee AS "reviewFee"
       FROM campaign_fee_schedules WHERE campaign_id = $1 ORDER BY effective_from`, [camp.id]);
  if (sched.some(s => s.effectiveFrom > today)) return reject('fee_future_segment');

  const fallback = _int(camp.review_fee) || 0;
  const oldFee = resolveReviewFee({ schedules: sched, fallback, today }).fee;
  if (oldFee === next && fallback === next) return { applied: false, reason: 'already_same', oldFee, newFee: next };

  // ① 스냅숏 고정 — 구간표가 있던 공고는 오늘 이후 건만(그 전 건은 구간표가 날짜로 지킨다)
  const datedOnly = sched.length > 0;
  const apps = await client.query(
    `UPDATE campaign_applications SET review_fee_snapshot = $2
      WHERE campaign_id = $1 AND review_fee_snapshot IS NULL
        AND (NOT $3::boolean OR (applied_at AT TIME ZONE 'Asia/Seoul')::date >= $4::date)`,
    [camp.id, oldFee, datedOnly, today]);
  const sid = String(camp.linked_sheet_id || ''), tab = String(camp.linked_tab_name || '');
  const ords = await client.query(
    `UPDATE order_submissions os SET review_fee_snapshot = $2
      WHERE os.deleted_at IS NULL AND os.review_fee_snapshot IS NULL
        -- 신청에 묶인 주문은 그 신청이 이 공고 것일 때만(같은 작업표를 쓰는 다른 공고의 주문을 이 공고 금액으로 고정하지 않게 · 검토 2026-10-20),
        -- 신청 없는 주문은 이 공고의 작업표 탭 기준(입금 계산이 탭으로 공고를 찾는 것과 같다)
        AND ((os.campaign_application_id IS NULL AND os.sheet_id = $5 AND os.tab_name = $6 AND $5 <> '' AND $6 <> '')
             OR os.campaign_application_id IN (SELECT id FROM campaign_applications WHERE campaign_id = $1))
        AND (NOT $3::boolean OR (os.submitted_at AT TIME ZONE 'Asia/Seoul')::date >= $4::date)`,
    [camp.id, oldFee, datedOnly, today, sid, tab]);

  // ② 구간 — 바닥(옛 금액 · 구간표가 없던 공고의 폴백 그대로) + 오늘부터 새 금액
  if (!sched.some(s => s.effectiveFrom <= FLOOR_DATE)) {
    await client.query(
      `INSERT INTO campaign_fee_schedules (campaign_id, effective_from, review_fee, memo, updated_at)
       VALUES ($1, $2::date, $3, $4, NOW()) ON CONFLICT (campaign_id, effective_from) DO NOTHING`,
      [camp.id, FLOOR_DATE, fallback, FLOOR_MEMO]);
  }
  await client.query(
    `INSERT INTO campaign_fee_schedules (campaign_id, effective_from, review_fee, memo, updated_at)
     VALUES ($1, $2::date, $3, $4, NOW())
     ON CONFLICT (campaign_id, effective_from) DO UPDATE SET review_fee = EXCLUDED.review_fee, memo = EXCLUDED.memo, updated_at = NOW()`,
    [camp.id, today, next, CHANGE_MEMO]);

  // ③ 공고 칸
  await client.query('UPDATE recruit_campaigns SET review_fee = $2, updated_at = NOW() WHERE id = $1', [camp.id, next]);
  return { applied: true, oldFee, newFee: next, frozenApplications: apps.rowCount || 0, frozenOrders: ords.rowCount || 0 };
}

module.exports = { applyFeeChangeInTx, feeChangeBlockReason, REJECT_TEXT, FLOOR_DATE, FLOOR_MEMO, CHANGE_MEMO };
