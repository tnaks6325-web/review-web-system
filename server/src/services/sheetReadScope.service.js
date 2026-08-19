'use strict';
/**
 * sheetReadScope.service.js — "지금 구글시트를 **어느 시트에서 왜** 읽고 있는가"의 읽기 전용 진단.
 *
 * ★★ 왜 필요한가(2026-08-19 실측): 탈시트 전환 화면의 "남음 0" 과 실제 시트 API 호출이 어긋났다.
 *   그 화면은 `is_closed=FALSE` + 연도 필터를 통과한 탭만 세는데, 주기 스윕(RAW 미러·스마트빌드)은
 *   **`campaigns ∪ tab_configs` 의 시트를 전부** 열거하고 `BOOL_AND(sheetless)` 로만 제외한다.
 *   그래서 아래 셋이 "남음" 에 안 잡히면서 계속 읽힌다:
 *     ㉮ 마감(is_closed) 탭이 섞인 시트 — 그 탭이 `sheetless=FALSE` 면 BOOL_AND 가 깨진다
 *     ㉯ 아카이브만 남은 시트 — `tab_configs` 행이 삭제돼 GROUP BY 그룹 자체가 없다(campaigns 행만 잔존)
 *     ㉰ 연도 필터로 목록에서 빠진 시트 기반 활성 탭
 *   끄기(크론 정지)를 판단하려면 **무엇을 끄면 무엇이 멈추는지**를 먼저 알아야 한다.
 *
 * ★★ 판정 사본 0 — 열거식(`REGISTERED_SHEET_IDS_SQL`)과 제외 게이트(`fullySheetlessSheetIds`)를
 *   스윕이 쓰는 **그 함수/상수 그대로** 태운다. 여기서 조건을 다시 쓰면 진단이 "안 읽는다"고 말하는
 *   시트를 스윕은 계속 읽는 상태가 된다(관측이 거짓말이 되는 자리).
 *
 * ★ 읽기 전용 — 쓰기 쿼리 0 · 구글 시트/Drive API 호출 0(전부 DB 조회).
 */
const { REGISTERED_SHEET_IDS_SQL, fullySheetlessSheetIds } = require('../utils/sheetlessScope');

/* ★★ `db/pool` 은 **풀 자체를 export** 한다(`module.exports = pool`) — `{ getPool }` 로 구조분해하면
   undefined 라 호출 순간 TypeError → 마스킹된 500("서버 오류가 발생했습니다") 이 된다.
   레포 관용구는 지연 require(순환참조 회피). 실측으로 밟았다(2026-08-19). */
let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }

const LIST_CAP = 300;      // 목록 상한(초과분은 건수로만 — 조용히 자르지 않는다)
const NAME_CAP = 5;        // 시트당 보여줄 탭 이름 수

/** 남는 사유 — 화면 문구까지 여기 한 곳(사본 금지). */
const REASONS = {
  sheet_tab_live: '시트 기반 작업이 아직 살아 있음',
  closed_only:    '마감 탭만 남았는데 무시트 표식이 없음',
  campaigns_only: '등록 탭은 없고 시트 등록(campaigns) 행만 남음',
};

/**
 * 지금 스윕이 읽는 시트 목록 + 사유.
 * @returns {Promise<object>} { ok, registered, excludedSheetless, reading, byReason, pendingOrdersTotal, items, truncated }
 */
async function readScope({ limit = LIST_CAP } = {}) {
  const db = _db();
  const lim = Math.min(Math.max(parseInt(limit, 10) || LIST_CAP, 1), LIST_CAP);

  // ① 스윕과 같은 열거 → ② 스윕과 같은 게이트
  const { rows: idRows } = await db.query(REGISTERED_SHEET_IDS_SQL);
  const all = [...new Set(idRows.map(r => r.sheet_id).filter(Boolean))];
  const excluded = await fullySheetlessSheetIds(db);
  const reading = all.filter(id => !excluded.has(id));

  if (!reading.length) {
    return {
      ok: true, registered: all.length, excludedSheetless: all.length - reading.length,
      reading: 0, byReason: {}, reasons: REASONS, pendingOrdersTotal: 0, items: [], truncated: false,
    };
  }

  // ③ 시트별 탭 구성 — 사유 판정 재료
  const { rows: tcRows } = await db.query(
    `SELECT sheet_id AS "sheetId",
            COUNT(*)::int AS tabs,
            COUNT(*) FILTER (WHERE COALESCE(sheetless, FALSE))::int AS "sheetlessTabs",
            COUNT(*) FILTER (WHERE NOT COALESCE(sheetless, FALSE) AND NOT COALESCE(is_closed, FALSE))::int AS "liveSheetTabs",
            COUNT(*) FILTER (WHERE NOT COALESCE(sheetless, FALSE) AND COALESCE(is_closed, FALSE))::int AS "closedSheetTabs"
       FROM tab_configs
      WHERE sheet_id = ANY($1::text[])
      GROUP BY sheet_id`, [reading]);
  const tcMap = new Map(tcRows.map(r => [r.sheetId, r]));

  // ④ 살아 있는 시트 탭 이름(시트당 몇 개만) — "무엇이 남았는지"를 사람이 알아볼 근거
  const { rows: nameRows } = await db.query(
    `SELECT sheet_id AS "sheetId", tab_name AS "tabName", COALESCE(display_name, tab_name) AS "displayName"
       FROM tab_configs
      WHERE sheet_id = ANY($1::text[])
        AND NOT COALESCE(sheetless, FALSE) AND NOT COALESCE(is_closed, FALSE)
      ORDER BY sheet_id, tab_name`, [reading]);
  const nameMap = new Map();
  for (const r of nameRows) {
    const arr = nameMap.get(r.sheetId) || [];
    if (arr.length < NAME_CAP) arr.push(r.displayName || r.tabName);
    nameMap.set(r.sheetId, arr);
  }

  // ⑤ 미반영 주문 — ★ 이게 있으면 크론을 끄면 그 주문이 시트에 영영 안 써진다(끄기 전 확인용)
  const { rows: pendRows } = await db.query(
    `SELECT sheet_id AS "sheetId", COUNT(*)::int AS n
       FROM order_submissions
      WHERE sheet_id = ANY($1::text[]) AND deleted_at IS NULL
        AND COALESCE(mirror_status, 'pending') <> 'written'
      GROUP BY sheet_id`, [reading]);
  const pendMap = new Map(pendRows.map(r => [r.sheetId, r.n]));

  // ⑥ 마지막 미러 시각(그 시트를 실제로 읽고 있다는 증거)
  const { rows: mirRows } = await db.query(
    `SELECT sheet_id AS "sheetId", MAX(mirrored_at) AS "mirroredAt"
       FROM raw_sheet_tabs WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id`, [reading]);
  const mirMap = new Map(mirRows.map(r => [r.sheetId, r.mirroredAt]));

  const byReason = {};
  let pendingOrdersTotal = 0;
  const items = [];
  for (const sheetId of reading) {
    const tc = tcMap.get(sheetId);
    let reason;
    if (!tc) reason = 'campaigns_only';                  // 등록 탭 0 (아카이브로 행이 지워진 시트 포함)
    else if (tc.liveSheetTabs > 0) reason = 'sheet_tab_live';
    else reason = 'closed_only';                         // 남은 시트 탭이 전부 마감
    byReason[reason] = (byReason[reason] || 0) + 1;
    const pending = pendMap.get(sheetId) || 0;
    pendingOrdersTotal += pending;
    if (items.length < lim) {
      items.push({
        sheetId, reason, reasonText: REASONS[reason],
        tabs: tc ? tc.tabs : 0,
        sheetlessTabs: tc ? tc.sheetlessTabs : 0,
        liveSheetTabs: tc ? tc.liveSheetTabs : 0,
        closedSheetTabs: tc ? tc.closedSheetTabs : 0,
        liveTabNames: nameMap.get(sheetId) || [],
        pendingOrders: pending,
        mirroredAt: mirMap.get(sheetId) || null,
      });
    }
  }
  // 조치가 필요한 순서로: 시트 작업 살아 있음 → 마감만 → campaigns 만, 그 안에서 미반영 주문 많은 순
  const rank = { sheet_tab_live: 0, closed_only: 1, campaigns_only: 2 };
  items.sort((a, b) => (rank[a.reason] - rank[b.reason]) || (b.pendingOrders - a.pendingOrders));

  return {
    ok: true,
    registered: all.length,
    excludedSheetless: all.length - reading.length,
    reading: reading.length,
    byReason, reasons: REASONS,
    pendingOrdersTotal,
    items,
    truncated: reading.length > items.length,
  };
}

module.exports = { readScope, REASONS, LIST_CAP };
