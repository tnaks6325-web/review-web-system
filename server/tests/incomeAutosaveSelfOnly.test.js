'use strict';
// 결정 220 — 구매양식 제출 뒤 소득신고 정보(소득명의·주민번호) 자동 저장은 1번 카드에서 "본인"을 골랐을 때만.
// 종전: 타계정을 골라도 그 사람 값으로 로그인 리뷰어 본인 칸을 덮었다(운영 실측 25명).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  const ends = ['\nfunction ', '\nasync function ', '\n/**'].map((x) => source.indexOf(x, start + 1)).filter((x) => x >= 0);
  return source.slice(start, Math.min(...ends));
}

function harness() {
  const btnsWrap = { dataset: {}, querySelectorAll: () => [] };
  const fields = { card_incomeName: { value: '' }, card_residentNo: { value: '' } };
  const ctx = {
    _orderCardIds: ['card'],
    document: { getElementById: (id) => (id === 'card_incomePersonBtns' ? btnsWrap : fields[id] || null) },
    _parseSubAccounts: (v) => v || [],
    _formatCardResidentNo: () => {},
  };
  vm.createContext(ctx);
  for (const name of ['_firstCardIncomeIsSelf', '_selectCardIncomePerson']) vm.runInContext(fn(name), ctx);
  return { ctx, btnsWrap };
}

const btn = { style: {} };
const profile = { incomeName: '본인명의', jumin: '9001011234567', subAccounts: [{ name: '가족', incomeName: '가족명의', jumin: '9502022345678' }] };

{
  const { ctx } = harness();
  assert.strictEqual(ctx._firstCardIncomeIsSelf(), false, '아무도 고르지 않았으면(모름) 본인 칸을 덮지 않는다');
  ctx._selectCardIncomePerson('card', btn, profile, -1);
  assert.strictEqual(ctx._firstCardIncomeIsSelf(), true, '본인을 고르면 저장한다');
  ctx._selectCardIncomePerson('card', btn, profile, 0);
  assert.strictEqual(ctx._firstCardIncomeIsSelf(), false, '타계정을 고르면 본인 칸에 저장하지 않는다');
  ctx._selectCardIncomePerson('card', btn, profile, -1);
  assert.strictEqual(ctx._firstCardIncomeIsSelf(), true, '다시 본인으로 바꾸면 저장한다');
  console.log('PASS 본인 선택일 때만 본인 소득정보 저장 · 타계정/모름은 저장 안 함');
}
{
  const ctx = { _orderCardIds: [], document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(fn('_firstCardIncomeIsSelf'), ctx);
  assert.strictEqual(ctx._firstCardIncomeIsSelf(), false, '카드·버튼이 없으면 저장하지 않는다');
  console.log('PASS 카드 없음 → 저장 안 함(fail-closed)');
}
{
  // 배선: 제출 뒤 saveIncomeInfo 블록이 본인 판정을 조건으로 건다.
  const at = source.indexOf('action:     "saveIncomeInfo"');
  assert(at > 0, 'saveIncomeInfo 자동 저장 블록');
  const guard = source.lastIndexOf('if (successCount > 0 && window._incomeType === "소득신고"', at);
  assert(guard > 0 && at - guard < 1500, '자동 저장 조건문');
  assert(/_firstCardIncomeIsSelf\(\)\)\s*\{/.test(source.slice(guard, guard + 200)), '조건에 본인 판정이 있다');
  console.log('PASS 제출 뒤 소득 자동 저장이 본인 판정에 묶임');
}
