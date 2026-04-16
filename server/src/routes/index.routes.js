const express = require('express');
const router = express.Router();
const { searchByName, searchByNameDebug } = require('../services/search.service');
const { buildIndexSmart } = require('../services/indexBuilder.service');
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════
// GET /api/search — 이름/전화번호 검색 (GAS: searchAll)
// ═══════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
  try {
    const { query, phone8 } = req.query;
    const result = await searchByName(query, phone8);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/search/debug — 디버그용 검색 (GAS: searchAllDebug)
// ═══════════════════════════════════════════════════════════
router.get('/debug', async (req, res, next) => {
  try {
    const { query } = req.query;
    const result = await searchByNameDebug(query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/index/build — 인덱스 빌드 (GAS: buildIndexSmart)
// ═══════════════════════════════════════════════════════════
router.post('/build', authMiddleware, async (req, res, next) => {
  try {
    const { forceFullRebuild } = req.body;
    const result = await buildIndexSmart(forceFullRebuild === true);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/index/status — 인덱스 현황 (GAS: indexStatus)
// ═══════════════════════════════════════════════════════════
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const metaResult = await pool.query(
      'SELECT COUNT(*) AS count, MAX(built_at) AS built_at FROM review_index'
    );
    const meta = metaResult.rows[0] || {};

    const { rows: masterData } = await pool.query(
      `SELECT campaign_name AS "campaignName", tab_name AS "tabName",
              row_count AS "rowCount", submitted_count AS "submittedCount",
              status, checksum, built_at AS "builtAt",
              error_msg AS "errorMsg", skip_reason AS "skipReason"
       FROM index_master
       ORDER BY built_at DESC NULLS LAST`
    );

    // 빌드 잠금 상태
    let lockStatus = { isLocked: false };
    try {
      const { rows: lockRows } = await pool.query(
        "SELECT * FROM build_locks WHERE lock_key = 'INDEX_BUILD'"
      );
      if (lockRows.length > 0) {
        const lock = lockRows[0];
        lockStatus = {
          isLocked: lock.is_locked,
          lockedAt: lock.locked_at,
          lockedBy: lock.locked_by,
          elapsedSec: lock.locked_at ? Math.round((Date.now() - new Date(lock.locked_at).getTime()) / 1000) : 0,
        };
      }
    } catch (_) {}

    // 인덱스 만료 체크 (2시간)
    const builtAt = meta.built_at ? new Date(meta.built_at).getTime() : 0;
    const isExpired = (Date.now() - builtAt) > 2 * 60 * 60 * 1000;

    res.json({
      ok: true,
      meta: {
        count: parseInt(meta.count) || 0,
        builtAt: meta.built_at || null,
        isExpired,
      },
      master: masterData,
      lock: lockStatus,
      codeVersion: new Date().toISOString().slice(0, 16).replace('T', ' '),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
