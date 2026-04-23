require('dotenv').config();
const app = require('./src/app');
const { startCronJobs } = require('./src/jobs/cron');
const { startSmartBuild } = require('./src/services/smartBuild.service');
const { logger } = require('./src/utils/logger');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── 서버 시작 전 자동 마이그레이션 (이력 추적) ──
async function runMigrations() {
  const pool = require('./src/db/pool');
  const migrationsDir = path.resolve(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  // 마이그레이션 이력 테이블 생성 (최초 1회)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 이미 적용된 마이그레이션 조회
  const { rows: applied } = await pool.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map(r => r.filename));

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let newCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      continue; // 이미 적용됨 → 건너뛰기
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      logger.info(`[migrate] ✅ ${file} 적용 완료`);
      newCount++;
    } catch (err) {
      // IF NOT EXISTS 패턴의 무해한 에러는 적용 완료로 처리
      if (err.message.includes('already exists') || err.message.includes('duplicate')) {
        await pool.query('INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        logger.info(`[migrate] ⏭ ${file} (이미 적용됨)`);
      } else {
        logger.warn(`[migrate] ⚠️ ${file}: ${err.message}`);
      }
    }
  }

  if (newCount > 0) {
    logger.info(`[migrate] 🎉 ${newCount}개 마이그레이션 새로 적용 (총 ${files.length}개)`);
  } else {
    logger.info(`[migrate] 모든 마이그레이션 적용 완료 (${files.length}개)`);
  }
}

// ── 서버 시작 ──
(async () => {
  try {
    await runMigrations();
  } catch (err) {
    logger.warn(`[migrate] 마이그레이션 오류 (서버는 계속 시작): ${err.message}`);
  }

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
      logger.info('⏭ 개발 환경 — 기존 CRON 스케줄러 비활성화 (수동 빌드 사용)');
    }

    // ★ 스마트 빌드 스케줄러 시작 (환경 무관 — 5분 주기)
    startSmartBuild();
    logger.info('✅ 스마트 빌드 스케줄러 시작됨 (5분 주기, Drive+Sheets API)');
  });

  // ── Graceful Shutdown (Railway / Docker 대응) ──
  function gracefulShutdown(signal) {
    logger.info(`${signal} 수신 — 서버 종료 시작...`);
    // 스마트 빌드 스케줄러 정지
    const { stopSmartBuild } = require('./src/services/smartBuild.service');
    stopSmartBuild();
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
})();

// 예상치 못한 에러 로깅
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});
