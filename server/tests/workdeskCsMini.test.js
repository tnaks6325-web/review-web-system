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
