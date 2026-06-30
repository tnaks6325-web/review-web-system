/**
 * PR-A(경화) 검증 — 취소건 부활 차단 가드
 *   reconcileStuckOrders SELECT에 `os.deleted_at IS NULL` 가드가 포함되는지(소프트취소 주문이
 *   자동복구로 다시 시트에 써져 부활하지 않게).
 * 실행: node tests/orderLedgerPRA.test.js
 */
const assert = require('assert');
const ledger = require('../src/services/orderLedger.service');

async function run() {
  const captured = [];
  const fakePool = {
    query: async (sql) => {
      captured.push(sql);
      return { rows: [] }; // 메인 SELECT 포함 모두 빈 결과 → scanned 0
    },
    connect: async () => { throw new Error('dryRun에서 connect 금지'); },
  };
  ledger.__setPoolForTest(fakePool);
  try {
    const r = await ledger.reconcileStuckOrders({ dryRun: true, limit: 10 });
    assert.equal(r.scanned, 0);
    const mainSelect = captured.find(s => s.includes('FROM order_submissions os'));
    assert.ok(mainSelect, 'reconcile 메인 SELECT가 실행됨');
    assert.ok(/os\.deleted_at\s+IS\s+NULL/.test(mainSelect),
      '★ reconcile SELECT에 os.deleted_at IS NULL 가드 필수(취소건 부활 차단)');
    console.log('  PR-A ok — reconcile에 deleted_at IS NULL 가드 존재');
  } finally {
    ledger.__setPoolForTest(null);
  }
}

run()
  .then(() => console.log('orderLedger PR-A tests passed'))
  .catch((err) => { console.error(err); process.exit(1); });
