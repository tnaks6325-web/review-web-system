'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildWorktablePlan, stagedSelectionsFromWorkOrder } = require('../src/utils/worktablePlan');
const createSource = fs.readFileSync(require.resolve('../src/services/worktableCreate.service'), 'utf8');

const template = { core: ['번호', '구매일자', '수취인', '연락처', '주소', '주문번호', '비고'], channels: {}, workTypes: [] };
const workOrder = {
  workboard_schema_version: 2,
  recruit_count: 3,
  daily_count: 3,
  start_date: '2026-08-27',
  product_options_json: JSON.stringify([
    {
      name: '티셔츠', product_mode: 'opt', base: { count: 0 },
      options: [
        { option_1: { name: '컬러', value: '화이트' }, option_2: { name: '사이즈', value: '105' }, count: 2 },
        { option_1: { name: '컬러', value: '블랙' }, option_2: { name: '사이즈', value: '105' }, count: 1 },
      ],
    },
  ]),
};

test('v2 계획은 상품·1차·2차 옵션을 한 배정 단위로 보존한다', () => {
  const selections = stagedSelectionsFromWorkOrder(workOrder);
  assert.equal(selections.length, 2);
  assert.deepEqual(selections[0], {
    productName: '티셔츠', option1Name: '컬러', option1Value: '화이트',
    option2Name: '사이즈', option2Value: '105', selectionKey: '티셔츠 · 화이트 · 105', count: 2, review_type_mix: [],
  });

  const plan = buildWorktablePlan({ workOrder, template });
  assert.equal(plan.blockers.some(b => b.code === 'invalid_staged_options'), false);
  assert.equal(plan.rows[0].selection.productName, '티셔츠');
  assert.equal(plan.rows[0].selection.option1Value, '화이트');
  assert.equal(plan.rows[1].selection.option2Value, '105');
  assert.equal(plan.rows[2].selection.option1Value, '블랙');
  assert.deepEqual(plan.columns.filter(c => ['product', 'option_1', 'option_2'].includes(c.role)).map(c => c.name), ['상품', '1차옵션', '2차옵션']);
  assert.match(createSource, /idxProduct[\s\S]{0,120}role === 'product'/, '생성기는 상품 열 인덱스를 별도로 찾아야 한다');
  assert.match(createSource, /row\[idxProduct\] = r\.selection\.productName/, '생성기는 상품값을 단계 원본에서 채워야 한다');
  assert.match(createSource, /row\[idxOption1\] = r\.selection\.option1Value/, '생성기는 1차 옵션값을 따로 채워야 한다');
  assert.match(createSource, /row\[idxOption2\] = r\.selection\.option2Value/, '생성기는 2차 옵션값을 따로 채워야 한다');
});

test('v2 계획은 단일 상품·옵션도 각 행에 배정하고 잘못된 원본은 생성하지 않는다', () => {
  const one = structuredClone(workOrder);
  one.recruit_count = 2;
  one.product_options_json = JSON.stringify([{ name: '간장', product_mode: 'none', base: { count: 2 }, options: [] }]);
  const plan = buildWorktablePlan({ workOrder: one, template });
  assert.equal(plan.rows[0].selection.productName, '간장');
  assert.equal(plan.rows[1].selection.productName, '간장');

  const invalid = structuredClone(workOrder);
  invalid.product_options_json = JSON.stringify([{ name: '티셔츠', product_mode: 'opt', options: [{ label: '화이트 + 105' }] }]);
  const invalidPlan = buildWorktablePlan({ workOrder: invalid, template });
  assert.ok(invalidPlan.blockers.some(b => b.code === 'invalid_staged_options'));
});
