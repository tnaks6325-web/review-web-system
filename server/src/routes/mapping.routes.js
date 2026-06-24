/**
 * mapping.routes.js — 명시적 컬럼 매핑 API (2a)
 *
 *   GET  /api/mapping/fields           — 표준 DB 필드 레지스트리 (드롭다운용)
 *   GET  /api/mapping?sheetId=&gid=     — 탭의 컬럼 매핑(저장값+자동추측 병합)
 *   POST /api/mapping                   — 탭 컬럼 매핑 저장 (admin/master)
 *
 * 인증: 조회는 로그인, 저장은 admin/master 전용.
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { getFieldRegistry, getMapping, saveMapping } = require('../services/columnMapping.service');

// ── 표준 필드 목록 ──
router.get('/fields', authMiddleware, (req, res) => {
  res.json({ ok: true, fields: getFieldRegistry() });
});

// ── 탭 매핑 조회 ──
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, gid } = req.query;
    if (!sheetId || !gid) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid 파라미터가 필요합니다.' });
    }
    const result = await getMapping(sheetId, String(gid));
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── 탭 매핑 저장 ──
router.post('/', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, gid, tabName, columns } = req.body || {};
    if (!sheetId || !gid) {
      return res.status(400).json({ ok: false, error: 'sheetId, gid가 필요합니다.' });
    }
    if (!Array.isArray(columns)) {
      return res.status(400).json({ ok: false, error: 'columns 배열이 필요합니다.' });
    }
    const updatedBy = req.admin?.name || 'admin';
    const result = await saveMapping(sheetId, String(gid), tabName, columns, updatedBy);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
