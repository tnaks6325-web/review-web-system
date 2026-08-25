// 8번 확장: 목록도 카드에서 즉시 쓸 상세 현재값을 가산적으로 내려준다.
// 상세 단건 조회가 실패해도 긴 필드가 과거 원본 스냅샷으로 되살아나지 않게 한다.
const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../src/routes/order.routes'), 'utf8');
const routeStart = source.indexOf("router.get('/intake/list'");
const routeEnd = source.indexOf("router.get('/intake/:id'", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'intake/list 라우트를 찾지 못했다');
const listRoute = source.slice(routeStart, routeEnd);

for (const field of [
  'review_guide', 'special_notes', 'inflow_guide', 'product_url',
  'purchase_time', 'delivery_type', 'review_type', 'pay_amount', 'daily_count',
]) {
  assert.match(listRoute, new RegExp(`\\b${field}\\b`), `intake/list SELECT에 ${field}가 없다`);
}

console.log('ok - intake/list returns live long-form order fields for Inadd cards');
