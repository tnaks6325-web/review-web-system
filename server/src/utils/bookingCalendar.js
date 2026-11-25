/**
 * bookingCalendar.js — 네이버예약리뷰(결정 404·407) **오더 입력 계약** 정규화 + **날짜별 자리표** 생성 — 순수 함수(DB 없음).
 *
 * 한 자리 = 「이 날 · 이 매장에서 한 명」. 날짜와 날짜별 인원은 **업체가 오더에 정한 그대로**다.
 *
 * ★★ 오더 입력 계약(단일 출처 — 인트라넷 6단계가 이 모양으로 보낸다 · v2 상품 원본 안에 둔다):
 *   work_orders.work_kind = 'booking' · workboard_schema_version = 2 · recruit_count = 날짜별 인원 합
 *   product_options_json = [{                       ← 매장 하나 = 상품 하나(오더 하나 = 매장 하나 · 사용자 확정 2)
 *     name: '<매장 이름>', url: '<네이버 예약 주소>', option_schema_version: 2, product_mode: 'none', options: [],
 *     base: { pay: <1건 결제금액 · 무료체험형 0>, count: <날짜별 인원 합>, daily: 0, review_type_mix: [] },
 *     booking: {
 *       pay_mode: 'refund' | 'free',                 ← 환급형(결제금액 환급 + 리뷰비) / 무료체험형(리뷰비만)
 *       dates: [{ date: 'YYYY-MM-DD', count: n }],    ← 날짜 오름차순 · 중복 없음 · n ≥ 1
 *       review_deadline_days: 3,                      ← 리뷰 기한 = 이용일 + N일(달력 날 · 1~30 · 없으면 3)
 *       place_address: '<매장 주소>'                  ← 안내용(선택)
 *     }
 *   }]
 *   - 매장 이름·예약 주소는 **상품 이름·상품 주소 칸을 그대로 쓴다**(따로 두면 두 값이 갈린다 · 작업표 「상품」 칸·공고 상품 주소가 같은 값).
 *   - 결제금액 = 상품 1건 금액(`base.pay` — 다른 작업과 같은 자리 · `workOrderPayAmounts`). 리뷰비 = `work_orders.review_fee`.
 *
 * ★ 잠금(blocker)은 「그대로 깔면 반드시 틀린 자리표」만 — 고쳐서 다시 보내면 된다(조용히 고쳐 깔지 않는다).
 * ★ 자리를 펼치기 **전에** 합계 상한을 본다(큰 오타로 서버가 멈추지 않게 — Q&A `qna_too_many` 와 같은 규율).
 * ★ 주말·공휴일·제외일을 건너뛰지 않는다 — 날짜는 업체가 정했다(토요일 방문도 그대로).
 *   표기(`M / D (요일)`)와 날짜 더하기는 `worktablePlan.businessDays`(주말 건너뛰기 끔) 단일 출처를 탄다.
 */
'use strict';

const { selectionKey } = require('../services/productOptions.service');

const BOOKING_PAY_MODES = ['refund', 'free'];
const BOOKING_PAY_MODE_LABEL = { refund: '환급형', free: '무료체험형' };
const DEFAULT_REVIEW_DEADLINE_DAYS = 3;
const MAX_REVIEW_DEADLINE_DAYS = 30;
const MAX_BOOKING_DATES = 366;
const MAX_BOOKING_SLOTS = 2000;   // worktablePlan.MAX_ROWS 와 같은 값(한 작업의 줄 상한)

const _YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 정수 글자/숫자만 받는다(소수·빈 값·글자 = null). */
function _strictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = String(v == null ? '' : v).trim();
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
}

/** 실제로 있는 날짜인가(2026-02-30·한 자리 월 거절). */
function isValidYmd(s) {
  const m = _YMD.exec(String(s == null ? '' : s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() + 1 === +m[2] && d.getUTCDate() === +m[3];
}

/** 날짜 하나의 표기(작업표 날짜 칸과 같은 `M / D (요일)`) — businessDays 단일 출처(주말 건너뛰기 끔). */
function dayOf(ymd) {
  const { businessDays } = require('./worktablePlan');
  const [d] = businessDays({ count: 1, startDate: ymd, skipWeekends: false });
  return d || null;
}

/** 리뷰 마감일 = 이용일 + N일(달력 날). */
function reviewDeadlineOf(ymd, days) {
  const n = Math.max(0, _strictInt(days) || 0);
  const { businessDays } = require('./worktablePlan');
  const list = businessDays({ count: n + 1, startDate: ymd, skipWeekends: false });
  const d = list[n];
  return d ? { date: d.date, label: d.label, dow: d.dow } : null;
}

/* ── 결정 419 — 리뷰 마감 안내(보여 주기만 · 넘겨도 막지 않는다 · 사용자 확정 2026-11-25 「1번」) ──
   판정 단일 출처: 리뷰어 화면(「오늘 마감」·「내일 마감」)과 담당자 작업보드(「마감 지남」)가 이 함수 하나를 탄다.
   ★ 오늘 = 서버 KST(부르는 쪽이 정한다 · 휴대폰 시계 안 씀 — 결정 415 와 같은 방향). 모르는 값 = null(「지남」으로 꾸미지 않는다). */
const REVIEW_DEADLINE_NOTICE = Object.freeze({ today: '오늘 마감', tomorrow: '내일 마감' });
/** @returns {'overdue'|'today'|'tomorrow'|'later'|null} */
function reviewDeadlineState(deadlineYmd, todayYmd) {
  const d = String(deadlineYmd == null ? '' : deadlineYmd), today = String(todayYmd == null ? '' : todayYmd);
  if (!isValidYmd(d) || !isValidYmd(today)) return null;
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  const next = reviewDeadlineOf(today, 1);   // 날짜 더하기 = businessDays 단일 출처(주말 건너뛰기 끔)
  return next && next.date === d ? 'tomorrow' : 'later';
}
/** 리뷰어 화면 안내 글자(마감 날·전날만 · 그 밖은 빈 글자). */
function reviewDeadlineNotice(state) {
  return Object.prototype.hasOwnProperty.call(REVIEW_DEADLINE_NOTICE, state) ? REVIEW_DEADLINE_NOTICE[state] : '';
}

function _parseProducts(wo) {
  const raw = wo && wo.product_options_json;
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

function _hasQtyTiers(p) {
  const t = p && p.qty_tiers;
  if (!t) return false;
  if (typeof t !== 'object') return true;
  return Array.isArray(t.rows) ? t.rows.length > 0 : Object.keys(t).length > 0;
}

/**
 * 작업오더 → 예약리뷰 계약(정규화) + 잠금.
 * @returns {{ spec: object|null, blockers: Array<{code,message}> }}
 *   spec = { placeName, bookingUrl, placeAddress, unitKey, payMode, payModeLabel, pay, dates:[{date,count}], total, reviewDeadlineDays }
 */
function bookingSpecFromWorkOrder(wo = {}) {
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  if (Number(wo && wo.workboard_schema_version) !== 2) block('booking_requires_v2', '네이버예약리뷰는 새 리뷰오더 형식(상품·옵션 단계형)으로만 만들 수 있습니다.');

  const products = _parseProducts(wo);
  const live = Array.isArray(products) ? products.filter(p => p && typeof p === 'object' && !p.closed) : [];
  const p = live.length === 1 ? live[0] : null;
  if (!p || String(p.product_mode || '').trim() === 'opt' || (Array.isArray(p.options) && p.options.length)) {
    block('booking_one_place', '네이버예약리뷰 오더는 매장 하나(옵션 없는 상품 하나)여야 합니다.');
    return { spec: null, blockers };
  }
  const placeName = String(p.name || '').trim();
  if (!placeName) block('booking_place_name', '매장 이름이 비어 있습니다.');
  if (_hasQtyTiers(p)) block('booking_no_qty_tiers', '네이버예약리뷰는 구매수량 단계를 쓰지 않습니다.');

  const b = p.booking && typeof p.booking === 'object' && !Array.isArray(p.booking) ? p.booking : null;
  if (!b) {
    block('booking_no_spec', '예약 설정(환급형/무료체험형 · 날짜별 인원)이 없습니다.');
    return { spec: null, blockers };
  }

  const payMode = String(b.pay_mode == null ? '' : b.pay_mode).trim();
  if (!BOOKING_PAY_MODES.includes(payMode)) block('booking_pay_mode', '돈 방식은 환급형(refund) 또는 무료체험형(free)이어야 합니다.');

  const rawDates = Array.isArray(b.dates) ? b.dates : [];
  const dates = [];
  if (!rawDates.length) block('booking_no_dates', '예약 가능한 날짜가 없습니다.');
  else if (rawDates.length > MAX_BOOKING_DATES) block('booking_too_many_dates', `날짜가 ${rawDates.length}개로 상한(${MAX_BOOKING_DATES}개)을 넘습니다.`);
  else {
    const seen = new Set();
    let prev = '';
    let invalid = 0, badCount = 0, dup = 0, unsorted = 0;
    for (const d of rawDates) {
      const date = String((d && d.date) == null ? '' : d.date).trim();
      const count = _strictInt(d && d.count);
      if (!isValidYmd(date)) { invalid++; continue; }
      if (seen.has(date)) dup++;
      else if (prev && date < prev) unsorted++;
      seen.add(date);
      if (!prev || date > prev) prev = date;
      if (count == null || count < 1) { badCount++; continue; }
      dates.push({ date, count });
    }
    if (invalid) block('booking_date_invalid', `날짜 ${invalid}개의 형식이 틀렸습니다(YYYY-MM-DD).`);
    if (dup) block('booking_date_duplicate', '같은 날짜가 두 번 있습니다.');
    if (unsorted) block('booking_dates_unsorted', '날짜는 이른 날부터 차례로 보내야 합니다.');
    if (badCount) block('booking_date_count', `날짜별 인원은 1명 이상의 정수여야 합니다(${badCount}개 날짜).`);
  }
  const total = dates.reduce((n, d) => n + d.count, 0);
  if (total > MAX_BOOKING_SLOTS) block('booking_too_many', `날짜별 인원 합 ${total}명이 한 작업의 상한(${MAX_BOOKING_SLOTS}명)을 넘습니다.`);

  const woTotal = _strictInt(wo && wo.recruit_count);
  const baseCount = p.base && p.base.count != null && String(p.base.count).trim() !== '' ? _strictInt(p.base.count) : null;
  if (dates.length && !blockers.some(x => x.code.startsWith('booking_date') || x.code === 'booking_too_many')
      && ((woTotal || 0) !== total || (baseCount != null && baseCount !== total))) {
    block('booking_total_mismatch', `총 모집 ${woTotal || 0}명(상품 인원 ${baseCount == null ? '-' : baseCount}명)과 날짜별 인원 합 ${total}명이 다릅니다.`);
  }

  const pay = Math.max(0, _strictInt(p.base && p.base.pay) || 0);
  const payTotal = Math.max(0, _strictInt(wo && wo.pay_amount) || 0);
  if (payMode === 'refund' && pay <= 0) block('booking_refund_no_pay', '환급형은 1건 결제금액이 있어야 합니다.');
  if (payMode === 'free' && (pay > 0 || payTotal > 0)) block('booking_free_has_pay', '무료체험형은 결제금액이 0이어야 합니다(업체가 현장에서 무료 처리 · 리뷰비만).');

  let reviewDeadlineDays = DEFAULT_REVIEW_DEADLINE_DAYS;
  if (b.review_deadline_days != null && String(b.review_deadline_days).trim() !== '') {
    const n = _strictInt(b.review_deadline_days);
    if (n == null || n < 1 || n > MAX_REVIEW_DEADLINE_DAYS) block('booking_deadline_days', `리뷰 기한은 1~${MAX_REVIEW_DEADLINE_DAYS}일이어야 합니다.`);
    else reviewDeadlineDays = n;
  }

  return {
    spec: {
      placeName,
      bookingUrl: String(p.url || (wo && wo.product_url) || '').trim(),
      placeAddress: String(b.place_address == null ? '' : b.place_address).trim(),
      unitKey: selectionKey(placeName, '', ''),
      payMode, payModeLabel: BOOKING_PAY_MODE_LABEL[payMode] || '',
      pay: payMode === 'free' ? 0 : pay,
      dates, total, reviewDeadlineDays,
    },
    blockers,
  };
}

/**
 * 자리표 생성 — 날짜 순 · 그날 인원만큼. 같은 계약이면 언제나 같은 seq(재접수·복구가 같은 표).
 * @param {object} spec  bookingSpecFromWorkOrder().spec
 * @returns {{ slots: Array, days: Array, total: number, blockers: Array }}
 */
function buildBookingCalendar(spec, { startSeq = 1 } = {}) {
  if (!spec || !Array.isArray(spec.dates) || !spec.dates.length) {
    return { slots: [], days: [], total: 0, blockers: [{ code: 'booking_no_dates', message: '예약 가능한 날짜가 없습니다.' }] };
  }
  if (spec.total > MAX_BOOKING_SLOTS) {
    return { slots: [], days: [], total: 0, blockers: [{ code: 'booking_too_many', message: `날짜별 인원 합이 상한(${MAX_BOOKING_SLOTS}명)을 넘습니다.` }] };
  }
  const slots = [];
  const days = [];
  for (const d of spec.dates) {
    const day = dayOf(d.date);
    const dl = reviewDeadlineOf(d.date, spec.reviewDeadlineDays);
    if (!day || !dl) return { slots: [], days: [], total: 0, blockers: [{ code: 'booking_date_invalid', message: `날짜 ${d.date} 를 읽을 수 없습니다.` }] };
    days.push({ date: day.date, label: day.label, dow: day.dow, count: d.count });
    for (let k = 1; k <= d.count; k++) {
      slots.push({
        seq: startSeq + slots.length,
        unitKey: spec.unitKey, placeName: spec.placeName,
        date: day.date, dateLabel: day.label, dow: day.dow, dateSeq: k,
        reviewDeadline: dl.date, reviewDeadlineLabel: dl.label,
      });
    }
  }
  return { slots, days, total: slots.length, blockers: [] };
}

/* ═══ ★★ 결정 414 — 접수 뒤 수정 잠금(단일 출처 · 완화 금지) ═══
   접수로 날짜별 자리표(booking_slots)·작업표 줄(이용일자·리뷰마감일·결제금액 칸)이 **이 계약 값으로** 이미 깔렸다.
   그래서 접수 뒤에는 자리표를 정한 값을 바꾸지 않는다(Q&A `_qnaCalendarLocked` 와 같은 규율):
     잠금 = 매장 이름 · 매장 구성(매장 수·옵션) · 진행 방식(환급형/무료체험형) · 날짜·날짜별 인원 · 총 모집인원 · 리뷰 마감 N일
     열림 = 매장 주소(place_address · 안내용) · 네이버 예약 링크(url) · 1건 결제금액(base.pay · 환급형) · 가이드·특이사항 등 글 칸
   ★ 열린 칸도 고친 **결과가 계약을 지켜야** 한다(invalid) — 매장 안내(placeInfoForTab)·입금(bookingPayoutOf)이 오더를 그때그때 읽어,
     계약이 깨지면 리뷰어 신청이 막히고 입금이 「예약 설정 모름」으로 멈춘다(무료체험형에 결제금액을 넣는 것 등).
   ★ 비교는 정규화된 계약(bookingSpecFromWorkOrder) 기준 — 표기 차이(키 순서·공백)로 막지 않는다.
   ★ 예약리뷰에는 「추가 모집」·차수가 없다(차수 = rounds_booking_locked · 결정 407). 날짜·인원을 바꾸려면 새 리뷰오더로 접수한다. */
/** 예약 설정(booking) 안에서 접수 뒤에도 고칠 수 있는 키 — 안내용 칸만. 넓히지 말 것(완화 금지). */
const BOOKING_EDITABLE_AFTER_ACCEPT_KEYS = Object.freeze(['place_address']);
const BOOKING_LOCK_LABELS = Object.freeze({
  place_name: '매장 이름', place_shape: '매장 구성(매장 하나 · 옵션 없음)', pay_mode: '진행 방식(환급형/무료체험형)',
  dates: '날짜·날짜별 인원', total: '총 모집인원', review_deadline_days: '리뷰 마감(이용일 + N일)',
});

/**
 * 접수된 예약 오더의 수정이 자리표를 정한 값을 바꾸는가.
 * @param {object} cur  지금 작업오더 행
 * @param {object} next 수정 뒤 모양(보내지 않은 칸은 cur 값 그대로 채워 넘긴다)
 * @returns {{ locked: string[], invalid: string[] }} locked = BOOKING_LOCK_LABELS 키 · invalid = 수정 뒤 계약이 새로 깨진 사유(사람 말)
 */
function bookingLockedChanges(cur = {}, next = {}) {
  const a = bookingSpecFromWorkOrder(cur || {});
  const z = bookingSpecFromWorkOrder(next || {});
  const locked = [];
  if (!a.spec || !z.spec) {
    // 한쪽 계약을 못 읽음 — 비교 근거가 없다. 상품 구성이 조금이라도 다르면 잠금(fail-closed).
    const canonJ = v => { try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v || '[]') : (v || [])); } catch (_) { return String(v); } };
    if (!z.spec || canonJ(cur && cur.product_options_json) !== canonJ(next && next.product_options_json)) locked.push('place_shape');
  } else {
    if (a.spec.placeName !== z.spec.placeName) locked.push('place_name');
    if (a.spec.payMode !== z.spec.payMode) locked.push('pay_mode');
    if (JSON.stringify(a.spec.dates) !== JSON.stringify(z.spec.dates)) locked.push('dates');
    if (a.spec.reviewDeadlineDays !== z.spec.reviewDeadlineDays) locked.push('review_deadline_days');
  }
  if ((_strictInt(cur && cur.recruit_count) || 0) !== (_strictInt(next && next.recruit_count) || 0)) locked.push('total');
  // ★ 새로 깨진 사유만 — 지금 이미 있던 사유로 글 칸 수정까지 영영 막지 않는다(막다른 길 방지).
  const had = new Set((a.blockers || []).map(b => b.code));
  const invalid = (z.blockers || []).filter(b => !had.has(b.code)).map(b => b.message);
  return { locked: [...new Set(locked)], invalid };
}

/** 잠금 409 문구 — 인트라넷이 실패 사유로 그대로 보여 준다(무엇을 하면 되는지까지).
 *  ★ 「추가 모집」이라는 말을 쓰지 않는다 — 인트라넷 실패 안내(reviewOrderDeliveryFailMessage)가 그 말이 있으면 **Q&A 안내**(「일정 끝 추가 모집으로 늘려라」)로
 *    바꿔 보여 준다(예약리뷰엔 그 길이 없다). 「새 리뷰오더」가 있으면 인트라넷이 「새 리뷰오더로 접수」 안내를 고른다. */
function bookingLockMessage({ locked = [], invalid = [], topLabels = [] } = {}) {
  const names = [...new Set([...topLabels, ...locked.map(k => BOOKING_LOCK_LABELS[k] || k)])];
  if (names.length) {
    return `네이버예약리뷰 작업은 접수 뒤 이 칸을 바꿀 수 없습니다: ${names.join(', ')} — 날짜별 자리가 이 값으로 이미 깔렸습니다. `
      + '원래 값으로 되돌려 저장해 주세요. 날짜·인원을 바꾸거나 늘리려면 새 리뷰오더로 접수해 주세요(네이버예약리뷰는 접수 뒤 인원 늘리기·차수가 없습니다). '
      + '매장 주소·네이버 예약 링크·1인 결제금액·리뷰비·가이드·특이사항은 고칠 수 있습니다.';
  }
  return `네이버예약리뷰 예약 설정이 맞지 않아 저장하지 않았습니다 — ${invalid.join(' ')} 고쳐서 다시 저장해 주세요. `
    + '진행 방식·날짜를 바꿔야 한다면 새 리뷰오더로 접수해 주세요(리뷰웹시스템 작업보드에서도 바꿀 수 없습니다).';
}

/**
 * 화면용 예약 계약(발행 폼 보기 전용 카드 · 결정 409) — 예약 오더가 아니거나 못 읽으면 undefined.
 * ★ 작업오더 목록·작업 카드 [공고 발행]·공고 수정 창이 같은 이 함수를 탄다(사본 0 · 결정 414).
 */
function bookingSpecForScreen(row) {
  if (!row || !require('./workKind').isBookingKind(row.work_kind)) return undefined;
  try {
    const { spec, blockers } = bookingSpecFromWorkOrder(row);
    return spec ? { ...spec, blockers: (blockers || []).map(b => b.message) } : undefined;
  } catch (_) { return undefined; }
}

module.exports = {
  bookingSpecFromWorkOrder, buildBookingCalendar, reviewDeadlineOf, isValidYmd,
  // 결정 419 — 리뷰 마감 안내(표시만)
  reviewDeadlineState, reviewDeadlineNotice, REVIEW_DEADLINE_NOTICE,
  // 결정 414 — 접수 뒤 수정 잠금 · 화면용 계약
  BOOKING_EDITABLE_AFTER_ACCEPT_KEYS, BOOKING_LOCK_LABELS, bookingLockedChanges, bookingLockMessage, bookingSpecForScreen,
  BOOKING_PAY_MODES, BOOKING_PAY_MODE_LABEL, DEFAULT_REVIEW_DEADLINE_DAYS, MAX_REVIEW_DEADLINE_DAYS, MAX_BOOKING_DATES, MAX_BOOKING_SLOTS,
};
