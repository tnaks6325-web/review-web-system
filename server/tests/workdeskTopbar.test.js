// 상단 작업바(사이드바 대체) 런타임 실행 가드 — grep이 못 보는 실행경로·스코프를 실제 호출로 검증.
// workdesk.html의 인라인 스크립트에서 대상 함수만 추출해 최소 DOM 스텁 위에서 실행한다.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const script = (HTML.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];
assert.ok(script, 'inline script block not found');

// ── 최소 DOM 스텁 ──────────────────────────────────────────────
function mkEl(id) {
  return {
    id, innerHTML: '', className: '', dataset: {}, value: '',
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                 toggle(c,on){ on ? this._s.add(c) : this._s.delete(c); }, contains(c){return this._s.has(c);} },
    setAttribute(){}, querySelector(){return null;}, scrollIntoView(){},
  };
}
const els = {};
const $ = sel => { const id = String(sel).replace(/^#/, ''); return els[id] || null; };

const document = {
  body: mkEl('body'),
  addEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];},
  createElement: () => mkEl('x'),
};
const localStorage = { _m:{}, getItem(k){return this._m[k]==null?null:this._m[k];}, setItem(k,v){this._m[k]=String(v);} };
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// 검증 대상 함수만 추출(선언 그대로 평가 → 스코프·오타·미정의 참조를 실제로 잡음)
const WANT = ['_wGroups','_wUnseen','_wActiveSeg','_renderTabList','wPickSeg','wSearch','wPickSearch','_wKbPaint','isFav','_favKey'];
const bodies = WANT.map(name => {
  const re = new RegExp('\\nfunction ' + name.replace(/[$]/g,'\\$') + '\\s*\\(', 'g');
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
let selected = [];
function selTab(i) { selected.push(i); STATE.cur = STATE.tabs[i]; }
function refreshUnseen() { /* no-op: 순수 렌더 검증 */ }
function _favLoad(){ return new Set(); }

// eslint-disable-next-line no-new-func
const load = new Function('STATE','$','esc','document','localStorage','selTab','refreshUnseen','_favLoad',
  bodies + '\n return {' + WANT.join(',') + '};');
const F = load(STATE, $, esc, document, localStorage, selTab, refreshUnseen, _favLoad);

// ── 픽스처 ────────────────────────────────────────────────────
function reset() {
  els.segwrap = mkEl('segwrap'); els.tb2 = mkEl('tb2'); els.sres = mkEl('sres'); els.wq = mkEl('wq');
  STATE.tabs = [
    { sheetId:'S1', tabName:'탐사수 500ml 100건', tabGid:'1', spreadsheetTitle:'로스터A', advertiserName:'우리회사' },
    { sheetId:'S1', tabName:'탐사수 2L 50건',     tabGid:'2', spreadsheetTitle:'로스터A', advertiserName:'우리회사' },
    { sheetId:'S2', tabName:'물티슈 80건',        tabGid:'3', spreadsheetTitle:'로스터B', advertiserName:'리뷰천국' },
    { sheetId:'S3', tabName:'미지정 작업',        tabGid:'4', spreadsheetTitle:'로스터C', advertiserName:'' },
  ];
  STATE.favs = new Set(); STATE.cur = null; STATE.wSeg = null; STATE.unseen = {}; STATE.wRes = []; STATE.wKb = -1;
  selected = [];
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

t('2. _wGroups: 즐겨찾기는 맨 앞 + 원 업체 그룹에도 그대로 남음(중복 제거 안 함)', () => {
  reset();
  STATE.favs = new Set([F._favKey(STATE.tabs[0])]);
  const gs = F._wGroups();
  assert.strictEqual(gs[0].key, 'fav');
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
  STATE.wSeg = 'fav';                       // 즐겨찾기 보던 중
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
  els.segwrap = null; els.tb2 = null;      // 작업대 뷰가 아닐 때
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
  assert.deepStrictEqual(selected, [2]);
  assert.strictEqual(els.wq.value, '');
  assert.ok(!els.sres.classList.contains('show'));
});

t('17. wPickSearch: 즐겨찾기 세그먼트를 보던 중 즐겨찾기 탭 선택 시 fav 유지', () => {
  reset();
  STATE.favs = new Set([F._favKey(STATE.tabs[0])]);
  STATE.wSeg = 'fav';
  F.wPickSearch(0);
  assert.strictEqual(STATE.wSeg, 'fav', '보던 즐겨찾기 그룹이 튕기면 맥락 상실');
  assert.deepStrictEqual(selected, [0]);
});

t('18. wPickSearch: 잘못된 인덱스는 무시(크래시·오선택 없음)', () => {
  reset();
  F.wPickSearch(999);
  assert.deepStrictEqual(selected, []);
});

t('19. wPickSeg: 세그먼트 전환이 STATE.wSeg에 반영되고 2단이 그 그룹으로 다시 그려짐', () => {
  reset();
  F.wPickSeg('리뷰천국');
  assert.strictEqual(STATE.wSeg, '리뷰천국');
  const idxs = [...els.tb2.innerHTML.matchAll(/data-i="(\d+)"/g)].map(m => +m[1]);
  assert.deepStrictEqual(idxs, [2]);
});

console.log('\n' + pass + ' runtime checks passed');
