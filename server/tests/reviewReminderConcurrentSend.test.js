'use strict';
/**
 * 결정 365 — 리뷰 미작성 알림톡: 같은 리뷰어(주문)·같은 회차를 두 요청이 동시에 보내도 공급자는 한 번만.
 *
 * 무엇을 막나:
 *   reviewReminder.sendManual / run(크론) 은 「미리보기(회차·결과 확인 중·재시도 대기)」 뒤 sendOne 이
 *   원장 줄(review_reminder_deliveries)을 넣기까지 잠금이 없었다. 두 담당자가 같은 줄을 동시에(키가 다르거나,
 *   구버전 화면이라 키가 없거나), 또는 크론과 담당자가 동시에 보내면
 *     ㉮ 앞 줄이 'accepted' → 기존 부분 유일 색인이 23505 를 던져 둘째 요청이 통째로 서버 오류
 *     ㉯ 앞 줄이 바로 거절(failed) → 둘째가 또 공급자를 부름(재시도 대기 무시)
 *     ㉰ 앞 줄이 그 사이 도착 확인(delivered) → 둘째가 같은 회차를 또 보냄
 *   고친 뒤: sendOne 이 그 주문의 상태 줄을 잠그고(짧은 트랜잭션) 「미리보기 뒤 바뀐 것」을 다시 본 뒤 원장 줄을
 *   넣고 COMMIT → 공급자 호출은 잠금 밖. 둘째는 공급자 0 + 한국어 사유.
 *
 * 무엇으로 확인하나:
 *   A. 실제 SQL(PGlite · migration 160·171·222) + 실제 manualMessage/reviewReminder 서비스 + 공급자 흉내(호출 수).
 *      PGlite 는 연결 하나라, 트랜잭션은 BEGIN~COMMIT 동안 연결을 독점하게 줄을 세운다(행 잠금이 하는 일의 모형).
 *      두 요청이 둘 다 미리보기를 끝낸 뒤에 보내기 단계에 들어가게 장벽을 둔다(= 가장 나쁜 겹침).
 *   B. 정적 가드 — 잠금·재확인·원장 줄이 공급자 호출 앞, 공급자 호출은 COMMIT 뒤 · 새 사유 코드마다 한국어.
 *   C. (선택) 실제 PostgreSQL 동시 접속 — REMINDER_LOCK_NATIVE_PG_TEST=1 일 때만: 둘째가 첫째의 잠금을 실제로 기다린다.
 * 실행: node tests/reviewReminderConcurrentSend.test.js
 * ★ 실제 발송 업체·운영 DB 는 절대 부르지 않는다(공급자 함수는 흉내, fetch 는 막음, DB 주소는 닫힌 포트).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

for (const k of ['DATABASE_PUBLIC_URL', 'SOLAPI_API_KEY', 'SOLAPI_API_SECRET']) delete process.env[k];
process.env.DATABASE_URL = 'postgres://u:x@127.0.0.1:1/none';
globalThis.fetch = async () => { throw new Error('외부 호출 금지(테스트)'); };

const SERVER = path.resolve(__dirname, '..');
const MIG = (f) => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8');

let passed = 0;
const failed = [];   // REMINDER_LOCK_SOFT=1 = 실패해도 끝까지 돌려 전부 보여준다(고치기 전 RED 확인용)
function ok(name, cond, extra) {
  if (!cond && process.env.REMINDER_LOCK_SOFT === '1') { failed.push(name); console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); return; }
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓ ' + name);
}

const pool = require(path.join(SERVER, 'src/db/pool'));
const { logger } = require(path.join(SERVER, 'src/utils/logger'));
const warns = [];
logger.warn = (m) => warns.push(String(m));
logger.info = () => {};

// ── 공급자 흉내(실제 발송 업체는 절대 부르지 않는다) ──
const solapi = require(path.join(SERVER, 'src/services/solapi.service'));
solapi.getSolapiStatus = () => ({ configured: true, missing: [] });
solapi._config = () => ({ templateIds: { 1: 'tpl1', 2: 'tpl2', 3: 'tpl3' } });
solapi.sendSms = async () => { throw new Error('이 테스트에서 문자는 부르지 않는다'); };
const calls = [];          // 공급자까지 간 알림톡
let sendImpl = null;
solapi.sendReviewAlimTalk = async (a) => {
  calls.push(a);
  if (sendImpl) return sendImpl(a);
  return { accepted: true, messageId: 'mx' + calls.length, groupId: 'g', statusCode: '2000', reason: '' };
};
let statusImpl = async () => ({ complete: false });
solapi.getMessageStatus = async (id) => statusImpl(id);
solapi.getAccountBilling = async () => { throw new Error('단가 조회는 발송 경로에서 부르지 않는다'); };

const obligation = require(path.join(SERVER, 'src/services/reviewObligation.service'));
obligation.isFulfilled = async () => false;
obligation.canRemind = async () => true;

const reminder = require(path.join(SERVER, 'src/services/reviewReminder.service'));
const svc = require(path.join(SERVER, 'src/services/manualMessage.service'));

// ── DB: 후보 조회만 같은 뜻의 작은 SQL 로 바꾼다(LATERAL 원본은 표가 많다) — 회차·결과 확인 중·마지막 시도 시각은
//    실제 원장 표에서 원본과 같은 식으로 계산하므로 「미리보기가 본 낡은 값」이 그대로 재현된다. ──
const CAND_SQL = `
  SELECT f.review_index_id AS "reviewIndexId", 'S' AS "sheetId", 'T' AS "tabName", f.row_index AS "rowIndex",
         f.name AS "reviewerName", NULL AS "campaignName", '상품' AS "productName", NULL AS "startDate", NULL AS "endDate",
         f.phone8, f.order_id AS "orderSubmissionId", f.phone AS "orderPhone", f.ordered_at AS "orderedAt",
         COALESCE(s.review_status, 'pending') AS "reviewStatus", COALESCE(s.reminder_count, 0)::int AS "reminderCount",
         s.last_reminded_at AS "lastRemindedAt", s.final_due_at AS "finalDueAt",
         EXISTS (SELECT 1 FROM review_reminder_deliveries d WHERE d.order_submission_id = f.order_id
                    AND d.reminder_no = COALESCE(s.reminder_count, 0) + 1 AND d.provider_status = 'accepted') AS "hasOpenAttempt",
         (SELECT MAX(d.requested_at) FROM review_reminder_deliveries d WHERE d.order_submission_id = f.order_id
             AND d.reminder_no = COALESCE(s.reminder_count, 0) + 1) AS "latestAttemptAt"
    FROM fx_rows f LEFT JOIN review_reminder_states s ON s.order_submission_id = f.order_id
   WHERE ($1::text IS NULL OR f.row_index = ANY($2::int[])) AND COALESCE(s.review_status, 'pending') = 'pending'
   ORDER BY f.row_index`;
function route(sql, params) {
  const s = String(sql);
  if (/FROM review_index ri\s+JOIN LATERAL/.test(s)) return { sql: CAND_SQL, params: [params[2], params[4] || []], cand: true };
  // 크론의 제출·종결 정리는 이 경합과 무관(표가 많다) — 0건으로 둔다.
  if (/SET review_status = 'submitted', review_index_id = ri\.id/.test(s)) return { fixed: { rows: [], rowCount: 0 } };
  if (/three_delivered_reminders_final_due_passed/.test(s)) return { fixed: { rows: [], rowCount: 0 } };
  return { sql: s, params };
}

let hook = null;   // async (sql) => void — 겹침 연출·오류 주입
let db = null;
let chain = Promise.resolve();
function lock() { let release; const p = new Promise((r) => { release = r; }); const prev = chain; chain = prev.then(() => p); return prev.then(() => release); }
async function exec(sql, params) {
  const r = route(sql, params);
  if (r.fixed) return r.fixed;
  const out = await db.query(r.sql, r.params);
  return { ...out, rowCount: out.affectedRows };
}
pool.query = async (sql, params) => {
  if (hook) await hook(String(sql), 'pool');
  const rel = await lock();
  try { return await exec(sql, params); } finally { rel(); }
};
pool.connect = async () => {
  let held = null;
  const client = {
    async query(sql, params) {
      const s = String(sql).trim();
      if (/^BEGIN/i.test(s) && !held) held = await lock();
      if (hook) await hook(s, 'tx');
      const rel = held ? null : await lock();
      try { return await exec(sql, params); }
      finally {
        if (rel) rel();
        if (/^(COMMIT|ROLLBACK)/i.test(s) && held) { const h = held; held = null; h(); }
      }
    },
    release() { if (held) { const h = held; held = null; h(); } },
  };
  return client;
};

const ORDER1 = '11111111-1111-4111-8111-111111111111';
const ORDER2 = '22222222-2222-4222-8222-222222222222';
const RI1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const RI2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const K1 = '11111111-2222-4333-8444-555555555555';
const K2 = '99999999-2222-4333-8444-555555555555';
const SCHEMA = `
  CREATE TABLE order_submissions (id UUID PRIMARY KEY, deleted_at TIMESTAMPTZ);
  CREATE TABLE review_index (id UUID PRIMARY KEY, sheet_id TEXT, tab_name TEXT, row_index INT, is_submitted BOOLEAN DEFAULT FALSE);
  CREATE TABLE review_closed_targets (sheet_id TEXT, tab_name TEXT, row_index INT, resolution_id UUID, order_submission_id UUID,
    closed_at TIMESTAMPTZ, close_reason TEXT, review_status TEXT);
  CREATE TABLE campaign_participants (id TEXT PRIMARY KEY, seq INT, reviewer_name TEXT, sheet_id TEXT, tab_name TEXT,
    deleted_at TIMESTAMPTZ, active BOOLEAN DEFAULT TRUE);
  CREATE TABLE fx_rows (row_index INT, review_index_id UUID, order_id UUID, name TEXT, phone TEXT, phone8 TEXT, ordered_at TIMESTAMPTZ);`;
async function seed(q) {
  // 구매 8일 전 → 1차는 날짜가 됐다(크론도 보냄) · 2차는 아직(담당자는 앞당겨 보낼 수 있음).
  const orderedAt = new Date(Date.now() - 8 * 86400000);
  for (const [o, ri, seq, name, phone] of [[ORDER1, RI1, 1, '김하나', '01011110001'], [ORDER2, RI2, 2, '이둘', '01011110002']]) {
    await q(`INSERT INTO order_submissions (id) VALUES ($1)`, [o]);
    await q(`INSERT INTO review_index (id, sheet_id, tab_name, row_index) VALUES ($1,'S','T',$2)`, [ri, seq]);
    await q(`INSERT INTO campaign_participants (id, seq, reviewer_name, sheet_id, tab_name) VALUES ($1,$2,$3,'S','T')`, ['p' + seq, seq, name]);
    await q(`INSERT INTO fx_rows VALUES ($1,$2,$3,$4,$5,$6,$7)`, [seq, ri, o, name, phone, phone.slice(-8), orderedAt]);
  }
}
async function freshDb() {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG('160_review_reminder_alimtalk.sql'));
  await db.exec(MIG('171_manual_message_sends.sql'));
  await db.exec(MIG('222_manual_message_send_client_id.sql'));
  await seed((s, p) => db.query(s, p));
  calls.length = 0; warns.length = 0; hook = null; sendImpl = null;
  statusImpl = async () => ({ complete: false });
}
const q = async (s, p) => (await db.query(s, p)).rows;
const deliveries = () => q(`SELECT order_submission_id AS o, reminder_no AS n, attempt_no AS a, provider_status AS st FROM review_reminder_deliveries ORDER BY requested_at, attempt_no`);

/** 두 요청 모두 후보 조회(미리보기)를 끝낸 뒤에야 보내기 단계로 넘어가게 하는 장벽. */
function candBarrier(n = 2) {
  let arrived = 0, open;
  const opened = new Promise((r) => { open = r; });
  return async (sql) => {
    if (!/FROM review_index ri\s+JOIN LATERAL/.test(sql)) return;
    if (++arrived >= n) open();
    await opened;
  };
}
const sendAta = (o) => svc.sendManualAlimtalk({ sheetId: 'S', tabName: 'T', ids: ['p1'], by: '망고', ...o });
const OTHER = /다른 담당자\(또는 자동 알림\)가 방금 이 회차 알림톡을 보냈습니다/;
const settle = (ps) => Promise.allSettled(ps).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { thrown: r.reason && (r.reason.code || r.reason.message) })));

(async () => {
  console.log('A. 실제 SQL + 실제 서비스 + 공급자 흉내');

  // A1 — 두 담당자, 키가 다름(새 화면 두 대)
  await freshDb();
  hook = candBarrier(2);
  let [a, b] = await settle([sendAta({ clientSendId: K1 }), sendAta({ clientSendId: K2, by: '만두' })]);
  hook = null;
  let rs = [a, b].map((x) => x.results && x.results[0]);
  ok('[키 다름 · 동시] 공급자 1번 · 둘 다 서버 오류 없이 결과 · 하나는 보냄 · 하나는 「다른 담당자가 방금」',
    calls.length === 1 && rs.every(Boolean) && rs.filter((r) => r.sent).length === 1 && rs.some((r) => !r.sent && OTHER.test(r.reason)), { calls: calls.length, a, b });
  let ms = await q(`SELECT client_send_id AS k, send_state AS st FROM manual_message_sends ORDER BY created_at`);
  ok('[키 다름 · 동시] 진 쪽 선점 줄은 풀린다(그 키가 「처리 중」으로 갇히지 않음 · 364 ⑥ 그대로) · 이긴 쪽만 sent', ms.length === 1 && ms[0].st === 'sent', ms);
  ok('[키 다름 · 동시] 원장 1줄(1차 1회)', (await deliveries()).length === 1);

  // A2 — 구버전 화면(키 없음) + 새 화면(키) 동시
  await freshDb();
  hook = candBarrier(2);
  [a, b] = await settle([sendAta({}), sendAta({ clientSendId: K1, by: '만두' })]);
  hook = null;
  rs = [a, b].map((x) => x.results && x.results[0]);
  ok('[키 없음 + 키 · 동시] 공급자 1번 · 진 쪽 「다른 담당자가 방금」', calls.length === 1 && rs.every(Boolean) && rs.filter((r) => r.sent).length === 1 && rs.some((r) => !r.sent && OTHER.test(r.reason)), { a, b });

  // A3 — 구버전 화면 두 창(둘 다 키 없음)
  await freshDb();
  hook = candBarrier(2);
  [a, b] = await settle([sendAta({}), sendAta({ by: '만두' })]);
  hook = null;
  rs = [a, b].map((x) => x.results && x.results[0]);
  ok('[키 없음 둘 · 동시] 공급자 1번 · 진 쪽 「다른 담당자가 방금」', calls.length === 1 && rs.every(Boolean) && rs.some((r) => !r.sent && OTHER.test(r.reason)), { a, b });
  ms = await q(`SELECT COUNT(*)::int AS n FROM manual_message_sends`);
  ok('[키 없음 둘 · 동시] 발송 기록도 1줄(보내지 않은 쪽은 종전처럼 기록 없음)', ms[0].n === 1, ms);

  // A4 — 앞 요청이 공급자에게 바로 거절됨 → 둘째는 재시도 대기를 무시하고 또 부르면 안 된다
  await freshDb();
  sendImpl = async () => ({ accepted: false, messageId: null, groupId: null, statusCode: '3059', reason: '거절' });
  hook = candBarrier(2);
  [a, b] = await settle([sendAta({ clientSendId: K1 }), sendAta({ clientSendId: K2, by: '만두' })]);
  hook = null;
  rs = [a, b].map((x) => x.results && x.results[0]);
  ok('[앞 요청 즉시 거절 · 동시] 공급자 1번(둘째가 또 부르지 않음)', calls.length === 1 && rs.some((r) => r && OTHER.test(r.reason || '')), { calls: calls.length, a, b });

  // A5 — 앞 요청이 그 사이 「도착」 확인까지 됨 → 둘째가 같은 회차를 또 보내면 안 된다
  await freshDb();
  {
    let isSub = 0, openB;
    const bGate = new Promise((r) => { openB = r; });
    const barrier = candBarrier(2);
    hook = async (sql) => {
      await barrier(sql);
      if (/SELECT is_submitted FROM review_index/.test(sql) && ++isSub === 2) await bGate;
    };
    const pA = sendAta({ clientSendId: K1 });
    const pB = sendAta({ clientSendId: K2, by: '만두' });
    const rA = await pA;
    statusImpl = async () => ({ complete: true, success: true, statusCode: '4000', reason: '정상' });
    const rec = await reminder.reconcileAccepted(new Date());
    openB();
    const rB = await pB.catch((e) => ({ thrown: e.code || e.message }));
    hook = null;
    const st = await q(`SELECT reminder_count::int AS c FROM review_reminder_states`);
    ok('[앞 요청 도착 확인 뒤 둘째 · 동시] 공급자 1번 · 회차는 1 · 둘째 「다른 담당자가 방금」',
      rec.delivered === 1 && calls.length === 1 && st[0].c === 1 && rA.results[0].sent && !!rB.results && OTHER.test(rB.results[0].reason), { rec, calls: calls.length, rB });
  }

  // A6 — 크론(자동 알림)과 담당자 수동이 같은 줄을 동시에
  await freshDb();
  process.env.REVIEW_REMINDER_ENABLED = '1';
  hook = candBarrier(2);
  let [cr, mn] = await settle([reminder.run({ dryRun: false, now: new Date(), limit: 10 }), sendAta({ ids: ['p1'], clientSendId: K1 })]);
  hook = null;
  delete process.env.REVIEW_REMINDER_ENABLED;
  let dv = await deliveries();
  const o1 = dv.filter((d) => d.o === ORDER1);
  ok('[크론 + 수동 · 동시] 줄1 은 1차 한 번만(공급자 호출도 그 줄 1번) · 크론·수동 둘 다 오류 없이 끝남',
    !cr.thrown && !mn.thrown && o1.length === 1 && calls.filter((c) => c.customFields.orderSubmissionId === ORDER1).length === 1,
    { cr, mn, dv, calls: calls.map((c) => c.customFields.orderSubmissionId) });
  ok('[크론 + 수동 · 동시] 크론은 다른 줄(줄2)은 그대로 보낸다', dv.some((d) => d.o === ORDER2) && cr.skippedBeforeSend + cr.sent >= 2, cr);

  // A7 — 여러 줄 묶음: 한 줄이 겹쳐도 같은 요청의 다른 줄은 나간다(종전: 겹친 줄에서 통째로 서버 오류)
  await freshDb();
  hook = candBarrier(2);
  [a, b] = await settle([sendAta({ ids: ['p1'], clientSendId: K1 }), sendAta({ ids: ['p1', 'p2'], clientSendId: K2, by: '만두' })]);
  hook = null;
  ok('[묶음 · 동시] 줄1 공급자 1번 · 줄2 공급자 1번 · 묶음 요청은 줄2 보냄',
    calls.length === 2 && b.results && b.results.find((r) => r.participantId === 'p2').sent === true, { a, b });

  // A8 — 순서대로(겹침 없음): 1차 도착 확인 뒤 담당자가 새로 열어 보내면 2차는 규칙대로 나간다
  await freshDb();
  let r1 = await sendAta({ clientSendId: K1 });
  statusImpl = async () => ({ complete: true, success: true, statusCode: '4000', reason: '정상' });
  let r2 = await sendAta({ clientSendId: K2, by: '만두' });
  dv = await deliveries();
  ok('[순서대로] 1차 도착 뒤 새 발송 = 2차가 나간다(정당한 다음 회차는 그대로)',
    r1.results[0].sent && r2.results[0].sent && r2.results[0].reminderNo === 2 && calls.length === 2 && dv.map((d) => d.n).join() === '1,2', { r2, dv });

  // A9 — 잠금 대기 초과(55P03) → 보내지 않고 안내 · 원장 줄 0 · 다음 발송은 정상
  await freshDb();
  hook = async (sql) => { if (/FROM review_reminder_states[\s\S]*FOR UPDATE/.test(sql)) { hook = null; const e = new Error('lock timeout'); e.code = '55P03'; throw e; } };
  r1 = await sendAta({ clientSendId: K1 });
  ok('[잠금 대기 초과] 공급자 0 · 「같은 리뷰어에게 다른 알림톡을 보내는 중」 · 원장 0',
    calls.length === 0 && !r1.results[0].sent && /같은 리뷰어에게 다른 알림톡을 보내는 중입니다/.test(r1.results[0].reason) && (await deliveries()).length === 0, r1);
  r2 = await sendAta({ clientSendId: K1 });
  ok('[잠금 대기 초과 뒤] 같은 키로 다시 보내면 정상 발송(선점이 풀려 있다)', calls.length === 1 && r2.results[0].sent, r2);

  // A10 — 원장 줄 INSERT 가 유일 색인에 걸리면(23505) 던지지 않고 「다른 담당자가 방금」
  await freshDb();
  hook = async (sql) => { if (/INSERT INTO review_reminder_deliveries/.test(sql)) { hook = null; const e = new Error('dup'); e.code = '23505'; throw e; } };
  r1 = await sendAta({});
  ok('[원장 유일 충돌] 공급자 0 · 서버 오류 없이 「다른 담당자가 방금」', calls.length === 0 && OTHER.test(r1.results[0].reason), r1);

  // A11 — 그 밖의 DB 오류(잠금 안에서)는 종전처럼 던진다(공급자 0 · 원장 0)
  await freshDb();
  hook = async (sql) => { if (/FROM review_reminder_states[\s\S]*FOR UPDATE/.test(sql)) { hook = null; throw Object.assign(new Error('boom'), { code: 'XX000' }); } };
  r1 = await sendAta({}).then((v) => ({ v }), (e) => ({ thrown: e.message }));
  ok('[그 밖 DB 오류] 종전처럼 실패로 올라간다 · 공급자 0 · 원장 0', r1.thrown === 'boom' && calls.length === 0 && (await deliveries()).length === 0, r1);

  console.log('B. 정적 가드');
  const src = fs.readFileSync(path.join(SERVER, 'src/services/reviewReminder.service.js'), 'utf8');
  const body = src.slice(src.indexOf('async function _claimDelivery('), src.indexOf('async function run('));
  const at = (re) => { const m = re.exec(body); return m ? m.index : -1; };
  const iBegin = at(/query\('BEGIN'\)/), iLock = at(/FOR UPDATE/), iIns = at(/INSERT INTO review_reminder_deliveries/),
    iCommit = at(/query\('COMMIT'\)/), iProv = at(/provider\.sendReviewAlimTalk\(/);
  ok('★ 잠금(FOR UPDATE) → 재확인 → 원장 INSERT → COMMIT → 공급자 호출 순서(공급자는 잠금 밖)',
    iBegin > -1 && iBegin < iLock && iLock < iIns && iIns < iCommit && iCommit < iProv, { iBegin, iLock, iIns, iCommit, iProv });
  ok('★ 잠금 대기 상한(lock_timeout)이 트랜잭션 안에 있다', /SET LOCAL lock_timeout/.test(body));
  const sendOneBody = src.slice(src.indexOf('async function sendOne('), src.indexOf('async function run('));
  ok('★ sendOne 은 _claimDelivery(잠금 안 선점) 뒤에만 공급자를 부르고, 원장 줄을 따로 넣지 않는다',
    sendOneBody.indexOf('_claimDelivery(') > -1 && sendOneBody.indexOf('_claimDelivery(') < sendOneBody.indexOf('provider.sendReviewAlimTalk(')
      && !/INSERT INTO review_reminder_deliveries/.test(sendOneBody));
  ok('★ 잠금 안 재확인 = 회차 바뀜 · 이 회차 접수/도착 줄 · 미리보기 뒤 새 시도(셋 다)',
    /count !== reminderNo - 1/.test(body) && /provider_status IN \('accepted','delivered'\)/.test(body) && /nowAt > seenAt/.test(body));
  const codes = [...new Set([...src.matchAll(/'([a-z_]+_before_send)'/g)].map((m) => m[1]))];
  const mm = fs.readFileSync(path.join(SERVER, 'src/services/manualMessage.service.js'), 'utf8');
  const sendReason = mm.slice(mm.indexOf('const SEND_REASON'), mm.indexOf('};', mm.indexOf('const SEND_REASON')));
  const missing = codes.filter((c) => !new RegExp('\\b' + c + ':').test(sendReason));
  ok('발송 직전 사유 코드마다 화면용 한국어가 있다(코드가 화면에 그대로 나가지 않음)', codes.length >= 7 && missing.length === 0, { codes, missing });

  if (process.env.REMINDER_LOCK_NATIVE_PG_TEST === '1') {
    console.log('C. 실제 PostgreSQL 동시 접속');
    const { startNativeCaptureDatabase, gate, waitUntilBlocked } = require('./helpers/captureNativePgFixture');
    const cluster = await startNativeCaptureDatabase();
    const savedQuery = pool.query, savedConnect = pool.connect;
    try {
      const nq = (s, p) => cluster.pool.query(s, p);
      await cluster.pool.query(SCHEMA);
      for (const f of ['160_review_reminder_alimtalk.sql', '171_manual_message_sends.sql', '222_manual_message_send_client_id.sql']) await cluster.pool.query(MIG(f));
      await seed(nq);
      calls.length = 0; sendImpl = null; statusImpl = async () => ({ complete: false });
      const nexec = (runner) => (sql, params) => { const r = route(sql, params); return r.fixed ? r.fixed : runner(r.sql, r.params); };
      const g = gate();
      let holdFirst = true, firstPid = null;
      const pids = [];
      pool.query = nexec(nq);
      pool.connect = async () => {
        const c = await cluster.pool.connect();
        pids.push(c.processID);
        const run = nexec((s, p) => c.query(s, p));
        return {
          async query(sql, params) {
            const out = await run(sql, params);
            if (holdFirst && /FROM review_reminder_states[\s\S]*FOR UPDATE/.test(String(sql))) { holdFirst = false; firstPid = c.processID; await g.promise; }
            return out;
          },
          release: () => c.release(),
        };
      };
      const pA = sendAta({ clientSendId: K1 });
      while (!firstPid) await new Promise((r) => setTimeout(r, 10));
      const pB = sendAta({ clientSendId: K2, by: '만두' });
      while (pids.length < 2) await new Promise((r) => setTimeout(r, 10));
      await waitUntilBlocked(cluster.pool, pids[1], firstPid);
      ok('[실 PG] 둘째 발송이 첫째의 상태 줄 잠금을 실제로 기다린다(pg_blocking_pids)', true);
      g.resolve();
      const [ra, rb] = await Promise.all([pA, pB]);
      const n = (await cluster.pool.query(`SELECT COUNT(*)::int n FROM review_reminder_deliveries`)).rows[0].n;
      ok('[실 PG] 동시 두 발송 → 공급자 1번 · 원장 1줄 · 둘째 「다른 담당자가 방금」',
        calls.length === 1 && n === 1 && ra.results[0].sent && OTHER.test(rb.results[0].reason), { calls: calls.length, n, ra, rb });
    } finally {
      pool.query = savedQuery; pool.connect = savedConnect;
      await cluster.close();
    }
  } else {
    console.log('  ⏭ 실 PostgreSQL 동시 접속(C)은 REMINDER_LOCK_NATIVE_PG_TEST=1 일 때만');
  }

  if (failed.length) { console.log(`\n❌ reviewReminderConcurrentSend: ${failed.length}개 실패 · ${passed}개 통과`); process.exit(1); }
  console.log(`\n✅ reviewReminderConcurrentSend: ${passed}개 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌', e && e.stack ? e.stack : e); process.exit(1); });
