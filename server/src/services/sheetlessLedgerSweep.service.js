'use strict';
/**
 * sheetlessLedgerSweep.service.js — 무시트 장부 재생성 스윕(132).
 *
 * ★ 편집 tx 는 `tab_configs.ledger_dirty_at` 만 찍는다 → 여기서 **탭당 1회** 재생성한다.
 *   (붙여넣기 500칸 = rebuild 1회. 종전처럼 편집마다 즉시 rebuild 하면 같은 advisory lock 에
 *    주문 유입·리뷰 제출 기록이 줄 서서 리뷰어 제출이 지연된다.)
 * ★ 실패하면 dirty 를 지우지 않는다 = 자가치유(조용한 유실 없음).
 * ★ 재생성 **시작 이후** 들어온 편집의 dirty 는 지우지 않는다(`<= $3`) — 지우면 그 편집이 유실된다.
 */
const { logger } = require('../utils/logger');

const DEBOUNCE_SEC = Number(process.env.SHEETLESS_LEDGER_DEBOUNCE_SEC || 20);
const CAP = Number(process.env.SHEETLESS_LEDGER_SWEEP_CAP || 20);

/**
 * @param {object} o
 * @param {boolean} [o.force]  디바운스를 건너뛴다(사람이 누른 수동 실행 — 크론이 없는 환경의 창구)
 */
async function sweepDirtyLedgers({ by = 'ledger-sweep', force = false } = {}) {
  if (process.env.SHEETLESS_LEDGER_SWEEP === '0') return { skipped: true, reason: 'disabled' };
  const db = require('../db/pool');
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", ledger_dirty_at AS "dirtyAt"
         FROM tab_configs
        WHERE COALESCE(sheetless, FALSE) = TRUE
          AND ledger_dirty_at IS NOT NULL
          AND ($3 OR ledger_dirty_at < NOW() - ($1 || ' seconds')::interval)
        ORDER BY ledger_dirty_at
        LIMIT $2`, [String(DEBOUNCE_SEC), CAP, !!force]));
  } catch (e) { logger.warn(`[ledgerSweep] 조회 실패: ${e.message}`); return { error: e.message }; }

  let done = 0, failed = 0;
  for (const t of rows) {
    try {
      await require('./sheetlessLedger.service').rebuildLedgers({ sheetId: t.sheetId, tabName: t.tabName, by });
      await db.query(
        `UPDATE tab_configs SET ledger_dirty_at = NULL
          WHERE sheet_id = $1 AND tab_name = $2 AND ledger_dirty_at <= $3`,
        [t.sheetId, t.tabName, t.dirtyAt]);
      done++;
    } catch (e) { failed++; logger.warn(`[ledgerSweep] ${t.tabName} 재생성 실패(dirty 유지): ${e.message}`); }
  }
  if (rows.length) logger.info(`[ledgerSweep] 후보 ${rows.length} · 완료 ${done} · 실패 ${failed}`);
  /* ★ 남은 대기(dirty)를 함께 보고한다 — 실패가 로그에만 남으면 담당자가 알 길이 없다.
     화면·운영자가 "장부 반영이 밀리고 있다"를 숫자로 볼 수 있어야 한다. */
  let pending = null, oldestWaitSec = null;
  try {
    const { rows: p } = await db.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(ledger_dirty_at)))::int, 0) AS wait
         FROM tab_configs
        WHERE COALESCE(sheetless, FALSE) = TRUE AND ledger_dirty_at IS NOT NULL`);
    pending = p[0] ? p[0].n : null;
    oldestWaitSec = p[0] ? p[0].wait : null;
  } catch (_) { /* 관측 실패는 스윕 결과를 바꾸지 않는다 */ }
  return { candidates: rows.length, done, failed, pending, oldestWaitSec };
}

module.exports = { sweepDirtyLedgers };
