const assert = require('assert');
const { weekendPublicationState } = require('../src/services/campaignWeekend.service');

function test(name, fn) {
  fn();
  console.log(`  ✓ ${name}`);
}

test('주말 제외 공고는 한국 시간 토요일에 게시 보류 상태가 된다', () => {
  const state = weekendPublicationState({ skip_weekends: true }, new Date('2026-08-14T15:00:00.000Z'));
  assert.deepStrictEqual(state, {
    blocked: true,
    reason: 'weekend_unpublished',
    message: '주말 미게시 · 월요일 재개',
    resumesOn: '2026-08-17',
  });
});

test('주말 제외 공고는 한국 시간 월요일에 자동 재개된다', () => {
  const state = weekendPublicationState({ skip_weekends: true }, new Date('2026-08-16T15:00:00.000Z'));
  assert.strictEqual(state.blocked, false);
  assert.strictEqual(state.resumesOn, null);
});

test('주말 포함 공고는 주말에도 차단되지 않는다', () => {
  const state = weekendPublicationState({ skip_weekends: false }, new Date('2026-08-15T15:00:00.000Z'));
  assert.strictEqual(state.blocked, false);
});

console.log('campaignWeekendPolicy: passed');
