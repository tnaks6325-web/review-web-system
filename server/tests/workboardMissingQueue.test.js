'use strict';

const assert = require('assert');
const service = require('../src/services/workboardQueueApply.service');
const consolidation = require('../src/services/workboardConsolidation.service');
const syncQueue = require('../src/services/syncQueue.service');
const orderLedger = require('../src/services/orderLedger.service');

const originalControl = consolidation.getControl;
const originalEnqueue = syncQueue.enqueue;
const originalMarkQueued = orderLedger.markOrderQueued;

(async () => {
  let queryCount = 0;
  const enqueued = [];
  const marked = [];
  const rows = [
    { id: '00000000-0000-0000-0000-000000000001', sheet_id: 's', tab_name: 't', gid: '1' },
    { id: '00000000-0000-0000-0000-000000000002', sheet_id: 's', tab_name: 't', gid: '1' },
  ];
  service.__setPoolForTest({
    query: async (sql, params) => {
      queryCount++;
      assert.match(sql, /NOT EXISTS \([\s\S]*?FROM sync_queue sq/);
      assert.deepStrictEqual(params, [2, 120, 48, 'enabled']);
      return { rows };
    },
  });
  consolidation.getControl = async () => ({ mode: 'enabled' });
  syncQueue.enqueue = async (type, payload) => {
    enqueued.push({ type, payload });
    if (payload.orderSubmissionId.endsWith('2')) throw new Error('simulated insert failure');
    return 1;
  };
  orderLedger.markOrderQueued = async id => { marked.push(id); };

  const out = await service.recoverMissingWorkboardQueues({ limit: 2, staleSeconds: 120, sinceHours: 48 });
  assert.deepStrictEqual(out, { scanned: 2, requeued: 1, failed: 1, dryRun: false });
  assert.strictEqual(enqueued.length, 2);
  assert.strictEqual(marked.length, 1);
  assert.strictEqual(enqueued[0].type, 'workboard_apply');
  assert.strictEqual(enqueued[0].payload.recovered, true);
  assert.strictEqual(enqueued[0].payload.missingQueueRecovery, true);

  const dry = await service.recoverMissingWorkboardQueues({ limit: 2, staleSeconds: 120, sinceHours: 48, dryRun: true });
  assert.deepStrictEqual(dry, { scanned: 2, requeued: 0, failed: 0, dryRun: true });
  assert.strictEqual(enqueued.length, 2, 'dry-run must not enqueue');

  consolidation.getControl = async () => ({ mode: 'legacy' });
  const beforeLegacy = queryCount;
  const legacy = await service.recoverMissingWorkboardQueues();
  assert.strictEqual(legacy.skipped, true);
  assert.strictEqual(queryCount, beforeLegacy, 'legacy mode must not scan or mutate orders');

  console.log('workboardMissingQueue: 13개 통과');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  consolidation.getControl = originalControl;
  syncQueue.enqueue = originalEnqueue;
  orderLedger.markOrderQueued = originalMarkQueued;
  service.__setPoolForTest(null);
  setImmediate(() => process.exit(process.exitCode || 0));
});
