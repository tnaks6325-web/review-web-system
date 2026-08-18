const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const svc = require('../src/services/trackB.service');
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const front = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('\n번호 없는 주문행 → 유효 슬롯 재배정 회귀가드');
t('번호 열만 인식하며 공란은 번호 없음으로 판정', () => {
  assert.strictEqual(svc.__displayNumberForTest({ 번호: '' }), '');
  assert.strictEqual(svc.__displayNumberForTest({ '번호': 601 }), '601');
  assert.strictEqual(svc.__displayNumberForTest({ 상품명: '번호 없는 상품' }), '');
});
t('주문값은 옮기되 유효 슬롯 번호는 보존', () => {
  const row = svc.__mergeUnslottedOrderRowForTest(
    { 번호: '601', 담당자: '만두', 구매일자: '' },
    { 번호: '', 주문자제출: '임은진', 결제금액: '78000' }, 601);
  assert.deepStrictEqual(row, { 번호: '601', 담당자: '만두', 구매일자: '', 주문자제출: '임은진', 결제금액: '78000' });
});
t('서버는 목표 안의 빈 슬롯만 FOR UPDATE로 선택', () => {
  const src = svc.assignUnslottedOrderToOpenSlot.toString();
  assert.match(src, /seq BETWEEN 1 AND \$3/);
  assert.match(src, /order_submission_id IS NULL/);
  assert.match(src, /FOR UPDATE SKIP LOCKED/);
  assert.match(src, /deleted_at=NOW\(\), active=FALSE/);
});
t('관리자 확인을 요구하는 재배정 라우트와 화면 실행 경로가 있다', () => {
  assert.match(route, /\/workdesk\/assign-unslotted-order/);
  assert.match(route, /adminOrMasterMiddleware/);
  assert.match(route, /confirm !== true/);
  assert.match(front, /function assignUnslottedOrder\(rowId\)/);
  assert.match(front, /번호 배정/);
});
console.log(`\n${pass}개 통과`);
