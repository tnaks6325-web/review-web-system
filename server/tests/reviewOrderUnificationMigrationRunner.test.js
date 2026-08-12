const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const runner = fs.readFileSync(path.join(root, 'scripts', 'migrate-review-order-unification.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function ok(message, condition) {
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

ok('전용 명령은 이번 출시 범위의 102~108 마이그레이션만 명시적으로 적용한다',
  /102_review_order_unification_foundation\.sql/.test(runner)
  && /103_review_order_advertiser_projection\.sql/.test(runner)
  && /104_campaign_weekend_publication\.sql/.test(runner)
  && /105_campaign_cash_receipt_required\.sql/.test(runner)
  && /106_campaign_review_type_mix\.sql/.test(runner)
  && /107_work_order_review_type_mix\.sql/.test(runner)
  && /108_campaign_option_url\.sql/.test(runner)
  && !/readdirSync\(migrationsDir\)/.test(runner));

ok('각 SQL 파일은 개별 트랜잭션으로 적용하며 실패 시 롤백한다',
  /client\.query\('BEGIN'\)/.test(runner)
  && /client\.query\(sql\)/.test(runner)
  && /client\.query\('COMMIT'\)/.test(runner)
  && /client\.query\('ROLLBACK'\)/.test(runner));

ok('운영자가 실수로 전체 실행 대신 전용 명령을 선택할 수 있다',
  pkg.scripts['migrate:review-order-unification'] === 'node scripts/migrate-review-order-unification.js');

console.log('reviewOrderUnificationMigrationRunner: passed');
