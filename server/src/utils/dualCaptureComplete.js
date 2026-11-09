'use strict';
/**
 * 네이버·쿠팡 동시진행 묶음 주문의 「구매캡처 다 냄」 판정 — SQL 조각 단일 출처 (결정 355)
 *
 * 묶음 주문(`purchase_bundle_version` 있음)은 사진을 `purchase_capture_artifacts`(구매처별)에 두고,
 * 옛 칸 `order_submissions.capture_uploaded_at` 은 **채우지 않는다**(결정 338 — 옛 1장 경로 재활용 금지).
 * 그 칸만 보는 "캡처 없음" 판정(리뷰어 홈 보완 목록 · 직원 리뷰어 기록 경고 · 자동 해결)은
 * 묶음 주문을 전부 미첨부로 잘못 본다(2026-11-09 실측: 묶음 17건 전부 두 구매처 사진 있음 · 전부 미첨부 경고).
 *
 * 판정 = `dualPurchaseProjection.validatedProjection` 의 사진 조건과 같다:
 *   네이버·쿠팡 각각 role='primary' · status='committed' · superseded_at IS NULL 사진이 있다.
 * ★ 묶음 여부는 `to_jsonb(<a>)->>'purchase_bundle_version'`(purchaseSubmissionSession 과 같은 idiom).
 */
const CHANNELS = ['naver', 'coupang'];

function isDualBundleSql(a = 'os') {
  return `((to_jsonb(${a})->>'purchase_bundle_version') IS NOT NULL)`;
}

function dualCaptureCompleteSql(a = 'os') {
  const has = ch => `EXISTS (SELECT 1 FROM purchase_capture_artifacts dcc_${ch}
      WHERE dcc_${ch}.order_submission_id = ${a}.id AND dcc_${ch}.channel = '${ch}'
        AND dcc_${ch}.role = 'primary' AND dcc_${ch}.status = 'committed' AND dcc_${ch}.superseded_at IS NULL)`;
  return `(${isDualBundleSql(a)} AND ${CHANNELS.map(has).join(' AND ')})`;
}

module.exports = { isDualBundleSql, dualCaptureCompleteSql, CHANNELS };
