'use strict';

/**
 * 공고별 필수 배송메세지 (결정 260 · 사용자 확정 2026-10-19 · migration 192).
 *
 * 작업 안내에 "배송메세지 00 넣어서 구매"가 있는 공고는 공고 설정의 「필수 배송메세지」에 그 글자를 적는다.
 * 구매양식 제출 때 서버는 **주문에 저장될 배송메세지**(결정 245 — 캡처 판독 서명에서만 꺼낸 값)에 그 글자가
 * 들어 있는지 본다.
 *   · 들어 있음            → 접수 + delivery_memo_check='ok'
 *   · 없음 + 직원 확인 요청(두 번째 사진을 받은 경우만 · 결정 300) → 접수 + delivery_memo_check='staff_review'(작업보드 🚩 · 직원이 보고 반려)
 *   · 없음                 → 접수하지 않는다(DELIVERY_MEMO_REQUIRED — 다시 캡처하게 안내)
 * ★ 판정 = "들어 있으면 통과"(사용자 확정 가) — 띄어쓰기·대소문자 무시, 숫자만인 글자는 AI 가 영문 O 로 읽은 것도 0 으로 본다.
 * ★ 공고 설정 조회 실패 = 모름 → 막지 않는다(fail-open + warn). 필수 글자가 빈 공고는 종전 동작 그대로.
 */

const { logger } = require('../utils/logger');

let _pool;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }

const REQUIRED_MAX = 30;

/** 저장용 — 앞뒤 공백 제거·연속 공백 하나로·30자. 빈 값 = 확인 안 함. */
function normalizeRequired(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, REQUIRED_MAX);
}

function _cmpKey(s, digitsOnly) {
  let t = String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (digitsOnly) t = t.replace(/[o○〇]/g, '0');
  return t;
}

/** 배송메세지에 필수 글자가 들어 있나. 필수 글자가 비면 true(확인 안 함). */
function memoSatisfies(memo, required) {
  const req = normalizeRequired(required);
  if (!req) return true;
  const digitsOnly = /^[0-9\s]+$/.test(req);
  const want = _cmpKey(req, digitsOnly);
  if (!want) return true;
  return _cmpKey(memo, digitsOnly).includes(want);
}

/**
 * 이 제출의 공고 필수 배송메세지. '' = 확인 안 함, null = 조회 실패(모름).
 * 공고 = 검증된 홀드의 공고 → 무시트 범위(campaign:<id>) → 작업표에 연결된 공고(필수 글자가 있는 가장 최근 것).
 */
async function requiredForSubmission({ holdCtx, sheetId, tabName } = {}) {
  try {
    const db = _db();
    let campaignId = (holdCtx && holdCtx.verified && holdCtx.campaignId) ? String(holdCtx.campaignId) : '';
    if (!campaignId) {
      const m = /^campaign:(.+)$/.exec(String(tabName || ''));
      if (m) campaignId = m[1];
    }
    if (campaignId) {
      const { rows } = await db.query(
        'SELECT required_delivery_memo FROM recruit_campaigns WHERE id = $1 LIMIT 1', [campaignId]);
      return normalizeRequired(rows[0] && rows[0].required_delivery_memo);
    }
    if (!sheetId || !tabName) return '';
    const { rows } = await db.query(
      `SELECT rc.required_delivery_memo
         FROM recruit_campaigns rc
         LEFT JOIN tab_configs tc ON tc.sheet_id = $1 AND tc.tab_name = $2
        WHERE rc.linked_sheet_id = $1
          AND (rc.linked_tab_name = $2 OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
          AND rc.required_delivery_memo <> ''
        ORDER BY rc.created_at DESC
        LIMIT 1`, [sheetId, tabName]);
    return normalizeRequired(rows[0] && rows[0].required_delivery_memo);
  } catch (e) {
    logger.warn(`[requiredDeliveryMemo] 공고 필수 배송메세지 조회 실패(확인 없이 접수): ${e.message}`);
    return null;
  }
}

/** 제출 판정. action: 'none'(확인 안 함) | 'ok' | 'staff_review' | 'block' */
/* 결정 300 — 「직원 확인 요청」은 두 번째 사진을 서버가 받았을 때만(secondCaptureProven) 받는다.
   없으면 막고(needSecondCapture) 배송지·배송메세지가 보이는 화면을 두 번째 사진으로 추가하게 한다(사용자 확정 2026-10-27). */
function decide({ required, memo, staffReviewRequested, secondCaptureProven }) {
  const req = normalizeRequired(required);
  if (!req) return { action: 'none' };
  if (memoSatisfies(memo, req)) return { action: 'ok', required: req };
  if (staffReviewRequested && secondCaptureProven === true) return { action: 'staff_review', required: req };
  const read = String(memo || '').trim();
  const needSecondCapture = secondCaptureProven !== true;
  return {
    action: 'block',
    required: req,
    readMemo: read,
    needSecondCapture,
    error: `이 작업은 배송메세지에 「${req}」을(를) 넣어 구매해야 해요. `
      + (read ? `캡처에서 읽힌 배송메세지(「${read}」)에 「${req}」이(가) 없어요. ` : '캡처에서 배송메세지가 보이지 않아요. ')
      + (needSecondCapture
        ? '배송지와 배송메세지가 보이는 화면을 찍어 두 번째 사진으로 추가한 뒤 다시 제출해 주세요.'
        : '두 번째 사진에서도 확인되지 않았어요. 배송메세지가 보이는 화면인지 확인해 주세요.'),
  };
}

module.exports = { REQUIRED_MAX, normalizeRequired, memoSatisfies, requiredForSubmission, decide, __setPoolForTest };
