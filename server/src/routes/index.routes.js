const express = require('express');
const router = express.Router();
const { searchByName } = require('../services/search.service');
const { buildIndexSmart } = require('../services/indexBuilder.service');
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');

// GET /api/search — 이름/전화번호 검색 (GAS: searchAll)
router.get('/', async (req, res, next) => {
  try {
    const { query, phone8 } = req.query;
    const result = await searchByName(query, phone8);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/index/build — 인덱스 빌드 (GAS: buildIndexSmart)
router.post('/build', authMiddleware, async (req, res, next) => {
  try {
    const { forceFullRebuild } = req.body;
    const result = await buildIndexSmart(forceFullRebuild === true);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/index/status — 인덱스 현황 (GAS: indexStatus)
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const metaResult = await pool.query(
      'SELECT COUNT(*) AS count, MAX(built_at) AS built_at FROM review_index'
    );
    const meta = metaResult.rows[0] || {};

    const { rows: masterData } = await pool.query(
      `SELECT campaign_name AS "campaignName", tab_name AS "tabName",
              row_count AS "rowCount", submitted_count AS "submittedCount",
              status, checksum, built_at AS "builtAt"
       FROM index_master
       ORDER BY built_at DESC NULLS LAST`
    );

    res.json({
      ok: true,
      meta: {
        count: parseInt(meta.count) || 0,
        builtAt: meta.built_at || null,
        isExpired: false,
      },
      master: masterData,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
