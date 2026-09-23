/**
 * 배송유형은 실배송·빈박스·택배발송대행 한 값으로 관리한다.
 * 실행: node tests/courierProxyDeliveryContract.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { LEGACY_DELIVERY_VALUES } = require('../src/utils/reviewType');

assert.deepStrictEqual(
  LEGACY_DELIVERY_VALUES,
  ['실배송', '빈박스', '택배발송대행'],
  '배송유형은 택배발송대행까지 단일 어휘로 관리한다'
);

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
assert.match(
  workOrderDetail,
  /WO_DELIVERY_MAP = \{ '실배송':'실배송', '빈박스':'빈박스', '택배발송대행':'택배발송대행' \}/
);
assert.match(
  workOrderDetail,
  /\{ v: "실배송", l: "실배송" \}, \{ v: "빈박스", l: "빈박스" \}, \{ v: "택배발송대행", l: "택배발송대행" \}/
);

const recruitModal = read('../frontend/js/recruit-modal.js');
assert.match(recruitModal, /<option value="택배발송대행">택배발송대행<\/option>/);
assert.doesNotMatch(recruitModal, /<option value="회수건">/);

console.log('courierProxyDeliveryContract: 12 passed');
