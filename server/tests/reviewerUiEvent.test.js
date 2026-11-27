'use strict';
/* 결정 425 — POST /api/reviewer/ui-event : 리뷰어 화면 사건 횟수(지금은 「사진을 다시 넣어 주세요」 안내가 뜬 횟수 하나).
 *   [A] 입구(진짜 라우터 · 진짜 express · 가짜 기록기): 허용 목록 · 크기 · 204 · 기다리지 않음 · 기록 실패 무관 · 인터넷 주소별 분당 상한
 *   [B] 표(진짜 migration 231 · PGlite): 기록 한 줄 · 개인정보 칸 없음 · 주인에게 줄 하루별 셈 SQL · 표가 없어도 실패를 삼킨다
 *   [C] 연결: app.js 가 reviewerRoutes 보다 먼저 싣는다 · 기동 필수 표(REQUIRED_TABLES)에 넣지 않는다
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://offline@127.0.0.1:1/offline';   // 모듈만 싣는다(연결 0)
const ROOT = path.resolve(__dirname, '..');
const { createReviewerUiEventRouter, MAX_BODY_BYTES } = require('../src/routes/reviewerUiEvent.routes');
const { normalizeUiEvent, recordUiEvent, UI_EVENTS } = require('../src/services/reviewerUiEvents.service');

async function serve(router) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));   // 운영과 같은 본문 해석(app.js)
  app.use('/api/reviewer', router);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (body, headers = {}) => fetch(base + '/api/reviewer/ui-event', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { post, close: () => new Promise((r) => srv.close(r)) };
}

test('A-1 허용된 사건만 받는다 — 204 · 기록은 정규화된 세 칸뿐(모르는 칸·이름·번호는 버린다)', async () => {
  const rows = [];
  const s = await serve(createReviewerUiEventRouter({ recordUiEvent: (row) => { rows.push(row); return Promise.resolve(true); } }));
  try {
    const r = await s.post({ event: 'photo_reattach_notice', screen: 'campaign', slots: 2, name: '김예시', phone: '01012345678', orderNumber: 'A-1' });
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    assert.deepStrictEqual(rows, [{ event: 'photo_reattach_notice', screen: 'campaign', slots: 2 }], '★ 사건·화면·칸 수만 남긴다');
    for (const bad of [{ event: 'drop_table', screen: 'campaign', slots: 1 }, { event: 'photo_reattach_notice', screen: 'admin', slots: 1 },
      { event: 'photo_reattach_notice', screen: 'direct', slots: 0 }, { event: 'photo_reattach_notice', screen: 'direct', slots: 21 },
      { event: 'photo_reattach_notice', screen: 'direct', slots: 1.5 }, { event: 'photo_reattach_notice', screen: 'direct', slots: '1' },
      { event: '__proto__', screen: 'direct', slots: 1 }, { event: 'constructor', screen: 'direct', slots: 1 }, [], {}]) {
      const x = await s.post(bad);
      assert.equal(x.status, 400, '허용 목록 밖 = 400: ' + JSON.stringify(bad));
    }
    assert.equal(rows.length, 1, '거절한 것은 기록하지 않는다');
    const big = await s.post({ event: 'photo_reattach_notice', screen: 'direct', slots: 1, pad: 'x'.repeat(MAX_BODY_BYTES) });
    assert.equal(big.status, 413, '★ 본문이 크면 받지 않는다');
    assert.equal(rows.length, 1);
  } finally { await s.close(); }
});

test('A-2 기록을 기다리지 않는다 · 기록이 실패·예외여도 204', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const s1 = await serve(createReviewerUiEventRouter({ recordUiEvent: () => slow }));
  const s2 = await serve(createReviewerUiEventRouter({ recordUiEvent: () => Promise.reject(new Error('db down')) }));
  const s3 = await serve(createReviewerUiEventRouter({ recordUiEvent: () => { throw new Error('boom'); } }));
  try {
    const t0 = Date.now();
    const r1 = await s1.post({ event: 'photo_reattach_notice', screen: 'direct', slots: 1 });
    assert.equal(r1.status, 204); assert.ok(Date.now() - t0 < 2000, '기록이 끝나기 전에 답한다');
    assert.equal((await s2.post({ event: 'photo_reattach_notice', screen: 'direct', slots: 1 })).status, 204);
    assert.equal((await s3.post({ event: 'photo_reattach_notice', screen: 'direct', slots: 1 })).status, 204);
  } finally { release(); await s1.close(); await s2.close(); await s3.close(); }
});

test('A-3 인터넷 주소별 분당 20회 — 넘으면 429(다른 주소는 그대로)', async () => {
  const s = await serve(createReviewerUiEventRouter({ recordUiEvent: () => Promise.resolve(true) }));
  try {
    const ok = { event: 'photo_reattach_notice', screen: 'direct', slots: 1 };
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await s.post(ok, { 'X-Real-IP': '203.0.113.7' })).status);
    assert.deepStrictEqual(codes.slice(0, 20), Array(20).fill(204));
    assert.equal(codes[20], 429, '★ 21번째는 막는다');
    assert.equal((await s.post(ok, { 'X-Real-IP': '203.0.113.8' })).status, 204, '다른 주소는 따로 센다');
  } finally { await s.close(); }
});

test('B-1 migration 231 — 개인정보 칸 없는 표 · 기록 한 줄 · 하루별 셈 SQL · 표가 없어도 실패를 삼킨다', async (t) => {
  let PGlite;
  try { ({ PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite')); } catch (_) { t.skip('PGlite 없음'); return; }
  const sql = fs.readFileSync(path.join(ROOT, 'migrations/231_reviewer_ui_events.sql'), 'utf8');
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  // 표가 아직 없을 때(옛 DB) — 실패를 삼키고 false
  assert.equal(await recordUiEvent({ event: 'photo_reattach_notice', screen: 'direct', slots: 1 }, pool), false, '표 없음 = 조용히 false');
  await db.exec(sql);
  await db.exec(sql);   // 두 번 돌려도 된다(IF NOT EXISTS)
  const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'reviewer_ui_events' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
  assert.deepStrictEqual(cols, ['id', 'event', 'screen', 'slots', 'created_at'], '★ 이름·전화·사진·주문번호·리뷰어·인터넷 주소 칸이 없다');
  assert.equal(await recordUiEvent(normalizeUiEvent({ event: 'photo_reattach_notice', screen: 'campaign', slots: 2 }), pool), true);
  assert.equal(await recordUiEvent(normalizeUiEvent({ event: 'photo_reattach_notice', screen: 'direct', slots: 1 }), pool), true);
  // 결정 425 문서의 주인용 셈 SQL 과 같은 꼴(읽기 전용)
  const doc = fs.readFileSync(fs.readdirSync(path.join(ROOT, '../docs/decisions')).filter((f) => /^425-/.test(f)).map((f) => path.join(ROOT, '../docs/decisions', f))[0], 'utf8');
  const m = /```sql\n([\s\S]*?)```/.exec(doc);
  assert.ok(m, '결정 문서에 하루별 셈 SQL');
  const rows = (await db.query(m[1])).rows;
  assert.equal(rows.length, 2, '화면별 한 줄씩(오늘)');
  assert.deepStrictEqual(rows.map((r) => [r.screen, Number(r.notices), Number(r.photo_slots)]).sort(), [['campaign', 1, 2], ['direct', 1, 1]]);
  await db.close();
});

test('C-1 연결 — app.js 가 reviewerRoutes 보다 먼저 싣는다 · 기동 필수 표에 넣지 않는다 · 허용 사건은 하나', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const a = app.indexOf("app.use('/api/reviewer',  require('./routes/reviewerUiEvent.routes'));");
  const b = app.indexOf("app.use('/api/reviewer',  reviewerRoutes);");
  assert.ok(a > 0 && b > a, '★ 리뷰어 라우터보다 먼저');
  const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.ok(!/reviewer_ui_events/.test(idx), '횟수 표가 없다고 서버가 뜨지 않으면 안 된다(REQUIRED_TABLES 밖)');
  assert.deepStrictEqual(Object.keys(UI_EVENTS), ['photo_reattach_notice']);
  // 화면이 보내는 이름과 같다
  const SA = fs.readFileSync(path.join(ROOT, '../frontend/js/search-app.js'), 'utf8');
  assert.match(SA, /"\/api\/reviewer\/ui-event"/);
  assert.match(SA, /event: "photo_reattach_notice", screen: _EMBED_CTX \? "campaign" : "direct", slots/);
});
