'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateRows, mapOrderToSheetRow } = require('../src/services/orderLedger.service');

const headers = ['번호', '구매일자', '상품', '1차옵션', '2차옵션', '수취인', '연락처', '주소'];
const selectedOptKey = '티셔츠 · 화이트 · 105';

test('단계형 선택키는 사전 기입된 상품·1차·2차 행을 정확히 찾는다', () => {
  const picked = buildCandidateRows({
    headers, headerRowIndex: 1,
    dataRows: [{ rowIndex: 2, cells: ['1', '8 / 27 (목)', '티셔츠', '화이트', '105', '', '', ''] }],
    orderData: { selectedOptKey },
  });
  assert.deepEqual(picked.slice(0, 1), [2]);
});

test('단계형 선택키는 각 전용 열에만 해당 값을 쓴다', () => {
  const row = mapOrderToSheetRow(headers, { selectedOptKey });
  assert.equal(row[2], '티셔츠');
  assert.equal(row[3], '화이트');
  assert.equal(row[4], '105');
});
