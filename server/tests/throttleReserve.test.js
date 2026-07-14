/**
 * throttleReserve 단위 테스트 — 버그2(smartBuild throttle 독점 → order_append 기아) 방어 검증.
 *   저우선(리뷰인덱스빌드) 서브캡(45-RESERVE)이 order(normal)용 슬롯을 항상 남기는지 + 45 하드리밋 불변식.
 * 실행: node tests/throttleReserve.test.js
 */
const assert = require('assert');

function freshThrottle(env) {
  const key = require.resolve('../src/utils/sheetsThrottle');
  delete require.cache[key];
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const mod = require('../src/utils/sheetsThrottle');
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return mod;
}

async function run() {
  // ── 기본(RESERVE=8): low는 37로 자기제한, normal은 45 전량 ──
  const t = freshThrottle({ SHEETS_ORDER_RESERVE: '8' });
  assert.equal(t._effectiveCap('low'), 37, 'low cap = 45-8 = 37');
  assert.equal(t._effectiveCap('normal'), 45, 'normal cap = 45');
  assert.equal(t._effectiveCap(undefined), 45, '미지정 → 45(정규)');
  console.log('  _effectiveCap(8) 통과');

  // 37 슬롯 소비 시: low는 대기(기아 방지 = order용 8 확보), normal은 즉시 통과
  t.__resetForTest(); t.__injectRequests(37, 5000);
  assert.ok(t._getWaitTime('low') > 0, 'low는 37에서 대기(서브캡 도달)');
  assert.equal(t._getWaitTime('normal'), 0, 'normal은 37에서 통과(45 미만)');
  console.log('  37 슬롯: low 대기 / normal 통과 통과');

  // 45 슬롯 소비 시: 둘 다 대기(하드리밋) — 바이패스 없음(R4)
  t.__resetForTest(); t.__injectRequests(45, 5000);
  assert.ok(t._getWaitTime('low') > 0 && t._getWaitTime('normal') > 0, '45에서 둘 다 대기(바이패스 없음)');
  assert.ok(t.getThrottleStatus().requestsInLastMinute <= 45, '★ 불변식: 최근1분 사용 ≤ 45');
  console.log('  45 하드리밋 불변식(R4) 통과');

  // ── RESERVE=0: 완전 현행(둘 다 45) — 되돌리기 게이트(R10) ──
  const t0 = freshThrottle({ SHEETS_ORDER_RESERVE: '0' });
  assert.equal(t0._effectiveCap('low'), 45, 'RESERVE=0 → low도 45(현행 동일)');
  assert.equal(t0._effectiveCap('normal'), 45, 'RESERVE=0 → normal 45');
  console.log('  RESERVE=0 되돌리기(R10) 통과');

  console.log('✅ throttleReserve 전체 통과');
}
run().catch(e => { console.error('❌ throttleReserve 실패:', e); process.exit(1); });
