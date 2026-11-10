/**
 * csStaffSendIdempotency.test.js — 결정 362 회귀가드 (migration 221 칸 재사용 · 새 마이그레이션 0)
 * 「직원(관리자·AE)이 1:1문의 답장을 보냈는데 서버엔 저장되고 응답만 못 받아(시간 초과·끊김) 다시 보내면
 *   리뷰어에게 같은 답장이 두 번 가고, 리뷰어 미확인 숫자·실시간 알림도 두 번 간다」를 막는다.
 *
 *   A. 키 규칙 단일 출처(utils/csClientMsgId) — 모양 · 직원 키 `staff:` 접두로 리뷰어 키와 절대 안 겹침 · 비교 규칙
 *   B. 실제 라우트 POST /api/cs/reply (PGlite 실제 SQL)
 *      - 키 없음 = 종전 그대로(두 번 = 두 개 · 실시간 알림 두 번)
 *      - 같은 키 다시 보내기 = 저장 1 · 리뷰어 실시간 알림 1 · 관리자 화면 방송 1 · 리뷰어 미확인 +1 한 번 · 같은 응답 모양(+duplicate)
 *      - 같은 키·다른 글/사진/보낸 사람 = 409 cs_client_msg_conflict(저장 0)
 *      - 같은 방의 리뷰어 메시지와 같은 키 = 서로 섞이지 않음(직원 답장은 새로 저장 · 리뷰어 메시지 무접촉)
 *      - 다른 방이면 같은 키라도 새 답장 · 동시에 두 번 = 하나 · 없는 방 = 404 쓰기 0
 *      - 칸 없는 DB = 키가 있어도 답장 성공(종전 경로) · 23505 최후 방어 갈래
 *   C. 작업보드 [리뷰어에게 메시지](POST /api/trackb/cs/notify-participants → csBridge.postAdminNotice)
 *      - 첫 전송이 일부만 저장된 뒤 응답 유실 → 같은 키 다시 보내기 = 받은 방은 duplicate(새 저장·알림 0) · 못 받은 사람만 새로
 *      - 같은 키·다른 글 = 그 건 실패 + code(화면이 키를 버리는 신호) · 키 없음/카드 통지 = 종전
 *   D. 화면(vm) — C/S 대화창(cs-inquiry.js) · 작업보드 미니 C/S(workdesk-cs-mini.js) · 작업보드 팝업(workdesk.html _rmSend)
 *      서버 저장 뒤 시간 초과/끊김 → 글 그대로 → 다시 보내기 = 같은 키 → 메시지 하나 · 고치면 새 키 · 성공 뒤 새 키
 *      · 409 뒤 새 키(막다른 길 없음) · 다른 계정으로 바뀌면 새 키 · crypto 없는 브라우저도 키 생성
 * 실행: node tests/csStaffSendIdempotency.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:***@127.0.0.1:1/none';
process.env.PUBLIC_API_URL = 'https://api.example.test';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..');
const MIG = (f) => fs.readFileSync(path.join(SERVER, 'migrations', f), 'utf8');
const BASE_MIGS = ['030_cs_inquiry.sql', '077_cs_message_images.sql', '080_cs_message_card.sql', '093_cs_inspect_result_msg.sql'];
const M221 = '221_cs_message_client_id.sql';

let passed = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓ ' + name);
}

// ── 실시간 알림 세기(라우터·서비스가 require 시점에 꺼내 쓰므로 그 전에 바꾼다) ──
const sse = require(path.join(SERVER, 'src/utils/sse'));
const pushes = [];      // 리뷰어에게 가는 실시간 알림
const casts = [];       // 다른 관리자 화면 갱신 방송
sse.emitCsReplyToReviewer = (p8, d) => pushes.push({ p8, d });
sse.broadcast = (ev, d) => casts.push({ ev, d });
sse.emitCsInquiry = () => {};

const pool = require(path.join(SERVER, 'src/db/pool'));
const { logger } = require(path.join(SERVER, 'src/utils/logger'));
const warns = [];
logger.warn = (m) => warns.push(String(m));
const nick = require(path.join(SERVER, 'src/services/adminNickname.service'));
nick.getNicknameMap = async () => ({ 만두: '상담원 만두' });
nick.maskMessages = async (m) => m;

/** PGlite = 연결 하나. 운영 풀처럼 트랜잭션이 서로 끼어들지 않게 연결 단위로 줄을 세운다. */
let db = null;
let chain = Promise.resolve();
function lock() { let release; const p = new Promise((r) => { release = r; }); const prev = chain; chain = prev.then(() => p); return prev.then(() => release); }
const realQuery = async (sql, params) => { const rel = await lock(); try { return await db.query(sql, params); } finally { rel(); } };
const realConnect = async () => { const rel = await lock(); return { query: (sql, params) => db.query(sql, params), release: () => rel() }; };
pool.query = realQuery;
pool.connect = realConnect;

const KEY = require(path.join(SERVER, 'src/utils/csClientMsgId'));
const csRouter = require(path.join(SERVER, 'src/routes/cs.routes'));
const layerOf = (router, method, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
const replyLayer = layerOf(csRouter, 'post', '/reply');
const msgsLayer = layerOf(csRouter, 'get', '/messages');
assert.ok(replyLayer && msgsLayer, '라우트 없음');

function call(layer, { body, query, admin }) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    Promise.resolve(handler({ body: body || {}, query: query || {}, admin: admin || { role: 'admin', name: '만두' }, get: () => 'api.example.test' }, res,
      (e) => (e ? reject(e) : resolve({ status: 404 })))).catch(reject);
  });
}
const reply = (body, admin) => call(replyLayer, { body, admin });
const G = (x) => `https://api.example.test/api/order/guide-image/${x}${'a'.repeat(24)}`;
const K1 = '11111111-2222-4333-8444-555555555555';

async function freshDb({ with221 = true } = {}) {
  db = new PGlite();
  await db.exec(`CREATE TABLE reviewers (phone8 TEXT PRIMARY KEY, name TEXT);`);
  for (const f of BASE_MIGS) await db.exec(MIG(f));
  if (with221) await db.exec(MIG(M221));
}
async function mkThread(phone8 = '12345678', ck = 'S1||탭A', label = '상품 A') {
  return (await db.query(`INSERT INTO cs_threads (reviewer_phone8, reviewer_name, campaign_key, campaign_label, campaign_source)
    VALUES ($1,'홍길동',$2,$3,'review_index') RETURNING id`, [phone8, ck, label])).rows[0].id;
}
const count = async (where = 'TRUE', p = []) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM cs_messages WHERE ${where}`, p)).rows[0].n);
const threadRow = async (id) => (await db.query(`SELECT * FROM cs_threads WHERE id=$1`, [id])).rows[0];

const fnSrc = (src, name, prefix = 'async function ') => {
  const i = src.indexOf(prefix + name + '(');
  assert(i > -1, name + ' 없음');
  let p = src.indexOf('(', i), pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let depth = 0; const j = src.indexOf('{', p);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
  throw new Error(name + ' 본문 끝 못 찾음');
};

(async () => {
  console.log('\n▶ 결정 362 — 직원 1:1문의 답장 다시 보내기 중복 방지\n');

  /* ── A. 키 규칙 단일 출처 ── */
  {
    ok('키 모양: UUID 통과 · 공백/짧은 값/콜론은 키 없음', KEY.normalizeCsClientMsgId(K1) === K1 && KEY.normalizeCsClientMsgId('x y') === '' && KEY.normalizeCsClientMsgId('short') === '' && KEY.normalizeCsClientMsgId('staff:' + K1) === '');
    ok('직원 저장 키 = staff: 접두 · 모양 틀리면 ""', KEY.staffCsClientMsgKey(K1) === 'staff:' + K1 && KEY.staffCsClientMsgKey('nope') === '' && KEY.staffCsClientMsgKey(undefined) === '');
    ok('★ 직원 저장 키는 리뷰어 키 모양에 절대 들어맞지 않는다(만드는 방식만으로 안 겹침)', !KEY.CS_CLIENT_MSG_ID_RE.test(KEY.staffCsClientMsgKey(K1)));
    const row = { senderRole: 'admin', senderName: '만두', msgType: 'text', content: '안내', imageUrls: [G('A')] };
    ok('같은 직원·같은 글·같은 사진 = 같은 답장', KEY.sameStaffCsMessage(row, { senderName: '만두', content: '안내', imageUrls: [G('A')] }));
    ok('보낸 사람·역할·글·사진·종류 중 하나라도 다르면 다른 답장',
      !KEY.sameStaffCsMessage(row, { senderName: '찐빵', content: '안내', imageUrls: [G('A')] })
      && !KEY.sameStaffCsMessage({ ...row, senderRole: 'reviewer' }, { senderName: '만두', content: '안내', imageUrls: [G('A')] })
      && !KEY.sameStaffCsMessage(row, { senderName: '만두', content: '안내!', imageUrls: [G('A')] })
      && !KEY.sameStaffCsMessage(row, { senderName: '만두', content: '안내', imageUrls: [] })
      && !KEY.sameStaffCsMessage({ ...row, msgType: 'inspect_result' }, { senderName: '만두', content: '안내', imageUrls: [G('A')] }));
    const rv = fs.readFileSync(path.join(SERVER, 'src/routes/reviewer.routes.js'), 'utf8');
    ok('리뷰어 보내기(결정 361)도 같은 단일 출처를 쓴다(키 정규식 사본 0)', /require\('\.\.\/utils\/csClientMsgId'\)/.test(rv) && !/\/\^\[A-Za-z0-9_-\]\{16,100\}\$\//.test(rv));
  }

  /* ── B. 실제 라우트 POST /api/cs/reply ── */
  let T1;
  {
    await freshDb();
    T1 = await mkThread();
    pushes.length = 0; casts.length = 0;
    // 키 없음 = 종전(구버전 화면)
    const a1 = await reply({ threadId: T1, content: '키 없는 답장' });
    const a2 = await reply({ threadId: T1, content: '키 없는 답장' });
    ok('키 없음: 두 번 보내면 두 개(종전 동작 불변)', a1.body.ok && a2.body.ok && (await count(`content='키 없는 답장'`)) === 2);
    ok('키 없음: 실시간 알림·방송 두 번 · 저장 칸 NULL · 응답에 duplicate 없음', pushes.length === 2 && casts.length === 2 && (await count('client_msg_id IS NULL')) === 2 && !('duplicate' in a2.body));
    const junk = await reply({ threadId: T1, content: '모양 틀린 키', clientMsgId: 'x y' });
    ok('모양이 틀린 키는 없는 것처럼(종전 경로 · 저장 NULL)', junk.body.ok && (await count(`content='모양 틀린 키' AND client_msg_id IS NULL`)) === 1);

    // 같은 키 다시 보내기
    pushes.length = 0; casts.length = 0;
    const th0 = await threadRow(T1);
    const imgs = [G('P1'), G('P2')];
    const first = await reply({ threadId: T1, content: '확인해 드릴게요', imageUrls: imgs, clientMsgId: K1 });
    const th1 = await threadRow(T1);
    ok('키 있음 첫 답장: 저장 1 · staff: 접두로 기록', first.body.ok === true && (await count(`client_msg_id=$1`, ['staff:' + K1])) === 1 && (await count(`client_msg_id=$1`, [K1])) === 0);
    ok('키 있음 첫 답장: 리뷰어 알림 1 · 방송 1 · 리뷰어 미확인 +1 · 미리보기 갱신', pushes.length === 1 && casts.length === 1 && th1.reviewer_unread_count === th0.reviewer_unread_count + 1 && th1.last_message_preview === '확인해 드릴게요');
    ok('키 있음 첫 답장: 리뷰어 알림 이름 = 리뷰어용(닉네임) · 관리자 응답 = 관리자용', pushes[0].d.senderName === '상담원 만두' && first.body.message.senderName === '상담원 만두' && pushes[0].p8 === '12345678');
    ok('키 있음 첫 답장: 응답 모양 종전(duplicate 없음)', !('duplicate' in first.body) && first.body.message.id);
    const again = await reply({ threadId: T1, content: '확인해 드릴게요', imageUrls: imgs, clientMsgId: K1 });
    const again2 = await reply({ threadId: T1, content: '확인해 드릴게요', imageUrls: imgs, clientMsgId: K1 });
    const th2 = await threadRow(T1);
    ok('★ 같은 키 다시 보내기(2번) → 저장은 여전히 1', (await count(`content='확인해 드릴게요'`)) === 1);
    ok('★ 다시 보내기 = 성공 · 같은 메시지 · duplicate:true', again.status === 200 && again.body.ok === true && again.body.duplicate === true && again.body.message.id === first.body.message.id && again2.body.message.id === first.body.message.id, again.body);
    ok('★ 다시 보내기 응답 모양 = 첫 답장과 같은 칸(+duplicate)', JSON.stringify(Object.keys(again.body.message).sort()) === JSON.stringify(Object.keys(first.body.message).sort()));
    ok('다시 보내기 응답 = 저장된 글·사진·보낸 사람(관리자용 이름)', again.body.message.content === '확인해 드릴게요' && JSON.stringify(again.body.message.imageUrls) === JSON.stringify(imgs) && again.body.message.senderRole === 'admin' && again.body.message.senderName === '상담원 만두');
    ok('★ 다시 보내기 → 리뷰어 실시간 알림·관리자 방송 추가 0', pushes.length === 1 && casts.length === 1, { p: pushes.length, c: casts.length });
    ok('★ 다시 보내기 → 리뷰어 미확인·마지막 시각·미리보기 그대로', th2.reviewer_unread_count === th1.reviewer_unread_count && String(th2.last_message_at) === String(th1.last_message_at) && th2.last_message_preview === th1.last_message_preview);
    ok('사진 주소도 한 번만 저장(사진 2장 · 메시지 1)', (await db.query(`SELECT image_urls FROM cs_messages WHERE client_msg_id=$1`, ['staff:' + K1])).rows[0].image_urls.length === 2);

    // 닫힌 방: 다시 보내기는 방 상태·미확인을 바꾸지 않는다
    await db.query(`UPDATE cs_threads SET status='closed' WHERE id=$1`, [T1]);
    const again3 = await reply({ threadId: T1, content: '확인해 드릴게요', imageUrls: imgs, clientMsgId: K1 });
    ok('다시 보내기는 방 상태를 바꾸지 않는다(닫힘 유지 · 성공)', again3.body.duplicate === true && (await threadRow(T1)).status === 'closed');
    await db.query(`UPDATE cs_threads SET status='open' WHERE id=$1`, [T1]);

    // 같은 키 · 다른 내용/보낸 사람 = 409(접지 않음)
    const before = await count();
    const conf = await reply({ threadId: T1, content: '확인해 드릴게요!!', imageUrls: imgs, clientMsgId: K1 });
    ok('★ 같은 키·다른 글 → 409 cs_client_msg_conflict · 저장 0 · 알림 0', conf.status === 409 && conf.body.ok === false && conf.body.code === 'cs_client_msg_conflict' && /[가-힣]/.test(conf.body.error) && (await count()) === before && pushes.length === 1, conf);
    const conf2 = await reply({ threadId: T1, content: '확인해 드릴게요', imageUrls: [G('P1')], clientMsgId: K1 });
    ok('같은 키·다른 사진 → 409', conf2.status === 409 && (await count()) === before);
    const conf3 = await reply({ threadId: T1, content: '확인해 드릴게요', imageUrls: imgs, clientMsgId: K1 }, { role: 'staff', name: '찐빵' });
    ok('★ 같은 키·다른 직원(로그인명) → 409(다른 사람 답장을 「이미 저장됨」으로 돌려주지 않는다)', conf3.status === 409 && (await count()) === before);

    // 같은 방의 리뷰어 메시지와 같은 키 = 섞이지 않는다
    const RK = 'abcdefabcdefabcdef-rev';
    await db.query(`INSERT INTO cs_messages (thread_id, sender_role, sender_name, content, client_msg_id) VALUES ($1,'reviewer','홍길동','리뷰어 글',$2)`, [T1, RK]);
    const cross = await reply({ threadId: T1, content: '리뷰어 글', clientMsgId: RK });
    ok('★ 리뷰어가 쓴 키와 같은 키의 직원 답장 → 새로 저장(리뷰어 메시지를 성공으로 돌려주지 않음)', cross.body.ok && !cross.body.duplicate && (await count(`content='리뷰어 글'`)) === 2 && (await count(`client_msg_id=$1 AND sender_role='reviewer'`, [RK])) === 1 && (await count(`client_msg_id=$1 AND sender_role='admin'`, ['staff:' + RK])) === 1);

    // 다른 방이면 같은 키라도 새 답장
    const T2 = await mkThread('87654321', 'S2||탭B', '상품 B');
    const other = await reply({ threadId: T2, content: '확인해 드릴게요', imageUrls: imgs, clientMsgId: K1 });
    ok('같은 키라도 다른 방 → 새 답장(유일 범위 = 방)', other.body.ok && !other.body.duplicate && (await count(`thread_id=$1`, [T2])) === 1);

    // 동시에 두 번(같은 키)
    pushes.length = 0; casts.length = 0;
    const K2 = 'scs-lz1abc-0123456789abcdef0123456789abcdef';
    const u0 = (await threadRow(T1)).reviewer_unread_count;
    const [c1, c2] = await Promise.all([
      reply({ threadId: T1, content: '동시에 두 번', clientMsgId: K2 }),
      reply({ threadId: T1, content: '동시에 두 번', clientMsgId: K2 }),
    ]);
    ok('★ 동시에 두 번(같은 키) → 저장 1 · 둘 다 성공 · 같은 메시지 · 하나만 duplicate', (await count(`content='동시에 두 번'`)) === 1 && c1.body.ok && c2.body.ok && c1.body.message.id === c2.body.message.id && [c1.body.duplicate, c2.body.duplicate].filter(Boolean).length === 1);
    ok('★ 동시에 두 번 → 리뷰어 알림 1 · 방송 1 · 미확인 +1', pushes.length === 1 && casts.length === 1 && (await threadRow(T1)).reviewer_unread_count === u0 + 1);

    // 없는 방
    const n0 = await count();
    const nf = await reply({ threadId: '00000000-0000-4000-8000-000000000000', content: '없는 방', clientMsgId: 'n'.repeat(20) });
    ok('키 있음 + 없는 방 → 404 · 쓰기 0', nf.status === 404 && nf.body.ok === false && (await count()) === n0);

    // 대화 조회에 키가 새지 않는다
    // (대화 조회 라우트는 작업 표까지 읽어 이 PGlite 에는 없는 표가 많다 — 조회 문장 자체를 본다)
    const csSrc = fs.readFileSync(path.join(SERVER, 'src/routes/cs.routes.js'), 'utf8');
    const msgSel = (csSrc.match(/SELECT id, sender_role AS "senderRole"[\s\S]*?FROM cs_messages WHERE thread_id = \$1 ORDER BY created_at/) || [''])[0];
    ok('관리자 대화 조회는 칸을 명시해 고르고 client_msg_id 를 내보내지 않는다(SELECT * 없음)', msgSel && !/client_msg_id/.test(msgSel) && !/SELECT \*[^;]*cs_messages/.test(csSrc));
  }

  /* 마이그레이션 전(칸 없음) — 답장은 살아 있어야 한다 */
  {
    await freshDb({ with221: false });
    const T = await mkThread();
    pushes.length = 0; warns.length = 0;
    const r = await reply({ threadId: T, content: '칸 없는 DB', clientMsgId: K1 });
    ok('★ 칸 없는 DB + 키 → 답장 성공(종전 경로) · 크래시 0', r.status === 200 && r.body.ok === true && (await count(`content='칸 없는 DB'`)) === 1, r);
    ok('칸 없는 DB: 리뷰어 알림 1 · 미확인 +1 한 번 · 경고 로그', pushes.length === 1 && (await threadRow(T)).reviewer_unread_count === 1 && warns.some((w) => /client_msg_id/.test(w)));
  }

  /* 23505 최후 방어 갈래(스텁 연결) */
  {
    const stored = { id: 'm-1', senderRole: 'admin', senderName: '만두', msgType: 'text', content: '경합', imageUrls: [], createdAt: '2026-11-10T00:00:00Z' };
    let finds = 0, released = 0;
    const seen = [];
    pool.connect = async () => ({
      query: async (sql) => {
        seen.push(sql.trim().split(/\s+/)[0]);
        if (/FROM cs_threads/.test(sql)) return { rows: [{ id: 't-1', reviewerPhone8: '12345678', campaignLabel: 'x' }] };
        if (/FROM cs_messages/.test(sql)) { finds++; return { rows: finds === 1 ? [] : [stored] }; }
        if (/INSERT INTO cs_messages/.test(sql)) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
        return { rows: [] };
      },
      release: () => { released++; },
    });
    pushes.length = 0;
    const r = await reply({ threadId: 't-1', content: '경합', clientMsgId: K1 });
    ok('23505(다른 요청이 먼저 저장) → 저장된 답장으로 성공 · 알림 0', r.body.ok === true && r.body.duplicate === true && r.body.message.id === 'm-1' && pushes.length === 0, r.body);
    ok('23505 갈래: ROLLBACK 후 같은 연결로 다시 읽고 연결은 한 번 반납 · 방 줄 잠금(FOR UPDATE) 사용', seen.includes('ROLLBACK') && !seen.includes('COMMIT') && released === 1, { seen, released });
    pool.connect = realConnect;
    const src = fs.readFileSync(path.join(SERVER, 'src/routes/cs.routes.js'), 'utf8');
    ok('키 확인은 방 줄 잠금(FOR UPDATE) 뒤 같은 트랜잭션 안', /FROM cs_threads WHERE id = \$1 LIMIT 1 FOR UPDATE[\s\S]{0,400}CS_FIND_STAFF_BY_KEY_SQL/.test(src));
  }

  /* ── C. 작업보드 [리뷰어에게 메시지] ── */
  const CSB = require(path.join(SERVER, 'src/services/csBridge.service'));
  const recip = require(path.join(SERVER, 'src/services/csRecipient.service'));
  const tbRouter = require(path.join(SERVER, 'src/routes/trackB.routes'));
  const notifyLayer = layerOf(tbRouter, 'post', '/cs/notify-participants');
  assert.ok(notifyLayer, 'notify 라우트 없음');
  const notify = (body, admin) => call(notifyLayer, { body, admin });
  let RECIPS = [];
  recip.resolveRecipients = async ({ participantIds }) => participantIds.map((id) => RECIPS.find((r) => r.participantId === id) || { participantId: id, ok: false, reason: '받는 사람 없음' });
  const R1 = { participantId: 'p1', ok: true, seq: 1, name: '가나', rowName: '가나', phone8: '11112222', phoneFull: '01011112222' };
  const R2 = { participantId: 'p2', ok: true, seq: 2, name: '다라', rowName: '다라', phone8: '33334444', phoneFull: '01033334444' };
  const NB = { sheetId: 'SH', tabName: '탭N', participantIds: ['p1', 'p2'], content: '구매 안내드립니다' };
  {
    await freshDb();
    // 키 없음 = 종전
    RECIPS = [R1, R2]; pushes.length = 0;
    await notify(NB); await notify(NB);
    ok('키 없음: 두 번 보내면 방마다 두 개(종전 동작 불변)', (await count(`content='구매 안내드립니다'`)) === 4);
    await db.query(`DELETE FROM cs_messages`); await db.query(`UPDATE cs_threads SET reviewer_unread_count=0`);

    // 첫 전송: p1 만 저장되고 p2 는 그때 실패 → 응답 유실(화면은 실패로 보고 글을 그대로 둔다) → 같은 키로 다시
    const NK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    RECIPS = [R1]; pushes.length = 0; casts.length = 0;
    const f1 = await notify({ ...NB, clientMsgId: NK });
    ok('첫 전송: 받은 사람 1 · 못 받은 사람 1', f1.body.sent.length === 1 && f1.body.failed.length === 1 && !f1.body.sent[0].duplicate);
    RECIPS = [R1, R2];
    const f2 = await notify({ ...NB, clientMsgId: NK });
    const per = (await db.query(`SELECT t.reviewer_phone8 p, COUNT(m.id)::int n, MAX(t.reviewer_unread_count) u FROM cs_threads t LEFT JOIN cs_messages m ON m.thread_id=t.id GROUP BY t.reviewer_phone8 ORDER BY 1`)).rows;
    ok('★ 다시 보내기: 받았던 방은 duplicate(새 저장 0) · 못 받은 사람만 새로 · 둘 다 「보냄」으로 센다',
      f2.body.ok === true && f2.body.sent.length === 2 && f2.body.sent.find((s) => s.participantId === 'p1').duplicate === true && !f2.body.sent.find((s) => s.participantId === 'p2').duplicate, f2.body);
    ok('★ 방마다 메시지 1 · 리뷰어 미확인 1', per.length === 2 && per.every((r) => r.n === 1 && r.u === 1), per);
    ok('★ 다시 보내기에서 받았던 방에는 알림·방송 추가 0(방송은 새로 받은 방 1번만 늘어남)', casts.filter((c) => c.d.reviewerPhone8 === '11112222').length === 1 && casts.filter((c) => c.d.reviewerPhone8 === '33334444').length === 1, casts);
    const f3 = await notify({ ...NB, clientMsgId: NK });
    ok('세 번째도 같은 키 → 둘 다 duplicate · 저장 그대로', f3.body.sent.every((s) => s.duplicate === true) && (await count()) === 2);

    // 같은 키·다른 글 = 그 건 실패 + code
    const f4 = await notify({ ...NB, content: '구매 안내드립니다(수정)', clientMsgId: NK });
    ok('★ 같은 키·다른 글 → 저장 0 · 건별 실패에 code cs_client_msg_conflict(화면이 키를 버리는 신호)', f4.body.ok === false && f4.body.sent.length === 0 && f4.body.failed.length === 2 && f4.body.failed.every((x) => x.code === 'cs_client_msg_conflict' && /[가-힣]/.test(x.reason)) && (await count()) === 2, f4.body);
    const f5 = await notify({ ...NB, clientMsgId: NK }, { role: 'staff', name: '다른AE' });
    ok('같은 키·다른 직원 → 저장 0 · 실패(다른 사람 글을 「이미 보냄」으로 세지 않는다)', f5.body.sent.length === 0 && (await count()) === 2);

    // 서비스 직접: 카드 통지는 키를 쓰지 않는다 · 키 없는 기존 호출부 불변
    const c1 = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭N', phone8: '11112222', message: '카드', by: '만두', clientMsgId: NK, card: { kind: 'x', fileId: 'f'.repeat(12) } });
    ok('카드가 있는 통지는 키를 저장하지 않는다(키는 직원이 쓴 글 전용)', c1 && !c1.duplicate && (await count(`content='카드' AND client_msg_id IS NULL`)) === 1);
    const s1 = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭N', phone8: '11112222', message: '키 없음', by: '만두' });
    const s2 = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭N', phone8: '11112222', message: '키 없음', by: '만두' });
    ok('키 없는 기존 호출부(검수 반려·입금 실패 안내) = 종전(두 번 = 두 개 · duplicate 없음)', s1 && s2 && !s1.duplicate && !s2.duplicate && (await count(`content='키 없음'`)) === 2);

    // 새 방(첫 메시지)에서 동시에 두 번
    const NK2 = 'concurrent-new-room-key-0001';
    const [x1, x2] = await Promise.all([
      CSB.postAdminNotice({ sheetId: 'SH', tabName: '새탭', phone8: '55556666', message: '첫 안내', by: '만두', clientMsgId: NK2 }),
      CSB.postAdminNotice({ sheetId: 'SH', tabName: '새탭', phone8: '55556666', message: '첫 안내', by: '만두', clientMsgId: NK2 }),
    ]);
    ok('★ 새 방에 동시에 두 번(같은 키) → 방 1 · 메시지 1 · 하나만 duplicate', x1 && x2 && x1.messageId === x2.messageId && [x1.duplicate, x2.duplicate].filter(Boolean).length === 1 && (await count(`content='첫 안내'`)) === 1);
  }
  {
    await freshDb({ with221: false });
    warns.length = 0;
    const r = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭N', phone8: '11112222', message: '칸 없음', by: '만두', clientMsgId: K1 });
    ok('★ 칸 없는 DB + 키 → 작업보드 메시지도 종전 경로로 성공 · 경고 로그', r && r.messageId && (await count(`content='칸 없음'`)) === 1 && warns.some((w) => /client_msg_id/.test(w)), r);
  }

  /* ── D. 화면(vm) ── */
  await freshDb();
  const TV = await mkThread();
  const API = fs.readFileSync(path.join(REPO, 'frontend/api.js'), 'utf8');
  const CSI = fs.readFileSync(path.join(REPO, 'frontend/js/cs-inquiry.js'), 'utf8');
  const MINI = fs.readFileSync(path.join(REPO, 'frontend/js/workdesk-cs-mini.js'), 'utf8');
  const WD = fs.readFileSync(path.join(REPO, 'frontend/workdesk.html'), 'utf8');
  ok('api.js: csAdminReply → POST /api/cs/reply', /'csAdminReply':\s*\{ method: 'POST', path: '\/api\/cs\/reply' \}/.test(API));
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const TOKEN_A = 'h.' + b64u({ id: 7, username: 'mandu', name: '만두', role: 'admin' }) + '.s';
  const TOKEN_B = 'h.' + b64u({ id: 8, username: 'jjin', name: '찐빵', role: 'admin' }) + '.s';
  let token = TOKEN_A;
  const adminOfToken = () => (token === TOKEN_A ? { role: 'admin', name: '만두' } : { role: 'admin', name: '찐빵' });
  let mode = 'normal';
  const sentBodies = [];
  // 「서버까지는 갔는데 응답이 끊긴다」: 실제 라우트로 저장시킨 뒤 시간 초과/끊김을 던진다.
  const stubFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sentBodies.push(body);
    const out = await reply(body, adminOfToken());
    if (mode === 'savedThenTimeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (mode === 'savedThenDrop') throw new TypeError('Failed to fetch');
    return { status: out.status, ok: out.status < 400, json: async () => out.body };
  };
  const toasts = [];
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', value: '', style: {}, focus() {}, remove() {}, insertAdjacentHTML() {} });
  const mkCtx = (cryptoImpl, extra) => {
    const ctx = Object.assign({
      console: { warn() {}, error() {}, log() {} }, JSON, String, Date, Math, Array, Object, Uint8Array, TextDecoder, atob, setTimeout, clearTimeout, Promise, AbortController,
      sessionStorage: { getItem: (k) => (k === 'admin_token' ? token : null), setItem() {} },
      document: { getElementById: (id) => els[id] || null, querySelector: () => null },
      API_BASE_URL: 'http://t', fetch: stubFetch,
      _ACTION_MAP: { csAdminReply: { method: 'POST', path: '/api/cs/reply' } },
      _resolveApiPath: (p) => p, _getAuthHeaders: () => ({}),
    }, extra || {});
    if (cryptoImpl !== undefined) ctx.crypto = cryptoImpl;
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(['_csNewClientMsgKey', '_csStaffAccountFp', 'createCsStaffDraftKey', 'apiFriendlyErrorMessage'].map((n) => fnSrc(API, n, 'function ')).join('\n')
      + '\n' + fnSrc(API, 'gasPost') + '\nthis.gasPost = gasPost; this.createCsStaffDraftKey = createCsStaffDraftKey;', ctx);
    return ctx;
  };
  let uuidN = 0;
  const uuidCrypto = { randomUUID: () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++uuidN).padStart(12, '0')}` };
  const nMsg = (c) => count(`content=$1`, [c]);

  // D1. C/S 대화창(cs-inquiry.js csSendReply)
  {
    const keyLine = CSI.match(/const _csReplyDraftKey = \(typeof createCsStaffDraftKey === "function"\) \? createCsStaffDraftKey\(\) : null;/);
    ok('cs-inquiry.js: 대화창 키는 api.js createCsStaffDraftKey 단일 출처', !!keyLine);
    const ctx = mkCtx(uuidCrypto, {
      showToast: (m) => toasts.push(String(m)), csRenderAttachBar() {}, csReloadConversation: async () => {}, loadCsRooms() {},
    });
    vm.runInContext('var _csPending = [];\n' + keyLine[0].replace(/^const /, 'var ') + '\n' + fnSrc(CSI, 'csSendReply') + '\nthis.csSendReply = csSendReply; this.setPending = (p) => { _csPending = p; }; this.getPending = () => _csPending;', ctx);
    el('csReplyText');
    for (const m of ['savedThenTimeout', 'savedThenDrop']) {
      await db.query(`DELETE FROM cs_messages WHERE content='배송 다시 보내드릴게요'`);
      mode = m; toasts.length = 0; sentBodies.length = 0;
      els.csReplyText.value = '배송 다시 보내드릴게요';
      ctx.setPending([{ url: G('Z1') }]);
      await ctx.csSendReply(TV);
      ok(`[대화창 · ${m}] 첫 답장: 서버엔 저장(1) · 화면은 실패 안내 · 글·사진 그대로`, (await nMsg('배송 다시 보내드릴게요')) === 1 && toasts.some((t) => /전송 오류/.test(t)) && els.csReplyText.value === '배송 다시 보내드릴게요' && ctx.getPending().length === 1, { toasts, v: els.csReplyText.value });
      mode = 'normal';
      await ctx.csSendReply(TV);
      ok(`★ [대화창 · ${m}] 다시 보내기 = 같은 키 → 답장 하나`, sentBodies.length === 2 && sentBodies[0].clientMsgId && sentBodies[0].clientMsgId === sentBodies[1].clientMsgId && (await nMsg('배송 다시 보내드릴게요')) === 1, sentBodies.map((b) => b.clientMsgId));
      ok(`[대화창 · ${m}] 다시 보내기 성공 → 입력칸·첨부 비움`, els.csReplyText.value === '' && ctx.getPending().length === 0);
    }
    sentBodies.length = 0;
    els.csReplyText.value = '배송 다시 보내드릴게요'; ctx.setPending([{ url: G('Z1') }]);
    await ctx.csSendReply(TV);
    ok('[대화창] 성공 뒤 같은 글을 또 보내면 새 키 · 새 답장(의도한 두 번째)', (await nMsg('배송 다시 보내드릴게요')) === 2);
    // 실패 뒤 글을 고치면 새 키
    mode = 'savedThenTimeout'; sentBodies.length = 0;
    els.csReplyText.value = '환불은 3일 걸려요'; ctx.setPending([]);
    await ctx.csSendReply(TV);
    mode = 'normal';
    els.csReplyText.value = '환불은 3~5일 걸려요';
    await ctx.csSendReply(TV);
    ok('[대화창] 실패 뒤 글을 고치면 새 키 → 고친 글도 저장(조용히 버리지 않음)', sentBodies[0].clientMsgId !== sentBodies[1].clientMsgId && (await count(`content LIKE '환불은%'`)) === 2);
    // 409 → 키를 버려 다음 누름은 새 답장
    sentBodies.length = 0; toasts.length = 0;
    els.csReplyText.value = '충돌 시험'; mode = 'savedThenTimeout';
    await ctx.csSendReply(TV);
    await db.query(`UPDATE cs_messages SET content='충돌 시험(서버에서 바뀐 것처럼)' WHERE content='충돌 시험'`);
    mode = 'normal';
    await ctx.csSendReply(TV);
    ok('[대화창] 409 충돌 → 실패 안내 · 글 그대로', toasts.some((t) => /내용이 바뀌었어요/.test(t)) && els.csReplyText.value === '충돌 시험');
    await ctx.csSendReply(TV);
    ok('★ [대화창] 409 뒤 다음 [보내기]는 새 키로 성공(막다른 길 없음)', sentBodies.length === 3 && sentBodies[2].clientMsgId !== sentBodies[1].clientMsgId && els.csReplyText.value === '' && (await nMsg('충돌 시험')) === 1);
    // 다른 계정으로 바뀌면 새 키
    sentBodies.length = 0;
    els.csReplyText.value = '계정 바뀜 시험'; mode = 'savedThenTimeout';
    await ctx.csSendReply(TV);
    token = TOKEN_B; mode = 'normal';
    await ctx.csSendReply(TV);
    token = TOKEN_A;
    ok('[대화창] 실패 뒤 다른 계정으로 바뀌면 같은 글이라도 새 키(다른 직원 답장으로 저장 · 409 막다른 길 없음)', sentBodies[0].clientMsgId !== sentBodies[1].clientMsgId && (await count(`content='계정 바뀜 시험' AND sender_name='찐빵'`)) === 1);
    // crypto 없는 브라우저
    for (const [label, c] of [['crypto 없음', undefined], ['getRandomValues 만', { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255; return a; } }]]) {
      const cx = mkCtx(c);
      if (c === undefined) delete cx.crypto;
      const k = vm.runInContext('createCsStaffDraftKey().keyFor(["t","x",[]])', cx);
      ok(`${label}: 키 생성 · 서버 키 모양(16~100자 영숫자-_)`, /^[A-Za-z0-9_-]{16,100}$/.test(k || ''), k);
    }
  }

  // D2. 작업보드 미니 C/S(workdesk-cs-mini.js send)
  {
    const keyLine = MINI.match(/const draftKey = \(typeof createCsStaffDraftKey === 'function'\) \? createCsStaffDraftKey\(\) : null;/);
    const reqErr = MINI.match(/const requestError = \(data, fallback\) => \{[\s\S]*?\n  \};/);
    ok('workdesk-cs-mini.js: 키는 api.js createCsStaffDraftKey 단일 출처', !!keyLine && !!reqErr);
    const notes = [];
    const ctx = mkCtx(uuidCrypto, { showToast: (m, e) => notes.push(String(m)) });
    vm.runInContext(`var state = { activeThreadId: ${JSON.stringify(String(TV))}, pendingImages: [], draft: '', sending: false };
      var input = { value: '' };
      var pendingImages = () => state.pendingImages;
      var render = () => {}; var openRoom = async () => {}; var loadRooms = async () => {}; var host = () => null;
      var notify = (m) => showToast(m, true);
      ${reqErr[0].replace(/^const /, 'var ')}
      ${keyLine[0].replace(/^const /, 'var ')}
      ${fnSrc(MINI, 'send')}
      this.miniSend = () => send({ preventDefault() {}, currentTarget: { querySelector: () => input } });
      this.miniInput = input; this.miniState = state;`, ctx);
    mode = 'savedThenDrop'; sentBodies.length = 0;
    ctx.miniInput.value = '작업보드에서 답장';
    await ctx.miniSend();
    ok('[미니] 첫 답장: 서버엔 저장 · 실패 안내 · 초안 그대로', (await nMsg('작업보드에서 답장')) === 1 && ctx.miniState.draft === '작업보드에서 답장' && notes.some((t) => /전송 오류/.test(t)));
    mode = 'normal';
    ctx.miniInput.value = ctx.miniState.draft;
    await ctx.miniSend();
    ok('★ [미니] 다시 보내기 = 같은 키 → 답장 하나', sentBodies.length === 2 && sentBodies[0].clientMsgId === sentBodies[1].clientMsgId && (await nMsg('작업보드에서 답장')) === 1);
    ctx.miniInput.value = '작업보드에서 답장';
    await ctx.miniSend();
    ok('[미니] 성공 뒤 같은 글 → 새 키 · 새 답장', sentBodies[2].clientMsgId !== sentBodies[1].clientMsgId && (await nMsg('작업보드에서 답장')) === 2);
  }

  // D3. 작업보드 팝업 [리뷰어에게 메시지](workdesk.html _rmSend)
  {
    ok('workdesk.html: 팝업 키는 api.js createCsStaffDraftKey 단일 출처(늦게 만든다 — api.js 가 뒤에 실림)',
      /function _rmDraftKeyer\(\)\{ if\(!_rmDraftKeyer\.k&&typeof createCsStaffDraftKey==='function'\)/.test(WD) && WD.indexOf('function _rmDraftKeyer') < WD.indexOf('<script src="api.js"></script>'));
    let rmMode = 'normal';
    const rmBodies = [];
    const ctx = mkCtx(uuidCrypto, {
      toast() {}, esc: (s) => String(s), _rmPaintFoot() {}, _rmPlace() {},
      api: async (p, opts) => {
        assert.strictEqual(p, '/api/trackb/cs/notify-participants');
        const body = JSON.parse(opts.body);
        rmBodies.push(body);
        const out = await notify(body, adminOfToken());
        if (rmMode === 'savedThenDrop') throw new TypeError('Failed to fetch');
        return out.body;
      },
    });
    vm.runInContext(`var _RM = null; var rendered = 0; function _rmRenderResult(){ rendered++; }
      ${fnSrc(WD, '_rmDraftKeyer', 'function ')}
      ${fnSrc(WD, '_rmSettleKey', 'function ')}
      ${fnSrc(WD, '_rmSendable', 'function ')}
      ${fnSrc(WD, '_rmSend')}
      this.rmOpen = () => { _RM = { sheetId: 'SH', tabName: '탭N', items: [${JSON.stringify(R1)}, ${JSON.stringify(R2)}], files: [] }; };
      this.rmSend = _rmSend; this.rmRendered = () => rendered; this.rmState = () => _RM;`, ctx);
    el('rmText');
    RECIPS = [R1, R2];
    ctx.rmOpen();
    els.rmText.value = '팝업 안내';
    rmMode = 'savedThenDrop';
    await ctx.rmSend();
    ok('[팝업] 첫 전송: 서버엔 방마다 저장 · 화면은 실패(결과 화면 안 그림) · 글 그대로', (await nMsg('팝업 안내')) === 2 && ctx.rmRendered() === 0 && els.rmText.value === '팝업 안내');
    rmMode = 'normal';
    await ctx.rmSend();
    ok('★ [팝업] 다시 보내기 = 같은 키 → 방마다 하나 · 결과 화면 「보냄」 2', rmBodies.length === 2 && rmBodies[0].clientMsgId && rmBodies[0].clientMsgId === rmBodies[1].clientMsgId && (await nMsg('팝업 안내')) === 2 && ctx.rmRendered() === 1);
    ctx.rmOpen();
    await ctx.rmSend();
    ok('[팝업] 성공 뒤 같은 글을 같은 사람에게 또 → 새 키 · 새 메시지(의도한 두 번째)', rmBodies[2].clientMsgId !== rmBodies[1].clientMsgId && (await nMsg('팝업 안내')) === 4);
    // 409 계열 → 키를 버린다
    ctx.rmOpen(); els.rmText.value = '팝업 충돌'; rmMode = 'savedThenDrop';
    await ctx.rmSend();
    await db.query(`UPDATE cs_messages SET content='팝업 충돌(바뀜)' WHERE content='팝업 충돌'`);
    rmMode = 'normal';
    await ctx.rmSend();
    ok('[팝업] 같은 키·다른 저장 내용 → 전부 실패(결과 화면 안 그림)', ctx.rmRendered() === 2 && (await nMsg('팝업 충돌')) === 0);
    await ctx.rmSend();
    ok('★ [팝업] 충돌 뒤 다음 [보내기]는 새 키로 성공(막다른 길 없음)', rmBodies[5].clientMsgId !== rmBodies[4].clientMsgId && (await nMsg('팝업 충돌')) === 2 && ctx.rmRendered() === 3);
  }

  console.log(`\ncsStaffSendIdempotency: ${passed} tests passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
