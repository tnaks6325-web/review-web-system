/**
 * 모집 정원을 채운 일반 주문이 빈 초과행을 만들지 않는지 확인한다.
 * 실행: node tests/sheetlessNoEmptyOverflow.test.js
 */
'use strict';

const assert = require('assert');
const orderSvc = require('../src/services/sheetlessOrder.service');
const ledgerSvc = require('../src/services/orderLedger.service');

async function run() {
  const originalLoad = ledgerSvc.loadRawTabContext;
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(text);
      if (/SELECT id, seq, row_json FROM campaign_participants/.test(text)) return { rows: [] };
      if (/FROM order_submissions/.test(text)) {
        return { rows: [{ source: 'reviewer', recipient: '일반주문', phone_digits: '01012345678' }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  ledgerSvc.loadRawTabContext = async () => ({ headers: ['수취인', '연락처'], tabGid: '1' });
  orderSvc.__setPoolForTest({ connect: async () => client });
  try {
    const result = await orderSvc.writeOrderToWorktable({
      sheetId: 'S', tabName: 'T', orderSubmissionId: '00000000-0000-0000-0000-000000000001',
      orderData: { recipient: '일반주문', phone: '010-1234-5678' },
    });
    assert.deepEqual(result, { ok: false, reason: 'no_open_slot' }, 'full ordinary worktable must reject without an overflow row');
    assert.ok(calls.includes('ROLLBACK'), 'ordinary no-slot write must roll back');
    assert.ok(!calls.some(q => /INSERT INTO campaign_participants/.test(q)), 'ordinary no-slot write must not create an empty overflow slot');
    assert.ok(!calls.some(q => /FROM tab_configs/.test(q)), 'only the confirmed external-manual exception may enter append preparation');
    console.log('sheetless no-empty-overflow checks passed');
  } finally {
    ledgerSvc.loadRawTabContext = originalLoad;
    orderSvc.__setPoolForTest(null);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
