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

const { holidayName, isLunarYearKnown } = require('../utils/krHolidays');

const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
// 음력 공휴일 표가 없는 해를 만나면 해마다 한 번만 경고한다(조용히 평일로 열리지 않게).
const _warnedYears = new Set();
function _warnUnknownYear(isoDate) {
  const y = String(isoDate || '').slice(0, 4);
  if (!/^\d{4}$/.test(y) || _warnedYears.has(y) || isLunarYearKnown(isoDate)) return;
  _warnedYears.add(y);
  try {
    require('../utils/logger').logger.warn(
      `[campaignWeekend] ${y}년 음력·대체공휴일 표가 없습니다 — 설·추석 등은 평일로 열립니다(utils/krHolidays.js 에 추가 필요)`);
  } catch (_) { /* 로깅 실패가 판정을 죽이지 않게 */ }
}

/**
 * 이 공고가 그 날짜(KST)를 **어떤 이유로 닫는가** — 'weekend' | 'holiday' | null.
 * ★★ 쉬는 날 판정의 단일 출처 — 게시 차단(weekendPublicationState)·카드의 "다시 오픈" 날짜
 *   (campaignState.nextOpenDate)·이월 계산(dailyQuota/pendingCarry)·작업표 날짜 분배가 **같은
 *   판정**을 본다. 사본을 두면 "카드는 공휴일 오픈이라 하는데 서버는 막는" 상태가 되살아난다.
 * ★★ "주말 제외"(skip_weekends)는 **주말 + 법정공휴일 제외**다(2026-09-23 사용자 확정 — 조절 화면이
 *   이미 공휴일을 휴무로 그리는데 서버만 열어 추석 모집이 새던 사고).
 * ★ 날짜별 계획(095)에 1명 이상이 저장된 날은 공고 설정보다 우선해 연다. 0명은 휴무.
 * ★ 판정 불가(형식 밖 값)는 **막지 않는다**.
 */
function closedKindOn(campaign, isoDate, plans = null) {
  if (!campaign || campaign.skip_weekends !== true) return null;
  if (plans && Number(plans[isoDate]) > 0) return null;
  const weekday = _isoWeekday(isoDate);
  if (weekday === null) return null;
  if (weekday === 0 || weekday === 6) return 'weekend';
  _warnUnknownYear(isoDate);
  if (holidayName(isoDate)) return 'holiday';
  return null;
}

/** 이 공고가 그 날짜를 닫는가(주말·공휴일) — 판정은 closedKindOn 하나. */
function isWeekendClosedOn(campaign, isoDate, plans = null) {
  return closedKindOn(campaign, isoDate, plans) !== null;
}

function _fmtMDKo(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  const w = _isoWeekday(iso);
  return `${Number(m[2])}/${Number(m[3])}(${DOW_KO[w]})`;
}

// 재개일 탐색 상한 — 못 찾으면 다음 날로 접는다(빈 값으로 두지 않는다).
const RESUME_SCAN_DAYS = 60;

function weekendPublicationState(campaign, now = new Date(), plans = null) {
  if (!campaign || campaign.skip_weekends !== true) {
    return { blocked: false, reason: null, message: null, resumesOn: null };
  }
  const today = _kstDateParts(now);
  const todayIso = _kstIsoDate(today);
  const kind = closedKindOn(campaign, todayIso, plans);
  if (!kind) {
    return { blocked: false, reason: null, message: null, resumesOn: null };
  }
  /* ★ 재개일 = 쉬는 날(주말·공휴일)과 0명 조절일을 건너뛴 첫날 — "다음 월요일" 고정 계산은
     목요일 추석에 틀린 날짜를 말했다. 카드 목록은 호출부가 nextOpenAt 으로 한 번 더 정교화한다. */
  let resumesOn = _kstIsoDate(_addUtcDays(today, 1));
  for (let i = 1; i <= RESUME_SCAN_DAYS; i++) {
    const d = _kstIsoDate(_addUtcDays(today, i));
    const zero = plans && plans[d] != null && Number(plans[d]) === 0;
    if (!zero && !closedKindOn(campaign, d, plans)) { resumesOn = d; break; }
  }
  const hName = kind === 'holiday' ? holidayName(todayIso) : '';
  const label = kind === 'holiday' ? `공휴일${hName ? `(${hName})` : ''} 미게시` : '주말 미게시';
  return {
    blocked: true,
    reason: 'weekend_unpublished',   // 화면 계약 유지(카드가 이 코드로 분기) — 종류는 closedKind 로 구분
    closedKind: kind,
    holidayName: hName || null,
    message: `${label} · ${_fmtMDKo(resumesOn)} 재개`,
    resumesOn,
  };
}

module.exports = { weekendPublicationState, isWeekendClosedOn, closedKindOn };
