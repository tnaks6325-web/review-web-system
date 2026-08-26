/**
 * C/S 문의방 목록 제어 회귀가드.
 * 실행: node server/tests/csRoomReadFilterControls.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'cs-inquiry.js'), 'utf8');
const win = {};
const doc = { getElementById: () => null, addEventListener: () => {} };
new Function('window', 'document', src)(win, doc);
const html = win.CsInquiry.html;

let n = 0;
const ok = (name, condition) => { assert(condition, name); n++; console.log('  ✓ ' + name); };

ok('드롭다운 상태 필터가 렌더링되지 않는다', !/id="csStatusFilter"/.test(html));
ok('검색 입력창이 렌더링되지 않는다', !/id="csSearchInput"/.test(html));
ok('전체 접기/펼치기 토글이 있다', /id="csFoldAllBtn"/.test(html) && /csToggleAllGroups\(\)/.test(html));
ok('읽음·안읽음 사각 버튼이 있다', /id="csReadFilter-read"/.test(html) && /id="csReadFilter-unread"/.test(html));
ok('새로고침은 아이콘만 가진 정사각 버튼이다', /cs-refresh-control[^>]*>[\s\S]*?<i class="fas fa-sync-alt"><\/i><\/button>/.test(html));
ok('새로고침 정사각 규격이 있다', /\.cs-refresh-control\{width:32px;min-width:32px;padding:0\}/.test(html));
ok('읽음/안읽음은 adminUnread 기준으로만 걸러진다',
  /_csReadFilter === 'read'.*adminUnread > 0/.test(src) && /_csReadFilter === 'unread'.*adminUnread > 0/.test(src));
ok('목록 조회는 상태와 무관하게 전체를 받아온다', /csAdminThreads", status: "all", q: ""/.test(src));
ok('방을 열면 캐시의 미확인 수와 읽음/안읽음 목록도 즉시 갱신한다',
  /const cached = _csRooms\.find\(r => r\.id === threadId\)/.test(src) && /cached\.adminUnread = 0/.test(src));
ok('전체 접기 상태는 필터가 바뀐 현재 그룹에도 적용된다',
  /if \(_csAllGroupsFolded\) _csFoldedGroupKeys = new Set\(_csVisibleGroupKeys\)/.test(src));
const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'cs.routes.js'), 'utf8');
ok('상태·검색 제어가 없는 목록에서 500건 상한으로 방이 누락되지 않는다', !/LIMIT 500\b/.test(route));

console.log(`\n✅ csRoomReadFilterControls: ${n} cases passed`);
