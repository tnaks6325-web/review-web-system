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
async function recordParticipationLink({ sheetId, tabName, rowIndex, phone8, phone, name, source }) {
  try {
    const p8 = toPhone8(phone8) || toPhone8(phone);
    const ri = parseInt(rowIndex, 10);
    if (!sheetId || !tabName || !Number.isInteger(ri) || ri < 1) return;
    if (!p8) return; // 신원키(phone8) 없으면 기록 의미 없음
    await pool.query(
      `INSERT INTO participation_links (sheet_id, tab_name, row_index, phone8, name, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW())
       ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
         phone8 = EXCLUDED.phone8,
         name   = COALESCE(NULLIF(EXCLUDED.name, ''), participation_links.name),
         source = EXCLUDED.source,
         updated_at = NOW()`,
      [sheetId, tabName, ri, p8, (name || '').toString().trim(), source || 'order_submit']
    );
    logger.info(`[participation] 신원 기록: ${String(sheetId).slice(0, 8)}…/${tabName} row=${ri} phone8=${p8}`);
  } catch (e) {
    logger.warn(`[participation] 신원 기록 실패(무시): ${e.message}`);
  }
}

module.exports = { recordParticipationLink, toPhone8 };
