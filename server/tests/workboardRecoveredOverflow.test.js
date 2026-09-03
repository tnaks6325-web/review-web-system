'use strict';

const assert = require('assert');
const test = require('node:test');
const { __canAppendConfirmedOverflowOrderForTest: canOverflow } = require('../src/services/sheetlessOrder.service');

function db(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

function valid(overrides = {}) {
  return {
    source: 'order_submit', recipient: '수취인', phone_digits: '01012345678', order_num: 'ORDER-1',
    mirror_status: 'queued', submitted_at: new Date(Date.now() - 60 * 60 * 1000), workboard_id: 'wb-1',
    ...overrides,
  };
}

test('외부모집 수동 확정 주문의 기존 초과 허용은 유지한다', async () => {
  assert.equal(await canOverflow(db(valid({ source: 'admin_external', order_num: null, workboard_id: null })), 'os-1'), true);
});

test('최근 48시간 큐 누락 복구 주문은 원장 조건을 모두 만족할 때만 허용한다', async () => {
  assert.equal(await canOverflow(db(valid()), 'os-1', { allowMissingQueueRecoveryOverflow: true, workboardId: 'wb-1' }), true);
});

for (const [name, row, options] of [
  ['일반 큐', valid(), { workboardId: 'wb-1' }],
  ['48시간 초과', valid({ submitted_at: new Date(Date.now() - 49 * 60 * 60 * 1000) }), { allowMissingQueueRecoveryOverflow: true, workboardId: 'wb-1' }],
  ['주문번호 없음', valid({ order_num: null }), { allowMissingQueueRecoveryOverflow: true, workboardId: 'wb-1' }],
  ['다른 작업보드', valid(), { allowMissingQueueRecoveryOverflow: true, workboardId: 'wb-2' }],
  ['완료 상태 재시도', valid({ mirror_status: 'written' }), { allowMissingQueueRecoveryOverflow: true, workboardId: 'wb-1' }],
]) {
  test(`${name}은 초과 슬롯을 만들지 않는다`, async () => {
    assert.equal(await canOverflow(db(row), 'os-1', options), false);
  });
}
