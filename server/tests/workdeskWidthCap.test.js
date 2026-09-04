/**
 * workdeskWidthCap.test.js — 리뷰웹시스템[3버전] QHD 화면 폭 상한 + 열 너비 고정 회귀가드.
 *
 * 문제였던 것 2가지:
 *  ① 창을 넓힐수록 헤더·업체 칩바·탭바·본문이 **끝없이** 따라 늘어났다(QHD·울트라와이드에서 시선 이동 과다).
 *  ② 시트 그리드가 컨테이너를 꽉 채우려고 **주소 열이 잔여폭을 흡수**했다 → 같은 열이 창 크기·숨긴 열 수에
 *     따라 매번 다른 너비가 되어, 여러 작업을 오가며 데이터를 훑는 실사용자가 열 위치를 다시 찾아야 했다.
 *
 * 확정 규칙(완화 금지):
 *  - 표폭 = **보이는 열 고정폭의 합**. 창 너비와 무관. 열이 많은 작업일수록 표만 그만큼 넓어진다.
 *  - 화면 상한은 --app-max(QHD 2560)으로 고정한다. 화면 크기 선택·localStorage 설정은 없다.
 *
 * ★★ 이 파일이 CSS **주석/중괄호 균형**까지 세는 이유(실측 사고):
 *   `:root{--tbh:…}` 위 주석에 닫는 표시가 하나 더 있어 주석이 일찍 닫혔고, 뒤따르던 설명 텍스트가
 *   top-level 셀렉터로 파싱되며 **`:root` 규칙을 통째로 삼켰다**. 브라우저는 에러 없이 조용히 넘어가
 *   `--app-max` 기본값이 아예 적용되지 않았다(QHD 상한 없음). grep 가드로는 못 잡는다 —
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

/* ── B. QHD 고정 상한 ── */
ok(':root 가 QHD --app-max 기본값(2560px)을 정의한다', /:root\{[^}]*--app-max:\s*2560px/.test(cssNoComment));
ok('화면 크기 선택용 data-vw 분기가 없다', !/data-vw/.test(cssNoComment));
ok('전체화면 모드는 상한을 푼다(표에 최대 폭)', /body\.widemode\{[^}]*--app-max:\s*100vw/.test(cssNoComment));
ok('★ none 을 쓰지 않는다 — calc() 안에서 무효라 상한이 통째로 죽는다',
  !/--app-max:\s*none/.test(cssNoComment));

/* ── C. 상한이 걸린 5개 컨테이너 (하나만 빠져도 단이 어긋난다) ──
   ★ .tb2 만 margin-inline: .tb2 는 자기 자신이 가로 스크롤 컨테이너라 padding 상한이면 탭이 넘칠 때
     스크롤 내용이 padding 을 뚫고 창 끝까지 그려진다(브라우저 스크롤 클리핑은 border-box 기준 — QHD 실측).
     margin 은 border-box 자체를 상한 안으로 줄여 탭·스크롤바가 상한에서 잘린다(배경은 .taskbar 가 같은 색). */
for (const sel of ['.top', '.tb1', '.wrap', '.ovwrap']) {
  const re = new RegExp(`\\${sel}\\s*\\{padding-inline:max\\([^)]*calc\\(\\(100% - var\\(--app-max\\)\\)`);
  ok(`${sel} 가 padding-inline 으로 상한을 받는다`, re.test(cssNoComment.replace(/\s*\{\s*/g, '{')));
}
ok('★ .tb2 는 margin-inline 으로 상한을 받는다(스크롤 컨테이너 — padding 이면 탭이 상한 밖까지 그려진다)',
  /\.tb2\{margin-inline:max\([^)]*calc\(\(100% - var\(--app-max\)\)/.test(cssNoComment.replace(/\s*\{\s*/g, '{')));
ok('★ .tb2 기본 선언에 좌우 padding 이 없다(margin 상한과 이중 오프셋 방지)',
  /\.tb2\{[^}]*padding:0[;}]/.test(cssNoComment) && !/\.tb2\{[^}]*padding:0 12px/.test(cssNoComment));
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

/* ── E. QHD 고정(선택 UI·저장값 없음) ── */
ok('화면 크기 선택 스위치가 없다',
  !/class="vwsw"|vwToggle|VW_KEY|toggleVwMode|setVwMode|_applyVwMode/.test(src));
ok('화면 크기 선택 state(data-vw)를 남기지 않는다', !/data-vw/.test(src));

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
  && /#rvbody \.lgwrap\{max-width:none\}/.test(cssNoComment)
  && /#lgbody \.lgwrap\{max-width:1300px\}/.test(cssNoComment));
ok('★ 공유 클래스 .lgwrap 자체(단독 셀렉터)에는 max-width 를 걸지 않았다(걸면 세 값이 서로 충돌한다)',
  !/(^|\})\s*\.lgwrap\{[^}]*max-width/.test(cssNoComment.replace(/\n/g, ' ')));
ok('표 자체(table.lgtable)는 width:100% 그대로 — 감싸는 폭만 좁아진다(C/S 대화창과 같은 원리)',
  /table\.lgtable\{width:100%/.test(cssNoComment));

/* ── H. 헤더 버튼바(.mh)를 그 아래 데이터 폭에 맞춰 정렬 ──
   .mh 는 h1 + <span class="sp" style="flex:1"> + 버튼들 구조라, .mh 자체가 캡되지 않으면
   .sp 가 .ovwrap 전체 폭을 먹어 버튼이 "페이지 오른쪽 끝"에 붙는다(실측 — 작업오더
   스크린샷에서 상태 필터·검색 버튼이 표보다 훨씬 오른쪽에 떠 있었다). 아래 넷은 위에서 정한
   데이터 폭과 정확히 같은 값이어야 버튼이 "그 데이터의 오른쪽 끝"에 붙는다. */
ok('작업오더 헤더(#wohead .mh)가 표와 같은 1120px', /#wohead \.mh\{max-width:1120px\}/.test(cssNoComment));
ok('모집공고 헤더(#rchead .mh)가 카드 컨테이너와 같은 1380px', /#rchead \.mh\{max-width:1380px\}/.test(cssNoComment));
ok('등록리뷰어DB 헤더(#rvhead .mh)가 QHD 가용 폭을 함께 쓴다', /#rvhead \.mh\{max-width:none\}/.test(cssNoComment));
ok('리뷰어 로그 헤더(#lghead .mh)가 표와 같은 1300px', /#lghead \.mh\{max-width:1300px\}/.test(cssNoComment));
ok('★ 공유 클래스 .mh 자체(단독 셀렉터)에는 max-width 를 걸지 않았다(다른 뷰까지 캡되면 안 된다)',
  !/(^|\})\s*\.mh\{[^}]*max-width/.test(cssNoComment.replace(/\n/g, ' ')));

/* ── I. 작업보드 상단 3단(.tp3grid) — 넓은 화면에서 끝없이 늘어나지 않는다 ──
   종전 8칸 스트립(.stripA .mcell)을 시안 B의 3분할 카드로 바꾸면서 검사 대상도 함께 옮겼다
   (검사 의미는 불변 = "상단이 화면 끝까지 늘어나지 않고 남는 폭은 우측 여백으로 흘린다").
   시안 = frontend/docs/design-workboard-top-3section.html */
ok('★ .tp3grid 에 폭 상한이 있다(모집공고 카드 컨테이너와 같은 1380px)',
  /\.tp3grid\{[^}]*max-width:1380px/.test(cssNoComment));
ok('★ 광고주(정산 열 없음) 2열 변형에도 상한이 있다',
  /\.tp3grid\.n2\{[^}]*max-width:920px/.test(cssNoComment));
ok('★ 값 …축약이 살아 있다(.tp3kv dd ellipsis) — 긴 상품명이 카드를 밀지 않는다',
  /\.tp3kv dd\{[^}]*text-overflow:ellipsis/.test(cssNoComment));
ok('★ 종전 스트립(.stripA .mcell)은 남아 있지 않다(사본 금지 — 두 벌이면 드리프트)',
  !/\.stripA/.test(cssNoComment) && !/class="mcell/.test(src));

/* ── J. 제목 행(.mh.mh-wb) — 마감 안내 + [🏁 마감] 이 작업명과 **같은 행** (사용자 확정) ──
   ★★ flex 는 줄바꿈을 먼저 하고 축소는 그다음이라(줄나눔 판정 = 축소 전 max-content) nowrap 이 없으면
      좁은 폭에서 [마감]이 아랫줄로 떨어진다 — 시안 검증에서 실측. nowrap + min-width:0 이 한 벌. */
ok('★ 작업보드 제목 행이 nowrap(줄바꿈 금지)', /\.mh\.mh-wb\{[^}]*flex-wrap:nowrap/.test(cssNoComment));
/* ⚠ 시트 제목 칩(`.mhsheet`)은 제거됐다(사용자 확정 2026-08-23) — 이제 제목 `h1` 하나다.
   ★ `h1` 의 min-width:0 + ellipsis 는 **여전히 필수** — 제목 행이 nowrap 이라 축소가 막히면
     긴 작업명이 [마감] 버튼을 아랫줄로 밀어낸다(§I 의 실측 사고). */
ok('★ 제목이 축소 가능(min-width:0 + …축약)', (() => {
  const m = cssNoComment.match(/\.mh\.mh-wb h1\{[^}]*\}/);
  return !!m && /min-width:0/.test(m[0]) && /text-overflow:ellipsis/.test(m[0]);
})());
ok('★ 마감 안내 문구도 축소 가능(.tp3fin .ft min-width:0)',
  /\.tp3fin \.ft\{[^}]*min-width:0/.test(cssNoComment));
ok('★ 공유 클래스 .mh 자체에는 nowrap 을 걸지 않았다(다른 뷰 헤더까지 바뀌면 안 된다)',
  !/(^|\})\s*\.mh\{[^}]*flex-wrap:nowrap/.test(cssNoComment.replace(/\n/g, ' ')));
ok('마감 조각이 제목 행 안에서 렌더된다(전폭 띠 .wbl-finbar 폐기)',
  /class="mh mh-wb"[\s\S]{0,900}?\$\{_finBarHtml\(\)\}/.test(src) && !/class="wbl-finbar"/.test(src));
ok('★ _finBarHtml 루트가 id="finBar" 를 유지한다(_finRefresh 의 outerHTML 교체 계약)', (() => {
  const m = src.match(/function _finBarHtml\(\)\{[\s\S]*?\n\}/);
  if (!m) return false;
  const roots = m[0].match(/<span class="tp3fin" id="finBar">/g) || [];
  return roots.length === 2 && /document\.getElementById\('finBar'\)/.test(src);
})());
/* ★ 2026-08-21 조건부 노출 도입 — 메뉴 내용은 `_mhMenuHtml()` 이 그리고, 진실원천 전환 버튼은
     `STATE._flipBtnHtml` 로 넘어간다(헤더 렌더의 지역변수로는 재렌더 때 못 읽는다).
     검사 의미는 그대로 — **master 도구 3종이 메뉴 안에 있고 제목 행에 낱개로 안 나온다**. */
ok('★ master 도구 3종이 [⋯] 메뉴 안에 있다(주 행동 [마감]이 오른쪽 끝을 갖는다)', (() => {
  const m = src.match(/function _mhMenuHtml\(\)\{[\s\S]*?\n\}/);
  if (!m) return false;
  return /STATE\._flipBtnHtml/.test(m[0]) && /showWritebackSim\(\)/.test(m[0]) && /id="projBtn"/.test(m[0])
    && /STATE\._flipBtnHtml=isMaster\?`<button class="btn" id="sotBtn"/.test(src)
    && /<span class="mhmenu" id="mhMenuBox">\$\{_mhMenuHtml\(\)\}<\/span>/.test(src);
})());
ok('★ 도구 버튼이 제목 행에 낱개로 남아 있지 않다(메뉴 밖 노출 0)', (() => {
  const mh = src.match(/<div class="mh mh-wb">[\s\S]*?<\/div>\n/);
  if (!mh) return false;
  const outside = mh[0].replace(/<span class="mhtools"[\s\S]*?<\/span><\/span>/, '');
  return !/showWritebackSim|projBtn|flipBtn/.test(outside);
})());
ok('★ [⋯] 바깥클릭/Esc 리스너는 1회만 등록(열 때마다 걸면 겹쳐 쌓인다)',
  /_mhToolsBound/.test(src) && (src.match(/document\.addEventListener\('click',e=>\{ const t=document\.getElementById\('mhTools'\)/g) || []).length === 1);

/* ── K. 발주 '미연결' 안내는 한 곳에서만 — 상단 ① 작업 조건 카드 안쪽 줄 ── */
/* ⚠ 2026-08-19 시안 C: 「작업세부 펼치기」 상시 노출을 폐지하고 발주 원문을
   [⋯] → 팝업(_woRawRowsHtml)으로 옮겼다. renderWorkOrderSection 은 사라졌고,
   검사 의미(= 미연결 안내를 두 곳에서 그리지 않는다)는 그대로 새 렌더러에 건다. */
ok('★ 미연결 배너가 발주 원문 렌더러에 없다(같은 말 두 번 금지)', (() => {
  const m = src.match(/function _woRawRowsHtml\(d\)\{[\s\S]*?\n\}/);
  return !!m && !/작업발주 미연결/.test(m[0]) && !/function renderWorkOrderSection/.test(src);
})());
ok('★ 작업세부 상시 펼침(.wodetail)은 본문에 그리지 않는다 — 팝업에서만', (() => {
  const m = src.match(/function openWoRawModal\(\)\{[\s\S]*?\n\}/);
  return !!m && /_woRawRowsHtml\(d\)/.test(m[0])
    && !/\$\{renderWorkOrderSection\(wd\)\}/.test(src);
})());
ok('★ 미연결 줄은 _woUnlinkedRow 한 곳(admin/master 만, 광고주·AE 미노출)', (() => {
  const m = src.match(/function _woUnlinkedRow\(wd\)\{[\s\S]*?\n\}/);
  return !!m && /role==='master'\|\|STATE\.role==='admin'/.test(m[0]) && /openWorkOrderPicker\(\)/.test(m[0])
    && (src.match(/작업발주 미연결/g) || []).length === 1;
})());

console.log(`\n✅ workdeskWidthCap: ${n} cases passed`);
