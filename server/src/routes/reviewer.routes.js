const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const { registerLimiter, imageApiLimiter, campaignTokenLimiter } = require('../middleware/rateLimit.middleware');
const { issueCampaignToken } = require('../services/reviewerCampaignEditor.service');
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
const { _getReviewerPhoneList, PAYMENT_COL_KEYWORDS } = require('../services/search.service');
const adminNickname = require('../services/adminNickname.service');
// ★ 082: 기간별 리뷰비 — 판정은 utils/campaignFee 가 단일 출처(화면마다 규칙을 만들면 합계가 갈라진다)
const { resolveReviewFee, sheetDateToIso, toKstDate } = require('../utils/campaignFee');
const { extractAmountNumber } = require('../utils/paymentAmount');

// POST /api/reviewer/register — 리뷰어 등록 (GAS: registerReviewer)
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const result = await registerReviewer(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/reviewer/campaign-token — 리뷰어 앱 공고수정 스코프 토큰 발급
//   허용명단(마스터 관리)에 있는 리뷰어에게만 공고 전용·2h 토큰 발급.
//   무인증 공개 경로지만 verifyReviewer(이름+phone8) + active 명단 이중 게이트 + 리미터.
router.post('/campaign-token', campaignTokenLimiter, async (req, res, next) => {
  try {
    const { name, phone8 } = req.body || {};
    const result = await issueCampaignToken(name, phone8);
    // 미허용/불일치는 401(존재 여부 노출 최소화)
    if (!result.ok) return res.status(401).json(result);
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

// ═══════════════════════════════════════════════════════════
// POST /api/reviewer/identity-precheck — 구매양식 제출 전 신원/유사도 사전검증
// Body: { phone8, orders: [{ recipient, phone, address, bank, account, depositor,
//                            extractedRecipient?, extractedPhone?, extractedAddress? }] }
// 반환: { ok, profileMissing: string[], results: [{ idx, status, subIndex, reasons, identity }] }
//   status: SELF | SUB | NEED_CONFIRM | NEED_SUB_REGISTER
// 인증 불필요 — /profile과 동일하게 phone8이 본인 스코프 키.
// ★ fail-open: 내부 오류 시 { ok:false }를 반환하고 프론트는 제출을 막지 않는다
//   (최종 게이트는 /api/submit/order 서버검증).
// ═══════════════════════════════════════════════════════════
// ★ Gemini 비용 보호: 이미지 API와 동일한 리미터 적용 (무인증 엔드포인트 DoS 방지)
router.post('/identity-precheck', imageApiLimiter, async (req, res) => {
  try {
    const { profileMissing, resolveOrderIdentity } = require('../services/identity.service');
    const p8 = String(req.body?.phone8 || '').replace(/[^0-9]/g, '').slice(-8);
    if (p8.length !== 8) return res.json({ ok: false, error: 'phone8이 필요합니다.' });

    const { rows } = await pool.query(
      `SELECT name, phone, phone8, address, bank_name, bank_account, account_holder, sub_accounts
       FROM reviewers WHERE phone8 = $1 LIMIT 1`, [p8]
    );
    if (rows.length === 0) return res.json({ ok: false, error: '등록된 리뷰어가 아닙니다.' });

    const reviewer = rows[0];
    // sub_accounts 방어 파싱 (문자열 스칼라 이중인코딩 호환)
    if (typeof reviewer.sub_accounts === 'string') {
      try { reviewer.sub_accounts = JSON.parse(reviewer.sub_accounts); } catch (_) { reviewer.sub_accounts = []; }
    }
    if (!Array.isArray(reviewer.sub_accounts)) reviewer.sub_accounts = [];

    const missing = profileMissing(reviewer);
    if (missing.length > 0) {
      return res.json({ ok: true, profileMissing: missing, results: [] });
    }

    // 카드 최대 5장(MAX_ORDER_CARDS)과 동일 상한 — Gemini 호출 폭 제한
    const orders = Array.isArray(req.body?.orders) ? req.body.orders.slice(0, 5) : [];
    const results = [];
    for (let i = 0; i < orders.length; i++) {
      const r = await resolveOrderIdentity(reviewer, orders[i] || {}, { mode: 'precheck' });
      results.push({ idx: i, ...r });
    }
    res.json({ ok: true, profileMissing: [], results });
  } catch (err) {
    // fail-open — 프론트는 ok:false면 사전검증 생략(서버 최종게이트가 방어)
    res.json({ ok: false, error: err.message });
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
        COALESCE(ca.review_fee_snapshot, rc.review_fee) AS "reviewFee", -- ★ 082: 참여 시점 금액 우선
        rc.status AS "campaignStatus"
      FROM campaign_applications ca
      LEFT JOIN recruit_campaigns rc ON ca.campaign_id = rc.id
      WHERE (ca.applicant_name = $1
         OR ca.applicant_phone LIKE $2)
        -- 작업보드에서 참여행을 삭제하며 취소된 건은 리뷰어의 참여이력에서 제외한다.
        AND ca.status <> 'cancelled'
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

    // review_index에서 해당 phone8의 모든 참여 내역 조회 (시트 기반)
    const { rows } = await pool.query(`
      SELECT
        ri.id,
        ri.reviewer_name AS "name",
        ri.tab_name AS "tabName",
        ri.campaign_name AS "campaignName",
        ri.sheet_id AS "sheetId",
        ri.row_index AS "rowIndex",
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
        -- 작업보드에서 실제 삭제된 정확한 참여 행은 리뷰어의 참여내역에도 노출하지 않는다.
        AND NOT EXISTS (
          SELECT 1 FROM workdesk_participant_deletions wd
           WHERE wd.sheet_id=ri.sheet_id AND wd.tab_name=ri.tab_name
             AND wd.seq=ri.row_index
        )
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

      return { ...r, stage, source: 'review_index' };
    });

    // ★ DB 기반 보강: order_submissions(시트 반영 전/실패 포함)도 노출.
    //   시스템이 DB-first라 시트 미반영이어도 리뷰어가 "제출 즉시" 자기 참여를 확인할 수 있어야 함.
    //   매칭: phone8 = 주문 연락처 끝 8자리. 이미 시트반영돼 review_index가 대표하는 행(sheetRow 동일)은 중복제거.
    const seenRows = new Set(
      items.filter(i => i.rowIndex != null).map(i => `${i.sheetId}||${i.tabName}||${i.rowIndex}`)
    );
    const { rows: orderRows } = await pool.query(`
      SELECT
        os.id,
        os.recipient AS "name",
        os.tab_name AS "tabName",
        tc.campaign_name AS "campaignName",
        os.sheet_id AS "sheetId",
        os.sheet_row AS "sheetRow",
        os.order_num AS "orderNum",
        os.mirror_status AS "mirrorStatus",
        os.submitted_at AS "submittedAt",
        tc.display_name AS "displayName",
        tc.manager,
        tc.review_type AS "reviewType",
        tc.delivery_type AS "deliveryType",
        tc.is_closed AS "isClosed"
      FROM order_submissions os
      LEFT JOIN tab_configs tc ON tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
      WHERE RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) = $1
        AND os.deleted_at IS NULL
        -- 주문 원장은 감사용으로 남겨도, 실제 삭제된 작업보드 참여행의 주문은 리뷰어
        -- 참여현황에 다시 나타나면 안 된다.
        AND NOT EXISTS (
          SELECT 1 FROM workdesk_participant_deletions wd
           WHERE wd.order_submission_id=os.id
        )
      ORDER BY os.submitted_at DESC
      LIMIT 100
    `, [phone8]);

    for (const o of orderRows) {
      // 이미 시트에 반영돼 review_index가 대표하는 주문은 건너뜀(중복 방지)
      if (o.sheetRow != null && seenRows.has(`${o.sheetId}||${o.tabName}||${o.sheetRow}`)) continue;
      // written인데 아직 review_index 미반영=반영대기 / 그 외(pending·queued·pending_no_row·failed)=처리중
      const stage = (o.mirrorStatus === 'written') ? 'submitted_db' : 'processing';
      items.push({
        id: `os-${o.id}`,
        name: o.name,
        tabName: o.tabName,
        campaignName: o.campaignName,
        sheetId: o.sheetId,
        rowIndex: o.sheetRow,
        isSubmitted: false,
        paymentStatus: null,
        productName: null,
        productUrl: null,
        startDate: null,
        endDate: null,
        round: null,
        displayName: o.displayName,
        manager: o.manager,
        reviewType: o.reviewType,
        deliveryType: o.deliveryType,
        isClosed: o.isClosed,
        orderNum: o.orderNum,
        mirrorStatus: o.mirrorStatus,
        submittedAt: o.submittedAt,
        stage,
        source: 'order_submissions',
      });
    }

    // ★ M2: 참여형 캠페인 활성 홀드(applied)를 stage:'applied'로 병합 —
    //   신청 직후에도 참여현황에 즉시 표시(리뷰 내역의 시트 반영 지연 보완, PRD §06-C).
    //   유효 홀드 판정은 시각 기준(expires_at > NOW()) — 스윕 미실행에도 정확.
    try {
      const { rows: holdRows } = await pool.query(`
        SELECT ca.id, ca.campaign_id AS "campaignId", ca.applicant_name AS "name",
               ca.applied_at AS "appliedAt", ca.expires_at AS "expiresAt",
               (ca.owner_phone8 IS NOT NULL AND ca.owner_phone8 <> ca.phone8) AS "isSub",
               rc.title, rc.thumbnail_url AS "thumbnailUrl"
          FROM campaign_applications ca
          JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
         WHERE (ca.phone8 = $1 OR ca.owner_phone8 = $1)
           AND ca.status = 'applied' AND ca.expires_at > NOW()
         ORDER BY ca.applied_at DESC
         LIMIT 20
      `, [phone8]);
      for (const h of holdRows) {
        items.unshift({
          id: `hold-${h.id}`,
          name: h.name,
          tabName: null,
          campaignName: h.title,
          displayName: h.title,
          campaignId: h.campaignId,
          applicationId: h.id,
          isSub: h.isSub === true,   // ★ 063: 타계정 홀드(소유자 조회 시 병합 — 명의 이름은 name). ownerPhone8 원문 미노출(무인증 API — PII 역유출 차단)
          appliedAt: h.appliedAt,
          expiresAt: h.expiresAt,
          thumbnailUrl: h.thumbnailUrl || '',
          isSubmitted: false,
          paymentStatus: null,
          stage: 'applied',           // 참여 확보 — 구매양식 제출 대기(만료 시 자동 제외)
          source: 'campaign_hold',
        });
      }
    } catch (holdErr) {
      // 홀드 병합 실패는 기존 my-status를 막지 않는다(가산적 보강)
      console.warn('[my-status] 캠페인 홀드 병합 실패:', holdErr.message);
    }

    // 통계 (processing은 DB-only 추가분 = 접수됨·처리중/반영대기)
    const stats = {
      total: items.length,
      assigned: items.filter(i => i.stage === 'assigned').length,
      submitted: items.filter(i => i.stage === 'submitted').length,
      paid: items.filter(i => i.stage === 'paid').length,
      closed: items.filter(i => i.stage === 'closed').length,
      processing: items.filter(i => i.stage === 'processing' || i.stage === 'submitted_db').length,
      applied: items.filter(i => i.stage === 'applied').length, // ★ M2: 참여형 활성 홀드(제출 대기)
    };

    res.json({ ok: true, items, stats });
  } catch (err) {
    next(err);
  }
});

// GET /api/reviewer/review-earnings?phone8=XX — 리뷰 내역 탭 상단 합계 + 카드별 상품비/리뷰비/썸네일
//   · 상품비 = order_submissions.price(실제 제출한 결제금액) · 리뷰비 = 연결 공고 review_fee · 썸네일 = thumbnail_url
//   · totals(받을 예정) = 참여중(미제출) 행 / doneTotals(누적) = 제출완료 중 **입금완료된 건만**
//   · 주문 행매칭(sheet_row=row_index) 실패분은 productPrice=null → 프론트 "상품비 조회안됨"
//   · phone8(본인+타계정) 스코프. 읽기 전용·best-effort(실패해도 목록은 뜸).
router.get('/review-earnings', async (req, res, next) => {
  try {
    const { phone8 } = req.query;
    if (!phone8 || phone8.length !== 8) {
      return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    }
    const phoneList = await _getReviewerPhoneList(phone8);

    // 참여중(미제출) + 제출완료 행을 한 번에.
    //   ★ 입금완료 판정은 search.service의 _isPaid와 동일 규칙을 SQL로 옮긴 것 —
    //     is_submitted2='PAID' 또는 row_json의 입금 키워드 컬럼에 값이 있으면 완료.
    //     키워드 배열을 그대로 패턴화해 판정이 갈라지지 않게 한다(row_json은 서버로 안 끌어옴 = 메모리 안전).
    const payPatterns = PAYMENT_COL_KEYWORDS.map(k => '%' + k + '%');
    const { rows: riRows } = await pool.query(
      `SELECT sheet_id AS "sheetId", tab_name AS "tabName", row_index AS "rowIndex",
              is_submitted AS "isSubmitted", start_date AS "startDate",
              (is_submitted2 = 'PAID' OR EXISTS (
                 SELECT 1 FROM jsonb_each_text(COALESCE(row_json, '{}'::jsonb)) kv
                  WHERE kv.key ILIKE ANY($2) AND btrim(kv.value) <> ''
               )) AS "isPaid"
         FROM review_index
        WHERE phone8 = ANY($1) AND row_index IS NOT NULL`,
      [phoneList, payPatterns]
    );
    const sheetIds = [...new Set(riRows.map(r => r.sheetId))];
    const tabNames = [...new Set(riRows.map(r => r.tabName))];

    // 탭별 연결 공고(리뷰비·썸네일) — 탭당 최신 1건
    const campMap = {};
    if (sheetIds.length) {
      const { rows: camps } = await pool.query(
        `SELECT DISTINCT ON (linked_sheet_id, linked_tab_name)
                id, linked_sheet_id AS "sheetId", linked_tab_name AS "tabName",
                COALESCE(review_fee, 0) AS "reviewFee", thumbnail_url AS "thumbnailUrl",
                to_char(start_date,'YYYY-MM-DD') AS "campStartDate"
           FROM recruit_campaigns
          WHERE linked_sheet_id = ANY($1) AND linked_tab_name = ANY($2)
          ORDER BY linked_sheet_id, linked_tab_name, created_at DESC`,
        [sheetIds, tabNames]
      );
      for (const c of camps) campMap[c.sheetId + '||' + c.tabName] = {
        id: c.id, reviewFee: c.reviewFee || 0, thumbnailUrl: c.thumbnailUrl || '',
        campStartDate: c.campStartDate || null, schedules: [],
      };
      // ★ 082: 기간별 리뷰비 구간(1쿼리). 구간이 없는 공고는 종전대로 review_fee 하나만 쓴다.
      //   조회 실패는 fail-soft — 구간 없이 기존 값으로 계산된다(리뷰 내역은 계속 뜬다).
      try {
        const campIds = camps.map(c => c.id).filter(Boolean);
        if (campIds.length) {
          const { rows: fsRows } = await pool.query(
            `SELECT campaign_id AS "campaignId", to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom",
                    review_fee AS "reviewFee"
               FROM campaign_fee_schedules WHERE campaign_id = ANY($1) ORDER BY campaign_id, effective_from`,
            [campIds]);
          const byCamp = new Map();
          for (const f of fsRows) {
            if (!byCamp.has(f.campaignId)) byCamp.set(f.campaignId, []);
            byCamp.get(f.campaignId).push({ effectiveFrom: f.effectiveFrom, reviewFee: f.reviewFee });
          }
          for (const k of Object.keys(campMap)) campMap[k].schedules = byCamp.get(campMap[k].id) || [];
        }
      } catch (e) { logger.warn('[review-earnings] 리뷰비 구간 조회 실패(기존 값 사용): ' + e.message); }
    }

    // 주문 결제금액(행매칭용) — phone8 스코프, 행 배정된 미삭제 주문
    const priceMap = {};
    const orderFeeMap = {};   // ★ 082: 행별 리뷰비 근거(참여시점 스냅샷 · 주문 제출일)
    if (sheetIds.length) {
      const { rows: orders } = await pool.query(
        `SELECT os.sheet_id AS "sheetId", os.tab_name AS "tabName", os.sheet_row AS "sheetRow", os.price,
                os.review_fee_snapshot AS "feeSnapshot", os.submitted_at AS "orderedAt"
                , cp.row_json AS "rowJson"
           FROM order_submissions os
           LEFT JOIN campaign_participants cp ON cp.order_submission_id = os.id
          WHERE RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) = ANY($1)
            AND os.deleted_at IS NULL AND os.sheet_row IS NOT NULL AND os.sheet_id = ANY($2)`,
        [phoneList, sheetIds]
      );
      for (const o of orders) {
        const key = o.sheetId + '||' + o.tabName + '||' + o.sheetRow;
        const n = parseInt(String(o.price || '').replace(/[^0-9]/g, ''), 10);
        const price = Number.isFinite(n) && n > 0 ? n : extractAmountNumber(o.rowJson);
        if (price > 0) priceMap[key] = price;
        // ★ 082: 그 행의 참여 근거(스냅샷·구매일) — 리뷰비 판정에 쓴다.
        orderFeeMap[key] = { snapshot: o.feeSnapshot, orderDate: toKstDate(o.orderedAt) };
      }
    }

    // 무시트 전환 후 주문은 review_index 행이 아직 없을 수 있다. 이 경우에도
    // 작업보드(campaign_participants)의 결제금액을 리뷰어 예상 금액에 바로 반영한다.
    // 시트 색인으로 이미 보이는 주문은 NOT EXISTS로 제외해 이중 집계를 막는다.
    const { rows: sheetlessOrders } = await pool.query(
      `SELECT os.id, os.price, os.review_fee_snapshot AS "feeSnapshot",
              os.submitted_at AS "orderedAt", cp.row_json AS "rowJson",
              COALESCE(rc.review_fee, 0) AS "reviewFee",
              rc.thumbnail_url AS "thumbnailUrl",
              to_char(rc.start_date, 'YYYY-MM-DD') AS "campStartDate"
         FROM order_submissions os
         LEFT JOIN campaign_participants cp ON cp.order_submission_id = os.id
         LEFT JOIN campaign_applications ca ON ca.id = os.campaign_application_id
         LEFT JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
        WHERE RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) = ANY($1)
          AND os.deleted_at IS NULL
          AND ca.campaign_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM review_index ri
             WHERE ri.phone8 = ANY($1)
               AND ri.sheet_id = os.sheet_id
               AND ri.tab_name = os.tab_name
               AND ri.row_index = os.sheet_row
          )`,
      [phoneList]
    );

    // 아이템별 맵 + 합계 (참여중=받을 예정 / 제출완료 중 입금완료=누적)
    const items = {};
    let productTotal = 0, reviewTotal = 0, count = 0, productUnknown = 0;
    let dProductTotal = 0, dReviewTotal = 0, dCount = 0, dProductUnknown = 0, dUnpaidCount = 0;
    for (const r of riRows) {
      const tk = r.sheetId + '||' + r.tabName;
      const camp = campMap[tk] || {};
      const pk = tk + '||' + r.rowIndex;
      const price = Object.prototype.hasOwnProperty.call(priceMap, pk) ? priceMap[pk] : null;
      // ★★ 082: 리뷰비는 **그 건의 참여 시점** 기준 — 공고의 현재 값을 그대로 쓰면
      //   금액을 올리는 순간 과거 참여자의 카드·누적 합계까지 바뀐다(2026-08 사고).
      //   순서: 참여시점 스냅샷 → 주문 제출일 → 시트 구매일자 → 오늘 → 기존 review_fee 폴백.
      const of = orderFeeMap[pk] || {};
      const reviewFee = resolveReviewFee({
        schedules: camp.schedules,
        fallback: camp.reviewFee || 0,
        snapshot: of.snapshot,
        orderDate: of.orderDate,
        sheetDate: sheetDateToIso(r.startDate, camp.campStartDate),
      }).fee;
      items[pk] = {
        reviewFee,
        productPrice: price,
        thumbnailUrl: camp.thumbnailUrl || '',
        purchaseDate: of.orderDate || sheetDateToIso(r.startDate, camp.campStartDate) || null,
      };
      if (!r.isSubmitted) {
        count++;
        reviewTotal += reviewFee;
        if (price != null) productTotal += price; else productUnknown++;
      } else if (r.isPaid) {
        dCount++;
        dReviewTotal += reviewFee;
        if (price != null) dProductTotal += price; else dProductUnknown++;
      } else {
        dUnpaidCount++;   // 제출완료지만 아직 입금 전 — 누적 합계에서 제외(사용자 확정 기준)
      }
    }

    for (const o of sheetlessOrders) {
      const parsed = parseInt(String(o.price || '').replace(/[^0-9]/g, ''), 10);
      const price = Number.isFinite(parsed) && parsed > 0 ? parsed : extractAmountNumber(o.rowJson);
      const reviewFee = resolveReviewFee({
        schedules: [],
        fallback: o.reviewFee || 0,
        snapshot: o.feeSnapshot,
        orderDate: toKstDate(o.orderedAt),
        sheetDate: o.campStartDate || null,
      }).fee;
      items[`order||${o.id}`] = {
        reviewFee,
        productPrice: price > 0 ? price : null,
        thumbnailUrl: o.thumbnailUrl || '',
        purchaseDate: toKstDate(o.orderedAt) || o.campStartDate || null,
      };
      count++;
      reviewTotal += reviewFee;
      if (price > 0) productTotal += price; else productUnknown++;
    }

    res.json({
      ok: true,
      totals: { productTotal, reviewTotal, grandTotal: productTotal + reviewTotal, count, productUnknown },
      doneTotals: {
        productTotal: dProductTotal, reviewTotal: dReviewTotal,
        grandTotal: dProductTotal + dReviewTotal,
        count: dCount, productUnknown: dProductUnknown, unpaidCount: dUnpaidCount,
      },
      items,
    });
  } catch (err) {
    logger.warn('[review-earnings] 실패: ' + err.message);
    res.json({
      ok: true,
      totals: { productTotal: 0, reviewTotal: 0, grandTotal: 0, count: 0, productUnknown: 0 },
      doneTotals: { productTotal: 0, reviewTotal: 0, grandTotal: 0, count: 0, productUnknown: 0, unpaidCount: 0 },
      items: {},
    });
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

// ── 문의 첨부 이미지 URL 검증 ──
//   화면에 <img src>로 나가므로 자유 문자열 금지 — 우리 서버의 guide-image 프록시 URL만 허용.
//   (외부 URL 주입·트래킹 픽셀 차단)
function _sanitizeCsImageUrls(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (const raw of arr.slice(0, 5)) {          // 메시지당 최대 5장
    const s = String(raw || '').trim();
    if (!/^https?:\/\/[^\s"'<>]+\/api\/order\/guide-image\/[-\w]{20,}$/.test(s)) continue;
    out.push(s);
  }
  return out;
}

// POST /api/reviewer/cs/upload — 문의 첨부 이미지 업로드(무인증, phone8 스코프)
//   body: { phone8, imageBase64, mimeType?, fileName? } → { ok, url }
//   저장은 기존 guide-image Drive 인프라 재사용 → 무인증 프록시 URL 반환(<img src> 가능).
router.post('/cs/upload', imageApiLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone8 = _normPhone8(b.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });

    let data = String(b.imageBase64 || '');
    if (!data.trim()) return res.status(400).json({ ok: false, error: '이미지 데이터가 없습니다.' });
    // data URL로 오면 헤더 제거 + mime 추출
    let mime = (b.mimeType || '').toString();
    const m = data.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { mime = mime || m[1]; data = m[2]; }
    if (!/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime || 'image/png')) {
      return res.status(400).json({ ok: false, error: '이미지 파일만 첨부할 수 있습니다.' });
    }
    // 용량 제한 8MB (base64 → 원본 약 3/4)
    if (data.length * 0.75 > 8 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: '이미지가 너무 큽니다 (8MB 이하).' });
    }

    const drive = require('../services/drive.service');
    let folderId = process.env.CS_UPLOAD_FOLDER_ID || process.env.GUIDE_FOLDER_ID;
    if (!folderId) {
      const root = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
      if (!root) return res.status(503).json({ ok: false, error: '저장 폴더가 설정되지 않았습니다.' });
      const folder = await drive.ensureFolderPath(root, ['[문의첨부]']);
      folderId = folder.id;
    }
    const ext = ((mime || 'image/png').split('/')[1] || 'png').split('+')[0];
    let name = (b.fileName || `cs_${phone8}_${Date.now()}`).toString().replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + ext;

    const up = await drive.uploadFileBase64(data, name, mime || 'image/png', folderId, { shareAnyone: true });
    const base = (process.env.PUBLIC_API_URL || ('https://' + req.get('host'))).replace(/\/+$/, '');
    res.json({ ok: true, url: `${base}/api/order/guide-image/${up.id}` });
  } catch (err) {
    next(err);
  }
});

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

// GET /api/reviewer/cs/unread?phone8= — 내 미확인 메시지 총합(탭 뱃지용)
router.get('/cs/unread', async (req, res, next) => {
  try {
    const phone8 = _normPhone8(req.query.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(reviewer_unread_count),0)::int AS "totalUnread",
              COUNT(*) FILTER (WHERE reviewer_unread_count > 0)::int AS "unreadRooms"
       FROM cs_threads WHERE reviewer_phone8 = $1`, [phone8]
    );
    res.json({ ok: true, totalUnread: rows[0].totalUnread, unreadRooms: rows[0].unreadRooms });
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
      `SELECT id, sender_role AS "senderRole", sender_name AS "senderName", content,
              image_urls AS "imageUrls", created_at AS "createdAt",
              msg_type AS "msgType", meta
       FROM cs_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 1000`, [thread.id]
    );
    await pool.query(`UPDATE cs_threads SET reviewer_unread_count = 0, updated_at = NOW() WHERE id = $1`, [thread.id]);

    // ★ 리뷰어 화면 = 닉네임 || '관리자' — 관리자 실명(로그인 계정명)은 절대 내보내지 않는다.
    //   읽는 시점 치환이라 과거에 실명으로 쌓인 답장도 함께 가려진다.
    const shown = await adminNickname.maskMessages(messages, 'reviewer');
    res.json({ ok: true, threadId: thread.id, campaignLabel: thread.campaignLabel, status: thread.status, messages: shown });
  } catch (err) {
    next(err);
  }
});

// POST /api/reviewer/cs/message — 문의 메시지 전송(스레드 upsert + 관리자 알림 + 웹훅)
// body: { phone8, name, campaignKey, campaignLabel, campaignSource, content, imageUrls? }
router.post('/cs/message', async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone8 = _normPhone8(b.phone8);
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    const content = (b.content || '').toString().trim();
    const imageUrls = _sanitizeCsImageUrls(b.imageUrls);
    // 사진만 보내는 것도 허용 — 둘 다 없을 때만 거부
    if (!content && imageUrls.length === 0) return res.status(400).json({ ok: false, error: '메시지 내용을 입력해주세요.' });
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
    `, [phone8, reviewerName, campaignKey, campaignLabel, source,
        (content || `사진 ${imageUrls.length}장`).slice(0, 120)]);
    const threadId = tRows[0].id;
    const isNew = tRows[0].isNew;

    const { rows: mRows } = await pool.query(
      `INSERT INTO cs_messages (thread_id, sender_role, sender_name, content, image_urls)
       VALUES ($1, 'reviewer', $2, $3, $4::jsonb) RETURNING id, created_at AS "createdAt"`,
      [threadId, reviewerName, content, JSON.stringify(imageUrls)]
    );
    const message = {
      id: mRows[0].id, threadId, senderRole: 'reviewer', senderName: reviewerName,
      content, imageUrls, createdAt: mRows[0].createdAt,
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

// ═══════════════════════════════════════════════════════════
// 리뷰어 소식·공지 (관리자 작성 → 리뷰어 홈 상단 노출)
// ═══════════════════════════════════════════════════════════

// GET /api/reviewer/notices — 리뷰어 홈용(공개, 노출중인 것만)
router.get('/notices', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, pinned, created_at AS "createdAt"
       FROM reviewer_notices
       WHERE active = TRUE
       ORDER BY pinned DESC, created_at DESC
       LIMIT 30`
    );
    res.json({ ok: true, notices: rows });
  } catch (err) { next(err); }
});

// GET /api/reviewer/notices/all — 관리자용(전체, 숨김 포함)
router.get('/notices/all', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, body, pinned, active, created_by AS "createdBy", created_at AS "createdAt"
       FROM reviewer_notices
       ORDER BY pinned DESC, created_at DESC
       LIMIT 200`
    );
    res.json({ ok: true, notices: rows });
  } catch (err) { next(err); }
});

// POST /api/reviewer/notices/save — 관리자 작성/수정 { id?, title, body, pinned?, active? }
router.post('/notices/save', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = (b.title || '').toString().trim();
    const body = (b.body || '').toString().trim();
    if (!title && !body) return res.status(400).json({ ok: false, error: '제목 또는 내용을 입력하세요.' });
    const pinned = b.pinned === true || b.pinned === 'true';
    const active = b.active === undefined ? true : (b.active === true || b.active === 'true');
    const by = req.admin?.name || '';

    if (b.id) {
      const { rows } = await pool.query(
        `UPDATE reviewer_notices
           SET title = $2, body = $3, pinned = $4, active = $5, updated_at = NOW()
         WHERE id = $1 RETURNING id`,
        [b.id, title, body, pinned, active]
      );
      if (rows.length === 0) return res.status(404).json({ ok: false, error: '공지를 찾을 수 없습니다.' });
      return res.json({ ok: true, id: rows[0].id });
    }
    const { rows } = await pool.query(
      `INSERT INTO reviewer_notices (title, body, pinned, active, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, body, pinned, active, by]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { next(err); }
});

// POST /api/reviewer/notices/delete — 관리자 삭제 { id }
router.post('/notices/delete', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const id = (req.body && req.body.id || '').toString();
    if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });
    await pool.query(`DELETE FROM reviewer_notices WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// GET /api/reviewer/my-missing-captures?phone8=XX — 구매캡쳐가 빠진 내 주문 (무인증·phone8 스코프)
//
// 배경: 구매캡쳐 미첨부의 85%가 "리뷰어가 실제로 안 올린 것"(운영 실측). 지금은 리뷰어가
//   자기 주문에 캡처가 빠졌다는 걸 알 방법이 없어 관리자가 개별 독촉해야 한다.
//   리뷰어 홈에서 스스로 보완하게 하면 그 왕복이 사라진다.
// 노출은 my-status 와 같은 수준(phone8 = 연락처 끝 8자리 소유자만 자기 건 조회) + 필드 최소화.
//   첨부는 기존 업로드 경로(/api/image/image-upload + orderSubmissionId) 재사용 — 신규 쓰기 표면 0.
// ═══════════════════════════════════════════════════════════
router.get('/my-missing-captures', async (req, res, next) => {
  try {
    const phone8 = String(req.query.phone8 || '').trim();
    if (phone8.length !== 8) return res.status(400).json({ ok: false, error: 'phone8 필수 (8자리)' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);

    // 캡처 연결 기능 배포 이전 주문은 링크가 없는 게 정상 → 보완 요청 대상이 아니다(과거분 독촉 방지).
    let cutoff = null;
    try {
      const { rows: cf } = await pool.query(
        `SELECT value FROM app_settings WHERE key = 'reviewer_log_capture_cutoff'`);
      cutoff = (cf[0] && cf[0].value) || null;
    } catch (_) { /* 못 읽으면 기간 조건만 적용 */ }

    const { rows } = await pool.query(`
      SELECT os.id, os.tab_name AS "tabName", os.recipient, os.orderer,
             os.submitted_at AS "submittedAt", os.sheet_id AS "sheetId",
             tc.display_name AS "displayName", tc.campaign_name AS "campaignName"
        FROM order_submissions os
        LEFT JOIN tab_configs tc ON tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
       WHERE RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 8) = $1
         AND os.deleted_at IS NULL
         AND os.capture_uploaded_at IS NULL
         AND os.submitted_at > NOW() - ($2 || ' days')::interval
         AND ($3::timestamptz IS NULL OR os.submitted_at > $3::timestamptz)
       ORDER BY os.submitted_at DESC
       LIMIT 30`, [phone8, String(days), cutoff]);

    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) { next(err); }
});

module.exports = router;
