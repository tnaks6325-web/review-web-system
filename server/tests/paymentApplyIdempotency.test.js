'use strict';

const assert = require('assert');
const { recordDeposits } = require('../src/services/paymentApply.service');

async function run() {
  let isPaid = false;
  let records = 0;
  const client = {
    async query(sql) {
      if (/UPDATE review_index SET is_submitted2 = 'PAID'/.test(sql)) {
        const isConditional = /IS DISTINCT FROM 'PAID'/.test(sql);
        if (isPaid && isConditional) return { rowCount: 0, rows: [] };
        isPaid = true;
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO payment_records/.test(sql)) {
        records += 1;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const item = { sheetId: 'sheet-8', tabName: '장수돌침대 900건', rowIndex: 457, reviewerName: '원지웅', amount: '78000' };

  const firstRecorded = [];
  const retryRecorded = [];
  assert.equal(await recordDeposits(client, [item], { by: 'admin', appliedItems: firstRecorded }), 1);
  assert.deepEqual(firstRecorded, [item], '새 입금 처리된 행만 작업보드 기록 대상으로 넘긴다');
  assert.equal(await recordDeposits(client, [item], { by: 'admin', appliedItems: retryRecorded }), 0,
    '다른 입금 경로가 먼저 처리했으면 두 번째 기록은 건너뛴다');
  assert.deepEqual(retryRecorded, [], '재시도·경합으로 건너뛴 행은 작업보드에 다시 기록하지 않는다');
  assert.equal(records, 1, '같은 작업 행의 payment_records는 한 번만 생성한다');
  console.log('payment apply idempotency tests passed');
}

run().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
