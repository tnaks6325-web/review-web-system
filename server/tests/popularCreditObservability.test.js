const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const routes = read('server/src/routes/campaign.routes.js');
const trackB = read('server/src/services/trackB.service.js');
const creditService = read('server/src/services/popularCredit.service.js');
const control = read('frontend/js/index-recruit.js');
const workdesk = read('frontend/workdesk.html');
const generic = routes.indexOf("router.get('/:id'");
const adminList = routes.indexOf("router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, _adminCampaignList);");
const audit = routes.indexOf("router.get('/admin/popular-credit-audit', authMiddleware, adminOrMasterMiddleware");

assert(adminList >= 0 && adminList < generic, 'admin list must precede generic /:id route');
assert(audit >= 0 && audit < generic, 'audit must precede generic /:id route');
assert(creditService.includes('COALESCE(ca.is_popular_snapshot, rc.is_popular)'), 'shared matcher must use immutable application popularity snapshot');
assert(creditService.includes('ca.submitted_at BETWEEN $1 AND $2'), 'shared matcher must use the rolling three-day window');
assert(creditService.includes('const credit = queue.credits[queue.next]'), 'shared matcher must consume FIFO credits in linear time');
assert(routes.includes('loadPopularCreditMatches(pool, null, { evaluatedAt })'), 'audit must use the shared matcher');
assert(routes.includes('popular_purpose: purposeMatches.matchedNormalIds.has(String(r.id))'), 'control API must use the shared purpose marker');
assert(trackB.includes('purpose_app.id AS "popularPurposeApplicationId"'), 'workdesk marker must follow the linked order application');
assert(trackB.includes("popularPurpose: showEdits && popularPurposeIds.has(String(r.popularPurposeApplicationId || ''))"),
  'workdesk marker must use the shared matcher and remain internal-only');
assert(control.includes('🔥 인기상품목적 참여건'), 'control UI must label the matched entry');
assert(workdesk.includes('🔥 인기상품목적 참여건'), 'workdesk UI must label the matched entry');
assert(workdesk.includes('이후 인기상품 참여권으로 실제 사용되었습니다'), 'workdesk detail must explain the label');

console.log('popularCreditObservability: passed');
