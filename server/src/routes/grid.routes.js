/**
 * grid.routes.js — DB-primary 그리드 편집 API (Phase 1, 값 전용)
 *
 *   GET  /api/grid/data       — 탭 그리드 데이터(행+헤더+dirty/synced+editable)
 *   POST /api/grid/cell       — 셀 값 편집(다건) → DB 확정 + 시트 반영 큐잉
 *   POST /api/grid/row/add    — 행 추가
 *   POST /api/grid/row/delete — 행 삭제
 *   POST /api/grid/col/add    — 열 추가
 *   POST /api/grid/col/delete — 열 삭제
 *   POST /api/grid/enable     — 탭 편집 opt-in 토글
 *
 * 인증: 전부 admin/master 전용 (source-of-truth 편집은 staff 차단).
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const grid = require('../services/gridEdit.service');

router.use(authMiddleware, adminOrMasterMiddleware);

function _who(req) {
  return (req.admin && req.admin.name) || 'admin';
}

// GET /api/grid/data?sheetId&gid&offset&limit
router.get('/data', async (req, res, next) => {
  try {
    const { sheetId, gid } = req.query;
    if (!sheetId || !gid) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid 파라미터가 필요합니다.' });
    }
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 500;
    const data = await grid.getGridData(sheetId, gid, { offset, limit });
    res.json({ ok: true, ...data });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ ok: false, error: err.message });
    next(err);
  }
});

// POST /api/grid/cell  { sheetId, gid, tabName, edits:[{rowIndex,colIndex,value}] }
router.post('/cell', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, edits } = req.body || {};
    if (!sheetId || gid == null || !tabName) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid, tabName 필수' });
    }
    const result = await grid.saveCellEdits({ sheetId, gid, tabName, edits, editedBy: _who(req) });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/grid/row/add  { sheetId, gid, tabName, afterRowIndex }
router.post('/row/add', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, afterRowIndex } = req.body || {};
    if (!sheetId || gid == null || !tabName) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid, tabName 필수' });
    }
    const result = await grid.addRow({ sheetId, gid, tabName, afterRowIndex, editedBy: _who(req) });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message });
    next(err);
  }
});

// POST /api/grid/row/delete  { sheetId, gid, tabName, rowIndex }
router.post('/row/delete', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, rowIndex } = req.body || {};
    if (!sheetId || gid == null || !tabName || !rowIndex) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid, tabName, rowIndex 필수' });
    }
    const result = await grid.deleteRow({ sheetId, gid, tabName, rowIndex, editedBy: _who(req) });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message });
    next(err);
  }
});

// POST /api/grid/col/add  { sheetId, gid, tabName, afterColIndex }
router.post('/col/add', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, afterColIndex } = req.body || {};
    if (!sheetId || gid == null || !tabName) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid, tabName 필수' });
    }
    const result = await grid.addColumn({ sheetId, gid, tabName, afterColIndex, editedBy: _who(req) });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message });
    next(err);
  }
});

// POST /api/grid/col/delete  { sheetId, gid, tabName, colIndex }
router.post('/col/delete', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, colIndex } = req.body || {};
    if (!sheetId || gid == null || !tabName || colIndex == null) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid, tabName, colIndex 필수' });
    }
    const result = await grid.deleteColumn({ sheetId, gid, tabName, colIndex, editedBy: _who(req) });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message });
    next(err);
  }
});

// POST /api/grid/enable  { sheetId, gid, editable? }
router.post('/enable', async (req, res, next) => {
  try {
    const { sheetId, gid, editable } = req.body || {};
    if (!sheetId || gid == null) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid 필수' });
    }
    const result = await grid.setEditable(sheetId, gid, editable);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
