'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const filename = path.resolve(__dirname, '../src/services/dualChannelLifecycle.service.js');
test('dual campaign locks are sorted before business writes, normal is noop, changed provenance rolls back', async () => {
  assert.ok(fs.existsSync(filename), 'lifecycle service must exist');
  const svc = require(filename);
  const pg = new PGlite();
  const calls = [];
  const query = async (s,p) => { calls.push([s,p]); return pg.query(s,p); };
  const db = { query, connect: async () => ({ query, release() {} }) };
  try {
    await pg.exec(`CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY, channel TEXT, channel_custom TEXT, work_detail JSONB, source_work_order_id TEXT, linked_sheet_id TEXT, linked_tab_name TEXT, linked_tab_gid TEXT);
      INSERT INTO recruit_campaigns VALUES ('z','네이버+쿠팡','','{}','wo','','',''),('a','네이버+쿠팡','','{}','wo','','',''),('normal','네이버','','{}','','','','');`);
    const normal = await svc.discoverDualScope(db, [{ campaignId: 'normal' }]);
    calls.length = 0; await svc.lockDualScopeInTx(db, normal);
    assert.equal(calls.length, 0);
    await svc.withDualLifecycleInTx({ db, targets: [{ campaignId: 'z' }, { campaignId: 'a' }], run: async client => { await client.query(`UPDATE recruit_campaigns SET channel_custom='written' WHERE id='z'`); } });
    assert.deepEqual(calls.filter(([s]) => /pg_advisory_xact_lock/.test(s)).map(([,p]) => p[0]), ['a','z']);
    assert.equal((await pg.query(`SELECT channel_custom FROM recruit_campaigns WHERE id='z'`)).rows[0].channel_custom, 'written');
    const scope = await svc.discoverDualScope(db, [{ campaignId: 'z' }]);
    await pg.query(`UPDATE recruit_campaigns SET source_work_order_id='foreign' WHERE id='z'`);
    await assert.rejects(svc.assertDualProvenanceUnchanged(db, scope), { code: 'dual_scope_changed_retry' });
    await pg.exec(`CREATE TABLE campaign_applications(id INTEGER PRIMARY KEY, campaign_id TEXT, order_submission_id TEXT);
      CREATE TABLE order_submissions(id TEXT PRIMARY KEY, campaign_application_id INTEGER, purchase_bundle_application_id INTEGER, sheet_id TEXT, tab_name TEXT, gid TEXT);
      CREATE TABLE payment_batch_items(id TEXT PRIMARY KEY, batch_id TEXT, order_submission_id TEXT, sheet_id TEXT, tab_name TEXT);
      CREATE TABLE payment_batches(id TEXT PRIMARY KEY);
      INSERT INTO payment_batches VALUES ('batch');
      INSERT INTO campaign_applications VALUES (1,'z','order');
      INSERT INTO order_submissions VALUES ('order',NULL,1,'sheet','tab','gid');
      INSERT INTO payment_batch_items VALUES ('item','batch','order','sheet','tab');
      UPDATE recruit_campaigns SET linked_sheet_id='sheet',linked_tab_name='tab',linked_tab_gid='gid' WHERE id='z';`);
    for (const target of [{ applicationId: 1 }, { orderSubmissionId: 'order' }, { sheetId: 'sheet', tabName: 'tab', tabGid: 'gid' }, { batchId: 'batch' }]) {
      const scope = await svc.discoverDualScope(db, [target]);
      assert.deepEqual(scope.campaignIds, ['z'], JSON.stringify(target));
      await svc.assertDualProvenanceUnchanged(db, scope);
    }
    const fromOrder = await svc.discoverDualScope(db, [{ orderSubmissionId: 'order' }]);
    await pg.query(`UPDATE order_submissions SET purchase_bundle_application_id=NULL WHERE id='order'`);
    await assert.rejects(svc.assertDualProvenanceUnchanged(db, fromOrder), { code: 'dual_scope_changed_retry' });
    await assert.rejects(svc.discoverDualScope(db, [{ orderSubmissionId: 'missing' }]));
  } finally { await pg.close(); }
});
