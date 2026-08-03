/**
 * workdeskWidthCap.test.js — 통합 작업대 화면 폭 상한(FHD/QHD) + 열 너비 고정 회귀가드.
 *
 * 문제였던 것 2가지:
 *  ① 창을 넓힐수록 헤더·업체 칩바·탭바·본문이 **끝없이** 따라 늘어났다(QHD·울트라와이드에서 시선 이동 과다).
 *  ② 시트 그리드가 컨테이너를 꽉 채우려고 **주소 열이 잔여폭을 흡수**했다 → 같은 열이 창 크기·숨긴 열 수에
 *     따라 매번 다른 너비가 되어, 여러 작업을 오가며 데이터를 훑는 실사용자가 열 위치를 다시 찾아야 했다.
 *
 * 확정 규칙(완화 금지):
 *  - 표폭 = **보이는 열 고정폭의 합**. 창 너비와 무관. 열이 많은 작업일수록 표만 그만큼 넓어진다.
 *  - 화면 상한은 --app-max(FHD 1920 / QHD 2560), 우측 상단 좌우 토글로 전환·localStorage 영속.
 *
 * ★★ 이 파일이 CSS **주석/중괄호 균형**까지 세는 이유(실측 사고):
 *   `:root{--tbh:…}` 위 주석에 닫는 표시가 하나 더 있어 주석이 일찍 닫혔고, 뒤따르던 설명 텍스트가
 *   top-level 셀렉터로 파싱되며 **`:root` 규칙을 통째로 삼켰다**. 브라우저는 에러 없이 조용히 넘어가
 *   `--app-max` 기본값이 아예 적용되지 않았다(FHD 모드에서 상한 없음). grep 가드로는 못 잡는다 —
 *   선언은 멀쩡히 '있기' 때문. 그래서 토큰을 센다.
 *
 * 실행: node server/tests/workdeskWidthCap.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
const style = (() => {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src);
  assert(m, '<style> 블록을 찾지 못했다');
  return m[1];
})();
const cssNoComment = style.replace(/\/\*[\s\S]*?\*\//g, '');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── A. CSS 무결성 (조용한 파싱 포기 차단) ── */
ok('★ CSS 주석이 짝을 이룬다 — 여는 /* 수 == 닫는 */ 수',
  (style.match(/\/\*/g) || []).length === (style.match(/\*\//g) || []).length);
ok('★ 주석 제거 후 남은 */ 가 없다 — 주석 밖의 */ 는 뒤 규칙을 셀렉터로 삼킨다',
  !cssNoComment.includes('*/'));
ok('★ 중괄호 균형 — { 수 == } 수',
  (cssNoComment.match(/\{/g) || []).length === (cssNoComment.match(/\}/g) || []).length);
ok('★ :root 가 셀렉터 맨 앞에서 시작한다(앞 텍스트에 붙어 삼켜지지 않았다)',
  /(^|\})\s*:root\s*\{/.test(cssNoComment.replace(/\n/g, ' ')));

/* ── B. 상한 토큰과 두 모드 ── */
ok(':root 가 --app-max 기본값을 정의한다', /:root\{[^}]*--app-max:\s*1920px/.test(cssNoComment));
ok('FHD 모드 = 1920px', /body\[data-vw="fhd"\]\{[^}]*--app-max:\s*1920px/.test(cssNoComment));
ok('QHD 모드 = 2560px', /body\[data-vw="qhd"\]\{[^}]*--app-max:\s*2560px/.test(cssNoComment));
ok('전체화면 모드는 상한을 푼다(표에 최대 폭)', /body\.widemode\{[^}]*--app-max:\s*100vw/.test(cssNoComment));
ok('★ none 을 쓰지 않는다 — calc() 안에서 무효라 상한이 통째로 죽는다',
  !/--app-max:\s*none/.test(cssNoComment));

/* ── C. 상한이 걸린 4개 컨테이너 (하나만 빠져도 단이 어긋난다) ── */
for (const sel of ['.top', '.tb1', '.tb2', '.wrap', '.ovwrap']) {
  const re = new RegExp(`\\${sel}\\s*\\{padding-inline:max\\([^)]*calc\\(\\(100% - var\\(--app-max\\)\\)`);
  ok(`${sel} 가 padding-inline 으로 상한을 받는다`, re.test(cssNoComment.replace(/\s*\{\s*/g, '{')));
}
ok('★ 상한을 max-width 로 걸지 않는다 — sticky 배경 띠가 화면 중앙만 덮어 스크롤 시 끊긴다',
  !/\.(top|tb1|tb2)\s*\{[^}]*max-width:\s*var\(--app-max\)/.test(cssNoComment));
ok('★ 상한 규칙이 각 바의 자체 padding 선언보다 뒤에 온다(동일 특이성 → 나중이 이김)', (() => {
  const own = cssNoComment.indexOf('.top{display:flex');
  const cap = cssNoComment.indexOf('.top    {padding-inline');
  return own >= 0 && cap > own;
})());

/* ── D. 열 너비 고정 (핵심 요구) ── */
ok('★ sheetgrid 가 컨테이너로 스트레치하지 않는다(min-width:0)',
  /table\.sheetgrid\{[^}]*min-width:0[^}]*\}/.test(cssNoComment)
  && !/table\.sheetgrid\{[^}]*min-width:100%/.test(cssNoComment));
ok('table-layout:fixed 유지(열 너비 = 선언값)', /table\.sheetgrid\{[^}]*table-layout:fixed/.test(cssNoComment));
ok('★ 유동 열(주소가 잔여폭 흡수)이 완전히 제거됐다 — 부활하면 열 너비가 다시 창 크기를 탄다',
  !/_isFlexCol/.test(src));
ok('★ _fitGrid 가 표폭을 고정폭 합으로 못박는다', (() => {
  const i = src.indexOf('function _fitGrid()');
  if (i < 0) return false;
  const body = src.slice(i, i + 1400);
  return /sum\+=_colW\(k\)/.test(body) && /tbl\.style\.width=sum\+'px'/.test(body)
    && !/clientWidth/.test(body);   // 컨테이너 폭을 참조하면 창 크기에 다시 종속된다
})());
ok('★ _fitGrid 가 역할로 분기하지 않는다 — 광고주/내부가 같은 규칙', (() => {
  const i = src.indexOf('function _fitGrid()');
  const body = src.slice(i, i + 1400);
  // idKeys(표시 열 목록) 산출의 role 분기 1건만 허용
  return (body.match(/STATE\.role==='advertiser'/g) || []).length === 1;
})());

/* ── E. 토글 UI·영속 ── */
ok('우측 상단(.top 의 .sp 뒤)에 좌우 2단 스위치가 있다',
  /<span class="sp"><\/span>\s*<div class="vwsw" id="vwToggle"/.test(src));
ok('스위치가 FHD·QHD 두 라벨과 노브를 가진다',
  /<span class="vwknob"><\/span><b>FHD<\/b><b>QHD<\/b>/.test(src));
ok('노브 이동거리 = 라벨 폭(44px) — 어긋나면 노브가 라벨과 안 맞는다',
  /\.vwsw b\{[^}]*width:44px/.test(cssNoComment)
  && /\.vwsw \.vwknob\{[^}]*width:44px/.test(cssNoComment)
  && /\.vwsw\[data-on="qhd"\] \.vwknob\{transform:translateX\(44px\)\}/.test(cssNoComment));
ok('키보드로 조작 가능(role=switch + tabindex + Enter/Space)',
  /role="switch"/.test(src) && /tabindex="0"/.test(src) && /event\.key===' '\|\|event\.key==='Enter'/.test(src));
ok('선택이 localStorage 에 영속된다', /localStorage\.setItem\(VW_KEY/.test(src) && /localStorage\.getItem\(VW_KEY\)/.test(src));
ok('★ 기본값은 FHD(좁은 쪽) — 저장값 없음·읽기 실패 모두',
  /localStorage\.getItem\(VW_KEY\)==='qhd' \? 'qhd' : 'fhd'/.test(src)
  && /catch\(_\)\{ return 'fhd'; \}/.test(src));
ok('부팅과 셸 렌더 양쪽에서 모드를 반영한다(로그인 화면 포함)',
  (src.match(/_applyVwMode\(\)/g) || []).length >= 3);
ok('모드 변경 시 헤더 높이를 재실측한다(--toph 드리프트 방지)', (() => {
  const i = src.indexOf('function setVwMode(');
  return i > 0 && /_measureChrome\(\)/.test(src.slice(i, i + 400));
})());
ok('reduced-motion 이면 노브 애니메이션을 끈다',
  /prefers-reduced-motion:reduce\)\{\.vwsw \.vwknob\{transition:none\}\}/.test(cssNoComment));

/* ── F. 모집공고 카드 컨테이너 상한 (카드 자체가 아니라 카드를 품는 공간) ── */
ok('#recruitListWrap 가 max-width:1380px 를 받는다(5열 고정 — 6열 문턱 1608px 미만)',
  /#recruitListWrap\{max-width:1380px\}/.test(cssNoComment));
ok('★ 1380px 는 5열 문턱(1338px) 이상 · 6열 문턱(1608px) 미만 — 화면이 아무리 넓어도 5장/줄 고정',
  1380 >= (5 * 258 + 4 * 12) && 1380 < (6 * 258 + 5 * 12));
ok('★ 카드 자체 CSS(js/campaign-cards.js 의 .pcards-grid.pc-admin)는 건드리지 않는다 — ' +
   '건드리면 admin.html 의 모집공고 탭도 같이 바뀐다(사본 없이 공유하는 셀렉터)',
  !/\.pcards-grid\.pc-admin\{/.test(cssNoComment));
ok('★ 상한이 카드 컨테이너에 걸린다(카드 자체 min-width 등을 재정의하지 않는다)', (() => {
  const i = cssNoComment.indexOf('#recruitListWrap{');
  if (i < 0) return false;
  const decl = cssNoComment.slice(i, i + 60);
  return /max-width:1380px/.test(decl) && !/min-width|grid-template-columns/.test(decl);
})());

/* ── G. 작업오더·등록리뷰어DB·리뷰어 로그 — 뷰별 표 폭 상한 ── */
ok('★ 셋 다 같은 클래스(.lgwrap)를 공유하지만 필요 폭이 달라 뷰 컨테이너 id 로 스코프했다',
  /#wobody \.lgwrap\{max-width:1120px\}/.test(cssNoComment)
  && /#rvbody \.lgwrap\{max-width:1400px\}/.test(cssNoComment)
  && /#lgbody \.lgwrap\{max-width:1300px\}/.test(cssNoComment));
ok('★ 공유 클래스 .lgwrap 자체(단독 셀렉터)에는 max-width 를 걸지 않았다(걸면 세 값이 서로 충돌한다)',
  !/(^|\})\s*\.lgwrap\{[^}]*max-width/.test(cssNoComment.replace(/\n/g, ' ')));
ok('표 자체(table.lgtable)는 width:100% 그대로 — 감싸는 폭만 좁아진다(C/S 대화창과 같은 원리)',
  /table\.lgtable\{width:100%/.test(cssNoComment));

console.log(`\n✅ workdeskWidthCap: ${n} cases passed`);
