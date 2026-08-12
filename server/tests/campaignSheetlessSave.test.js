/**
 * 모집공고는 시트 없이도 저장·발행할 수 있다.
 * 단, 시트 연결을 시작했다면 sheet/tab/gid 3종이 완전해야 한다.
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

ok('연결을 전혀 고르지 않은 참여형 공고는 프론트 점검에서 막지 않는다',
  /if \(tabKey && \!\(tabMeta && tabMeta\.tabGid\)\)/.test(recruit));
ok('저장 요청이 연결 없음 의도를 명시한다',
  /linked_tab_mode:\s*tabKey \? "linked" : "unlinked"/.test(recruit));
ok('연결 없음 선택은 안내 문구와 선택 항목으로 표시된다',
  /시트·탭 연결은 나중에 추가할 수 있습니다/.test(modal)
  && /시트명 <span class="rf-optional">선택<\/span>/.test(modal)
  && /탭명 <span class="rf-optional">선택<\/span>/.test(modal));
ok('점검표는 무시트 허용 상태와 불완전 연결 오류를 올바르게 표시한다',
  /시트 탭 미연결 — 나중에 추가 가능/.test(recruit)
  && /errs\.some\(e => e\.includes\("gid"\)\)/.test(recruit));
ok('서버 활성화 점검은 완전히 비어 있는 연결을 허용한다',
  /const hasAnyLink = !!\(c\.linked_sheet_id \|\| c\.linked_tab_name \|\| c\.linked_tab_gid\)/.test(routes));
ok('서버는 연결 없음 요청일 때 작업오더 자동 연결을 하지 않는다',
  /const intentionallyUnlinked = linked_tab_mode === 'unlinked'/.test(routes)
  && /if \(!intentionallyUnlinked && \(!lSheet \|\| !lTab\)\)/.test(routes));
ok('수정 저장에서 명시적 연결 해제가 기존 연결을 비운다',
  /linked_sheet_id = CASE WHEN \$45::boolean THEN '' ELSE COALESCE\(\$17, linked_sheet_id\) END/.test(routes)
  && /linked_tab_name = CASE WHEN \$45::boolean THEN '' ELSE COALESCE\(\$18, linked_tab_name\) END/.test(routes));

console.log(`\ncampaignSheetlessSave: ${passed} passed`);
