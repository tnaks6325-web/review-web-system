const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');

const INAD_COL_KEYWORDS = ['인애드', '인애드명', '인애드제출', '카톡', '카카오', '닉네임'];
const OPTION_COL_KEYWORDS = ['옵션', 'option'];
const FILLED_THRESHOLD = 4;
const APPEND_CANDIDATE_COUNT = 20;

let _pool;
function getPool() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}

function __setPoolForTest(pool) {
  _pool = pool || null;
}

function toPhone8(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, '');
}

function computeDedupKey({ orderNum, recipient, phone, dateStr, selectedOptKey } = {}) {
  const num = String(orderNum == null ? '' : orderNum).replace(/[^0-9]/g, '');
  if (num.length >= 6) return `num:${num}`;
  const rcp = normalizeText(recipient);
  const p8 = toPhone8(phone);
  const date = normalizeText(dateStr);
  const opt = normalizeText(selectedOptKey);
  return `rcp:${rcp}|${p8}|${date}|${opt}`;
}

function getColLetter(colIdx) {
  let letter = '';
  let idx = colIdx;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

function findColumn(headers, keywords, exact = []) {
  return (headers || []).findIndex(h => {
    const key = String(h || '').toLowerCase().trim();
    return exact.includes(key) || keywords.some(kw => key.includes(kw.toLowerCase()));
  });
}

function countFilledForAssignment(headers, row) {
  const excluded = new Set();
  (headers || []).forEach((h, idx) => {
    const key = String(h || '').toLowerCase();
    if (key === '번호' || key === 'no' || key === '#') excluded.add(idx);
    if (INAD_COL_KEYWORDS.some(kw => key.includes(kw))) excluded.add(idx);
    if (key.includes('구매일') || key.includes('상품') || key.includes('product')) excluded.add(idx);
    if (OPTION_COL_KEYWORDS.some(kw => key.includes(kw))) excluded.add(idx);
  });
  return (row || []).filter((cell, idx) => {
    if (excluded.has(idx)) return false;
    const val = String(cell == null ? '' : cell).trim();
    return val !== '' && val !== '0';
  }).length;
}

function isUnfilledOrderRow(headers, row) {
  const phoneColIdx = findColumn(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  const addressColIdx = findColumn(headers, ['주소', 'address']);
  const phoneVal = phoneColIdx >= 0 ? String((row || [])[phoneColIdx] || '').trim() : '';
  const addrVal = addressColIdx >= 0 ? String((row || [])[addressColIdx] || '').trim() : '';
  return !phoneVal && !addrVal;
}

function pushUnique(arr, seen, rowIndex) {
  const n = parseInt(rowIndex, 10);
  if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
    seen.add(n);
    arr.push(n);
  }
}

function buildCandidateRows({ headers, dataRows, headerRowIndex, orderData = {} }) {
  const candidates = [];
  const seen = new Set();
  const rows = (dataRows || []).map((r, idx) => ({
    rowIndex: parseInt(r.rowIndex, 10) || ((headerRowIndex || 0) + 1 + idx),
    cells: normalizeCells(r.cells || r),
  }));

  const inadColIdx = findColumn(headers, INAD_COL_KEYWORDS);
  const submittedOrderer = String(orderData.orderer || '').trim();
  if (inadColIdx >= 0 && submittedOrderer) {
    for (const row of rows) {
      if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
      const inadVal = String(row.cells[inadColIdx] || '').trim();
      if (inadVal === submittedOrderer && isUnfilledOrderRow(headers, row.cells)) {
        pushUnique(candidates, seen, row.rowIndex);
      }
    }
  }

  const selectedOptKey = String(orderData.selectedOptKey || '').trim();
  const optParts = selectedOptKey ? selectedOptKey.split('|').map(v => v.trim().toLowerCase()) : [];
  const optColIndices = [];
  (headers || []).forEach((h, idx) => {
    const key = String(h || '').toLowerCase();
    if (optColIndices.length < 3 && OPTION_COL_KEYWORDS.some(kw => key.includes(kw))) {
      optColIndices.push(idx);
    }
  });
  if (selectedOptKey && optColIndices.length > 0) {
    for (const row of rows) {
      if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
      const optMatch = optColIndices.every((colIdx, idx) => {
        const actual = String(row.cells[colIdx] || '').trim().toLowerCase();
        const expected = optParts[idx] || '';
        return actual === expected;
      });
      if (optMatch && isUnfilledOrderRow(headers, row.cells)) {
        pushUnique(candidates, seen, row.rowIndex);
      }
    }
  }

  for (const row of rows) {
    if (countFilledForAssignment(headers, row.cells) >= FILLED_THRESHOLD) continue;
    if (isUnfilledOrderRow(headers, row.cells)) {
      pushUnique(candidates, seen, row.rowIndex);
    }
  }

  const maxRow = rows.reduce((max, row) => Math.max(max, row.rowIndex), headerRowIndex || 1);
  for (let i = 1; i <= APPEND_CANDIDATE_COUNT; i++) {
    pushUnique(candidates, seen, maxRow + i);
  }
  return candidates;
}

function mapOrderToSheetRow(headers, orderData = {}) {
  const optParts = String(orderData.selectedOptKey || '').split('|').map(v => v.trim());
  let optColCounter = 0;
  const exactAdminHeaders = ['번호', 'no', '#'];
  const adminOnlyKeywords = ['인애드', '카톡', '닉네임', '상품', '상품명'];

  return (headers || []).map(h => {
    const key = String(h || '').toLowerCase().trim();
    if (exactAdminHeaders.includes(key)) return null;
    if (adminOnlyKeywords.some(kw => key === kw || key.includes(kw))) return null;
    if (key.includes('주문자') || key.includes('orderer')) return orderData.orderer || '';
    if (key.includes('수취인') || key.includes('받는분') || key.includes('이름') || key.includes('recipient')) return orderData.recipient || '';
    if (key.includes('아이디') || key.includes('userid') || key === 'id') return orderData.userId || '';
    if (key.includes('전화') || key.includes('연락') || key.includes('핸드폰') || key.includes('휴대폰') || key === 'phone') return orderData.phone || '';
    if (key.includes('주소') || key.includes('address')) return orderData.address || '';
    if (key.includes('은행') || key.includes('bank')) return orderData.bank || '';
    if (key.includes('계좌') || key.includes('account')) return orderData.account || '';
    if (key.includes('예금주') || key.includes('depositor')) return orderData.depositor || '';
    if (key.includes('금액') || key.includes('price')) return orderData.price || '';
    if (key.includes('일자') || key.includes('날짜') || key.includes('date')) return orderData.dateStr || '';
    if (key.includes('주문번호') || key.includes('ordernum')) return orderData.orderNum || '';
    if (key.includes('비고') || key.includes('특이사항') || key.includes('memo')) return orderData.memo || '';
    if (key.includes('옵션') || key.includes('option')) {
      const val = optParts[optColCounter] || '';
      optColCounter++;
      return val;
    }
    return null;
  });
}

function buildBatchUpdateData({ tabName, headers, targetRow, orderData }) {
  const rowData = mapOrderToSheetRow(headers, orderData);
  return rowData
    .map((val, col) => ({ val, col }))
    .filter(pair => pair.val !== null)
    .map(pair => ({
      range: `'${tabName}'!${getColLetter(pair.col)}${targetRow}`,
      values: [[pair.val]],
    }));
}

function buildMirrorGuardRange({ tabName, headers, targetRow, orderData = {} }) {
  const preferredCol = findColumn(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  const addressCol = findColumn(headers, ['주소', 'address']);
  let col = preferredCol >= 0 ? preferredCol : addressCol;

  if (col < 0) {
    const rowData = mapOrderToSheetRow(headers, orderData);
    col = rowData.findIndex(v => v !== null && String(v == null ? '' : v).trim() !== '');
  }
  if (col < 0) return null;

  return {
    range: `'${tabName}'!${getColLetter(col)}${targetRow}`,
    col,
    header: headers[col] || '',
  };
}

function escapeSheetName(name) {
  return String(name || '').replace(/'/g, "''");
}

async function loadRawTabContextFromSheet(sheetId, tabGid, tabName) {
  const pool = getPool();
  const { getSpreadsheetMeta, readSheet } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');

  const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
  const sheets = Array.isArray(meta) ? meta : [];
  const target = sheets.find(s => {
    const props = s && s.properties;
    if (!props) return false;
    if (tabGid && String(props.sheetId) === String(tabGid)) return true;
    return tabName && props.title === tabName;
  });
  const resolvedTabName = (target && target.properties && target.properties.title) || tabName;
  const resolvedGid = String((target && target.properties && target.properties.sheetId) || tabGid || '');
  if (!resolvedTabName) return null;

  const rows = await throttledCall(() =>
    readSheet(sheetId, `'${escapeSheetName(resolvedTabName)}'!A:ZZ`, resolvedGid ? { gid: resolvedGid } : {})
  );
  const values = Array.isArray(rows) ? rows : [];
  const detected = detectSheetHeader(values);
  const headers = detected.headers || (values[0] ? normalizeCells(values[0]) : []);
  const headerRowIndex = detected.headerRowIndex || (headers.length ? 1 : null);
  const dataStartRow = detected.dataStartRow || (headers.length ? 2 : null);
  const colCount = values.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);

  if (resolvedGid) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO raw_sheet_tabs
           (sheet_id, sheet_url, spreadsheet_title, tab_gid, tab_name,
            row_count, col_count, headers, is_system_tab, is_hidden,
            checksum, sheet_modified_at, mirrored_at,
            header_row_index, detected_headers, data_start_row)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false,false,NULL,NULL,NOW(),$9,$10::jsonb,$11)
         ON CONFLICT (sheet_id, tab_gid) DO UPDATE SET
           tab_name = EXCLUDED.tab_name,
           row_count = EXCLUDED.row_count,
           col_count = EXCLUDED.col_count,
           headers = EXCLUDED.headers,
           header_row_index = EXCLUDED.header_row_index,
           detected_headers = EXCLUDED.detected_headers,
           data_start_row = EXCLUDED.data_start_row,
           mirrored_at = NOW()`,
        [
          sheetId,
          `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
          meta._spreadsheetTitle || sheetId,
          resolvedGid,
          resolvedTabName,
          values.length,
          colCount,
          JSON.stringify(values[0] || []),
          headerRowIndex,
          headers.length ? JSON.stringify(headers) : null,
          dataStartRow,
        ]
      );
      await client.query('DELETE FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2', [sheetId, resolvedGid]);
      for (let start = 0; start < values.length; start += 500) {
        const batch = values.slice(start, start + 500);
        const placeholders = [];
        const params = [];
        let p = 1;
        batch.forEach((row, idx) => {
          placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(sheetId, resolvedGid, resolvedTabName, start + idx + 1, JSON.stringify(Array.isArray(row) ? row : []));
        });
        if (placeholders.length) {
          await client.query(
            `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells)
             VALUES ${placeholders.join(',')}`,
            params
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    sheetId,
    tabGid: resolvedGid,
    tabName: resolvedTabName,
    headers,
    headerRowIndex,
    dataStartRow,
    dataRows: values.slice(Math.max((dataStartRow || 1) - 1, 0)).map((cells, idx) => ({
      rowIndex: (dataStartRow || 1) + idx,
      cells,
    })),
    liveFallback: true,
  };
}

async function loadRawTabContext(sheetId, tabGid, tabName) {
  const pool = getPool();
  const params = [sheetId];
  let where = 'sheet_id = $1';
  if (tabGid) {
    params.push(String(tabGid));
    where += ` AND tab_gid = $${params.length}`;
  } else {
    params.push(tabName);
    where += ` AND tab_name = $${params.length}`;
  }

  const { rows: tabRows } = await pool.query(
    `SELECT sheet_id, tab_gid, tab_name, headers, header_row_index, detected_headers, data_start_row
       FROM raw_sheet_tabs
      WHERE ${where}
      LIMIT 1`,
    params
  );
  const tab = tabRows[0];
  if (!tab) {
    try {
      return await loadRawTabContextFromSheet(sheetId, tabGid, tabName);
    } catch (_) {
      return null;
    }
  }

  let headers = Array.isArray(tab.detected_headers) ? tab.detected_headers : null;
  let headerRowIndex = tab.header_row_index || null;
  let dataStartRow = tab.data_start_row || null;

  if (!headers || !headerRowIndex || !dataStartRow) {
    const { rows: firstRows } = await pool.query(
      `SELECT row_index, cells
         FROM raw_sheet_rows
        WHERE sheet_id = $1 AND tab_gid = $2
        ORDER BY row_index
        LIMIT 50`,
      [sheetId, tab.tab_gid]
    );
    const sparse = [];
    for (const r of firstRows) sparse[(parseInt(r.row_index, 10) || 1) - 1] = r.cells || [];
    const detected = detectSheetHeader(sparse);
    if (detected.headers) {
      headers = detected.headers;
      headerRowIndex = detected.headerRowIndex;
      dataStartRow = detected.dataStartRow;
      await pool.query(
        `UPDATE raw_sheet_tabs
            SET detected_headers = $3::jsonb,
                header_row_index = $4,
                data_start_row = $5
          WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, tab.tab_gid, JSON.stringify(headers), headerRowIndex, dataStartRow]
      );
    }
  }

  if (!headers || !headerRowIndex || !dataStartRow) {
    headers = Array.isArray(tab.headers) ? tab.headers : [];
    headerRowIndex = 1;
    dataStartRow = 2;
  }

  const { rows: dataRows } = await pool.query(
    `SELECT row_index AS "rowIndex", cells
       FROM raw_sheet_rows
      WHERE sheet_id = $1 AND tab_gid = $2 AND row_index >= $3
      ORDER BY row_index`,
    [sheetId, tab.tab_gid, dataStartRow]
  );

  return {
    sheetId,
    tabGid: tab.tab_gid,
    tabName: tab.tab_name,
    headers,
    headerRowIndex,
    dataStartRow,
    dataRows,
  };
}

async function claimRow({ client, sheetId, tabGid, tabName, dedupKey, candidateRows, orderId, meta = {} }) {
  const db = client || getPool();
  const candidates = (candidateRows || []).filter(r => Number.isInteger(parseInt(r, 10)) && parseInt(r, 10) > 0);
  const firstCandidate = candidates[0] || null;
  if (!sheetId || !tabName || !dedupKey) return { row: null, error: 'missing args' };

  let existing;
  try {
    existing = await db.query(
      `SELECT sheet_row FROM sheet_row_claims
       WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
      [sheetId, tabName, dedupKey]
    );
  } catch (e) {
    if (e.code === '42P01') return { row: firstCandidate, isNew: true, fallback: true };
    throw e;
  }
  if (existing.rows.length) {
    const row = existing.rows[0].sheet_row;
    if (orderId) {
      await db.query(
        `UPDATE sheet_row_claims
            SET order_id = COALESCE(order_id, $4), updated_at = NOW()
          WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
        [sheetId, tabName, dedupKey, orderId]
      );
    }
    return { row, isNew: false };
  }

  for (const rawRow of candidates) {
    const row = parseInt(rawRow, 10);
    const result = await db.query(
      `INSERT INTO sheet_row_claims
         (sheet_id, tab_gid, tab_name, sheet_row, dedup_key, order_id, name, phone8, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT DO NOTHING
       RETURNING sheet_row`,
      [
        sheetId,
        tabGid || null,
        tabName,
        row,
        dedupKey,
        orderId || null,
        meta.name || '',
        toPhone8(meta.phone8) || toPhone8(meta.phone),
        meta.source || 'order_submit',
      ]
    );
    if (result.rows.length) return { row, isNew: true };

    const again = await db.query(
      `SELECT sheet_row FROM sheet_row_claims
       WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3`,
      [sheetId, tabName, dedupKey]
    );
    if (again.rows.length) return { row: again.rows[0].sheet_row, isNew: false };
  }

  return { row: null, exhausted: true };
}

async function createOrderLedgerEntry(input) {
  const db = getPool();
  const {
    sheetId, tabName, gid, orderData,
    slotRowNumber, loginPhone8, loginName,
  } = input;
  const dedupKey = computeDedupKey(orderData);

  const insert = await db.query(
    `INSERT INTO order_submissions
      (sheet_id, tab_name, gid, tab_gid, orderer, recipient, user_id, phone, address,
       order_num, date_str, selected_opt_key, bank, account, depositor, price, memo,
       dedup_key, mirror_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending')
     RETURNING id`,
    [
      sheetId,
      tabName,
      gid || '',
      gid || '',
      orderData.orderer || '',
      orderData.recipient || '',
      orderData.userId || '',
      orderData.phone || '',
      orderData.address || '',
      orderData.orderNum || '',
      orderData.dateStr || '',
      orderData.selectedOptKey || '',
      orderData.bank || '',
      orderData.account || '',
      orderData.depositor || '',
      orderData.price || '',
      orderData.memo || '',
      dedupKey,
    ]
  );
  const orderSubmissionId = insert.rows[0].id;

  let tabContext = null;
  let claim = { row: null, error: 'not_attempted' };
  let candidateRows = [];
  let claimError = null;

  try {
    tabContext = await loadRawTabContext(sheetId, gid, tabName);
    candidateRows = slotRowNumber
      ? [parseInt(slotRowNumber, 10)]
      : (tabContext ? buildCandidateRows({
          headers: tabContext.headers,
          dataRows: tabContext.dataRows,
          headerRowIndex: tabContext.headerRowIndex,
          orderData,
        }) : []);

    if (!candidateRows.length) {
      claim = { row: null, error: 'no candidates' };
    } else {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        claim = await claimRow({
          client,
          sheetId,
          tabGid: (tabContext && tabContext.tabGid) || gid || '',
          tabName,
          dedupKey,
          candidateRows,
          orderId: orderSubmissionId,
          meta: {
            name: loginName || orderData.orderer || orderData.recipient || '',
            phone8: loginPhone8,
            phone: orderData.phone,
            source: 'order_submit',
          },
        });
        await client.query(
          `UPDATE order_submissions
              SET sheet_row = $2,
                  tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                  mirror_status = CASE WHEN $2 IS NULL THEN 'pending_no_row' ELSE 'pending' END,
                  sheet_error = CASE WHEN $2 IS NULL THEN $4 ELSE NULL END
            WHERE id = $1`,
          [
            orderSubmissionId,
            claim.row || null,
            (tabContext && tabContext.tabGid) || gid || '',
            claim.error || (claim.exhausted ? 'row claim exhausted' : 'row claim failed'),
          ]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        claimError = err;
        claim = { row: null, error: 'claim_failed', message: err.message };
      } finally {
        client.release();
      }
    }
  } catch (err) {
    claimError = err;
    claim = { row: null, error: 'row_assignment_failed', message: err.message };
  }

  if (!claim.row) {
    try {
      await db.query(
        `UPDATE order_submissions
            SET mirror_status = 'pending_no_row',
                tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                sheet_error = $2
          WHERE id = $1`,
        [
          orderSubmissionId,
          String((claimError && claimError.message) || claim.message || claim.error || 'row assignment failed').slice(0, 500),
          (tabContext && tabContext.tabGid) || gid || '',
        ]
      );
    } catch (err) {
      claim.statusUpdateError = err.message;
    }
  }

  return {
    orderSubmissionId,
    dedupKey,
    sheetRow: claim.row || null,
    claim,
    tabContext,
    tabGid: (tabContext && tabContext.tabGid) || gid || '',
    headers: tabContext ? tabContext.headers : [],
  };
}

async function markOrderQueued(orderSubmissionId) {
  if (!orderSubmissionId) return;
  await getPool().query(
    `UPDATE order_submissions SET queued_at = NOW(), mirror_status = 'queued' WHERE id = $1`,
    [orderSubmissionId]
  );
}

async function markOrderWritten(orderSubmissionId, sheetRow) {
  if (!orderSubmissionId) return;
  await getPool().query(
    `UPDATE order_submissions
        SET mirror_status = 'written',
            sheet_row = COALESCE($2, sheet_row),
            sheet_written_at = NOW(),
            sheet_error = NULL
      WHERE id = $1`,
    [orderSubmissionId, sheetRow || null]
  );
}

async function markOrderMirrorFailed(orderSubmissionId, err) {
  if (!orderSubmissionId) return;
  await getPool().query(
    `UPDATE order_submissions
        SET mirror_status = 'failed',
            sheet_error = $2
      WHERE id = $1`,
    [orderSubmissionId, String((err && err.message) || err || '').slice(0, 500)]
  );
}

async function recordReviewIdentity({ sheetId, tabName, tabGid, rowIndex, phone8, phone, name, recipient }) {
  try {
    const p8 = toPhone8(phone8) || toPhone8(phone);
    const ri = parseInt(rowIndex, 10);
    if (!sheetId || !tabName || !Number.isInteger(ri) || ri < 1 || !p8) return;
    const displayName = String(name || recipient || '').trim();
    await getPool().query(
      `UPDATE review_index
          SET phone8 = COALESCE(NULLIF($4, ''), phone8),
              recipient_name = COALESCE(NULLIF($5, ''), recipient_name),
              tab_gid = COALESCE(NULLIF($6, ''), tab_gid)
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
      [sheetId, tabName, ri, p8, displayName, tabGid || '']
    );
  } catch (_) {
    // Best-effort identity backfill. Submission durability is handled by order_submissions.
  }
}

module.exports = {
  computeDedupKey,
  buildCandidateRows,
  mapOrderToSheetRow,
  buildBatchUpdateData,
  buildMirrorGuardRange,
  loadRawTabContext,
  claimRow,
  createOrderLedgerEntry,
  markOrderQueued,
  markOrderWritten,
  markOrderMirrorFailed,
  recordReviewIdentity,
  getColLetter,
  __setPoolForTest,
};
