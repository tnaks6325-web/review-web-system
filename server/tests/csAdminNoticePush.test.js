/**
 * csAdminNoticePush.test.js — 결정 363 회귀가드
 * 「직원 쪽 안내(검수 반려 · 입금 실패 · 작업보드 [리뷰어에게 메시지] · 주문취소 · 블로그 승인/반려)가
 *   문의방에 저장은 되는데 리뷰어 화면에 **실시간으로는 한 번도 안 갔다**」를 막는다.
 *
 *   원인(2026-08-21 ~): `csBridge.postInspectionReject`(= postAdminNotice) 의 실시간 알림 줄이 트랜잭션 블록 안에서
 *   선언된 `meta` 를 블록 밖에서 읽어 ReferenceError → `try {} catch (_) {}` 가 조용히 삼켰다(저장 1 · 실시간 알림 0).
 *
 *   ★ sse 모듈을 **스텁하지 않는다** — 진짜 `utils/sse` 에 리뷰어·관리자 가짜 연결을 붙여, 리뷰어 연결에
 *     실제로 써진 `event: cs_message` 를 센다(스텁은 "함수를 불렀다"만 보고 대상 필터·직렬화를 못 본다).
 *
 *   A. 카드 없는 안내(검수 반려 본문·입금 실패 안내 모양) — 저장 1 · 그 리뷰어 연결에 실시간 알림 정확히 1 ·
 *      다른 리뷰어 0 · 관리자 화면엔 갱신 신호만(본문 없음) · 미확인 +1 한 번 · **COMMIT 뒤에** 나간다
 *   B. 사진 카드(검수 반려) — 알림에 msgType inspect_result + 위생 처리된 meta(관리자 실명 없음)
 *   C. 다시 보내기 키(작업보드 메시지 · 결정 362) — 첫 전송 1 · 같은 키 다시 = duplicate · 알림 0 · 미확인 그대로
 *      · 같은 키·다른 글 = 저장 0 · 알림 0
 *   D. 저장 실패(트리거로 INSERT 실패 주입) — null · 알림 0 · 빈 방 0
 *   E. 칸 없는 DB(migration 221 전) + 키 — 알림 정확히 1(두 번 아님)
 *   F. 실제 라우트 POST /api/trackb/cs/notify-participants — 받는 사람마다 1
 *   G. 알림 모양 = POST /api/cs/reply 가 리뷰어에게 보내는 모양 ⊆ (칸 이름·형)
 *   H. 리뷰어 화면(reviewer-cs.js · vm) — 그 방을 보고 있으면 대화를 다시 읽고, 아니면 「관리자 답변이 도착했습니다」
 * 실행: node tests/csAdminNoticePush.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

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

const { logger } = require(path.join(SERVER, 'src/utils/logger'));
const warns = [];
logger.warn = (m) => warns.push(String(m));
logger.info = () => {};
logger.debug = () => {};

// ── 진짜 sse 모듈 + 가짜 연결(리뷰어 A·B · 관리자) ──
const sse = require(path.join(SERVER, 'src/utils/sse'));
const seq = [];   // DB COMMIT 과 실시간 알림의 순서
function fakeConn(name, meta) {
  const req = new EventEmitter(); req.ip = '127.0.0.1';
  const events = [];
  const res = {
    writeHead() {}, end() {},
    write(chunk) {
      const s = String(chunk);
      const m = s.match(/^event: ([^\n]+)\ndata: ([^\n]*)\n\n$/);
      if (m) { events.push({ ev: m[1], data: JSON.parse(m[2]), raw: m[2] }); seq.push(`push:${name}:${m[1]}`); }
      return true;
    },
  };
  sse.addClient(req, res, meta);
  return { events, cs: () => events.filter((e) => e.ev === 'cs_message'), reset: () => { events.length = 0; } };
}
const RA = fakeConn('A', { role: 'reviewer', phone8: '11112222' });
const RB = fakeConn('B', { role: 'reviewer', phone8: '33334444' });
const ADM = fakeConn('admin', { role: 'admin' });
const resetAll = () => { RA.reset(); RB.reset(); ADM.reset(); seq.length = 0; };

const pool = require(path.join(SERVER, 'src/db/pool'));
const nick = require(path.join(SERVER, 'src/services/adminNickname.service'));
nick.getNicknameMap = async () => ({ 만두: '상담원 만두' });
nick.maskMessages = async (m) => m;

let db = null;
let chain = Promise.resolve();
function lock() { let release; const p = new Promise((r) => { release = r; }); const prev = chain; chain = prev.then(() => p); return prev.then(() => release); }
pool.query = async (sql, params) => { const rel = await lock(); try { return await db.query(sql, params); } finally { rel(); } };
pool.connect = async () => {
  const rel = await lock();
  return {
    query: async (sql, params) => {
      const r = await db.query(sql, params);
      if (/^\s*(COMMIT|ROLLBACK)\s*$/i.test(String(sql))) seq.push('db:' + String(sql).trim().toUpperCase());
      return r;
    },
    release: () => rel(),
  };
};

async function freshDb({ with221 = true } = {}) {
  db = new PGlite();
  await db.exec(`CREATE TABLE reviewers (phone8 TEXT PRIMARY KEY, name TEXT);`);
  for (const f of BASE_MIGS) await db.exec(MIG(f));
  if (with221) await db.exec(MIG(M221));
}
const count = async (where = 'TRUE', p = []) => Number((await db.query(`SELECT COUNT(*)::int AS n FROM cs_messages WHERE ${where}`, p)).rows[0].n);
const unreadOf = async (phone8) => { const r = (await db.query(`SELECT reviewer_unread_count u FROM cs_threads WHERE reviewer_phone8=$1`, [phone8])).rows; return r.length ? Number(r[0].u) : null; };

const layerOf = (router, method, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
function call(layer, { body, query, admin }) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    Promise.resolve(handler({ body: body || {}, query: query || {}, admin: admin || { role: 'admin', name: '만두' }, get: () => 'api.example.test' }, res,
      (e) => (e ? reject(e) : resolve({ status: 404 })))).catch(reject);
  });
}

const CSB = require(path.join(SERVER, 'src/services/csBridge.service'));
const K1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

(async () => {
  console.log('\n▶ 결정 363 — 직원 쪽 안내도 리뷰어에게 실시간으로 (저장 1 = 알림 1 · 다시 보내기 0)\n');

  /* ── A. 카드 없는 안내 ── */
  let textPush = null;
  {
    await freshDb(); resetAll();
    const out = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭A', rowIndex: 3, reviewerName: '가나', phone8: '11112222', message: '입금이 실패했어요\n계좌를 확인해 주세요', by: '만두' });
    ok('저장 1 · 성공 객체(종전 계약)', out && out.threadId && out.messageId && !out.duplicate && (await count()) === 1, out);
    const pa = RA.cs();
    ok('★ 그 리뷰어 연결에 실시간 알림 정확히 1', pa.length === 1, { n: pa.length, warns });
    textPush = pa[0] && pa[0].data;
    ok('알림 = 저장된 그 메시지(id·방·내용·종류)', textPush && textPush.id === out.messageId && textPush.threadId === out.threadId
      && textPush.senderRole === 'admin' && textPush.content === '입금이 실패했어요\n계좌를 확인해 주세요'
      && Array.isArray(textPush.imageUrls) && textPush.imageUrls.length === 0 && !!textPush.createdAt
      && textPush.msgType === 'text' && textPush.meta === null && textPush.campaignLabel === '탭A', textPush);
    ok('★ 알림의 보낸 사람 = 리뷰어용 이름(닉네임) — 로그인명 미노출', textPush.senderName === '상담원 만두' && !/"만두"/.test(pa[0].raw));
    ok('다른 리뷰어 연결엔 0', RB.cs().length === 0);
    const ac = ADM.cs();
    ok('관리자 화면엔 갱신 신호 1(본문 없음 — 리뷰어용 알림이 관리자 방송으로 새지 않는다)', ac.length === 1 && ac[0].data.threadId === out.threadId && !('content' in ac[0].data), ac);
    ok('리뷰어 미확인 +1 한 번(실시간 알림이 숫자를 또 올리지 않는다 — 화면은 서버 숫자를 다시 읽는다)', (await unreadOf('11112222')) === 1);
    ok('★ 실시간 알림은 COMMIT 뒤에 나간다', seq.indexOf('db:COMMIT') > -1 && seq.indexOf('push:A:cs_message') > seq.indexOf('db:COMMIT'), seq);
    ok('조용히 삼킨 실패 없음(경고 로그 0)', !warns.some((w) => /csBridge/.test(w)), warns);

    // 같은 방에 두 번째 안내(키 없음) = 종전대로 두 개 · 알림도 두 번
    resetAll();
    const out2 = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭A', phone8: '11112222', message: '두 번째 안내', by: '만두' });
    ok('기존 방 두 번째 안내 → 알림 1 · 같은 방 · 미확인 2', out2 && out2.threadId === out.threadId && RA.cs().length === 1 && (await unreadOf('11112222')) === 2);
    ok('사진만(본문 없음) 안내도 알림에 첨부가 실린다', await (async () => {
      resetAll();
      const G = 'https://api.example.test/api/order/guide-image/x' + 'a'.repeat(24);
      const o = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭A', phone8: '11112222', message: '', by: '만두', imageUrls: [G] });
      const p = RA.cs()[0];
      return o && p && p.data.imageUrls.length === 1 && p.data.imageUrls[0] === G && RA.cs().length === 1;
    })());
  }

  /* ── B. 사진 카드(검수 반려) ── */
  {
    resetAll(); warns.length = 0;
    const out = await CSB.postInspectionReject({ sheetId: 'SH', tabName: '탭A', rowIndex: 5, phone8: '11112222', message: '리뷰 사진이 달라요', by: '만두',
      card: { kind: 'reject', fileId: 'FILE_abc-1234567', matchFileId: 'bad id!!', product: '상품', ordinal: 2, to: '반려' } });
    const p = RA.cs();
    ok('★ 카드 안내도 알림 정확히 1', out && p.length === 1, { n: p.length, warns });
    const d = p[0].data;
    ok('알림에 카드가 실린다(msgType inspect_result + meta)', d.msgType === 'inspect_result' && d.meta && d.meta.kind === 'reject' && d.meta.fileId === 'FILE_abc-1234567' && d.meta.ordinal === 2, d);
    ok('카드 meta 위생 그대로(잘못된 파일ID 버림 · 관리자 실명/시트ID 없음)', d.meta.matchFileId === '' && !/만두|"SH"/.test(JSON.stringify(d.meta)), d.meta);
    const saved = (await db.query(`SELECT meta FROM cs_messages WHERE id=$1`, [out.messageId])).rows[0].meta;
    ok('알림의 meta = 저장된 meta(목록을 다시 읽어도 같은 카드)', JSON.stringify(saved, Object.keys(saved).sort()) === JSON.stringify(d.meta, Object.keys(d.meta).sort()), { saved, d: d.meta });
  }

  /* ── C. 다시 보내기 키(작업보드 메시지 · 결정 362) ── */
  {
    await freshDb(); resetAll();
    const a = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭K', phone8: '11112222', message: '구매 안내', by: '만두', clientMsgId: K1 });
    ok('키 첫 전송: 저장 1 · 알림 1 · 미확인 1', a && !a.duplicate && (await count()) === 1 && RA.cs().length === 1 && (await unreadOf('11112222')) === 1);
    const b = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭K', phone8: '11112222', message: '구매 안내', by: '만두', clientMsgId: K1 });
    ok('★ 같은 키 다시 보내기 = duplicate · 저장 그대로 · 리뷰어 알림 추가 0 · 관리자 방송 추가 0 · 미확인 그대로',
      b && b.duplicate === true && b.messageId === a.messageId && (await count()) === 1 && RA.cs().length === 1 && ADM.cs().length === 1 && (await unreadOf('11112222')) === 1,
      { b, n: RA.cs().length, adm: ADM.cs().length });
    let code = '';
    const c = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭K', phone8: '11112222', message: '구매 안내(수정)', by: '만두', clientMsgId: K1, onError: (e) => { code = e.code; } });
    ok('같은 키·다른 글 = null · 저장 0 · 알림 0', c === null && code === 'cs_client_msg_conflict' && (await count()) === 1 && RA.cs().length === 1);
    const [x1, x2] = await Promise.all([
      CSB.postAdminNotice({ sheetId: 'SH', tabName: '새탭', phone8: '33334444', message: '첫 안내', by: '만두', clientMsgId: 'concurrent-new-room-key-0001' }),
      CSB.postAdminNotice({ sheetId: 'SH', tabName: '새탭', phone8: '33334444', message: '첫 안내', by: '만두', clientMsgId: 'concurrent-new-room-key-0001' }),
    ]);
    ok('★ 동시에 두 번(같은 키) → 저장 1 · 알림 1', x1 && x2 && x1.messageId === x2.messageId && RB.cs().length === 1 && (await count(`content='첫 안내'`)) === 1, { n: RB.cs().length });
  }

  /* ── D. 저장 실패 ── */
  {
    await freshDb(); resetAll(); warns.length = 0;
    await db.exec(`CREATE FUNCTION w9_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER w9_fail_t BEFORE INSERT ON cs_messages FOR EACH ROW EXECUTE FUNCTION w9_fail();`);
    const r = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭F', phone8: '11112222', message: '실패할 안내', by: '만두' });
    const rooms = Number((await db.query(`SELECT COUNT(*)::int n FROM cs_threads`)).rows[0].n);
    ok('★ 저장 실패 → null · 리뷰어 알림 0 · 관리자 방송 0 · 빈 방 0', r === null && RA.cs().length === 0 && ADM.cs().length === 0 && rooms === 0, { r, rooms });
    ok('실패는 경고 로그로 남는다(조용한 실패 금지)', warns.some((w) => /검수 반려 통지 실패|injected/.test(w)), warns);
  }

  /* ── E. 칸 없는 DB(221 전) + 키 ── */
  {
    await freshDb({ with221: false }); resetAll(); warns.length = 0;
    const r = await CSB.postAdminNotice({ sheetId: 'SH', tabName: '탭N', phone8: '11112222', message: '칸 없음', by: '만두', clientMsgId: K1 });
    ok('★ 칸 없는 DB + 키 → 종전 경로로 저장 1 · 알림 정확히 1(두 번 아님)', r && r.messageId && (await count()) === 1 && RA.cs().length === 1 && (await unreadOf('11112222')) === 1, { n: RA.cs().length });
  }

  /* ── F. 실제 라우트 — 작업보드 [리뷰어에게 메시지] ── */
  {
    await freshDb(); resetAll();
    const recip = require(path.join(SERVER, 'src/services/csRecipient.service'));
    const RECIPS = [
      { participantId: 'p1', ok: true, seq: 1, name: '가나', rowName: '가나', phone8: '11112222', phoneFull: '01011112222' },
      { participantId: 'p2', ok: true, seq: 2, name: '다라', rowName: '다라', phone8: '33334444', phoneFull: '01033334444' },
    ];
    recip.resolveRecipients = async ({ participantIds }) => participantIds.map((id) => RECIPS.find((r) => r.participantId === id));
    const tbRouter = require(path.join(SERVER, 'src/routes/trackB.routes'));
    const notifyLayer = layerOf(tbRouter, 'post', '/cs/notify-participants');
    assert.ok(notifyLayer, 'notify 라우트 없음');
    const NB = { sheetId: 'SH', tabName: '탭W', participantIds: ['p1', 'p2'], content: '작업보드 안내', clientMsgId: K1 };
    const r1 = await call(notifyLayer, { body: NB });
    ok('★ 작업보드 메시지 → 받는 사람마다 실시간 알림 1', r1.body.ok && r1.body.sent.length === 2 && RA.cs().length === 1 && RB.cs().length === 1
      && RA.cs()[0].data.content === '작업보드 안내' && RA.cs()[0].data.threadId === r1.body.sent[0].threadId, { body: r1.body, a: RA.cs().length, b: RB.cs().length });
    const r2 = await call(notifyLayer, { body: NB });
    ok('★ 같은 키로 다시 보내기 → 둘 다 duplicate · 알림 추가 0', r2.body.sent.every((s) => s.duplicate === true) && RA.cs().length === 1 && RB.cs().length === 1);
  }

  /* ── G. 알림 모양 = 답장(POST /api/cs/reply)과 같은 칸 ── */
  {
    resetAll();
    const thread = (await db.query(`SELECT id FROM cs_threads WHERE reviewer_phone8='11112222'`)).rows[0].id;
    const csRouter = require(path.join(SERVER, 'src/routes/cs.routes'));
    const replyLayer = layerOf(csRouter, 'post', '/reply');
    const rr = await call(replyLayer, { body: { threadId: thread, content: '답장입니다' } });
    ok('답장 라우트도 알림 1(비교 기준)', rr.body.ok && RA.cs().length === 1);
    const replyPush = RA.cs()[0].data;
    const missing = Object.keys(replyPush).filter((k) => !(k in textPush));
    ok('★ 안내 알림은 답장 알림의 칸을 전부 갖는다(리뷰어 화면이 같은 방식으로 읽는다)', missing.length === 0, { missing, replyKeys: Object.keys(replyPush), noticeKeys: Object.keys(textPush) });
    ok('칸의 형(threadId·id·createdAt 문자열 · imageUrls 배열)이 같다',
      ['threadId', 'id', 'senderRole', 'senderName', 'content'].every((k) => typeof replyPush[k] === typeof textPush[k])
      && Array.isArray(replyPush.imageUrls) && Array.isArray(textPush.imageUrls)
      && typeof replyPush.createdAt === typeof textPush.createdAt, { replyPush, textPush });
  }

  /* ── 구조 고정: 알림 줄이 읽는 값은 트랜잭션 블록 밖에서 만든다 · 알림 실패는 로그로 ── */
  {
    const src = fs.readFileSync(path.join(SERVER, 'src/services/csBridge.service.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function postInspectionReject'), src.indexOf('const postAdminNotice'));
    ok('★ meta 는 pool.connect()(트랜잭션) 전에 만든다 — 블록 안 선언이면 알림 줄에서 ReferenceError',
      fn.indexOf('const meta = card ?') > -1 && fn.indexOf('const meta = card ?') < fn.indexOf('await pool.connect()'));
    const post = fn.slice(fn.indexOf('emitCsReplyToReviewer(phone8'));
    ok('★ 리뷰어 실시간 알림 실패를 맨 catch 로 삼키지 않는다(경고 로그)', /^[\s\S]*?\}\);\s*\} catch \(e\) \{\s*try \{ logger\.warn\(/.test(post));
  }

  /* ── H. 리뷰어 화면(reviewer-cs.js · vm) ── */
  {
    const CS = fs.readFileSync(path.join(REPO, 'frontend/js/reviewer-cs.js'), 'utf8');
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, innerHTML: '', value: '', textContent: '', disabled: false, style: {}, scrollTop: 0, scrollHeight: 0, addEventListener() {}, appendChild() {} });
    ['rcsOverlay', 'rcsInput', 'rcsSendBtn', 'rcsAttachBar', 'rcsThread', 'rcsTabDot'].forEach(el);
    const toasts = []; const gets = []; const listeners = {};
    const window = { getSavedUser: () => ({ name: '가나', phone8: '11112222' }) };
    const ctx = {
      window, console: { warn() {}, error() {}, log() {} }, JSON, String, Date, Math, Array, setTimeout, clearTimeout, Promise,
      document: { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => el('x' + Math.random()), body: { appendChild() {} }, addEventListener() {} },
      setInterval: () => 0,
      EventSource: function (url) { this.url = url; this.addEventListener = (ev, fn) => { listeners[ev] = fn; }; this.close = () => {}; },
      localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null, setItem() {} },
      showToast: (m) => toasts.push(String(m)), alert: (m) => toasts.push(String(m)), API_BASE_URL: 'http://t',
      gasGet: async (p) => { gets.push(p); return p.action === 'csReviewerMessages' ? { ok: true, threadId: p.threadId, messages: [] } : { ok: true, totalUnread: 1 }; },
      gasPost: async () => ({ ok: true }),
    };
    vm.createContext(ctx);
    vm.runInContext(CS, ctx);
    ok('리뷰어 화면이 cs_message 실시간 알림을 듣는다', typeof listeners.cs_message === 'function');
    const RCS = window.ReviewerCS;
    await RCS.openChat('SH||탭A', '탭A', 'review_index', textPush.threadId);
    gets.length = 0;
    listeners.cs_message({ data: JSON.stringify(textPush) });
    await new Promise((r) => setTimeout(r, 20));
    ok('★ 그 방을 보고 있으면 → 대화를 다시 읽는다(새 안내가 바로 보인다) + 미확인 숫자를 서버에서 다시 읽는다',
      gets.some((g) => g.action === 'csReviewerMessages' && g.threadId === textPush.threadId) && gets.some((g) => g.action === 'csReviewerUnread'), gets);
    RCS.close(); gets.length = 0; toasts.length = 0;
    listeners.cs_message({ data: JSON.stringify(textPush) });
    await new Promise((r) => setTimeout(r, 20));
    ok('대화창이 닫혀 있으면 → 「관리자 답변이 도착했습니다」 + 미확인 숫자 다시 읽기(직접 +1 안 함)',
      toasts.includes('관리자 답변이 도착했습니다') && gets.some((g) => g.action === 'csReviewerUnread') && !gets.some((g) => g.action === 'csReviewerMessages'), { toasts, gets });
  }

  console.log(`\ncsAdminNoticePush: ${passed} tests passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
