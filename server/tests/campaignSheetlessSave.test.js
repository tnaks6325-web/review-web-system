/**
 * 시트·탭 연결 여부는 모집공고 게시를 막지 않는다.
 * 연결 정보는 연동을 위한 선택 값이며, 게시 조건이 아니다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const routes = read('src/routes/campaign.routes.js');
const recruit = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-recruit.js'), 'utf8');
const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'recruit-modal.js'), 'utf8');

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; console.log('  ✓ ' + name); }

ok('프론트 게시 점검은 시트·탭 연결 여부를 검사하지 않는다',
  !/const tabKey = document\.getElementById\("rf_linked_tab"\)/.test(
    recruit.slice(recruit.indexOf('function participationCheckErrors()'), recruit.indexOf('function renderPartCheck()'))
  ));
ok('저장 요청이 연결 없음 의도를 명시한다',
  /linked_tab_mode:\s*tabKey \? "linked" : "unlinked"/.test(recruit));
ok('연결 없음 선택은 안내 문구와 선택 항목으로 표시된다',
  /시트·탭 연결은 나중에 추가할 수 있습니다/.test(modal)
  && /시트명 <span class="rf-optional">선택<\/span>/.test(modal)
  && /탭명 <span class="rf-optional">선택<\/span>/.test(modal));
ok('점검표는 미연결을 안내만 하고 게시 불가 상태로 표시하지 않는다',
  /시트 탭 미연결 — 나중에 추가 가능/.test(recruit)
  && !/errs\.some\(e => e\.includes\("gid"\)\)/.test(recruit));
ok('서버 활성화 점검은 시트·탭 연결 여부를 게시 조건으로 삼지 않는다',
  !/const hasAnyLink = !!\(c\.linked_sheet_id \|\| c\.linked_tab_name \|\| c\.linked_tab_gid\)/.test(routes)
  && !/연결 시트\/탭 정보를 모두 입력해주세요/.test(routes));
ok('카드의 미연결 상태는 게시 불가로 표시하지 않는다',
  !/시트 탭 미연결 — 게시할 수 없습니다/.test(
    fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'campaign-cards.js'), 'utf8')
  ));
ok('서버는 연결 없음 요청일 때 작업오더 자동 연결을 하지 않는다',
  /const intentionallyUnlinked = linked_tab_mode === 'unlinked'/.test(routes)
  && /if \(!intentionallyUnlinked && \(!lSheet \|\| !lTab\)\)/.test(routes));
ok('수정 저장에서 명시적 연결 해제가 기존 연결을 비운다',
  /linked_sheet_id = CASE WHEN \$45::boolean THEN '' ELSE COALESCE\(\$17, linked_sheet_id\) END/.test(routes)
  && /linked_tab_name = CASE WHEN \$45::boolean THEN '' ELSE COALESCE\(\$18, linked_tab_name\) END/.test(routes));

console.log(`\ncampaignSheetlessSave: ${passed} passed`);
