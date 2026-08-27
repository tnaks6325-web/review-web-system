'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProductOptionsError,
  normalizeProductOptionsJson,
  selectionKey,
} = require('../src/services/productOptions.service');

const staged = [{
  name: '티셔츠', url: 'https://example.com/tshirt', product_mode: 'opt',
  base: { pay: 18000, count: 10, daily: 2 },
  options: [{
    option_1: { name: '컬러', value: '화이트' },
    option_2: { name: '사이즈', value: '105' },
    label: '임의 문자열은 원본이 아니다', url: 'https://example.com/tshirt?color=white&size=105',
    pay: 18000, count: 10, daily: 2,
  }],
}];

test('단계형 상품·옵션 원본을 검증하고 label을 파생한다', () => {
  const result = normalizeProductOptionsJson(JSON.stringify(staged), { requireStructured: true });
  const option = JSON.parse(result.json)[0].options[0];
  assert.equal(result.structured, true);
  assert.deepEqual(option.option_1, { name: '컬러', value: '화이트' });
  assert.deepEqual(option.option_2, { name: '사이즈', value: '105' });
  assert.equal(option.label, '화이트 + 105');
  assert.equal(selectionKey('티셔츠', '화이트', '105'), '티셔츠 · 화이트 · 105');
});

test('2차만 있거나 3차가 있거나 중복된 단계형 옵션은 거부한다', () => {
  const onlySecond = structuredClone(staged);
  delete onlySecond[0].options[0].option_1;
  assert.throws(() => normalizeProductOptionsJson(onlySecond, { requireStructured: true }), ProductOptionsError);

  const third = structuredClone(staged);
  third[0].options[0].option_3 = { name: '소재', value: '면' };
  assert.throws(() => normalizeProductOptionsJson(third, { requireStructured: true }), /최대 2단계/);

  const duplicate = structuredClone(staged);
  duplicate[0].options.push(structuredClone(duplicate[0].options[0]));
  assert.throws(() => normalizeProductOptionsJson(duplicate, { requireStructured: true }), /중복된 상품·옵션 조합/);
});

test('구버전 label-only 원본은 변환하거나 추측 분해하지 않는다', () => {
  const legacy = JSON.stringify([{ name: '티셔츠', product_mode: 'opt', options: [{ label: '화이트 + 105' }] }]);
  const result = normalizeProductOptionsJson(legacy);
  assert.equal(result.structured, false);
  assert.equal(result.json, legacy);
  assert.throws(() => normalizeProductOptionsJson(legacy, { requireStructured: true }), ProductOptionsError);
});

test('옵션 없는 새 v2 상품도 상품 원본만으로 허용한다', () => {
  const result = normalizeProductOptionsJson([{ name: '간장', option_schema_version: 2, product_mode: 'none', options: [] }], { requireStructured: true });
  assert.equal(result.structured, true);
  assert.equal(JSON.parse(result.json)[0].name, '간장');
});
