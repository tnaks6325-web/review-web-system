/**
 * 데이터베이스 마이그레이션 실행
 * 실행: node src/db/migrate.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const pool = require('./pool');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} migration file(s)`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`Running: ${file}...`);
    try {
      await pool.query(sql);
      console.log(`  ✅ ${file} 완료`);
    } catch (err) {
      console.error(`  ❌ ${file} 오류:`, err.message);
      throw err;
    }
  }

  console.log('✅ 모든 마이그레이션 완료');
  await pool.end();
}

migrate().catch(err => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
