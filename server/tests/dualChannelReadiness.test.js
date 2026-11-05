'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProductOptionsJson, ProductOptionsError } = require('../src/services/productOptions.service');

const payload = () => [{
  name: '동시진행 시험', product_mode: 'none', options: [],
  base: { pay: 19000, count: 3 },
  channels: {
    naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'link' },
    coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'link' },
  },
}];

const notReady = err => err instanceof ProductOptionsError && err.code === 'dual_channel_not_ready';

test('미완성 동시진행은 기존 접수 정규화의 기본값으로 열리지 않는다', () => {
  assert.throws(() => normalizeProductOptionsJson(payload()), notReady);
});

test('내부 검증에 true를 명시한 호출만 두 구매처 설정을 정규화한다', () => {
  assert.equal(JSON.parse(normalizeProductOptionsJson(payload(), { allowDualChannels: true }).json)[0].base.pay, 19000);
  for (const flag of [false, undefined, null, 1, '1', 'true']) {
    assert.throws(() => normalizeProductOptionsJson(payload(), { allowDualChannels: flag }), notReady);
  }
});

test('준비중 차단은 v2와 잘못된 새 설정에도 적용돼 일반 상품으로 축소하지 않는다', () => {
  const p = payload();
  p[0].option_schema_version = 2;
  assert.throws(() => normalizeProductOptionsJson(p, { requireStructured: true }), notReady);
  p[0].channels = null;
  assert.throws(() => normalizeProductOptionsJson(p), notReady);
});

test('동시진행 차단이 기존 상품과 구매수량 단계의 정규화를 막지 않는다', () => {
  const raw = ' [ {"name":"기존 상품", "product_mode":"none", "options":[]} ] ';
  assert.equal(normalizeProductOptionsJson(raw).json, raw);
  const p = [{ name: '기존 단계 상품', option_schema_version: 2, product_mode: 'none', options: [],
    base: { pay: 10000, count: 2 }, qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 2, amount: 10000 }] } }];
  assert.equal(JSON.parse(normalizeProductOptionsJson(p).json)[0].qty_tiers.rows[0].people, 2);
});
