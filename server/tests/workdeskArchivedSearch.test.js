const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/workdesk.html'), 'utf8').replace(/\r\n/g, '\n');
const routes = fs.readFileSync(path.join(root, 'server/src/routes/trackB.routes.js'), 'utf8').replace(/\r\n/g, '\n');
const service = fs.readFileSync(path.join(root, 'server/src/services/trackB.service.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok   ' + name); }

t('검색 결과는 활성 작업 뒤에 마감 작업을 붙이고 요청 문구를 그대로 표시한다', () => {
  assert.match(html, /const hits=\[\.\.\.active,\.\.\.closed\]/);
  assert.match(html, /`\*마감 : \$\{_tabLabel\(t\)\}`/);
});

t('한글 IME 조합 중에는 요청하지 않고 조합 완료 후 검색한다', () => {
  assert.match(html, /oncompositionstart="_wSearchComposing=true"/);
  assert.match(html, /oncompositionend="_wSearchComposing=false;wSearch\(this\.value\)"/);
  assert.match(html, /if\(_wSearchComposing\) return;/);
  assert.match(html, /const seq=\+\+_wSearchSeq/);
});

t('마감 검색은 내부 역할만 접근하고 파라미터 바인딩으로 조회한다', () => {
  assert.match(routes, /router\.get\('\/workdesk\/archived-search', authMiddleware/);
  assert.match(routes, /\['master', 'admin', 'staff'\]\.includes\(role\)/);
  assert.match(routes, /ima\.tab_name ILIKE \$1 OR ima\.campaign_name ILIKE \$1 OR tc\.display_name ILIKE \$1/);
  assert.match(routes, /\[`%\$\{q\}%`, limit\]/);
});

t('마감 결과 클릭은 아카이브 좌표로 열고 열린 탭에는 추가하지 않는다', () => {
  assert.match(html, /Object\.assign\(\{\},t,\{archived:true,finished:true\}\)/);
  assert.match(html, /t\.archived\?'&archived=1':''/);
  assert.match(html, /if\(!t\|\|t\.archived\|\|STATE\.role==='advertiser'\) return;/);
});

t('마감 작업표 응답은 편집 재료를 싣지 않고 화면도 읽기 전용으로 연다', () => {
  assert.match(service, /const showEdits = role !== 'advertiser' && !archived/);
  assert.match(service, /FROM review_index_archive ria/);
  assert.match(service, /const \{ rows: edits \} = archived \? \{ rows: \[\] \}/);
  assert.match(service, /archived: !!archived/);
  assert.match(html, /STATE\.canEdit=\(STATE\.role!=='advertiser'&&!wd\.archived\)/);
  assert.match(html, /\*마감 · 열람 전용/);
  assert.match(html, /wd\.archived\?'':_finBarHtml\(\)/);
});

console.log(`\n${pass} archived work-search checks passed`);
