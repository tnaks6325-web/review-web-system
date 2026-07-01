const { detectSheetHeader, normalizeCells } = require('../utils/sheetHeader');
const { logger } = require('../utils/logger');

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
      const { withJobLock } = require('../utils/jobLock');
      await mirrorOneSheet(sheetId);
      // ★ #1: cron/flush reconcile과 동일한 order_reconcile 락으로 직렬화(동시 행배정 경합 차단).
      //   락 busy면 양보 — 정규 cron(리컨실 2분)이 backstop.
      await withJobLock('order_reconcile', () => reconcileStuckOrders({ sheetId, limit: 500, perTabCap: 500 }));
    } catch (_) { /* best-effort; 정규 cron(미러 5분·리컨실 2분)이 backstop */ }
  });
}

// ★ F2: 실시간 "마지막 데이터 행"을 탭당 1콜로 조회.
//   주의: gridProperties.rowCount는 그리드 할당크기(예 1010)지 데이터 끝이 아니다 →
//   그걸 base로 쓰면 append가 데이터 한참 아래(빈칸 수백 행 점프)로 떨어진다.
//   values.get(범위=탭명)은 후행 빈 행을 트림 → 반환 행수 = 실제 마지막 데이터행(1-indexed). 이게 정답.
//   metaCache(사이클 맵)로 같은 사이클 내 탭당 중복콜 제거. base 하한 보정 전용(배치 reconcile만 사용).
async function _getRealMaxRow(sheetId, tabGid, tabName, metaCache) {
  const { readSheet } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');
  const cacheKey = `${sheetId}||${tabName}`;
  if (metaCache && metaCache.has(cacheKey)) return metaCache.get(cacheKey);
  const safeTab = String(tabName || '').replace(/'/g, "''");
  // gid 미전달 → values.get 경로(후행 빈행 트림). 탭명은 시트 내 유니크(구글 강제)라 안전.
  const grid = await throttledCall(() => readSheet(sheetId, `'${safeTab}'`, {}));
  const lastRow = Array.isArray(grid) ? grid.length : 0;
  if (metaCache) metaCache.set(cacheKey, lastRow);
  return lastRow;
}

function toPhone8(v) {
  const d = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, '');
}

function computeDedupKey({ orderNum, recipient, phone, dateStr, selectedOptKey, orderSubmissionId } = {}) {
  const num = String(orderNum == null ? '' : orderNum).replace(/[^0-9]/g, '');
  if (num.length >= 6) return `num:${num}`;
  // ★ D4(#5): 주문번호가 약하면(쿠팡 비번호/분할주문 등 6자리 미만) 같은 사람·같은 날·같은 옵션의
  //   별개 주문 2건이 동일 dedupKey → 같은 행 공유 → 한 건 시트 영구소실. orderSubmissionId(UUID)를
  //   폴백 키로 써서 별개 주문은 별개 행. reconcile은 row.dedup_key를 재사용하므로 재시도 멱등 유지.
  if (orderSubmissionId) return `osid:${orderSubmissionId}`;
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

function buildCandidateRows({ headers, dataRows, headerRowIndex, orderData = {}, appendOnly = false, appendBaseRow = 0 }) {
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

  // ★ R-2a: append base를 미러 maxRow와 claims MAX(appendBaseRow) 중 큰 값으로 통일.
  //   제출 핫패스가 claims를 안 보면 같은 maxRow+1을 여러 제출이 동시 후보로 잡아 동일행 경쟁(버스트) →
  //   claims MAX 합류로 reconcile과 단일 진실원본화(단조증가, 손실0).
  const maxRow = Math.max(
    rows.reduce((max, row) => Math.max(max, row.rowIndex), headerRowIndex || 1),
    parseInt(appendBaseRow, 10) || 0
  );
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

// ★ D3a(#3): 다중컬럼 가드 — 연락처 한 칸만 보면 그 칸만 빈 수동입력행을 "비었음"으로 오판해 덮어쓴다.
//   연락처+주소+수취인 3칸을 검사해 하나라도 외부값이면 차단. (range 없이 col만 — 호출부가 한 행을
//   한 번에 읽어 셀별로 판정 → 쿼터 1회 유지.) 헤더에서 못 찾으면 첫 비어있지 않은 기대값 칸으로 폴백.
function buildMirrorGuardRanges({ tabName, headers, targetRow, orderData = {} }) {
  const rowData = mapOrderToSheetRow(headers, orderData);
  const cols = [];
  const add = (kw, ex = []) => { const i = findColumn(headers, kw, ex); if (i >= 0) cols.push(i); };
  add(['연락처', '전화', '핸드폰', '휴대폰'], ['phone']);
  add(['주소', 'address']);
  add(['수취인', '받는분', '이름', 'recipient']);
  let uniq = [...new Set(cols)];
  if (!uniq.length) {
    const i = rowData.findIndex(v => v !== null && String(v == null ? '' : v).trim() !== '');
    if (i >= 0) uniq = [i];
  }
  return uniq.map(col => ({
    col,
    header: headers[col] || '',
    expected: rowData[col] != null ? String(rowData[col]) : '',
  }));
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
    `SELECT sheet_id, tab_gid, tab_name, headers, header_row_index, detected_headers, data_start_row,
            COUNT(*) OVER () AS _dup
       FROM raw_sheet_tabs
      WHERE ${where}
      ORDER BY mirrored_at DESC NULLS LAST
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
  // ★ D5b(#8): gid 없이 tab_name으로 매칭했는데 동명 탭이 여러 개(복제 후 미정리)면 임의 1개 선택 시
  //   다른 탭에 오배정 위험 → 보류(pending_no_row). 미러 재유도로 gid가 채워질 때까지 자가치유.
  if (!tabGid && parseInt(tab._dup, 10) > 1) {
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
    // ★ D5d(#10): claims 테이블 부재(부팅/복구 윈도우)면 무검증 firstCandidate 배정 금지.
    //   배정 보류(pending_no_row) → 다음 reconcile이 정상 claim. 멱등·중복방지 무력화 차단.
    if (e.code === '42P01') return { row: null, error: 'claims table missing (boot window)' };
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
  // ★ D4(#5): osid 폴백 dedupKey를 쓰려면 먼저 id가 필요 → INSERT(dedup_key NULL) 후 osid 포함 키 계산·UPDATE.
  const insert = await db.query(
    `INSERT INTO order_submissions
      (sheet_id, tab_name, gid, tab_gid, orderer, recipient, user_id, phone, address,
       order_num, date_str, selected_opt_key, bank, account, depositor, price, memo,
       dedup_key, mirror_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NULL,'pending')
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
    ]
  );
  const orderSubmissionId = insert.rows[0].id;
  const dedupKey = computeDedupKey({ ...orderData, orderSubmissionId });
  await db.query(`UPDATE order_submissions SET dedup_key = $2 WHERE id = $1`, [orderSubmissionId, dedupKey]);

  let tabContext = null;
  let claim = { row: null, error: 'not_attempted' };
  let candidateRows = [];
  let claimError = null;

  try {
    tabContext = await loadRawTabContext(sheetId, gid, tabName);
    // ★ R-2a: 제출 claim 후보 base에 claims MAX 합류(reconcile과 동일기준) → 버스트 동일행 경쟁 차단.
    let claimsMax = 0;
    try {
      const mc = await db.query(
        `SELECT COALESCE(MAX(sheet_row),0) AS m FROM sheet_row_claims WHERE sheet_id=$1 AND tab_name=$2`,
        [sheetId, tabName]
      );
      claimsMax = parseInt(mc.rows[0].m, 10) || 0;
    } catch (_) { /* claims 조회 실패는 미러 base로 폴백 */ }
    candidateRows = slotRowNumber
      ? [parseInt(slotRowNumber, 10)]
      : (tabContext ? buildCandidateRows({
          headers: tabContext.headers,
          dataRows: tabContext.dataRows,
          headerRowIndex: tabContext.headerRowIndex,
          orderData,
          appendBaseRow: claimsMax,
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
  // ★ R1: 단조전이 가드. 펌프(queuePump)가 enqueue 직후 이 주문을 이미 'written' 처리했다면
  //   여기서 'queued'로 역행시키지 않는다(written이면 UPDATE 0행=무해). markOrderWritten은
  //   무가드 유지 — reconcile의 'failed'→'written' 정상전이를 막지 않기 위함.
  await getPool().query(
    `UPDATE order_submissions SET queued_at = NOW(), mirror_status = 'queued'
       WHERE id = $1 AND mirror_status <> 'written'`,
    [orderSubmissionId]
  );
}

async function markOrderWritten(orderSubmissionId, sheetRow, sig = null) {
  if (!orderSubmissionId) return;
  await getPool().query(
    `UPDATE order_submissions
        SET mirror_status = 'written',
            sheet_row = COALESCE($2::int, sheet_row),
            sheet_written_at = NOW(),
            sheet_error = NULL,
            last_sheet_write_sig = COALESCE($3, last_sheet_write_sig)
      WHERE id = $1`,
    [orderSubmissionId, sheetRow || null, sig]
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
async function reconcileStuckOrders({ limit = 50, perTabCap = 20, sheetId = null, tabName = null, staleQueuedMinutes = 10, dryRun = false, useLiveMaxRow = false } = {}) {
  const db = getPool();
  const { enqueue } = require('./syncQueue.service'); // lazy: require 순환 회피
  const _metaByTab = new Map(); // F2/J-2: 사이클 내 getSpreadsheetMeta 중복콜 제거(시트당 1콜)

  const params = [staleQueuedMinutes];
  let sheetFilter = '';
  if (sheetId) { params.push(sheetId); sheetFilter += ` AND os.sheet_id = $${params.length}`; }
  if (tabName) { params.push(tabName); sheetFilter += ` AND os.tab_name = $${params.length}`; } // 탭 단위 우선 복구
  params.push(limit);
  const limitIdx = params.length;

  const { rows } = await db.query(
    `SELECT os.id, os.sheet_id, os.tab_name, os.gid, os.tab_gid, os.dedup_key,
            os.orderer, os.recipient, os.user_id, os.phone, os.address,
            os.order_num, os.date_str, os.selected_opt_key, os.bank, os.account,
            os.depositor, os.price, os.memo, os.mirror_status, os.sheet_row
       FROM order_submissions os
      WHERE os.deleted_at IS NULL
        AND (os.mirror_status IN ('pending','pending_no_row','failed')
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
  const tabCursors = new Map(); // tabKey → 마지막 배정 append 행(순차 커서, 20행 한계 제거)

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
    // ★ D4 보강(리뷰 should-fix): INSERT↔dedup_key UPDATE 사이 크래시로 dedup_key가 NULL이면,
    //   여기서 osid(row.id) 폴백을 넣어 재계산해야 원래 osid 키와 일치(없으면 약한 rcp 키로 떨어져 #5 충돌 재발).
    const dedupKey = row.dedup_key || computeDedupKey({ ...orderData, orderSubmissionId: row.id });
    const gid = row.tab_gid || row.gid || '';

    // 이미 행이 있는 주문(failed/정체 queued) → 재배정 없이 바로 재-enqueue
    if (row.sheet_row) {
      if (dryRun) { result.requeued++; continue; }
      // ★ 공정화 #3(R1 근원): 이미 live(pending/processing) order_append가 있으면 재생성 금지 →
      //   고아 큐 누적 차단(written된 주문의 잔여 항목이 throttle를 반복 잠식하던 원인). queued 분기와 동일 가드.
      try {
        const { rows: dup } = await db.query(
          `SELECT 1 FROM sync_queue WHERE type='order_append' AND status IN ('pending','processing')
             AND (payload->>'orderSubmissionId') = $1 LIMIT 1`,
          [String(row.id)]
        );
        if (dup.length) { result.requeued++; continue; }
      } catch (_) { /* 가드 조회 실패는 무시하고 재큐잉(보수적) */ }
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

    if (dryRun) { result.requeued++; continue; } // 하단 append는 항상 가능

    // ★ 하단 append 행을 "탭별 순차 커서"로 배정(O(n), 20행 한계 제거).
    //   커서 시작 = max(미러 데이터 마지막행, 이미 점유된 sheet_row_claims 최대행) → 패스 간 충돌 없음.
    let cursor = tabCursors.get(tabKey);
    if (cursor == null) {
      let baseRow = tabContext.headerRowIndex || 0;
      for (const dr of (tabContext.dataRows || [])) {
        const ri = parseInt(dr.rowIndex, 10) || 0;
        if (ri > baseRow) baseRow = ri;
      }
      try {
        const mc = await db.query(
          `SELECT COALESCE(MAX(sheet_row), 0) AS m FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2`,
          [row.sheet_id, row.tab_name]
        );
        const claimed = parseInt(mc.rows[0].m, 10) || 0;
        if (claimed > baseRow) baseRow = claimed;
      } catch (_) {}
      // ★ F2: stale 미러로 base가 실제 시트보다 작으면 이미 채워진 행을 claim → 가드블록 스래싱.
      //   useLiveMaxRow(배치 reconcile만)일 때 실시간 그리드 끝행을 base 하한으로 보정(시트당 1콜, 사이클 캐시).
      //   append-only라 그리드 끝 아래는 항상 빈칸 → 가드 통과 보장.
      //   ★ 단, 라이브읽기는 throttle(45/분)에 직렬화되므로 버스트로 throttle 포화면 ~60s 블록 →
      //     pnr 복구가 60s 지연(인터리브 다탭 관측). claims MAX/미러 base가 이미 append에 충분하므로
      //     throttle 여유 없을 땐 라이브읽기 SKIP(캐시값 있으면 사용). 수동행은 다중컬럼 가드가 잡음.
      if (useLiveMaxRow) {
        let live = false;
        const cached = _metaByTab.has(`${row.sheet_id}||${row.tab_name}`);
        if (cached) { live = true; }
        else {
          try {
            const { getThrottleStatus } = require('../utils/sheetsThrottle');
            const busyN = parseInt(process.env.ORDER_RECONCILE_LIVE_MAXROW_BUSY || '30', 10);
            live = getThrottleStatus().requestsInLastMinute < busyN;
          } catch (_) { live = true; }
        }
        if (live) {
          try {
            const realMax = await _getRealMaxRow(row.sheet_id, tabContext.tabGid || gid, row.tab_name, _metaByTab);
            if (realMax > baseRow) baseRow = realMax;
          } catch (e) { logger.warn(`[reconcile] realMaxRow 실패(미러 base 유지): ${e.message}`); }
        }
      }
      cursor = baseRow;
    }
    cursor += 1;
    const candidateRows = [cursor, cursor + 1, cursor + 2, cursor + 3, cursor + 4]; // 작은 버퍼(동시 cron 충돌 대비)
    tabCursors.set(tabKey, cursor);

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
    { const cr = parseInt(claim.row, 10) || 0; if (cr > (tabCursors.get(tabKey) || 0)) tabCursors.set(tabKey, cr); }

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

// ── PR-B 헬퍼: order_submissions 행 → orderData(편집/취소/append fresh값 공유) ──
function _osRowToOrderData(os) {
  return {
    orderer: os.orderer, recipient: os.recipient, userId: os.user_id, phone: os.phone, address: os.address,
    bank: os.bank, account: os.account, depositor: os.depositor, price: os.price, orderNum: os.order_num,
    memo: os.memo, dateStr: os.date_str, selectedOptKey: os.selected_opt_key,
  };
}

// 편집 가능 필드 → 헤더 키워드(한글/라틴). _fieldToCol이 헤더에서 컬럼 인덱스를 찾는다.
const _FIELD_HEADER_KW = {
  orderer: [['주문자'], ['orderer']],
  recipient: [['수취인', '받는분', '이름'], ['recipient']],
  user_id: [['아이디'], ['userid', 'id']],
  phone: [['연락처', '전화', '핸드폰', '휴대폰'], ['phone']],
  address: [['주소'], ['address']],
  bank: [['은행'], ['bank']],
  account: [['계좌'], ['account']],
  depositor: [['예금주'], ['depositor']],
  price: [['금액'], ['price']],
  order_num: [['주문번호'], ['ordernum']],
  memo: [['비고', '특이사항'], ['memo']],
  date_str: [['일자', '날짜'], ['date']],
  selected_opt_key: [['옵션'], ['option']],
};
function _fieldToCol(headers, field) {
  const def = _FIELD_HEADER_KW[field];
  if (!def) return -1;
  return findColumn(headers, def[0], def[1] || []);
}

// ── 시트→DB 역동기화(옵션·수동) 대상 필드(G4: 옵션·dedup영향칸 제외). ──
//   selected_opt_key(옵션칸)는 역매핑이 비결정적이라 제외. recipient/phone은 dedupKey 입력이지만
//   apply가 order_update(매핑칸 in-place)만 타고 dedup_key/claims를 안 건드리므로 포함 가능(R6 방어).
const REVERSE_SYNC_FIELDS = ['orderer', 'recipient', 'user_id', 'phone', 'address', 'bank', 'account', 'depositor', 'price', 'order_num', 'memo', 'date_str'];

// R1 provenance: DB가 "마지막으로 시트에 쓴 매핑칸 값"의 서명. 정방향 written 시 기록.
//   detect가 "현재 시트값 == 이 서명"이면 내가 쓴 흔적 → 제외(핑퐁/노이즈 차단).
//   detect의 _sigFromCells와 동일 필드·순서·정규화를 써야 일치한다.
function computeRowWriteSig(headers, orderData) {
  const mapped = mapOrderToSheetRow(headers, orderData || {});
  const parts = [];
  for (const f of REVERSE_SYNC_FIELDS) {
    const c = _fieldToCol(headers, f);
    if (c >= 0) parts.push(f + '=' + normalizeText(mapped[c]));
  }
  return parts.join('');
}

// ── R1: 그 시트 행이 "여전히 이 주문의 것"인지 다중칸(연락처+수취인+주소) AND 일치로 판정.
//   취소 클리어 전 안전가드 — 사람이 그 행을 재사용했으면 일치 안 해 클리어 거부(데이터 파괴 방지).
//   J-2: 그리드밖 행(빈읽기)은 사람이 손댈 수 없으므로 gridOutOfRange=true로 표시(호출부가 진행 허용).
async function rowIdentityMatches(os, tabContext) {
  const { readSheet, invalidateSheetMeta } = require('./sheets.service');
  const { throttledCall } = require('../utils/sheetsThrottle');
  const sheetId = os.sheet_id || os.sheetId;
  const cands = [
    [findColumn(tabContext.headers, ['연락처', '전화', '핸드폰', '휴대폰'], ['phone']), os.phone],
    [findColumn(tabContext.headers, ['수취인', '받는분', '이름'], ['recipient']), os.recipient],
    [findColumn(tabContext.headers, ['주소'], ['address']), os.address],
  ].filter(([c, v]) => c >= 0 && String(v == null ? '' : v).trim());
  if (!cands.length) return { match: false, gridOutOfRange: false }; // 비교 불가 → 안전: 클리어 거부
  const cols = cands.map(([c]) => c);
  const minC = Math.min(...cols), maxC = Math.max(...cols);
  const range = `'${tabContext.tabName}'!${getColLetter(minC)}${os.sheet_row}:${getColLetter(maxC)}${os.sheet_row}`;
  invalidateSheetMeta(sheetId);
  const read = await throttledCall(() => readSheet(sheetId, range,
    tabContext.tabGid ? { gid: tabContext.tabGid } : {}));
  if (!read || read.length === 0) return { match: false, gridOutOfRange: true }; // J-2: 그리드밖=사람 손 불가
  const cells = read[0] || [];
  const match = cands.every(([col, val]) => {
    const cur = normalizeGuardValue(tabContext.headers[col], cells[col - minC]);
    const exp = normalizeGuardValue(tabContext.headers[col], val);
    return cur && exp && cur === exp;
  });
  return { match, gridOutOfRange: false };
}

// ════════════════════════════════════════════════════════════════════════
// 시트→DB 역동기화(옵션·수동·기본 OFF) — 감지(detect). 읽기 전용 + 제안 생성.
//   심판 최종설계: 자동 무인 동기 금지. 사람이 reverse-sync-apply로 명시 적용.
//   방어: R1(sig 제외) · R2(라이브 단일 사각형 읽기, 미러 값판정 금지) · R3(identity AND 3칸)
//        · R4(그리드밖/전공란=cancel_suspect 플래그만, 단칸 공란 무시) · R5(order_reconcile 락)
//        · R10/G5(throttle busy면 양보) · R11(gid 없으면 보류) · G3(기본 sig-not-null 주문만).
// ════════════════════════════════════════════════════════════════════════
async function detectReverseSyncProposals({ sheetId, tabName, limit = 200, includeNullSig = false, ignoreBusy = false, useLiveHeaders = true } = {}) {
  if (process.env.SHEET_REVERSE_SYNC !== '1') return { skipped: true, reason: 'disabled' };
  if (!sheetId || !tabName) throw new Error('detectReverseSyncProposals: sheetId, tabName 필수');
  const { withJobLock } = require('../utils/jobLock');
  return withJobLock('order_reconcile',
    () => _detectReverseSyncInner({ sheetId, tabName, limit, includeNullSig, ignoreBusy, useLiveHeaders }),
    { onBusy: () => ({ skipped: true, reason: 'order_reconcile_lock_busy' }) });
}

const _HEADER_SCAN_ROWS = parseInt(process.env.REVERSE_SYNC_HEADER_SCAN || '20', 10);

async function _detectReverseSyncInner({ sheetId, tabName, limit, includeNullSig, ignoreBusy, useLiveHeaders }) {
  const db = getPool();
  const { getThrottleStatus, throttledCall } = require('../utils/sheetsThrottle');
  const { readSheet, invalidateSheetMeta } = require('./sheets.service');

  // R10/G5: throttle 여유 없으면 양보(정방향 핫패스 우선). 단 수동 트리거(ignoreBusy)는 소량 콜이라
  //   busy-skip 대신 throttledCall이 슬롯을 기다려 실행(관리자 즉시 결과). cron은 ignoreBusy=false로 양보.
  const busyN = parseInt(process.env.REVERSE_SYNC_BUSY || '15', 10);
  if (!ignoreBusy && getThrottleStatus().requestsInLastMinute > busyN) return { skipped: true, reason: 'throttle_busy' };

  // R11: gid 필수(동명탭 보류). gid는 미러 메타에서.
  const ctx = await loadRawTabContext(sheetId, null, tabName);
  if (!ctx || !ctx.tabGid) return { skipped: true, reason: 'no_meta_or_gid' };
  let headers = ctx.headers;

  // ★ 라이브 헤더 읽기(#2): 미러가 stale/희소하면 detected_headers가 실제 시트 열배치와 어긋나
  //   컬럼 오매핑→오탐(cancel_suspect 폭발). 상단 N행을 라이브로 읽어 헤더를 현재 시트 기준 재감지(1콜).
  //   미러 헤더와 무관하게 컬럼 정확도 보장 → 어떤 탭에서도 detect 정확.
  if (useLiveHeaders) {
    try {
      const top = await throttledCall(() => readSheet(sheetId,
        `'${ctx.tabName}'!A1:ZZ${_HEADER_SCAN_ROWS}`, { gid: ctx.tabGid }));
      const det = detectSheetHeader(Array.isArray(top) ? top : []);
      if (det && det.headers && det.headers.length) headers = det.headers;
    } catch (e) { logger.warn(`[reverseSync] 라이브 헤더 읽기 실패(미러 헤더 사용): ${e.message}`); }
  }
  if (!headers || !headers.length) return { skipped: true, reason: 'no_headers' };

  // 필드→컬럼 매핑(헤더 고정). 식별칸(연락처/수취인/주소) + 역동기 대상칸.
  const fieldCols = {};
  for (const f of REVERSE_SYNC_FIELDS) { const c = _fieldToCol(headers, f); if (c >= 0) fieldCols[f] = c; }
  const idFields = ['phone', 'recipient', 'address'].filter(f => fieldCols[f] != null);
  if (!Object.keys(fieldCols).length || !idFields.length) return { scanned: 0, proposals: 0, reason: 'no_mappable_cols' };

  // R9/G3: written·미취소·행배정 주문만. 기본은 sig 있는 주문만(과거 전수비교 노이즈 폭발 차단).
  const sigFilter = includeNullSig ? '' : ' AND last_sheet_write_sig IS NOT NULL';
  const { rows: orders } = await db.query(
    `SELECT id, sheet_row, orderer, recipient, user_id, phone, address, bank, account, depositor,
            price, order_num, memo, date_str, selected_opt_key, last_sheet_write_sig, last_edit_seq
       FROM order_submissions
      WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        AND mirror_status = 'written' AND sheet_row IS NOT NULL${sigFilter}
      ORDER BY sheet_row LIMIT $3`,
    [sheetId, tabName, limit]
  );
  if (!orders.length) return { scanned: 0, proposals: 0 };

  // R2: 라이브 단일 사각형 1콜(미러 금지). 매핑칸 union × 주문 행 범위.
  const cols = Object.values(fieldCols);
  const minC = Math.min(...cols), maxC = Math.max(...cols);
  const rows = orders.map(o => o.sheet_row);
  const minR = Math.min(...rows), maxR = Math.max(...rows);
  invalidateSheetMeta(sheetId);
  const grid = await throttledCall(() => readSheet(sheetId,
    `'${ctx.tabName}'!${getColLetter(minC)}${minR}:${getColLetter(maxC)}${maxR}`, { gid: ctx.tabGid }));

  let made = 0, edits = 0, suspects = 0, skippedSig = 0, identMismatch = 0;
  for (const os of orders) {
    const gi = os.sheet_row - minR;
    const gridRow = grid && grid[gi];
    const cellAt = (c) => (gridRow ? gridRow[c - minC] : undefined);
    const gridOutOfRange = !gridRow || gridRow.length === 0; // R4: 그리드밖/빈행 = 사람 손 불가

    // R3: identity AND(연락처+수취인+주소) — cells에서 직접(추가 쿼터 0).
    let allGuardEmpty = true, idMatch = true, idComparable = 0;
    for (const f of idFields) {
      const c = fieldCols[f];
      const cur = normalizeGuardValue(headers[c], cellAt(c));
      const exp = normalizeGuardValue(headers[c], os[f]);
      if (cur) allGuardEmpty = false;
      if (exp) { idComparable++; if (!(cur && cur === exp)) idMatch = false; }
    }

    if (gridOutOfRange) { continue; } // R4: 그리드밖은 취소 오인 금지 — 스킵
    if (idComparable === 0 || !idMatch) {
      // 식별 불일치: 사람이 그 행을 다른 용도로 재사용 가능. 전부 공란이면 "취소 의심" 플래그만(자동취소 금지).
      identMismatch++;
      if (allGuardEmpty) {
        made += await _replaceOpenProposal(db, os, sheetId, tabName, ctx.tabGid,
          { type: 'cancel_suspect', field: null, oldv: null, newv: null, sig: null });
        suspects++;
      }
      continue;
    }

    // R1: 현재 시트서명 == 내가 마지막 쓴 서명 → 내가 쓴 값(변경 아님) 제외.
    const curSig = _sigFromCells(headers, fieldCols, cellAt);
    if (os.last_sheet_write_sig && curSig === os.last_sheet_write_sig) { skippedSig++; continue; }

    // 필드별 diff → edit 제안. 단칸 공란은 무시(R2/R4 원본 보존).
    const mapped = mapOrderToSheetRow(headers, _osRowToOrderData(os));
    const fieldEdits = [];
    for (const f of REVERSE_SYNC_FIELDS) {
      const c = fieldCols[f]; if (c == null) continue;
      const dbv = normalizeText(mapped[c]);
      const shv = normalizeText(cellAt(c));
      if (shv === dbv) continue;
      if (shv === '') continue; // 공란은 자동 역반영 금지(실수/미러 누락 보호)
      fieldEdits.push({ field: f, oldv: dbv, newv: shv });
    }
    if (fieldEdits.length) {
      made += await _replaceOpenProposalEdits(db, os, sheetId, tabName, ctx.tabGid, fieldEdits, curSig, os.last_edit_seq);
      edits += fieldEdits.length;
    }
  }
  return { scanned: orders.length, proposals: made, edits, cancelSuspects: suspects, skippedBySig: skippedSig, identityMismatch: identMismatch };
}

// detect의 시트행 서명(write-time computeRowWriteSig와 동일 필드·순서·정규화).
function _sigFromCells(headers, fieldCols, cellAt) {
  const parts = [];
  for (const f of REVERSE_SYNC_FIELDS) {
    if (fieldCols[f] == null) continue;
    parts.push(f + '=' + normalizeText(cellAt(fieldCols[f])));
  }
  return parts.join('');
}

// G2 멱등: 트랜잭션 내 "open 제안 교체(DELETE→INSERT)". (단일 cancel_suspect/전체 edits 교체)
async function _replaceOpenProposal(db, os, sheetId, tabName, tabGid, { type, field, oldv, newv, sig }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM reverse_sync_proposals WHERE os_id = $1 AND status = 'open'`, [os.id]);
    await client.query(
      `INSERT INTO reverse_sync_proposals (os_id, sheet_id, tab_name, tab_gid, sheet_row, proposal_type, field, old_value, new_value, detected_sig, detected_edit_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [os.id, sheetId, tabName, tabGid, os.sheet_row, type, field, oldv, newv, sig, os.last_edit_seq]
    );
    await client.query('COMMIT');
    return 1;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} logger.warn(`[reverseSync] 제안 기록 실패: ${e.message}`); return 0; }
  finally { client.release(); }
}

async function _replaceOpenProposalEdits(db, os, sheetId, tabName, tabGid, fieldEdits, sig, detectedEditSeq) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM reverse_sync_proposals WHERE os_id = $1 AND status = 'open'`, [os.id]);
    for (const e of fieldEdits) {
      await client.query(
        `INSERT INTO reverse_sync_proposals (os_id, sheet_id, tab_name, tab_gid, sheet_row, proposal_type, field, old_value, new_value, detected_sig, detected_edit_seq)
         VALUES ($1,$2,$3,$4,$5,'edit',$6,$7,$8,$9,$10)`,
        [os.id, sheetId, tabName, tabGid, os.sheet_row, e.field, e.oldv, e.newv, sig, detectedEditSeq]
      );
    }
    await client.query('COMMIT');
    return fieldEdits.length;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} logger.warn(`[reverseSync] edit 제안 기록 실패: ${e.message}`); return 0; }
  finally { client.release(); }
}

module.exports = {
  computeDedupKey,
  buildCandidateRows,
  reconcileStuckOrders,
  _osRowToOrderData,
  _fieldToCol,
  rowIdentityMatches,
  mapOrderToSheetRow,
  buildBatchUpdateData,
  buildMirrorGuardRange,
  buildMirrorGuardRanges,
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
  computeRowWriteSig,
  detectReverseSyncProposals,
  __setPoolForTest,
};
