'use strict';
/*
 * 번진 입금일 정리 — 판정 규칙 회귀가드 (사용자 확정 2026-08-19).
 *
 *   · 그룹에 리뷰 제출된 줄이 **정확히 1개** → 그 줄만 남기고 나머지에서 그 날짜 회수
 *   · **0개 또는 2개 이상 → 보류**(자동 판단 금지)
 *   · 남길 줄은 절대 건드리지 않는다 · 같은 칸의 다른 입금일은 보존
 *   · 회수는 **수동 이력 회차(#0)** 항목만 — 실제 이체 회차는 건드리지 않는다
 *
 * ★ 문자열 검사가 아니라 **스텁 DB 로 서비스를 실행**해 실제로 어떤 UPDATE 가 나가는지 본다
 *   (조건을 지워도 문자열은 남기 때문). 되돌릴 수 없는 조작이라 실행 검증이 필수다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const svcPath = path.join(root, 'src/services/manualDepositRepair.service.js');
const src = fs.readFileSync(svcPath, 'utf8');

/* ── 스텁 pool: _fanoutGroups 조회 + 실행 UPDATE 를 가로챈다 ─────────────── */
function makePool(markRows) {
  const writes = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|advisory_xact_lock/.test(s)) return { rows: [] };
      if (/FROM manual_payment_marks m/.test(s)) return { rows: markRows };
      writes.push({ s, params });
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return {
    writes, client,
    async connect() { return client; },
    async query(sql, params) { return client.query(sql, params); },
  };
}

function mark(o) {
  return {
    markId: o.markId || 'm1', sheetId: 's', tabName: 'T',
    anchorType: 'order', anchorValue: 'os-dup', depositColKey: '입금', stamp: '8/11',
    rowId: o.rowId, rowIndex: o.rowIndex, reviewerName: o.name || '박',
    paidValue: o.paidValue == null ? '8/11' : o.paidValue,
    submitted: !!o.submitted, sheetless: o.sheetless !== false,
  };
}

(async () => {
  // 서비스는 pool 을 직접 require 하므로 모듈 캐시를 갈아끼운다.
  const poolPath = require.resolve(path.join(root, 'src/db/pool'));
  const ledgerPath = require.resolve(path.join(root, 'src/services/sheetlessLedger.service'));
  const install = (p) => {
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: p };
    require.cache[ledgerPath] = { id: ledgerPath, filename: ledgerPath, loaded: true,
      exports: { rebuildLedgers: async () => ({ ok: true }) } };
    delete require.cache[require.resolve(svcPath)];
    return require(svcPath);
  };

  /* 1. 제출 1개 → 그 줄만 남기고 나머지 회수 */
  let pool = makePool([
    mark({ rowId: 'a', rowIndex: 179, submitted: true }),
    mark({ rowId: 'b', rowIndex: 189, submitted: false }),
    mark({ rowId: 'c', rowIndex: 199, submitted: false }),
  ]);
  let svc = install(pool);
  let pv = await svc.previewDepositFanoutCleanup({});
  assert.equal(pv.items[0].keepRow, 179, '1a: 리뷰 제출된 줄을 남긴다');
  assert.deepEqual(pv.items[0].dropRows, [189, 199], '1b: 나머지를 회수 대상으로');
  assert.equal(pv.summary.dropRows, 2);
  assert.equal(pv.dryRun, true, '1c: 미리보기는 dryRun');
  assert.equal(pool.writes.length, 0, '1d: 미리보기는 쓰기 0');

  const out = await svc.applyDepositFanoutCleanup({ by: 'tester' });
  const cellW = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(cellW.length, 2, '1e: 회수 대상 2줄만 갱신');
  assert.ok(!cellW.some(w => w.params[0] === 'a'), '1f: 남길 줄은 절대 건드리지 않는다');
  assert.deepEqual(cellW.map(w => w.params[0]).sort(), ['b', 'c']);
  assert.equal(cellW[0].params[2], '', '1g: 8/11 만 있던 칸은 비워진다');
  const itemW = pool.writes.filter(w => /UPDATE payment_batch_items/.test(w.s));
  assert.equal(itemW.length, 2, '1h: 회차 항목도 함께 회수');
  assert.ok(/historical_key = 'manual-811'/.test(itemW[0].s), '1i: 수동 이력 회차(#0) 항목만 회수');
  assert.ok(/i.status = 'paid'/.test(itemW[0].s), '1j: paid 항목만');
  const reW = pool.writes.filter(w => /UPDATE manual_payment_marks/.test(w.s));
  assert.equal(reW.length, 1, '1k: 마커를 남긴 줄로 재고정');
  assert.equal(reW[0].params[1], 'a', '1l: 재고정 대상은 남긴 줄');
  assert.ok(/anchor_type = 'manual'/.test(reW[0].s), '1m: 정확 앵커(manual)로 고정');
  assert.equal(out.removedCells, 2);

  /* 2. 제출 0개 → 보류(쓰기 0) — 사용자 확정 */
  pool = makePool([
    mark({ rowId: 'a', rowIndex: 179, submitted: false }),
    mark({ rowId: 'b', rowIndex: 189, submitted: false }),
  ]);
  svc = install(pool);
  pv = await svc.previewDepositFanoutCleanup({});
  assert.equal(pv.items[0].hold, 'no_submitted_row', '2a: 제출 0개는 보류');
  assert.equal(pv.items[0].keepRow, null, '2b: 남길 줄을 임의로 고르지 않는다');
  assert.equal(pv.summary.dropRows, 0);
  await assert.rejects(() => svc.applyDepositFanoutCleanup({}), /정리할 대상이 없습니다/, '2c: 보류만 있으면 실행 거부');
  assert.equal(pool.writes.length, 0, '2d: 보류는 쓰기 0');

  /* 3. 제출 2개 이상 → 보류 */
  pool = makePool([
    mark({ rowId: 'a', rowIndex: 179, submitted: true }),
    mark({ rowId: 'b', rowIndex: 189, submitted: true }),
  ]);
  svc = install(pool);
  pv = await svc.previewDepositFanoutCleanup({});
  assert.equal(pv.items[0].hold, 'multiple_submitted_rows', '3a: 제출 2개 이상은 보류');
  assert.equal(pv.summary.dropRows, 0);

  /* 4. 시트 기반 탭은 보류(작업표 값을 지워도 빌드가 되돌린다) */
  pool = makePool([
    mark({ rowId: 'a', rowIndex: 1, submitted: true, sheetless: false }),
    mark({ rowId: 'b', rowIndex: 2, submitted: false, sheetless: false }),
  ]);
  svc = install(pool);
  pv = await svc.previewDepositFanoutCleanup({});
  assert.equal(pv.items[0].hold, 'not_sheetless', '4a: 시트 기반은 보류');

  /* 5. 다른 입금일은 보존 — 그 날짜 토큰만 제거 */
  pool = makePool([
    mark({ rowId: 'a', rowIndex: 1, submitted: true }),
    mark({ rowId: 'b', rowIndex: 2, submitted: false, paidValue: '8/3, 8/11' }),
  ]);
  svc = install(pool);
  await svc.applyDepositFanoutCleanup({});
  const w5 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w5.length, 1);
  assert.equal(w5[0].params[2], '8/3', '5a: 같은 칸의 다른 입금일은 보존한다');
  assert.ok(!pool.writes.some(w => /UPDATE review_index/.test(w.s)),
    '5b: 칸이 비지 않으면 입금완료 표시를 내리지 않는다');

  /* 6. 그 날짜가 없는 줄은 회수 대상이 아니다(헛 UPDATE 금지) */
  pool = makePool([
    mark({ rowId: 'a', rowIndex: 1, submitted: true }),
    mark({ rowId: 'b', rowIndex: 2, submitted: false, paidValue: '' }),
  ]);
  svc = install(pool);
  pv = await svc.previewDepositFanoutCleanup({});
  assert.equal(pv.summary.dropRows, 0, '6a: 그 날짜가 없는 줄은 대상 아님');

  /* 7. 번지지 않은 마커(1줄)는 애초에 대상이 아니다 */
  pool = makePool([mark({ rowId: 'a', rowIndex: 1, submitted: true })]);
  svc = install(pool);
  pv = await svc.previewDepositFanoutCleanup({});
  assert.equal(pv.items.length, 0, '7a: 유일 앵커는 정리 대상이 아니다');

  console.log('deposit fan-out cleanup rules passed');
})().catch(e => { console.error(e); process.exit(1); });

/* ── 8. 라우트·화면 배선 ────────────────────────────────────────────────── */
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
assert.match(routes, /router\.get\('\/payment\/repair\/deposit-fanout-cleanup', authMiddleware, adminOrMasterMiddleware/,
  '미리보기는 관리자 전용 GET');
assert.match(routes, /router\.post\('\/payment\/repair\/deposit-fanout-cleanup', authMiddleware, adminOrMasterMiddleware/,
  '실행은 관리자 전용 POST');
const postStart = routes.indexOf("router.post('/payment/repair/deposit-fanout-cleanup'");
const postSrc = routes.slice(postStart, routes.indexOf('\nrouter.', postStart + 10));
assert.match(postSrc, /confirm !== true/, '실행은 confirm 없이는 안 된다');

const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
assert.match(workdesk, /_pmOpenFanoutCleanup/, '점검 화면에 정리 진입점이 있어야 한다');
assert.match(workdesk, /_pmApplyFanoutCleanup/, '실행 함수가 있어야 한다');
const applyStart = workdesk.indexOf('async function _pmApplyFanoutCleanup');
const applySrc = workdesk.slice(applyStart, applyStart + 1600);
assert.match(applySrc, /confirm\(/, '실행 전 확인창이 있어야 한다');
assert.match(applySrc, /되돌릴 수 없습니다/, '되돌릴 수 없음을 말해야 한다');
assert.match(applySrc, /confirm:true/, 'confirm 을 서버로 보내야 한다');
// ★ 화면이 판정을 다시 하지 않는다 — 서버 계획을 그대로 실행한다
assert.doesNotMatch(applySrc, /submitted|keepRow\s*=/, '화면에서 남길 줄을 다시 정하면 안 된다');

/* ── 9. 정리 모달을 가짜 DOM 위에서 실제 실행 ──────────────────────────── */
{
  const vm = require('vm');
  const start = workdesk.indexOf('async function _pmOpenFanoutCleanup');
  const end = workdesk.indexOf('\nfunction _pmOpenDepositDateCorrection');
  assert.ok(start > 0 && end > start, '정리 모달 블록을 찾아야 한다');
  const mk = () => ({ id: '', className: '', innerHTML: '', value: '', addEventListener() {}, appendChild() {}, remove() {} });
  const ov = mk(); const bd = mk();
  let posted = null; let confirmed = true; const toasts = [];
  const sandbox = {
    STATE: { cur: { sheetId: 'sh', tabName: 'T' } },
    esc: v => String(v == null ? '' : v),
    document: { createElement: () => ov, body: { appendChild() {} },
      getElementById: id => (id === 'pmfanoutbd' ? bd : (id === 'pmfanoutov' ? ov : null)) },
    api: null, toast: m => toasts.push(m), confirm: () => confirmed,
    _pmLoad: async () => {}, _pmOpenDepositAnomalies: async () => {}, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(workdesk.slice(start, end), sandbox);

  (async () => {
    const plan = { ok: true, dryRun: true, stamp: '8/11',
      summary: { groups: 2, actionableGroups: 1, dropRows: 2, holdGroups: 1 },
      items: [
        { tabName: 'T', reviewerName: 'A', rows: [179, 189, 199], keepRow: 179, dropRows: [189, 199], submittedCount: 1, hold: null },
        { tabName: 'T', reviewerName: 'B', rows: [10, 11], keepRow: null, dropRows: [], submittedCount: 0,
          hold: 'no_submitted_row', holdReason: '리뷰 제출된 줄이 없습니다' },
      ] };
    sandbox.api = async (u, opt) => {
      if (opt && opt.method === 'POST') { posted = JSON.parse(opt.body); return { ok: true, removedCells: 2, cancelledItems: 2, reanchored: 1 }; }
      return plan;
    };
    await sandbox._pmOpenFanoutCleanup();
    assert.ok(bd.innerHTML.includes('179, 189, 199'), '9a: 가리키는 줄을 보여준다');
    assert.ok(bd.innerHTML.includes('리뷰 제출된 줄이 없습니다'), '9b: 보류 사유를 보여준다');
    assert.ok(bd.innerHTML.includes('이대로 정리 (2줄)'), '9c: 회수할 줄 수를 버튼에 적는다');

    await sandbox._pmApplyFanoutCleanup();
    assert.equal(posted && posted.confirm, true, '9d: confirm 을 보낸다');
    assert.equal(posted.stamp, '8/11', '9e: 대상 날짜를 보낸다');
    assert.ok(toasts.some(t => /정리 완료/.test(t)), '9f: 결과를 사실대로 말한다');

    // 확인창을 취소하면 전송하지 않는다
    posted = null; confirmed = false;
    await sandbox._pmApplyFanoutCleanup();
    assert.equal(posted, null, '9g: 확인창 취소 시 아무것도 보내지 않는다');

    // 대상 0건이면 실행 버튼 비활성
    confirmed = true;
    sandbox.api = async () => ({ ok: true, summary: { actionableGroups: 0, dropRows: 0, holdGroups: 1 }, items: [] });
    await sandbox._pmOpenFanoutCleanup();
    assert.ok(/disabled/.test(bd.innerHTML), '9h: 정리할 것이 없으면 실행 버튼을 잠근다');
    console.log('deposit fan-out cleanup modal runtime guard passed');
  })().catch(e => { console.error(e); process.exit(1); });
}

console.log('deposit fan-out cleanup wiring passed');
