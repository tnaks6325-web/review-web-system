async function loadPopularCreditState(db, reviewerPhone8) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(ca.is_popular_snapshot, rc.is_popular) IS NOT TRUE AND ca.status = 'submitted') AS normal_done,
       COUNT(*) FILTER (WHERE COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE AND (ca.status = 'submitted' OR (ca.status = 'applied' AND ca.expires_at > NOW()))) AS popular_used
     FROM campaign_applications ca
     JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
    WHERE ca.phone8 = $1 AND rc.participation_mode`, [reviewerPhone8]);
  const normalDone = Number(rows[0].normal_done) || 0;
  const popularUsed = Number(rows[0].popular_used) || 0;
  return { normalDone, popularUsed, credits: Math.max(0, normalDone - popularUsed) };
}

function canUsePopularCredit(state) {
  return Number(state && state.credits) >= 1;
}

module.exports = { loadPopularCreditState, canUsePopularCredit };
