/**
 * sheetlessOrphanCleanup.service.js — 무시트 접수 실패 잔재(빈 가상 탭) 정리
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 있나 (2026-08-19 실사고 「8/19)유일기획_쿠팡_암막커튼 20건」 작업바 11줄)
 *
 *   무시트 접수가 호출마다 **랜덤 가상 시트ID**를 발급하던 동안, 접수 처리의 마지막 단계
 *   (`work_orders.linked_tab_*` 기록) **전에** 빠져나가는 경로(광고주 연결 409 · 쿼리 예외)
 *   에서는 `campaigns`·`tab_configs` 줄만 남고 링크는 안 걸렸다 → 재시도마다 탭이 하나씩
 *   늘어 같은 이름이 여러 줄 보였다. 원인은 결정적 시트ID 파생으로 막았고(재발 차단),
 *   **이미 만들어진 잔재**를 사람이 화면에서 치우는 창구가 이 서비스다.
 *
 * ★★ 조작은 `tab_configs.is_closed = TRUE` **한 칸뿐** — 데이터를 지우지 않는다.
 *   되돌리기 = 그 칸을 FALSE 로. `campaigns`·장부·작업표·주문은 손대지 않는다.
 *   (그래서 오판해도 잃는 것이 없다 = 이 기능의 안전 근거)
 *
 * ★★ 판정은 fail-closed — "어디에도 쓰이지 않는 빈 가상 탭"만 고른다. 아래 조건 중
 *   하나라도 못 세면 그 탭은 후보에서 빠진다(모르면 건드리지 않는다).
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');
const { VIRTUAL_SHEET_PREFIX } = require('./sheetlessAccept.service');

let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }
function __setPoolForTest(p) { _pool = p; }

/**
 * ★ 유예 시간 — 방금 접수 중인 탭은 "줄이 아직 없는" 순간이 있다(등록 → 작업표 persist 사이).
 *   그 창을 잔재로 오인하면 진행 중인 접수를 닫아버린다. 그래서 오래된 것만 본다.
 */
const GRACE_MINUTES = 60;

/**
 * 잔재 후보 조회 (읽기 전용 — 쓰기 쿼리 0).
 *
 * 후보 조건(전부 AND):
 *   ① 무시트 표식이 켜져 있고 아직 마감 안 됨          (`sheetless` · `is_closed=FALSE`)
 *   ② **가상 시트ID**(`wt_` 접두)                       ← 진짜 구글시트 탭은 절대 대상 아님
 *   ③ 작업표 활성 줄 0 · 검색 명단 0 · 주문 0           ← 사람 데이터가 한 줄도 없다
 *   ④ 어떤 작업오더도 이 시트를 연결하고 있지 않다      ← 접수 성공한 진짜 탭 보호
 *   ⑤ 어떤 모집공고도 이 시트를 연결하고 있지 않다      ← 발행된 공고의 연결 탭 보호
 *   ⑥ 정산 계약 링크가 없다                             ← 사람이 매칭해 둔 탭 보호
 *   ⑦ 마지막 갱신이 GRACE_MINUTES 이전                  ← 진행 중 접수와의 경합 차단
 *   ⑧ 등록부(index_master)에 활성 행 없음                ← 닫아도 목록에 남는 탭은 후보 아님
 */
async function findOrphanTabs({ limit = 200 } = {}) {
  const db = _db();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const { rows } = await db.query(
    `SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName", tc.tab_gid AS "tabGid",
            COALESCE(NULLIF(tc.display_name,''), NULLIF(tc.campaign_name,''), tc.tab_name) AS "displayName",
            tc.updated_at AS "updatedAt",
            (SELECT COUNT(*) FROM tab_configs sib
              WHERE sib.tab_name = tc.tab_name AND sib.sheet_id <> tc.sheet_id) AS "siblings"
       FROM tab_configs tc
      WHERE COALESCE(tc.sheetless, FALSE) = TRUE
        AND COALESCE(tc.is_closed, FALSE) = FALSE
        AND tc.sheet_id LIKE $1 || '%'
        AND tc.updated_at < NOW() - ($2 || ' minutes')::interval
        AND NOT EXISTS (SELECT 1 FROM campaign_participants p
                         WHERE p.sheet_id = tc.sheet_id AND p.tab_name = tc.tab_name
                           AND p.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM review_index ri
                         WHERE ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name)
        AND NOT EXISTS (SELECT 1 FROM order_submissions os
                         WHERE os.sheet_id = tc.sheet_id AND os.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM work_orders wo
                         WHERE wo.linked_tab_sheet_id = tc.sheet_id AND wo.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM recruit_campaigns rc
                         WHERE rc.linked_sheet_id = tc.sheet_id)
        AND NOT EXISTS (SELECT 1 FROM trackb_settlement_links sl
                         WHERE sl.sheet_id = tc.sheet_id AND sl.deleted_at IS NULL)
        -- ★★ 등록부(index_master)에 활성 행이 있으면 목록의 다른 경로(raw_tabs ∩ index_master)로
        --   계속 보인다 → 닫아도 화면이 안 바뀌는 "정리했는데 그대로" 상태가 된다. 그런 탭은
        --   후보에서 빼고 건수에 그대로 드러낸다(조용한 no-op 금지).
        AND NOT EXISTS (SELECT 1 FROM index_master im
                         WHERE im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
                           AND im.status = 'active')
      ORDER BY tc.tab_name, tc.updated_at
      LIMIT $3`,
    [VIRTUAL_SHEET_PREFIX, String(GRACE_MINUTES), lim]
  );
  return {
    ok: true, total: rows.length, graceMinutes: GRACE_MINUTES,
    truncated: rows.length >= lim,
    items: rows.map(r => ({
      sheetId: r.sheetId, tabName: r.tabName, tabGid: r.tabGid || '',
      displayName: r.displayName || r.tabName,
      updatedAt: r.updatedAt,
      // ★ 같은 이름의 다른 탭 수 — "이건 중복 잔재다"를 사람이 확인할 근거(0이어도 후보는 후보다:
      //   위 조건대로 어디에도 쓰이지 않는 빈 탭이므로 목록에서 내려도 잃는 것이 없다).
      siblings: Number(r.siblings || 0),
    })),
  };
}

/**
 * 잔재 정리 — 후보를 **서버가 다시 골라** 그 중에서만 닫는다(화면이 보낸 목록 불신).
 *
 * @param {object} o
 * @param {boolean} [o.dryRun=true]   기본 미리보기(쓰기 0)
 * @param {string[]} [o.sheetIds]     지정하면 그 시트만(후보 교집합) — 미지정 = 후보 전부
 */
async function closeOrphanTabs({ dryRun = true, sheetIds = null, by = '' } = {}) {
  const found = await findOrphanTabs({ limit: 500 });
  let items = found.items;
  if (Array.isArray(sheetIds) && sheetIds.length) {
    const want = new Set(sheetIds.map(s => String(s)));
    items = items.filter(t => want.has(t.sheetId));   // ★ 교집합 — 후보 밖은 절대 닫지 않는다
  }
  if (dryRun) return { ok: true, dryRun: true, total: items.length, items };
  if (!items.length) return { ok: true, dryRun: false, closed: 0, total: 0, items };

  const db = _db();
  let closed = 0;
  for (const t of items) {
    // ★ 조건을 UPDATE 에도 다시 건다(TOCTOU — 조회 직후 누군가 그 탭을 쓰기 시작했을 수 있다).
    const { rowCount } = await db.query(
      `UPDATE tab_configs SET is_closed = TRUE, updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2
          AND COALESCE(sheetless, FALSE) = TRUE
          AND COALESCE(is_closed, FALSE) = FALSE
          AND NOT EXISTS (SELECT 1 FROM campaign_participants p
                           WHERE p.sheet_id = tab_configs.sheet_id
                             AND p.tab_name = tab_configs.tab_name AND p.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM work_orders wo
                           WHERE wo.linked_tab_sheet_id = tab_configs.sheet_id AND wo.deleted_at IS NULL)`,
      [t.sheetId, t.tabName]
    );
    if (rowCount) closed++;
  }
  logger.warn(`[orphanCleanup] 무시트 잔재 탭 ${closed}/${items.length}건 목록에서 내림 by=${by} ` +
    `(데이터 삭제 0 — is_closed=TRUE 만, 되돌리기 가능)`);
  return { ok: true, dryRun: false, closed, total: items.length, items };
}

module.exports = { findOrphanTabs, closeOrphanTabs, GRACE_MINUTES, __setPoolForTest };
