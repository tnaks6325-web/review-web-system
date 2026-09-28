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

/** 'YYYY-MM-DD' → 요일(0=일 … 6=토). 형식이 아니면 null(추측하지 않는다). */
function _isoWeekday(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * 이 공고가 **그 날짜(KST)에 주말 미게시로 닫히는가**.
 * ★★ 주말 판정의 단일 출처 — 게시 차단(weekendPublicationState)과 카드의 "다시 오픈" 날짜
 *   계산(campaignState.nextOpenDate)이 **같은 함수**를 본다. 사본을 두면 "카드는 토요일 오픈이라
 *   하는데 서버는 토요일에 막는" 상태가 되살아난다(2026-08-21 신고 건).
 * ★ 판정 불가(형식 밖 값)는 **막지 않는다** — 모른다고 날짜를 건너뛰면 카운트다운이 엉뚱한
 *   날을 가리킨다(막는 쪽은 weekendPublicationState 가 오늘 기준으로 최종 판정한다).
 */
function isWeekendClosedOn(campaign, isoDate, plans = null) {
  if (!campaign || campaign.skip_weekends !== true) return false;
  // 날짜별 모집계획(095)에 주말 인원이 명시되면 그 날짜만 공고 설정보다 우선해 연다.
  // 0명은 휴무라는 기존 계약을 유지한다.
  if (plans && Number(plans[isoDate]) > 0) return false;
  const weekday = _isoWeekday(isoDate);
  if (weekday === null) return false;
  return weekday === 0 || weekday === 6;
}

function weekendPublicationState(campaign, now = new Date(), plans = null) {
  if (!campaign || campaign.skip_weekends !== true) {
    return { blocked: false, reason: null, message: null, resumesOn: null };
  }
  const today = _kstDateParts(now);
  const todayIso = _kstIsoDate(today);
  const weekday = _isoWeekday(todayIso);
  if (!isWeekendClosedOn(campaign, todayIso, plans)) {
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

module.exports = { weekendPublicationState, isWeekendClosedOn };
