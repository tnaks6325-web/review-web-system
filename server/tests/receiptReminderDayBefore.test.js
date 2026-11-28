'use strict';
/**
 * receiptReminderDayBefore.test.js — 결정 432 사용자 확정(2026-11-28 ②) 회귀가드 (스키마 변경 0).
 *
 * 무엇을 막나:
 *   영수증리뷰(receipt) 줄의 리뷰 미작성 알림톡은 **리뷰 마감일 전날(KST) 한 번만** 나간다.
 *   마감일 = 영수증 줄 `receipt_pool.review_deadline`(= 참여일 + 오더 review_deadline_days · 리뷰어 화면 「내일/오늘 마감」과 같은 칸).
 *   #{제출기한} = 그 마감일(화면 날짜). 1차 템플릿(리뷰미작성_1차)만 · 2차·3차 없음.
 *   ★ 자동 발송은 **보내는 날(마감 전날)이 오늘인 줄만** 후보로 읽는다(PR #1891 규칙 — 지난 줄을 후보 상한 안에 넣지 않는다).
 *   ★ 보내는 날을 놓치면 늦게 안 보낸다 · 담당자 수동 = 보내는 날 ~ 마감일 + 7일 · 마감일 모름 = 안 보냄.
 *   ★ 보내는 날이 참여한 날과 같거나 앞이면(리뷰 기한 1일) 자동으로 보내지 않는다(참여 당일 「아직 안 쓰셨다」 금지 — 보수적 결정).
 *   ★ 예약(마감 당일)·리뷰·블로그·Q&A 는 그대로(예약 쪽 얼린 시험 = bookingReminderDeadlineDay).
 *
 * 어떻게: PGlite(저장소 migrations 그대로) + 실제 reviewReminder 서비스(가짜 공급자 — 실제 발송 0 · fetch 막음) + 시계 주입.
 * 실행: node tests/receiptReminderDayBefore.test.js   (고치기 전 RED 전부 보기: DL_SOFT=1)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

for (const k of ['DATABASE_PUBLIC_URL']) delete process.env[k];
process.env.DATABASE_URL = 'postgres://u:***@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-receipt-day-before-secret';
Object.assign(process.env, {
  SOLAPI_API_KEY: 'test-key', SOLAPI_API_SECRET: 'test-secret', SOLAPI_PF_ID: 'test-pf', SOLAPI_SENDER_NUMBER: '0212345678',
  SOLAPI_REVIEW_TEMPLATE_ID_1: 'tpl-1', SOLAPI_REVIEW_TEMPLATE_ID_2: 'tpl-2', SOLAPI_REVIEW_TEMPLATE_ID_3: 'tpl-3',
  REVIEW_REMINDER_ENABLED: '1', REVIEW_REMINDER_DAILY_CAP: '500', REVIEW_REMINDER_CYCLE_LIMIT: '40',
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
const V = (n) => ymdAdd(TODAY, n);
const dayStart = (ymd) => new Date(ymd + 'T00:00:00+09:00').getTime();
const dayEnd = (ymd) => new Date(ymd + 'T23:59:59.999+09:00').getTime();
const dotted = (ymd) => ymd.replace(/-/g, '.');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

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

let phoneSeq = 30000000;
let poolSeq = 1;
const ROWS = {};
/** 한 줄 = 리뷰 색인 + 주문(참여 확정 장부) [+ 영수증 줄(참여일·마감일)] [+ 알림 상태]. */
async function addRow(q, key, { tab, row, subDays, joined, deadline, receipt = true, poolStatus = 'open', state }) {
  const phone8 = String(phoneSeq++);
  const ri = (await q(`INSERT INTO review_index (reviewer_name, sheet_id, tab_name, row_index, is_submitted, submit_col, row_json, phone8, product_name)
           VALUES ($1, 'S', $2, $3, FALSE, '리뷰', '{"리뷰":""}'::jsonb, $4, '가짜카페') RETURNING id`, ['리뷰어' + key, tab, row, phone8])).rows[0].id;
  const os = (await q(`INSERT INTO order_submissions (sheet_id, tab_name, sheet_row, phone, submitted_at) VALUES ('S', $1, $2, $3, $4) RETURNING id`,
    [tab, row, '010' + phone8, ago(subDays)])).rows[0].id;
  if (receipt) {
    const n = poolSeq++;
    await q(`INSERT INTO receipt_pool (work_order_id, sheet_id, tab_name, seq, pool_seq, file_id, status, joined_date, review_deadline)
             VALUES ('wo_rc', 'S', $1, $2, $3, $4, $5, $6::date, $7::date)`, [tab, row, n, 'fake_rc_' + n, poolStatus, joined || null, deadline || null]);
  }
  if (state) {
    await q(`INSERT INTO review_reminder_states (order_submission_id, review_index_id, sheet_id, tab_name, row_index, reviewer_name, phone8, product_name,
               review_deadline_at, reminder_count, last_reminded_at) VALUES ($1,$2,'S',$3,$4,$5,$6,'가짜카페',NOW(),$7,$8)`,
    [os, ri, tab, row, '리뷰어' + key, phone8, state.count, state.lastAgoH == null ? null : new Date(NOW - state.lastAgoH * 3600000).toISOString()]);
  }
  ROWS[key] = { tab, row, phone8, phone: '010' + phone8, joined, deadline, os };
}

(async () => {
  const db = await openDb();
  const pool = poolOf(db);
  const q = pool.query;
  const realPool = SRC('db/pool');
  realPool.query = q; realPool.connect = pool.connect;
  const plan = SRC('utils/reviewReminderPlan');

  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind) VALUES ('S','영수증탭','receipt'),('S','리뷰탭',''),('S','예약탭','booking')`);
  // 영수증 줄 — joined = 참여일 · deadline = 영수증 줄 리뷰마감일(참여일 + N)
  await addRow(q, 'r1', { tab: '영수증탭', row: 1, subDays: 2, joined: V(-2), deadline: V(1) });     // N=3 · 내일 마감 → 오늘 = 보내는 날 → 자동 1회
  await addRow(q, 'r2', { tab: '영수증탭', row: 2, subDays: 9, joined: V(-9), deadline: V(1) });     // N=10 · 내일 마감 → 자동 1회(종전 기간 절 밖이어도 읽는다)
  await addRow(q, 'r3', { tab: '영수증탭', row: 3, subDays: 1, joined: V(-1), deadline: V(2) });     // 모레 마감 → 아직(앞당기지 않음 · 수동도 막음)
  await addRow(q, 'r4', { tab: '영수증탭', row: 4, subDays: 3, joined: V(-3), deadline: TODAY });    // 오늘 마감 = 보내는 날(어제) 지남 → 자동 안 보냄 · 수동 가능
  await addRow(q, 'r5', { tab: '영수증탭', row: 5, subDays: 12, joined: V(-12), deadline: V(-9) }); // 마감 9일 지남 → 수동도 기간 지남
  await addRow(q, 'r6', { tab: '영수증탭', row: 6, subDays: 0.2, joined: TODAY, deadline: V(1) });  // N=1 · 보내는 날 = 참여한 날 → 자동 안 보냄(보수적) · 수동 가능
  await addRow(q, 'r7', { tab: '영수증탭', row: 7, subDays: 2, joined: V(-2), deadline: null });     // 마감일 모름 → 안 보냄 + 로그
  await addRow(q, 'r8', { tab: '영수증탭', row: 8, subDays: 2, receipt: false });                     // 영수증 줄 없음(취소로 영수증이 다른 줄로 옮겨감) → 모름
  await addRow(q, 'r9', { tab: '영수증탭', row: 9, subDays: 2, joined: V(-2), deadline: V(1), state: { count: 1, lastAgoH: 30 } });   // 이미 1번 보냄
  await addRow(q, 'r10', { tab: '영수증탭', row: 10, subDays: 7.2, joined: V(-7), deadline: V(-4) }); // 종전 규칙이면 7일째 1차 → 이제 0(수동만)
  await addRow(q, 'r11', { tab: '영수증탭', row: 11, subDays: 2, joined: V(-2), deadline: V(1), poolStatus: 'cancelled' }); // 취소된 영수증 자리 → 모름
  await addRow(q, 'r12', { tab: '영수증탭B', row: 12, subDays: 2, joined: V(-2), deadline: V(1) }); // 탭 종류 칸 없이 영수증 묶음만 → 영수증 규칙
  await addRow(q, 'v1', { tab: '리뷰탭', row: 101, subDays: 7.2, receipt: false });                   // 리뷰 줄 — 종전 7일째 1차
  await addRow(q, 'v2', { tab: '리뷰탭', row: 102, subDays: 2, receipt: false });                     // 리뷰 줄 — 아직
  const RC_TABS = new Set(['영수증탭', '영수증탭B']);
  const isRc = x => RC_TABS.has(x.tabName || (x.row && x.row.tabName));
  const keyOf = x => Object.keys(ROWS).find(k => ROWS[k].tab === (x.tabName || (x.row && x.row.tabName)) && ROWS[k].row === Number(x.rowIndex != null ? x.rowIndex : x.row.rowIndex));

  const reminder = SRC('services/reviewReminder.service');
  const sent = [];
  let statusCalls = 0;
  const provider = {
    async sendReviewAlimTalk(m) { sent.push(m); return { accepted: true, messageId: 'msg-' + sent.length, groupId: 'g', statusCode: '2000', reason: '' }; },
    async getMessageStatus() { statusCalls++; return { complete: true, success: true, statusCode: '4000', reason: '', dateReceived: new Date(NOW) }; },
  };
  const svc = reminder.createReviewReminderService({ db: pool, provider });
  const config = reminder.getReviewReminderConfig();
  const now = new Date(NOW);

  console.log('\n[0] 단일 출처 — 영수증 = 마감 전날 한 번 · 예약·다른 종류 그대로');
  t('★ receipt = 마감 전날 한 번(day_before_deadline_once)', plan.reminderPlanOfKind('receipt') === 'day_before_deadline_once' && plan.reminderPlanOfKind('영수증리뷰') === 'day_before_deadline_once');
  t('★ booking = 마감 당일 한 번 그대로(deadline_day_once)', plan.reminderPlanOfKind('booking') === 'deadline_day_once');
  for (const k of ['review', 'blog', 'qna', '', null, '모르는값']) t(`${JSON.stringify(k)} = 종전 7·13·14일(schedule_days)`, plan.reminderPlanOfKind(k) === 'schedule_days');
  const R = plan.PLAN_RULES.day_before_deadline_once || {};
  t('영수증 규칙: 1차만 · 한 번 · 전날(하루 앞) · 수동 = 마감 + 7일', R.reminderNo === 1 && R.maxSends === 1 && R.sendOffsetDays === 1 && R.manualLateDays === 7);
  t('예약 규칙(마감 당일)은 그대로 — 0일 앞 · 1차 · 한 번 · +7일', plan.PLAN_RULES.deadline_day_once.sendOffsetDays === 0 && plan.PLAN_RULES.deadline_day_once.reminderNo === 1
    && plan.PLAN_RULES.deadline_day_once.maxSends === 1 && plan.PLAN_RULES.deadline_day_once.manualLateDays === 7);
  const planSrc = fs.readFileSync(path.join(SERVER, 'src/utils/reviewReminderPlan.js'), 'utf8');
  t('★ 영수증 마감일 = receipt_pool.review_deadline 칸(화면 「내일/오늘 마감」 이 읽는 칸 · 다시 계산하지 않음)', /receipt_pool[\s\S]{0,200}review_deadline/.test(planSrc) && !/review_deadline_days/.test(planSrc));
  t('★ 영수증 줄 판정 = reviewClockStart.KIND_ROW_SQL(receipt) → utils/receiptTabSql 한 벌', typeof SRC('utils/reviewClockStart').KIND_ROW_SQL.receipt === 'function'
    && /receiptTabSql/.test(fs.readFileSync(path.join(SERVER, 'src/utils/reviewClockStart.js'), 'utf8')));
  t('★ 영수증 날수 시작일(블랙리스트·등록리뷰어 필터)은 그대로 제출 시각(참여일) — 알림톡만 바뀜', SRC('utils/reviewClockStart').clockStartBasis('receipt') === 'submission');

  console.log('\n[1] 자동(dry-run) — 보내는 날(마감 전날)이 오늘인 줄만');
  const dry = await svc.run({ dryRun: true, now, limit: 500 });
  const dueR = dry.items.filter(isRc).map(keyOf).sort();
  t('★★ 영수증 자동 대상 = 내일 마감 줄(r1·r12·r2)만', JSON.stringify(dueR) === JSON.stringify(['r1', 'r12', 'r2']), { dueR, skipped: dry.skipped });
  t('★ 자동 대상은 모두 1차 · #{제출기한} = 내일(= 화면 리뷰마감일)', dry.items.filter(isRc).every(x => x.reminderNo === 1 && x.deadline === dotted(V(1))), dry.items.filter(isRc));
  t('★ 모레 마감(r3)·오늘 마감(r4)·지난 마감(r5·r10)·참여 당일이 보내는 날(r6)·이미 보냄(r9)은 자동 대상 아님', !['r3', 'r4', 'r5', 'r6', 'r9', 'r10'].some(k => dueR.includes(k)), dueR);
  t('★ 마감일 모름(r7·r8·r11) = 보내지 않음', !['r7', 'r8', 'r11'].some(k => dueR.includes(k)), dry.skipped);
  t('★ 마감일 모름은 로그를 남긴다(영수증 글자)', warns.some(w => /영수증/.test(w) && /deadline_unknown/.test(w)), warns);
  t('리뷰 줄(v1)은 종전대로 7일째 1차 자동 대상', dry.items.some(x => keyOf(x) === 'v1' && x.reminderNo === 1));

  console.log('\n[2] 후보 SQL — 지난 줄·참여 당일 줄을 후보 상한 안에 넣지 않는다(PR #1891 규칙)');
  const cand = await svc.loadCandidates(Math.max(config.cycleLimit * 4, 100), config);
  const inCand = cand.filter(isRc).map(keyOf);
  t('★★ 자동 후보에 오늘 마감(r4)·지난 마감(r5·r10)·모레 마감(r3)·참여 당일(r6)·이미 보냄 아닌 지난 줄 없음', !['r3', 'r4', 'r5', 'r6', 'r10'].some(k => inCand.includes(k)), inCand);
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind) VALUES ('S','영수증탭C','receipt')`);
  for (let i = 0; i < 300; i++) await addRow(q, `old${i}`, { tab: '영수증탭C', row: 1000 + i, subDays: 3, joined: V(-3), deadline: TODAY });
  for (let i = 0; i < 50; i++) await addRow(q, `jd${i}`, { tab: '영수증탭C', row: 3000 + i, subDays: 0.1, joined: TODAY, deadline: V(1) });
  await addRow(q, 'rz', { tab: '영수증탭C', row: 2000, subDays: 2, joined: V(-2), deadline: V(1) });
  const candZ = await svc.loadCandidates(Math.max(config.cycleLimit * 4, 100), config);
  const posZ = candZ.findIndex(x => x.tabName === '영수증탭C' && Number(x.rowIndex) === 2000);
  const oldIn = candZ.filter(x => x.tabName === '영수증탭C' && Number(x.rowIndex) !== 2000).length;
  t('★★★ 보내는 날이 어제였던 줄 300 · 참여 당일 줄 50 이 있어도 후보 = rz 만(지난·막힌 줄 0)', oldIn === 0 && posZ >= 0, { posZ, oldIn, n: candZ.length });
  const nz = sent.length;
  await svc.run({ dryRun: false, now: new Date(NOW + 1000) });
  t('★ 실제 자동 실행에서 rz 는 기본 상한으로 보내진다', sent.slice(nz).some(m => m.to === ROWS.rz.phone));
  t('★ 지난 줄·참여 당일 줄은 한 통도 자동 발송되지 않는다', !sent.slice(nz).some(m => Object.keys(ROWS).some(k => (k.startsWith('old') || k.startsWith('jd')) && ROWS[k].phone === m.to)));

  console.log('\n[3] 시계 주입 — 마감 전날 하루만 · 늦게 안 보냄 · 수동 창');
  const load1 = async (key) => (await svc.loadCandidates(10, config, { sheetId: 'S', tabName: ROWS[key].tab, rowIndexes: [ROWS[key].row] }))[0];
  const at = (row, ms, extra) => reminder._summarizePreview([{ ...row, ...(extra || {}) }], new Date(ms), config)[0];
  const r3 = await load1('r3');   // 모레 마감 — 내일이 보내는 날
  t('r3 줄을 읽었다(담당자 지목은 기간 절 없음)', !!r3 && r3.reminderPlan === 'day_before_deadline_once' && r3.planDeadline === V(2), r3);
  const sendDay = V(1);
  const b0 = at(r3, dayStart(sendDay) - 1);
  t('★ 보내는 날 0시 1ms 전 = 아직(receipt_before_send_day) · 보낼 수 있는 시각 = 마감 전날 0시', b0.reason === 'receipt_before_send_day' && b0.eligibleAt && b0.eligibleAt.getTime() === dayStart(sendDay), b0);
  const on = at(r3, dayStart(sendDay));
  t('★★ 마감 전날 0시 정각 = 1차 보냄 · #{제출기한} = 마감일(전날 아님)', on.reason === null && on.reminderNo === 1 && reminder.formatKstDate(on.deadline) === dotted(V(2)), on);
  t('마감 전날 23:59:59.999 = 보냄', at(r3, dayEnd(sendDay)).reason === null);
  t('★ 마감일 당일 0시 = 자동 안 보냄(receipt_send_day_passed — 늦게 안 보냄)', at(r3, dayEnd(sendDay) + 1).reason === 'receipt_send_day_passed');
  t('마감 + 7일 끝까지 = 수동만 가능 사유 그대로', at(r3, dayEnd(V(9))).reason === 'receipt_send_day_passed');
  t('★ 마감 + 8일 0시 = 기간 지남(receipt_schedule_passed)', at(r3, dayEnd(V(9)) + 1).reason === 'receipt_schedule_passed');
  t('★ 마감일 칸이 비면 = deadline_unknown(7·13·14일·참여일 + 3 계산으로 되돌아가지 않음)', [dayStart(sendDay), NOW, NOW + 5 * DAY].every(ms => at(r3, ms, { planDeadline: null }).reason === 'deadline_unknown'));
  t('★ 참여일 칸이 비면 = deadline_unknown(fail-safe)', at(r3, dayStart(sendDay), { planStart: null }).reason === 'deadline_unknown');
  const r6 = await load1('r6');
  t('★★ 리뷰 기한 1일(보내는 날 = 참여한 날) = 자동 안 보냄(receipt_send_day_is_join_day)', at(r6, NOW).reason === 'receipt_send_day_is_join_day', at(r6, NOW));
  t('그 줄도 마감일 당일엔 늦게 안 보냄 사유(수동만)', at(r6, dayStart(V(1))).reason === 'receipt_send_day_passed');
  let never23 = true;
  for (let c = 0; c <= 3; c++) for (let h = -24 * 5; h <= 24 * 20; h += 5) {
    const x = at(r3, NOW + h * 3600000, { reminderCount: c, lastRemindedAt: c ? new Date(NOW - 30 * DAY) : null });
    if (x.reminderNo !== 1 || (c >= 1 && x.reason === null)) never23 = false;
  }
  t('★ 어떤 시각·어떤 회차 기록에서도 1차만 · 한 번 보낸 뒤 다시 없음(2차·3차·「미작성 종결」 문구 없음)', never23);

  console.log('\n[4] 실제 자동 실행(가짜 공급자) — 한 번만 · 변수');
  const n0 = sent.length;
  await svc.run({ dryRun: false, now: new Date(NOW + 2000) });
  const got = sent.slice(0).filter(m => ['r1', 'r2', 'r12'].some(k => ROWS[k].phone === m.to));
  t('★ 자동 발송 = r1·r2·r12 각 한 통(앞 [2] 실행 포함 누적)', ['r1', 'r2', 'r12'].every(k => got.filter(m => m.to === ROWS[k].phone).length === 1), { got: got.map(m => m.to) });
  const m1 = got.find(m => m.to === ROWS.r1.phone);
  t('★ 변수 = #{상품명}·#{리뷰링크}·#{리뷰어명}·#{제출기한}(= 내일 = 마감일) 넷 · 1차', !!m1 && m1.reminderNo === 1
    && JSON.stringify(m1.variables) === JSON.stringify({ '#{상품명}': '가짜카페', '#{리뷰링크}': config.reviewLink, '#{리뷰어명}': '리뷰어r1', '#{제출기한}': dotted(V(1)) }), m1 && m1.variables);
  const led = (await q(`SELECT d.template_name, d.reminder_no, d.final_due_at, s.review_deadline_at
                          FROM review_reminder_deliveries d JOIN review_reminder_states s USING (order_submission_id) WHERE d.order_submission_id = $1`, [ROWS.r1.os])).rows;
  t('원장 = 리뷰미작성_1차 · 1회차 · 최종기한 없음 · 상태 줄 마감 = 마감일 끝(KST)', led.length === 1 && led[0].template_name === '리뷰미작성_1차' && Number(led[0].reminder_no) === 1
    && led[0].final_due_at == null && new Date(led[0].review_deadline_at).getTime() === dayEnd(V(1)), led);
  t('영수증이 아닌 리뷰 줄 v1 은 종전 1차로 보내졌다', sent.some(m => m.to === ROWS.v1.phone && m.reminderNo === 1));
  const n1 = sent.length;
  await svc.run({ dryRun: false, now: new Date(NOW + 60000) });
  t('★ 같은 날 다시 돌려도 더 보내지 않는다', sent.length === n1 && statusCalls > 0 && n1 >= n0);
  const r1after = await load1('r1');
  const later = [];
  for (let d = 0; d <= 20; d++) { const x = at(r1after, dayStart(V(d)) + 11 * 3600000); if (x.reason === null) later.push(d); }
  t('★ 보낸 뒤 20일 동안 다시 보낼 수 없다 · 사유 = receipt_reminder_delivered', later.length === 0 && at(r1after, NOW).reason === 'receipt_reminder_delivered', later);

  console.log('\n[5] 담당자 수동 — 보내는 날 ~ 마감 + 7일 · 영수증 글자');
  const mp = await svc.manualPreview({ sheetId: 'S', tabName: '영수증탭', rowIndexes: [1, 3, 4, 5, 6, 7, 8, 9, 10], now });
  const m = k => mp.byRow.get(ROWS[k].row);
  t('★ r3(모레 마감) = 막힘 · 「마감 전날」 부터라는 말(앞당기지 않음)', m('r3') && !m('r3').ok && /전날/.test(m('r3').reason) && /영수증리뷰/.test(m('r3').reason), m('r3'));
  t('★ r4(오늘 마감 · 보내는 날 지남) = 수동 가능 · 1차 · 기한 = 오늘(화면 마감일)', m('r4') && m('r4').ok && m('r4').reminderNo === 1 && m('r4').deadline === dotted(TODAY), m('r4'));
  t('★ r10(마감 4일 지남) = 수동 가능', m('r10') && m('r10').ok && m('r10').deadline === dotted(V(-4)), m('r10'));
  t('★ r5(마감 9일 지남) = 막힘 · 「리뷰 마감일 후」 기간 · 문자 안내(「구매」 글자 없음)', m('r5') && !m('r5').ok && /마감일/.test(m('r5').reason) && /문자/.test(m('r5').reason) && !/구매/.test(m('r5').reason), m('r5'));
  t('★ r6(참여 당일이 보내는 날) = 담당자는 보낼 수 있다(자동만 쉰다)', m('r6') && m('r6').ok && m('r6').deadline === dotted(V(1)), m('r6'));
  t('★ r7·r8(마감일 모름) = 막힘 · 마감일을 확인 못 했다는 말', [m('r7'), m('r8')].every(x => x && !x.ok && /마감일/.test(x.reason) && /확인/.test(x.reason)), [m('r7'), m('r8')]);
  t('★ r1·r9(이미 보냄) = 막힘 · 「이미」 · 영수증리뷰는 한 번만', [m('r1'), m('r9')].every(x => x && !x.ok && /이미/.test(x.reason) && /영수증리뷰/.test(x.reason)), [m('r1'), m('r9')]);
  const nS = sent.length;
  const sm = await svc.sendManual({ sheetId: 'S', tabName: '영수증탭', rowIndexes: [4], now });
  t('★ 수동 발송 r4 = 1차 한 통 · #{제출기한} = 오늘(마감일)', sm.results[0] && sm.results[0].sent && sent.length === nS + 1 && sent[nS].variables['#{제출기한}'] === dotted(TODAY), sm.results);
  const sm2 = await svc.sendManual({ sheetId: 'S', tabName: '영수증탭', rowIndexes: [4], now: new Date(NOW + 60000) });
  t('★ r4 를 다시 눌러도 두 번째는 안 나간다', sm2.results[0] && !sm2.results[0].sent && sent.length === nS + 1, sm2.results);

  if (softFails.length) { console.log(`\n✗ ${softFails.length} failed (soft)`); process.exit(1); }
  console.log(`\n✅ receiptReminderDayBefore: ${pass}개 통과\n`);
  process.exit(0);
})().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
