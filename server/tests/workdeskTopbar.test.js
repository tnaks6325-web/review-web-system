// 작업보드 상단 업체목록 드래그 배치 + 업체별 작업 드롭다운 회귀가드.
// 인라인 스크립트는 브라우저 전용이므로, 사용자 계약을 만드는 HTML/CSS/배선만 빠르게 검증한다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/workdesk.html'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server/src/routes/trackB.routes.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'server/migrations/143_trackb_workdesk_advertiser_order.sql'), 'utf8');

let pass = 0;
function t(name, fn) { fn(); console.log('  ok   ' + name); pass++; }

const view = html.slice(html.indexOf('function renderWorkdeskView()'), html.indexOf('async function loadTabs()'));

t('상단은 업체목록·열린탭만 고정하고, 작업목록은 숨은 드롭다운이다', () => {
  const company = view.indexOf('class="tb1 wb-tier wb-company"');
  const menu = view.indexOf('class="wb-task-menu" id="taskmenu" hidden');
  const opened = view.indexOf('class="tb0 wb-tier wb-open" id="tb0"');
  assert.ok(company >= 0 && menu > company && opened > menu, '업체 → 드롭다운 → 열린탭 순서가 아님');
  assert.ok(!/id="tb2"/.test(view), '기존 고정 작업목록 행(tb2)이 남아 있음');
  assert.match(view, /&#50629;&#52404;&#47785;&#47197;/, '업체목록 라벨 누락');
  assert.match(view, /&#50676;&#47536;&#53485;/, '열린탭 라벨 누락');
});

t('업체 클릭은 드롭다운 토글, 작업 클릭은 선택 후 드롭다운 닫기로 배선된다', () => {
  assert.match(html, /function wPickSeg\(k\)\{ STATE\.wSeg=k; STATE\.wMenu=\(STATE\.wMenu===k\?null:k\); _renderTabList\(\); \}/);
  assert.match(html, /function wPickTask\(i\)\{ STATE\.wMenu=null; selTab\(i\); \}/);
  assert.match(html, /function _renderTaskMenu\(\)/);
  assert.match(html, /작업목록 · \$\{esc\(g\.label\)\}/);
  assert.match(html, /#segwrap \.seg,#taskmenu/, '바깥 클릭 닫기 범위가 드롭다운을 포함하지 않음');
});

t('업체 칩은 드래그 가능하며, 즐겨찾기/미지정 특수 그룹은 재배치 대상에서 제외한다', () => {
  assert.match(html, /draggable="true" ondragstart="advDragStart/);
  assert.match(html, /function advDrop\(ev,k\)/);
  assert.match(html, /_wGroups\(\)\.filter\(g=>g\.key!==W_FAV&&g\.key!==''\)/);
  assert.match(html, /const movable=!isFavSeg&&g\.key!==''/);
  assert.match(html, /\.seg\[draggable="true"\]\.drag/);
});

t('드래그 순서는 자동 정렬보다 우선하고, 계정별 로컬 캐시와 서버 원장에 함께 저장된다', () => {
  assert.match(html, /function _advOrderLSKey\(\)\{ return 'wd_advertiser_order_v1_'/);
  assert.match(html, /function _advOrderSyncFromServer\(\)/);
  assert.match(html, /\/api\/trackb\/workdesk\/advertiser-order/);
  assert.match(html, /if\(ma!==mb\) return ma-mb;/);
  assert.match(html, /_advOrderSyncFromServer\(\);/);
});

t('서버는 사용자별 순서 원장을 제공하며, 마이그레이션 누락을 조용히 성공으로 꾸미지 않는다', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS trackb_workdesk_advertiser_order/);
  assert.match(route, /router\.get\('\/workdesk\/advertiser-order', authMiddleware/);
  assert.match(route, /router\.post\('\/workdesk\/advertiser-order', authMiddleware/);
  assert.match(service, /async function getWorkdeskAdvertiserOrder/);
  assert.match(service, /async function setWorkdeskAdvertiserOrder/);
  assert.match(service, /migration 143 미적용/);
});

console.log('\n' + pass + ' topbar checks passed');
