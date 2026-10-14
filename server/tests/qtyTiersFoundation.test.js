'use strict';

/**
 * 회귀가드: 인당 구매수량 단계 ①단계 — 오더 상품 구성의 qty_tiers 받기·검증·표준형 (2026-10-14).
 * 고정: (1) 단계가 없거나 빈 값이면 키를 지워 저장 바이트가 예전과 같다(결정 167 — 안 그러면 접수된 오더가 영영 409)
 *       (2) 단계 금액 칸은 `amount` — 접수 뒤 열린 키(`pay`)가 아니다 (3) 인원 합 = 모집인원, 공통 방식은 옵션 금액이 같을 때만
 *       (4) 정규화를 안 거치던 옛 경로 3곳(출처 계약 없는 접수·옛 수정·관리자 수정)도 단계가 실리면 검증한다.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ProductOptionsError,
  normalizeProductOptionsJson,
  rawHasQtyTiers,
} = require('../src/services/productOptions.service');

const opt = (value, pay, count) => ({
  option_1: { name: '컬러', value }, label: value, url: 'https://example.com/t', pay, count, daily: 5,
});
const product = extra => ({
  name: '텀블러', url: 'https://example.com/t', option_schema_version: 2, product_mode: 'opt',
  base: { pay: 0, count: 0, daily: 0 },
  options: [opt('블랙', 13000, 60), opt('화이트', 13000, 40)],
  ...extra,
});
const single = extra => ({
  name: '바디로션', url: 'https://example.com/b', option_schema_version: 2, product_mode: 'none',
  base: { pay: 16000, count: 100, daily: 10 }, options: [], ...extra,
});
const norm = list => JSON.parse(normalizeProductOptionsJson(JSON.stringify(list)).json);
const fails = (list, re) => assert.throws(() => normalizeProductOptionsJson(JSON.stringify(list)),
  err => err instanceof ProductOptionsError && re.test(err.message));

test('단계가 없거나 빈 값이면 키를 지운다 — 저장 바이트가 예전과 같다(결정 167)', () => {
  const before = normalizeProductOptionsJson(JSON.stringify([product()])).json;
  for (const empty of [null, '', { rows: [] }, { mode: 'common', rows: null }]) {
    assert.equal(normalizeProductOptionsJson(JSON.stringify([product({ qty_tiers: empty })])).json, before);
  }
  const one = normalizeProductOptionsJson(JSON.stringify([single()])).json;
  assert.equal(normalizeProductOptionsJson(JSON.stringify([single({ qty_tiers: null })])).json, one);
});

test('공통 방식 — 표준형으로 저장, 금액은 인트라넷 값 그대로(배송비·묶음가)', () => {
  const [p] = norm([product({ qty_tiers: { mode: 'common', rows: [
    { qty: 3, people: 10, amount: 30000 }, { qty: '2', people: 40, amount: 20000 }, { qty: 1, people: 50, amount: 13000, option: '' },
  ] } })]);
  assert.deepEqual(p.qty_tiers, { mode: 'common', buy_method: 'qty', rows: [
    { option: null, qty: 3, people: 10, amount: 30000 },
    { option: null, qty: 2, people: 40, amount: 20000 },
    { option: null, qty: 1, people: 50, amount: 13000 },
  ] });
  const [s] = norm([single({ qty_tiers: { mode: 'common', buy_method: 'option', rows: [
    { qty: 2, people: 40, amount: 55000 }, { qty: 1, people: 60, amount: 30000 },
  ] } })]);
  assert.equal(s.qty_tiers.buy_method, 'option');
});

test('공통 방식 거부 — 인원 합 불일치 · 옵션 금액이 다름 · 옵션을 적음 · 같은 단계 두 번', () => {
  fails([product({ qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 99, amount: 13000 }] } })], /인원 합\(99명\).*100명/);
  const diff = product({ qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 100, amount: 13000 }] } });
  diff.options[1].pay = 15000;
  fails([diff], /옵션별 결제금액이 달라/);
  fails([product({ qty_tiers: { mode: 'common', rows: [{ option: '블랙', qty: 1, people: 100, amount: 1 }] } })], /공통 방식에는 옵션을/);
  fails([product({ qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 50, amount: 1 }, { qty: 1, people: 50, amount: 1 }] } })], /1개 단계가 두 번/);
});

test('옵션별 방식 — 옵션마다 인원 합 = 그 옵션 모집인원', () => {
  const rows = [
    { option: '블랙', qty: 3, people: 6, amount: 30000 }, { option: '블랙', qty: 1, people: 54, amount: 13000 },
    { option: '화이트', qty: 3, people: 4, amount: 36000 }, { option: '화이트', qty: 1, people: 36, amount: 15000 },
  ];
  const [p] = norm([product({ qty_tiers: { mode: 'by_option', rows } })]);
  assert.equal(p.qty_tiers.rows.length, 4);
  assert.equal(p.qty_tiers.rows[2].option, '화이트');
  fails([product({ qty_tiers: { mode: 'by_option', rows: rows.slice(0, 3) } })], /「화이트」 인원 합\(4명\).*40명/);
  fails([product({ qty_tiers: { mode: 'by_option', rows: [...rows, { option: '레드', qty: 2, people: 0, amount: 1 }] } })], /「레드」.*없습니다/);
  fails([single({ qty_tiers: { mode: 'by_option', rows: [{ option: 'x', qty: 1, people: 100, amount: 1 }] } })], /옵션 없는 상품/);
});

test('값 형식 거부 — 방식·구매방법·수량 범위·소수', () => {
  const r = [{ qty: 1, people: 100, amount: 13000 }];
  fails([product({ qty_tiers: { mode: 'x', rows: r } })], /방식은 common 또는 by_option/);
  fails([product({ qty_tiers: { mode: 'common', buy_method: 'bulk', rows: r } })], /구매 방법/);
  fails([product({ qty_tiers: { mode: 'common', rows: [{ qty: 0, people: 100, amount: 1 }] } })], /구매수량/);
  fails([product({ qty_tiers: { mode: 'common', rows: [{ qty: 1.5, people: 100, amount: 1 }] } })], /구매수량/);
  fails([product({ qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 100, amount: -1 }] } })], /1인 결제금액/);
  fails([product({ qty_tiers: [] })], /형식이 올바르지/);
});

test('구버전(라벨만) 배열 — 단계가 실리면 거부, 빈 단계 키는 바이트 그대로', () => {
  const legacy = [{ name: '옛 상품', label: '블랙', qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 1, amount: 1 }] } }];
  fails(legacy, /단계형\(v2\) 상품 원본에서만/);
  const raw = JSON.stringify([{ name: '옛 상품', label: '블랙' }]);
  assert.equal(normalizeProductOptionsJson(raw).json, raw, '단계 키가 없으면 원문 바이트 그대로');
  for (const empty of [null, '', { rows: [] }]) {
    const withEmpty = JSON.stringify([{ name: '옛 상품', label: '블랙', qty_tiers: empty }]);
    assert.equal(normalizeProductOptionsJson(withEmpty).json, raw, '빈 단계 키는 지운다(PR #1637 리뷰)');
  }
});

test('공통 방식의 옵션 금액 비교는 기존 읽기 규칙(op.pay || base.pay) — 기본가를 물려받은 옵션도 같은 금액', () => {
  const p = product({ base: { pay: 13000, count: 0, daily: 0 }, qty_tiers: { mode: 'common', rows: [{ qty: 1, people: 100, amount: 13000 }] } });
  p.options[0].pay = 0;   // 기본가 13000 을 물려받음 — 화이트는 13000 을 직접 적음
  assert.equal(norm([p])[0].qty_tiers.mode, 'common');
});

test('옵션별 방식 줄 수 — 옵션 61개 × 2단계도 받는다(옵션 상한 200 과 맞춤)', () => {
  const opts = Array.from({ length: 61 }, (_, i) => opt('색' + i, 10000 + i * 100, 2));
  const rows = opts.flatMap(o => [{ option: o.label, qty: 2, people: 1, amount: 1 }, { option: o.label, qty: 1, people: 1, amount: 1 }]);
  const [p] = norm([product({ options: opts, qty_tiers: { mode: 'by_option', rows } })]);
  assert.equal(p.qty_tiers.rows.length, 122);
});

test('rawHasQtyTiers — 키가 있을 때만 참(빈 값 포함), 못 읽는 원문은 거짓', () => {
  assert.equal(rawHasQtyTiers(JSON.stringify([product()])), false);
  assert.equal(rawHasQtyTiers(JSON.stringify([product({ qty_tiers: null })])), true);
  assert.equal(rawHasQtyTiers('not json'), false);
  assert.equal(rawHasQtyTiers(''), false);
});

test('배선 — 단계 금액 칸은 잠긴 키, 정규화 없던 옛 경로 3곳이 단계를 검증', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'order.routes.js'), 'utf8');
  const editable = src.match(/const PRODUCT_OPTION_EDITABLE_KEYS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(editable, '열린 키 목록을 찾지 못함');
  assert.ok(!/'amount'|'qty_tiers'|'rows'|'people'|'qty'/.test(editable[1]), '단계 칸이 접수 뒤 열린 키가 되면 안 된다');
  assert.equal((src.match(/rawHasQtyTiers\(b\.product_options_json\)/g) || []).length, 3,
    '출처 계약 없는 접수·옛 수정·관리자 수정 3곳');
});
