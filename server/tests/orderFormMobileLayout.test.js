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

console.log('\n' + passed + ' mobile layout checks passed');
