/**
 * PR-B 백엔드 검증 — 편집 필드매핑 헬퍼 (취소 안전가드 R1 rowIdentityMatches 는 결정 274 로 제거 — 부재만 본다)
 *   (rowIdentityMatches — 시트 행 신원 재확인 — 는 시트 쓰기 실행부와 함께 결정 274 로 제거. 부재만 본다.)
 * 실행: node tests/orderLedgerPRB.test.js
 */
const assert = require('assert');

// sheets.service / sheetsThrottle를 require.cache로 모킹(혹시 남은 시트 호출이 실제 구글로 나가지 않게).
let _readReturn = [['홍길동', '01011112222', '서울시']];
function mockModule(relId, exportsObj) {
  const resolved = require.resolve(relId);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
mockModule('../src/services/sheets.service', {
  readSheet: async () => _readReturn,
  invalidateSheetMeta: () => {},
});
mockModule('../src/utils/sheetsThrottle', {
  throttledCall: async (fn) => fn(),
});

const ledger = require('../src/services/orderLedger.service');

async function run() {
  // ── 헬퍼: _osRowToOrderData ──
  const od = ledger._osRowToOrderData({ orderer: 'A', recipient: 'B', user_id: 'u', phone: 'p', address: 'addr',
    order_num: 'n', date_str: 'd', selected_opt_key: 'o', bank: 'bk', account: 'ac', depositor: 'dp', price: '1', memo: 'm' });
  assert.equal(od.userId, 'u'); assert.equal(od.orderNum, 'n'); assert.equal(od.dateStr, 'd');
  assert.equal(od.selectedOptKey, 'o'); assert.equal(od.recipient, 'B');
  console.log('  _osRowToOrderData ok');

  // ── 헬퍼: _fieldToCol ──
  const headers = ['번호', '수취인', '연락처', '주소', '비고'];
  assert.equal(ledger._fieldToCol(headers, 'recipient'), 1);
  assert.equal(ledger._fieldToCol(headers, 'phone'), 2);
  assert.equal(ledger._fieldToCol(headers, 'address'), 3);
  assert.equal(ledger._fieldToCol(headers, 'memo'), 4);
  assert.equal(ledger._fieldToCol(headers, 'bank'), -1); // 헤더에 은행 컬럼 없음
  assert.equal(ledger._fieldToCol(headers, 'nope'), -1);
  console.log('  _fieldToCol ok');

  // (rowIdentityMatches — 시트 행 신원 재확인 — 단언 4건은 그 유일한 소비처인 큐 실행부 order_update·order_cancel 과 함께
  //  결정 274 로 제거됐다. 시트 셀을 비우거나 고치는 경로 자체가 없으니 재확인할 대상도 없다.)
  assert.equal(typeof ledger.rowIdentityMatches, 'undefined', '시트 행 신원 재확인이 되살아났다 — 시트 쓰기 실행부가 다시 생겼는지 확인');
}

run()
  .then(() => console.log('orderLedger PR-B tests passed'))
  .catch((err) => { console.error(err); process.exit(1); });
