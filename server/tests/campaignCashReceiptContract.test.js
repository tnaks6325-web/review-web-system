/**
 * 현금영수증 발행 여부는 모집공고가 직접 소유한다.
 * 작업오더/시트 설정 파생만으로 두면 무시트 공고에서 안내·배지가 사라진다.
 * 실행: node tests/campaignCashReceiptContract.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const routes = read('src/routes/campaign.routes.js');
const app = read('../frontend/js/index-recruit.js');
const modal = read('../frontend/js/recruit-modal.js');
const bootstrap = read('index.js');
const migration = read('migrations/105_campaign_cash_receipt_required.sql');

assert.match(migration, /ADD COLUMN IF NOT EXISTS cash_receipt_required BOOLEAN NOT NULL DEFAULT FALSE/);
assert.match(bootstrap, /\['recruit_campaigns', 'cash_receipt_required'\]/);

assert.match(modal, /id="rf_cash_receipt_required"/);
assert.doesNotMatch(modal, /addPresetBadge\('현영건'\)/);
assert.match(modal, /onchange="syncRecruitAutomaticBadges\(\)"/);
assert.match(app, /rf_cash_receipt_required.*checked = false/);
assert.match(app, /rf_cash_receipt_required.*c\.cash_receipt_required/);
assert.match(app, /cash_receipt_required:\s*!!document\.getElementById\("rf_cash_receipt_required"\)\?\.checked/);
assert.match(app, /cashReceiptRequired:\s*!!document\.getElementById\("rf_cash_receipt_required"\)\?\.checked/);
assert.match(app, /const _PREVIEW_CHECKS = \["rf_cash_receipt_required"\]/);
assert.match(app, /function syncRecruitAutomaticBadges\(\)/);
assert.match(app, /AUTOMATIC_RECRUIT_BADGES/);
assert.match(app, /if \(required\) next\.push\('현영건'\)/);

assert.match(routes, /cash_receipt_required,\s*\/\/ 모집공고 직접 설정/);
assert.match(routes, /cash_receipt_required\)\s*\n\s*VALUES/);
assert.match(routes, /cash_receipt_required = COALESCE/);
assert.match(routes, /cash_receipt_required === true/);
assert.match(routes, /r\.cash_receipt_required === true/);
assert.match(routes, /carry_mode, skip_weekends, cash_receipt_required/);

console.log('campaignCashReceiptContract: 19 passed');
