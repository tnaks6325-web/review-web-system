'use strict';
// Purchase captures and review photos share one byte-hash lock namespace and one reuse check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lockEvidenceShaInTx, evidenceShaUsesInTx } = require('../src/utils/dualEvidenceShaLock');

function client(rows = []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rows }; } };
}

test('one namespace for purchase and review hash locks', async () => {
  const c = client();
  await lockEvidenceShaInTx(c, 'a'.repeat(64));
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].sql, "SELECT pg_advisory_xact_lock(hashtext('dual_evidence_sha'),hashtext($1))");
  assert.deepEqual(c.calls[0].params, ['a'.repeat(64)]);
});

test('reuse lookup reads both purchase artifacts and review photos', async () => {
  const c = client([{ kind: 'review', file_id: 'F1' }]);
  const uses = await evidenceShaUsesInTx(c, 'b'.repeat(64));
  assert.deepEqual(uses, [{ kind: 'review', file_id: 'F1' }]);
  assert.match(c.calls[0].sql, /FROM review_submissions WHERE byte_sha256=\$1/);
  assert.match(c.calls[0].sql, /FROM purchase_capture_artifacts WHERE byte_sha256=\$1/);
});

test('missing or malformed hash is rejected before any SQL', async () => {
  for (const bad of ['', null, 'xyz', 'A'.repeat(64)]) {
    const c = client();
    await assert.rejects(() => lockEvidenceShaInTx(c, bad), /dual_evidence_sha_invalid/);
    await assert.rejects(() => evidenceShaUsesInTx(c, bad), /dual_evidence_sha_invalid/);
    assert.equal(c.calls.length, 0);
  }
});

test('purchase and review writers use the shared lock and purchase checks review reuse', () => {
  const fs = require('fs'); const path = require('path');
  const read = f => fs.readFileSync(path.join(__dirname, '../src/services', f), 'utf8');
  for (const f of ['dualPurchaseArtifacts.service.js', 'dualPurchaseSubmission.service.js', 'dualChannelReview.service.js']) {
    const src = read(f);
    assert.ok(!/dual-artifact:sha:|dual_review_evidence/.test(src), f + ' must not keep a private hash namespace');
    assert.match(src, /lockEvidenceShaInTx\(/, f + ' uses shared hash lock');
  }
  for (const f of ['dualPurchaseArtifacts.service.js', 'dualPurchaseSubmission.service.js']) {
    assert.match(read(f), /evidenceShaUsesInTx\(/, f + ' rejects a hash already used by a review photo');
  }
});
