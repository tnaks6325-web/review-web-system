const cron = require('node-cron');
const { buildIndexSmart, checkDirtySheets } = require('../services/indexBuilder.service');
const { processQueue, purgeCompleted } = require('../services/syncQueue.service');
const { logger } = require('../utils/logger');
const { emitIndexBuild, broadcast } = require('../utils/sse');

/**
 * GAS autoRebuildIndex 트리거 대체
 * 평일+토요일 9~19시 매 정시 실행
 */
function startCronJobs() {
  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9-19 * * 1-6';

  // ── 인덱스 빌드: 매 정시 ──
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

  // ── 전체 재빌드: 6시간마다 ──
  cron.schedule('0 */4 * * *', async () => {
    logger.info('[CRON] 전체 재빌드 시작');
    try {
      await buildIndexSmart(true);
      logger.info('[CRON] 전체 재빌드 완료');
      emitIndexBuild({ trigger: 'cron_full' });
    } catch (err) {
      logger.error(`[CRON] 전체 재빌드 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── Phase 4: Dirty Check — 5분마다 변경 감지 (빌드 없이 Drive API만) ──
  cron.schedule('*/5 9-19 * * 1-6', async () => {
    try {
      const dirtySheets = await checkDirtySheets();
      if (dirtySheets.length > 0) {
        logger.info(`[CRON-Dirty] 변경 감지: ${dirtySheets.length}개 시트 — ${dirtySheets.map(s => s.campaignName).join(', ')}`);
        broadcast('dirty_detected', {
          message: `${dirtySheets.length}개 시트에 변경사항 감지`,
          dirtyCount: dirtySheets.length,
          dirtySheets,
        });
      }
    } catch (err) {
      logger.warn(`[CRON-Dirty] 변경 감지 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── Phase 2: Sync Queue 워커 — 30초마다 pending 작업 처리 ──
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

  // ── 완료된 큐 항목 정리: 매일 새벽 3시 (24시간 이상 경과) ──
  cron.schedule('0 3 * * *', async () => {
    try {
      const result = await purgeCompleted(24);
      logger.info(`[CRON-Queue] 정리: ${result.purged}건 완료 항목 삭제`);
    } catch (err) {
      logger.error(`[CRON-Queue] 정리 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  logger.info(`[CRON] 스케줄러 등록 완료: 인덱스=${schedule}, 전체재빌드=4h, dirty=5분, 큐워커=30초, 정리=매일03시`);
}

module.exports = { startCronJobs };
