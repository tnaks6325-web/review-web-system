/**
 * queuePump / 근실시간 동기화 변경 검증 테스트
 *   V4: advisory lock 해시충돌 — queue_pump_drain ≠ order_reconcile (jobLock._lockKeys)
 *   V6: markOrderQueued 단조전이 가드(written 역행 방지), markOrderWritten은 무가드 유지
 *   V3: queuePump 코얼레싱 — 연속 kick에도 동시 러너 1개 + 종료 후 rerun 1회 소비
 *
 * 프레임워크 없이 plain node + assert (기존 tests/orderLedger.test.js 스타일).
 * 실행: node tests/queuePump.test.js
 */
const assert = require('assert');

// ── V4: advisory lock 키 충돌 검증 (R3 방어의 전제) ──
function testLockKeys() {
  const { _lockKeys } = require('../src/utils/jobLock');
  const a = _lockKeys('order_reconcile');
  const b = _lockKeys('queue_pump_drain');
  // 두 락 이름이 같은 64bit 키쌍으로 해시되면 무관한 작업이 조용히 직렬화된다 → 반드시 달라야 함.
  assert.ok(!(a[0] === b[0] && a[1] === b[1]),
    `해시충돌: order_reconcile=${a} 와 queue_pump_drain=${b} 가 같은 키`);
  // 결정적(같은 입력 → 같은 출력)인지도 확인.
  assert.deepEqual(_lockKeys('queue_pump_drain'), b);
  console.log('  V4 ok — lock keys distinct & deterministic', { order_reconcile: a, queue_pump_drain: b });
}

// ── V6: markOrderQueued 단조가드 (R1) ──
async function testMonotonicGuard() {
  const ledger = require('../src/services/orderLedger.service');
  const captured = [];
  const fakePool = { query: async (sql, params) => { captured.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  ledger.__setPoolForTest(fakePool);
  try {
    captured.length = 0;
    await ledger.markOrderQueued('order-XYZ');
    assert.equal(captured.length, 1, 'markOrderQueued 는 1회 UPDATE');
    const q = captured[0];
    assert.ok(/mirror_status\s*=\s*'queued'/.test(q.sql), "queued 로 세팅");
    assert.ok(/mirror_status\s*<>\s*'written'/.test(q.sql), "★ 단조가드: WHERE mirror_status <> 'written' 필수");
    assert.deepEqual(q.params, ['order-XYZ']);

    // 빈 id 는 no-op (가드)
    captured.length = 0;
    await ledger.markOrderQueued(null);
    assert.equal(captured.length, 0, '빈 id 는 쿼리 안 함');

    // markOrderWritten 은 무가드 유지 — reconcile failed→written 정상전이 보존
    captured.length = 0;
    await ledger.markOrderWritten('order-XYZ', 42);
    const w = captured[0];
    assert.ok(/mirror_status\s*=\s*'written'/.test(w.sql), 'written 세팅');
    assert.ok(!/<>\s*'written'/.test(w.sql), '★ markOrderWritten 은 단조가드를 걸지 않음(무가드 유지)');
    console.log('  V6 ok — markOrderQueued guarded, markOrderWritten unguarded');
  } finally {
    ledger.__setPoolForTest(null);
  }
}

// ── V3: queuePump 코얼레싱 (R4) ──
// queuePump 의 4개 의존성을 require.cache 주입으로 모킹한 뒤 fresh require.
async function testCoalescing() {
  let pumpOnceCalls = 0;   // = withJobLock 호출 수 = 러너 실행 수
  let releaseGate;          // withJobLock fn 을 잡아두는 게이트(코얼레싱 타이밍 제어)
  let gate = new Promise((r) => { releaseGate = r; });

  function mock(relId, exportsObj) {
    const resolved = require.resolve(relId);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
    return resolved;
  }

  const injected = [];
  injected.push(mock('../src/utils/jobLock', {
    withJobLock: async (name, fn) => {
      assert.equal(name, 'queue_pump_drain', '펌프 락 이름');
      pumpOnceCalls++;
      await gate;            // 첫 러너를 잡아둬 그 사이 추가 kick 이 코얼레싱되게
      return fn();
    },
    _lockKeys: () => [0, 0],
  }));
  injected.push(mock('../src/utils/sheetsThrottle', {
    getThrottleStatus: () => ({ requestsInLastMinute: 0, limit: 45 }),
  }));
  injected.push(mock('../src/services/syncQueue.service', {
    processQueue: async () => ({ processed: 0, succeeded: 0, failed: 0, elapsed: 0, quotaExceeded: false }),
  }));
  injected.push(mock('../src/utils/logger', { logger: { debug() {}, warn() {}, info() {} } }));

  // queuePump 캐시 제거 후 fresh require (위 모킹을 잡도록)
  delete require.cache[require.resolve('../src/jobs/queuePump')];
  const { kickQueuePump } = require('../src/jobs/queuePump');

  const tick = () => new Promise((r) => setImmediate(r));

  try {
    // 첫 kick → 러너 시작(게이트에서 멈춤). 그 뒤 2번 더 kick → _running=true 라 코얼레싱(rerun 1회).
    kickQueuePump();
    await tick();                 // setImmediate 러너 진입 → withJobLock 호출(게이트 대기)
    assert.equal(pumpOnceCalls, 1, '첫 러너 1개만 시작');
    kickQueuePump();              // 러너 가동 중 → _rerun=true
    kickQueuePump();              // 또 호출 → 여전히 _rerun=true (중복 러너 안 생김)
    await tick();
    assert.equal(pumpOnceCalls, 1, '가동 중 추가 kick 은 새 러너를 만들지 않음(코얼레싱)');

    // 게이트 해제 → 첫 러너 종료 → finally 에서 rerun 1회 소비 → 두 번째 러너
    releaseGate();
    // 두 번째 러너도 같은 게이트(이미 resolved)라 즉시 통과
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(pumpOnceCalls, 2, '종료 후 rerun 정확히 1회 소비(2,3번째 kick 이 1회로 합쳐짐)');

    // 모두 정리된 뒤 새 kick → 새 러너(멱등 재진입 가능)
    kickQueuePump();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(pumpOnceCalls, 3, '정리 후 새 kick 은 새 러너 시작');
    console.log('  V3 ok — coalescing: single runner + exactly-one rerun');
  } finally {
    injected.forEach((p) => { delete require.cache[p]; });
    delete require.cache[require.resolve('../src/jobs/queuePump')];
  }
}

async function run() {
  testLockKeys();
  await testMonotonicGuard();
  await testCoalescing();
}

run()
  .then(() => console.log('queuePump tests passed'))
  .catch((err) => { console.error(err); process.exit(1); });
