'use strict';

// One-time recovery for the final 8/11 manual payment marks.  A reverted edit
// is historical evidence only; it must never be re-materialized as a payment.
const pool = require('../db/pool');
const { markDepositCells } = require('./paymentApply.service');
const { rebuildLedgers } = require('./sheetlessLedger.service');
const { mergeDepositStamps, removeDepositStamp } = require('../utils/depositStamp');
const { extractAmountNumber } = require('../utils/paymentAmount');

// 직전 후보 산출에서 "앵커가 여러 줄"이라 제외한 행들 — 화면·응답이 사실대로 말하기 위한 값이다
// (조용히 빼면 담당자가 "왜 N건이 줄었지"를 알 수 없다).
let _lastAmbiguous = [];

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

async function _manual811Candidates(client) {
  const { rows } = await client.query(
    `WITH marked AS (
       SELECT DISTINCT pe.id::text AS edit_id, pe.sheet_id, pe.tab_name, pe.anchor_type, pe.anchor_value
         FROM participant_edits pe
        WHERE pe.field = 'col:입금' AND pe.kind = 'text' AND pe.reverted_at IS NULL
          AND btrim(pe.value_text) = '8/11'
     ), resolved AS (
       SELECT DISTINCT pe.edit_id, pe.sheet_id, pe.tab_name, pe.anchor_type, pe.anchor_value,
              cp.seq AS row_index, cp.row_json
         FROM marked pe
         JOIN campaign_participants cp
           ON cp.sheet_id = pe.sheet_id AND cp.tab_name = pe.tab_name
          AND cp.deleted_at IS NULL AND cp.active = TRUE
          AND ((pe.anchor_type = 'order' AND cp.order_submission_id::text = pe.anchor_value)
            OR (pe.anchor_type = 'manual' AND cp.id::text = pe.anchor_value)
            OR (pe.anchor_type = 'identity' AND cp.identity_key = pe.anchor_value))
     )
       SELECT r.edit_id AS "editId", r.sheet_id AS "sheetId", r.tab_name AS "tabName", r.row_index AS "rowIndex",
              r.anchor_type AS "anchorType", r.anchor_value AS "anchorValue", r.row_json AS "rowJson",
            ri.submit_col2 AS "depositColKey", ri.tab_gid AS gid,
            COALESCE(tc.sheetless, FALSE) AS sheetless,
            os.price AS "productPrice", os.review_fee_snapshot AS "reviewFeeSnapshot",
            rc.review_fee AS "reviewFee", ri.reviewer_name AS "reviewerName"
       FROM resolved r
       JOIN review_index ri
         ON ri.sheet_id = r.sheet_id AND ri.tab_name = r.tab_name AND ri.row_index = r.row_index
       LEFT JOIN tab_configs tc ON tc.sheet_id = r.sheet_id AND tc.tab_name = r.tab_name
       LEFT JOIN order_submissions os ON os.sheet_id = r.sheet_id AND os.tab_name = r.tab_name
         AND os.sheet_row = r.row_index AND os.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT review_fee FROM recruit_campaigns c
          WHERE c.linked_sheet_id = r.sheet_id AND c.linked_tab_name = r.tab_name
          ORDER BY c.created_at DESC LIMIT 1
       ) rc ON TRUE
      WHERE COALESCE(ri.submit_col2, '') <> ''
      ORDER BY r.sheet_id, r.tab_name, r.row_index`);

  const uniqueRows = [...new Map(rows.map(r => [`${r.sheetId}\t${r.tabName}\t${r.rowIndex}`, r])).values()];
  // ★★ 한 앵커가 여러 줄을 가리키면 그 앵커 전체를 제외한다 (완화 금지 · 2026-08-19 실사고)
  //   `order_submission_id` 는 유니크가 아니고 `identity_key` 는 `num:<주문번호>` 라서, 중복 줄이
  //   생긴 탭에서는 수기 표기 1건이 **여러 줄의 입금 원장**(payment_records·batch_items)으로 승격돼
  //   "이체 1건 = 입금완료 N건" 이 된다. 어느 줄이 진짜인지 모르면 **한 줄도 만들지 않는다.**
  const perAnchor = new Map();
  for (const r of uniqueRows) {
    const k = `${r.sheetId}\t${r.tabName}\t${r.anchorType}\t${r.anchorValue}`;
    perAnchor.set(k, (perAnchor.get(k) || 0) + 1);
  }
  const ambiguous = uniqueRows.filter(r =>
    perAnchor.get(`${r.sheetId}\t${r.tabName}\t${r.anchorType}\t${r.anchorValue}`) > 1);
  const single = uniqueRows.filter(r =>
    perAnchor.get(`${r.sheetId}\t${r.tabName}\t${r.anchorType}\t${r.anchorValue}`) === 1);
  _lastAmbiguous = ambiguous.map(r => ({
    sheetId: r.sheetId, tabName: r.tabName, rowIndex: r.rowIndex,
    anchorType: r.anchorType, anchorValue: r.anchorValue, reviewerName: r.reviewerName || '',
  }));
  return single.map(r => ({
    ...r,
    stamp: '8/11',
    sourceKey: `manual-811:${r.editId}`,
    amount: Math.max(0, Number(r.productPrice || extractAmountNumber(r.rowJson) || 0)
      + Number(r.reviewFeeSnapshot != null ? r.reviewFeeSnapshot : (r.reviewFee || 0))),
  }));
}

async function previewManual811Transfer() {
  const items = await _manual811Candidates(pool);
  const { rows: existing } = await pool.query(
    `SELECT historical_key FROM payment_batches WHERE historical_key = 'manual-811' LIMIT 1`);
  const { rows: conflicts } = items.length ? await pool.query(
    `SELECT sheet_id, tab_name, row_index FROM payment_batch_items
      WHERE (sheet_id, tab_name, row_index) IN (SELECT * FROM unnest($1::text[], $2::text[], $3::int[]))
        AND status IN ('pending','paid')`,
    [items.map(x => x.sheetId), items.map(x => x.tabName), items.map(x => x.rowIndex)]) : { rows: [] };
  return { ok: true, candidates: items.length, totalAmount: items.reduce((n, x) => n + x.amount, 0),
    existingBatch: !!existing.length, conflicts: conflicts.length, blocked: items.filter(x => !x.sheetless || !x.depositColKey).length,
    // 앵커가 여러 줄을 가리켜 제외한 행 — 조용히 빼지 않는다(중복 줄부터 정리해야 한다는 신호).
    ambiguous: _lastAmbiguous.length, ambiguousRows: _lastAmbiguous.slice(0, 200) };
}

/* ══════════════════════════════════════════════════════════════════
   입금일 오염 진단 (읽기 전용 · 쓰기 쿼리 0)
   ──────────────────────────────────────────────────────────────────
   2026-08-19 조사에서 확인된 세 증상을 한 번에 센다.
     ① 한 수동 입금 마커가 여러 작업표 줄을 가리킴 = 입금일 번짐의 원인
     ② 리뷰 미작성인데 입금 기록됨
     ③ 실제 이체 1건인데 입금 원장 N건(같은 사람·같은 날짜 중복 기록)
   ★ 어떤 것도 고치지 않는다 — 정리는 사람이 결과를 보고 결정한다.
   ★ 소스별 실패를 뭉뚱그리지 않는다(`*Unavailable`) — 0 으로 꾸미면 "이상 없음"으로 오독된다.
   ══════════════════════════════════════════════════════════════════ */
const _ANOMALY_CAP = 300;

async function depositAnomalyReport({ sheetId = '', tabName = '' } = {}) {
  const scope = [];
  const params = [];
  if (sheetId) { params.push(sheetId); scope.push(`sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); scope.push(`tab_name = $${params.length}`); }
  const whereScope = scope.length ? scope.join(' AND ') : 'TRUE';
  const out = { ok: true, scope: { sheetId: sheetId || null, tabName: tabName || null }, cap: _ANOMALY_CAP };

  // ① 앵커가 여러 줄을 가리키는 수동 입금 마커
  try {
    const { rows } = await pool.query(
      `SELECT m.sheet_id AS "sheetId", m.tab_name AS "tabName", m.anchor_type AS "anchorType",
              m.anchor_value AS "anchorValue", m.stamp,
              count(cp.id)::int AS "rowCount", array_agg(cp.seq ORDER BY cp.seq) AS rows
         FROM manual_payment_marks m
         JOIN campaign_participants cp
           ON cp.sheet_id = m.sheet_id AND cp.tab_name = m.tab_name
          AND cp.deleted_at IS NULL AND cp.active = TRUE
          AND ((m.anchor_type = 'order'    AND cp.order_submission_id::text = m.anchor_value)
            OR (m.anchor_type = 'manual'   AND cp.id::text = m.anchor_value)
            OR (m.anchor_type = 'identity' AND cp.identity_key = m.anchor_value))
        WHERE ${whereScope.replace(/\b(sheet_id|tab_name)\b/g, 'm.$1')}
        GROUP BY 1,2,3,4,5
       HAVING count(cp.id) > 1
        ORDER BY count(cp.id) DESC
        LIMIT ${_ANOMALY_CAP}`, params);
    out.ambiguousMarks = rows;
    out.ambiguousMarkCount = rows.length;
    out.ambiguousRowCount = rows.reduce((n, r) => n + (Number(r.rowCount) - 1), 0);   // 번져 나간 줄 수
  } catch (e) { out.ambiguousUnavailable = e.message; }

  // ② 리뷰 미작성인데 입금 기록된 행
  try {
    const { rows } = await pool.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", row_index AS "rowIndex",
              reviewer_name AS "reviewerName"
         FROM review_index
        WHERE ${whereScope} AND is_submitted = FALSE AND is_submitted2 = 'PAID'
        ORDER BY sheet_id, tab_name, row_index
        LIMIT ${_ANOMALY_CAP}`, params);
    out.paidWithoutSubmit = rows;
    out.paidWithoutSubmitCount = rows.length;
  } catch (e) { out.paidWithoutSubmitUnavailable = e.message; }

  // ③ 같은 사람·같은 입금일에 입금 원장이 2건 이상
  try {
    const { rows } = await pool.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", reviewer_name AS "reviewerName",
              (paid_at AT TIME ZONE 'Asia/Seoul')::date AS "paidDate",
              count(*)::int AS "records", array_agg(row_index ORDER BY row_index) AS rows
         FROM payment_records
        WHERE ${whereScope}
        GROUP BY 1,2,3,4
       HAVING count(*) > 1
        ORDER BY count(*) DESC
        LIMIT ${_ANOMALY_CAP}`, params);
    out.duplicateLedger = rows;
    out.duplicateLedgerCount = rows.length;
  } catch (e) { out.duplicateLedgerUnavailable = e.message; }

  return out;
}

async function restoreManual811DepositDates({ by = 'payment-repair' } = {}) {
  const client = await pool.connect();
  let items = [];
  let batch;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('manual_811_transfer_batch'))`);
    items = await _manual811Candidates(client);
    if (!items.length) throw new ManualDepositRepairError('empty', '복구할 8/11 수동 입금 기록을 찾지 못했습니다.');
    if (items.some(x => !x.sheetless || !x.depositColKey)) throw new ManualDepositRepairError('unresolved', '입금 컬럼 또는 무시트 작업표를 찾지 못한 행이 있어 전체 복구를 중단했습니다.');
    const { rows: existingBatches } = await client.query(
      `SELECT * FROM payment_batches WHERE historical_key = 'manual-811' FOR UPDATE`);
    if (existingBatches.length) {
      batch = existingBatches[0];
      await client.query('COMMIT');
    } else {
    const { rows: conflicts } = await client.query(
      `SELECT sheet_id, tab_name, row_index FROM payment_batch_items
        WHERE (sheet_id, tab_name, row_index) IN (SELECT * FROM unnest($1::text[], $2::text[], $3::int[]))
          AND status IN ('pending','paid')`, [items.map(x => x.sheetId), items.map(x => x.tabName), items.map(x => x.rowIndex)]);
    if (conflicts.length) throw new ManualDepositRepairError('already_locked', `기존 이체 회차와 겹치는 ${conflicts.length}건이 있어 중복 기록을 중단했습니다.`);
    const { rows: batches } = await client.query(
      `INSERT INTO payment_batches (seq, bank, status, item_count, total_amount, created_by, created_at, historical_key)
       VALUES (0, 'manual', 'applied', $1, $2, $3, '2026-08-11 00:00:00+09', 'manual-811')
       RETURNING *`, [items.length, items.reduce((n, x) => n + x.amount, 0), by]);
    batch = batches[0];
    for (const item of items) {
      await client.query(
        `INSERT INTO payment_batch_items (batch_id, sheet_id, tab_name, row_index, reviewer_name, product_price, review_fee, amount, status, paid_at, transfer_memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid','2026-08-11 00:00:00+09','수동 이력 #0')`, [batch.id, item.sheetId, item.tabName, item.rowIndex, item.reviewerName || '',
          Number(item.productPrice || extractAmountNumber(item.rowJson) || 0), Number(item.reviewFeeSnapshot != null ? item.reviewFeeSnapshot : (item.reviewFee || 0)), item.amount]);
      await client.query(
        `INSERT INTO manual_payment_marks (source_key, batch_id, sheet_id, tab_name, anchor_type, anchor_value, deposit_col_key, stamp, paid_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'8/11','2026-08-11 00:00:00+09',$8)
         ON CONFLICT (source_key) DO NOTHING`, [item.sourceKey, batch.id, item.sheetId, item.tabName, item.anchorType, item.anchorValue, item.depositColKey, by]);
      await client.query(
        `INSERT INTO payment_records (sheet_id, tab_name, reviewer_name, row_index, amount, paid_by, paid_at, source_key)
         VALUES ($1,$2,$3,$4,$5,$6,'2026-08-11 00:00:00+09',$7)
         ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING`, [item.sheetId, item.tabName, item.reviewerName || '', item.rowIndex, item.amount, by, item.sourceKey]);
    }
    await client.query('COMMIT');
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }

  const board = await markDepositCells(items, { by, deferSheetlessRebuild: true });
  // #0도 자동 이체회차와 같은 작업보드 반영 이력을 남긴다. 이 값이 없으면 입금칸이
  // 실제로 복구돼도 회차 목록에는 "입금일 미기록"으로 보여 운영자가 다시 실행하게 된다.
  await pool.query(
    `UPDATE payment_batches
        SET board_recorded_count = $2, board_queued_count = $3, board_skipped_count = $4,
            board_failed_count = $5, board_stamp = '8/11', board_recorded_at = NOW(), board_recorded_by = $6
      WHERE id = $1`, [batch.id, board.recorded, board.queued, board.skipped, board.failed, by]);
  const sheetlessTabs = [...new Map(items.filter(x => x.sheetless)
    .map(x => [`${x.sheetId}\t${x.tabName}`, x])).values()];
  for (const tab of sheetlessTabs) {
    await rebuildLedgers({ sheetId: tab.sheetId, tabName: tab.tabName, by });
  }
  return { ok: true, batch: { id: batch.id, seq: 0, totalAmount: Number(batch.total_amount || 0) }, candidates: items.length, stamp: '8/11', rebuiltTabs: sheetlessTabs.length, ...board };
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
  const targetValue = mergeDepositStamps('', date);
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
    for (const { row, value } of sourceUpdates) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                updated_at = NOW(), updated_by = $4
          WHERE id = $1`, [row.id, depositColKey, value, by]);
    }
    for (const row of targetRows) {
      await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
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

module.exports = { previewManual811Transfer, depositAnomalyReport, restoreManual811DepositDates, moveDepositDateBetweenRows, ManualDepositRepairError };
