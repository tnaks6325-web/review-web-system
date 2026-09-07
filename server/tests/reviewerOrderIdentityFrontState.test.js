'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');

function functionSource(name) {
  const start = appJs.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} 함수를 찾을 수 없습니다.`);
  const brace = appJs.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < appJs.length; i++) {
    if (appJs[i] === '{') depth++;
    if (appJs[i] === '}' && --depth === 0) return appJs.slice(start, i + 1);
  }
  throw new Error(`${name} 함수 끝을 찾을 수 없습니다.`);
}

const calls = [];
const context = {
  _cardAiState: {
    card: { extracted:{ address:'보완된 주소' }, approvalToken:'matched-proof', priorApprovalToken:'', reviewToken:'' },
  },
  document: { getElementById: () => ({}) },
  _renderIdentityMatchState: (...args) => calls.push(args),
};
vm.createContext(context);
vm.runInContext(functionSource('_invalidateIdentityApproval'), context);

context._invalidateIdentityApproval('card');
assert.strictEqual(context._cardAiState.card.approvalToken, '', '수정 전 승인토큰은 제출에 재사용하면 안 된다.');
assert.strictEqual(context._cardAiState.card.priorApprovalToken, 'matched-proof', '같은 캡처 재확인용 승인증명은 보존해야 한다.');
assert.strictEqual(calls.at(-1)[1], 'REVIEW');
assert.strictEqual(calls.at(-1)[3], true, 'MATCH 후 수정 상태에는 수동 재확인 버튼이 보여야 한다.');

context._invalidateIdentityApproval('card');
assert.strictEqual(context._cardAiState.card.priorApprovalToken, 'matched-proof', '연속 수정에도 최초 승인증명을 잃으면 안 된다.');
assert.strictEqual(calls.at(-1)[3], true);

console.log('  ✓ MATCH → 필드 수정 → 재확인 가능 상태 전이');

const elements = {
  card_address:{ value:'서울 새길 20 1508호 <img src=x>' },
  card_identityStatus:{ style:{}, innerHTML:'' },
  orderIdentityAction:{ style:{}, dataset:{}, innerHTML:'', focus:() => {}, scrollIntoView:() => {} },
};
const addressContext = {
  _activeIdentityContext:{ selectedIdentity:{ address:'서울 등록길 10 502호' } },
  _cardAiState:{ card:{} },
  document:{ getElementById:(id) => elements[id] },
  _safeText:(value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};
vm.createContext(addressContext);
vm.runInContext(functionSource('_identityAddressDifference'), addressContext);
vm.runInContext(functionSource('_syncSubmissionIdentityAction'), addressContext);
vm.runInContext(functionSource('_renderIdentityMatchState'), addressContext);
addressContext._renderIdentityMatchState('card', 'REVIEW', [], true);
const rendered = elements.card_identityStatus.innerHTML;
assert.ok(rendered.includes('등록 주소') && rendered.includes('502호'));
assert.ok(rendered.includes('주문 배송지') && rendered.includes('1508호'));
assert.ok(rendered.includes('다른 배송지로도 제출할 수 있습니다'));
assert.ok(rendered.includes('&lt;img src=x&gt;') && !rendered.includes('<img'), '주소 HTML은 반드시 escape한다');
addressContext._renderIdentityMatchState('card', 'MISMATCH', ['연락처 불일치'], false);
assert.ok(!elements.card_identityStatus.innerHTML.includes('_manualConfirmIdentity'), '다른 명의는 확인 버튼을 열지 않는다');
assert.ok(elements.card_identityStatus.innerHTML.includes('구매 캡처 다시 선택하기'));
elements.card_address.value = '서울 등록길 10 502호';
assert.strictEqual(addressContext._identityAddressDifference('card'), null);
console.log('  ✓ 다른 배송지 비교 표시 · HTML 이스케이프 · 다른 명의 차단');

for (const mask of ['*', '＊', '●', '○', '◯', '◉', '•', '·', 'x', 'X']) {
  const listeners = [];
  const field = { value:'', readOnly:true, parentElement:null,
    classList:{ add:() => {}, remove:() => {} },
    removeAttribute:(name) => { assert.strictEqual(name, 'tabindex'); },
    addEventListener:(_name, fn) => listeners.push(fn),
  };
  let invalidated = 0;
  const maskContext = {
    _BATCH: false,
    _cardAiState:{ card:{ extracted:{ recipient:`김${mask}수` } } },
    document:{ getElementById:(id) => id === 'card_recipient' ? field : null },
    showToast:() => {}, _invalidateIdentityApproval:() => { invalidated++; },
  };
  vm.createContext(maskContext);
  vm.runInContext(functionSource('_hasIdentityMask'), maskContext);
  vm.runInContext(functionSource('applyCardAiResult'), maskContext);
  maskContext.applyCardAiResult('card');
  assert.strictEqual(field.readOnly, false, `${mask} 가림문자는 수정할 수 있어야 한다`);
  field.value = '김민수';
  listeners.forEach((fn) => fn());
  assert.strictEqual(invalidated, 1, '가림문자 수정은 기존 승인을 무효화한다');
}
console.log('  ✓ 서버와 같은 가림문자 10종 편집 및 승인 무효화');

(async () => {
  elements.card_address.value = '서울 새길 20 1508호';
  elements.card_recipient = { value:'김민수' };
  elements.card_phone = { value:'010-1234-5678' };
  addressContext._cardAiState.card = { reviewToken:'review-proof', extracted:{}, extractToken:'capture-proof' };
  let requests = 0, message = '';
  Object.assign(addressContext, {
    _EMBED_CTX:{ app:'test' }, _PREVIEW_MODE:false, _loadOrderIdentityContext:async () => {},
    API_BASE_URL:'https://example.invalid', _getAuthHeaders:() => ({}),
    _reviewerIdentityRequestBody:(body) => body,
    showToast:(text) => { throw new Error(text); },
    confirm:(text) => { message = text; return false; },
    fetch:async (_url, options) => {
      requests++;
      const body = JSON.parse(options.body);
      assert.strictEqual(body.formFields.address, '서울 새길 20 1508호');
      assert.strictEqual(body.manualConfirmed, true);
      return { ok:true, json:async () => ({ ok:true, approvalToken:'new-approval' }) };
    },
  });
  vm.runInContext(functionSource('_cardIdentityForm'), addressContext);
  vm.runInContext('async ' + functionSource('_manualConfirmIdentity'), addressContext);
  vm.runInContext('async ' + functionSource('_prepareIdentityApprovals'), addressContext);
  addressContext._renderIdentityMatchState('card', 'REVIEW', ['배송지 확인 필요'], true);
  const originalToast = addressContext.showToast;
  addressContext.showToast = (text) => { message = text; };
  assert.strictEqual(await addressContext._prepareIdentityApprovals([{ cid:'card', imgThumbSrc:'data:image/png;base64,test' }]), false);
  assert.ok(elements.orderIdentityAction.innerHTML.includes('여기서 명의를 확인해주세요'));
  assert.ok(elements.orderIdentityAction.innerHTML.includes("_manualConfirmIdentity('card')"));
  assert.ok(message.includes('제출 버튼 위'));
  addressContext.showToast = originalToast;
  await addressContext._manualConfirmIdentity('card');
  assert.strictEqual(requests, 0, '확인을 취소하면 승인요청을 보내지 않는다');
  assert.ok(message.includes('502호') && message.includes('1508호'));
  addressContext.confirm = () => true;
  await addressContext._manualConfirmIdentity('card');
  assert.strictEqual(requests, 1);
  assert.strictEqual(addressContext._cardAiState.card.approvalToken, 'new-approval');
  assert.strictEqual(addressContext._cardAiState.card.reviewToken, '');
  assert.ok(elements.card_identityStatus.innerHTML.includes('선택 명의의 주문으로 확인했습니다'));
  assert.ok(elements.orderIdentityAction.innerHTML.includes('명의 확인 완료'));
  assert.ok(elements.orderIdentityAction.innerHTML.includes('구매양식 제출'));
  console.log('  ✓ 주소 비교 확인창 → 취소 또는 승인요청 → 승인 상태 유지');
})().catch((err) => { console.error(err); process.exitCode = 1; });
