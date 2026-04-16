const cron = require('node-cron');
const { buildIndexSmart } = require('../services/indexBuilder.service');
const { logger } = require('../utils/logger');

/**
 * GAS autoRebuildIndex 트리거 대체
 * 평일+토요일 9~19시 매 정시 실행
 */
function startCronJobs() {
  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9-19 * * 1-6';

  cron.schedule(schedule, async () => {
    logger.info(`[CRON] 인덱스 빌드 시작: ${new Date().toISOString()}`);
    try {
      const result = await buildIndexSmart(false);
      logger.info(`[CRON] 인덱스 빌드 완료: rebuilt=${result.rebuilt}, skipped=${result.skipped}, ${result.elapsed}`);
    } catch (err) {
      logger.error(`[CRON] 인덱스 빌드 오류: ${err.message}`);
    }
  }, {
    timezone: 'Asia/Seoul',
  });

  // 전체 재빌드: 6시간마다
  cron.schedule('0 */6 * * *', async () => {
    logger.info('[CRON] 전체 재빌드 시작');
    try {
      await buildIndexSmart(true);
      logger.info('[CRON] 전체 재빌드 완료');
    } catch (err) {
      logger.error(`[CRON] 전체 재빌드 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  logger.info(`[CRON] 스케줄러 등록 완료: ${schedule}`);
}

module.exports = { startCronJobs };
