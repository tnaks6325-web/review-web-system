// 상단 작업바(사이드바 대체) 런타임 실행 가드 — grep이 못 보는 실행경로·스코프를 실제 호출로 검증.
// workdesk.html의 인라인 스크립트에서 대상 함수만 추출해 최소 DOM 스텁 위에서 실행한다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const script = (HTML.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];
assert.ok(script, 'inline script block not found');

// 화면 계약: 작업보드 상단은 시안 1의 연속 필드 구조를 쓰되, 기존 렌더러가 의존하는
// tb0/tb1/tb2 ID는 유지한다. DOM 순서는 업체 → 업체 작업 → 열린 작업이다.
const workdeskView = HTML.slice(HTML.indexOf('function renderWorkdeskView()'), HTML.indexOf('async function loadTabs()'));
assert.match(workdeskView, /class="taskbar wb-topbar" id="taskbar"/, '연속 필드 작업바 클래스 누락');
const companyTier = workdeskView.indexOf('class="tb1 wb-tier wb-company"');
const taskTier = workdeskView.indexOf('class="tb2 wb-tier wb-task"');
const openedTier = workdeskView.indexOf('class="tb0 wb-tier wb-open"');
assert.ok(companyTier >= 0 && taskTier > companyTier && openedTier > taskTier,
  '상단 순서는 업체 → 업체 작업 → 열린 작업이어야 함');
assert.ok(/\.wb-task\{[^}]*gap:3px/.test(HTML)
  && /\.wb-open\{[^}]*gap:3px/.test(HTML)
  && /\.segwrap\{gap:3px/.test(HTML),
  '세 상단 탭 그룹 간격은 3px이어야 함');

// ── 최소 DOM 스텁 ──────────────────────────────────────────────
function mkEl(id) {
  const el = {
    id, innerHTML: '', className: '', dataset: {}, value: '', scrollLeft: 0, scrolledIntoView: 0,
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                 toggle(c,on){ on ? this._s.add(c) : this._s.delete(c); }, contains(c){return this._s.has(c);} },
    setAttribute(){}, scrollIntoView(){ el.scrolledIntoView++; },
    // 활성 항목 자동 스크롤 검증용: innerHTML 안에 해당 클래스가 있으면 스크롤 가능한 엘리먼트를 돌려준다
    querySelector(sel){
      const cls = String(sel).replace(/^\./, '').replace(/\./g, ' ');
      return el.innerHTML.includes('class="' + cls + '"') ? { scrollIntoView(){ el.scrolledIntoView++; } } : null;
    },
  };
  return el;
}
const els = {};
const $ = sel => { const id = String(sel).replace(/^#/, ''); return els[id] || null; };

const WHEEL = {};   // _bindWheelScroll 대상 스텁(핸들러를 붙잡아 직접 호출)
function mkScroller(){
  return { scrollLeft:0, scrollWidth:1000, clientWidth:400, _h:null,
    addEventListener(type, fn, opt){ if(type==='wheel'){ this._h=fn; this._opt=opt; } } };
}
const document = {
  body: mkEl('body'),
  addEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];},
  createElement: () => mkEl('x'),
  getElementById: id => (WHEEL[id] || els[id] || null),
};
const localStorage = { _m:{}, getItem(k){return this._m[k]==null?null:this._m[k];}, setItem(k,v){this._m[k]=String(v);} };
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// 즐겨찾기 세그먼트 센티널은 구현에서 그대로 읽어온다(테스트가 값을 하드코딩하면 구현과 어긋나도 통과함)
const W_FAV_SRC = (script.match(/const W_FAV='([^']*)';/) || [])[1];
assert.ok(W_FAV_SRC != null, 'W_FAV 선언을 찾지 못함');
const W_FAV = W_FAV_SRC.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
assert.ok(!/^[\w가-힣]/.test(W_FAV), 'W_FAV가 평범한 문자로 시작하면 업체명과 충돌 가능');

// 검증 대상 함수만 추출(선언 그대로 평가 → 스코프·오타·미정의 참조를 실제로 잡음)
// ★ isFinished 는 스텁이 아니라 **구현을 그대로 추출**한다 — 작업보드가 "진행 중만" 보여주는 규칙(088)이
//   이 파일의 그룹핑 검증과 같은 코드로 확인되게(스텁을 두면 구현이 바뀌어도 테스트가 통과한다).
// ★ 작업바 정렬(모집중 먼저, 2026-08-10)로 _wGroups/_renderTabList 이 갖게 된 의존 —
//   구현이 아니라 **실제 함수**를 함께 뜯어 온다(스텁을 두면 정렬 규칙이 여기서만 딴판이 된다).
const WANT = ['_wGroups','_wUnseen','_wActiveSeg','_renderTabList','wPickSeg','wSearch','wPickSearch','_wKbPaint','isFav','_favKey','selTab','isAdvFav','_advFavKey','toggleAdvFav','_curSheetLabel','_bindWheelScroll','isFinished','_campRank','_wRecruiting','_wTabRecruiting','_wTabPending','_wTabRank','_wSegTip'];
const bodies = WANT.map(name => {
  const re = new RegExp('\\n(?:async )?function ' + name.replace(/[$]/g,'\\$') + '\\s*\\(', 'g');
  const m = re.exec(script);
  assert.ok(m, 'function not found in workdesk.html: ' + name);
  // 중괄호 균형으로 함수 본문 끝을 찾는다(문자열/템플릿리터럴 내부 중괄호 무시)
  let i = script.indexOf('{', m.index + m[0].length - 1), depth = 0, q = null, start = i;
  for (; i < script.length; i++) {
    const c = script[i], p = script[i-1];
    if (q) { if (c === q && p !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return script.slice(m.index + 1, i + 1);
}).join('\n');

let STATE = { tabs: [], favs: new Set(), _favLoaded: true, unseen: {}, cur: null, wSeg: null, wRes: [], wKb: -1 };
let opened = [];                       // selTab이 실제로 연 탭(본문 로드 요청)
function refreshUnseen() { /* no-op: 순수 렌더 검증 */ }
function _favLoad(){ return new Set(); }
// selTab이 부르는 주변 함수 스텁 — 본문 로드는 관심 밖, 상단바 상태 전이만 본다
const api = async () => ({ ok: true });
const renderWorkdesk = wd => { opened.push(STATE.cur && STATE.cur.tabName); };
const loadParity = () => {};
const closeGColMenu = () => {}, closeGHidMenu = () => {};
// SPA 히스토리(#447)로 selTab 이 갖게 된 의존 — 스텁을 안 주면 ReferenceError 로 selTab 이
// 조용히 죽어(async 라 rejection 이 삼켜짐) 아래 상태 전이 단언이 "예전 값 그대로"로 실패한다.
// ★ selTab/switchView 가 새 전역을 부르게 되면 이 목록도 함께 늘릴 것.
let navPushed = 0;
const _navPush = () => { navPushed++; };
// 열린 작업 줄(0단, migration 089)로 selTab 이 갖게 된 의존 — 이 파일의 관심은 1·2단 상태 전이라
//   스텁으로 둔다(줄 자체의 동작은 workboardWorktabs 가드 + 실브라우저 검증이 담당).
let wtOpened = [];
const _wtOpen = t => { wtOpened.push(t && t.tabName); };
const sheetTitle = sid => (({ S1:'로스터A', S2:'로스터B', S3:'로스터C' })[sid] || sid);

// eslint-disable-next-line no-new-func
const load = new Function('STATE','$','esc','document','localStorage','refreshUnseen','_favLoad','W_FAV',
  'api','renderWorkdesk','loadParity','closeGColMenu','closeGHidMenu','sheetTitle','_favSaveLocal','_favPushServer','_navPush','_wtOpen',
  bodies + '\n return {' + WANT.join(',') + '};');
const F = load(STATE, $, esc, document, localStorage, refreshUnseen, _favLoad, W_FAV,
  api, renderWorkdesk, loadParity, closeGColMenu, closeGHidMenu, sheetTitle, ()=>{}, ()=>{}, _navPush, _wtOpen);
// wPickSearch/selTab 은 서로를 호출하므로 추출본끼리 연결(전역 선언과 동일한 관계 재현)
const selTab = F.selTab;

// ── 픽스처 ────────────────────────────────────────────────────
function reset() {
  els.segwrap = mkEl('segwrap'); els.tb2 = mkEl('tb2'); els.sres = mkEl('sres'); els.wq = mkEl('wq');
  els.main = mkEl('main');   // selTab 이 본문 자리표시자를 쓰므로 필요
  STATE.tabs = [
    { sheetId:'S1', tabName:'탐사수 500ml 100건', tabGid:'1', spreadsheetTitle:'로스터A', advertiserName:'우리회사' },
    { sheetId:'S1', tabName:'탐사수 2L 50건',     tabGid:'2', spreadsheetTitle:'로스터A', advertiserName:'우리회사' },
    { sheetId:'S2', tabName:'물티슈 80건',        tabGid:'3', spreadsheetTitle:'로스터B', advertiserName:'리뷰천국' },
    { sheetId:'S3', tabName:'미지정 작업',        tabGid:'4', spreadsheetTitle:'로스터C', advertiserName:'' },
  ];
  STATE.favs = new Set(); STATE.cur = null; STATE.wSeg = null; STATE.unseen = {}; STATE.wRes = []; STATE.wKb = -1;
  STATE._wLastSel = null;
  opened = [];
}

let pass = 0;
const t = (name, fn) => { fn(); console.log('  ok   ' + name); pass++; };

// 1) 그룹 구성: 업체별 + 미지정 마지막, 즐겨찾기 그룹은 fav가 있을 때만 맨 앞
t('1. _wGroups: 업체 정렬 + 미지정 마지막, fav 없으면 fav 그룹 없음', () => {
  reset();
  const gs = F._wGroups();
  assert.deepStrictEqual(gs.map(g => g.key), ['리뷰천국','우리회사','']);
  assert.strictEqual(gs[gs.length-1].label, '미지정');
});

// ★ 마감(전사 공통, migration 088) — "작업보드에는 진행 중만". 인덱스는 원본을 유지해야 selTab(i) 계약이 안 깨진다.
t('1b. _wGroups: 마감 작업은 상단 작업바에서 빠지고, 남은 탭의 인덱스는 원본 그대로', () => {
  reset();
  STATE.tabs[0].finished = true;                       // 우리회사 탭 하나를 마감
  const gs = F._wGroups();
  const woori = gs.find(g => g.key === '우리회사');
  assert.deepStrictEqual(woori.idxs, [1], '마감 탭(0)은 빠지고 남은 탭의 STATE.tabs 인덱스(1)는 보존');
  assert.ok(!gs.some(g => g.idxs.includes(0)), '마감 탭이 어느 그룹에도 없어야');
});
t('1c. _wGroups: 업체의 탭이 전부 마감이면 그 업체 칩 자체가 사라진다', () => {
  reset();
  STATE.tabs[2].finished = true;                       // 리뷰천국은 탭이 하나뿐
  assert.ok(!F._wGroups().some(g => g.key === '리뷰천국'));
});
t('1d. _wGroups: 마감 탭은 즐겨찾기여도 작업바에 남지 않는다(즐겨찾기가 마감을 이기지 않는다)', () => {
  reset();
  STATE.tabs[2].finished = true;
  STATE.favs = new Set([F._favKey(STATE.tabs[2])]);
  const gs = F._wGroups();
  assert.ok(!gs.some(g => g.idxs.includes(2)), '마감 탭이 즐겨찾기 그룹으로 되살아나면 안 됨');
});

t('2. _wGroups: 즐겨찾기는 맨 앞 + 원 업체 그룹에도 그대로 남음(중복 제거 안 함)', () => {
  reset();
  STATE.favs = new Set([F._favKey(STATE.tabs[0])]);
  const gs = F._wGroups();
  assert.strictEqual(gs[0].key, W_FAV);
  assert.deepStrictEqual(gs[0].idxs, [0]);
  const own = gs.find(g => g.key === '우리회사');
  assert.ok(own.idxs.includes(0), '즐겨찾기 탭이 원 업체 그룹에서 사라지면 안 됨');
});

// 2) 활성 세그먼트 결정
t('3. _wActiveSeg: 선택 없으면 첫 그룹', () => {
  reset();
  assert.strictEqual(F._wActiveSeg(F._wGroups()), '리뷰천국');
});

t('4. _wActiveSeg: 현재 열린 탭이 속한 업체 그룹을 따라감(fav 그룹으로 새지 않음)', () => {
  reset();
  STATE.favs = new Set([F._favKey(STATE.tabs[0])]);
  STATE.cur = STATE.tabs[0];
  assert.strictEqual(F._wActiveSeg(F._wGroups()), '우리회사');
});

t('5. _wActiveSeg: 사용자가 고른 세그먼트가 사라지면 유효한 값으로 폴백(빈 화면 방지)', () => {
  reset();
  STATE.wSeg = W_FAV;                      // 즐겨찾기 보던 중
  const gs = F._wGroups();                  // 즐겨찾기 0개 → fav 그룹 없음
  const seg = F._wActiveSeg(gs);
  assert.ok(gs.some(g => g.key === seg), '존재하지 않는 세그먼트를 반환하면 2단이 영구 빈칸이 됨');
});

t('6. _wActiveSeg: 탭 목록이 비면 null (크래시 없음)', () => {
  reset(); STATE.tabs = [];
  assert.strictEqual(F._wActiveSeg(F._wGroups()), null);
});

// 3) 렌더: 인덱스 계약 + 활성 표시 + 이스케이프
t('7. _renderTabList: 2단 탭의 data-i가 STATE.tabs 원본 인덱스(selTab 계약)', () => {
  reset();
  STATE.wSeg = '우리회사';
  F._renderTabList();
  const idxs = [...els.tb2.innerHTML.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.deepStrictEqual(idxs, [0,1]);
  assert.ok(/onclick="selTab\(0\)"/.test(els.tb2.innerHTML));
});

t('8. _renderTabList: 현재 탭만 .on (활성 1개)', () => {
  reset();
  STATE.wSeg = '우리회사'; STATE.cur = STATE.tabs[1];
  F._renderTabList();
  assert.strictEqual((els.tb2.innerHTML.match(/class="wtab on"/g) || []).length, 1);
});

t('9. _renderTabList: 미확인 배지 = 탭별 표시 + 세그먼트 그룹 합계', () => {
  reset();
  STATE.unseen = { 'S1\t탐사수 500ml 100건': 2, 'S1\t탐사수 2L 50건': 3 };
  STATE.wSeg = '우리회사';
  F._renderTabList();
  assert.ok(/💬 2/.test(els.tb2.innerHTML), '탭 배지 누락');
  assert.ok(/💬5/.test(els.segwrap.innerHTML), '세그먼트 합계(2+3=5) 누락');
});

t('10. _renderTabList: 업체명/탭명 XSS 이스케이프 + data-k 따옴표 안전', () => {
  reset();
  STATE.tabs = [{ sheetId:'X', tabName:'<img src=x onerror=alert(1)>', tabGid:'9',
                  spreadsheetTitle:'t', advertiserName:'A"B&C<script>' }];
  STATE.wSeg = null;
  F._renderTabList();
  assert.ok(!/<img src=x/.test(els.tb2.innerHTML), '탭명 미이스케이프 → XSS');
  assert.ok(!/<script>/.test(els.segwrap.innerHTML), '업체명 미이스케이프 → XSS');
  assert.ok(/data-k="A&quot;B&amp;C/.test(els.segwrap.innerHTML), 'data-k 따옴표/앰퍼샌드 이스케이프 실패');
  assert.ok(/onclick="wPickSeg\(this\.dataset\.k\)"/.test(els.segwrap.innerHTML), '핸들러는 dataset 경유여야 안전');
});

t('11. _renderTabList: 탭 0개 / 호스트 부재 시 크래시 없음', () => {
  reset(); STATE.tabs = [];
  F._renderTabList();
  assert.ok(/활성 작업 없음/.test(els.tb2.innerHTML));
  els.segwrap = null; els.tb2 = null;      // 작업보드 뷰가 아닐 때
  F._renderTabList();                       // throw 하면 실패
});

// 4) 통합검색
t('12. wSearch: 탭명·업체명·시트제목 교차 검색 + 결과 인덱스가 원본 인덱스', () => {
  reset();
  F.wSearch('물티슈');
  assert.deepStrictEqual(STATE.wRes, [2]);
  assert.ok(/onclick="wPickSearch\(2\)"/.test(els.sres.innerHTML));
  F.wSearch('로스터A');                     // 시트제목으로도 검색
  assert.deepStrictEqual(STATE.wRes, [0,1]);
  F.wSearch('리뷰천국');                     // 업체명으로도 검색
  assert.deepStrictEqual(STATE.wRes, [2]);
});

t('13. wSearch: 빈 입력이면 패널 닫고 결과 초기화', () => {
  reset();
  F.wSearch('물'); assert.ok(els.sres.classList.contains('show'));
  F.wSearch('   '); assert.ok(!els.sres.classList.contains('show'));
  assert.deepStrictEqual(STATE.wRes, []);
});

t('14. wSearch: 하이라이트가 HTML 주입 통로가 되지 않음', () => {
  reset();
  STATE.tabs = [{ sheetId:'X', tabName:'<b>bold</b> 물티슈', tabGid:'9', spreadsheetTitle:'t', advertiserName:'a' }];
  F.wSearch('물티슈');
  assert.ok(!/<b>bold<\/b>/.test(els.sres.innerHTML), '검색 하이라이트 경유 XSS');
  assert.ok(/<mark>물티슈<\/mark>/.test(els.sres.innerHTML), '매칭 하이라이트 누락');
});

t('15. wSearch: 결과 없음 안내(원문 이스케이프)', () => {
  reset();
  F.wSearch('<zzz>');
  assert.ok(/검색 결과 없음/.test(els.sres.innerHTML));
  assert.ok(!/<zzz>/.test(els.sres.innerHTML));
});

// 5) 선택 경로
t('16. wPickSearch: 그 탭의 업체 세그먼트로 이동 + selTab(원본 인덱스) 호출 + 입력 초기화', () => {
  reset();
  F.wSearch('물티슈');
  F.wPickSearch(2);
  assert.strictEqual(STATE.wSeg, '리뷰천국');
  assert.strictEqual(STATE.cur.tabName, '물티슈 80건');
  assert.strictEqual(els.wq.value, '');
  assert.ok(!els.sres.classList.contains('show'));
});

t('17. wPickSearch: 즐겨찾기 세그먼트를 보던 중 즐겨찾기 탭 선택 시 fav 유지', () => {
  reset();
  STATE.favs = new Set([F._favKey(STATE.tabs[0])]);
  STATE.wSeg = W_FAV;
  F.wPickSearch(0);
  assert.strictEqual(STATE.wSeg, W_FAV, '보던 즐겨찾기 그룹이 튕기면 맥락 상실');
  assert.strictEqual(STATE.cur.tabName, '탐사수 500ml 100건');
});

t('18. wPickSearch: 잘못된 인덱스는 무시(크래시·오선택 없음)', () => {
  reset();
  F.wPickSearch(999);
  assert.strictEqual(STATE.cur, null);
});

t('19. wPickSeg: 세그먼트 전환이 STATE.wSeg에 반영되고 2단이 그 그룹으로 다시 그려짐', () => {
  reset();
  F.wPickSeg('리뷰천국');
  assert.strictEqual(STATE.wSeg, '리뷰천국');
  const idxs = [...els.tb2.innerHTML.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.deepStrictEqual(idxs, [2]);
});

// ── 6) 코드리뷰 지적 반영분 회귀가드 ────────────────────────────
t('20. selTab: 다른 세그먼트의 탭을 열면 활성 세그먼트가 그 업체로 따라온다', () => {
  reset();
  // 관측/업체관리에서 넘어온 상황 재현: 목록 렌더가 먼저 wSeg 를 첫 그룹(리뷰천국)에 고정
  F._renderTabList();
  assert.strictEqual(STATE.wSeg, '리뷰천국');
  selTab(0);                                   // '우리회사' 소속 탭을 연다
  assert.strictEqual(STATE.wSeg, '우리회사', '세그먼트가 안 따라오면 2단에 활성표시가 사라진다');
  assert.ok(/class="wtab on"/.test(els.tb2.innerHTML), '연 탭이 2단에서 활성으로 보여야 함');
  const idxs = [...els.tb2.innerHTML.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.ok(idxs.includes(0), '연 탭이 2단 목록에 없음');
});

t('21. selTab: 즐겨찾기 그룹에 있는 탭이면 즐겨찾기 세그먼트를 유지(맥락 보존)', () => {
  reset();
  STATE.favs = new Set([F._favKey(STATE.tabs[0])]);
  STATE.wSeg = W_FAV;
  selTab(0);
  assert.strictEqual(STATE.wSeg, W_FAV, '즐겨찾기로 보던 탭인데 업체 그룹으로 튕기면 안 됨');
});

t('22. selTab: 잘못된 인덱스는 조용히 무시(크래시·상태오염 없음)', () => {
  reset();
  selTab(999);
  assert.strictEqual(STATE.cur, null);
});

t('23. 가로 스크롤 위치가 재렌더로 0으로 되감기지 않는다', () => {
  reset();
  STATE.wSeg = '우리회사'; STATE.cur = STATE.tabs[0];
  F._renderTabList();
  els.segwrap.scrollLeft = 420; els.tb2.scrollLeft = 260;   // 사용자가 오른쪽으로 밀어둔 상태
  F._renderTabList();                                        // 배지 도착 등으로 재렌더
  assert.strictEqual(els.segwrap.scrollLeft, 420, '세그먼트 줄이 맨 왼쪽으로 튕김');
  assert.strictEqual(els.tb2.scrollLeft, 260, '탭 줄이 맨 왼쪽으로 튕김');
});

t('24. 선택이 바뀐 경우에만 활성 항목을 시야로 스크롤(사용자 스크롤과 안 싸움)', () => {
  reset();
  STATE.wSeg = '우리회사'; STATE.cur = STATE.tabs[0];
  F._renderTabList();                       // 최초 = 선택 변경으로 간주
  const first = els.tb2.scrolledIntoView;
  assert.ok(first > 0, '활성 탭을 시야로 끌어와야 함');
  F._renderTabList();                       // 같은 선택으로 재렌더
  assert.strictEqual(els.tb2.scrolledIntoView, first, '선택이 그대로면 스크롤을 건드리지 않아야 함');
  STATE.cur = STATE.tabs[1];
  F._renderTabList();                       // 선택 변경
  assert.ok(els.tb2.scrolledIntoView > first, '선택이 바뀌면 다시 시야로');
});

t('25. 즐겨찾기 센티널이 "fav"라는 이름의 업체와 충돌하지 않는다', () => {
  reset();
  STATE.tabs = [
    { sheetId:'A', tabName:'가', tabGid:'1', spreadsheetTitle:'s', advertiserName:'fav' },
    { sheetId:'B', tabName:'나', tabGid:'2', spreadsheetTitle:'s', advertiserName:'다른업체' },
  ];
  STATE.favs = new Set([F._favKey(STATE.tabs[1])]);   // '다른업체' 탭을 즐겨찾기
  const gs = F._wGroups();
  assert.strictEqual(new Set(gs.map(g => g.key)).size, gs.length, '그룹 키가 중복되면 칩 두 개가 동시에 활성화됨');
  STATE.wSeg = W_FAV;
  F._renderTabList();
  assert.strictEqual((els.segwrap.innerHTML.match(/class="seg[^"]*\bon\b[^"]*"/g) || []).length, 1,
    '활성 칩은 항상 하나여야 함');
  const idxs = [...els.tb2.innerHTML.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.deepStrictEqual(idxs, [1], "즐겨찾기 세그먼트가 'fav' 업체 목록을 보여주면 안 됨");
});

t('26. 2단 탭에는 시트제목을 붙이지 않는다(줄 길이 절약) — 툴팁·본문 헤더로만 확인', () => {
  reset();
  STATE.unseen = { 'S1\t탐사수 500ml 100건': 3 };
  STATE.wSeg = '우리회사';
  F._renderTabList();
  assert.ok(/💬 3/.test(els.tb2.innerHTML), '배지 누락');
  assert.ok(!/class="ts"/.test(els.tb2.innerHTML), '탭마다 시트제목이 붙으면 탭 몇 개만 보인다');
  assert.ok(/title="탐사수 500ml 100건 · 로스터A"/.test(els.tb2.innerHTML), '툴팁에서는 확인 가능해야 함');
});

t('27. 탭 라벨 전체값이 title 툴팁으로 보존된다(축약돼도 확인 가능)', () => {
  reset();
  STATE.wSeg = '우리회사';
  F._renderTabList();
  assert.ok(/title="탐사수 500ml 100건 · 로스터A"/.test(els.tb2.innerHTML), 'title 툴팁 누락');
});

t('28. 검색 하이라이트 구간 길이는 소문자화 기준(ql)이라 대소문자 혼용에서 안 밀린다', () => {
  reset();
  STATE.tabs = [{ sheetId:'X', tabName:'ABC물티슈DEF', tabGid:'1', spreadsheetTitle:'s', advertiserName:'a' }];
  F.wSearch('abc');
  assert.ok(/<mark>ABC<\/mark>/.test(els.sres.innerHTML), '매칭 구간이 어긋남: ' + els.sres.innerHTML);
});

// ── 7) 1단 업체 즐겨찾기(왼쪽 우선 정렬) ──────────────────────
t('29. 업체 즐겨찾기: 즐겨찾기한 업체가 왼쪽 우선(미지정은 그래도 마지막)', () => {
  reset();
  assert.deepStrictEqual(F._wGroups().map(g => g.key), ['리뷰천국','우리회사',''], '기본은 가나다순');
  STATE.favs = new Set([F._advFavKey('우리회사')]);
  assert.deepStrictEqual(F._wGroups().map(g => g.key), ['우리회사','리뷰천국',''],
    '즐겨찾기 업체가 앞으로 안 옴');
});

t('30. 업체 즐겨찾기 키는 탭 즐겨찾기 키와 겹치지 않는다(서로 오염 없음)', () => {
  reset();
  STATE.favs = new Set([F._advFavKey('우리회사')]);
  assert.ok(F.isAdvFav('우리회사'));
  assert.ok(!F.isFav(STATE.tabs[0]), '업체 즐겨찾기가 탭 즐겨찾기로 잘못 인식됨');
  const gs = F._wGroups();
  assert.ok(!gs.some(g => g.key === W_FAV), '업체 즐겨찾기만 했는데 ★탭 그룹이 생기면 안 됨');
});

t('31. toggleAdvFav: 토글 + 세그먼트 클릭으로 전파되지 않음(별 눌렀는데 이동 방지)', () => {
  reset();
  let stopped = 0;
  const ev = { stopPropagation(){ stopped++; } };
  const star = { closest: () => ({ dataset: { k: '우리회사' } }) };
  F.toggleAdvFav(ev, star);
  assert.strictEqual(stopped, 1, 'stopPropagation 누락 → 별 클릭이 세그먼트 전환을 유발');
  assert.ok(F.isAdvFav('우리회사'), '추가 안 됨');
  F.toggleAdvFav(ev, star);
  assert.ok(!F.isAdvFav('우리회사'), '해제 안 됨');
});

t('32. toggleAdvFav: 미지정·즐겨찾기 그룹·엘리먼트 없음은 무시(원장 오염 방지)', () => {
  reset();
  const ev = { stopPropagation(){} };
  F.toggleAdvFav(ev, { closest: () => ({ dataset: { k: '' } }) });        // 미지정
  F.toggleAdvFav(ev, { closest: () => ({ dataset: { k: W_FAV } }) });     // ★즐겨찾기 그룹
  F.toggleAdvFav(ev, { closest: () => null });                            // 칩 밖
  F.toggleAdvFav(ev, null);
  assert.strictEqual(STATE.favs.size, 0, '대상이 아닌 칩에서 즐겨찾기가 저장됨');
});

t('33. 1단 렌더: 업체 칩에만 별표(미지정·★즐겨찾기 그룹엔 없음) + 활성 표시', () => {
  reset();
  STATE.favs = new Set([F._advFavKey('우리회사'), F._favKey(STATE.tabs[2])]);
  STATE.wSeg = '우리회사';
  F._renderTabList();
  const html = els.segwrap.innerHTML;
  const chips = html.split('<div class="seg').slice(1);
  const favChip = chips.find(c => c.includes('favseg'));
  const unassigned = chips.find(c => c.includes('>미지정<'));
  assert.ok(favChip && !favChip.includes('segstar'), '★즐겨찾기 그룹에 업체 별표가 붙음');
  assert.ok(unassigned && !unassigned.includes('segstar'), '미지정에 업체 별표가 붙음');
  assert.ok(/class="segstar on"/.test(html), '즐겨찾기한 업체 별표가 활성으로 안 그려짐');
  assert.ok(/class="seg advfav/.test(html), '즐겨찾기 업체 칩 강조 클래스 누락');
});

// ── 8) 선택 작업의 소속 시트 표기 ─────────────────────────────
t('34. _curSheetLabel: 선택 작업의 시트제목을 본문 헤더용으로 반환', () => {
  reset();
  STATE.cur = STATE.tabs[0];
  const out = F._curSheetLabel();
  assert.ok(/로스터A/.test(out), '시트제목 누락: ' + out);
  assert.ok(/mhsheet/.test(out));
});

t('35. _curSheetLabel: 제목이 없으면 sheetMap 폴백, 그래도 모르면 표기 생략', () => {
  reset();
  STATE.cur = { sheetId:'S2', tabName:'물티슈 80건' };            // spreadsheetTitle 없음
  assert.ok(/로스터B/.test(F._curSheetLabel()), 'sheetMap 폴백 실패');
  STATE.cur = { sheetId:'UNKNOWN', tabName:'x' };                  // 제목 모름 → 시트ID뿐
  assert.strictEqual(F._curSheetLabel(), '', '의미 없는 시트ID를 그대로 노출하면 안 됨');
  STATE.cur = null;
  assert.strictEqual(F._curSheetLabel(), '');
});

t('36. _curSheetLabel: 시트제목 XSS 이스케이프', () => {
  reset();
  STATE.cur = { sheetId:'X', tabName:'t', spreadsheetTitle:'<img src=x onerror=alert(1)>' };
  assert.ok(!/<img/.test(F._curSheetLabel()), 'XSS 통로');
});

// ── 9) 휠 → 좌우 스크롤 ───────────────────────────────────────
function wheelSetup(){
  WHEEL.segwrap = mkScroller(); WHEEL.tb2 = mkScroller();
  F._bindWheelScroll();
  return WHEEL.segwrap;
}
function fire(el, patch){
  let prevented = 0;
  el._h(Object.assign({ deltaY:0, deltaX:0, deltaMode:0, ctrlKey:false,
    preventDefault(){ prevented++; } }, patch));
  return prevented;
}

t('37. 휠: 1·2단 모두에 바인딩되고 passive:false(preventDefault 가능)', () => {
  wheelSetup();
  assert.ok(typeof WHEEL.segwrap._h === 'function', '1단 미바인딩');
  assert.ok(typeof WHEEL.tb2._h === 'function', '2단 미바인딩');
  assert.strictEqual(WHEEL.segwrap._opt && WHEEL.segwrap._opt.passive, false,
    'passive:true면 preventDefault가 무시돼 페이지가 같이 스크롤된다');
});

t('38. 휠 아래 → 오른쪽, 위 → 왼쪽 이동', () => {
  const el = wheelSetup();
  el.scrollLeft = 200;
  assert.strictEqual(fire(el, { deltaY: 100 }), 1, '기본동작을 막아야 페이지가 안 밀림');
  assert.strictEqual(el.scrollLeft, 300, '아래로 굴리면 오른쪽으로 가야 함');
  assert.strictEqual(fire(el, { deltaY: -100 }), 1);
  assert.strictEqual(el.scrollLeft, 200, '위로 굴리면 왼쪽으로 가야 함');
});

t('39. 휠: 양 끝에서는 가로 이동을 멈추고 페이지 스크롤에 양보(가둠 방지)', () => {
  const el = wheelSetup();
  el.scrollLeft = 600;                       // scrollWidth 1000 - clientWidth 400 = 최대 600
  assert.strictEqual(fire(el, { deltaY: 100 }), 0, '오른쪽 끝인데 기본동작을 막으면 페이지가 안 내려감');
  el.scrollLeft = 0;
  assert.strictEqual(fire(el, { deltaY: -100 }), 0, '왼쪽 끝인데 기본동작을 막으면 페이지가 안 올라감');
});

t('40. 휠: 넘칠 게 없으면 양보 · ctrl(확대) · 트랙패드 가로 제스처는 네이티브', () => {
  const el = wheelSetup();
  el.scrollWidth = 400;                      // clientWidth와 같음 → 스크롤 불가
  assert.strictEqual(fire(el, { deltaY: 100 }), 0);
  el.scrollWidth = 1000;
  assert.strictEqual(fire(el, { deltaY: 100, ctrlKey: true }), 0, '확대/축소를 가로채면 안 됨');
  assert.strictEqual(fire(el, { deltaY: 10, deltaX: 100 }), 0, '트랙패드 가로 스크롤은 네이티브에 맡김');
});

t('41. 휠: 줄/페이지 단위(deltaMode)도 보정해 이동량이 0이 되지 않음', () => {
  const el = wheelSetup();
  el.scrollLeft = 0;
  fire(el, { deltaY: 3, deltaMode: 1 });     // 줄 단위
  assert.ok(el.scrollLeft > 0, 'deltaMode=1(줄)에서 안 움직임');
});

t('42. 휠: 같은 엘리먼트에 중복 바인딩하지 않는다(재렌더 시 이동량 배가 방지)', () => {
  const el = wheelSetup();
  const first = el._h;
  F._bindWheelScroll();                      // 다시 호출
  assert.strictEqual(el._h, first, '핸들러가 덧붙으면 한 번 굴릴 때 두 배로 움직인다');
});

console.log('\n' + pass + ' runtime checks passed');
