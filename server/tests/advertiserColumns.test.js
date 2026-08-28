/**
 * 광고주 작업보드 컬럼 차단 목록(_advertiserColumns) 회귀가드.
 * 원본 시트 컬럼은 순서 그대로 열고, 참여자·연락처·은행·계좌번호·예금주만 전송 전에 제외한다.
 * 실행: node tests/advertiserColumns.test.js
 */
const assert = require('node:assert/strict');
const { _advertiserColumns: advertiserColumns } = require('../src/services/trackB.service');

const headers = [
  '번호', '담당자', '참여자', '구매일자', '인애드명단', '색상', '사이즈', '주문번호',
  '주문자제출', '수취인', '쿠팡id', '연락처', '주소', '은행', '계좌번호', '예금주',
  '결제금액', '리뷰제출', '입금', '비고(닉네임)', '택배송장', '기타 안내',
];

assert.deepEqual(
  advertiserColumns(headers),
  ['번호', '담당자', '구매일자', '인애드명단', '색상', '사이즈', '주문번호', '주문자제출',
    '수취인', '쿠팡id', '주소', '결제금액', '리뷰제출', '입금', '비고(닉네임)', '택배송장', '기타 안내'],
  '원본 순서를 유지하며 다섯 차단 컬럼만 제외한다',
);

for (const blocked of ['참여자', '연락처', '은행', '계좌번호', '예금주']) {
  assert.ok(!advertiserColumns(headers).includes(blocked), `'${blocked}'는 광고주 데이터에서 제외한다`);
}

assert.deepEqual(advertiserColumns([
  '  참여자 ', ' 참여자명 ', ' 연락처 ', '전화번호', '핸드폰', '휴대폰', 'phone',
  '은행명', '입금은행', ' 계좌 번호 ', '계좌', '입금계좌', 'account', '예금주명', '비고',
]), ['비고'], '공백 차이와 실사용 별칭의 차단 헤더도 제외한다');
assert.deepEqual(advertiserColumns(['번호', '번호', 'id', '', null, '리뷰제출']), ['번호', '리뷰제출'],
  '빈 헤더·내부 id·중복은 표시하지 않는다');
assert.deepEqual(advertiserColumns(null), [], 'null 입력은 안전하게 빈 배열이다');

console.log('ADVERTISER COLUMN BLOCKLIST TESTS PASSED ✓');
