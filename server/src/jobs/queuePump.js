/**
 * ═══════════════════════════════════════════════════════════
 * Queue Pump — enqueue 직후 비차단 즉시 드레인(근실시간화)
 *
 * 구매양식 제출(order_append)이 30초 cron 큐워커를 기다리지 않고 제출 직후
 * 곧바로 시트에 반영되도록, 제출 핸들러가 kickQueuePump()로 큐를 즉시 펌프한다.
 *
 * 불변식: (advisory lock 보유) AND (throttle 여유) AND (quota 미발생)일 때만 시트콜.
 *   셋 중 하나라도 닫히면 30초 cron 백스톱으로 폴백 → 손실0·멱등·쿼터안전·되돌릴수있음.
 *
 *   - R3 (롤링배포 합산쿼터): withJobLock('queue_pump_drain')로 인스턴스 경계 직렬화.
 *       배포 중 old+new 두 프로세스가 각자 throttle(프로세스 전역)를 풀가동해 합산
 *       쿼터를 초과하는 것을 차단(한 번에 한 프로세스만 펌프, 나머지는 즉시 양보).
 *   - R2 (다른 cron 굶김): 라운드마다 throttle busy 재평가로 양보 + quotaExceeded break
 *       + batchSize 캡 → rawMirror/reconcile cron이 throttle 창을 비집을 틈 확보.
 *   - R4 (코얼레싱): _running/_rerun — 러너 종료 시 _running=false 먼저, 그 뒤 rerun 재진입.
 *   - R5 (크래시 방지): 러너 본문 전체 try/catch(삼킴)/finally + MAX_PUMP_MS 상한.
 *
 * 30초 cron(cron.js)은 백스톱으로 유지(프로세스 재시작 잔여 pending·kick 누락·quota 양보 흡수).
 * ═══════════════════════════════════════════════════════════
 */

const { processQueue } = require('../services/syncQueue.service');
const { getThrottleStatus } = require('../utils/sheetsThrottle');
const { withJobLock } = require('../utils/jobLock');
const { logger } = require('../utils/logger');

const MAX_PUMP_MS = parseInt(process.env.QUEUE_PUMP_MAX_MS || '15000', 10);       // 한 펌프 러너 최대 가동 시간(상한)
const PUMP_BATCH = parseInt(process.env.QUEUE_PUMP_BATCH || '5', 10);             // 라운드당 배치 크기(작게 캡)
const PUMP_BUSY_THRESHOLD = parseInt(process.env.QUEUE_PUMP_BUSY_THRESHOLD || '25', 10); // throttle 사용량 이 이상이면 양보

let _running = false;   // 현재 펌프 러너 가동 중
let _rerun = false;     // 러너 가동 중 들어온 kick 요청(종료 후 1회 재실행)

async function _pumpOnce() {
  // R3: 인스턴스 경계 직렬화. 다른 인스턴스/프로세스가 펌프 중이면 즉시 양보(30초 cron 백스톱).
  return withJobLock('queue_pump_drain', async () => {
    const start = Date.now();
    while (Date.now() - start < MAX_PUMP_MS) {
      // R2: 라운드마다 throttle 재평가 — 포화면 다른 cron(rawMirror/reconcile)에 양보하고 빠진다.
      const th = getThrottleStatus();
      if (th.requestsInLastMinute > PUMP_BUSY_THRESHOLD) {
        logger.debug(`[queuePump] throttle busy (${th.requestsInLastMinute}/${th.limit}) — 양보(cron 백스톱)`);
        break;
      }
      const r = await processQueue(PUMP_BATCH, { interItemDelayMs: 0 });
      if ((r.processed || 0) === 0) break;     // 큐 비었음
      if (r.quotaExceeded) {                    // R2: quota → cron 백오프에 양보
        logger.warn('[queuePump] quotaExceeded — 펌프 중단, 30초 cron 백스톱에 양보');
        break;
      }
    }
  });
}

/**
 * 큐를 즉시 펌프(비차단). 이미 러너가 돌고 있으면 재실행 요청만 등록(코얼레싱).
 * 호출자(핫패스)에 절대 throw하지 않는다 — 실패해도 30초 cron이 백스톱.
 */
function kickQueuePump() {
  if (_running) { _rerun = true; return; }   // R4: 코얼레싱 — 동시 러너 최대 1개
  _running = true;
  setImmediate(async () => {                  // R5: 비차단 — 핸들러 종료 후 실행
    try {
      await _pumpOnce();
    } catch (err) {
      logger.warn(`[queuePump] 러너 오류(무시, cron 백스톱): ${err && err.message}`);
    } finally {
      _running = false;                        // R4: 먼저 해제
      if (_rerun) { _rerun = false; kickQueuePump(); }  // 그 뒤 멱등 재진입
    }
  });
}

module.exports = { kickQueuePump };
