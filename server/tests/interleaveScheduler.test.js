/**
 * interleaveScheduler 단위 테스트 — 다탭 인터리브 공평성(기아 방지) 회귀 가드.
 *   배경: busy 폴백이 "첫 1탭 전체 드레인"이라 나머지 탭을 수분 굶기던 버그(관측: tab1 20s, tab2/3 ~3분).
 *   의존성(pool/syncQueue/throttle/orderLedger/jobLock)을 require.cache로 모킹해 _cycle을 결정적으로 검증.
 * 실행: node tests/interleaveScheduler.test.js
 */
const assert = require('assert');
const path = require('path');
const SRV = path.join(__dirname, '..');

function loadSchedulerWithMocks({ throttleN }) {
  // env는 로드 전에 — const가 로드시 평가됨
  process.env.ORDER_BATCH_AUTO = '1';
  process.env.ORDER_BATCH_DRAIN = '1';
  process.env.ORDER_BATCH_INTERLEAVE = '1';
  process.env.ORDER_BATCH_INTERLEAVE_MAX_MS = '20000';

  const SHEET = 'S1';
  const queues = { T1: 100, T2: 100, T3: 100 };
  const submittedAt = { T1: 1, T2: 2, T3: 3 };
  const BATCH = 50;

  const inject = (rel, exp) => {
    const abs = require.resolve(path.join(SRV, 'src/jobs', rel));
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exp };
  };
  inject('../db/pool', {
    query: async (sql) => {
      if (/FROM order_submissions/i.test(sql) && /GROUP BY/i.test(sql)) {
        const rows = Object.keys(queues).filter(t => queues[t] > 0)
          .map(t => ({ sheet_id: SHEET, tab_name: t, c: queues[t], sort_key: submittedAt[t] }))
          .sort((a, b) => a.sort_key - b.sort_key);
        return { rows };
      }
      return { rows: [] };
    },
  });
  inject('../services/syncQueue.service', {
    drainTabQueueBatched: async ({ tabName, oneChunk }) => {
      let succeeded = 0;
      do {
        const take = Math.min(BATCH, queues[tabName] || 0);
        queues[tabName] -= take; succeeded += take;
        if (oneChunk) break;
      } while (queues[tabName] > 0);
      return { processed: succeeded, succeeded, failed: 0, deferred: 0, quotaExceeded: false, emptied: succeeded === 0, elapsedMs: 1 };
    },
  });
  inject('../utils/sheetsThrottle', { getThrottleStatus: () => ({ requestsInLastMinute: throttleN }) });
  inject('../services/orderLedger.service', { reconcileStuckOrders: async () => ({ requeued: 0 }) });
  inject('../utils/jobLock', { withJobLock: async (name, fn) => fn() });

  // 스케줄러 모듈 캐시 무효화 후 새로 로드(상태 격리)
  delete require.cache[require.resolve(path.join(SRV, 'src/jobs/orderBatchScheduler.js'))];
  const sched = require(path.join(SRV, 'src/jobs/orderBatchScheduler.js'));
  return { sched, queues, SHEET };
}

async function drive(sched, queues) {
  sched.kickOrderBatch('S1', 'T1');
  sched.kickOrderBatch('S1', 'T2');
  sched.kickOrderBatch('S1', 'T3');
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setImmediate(r));
    sched.kickOrderBatch();
    if (Object.values(queues).every(v => v === 0)) break;
  }
  await new Promise(r => setTimeout(r, 30));
}

async function run() {
  // ── not-busy: 한 사이클에 전탭 공평 드레인 ──
  {
    const { sched, queues } = loadSchedulerWithMocks({ throttleN: 0 });
    await drive(sched, queues);
    assert.deepEqual(queues, { T1: 0, T2: 0, T3: 0 }, 'not-busy: 전탭 드레인');
    const h = sched.getDiag().history.find(x => x.mode === 'interleave');
    assert.ok(h, 'interleave 사이클 존재');
    assert.deepEqual(h.perTab, { T1: 100, T2: 100, T3: 100 }, 'not-busy: 한 사이클 전탭 공평(100/100/100)');
    console.log('  not-busy 인터리브 공평 통과');
  }

  // ── busy: 라운드마다 1청크/탭 공평(첫 탭 독점 금지) ──
  {
    const { sched, queues } = loadSchedulerWithMocks({ throttleN: 50 }); // > BUSY_THRESHOLD(40)
    await drive(sched, queues);
    assert.deepEqual(queues, { T1: 0, T2: 0, T3: 0 }, 'busy: 전탭 드레인(손실0)');
    const busyCycles = sched.getDiag().history.filter(x => x.mode === 'busy-fair');
    assert.ok(busyCycles.length >= 1, 'busy-fair 사이클 존재');
    // ★ 핵심 회귀가드: busy 사이클이 "첫 탭만"이 아니라 여러 탭을 한 라운드에 처리해야 함
    for (const c of busyCycles) {
      const tabsTouched = Object.keys(c.perTab).length;
      assert.ok(tabsTouched >= 2 || Object.values(c.perTab).every(v => v <= 50),
        `busy 사이클이 공평해야(첫 탭 전체 독점 금지): perTab=${JSON.stringify(c.perTab)}`);
    }
    // 첫 busy 사이클은 3탭 각 1청크(50)여야 함
    const first = busyCycles[0];
    assert.deepEqual(first.perTab, { T1: 50, T2: 50, T3: 50 }, `busy 1라운드 공평(50/50/50): ${JSON.stringify(first.perTab)}`);
    console.log('  busy-fair 공평(기아 방지) 통과');
  }
}

run().then(() => console.log('interleaveScheduler tests passed'))
  .catch(e => { console.error(e); process.exit(1); });
