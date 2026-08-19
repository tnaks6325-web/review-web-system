/* 작업보드 표 — 우클릭 편집 + 범위 선택 복사/붙여넣기 회귀가드 (2026-08-10 사용자 확정)
 *
 *   ① 왼쪽 클릭은 더 이상 편집을 시작하지 않는다(onclick="beginEditCell" 부활 차단)
 *   ② 편집 진입은 우클릭 메뉴(또는 F2) 하나 — contextmenu 배선이 있어야 한다
 *   ③ 선택은 **직사각형**: 세로로만 끌면 그 열만 잡히고 오른쪽 열은 복사되지 않는다
 *      (사용자 확정 예: 참여자 열만 세로 드래그 → 수취인·연락처·주소는 복사 대상 아님)
 *   ④ 붙여넣기는 편집 가능한 셀(.gedit)에만 들어가고, 잠긴 칸은 건너뛰며 건수를 보고한다
 *
 *   ★ 문자열 grep 으로는 ③④를 못 잡는다 → 가짜 DOM 위에서 **실제 실행**해 대조한다.
 *   실행: node tests/gridCellRangeEdit.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra != null ? '→ ' + extra : ''); } };
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ── 1. 정적 배선 ────────────────────────────────────────────────
console.log('\n[1] 배선');
{ // ★ 렌더러(eCell) 본문에서 검사 — 주석의 설명 문구가 대신 통과시키지 않게 한다.
  const i = HTML.indexOf('const eCell=(field, disp, edited');
  const body = i > 0 ? HTML.slice(i, i + 1600) : '';
  ok('셀 렌더러에 onclick=beginEditCell 부활 없음 (왼쪽 클릭=편집 금지)', !!body && !/beginEditCell/.test(body), body ? '' : 'eCell 렌더러를 찾지 못함');
}
ok('우클릭(contextmenu) 로 편집 메뉴를 연다', /addEventListener\('contextmenu'/.test(HTML) && /_openCellMenu\(/.test(HTML));
ok('우클릭 메뉴에 [이 셀 편집] → beginEditCell', /_menuEditCell\(\)\s*\{[\s\S]{0,200}beginEditCell\(td\)/.test(HTML));
ok('copy 이벤트로 선택 범위를 TSV 복사', /addEventListener\('copy'/.test(HTML) && /_selectionTsv\(\)/.test(HTML));
ok('paste 이벤트로 선택 범위에 붙여넣기', /addEventListener\('paste'/.test(HTML) && /_pasteIntoSelection\(/.test(HTML));
// ★ 붙여넣기 저장은 왕복 1회(edit-batch) — 칸마다 요청하면 리미터(분당 120)·PG 풀에 막힌다.
//   낙관 반영·롤백은 단건과 같은 `_applyCellLocal` 한 벌(사본 없음).
ok('붙여넣기 저장은 왕복 1회(edit-batch) 한 경로', /_pasteCommitBatch\(jobs,/.test(HTML)
  && /\/api\/trackb\/workdesk\/edit-batch/.test(HTML));
ok('낙관 반영·롤백은 단건과 같은 한 벌(_applyCellLocal)', /function _applyCellLocal\(/.test(HTML)
  && (HTML.match(/_applyCellLocal\(/g) || []).length >= 3);
ok('재렌더 시 선택 범위를 비운다(엉뚱한 칸 적용 차단)', /STATE\.gSelRange=null;/.test(HTML.slice(HTML.indexOf('function buildGrid'), HTML.indexOf('function buildGrid') + 1200)));
ok('한 번에 붙여넣는 칸 수 상한', /_PASTE_MAX\s*=\s*\d+/.test(HTML));
ok('입금 날짜 열은 내부·광고주 작업보드에서 지정 폭을 쓴다', /'입금':96/.test(HTML)
  && /'입금':88,'입금일':88/.test(HTML));
ok('그리드 안내 문구는 렌더하지 않는다', !/<span class="gnote">/.test(HTML));
ok('선택 요약 렌더 영역이 있다', /id="gselstat"/.test(HTML));
ok('선택 요약은 그리드 툴바의 오른쪽 끝에 남아 있다', /\$\{_folBarHtml\(\)\}\s*\n\s*<output id="gselstat"/.test(HTML));
ok('선택 변경과 해제 모두 요약을 동기화한다', /function _paintSel\(\)[\s\S]{0,1200}_syncSelectionStat\(\)/.test(HTML)
  && /function _clearCellSel\(\)[\s\S]{0,500}_syncSelectionStat\(\)/.test(HTML));
{ // `#`는 원본 시트 행번호라 무시트 작업보드에 보이면 안 된다. 단, 서버 행 앵커 seq 자체는 전혀 건드리지 않는다.
  const i = HTML.indexOf('function buildGrid(wd)');
  const body = i > 0 ? HTML.slice(i, HTML.indexOf('function _fitGrid()', i)) : '';
  ok('작업보드 고정 신원열에서 #/seq 표시 컬럼을 제거', !!body
    && /const idCols = STATE\.role==='advertiser' \? \[\] : \[\{key:'참여자',kind:'name'\},\{key:'연락처',kind:'phone'\}\]/.test(body)
    && !/key:'#',kind:'seq'/.test(body), body ? '' : 'buildGrid을 찾지 못함');
  ok('표 폭 계산도 # 없이 참여자·연락처만 고정', /const idKeys = STATE\.role==='advertiser' \? \[\] : \['참여자','연락처'\]/.test(HTML));
}

// ── 2. 가짜 DOM 위에서 실제 실행 ────────────────────────────────
function grab(name) {
  const i = HTML.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('함수를 찾지 못함: ' + name);
  let d = 0, started = false;
  for (let j = i; j < HTML.length; j++) {
    const c = HTML[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return HTML.slice(i, j + 1); }
  }
  throw new Error('본문 끝을 찾지 못함: ' + name);
}

// 최소 DOM: classList / getAttribute / closest / cloneNode / children
function mkCell(opts) {
  const cell = {
    tagName: 'TD', _cls: new Set(opts.cls || []), _attr: Object.assign({}, opts.attr || {}), textContent: opts.text != null ? opts.text : '',
    children: [], style: {}, parentRow: null,
    classList: {
      add(...c) { c.forEach(x => cell._cls.add(x)); }, remove(...c) { c.forEach(x => cell._cls.delete(x)); },
      contains(c) { return cell._cls.has(c); },
    },
    getAttribute(k) { return k in cell._attr ? cell._attr[k] : null; },
    setAttribute(k, v) { cell._attr[k] = v; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    cloneNode() { return { querySelectorAll: () => [], textContent: cell.textContent }; },
    closest(sel) {
      if (sel === 'tr' || sel === 'tr.grouphd') return sel === 'tr' ? cell.parentRow : (cell.parentRow && cell.parentRow.classList.contains('grouphd') ? cell.parentRow : null);
      if (sel === 'tbody') return cell.parentRow && cell.parentRow.parentBody;
      return null;
    },
  };
  return cell;
}
function mkRow(cells, grouphd) {
  const set = new Set(grouphd ? ['grouphd'] : []);
  const row = { tagName: 'TR', children: cells, parentBody: null, classList: { contains: c => set.has(c), add: c => set.add(c), remove: c => set.delete(c) } };
  cells.forEach(c => { c.parentRow = row; });
  return row;
}

/* 실측 화면과 같은 모양: [참여자(잠금) · 연락처(잠금) · 주문자제출(편집) · 수취인(편집)]
 * `seq`는 서버 행 앵커로만 남고, 과거 시트 행번호 `#` 열은 작업보드에 표시하지 않는다. */
function buildFakeGrid() {
  const names = ['이진우', '조수빈', '고덕하', '윤지혜'];
  const rows = names.map((nm, i) => mkRow([
    mkCell({ cls: ['gnm', 'gidlock'], text: nm, attr: { 'data-rid': 'r' + i, 'data-cfield': 'idname' } }),
    mkCell({ cls: ['gcell', 'gidlock'], text: '010-1111-000' + i, attr: { 'data-rid': 'r' + i, 'data-cfield': 'idphone' } }),
    mkCell({ cls: ['gcell', 'gedit'], text: nm, attr: { 'data-id': 'r' + i, 'data-field': 'col:주문자제출', 'data-val': nm } }),
    mkCell({ cls: ['gcell', 'gedit'], text: nm, attr: { 'data-id': 'r' + i, 'data-field': 'col:수취인', 'data-val': nm } }),
    mkCell({ cls: ['gcell', 'gedit'], text: '서울 ' + i, attr: { 'data-id': 'r' + i, 'data-field': 'col:주소', 'data-val': '서울 ' + i } }),
    mkCell({ cls: ['gcell', 'gedit'], text: '22,000', attr: { 'data-id': 'r' + i, 'data-field': 'col:결제금액', 'data-val': '22000' } }),
  ]));
  const body = { children: rows, id: 'gbody' };
  const stat = { hidden: true, textContent: '', title: '', removeAttribute(k) { if (k === 'title') this.title = ''; } };
  rows.forEach(r => { r.parentBody = body; });
  return { body, rows, stat };
}

/* 동기로 해소되는 thenable — 붙여넣기가 묶음을 이어 보내는 체인을 그 자리에서 끝까지 태운다
   (실제 Promise 를 쓰면 이 가드의 동기 단언이 완료 처리보다 먼저 실행된다). */
function syncThen(v) {
  return {
    then(f) { const r = f ? f(v) : v; return (r && typeof r.then === 'function') ? r : syncThen(r); },
    catch() { return this; },
  };
}
function makeCtx(fake) {
  const commits = [], toasts = [], batches = [];
  const sandbox = {
    STATE: { canEdit: true, gSelRange: null, cur: { sheetId: 's', tabName: 't' } },
    $: sel => (sel === '#gbody' ? fake.body : (sel === '#gselstat' ? fake.stat : null)),
    document: {
      querySelectorAll(sel) {
        if (!/gselrange|gselanchor/.test(sel)) return [];
        const out = [];
        fake.rows.forEach(r => r.children.forEach(c => { if (c.classList.contains('gselrange') || c.classList.contains('gselanchor')) out.push(c); }));
        return out;
      },
      querySelector() { return null; },
    },
    toast: m => toasts.push(String(m)),
    confirm: () => true,
    commitCellEdit: (rowId, field, val) => commits.push({ rowId, field, val }),
    _beginCellUndoGroup: kind => ({ kind, entries: [], pending: 0 }),
    _finishCellUndoGroup: () => {},
    // ★ 붙여넣기는 왕복 1회(`/workdesk/edit-batch`)로 나간다 — 저장 대상은 그 페이로드에서 센다.
    //   (칸마다 commitCellEdit 을 부르던 옛 경로로 되돌아가면 아래 [3]이 전부 0건이 되어 잡힌다)
    _applyCellLocal: (rowId, field, value, td) => ({ had: false, prev: undefined, rollback() {} }),
    _recordCellUndo: () => {},
    _wtNotice: () => {},
    reloadWorkdesk: () => {},
    setTimeout: () => 0,
    api: (url, opt) => {
      const body = JSON.parse(opt.body);
      batches.push({ url, body });
      (body.edits || []).forEach(e => commits.push({ rowId: e.rowId, field: e.field, val: e.value }));
      // 성공 응답을 동기로 흘려 완료 처리(확정 토스트·되돌리기 기록)까지 실제로 태운다
      const resp = { ok: true, total: (body.edits || []).length, succeeded: (body.edits || []).length, failed: 0,
                     results: (body.edits || []).map((e, i) => ({ index: i, rowId: e.rowId, field: e.field, ok: true })) };
      return syncThen(resp);
    },
    _PASTE_MAX: 500,
    _PASTE_CHUNK: 50,
    Promise: { resolve: v => syncThen(v) },
    console,
  };
  vm.createContext(sandbox);
  ['_selRanges', '_setCellSel', '_updateActiveSel', '_paintSel', '_clearCellSel', '_selAnchorTd', '_selectionGrid', '_cellCopyText', '_selectionTsv', '_selectionStats', '_syncSelectionStat', '_pasteIntoSelection', '_pasteCommitBatch', '_pasteApplyResults'].forEach(n => {
    vm.runInContext(grab(n), sandbox);
  });
  return { sandbox, commits, toasts, batches };
}

console.log('\n[2] 직사각형 선택 · 복사 (세로 드래그 = 그 열만)');
{
  const fake = buildFakeGrid();
  const { sandbox } = makeCtx(fake);
  // 참여자 열(ci=0)을 이진우(0) → 윤지혜(3) 로 세로 드래그
  vm.runInContext('_setCellSel({r0:0,c0:0,r1:3,c1:0})', sandbox);
  const tsv = vm.runInContext('_selectionTsv()', sandbox);
  eq('세로 드래그 = 그 열만 복사', tsv, '이진우\n조수빈\n고덕하\n윤지혜');
  ok('오른쪽 열(수취인·연락처·주소) 미포함', !/010-|\t/.test(tsv));
  const n = vm.runInContext('_selectionGrid().reduce((a,l)=>a+l.length,0)', sandbox);
  eq('선택 칸 수 = 4', n, 4);
}
{
  const fake = buildFakeGrid();
  const { sandbox } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:5,r1:2,c1:5})', sandbox);
  eq('결제금액 선택은 셀 수를 센다', vm.runInContext('_selectionStats().count', sandbox), 3);
  eq('결제금액 선택은 금액을 합산한다', vm.runInContext('_selectionStats().amount', sandbox), 66000);
  eq('결제금액 선택은 상단에 셀 수와 합계금액을 표기한다', fake.stat.textContent, '선택 셀 3개 · 합계금액 66,000원');
  vm.runInContext('_clearCellSel()', sandbox);
  eq('선택 해제 시 상단 선택 요약을 숨긴다', fake.stat.hidden, true);
}
{
  const fake = buildFakeGrid();
  const { sandbox } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:4,r1:2,c1:4})', sandbox);
  eq('결제금액이 아닌 선택은 금액 합계를 만들지 않는다', vm.runInContext('_selectionStats().amount', sandbox), null);
}
{
  const fake = buildFakeGrid();
  const { sandbox } = makeCtx(fake);
  // 역방향(아래→위, 오른쪽→왼쪽) 드래그도 같은 직사각형
  vm.runInContext('_setCellSel({r0:2,c0:3,r1:1,c1:2})', sandbox);
  eq('4방향 자유 드래그 = 같은 직사각형(TSV 2×2)', vm.runInContext('_selectionTsv()', sandbox), '조수빈\t조수빈\n고덕하\t고덕하');
  eq('앵커 = 범위의 왼쪽 위', vm.runInContext('_selAnchorTd().getAttribute("data-field")', sandbox), 'col:주문자제출');
}
{
  const fake = buildFakeGrid();
  fake.rows.splice(2, 0, (() => { const r = mkRow([mkCell({ text: '그룹' })], true); r.parentBody = fake.body; return r; })());
  const { sandbox } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:0,r1:4,c1:0})', sandbox);
  ok('그룹 머리행은 복사에서 제외', !/그룹/.test(vm.runInContext('_selectionTsv()', sandbox)));
}

console.log('\n[3] 붙여넣기 — 편집 가능한 칸에만');
{
  const fake = buildFakeGrid();
  const { sandbox, commits, toasts } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:0,c1:2})', sandbox);
  vm.runInContext('_pasteIntoSelection("가\\t나\\n다\\t라")', sandbox);
  eq('2×2 붙여넣기 = 4칸 저장', commits.length, 4);
  eq('첫 칸은 선택 시작 칸', commits[0].field, 'col:주문자제출');
  eq('오른쪽으로 이어짐', commits[1].field, 'col:수취인');
  eq('아래 행으로 이어짐', commits[2].rowId, 'r1');
  ok('건수를 보고한다', toasts.some(t => /4개 칸 붙여넣음/.test(t)), toasts.join('|'));
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits, toasts } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:0,r1:1,c1:0})', sandbox);   // 참여자(신원 잠금) 열
  vm.runInContext('_pasteIntoSelection("홍길동\\n임꺽정")', sandbox);
  eq('잠긴 신원 칸에는 쓰지 않는다', commits.length, 0);
  ok('잠긴 칸을 조용히 넘기지 않고 말한다', toasts.some(t => /잠긴 칸 2개/.test(t)), toasts.join('|'));
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:2,c1:2})', sandbox);
  vm.runInContext('_pasteIntoSelection("공통값")', sandbox);
  eq('한 칸 복사 → 선택 범위 채우기(엑셀식)', commits.length, 3);
  ok('모두 같은 값', commits.every(c => c.val === '공통값'));
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:0,c1:2})', sandbox);
  vm.runInContext('_pasteIntoSelection("이진우")', sandbox);   // 이미 같은 값
  eq('같은 값은 저장 왕복을 만들지 않는다', commits.length, 0);
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits, toasts } = makeCtx(fake);
  sandbox.STATE.canEdit = false;
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:0,c1:2})', sandbox);
  vm.runInContext('_selectionTsv()', sandbox);
  ok('열람 전용도 복사는 된다(선택은 유효)', vm.runInContext('_selectionTsv()', sandbox) === '이진우');
  eq('열람 전용 계정에는 붙여넣기 이벤트가 애초에 걸리지 않는다(배선)', /if\(!STATE\.canEdit \|\| !STATE\.gSelRange\) return;/.test(HTML), true);
  void commits; void toasts;
}

/* ── 4. Ctrl(⌘) = 떨어진 범위 추가 (사용자 확정 2026-08-10) ──────────────────
   실제 작업: 사이에 낀 id 열을 빼고 **수취인 + 연락처 + 주소** 만 복사한다.
   가짜 표의 열: 0=참여자 · 1=연락처 · 2=주문자제출 · 3=수취인 · 4=주소 */
console.log('\n[4] Ctrl+드래그 = 떨어진 범위 추가');
ok('Ctrl(⌘) 로 선택을 더한다(배선)', /_setCellSel\(drag, ?e\.ctrlKey\|\|e\.metaKey\)/.test(HTML));
ok('드래그 중에는 활성 범위만 갱신(앞서 더한 범위 보존)', /_updateActiveSel\(drag\)/.test(HTML));
{
  const fake = buildFakeGrid();
  const { sandbox } = makeCtx(fake);
  // 일부러 **화면 순서와 반대로** 고른다: 주소(4) → 수취인(3) → 연락처(1)
  vm.runInContext('_setCellSel({r0:0,c0:4,r1:1,c1:4},false)', sandbox);
  vm.runInContext('_setCellSel({r0:0,c0:3,r1:1,c1:3},true)', sandbox);
  vm.runInContext('_setCellSel({r0:0,c0:1,r1:1,c1:1},true)', sandbox);
  eq('범위 3개가 유지된다', vm.runInContext('_selRanges().length', sandbox), 3);
  eq('복사본은 화면 열 순서(연락처→수취인→주소)', vm.runInContext('_selectionTsv()', sandbox),
     '010-1111-0000\t이진우\t서울 0\n010-1111-0001\t조수빈\t서울 1');
  ok('사이에 낀 열(주문자제출)은 포함되지 않는다', !/이진우\t이진우/.test(vm.runInContext('_selectionTsv()', sandbox)));
  eq('선택 칸 수 = 3열 × 2행', vm.runInContext('_selectionGrid().reduce((a,l)=>a+l.length,0)', sandbox), 6);
  eq('칠하기도 합집합', vm.runInContext('document.querySelectorAll(".gselrange").length', sandbox), 6);
}
{
  const fake = buildFakeGrid();
  const { sandbox } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:1,c1:2},false)', sandbox);   // 주문자제출
  vm.runInContext('_setCellSel({r0:0,c0:4,r1:1,c1:4},true)', sandbox);    // 주소
  vm.runInContext('_clearCellSel()', sandbox);
  eq('해제하면 범위 목록도 비운다', vm.runInContext('_selRanges().length', sandbox), 0);
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:1,c1:2},false)', sandbox);   // 주문자제출 2칸
  vm.runInContext('_setCellSel({r0:0,c0:4,r1:1,c1:4},true)', sandbox);    // 주소 2칸
  vm.runInContext('_pasteIntoSelection("가\\t나\\n다\\t라")', sandbox);
  eq('떨어진 범위 붙여넣기 = 선택한 칸에만', commits.length, 4);
  eq('행 안에서는 화면 열 순서대로', commits.map(c => c.field).join(','),
     'col:주문자제출,col:주소,col:주문자제출,col:주소');
  ok('선택 밖으로 넓히지 않는다', commits.every(c => /주문자제출|주소/.test(c.field)));
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:1,c1:3},false)', sandbox);   // 2×2 선택
  vm.runInContext('_pasteIntoSelection("가")', sandbox);                   // 한 칸만 복사 → 채우기
  eq('한 칸 복사 → 여러 범위/칸 채우기', commits.length, 4);
}
{
  const fake = buildFakeGrid();
  const { sandbox, commits } = makeCtx(fake);
  vm.runInContext('_setCellSel({r0:0,c0:2,r1:2,c1:3},false)', sandbox);   // 3행 선택
  vm.runInContext('_pasteIntoSelection("가\\t나")', sandbox);              // 1행짜리 복사본
  eq('복사본에 없는 행은 건드리지 않는다(빈 값으로 지우지 않음)', commits.length, 2);
}

console.log(`\n${fail ? '❌' : '✅'} pass ${pass} · fail ${fail}`);
process.exit(fail ? 1 : 0);
