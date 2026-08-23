/**
 * tabDisplayNameLabel.test.js — 작업 표시 이름 통일(작업명 우선) 회귀가드
 * 실행: node tests/tabDisplayNameLabel.test.js
 *
 * 무엇을 고정하나 (2026-08-24 사용자 확정 "B안"):
 *   목록 API 가 **작업명(`tab_configs.display_name`)** 을 안 실어 보내서 작업바·검색·홈 목록·
 *   업체관리·광고주 화면이 전부 **탭 이름**이었고, 작업보드 헤더만 작업명이라 같은 작업이 두 이름으로
 *   보였다(실측: 목록 「맛고」 ↔ 헤더 「0720수진코리아고양이캔」).
 *
 *   ① 서버가 목록에 displayName 을 싣는다 — **두 CTE 모두**(UNION ALL 이라 칸이 밀리면 값이 섞인다)
 *   ② 라벨 판정은 `_tabLabel` **한 곳**(사본을 두면 화면마다 이름이 갈린다)
 *   ③ 작업명이 없으면 **탭 이름으로 접는다**(구버전 백엔드·빈 값에서 동작 불변)
 *   ④ 이름을 바꿔 그리는 자리는 **툴팁에 탭 이름을 남긴다**(작업명은 중복 가능 — 구분 단서를 잃지 않는다)
 *   ⑤ 검색은 작업명도 본다(화면에 보이는 글자로 검색이 안 되면 그건 막다른 길)
 *   ⑥ **주소는 안 바뀐다** — 즐겨찾기 키·API 파라미터는 여전히 tab_name
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WD = fs.readFileSync(path.join(__dirname, '../../frontend/workdesk.html'), 'utf8');
const PART = fs.readFileSync(path.join(__dirname, '../src/services/participants.service.js'), 'utf8');

let pass = 0;
const t = (name, cond, extra) => { assert.ok(cond, name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); pass++; };

/** workdesk.html 인라인 스크립트에서 함수 하나를 중괄호 균형으로 잘라 온다(스텁이 아니라 **구현**). */
function grab(name) {
  const i = WD.indexOf('\nfunction ' + name + '(');
  assert.ok(i > 0, name + ' 함수를 찾지 못했습니다');
  let d = 0;
  for (let k = WD.indexOf('{', i); k < WD.length; k++) {
    if (WD[k] === '{') d++; else if (WD[k] === '}') { d--; if (!d) return WD.slice(i, k + 1); }
  }
  throw new Error(name + ' 블록 추출 실패');
}

console.log('\n▶ 작업 표시 이름 통일(작업명 우선)\n');

/* ═══ 1. 서버 — 목록에 작업명을 싣는다 ═══ */
console.log('1) 목록 API 재료(listActiveTabs)');
const LAT_S = PART.indexOf('async function listActiveTabs(');
assert.ok(LAT_S > 0, 'listActiveTabs 를 찾지 못했습니다');
const LAT = PART.slice(LAT_S, PART.indexOf('\n}', LAT_S));
const dnCols = (LAT.match(/COALESCE\(tc\.display_name, ''\) AS "displayName"/g) || []).length;
t('★★ 두 CTE 모두 displayName 을 뽑는다(UNION ALL — 한쪽만 넣으면 칸이 밀려 값이 섞인다)', dnCols === 2,
  'count=' + dnCols);
// 칸 순서 계약: 두 CTE 에서 displayName 이 workKind **바로 뒤**여야 SELECT * 정렬이 맞는다.
const orderOk = (LAT.match(/AS "workKind",\s*(?:\/\*[\s\S]*?\*\/\s*)?COALESCE\(tc\.display_name, ''\) AS "displayName"/g) || []).length;
t('★ 칸 위치가 두 CTE 에서 같다(workKind 바로 뒤)', orderOk === 2, 'count=' + orderOk);
t('★ 원본은 tab_configs.display_name 하나(다른 칸을 작업명으로 지어내지 않는다)',
  LAT.split('\n').filter(l => /AS "displayName"/.test(l)).every(l => /tc\.display_name/.test(l)));

/* ═══ 2. 라벨 단일 출처 + 폴백 (vm 실행) ═══ */
console.log('\n2) 라벨 판정 단일 출처');
t('★ _tabLabel 은 한 번만 선언된다(사본 금지)', (WD.match(/\nfunction _tabLabel\(/g) || []).length === 1);
t('★ _tabTip 은 한 번만 선언된다', (WD.match(/\nfunction _tabTip\(/g) || []).length === 1);

const sb = {};
vm.createContext(sb);
vm.runInContext(grab('_tabLabel') + '\n' + grab('_tabTip') + '\n' + grab('_tabSearchText'), sb);
const label = vm.runInContext('_tabLabel', sb);
const tip = vm.runInContext('_tabTip', sb);
const stext = vm.runInContext('_tabSearchText', sb);

t('작업명이 있으면 작업명', label({ tabName: '맛고', displayName: '0720수진코리아고양이캔' }) === '0720수진코리아고양이캔');
t('★ 작업명이 비면 탭 이름(종전 동작)', label({ tabName: '맛고', displayName: '' }) === '맛고');
t('★ 작업명 필드가 아예 없으면 탭 이름(구버전 백엔드 = 동작 불변)', label({ tabName: '맛고' }) === '맛고');
t('★ 공백만 있는 작업명도 탭 이름으로 접는다', label({ tabName: '맛고', displayName: '   ' }) === '맛고');
t('★ 둘 다 없어도 빈 문자열(터지지 않는다)', label(null) === '' && label({}) === '');

t('★ 툴팁은 이름이 다를 때 탭 이름을 함께 적는다(작업명은 중복 가능 — 구분 단서)',
  tip({ tabName: '맛고', displayName: '0720수진코리아고양이캔' }) === '0720수진코리아고양이캔 · 탭 맛고');
t('★ 이름이 같으면 한 번만 적는다(같은 말 두 번 금지)', tip({ tabName: '맛고' }) === '맛고');

t('★ 검색 재료에 작업명과 탭 이름이 모두 들어간다',
  /맛고/.test(stext({ tabName: '맛고', displayName: '0720' })) && /0720/.test(stext({ tabName: '맛고', displayName: '0720' })));

/* ═══ 3. 화면 6곳이 라벨을 쓴다 ═══ */
console.log('\n3) 화면 배선 — 이름을 그리는 자리');
const SITES = [
  ['작업바 2단 작업 칩', /<span class="tn">\$\{esc\(_tabLabel\(t\)\)\}<\/span>/],
  ['통합검색 결과 줄', /<span class="sn">\$\{isFav\(t\)\?'★ ':''\}\$\{hl\(_tabLabel\(t\)\)\}<\/span>/],
  ['홈 작업목록 표', /<div class="wbl-nm">\$\{esc\(_tabLabel\(t\)\)\}<\/div>/],
  ['광고주 사이드바', /<span class="nm">\$\{_awHi\(_tabLabel\(it\)\)\}/],
  ['광고주 전체 작업 표', /<span class="anm"><b>\$\{_awHi\(_tabLabel\(it\)\)\}<\/b>/],
  ['광고주 대시보드 최근작업', /<span class="pn"><b>\$\{esc\(_tabLabel\(it\)\)\}<\/b>/],
  ['업체관리 연결된 작업 표', /\$\{_ovmHl\(_tabLabel\(t\),q\)\}<\/b>/],
];
SITES.forEach(([name, re]) => t(name + ' 이 _tabLabel 을 쓴다', re.test(WD)));

const TIPS = [
  ['작업바 칩', /onclick="selTab\(\$\{i\}\)" title="\$\{esc\(_tabTip\(t\)\)\}/],
  ['홈 작업목록 행', /onclick="openTaskFromHome\(\$\{i\}\)" title="\$\{esc\(_tabTip\(t\)\)\}"/],
  ['광고주 사이드바', /onclick="selTab\(\$\{i\}\)" title="\$\{esc\(_tabTip\(it\)\)\}/],
  ['업체관리 행', /onclick="openOwnTab\(\$\{i\}\)" title="\$\{esc\(_tabTip\(t\)\)\}"/],
];
TIPS.forEach(([name, re]) => t(name + ' 툴팁이 탭 이름을 남긴다', re.test(WD)));

/* ═══ 4. 검색이 작업명도 본다 ═══ */
console.log('\n4) 검색');
t('작업바 통합검색', /if\(`\$\{_tabSearchText\(t\)\} \$\{t\.advertiserName\|\|''\}/.test(WD));
t('홈 작업목록 검색', /list=list\.filter\(t=>`\$\{_tabSearchText\(t\)\} \$\{t\.advertiserName\|\|''\}/.test(WD));
t('★ 업체관리 검색도 화면에 그리는 이름을 본다(안 넣으면 보이는 글자로 검색이 안 걸린다)',
  /return \[_tabLabel\(t\),t\.tabName,/.test(WD));

/* ═══ 5. 주소는 안 바뀐다 ═══ */
console.log('\n5) 주소(키)는 표시명이 아니다');
t('★★ 즐겨찾기 키는 여전히 tab_name(표시명으로 바꾸면 작업명을 고치는 순간 즐겨찾기가 풀린다)',
  /function _favKey\(t\)\{ return \(t\.sheetId\|\|''\)\+'␟'\+\(t\.tabName\|\|''\)/.test(WD));
t('★★ _tabLabel 을 API 파라미터로 쓰지 않는다(주소는 탭 이름)',
  !/tabName=\$\{encodeURIComponent\(_tabLabel\(/.test(WD));
t('★ 라벨 판정을 서버로 넘기지 않는다(표시 전용 — 조회 조건에 섞이면 0줄이 난다)',
  !/_tabLabel\([^)]*\)[^\n]*\b(WHERE|query\()/.test(WD));

/* ═══ 6. 인라인 스크립트 파싱 ═══ */
console.log('\n6) 무결성');
{
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0, bad = 0;
  while ((m = re.exec(WD))) { n++; try { new vm.Script(m[1]); } catch (_) { bad++; } }
  t('workdesk.html 인라인 스크립트가 전부 파싱된다', n > 0 && bad === 0, n + '블록 · 실패 ' + bad);
}

console.log('\n✅ tabDisplayNameLabel — ' + pass + ' 케이스 통과\n');
