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
// ★ 경로 재기준 — 인트라넷 SSO 토큰(via:'intranet')은 /api/manual-order/* 에 도달 자체가 불가능하다.
assert.ok(
  workdesk.includes("window.MANUAL_ORDER_API = '/api/trackb/manual-order'"),
  '리뷰웹시스템[3버전]은 수동제출 경로를 Track B 네임스페이스로 재기준해야 합니다.'
);
// 버튼 자리는 항상 그린다 — 편집 허용명단이 늦게 도착해도 그 자리에 채울 수 있어야 한다.
assert.ok(
  (workdesk.match(/<span id="emoBtnBox">\$\{_emoBtnHtml\(\)\}<\/span>/g) || []).length === 2
  && workdesk.includes('_emoSyncBtn();'),
  '수동제출 버튼은 단일 렌더러(_emoBtnHtml)로 두 화면에 그리고, 명단 도착 시 채워야 합니다.'
);
const gridStart = workdesk.indexOf('function buildGrid(wd)');
const gridEnd = workdesk.indexOf('// 그리드만 가볍게 재렌더', gridStart);
const gridBody = workdesk.slice(gridStart, gridEnd);
assert.ok(
  /addCustomColumnPrompt\(\).*?<span id="emoBtnBox">\$\{_emoBtnHtml\(\)\}<\/span>[\s\S]*?_folBarHtml\(\)/.test(gridBody),
  '외부모집 수동제출 버튼은 열 추가 버튼 바로 오른쪽에 있어야 합니다.'
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
const externalManualOrder = new Function('STATE', 'toast', 'window', 'reloadWorkdesk', '_isInternalRole', '_loadCampPerm', 'document',
  `${inlineScript.slice(start, end)}\nreturn { canOpenExternalManualOrder, openExternalManualOrder, _emoBtnHtml, _emoSyncBtn };`);
const isInternal = () => ['master', 'admin', 'staff'].includes(state.role);
const fakeDoc = { box: { innerHTML: '' }, getElementById(id) { return id === 'emoBtnBox' ? this.box : null; } };

let message = '';
let opened = null;
let state = { role: 'staff', cur: null, wd: null };
let reloaded = 0;
let permCalls = 0;
const loadPerm = async () => { permCalls++; state.campEdit = true; return true; };
let actions = externalManualOrder(state, text => { message = text; }, { ManualOrder: { open: ctx => { opened = ctx; } } }, async () => { reloaded++; }, isInternal, loadPerm, fakeDoc);
assert.strictEqual(actions.canOpenExternalManualOrder(), false, '명단 판정 전에는 버튼을 그리지 않아야 합니다(눌러도 403 나는 버튼 금지).');
actions.openExternalManualOrder();
assert.match(message, /작업을 먼저 선택/, '선택한 작업이 없으면 원인을 안내해야 합니다.');

// ★ AE(staff)도 편집 허용명단에 있으면 실행할 수 있다(사용자 확정 2026-08-20) — 서버 게이트와 1:1.
state.campEdit = null;
actions._emoSyncBtn();
assert.strictEqual(permCalls, 1, '명단 판정은 도착 시 한 번만 조회해야 합니다.');
assert.strictEqual(actions.canOpenExternalManualOrder(), true, '편집 허용명단 AE 는 수동제출을 실행할 수 있어야 합니다.');
state.campEdit = false;
assert.strictEqual(actions.canOpenExternalManualOrder(), false, '명단 밖 AE 에게는 노출하지 않아야 합니다.');

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

// 명단 판정이 도착하면(비동기) 그 자리를 채운다 — 버튼이 늦게라도 반드시 생긴다.
(async () => {
  const box = { innerHTML: '' };
  const doc = { getElementById: id => (id === 'emoBtnBox' ? box : null) };
  const late = { role: 'staff', campEdit: null };
  const a = externalManualOrder(late, () => {}, {}, async () => {},
    () => true, async () => { late.campEdit = true; return true; }, doc);
  a._emoSyncBtn();
  await new Promise(r => setImmediate(r));
  assert.ok(/외부모집 수동제출/.test(box.innerHTML), '명단에 있는 AE 에게는 버튼이 채워져야 합니다.');

  // 광고주·리뷰어에게는 명단 조회조차 하지 않는다(눌러도 403 나는 버튼 금지 + 불필요한 요청 0).
  const adv = { role: 'advertiser', campEdit: null };
  let advPerm = 0;
  const b = externalManualOrder(adv, () => {}, {}, async () => {},
    () => false, async () => { advPerm++; return true; }, doc);
  b._emoSyncBtn();
  assert.strictEqual(advPerm, 0, '내부인이 아니면 편집 명단을 조회하지 않아야 합니다.');
  assert.strictEqual(b.canOpenExternalManualOrder(), false, '광고주에게는 수동제출을 노출하지 않아야 합니다.');

  console.log('workdeskExternalManualOrder.test.js passed');
})();
