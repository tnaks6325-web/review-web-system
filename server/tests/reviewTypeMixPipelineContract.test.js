/** 인트라넷 → 작업오더 → 모집공고 혼합 리뷰 구성의 전달 회귀가드. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const reviewRoot = path.join(__dirname, '..', '..');
const readReview = (file) => fs.readFileSync(path.join(reviewRoot, file), 'utf8');
const intranetRoots = [
  process.env.INTRANET_PROJECT_ROOT,
  path.resolve(reviewRoot, '..', '..', '..', 'Documents', '인트라넷 프로젝트'),
  path.resolve(reviewRoot, '..', '인트라넷 프로젝트'),
].filter(Boolean);
const intranetRoot = intranetRoots.find((root) => fs.existsSync(path.join(root, 'public', 'static', 'js', 'review-orders.js')));
const readIntranet = (file) => intranetRoot && fs.readFileSync(path.join(intranetRoot, file), 'utf8');

const intranetUi = readIntranet('public/static/js/review-orders.js');
const intranetApi = readIntranet('src/routes/api.ts');
const orderRoute = readReview('server/src/routes/order.routes.js');
const workOrderUi = readReview('frontend/js/work-order-detail.js');
const recruitUi = readReview('frontend/js/index-recruit.js');
const campaignRoute = readReview('server/src/routes/campaign.routes.js');
const boot = readReview('server/index.js');

if (intranetRoot) {
  assert.match(intranetUi, /reviewOrderReviewTypeMix/);
  assert.match(intranetUi, /review-order-review-confirm-count/);
  assert.match(intranetUi, /review_type_mix:\s*reviewOrderReviewTypeMix\(products\)/);
  assert.match(intranetUi, /review_type_mix:\s*option\.reviewTypeMix\s*\|\|\s*\[\]/);
  assert.match(intranetApi, /'review_type_mix'/);
} else {
  console.log('reviewTypeMixPipelineContract: intranet cross-repository assertions skipped (set INTRANET_PROJECT_ROOT to enable)');
}

assert.match(orderRoute, /review_type_mix JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
assert.match(orderRoute, /_reviewTypeMixJson\(b\.review_type_mix, b\.review_type\)/);
assert.match(orderRoute, /review_type_mix = \$18/);
assert.match(workOrderUi, /review_type_mix: _woIsBlogKind/);

assert.match(recruitUi, /prefill\.review_type_mix/);
assert.match(recruitUi, /payload\.review_type_mix = getRecruitReviewTypeMix\(\)/);
assert.match(campaignRoute, /review_type_mix = CASE WHEN \$40::jsonb/);
assert.match(campaignRoute, /validateReviewTypeMix/);
assert.match(boot, /\['work_orders', 'review_type_mix'\]/);
assert.match(boot, /\['recruit_campaigns', 'review_type_mix'\]/);

console.log('reviewTypeMixPipelineContract: Review Web contract assertions passed');
