'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const paymentService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'payment.service.js'), 'utf8');
const trackBService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'trackB.service.js'), 'utf8');
const sheetlessStatus = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sheetlessStatus.service.js'), 'utf8');

function sourceOf(name) {
  const start = workdesk.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  let depth = 0;
  let started = false;
  for (let i = start; i < workdesk.length; i++) {
    if (workdesk[i] === '{') { depth++; started = true; }
    else if (workdesk[i] === '}' && started && --depth === 0) return workdesk.slice(start, i + 1);
  }
  throw new Error(name + ' is incomplete');
}

function test(name, fn) {
  try { fn(); console.log('  ok ' + name); }
  catch (error) { console.error('  not ok ' + name + '\n    ' + error.message); process.exitCode = 1; }
}

// ★ 위 test() 는 동기 전용 — fn 이 async 면 반환된 Promise 를 기다리지 않고 즉시 'ok' 를 찍는다
//   (실패해도 그 뒤에야 미확인 rejection 으로 터져 로그가 어긋난다). stub pool 로 서비스를
//   실제 실행하는 테스트는 이 큐에 담아 파일 끝에서 순서대로 await 한다.
const _asyncTests = [];
function testAsync(name, fn) { _asyncTests.push({ name, fn }); }

/* ★★ 회차 #18 사고(2026-08-24): 입금관리 담당자는 `tab_configs.manager` 만 봤고 작업 화면은
   작업오더 담당자를 닉네임으로 바꿔 보여줬다 — 출처가 둘이라 오더에서 담당자가 바뀐 작업이
   옛 담당자 칩에 남았고, "망고만 선택"한 서식에 만두 작업의 이체건이 딸려왔다.
   → 담당자 판정은 작업 화면과 같은 출처(작업오더)를 우선한다. 완화 = 사고 재발. */
test('payment target metadata resolves the work manager from the work order first', () => {
  assert.match(paymentService, /tc\.manager\s+AS\s+"manager"/);
  assert.match(paymentService, /wo\.work_manager\s+AS\s+"orderWorkManager"/);
  assert.match(paymentService, /w\.goods_cost_type,\s*w\.work_manager\s+FROM work_orders/);
  assert.match(paymentService, /resolveWorkManager\(\{\s*orderWorkManager:\s*t\.orderWorkManager/);
  // ★★ 담당AE 실명 칸(`manager_name`)을 **읽지 않는다** — 065 이전 사고 자리(완화 금지).
  //   (주석에 이름이 나오는 것은 무방하고, 컬럼을 실제로 참조하는 것만 막는다)
  assert.doesNotMatch(paymentService, /\bw{1,2}\.manager_name\b/);
  // 닉네임 치환도 `mapWorkManager` 한 곳 — 다른 이름 맵을 끌어오면 AE·관리자 이름이 칩으로 샌다.
  assert.doesNotMatch(paymentService, /require\(['"][^'"]*adminNickname[^'"]*['"]\)/);
  // ★★ 판정은 utils/workManager 에서 **가져다** 쓴다 — payment.service 안에 다시 정의하면
  //   이 함수가 두 벌이 되어 언젠가 갈린다(회차 #18 이 바로 그 갈림의 결과였다).
  assert.match(paymentService, /require\(['"]\.\.\/utils\/workManager['"]\)/);
  assert.doesNotMatch(paymentService, /function resolveWorkManager/);
});

/* ★★ 같은 날 신고: 홈 작업목록의 "담당" 열도 `tab_configs.manager` 를 폴백 없이 그대로
   보여줘 같은 함정에 빠져 있었다(작업조건·모집공고는 만두인데 홈만 망고). 두 화면이
   `resolveWorkManager` 한 함수를 부르게 해 판정이 다시 갈릴 수 없게 한다. */
test('the home task-list manager also resolves from the work order first, not the frozen tab column', () => {
  assert.match(trackBService, /require\(['"]\.\.\/utils\/workManager['"]\)/);
  assert.match(trackBService, /wo\.work_manager\s+AS\s+"orderWorkManager"/);
  assert.match(trackBService, /LEFT JOIN LATERAL[\s\S]{0,120}FROM work_orders w[\s\S]{0,200}linked_tab_sheet_id = tc\.sheet_id/);
  assert.match(trackBService, /manager:\s*resolveWorkManager\(\{\s*orderWorkManager:\s*r\.orderWorkManager,\s*tabManager:\s*r\.manager\s*\}\)\.manager/);
});

testAsync('the home task-list stub-pool run actually prefers the live work order manager over the frozen tab value', async () => {
  const svc = require('../src/services/trackB.service');
  svc.__setPoolForTest({
    query: async () => ({ rows: [
      // 실측 그대로: 탭에는 옛 값(망고)이 굳어 있는데 작업오더는 최신 값(만두)을 말한다.
      { sheetId: 'S1', tabName: '8/19)T', manager: '망고', orderWorkManager: '박세희',
        campaignName: '', displayName: '', rowCount: 300, submittedCount: 35, paidCount: 0,
        closeoutDate: null, closeoutRows: null },
      // 오더가 담당자를 말하지 않으면(랜덤·미매핑·오더 없음) 종전대로 탭 값을 본다.
      { sheetId: 'S2', tabName: 'T2', manager: '만두', orderWorkManager: '랜덤',
        campaignName: '', displayName: '', rowCount: 1, submittedCount: 0, paidCount: 0,
        closeoutDate: null, closeoutRows: null },
    ] }),
  });
  const r = await svc.tabStatsMap({ force: true });
  svc.__setPoolForTest(null);
  assert.strictEqual(r.map['S1\t8/19)T'].manager, '만두',
    '홈 목록이 여전히 탭에 굳은 옛 담당자(망고)를 보여준다');
  assert.strictEqual(r.map['S2\tT2'].manager, '만두',
    '오더가 담당자를 말하지 않을 때 탭 폴백이 깨졌다');
});

test('the work manager comes from 작업담당(065) and falls back to the tab setting only when it says nothing', () => {
  const resolve = require('../src/utils/workManager').resolveWorkManager;
  // payment.service 가 다시 정의하지 않고 같은 함수를 그대로 재수출하는지(사본 금지) 고정.
  assert.strictEqual(require('../src/services/payment.service').resolveWorkManager, resolve);
  // 작업담당이 있으면 그 값이 이긴다 — 탭 값은 접수 업서트가 blank-only 라 옛 담당자로 굳는다.
  assert.deepStrictEqual(resolve({ orderWorkManager: '\uBC15\uC138\uD76C', tabManager: '\uB9DD\uACE0' }),
    { manager: '\uB9CC\uB450', managerSource: 'order' });
  // 표기 흔들림('박세희(만두)')도 065 매핑이 흡수한다.
  assert.deepStrictEqual(resolve({ orderWorkManager: '\uBC15\uC740\uBE44(\uB9DD\uACE0)', tabManager: '' }),
    { manager: '\uB9DD\uACE0', managerSource: 'order' });
  // ★ 랜덤·미매핑·오더 없음 = 자동으로 아무나 배정하지 않는다(065) → 그때만 탭 설정 폴백.
  assert.deepStrictEqual(resolve({ orderWorkManager: '\uB79C\uB364', tabManager: '\uB9CC\uB450' }),
    { manager: '\uB9CC\uB450', managerSource: 'tab' });
  assert.deepStrictEqual(resolve({ orderWorkManager: '', tabManager: '\uBC15\uC740\uBE44' }),
    { manager: '\uB9DD\uACE0', managerSource: 'tab' });
  // 탭에 매핑 밖 이름이 있으면 원문 보존(임의 해석 금지).
  assert.deepStrictEqual(resolve({ orderWorkManager: '', tabManager: '\uAE40\uAD00\uB9AC' }),
    { manager: '\uAE40\uAD00\uB9AC', managerSource: 'tab' });
  // 둘 다 없으면 '담당자 없음' — 추측하지 않는다.
  assert.deepStrictEqual(resolve({ orderWorkManager: '', tabManager: '' }),
    { manager: '', managerSource: null });
});

const sandbox = {};
vm.createContext(sandbox);
function constSource(name) {
  const line = workdesk.match(new RegExp('^const ' + name + '=.*$', 'm'));
  assert.ok(line, name + ' must exist');
  return line[0];
}

vm.runInContext(constSource('PM_MANAGER_NICK') + '\n'
  + sourceOf('_pmWorkKey') + '\n' + sourceOf('_pmManagerName') + '\n' + sourceOf('_pmManagerMatch') + '\n' + sourceOf('_pmFilterItems') + '\n' + sourceOf('_pmSelectedPaymentTotal') + '\n' + sourceOf('_pmSelectedRecipientCount') + '\n' + sourceOf('_pmWorkEntries') + '\n' + sourceOf('_pmToggleWorkKeys') + '\n' + sourceOf('_pmSetWorkSelection') + '\n' + sourceOf('_pmWorkKeyRange'), sandbox);

test('legacy manager names are normalized on both sides, not just one', () => {
  assert.strictEqual(sandbox._pmManagerName('\uBC15\uC740\uBE44'), '\uB9DD\uACE0');
  // ★ 한쪽만 접으면 같은 사람이 '만두'와 '박세희' 두 칩으로 갈려, 한 칩만 고른 담당자의
  //   서식에서 나머지 절반이 조용히 빠진다.
  assert.strictEqual(sandbox._pmManagerName('\uBC15\uC138\uD76C'), '\uB9CC\uB450');
});

test('the download confirmation states which manager and works are being locked', () => {
  const confirmText = sourceOf('_pmDownloadConfirmText');
  assert.match(confirmText, /_pmManagerLabel\(filter\.manager\)/);
  assert.match(confirmText, /\uC791\uC5C5 \$\{works\.length\}\uAC1C/);
  assert.match(sourceOf('_pmDownload'), /confirm\(_pmDownloadConfirmText\(label, picked\)\)/);
  // 확인창에 실린 목록과 실제로 담기는 목록은 **같은 배열**이어야 한다(사본을 두면 갈린다).
  assert.match(sourceOf('_pmDownload'), /const rows = picked\.map/);
});

const rows = [
  { sheetId: 'S1', tabName: 'A', manager: '\uB9CC\uB450', amount: 1000, payable: true, excluded: false },
  { sheetId: 'S1', tabName: 'B', manager: '\uB9DD\uACE0', amount: 2200, payable: true, excluded: false },
  { sheetId: 'S2', tabName: 'A', manager: '\uB9CC\uB450', amount: 300, payable: true, excluded: true },
  { sheetId: 'S3', tabName: 'C', manager: '\uB9CC\uB450', amount: 700, payable: true, excluded: false },
];

/* ★★ C스타일(CLAUDE.md 맨 위) — 담당자 줄은 `전체` + 실제 담당자 토글뿐이다.
   UI 를 늘리려면 **먼저 시안으로 제안하고 사용자 선택을 받는다**(UI style proposal gate).
   작업 중 실측: 담당자 없는 작업을 담으려고 `담당자 미지정` 칩을 임의로 붙였다가 되돌렸다. */
test('the manager chip row stays 전체 + 담당자 toggles (C스타일)', () => {
  const bar = sourceOf('_pmFilterBar');
  // 칩 줄 = `전체` 하나 + 실제 담당자 목록 하나. 그 사이에 다른 버튼이 끼지 않는다.
  assert.ok(bar.includes("${managerButton('','전체')}${managers.map(name=>managerButton(name,name)).join('')}</div>"),
    '담당자 칩 줄이 C스타일(전체 + 담당자 토글)을 벗어났다');
  // ★ 센티널·칩 자체는 여전히 금지 — 단, "담당자 미지정" **문구**는 A안(사용자 확정)의
  //   안내 배너(_pmUnassignedNoteHtml)에서 정상적으로 쓰인다. 금지 대상은 그 문구가 칩
  //   함수 안으로 다시 새어 들어오는 것뿐이다(칩 줄 자체를 검사 대상으로 좁힌다).
  assert.doesNotMatch(workdesk, /PM_NO_MANAGER/);
  assert.doesNotMatch(bar, /담당자 미지정/);
});

/* ★★ A안(사용자 확정 2026-08-24) — 담당자가 비어 있는 작업(랜덤·미매핑·오더 없음)은 특정
   담당자 칩을 고르면 안 보인다. 문구로만 알리고 버튼 구성(C스타일)은 그대로 두되, 그 작업의
   작업보드로 보내 [관리자 수정] › 작업담당을 정하도록 유도한다(행동유도 — 안내만 하고 끝나지
   않는다). '전체'에서는 어차피 다 보이므로 특정 담당자를 고른 상태에서만 뜬다. */
test('unassigned-manager works get a nudge banner only while a specific manager chip is active', () => {
  const render = sourceOf('_pmRender');
  assert.match(render, /_pmFilterState\(\)\.manager \? _pmUnassignedWorks\(allItems\) : \[\]/);
  assert.match(render, /unassignedWorks\.length\?_pmUnassignedNoteHtml\(unassignedWorks\):''/);
  const note = sourceOf('_pmUnassignedNoteHtml');
  assert.match(note, /담당자 미지정 작업/);
  assert.match(note, /관리자 수정.*작업담당/);
  // 안내는 문구뿐 아니라 실제 행동(작업보드 열기)까지 준다 — 텍스트만 있고 누를 게 없는 안내 금지.
  assert.match(note, /_pmOpenUnassignedWork\(\$\{idx\}\)/);
  const open = sourceOf('_pmOpenUnassignedWork');
  assert.match(open, /switchView\('workdesk'\)/);
  // onclick 에는 인덱스만 — 탭명은 시트/DB 발 문자열이라 보간하면 XSS 자리다(레포 관용구).
  assert.doesNotMatch(note, /onclick="_pmOpenUnassignedWork\(\$\{esc\(/);
});

test('the unassigned-manager helper is work-level, computed the same way as the manager chips', () => {
  const helper = sourceOf('_pmUnassignedWorks');
  assert.match(helper, /_pmWorkEntries\(items,'',_pmOn\)/);
  assert.match(helper, /!_pmManagerName\(it\.manager\)/);
});

test('manager and multiple selected works narrow the download candidates together', () => {
  const out = sandbox._pmFilterItems(rows, { manager: '\uB9CC\uB450', workKeys: ['S1||A', 'S3||C'] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), [rows[0], rows[3]]);
});

test('download total excludes unchecked rows within the active filters', () => {
  assert.strictEqual(sandbox._pmSelectedPaymentTotal(rows, { manager: '\uB9CC\uB450', workKeys: ['S1||A', 'S2||A'] }), 1000);
});

test('selected recipient count uses the same work and checked-item conditions as the download', () => {
  assert.strictEqual(sandbox._pmSelectedRecipientCount(rows, { manager: '\uB9CC\uB450', workKeys: ['S1||A', 'S2||A'] }, it => it.payable && !it.excluded), 1);
});

test('work selector hides works with no payment targets', () => {
  const works = sandbox._pmWorkEntries([
    { sheetId: 'S1', tabName: 'zero', manager: '\uB9CC\uB450', payable: false },
    { sheetId: 'S2', tabName: 'excluded', manager: '\uB9CC\uB450', payable: true, excluded: true },
    { sheetId: 'S3', tabName: 'payable', manager: '\uB9CC\uB450', payable: true, excluded: false },
  ], '\uB9CC\uB450');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(works.map(([key]) => key))), ['S3||payable']);
});

test('an empty selected-work list produces no download candidates', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmFilterItems(rows, { manager: '\uB9CC\uB450', workKeys: [] }))), []);
});

test('toggling work rows preserves every other selected work', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmToggleWorkKeys(['S1||A', 'S3||C'], ['S1||A', 'S2||A', 'S3||C'], 'S2||A'))), ['S1||A', 'S2||A', 'S3||C']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmToggleWorkKeys(['S1||A', 'S2||A'], ['S1||A', 'S2||A'], 'S1||A'))), ['S2||A']);
});

test('drag selection applies the initial row direction to each newly crossed work', () => {
  const all = ['S1||A', 'S1||B', 'S1||C'];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmSetWorkSelection(['S1||A'], all, 'S1||B', true))), ['S1||A', 'S1||B']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmSetWorkSelection(['S1||A', 'S1||B'], all, 'S1||A', false))), ['S1||B']);
});

test('fast drag fills every work key between the last and current pointer row', () => {
  const all = ['S1||A', 'S1||B', 'S1||C', 'S1||D'];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmWorkKeyRange(all, 'S1||A', 'S1||D'))), all);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox._pmWorkKeyRange(all, 'S1||D', 'S1||B'))), ['S1||B', 'S1||C', 'S1||D']);
});

test('work rows start and extend a pointer drag without double-toggling on click', () => {
  // ★ 작업 줄 마크업은 `_pmFilterBar` 안에서 `_pmWorkRowsHtml` 로 떨어져 나왔다(사본이 생긴 게 아니라
  //   조각으로 분리된 것) — 검사 대상을 그 조각으로 옮긴다. 고정하는 것은 드래그 배선 자체다.
  const workRows = sourceOf('_pmWorkRowsHtml');
  assert.match(workRows, /onpointerdown="_pmStartWorkDrag/);
  assert.match(workRows, /onpointerenter="_pmDragSelectWork/);
  assert.match(sourceOf('_pmFilterBar'), /_pmWorkRowsHtml\(/);
  assert.match(sourceOf('_pmEndWorkDrag'), /pmWorkDragClickSuppressed/);
});

test('toggling a work preserves the work-list scroll position and exposes the selected-work count', () => {
  assert.match(sourceOf('_pmToggleWork'), /pmworklist[\s\S]*scrollTop/);
  assert.match(sourceOf('_pmRender'), /pmworklist[\s\S]*scrollTop\s*=/);
  assert.match(workdesk, /선택 작업 \$\{selectedKeys\.size\}개/);
});

test('a transfer result can be reopened from its batch row without opening a file picker', () => {
  const openResult = sourceOf('_pmOpenResult');
  assert.match(openResult, /result-preview/);
  assert.doesNotMatch(openResult, /_pmPickResult/);
  assert.match(workdesk, /onclick="_pmOpenResult\(\$\{i\}\)"/);
});

test('result upload supports drag-and-drop and has no second manual apply action', () => {
  assert.match(sourceOf('_pmResultDrop'), /dataTransfer/);
  assert.match(sourceOf('_pmUploadResultFile'), /result-auto-apply/);
  assert.doesNotMatch(sourceOf('_pmBatchActions'), /_pmApplySavedResult\(\$\{i\}\)/);
});

test('result upload uses one clickable drop zone with a concise label', () => {
  const actions = sourceOf('_pmBatchActions');
  assert.match(actions, /<button class="pmdrop"[^>]*onclick="_pmPickResult\(\$\{i\}\)"/);
  assert.match(actions, /결과 파일 업로드/);
  assert.doesNotMatch(actions, /드래그 가능/);
  assert.doesNotMatch(actions, /<button class="btn sm" onclick="_pmPickResult/);
});

/* 2026-08-19 회차 #12 이후 규칙 변경(사용자 확정): 입금일 재기록 창구를 **하나** 둔다.
   종전에는 재시도 수단이 아예 없어, 반영이 도중에 끊긴 회차(board_* 전부 0)를 아무도
   치울 수 없었다. 창구는 작업보드 칸의 [입금일 기록] 하나이고, 회차 액션 줄(다시 받기·
   취소·결과 업로드)에는 두지 않는다 — 그쪽에 버튼을 더하면 주 행동이 묻힌다. */
test('deposit-date retry lives only in the workboard cell, not in the batch actions', () => {
  assert.doesNotMatch(sourceOf('_pmBatchActions'), /_pmDepositBackfill/);
  assert.doesNotMatch(workdesk, /function _pmBackfillPaidDeposit/);
  assert.match(sourceOf('_pmBatchWorkboard'), /_pmDepositBackfill\(\$\{i\}\)/);
  // 실행부는 한 벌이어야 한다(사본을 두면 확인창·후처리가 갈린다).
  assert.strictEqual((workdesk.match(/async function _pmDepositBackfill/g) || []).length, 1);
});

test('legacy failed deposit-date writes are repaired automatically once per payment view', () => {
  const load = sourceOf('_pmLoad');
  assert.match(load, /pmLegacyDepositRepairRun/);
  assert.match(load, /boardFailedCount/);
  assert.match(load, /deposit-date-backfill/);
});

test('legacy year-formatted deposit dates are normalized automatically once per payment view', () => {
  const load = sourceOf('_pmLoad');
  assert.match(load, /boardStamp/);
  assert.match(load, /compactDepositFormat/);
});

test('sheetless payment-date writes recover a missing saved column from workboard headers', () => {
  assert.match(sheetlessStatus, /findPaymentColumnIndex/);
  assert.match(sheetlessStatus, /raw_sheet_tabs/);
});

test('payment UI keeps the work list and selected-result panel side by side', () => {
  assert.match(workdesk, /class="pmselectionlayout"/);
  assert.match(workdesk, /입금 대상자 수/);
  assert.match(workdesk, /선택 항목 서식 다운로드/);
});

test('transfer batch history is grouped in a bordered panel', () => {
  const paymentRender = workdesk.slice(workdesk.indexOf("$('#pmbody').innerHTML = `"), workdesk.indexOf('function _pmTargetTable'));
  assert.match(paymentRender, /<section class="pmbatchpanel">[\s\S]*\$\{_pmBatchTable\(STATE\.pmBatches\|\|\[\]\)\}[\s\S]*<\/section>/);
  assert.match(workdesk, /\.pmbatchpanel\{[^}]*border:1px solid/);
});

test('transfer batch history appears directly below the payment summary cards', () => {
  const paymentRender = workdesk.slice(workdesk.indexOf("$('#pmbody').innerHTML = `"), workdesk.indexOf('function _pmTargetTable'));
  assert.ok(paymentRender.indexOf('<h2 class="pmh2">이체 회차</h2>') < paymentRender.indexOf('${_pmTargetTable(items)}'));
});

test('transfer batch history shows ten rows before scrolling within its own area', () => {
  const table = sourceOf('_pmBatchTable');
  assert.match(table, /class="lgwrap pm-batch-scroll"/);
  assert.match(workdesk, /\.pm-batch-scroll\{[^}]*max-height:.*overflow-y:auto/);
});

test('transfer batch separates transfer result from workboard application count', () => {
  const result = sourceOf('_pmBatchResult');
  const workboard = sourceOf('_pmBatchWorkboard');
  const table = sourceOf('_pmBatchTable');
  assert.doesNotMatch(result, /반영됨\(시트\)/);
  assert.match(workboard, /기록됨/);
  assert.match(table, /<th>이체결과<\/th><th>작업보드<\/th>/);
  // 작업보드 칸은 회차 인덱스를 받는다(미기록·기록실패 회차의 [입금일 기록] 버튼이 인덱스만 넘긴다).
  assert.match(table, /\$\{_pmBatchResult\(b\)\}<\/td><td>\$\{_pmBatchWorkboard\(b,\s*i\)\}/);
});

test('workboard result uses confirmed write counts instead of paid-result counts', () => {
  const workboard = sourceOf('_pmBatchWorkboard');
  assert.match(workboard, /boardRecordedCount/);
  assert.match(workboard, /boardQueuedCount/);
  assert.doesNotMatch(workboard, /\$\{b\.resultAppliedCount\}건 반영됨/);
});

(async () => {
  for (const { name, fn } of _asyncTests) {
    try { await fn(); console.log('  ok ' + name); }
    catch (error) { console.error('  not ok ' + name + '\n    ' + error.message); process.exitCode = 1; }
  }
})();
