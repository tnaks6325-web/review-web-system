const POPULAR_CREDIT_VALIDITY_DAYS = 3;
const POPULAR_CREDIT_VALIDITY_MS = POPULAR_CREDIT_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

function _time(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function _emptyState() {
  return { normalDone: 0, popularUsed: 0, credits: 0, validityDays: POPULAR_CREDIT_VALIDITY_DAYS };
}

/**
 * 판정 시점의 최근 72시간 이력만 시간순으로 매칭한다. 기간 밖 일반 참여권은 소급해서
 * 제외하고, 기간 안의 인기 참여는 그보다 먼저 생긴 현재 유효 참여권부터 소진한다.
 * 명의별 큐 포인터를 한 번만 전진시키므로 계산량은 조회 행 수에 비례한다.
 */
function calculatePopularCreditMatches(events, evaluatedAt = new Date()) {
  const evaluatedAtMs = _time(evaluatedAt);
  if (evaluatedAtMs === null) throw new TypeError('evaluatedAt must be a valid date');
  const cutoffMs = evaluatedAtMs - POPULAR_CREDIT_VALIDITY_MS;

  const ordered = (Array.isArray(events) ? events : [])
    .map((event) => ({ ...event, phone8: String(event.phone8 || ''), eventAtMs: _time(event.event_at) }))
    .filter((event) => event.eventAtMs !== null && event.eventAtMs >= cutoffMs && event.eventAtMs <= evaluatedAtMs)
    .sort((a, b) => a.phone8.localeCompare(b.phone8)
      || a.eventAtMs - b.eventAtMs || Number(a.id || 0) - Number(b.id || 0));

  const states = new Map();
  const queues = new Map();
  const matchedNormalIds = new Set();
  const matchedPopularIds = new Set();
  const popularEvents = [];
  for (const event of ordered) {
    if (!states.has(event.phone8)) states.set(event.phone8, _emptyState());
    if (!queues.has(event.phone8)) queues.set(event.phone8, { credits: [], next: 0 });
    const state = states.get(event.phone8);
    const queue = queues.get(event.phone8);

    if (event.event_type === 'normal') {
      queue.credits.push(event);
      state.normalDone += 1;
      continue;
    }
    if (event.event_type !== 'popular') continue;

    popularEvents.push(event);
    const credit = queue.credits[queue.next];
    if (!credit || credit.eventAtMs > event.eventAtMs) continue;
    queue.next += 1;
    state.popularUsed += 1;
    matchedNormalIds.add(String(credit.id));
    matchedPopularIds.add(String(event.id));
  }

  for (const state of states.values()) state.credits = Math.max(0, state.normalDone - state.popularUsed);
  return { states, matchedNormalIds, matchedPopularIds, popularEvents,
    evaluatedAt: new Date(evaluatedAtMs), cutoff: new Date(cutoffMs) };
}

function calculatePopularCreditState(events, evaluatedAt = new Date()) {
  const matches = calculatePopularCreditMatches(events, evaluatedAt);
  return matches.states.values().next().value || _emptyState();
}

async function loadPopularCreditMatches(db, reviewerPhone8s = null, { evaluatedAt = new Date() } = {}) {
  const evaluatedAtMs = _time(evaluatedAt);
  if (evaluatedAtMs === null) throw new TypeError('evaluatedAt must be a valid date');
  const evaluatedAtDate = new Date(evaluatedAtMs);
  const cutoff = new Date(evaluatedAtMs - POPULAR_CREDIT_VALIDITY_MS);
  const scopedPhones = Array.isArray(reviewerPhone8s)
    ? [...new Set(reviewerPhone8s.map((value) => String(value || '')).filter(Boolean))]
    : null;
  if (scopedPhones && !scopedPhones.length) return calculatePopularCreditMatches([], evaluatedAtDate);
  const phoneClause = scopedPhones ? 'AND ca.phone8 = ANY($3::text[])' : '';
  const params = scopedPhones ? [cutoff, evaluatedAtDate, scopedPhones] : [cutoff, evaluatedAtDate];
  const { rows } = await db.query(
    `SELECT ca.id, ca.phone8, ca.status,
            CASE WHEN COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE THEN 'popular' ELSE 'normal' END AS event_type,
            CASE WHEN COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE
                 THEN COALESCE(ca.applied_at, ca.submitted_at) ELSE ca.submitted_at END AS event_at
       FROM campaign_applications ca
       JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
      WHERE rc.participation_mode IS TRUE
        ${phoneClause}
        AND (
          (COALESCE(ca.is_popular_snapshot, rc.is_popular) IS NOT TRUE
            AND ca.status = 'submitted'
            AND ca.submitted_at BETWEEN $1 AND $2)
          OR
          (COALESCE(ca.is_popular_snapshot, rc.is_popular) IS TRUE
            AND (ca.status = 'submitted' OR ca.status = 'blog_pending'
              OR (ca.status = 'applied' AND ca.expires_at > $2))
            AND COALESCE(ca.applied_at, ca.submitted_at) BETWEEN $1 AND $2)
        )
      ORDER BY ca.phone8, event_at, ca.id`, params);
  return calculatePopularCreditMatches(rows, evaluatedAtDate);
}

async function loadPopularCreditState(db, reviewerPhone8, options = {}) {
  const phone8 = String(reviewerPhone8 || '');
  const matches = await loadPopularCreditMatches(db, [phone8], options);
  return matches.states.get(phone8) || _emptyState();
}

function canUsePopularCredit(state) {
  return Number(state && state.credits) >= 1;
}

module.exports = {
  POPULAR_CREDIT_VALIDITY_DAYS,
  calculatePopularCreditMatches,
  calculatePopularCreditState,
  loadPopularCreditMatches,
  loadPopularCreditState,
  canUsePopularCredit,
};
