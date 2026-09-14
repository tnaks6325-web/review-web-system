/** 모집공고의 현금영수증 직접 설정을 연결 작업 단위로 읽는다. */
const { logger } = require('../utils/logger');

let _pool;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; _cache.clear(); }
function invalidateCashReceiptContext(sheetId, tabName) {
  if (!sheetId || !tabName) return _cache.clear();
  _cache.delete(`${sheetId}\u0000${tabName}`);
}

const TTL = Number(process.env.CASH_RECEIPT_CONTEXT_CACHE_MS || 60 * 1000);
const _cache = new Map();

async function cashReceiptRequiredForTab({ sheetId, tabName, client } = {}) {
  if (!sheetId || !tabName) return null;
  const key = `${sheetId}\u0000${tabName}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.v;
  try {
    const db = client || _db();
    const { rows } = await db.query(
      `SELECT BOOL_OR(rc.cash_receipt_required) AS cash_receipt_required
         FROM recruit_campaigns rc
         LEFT JOIN tab_configs tc
           ON tc.sheet_id = $1 AND tc.tab_name = $2
        WHERE rc.linked_sheet_id = $1
          AND (rc.linked_tab_name = $2
               OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
       `,
      [sheetId, tabName]
    );
    const v = rows.length ? rows[0].cash_receipt_required === true : null;
    _cache.set(key, { v, ts: Date.now() });
    return v;
  } catch (e) {
    logger.warn(`[cashReceiptContext] 공고 현금영수증 설정 조회 실패(탭 설정으로 폴백): ${e.message}`);
    return null;
  }
}

async function cashReceiptRequirementsForTabs(pairs, opts = {}) {
  const strict = opts.strict === true;
  const fresh = opts.fresh === true;
  const out = new Map();
  const missing = [];
  const seen = new Set();
  for (const p of pairs || []) {
    if (!p || !p.sheetId || !p.tabName) continue;
    const key = `${p.sheetId}\u0000${p.tabName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = fresh ? null : _cache.get(key);
    if (hit && Date.now() - hit.ts < TTL) out.set(key, hit.v);
    else missing.push({ ...p, key });
  }
  if (!missing.length) return out;

  try {
    const db = opts.client || _db();
    const sheetIds = missing.map(p => p.sheetId);
    const tabNames = missing.map(p => p.tabName);
    const { rows } = await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[]) AS r(sheet_id, tab_name)
       )
       SELECT r.sheet_id, r.tab_name, picked.cash_receipt_required
         FROM requested r
         LEFT JOIN LATERAL (
           SELECT BOOL_OR(rc.cash_receipt_required) AS cash_receipt_required
             FROM recruit_campaigns rc
             LEFT JOIN tab_configs tc
               ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
            WHERE rc.linked_sheet_id = r.sheet_id
              AND (rc.linked_tab_name = r.tab_name
                   OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
         ) picked ON TRUE`,
      [sheetIds, tabNames]
    );
    const byKey = new Map((rows || []).map(r => [
      `${r.sheet_id}\u0000${r.tab_name}`,
      r.cash_receipt_required == null ? null : r.cash_receipt_required === true,
    ]));
    const now = Date.now();
    for (const p of missing) {
      const v = byKey.has(p.key) ? byKey.get(p.key) : null;
      _cache.set(p.key, { v, ts: now });
      out.set(p.key, v);
    }
  } catch (e) {
    if (strict) throw e;
    logger.warn(`[cashReceiptContext] 공고 현금영수증 설정 일괄 조회 실패(탭 설정으로 폴백): ${e.message}`);
    for (const p of missing) out.set(p.key, null);
  }
  return out;
}

/**
 * 지급 행별 공고 현영 설정. 주문/신청 원장으로 공고가 하나로 정해지면 그 값을 쓰고,
 * 출처가 없거나 여러 공고로 갈리면 연결 공고 중 하나라도 현영인 경우 true로 닫는다.
 */
async function cashReceiptRequirementsForRows(rows, opts = {}) {
  const strict = opts.strict === true;
  const out = new Map();
  const unique = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row || !row.sheetId || !row.tabName || !Number.isInteger(Number(row.rowIndex))) continue;
    const key = `${row.sheetId}\u0000${row.tabName}\u0000${Number(row.rowIndex)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ sheetId: row.sheetId, tabName: row.tabName, rowIndex: Number(row.rowIndex), key });
  }
  if (!unique.length) return out;

  try {
    const db = opts.client || _db();
    const { rows: found } = await db.query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[])
           AS r(sheet_id, tab_name, row_index)
       ), provenance AS (
         SELECT DISTINCT r.sheet_id, r.tab_name, r.row_index, ca.campaign_id
           FROM requested r
           JOIN order_submissions os
             ON os.sheet_id = r.sheet_id AND os.tab_name = r.tab_name
            AND os.sheet_row = r.row_index AND os.deleted_at IS NULL
           JOIN campaign_applications ca
             ON (ca.id = os.campaign_application_id OR ca.order_submission_id = os.id)
         UNION
         SELECT DISTINCT r.sheet_id, r.tab_name, r.row_index, ca.campaign_id
           FROM requested r
           JOIN campaign_participants cp
             ON cp.sheet_id = r.sheet_id AND cp.tab_name = r.tab_name AND cp.seq = r.row_index
            AND cp.deleted_at IS NULL AND cp.active = TRUE
           JOIN order_submissions os ON os.id = cp.order_submission_id AND os.deleted_at IS NULL
           JOIN campaign_applications ca
             ON (ca.id = os.campaign_application_id OR ca.order_submission_id = os.id)
       ), exact AS (
         SELECT p.sheet_id, p.tab_name, p.row_index,
                COUNT(DISTINCT rc.id)::int AS campaign_count,
                BOOL_OR(rc.cash_receipt_required) AS cash_receipt_required
           FROM provenance p
           JOIN recruit_campaigns rc ON rc.id = p.campaign_id
          GROUP BY p.sheet_id, p.tab_name, p.row_index
       ), linked AS (
         SELECT r.sheet_id, r.tab_name, r.row_index,
                COUNT(DISTINCT rc.id)::int AS campaign_count,
                BOOL_OR(rc.cash_receipt_required) AS cash_receipt_required
           FROM requested r
           LEFT JOIN tab_configs tc
             ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
           LEFT JOIN recruit_campaigns rc
             ON rc.linked_sheet_id = r.sheet_id
            AND (rc.linked_tab_name = r.tab_name
                 OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
          GROUP BY r.sheet_id, r.tab_name, r.row_index
       )
       SELECT r.sheet_id, r.tab_name, r.row_index,
              CASE WHEN COALESCE(e.campaign_count, 0) > 0
                   THEN e.cash_receipt_required ELSE l.cash_receipt_required END AS cash_receipt_required,
              CASE WHEN COALESCE(e.campaign_count, 0) = 1 THEN 'exact'
                   WHEN COALESCE(e.campaign_count, 0) > 1 THEN 'ambiguous_exact'
                   WHEN COALESCE(l.campaign_count, 0) > 1 THEN 'ambiguous_tab'
                   ELSE 'tab' END AS resolution
         FROM requested r
         LEFT JOIN exact e USING (sheet_id, tab_name, row_index)
         LEFT JOIN linked l USING (sheet_id, tab_name, row_index)`,
      [unique.map(r => r.sheetId), unique.map(r => r.tabName), unique.map(r => r.rowIndex)]
    );
    for (const row of found || []) {
      out.set(`${row.sheet_id}\u0000${row.tab_name}\u0000${Number(row.row_index)}`,
        row.cash_receipt_required == null ? null : row.cash_receipt_required === true);
    }
    for (const row of unique) if (!out.has(row.key)) out.set(row.key, null);
  } catch (e) {
    if (strict) throw e;
    logger.warn(`[cashReceiptContext] 행별 공고 현금영수증 설정 조회 실패: ${e.message}`);
    for (const row of unique) out.set(row.key, null);
  }
  return out;
}

module.exports = {
  cashReceiptRequiredForTab, cashReceiptRequirementsForTabs, cashReceiptRequirementsForRows,
  invalidateCashReceiptContext, __setPoolForTest,
};
