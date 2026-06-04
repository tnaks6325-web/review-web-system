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
    console.error('[verify] Error:', err.message, err.stack);
    res.status(500).json({ ok: false, error: '로그인 처리 중 오류: ' + err.message });
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
// 리뷰어 본인이 phone8을 통해 접근 (인증 불필요 — phone8이 사실상 인증 토큰 역할)
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
             resident_num AS "residentNum",
             sub_accounts AS "subAccounts"
      FROM reviewers
      ORDER BY registered_at DESC
    `);
    res.json({ ok: true, list: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// Phase 2: 리뷰어 대시보드 API
// ═══════════════════════════════════════════════════════════

// GET /api/reviewer/my-applications?phone8=XX — 내 캠페인 신청 이력
router.get('/my-applications', async (req, res, next) => {
  try {
    const { phone8 } = req.query;
    if (!phone8 || phone8.length !== 8) {
      return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    }

    // 1. reviewers 테이블에서 이름/전화번호 조회
    const { rows: reviewerRows } = await pool.query(
      `SELECT name, phone FROM reviewers WHERE phone8 = $1 LIMIT 1`,
      [phone8]
    );
    if (reviewerRows.length === 0) {
      return res.json({ ok: true, applications: [], message: '등록된 리뷰어를 찾을 수 없습니다.' });
    }
    const reviewer = reviewerRows[0];

    // 2. campaign_applications에서 해당 리뷰어의 신청 이력 조회
    const { rows: appRows } = await pool.query(`
      SELECT
        ca.id,
        ca.campaign_id AS "campaignId",
        ca.applicant_name AS "name",
        ca.applicant_phone AS "phone",
        ca.status,
        ca.applied_at AS "appliedAt",
        rc.title AS "campaignTitle",
        rc.channel,
        rc.channel_custom AS "channelCustom",
        rc.manager,
        rc.review_fee AS "reviewFee",
        rc.status AS "campaignStatus"
      FROM campaign_applications ca
      LEFT JOIN recruit_campaigns rc ON ca.campaign_id = rc.id
      WHERE ca.applicant_name = $1
         OR ca.applicant_phone LIKE $2
      ORDER BY ca.applied_at DESC
      LIMIT 50
    `, [reviewer.name, '%' + phone8]);

    res.json({ ok: true, applications: appRows, total: appRows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/my-status?phone8=XX — 내 참여현황 (진행단계 포함)
router.get('/my-status', async (req, res, next) => {
  try {
    const { phone8 } = req.query;
    if (!phone8 || phone8.length !== 8) {
      return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    }

    // review_index에서 해당 phone8의 모든 참여 내역 조회
    const { rows } = await pool.query(`
      SELECT
        ri.id,
        ri.reviewer_name AS "name",
        ri.tab_name AS "tabName",
        ri.campaign_name AS "campaignName",
        ri.sheet_id AS "sheetId",
        ri.is_submitted AS "isSubmitted",
        ri.is_submitted2 AS "paymentStatus",
        ri.product_name AS "productName",
        ri.product_url AS "productUrl",
        ri.start_date AS "startDate",
        ri.end_date AS "endDate",
        ri.round,
        tc.display_name AS "displayName",
        tc.manager,
        tc.review_type AS "reviewType",
        tc.delivery_type AS "deliveryType",
        tc.is_closed AS "isClosed"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.phone8 = $1
      ORDER BY ri.built_at DESC
      LIMIT 100
    `, [phone8]);

    // 진행단계 매핑:
    // 배정됨(review_index에 있음) → 리뷰제출(is_submitted=true) → 입금완료(is_submitted2='PAID')
    const items = rows.map(r => {
      let stage = 'assigned'; // 배정됨
      if (r.isSubmitted) stage = 'submitted'; // 리뷰 제출완료
      if (r.paymentStatus === 'PAID') stage = 'paid'; // 입금완료
      if (r.isClosed && !r.isSubmitted) stage = 'closed'; // 마감(미제출)

      return { ...r, stage };
    });

    // 통계
    const stats = {
      total: items.length,
      assigned: items.filter(i => i.stage === 'assigned').length,
      submitted: items.filter(i => i.stage === 'submitted').length,
      paid: items.filter(i => i.stage === 'paid').length,
      closed: items.filter(i => i.stage === 'closed').length,
    };

    res.json({ ok: true, items, stats });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/my-payments?phone8=XX — 내 입금 내역
router.get('/my-payments', async (req, res, next) => {
  try {
    const { phone8 } = req.query;
    if (!phone8 || phone8.length !== 8) {
      return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    }

    // reviewers에서 이름 조회
    const { rows: reviewerRows } = await pool.query(
      `SELECT name FROM reviewers WHERE phone8 = $1 LIMIT 1`,
      [phone8]
    );
    if (reviewerRows.length === 0) {
      return res.json({ ok: true, payments: [], summary: { total: 0, totalAmount: 0 } });
    }
    const name = reviewerRows[0].name;

    // payment_records에서 해당 리뷰어의 입금 이력
    const { rows: payRows } = await pool.query(`
      SELECT
        pr.id,
        pr.tab_name AS "tabName",
        pr.reviewer_name AS "name",
        pr.amount,
        pr.status,
        pr.paid_at AS "paidAt",
        tc.display_name AS "displayName",
        tc.campaign_name AS "campaignName"
      FROM payment_records pr
      LEFT JOIN tab_configs tc ON pr.sheet_id = tc.sheet_id AND pr.tab_name = tc.tab_name
      WHERE pr.reviewer_name = $1
      ORDER BY pr.paid_at DESC
      LIMIT 100
    `, [name]);

    // 총 입금액 합산
    let totalAmount = 0;
    payRows.forEach(r => {
      const amt = parseInt((r.amount || '0').replace(/[^0-9]/g, ''));
      if (!isNaN(amt)) totalAmount += amt;
    });

    res.json({
      ok: true,
      payments: payRows,
      summary: {
        total: payRows.length,
        totalAmount,
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
