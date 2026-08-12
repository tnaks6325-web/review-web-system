/**
 * 작업오더 기반 모집공고는 무시트 작업표를 서버가 자동 연결한다.
 * 운영자가 과거 구글시트/탭을 다시 고르게 하면 안 된다.
 * 실행: node tests/recruitSheetlessSourceContract.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const modal = read('../frontend/js/recruit-modal.js');
const app = read('../frontend/js/index-recruit.js');
const routes = read('src/routes/campaign.routes.js');

assert.match(modal, /id="rf_sheet_link_row"/);
assert.match(modal, /id="rf_link_heading_note"/);
assert.match(app, /rf_sheet_link_row/);
assert.match(app, /function _syncSourceWorkOrderLinkUi\(\)[\s\S]{0,350}_woPrefillOrderId[\s\S]{0,350}rf_sheet_link_row/);
assert.match(app, /if \(\(!tabKey[\s\S]{0,100}&& !_woPrefillOrderId\)/);
assert.match(app, /작업오더 작업표 자동 연결/);
assert.match(app, /작업오더 작업표에 자동 연결됩니다/);

const createRoute = routes.slice(routes.indexOf("router.post('/admin/create'"), routes.indexOf("router.put('/admin/:id'"));
assert.ok(
  createRoute.indexOf('_linkedTabFromWorkOrder(source_work_order_id)') < createRoute.indexOf('_participationActivationErrors('),
  '서버는 활성화 검사 전에 작업오더의 무시트 작업표를 자동 연결한다'
);

console.log('recruitSheetlessSourceContract: 8 passed');
