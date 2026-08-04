/**
 * reviewerDbTab.ux.test.js — 통합 작업대 "등록리뷰어DB" 화면 규칙 회귀가드.
 *
 * 고정하는 것 5가지(전부 사용자 확정):
 *  ① 관리자 메모는 **[저장] 을 눌러야** 반영된다(종전 onchange 자동저장 제거 — 옆 칸만 눌러도
 *     고치던 중간 문구가 저장되던 것).
 *  ② 컬럼 순서 = 이름·연락처·주소·은행·계좌번호·예금주·주민번호·소득유형·타계정·등록일
 *     (+ 요청에 없던 기존 열 상태·관리자메모·삭제는 뒤에).
 *  ③ **주소 말고는 전부 nowrap** — `table-layout:auto` 에서 th width 는 희망값이라 열이 늘면
 *     브라우저가 아무 칸이나 접고, 한 칸만 접혀도 그 행이 10px 이상 높아진다(실측 47.3→57.5px).
 *  ④ 타계정 숫자 클릭 → 그 행 **바로 아래** 펼침행. 클래스는 `rv` 접두(작업세부 패널의
 *     .worow/.wodetail 과 겹치면 그쪽 display:grid 가 <tr> 에 걸려 표가 무너진다 — 이 저장소 실측).
 *  ⑤ 리뷰어 삭제 = **완전삭제 2단 확인**. 1차는 force 없이 호출해 서버가 **아무것도 안 지우고**
 *     이력 건수만 돌려주고, 그 숫자를 보여준 뒤에야 force:true 로 지운다.
 *
 * ★ 화면 동작(줄 수·행 높이·클릭)은 정적 검사로 못 잡는 부분이 있어 **실제 브라우저로 따로 검증**했다
 *   (Chromium: 1600/1920/2560px 에서 전 행 높이 47.3px 동일 = 접힘 0, 6~7자 예금주 한 줄,
 *   포커스 이동만으로는 저장요청 0건, 확인창 취소 시 삭제요청 0건). 이 파일은 그 규칙이
 *   코드에서 사라지지 않게 고정한다.
 *
 * 실행: node server/tests/reviewerDbTab.ux.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'workdesk.html'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'server', 'src', 'routes', 'trackB.routes.js'), 'utf8');
const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)[1];
const css = style.replace(/\/\*[\s\S]*?\*\//g, '');
const jsNoComment = html.replace(/\/\*[\s\S]*?\*\//g, '');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── ① 관리자 메모 = 저장 버튼 ── */
console.log('① 관리자 메모는 [저장] 을 눌러야 반영');
ok('★ 메모 input 에 onchange 자동저장이 없다(포커스 이동만으로 저장되던 경로 제거)',
  !/data-rvid[\s\S]{0,200}?onchange\s*=\s*"_rvSaveMemo/.test(jsNoComment));
ok('입력하면 dirty 판정 훅이 돈다(oninput="_rvMemoDirty")', /oninput="_rvMemoDirty\(this\)"/.test(jsNoComment));
ok('[저장] 버튼이 있고 _rvSaveMemo 를 부른다',
  /class="btn rvmemosave"[^>]*onclick="_rvSaveMemo\(/.test(jsNoComment));
ok('저장 버튼의 기본값은 disabled(값이 안 바뀌면 못 누른다)',
  /class="btn rvmemosave"\s+disabled/.test(jsNoComment));
ok('Enter 로도 저장된다(관리자 손버릇 보존)',
  /event\.key==='Enter'\)\{event\.preventDefault\(\);_rvSaveMemo\(this\);\}/.test(jsNoComment));
ok('_rvMemoDirty 는 원본값과 다를 때만 버튼을 켠다',
  /function _rvMemoDirty[\s\S]{0,400}?String\(row\.memo\|\|''\)!==String\(el\.value\)/.test(jsNoComment));
ok('저장 실패 시 화면값을 원래대로 되돌린다(거짓 성공 표시 금지)',
  /_rvSaveMemo[\s\S]{0,900}?el\.value=row\.memo\|\|''/.test(jsNoComment));

/* ── ② 컬럼 순서 ── */
console.log('\n② 컬럼 순서(사용자 확정)');
const thead = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(
  /_renderRvBody[\s\S]*?<\/tbody><\/table>/.exec(jsNoComment)[0]);
const cols = [...thead[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => m[1].trim());
const want = ['이름', '연락처', '주소', '은행', '계좌번호', '예금주', '주민번호', '소득유형', '타계정', '등록일'];
ok(`앞 10개 = ${want.join(' · ')}`, JSON.stringify(cols.slice(0, 10)) === JSON.stringify(want));
ok('그 뒤에 상태·관리자 메모·삭제(요청에 없던 기존 열을 지우지 않았다)',
  cols[10] === '상태' && cols[11] === '관리자 메모' && cols.length === 13);
ok(`펼침행 colspan(${/colspan="\$\{RV_COLSPAN\}"/.test(jsNoComment) ? 'RV_COLSPAN' : '?'}) 이 열 수와 같다`,
  /const RV_COLSPAN = 13;/.test(jsNoComment) && /colspan="\$\{RV_COLSPAN\}"/.test(jsNoComment) && cols.length === 13);

/* ── ③ 줄바꿈 금지 ── */
console.log('\n③ 주소 말고는 전부 한 줄(행 높이 붕괴 방지)');
ok('★ 표 전체에 nowrap 을 건다(칸을 하나씩 넓히는 두더지잡기 금지)',
  /#rvbody table\.lgtable th,\s*#rvbody table\.lgtable td\{white-space:nowrap\}/.test(css));
ok('주소만 예외 — max-width + ellipsis 로 남는 폭을 흡수',
  /#rvbody table\.lgtable td\.c-addr\{[^}]*max-width:220px[^}]*text-overflow:ellipsis/.test(css));
ok('주소 셀에 c-addr 이 붙고 title 로 전체 주소가 남는다(잘려도 확인 가능)',
  /<td class="c-addr" title="\$\{esc\(r\.address\|\|''\)\}"/.test(jsNoComment));
ok('예금주 폭 104px — 한글 6~7자가 한 줄로 들어간다(원래 신고된 증상)',
  /\.lgtable \.c-hold\{width:104px\}/.test(css) && /<th class="c-hold">예금주<\/th>/.test(jsNoComment));
ok('은행 폭 90px — "카카오뱅크"(5자) 기준', /\.lgtable \.c-bank\{width:90px\}/.test(css));
ok('★ 삭제·저장 버튼도 nowrap — 두 글자가 접히면 그 행만 16px 높아진다(실측)',
  /\.rvdel\{[^}]*white-space:nowrap/.test(css) && /\.rvmemosave\{[^}]*white-space:nowrap/.test(css));

/* ── ④ 타계정 펼침 ── */
console.log('\n④ 타계정 클릭 → 행 바로 아래 펼침');
ok('타계정 수가 0보다 크면 버튼, 0이면 그냥 숫자(누를 게 없는 걸 누르게 하지 않는다)',
  /\(r\.subCount\|0\)>0[\s\S]{0,260}?onclick="_rvToggleSub\(/.test(jsNoComment));
ok('펼침행이 그 리뷰어 행 **바로 다음**에 렌더된다',
  /<\/tr>\s*<tr class="rvsubrow" data-rvsub="\$\{i\}" hidden>/.test(jsNoComment));
ok('내용은 열 때 한 번만 만든다(dataset.filled — 목록 50행 동시 렌더 방지)',
  /_rvToggleSub[\s\S]{0,400}?tr\.dataset\.filled/.test(jsNoComment));
ok('서버가 이미 주는 subAccounts 를 쓴다(신규 엔드포인트 0)',
  /_rvSubHtml[\s\S]{0,400}?r\.subAccounts/.test(jsNoComment)
  && /sub_accounts AS "subAccounts"/.test(routes));
ok('문자열로 저장된 구형 sub_accounts 도 파싱한다',
  /typeof r\.subAccounts==='string' \? JSON\.parse/.test(jsNoComment));
ok('계좌 3종이 비면 "본인 공통계좌 사용" 로 표기(빈칸=누락 오해 방지)',
  /본인 공통계좌 사용/.test(jsNoComment));
ok('★ 클래스가 rv 접두로 분리돼 있다 — 작업세부 패널의 .worow/.wodetail 과 안 겹친다',
  /\.rvsubbtn\{/.test(css) && /tr\.rvsubrow td\{/.test(css) && /table\.rvsubtbl\{/.test(css));
// 이 화면이 실제로 뿜는 마크업만 잘라내 남의 클래스를 재사용하지 않았는지 본다.
const rvMarkup =
  (/function _renderRvBody\b[\s\S]*?\n\}/.exec(jsNoComment) || [''])[0] +
  (/function _rvSubHtml\b[\s\S]*?\n\}/.exec(jsNoComment) || [''])[0];
ok('마크업 추출 성공(아래 검사가 빈 문자열을 통과시키지 않게)', rvMarkup.length > 800);
for (const c of ['worow', 'wodetail', 'wochip', 'lgrow', 'lgdetail']) {
  ok(`★ 등록리뷰어DB 마크업이 남의 클래스 .${c} 를 재사용하지 않는다(겹치면 그쪽 규칙이 <tr> 에 걸려 표가 무너진다)`,
    !new RegExp(`class="[^"]*\\b${c}\\b`).test(rvMarkup));
}
ok('이 화면이 쓰는 rv 클래스는 CSS 에 실제로 정의돼 있다(오타로 스타일이 통째로 죽는 것 방지)',
  [...rvMarkup.matchAll(/class="([^"$]*)"/g)]
    .flatMap(m => m[1].split(/\s+/))
    .filter(c => /^rv/.test(c))
    .every(c => new RegExp(`\\.${c}[\\s{,.:]`).test(css)));

/* ── ⑤ 삭제 ── */
console.log('\n⑤ 리뷰어 삭제 = 완전삭제 · 2단 확인');
ok('삭제 라우트가 있고 authMiddleware + adminOrMaster (사용자 확정: master+admin)',
  /router\.post\('\/reviewers\/delete',\s*authMiddleware,\s*adminOrMasterMiddleware/.test(routes));
ok('id 는 UUID 형식 선검사(형식 오류로 22P02 나며 응답이 안 나가는 것 방지)',
  /reviewers\/delete[\s\S]{0,700}?\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/.test(routes));
ok('★ force 없이 부르면 needConfirm 만 반환하고 **DELETE 하지 않는다**',
  /if \(!force && \(historyTotal > 0 \|\| countsPartial\)\) \{[\s\S]{0,320}?needConfirm: true/.test(routes));
ok('★ needConfirm 반환이 DELETE 문보다 먼저 온다(early return 이 실제로 막는다)',
  routes.indexOf('needConfirm: true') < routes.indexOf("DELETE FROM reviewers WHERE id = $1"));
ok('이력 집계는 주문·참여·문의 3종', /order_submissions WHERE phone8/.test(routes)
  && /campaign_applications WHERE phone8/.test(routes) && /cs_threads WHERE reviewer_phone8/.test(routes));
ok('★ 집계 실패를 0건으로 속이지 않는다(countsPartial 로 알린다)',
  /countsPartial = true/.test(routes) && /countsPartial/.test(jsNoComment));
ok('삭제는 감사 로그를 남긴다(누가·누구를·이력 몇 건)',
  /logger\.warn\(`\[reviewers\/delete\][\s\S]{0,160}?리뷰어 삭제/.test(routes));
ok('프론트: 1차는 force 없이, 확인 후에만 force:true',
  /_rvDelete[\s\S]{0,1400}?body:JSON\.stringify\(\{id:row\.id\}\)/.test(jsNoComment)
  && /_rvDelete[\s\S]{0,2200}?body:JSON\.stringify\(\{id:row\.id,force:true\}\)/.test(jsNoComment));
ok('★ 확인창이 "기록은 함께 지워지지 않는다"를 명시(FK 가 없어 이력이 남는다는 사실)',
  /함께 지워지지 않습니다/.test(jsNoComment));
ok('확인창에 실제 이력 건수가 들어간다', /구매양식 제출[\s\S]{0,80}?c\.orders/.test(jsNoComment));
ok('삭제 후 목록을 다시 불러온다', /_rvDelete[\s\S]{0,2600}?_loadReviewers\(\)/.test(jsNoComment));

/* ── 곁다리: 이 파일에서 함께 고친 잠복 버그 ── */
console.log('\n곁다리');
ok('★ trackB.routes.js 가 logger 를 최상위 import 한다 — 종전 review-inspect 실패 경로는 ReferenceError 였다',
  /^const \{ logger \} = require\('\.\.\/utils\/logger'\);$/m.test(routes));

console.log(`\n✅ reviewerDbTab.ux: ${n} cases passed`);
