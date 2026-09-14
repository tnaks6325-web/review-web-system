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

  svc.__setPoolForTest({ query: async (sql, params) => {
    assert.match(sql, /provenance AS[\s\S]*campaign_application_id[\s\S]*BOOL_OR\(rc\.cash_receipt_required\)/,
      '지급 행은 주문·신청 출처의 공고를 먼저 판정해야 한다');
    assert.deepStrictEqual(params, [['S1', 'S1'], ['T1', 'T1'], [10, 11]]);
    return { rows: [
      // 같은 탭의 다른 공고가 true여도 이 행의 단일 출처 공고가 false면 비대상이다.
      { sheet_id: 'S1', tab_name: 'T1', row_index: 10, cash_receipt_required: false, resolution: 'exact' },
      // 출처가 여러 개거나 없으면 연결 공고 중 true 하나라도 있으면 보류 쪽으로 닫는다.
      { sheet_id: 'S1', tab_name: 'T1', row_index: 11, cash_receipt_required: true, resolution: 'ambiguous_tab' },
    ] };
  } });
  const byRow = await svc.cashReceiptRequirementsForRows([
    { sheetId: 'S1', tabName: 'T1', rowIndex: 10 },
    { sheetId: 'S1', tabName: 'T1', rowIndex: 11 },
  ], { strict: true });
  assert.strictEqual(byRow.get('S1\u0000T1\u000010'), false);
  assert.strictEqual(byRow.get('S1\u0000T1\u000011'), true);

  svc.__setPoolForTest(null);
  console.log('cashReceiptContext: 12 passed');
})().catch(e => { console.error(e); process.exit(1); });
