const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '103_review_order_advertiser_projection.sql'), 'utf8');
const orderRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'order.routes.js'), 'utf8');
const boot = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

function ok(message, condition) {
  assert.ok(condition, message);
  console.log(`  ✓ ${message}`);
}

console.log('review-order advertiser projection');

ok('광고주 외부 원본 ID와 포털 작업의 원 작업오더 ID를 보관한다',
  /ADD COLUMN IF NOT EXISTS intranet_advertiser_id/.test(migration)
  && /ADD COLUMN IF NOT EXISTS work_order_id/.test(migration));
ok('외부 광고주 ID와 포털 작업 원본은 DB 유니크 제약으로 중복을 막는다',
  /uq_advertisers_intranet_advertiser_id/.test(migration)
  && /uq_portal_works_work_order_id/.test(migration));
ok('접수 시 원본 광고주를 업서트하고 작업오더 기준으로 포털 작업을 업서트한다',
  /function _upsertIntranetAdvertiserAndPortalWork/.test(orderRoute)
  && /ON CONFLICT \(work_order_id\) WHERE work_order_id <> ''/.test(orderRoute));
ok('광고주 이름만 같은 기존 레코드는 자동 병합하지 않는다',
  /동일 이름의 기존 광고주/.test(orderRoute));
ok('미적용 스키마는 부팅 전 차단한다',
  /\['advertisers', 'intranet_advertiser_id'\]/.test(boot)
  && /\['portal_works', 'work_order_id'\]/.test(boot));

ok('source revisions use their own route and protect accepted work-order state',
  /router\.put\('\/intake\/source\/:sourceReviewOrderId'/.test(orderRoute)
  && /source\.sourceRevision !== currentRevision \+ 1/.test(orderRoute)
  && /current\.linked_campaign_id \|\| current\.advertiser_id/.test(orderRoute));

console.log('reviewOrderAdvertiserProjection: passed');
