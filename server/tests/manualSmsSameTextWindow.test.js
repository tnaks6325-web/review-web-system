'use strict';
/**
 * manualSmsSameTextWindow.test.js — 결정 366 회귀가드 (스키마 변경 0 · migration 171·222 재사용)
 * 「작업보드 수동 문자 — 같은 번호로 같은 글을 10분(설정) 안에 다시 보내지 않는다. 두 담당자가 동시에 눌러도 공급자는 한 번」
 *
 *   A. 실제 라우트 POST /workdesk/manual-send(trackB) + 실제 SQL(PGlite) + 공급자 흉내(호출 수를 센다)
 *      - 같은 번호·같은 글·창 안 = 막음(키가 달라도 · 키 없어도 · 다른 담당자여도) · 공백/줄바꿈 차이는 같은 글
 *      - 다른 글 = 보냄 · 창 지남 = 보냄 · 앞선 확실한 실패 = 보냄 · 앞선 결과 모름 = 막음 · 설정 0 = 규칙 끔
 *      - 동시에 두 요청(키 다름) = 공급자 1번 · 여러 명 중 막힌 사람만 빠짐 · 같은 키 다시 보내기는 364 duplicate 우선
 *      - 같은 번호의 다른 참여 줄(타계정)도 막음 · 번호 모양(하이픈) 무관 · 종전 기록(send_state 없음) accepted 만 막음
 *      - 잠금 대기 초과(55P03) = 보내지 않음 + 한국어 · 창 조회 실패 = 보내지 않음(fail-closed) · 222 전 DB = 종전 경로
 *   B. 문구·설정 단위 · 정적 순서 가드(잠금 → 창 판정 → 선점 → COMMIT, 공급자 호출은 선점 뒤)
 *   C. (선택) 실제 PostgreSQL 동시 접속 — SMS_WINDOW_NATIVE_PG_TEST=1 일 때만:
 *      둘째가 첫째의 번호 잠금을 실제로 기다린다(pg_blocking_pids) → 공급자 1번 · 잠금 5초 초과 = 「처리 중」(55P03)
 * 실행: node tests/manualSmsSameTextWindow.test.js
 * ★ 실제 발송 업체·운영 DB 는 절대 부르지 않는다(공급자 함수는 흉내, fetch 는 막음, DB 주소는 닫힌 포트).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

for (const k of ['DATABASE_PUBLIC_URL', 'SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'MANUAL_SMS_SAME_TEXT_WINDOW_MIN']) delete process.env[k];
process.env.DATABASE_URL = 'postgres://u:***@127.0.0.1:1/none';
globalThis.fetch = async () => { throw new Error('외부 호출 금지(테스트)'); };

const SERVER = path.resolve(__dirname, '..');
const MIG = (f) => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8');

let passed = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : ''));
  passed++;
  console.log('  ✓ ' + name);
}

const pool = require(path.join(SERVER, 'src/db/pool'));
const { logger } = require(path.join(SERVER, 'src/utils/logger'));
const warns = [];
logger.warn = (m) => warns.push(String(m));
logger.info = () => {};

/* ── DB: PGlite = 연결 하나. 트랜잭션은 BEGIN~COMMIT 동안 연결을 독점하게 줄을 세운다(번호 잠금이 하는 일의 모형). ── */
let db = null;
let chain = Promise.resolve();
function lock() { let release; const p = new Promise((r) => { release = r; }); const prev = chain; chain = prev.then(() => p); return prev.then(() => release); }
let failNext = null;   // (sql) => Error | null — 한 번 실패 주입
let hook = null;       // async (sql) => void — 겹침 연출
pool.query = async (sql, params) => {
  if (failNext) { const e = failNext(String(sql)); if (e) { failNext = null; throw e; } }
  const rel = await lock(); try { return await db.query(sql, params); } finally { rel(); }
};
pool.connect = async () => {
  let held = null;
  return {
    async query(sql, params) {
      const s = String(sql).trim();
      if (failNext) { const e = failNext(s); if (e) { failNext = null; throw e; } }
      if (/^BEGIN/i.test(s) && !held) held = await lock();
      const rel = held ? null : await lock();
      try { const out = await db.query(sql, params); if (hook) await hook(s); return out; }
      finally {
        if (rel) rel();
        if (/^(COMMIT|ROLLBACK)/i.test(s) && held) { const h = held; held = null; h(); }
      }
    },
    release() { if (held) { const h = held; held = null; h(); } },
  };
};

/* ── 공급자·주변 흉내(실제 발송 업체는 절대 부르지 않는다) ── */
const solapi = require(path.join(SERVER, 'src/services/solapi.service'));
solapi.getSolapiStatus = () => ({ configured: true, missing: [] });
solapi.getAccountBilling = async () => { throw new Error('단가 조회는 발송 경로에서 부르면 안 된다'); };
solapi.sendReviewAlimTalk = async () => { throw new Error('이 테스트에서 알림톡은 부르지 않는다'); };
const smsCalls = [];
let smsImpl = async () => ({ accepted: true, messageId: 'm' + smsCalls.length, type: 'LMS' });
solapi.sendSms = async (a) => { smsCalls.push(a); return smsImpl(a); };
const csBridge = require(path.join(SERVER, 'src/services/csBridge.service'));
const rooms = [];
csBridge.postAdminNotice = async (a) => { rooms.push(a); return { threadId: 't-' + a.phone8 }; };
const contact = require(path.join(SERVER, 'src/services/reviewerContact.service'));
let contacts = [];
let contactGate = null;   // async () => void — 미리보기(받는 사람 판정) 중간에 멈춰 겹침을 만든다
// ★ 서비스가 불러올 때 함수를 꺼내 가므로(구조 분해) 이 흉내는 서비스보다 먼저, 한 번만 단다.
contact.reviewerContactsForRows = async ({ participantIds }) => {
  if (contactGate) await contactGate();
  return { items: contacts.filter(c => participantIds.includes(c.participantId)) };
};
const reminder = require(path.join(SERVER, 'src/services/reviewReminder.service'));
reminder.manualPreview = async () => ({ byRow: new Map() });

const svc = require(path.join(SERVER, 'src/services/manualMessage.service'));
const tbRouter = require(path.join(SERVER, 'src/routes/trackB.routes'));
const layer = tbRouter.stack.find((l) => l.route && l.route.path === '/workdesk/manual-send' && l.route.methods.post);
assert.ok(layer, '/workdesk/manual-send 라우트 없음');
function send(body, admin) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    Promise.resolve(handler({ body, admin: admin || { role: 'staff', name: '망고' } }, res, (e) => (e ? reject(e) : resolve({ status: 404 })))).catch(reject);
  });
}

const S = 'sheet-1', T = '탭A';
const CPS = [
  { id: 'p1', seq: 1, name: '김하나', phone: '01011110001' },
  { id: 'p2', seq: 2, name: '이둘', phone: '01011110002' },
  { id: 'p3', seq: 3, name: '박셋', phone: '01011110003' },
  { id: 'p4', seq: 4, name: '김하나', phone: '01011110001' },   // p1 과 같은 번호(타계정 줄)
];
const BASE_SCHEMA = `CREATE TABLE campaign_participants (id TEXT PRIMARY KEY, seq INT, reviewer_name TEXT, sheet_id TEXT, tab_name TEXT,
    deleted_at TIMESTAMPTZ, active BOOLEAN DEFAULT TRUE)`;
async function seed(q) {
  for (const c of CPS) await q(`INSERT INTO campaign_participants (id, seq, reviewer_name, sheet_id, tab_name) VALUES ($1,$2,$3,$4,$5)`, [c.id, c.seq, c.name, S, T]);
}
function resetFakes() {
  contacts = CPS.map(c => ({ participantId: c.id, ok: true, name: c.name, phoneFull: c.phone, phone8: c.phone.slice(-8), isSub: c.id === 'p4' }));
  smsCalls.length = 0; rooms.length = 0; warns.length = 0; failNext = null; hook = null;
  smsImpl = async () => ({ accepted: true, messageId: 'm' + smsCalls.length, type: 'LMS' });
  delete process.env.MANUAL_SMS_SAME_TEXT_WINDOW_MIN;
}
async function freshDb({ with222 = true } = {}) {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await seed((s, p) => db.query(s, p));
  await db.exec(MIG('171_manual_message_sends.sql'));
  if (with222) await db.exec(MIG('222_manual_message_send_client_id.sql'));
  resetFakes();
}
const K1 = '11111111-2222-4333-8444-555555555555';
const K2 = '99999999-2222-4333-8444-555555555555';
const K3 = '77777777-2222-4333-8444-555555555555';
const TEXT = '리뷰 부탁드립니다';
const smsBody = (o = {}) => ({ sheetId: S, tabName: T, ids: ['p1'], kind: 'sms', text: TEXT, ...o });
const SAME = 'manual_sms_same_text_window';
const ageBack = (min) => db.query(`UPDATE manual_message_sends SET send_state_at = NOW() - make_interval(mins => ${Number(min)}), created_at = NOW() - make_interval(mins => ${Number(min)})`);
const fnSrc = (src, name, prefix = 'function ') => {
  const i = src.indexOf(prefix + name + '(');
  assert(i > -1, name + ' 없음');
  let p = src.indexOf('(', i), pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let depth = 0; const j = src.indexOf('{', p);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
  throw new Error(name + ' 본문 끝 못 찾음');
};

(async () => {
  console.log('\n▶ 결정 366 — 같은 번호·같은 글 10분 안 다시 보내기 막기\n');
  console.log('A. 실제 라우트 + 실제 SQL + 공급자 흉내');

  {
    await freshDb();
    const a = await send(smsBody({ clientSendId: K1 }));
    const b = await send(smsBody({ clientSendId: K2 }), { role: 'staff', name: '만두' });
    ok('★ 같은 번호·같은 글·10분 안(다른 담당자·다른 키) = 둘째는 공급자 0 · 총 1번', smsCalls.length === 1 && a.body.results[0].sent === true && b.body.results[0].sent === false, b.body);
    ok('막힘 응답 = 200 · code manual_sms_same_text_window · 사유 한국어(방금 · 10분 뒤)', b.status === 200 && b.body.results[0].code === SAME
      && b.body.results[0].reason === '같은 번호로 같은 문자를 방금 보냈습니다 — 두 번 나가지 않게 이번에는 보내지 않았습니다. 꼭 다시 보내야 하면 10분 뒤에 보내거나 내용을 고쳐 주세요', b.body.results[0].reason);
    ok('막힌 사람에게는 문의방 기록도 남기지 않는다 · 기록 줄도 늘지 않는다', rooms.length === 1
      && Number((await db.query(`SELECT COUNT(*)::int n FROM manual_message_sends`)).rows[0].n) === 1);
    const c = await send(smsBody());   // 구버전 화면(키 없음)
    ok('★ 키 없음(구버전 화면)도 막는다', smsCalls.length === 1 && c.body.results[0].code === SAME);
    const d = await send(smsBody({ text: '  리뷰   부탁드립니다\n' }));
    ok('앞뒤 공백·공백 묶음·줄바꿈 차이 = 같은 글로 본다(막음)', smsCalls.length === 1 && d.body.results[0].code === SAME);
    const e = await send(smsBody({ text: '리뷰 부탁드립니다!' , clientSendId: K3 }));
    ok('★ 글이 다르면 보낸다', smsCalls.length === 2 && e.body.results[0].sent === true);
    const f = await send(smsBody({ ids: ['p4'], clientSendId: '55555555-2222-4333-8444-555555555555' }));
    ok('★ 같은 번호의 다른 참여 줄(타계정)도 같은 사람 = 막음', smsCalls.length === 2 && f.body.results[0].code === SAME);
    const g = await send(smsBody({ ids: ['p2'] }));
    ok('다른 번호 = 보낸다', smsCalls.length === 3 && g.body.results[0].sent === true);
  }

  {
    // 같은 키 다시 보내기 = 364 결과(duplicate)가 우선 — 막힘 사유가 아니다
    await freshDb();
    await send(smsBody({ clientSendId: K1 }));
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('★ 같은 키 다시 보내기 = 「보냄」(duplicate:true) · 막힘 사유 아님 · 공급자 1번', smsCalls.length === 1 && r.body.results[0].sent === true
      && r.body.results[0].duplicate === true && !r.body.results[0].code, r.body);
    // 같은 키 결과 모름 다시 보내기 = 364 안내(결과 모름) 그대로
    await freshDb();
    smsImpl = async () => { const e = new Error('SOLAPI_REQUEST_TIMEOUT'); e.code = 'SOLAPI_REQUEST_TIMEOUT'; throw e; };
    await send(smsBody({ clientSendId: K1 }));
    const u = await send(smsBody({ clientSendId: K1 }));
    ok('같은 키·결과 모름 다시 보내기 = 364 「결과를 확인하지 못했습니다」 그대로(우선)', smsCalls.length === 1 && u.body.results[0].code === 'manual_send_unknown');
    // 다른 키·결과 모름 = 창 규칙으로 막음(결과 모름 문구)
    const u2 = await send(smsBody({ clientSendId: K2 }));
    ok('★ 앞선 결과 모름(시간 초과) + 다른 키 = 막음 · 「결과를 확인하지 못했습니다(이미 받았을 수 있습니다)」', smsCalls.length === 1
      && u2.body.results[0].code === SAME && /^같은 번호로 같은 문자를 방금 보냈는데 결과를 확인하지 못했습니다\(이미 받았을 수 있습니다\)/.test(u2.body.results[0].reason), u2.body);
    // 키 없음 결과 모름 = 종전 문구(구버전 화면) · 다음 같은 글은 막힘
    await freshDb();
    smsImpl = async () => { throw new TypeError('fetch failed'); };
    const n1 = await send(smsBody());
    ok('키 없음 + 결과 모름 = 종전 문구 「문자 발송 실패 — …」 · 기록 unknown', /^문자 발송 실패/.test(n1.body.results[0].reason)
      && (await db.query(`SELECT send_state FROM manual_message_sends`)).rows[0].send_state === 'unknown');
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    const n2 = await send(smsBody());
    ok('키 없음 결과 모름 뒤 같은 글 = 막음(이미 받았을 수 있음)', smsCalls.length === 1 && n2.body.results[0].code === SAME);
  }

  {
    // 앞선 확실한 실패 = 막지 않는다
    await freshDb();
    smsImpl = async () => ({ accepted: false, reason: '수신 거부', type: 'LMS' });
    await send(smsBody({ clientSendId: K1 }));
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    const r = await send(smsBody({ clientSendId: K2 }));
    ok('★ 앞선 확실한 실패(공급자 거절) = 다음 발송은 보낸다', smsCalls.length === 2 && r.body.results[0].sent === true);
    await freshDb();
    smsImpl = async () => { const e = new Error('SOLAPI_HTTP_400:bad'); e.status = 400; throw e; };
    await send(smsBody());
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    const r2 = await send(smsBody());
    ok('앞선 HTTP 오류(키 없음) = 다음 발송은 보낸다', smsCalls.length === 2 && r2.body.results[0].sent === true);
    // 같은 키 확실한 실패 다시 보내기 — 그 사이 다른 담당자가 같은 글을 보냈으면 막는다
    await freshDb();
    smsImpl = async () => ({ accepted: false, reason: '잔액 부족', type: 'LMS' });
    await send(smsBody({ clientSendId: K1 }));
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    await send(smsBody({ clientSendId: K2 }), { role: 'staff', name: '만두' });
    const r3 = await send(smsBody({ clientSendId: K1 }));
    ok('같은 키 실패 다시 보내기 + 그 사이 다른 담당자가 보냄 = 막음(공급자 3번째 없음)', smsCalls.length === 2 && r3.body.results[0].code === SAME);
  }

  {
    // 창 지남 · 설정
    await freshDb();
    await send(smsBody({ clientSendId: K1 }));
    await ageBack(4);
    const r0 = await send(smsBody({ clientSendId: K2 }));
    ok('4분 전 보냄 → 「4분 전에 보냈습니다 … 6분 뒤에」', r0.body.results[0].code === SAME
      && r0.body.results[0].reason === '같은 번호로 같은 문자를 4분 전에 보냈습니다 — 두 번 나가지 않게 이번에는 보내지 않았습니다. 꼭 다시 보내야 하면 6분 뒤에 보내거나 내용을 고쳐 주세요', r0.body.results[0].reason);
    await ageBack(11);
    const r = await send(smsBody({ clientSendId: K2 }));
    ok('★ 10분 지남 = 보낸다', smsCalls.length === 2 && r.body.results[0].sent === true);

    await freshDb();
    process.env.MANUAL_SMS_SAME_TEXT_WINDOW_MIN = '0';
    await send(smsBody({ clientSendId: K1 }));
    const off = await send(smsBody({ clientSendId: K2 }));
    await send(smsBody());
    ok('★ 설정 0 = 규칙 끔(같은 글 세 번 = 세 번 발송)', smsCalls.length === 3 && off.body.results[0].sent === true);

    await freshDb();
    process.env.MANUAL_SMS_SAME_TEXT_WINDOW_MIN = '5';
    await send(smsBody({ clientSendId: K1 }));
    await ageBack(6);
    const five = await send(smsBody({ clientSendId: K2 }));
    ok('설정 5분 = 6분 전 보낸 같은 글은 보낸다', smsCalls.length === 2 && five.body.results[0].sent === true);
    await ageBack(1);
    process.env.MANUAL_SMS_SAME_TEXT_WINDOW_MIN = '30';
    const thirty = await send(smsBody({ clientSendId: K3 }));
    ok('설정 30분 = 1분 전 보낸 같은 글은 막음 · 「29분 뒤에」', smsCalls.length === 2 && /1분 전에 보냈습니다[\s\S]*29분 뒤에/.test(thirty.body.results[0].reason), thirty.body.results[0].reason);
  }

  {
    // ★ 동시에 두 요청(키 다름) — 첫 요청이 공급자 응답을 기다리는 사이 둘째가 들어온다
    await freshDb();
    let open; const gate = new Promise((r) => { open = r; });
    smsImpl = async () => { await gate; return { accepted: true, messageId: 'mx', type: 'LMS' }; };
    const pa = send(smsBody({ clientSendId: K1 }));
    while (smsCalls.length === 0) await new Promise((r) => setImmediate(r));
    const b = await send(smsBody({ clientSendId: K2 }), { role: 'staff', name: '만두' });
    const c = await send(smsBody());
    ok('★ 동시에 다른 키·키 없음 = 둘째·셋째는 공급자 0 · 「보내기 시작해 아직 처리 중」', smsCalls.length === 1 && b.body.results[0].code === SAME
      && /^같은 번호로 같은 문자를 방금 보내기 시작해 아직 처리 중입니다 — /.test(b.body.results[0].reason) && c.body.results[0].code === SAME, b.body);
    open();
    const a = await pa;
    ok('첫 요청은 그대로 보냄 · 공급자 총 1번', a.body.results[0].sent === true && smsCalls.length === 1);

    // 가장 나쁜 겹침: 두 요청이 둘 다 미리보기(받는 사람 판정)를 끝낸 뒤 선점 단계에 들어간다
    await freshDb();
    let arrived = 0, go; const both = new Promise((r) => { go = r; });
    const origPreview = svc.previewManualSend;
    contactGate = async () => { arrived++; if (arrived >= 2) go(); await both; };
    const [x, y] = await Promise.all([send(smsBody({ clientSendId: K1 })), send(smsBody({ clientSendId: K2 }), { role: 'staff', name: '만두' })]);
    contactGate = null;
    const sentN = [x, y].filter(r => r.body.results[0].sent).length;
    ok('★ 미리보기 뒤 동시 선점(키 다름) = 공급자 1번 · 한쪽만 보냄 · 다른 쪽은 막힘 사유', smsCalls.length === 1 && sentN === 1
      && [x, y].some(r => r.body.results[0].code === SAME), { x: x.body, y: y.body });
    ok('미리보기 함수는 그대로(단일 출처)', svc.previewManualSend === origPreview);
  }

  {
    // 여러 명 — 막힌 사람만 빠진다
    await freshDb();
    await send(smsBody({ ids: ['p2'], clientSendId: K1 }));
    const r = await send(smsBody({ ids: ['p1', 'p2', 'p3'], clientSendId: K2 }));
    const by = Object.fromEntries(r.body.results.map(x => [x.participantId, x]));
    ok('★ 3명 중 1명이 10분 안 같은 글 = 그 1명만 막고 2명은 보냄(공급자 총 3번)', smsCalls.length === 3 && by.p1.sent && by.p3.sent
      && by.p2.sent === false && by.p2.code === SAME && r.body.ok === true, r.body);
    ok('막힌 사람 결과에도 이름·번호가 있다(결과 목록에 그대로)', by.p2.name === '이둘' && by.p2.phone === '01011110002');
    // 같은 요청 안 같은 번호 두 줄 = 종전처럼 merged(창 사유 아님)
    await freshDb();
    const m = await send(smsBody({ ids: ['p1', 'p4'], clientSendId: K1 }));
    ok('같은 요청 안 같은 번호 두 줄 = 종전처럼 「같은 번호에 이미 보냈습니다」(merged) · 공급자 1번', smsCalls.length === 1 && m.body.results[1].merged === true && !m.body.results[1].code);
  }

  {
    // 종전 기록(send_state 없음 · 배포 직전 기록) · 번호 모양
    await freshDb();
    const full = svc.composeSms(TEXT);
    await db.query(`INSERT INTO manual_message_sends (kind, participant_id, target_phone, message_text, accepted) VALUES ('sms','old','010-1111-0001',$1,TRUE)`, [full]);
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('종전 기록(상태 칸 없음) accepted = 막음 · 하이픈 번호도 같은 번호', smsCalls.length === 0 && r.body.results[0].code === SAME);
    await db.query(`UPDATE manual_message_sends SET accepted = FALSE`);
    const r2 = await send(smsBody({ clientSendId: K1 }));
    ok('종전 기록 accepted=false = 막지 않음', smsCalls.length === 1 && r2.body.results[0].sent === true);
    // 알림톡 기록은 문자 판정에 안 들어간다
    await freshDb();
    await db.query(`INSERT INTO manual_message_sends (kind, participant_id, target_phone, message_text, accepted, send_state) VALUES ('alimtalk','p1','01011110001',$1,TRUE,'sent')`, [svc.composeSms(TEXT)]);
    const r3 = await send(smsBody({ clientSendId: K1 }));
    ok('알림톡 기록은 문자 창 판정에 넣지 않는다', smsCalls.length === 1 && r3.body.results[0].sent === true);
  }

  {
    // 잠금 대기 초과 · 조회 실패 · 222 전 DB
    await freshDb();
    failNext = (sql) => (/pg_advisory_xact_lock/.test(sql) ? Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }) : null);
    const r = await send(smsBody({ ids: ['p1', 'p2'], clientSendId: K1 }));
    ok('★ 번호 잠금 대기 초과(55P03) = 그 사람은 공급자 0 · 「다른 요청이 처리 중」 · 다른 사람은 보냄', smsCalls.length === 1 && smsCalls[0].to === '01011110002'
      && r.body.results[0].code === 'manual_sms_busy' && r.body.results[0].reason === svc.SMS_BUSY_MSG && r.body.results[1].sent === true, r.body);
    ok('잠금 대기 초과 뒤 기록 줄 없음(그 사람은 선점 안 함)', (await db.query(`SELECT participant_id FROM manual_message_sends`)).rows.every(x => x.participant_id === 'p2'));
    await freshDb();
    failNext = (sql) => (/regexp_replace\(target_phone/.test(sql) ? Object.assign(new Error('disk read error'), { code: 'XX001' }) : null);
    const r2 = await send(smsBody({ clientSendId: K1 }));
    ok('창 조회 실패(스키마 문제 아님) = 보내지 않음(fail-closed) · 「기록을 남기지 못해」', smsCalls.length === 0 && /기록을 남기지 못해/.test(r2.body.results[0].reason));
    await freshDb();
    pool.connect = (orig => async () => { throw new Error('too many clients'); })(pool.connect);
    const r3 = await send(smsBody());
    ok('연결을 못 얻으면 보내지 않음(fail-closed)', smsCalls.length === 0 && r3.body.results[0].sent === false);
    delete pool.connect;   // 아래에서 다시 단다
  }
  // pool.connect 복구(위에서 실패 흉내로 덮었다)
  pool.connect = async () => {
    let held = null;
    return {
      async query(sql, params) {
        const s = String(sql).trim();
        if (failNext) { const e = failNext(s); if (e) { failNext = null; throw e; } }
        if (/^BEGIN/i.test(s) && !held) held = await lock();
        const rel = held ? null : await lock();
        try { return await db.query(sql, params); }
        finally { if (rel) rel(); if (/^(COMMIT|ROLLBACK)/i.test(s) && held) { const h = held; held = null; h(); } }
      },
      release() { if (held) { const h = held; held = null; h(); } },
    };
  };
  {
    await freshDb({ with222: false });
    const r = await send(smsBody());
    const r2 = await send(smsBody());
    ok('222 전 DB(칸 없음 · 42703) = 종전 경로로 보낸다(같은 글 막기 없음) · 경고 로그', r.body.results[0].sent && r2.body.results[0].sent && smsCalls.length === 2
      && warns.some(w => /같은 글 막기 없음/.test(w)));
  }

  console.log('B. 문구·설정·정적 가드');
  {
    ok('설정: 없음/빈칸/잘못된 값/음수 = 10 · 0 = 끔 · 소수 내림 · 상한 1440',
      svc.smsSameTextWindowMin({}) === 10 && svc.smsSameTextWindowMin({ MANUAL_SMS_SAME_TEXT_WINDOW_MIN: '' }) === 10
      && svc.smsSameTextWindowMin({ MANUAL_SMS_SAME_TEXT_WINDOW_MIN: 'abc' }) === 10 && svc.smsSameTextWindowMin({ MANUAL_SMS_SAME_TEXT_WINDOW_MIN: '-3' }) === 10
      && svc.smsSameTextWindowMin({ MANUAL_SMS_SAME_TEXT_WINDOW_MIN: '0' }) === 0 && svc.smsSameTextWindowMin({ MANUAL_SMS_SAME_TEXT_WINDOW_MIN: '7.9' }) === 7
      && svc.smsSameTextWindowMin({ MANUAL_SMS_SAME_TEXT_WINDOW_MIN: '99999' }) === 1440);
    ok('설정 이름 = MANUAL_SMS_SAME_TEXT_WINDOW_MIN · 기본 10', svc.SMS_WINDOW_ENV === 'MANUAL_SMS_SAME_TEXT_WINDOW_MIN' && svc.SMS_WINDOW_DEFAULT_MIN === 10);
    ok('문구: 125초 전·10분 창 = 「2분 전에 … 8분 뒤에」', svc.smsWindowReason({ state: 'sent', ageSec: 125, windowMin: 10 })
      === '같은 번호로 같은 문자를 2분 전에 보냈습니다 — 두 번 나가지 않게 이번에는 보내지 않았습니다. 꼭 다시 보내야 하면 8분 뒤에 보내거나 내용을 고쳐 주세요');
    ok('문구: 남은 시간은 최소 1분', /1분 뒤에/.test(svc.smsWindowReason({ state: 'sent', ageSec: 599.5, windowMin: 10 })));
    ok('같은 글 판정 = trim + 공백 묶음 한 칸', svc.smsTextKey(' a \n\n b\t c ') === 'a b c' && svc.smsPhoneKey('010-1111 0001') === '01011110001');
    const src = fs.readFileSync(path.join(SERVER, 'src/services/manualMessage.service.js'), 'utf8');
    const tx = fnSrc(src, '_claimSmsTx', 'async function ');
    const iBegin = tx.indexOf(`'BEGIN'`), iTo = tx.indexOf('lock_timeout'), iLock = tx.indexOf('pg_advisory_xact_lock'),
      iHit = tx.indexOf('_smsWindowHit('), iClaim = tx.indexOf('_claim(c, client)'), iCommit = tx.indexOf(`'COMMIT'`);
    ok('★ 순서: BEGIN → lock_timeout → 번호 잠금 → 창 판정 → 선점 → COMMIT', iBegin > -1 && iBegin < iTo && iTo < iLock && iLock < iHit && iHit < iClaim && iClaim < iCommit);
    ok('잠금 트랜잭션 안에서 공급자를 부르지 않는다', !/solapi\./.test(tx));
    const body = fnSrc(src, '_sendManualSmsKeyed', 'async function ');
    ok('★ 문자 선점(_claimSmsTx)이 공급자 호출보다 앞선다', body.indexOf('_claimSmsTx(') > -1 && body.indexOf('_claimSmsTx(') < body.indexOf('solapi.sendSms('));
    const top = fnSrc(src, 'sendManualSms', 'async function ');
    ok('키 없음도 선점 경로를 탄다(종전 경로는 222 전 DB 대비 뒤쪽 하나)', top.indexOf('_sendManualSmsKeyed(') > -1 && top.indexOf('_sendManualSmsKeyed(') < top.indexOf('_sendManualSmsLegacy('));
    ok('같은 키 줄이 있으면(확실한 실패 제외) 창 판정을 건너뛴다(364 우선)', /if \(!own \|\| own\.state === 'failed'\)/.test(tx));
    {
      // 두 키 advisory 잠금의 첫 키가 다른 잠금(작업 잠금 · 증빙 해시 잠금)의 첫 키와 겹치지 않는다
      const jl = require(path.join(SERVER, 'src/utils/jobLock'));
      const names = ['order_reconcile', 'queue_pump_drain', 'raw_mirror_all', 'reverse_sync_auto', 'campaign_hold_sweep', 'review_reminder_alimtalk'];
      const mine = (await db.query(`SELECT hashtext('manual_sms_same_text') AS a, hashtext('dual_evidence_sha') AS b`)).rows[0];
      ok('번호 잠금 첫 키가 작업 잠금·증빙 해시 잠금 첫 키와 다르다', mine.a !== mine.b && names.every(n => jl._lockKeys(n)[0] !== mine.a), mine);
    }
    ok('문자 발송 호출처 = manualMessage 한 곳(자동/크론 문자 없음)', (() => {
      const dir = path.join(SERVER, 'src');
      const hits = [];
      (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.js$/.test(f) && /\.sendSms\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(dir, p)); } })(dir);
      return hits.length === 1 && hits[0] === path.join('services', 'manualMessage.service.js');
    })());
  }

  if (process.env.SMS_WINDOW_NATIVE_PG_TEST === '1') {
    console.log('C. 실제 PostgreSQL 동시 접속');
    const { startNativeCaptureDatabase, gate, waitUntilBlocked } = require('./helpers/captureNativePgFixture');
    const cluster = await startNativeCaptureDatabase();
    const savedQuery = pool.query, savedConnect = pool.connect;
    try {
      const nq = (s, p) => cluster.pool.query(s, p);
      await cluster.pool.query(BASE_SCHEMA);
      await seed(nq);
      for (const f of ['171_manual_message_sends.sql', '222_manual_message_send_client_id.sql']) await cluster.pool.query(MIG(f));
      resetFakes();
      pool.query = nq;
      let holdFirst = false, firstPid = null, g = null;
      const pids = [];
      pool.connect = async () => {
        const c = await cluster.pool.connect();
        pids.push(c.processID);
        return {
          async query(sql, params) {
            const out = await c.query(sql, params);
            if (holdFirst && /pg_advisory_xact_lock/.test(String(sql))) { holdFirst = false; firstPid = c.processID; await g.promise; }
            return out;
          },
          release: () => c.release(),
        };
      };
      // ① 둘째가 첫째의 번호 잠금을 실제로 기다린다 → 첫째 COMMIT 뒤 '대기' 줄을 보고 보내지 않는다
      g = gate(); holdFirst = true; pids.length = 0;
      const pA = send(smsBody({ clientSendId: K1 }));
      while (!firstPid) await new Promise((r) => setTimeout(r, 10));
      const pB = send(smsBody({ clientSendId: K2 }), { role: 'staff', name: '만두' });
      while (pids.length < 2) await new Promise((r) => setTimeout(r, 10));
      await waitUntilBlocked(cluster.pool, pids[1], firstPid);
      ok('[실 PG] 둘째 발송이 첫째의 번호 잠금을 실제로 기다린다(pg_blocking_pids)', true);
      g.resolve();
      const [ra, rb] = await Promise.all([pA, pB]);
      const n = (await nq(`SELECT COUNT(*)::int n FROM manual_message_sends`)).rows[0].n;
      ok('[실 PG] 동시 두 발송(키 다름) → 공급자 1번 · 기록 1줄 · 둘째 막힘 사유', smsCalls.length === 1 && n === 1 && ra.body.results[0].sent
        && rb.body.results[0].code === SAME, { calls: smsCalls.length, n, ra: ra.body, rb: rb.body });
      // ② 잠금을 5초 넘게 쥐고 있으면 둘째는 기다리다 멈추고(55P03) 보내지 않는다
      await nq(`DELETE FROM manual_message_sends`); smsCalls.length = 0;
      g = gate(); holdFirst = true; firstPid = null; pids.length = 0;
      const pC = send(smsBody({ ids: ['p2'], clientSendId: K1 }));
      while (!firstPid) await new Promise((r) => setTimeout(r, 10));
      const t0 = Date.now();
      const rd = await send(smsBody({ ids: ['p2'], clientSendId: K2 }), { role: 'staff', name: '만두' });
      const waited = Date.now() - t0;
      g.resolve();
      const rc = await pC;
      ok('[실 PG] 번호 잠금 5초 초과 = 「다른 요청이 처리 중」 · 공급자 0(둘째) · 첫째는 보냄', rd.body.results[0].code === 'manual_sms_busy'
        && waited >= 4500 && waited < 9000 && rc.body.results[0].sent === true && smsCalls.length === 1, { waited, rd: rd.body });
    } finally {
      pool.query = savedQuery; pool.connect = savedConnect;
      await cluster.close();
    }
  } else {
    console.log('  ⏭ 실 PostgreSQL 동시 접속(C)은 SMS_WINDOW_NATIVE_PG_TEST=1 일 때만');
  }

  console.log(`\n✅ manualSmsSameTextWindow: ${passed}개 통과`);
  process.exit(0);
})().catch((e) => { console.error('❌', e && e.stack ? e.stack : e); process.exit(1); });
