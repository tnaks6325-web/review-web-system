'use strict';
/* manualOrderDualBlock.test.js — 결정 344 회귀가드
   외부모집 수동제출(관리자 대리 입력)은 네이버·쿠팡 동시진행 작업표/공고에 「보통 주문 1건」을 넣지 않는다.
   - 서비스(submitExternalOrder) 맨 앞에서 거절: 리뷰어 자동등록·원장·큐·작업표 쓰기 0건
   - 라우트(preview·submit) 사전 판정에서 거절: 미리보기 단계에서 바로 알림 (/api/trackb/manual-order/* 는 같은 핸들러)
   - 판정 자체가 실패하면 막는다(fail-closed — 돈이 걸린 대리 입력 경로)
   - 동시진행이 아닌 작업표는 종전대로 접수된다
   판정 = 공용 lifecycle 발견기(discoverDualScope) 실물 + 실제 동시진행 fixture(PGlite). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');
const CODE = 'dual_channel_manual_unsupported';
const MSG = '이 작업은 네이버·쿠팡 동시진행이라 수동제출로 접수할 수 없어요 — 리뷰어가 구매양식 링크로 두 곳을 함께 내야 해요.';
const FIELDS = { reviewerName: '홍길동', recipient: '홍길동', userId: 'id1', phone: '010-1234-5678', address: '서울 어딘가 1',
  bank: '국민', account: '123-456', depositor: '홍길동', price: 19000, isSubAccount: false };

function inject(rel, exportsObj) {
  const p = require.resolve(path.join(SRC, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
function fresh() { for (const k of Object.keys(require.cache)) if (k.startsWith(SRC + path.sep)) delete require.cache[k]; }

/** pool 대역: queryImpl 로 읽기를 넘기고, 모든 SQL 을 기록한다(쓰기 SQL 이 0건인지 본다). */
function load(queryImpl) {
  fresh();
  const calls = { sql: [], ledger: 0, enqueue: 0, worktable: 0, register: 0 };
  const pool = {
    query: async (sql, params) => { calls.sql.push(String(sql)); return queryImpl(String(sql), params); },
    connect: async () => ({ query: async (sql, params) => { calls.sql.push(String(sql)); return queryImpl(String(sql), params); }, release() {} }),
  };
  inject('db/pool.js', pool);
  inject('services/orderLedger.service.js', {
    createOrderLedgerEntry: async () => { calls.ledger++; return { orderSubmissionId: 'os-1', sheetRow: 5, tabGid: 'g' }; },
    markOrderQueued: async () => {}, markOrderMirrorFailed: async () => {},
    optionColIndexes: () => [], existingOptionKeyAt: () => '',
  });
  inject('services/syncQueue.service.js', { enqueue: async () => { calls.enqueue++; } });
  inject('services/reviewer.service.js', { registerReviewer: async () => { calls.register++; return { ok: true }; } });
  inject('services/workboardQueueApply.service.js', { resolveQueuedWorkboardTarget: async () => ({ enabled: false }) });
  inject('utils/sheetlessScope.js', { isSheetless: async () => true });
  inject('services/sheetlessOrder.service.js', { writeOrderToWorktable: async () => { calls.worktable++; return { ok: true }; } });
  inject('services/purchaseSubmissionSession.service.js', { issueForOrder: async (a) => ({ issued: true, kind: 'single', ...a }) });
  const writes = () => calls.sql.filter(s => /\b(INSERT|UPDATE|DELETE)\b/i.test(s));
  return { calls, writes, svc: () => require(path.join(SRC, 'services/manualOrder.service.js')),
    routes: () => require(path.join(SRC, 'routes/manualOrder.routes.js')) };
}

let FX = null;
async function dualDb() {
  if (!FX) { FX = await require('./helpers/dualChannelRealFixture.js').fixture(); }
  return FX;
}
test.after(async () => { if (FX) await FX.close(); });

const plainRead = async () => ({ rows: [], rowCount: 0 });
const boom = async () => { throw new Error('db down'); };
function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } }; }
function assertNoWrites(h) {
  assert.equal(h.calls.ledger, 0, '원장 0'); assert.equal(h.calls.enqueue, 0, '큐 0');
  assert.equal(h.calls.worktable, 0, '작업표 0'); assert.equal(h.calls.register, 0, '리뷰어 등록 0');
  assert.deepEqual(h.writes(), [], '쓰기 SQL 0');
}

test('서비스: 동시진행 작업표(시트 좌표)면 맨 앞에서 거절 — 리뷰어 등록·원장·큐·작업표 0', async () => {
  const fx = await dualDb();
  const h = load((sql, p) => fx.query(sql, p));
  const r = await h.svc().submitExternalOrder({ sheetId: 's', tabName: 't', gid: 'g', campaignId: null, fields: FIELDS, adminName: '관리자', allowRepurchase: true });
  assert.equal(r.ok, false); assert.equal(r.code, CODE); assert.equal(r.error, MSG);
  assertNoWrites(h);
});

test('서비스: 동시진행 공고 id 로 들어와도 거절(작업표 좌표가 달라도)', async () => {
  const fx = await dualDb();
  const h = load((sql, p) => fx.query(sql, p));
  const r = await h.svc().submitExternalOrder({ sheetId: 'other', tabName: 'x', gid: '', campaignId: 'campaign', fields: FIELDS, adminName: '관리자', allowRepurchase: true });
  assert.equal(r.ok, false); assert.equal(r.code, CODE);
  assertNoWrites(h);
});

test('서비스: 판정이 실패하면 막는다(fail-closed) — 쓰기 0', async () => {
  const h = load(boom);
  const r = await h.svc().submitExternalOrder({ sheetId: 's', tabName: 't', gid: 'g', campaignId: null, fields: FIELDS, adminName: '관리자', allowRepurchase: true });
  assert.equal(r.ok, false); assert.ok(r.code && /^dual_channel_manual/.test(r.code), r.code);
  assertNoWrites(h);
});

test('서비스: 동시진행이 아닌 작업표는 종전대로 접수(원장 1)', async () => {
  const h = load(plainRead);
  const r = await h.svc().submitExternalOrder({ sheetId: 'plain', tabName: 'p', gid: 'g', campaignId: null, fields: FIELDS, adminName: '관리자', allowRepurchase: true });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(h.calls.ledger, 1);
});

test('라우트 submit: 동시진행 작업표면 배치 시작 전 409 · 화면이 그대로 보여줄 문구 · 쓰기 0', async () => {
  const fx = await dualDb();
  const h = load((sql, p) => fx.query(sql, p));
  const out = res();
  await h.routes().handlers.manualOrderSubmit({ body: { sheetId: 's', tabName: 't', gid: 'g', allowRepurchase: true, items: [{ fields: FIELDS }] }, admin: { name: '관리자' } }, out, e => { throw e; });
  assert.equal(out.statusCode, 409); assert.equal(out.body.ok, false); assert.equal(out.body.code, CODE); assert.equal(out.body.error, MSG);
  assertNoWrites(h);
});

test('라우트 preview: 동시진행이면 미리보기 단계에서 바로 거절', async () => {
  const fx = await dualDb();
  const h = load((sql, p) => fx.query(sql, p));
  const out = res();
  await h.routes().handlers.manualOrderPreview({ body: { text: FIELDS_LINE(), sheetId: 's', tabName: 't', campaignId: null }, admin: { name: '관리자' } }, out, e => { throw e; });
  assert.equal(out.statusCode, 409); assert.equal(out.body.code, CODE); assert.equal(out.body.error, MSG);
});

test('라우트 preview·submit: 판정 실패면 막는다(fail-closed)', async () => {
  const h = load(boom);
  const p = res();
  await h.routes().handlers.manualOrderPreview({ body: { text: FIELDS_LINE(), sheetId: 's', tabName: 't' }, admin: { name: '관리자' } }, p, () => {});
  assert.equal(p.body && p.body.ok, false); assert.ok(/^dual_channel_manual/.test(p.body.code));
  const s = res();
  await h.routes().handlers.manualOrderSubmit({ body: { sheetId: 's', tabName: 't', allowRepurchase: true, items: [{ fields: FIELDS }] }, admin: { name: '관리자' } }, s, () => {});
  assert.equal(s.body && s.body.ok, false); assert.ok(/^dual_channel_manual/.test(s.body.code));
  assertNoWrites(h);
});

test('라우트 preview·submit: 동시진행이 아닌 작업표는 종전대로', async () => {
  const h = load(plainRead);
  const p = res();
  await h.routes().handlers.manualOrderPreview({ body: { text: FIELDS_LINE(), sheetId: 'plain', tabName: 'p' }, admin: { name: '관리자' } }, p, e => { throw e; });
  assert.equal(p.statusCode, 200); assert.equal(p.body.ok, true); assert.equal(p.body.okCount, 1);
  const s = res();
  await h.routes().handlers.manualOrderSubmit({ body: { sheetId: 'plain', tabName: 'p', gid: 'g', allowRepurchase: true, items: [{ fields: FIELDS }] }, admin: { name: '관리자' } }, s, e => { throw e; });
  assert.equal(s.body.ok, true, JSON.stringify(s.body)); assert.equal(s.body.okCount, 1); assert.equal(h.calls.ledger, 1);
});

test('Track B 입구는 같은 이름 핸들러를 태운다(사본 0 — 같은 판정)', () => {
  const src = require('node:fs').readFileSync(path.join(SRC, 'routes/trackB.routes.js'), 'utf8');
  assert.match(src, /_handler\(_moRoutes, 'manualOrderPreview'\)/);
  assert.match(src, /_handler\(_moRoutes, 'manualOrderSubmit'\)/);
});

function FIELDS_LINE() {
  const f = FIELDS;
  return [f.reviewerName, f.recipient, f.userId, f.phone, f.address, f.bank, f.account, f.depositor, f.price].join('/');
}
