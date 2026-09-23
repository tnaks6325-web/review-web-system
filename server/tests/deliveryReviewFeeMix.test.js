/**
 * 혼합 배송별 리뷰비 회귀가드.
 * 실행: node tests/deliveryReviewFeeMix.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeDeliveryReviewFeeMix,
  validateDeliveryReviewFeeMix,
  resolveDeliveryReviewFee,
} = require('../src/utils/deliveryReviewFee');

const MIX = [{ type: 'real', reviewFee: 0 }, { type: 'empty', reviewFee: 1000 }];

const state = normalizeDeliveryReviewFeeMix(MIX);
assert.deepStrictEqual(state.mix, MIX, '0원도 설정값으로 보존한다');
assert.strictEqual(validateDeliveryReviewFeeMix('혼합', state, { requireWhenMixed: true }), null);
assert.match(
  validateDeliveryReviewFeeMix('혼합', normalizeDeliveryReviewFeeMix([{ type: 'real', reviewFee: 0 }]), { requireWhenMixed: true }),
  /실배송·빈박스/,
  '한 유형이 빠진 혼합 설정은 저장하지 않는다'
);
assert.strictEqual(resolveDeliveryReviewFee(MIX, '실배송', 999).fee, 0, '실배송: 결제금액만 입금');
assert.strictEqual(resolveDeliveryReviewFee(MIX, '빈박스', 0).fee, 1000, '빈박스: 설정 리뷰비를 더한다');
assert.strictEqual(resolveDeliveryReviewFee(MIX, '알 수 없음', 700).fee, 700, '행 유형이 불명확하면 기존 단일값 폴백');

// 새 혼합 공고는 유형별 설정을 신청·주문에 고정한다. 단일 구간표 스냅샷이 있어도
// 이 값을 우선해야 실배송/빈박스가 같은 금액으로 합쳐지지 않는다.
assert.deepStrictEqual(normalizeDeliveryReviewFeeMix(MIX).mix, MIX, '신청 스냅샷도 0원을 보존한다');

const payment = fs.readFileSync(path.join(__dirname, '../src/services/payment.service.js'), 'utf8');
assert.match(payment, /deliveryReviewFeeMixSnapshot/,
  '입금관리는 신청 시점 유형별 리뷰비 스냅샷을 읽는다');
assert.match(payment, /resolveDeliveryReviewFee\(deliveryFeeMix, deliveryKind, feeInfo\.fee\)/,
  '입금관리 산정은 작업표 배송구분별 리뷰비를 사용한다');
assert.match(payment, /delivery_review_fee_mix AS "deliveryReviewFeeMix"/,
  '캠페인 설정을 입금 대상 조회까지 운반한다');

const front = fs.readFileSync(path.join(__dirname, '../../frontend/js/index-recruit.js'), 'utf8');
assert.match(front, /const hasDeliveryReviewFee = realReviewFee !== "" \|\| emptyReviewFee !== ""/,
  '비어 있는 유형별 입력은 0원 매핑으로 보내지 않는다');
assert.match(front, /feeRow && hasDeliveryReviewFee/,
  '유형별 금액을 실제 입력했을 때만 저장한다');

const hold = fs.readFileSync(path.join(__dirname, '../src/services/campaignHold.service.js'), 'utf8');
assert.match(hold, /delivery_review_fee_mix_snapshot = COALESCE\(os\.delivery_review_fee_mix_snapshot, ca\.delivery_review_fee_mix_snapshot\)/,
  '신청 시점 유형별 설정을 주문 원장으로 전파한다');

console.log('✅ deliveryReviewFeeMix: 전부 통과');
