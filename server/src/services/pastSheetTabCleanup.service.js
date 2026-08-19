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
 * ★★ 이 서비스의 **쓰기 표면은 `tab_configs.is_closed` 한 칸뿐**이다(다른 테이블·시트 무접촉).
 *   그러나 **그 칸의 의미는 "표시"가 아니라 "마감(아카이브) 예약"** 이다 —
 *   다음 전체 빌드의 `auto-clean-closed`(indexBuilder 0.5단계)가 그 탭의
 *   `review_index`·`index_master` 를 보관함으로 옮긴 뒤 **원본과 `tab_configs` 행까지 지운다.**
 *   ⇒ 그 작업은 활성 목록에서 사라지고, **참여했던 리뷰어의 「제출완료」 내역도 화면에서 사라진다**
 *     (리뷰 내역 완료 탭은 활성 `review_index` 의 뷰다 — CLAUDE.md 문서화된 한계).
 *   ★ 그러므로 화면·확인창은 "데이터를 지우지 않는다"고 **말하면 안 된다**(회귀가드가 고정).
 *   ★ 되돌리기: 빌드 전이면 `reopenTabs`(그 칸 FALSE)로 즉시 원복되지만,
 *     빌드가 지나 `tab_configs` 행이 사라진 뒤에는 **아카이브 복구**가 유일한 길이다.
 *   ⇒ 대상은 **끝난 과거 작업만** — fail-closed 제외 조건이 그래서 넓다.
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
const CLOSE_CAP = 300;          // 한 번에 닫는 탭 수(오조작 폭발반경 제한)
// ★ 복합키 구분자 — 소스에 리터럴 NUL 을 넣으면 git 이 파일을 바이너리로 취급해
//   grep·grep 기반 회귀가드가 그 파일에서 통째로 무력화된다(이번에 실제로 밟았다).
const KEY_SEP = '\u0000';

class PastTabError extends Error {
  constructor(code, extra) { super(code); this.code = code; Object.assign(this, extra || {}); }
}

/* 후보 조회 SQL — 읽기 전용. 제외 조건 (5)는 WHERE 가 아니라 아래 JS 에서 사유와 함께 가른다
   (조용히 빼면 "왜 목록에 없는지" 를 담당자가 알 수 없다). */
const _SCAN_SQL = `
  SELECT tc.sheet_id                       AS "sheetId",
         tc.tab_name                       AS "tabName",
         COALESCE(NULLIF(tc.campaign_name, ''), tc.sheet_id) AS "campaignName",
         COALESCE(tc.tab_gid, '')          AS "tabGid",
         COALESCE(tc.sheetless, FALSE)     AS sheetless,
         COALESCE(tc.is_closed, FALSE)     AS "isClosed",
         (SELECT MIN(c.created_at) FROM campaigns c
           WHERE c.sheet_id = tc.sheet_id) AS "registeredAt",
         ${ACTIVITY_SELECT_SQL},
         arch."isArchived",
         archg."archivedGidOnly",
         livereg."liveNameRegistered",
         live."liveTabName",
         ord."pendingOrders",
         camp."activeCampaigns",
         idx."indexRows"
    /* ★★ campaigns 는 UNIQUE(sheet_id, campaign_name) — **한 시트에 여러 행**이 있을 수 있다.
     *   여기를 LEFT JOIN campaigns ON sheet_id 로 붙이면 그 시트의 **모든 탭이 배수로 불어나**
     *   총계·"지금도 읽는 수"·목록이 전부 부풀고, 화면에는 **똑같은 줄이 여러 개** 보인다
     *   (2026-08-19 실측: 어니스트캄 시트의 탭들이 2줄씩). 등록일은 스칼라 서브쿼리로 읽는다
     *   — 반영 점검(sheetSyncAudit)이 같은 자리를 이미 이렇게 쓰고 있다(같은 값·같은 형태). */
    FROM tab_configs tc
    ${ACTIVITY_LATERAL_SQL}
    /* ★★ 아카이브 판정은 smartBuild 와 글자 그대로 같은 규칙이어야 한다 —
     *   indexBuilder 는 sheet_id||tab_name 키 집합으로만 스킵한다(이름만, gid 미참조).
     *   여기서 gid 폴백을 넣어 더 넓게 잡으면(레포의 "gid 우선 재매칭" 관용구),
     *   탭 이름이 바뀐 뒤 아카이브 마커가 옛 이름으로 남은 탭이
     *   "이미 안 읽음"으로 분류되는데 smartBuild 는 새 이름으로 계속 읽는다
     *   => 정리해야 할 탭이 화면에서 조용히 사라진다(2026-08-19 실측 「826개 중 0개」 보고로 발견).
     *   여기서 판정하는 것은 "그 탭이 무엇인가"가 아니라 "저쪽이 읽는가" 다.
     *   ★ 그 차이(gid 로만 일치)는 버리지 않고 archivedByGidOnly 로 건수를 말한다. */
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int > 0 AS "isArchived"
        FROM index_master_archive ima
       WHERE ima.sheet_id = tc.sheet_id AND ima.tab_name = tc.tab_name
    ) arch ON TRUE
    /* ★★ smartBuild 의 마감·아카이브 스킵은 **시트의 현재 탭 이름**으로 조회한다
     *   (tcMap/archivedSet 둘 다 sheet_id||tab_name 키, gid 미참조 — indexBuilder:278,543).
     *   그래서 시트에서 탭 이름이 바뀌었는데 tab_configs 가 옛 이름을 들고 있으면
     *   그 탭은 마감·아카이브 표시가 있어도 **새 이름으로 계속 읽힌다**
     *   ⇒ 그런 탭은 "이미 안 읽음"이 아니고, 게다가 **마감해도 읽기가 안 멈춘다**
     *     (탭명 교정이 먼저다). 라이브 이름은 RAW 미러에서 gid 로 읽는다(시트 재읽기 0). */
    LEFT JOIN LATERAL (
      SELECT rst.tab_name AS "liveTabName"
        FROM raw_sheet_tabs rst
       WHERE rst.sheet_id = tc.sheet_id
         AND NULLIF(tc.tab_gid, '') IS NOT NULL AND rst.tab_gid = tc.tab_gid
       ORDER BY rst.mirrored_at DESC NULLS LAST
       LIMIT 1
    ) live ON TRUE
    /* 시트의 현재 이름이 **이미 별도 행으로 등록**돼 있는가.
     *  있으면 옛 이름 행은 gid 만 등록해 두는 유령 행이고, 탭명 교정은
     *  UNIQUE(sheet_id, tab_name) 충돌로 실패한다 — 조치가 달라지므로 구분해서 말한다. */
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int > 0 AS "liveNameRegistered"
        FROM tab_configs t2
       WHERE t2.sheet_id = tc.sheet_id AND t2.tab_name = live."liveTabName"
         AND t2.tab_name <> tc.tab_name
    ) livereg ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int > 0 AS "archivedGidOnly"
        FROM index_master_archive ima
       WHERE ima.sheet_id = tc.sheet_id
         AND ima.tab_name <> tc.tab_name
         AND NULLIF(tc.tab_gid, '') IS NOT NULL AND ima.tab_gid = tc.tab_gid
    ) archg ON TRUE
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
    // ★ 시트가 다르면 탭 이름이 같을 수 있다(`UNIQUE(sheet_id, tab_name)` — 시트 복사본이 흔하다).
    //   화면에 시트를 안 적으면 똑같아 보이는 줄이 여럿 생겨 **어느 것을 고르는지 알 수 없다**
    //   (2026-08-19 실측: 「…50건」·「…50건의 사본」이 두 시트에 걸쳐 4줄).
    campaignName: row.campaignName || '',
    activityAt: act.activityAt, activitySource: act.activitySource,
    indexRows: row.indexRows || 0,
    // 아카이브 마커가 옛 이름으로만 남은 탭 표식(판정에는 쓰지 않는다 — smartBuild 는 읽는다)
    archivedGidOnly: !!row.archivedGidOnly,
    // 시트의 현재 탭 이름이 등록명과 다르다 = smartBuild 의 이름 기준 스킵이 빗나간다
    nameDrift: !!(row.liveTabName && row.liveTabName !== row.tabName),
    liveTabName: row.liveTabName || '',
    // 새 이름이 이미 등록돼 있으면 탭명 교정이 충돌한다(조치가 다르다)
    liveNameRegistered: !!row.liveNameRegistered,
  };
  // (5) 이미 안 읽는 상태 — 할 일 없음
  // ★ 무시트 판정만 gid 폴백이 있다(sheetlessScope) — 이름이 바뀌어도 유효
  if (row.sheetless)   return { ...base, reads: false, candidate: false, reason: 'already_sheetless' };
  // ★★ 마감·아카이브 스킵은 **이름 기준**이라 이름이 어긋나면 빗나간다 → 여전히 읽힌다.
  //   그리고 이 상태는 **마감으로 고칠 수 없다**(마감 표시는 옛 이름 행에 붙는다)
  //   ⇒ 후보로 올리지 않고 사유를 말한다: 탭명 교정이 먼저다.
  /* ★★ 시트의 현재 이름이 **이미 별도 행으로 등록**돼 있으면 이 행은 아무 일도 하지 않는다.
   *   smartBuild 는 시트의 현재 이름으로 tcMap 을 찾으므로(indexBuilder:548) 읽기 여부는
   *   **새 이름 행**의 마감 상태가 정한다. 이 행의 gid 도 그 행과 같아 registeredGids 에
   *   보태는 것이 없다 ⇒ 빈 껍데기다. "지금도 읽습니다" 로 세면 **거짓**이 된다
   *   (2026-08-19 실측: 3건 중 1건이 이 경우였다). 지울지는 사람이 정한다. */
  if (base.nameDrift && base.liveNameRegistered)
    return { ...base, reads: false, candidate: false, reason: 'ghost_row' };
  if (base.nameDrift && (row.isArchived || row.isClosed))
    return { ...base, reads: true, candidate: false, reason: 'name_drift' };
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
    // 이름이 바뀌어 아카이브 마커가 옛 이름으로만 남은 탭 — smartBuild 는 새 이름으로 계속 읽으므로
    // "아카이브"로 접지 않고 정상 판정에 태운다. 건수를 말하는 이유 = 숫자가 왜 늘었는지 설명하려고.
    // ★ 읽히는 것만 센다 — 무시트·마감이라 어차피 안 읽는 탭까지 세면
    //   "여전히 읽습니다"가 거짓이 된다(2026-08-19 실측: 6개 전부 무시트·마감이었다).
    archivedByGidOnly: items.filter(i => i.archivedGidOnly && i.reads).length,
    candidates: candidates.length,
    heldBy: held,
    sheetsAffected: new Set(candidates.map(i => i.sheetId)).size,
    items: candidates,
    holds: reading.filter(i => !i.candidate),
    // 빈 껍데기 행 — 읽기에 영향은 없지만 **무엇인지 알 수 있게** 목록으로 준다
    // (건수만 주면 어느 행을 지워야 할지 알 수 없다).
    ghosts: items.filter(i => i.reason === 'ghost_row'),
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
  const okKey = new Set(scan.items.map(i => i.sheetId + KEY_SEP + i.tabName));
  const wanted = [], refused = [];
  for (const t of tabs) {
    const sid = t && t.sheetId, tab = t && t.tabName;
    if (!sid || !tab) { refused.push({ sheetId: sid || null, tabName: tab || null, reason: 'bad_key' }); continue; }
    if (!okKey.has(sid + KEY_SEP + tab)) { refused.push({ sheetId: sid, tabName: tab, reason: 'not_candidate' }); continue; }
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

/** 되돌리기 — 후보 판정을 요구하지 않는다(비상구는 잠그지 않는다).
 *  ⚠ 전체 빌드가 지나 `tab_configs` 행이 아카이브되며 삭제됐다면 여기서 되돌릴 대상이 없다
 *    (0건 반환) — 그때는 아카이브 복구를 쓴다. 0건을 "되돌렸다"고 꾸미지 않는다. */
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
