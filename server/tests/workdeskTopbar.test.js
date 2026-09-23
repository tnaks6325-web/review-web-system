// 작업보드 상단 업체목록 드래그 배치 + 업체별 작업 드롭다운 회귀가드.
// 인라인 스크립트는 브라우저 전용이므로, 사용자 계약을 만드는 HTML/CSS/배선만 빠르게 검증한다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/workdesk.html'), 'utf8');
const route = fs.readFileSync(path.join(root, 'server/src/routes/trackB.routes.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8');
const participants = fs.readFileSync(path.join(root, 'server/src/services/participants.service.js'), 'utf8');
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
  assert.match(view, /taskbar\.onclick=function\(ev\)/, '작업바 클릭 위임이 없음');
  assert.match(view, /const results=\$\('#sres'\); if\(results\) results\.classList\.remove\('show'\);/, '업체 클릭이 열린 검색 결과를 닫지 않음');
  assert.match(view, /ev\.stopPropagation\(\); wPickSeg\(seg\.dataset\.k\);/, '업체 클릭이 바깥 클릭 닫기와 분리되지 않음');
  assert.match(view, /ev\.stopPropagation\(\); wPickTask\(\+item\.dataset\.i\);/, '작업 선택이 드롭다운 밖 클릭으로 번지지 않음');
  assert.doesNotMatch(html, /onclick="wPickSeg\(this\.dataset\.k\)"/, '재렌더되는 업체 칩에 인라인 토글이 남아 이중 실행될 수 있음');
});

t('작업바의 일반 배치는 sticky 상단 오프셋을 해제해 헤더 바로 아래에서 시작한다', () => {
  assert.match(html, /\.taskbar\.wb-topbar\{position:relative;top:auto;/,
    'relative 작업바에 sticky top 오프셋이 남아 상단 공백을 만든다');
});

t('업체 칩은 드래그 가능하며, 즐겨찾기/미지정 특수 그룹은 재배치 대상에서 제외한다', () => {
  assert.match(html, /draggable="true" ondragstart="advDragStart/);
  assert.match(html, /function advDrop\(ev,k\)/);
  assert.match(html, /_wGroups\(\)\.filter\(g=>g\.key!==W_FAV&&g\.key!==''\)/);
  assert.match(html, /const movable=!isFavSeg&&g\.key!==''/);
  assert.match(html, /\.seg\[draggable="true"\]\.drag/);
});

t('업체별 작업목록은 즐겨찾기 우선 후 최초 관측시각 최신순으로 안정 정렬한다', () => {
  assert.match(html, /function _wTabNewestAt\(t\)\{ const ms=Date\.parse\(\(t&&t\.firstSeenAt\)\|\|''\);/,
    '최신 작업 정렬에 쓸 최초 관측 시각이 없음');
  assert.match(html, /const fx=isFav\(tx\), fy=isFav\(ty\); if\(fx!==fy\) return fx\?-1:1;/,
    '즐겨찾기 작업 우선 정렬이 없음');
  assert.match(html, /const dx=_wTabNewestAt\(tx\), dy=_wTabNewestAt\(ty\); if\(dx!==dy\) return dy-dx;/,
    '최신 작업 내림차순 정렬이 없음');
  const activeTabs = participants.slice(participants.indexOf('async function listActiveTabs('), participants.indexOf('\n}', participants.indexOf('async function listActiveTabs(')));
  assert.strictEqual((activeTabs.match(/AS "firstSeenAt"/g) || []).length, 2,
    '시트/무시트 작업 모두 최초 관측 시각을 내려야 한다');
  assert.match(activeTabs, /MIN\(cp\.first_seen_at\)/,
    '최신 작업 정렬이 재동기화 시각에 흔들리지 않게 최초 관측 시각을 읽어야 한다');
});

t('드래그 순서는 자동 정렬보다 우선하고, 계정별 로컬 캐시와 서버 원장에 함께 저장된다', () => {
  assert.match(html, /function _advOrderLSKey\(\)\{ return 'wd_advertiser_order_v1_'/);
  assert.match(html, /function _advOrderSyncFromServer\(\)/);
  assert.match(html, /\/api\/trackb\/workdesk\/advertiser-order/);
  assert.match(html, /if\(ma!==mb\) return ma-mb;/);
  assert.match(html, /_advOrderSyncFromServer\(\);/);
});

t('계정 전환·초기 동기화 경합과 미지정 업체 작업 선택을 보존한다', () => {
  assert.match(html, /advOrder:null,_advOrderLoaded:false,_advOrderDirty:false,_advOrderBootSynced:false,_advOrderVersion:0/);
  assert.match(html, /const version=STATE\._advOrderVersion\|\|0;/);
  assert.match(html, /if\(\(STATE\._advOrderVersion\|\|0\)!==version\)/);
  assert.match(html, /if\(key==null\|\|!g\)/);
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
