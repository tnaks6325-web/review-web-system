'use strict';
const assert = require('node:assert/strict');

const router = require('../src/routes/trackB.routes');
const pool = require('../src/db/pool');
const payment = require('../src/services/payment.service');
const layer = router.stack.find(entry => entry.route && entry.route.path === '/payment/batch/:id/file');
assert.ok(layer, 'download endpoint exists');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const calls = [];
const client = { query: async sql => { calls.push(String(sql)); return { rows: [], rowCount: 0 }; }, release() {} };
const originals = {
  connect: pool.connect,
  query: pool.query,
  getBatch: payment.getBatch,
  checkBatchReceiptEligibility: payment.checkBatchReceiptEligibility,
  buildWorkbook: payment.buildWorkbook,
  markDownloaded: payment.markDownloaded,
};

pool.connect = async () => client;
payment.getBatch = async () => ({
  batch: { id: 'synthetic-history', seq: 1, bank: 'hana', status: 'ready', historyOnly: true, historicalKey: 'historical-fee:malformed' },
  items: [],
});
payment.checkBatchReceiptEligibility = async () => { calls.push('receipt-check'); return { ok: true }; };
payment.buildWorkbook = async () => { calls.push('workbook'); return Buffer.from('synthetic'); };
payment.markDownloaded = async () => { calls.push('mark-downloaded'); };

const response = {
  code: 200, body: null,
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader() {}, send() { throw new Error('history-only batch produced a workbook'); },
};

(async () => {
  try {
    await handler({ params: { id: 'synthetic-history' }, admin: { name: 'test', role: 'admin' } }, response, e => { throw e; });
    assert.equal(response.code, 409);
    assert.equal(response.body.code, 'history_only');
    assert.deepEqual(calls, ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);

    pool.query = async () => ({ rows: [{ id: 'synthetic-history', historical_key: 'historical-fee:' }] });
    const listed = await payment.listBatches();
    assert.equal(listed[0].historyOnly, true);
    assert.equal(listed[0].historicalKey, 'historical-fee:');

    const cancelCalls = [];
    pool.connect = async () => ({
      query: async sql => {
        cancelCalls.push(String(sql));
        if (/SELECT \* FROM payment_batches/.test(String(sql))) {
          return { rows: [{ id: 'synthetic-history', status: 'cancelled', historical_key: 'historical-fee:' }] };
        }
        return { rows: [], rowCount: 0 };
      }, release() {},
    });
    const canceled = await payment.cancelBatch('synthetic-history', 'test');
    assert.equal(canceled.code, 'history_only', 'even a corrupted terminal status cannot unlock a historical batch');
    assert.equal(cancelCalls.some(sql => /UPDATE payment_batches|UPDATE payment_batch_items/.test(sql)), false);

    const markCalls = [];
    payment.markDownloaded = originals.markDownloaded;
    await assert.rejects(payment.markDownloaded('synthetic-history', 'test', { db: {
      query: async sql => {
        markCalls.push(String(sql));
        if (/SELECT historical_key/.test(String(sql))) return { rows: [{ historical_key: 'historical-fee:malformed' }] };
        return { rows: [], rowCount: 1 };
      },
    } }), e => e.code === 'history_only');
    assert.equal(markCalls.some(sql => /UPDATE payment_batches/.test(sql)), false, 'direct download marking is independently blocked');
    console.log('paymentHistoryDownloadRoute: PASS');
  } finally {
    pool.connect = originals.connect;
    pool.query = originals.query;
    payment.getBatch = originals.getBatch;
    payment.checkBatchReceiptEligibility = originals.checkBatchReceiptEligibility;
    payment.buildWorkbook = originals.buildWorkbook;
    payment.markDownloaded = originals.markDownloaded;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
