const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');

// GET /api/memo — 메모 조회 (GAS: getMemo)
router.get('/', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ ok: true, memo: null });

    const tabKey = `${sheetId}||${tabName}`;
    const { rows } = await pool.query(
      'SELECT content AS text, author, updated_at AS "updatedAt", role FROM memos WHERE tab_key = $1',
      [tabKey]
    );

    if (rows.length === 0) return res.json({ ok: true, memo: null });
    res.json({ ok: true, memo: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/memo — 메모 저장 (GAS: saveMemo)
router.post('/', async (req, res, next) => {
  try {
    const { sheetId, tabName, role, name, text } = req.body;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    const tabKey = `${sheetId}||${tabName}`;
    await pool.query(`
      INSERT INTO memos (tab_key, role, author, content, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (tab_key) DO UPDATE SET
        role = $2, author = $3, content = $4, updated_at = NOW()
    `, [tabKey, role || '', name || '', text || '']);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/memo — 메모 삭제 (GAS: deleteMemo)
router.delete('/', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    const tabKey = `${sheetId}||${tabName}`;
    await pool.query('DELETE FROM memos WHERE tab_key = $1', [tabKey]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
