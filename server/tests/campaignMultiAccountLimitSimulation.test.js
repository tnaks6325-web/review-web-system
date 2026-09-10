/**
 * 공고별 타계정 하루 한도 가상 시뮬레이션.
 * 운영 DB 대신 메모리 상태를 만들고 실제 집계 헬퍼를 호출한다.
 */
const assert = require('assert');
const { countCampaignSubDailyUsage } = require('../src/services/campaignHold.service');

const now = Date.parse('2026-09-10T03:00:00.000Z'); // 2026-09-10 12:00 KST
const todayStart = '2026-09-09T15:00:00.000Z';
const yesterdayStart = '2026-09-08T15:00:00.000Z';
const rows = [];

const isoMs = (value) => value ? Date.parse(value) : NaN;
const fakeDb = {
  async query(_sql, [campaignId, ownerPhone8, dayStartIso]) {
    const dayStartMs = isoMs(dayStartIso);
    const count = rows.filter((row) => {
      if (row.campaignId !== campaignId || row.ownerPhone8 !== ownerPhone8 || row.phone8 === ownerPhone8) return false;
      if (row.status === 'applied') return isoMs(row.expiresAt) > now;
      if (row.status === 'blog_pending') return isoMs(row.appliedAt) >= dayStartMs;
      if (row.status === 'submitted') return isoMs(row.submittedAt) >= dayStartMs;
      return false;
    }).length;
    return { rows: [{ n: String(count) }] };
  },
};

async function attempt({ campaignId, ownerPhone8 = '11112222', phone8, limit, status = 'applied', dayStartIso = todayStart }) {
  const used = limit > 0
    ? await countCampaignSubDailyUsage(fakeDb, { campaignId, ownerPhone8, dayStartIso })
    : 0;
  if (limit > 0 && used >= limit) return { allowed: false, used, limit };
  rows.push({
    campaignId, ownerPhone8, phone8, status,
    appliedAt: new Date(now).toISOString(),
    expiresAt: status === 'applied' ? new Date(now + 15 * 60_000).toISOString() : null,
    submittedAt: status === 'submitted' ? new Date(now).toISOString() : null,
  });
  const reread = limit > 0
    ? await countCampaignSubDailyUsage(fakeDb, { campaignId, ownerPhone8, dayStartIso })
    : rows.filter((row) => row.campaignId === campaignId && row.ownerPhone8 === ownerPhone8).length;
  return { allowed: true, used: reread, limit };
}

function step(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label);
  console.log(`  ✓ ${label}: ${JSON.stringify(actual)}`);
}

(async () => {
  const firstA = await attempt({ campaignId: 'camp-a', phone8: '20000001', limit: 1 });
  step('한도 1 공고의 첫 타계정은 허용되고 즉시 1개 예약', firstA, { allowed: true, used: 1, limit: 1 });

  const secondA = await attempt({ campaignId: 'camp-a', phone8: '20000002', limit: 1 });
  step('제출 전이어도 같은 공고의 두 번째 타계정은 차단', secondA, { allowed: false, used: 1, limit: 1 });

  const firstB = await attempt({ campaignId: 'camp-b', phone8: '30000001', limit: 2 });
  const secondB = await attempt({ campaignId: 'camp-b', phone8: '30000002', limit: 2 });
  const thirdB = await attempt({ campaignId: 'camp-b', phone8: '30000003', limit: 2 });
  step('다른 공고는 자체 한도 2를 독립 적용',
    [firstB.allowed, secondB.allowed, thirdB.allowed, thirdB.used], [true, true, false, 2]);

  const aHold = rows.find((row) => row.campaignId === 'camp-a' && row.status === 'applied');
  aHold.expiresAt = new Date(now - 1).toISOString();
  const afterExpiry = await attempt({ campaignId: 'camp-a', phone8: '20000002', limit: 1 });
  step('만료된 자리는 반환되어 다른 타계정이 참여', afterExpiry, { allowed: true, used: 1, limit: 1 });

  const activeA = rows.find((row) => row.campaignId === 'camp-a' && row.phone8 === '20000002');
  activeA.status = 'submitted';
  activeA.submittedAt = new Date(now).toISOString();
  const afterSubmit = await attempt({ campaignId: 'camp-a', phone8: '20000003', limit: 1 });
  step('제출완료 뒤에도 당일 한도는 유지', afterSubmit, { allowed: false, used: 1, limit: 1 });

  activeA.status = 'cancelled';
  const afterCancel = await attempt({ campaignId: 'camp-a', phone8: '20000003', limit: 1 });
  step('취소된 건은 한도를 반환', afterCancel, { allowed: true, used: 1, limit: 1 });

  const pending = await attempt({ campaignId: 'camp-blog', phone8: '40000001', limit: 1, status: 'blog_pending' });
  const pendingBlocked = await attempt({ campaignId: 'camp-blog', phone8: '40000002', limit: 1, status: 'blog_pending' });
  step('블로그 승인 대기도 당일 한도를 예약',
    [pending.allowed, pendingBlocked.allowed, pendingBlocked.used], [true, false, 1]);
  rows.find((row) => row.campaignId === 'camp-blog').status = 'blog_rejected';
  const afterReject = await attempt({ campaignId: 'camp-blog', phone8: '40000002', limit: 1, status: 'blog_pending' });
  step('블로그 반려 뒤에는 다른 타계정이 참여', afterReject, { allowed: true, used: 1, limit: 1 });

  const unlimited = [];
  for (let i = 1; i <= 3; i += 1) {
    unlimited.push((await attempt({ campaignId: 'camp-unlimited', phone8: `5000000${i}`, limit: 0 })).allowed);
  }
  step('한도 0 공고는 타계정 하루 수량을 제한하지 않음', unlimited, [true, true, true]);

  rows.push({
    campaignId: 'camp-new-day', ownerPhone8: '11112222', phone8: '60000001', status: 'submitted',
    appliedAt: new Date(isoMs(yesterdayStart) + 60_000).toISOString(), expiresAt: null,
    submittedAt: new Date(isoMs(yesterdayStart) + 60_000).toISOString(),
  });
  const newDay = await attempt({ campaignId: 'camp-new-day', phone8: '60000002', limit: 1, dayStartIso: todayStart });
  step('전날 제출 건은 오늘 한도에 포함하지 않음', newDay, { allowed: true, used: 1, limit: 1 });

  // 사용자 지정 시나리오: 한도 3계정, 등록 타계정 5개.
  const fiveSubs = ['70000001', '70000002', '70000003', '70000004', '70000005'];
  const fiveAttempts = [];
  for (const phone8 of fiveSubs) {
    fiveAttempts.push(await attempt({ campaignId: 'camp-limit-3', phone8, limit: 3 }));
  }
  step('한도 3·타계정 5개: 앞의 3개만 허용되고 4·5번째는 차단',
    fiveAttempts.map((result) => result.allowed), [true, true, true, false, false]);
  const limitThreeUsage = await countCampaignSubDailyUsage(fakeDb, {
    campaignId: 'camp-limit-3', ownerPhone8: '11112222', dayStartIso: todayStart,
  });
  step('한도 3·타계정 5개: 차단 뒤 실제 사용량은 3으로 유지', limitThreeUsage, 3);

  rows.find((row) => row.campaignId === 'camp-limit-3' && row.phone8 === fiveSubs[0]).expiresAt = new Date(now - 1).toISOString();
  const fourthAfterExpiry = await attempt({ campaignId: 'camp-limit-3', phone8: fiveSubs[3], limit: 3 });
  const fifthStillBlocked = await attempt({ campaignId: 'camp-limit-3', phone8: fiveSubs[4], limit: 3 });
  step('한도 3·타계정 5개: 1건 만료 후 4번째는 허용되고 5번째는 계속 차단',
    [fourthAfterExpiry.allowed, fourthAfterExpiry.used, fifthStillBlocked.allowed, fifthStillBlocked.used],
    [true, 3, false, 3]);

  console.log('\n✅ campaignMultiAccountLimitSimulation: 13개 시나리오 통과');
})().catch((error) => {
  console.error('❌ campaignMultiAccountLimitSimulation:', error.stack || error.message);
  process.exit(1);
});
