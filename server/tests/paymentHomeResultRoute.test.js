/** Home result upload: execute the real registration/handler, never load the app or DB. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
const ROUTE = '/payment/batch/:id/home-result-auto-apply';
const ID = 'abcdefab-1234-5678-9012-abcdefabcdef';
const OTHER = '11111111-1234-5678-9012-abcdefabcdef';
const plain = v => JSON.parse(JSON.stringify(v));
function declaration(name, async = false) {
  const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
  assert.ok(start >= 0, `actual helper ${name} exists`);
  // Helpers end at an unindented closing brace; no copy of their implementation.
  const end = source.indexOf('\n}', start);
  if (end >= 0 && !source.slice(start, source.indexOf('\n', start)).includes('}')) return source.slice(start, end + 2);
  return source.slice(start, source.indexOf('\n', start));
}
function harness(options = {}) {
  const calls = [], forwarded = [], warnings = [], finds = [], applies = [];
  const found = options.found || { batchId: ID, pending: 2, fileRows: 2 };
  const out = options.out || { ok: true, autoApplied: true, applied: { success: 2 }, unmatched: [{ seq: 3 }] };
  const auth = () => {}, admin = () => {};
  let registration;
  class ResultError extends Error { constructor(code) { super(code); this.code = code; } }
  const context = {
    router: { post: (...args) => { registration = args; } },
    authMiddleware: auth, adminOrMasterMiddleware: admin,
    paymentResultSvc: { ResultError,
      findBatchForResultFile: async args => { calls.push('find'); finds.push(plain(args)); if (options.findError) throw options.findError; return options.findImpl ? options.findImpl(args) : found; },
      autoApplyResultFile: async args => { calls.push('apply'); applies.push(plain(args)); if (options.applyError) throw options.applyError; return options.applyImpl ? options.applyImpl(args) : out; },
    },
    opsCheckSvc: { refreshBankChecks: async args => { calls.push('refresh'); assert.equal(args.by, 'test-admin'); if (options.refreshError) throw options.refreshError; } },
    logger: { warn: text => warnings.push(text) },
    paymentResultArchiveSvc: { kickSoon: () => { calls.push('archive'); if (options.archiveError) throw options.archiveError; } },
  };
  vm.createContext(context);
  const uuid = source.match(/^const _UUID_RE = .*;$/m);
  assert.ok(uuid, 'use actual existing UUID rule');
  vm.runInContext(uuid[0] + '\n' + declaration('_by') + '\n' + declaration('_resultErr') + '\n' + declaration('_archiveSoon') + '\n' + declaration('_refreshOpsChecks', true), context);
  const start = source.indexOf(`router.post('${ROUTE}'`);
  assert.ok(start >= 0, 'home batch-bound route registration is missing');
  const end = source.indexOf('\n});', start);
  assert.ok(end > start, 'complete actual registration block');
  vm.runInContext(source.slice(start, end + 4), context);
  assert.equal(registration[0], ROUTE);
  assert.equal(registration[1], auth);
  assert.equal(registration[2], admin);
  assert.equal(registration.length, 4);
  return { calls, finds, applies, forwarded, warnings, found, out, refresh: by => context._refreshOpsChecks(by),
    async run(req = {}) {
      const response = { statusCode: 200, bodies: [], status(n) { this.statusCode = n; return this; }, json(body) { calls.push('json'); this.bodies.push(plain(body)); return this; } };
      await registration[3]({ params: { id: ID }, body: { fileName: 'bank.xls', base64: 'synthetic-file' }, admin: { name: 'test-admin', role: 'admin' }, ...req }, response, err => { calls.push('next'); forwarded.push(err); });
      return response;
    },
  };
}

test('exact home path registers auth/admin and binds the actual finder result before the sole apply engine', async () => {
  const h = harness(); const r = await h.run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(h.finds, [{ fileName: 'bank.xls', base64: 'synthetic-file' }]);
  assert.deepEqual(h.applies, [{ batchId: ID, fileName: 'bank.xls', base64: 'synthetic-file', by: 'test-admin', notifyFailed: true }]);
  assert.deepEqual(r.bodies[0], { ...h.out, found: h.found, alreadyDone: false, opsRefresh: true });
  assert.deepEqual(h.calls, ['find', 'apply', 'refresh', 'json', 'archive']);
});

test('invalid UUID is refused before find/apply/refresh/archive', async () => {
  for (const id of ['', 'bad', ID + ' ', '../' + ID]) {
    const h = harness(); const r = await h.run({ params: { id } });
    assert.equal(r.statusCode, 400); assert.equal(r.bodies[0].ok, false);
    assert.deepEqual(h.calls, ['json']);
  }
});

test('even a two-row file found for another batch is 409 wrong_batch with no side effects', async () => {
  const h = harness({ found: { batchId: OTHER, pending: 2, fileRows: 2 } }); const r = await h.run();
  assert.equal(r.statusCode, 409); assert.equal(r.bodies[0].code, 'wrong_batch');
  assert.deepEqual(h.calls, ['find', 'json']);
});

test('uppercase UUID normalization accepts the same batch without changing the found ID passed to apply', async () => {
  const h = harness({ found: { batchId: ID.toUpperCase(), pending: 1 } });
  await h.run({ params: { id: ID } }); assert.equal(h.applies[0].batchId, ID.toUpperCase());
  const h2 = harness(); await h2.run({ params: { id: ID.toUpperCase() } }); assert.equal(h2.applies.length, 1);
});

test('finder ambiguity/failure is forwarded without apply, ops, or archive', async () => {
  for (const code of ['ambiguous', 'no_batch', 'lookup_failure']) {
    const err = Object.assign(new Error(code), { code }); const h = harness({ findError: err });
    const r = await h.run(); assert.equal(r.bodies.length, 0); assert.deepEqual(h.forwarded, [err]);
    assert.deepEqual(h.calls, ['find', 'next']);
  }
});

test('legacy file fallback and explicit notify false are passed exactly once', async () => {
  const h = harness(); await h.run({ body: { fileName: 'fallback.xls', file: 'fallback-content', notifyFailed: false } });
  assert.deepEqual(h.finds, [{ fileName: 'fallback.xls', base64: 'fallback-content' }]);
  assert.deepEqual(h.applies, [{ batchId: ID, fileName: 'fallback.xls', base64: 'fallback-content', by: 'test-admin', notifyFailed: false }]);
});

test('apply error uses existing error forwarding once and never refreshes or archives', async () => {
  const err = new Error('apply failed'); const h = harness({ applyError: err }); const r = await h.run();
  assert.deepEqual(h.forwarded, [err]); assert.equal(r.bodies.length, 0); assert.deepEqual(h.calls, ['find', 'apply', 'next']);
});

test('archive kick exception after response cannot become a financial error or double response', async () => {
  const h = harness({ archiveError: new Error('archive failed') }); const r = await h.run();
  assert.equal(r.bodies.length, 1); assert.equal(r.bodies[0].ok, true); assert.deepEqual(h.forwarded, []);
  assert.equal(h.calls.at(-1), 'archive');
});


test('positive-pending hold preserves output and unmatched without refresh or invented numbers', async () => {
  const out = { ok: true, autoApplied: false, reason: 'hold', unmatched: [{ seq: 2 }] };
  const h = harness({ out }); const r = await h.run();
  assert.deepEqual(r.bodies[0], { ...out, found: h.found, alreadyDone: false, opsRefresh: null });
  assert.deepEqual(h.calls, ['find', 'apply', 'json', 'archive']);
  for (const key of ['success', 'failed', 'notified', 'applied']) assert.equal(Object.hasOwn(r.bodies[0], key), false);
});

test('non-ok output never refreshes even with autoApplied true and pending zero', async () => {
  for (const ok of [false, undefined]) {
    const out = { autoApplied: true, ...(ok === undefined ? {} : { ok }) };
    const h = harness({ found: { batchId: ID, pending: 0 }, out }); const r = await h.run();
    assert.equal(r.bodies[0].opsRefresh, null); assert.equal(h.calls.includes('refresh'), false);
  }
});

test('actual refresh helper returns true on completion and false on caught exception', async () => {
  const good = harness(); assert.equal(await good.refresh('test-admin'), true);
  const bad = harness({ refreshError: new Error('ops unavailable') });
  assert.equal(await bad.refresh('test-admin'), false); assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /ops unavailable/);
});

test('refresh exception preserves financial output with warning and response before archive', async () => {
  const h = harness({ refreshError: new Error('ops unavailable') }); const r = await h.run();
  const body = r.bodies[0]; assert.equal(body.opsRefresh, false); assert.ok(body.opsWarning);
  assert.deepEqual(body.applied, h.out.applied); assert.deepEqual(body.unmatched, h.out.unmatched);
  assert.equal(body.ok, true); assert.equal(body.autoApplied, true); assert.deepEqual(h.forwarded, []);
  assert.deepEqual(h.calls, ['find', 'apply', 'refresh', 'json', 'archive']);
});

test('already-done same-file retry repairs stale ops after failed refresh without a second payment path', async () => {
  // Simulates the existing engine contract, NOT proof of real SQL pending-only writes.
  let pending = 2, simulatedPaymentChanges = 0;
  const findImpl = () => ({ batchId: ID, pending });
  const applyImpl = () => {
    if (!pending) return { ok: true, autoApplied: false, reason: 'no_pending_items', unmatched: [{ seq: 3 }] };
    pending = 0; simulatedPaymentChanges++;
    return { ok: true, autoApplied: true, applied: { success: 2 } };
  };
  const first = harness({ findImpl, applyImpl, refreshError: new Error('ops unavailable') });
  assert.equal((await first.run()).bodies[0].opsRefresh, false);
  const retry = harness({ findImpl, applyImpl }); const r = await retry.run();
  assert.deepEqual(r.bodies[0], { ok: true, autoApplied: false, reason: 'no_pending_items', unmatched: [{ seq: 3 }], found: { batchId: ID, pending: 0 }, alreadyDone: true, opsRefresh: true });
  assert.equal(simulatedPaymentChanges, 1); assert.equal(retry.applies.length, 1);
  assert.deepEqual(retry.calls, ['find', 'apply', 'refresh', 'json', 'archive']);
});

test('unknown pending is not invented as zero to refresh a held result', async () => {
  const h = harness({ found: { batchId: ID }, out: { ok: true, autoApplied: false } });
  const r = await h.run(); assert.equal(r.bodies[0].opsRefresh, null); assert.equal(h.calls.includes('refresh'), false);
});

test('response and archive are outside the financial catch', () => {
  const start = source.indexOf(`router.post('${ROUTE}'`);
  const block = source.slice(start, source.indexOf('\n});', start));
  assert.match(block, /catch \(err\) \{ return _resultErr\(err, res, next\); \}\s*res\.json\(payload\);\s*_archiveSoon\(\);/);
});
