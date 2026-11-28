'use strict';
/**
 * bookingReminderDeadlineDay.test.js — 결정 426 회귀가드 (스키마 변경 0).
 *
 * 무엇을 막나:
 *   네이버예약리뷰(booking) 줄의 리뷰 미작성 알림톡은 **리뷰 마감일 당일(KST) 한 번만** 나간다(사용자 확정 2026-11-25 ③).
 *   마감일 = 자리표 `booking_slots.review_deadline`(= 이용일 + 오더의 리뷰 기한 N일 · 기본 3) — 리뷰어 화면 「오늘 마감」과 같은 날.
 *   알림톡의 #{제출기한} = 그 마감일. 1차 템플릿(리뷰미작성_1차)만 · 2차·3차 없음.
 *   ★ 자동 발송은 마감일 하루만(지나면 늦게 보내지 않음) · 담당자 수동은 마감일 ~ 마감일 + 7일.
 *   ★ 마감일을 모르면 보내지 않는다(로그) — 제출 시각·7·13·14일로 되돌아가지 않는다.
 *   ★ 리뷰·블로그·Q&A 줄은 종전과 같은 줄·같은 순서·같은 판정·같은 변수(종전 SQL·판정 원문을 이 파일에 얼려 같은 DB 에서 대조).
 *
 * 어떻게: PGlite(저장소 migrations 그대로) + 실제 reviewReminder 서비스(가짜 공급자 — 실제 발송 0 · fetch 막음) + 시계 주입.
 * 실행: node tests/bookingReminderDeadlineDay.test.js   (고치기 전 RED 전부 보기: DL_SOFT=1)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

for (const k of ['DATABASE_PUBLIC_URL']) delete process.env[k];
process.env.DATABASE_URL = 'postgres://u:***@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-deadline-day-secret';
// 가짜 공급자 설정(값만 — 실제 공급자 모듈은 부르지 않는다 · fetch 막음)
Object.assign(process.env, {
  SOLAPI_API_KEY: 'test-key', SOLAPI_API_SECRET: 'test-secret', SOLAPI_PF_ID: 'test-pf', SOLAPI_SENDER_NUMBER: '0212345678',
  SOLAPI_REVIEW_TEMPLATE_ID_1: 'tpl-1', SOLAPI_REVIEW_TEMPLATE_ID_2: 'tpl-2', SOLAPI_REVIEW_TEMPLATE_ID_3: 'tpl-3',
  REVIEW_REMINDER_ENABLED: '1', REVIEW_REMINDER_DAILY_CAP: '500', REVIEW_REMINDER_CYCLE_LIMIT: '500',
});
delete process.env.REVIEW_REMINDER_SCHEDULE_DAYS;
globalThis.fetch = async () => { throw new Error('외부 호출 금지(테스트)'); };

const SERVER = path.resolve(__dirname, '..');
const SRC = p => require(path.join(SERVER, 'src', p));

let pass = 0;
const softFails = [];
const t = (name, cond, extra) => {
  if (!cond && process.env.DL_SOFT === '1') { softFails.push(name); console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); return; }
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 1200) : ''));
  pass++; console.log('  ✓ ' + name);
};

const { logger } = SRC('utils/logger');
const warns = [];
logger.warn = (m) => warns.push(String(m));
logger.info = () => {};

const DAY = 86400000;
const NOW = Date.now();
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const TODAY = kstYmd(NOW);
const ymdAdd = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const dayStart = (ymd) => new Date(ymd + 'T00:00:00+09:00').getTime();
const dayEnd = (ymd) => new Date(ymd + 'T23:59:59.999+09:00').getTime();
const dotted = (ymd) => ymd.replace(/-/g, '.');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

/* ══ 얼린 원문(결정 426 이전 · origin/main 8c3f542d) — 비예약 줄 대조 기준. 고치지 않는다. ══ */
function OLD_CANDIDATES_SQL() {
  return `
      SELECT ri.id AS "reviewIndexId", ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
             ri.row_index AS "rowIndex", ri.reviewer_name AS "reviewerName",
             ri.campaign_name AS "campaignName", ri.product_name AS "productName",
             ri.start_date AS "startDate", ri.end_date AS "endDate", ri.phone8,
             ord.id AS "orderSubmissionId", ord.phone AS "orderPhone", ord.submitted_at AS "orderedAt",
             clk.basis AS "clockBasis", clk.start_at AS "clockStartAt",
             COALESCE(s.review_status, 'pending') AS "reviewStatus",
             COALESCE(s.reminder_count, 0)::int AS "reminderCount",
             s.last_reminded_at AS "lastRemindedAt", s.final_due_at AS "finalDueAt",
             EXISTS (
               SELECT 1 FROM review_reminder_deliveries d
                WHERE d.order_submission_id = ord.id
                  AND d.reminder_no = COALESCE(s.reminder_count, 0) + 1
                  AND d.provider_status = 'accepted'
             ) AS "hasOpenAttempt",
             (SELECT MAX(d.requested_at) FROM review_reminder_deliveries d
               WHERE d.order_submission_id = ord.id
                 AND d.reminder_no = COALESCE(s.reminder_count, 0) + 1) AS "latestAttemptAt"
        FROM review_index ri
        JOIN LATERAL (
          SELECT picked.* FROM (
            SELECT os.*, 0 AS priority
              FROM campaign_participants cp
              JOIN order_submissions os ON os.id = cp.order_submission_id
             WHERE cp.sheet_id = ri.sheet_id AND cp.tab_name = ri.tab_name AND cp.seq = ri.row_index
               AND cp.active = TRUE AND cp.deleted_at IS NULL AND os.deleted_at IS NULL
            UNION ALL
            SELECT os.*, 1 AS priority
              FROM order_submissions os
             WHERE os.sheet_id = ri.sheet_id AND os.tab_name = ri.tab_name AND os.sheet_row = ri.row_index
               AND os.deleted_at IS NULL
               AND RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) = ri.phone8
          ) picked
          ORDER BY picked.priority, picked.submitted_at DESC, picked.id DESC
          LIMIT 1
        ) ord ON TRUE
        JOIN LATERAL (SELECT k.basis, CASE k.basis WHEN 'submission' THEN ord.submitted_at WHEN 'visit_date' THEN (SELECT bks.slot_date::timestamp AT TIME ZONE 'Asia/Seoul' FROM booking_slots bks
                        WHERE bks.sheet_id = ri.sheet_id AND bks.tab_name = ri.tab_name AND bks.seq = ri.row_index
                          AND bks.status <> 'cancelled' LIMIT 1) END AS start_at
            FROM (SELECT CASE WHEN (EXISTS (SELECT 1 FROM booking_slots WHERE sheet_id = ri.sheet_id AND tab_name = ri.tab_name)
                                OR EXISTS (SELECT 1 FROM tab_configs WHERE sheet_id = ri.sheet_id AND tab_name = ri.tab_name AND work_kind = 'booking')) THEN 'visit_date' ELSE 'submission' END AS basis) k) clk ON TRUE
        LEFT JOIN review_reminder_states s ON s.order_submission_id = ord.id
       WHERE ri.is_submitted = FALSE
         AND ${SRC('services/reviewObligation.service').unfulfilledSql('ri')}
         AND ri.row_index IS NOT NULL
         AND ($2::int IS NULL OR COALESCE(clk.start_at, ord.submitted_at) >= NOW() - ($2::int * INTERVAL '1 day'))
         AND ($2::int IS NULL OR clk.basis = 'submission' OR clk.start_at IS NULL OR clk.start_at <= NOW())
         AND ($3::text IS NULL OR (ri.sheet_id = $3 AND ri.tab_name = $4 AND ri.row_index = ANY($5::int[])))
         AND COALESCE(s.review_status, 'pending') = 'pending'
         AND NOT EXISTS (SELECT 1 FROM review_closed_targets closed
           WHERE closed.sheet_id=ri.sheet_id AND closed.tab_name=ri.tab_name AND closed.row_index=ri.row_index)
         AND NOT EXISTS (
           SELECT 1 FROM workdesk_participant_deletions wd
            WHERE wd.order_submission_id = ord.id
               OR (wd.sheet_id = ri.sheet_id AND wd.tab_name = ri.tab_name AND wd.seq = ri.row_index)
         )
       ORDER BY clk.start_at, ri.sheet_id, ri.tab_name, ri.row_index
       LIMIT $1`;
}
/* 얼린 판정 원문(같은 커밋의 reviewReminder.service 순수 함수 · clockStartOfRow 포함) */
const OLD = (() => {
  const DEFAULT_SCHEDULE_DAYS = [7, 13, 14];
  const _validDateParts = (year, month, day) => {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  };
  const _kstParts = (date) => { const s = new Date(new Date(date).getTime() + 9 * 3600000); return { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() }; };
  const _kstEndOfDay = (y, m, d) => (_validDateParts(y, m, d) ? new Date(Date.UTC(y, m - 1, d, 14, 59, 59, 999)) : null);
  const formatKstDate = (date) => { const p = _kstParts(date); return `${p.year}.${String(p.month).padStart(2, '0')}.${String(p.day).padStart(2, '0')}`; };
  const _addHours = (date, h) => new Date(new Date(date).getTime() + h * 3600000);
  const _addKstDaysEnd = (date, days) => { const p = _kstParts(date); const o = _kstParts(new Date(Date.UTC(p.year, p.month - 1, p.day + days, 3, 0, 0))); return _kstEndOfDay(o.year, o.month, o.day); };
  const normalizeKoreanMobile = (v) => { let d = String(v || '').replace(/[^0-9]/g, ''); if (d.startsWith('82')) d = '0' + d.slice(2); return /^01\d{8,9}$/.test(d) ? d : null; };
  const buildTemplateVariables = (n, row, deadline, finalDue, link) => {
    const c = { '#{상품명}': String(row.productName || row.campaignName || row.tabName || '리뷰 상품').trim(), '#{리뷰링크}': link };
    if (n === 1) { c['#{리뷰어명}'] = String(row.reviewerName || '').trim(); c['#{제출기한}'] = formatKstDate(deadline); }
    else if (n === 2) c['#{제출기한}'] = formatKstDate(deadline);
    else c['#{최종기한}'] = formatKstDate(finalDue);
    return c;
  };
  const _kstDayStart = (date, days) => new Date(_addKstDaysEnd(date, days - 1).getTime() + 1);
  const reminderSchedule = (orderedAt, config) => {
    if (!orderedAt || Number.isNaN(new Date(orderedAt).getTime())) return null;
    const days = config.scheduleDays || DEFAULT_SCHEDULE_DAYS;
    return { purchaseDay: formatKstDate(orderedAt), slots: days.map(d => _kstDayStart(orderedAt, d)), deadline: _addKstDaysEnd(orderedAt, days[2]), windowEnd: _addKstDaysEnd(orderedAt, days[2]) };
  };
  const _eligibleAt = (row, sched, config) => {
    const count = Number(row.reminderCount || 0); if (count >= 3) return null;
    let at = sched.slots[count];
    if (count > 0 && row.lastRemindedAt) { const g = _addHours(row.lastRemindedAt, config.minGapHours || 12); if (g > at) at = g; }
    return at;
  };
  const clockStartOfRow = (row) => {
    const r = row || {}; const toDate = v => (v == null || v === '' || Number.isNaN(new Date(v).getTime()) ? null : new Date(v));
    if (r.clockBasis == null) return { basis: 'submission', at: toDate(r.orderedAt) };
    return { basis: String(r.clockBasis), at: toDate(r.clockStartAt) };
  };
  const _summarizePreview = (rows, now, config) => rows.map(row => {
    const start = clockStartOfRow(row); const byVisit = start.basis !== 'submission';
    const sched = reminderSchedule(start.at, config); const deadline = sched ? sched.deadline : null;
    const phone = normalizeKoreanMobile(row.orderPhone); const reminderNo = Number(row.reminderCount || 0) + 1;
    const eligibleAt = sched ? _eligibleAt(row, sched, config) : null;
    let reason = null;
    if (byVisit && !start.at) reason = 'visit_date_unknown';
    else if (byVisit && start.at > now) reason = 'visit_not_yet';
    else if (!sched) reason = 'purchase_date_unknown';
    else if (!phone) reason = 'participant_phone_invalid';
    else if (row.reviewStatus && row.reviewStatus !== 'pending') reason = row.reviewStatus;
    else if (Number(row.reminderCount || 0) >= 3) reason = 'all_reminders_delivered';
    else if (row.hasOpenAttempt) reason = 'provider_result_pending';
    else if (row.latestAttemptAt && _addHours(row.latestAttemptAt, config.retryHours) > now) reason = 'retry_cooldown';
    else if (now > sched.windowEnd) reason = 'schedule_passed';
    else if (eligibleAt && eligibleAt > now) reason = 'not_due';
    return { row, deadline, phone, reminderNo, eligibleAt, reason };
  });
  const MANUAL_OK = new Set([null, 'not_due']);
  const MANUAL_REASON = {
    purchase_date_unknown: '구매 기록이 없어 알림톡 회차를 정할 수 없습니다 — 문자로 보내세요',
    visit_date_unknown: '이용일(방문 날짜)을 확인하지 못해 알림톡 회차를 정할 수 없습니다 — 문자로 보내세요',
    visit_not_yet: '아직 이용일(방문 날짜) 전입니다 — 방문한 뒤에 보낼 수 있습니다',
    participant_phone_invalid: '주문 연락처가 휴대폰 번호가 아닙니다',
    all_reminders_delivered: '알림톡 3회를 이미 모두 보냈습니다',
    provider_result_pending: '앞서 보낸 알림톡의 도착 확인을 기다리는 중입니다',
    retry_cooldown: '방금 실패한 알림톡의 재시도 대기 중입니다(6시간)',
    schedule_passed: '알림톡 기간(구매 후 14일)이 지났습니다 — 문자로 보내세요',
    submitted: '리뷰를 이미 제출했습니다', closed_no_review: '미작성 종결된 줄입니다', cancelled: '취소된 주문입니다',
  };
  return { _summarizePreview, buildTemplateVariables, formatKstDate, MANUAL_OK, MANUAL_REASON };
})();

async function openDb() {
  const db = new PGlite();
  const dir = path.join(SERVER, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { /* PGlite 에 없는 확장을 쓰는 몇 파일 — 이 시험의 표와 무관 */ }
  }
  return db;
}
function poolOf(db) {
  const query = async (sql, params) => {
    const r = await db.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release() {} }), on() {}, end: async () => {} };
}

let phoneSeq = 20000000;
const ROWS = {};
async function addRow(q, key, { tab, row, subDays, visit, deadline, slotStatus = 'open', state }) {
  const phone8 = String(phoneSeq++);
  const ri = (await q(`INSERT INTO review_index (reviewer_name, sheet_id, tab_name, row_index, is_submitted, submit_col, row_json, phone8, product_name)
           VALUES ($1, 'S', $2, $3, FALSE, '리뷰', '{"리뷰":""}'::jsonb, $4, '상품') RETURNING id`, ['리뷰어' + key, tab, row, phone8])).rows[0].id;
  const os = (await q(`INSERT INTO order_submissions (sheet_id, tab_name, sheet_row, phone, submitted_at) VALUES ('S', $1, $2, $3, $4) RETURNING id`,
    [tab, row, '010' + phone8, ago(subDays)])).rows[0].id;
  if (visit !== undefined) {
    await q(`INSERT INTO booking_slots (work_order_id, sheet_id, tab_name, seq, slot_date, date_seq, review_deadline, status)
             VALUES ('wo', 'S', $1, $2, $3::date, $2, $4::date, $5)`, [tab, row, visit, deadline, slotStatus]);
  }
  if (state) {
    await q(`INSERT INTO review_reminder_states (order_submission_id, review_index_id, sheet_id, tab_name, row_index, reviewer_name, phone8, product_name,
               review_deadline_at, reminder_count, last_reminded_at) VALUES ($1,$2,'S',$3,$4,$5,$6,'상품',NOW(),$7,$8)`,
    [os, ri, tab, row, '리뷰어' + key, phone8, state.count, state.lastAgoH == null ? null : new Date(NOW - state.lastAgoH * 3600000).toISOString()]);
  }
  ROWS[key] = { tab, row, phone8, phone: '010' + phone8, subDays, visit, deadline, os };
}

(async () => {
  const db = await openDb();
  const pool = poolOf(db);
  const q = pool.query;
  const realPool = SRC('db/pool');
  realPool.query = q; realPool.connect = pool.connect;
  const plan = (() => { try { return SRC('utils/reviewReminderPlan'); } catch (_) { return null; } })();

  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind) VALUES ('S','리뷰탭',''),('S','블로그탭','blog'),('S','QnA탭','qna'),('S','예약탭','booking')`);
  let r = 1;
  for (const tab of ['리뷰탭', '블로그탭', 'QnA탭']) {
    for (const d of [2, 6.9, 7.2, 8, 12.9, 13.2, 14, 14.6, 15.5, 20, 40]) await addRow(q, `${tab}-${d}`, { tab, row: r++, subDays: d });
    await addRow(q, `${tab}-s1`, { tab, row: r++, subDays: 13.4, state: { count: 1, lastAgoH: 140 } });   // 2차 차례
    await addRow(q, `${tab}-s2`, { tab, row: r++, subDays: 14.3, state: { count: 2, lastAgoH: 20 } });    // 3차 차례
    await addRow(q, `${tab}-s3`, { tab, row: r++, subDays: 9, state: { count: 1, lastAgoH: 30 } });       // 2차 아직
  }
  const V = (n) => ymdAdd(TODAY, n);
  // 예약 줄 — visit = 이용일 · deadline = 자리표 리뷰마감일(이용일 + N)
  await addRow(q, 'k1', { tab: '예약탭', row: 201, subDays: 9, visit: V(-3), deadline: TODAY });          // N=3 · 오늘 마감 → 자동 1회
  await addRow(q, 'k2', { tab: '예약탭', row: 202, subDays: 4, visit: V(-1), deadline: TODAY });          // N=1 · 오늘 마감
  await addRow(q, 'k3', { tab: '예약탭', row: 203, subDays: 30, visit: V(-20), deadline: TODAY });        // N=20 · 오늘 마감(이용일 + 16일보다 늦은 마감도 읽는다)
  await addRow(q, 'k4', { tab: '예약탭', row: 204, subDays: 6, visit: V(-2), deadline: V(1) });          // 내일 마감 → 안 보냄 · 수동도 막음
  await addRow(q, 'k5', { tab: '예약탭', row: 205, subDays: 8, visit: V(-4), deadline: V(-1) });         // 어제 마감 → 자동 안 보냄(늦게 안 보냄) · 수동 가능
  await addRow(q, 'k6', { tab: '예약탭', row: 206, subDays: 15, visit: V(-12), deadline: V(-9) });       // 마감 9일 지남 → 수동도 기간 지남(종전: 1차 자동)
  await addRow(q, 'k7', { tab: '예약탭', row: 207, subDays: 10, visit: V(-8), deadline: V(-5) });        // 마감 5일 지남 → 자동 0 · 수동 가능(종전: 1차 자동)
  await addRow(q, 'k8', { tab: '예약탭', row: 208, subDays: 2, visit: TODAY, deadline: V(3) });          // 오늘 방문
  await addRow(q, 'k9', { tab: '예약탭', row: 209, subDays: 7, visit: V(-3), deadline: null });          // 마감일 모름 → 안 보냄 + 로그
  await addRow(q, 'k10', { tab: '예약탭', row: 210, subDays: 9 });                                         // 자리표 없음 → 이용일 모름
  await addRow(q, 'k11', { tab: '예약탭', row: 211, subDays: 9, visit: V(-3), deadline: TODAY, state: { count: 1, lastAgoH: 30 } }); // 이미 1번 보냄
  await addRow(q, 'k12', { tab: '예약탭', row: 212, subDays: 20, visit: V(-13), deadline: TODAY, state: { count: 1, lastAgoH: 150 } }); // 종전이면 2차 차례 → 0
  await addRow(q, 'k13', { tab: '예약탭B', row: 213, subDays: 9, visit: V(-3), deadline: TODAY });       // 탭 종류 칸 없이 자리표만 → 예약 규칙
  await addRow(q, 'k14', { tab: '예약탭', row: 214, subDays: 9, visit: V(2), deadline: V(5) });          // 방문 전
  const BOOKING_TABS = new Set(['예약탭', '예약탭B']);
  const isBooking = x => BOOKING_TABS.has(x.tabName || (x.row && x.row.tabName));
  const keyOf = x => Object.keys(ROWS).find(k => ROWS[k].tab === x.tabName && ROWS[k].row === Number(x.rowIndex));

  const reminder = SRC('services/reviewReminder.service');
  const sent = [];
  let statusCalls = 0;
  const provider = {
    async sendReviewAlimTalk(m) { sent.push(m); return { accepted: true, messageId: 'msg-' + sent.length, groupId: 'g', statusCode: '2000', reason: '' }; },
    async getMessageStatus() { statusCalls++; return { complete: true, success: true, statusCode: '4000', reason: '', dateReceived: new Date(NOW) }; },
  };
  const svc = reminder.createReviewReminderService({ db: pool, provider });
  const config = reminder.getReviewReminderConfig();
  const lookback = config.scheduleDays[2] + 2;
  const now = new Date(NOW);

  console.log('\n[1] 비예약(리뷰·블로그·Q&A) = 종전과 같은 줄·같은 순서·같은 판정(얼린 원문 대조 · 같은 DB)');
  const oldRows = (await q(OLD_CANDIDATES_SQL(), [500, lookback, null, null, null])).rows;
  const newRows = await svc.loadCandidates(500, config);
  const sig = x => [x.orderSubmissionId, x.sheetId, x.tabName, x.rowIndex, new Date(x.orderedAt).toISOString(), x.clockBasis, new Date(x.clockStartAt).toISOString(), x.reminderCount, x.reviewStatus, x.hasOpenAttempt, x.lastRemindedAt && new Date(x.lastRemindedAt).toISOString()].join('|');
  const oldNon = oldRows.filter(x => !isBooking(x)).map(sig);
  const newNon = newRows.filter(x => !isBooking(x)).map(sig);
  t('비예약 후보가 충분하다(시험이 비어 있지 않다)', oldNon.length >= 30, oldNon.length);
  t('★ 비예약 후보 = 종전 SQL 과 같은 줄 · 같은 순서', JSON.stringify(oldNon) === JSON.stringify(newNon), { oldNon, newNon });
  const pvSig = x => [x.row.orderSubmissionId, x.reason, x.reminderNo, x.eligibleAt && x.eligibleAt.toISOString(), x.deadline && x.deadline.toISOString(), x.phone].join('|');
  const nonNew = newRows.filter(x => !isBooking(x));
  let sweepDiff = [];
  for (let h = -24 * 3; h <= 24 * 20; h += 7) {
    const at = new Date(NOW + h * 3600000);
    const a = OLD._summarizePreview(nonNew, at, config).map(pvSig).join('\n');
    const b = reminder._summarizePreview(nonNew, at, config).map(pvSig).join('\n');
    if (a !== b) sweepDiff.push(h);
  }
  t('★ 비예약 발송 판정(사유·회차·발송 가능 시각·제출기한) = 얼린 종전 판정 · 시계 -3일~+20일 7시간 간격', sweepDiff.length === 0, sweepDiff.slice(0, 5));
  const varDiff = [];
  for (const row of nonNew) for (const n of [1, 2, 3]) {
    const dl = new Date(NOW + 3 * DAY), fd = new Date(NOW + 4 * DAY);
    if (JSON.stringify(OLD.buildTemplateVariables(n, row, dl, fd, 'L')) !== JSON.stringify(reminder.buildTemplateVariables(n, row, dl, fd, 'L'))) varDiff.push([row.rowIndex, n]);
  }
  t('★ 비예약 템플릿 변수(1·2·3차) = 종전 그대로', varDiff.length === 0, varDiff);
  const oldDueNon = OLD._summarizePreview(oldRows.filter(x => !isBooking(x)), now, config).filter(x => !x.reason);
  t('비예약 지금 보낼 줄이 1·2·3차 모두 있다(재료 확인)', [1, 2, 3].every(n => oldDueNon.some(x => x.reminderNo === n)), oldDueNon.map(x => x.reminderNo));

  console.log('\n[2] 예약 줄 — 리뷰 마감일 당일 한 번(자동 dry-run)');
  const dry = await svc.run({ dryRun: true, now, limit: 500 });
  const dueB = dry.items.filter(isBooking).map(keyOf).sort();
  t('★ 예약 자동 대상 = 오늘 마감 줄(k1·k13·k2·k3)만', JSON.stringify(dueB) === JSON.stringify(['k1', 'k13', 'k2', 'k3']), { dueB, skipped: dry.skipped });
  t('★ 예약 자동 대상은 모두 1차 · 제출기한 = 오늘(= 화면 리뷰마감일)', dry.items.filter(isBooking).every(x => x.reminderNo === 1 && x.deadline === dotted(TODAY)), dry.items.filter(isBooking));
  t('★ 마감 지난 줄(k5·k6·k7)·내일 마감(k4)·이미 보낸 줄(k11·k12)은 자동 대상 아님', !['k4', 'k5', 'k6', 'k7', 'k11', 'k12'].some(k => dueB.includes(k)), dueB);
  t('★ 마감일 모름(k9) = 보내지 않음 · 사유 deadline_unknown', dry.skipped.deadline_unknown === 1 && !dueB.includes('k9'), dry.skipped);
  t('★ 마감일 모름은 로그를 남긴다', warns.some(w => /마감일/.test(w) && /deadline_unknown/.test(w)), warns);
  t('이용일 모름(k10)은 종전대로 visit_date_unknown', dry.skipped.visit_date_unknown === 1, dry.skipped);
  t('이미 보낸 예약 줄(k11·k12) = booking_reminder_delivered(2차 없음)', dry.skipped.booking_reminder_delivered === 2, dry.skipped);
  t('★ 어제 마감(k5) = 자동 후보로 읽지도 않음(늦게 보내지 않음 · 후보 상한을 잡아먹지 않음 — PR #1891 리뷰 P2)', !dueB.includes('k5') && !dry.skipped.booking_deadline_day_passed, dry.skipped);
  const nonDueKeys = dry.items.filter(x => !isBooking(x)).map(x => x.orderSubmissionId).join(',');
  t('★ 비예약 자동 대상 = 얼린 종전 판정의 대상과 같다', nonDueKeys === oldDueNon.map(x => x.row.orderSubmissionId).join(','), { nonDueKeys });

  console.log('\n[3] 시계 주입 — 마감일 하루만 · 늦게 안 보냄 · 수동 창');
  const load1 = async (key) => (await svc.loadCandidates(10, config, { sheetId: 'S', tabName: ROWS[key].tab, rowIndexes: [ROWS[key].row] }))[0];
  const k1 = await load1('k1');
  t('k1 줄을 읽었다', !!k1);
  const at = (row, ms, extra) => reminder._summarizePreview([{ ...row, ...(extra || {}) }], new Date(ms), config)[0];
  const ds = dayStart(TODAY), de = dayEnd(TODAY);
  const before = at(k1, ds - 1);
  t('마감일 0시(KST) 1ms 전 = 아직(booking_before_deadline_day) · 보낼 수 있는 시각 = 마감일 0시', before.reason === 'booking_before_deadline_day' && before.eligibleAt && before.eligibleAt.getTime() === ds, before.reason);
  const onStart = at(k1, ds);
  t('★ 마감일 0시 정각 = 1차 보냄 · 제출기한 = 마감일', onStart.reason === null && onStart.reminderNo === 1 && reminder.formatKstDate(onStart.deadline) === dotted(TODAY), onStart.reason);
  t('마감일 23:59:59.999 = 아직 보냄', at(k1, de).reason === null);
  t('★ 마감 다음 날 0시 = 자동 안 보냄(booking_deadline_day_passed)', at(k1, de + 1).reason === 'booking_deadline_day_passed');
  t('마감 + 7일 끝까지 = 수동만 가능 사유 그대로', at(k1, dayEnd(V(7))).reason === 'booking_deadline_day_passed');
  t('★ 마감 + 8일 0시 = 기간 지남(booking_schedule_passed)', at(k1, dayEnd(V(7)) + 1).reason === 'booking_schedule_passed');
  t('이용일 전 = visit_not_yet(종전 그대로)', at(k1, dayStart(V(-3)) - 1).reason === 'visit_not_yet');
  t('★ 마감일 칸이 비면 = deadline_unknown(제출 시각·7·13·14일로 되돌아가지 않음)', [ds, ds + 5 * DAY, NOW - 1 * DAY].every(ms => at(k1, ms, { planDeadline: null }).reason === 'deadline_unknown'));
  t('★ 이용일이 비면 = visit_date_unknown(종전 그대로)', at(k1, ds, { clockStartAt: null }).reason === 'visit_date_unknown');
  let never23 = true;
  for (let c = 0; c <= 3; c++) for (let h = -24 * 5; h <= 24 * 20; h += 5) {
    const x = at(k1, NOW + h * 3600000, { reminderCount: c, lastRemindedAt: c ? new Date(NOW - 30 * DAY) : null });
    if (x.reminderNo !== 1 || (c >= 1 && x.reason === null)) never23 = false;
  }
  t('★ 예약 줄은 어떤 시각·어떤 회차 기록에서도 1차만 · 한 번 보낸 뒤 다시 보낼 수 없음(2차·3차 없음)', never23);

  console.log('\n[4] 실제 자동 실행(가짜 공급자) — 한 번만 · 변수');
  const run1 = await svc.run({ dryRun: false, now });
  const sentB = sent.filter(m => Object.values(ROWS).some(x => BOOKING_TABS.has(x.tab) && x.phone === m.to));
  const sentKeys = sentB.map(m => Object.keys(ROWS).find(k => ROWS[k].phone === m.to)).sort();
  t('★ 자동 실행 예약 발송 = k1·k13·k2·k3 각 한 통', JSON.stringify(sentKeys) === JSON.stringify(['k1', 'k13', 'k2', 'k3']), { sentKeys, run1 });
  const m1 = sentB.find(m => m.to === ROWS.k1.phone);
  t('★ 예약 발송 = 1차 템플릿 번호(reminderNo 1)', sentB.every(m => m.reminderNo === 1));
  t('★ 예약 변수 = #{상품명}·#{리뷰링크}·#{리뷰어명}·#{제출기한}(= 오늘 마감일) 넷뿐', !!m1 && JSON.stringify(m1.variables) === JSON.stringify({ '#{상품명}': '상품', '#{리뷰링크}': config.reviewLink, '#{리뷰어명}': '리뷰어k1', '#{제출기한}': dotted(TODAY) }), m1 && m1.variables);
  const led = (await q(`SELECT d.template_name, d.reminder_no, d.template_variables, d.final_due_at, s.review_deadline_at
                          FROM review_reminder_deliveries d JOIN review_reminder_states s USING (order_submission_id) WHERE d.order_submission_id = $1`, [ROWS.k1.os])).rows;
  t('원장 = 리뷰미작성_1차 · 1회차 · 최종기한 없음 · 상태 줄 마감 = 마감일 끝(KST)',
    led.length === 1 && led[0].template_name === '리뷰미작성_1차' && Number(led[0].reminder_no) === 1 && led[0].final_due_at == null
      && new Date(led[0].review_deadline_at).getTime() === de, led);
  const sentNon = sent.filter(m => !sentB.includes(m));
  const fd = new Date(dayEnd(V(config.finalGraceDays)));   // 3차 최종기한 = 발송일 + 유예일 끝(종전 규칙)
  const expectNon = oldDueNon.map(x => JSON.stringify([x.phone, x.reminderNo, OLD.buildTemplateVariables(x.reminderNo, x.row, x.deadline, x.reminderNo === 3 ? fd : null, config.reviewLink)]));
  const gotNon = sentNon.map(m => JSON.stringify([m.to, m.reminderNo, m.variables]));
  t('★ 비예약 실제 발송(받는 사람·회차·변수) = 얼린 종전 판정 그대로', JSON.stringify(gotNon.sort()) === JSON.stringify(expectNon.sort()), { gotNon, expectNon });
  const n1 = sent.length;
  const run2 = await svc.run({ dryRun: false, now: new Date(NOW + 60000) });
  t('★ 같은 날 다시 돌려도 더 보내지 않는다(도착 확인 뒤 회차 1 기록)', sent.length === n1 && statusCalls > 0, run2);
  const st = (await q(`SELECT reminder_count FROM review_reminder_states WHERE order_submission_id = $1`, [ROWS.k1.os])).rows[0];
  t('도착 확인 뒤 k1 상태 = 1회 보냄', st && Number(st.reminder_count) === 1, st);
  const k1after = await load1('k1');
  let later = [];
  for (let d = 0; d <= 20; d++) { const x = at(k1after, dayStart(V(d)) + 11 * 3600000); if (x.reason === null) later.push(d); }
  t('★ 보낸 뒤 이후 20일 동안 어느 날에도 다시 보낼 수 없다(2차·3차 0)', later.length === 0 && at(k1after, NOW).reason === 'booking_reminder_delivered', later);

  console.log('\n[5] 담당자 수동 미리보기·발송 — 예약 줄 사유 글자');
  const mp = await svc.manualPreview({ sheetId: 'S', tabName: '예약탭', rowIndexes: [201, 204, 205, 206, 207, 208, 209, 210, 211, 212, 214], now });
  const m = k => mp.byRow.get(ROWS[k].row);
  t('k1(이미 보냄) = 막힘 · 「이미」 보냈다는 말', m('k1') && !m('k1').ok && /이미/.test(m('k1').reason), m('k1'));
  t('★ k4(내일 마감) = 막힘 · 마감일 당일부터라는 말', m('k4') && !m('k4').ok && /마감일/.test(m('k4').reason) && /당일/.test(m('k4').reason), m('k4'));
  t('★ k5(어제 마감) = 수동 가능 · 1차 · 기한 = 어제(화면 마감일)', m('k5') && m('k5').ok && m('k5').reminderNo === 1 && m('k5').deadline === dotted(V(-1)), m('k5'));
  t('★ k7(마감 5일 지남) = 수동 가능', m('k7') && m('k7').ok && m('k7').deadline === dotted(V(-5)), m('k7'));
  t('★ k6(마감 9일 지남) = 막힘 · 「리뷰 마감일 후」 기간 · 문자 안내(「구매 후 14일」 아님)', m('k6') && !m('k6').ok && /마감일/.test(m('k6').reason) && /문자/.test(m('k6').reason) && !/구매/.test(m('k6').reason), m('k6'));
  t('k8(오늘 방문 · 3일 뒤 마감) = 막힘(마감일 당일부터)', m('k8') && !m('k8').ok && /마감일/.test(m('k8').reason), m('k8'));
  t('★ k9(마감일 모름) = 막힘 · 마감일을 확인 못 했다는 말', m('k9') && !m('k9').ok && /마감일/.test(m('k9').reason) && /확인/.test(m('k9').reason), m('k9'));
  t('k10(이용일 모름) = 종전 글자', m('k10') && m('k10').reason === OLD.MANUAL_REASON.visit_date_unknown, m('k10'));
  t('k11·k12(이미 보냄) = 막힘', [m('k11'), m('k12')].every(x => x && !x.ok && /이미/.test(x.reason)));
  t('k14(방문 전) = 종전 글자(visit_not_yet)', m('k14') && m('k14').reason === OLD.MANUAL_REASON.visit_not_yet, m('k14'));
  const nonTargets = Object.keys(ROWS).filter(k => ROWS[k].tab === '리뷰탭');
  const mpN = await svc.manualPreview({ sheetId: 'S', tabName: '리뷰탭', rowIndexes: nonTargets.map(k => ROWS[k].row), now });
  const oldTargetRows = (await q(OLD_CANDIDATES_SQL(), [500, null, 'S', '리뷰탭', nonTargets.map(k => ROWS[k].row)])).rows;
  const oldBy = new Map();
  for (const x of OLD._summarizePreview(oldTargetRows, now, config)) {
    if (oldBy.has(Number(x.row.rowIndex))) continue;
    const ok = OLD.MANUAL_OK.has(x.reason);
    oldBy.set(Number(x.row.rowIndex), JSON.stringify([ok, x.reminderNo, x.deadline ? OLD.formatKstDate(x.deadline) : '', ok ? '' : (OLD.MANUAL_REASON[x.reason] || x.reason)]));
  }
  const diffN = [...oldBy.keys()].filter(k => { const n = mpN.byRow.get(k); return !n || JSON.stringify([n.ok, n.reminderNo, n.deadline, n.reason]) !== oldBy.get(k); });
  t('★ 비예약 수동 미리보기(가능 여부·회차·기한·사유 글자) = 종전 그대로', oldBy.size > 5 && diffN.length === 0 && mpN.byRow.size === oldBy.size, diffN);
  const nSent = sent.length;
  const sm = await svc.sendManual({ sheetId: 'S', tabName: '예약탭', rowIndexes: [205, 204], now });
  const r5 = sm.results.find(x => x.rowIndex === 205), r4 = sm.results.find(x => x.rowIndex === 204);
  t('★ 수동 발송 k5 = 1차 한 통 · #{제출기한} = 어제(마감일)', r5 && r5.sent && sent.length === nSent + 1 && sent[nSent].reminderNo === 1 && sent[nSent].variables['#{제출기한}'] === dotted(V(-1)), { r5, v: sent[nSent] && sent[nSent].variables });
  t('수동 발송 k4(내일 마감) = 안 보냄', r4 && !r4.sent, r4);
  const sm2 = await svc.sendManual({ sheetId: 'S', tabName: '예약탭', rowIndexes: [205], now: new Date(NOW + 60000) });
  t('★ k5 를 다시 눌러도 두 번째는 안 나간다', sm2.results[0] && !sm2.results[0].sent && sent.length === nSent + 1, sm2.results);

  console.log('\n[6] 단일 출처 — 종류별 알림 방식');
  t('reviewReminderPlan 모듈이 있다(종류별 알림 방식 단일 출처)', !!plan);
  if (plan) {
    t('booking = 마감일 당일 한 번(deadline_day_once)', plan.reminderPlanOfKind('booking') === 'deadline_day_once' && plan.reminderPlanOfKind('네이버예약리뷰') === 'deadline_day_once');
    for (const k of ['review', 'blog', 'qna', '', null, '모르는값']) t(`${JSON.stringify(k)} = 종전 7·13·14일(schedule_days)`, plan.reminderPlanOfKind(k) === 'schedule_days');
    // 결정 432 사용자 확정(2026-11-28 ②) — 영수증리뷰는 「마감 전날 한 번」으로 바뀌었다(자세한 가드 = receiptReminderDayBefore). 예약 방식과는 다른 값이어야 한다.
    for (const k of ['receipt', '영수증리뷰']) t(`${JSON.stringify(k)} = 마감 전날 한 번(day_before_deadline_once · 예약 방식 아님)`, plan.reminderPlanOfKind(k) === 'day_before_deadline_once');
    t('수동 늦은 발송 창 = 마감일 + 7일', plan.PLAN_RULES.deadline_day_once.manualLateDays === 7);
  }
  const read = p => fs.readFileSync(path.join(SERVER, p), 'utf8');
  const remSrc = read('src/services/reviewReminder.service.js');
  t('알림톡 후보 SQL 이 알림 방식 단일 출처(reminderPlanLateralSql)를 쓴다', /reviewReminderPlan[\s\S]{0,80}reminderPlanLateralSql/.test(remSrc));
  t('알림톡 서비스에 booking_slots 직접 읽기 사본이 없다', !/booking_slots/.test(remSrc));
  let planSrc = ''; try { planSrc = read('src/utils/reviewReminderPlan.js'); } catch (_) { /* RED */ }
  t('마감일 = 자리표 review_deadline 칸(화면 「오늘 마감」 과 같은 칸 · bookingSlots.reviewDeadlinesForRows 와 같은 칸)', /review_deadline/.test(planSrc) && /review_deadline/.test(read('src/services/bookingSlots.service.js')));
  t('예약 줄 판정 = reviewClockStart 의 종류 판정 SQL 한 벌(KIND_ROW_SQL)', /KIND_ROW_SQL/.test(planSrc));

  console.log('\n[7] 지난 마감 예약 줄이 많아도 오늘 마감 줄이 후보 상한(기본 40)에 밀리지 않는다 (PR #1891 리뷰 P2)');
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind) VALUES ('S','예약탭C','booking')`);
  for (let i = 0; i < 300; i++) await addRow(q, `old${i}`, { tab: '예약탭C', row: 1000 + i, subDays: 30, visit: V(-25), deadline: V(-1) });
  await addRow(q, 'kz', { tab: '예약탭C', row: 2000, subDays: 9, visit: V(-3), deadline: TODAY });
  const nz = sent.length;
  const candZ = await svc.loadCandidates(Math.max(config.cycleLimit * 4, 100), config);
  const posZ = candZ.findIndex(x => x.tabName === '예약탭C' && Number(x.rowIndex) === 2000);
  const oldInCand = candZ.filter(x => x.tabName === '예약탭C' && Number(x.rowIndex) < 2000).length;
  t('★ 자동 후보(상한 그대로)에 어제 마감 줄은 0 · 오늘 마감 kz 는 들어 있다', oldInCand === 0 && posZ >= 0, { posZ, oldInCand, n: candZ.length });
  const runZ = await svc.run({ dryRun: false, now: new Date(NOW + 120000) });
  t('★ 어제 마감 300줄이 있어도 오늘 마감 kz 는 기본 상한으로 자동 발송된다', sent.slice(nz).some(m => m.to === ROWS.kz.phone), { runZ, sentNew: sent.length - nz });
  t('★ 어제 마감 줄은 한 통도 자동 발송되지 않는다', !sent.slice(nz).some(m => Object.keys(ROWS).some(k => k.startsWith('old') && ROWS[k].phone === m.to)));

  if (softFails.length) { console.log(`\n✗ ${softFails.length} failed (soft)`); process.exit(1); }
  console.log(`\n${pass} booking reminder deadline-day checks passed`);
})().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
