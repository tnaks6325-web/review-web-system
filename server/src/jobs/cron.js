const cron = require('node-cron');
const { buildIndexSmart, checkDirtySheets, buildOneSheet } = require('../services/indexBuilder.service');
const { processQueue, purgeCompleted, retryAllFailed } = require('../services/syncQueue.service');
// [DEPRECATED — v11.8.0] syncSettingsOnly 제거: DB가 설정 원본이므로 시트→DB 동기화 불필요
// const { syncSettingsOnly } = require('../services/masterSheet.service');
const { logger } = require('../utils/logger');
const { emitIndexBuild, broadcast } = require('../utils/sse');
// [REMOVED] readSheet, pool — 세부목록→DB 자동동기화 CRON 제거됨 (DB가 원본)

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
  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9,15 * * 1-6';
  cron.schedule(schedule, async () => {
    logger.info(`[CRON] 인덱스 빌드 시작: ${new Date().toISOString()}`);
    try {
      const result = await buildIndexSmart(false);
      logger.info(`[CRON] 인덱스 빌드 완료: rebuilt=${result.rebuilt}, skipped=${result.skipped}, ${result.elapsed}`);
      emitIndexBuild({ rebuilt: result.rebuilt || 0, skipped: result.skipped || 0, errors: result.errors || 0, elapsed: result.elapsed || '', trigger: 'cron' });
    } catch (err) {
      logger.error(`[CRON] 인덱스 빌드 오류: ${err.message}`);
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
    }
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

  logger.info(`[CRON] 스케줄러 등록 완료: dirty+자동빌드=15분, 인덱스=${schedule}, 전체재빌드=매일04시, 큐워커=30초, 자동복구=매시간, 정리=매일03시`);
}

module.exports = { startCronJobs };
