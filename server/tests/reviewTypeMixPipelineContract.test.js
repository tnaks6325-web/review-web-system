/** 인트라넷 → 작업오더 → 모집공고 혼합 리뷰 구성의 전달 회귀가드. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const reviewRoot = path.join(__dirname, '..', '..');
const intranetRoot = path.resolve(reviewRoot, '..', '인트라넷 프로젝트');
const readReview = (file) => fs.readFileSync(path.join(reviewRoot, file), 'utf8');
const readIntranet = (file) => fs.readFileSync(path.join(intranetRoot, file), 'utf8');

const intranetUi = readIntranet('public/static/js/review-orders.js');
const intranetApi = readIntranet('src/routes/api.ts');
const orderRoute = readReview('server/src/routes/order.routes.js');
const workOrderUi = readReview('frontend/js/work-order-detail.js');
const recruitUi = readReview('frontend/js/index-recruit.js');
const campaignRoute = readReview('server/src/routes/campaign.routes.js');
const boot = readReview('server/index.js');

assert.match(intranetUi, /reviewOrderReviewTypeMix/);
assert.match(intranetUi, /review-order-review-confirm-count/);
assert.match(intranetUi, /review_type_mix:\s*reviewMix/);
assert.match(intranetApi, /'review_type_mix'/);

assert.match(orderRoute, /review_type_mix JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
assert.match(orderRoute, /_reviewTypeMixJson\(b\.review_type_mix, b\.review_type\)/);
assert.match(orderRoute, /review_type_mix = \$17/);
assert.match(workOrderUi, /review_type_mix: _woIsBlogKind/);

assert.match(recruitUi, /prefill\.review_type_mix/);
assert.match(recruitUi, /payload\.review_type_mix = getRecruitReviewTypeMix\(\)/);
assert.match(campaignRoute, /review_type_mix = CASE WHEN \$40::jsonb/);
assert.match(campaignRoute, /validateReviewTypeMix/);
assert.match(boot, /\['work_orders', 'review_type_mix'\]/);
assert.match(boot, /\['recruit_campaigns', 'review_type_mix'\]/);

console.log('reviewTypeMixPipelineContract: 13 passed');
