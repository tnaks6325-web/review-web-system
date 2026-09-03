/* 작업보드 미니 C/S 정적 계약 — 같은 C/S 방을 쓰고, 작업 경계를 벗어나지 않는지 확인한다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const front = path.join(__dirname, '../../frontend');
const workdesk = fs.readFileSync(path.join(front, 'workdesk.html'), 'utf8');
const mini = fs.readFileSync(path.join(front, 'js/workdesk-cs-mini.js'), 'utf8');
const shared = fs.readFileSync(path.join(front, 'js/cs-inquiry.js'), 'utf8');

assert(workdesk.indexOf('<script src="js/cs-inquiry.js"></script>') < workdesk.indexOf('<script src="js/workdesk-cs-mini.js"></script>'),
  '공유 C/S 모듈 뒤에 미니 모듈을 읽는다');
assert.match(workdesk, /id="workdeskCsMini"/, '작업보드에 미니 C/S 마운트 지점이 있다');
assert.match(workdesk, /WorkdeskCsMini\.mount\('workdeskCsMini', \{ sheetId: STATE\.cur\.sheetId, tabName: STATE\.cur\.tabName/, '현재 작업 좌표로만 미니 C/S를 연다');
assert.match(workdesk, /tp3grid c3\$\{csMini\?' csmini':''\}/, '내부 작업보드에서만 네 번째 C/S 카드를 추가한다');
assert.match(workdesk, /STATE\.role!=='advertiser'/, '광고주에게 C/S 대화를 노출하지 않는다');
assert.match(workdesk, /\.tp3grid\.c3\.csmini\{grid-template-columns:minmax\(230px,370fr\).*minmax\(340px,460fr\)/, 'QHD에서 C/S 미니 폭을 넓힌 네 번째 카드 비율을 쓴다');
assert.match(workdesk, /\.tp3grid\.c3\.csmini \.wdcsmini-pane\{[^}]*align-self:stretch;[^}]*height:auto;[^}]*min-height:330px;[^}]*max-height:none;[^}]*contain:size/s, '긴 C/S 목록은 행 높이를 밀지 않고 다른 상단 카드와 같은 그리드 행으로 맞춘다');
assert.match(workdesk, /@media\(max-width:1500px\)\{[\s\S]*?\.wdcsmini-pane\{[^}]*height:300px;[^}]*max-height:300px/, '중간 화면에서 C/S 미니 높이를 300px로 제한한다');
assert.match(mini, /wdcsmini-head tp3t tp3h[^>]*onclick="_topToggle\(\)"/, 'C/S 제목행은 기존 상단 카드와 같은 접기/펼치기 제목행을 쓴다');
assert.match(workdesk, /\.tp3grid\.c3 \.topcardhd\{[^}]*min-height:40px;[^}]*font-size:11px;[^}]*font-weight:750/s, '상단 네 카드 제목행은 제출물 미리보기 기준의 같은 크기를 쓴다');
assert.match(workdesk, /\.tp3grid\.c3 \.tp3col > \.topcardhd\{[^}]*width:calc\(100% \+ 26px\);[^}]*margin:-11px -13px 8px/s, '작업 조건과 진행 현황 제목행은 카드 전폭을 클릭 영역으로 쓴다');
assert.match(workdesk, /\.tp3grid\.c3\.fold \.rvpane \.rvfill\{position:static;padding:11px 13px\}/, '제출물 미리보기 제목행은 접혀도 같은 여백을 유지한다');
assert.match(workdesk, /\.tp3grid\.c3\.fold \.wdcsmini-body\{display:none\}/, '상단 접기 시 C/S 대화 본문도 함께 접힌다');
assert.match(mini, /event\.stopPropagation\(\).*switchView\('cs'\)/, 'C/S 전체보기 버튼은 접기 대신 전체 C/S로 이동한다');
assert.match(mini, /campaignKey: sheetId \+ '\|\|' \+ tabName/, '작업별 C/S 범위는 기존 campaignKey 규칙을 사용한다');
assert.match(mini, /csAdminThreads/, 'C/S 메뉴와 같은 방 목록 API를 사용한다');
assert.match(mini, /csAdminMessages/, 'C/S 메뉴와 같은 메시지 API를 사용한다');
assert.match(mini, /csAdminReply/, '작업보드 답장도 C/S 메뉴와 같은 쓰기 API를 사용한다');
assert.match(mini, /window\.addEventListener\('cs:sse'/, '서버 이벤트가 오면 미니 C/S도 새로 읽는다');
assert.match(mini, /isMountedAndVisible\(\).*state = null/s, '사라진 작업보드에서는 SSE가 메시지 읽음 처리를 만들지 않는다');
assert.match(mini, /data\.ok === false \|\| data\.error/, '전송·조회는 transport error 응답도 실패로 처리한다');
assert.match(mini, /data\.hasMore && previousActive/, '후속 페이지를 읽는 동안 선택 대화방을 유지한다');
assert.match(shared, /window\.dispatchEvent\(new CustomEvent\('cs:sse'/, '공유 C/S SSE 훅이 미니 C/S에 이벤트를 전달한다');

console.log('workdesk C/S mini contract passed');
