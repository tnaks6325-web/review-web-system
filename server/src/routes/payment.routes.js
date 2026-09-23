const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');

/* ★★ 입금 기록(review_index PAID + payment_records + 무시트 작업표 칸 + 시트 칸/큐)은
   `paymentApply.service` **한 곳**이 한다 — M2 이체결과 반영이 같은 함수를 쓴다.
   사본을 두면 "수동 처리는 작업표에 남는데 자동 반영은 안 남는" 드리프트가 조용히 생긴다. */
const { nowStamp, recordDeposits, markDepositCells } = require('../services/paymentApply.service');

// ── 헬퍼: row_json에서 결제금액 추출 ──
// ★ 규칙 본체는 utils/paymentAmount.js 단일 출처(입금관리 M1 의 상품비 폴백과 공용).
//   여기 사본을 되살리면 "레거시 화면과 입금관리의 금액이 갈리는" 드리프트가 난다.
const { extractAmountText: _extractAmount } = require('../utils/paymentAmount');

// ═══════════════════════════════════════════════════════════
// GET /api/payment/targets — 입금 대상 목록 (GAS: getPaymentTargets)
//   리뷰 완료(is_submitted) + 입금 미처리(is_submitted2 != PAID) + 미마감 탭
//   리뷰어 마스터(reviewers)에서 계좌/소득명의/주민번호를 결합한다.
// ═══════════════════════════════════════════════════════════
router.get('/targets', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name AS "reviewerName",
        ri.tab_name AS "tabName",
        ri.sheet_id AS "sheetId",
        ri.tab_gid AS "gid",
        ri.row_index AS "rowIndex",
        ri.campaign_name AS "campaignName",
        ri.product_name AS "productName",
        ri.submit_col2 AS "depositColKey",
        ri.row_json AS "rowJson",
        tc.deposit_name AS "depositName",
        tc.transfer_bank AS "transferBank",
        tc.payment_type AS "paymentType",
        tc.display_name AS "displayName",
        tc.manager AS "manager",
        rev.bank_name AS "bank",
        rev.bank_account AS "account",
        rev.account_holder AS "holder",
        rev.income_type AS "incomeName",
        rev.resident_num AS "residentNum"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      LEFT JOIN reviewers   rev ON rev.phone8 = ri.phone8
      WHERE ri.is_submitted = TRUE
        AND (tc.is_closed IS NULL OR tc.is_closed = FALSE)
        AND (ri.is_submitted2 IS NULL OR ri.is_submitted2 = 'NONE')
      ORDER BY ri.tab_name, ri.reviewer_name
    `);

    // row_json → 결제금액 추출 후 응답 슬림화 (row_json 자체는 제외)
    const targets = rows.map(r => {
      const { rowJson, ...rest } = r;
      return { ...rest, amount: _extractAmount(rowJson) };
    });

    res.json({ ok: true, targets, total: targets.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/payment/mark-done — 이체 완료 처리 (GAS: markPaymentDone)
//   1) DB: review_index.is_submitted2='PAID' + payment_records 이력
//   2) 백그라운드: 구글시트 입금칸(submit_col2)에 이체완료시각 기록
//      (실패 시 sync_queue 'deposit_mark' 로 재시도)
// ═══════════════════════════════════════════════════════════
router.post('/mark-done', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items
                : Array.isArray(req.body.rows)  ? req.body.rows
                : [];
    if (items.length === 0) {
      return res.json({ error: '처리할 항목이 없습니다.' });
    }

    const stamp = nowStamp();
    let updated = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      updated = await recordDeposits(client, items, { by: req.admin?.name || '' });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // ── 즉시 응답 (DB 저장 = 처리 성공) ──
    res.json({ ok: true, updated, successCount: updated, paidAt: stamp, errors: [] });

    // ── 백그라운드: 입금칸 기록(무시트=작업표 / 시트=구글시트·실패 시 큐) ──
    //    ★ 실행부는 paymentApply.service 한 벌 — M2 이체결과 반영이 같은 함수를 쓴다.
    setImmediate(() => markDepositCells(items, { stamp, by: req.admin?.name || 'payment' }));
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/payment/history — 입금 이력 조회
// ═══════════════════════════════════════════════════════════
router.get('/history', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
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
