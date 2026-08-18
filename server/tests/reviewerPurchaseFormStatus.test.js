const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, '..', 'frontend', 'index.html'), 'utf8');
const search = fs.readFileSync(path.join(root, 'src', 'services', 'search.service.js'), 'utf8');
const migrationPath = path.join(root, 'migrations', '120_cleanup_reflected_failed_orders.sql');

assert.match(page, /function _hasPurchaseFormReflected\(item\)/,
  'workboard rows must expose purchase-form reflection independently of review submission');
assert.match(page, /구매양식 반영완료/,
  'a reflected purchase form must have a dedicated badge');
assert.match(page, /리뷰제출대기/,
  'unsubmitted review cards must not be labelled as purchase-form unsubmitted');
assert.match(search, /AND NOT \([\s\S]*FROM review_index ri[\s\S]*ri\.tab_name = rc\.title/,
  'a failed sheetless order already represented by a workboard row must not be appended to reviewer history');

assert.ok(fs.existsSync(migrationPath), 'reflected failed-order cleanup migration must exist');
const migration = fs.readFileSync(migrationPath, 'utf8');
assert.match(migration, /os\.sheet_id LIKE 'campaign:%'/,
  'cleanup must be limited to sheetless virtual orders');
assert.match(migration, /os\.mirror_status IN \('failed', 'stuck_manual'\)/,
  'cleanup must only target stale failed manual states');
assert.match(migration, /ri\.phone8 = RIGHT\(regexp_replace\(COALESCE\(os\.phone, ''\)/,
  'cleanup must require the same reviewer phone');
assert.match(migration, /ri\.tab_name = rc\.title/,
  'cleanup must require the same campaign title');
assert.match(migration, /COALESCE\(NULLIF\(ri\.row_json->>'주문번호', ''\), ''\) <> ''/,
  'cleanup must require a recorded workboard order number');

console.log('reviewer purchase-form status contract passed');
