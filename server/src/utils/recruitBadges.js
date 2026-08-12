/** 모집공고 안내배지의 단일 규칙. UI의 버튼은 편집 편의일 뿐 이 모듈이 저장값을 결정한다. */
const AUTOMATIC_RECRUIT_BADGES = ['현영건', '로켓와우', '사진 5장+', '구매확정'];
const RETIRED_RECRUIT_BADGES = ['와우 필수', '포토리뷰'];

function _array(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return []; }
  }
  return [];
}

function normalizeRecruitBadges(raw, { cashReceiptRequired = false, channel = '', reviewType = '', reviewTypeMix = [] } = {}) {
  const manual = [];
  for (const value of _array(raw)) {
    const badge = String(value || '').trim();
    if (!badge || AUTOMATIC_RECRUIT_BADGES.includes(badge) || RETIRED_RECRUIT_BADGES.includes(badge) || manual.includes(badge)) continue;
    manual.push(badge);
  }
  const mix = _array(reviewTypeMix);
  const hasReviewType = (type) => reviewType === type
    || (reviewType === 'mixed' && mix.some(row => row && row.type === type && Number(row.quantity) > 0));
  if (cashReceiptRequired) manual.push('현영건');
  if (channel === '쿠팡') manual.push('로켓와우');
  if (hasReviewType('photo')) manual.push('사진 5장+');
  if (hasReviewType('confirm')) manual.push('구매확정');
  return manual;
}

module.exports = { AUTOMATIC_RECRUIT_BADGES, RETIRED_RECRUIT_BADGES, normalizeRecruitBadges };
