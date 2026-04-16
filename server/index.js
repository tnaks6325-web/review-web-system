require('dotenv').config();
const app = require('./src/app');
const { startCronJobs } = require('./src/jobs/cron');
const { logger } = require('./src/utils/logger');

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`✅ 리뷰웹시스템 API 서버 시작: http://0.0.0.0:${PORT}`);
  logger.info(`   환경: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   DB: ${process.env.DATABASE_URL ? '연결됨' : '❌ DATABASE_URL 미설정'}`);
  logger.info(`   Google: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? '설정됨' : '⚠️ 미설정'}`);

  // 스케줄러 시작 (GAS 트리거 대체)
  if (process.env.NODE_ENV === 'production') {
    startCronJobs();
    logger.info('✅ 인덱스 빌드 스케줄러 시작됨');
  } else {
    logger.info('⏭ 개발 환경 — 스케줄러 비활성화 (수동 빌드 사용)');
  }
});

// ── Graceful Shutdown (Railway / Docker 대응) ──
function gracefulShutdown(signal) {
  logger.info(`${signal} 수신 — 서버 종료 시작...`);
  server.close(() => {
    logger.info('✅ HTTP 서버 종료 완료');
    const pool = require('./src/db/pool');
    pool.end().then(() => {
      logger.info('✅ DB 풀 종료 완료');
      process.exit(0);
    }).catch(() => {
      process.exit(0);
    });
  });
  // 10초 후 강제 종료
  setTimeout(() => {
    logger.warn('⚠️ 강제 종료 (타임아웃)');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// 예상치 못한 에러 로깅
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});
