/**
 * sheetlessLabelHidden.test.js — 회귀가드: 무시트 작업에는 **시트 라벨을 그리지 않는다**
 * 실행: node tests/sheetlessLabelHidden.test.js
 *
 * 배경(사용자 확정 2026-08-23 · 「0729)위드프렌즈_면마스크 200건」): 이관(무시트)한 작업인데
 *   작업보드 머리에 `무시트` 배지와 나란히 `📄 위드프렌즈 체험단 시트_2026` · `원본: 시트` ·
 *   `시트 그리드 · 열람` 이 떠서 **아직 구글시트를 쓰는 작업처럼 읽혔다**.
 *   이관해도 `sheet_id` 는 좌표로 남아 제목 조회가 계속 성공하므로 가만두면 영영 사라지지 않는다.
 *
 * 고정하는 것:
 *  A. 판정 **단일 출처** `_isNoSheet` — 무시트 배지와 라벨 숨김이 같은 값을 본다
 *     · 필드가 없으면 false(= 종전 표기 유지 · 모르는 것을 무시트로 단정하지 않는다)
 *  B. 작업보드 머리 — 시트 표기(제목 칩·`원본: 시트`·그리드 모드 배지)는 **전부 제거됨**
 *     · `원본: Track B` 는 시트 라벨이 아니므로 그대로 남는다
 *  C. 목록 4곳(작업 탭바 · 통합검색 · 업체 사이드바/표/대시보드 · 업체관리 연결탭)도 같은 게이트
 *     · 라벨을 빼도 구분자(` · `)가 앞에 남지 않는다
 *  D. 업체(광고주) 응답에 `sheetless` 가 실린다 — 없으면 라벨 숨김이 조용히 무력화된다
 *  E. 검색 **필터**는 좁히지 않는다(시트 제목으로 찾던 길을 없애면 그건 회귀다)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readRoot = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0;
const ok = (name, cond, extra) => { assert(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✓ ' + name); };

const WD = readRoot('frontend/workdesk.html');

/** workdesk.html 인라인 스크립트에서 함수 하나를 이름으로 잘라 온다(스텁이 아니라 **구현**을 넣는다). */
function grab(name) {
  const i = WD.indexOf('\nfunction ' + name + '(');
  assert(i > 0, name + ' 함수를 찾지 못했습니다');
  // 다음 최상위 `function ` 선언 직전까지
  const j = WD.indexOf('\nfunction ', i + 1);
  return WD.slice(i, j > 0 ? j : i + 4000);
}

console.log('\n[A] 판정 단일 출처 `_isNoSheet`');
{
  const sandbox = { STATE: { cur: null }, esc: s => String(s == null ? '' : s), sheetTitle: sid => sid };
  vm.createContext(sandbox);
  vm.runInContext(grab('_isNoSheet'), sandbox);

  ok('sheetless===true 만 무시트', sandbox._isNoSheet({ sheetless: true }) === true);
  ok('★ 필드 없음 = false(모르는 것을 무시트로 단정하지 않는다)',
    sandbox._isNoSheet({}) === false && sandbox._isNoSheet(null) === false && sandbox._isNoSheet(undefined) === false);
  ok('문자열 "true" 를 무시트로 읽지 않는다', sandbox._isNoSheet({ sheetless: 'true' }) === false);

  /* ⚠ 「무시트」 배지는 제거됐다(사용자 확정 2026-08-23) — 활성 작업이 전부 무시트라 상시
     표기가 되어 신호 구실을 못 했다. 판정(`_isNoSheet`)은 시트 제목 라벨 숨김이 계속 쓴다. */
  ok('★ 무시트 배지 렌더러는 없다(되붙이면 상시 표기로 되돌아간다)',
    typeof sandbox._nsBadge === 'undefined');

  /* ⚠ `_curSheetLabel`(📄 시트 제목 칩)은 제거됐다(사용자 확정 2026-08-23) —
     「무시트」·그리드 모드·「원본: 시트」 에 이은 시트 표기 정리의 마지막.
     ★ 다시 만든다면 "무시트면 숨김"이 아니라 **"시트 기반이면 표시"** 여야 한다. */
  ok('★ 시트 제목 칩 렌더러는 없다(되붙이면 상시 표기로 되돌아간다)',
    typeof sandbox._curSheetLabel === 'undefined');
}

console.log('\n[B] 작업보드 머리 3종');
{
  ok('무시트 판정을 렌더 시작부에서 1회만 구한다',
    /const noSheet=_isNoSheet\(m\)\|\|_isNoSheet\(STATE\.cur\);/.test(WD));
  ok('★ 시트 제목 칩 호출·CSS 흔적 0', (() => {
    const live = WD.replace(/\/\*[\s\S]*?\*\//g, '');   // 설명 주석이 대신 통과시키지 않게
    return !/_curSheetLabel/.test(live) && !/mhsheet/.test(live);
  })());
  ok('★ 제목 행 h1 의 nowrap·ellipsis 는 남는다 — 없으면 [마감] 버튼이 아랫줄로 떨어진다',
    /\.mh\.mh-wb h1\{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap/.test(WD));
  ok('★ noSheet 판정은 남는다 — 리허설 안내문이 쓴다',
    /\$\{noSheet\?'주문 기록은':'구글시트·주문은'\}/.test(WD));

  /* ★★ 「원본: 시트」 배지는 **제거**했다(사용자 확정 2026-08-23) — 시트 기반 작업에서도 안 뜬다.
       본섭 실측(114 전수) 상 `source_of_truth` 는 전부 `sheet` 이라 종전 조건에서도 이미
       안 보이고 있었다. 시트 기반 작업임을 알리는 표기는 이제 **시트 제목 라벨 하나**다.
     ★ 「원본: Track B」 는 남는다 — 시트 표기가 아니라 **cutover 상태**이고 master 의
       [⋯] 전환 버튼과 짝이다(없애면 전환 여부를 화면에서 알 수 없다). */
  /* ⚠ 검사 범위는 **작업보드 상단 `sotBadge` 한 곳**이다 — 파일 전체로 보면 관측 뷰의
     `원본` 열(`o.sourceOfTruth==='db'?'Track B':'시트'`)과 전환 토스트가 걸린다.
     그 둘은 다른 화면·다른 목적이라 이번 정리 대상이 아니다. */
  ok('★ 작업보드 상단 `원본: 시트` 는 어떤 경우에도 안 그린다', (() => {
    const i = WD.indexOf('const sotBadge=');
    /* 끝 앵커 = **전환 버튼 대입문**. 그 버튼 문구에 「시트로 되돌리기」가 들어 있어
       배지 블록에 포함시키면 이 검사가 제 뜻을 잃는다. 대입 이름은 두 가지가 있다:
       지역변수(`const flipBtn=`) / [⋯] 메뉴 재렌더용 STATE 보관(`STATE._flipBtnHtml=`).
       **둘 중 먼저 나오는 것**을 끝으로 삼는다 — 이름이 바뀌어도 보는 범위는 같다. */
    const cands = ['const flipBtn=', 'STATE._flipBtnHtml=']
      .map(k => WD.indexOf(k, i)).filter(x => x > i);
    const j = cands.length ? Math.min(...cands) : -1;
    const blk = WD.slice(i, j);
    return i > 0 && j > i && !/시트/.test(blk);
  })());
  ok('★ `원본: Track B`(cutover 상태)는 그대로 남는다',
    /const sotBadge=\(sot==='db'\)/.test(WD) && />원본: Track B</.test(WD));
  ok('★ 전환 버튼도 그대로 — 상태 표기를 없앤 게 아니라 시트 표기만 뺐다',
    /flipSoT\('\$\{sot==='db'\?'sheet':'db'\}'\)/.test(WD));

  /* ★★ 그리드 모드 배지는 **둘 다 제거**했다(사용자 확정 2026-08-23) —
       `표 · 전체 열`(무시트) 은 전 작업이 무시트라 상시 표기였고, `시트 그리드 · 열람`(시트 기반)
       도 함께 뺐다. 시트 기반 작업임을 알리는 표기는 **시트 제목 라벨 + `원본: 시트` 배지**가
       계속 맡는다(둘 다 무시트면 스스로 숨으므로 신호는 유지된다 — 위 두 검사가 그것을 고정).
     ⚠ 되살린다면 "무시트면 뜬다"가 아니라 **"시트 기반이면 뜬다"** 여야 한다. */
  ok('★ 그리드 모드 배지 2종 모두 제거(되붙이면 상시 표기로 되돌아간다)',
    !/title="표 전체 컬럼 가로 펼침"/.test(WD)
    && !/title="구글시트와 동일 컬럼·가로 펼침 \(열람 전용\)"/.test(WD)
    && !/>표 · 전체 열</.test(WD) && !/>시트 그리드 · 열람</.test(WD));
  ok('★ gridMode 변수는 남는다 — 경고 분기·표 렌더·_fitGrid 가 쓴다',
    (WD.match(/gridMode/g) || []).length >= 5);

  ok('리허설 안내문도 무시트면 구글시트를 들먹이지 않는다',
    /\$\{noSheet\?'주문 기록은':'구글시트·주문은'\} 바뀌지 않습니다/.test(WD));
}

console.log('\n[C] 목록 4곳 — 같은 게이트 · 구분자가 앞에 남지 않는다');
{
  // 화면에 시트 제목을 **그리는** 자리는 전부 판정을 통과해야 한다.
  //  예외 2곳(의도) = 그림자 투영 커버리지 진단표 · 관측(parity) 표 — 시트 좌표 자체가 진단 대상이다.
  const EXEMPT = [
    'word-break:break-all">${esc(t.spreadsheetTitle||t.sheetId||\'\')}',   // 커버리지 진단표
    '<div class="ovsub">${esc(o.spreadsheetTitle)}</div>',                 // 관측(parity) 표
  ];
  const bad = WD.split('\n').filter(l =>
    /spreadsheetTitle/.test(l) && /(esc\(|_awHi\()/.test(l) &&
    !/_isNoSheet/.test(l) && !EXEMPT.some(e => l.indexOf(e) >= 0));
  ok('★ 시트 제목을 그리는 자리에 게이트 없는 사본이 없다', bad.length === 0, bad.join('\n'));

  // ★ 라벨은 작업명 우선(_tabTip)으로 바뀌었지만 **게이트는 그대로** — 이 검사가 보는 것은 시트 제목 절이다.
  ok('작업 탭바 칩 툴팁', /title="\$\{esc\(_tabTip\(t\)\)\}\$\{\(!_isNoSheet\(t\)&&t\.spreadsheetTitle\)/.test(WD));
  ok('통합검색 서브라인 — 구분자까지 함께 뺀다',
    /\$\{_isNoSheet\(t\)\?'':' · '\+esc\(t\.spreadsheetTitle\|\|''\)\}/.test(WD));
  ok('업체 사이드바 툴팁', /title="\$\{esc\(_tabTip\(it\)\)\}\$\{\(!_isNoSheet\(it\)&&it\.spreadsheetTitle\)/.test(WD));
  ok('업체 전체 작업 표 서브라인', /class="asub">\$\{_isNoSheet\(it\)\?'':_awHi\(it\.spreadsheetTitle/.test(WD));
  ok('★ 업체 대시보드 줄 — 조각으로 이어 " · 총 N건" 이 앞에 붙지 않는다',
    /\[_isNoSheet\(it\)\?'':esc\(it\.spreadsheetTitle\|\|''\),tgt\?`총 \$\{tgt\}건`:''\]\.filter\(Boolean\)\.join\(' · '\)/.test(WD));
  // ★★ 사용자 확정(2026-08-23): 업체관리는 시트 제목을 **아예** 그리지 않는다(무시트 여부와 무관) —
  //    이 화면의 단위는 작업(작업보드)이고 진실원천은 작업오더다. 종전의 _isNoSheet 게이트보다 강한 규칙.
  ok('★★ 업체관리 연결탭 서브라인에 시트 제목이 없다', /const osub=t\.firstSeenAt\?esc\(String\(t\.firstSeenAt\)\.slice\(0,10\)\):'';/.test(WD));
}

console.log('\n[D] 업체(광고주) 응답에 sheetless 가 실린다');
{
  const svc = read('src/services/trackB.service.js');
  const i = svc.indexOf('async function advertiserWorkSummary');
  const j = svc.indexOf('\n// ═══ 브랜드 분류', i);
  const body = svc.slice(i, j > 0 ? j : i + 6000);
  ok('★ 광고주 렌즈 화이트리스트에 sheetless 합류', /sheetless: t\.sheetless === true,/.test(body));
  ok('원재료가 실제로 있다(ownedTabsForAdvertiser)',
    /COALESCE\(tc\.sheetless, FALSE\) AS "sheetless"/.test(svc));
}

console.log('\n[E] 검색 필터는 좁히지 않는다(시트 제목으로 찾던 길 보존)');
{
  ok('내부 통합검색 필터에 spreadsheetTitle 유지',
    /hits\.push\(i\)/.test(WD) && /\$\{t\.spreadsheetTitle\|\|''\}`\.toLowerCase\(\)\.includes\(ql\)/.test(WD));
  ok('업체 검색 필터에 spreadsheetTitle 유지', /_awNorm\(it\.spreadsheetTitle\)\.includes\(qn\)/.test(WD));
  ok('홈 작업목록 검색 필터에 spreadsheetTitle 유지', /\$\{t\.spreadsheetTitle\|\|''\}[^\n]*toLowerCase\(\)\.includes\(q\)/.test(WD));
}

console.log(`\n✅ sheetlessLabelHidden — ${passed} 케이스 통과\n`);
