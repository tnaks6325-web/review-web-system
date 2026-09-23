const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const campaign = read('src/routes/campaign.routes.js');
const trackB = read('src/services/trackB.service.js');
const workdesk = read('../frontend/workdesk.html');
const recruit = read('../frontend/js/index-recruit.js');
const migration = read('migrations/145_workboard_display_name.sql');

assert.match(migration, /ADD COLUMN IF NOT EXISTS workboard_display_name TEXT NOT NULL DEFAULT ''/,
  '탭별 표시명 컬럼이 있어야 합니다.');
assert.match(campaign, /INSERT INTO tab_configs \(sheet_id, tab_name, workboard_display_name, updated_at\)/,
  '표시명은 연결된 탭 설정에만 저장해야 합니다.');
assert.match(campaign, /workboard_display_name = EXCLUDED\.workboard_display_name/,
  '같은 탭에서 표시명은 갱신 가능해야 합니다.');
const saveStart = campaign.indexOf('async function _saveWorkboardDisplayName');
const saveEnd = campaign.indexOf('\n}\n', saveStart) + 2;
const saveBlock = campaign.slice(saveStart, saveEnd);
assert.ok(!/campaign_participants|order_submissions|campaign_options/.test(saveBlock),
  '표시명 저장은 주문·참여·상품 원본을 건드리면 안 됩니다.');
assert.match(trackB, /tc\.workboard_display_name AS "workboardDisplayName"/,
  '내부 작업보드 조건에 표시명이 전달되어야 합니다.');
assert.match(trackB, /workboardDisplayName: cd\.workboardDisplayName \|\| null/,
  '업체용 렌즈도 표시명을 전달해야 합니다.');
const trackBService = require('../src/services/trackB.service');
assert.strictEqual(
  trackBService.__condAdvertiserLensForTest({ workboardDisplayName: '짧은 작업명', productName: '실제 상품명' }).workboardDisplayName,
  '짧은 작업명',
  '업체용 렌즈는 표시명을 유지해야 합니다.',
);
assert.match(recruit, /작업보드 표시명/,
  '모집공고 설정에 표시명 입력칸이 있어야 합니다.');
assert.match(recruit, /payload\.workboard_display_name = workboardDisplayNameInput\.value\.trim\(\)/,
  '모집공고 저장이 표시명을 전송해야 합니다.');
assert.match(workdesk, /const prod=workboardDisplayName\|\|String\(cd\.productName/,
  '작업 조건은 표시명을 우선해 보여야 합니다.');
assert.match(workdesk, /if\(displayName&&_isWorkboardProductHeader\(h\)\) return displayName;/,
  '그리드와 내려받기는 표시명만 덮어써야 합니다.');
assert.match(workdesk, /_cndFix\('displayName'\)/,
  '내부 작업 조건의 상품명을 누르면 모집공고 설정을 열어야 합니다.');

console.log('✓ 작업보드 표시명: 탭 단위 저장 · 내부/업체 표시 · 실제 상품 원본 보존');
