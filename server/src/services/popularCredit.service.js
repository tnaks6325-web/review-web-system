const POPULAR_CREDIT_VALIDITY_DAYS = 3;
const POPULAR_CREDIT_VALIDITY_MS = POPULAR_CREDIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

function _time(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * 최근 72시간 안의 일반 제출완료를 시간순으로 인기 참여와 1:1 매칭한다.
 * 인기 참여 당시 유효했던 가장 오래된 미사용 참여권부터 소진한다. 이렇게 해야
 * 과거 인기 참여가 오늘 새로 생긴 참여권을 차감하거나, 만료된 참여권의 사용 이력이
 * 더 최신 참여권으로 옮겨 붙는 일을 막을 수 있다.
 */
function calculatePopularCreditState(events, evaluatedAt = new Date()) {
  const evaluatedAtMs = _time(evaluatedAt);
  if (evaluatedAtMs === null) throw new TypeError('evaluatedAt must be a valid date');

  const ordered = (Array.isArray(events) ? events : [])
    .map((event) => ({ ...event, eventAtMs: _time(event.event_at) }))
    .filter((event) => event.eventAtMs !== null && event.eventAtMs <= evaluatedAtMs)
    .sort((a, b) => a.eventAtMs - b.eventAtMs || Number(a.id || 0) - Number(b.id || 0));

  const normalCredits = [];
  for (const event of ordered) {
    if (event.event_type === 'normal') {
      normalCredits.push({
        id: event.id,
        submittedAtMs: event.eventAtMs,
        expiresAtMs: event.eventAtMs + POPULAR_CREDIT_VALIDITY_MS,
        used: false,
      });
      continue;
    }
    if (event.event_type !== 'popular') continue;

    const credit = normalCredits.find((candidate) =>
      !candidate.used && candidate.submittedAtMs <= event.eventAtMs && candidate.expiresAtMs >= event.eventAtMs);
    if (credit) credit.used = true;
  }

  const current = normalCredits.filter((credit) => credit.expiresAtMs >= evaluatedAtMs);
  const normalDone = current.length;
  const popularUsed = current.filter((credit) => credit.used).length;
  return {
    normalDone,
    popularUsed,
    credits: Math.max(0, normalDone - popularUsed),
    validityDays: POPULAR_CREDIT_VALIDITY_DAYS,
  };
}

async function loadPopularCreditState(db, reviewerPhone8, { evaluatedAt = new Date() } = {}) {
  const evaluatedAtMs = _time(evaluatedAt);
  if (evaluatedAtMs === null) throw new TypeError('evaluatedAt must be a valid date');
  const evaluatedAtDate = new Date(evaluatedAtMs);
  const { rows } = await db.query(
    `SELECT ca.id,
            CASE WHEN COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE THEN 'popular' ELSE 'normal' END AS event_type,
            CASE WHEN COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE
                 THEN COALESCE(ca.applied_at, ca.submitted_at) ELSE ca.submitted_at END AS event_at
       FROM campaign_applications ca
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
      WHERE ca.phone8 = $1
        AND rc.participation_mode IS TRUE
        AND (
          (COALESCE(ca.is_popular_snapshot, rc.is_popular) IS NOT TRUE
            AND ca.status = 'submitted'
            AND ca.submitted_at <= $2)
          OR
          (COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE
            AND (ca.status = 'submitted' OR ca.status = 'blog_pending'
              OR (ca.status = 'applied' AND ca.expires_at > $2))
            AND COALESCE(ca.applied_at, ca.submitted_at) <= $2)
        )
      ORDER BY event_at, ca.id`,
    [reviewerPhone8, evaluatedAtDate]);
  return calculatePopularCreditState(rows, evaluatedAtDate);
}

function canUsePopularCredit(state) {
  return Number(state && state.credits) >= 1;
}

module.exports = {
  POPULAR_CREDIT_VALIDITY_DAYS,
  calculatePopularCreditState,
  loadPopularCreditState,
  canUsePopularCredit,
};
