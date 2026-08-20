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
/* ★ 시트 주소 조립은 `payment.service.tabSheetUrl` 단일 출처 — 가상 시트ID(`wt_`)면 빈 값이다
   (빈 링크 > 죽은 링크, 레포 규율). 화면이 sheetId 로 직접 조립하면 그 판정이 사라진다. */
const { tabSheetUrl } = require('./payment.service');

/* ★★ `db/pool` 은 **풀 자체를 export** 한다(`module.exports = pool`) — `{ getPool }` 로 구조분해하면
   undefined 라 호출 순간 TypeError → 마스킹된 500("서버 오류가 발생했습니다") 이 된다.
   레포 관용구는 지연 require(순환참조 회피). 실측으로 밟았다(2026-08-19). */
let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }

const LIST_CAP = 300;      // 목록 상한(초과분은 건수로만 — 조용히 자르지 않는다)
const NAME_CAP = 5;        // 시트당 보여줄 탭 이름 수
const ERROR_CAP = 5;       // 시트당 보여줄 실패 사유 묶음 수(초과분은 건수로만)
const ERROR_TEXT_CAP = 200;// 사유 문자열 상한 — 시트 API 원문이 길다

/**
 * ★★ 미반영 주문의 상태는 **두 부류로 갈린다 — 뭉뚱그리면 판단이 뒤집힌다** (2026-08-20 실측).
 *   ㉮ **크론이 재시도하는 상태**(`reconcileStuckOrders` 의 WHERE 절과 같은 목록) — 주기 작업을 끄면
 *      그 재시도가 멈추므로 "끄면 영영 안 써진다" 가 사실이다.
 *   ㉯ **크론이 아예 손대지 않는 상태**(`conflict`·`stuck_manual`·`canceled_sheet_dirty`) — reconcile 이
 *      제외하므로 **켜 둬도 영영 안 풀린다**. 사람이 처리해야 하는 건이고, 크론 정지와는 무관하다.
 *      특히 `conflict` 는 `order_update` 가 **이미 written 된 행**의 편집을 반영하려다 그 칸을 사람이
 *      다르게 고쳐 놔 안전정지한 것이라 — **주문 자체는 시트에 이미 기록돼 있다**(주문 유실 아님).
 * ★ 둘을 합쳐 "못 쓴 주문 N건"으로만 말하면 "크론을 끄면 안 된다"는 **틀린 결론**을 준다.
 * ★★ 목록은 reconcile SQL 과 **회귀가드가 대조**한다(사본이 조용히 갈라지는 자리).
 */
const RETRYABLE_STATUSES = ['pending', 'queued', 'failed', 'pending_no_row'];

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
      reading: 0, byReason: {}, reasons: REASONS,
      pendingOrdersTotal: 0, pendingByStatus: {}, pendingRetryable: 0, pendingManual: 0,
      retryableStatuses: RETRYABLE_STATUSES, items: [], truncated: false,
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

  /* ⑤ 미반영 주문 — ★ 이게 있으면 크론을 끄면 그 주문이 시트에 영영 안 써진다(끄기 전 확인용).
     ★★ **건수만으로는 판단이 안 된다** — 상태와 나이를 함께 센다:
        `stuck_manual` 은 reconcile 이 제외하므로 **재기록으로 영영 안 풀린다**(사람이 처리해야 한다),
        `pending`/`queued` 는 지금 처리 중일 수 있고, 몇 달 전 `failed` 는 마감 전 잔재다.
     ★ 나이는 **최근/최오래 제출 시각**으로 준다(임의 구간을 나누면 그게 또 하나의 판정 사본이 된다). */
  const { rows: pendRows } = await db.query(
    `SELECT sheet_id AS "sheetId",
            COALESCE(mirror_status, 'pending') AS "status",
            COUNT(*)::int AS n,
            MIN(submitted_at) AS "oldest", MAX(submitted_at) AS "newest"
       FROM order_submissions
      WHERE sheet_id = ANY($1::text[]) AND deleted_at IS NULL
        AND COALESCE(mirror_status, 'pending') <> 'written'
      GROUP BY sheet_id, COALESCE(mirror_status, 'pending')`, [reading]);
  const pendMap = new Map();       // sheetId → { n, byStatus, oldest, newest }
  const pendingByStatus = {};      // 전체 합계(화면 머리줄)
  for (const r of pendRows) {
    const cur = pendMap.get(r.sheetId) || { n: 0, byStatus: {}, oldest: null, newest: null };
    cur.n += r.n;
    cur.byStatus[r.status] = (cur.byStatus[r.status] || 0) + r.n;
    if (r.oldest && (!cur.oldest || r.oldest < cur.oldest)) cur.oldest = r.oldest;
    if (r.newest && (!cur.newest || r.newest > cur.newest)) cur.newest = r.newest;
    pendMap.set(r.sheetId, cur);
    pendingByStatus[r.status] = (pendingByStatus[r.status] || 0) + r.n;
  }

  /* ⑤-2 실패 사유 — ★ **재시도 대상 상태만** 본다.
     그 밖(`conflict`·`stuck_manual`)은 크론이 손대지 않으므로 "왜 아직 못 썼나"의 답이 아니고,
     `conflict` 의 `sheet_error` 에는 **시트 셀 원문**이 실려 있어 굳이 화면으로 끌어올 이유가 없다.
     ★ 사유는 그대로 세어 보여줄 뿐 분류하지 않는다(사유 표를 만들면 그게 또 하나의 판정 사본이 된다). */
  const { rows: errRows } = await db.query(
    `SELECT sheet_id AS "sheetId",
            COALESCE(NULLIF(tab_name, ''), '(탭 미상)') AS "tabName",
            LEFT(COALESCE(NULLIF(sheet_error, ''), '(사유 기록 없음)'), $3::int) AS "error",
            COUNT(*)::int AS n,
            MIN(submitted_at) AS "oldest", MAX(submitted_at) AS "newest"
       FROM order_submissions
      WHERE sheet_id = ANY($1::text[]) AND deleted_at IS NULL
        AND COALESCE(mirror_status, 'pending') = ANY($2::text[])
      GROUP BY 1, 2, 3
      ORDER BY n DESC`, [reading, RETRYABLE_STATUSES, ERROR_TEXT_CAP]);
  const errMap = new Map();        // sheetId -> { list, moreGroups, moreOrders }
  for (const r of errRows) {
    const cur = errMap.get(r.sheetId) || { list: [], moreGroups: 0, moreOrders: 0 };
    if (cur.list.length < ERROR_CAP) {
      cur.list.push({ tabName: r.tabName, error: r.error, n: r.n, oldest: r.oldest, newest: r.newest });
    } else { cur.moreGroups += 1; cur.moreOrders += r.n; }   // 조용히 자르지 않는다
    errMap.set(r.sheetId, cur);
  }

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
    const pend = pendMap.get(sheetId) || null;
    const pending = pend ? pend.n : 0;
    pendingOrdersTotal += pending;
    if (items.length < lim) {
      items.push({
        sheetId, reason, reasonText: REASONS[reason],
        tabs: tc ? tc.tabs : 0,
        sheetlessTabs: tc ? tc.sheetlessTabs : 0,
        liveSheetTabs: tc ? tc.liveSheetTabs : 0,
        closedSheetTabs: tc ? tc.closedSheetTabs : 0,
        sheetUrl: tabSheetUrl({ sheetId }),
        liveTabNames: nameMap.get(sheetId) || [],
        pendingOrders: pending,
        pendingByStatus: pend ? pend.byStatus : {},
        pendingErrors: (errMap.get(sheetId) || { list: [] }).list,
        pendingErrorsMoreGroups: (errMap.get(sheetId) || {}).moreGroups || 0,
        pendingErrorsMoreOrders: (errMap.get(sheetId) || {}).moreOrders || 0,
        pendingOldest: pend ? pend.oldest : null,
        pendingNewest: pend ? pend.newest : null,
        mirroredAt: mirMap.get(sheetId) || null,
      });
    }
  }
  // 조치가 필요한 순서로: 시트 작업 살아 있음 → 마감만 → campaigns 만, 그 안에서 미반영 주문 많은 순
  const rank = { sheet_tab_live: 0, closed_only: 1, campaigns_only: 2 };
  items.sort((a, b) => (rank[a.reason] - rank[b.reason]) || (b.pendingOrders - a.pendingOrders));

  let pendingRetryable = 0, pendingManual = 0;
  for (const [st, n] of Object.entries(pendingByStatus)) {
    if (RETRYABLE_STATUSES.includes(st)) pendingRetryable += n; else pendingManual += n;
  }

  return {
    ok: true,
    registered: all.length,
    excludedSheetless: all.length - reading.length,
    reading: reading.length,
    byReason, reasons: REASONS,
    pendingOrdersTotal, pendingByStatus, pendingRetryable, pendingManual,
    retryableStatuses: RETRYABLE_STATUSES,
    items,
    truncated: reading.length > items.length,
  };
}

module.exports = { readScope, REASONS, LIST_CAP, RETRYABLE_STATUSES, ERROR_CAP };
