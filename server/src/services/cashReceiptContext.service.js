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
      `SELECT rc.cash_receipt_required
         FROM recruit_campaigns rc
         LEFT JOIN tab_configs tc
           ON tc.sheet_id = $1 AND tc.tab_name = $2
        WHERE rc.linked_sheet_id = $1
          AND (rc.linked_tab_name = $2
               OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
        ORDER BY (rc.status = 'active') DESC, (rc.linked_tab_name = $2) DESC, rc.created_at DESC
        LIMIT 1`,
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

async function cashReceiptRequirementsForTabs(pairs) {
  const out = new Map();
  const missing = [];
  const seen = new Set();
  for (const p of pairs || []) {
    if (!p || !p.sheetId || !p.tabName) continue;
    const key = `${p.sheetId}\u0000${p.tabName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.ts < TTL) out.set(key, hit.v);
    else missing.push({ ...p, key });
  }
  if (!missing.length) return out;

  try {
    const sheetIds = missing.map(p => p.sheetId);
    const tabNames = missing.map(p => p.tabName);
    const { rows } = await _db().query(
      `WITH requested AS (
         SELECT * FROM UNNEST($1::text[], $2::text[]) AS r(sheet_id, tab_name)
       )
       SELECT r.sheet_id, r.tab_name, picked.cash_receipt_required
         FROM requested r
         LEFT JOIN LATERAL (
           SELECT rc.cash_receipt_required
             FROM recruit_campaigns rc
             LEFT JOIN tab_configs tc
               ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
            WHERE rc.linked_sheet_id = r.sheet_id
              AND (rc.linked_tab_name = r.tab_name
                   OR (COALESCE(tc.tab_gid, '') <> '' AND rc.linked_tab_gid = tc.tab_gid))
            ORDER BY (rc.status = 'active') DESC,
                     (rc.linked_tab_name = r.tab_name) DESC,
                     rc.created_at DESC
            LIMIT 1
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
    logger.warn(`[cashReceiptContext] 공고 현금영수증 설정 일괄 조회 실패(탭 설정으로 폴백): ${e.message}`);
    for (const p of missing) out.set(p.key, null);
  }
  return out;
}

module.exports = {
  cashReceiptRequiredForTab, cashReceiptRequirementsForTabs,
  invalidateCashReceiptContext, __setPoolForTest,
};
