const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, '..', 'frontend', 'index.html'), 'utf8');
const search = fs.readFileSync(path.join(root, 'src', 'services', 'search.service.js'), 'utf8');
const migrationPath = path.join(root, 'migrations', '120_cleanup_reflected_failed_orders.sql');

assert.match(page, /function _hasPurchaseFormReflected\(item\)/,
  'workboard rows must expose purchase-form reflection independently of review submission');
// 2026-08-19: 배지가 금액 줄(.fee)에서 상태 배지로 옮겨졌다(7768c3d) — 검사 의미는 그대로
// "반영완료를 말하는 배지가 있다 / 미제출로 부르지 않는다".
// 2026-11-13(결정 371): 반영이 끝난 카드의 배지 글자가 「구매양식반영완료」 → 할 일을 말하는 「리뷰 제출 필요」로 바뀌고,
// 단건·다건이 같은 함수(_pendingCardState)를 쓴다 — 검사 의미 그대로(전용 배지가 있다) + 단일 출처로 강화.
assert.match(page, /return \{ text:'리뷰 제출 필요', tone:'todo', tappable:true/,
  'a reflected purchase form must have a dedicated badge');
assert.match(page, /status-badge-order \$\{st\.tone\}">\$\{escHtml\(st\.text\)\}/,
  'single review cards must draw the badge from the shared card-state function');
assert.doesNotMatch(page, /return "미제출";/,
  'unsubmitted review cards must not be labelled as purchase-form unsubmitted');
assert.match(search, /AND NOT \([\s\S]*FROM review_index ri[\s\S]*ri\.tab_name = rc\.title/,
  'a failed sheetless order already represented by a workboard row must not be appended to reviewer history');
// 제목은 언제든 바뀐다 — 좌표 매칭이 함께 있어야 제목 수정으로 dedup 이 풀리지 않는다.
assert.match(search, /ri\.sheet_id = rc\.linked_sheet_id[\s\S]{0,120}ri\.tab_name = rc\.linked_tab_name/,
  'title-based dedup must also match the linked workboard tab coordinates');

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
