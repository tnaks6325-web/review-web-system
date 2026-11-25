'use strict';
/**
 * ═══════════════════════════════════════════════════════════
 * ★★ 결정 412 — 네이버예약리뷰 4단계: 예약내역·리뷰 캡처 자동 검사 (판정 단일 출처)
 *
 * ① 예약내역 캡처(구매캡처 길로 올라온 첫 장) — AI 가 읽은 매장 이름·이용일·예약번호·결제금액을
 *    공고 매장 · 고른 날(자리표) · 리뷰어가 적은 예약번호 · 리뷰어가 적은 결제금액(환급형)과 비교해
 *    `match`(모두 같음) / `mismatch`(다른 것이 있음 + 이유) / `unknown`(못 읽었거나 비교할 수 없음)으로 남긴다.
 *    저장 = order_submissions.capture_flags 의 `booking` 키(결정 319 의 `flags` 옆 · 스키마 변경 0).
 * ② 리뷰 캡처(2차 검수) — 네이버 플레이스 방문자 리뷰인지 · 그 매장인지(`judgeReview` → review_inspections.checks.place).
 *
 * ★★ 담당자 표시만 한다(완화 금지 · fail-open) — 리뷰어의 업로드·제출을 막거나 거절하지 않는다.
 *    검사 실패(AI·조회 오류)는 제출을 깨지 않고 `unknown` 으로 남긴다. **못 읽음을 `match` 로 접지 않는다.**
 * ★ AI = 기존 Gemini 길(gemini.service `readBookingCapture` → `_runModel` · 같은 모델·키·시간 제한) — 새 제공자·새 모델 없음.
 * ★ 끄는 스위치 `BOOKING_CAPTURE_CHECK=0`(AI 호출 0 · 작업보드는 「자동 확인 기록 없음」으로 말한다).
 * ═══════════════════════════════════════════════════════════
 */
const { logger } = require('../utils/logger');

function _db() { return require('../db/pool'); }
function enabled() { return process.env.BOOKING_CAPTURE_CHECK !== '0'; }

/** 화면 종류를 믿는 최소 확신 — 리뷰 1차 필터의 잠금 기준(0.9)보다 낮게: 막지 않고 표시만 하므로. */
const SCREEN_CONFIDENCE = 0.7;

/* ── 매장 이름 ───────────────────────────────────────────── */
function _normName(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/[\s\u00a0·.,'"`~!@#$%^&*()_+\-=[\]{}|\\:;<>?/·・｜]/g, '');
}
/**
 * 공고 매장 ↔ 캡처 매장. 한쪽이 다른 쪽을 품으면 같다(화면이 지점명을 빼거나 붙이는 경우).
 * @returns {'match'|'mismatch'|'unknown'} — 어느 한쪽이 비었거나 1글자면 unknown(맞다고 꾸미지 않는다).
 */
function placeNameMatches(expected, captured) {
  const a = _normName(expected), b = _normName(captured);
  if (a.length < 2 || b.length < 2) return 'unknown';
  return (a.includes(b) || b.includes(a)) ? 'match' : 'mismatch';
}

/* ── 이용일 ─────────────────────────────────────────────── */
/** 화면 날짜 글자 → {y|null, m, d} · 못 읽으면 null. 2026-12-07 · 2026.12.7 · 12.7(월) · 12월 7일 · 12/7 */
function parseVisitDate(raw) {
  const s = String(raw == null ? '' : raw);
  let m = s.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (m) return _md(Number(m[1]), Number(m[2]), Number(m[3]));
  // 연도 없는 표기 — 첫 「올바른」 월·일(26.12.7 처럼 두 자리 연도가 앞에 붙은 경우 26.12 를 건너뛴다)
  for (const x of s.matchAll(/(?:^|[^\d])(\d{1,2})\s*(?:월\s*|[.\-/]\s*)(\d{1,2})\s*일?(?!\d)/g)) {
    const v = _md(null, Number(x[1]), Number(x[2]));
    if (v) return v;
  }
  m = s.match(/(?:^|[^\d])\d{2}\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\d)/);
  if (m) return _md(null, Number(m[1]), Number(m[2]));
  return null;
}
function _md(y, mo, d) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return { y, m: mo, d };
}
/** 고른 날(YYYY-MM-DD) ↔ 캡처 날짜 글자 — 연도가 보이면 연도까지, 안 보이면 월·일만 본다. */
function sameVisitDate(slotDate, captured) {
  const e = parseVisitDate(slotDate), c = parseVisitDate(captured);
  if (!e || !c) return 'unknown';
  if (c.y != null && e.y != null && c.y !== e.y) return 'mismatch';
  return (c.m === e.m && c.d === e.d) ? 'match' : 'mismatch';
}
function _dateLabel(raw) {
  const p = parseVisitDate(raw);
  return p ? `${p.m}/${p.d}` : String(raw || '').slice(0, 20);
}

/* ── 예약번호·금액 ───────────────────────────────────────── */
function _normResv(s) { return String(s == null ? '' : s).normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, ''); }
function _won(n) {
  const v = typeof n === 'number' ? n : parseInt(String(n == null ? '' : n).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 예약내역 캡처 판정(순수).
 * @param read AI 판독 { screen, confidence, cancelled, placeName, visitDate, reservationNo, amount } | null(AI 실패)
 * @param expected { placeName, slotDate, reservationNo, payMode, payAmount }
 * @returns {{status:'match'|'mismatch'|'unknown', reasons:Array<{code, captured?, expected?}>}}
 */
function judgeReservation({ read, expected } = {}) {
  const ex = expected || {};
  if (!read || typeof read !== 'object') return { status: 'unknown', reasons: [{ code: 'ai_failed' }] };
  const conf = Number(read.confidence) || 0;
  if (read.screen !== 'naver_booking' && conf >= SCREEN_CONFIDENCE) {
    return { status: 'mismatch', reasons: [{ code: 'not_booking_screen' }] };
  }
  const bad = [], unk = [];
  if (read.screen !== 'naver_booking' || conf < SCREEN_CONFIDENCE) unk.push({ code: 'low_confidence' });
  if (read.cancelled === true) bad.push({ code: 'cancelled' });
  // 매장
  const pm = placeNameMatches(ex.placeName, read.placeName);
  if (!String(ex.placeName || '').trim()) unk.push({ code: 'no_expected_place' });
  else if (pm === 'mismatch') bad.push({ code: 'place_differs', captured: String(read.placeName || '').slice(0, 60), expected: String(ex.placeName).slice(0, 60) });
  else if (pm === 'unknown') unk.push({ code: 'place_unread' });
  // 이용일
  const dm = sameVisitDate(ex.slotDate, read.visitDate);
  if (dm === 'mismatch') bad.push({ code: 'date_differs', captured: _dateLabel(read.visitDate), expected: _dateLabel(ex.slotDate) });
  else if (dm === 'unknown') unk.push({ code: 'date_unread' });
  // 예약번호
  const er = _normResv(ex.reservationNo), cr = _normResv(read.reservationNo);
  if (!er) unk.push({ code: 'no_expected_resv' });
  else if (!cr) unk.push({ code: 'resv_unread' });
  else if (er !== cr) bad.push({ code: 'resv_differs', captured: String(read.reservationNo || '').slice(0, 40), expected: String(ex.reservationNo).slice(0, 40) });
  // 결제금액 — 환급형만(무료체험형은 결제가 없다)
  if (ex.payMode === 'refund') {
    const ea = _won(ex.payAmount), ca = _won(read.amount);
    if (!ea) unk.push({ code: 'no_expected_amount' });
    else if (!ca) unk.push({ code: 'amount_unread' });
    else if (ea !== ca) bad.push({ code: 'amount_differs', captured: ca, expected: ea });
  }
  if (bad.length) return { status: 'mismatch', reasons: bad.concat(unk.filter(u => u.code !== 'low_confidence')) };
  if (unk.length) return { status: 'unknown', reasons: unk };
  return { status: 'match', reasons: [] };
}

/**
 * 리뷰 캡처 판정(순수) — 2차 검수의 `checks.place` 한 칸.
 * pass = 네이버 플레이스 방문자 리뷰 + 같은 매장 · warn = 다른 화면(확신)·다른 매장 · skip + evidence unknown = 못 읽음/비교 불가.
 */
function judgeReview({ read, expected } = {}) {
  const ex = expected || {};
  const unknown = (reason, extra) => ({ verdict: 'skip', evidence: 'unknown', reason, ...(extra || {}) });
  if (!read || typeof read !== 'object') return unknown('ai_failed');
  const conf = Number(read.confidence) || 0;
  const kind = String(read.screen || '');
  if (kind !== 'naver_place_review') {
    return conf >= SCREEN_CONFIDENCE
      ? { verdict: 'warn', reason: 'not_place_review', kind, confidence: conf, ocr: String(read.placeName || '').slice(0, 60) }
      : unknown('low_confidence', { kind, confidence: conf });
  }
  if (conf < SCREEN_CONFIDENCE) return unknown('low_confidence', { kind, confidence: conf });
  if (!String(ex.placeName || '').trim()) return unknown('no_expected_place', { kind });
  const pm = placeNameMatches(ex.placeName, read.placeName);
  if (pm === 'unknown') return unknown('place_unread', { kind });
  if (pm === 'mismatch') return { verdict: 'warn', reason: 'place_differs', kind, ocr: String(read.placeName || '').slice(0, 60), expected: String(ex.placeName).slice(0, 60), confidence: conf };
  return { verdict: 'pass', kind, ocr: String(read.placeName || '').slice(0, 60), confidence: conf };
}

/* ── 담당자에게 보일 말(작업보드) ─────────────────────────── */
const _fmtWon = n => `${Number(n || 0).toLocaleString('ko-KR')}원`;
function reasonText(r) {
  if (!r || typeof r !== 'object') return '';
  switch (r.code) {
    case 'not_booking_screen': return '네이버 예약내역 화면이 아닌 것 같음';
    case 'cancelled': return '예약이 취소된 화면으로 보임';
    case 'place_differs': return `매장 이름이 다름 — 캡처 「${r.captured || ''}」 · 공고 「${r.expected || ''}」`;
    case 'date_differs': return `이용일이 다름 — 캡처 ${r.captured || ''} · 고른 날 ${r.expected || ''}`;
    case 'resv_differs': return `예약번호가 다름 — 캡처 ${r.captured || ''} · 리뷰어가 적은 번호 ${r.expected || ''}`;
    case 'amount_differs': return `결제금액이 다름 — 캡처 ${_fmtWon(r.captured)} · 리뷰어가 적은 금액 ${_fmtWon(r.expected)}`;
    case 'place_unread': return '매장 이름을 읽지 못함';
    case 'date_unread': return '이용일을 읽지 못함';
    case 'resv_unread': return '예약번호를 읽지 못함';
    case 'amount_unread': return '결제금액을 읽지 못함';
    case 'low_confidence': return 'AI가 어떤 화면인지 확신하지 못함';
    case 'no_expected_place': return '공고 매장 이름을 몰라 비교하지 못함';
    case 'no_expected_resv': return '리뷰어가 적은 예약번호가 없어 비교하지 못함';
    case 'no_expected_amount': return '리뷰어가 적은 결제금액이 없어 비교하지 못함';
    case 'ai_failed': return 'AI가 사진을 읽지 못함';
    case 'expect_failed': return '비교할 예약 정보를 불러오지 못함';
    case 'capture_changed': return '사진이 바뀐 뒤 다시 확인하지 않음';
    case 'not_checked': return '자동 확인 기록 없음';
    default: return '';
  }
}

/**
 * 작업보드 한 줄의 표시 재료(내부만 — 호출부가 showEdits 일 때만 싣는다).
 * @param captureFlags order_submissions.capture_flags
 * @param bookingCapture { fileId } — 예약 주문(source='booking_submit')일 때만(아니면 null)
 * @returns {null | {status:'match'|'mismatch'|'unknown', lines:string[]}}
 */
function reservationCheckView(captureFlags, bookingCapture) {
  if (!bookingCapture || typeof bookingCapture !== 'object') return null;
  const fileId = String(bookingCapture.fileId || '');
  if (!fileId) return null;   // 캡처가 아직 없다 — 「구매캡처 없음」 쪽이 말한다
  const rec = captureFlags && typeof captureFlags === 'object' ? captureFlags.booking : null;
  const tail = ' — 직접 확인해 주세요';
  if (!rec || typeof rec !== 'object' || !['match', 'mismatch', 'unknown'].includes(rec.status)) {
    return { status: 'unknown', lines: [reasonText({ code: 'not_checked' }) + tail] };
  }
  if (String(rec.fileId || '') !== fileId) return { status: 'unknown', lines: [reasonText({ code: 'capture_changed' }) + tail] };
  if (rec.status === 'match') return { status: 'match', lines: ['매장 · 이용일 · 예약번호' + (rec.payMode === 'refund' ? ' · 결제금액' : '') + '이 캡처와 같음'] };
  const lines = (Array.isArray(rec.reasons) ? rec.reasons : []).map(reasonText).filter(Boolean);
  if (rec.status === 'unknown') return { status: 'unknown', lines: (lines.length ? lines : [reasonText({ code: 'not_checked' })]).map(l => l + tail) };
  return { status: 'mismatch', lines: lines.length ? lines : ['예약내역이 신청 내용과 다름'] };
}

/* ── 예약 주문의 비교 재료 ──────────────────────────────── */
async function expectationsForOrder(db, orderSubmissionId) {
  const { rows } = await db.query(
    `SELECT os.id, os.source, os.price, os.capture_file_id,
            ca.booking_reservation_no, s.sheet_id, s.tab_name, to_char(s.slot_date, 'YYYY-MM-DD') AS slot_date
       FROM order_submissions os
       LEFT JOIN campaign_applications ca ON ca.order_submission_id = os.id
       LEFT JOIN booking_slots s ON s.id = ca.booking_slot_id
      WHERE os.id = $1::uuid AND os.deleted_at IS NULL
      ORDER BY ca.id DESC NULLS LAST LIMIT 1`, [orderSubmissionId]);
  return rows[0] || null;
}

/**
 * 예약내역 캡처 한 장 검사 → capture_flags.booking 에 기록. **던지지 않는다**(호출부는 기다리지 않는다).
 * ★ 기록은 그 사진이 아직 그 주문의 첫 장일 때만(capture_file_id = fileId) — 그사이 바뀐 사진의 결과로 덮지 않는다.
 * @returns {{skipped?:string, status?:string, persisted?:boolean}}
 */
async function checkReservationCapture({ db, orderSubmissionId, fileId, base64, mimeType = 'image/jpeg' } = {}) {
  const pool = db || _db();
  try {
    if (!enabled()) return { skipped: 'disabled' };
    if (!orderSubmissionId || !fileId || !base64) return { skipped: 'no_input' };
    const row = await expectationsForOrder(pool, orderSubmissionId);
    if (!row || row.source !== 'booking_submit') return { skipped: 'not_booking' };
    let expected = null, verdict;
    try {
      const place = row.sheet_id ? await require('./bookingSlots.service').placeInfoForTab(pool, row.sheet_id, row.tab_name) : null;
      if (place && row.slot_date) {
        expected = { placeName: place.placeName || '', slotDate: row.slot_date, reservationNo: row.booking_reservation_no || '',
          payMode: place.payMode === 'refund' ? 'refund' : 'free', payAmount: place.payMode === 'refund' ? _won(row.price) : null };
      }
    } catch (e) { logger.warn(`[bookingCaptureCheck] 비교 재료 조회 실패 os=${orderSubmissionId}: ${e.message}`); }
    let read = null;
    if (!expected) verdict = { status: 'unknown', reasons: [{ code: 'expect_failed' }] };
    else {
      try { read = await require('./gemini.service').readBookingCapture(base64, mimeType, { purpose: 'reservation' }); }
      catch (e) { read = null; logger.warn(`[bookingCaptureCheck] 예약내역 판독 실패 os=${orderSubmissionId}: ${String(e && e.message || e).slice(0, 120)}`); }
      verdict = judgeReservation({ read, expected });
    }
    const rec = {
      v: 1, status: verdict.status, reasons: verdict.reasons, fileId: String(fileId),
      payMode: expected ? expected.payMode : '',
      read: read ? { screen: read.screen || '', cancelled: read.cancelled === true, placeName: read.placeName || '',
        visitDate: read.visitDate || '', reservationNo: read.reservationNo || '', amount: _won(read.amount) || 0,
        confidence: Number(read.confidence) || 0 } : null,
      checkedAt: new Date().toISOString(),
    };
    const out = await pool.query(
      `UPDATE order_submissions
          SET capture_flags = jsonb_set(COALESCE(capture_flags, '{}'::jsonb), '{booking}', $2::jsonb, true), updated_at = NOW()
        WHERE id = $1::uuid AND deleted_at IS NULL AND capture_file_id = $3`,
      [orderSubmissionId, JSON.stringify(rec), String(fileId)]);
    const persisted = !!(out && out.rowCount);
    if (!persisted) logger.warn(`[bookingCaptureCheck] 사진이 바뀌어 결과를 남기지 않음 os=${orderSubmissionId}`);
    return { status: rec.status, persisted };
  } catch (e) {
    logger.warn(`[bookingCaptureCheck] 검사 실패(무시 — 제출 영향 없음) os=${orderSubmissionId}: ${String(e && e.message || e).slice(0, 160)}`);
    return { skipped: 'error' };
  }
}

/* ── 기다리지 않고 돌리기(구매캡처 업로드 응답 뒤) ───────── */
const _pending = new Set();
function scheduleReservationCheck(args) {
  const p = Promise.resolve().then(() => checkReservationCapture(args)).catch(() => ({ skipped: 'error' }));
  _pending.add(p);
  p.finally(() => _pending.delete(p));
  return p;
}
/** 시험용 — 예약한 검사가 다 끝날 때까지 기다린다. */
async function flushPending() { while (_pending.size) await Promise.allSettled([..._pending]); }

module.exports = {
  SCREEN_CONFIDENCE,
  placeNameMatches, parseVisitDate, sameVisitDate,
  judgeReservation, judgeReview, reasonText, reservationCheckView,
  expectationsForOrder, checkReservationCapture, scheduleReservationCheck, flushPending,
};
