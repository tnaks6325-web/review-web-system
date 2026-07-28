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
  const skip = (message) => ({ status: 'skipped', expected, got: null, confidence: 0, message, businessNo: '', amount: 0 });
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
        message = '영수증의 사업자번호가 회사 번호와 다릅니다. 발행 대상을 확인해주세요.';
        return { status: 'mismatch', expected, got: r.kind, confidence: r.confidence,
                 message, businessNo: r.businessNo, amount: r.amount };
      }
    }
    return { status: 'ok', expected, got: r.kind, confidence: r.confidence,
             message, businessNo: r.businessNo, amount: r.amount };
  }

  const label = { review: '리뷰 캡처', receipt: '현금영수증 캡처', other: '알 수 없는 이미지' };
  return {
    status: 'mismatch', expected, got: r.kind, confidence: r.confidence,
    message: `${label[expected]} 자리에 ${label[r.kind] || '다른 이미지'}가 올라온 것 같아요. 확인 후 다시 첨부해주세요.`,
    businessNo: r.businessNo, amount: r.amount,
  };
}

/**
 * 불일치를 관리자 알림으로 남긴다(리뷰어가 [그대로 제출]을 눌러도 사람이 볼 수 있게).
 * 실패해도 업로드에는 영향 없음 — 알림은 부가 신호다.
 */
async function logCaptureMismatch({ sheetId, tabName, reviewerName, slotKey, verdict, fileId } = {}) {
  try {
    const { logReviewerEvent } = require('./reviewerEventLog.service');
    const slotName = slotKey === 'receipt' ? '현금영수증' : '리뷰';
    await logReviewerEvent({
      eventType: 'capture_mismatch',
      severity: 'warn',
      sheetId, tabName, reviewerName,
      message: `${reviewerName || '리뷰어'}님이 올린 ${slotName} 캡처가 형식과 다를 수 있습니다. ${verdict?.message || ''}`.trim(),
      context: { slotKey, fileId, expected: verdict?.expected, got: verdict?.got, confidence: verdict?.confidence },
    });
  } catch (e) {
    logger.warn(`[captureVerify] 알림 기록 실패(무시): ${e.message}`);
  }
}

module.exports = { verifyCapture, logCaptureMismatch, MIN_CONFIDENCE };
