const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const { registerLimiter } = require('../middleware/rateLimit.middleware');
const {
  registerReviewer,
  verifyReviewer,
  lookupPhone,
  getReviewerList,
  deleteReviewer,
  handleReviewerProfile,
} = require('../services/reviewer.service');
const pool = require('../db/pool');

// POST /api/reviewer/register — 리뷰어 등록 (GAS: registerReviewer)
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const result = await registerReviewer(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/verify — 리뷰어 인증 (GAS: verifyReviewer)
router.get('/verify', async (req, res, next) => {
  try {
    const { name, phone8 } = req.query;
    const result = await verifyReviewer(name, phone8);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/lookup — 전화번호로 이름 조회 (GAS: lookupPhone)
router.get('/lookup', async (req, res, next) => {
  try {
    const { phone8 } = req.query;
    const result = await lookupPhone(phone8);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/list — 리뷰어 목록 (GAS: getReviewerList)
router.get('/list', authMiddleware, async (req, res, next) => {
  try {
    const result = await getReviewerList();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/reviewer/delete — 리뷰어 삭제 (GAS: deleteReviewer)
router.post('/delete', authMiddleware, async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    const result = await deleteReviewer(name, phone);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/reviewer/profile — 프로필 관리 (GAS: getReviewerProfile/saveSubAccounts/saveIncomeInfo)
router.post('/profile', async (req, res, next) => {
  try {
    const result = await handleReviewerProfile(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/inaed-list — 인애드 명단 조회 (전체 목록, 관리자용)
router.get('/inaed-list', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT name, phone, phone8, registered_at AS "registeredAt",
             consent, status, income_type AS "incomeType",
             sub_accounts AS "subAccounts"
      FROM reviewers
      ORDER BY registered_at DESC
    `);
    res.json({ ok: true, list: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
