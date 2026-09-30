'use strict';
const assert = require('assert');
const svc = require('../src/services/paymentResult.service');
const paymentApply = require('../src/services/paymentApply.service');

const BATCH_ID = '00000000-0000-0000-0000-000000000008';
const UPLOAD_ID = '00000000-0000-0000-0000-000000000010';
const ITEM_ID = '00000000-0000-0000-0000-000000000114';

function makeHarness({ failRecord = false, alreadyPaid = false } = {}) {
  const state = {
    item: {
      id: ITEM_ID, sheet_id: 'sheet-8', tab_name: '장수돌침대 900건', row_index: 457,
      reviewer_name: '원지웅', phone8: '91495907', bank_name: '토스뱅크',
      bank_account: '100190950172', account_holder: '원지웅', amount: 79000,
      status: 'failed', result_status: '결과 파일에 없음',
      fail_reason: '이체 실패 — 결과 파일에 해당 이체내역 없음', result_seq: null,
    },
    reconciliations: [], records: [], paidRows: [], transactionSnapshot: null,
    committed: 0, rolledBack: 0, released: 0, boardSaved: null,
  };
  const upload = { summary: { preview: { unmatchedResults: [{
    seq: 114, holder: '원지웅(모임통장)', amount: 79000, accountTail: '6895',
    transferredAt: '2026.08.18 17:15:00', success: true,
  }] } } };
  const clone = value => JSON.parse(JSON.stringify(value));
  const query = async (sql, params) => {
    const text = String(sql);
    if (text === 'BEGIN') {
      state.transactionSnapshot = clone({ item: state.item, reconciliations: state.reconciliations, records: state.records, paidRows: state.paidRows });
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') { state.transactionSnapshot = null; state.committed++; return { rows: [], rowCount: 0 }; }
    if (text === 'ROLLBACK') {
      const prior = state.transactionSnapshot;
      if (prior) Object.assign(state, prior);
      state.transactionSnapshot = null; state.rolledBack++;
      return { rows: [], rowCount: 0 };
    }
    if (/SELECT \* FROM payment_batches WHERE id/.test(text)) return { rows: [{ id: BATCH_ID, status: 'applied' }], rowCount: 1 };
    if (/SELECT summary FROM payment_result_uploads/.test(text)) return { rows: [upload], rowCount: 1 };
    if (/SELECT \* FROM payment_batch_items WHERE batch_id/.test(text)) return { rows: [state.item], rowCount: 1 };
    if (/SELECT COALESCE\(tc\.workboard_schema_version, 1\) AS schema_version/.test(text)) {
      return { rows: [{ schema_version: 1, is_submitted: false }], rowCount: 1 };
    }
    if (/SELECT ri\.is_submitted2 AS "isSubmitted2"/.test(text)) {
      return { rows: [{ isSubmitted2: alreadyPaid ? 'PAID' : 'NONE', hasPaymentRecord: false, hasPaidBatchItem: false }], rowCount: 1 };
    }
    if (/INSERT INTO payment_account_mismatch_reconciliations/.test(text)) {
      if (state.reconciliations.length) return { rows: [], rowCount: 0 };
      state.reconciliations.push({ itemId: params[3], resultSeq: params[2], by: params[7] });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE payment_batch_items[\s\S]*SET status = 'paid'/.test(text)) {
      if (state.item.status !== 'failed' || state.item.result_status !== '결과 파일에 없음') return { rows: [], rowCount: 0 };
      state.item.status = 'paid'; state.item.paid_at = params[1]; state.item.result_seq = params[2]; state.item.fail_reason = null;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE payment_result_uploads SET success_count = success_count \+ 1/.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE review_index SET is_submitted2 = 'PAID'/.test(text)) { state.paidRows.push(params); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO payment_records/.test(text)) {
      if (failRecord) throw new Error('forced payment record failure');
      state.records.push(params); return { rows: [], rowCount: 1 };
    }
    if (/SELECT submit_col2, tab_gid FROM review_index/.test(text)) return { rows: [{ submit_col2: 'col:입금', tab_gid: 'gid-8' }], rowCount: 1 };
    if (/UPDATE payment_batches SET board_recorded_count/.test(text)) { state.boardSaved = params; return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected query: ${text.slice(0, 100)}`);
  };
  const client = { query, release: () => { state.released++; } };
  return { state, pool: { query, connect: async () => client } };
}

async function run() {
  const originalMark = paymentApply.markDepositCells;
  const originalVerify = paymentApply.verifyDepositCells;
  paymentApply.markDepositCells = async () => ({ recorded: 1, queued: 0, skipped: 0, failed: 0 });
  paymentApply.verifyDepositCells = async () => ({ verified: 1, missing: 0 });
  try {
    const ok = makeHarness();
    svc.__setPoolForTest(ok.pool);
    const out = await svc.reconcileAccountMismatch({ batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 114, by: 'admin-test' });
    assert.equal(out.ok, true);
    assert.equal(ok.state.item.status, 'paid', '#8 대상은 paid로 전환되어야 한다');
    assert.equal(ok.state.reconciliations.length, 1, '감사 이력은 정확히 한 건이어야 한다');
    assert.equal(ok.state.records.length, 1, '입금 원장은 같은 트랜잭션에 한 건 기록되어야 한다');
    assert.equal(ok.state.paidRows.length, 1, '작업보드 원본 상태도 PAID로 기록되어야 한다');
    assert.equal(ok.state.committed, 1);
    assert.equal(ok.state.rolledBack, 0);
    assert.ok(ok.state.boardSaved, '작업보드 기록 결과가 회차에 저장되어야 한다');

    await assert.rejects(
      svc.reconcileAccountMismatch({ batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 114, by: 'admin-test' }),
      err => err && err.code === 'not_eligible',
      '같은 #8 결과 행은 두 번 성공 처리할 수 없어야 한다'
    );
    assert.equal(ok.state.reconciliations.length, 1, '중복 실행은 새 감사 이력을 만들면 안 된다');

    const alreadyPaid = makeHarness({ alreadyPaid: true });
    svc.__setPoolForTest(alreadyPaid.pool);
    await assert.rejects(
      svc.reconcileAccountMismatch({ batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 114, by: 'admin-test' }),
      err => err && err.code === 'already_paid',
      '기존 입금 기록이 있으면 수동 대조가 거부되어야 한다'
    );
    assert.equal(alreadyPaid.state.item.status, 'failed', '이미 입금된 행의 회차 상태를 다시 바꾸면 안 된다');
    assert.equal(alreadyPaid.state.reconciliations.length, 0, '이미 입금된 행에는 새 대조 이력을 만들면 안 된다');

    const fail = makeHarness({ failRecord: true });
    svc.__setPoolForTest(fail.pool);
    await assert.rejects(
      svc.reconcileAccountMismatch({ batchId: BATCH_ID, uploadId: UPLOAD_ID, itemId: ITEM_ID, resultSeq: 114, by: 'admin-test' }),
      /forced payment record failure/
    );
    assert.equal(fail.state.item.status, 'failed', '원장 기록 실패 시 성공 전환을 롤백해야 한다');
    assert.equal(fail.state.reconciliations.length, 0, '원장 기록 실패 시 감사 이력도 롤백해야 한다');
    assert.equal(fail.state.rolledBack, 1);
    console.log('payment account mismatch reconciliation transaction tests passed');
  } finally {
    svc.__setPoolForTest(null);
    paymentApply.markDepositCells = originalMark;
    paymentApply.verifyDepositCells = originalVerify;
  }
}

run().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
