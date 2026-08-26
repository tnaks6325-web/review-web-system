const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const routes = read('server/src/routes/campaign.routes.js');
const trackB = read('server/src/services/trackB.service.js');
const control = read('frontend/js/index-recruit.js');
const workdesk = read('frontend/workdesk.html');
const generic = routes.indexOf("router.get('/:id'");
const adminList = routes.indexOf("router.get('/admin/list', authMiddleware, adminOrMasterMiddleware, _adminCampaignList);");
const audit = routes.indexOf("router.get('/admin/popular-credit-audit', authMiddleware, adminOrMasterMiddleware");

assert(adminList >= 0 && adminList < generic, 'admin list must precede generic /:id route');
assert(audit >= 0 && audit < generic, 'audit must precede generic /:id route');
assert(routes.includes('COALESCE(ca.is_popular_snapshot, rc.is_popular)'), 'observability must use immutable application popularity snapshot');
assert(routes.includes('ROW_NUMBER() OVER (PARTITION BY ca.phone8 ORDER BY ca.submitted_at, ca.id)'), 'normal credits must be FIFO ordered');
assert(routes.includes('WHERE ns.id = ca.id) AS popular_purpose'), 'control API must return the matched purpose marker');
assert(trackB.includes('WHERE os.id = cp.order_submission_id'), 'workdesk marker must follow the linked order only');
assert(trackB.includes('popularPurpose: showEdits && r.popularPurpose === true'), 'workdesk marker must remain internal-only');
assert(control.includes('🔥 인기상품목적 참여건'), 'control UI must label the matched entry');
assert(workdesk.includes('🔥 인기상품목적 참여건'), 'workdesk UI must label the matched entry');
assert(workdesk.includes('이후 인기상품 참여권으로 실제 사용되었습니다'), 'workdesk detail must explain the label');

console.log('popularCreditObservability: passed');
