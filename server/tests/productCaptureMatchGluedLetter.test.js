'use strict';
/**
 * productCaptureMatchGluedLetter.test.js — 결정 234 (사용자 확정 2026-10-13)
 * 한 상품에만 있는 영문 구분 글자(F·S·XL)는 한글·숫자에 붙어 있어도 그 상품 — 앞뒤에 다른 영문이 붙으면 안 걸린다.
 * 같은 글자가 여러 상품에 있으면 다른 구별 낱말로 가리고, 없으면 모름(관리자 확인).
 */
const assert = require('assert');
const { matchOption } = require('../src/utils/productCaptureMatch');
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const SOY = ['풍성한 진간장 F 13L x 1통', '풍성한 진간장 13L x 1통', '풍성한 진간장 S 13L x 1통'].map(k => ({ opt_key: k, product_name: k }));
const m = (name, opt = '') => matchOption(`${name} ${opt}`.trim(), SOY, { shortText: opt });

ok('간장 운영 캡처 7건(실측 판독 글자) 모두 F', () => {
  for (const [n, o] of [['풍성한 진간장 F1개, 13L', ''], ['풍성한 진간장F, 1개, 13L', ''], ['풍성한 진간장 F, 1개, 13L', ''],
    ['풍성한 진간장 F', '1개, 13L'], ['풍성한 진간장 F, 1개, 13L', '1개, 13L']]) assert.equal(m(n, o), SOY[0].opt_key, n);
});
ok('S 도 같은 규칙 · 구분 글자 없음(기본 상품)은 모름 — 없다는 것으로 추측하지 않는다', () => {
  assert.equal(m('풍성한 진간장 S 13L'), SOY[2].opt_key);
  assert.equal(m('풍성한 진간장 13L, 1개'), '');
});
ok('앞뒤에 다른 영문이 붙은 글자는 안 걸린다(Fresh 의 F · XL 의 L · polo 의 l)', () => {
  assert.equal(m('풍성한 진간장 Fresh 13L'), '');
  const sz = ['티셔츠 S', '티셔츠 M', '티셔츠 L', '티셔츠 XL'].map(k => ({ opt_key: k, product_name: '티셔츠' }));
  assert.equal(matchOption('티셔츠 XL사이즈', sz, { shortText: '' }), '티셔츠 XL');
  assert.equal(matchOption('티셔츠 L사이즈', sz, { shortText: '' }), '티셔츠 L');
  assert.equal(matchOption('polo 티셔츠', sz, { shortText: '' }), '');
});
ok('같은 글자가 여러 상품에 있으면 다른 구별 낱말로 · 그것도 없으면 모름(관리자 확인)', () => {
  const shared = ['진간장 F 13L', '진간장 F 500ml', '진간장 13L'].map(k => ({ opt_key: k, product_name: k }));
  assert.equal(matchOption('진간장F 500ml', shared, { shortText: '' }), '진간장 F 500ml');
  assert.equal(matchOption('진간장F', shared, { shortText: '' }), '');
});
ok('숫자·한글 약한 이름은 종전 규칙(모델번호 100 · 킹사이즈 의 킹)', () => {
  const ks = ['KS-100 블랙', '100'].map(k => ({ opt_key: k, product_name: k }));
  assert.notEqual(matchOption('KS-100 화이트', [{ opt_key: '100', product_name: '100' }, { opt_key: '200', product_name: '200' }], { shortText: '화이트' }), '100');
  const bed = ['퀸', '킹'].map(k => ({ opt_key: k, product_name: k }));
  assert.equal(matchOption('킹사이즈 침대', bed, { shortText: '' }), '');
  void ks;
});
console.log(`\n✅ productCaptureMatchGluedLetter: ${passed} passed`);
