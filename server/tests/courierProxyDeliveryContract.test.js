/**
 * 배송유형은 **5종**으로 관리한다 — 실배송·빈박스·택배발송대행·회수·혼합(사용자 확정 2026-08-24).
 *
 * ★★ 어휘 목록(`DELIVERY_TYPES`)과 `LEGACY_DELIVERY_VALUES` 를 **합치지 않는다**:
 *   후자는 어휘가 아니라 '리뷰타입 칸에 잘못 들어간 배송유형 판별 목록'이고,
 *   `혼합` 은 **정상 리뷰타입 값**이라 넣는 순간 접수 업서트가 멀쩡한 혼합 리뷰 탭의
 *   리뷰타입을 갈아치운다(2026-08-06 이노크아든 사고의 거울상).
 * 실행: node tests/courierProxyDeliveryContract.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { LEGACY_DELIVERY_VALUES } = require('../src/utils/reviewType');
const { DELIVERY_TYPES, deliveryBaseType, canonicalDeliveryValue } = require('../src/utils/deliveryType');

assert.deepStrictEqual(
  DELIVERY_TYPES,
  ['실배송', '빈박스', '택배발송대행', '회수', '혼합'],
  '배송유형 어휘는 5종 단일 출처'
);
assert.deepStrictEqual(
  LEGACY_DELIVERY_VALUES,
  ['실배송', '빈박스', '택배발송대행'],
  '리뷰타입 칸 오염 판별 목록은 3종 그대로 — 어휘 목록과 합치지 않는다'
);
assert.ok(
  !LEGACY_DELIVERY_VALUES.includes('혼합'),
  '★ 혼합은 정상 리뷰타입 값 — 오염 판별 목록에 들어가면 접수가 멀쩡한 혼합 리뷰 탭을 파괴한다'
);

// 회수·혼합은 부속정보가 붙은 **문장**으로 온다 — 기본형으로 접되 원문은 보존한다.
assert.strictEqual(deliveryBaseType('회수(회수택배사: CJ대한통운, 회수상품명칭: A)'), '회수');
assert.strictEqual(deliveryBaseType('혼합(실배송 20건, 빈박스 80건)'), '혼합');
assert.strictEqual(canonicalDeliveryValue('회수(회수택배사: CJ대한통운)'), '회수(회수택배사: CJ대한통운)',
  '부속정보가 있으면 원문 보존 — 기본형만 남기면 회수택배사가 증발한다');
assert.strictEqual(canonicalDeliveryValue('회수건'), '회수', '옛 표기는 맨 토큰일 때만 접는다');
assert.strictEqual(canonicalDeliveryValue('빈택배'), '빈박스');
assert.strictEqual(canonicalDeliveryValue('기타배송(박스)'), '기타배송(박스)', '판정 불가값은 원문 통과');

const orderRoutes = read('src/routes/order.routes.js');
assert.match(orderRoutes, /function _canonicalDeliveryType/);
assert.match(orderRoutes, /function _courierProxyFromDelivery/);
assert.match(orderRoutes, /_canonicalDeliveryType\(b\.delivery_type, b\.courier_proxy\)/);

const intakePatch = orderRoutes.slice(
  orderRoutes.indexOf('async function _intakeUpdateHandler'),
  orderRoutes.indexOf("router.route('/intake/:id')")
);
assert.match(intakePatch, /SELECT id, status, deleted_at, delivery_type, courier_proxy/);
assert.match(intakePatch, /if \(b\.delivery_type !== undefined \|\| b\.courier_proxy !== undefined\)/);
assert.match(intakePatch, /_canonicalDeliveryType\([\s\S]{0,140}cur\[0\]\.delivery_type/);
assert.match(intakePatch, /b\.courier_proxy = _courierProxyFromDelivery/);

const aeUpdate = orderRoutes.slice(
  orderRoutes.indexOf("router.put('/my/update'"),
  orderRoutes.indexOf("// ═══════════════════════════════════════════════════════════", orderRoutes.indexOf("router.put('/my/update'") + 1)
);
assert.match(aeUpdate, /SELECT created_by, status, delivery_type, courier_proxy/);
assert.match(aeUpdate, /if \(b\.delivery_type !== undefined \|\| b\.courier_proxy !== undefined\)/);
assert.match(aeUpdate, /const deliveryType = _canonicalDeliveryType/);
assert.match(aeUpdate, /b\.delivery_type = deliveryType/);

const workOrderDetail = read('../frontend/js/work-order-detail.js');
// 프론트 어휘는 서버 DELIVERY_TYPES 의 최소 사본 — 값·순서가 어긋나면 화면과 판정이 갈린다.
const frontTypes = workOrderDetail.match(/const WO_DELIVERY_TYPES = \[([^\]]*)\]/);
assert.ok(frontTypes, 'WO_DELIVERY_TYPES 선언');
assert.deepStrictEqual(
  frontTypes[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean),
  DELIVERY_TYPES,
  '프론트 배송유형 어휘 ≡ 서버 DELIVERY_TYPES(사본 드리프트 금지)'
);
assert.match(workOrderDetail, /delivery_type: _woDeliveryBase\(o\.delivery_type\)/,
  '공고 프리필은 기본형으로 접는다 — 정확일치 맵은 문장을 못 받아 값을 통째로 버렸다');
assert.match(workOrderDetail, /recall_courier: o\.recall_courier/,
  '회수 부속정보도 프리필에 실어 보낸다');
assert.match(workOrderDetail, /pills\(c2, "delivery_type", "배송유형", WO_DELIVERY_TYPES/,
  '관리자 수정 칩도 같은 목록에서 만든다(사본 금지)');

const recruitModal = read('../frontend/js/recruit-modal.js');
DELIVERY_TYPES.forEach((v) => {
  assert.ok(recruitModal.includes('<option value="' + v + '">' + v + '</option>'),
    '모집공고 모달 선택지: ' + v);
  assert.ok(recruitModal.includes('data-rf-delivery="' + v + '"'), '모집공고 모달 토글: ' + v);
});
// ★ 옛 어휘는 되살리지 않는다 — 저장되면 현행 모달 select 에 없어 조용히 지워진다.
[
  ['../frontend/js/recruit-modal.js', recruitModal],
  ['../frontend/js/campaign-cards.js', read('../frontend/js/campaign-cards.js')],
  ['../frontend/admin-siand.html', read('../frontend/admin-siand.html')],
].forEach(([name, src]) => {
  assert.doesNotMatch(src, /<option value="회수건">/, name + ' 에 옛 어휘 회수건이 남으면 안 된다');
  assert.doesNotMatch(src, /<option value="빈택배">/, name + ' 에 옛 어휘 빈택배가 남으면 안 된다');
});

console.log('courierProxyDeliveryContract: 배송유형 5종 계약 통과');
