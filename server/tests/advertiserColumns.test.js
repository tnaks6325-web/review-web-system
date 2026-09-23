/**
 * 광고주 노출 컬럼 화이트리스트(_advertiserColumns) 회귀가드.
 *   핵심 불변식: 은행/계좌번호/예금주 등 화이트리스트 외 컬럼은 절대 포함 안 됨(데이터 최소화 = 외부 유출 방지).
 *   매핑: 개념→시트헤더 키워드(쿠팡id/네이버아이디→ID, 리뷰제출→리뷰제출일, 입금→입금일), 요청 순서 유지, 개념당 1개.
 * 실행: node tests/advertiserColumns.test.js
 */
const assert = require('assert');
const svc = require('../src/services/trackB.service');
const advCols = svc._advertiserColumns;

function run() {
  // 1) 쿠팡 시트(실 헤더) — 화이트리스트 10개 매핑 + 민감컬럼 제외
  const coupang = ['번호','담당자','구매일자','인애드명단','색상','사이즈','주문번호','주문자제출','수취인','쿠팡id','연락처','주소','은행','계좌번호','예금주','결제금액','리뷰제출','입금','비고(닉네임)'];
  const out1 = advCols(coupang);
  assert.deepEqual(out1, ['번호','구매일자','주문번호','수취인','쿠팡id','연락처','주소','결제금액','리뷰제출','입금'],
    '1: 쿠팡 시트 → 화이트리스트 10개(순서 유지, 쿠팡id→ID·리뷰제출→리뷰제출일·입금→입금일)');
  // ★ 데이터 최소화 불변식: 민감/비대상 컬럼은 절대 미포함
  for (const banned of ['은행','계좌번호','예금주','담당자','인애드명단','색상','사이즈','주문자제출','비고(닉네임)']) {
    assert.ok(!out1.includes(banned), `1: '${banned}' 제외(외부 유출 방지)`);
  }
  console.log('  1. 쿠팡 시트 매핑 + 민감컬럼 제외 ✓');

  // 2) 네이버 시트 변형(네이버아이디·리뷰제출일·입금일 리터럴)
  const naver = ['번호','구매일자','주문번호','수취인','네이버아이디','연락처','주소','은행','계좌번호','예금주','결제금액','리뷰제출일','입금일','비고'];
  const out2 = advCols(naver);
  assert.deepEqual(out2, ['번호','구매일자','주문번호','수취인','네이버아이디','연락처','주소','결제금액','리뷰제출일','입금일'],
    '2: 네이버 변형 → 네이버아이디→ID, 리뷰제출일/입금일 리터럴 매칭');
  for (const banned of ['은행','계좌번호','예금주','비고']) assert.ok(!out2.includes(banned), `2: '${banned}' 제외`);
  console.log('  2. 네이버 변형 매핑 ✓');

  // 3) 개념 누락 시 생략(크래시 없음) + 개념당 1개(중복 헤더 재사용 안 함)
  const partial = ['번호','수취인','주소','기타','기타2'];
  assert.deepEqual(advCols(partial), ['번호','수취인','주소'], '3: 매칭되는 개념만(누락은 생략)');
  assert.deepEqual(advCols([]), [], '3: 빈 입력 → []');
  assert.deepEqual(advCols(null), [], '3: null → []');
  console.log('  3. 부분/빈 입력 안전 ✓');

  // 배송 대행 탭의 송장 번호는 광고주가 배송 상태를 확인하는 데 필요한 업무 데이터다.
  const tracking = advCols(['번호', '주문번호', '택배송장', '비고']);
  assert.deepEqual(tracking, ['번호', '주문번호', '택배송장'],
    '3a: 택배송장 열을 광고주 뷰어에 포함한다');
  console.log('  3a. 택배송장 열 노출 ✓');

  // 3b) ★유출 방지: '입금'이지만 계좌/은행/입금자명/자유텍스트 컬럼은 입금일로 오매칭 안 함(계좌·이름·정보 유출 차단)
  assert.deepEqual(advCols(['입금일','입금계좌','입금은행','입금자명']), ['입금일'], '3b: 입금일만 · 입금계좌/입금은행/입금자명 제외');
  assert.deepEqual(advCols(['입금']), ['입금'], '3b: 단독 입금(시트 관행=입금일) 매칭');
  assert.deepEqual(advCols(['입금완료']), ['입금완료'], '3b: 입금완료(상태) 매칭');
  assert.deepEqual(advCols(['입금완료일']), ['입금완료일'], '3b: 입금완료일(날짜) 매칭');
  // 예금주명/입금자명 계열(입금자·입금명·입금정보·입금메모·입금주)은 절대 미노출 — 리뷰 지적(depositor name/free-text PII)
  for (const banned of ['입금자','입금명','입금정보','입금메모','입금주','입금액','입금계좌번호']) {
    assert.deepEqual(advCols([banned]), [], `3b: '${banned}' 는 입금일로 오매칭 안 됨(이름/계좌/자유텍스트 유출 차단)`);
  }
  console.log('  3b. 입금 계좌/이름/자유텍스트 유출 방지 ✓');

  // 4) '번호'는 정확일치(주문번호·계좌번호를 번호로 오매칭 안 함)
  const only = advCols(['주문번호','계좌번호']);
  assert.ok(!only.includes('계좌번호'), '4: 계좌번호는 번호/주문번호로 오매칭 안 됨(제외)');
  assert.deepEqual(only, ['주문번호'], '4: 주문번호만(번호 개념은 정확일치라 미매칭)');
  console.log('  4. 번호 정확일치(계좌번호 오매칭 방지) ✓');

  // 5) 공백·대소문 정규화(트림)
  const spaced = advCols([' 번호 ', '쿠팡ID', ' 연락처']);
  assert.ok(spaced.includes(' 번호 ') || spaced.includes('번호'), '5: 트림 후 번호 매칭');
  assert.ok(spaced.some(h => /쿠팡ID/i.test(h)), '5: 쿠팡ID(대문자) → ID 매칭');
  console.log('  5. 공백/대소문 정규화 ✓');

  console.log('ALL ADVERTISER COLUMN TESTS PASSED ✓');
}
run();
