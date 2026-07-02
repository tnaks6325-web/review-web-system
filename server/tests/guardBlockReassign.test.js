/**
 * guardBlockReassign 단위 테스트 — 버그1(가드 차단된 비복구 queued 주문 영구정체) 방어 검증.
 *   _guardBlockDecision 진리표: defer(유예)/release(재배정)/giveup(수동전환·상한).
 *   ★ 기본 ON(미설정 = ON): grace 경과 후 비복구도 release, 상한 초과는 giveup.
 *     OFF는 ORDER_GUARD_REASSIGN='0' 명시(비복구는 defer만 = 재배정 안 함, 복구분만 release).
 * 실행: node tests/guardBlockReassign.test.js
 */
const assert = require('assert');
const { _guardBlockDecision } = require('../src/services/syncQueue.service');

function withGate(mode, fn) {
  // mode: 'on'(='1') | 'off'(='0') | 'unset'(미설정 → 기본 ON)
  const saved = process.env.ORDER_GUARD_REASSIGN;
  if (mode === 'on') process.env.ORDER_GUARD_REASSIGN = '1';
  else if (mode === 'off') process.env.ORDER_GUARD_REASSIGN = '0';
  else delete process.env.ORDER_GUARD_REASSIGN;
  try { fn(); } finally { if (saved === undefined) delete process.env.ORDER_GUARD_REASSIGN; else process.env.ORDER_GUARD_REASSIGN = saved; }
}

async function run() {
  const now = Date.now();
  const past = new Date(now - 200000).toISOString();  // 200s 전 (>90s grace)
  const fresh = new Date(now - 1000).toISOString();    // 1s 전

  // ── 게이트 미설정(기본) = ON: 재배정 폴백이 기본 동작 ──
  withGate('unset', () => {
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: fresh }), 'defer', '기본+fresh → defer(일시경합 오판 방지)');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past }), 'release', '★기본(미설정)+past-grace → release(기본 ON)');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past, reassignCount: 5 }), 'giveup', '기본+rc≥max(5) → giveup');
  });
  console.log('  게이트 기본값(미설정=ON) 진리표 통과');

  // ── 게이트 OFF('0' 명시): 복구분만 release, 비복구는 항상 defer(되돌리기 경로) ──
  withGate('off', () => {
    assert.equal(_guardBlockDecision({ recovered: true }), 'release', 'OFF+복구 → release');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: fresh }), 'defer', 'OFF+비복구(fresh) → defer');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past }), 'defer', 'OFF+비복구(past) → defer(게이트 꺼짐)');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past, reassignCount: 99 }), 'defer', 'OFF는 상한 무시(giveup 안 함)');
  });
  console.log('  게이트 OFF(=0 명시) 진리표 통과');

  // ── 게이트 ON('1' 명시): fresh는 유예(defer), grace 경과는 release, 복구분 release, 상한 초과 giveup ──
  withGate('on', () => {
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: fresh }), 'defer', 'ON+fresh → defer(일시경합 오판 방지)');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past }), 'release', 'ON+past-grace → release');
    assert.equal(_guardBlockDecision({ recovered: true, submittedAt: fresh }), 'release', 'ON+복구 → release');
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past, reassignCount: 5 }), 'giveup', 'ON+rc≥max(5) → giveup');
    assert.equal(_guardBlockDecision({ recovered: true, reassignCount: 9 }), 'giveup', 'ON+상한 초과는 복구분보다 우선(무한 append 종결)');
    // submittedAt 없으면 ageMs=Infinity → release(정체 오래된 주문 취급, 손실 방지)
    assert.equal(_guardBlockDecision({ recovered: false }), 'release', 'ON+submittedAt 없음 → release(정체건)');
  });
  console.log('  게이트 ON 진리표 통과');

  // 기본 상한(ORDER_MAX_REASSIGN 미설정=5)에서 rc=4는 아직 release(경계 검증)
  withGate('on', () => {
    assert.equal(_guardBlockDecision({ recovered: false, submittedAt: past, reassignCount: 4 }), 'release', 'rc=4(<5) → 아직 release');
  });
  console.log('  상한 경계(rc=4) 통과');

  console.log('✅ guardBlockReassign 전체 통과');
}
run().catch(e => { console.error('❌ guardBlockReassign 실패:', e); process.exit(1); });
