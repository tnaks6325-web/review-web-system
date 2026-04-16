require('dotenv').config();
const app = require('./src/app');
const { startCronJobs } = require('./src/jobs/cron');
const { logger } = require('./src/utils/logger');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`✅ 리뷰웹시스템 API 서버 시작: http://localhost:${PORT}`);
  logger.info(`   환경: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   DB: ${process.env.DATABASE_URL ? '연결됨' : '❌ DATABASE_URL 미설정'}`);

  // 스케줄러 시작 (GAS 트리거 대체)
  if (process.env.NODE_ENV === 'production') {
    startCronJobs();
    logger.info('✅ 인덱스 빌드 스케줄러 시작됨');
  } else {
    logger.info('⏭ 개발 환경 — 스케줄러 비활성화 (수동 빌드 사용)');
  }
});
