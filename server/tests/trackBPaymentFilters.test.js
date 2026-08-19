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

test('payment target metadata includes the work manager', () => {
  assert.match(paymentService, /tc\.manager\s+AS\s+"manager"/);
  assert.match(paymentService, /manager:\s*t\.manager\s*\|\|\s*''/);
});

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(sourceOf('_pmWorkKey') + '\n' + sourceOf('_pmManagerName') + '\n' + sourceOf('_pmFilterItems') + '\n' + sourceOf('_pmSelectedPaymentTotal') + '\n' + sourceOf('_pmSelectedRecipientCount') + '\n' + sourceOf('_pmWorkEntries') + '\n' + sourceOf('_pmToggleWorkKeys') + '\n' + sourceOf('_pmSetWorkSelection') + '\n' + sourceOf('_pmWorkKeyRange'), sandbox);

test('legacy manager name is normalized to mango', () => {
  assert.strictEqual(sandbox._pmManagerName('\uBC15\uC740\uBE44'), '\uB9DD\uACE0');
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

test('payment result application does not expose a manual deposit-date retry', () => {
  assert.doesNotMatch(sourceOf('_pmBatchActions'), /_pmBackfillPaidDeposit/);
  assert.doesNotMatch(workdesk, /function _pmBackfillPaidDeposit/);
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
  assert.match(table, /\$\{_pmBatchResult\(b\)\}<\/td><td>\$\{_pmBatchWorkboard\(b\)\}/);
});

test('workboard result uses confirmed write counts instead of paid-result counts', () => {
  const workboard = sourceOf('_pmBatchWorkboard');
  assert.match(workboard, /boardRecordedCount/);
  assert.match(workboard, /boardQueuedCount/);
  assert.doesNotMatch(workboard, /\$\{b\.resultAppliedCount\}건 반영됨/);
});
