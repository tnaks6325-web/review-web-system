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
const { logger } = require('../utils/logger');
const { addClient, emitCsInquiry } = require('../utils/sse');

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

// ═══════════════════════════════════════════════════════════
// C/S 문의창구 — 리뷰어용 (토큰 없음, phone8이 사실상 인증 토큰)
// 보안: 모든 조회/전송은 항상 reviewer_phone8 = 본인 phone8 으로만 스코프.
//        admin_memo 등 관리자 전용 데이터는 절대 반환하지 않는다.
// ═══════════════════════════════════════════════════════════

function _normPhone8(v) {
  return (v || '').toString().replace(/[^0-9]/g, '');
}

// GET /api/reviewer/cs/campaigns?phone8= — 문의 가능 캠페인 목록(참여 캠페인 + 일반문의)
router.get('/cs/campaigns', async (req, res, next) => {
  try {
    const phone8 = _normPhone8(req.query.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });

    const map = new Map(); // campaignKey(sheet||tab) → { ... }

    // 진행한 "탭" 단위로 목록 구성. 리뷰어 노출 라벨은 상품명(우선) → 탭명(차선)만 사용.
    // ※ 시트제목(campaign_name)은 관리자 확인용 → 리뷰어 응답에는 절대 포함하지 않는다.
    const { rows: idx } = await pool.query(`
      SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
             COALESCE(NULLIF(ri.product_name,''), NULLIF(ri.tab_name,'')) AS "label"
      FROM review_index ri
      WHERE ri.phone8 = $1 AND COALESCE(ri.tab_name,'') <> ''
      ORDER BY ri.built_at DESC
      LIMIT 200
    `, [phone8]);
    idx.forEach(r => {
      const key = `${r.sheetId}||${r.tabName}`;
      if (map.has(key)) return;
      map.set(key, {
        campaignKey: key,
        campaignLabel: r.label || r.tabName,
        campaignSource: 'review_index',
      });
    });

    const campaigns = [...map.values()];

    // 기존 스레드 정보 병합(이미 문의한 캠페인 표시 + 미확인 수)
    const { rows: threads } = await pool.query(
      `SELECT campaign_key AS "campaignKey", id AS "threadId", status,
              reviewer_unread_count AS "reviewerUnread", last_message_at AS "lastMessageAt"
       FROM cs_threads WHERE reviewer_phone8 = $1`, [phone8]
    );
    const tmap = new Map(threads.map(t => [t.campaignKey, t]));
    campaigns.forEach(c => {
      const t = tmap.get(c.campaignKey);
      if (t) { c.threadId = t.threadId; c.status = t.status; c.reviewerUnread = t.reviewerUnread; c.lastMessageAt = t.lastMessageAt; }
    });

    // 일반 문의(탭 무관) — 항상 선택 가능
    const generalThread = tmap.get('');
    const general = {
      campaignKey: '', campaignLabel: '일반 문의', campaignSource: 'general',
      threadId: generalThread ? generalThread.threadId : undefined,
      status: generalThread ? generalThread.status : undefined,
      reviewerUnread: generalThread ? generalThread.reviewerUnread : 0,
      lastMessageAt: generalThread ? generalThread.lastMessageAt : undefined,
    };

    res.json({ ok: true, campaigns, general });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/cs/threads?phone8= — 내 문의방 목록
router.get('/cs/threads', async (req, res, next) => {
  try {
    const phone8 = _normPhone8(req.query.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    const { rows } = await pool.query(`
      SELECT id AS "threadId", campaign_key AS "campaignKey", campaign_label AS "campaignLabel",
             campaign_source AS "campaignSource", status,
             last_message_at AS "lastMessageAt", last_message_preview AS "lastMessagePreview",
             reviewer_unread_count AS "reviewerUnread"
      FROM cs_threads
      WHERE reviewer_phone8 = $1
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT 100
    `, [phone8]);
    res.json({ ok: true, threads: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/cs/messages?phone8=&campaignKey= — 특정 캠페인 대화 메시지(열람 시 미확인 리셋)
router.get('/cs/messages', async (req, res, next) => {
  try {
    const phone8 = _normPhone8(req.query.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    const campaignKey = (req.query.campaignKey || '').toString();

    const { rows: tRows } = await pool.query(
      `SELECT id, campaign_label AS "campaignLabel", status FROM cs_threads
       WHERE reviewer_phone8 = $1 AND campaign_key = $2 LIMIT 1`, [phone8, campaignKey]
    );
    if (tRows.length === 0) return res.json({ ok: true, threadId: null, messages: [] });
    const thread = tRows[0];

    const { rows: messages } = await pool.query(
      `SELECT id, sender_role AS "senderRole", sender_name AS "senderName", content, created_at AS "createdAt"
       FROM cs_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 1000`, [thread.id]
    );
    await pool.query(`UPDATE cs_threads SET reviewer_unread_count = 0, updated_at = NOW() WHERE id = $1`, [thread.id]);

    res.json({ ok: true, threadId: thread.id, campaignLabel: thread.campaignLabel, status: thread.status, messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/reviewer/cs/message — 문의 메시지 전송(스레드 upsert + 관리자 알림 + 웹훅)
// body: { phone8, name, campaignKey, campaignLabel, campaignSource, content }
router.post('/cs/message', async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone8 = _normPhone8(b.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    const content = (b.content || '').toString().trim();
    if (!content) return res.status(400).json({ ok: false, error: '메시지 내용을 입력해주세요.' });
    if (content.length > 4000) return res.status(400).json({ ok: false, error: '메시지가 너무 깁니다.' });

    let source = (b.campaignSource || 'general').toString();
    if (!['recruit', 'review_index', 'general'].includes(source)) source = 'general';
    let campaignKey = (b.campaignKey || '').toString();
    let campaignLabel = (b.campaignLabel || '').toString().trim().slice(0, 200);
    if (source === 'general' || !campaignKey) { source = 'general'; campaignKey = ''; campaignLabel = campaignLabel || '일반 문의'; }
    if (!campaignLabel) campaignLabel = '문의';

    // 리뷰어 이름 확정(reviewers 우선, 없으면 body)
    const { rows: rev } = await pool.query(`SELECT name FROM reviewers WHERE phone8 = $1 LIMIT 1`, [phone8]);
    const reviewerName = (rev[0] && rev[0].name) || (b.name || '').toString().trim() || '리뷰어';

    // 스레드 upsert (xmax=0 → 신규 insert)
    const { rows: tRows } = await pool.query(`
      INSERT INTO cs_threads
        (reviewer_phone8, reviewer_name, campaign_key, campaign_label, campaign_source,
         status, last_message_at, last_message_preview, admin_unread_count)
      VALUES ($1,$2,$3,$4,$5,'open',NOW(),$6,1)
      ON CONFLICT (reviewer_phone8, campaign_key) DO UPDATE SET
        reviewer_name = EXCLUDED.reviewer_name,
        campaign_label = EXCLUDED.campaign_label,
        campaign_source = EXCLUDED.campaign_source,
        status = 'open',
        last_message_at = NOW(),
        last_message_preview = EXCLUDED.last_message_preview,
        admin_unread_count = cs_threads.admin_unread_count + 1,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS "isNew"
    `, [phone8, reviewerName, campaignKey, campaignLabel, source, content.slice(0, 120)]);
    const threadId = tRows[0].id;
    const isNew = tRows[0].isNew;

    const { rows: mRows } = await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content)
       VALUES ($1, 'reviewer', $2, $3) RETURNING id, created_at AS "createdAt"`,
      [threadId, reviewerName, content]
    );
    const message = {
      id: mRows[0].id, threadId, senderRole: 'reviewer', senderName: reviewerName,
      content, createdAt: mRows[0].createdAt,
    };

    // 관리자 실시간 알림 (대시보드 뱃지/토스트/목록 갱신)
    try {
      emitCsInquiry({
        isNew, threadId, reviewerName, reviewerPhone8: phone8,
        campaignLabel, preview: content.slice(0, 120),
      });
    } catch (_) {}

    // 외부 웹훅 푸시 (카톡/슬랙 릴레이) — best-effort, 미설정 시 skip
    const hook = process.env.CS_INQUIRY_WEBHOOK_URL;
    if (hook) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const resp = await fetch(hook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Review-Key': process.env.INTRANET_WEBHOOK_KEY || '' },
          body: JSON.stringify({
            event: 'cs_inquiry',
            thread_id: threadId, is_new: isNew,
            reviewer_name: reviewerName, reviewer_phone8: phone8,
            campaign_label: campaignLabel, content, at: new Date().toISOString(),
          }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) logger.warn(`[cs] 웹훅 HTTP ${resp.status}`);
      } catch (e) {
        logger.warn(`[cs] 문의 웹훅 실패: ${e.message}`);
      }
    }

    res.json({ ok: true, threadId, message });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/cs/events?phone8= — 리뷰어 SSE(관리자 답장 실시간 수신)
router.get('/cs/events', (req, res) => {
  const phone8 = _normPhone8(req.query.phone8);
  if (phone8.length !== 8) { res.status(400).json({ ok: false, error: 'phone8 필수' }); return; }
  addClient(req, res, { role: 'reviewer', phone8 });
});

module.exports = router;
