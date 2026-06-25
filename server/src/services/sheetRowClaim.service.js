/**
 * ═══════════════════════════════════════════════════════════
 * 시트 행 점유 락 서비스 (sheet_row_claims, 마이그레이션 033)
 *
 * 목적: 구매양식 제출의 시트 쓰기 직전, DB에서 "행"을 원자적으로 점유해
 *   ① 같은 주문이 두 행을 차지하는 중복 증식과
 *   ② 동시 제출이 같은 빈 행을 덮어쓰는 경합을
 *   한 번에 막는다. 인라인 쓰기와 큐(order_append) 재시도 양쪽에서 공유한다.
 *
 * 핵심: 쓰기 경로는 "빈 행 후보 목록"을 만들어 claimRow()에 넘긴다.
 *   - 이 주문이 이미 점유한 행이 있으면 그 행을 그대로 반환(멱등).
 *   - 없으면 후보를 순서대로 INSERT ... ON CONFLICT DO NOTHING 으로 점유 시도.
 *   - 점유에 성공한 task만 그 행에 기입한다. → 재제출/타임아웃이 몇 번이든 주문당 1행.
 * ═══════════════════════════════════════════════════════════
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { toPhone8 } = require('./participation.service');

/**
 * 주문 식별용 dedup_key 계산.
 *  - 주문번호(숫자만)가 6자리 이상이면 `num:<digits>` (가장 신뢰도 높음)
 *  - 없으면 `rcp:<수취인>|<연락처8>|<날짜>` (공백 제거 정규화)
 */
function computeDedupKey({ orderNum, recipient, phone, dateStr }) {
  const num = String(orderNum == null ? '' : orderNum).replace(/[^0-9]/g, '');
  if (num.length >= 6) return `num:${num}`;
  const p8 = toPhone8(phone);
  const rcp = String(recipient == null ? '' : recipient).trim().replace(/\s+/g, '');
  const d = String(dateStr == null ? '' : dateStr).replace(/\s+/g, '');
  return `rcp:${rcp}|${p8}|${d}`;
}

/**
 * 행 점유 시도.
 * @param {object} p
 * @param {string} p.sheetId
 * @param {string} p.tabName
 * @param {string} p.dedupKey      computeDedupKey() 결과
 * @param {number[]} p.candidateRows  점유를 시도할 시트 행 번호(1-based) 우선순위 목록
 * @param {object} [p.meta]         { name, phone8, phone, source } — 디버그/추적용
 * @returns {Promise<{row:number|null, isNew?:boolean, exhausted?:boolean, error?:string}>}
 *   - { row, isNew:true }  → 이번에 새로 점유함 → 이 task가 시트에 기입해야 함
 *   - { row, isNew:false } → 이미 이 주문이 점유한 행 → 같은 행에 기입(멱등) 가능
 *   - { row:null, exhausted:true } → 후보가 모두 다른 주문에 점유됨(append 여유 부족)
 */
async function claimRow({ sheetId, tabName, dedupKey, candidateRows, meta = {} }) {
  if (!sheetId || !tabName || !dedupKey) return { row: null, error: 'missing args' };
  const firstCandidate = (candidateRows || []).find(r => Number.isInteger(r) && r >= 1) || null;

  // 1) 이 주문이 이미 점유한 행이 있는가?
  let pre;
  try {
    pre = await pool.query(
      `SELECT sheet_row FROM sheet_row_claims
       WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
      [sheetId, tabName, dedupKey]
    );
  } catch (e) {
    // 테이블 부재(마이그레이션 033 미적용) 등 → 기존 동작으로 안전 폴백(원자성 없음, 흐름 보존)
    if (e.code === '42P01') {
      logger.warn('[rowClaim] sheet_row_claims 미존재 → 비원자 폴백(첫 후보 사용)');
      return { row: firstCandidate, isNew: true, fallback: true };
    }
    throw e;
  }
  if (pre.rows.length) return { row: pre.rows[0].sheet_row, isNew: false };

  const p8 = toPhone8(meta.phone8) || toPhone8(meta.phone) || '';
  const nm = String(meta.name == null ? '' : meta.name).trim();
  const src = meta.source || 'order_submit';

  // 2) 후보 행을 순서대로 점유 시도
  for (const row of candidateRows || []) {
    if (!Number.isInteger(row) || row < 1) continue;
    try {
      const r = await pool.query(
        `INSERT INTO sheet_row_claims (sheet_id, tab_name, sheet_row, dedup_key, name, phone8, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING
         RETURNING sheet_row`,
        [sheetId, tabName, row, dedupKey, nm, p8, src]
      );
      if (r.rows.length) return { row, isNew: true };
    } catch (e) {
      logger.warn(`[rowClaim] 점유 INSERT 오류(무시): ${e.message}`);
    }
    // 충돌 발생: (a) 이 행을 다른 주문이 선점했거나 (b) 그 사이 우리 주문이 점유됨
    const again = await pool.query(
      `SELECT sheet_row FROM sheet_row_claims
       WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
      [sheetId, tabName, dedupKey]
    );
    if (again.rows.length) return { row: again.rows[0].sheet_row, isNew: false };
    // (a)인 경우 → 다음 후보로
  }

  return { row: null, exhausted: true };
}

/**
 * ⓒ 이름 즉시표시: 제출 즉시(시트 쓰기 성공 여부와 무관하게) 리뷰어 신원을
 *   review_index 해당 행에 못 박아 리뷰제출 폼 검색에 바로 뜨게 한다.
 *   - 행이 이미 있으면(사전 기입된 인애드명단 행) phone8/수취인만 backfill.
 *   - 행이 없으면(순수 append) 최소 행을 생성 — 다음 smartBuild가 전체 갱신.
 *   reviewer_name 은 NOT NULL 이므로 항상 비어있지 않게 채운다.
 *   ※ 실패해도 제출 흐름을 막지 않도록 에러를 흡수한다.
 */
async function recordReviewIdentity({ sheetId, tabName, tabGid, rowIndex, phone8, phone, name, recipient }) {
  try {
    const p8 = toPhone8(phone8) || toPhone8(phone);
    const ri = parseInt(rowIndex, 10);
    if (!sheetId || !tabName || !Number.isInteger(ri) || ri < 1 || !p8) return;
    const displayName = String(name || recipient || '').trim() || recipient || name || '미상';
    const rcp = String(recipient || name || '').trim();
    await pool.query(
      `INSERT INTO review_index
         (reviewer_name, sheet_id, tab_name, tab_gid, row_index, is_submitted, phone8, recipient_name, built_at)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,NOW())
       ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
         phone8 = COALESCE(NULLIF(EXCLUDED.phone8, ''), review_index.phone8),
         recipient_name = COALESCE(NULLIF(review_index.recipient_name, ''), EXCLUDED.recipient_name),
         reviewer_name = COALESCE(NULLIF(review_index.reviewer_name, ''), EXCLUDED.reviewer_name)`,
      [displayName, sheetId, tabName, String(tabGid || ''), ri, p8, rcp]
    );
  } catch (e) {
    logger.warn(`[rowClaim] review_index 신원 즉시기록 실패(무시): ${e.message}`);
  }
}

module.exports = { computeDedupKey, claimRow, recordReviewIdentity };
