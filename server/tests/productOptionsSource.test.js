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

test('옵션 이름이 비어 와도 받는다 — 인트라넷은 값만 보낸다(2026-10-14 실사고: 옵션 있는 리뷰오더가 전부 400)', () => {
  const list = [{
    name: '가습기', product_mode: 'opt', option_schema_version: 2, base: { pay: 0, count: 0 },
    options: [
      { option_1: { name: '', value: '화이트' }, label: '화이트', pay: 30000, count: 10 },
      { option_1: { name: '  ', value: '블랙' }, option_2: { name: '', value: '대형' }, label: '블랙', pay: 30000, count: 5 },
    ],
  }];
  const [p] = JSON.parse(normalizeProductOptionsJson(JSON.stringify(list)).json);
  assert.deepEqual(p.options[0].option_1, { name: '옵션', value: '화이트' });
  assert.deepEqual(p.options[1].option_2, { name: '옵션2', value: '대형' });
  assert.equal(p.options[1].label, '블랙 + 대형');
  // 값은 여전히 필수
  assert.throws(() => normalizeProductOptionsJson(JSON.stringify([{ ...list[0], options: [{ option_1: { name: '', value: '' }, pay: 1, count: 1 }] }])),
    err => err instanceof ProductOptionsError && /1차 옵션값/.test(err.message));
});

test('옵션 이름을 채운 상품 구성은 작업표 계획에서 옵션 줄이 선다', () => {
  const { stagedSelectionsFromWorkOrder } = require('../src/utils/worktablePlan');
  const list = [{ name: '가습기', product_mode: 'opt', option_schema_version: 2, base: { pay: 0, count: 0 },
    options: [{ option_1: { name: '', value: '화이트' }, label: '화이트', pay: 1, count: 3 }] }];
  const json = normalizeProductOptionsJson(JSON.stringify(list)).json;
  assert.match(json, /"name":"옵션"/);
  const rows = stagedSelectionsFromWorkOrder({ product_options_json: json });
  assert.equal(rows.length, 1, '이름 없는 옵션은 작업표 계획에서 통째로 빠진다');
  assert.equal(rows[0].option1Name, '옵션');
});
