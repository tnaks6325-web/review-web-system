'use strict';

/* ★★ 입금관리 — 입금명(통장표시)이 없는 작업은 **선택할 수 없고**, 누르면 그 작업의 작업보드로 가서
   **입금명 설정 창을 바로 연다**(사용자 확정 2026-10-08). 종전에는 경고만 하고 은행 서식에 담겨
   리뷰어 통장에 이름 없이 찍혔다.
   고정하는 것:
   ① `_pmOn`(다운로드·합계·대상자 수·작업 목록·표 체크의 단일 출처)이 no_memo 를 뺀다
   ② 입금명 없는 작업은 [입금명 필요] 줄로 보이고, 드래그 선택 범위에 끼지 않으며, onclick 은 인덱스만
   ③ 입금명을 정하고 돌아와도 **자동 선택하지 않는다**(선택이 "전체(null)"일 때 목록으로 굳힌다)
   ④ 작업보드 도착 시 예약을 **한 번만**, **같은 작업일 때만** 소비해 `_cndFix('memo')` 를 연다
   ⑤ 표의 [미설정] 은 여전히 작업보드로 보낸다(결정 111 — 창구는 작업 조건 하나) */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const workdesk = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

function sourceOf(name) {
  const start = workdesk.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  let depth = 0, started = false;
  for (let i = start; i < workdesk.length; i++) {
    if (workdesk[i] === '{') { depth++; started = true; }
    else if (workdesk[i] === '}' && started && --depth === 0) return workdesk.slice(start, i + 1);
  }
  throw new Error(name + ' is incomplete');
}
function constSource(name) {
  const line = workdesk.match(new RegExp('^const ' + name + '\\s*=.*$', 'm'));
  assert.ok(line, name + ' must exist');
  return line[0];
}
function test(name, fn) {
  try { fn(); console.log('  ok ' + name); }
  catch (error) { console.error('  not ok ' + name + '\n    ' + error.message); process.exitCode = 1; }
}

function load() {
  const S = {
    STATE: { pmExcluded: {}, pmFilter: {}, pmWorkQ: '' },
    esc: v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    _pmNum: n => String(Number(n) || 0),
    calls: [],
    setTimeout: fn => fn(),
  };
  S.switchView = v => S.calls.push(['switchView', v]);
  S._cndFix = k => S.calls.push(['cndFix', k]);
  S._toast = m => S.calls.push(['toast', m]);
  vm.createContext(S);
  vm.runInContext([
    constSource('_pmNeedsMemo'), constSource('_pmOn'), constSource('_pmKey'), constSource('PM_MANAGER_NICK'),
    ...['_pmWorkKey', '_pmManagerName', '_pmManagerMatch', '_pmFilterItems', '_pmFilterState', '_pmWorkEntries',
      '_pmNormQ', '_pmMatchWork', '_pmMemoWorkEntries', '_pmMemoWorkRowsHtml', '_pmQueueMemoFix', '_pmOpenMemoWork',
      '_pmHoldMemoWorks', '_runPendingCndFix', '_pmUnassignedWorks', '_pmHoldWorkEntries'].map(sourceOf),
    // 최상위 const 는 vm 컨텍스트 속성으로 안 드러난다 — 검사에서 부르도록 꺼내 둔다
    'this._pmOn=_pmOn; this._pmNeedsMemo=_pmNeedsMemo;',
  ].join('\n'), S);
  return S;
}
const row = (o = {}) => Object.assign({ sheetId: 'S1', tabName: 'A', tabLabel: 'A작업', rowIndex: 1, manager: '만두',
  payable: true, warnings: [], amount: 1000 }, o);

test('① 입금명 없는 줄은 _pmOn(선택 판정 단일 출처)에서 빠진다 — 보류·제외 규칙은 그대로', () => {
  const S = load();
  assert.strictEqual(S._pmOn(row()), true);
  assert.strictEqual(S._pmOn(row({ warnings: ['no_memo'] })), false, '★ 입금명 없는 줄이 선택 대상에 남았다');
  assert.strictEqual(S._pmOn(row({ payable: false })), false);
  S.STATE.pmExcluded['S1||A||1'] = true;
  assert.strictEqual(S._pmOn(row()), false);
  // 판정은 서버 warnings 그대로 — transferMemo 를 화면에서 다시 보지 않는다(사본 0)
  assert.doesNotMatch(constSource('_pmNeedsMemo'), /transferMemo/);
});

test('② 입금명만 없는 작업 = [입금명 필요] 목록 · 보류만 있는 작업·섞인 작업은 제외', () => {
  const S = load();
  const items = [
    row({ tabName: 'OK', tabLabel: '정상' }),
    row({ tabName: 'MEMO', tabLabel: '입금명없음', warnings: ['no_memo'] }),
    row({ tabName: 'HOLD', tabLabel: '보류', payable: false, warnings: ['no_memo'] }),
    row({ tabName: 'MIX', tabLabel: '섞임', rowIndex: 1 }),
    row({ tabName: 'MIX', tabLabel: '섞임', rowIndex: 2, warnings: ['no_memo'] }),
  ];
  const keys = arr => JSON.parse(JSON.stringify(arr.map(([k]) => k)));
  assert.deepStrictEqual(keys(S._pmMemoWorkEntries(items, '')), ['S1||MEMO']);
  assert.deepStrictEqual(keys(S._pmWorkEntries(items, '', S._pmOn)).sort(), ['S1||MIX', 'S1||OK']);
});

test('② [입금명 필요] 줄은 드래그 배선이 없고 onclick 은 인덱스만 넘긴다', () => {
  const S = load();
  const evil = `x"><img src=x onerror=alert(1)>`;
  const html = S._pmMemoWorkRowsHtml([row({ tabName: evil, tabLabel: evil, warnings: ['no_memo'] })], '');
  assert.match(html, /onclick="_pmOpenMemoWork\(0\)"/);
  assert.doesNotMatch(html, /onpointerdown|onpointerenter|data-work-key/, '★ 끌어서 고르는 범위에 낄 수 있다');
  assert.doesNotMatch(html, /<img src=x/, '★ 작업명이 이스케이프되지 않았다');
  assert.match(html, /입금명 필요/);
  assert.strictEqual(S.STATE.pmMemoWorks.length, 1);
  // 검색어가 있으면 같은 규칙으로 좁힌다
  S.STATE.pmWorkQ = '없는작업';
  assert.strictEqual(S._pmMemoWorkRowsHtml([row({ warnings: ['no_memo'] })], ''), '');
});

test('② 줄을 누르면 그 작업보드를 열고 입금명 설정 창을 예약한다', () => {
  const S = load();
  S._pmMemoWorkRowsHtml([row({ sheetId: 'S9', tabName: 'T9', tabGid: '77', warnings: ['no_memo'] })], '');
  S._pmOpenMemoWork(0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.STATE.pendingTab)), { sheetId: 'S9', tabName: 'T9', tabGid: '77', spreadsheetTitle: '' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.STATE.pendingCndFix)), { sheetId: 'S9', tabName: 'T9', kind: 'memo' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.calls)), [['switchView', 'workdesk']]);
});

test('③ 입금명을 정하고 돌아와도 자동 선택하지 않는다(선택이 "전체"일 때만 목록으로 굳힌다)', () => {
  const S = load();
  const before = [row({ tabName: 'OK' }), row({ tabName: 'MEMO', warnings: ['no_memo'] })];
  S._pmHoldMemoWorks(before);
  assert.strictEqual(S.STATE.pmFilter.workKeys, null, '아직 굳힐 이유가 없다(고를 수 있는 작업은 전부 선택 그대로)');
  // 입금명을 정하고 돌아옴 → 이제 고를 수 있는 작업이 됐다
  const after = [row({ tabName: 'OK' }), row({ tabName: 'MEMO' })];
  S._pmHoldMemoWorks(after);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.STATE.pmFilter.workKeys)), ['S1||OK'], '★ 입금명을 정한 작업이 저절로 선택됐다');
  // 이미 목록으로 고른 상태는 건드리지 않는다
  const S2 = load();
  S2.STATE.pmFilter = { workKeys: ['S1||OK'] };
  S2._pmHoldMemoWorks(after);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S2.STATE.pmFilter.workKeys)), ['S1||OK']);
  // 선택 상태를 정한 뒤에 보이는 건을 뽑는다(순서 계약)
  const render = sourceOf('_pmRender');
  assert.ok(render.indexOf('_pmHoldMemoWorks(allItems)') < render.indexOf('_pmVisibleItems()'));
});

test('④ 작업보드 도착 시 예약은 한 번만, 같은 작업일 때만 입금명 설정 창을 연다', () => {
  const S = load();
  const t = { sheetId: 'S1', tabName: 'A' };
  S.STATE.cur = t; S.STATE.wd = { condition: {} };
  S.STATE.pendingCndFix = { sheetId: 'S1', tabName: 'A', kind: 'memo' };
  S._runPendingCndFix();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S.calls)), [['cndFix', 'memo']]);
  S._runPendingCndFix();                                   // 다시 그려도 또 열리지 않는다
  assert.strictEqual(S.calls.length, 1, '★ 예약이 소비되지 않아 렌더마다 창이 다시 뜬다');
  // 다른 작업이 열렸으면 실행하지 않고 버린다
  S.STATE.pendingCndFix = { sheetId: 'S1', tabName: 'B', kind: 'memo' };
  S._runPendingCndFix();
  assert.strictEqual(S.calls.length, 1, '★ 엉뚱한 작업의 설정 창이 열렸다');
  assert.strictEqual(S.STATE.pendingCndFix, null);
  // 작업 조건을 못 받았으면 조용히 끝내지 않고 말한다
  S.STATE.wd = { condition: null };
  S.STATE.pendingCndFix = { sheetId: 'S1', tabName: 'A', kind: 'memo' };
  S._runPendingCndFix();
  assert.strictEqual(S.calls[1][0], 'toast');
  // 작업보드 렌더 끝에서 부른다
  assert.match(sourceOf('renderWorkdesk'), /_runPendingCndFix\(\);\s*\}$/);
});

test('⑤ 표: 입금명 없는 줄의 체크는 막히고, [미설정] 은 작업보드 + 설정 창 예약으로 간다', () => {
  const table = sourceOf('_pmTargetTable');
  assert.match(table, /_pmNeedsMemo\(it\)\?'<input type="checkbox" disabled/);
  const rowMemo = sourceOf('_pmRowMemo');
  assert.match(rowMemo, /_pmQueueMemoFix\(it\); return _pmOpenBoard\(i\);/);
  // 결정 217: 노란 안내 상자 대신 왼쪽 「고쳐야 고를 수 있는 작업」 줄이 건수를 말한다(선택과 무관하게 담당자 범위 전체)
  assert.match(sourceOf('_pmMemoWorkRowsHtml'), /통장표시가 없는 건/);
  assert.match(sourceOf('_pmMemoWorkRowsHtml'), /_pmMemoWorkEntries\(allItems,manager\)/);
  // 입금명만 없는 작업은 오른쪽 표·보완 목록에 되풀이하지 않는다
  assert.match(sourceOf('_pmVisibleItems'), /_pmMemoWorkEntries\(all, filter\.manager\)/);
  // 단 그 작업의 보류 줄은 남긴다(계좌 보완 목록 건수가 사라지지 않게)
  assert.match(sourceOf('_pmVisibleItems'), /!memo\.has\(_pmWorkKey\(it\)\) \|\| !it\.payable/);
});

test('⑥ 담당자도 입금명도 없는 작업은 "담당자 미지정" 안내에 남는다(담당자 칩을 골라도 사라지지 않게 — Codex P2)', () => {
  const S = load();
  const items = [row({ tabName: 'NOMGR', manager: '', warnings: ['no_memo'] }), row({ tabName: 'OK' })];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S._pmUnassignedWorks(items).map(([k]) => k))), ['S1||NOMGR']);
  // 보류 줄만 있는 작업은 종전처럼 제외
  assert.strictEqual(S._pmUnassignedWorks([row({ manager: '', payable: false })]).length, 0);
});
