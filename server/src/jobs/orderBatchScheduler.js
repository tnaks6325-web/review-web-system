/**
 * orderBatchScheduler.js — 구매주문 시트반영 "상시 배치" 스케줄러 (근실시간)
 *
 * 목적: 모든 활성 탭의 order_append를 탭별 배치(가드 1콜 + 쓰기 1콜/청크)로 "상시" 드레인 →
 *   throttle 쿼터 안전 + 단건 대비 수십배 효율로 근실시간 시트반영.
 *
 * 동작: 제출 시 kick(즉시성) + 15초 cron(백스톱). 코얼레싱(_running/_rerun)으로 한 번에 1사이클만.
 *   각 탭은 검증된 drainTabQueueBatched(레드-블루-심판 + E2E 통과)로 처리 — advisory lock(queue_pump_drain
 *   ∩ order_reconcile)으로 펌프·가속드레인·reconcile과 직렬화(이중쓰기·throttle 과구독 차단).
 *
 * 게이트: ORDER_BATCH_AUTO=1 일 때만 활성. 미설정 시 no-op(기존 펌프/30초 cron이 처리 = 되돌리기).
 *   (drainTabQueueBatched 자체는 ORDER_BATCH_DRAIN=1 이라야 배치, 아니면 단건 폴백.)
 *
 * 손실 0: 실패/quota/락경합은 모두 양보 → 30초 cron·2분주기 reconcile 백스톱이 흡수.
 *   markWritten은 시트 쓰기 성공 후에만(교차노출 불변식 유지).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const TICK_MAX_MS = parseInt(process.env.ORDER_BATCH_TICK_MAX_MS || '25000', 10);   // 한 사이클 총상한
const PER_TAB_MS = parseInt(process.env.ORDER_BATCH_PER_TAB_MS || '12000', 10);     // 탭당 드레인 상한
const MAX_TABS = parseInt(process.env.ORDER_BATCH_MAX_TABS || '10', 10);            // 사이클당 탭 수

let _running = false, _rerun = false;

function isAutoEnabled() {
  return process.env.ORDER_BATCH_AUTO === '1';
}

// 시트 미반영 주문이 있는 탭을 건수 내림차순으로 추려 배치 드레인.
// ★ order_submissions(원장) 기준 — 큐에 없는 pending_no_row(버스트 시 행 미배정분)도 포함해야
//   drainTabQueueBatched의 reconcile 선행이 행배정+enqueue 후 곧바로 드레인한다(큐만 보면 사각지대).
async function _cycle() {
  const start = Date.now();
  // ★ 제안B: throttle가 이미 바쁘면(리뷰제출·RAW미러 등이 예산 사용 중) 이번 사이클 양보 →
  //   45/분 한도 안에서 다른 시트작업과 공존(배치가 예산 독식 안 함). 다음 kick/15초 cron이 재시도.
  try {
    const { getThrottleStatus } = require('../utils/sheetsThrottle');
    const busyThreshold = parseInt(process.env.ORDER_BATCH_BUSY_THRESHOLD || '35', 10);
    if (getThrottleStatus().requestsInLastMinute > busyThreshold) {
      return { tabs: 0, drained: 0, skipped: 'throttle_busy' };
    }
  } catch (_) { /* throttle 상태 조회 실패는 무시하고 진행 */ }
  const { rows } = await pool.query(
    `SELECT os.sheet_id AS sheet_id, os.tab_name AS tab_name, COUNT(*)::int AS c
       FROM order_submissions os
      WHERE os.deleted_at IS NULL
        AND os.mirror_status IN ('pending','pending_no_row','queued','failed')
        AND os.sheet_id IS NOT NULL AND os.tab_name IS NOT NULL AND os.tab_name <> ''
      GROUP BY os.sheet_id, os.tab_name
      ORDER BY c DESC
      LIMIT $1`,
    [MAX_TABS]
  );
  if (!rows.length) return { tabs: 0, drained: 0 };

  const { drainTabQueueBatched } = require('../services/syncQueue.service');
  let drained = 0, succeeded = 0;
  for (const r of rows) {
    if (Date.now() - start > TICK_MAX_MS) break;
    if (!r.sheet_id || !r.tab_name) continue;
    try {
      const res = await drainTabQueueBatched({ sheetId: r.sheet_id, tabName: r.tab_name, maxMillis: PER_TAB_MS });
      drained++;
      if (res && res.succeeded) succeeded += res.succeeded;
    } catch (e) {
      logger.warn(`[orderBatchTick] tab=${r.tab_name} 드레인 실패(무시, cron 백스톱): ${e && e.message}`);
    }
  }
  if (succeeded) logger.info(`[orderBatchTick] ${drained}개 탭 드레인, ${succeeded}건 시트반영`);
  return { tabs: rows.length, drained, succeeded };
}

// 비차단 코얼레싱 kick. 제출/cron이 호출. 실행 중이면 1회 재실행 예약.
function kickOrderBatch() {
  if (!isAutoEnabled()) return;
  if (_running) { _rerun = true; return; }
  _running = true;
  setImmediate(async () => {
    try { await _cycle(); }
    catch (e) { logger.warn(`[orderBatchTick] 사이클 오류(무시): ${e && e.message}`); }
    finally { _running = false; if (_rerun) { _rerun = false; kickOrderBatch(); } }
  });
}

module.exports = { kickOrderBatch, isAutoEnabled, _cycle };
