/**
 * manualMessageSendIdempotency.test.js — 결정 364 회귀가드 (migration 222)
 * 「작업보드 문자·알림톡 직접 보내기에서, 서버는 이미 보냈는데 응답만 못 받아(시간 초과·끊김) 같은 내용으로
 *   다시 보내면 같은 문자가 한 번 더 나가 비용이 두 번 든다」를 막는다.
 *
 *   A. migration 222 — 두 번 돌려도 안전 · 기존 기록은 NULL 그대로 · 부분 유일 색인
 *   B. 실제 라우트 POST /workdesk/manual-send(trackB) + 실제 SQL(PGlite) + 공급자 흉내(호출 수를 센다)
 *      - 키 없음 = 종전 그대로(두 번 = 두 번 발송)
 *      - 첫 발송 저장·공급자 호출 뒤 응답 유실 → 같은 키 다시 보내기 = 공급자 1번 · 문의방 기록 1번 · 「보냄」(duplicate)
 *      - 같은 키 동시에 두 번 = 공급자 1번(뒤쪽은 「처리 중」)
 *      - 같은 키·다른 글 / 다른 보낸 사람 = 409(공급자 0번)
 *      - 여러 명 중 일부만 확실한 실패 → 다시 보내기 = 실패한 사람에게만
 *      - 공급자 시간 초과(결과 모름) → 다시 보내기가 보내지 않음 + 쉬운 한국어
 *      - 공급자 성공 + 결과 기록 실패 → 이번 응답은 「보냄」 · 다시 보내기는 보내지 않음
 *      - 오래된 '대기' = 결과 모름 · 마이그레이션 전 DB(42703)·색인 없는 DB(42P10) = 종전 경로
 *      - 알림톡: 다시 보내기가 다음 회차를 보내지 않음 · 결과 모름은 다시 안 보냄 · 공급자까지 안 간 줄은 다시 시도 가능
 *   C. 화면(vm) — workdesk.html _msSendConfirmed + api.js createCsStaffDraftKey
 *      통신 실패 → 키 유지 → 같은 내용 다시 보내기 = 같은 키 · 모두 보냄 뒤 새 키 · 고치면 새 키 · 409 뒤 새 키
 *      · 일부 실패면 키 유지 · 창을 닫아도 응답 기준으로 키 정리 · 구버전 api.js = 키 없이 종전
 * 실행: node tests/manualMessageSendIdempotency.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:***@127.0.0.1:1/none';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..');
const MIG = (f) => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8');
const M171 = '171_manual_message_sends.sql';
const M222 = '222_manual_message_send_client_id.sql';

let passed = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓ ' + name);
}

const pool = require(path.join(SERVER, 'src/db/pool'));
const { logger } = require(path.join(SERVER, 'src/utils/logger'));
const warns = [];
logger.warn = (m) => warns.push(String(m));

/** PGlite = 연결 하나 — 문장 단위로 줄을 세운다(운영 풀처럼 문장 사이에 다른 요청이 끼어들 수 있다). */
let db = null;
let chain = Promise.resolve();
function lock() { let release; const p = new Promise((r) => { release = r; }); const prev = chain; chain = prev.then(() => p); return prev.then(() => release); }
let failNext = null;   // (sql) => Error | null — 한 번 실패 주입
pool.query = async (sql, params) => {
  if (failNext) { const e = failNext(sql); if (e) { failNext = null; throw e; } }
  const rel = await lock(); try { return await db.query(sql, params); } finally { rel(); }
};

// ── 공급자·주변 흉내(실제 발송 업체는 절대 부르지 않는다) ──
const solapi = require(path.join(SERVER, 'src/services/solapi.service'));
solapi.getSolapiStatus = () => ({ configured: true, missing: [] });
solapi.getAccountBilling = async () => { throw new Error('단가 조회는 발송 경로에서 부르면 안 된다'); };
const smsCalls = [];
let smsImpl = async () => ({ accepted: true, messageId: 'm' + smsCalls.length, type: 'LMS' });
solapi.sendSms = async (a) => { smsCalls.push(a); return smsImpl(a); };
const csBridge = require(path.join(SERVER, 'src/services/csBridge.service'));
const rooms = [];
csBridge.postAdminNotice = async (a) => { rooms.push(a); return { threadId: 't-' + a.phone8 }; };
const contact = require(path.join(SERVER, 'src/services/reviewerContact.service'));
let contacts = [];
contact.reviewerContactsForRows = async ({ participantIds }) => ({ items: contacts.filter(c => participantIds.includes(c.participantId)) });
const reminder = require(path.join(SERVER, 'src/services/reviewReminder.service'));
reminder.manualPreview = async () => ({ byRow: new Map() });
const ataCalls = [];      // 공급자까지 간 알림톡(줄 번호)
let ataImpl = (seq) => ({ rowIndex: seq, sent: true, accepted: true, reminderNo: 1, targetPhone: '010111' + seq, orderSubmissionId: 'o' + seq });
let ataManualCalls = 0;
reminder.sendManual = async ({ rowIndexes }) => {
  ataManualCalls++;
  const results = rowIndexes.map(seq => { const r = ataImpl(seq); if (r.sent) ataCalls.push(seq); return r; });
  return { ok: true, results };
};

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
];
async function freshDb({ with222 = true, withIndex = true } = {}) {
  db = new PGlite();
  await db.exec(`CREATE TABLE campaign_participants (id TEXT PRIMARY KEY, seq INT, reviewer_name TEXT, sheet_id TEXT, tab_name TEXT,
    deleted_at TIMESTAMPTZ, active BOOLEAN DEFAULT TRUE)`);
  for (const c of CPS) await db.query(`INSERT INTO campaign_participants (id, seq, reviewer_name, sheet_id, tab_name) VALUES ($1,$2,$3,$4,$5)`, [c.id, c.seq, c.name, S, T]);
  await db.exec(MIG(M171));
  if (with222) {
    const sql = withIndex ? MIG(M222) : MIG(M222).replace(/CREATE UNIQUE INDEX[\s\S]*$/, '');
    await db.exec(sql);
  }
  contacts = CPS.map(c => ({ participantId: c.id, ok: true, name: c.name, phoneFull: c.phone, phone8: c.phone.slice(-8) }));
  smsCalls.length = 0; rooms.length = 0; ataCalls.length = 0; ataManualCalls = 0; warns.length = 0;
  smsImpl = async () => ({ accepted: true, messageId: 'm' + smsCalls.length, type: 'LMS' });
  ataImpl = (seq) => ({ rowIndex: seq, sent: true, accepted: true, reminderNo: 1, targetPhone: '010111' + seq, orderSubmissionId: 'o' + seq });
}
const rowsOf = async () => (await db.query(`SELECT participant_id AS p, send_state AS state, accepted, client_send_id AS key, message_type AS type, reminder_no AS "reminderNo" FROM manual_message_sends ORDER BY participant_id, created_at`)).rows;
const K1 = '11111111-2222-4333-8444-555555555555';
const K2 = '99999999-2222-4333-8444-555555555555';
const smsBody = (o = {}) => ({ sheetId: S, tabName: T, ids: ['p1'], kind: 'sms', text: '리뷰 부탁드립니다', ...o });

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
  console.log('\n▶ 결정 364 — 작업보드 문자·알림톡 다시 보내기 중복 발송 방지\n');

  /* ── A. migration 222 ── */
  {
    await freshDb({ with222: false });
    await db.query(`INSERT INTO manual_message_sends (kind, participant_id, accepted) VALUES ('sms','old',TRUE)`);
    await db.exec(MIG(M222));
    await db.exec(MIG(M222));
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='manual_message_sends'`)).rows.map(r => r.column_name);
    ok('222: 칸 4개 더하기(두 번 돌려도 안전)', ['client_send_id', 'client_send_fp', 'send_state', 'send_state_at'].every(c => cols.includes(c)));
    const old = (await db.query(`SELECT client_send_id, send_state, accepted FROM manual_message_sends WHERE participant_id='old'`)).rows[0];
    ok('222: 기존 기록은 그대로(새 칸 NULL · accepted 불변)', old.client_send_id === null && old.send_state === null && old.accepted === true);
    const idx = (await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname='uq_manual_message_sends_client_send'`)).rows[0];
    ok('222: 부분 유일 색인 (키, 참여 줄) WHERE 키 있음', idx && /UNIQUE/.test(idx.indexdef) && /client_send_id, participant_id/.test(idx.indexdef) && /client_send_id IS NOT NULL/.test(idx.indexdef));
    const m = MIG(M222).replace(/--.*$/gm, '');
    ok('222: 더하기만(DROP·DELETE·UPDATE·RENAME 0) · 문장마다 IF NOT EXISTS', !/\b(DROP|DELETE|UPDATE|RENAME)\b/i.test(m) && (m.match(/IF NOT EXISTS/g) || []).length === 5);
    const idxJs = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
    ok('부팅 필수 칸 목록(REQUIRED_SCHEMA)에 222 칸 4개', /\['client_send_id', 'client_send_fp', 'send_state', 'send_state_at'\]\.map\(c => \['manual_message_sends', c\]\)/.test(idxJs));
  }

  /* ── B. 실제 라우트 · 문자 ── */
  {
    await freshDb();
    let r1 = await send(smsBody());
    let r2 = await send(smsBody());
    ok('키 없음 = 종전 그대로(두 번 누르면 두 번 발송 · 구버전 화면)', smsCalls.length === 2 && r1.body.ok && r2.body.ok);
    ok('키 없음 기록은 키 칸 NULL', (await rowsOf()).every(x => x.key === null && x.state === null));

    await freshDb();
    const first = await send(smsBody({ clientSendId: K1 }));   // ← 이 응답이 화면까지 못 갔다고 친다
    ok('첫 발송: 공급자 1번 · 문의방 기록 1번 · 기록 sent', smsCalls.length === 1 && rooms.length === 1 && first.body.results[0].sent === true
      && (await rowsOf())[0].state === 'sent' && (await rowsOf())[0].accepted === true);
    const again = await send(smsBody({ clientSendId: K1 }));
    ok('★ 응답 유실 뒤 같은 키 다시 보내기 = 공급자 호출 0(총 1번) · 문의방 기록도 1번', smsCalls.length === 1 && rooms.length === 1);
    ok('다시 보내기 응답 = 「보냄」(duplicate:true) · 200', again.status === 200 && again.body.ok === true && again.body.results[0].sent === true && again.body.results[0].duplicate === true);
    ok('기록은 한 사람 한 줄', (await rowsOf()).length === 1);
    const other = await send(smsBody({ clientSendId: K2 }));
    ok('새 키(= 화면이 새로 쓴 발송) = 새로 보낸다', smsCalls.length === 2 && other.body.results[0].sent === true && !other.body.results[0].duplicate);

    // 같은 키·다른 글 / 다른 보낸 사람 = 409, 공급자 0
    const c1 = await send(smsBody({ clientSendId: K1, text: '고친 글' }));
    ok('같은 키·다른 글 = 409 manual_send_conflict · 공급자 0', c1.status === 409 && c1.body.code === 'manual_send_conflict' && /내용이 달라/.test(c1.body.error) && smsCalls.length === 2);
    const c2 = await send(smsBody({ clientSendId: K1 }), { role: 'staff', name: '만두' });
    ok('같은 키·다른 보낸 사람 = 409 · 공급자 0', c2.status === 409 && smsCalls.length === 2);
    const c3 = await send({ ...smsBody({ clientSendId: K1 }), kind: 'alimtalk' });
    ok('같은 키·다른 방식(문자→알림톡) = 409 · 발송 0', c3.status === 409 && ataManualCalls === 0);
  }

  {
    // 같은 키 동시에 두 번 — 첫 요청이 공급자 응답을 기다리는 사이 두 번째가 들어온다
    await freshDb();
    let open; const gate = new Promise((r) => { open = r; });
    smsImpl = async () => { await gate; return { accepted: true, messageId: 'mx', type: 'LMS' }; };
    const pa = send(smsBody({ clientSendId: K1 }));
    while (smsCalls.length === 0) await new Promise((r) => setImmediate(r));
    const b = await send(smsBody({ clientSendId: K1 }));
    ok('★ 동시에 같은 키 = 두 번째는 공급자를 부르지 않고 「처리 중」', smsCalls.length === 1 && b.body.results[0].sent === false && b.body.results[0].code === 'manual_send_in_progress' && /처리 중/.test(b.body.results[0].reason));
    open();
    const a = await pa;
    ok('첫 요청은 그대로 보냄 · 공급자 총 1번', a.body.results[0].sent === true && smsCalls.length === 1);
    const c = await send(smsBody({ clientSendId: K1 }));
    ok('끝난 뒤 다시 보내기 = 「보냄」(duplicate) · 공급자 총 1번', c.body.results[0].duplicate === true && smsCalls.length === 1);
  }

  {
    // 여러 명 — 일부만 확실한 실패(공급자 거절)
    await freshDb();
    smsImpl = async (a) => (a.to === '01011110002' ? { accepted: false, reason: '수신 거부', type: 'LMS' } : { accepted: true, messageId: 'm', type: 'LMS' });
    const body = smsBody({ ids: ['p1', 'p2', 'p3'], clientSendId: K1 });
    const r = await send(body);
    ok('3명 중 1명 거절 = 2명 보냄 · 1명 실패(기록 failed)', smsCalls.length === 3 && r.body.results.filter(x => x.sent).length === 2
      && (await rowsOf()).find(x => x.p === 'p2').state === 'failed');
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    const r2 = await send(body);
    ok('★ 같은 키 다시 보내기 = 실패했던 1명에게만 공급자 호출(총 4번)', smsCalls.length === 4 && smsCalls[3].to === '01011110002');
    ok('다시 보내기 결과: 셋 다 「보냄」(둘은 duplicate)', r2.body.results.every(x => x.sent) && r2.body.results.filter(x => x.duplicate).length === 2);
    ok('기록: 셋 다 sent · 사람마다 한 줄', (await rowsOf()).length === 3 && (await rowsOf()).every(x => x.state === 'sent'));
    ok('문의방 기록 = 사람마다 한 번(총 3)', rooms.length === 3);
  }

  {
    // HTTP 오류(공급자가 답함) = 확실한 실패 → 다시 보낼 수 있다
    await freshDb();
    smsImpl = async () => { const e = new Error('SOLAPI_HTTP_400:bad'); e.status = 400; e.code = 'BadRequest'; throw e; };
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('공급자 HTTP 오류 = 실패(failed) · 사유 표시', r.body.results[0].sent === false && /문자 발송 실패/.test(r.body.results[0].reason) && (await rowsOf())[0].state === 'failed');
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    const r2 = await send(smsBody({ clientSendId: K1 }));
    ok('확실한 실패 뒤 같은 키 = 다시 보낸다(공급자 2번째)', smsCalls.length === 2 && r2.body.results[0].sent === true && (await rowsOf())[0].state === 'sent');
  }

  {
    // 공급자 시간 초과(받았을 수 있음) = 결과 모름 → 다시 보내지 않는다
    await freshDb();
    smsImpl = async () => { const e = new Error('SOLAPI_REQUEST_TIMEOUT'); e.code = 'SOLAPI_REQUEST_TIMEOUT'; throw e; };
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('공급자 시간 초과 = 결과 모름(unknown) · 쉬운 한국어', r.body.results[0].sent === false && r.body.results[0].code === 'manual_send_unknown'
      && /결과를 확인하지 못했습니다/.test(r.body.results[0].reason) && (await rowsOf())[0].state === 'unknown');
    ok('결과 모름에는 문의방 기록을 남기지 않는다', rooms.length === 0);
    smsImpl = async () => ({ accepted: true, messageId: 'm', type: 'LMS' });
    const r2 = await send(smsBody({ clientSendId: K1 }));
    ok('★ 결과 모름 뒤 같은 키 = 공급자 호출 0(총 1번) · 같은 안내', smsCalls.length === 1 && r2.body.results[0].code === 'manual_send_unknown' && /내용을 조금 고치거나/.test(r2.body.results[0].reason));
    // 연결 끊김(TypeError fetch failed)도 결과 모름
    await freshDb();
    smsImpl = async () => { throw new TypeError('fetch failed'); };
    await send(smsBody({ clientSendId: K1 }));
    ok('연결 끊김도 결과 모름(unknown)', (await rowsOf())[0].state === 'unknown');
    // 요청을 보내기도 전의 오류는 확실한 실패
    await freshDb();
    smsImpl = async () => { const e = new Error('SOLAPI_NOT_CONFIGURED:x'); e.code = 'SOLAPI_NOT_CONFIGURED'; throw e; };
    await send(smsBody({ clientSendId: K1 }));
    ok('보내기 전 오류(설정 없음)는 확실한 실패(failed — 다시 보낼 수 있음)', (await rowsOf())[0].state === 'failed');
  }

  {
    // 공급자 성공 + 결과 기록 실패 → 이번 응답은 보냄 · 다시 보내기는 안 보냄
    await freshDb();
    failNext = (sql) => (/SET send_state=\$2/.test(sql) ? Object.assign(new Error('connection lost'), { code: '08006' }) : null);
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('공급자 성공 + 기록 갱신 실패 = 이번 응답은 「보냄」 · 경고 로그', r.body.results[0].sent === true && smsCalls.length === 1 && warns.some(w => /발송 결과 기록 실패/.test(w)));
    ok('그 줄은 대기(pending)로 남는다', (await rowsOf())[0].state === 'pending');
    const r2 = await send(smsBody({ clientSendId: K1 }));
    ok('★ 다시 보내기 = 대기 줄을 보고 공급자 호출 0', smsCalls.length === 1 && r2.body.results[0].sent === false && r2.body.results[0].code === 'manual_send_in_progress');
    await db.query(`UPDATE manual_message_sends SET send_state_at = NOW() - INTERVAL '10 minutes'`);
    const r3 = await send(smsBody({ clientSendId: K1 }));
    ok('오래된 대기(2분 넘음) = 결과 모름 안내 · 공급자 호출 0', smsCalls.length === 1 && r3.body.results[0].code === 'manual_send_unknown');
  }

  {
    // 선점 기록 자체가 실패하면 그 사람에게는 보내지 않는다(fail-closed)
    await freshDb();
    failNext = (sql) => (/INSERT INTO manual_message_sends/.test(sql) ? Object.assign(new Error('disk full'), { code: '53100' }) : null);
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('선점 기록 실패 = 공급자 호출 0 · 「기록을 남기지 못해 보내지 않았습니다」', smsCalls.length === 0 && r.body.results[0].sent === false && /기록을 남기지 못해/.test(r.body.results[0].reason));
  }

  {
    // 마이그레이션 전 DB(칸 없음) · 색인 없음 = 종전 경로(보내기는 살린다)
    await freshDb({ with222: false });
    const r = await send(smsBody({ clientSendId: K1 }));
    ok('칸 없는 DB(42703) + 키 = 종전 경로로 보낸다 · 경고', r.body.results[0].sent === true && smsCalls.length === 1 && warns.some(w => /migration 222 전/.test(w)));
    ok('종전 경로 기록이 남는다', Number((await db.query(`SELECT COUNT(*)::int AS n FROM manual_message_sends`)).rows[0].n) === 1);
    await freshDb({ withIndex: false });
    const r2 = await send(smsBody({ clientSendId: K1 }));
    ok('색인 없는 DB(42P10) + 키 = 종전 경로로 보낸다 · 경고', r2.body.results[0].sent === true && smsCalls.length === 1 && warns.some(w => /색인 없음/.test(w)));
    ok('모양이 틀린 키 = 키 없음(종전 경로)', svc.SEND_CONFLICT === 'manual_send_conflict' && (await (async () => { await freshDb(); await send(smsBody({ clientSendId: 'short' })); return (await rowsOf())[0].key === null; })()));
  }

  {
    // 같은 번호 두 줄(본계정·타계정) — 종전처럼 한 번만, 다시 보내기도 한 번
    await freshDb();
    contacts = [{ participantId: 'p1', ok: true, name: '김하나', phoneFull: '01011110001', phone8: '11110001' },
      { participantId: 'p2', ok: true, name: '김하나', phoneFull: '01011110001', phone8: '11110001', isSub: true }];
    const r = await send(smsBody({ ids: ['p1', 'p2'], clientSendId: K1 }));
    await send(smsBody({ ids: ['p1', 'p2'], clientSendId: K1 }));
    ok('같은 번호 두 줄 = 공급자 1번(다시 보내기 포함)', smsCalls.length === 1 && r.body.results[1].merged === true);
  }

  /* ── B-2. 알림톡 ── */
  {
    await freshDb();
    const body = { sheetId: S, tabName: T, ids: ['p1', 'p2'], kind: 'alimtalk', clientSendId: K1 };
    const r = await send(body);
    ok('알림톡 첫 발송: 두 줄 공급자까지 · 기록 sent(ATA·회차)', ataCalls.length === 2 && r.body.results.every(x => x.sent)
      && (await rowsOf()).every(x => x.state === 'sent' && x.type === 'ATA' && x.reminderNo === 1));
    // 첫 알림톡이 바로 도착 확인돼 회차가 올라간 상황 — 흉내 공급자는 부르면 다음 회차를 또 보낸다
    ataImpl = (seq) => ({ rowIndex: seq, sent: true, accepted: true, reminderNo: 2, targetPhone: '010111' + seq, orderSubmissionId: 'o' + seq });
    const r2 = await send(body);
    ok('★ 알림톡 다시 보내기 = 다음 회차를 보내지 않는다(공급자 호출 0 · sendManual 호출 0)', ataCalls.length === 2 && ataManualCalls === 1);
    ok('알림톡 다시 보내기 응답 = 「보냄」(duplicate · 보낸 회차 1차)', r2.body.results.every(x => x.sent && x.duplicate && x.reminderNo === 1));

    await freshDb();
    ataImpl = (seq) => (seq === 1
      ? { rowIndex: seq, sent: true, accepted: false, uncertain: true, reminderNo: 1, reason: 'SOLAPI_REQUEST_TIMEOUT', targetPhone: '0101111', orderSubmissionId: 'o1' }
      : { rowIndex: seq, sent: false, reason: 'submitted_before_send' });
    const u = await send(body);
    ok('알림톡 결과 모름 = unknown · 쉬운 한국어', u.body.results[0].code === 'manual_send_unknown' && /알림톡 발송 결과를 확인하지 못했습니다/.test(u.body.results[0].reason));
    ok('공급자까지 안 간 줄(방금 제출함) = 선점을 풀어 기록 없음 · 사유', /방금 리뷰를 제출/.test(u.body.results[1].reason) && (await rowsOf()).length === 1);
    ataImpl = (seq) => ({ rowIndex: seq, sent: true, accepted: true, reminderNo: 1, targetPhone: '010111' + seq, orderSubmissionId: 'o' + seq });
    const u2 = await send(body);
    ok('★ 다시 보내기: 결과 모름 줄은 안 보내고, 공급자까지 안 갔던 줄만 다시 시도', ataCalls.length === 2 && ataCalls[1] === 2
      && u2.body.results[0].code === 'manual_send_unknown' && u2.body.results[1].sent === true);

    await freshDb();
    const k0 = await send({ sheetId: S, tabName: T, ids: ['p1'], kind: 'alimtalk' });
    await send({ sheetId: S, tabName: T, ids: ['p1'], kind: 'alimtalk' });
    ok('알림톡 키 없음 = 종전 그대로(sendManual 두 번)', ataManualCalls === 2 && k0.body.results[0].sent === true);
  }

  /* ── C. 화면(vm) ── */
  {
    const wd = fs.readFileSync(path.join(REPO, 'frontend/workdesk.html'), 'utf8');
    const apiJs = fs.readFileSync(path.join(REPO, 'frontend/api.js'), 'utf8');
    const keySrc = ['_csNewClientMsgKey', '_csStaffAccountFp', 'createCsStaffDraftKey'].map(n => fnSrc(apiJs, n)).join('\n');
    const wdSrc = [fnSrc(wd, '_msDraftKeyer'), fnSrc(wd, '_msKeyFor'), fnSrc(wd, '_msSettleKey'), fnSrc(wd, '_msSendConfirmed', 'async function ')].join('\n');
    function makeCtx({ withKeyer = true } = {}) {
      const bodies = [];
      const el = (v) => ({ value: v, readOnly: false, innerHTML: '', classList: { remove() {}, add() {} } });
      const ctx = {
        console, JSON, Math, Date, Array, String, Number, Promise, Uint8Array, TextDecoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        crypto: require('crypto').webcrypto,
        sessionStorage: { getItem: () => 'h.' + Buffer.from(JSON.stringify({ id: 7, username: 'mango', name: '망고' })).toString('base64url') + '.s' },
        text: '리뷰 부탁드립니다', nodes: {}, bodies, toasts: [],
        respond: null,
      };
      ctx.document = { getElementById: (id) => (id === 'msText' ? el(ctx.text) : (ctx.nodes[id] = ctx.nodes[id] || el(''))), querySelector: () => null, querySelectorAll: () => [] };
      ctx.api = async (p, o) => { const b = JSON.parse(o.body); bodies.push(b); return ctx.respond(b); };
      ctx.esc = (s) => String(s); ctx.toast = (m) => ctx.toasts.push(m);
      ctx._msPaintBtns = () => {}; ctx._msPaintList = () => {}; ctx._msPlace = () => {}; ctx._msTplProduct = () => ''; ctx._MS_PH = '○○○○○'; ctx._msBytes = (t) => String(t).length;
      ctx._msOkItems = () => [{ participantId: 'p1' }, { participantId: 'p2' }];
      ctx.reset = () => { ctx._MS = { sheetId: S, tabName: T, ids: ['p2', 'p1'], tab: 'sms', confirming: true, busy: false }; };
      vm.createContext(ctx);
      vm.runInContext((withKeyer ? keySrc : '') + '\n' + wdSrc + '\nthis._msSendConfirmed=_msSendConfirmed;', ctx);
      ctx.reset();
      return ctx;
    }
    const allSent = () => ({ ok: true, results: [{ participantId: 'p1', sent: true }, { participantId: 'p2', sent: true }] });
    const ctx = makeCtx();
    ctx.respond = () => { throw new TypeError('Failed to fetch'); };   // 서버는 보냈는데 응답이 끊김
    await ctx._msSendConfirmed();
    const k1 = ctx.bodies[0].clientSendId;
    ok('화면: 보낼 때 다시 보내기 키를 싣는다(서버 키 모양)', /^[A-Za-z0-9_-]{16,100}$/.test(k1 || ''));
    ctx.reset(); ctx.respond = allSent;
    await ctx._msSendConfirmed();
    ok('★ 화면: 통신 실패 뒤 창을 다시 열어 같은 내용 = 같은 키', ctx.bodies[1].clientSendId === k1);
    ctx.reset();
    await ctx._msSendConfirmed();
    ok('화면: 모두 보냄이 확인되면 키를 버린다(다음 같은 내용 = 새 발송)', ctx.bodies[2].clientSendId && ctx.bodies[2].clientSendId !== k1);
    const k3 = ctx.bodies[2].clientSendId;
    ctx.reset(); ctx.text = '리뷰 부탁드립니다!'; ctx.respond = () => ({ ok: false, error: '발송에 실패했습니다.' });
    await ctx._msSendConfirmed();
    ok('화면: 글을 고치면 새 키', ctx.bodies[3].clientSendId !== k3);
    const k4 = ctx.bodies[3].clientSendId;
    ctx.reset(); ctx.respond = () => ({ ok: true, results: [{ participantId: 'p1', sent: true }, { participantId: 'p2', sent: false, reason: '수신 거부' }] });
    await ctx._msSendConfirmed();
    ok('화면: 서버 500(전부 실패) 뒤에도 키 유지', ctx.bodies[4].clientSendId === k4);
    ctx.reset(); ctx.respond = allSent;
    await ctx._msSendConfirmed();
    ok('화면: 일부 실패 응답 뒤에도 키 유지(다시 보내면 못 받은 사람에게만)', ctx.bodies[5].clientSendId === k4);
    ctx.reset(); ctx.respond = () => ({ ok: true, results: [{ participantId: 'p1', sent: true }, { participantId: 'p2', sent: false, code: 'manual_send_unknown', reason: 'x' }] });
    await ctx._msSendConfirmed();
    ctx.reset(); ctx.respond = allSent;
    await ctx._msSendConfirmed();
    ok('화면: 결과 모름 응답 뒤에도 키 유지', ctx.bodies[7].clientSendId === ctx.bodies[6].clientSendId);
    ctx.reset(); ctx.respond = () => ({ ok: false, code: 'manual_send_conflict', error: '내용이 달라' });
    await ctx._msSendConfirmed();
    const kc = ctx.bodies[8].clientSendId;
    ctx.reset(); ctx.respond = allSent;
    await ctx._msSendConfirmed();
    ok('화면: 409(같은 키·다른 내용) 뒤에는 새 키(막다른 길 없음)', ctx.bodies[9].clientSendId !== kc);
    ctx.reset(); ctx._MS.tab = 'alimtalk'; ctx.text = '알림톡은 글을 안 본다';
    let rel; ctx.respond = () => new Promise((r) => { rel = r; });
    const pend = ctx._msSendConfirmed();
    const ka = ctx.bodies[10].clientSendId;
    ctx._MS = null;   // 기다리는 동안 창을 닫았다
    rel(allSent()); await pend;
    ctx.reset(); ctx._MS.tab = 'alimtalk'; ctx.respond = allSent;
    await ctx._msSendConfirmed();
    ok('화면: 창을 닫은 뒤 도착한 「모두 보냄」도 키를 정리한다', ctx.bodies[11].clientSendId !== ka);
    ctx.reset(); ctx.respond = () => ({ ok: false, error: 'x' });
    await ctx._msSendConfirmed();
    ctx.reset(); ctx._MS.ids = ['p1', 'p2']; await ctx._msSendConfirmed();
    ok('화면: 고른 줄의 순서만 다르면 같은 키', ctx.bodies[13].clientSendId === ctx.bodies[12].clientSendId);
    ctx.reset(); ctx._MS.ids = ['p1']; await ctx._msSendConfirmed();
    ok('화면: 고른 줄이 다르면 다른 키', ctx.bodies[14].clientSendId !== ctx.bodies[13].clientSendId);

    const old = makeCtx({ withKeyer: false });
    old.respond = allSent;
    await old._msSendConfirmed();
    ok('화면: 키 생성기(api.js)가 없으면 키 없이 종전 요청', !('clientSendId' in old.bodies[0]) && old.bodies[0].kind === 'sms');
    ok('화면: 키 생성은 단일 출처(createCsStaffDraftKey) — 새 생성기 0', /typeof createCsStaffDraftKey==='function'\) _msDraftKeyer\.k=createCsStaffDraftKey\(\)/.test(wd) && !/function _msNewKey/.test(wd));
  }

  /* ── D. 단일 출처 ── */
  {
    const src = fs.readFileSync(path.join(SERVER, 'src/services/manualMessage.service.js'), 'utf8');
    ok('서버 키 모양 = utils/csClientMsgId 단일 출처(정규식 사본 0)', /require\('\.\.\/utils\/csClientMsgId'\)/.test(src) && !/\[A-Za-z0-9_-\]\{16,100\}/.test(src));
    ok('선점(INSERT … ON CONFLICT DO NOTHING)이 공급자 호출보다 앞선다(문자)', (() => {
      const body = fnSrc(src, '_sendManualSmsKeyed', 'async function ');
      return body.indexOf('_claim(') > -1 && body.indexOf('_claim(') < body.indexOf('solapi.sendSms(');
    })());
    ok('선점이 공급자 호출보다 앞선다(알림톡)', (() => {
      const body = fnSrc(src, '_sendManualAlimtalkKeyed', 'async function ');
      return body.indexOf('_claim(') > -1 && body.indexOf('_claim(') < body.indexOf('reminder.sendManual(');
    })());
  }

  console.log(`\n✅ manualMessageSendIdempotency: ${passed}개 통과`);
})().catch((e) => { console.error('❌', e && e.stack || e); process.exit(1); });
