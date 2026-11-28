'use strict';
/**
 * reviewReminderPlan.js — **「리뷰 미작성 알림톡을 언제·몇 번·어떤 기한으로 보내나」 종류별 단일 출처** (결정 426 · 사용자 확정 2026-11-25 ③ · 결정 434 사용자 확정 2026-11-28 ②).
 *
 * 형제 모듈 `utils/reviewClockStart`(날수 시작일 · 결정 423)와 같은 종류 판정 SQL(`KIND_ROW_SQL`)을 쓴다 — 예약·영수증 줄 판정 사본 0.
 *
 * 종류별 알림 방식:
 *   · 기본(리뷰·블로그·Q&A) = `schedule_days` — 시작일 + 7·13·14일 1·2·3차(결정 194 · `REVIEW_REMINDER_SCHEDULE_DAYS`) — **종전 그대로**.
 *   · 마감일 기준 「한 번」 방식(아래 두 가지) — 공통 틀: 1차 템플릿(리뷰미작성_1차)만 · 2차·3차 없음 · #{제출기한} = 그 줄의 리뷰 마감일(화면 날짜).
 *       보내는 날 = 마감일 − `sendOffsetDays`(KST 달력 날).
 *       - 자동(크론): 보내는 날 0시~23:59:59(KST) 하루만. 그날 못 보냈으면(크론 꺼짐·하루 상한) **늦게 보내지 않는다**.
 *       - 담당자 수동: 보내는 날 ~ 마감일 + `manualLateDays`(7)일 끝. 보내는 날 전에는 앞당겨 보내지 않는다.
 *     ① 네이버예약리뷰(booking) = `deadline_day_once` — **리뷰 마감일 당일 한 번**(sendOffsetDays 0 · 결정 426).
 *          마감일 = 자리표 `booking_slots.review_deadline`(= 이용일 + 오더 리뷰 기한 N일 · 결정 407·422) —
 *          리뷰어 화면 「오늘 마감」(`bookingSlots.reviewDeadlineStateAt`)과 담당자 작업보드 「마감 지남」이 읽는 **같은 칸**.
 *     ② 영수증리뷰(receipt) = `day_before_deadline_once` — **리뷰 마감일 전날 한 번**(sendOffsetDays 1 · 결정 434 사용자 확정 2026-11-28 ②).
 *          마감일 = 영수증 줄 `receipt_pool.review_deadline`(= 참여일 + 오더의 리뷰 기한 N일 · 배정 때 새김 — 리뷰어 화면
 *          「내일/오늘 마감」·참여 상세 `receiptSeat`·담당자 「마감 지남」이 읽는 **같은 칸**). 참여일 = 같은 줄 `joined_date`.
 *          ★ 보내는 날이 참여한 날과 같거나 앞이면(리뷰 기한 1일) **자동으로 보내지 않는다**(`autoAfterStartDay` — 참여 당일에
 *          「리뷰가 아직 등록되지 않았습니다」를 보내지 않는 보수적 결정) · 담당자 수동은 보낼 수 있다. 참여일을 모르면 = 모름(안 보냄).
 *
 * ★★ fail-safe(완화 금지): 마감일을 모르면(칸이 비었거나 줄이 없거나 취소된 자리) = **보내지 않는다**(사유 deadline_unknown · 로그).
 *   제출 시각·이용일/참여일 + 7·13·14일·「참여일 + N」 다시 계산으로 되돌아가지 않는다.
 * ★★ 후보 SQL(자동)은 `auto_send_ymd`(자동으로 보내는 날 · 자동으로 안 보내는 줄 = NULL)가 **오늘인 줄만** 읽는다(PR #1891 리뷰 규칙 —
 *   어차피 거절될 지난 줄·참여 당일 줄을 후보 LIMIT 안에 넣지 않는다).
 */
const { normalizeWorkKind } = require('./workKind');
const { KIND_ROW_SQL } = require('./reviewClockStart');

/** 기본 방식 = 시작일 + scheduleDays 1·2·3차(결정 194). */
const DEFAULT_PLAN = 'schedule_days';

/** 종류 → 알림 방식. 여기 없는 종류 = 기본. */
const REMINDER_PLAN_BY_KIND = Object.freeze({
  booking: 'deadline_day_once',          // 결정 426 — 네이버예약리뷰 = 리뷰 마감일 당일 한 번
  receipt: 'day_before_deadline_once',   // 결정 434(2026-11-28 ②) — 영수증리뷰 = 리뷰 마감일 전날 한 번
});

/** 방식 → 그 줄 마감일(YYYY-MM-DD 글자) SQL(별칭 a = review_index 별칭). 모르면 NULL 이어야 한다(fail-safe). */
const PLAN_DEADLINE_SQL = Object.freeze({
  // 자리표의 리뷰마감일 칸(화면 「오늘 마감」과 같은 칸) · 취소된 자리 = 모름(NULL) — 이용일 식(reviewClockStart)과 같은 자리 판정.
  deadline_day_once: (a) => `(SELECT to_char(bkd.review_deadline, 'YYYY-MM-DD') FROM booking_slots bkd
                        WHERE bkd.sheet_id = ${a}.sheet_id AND bkd.tab_name = ${a}.tab_name AND bkd.seq = ${a}.row_index
                          AND bkd.status <> 'cancelled' LIMIT 1)`,
  // 영수증 줄의 리뷰마감일 칸(참여 상세 receiptSeat · 검색 결과 reviewDeadlinesForRows 와 같은 칸) · 취소된 자리 = 모름.
  //   ★ 줄 번호 = 지금 그 영수증이 묶인 줄(줄 삭제·리뷰어 취소면 보충 줄로 옮겨 가므로 옛 줄은 모름 = 안 보냄).
  day_before_deadline_once: (a) => `(SELECT to_char(rcd.review_deadline, 'YYYY-MM-DD') FROM receipt_pool rcd
                        WHERE rcd.sheet_id = ${a}.sheet_id AND rcd.tab_name = ${a}.tab_name AND rcd.seq = ${a}.row_index
                          AND rcd.status <> 'cancelled' LIMIT 1)`,
});

/** 방식 → 그 줄 시작일(참여일 · YYYY-MM-DD) SQL — `autoAfterStartDay` 방식만. 모르면 NULL. */
const PLAN_START_SQL = Object.freeze({
  day_before_deadline_once: (a) => `(SELECT to_char(rcs.joined_date, 'YYYY-MM-DD') FROM receipt_pool rcs
                        WHERE rcs.sheet_id = ${a}.sheet_id AND rcs.tab_name = ${a}.tab_name AND rcs.seq = ${a}.row_index
                          AND rcs.status <> 'cancelled' LIMIT 1)`,
});

/** 방식별 규칙. reasons = 그 방식의 사유 코드(담당자 창 글자는 reviewReminder.service MANUAL_REASON). */
const PLAN_RULES = Object.freeze({
  deadline_day_once: Object.freeze({
    reminderNo: 1,          // 템플릿 = TEMPLATE_NAMES[1] '리뷰미작성_1차'(#{제출기한} = 마감일) — 3차(「미작성 종결·입금 안 됨」)는 결정 422 와 어긋나 쓰지 않는다
    maxSends: 1,            // 한 번 보낸(도착 확인된) 줄은 다시 보내지 않는다
    manualLateDays: 7,      // 담당자 수동 = 마감일 + 7일 끝까지(그 뒤는 문자)
    sendOffsetDays: 0,      // 보내는 날 = 마감일 당일
    autoAfterStartDay: false,
    reasons: Object.freeze({
      before: 'booking_before_deadline_day', passed: 'booking_deadline_day_passed',
      schedulePassed: 'booking_schedule_passed', delivered: 'booking_reminder_delivered',
    }),
  }),
  day_before_deadline_once: Object.freeze({
    reminderNo: 1,          // 리뷰미작성_1차(승인 문구 「… 리뷰가 아직 등록되지 않았습니다. 제출기한: #{제출기한} …」 — 솔라피 콘솔 확인 2026-11-28)
    maxSends: 1,
    manualLateDays: 7,      // 담당자 수동 = 보내는 날 ~ 마감일 + 7일 끝
    sendOffsetDays: 1,      // 보내는 날 = 마감일 전날
    autoAfterStartDay: true,   // 보내는 날 ≤ 참여일(리뷰 기한 1일)이면 자동은 쉰다(담당자 수동은 가능)
    reasons: Object.freeze({
      before: 'receipt_before_send_day', passed: 'receipt_send_day_passed',
      schedulePassed: 'receipt_schedule_passed', delivered: 'receipt_reminder_delivered',
      startDay: 'receipt_send_day_is_join_day',
    }),
  }),
});

for (const [kind, planName] of Object.entries(REMINDER_PLAN_BY_KIND)) {
  if (typeof KIND_ROW_SQL[kind] !== 'function') throw new Error(`reviewReminderPlan: ${kind} 줄 판정 SQL 이 없습니다`);
  if (typeof PLAN_DEADLINE_SQL[planName] !== 'function') throw new Error(`reviewReminderPlan: ${planName} 마감일 SQL 이 없습니다`);
  const rules = PLAN_RULES[planName];
  if (!rules) throw new Error(`reviewReminderPlan: ${planName} 규칙이 없습니다`);
  if (!Number.isInteger(rules.sendOffsetDays) || rules.sendOffsetDays < 0) throw new Error(`reviewReminderPlan: ${planName} 보내는 날(sendOffsetDays)이 올바르지 않습니다`);
  if (rules.autoAfterStartDay && typeof PLAN_START_SQL[planName] !== 'function') throw new Error(`reviewReminderPlan: ${planName} 시작일 SQL 이 없습니다`);
}

/** 종류(자유 문자열 포함) → 알림 방식. 모르는 값 = 기본(workKind 규칙 그대로). */
function reminderPlanOfKind(workKind) {
  return REMINDER_PLAN_BY_KIND[normalizeWorkKind(workKind)] || DEFAULT_PLAN;
}

/**
 * LATERAL 하위 질의 — 한 줄의 알림 방식(plan) · 마감일(deadline_ymd) · 시작일(start_ymd) · 자동으로 보내는 날(auto_send_ymd).
 *   기본 방식 = 셋 다 항상 NULL. 자동으로 보내지 않는 줄(마감일 모름 · 참여 당일이 보내는 날 · 참여일 모름) = auto_send_ymd NULL.
 *   ★ 예약(deadline_day_once · 0일 앞 · 시작일 조건 없음) = auto_send_ymd 가 곧 deadline_ymd(종전 「마감일이 오늘」 그대로).
 *   사용: `JOIN LATERAL (${reminderPlanLateralSql({ alias: 'ri' })}) pl ON TRUE` — 항상 한 줄(줄 수 불변).
 */
function reminderPlanLateralSql({ alias = 'ri' } = {}) {
  const planNames = [...new Set(Object.values(REMINDER_PLAN_BY_KIND))];
  const whens = Object.entries(REMINDER_PLAN_BY_KIND)
    .map(([kind, planName]) => `WHEN ${KIND_ROW_SQL[kind](alias)} THEN '${planName}'`).join(' ');
  const deadlines = planNames.map(planName => `WHEN '${planName}' THEN ${PLAN_DEADLINE_SQL[planName](alias)}`).join(' ');
  const starts = planNames.filter(n => typeof PLAN_START_SQL[n] === 'function')
    .map(planName => `WHEN '${planName}' THEN ${PLAN_START_SQL[planName](alias)}`).join(' ');
  const autos = planNames.map(planName => {
    const r = PLAN_RULES[planName];
    const send = `(d.deadline_ymd::date - ${r.sendOffsetDays})`;
    const cond = r.autoAfterStartDay ? `d.start_ymd IS NOT NULL AND ${send} > d.start_ymd::date` : 'TRUE';
    return `WHEN '${planName}' THEN CASE WHEN d.deadline_ymd IS NOT NULL AND ${cond} THEN to_char(${send}, 'YYYY-MM-DD') END`;
  }).join(' ');
  return `SELECT d.plan, d.deadline_ymd, d.start_ymd, CASE d.plan ${autos} END AS auto_send_ymd
            FROM (SELECT p.plan, CASE p.plan ${deadlines} END AS deadline_ymd,
                         (CASE p.plan ${starts} ELSE NULL END)::text AS start_ymd
                    FROM (SELECT CASE ${whens} ELSE '${DEFAULT_PLAN}' END AS plan) p) d`;
}

/**
 * 후보 줄 → { plan, deadlineYmd|null, startYmd|null, rules|null }.
 *   · 방식 칸이 없는 옛 모양 줄(시험·옛 사본) = 기본 — 종전 그대로.
 *   · 날짜 글자가 날짜가 아니면 null(모름 · fail-safe).
 */
function reminderPlanOfRow(row) {
  const r = row || {};
  const planName = r.reminderPlan == null ? DEFAULT_PLAN : String(r.reminderPlan);
  const ymd = v => { const s = v == null ? '' : String(v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
  return { plan: planName, deadlineYmd: ymd(r.planDeadline), startYmd: ymd(r.planStart), rules: PLAN_RULES[planName] || null };
}

module.exports = {
  DEFAULT_PLAN, REMINDER_PLAN_BY_KIND, PLAN_RULES,
  reminderPlanOfKind, reminderPlanLateralSql, reminderPlanOfRow,
};
