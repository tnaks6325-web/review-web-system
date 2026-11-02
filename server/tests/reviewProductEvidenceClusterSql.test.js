'use strict';
// Execute production SQL with disposable PostgreSQL, not a query-pattern fake.
// Trusted fixtures exercise the existing admin-candidate path: warn is deliberate,
// comparison/provenance/signatures come from the real matcher. No image/AI claim.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { pg_trgm } = require('@electric-sql/pglite/contrib/pg_trgm');
const { service } = require('./reviewInspectionFailureSafety.test');

test('product cluster production SQL on migrations 081/092/148', async t => {
  const db = new PGlite({ extensions: { pg_trgm } });
  const { api } = service();
  const transactions = [];
  const query = async (sql, params) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) transactions.push(sql);
    return db.query(sql, params);
  };
  api.__setPoolForTest({ query, connect: async () => ({ query, release() {} }) });
  const sheetId = 'FAKE_SQL_SHEET';
  const primary = ['가상브랜드 보습 로션 500ml 2개'];
  const rules = [{ id: 'FAKE_HUMAN_RULE', active: true, verdict: 'fail',
    clusterKey: 'FAKE_PRIOR_KEY', createdBy: 'FAKE_HUMAN', note: 'keep exact JSON',
    nested: { historical: ['unchanged', 2] } }];
  const checks = (ocr = primary[0], expected = primary) => ({
    format: { verdict: 'pass' }, duplicate: { verdict: 'pass' },
    product: { ...api.matchProductName(ocr, expected, { canonicalSource: 'manual' }), verdict: 'warn' },
  });
  async function setup(tabName) {
    await db.query(`INSERT INTO tab_configs(sheet_id,tab_name,inspect_product_rules)
      VALUES ($1,$2,$3::jsonb)`, [sheetId, tabName, JSON.stringify(rules)]);
  }
  async function insert(tabName, id, c = checks(), ocr = c.product.ocr, history = false) {
    await db.query(`INSERT INTO review_inspections
      (file_id,sheet_id,tab_name,slot_key,status,checks,ocr_product,resolution,resolved_at,resolved_by)
      VALUES ($1,$2,$3,$4,'suspect',$5::jsonb,$6,$7,$8,$9)`,
    [id, sheetId, tabName, c.receiptValidation ? 'receipt' : 'review', JSON.stringify(c), ocr,
      history ? 'bad' : null, history ? '2000-01-01T00:00:00Z' : null, history ? 'FAKE_OLD_HUMAN' : null]);
  }
  async function rows(tabName) {
    return (await db.query('SELECT * FROM review_inspections WHERE sheet_id=$1 AND tab_name=$2 ORDER BY file_id',
      [sheetId, tabName])).rows;
  }
  async function storedRules(tabName) {
    return (await db.query('SELECT inspect_product_rules FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2',
      [sheetId, tabName])).rows[0].inspect_product_rules;
  }
  async function preview(tabName) {
    return api.autoResolveProductClusters({ sheetId, tabName, dryRun: true });
  }
  async function apply(tabName, p) {
    return api.autoResolveProductClusters({ sheetId, tabName, dryRun: false, confirm: 'AUTO_PASS_V1',
      snapshotToken: p.snapshotToken, clusterKeys: p.clusterKeys, by: 'FAKE_ADMIN' });
  }
  try {
    // Only dependency tables are minimal fixtures; inspection schema is real migrations.
    await db.exec(`CREATE EXTENSION pg_trgm;
      CREATE TABLE review_submissions(file_id TEXT,file_url TEXT,file_name TEXT);
      CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());`);
    for (const name of ['081_review_inspections.sql', '092_review_inspect_learning.sql',
      '148_review_product_cluster_learning.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8'));
    }

    await t.test('two trusted rows resolve through preview and actual transactional SQL without changing human rules', async () => {
      const tab = 'FAKE_TRUSTED';
      await setup(tab);
      const first = checks();
      assert.equal(first.product.comparison.kind, 'match');
      assert.equal(first.product.canonicalSource, 'manual');
      assert.ok(first.product.comparison.signature);
      assert.ok(first.product.comparison.semanticSignature);
      await insert(tab, 'FAKE_GOOD_A', first);
      await insert(tab, 'FAKE_GOOD_B', checks('가상브랜드  보습 로션 500ml  2개'));
      const before = await rows(tab);
      const beforeRules = await storedRules(tab);
      const listed = await api.listProductClusters({ sheetId, tabName: tab, includeAll: true });
      assert.equal(listed.totalRows, 2);
      assert.equal(listed.totalClusters, 1);
      assert.equal(listed.autoPassRows, 2);
      const p = await preview(tab);
      assert.equal(p.eligibleRows, 2);
      assert.deepEqual(await rows(tab), before, 'preview is read-only');
      const txStart = transactions.length;
      const result = await apply(tab, p);
      assert.equal(result.ok, true);
      assert.equal(result.affected, 2);
      assert.equal(result.processedClusters, 1);
      assert.equal(result.remainsOpen, 0);
      assert.deepEqual(transactions.slice(txStart), ['BEGIN', 'COMMIT']);
      for (const row of await rows(tab)) {
        assert.equal(row.status, 'resolved');
        assert.equal(row.resolution, 'ok');
        assert.equal(row.product_resolution, 'pass');
        assert.match(row.product_resolved_by, /^AUTO:/, 'actor identifies automatic processing, not a person');
        assert.equal(row.resolved_by, row.product_resolved_by);
        assert.ok(row.product_resolved_at);
        assert.ok(row.resolved_at);
        assert.equal(row.checks.product.machineVerdict, 'warn');
      }
      assert.deepEqual(await storedRules(tab), beforeRules, 'automatic decisions cannot rewrite human rules JSON');
      assert.equal((await api.listProductClusters({ sheetId, tabName: tab })).totalRows, 0);
    });

    await t.test('receipt warning and other unknown remain open after product-only automatic decision', async () => {
      const tab = 'FAKE_OTHER_AXES';
      await setup(tab);
      const unknown = checks();
      unknown.format = { verdict: 'skip', reason: 'no_ai', evidence: 'unknown' };
      const receipt = checks();
      receipt.receiptValidation = { verdict: 'warn', status: 'retry_pending', evidence: 'unknown' };
      await insert(tab, 'FAKE_UNKNOWN', unknown, primary[0], true);
      await insert(tab, 'FAKE_RECEIPT', receipt);
      const before = await rows(tab);
      const p = await preview(tab);
      assert.equal(p.eligibleRows, 2);
      const result = await apply(tab, p);
      assert.equal(result.affected, 2);
      assert.equal(result.remainsOpen, 2);
      for (const row of await rows(tab)) {
        const prior = before.find(r => r.file_id === row.file_id);
        assert.equal(row.product_resolution, 'pass');
        assert.equal(row.status, row.file_id === 'FAKE_RECEIPT' ? 'suspect' : 'unverifiable');
        assert.equal(row.resolution, prior.resolution);
        assert.equal(String(row.resolved_at), String(prior.resolved_at));
        assert.equal(row.resolved_by, prior.resolved_by);
        if (row.file_id === 'FAKE_RECEIPT') assert.deepEqual(row.checks.receiptValidation, prior.checks.receiptValidation);
        else assert.deepEqual(row.checks.format, prior.checks.format);
      }
      assert.deepEqual(await storedRules(tab), rules);
    });

    await t.test('decimal historical-key collision blocks the whole group including direct automatic resolve', async () => {
      const tab = 'FAKE_COLLISION';
      await setup(tab);
      const expected = ['5L 가상브랜드 프리미엄 저자극 보습 로션'];
      const good = checks(expected[0], expected);
      const bad = checks('0.5L 가상브랜드 프리미엄 저자극 보습 로션', expected);
      assert.equal(good.product.comparison.kind, 'match');
      assert.equal(bad.product.comparison.kind, 'conflict');
      const key = c => api.productClusterKey({ sheetId, tabName: tab, expectedList: c.product.expected, ocr: c.product.ocr });
      assert.equal(key(good), key(bad), 'fixture must exercise a genuine historical key collision');
      await insert(tab, 'FAKE_COLLISION_GOOD', good);
      const approved = await preview(tab);
      assert.equal(approved.eligibleRows, 1);
      const goodGroup = (await api.listProductClusters({ sheetId, tabName: tab })).clusters[0];
      await insert(tab, 'FAKE_COLLISION_BAD', bad);
      const before = await rows(tab);
      const listed = await api.listProductClusters({ sheetId, tabName: tab });
      assert.equal(listed.totalRows, 2);
      assert.equal(listed.totalClusters, 1);
      assert.equal(listed.autoPassRows, 0);
      assert.equal((await apply(tab, approved)).ok, false, 'old preview cannot certify a newly mixed group');
      const denied = await api.resolveProductCluster({ fileId: 'FAKE_COLLISION_GOOD', verdict: 'pass',
        by: 'FAKE_ADMIN', automatic: true, evidenceToken: goodGroup.evidenceToken });
      assert.equal(denied.ok, false, 'locked revalidation rejects every member rather than processing the trusted subset');
      assert.deepEqual(await rows(tab), before);
      assert.deepEqual(await storedRules(tab), rules);
    });

    await t.test('real SQL failure rolls back preceding cluster writes and preserves human rules', async () => {
      const tab = 'FAKE_ROLLBACK';
      await setup(tab);
      await insert(tab, 'FAKE_ROLLBACK_A');
      await insert(tab, 'FAKE_ROLLBACK_B');
      const before = await rows(tab);
      // Fail rule persistence AFTER production inspection UPDATEs have run.
      await db.exec(`CREATE FUNCTION fake_rule_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'FAKE_RULE_WRITE_FAILURE'; END $$;
        CREATE TRIGGER fake_rule_write_failure BEFORE UPDATE ON tab_configs
        FOR EACH ROW EXECUTE FUNCTION fake_rule_write_failure();`);
      const txStart = transactions.length;
      try {
        await assert.rejects(api.resolveProductCluster({ fileId: 'FAKE_ROLLBACK_A',
          verdict: 'pass', by: 'FAKE_HUMAN' }), /FAKE_RULE_WRITE_FAILURE/);
      } finally {
        await db.exec('DROP TRIGGER fake_rule_write_failure ON tab_configs; DROP FUNCTION fake_rule_write_failure();');
      }
      assert.deepEqual(transactions.slice(txStart), ['BEGIN', 'ROLLBACK']);
      assert.deepEqual(await rows(tab), before, 'neither row may survive a failed transaction');
      assert.deepEqual(await storedRules(tab), rules);
    });

    await t.test('a new suspect with historical human metadata can still be explicitly resolved individually', async () => {
      const tab = 'FAKE_HUMAN_HISTORY';
      await setup(tab);
      const c = checks();
      c.duplicate = { verdict: 'warn', reason: 'FAKE_NEW_SUSPICION' };
      await insert(tab, 'FAKE_REOPENED', c, primary[0], true);
      const before = (await rows(tab))[0];
      const result = await api.resolveInspection({ fileId: before.file_id, resolution: 'ok', by: 'FAKE_NEW_HUMAN' });
      assert.equal(result.ok, true);
      assert.equal(result.resolved, 1);
      const after = (await rows(tab))[0];
      assert.equal(after.status, 'resolved');
      assert.equal(after.resolution, 'ok');
      assert.equal(after.resolved_by, 'FAKE_NEW_HUMAN');
      assert.notEqual(String(after.resolved_at), String(before.resolved_at));
      assert.deepEqual(after.checks, before.checks, 'explicit whole-case resolution preserves machine evidence');
      assert.equal(after.product_resolution, null, 'whole-case confirmation is not a product-only verdict');
      assert.deepEqual(await storedRules(tab), rules);
    });
    await t.test('preserved non-null product history does not hide a new suspect or block individual confirmation', async () => {
      const tab = 'FAKE_PRODUCT_HISTORY';
      await setup(tab);
      await insert(tab, 'FAKE_PRODUCT_HISTORY_FILE', checks(), primary[0], true);
      await db.query(`UPDATE review_inspections SET product_resolution='pass',
        product_resolution_note='FAKE_OLD_NOTE', product_resolved_by='FAKE_OLD_PRODUCT_HUMAN'
        WHERE file_id=$1`, ['FAKE_PRODUCT_HISTORY_FILE']);
      const listed = await api.listInspections({ sheetId, tabName: tab, status: 'open' });
      assert.equal(listed.length, 1, 'open status is visible even with historical product confirmation');
      assert.equal(listed[0].product_resolution, 'pass');
      const result = await api.resolveInspection({ fileId: listed[0].file_id, resolution: 'ok', by: 'FAKE_NEW_HUMAN' });
      assert.equal(result.ok, true);
      assert.equal(result.resolved, 1);
      const after = (await rows(tab))[0];
      assert.equal(after.status, 'resolved');
      assert.equal(after.product_resolution, 'pass');
      assert.equal(after.product_resolution_note, 'FAKE_OLD_NOTE');
      assert.equal(after.product_resolved_by, 'FAKE_OLD_PRODUCT_HUMAN');
    });
    await t.test('fresh conflicting evidence stays open with historical decisions until explicit whole-case confirmation', async () => {
      for (const [prior, requested] of [['pass', 'bad'], ['fail', 'ok']]) {
        const tab = `FAKE_REOPEN_${prior}`;
        const fileId = `FAKE_REOPEN_FILE_${prior}`;
        await setup(tab);
        const current = JSON.parse(JSON.stringify(checks('가상브랜드 보습 로션 400ml 2개')));
        current.format = { verdict: 'skip', reason: 'no_ai', evidence: 'unknown' };
        assert.equal(current.product.comparison.kind, 'conflict');
        const key = api.productClusterKey({ sheetId, tabName: tab,
          expectedList: current.product.expected, ocr: current.product.ocr });
        const base = { fileId, sheetId, tabName: tab, slotKey: 'review', status: 'suspect',
          checks: current, ocrProduct: current.product.ocr, productClusterKey: key };
        assert.equal((await api.__upsertForTest(base)).persisted, true);
        await db.query(`UPDATE review_inspections SET product_resolution=$2,
          product_resolution_note='FAKE_REOPEN_HISTORY', product_resolved_by='FAKE_PRIOR_HUMAN',
          status='resolved', resolution='ok' WHERE file_id=$1`, [fileId, prior]);
        const stored = await api.__upsertForTest(base);
        assert.equal(stored.persisted, true);
        assert.equal(stored.storedStatus, 'suspect');
        const open = await api.listInspections({ sheetId, tabName: tab, status: 'open' });
        assert.equal(open.length, 1);
        assert.deepEqual(open[0].checks, current);
        assert.equal(open[0].product_resolution, prior);
        assert.equal((await api.listProductClusters({ sheetId, tabName: tab })).totalRows, 0,
          'historical product decisions are excluded by the approved bounded contract');
        const before = await rows(tab);
        assert.equal((await api.resolveProductCluster({ fileId, verdict: 'fail', by: 'FAKE_NEW_HUMAN' })).ok, false,
          'product-only reconsideration is deliberately not provided by this patch');
        assert.deepEqual(await rows(tab), before);
        assert.equal((await api.resolveInspection({ fileId, resolution: requested, by: 'FAKE_NEW_HUMAN' })).resolved, 1);
        const after = (await rows(tab))[0];
        assert.equal(after.status, 'resolved');
        assert.equal(after.resolution, 'bad', 'explicit bad or protected historical fail cannot become normal');
        assert.equal(after.product_resolution, prior);
        assert.equal(after.product_resolution_note, 'FAKE_REOPEN_HISTORY');
        assert.equal(after.product_resolved_by, 'FAKE_PRIOR_HUMAN');
        assert.deepEqual(after.checks, current, 'confirmation does not rewrite the saved machine evidence');
      }
    });
  } finally {
    await db.close();
  }
});
