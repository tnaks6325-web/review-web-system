/**
 * closedRounds.service.js — 차수 단위 마감·아카이브 판정/집행 **단일 출처**
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 있나 (2026-08-24)
 *   차수 마감(`tab_configs.closed_rounds`, migration 010)·차수 아카이브
 *   (`archived_rounds`, 012)는 **시트 경로(`indexBuilder`)에만** 집행돼 있었다.
 *   무시트 작업표의 장부 재생성(`sheetlessLedger.rebuildLedgers`)은
 *   `review_index` 를 통째로 지우고 **활성 줄 전부를 다시 넣으면서** 그 두 칸을
 *   한 번도 읽지 않았다.
 *
 *   → 무시트 작업에서 차수를 아카이브하면 **화면은 성공했다고 말하고**
 *      다음 장부 재생성이 **그대로 되살린다**(조용한 no-op). 이것이
 *      2026-08-07 쿠팡 이관 때 명단이 50명 → 216명으로 부푼 것과
 *      **같은 메커니즘**이다. `archive.routes` 에는 무시트 제외 필터가
 *      한 곳도 없어 무시트 탭도 아카이브 목록에 뜨고 눌린다.
 *
 * ★★ 그래서 **판정과 집행을 여기 한 벌**로 모으고 두 경로가 같이 쓴다.
 *    사본을 두면 "시트에서는 빠지는데 무시트에서는 되살아나는" 드리프트가
 *    그대로 남는다(이 파일이 존재하는 이유가 곧 그 사고다).
 *
 * ★ 기록은 지우지 않는다 — 제외되는 행은 `review_index_archive` 로 **옮긴다**.
 *   구매기록(`order_submissions`)·작업표 줄(`campaign_participants`)·Drive 는
 *   애초에 이 서비스의 사정거리 밖이다(검색 명단만 다룬다).
 * ★ fail-soft — 아카이브 이동이 실패해도 빌드/장부 재생성을 죽이지 않는다.
 *   다만 **조용히 넘기지 않고** 사유를 로그로 남긴다.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');

let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }
function __setPoolForTest(p) { _pool = p || null; }

/** 쉼표 구분 문자열 → 정리된 차수 목록 (빈 값·공백 제거) */
function parseRoundList(raw) {
  return String(raw == null ? '' : raw).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * 제외할 차수 집합 — `closed_rounds` ∪ `archived_rounds`.
 * @param {{closed_rounds?:string, archived_rounds?:string}} tabConfig
 * @returns {string[]} 중복 없는 차수 목록(빈 배열 = 제외 대상 없음)
 */
function excludedRounds(tabConfig) {
  const closed = parseRoundList(tabConfig && tabConfig.closed_rounds);
  const archived = parseRoundList(tabConfig && tabConfig.archived_rounds);
  return [...new Set([...closed, ...archived])];
}

/** 탭 하나의 마감·아카이브 차수를 DB 에서 읽는다. 조회 실패는 **빈 배열**(제외 없음). */
async function loadExcludedRounds({ sheetId, tabName, db = null } = {}) {
  if (!sheetId || !tabName) return [];
  try {
    const { rows } = await (db || _db()).query(
      `SELECT closed_rounds, archived_rounds FROM tab_configs
        WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1`, [sheetId, tabName]);
    return rows.length ? excludedRounds(rows[0]) : [];
  } catch (err) {
    /* ★ fail-open(제외 없음) — 못 읽었다고 명단에서 사람을 빼면 안 된다.
       빼는 쪽이 아니라 **남기는 쪽**으로 접는다(조용한 실종 금지). */
    logger.warn(`[closedRounds] 차수 설정 조회 실패(제외 없이 진행) ${tabName}: ${err.message}`);
    return [];
  }
}

/** 파싱된 행 목록에서 제외 차수 행을 걸러낸다(판정 한 곳). */
function filterRows(rows, exclude) {
  if (!Array.isArray(rows) || !exclude || !exclude.length) return rows;
  const set = new Set(exclude.map(String));
  return rows.filter(r => !set.has(String(r && r.round == null ? '' : r.round)));
}

/**
 * 마감·아카이브된 차수의 기존 `review_index` 행을 `review_index_archive` 로 옮기고 원본에서 지운다.
 *
 * ★ 이미 아카이브된 행은 다시 넣지 않는다(NOT EXISTS).
 * ★ 이동에 실패해도 삭제는 하지 않는다 — 그 차수는 이번 회차에 그대로 남고 다음에 다시 시도한다
 *   (원장이 없는 채로 명단에서만 사라지는 상태를 만들지 않는다).
 * @returns {Promise<{moved:number, deleted:number, failed:number}>}
 */
async function archiveExcludedRounds({ sheetId, tabName, exclude, db = null, by = 'build' } = {}) {
  const out = { moved: 0, deleted: 0, failed: 0 };
  if (!sheetId || !tabName || !exclude || !exclude.length) return out;
  const q = db || _db();

  for (const cr of exclude) {
    try {
      const { rowCount: movedCount } = await q.query(
        `INSERT INTO review_index_archive
           (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
            row_index, is_submitted, is_submitted2, product_url, product_name,
            submit_col, submit_col2, row_json, start_date, end_date,
            round, phone8, built_at, archived_at)
         SELECT ri.reviewer_name, ri.sheet_id, ri.tab_gid, ri.tab_name, ri.campaign_name,
                ri.row_index, ri.is_submitted, ri.is_submitted2, ri.product_url, ri.product_name,
                ri.submit_col, ri.submit_col2, ri.row_json, ri.start_date, ri.end_date,
                ri.round, ri.phone8, ri.built_at, NOW()
           FROM review_index ri
          WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.round = $3
            AND NOT EXISTS (
              SELECT 1 FROM review_index_archive ria
               WHERE ria.sheet_id = ri.sheet_id AND ria.tab_name = ri.tab_name
                 AND ria.row_index = ri.row_index
            )`, [sheetId, tabName, cr]);

      const { rowCount: deletedCount } = await q.query(
        `DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND round = $3`,
        [sheetId, tabName, cr]);

      out.moved += movedCount || 0;
      out.deleted += deletedCount || 0;
      if (movedCount > 0 || deletedCount > 0) {
        logger.info(`[closedRounds] 마감 차수 아카이브(${by}): ${tabName}/${cr} — ${movedCount}행 이동, ${deletedCount}행 삭제`);
      }
    } catch (err) {
      out.failed++;
      logger.warn(`[closedRounds] 마감 차수 아카이브 실패(${by}) ${tabName}/${cr}: ${err.message}`);
    }
  }
  return out;
}

module.exports = {
  parseRoundList,
  excludedRounds,
  loadExcludedRounds,
  filterRows,
  archiveExcludedRounds,
  __setPoolForTest,
};
