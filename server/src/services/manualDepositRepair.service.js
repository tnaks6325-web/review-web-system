'use strict';

// One-time recovery for the 8/11 manual exclusion markers.  The edit history
// is intentionally read even when a marker was later reverted: the purpose is
// to materialize the historical payment date, not to re-enable target blocking.
const pool = require('../db/pool');
const { markDepositCells } = require('./paymentApply.service');
const { rebuildLedgers } = require('./sheetlessLedger.service');

async function restoreManual811DepositDates({ by = 'payment-repair' } = {}) {
  const { rows } = await pool.query(
    `WITH marked AS (
       SELECT DISTINCT pe.sheet_id, pe.tab_name, pe.anchor_type, pe.anchor_value
         FROM participant_edits pe
        WHERE pe.field = 'col:입금' AND pe.kind = 'text'
          AND btrim(pe.value_text) = '8/11'
     ), resolved AS (
       SELECT DISTINCT cp.sheet_id, cp.tab_name, cp.seq AS row_index
         FROM marked pe
         JOIN campaign_participants cp
           ON cp.sheet_id = pe.sheet_id AND cp.tab_name = pe.tab_name
          AND cp.deleted_at IS NULL AND cp.active = TRUE
          AND ((pe.anchor_type = 'order' AND cp.order_submission_id::text = pe.anchor_value)
            OR (pe.anchor_type = 'manual' AND cp.id::text = pe.anchor_value)
            OR (pe.anchor_type = 'identity' AND cp.identity_key = pe.anchor_value))
     )
     SELECT r.sheet_id AS "sheetId", r.tab_name AS "tabName", r.row_index AS "rowIndex",
            ri.submit_col2 AS "depositColKey", ri.tab_gid AS gid,
            COALESCE(tc.sheetless, FALSE) AS sheetless
       FROM resolved r
       JOIN review_index ri
         ON ri.sheet_id = r.sheet_id AND ri.tab_name = r.tab_name AND ri.row_index = r.row_index
       LEFT JOIN tab_configs tc ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
      WHERE COALESCE(ri.submit_col2, '') <> ''
      ORDER BY r.sheet_id, r.tab_name, r.row_index`);

  const items = rows.map(r => ({ ...r, stamp: '8/11' }));
  const board = await markDepositCells(items, { by, deferSheetlessRebuild: true });
  const sheetlessTabs = [...new Map(items.filter(x => x.sheetless)
    .map(x => [`${x.sheetId}\t${x.tabName}`, x])).values()];
  for (const tab of sheetlessTabs) {
    await rebuildLedgers({ sheetId: tab.sheetId, tabName: tab.tabName, by });
  }
  return { ok: true, candidates: items.length, stamp: '8/11', rebuiltTabs: sheetlessTabs.length, ...board };
}

module.exports = { restoreManual811DepositDates };
