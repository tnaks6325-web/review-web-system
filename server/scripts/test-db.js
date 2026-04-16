#!/usr/bin/env node
/**
 * PostgreSQL 연결 및 테이블 상태 테스트 스크립트
 * 
 * 사용법:
 *   DATABASE_URL=postgresql://... node scripts/test-db.js
 * 
 * 또는 .env 파일에 설정 후:
 *   cd server && node scripts/test-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { Pool } = require('pg');

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  PostgreSQL 연결 및 테이블 상태 테스트');
  console.log('═══════════════════════════════════════════');
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.log('❌ DATABASE_URL이 설정되지 않았습니다.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    // 1. 연결 테스트
    console.log('▶ 연결 테스트...');
    const { rows: [{ now }] } = await pool.query('SELECT NOW() AS now');
    console.log(`  ✅ 연결 성공: ${now}`);
    console.log('');

    // 2. 테이블 목록
    console.log('▶ 테이블 목록:');
    const { rows: tables } = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    tables.forEach(t => console.log(`  - ${t.table_name}`));
    console.log(`  총 ${tables.length}개 테이블`);
    console.log('');

    // 3. 각 테이블 행 수
    console.log('▶ 테이블별 행 수:');
    for (const t of tables) {
      const { rows: [{ count }] } = await pool.query(`SELECT COUNT(*) FROM ${t.table_name}`);
      console.log(`  ${t.table_name}: ${count}행`);
    }
    console.log('');

    // 4. 빌드 잠금 상태
    console.log('▶ 빌드 잠금 상태:');
    const { rows: locks } = await pool.query('SELECT * FROM build_locks');
    locks.forEach(l => console.log(`  ${l.lock_key}: locked=${l.is_locked}`));
    console.log('');

    console.log('═══════════════════════════════════════════');
    console.log('  ✅ 데이터베이스 테스트 완료');
    console.log('═══════════════════════════════════════════');
  } catch (err) {
    console.error('❌ 에러:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
