/**
 * 공고별 타계정 하루 한도 사용량.
 * 자리를 잡은 순간 한도를 예약해야 `하루 1계정`에서 여러 타계정 홀드를 먼저 만든 뒤
 * 한꺼번에 제출하는 우회가 생기지 않는다. 만료·취소·반려는 다시 사용할 수 있고,
 * 블로그 승인 대기는 당일 신청분만 예약한다.
 */
async function countCampaignSubDailyUsage(q, { campaignId, ownerPhone8, dayStartIso }) {
  const { rows } = await q.query(
    `SELECT COUNT(*) AS n FROM campaign_applications
      WHERE campaign_id = $1 AND owner_phone8 = $2 AND phone8 <> owner_phone8
        AND (
          (status = 'applied' AND expires_at > NOW())
          OR (status = 'blog_pending' AND applied_at >= $3)
          OR (status = 'submitted' AND submitted_at >= $3)
        )`,
    [campaignId, ownerPhone8, dayStartIso]
  );
  return Number(rows[0] && rows[0].n) || 0;
}

module.exports = { countCampaignSubDailyUsage };
