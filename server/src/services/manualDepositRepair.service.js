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

  // ④ 수정 오버레이로 남아 있는 입금 표기 (8/12 계열) — 앵커가 몇 줄을 가리키는지까지
  //    ★ 이건 row_json 에 박힌 값이 아니라 **표시·집계에만 얹히는 오버레이**다. 앵커가 여러 줄이면
  //      게이트가 적용을 막지만(이번 배포), 편집 자체는 남아 있으므로 날짜별로 규모를 보여준다.
  try {
    const { rows } = await pool.query(
      `SELECT pe.sheet_id AS "sheetId", pe.tab_name AS "tabName", pe.anchor_type AS "anchorType",
              btrim(pe.value_text) AS stamp, pe.created_by AS "createdBy",
              count(cp.id)::int AS "rowCount", array_agg(cp.seq ORDER BY cp.seq) AS rows
         FROM participant_edits pe
         LEFT JOIN campaign_participants cp
           ON cp.sheet_id = pe.sheet_id AND cp.tab_name = pe.tab_name
          AND cp.deleted_at IS NULL AND cp.active = TRUE
          AND ((pe.anchor_type = 'order'    AND cp.order_submission_id::text = pe.anchor_value)
            OR (pe.anchor_type = 'manual'   AND cp.id::text = pe.anchor_value)
            OR (pe.anchor_type = 'identity' AND cp.identity_key = pe.anchor_value))
        WHERE ${whereScope.replace(/\b(sheet_id|tab_name)\b/g, 'pe.$1')}
          AND pe.field = 'col:입금' AND pe.kind = 'text' AND pe.reverted_at IS NULL
          AND btrim(COALESCE(pe.value_text, '')) <> ''
        GROUP BY 1,2,3,4,5
        ORDER BY count(cp.id) DESC
        LIMIT ${_ANOMALY_CAP}`, params);
    out.overlayMarks = rows;
    out.overlayMarkCount = rows.length;
    out.overlaySpreadCount = rows.filter(r => Number(r.rowCount) > 1).length;
    // 날짜별 요약 — "8/11 몇 건 · 8/12 몇 건" 을 한눈에
    const byDate = {};
    for (const r of rows) {
      const k = r.stamp || '(빈값)';
      if (!byDate[k]) byDate[k] = { marks: 0, spread: 0, rows: 0 };
      byDate[k].marks += 1;
      byDate[k].rows += Number(r.rowCount) || 0;
      if (Number(r.rowCount) > 1) byDate[k].spread += 1;
    }
    out.overlayByDate = byDate;
  } catch (e) { out.overlayUnavailable = e.message; }

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


/* ══════════════════════════════════════════════════════════════════
   번진 입금일 정리 (사용자 확정 2026-08-19)
   ──────────────────────────────────────────────────────────────────
   ★★ 판정 규칙(완화 금지) — 정규 입금 대상은 `is_submitted = TRUE` 였으므로
      **실제 이체된 줄 = 리뷰 제출된 줄**이다.
        · 그룹에 제출된 줄이 **정확히 1개** → 그 줄만 남기고 나머지에서 그 날짜를 회수
        · 제출된 줄이 **0개 또는 2개 이상** → **보류**(자동 판단 금지, 사람이 고른다)
   ★ 미리보기와 실행이 **같은 판정 함수**(`_fanoutGroups`)를 쓴다 — 사본을 두면
     "미리보기 ≠ 실제 결과"가 되고 그건 되돌릴 수 없는 조작에서 가장 나쁜 실패다.
   ★ 남길 줄은 **절대 건드리지 않는다**. 회수는 **그 날짜 토큰만**(`removeDepositStamp`) —
     같은 칸의 다른 입금일(예 `8/3, 8/11`)은 보존한다.
   ★ 무시트 탭만 — 시트 기반 탭의 `row_json` 은 시트의 사본이라 지워도 다음 빌드가 되돌린다.
   ══════════════════════════════════════════════════════════════════ */

const CLEANUP_HOLD = {
  no_submitted_row: '리뷰 제출된 줄이 없습니다 — 어느 줄이 실제 이체인지 사람이 판단해야 합니다.',
  multiple_submitted_rows: '리뷰 제출된 줄이 2개 이상입니다 — 사람이 골라야 합니다.',
  not_sheetless: '시트 기반 작업입니다 — 작업표 값을 지워도 다음 빌드가 되돌립니다.',
  deposit_column_missing: '입금 컬럼을 찾지 못했습니다.',
};

/** 번진 마커 그룹 + 처리 계획(판정 단일 출처). 읽기만 한다. */
async function _fanoutGroups(client, { sheetId = '', tabName = '', stamp = '8/11' } = {}) {
  const params = [String(stamp)];
  const scope = [];
  if (sheetId) { params.push(sheetId); scope.push(`m.sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); scope.push(`m.tab_name = $${params.length}`); }
  const { rows } = await client.query(
    `SELECT m.id::text AS "markId", m.sheet_id AS "sheetId", m.tab_name AS "tabName",
            m.anchor_type AS "anchorType", m.anchor_value AS "anchorValue",
            m.deposit_col_key AS "depositColKey", m.stamp,
            cp.id::text AS "rowId", cp.seq AS "rowIndex", cp.reviewer_name AS "reviewerName",
            COALESCE(cp.row_json ->> m.deposit_col_key, '') AS "paidValue",
            COALESCE(ri.is_submitted, FALSE) AS submitted,
            COALESCE(tc.sheetless, FALSE) AS sheetless
       FROM manual_payment_marks m
       JOIN campaign_participants cp
         ON cp.sheet_id = m.sheet_id AND cp.tab_name = m.tab_name
        AND cp.deleted_at IS NULL AND cp.active = TRUE
        AND (( m.anchor_type = 'order'    AND cp.order_submission_id::text = m.anchor_value)
          OR ( m.anchor_type = 'manual'   AND cp.id::text = m.anchor_value)
          OR ( m.anchor_type = 'identity' AND cp.identity_key = m.anchor_value))
       LEFT JOIN review_index ri
         ON ri.sheet_id = m.sheet_id AND ri.tab_name = m.tab_name AND ri.row_index = cp.seq
       LEFT JOIN tab_configs tc
         ON tc.sheet_id = m.sheet_id AND tc.tab_name = m.tab_name
      WHERE btrim(m.stamp) = $1${scope.length ? ' AND ' + scope.join(' AND ') : ''}
      ORDER BY m.sheet_id, m.tab_name, m.id, cp.seq`, params);

  const byMark = new Map();
  for (const r of rows) {
    if (!byMark.has(r.markId)) {
      byMark.set(r.markId, {
        markId: r.markId, sheetId: r.sheetId, tabName: r.tabName,
        anchorType: r.anchorType, anchorValue: r.anchorValue,
        depositColKey: r.depositColKey, stamp: r.stamp, sheetless: r.sheetless === true,
        targets: [],
      });
    }
    byMark.get(r.markId).targets.push({
      rowId: r.rowId, rowIndex: Number(r.rowIndex), reviewerName: r.reviewerName || '',
      submitted: r.submitted === true, paidValue: r.paidValue || '',
    });
  }

  const groups = [];
  for (const g of byMark.values()) {
    if (g.targets.length <= 1) continue;              // 번지지 않은 마커는 대상 아님
    const submitted = g.targets.filter(t => t.submitted);
    let hold = null;
    if (!g.sheetless) hold = 'not_sheetless';
    else if (!g.depositColKey) hold = 'deposit_column_missing';
    else if (submitted.length === 0) hold = 'no_submitted_row';
    else if (submitted.length > 1) hold = 'multiple_submitted_rows';
    const keep = hold ? null : submitted[0];
    // ★ 회수 대상은 "그 칸에 그 날짜가 실제로 있는 줄"만 — 없는 줄은 셀 필요가 없다.
    const drop = hold ? [] : g.targets.filter(t =>
      t.rowId !== keep.rowId
      && removeDepositStamp(t.paidValue, g.stamp) !== String(t.paidValue || '').trim());
    groups.push({ ...g, hold, holdReason: hold ? CLEANUP_HOLD[hold] : null, keep, drop,
      submittedCount: submitted.length });
  }
  return groups;
}

function _cleanupSummary(groups) {
  const actionable = groups.filter(g => !g.hold && g.drop.length);
  return {
    groups: groups.length,
    actionableGroups: actionable.length,
    dropRows: actionable.reduce((n, g) => n + g.drop.length, 0),
    holdGroups: groups.filter(g => g.hold).length,
    holdByReason: groups.filter(g => g.hold).reduce((acc, g) => {
      acc[g.hold] = (acc[g.hold] || 0) + 1; return acc;
    }, {}),
  };
}

function _cleanupView(groups) {
  return groups.map(g => ({
    tabName: g.tabName, anchorType: g.anchorType, stamp: g.stamp,
    rows: g.targets.map(t => t.rowIndex),
    keepRow: g.keep ? g.keep.rowIndex : null,
    dropRows: g.drop.map(t => t.rowIndex),
    reviewerName: (g.targets[0] && g.targets[0].reviewerName) || '',
    submittedCount: g.submittedCount,
    hold: g.hold, holdReason: g.holdReason,
  }));
}

async function previewDepositFanoutCleanup({ sheetId = '', tabName = '', stamp = '8/11' } = {}) {
  const groups = await _fanoutGroups(pool, { sheetId, tabName, stamp });
  return { ok: true, dryRun: true, stamp, summary: _cleanupSummary(groups), items: _cleanupView(groups) };
}

/**
 * 실행 — 그룹별로 남길 줄 1개를 빼고 나머지 줄에서 그 날짜만 회수한다.
 *  ① 작업표 입금칸에서 해당 날짜 제거  ② 그 줄의 `review_index.is_submitted2` 해제(칸이 비면)
 *  ③ 수동 회차(#0) 항목 `cancelled` 로 회수  ④ 마커를 남긴 줄에 정확히 재고정(manual 앵커)
 *  ⑤ 무시트 장부 재생성
 */
async function applyDepositFanoutCleanup({ sheetId = '', tabName = '', stamp = '8/11', by = 'payment-repair' } = {}) {
  const client = await pool.connect();
  let groups = [];
  const touchedTabs = new Map();
  let removedCells = 0, cancelledItems = 0, reanchored = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('manual_811_transfer_batch'))`);
    groups = await _fanoutGroups(client, { sheetId, tabName, stamp });
    const actionable = groups.filter(g => !g.hold && g.drop.length);
    if (!actionable.length) {
      await client.query('ROLLBACK');
      throw new ManualDepositRepairError('empty', '정리할 대상이 없습니다(모두 보류이거나 이미 정리됨).');
    }
    for (const g of actionable) {
      for (const t of g.drop) {
        const next = removeDepositStamp(t.paidValue, g.stamp);
        const upd = await client.query(
          `UPDATE campaign_participants
              SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                  updated_at = NOW(), updated_by = $4
            WHERE id = $1 AND deleted_at IS NULL`,
          [t.rowId, g.depositColKey, next, by]);
        removedCells += upd.rowCount;
        // 칸이 비면 그 줄의 입금완료 표시도 내린다(장부 재생성도 같은 결과를 만든다 — 즉시 반영용).
        if (!next) {
          await client.query(
            `UPDATE review_index SET is_submitted2 = 'NONE'
              WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3 AND is_submitted2 = 'PAID'`,
            [g.sheetId, g.tabName, t.rowIndex]);
        }
        // ★ 회수는 **수동 이력 회차(#0)** 항목만 — 실제 이체 회차 항목은 절대 건드리지 않는다.
        const c = await client.query(
          `UPDATE payment_batch_items i
              SET status = 'cancelled', result_status = '정리: 번진 입금일 회수'
             FROM payment_batches b
            WHERE i.batch_id = b.id AND b.historical_key = 'manual-811'
              AND i.sheet_id = $1 AND i.tab_name = $2 AND i.row_index = $3
              AND i.status = 'paid'`,
          [g.sheetId, g.tabName, t.rowIndex]);
        cancelledItems += c.rowCount;
      }
      // ④ 마커를 남긴 줄에 정확히 고정 — 앵커가 다시 여러 줄을 가리키지 않게 한다.
      const ra = await client.query(
        `UPDATE manual_payment_marks SET anchor_type = 'manual', anchor_value = $2 WHERE id = $1::uuid`,
        [g.markId, g.keep.rowId]);
      reanchored += ra.rowCount;
      touchedTabs.set(`${g.sheetId}\t${g.tabName}`, { sheetId: g.sheetId, tabName: g.tabName });
    }
    // 회차 #0 합계 재계산 — 회수분을 빼야 "이체 1건 = 원장 1건"이 맞는다.
    await client.query(
      `UPDATE payment_batches b
          SET item_count = s.n, total_amount = s.amt
         FROM (SELECT batch_id, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS amt
                 FROM payment_batch_items WHERE status = 'paid' GROUP BY batch_id) s
        WHERE b.id = s.batch_id AND b.historical_key = 'manual-811'`);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }

  // ⑤ 장부 재생성 — 실패해도 작업표 값은 이미 정리됐다(다음 재생성에 자동 반영).
  const rebuilt = [];
  for (const tab of touchedTabs.values()) {
    try { await rebuildLedgers({ sheetId: tab.sheetId, tabName: tab.tabName, by: `deposit-cleanup:${by}` }); rebuilt.push(tab.tabName); }
    catch (e) { rebuilt.push(`${tab.tabName}(재생성 실패: ${e.code || e.message})`); }
  }
  return { ok: true, dryRun: false, stamp, removedCells, cancelledItems, reanchored,
    rebuiltTabs: rebuilt, summary: _cleanupSummary(groups), items: _cleanupView(groups) };
}


/* ══════════════════════════════════════════════════════════════════
   "직원이 최초로 적은 입금일" 복원 (사용자 확정 2026-08-19)
   ──────────────────────────────────────────────────────────────────
   상태: 직원이 8/11·8/12 를 작업보드 입금칸에 적은 것은 `participant_edits` **오버레이**로 남아 있고,
   그 앵커(`order_submission_id`)가 무시트 중복 줄 사고로 **여러 줄을 가리키게** 됐다.

   ★★ 오버레이만으로는 "원래 줄 하나"에 붙일 수 없다 — 합성은 **행에서 파생한 앵커**로 편집을 찾으므로
      같은 주문 UUID 를 가진 두 줄은 **구조적으로 같은 키**가 된다. 그래서 게이트(2줄 이상 미적용)를
      걸면 번짐은 멈추지만 **원래 줄에서도 값이 사라진다**. 원하는 상태는 그게 아니다.
   → 해결: **원래 줄에는 값을 실제로 새기고(row_json), 오버레이는 이력으로 내린다(reverted_at).**
      그러면 그 줄에만 남고 번진 줄에서는 사라지며, 앵커 모호성 자체가 소멸한다.

   ★ 원래 줄 판정 = 사용자가 확정한 그 규칙 — **리뷰 제출된 줄이 정확히 1개**일 때만 자동,
     0개·2개 이상은 **보류**(사람이 고른다). 미리보기에 입금 원장 유무를 함께 보여 눈으로 검증하게 한다.
   ★ 값은 **직원이 친 그대로** 새긴다(`8/11`·`계좌 오류` 등) — "최초 입력 버전"이 목적이므로 해석하지 않는다.
   ★ 번진 줄에서 지우는 것은 **그 값(날짜 토큰)만**이고, **입금 원장이 있는 줄은 건드리지 않는다**
     (실제 이체된 줄일 수 있다 — fail-closed).
   ══════════════════════════════════════════════════════════════════ */

const OVERLAY_HOLD = {
  no_submitted_row: '리뷰 제출된 줄이 없습니다 — 어느 줄이 원래 줄인지 사람이 판단해야 합니다.',
  multiple_submitted_rows: '리뷰 제출된 줄이 2개 이상입니다 — 사람이 골라야 합니다.',
  not_sheetless: '시트 기반 작업입니다 — 작업표에 새겨도 다음 빌드가 되돌립니다.',
  deposit_column_missing: '입금 컬럼을 찾지 못했습니다.',
};

/** 같은 값인지(날짜는 토큰 기준, 그 외는 문자열 그대로) */
function _sameStampValue(cellValue, stamp) {
  const cur = String(cellValue == null ? '' : cellValue).trim();
  if (!cur) return false;
  if (removeDepositStamp(cur, stamp) !== cur) return true;      // 날짜 토큰이 들어 있다
  return cur === String(stamp == null ? '' : stamp).trim();      // 비-날짜 표기(계좌 오류 등)
}

/** 그 값만 뺀 나머지 */
function _withoutStamp(cellValue, stamp) {
  const cur = String(cellValue == null ? '' : cellValue).trim();
  const byToken = removeDepositStamp(cur, stamp);
  if (byToken !== cur) return byToken;
  return cur === String(stamp == null ? '' : stamp).trim() ? '' : cur;
}

/** 번진 입금 오버레이 + 처리 계획(판정 단일 출처). 읽기만 한다. */
async function _overlayGroups(client, { sheetId = '', tabName = '' } = {}) {
  const params = [];
  const scope = [];
  if (sheetId) { params.push(sheetId); scope.push(`pe.sheet_id = $${params.length}`); }
  if (tabName) { params.push(tabName); scope.push(`pe.tab_name = $${params.length}`); }
  const { rows } = await client.query(
    `WITH col AS (
       SELECT sheet_id, tab_name, MAX(NULLIF(submit_col2, '')) AS deposit_col
         FROM review_index GROUP BY sheet_id, tab_name
     )
     SELECT pe.id::text AS "editId", pe.sheet_id AS "sheetId", pe.tab_name AS "tabName",
            pe.anchor_type AS "anchorType", pe.anchor_value AS "anchorValue",
            btrim(pe.value_text) AS stamp, pe.created_by AS "createdBy", pe.created_at AS "createdAt",
            col.deposit_col AS "depositColKey",
            COALESCE(tc.sheetless, FALSE) AS sheetless,
            cp.id::text AS "rowId", cp.seq AS "rowIndex", cp.reviewer_name AS "reviewerName",
            COALESCE(cp.row_json ->> col.deposit_col, '') AS "paidValue",
            COALESCE(ri.is_submitted, FALSE) AS submitted,
            (EXISTS (SELECT 1 FROM payment_records pr
                      WHERE pr.sheet_id = cp.sheet_id AND pr.tab_name = cp.tab_name AND pr.row_index = cp.seq)
             OR EXISTS (SELECT 1 FROM payment_batch_items pi
                      WHERE pi.sheet_id = cp.sheet_id AND pi.tab_name = cp.tab_name AND pi.row_index = cp.seq
                        AND pi.status = 'paid')) AS "hasLedger",
            -- ── 보류건 판단 근거(읽기 전용) ──
            (SELECT MAX(pr.paid_at) FROM payment_records pr
              WHERE pr.sheet_id = cp.sheet_id AND pr.tab_name = cp.tab_name AND pr.row_index = cp.seq) AS "ledgerPaidAt",
            EXISTS (SELECT 1 FROM review_submissions rs
                     WHERE rs.sheet_id = cp.sheet_id AND rs.tab_name = cp.tab_name AND rs.row_index = cp.seq) AS "hasReviewFile",
            -- 그 줄이 "언제부터 채워져 있었나" — 직원이 적은 시각보다 나중에 채워진 줄은 그때 화면에 없었다.
            LEAST(
              (SELECT MIN(COALESCE(rs.uploaded_at, rs.created_at)) FROM review_submissions rs
                WHERE rs.sheet_id = cp.sheet_id AND rs.tab_name = cp.tab_name AND rs.row_index = cp.seq),
              (SELECT MIN(pl.created_at) FROM participation_links pl
                WHERE pl.sheet_id = cp.sheet_id AND pl.tab_name = cp.tab_name AND pl.row_index = cp.seq),
              (SELECT MIN(os.submitted_at) FROM order_submissions os
                WHERE os.sheet_id = cp.sheet_id AND os.tab_name = cp.tab_name AND os.sheet_row = cp.seq
                  AND os.deleted_at IS NULL)
            ) AS "firstSeenAt"
       FROM participant_edits pe
       JOIN campaign_participants cp
         ON cp.sheet_id = pe.sheet_id AND cp.tab_name = pe.tab_name
        AND cp.deleted_at IS NULL AND cp.active = TRUE
        AND (( pe.anchor_type = 'order'    AND cp.order_submission_id::text = pe.anchor_value)
          OR ( pe.anchor_type = 'manual'   AND cp.id::text = pe.anchor_value)
          OR ( pe.anchor_type = 'identity' AND cp.identity_key = pe.anchor_value))
       LEFT JOIN col ON col.sheet_id = pe.sheet_id AND col.tab_name = pe.tab_name
       LEFT JOIN review_index ri
         ON ri.sheet_id = pe.sheet_id AND ri.tab_name = pe.tab_name AND ri.row_index = cp.seq
       LEFT JOIN tab_configs tc
         ON tc.sheet_id = pe.sheet_id AND tc.tab_name = pe.tab_name
      WHERE pe.field = 'col:입금' AND pe.kind = 'text' AND pe.reverted_at IS NULL
        AND btrim(COALESCE(pe.value_text, '')) <> ''
        ${scope.length ? 'AND ' + scope.join(' AND ') : ''}
      ORDER BY pe.sheet_id, pe.tab_name, pe.id, cp.seq`, params);

  const byEdit = new Map();
  for (const r of rows) {
    if (!byEdit.has(r.editId)) {
      byEdit.set(r.editId, {
        editId: r.editId, sheetId: r.sheetId, tabName: r.tabName,
        anchorType: r.anchorType, anchorValue: r.anchorValue, stamp: r.stamp,
        createdBy: r.createdBy || '', createdAt: r.createdAt,
        depositColKey: r.depositColKey, sheetless: r.sheetless === true, targets: [],
      });
    }
    byEdit.get(r.editId).targets.push({
      rowId: r.rowId, rowIndex: Number(r.rowIndex), reviewerName: r.reviewerName || '',
      paidValue: r.paidValue || '', submitted: r.submitted === true, hasLedger: r.hasLedger === true,
      ledgerPaidAt: r.ledgerPaidAt || null, hasReviewFile: r.hasReviewFile === true,
      firstSeenAt: r.firstSeenAt || null,
    });
  }

  const groups = [];
  for (const g of byEdit.values()) {
    if (g.targets.length <= 1) continue;              // 번지지 않은 표기는 손대지 않는다
    const submitted = g.targets.filter(t => t.submitted);
    let hold = null;
    if (!g.sheetless) hold = 'not_sheetless';
    else if (!g.depositColKey) hold = 'deposit_column_missing';
    else if (submitted.length === 0) hold = 'no_submitted_row';
    else if (submitted.length > 1) hold = 'multiple_submitted_rows';
    const keep = hold ? null : submitted[0];
    // 번진 줄에서 지울 대상 = 그 값이 실제로 새겨져 있고 **입금 원장이 없는** 줄만(fail-closed)
    const clear = hold ? [] : g.targets.filter(t =>
      t.rowId !== keep.rowId && !t.hasLedger && _sameStampValue(t.paidValue, g.stamp));
    const ledgerBlocked = hold ? [] : g.targets.filter(t =>
      t.rowId !== keep.rowId && t.hasLedger && _sameStampValue(t.paidValue, g.stamp));
    const grp = { ...g, hold, holdReason: hold ? OVERLAY_HOLD[hold] : null, keep, clear, ledgerBlocked,
      submittedCount: submitted.length };
    // 보류건에만 추천을 붙인다(자동 확정 규칙은 불변 — 이미 확인한 미리보기가 달라지면 안 된다).
    if (hold === 'no_submitted_row' || hold === 'multiple_submitted_rows') {
      const sg = _suggestKeep(grp);
      if (sg) { grp.suggest = sg; grp.suggestReason = SUGGEST_BASIS[sg.basis]; }
    }
    groups.push(grp);
  }
  return groups;
}

function _overlaySummary(groups) {
  const act = groups.filter(g => !g.hold);
  return {
    groups: groups.length,
    actionableGroups: act.length,
    keepRows: act.length,
    clearRows: act.reduce((n, g) => n + g.clear.length, 0),
    ledgerBlockedRows: act.reduce((n, g) => n + g.ledgerBlocked.length, 0),
    holdGroups: groups.filter(g => g.hold).length,
    byStamp: groups.reduce((acc, g) => {
      const k = g.stamp || '(빈값)';
      if (!acc[k]) acc[k] = { groups: 0, hold: 0 };
      acc[k].groups += 1; if (g.hold) acc[k].hold += 1;
      return acc;
    }, {}),
  };
}

function _overlayView(groups) {
  return groups.map(g => ({
    editId: g.editId,
    tabName: g.tabName, stamp: g.stamp, anchorType: g.anchorType,
    createdBy: g.createdBy, createdAt: g.createdAt,
    reviewerName: (g.targets[0] && g.targets[0].reviewerName) || '',
    rows: g.targets.map(t => t.rowIndex),
    // 보류건을 사람이 고를 수 있도록 줄별 근거를 함께 준다(화면은 이것만 보고 그린다).
    candidates: g.targets.map(t => ({
      rowId: t.rowId, rowIndex: t.rowIndex, submitted: t.submitted,
      hasLedger: t.hasLedger, ledgerPaidAt: t.ledgerPaidAt,
      hasReviewFile: t.hasReviewFile, firstSeenAt: t.firstSeenAt,
      paidValue: t.paidValue,
    })),
    suggest: g.suggest || null, suggestReason: g.suggestReason || null,
    keepRow: g.keep ? g.keep.rowIndex : null,
    clearRows: g.clear.map(t => t.rowIndex),
    ledgerBlockedRows: g.ledgerBlocked.map(t => t.rowIndex),
    ledgerRows: g.targets.filter(t => t.hasLedger).map(t => t.rowIndex),
    submittedCount: g.submittedCount,
    hold: g.hold, holdReason: g.holdReason,
  }));
}


/* ══════════════════════════════════════════════════════════════════
   보류건 판단 기준 (사용자 요청 2026-08-19)
   ──────────────────────────────────────────────────────────────────
   자동 확정 규칙(= 리뷰 제출된 줄 1개)으로 못 정한 그룹에, **증거 사다리**를 적용해
   "어느 줄이 직원이 적은 그 줄인가"를 추천한다.

   ★★ 자동 확정 규칙은 **바꾸지 않는다** — 이미 사람이 미리보기로 확인한 결과가
      배포 한 번에 달라지면 안 된다. 사다리는 **보류건에만**, 그리고 **추천까지만** 한다.
      최종 확정은 사람이 고른다(`decisions`).

   사다리(위에서부터, 정확히 1줄로 좁혀질 때만 인정):
     ① 입금 원장이 있는 줄        — 실제로 돈이 나간 줄이면 그 줄이 직원이 표기한 줄이다
     ② 리뷰 캡처 원장이 있는 줄    — `is_submitted`(파생값)와 달리 **파일 업로드 사실**이라
                                    장부 재생성에 흔들리지 않는다
     ③ 직원이 적은 시각보다 **먼저 채워져 있던** 줄
                                  — 8/18~19 사고로 생긴 중복 줄은 8/11 에는 화면에 없었다
   ★ 어느 단계도 1줄로 좁히지 못하면 추천하지 않는다(억지로 고르지 않는다).
   ══════════════════════════════════════════════════════════════════ */

const SUGGEST_BASIS = {
  ledger: '이 줄에만 입금 원장이 있습니다 — 실제로 이체된 줄입니다.',
  review_file: '이 줄에만 리뷰 캡처 업로드 기록이 있습니다.',
  filled_before_edit: '직원이 적은 시각보다 먼저 채워져 있던 유일한 줄입니다(중복 줄은 그 뒤에 생겼습니다).',
};

function _suggestKeep(group) {
  const t = group.targets || [];
  const only = (list) => (list.length === 1 ? list[0] : null);

  const byLedger = only(t.filter(x => x.hasLedger));
  if (byLedger) return { rowId: byLedger.rowId, rowIndex: byLedger.rowIndex, basis: 'ledger' };

  const byFile = only(t.filter(x => x.hasReviewFile));
  if (byFile) return { rowId: byFile.rowId, rowIndex: byFile.rowIndex, basis: 'review_file' };

  const editedAt = group.createdAt ? new Date(group.createdAt).getTime() : null;
  if (editedAt) {
    const before = t.filter(x => x.firstSeenAt && new Date(x.firstSeenAt).getTime() <= editedAt);
    const byTime = only(before);
    if (byTime) return { rowId: byTime.rowId, rowIndex: byTime.rowIndex, basis: 'filled_before_edit' };
  }
  return null;   // 좁혀지지 않으면 추천하지 않는다
}

async function previewOverlayFanoutFix({ sheetId = '', tabName = '' } = {}) {
  const groups = await _overlayGroups(pool, { sheetId, tabName });
  return { ok: true, dryRun: true, summary: _overlaySummary(groups), items: _overlayView(groups) };
}

/**
 * 실행 — 원래 줄에 값을 새기고, 번진 줄에서 지우고, 오버레이를 이력으로 내린다.
 */
/**
 * @param {object} o
 * @param {Array<{editId:string,rowId:string}>} [o.decisions]
 *   보류건에 대해 **사람이 고른 원래 줄**. 서버가 그 그룹의 실제 줄인지 재검증한다
 *   (화면이 보낸 rowId 를 그대로 믿으면 남의 줄에 입금일을 새길 수 있다).
 */
async function applyOverlayFanoutFix({ sheetId = '', tabName = '', by = 'payment-repair', decisions = null } = {}) {
  const picked = new Map();
  for (const d of (Array.isArray(decisions) ? decisions : [])) {
    if (d && d.editId && d.rowId) picked.set(String(d.editId), String(d.rowId));
  }
  const client = await pool.connect();
  let groups = [];
  const touchedTabs = new Map();
  let kept = 0, cleared = 0, reverted = 0;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('manual_deposit_overlay_fix'))`);
    groups = await _overlayGroups(client, { sheetId, tabName });
    // 사람이 고른 보류건을 대상으로 승격 — ★ 고른 줄이 **그 그룹의 실제 줄**일 때만.
    for (const g of groups) {
      if (!g.hold || !picked.has(g.editId)) continue;
      if (g.hold === 'not_sheetless' || g.hold === 'deposit_column_missing') continue;  // 사람이 골라도 안 되는 사유
      const chosen = g.targets.find(t => t.rowId === picked.get(g.editId));
      if (!chosen) continue;                       // 그 그룹에 없는 줄 → 무시(조용히 남의 줄에 쓰지 않는다)
      g.hold = null; g.holdReason = null; g.keep = chosen; g.pickedByHuman = true;
      g.clear = g.targets.filter(t =>
        t.rowId !== chosen.rowId && !t.hasLedger && _sameStampValue(t.paidValue, g.stamp));
      g.ledgerBlocked = g.targets.filter(t =>
        t.rowId !== chosen.rowId && t.hasLedger && _sameStampValue(t.paidValue, g.stamp));
    }
    const act = groups.filter(g => !g.hold);
    if (!act.length) {
      await client.query('ROLLBACK');
      throw new ManualDepositRepairError('empty', '복원할 대상이 없습니다(모두 보류이거나 이미 처리됨).');
    }
    for (const g of act) {
      // ① 원래 줄에 값을 실제로 새긴다(기존 입금일과 병합 — 다른 날짜를 지우지 않는다)
      const nextKeep = mergeDepositStamps(g.keep.paidValue, g.stamp);
      const k = await client.query(
        `UPDATE campaign_participants
            SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                is_paid = TRUE, updated_at = NOW(), updated_by = $4
          WHERE id = $1 AND deleted_at IS NULL`,
        [g.keep.rowId, g.depositColKey, nextKeep, by]);
      kept += k.rowCount;

      // ② 번진 줄에서 그 값만 지운다(입금 원장이 있는 줄은 위 필터에서 이미 제외됨)
      for (const t of g.clear) {
        const next = _withoutStamp(t.paidValue, g.stamp);
        const c = await client.query(
          `UPDATE campaign_participants
              SET row_json = COALESCE(row_json, '{}'::jsonb) || jsonb_build_object($2::text, $3::text),
                  is_paid = CASE WHEN $3::text = '' THEN FALSE ELSE is_paid END,
                  updated_at = NOW(), updated_by = $4
            WHERE id = $1 AND deleted_at IS NULL`,
          [t.rowId, g.depositColKey, next, by]);
        cleared += c.rowCount;
        if (!next) {
          await client.query(
            `UPDATE review_index SET is_submitted2 = 'NONE'
              WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3 AND is_submitted2 = 'PAID'`,
            [g.sheetId, g.tabName, t.rowIndex]);
        }
      }

      // ③ 오버레이(그 편집 + 짝 is_paid 토글)를 이력으로 내린다 — 앵커 모호성 자체를 없앤다.
      const rv = await client.query(
        `UPDATE participant_edits SET reverted_at = NOW(), reverted_by = $1
          WHERE sheet_id = $2 AND tab_name = $3 AND anchor_type = $4 AND anchor_value = $5
            AND field IN ('col:입금', 'is_paid') AND reverted_at IS NULL`,
        [String(by).slice(0, 100), g.sheetId, g.tabName, g.anchorType, g.anchorValue]);
      reverted += rv.rowCount;
      touchedTabs.set(`${g.sheetId}\t${g.tabName}`, { sheetId: g.sheetId, tabName: g.tabName });
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally { client.release(); }

  const rebuilt = [];
  for (const tab of touchedTabs.values()) {
    try { await rebuildLedgers({ sheetId: tab.sheetId, tabName: tab.tabName, by: `overlay-fix:${by}` }); rebuilt.push(tab.tabName); }
    catch (e) { rebuilt.push(`${tab.tabName}(재생성 실패: ${e.code || e.message})`); }
  }
  return { ok: true, dryRun: false, keptRows: kept, clearedRows: cleared, revertedEdits: reverted,
    pickedByHuman: groups.filter(g => g.pickedByHuman).length,
    rebuiltTabs: rebuilt, summary: _overlaySummary(groups), items: _overlayView(groups) };
}

module.exports = { previewManual811Transfer, depositAnomalyReport, previewOverlayFanoutFix, applyOverlayFanoutFix, previewDepositFanoutCleanup, applyDepositFanoutCleanup, restoreManual811DepositDates, moveDepositDateBetweenRows, ManualDepositRepairError };
