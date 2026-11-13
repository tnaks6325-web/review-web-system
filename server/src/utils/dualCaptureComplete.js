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
const CHANNEL_LABELS = { naver: '네이버', coupang: '쿠팡' };

/** 「지금 사진」 = 확정됐고(committed) 다른 사진으로 교체되지 않았다 — 판정·읽기가 같은 조건 한 벌을 쓴다. */
function currentArtifactSql(x) {
  return `${x}.status = 'committed' AND ${x}.superseded_at IS NULL`;
}

function isDualBundleSql(a = 'os') {
  return `((to_jsonb(${a})->>'purchase_bundle_version') IS NOT NULL)`;
}

function dualCaptureCompleteSql(a = 'os') {
  const has = ch => `EXISTS (SELECT 1 FROM purchase_capture_artifacts dcc_${ch}
      WHERE dcc_${ch}.order_submission_id = ${a}.id AND dcc_${ch}.channel = '${ch}'
        AND dcc_${ch}.role = 'primary' AND ${currentArtifactSql(`dcc_${ch}`)})`;
  return `(${isDualBundleSql(a)} AND ${CHANNELS.map(has).join(' AND ')})`;
}

/**
 * 묶음 주문 한 건의 지금 사진 목록 (결정 371 — 리뷰 내역 「참여상품 정보」 [📷 구매캡처보기]).
 * ★ 권한 판정은 하지 않는다 — 부르는 쪽이 소유권을 이미 확인한 주문 id 로만 부른다.
 * 순서 = 네이버 → 쿠팡, 같은 구매처 안에서는 첫 장(primary) → 둘째 장(supplement).
 * @returns {Promise<Array<{fileId:string, label:string, channel:string, createdAt:any}>>}
 */
async function listCurrentDualCaptures(db, orderSubmissionId) {
  const { rows } = await db.query(
    `SELECT dca.channel, dca.role, dca.file_id, dca.created_at
       FROM purchase_capture_artifacts dca
      WHERE dca.order_submission_id = $1 AND ${currentArtifactSql('dca')}
        AND COALESCE(dca.file_id, '') <> ''
      ORDER BY CASE dca.channel WHEN 'naver' THEN 0 WHEN 'coupang' THEN 1 ELSE 2 END,
               CASE dca.role WHEN 'primary' THEN 0 ELSE 1 END, dca.revision, dca.created_at`,
    [orderSubmissionId]
  );
  const seen = {};
  return rows.map(r => {
    const base = CHANNEL_LABELS[r.channel] || '구매사진';
    seen[base] = (seen[base] || 0) + 1;
    return {
      fileId: String(r.file_id),
      label: seen[base] > 1 ? `${base} ${seen[base]}장째` : base,
      channel: String(r.channel || ''),
      createdAt: r.created_at || null,
    };
  });
}

module.exports = { isDualBundleSql, dualCaptureCompleteSql, listCurrentDualCaptures, CHANNELS, CHANNEL_LABELS };
