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

// ★ 미러 안 된 탭에 주문이 오면 그 시트를 백그라운드로 1회 자동미러(탭당 60초 debounce)
//   → 메타가 채워지면 즉시 그 시트의 막힌 주문을 리컨실(행배정+큐). 버스트에도 시트당 미러 1회뿐.
//   (예전: 제출마다 시트를 라이브로 통읽기 → 동시 수백건이면 시트 쿼터 폭발. 그 경로를 대체.)
const _mirrorTriggered = new Map(); // sheetId → 마지막 트리거 시각(ms)
function _triggerSheetMirrorOnce(sheetId) {
  if (!sheetId) return;
  const now = Date.now();
  const last = _mirrorTriggered.get(sheetId) || 0;
  if (now - last < 60000) return; // 60초 debounce
  _mirrorTriggered.set(sheetId, now);
  setImmediate(async () => {
    try {
      const { mirrorOneSheet } = require('./rawMirror.service');
      await mirrorOneSheet(sheetId);
      await reconcileStuckOrders({ sheetId, limit: 500, perTabCap: 500 });
    } catch (_) { /* best-effort; 정규 cron(미러 5분·리컨실 2분)이 backstop */ }
  });
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

function buildCandidateRows({ headers, dataRows, headerRowIndex, orderData = {}, appendOnly = false }) {
  const candidates = [];
  const seen = new Set();
  const rows = (dataRows || []).map((r, idx) => ({
    rowIndex: parseInt(r.rowIndex, 10) || ((headerRowIndex || 0) + 1 + idx),
    cells: normalizeCells(r.cells || r),
  }));

  // ★ appendOnly: 복구(reconcile) 경로 — 제자리(인애드/옵션/빈행) 매칭을 건너뛰고
  //   기존 데이터 "아래"의 새 행만 후보로 삼는다(노란 배경으로 append 기록 → 수동입력분과 구분).
  if (!appendOnly) {
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
  } // end if(!appendOnly)

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
  const rowData = mapOrderToSheetRow(headers, orderData);
  const preferredCol = findColumn(headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  const addressCol = findColumn(headers, ['주소', 'address']);
  let col = preferredCol >= 0 ? preferredCol : addressCol;

  if (col < 0) {
    col = rowData.findIndex(v => v !== null && String(v == null ? '' : v).trim() !== '');
  }
  if (col < 0) return null;

  return {
    range: `'${tabName}'!${getColLetter(col)}${targetRow}`,
    col,
    header: headers[col] || '',
    // ★ 이 주문이 가드 칸에 쓸 값(보통 연락처). 재시도 시 "내가 쓴 값"과 외부 기입을 구분하는 데 사용.
    expected: rowData[col] != null ? String(rowData[col]) : '',
  };
}

// 가드 칸 값 정규화 — 연락처류는 숫자만 비교(서식 차이 무시), 그 외는 trim 비교.
function normalizeGuardValue(header, val) {
  const s = String(val == null ? '' : val).trim();
  if (/연락처|전화|핸드폰|휴대폰|phone/i.test(String(header || ''))) {
    return s.replace(/[^0-9]/g, '');
  }
  return s;
}

// 미러 쓰기를 막아야 하는가? (덮어쓰기 방지)
//   - 가드 칸이 비어있음            → false (안전, 써도 됨)
//   - 가드 칸 == 이 주문의 기대값    → false (내가 이미 쓴 값 = 멱등 재기입, 허용)
//   - 가드 칸에 다른 값             → true  (외부/타 주문 기입 = 차단)
function guardBlocksWrite(existingVal, guard) {
  const header = guard && guard.header;
  const existing = normalizeGuardValue(header, existingVal);
  if (!existing) return false;
  const expected = normalizeGuardValue(header, guard && guard.expected);
  if (expected && existing === expected) return false;
  return true;
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

  // ★ 미러(rawMirror)와 동일하게 FORMATTED_VALUE로 읽어 라이브폴백/미러 간
  //   raw_sheet_rows 표기 일관성 유지 (날짜 등이 직렬숫자 45463이 아니라 시트 표기 "11/23"로 저장).
  //   행배정은 텍스트 컬럼(연락처/주소/인애드/옵션) 기준이라 서식 변경에 영향 없음.
  const rows = await throttledCall(() =>
    readSheet(sheetId, `'${escapeSheetName(resolvedTabName)}'!A:ZZ`,
      resolvedGid
        ? { gid: resolvedGid, valueRenderOption: 'FORMATTED_VALUE' }
        : { valueRenderOption: 'FORMATTED_VALUE' })
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
    // ★ 미러 안 된 탭: per-제출 라이브읽기(버스트 시 시트 쿼터 위험) 대신
    //   그 시트를 백그라운드로 1회 자동미러(debounce) → 메타 채운 뒤 리컨실이 복구.
    //   이 주문은 일단 행 없음(null) → pending_no_row → 자동복구가 시트에 기록(손실 0).
    _triggerSheetMirrorOnce(sheetId);
    return null;
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
              SET sheet_row = $2::int,
                  tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                  mirror_status = CASE WHEN $2::int IS NULL THEN 'pending_no_row' ELSE 'pending' END,
                  sheet_error = CASE WHEN $2::int IS NULL THEN $4 ELSE NULL END
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
            sheet_row = COALESCE($2::int, sheet_row),
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

/**
 * 막힌 주문 복구/리컨실 — order_submissions에서 시트에 못 들어간 주문을 찾아
 * 행을 재배정하고 order_append 큐에 다시 올린다. (복구분은 하단 append + 노란 배경)
 *
 * - 대상: mirror_status IN ('pending','pending_no_row','failed') + 정체된 'queued'
 * - RAW 미러 메타가 없는 탭은 skip(자가치유 대기) — 여기서 라이브폴백 금지(쿼터 버스트 방지)
 * - createOrderLedgerEntry는 호출 안 함(매번 INSERT됨). 기존 order 행에 대해
 *   행배정 하위단계(loadRawTabContext→buildCandidateRows(appendOnly)→claimRow)만 재실행
 * - claimRow의 dedup 유니크로 재시도해도 같은 행 반환 → 시트 중복행 없음
 */
async function reconcileStuckOrders({ limit = 50, perTabCap = 20, sheetId = null, staleQueuedMinutes = 10, dryRun = false } = {}) {
  const db = getPool();
  const { enqueue } = require('./syncQueue.service'); // lazy: require 순환 회피

  const params = [staleQueuedMinutes];
  let sheetFilter = '';
  if (sheetId) { params.push(sheetId); sheetFilter = `AND os.sheet_id = $${params.length}`; }
  params.push(limit);
  const limitIdx = params.length;

  const { rows } = await db.query(
    `SELECT os.id, os.sheet_id, os.tab_name, os.gid, os.tab_gid, os.dedup_key,
            os.orderer, os.recipient, os.user_id, os.phone, os.address,
            os.order_num, os.date_str, os.selected_opt_key, os.bank, os.account,
            os.depositor, os.price, os.memo, os.mirror_status, os.sheet_row
       FROM order_submissions os
      WHERE (os.mirror_status IN ('pending','pending_no_row','failed')
             OR (os.mirror_status = 'queued'
                 AND os.queued_at IS NOT NULL
                 AND os.queued_at < NOW() - ($1 || ' minutes')::interval
                 AND NOT EXISTS (
                   SELECT 1 FROM sync_queue sq
                    WHERE sq.type = 'order_append'
                      AND sq.status IN ('pending','processing')
                      AND (sq.payload->>'orderSubmissionId') = os.id::text)))
        ${sheetFilter}
      ORDER BY (os.mirror_status <> 'pending_no_row'), os.submitted_at ASC
      LIMIT $${limitIdx}`,
    params
  );

  const result = { scanned: rows.length, requeued: 0, skippedNoMeta: 0, noCandidates: 0, stillStuck: 0, byTab: [], dryRun };
  const tabCount = new Map();

  for (const row of rows) {
    const tabKey = `${row.sheet_id}||${row.tab_name}`;
    if ((tabCount.get(tabKey) || 0) >= perTabCap) continue;
    tabCount.set(tabKey, (tabCount.get(tabKey) || 0) + 1);

    const orderData = {
      orderer: row.orderer, recipient: row.recipient, userId: row.user_id, phone: row.phone,
      address: row.address, orderNum: row.order_num, dateStr: row.date_str,
      selectedOptKey: row.selected_opt_key, bank: row.bank, account: row.account,
      depositor: row.depositor, price: row.price, memo: row.memo,
    };
    const dedupKey = row.dedup_key || computeDedupKey(orderData);
    const gid = row.tab_gid || row.gid || '';

    // 이미 행이 있는 주문(failed/정체 queued) → 재배정 없이 바로 재-enqueue
    if (row.sheet_row) {
      if (dryRun) { result.requeued++; continue; }
      try {
        await enqueue('order_append', {
          sheetId: row.sheet_id, tabName: row.tab_name, gid,
          orderData, orderSubmissionId: row.id, sheetRow: row.sheet_row,
          dedupKey, loginPhone8: '', loginName: '', recovered: true,
        });
        await markOrderQueued(row.id);
        result.requeued++;
      } catch (_) { result.stillStuck++; }
      continue;
    }

    // 행 배정 필요 → RAW 컨텍스트(메타 없으면 skip, 라이브폴백 금지)
    let tabContext = null;
    try { tabContext = await loadRawTabContext(row.sheet_id, gid, row.tab_name); } catch (_) {}
    if (!tabContext || !tabContext.headers || !tabContext.headers.length) {
      result.skippedNoMeta++;
      continue;
    }

    const candidateRows = buildCandidateRows({
      headers: tabContext.headers, dataRows: tabContext.dataRows,
      headerRowIndex: tabContext.headerRowIndex, orderData, appendOnly: true,
    });
    if (!candidateRows.length) { result.noCandidates++; continue; }
    if (dryRun) { result.requeued++; continue; }

    const client = await db.connect();
    let claim = { row: null };
    try {
      await client.query('BEGIN');
      claim = await claimRow({
        client, sheetId: row.sheet_id,
        tabGid: tabContext.tabGid || gid, tabName: row.tab_name,
        dedupKey, candidateRows, orderId: row.id,
        meta: { name: row.orderer || row.recipient || '', phone: row.phone, source: 'order_reconcile' },
      });
      await client.query(
        `UPDATE order_submissions
            SET sheet_row = $2::int,
                tab_gid = COALESCE(NULLIF($3, ''), tab_gid),
                mirror_status = CASE WHEN $2::int IS NULL THEN 'pending_no_row' ELSE 'pending' END,
                sheet_error = CASE WHEN $2::int IS NULL THEN $4 ELSE NULL END
          WHERE id = $1`,
        [row.id, claim.row || null, tabContext.tabGid || gid,
         claim.error || (claim.exhausted ? 'row claim exhausted' : 'row claim failed')]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      result.stillStuck++;
      client.release();
      continue;
    }
    client.release();

    if (!claim.row) { result.stillStuck++; continue; }

    try {
      await enqueue('order_append', {
        sheetId: row.sheet_id, tabName: row.tab_name, gid: tabContext.tabGid || gid,
        orderData, orderSubmissionId: row.id, sheetRow: claim.row,
        dedupKey, loginPhone8: '', loginName: '', recovered: true,
      });
      await markOrderQueued(row.id);
      result.requeued++;
    } catch (_) { result.stillStuck++; }
  }

  result.byTab = Array.from(tabCount.entries()).map(([tab, processed]) => ({ tab, processed }));
  return result;
}

module.exports = {
  computeDedupKey,
  buildCandidateRows,
  reconcileStuckOrders,
  mapOrderToSheetRow,
  buildBatchUpdateData,
  buildMirrorGuardRange,
  guardBlocksWrite,
  normalizeGuardValue,
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
