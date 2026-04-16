const { Pool } = require('pg');
const { logger } = require('../utils/logger');

// Railway, Render 등 외부 PostgreSQL 서비스의 URL에 sslmode=require가 포함될 수 있음
const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;

const poolConfig = {
  connectionString,
  max: isProduction ? 20 : 10,              // 프로덕션은 풀 크기 증가
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
});

pool.on('connect', () => {
  logger.info('PostgreSQL: 새 연결 생성');
});

module.exports = pool;
