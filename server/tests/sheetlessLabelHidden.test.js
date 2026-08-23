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
 *  B. 작업보드 머리 3종(시트 제목 · 원본: 시트 · 시트 그리드)이 무시트면 안 그려진다
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
  vm.runInContext(grab('_isNoSheet') + '\n' + grab('_nsBadge') + '\n' + grab('_curSheetLabel'), sandbox);

  ok('sheetless===true 만 무시트', sandbox._isNoSheet({ sheetless: true }) === true);
  ok('★ 필드 없음 = false(모르는 것을 무시트로 단정하지 않는다)',
    sandbox._isNoSheet({}) === false && sandbox._isNoSheet(null) === false && sandbox._isNoSheet(undefined) === false);
  ok('문자열 "true" 를 무시트로 읽지 않는다', sandbox._isNoSheet({ sheetless: 'true' }) === false);

  ok('★ 무시트 배지가 같은 판정을 쓴다(사본 0)',
    /_isNoSheet\(t\)/.test(grab('_nsBadge')) && !/t\.sheetless\s*===\s*true/.test(grab('_nsBadge')));
  ok('무시트면 배지가 뜬다', sandbox._nsBadge({ sheetless: true }).indexOf('무시트') > 0);
  ok('시트 기반이면 배지 없음', sandbox._nsBadge({ sheetless: false }) === '');

  // _curSheetLabel — 실제 실행
  sandbox.STATE.cur = { sheetId: 'SID', spreadsheetTitle: '위드프렌즈 체험단 시트_2026' };
  ok('★ 무시트면 시트 제목 칩을 그리지 않는다', sandbox._curSheetLabel(true) === '');
  const shown = sandbox._curSheetLabel(false);
  ok('시트 기반이면 종전대로 제목을 그린다(무회귀)',
    shown.indexOf('위드프렌즈 체험단 시트_2026') > 0 && shown.indexOf('mhsheet') > 0, shown);
  sandbox.STATE.cur = { sheetId: 'SID' };
  ok('제목을 모르면 종전대로 생략', sandbox._curSheetLabel(false) === '');
}

console.log('\n[B] 작업보드 머리 3종');
{
  ok('무시트 판정을 렌더 시작부에서 1회만 구한다',
    /const noSheet=_isNoSheet\(m\)\|\|_isNoSheet\(STATE\.cur\);/.test(WD));
  ok('★ 시트 제목 칩에 판정을 넘긴다', /\$\{_curSheetLabel\(noSheet\)\}/.test(WD));
  ok('인자 없는 옛 호출이 남아 있지 않다', !/_curSheetLabel\(\)/.test(WD));

  ok('★ `원본: 시트` 는 무시트면 안 그린다',
    /const sotBadge=\(noSheet && sot!=='db'\) \? ''/.test(WD));
  ok('★ `원본: Track B` 는 시트 라벨이 아니라 그대로 남는다',
    /sot==='db'\?'Track B':'시트'/.test(WD));

  ok('★ 무시트면 그리드 배지 문구에 "시트" 가 없다',
    /noSheet\?'<span class="bd" title="표 전체 컬럼 가로 펼침">표 · 전체 열<\/span>'/.test(WD));
  ok('시트 기반 그리드 배지는 종전 문구 그대로(무회귀)',
    /구글시트와 동일 컬럼·가로 펼침 \(열람 전용\)">시트 그리드 · 열람/.test(WD));

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

  ok('작업 탭바 칩 툴팁', /title="\$\{esc\(t\.tabName\)\}\$\{\(!_isNoSheet\(t\)&&t\.spreadsheetTitle\)/.test(WD));
  ok('통합검색 서브라인 — 구분자까지 함께 뺀다',
    /\$\{_isNoSheet\(t\)\?'':' · '\+esc\(t\.spreadsheetTitle\|\|''\)\}/.test(WD));
  ok('업체 사이드바 툴팁', /title="\$\{esc\(it\.tabName\)\}\$\{\(!_isNoSheet\(it\)&&it\.spreadsheetTitle\)/.test(WD));
  ok('업체 전체 작업 표 서브라인', /class="asub">\$\{_isNoSheet\(it\)\?'':_awHi\(it\.spreadsheetTitle/.test(WD));
  ok('★ 업체 대시보드 줄 — 조각으로 이어 " · 목표 N명" 이 앞에 붙지 않는다',
    /\[_isNoSheet\(it\)\?'':esc\(it\.spreadsheetTitle\|\|''\),tgt\?`목표 \$\{tgt\}명`:''\]\.filter\(Boolean\)\.join\(' · '\)/.test(WD));
  ok('★ 업체관리 연결탭 서브라인 — 조각으로 이어 " · 날짜" 가 앞에 붙지 않는다',
    /const osub=\[_isNoSheet\(t\)\?'':esc\(t\.spreadsheetTitle\|\|sheetTitle\(t\.sheetId\)\),/.test(WD)
    && /\.filter\(Boolean\)\.join\(' · '\);/.test(WD));
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
