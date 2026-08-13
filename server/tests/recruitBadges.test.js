const assert = require('assert');
const { normalizeRecruitBadges } = require('../src/utils/recruitBadges');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

ok('현영건은 현금영수증 설정일 때만 자동 적용된다', () => {
  assert.deepStrictEqual(normalizeRecruitBadges(['현영건', '텍스트 제공'], { cashReceiptRequired: false }), ['텍스트 제공']);
  assert.deepStrictEqual(normalizeRecruitBadges(['텍스트 제공'], { cashReceiptRequired: true }), ['텍스트 제공', '현영건']);
});

ok('로켓와우는 쿠팡 채널일 때만 적용된다', () => {
  assert.ok(normalizeRecruitBadges([], { channel: '쿠팡' }).includes('로켓와우'));
  assert.ok(!normalizeRecruitBadges(['로켓와우'], { channel: '네이버' }).includes('로켓와우'));
});

ok('포토 리뷰 선택만으로 사진 5장+ 배지를 자동 적용하지 않는다', () => {
  assert.deepStrictEqual(normalizeRecruitBadges([], { reviewType: 'photo' }), []);
  assert.deepStrictEqual(normalizeRecruitBadges([], {
    reviewType: 'mixed', reviewTypeMix: [{ type: 'photo', quantity: 10 }, { type: 'confirm', quantity: 5 }],
  }), ['구매확정']);
});

ok('사진 5장+을 포함한 이전 자동·폐기 배지는 수동 저장값에서 제거된다', () => {
  assert.deepStrictEqual(normalizeRecruitBadges(['와우 필수', '포토리뷰', '사진 5장+', '3.3% 공제'], {}), ['3.3% 공제']);
});

console.log(`\n✅ recruitBadges: ${passed}개 통과`);
