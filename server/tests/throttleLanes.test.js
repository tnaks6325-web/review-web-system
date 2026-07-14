/**
 * throttleLanes 단위 테스트 — Drive lane 분리 + concurrentMap 계약 검증 (순수 node, DB 불필요)
 * 실행: node tests/throttleLanes.test.js
 */
const assert = require('assert');

function freshThrottle(env = {}) {
  const key = require.resolve('../src/utils/sheetsThrottle');
  delete require.cache[key];
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const mod = require('../src/utils/sheetsThrottle');
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  return mod;
}

async function run() {
  // ── R3/R9: lane 격리 — drive 포화가 시트 윈도우/게이트에 안 보임, 반대도 ──
  const t = freshThrottle({});
  t.__injectDriveRequests(120, 5000);
  assert.equal(t.getThrottleStatus().requestsInLastMinute, 0, 'drive 포화여도 시트 lane 0 (busy-gate 미오염)');
  assert.ok(!('drive' in t.getThrottleStatus()), 'getThrottleStatus는 시트 전용 계약(R9)');
  assert.equal(t._getWaitTime('normal'), 0, '시트 lane 대기 0');
  assert.ok(t._getDriveWaitTime() > 0, 'drive lane은 자기 cap(120)에서 대기');
  t.__resetForTest();
  t.__injectRequests(45, 5000);
  assert.equal(t._getDriveWaitTime(), 0, '시트 포화여도 drive lane 통과');
  assert.equal(t.getThrottleMonitor().drive.used, 0, '모니터 drive lane 독립 계수');
  console.log('  lane 격리 통과');

  // ── driveThrottledCall 실호출: drive lane에만 기록 + 라벨 프레임스킵 ──
  t.__resetForTest();
  const v = await t.driveThrottledCall(async () => 42);
  assert.equal(v, 42);
  const mon = t.getThrottleMonitor();
  assert.equal(mon.drive.used, 1, 'drive lane 1콜 기록');
  assert.equal(mon.used, 0, '시트 lane 미소모');
  assert.ok(!/sheetsThrottle/.test(mon.drive.recent[0].label), '라벨이 sheetsThrottle 프레임으로 오귀속 안 됨(R3)');
  console.log('  driveThrottledCall 기록/귀속 통과');

  // ── R6: concurrentMap 계약 — 무기록·인덱스 보존·부분실패 격리·allSettled 형태·동시성 상한 ──
  t.__resetForTest();
  let inflight = 0, maxInflight = 0;
  const items = [50, 30, 10, 40, 20];  // 완료순 ≠ 입력순이 되도록 지연 역전
  const res = await t.concurrentMap(items, async (ms, idx) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, ms));
    inflight--;
    if (idx === 2) throw new Error('boom-2');
    return `ok-${idx}`;
  }, 2);
  assert.equal(res.length, 5);
  assert.equal(res[0].status, 'fulfilled'); assert.equal(res[0].value, 'ok-0');
  assert.equal(res[2].status, 'rejected'); assert.equal(res[2].reason.message, 'boom-2', '실패가 그 인덱스에 격리');
  assert.equal(res[4].value, 'ok-4', '완료순 아닌 입력 인덱스 정렬 보존');
  assert.ok(maxInflight <= 2, '동시성 상한 준수');
  assert.equal(t.getThrottleStatus().requestsInLastMinute, 0, '시트 슬롯 무기록(팬텀 0)');
  assert.equal(t.getThrottleMonitor().drive.used, 0, 'drive 슬롯도 무기록');
  console.log('  concurrentMap 계약(R6) 통과');

  // ── R8: env 미가드 값 → 기본값 폴백, 크래시 없음 ──
  for (const bad of ['0', '-5', 'abc']) {
    const tb = freshThrottle({ DRIVE_REQUESTS_PER_MINUTE: bad });
    assert.equal(tb.DRIVE_REQUESTS_PER_MINUTE, 120, `misconfig '${bad}' → 120 폴백`);
    assert.equal(await tb.driveThrottledCall(async () => 1), 1, '대기계산 크래시 없음');
  }
  console.log('  env 가드(R8) 통과');

  // ── 기존 시트 lane 시맨틱 불변(throttleReserve 불변식 재확인) ──
  const t2 = freshThrottle({ SHEETS_ORDER_RESERVE: '8' });
  assert.equal(t2._effectiveCap('low'), 37, 'low cap = 45-8');
  assert.equal(t2._effectiveCap('normal'), 45, 'normal cap = 45');
  t2.__injectRequests(45, 5000);
  assert.ok(t2._getWaitTime('normal') > 0, '45 하드리밋 불변');
  const t0 = freshThrottle({ SHEETS_ORDER_RESERVE: '0' });
  assert.equal(t0._effectiveCap('low'), 45, 'RESERVE=0 되돌리기 게이트 불변');
  console.log('  시트 lane 시맨틱 불변 통과');

  // ── R1: jobLock 신규 이름 해시 비충돌 ──
  const { _lockKeys } = require('../src/utils/jobLock');
  const names = ['order_reconcile', 'queue_pump_drain', 'reverse_sync_auto', 'raw_mirror_all'];
  const keys = names.map(n => _lockKeys(n).join(','));
  assert.equal(new Set(keys).size, names.length, 'advisory lock 키 비충돌');
  console.log('  jobLock 키 비충돌(R1) 통과');

  console.log('✅ throttleLanes 전체 통과');
}
run().catch(e => { console.error('❌ throttleLanes 실패:', e); process.exit(1); });
