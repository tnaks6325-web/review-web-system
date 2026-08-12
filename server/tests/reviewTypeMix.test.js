const assert = require('assert');
const { normalizeReviewTypeMix, validateReviewTypeMix } = require('../src/utils/reviewTypeMix');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

ok('동일 유형은 합산하고 0명 행은 저장하지 않는다', () => {
  const result = normalizeReviewTypeMix([
    { type: 'photo', quantity: 3 }, { type: 'text', quantity: 12 }, { type: 'photo', quantity: 2 }, { type: 'star', quantity: 0 },
  ]);
  assert.deepStrictEqual(result, {
    provided: true,
    mix: [{ type: 'photo', quantity: 5 }, { type: 'text', quantity: 12 }],
    error: null,
  });
});

ok('알 수 없는 유형·소수·음수는 거부한다', () => {
  for (const raw of [[{ type: 'unknown', quantity: 1 }], [{ type: 'photo', quantity: 1.5 }], [{ type: 'photo', quantity: -1 }]]) {
    assert.ok(normalizeReviewTypeMix(raw).error);
  }
});

ok('혼합은 총인원과 정확히 같고 두 유형 이상이어야 한다', () => {
  const good = normalizeReviewTypeMix([{ type: 'photo', quantity: 5 }, { type: 'text', quantity: 10 }]);
  assert.strictEqual(validateReviewTypeMix('mixed', good, 15, { requireWhenMixed: true }), null);
  assert.match(validateReviewTypeMix('mixed', good, 14, { requireWhenMixed: true }), /합계/);
  const one = normalizeReviewTypeMix([{ type: 'photo', quantity: 15 }]);
  assert.match(validateReviewTypeMix('mixed', one, 15, { requireWhenMixed: true }), /두 가지/);
});

ok('단일 타입으로 바꾸면 혼합 입력은 요구하지 않는다', () => {
  assert.strictEqual(validateReviewTypeMix('photo', normalizeReviewTypeMix(undefined), 15), null);
});

ok('신규 혼합 공고는 조합을 생략할 수 없다', () => {
  assert.match(validateReviewTypeMix('mixed', normalizeReviewTypeMix(undefined), 15, { requireWhenMixed: true }), /유형별 수량/);
});

console.log(`\n✅ reviewTypeMix: ${passed}개 통과`);
