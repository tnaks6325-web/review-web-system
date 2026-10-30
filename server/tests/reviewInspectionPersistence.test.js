'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const base = path.join(__dirname, '..');
function service({ write = 'ok', stored } = {}) {
  const queries = [];
  const pure = new Map();
  function loadPure(name) {
    if (pure.has(name)) return pure.get(name);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(base, 'src/utils', name + '.js'), 'utf8'), {
      module, exports: module.exports, require: key => { throw new Error('Blocked: ' + key); },
    });
    pure.set(name, module.exports);
    return module.exports;
  }
  const target = { file_id: 'FAKE_FILE', file_hash: 'FAKE_HASH', sheet_id: 'FAKE_SHEET',
    tab_name: 'FAKE_TAB', slot_key: 'receipt', receipt_evidence: true };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(base, 'src/services/reviewInspect.service.js'), 'utf8'), {
    module, exports: module.exports, Buffer, process: { env: {} }, require: key => {
      if (key === 'crypto') return crypto;
      if (key === '../utils/logger') return { logger: { warn() {}, info() {} } };
      if (key === './reviewTypeContext.service') return { CAMPAIGN_REVIEW_TYPE_LATERAL: '', reviewTypeForRow: async () => null };
      if (key === './workKindContext.service') return { CAMPAIGN_WORK_KIND_LATERAL: '' };
      if (key === '../utils/workKind') return { resolveWorkKind: () => null };
      if (key === './drive.service') return { downloadFile: async () => ({ buffer: Buffer.from('FAKE IMAGE'), mimeType: 'image/jpeg' }) };
      if (key === './gemini.service') return { classifySubmissionImage: async () => ({ kind: 'receipt', confidence: 0.99 }) };
      if (key === './captureVerify.service') return { verifyCapture: async () => ({ status: 'ok', got: 'receipt', businessNo: '1234567890' }) };
      if (/^\.\.\/utils\/(workOrderLink|reviewType|captureSlots|inspectIssueTypes)$/.test(key)) return loadPure(key.split('/').pop());
      throw new Error('Blocked: ' + key);
    },
  });
  const api = module.exports;
  api.__setPoolForTest({ query: async (sql, params) => {
    queries.push(sql);
    if (sql.includes('company_business_no')) return { rows: [{ value: '1234567890' }] };
    if (sql.includes('INSERT INTO review_inspections')) {
      // The initial receipt reset is not the final inspection write.
      if (sql.includes("'pending',$7::jsonb")) return { rows: [], rowCount: 1 };
      if (write === 'error') throw new Error('FAKE persistence failure');
      if (write === 'empty') return { rows: [], rowCount: 0 };
      assert.match(sql, /RETURNING\s+status,\s*checks/i, 'success must come from SQL RETURNING');
      return { rows: [stored || { status: params[6], checks: JSON.parse(params[7]) }], rowCount: 1 };
    }
    if (sql.includes('FROM review_submissions WHERE file_id')) return { rows: [target] };
    if (sql.includes('ORDER BY pri, attempts')) return { rows: [target] };
    return { rows: [], rowCount: 0 };
  } });
  return { api, queries };
}
const input = { fileId: 'FAKE_FILE', sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB',
  slotKey: 'receipt', slotRole: 'receipt', samples: [],
  captureVerdict: { status: 'ok', got: 'receipt', businessNo: '1234567890' } };
const tests = [];
const test = (name, run) => tests.push({ name, run });
test('successful RETURNING row preserves calculated result and reports stored result', async () => {
  const { api } = service();
  const r = await api.inspectSubmission(input);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(r.status, 'pass');
  assert.strictEqual(r.storedStatus, 'pass');
  assert.strictEqual(JSON.stringify(r.storedChecks), JSON.stringify(r.checks));
});
for (const write of ['empty', 'error']) {
  test(`${write}: calculation survives failed persistence without throwing`, async () => {
    const { api } = service({ write });
    const r = await api.inspectSubmission(input);
    assert.strictEqual(r.status, 'pass');
    assert.strictEqual(r.checks.receiptValidation.verdict, 'pass');
    assert.strictEqual(r.persisted, false);
    assert.strictEqual(r.storedStatus, null);
    assert.strictEqual(r.storedChecks, null);
  });
  test(`${write}: receipt reinspection remains pending when final write fails`, async () => {
    const { api, queries } = service({ write });
    const r = await api.reinspectReceiptFile({ fileId: input.fileId });
    assert.ok(queries.some(sql => sql.includes("'pending',$7::jsonb")), 'reset before final inspection');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.pending, true);
  });
  test(`${write}: sweep counts a failed write as failed, never done`, async () => {
    const { api, queries } = service({ write });
    const r = await api.runInspectSweep({ limit: 1 });
    assert.strictEqual(r.scanned, 1, 'exercise a real target rather than an empty sweep');
    assert.ok(queries.some(sql => sql.includes('RETURNING status, checks')), 'final write attempted');
    assert.strictEqual(r.done, 0);
    assert.strictEqual(r.failed, 1);
  });
}
test('stored resolution never overwrites the calculated status/checks contract', async () => {
  const stored = { status: 'resolved', checks: { product: { verdict: 'pass', source: 'human' } } };
  const { api } = service({ stored });
  const r = await api.inspectSubmission(input);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(r.status, 'pass');
  assert.strictEqual(r.checks.receiptValidation.verdict, 'pass');
  assert.strictEqual(r.storedStatus, 'resolved');
  assert.strictEqual(r.storedChecks, stored.checks);
});
test('successful receipt reinspection and sweep still report completion', async () => {
  const { api } = service();
  assert.strictEqual((await api.reinspectReceiptFile({ fileId: input.fileId })).ok, true);
  const r = await api.runInspectSweep({ limit: 1 });
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.done, 1);
  assert.strictEqual(r.failed, 0);
});
test('replacement approval logs an unsuccessful inspection write without undoing approval', async () => {
  const src = fs.readFileSync(path.join(base, 'src/routes/reviewEdit.routes.js'), 'utf8');
  const start = src.indexOf('    try {', src.indexOf('// 현금영수증 교체본은'));
  const end = src.indexOf("    _lap('receipt');", start);
  assert.ok(start >= 0 && end > start, 'find the complete immediate receipt reinspection block');
  for (const result of [null, { persisted: false }, { persisted: true }]) {
    const warnings = [];
    let called = 0;
    await vm.runInNewContext(`(async () => { ${src.slice(start, end)} })()`, {
      Buffer, crypto, committed: { new_file_id: 'FAKE_NEW_FILE', sheet_id: 'S', tab_name: 'T' },
      pool: { query: async () => ({ rows: [{}] }) }, reviewTypeForTab: async () => null,
      isCashReceiptSlot: () => true,
      driveService: { downloadFile: async () => ({ buffer: Buffer.from('FAKE IMAGE') }) },
      logger: { warn: text => warnings.push(text) },
      require: key => {
        if (key.endsWith('cashReceiptContext.service')) return { cashReceiptRequiredForTab: async () => true };
        if (key.endsWith('reviewInspect.service')) return {
          inspectSubmission: async () => { called++; return result; }, saveFileHash: async () => {},
        };
        throw new Error('Blocked: ' + key);
      },
    });
    assert.strictEqual(called, 1, 'inspection actually ran');
    assert.strictEqual(warnings.length, result?.persisted === true ? 0 : 1, 'failure must not be silent');
    if (warnings.length) assert.match(warnings[0], /pending/);
  }
});
(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
  }
  console.log(`review inspection persistence: ${tests.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();