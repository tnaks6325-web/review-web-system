const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// 숫자만 추출 후 끝 8자리 (phone8 정규화) — 하이픈/공백/국가코드 무관
function toPhone8(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

// ═══════════════════════════════════════════════════════════
// P5: 제출 시점 리뷰어 신원 확정 기록 (idempotent UPSERT)
// (sheet_id, tab_name, row_index) → 제출 리뷰어 phone8/name 를 DB에 못 박는다.
// 이후 "참여한 캠페인 조회"는 시트 이름칸 재매칭 없이 이 링크로 본인을 식별.
// ※ 실패해도 제출 흐름을 막지 않도록 내부에서 에러를 흡수한다.
// ═══════════════════════════════════════════════════════════
async function recordParticipationLink({ sheetId, tabName, rowIndex, phone8, phone, name, source, ownerReviewerId, participantIdentityId }) {
  try {
    const p8 = toPhone8(phone8) || toPhone8(phone);
    const ri = parseInt(rowIndex, 10);
    if (!sheetId || !tabName || !Number.isInteger(ri) || ri < 1) return;
    if (!p8) return; // 신원키(phone8) 없으면 기록 의미 없음
    let ownerId = ownerReviewerId || null;
    let identityId = participantIdentityId || null;
    // 코드 쓰기 스위치가 명시적으로 켜진 뒤에만 새 FK를 기록한다. 해석 실패는 기존 신원기록을
    // 막지 않되, 부분 귀속(owner만/participant만)을 만들지 않는다.
    try {
      const identitySvc = require('./reviewerIdentity.service');
      if (identitySvc.isWriteEnabled() && (!ownerId || !identityId)) {
        const { rows } = await pool.query('SELECT id FROM reviewers WHERE phone8 = $1 LIMIT 2', [p8]);
        // 이 호출은 submit 쪽에서 owner를 전달받지 못하는 레거시 경로용이다. 실제 참여자 본인의
        // 직접 등록 행만 여기서 소유자로 삼고, 타계정은 제출 경로가 owner/identity를 명시해야 한다.
        if (rows.length === 1) {
          const resolved = await identitySvc.resolveParticipantIdentity({ ownerReviewerId: rows[0].id, participantPhone8: p8 });
          if (resolved) { ownerId = resolved.ownerReviewerId; identityId = resolved.id; }
        }
      }
    } catch (identityError) {
      logger.warn(`[participation] 코드 신원 해석 실패(기존 기록 계속): ${identityError.message}`);
      ownerId = null; identityId = null;
    }
    await pool.query(
      `INSERT INTO participation_links (sheet_id, tab_name, row_index, phone8, name, source, owner_reviewer_id, participant_identity_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
       ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
         phone8 = EXCLUDED.phone8,
         name   = COALESCE(NULLIF(EXCLUDED.name, ''), participation_links.name),
         source = EXCLUDED.source,
         owner_reviewer_id = COALESCE(EXCLUDED.owner_reviewer_id, participation_links.owner_reviewer_id),
         participant_identity_id = COALESCE(EXCLUDED.participant_identity_id, participation_links.participant_identity_id),
         updated_at = NOW()`,
      [sheetId, tabName, ri, p8, (name || '').toString().trim(), source || 'order_submit', ownerId, identityId]
    );
    logger.info(`[participation] 신원 기록: ${String(sheetId).slice(0, 8)}…/${tabName} row=${ri} phone8=${p8}`);
  } catch (e) {
    logger.warn(`[participation] 신원 기록 실패(무시): ${e.message}`);
  }
}

module.exports = { recordParticipationLink, toPhone8 };
