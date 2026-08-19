'use strict';
/*
 * "직원이 최초로 적은 입금일" 복원 — 판정·동작 회귀가드 (사용자 확정 2026-08-19).
 *
 *   목표 상태: 원래 줄(리뷰 제출된 줄)에는 직원이 친 값이 **그대로 남고**,
 *              번져 나간 줄에서는 **사라진다**.
 *   ★ 오버레이만으로는 중복 줄을 구분할 수 없으므로(합성 앵커가 같다) 원래 줄에 **실제로 새기고**
 *     오버레이는 이력으로 내린다.
 *   ★ 입금 원장이 있는 줄은 **지우지 않는다**(실제 이체일 수 있다 — fail-closed).
 *   ★ 제출된 줄이 0개·2개 이상이면 **보류**(자동 판단 금지).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const svcPath = path.join(root, 'src/services/manualDepositRepair.service.js');

function makePool(editRows) {
  const writes = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|advisory_xact_lock/.test(s)) return { rows: [] };
      if (/FROM participant_edits pe/.test(s) && /JOIN campaign_participants/.test(s)) return { rows: editRows };
      writes.push({ s, params });
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { writes, client, async connect() { return client; }, async query(a, b) { return client.query(a, b); } };
}

function row(o) {
  return {
    editId: o.editId || 'e1', sheetId: 's', tabName: 'T',
    anchorType: 'order', anchorValue: 'os-1', stamp: o.stamp || '8/11',
    createdBy: '직원', createdAt: null, depositColKey: '입금', sheetless: o.sheetless !== false,
    rowId: o.rowId, rowIndex: o.rowIndex, reviewerName: '박',
    paidValue: o.paidValue == null ? (o.stamp || '8/11') : o.paidValue,
    submitted: !!o.submitted, hasLedger: !!o.hasLedger,
  };
}

(async () => {
  const poolPath = require.resolve(path.join(root, 'src/db/pool'));
  const ledgerPath = require.resolve(path.join(root, 'src/services/sheetlessLedger.service'));
  const install = (p) => {
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: p };
    require.cache[ledgerPath] = { id: ledgerPath, filename: ledgerPath, loaded: true,
      exports: { rebuildLedgers: async () => ({ ok: true }) } };
    delete require.cache[require.resolve(svcPath)];
    return require(svcPath);
  };

  /* 1. 제출 1개 → 그 줄에 새기고 나머지에서 지운다 */
  let pool = makePool([
    row({ rowId: 'a', rowIndex: 38, submitted: true }),
    row({ rowId: 'b', rowIndex: 96, submitted: false }),
  ]);
  let svc = install(pool);
  let pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].keepRow, 38, '1a: 리뷰 제출된 줄이 원래 줄');
  assert.deepEqual(pv.items[0].clearRows, [96], '1b: 번진 줄만 지운다');
  assert.equal(pool.writes.length, 0, '1c: 미리보기는 쓰기 0');

  let out = await svc.applyOverlayFanoutFix({ by: 't' });
  const cw = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(cw.length, 2, '1d: 원래 줄 새김 + 번진 줄 제거');
  assert.equal(cw[0].params[0], 'a', '1e: 첫 쓰기는 원래 줄');
  assert.equal(cw[0].params[2], '8/11', '1f: 직원이 친 값을 그대로 새긴다');
  assert.ok(/is_paid = TRUE/.test(cw[0].s), '1g: 원래 줄은 입금완료로');
  assert.equal(cw[1].params[0], 'b');
  assert.equal(cw[1].params[2], '', '1h: 번진 줄에서는 값이 사라진다');
  const rv = pool.writes.filter(w => /UPDATE participant_edits SET reverted_at/.test(w.s));
  assert.equal(rv.length, 1, '1i: 오버레이를 이력으로 내린다');
  assert.ok(/field IN \('col:입금', 'is_paid'\)/.test(rv[0].s), '1j: 짝 is_paid 토글도 함께 — 집계가 어긋나지 않게');
  assert.equal(out.keptRows, 1); assert.equal(out.clearedRows, 1);

  /* 2. 입금 원장이 있는 줄은 지우지 않는다(fail-closed) */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 38, submitted: true }),
    row({ rowId: 'b', rowIndex: 96, submitted: false, hasLedger: true }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.deepEqual(pv.items[0].clearRows, [], '2a: 원장 있는 줄은 지움 대상 아님');
  assert.deepEqual(pv.items[0].ledgerBlockedRows, [96], '2b: 보존 사유를 드러낸다');
  await svc.applyOverlayFanoutFix({});
  assert.ok(!pool.writes.some(w => /UPDATE campaign_participants/.test(w.s) && w.params[0] === 'b'),
    '2c: 원장 있는 줄은 건드리지 않는다');

  /* 3. 제출 0개·2개 이상 → 보류(쓰기 0) */
  for (const [rows, why] of [
    [[row({ rowId: 'a', rowIndex: 1 }), row({ rowId: 'b', rowIndex: 2 })], 'no_submitted_row'],
    [[row({ rowId: 'a', rowIndex: 1, submitted: true }), row({ rowId: 'b', rowIndex: 2, submitted: true })], 'multiple_submitted_rows'],
  ]) {
    pool = makePool(rows); svc = install(pool);
    pv = await svc.previewOverlayFanoutFix({});
    assert.equal(pv.items[0].hold, why, `3: ${why} 는 보류`);
    assert.equal(pv.items[0].keepRow, null, '3b: 원래 줄을 임의로 고르지 않는다');
    await assert.rejects(() => svc.applyOverlayFanoutFix({}), /복원할 대상이 없습니다/);
    assert.equal(pool.writes.length, 0, '3c: 보류는 쓰기 0');
  }

  /* 4. 시트 기반 탭은 보류 */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, sheetless: false }),
    row({ rowId: 'b', rowIndex: 2, sheetless: false }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items[0].hold, 'not_sheetless', '4a: 시트 기반은 보류');

  /* 5. 같은 칸의 다른 입금일은 보존 — 그 값만 뺀다 */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2, paidValue: '8/3, 8/11' }),
  ]);
  svc = install(pool);
  await svc.applyOverlayFanoutFix({});
  const w5 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w5.find(w => w.params[0] === 'b').params[2], '8/3', '5a: 다른 입금일은 보존');

  /* 6. 날짜가 아닌 표기(계좌 오류)도 그대로 복원되고 번진 줄에서만 사라진다 */
  pool = makePool([
    row({ rowId: 'a', rowIndex: 1, submitted: true, stamp: '계좌 오류', paidValue: '' }),
    row({ rowId: 'b', rowIndex: 2, stamp: '계좌 오류', paidValue: '계좌 오류' }),
  ]);
  svc = install(pool);
  await svc.applyOverlayFanoutFix({});
  const w6 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w6.find(w => w.params[0] === 'a').params[2], '계좌 오류', '6a: 직원이 친 문구 그대로');
  assert.equal(w6.find(w => w.params[0] === 'b').params[2], '', '6b: 번진 줄에서는 사라진다');

  /* 7. 번지지 않은 표기(1줄)는 애초에 손대지 않는다 */
  pool = makePool([row({ rowId: 'a', rowIndex: 1, submitted: true })]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.items.length, 0, '7a: 정상 표기는 대상이 아니다');

  /* 8. 8/11·8/12 가 섞여 있어도 각각 자기 값으로 처리된다 */
  pool = makePool([
    row({ editId: 'e1', rowId: 'a', rowIndex: 1, submitted: true, stamp: '8/11', paidValue: '' }),
    row({ editId: 'e1', rowId: 'b', rowIndex: 2, stamp: '8/11' }),
    row({ editId: 'e2', rowId: 'c', rowIndex: 3, submitted: true, stamp: '8/12', paidValue: '' }),
    row({ editId: 'e2', rowId: 'd', rowIndex: 4, stamp: '8/12' }),
  ]);
  svc = install(pool);
  pv = await svc.previewOverlayFanoutFix({});
  assert.equal(pv.summary.byStamp['8/11'].groups, 1, '8a: 날짜별로 센다');
  assert.equal(pv.summary.byStamp['8/12'].groups, 1);
  out = await svc.applyOverlayFanoutFix({});
  const w8 = pool.writes.filter(w => /UPDATE campaign_participants/.test(w.s));
  assert.equal(w8.find(w => w.params[0] === 'a').params[2], '8/11');
  assert.equal(w8.find(w => w.params[0] === 'c').params[2], '8/12', '8b: 각 값이 자기 줄에 새겨진다');
  assert.equal(out.keptRows, 2); assert.equal(out.clearedRows, 2);

  console.log('deposit overlay restore rules passed');
})().catch(e => { console.error(e); process.exit(1); });

/* ── 9. 라우트·화면 배선 ────────────────────────────────────────────────── */
const routes = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
assert.match(routes, /router\.get\('\/payment\/repair\/deposit-overlay-fix', authMiddleware, adminOrMasterMiddleware/);
assert.match(routes, /router\.post\('\/payment\/repair\/deposit-overlay-fix', authMiddleware, adminOrMasterMiddleware/);
const ps = routes.indexOf("router.post('/payment/repair/deposit-overlay-fix'");
assert.match(routes.slice(ps, routes.indexOf('\nrouter.', ps + 10)), /confirm !== true/, '실행은 confirm 필수');

const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');
assert.match(workdesk, /onclick="_pmOpenOverlayFix\(\)"/, '점검 화면 ④ 아래에 복원 진입점');
const as = workdesk.indexOf('async function _pmApplyOverlayFix');
const asrc = workdesk.slice(as, as + 1500);
assert.match(asrc, /confirm\(/, '실행 전 확인창');
assert.match(asrc, /되돌릴 수 없습니다/);
assert.doesNotMatch(asrc, /submitted|keepRow\s*=/, '화면에서 원래 줄을 다시 정하면 안 된다');

/* ── 10. 복원 모달을 가짜 DOM 위에서 실제 실행 ────────────────────────── */
{
  const vm = require('vm');
  const st = workdesk.indexOf('async function _pmOpenOverlayFix');
  const en = workdesk.indexOf('/* 번진 입금일 정리 — 미리보기');
  assert.ok(st > 0 && en > st, '복원 모달 블록을 찾아야 한다');
  const mk = () => ({ id: '', className: '', innerHTML: '', value: '', addEventListener() {}, appendChild() {}, remove() {} });
  const ov = mk(); const bd = mk();
  let posted = null; let confirmed = true; const toasts = [];
  const sandbox = {
    STATE: { cur: { sheetId: 'sh', tabName: 'T' } },
    esc: v => String(v == null ? '' : v),
    document: { createElement: () => ov, body: { appendChild() {} },
      getElementById: id => (id === 'pmovfixbd' ? bd : (id === 'pmovfixov' ? ov : null)) },
    api: null, toast: m => toasts.push(m), confirm: () => confirmed,
    _pmLoad: async () => {}, _pmOpenDepositAnomalies: async () => {}, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(workdesk.slice(st, en), sandbox);

  (async () => {
    sandbox.api = async (u, opt) => {
      if (opt && opt.method === 'POST') { posted = JSON.parse(opt.body); return { ok: true, keptRows: 2, clearedRows: 2, revertedEdits: 4 }; }
      return { ok: true, dryRun: true,
        summary: { groups: 3, actionableGroups: 2, keepRows: 2, clearRows: 2, ledgerBlockedRows: 1, holdGroups: 1,
          byStamp: { '8/11': { groups: 2, hold: 1 }, '8/12': { groups: 1, hold: 0 } } },
        items: [
          { tabName: 'T', reviewerName: 'A', stamp: '8/11', rows: [38, 96], keepRow: 38, clearRows: [96], ledgerBlockedRows: [], submittedCount: 1, hold: null },
          { tabName: 'T', reviewerName: 'B', stamp: '8/11', rows: [118, 119], keepRow: 118, clearRows: [], ledgerBlockedRows: [119], submittedCount: 1, hold: null },
          { tabName: 'T', reviewerName: 'C', stamp: '8/12', rows: [295, 296], keepRow: null, clearRows: [], submittedCount: 0,
            hold: 'no_submitted_row', holdReason: '리뷰 제출된 줄이 없습니다' },
        ] };
    };
    await sandbox._pmOpenOverlayFix();
    assert.ok(bd.innerHTML.includes('8/11') && bd.innerHTML.includes('8/12'), '10a: 날짜별로 규모를 보여준다');
    assert.ok(bd.innerHTML.includes('<td>38</td>') && bd.innerHTML.includes('<td>96</td>'), '10b: 남길 줄·지울 줄');
    assert.ok(bd.innerHTML.includes('<td>119</td>'), '10c: 원장 있어 보존하는 줄을 드러낸다');
    assert.ok(bd.innerHTML.includes('리뷰 제출된 줄이 없습니다'), '10d: 보류 사유');
    assert.ok(bd.innerHTML.includes('이대로 복원 (2건)'), '10e: 실행 건수를 버튼에 적는다');

    await sandbox._pmApplyOverlayFix();
    assert.equal(posted && posted.confirm, true, '10f: confirm 을 보낸다');
    assert.ok(toasts.some(t => /복원 완료/.test(t)), '10g: 결과를 사실대로 말한다');

    posted = null; confirmed = false;
    await sandbox._pmApplyOverlayFix();
    assert.equal(posted, null, '10h: 확인창 취소 시 아무것도 보내지 않는다');

    confirmed = true;
    sandbox.api = async () => ({ ok: true, summary: { actionableGroups: 0, keepRows: 0, clearRows: 0, holdGroups: 3, byStamp: {} }, items: [] });
    await sandbox._pmOpenOverlayFix();
    assert.ok(/disabled/.test(bd.innerHTML), '10i: 복원할 것이 없으면 버튼을 잠근다');
    console.log('deposit overlay restore modal runtime guard passed');
  })().catch(e => { console.error(e); process.exit(1); });
}

console.log('deposit overlay restore wiring passed');
