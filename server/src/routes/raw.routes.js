/**
 * raw.routes.js — 구글시트 전체 RAW 미러링 API
 *
 *   POST /api/raw/mirror   — 인덱스 기반 전체 시트 RAW 미러링 (비동기 백그라운드)
 *   GET  /api/raw/status   — 미러 현황 요약
 *   GET  /api/raw/tabs     — 미러링된 탭 목록
 *   GET  /api/raw/rows     — 특정 탭의 raw 행 데이터 (sheetId + gid)
 *
 * 인증: 모든 엔드포인트 로그인 필요. 미러 실행은 admin/master 전용.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { mirrorAllSheets } = require('../services/rawMirror.service');

// 동시 미러링 방지용 메모리 잠금
let _mirrorRunning = false;
let _lastMirror = null; // 마지막 실행 요약

// ═══════════════════════════════════════════════════════════
// POST /api/raw/mirror — 전체 RAW 미러링 (비동기)
//   body: { force?: boolean, includeHidden?: boolean }
// ═══════════════════════════════════════════════════════════
router.post('/mirror', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (_mirrorRunning) {
      return res.json({ ok: false, error: '이미 미러링이 진행 중입니다.', running: true });
    }

    const force = req.body?.force === true;
    const includeHidden = req.body?.includeHidden !== false; // 기본 true

    res.json({
      ok: true,
      mode: 'async',
      message: 'RAW 미러링이 시작되었습니다. 완료 후 /api/raw/status 로 확인하세요.',
    });

    // 백그라운드 실행
    _mirrorRunning = true;
    setImmediate(async () => {
      try {
        const result = await mirrorAllSheets({ force, includeHidden });
        _lastMirror = { ...result, finishedAt: new Date().toISOString() };
        console.log('[raw/mirror] 완료:', JSON.stringify({
          tabsMirrored: result.tabsMirrored, rowsWritten: result.rowsWritten,
          errors: result.errors, elapsed: result.elapsed,
        }));
      } catch (err) {
        _lastMirror = { ok: false, error: err.message, finishedAt: new Date().toISOString() };
        console.error('[raw/mirror] 실패:', err.message);
      } finally {
        _mirrorRunning = false;
      }
    });
  } catch (err) {
    _mirrorRunning = false;
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/raw/status — 미러 현황 요약
// ═══════════════════════════════════════════════════════════
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const { rows: tabAgg } = await pool.query(
      `SELECT COUNT(*)::int AS tabs,
              COUNT(DISTINCT sheet_id)::int AS sheets,
              COALESCE(SUM(row_count), 0)::bigint AS total_rows,
              COUNT(*) FILTER (WHERE is_system_tab)::int AS system_tabs,
              COUNT(*) FILTER (WHERE is_hidden)::int AS hidden_tabs,
              MAX(mirrored_at) AS last_mirrored_at
         FROM raw_sheet_tabs`
    );
    const { rows: rowAgg } = await pool.query(
      'SELECT COUNT(*)::bigint AS stored_rows FROM raw_sheet_rows'
    );

    const agg = tabAgg[0] || {};
    let lastMirroredStr = '-';
    if (agg.last_mirrored_at) {
      lastMirroredStr = new Date(agg.last_mirrored_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    }

    res.json({
      ok: true,
      running: _mirrorRunning,
      tabs: agg.tabs || 0,
      sheets: agg.sheets || 0,
      totalRows: Number(agg.total_rows || 0),
      storedRows: Number(rowAgg[0]?.stored_rows || 0),
      systemTabs: agg.system_tabs || 0,
      hiddenTabs: agg.hidden_tabs || 0,
      lastMirroredAt: agg.last_mirrored_at || null,
      lastMirroredStr,
      lastRun: _lastMirror,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/raw/tabs — 미러링된 탭 목록
//   query: sheetId? (필터), limit? (기본 1000)
// ═══════════════════════════════════════════════════════════
router.get('/tabs', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);

    const params = [];
    let where = '';
    if (sheetId) {
      params.push(sheetId);
      where = 'WHERE sheet_id = $1';
    }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT sheet_id   AS "sheetId",
              spreadsheet_title AS "spreadsheetTitle",
              tab_gid    AS "tabGid",
              tab_name   AS "tabName",
              row_count  AS "rowCount",
              col_count  AS "colCount",
              is_system_tab AS "isSystemTab",
              is_hidden  AS "isHidden",
              mirrored_at AS "mirroredAt"
         FROM raw_sheet_tabs
         ${where}
         ORDER BY spreadsheet_title, tab_name
         LIMIT $${params.length}`,
      params
    );

    res.json({ ok: true, count: rows.length, tabs: rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/raw/rows — 특정 탭의 raw 행 데이터
//   query: sheetId(필수), gid(필수), offset?, limit?(기본 500, 최대 5000)
// ═══════════════════════════════════════════════════════════
router.get('/rows', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, gid } = req.query;
    if (!sheetId || !gid) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid 파라미터가 필요합니다.' });
    }
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);

    const { rows: metaRows } = await pool.query(
      `SELECT tab_name AS "tabName", spreadsheet_title AS "spreadsheetTitle",
              row_count AS "rowCount", col_count AS "colCount", headers
         FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2`,
      [sheetId, String(gid)]
    );
    if (metaRows.length === 0) {
      return res.status(404).json({ ok: false, error: '미러링된 탭을 찾을 수 없습니다.' });
    }

    const { rows } = await pool.query(
      `SELECT row_index AS "rowIndex", cells
         FROM raw_sheet_rows
         WHERE sheet_id = $1 AND tab_gid = $2
         ORDER BY row_index
         OFFSET $3 LIMIT $4`,
      [sheetId, String(gid), offset, limit]
    );

    res.json({
      ok: true,
      meta: metaRows[0],
      offset,
      limit,
      count: rows.length,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
