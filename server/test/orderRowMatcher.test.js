const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasSubmittedOrderData,
  isAvailableOrderRow,
  selectOrderTargetRow,
} = require('../src/services/orderRowMatcher.service');

const headers = [
  '번호', '담당자', '구매일자', '용량', '사이즈', '인애드명단',
  '주문번호', '주문자제출', '수취인', 'id', '연락처', '주소',
  '은행', '계좌번호', '예금주', '결제금액', '리뷰제출', '입금',
  '비고(닉네임)', '택배송장(롯데택배)',
];

test('prepared rows with many preset values are still available for order input', () => {
  const preparedOsuji = [
    '17', '만두', ' 6 / 26 (금)', '500g', '14mm(상)', '오수지',
    '', '', '', '', '', '',
    '', '', '', '18800', '', '', '전체입금', '',
  ];

  const result = selectOrderTargetRow({
    headers,
    dataRows: [preparedOsuji],
    orderer: '오수지',
    selectedOptKey: '500g|14mm(상)',
  });

  assert.equal(hasSubmittedOrderData(preparedOsuji, result.columns), false);
  assert.equal(isAvailableOrderRow(preparedOsuji, result.columns), true);
  assert.equal(result.emptyRowOffset, 0);
  assert.equal(result.matchType, 'inad');
});

test('submitted rows are skipped and the matching prepared row is selected', () => {
  const submittedPark = [
    '15', '만두', ' 6 / 26 (금)', '500g', '14mm(상)', '박재선',
    '2026062684714901', '박재선', '박재선', 'zzangwotjs', '010-6398-9261',
    '서울시 동작구 국사봉길 109-11, 203호', '국민은행', '9-6398926151',
    '박재선', '18800', '', '', '전체입금', '260863076633',
  ];
  const preparedCha = [
    '19', '만두', ' 6 / 26 (금)', '500g', '14mm(상)', '차세희',
    '', '', '', '', '', '',
    '', '', '', '18800', '', '', '전체입금', '',
  ];

  const result = selectOrderTargetRow({
    headers,
    dataRows: [submittedPark, preparedCha],
    orderer: '차세희',
    selectedOptKey: '500g|14mm(상)',
  });

  assert.equal(result.emptyRowOffset, 1);
  assert.equal(result.matchType, 'inad');
});

test('appends only after all prepared rows contain submitted order data', () => {
  const submittedOsuji = [
    '17', '만두', ' 6 / 26 (금)', '500g', '14mm(상)', '오수지',
    '2026062684803771', '오수지', '오수지', 'osg1604', '010-4913-5306',
    '강원특별자치도 원주시 단구로 424', '국민', '954202-00-026596',
    '오수지', '18800', '', '', '전체입금', '260863076655',
  ];

  const result = selectOrderTargetRow({
    headers,
    dataRows: [submittedOsuji],
    orderer: '새제출자',
    selectedOptKey: '500g|14mm(상)',
  });

  assert.equal(result.emptyRowOffset, 1);
  assert.equal(result.matchType, 'append');
});
