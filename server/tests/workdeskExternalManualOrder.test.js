const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workdesk = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const manualOrder = fs.readFileSync(path.join(__dirname, '../../frontend/js/manual-order.js'), 'utf8');
const inlineScript = (workdesk.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];

assert.ok(
  workdesk.includes('onclick="openExternalManualOrder()">외부모집 수동제출</button>'),
  '작업보드의 참가자 추가 버튼은 외부모집 수동제출 진입점이어야 합니다.'
);
assert.ok(
  workdesk.includes('function openExternalManualOrder()'),
  '작업보드는 공용 외부모집 수동제출 모달을 여는 함수를 제공해야 합니다.'
);
assert.ok(
  workdesk.includes('window.ManualOrder.open({'),
  '작업보드는 별도 수동행 폼 대신 공용 ManualOrder 모달을 재사용해야 합니다.'
);
assert.ok(
  /campaignId\s*:\s*null/.test(workdesk),
  '작업보드의 탭 단위 수동제출은 공고 정원을 직접 차감하지 않아야 합니다.'
);
assert.ok(
  !workdesk.includes('onclick="showAddForm()">＋ 참여자 추가</button>'),
  '기존 참여자 추가 UI는 작업보드에서 노출되면 안 됩니다.'
);
assert.ok(
  !workdesk.includes('function showAddForm()') && !workdesk.includes('/api/trackb/workdesk/add'),
  '작업보드는 별도 Track B 수동행 추가 경로를 유지하면 안 됩니다.'
);
assert.match(
  manualOrder,
  /Number\(out\.okCount\).*typeof CTX\.onSubmitted === 'function'.*CTX\.onSubmitted\(out\)/,
  '공용 수동제출 모달은 성공 건이 있을 때만 호출 화면에 완료를 알려야 합니다.'
);

const start = inlineScript.indexOf('function canOpenExternalManualOrder()');
const end = inlineScript.indexOf('async function reloadWorkdesk()', start);
assert.ok(start >= 0 && end > start, '외부모집 수동제출 동작 함수를 추출할 수 있어야 합니다.');
const externalManualOrder = new Function('STATE', 'toast', 'window', 'reloadWorkdesk', `${inlineScript.slice(start, end)}\nreturn { canOpenExternalManualOrder, openExternalManualOrder };`);

let message = '';
let opened = null;
let state = { role: 'staff', cur: null, wd: null };
let reloaded = 0;
let actions = externalManualOrder(state, text => { message = text; }, { ManualOrder: { open: ctx => { opened = ctx; } } }, async () => { reloaded++; });
assert.strictEqual(actions.canOpenExternalManualOrder(), false, 'AE는 관리자 전용 수동제출 버튼을 볼 수 없어야 합니다.');
actions.openExternalManualOrder();
assert.match(message, /작업을 먼저 선택/, '선택한 작업이 없으면 원인을 안내해야 합니다.');

state = { role: 'admin', cur: { sheetId: 'sheet-1', tabName: '8/12 외부모집', tabGid: 42, displayName: '탭 이름' }, wd: { meta: { displayName: '작업명' } } };
actions = externalManualOrder(state, text => { message = text; }, { ManualOrder: { open: ctx => { opened = ctx; } } }, async () => { reloaded++; });
assert.strictEqual(actions.canOpenExternalManualOrder(), true, '관리자는 외부모집 수동제출 버튼을 사용할 수 있어야 합니다.');
actions.openExternalManualOrder();
assert.deepStrictEqual(
  { sheetId: opened.sheetId, tabName: opened.tabName, gid: opened.gid, campaignId: opened.campaignId, title: opened.title },
  { sheetId: 'sheet-1', tabName: '8/12 외부모집', gid: '42', campaignId: null, title: '작업명' },
  '현재 작업 탭 문맥으로 공용 외부모집 수동제출 모달을 열어야 합니다.'
);
assert.strictEqual(typeof opened.onSubmitted, 'function', '성공한 수동제출은 작업보드 새로고침 콜백을 전달해야 합니다.');
opened.onSubmitted();
assert.strictEqual(reloaded, 1, '수동제출 성공 후 현재 작업보드가 한 번 새로고침되어야 합니다.');

console.log('workdeskExternalManualOrder.test.js passed');
