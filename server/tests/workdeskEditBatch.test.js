/* 작업표 묶음 저장(POST /workdesk/edit-batch) 회귀가드 — 결정 327 (2026-11-03)
 *
 *   사고: 큰 붙여넣기가 칸마다 저장 요청 1개를 한꺼번에 보내 직원별 요청 한도(분당 300)를 넘기고,
 *         넘친 칸이 429 로 거절돼 조용히 원래 값으로 돌아갔다(10/15 300칸 중 3칸 누락).
 *   고침: 여러 칸을 한 요청으로 저장하는 묶음 경로. ★ 쓰기 규칙은 한 칸 저장과 **같은 본문**(_workdeskEditCell)을 탄다.
 *
 *   여기서 확인하는 것(라우트 핸들러를 실제로 실행 — 서비스만 스텁):
 *    ① 칸마다 한 칸 저장과 같은 서비스 호출·같은 권한 게이트(광고주는 송장 칸만)·같은 금액 검증
 *    ② 칸별 독립 — 한 칸 실패(충돌·예외)가 다른 칸을 막거나 되돌리지 않고, 결과가 칸별로 순서대로 온다
 *    ③ 상한 초과 묶음은 통째 400(서비스 호출 0)
 *    ④ 내부 직원 칸은 주문 원장 반영(through-write)·참여 기록 맞춤도 한 칸 저장과 똑같이 탄다
 *    ⑤ 실제 요청 한도(rateLimiter) + 실제 묶음 핸들러 + 실제 화면 붙여넣기 코드: 500칸이 한도 300 아래에서 전부 저장
 *   실행: node tests/workdeskEditBatch.test.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'batch-test-secret';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const svc = require('../src/services/trackB.service');
const ledger = require('../src/services/orderLedger.service');
const pmv = require('../src/services/productMismatchVerify.service');
const router = require('../src/routes/trackB.routes');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n    ', e && e.message); }
}

const handlerOf = (method, routePath) => {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) return null;
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

function stubAll({ edit, normalize, sync } = {}) {
  const orig = {
    edit: svc.editWorkdeskRow, access: svc.canAccessTab, brand: svc.brandTabAllowed,
    norm: ledger.normalizeWorkdeskColumnValue, sync: ledger.syncCellToOrderIdentity, app: pmv.syncApplicationFromWorkboard,
  };
  const calls = { edit: [], sync: [], app: [] };
  svc.editWorkdeskRow = async (a) => { calls.edit.push(a); return edit ? edit(a) : { ok: true, field: a.field, value: a.value }; };
  svc.canAccessTab = async () => true;
  svc.brandTabAllowed = async () => true;
  ledger.normalizeWorkdeskColumnValue = normalize || (async ({ value }) => ({ isPrice: false, ok: true, value }));
  ledger.syncCellToOrderIdentity = async (a) => { calls.sync.push(a); return sync ? sync(a) : { attempted: true, ok: true }; };
  pmv.syncApplicationFromWorkboard = async (a) => { calls.app.push(a); return { synced: false }; };
  const restore = () => {
    svc.editWorkdeskRow = orig.edit; svc.canAccessTab = orig.access; svc.brandTabAllowed = orig.brand;
    ledger.normalizeWorkdeskColumnValue = orig.norm; ledger.syncCellToOrderIdentity = orig.sync; pmv.syncApplicationFromWorkboard = orig.app;
  };
  return { calls, restore };
}

async function call(handler, role, body) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ admin: { role, name: 'tester', advertiser_id: 'adv1' }, body }, res, (e) => { throw e; });
  return res;
}

(async () => {
  console.log('\n[1] 묶음 저장 경로 — 한 칸 저장과 같은 본문');
  const batch = handlerOf('post', '/workdesk/edit-batch');
  await t('POST /workdesk/edit-batch 가 있다', () => assert.ok(batch, '묶음 저장 경로가 없다'));
  if (!batch) { console.log(`\n${pass} pass / ${fail + 1} fail`); process.exit(1); }

  const src = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  await t('★ 단일 출처: 한 칸 저장·묶음 저장 둘 다 _workdeskEditCell 을 부른다(쓰기 규칙 사본 0)', () => {
    const i = src.indexOf("router.post('/workdesk/edit',"); const one = src.slice(i, src.indexOf('\n});', i));
    const j = src.indexOf("router.post('/workdesk/edit-batch',"); const many = src.slice(j, src.indexOf('\n});', j));
    assert.ok(/_workdeskEditCell\(req, res, req\.body/.test(one), '한 칸 저장이 공용 본문을 안 탄다');
    assert.ok(/_workdeskEditCell\(req, cap,/.test(many), '묶음 저장이 공용 본문을 안 탄다');
    assert.ok(!/svc\.editWorkdeskRow|_ensureWorkdeskCellEditScope|normalizeWorkdeskColumnValue/.test(many), '묶음 경로에 쓰기 규칙 사본이 생겼다');
  });

  let s = stubAll();
  let r;
  try {
    r = await call(batch, 'staff', { sheetId: 's1', tabName: 't1', cells: [
      { rowId: 'r1', field: 'col:주소', value: 'A' }, { rowId: 'r2', field: 'col:주소', value: 'B' }, { rowId: 'r3', field: 'col:수취인', value: 'C' }] });
  } finally { s.restore(); }
  await t('직원 3칸 = 서비스 3번(칸마다 같은 인자) · 결과 3개 순서대로 ok', () => {
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(s.calls.edit.map(a => [a.sheetId, a.tabName, a.rowId, a.field, a.value]),
      [['s1', 't1', 'r1', 'col:주소', 'A'], ['s1', 't1', 'r2', 'col:주소', 'B'], ['s1', 't1', 'r3', 'col:수취인', 'C']]);
    assert.strictEqual(s.calls.edit[0].by, 'tester');
    assert.deepStrictEqual(r.body.results.map(x => [x.rowId, x.ok, x.status]), [['r1', true, 200], ['r2', true, 200], ['r3', true, 200]]);
    assert.strictEqual(r.body.saved, 3); assert.strictEqual(r.body.failed, 0);
  });
  await t('내부 직원 칸은 참여 기록 맞춤을 칸마다 탄다(한 칸 저장과 동일)', () => assert.strictEqual(s.calls.app.length, 3));

  s = stubAll();
  try {
    r = await call(batch, 'advertiser', { sheetId: 's1', tabName: 't1', cells: [
      { rowId: 'r1', field: 'col:택배송장번호', value: '1234' }, { rowId: 'r2', field: 'col:주소', value: 'x' }, { rowId: 'r3', field: 'is_paid', value: true }] });
  } finally { s.restore(); }
  await t('★ 광고주: 송장 칸만 저장 · 다른 칸은 칸별 403(서비스 호출 0) — 한 칸 저장과 같은 게이트', () => {
    assert.strictEqual(s.calls.edit.length, 1);
    assert.strictEqual(s.calls.edit[0].field, 'col:택배송장번호');
    assert.deepStrictEqual(r.body.results.map(x => x.status), [200, 403, 403]);
    assert.strictEqual(r.body.saved, 1); assert.strictEqual(r.body.failed, 2);
  });
  await t('★ 광고주 칸은 주문 원장 반영·참여 기록 맞춤을 타지 않는다', () => {
    assert.strictEqual(s.calls.sync.length, 0); assert.strictEqual(s.calls.app.length, 0);
  });

  console.log('\n[2] 칸별 독립');
  s = stubAll({
    edit: (a) => a.rowId === 'r2' ? { ok: false, error: 'concurrent_edit_conflict' }
      : a.rowId === 'r3' ? (() => { throw new Error('boom'); })()
      : { ok: true, field: a.field, value: a.value },
    normalize: async ({ header, value }) => header === '결제금액' ? { isPrice: true, ok: false, value } : { isPrice: false, ok: true, value },
  });
  try {
    r = await call(batch, 'staff', { sheetId: 's1', tabName: 't1', cells: [
      { rowId: 'r1', field: 'col:주소', value: 'A' }, { rowId: 'r2', field: 'col:주소', value: 'B' },
      { rowId: 'r3', field: 'col:주소', value: 'C' }, { rowId: 'r4', field: 'col:결제금액', value: '-5' },
      { rowId: 'r5', field: 'col:주소', value: 'E' }, { field: 'col:주소', value: 'F' }] });
  } finally { s.restore(); }
  await t('충돌 409 · 예외 500 · 금액 검증 400 · 필수값 누락 400 이 그 칸에만 · 나머지 칸은 저장', () => {
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(r.body.results.map(x => [x.ok === true, x.status]),
      [[true, 200], [false, 409], [false, 500], [false, 400], [true, 200], [false, 400]]);
    assert.strictEqual(r.body.results[1].error, 'concurrent_edit_conflict');
    assert.ok(/결제금액/.test(r.body.results[3].error));
    assert.strictEqual(r.body.saved, 2); assert.strictEqual(r.body.failed, 4);
  });
  await t('★ 금액 검증 실패 칸은 서비스까지 가지 않는다(한 칸 저장과 같은 순서)', () => {
    assert.ok(!s.calls.edit.some(a => a.rowId === 'r4'));
    assert.ok(s.calls.edit.some(a => a.rowId === 'r5'), '실패 뒤 칸도 계속 저장한다');
  });

  console.log('\n[3] 상한 · 입력');
  s = stubAll();
  try {
    r = await call(batch, 'staff', { sheetId: 's1', tabName: 't1', cells: Array.from({ length: 51 }, (_, i) => ({ rowId: 'r' + i, field: 'col:주소', value: 'v' })) });
  } finally { s.restore(); }
  await t('51칸 묶음 = 통째 400 · 서비스 호출 0', () => {
    assert.strictEqual(r.code, 400); assert.strictEqual(r.body.error, 'too_many_cells'); assert.strictEqual(s.calls.edit.length, 0);
  });
  s = stubAll();
  try { r = await call(batch, 'staff', { sheetId: 's1', tabName: 't1', cells: [] }); } finally { s.restore(); }
  await t('빈 묶음 = 400', () => assert.strictEqual(r.code, 400));

  console.log('\n[4] 주문 원장 반영');
  s = stubAll({ edit: (a) => ({ ok: true, field: a.field, value: a.value, orderSubmissionId: 'o-' + a.rowId, priorValue: 'old' }),
    sync: (a) => a.orderSubmissionId === 'o-r2' ? { attempted: true, ok: false, reason: 'x' } : { attempted: true, ok: true } });
  try {
    r = await call(batch, 'admin', { sheetId: 's1', tabName: 't1', cells: [{ rowId: 'r1', field: 'col:연락처', value: '1' }, { rowId: 'r2', field: 'col:연락처', value: '2' }] });
  } finally { s.restore(); }
  await t('칸마다 through-write 를 부르고 결과(throughWrite)를 칸별로 싣는다', () => {
    assert.deepStrictEqual(s.calls.sync.map(a => [a.orderSubmissionId, a.header, a.oldValue]), [['o-r1', '연락처', 'old'], ['o-r2', '연락처', 'old']]);
    assert.strictEqual(r.body.results[0].throughWrite.ok, true);
    assert.strictEqual(r.body.results[1].throughWrite.ok, false);
  });

  /* ── [5] 실제 요청 한도 + 실제 묶음 핸들러 + 실제 화면 붙여넣기 코드(vm) ── */
  console.log('\n[5] 실제 요청 한도(분당 300) 아래에서 500칸 붙여넣기');
  await realLimiterPaste();

  console.log('\n[6] 한도 초과 재시도 · 구 서버 · 칸별 실패 표시 (가짜 서버 + 실제 화면 코드)');
  await fakeServerCases();
  await supersedeCase();

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

async function realLimiterPaste() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  delete process.env.RL_STAFF_MAX;
  const { rateLimiter } = require('../src/middleware/rateLimit.middleware');
  const auth = require('../src/middleware/auth.middleware');
  const saved = new Map();
  let hits = 0;
  const s = stubAll({ edit: (a) => { saved.set(a.rowId + '|' + a.field, a.value); return { ok: true, field: a.field, value: a.value }; } });
  const batchHandler = handlerOf('post', '/workdesk/edit-batch');
  const app = express(); app.set('trust proxy', 1); app.use(express.json());
  app.use('/api/', rateLimiter);
  // ★ 인증은 이 시험의 대상이 아니다 — 실제 요청 한도가 직원 토큰을 사람별 통(300)으로 세는지만 본다.
  app.post('/api/trackb/workdesk/edit-batch', (req, res, next) => { hits++; req.admin = { role: 'staff', name: '직원' }; batchHandler(req, res, next); });
  const srv = await new Promise(ok => { const x = app.listen(0, () => ok(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tokPayload = { role: 'staff', id: 7, name: '직원' };
  assert.ok(auth.isTrustedLoginToken(tokPayload), '시험 토큰이 직원 통(300)으로 세여야 한다');
  const tok = jwt.sign(tokPayload, process.env.JWT_SECRET);
  try {
    const N = 500;
    const { ctx, rows, jobs } = pasteSandbox(base, tok, N);
    const result = await vm.runInContext('_runPaste()', ctx);
    void jobs;
    const shown = Object.values(rows).filter(r => r.cellEdits['메모'] !== undefined).length;
    await t(`★ 500칸 붙여넣기 → 서버에 500칸 모두 저장 · 화면도 500칸 새 값 유지 (요청 ${hits}번)`, () => {
      assert.strictEqual(saved.size, N, `서버 저장 ${saved.size}`);
      assert.strictEqual(shown, N, `화면 새 값 ${shown}`);
      assert.ok(hits <= 20, `요청 수 ${hits}`);
    });
    await t('★ 결과 요약은 마지막에 한 번 — "500칸 저장" (실패 0)', () => {
      const sums = ctx.toasts.filter(m => /칸 저장/.test(m) && !/저장 중/.test(m));
      assert.strictEqual(sums.length, 1, ctx.toasts.join(' | '));
      assert.ok(/500칸 저장/.test(sums[0]) && !/실패/.test(sums[0]), sums[0]);
      assert.ok(!ctx.toasts.some(m => /편집 거부/.test(m)), '칸별 거부 토스트가 덮어쓰면 안 된다');
      assert.ok(result && result.saved === N, JSON.stringify(result));
    });
    await t('붙여넣기 되돌리기(Ctrl+Z) 묶음에 500칸이 모두 기록된다', () => {
      assert.strictEqual(ctx._cellUndoStack.length, 1);
      assert.strictEqual(ctx._cellUndoStack[0].entries.length, N);
      assert.strictEqual(ctx._cellUndoStack[0].pending, 0);
    });
  } finally { srv.close(); s.restore(); }
}

async function fakeServer(handlers) {
  const express = require('express');
  const app = express(); app.use(express.json());
  const st = { batch: 0, single: 0, custom: 0, inflight: 0, maxInflight: 0, saved: new Map() };
  const wrap = (name) => async (req, res) => {
    st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
    try { await new Promise(r => setTimeout(r, 3)); await handlers[name](req, res, st); } finally { st.inflight--; }
  };
  if (handlers.batch) app.post('/api/trackb/workdesk/edit-batch', wrap('batch'));
  if (handlers.single) app.post('/api/trackb/workdesk/edit', wrap('single'));
  const srv = await new Promise(ok => { const x = app.listen(0, () => ok(x)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, st, close: () => srv.close() };
}
const okCell = (st, c) => { st.saved.set(c.rowId + '|' + c.field, c.value); return { rowId: c.rowId, field: c.field, status: 200, ok: true }; };

async function fakeServerCases() {
  // ㉠ 새 서버가 처음 두 번 429 → 기다렸다 남은 묶음만 다시 → 전부 저장
  {
    let n429 = 0;
    const f = await fakeServer({ batch: (req, res, st) => {
      st.batch++;
      if (n429 < 2) { n429++; return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }); }
      res.json({ ok: true, results: req.body.cells.map(c => okCell(st, c)) });
    } });
    try {
      const { ctx } = pasteSandbox(f.base, 'tok', 120);
      const r = await vm.runInContext('_runPaste()', ctx);
      await t('㉠ 429 두 번 → 기다렸다 다시 보내 120칸 전부 저장 · 대기 안내 → 마지막 요약 한 번', () => {
        assert.strictEqual(f.st.saved.size, 120); assert.strictEqual(r.saved, 120);
        assert.ok(ctx.toasts.some(m => /기다렸다가 남은 칸을 이어서 저장/.test(m)), ctx.toasts.join(' | '));
        assert.ok(/^120칸 저장$/.test(ctx.toasts[ctx.toasts.length - 1]), ctx.toasts[ctx.toasts.length - 1]);
        assert.ok(f.st.batch <= 3 + 2, '재시도는 막힌 묶음만 ' + f.st.batch);
      });
    } finally { f.close(); }
  }
  // ㉡ 계속 429 → 정해진 횟수만 시도하고 끝낸다(무한 루프 금지) · 화면은 원래 값 + 실패 표시 · 실패 건수 요약
  {
    const f = await fakeServer({ batch: (req, res, st) => { st.batch++; res.status(429).json({ error: '요청이 너무 많습니다.' }); } });
    try {
      const { ctx, rows, jobs } = pasteSandbox(f.base, 'tok', 60);
      const r = await vm.runInContext('_runPaste()', ctx);
      const tries = vm.runInContext('_EDIT_429_TRIES', ctx);
      await t('㉡ 계속 429 = 묶음당 (1+재시도 상한)번에서 멈춘다 · 60칸 실패 · 화면 원래 값 · 빨간 표시', () => {
        assert.strictEqual(r.saved, 0); assert.strictEqual(r.failed, 60);
        assert.strictEqual(f.st.batch, 2 * (1 + tries), '보낸 횟수 ' + f.st.batch);
        assert.strictEqual(Object.values(rows).filter(x => x.cellEdits['메모'] !== undefined).length, 0, '실패 칸이 새 값으로 남았다');
        assert.ok(jobs.every(td => td.classList.contains('cellfailed')), '실패 칸 표시 없음');
        const last = ctx.toasts[ctx.toasts.length - 1];
        assert.ok(/^0칸 저장 · 60칸 실패/.test(last) && /요청이 너무 많습니다/.test(last), last);
        assert.strictEqual(ctx.toasts.filter(m => /칸 실패/.test(m)).length, 1, '요약은 한 번만');
      });
    } finally { f.close(); }
  }
  // ㉢ 구 서버(묶음 경로 404) → 칸별 저장으로 되돌아가되 동시 요청 6개 이하 · 429 는 그 칸만 다시
  {
    let budget = 40, n429 = 0;
    const f = await fakeServer({ single: (req, res, st) => {
      st.single++;
      if (budget-- <= 0 && n429 < 12) { n429++; if (n429 === 12) budget = 1e9; return res.status(429).json({ error: '요청이 너무 많습니다.' }); }
      res.json(okCell(st, req.body));
    } });
    try {
      const { ctx } = pasteSandbox(f.base, 'tok', 100);
      const r = await vm.runInContext('_runPaste()', ctx);
      await t('㉢ 구 서버: 묶음 404 → 칸별 저장 100칸 전부 · 동시 요청 ≤ 6 · 한도 걸린 칸만 다시', () => {
        assert.strictEqual(f.st.saved.size, 100); assert.strictEqual(r.saved, 100);
        assert.ok(f.st.maxInflight <= 6, '동시 요청 ' + f.st.maxInflight);
        assert.strictEqual(vm.runInContext('_editBatchUnsupported', ctx), true);
      });
    } finally { f.close(); }
  }
  // ㉣ 묶음 안 일부 칸만 실패 → 그 칸만 원래 값 + 표시 · 나머지는 새 값 · 실행취소 기록은 성공 칸만
  {
    const f = await fakeServer({ batch: (req, res, st) => {
      res.json({ ok: true, results: req.body.cells.map(c => (c.rowId === 'r3' || c.rowId === 'r7')
        ? { rowId: c.rowId, field: c.field, status: 400, ok: false, error: 'row_not_found' } : okCell(st, c)) });
    } });
    try {
      const { ctx, rows, jobs } = pasteSandbox(f.base, 'tok', 10);
      await vm.runInContext('_runPaste()', ctx);
      await t('㉣ 10칸 중 2칸 실패 → "8칸 저장 · 2칸 실패" · 그 2칸만 원래 값 + 빨간 표시', () => {
        const last = ctx.toasts[ctx.toasts.length - 1];
        assert.ok(/^8칸 저장 · 2칸 실패/.test(last) && /row_not_found/.test(last), last);
        assert.strictEqual(rows.r3.cellEdits['메모'], undefined); assert.strictEqual(rows.r4.cellEdits['메모'], 'v4');
        assert.deepStrictEqual(jobs.map((td, i) => td.classList.contains('cellfailed') ? i : -1).filter(i => i >= 0), [3, 7]);
        assert.strictEqual(ctx._cellUndoStack[0].entries.length, 8);
        assert.deepStrictEqual(ctx.toasts.length, 2, '칸별 거부 토스트 0 — 저장 중 + 요약만: ' + ctx.toasts.join(' | '));
      });
    } finally { f.close(); }
  }
}

async function supersedeCase() {
  // Codex P2(PR #1753): 대기열에 있던 칸을 저장 전에 사람이 다시 고치면, 뒤늦은 붙여넣기 값이 그것을 덮으면 안 된다.
  let release; const hold = new Promise(r => { release = r; });
  const order = [];
  const f = await fakeServer({
    batch: async (req, res, st) => { st.batch++; await hold; res.json({ ok: true, results: req.body.cells.map(c => { order.push('batch:' + c.rowId); return okCell(st, c); }) }); },
    single: (req, res, st) => { order.push('single:' + req.body.rowId); res.json(okCell(st, req.body)); },
  });
  try {
    const { ctx, rows } = pasteSandbox(f.base, 'tok', 150);
    const p = vm.runInContext('_runPaste()', ctx);
    await new Promise(r => setTimeout(r, 30));
    // 세 번째 묶음(r100~r149)은 아직 대기열 · 첫 묶음(r0~)은 서버에서 붙잡혀 진행 중
    const e1 = vm.runInContext("_editNow(149,'사람이 고침')", ctx);   // 아직 안 보낸 칸
    const e2 = vm.runInContext("_editNow(0,'진행중 칸 고침')", ctx);  // 이미 보낸(진행 중) 칸
    await new Promise(r => setTimeout(r, 80));   // 새 편집이 (막지 않으면) 서버에 먼저 닿을 시간
    release();
    const r = await p; await e1; await e2;
    await t('★ 대기 중 칸을 다시 고치면 고친 값이 서버에 남는다(붙여넣기 값이 덮지 않음)', () => {
      assert.strictEqual(f.st.saved.get('r149|col:메모'), '사람이 고침');
      assert.strictEqual(rows.r149.cellEdits['메모'], '사람이 고침');
      assert.ok(!order.includes('batch:r149'), '이미 다시 고친 칸을 묶음으로 보냈다');
    });
    await t('★ 진행 중인 칸을 다시 고치면 묶음이 끝난 뒤에 보낸다(나중 편집이 이긴다)', () => {
      assert.ok(order.indexOf('batch:r0') >= 0 && order.indexOf('single:r0') > order.indexOf('batch:r0'), order.slice(0, 5).join(','));
      assert.strictEqual(f.st.saved.get('r0|col:메모'), '진행중 칸 고침');
      assert.strictEqual(r.later, 1); assert.strictEqual(r.failed, 0);
      assert.ok(/^149칸 저장 · 저장 중에 다시 고친 1칸은 고친 값으로$/.test(ctx.toasts[ctx.toasts.length - 1]), ctx.toasts.join(' | '));
    });
  } finally { f.close(); }
}

/* 화면(workdesk.html)에서 붙여넣기·저장 함수를 그대로 꺼내 vm 에서 실행한다. */
function grabFrom(html, name) {
  const i = html.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('함수를 찾지 못함: ' + name);
  const at = html.lastIndexOf('async ', i) === i - 6 ? i - 6 : i;
  let d = 0, started = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (c === '{') { d++; started = true; } else if (c === '}') { d--; if (started && d === 0) return html.slice(at, j + 1); }
  }
  throw new Error('본문 끝을 찾지 못함: ' + name);
}
function constLine(html, name) {
  const m = new RegExp('const ' + name + '=[^;]+;').exec(html);
  if (!m) throw new Error('상수를 찾지 못함: ' + name);
  return m[0];
}
function pasteSandbox(base, tok, N) {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
  const rows = {}; for (let i = 0; i < N; i++) rows['r' + i] = { id: 'r' + i, cellEdits: {} };
  const mkTd = (i) => {
    const cls = new Set(['gcell', 'gedit']);
    return { _a: { 'data-id': 'r' + i, 'data-field': 'col:메모', 'data-val': '' },
      classList: { add: (...c) => c.forEach(x => cls.add(x)), remove: (...c) => c.forEach(x => cls.delete(x)), contains: c => cls.has(c), toggle: () => {} },
      getAttribute(k) { return k in this._a ? this._a[k] : null; } };
  };
  const tds = Array.from({ length: N }, (_, i) => mkTd(i));
  const ctx = { fetch, API_BASE: base, token: () => tok, rows, console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, Date,
    toasts: [], STATE: { cur: { sheetId: 's', tabName: 't' } }, tds };
  vm.createContext(ctx);
  const names = ['_beginCellUndoGroup', '_finishCellUndoGroup', '_recordCellUndo', 'commitCellEdit', '_wdPostStatus', '_cellLocalIs', '_wdCellSaveQueue', '_pasteSummary'];
  vm.runInContext(`
    function toast(m){ toasts.push(String(m)); }
    function _dropSession(){}
    function _gridRowById(id){ return rows[id]; }
    function _paintGridCell(){}
    function reloadWorkdesk(){ toasts.push('[reload]'); }
    function api(p,o){ return fetch(API_BASE+p,Object.assign({headers:{Authorization:'Bearer '+token(),'Content-Type':'application/json'}},o)).then(r=>r.json()); }
    const _CELL_UNDO_MAX=1000; const _cellUndoStack=[]; const _cellPendingWrites=new Map();
    ${['_EDIT_BATCH_MAX', '_EDIT_BATCH_PAR', '_EDIT_FALLBACK_PAR', '_EDIT_429_TRIES'].map(n => constLine(html, n)).join('\n')}
    let _EDIT_429_WAIT_MS=50; let _editBatchUnsupported=false;
    ${names.map(n => grabFrom(html, n)).join('\n')}
    function _editNow(i,v){ return commitCellEdit('r'+i,'col:메모',v,tds[i]); }
    function _runPaste(){
      const jobs=tds.map((td,i)=>({rowId:'r'+i, field:'col:메모', val:'v'+i, td}));
      return _saveCellJobs(jobs, 0);
    }
    ${grabFrom(html, '_saveCellJobs')}
    this._cellUndoStack=_cellUndoStack;
  `, ctx);
  return { ctx, rows, jobs: tds };
}
