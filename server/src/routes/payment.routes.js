const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');

// GET /api/payment/targets — 입금 대상 목록 (GAS: getPaymentTargets)
router.get('/targets', authMiddleware, async (req, res, next) => {
  try {
    // 제출 완료이면서 force_done/is_closed가 아닌 탭의 리뷰어
    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name AS "reviewerName",
        ri.tab_name AS "tabName",
        ri.sheet_id AS "sheetId",
        ri.campaign_name AS "campaignName",
        tc.deposit_name AS "depositName",
        tc.transfer_bank AS "transferBank",
        tc.income_type AS "incomeType",
        tc.payment_type AS "paymentType"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.is_submitted = TRUE
        AND (tc.force_done IS NULL OR tc.force_done = FALSE)
        AND (tc.is_closed IS NULL OR tc.is_closed = FALSE)
      ORDER BY ri.tab_name, ri.reviewer_name
    `);

    res.json({ ok: true, targets: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/payment/mark-done — 입금 완료 처리 (GAS: markPaymentDone)
router.post('/mark-done', authMiddleware, async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ error: '처리할 항목이 없습니다.' });
    }

    // TODO: Sheets API를 통해 시트에도 마킹하거나, DB 전용으로 처리
    // 현재는 인덱스에서 해당 항목을 "처리 완료"로 표시
    let updated = 0;
    for (const item of items) {
      const result = await pool.query(
        `UPDATE review_index SET is_submitted2 = 'PAID'
         WHERE sheet_id = $1 AND tab_name = $2 AND reviewer_name = $3 AND row_index = $4`,
        [item.sheetId, item.tabName, item.reviewerName, item.rowIndex]
      );
      updated += result.rowCount;
    }

    res.json({ ok: true, updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
