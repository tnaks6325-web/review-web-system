'use strict';
/**
 * reviewReminderPlan.js — **「리뷰 미작성 알림톡을 언제·몇 번·어떤 기한으로 보내나」 종류별 단일 출처** (결정 426 · 사용자 확정 2026-11-25 ③).
 *
 * 형제 모듈 `utils/reviewClockStart`(날수 시작일 · 결정 423)와 같은 종류 판정 SQL(`KIND_ROW_SQL`)을 쓴다 — 예약 줄 판정 사본 0.
 *
 * 종류별 알림 방식:
 *   · 기본(리뷰·블로그·Q&A·영수증) = `schedule_days` — 시작일 + 7·13·14일 1·2·3차(결정 194 · `REVIEW_REMINDER_SCHEDULE_DAYS`) — **종전 그대로**.
 *   · 네이버예약리뷰(booking) = `deadline_day_once` — **리뷰 마감일 당일(KST) 한 번** · 1차 템플릿(리뷰미작성_1차)만 · 2차·3차 없음.
 *       마감일 = 그 줄 자리표 `booking_slots.review_deadline`(= 이용일 + 오더 리뷰 기한 N일 · 기본 3 · 결정 407·422) —
 *       리뷰어 화면 「오늘 마감」(`bookingSlots.reviewDeadlineStateAt`)과 담당자 작업보드 「마감 지남」이 읽는 **같은 칸**.
 *       알림톡 #{제출기한} = 그 마감일(화면 날짜와 같다).
 *       - 자동(크론): 마감일 0시~23:59:59(KST) 하루만. 그날 못 보냈으면(크론 꺼짐·하루 상한) **늦게 보내지 않는다**.
 *       - 담당자 수동: 마감일 당일 ~ 마감일 + `manualLateDays`(7)일 끝. 마감일 전에는 앞당겨 보내지 않는다.
 *   · 영수증리뷰(receipt · 418·420): 지금은 기본. 다른 방식이 필요해지면 `REMINDER_PLAN_BY_KIND` 한 줄 + 필요하면
 *       `PLAN_DEADLINE_SQL`(그 방식의 마감일 식) + `PLAN_RULES` 를 더한다(빠뜨리면 기동 때 바로 오류).
 *
 * ★★ fail-safe(완화 금지): 예약 줄의 마감일을 모르면(자리표에 마감일 칸이 비었거나 줄이 없거나 취소된 자리) =
 *   **보내지 않는다**(사유 deadline_unknown · 로그). 제출 시각·이용일 + 7·13·14일로 되돌아가지 않는다.
 */
const { normalizeWorkKind } = require('./workKind');
const { KIND_ROW_SQL } = require('./reviewClockStart');

/** 기본 방식 = 시작일 + scheduleDays 1·2·3차(결정 194). */
const DEFAULT_PLAN = 'schedule_days';

/** 종류 → 알림 방식. 여기 없는 종류 = 기본. */
const REMINDER_PLAN_BY_KIND = Object.freeze({
  booking: 'deadline_day_once',   // 결정 426 — 네이버예약리뷰 = 리뷰 마감일 당일 한 번
});

/** 방식 → 그 줄 마감일(YYYY-MM-DD 글자) SQL(별칭 a = review_index 별칭). 모르면 NULL 이어야 한다(fail-safe). */
const PLAN_DEADLINE_SQL = Object.freeze({
  // 자리표의 리뷰마감일 칸(화면 「오늘 마감」과 같은 칸) · 취소된 자리 = 모름(NULL) — 이용일 식(reviewClockStart)과 같은 자리 판정.
  deadline_day_once: (a) => `(SELECT to_char(bkd.review_deadline, 'YYYY-MM-DD') FROM booking_slots bkd
                        WHERE bkd.sheet_id = ${a}.sheet_id AND bkd.tab_name = ${a}.tab_name AND bkd.seq = ${a}.row_index
                          AND bkd.status <> 'cancelled' LIMIT 1)`,
});

/** 방식별 규칙. */
const PLAN_RULES = Object.freeze({
  deadline_day_once: Object.freeze({
    reminderNo: 1,          // 템플릿 = TEMPLATE_NAMES[1] '리뷰미작성_1차'(#{제출기한} = 마감일) — 3차(「미작성 종결·입금 안 됨」)는 결정 422 와 어긋나 쓰지 않는다
    maxSends: 1,            // 한 번 보낸(도착 확인된) 줄은 다시 보내지 않는다
    manualLateDays: 7,      // 담당자 수동 = 마감일 + 7일 끝까지(그 뒤는 문자)
  }),
});

for (const [kind, planName] of Object.entries(REMINDER_PLAN_BY_KIND)) {
  if (typeof KIND_ROW_SQL[kind] !== 'function') throw new Error(`reviewReminderPlan: ${kind} 줄 판정 SQL 이 없습니다`);
  if (typeof PLAN_DEADLINE_SQL[planName] !== 'function') throw new Error(`reviewReminderPlan: ${planName} 마감일 SQL 이 없습니다`);
  if (!PLAN_RULES[planName]) throw new Error(`reviewReminderPlan: ${planName} 규칙이 없습니다`);
}

/** 종류(자유 문자열 포함) → 알림 방식. 모르는 값 = 기본(workKind 규칙 그대로). */
function reminderPlanOfKind(workKind) {
  return REMINDER_PLAN_BY_KIND[normalizeWorkKind(workKind)] || DEFAULT_PLAN;
}

/**
 * LATERAL 하위 질의 — 한 줄의 알림 방식(plan)과 그 방식의 마감일(deadline_ymd · 기본 방식 = 항상 NULL).
 *   사용: `JOIN LATERAL (${reminderPlanLateralSql({ alias: 'ri' })}) pl ON TRUE` — 항상 한 줄(줄 수 불변).
 */
function reminderPlanLateralSql({ alias = 'ri' } = {}) {
  const whens = Object.entries(REMINDER_PLAN_BY_KIND)
    .map(([kind, planName]) => `WHEN ${KIND_ROW_SQL[kind](alias)} THEN '${planName}'`).join(' ');
  const deadlines = [...new Set(Object.values(REMINDER_PLAN_BY_KIND))]
    .map(planName => `WHEN '${planName}' THEN ${PLAN_DEADLINE_SQL[planName](alias)}`).join(' ');
  return `SELECT p.plan, CASE p.plan ${deadlines} END AS deadline_ymd
            FROM (SELECT CASE ${whens} ELSE '${DEFAULT_PLAN}' END AS plan) p`;
}

/**
 * 후보 줄 → { plan, deadlineYmd|null, rules|null }.
 *   · 방식 칸이 없는 옛 모양 줄(시험·옛 사본) = 기본 — 종전 그대로.
 *   · 마감일 글자가 날짜가 아니면 null(모름 · fail-safe).
 */
function reminderPlanOfRow(row) {
  const r = row || {};
  const planName = r.reminderPlan == null ? DEFAULT_PLAN : String(r.reminderPlan);
  const raw = r.planDeadline == null ? '' : String(r.planDeadline).trim();
  const deadlineYmd = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  return { plan: planName, deadlineYmd, rules: PLAN_RULES[planName] || null };
}

module.exports = {
  DEFAULT_PLAN, REMINDER_PLAN_BY_KIND, PLAN_RULES,
  reminderPlanOfKind, reminderPlanLateralSql, reminderPlanOfRow,
};
