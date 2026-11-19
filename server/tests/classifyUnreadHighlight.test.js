'use strict';
/**
 * 결정 385 — 작업보드 「분류」 칸(결정 383)이 빈 **구매양식 제출 주문**을 연한 노란 「확인」 칸으로 보이고,
 * 누르면 기존 「제출물 크게 보기」 팝업(구매캡처)을 그 주문들만 모아 열어 후보 중 하나를 골라 저장한다.
 *
 *   A) 판정 단일 출처 `_clsNeedsCheck(r)` = 「분류」 칸 있음 · 구매양식 주문 있음(`hasOrder`) · 칸 값이 빈칸(gCellDisp 와 같은 값)
 *      — 직원이 비워 둔 값('' 기록)도 빈칸이라 「확인」(헤더 메뉴 「(미분류)」와 같은 판정).
 *   B) 머리글 메뉴: 「(미분류)」 건수 = 노란 칸 수 · 주문이 아직 없는 빈 줄은 「(주문 전)」으로 따로(206줄이 미분류로 세지던 것)
 *   C) 칸 그리기: 「확인」 글자는 화면에만 — 복사(data-val)·내려받기(gCellDisp)·정렬 값은 빈칸 그대로
 *   D) 누르면: 팝업 목록 = 「확인」 줄만 · 후보 버튼(단일 선택 · aria-pressed) · 고르면 기존 추가 열 저장(custom-value) →
 *      표 칸 갱신 · 다음 「확인」 줄로 · 실패는 기존 문구로 그 자리에 · 캡처 없는 주문은 「캡처 없음」 안내
 *   E) 업체 화면·다른 팝업 길은 그대로
 * 실제 frontend/workdesk.html 함수 본문을 vm 으로 떼어 가짜 DOM/api 로 실행한다(외부 요청 0).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const WD = fs.readFileSync(path.join(ROOT, 'frontend/workdesk.html'), 'utf8');

/** workdesk.html 최상위 선언 하나(function/const)를 다음 최상위 선언 직전까지 떼어 낸다. */
function pick(name) {
  const re = new RegExp('\\n(?:async function ' + name + '\\(|function ' + name + '\\(|const ' + name + '=)');
  const m = re.exec(WD);
  assert.ok(m, name + ' 를 workdesk.html 에서 찾았다');
  const from = m.index + 1;
  const rest = WD.slice(from + 1);
  const nx = /\n(?:async function |function |const |let |var |\/\*|<\/script>)/.exec(rest);
  return WD.slice(from, from + 1 + (nx ? nx.index : rest.length));
}

const COL = 'cc1';
const CANDS = ['피치', '레몬', '스트로베리'];
function roster() {
  return [
    { id: 'r1', seq: 2, boardNo: 1, hasOrder: true, filled: true, editable: true, customValues: { [COL]: '피치' }, rowJson: { 수취인: '가짜가' } },
    { id: 'r2', seq: 3, boardNo: 2, hasOrder: true, filled: true, editable: true, customValues: {}, rowJson: { 수취인: '가짜나' } },          // 못 읽음(기록 없음)
    { id: 'r3', seq: 4, boardNo: 3, hasOrder: true, filled: true, editable: true, customValues: { [COL]: '' }, rowJson: { 수취인: '가짜다' } }, // 직원이 비워 둠
    { id: 'r4', seq: 5, boardNo: 4, hasOrder: false, editable: true, customValues: {}, rowJson: {} },                           // 주문 전 빈 줄
    { id: 'r5', seq: 6, boardNo: 5, hasOrder: true, filled: true, editable: true, customValues: {}, rowJson: { 수취인: '가짜라' } },          // 캡처 없음 제출
    { id: 'r6', seq: 7, boardNo: 6, hasOrder: true, filled: true, editable: true, customValues: { [COL]: ' ' }, rowJson: { 수취인: '가짜마' } }, // 공백 = 값(메뉴와 같게)
  ];
}
const IMGS = { 2: [{ slot: 'order_capture', fileId: 'CAPAAAAAAAAAAAAAAAAAAAA1' }], 3: [{ slot: 'order_capture', fileId: 'CAPAAAAAAAAAAAAAAAAAAAA2' }],
  4: [{ slot: 'order_capture', fileId: 'CAPAAAAAAAAAAAAAAAAAAAA3' }], 7: [{ slot: 'order_capture', fileId: 'CAPAAAAAAAAAAAAAAAAAAAA6' }] };

function setup({ reply, canEdit = true, classify = true, role = 'admin' } = {}) {
  const log = { api: [], toast: [] };
  const els = {};
  const listeners = {};
  const pop = { id: 'rvpop', _h: '', set innerHTML(h) { this._h = h; }, get innerHTML() { return this._h; }, remove() { delete els.rvpop; } };
  const document = {
    getElementById: (k) => els[k] || null,
    createElement: () => pop,
    body: { appendChild: (e) => { els[e.id] = e; } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const sb = {
    console, Date, JSON, Math, Object, String, Number, Promise, RegExp, Array, Boolean, Map, Set,
    document, API_BASE: 'https://api.example.com', setTimeout: () => 0,
    api: async (u, o) => { const b = o && o.body ? JSON.parse(o.body) : null; log.api.push({ u, b }); return reply ? reply(u, b) : { ok: true }; },
    toast: (m) => log.toast.push(m),
    _fullAttrs: (id, url) => ` src="${url}"`,
    _syncGridColumnWidths() {},
    _rvReceiptActive: () => false,
    _rvRender() {}, _rvBind() {}, _rvSelect() {},
  };
  sb.window = sb;
  vm.createContext(sb);
  const names = ['esc', '_rvUrl', '_rvNo', '_rvWho', '_rvReceiptApplies', '_rvReceiptSubmitted', '_rvKindFiles', '_rvPeople',
    '_CASH_RECEIPT_COL', '_PURCHASE_QTY_COL', '_FEE_DEPOSIT_COL', 'gCellDisp', 'gFilterValues',
    '_isClassifyCol', '_clsNeedsCheck', '_CLS_NOORDER', '_CLS_TIP', 'openClassifyCheck', '_clsBarHtml', '_clsPick', '_clsCellTd',
    '_gridRowById', '_paintGridCell', '_cellPendingWrites', 'commitCellEdit', '_cellCopyText',
    '_rvBoot', '_rvSeedEdge', '_clsBind', '_clsCanCheck', '_cellLockReason', '_workdeskStatusKindForField'];
  const popFrom = WD.indexOf('\nfunction _rvPopIdx(');
  const popTo = WD.indexOf('\n/* ── 시안 B');
  assert.ok(popFrom > 0 && popTo > popFrom, '팝업 함수 묶음');
  vm.runInContext('var STATE = {};\n' + names.map(pick).join('\n') + '\n' + WD.slice(popFrom, popTo), sb);
  const S = vm.runInContext('STATE', sb);
  S.role = role; S.canEdit = canEdit; S.cur = { sheetId: 'sh1', tabName: '가짜 작업' };
  S.wd = { roster: roster(), customColumns: [{ id: COL, colName: '분류' }], ...(classify ? { classifyColumn: { campaignId: 'c1', columnId: COL, column: '분류', candidates: CANDS } } : {}) };
  S.rvImgs = IMGS;
  const run = (c) => vm.runInContext(c, sb);
  const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { sb, S, log, run, tick, listeners, pop: () => (els.rvpop ? els.rvpop.innerHTML : null) };
}

test('A) 판정 단일 출처: 주문 있음 + 빈칸만 「확인」 — 주문 전 빈 줄·값 있는 줄·공백 값·「분류」 칸 없는 작업은 아님', () => {
  const e = setup();
  const need = e.S.wd.roster.map(r => e.sb._clsNeedsCheck(r));
  assert.deepEqual(need, [false, true, true, false, true, false]);
  // 직원이 비워 둔 값('' 기록)도 빈칸 = 확인(헤더 메뉴 (미분류)와 같은 값)
  assert.equal(e.sb.gCellDisp(e.S.wd.roster[2], 'ccol:' + COL), '');
  const e2 = setup({ classify: false });
  assert.deepEqual(e2.S.wd.roster.map(r => e2.sb._clsNeedsCheck(r)), [false, false, false, false, false, false]);
});

test('B) 머리글 메뉴 거르기 값: 「(미분류)」 = 노란 칸과 같은 줄 · 주문 전 빈 줄은 따로 · 다른 추가 열은 그대로', () => {
  const e = setup();
  const vals = e.S.wd.roster.map(r => e.sb.gFilterValues(r, 'ccol:' + COL)[0]);
  const noorder = e.run('_CLS_NOORDER');
  assert.ok(noorder && noorder !== '', '주문 전 값은 빈칸과 다른 거르기 값');
  assert.deepEqual(vals, ['피치', '', '', noorder, '', ' ']);
  const blank = e.S.wd.roster.filter(r => e.sb.gFilterValues(r, 'ccol:' + COL)[0] === '').map(r => r.id);
  const yellow = e.S.wd.roster.filter(r => e.sb._clsNeedsCheck(r)).map(r => r.id);
  assert.deepEqual(blank, yellow, '(미분류) 거르기 = 노란 칸');
  // 분류 칸이 아닌 추가 열·시트 열은 빈 값 그대로
  e.S.wd.customColumns.push({ id: 'cc2', colName: '메모' });
  assert.equal(e.sb.gFilterValues(e.S.wd.roster[3], 'ccol:cc2')[0], '');
  // 메뉴 라벨
  const menu = WD.slice(WD.indexOf('function openGColMenu('), WD.indexOf('function closeGColMenu('));
  assert.match(menu, /\(주문 전\)/);
  assert.match(menu, /\(미분류\)/);
});

test('C) 칸 그리기: 노란 「확인」은 화면 글자만 — data-val·복사·내려받기 값은 빈칸 · 값이 들어가면 사라진다', () => {
  const e = setup();
  const td = { _a: {}, innerHTML: '', classList: { _s: new Set(['gcell', 'gedit', 'gempty']), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
    toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    setAttribute(k, v) { this._a[k] = String(v); }, getAttribute(k) { return k in this._a ? this._a[k] : null }, cloneNode() { return this; }, querySelectorAll: () => [] };
  const r2 = e.S.wd.roster[1];
  e.sb._paintGridCell(r2, 'ccol:' + COL, td);
  assert.ok(td.classList.contains('gclschk'), '노란 칸');
  assert.ok(!td.classList.contains('gempty'));
  assert.equal(td.innerHTML, '확인');
  assert.equal(td.getAttribute('data-val'), '', '복사·편집 값은 빈칸');
  assert.equal(e.sb._cellCopyText(td), '', '복사하면 빈칸');
  assert.equal(e.sb.gCellDisp(r2, 'ccol:' + COL), '', '내려받기·정렬 값은 빈칸');
  assert.match(td.getAttribute('title'), /구매 캡처/);
  r2.customValues[COL] = '레몬';
  e.sb._paintGridCell(r2, 'ccol:' + COL, td);
  assert.ok(!td.classList.contains('gclschk'));
  assert.equal(td.innerHTML, '레몬');
  // 주문 전 빈 줄 · 편집 못 하는 칸(gedit 없음)은 노랗게 하지 않는다
  const r4 = e.S.wd.roster[3];
  e.sb._paintGridCell(r4, 'ccol:' + COL, td);
  assert.ok(!td.classList.contains('gclschk')); assert.equal(td.innerHTML, '—');
  td.classList.remove('gedit'); r2.customValues[COL] = '';
  e.sb._paintGridCell(r2, 'ccol:' + COL, td);
  assert.ok(!td.classList.contains('gclschk'), '편집 권한 없는 칸은 표시 안 함');
  // 그리드 본문(buildGrid)의 추가 열 칸도 같은 판정·같은 글자를 쓴다
  const bg = WD.slice(WD.indexOf("else if(c.kind==='custom'){"), WD.indexOf("else { const statusKind=_workdeskStatusKind(h);"));
  assert.match(bg, /_clsCanCheck\(r\)/);   // = 편집 권한(canE) + _clsNeedsCheck — F3 의 잠긴 줄 제외까지 같은 함수
  assert.match(pick('_clsCanCheck'), /_clsNeedsCheck\(r\)/);
  assert.match(bg, /gclschk/);
});

test('D1) 누르면: 「확인」 줄만 모은 크게 보기 팝업 · 누른 줄부터 · 후보 버튼(단일 선택) · 캡처 없는 주문은 「캡처 없음」', () => {
  const e = setup();
  e.run("openClassifyCheck('r2')");
  const p = e.S.rvPop;
  assert.ok(p && p.cls, '분류 확인 모드');
  assert.deepEqual(p.people.map(x => x.r.id), ['r2', 'r3', 'r5']);
  assert.equal(p.idx, 0);
  const h = e.pop();
  assert.match(h, /분류 확인<span class="cnt">3명/);
  for (const c of CANDS) assert.ok(h.includes('>' + c + '</button>'), c + ' 버튼');
  assert.equal((h.match(/aria-pressed="false"/g) || []).length, 3);
  assert.ok(!/<select|type="checkbox"/.test(h.slice(h.indexOf('rvpcls'))), '드롭다운·체크박스 없음');
  assert.ok(!/↗/.test(h), '대각선 화살표 없음');
  assert.match(h, /후보에 없으면 창을 닫고 칸을 우클릭해 직접 적으세요/);
  // 캡처 없는 제출(r5)로 넘어가면 「캡처 없음」 안내
  e.run('_rvPopPick(2)');
  assert.match(e.pop(), /캡처 없음/);
  assert.match(e.pop(), /이 주문은 구매 캡처가 없습니다/);
  // 누른 줄이 r3 이면 r3 부터
  e.run('_rvPopClose()'); e.run("openClassifyCheck('r3')");
  assert.equal(e.S.rvPop.people[e.S.rvPop.idx].r.id, 'r3');
});

test('D2) 고르면 기존 추가 열 저장(custom-value)으로 그 칸에 → 표 모델 갱신 → 다음 「확인」 줄 · 끝나면 안내', async () => {
  const e = setup();
  e.run("openClassifyCheck('r2')");
  e.run('_clsPick(1)');
  await e.tick();
  const w = e.log.api.filter(x => x.u === '/api/trackb/workdesk/custom-value');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].b, { sheetId: 'sh1', tabName: '가짜 작업', rowId: 'r2', columnId: COL, value: '레몬' });
  assert.equal(e.S.wd.roster[1].customValues[COL], '레몬');
  assert.equal(e.sb._clsNeedsCheck(e.S.wd.roster[1]), false, '노란 표시 대상에서 빠짐');
  assert.equal(e.S.rvPop.people[e.S.rvPop.idx].r.id, 'r3', '다음 확인 줄로');
  // 돌아가 보면 고른 값이 눌린 상태(단일 선택)
  e.run('_rvPopStep(-1)');
  assert.match(e.pop(), /aria-pressed="true"[^>]*>레몬<\/button>/);
  e.run('_rvPopStep(1)');
  e.run('_clsPick(0)'); await e.tick();
  e.run('_clsPick(2)'); await e.tick();
  assert.deepEqual(e.S.wd.roster.filter(r => e.sb._clsNeedsCheck(r)).map(r => r.id), []);
  assert.match(e.pop(), /「분류」를 확인할 주문을 모두 골랐습니다/);
});

test('D3) 저장 실패: 기존 문구로 그 자리에 알리고 같은 줄에 남는다 · 표 값은 되돌린다', async () => {
  const e = setup({ reply: (u) => (u === '/api/trackb/workdesk/custom-value' ? { ok: false, error: 'ambiguous_identity' } : { ok: true }) });
  e.run("openClassifyCheck('r2')");
  e.run('_clsPick(0)'); await e.tick();
  assert.equal(e.S.rvPop.people[e.S.rvPop.idx].r.id, 'r2', '같은 줄에 남음');
  assert.ok(!e.S.wd.roster[1].customValues[COL], '값 되돌림');
  assert.match(e.pop(), /저장 거부: ambiguous_identity/);
  assert.ok(e.sb._clsNeedsCheck(e.S.wd.roster[1]));
  const e2 = setup({ reply: () => { throw new Error('net'); } });
  e2.run("openClassifyCheck('r2')"); e2.run('_clsPick(0)'); await e2.tick();
  assert.match(e2.pop(), /저장 실패 — 네트워크/);
});

test('D4) 권한: 추가 열을 못 고치는 사람에게는 열지 않는다 · 확인 대상이 아닌 줄을 누르면 아무 일도 없다', () => {
  const e = setup({ canEdit: false });
  e.run("openClassifyCheck('r2')");
  assert.equal(e.S.rvPop, undefined);
  const e2 = setup();
  e2.run("openClassifyCheck('r1')");
  assert.equal(e2.S.rvPop, undefined);
});

test('E) 다른 길은 그대로: 보통 크게 보기 팝업(업체 화면 공용)은 「참여자」·분류 줄 없음', () => {
  const e = setup({ role: 'advertiser' });
  e.run("_rvOpen('r1', 0)");
  const h = e.pop();
  assert.match(h, /참여자<span class="cnt">/);
  assert.ok(!/rvpcls/.test(h));
});

/* ── F) PR #1845 자동 코드리뷰 지적 3건 ───────────────────────────────────────────────────────── */

test('F1) 처음 사진 목록을 받는 중에 노란 칸을 누르면 — 다 받은 뒤 창을 연다(빈 사진 목록을 찍어 두지 않는다)', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const e = setup({ reply: async (u) => (String(u).indexOf('/review-images') >= 0 ? (await gate, { ok: true, rows: IMGS }) : { ok: true }) });
  e.run('_rvBoot(STATE.cur)');            // 표를 그린 직후 — 사진 목록 요청이 아직 안 끝났다
  assert.equal(e.S.rvImgs, null, '받는 중');
  e.run("openClassifyCheck('r2')");
  await e.tick();
  release(); await e.tick(); await e.tick();
  assert.ok(e.S.rvPop && e.S.rvPop.cls, '다 받은 뒤 창이 열려 있다');
  e.run('_rvPopRender()');
  const h = e.pop();
  assert.ok(h.includes('CAPAAAAAAAAAAAAAAAAAAAA2'), 'r2 구매 캡처가 보인다');
  assert.ok(!/캡처 없음|사진을 불러오지 못했습니다/.test(h), '「캡처 없음」·「못 불러옴」으로 꾸미지 않는다');
  // 두 번 눌러도 창은 한 번(마지막 누름 기준)만 열린다
  let release2;
  const gate2 = new Promise((res) => { release2 = res; });
  const e2 = setup({ reply: async (u) => (String(u).indexOf('/review-images') >= 0 ? (await gate2, { ok: true, rows: IMGS }) : { ok: true }) });
  e2.run('_rvBoot(STATE.cur)');
  e2.run("openClassifyCheck('r2')"); e2.run("openClassifyCheck('r3')");
  release2(); await e2.tick(); await e2.tick();
  assert.equal(e2.S.rvPop.people[e2.S.rvPop.idx].r.id, 'r3', '마지막에 누른 줄');
  // 받다가 실패하면 기다린 뒤 종전 「사진을 불러오지 못했습니다」(꾸미지 않음)
  const e3 = setup({ reply: async (u) => { if (String(u).indexOf('/review-images') >= 0) throw new Error('net'); return { ok: true }; } });
  e3.run('_rvBoot(STATE.cur)');
  e3.run("openClassifyCheck('r2')");
  await e3.tick(); await e3.tick();
  assert.ok(e3.S.rvPop && e3.S.rvPop.cls);
  assert.match(e3.pop(), /사진을 불러오지 못했습니다/);
  // 기다리는 사이 다른 작업으로 옮겨 갔으면 열지 않는다
  let release4;
  const gate4 = new Promise((res) => { release4 = res; });
  const e4 = setup({ reply: async (u) => (String(u).indexOf('/review-images') >= 0 ? (await gate4, { ok: true, rows: IMGS }) : { ok: true }) });
  e4.run('_rvBoot(STATE.cur)');
  e4.run("openClassifyCheck('r2')");
  e4.S.cur = { sheetId: 'sh2', tabName: '다른 작업' };
  release4(); await e4.tick(); await e4.tick();
  assert.ok(!e4.S.rvPop, '다른 작업 화면에는 열지 않는다');
});

test('F2) 노란 칸을 직접 고치는 중(입력칸 안)을 누르면 창이 다시 열리지 않는다 · 보통 클릭은 그대로 연다', () => {
  const e = setup();
  e.run('_clsBind()');
  const clicks = e.listeners.click || [];
  assert.equal(clicks.length, 1, '누르기 위임 1개');
  const inp = { tagName: 'INPUT' };
  const td = { _input: null, getAttribute: (k) => (k === 'data-id' ? 'r2' : null), querySelector: (q) => (/input/.test(q) ? td._input : null) };
  inp.closest = (q) => (/td\.gclschk/.test(q) ? td : null);
  td.closest = (q) => (/td\.gclschk/.test(q) ? td : null);
  td._input = inp;                                     // beginEditCell 이 칸 안에 입력칸을 넣었다(gclschk 는 남아 있다)
  clicks[0]({ target: inp, button: 0 });
  assert.equal(e.S.rvPop, undefined, '입력칸 안 클릭 = 창 안 엶');
  clicks[0]({ target: td, button: 0 });
  assert.equal(e.S.rvPop, undefined, '편집 중인 칸 자체를 눌러도 안 엶');
  td._input = null;                                    // 편집이 끝난 노란 칸
  clicks[0]({ target: td, button: 0 });
  assert.ok(e.S.rvPop && e.S.rvPop.cls, '보통 클릭은 종전대로 연다');
});

test('F3) 같은 주문을 가리키는 잠긴 줄(editable:false)은 확인 목록에 넣지 않고 · 저장 직전에도 다시 막는다', async () => {
  const e = setup();
  // 서버가 중복 줄을 잠그고 추가 열 값을 뺀다 = 화면에선 빈칸 · 주문 있음
  e.S.wd.roster.splice(2, 0, { id: 'r2b', seq: 30, boardNo: 7, hasOrder: true, filled: true, editable: false, customValues: {}, rowJson: { 수취인: '가짜나' } });
  e.S.rvImgs = Object.assign({}, IMGS, { 30: [{ slot: 'order_capture', fileId: 'CAPAAAAAAAAAAAAAAAAAAAA9' }] });
  e.run("openClassifyCheck('r2')");
  assert.deepEqual(e.S.rvPop.people.map(x => x.r.id), ['r2', 'r3', 'r5'], '잠긴 줄 없음');
  assert.match(e.pop(), /남은 3건/);
  e.run("openClassifyCheck('r2b')");
  // 다 골라도 잠긴 줄에는 쓰지 않는다
  e.run('_rvPopClose()'); e.run("openClassifyCheck('r2')");
  for (let k = 0; k < 4; k++) { e.run('_clsPick(0)'); await e.tick(); }
  const w = e.log.api.filter(x => x.u === '/api/trackb/workdesk/custom-value').map(x => x.b.rowId);
  assert.deepEqual(w, ['r2', 'r3', 'r5'], '잠긴 줄(r2b)에 쓰지 않음');
  assert.match(e.pop(), /「분류」를 확인할 주문을 모두 골랐습니다/, '잠긴 줄을 남은 건수로 세지 않는다');
  // 창을 연 뒤 그 줄이 잠기면(저장 직전 다시 확인) 쓰지 않는다
  const e2 = setup();
  e2.run("openClassifyCheck('r2')");
  e2.S.wd.roster[1].editable = false;
  e2.run('_clsPick(0)'); await e2.tick();
  assert.equal(e2.log.api.filter(x => x.u === '/api/trackb/workdesk/custom-value').length, 0, '잠긴 줄 저장 요청 0');
  assert.match(e2.pop(), /잠겼습니다/, '왜 안 되는지 그 자리에(우클릭 메뉴와 같은 문구)');
  assert.equal(e2.S.rvPop.people[e2.S.rvPop.idx].r.id, 'r2', '같은 줄에 남는다');
  // 창을 연 뒤 다음 줄이 잠기면 고른 뒤 그 줄로 넘어가지 않는다(남은 건수에도 안 센다)
  const e3 = setup();
  e3.run("openClassifyCheck('r2')");
  e3.S.wd.roster[2].editable = false;
  e3.run('_clsPick(0)'); await e3.tick();
  assert.equal(e3.S.rvPop.people[e3.S.rvPop.idx].r.id, 'r5', '잠긴 r3 를 건너 r5 로');
  assert.match(e3.pop(), /남은 1건/);
  e2.S.wd.roster[1].ambiguous = true;
  e2.run('_clsPick(0)'); await e2.tick();
  assert.match(e2.pop(), /같은 주문·신원이 여러 줄이라 편집이 잠겼습니다/);
  // 노란 칸 판정과 같은 함수(단일 출처) — 그리드 본문 · 다시 그리기 · 창 목록
  const bg = WD.slice(WD.indexOf("else if(c.kind==='custom'){"), WD.indexOf("else { const statusKind=_workdeskStatusKind(h);"));
  assert.match(bg, /_clsCanCheck\(r\)/);
  assert.match(pick('_paintGridCell'), /_clsCanCheck\(r\)/);
  assert.match(pick('openClassifyCheck'), /_clsCanCheck/);
});
