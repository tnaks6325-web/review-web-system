'use strict';

// 동시진행 ①: 기존 접수 정규화가 두 구매처 설정을 검증하는 실제 진입점이다.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProductOptionsJson, ProductOptionsError } = require('../src/services/productOptions.service');

const product = () => ({
  name: '시험 상품', product_mode: 'none', options: [],
  base: { pay: 19000, count: 3, daily: 1 },
  channels: {
    naver: { url: 'https://smartstore.naver.com/example/products/1', pay: 9000, inflow_type: 'link' },
    coupang: { url: 'https://www.coupang.com/vp/products/1', pay: 10000, inflow_type: 'guide',
      guide: { text: '시험용 검색 안내', images: [] } },
  },
});

// 기능 RED: 기존 코드는 잘못된 합계까지 검증 없이 원문으로 저장한다.
test('두 구매처 합계와 상품의 1인 결제금액이 다르면 기존 정규화에서도 거부한다', () => {
  const p = product();
  p.base.pay = 9000;
  assert.throws(() => normalizeProductOptionsJson(JSON.stringify([p]), { allowDualChannels: true }),
    err => err instanceof ProductOptionsError && /합계|합/.test(err.message));
});

test('문자열 금액을 정규화하고 사람 수와 구매처별 가이드를 그대로 유지한다', () => {
  const p = product();
  p.base.pay = '19000';
  p.base.count = '3';
  p.channels.naver.pay = '9000';
  p.channels.coupang.pay = '10000';
  const before = JSON.stringify(p);
  const result = normalizeProductOptionsJson([p], { allowDualChannels: true });
  const saved = JSON.parse(result.json);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].base.pay, 19000);
  assert.equal(saved[0].base.count, 3);
  assert.equal(saved[0].base.daily, 1);
  assert.equal(saved[0].channels.naver.pay, 9000);
  assert.equal(saved[0].channels.coupang.pay, 10000);
  assert.equal(saved[0].channels.coupang.guide.text, '시험용 검색 안내');
  assert.equal(JSON.stringify(p), before, '호출자의 원문을 직접 바꾸지 않는다');
});

test('v2 옵션 없는 상품도 같은 두 구매처 검증을 거친다', () => {
  const p = { ...product(), option_schema_version: 2 };
  const result = normalizeProductOptionsJson([p], { requireStructured: true, allowDualChannels: true });
  assert.equal(result.structured, true);
  assert.equal(JSON.parse(result.json)[0].channels.coupang.pay, 10000);
  p.channels.coupang.inflow_type = 'link';
  delete p.channels.naver;
  assert.throws(() => normalizeProductOptionsJson([p], { requireStructured: true, allowDualChannels: true }), ProductOptionsError);
});

test('새 설정이 없는 구형 상품 원문은 들여쓰기까지 그대로 둔다', () => {
  const raw = '[\n  {"name":"옛 상품", "product_mode":"none", "base":{"pay":9900,"count":2}, "options":[]}\n]';
  assert.equal(normalizeProductOptionsJson(raw).json, raw);
});

test('옵션 상품과 두 상품짜리 요청에 동시진행 설정을 섞지 못한다', () => {
  const p = product();
  p.product_mode = 'opt';
  assert.throws(() => normalizeProductOptionsJson([p], { allowDualChannels: true }), ProductOptionsError);
  assert.throws(() => normalizeProductOptionsJson([product(), { name: '다른 상품', product_mode: 'none', options: [] }], { allowDualChannels: true }), ProductOptionsError);
});

test('금액·발행 소비처에서 빈 이름이 되는 상품과 200자 초과 이름은 구형·v2 모두 거부한다', () => {
  for (const name of [' | ', '|||', '가'.repeat(201)]) {
    for (const v2 of [false, true]) {
      const p = { ...product(), name, ...(v2 ? { option_schema_version: 2 } : {}) };
      assert.throws(() => normalizeProductOptionsJson([p], { allowDualChannels: true }),
        err => err instanceof ProductOptionsError && /상품명/.test(err.message));
    }
  }
  for (const v2 of [false, true]) {
    const p = { ...product(), name: '가'.repeat(200), ...(v2 ? { option_schema_version: 2 } : {}) };
    const saved = normalizeProductOptionsJson([p], { allowDualChannels: true }).json;
    const { payAmountsFromWorkOrder } = require('../src/utils/workOrderPayAmounts');
    assert.equal(payAmountsFromWorkOrder(saved).units.length, 1);
    assert.equal(payAmountsFromWorkOrder(saved).single, 19000);
  }
});
