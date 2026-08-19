// ═══════════════════════════════════════════════════════════════════════════
// 탭 → **지금 적용된 공고 제목**(리뷰어 카드의 작업 이름) 조회 — 소비처 단일 출처.
//
// 배경(2026-08-19 사용자 확정): 리뷰 내역 카드는 접수 시점에 고정된 탭 이름
// (`tab_configs.display_name`, 업서트가 blank-only 라 절대 안 바뀐다)을 보여 왔다.
// 관리자가 공고 제목을 고치면 **화면만 옛 이름으로 남아** "다른 작업"으로 읽힌다.
// → 연결된 공고의 현재 `title` 을 이름으로 쓴다.
//
// ★ 조회만 한다 — 규칙(gid 폴백 · 값이 있는 최신 공고)은 utils/campaignTabLateral 이 소유.
// ★ fail-soft: 조회 실패·미연결 탭은 **null** → 호출부가 종전 이름(display_name)으로 접는다.
//   이름을 몰라서 카드가 비는 일은 없어야 한다(빈 이름 > 옛 이름 이 아니다 — 그 반대다).
// ★ 실패는 캐시에 넣지 않는다 — 일시 장애를 60초 굳히지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
const { campaignColLateral } = require('../utils/campaignTabLateral');
const { logger } = require('../utils/logger');

const CAMPAIGN_TITLE_LATERAL = campaignColLateral('title', 'ct');

let _pool;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; _cache.clear(); }

const TTL = Number(process.env.CAMPAIGN_TITLE_CACHE_MS || 60 * 1000);
const _cache = new Map();   // `${sheetId}\u0000${tabName}` → { v, ts }

/** @returns {Promise<string|null>} 지금 적용된 공고 제목 또는 null(미연결·조회 실패) */
async function campaignTitleForTab({ sheetId, tabName, client } = {}) {
  if (!sheetId || !tabName) return null;
  const key = `${sheetId}\u0000${tabName}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.v;

  let v = null;
  try {
    const db = client || _db();
    const { rows } = await db.query(
      `SELECT ct.title AS camp_title
         FROM tab_configs c${CAMPAIGN_TITLE_LATERAL}
        WHERE c.sheet_id = $1 AND c.tab_name = $2
        LIMIT 1`,
      [sheetId, tabName]
    );
    if (!rows[0]) return null;                 // 미등록 탭 — 캐시에 넣지 않는다(접수되면 바로 보이게)
    v = String(rows[0].camp_title || '').trim() || null;
  } catch (e) {
    logger.warn(`[campaignTitle] 탭 공고 제목 조회 실패(종전 이름 사용): ${e.message}`);
    return null;
  }
  _cache.set(key, { v, ts: Date.now() });
  return v;
}

/**
 * 여러 탭을 한 번에 — 검색 결과처럼 탭이 섞인 목록용(행마다 조회하면 왕복이 폭증한다).
 * ★ `reviewTypesForTabs`·`workKindsForTabs` 와 같은 모양: 중복 제거 후 탭당 1회(60초 캐시가 흡수).
 * @returns {Promise<Map<string, string|null>>} 키 = `${sheetId} ${tabName}`
 */
async function campaignTitlesForTabs(pairs) {
  const out = new Map();
  const uniq = [];
  for (const p of pairs || []) {
    if (!p || !p.sheetId || !p.tabName) continue;
    const k = `${p.sheetId} ${p.tabName}`;
    if (!out.has(k)) { out.set(k, null); uniq.push(p); }
  }
  for (const p of uniq) {
    out.set(`${p.sheetId} ${p.tabName}`, await campaignTitleForTab(p));
  }
  return out;
}

module.exports = { campaignTitleForTab, campaignTitlesForTabs, __setPoolForTest, CAMPAIGN_TITLE_LATERAL };
