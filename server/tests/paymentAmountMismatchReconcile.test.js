'use strict';
const assert = require('assert');
const fs = require('fs');
const svc = require('../src/services/paymentResult.service');
const paymentApply = require('../src/services/paymentApply.service');

const BATCH_ID = '00000000-0000-4000-8000-000000000201';
const UPLOAD_ID = '00000000-0000-4000-8000-000000000202';
const ITEM_ID = '00000000-0000-4000-8000-000000000203';

function harness({ failRecord = false } = {}) {
  const state = { status: 'failed', audits: [], records: [], paidRows: [], committed: 0, rolledBack: 0, snapshot: null, board: null };
  const item = {
    id: ITEM_ID, sheet_id: 'S1', tab_name: '작업', row_index: 77, reviewer_name: '조현기',
    phone8: '12345678', bank_name: '국민은행', bank_account: '1234567890172', account_holder: '조현기',
    product_price: 18950, review_fee: 0, amount: 18950, status: state.status,
    result_status: '결과 파일에 없음', fail_reason: '이체 실패 — 결과 파일에 해당 이체내역 없음',
  };
  const upload = { summary: { preview: {
    items: [{ itemId: ITEM_ID, reviewerName: '조현기', amount: 18950, accountTail: '0172', outcome: 'not_in_file' }],
    unmatchedResults: [{ seq: 9, holder: '조현기', amount: 7650, accountTail: '0172', transferredAt: '2026.08.27 15:35', success: true }],
    summary: { success: 0, failed: 1, notInFile: 1 },
  } } };
  const clone = value => JSON.parse(JSON.stringify(value));
  const query = async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN') { state.snapshot = clone(state); return { rows: [], rowCount: 0 }; }
    if (text === 'COMMIT') { state.snapshot = null; state.committed++; return { rows: [], rowCount: 0 }; }
    if (text === 'ROLLBACK') {
      if (state.snapshot) Object.assign(state, state.snapshot);
      state.snapshot = null; state.rolledBack++; return { rows: [], rowCount: 0 };
    }
    if (/SELECT \* FROM payment_batches WHERE id/.test(text)) return { rows: [{ id: BATCH_ID, status: 'applied' }] };
    if (/SELECT summary, file_blob, file_name FROM payment_result_uploads/.test(text)) return { rows: [upload] };
    if (/SELECT \* FROM payment_batch_items WHERE batch_id/.test(text)) return { rows: [{ ...item, status: state.status }] };
    if (/WITH targets AS/.test(text)) return { rows: [{
      sheetId: 'S1', tabName: '작업', rowIndex: 77,
      participantRowJson: { 결제금액: '18,950' }, manualEdits: {}, anchorEdits: { 'col:결제금액': '7,650' },
    }] };
    if (/SELECT ri\.is_submitted2 AS "isSubmitted2"/.test(text)) return { rows: [{ isSubmitted2: 'NONE', hasPaymentRecord: false, hasPaidBatchItem: false }] };
    if (/INSERT INTO payment_amount_mismatch_reconciliations/.test(text)) {
      if (state.audits.length) return { rows: [], rowCount: 0 };
      state.audits.push({ expected: params[4], product: params[5], workboard: params[7], actual: params[8], note: params[9] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE payment_batch_items[\s\S]*금액 조정 이체완료/.test(text)) { state.status = 'paid'; return { rows: [], rowCount: 1 }; }
    if (/UPDATE payment_result_uploads SET success_count/.test(text)) return { rows: [], rowCount: 1 };
    if (/SELECT COALESCE\(tc\.workboard_schema_version, 1\) AS schema_version/.test(text)) return { rows: [{ schema_version: 1, is_submitted: false }] };
    if (/UPDATE review_index SET is_submitted2 = 'PAID'/.test(text)) { state.paidRows.push(params); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO payment_records/.test(text)) {
      if (failRecord) throw new Error('forced payment record failure');
      state.records.push(params); return { rows: [], rowCount: 1 };
    }
    if (/SELECT submit_col2, tab_gid FROM review_index/.test(text)) return { rows: [{ submit_col2: '입금', tab_gid: 'gid-1' }] };
    if (/UPDATE payment_batches SET board_recorded_count/.test(text)) { state.board = params; return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected query: ${text.slice(0, 120)}`);
  };
  return { state, pool: { query, connect: async () => ({ query, release() {} }) } };
}

(async () => {
  assert.equal(typeof svc.reconcileAmountMismatch, 'function');
  assert.deepEqual(svc.findAmountMismatchCandidates({
    transfers: [{ seq: 1, holder: '조현기', amount: 7650, accountTail: '0172', success: true }],
    items: [{ id: ITEM_ID, reviewerName: '조현기', amount: 18950, workboardAmount: 7650,
      reviewFee: 0, bankAccount: '1234567890172', status: 'failed', failReason: '결과 파일에 해당 이체내역 없음' }],
  }).map(x => [x.expectedAmount, x.workboardAmount, x.actualAmount]), [[18950, 7650, 7650]]);

  svc.__setPoolForTest({ query: async sql => {
    const text = String(sql);
    if (/FROM payment_result_uploads WHERE id/.test(text)) return { rows: [{ summary: { preview: { unmatchedResults: [
      { seq: 9, memo: '테스트입금', holder: '조현기', amount: 7650, accountTail: '0172', success: true },
    ] } } }] };
    if (/FROM unconfirmed_transfer_reviews/.test(text)) return { rows: [] };
    if (/FROM review_index ri/.test(text) && /alreadyPaid/.test(text)) return { rows: [
      { reviewerName: '조현기', rowIndex: 77, rowJson: { 결제금액: '18,950' }, alreadyPaid: false },
    ] };
    if (/FROM payment_batch_items WHERE batch_id/.test(text)) return { rows: [{
      id: ITEM_ID, sheet_id: 'S1', tab_name: '작업', row_index: 77, reviewer_name: '조현기',
      bank_account: '1234567890172', product_price: 18950, review_fee: 0, amount: 18950,
      status: 'failed', result_status: '결과 파일에 없음', fail_reason: '결과 파일에 해당 이체내역 없음',
    }] };
    if (/WITH targets AS/.test(text)) return { rows: [{
      sheetId: 'S1', tabName: '작업', rowIndex: 77,
      participantRowJson: { 결제금액: '18,950' }, manualEdits: {}, anchorEdits: { 'col:결제금액': '7,650' },
    }] };
    throw new Error(`unexpected inspect query: ${text.slice(0, 100)}`);
  } });
  const inspected = await svc.inspectUnconfirmedWorkMatch({
    batchId: BATCH_ID, uploadId: UPLOAD_ID, memo: '테스트입금', sheetId: 'S1', tabName: '작업',
  });
  assert.equal(inspected.results[0].state, 'amount_mismatch_candidate',
    '일반 미확인 승인으로 우회하지 못하도록 서버 판정도 전용 상태여야 한다');
  assert.equal(inspected.amountMismatchCandidates[0].expectedAmount, 18950);
  assert.equal(inspected.amountMismatchCandidates[0].workboardAmount, 7650);

  const originalMark = paymentApply.markDepositCells;
  const originalVerify = paymentApply.verifyDepositCells;
  paymentApply.markDepositCells = async items => ({ recorded: items.length, queued: 0, skipped: 0, failed: 0 });
  paymentApply.verifyDepositCells = async items => ({ verified: items.length, missing: 0 });
  try {
    const ok = harness(); svc.__setPoolForTest(ok.pool);
    await assert.rejects(
      svc.reconcileAmountMismatch({ batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 9, note: '' }),
      err => err && err.code === 'bad_request', '승인 사유 없이는 처리할 수 없어야 한다');
    const out = await svc.reconcileAmountMismatch({
      batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 9,
      note: '관리자 작업보드 금액 7,650원 확인', by: 'admin-test',
    });
    assert.equal(out.ok, true);
    assert.equal(out.expectedAmount, 18950);
    assert.equal(out.actualAmount, 7650);
    assert.equal(ok.state.status, 'paid');
    assert.deepEqual(ok.state.audits[0], { expected: 18950, product: 7650, workboard: 7650, actual: 7650, note: '관리자 작업보드 금액 7,650원 확인' });
    assert.equal(ok.state.records.length, 1, '실제 이체금액으로 입금 원장을 기록해야 한다');
    assert.equal(ok.state.committed, 1);
    assert.ok(ok.state.board, '작업보드 입금일 기록 결과도 회차에 남겨야 한다');

    const fail = harness({ failRecord: true }); svc.__setPoolForTest(fail.pool);
    await assert.rejects(svc.reconcileAmountMismatch({
      batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 9,
      note: '테스트', by: 'admin-test',
    }), /forced payment record failure/);
    assert.equal(fail.state.status, 'failed', '입금 원장 실패 시 회차 성공 전환도 롤백해야 한다');
    assert.equal(fail.state.audits.length, 0, '감사 이력도 함께 롤백해야 한다');
    assert.equal(fail.state.rolledBack, 1);
  } finally {
    svc.__setPoolForTest(null);
    paymentApply.markDepositCells = originalMark;
    paymentApply.verifyDepositCells = originalVerify;
  }

  const migration = fs.readFileSync(require.resolve('../migrations/150_payment_amount_mismatch_reconciliations.sql'), 'utf8');
  assert.match(migration, /expected_amount/); assert.match(migration, /actual_amount/); assert.match(migration, /review_note TEXT NOT NULL/);
  const routes = fs.readFileSync(require.resolve('../src/routes/trackB.routes.js'), 'utf8');
  assert.match(routes, /amount-mismatch-reconcile/); assert.match(routes, /adminOrMasterMiddleware/);
  const html = fs.readFileSync(require.resolve('../../frontend/workdesk.html'), 'utf8');
  assert.match(html, /금액 조정 승인/); assert.match(html, /pmAmountMismatchNote/); assert.match(html, /단독 이상금액/);
  console.log('payment amount mismatch reconciliation tests passed');
})().catch(err => { svc.__setPoolForTest(null); console.error(err.stack || err); process.exitCode = 1; });
