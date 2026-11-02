'use strict';
const assert = require('assert');
const api = require('../src/services/reviewInspect.service');

async function run() {
  const expected = ['5L 가상브랜드 프리미엄 저자극 보습 로션'];
  const rows = ['0.5L 가상브랜드 프리미엄 저자극 보습 로션', expected[0]].map((ocr, index) => ({
    file_id: 'FAKE_LEGACY_' + index, sheet_id: 'FAKE_SHEET', tab_name: 'FAKE_TAB',
    ocr_product: ocr, status: 'suspect', product_resolution: null,
    checks: { product: { verdict: 'warn', expected, ocr } },
  }));
  const clusterKey = row => api.productClusterKey({ sheetId: row.sheet_id, tabName: row.tab_name,
    expectedList: row.checks.product.expected, ocr: row.ocr_product });
  assert.strictEqual(clusterKey(rows[0]), clusterKey(rows[1]),
    'the historical decimal-colliding grouping key is deliberately preserved');
  for (const order of [rows, [...rows].reverse()]) {
    api.__setPoolForTest({ query: async () => ({ rows: order }) });
    const listed = await api.listProductClusters({ includeAll: true });
    assert.strictEqual(listed.totalRows, 2);
    assert.strictEqual(listed.totalClusters, 1);
    assert.strictEqual(listed.autoPassRows, 0,
      'old merged expected-only JSON must not automatically certify a mixed decimal group');
    assert.strictEqual(listed.clusters[0].triage.eligible, false);
    assert.strictEqual(listed.clusters[0].triage.reason, 'legacy_evidence');
  }
  const primary = ['가상브랜드 보습 로션 500ml 2개'];
  const trusted = (id, ocr, expected = primary) => ({
    file_id: id, sheet_id: 'FAKE_SHEET', tab_name: 'FAKE_TAB', ocr_product: ocr,
    status: 'suspect', product_resolution: null,
    checks: { format: { verdict: 'pass' }, duplicate: { verdict: 'pass' },
      product: { ...api.matchProductName(ocr, expected, { canonicalSource: 'manual' }), verdict: 'warn' } },
  });
  const equivalent = [trusted('FAKE_A', primary[0]), trusted('FAKE_B', '가상브랜드  보습 로션 500ml  2개')];
  api.__setPoolForTest({ query: async () => ({ rows: equivalent }) });
  const positive = await api.listProductClusters({ includeAll: true });
  assert.strictEqual(positive.totalClusters, 1);
  assert.strictEqual(positive.autoPassRows, 2,
    'different raw whitespace with the same complete canonical semantic proof is eligible');
  let current = equivalent;
  let writes = 0;
  api.__setPoolForTest({ query: async sql => {
    if (/^\s*(UPDATE|INSERT INTO)\b/.test(sql)) { writes++; return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT inspect_product_rules')) return { rows: [{ inspect_product_rules: [] }] };
    if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [current[0]] };
    if (/FROM review_inspections/.test(sql)) return { rows: current };
    return { rows: [], rowCount: 0 };
  } });
  const preview = await api.autoResolveProductClusters({ dryRun: true });
  assert.strictEqual(preview.eligibleRows, 2);
  current = [equivalent[0], { ...equivalent[1], file_id: 'FAKE_CHANGED_FILE' }];
  const denied = await api.autoResolveProductClusters({ dryRun: false, confirm: 'AUTO_PASS_V1',
    snapshotToken: preview.snapshotToken, clusterKeys: preview.clusterKeys, by: 'FAKE_ADMIN' });
  assert.strictEqual(denied.ok, false, 'same historical key with a changed target set cannot reuse an approval token');
  assert.strictEqual(writes, 0, 'reject changed evidence before any update or rule learning');
  current = equivalent;
  writes = 0;
  const added = trusted('FAKE_ADDED_AFTER_PREVIEW', primary[0]);
  api.__setPoolForTest({ query: async sql => {
    if (/^\s*(UPDATE|INSERT INTO)\b/.test(sql)) { writes++; return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT inspect_product_rules')) return { rows: [{ inspect_product_rules: [] }] };
    if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [equivalent[0]] };
    if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [...equivalent, added] };
    if (/FROM review_inspections/.test(sql)) return { rows: equivalent };
    return { rows: [], rowCount: 0 };
  } });
  const freshPreview = await api.autoResolveProductClusters({ dryRun: true });
  const changedWhileLocking = await api.autoResolveProductClusters({ dryRun: false, confirm: 'AUTO_PASS_V1',
    snapshotToken: freshPreview.snapshotToken, clusterKeys: freshPreview.clusterKeys, by: 'FAKE_ADMIN' });
  assert.strictEqual(changedWhileLocking.affected, 0, 'targets added after listing must be revalidated under the execution lock');
  assert.strictEqual(writes, 0, 'a changed locked target set cannot write any row or human rule');
  const stale = { ...equivalent[0], ocr_product: '가상브랜드  보습 로션 500ml 2개' };
  api.__setPoolForTest({ query: async () => ({ rows: [stale] }) });
  const staleProof = await api.listProductClusters({ includeAll: true });
  assert.strictEqual(staleProof.autoPassRows, 0, 'changed OCR must not borrow the raw proof from a prior observation');
  const capped = Array.from({ length: 10000 }, (_, i) => ({ ...equivalent[0], file_id: 'FAKE_CAP_' + i }));
  api.__setPoolForTest({ query: async () => ({ rows: capped }) });
  const partial = await api.listProductClusters({ includeAll: true });
  assert.strictEqual(partial.truncated, true);
  assert.strictEqual(partial.autoPassRows, 0, 'a capped scan cannot prove every member of a historical group');
  const humanSeed = trusted('FAKE_EXPLICIT_HUMAN', '가상브랜드 생략된 다른 로션');
  assert.strictEqual(humanSeed.checks.product.evidence, 'unknown');
  const humanUpdates = [];
  api.__setPoolForTest({ query: async (sql, params) => {
    if (/^\s*UPDATE review_inspections/.test(sql)) humanUpdates.push(params);
    if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [humanSeed] };
    if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [humanSeed] };
    if (/SELECT inspect_product_rules/.test(sql)) return { rows: [{ inspect_product_rules: [] }] };
    return { rows: [], rowCount: 1 };
  } });
  const human = await api.resolveProductCluster({ fileId: humanSeed.file_id, verdict: 'pass', by: 'FAKE_ACTUAL_HUMAN' });
  assert.strictEqual(human.remainsOpen, 0, 'an explicit human confirmation resolves the product-only unknown, not unrelated unknown axes');
  assert.strictEqual(humanUpdates[0][2], 'resolved');
  assert.strictEqual(JSON.parse(humanUpdates[0][1]).product.comparison.kind, 'insufficient', 'keep original machine evidence for audit');
  console.log('Product cluster evidence: automatic fences and explicit human confirmation passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
