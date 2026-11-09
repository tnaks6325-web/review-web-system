/**
 * 구매양식 모바일 레이아웃 회귀가드.
 * 짧은 항목은 좌측 라벨/우측 입력, 긴 주소·비고는 세로형이어야 하며
 * 선택한 참여 명의와 AI 확인 대상이 폼 안에서도 분명해야 한다.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CSS = fs.readFileSync(path.join(__dirname, '../../frontend/css/search.css'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/search.html'), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

test('모바일 구매양식은 2열 그리드와 minmax(0,1fr)로 가로 넘침을 막는다', () => {
  assert.match(CSS, /@media\(max-width:600px\)[\s\S]*?#screenOrderForm \.of-field\{[^}]*grid-template-columns:76px minmax\(0,1fr\)/);
  assert.match(CSS, /#screenOrderForm \.of-input,#screenOrderForm \.of-autocomplete-wrap\{[^}]*min-width:0/);
  assert.match(CSS, /#screenOrderForm \.screen-body\{[^}]*overflow-x:hidden/);
});

test('배송주소와 비고만 세로형 textarea를 사용한다', () => {
  assert.match(APP, /<div class="of-field of-field--stack">\s*<label[^>]*for="\$\{cid\}_address"[\s\S]*?<textarea id="\$\{cid\}_address" class="of-input of-textarea"/);
  assert.match(APP, /<div class="of-field of-field--stack" id="\$\{cid\}_memo_wrap">[\s\S]*?<textarea id="\$\{cid\}_memo" class="of-input of-textarea"/);
  assert.match(CSS, /#screenOrderForm \.of-field--stack\{grid-template-columns:minmax\(0,1fr\)/);
  const narrow = CSS.slice(CSS.indexOf('@media(max-width:340px)'));
  assert.match(narrow, /#screenOrderForm \.of-field--stack\{grid-template-columns:minmax\(0,1fr\)\}/,
    '340px 보정이 긴 필드를 다시 2열로 만들면 안 됨');
});

test('아이디 저장 선택지는 입력칸 아래 같은 열에 배치된다', () => {
  assert.match(APP, /class="of-save-id"[\s\S]*?수정한 아이디를 이 명의에 저장/);
  assert.match(CSS, /#screenOrderForm \.of-save-id\{grid-column:2/);
});

test('참여 명의는 본계정·타계정과 마스킹 번호를 안전하게 표시한다', () => {
  const loader = APP.slice(APP.indexOf('async function _loadOrderIdentityContext'), APP.indexOf('function _invalidateIdentityApproval'));
  assert.match(loader, /identity\.type === "sub" \? "타계정" : "본계정"/);
  assert.match(loader, /phoneDigits\.slice\(-4\)/);
  assert.match(loader, /_safeText\(identityName\)/);
  assert.match(APP, /class="of-identity-context" aria-label="선택한 참여 명의 확인"/);
});

test('임베드 모바일은 부모 화면과 중복되는 로그인·제공정보를 숨긴다', () => {
  assert.match(HTML, /id="orderFormProductCard" class="pane-card"/);
  assert.match(CSS, /body\.embed-mode #orderFormReviewerInfo,body\.embed-mode #orderFormProductCard\{display:none!important\}/);
});

test('제출 문구와 두 모달은 모바일 전용 스타일 훅을 가진다', () => {
  assert.match(HTML, /id="btnOrderFormSubmit"[\s\S]*?구매양식 제출/);
  assert.strictEqual((HTML.match(/class="of-modal-overlay"/g) || []).length, 2);
  assert.strictEqual((HTML.match(/class="of-modal-card"/g) || []).length, 2);
});

test('입력칸은 얇은 테두리·작은 글자이고, 투명 테두리 테마에 가려지던 상태색과 포커스가 다시 보인다(개편 1단계-2)', () => {
  const start = CSS.indexOf('/* 구매양식 입력칸 모양');
  assert.ok(start > 0, '입력칸 모양 블록');
  const block = CSS.slice(start, CSS.indexOf('/* ── 관리자 화면 너비 확장', start));
  // toss-theme.css 가 모든 input 테두리를 투명 !important 로 덮는다 — 같은 !important + 아이디 범위로만 이긴다.
  assert.match(block, /#screenOrderForm \.of-input\{[^}]*border:1px solid #b6b6bd!important;border-radius:6px!important/);
  // 개편 1단계(시안 v18): 이름표 칸 96px("결제금액 (원)"·"주문번호 선택"이 한 줄에 들어가게)
  assert.match(block, /#screenOrderForm \.of-label\{width:96px;text-align:left;font-size:13px;font-weight:400/);
  assert.match(block, /@media\(max-width:600px\)\{\s*#screenOrderForm \.of-input\{min-height:32px;padding:5px 8px;font-size:14px;line-height:20px\}/);
  assert.match(block, /#screenOrderForm \.of-input\{min-height:26px;padding:3px 8px;font-size:13px;line-height:18px/);
  // 위 !important 테두리가 상태색을 지우지 않도록 같은 범위로 다시 지정하고, 포커스는 그 뒤(입력 중엔 파랑).
  const ai = block.indexOf('.of-input.ai-filled,#screenOrderForm .of-input.ai-locked{border-color:#12b886!important}');
  const star = block.indexOf('.of-input.ai-filled-asterisk{border-color:#F43F5E!important}');
  const err = block.indexOf('.of-input.of-input--error{border-color:#EF4444!important}');
  const focus = block.indexOf('#screenOrderForm .of-input:focus{border-color:var(--p)!important');
  assert.ok(ai > 0 && star > 0 && err > 0 && focus > Math.max(ai, star, err), '상태색 재지정 + 포커스는 맨 뒤');
});

test('결정 353: 주문이 여러 건이면 위 탭 + 옆으로 넘기기 — 칸은 숨기기만(지우지 않음), 오류 칸은 그 주문을 연다', () => {
  // 2건부터만 탭, 동시진행(dual=1) 양식은 제외
  assert.match(APP, /if \(!wrap \|\| new URLSearchParams\(location\.search\)\.get\("dual"\) === "1"\) return \[\];/);
  assert.match(APP, /if \(cards\.length < 2\) \{\s*\n\s*if \(bar\) bar\.hidden = true;\s*\n\s*cards\.forEach\(\(c\) => c\.classList\.remove\("of-card-off"\)\);/);
  // 숨김은 CSS 클래스만 — 검증·저장·제출은 모든 카드를 그대로 읽는다(카드를 지우는 코드는 removeOrderCard 하나)
  assert.match(CSS, /#ofOrderCardsWrap\.of-cards-tabbed>\.of-order-card\.of-card-off\{display:none\}/);
  assert.equal((APP.match(/el\.remove\(\);/g) || []).length >= 1, true);
  // 오류·포커스로 숨은 주문 칸의 입력을 가리키면 그 주문 칸부터 보여 준다
  assert.match(APP, /function _ofReveal\(el\) \{[\s\S]{0,260}if \(card && card\.classList\.contains\("of-card-off"\)\) _ofShowCard\(card\.id, 0\);/);
  // 밀기는 입력칸·목록 위에서 시작하면 무시, 공고 화면 틀 안이면 부모에 다음 명의를 알린다(같은 출처로만)
  assert.match(APP, /closest\("input, textarea, select, \.of-saved-info-menu/);
  assert.match(APP, /window\.parent\.postMessage\(\{ type: "purchase-swipe", dir \}, location\.origin\)/);
  // 제출 완료 화면에서는 탭 줄도 접는다
  assert.match(APP, /const tabsEl = document\.getElementById\("ofCardTabs"\); if \(tabsEl\) tabsEl\.hidden = true;/);
});

console.log('\n' + passed + ' mobile layout checks passed');
