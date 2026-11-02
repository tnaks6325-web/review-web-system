'use strict';
const assert = require('node:assert/strict');
if (process.env.EVIDENCE_BASELINE === '1') {
  const service = require('../src/services/reviewInspect.service');
  const actual = service.matchProductName('브랜드 프리미엄 보습 크림 400ml', ['브랜드 프리미엄 보습 크림 500ml']);
  console.log('BASELINE 400/500:', JSON.stringify(actual));
  assert.notEqual(actual.verdict, 'pass', 'different per-unit volume must never pass');
} else {
  const { compareReviewProduct: compare, PRODUCT_EVIDENCE_VERSION } = require('../src/utils/reviewProductEvidence');
  const cases = [];
  function check(name, observed, expected, kind, options) { cases.push({name, observed, expected, kind, options}); }
  check('volume contradiction', '브랜드 프리미엄 보습 크림 400ml', ['브랜드 프리미엄 보습 크림 500ml'], 'conflict');
  check('same volume', '크림 500ml', ['크림 500ml'], 'match');
  check('physical volume conversion', '크림 0.5L', ['크림 500ml'], 'match');
  check('physical mass conversion', '식품 1kg', ['식품 1000g'], 'match');
  check('decimal preserved', '크림 5ml', ['크림 0.5ml'], 'conflict');
  check('global quantities surround contiguous body', '2개 가상세럼500ml', ['가상세럼500ml2개'], 'match');
  check('roles reorder', '크림 2개50ml', ['크림 50ml2개'], 'match');
  check('roles swapped', '크림 2ml50개', ['크림 50ml2개'], 'conflict');
  check('total not per-unit proof', '음료 1Lx1', ['음료 500mlx2'], 'conflict');
  check('count contradiction', '마스크 10개', ['마스크 20개'], 'conflict');
  check('concentration contradiction', '세럼 5%', ['세럼 10%'], 'conflict');
  check('year contradiction', '에어컨 28년형', ['에어컨 26년형'], 'conflict');
  check('model numeric contradiction', '휴대폰 S25', ['휴대폰 S24'], 'conflict');
  check('model suffix contradiction', '기계 AB-100B', ['기계 AB-100A'], 'conflict');
  check('missing capacity expected', '크림', ['크림 500ml'], 'insufficient');
  check('missing capacity canonical', '크림 500ml', ['크림'], 'insufficient');
  check('missing count', '크림 50ml', ['크림 50ml2개'], 'insufficient');
  check('unknown bare numbers', '가전 2026', ['가전 2026'], 'insufficient');
  check('unknown reversed roles', '상품 20 10', ['상품 10 20'], 'insufficient');
  check('ambiguous nested packaging', '상품 4개', ['상품 1개4개입'], 'insufficient');
  check('count not silently deduped', '상품 2개', ['상품 2개2개'], 'insufficient');
  check('different identity same quantity', '다른 브랜드 크림 500ml', ['원래 브랜드 크림 500ml'], 'insufficient');
  check('prefix not evidence', '프리미엄 보습', ['프리미엄 보습 크림 500ml'], 'insufficient');
  check('aliases cannot promote', '다른 크림 400ml', ['원래 크림 500ml'], 'insufficient', {aliases:['다른 크림 400ml']});
  check('later canonical candidate', '크림 500ml', ['다른상품', '크림 500ml'], 'match');
  check('duplicate canonical not ambiguous', '크림 500ml', ['크림 500ml', '크림 500ml'], 'match');
  check('equivalent canonical conversion', '크림 500ml', ['크림 500ml', '크림 0.5L'], 'match');
  check('ambiguous distinct fuzzy candidates', '브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션', ['브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션가', '브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션나'], 'insufficient');
  // Without independent identity evidence a typo and a variant cannot be distinguished.
  check('unproven long OCR typo remains unknown', '브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션', ['브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션가'], 'insufficient');
  const variantPrefix = '가상브랜드 프리미엄 저자극 피부 보습 영양 탄력 수분 보호 데일리 바디 로션 건조하고 민감한 피부를 위한 집중 영양보습 대용량 패밀리 케어 ';
  check('long name cannot hide scented variant', variantPrefix + '유향500ml', [variantPrefix + '무향500ml'], 'insufficient');
  check('safe cosmetic cleanup', '[NEW] 크림 (500ml)…', ['1. 크림 500ml (https://example.invalid/product)'], 'match');
  check('truncated URL is not product evidence', '크림 500ml', ['1. 크림 500ml (https:'], 'match');
  check('explicit promotions only', '크림 500ml 168시간 보습 74% 할인', ['크림 500ml'], 'match');
  check('unlabelled hours not ignored', '크림 500ml 168시간', ['크림 500ml'], 'insufficient');
  check('percentage is dimension', '크림 5%', ['크림'], 'insufficient');
  check('structure not product', '상품', ['상품'], 'insufficient');
  check('no canonical', '상품 500ml', [], 'insufficient');
  check('no OCR', '', ['크림'], 'insufficient');
  check('leading decimal unsupported not five', '크림 .5ml', ['크림 5ml'], 'insufficient');
  check('negative quantity unsupported', '크림 -5ml', ['크림 5ml'], 'insufficient');
  check('negative box count must not match positive count', '가상제품 -2박스', ['가상제품 2박스'], 'insufficient');
  // Exhaust the existing role-parser units; this is a test fixture, not a
  // second runtime parser. These are post-fix regression/positive controls.
  const parsedUnits = ['년형', '년도', '년', '세대', 'mah', 'kg', 'mg', 'ml', 'cm', 'mm', 'g', 'l',
    '캡슐', '박스', '세트', '개입', '정', '포', '개', '매', '입', '종', '인치', '%'];
  for (const unit of parsedUnits) {
    const positive = `가상제품 2${unit}`;
    check(`unsigned role exact: ${unit}`, positive, [positive], 'match');
    check(`unsigned global role order: ${unit}`, `2${unit} 가상제품`, [positive], 'match');
    for (const sign of ['-', '+', '−', '±', '－', '＋']) {
      for (const gap of ['', ' ']) {
        const signed = `가상제품 ${sign}${gap}2${unit}`;
        check(`signed observed ${sign}${JSON.stringify(gap)} ${unit}`, signed, [positive], 'insufficient');
        check(`signed expected ${sign}${JSON.stringify(gap)} ${unit}`, positive, [signed], 'insufficient');
        check(`identical signed ${sign}${JSON.stringify(gap)} ${unit}`, signed, [signed], 'insufficient');
      }
    }
  }
  for (const [observed, expected] of [
    ['가상기계 AB-100', '가상기계 AB100'],
    ['가상기계 AB-CD-100ML', '가상기계 ABCD100ML'],
    ['가상기계 AB-100-A', '가상기계 AB100A'],
    ['가상크림 0.5L2개', '2개 가상크림500ml'],
    ['가상크림 50mlx2', '가상크림 2개50ml'],
    ['가상식품 1kg', '가상식품1000g'],
  ]) {
    check('signed syntax fix preserves positive: ' + observed, observed, [expected], 'match');
  }
  check('one multiplier cannot associate two sizes', '크림 50ml100mlx2', ['크림 100ml50mlx2'], 'insufficient');
  // Repeated roles lose component binding, so even equal multisets are not proof.
  for (const [role, expected, observed] of [
    ['mixed physical', '세트 토너50ml 로션100g', '세트 토너100g 로션50ml'],
    ['mixed count', '세트 토너50ml 로션2개', '세트 토너2개 로션50ml'],
    ['mixed model', '세트 토너AB100 로션50ml', '세트 토너50ml 로션AB100'],
    ['mixed year', '세트 토너26년형 로션50ml', '세트 토너50ml 로션26년형'],
    ['mixed concentration', '세트 토너5% 로션50ml', '세트 토너50ml 로션5%'],
    ['volume', '세트 토너50ml 로션100ml', '세트 토너100ml 로션50ml'],
    ['mass', '세트 토너50g 로션100g', '세트 토너100g 로션50g'],
    ['concentration', '세트 토너5% 로션10%', '세트 토너10% 로션5%'],
    ['year', '세트 본체26년형 부품28년형', '세트 본체28년형 부품26년형'],
    ['model', '세트 본체AB100 부품AB200', '세트 본체AB200 부품AB100'],
  ]) {
    check('component binding unknown: ' + role, observed, [expected], 'insufficient');
    check('identical repeated role still unbound: ' + role, expected, [expected], 'insufficient');
  }
  for (const [role, expected, observed] of [
    ['volume', '세트 토너50ml 로션', '세트 토너 로션50ml'],
    ['count', '세트 토너2개 로션', '세트 토너 로션2개'],
    ['model', '세트 본체AB100 부품', '세트 본체 부품AB100'],
    ['year', '세트 본체26년형 부품', '세트 본체 부품26년형'],
    ['concentration', '세트 토너5% 로션', '세트 토너 로션5%'],
  ]) {
    check('single-axis ownership forward: ' + role, observed, [expected], 'insufficient');
    check('single-axis ownership reverse: ' + role, expected, [observed], 'insufficient');
    check('exact interleaved single-axis remains unbound: ' + role, expected, [expected], 'insufficient');
  }
  for (const [expected, observed] of [
    ['가상세럼500ml2개', '2개 가상세럼0.5L'],
    ['가상크림50ml', '50ml 가상크림'],
    ['가상마스크2개', '2개 가상마스크'],
    ['가상기계AB100', 'AB100 가상기계'],
    ['가상기계26년형', '26년형 가상기계'],
    ['가상세럼5%', '5% 가상세럼'],
    ['1. 가상크림 500ml (https://example.invalid/product)', '[NEW] 가상크림 (0.5L)…'],
  ]) {
    check('contiguous global roles forward: ' + expected, observed, [expected], 'match');
    check('contiguous global roles reverse: ' + expected, expected, [observed], 'match');
  }
  check('multiplicity unbound remains unknown', '크림 50ml', ['크림 50ml50ml'], 'insufficient');
  check('unit dimensions not interchangeable', '크림 5g', ['크림 5ml'], 'insufficient');
  check('model suffix missing not a match', '기계 AB-100', ['기계 AB-100A'], 'conflict');
  check('model exact', '기계 AB100A', ['기계 AB-100A'], 'match');
  check('nested packaging identical still unknown', '상품 1개4개입', ['상품 1개4개입'], 'insufficient');
  check('bare year reversed unknown', '가전 28 26', ['가전 26 28'], 'insufficient');
  check('count unknown identical', '상품 2', ['상품 2'], 'insufficient');
  check('wrong number despite very high similarity', '브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션 400ml', ['브랜드초장문보습크림민감성피부진정수분장벽보호데일리로션 500ml'], 'conflict');
  check('precise decimal never rounded away', '크림 500.0000000000001ml', ['크림 500ml'], 'conflict');
  check('large integer never rounded away', '식품 9007199254740993mg', ['식품 9007199254740992mg'], 'conflict');
  check('fraction conversion exact', '식품 0.0005kg', ['식품 500mg'], 'match');
  check('zero count not evidence', '크림 50mlx0', ['크림 50mlx0'], 'insufficient');
  check('unit-looking model suffix not converted', '기계 AB-100ml', ['기계 AB-0.1L'], 'insufficient');
  check('fractional count not evidence', '크림 50ml2.5개', ['크림 50ml2.5개'], 'insufficient');
  check('unit-looking model must not be converted into volume', '기계 AB100ml', ['기계 AB0.1L'], 'insufficient');
  check('whole unit-looking model token difference', '기계 AB100ml', ['기계 AB200ml'], 'conflict');
  check('model multiplication-looking suffix stays model', '기계 AB500mlx2', ['기계 AB0.5Lx2'], 'insufficient');
  check('hyphenated unit-looking exact model', '기계 AB-100ml', ['기계 AB100ml'], 'match');
  cases.push({name: 'missing reasons', run() {
    assert.equal(compare('크림', []).reason, 'no_expected');
    assert.equal(compare('', ['크림']).reason, 'no_ocr');
    assert.equal(compare('크림', ['상품', '최종모집인원 30명']).reason, 'no_expected');
  }});
  cases.push({name: 'signature preserves raw decimals and whole canonical set', run() {
    const a = compare('크림 0.5ml', ['크림 0.5ml', '다른 크림']);
    assert.notEqual(a.signature, compare('크림 5ml', ['크림 0.5ml', '다른 크림']).signature);
    assert.notEqual(a.signature, compare('크림 0.5ml', ['크림 0.5ml']).signature);
    assert.equal(a.signature, compare('크림 0.5ml', ['다른 크림', '크림 0.5ml']).signature);
  }});
  cases.push({name: 'inputs never mutated', run() {
    const expected = Object.freeze(['크림 50ml2개']);
    const options = Object.freeze({aliases:Object.freeze(['크림'])});
    assert.equal(compare('크림 2개50ml', expected, options).kind, 'match');
    assert.deepEqual(expected, ['크림 50ml2개']);
  }});
  cases.push({name: 'semantic proof separates normalization from raw source', run() {
    const a = compare('크림 50ml 2개', ['크림 50ml 2개']);
    const b = compare('크림 2개 0.05L', ['크림 50ml 2개']);
    assert.equal(typeof a.semanticSignature, 'string');
    assert.equal(a.semanticSignature, b.semanticSignature, 'role order and physical conversion preserve semantic proof');
    assert.notEqual(a.signature, b.signature, 'raw proof still detects changed source text');
    assert.equal(b.score, 1, 'identity Dice is measured on the normalized substantive product name');
    assert.ok(b.rawScore < 1, 'raw character similarity remains an honest separate diagnostic');
    assert.notEqual(a.semanticSignature, compare('크림 5ml 2개', ['크림 50ml 2개']).semanticSignature);
  }});
  cases.push({name: 'VM dependency-free actual execution', run() {
    const fs = require('node:fs'), vm = require('node:vm');
    const sandbox = {module: {exports:{}}, require() { throw Error('pure utility must not import'); }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/utils/reviewProductEvidence'), 'utf8'), sandbox);
    assert.equal(sandbox.module.exports.compareReviewProduct('크림 2개50ml', ['크림 50ml2개']).kind, 'match');
  }});
  let failed = 0;
  for (const t of cases) {
    try {
      if (t.run) t.run();
      else {
        const r = compare(t.observed, t.expected, t.options);
        assert.equal(r.kind, t.kind);
        assert.equal(r.version, 'review-product-evidence-v2');
        assert.equal(PRODUCT_EVIDENCE_VERSION, r.version);
        assert.doesNotThrow(() => JSON.stringify(r));
        assert.ok(Number.isFinite(r.score) && r.score >= 0 && r.score <= 1);
        assert.ok(Number.isFinite(r.lengthRatio) && r.lengthRatio >= 0 && r.lengthRatio <= 1);
      }
      console.log('PASS', t.name);
    }
    catch (e) { failed++; console.error('FAIL', t.name, e.message); }
  }
  console.log(`${cases.length - failed}/${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
