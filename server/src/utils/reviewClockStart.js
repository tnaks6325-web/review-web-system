'use strict';
/**
 * reviewClockStart.js — **「리뷰 날수를 언제부터 세나」 단일 출처** (결정 423 · 사용자 확정 2026-11-25 「1번」).
 *
 * 같은 시작일을 보는 곳(사본 0):
 *   · 리뷰 미작성 알림톡 1·2·3차 = 시작일 + 7·13·14일(결정 194 · reviewReminder.service 후보 SQL + 발송 창)
 *   · 블랙리뷰어 「기한경과」(14일↑) · 「리뷰미작성」(30일↑) 집계(결정 050 · reviewerGate._reviewHistory)
 *   · 등록리뷰어DB 필터 「🚨 후보」·「기한경과만」(trackB.routes GET /reviewers)
 *   ★ 결정 426 — 알림톡을 「언제·몇 번·어떤 기한으로」 보내는지(종류별 알림 방식)는 형제 모듈 `utils/reviewReminderPlan`.
 *     네이버예약리뷰 알림톡은 7·13·14일이 아니라 리뷰 마감일 당일 한 번이다(이 모듈의 이용일은 「방문 전엔 안 보냄」 판정에만 쓴다).
 *
 * 종류별 시작일:
 *   · 기본(리뷰·블로그·Q&A·영수증) = 구매양식/제출 시각(order_submissions.submitted_at) — **종전 그대로**.
 *   · 네이버예약리뷰(booking) = **이용일**(자리표 booking_slots.slot_date)의 KST 0시.
 *       예약내역(= 그 줄의 주문 기록)은 예약 직후 내지만 방문은 며칠~몇 주 뒤다. 제출 시각부터 세면 방문도 하기 전에
 *       「리뷰를 아직 안 쓰셨다」 알림톡이 가고 블랙리스트 후보로 잡힌다. 날수(7·13·14 / 14·30)는 그대로 두고 시작일만 바꾼다.
 *   · 영수증리뷰(receipt · 결정 418): 리뷰 기한 = 참여일 + N, 참여일 = 제출 시작이라 기본과 같다 — 다른 시작일이 필요해지면
 *       `CLOCK_START_BY_KIND` 에 한 줄 + `KIND_ROW_SQL`(그 종류 줄 판정) + 필요하면 `BASIS_START_SQL`(시작 시각 식)을 더한다.
 *
 * ★★ fail-safe(완화 금지): 예약 줄의 이용일을 모르면(자리표에 그 줄이 없음 · 취소된 자리) 시작일 = **없음(NULL)** —
 *   알림톡을 보내지 않고 기한경과·미작성으로 세지 않는다(로그). **제출 시각으로 되돌아가지 않는다.**
 *   이용일이 아직 안 온 예약 줄도 보내지·세지 않는다(시작일이 미래).
 * ★ 예약 줄 판정 = `utils/bookingTabSql`(bookingSlots.isBookingTab 과 한 벌 — 자리표가 있거나 탭 종류 booking).
 */
const { normalizeWorkKind } = require('./workKind');
const { bookingTabSql } = require('./bookingTabSql');

/** 기본 시작일 = 제출 시각. */
const DEFAULT_BASIS = 'submission';

/** 종류 → 시작일 기준. 여기 없는 종류 = 기본(제출 시각). */
const CLOCK_START_BY_KIND = Object.freeze({
  booking: 'visit_date',   // 결정 423 — 네이버예약리뷰 = 이용일
});

/** 종류 key → 그 종류 줄인지 판정하는 SQL(별칭 a = review_index 별칭).
 *  ★ receipt 는 알림 방식(utils/reviewReminderPlan — 마감 전날 한 번 · 결정 434 2026-11-28 ②)만 쓴다 —
 *    시작일(CLOCK_START_BY_KIND)에는 넣지 않았다(영수증 시작일 = 제출 시각 = 참여일 그대로 · 블랙리스트·등록리뷰어 필터 불변). */
const KIND_ROW_SQL = Object.freeze({
  booking: (a) => bookingTabSql(`${a}.sheet_id`, `${a}.tab_name`),
  receipt: (a) => require('./receiptTabSql').receiptTabSql(`${a}.sheet_id`, `${a}.tab_name`),
});

/** 기준 → 시작 시각(timestamptz) SQL. 모르면 NULL 이어야 한다(fail-safe). */
const BASIS_START_SQL = Object.freeze({
  // 그 줄(review_index.row_index = 자리표 seq)의 이용일 KST 0시 · 취소된 자리 = 모름(NULL).
  visit_date: (a) => `(SELECT bks.slot_date::timestamp AT TIME ZONE 'Asia/Seoul' FROM booking_slots bks
                        WHERE bks.sheet_id = ${a}.sheet_id AND bks.tab_name = ${a}.tab_name AND bks.seq = ${a}.row_index
                          AND bks.status <> 'cancelled' LIMIT 1)`,
});

// 표가 어긋나면 기동 때 바로 드러나게(종류를 추가하고 판정·시작 식을 빠뜨리는 실수).
for (const [kind, basis] of Object.entries(CLOCK_START_BY_KIND)) {
  if (typeof KIND_ROW_SQL[kind] !== 'function') throw new Error(`reviewClockStart: ${kind} 줄 판정 SQL 이 없습니다`);
  if (typeof BASIS_START_SQL[basis] !== 'function') throw new Error(`reviewClockStart: ${basis} 시작 시각 SQL 이 없습니다`);
}

/** 종류(자유 문자열 포함) → 'submission' | 'visit_date'. 모르는 값 = 기본(workKind 규칙 그대로 — 모르면 리뷰). */
function clockStartBasis(workKind) {
  return CLOCK_START_BY_KIND[normalizeWorkKind(workKind)] || DEFAULT_BASIS;
}

/**
 * LATERAL 하위 질의 — 한 줄의 시작일 기준(basis)과 시작 시각(start_at).
 *   사용: `JOIN LATERAL (${clockStartLateralSql({ alias: 'ri', submittedAt: 'ord.submitted_at' })}) clk ON TRUE`
 *   ★ 기본 기준 줄은 start_at = submittedAt 식 **그 값 그대로**(종전 비교·정렬과 같은 결과).
 *   ★ 항상 한 줄을 돌려준다(LEFT/INNER 어느 쪽으로 붙여도 줄 수가 바뀌지 않는다).
 * @param {{alias?:string, submittedAt:string}} o
 */
function clockStartLateralSql({ alias = 'ri', submittedAt } = {}) {
  if (!submittedAt) throw new Error('reviewClockStart: submittedAt 식이 필요합니다');
  const whens = Object.entries(CLOCK_START_BY_KIND)
    .map(([kind, basis]) => `WHEN ${KIND_ROW_SQL[kind](alias)} THEN '${basis}'`).join(' ');
  const starts = [...new Set(Object.values(CLOCK_START_BY_KIND))]
    .map(basis => `WHEN '${basis}' THEN ${BASIS_START_SQL[basis](alias)}`).join(' ');
  return `SELECT k.basis, CASE k.basis WHEN '${DEFAULT_BASIS}' THEN ${submittedAt} ${starts} END AS start_at
            FROM (SELECT CASE ${whens} ELSE '${DEFAULT_BASIS}' END AS basis) k`;
}

/**
 * 후보 줄(reviewReminder 후보 SQL 결과) → { basis, at(Date|null) }.
 *   · 시작일 칸이 없는 옛 모양 줄(clockBasis 없음 — 시험·옛 사본) = 기본(제출 시각 orderedAt) — 종전 그대로.
 *   · 기본 기준 줄 = clockStartAt(= 제출 시각).
 *   · 그 밖 기준(이용일) = clockStartAt 만 — 비었으면 at = null(모름). ★ orderedAt 으로 되돌아가지 않는다.
 */
function clockStartOfRow(row) {
  const r = row || {};
  const toDate = v => (v == null || v === '' || Number.isNaN(new Date(v).getTime()) ? null : new Date(v));
  if (r.clockBasis == null) return { basis: DEFAULT_BASIS, at: toDate(r.orderedAt) };
  return { basis: String(r.clockBasis), at: toDate(r.clockStartAt) };
}

module.exports = {
  DEFAULT_BASIS, CLOCK_START_BY_KIND,
  KIND_ROW_SQL,   // 결정 426 — 알림 방식(utils/reviewReminderPlan)도 같은 종류 판정 SQL 을 쓴다(사본 0)
  clockStartBasis, clockStartLateralSql, clockStartOfRow,
  bookingTabSql,
};
