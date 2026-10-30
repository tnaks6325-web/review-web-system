'use strict';
// Real production UPSERT SQL against disposable, in-memory PostgreSQL; no pg/socket/API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
const { service } = require('./reviewInspectionFailureSafety.test');
(async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  try {
    await db.exec('CREATE EXTENSION pg_trgm; CREATE TABLE review_submissions (file_id TEXT); CREATE TABLE tab_configs (sheet_id TEXT, tab_name TEXT);');
    for (const name of ['081_review_inspections.sql', '092_review_inspect_learning.sql', '148_review_product_cluster_learning.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
    }
    const { api } = service();
    api.__setPoolForTest(db);
    const base = { fileId: 'FAKE_FILE', sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB', rowIndex: 1,
      reviewerName: 'FAKE_REVIEWER', slotKey: 'review', status: 'suspect', productClusterKey: 'FAKE_CLUSTER',
      checks: { format: { verdict: 'pass' }, product: { verdict: 'warn' }, duplicate: { verdict: 'pass' } } };
    assert.strictEqual((await api.__upsertForTest(base)).persisted, true);
    await db.exec("UPDATE review_inspections SET product_resolution = 'pass', product_resolved_by = 'FAKE_HUMAN', resolution = NULL, resolved_at = NULL, resolved_by = NULL;");
    const result = await api.__upsertForTest({ ...base, status: 'unverifiable', checks: {
      ...base.checks, format: { verdict: 'skip', reason: 'no_ai', evidence: 'unknown' },
    } });
    assert.strictEqual(result.persisted, true);
    assert.strictEqual(result.storedStatus, 'unverifiable', 'preserved product decision must not auto-close an unread format');
    const row = (await db.query('SELECT * FROM review_inspections')).rows[0];
    assert.strictEqual(row.resolution, null, 'unknown evidence must not create an ok resolution');
    assert.strictEqual(row.resolved_at, null, 'unknown evidence must not manufacture whole-case human confirmation time');
    assert.strictEqual(row.resolved_by, null, 'unknown evidence must not manufacture whole-case human confirmation actor');
    assert.strictEqual(row.product_resolution, 'pass', 'the real product-only human decision remains preserved');
    for (const [verdict, expected] of [['warn', 'suspect'], ['fail', 'fail']]) {
      const out = await api.__upsertForTest({ ...base, checks: { ...base.checks,
        format: { verdict, evidence: 'unknown' } } });
      assert.strictEqual(out.storedStatus, expected, 'known warning/failure priority must survive unknown metadata');
    }
    const verified = await api.__upsertForTest(base);
    assert.strictEqual(verified.storedStatus, 'resolved', 'verified non-product axes still respect a preserved product decision');
    console.log('Inspection unknown evidence: real SQL preservation checks passed');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
