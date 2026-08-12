/**
 * ReviewOrder → WorkOrder → Recruitment 통합 출시 전용 마이그레이션.
 *
 * 과거 전체 마이그레이션을 재실행하지 않고, 이번 기능에서 새로 필요한
 * 102~108번만 파일별 트랜잭션으로 적용한다. 각 SQL은 재실행 가능하도록
 * 작성되어 있어, 연결 중단 뒤 같은 명령을 다시 실행해도 안전하다.
 *
 * 실행: npm run migrate:review-order-unification
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = require('../src/db/pool');

const migrationNames = [
  '102_review_order_unification_foundation.sql',
  '103_review_order_advertiser_projection.sql',
  '104_campaign_weekend_publication.sql',
  '105_campaign_cash_receipt_required.sql',
  '106_campaign_review_type_mix.sql',
  '107_work_order_review_type_mix.sql',
  '108_campaign_option_url.sql'
];

const migrationsDir = path.resolve(__dirname, '../migrations');

async function applyMigration(name) {
  const filePath = path.join(migrationsDir, name);
  if (!fs.existsSync(filePath)) throw new Error(`마이그레이션 파일을 찾을 수 없습니다: ${name}`);

  const sql = fs.readFileSync(filePath, 'utf8');
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`✓ ${name}`);
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw new Error(`${name} 적용 실패: ${error.message}`);
  } finally {
    if (client) client.release();
  }
}

async function run() {
  for (const name of migrationNames) await applyMigration(name);
}

if (require.main === module) {
  run()
    .then(() => {
      console.log('리뷰오더 통합 마이그레이션 적용 완료');
      return pool.end();
    })
    .catch(async (error) => {
      console.error(error.message);
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { migrationNames, applyMigration, run };
