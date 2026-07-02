// '쿠팡id' 미기록 수정 회귀가드 — mapOrderToSheetRow / _fieldToCol / _singleIdCol 이
//   단일 id열(쿠팡id·네이버id·id)은 채우고, NC(네이버+쿠팡) 2열·오탐은 안 채우는지 검증.
const assert = require('assert');
const { mapOrderToSheetRow, _fieldToCol, _singleIdCol } = require('../src/services/orderLedger.service');
const od = { userId: 'cpid123', orderer: 'Kim', recipient: 'Kim', phone: '010', address: 'A' };

// 실제 쿠팡 단일탭 — 쿠팡id 정확히 1개, 주문번호 오탐 없음
const coupang = ['번호','담당자','구매일자','용량','사이즈','인애드명단','주문번호','주문자제출','수취인','쿠팡id','연락처','주소','은행','계좌번호','예금주','결제금액','리뷰제출','입금','비고','택배송장'];
assert.equal(_singleIdCol(coupang), 9);
assert.equal(mapOrderToSheetRow(coupang, od)[9], 'cpid123');
assert.equal(mapOrderToSheetRow(coupang, od)[6], '');          // 주문번호 오탐 없음(orderNum 미제공 → '')
assert.equal(_fieldToCol(coupang, 'user_id'), 9);

// 네이버 단일탭('id') 무회귀
const naver = ['번호','주문자제출','수취인','id','연락처','주소'];
assert.equal(mapOrderToSheetRow(naver, od)[3], 'cpid123');
assert.equal(_fieldToCol(naver, 'user_id'), 3);

// NC 동시탭(네이버id+쿠팡id) → 둘 다 공란(무회귀)
const nc = ['주문자제출','수취인','네이버id','쿠팡id','연락처'];
assert.equal(_singleIdCol(nc), -1);
assert.equal(mapOrderToSheetRow(nc, od)[2], null);
assert.equal(mapOrderToSheetRow(nc, od)[3], null);
assert.equal(_fieldToCol(nc, 'user_id'), -1);

// 오탐 회피: 'paid'는 id 아님, 선점열(받는분id→수취인, 카톡id→admin), 메모열('비고(아이디확인)') 제외
assert.equal(_singleIdCol(['주문자제출','paid','쿠팡id']), 2);
assert.equal(_singleIdCol(['수취인','받는분id','id']), 2);          // 받는분id는 수취인 선점 → id 1개
assert.equal(_singleIdCol(['쿠팡id','비고(아이디확인)']), 0);        // 메모열 오탐 제외 → 쿠팡id 단일 유지
assert.equal(mapOrderToSheetRow(['쿠팡id','비고(아이디확인)'], od)[0], 'cpid123');

// 재발방지 #1: unmappedSubmittedFields — 제출값 있는데 넣을 열 못 찾은 필드 감지
const { unmappedSubmittedFields } = require('../src/services/orderLedger.service');
// 쿠팡 단일탭: 모든 필드 매핑됨 → 미매핑 없음(false positive 없음)
assert.deepEqual(unmappedSubmittedFields(coupang, { userId: 'x', phone: '010', recipient: 'K' }), []);
// id열 없는 탭 + userId 값 → user_id 미매핑 감지(조용한 누락 신호)
assert.deepEqual(unmappedSubmittedFields(['번호', '주문자제출', '연락처'], { userId: 'x' }), ['user_id']);
// NC(2 id열): user_id는 의도적 미기입이라 미보고(노이즈 억제)
assert.deepEqual(unmappedSubmittedFields(nc, { userId: 'x' }), []);
console.log('backfill-userid unit OK');
