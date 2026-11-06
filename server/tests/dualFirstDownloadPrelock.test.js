'use strict';
// First payment-file download must take the dual lifecycle lock before the batch row lock,
// then hand that same server-discovered scope to the shared payout recheck.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('first download: discover (outside tx) -> BEGIN -> lifecycle lock -> provenance -> batch lock -> recheck with scope', async () => {
  const router = require('../src/routes/trackB.routes');
  const pool = require('../src/db/pool');
  const payment = require('../src/services/payment.service');
  const lifecycle = require('../src/services/dualChannelLifecycle.service');
  const layer = router.stack.find(e => e.route && e.route.path === '/payment/batch/:id/file');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const order = [];
  const scope = Object.freeze({ token: 'scope' });
  const client = { query: async sql => { order.push(String(sql)); return { rows: [], rowCount: 0 }; }, release() { order.push('release'); } };
  const keep = { connect: pool.connect, getBatch: payment.getBatch, check: payment.checkBatchReceiptEligibility,
    account: payment.checkBatchAccountSnapshots, wb: payment.buildWorkbook, mark: payment.markDownloaded,
    discover: lifecycle.discoverDualScope, lock: lifecycle.lockDualScopeInTx, assertP: lifecycle.assertDualProvenanceUnchanged };
  let seenScope = null; let discoveredOn = null;
  try {
    pool.connect = async () => { order.push('connect'); return client; };
    lifecycle.discoverDualScope = async (db, targets) => { discoveredOn = db; order.push('discover:' + JSON.stringify(targets)); return scope; };
    lifecycle.lockDualScopeInTx = async (c, s) => { assert.equal(c, client); assert.equal(s, scope); order.push('lifecycle-lock'); };
    lifecycle.assertDualProvenanceUnchanged = async (c, s) => { assert.equal(c, client); assert.equal(s, scope); order.push('provenance'); };
    payment.getBatch = async (id, o) => { assert.equal(o.db, client); order.push('batch-lock'); return { batch: { id, seq: 3, bank: 'kbank', status: 'ready', downloadCount: 0 }, items: [] }; };
    payment.checkBatchReceiptEligibility = async (out, o) => { seenScope = o.lockedScope; assert.equal(o.db, client); assert.equal(o.lock, true); order.push('recheck'); return { ok: true, blocked: [] }; };
    payment.checkBatchAccountSnapshots = async () => ({ ok: true, mismatches: [] });
    payment.buildWorkbook = async () => Buffer.from('x');
    payment.markDownloaded = async () => { order.push('mark'); };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, send() { order.push('send'); } };
    await handler({ params: { id: '7' }, admin: { name: 't', role: 'admin' } }, res, e => { throw e; });
    assert.equal(discoveredOn, pool, 'discovery reads through the pool before the transaction');
    assert.equal(seenScope, scope, 'recheck receives the exact locked scope');
    assert.deepEqual(order, ['discover:[{"batchId":"7"}]', 'connect', 'BEGIN ISOLATION LEVEL SERIALIZABLE', 'lifecycle-lock', 'provenance', 'batch-lock', 'recheck', 'mark', 'COMMIT', 'send', 'release']);
  } finally {
    pool.connect = keep.connect; payment.getBatch = keep.getBatch; payment.checkBatchReceiptEligibility = keep.check;
    payment.checkBatchAccountSnapshots = keep.account; payment.buildWorkbook = keep.wb; payment.markDownloaded = keep.mark;
    lifecycle.discoverDualScope = keep.discover; lifecycle.lockDualScopeInTx = keep.lock; lifecycle.assertDualProvenanceUnchanged = keep.assertP;
  }
});

test('changed dual provenance after discovery rolls back before the batch row is locked', async () => {
  const router = require('../src/routes/trackB.routes');
  const pool = require('../src/db/pool');
  const payment = require('../src/services/payment.service');
  const lifecycle = require('../src/services/dualChannelLifecycle.service');
  const layer = router.stack.find(e => e.route && e.route.path === '/payment/batch/:id/file');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const order = [];
  const client = { query: async sql => { order.push(String(sql)); return { rows: [] }; }, release() {} };
  const keep = { connect: pool.connect, getBatch: payment.getBatch, discover: lifecycle.discoverDualScope, lock: lifecycle.lockDualScopeInTx, assertP: lifecycle.assertDualProvenanceUnchanged };
  try {
    pool.connect = async () => client;
    lifecycle.discoverDualScope = async () => ({});
    lifecycle.lockDualScopeInTx = async () => {};
    lifecycle.assertDualProvenanceUnchanged = async () => { const e = new Error('dual_lifecycle_changed'); e.status = 409; e.code = 'dual_lifecycle_changed'; throw e; };
    payment.getBatch = async () => { order.push('batch-lock'); return null; };
    let passed = null;
    await handler({ params: { id: '8' }, admin: { name: 't', role: 'admin' } }, {}, e => { passed = e; });
    assert.equal(passed && passed.code, 'dual_lifecycle_changed');
    assert.ok(!order.includes('batch-lock'));
    assert.ok(order.includes('ROLLBACK'));
  } finally {
    pool.connect = keep.connect; payment.getBatch = keep.getBatch;
    lifecycle.discoverDualScope = keep.discover; lifecycle.lockDualScopeInTx = keep.lock; lifecycle.assertDualProvenanceUnchanged = keep.assertP;
  }
});
