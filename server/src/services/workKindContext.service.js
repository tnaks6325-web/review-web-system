// ═══════════════════════════════════════════════════════════════════════════
// 탭의 체험단 종류(리뷰/블로그) 조회 — 소비처 단일 출처 (099 · 블로그체험단 M2)
//
// 판정 규칙 자체는 `utils/workKind`(resolveWorkKind: 공고 > 탭)가 소유하고, 여기서는
// **그 두 값을 한 번에 읽어 오는 일**만 한다. 소비처가 각자 SQL 을 쓰면 조용히 갈라진다
// (리뷰타입에서 이미 밟은 자리 — reviewTypeContext 와 같은 모양·같은 규율).
//
// ★ 공고 LATERAL 은 utils/campaignTabLateral 공유 조각(gid 폴백 · 값이 있는 최신 공고).
// ★ 조회 실패는 **null**(= 판정 불가) — 호출부가 "종전 동작"으로 접는다. 모른다고 블로그로
//   단정하면 리뷰 작업의 준비 행 기준이 통째로 바뀐다(오탐이 훨씬 비싸다).
// ★ 실패는 캐시에 넣지 않는다 — 일시 장애를 60초 굳히지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
const { resolveWorkKind } = require('../utils/workKind');
const { campaignColLateral } = require('../utils/campaignTabLateral');
const { logger } = require('../utils/logger');

const CAMPAIGN_WORK_KIND_LATERAL = campaignColLateral('work_kind', 'wk');

let _pool;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; _cache.clear(); }

const TTL = Number(process.env.WORK_KIND_CACHE_MS || 60 * 1000);
const _cache = new Map();   // `${sheetId}\u0000${tabName}` → { v, ts }

/**
 * @returns {Promise<string|null>} 'review' | 'blog' | null(판정 불가 — 종전 동작)
 */
async function workKindForTab({ sheetId, tabName, client } = {}) {
  if (!sheetId || !tabName) return null;
  const key = `${sheetId}\u0000${tabName}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.v;

  let v = null;
  try {
    const db = client || _db();
    const { rows } = await db.query(
      `SELECT c.work_kind AS tab_work_kind, wk.work_kind AS camp_work_kind
         FROM tab_configs c${CAMPAIGN_WORK_KIND_LATERAL}
        WHERE c.sheet_id = $1 AND c.tab_name = $2
        LIMIT 1`,
      [sheetId, tabName]
    );
    const r = rows[0];
    if (!r) return null;                       // 미등록 탭 — 캐시에 넣지 않는다(접수되면 바로 보이게)
    v = resolveWorkKind({ campaignKind: r.camp_work_kind, tabKind: r.tab_work_kind });
  } catch (e) {
    logger.warn(`[workKind] 탭 체험단 종류 조회 실패(종전 동작): ${e.message}`);
    return null;
  }
  _cache.set(key, { v, ts: Date.now() });
  return v;
}

module.exports = { workKindForTab, __setPoolForTest, CAMPAIGN_WORK_KIND_LATERAL };
