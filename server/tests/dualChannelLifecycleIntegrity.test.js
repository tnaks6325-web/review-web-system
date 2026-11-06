'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const svc = require('../src/services/dualChannelLifecycle.service');
test('real SQL distinguishes missing batch from existing empty batch and rejects bundle without a dual source', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE payment_batches(id TEXT PRIMARY KEY);
      CREATE TABLE payment_batch_items(id TEXT PRIMARY KEY,batch_id TEXT,order_submission_id TEXT,sheet_id TEXT,tab_name TEXT);
      CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY,channel TEXT,work_detail JSONB,linked_sheet_id TEXT,linked_tab_name TEXT,linked_tab_gid TEXT);
      CREATE TABLE campaign_applications(id INTEGER PRIMARY KEY,campaign_id TEXT,order_submission_id TEXT);
      CREATE TABLE order_submissions(id TEXT PRIMARY KEY,purchase_bundle_version INTEGER,purchase_bundle_hash TEXT,purchase_bundle_application_id INTEGER,campaign_application_id INTEGER,sheet_id TEXT,tab_name TEXT,gid TEXT);
      INSERT INTO payment_batches VALUES ('empty');
      INSERT INTO order_submissions(id,purchase_bundle_version) VALUES ('broken',1);`);
    await assert.rejects(svc.discoverDualScope(pg,[{batchId:'missing'}]), {code:'dual_scope_changed_retry'});
    const empty = await svc.discoverDualScope(pg,[{batchId:'empty'}]);
    assert.deepEqual(empty.campaignIds,[]);
    await assert.rejects(svc.discoverDualScope(pg,[{orderSubmissionId:'broken'}]), {code:'dual_scope_changed_retry'});
    await pg.exec(`INSERT INTO recruit_campaigns VALUES ('ordinary','네이버','{}','sheet','tab','gid'); UPDATE order_submissions SET sheet_id='sheet',tab_name='tab',gid='gid' WHERE id='broken';`);
    await assert.rejects(svc.discoverDualScope(pg,[{orderSubmissionId:'broken'}]), {code:'dual_scope_changed_retry'});
  } finally { await pg.close(); }
});
