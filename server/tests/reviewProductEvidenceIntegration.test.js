'use strict';
const assert = require('assert');
const api = require('../src/services/reviewInspect.service');

async function run() {
  api.__setPoolForTest({ query: async () => ({ rows: [{
    inspect_product_names: '가상 보습 세럼 500ml 2개',
    inspect_product_aliases: '가상 보습 세럼 100ml 1개',
    inspect_product_rules: [],
  }] }) });
  const expected = await api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
  assert.deepStrictEqual(expected.primaryProductNames, ['가상 보습 세럼 500ml 2개'],
    'canonical criteria must remain distinguishable from a historically learned conflicting alias');
  assert.deepStrictEqual(expected.productAliases, ['가상 보습 세럼 100ml 1개']);
  assert.deepStrictEqual(expected.productNames, ['가상 보습 세럼 500ml 2개', '가상 보습 세럼 100ml 1개'],
    'existing merged settings and duplicate-context consumers retain their response');
  assert.strictEqual(expected.productSource, 'manual');
  for (const kind of ['conflict', 'insufficient']) {
    const check = { verdict: kind === 'conflict' ? 'warn' : 'skip',
      expected: expected.productNames, ocr: '가상 보습 세럼 100ml 1개',
      comparison: { kind, version: 'review-product-evidence-v2', reason: 'FAKE_CURRENT_EVIDENCE',
        signature: 'FAKE_DECIMAL_PRESERVING_SIGNATURE', axes: { expected: ['500ml'], observed: ['100ml'] } },
      ...(kind === 'insufficient' ? { evidence: 'unknown' } : {}),
    };
    const scope = { sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' };
    const clusterKey = api.productClusterKey({ ...scope, expectedList: check.expected, ocr: check.ocr });
    const learned = api.applyProductRule(check,
      [{ id: 'FAKE_LEGACY_PASS', clusterKey, verdict: 'pass', active: true }], scope);
    assert.strictEqual(learned.clusterKey, clusterKey, 'historical grouping key remains compatible');
    assert.deepStrictEqual(learned.check, check,
      'a learned pass must not erase current ' + kind + ', its dimensions, signature or unknown flag');
  }
  const conflict = api.matchProductName('가상브랜드 보습 로션 400g', ['가상브랜드 보습 로션 500g']);
  assert.strictEqual(conflict.verdict, 'warn', 'clear capacity contradiction is not a normal product match');
  assert.strictEqual(conflict.comparison.kind, 'conflict');
  assert.strictEqual(conflict.comparison.version, 'review-product-evidence-v2');
  const { service, input } = require('./reviewInspectionFailureSafety.test');
  async function inspectRawWorkOrder(products, { observed = '가상 로션', manual = '', text } = {}) {
    const raw = typeof products === 'string' ? products : JSON.stringify(products);
    const summary = text === undefined
      ? require('../src/utils/orderProductSummary').productSummaryText(raw) : text;
    const inspected = service({ classify: async () => ({ kind: 'review', confidence: 0.99,
      channel: 'coupang', productName: observed,
      reviewText: '실제 고객 자료가 아닌 충분히 긴 가상 리뷰 본문으로 상품 기준과 저장 결과를 검사합니다.',
    }) });
    inspected.api.__setPoolForTest({ query: async (sql, params) => {
      if (sql.includes('FROM tab_configs c')) return { rows: [{ inspect_product_names: manual,
        inspect_product_aliases: '', inspect_product_rules: [], channel: '쿠팡',
        tab_review_type: '포토', camp_review_type: '포토' }] };
      if (sql.includes('INSERT INTO review_inspections')) {
        const row = { status: params[6], checks: JSON.parse(params[7]), updated_at: '2026-01-01 00:00:00+00' };
        inspected.saved.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('FROM work_orders')) return { rows: [{ product_options_json: raw, product_option: summary }] };
      return { rows: [], rowCount: 0 };
    } });
    const criteria = await inspected.api.loadTabExpectations(input);
    const options = { primaryExpected: criteria.primaryProductNames, canonicalSource: criteria.productSource,
      criteriaIncomplete: criteria.productCriteriaIncomplete };
    const general = inspected.api.matchProductName(observed, criteria.productNames, options);
    const strict = inspected.api.classifyProductNameForAuto(observed, criteria.primaryProductNames, options);
    const submitted = await inspected.api.inspectSubmission(input);
    return { criteria, general, strict, submitted, saved: inspected.saved };
  }
  function assertUnknownRaw(result, label) {
    const { criteria, general, strict, submitted, saved } = result;
    assert.strictEqual(criteria.productCriteriaIncomplete, true, label);
    assert.notStrictEqual(general.verdict, 'pass', label);
    assert.strictEqual(general.evidence, 'unknown', label);
    assert.strictEqual(general.comparison.kind, 'insufficient', label);
    assert.strictEqual(strict.eligible, false, label);
    assert.notStrictEqual(submitted.status, 'pass', label);
    assert.strictEqual(submitted.persisted, true, label);
    assert.strictEqual(submitted.checks.product.evidence, 'unknown', label);
    assert.strictEqual(saved.length, 1, label);
    assert.notStrictEqual(saved[0].status, 'pass', label);
    assert.strictEqual(saved[0].checks.product.evidence, 'unknown', label);
    assert.strictEqual(saved[0].checks.product.comparison.kind, 'insufficient', label);
    assert.deepStrictEqual(saved[0].checks.product.comparison,
      JSON.parse(JSON.stringify(submitted.checks.product.comparison)), 'original comparison evidence survives storage');
  }
  const rootRaw = await inspectRawWorkOrder([
    { name: '가상 로션', options: [] }, { name: '', options: [{ label: '500ml' }] },
  ]);
  console.log('RAW_CRITERIA_ROOT', JSON.stringify(rootRaw));
  assertUnknownRaw(rootRaw, 'unnamed 500ml option must survive filtering and exact official-summary exemption');
  let rawUnknownCount = 1;
  const invalidEntries = [
    { name: '', options: [{ label: '500ml' }] },
    { name: '   ', options: [{ label: '500ml' }] },
    { options: [{ label: '500ml' }] },
    { name: null, options: [{ label: '500ml' }] },
    { name: 500, options: [{ label: '500ml' }] },
    { name: {}, options: [{ label: '500ml' }] },
    ...['상품', '최종모집인원 30명', '합계최종모집인원 30명', '...', 'https://example.invalid/option']
      .map(name => ({ name, options: [{ label: '500ml' }] })),
    { name: '', options: { label: '500ml' } },
    { name: '', options: [{ option_1: { value: '500ml' } }] },
    { name: '', options: [null] },
    { name: '', options: [] },
    null, 42, '500ml', [],
    { name: '가상 로션', options: [null] },
    { name: '가상 로션', options: ['500ml'] },
    { name: '가상 로션', options: [{ label: 500 }] },
    { name: '가상 로션', options: [{ label: '' }] },
    { name: '가상 로션', options: [{ option_1: { value: '500ml' } }] },
    { name: '가상 로션', options: { label: '500ml' } },
  ];
  for (const [index, invalid] of invalidEntries.entries()) {
    for (const products of [[{ name: '가상 로션', options: [] }, invalid],
      [invalid, { name: '가상 로션', options: [] }], [invalid]]) {
      const result = await inspectRawWorkOrder(products);
      assertUnknownRaw(result, 'raw entry ' + index + ': ' + JSON.stringify(products));
      rawUnknownCount++;
    }
  }
  // Without the exact official summary the same option cannot disappear either.
  assertUnknownRaw(await inspectRawWorkOrder([
    { name: '가상 로션', options: [] }, { name: '', options: [{ label: '500ml' }] },
  ], { text: '가상 로션' }), 'unnamed option without summary exemption');
  rawUnknownCount++;
  const positiveCases = [
    [[{ name: '가상 로션', options: [], base: { pay: 20000, count: 5 } }], {}],
    [[{ name: '가상 로션' }], {}],
    [[{ name: '가상 로션', options: [{ label: '기본', pay: 20000, count: 5 }] }], {}],
    [[{ name: '가상 로션 500ml', options: [{ label: '500ml' }] }], { observed: '가상 로션 500ml' }],
    [[{ name: '가상 로션 0.5L', options: [{ label: '500ml' }] }], { observed: '가상 로션 500ml' }],
    [[], { text: '가상 로션' }],
    [[{ name: '', options: [{ label: '500ml' }] }], { manual: '가상 로션' }],
  ];
  for (const [products, options] of positiveCases) {
    const { criteria, general, strict, submitted, saved } = await inspectRawWorkOrder(products, options);
    assert.strictEqual(criteria.productCriteriaIncomplete, false, JSON.stringify(products));
    assert.strictEqual(general.verdict, 'pass');
    assert.strictEqual(strict.eligible, true);
    assert.strictEqual(submitted.status, 'pass');
    assert.strictEqual(submitted.persisted, true);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].status, 'pass');
    if (options.manual) assert.strictEqual(criteria.productSource, 'manual');
  }
  console.log('RAW_CRITERIA_COUNTS', JSON.stringify({ unknown: rawUnknownCount, positive: positiveCases.length }));
  // One ownership slice spans comparison, automatic eligibility and actual
  // inspectSubmission -> INSERT/RETURNING. Collect every case before failing
  // so RED demonstrates the persisted failure as well as the pure verdict.
  const ownershipFailures = [];
  for (const [role, left, right] of [
    ['volume', '세트 토너50ml 로션', '세트 토너 로션50ml'],
    ['count', '세트 토너2개 로션', '세트 토너 로션2개'],
    ['model', '세트 본체AB100 부품', '세트 본체 부품AB100'],
    ['year', '세트 본체26년형 부품', '세트 본체 부품26년형'],
    ['concentration', '세트 토너5% 로션', '세트 토너 로션5%'],
  ]) {
    for (const [expected, observed] of [[left, right], [right, left], [left, left]]) {
      const general = api.matchProductName(observed, [expected]);
      const strict = api.classifyProductNameForAuto(observed, [expected]);
      const inspectedOwnership = service({ criteria: { inspect_product_names: expected },
        classify: async () => ({ kind: 'review', confidence: 0.99, channel: 'coupang',
          productName: observed,
          reviewText: '실제 고객 자료가 아닌 충분히 긴 가상 리뷰 본문으로 구성품 소속과 저장 결과를 검사합니다.',
        }) });
      const submittedOwnership = await inspectedOwnership.api.inspectSubmission(input);
      const actual = {
        generalPass: general.verdict === 'pass', reason: general.reason,
        evidence: general.evidence, kind: general.comparison.kind, eligible: strict.eligible,
        calculatedPass: submittedOwnership.status === 'pass', persisted: submittedOwnership.persisted,
        submittedEvidence: submittedOwnership.checks.product.evidence,
        savedCount: inspectedOwnership.saved.length,
        savedPass: inspectedOwnership.saved[0].status === 'pass',
        savedEvidence: inspectedOwnership.saved[0].checks.product.evidence,
        savedKind: inspectedOwnership.saved[0].checks.product.comparison.kind,
      };
      console.log('OWNERSHIP', role, JSON.stringify({ expected, observed, actual }));
      try {
        assert.deepStrictEqual(actual, {
          generalPass: false, reason: 'ambiguous_dimensions', evidence: 'unknown',
          kind: 'insufficient', eligible: false, calculatedPass: false, persisted: true,
          submittedEvidence: 'unknown', savedCount: 1, savedPass: false,
          savedEvidence: 'unknown', savedKind: 'insufficient',
        });
      } catch (error) { ownershipFailures.push(role + ': ' + error.message); }
    }
  }
  assert.strictEqual(ownershipFailures.length, 0, ownershipFailures.join('\n'));
  for (const [left, right] of [
    ['가상세럼500ml2개', '2개 가상세럼0.5L'],
    ['가상크림50ml', '50ml 가상크림'],
    ['가상마스크2개', '2개 가상마스크'],
    ['가상기계AB100', 'AB100 가상기계'],
    ['가상기계26년형', '26년형 가상기계'],
    ['가상세럼5%', '5% 가상세럼'],
    ['1. 가상크림 500ml (https://example.invalid/product)', '[NEW] 가상크림 (0.5L)…'],
  ]) {
    for (const [expected, observed] of [[left, right], [right, left]]) {
      assert.strictEqual(api.matchProductName(observed, [expected]).verdict, 'pass',
        'one contiguous body retains global role order and clean unit equivalence');
      assert.strictEqual(api.classifyProductNameForAuto(observed, [expected]).eligible, true,
        'automatic comparison shares the same positive semantic proof');
    }
  }
  console.log('PASS contiguous global roles, unit conversions and cosmetic cleanup in both directions');
  const inspected = service({ criteria: {
    inspect_product_names: '가상브랜드 보습 로션 500ml 2개',
    inspect_product_aliases: '가상브랜드 보습 로션 400ml 2개',
  }, classify: async () => ({ kind: 'review', confidence: 0.99, channel: 'coupang',
    productName: '가상브랜드 보습 로션 400ml 2개',
    reviewText: '실제 고객 자료가 아닌 충분히 긴 가상 리뷰 본문으로 제출부터 저장까지 연결을 검사합니다.',
  }) });
  const submitted = await inspected.api.inspectSubmission(input);
  assert.notStrictEqual(submitted.status, 'pass', 'a conflicting learned alias cannot become the canonical criteria during inspection');
  assert.strictEqual(submitted.checks.product.comparison.kind, 'conflict');
  assert.strictEqual(submitted.checks.product.canonicalSource, 'manual');
  assert.strictEqual(submitted.persisted, true, 'a warning is saved without blocking submission');
  assert.strictEqual(inspected.saved[0].status, 'suspect');
  api.__setPoolForTest({ query: async sql => ({ rows: sql.includes('FROM tab_configs c')
    ? [{ inspect_product_names: '', inspect_product_aliases: '', inspect_product_rules: [] }]
    : [{ product_options_json: JSON.stringify([{ name: '가상 보습 로션', options: [{ label: '500ml 2개' }] }]),
      product_option: '' }] }) });
  const incomplete = await api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
  const missingOption = api.matchProductName('가상 보습 로션', incomplete.productNames, {
    primaryExpected: incomplete.primaryProductNames, canonicalSource: incomplete.productSource,
    criteriaIncomplete: incomplete.productCriteriaIncomplete,
  });
  assert.notStrictEqual(missingOption.verdict, 'pass',
    'an option dropped by legacy name extraction is missing evidence, not a no-option product');
  assert.strictEqual(missingOption.reason, 'incomplete_criteria');
  assert.strictEqual(missingOption.evidence, 'unknown');
  api.__setPoolForTest({ query: async sql => ({ rows: sql.includes('FROM tab_configs c')
    ? [{ inspect_product_names: '', inspect_product_aliases: '', inspect_product_rules: [] }]
    : [{ product_options_json: JSON.stringify([{ name: '가상 보습 로션', options: [] }]),
      product_option: '가상 보습 로션 - 500ml 2개 - 결제금액 20,000원' }] }) });
  const textOption = await api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
  assert.strictEqual(textOption.productCriteriaIncomplete, true,
    'a structured bare name must not silently discard the explicit free-text option');
  async function workOrderCriteria(name, options = [], text = '') {
    api.__setPoolForTest({ query: async sql => ({ rows: sql.includes('FROM tab_configs c')
      ? [{ inspect_product_names: '', inspect_product_aliases: '', inspect_product_rules: [] }]
      : [{ product_options_json: JSON.stringify([{ name, options }]), product_option: text }] }) });
    return api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
  }
  const variantPrefix = '가상브랜드 프리미엄 저자극 피부 보습 영양 탄력 수분 보호 데일리 바디 로션 건조하고 민감한 피부를 위한 집중 영양보습 대용량 패밀리 케어 ';
  const variantExpected = variantPrefix + '무향 500ml';
  const variantObserved = variantPrefix + '유향 500ml';
  const variantCriteria = await workOrderCriteria(variantExpected, [{ label: '무향' }]);
  assert.strictEqual(variantCriteria.productCriteriaIncomplete, false, 'the explicit expected variant is preserved');
  for (const [name, expected] of [[variantObserved, [variantExpected]],
    [variantObserved, variantCriteria.primaryProductNames]]) {
    const general = api.matchProductName(name, expected);
    assert.notStrictEqual(general.verdict, 'pass', 'long common identity cannot prove a changed variant');
    assert.strictEqual(general.evidence, 'unknown');
    assert.strictEqual(api.classifyProductNameForAuto(name, expected).eligible, false);
  }
  console.log('PASS long-name variant: general, automatic and structured criteria');
  for (const [expected, observed] of [
    ['세트 토너50ml 로션100g', '세트 토너100g 로션50ml'],
    ['세트 토너50ml 로션2개', '세트 토너2개 로션50ml'],
    ['세트 토너AB100 로션50ml', '세트 토너50ml 로션AB100'],
    ['세트 토너26년형 로션50ml', '세트 토너50ml 로션26년형'],
    ['세트 토너5% 로션50ml', '세트 토너50ml 로션5%'],
    ['세트 토너50ml 로션100ml', '세트 토너100ml 로션50ml'],
    ['세트 토너5% 로션10%', '세트 토너10% 로션5%'],
    ['세트 본체26년형 부품28년형', '세트 본체28년형 부품26년형'],
    ['세트 본체AB100 부품AB200', '세트 본체AB200 부품AB100'],
  ]) {
    const general = api.matchProductName(observed, [expected]);
    assert.notStrictEqual(general.verdict, 'pass', 'unbound component quantities cannot approve a swapped set');
    assert.strictEqual(general.reason, 'ambiguous_dimensions');
    assert.strictEqual(general.evidence, 'unknown');
    assert.strictEqual(api.classifyProductNameForAuto(observed, [expected]).eligible, false);
  }
  console.log('PASS component binding: general and automatic remain unknown');
  for (const label of ['...', '…', 'https://example.invalid/option', '상품', '최종모집인원 30명', '합계최종모집인원 30명']) {
    const emptyCriteria = await workOrderCriteria('가상 보습 로션', [{ label }]);
    assert.strictEqual(emptyCriteria.productCriteriaIncomplete, true,
      'cleaned-empty or heading labels are missing option evidence: ' + label);
    const general = api.matchProductName('가상 보습 로션', emptyCriteria.productNames, {
      primaryExpected: emptyCriteria.primaryProductNames,
      criteriaIncomplete: emptyCriteria.productCriteriaIncomplete,
    });
    assert.notStrictEqual(general.verdict, 'pass');
    assert.strictEqual(general.evidence, 'unknown');
    assert.strictEqual(api.classifyProductNameForAuto('가상 보습 로션', emptyCriteria.primaryProductNames,
      { criteriaIncomplete: emptyCriteria.productCriteriaIncomplete }).eligible, false);
  }
  console.log('PASS unreadable option labels: criteria, general and automatic');
  const decimalOption = await workOrderCriteria('가상 세럼 0.5ml', [{ label: '5ml' }]);
  assert.strictEqual(decimalOption.productCriteriaIncomplete, true,
    'a decimal substring is not semantic proof of the structured option');
  assert.notStrictEqual(api.matchProductName('가상 세럼 0.5ml', decimalOption.productNames, {
    primaryExpected: decimalOption.primaryProductNames, criteriaIncomplete: decimalOption.productCriteriaIncomplete,
  }).verdict, 'pass');
  for (const [name, label] of [
    ['가상 세럼 0.5ml', '0.5ml'], ['가상 세럼 0.5L', '500ml'],
    ['가상 세럼 500ml 2개', '2개 0.5L'], ['가상 무향 세럼 500ml', '무향'],
  ]) {
    assert.strictEqual((await workOrderCriteria(name, [{ label }])).productCriteriaIncomplete, false,
      'provably present option remains complete: ' + label);
  }
  for (const [name, label] of [
    ['가상 세럼 AB100ML', '100ml'], ['가상 세럼 AB100ML', 'AB100'],
    ['가상 세럼 500ml', '500ml 2개'], ['가상 레드우드 세럼', '레드'],
    ['가상 무향 세럼 500ml', '유향'], ['가상 세럼 500ml', '500ml x2'],
  ]) {
    assert.strictEqual((await workOrderCriteria(name, [{ label }])).productCriteriaIncomplete, true,
      'missing, ambiguous and model-substring options remain unknown: ' + label);
  }
  const noDelimiter = await workOrderCriteria('가상 보습 로션', [], '가상 보습 로션 500ml 2개');
  assert.strictEqual(noDelimiter.productCriteriaIncomplete, true,
    'undelimited free-text dimensions cannot be discarded in favor of a structured bare name');
  const bareOcr = api.matchProductName('가상 보습 로션', noDelimiter.productNames, {
    primaryExpected: noDelimiter.primaryProductNames, criteriaIncomplete: noDelimiter.productCriteriaIncomplete,
  });
  assert.notStrictEqual(bareOcr.verdict, 'pass');
  assert.strictEqual(bareOcr.evidence, 'unknown');
  const oldTail = await workOrderCriteria('가상 세럼 0.5ml', [], '가상 세럼 0.5ml - 5ml');
  assert.strictEqual(oldTail.productCriteriaIncomplete, true,
    'legacy hyphen tails cannot prove options through decimal substring containment');
  for (const [name, label, incomplete] of [
    ['가상 세럼 AB100ML', '100ml', true], ['가상 세럼 AB100ML', 'AB100', true],
    ['가상 세럼 AB100ML', 'AB100ML', false], ['가상 세럼 0.5L', '500ml', false],
    ['가상 레드우드 세럼', '레드', true],
  ]) {
    assert.strictEqual((await workOrderCriteria(name, [], `${name} - ${label}`)).productCriteriaIncomplete,
      incomplete, 'hyphen-tail evidence follows the same semantic contract: ' + label);
  }
  assert.strictEqual((await workOrderCriteria('가상 보습 로션', [], '가상 보습 로션 무향'))
    .productCriteriaIncomplete, true, 'undelimited meaningful option words are evidence too');
  assert.strictEqual((await workOrderCriteria('가상 보습 로션', [], '가상 보습 로션\n다른 상품'))
    .productCriteriaIncomplete, true, 'structured names do not hide additional free-text candidates');
  assert.strictEqual((await workOrderCriteria('가상 세럼', [{ label: '기본' }, { label: '500ml' }]))
    .productCriteriaIncomplete, true);
  assert.strictEqual((await workOrderCriteria('가상 세럼', { label: '500ml' }))
    .productCriteriaIncomplete, true, 'malformed options remain unknown');
  assert.deepStrictEqual(api.productNamesFromWorkOrder({
    product_options_json: JSON.stringify([{ name: '가상 보습 로션', options: [] }]),
    product_option: '가상 보습 로션 500ml 2개',
  }), ['가상 보습 로션', '가상 보습 로션 500ml 2개'], 'legacy name extraction API stays unchanged');
  const longName = '가상브랜드 순한 피부 보습 영양 탄력 수분 보호 세럼 '.repeat(4).trim();
  assert.strictEqual((await workOrderCriteria(longName, [], `${longName} 무향`)).productCriteriaIncomplete,
    true, 'high name similarity does not certify that a meaningful free-text option was preserved');
  assert.strictEqual((await workOrderCriteria('가상 세럼 500ml', [{ label: '500ml' }, { label: '500ml' }]))
    .productCriteriaIncomplete, true, 'multiple options have no per-row selection proof');
  assert.strictEqual((await workOrderCriteria('가상 세럼 0.5L', [], '가상 세럼 500ml'))
    .productCriteriaIncomplete, false, 'free-text canonical unit equivalence remains provable');
  const completeJson = JSON.stringify([{ name: '가상 보습 로션', options: [], base: { pay: 20000, count: 5 } }]);
  const completeText = require('../src/utils/orderProductSummary').productSummaryText(completeJson);
  api.__setPoolForTest({ query: async sql => ({ rows: sql.includes('FROM tab_configs c')
    ? [{ inspect_product_names: '', inspect_product_aliases: '', inspect_product_rules: [] }]
    : [{ product_options_json: completeJson, product_option: completeText }] }) });
  const complete = await api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
  assert.strictEqual(complete.productCriteriaIncomplete, false,
    'the authoritative generated summary contains recruitment and cost metadata, not hidden product options');
  const unlabeledJson = JSON.stringify([{ name: '가상 보습 로션', options: [{
    option_1: { value: '500ml 2개' }, pay: 20000, count: 5,
  }] }]);
  api.__setPoolForTest({ query: async sql => ({ rows: sql.includes('FROM tab_configs c')
    ? [{ inspect_product_names: '', inspect_product_aliases: '', inspect_product_rules: [] }]
    : [{ product_options_json: unlabeledJson,
      product_option: require('../src/utils/orderProductSummary').productSummaryText(unlabeledJson) }] }) });
  const unlabeled = await api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
  assert.strictEqual(unlabeled.productCriteriaIncomplete, true,
    'an option without a flattened label is still an option, not proof of a no-option product');
  for (const [name, label] of [['가상 세럼 150ml', '50ml'], ['가상 세럼 11개', '1개']]) {
    api.__setPoolForTest({ query: async sql => ({ rows: sql.includes('FROM tab_configs c')
      ? [{ inspect_product_names: '', inspect_product_aliases: '', inspect_product_rules: [] }]
      : [{ product_options_json: '[]', product_option: `${name} - ${label}` }] }) });
    const criteria = await api.loadTabExpectations({ sheetId: 'FAKE_SHEET', tabName: 'FAKE_TAB' });
    assert.strictEqual(criteria.productCriteriaIncomplete, true,
      'free-text-only option substrings are not semantic evidence: ' + label);
    assert.notStrictEqual(api.matchProductName(name, criteria.productNames, {
      primaryExpected: criteria.primaryProductNames, criteriaIncomplete: criteria.productCriteriaIncomplete,
    }).verdict, 'pass');
  }
  console.log('Review product evidence integration: provenance, learned-pass fence and numeric comparison passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
