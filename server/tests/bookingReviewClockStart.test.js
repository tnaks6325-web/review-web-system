'use strict';
/**
 * bookingReviewClockStart.test.js — 결정 423 회귀가드 (스키마 변경 0).
 *
 * 무엇을 막나:
 *   네이버예약리뷰(booking)는 예약 직후 예약내역(= 주문 줄 `order_submissions.submitted_at`)을 내지만 실제 방문(이용일 ·
 *   자리표 `booking_slots.slot_date`)은 며칠~몇 주 뒤다. 리뷰 미작성 알림톡(7·13·14일 · 결정 194)과 블랙리뷰어
 *   기한경과(14일)·리뷰미작성(30일 · 결정 050)이 **예약내역 낸 날**부터 세면, 방문도 하기 전에 「리뷰 안 썼다」 알림이 가고
 *   블랙리스트 후보가 된다. → 예약 줄만 **이용일(KST 0시)부터** 같은 날수(7·13·14 / 14·30)로 센다(사용자 확정 2026-11-25 1번).
 *   ★ 이용일을 모르면 그 예약 줄은 보내지 않고 세지 않는다(fail-safe · 로그) — 제출 시각으로 되돌아가지 않는다.
 *   ★ 이용일이 아직 안 온 줄은 고르지 않는다.
 *   ★ 리뷰·블로그·Q&A 줄은 종전과 **같은 줄을 같은 순서로** 고른다(종전 SQL 원문을 이 파일에 얼려 두고 같은 DB 에서 대조).
 *
 * 어떻게: PGlite(저장소 migrations 그대로) + 실제 reviewReminder 서비스(dry-run · 담당자 미리보기 — 공급자 호출 0) +
 *   실제 reviewerGate.annotateReviewerRows + 실제 등록리뷰어DB 라우터(flag=candidate/overdue).
 * ★ 실제 알림톡·운영 DB 는 부르지 않는다(공급자 = 빈 객체 · fetch 막음 · DB 주소는 닫힌 포트).
 * 실행: node tests/bookingReviewClockStart.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

for (const k of ['DATABASE_PUBLIC_URL', 'SOLAPI_API_KEY', 'SOLAPI_API_SECRET']) delete process.env[k];
process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booking-clock-secret';
globalThis.fetch = async () => { throw new Error('외부 호출 금지(테스트)'); };

const SERVER = path.resolve(__dirname, '..');
const SRC = p => require(path.join(SERVER, 'src', p));

let pass = 0;
const softFails = [];   // CLOCK_SOFT=1 = 실패해도 끝까지 돌려 전부 보여 준다(고치기 전 RED 기록용)
const t = (name, cond, extra) => {
  if (!cond && process.env.CLOCK_SOFT === '1') { softFails.push(name); console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); return; }
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 900) : ''));
  pass++; console.log('  ✓ ' + name);
};

const { logger } = SRC('utils/logger');
const warns = [];
logger.warn = (m) => warns.push(String(m));
logger.info = () => {};

const DAY = 86400000;
const NOW = Date.now();
const kstYmd = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const ago = (d) => new Date(NOW - d * DAY).toISOString();

/* ── 종전 SQL 원문(결정 423 이전 · origin/main 5baf4c3b) — 리뷰·블로그·Q&A 줄이 같은지 대조하는 기준. 고치지 않는다. ── */
function OLD_CANDIDATES_SQL() {
  return `
      SELECT ri.id AS "reviewIndexId", ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
             ri.row_index AS "rowIndex", ri.reviewer_name AS "reviewerName",
             ri.campaign_name AS "campaignName", ri.product_name AS "productName",
             ri.start_date AS "startDate", ri.end_date AS "endDate", ri.phone8,
             ord.id AS "orderSubmissionId", ord.phone AS "orderPhone", ord.submitted_at AS "orderedAt",
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
        LEFT JOIN review_reminder_states s ON s.order_submission_id = ord.id
       WHERE ri.is_submitted = FALSE
         AND ${SRC('services/reviewObligation.service').unfulfilledSql('ri')}
         AND ri.row_index IS NOT NULL
         AND ($2::int IS NULL OR ord.submitted_at >= NOW() - ($2::int * INTERVAL '1 day'))
         AND ($3::text IS NULL OR (ri.sheet_id = $3 AND ri.tab_name = $4 AND ri.row_index = ANY($5::int[])))
         AND COALESCE(s.review_status, 'pending') = 'pending'
         AND NOT EXISTS (SELECT 1 FROM review_closed_targets closed
           WHERE closed.sheet_id=ri.sheet_id AND closed.tab_name=ri.tab_name AND closed.row_index=ri.row_index)
         AND NOT EXISTS (
           SELECT 1 FROM workdesk_participant_deletions wd
            WHERE wd.order_submission_id = ord.id
               OR (wd.sheet_id = ri.sheet_id AND wd.tab_name = ri.tab_name AND wd.seq = ri.row_index)
         )
       ORDER BY ord.submitted_at, ri.sheet_id, ri.tab_name, ri.row_index
       LIMIT $1`;
}
const OLD_HISTORY_SQL = `SELECT ri.phone8,
            COUNT(*)::int AS joined,
            COUNT(*) FILTER (WHERE ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL)::int AS done,
            COUNT(*) FILTER (WHERE NOT (ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL)
                               AND os.submitted_at IS NOT NULL
                               AND os.submitted_at < NOW() - ($3 || ' days')::interval)::int AS nowrite,
            COUNT(*) FILTER (WHERE NOT (ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL)
                               AND os.submitted_at IS NOT NULL
                               AND os.submitted_at < NOW() - ($2 || ' days')::interval
                               AND os.submitted_at >= NOW() - ($3 || ' days')::interval)::int AS overdue
       FROM review_index ri
       LEFT JOIN order_submissions os
              ON os.sheet_id = ri.sheet_id AND os.tab_name = ri.tab_name
             AND os.sheet_row = ri.row_index AND os.deleted_at IS NULL
      WHERE ri.phone8 = ANY($1)
      GROUP BY ri.phone8`;
function OLD_FLAG_SQL(flag) {
  const unsub = `NOT (ri.is_submitted = TRUE OR ri.review_file_id IS NOT NULL) AND os.submitted_at IS NOT NULL`;
  const cond = flag === 'candidate'
    ? `${unsub} AND os.submitted_at < NOW() - ($1 || ' days')::interval`
    : `${unsub} AND os.submitted_at < NOW() - ($1 || ' days')::interval
                        AND os.submitted_at >= NOW() - ($2 || ' days')::interval`;
  return `SELECT ri.phone8 FROM review_index ri
        LEFT JOIN order_submissions os ON os.sheet_id = ri.sheet_id AND os.tab_name = ri.tab_name
              AND os.sheet_row = ri.row_index AND os.deleted_at IS NULL
        WHERE ${cond}
        GROUP BY ri.phone8 ORDER BY ri.phone8`;
}

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

/* ── 줄 만들기 ── */
let phoneSeq = 10000000;
const ROWS = {};   // key → { tab, row, phone8, sub, visit }
async function addRow(q, key, { tab, row, subDays, visitDays = undefined, slotStatus = 'open' }) {
  const phone8 = String(phoneSeq++);
  await q(`INSERT INTO review_index (reviewer_name, sheet_id, tab_name, row_index, is_submitted, submit_col, row_json, phone8, product_name)
           VALUES ($1, 'S', $2, $3, FALSE, '리뷰', '{"리뷰":""}'::jsonb, $4, '상품')`, ['리뷰어' + key, tab, row, phone8]);
  await q(`INSERT INTO order_submissions (sheet_id, tab_name, sheet_row, phone, submitted_at) VALUES ('S', $1, $2, $3, $4)`,
    [tab, row, '010' + phone8, ago(subDays)]);
  if (visitDays !== undefined && visitDays !== null) {
    await q(`INSERT INTO booking_slots (work_order_id, sheet_id, tab_name, seq, slot_date, date_seq, review_deadline, status)
             VALUES ('wo', 'S', $1, $2, $3::date, $2, ($3::date + 3), $4)`, [tab, row, kstYmd(NOW + visitDays * DAY), slotStatus]);
  }
  await q(`INSERT INTO reviewers (name, phone) VALUES ($1, $2)`, ['리뷰어' + key, '010' + phone8]);
  ROWS[key] = { tab, row, phone8, subDays, visitDays };
}

(async () => {
  const db = await openDb();
  const pool = poolOf(db);
  const q = pool.query;
  // 등록리뷰어DB 라우터·reviewerGate 기본 pool 을 이 DB 로(운영 DB 0)
  const realPool = SRC('db/pool');
  realPool.query = q; realPool.connect = pool.connect;

  const clock = (() => { try { return SRC('utils/reviewClockStart'); } catch (_) { return null; } })();

  /* ── 탭 ── */
  await q(`INSERT INTO tab_configs (sheet_id, tab_name, work_kind) VALUES ('S','리뷰탭',''),('S','블로그탭','blog'),('S','QnA탭','qna'),('S','예약탭','booking')`);
  // 예약탭B = 탭 종류 칸이 비었지만 자리표가 있는 탭(bookingSlots.isBookingTab 과 같은 판정 — 자리표만으로도 예약 탭)

  let r = 1;
  for (const tab of ['리뷰탭', '블로그탭', 'QnA탭']) {
    for (const d of [3, 6.9, 8, 13.5, 14, 15, 15.9, 20, 29, 31, 40]) await addRow(q, `${tab}-${d}`, { tab, row: r++, subDays: d });
  }
  // 예약 줄들
  await addRow(q, 'b1', { tab: '예약탭', row: 101, subDays: 20, visitDays: -8 });    // 방문 8일 전 → 1차(종전: 예약내역 20일 전이라 아예 안 읽음)
  await addRow(q, 'b2', { tab: '예약탭', row: 102, subDays: 9, visitDays: 5 });      // 방문 전(5일 뒤) → 고르지 않음(종전: 1차 나감)
  await addRow(q, 'b3', { tab: '예약탭', row: 103, subDays: 40, visitDays: -10 });   // 방문 10일 → 1차 · 블랙 0(종전: 미작성)
  await addRow(q, 'b4', { tab: '예약탭', row: 104, subDays: 8 });                    // 자리표에 없음(이용일 모름) → 안 보냄 + 로그
  await addRow(q, 'b5', { tab: '예약탭', row: 105, subDays: 50, visitDays: -35 });   // 방문 35일 → 알림 기간 지남 · 미작성
  await addRow(q, 'b6', { tab: '예약탭', row: 106, subDays: 40, visitDays: -20 });   // 방문 20일 → 기한경과(종전: 미작성)
  await addRow(q, 'b7', { tab: '예약탭B', row: 107, subDays: 25, visitDays: -8 });   // 탭 종류 칸 없이 자리표로만 예약 탭 → 1차
  await addRow(q, 'b8', { tab: '예약탭', row: 108, subDays: 40, visitDays: 2 });     // 방문 전 → 고르지 않음 · 블랙 0(종전: 미작성)
  await addRow(q, 'b9', { tab: '예약탭', row: 109, subDays: 10, visitDays: -8, slotStatus: 'cancelled' }); // 취소된 자리 = 이용일 모름
  await addRow(q, 'b10', { tab: '예약탭', row: 110, subDays: 40 });                  // 자리표에 없음 · 오래됨 → 블랙 세지 않음 + 로그
  await addRow(q, 'b11', { tab: '예약탭', row: 111, subDays: 3, visitDays: 0 });     // 오늘 방문 → 아직 1차 아님(not_due)
  const BOOKING_TABS = new Set(['예약탭', '예약탭B']);
  const isBooking = x => BOOKING_TABS.has(x.tabName);
  const keyOf = x => Object.keys(ROWS).find(k => ROWS[k].tab === x.tabName && ROWS[k].row === Number(x.rowIndex));

  const reminder = SRC('services/reviewReminder.service');
  const svc = reminder.createReviewReminderService({ db: pool, provider: {} });
  const config = reminder.getReviewReminderConfig({});
  const lookback = config.scheduleDays[2] + 2;

  console.log('\n[1] 리뷰·블로그·Q&A 줄 = 종전 SQL 과 같은 줄·같은 순서(얼린 원문 대조)');
  const oldRows = (await q(OLD_CANDIDATES_SQL(), [500, lookback, null, null, null])).rows;
  const newRows = await svc.loadCandidates(500, config);
  const sig = x => [x.orderSubmissionId, x.sheetId, x.tabName, x.rowIndex, new Date(x.orderedAt).toISOString(), x.reminderCount, x.reviewStatus, x.hasOpenAttempt].join('|');
  const oldNon = oldRows.filter(x => !isBooking(x)).map(sig);
  const newNon = newRows.filter(x => !isBooking(x)).map(sig);
  t('비예약 후보 줄 수 > 0(시험이 비어 있지 않다)', oldNon.length > 10, oldNon.length);
  t('★ 비예약 후보 = 종전과 같은 줄 · 같은 순서', JSON.stringify(oldNon) === JSON.stringify(newNon), { oldNon, newNon });
  t('비예약 줄의 시작일 = 제출 시각 그대로(clockBasis=submission · clockStartAt=orderedAt)',
    newRows.filter(x => !isBooking(x)).every(x => x.clockBasis === 'submission' && new Date(x.clockStartAt).getTime() === new Date(x.orderedAt).getTime()));
  const now = new Date(NOW);
  const pv = rows => reminder._summarizePreview(rows, now, config).filter(x => !isBooking(x.row))
    .map(x => [x.row.orderSubmissionId, x.reason, x.reminderNo, x.eligibleAt && x.eligibleAt.toISOString(), x.deadline && x.deadline.toISOString()].join('|'));
  t('★ 비예약 발송 판정(사유·회차·발송 가능 시각·제출기한) = 종전 줄 모양(시작일 칸 없음)과 같다', JSON.stringify(pv(oldRows)) === JSON.stringify(pv(newRows)));

  console.log('\n[2] 예약 줄 = 이용일부터 7·13·14일');
  const bk = newRows.filter(isBooking).map(keyOf).sort();
  t('★ 방문 전(b2 5일 뒤 · b8 2일 뒤) 줄은 고르지 않는다', !bk.includes('b2') && !bk.includes('b8'), bk);
  t('★ b1(예약내역 20일 전 · 방문 8일 전)은 이용일 기준이라 읽힌다', bk.includes('b1'), bk);
  t('b5(방문 35일 전)는 알림 기간(이용일+14일)을 지나 읽지 않는다', !bk.includes('b5'), bk);
  const dry = await svc.run({ dryRun: true, now, limit: 500 });
  const dueKeys = dry.items.filter(isBooking).map(keyOf).sort();
  t('★ 예약 발송 대상 = b1·b3·b7(이용일 + 7일 지난 줄)만', JSON.stringify(dueKeys) === JSON.stringify(['b1', 'b3', 'b7']), { dueKeys, skipped: dry.skipped });
  const b1Item = dry.items.find(x => keyOf(x) === 'b1');
  t('b1 = 1차 · 제출기한 = 이용일 + 14일', !!b1Item && b1Item.reminderNo === 1 && b1Item.deadline === kstYmd(NOW - 8 * DAY + 14 * DAY).replace(/-/g, '.'), b1Item);
  t('★ 이용일 모름(b4 자리 없음 · b9 취소된 자리) = 보내지 않음 · 사유 visit_date_unknown',
    dry.skipped.visit_date_unknown === 2 && !dry.items.some(x => ['b4', 'b9'].includes(keyOf(x))), dry.skipped);
  t('★ 이용일 모름은 로그를 남긴다', warns.some(w => /이용일/.test(w) && /visit_date_unknown|안 보냄|보내지 않/.test(w)), warns);
  t('b11(오늘 방문)은 아직 1차 전(not_due)', !dry.items.some(x => keyOf(x) === 'b11'));

  // 시계 앞뒤 — 이용일 + 7일 KST 0시 직전/정각
  const b1Row = newRows.find(x => keyOf(x) === 'b1');
  const visitMid = new Date(kstYmd(NOW - 8 * DAY) + 'T00:00:00+09:00').getTime();
  t('b1 줄을 읽었다(시계 앞뒤 시험 재료)', !!b1Row);
  const at = ms => (b1Row ? reminder._summarizePreview([b1Row], new Date(ms), config)[0] : {});
  t('이용일 + 7일 0시(KST) 1ms 전 = not_due', at(visitMid + 7 * DAY - 1).reason === 'not_due');
  t('이용일 + 7일 0시(KST) 정각 = 1차 가능', at(visitMid + 7 * DAY).reason === null && at(visitMid + 7 * DAY).reminderNo === 1);
  t('이용일 + 13일 = 2차(1차 뒤)', !!b1Row && reminder._summarizePreview([{ ...b1Row, reminderCount: 1, lastRemindedAt: new Date(visitMid + 7 * DAY + 3600000) }], new Date(visitMid + 13 * DAY + 3600000), config)[0].reason === null);
  t('이용일 + 15일 = 알림 기간 지남', at(visitMid + 15 * DAY + 3600000).reason === 'schedule_passed');
  t('이용일 전(시계를 방문 전날로) = visit_not_yet', at(visitMid - 3600000).reason === 'visit_not_yet');
  t('★ 예약 줄인데 시작일이 비면(조회 실패 모양) 제출 시각으로 되돌아가지 않는다',
    !!b1Row && reminder._summarizePreview([{ ...b1Row, clockStartAt: null }], new Date(visitMid + 8 * DAY), config)[0].reason === 'visit_date_unknown');

  console.log('\n[3] 담당자 수동 알림톡 미리보기 — 막힌 사유를 말한다(발송 0)');
  const mp = await svc.manualPreview({ sheetId: 'S', tabName: '예약탭', rowIndexes: [101, 102, 104, 105, 108, 109], now });
  const m = n => mp.byRow.get(n);
  t('b1 = 보낼 수 있음 · 1차', m(101) && m(101).ok === true && m(101).reminderNo === 1, m(101));
  t('★ b2(방문 전) = 막힘 · 「이용일」 전이라는 말', m(102) && m(102).ok === false && /이용일/.test(m(102).reason) && /전/.test(m(102).reason), m(102));
  t('★ b8(방문 전) = 막힘', m(108) && m(108).ok === false && /이용일/.test(m(108).reason), m(108));
  t('★ b4(이용일 모름) = 막힘 · 「이용일」을 확인 못 했다는 말', m(104) && m(104).ok === false && /이용일/.test(m(104).reason) && /확인/.test(m(104).reason), m(104));
  t('b9(취소된 자리) = 막힘', m(109) && m(109).ok === false && /이용일/.test(m(109).reason), m(109));
  t('b5(방문 35일 전) = 알림 기간 지남(문자 안내)', m(105) && m(105).ok === false && /문자/.test(m(105).reason), m(105));

  console.log('\n[4] 블랙리뷰어 집계(기한경과 14일 · 리뷰미작성 30일) — 예약 줄은 이용일부터');
  const keys = Object.keys(ROWS);
  const ann = await SRC('services/reviewerGate.service').annotateReviewerRows(keys.map(k => ({ phone8: ROWS[k].phone8, subPhone8s: [] })), pool);
  const got = Object.fromEntries(keys.map((k, i) => [k, { nowrite: ann[i].stats.nowrite, overdue: ann[i].stats.overdue, joined: ann[i].stats.joined, done: ann[i].stats.done }]));
  const old = new Map((await q(OLD_HISTORY_SQL, [keys.map(k => ROWS[k].phone8), '14', '30'])).rows.map(x => [x.phone8, x]));
  const nonKeys = keys.filter(k => !BOOKING_TABS.has(ROWS[k].tab));
  const diffs = nonKeys.filter(k => { const o = old.get(ROWS[k].phone8) || {}; return o.nowrite !== got[k].nowrite || o.overdue !== got[k].overdue || o.joined !== got[k].joined || o.done !== got[k].done; });
  t('비예약 줄 중 기한경과·미작성이 실제로 있다(시험이 비어 있지 않다)', nonKeys.some(k => got[k].nowrite) && nonKeys.some(k => got[k].overdue));
  t('★ 비예약 집계 = 종전 SQL 과 같다(건수 넷 모두)', diffs.length === 0, diffs.map(k => [k, old.get(ROWS[k].phone8), got[k]]));
  const exp = { b1: [0, 0], b2: [0, 0], b3: [0, 0], b4: [0, 0], b5: [1, 0], b6: [0, 1], b7: [0, 0], b8: [0, 0], b9: [0, 0], b10: [0, 0], b11: [0, 0] };
  for (const [k, [nw, ov]] of Object.entries(exp)) {
    t(`예약 ${k}(예약내역 ${ROWS[k].subDays}일 전 · 이용일 ${ROWS[k].visitDays == null ? '모름' : ROWS[k].visitDays + '일'}) = 미작성 ${nw} · 기한경과 ${ov}`,
      got[k].nowrite === nw && got[k].overdue === ov, { got: got[k], old: old.get(ROWS[k].phone8) });
  }
  t('예약 줄도 누적참여(joined)는 그대로 센다', ['b1', 'b4', 'b10'].every(k => got[k].joined === 1));
  t('★ 이용일 모름(b10) = 세지 않음 + 로그', warns.some(w => /이용일/.test(w) && /reviewerGate|블랙|집계/.test(w)), warns);

  console.log('\n[5] 등록리뷰어DB 필터(🚨 후보 · 기한경과만) — 실제 라우터');
  const router = SRC('routes/trackB.routes');
  const layer = router.stack.find(l => l.route && l.route.path === '/reviewers' && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  async function list(flag) {
    let body = null, err = null;
    await handler({ query: { flag, limit: '200' } }, { json: b => { body = b; } }, e => { err = e; });
    if (err) throw err;
    return new Set(body.items.map(x => x.phone8));
  }
  for (const [flag, params] of [['candidate', ['30']], ['overdue', ['14', '30']]]) {
    const s = await list(flag);
    const oldSet = new Set((await q(OLD_FLAG_SQL(flag), params)).rows.map(x => x.phone8));
    const nonP = nonKeys.map(k => ROWS[k].phone8);
    t(`★ ${flag}: 비예약 리뷰어 = 종전과 같다`, nonP.every(p => s.has(p) === oldSet.has(p)) && nonP.some(p => s.has(p)));
    const bkIn = keys.filter(k => BOOKING_TABS.has(ROWS[k].tab) && s.has(ROWS[k].phone8)).sort();
    const want = flag === 'candidate' ? ['b5'] : ['b6'];
    t(`★ ${flag}: 예약 리뷰어 = 이용일 기준(${want})`, JSON.stringify(bkIn) === JSON.stringify(want), bkIn);
  }

  console.log('\n[6] 정적 — 같은 판정 한 벌(사본 0)');
  const read = p => fs.readFileSync(path.join(SERVER, p), 'utf8');
  const remSrc = read('src/services/reviewReminder.service.js');
  const gateSrc = read('src/services/reviewerGate.service.js');
  const tbSrc = read('src/routes/trackB.routes.js');
  t('알림톡 후보 SQL 이 시작일 단일 출처를 쓴다', /reviewClockStart[\s\S]{0,80}clockStartLateralSql/.test(remSrc));
  t('블랙 집계 SQL 이 시작일 단일 출처를 쓴다', /clockStartLateralSql/.test(gateSrc));
  t('등록리뷰어DB 필터 SQL 이 시작일 단일 출처를 쓴다', /clockStartLateralSql/.test(tbSrc));
  t('booking_slots 를 직접 읽는 시작일 사본이 세 곳에 없다', !/booking_slots/.test(remSrc) && !/booking_slots/.test(gateSrc) && !/slot_date/.test(tbSrc));
  t('예약 탭 판정 SQL = bookingSlots.isBookingTab 과 한 벌', /bookingTabSql/.test(read('src/services/bookingSlots.service.js')) && (() => { try { return /bookingTabSql/.test(read('src/utils/reviewClockStart.js')); } catch (_) { return false; } })());

  console.log('\n[7] 단일 출처 — 종류별 시작일 기준');
  t('reviewClockStart 모듈이 있다(종류별 시작일 판정 단일 출처)', !!clock);
  if (clock) t('booking = 이용일(visit_date)', clock.clockStartBasis('booking') === 'visit_date');
  for (const k of ['review', 'blog', 'qna', 'receipt', '', null, '모르는값', '블로그체험단', 'Q&A체험단', '영수증리뷰']) {
    if (clock) t(`${JSON.stringify(k)} = 제출 시각(submission) — 종전 그대로`, clock.clockStartBasis(k) === 'submission');
  }
  if (clock) t('사람이 적은 표기 「네이버예약리뷰」도 booking 으로 읽는다(workKind 단일 출처)', clock.clockStartBasis('네이버예약리뷰') === 'visit_date');

  if (softFails.length) { console.log(`\n✗ ${softFails.length} failed (soft)`); process.exit(1); }
  console.log(`\n${pass} booking review clock-start checks passed`);
})().catch(err => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
