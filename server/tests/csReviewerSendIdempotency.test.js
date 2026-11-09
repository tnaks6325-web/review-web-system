/**
 * csReviewerSendIdempotency.test.js — 결정 361 회귀가드 (migration 221)
 * 「1:1문의 [보내기]가 서버엔 저장됐는데 응답만 못 받아(시간 초과·끊김) 다시 보내면 같은 글이 두 번 남는다」를 막는다.
 *
 *   A. migration 221 — 실제 SQL(PGlite): 두 번 돌려도 안전 · 기존 행 무접촉(NULL) · 부분 유일 색인((방, 키) 한 번 · NULL 여러 개 허용)
 *   B. 실제 라우트 POST /api/reviewer/cs/message (PGlite)
 *      - 키 없음 = 종전 그대로(두 번 보내면 두 개 · 알림 두 번)
 *      - 같은 키 다시 보내기 = 저장 1 · 관리자 알림 1 · 웹훅 1 · 미확인 +1 한 번 · 같은 응답 모양(+duplicate:true)
 *      - 같은 키·다른 내용 = 409 cs_client_msg_conflict(저장 0 · 접어서 성공 금지)
 *      - 같은 키라도 다른 방이면 새 메시지(유일 범위 = 방)
 *      - 동시에 두 번(같은 키) = 하나만 저장 · 둘 다 같은 메시지로 성공
 *      - 칸이 없는 DB(마이그레이션 전) = 키가 있어도 보내기는 성공(종전 경로로 접힘 · 크래시 0)
 *      - 23505(유일 색인 최후 방어) 갈래 = 저장된 쪽을 다시 읽어 성공
 *   C. 화면(reviewer-cs.js + api.js gasPost, vm) — 서버 저장 뒤 시간 초과 → 글 그대로 → 다시 보내기 = 같은 키 → 메시지 하나
 *      · 글을 고치면 새 키 · 성공 뒤 같은 글을 또 보내면 새 키 · crypto 없는 브라우저도 키 생성
 *   D. (선택) 실제 PostgreSQL 동시 접속 — CS_IDEM_NATIVE_PG_TEST=1 일 때만: 둘째 전송이 첫째의 방 줄 잠금을 실제로 기다리고 저장 1건.
 * 실행: node tests/csReviewerSendIdempotency.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { console.log('⏭ PGlite 없음 — 건너뜀'); process.exit(0); }

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:x@127.0.0.1:1/none';
process.env.PUBLIC_API_URL = 'https://api.example.test';
process.env.CS_INQUIRY_WEBHOOK_URL = 'https://hook.example.test/cs';

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

// ── 관리자 알림·웹훅 세기(라우터가 require 시점에 꺼내 쓰므로 그 전에 바꾼다) ──
const sse = require(path.join(SERVER, 'src/utils/sse'));
const notices = [];
sse.emitCsInquiry = (d) => notices.push(d);
const hooks = [];
global.fetch = async (url, opts) => { hooks.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };

const pool = require(path.join(SERVER, 'src/db/pool'));
const { logger } = require(path.join(SERVER, 'src/utils/logger'));
const warns = [];
logger.warn = (m) => warns.push(String(m));

/** PGlite = 연결 하나. 운영 풀처럼 트랜잭션이 서로 끼어들지 않게 연결 단위로 줄을 세운다. */
let db = null;
let chain = Promise.resolve();
function lock() { let release; const p = new Promise((r) => { release = r; }); const prev = chain; chain = prev.then(() => p); return prev.then(() => release); }
pool.query = async (sql, params) => { const rel = await lock(); try { return await db.query(sql, params); } finally { rel(); } };
pool.connect = async () => {
  const rel = await lock();
  return { query: (sql, params) => db.query(sql, params), release: () => rel() };
};

const router = require(path.join(SERVER, 'src/routes/reviewer.routes'));
const sendLayer = router.stack.find((l) => l.route && l.route.path === '/cs/message' && l.route.methods.post);
const msgsLayer = router.stack.find((l) => l.route && l.route.path === '/cs/messages' && l.route.methods.get);
assert.ok(sendLayer && msgsLayer, '라우트 없음');
require(path.join(SERVER, 'src/services/adminNickname.service')).maskMessages = async (m) => m;

function call(layer, { body, query }) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    Promise.resolve(handler({ body: body || {}, query: query || {}, get: () => 'api.example.test' }, res, (e) => (e ? reject(e) : resolve({ status: 404 })))).catch(reject);
  });
}
const send = (body) => call(sendLayer, { body });
const G = (x) => `https://api.example.test/api/order/guide-image/${x}${'a'.repeat(24)}`;
const base = { phone8: '12345678', name: '홍길동', campaignKey: 'S1||탭A', campaignLabel: '상품 A', campaignSource: 'review_index' };
const KEY = '11111111-2222-4333-8444-555555555555';

async function freshDb({ with221 = true } = {}) {
  db = new PGlite();
  await db.exec(`CREATE TABLE reviewers (phone8 TEXT PRIMARY KEY, name TEXT);`);
  for (const f of BASE_MIGS) await db.exec(MIG(f));
  if (with221) await db.exec(MIG(M221));
  await db.query(`INSERT INTO reviewers (phone8, name) VALUES ('12345678', '홍길동') ON CONFLICT DO NOTHING`);
}
const count = async (where = 'TRUE', p = []) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM cs_messages WHERE ${where}`, p)).rows[0].n);
const thread = async (ck = base.campaignKey) => (await db.query(`SELECT * FROM cs_threads WHERE reviewer_phone8='12345678' AND campaign_key=$1`, [ck])).rows[0];

(async () => {
  console.log('\n▶ 결정 361 — 1:1문의 다시 보내기 중복 방지\n');

  /* ── A. migration 221 ── */
  {
    await freshDb({ with221: false });
    const t = (await db.query(`INSERT INTO cs_threads (reviewer_phone8, campaign_key) VALUES ('99999999','') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO cs_messages (thread_id, sender_role, content) VALUES ($1,'reviewer','옛 글'),($1,'admin','옛 답장')`, [t]);
    await db.exec(MIG(M221));
    await db.exec(MIG(M221));
    ok('221 을 두 번 돌려도 오류 없음(IF NOT EXISTS)', true);
    const old = (await db.query(`SELECT content, client_msg_id FROM cs_messages ORDER BY content`)).rows;
    ok('기존 행은 그대로 · 새 칸은 NULL', old.length === 2 && old.every((r) => r.client_msg_id === null) && old.map((r) => r.content).sort().join() === ['옛 글', '옛 답장'].sort().join(), old);
    const col = (await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='cs_messages' AND column_name='client_msg_id'`)).rows[0];
    ok('칸 = TEXT · NULL 허용 · 기본값 없음(표 재작성 없음)', col && col.data_type === 'text' && col.is_nullable === 'YES' && col.column_default === null, col);
    const idx = (await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname='uq_cs_messages_thread_client_msg'`)).rows[0];
    ok('부분 유일 색인 (thread_id, client_msg_id) WHERE client_msg_id IS NOT NULL', idx && /UNIQUE/.test(idx.indexdef) && /\(thread_id, client_msg_id\)/.test(idx.indexdef) && /client_msg_id IS NOT NULL/.test(idx.indexdef), idx);
    await db.query(`INSERT INTO cs_messages (thread_id, sender_role, content) VALUES ($1,'reviewer','키 없음 1'),($1,'reviewer','키 없음 2')`, [t]);
    ok('키 없는(NULL) 행은 여러 개 가능', (await count('client_msg_id IS NULL')) === 4);
    await db.query(`INSERT INTO cs_messages (thread_id, sender_role, content, client_msg_id) VALUES ($1,'reviewer','a',$2)`, [t, KEY]);
    let code = null;
    try { await db.query(`INSERT INTO cs_messages (thread_id, sender_role, content, client_msg_id) VALUES ($1,'reviewer','b',$2)`, [t, KEY]); } catch (e) { code = e.code; }
    ok('같은 방·같은 키 두 번째 행은 DB 가 거절(23505)', code === '23505', code);
    const sql = MIG(M221);
    ok('221 은 더하기만(DROP·RENAME·UPDATE·DELETE 없음)', !/\b(DROP|RENAME|UPDATE|DELETE)\b/i.test(sql.replace(/--.*$/gm, '')));
    const idxJs = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
    ok('부팅 필수 칸 목록(REQUIRED_SCHEMA)에 cs_messages.client_msg_id', /\['cs_messages', 'client_msg_id'\]/.test(idxJs));
  }

  /* ── B. 실제 라우트 ── */
  {
    await freshDb();
    notices.length = 0; hooks.length = 0;
    // 키 없음 = 종전(구버전 화면)
    const a1 = await send({ ...base, content: '키 없는 글' });
    const a2 = await send({ ...base, content: '키 없는 글' });
    ok('키 없음: 두 번 보내면 두 개(종전 동작 불변)', a1.body.ok && a2.body.ok && (await count(`content='키 없는 글'`)) === 2);
    ok('키 없음: 알림·웹훅 두 번(종전)', notices.length === 2 && hooks.length === 2);
    ok('키 없음: 응답 모양 종전(duplicate 없음)', !('duplicate' in a2.body) && a2.body.message && a2.body.threadId);
    ok('키 없음: 저장 칸 NULL', (await count(`client_msg_id IS NULL`)) === 2);
    const junk = await send({ ...base, content: '모양 틀린 키', clientMsgId: 'x y' });
    ok('모양이 틀린 키는 없는 것처럼(종전 경로 · 저장 NULL)', junk.body.ok && (await count(`content='모양 틀린 키' AND client_msg_id IS NULL`)) === 1);

    // 같은 키 다시 보내기
    notices.length = 0; hooks.length = 0;
    const unread0 = (await thread()).admin_unread_count;
    const imgs = [G('P1'), G('P2')];
    const first = await send({ ...base, content: '배송이 안 왔어요', imageUrls: imgs, clientMsgId: KEY });
    const th1 = await thread();
    ok('키 있음 첫 전송: 저장 1 · 키 기록', first.body.ok === true && (await count(`client_msg_id=$1`, [KEY])) === 1);
    ok('키 있음 첫 전송: 알림 1 · 웹훅 1 · 미확인 +1', notices.length === 1 && hooks.length === 1 && th1.admin_unread_count === unread0 + 1, { n: notices.length, h: hooks.length, u: th1.admin_unread_count });
    ok('키 있음 첫 전송: 응답에 duplicate 없음(종전 모양)', !('duplicate' in first.body));
    const again = await send({ ...base, content: '배송이 안 왔어요', imageUrls: imgs, clientMsgId: KEY });
    const again2 = await send({ ...base, content: '배송이 안 왔어요', imageUrls: imgs, clientMsgId: KEY });
    const th2 = await thread();
    ok('★ 같은 키 다시 보내기(2번) → 저장은 여전히 1', (await count(`content='배송이 안 왔어요'`)) === 1);
    ok('★ 다시 보내기 = 성공 · 같은 메시지 · duplicate:true', again.status === 200 && again.body.ok === true && again.body.duplicate === true && again.body.message.id === first.body.message.id && again2.body.message.id === first.body.message.id, again.body);
    ok('★ 다시 보내기 응답 모양 = 첫 전송과 같은 칸(+duplicate)', JSON.stringify(Object.keys(again.body.message).sort()) === JSON.stringify(Object.keys(first.body.message).sort()) && again.body.threadId === first.body.threadId);
    ok('다시 보내기 응답 = 저장된 글·사진', again.body.message.content === '배송이 안 왔어요' && JSON.stringify(again.body.message.imageUrls) === JSON.stringify(imgs) && again.body.message.senderRole === 'reviewer');
    ok('★ 다시 보내기 → 관리자 알림·웹훅 추가 0', notices.length === 1 && hooks.length === 1, { n: notices.length, h: hooks.length });
    ok('★ 다시 보내기 → 미확인 숫자·마지막 시각·미리보기 그대로(되돌림)', th2.admin_unread_count === th1.admin_unread_count && String(th2.last_message_at) === String(th1.last_message_at) && th2.last_message_preview === th1.last_message_preview, { th1: th1.admin_unread_count, th2: th2.admin_unread_count });
    const imgRows = (await db.query(`SELECT image_urls FROM cs_messages WHERE client_msg_id=$1`, [KEY])).rows;
    ok('사진 주소도 한 번만 저장(사진 2장 · 메시지 1)', imgRows.length === 1 && imgRows[0].image_urls.length === 2);

    // 닫힌 방: 첫 전송이 저장된 뒤 담당자가 방을 닫았다면 다시 보내기는 방을 다시 열지 않는다(이미 전달됨)
    await db.query(`UPDATE cs_threads SET status='closed' WHERE id=$1`, [th1.id]);
    const again3 = await send({ ...base, content: '배송이 안 왔어요', imageUrls: imgs, clientMsgId: KEY });
    ok('다시 보내기는 방 상태를 바꾸지 않는다(닫힘 유지 · 성공)', again3.body.duplicate === true && (await thread()).status === 'closed');
    await db.query(`UPDATE cs_threads SET status='open' WHERE id=$1`, [th1.id]);

    // 같은 키 · 다른 내용 = 409(접지 않음)
    const before = await count();
    const conf = await send({ ...base, content: '배송이 안 왔어요!!', imageUrls: imgs, clientMsgId: KEY });
    ok('★ 같은 키·다른 글 → 409 cs_client_msg_conflict · 저장 0 · 알림 0', conf.status === 409 && conf.body.ok === false && conf.body.code === 'cs_client_msg_conflict' && /[가-힣]/.test(conf.body.error) && (await count()) === before && notices.length === 1, conf);
    const conf2 = await send({ ...base, content: '배송이 안 왔어요', imageUrls: [G('P1')], clientMsgId: KEY });
    ok('같은 키·다른 사진 → 409', conf2.status === 409 && (await count()) === before);

    // 다른 방이면 같은 키라도 새 메시지
    const other = await send({ ...base, campaignKey: 'S2||탭B', campaignLabel: '상품 B', content: '배송이 안 왔어요', imageUrls: imgs, clientMsgId: KEY });
    ok('같은 키라도 다른 방 → 새 메시지(유일 범위 = 방)', other.body.ok && !other.body.duplicate && other.body.threadId !== first.body.threadId && (await count()) === before + 1);

    // 동시에 두 번(같은 키)
    notices.length = 0; hooks.length = 0;
    const K2 = 'rcs-lz1abc-0123456789abcdef0123456789abcdef';
    const u0 = (await thread()).admin_unread_count;
    const [c1, c2] = await Promise.all([
      send({ ...base, content: '동시에 두 번', clientMsgId: K2 }),
      send({ ...base, content: '동시에 두 번', clientMsgId: K2 }),
    ]);
    ok('★ 동시에 두 번(같은 키) → 저장 1', (await count(`content='동시에 두 번'`)) === 1);
    ok('★ 동시에 두 번 → 둘 다 성공 · 같은 메시지 · 하나만 duplicate', c1.body.ok && c2.body.ok && c1.body.message.id === c2.body.message.id && [c1.body.duplicate, c2.body.duplicate].filter(Boolean).length === 1);
    ok('★ 동시에 두 번 → 알림 1 · 웹훅 1 · 미확인 +1', notices.length === 1 && hooks.length === 1 && (await thread()).admin_unread_count === u0 + 1);

    // 새 방(첫 문의)에서 키 있는 전송 — 방 만들기도 한 번
    const fresh = await send({ ...base, campaignKey: 'S3||탭C', campaignLabel: '상품 C', content: '첫 문의', clientMsgId: 'k'.repeat(20) });
    const fresh2 = await send({ ...base, campaignKey: 'S3||탭C', campaignLabel: '상품 C', content: '첫 문의', clientMsgId: 'k'.repeat(20) });
    const t3 = await thread('S3||탭C');
    ok('첫 문의 방: 다시 보내기 → 방 1 · 메시지 1 · 미확인 1', fresh.body.ok && fresh2.body.duplicate === true && t3.admin_unread_count === 1 && (await count(`thread_id=$1`, [t3.id])) === 1);
    ok('첫 문의 알림은 새 문의(isNew) 한 번', notices.filter((n) => n.threadId === t3.id).length === 1 && notices.find((n) => n.threadId === t3.id).isNew === true);

    // 대화 조회에 키가 새지 않는다(응답 칸 명시 SELECT)
    const msgs = await call(msgsLayer, { query: { phone8: '12345678', threadId: first.body.threadId } });
    ok('대화 조회 응답에 client_msg_id 칸 없음', msgs.body.ok && msgs.body.messages.length && msgs.body.messages.every((m) => !('client_msg_id' in m) && !('clientMsgId' in m)));
  }

  /* 마이그레이션 전(칸 없음) — 보내기는 살아 있어야 한다 */
  {
    await freshDb({ with221: false });
    notices.length = 0; warns.length = 0;
    const r = await send({ ...base, content: '칸 없는 DB', clientMsgId: KEY });
    ok('★ 칸 없는 DB + 키 → 보내기 성공(종전 경로) · 크래시 0', r.status === 200 && r.body.ok === true && (await count(`content='칸 없는 DB'`)) === 1, r);
    ok('칸 없는 DB: 알림 1 · 경고 로그', notices.length === 1 && warns.some((w) => /client_msg_id/.test(w)));
    ok('칸 없는 DB: 미확인 +1 한 번(트랜잭션 되돌림 후 종전 경로 1회)', (await thread()).admin_unread_count === 1);
    const r2 = await send({ ...base, content: '칸 없는 DB 키 없음' });
    ok('칸 없는 DB + 키 없음 → 종전대로 성공', r2.body.ok === true);
  }

  /* 23505 최후 방어 갈래(스텁 연결) */
  {
    const saved = { connect: pool.connect, query: pool.query };
    const stored = { id: 'm-1', senderName: '홍길동', content: '경합', imageUrls: [], createdAt: '2026-11-10T00:00:00Z' };
    let finds = 0, released = 0;
    const seen = [];
    pool.query = async (sql) => { if (/FROM reviewers/.test(sql)) return { rows: [{ name: '홍길동' }] }; throw new Error('unexpected pool.query ' + sql); };
    pool.connect = async () => ({
      query: async (sql) => {
        seen.push(sql.trim().split(/\s+/)[0]);
        if (/INSERT INTO cs_threads/.test(sql)) return { rows: [{ id: 't-1', isNew: false }] };
        if (/FROM cs_messages/.test(sql)) { finds++; return { rows: finds === 1 ? [] : [stored] }; }
        if (/INSERT INTO cs_messages/.test(sql)) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
        return { rows: [] };
      },
      release: () => { released++; },
    });
    notices.length = 0;
    const r = await send({ ...base, content: '경합', clientMsgId: KEY });
    ok('23505(다른 요청이 먼저 저장) → 저장된 메시지로 성공 · 알림 0', r.body.ok === true && r.body.duplicate === true && r.body.message.id === 'm-1' && notices.length === 0, r.body);
    ok('23505 갈래: ROLLBACK 후 같은 연결로 다시 읽고 연결은 한 번 반납', seen.includes('ROLLBACK') && !seen.includes('COMMIT') && released === 1, { seen, released });
    pool.connect = saved.connect; pool.query = saved.query;
  }

  /* ── C. 화면(vm) — 서버 저장 뒤 시간 초과 → 다시 보내기 ── */
  {
    await freshDb();
    notices.length = 0;
    const API = fs.readFileSync(path.join(REPO, 'frontend/api.js'), 'utf8');
    const CS = fs.readFileSync(path.join(REPO, 'frontend/js/reviewer-cs.js'), 'utf8');
    ok('api.js: csReviewerSend → POST /api/reviewer/cs/message', /'csReviewerSend':\s*\{ method: 'POST', path: '\/api\/reviewer\/cs\/message' \}/.test(API));
    const fnSrc = (src, name, prefix = 'async function ') => {
      const i = src.indexOf(prefix + name + '(');
      assert(i > -1, name + ' 없음');
      let p = src.indexOf('(', i), pd = 0;
      for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
      let depth = 0; const j = src.indexOf('{', p);
      for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
      throw new Error(name + ' 본문 끝 못 찾음');
    };
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, innerHTML: '', value: '', textContent: '', disabled: false, style: {}, scrollTop: 0, scrollHeight: 0, addEventListener() {}, appendChild() {} });
    ['rcsOverlay', 'rcsInput', 'rcsSendBtn', 'rcsAttachBar', 'rcsThread', 'rcsTabDot'].forEach(el);
    const toasts = [];
    const sentBodies = [];
    // 「서버까지는 갔는데 응답이 끊긴다」: 실제 라우트로 저장시킨 뒤 AbortError(시간 초과)를 던진다.
    let mode = 'normal';
    const stubFetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      sentBodies.push(body);
      const out = await send(body);
      if (mode === 'savedThenTimeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (mode === 'savedThenDrop') throw new TypeError('Failed to fetch');
      return { status: out.status, ok: out.status < 400, json: async () => out.body };
    };
    const window = { getSavedUser: () => ({ name: '홍길동', phone8: '12345678' }) };
    const mkCtx = (cryptoImpl) => {
      const ctx = {
        window, console: { warn() {}, error() {}, log() {} }, JSON, String, Date, Math, Array, Uint8Array, setTimeout, clearTimeout, Promise, AbortController,
        document: { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => el('x' + Math.random()), body: { appendChild() {} }, addEventListener() {} },
        setInterval: () => 0, EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
        localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null, setItem() {} },
        showToast: (m) => toasts.push(String(m)), alert: (m) => toasts.push(String(m)),
        API_BASE_URL: 'http://t', fetch: stubFetch,
        _ACTION_MAP: { csReviewerSend: { method: 'POST', path: '/api/reviewer/cs/message' } },
        _resolveApiPath: (p) => p, _getAuthHeaders: () => ({}),
        gasGet: async (p) => (p.action === 'csReviewerMessages'
          ? (await call(msgsLayer, { query: { phone8: p.phone8, threadId: p.threadId, campaignKey: p.campaignKey } })).body
          : { ok: true, totalUnread: 0 }),
      };
      if (cryptoImpl !== undefined) ctx.crypto = cryptoImpl;
      vm.createContext(ctx);
      vm.runInContext(fnSrc(API, 'apiFriendlyErrorMessage', 'function ') + '\n' + fnSrc(API, 'gasPost') + '\nthis.gasPost = gasPost;', ctx);
      vm.runInContext(CS, ctx);
      return ctx;
    };
    let uuidN = 0;
    mkCtx({ randomUUID: () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++uuidN).padStart(12, '0')}` });
    const RCS = window.ReviewerCS;
    await RCS.openChat(base.campaignKey, base.campaignLabel, base.campaignSource, null);
    const n = () => count(`content=$1`, ['상품이 파손됐어요']);

    for (const m of ['savedThenTimeout', 'savedThenDrop']) {
      await db.query(`DELETE FROM cs_messages WHERE content='상품이 파손됐어요'`);
      mode = m; toasts.length = 0; sentBodies.length = 0;
      els.rcsInput.value = '상품이 파손됐어요';
      await RCS.send();
      const n1 = await n();
      ok(`[${m}] 첫 전송: 서버엔 저장됨(1) · 화면은 실패 안내 · 글 그대로`, n1 === 1 && toasts.some((t) => /전송하지 못했어요/.test(t)) && els.rcsInput.value === '상품이 파손됐어요', { n1, toasts, v: els.rcsInput.value, sent: sentBodies.length });
      mode = 'normal';
      await RCS.send();
      ok(`★ [${m}] 다시 보내기 = 같은 키`, sentBodies.length === 2 && sentBodies[0].clientMsgId && sentBodies[0].clientMsgId === sentBodies[1].clientMsgId, sentBodies.map((b) => b.clientMsgId));
      ok(`★ [${m}] 다시 보내기 뒤 메시지는 하나`, (await n()) === 1);
      ok(`[${m}] 다시 보내기 성공 → 입력칸 비움 · 대화에 글 한 번`, els.rcsInput.value === '' && (els.rcsThread.innerHTML.match(/상품이 파손됐어요/g) || []).length === 1);
    }
    // 성공 뒤 같은 글을 또 보내면 새 메시지(새 키)
    sentBodies.length = 0;
    els.rcsInput.value = '상품이 파손됐어요';
    await RCS.send();
    ok('성공 뒤 같은 글을 또 보내면 새 키 · 새 메시지(의도한 두 번째)', sentBodies.length === 1 && (await n()) === 2);
    const usedKeys = new Set();
    (await db.query(`SELECT client_msg_id FROM cs_messages WHERE content='상품이 파손됐어요'`)).rows.forEach((r) => usedKeys.add(r.client_msg_id));
    ok('두 메시지의 키가 다르다', usedKeys.size === 2);

    // 실패 뒤 글을 고치면 새 키(고친 글이 조용히 버려지지 않는다)
    mode = 'savedThenTimeout'; sentBodies.length = 0;
    els.rcsInput.value = '환불 원해요';
    await RCS.send();
    mode = 'normal';
    els.rcsInput.value = '환불 원해요(사진 첨부)';
    await RCS.send();
    ok('실패 뒤 글을 고치면 새 키 → 고친 글도 저장(조용히 버리지 않음)', sentBodies[0].clientMsgId !== sentBodies[1].clientMsgId && (await count(`content LIKE '환불 원해요%'`)) === 2);

    // 서버가 409(같은 키·다른 내용)를 주면 키를 버려 다음 누름은 새 메시지로(막다른 길 방지)
    sentBodies.length = 0;
    // 409 흉내: 첫 전송이 저장된 뒤 저장 내용이 달라진 것처럼 만들어, 같은 키 다시 보내기가 실제 라우트에서 409 를 받게 한다
    els.rcsInput.value = '키 충돌 시험';
    mode = 'savedThenTimeout';
    await RCS.send();                           // 저장됨 · 화면 실패 · 키 K 유지
    await db.query(`UPDATE cs_messages SET content='키 충돌 시험(서버에서 바뀐 것처럼)' WHERE content='키 충돌 시험'`);
    mode = 'normal';
    await RCS.send();                           // 같은 키 · 다른 저장 내용 → 409
    ok('409 충돌 → 실패 안내 · 글 그대로', toasts.some((t) => /내용이 바뀌었어요/.test(t)) && els.rcsInput.value === '키 충돌 시험');
    await RCS.send();                           // 키를 버렸으므로 새 키 → 저장
    ok('★ 409 뒤 다음 [보내기]는 새 키로 성공(막다른 길 없음)', sentBodies.length === 3 && sentBodies[2].clientMsgId !== sentBodies[1].clientMsgId && els.rcsInput.value === '' && (await count(`content='키 충돌 시험'`)) === 1);

    // crypto 가 없는 옛 브라우저도 서버가 받는 모양의 키를 만든다
    for (const [label, c] of [['crypto 없음', undefined], ['getRandomValues 만', { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255; return a; } }]]) {
      const ctx = mkCtx(c === undefined ? undefined : c);
      if (c === undefined) delete ctx.crypto;
      const R = window.ReviewerCS;
      await R.openChat(base.campaignKey, base.campaignLabel, base.campaignSource, null);
      sentBodies.length = 0;
      els.rcsInput.value = '키 모양 ' + label;
      await R.send();
      const k = sentBodies[0] && sentBodies[0].clientMsgId;
      ok(`${label}: 키 생성 · 서버 키 모양(16~100자 영숫자-_) · 저장에 기록`, /^[A-Za-z0-9_-]{16,100}$/.test(k || '') && (await count(`client_msg_id=$1`, [k])) === 1, k);
    }
  }

  /* ── D. (선택) 실제 PostgreSQL 동시 접속 ── */
  if (process.env.CS_IDEM_NATIVE_PG_TEST === '1') {
    const { startNativeCaptureDatabase, gate, tracedPool, waitUntilBlocked } = require('./helpers/captureNativePgFixture');
    const cluster = await startNativeCaptureDatabase();
    try {
      await cluster.pool.query(`CREATE TABLE reviewers (phone8 TEXT PRIMARY KEY, name TEXT); INSERT INTO reviewers VALUES ('12345678','홍길동');`);
      for (const f of BASE_MIGS) await cluster.pool.query(MIG(f));
      await cluster.pool.query(MIG(M221)); await cluster.pool.query(MIG(M221));
      await cluster.pool.query(`INSERT INTO cs_threads (reviewer_phone8, campaign_key, campaign_label, campaign_source) VALUES ('12345678',$1,'상품 A','review_index')`, [base.campaignKey]);
      for (const [label, ck] of [['있던 방', base.campaignKey], ['새 방(첫 문의)', 'S9||새탭']]) {
        const g = gate();
        let firstPid = null, holdFirst = true;
        const pids = [];
        const traced = tracedPool(cluster.pool, {
          connected: (pid) => pids.push(pid),
          after: async (sql, _a, c) => {
            if (holdFirst && /INSERT INTO cs_threads/.test(sql)) { holdFirst = false; firstPid = c.processID; await g.promise; }
          },
        });
        pool.query = traced.query; pool.connect = traced.connect;
        notices.length = 0;
        const K3 = 'native-' + (ck === base.campaignKey ? 'a' : 'b').repeat(20);
        const body = { ...base, campaignKey: ck, content: '실제 동시 ' + label, clientMsgId: K3 };
        const p1 = send(body);
        while (!firstPid) await new Promise((r) => setTimeout(r, 10));
        const p2 = send(body);
        while (pids.length < 2) await new Promise((r) => setTimeout(r, 10));
        await waitUntilBlocked(cluster.pool, pids[1], firstPid);
        ok(`[실 PG · ${label}] 둘째 전송이 첫째 트랜잭션을 실제로 기다린다(pg_blocking_pids)`, true);
        g.resolve();
        const [r1, r2] = await Promise.all([p1, p2]);
        const nn = Number((await cluster.pool.query(`SELECT COUNT(*)::int n FROM cs_messages WHERE client_msg_id=$1`, [K3])).rows[0].n);
        const tu = (await cluster.pool.query(`SELECT admin_unread_count FROM cs_threads WHERE reviewer_phone8='12345678' AND campaign_key=$1`, [ck])).rows;
        ok(`[실 PG · ${label}] 동시 두 전송 → 방 1 · 저장 1 · 알림 1 · 미확인 1 · 같은 메시지`,
          nn === 1 && notices.length === 1 && tu.length === 1 && tu[0].admin_unread_count === 1 && r1.body.message.id === r2.body.message.id && r2.body.duplicate === true,
          { nn, n: notices.length, tu });
      }
    } finally { await cluster.close(); }
  } else {
    console.log('  ⏭ 실 PostgreSQL 동시 접속(D)은 CS_IDEM_NATIVE_PG_TEST=1 일 때만');
  }

  console.log(`\ncsReviewerSendIdempotency: ${passed} tests passed`);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
