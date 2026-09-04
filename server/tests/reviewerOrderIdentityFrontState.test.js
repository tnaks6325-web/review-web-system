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
