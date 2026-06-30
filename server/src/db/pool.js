const { Pool } = require('pg');
const { logger } = require('../utils/logger');

// Railway, Render 등 외부 PostgreSQL 서비스의 URL에 sslmode=require가 포함될 수 있음
const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;

// ★ 제안D: 풀 크기 env 조정 가능(DB_POOL_MAX). 제출 폭주 시 err의 실제 원인이 시트 throttle가
//   아니라 PG 커넥션 풀 고갈이므로, Railway PG의 max_connections 한도 내에서 상향하면 제출 안정화.
//   기본값은 무변경(프로덕션 20/개발 10) — 무분별 상향이 PG 한도를 넘으면 오히려 연결실패가 나므로,
//   PG max_connections 확인 후 DB_POOL_MAX로 명시 상향 권장(예: 30~40).
const envPoolMax = parseInt(process.env.DB_POOL_MAX || '', 10);
const poolMax = Number.isInteger(envPoolMax) && envPoolMax > 0 ? envPoolMax : (isProduction ? 20 : 10);
const poolConfig = {
  connectionString,
  max: poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: isProduction ? 10000 : 5000,
};

// Railway PostgreSQL은 SSL 필수
if (isProduction && connectionString) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', err.message);
  // 지연 require로 순환참조 회피 (errorLog.service → pool)
  try {
    require('../services/errorLog.service').logAbnormal({
      flow: 'db', category: 'db', source: 'db', severity: 'critical', error: err,
      context: { origin: 'pool.on(error)' },
    });
  } catch (_) { /* noop */ }
});

pool.on('connect', () => {
  logger.info('PostgreSQL: 새 연결 생성');
});

module.exports = pool;
