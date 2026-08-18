'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decideAutoApply, autoApplyResultFile, __setPoolForTest } = require('../src/services/paymentResult.service');
const paymentApply = require('../src/services/paymentApply.service');
const { HANA_AOA } = require('./fixtures/paymentResultFixtures');
const { parseResultAoa } = require('../src/utils/paymentResultParse');
const XLSX = require('@e965/xlsx');

process.on('uncaughtException', error => {
  console.error(error.stack || error);
  process.exit(1);
});

function decision(summary, duplicateApplied = false) {
  return decideAutoApply({ summary, duplicateApplied });
}

assert.deepStrictEqual(
  decision({ items: 10, matched: 9, unmatchedResults: 0 }),
  { allowed: true, matchRate: 0.9, blockers: [] },
  '회차 대상 일부만 매칭돼도 매칭 성공 건은 자동 반영한다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 8, unmatchedResults: 0 }),
  { allowed: true, matchRate: 0.8, blockers: [] },
  '정확 매칭률이 90% 미만이어도 매칭 성공 건은 자동 반영한다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 10, unmatchedResults: 1 }),
  { allowed: true, matchRate: 1, blockers: [] },
  '회차 밖 결과 행은 표시만 하고 이 회차의 매칭 성공 반영을 막지 않는다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 10, unmatchedResults: 0 }, true),
  { allowed: false, matchRate: 1, blockers: ['duplicate_file'] },
  '이미 반영된 동일 결과 파일은 자동 반영하지 않는다');

assert.deepStrictEqual(
  decision({ items: 0, matched: 0, unmatchedResults: 0 }),
  { allowed: false, matchRate: 0, blockers: ['no_pending_items'] },
  '대상이 없는 결과 파일은 자동 반영하지 않는다');

assert.deepStrictEqual(
  decision({ items: 10, matched: 0, unmatchedResults: 10 }),
  { allowed: false, matchRate: 0, blockers: ['no_matched_results'] },
  '매칭된 결과가 하나도 없으면 자동 반영하지 않는다');

assert.strictEqual(typeof autoApplyResultFile, 'function',
  '서버가 업로드·판정·반영을 하나의 자동 반영 경로에서 처리한다');

const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
assert.match(routes,
  /router\.post\('\/payment\/batch\/:id\/result-auto-apply', authMiddleware, adminOrMasterMiddleware/,
  '자동 반영 API도 기존 결과 파일 API와 동일한 관리자 권한을 요구한다');

const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
assert.match(workdesk, /function _pmResultDrop\(event, i\)/,
  '회차 행에 결과 파일 드래그 업로드 처리가 있다');
assert.match(workdesk, /result-auto-apply/,
  '결과 파일 업로드는 자동 반영 API만 호출한다');
assert.doesNotMatch(workdesk, /id="pmApplyBtn"/,
  '결과 확인창에 별도 이대로 반영 버튼을 남기지 않는다');
assert.match(workdesk, /outsideRows/, '회차 밖 이체결과도 확인 표에 표시한다');
assert.match(workdesk, /매칭된 성공 건은 정상 반영됩니다/, '회차 밖 결과와 매칭 성공 반영 기준을 화면에 고지한다');
assert.match(workdesk, /Array\.isArray\(p\.unmatchedResults\)/,
  '자동반영 응답의 회차 밖 결과가 배열이 아니어도 결과 화면이 중단되지 않는다');

function fileBase64(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'result');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

async function verifyAutomaticApplication() {
  const parsed = parseResultAoa(HANA_AOA, { expectBank: 'hana' });
  assert.ok(parsed.ok && parsed.rows.length >= 2, '자동 반영용 결과 파일 픽스처를 해석한다');
  const state = parsed.rows.slice(0, 2).map((row, index) => ({
    id: `I${index}`, sheet_id: 'S1', tab_name: 'T1', row_index: index + 1,
    reviewer_name: `R${index}`, phone8: `0100000000${index}`, bank_name: 'hana',
    bank_account: row.accountDigits, account_holder: row.holder, amount: row.amount,
    transfer_memo: '', status: 'pending', notified_at: null,
  }));
  const uploads = [];
  const batch = { id: 'B1', seq: 1, bank: 'hana', status: 'downloaded' };
  const query = async (sql, params, tx) => {
    const s = String(sql);
    if (/SELECT \* FROM payment_batches WHERE id = \$1/.test(s)) return { rows: [batch], rowCount: 1 };
    if (/SELECT \* FROM payment_batch_items WHERE batch_id/.test(s)) return { rows: state, rowCount: state.length };
    if (/SELECT id FROM payment_result_uploads[\s\S]*file_sha256/.test(s)) return { rows: uploads.filter(x => x.applied && x.sha === params[0]), rowCount: 0 };
    if (/INSERT INTO payment_result_uploads/.test(s)) {
      const entry = { id: `U${uploads.length + 1}`, file_name: params[2], file_blob: params[10], sha: params[11], applied: false };
      uploads.push(entry); return { rows: [{ id: entry.id, uploaded_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (/SELECT id, file_name, file_blob, file_sha256, applied/.test(s)) {
      const entry = uploads.find(x => x.id === params[0]);
      return { rows: entry ? [{ id: entry.id, file_name: entry.file_name, file_blob: entry.file_blob, file_sha256: entry.sha, applied: entry.applied }] : [], rowCount: entry ? 1 : 0 };
    }
    if (/SELECT pg_advisory_xact_lock/.test(s)) return { rows: [], rowCount: 1 };
    if (/UPDATE payment_batch_items[\s\S]*status = 'paid'/.test(s)) {
      const item = state.find(x => x.id === params[0] && x.status === 'pending');
      if (!item) return { rows: [], rowCount: 0 };
      item.status = 'paid'; item.paid_at = params[1]; return { rows: [item], rowCount: 1 };
    }
    if (/COUNT\(\*\)::int AS n FROM payment_batch_items/.test(s)) return { rows: [{ n: state.filter(x => x.status === 'pending').length }], rowCount: 1 };
    if (/UPDATE payment_result_uploads[\s\S]*SET summary/.test(s)) { return { rows: [], rowCount: 1 }; }
    if (/UPDATE payment_result_uploads/.test(s)) { uploads.find(x => x.id === params[0]).applied = true; return { rows: [], rowCount: 1 }; }
    if (/FROM review_index/.test(s)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query: (sql, params) => query(sql, params, true), release: () => {} };
  const pool = { query: (sql, params) => query(sql, params, false), connect: async () => client };
  const originalMark = paymentApply.markDepositCells;
  const originalVerify = paymentApply.verifyDepositCells;
  __setPoolForTest(pool);
  paymentApply.markDepositCells = async items => ({ recorded: items.length, queued: 0, skipped: 0, failed: 0 });
  paymentApply.verifyDepositCells = async items => ({ verified: items.length, missing: 0 });
  try {
    const onlyThisBatch = HANA_AOA.slice(0, parsed.rows[1].sheetRow);
    const out = await autoApplyResultFile({ batchId: 'B1', fileName: 'result.xlsx', base64: fileBase64(onlyThisBatch), by: 'test', notifyFailed: false });
    assert.strictEqual(out.autoApplied, true, '매칭된 결과가 있으면 업로드 즉시 자동 반영한다');
    assert.strictEqual(out.applied, 2, '자동 반영은 기존 입금 기록 경로를 통해 성공 항목을 반영한다');
    assert.strictEqual(out.board.recorded, 2, '자동 반영은 작업보드 입금일 기록 결과를 함께 반환한다');
    assert.ok(uploads[0].applied, '자동 반영한 파일은 이후 동일 파일 경고를 위해 반영 이력으로 남긴다');
    const duplicate = await autoApplyResultFile({ batchId: 'B1', fileName: 'result.xlsx', base64: fileBase64(onlyThisBatch), by: 'test', notifyFailed: false });
    assert.strictEqual(duplicate.autoApplied, false, '이미 반영된 동일 파일은 다시 자동 반영하지 않는다');
    assert.ok(duplicate.autoApply.blockers.includes('duplicate_file'), '동일 파일 경고 사유를 응답에 포함한다');
  } finally {
    paymentApply.markDepositCells = originalMark;
    paymentApply.verifyDepositCells = originalVerify;
    __setPoolForTest(null);
  }
}

verifyAutomaticApplication().then(() => console.log('payment result auto-apply decision tests passed'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
