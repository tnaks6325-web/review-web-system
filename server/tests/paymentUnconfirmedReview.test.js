'use strict';

const assert = require('assert');
const fs = require('fs');
const svc = require('../src/services/paymentResult.service');

assert.equal(typeof svc.reviewUnconfirmedTransfer, 'function',
  '미확인 이체의 행별 검토를 기록하는 서비스가 필요하다');
assert.equal(typeof svc.createDuplicatePaymentCase, 'function',
  '중복입금의 회수·환불 후속관리 건을 만드는 서비스가 필요하다');
assert.equal(typeof svc.updateDuplicatePaymentCase, 'function',
  '중복입금 후속관리 상태를 변경하는 서비스가 필요하다');

const routes = fs.readFileSync(require.resolve('../src/routes/trackB.routes.js'), 'utf8');
assert.match(routes, /unconfirmed-transfer-review/,
  '행별 대조 검토 API가 필요하다');
assert.match(routes, /duplicate-payment-case/,
  '중복입금 후속관리 API가 필요하다');
const workdesk = fs.readFileSync(require.resolve('../../frontend/workdesk.html'), 'utf8');
assert.match(workdesk, /function _pmOpenDuplicateCaseManagement\(\)/,
  '중복입금 후속관리 목록을 여는 UI가 필요하다');
assert.match(workdesk, /function _pmUpdateDuplicatePaymentCase\(caseId\)/,
  '중복입금 후속관리 상태를 갱신하는 UI가 필요하다');
assert.match(workdesk, /입금 성공 승인/,
  '입금 이력이 없는 행의 승인 버튼은 업무 용어로 명확히 표시해야 한다');

const migration = fs.readFileSync(require.resolve('../migrations/124_unconfirmed_transfer_reviews.sql'), 'utf8');
assert.match(migration, /unconfirmed_transfer_reviews/);
assert.match(migration, /duplicate_payment_cases/);
assert.match(migration, /UNIQUE \(upload_id, result_seq\)/,
  '같은 이체 결과를 두 번 검토하지 못하게 해야 한다');
assert.match(svc.reviewUnconfirmedTransfer.toString(), /recordDeposits/,
  '입금 성공 승인 시 해당 참여자 행의 입금 이력과 작업보드 입금일을 기록해야 한다');

const queries = [];
let approvedBoardItems = [];
svc.__setPaymentApplyForTest({
  markDepositCells: async items => { approvedBoardItems = items; return { recorded: items.length, queued: 0, skipped: 0, failed: 0 }; },
  verifyDepositCells: async items => ({ verified: items.length, missing: 0 }),
});
const client = {
  async query(sql) {
    queries.push(sql);
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (/SELECT id, status FROM payment_batches/.test(sql)) return { rows: [{ id: 'batch-1', status: 'created' }] };
    if (/SELECT summary FROM payment_result_uploads/.test(sql)) return { rows: [{ summary: { preview: { unmatchedResults: [
      { seq: 8, memo: '테스트입금명', holder: '황민정', amount: 20300, success: true, transferredAt: '2026.08.19 10:00' },
    ] } } }] };
    if (/FROM unconfirmed_transfer_reviews WHERE upload_id/.test(sql)) return { rows: [] };
    if (/FROM review_index ri/.test(sql) && /alreadyPaid/.test(sql)) return { rows: [{ reviewerName: '황민정', rowIndex: 45, alreadyPaid: false }] };
    if (/FROM payment_batch_items WHERE batch_id/.test(sql)) return { rows: [] };
    if (/INSERT INTO unconfirmed_transfer_reviews/.test(sql)) return { rows: [{ id: 'review-1', decision: 'APPROVED', result_seq: 8 }] };
    if (/UPDATE review_index SET is_submitted2 = 'PAID'/.test(sql)) return { rowCount: 1, rows: [] };
    if (/INSERT INTO payment_records/.test(sql)) return { rowCount: 1, rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  },
  release() {},
};

(async () => {
  await assert.rejects(
    svc.updateDuplicatePaymentCase({ caseId: 'not-a-uuid', caseStatus: 'CLOSED' }),
    err => err && err.code === 'bad_request',
    '잘못된 후속관리 식별자는 DB까지 전달하지 않아야 한다');
  svc.__setPoolForTest({ connect: async () => client });
  const out = await svc.reviewUnconfirmedTransfer({
    batchId: 'batch-1', uploadId: 'upload-1', memo: '테스트입금명', sheetId: 'sheet-1', tabName: '작업보드',
    resultSeq: 8, action: 'APPROVE', by: 'admin-test',
  });
  assert.equal(out.ok, true);
  assert.equal(out.review.decision, 'APPROVED');
  assert.ok(queries.some(sql => /INSERT INTO unconfirmed_transfer_reviews/.test(sql)), '대조 검토 이력을 남겨야 한다');
  assert.ok(queries.some(sql => /UPDATE review_index SET is_submitted2 = 'PAID'/.test(sql)),
    '승인한 참여자 행을 입금 완료 상태로 기록해야 한다');
  assert.ok(queries.some(sql => /INSERT INTO payment_records/.test(sql)),
    '승인한 참여자의 입금 이력을 기록해야 한다');
  assert.equal(approvedBoardItems.length, 1, '승인한 참여자 행의 입금 셀 기록을 요청해야 한다');
  assert.equal(approvedBoardItems[0].rowIndex, 45, '대조된 참여자 행에만 입금일을 기록해야 한다');
  assert.equal(out.board.recorded, 1, '입금 셀 기록 결과를 반환해야 한다');

  const duplicateQueries = [];
  const duplicateClient = {
    async query(sql) {
      duplicateQueries.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (/SELECT id, status FROM payment_batches/.test(sql)) return { rows: [{ id: 'batch-1', status: 'created' }] };
      if (/SELECT summary FROM payment_result_uploads/.test(sql)) return { rows: [{ summary: { preview: { unmatchedResults: [
        { seq: 9, memo: '테스트입금명', holder: '김윤경', amount: 20300, success: true },
      ] } } }] };
      if (/FROM unconfirmed_transfer_reviews WHERE upload_id/.test(sql)) return { rows: [] };
      if (/FROM review_index ri/.test(sql) && /alreadyPaid/.test(sql)) return { rows: [{ reviewerName: '김윤경', rowIndex: 50, alreadyPaid: true }] };
      if (/FROM payment_batch_items WHERE batch_id/.test(sql)) return { rows: [] };
      if (/INSERT INTO unconfirmed_transfer_reviews/.test(sql)) return { rows: [{ id: 'review-2', decision: 'DUPLICATE_CASE_OPENED', result_seq: 9 }] };
      if (/INSERT INTO duplicate_payment_cases/.test(sql)) return { rows: [{ id: '00000000-0000-4000-8000-000000000009', case_status: 'REFUND_REQUESTED' }] };
      if (/INSERT INTO duplicate_payment_case_events/.test(sql)) return { rows: [] };
      throw new Error(`unexpected duplicate query: ${sql.slice(0, 80)}`);
    },
    release() {},
  };
  svc.__setPoolForTest({ connect: async () => duplicateClient });
  const duplicate = await svc.reviewUnconfirmedTransfer({
    batchId: 'batch-1', uploadId: 'upload-1', memo: '테스트입금명', sheetId: 'sheet-1', tabName: '작업보드',
    resultSeq: 9, action: 'DUPLICATE', caseInfo: { resolutionType: 'REFUND', ownerName: '담당자', dueAt: '2026-08-21', memo: '환불 요청' }, by: 'admin-test',
  });
  assert.equal(duplicate.review.decision, 'DUPLICATE_CASE_OPENED');
  assert.equal(duplicate.duplicateCase.case_status, 'REFUND_REQUESTED');
  assert.ok(duplicateQueries.some(sql => /INSERT INTO duplicate_payment_case_events/.test(sql)), '후속관리 생성 이력이 필요하다');
  assert.ok(!duplicateQueries.some(sql => /UPDATE payment_batch_items|INSERT INTO payment_records/.test(sql)), '중복입금 처리도 입금기록을 만들면 안 된다');

  svc.__setPoolForTest({
    async query(sql) {
      if (/SELECT summary FROM payment_result_uploads/.test(sql)) return { rows: [{ summary: { preview: { unmatchedResults: [
        { seq: 10, memo: '테스트입금명', holder: '이체실패', amount: 20300, success: false },
      ] } } }] };
      if (/FROM unconfirmed_transfer_reviews WHERE upload_id/.test(sql)) return { rows: [] };
      if (/FROM review_index ri/.test(sql) && /alreadyPaid/.test(sql)) return { rows: [{ reviewerName: '이체실패', rowIndex: 51, alreadyPaid: false }] };
      if (/FROM payment_batch_items WHERE batch_id/.test(sql)) return { rows: [] };
      throw new Error(`unexpected failed-transfer query: ${sql.slice(0, 80)}`);
    },
  });
  const failedTransfer = await svc.inspectUnconfirmedWorkMatch({
    batchId: 'batch-1', uploadId: 'upload-1', memo: '테스트입금명', sheetId: 'sheet-1', tabName: '작업보드',
  });
  assert.equal(failedTransfer.results[0].state, 'transfer_not_confirmed',
    '성공으로 확인되지 않은 이체 결과는 승인 후보가 아니어야 한다');
  svc.__setPoolForTest(null);
  svc.__setPaymentApplyForTest(null);
  console.log('payment unconfirmed review tests passed');
})().catch(err => { svc.__setPoolForTest(null); svc.__setPaymentApplyForTest(null); throw err; });
