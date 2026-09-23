/**
 * workdeskNavClickable.test.js — 리뷰웹시스템[3버전] 상단 메뉴가 "보이지 않는 상자"에 막히지 않게 고정.
 *
 * ★★ 실측 사고(이 파일이 생긴 이유):
 *   `#toast` 는 페이지에 **항상 떠 있는** `position:fixed; top:16px; left:50%` 요소인데,
 *   숨김이 `opacity:0` 뿐이었다(display:none/visibility:hidden 아님). opacity 는 히트테스트를
 *   끄지 않으므로 **화면 중앙 상단의 투명한 상자가 상단 메뉴(.nav) 위에 그대로 얹혀** 그 자리에
 *   오는 버튼의 클릭을 삼켰다. 게다가 `toast()` 는 textContent 를 지우지 않아 **상자 폭이 마지막
 *   문구 길이만큼 영구히 유지**된다 — 즉 긴 오류 토스트가 한 번 뜬 뒤로는 그 폭만큼의 메뉴가
 *   계속 죽어 있다.
 *   브라우저 실측(2560px, "저장 실패: 해당 리뷰어 행을 …" 토스트 1회 후):
 *     이미지 교체요청 9/9 · 리뷰검수 9/9 · 등록리뷰어DB 9/9 · 설정 9/9 지점 전부 차단.
 *   같은 화면의 `.wdtoast` 는 처음부터 pointer-events:none 이라 무사했다 — 이쪽만 빠져 있었다.
 *
 * ★ 증상이 "가끔"·"메뉴에 따라 다르게" 나타나는 이유 = 상자가 뷰포트 **중앙**에 고정이라
 *   화면 폭과 토스트 문구 길이에 따라 덮이는 버튼이 달라진다. 그래서 재현이 들쭉날쭉했다.
 *
 * 규칙(완화 금지): 항상 DOM 에 있고 opacity 로만 숨기는 fixed/absolute 오버레이는
 *   **반드시 pointer-events:none** 을 함께 가진다. 하나라도 빠지면 그 아래 UI 가 조용히 죽는다
 *   (에러도 콘솔 로그도 없다 — 사용자는 "클릭이 안 된다"만 겪는다).
 *
 * 실행: node server/tests/workdeskNavClickable.test.js
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
const css = style.replace(/\/\*[\s\S]*?\*\//g, '');   // 주석 제거 — 설명문의 예시 코드가 통과시키면 안 된다

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

/* ── 규칙을 만든 그 요소 자체 ── */
const toastRule = /(^|\})\s*\.toast\{([^}]*)\}/.exec(css.replace(/\n/g, ' '));
ok('#toast 의 .toast 규칙이 존재한다', !!toastRule);
ok('★ .toast 에 pointer-events:none — 없으면 투명한 상자가 상단 메뉴 클릭을 삼킨다(등록리뷰어DB·설정 사망)',
  /pointer-events\s*:\s*none/.test(toastRule[2]));
ok('.toast 는 여전히 opacity 로 숨긴다(= display 로 바꾸지 않았다 · 전환 애니메이션 보존)',
  /opacity\s*:\s*0/.test(toastRule[2]));
ok('.toast.show 로 다시 보이는 동작은 그대로', /\.toast\.show\{[^}]*opacity\s*:\s*1/.test(css.replace(/\n/g, ' ')));

/* ── 같은 함정의 이웃 ── */
ok('.wdtoast 도 pointer-events:none 유지(원래 있던 방어를 지우지 않았다)',
  /(^|\})\s*\.wdtoast\{[^}]*pointer-events\s*:\s*none/.test(css.replace(/\n/g, ' ')));

/* ── 일반 규칙: 이 클래스의 버그가 다시 새로 들어오지 못하게 ──
   "opacity:0 으로만 숨긴 fixed/absolute 오버레이"를 전부 훑어 pointer-events:none 을 요구한다.
   .show/:hover 같이 다시 켜는 규칙과 크기 0 짜리 장식은 대상이 아니다. */
const offenders = [];
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(css.replace(/\n/g, ' ')))) {
  const sel = m[1].trim(), body = m[2];
  if (!/opacity\s*:\s*0(?![.\d])/.test(body)) continue;
  if (!/position\s*:\s*(fixed|absolute)/.test(body)) continue;
  if (/pointer-events\s*:\s*none/.test(body)) continue;
  if (/@|:hover|\.show|\.on\b/.test(sel)) continue;
  offenders.push(sel);
}
ok(`★ opacity:0 으로만 숨긴 fixed/absolute 오버레이는 전부 pointer-events:none — 위반 없음${
  offenders.length ? ' (위반: ' + offenders.join(' / ') + ')' : ''}`, offenders.length === 0);

/* ── 상단 메뉴 자체가 그대로 있는지(리팩터 중 버튼이 사라지는 것 방지) ── */
for (const [v, label] of [['reviewers', '등록리뷰어DB'], ['settings', '설정']]) {
  ok(`상단 메뉴에 ${label} 버튼(data-v="${v}") 이 있고 switchView 로 배선돼 있다`,
    new RegExp(`data-v="${v}"[^>]*onclick="switchView\\('${v}'\\)"`).test(src));
}

console.log(`\n✅ workdeskNavClickable: ${n} cases passed`);
