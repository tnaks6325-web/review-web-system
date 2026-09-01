'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildWorktablePlan } = require('../src/utils/worktablePlan');
const { planToSheetValues } = require('../src/services/worktableCreate.service');
const { autoGuessField } = require('../src/services/columnMapping.service');
const { optionWriteColumns } = require('../src/services/orderLedger.service');
const previewRoute = fs.readFileSync(require.resolve('../src/routes/trackB.routes'), 'utf8');

const template = {
  core: ['번호', '구매일자', '수취인', '연락처', '주소', '주문번호', '비고'],
  channels: {}, workTypes: [],
};

function baseWorkOrder(overrides = {}) {
  return {
    workboard_schema_version: 2,
    work_series_id: 'series_1',
    work_round: 2,
    recruit_count: 2,
    daily_count: 2,
    start_date: '2026-08-27',
    review_type: 'photo',
    review_type_mix: [],
    delivery_type: '택배발송대행',
    courier_proxy: true,
    product_options_json: JSON.stringify([{
      name: '티셔츠', product_mode: 'opt', options: [
        { option_1: { name: '색상', value: '화이트' }, count: 1 },
        { option_1: { name: '색상', value: '블랙' }, count: 1 },
      ],
    }]),
    ...overrides,
  };
}

test('v2는 차수·상품·리뷰옵션·송장번호를 고정 앵커에 만들고 행에 기입한다', () => {
  const plan = buildWorktablePlan({ workOrder: baseWorkOrder(), template });
  assert.equal(plan.canCreate, true);
  assert.deepEqual(plan.columns.map(column => column.name), [
    '차수', '번호', '구매일자', '상품', '1차옵션', '리뷰옵션',
    '수취인', '연락처', '주소', '주문번호', '리뷰', '입금일', '비고', '송장번호',
  ]);
  assert.deepEqual(plan.rows.map(row => [row.roundLabel, row.reviewOptionLabel]), [['2차', '포토'], ['2차', '포토']]);
  const values = planToSheetValues(plan);
  const round = values.header.indexOf('차수');
  const review = values.header.indexOf('리뷰옵션');
  assert.equal(values.body[0][round], '2차');
  assert.equal(values.body[0][review], '포토');
});

test('복수 선택지 혼합 리뷰에 선택지별 수량이 없으면 생성하지 않는다', () => {
  const plan = buildWorktablePlan({ workOrder: baseWorkOrder({ review_type: 'mixed' }), template });
  assert.equal(plan.canCreate, false);
  assert.ok(plan.blockers.some(blocker => blocker.code === 'review_mix_assignment_missing'));
});

test('인트라넷 옵션 없는 상품별 base 조합은 접수 작업표와 모집공고 설정에 쓸 20행으로 보존한다', () => {
  const mix = (photo, text) => [{ type: 'photo', quantity: photo }, { type: 'text', quantity: text }];
  const products = [
    ['제주 은갈치', 4, 1],
    ['갈고 순살 듀오세트', 4, 1],
    ['갈옥 순살 듀오세트', 3, 2],
    ['정성 500갈치 1호', 3, 2],
  ].map(([name, photo, text]) => ({
    name,
    product_mode: 'none',
    base: { count: 5, daily: 5, review_type_mix: mix(photo, text) },
    options: [],
  }));
  const plan = buildWorktablePlan({
    workOrder: baseWorkOrder({
      recruit_count: 20,
      daily_count: 5,
      review_type: 'mixed',
      review_type_mix: mix(14, 6),
      product_options_json: JSON.stringify(products),
    }),
    template,
  });

  assert.equal(plan.canCreate, true);
  assert.equal(plan.rows.length, 20);
  assert.deepEqual(plan.rows.reduce((counts, row) => {
    counts[row.reviewOptionLabel] = (counts[row.reviewOptionLabel] || 0) + 1;
    return counts;
  }, {}), { 포토: 14, 텍스트: 6 });
});

test('v1은 가변 시스템 열을 만들지 않는다', () => {
  const legacy = baseWorkOrder({ workboard_schema_version: 1, work_round: 2, review_type: 'photo' });
  const plan = buildWorktablePlan({ workOrder: legacy, template });
  assert.equal(plan.columns.some(column => ['차수', '리뷰옵션', '송장번호'].includes(column.name)), false);
});

test('v2는 표준 앵커가 없으면 append하지 않고 차단한다', () => {
  const noAnchor = { core: ['번호', '구매일자', '수취인', '연락처', '주소'], channels: {}, workTypes: [] };
  const plan = buildWorktablePlan({ workOrder: baseWorkOrder(), template: noAnchor });
  assert.equal(plan.canCreate, false);
  assert.ok(plan.blockers.some(blocker => blocker.code === 'v2_required_anchor_missing'));
});

test('미리보기와 직접 생성 조회는 v2 가변열 원본을 모두 읽는다', () => {
  assert.match(previewRoute, /work_series_id, work_round, delivery_type, courier_proxy,[\s\S]{0,80}review_type, review_type_mix/);
});

test('리뷰옵션은 리뷰제출이나 상품 옵션 쓰기 대상으로 추정되지 않는다', () => {
  assert.equal(autoGuessField('리뷰옵션'), 'review_option');
  assert.deepEqual(optionWriteColumns(['리뷰옵션', '1차옵션']), [1]);
});
