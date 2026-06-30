/**
 * PR-B 백엔드 검증 — 취소 안전가드(R1) + 편집 필드매핑 헬퍼
 *   rowIdentityMatches: 시트 행이 "여전히 이 주문의 것"인지 다중칸 AND 일치로 판정.
 *     - 일치 → {match:true} (클리어 허용)
 *     - 수취인만 다른 재기입자 → {match:false,gridOutOfRange:false} (클리어 거부 = R1 데이터파괴 방지)
 *     - 그리드밖 빈읽기 → {match:false,gridOutOfRange:true} (사람 손 불가 → 호출부가 클리어 진행)
 * 실행: node tests/orderLedgerPRB.test.js
 */
const assert = require('assert');

// sheets.service / sheetsThrottle를 require.cache로 모킹(rowIdentityMatches가 호출시점 inline require).
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

  const tabContext = { headers, tabName: 'Orders', tabGid: '123' };
  const osBase = { sheet_id: 's1', sheet_row: 10, recipient: '홍길동', phone: '010-1111-2222', address: '서울시' };

  // (a) 3칸 일치 → match
  _readReturn = [['홍길동', '01011112222', '서울시']]; // B10:D10 = [수취인,연락처,주소]
  let r = await ledger.rowIdentityMatches(osBase, tabContext);
  assert.deepEqual(r, { match: true, gridOutOfRange: false });
  console.log('  rowIdentityMatches (a) 일치 → match:true');

  // (b) 수취인만 다른 재기입자 → match:false (클리어 거부)
  _readReturn = [['김철수', '01011112222', '서울시']];
  r = await ledger.rowIdentityMatches(osBase, tabContext);
  assert.deepEqual(r, { match: false, gridOutOfRange: false }, 'R1: 사람 재사용행은 클리어 거부');
  console.log('  rowIdentityMatches (b) 수취인 불일치 → match:false (R1 파괴방지)');

  // (c) 연락처 일치+주소 불일치 → AND라 match:false
  _readReturn = [['홍길동', '01011112222', '부산시']];
  r = await ledger.rowIdentityMatches(osBase, tabContext);
  assert.equal(r.match, false, '한 칸이라도 다르면 불일치(AND)');
  console.log('  rowIdentityMatches (c) 주소 불일치 → match:false');

  // (d) 그리드밖 빈읽기 → gridOutOfRange:true (호출부가 클리어 진행)
  _readReturn = [];
  r = await ledger.rowIdentityMatches(osBase, tabContext);
  assert.deepEqual(r, { match: false, gridOutOfRange: true }, 'J-2: 그리드밖=사람 손 불가');
  console.log('  rowIdentityMatches (d) 빈읽기 → gridOutOfRange:true');
}

run()
  .then(() => console.log('orderLedger PR-B tests passed'))
  .catch((err) => { console.error(err); process.exit(1); });
