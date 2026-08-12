'use strict';

// Calendar policy is evaluated in Korea, not the server's host timezone.
// This is shared by card projection and the write path so a visible weekend
// notice can never be bypassed by calling the application endpoint directly.
function _kstDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
  };
}

function _kstIsoDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function _addUtcDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
  };
}

function weekendPublicationState(campaign, now = new Date()) {
  if (!campaign || campaign.skip_weekends !== true) {
    return { blocked: false, reason: null, message: null, resumesOn: null };
  }
  const today = _kstDateParts(now);
  const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  if (weekday !== 0 && weekday !== 6) {
    return { blocked: false, reason: null, message: null, resumesOn: null };
  }
  const daysUntilMonday = weekday === 6 ? 2 : 1;
  return {
    blocked: true,
    reason: 'weekend_unpublished',
    message: '주말 미게시 · 월요일 재개',
    resumesOn: _kstIsoDate(_addUtcDays(today, daysUntilMonday)),
  };
}

module.exports = { weekendPublicationState };
