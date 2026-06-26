const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasSubmittedOrderData,
  isAvailableOrderRow,
  selectOrderTargetRow,
  getOrderRowColumns,
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

test('"비고(닉네임 등 자유)" 컬럼은 인애드 컬럼으로 인식되지 않는다', () => {
  // 전용 인애드 컬럼이 없고 비고에 닉네임 키워드만 포함된 양식
  const optionOnlyHeaders = [
    '번호', '담당자', '구매일자', '옵션', '주문자제출', '수취인',
    '쿠팡id', '연락처', '주소', '은행', '계좌번호', '예금주',
    '결제금액', '리뷰제출', '입금', '주문번호', '비고(닉네임 등 자유)',
  ];
  const cols = getOrderRowColumns(optionOnlyHeaders);
  assert.equal(cols.inadColIdx, -1); // 비고는 인애드로 잡히지 않음
});

test('인애드 컬럼이 없으면 옵션 매칭으로 선택한 옵션의 빈 행에 누적된다', () => {
  const optionOnlyHeaders = [
    '번호', '담당자', '구매일자', '옵션', '주문자제출', '수취인',
    '쿠팡id', '연락처', '주소', '은행', '계좌번호', '예금주',
    '결제금액', '리뷰제출', '입금', '주문번호', '비고(닉네임 등 자유)',
  ];
  const row937 = ['1', '', '', '937,000원 짜리', '', '', '', '', '', '', '', '', '', '', '', '', ''];
  const row906 = ['2', '', '', '906,000원 짜리', '', '', '', '', '', '', '', '', '', '', '', '', ''];

  const result = selectOrderTargetRow({
    headers: optionOnlyHeaders,
    dataRows: [row937, row906],
    orderer: '홍길동',
    selectedOptKey: '906,000원 짜리',
  });

  assert.equal(result.matchType, 'option');
  assert.equal(result.emptyRowOffset, 1); // 906,000 행 선택
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
