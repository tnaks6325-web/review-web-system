'use strict';
// Execute the complete production inspection service with only fake dependencies.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const base = path.join(__dirname, '..');
function service({ classify, write = 'ok', lookupFailure = '', rowTypeFailure = false, reviewType = '포토', workKind = null } = {}) {
  const saved = [];
  const pure = new Map();
  const loadPure = name => {
    if (pure.has(name)) return pure.get(name);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(base, 'src/utils', name + '.js'), 'utf8'), {
      module, exports: module.exports,
      require: key => { throw new Error('Unexpected pure dependency: ' + key); },
    });
    pure.set(name, module.exports);
    return module.exports;
  };
  const module = { exports: {} };
  const context = { module, exports: module.exports, Buffer, process: { env: {} }, require: key => {
    if (key === 'crypto') return crypto;
    if (key === '../utils/logger') return { logger: { warn() {}, info() {} } };
    if (key === './reviewTypeContext.service') return { CAMPAIGN_REVIEW_TYPE_LATERAL: '', reviewTypeForRow: async () => { if (rowTypeFailure) throw new Error('FAKE row type lookup failure'); return null; } };
    if (key === './workKindContext.service') return { CAMPAIGN_WORK_KIND_LATERAL: '' };
    if (key === '../utils/workKind') return { resolveWorkKind: () => workKind };
    if (key === './gemini.service') return { classifySubmissionImage: classify };
    if (/^\.\.\/utils\/(workOrderLink|reviewType|captureSlots|inspectIssueTypes)$/.test(key)) return loadPure(key.split('/').pop());
    throw new Error('Blocked dependency: ' + key);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'src/services/reviewInspect.service.js'), 'utf8')
    + '\nmodule.exports.__upsertForTest = _upsertInspection;', context);
  const api = module.exports;
  api.__setPoolForTest({ query: async (sql, params) => {
    if ((lookupFailure === 'criteria' && sql.includes('FROM tab_configs c'))
      || (lookupFailure === 'duplicate' && sql.includes('WHERE file_hash = $1'))
      || (lookupFailure === 'similarity' && sql.includes('similarity(ocr_text'))
      || (lookupFailure === 'author' && sql.includes('WHERE ocr_author = $1'))) throw new Error('FAKE lookup failure');
    if (sql.includes('FROM tab_configs c')) return { rows: [{
      inspect_product_names: '가상브랜드 보습 로션 500ml 1개', inspect_product_aliases: '', inspect_product_rules: [],
      tab_review_type: reviewType, camp_review_type: reviewType, channel: '쿠팡',
    }] };
    if (sql.includes('INSERT INTO review_inspections')) {
      if (write === 'error') throw new Error('FAKE persistence failure');
      if (write === 'empty') return { rows: [], rowCount: 0 };
      const row = { status: params[6], checks: JSON.parse(params[7]), updated_at: '2026-01-01 00:00:00+00' };
      saved.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  } });
  return { api, saved };
}
const input = {
  fileId: 'FAKE_FILE', sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB',
  base64: Buffer.from('FAKE IMAGE, NOT CUSTOMER DATA').toString('base64'), samples: [],
};
async function run() {
  const { api, saved } = service({ classify: async () => { throw new Error('FAKE model unavailable'); } });
  const result = await api.inspectSubmission(input);
  assert.ok(result, 'inspection should record an unverified result without throwing into the upload');
  assert.notStrictEqual(result.status, 'pass', 'AI failure must not become verified success through a duplicate-only pass');
  assert.strictEqual(saved.length, 1, 'unverified inspection should still be persisted');
  assert.notStrictEqual(saved[0].status, 'pass', 'database must not label an unread image as verified');
  for (const classification of [{}, { kind: 'review', confidence: 0.2 }, { kind: 'order_cancel', confidence: 0.2 }]) {
    const run = service({ classify: async () => ({
      productName: '가상브랜드 보습 로션 500ml 1개', reviewText: '가상 리뷰의 충분히 긴 본문입니다. 실제 고객 자료를 사용하지 않고 읽기 결과를 검증합니다.',
      ...classification,
    }) });
    const unverified = await run.api.inspectSubmission(input);
    assert.ok(unverified, 'malformed or low-confidence classification must be recorded without throwing');
    assert.notStrictEqual(unverified.status, 'pass', 'malformed or low-confidence classification is not verified evidence');
  }
  const valid = async () => ({ kind: 'review', confidence: 0.99, channel: 'coupang',
    productName: '가상브랜드 보습 로션 500ml 1개',
    reviewText: '가상 리뷰의 충분히 긴 본문입니다. 실제 고객 자료를 사용하지 않고 읽기 결과를 검증합니다.', authorMask: '가상**' });
  for (const lookupFailure of ['criteria', 'duplicate', 'similarity', 'author']) {
    const run = service({ classify: valid, lookupFailure });
    const unverified = await run.api.inspectSubmission(input);
    assert.ok(unverified, 'lookup failures must not throw into the upload');
    assert.notStrictEqual(unverified.status, 'pass', lookupFailure + ' lookup failure is not verified evidence');
  }
  for (const reviewText of ['', '   ', null]) {
    const missingText = service({ classify: async () => ({ ...(await valid()), reviewText }) });
    assert.notStrictEqual((await missingText.api.inspectSubmission(input)).status, 'pass', 'missing normal-review OCR is not an applicable short phrase');
  }
  for (const reviewType of ['구매확정', '별점']) {
    const allowed = service({ reviewType, classify: async () => ({ ...(await valid()), reviewText: '' }) });
    assert.strictEqual((await allowed.api.inspectSubmission(input)).status, 'pass', 'confirmed non-text review types do not require a written body');
  }
  const blog = service({ workKind: 'blog', classify: async () => null });
  assert.strictEqual((await blog.api.inspectSubmission(input)).status, 'pass', 'blog uploads do not require a review screenshot');
  const row = service({ classify: valid, rowTypeFailure: true });
  assert.notStrictEqual((await row.api.inspectSubmission({ ...input, rowIndex: 1 })).status, 'pass', 'row type lookup failure must not become a verified result');
  const cluster = service();
  const seed = { file_id: 'FAKE_CLUSTER_FILE', sheet_id: 'FAKE_SHEET', tab_name: 'FAKE_TAB', status: 'suspect',
    ocr_product: '가상 로션 오타 표기', checks: { product: { verdict: 'warn', expected: ['가상 로션 기대 표기'] },
      format: { verdict: 'skip', reason: 'no_ai', evidence: 'unknown' }, duplicate: { verdict: 'pass' } } };
  const updates = [];
  cluster.api.__setPoolForTest({ query: async (sql, params) => {
    if (/FROM review_inspections WHERE file_id/.test(sql)) return { rows: [seed] };
    if (/FROM review_inspections\s+WHERE sheet_id/.test(sql)) return { rows: [seed] };
    if (/SELECT inspect_product_rules/.test(sql)) return { rows: [{ inspect_product_rules: [] }] };
    if (/UPDATE review_inspections/.test(sql)) updates.push(params);
    return { rows: [], rowCount: 1 };
  } });
  const decision = await cluster.api.resolveProductCluster({ fileId: seed.file_id, verdict: 'pass', by: 'FAKE_HUMAN' });
  assert.strictEqual(decision.remainsOpen, 1, 'a product-only decision cannot close unknown format evidence');
  assert.strictEqual(updates[0][2], 'unverifiable', 'product-only resolution preserves the unverified whole-case status');
  console.log('Inspection failure safety: model, lookup, row-type and product-only decisions passed');
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { service, input };
