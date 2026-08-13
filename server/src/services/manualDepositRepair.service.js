'use strict';

// One-time recovery for the 8/11 manual exclusion markers.  The edit history
// is intentionally read even when a marker was later reverted: the purpose is
// to materialize the historical payment date, not to re-enable target blocking.
const pool = require('../db/pool');
const { markDepositCells } = require('./paymentApply.service');
const { rebuildLedgers } = require('./sheetlessLedger.service');
const { mergeDepositStamps, removeDepositStamp } = require('../utils/depositStamp');

class ManualDepositRepairError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function _seqs(values, label) {
  if (!Array.isArray(values) || !values.length) {
    throw new ManualDepositRepairError('bad_request', `${label} 순번을 입력해 주세요.`);
  }
  const seqs = values.map(v => Number(v));
  if (seqs.some(v => !Number.isInteger(v) || v < 1) || new Set(seqs).size !== seqs.length) {
    throw new ManualDepositRepairError('bad_request', `${label} 순번이 올바르지 않거나 중복되었습니다.`);
  }
  return seqs;
}

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

// Controlled support operation for a verified pair of row groups.  It is
// intentionally fail-closed: populated destinations, missing source dates,
// non-sheetless tabs, and partial row lookups all abort before any write.
async function moveDepositDateBetweenRows({ sheetId, tabName, sourceSeqs, targetSeqs, date, by = 'payment-repair' } = {}) {
  if (!sheetId || !tabName || !String(date || '').trim()) {
    throw new ManualDepositRepairError('bad_request', '작업과 이동할 입금일을 확인해 주세요.');
  }
  const from = _seqs(sourceSeqs, '기존');
  const to = _seqs(targetSeqs, '대상');
  if (from.length !== to.length || from.some(seq => to.includes(seq))) {
    throw new ManualDepositRepairError('bad_request', '기존/대상 순번은 같은 수여야 하며 서로 겹칠 수 없습니다.');
  }

  const client = await pool.connect();
  let depositColKey;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`manual_deposit_move:${sheetId}:${tabName}`]);
    const { rows: configRows } = await client.query(
      `SELECT COALESCE(tc.sheetless, FALSE) AS sheetless,
              COALESCE(MAX(NULLIF(ri.submit_col2, '')), '') AS deposit_col_key
         FROM tab_configs tc
         LEFT JOIN review_index ri ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
        WHERE tc.sheet_id = $1 AND tc.tab_name = $2
        GROUP BY tc.sheetless`, [sheetId, tabName]);
    if (!configRows.length) throw new ManualDepositRepairError('tab_not_registered', '등록된 작업을 찾지 못했습니다.');
    if (!configRows[0].sheetless) throw new ManualDepositRepairError('not_sheetless', '시트 기반 작업은 이 수동 정정을 사용할 수 없습니다.');
    depositColKey = configRows[0].deposit_col_key;
    if (!depositColKey) throw new ManualDepositRepairError('deposit_column_missing', '입금 컬럼을 찾지 못했습니다.');

    const requested = [...from, ...to];
    const { rows } = await client.query(
      `SELECT id::text AS id, seq, COALESCE(row_json ->> $4, '') AS paid_value
         FROM campaign_participants
        WHERE sheet_id = $1 AND tab_name = $2
          AND seq = ANY($3::int[]) AND deleted_at IS NULL AND active = TRUE
        FOR UPDATE`, [sheetId, tabName, requested, depositColKey]);
    if (rows.length !== requested.length) {
      throw new ManualDepositRepairError('participant_mismatch', '요청한 작업보드 행을 모두 찾지 못했습니다.');
    }
    const bySeq = new Map(rows.map(row => [Number(row.seq), row]));
    const sourceRows = from.map(seq => bySeq.get(seq));
    const targetRows = to.map(seq => bySeq.get(seq));
    const sourceUpdates = sourceRows.map(row => ({ row, value: removeDepositStamp(row.paid_value, date) }));
    if (sourceUpdates.some(({ row, value }) => value === String(row.paid_value || '').trim() || !value)) {
      throw new ManualDepositRepairError('source_date_missing', `기존 행에 ${date} 입금일이 없거나 남길 입금일이 없습니다.`);
    }
    if (targetRows.some(row => String(row.paid_value || '').trim())) {
      throw new ManualDepositRepairError('target_not_blank', '대상 행 중 비어 있지 않은 입금칸이 있어 이동을 중단했습니다.');
    }
    const targetValue = mergeDepositStamps('', date);
    for (const { row, value } of sourceUpdates) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2, $3),
                updated_at = NOW(), updated_by = $4
          WHERE id = $1`, [row.id, depositColKey, value, by]);
    }
    for (const row of targetRows) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2, $3),
                updated_at = NOW(), updated_by = $4
          WHERE id = $1`, [row.id, depositColKey, targetValue, by]);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  // The participant row_json write above is the workboard source of truth.
  // Ledger rebuild can touch every row in a large tab, so do not hold the
  // operator's correction dialog open behind it.  Let it continue after a
  // short budget and expose that fact to the caller.
  const ledgerPromise = rebuildLedgers({ sheetId, tabName, by: `manual-deposit-move:${by}` });
  let ledger = null;
  let ledgerError = null;
  let ledgerDeferred = false;
  const ledgerState = await Promise.race([
    ledgerPromise.then(value => ({ value }), err => ({ err })),
    new Promise(resolve => setTimeout(() => resolve({ deferred: true }), 8000)),
  ]);
  if (ledgerState.deferred) {
    ledgerDeferred = true;
    ledgerPromise.catch(() => {}); // result is already persisted; background rebuild is best-effort.
  } else if (ledgerState.err) {
    ledgerError = (ledgerState.err && (ledgerState.err.code || ledgerState.err.message)) || 'rebuild_failed';
  } else {
    ledger = ledgerState.value;
  }
  const { rows: verified } = await pool.query(
    `SELECT seq, COALESCE(row_json ->> $4, '') AS paid_value
       FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2 AND seq = ANY($3::int[])
      ORDER BY seq`, [sheetId, tabName, [...from, ...to], depositColKey]);
  const verifiedBySeq = new Map(verified.map(row => [Number(row.seq), String(row.paid_value || '').trim()]));
  const sourceRemoved = from.filter(seq => removeDepositStamp(verifiedBySeq.get(seq), date) === verifiedBySeq.get(seq)).length;
  const targetRecorded = to.filter(seq => verifiedBySeq.get(seq) === targetValue).length;
  return {
    ok: true, moved: from.length, date: targetValue,
    sourceSeqs: from, targetSeqs: to,
    sourceRemoved, targetRecorded,
    ledgerRebuilt: !!ledger, ledgerDeferred, ledgerError,
  };
}

module.exports = { restoreManual811DepositDates, moveDepositDateBetweenRows, ManualDepositRepairError };
