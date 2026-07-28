/**
 * captureVerify.service.js — 제출 캡처 슬롯 검수(3단계).
 *
 * 리뷰 슬롯에 영수증을, 영수증 슬롯에 리뷰를 올리는 실수를 제출 시점에 잡는다.
 * 현영건은 영수증 캡처가 정산 근거라 슬롯이 뒤바뀌면 나중에 사람이 전수 확인해야 한다.
 *
 * ★★ fail-open (완화 금지):
 *   AI 미설정·오류·저확신은 **통과**로 처리한다. 오탐으로 정당한 제출이 막히는 쪽이
 *   막으려던 사고보다 나쁘다(구매양식 신원게이트와 같은 규율).
 *   프론트도 경고만 하고 [그대로 제출]을 허용하며, 미해결 건은 관리자 알림으로 남는다.
 */
const { logger } = require('../utils/logger');

// 이 확신도 미만은 판정하지 않는다(모호한 캡처로 리뷰어를 붙잡지 않기 위한 하한)
const MIN_CONFIDENCE = Number(process.env.CAPTURE_VERIFY_MIN_CONFIDENCE || 0.7);
// ★ "확실히 아니다" 하한 — 이 이상일 때만 관리자 실시간 알림(critical)으로 승격한다.
//   0.7~0.9 구간은 리뷰어 유도(인라인 경고) + 통합작업대 로그(warn)까지만 —
//   애매한 판정까지 빨간 알림을 띄우면 급한 건(주문 소실)이 묻힌다(늑대소년 방지).
const SURE_CONFIDENCE = Number(process.env.CAPTURE_VERIFY_SURE_CONFIDENCE || 0.9);
const ENABLED = process.env.CAPTURE_VERIFY !== '0';

/** 슬롯 key → 그 슬롯에 와야 할 이미지 종류. 모르는 슬롯은 검수 대상이 아니다(null). */
function _expectedKind(slotKey) {
  if (slotKey === 'review') return 'review';
  if (slotKey === 'receipt') return 'receipt';
  return null;
}

/**
 * 파일 1장 검수.
 * @returns {{status:'ok'|'mismatch'|'skipped', expected:string|null, got:string|null,
 *            confidence:number, message:string, businessNo:string, amount:number}}
 *   status: ok=형식 일치 / mismatch=명백히 다른 형식(경고) / skipped=판정 안 함(통과)
 */
async function verifyCapture({ base64, mimeType, slotKey, companyBusinessNo } = {}) {
  const expected = _expectedKind(slotKey);
  const skip = (message) => ({ status: 'skipped', expected, got: null, confidence: 0, message, businessNo: '', amount: 0, sure: false });
  if (!ENABLED || !expected || !base64) return skip('');

  let r;
  try {
    const { classifySubmissionImage } = require('./gemini.service');
    r = await classifySubmissionImage(base64, mimeType);
  } catch (e) {
    return skip('');   // AI 장애 = 통과(제출을 막지 않는다)
  }

  if (!r || r.confidence < MIN_CONFIDENCE) return skip('');
  if (r.kind === expected) {
    // 영수증이면 사업자번호가 회사 번호와 같은지까지 확인(강한 통과 신호)
    let message = '';
    if (expected === 'receipt' && companyBusinessNo && r.businessNo) {
      const norm = (v) => String(v || '').replace(/[^0-9]/g, '');
      if (norm(companyBusinessNo) && norm(r.businessNo) !== norm(companyBusinessNo)) {
        // ★ 사업자번호 불일치는 sure로 올리지 않는다 — 형식은 맞고 숫자 OCR 한 자리 오독으로도
        //   갈리는 판정이라, 리뷰어 유도 + 로그(warn)까지만 하고 빨간 알림은 띄우지 않는다.
        message = '영수증의 사업자번호가 회사 번호와 다릅니다. 발행 대상을 확인해주세요.';
        return { status: 'mismatch', expected, got: r.kind, confidence: r.confidence,
                 message, businessNo: r.businessNo, amount: r.amount, sure: false };
      }
    }
    return { status: 'ok', expected, got: r.kind, confidence: r.confidence,
             message, businessNo: r.businessNo, amount: r.amount, sure: false };
  }

  const label = { review: '리뷰 캡처', receipt: '현금영수증 캡처', other: '알 수 없는 이미지' };
  // 형식 자체가 다른 경우만 "확실히 아님" 후보 — 확신도가 SURE 이상이면 관리자 알림으로 승격.
  const sure = r.confidence >= SURE_CONFIDENCE;
  return {
    status: 'mismatch', expected, got: r.kind, confidence: r.confidence,
    message: `${label[expected]} 자리에 ${label[r.kind] || '다른 이미지'}가 올라온 것 같아요. 확인 후 다시 첨부해주세요.`,
    businessNo: r.businessNo, amount: r.amount, sure,
  };
}

/* ── 알림 원장 접근(전부 best-effort — 실패해도 업로드·제출에 영향 0) ───────────── */
let _pool;
function _db() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(p) { _pool = p || null; }

/** 같은 자리(탭·행·슬롯)를 가리키는 키 — 도배 방지와 자동 해결이 같은 기준을 써야 한다. */
function _slotScope({ sheetId, tabName, slotKey, rowIndex }) {
  return [String(sheetId || ''), String(tabName || ''), String(slotKey || ''), String(rowIndex ?? '')];
}

/**
 * 불일치를 관리자 알림으로 남긴다(리뷰어가 [그대로 제출]을 눌러도 사람이 볼 수 있게).
 * 실패해도 업로드에는 영향 없음 — 알림은 부가 신호다.
 *
 * ★ 확실히 아님(verdict.sure) → `critical` = 관리자 대시보드 빨간 알림 카드 + SSE 실시간.
 *   애매(0.7~0.9) → `warn` = 통합작업대 "리뷰어 로그"에만. 둘 다 제출은 막지 않는다.
 * ★ 도배 방지: 같은 (탭·행·슬롯)에 **미해결** 알림이 이미 있으면 새로 쌓지 않는다.
 *   (reviewer_event_logs의 부분유니크는 order_submission_id 기준이라 캡처 알림엔 안 걸린다.)
 */
async function logCaptureMismatch({ sheetId, tabName, reviewerName, slotKey, verdict, fileId, rowIndex } = {}) {
  try {
    const scope = _slotScope({ sheetId, tabName, slotKey, rowIndex });
    // 이미 같은 자리로 열려 있는 알림이 있으면 skip — 리뷰어가 여러 번 올려도 알림은 1건.
    try {
      const { rows } = await _db().query(
        `SELECT 1 FROM reviewer_event_logs
          WHERE event_type = 'capture_mismatch' AND resolved_at IS NULL
            AND sheet_id = $1 AND tab_name = $2
            AND context->>'slotKey' = $3 AND COALESCE(context->>'row', '') = $4
          LIMIT 1`, scope);
      if (rows.length) return { ok: true, skipped: true };
    } catch (_) { /* 선조회 실패는 무시하고 기록은 진행(알림 유실보다 중복이 낫다) */ }

    const { logReviewerEvent } = require('./reviewerEventLog.service');
    const slotName = slotKey === 'receipt' ? '현금영수증' : '리뷰';
    const sure = !!(verdict && verdict.sure);
    const pct = verdict && verdict.confidence ? Math.round(verdict.confidence * 100) : null;
    const where = rowIndex ? ` ${rowIndex}행` : '';
    const message = sure
      ? `${reviewerName || '리뷰어'}님이${where} ${slotName} 캡처 자리에 다른 형식의 이미지를 올렸습니다`
        + (pct ? `(AI 확신 ${pct}%)` : '') + '. 리뷰어 화면에는 재첨부 안내가 표시됐습니다 — 확인이 필요합니다.'
      : `${reviewerName || '리뷰어'}님이${where} 올린 ${slotName} 캡처가 형식과 다를 수 있습니다. ${verdict?.message || ''}`.trim();

    const r = await logReviewerEvent({
      eventType: 'capture_mismatch',
      severity: sure ? 'critical' : 'warn',
      sheetId, tabName, reviewerName,
      message,
      context: { slotKey, row: String(rowIndex ?? ''), fileId, sure,
                 expected: verdict?.expected, got: verdict?.got, confidence: verdict?.confidence },
    });
    return r || { ok: true };
  } catch (e) {
    logger.warn(`[captureVerify] 알림 기록 실패(무시): ${e.message}`);
    return { ok: false };
  }
}

/**
 * 같은 자리에 형식이 맞는 캡처가 다시 올라오면 그 알림을 자동으로 닫는다.
 * 원인이 사라졌는데 관리자가 손으로 [확인]을 눌러야 하면 알림 창이 옛 건으로 차서
 * 정작 지금 문제를 못 보게 된다(order_lost의 autoResolveHealed와 같은 규율).
 *
 * 한계: PR #379 시점의 옛 로그는 context에 행 번호가 없어 이 자동 해결에 안 걸린다(수동 [확인]).
 */
async function resolveCaptureMismatch({ sheetId, tabName, slotKey, rowIndex } = {}) {
  try {
    const { rowCount } = await _db().query(
      `UPDATE reviewer_event_logs
          SET resolved_at = NOW(), resolved_by = 'auto:recaptured'
        WHERE event_type = 'capture_mismatch' AND resolved_at IS NULL
          AND sheet_id = $1 AND tab_name = $2
          AND context->>'slotKey' = $3 AND COALESCE(context->>'row', '') = $4`,
      _slotScope({ sheetId, tabName, slotKey, rowIndex }));
    return { ok: true, resolved: rowCount || 0 };
  } catch (e) {
    logger.warn(`[captureVerify] 알림 자동해결 실패(무시): ${e.message}`);
    return { ok: false };
  }
}

module.exports = {
  verifyCapture, logCaptureMismatch, resolveCaptureMismatch,
  MIN_CONFIDENCE, SURE_CONFIDENCE, __setPoolForTest,
};
