const assert = require('assert');
const { validateOptionReviewTypeMix } = require('../src/utils/reviewTypeMix');

let passed = 0;
function ok(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

ok('옵션별 포토 10·텍스트 10 / 각 20명 조합을 허용한다', () => {
  const error = validateOptionReviewTypeMix('mixed', [
    { optKey: 'A옵션', recruitTotal: 20, reviewTypeMix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] },
    { optKey: 'B옵션', recruitTotal: 20, reviewTypeMix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 10 }] },
  ]);
  assert.strictEqual(error, null);
});

ok('옵션별 조합이 옵션 인원과 다르면 해당 옵션을 알려준다', () => {
  const error = validateOptionReviewTypeMix('mixed', [
    { optKey: 'A옵션', recruitTotal: 20, reviewTypeMix: [{ type: 'photo', quantity: 10 }, { type: 'text', quantity: 8 }] },
  ]);
  assert.match(error, /A옵션/);
  assert.match(error, /합계/);
});

ok('혼합 리뷰 옵션은 두 가지 이상 리뷰방식을 요구한다', () => {
  const error = validateOptionReviewTypeMix('mixed', [
    { optKey: 'A옵션', recruitTotal: 20, reviewTypeMix: [{ type: 'photo', quantity: 20 }] },
  ]);
  assert.match(error, /두 가지/);
});

console.log(`\n✅ optionReviewTypeMix: ${passed}개 통과`);
