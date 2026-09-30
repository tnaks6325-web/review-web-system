const assert = require('assert');
const fs = require('fs');
const path = require('path');

// RED: 삭제 확인창이 보여줄 수치는 한 행만 빼고, 총인원·제출·입금·결제금액을 함께 계산한다.
const { calculateOrderDeleteImpact } = require('../src/services/workdeskOrderDelete.service');

const impact = calculateOrderDeleteImpact(
  { total: 18, submitted: 12, paid: 10, paymentAmount: 132000 },
  { submitted: true, paid: true, price: '12,000원' },
);

assert.deepStrictEqual(impact.before, { total: 18, submitted: 12, paid: 10, paymentAmount: 132000 });
assert.deepStrictEqual(impact.after, { total: 17, submitted: 11, paid: 9, paymentAmount: 120000 });
assert.deepStrictEqual(impact.delta, { total: -1, submitted: -1, paid: -1, paymentAmount: -12000 });

const onlyOne = calculateOrderDeleteImpact(
  { total: 2, submitted: 2, paid: 0, paymentAmount: 20000 },
  { submitted: false, paid: false, price: '10,000' },
);
assert.strictEqual(onlyOne.after.total, 1, '동일 리뷰어의 다른 행은 남는다');
assert.strictEqual(onlyOne.after.paymentAmount, 10000);

const root = path.join(__dirname, '..');
const deleteService = fs.readFileSync(path.join(root, 'src/services/workdeskOrderDelete.service.js'), 'utf8');
const cancelService = fs.readFileSync(path.join(root, 'src/services/orderCancellation.service.js'), 'utf8');
const trackRoute = fs.readFileSync(path.join(root, 'src/routes/trackB.routes.js'), 'utf8');
const workdesk = fs.readFileSync(path.join(root, '..', 'frontend/workdesk.html'), 'utf8');

assert.match(deleteService, /WHERE id=\$1 AND sheet_id=\$2 AND tab_name=\$3 AND order_submission_id=\$5::uuid/,
  '삭제 대상은 선택한 행 ID와 주문 ID를 함께 대조한다');
assert.match(cancelService, /INSERT INTO sync_queue/, '시트 주문값 비우기 큐는 취소 트랜잭션 안에서 확정한다');
// ★ 2026-08 사용자 확정: 주문 삭제·번호 배정은 AE(staff)도 한다 — 게이트는 internal(광고주 차단).
assert.match(trackRoute, /\/workdesk\/order-delete-preview[\s\S]{0,180}authMiddleware, internalMiddleware/,
  '영향 미리보기도 내부 담당자 권한이 필요하다(광고주 차단)');
assert.match(trackRoute, /confirm !== true/, '확인 없는 삭제 요청은 서버에서 거부한다');
assert.match(workdesk, /같은 리뷰어의 다른 행은 남습니다/, '확인문이 한 행만 삭제됨을 명시한다');
const previewAt = workdesk.indexOf('order-delete-preview');
const confirmAt = workdesk.indexOf('confirm(message)', previewAt);
const deleteAt = workdesk.indexOf("'/api/trackb/workdesk/order-delete'", confirmAt);
assert.ok(previewAt >= 0 && confirmAt > previewAt && deleteAt > confirmAt,
  '화면은 미리보기 뒤 확인 후에만 삭제 API를 호출한다');

console.log('✓ workdesk one-row order delete impact');
