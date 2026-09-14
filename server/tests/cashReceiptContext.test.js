const assert = require('assert');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const svc = require('../src/services/cashReceiptContext.service');

(async () => {
  let calls = 0;
  svc.__setPoolForTest({ query: async (sql, params) => {
    calls++;
    assert.match(sql, /cash_receipt_required/);
    assert.deepStrictEqual(params, ['S1', 'T1']);
    return { rows: [{ cash_receipt_required: true }] };
  } });

  assert.strictEqual(await svc.cashReceiptRequiredForTab({ sheetId: 'S1', tabName: 'T1' }), true);
  assert.strictEqual(await svc.cashReceiptRequiredForTab({ sheetId: 'S1', tabName: 'T1' }), true);
  assert.strictEqual(calls, 1, '같은 탭은 캐시로 DB 왕복 1회');

  svc.__setPoolForTest({ query: async () => ({ rows: [] }) });
  assert.strictEqual(await svc.cashReceiptRequiredForTab({ sheetId: 'S2', tabName: 'T2' }), null);
  assert.strictEqual(await svc.cashReceiptRequiredForTab({}), null);

  calls = 0;
  svc.__setPoolForTest({ query: async (sql, params) => {
    calls++;
    assert.match(sql, /UNNEST\(\$1::text\[\], \$2::text\[\]\)/);
    assert.deepStrictEqual(params, [['S1', 'S2'], ['T1', 'T2']]);
    return { rows: [
      { sheet_id: 'S1', tab_name: 'T1', cash_receipt_required: true },
      { sheet_id: 'S2', tab_name: 'T2', cash_receipt_required: null },
    ] };
  } });
  const batch = await svc.cashReceiptRequirementsForTabs([
    { sheetId: 'S1', tabName: 'T1' }, { sheetId: 'S2', tabName: 'T2' },
    { sheetId: 'S1', tabName: 'T1' },
  ]);
  assert.strictEqual(batch.get('S1\u0000T1'), true);
  assert.strictEqual(batch.get('S2\u0000T2'), null);
  assert.strictEqual(calls, 1, '검색 결과 여러 작업은 DB 한 번에 일괄 조회');

  svc.__setPoolForTest(null);
  console.log('cashReceiptContext: 8 passed');
})().catch(e => { console.error(e); process.exit(1); });
