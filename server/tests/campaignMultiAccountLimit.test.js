/**
 * 공고별 타계정 하루 한도 사용량 회귀 테스트.
 * 한도는 제출 뒤가 아니라 자리 신청 시점부터 예약되어야 한다.
 */
const assert = require('assert');
const { countCampaignSubDailyUsage } = require('../src/services/campaignSubAccountLimit.service');

(async () => {
  let captured = null;
  const q = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ n: '2' }] };
    },
  };

  const used = await countCampaignSubDailyUsage(q, {
    campaignId: 'camp-a',
    ownerPhone8: '12345678',
    dayStartIso: '2026-09-09T15:00:00.000Z',
  });

  assert.strictEqual(used, 2, 'DB COUNT 결과를 숫자로 반환해야 한다');
  assert.deepStrictEqual(captured.params, ['camp-a', '12345678', '2026-09-09T15:00:00.000Z'],
    '공고·소유자·KST 당일 경계로 범위를 고정해야 한다');
  assert.match(captured.sql, /campaign_id = \$1 AND owner_phone8 = \$2 AND phone8 <> owner_phone8/,
    '다른 공고나 다른 본계정의 타계정 사용량이 섞이면 안 된다');
  assert.match(captured.sql, /status = 'applied' AND expires_at > NOW\(\)/,
    '유효한 타계정 홀드는 즉시 한도를 예약해야 한다');
  assert.match(captured.sql, /status = 'blog_pending' AND applied_at >= \$3/,
    '당일 블로그 승인 대기도 한도를 예약해야 한다');
  assert.match(captured.sql, /status = 'submitted' AND submitted_at >= \$3/,
    '당일 제출완료 건은 계속 한도를 차지해야 한다');

  const empty = await countCampaignSubDailyUsage({ query: async () => ({ rows: [] }) }, {
    campaignId: 'camp-b', ownerPhone8: '87654321', dayStartIso: '2026-09-09T15:00:00.000Z',
  });
  assert.strictEqual(empty, 0, '집계 행이 없으면 사용량 0으로 처리해야 한다');

  console.log('✅ campaignMultiAccountLimit: 7개 통과');
})().catch((error) => {
  console.error('❌ campaignMultiAccountLimit:', error.stack || error.message);
  process.exit(1);
});
