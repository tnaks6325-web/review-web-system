const cron = require('node-cron');
const { buildIndexSmart, checkDirtySheets, buildOneSheet } = require('../services/indexBuilder.service');
const { processQueue, purgeCompleted, retryAllFailed } = require('../services/syncQueue.service');
const { mirrorAllSheets } = require('../services/rawMirror.service');
const { getThrottleStatus } = require('../utils/sheetsThrottle');
// [DEPRECATED — v11.8.0] syncSettingsOnly 제거: DB가 설정 원본이므로 시트→DB 동기화 불필요
// const { syncSettingsOnly } = require('../services/masterSheet.service');
const { logger } = require('../utils/logger');
const { emitIndexBuild, broadcast } = require('../utils/sse');
const { logAbnormal } = require('../services/errorLog.service');
const pool = require('../db/pool');
let rawMirrorRunning = false;
let reconcileRunning = false;
// [REMOVED] readSheet — 세부목록→DB 자동동기화 CRON 제거됨 (DB가 원본)

/**
 * ★ CRON 최적화 (v11.8.0 — 2탭 통합):
 *   1. [REMOVED] 설정 동기화(Group B) — DB가 설정 원본이므로 시트→DB 동기화 불필요
 *   2. Dirty Check + 자동 빌드: 15분마다 → 변경 시트 자동 개별 빌드
 *   3. 인덱스 전체 빌드: 하루 2회 (09시, 15시)
 *   4. 전체 재빌드: 하루 1회 새벽 4시
 */
function startCronJobs() {
  // [DEPRECATED — v11.8.0] Group B 설정 동기화 CRON 제거
  // DB가 설정 원본이므로 시트→DB 설정 동기화가 불필요합니다.
  // 설정은 웹 UI(POST /api/tab/config)에서 직접 DB에 저장됩니다.

  // ── ★ Dirty Check + 자동 빌드: 15분마다 ──
  cron.schedule('*/15 9-19 * * 1-6', async () => {
    try {
      const dirtySheets = await checkDirtySheets();
      if (dirtySheets.length === 0) return;

      logger.info(`[CRON-Dirty] 변경 감지: ${dirtySheets.length}개 시트 — ${dirtySheets.map(s => s.campaignName).join(', ')}`);
      broadcast('dirty_detected', {
        message: `${dirtySheets.length}개 시트에 변경사항 감지 → 자동 갱신 시작`,
        dirtyCount: dirtySheets.length,
        dirtySheets,
      });

      // ★ 변경된 시트만 순차적으로 개별 빌드
      let builtCount = 0, failCount = 0;
      for (const dirty of dirtySheets) {
        try {
          const result = await buildOneSheet(dirty.sheetId);
          if (result.ok) {
            builtCount++;
            logger.info(`[CRON-Dirty] 자동 빌드 완료: ${dirty.campaignName} (rebuilt=${result.rebuilt}, ${result.elapsed})`);
          } else {
            logger.warn(`[CRON-Dirty] 자동 빌드 스킵: ${dirty.campaignName} — ${result.error || 'locked'}`);
            break;
          }
        } catch (err) {
          failCount++;
          logger.error(`[CRON-Dirty] 자동 빌드 실패: ${dirty.campaignName} — ${err.message}`);
        }
      }

      if (builtCount > 0) {
        emitIndexBuild({
          rebuilt: builtCount,
          skipped: 0,
          errors: failCount,
          trigger: 'dirty_auto',
          message: `Dirty 자동 빌드: ${builtCount}개 시트 갱신`,
        });
        broadcast('dirty_auto_built', {
          message: `${builtCount}개 변경 시트 자동 갱신 완료`,
          builtCount,
          failCount,
        });
      }
    } catch (err) {
      logger.warn(`[CRON-Dirty] 변경 감지 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 인덱스 전체 빌드: 하루 2회 (09시, 15시) ──
  // RAW mirror dirty check: keep DB source data close to manually edited Sheets.
  if (process.env.RAW_MIRROR_CRON_ENABLED !== 'false') {
    const rawMirrorSchedule = process.env.RAW_MIRROR_CRON_SCHEDULE || '*/5 * * * *';
    cron.schedule(rawMirrorSchedule, async () => {
      if (rawMirrorRunning) {
        logger.debug('[CRON-RawMirror] previous run still active, skip');
        return;
      }
      const throttle = getThrottleStatus();
      const busyThreshold = parseInt(process.env.RAW_MIRROR_BUSY_THRESHOLD || '10', 10);
      if (throttle.requestsInLastMinute > busyThreshold) {
        logger.debug(`[CRON-RawMirror] throttle busy (${throttle.requestsInLastMinute}/${throttle.limit}), skip`);
        return;
      }
      rawMirrorRunning = true;
      try {
        const result = await mirrorAllSheets({ force: false, includeHidden: true });
        if ((result.tabsMirrored || 0) > 0 || (result.errors || 0) > 0) {
          logger.info(`[CRON-RawMirror] tabs=${result.tabsMirrored}, rows=${result.rowsWritten}, skipped=${result.sheetsSkipped}, errors=${result.errors}, elapsed=${result.elapsed}`);
        }
      } catch (err) {
        logger.error(`[CRON-RawMirror] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'raw_mirror', error: err, context: { job: 'raw_mirror' } });
      } finally {
        rawMirrorRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 막힌 주문 자동복구(리컨실): 2분마다 — RAW 미러 뒤에 둠(메타 채워진 뒤 복구) ──
  //   pending_no_row/failed/정체 queued 주문을 시트에 다시 밀어넣는다(복구분은 하단 노란행).
  //   읽기 쿼터 부담 0(메타 없는 탭은 skip). 아침 폭주 시 throttle busy면 양보.
  if (process.env.ORDER_RECONCILE_CRON_ENABLED !== 'false') {
    const reconcileSchedule = process.env.ORDER_RECONCILE_CRON_SCHEDULE || '*/2 * * * *';
    cron.schedule(reconcileSchedule, async () => {
      if (reconcileRunning) return;
      // ★ AUTO 배치 시 cron reconcile 양보: 배치 스케줄러가 탭별 reconcile-first(DB-only, 시트콜0)를
      //   직접 수행하므로 이 cron은 order_reconcile 락만 점유해 배치 드레인을 skip시키는 역효과.
      //   AUTO=1이면 cron reconcile 비활성(배치가 전탭 FIFO 순회로 reconcile 커버). AUTO 끄면 복귀.
      if (process.env.ORDER_BATCH_AUTO === '1') return;
      const throttle = getThrottleStatus();
      const busyThreshold = parseInt(process.env.ORDER_RECONCILE_BUSY_THRESHOLD || '20', 10);
      if (throttle.requestsInLastMinute > busyThreshold) {
        logger.debug(`[CRON-Reconcile] throttle busy (${throttle.requestsInLastMinute}/${throttle.limit}), skip`);
        return;
      }
      reconcileRunning = true;
      try {
        const { reconcileStuckOrders } = require('../services/orderLedger.service');
        const { withJobLock } = require('../utils/jobLock');
        // ★ #1: 멀티인스턴스/rolling 배포(old+new 공존) 경합 차단 — order_reconcile advisory lock으로
        //   cron·flush·인라인 reconcile을 하나로 직렬화. 다른 인스턴스가 보유 중이면 이번 틱은 양보.
        const r = await withJobLock('order_reconcile', () => reconcileStuckOrders({ limit: 100, perTabCap: 60 }));
        if (r && (r.requeued > 0 || r.stillStuck > 0 || r.noCandidates > 0)) {
          logger.info(`[CRON-Reconcile] requeued=${r.requeued}, skippedNoMeta=${r.skippedNoMeta}, noCandidates=${r.noCandidates}, stillStuck=${r.stillStuck}`);
        } else if (r && r.skipped) {
          logger.debug('[CRON-Reconcile] order_reconcile lock busy — 다른 인스턴스 처리 중, 양보');
        }
      } catch (err) {
        logger.error(`[CRON-Reconcile] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'order_reconcile', error: err, context: { job: 'order_reconcile' } });
      } finally {
        reconcileRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9,15 * * 1-6';
  cron.schedule(schedule, async () => {
    logger.info(`[CRON] 인덱스 빌드 시작: ${new Date().toISOString()}`);
    try {
      const result = await buildIndexSmart(false);
      logger.info(`[CRON] 인덱스 빌드 완료: rebuilt=${result.rebuilt}, skipped=${result.skipped}, ${result.elapsed}`);
      emitIndexBuild({ rebuilt: result.rebuilt || 0, skipped: result.skipped || 0, errors: result.errors || 0, elapsed: result.elapsed || '', trigger: 'cron' });
    } catch (err) {
      logger.error(`[CRON] 인덱스 빌드 오류: ${err.message}`);
      logAbnormal({ flow: 'cron', step: 'index_build', error: err, context: { job: '인덱스 빌드' } });
    }
  }, {
    timezone: 'Asia/Seoul',
  });

  // ── 전체 재빌드: 하루 1회 새벽 4시 ──
  cron.schedule('0 4 * * *', async () => {
    logger.info('[CRON] 전체 재빌드 시작 (일일 1회)');
    try {
      await buildIndexSmart(true);
      logger.info('[CRON] 전체 재빌드 완료');
      emitIndexBuild({ trigger: 'cron_full' });
    } catch (err) {
      logger.error(`[CRON] 전체 재빌드 오류: ${err.message}`);
      logAbnormal({ flow: 'cron', step: 'index_build', error: err, context: { job: '전체 재빌드' } });
    }
  }, { timezone: 'Asia/Seoul' });

  // ── Phase 2: Sync Queue 워커 — 30초마다 pending 작업 처리 ──
  // ★ A2: stuck processing 자동 감지 포함
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const result = await processQueue(10);
      if (result.processed > 0) {
        logger.info(`[CRON-Queue] 처리: ${result.succeeded}/${result.processed} 성공, ${result.failed} 실패, ${result.elapsed}ms`);
      }
    } catch (err) {
      logger.error(`[CRON-Queue] 큐 처리 오류: ${err.message}`);
      logAbnormal({ flow: 'sync_queue', step: 'process_queue', error: err, context: { job: '큐 워커' } });
    }
  });

  // ── ★ 상시 배치 드레인 백스톱 — 15초마다 백로그 탭을 배치로 시트반영(근실시간) ──
  //   ORDER_BATCH_AUTO=1 일 때만 동작(kickOrderBatch 내부 게이트). 코얼레싱이라 중복 사이클 없음.
  //   제출 시 즉시 kick + 이 15초 cron이 백스톱(kick 누락·재시작 잔여분 흡수).
  cron.schedule('*/15 * * * * *', () => {
    try { require('../jobs/orderBatchScheduler').kickOrderBatch(); }
    catch (err) { logger.warn(`[CRON-OrderBatch] kick 실패(무시): ${err.message}`); }
  });

  // ── ★ A2+C2: 매시간 stuck/failed 자동 복구 ──
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await retryAllFailed();
      if (result.retried > 0 || result.unstuck > 0 || result.resetExhausted > 0) {
        logger.info(`[CRON-Queue] 자동 복구: retried=${result.retried}, unstuck=${result.unstuck}, resetExhausted=${result.resetExhausted}`);
      }
    } catch (err) {
      logger.error(`[CRON-Queue] 자동 복구 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 완료된 큐 항목 정리: 매일 새벽 3시 (24시간 이상 경과) ──
  cron.schedule('0 3 * * *', async () => {
    try {
      const result = await purgeCompleted(24);
      logger.info(`[CRON-Queue] 정리: ${result.purged}건 완료 항목 삭제`);
    } catch (err) {
      logger.error(`[CRON-Queue] 정리 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 이상로그(error_logs) 보존 정리: 매일 새벽 3시 30분 ──
  // 해결건은 RETENTION_DAYS(기본 30일) 후, 미해결건은 3배 기간 후 삭제(안전망)
  cron.schedule('30 3 * * *', async () => {
    try {
      const days = parseInt(process.env.ERRORLOG_RETENTION_DAYS || '30', 10);
      const { rowCount } = await pool.query(
        `DELETE FROM error_logs
         WHERE (resolved = TRUE AND resolved_at < NOW() - ($1 || ' days')::interval)
            OR (created_at < NOW() - (($1 * 3) || ' days')::interval)`,
        [days]
      );
      if (rowCount) logger.info(`[CRON-ErrorLog] 정리: ${rowCount}건 삭제 (보존 ${days}일)`);
    } catch (err) {
      logger.error(`[CRON-ErrorLog] 정리 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  logger.info(`[CRON] 스케줄러 등록 완료: dirty+자동빌드=15분, 인덱스=${schedule}, 전체재빌드=매일04시, 큐워커=30초, 자동복구=매시간, 정리=매일03시, 이상로그정리=매일03시30분`);
}

module.exports = { startCronJobs };
