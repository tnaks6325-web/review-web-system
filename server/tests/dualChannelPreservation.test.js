'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { keepDualChannelProducts, DualChannelError } = require('../src/utils/dualChannel');
const product = () => ({ name: '가짜 상품', product_mode: 'none', options: [],
  base: { pay: 19000, count: 3, daily: 1 }, channels: {
    naver: { url: 'https://fake.example/n', pay: 9000, inflow_type: 'link' },
    coupang: { url: 'https://fake.example/c', pay: 10000, inflow_type: 'link' },
  } });
const omitted = () => { const p = product(); delete p.channels; return p; };
const freeze = value => { if (value && typeof value === 'object') {
  Object.values(value).forEach(freeze); Object.freeze(value);
} return value; };
const rejects = (current, next) => assert.throws(() => keepDualChannelProducts(current, next),
  error => error instanceof DualChannelError && error.code === 'invalid_dual_channel');

test('미전송 구매처 복원: 배열 반환·합계·인원 한번·양쪽 얼린 입력 불변', () => {
  const cur = freeze([product()]); const next = freeze([omitted()]);
  const before = [JSON.stringify(cur), JSON.stringify(next)];
  const result = keepDualChannelProducts(cur, next);
  assert.ok(Array.isArray(result));
  assert.ok(Object.hasOwn(result[0], 'channels'), '미전송 구매처가 복원되어야 한다');
  assert.equal(result[0].channels.naver.pay, 9000);
  assert.equal(result[0].channels.coupang.pay, 10000);
  assert.equal(result[0].base.pay, 19000);
  assert.equal(result[0].base.count, 3);
  assert.deepEqual([JSON.stringify(cur), JSON.stringify(next)], before);
  assert.notStrictEqual(result[0].channels, cur[0].channels);
});

test('명시 구매처는 복원 대신 자체 검증하고 정상 원문·참조를 그대로 돌려준다', () => {
  const cur = [product()]; const next = [product()];
  next[0].channels.naver.pay = 8000; next[0].channels.coupang.pay = 11000;
  assert.strictEqual(keepDualChannelProducts(cur, next), next);
  const raw = JSON.stringify(next, null, 3) + '\n';
  assert.strictEqual(keepDualChannelProducts('[]', raw), raw);
  for (const channels of [null, undefined, {}, { naver: product().channels.naver }]) {
    const bad = [{ ...product(), channels }];
    rejects(cur, bad); rejects([], bad);
  }
  const bad = [product()]; bad[0].base.pay = 1;
  rejects([], bad); rejects(cur, bad);
});

test('일반 상품 배열·구형 원문·파싱불가 원문은 복원 없으면 그대로', () => {
  for (const next of [[{ name: ' 옛 상품 ', base: { pay: ' 01 ' } }],
    ' [ { "name" : " 옛 상품 " } ]\n', 'legacy text', null, undefined]) {
    assert.strictEqual(keepDualChannelProducts('legacy text', next), next);
  }
});

test('같은 상품만 복원: trim·올바른 prev_name 이름 변경·문자열 반환', () => {
  const next = omitted(); next.prev_name = '  가짜 상품  '; next.name = '새 가짜 이름';
  const raw = keepDualChannelProducts(JSON.stringify([product()]), JSON.stringify([next]));
  assert.equal(typeof raw, 'string');
  assert.equal(JSON.parse(raw)[0].name, '새 가짜 이름');
  assert.ok(Object.hasOwn(JSON.parse(raw)[0], 'channels'), '이름을 바꿔도 구매처를 보존한다');
  assert.equal(JSON.parse(raw)[0].channels.naver.pay, 9000);
  next.prev_name = ' '; next.name = ' 가짜 상품 ';
  assert.equal(keepDualChannelProducts([product()], [next])[0].channels.coupang.pay, 10000);
});

test('다른 상품·잘못된 prev_name name폴백·삭제·다상품을 거부한다', () => {
  const cur = [product()];
  for (const next of [[], null, undefined, 'bad json', '{}',
    [{ ...omitted(), name: '다른 상품' }],
    [{ ...omitted(), prev_name: '없는 옛 이름' }],
    [{ ...product(), prev_name: '없는 옛 이름' }],
    [omitted(), omitted()], [product(), omitted()]]) rejects(cur, next);
});

test('깨진 현재 동시상품은 정상 명시입력으로도 숨기지 못한다', () => {
  for (const change of [p => { p.channels = null; }, p => { p.base.pay = 1; },
    p => { p.name = ''; }, p => { p.product_mode = 'opt'; }]) {
    const p = product(); change(p);
    rejects([p], [omitted()]); rejects([p], [product()]);
  }
  rejects([product(), product()], [product()]);
});

test('복원된 최종 합계·옵션전환·마감·수량단계를 원검증으로 거부하고 입력 불변', () => {
  for (const change of [p => { p.base.pay = 1; }, p => { p.base.count = 0; },
    p => { p.product_mode = 'opt'; }, p => { p.options = [{ label: '새 옵션' }]; },
    p => { p.closed = true; }, p => { p.qty_tiers = null; }]) {
    const cur = freeze([product()]); const p = omitted(); change(p); const next = freeze([p]);
    const before = JSON.stringify(next); rejects(cur, next);
    assert.equal(JSON.stringify(next), before);
  }
});
