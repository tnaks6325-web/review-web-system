// 8번 확장: 목록에는 카드 첫 화면에서 자주 보는 짧은 현재값만 가산한다.
// 긴 가이드·HTML은 /intake/:id 상세 조회 전용이라 200행 폴링 응답을 키우지 않는다.
const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../src/routes/order.routes'), 'utf8');
const routeStart = source.indexOf("router.get('/intake/list'");
const routeEnd = source.indexOf("router.get('/intake/:id'", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'intake/list 라우트를 찾지 못했다');
const listRoute = source.slice(routeStart, routeEnd);

for (const field of ['purchase_time', 'delivery_type', 'review_type', 'pay_amount', 'daily_count']) {
  assert.match(listRoute, new RegExp(`\\b${field}\\b`), `intake/list SELECT에 ${field}가 없다`);
}

const selectPart = listRoute.slice(listRoute.indexOf('SELECT '), listRoute.indexOf('FROM work_orders'));
for (const field of ['review_guide', 'special_notes', 'inflow_guide', 'product_url']) {
  assert.doesNotMatch(selectPart, new RegExp(`\\b${field}\\b`), `긴 필드 ${field}는 intake/list에 실으면 안 된다`);
}

console.log('ok - intake/list returns live long-form order fields for Inadd cards');
