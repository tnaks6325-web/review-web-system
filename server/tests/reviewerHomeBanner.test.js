'use strict';
const assert = require('assert');
const fs = require('fs');
const { normalizeStoredBanner, validateBannerInput, toPublicBanner } = require('../src/utils/reviewerHomeBanner');

const imageUrl = 'https://example.com/api/order/guide-image/abcdefghijklmnopqrstuvwxyz';

assert.strictEqual(validateBannerInput({ active: true, imageUrl, clickUrl: 'https://advertiser.example/promo' }).ok, true);
assert.strictEqual(validateBannerInput({ active: true, imageUrl, clickUrl: 'javascript:alert(1)' }).ok, false);
assert.strictEqual(validateBannerInput({ active: true, imageUrl, clickUrl: 'https://user:pass@advertiser.example/' }).ok, false);
assert.strictEqual(toPublicBanner({ active: false, imageUrl, clickUrl: 'https://advertiser.example/' }), null);
assert.strictEqual(toPublicBanner({ active: true, imageUrl, clickUrl: 'https://advertiser.example/' }).width, 1080);
assert.strictEqual(normalizeStoredBanner('not-json').active, false);
const reviewerRoutes = fs.readFileSync(require.resolve('../src/routes/reviewer.routes'), 'utf8');
const trackBRoutes = fs.readFileSync(require.resolve('../src/routes/trackB.routes'), 'utf8');
const home = fs.readFileSync(require.resolve('../../frontend/index.html'), 'utf8');
const settings = fs.readFileSync(require.resolve('../../frontend/js/admin-settings.js'), 'utf8');
assert.match(reviewerRoutes, /router\.get\('\/home-banner'/);
assert.match(reviewerRoutes, /router\.post\('\/home-banner\/save', authMiddleware, adminOrMasterMiddleware/);
assert.match(trackBRoutes, /settings\/home-banner/);
assert.match(home, /id="reviewerHomeBanner"/);
assert.match(home, /target="_blank" rel="noopener noreferrer"/);
assert.match(settings, /권장 이미지 크기: 1080 × 240px/);
console.log('reviewer home banner validation tests passed');
