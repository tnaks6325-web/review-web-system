/**
 * pastSheetTabCleanup.service.js — 과거 작업이 아직 구글시트를 읽고 있는 것을 멈춘다
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 있나 (2026-08-19 사용자 지시 「과거 358건 중 시트 읽는 건 정리해」)
 *
 *   탈 구글시트 W5 에서 기존 작업 86건을 이관하고 **358건은 과거 자료로 이관하지 않기로**
 *   확정했다. 그런데 "이관하지 않는다"는 **시트를 그만 읽는다는 뜻이 아니다** —
 *   smartBuild 는 매 주기 `campaigns ∪ tab_configs` 를 훑어 그 탭들을 여전히
 *   **A:Z 로 읽고 장부를 다시 만든다**(무시트·아카이브·마감 탭만 제외).
 *   즉 몇 년 전 작업이 지금도 구글 쿼터를 쓰고, 옛 시트 값이 장부를 덮을 수 있다.
 *
 * ★★ 조작은 `tab_configs.is_closed = TRUE` **한 칸뿐** — 데이터를 지우지 않는다.
 *   `campaigns`·장부(review_index/index_master)·작업표·주문·시트 전부 무접촉.
 *   되돌리기 = 그 칸을 FALSE 로(`reopenTabs`). 그래서 오판해도 잃는 것이 없다
 *   = 이 기능의 안전 근거. (main 의 `sheetlessOrphanCleanup` 과 같은 규율)
 *
 * ★★ 판정 사본 0 — "과거인가"는 `utils/tabActivity` 한 곳이 정한다.
 *   반영 점검·시트 우위 점검·전환 화면이 쓰는 **그 판정**을 그대로 쓴다.
 *   여기서 규칙을 새로 만들면 "점검에서는 과거인데 정리 대상은 아닌" 상태가 된다.
 *
 * ★★ fail-closed — 아래 제외 조건 중 하나라도 걸리면 후보에서 뺀다(모르면 건드리지 않는다).
 *   (1) 연도를 모름(yearUnknown) 또는 근거가 시트 등록일뿐(weak_signal)
 *       -> 과거라고 단정할 수 없다(등록일은 그 작업의 진행 시기가 아니다)
 *   (2) 컷오프 이후 활동                       -> 현재 작업이다
 *   (3) 미반영 주문 보유                       -> 닫으면 그 주문이 시트에 영영 안 써진다
 *   (4) 살아있는 참여형 공고 연결(status=active) -> 지금 모집 중일 수 있다
 *   (5) 이미 무시트/아카이브/마감              -> 이미 안 읽는다(할 일 없음)
 *
 * 한계(문서화): 탭을 닫으면 **A:Z 읽기와 재빌드가 멈춘다**(비싼 쪽). 다만 그 시트에
 *   시트 기반 탭이 하나라도 남아 있으면 smartBuild 의 시트 목록에는 남아
 *   **Drive 수정시각 조회 1회/주기**는 계속된다(drive 레인 = 시트 쿼터와 별개).
 *   시트 목록에서 빼는 것은 크론 핵심 동작 변경이라 이 작업 범위 밖으로 둔다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const {
  ACTIVITY_LATERAL_SQL, ACTIVITY_SELECT_SQL,
  resolveActivity, normalizeSince,
} = require('../utils/tabActivity');

let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }
function __setPoolForTest(p) { _pool = p; }

const SCAN_CAP = 1000;          // 한 번에 훑는 탭 수 상한(넘으면 절단 사실을 고지)
const CLOSE_CAP = 300;          // 한 번에 닫는 탭 수 상한(오조작 폭발반경 제한)

class PastTabError extends Error {
  constructor(code, extra) { super(code); this.code = code; Object.assign(this, extra || {}); }
}

/* 후보 조회 SQL — 읽기 전용. 제외 조건 (5)는 WHERE 가 아니라 아래 JS 에서 사유와 함께 가른다
   (조용히 빼면 "왜 목록에 없는지" 를 담당자가 알 수 없다). */
const _SCAN_SQL = `
  SELECT tc.sheet_id                       AS "sheetId",
         tc.tab_name                       AS "tabName",
         COALESCE(tc.tab_gid, '')          AS "tabGid",
         COALESCE(tc.sheetless, FALSE)     AS sheetless,
         COALESCE(tc.is_closed, FALSE)     AS "isClosed",
         c.created_at                      AS "registeredAt",
         ${ACTIVITY_SELECT_SQL},
         arch."isArchived",
         ord."pendingOrders",
         camp."activeCampaigns",
         idx."indexRows"
    FROM tab_configs tc
    LEFT JOIN campaigns c
      ON c.sheet_id = tc.sheet_id
    ${ACTIVITY_LATERAL_SQL}
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int > 0 AS "isArchived"
        FROM index_master_archive ima
       WHERE ima.sheet_id = tc.sheet_id
         AND (ima.tab_name = tc.tab_name
              OR (NULLIF(tc.tab_gid, '') IS NOT NULL AND ima.tab_gid = tc.tab_gid))
    ) arch ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "pendingOrders"
        FROM order_submissions os
       WHERE os.sheet_id = tc.sheet_id AND os.tab_name = tc.tab_name
         AND os.deleted_at IS NULL AND os.mirror_status <> 'written'
    ) ord ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "activeCampaigns"
        FROM recruit_campaigns rc
       WHERE rc.linked_sheet_id = tc.sheet_id
         AND (rc.linked_tab_name = tc.tab_name
              OR (NULLIF(tc.tab_gid, '') IS NOT NULL AND rc.linked_tab_gid = tc.tab_gid))
         AND rc.status = 'active'
    ) camp ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS "indexRows"
        FROM index_master im
       WHERE im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
    ) idx ON TRUE
   ORDER BY tc.sheet_id, tc.tab_name
   LIMIT $1`;

/** 한 탭이 지금도 시트를 읽히는가 + 정리 후보인가 (순수함수 — 회귀가드가 직접 실행) */
function classifyPastTab(row, since) {
  const act = resolveActivity(row);
  const base = {
    sheetId: row.sheetId, tabName: row.tabName, tabGid: row.tabGid || '',
    activityAt: act.activityAt, activitySource: act.activitySource,
    indexRows: row.indexRows || 0,
  };
  // (5) 이미 안 읽는 상태 — 할 일 없음
  if (row.sheetless)   return { ...base, reads: false, candidate: false, reason: 'already_sheetless' };
  if (row.isArchived)  return { ...base, reads: false, candidate: false, reason: 'already_archived' };
  if (row.isClosed)    return { ...base, reads: false, candidate: false, reason: 'already_closed' };
  // 여기부터는 **지금도 시트를 읽고 장부를 다시 만드는 탭**이다.
  if (act.yearUnknown) return { ...base, reads: true, candidate: false, reason: 'year_unknown' };
  if (act.activityAt >= since)
    return { ...base, reads: true, candidate: false, reason: 'recent' };
  /* ★★ 시트 등록일만으로는 닫지 않는다(fail-closed · 진짜 PG 검증이 잡은 자리).
     `campaigns.created_at` 은 **DB 행이 만들어진 시각**이라 그 작업이 언제 진행됐는지를
     말해 주지 않는다 — 2024 에 등록한 시트를 2026 에 새 탭으로 재사용하고 구매일을
     `7 / 12 (금)`(연도 없음)로 적으면, 지금 돌아가는 작업이 "2024 활동"으로 찍힌다.
     tabActivity 가 그 위험을 이미 적어 뒀고(`purchaseUnconfirmed`), 여기서 닫는 것은
     **읽기를 멈추는 조작**이라 오판 비용이 목록에서 빠지는 것보다 크다. */
  if (act.activitySource === 'registered')
    return { ...base, reads: true, candidate: false, reason: 'weak_signal' };
  if ((row.pendingOrders || 0) > 0)
    return { ...base, reads: true, candidate: false, reason: 'pending_orders',
             pendingOrders: row.pendingOrders };
  if ((row.activeCampaigns || 0) > 0)
    return { ...base, reads: true, candidate: false, reason: 'active_campaign',
             activeCampaigns: row.activeCampaigns };
  return { ...base, reads: true, candidate: true, reason: 'past' };
}

/** 읽기 전용 진단 — 쓰기 쿼리 0 */
async function scanPastSheetTabs({ since, limit = SCAN_CAP } = {}) {
  const db = _db();
  const cut = normalizeSince(since);
  const cap = Math.max(1, Math.min(SCAN_CAP, Number(limit) || SCAN_CAP));
  let rows;
  try {
    ({ rows } = await db.query(_SCAN_SQL, [cap + 1]));
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) throw new PastTabError('not_ready');
    throw e;
  }
  const truncated = rows.length > cap;
  const items = rows.slice(0, cap).map(r => classifyPastTab(r, cut));
  const reading = items.filter(i => i.reads);
  const candidates = reading.filter(i => i.candidate);
  // 사유별 건수 — "왜 후보가 아닌지"를 화면이 말할 수 있어야 한다(조용한 누락 금지)
  const held = {};
  reading.filter(i => !i.candidate).forEach(i => { held[i.reason] = (held[i.reason] || 0) + 1; });
  // 이미 안 읽는 탭도 **건수는 말한다** — 목록에서 통째로 빠지면 "전체 몇 개 중 몇 개인지"를
  // 화면이 알 수 없어 "정리할 게 없다"와 "이미 정리됐다"가 구분되지 않는다.
  const quiet = {};
  items.filter(i => !i.reads).forEach(i => { quiet[i.reason] = (quiet[i.reason] || 0) + 1; });
  return {
    ok: true, since: cut, truncated,
    total: items.length,
    stillReading: reading.length,
    alreadyQuiet: items.length - reading.length,
    quietBy: quiet,
    candidates: candidates.length,
    heldBy: held,
    sheetsAffected: new Set(candidates.map(i => i.sheetId)).size,
    items: candidates,
    holds: reading.filter(i => !i.candidate),
  };
}

/**
 * 일괄 마감 — `is_closed = TRUE` 한 칸.
 * ★★ 화면이 보낸 목록을 믿지 않는다: 서버가 후보 판정을 **다시 계산**해 통과한 탭만 닫는다
 *   (낡은 화면이 그 사이 주문이 들어온 탭을 닫는 것을 막는다).
 */
async function closePastTabs({ tabs, since, by = 'admin', dryRun = true } = {}) {
  if (!Array.isArray(tabs) || tabs.length === 0) throw new PastTabError('tabs_required');
  if (tabs.length > CLOSE_CAP) throw new PastTabError('too_many_tabs', { max: CLOSE_CAP, got: tabs.length });
  const scan = await scanPastSheetTabs({ since });
  const okKey = new Set(scan.items.map(i => i.sheetId + ' ' + i.tabName));
  const wanted = [], refused = [];
  for (const t of tabs) {
    const sid = t && t.sheetId, tab = t && t.tabName;
    if (!sid || !tab) { refused.push({ sheetId: sid || null, tabName: tab || null, reason: 'bad_key' }); continue; }
    if (!okKey.has(sid + ' ' + tab)) { refused.push({ sheetId: sid, tabName: tab, reason: 'not_candidate' }); continue; }
    wanted.push({ sheetId: sid, tabName: tab });
  }
  if (dryRun) return { ok: true, dryRun: true, wouldClose: wanted.length, refused, tabs: wanted };
  if (!wanted.length) return { ok: true, dryRun: false, closed: 0, refused, tabs: [] };

  const db = _db();
  const client = await db.connect();
  let closed = 0;
  try {
    await client.query('BEGIN');
    for (const w of wanted) {
      const { rowCount } = await client.query(
        `UPDATE tab_configs SET is_closed = TRUE
          WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(is_closed, FALSE) = FALSE`,
        [w.sheetId, w.tabName]);
      closed += rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
  logger.info('[pastTabs] 과거 탭 마감', { by, closed, asked: wanted.length, refused: refused.length });
  return { ok: true, dryRun: false, closed, refused, tabs: wanted };
}

/** 되돌리기 — 후보 판정을 요구하지 않는다(비상구는 잠그지 않는다). */
async function reopenTabs({ tabs, by = 'admin' } = {}) {
  if (!Array.isArray(tabs) || tabs.length === 0) throw new PastTabError('tabs_required');
  if (tabs.length > CLOSE_CAP) throw new PastTabError('too_many_tabs', { max: CLOSE_CAP, got: tabs.length });
  const db = _db();
  const client = await db.connect();
  let reopened = 0;
  try {
    await client.query('BEGIN');
    for (const t of tabs) {
      if (!t || !t.sheetId || !t.tabName) continue;
      const { rowCount } = await client.query(
        `UPDATE tab_configs SET is_closed = FALSE
          WHERE sheet_id = $1 AND tab_name = $2 AND COALESCE(is_closed, FALSE) = TRUE`,
        [t.sheetId, t.tabName]);
      reopened += rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
  logger.info('[pastTabs] 과거 탭 재개', { by, reopened });
  return { ok: true, reopened };
}

module.exports = {
  scanPastSheetTabs, closePastTabs, reopenTabs,
  classifyPastTab, PastTabError, SCAN_CAP, CLOSE_CAP, __setPoolForTest,
};
