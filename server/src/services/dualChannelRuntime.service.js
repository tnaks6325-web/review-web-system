'use strict';
// No environment, request-body or DB fallback may enable or disable this feature.
// 출시 상태는 코드 상수다(결정 341 「출시(켜기)」 2026-11-06) — 끄려면 이 커밋을 되돌린다.
// 시험만 __setReadinessForTest 로 닫거나 열 수 있다(NODE_ENV=test 전용).
const KEYS = Object.freeze(['settings', 'roundtrip', 'recruitment', 'purchase', 'review', 'payment', 'operationalEnabled']);
const RELEASED = Object.freeze(Object.fromEntries([['version', 1], ...KEYS.map(k => [k, true])]));
let readiness = RELEASED;
function getDualChannelReadiness() { return { ...readiness }; }
function isDualChannelReady(operation) {
  if (!KEYS.includes(operation) || operation === 'operationalEnabled') throw new TypeError('Unknown dual channel operation');
  const yes = key => readiness[key] === true;
  if (operation === 'settings') return yes('settings');
  if (operation === 'roundtrip') return yes('settings') && yes('roundtrip');
  if (operation === 'recruitment' || operation === 'purchase') return KEYS.every(yes);
  if (operation === 'review') return ['settings', 'roundtrip', 'purchase', 'review'].every(yes);
  return ['settings', 'roundtrip', 'purchase', 'review', 'payment'].every(yes);
}
function assertDualChannelReady(operation) {
  if (isDualChannelReady(operation)) return;
  const err = new Error(require('../utils/dualChannel').DUAL_CHANNEL_NOT_READY.error);
  err.code = 'dual_channel_not_ready';
  throw err;
}
function __setReadinessForTest(state) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Server test dependency injection only');
  readiness = Object.freeze(Object.fromEntries([['version', 1], ...KEYS.map(k => [k, !!state && state[k] === true])]));
}
module.exports = { getDualChannelReadiness, isDualChannelReady, assertDualChannelReady, __setReadinessForTest };
