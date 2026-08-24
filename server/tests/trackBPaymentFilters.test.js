'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const paymentService = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'payment.service.js'), 'utf8');
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

/* ★★ 회차 #18 사고(2026-08-24): 입금관리 담당자는 `tab_configs.manager` 만 봤고 작업 화면은
   작업오더 담당자를 닉네임으로 바꿔 보여줬다 — 출처가 둘이라 오더에서 담당자가 바뀐 작업이
   옛 담당자 칩에 남았고, "망고만 선택"한 서식에 만두 작업의 이체건이 딸려왔다.
   → 담당자 판정은 작업 화면과 같은 출처(작업오더)를 우선한다. 완화 = 사고 재발. */
test('payment target metadata resolves the work manager from the work order first', () => {
  assert.match(paymentService, /tc\.manager\s+AS\s+"manager"/);
  assert.match(paymentService, /wo\.work_manager\s+AS\s+"orderWorkManager"/);
  assert.match(paymentService, /wo\.manager_name\s+AS\s+"orderManager"/);
  assert.match(paymentService, /w\.goods_cost_type,\s*w\.work_manager,\s*w\.manager_name\s+FROM work_orders/);
  assert.match(paymentService, /resolveWorkManager\(\{[\s\S]{0,120}orderWorkManager:\s*t\.orderWorkManager/);
});

test('the work manager falls back to the tab setting only when the order says nothing', () => {
  const resolve = require('../src/services/payment.service').resolveWorkManager;
  const nickMap = { '\uBC15\uC138\uD76C': '\uB9CC\uB450', '\uBC15\uC740\uBE44': '\uB9DD\uACE0' };
  // 오더가 담당자를 말하면 그 값이 이긴다 — 탭 값은 접수 업서트가 blank-only 라 옛 담당자로 굳는다.
  assert.deepStrictEqual(resolve({ orderWorkManager: '\uBC15\uC138\uD76C', tabManager: '\uB9DD\uACE0', nickMap }),
    { manager: '\uB9CC\uB450', managerSource: 'order' });
  // 작업담당(065)이 비었거나 랜덤이면 작업 카드가 읽는 칸(manager_name)으로 이어 본다.
  assert.deepStrictEqual(resolve({ orderWorkManager: '\uB79C\uB364', orderManager: '\uBC15\uC138\uD76C', tabManager: '\uB9DD\uACE0', nickMap }),
    { manager: '\uB9CC\uB450', managerSource: 'order' });
  // 닉네임 맵이 비어도 065 매핑으로 같은 결론에 이른다(fail-soft).
  assert.deepStrictEqual(resolve({ orderManager: '\uBC15\uC740\uBE44', tabManager: '\uB9CC\uB450', nickMap: {} }),
    { manager: '\uB9DD\uACE0', managerSource: 'order' });
  // 랜덤·미매핑·오더 없음 = 오더가 담당자를 정하지 않은 것 → 탭 설정 폴백.
  assert.deepStrictEqual(resolve({ orderManager: '\uB79C\uB364', tabManager: '\uB9CC\uB450', nickMap }),
    { manager: '\uB9CC\uB450', managerSource: 'tab' });
  assert.deepStrictEqual(resolve({ orderManager: '', tabManager: '\uBC15\uC740\uBE44', nickMap }),
    { manager: '\uB9DD\uACE0', managerSource: 'tab' });
  // 둘 다 없으면 '담당자 없음' — 추측하지 않는다.
  assert.deepStrictEqual(resolve({ orderManager: '', tabManager: '', nickMap }),
    { manager: '', managerSource: null });
});

const sandbox = {};
vm.createContext(sandbox);
function constSource(name) {
  const line = workdesk.match(new RegExp('^const ' + name + '=.*$', 'm'));
  assert.ok(line, name + ' must exist');
  return line[0];
}

vm.runInContext(constSource('PM_MANAGER_NICK') + '\n' + constSource('PM_NO_MANAGER') + '\n'
  + sourceOf('_pmWorkKey') + '\n' + sourceOf('_pmManagerName') + '\n' + sourceOf('_pmManagerMatch') + '\n' + sourceOf('_pmFilterItems') + '\n' + sourceOf('_pmSelectedPaymentTotal') + '\n' + sourceOf('_pmSelectedRecipientCount') + '\n' + sourceOf('_pmWorkEntries') + '\n' + sourceOf('_pmToggleWorkKeys') + '\n' + sourceOf('_pmSetWorkSelection') + '\n' + sourceOf('_pmWorkKeyRange'), sandbox);

test('legacy manager names are normalized on both sides, not just one', () => {
  assert.strictEqual(sandbox._pmManagerName('\uBC15\uC740\uBE44'), '\uB9DD\uACE0');
  // ★ 한쪽만 접으면 같은 사람이 '만두'와 '박세희' 두 칩으로 갈려, 한 칩만 고른 담당자의
  //   서식에서 나머지 절반이 조용히 빠진다.
  assert.strictEqual(sandbox._pmManagerName('\uBC15\uC138\uD76C'), '\uB9CC\uB450');
});

const PM_NONE = vm.runInContext('PM_NO_MANAGER', sandbox);   // const 선언은 sandbox 프로퍼티가 아니다

test('the unassigned chip is a real group, not everything', () => {
  const unassigned = [
    { sheetId: 'S1', tabName: 'A', manager: '\uB9CC\uB450', amount: 1000, payable: true, excluded: false },
    { sheetId: 'S2', tabName: 'B', manager: '', amount: 500, payable: true, excluded: false },
  ];
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(sandbox._pmFilterItems(unassigned, { manager: PM_NONE }))),
    [unassigned[1]]);
  // 담당자 칩들의 합이 '전체'와 같아야 한다 — 어느 칩에도 안 잡히는 건이 남으면 조용한 누락이다.
  assert.strictEqual(sandbox._pmFilterItems(unassigned, { manager: '\uB9CC\uB450' }).length
    + sandbox._pmFilterItems(unassigned, { manager: PM_NONE }).length,
    sandbox._pmFilterItems(unassigned, {}).length);
});

test('the download confirmation states which manager and works are being locked', () => {
  const confirmText = sourceOf('_pmDownloadConfirmText');
  assert.match(confirmText, /_pmManagerLabel\(filter\.manager\)/);
  assert.match(confirmText, /\uC791\uC5C5 \$\{works\.length\}\uAC1C/);
  assert.match(sourceOf('_pmDownload'), /confirm\(_pmDownloadConfirmText\(label, picked\)\)/);
  // 확인창에 실린 목록과 실제로 담기는 목록은 **같은 배열**이어야 한다(사본을 두면 갈린다).
  assert.match(sourceOf('_pmDownload'), /const rows = picked\.map/);
});

test('the manager chip row offers the unassigned group when such works exist', () => {
  const bar = sourceOf('_pmFilterBar');
  assert.match(bar, /hasNoManager/);
  assert.match(bar, /managerButton\(PM_NO_MANAGER, *'\uB2F4\uB2F9\uC790 \uBBF8\uC9C0\uC815'\)/);
});

const rows = [
  { sheetId: 'S1', tabName: 'A', manager: '\uB9CC\uB450', amount: 1000, payable: true, excluded: false },
  { sheetId: 'S1', tabName: 'B', manager: '\uB9DD\uACE0', amount: 2200, payable: true, excluded: false },
  { sheetId: 'S2', tabName: 'A', manager: '\uB9CC\uB450', amount: 300, payable: true, excluded: true },
  { sheetId: 'S3', tabName: 'C', manager: '\uB9CC\uB450', amount: 700, payable: true, excluded: false },
];

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
