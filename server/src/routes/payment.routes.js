const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════
// GET /api/payment/targets — 입금 대상 목록 (GAS: getPaymentTargets)
// ═══════════════════════════════════════════════════════════
router.get('/targets', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name AS "reviewerName",
        ri.tab_name AS "tabName",
        ri.sheet_id AS "sheetId",
        ri.row_index AS "rowIndex",
        ri.campaign_name AS "campaignName",
        ri.product_name AS "productName",
        tc.deposit_name AS "depositName",
        tc.transfer_bank AS "transferBank",
        tc.income_type AS "incomeType",
        tc.payment_type AS "paymentType",
        tc.display_name AS "displayName"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = TRUE
        AND (tc.is_closed IS NULL OR tc.is_closed = FALSE)
        AND (ri.is_submitted2 IS NULL OR ri.is_submitted2 = 'NONE')
      ORDER BY ri.tab_name, ri.reviewer_name
    `);

    res.json({ ok: true, targets: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/payment/mark-done — 입금 완료 처리 (GAS: markPaymentDone)
// ═══════════════════════════════════════════════════════════
router.post('/mark-done', authMiddleware, async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ error: '처리할 항목이 없습니다.' });
    }

    let updated = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const item of items) {
        // review_index 업데이트
        const result = await client.query(
          `UPDATE review_index SET is_submitted2 = 'PAID'
           WHERE sheet_id = $1 AND tab_name = $2 AND reviewer_name = $3 AND row_index = $4`,
          [item.sheetId, item.tabName, item.reviewerName, item.rowIndex]
        );
        updated += result.rowCount;

        // payment_records에 이력 기록
        await client.query(
          `INSERT INTO payment_records (sheet_id, tab_name, reviewer_name, row_index, amount, paid_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [item.sheetId, item.tabName, item.reviewerName, item.rowIndex, item.amount || '', req.admin?.name || '']
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, updated });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/payment/history — 입금 이력 조회
// ═══════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, limit } = req.query;
    let sql = `
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             reviewer_name AS "reviewerName", row_index AS "rowIndex",
             amount, status, paid_by AS "paidBy", paid_at AS "paidAt"
      FROM payment_records
    `;
    const params = [];
    const where = [];

    if (sheetId) { where.push(`sheet_id = $${params.length + 1}`); params.push(sheetId); }
    if (tabName) { where.push(`tab_name = $${params.length + 1}`); params.push(tabName); }

    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY paid_at DESC';
    sql += ` LIMIT ${parseInt(limit) || 100}`;

    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, history: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
