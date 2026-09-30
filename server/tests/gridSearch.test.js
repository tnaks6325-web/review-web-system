/**
 * gridSearch.test.js — 작업보드 시트 그리드 "표 검색" 회귀가드 (시안 C · docs/design-grid-search.html)
 *
 * 확정 사양(사용자 확정 2026-08-05):
 *   ① 시안 C = 툴바 왼쪽 인라인 검색창 + 스크롤 위치 눈금
 *   ② [일치하는 행만 보기]는 **넣지 않는다**(B안 옵션 — 제외 확정)
 *   ③ 왼쪽 고정 3열(#·참여자·연락처)도 **검색 대상에 포함**
 *
 * ★★ 이 파일이 지키는 불변식(완화 금지 — 전부 실제 코드에 있던 함정):
 *   ⓐ 매칭은 **데이터(STATE.gRows)** 에서 센다. 이 그리드는 첫 60행만 즉시 그리고 나머지는 rAF 로
 *      이어 붙이므로, DOM 을 훑으면 아직 안 그려진 행이 통째로 결과에서 빠진다.
 *      → 이동할 때는 남은 청크를 먼저 다 그린다(_gsFlushAll).
 *   ⓑ 하이라이트는 **인라인 배경색(셀 배경색 기능, migration 080)·편집 셀 파란 배경·행 호버**를
 *      전부 이겨야 한다(!important). 하나라도 못 이기면 "찾았다는데 노란 게 안 보이는 셀"이 생긴다.
 *   ⓒ 기존 앰버(.rowhit = 리뷰어 로그 딥링크 행 강조)와 **색이 달라야** 둘이 구분된다.
 *   ⓓ 이동은 세로뿐 아니라 **가로**도 맞추고, 왼쪽 고정열(STATE.gFrozenW) 뒤에 가려지지 않아야 한다.
 *   ⓔ 입력 중 그리드/툴바를 재렌더하면 **한글 IME 조합이 깨진다**(홈 작업목록에서 실측된 'ㅁ며면면' 사고).
 *
 * 실행: node server/tests/gridSearch.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const css = (() => {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src);
  assert(m, '<style> 블록을 찾지 못했다');
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
})();
// 주석을 지운 JS(문자열 안 슬래시는 건드리지 않게 줄 주석만 보수적으로 제거)
const js = src.replace(/^\s*\/\/.*$/gm, '');

let n = 0;
const ok = (name, cond, extra) => {
  assert(cond, name + (extra ? ' — ' + extra : ''));
  n++; console.log('  ✓ ' + name);
};

/** 이름으로 함수 하나를 통째로 뜯어낸다(중괄호 균형) */
function fnSrc(name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i >= 0, name + ' 함수를 찾지 못했다');
  let d = 0, started = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(name + ' 함수 끝을 찾지 못했다');
}

console.log('\n── A. 배치·구성(시안 C) ──');
// ★ 검사 의미 불변: "검색창이 조작 컨트롤들보다 앞 = 표 왼쪽 위".
//   그 왼쪽에 올 수 있는 것은 **읽기 전용 표기**(오늘 참여현황 칩, docs/design-grid-today-progress.html)뿐 —
//   고정 열·행 그룹·숨긴 열 같은 조작 컨트롤이 검색창 앞에 끼어들면 이 단언이 깨진다.
ok('★ 검색창이 툴바(.gridbar) 앞쪽(참여현황 표기 다음)에 온다 = 표 왼쪽 위',
  /return `<div class="gridbar">\s*(\$\{_tpHtml\(wd\.todayProgress(?:,wd\.counts)?\)\}\s*)?<div class="gsearch">/.test(src));
ok('입력·카운터·이전/다음 버튼이 한 덩이(입력칸 안)로 들어간다',
  /id="gsInput"/.test(src) && /id="gsCnt"/.test(src) && /id="gsPrev"/.test(src) && /id="gsNext"/.test(src));
ok('실시간 검색 배선(oninput) + 키 조작 배선(onkeydown)',
  /oninput="_gsInput\(this\.value\)"/.test(src) && /onkeydown="_gsKey\(event\)"/.test(src));
ok('★ 스크롤 위치 눈금(시안 C)이 표를 감싸는 .gswrap 안에 있다',
  /<div class="gswrap"><div class="gridscroll">[\s\S]*?<\/div><div class="gsmap" id="gsMap"><\/div><\/div>/.test(src));
ok('★ 눈금은 표 "바깥"에 자리를 만든다(표 위에 겹치면 오른쪽 끝 데이터를 가린다)',
  /\.gswrap\{[^}]*padding-right:15px/.test(css) && /\.gsmap\{[^}]*right:0/.test(css));
ok('★ [일치하는 행만 보기]는 넣지 않았다(B안 옵션 — 사용자 확정 제외)',
  !/일치하는 행만/.test(src) && !/gsonly/i.test(src));
ok('★ 검색 대상 열 지정 셀렉트도 없다(B안 옵션 — 제외)', !/gscol/i.test(src));

console.log('\n── B. 하이라이트 (노란색이 반드시 보여야 한다) ──');
for (const sel of ['td.gs-hit', 'tbody tr:hover td.gs-hit', 'td.gs-hit.gfz', 'tbody tr:hover td.gs-hit.gfz']) {
  ok(`${sel} 이 하이라이트 규칙에 포함된다`, css.includes('table.sheetgrid ' + sel));
}
ok('★ 일치 셀 배경이 !important — 인라인 셀 배경색(migration 080)을 이겨야 한다',
  /table\.sheetgrid tbody tr:hover td\.gs-hit\.gfz\{background:#fff3b0!important\}/.test(css.replace(/\s*\n\s*/g, '')));
ok('★ 현재 1건 배경도 !important + 주황 테두리',
  /background:#ffe9c7!important;box-shadow:inset 0 0 0 2px #ff8a00/.test(css));
ok('일치한 "글자"만 진한 노랑(mark.gs-mk) · 현재 건은 주황 반전',
  /mark\.gs-mk\{background:#ffe14d/.test(css) && /td\.gs-cur mark\.gs-mk\{background:#ff8a00;color:#fff\}/.test(css));
ok('가로로 밀려나도 남는 행 표시(# 칸 세로 막대)',
  /tr\.gs-row td\.gnum\{box-shadow:inset 3px 0 0 #ffe14d\}/.test(css)
  && /tr\.gs-rowcur td\.gnum\{box-shadow:inset 3px 0 0 #ff8a00\}/.test(css));
ok('★ 기존 앰버(.rowhit = 딥링크 행 강조 #fef3c7)와 색이 다르다 — 같으면 둘이 구분되지 않는다',
  /tr\.rowhit td[^}]*background:#fef3c7/.test(css) && !/gs-hit\{background:#fef3c7/.test(css));

console.log('\n── C. 매칭은 데이터에서 (청크 렌더 함정) ──');
const compute = fnSrc('_gsCompute');
ok('★ _gsCompute 가 DOM 을 훑지 않는다(querySelector/getElementById 미사용)',
  !/querySelector|getElementById|#gbody/.test(compute));
ok('★ _gsCompute 는 STATE.gRows(표시 순서) · STATE.gVCols(표시 열)만 본다',
  /STATE\.gRows/.test(compute) && /STATE\.gVCols/.test(compute));
ok('표시값 기준으로 찾는다(gCellDisp) — 화면에 보이는 것과 찾히는 것이 어긋나지 않게',
  /gCellDisp\(r,\s*c\.key\)/.test(compute));
ok('buildGrid 가 표시 순서·표시 열·고정열 폭을 남긴다',
  /STATE\.gRows=rows; STATE\.gVCols=vcols;/.test(src)
  && /STATE\.gFrozenW=vcols\.slice\(0,frozenN\)\.reduce/.test(src));
const go = fnSrc('_gsGo');
// ★ "호출이 있나"만 보면 안 된다 — _gsGo 안에는 그룹 펼침 분기에도 _gsFlushAll() 이 있어서
//   정작 맨 앞의 호출을 지워도 통과한다(변이시험으로 실측). **행을 찾기 전에** 그리는지 순서를 본다.
ok('★ 이동 전에 남은 청크를 먼저 그린다(_gsFlushAll 이 첫 _gsTr 조회보다 앞) — 안 하면 못 찾아간다', (() => {
  const iFlush = go.indexOf('_gsFlushAll()');
  const iLookup = go.indexOf('_gsTr(');
  return iFlush > 0 && iLookup > 0 && iFlush < iLookup;
})());
const flush = fnSrc('_gsFlushAll');
ok('_gsFlushAll 이 남은 행을 붙이고 진행 중 rAF 루프를 멈춘다',
  /insertAdjacentHTML\('beforeend'/.test(flush) && /STATE\._pendingBody=null/.test(flush));
ok('★ 청크가 뒤늦게 다 그려지면 그 행에도 하이라이트를 칠한다',
  /if\(STATE\.gSearch\) _gsPaint\(\);/.test(src));
ok('접힌 행 그룹 안이면 그 그룹만 펼치고 이동한다',
  /STATE\.gCollapsed&&STATE\.gCollapsed\.has\(k\)/.test(go) && /rerenderGrid\(\)/.test(go));

console.log('\n── D. 이동(세로 + 가로) ──');
const scrollTo = fnSrc('_gsScrollTo');
ok('★ 가로도 맞춘다(scrollLeft) — 주소·계좌번호는 표 오른쪽 끝에 있다', /scrollLeft/.test(scrollTo));
ok('★ 왼쪽 고정열 뒤에 가려지지 않게 STATE.gFrozenW 를 쓴다', /STATE\.gFrozenW/.test(scrollTo));
ok('고정열 셀(.gfz)은 가로 이동하지 않는다(항상 보이므로)', /classList\.contains\('gfz'\)/.test(scrollTo));
ok('세로도 맞추되 sticky 헤더 높이를 뺀다', /scrollTop/.test(scrollTo) && /thead th/.test(scrollTo));
ok('결과 사이 이동은 순환한다(마지막 다음 = 처음)',
  /\(STATE\.gsCur\+d\+hits\.length\)%hits\.length/.test(src));
ok('Enter=다음 · Shift+Enter=이전 · ↑↓ · Esc=지우기',
  /e\.key==='Enter'/.test(src) && /e\.shiftKey\?-1:1/.test(src)
  && /e\.key==='ArrowDown'/.test(src) && /e\.key==='Escape'/.test(src));

console.log('\n── E. 정직한 표기(조용한 누락 금지) ──');
ok('결과가 없으면 "결과 없음"이라고 말한다(입력칸도 빨갛게)',
  /결과 없음/.test(src) && /classList\.toggle\('none'/.test(src));
ok('★ 필터로 숨겨진 행에 결과가 있으면 알린다', /필터로 숨겨진 '\+STATE\.gsFiltered\+'행에도 결과가 있습니다/.test(src));
ok('몇 개 행 · 몇 칸인지 풀어서 말한다(24건이 24명인지 24칸인지 헷갈리지 않게)',
  /개 행 · '\+hits\.length\+'칸 일치/.test(src));

console.log('\n── F. 재렌더·전환 정합 ──');
ok('★ 필터·정렬·숨김 재렌더 후 하이라이트를 복원한다(rerenderGrid → _gsReapply)',
  /_fitGrid\(\); _rvReapply\(\); _gsReapply\(\);/.test(src));
ok('★ 재렌더 복원은 다시 스크롤하지 않는다(사용자가 보던 자리를 뺏지 않게)',
  !/_gsScrollTo|_gsGo\(\)/.test(fnSrc('_gsReapply')));
ok('★ 탭을 바꾸면 검색어를 비운다 — 다른 작업의 검색어가 남으면 "왜 여기만 노랗지"가 된다',
  /STATE\.gSearch=''; STATE\.gsHits=\[\]; STATE\.gsCur=-1;/.test(src));
ok('툴바가 다시 그려져도 치던 검색어가 살아남는다(value 복원)',
  /const gsVal=esc\(STATE\.gSearch\|\|''\);/.test(src) && /value="\$\{gsVal\}"/.test(src));

console.log('\n── G. IME(한글 조합) 보호 ──');
const input = fnSrc('_gsInput');
ok('★ 입력 중 그리드/툴바를 재렌더하지 않는다 — 재렌더하면 한글 조합이 깨진다(실측 사고)',
  !/rerenderGrid|renderWorkdesk|buildGrid/.test(input));
ok('입력은 짧은 디바운스로 모은다(큰 표에서도 안 버벅임)', /setTimeout\(\(\)=>\{[\s\S]*?\},120\)/.test(input));
const paint = fnSrc('_gsPaint');
ok('★ 칠하기는 #gbody 셀만 건드린다(입력칸이 든 툴바는 무접촉)',
  !/gridbar|gsInput/.test(paint));
const status = fnSrc('_gsStatus');
ok('★ 상태 표기도 textContent/classList 만 쓴다(innerHTML 로 툴바를 다시 그리지 않는다)',
  !/innerHTML/.test(status));

console.log('\n── H. 셀 마크업 보존 ──');
const mark = fnSrc('_gsMark');
ok('★ 텍스트 노드만 훑어 <mark> 를 넣는다(배지·되돌리기 버튼 마크업을 깨지 않게)',
  /nodeType===3/.test(mark) && /nodeType===1/.test(mark));
ok('중첩 mark 방지', /tagName!=='MARK'/.test(mark));
const clear = fnSrc('_gsClear');
ok('★ 해제 시 <mark> 를 텍스트로 되돌리고 normalize 한다(원래 셀 그대로)',
  /replaceChild\(document\.createTextNode\(m\.textContent\), m\)/.test(clear) && /normalize\(\)/.test(clear));

console.log('\n── I. 런타임: _gsCompute 를 실제로 실행 ──');
{
  // 실제 구현을 vm 으로 꺼내 돌린다(정적 grep 은 "찾는 규칙"이 맞는지 못 본다)
  const rows = [
    { id: 'r1', name: '김영희', phone8: '10001111', bank: '카카오뱅크', addr: '부산 진구 1' },
    { id: 'r2', name: '이보윤', phone8: '10002222', bank: '국민', addr: '서울 송파구 2' },
    { id: 'r3', name: '김영희', phone8: '10003333', bank: '카카오뱅크', addr: '대구 북구 3' },
  ];
  const hidden = [{ id: 'h1', name: '김영희', phone8: '10009999', bank: '신한', addr: '광주 4' }];
  const sandbox = {
    STATE: {
      gSearch: '', gRows: rows, gVCols: [{ key: '참여자' }, { key: '연락처' }, { key: '은행' }, { key: '주소' }],
      gsCur: -1, wd: { roster: rows.concat(hidden) },
    },
    gCellDisp(r, key) {
      if (key === '참여자') return r.name;
      if (key === '연락처') return '010-' + r.phone8.slice(0, 4) + '-' + r.phone8.slice(4);
      if (key === '은행') return r.bank;
      if (key === '주소') return r.addr;
      return '';
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(compute, sandbox);

  const run = (q) => { sandbox.STATE.gSearch = q; sandbox.STATE.gsCur = -1; sandbox._gsCompute(); return sandbox.STATE; };

  let s = run('김영희');
  ok('실행: 이름 2건이 잡힌다', s.gsHits.length === 2 && s.gsHits.every((h) => h.ci === 0), JSON.stringify(s.gsHits));
  ok('실행: 첫 결과가 현재로 선택된다', s.gsCur === 0);
  ok('★ 실행: 필터로 숨겨진 행의 일치도 세어 고지 재료를 만든다', s.gsFiltered === 1, String(s.gsFiltered));

  s = run('카카오뱅크');
  ok('실행: 은행 열 2건', s.gsHits.length === 2 && s.gsHits.every((h) => h.ci === 2));

  s = run('부산');
  ok('실행: 주소 부분일치 1건', s.gsHits.length === 1 && s.gsHits[0].ci === 3);

  s = run('10002222');
  ok('★ 실행: 대시 없는 숫자로도 연락처를 찾는다(010-1000-2222)',
    s.gsHits.length === 1 && s.gsHits[0].ci === 1 && s.gsHits[0].mk === '', JSON.stringify(s.gsHits));

  s = run('카카오');
  ok('실행: <mark> 로 감쌀 원문(mk)이 검색어와 같다', s.gsHits[0].mk === '카카오');

  s = run('KAKAO'.toLowerCase() === 'kakao' ? '이보윤' : '이보윤');
  ok('실행: 다른 이름 1건', s.gsHits.length === 1);

  s = run('없는값zz');
  ok('실행: 없으면 빈 결과 + 현재 없음', s.gsHits.length === 0 && s.gsCur === -1);

  s = run('');
  ok('실행: 빈 검색어면 전부 초기화', s.gsHits.length === 0 && s.gsCur === -1 && s.gsFiltered === 0);

  // 3자리 숫자는 "숫자만" 폴백을 켜지 않는다(짧은 숫자로 온 표가 노래지는 것 방지)
  s = run('222');
  ok('★ 실행: 3자리 숫자는 숫자-폴백을 켜지 않는다(표시값에 그대로 있는 것만)',
    s.gsHits.every((h) => h.mk === '222'), JSON.stringify(s.gsHits));

  // 고정 3열 포함(사용자 확정 ③) — 참여자(ci 0)·연락처(ci 1)가 실제로 검색된다
  s = run('010-1000');
  ok('★ 실행: 왼쪽 고정열(연락처)도 검색 대상 — 사용자 확정 "포함"',
    s.gsHits.length >= 1 && s.gsHits.every((h) => h.ci === 1), JSON.stringify(s.gsHits));
}

console.log(`\n✅ gridSearch: ${n} cases passed`);
