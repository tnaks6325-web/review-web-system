/**
 * ═══════════════════════════════════════════════════════════
 * gridEdit.service.js — DB-primary 그리드 편집 (Phase 1, 값 전용)
 *
 * raw_sheet_rows 를 편집 소스(source of truth)로 사용한다.
 *  - saveCellEdits : 셀 값 편집 → DB 즉시 확정 + dirty 표시 → 큐(cell_write)로 시트 반영
 *  - addRow/deleteRow/addColumn/deleteColumn : 구조 변경 → DB 반영 + 큐(dimension_op)로 시트 반영
 *  - tabHasDirtyRows/markRowSynced : RAW 미러 가드 & 동기화 완료 표시
 *
 * 충돌 방지(요구사항 #4): dirty 행이 남은 탭은 RAW 미러가 skip(rawMirror.service.js).
 *   "양쪽 동시작업 없음" 전제이므로 단일 편집자 가정으로 충분.
 *
 * 구조 변경(행/열) 작업은 절대 행번호(rowIndex)를 시트에 미러하므로,
 *   해당 탭에 미반영(dirty) 셀이 있으면 큐가 빌 때까지 거부한다(행번호 어긋남 방지).
 * ═══════════════════════════════════════════════════════════
 */

const pool = require('../db/pool');
const { enqueue } = require('./syncQueue.service');
const { applyDimensionOp } = require('./sheets.service');
const { throttledCall } = require('../utils/sheetsThrottle');
const { logger } = require('../utils/logger');

const SHIFT_OFF = 1000000000; // 행번호 일괄 이동 시 유니크 충돌 방지용 임시 오프셋

// ── 셀 배열을 colIndex 까지 빈 문자열로 패딩 ──
function _padCells(cells, colIndex) {
  const arr = Array.isArray(cells) ? cells.slice() : [];
  while (arr.length <= colIndex) arr.push('');
  return arr;
}

// ───────────────────────────────────────────────
// 그리드 데이터 조회 (행 + 헤더 + dirty/synced + editable)
// ───────────────────────────────────────────────
async function getGridData(sheetId, gid, { offset = 0, limit = 500 } = {}) {
  const g = String(gid);
  const { rows: metaRows } = await pool.query(
    `SELECT tab_name AS "tabName", spreadsheet_title AS "spreadsheetTitle",
            row_count AS "rowCount", col_count AS "colCount",
            headers, detected_headers AS "detectedHeaders",
            COALESCE(editable, FALSE) AS "editable", last_edited_at AS "lastEditedAt"
       FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2`,
    [sheetId, g]
  );
  if (metaRows.length === 0) {
    const err = new Error('미러링된 탭을 찾을 수 없습니다.');
    err.statusCode = 404;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT row_index AS "rowIndex", cells,
            (dirty_at IS NOT NULL) AS dirty, synced_at AS "syncedAt"
       FROM raw_sheet_rows
       WHERE sheet_id = $1 AND tab_gid = $2
       ORDER BY row_index
       OFFSET $3 LIMIT $4`,
    [sheetId, g, Math.max(offset, 0), Math.min(limit, 5000)]
  );

  return { meta: metaRows[0], offset, limit, count: rows.length, rows };
}

// ───────────────────────────────────────────────
// 셀 값 편집 (다건). edits = [{ rowIndex, colIndex, value }]
//  → DB 확정 + dirty 표시 → 행 단위로 묶어 cell_write 큐잉
// ───────────────────────────────────────────────
async function saveCellEdits({ sheetId, gid, tabName, edits, editedBy }) {
  if (!Array.isArray(edits) || edits.length === 0) return { saved: 0, queued: 0 };
  const g = String(gid);

  // 행 단위로 그룹핑
  const byRow = new Map();
  for (const e of edits) {
    const ri = parseInt(e.rowIndex, 10);
    const ci = parseInt(e.colIndex, 10);
    if (!Number.isInteger(ri) || ri < 1 || !Number.isInteger(ci) || ci < 0) continue;
    if (!byRow.has(ri)) byRow.set(ri, []);
    byRow.get(ri).push({ colIndex: ci, value: e.value == null ? '' : String(e.value) });
  }
  if (byRow.size === 0) return { saved: 0, queued: 0 };

  const client = await pool.connect();
  const queueJobs = []; // 커밋 후 enqueue 할 작업
  try {
    await client.query('BEGIN');
    for (const [rowIndex, cellEdits] of byRow.entries()) {
      const { rows: existing } = await client.query(
        `SELECT id, cells FROM raw_sheet_rows
          WHERE sheet_id = $1 AND tab_gid = $2 AND row_index = $3 FOR UPDATE`,
        [sheetId, g, rowIndex]
      );

      let cells = existing.length ? (Array.isArray(existing[0].cells) ? existing[0].cells.slice() : []) : [];
      const colWrites = [];
      for (const { colIndex, value } of cellEdits) {
        cells = _padCells(cells, colIndex);
        const oldValue = cells[colIndex] == null ? '' : String(cells[colIndex]);
        cells[colIndex] = value;
        colWrites.push({ col: colIndex, value });
        await client.query(
          `INSERT INTO grid_edit_log (sheet_id, tab_gid, tab_name, op, row_index, col_index, old_value, new_value, edited_by)
           VALUES ($1,$2,$3,'cell',$4,$5,$6,$7,$8)`,
          [sheetId, g, tabName, rowIndex, colIndex, oldValue, value, editedBy || null]
        );
      }

      let dirtyAt;
      if (existing.length) {
        const { rows: ret } = await client.query(
          `UPDATE raw_sheet_rows
              SET cells = $4, dirty_at = NOW(), synced_at = NULL, edited_by = $5
            WHERE id = $1 AND sheet_id = $2 AND tab_gid = $3
            RETURNING dirty_at AS "dirtyAt"`,
          [existing[0].id, sheetId, g, JSON.stringify(cells), editedBy || null]
        );
        dirtyAt = ret[0] && ret[0].dirtyAt;
      } else {
        const { rows: ret } = await client.query(
          `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells, dirty_at, synced_at, edited_by)
           VALUES ($1,$2,$3,$4,$5, NOW(), NULL, $6)
           ON CONFLICT (sheet_id, tab_gid, row_index)
           DO UPDATE SET cells = EXCLUDED.cells, dirty_at = NOW(), synced_at = NULL, edited_by = EXCLUDED.edited_by
           RETURNING dirty_at AS "dirtyAt"`,
          [sheetId, g, tabName, rowIndex, JSON.stringify(cells), editedBy || null]
        );
        dirtyAt = ret[0] && ret[0].dirtyAt;
      }

      queueJobs.push({ rowIndex, colWrites, dirtyAt });
    }

    await client.query(
      `UPDATE raw_sheet_tabs SET last_edited_at = NOW() WHERE sheet_id = $1 AND tab_gid = $2`,
      [sheetId, g]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 커밋 후: 행 단위로 cell_write 큐잉 (시트 쓰기 횟수 절감)
  let queued = 0;
  for (const job of queueJobs) {
    await enqueue('cell_write', {
      sheetId, tabName, gid: g, rowIndex: job.rowIndex, colWrites: job.colWrites,
      dirtyAt: job.dirtyAt instanceof Date ? job.dirtyAt.toISOString() : job.dirtyAt,
    });
    queued++;
  }
  logger.info(`[gridEdit] saveCellEdits sheet=${sheetId.substring(0, 12)} tab=${tabName} 행${queueJobs.length}건 큐잉`);
  return { saved: edits.length, queued };
}

// ── 구조 변경 가드: 미반영(dirty) 셀이 있으면 거부 (행번호 어긋남 방지) ──
async function _assertNoDirty(sheetId, gid, action) {
  if (await tabHasDirtyRows(sheetId, gid)) {
    const err = new Error(`셀 편집이 시트에 반영되는 중입니다. 잠시 후 ${action}을(를) 다시 시도하세요.`);
    err.statusCode = 409;
    throw err;
  }
}

// ───────────────────────────────────────────────
// 행 추가 (afterRowIndex 다음에 빈 행 삽입)
// ───────────────────────────────────────────────
async function addRow({ sheetId, gid, tabName, afterRowIndex, editedBy }) {
  const g = String(gid);
  await _assertNoDirty(sheetId, g, '행 추가');
  const newRow = Math.max(parseInt(afterRowIndex, 10) || 0, 0) + 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // newRow 이상 행을 +1 (오프셋 2단계로 유니크 충돌 회피)
    await client.query(
      `UPDATE raw_sheet_rows SET row_index = row_index + $3
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index >= $4`,
      [sheetId, g, SHIFT_OFF, newRow]
    );
    await client.query(
      `UPDATE raw_sheet_rows SET row_index = row_index - $3
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index >= $4`,
      [sheetId, g, SHIFT_OFF - 1, SHIFT_OFF]
    );
    // 빈 행 삽입 (clean: 시트에도 dimension_op로 빈 행 삽입되므로 dirty 아님)
    await client.query(
      `INSERT INTO raw_sheet_rows (sheet_id, tab_gid, tab_name, row_index, cells, synced_at)
       VALUES ($1,$2,$3,$4,'[]', NOW())
       ON CONFLICT (sheet_id, tab_gid, row_index) DO NOTHING`,
      [sheetId, g, tabName, newRow]
    );
    await client.query(
      `UPDATE raw_sheet_tabs SET row_count = COALESCE(row_count,0) + 1, last_edited_at = NOW()
        WHERE sheet_id = $1 AND tab_gid = $2`,
      [sheetId, g]
    );
    await client.query(
      `INSERT INTO grid_edit_log (sheet_id, tab_gid, tab_name, op, row_index, edited_by)
       VALUES ($1,$2,$3,'add_row',$4,$5)`,
      [sheetId, g, tabName, newRow, editedBy || null]
    );
    // ★ 시트에 먼저 반영(throttled). 실패하면 ROLLBACK → DB 변경 없음(행기하학 드리프트 방지).
    //   구조변경은 비멱등이므로 큐 재시도 대신 트랜잭션 내 동기 적용으로 원자성 확보.
    await throttledCall(() => applyDimensionOp(sheetId, { gid: g, op: 'insert_row', rowIndex: newRow }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { rowIndex: newRow };
}

// ───────────────────────────────────────────────
// 행 삭제
// ───────────────────────────────────────────────
async function deleteRow({ sheetId, gid, tabName, rowIndex, editedBy }) {
  const g = String(gid);
  await _assertNoDirty(sheetId, g, '행 삭제');
  const ri = parseInt(rowIndex, 10);
  if (!Number.isInteger(ri) || ri < 1) throw new Error('잘못된 rowIndex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2 AND row_index = $3`,
      [sheetId, g, ri]
    );
    // ri 초과 행을 -1
    await client.query(
      `UPDATE raw_sheet_rows SET row_index = row_index + $3
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index > $4`,
      [sheetId, g, SHIFT_OFF, ri]
    );
    await client.query(
      `UPDATE raw_sheet_rows SET row_index = row_index - $3
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index >= $4`,
      [sheetId, g, SHIFT_OFF + 1, SHIFT_OFF]
    );
    await client.query(
      `UPDATE raw_sheet_tabs SET row_count = GREATEST(COALESCE(row_count,1) - 1, 0), last_edited_at = NOW()
        WHERE sheet_id = $1 AND tab_gid = $2`,
      [sheetId, g]
    );
    await client.query(
      `INSERT INTO grid_edit_log (sheet_id, tab_gid, tab_name, op, row_index, edited_by)
       VALUES ($1,$2,$3,'del_row',$4,$5)`,
      [sheetId, g, tabName, ri, editedBy || null]
    );
    await throttledCall(() => applyDimensionOp(sheetId, { gid: g, op: 'delete_row', rowIndex: ri }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { deleted: ri };
}

// ── 헤더 JSONB 배열에 splice (in/out) ──
function _spliceHeaders(headers, colIndex, insert) {
  const arr = Array.isArray(headers) ? headers.slice() : [];
  if (insert) arr.splice(colIndex, 0, '');
  else arr.splice(colIndex, 1);
  return arr;
}

// ── 모든 행 cells 에 colIndex 위치로 splice (in/out) + 탭 메타 갱신 ──
async function _spliceColumn({ sheetId, gid, tabName, colIndex, insert, op, editedBy }) {
  const g = String(gid);
  await _assertNoDirty(sheetId, g, insert ? '열 추가' : '열 삭제');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, cells FROM raw_sheet_rows WHERE sheet_id = $1 AND tab_gid = $2 ORDER BY row_index FOR UPDATE`,
      [sheetId, g]
    );
    for (const r of rows) {
      const cells = Array.isArray(r.cells) ? r.cells.slice() : [];
      if (insert) {
        while (cells.length < colIndex) cells.push('');
        cells.splice(colIndex, 0, '');
      } else {
        if (colIndex < cells.length) cells.splice(colIndex, 1);
      }
      // 구조 변경은 clean 유지 (시트에도 dimension_op로 동일 반영)
      await client.query(`UPDATE raw_sheet_rows SET cells = $2 WHERE id = $1`, [r.id, JSON.stringify(cells)]);
    }

    // 탭 메타: headers / detected_headers / col_count 갱신
    const { rows: metaRows } = await client.query(
      `SELECT headers, detected_headers AS "detectedHeaders", col_count AS "colCount"
         FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2 FOR UPDATE`,
      [sheetId, g]
    );
    if (metaRows.length) {
      const newHeaders = _spliceHeaders(metaRows[0].headers, colIndex, insert);
      const newDetected = metaRows[0].detectedHeaders ? _spliceHeaders(metaRows[0].detectedHeaders, colIndex, insert) : null;
      const newColCount = Math.max((metaRows[0].colCount || 0) + (insert ? 1 : -1), 0);
      await client.query(
        `UPDATE raw_sheet_tabs
            SET headers = $3, detected_headers = $4, col_count = $5, last_edited_at = NOW()
          WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, g, JSON.stringify(newHeaders), newDetected ? JSON.stringify(newDetected) : null, newColCount]
      );
    }

    await client.query(
      `INSERT INTO grid_edit_log (sheet_id, tab_gid, tab_name, op, col_index, edited_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sheetId, g, tabName, op, colIndex, editedBy || null]
    );
    await throttledCall(() => applyDimensionOp(sheetId, { gid: g, op: insert ? 'insert_col' : 'delete_col', colIndex }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function addColumn({ sheetId, gid, tabName, afterColIndex, editedBy }) {
  const colIndex = Math.max(parseInt(afterColIndex, 10) || -1, -1) + 1; // afterColIndex 다음에 삽입
  await _spliceColumn({ sheetId, gid, tabName, colIndex, insert: true, op: 'add_col', editedBy });
  return { colIndex };
}

async function deleteColumn({ sheetId, gid, tabName, colIndex, editedBy }) {
  const ci = parseInt(colIndex, 10);
  if (!Number.isInteger(ci) || ci < 0) throw new Error('잘못된 colIndex');
  await _spliceColumn({ sheetId, gid, tabName, colIndex: ci, insert: false, op: 'del_col', editedBy });
  return { deleted: ci };
}

// ───────────────────────────────────────────────
// 미러 가드 & 동기화 완료 표시
// ───────────────────────────────────────────────
async function tabHasDirtyRows(sheetId, tabGid) {
  const { rows } = await pool.query(
    `SELECT 1 FROM raw_sheet_rows
      WHERE sheet_id = $1 AND tab_gid = $2 AND dirty_at IS NOT NULL LIMIT 1`,
    [sheetId, String(tabGid)]
  );
  return rows.length > 0;
}

// dirtyAt: 큐잉 당시의 dirty_at. 이후 더 최신 편집이 있으면(현재 dirty_at > dirtyAt)
//   dirty 를 해제하지 않는다(아직 미반영 편집이 남았으므로 후속 cell_write 가 처리).
async function markRowSynced(sheetId, tabGid, rowIndex, dirtyAt) {
  if (dirtyAt) {
    await pool.query(
      `UPDATE raw_sheet_rows SET synced_at = NOW(), dirty_at = NULL
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index = $3
          AND dirty_at IS NOT NULL AND dirty_at <= $4::timestamptz`,
      [sheetId, String(tabGid), parseInt(rowIndex, 10), dirtyAt]
    );
  } else {
    await pool.query(
      `UPDATE raw_sheet_rows SET synced_at = NOW(), dirty_at = NULL
        WHERE sheet_id = $1 AND tab_gid = $2 AND row_index = $3`,
      [sheetId, String(tabGid), parseInt(rowIndex, 10)]
    );
  }
}

// 탭의 dirty 행 cells (미러 DELETE+INSERT 시 보존용)
async function getDirtyRows(sheetId, tabGid) {
  const { rows } = await pool.query(
    `SELECT row_index AS "rowIndex", cells, dirty_at AS "dirtyAt", synced_at AS "syncedAt", edited_by AS "editedBy"
       FROM raw_sheet_rows
      WHERE sheet_id = $1 AND tab_gid = $2 AND dirty_at IS NOT NULL`,
    [sheetId, String(tabGid)]
  );
  return rows;
}

// 탭 그리드 편집 opt-in 토글
async function setEditable(sheetId, gid, editable) {
  const { rowCount } = await pool.query(
    `UPDATE raw_sheet_tabs SET editable = $3 WHERE sheet_id = $1 AND tab_gid = $2`,
    [sheetId, String(gid), editable !== false]
  );
  return { updated: rowCount };
}

module.exports = {
  getGridData,
  saveCellEdits,
  addRow,
  deleteRow,
  addColumn,
  deleteColumn,
  tabHasDirtyRows,
  markRowSynced,
  getDirtyRows,
  setEditable,
};
