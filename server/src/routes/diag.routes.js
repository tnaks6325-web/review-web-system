const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID, randomBytes } = require('crypto');
const router = express.Router();
// Track B(trackB.routes.js)가 경로 문자열 대신 이름으로 부르는 핸들러 모음 — 맨 아래 router.handlers 로 내보낸다(결정 270).
const { lastRouteHandler } = require('../utils/routeHandlers');
const _handlers = {};
const { authMiddleware, adminOrMasterMiddleware, isTrustedLoginToken } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta } = require('../services/sheets.service');
const { imageApiLimiter, imageUploadLimiter } = require('../middleware/rateLimit.middleware');
const captureLinkBackfill = require('../services/captureLinkBackfill.service');
const { extractOrderFromImage, verifyAddressMatch } = require('../services/gemini.service');
const driveService = require('../services/drive.service');
const { emitImageExtract, emitImageUpload } = require('../utils/sse');
const { logger } = require('../utils/logger');
const { slotLabel: slotLabelOf, effectiveCaptureSlots, isCashReceiptSlot } = require('../utils/captureSlots');
const { verifyCapture, logCaptureMismatch, resolveCaptureMismatch } = require('../services/captureVerify.service');
const { logAbnormal } = require('../services/errorLog.service');
const { reviewTypeForTab } = require('../services/reviewTypeContext.service');
const purchaseSessions = require('../services/purchaseSubmissionSession.service');
const reviewerOrderIdentity = require('../services/reviewerOrderIdentity.service');
const { verifyReviewerSession } = require('../services/reviewerSession.service');
const { recipientNameForRow } = require('../services/captureOwnerName.service');

/** 리뷰어 화면이 보낸 세션에서 서버가 검증한 신원만 반환한다. */
function verifiedReviewerIdentity(req) {
  const token = req.headers['x-reviewer-token'];
  if (!token) return null;
  try {
    const session = verifyReviewerSession(token);
    const phone8 = String(session.loginPhone8 || '').replace(/\D/g, '').slice(-8);
    if (phone8.length !== 8) return null;
    return { reviewerName: String(session.loginName || '').trim(), phone8, session };
  } catch (_) {
    return null;
  }
}

/** 리뷰어 토큰이 없는 수동 업로드는 내부 담당자 JWT로만 허용한다. */
function verifiedInternalUploadIdentity(req) {
  const auth = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  try {
    const decoded = jwt.verify(match[1], process.env.JWT_SECRET);
    if (!decoded || !['master', 'admin', 'staff'].includes(decoded.role)) return null;
    if (decoded.via === 'reviewer_campaign') return null;
    if (decoded.via === 'intranet' && req.trackBUploadAuthorized !== true) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

// ── Auto-migration: review_submissions.slot_key 컬럼 추가 (제출 파일이 어느 캡처 슬롯인지) ──
// 기존 행은 DEFAULT 'review'로 채워짐. NULL 없음. (migration 034 와 동일)
(async () => {
  try {
    await pool.query(`
      ALTER TABLE review_submissions
      ADD COLUMN IF NOT EXISTS slot_key TEXT NOT NULL DEFAULT 'review'
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_review_sub_slot
        ON review_submissions(sheet_id, tab_name, row_index, slot_key)
    `);
    logger.info('[diag] review_submissions.slot_key 컬럼 확인/추가 완료');
  } catch (err) {
    logger.warn('[diag] slot_key 컬럼 추가 실패 (이미 존재할 수 있음):', err.message);
  }
})();

// GET /api/diag/debug-tab · /debug-base 은 2026-10-05 제거 — 결정 186 103번(옛 리뷰제출 화면의 열 수 없는 진단 창 전용 · 9/2 이후 호출 0).


// (GET /api/viewer/viewer-data — 광고주 뷰어 viewer.html 전용, 2026-09-28 제거 · 결정 186 47번)

// ═══════════════════════════════════════════════════════════
// POST /api/blacklist — 블랙리스트 관리 (GAS: blacklist)
// 주의: app.js에서 app.use('/api/blacklist', diagRoutes) 로 마운트하므로 path='/'
// ═══════════════════════════════════════════════════════════
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { action, action2, phone, name, reason } = req.body;
    const act = action || action2 || 'list';

    switch (act) {
      case 'add': {
        if (!phone) return res.json({ error: '전화번호가 필요합니다.' });
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        await pool.query(
          `INSERT INTO blacklist (phone, name, reason, added_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (phone) DO UPDATE SET name = $2, reason = $3`,
          [cleanPhone, name || '', reason || '', req.admin?.name || '']
        );
        return res.json({ ok: true });
      }
      case 'remove': {
        if (!phone) return res.json({ error: '전화번호가 필요합니다.' });
        // ★ 해제는 공고별 참여 불가까지 일괄로 푼다 — 등록리뷰어DB 토글과 같은 권한(관리자·마스터)만 허용.
        //   이 라우트는 authMiddleware 뿐이라 여기서 막지 않으면 낮은 권한 계정이 일괄 해제를 할 수 있다.
        const role = req.admin && req.admin.role;
        if (role !== 'admin' && role !== 'master') return res.status(403).json({ ok: false, error: '관리자 권한이 필요합니다.' });
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        // 해제 = 다시 참여 가능 — 공고별 참여 불가까지 함께 푸는 단일 경로(reviewerGate.setGlobalBlacklist)를 쓴다.
        const out = await require('../services/reviewerGate.service')
          .setGlobalBlacklist({ phone: cleanPhone, on: false, by: req.admin?.name || '' });
        return res.json({ ok: true, ...out });
      }
      case 'check': {
        // 이름으로 블랙리스트 확인
        if (!name) return res.json({ ok: true, isBlacklisted: false });
        const { rows } = await pool.query(
          'SELECT * FROM blacklist WHERE name ILIKE $1', [`%${name}%`]
        );
        return res.json({ ok: true, isBlacklisted: rows.length > 0, matches: rows });
      }
      case 'list':
      default: {
        const { rows } = await pool.query(
          'SELECT phone, name, reason, added_by AS "addedBy", added_at AS "addedAt" FROM blacklist ORDER BY added_at DESC'
        );
        return res.json({ ok: true, blacklist: rows, total: rows.length });
      }
    }
  } catch (err) {
    next(err);
  }
});

// (GET /api/diag/campaign-list — 옛 대시보드 캠페인 목록, 2026-10-22 제거 · 결정 273 · 결정 186 88번)

// 시트 시절 임시 진단 10종(tab-gid-check·dashboard-check·dashboard-roundlist·round-check·drive-diag·payment-check·sse-status·debug-parse·archive-detect-debug·slot-locks)은 2026-10-04 제거 — 결정 186 100번(화면 호출 0 · 9/2 이후 0).


// (GET /api/diag/inaed-list(·viewer·image·blacklist) — 리뷰어 이름·전화 명단) 은 2026-10-04 제거 — 화면 호출 0 · 9/2 이후 호출 0 · 개인정보가 새는 입구(결정 186 92번).


// ═══════════════════════════════════════════════════════════
// POST /api/image/extract — 주문이미지 AI 분석 (Gemini Vision)
// 프론트엔드 기대 응답: { ok, orderNumber, recipient, phone, address, price, orderer, ... }
// ═══════════════════════════════════════════════════════════
router.post('/image-extract', imageApiLimiter, async (req, res, next) => {
  let imageHash = '';
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.json({ ok: false, error: '이미지 데이터가 필요합니다.' });

    imageHash = reviewerOrderIdentity.hashImageBase64(imageBase64);

    // 설정 › AI 판별 예시의 구매캡처 기준이미지를 실제 주문정보 OCR에도 동봉한다.
    // 예시 조회/다운로드 장애는 기존 추출을 막지 않는다(fail-open).
    let extractionSamples = [];
    try {
      extractionSamples = await require('../services/reviewInspect.service').loadOrderExtractionSamples();
    } catch (_) { extractionSamples = []; }
    /* 결정 288 — 구매캡처 두 번째 장 판독: 배송메세지·상품만 있어도 성공으로 받고(allowSecondCapture),
       명의 확인 증명에는 쓰지 않는다(화면이 첫 장 증명만 제출에 싣는다). */
    const secondCapture = Number(req.body && req.body.captureIndex) === 2;
    const result = await extractOrderFromImage(imageBase64, mimeType || 'image/jpeg', { samples: extractionSamples, allowSecondCapture: secondCapture });
    // result: { ok, orderNumber, recipient, phone, address, price, orderer, productName, orderDate, store, elapsed }

    // ── SSE 알림: AI 분석 완료 ──
    if (result.ok) {
      emitImageExtract({
        recipient: result.recipient || '',
        orderNumber: result.orderNumber || '',
        elapsed: result.elapsed || 0,
      });
    }

    const proof = reviewerOrderIdentity.issueExtractionProof({ imageHash, extracted: result, ok: !!result.ok });
    // ★ 2026-10-02 B안 — 구매양식 링크 화면이 작업(sheetId·tabName)을 함께 보내면, 캡처에서 읽은 상품명을
    //   그 작업의 상품 선택지 중 하나로 짝지어 돌려준다(productLabel). 짝짓기 규칙은 빈 줄 고르기와 같은
    //   resolveProductLabel 하나 — 화면에 사본을 두지 않는다. 못 정하면 '' (리뷰어가 직접 고른다).
    //   ★ 어떤 실패도 판독 응답을 막지 않는다(fail-open).
    let productLabel = '';
    try {
      const pSheet = String((req.body && req.body.sheetId) || '').trim();
      const pTab = String((req.body && req.body.tabName) || '').trim();
      if (result.ok && result.productName && pSheet && pTab) {
        const so = require('../services/sheetlessOrder.service');
        const choices = await so.listProductChoices(pool, pSheet, pTab);
        if (choices.length) productLabel = so.resolveProductLabel(result.productName, choices);
      }
    } catch (_) { productLabel = ''; }
    // 결정 245 — 배송메세지는 서명에 담아 준다(제출 때 서버가 이 서명에서만 꺼낸다). 서명 실패도 판독 응답을 막지 않는다.
    let deliveryMemoToken = '';
    // 두 번째 장에는 주문번호가 안 찍히는 게 보통이라, 그때만 화면이 첫 장·입력칸에서 보낸 주문번호(orderNumberHint)에 묶는다.
    //   ★ 제출 때 서명의 주문번호가 제출한 주문번호와 같아야만 쓰이므로(readDeliveryMemoProof) 다른 주문으로 옮겨 붙일 수 없다.
    const memoOrder = result.orderNumber || (secondCapture ? String((req.body && req.body.orderNumberHint) || '').trim() : '');
    try { deliveryMemoToken = result.ok ? reviewerOrderIdentity.issueDeliveryMemoProof(result.deliveryMemo, memoOrder) : ''; } catch (_) { deliveryMemoToken = ''; }
    // ★ 두 번째 장 판독에는 명의 확인 증명을 싣지 않는다(결정 288 — 명의 확인은 첫 장만 · 빈 칸 증명이 매칭 경로에 쓰이지 않게).
    // 결정 300 — 두 번째 장을 받았다는 서명(읽었든 못 읽었든). 필수 배송메세지 「직원 확인 요청」의 전제다. 서명 실패도 판독 응답을 막지 않는다.
    let capture2Token = '';
    if (secondCapture) { try { capture2Token = reviewerOrderIdentity.issueSecondCaptureProof(memoOrder, imageHash); } catch (_) { capture2Token = ''; } }
    res.json(secondCapture ? { ...result, productLabel, deliveryMemoToken, capture2Token } : { ...result, ...proof, productLabel, deliveryMemoToken });
  } catch (err) {
    logger.error(`[image-extract] ${err.message}`);
    logAbnormal({
      flow: 'image_extract', step: 'gemini_call', source: 'external_api', error: err,
      context: { path: req.path, method: 'POST' },
    });
    const failed = {
      ok: false,
      error: err.message || '이미지 분석 중 오류가 발생했습니다.',
      orderNumber: '', recipient: '', phone: '', address: '', price: ''
    };
    const proof = imageHash
      ? reviewerOrderIdentity.issueExtractionProof({ imageHash, extracted: failed, ok: false, errorCode: err.code || err.name || 'extract_failed' })
      : {};
    // 결정 300 — 판독이 실패해도(AI 장애) 두 번째 장은 받았다 — 화면이 보낸 주문번호에 묶어 서명한다(위와 같은 규율).
    let capture2Token = '';
    if (imageHash && Number(req.body && req.body.captureIndex) === 2) {
      try { capture2Token = reviewerOrderIdentity.issueSecondCaptureProof(String((req.body && req.body.orderNumberHint) || '').trim(), imageHash); } catch (_) { capture2Token = ''; }
    }
    res.json(capture2Token ? { ...failed, ...proof, capture2Token } : { ...failed, ...proof });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/upload — 주문캡처 이미지 Drive 업로드 (새 3단계 구조)
//
// 폴더 구조: AI_REVIEW_FOLDER → {시트제목} → {탭명} → [구매캡처]
// 프론트엔드 페이로드는 이미지와 서버가 발급한 주문ID·세션ID·세션토큰을 함께 보낸다.
// 폴더 좌표는 클라이언트 값이 아니라 세션에 고정된 sheetId/tabName만 사용한다.
// tab_configs.capture_folder_url이 없으면 ensureCaptureFolderPath로 만들고 서버가 직접 저장한다.
// ═══════════════════════════════════════════════════════════
router.post('/image-upload', imageUploadLimiter, async (req, res, next) => {
  let uploadLease = null;
  const failOwnedAttempt = async code => {
    if (!uploadLease) return; // 점유 전 실패·둘째 장은 첫 장 세션 상태를 쓰지 않는다.
    await purchaseSessions.markFailed({
      sessionId: req.body.captureSessionId, orderSubmissionId: req.body.orderSubmissionId,
      attemptCount: uploadLease.attemptCount, code,
    });
  };
  try {
    const { imageBase64, mimeType, fileName, displayName, round,
            orderSubmissionId, captureSessionId, captureSessionToken } = req.body;
    if (!imageBase64) return res.json({ ok: false, error: '이미지 데이터가 필요합니다.' });
    /* 결정 288 — 구매캡처 두 번째 장(선택). 1 = 종전 첫 장(기본 · 옛 화면은 이 값을 안 보낸다) / 2 = 두 번째 장.
       두 번째 장은 같은 세션 검증을 거치되 자기 칸(capture_file_id_2)에만 연결하고, 첫 장의 세션 상태는 건드리지 않는다. */
    const captureIndex = Number(req.body.captureIndex) === 2 ? 2 : 1;
    const second = captureIndex === 2;

    // 구매캡처는 서버가 주문 응답으로 발급한 세션과 주문 ID가 모두 맞아야 한다.
    // 이름·최근시각 추정이나 클라이언트가 보낸 폴더 URL은 신뢰하지 않는다.
    const uploadCtx = await purchaseSessions.inspectForUpload({
      sessionId: captureSessionId,
      sessionToken: captureSessionToken,
      orderSubmissionId,
      captureIndex,
    });
    if (!uploadCtx.ok) {
      return res.status(403).json({ ok: false, code: uploadCtx.code, error: '구매캡처 제출 세션이 유효하지 않습니다. 구매양식을 다시 열어주세요.' });
    }
    if (uploadCtx.alreadyCompleted) {
      return res.json({ ok: true, alreadyCompleted: true, fileId: uploadCtx.captureFileId, captureIndex });
    }
    // 두 번째 장은 세션의 "업로드 중" 표시를 쓰지 않는다(그 표시는 첫 장 전용) — 동시 업로드는 연결 단계의 주문 잠금이 가른다.
    if (!second) {
      uploadLease = await purchaseSessions.markUploading({ sessionId: captureSessionId, orderSubmissionId });
      if (!uploadLease) {
        // 사전 확인 뒤 다른 요청·직원이 완료했을 수 있다. 파일을 새로 만들지 않고 현재 값을 반환한다.
        const latest = await purchaseSessions.inspectForUpload({
          sessionId: captureSessionId, sessionToken: captureSessionToken, orderSubmissionId, captureIndex,
        });
        if (!latest.ok) return res.status(403).json({ ok: false, code: latest.code, error: '구매캡처 제출 세션이 유효하지 않습니다. 구매양식을 다시 열어주세요.' });
        if (latest.alreadyCompleted) return res.json({ ok: true, alreadyCompleted: true, fileId: latest.captureFileId, captureIndex });
        return res.status(409).json({ ok: false, code: 'capture_upload_in_progress', retryable: true, error: '같은 구매캡처가 이미 업로드 중입니다.' });
      }
    }
    const sheetId = uploadCtx.captureSheetId;
    const tabName = uploadCtx.captureTabName;

    const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      logger.warn('[image-upload] AI_REVIEW_FOLDER_ID 미설정');
      throw Object.assign(new Error('Drive 루트 폴더가 설정되지 않았습니다. (AI_REVIEW_FOLDER_ID)'), { code: 'drive_not_configured' });
    }

    // ── 1·2단계: 캡처 폴더 확보 — 작업보드 [구매캡처 교체]와 같은 함수(captureFolder.service 단일 출처) ──
    let targetFolderId = null;
    let captureFolderUrl = null;
    try {
      const folder = await require('../services/captureFolder.service')
        .resolveCaptureFolder({ sheetId, tabName, round, rootFolderId });
      targetFolderId = folder.folderId;
      captureFolderUrl = folder.folderUrl;
    } catch (folderErr) {
      logger.error(`[image-upload] 폴더 생성 실패: ${folderErr.message}`);
      throw folderErr;
    }

    // ── 3단계: 요청별 독립 파일명 — 이름은 기존 증빙의 삭제 근거가 아니다(결정 305) ──
    const rawName = String(fileName || '주문캡처.jpg');
    const dot = rawName.lastIndexOf('.');
    const baseName = (dot > 0 ? rawName.slice(0, dot) : rawName).slice(0, 80) || '주문캡처';
    const ext = (dot > 0 ? rawName.slice(dot + 1) : 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'jpg';
    // stale 점유 인수로 요청이 겹쳐도 서로의 파일을 건드리지 않는다. _2 는 둘째 장 계약을 보존한다.
    // __pcv2_ 는 롤링 배포 중 구서버의 결정적 파일명·동명 삭제와도 격리한다.
    const finalFileName = `${baseName}${second ? '_2' : ''}__${String(orderSubmissionId).slice(0, 8)}_${String(captureSessionId).slice(0, 8)}__pcv2_${randomBytes(16).toString('hex')}.${ext}`;

    // ── 4단계: 파일 업로드 ──
    const uploaded = await driveService.uploadFileBase64(
      imageBase64, finalFileName, mimeType || 'image/jpeg', targetFolderId
    );

    logger.info(`[image-upload] 업로드 완료: ${uploaded.name} → ${uploaded.id}`);

    // ── 캡처↔주문 연결 — 세션+주문ID 정확일치, 주문 단위 직렬화 ──
    let finalLinkedFileId = uploaded.id;
    try {
      const linked = await purchaseSessions[second ? 'completeCapture2' : 'completeCapture']({
        sessionId: captureSessionId,
        sessionToken: captureSessionToken,
        orderSubmissionId,
        captureFileId: uploaded.id,
      });
      if (!linked.ok) throw Object.assign(new Error(linked.code), { code: linked.code });
      finalLinkedFileId = linked.captureFileId || uploaded.id;
      // 다른 세션이 먼저 같은 주문을 완료했으면 이번에 올라간 패배 파일만 휴지통으로 보낸다.
      if (linked.alreadyCompleted && linked.captureFileId && linked.captureFileId !== uploaded.id) {
        try { await driveService.trashFiles([{ id: uploaded.id, name: uploaded.name }]); }
        catch (cleanupErr) { logger.warn(`[image-upload] 동시 업로드 패배 파일 정리 실패: ${cleanupErr.message}`); }
        // 승자 ID에 이미 정리한 패자의 이름·URL·알림을 섞지 않는다(사전 완료 응답과 같은 계약).
        return res.json({ ok: true, alreadyCompleted: true, fileId: linked.captureFileId, captureIndex });
      }
    } catch (linkErr) {
      await failOwnedAttempt(linkErr.code || 'db_link_failed');
      logger.error(`[image-upload] 캡처↔주문 연결 실패: ${linkErr.message}`);
      return res.status(503).json({
        ok: false,
        code: 'capture_link_failed',
        retryable: true,
        error: '캡처 파일은 임시 저장됐지만 주문 연결에 실패했습니다. 다시 시도해주세요.',
      });
    }

    // ── SSE 알림 ──
    try {
      emitImageUpload({
        fileName: uploaded.name,
        fileId: finalLinkedFileId,
        tabName: tabName || '',
        displayName: displayName || '',
      });
    } catch (notifyErr) {
      logger.warn(`[image-upload] 완료 알림 실패 (사진 연결 유지): ${notifyErr.message}`);
    }

    res.json({
      ok: true,
      captureIndex,
      fileId: finalLinkedFileId,
      alreadyCompleted: finalLinkedFileId !== uploaded.id,
      fileName: uploaded.name,
      webViewLink: uploaded.webViewLink || '',
      webContentLink: uploaded.webContentLink || '',
      captureFolderUrl: captureFolderUrl || '',
    });
  } catch (err) {
    await failOwnedAttempt(err.code || 'upload_failed');
    logger.error(`[image-upload] ${err.message}`);
    logAbnormal({
      flow: 'order_submit', step: 'image_upload', source: 'external_api', error: err,
      context: { path: req.path, method: 'POST', tabName: req.body?.tabName, round: req.body?.round, sheetId: req.body?.sheetId },
    });
    res.json({ ok: false, error: err.message || '이미지 업로드 중 오류가 발생했습니다.' });
  }
});

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// POST /api/image/review-precheck — 1차 필터(M0): 첨부 시점 리뷰/채널 판별
//
// ★ Drive 업로드 0 · DB 쓰기 0 — 순수 판정만 돌려준다. 리뷰어가 캡처를 **고른 직후**
//   호출되므로, 잘못된 파일이 저장되거나 제출로 기록되기 **전에** 되돌릴 수 있다.
//   (사후에 교체요청 → 리뷰어 재제출은 왕복 비용이 커서 실무에서 가장 번거롭다)
// ★ 현재 리뷰어 화면은 X-Reviewer-Token을 보내며, 중복 차단 신원은 검증된 세션에서만 읽는다.
//   같은 이미지는 Gemini 해시 캐시로 상각되고 남용은 imageApiLimiter 로 막는다.
// Body: { base64, mimeType, sheetId, tabName, slotKey }
// ═══════════════════════════════════════════════════════════
router.post('/review-precheck', imageApiLimiter, async (req, res) => {
  // ★★ 이 핸들러는 어떤 경우에도 500 을 내지 않는다 — 1차 필터의 장애가
  //    리뷰어의 첨부·제출을 막으면 막으려던 사고보다 큰 피해가 된다(fail-open).
  try {
    const { base64, mimeType, sheetId, tabName, slotKey, rowIndex, reviewerName, phone8 } = req.body || {};
    const inspect = require('../services/reviewInspect.service');
    const reviewerIdentity = verifiedReviewerIdentity(req);

    /* ── 중복 대조(첨부 즉시) ─────────────────────────────────────────
     * ★★ 리뷰어가 스스로 고칠 수 있는 **유일한 시점**이다 — 사진이 저장되기 전이라
     *   다른 사진으로 바꾸기만 하면 끝난다(제출 후 2차 검수는 관리자 사후처리가 된다).
     * ★ 형식 판정(아래)과 **독립적으로** 계산해 응답에 얹는다 — AI 가 죽어도 중복 차단은 나가고,
     *   중복 조회가 죽으면 동명이인 오차단을 피하기 위해 그 판정만 생략한다.
     * ★ 기존 응답 계약(verdict/blocked)은 건드리지 않는다 — `duplicate` 필드만 **가산**이라
     *   구버전 프론트는 아무 영향이 없다. */
    const dupOf = async () => {
      if (!base64 || !reviewerIdentity) return null;
      try {
        return await inspect.findOwnDuplicate({
          fileHash: inspect.hashBase64(base64),
          sheetId, tabName, rowIndex,
          reviewerName: reviewerIdentity.reviewerName || reviewerName,
          phone8: reviewerIdentity.phone8,
        });
      } catch (_) { return null; }
    };
    const pass = async (code) => res.json({
      ok: true, verdict: 'skip', code, message: '', blocked: false, duplicate: await dupOf(),
    });

    if (!inspect.PRECHECK_ENABLED) return pass('disabled');
    if (!base64) return pass('no_image');
    if (String(slotKey || 'review') !== 'review') return pass('not_review_slot');

    // ★ 기대 채널을 **먼저** 읽는다 — 예시이미지 선택에 필요하고, 제출 시점 검수와
    //   같은 samples 를 써야 AI 캐시가 공유된다(첨부 판정이 제출 때 히트).
    let expectedChannel = null;
    let reviewType = null;
    let workKind = null;
    let samples = [];
    try {
      const exp = await inspect.loadTabExpectations({ sheetId, tabName });
      expectedChannel = exp.expectedChannel;
      reviewType = exp.reviewType;        // ★ 087: 구매확정 작업이면 1차 필터를 돌리지 않는다(안전핀)
      workKind = exp.workKind;            // ★ 099: 블로그체험단도 같은 안전핀(결과물이 포스팅URL)
      /* ★ 행 단위 리뷰타입(리뷰옵션 칸) — 혼합 탭은 탭/공고 값이 null 이라 구매확정 **행**의
         안전핀이 여기서만 켜진다. 행을 모르는 첨부(참여형 임베드 = 행 배정 전)는 종전 그대로.
         fail-open: 조회 실패 = 탭 값 유지. */
      if (rowIndex) {
        try {
          const rt = await require('../services/reviewTypeContext.service').reviewTypeForRow({ sheetId, tabName, rowIndex });
          if (rt) reviewType = rt;
        } catch (_) {}
      }
      // ★★ 조립은 submissionSamples 한 곳 — 업로드 검수·2차 검수와 같은 배열이어야
      //   캐시 지문(sampleSig)이 일치해 첨부 판정이 제출 때 히트한다(AI 콜 순증 0).
      samples = await inspect.submissionSamples({ expectedChannel, slotKey: 'review' });
    } catch (_) { /* 채널을 모르면 대조만 생략(예시도 미동봉) */ }

    let classified = null;
    try {
      const { classifySubmissionImage } = require('../services/gemini.service');
      classified = await classifySubmissionImage(base64, mimeType || 'image/jpeg', { samples });
    } catch (_) { classified = null; }   // AI 장애 = 무판정 통과

    const v = inspect.precheckPolicy({ classified, expectedChannel, slotKey: slotKey || 'review', reviewType, workKind });
    res.json({
      ok: true,
      verdict: v.verdict,          // pass | warn | block | skip
      code: v.code,
      message: v.message,
      channel: v.channel,
      blocked: v.verdict === 'block',
      duplicate: await dupOf(),    // ★ 가산 — 이미 낸 사진이면 {fileId, sameTab, rowIndex, uploadedAt}
    });
  } catch (err) {
    logger.warn(`[review-precheck] 판정 실패(통과 처리): ${err.message}`);
    res.json({ ok: true, verdict: 'skip', code: 'error', message: '', blocked: false });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/review-upload — 리뷰 캡처 Drive 업로드 (새 4단계 구조)
//
// 폴더 구조: AI_REVIEW_FOLDER → {시트제목} → {탭명} → [리뷰] → [옵션(선택)]
// 파일명 규칙: {수취인}_{index}_{yyyyMMdd_HHmmss}.{ext}  ← 이름은 서버가 그 행에서 해석(captureOwnerName)
//
// 프론트엔드 페이로드:
//   { sheetId, tabName, reviewerName, campaignName, optionFolderName,
//     files: [{ data: base64, mimeType, name? }] }
// ═══════════════════════════════════════════════════════════
router.post('/review-upload', imageApiLimiter, async (req, res, next) => {
  try {
    const { sheetId, tabName, reviewerName, campaignName, optionFolderName, files, gid, rowIndex, submitCol, memo, slotKey } = req.body;
    const slot = (slotKey || 'review').toString().trim() || 'review';
    const reviewerIdentity = verifiedReviewerIdentity(req);
    const internalIdentity = verifiedInternalUploadIdentity(req);

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.json({ ok: false, error: '업로드할 파일이 필요합니다.' });
    }
    if (!sheetId || !tabName) {
      return res.json({ ok: false, error: 'sheetId, tabName이 필요합니다.' });
    }
    if (!reviewerIdentity && !internalIdentity) {
      return res.status(401).json({
        ok: false, code: 'REVIEW_UPLOAD_AUTH_REQUIRED',
        error: '리뷰어 로그인을 다시 확인해주세요.',
      });
    }
    if (reviewerIdentity) {
      const ownsTarget = await require('../services/reviewerTargetOwnership.service').ownsReviewerTarget({
        session: reviewerIdentity.session, sheetId, tabName, rowIndex,
      });
      if (!ownsTarget) {
        return res.status(403).json({
          ok: false, code: 'REVIEW_UPLOAD_TARGET_FORBIDDEN',
          error: '이 구매양식의 리뷰를 제출할 권한이 없습니다.',
        });
      }
    }

    if (slot === 'review') {
      const closedReminder = await require('../services/reviewReminder.service')
        .closedStateForTarget({ sheetId, tabName, rowIndex });
      if (closedReminder) {
        return res.status(409).json({
          ok: false,
          code: 'REVIEW_CLOSED_NO_REVIEW',
          error: '최종 제출기한이 지나 미작성으로 종결된 작업입니다.',
        });
      }
    }

    const _riSvc = require('../services/reviewInspect.service');
    // ★ 최종 서버 방어: 한 요청에 여러 장이 있어도 한 장이라도 반영 완료 중복이면
    //   어떤 파일도 Drive에 올리지 않는다. 프런트 검사 우회·응답 경쟁에도 제출은 여기서 멈춘다.
    if (slot === 'review' && reviewerIdentity) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file || !file.data) continue;
        const duplicate = await _riSvc.findOwnDuplicate({
          fileHash: _riSvc.hashBase64(file.data), sheetId, tabName, rowIndex,
          reviewerName: reviewerIdentity.reviewerName || reviewerName,
          phone8: reviewerIdentity.phone8,
        });
        if (duplicate) {
          const rejected = {
            index: i + 1, rejected: 'duplicate_submitted',
            message: '이미 제출됬던 사진이에요', duplicate,
          };
          logger.warn(`[review-upload] 반영 완료된 중복 리뷰캡처 차단 (tab=${tabName}, row=${rowIndex}, match=${duplicate.fileId})`);
          return res.json({ ok: false, uploaded: 0, total: files.length, files: [rejected], error: rejected.message });
        }
      }
    }
    // 한 업로드 요청의 여러 리뷰 이미지를 같은 제출 묶음으로 보존한다.
    const uploadBatchId = randomUUID();

    const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      return res.json({ ok: false, error: 'AI_REVIEW_FOLDER_ID 미설정' });
    }

    // ── 1단계: 리뷰 폴더 ID 확보 ──
    let targetFolderId = null;
    let reviewFolderUrl = null;

    // STEP 1: tab_configs.folder_url (DB)
    const { rows: tabRows } = await pool.query(
      'SELECT folder_url, campaign_name, capture_slots, income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );

    // 슬롯 라벨 해석: capture_slots에서 slot.key에 매칭되는 label을 찾는다.
    //   기본 'review' 슬롯은 하위폴더를 만들지 않아 기존 레이아웃을 그대로 유지한다.
    // ★ 087 2차: 이 탭의 리뷰타입 — 슬롯 라벨과 AI 기대 화면 종류가 **같은 값**을 봐야 한다.
    //   fail-soft(null = 종전 동작).
    let _tabReviewType = null;
    try { _tabReviewType = await reviewTypeForTab({ sheetId, tabName }); } catch (_) {}
    let _campaignCashReceipt = null;
    try {
      const _cashContext = require('../services/cashReceiptContext.service');
      const _rowNo = Number(rowIndex);
      if (Number.isInteger(_rowNo)) {
        const _byRow = await _cashContext.cashReceiptRequirementsForRows([
          { sheetId, tabName, rowIndex: _rowNo },
        ]);
        _campaignCashReceipt = _byRow.get(`${sheetId}\u0000${tabName}\u0000${_rowNo}`);
      }
      // 원본 행이 없거나 행별 판정이 실패한 구형 제출만 기존 탭 단위 보수 판정으로 폴백한다.
      if (_campaignCashReceipt == null) {
        _campaignCashReceipt = await _cashContext.cashReceiptRequiredForTab({ sheetId, tabName });
      }
    } catch (_) {}
    _campaignCashReceipt = _campaignCashReceipt === true;
    /* ★ 행 단위 리뷰타입(리뷰옵션 칸) — AI 기대 화면 종류(verifyCapture)에만 쓴다.
       혼합 탭에서 구매확정 행의 캡처가 "리뷰 화면 아님"으로 몰리지 않게 한다.
       ★ 폴더 라벨(slotLabelOf)은 **탭 값 그대로** — 폴더 이름이 행마다 갈리면 안 된다. */
    let _rowReviewType = null;
    if (rowIndex) {
      try { _rowReviewType = await require('../services/reviewTypeContext.service').reviewTypeForRow({ sheetId, tabName, rowIndex }); } catch (_) {}
    }
    const _effReviewType = _rowReviewType || _tabReviewType;

    let slotLabel = null;
    if (slot !== 'review') {
      // 라벨 판정은 공용 유틸(utils/captureSlots) — 검색·완료판정과 같은 규칙이라
      // 현영 자동 슬롯(receipt)도 '현금영수증' 서브폴더로 일관되게 들어간다.
      slotLabel = slotLabelOf(
        tabRows[0]?.capture_slots, tabRows[0]?.income_type, slot, _tabReviewType, _campaignCashReceipt);
    }
    if (tabRows[0]?.folder_url) {
      targetFolderId = driveService.extractFolderIdFromUrl(tabRows[0].folder_url);
      if (targetFolderId) {
        reviewFolderUrl = tabRows[0].folder_url;
        logger.info(`[review-upload] DB folder_url 사용: ${targetFolderId}`);
      }
    }

    // STEP 2: 자동 생성 (3단계: 시트제목 → 탭명 → [리뷰])
    if (!targetFolderId) {
      let sheetTitle = campaignName || tabRows[0]?.campaign_name || tabName;
      /* ★ 무시트 작업(D2-a): 폴더 1단 = **업체명**. 시트 파일이 없어 아래 getSpreadsheetMeta 는
         404 다. 시트 기반 탭이면 null 이라 아래 기존 로직이 그대로 돈다(무회귀). */
      let _slTitle = null;
      try { _slTitle = await require('../services/folderTitle.service').resolveSheetlessFolderTitle(sheetId, tabName); } catch (_) {}
      if (_slTitle) sheetTitle = _slTitle;
      if (sheetId && !_slTitle) {
        try {
          const { rows: campRows } = await pool.query(
            `SELECT DISTINCT campaign_name FROM tab_configs WHERE sheet_id = $1 AND campaign_name IS NOT NULL AND campaign_name <> '' LIMIT 1`,
            [sheetId]
          );
          if (campRows[0]?.campaign_name) {
            sheetTitle = campRows[0].campaign_name;
          } else {
            const meta = await getSpreadsheetMeta(sheetId);
            if (meta._spreadsheetTitle) sheetTitle = meta._spreadsheetTitle;
          }
        } catch (_) {}
      }

      logger.info(`[review-upload] 폴더 자동 생성: ${sheetTitle} → ${tabName} → [리뷰]`);
      const result = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tabName);
      targetFolderId = result.id;
      reviewFolderUrl = result.url;

      // tab_configs에 리뷰폴더 URL 저장
      await pool.query(
        'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
        [reviewFolderUrl, sheetId, tabName]
      );
    }

    // ★ 루트 업로드 방지 가드: 위 STEP1/STEP2에서 리뷰 폴더를 확보하지 못했으면
    //   업로드를 중단한다. (parentFolderId가 비면 파일이 내 드라이브 루트에 흩어짐)
    if (!targetFolderId) {
      logger.error('[review-upload] 리뷰 폴더 확보 실패 — 루트 업로드 방지를 위해 업로드 중단');
      return res.json({ ok: false, error: '리뷰 폴더를 확보하지 못했습니다. 잠시 후 다시 시도해주세요.' });
    }

    // ★ 자동 분류(파일 라우팅)의 이동 목적지 계산용 — 슬롯/옵션 서브폴더로 내려가기 전의
    //   그 탭 [리뷰] 폴더를 기억해 둔다(targetFolderId 는 아래에서 계속 변이된다).
    const reviewBaseFolderId = targetFolderId;

    const _fileRoute = require('../services/fileRoute.service');
    const _isReceiptUpload = isCashReceiptSlot(
      tabRows[0]?.capture_slots, tabRows[0]?.income_type, slot, _tabReviewType, _campaignCashReceipt);
    const _slotRole = _isReceiptUpload ? 'receipt' : slot;

    // ── 1.5단계: 슬롯 서브폴더 ([리뷰] → {슬롯라벨}) ──
    // 'review'(기본) 슬롯은 하위폴더 없이 [리뷰] 바로 아래 — 기존 동작/정리로직 보존.
    // 현금영수증은 공개 업체 리포트와 분리된 구매캡처 폴더 아래에 보관한다.
    if (_isReceiptUpload) {
      targetFolderId = await _fileRoute.resolveTargetFolder({
        target: 'receipt', sheetId, tabName, reviewBaseFolderId, receiptLabel: slotLabel || '현금영수증',
      });
      if (!targetFolderId) {
        logger.error('[review-upload] 비공개 현금영수증 폴더 확보 실패 — 공개 리뷰 폴더 업로드 차단');
        return res.json({ ok: false, error: '현금영수증 보관 폴더를 확보하지 못했습니다. 잠시 후 다시 시도해주세요.' });
      }
      logger.info(`[review-upload] 비공개 현금영수증 폴더: ${targetFolderId}`);
    } else if (slotLabel) {
      const slotFolder = await driveService.getOrCreateSubFolder(targetFolderId, slotLabel);
      targetFolderId = slotFolder.id;
      logger.info(`[review-upload] 슬롯 서브폴더: ${slotLabel} → ${slotFolder.id}`);
    }

    // 영수증 슬롯 대조용 회사 사업자번호(없어도 검수는 형식 판별만 수행)
    let _companyBizNo = '';
    if (_isReceiptUpload) {
      try {
        const { rows: bz } = await pool.query("SELECT value FROM app_settings WHERE key = 'company_business_no'");
        _companyBizNo = bz[0]?.value || '';
      } catch (_) {}
    }

    // ── 2단계: 옵션 서브폴더 (있으면) ──
    if (optionFolderName) {
      const optFolder = await driveService.getOrCreateSubFolder(targetFolderId, optionFolderName);
      targetFolderId = optFolder.id;
      logger.info(`[review-upload] 옵션 서브폴더: ${optionFolderName} → ${optFolder.id}`);
    }

    // ── 판별 예시이미지 1회 준비 ──
    //   ★ 루프 밖에서 한 번만 — 파일마다 다시 읽으면 Drive 호출이 파일 수만큼 늘어난다.
    //   ★★ 슬롯 검수(verifyCapture)와 2차 검수가 **같은 값**을 써야 AI 캐시가 공유된다(콜 순증 0).
    //   등록된 예시가 없으면 빈 배열 = 오늘과 완전히 같은 동작.
    let _inspectSamples = [];
    let _expectedChannel = null;
    try {
      // ★ 슬롯에 맞는 예시를 고른다 — 리뷰 슬롯엔 리뷰 화면, 영수증 슬롯엔 그 채널의
      //   현금영수증 실물. 반대로 주면 "영수증 자리에 리뷰가 왔다"는 판정이 흔들린다.
      // ★★ 조립은 submissionSamples 한 곳 — 1차 필터·2차 검수와 같은 배열이어야
      //   캐시 지문(sampleSig)이 일치한다(AI 콜 순증 0). 자동 분류 예시(구매캡처·구매확정)도
      //   여기서 함께 실린다.
      if (slot === 'review' || _isReceiptUpload) {
        try { _expectedChannel = (await _riSvc.loadTabExpectations({ sheetId, tabName })).expectedChannel; } catch (_) {}
        _inspectSamples = await _riSvc.submissionSamples({ expectedChannel: _expectedChannel, slotKey: _slotRole });
      }
    } catch (_) { _inspectSamples = []; }   // 준비 실패 = 예시 없이 진행(동작 불변)

    // ── 자동 분류(파일 라우팅) 판정 재료 — 규칙은 utils/captureRoute 전이표 단일 출처 ──
    const { routeDecision: _routeDecision, routeMode: _routeMode,
            rejectEnabled: _routeRejectEnabled, routeSlotLabel: _routeSlotLabel } = require('../utils/captureRoute');
    const _sampleKindSet = new Set(_inspectSamples.map(s => s.kind));
    // ★ 구매캡처 이동은 예시 2장(구매캡처+구매확정)이 모두 등록돼야 발동(사용자 확정)
    const _hasRouteSamples = _sampleKindSet.has('order_capture') && _sampleKindSet.has('purchase_confirm');
    let _hasReceiptSlot = false;
    try {
      _hasReceiptSlot = (effectiveCaptureSlots(
        tabRows[0]?.capture_slots, tabRows[0]?.income_type, _tabReviewType, _campaignCashReceipt) || [])
        .some(sl => sl.key === 'receipt' || /현금영수증|현영|지출증빙/.test(String(sl.label || '')));
    } catch (_) {}
    const _receiptInfo = require('../utils/captureSlots').cashReceiptSlotInfo(
      tabRows[0]?.capture_slots, tabRows[0]?.income_type, _campaignCashReceipt, _tabReviewType);
    const _receiptLabel = (_receiptInfo.slot && _receiptInfo.slot.label) || '현금영수증';

    // 같은 구매양식·같은 행의 기존 캡처는 중복 차단 대상이 아니라 교체 제출이다.
    let replacedCurrent = false;
    if (slot === 'review' && rowIndex) {
      try {
        const { rows: currentRows } = await pool.query(
          `SELECT 1 FROM review_submissions
            WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3
              AND COALESCE(slot_key, 'review') = 'review'
            LIMIT 1`,
          [sheetId, tabName, rowIndex]
        );
        replacedCurrent = currentRows.length > 0;
      } catch (_) { /* 교체 안내용 보조값 — 실패해도 업로드는 계속 */ }
    }

    /* ★★ 파일명에 쓸 이름은 **서버가 그 행의 수취인으로 정한다**(사용자 확정 2026-09-22).
       타계정 참여는 주문자가 로그인 본계정 한 사람이라, 화면이 보낸 이름을 그대로 쓰면
       같은 작업의 캡처가 전부 같은 이름으로 쌓여 **어떤 타계정의 리뷰인지 구분되지 않는다**.
       ★ 해석은 `captureOwnerName` 단일 출처 — 리뷰어 제출 2경로와 작업보드 [📎 리뷰 대신 제출]이
         각자 이름을 고르던 사본이 여기로 모인다. ★ 못 찾으면 종전 값(화면이 보낸 이름)으로 접는다.
       ★ `reviewerName` 자체는 건드리지 않는다 — 원장·알림·검수는 계속 참여자 기준이다. */
    const captureOwnerName =
      (await recipientNameForRow({ db: pool, sheetId, tabName, rowIndex })) || reviewerName || '익명';

    // ── 3단계: 파일 업로드 (복수 파일 루프) ──
    const uploadResults = [];
    // 파일 루프의 판정값은 루프 밖 원장 기록 단계에서도 필요하다. 응답 객체에 붙이면
    // 사업자번호 같은 판정 세부값이 리뷰어에게 노출될 수 있어 서버 내부 Map으로만 보존한다.
    const captureVerdictsByFileId = new Map();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.data) continue;

      // 파일명 생성: {수취인}_{index}_{yyyyMMdd_HHmmss}.{ext}
      const reviewFileName = driveService.generateReviewFileName(
        captureOwnerName,
        i + 1,
        file.mimeType || 'image/jpeg'
      );

      try {
        const uploaded = await driveService.uploadFileBase64(
          file.data,
          reviewFileName,
          file.mimeType || 'image/jpeg',
          targetFolderId,
          /* ★ 공개 권한은 **응답을 기다리지 않고** 뒤에서 건다 — Drive 왕복 1회(약 1초)인데
             업로드 결과(파일 ID·링크)에는 영향이 없고, 그 1초를 리뷰어가 그대로 기다리고 있었다.
             공개가 늦어지는 동안의 영향은 구글 CDN 썸네일이 잠깐 우리 프록시로 폴백하는 것뿐. */
          { deferShare: true }
        );

        // ── 3단계 AI 검수: 이 슬롯에 맞는 형식인지 판별(fail-open — 업로드는 이미 끝났고 막지 않는다) ──
        let verdict = null;
        try {
          verdict = await verifyCapture({
            base64: file.data, mimeType: file.mimeType || 'image/jpeg',
            // ★ 행 우선 유효 리뷰타입 — 혼합 탭의 구매확정 행은 구매확정 화면이 정상 제출이다.
            slotKey: _slotRole, companyBusinessNo: _companyBizNo, reviewType: _effReviewType,
            // ★★ 아래 2차 검수와 **같은 예시이미지**를 넘긴다 — 다르면 캐시 키가 갈려
            //   같은 이미지에 AI 콜이 두 번 나간다(순증 0 이라는 전제가 깨진다).
            samples: _inspectSamples,
          });
        } catch (_) { verdict = null; }   // 검수 실패가 업로드 결과를 뒤집지 않는다

        // ── 자동 분류(파일 라우팅): 오제출을 올바른 폴더로 이동 / 중복이면 휴지통+반려 ──
        //   판정 = utils/captureRoute 전이표(확신 ≥0.9 sure 만) · 실행 = fileRoute.service.
        //   ★★ 반려의 유일한 근거는 SHA-256 정확 일치(findSlotDuplicate) — AI 단독 반려 없음.
        //   ★ 어떤 실패도 업로드를 뒤집지 않는다(fail-open — 라우팅만 생략되고 현행 경고 유지).
        let routed = null, rejected = null, routePlan = null, finalSlot = slot;
        try {
          const _mode = _routeMode();
          if (_mode !== 'off' && verdict && verdict.status === 'mismatch') {
            const rd = _routeDecision({
              slotKey: _slotRole, verdict, hasReceiptSlot: _hasReceiptSlot,
              hasRouteSamples: _hasRouteSamples, expectedChannel: _expectedChannel,
            });
            if (rd.action === 'route') {
              // 자동 분류 규칙은 receipt라는 역할명을 돌려주지만, 수동 슬롯의 실제 원장 key는
              // slot2일 수 있다. 폴더·중복·제출 원장은 설정된 key 한 벌로 맞춘다.
              const toSlotKey = rd.toSlot === 'receipt' && _receiptInfo.slot?.key
                ? String(_receiptInfo.slot.key) : rd.toSlot;
              const toLabel = _routeSlotLabel(rd.toSlot);
              const gotLabel = _routeSlotLabel(verdict.got) || verdict.got;
              const pct = Math.round((verdict.confidence || 0) * 100);
              if (_mode === 'dry') {
                // 관측 모드 — 계획만 기록하고 아무것도 옮기지 않는다(출시 결정 근거 수집)
                routePlan = { toSlot: rd.toSlot, toLabel };
                await _fileRoute.logRouteEvent({
                  eventType: 'capture_route_plan', severity: 'info', resolved: true,
                  sheetId, tabName, reviewerName,
                  message: `[관측] ${reviewerName || '리뷰어'}님이 ${rowIndex ? rowIndex + '행 ' : ''}${_routeSlotLabel(slot)} 칸에 올린 이미지를 ${gotLabel}(AI 확신 ${pct}%)으로 판정 — 자동 이동 대상입니다(관측 모드라 이동하지 않음).`,
                  context: { fileId: uploaded.id, from: slot, to: rd.toSlot, row: String(rowIndex ?? ''), dry: true },
                });
              } else {
                const _fh = _riSvc.hashBase64(file.data);
                const dup = await _fileRoute.findSlotDuplicate({
                  sheetId, tabName, rowIndex, reviewerName,
                  toSlot: toSlotKey, fileHash: _fh, fileId: uploaded.id,
                });
                if (dup && _routeRejectEnabled()) {
                  // 중복 반려 — 방금 파일을 휴지통으로(영구삭제 아님, 30일 복구창)
                  await driveService.trashFiles([{ id: uploaded.id, name: uploaded.name }]);
                  rejected = {
                    reason: 'duplicate',
                    message: `이 파일은 ${toLabel} 칸에 이미 제출된 것과 같은 파일이라 등록되지 않았어요. ${_routeSlotLabel(slot)} 캡처를 올려주세요.`,
                  };
                  await _fileRoute.logRouteEvent({
                    eventType: 'capture_dup_rejected', severity: 'warn',
                    sheetId, tabName, reviewerName,
                    message: `${reviewerName || '리뷰어'}님이 ${rowIndex ? rowIndex + '행 ' : ''}${_routeSlotLabel(slot)} 칸에 올린 파일이 ${toLabel} 칸의 기존 제출과 동일 파일(SHA-256 일치)이라 휴지통으로 옮기고 반려했습니다.`,
                    context: { fileId: uploaded.id, matchFileId: dup.file_id, from: slot, to: toSlotKey, row: String(rowIndex ?? '') },
                  });
                } else if (!dup) {
                  const toFolderId = await _fileRoute.resolveTargetFolder({
                    target: rd.target, sheetId, tabName, reviewBaseFolderId, receiptLabel: _receiptLabel,
                  });
                  if (toFolderId) {
                    await driveService.moveFile(uploaded.id, toFolderId, targetFolderId);
                    finalSlot = toSlotKey;
                    routed = {
                      from: slot, to: toSlotKey, toLabel,
                      message: `첨부하신 이미지가 ${gotLabel}(으)로 확인되어 ${toLabel} ${rd.target === 'capture' ? '폴더' : '칸'}으로 옮겨 드렸어요.`
                        + (slot === 'review' ? ' 리뷰 캡처를 여기에 다시 올려주세요.' : ''),
                    };
                    await _fileRoute.logRouteEvent({
                      eventType: 'capture_routed', severity: 'warn',
                      sheetId, tabName, reviewerName,
                      message: `${reviewerName || '리뷰어'}님이 ${rowIndex ? rowIndex + '행 ' : ''}${_routeSlotLabel(slot)} 칸에 올린 이미지가 ${gotLabel}(AI 확신 ${pct}%)으로 판정되어 ${toLabel} 폴더로 자동 이동했습니다. 리뷰어 화면에는 안내가 표시됐습니다.`,
                      context: { fileId: uploaded.id, from: slot, to: toSlotKey, row: String(rowIndex ?? '') },
                    });
                  }
                }
                // dup && 반려 스위치 꺼짐 → 이동하지 않는다(대상 폴더에 중복 사본을 만들지 않음 — 현행 경고만)
              }
            }
          }
        } catch (routeErr) {
          // 이동/휴지통 단계에서 던져졌으면 routed/rejected 는 세워지기 전이라 그대로 현행 경고 경로.
          logger.warn(`[review-upload] 자동 분류 실패(무시 — 현행 경고 유지): ${routeErr.message}`);
        }

        // 알림 기록은 판정과 분리한다 — 여기서 실패해도 리뷰어 화면의 재첨부 안내(verdict)는 남아야 한다.
        //   ★ 자동 이동/반려된 파일은 capture_mismatch 를 남기지 않는다 — capture_routed /
        //     capture_dup_rejected 가 그 자리를 대신한다(같은 파일에 알림 2건 = 도배).
        try {
          if (verdict && verdict.status === 'mismatch' && !routed && !rejected) {
            // 리뷰어가 [그대로 제출]을 눌러도 사람이 볼 수 있게 관리자 알림으로 남긴다
            // (verdict.sure = AI가 확실히 아니라고 본 경우 → critical 승격 = 대시보드 빨간 알림)
            await logCaptureMismatch({ sheetId, tabName, reviewerName, slotKey: slot,
                                       verdict, fileId: uploaded.id, rowIndex });
          } else if (verdict && verdict.status === 'ok') {
            // 같은 자리에 올바른 캡처가 다시 올라옴 → 열려 있던 알림을 자동으로 닫는다
            await resolveCaptureMismatch({ sheetId, tabName, slotKey: slot, rowIndex });
          }
        } catch (_) { /* 알림 경로 실패는 업로드·판정에 영향 없음 */ }

        if (rejected) {
          // 중복 반려 — 파일은 휴지통으로 갔고 원장에도 싣지 않는다(fileId 미반환)
          uploadResults.push({ index: i + 1, rejected: rejected.reason, message: rejected.message });
          logger.info(`[review-upload] 파일 ${i + 1}/${files.length} 중복 반려(휴지통): ${uploaded.name}`);
        } else {
          if (verdict) captureVerdictsByFileId.set(uploaded.id, verdict);
          uploadResults.push({
            index: i + 1,
            fileId: uploaded.id,
            fileName: uploaded.name,
            webViewLink: uploaded.webViewLink || '',
            slotKey: finalSlot,                          // 라우팅 반영 후 최종 슬롯(원장 기록 기준)
            routed: routed || undefined,                 // {from,to,toLabel,message} — 자동 이동됨
            routePlan: routePlan || undefined,           // 관측 모드의 이동 계획(이동 안 함)
            verdict: verdict && verdict.status !== 'skipped'
              ? { status: verdict.status, message: verdict.message, sure: !!verdict.sure } : null,
          });
          logger.info(`[review-upload] 파일 ${i + 1}/${files.length} 업로드: ${uploaded.name} → ${uploaded.id}` +
            (routed ? ` ↪ 자동 이동(${routed.from}→${routed.to})`
              : (verdict && verdict.status === 'mismatch' ? ` ⚠ 형식 불일치(${verdict.expected}≠${verdict.got})` : '')));
        }
      } catch (uploadErr) {
        logger.error(`[review-upload] 파일 ${i + 1} 업로드 실패: ${uploadErr.message}`);
        uploadResults.push({
          index: i + 1,
          error: uploadErr.message,
        });
      }
    }

    const successCount = uploadResults.filter(r => r.fileId).length;

    // ── A-1/A-2: 제출된 인덱스 행에 리뷰 파일 연결 + 제출 원장 기록 ──
    //   업로드 시점에 rowIndex/sheetId/tabName이 오므로, 대표 파일은 review_index
    //   해당 행에 기록(A-1), 모든 파일은 review_submissions 원장에 적재(A-2). (비파괴)
    const primary = uploadResults.find(r => r.fileId);
    if (primary && rowIndex && sheetId && tabName) {
      const rowIdx = parseInt(rowIndex, 10);

      // 인덱스 행 id 조회 (A-2 review_index_id 연결용)
      let reviewIndexId = null;
      try {
        const { rows } = await pool.query(
          'SELECT id FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3 LIMIT 1',
          [sheetId, tabName, rowIdx]
        );
        reviewIndexId = rows[0]?.id || null;
      } catch (_) {}

      // A-1: 대표 파일을 review_index 행에 기록
      //   ★ 대표 이미지는 기본 'review' 슬롯만 기록한다. 현금영수증 등 다른 슬롯이
      //     대표 리뷰 캡처를 덮어쓰지 않도록 가드(슬롯별 진실은 A-2 원장에 있음).
      //   ★ 자동 분류로 슬롯 구성이 바뀐 호출은 아래 recomputePrimary 가 원장 기준으로
      //     대표를 다시 계산한다(여기 레거시 경로는 라우팅 없을 때 종전 그대로).
      const _routedAny = uploadResults.some(r => r && (r.routed || r.rejected));
      let primaryMappingError = null;
      if (slot === 'review' && !_routedAny) {
        try {
          const fileUrl = primary.webViewLink || `https://drive.google.com/file/d/${primary.fileId}/view`;
          const linked = await pool.query(
            `UPDATE review_index
                SET review_file_id = $1, review_file_url = $2, review_file_name = $3,
                    review_file_count = $4, review_file_at = NOW()
              WHERE sheet_id = $5 AND tab_name = $6 AND row_index = $7`,
            [primary.fileId, fileUrl, primary.fileName, successCount, sheetId, tabName, rowIdx]
          );
          if (!linked.rowCount) throw new Error('review_index 대상 행을 찾을 수 없습니다.');
        } catch (linkErr) {
          primaryMappingError = linkErr;
          logger.error(`[review-upload] 인덱스 파일링크 저장 실패: ${linkErr.message}`);
        }
      }

      // A-2: 업로드된 모든 파일을 review_submissions 원장에 적재 (file_id 업서트)
      //   ★ file_hash 는 여기서 함께 넣는다 — base64 를 이미 쥔 시점이라 계산 비용이 0이고,
      //     나중에 UPDATE 로 채우면 그 사이 올라온 다른 파일이 중복 대조 대상을 놓친다.
      const _inspect = require('../services/reviewInspect.service');
      let submissionLedgerError = null;
      for (const r of uploadResults) {
        if (!r.fileId) continue;
        const _b64 = (files[r.index - 1] && files[r.index - 1].data) || '';
        const _hash = _inspect.hashBase64(_b64);
        try {
          const fUrl = r.webViewLink || `https://drive.google.com/file/d/${r.fileId}/view`;
          await pool.query(
            `INSERT INTO review_submissions
               (sheet_id, tab_name, tab_gid, row_index, reviewer_name, review_index_id,
                file_id, file_url, file_name, source, slot_key, file_hash, upload_batch_id,
                completed_at, uploaded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'upload',$10,$11,$12,
               CASE WHEN
                 EXISTS (
                   SELECT 1 FROM review_index ri
                    WHERE ri.sheet_id = $1 AND ri.tab_name = $2 AND ri.row_index = $4
                      AND ri.is_submitted = TRUE
                 ) OR EXISTS (
                   SELECT 1 FROM campaign_participants cp
                    WHERE cp.sheet_id = $1 AND cp.tab_name = $2 AND cp.seq = $4
                      AND cp.deleted_at IS NULL AND cp.is_submitted = TRUE
                 )
               THEN NOW() ELSE NULL END,
               NOW())
             ON CONFLICT (file_id) DO UPDATE
               SET file_url = EXCLUDED.file_url, file_name = EXCLUDED.file_name,
                   row_index = EXCLUDED.row_index, review_index_id = EXCLUDED.review_index_id,
                   reviewer_name = EXCLUDED.reviewer_name, slot_key = EXCLUDED.slot_key,
                   file_hash = COALESCE(EXCLUDED.file_hash, review_submissions.file_hash),
                   upload_batch_id = EXCLUDED.upload_batch_id,
                   completed_at = COALESCE(review_submissions.completed_at, EXCLUDED.completed_at)`,
            [sheetId, tabName, gid || null, rowIdx, reviewerName || null, reviewIndexId,
             r.fileId, fUrl, r.fileName, r.slotKey || slot, _hash, uploadBatchId]
          );
          // 자동 분류로 이동된 파일은 이동 이력을 함께 남긴다(되돌리기의 유일한 재료)
          if (r.routed) {
            await require('../services/fileRoute.service')
              .markRouted({ fileId: r.fileId, fromSlot: r.routed.from, by: 'auto:upload' });
          }
        } catch (subErr) {
          submissionLedgerError = submissionLedgerError || subErr;
          logger.error(`[review-upload] 제출원장 기록 실패: ${subErr.message}`);
        }

        // ── 2차 검수(M1): 상품명·같은 파일·본문 겹침 대조 후 review_inspections 에 기록 ──
        //   ★ AI 콜 순증 0 — 바로 위 verifyCapture 가 같은 이미지로 classify 를 이미 돌려
        //     캐시를 데워 놨으므로 여기서는 캐시 히트다(첨부 시점 1차 필터가 돌았다면 그때부터).
        //   ★ 절대 throw 하지 않는다(서비스가 내부에서 삼킨다) — 업로드는 이미 끝났고,
        //     검수 실패가 "파일은 올라갔는데 제출 실패"로 보이면 안 된다.
        try {
          const _finalSlotKey = r.slotKey || slot;
          const _finalSlotRole = isCashReceiptSlot(
            tabRows[0]?.capture_slots, tabRows[0]?.income_type, _finalSlotKey,
            _tabReviewType, _campaignCashReceipt) ? 'receipt' : _finalSlotKey;
          let _finalInspectSamples = _inspectSamples;
          if (_finalSlotRole !== _slotRole) {
            try {
              _finalInspectSamples = await _riSvc.submissionSamples({
                expectedChannel: _expectedChannel, slotKey: _finalSlotRole,
              });
            } catch (_) { _finalInspectSamples = []; }
          }
          const _ins = await _inspect.inspectSubmission({
            base64: _b64, mimeType: (files[r.index - 1] && files[r.index - 1].mimeType) || 'image/jpeg',
            fileId: r.fileId, fileHash: _hash,
            sheetId, tabName, rowIndex: rowIdx, reviewerName, slotKey: _finalSlotKey,
            slotRole: _finalSlotRole,
            // 자동 이동으로 슬롯 역할이 바뀌었으면 옛 슬롯 기준 판정을 재사용하지 않는다.
            captureVerdict: _finalSlotRole === _slotRole ? (captureVerdictsByFileId.get(r.fileId) || null) : null,
            samples: _finalInspectSamples,
          });
          // ★ 첨부 즉시 경고(1차)를 지나쳐 제출된 중복은 **리뷰어에게 그 자리에서** 한 번 더 알린다.
          //   관리자 쪽은 위 검수 기록이 리뷰검수 탭에 바로 뜨므로 별도 알림을 새로 쌓지 않는다
          //   (같은 사실로 두 번 울리면 늑대소년이 된다 — 캡처 알림 도배 방지 규율).
          //   ★ 파일은 지우지 않는다 — 정당한 재제출을 잃지 않기 위해 안내까지만.
          if (_ins && _ins.checks && _ins.checks.duplicate && _ins.checks.duplicate.verdict === 'fail') {
            r.duplicateNotice = '앞서 제출하신 사진과 같은 사진이에요. 담당자가 확인 후 다시 요청드릴 수 있습니다.';
          }
        } catch (_) { /* 위 서비스가 이미 삼키지만 이중 방어 */ }
      }

      // 자동 분류로 review 슬롯 구성이 바뀌었으면 대표 이미지를 원장 기준으로 재계산
      //   (영수증이 대표로 남거나, 옮겨 들어온 리뷰가 대표에 안 잡히는 것 방지)
      if (_routedAny) {
        const recomputed = await require('../services/fileRoute.service').recomputePrimary({ sheetId, tabName, rowIndex: rowIdx });
        if (!recomputed?.ok) primaryMappingError = new Error(recomputed?.error || '대표 이미지 재계산 실패');
      }
      if (submissionLedgerError) {
        return res.status(503).json({
          ok: false, code: 'REVIEW_SUBMISSION_LEDGER_FAILED', uploaded: successCount,
          total: files.length, files: uploadResults,
          error: '리뷰 파일 기록에 실패했습니다. 잠시 후 다시 제출해주세요.',
        });
      }
      if (primaryMappingError) {
        return res.status(503).json({
          ok: false, code: 'REVIEW_PRIMARY_LINK_FAILED', uploaded: successCount,
          total: files.length, files: uploadResults,
          error: '리뷰 파일 연결에 실패했습니다. 잠시 후 다시 제출해주세요.',
        });
      }
    }

    const _rejectedResults = uploadResults.filter(r => r && r.rejected);
    res.json({
      ok: successCount > 0,
      uploaded: successCount,
      total: files.length,
      files: uploadResults,
      reviewFolderUrl: reviewFolderUrl || '',
      uploadBatchId,
      replacedCurrent,
      // 전부 반려면 실패 사유를 최상위 error 로도 실어준다(단일 첨부 화면의 기존 오류 표시 경로)
      ...(successCount === 0 && _rejectedResults.length ? { error: _rejectedResults[0].message } : {}),
    });
  } catch (err) {
    logger.error(`[review-upload] ${err.message}`);
    res.json({ ok: false, error: err.message || '리뷰 캡처 업로드 중 오류가 발생했습니다.' });
  }
});
_handlers.reviewUpload = lastRouteHandler(router); // Track B 프록시가 이 이름으로 부른다(결정 270)

// ═══════════════════════════════════════════════════════════
// POST /api/image/verify-address — AI 주소 동일인 비교 (Gemini)
// 프론트엔드 기대 응답: { ok, isSamePerson, confidence, reason }
// ═══════════════════════════════════════════════════════════
router.post('/verify-address', imageApiLimiter, async (req, res, next) => {
  try {
    const {
      naverRecipient, naverPhone, naverAddress,
      coupangRecipient, coupangPhone, coupangAddress
    } = req.body;

    if (!naverAddress && !coupangAddress) {
      return res.json({ ok: false, error: '비교할 주소 정보가 필요합니다.' });
    }

    const naverInfo   = { recipient: naverRecipient || '', phone: naverPhone || '', address: naverAddress || '' };
    const coupangInfo = { recipient: coupangRecipient || '', phone: coupangPhone || '', address: coupangAddress || '' };

    const result = await verifyAddressMatch(naverInfo, coupangInfo);
    // result: { ok, isSamePerson, confidence, reason, elapsed }
    res.json(result);
  } catch (err) {
    logger.error(`[verify-address] ${err.message}`);
    res.json({
      ok: false,
      isSamePerson: false,
      confidence: 0,
      reason: err.message || 'AI 주소 비교 중 오류',
    });
  }
});

// (시트 시절 큐 복구 도구 — GET /sync-queue · POST /sync-queue/retry·purge·delete · GET /order-mirror-status ·
//  POST /order-reconcile 는 2026-10-22 제거 — 결정 273 · 결정 186 82번. 30초 워커·매시 복구는 cron 이 그대로 돈다.)

// POST /api/diag/sheetless-worktable-recover — 첫 탈시트 배포 구간에 원장만 남은 주문을
// DB 작업보드의 준비 슬롯으로 일회성 복구한다. Google Sheet/GAS는 호출하지 않는다.
router.post('/sheetless-worktable-recover', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { withJobLock } = require('../utils/jobLock');
    const { recoverUnwrittenSheetlessOrders } = require('../services/sheetlessOrder.service');
    const limit = Math.min(Math.max(parseInt(b.limit, 10) || 100, 1), 1000);
    const dryRun = b.dryRun !== false;
    if (b.orderSubmissionIds != null && !Array.isArray(b.orderSubmissionIds)) {
      return res.status(400).json({ ok: false, error: 'orderSubmissionIds는 배열이어야 합니다.' });
    }
    if (Array.isArray(b.orderSubmissionIds) && b.orderSubmissionIds.length > 100) {
      return res.status(400).json({ ok: false, error: '한 번에 최대 100건만 지정할 수 있습니다.' });
    }
    const orderSubmissionIds = Array.isArray(b.orderSubmissionIds)
      ? b.orderSubmissionIds.map(id => String(id).trim())
      : null;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (orderSubmissionIds && orderSubmissionIds.some(id => !uuidPattern.test(id))) {
      return res.status(400).json({ ok: false, error: '올바르지 않은 주문 식별값이 포함되어 있습니다.' });
    }
    const by = (req.admin && req.admin.name) ||
      (req.admin && (req.admin.name || req.admin.username || req.admin.id)) || 'admin';
    const run = () => recoverUnwrittenSheetlessOrders({ limit, by, orderSubmissionIds, dryRun });
    const out = dryRun ? await run() : await withJobLock('sheetless_worktable_recover', run);
    if (out && out.skipped) return res.status(409).json({ ok: false, busy: true, error: '다른 작업보드 복구가 진행 중입니다.' });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// POST /api/diag/worktable-number-order-repair — 표시 번호만 구매양식 제출시각 순으로 다시 맞춘다.
// 기본은 미리보기이며 실제 실행도 내부 관리자만 가능하다. 행 자체의 연결값은 바꾸지 않는다.
router.post('/worktable-number-order-repair', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const sheetId = String(b.sheetId || '').trim();
    const tabName = String(b.tabName || '').trim();
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const dryRun = b.dryRun !== false;
    const by = (req.admin && req.admin.name) ||
      (req.admin && (req.admin.name || req.admin.username || req.admin.id)) || 'admin';
    const { renumberTab } = require('../services/rowNumbering.service');
    if (dryRun) return res.json(await renumberTab({ sheetId, tabName, dryRun: true, by }));
    const { withJobLock } = require('../utils/jobLock');
    const run = async () => {
      const client = await pool.connect();
      let out;
      try {
        await client.query('BEGIN');
        // 주문 기록이 빈자리를 고르기 전에 잡는 것과 정확히 같은 작업 단위 잠금이다.
        // 새 제출과 정정이 겹치면 한쪽이 끝난 뒤 최신 상태를 읽어 번호를 다시 매긴다.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
          [`sheetless_worktable:${sheetId}:${tabName}`]);
        out = await renumberTab({ sheetId, tabName, dryRun: false, by, client });
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw err;
      } finally {
        client.release();
      }
      // 번호를 바꾼 뒤 검색·내역에서 옛 번호가 되돌아오지 않게 같은 자료를 다시 만든다.
      if (out && out.ok && out.changed) {
        try {
          await require('../services/sheetlessLedger.service')
            .rebuildLedgers({ sheetId, tabName, by: `renumber:${by}`.slice(0, 100) });
        } catch (err) {
          out.ledgerError = (err && (err.code || err.message)) || 'rebuild_failed';
        }
      }
      return out;
    };
    // 자동 번호 정리와도 같은 잠금으로 묶어 같은 정정을 두 번 동시에 실행하지 않는다.
    const out = await withJobLock('worktable_renumber_sweep', run);
    if (out && out.skipped) return res.status(409).json({ ok: false, busy: true, error: '다른 번호 정리가 진행 중입니다.' });
    res.json(out);
  } catch (err) { next(err); }
});

// POST /api/diag/cleanup-overflow-worktable-slots — 빈 301/300·501/500 같은 과거 초과 슬롯만 정리.
router.post('/cleanup-overflow-worktable-slots', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const { cleanupOverflowEmptyWorktableSlots } = require('../services/linkedRecruitQuota.service');
    const out = await cleanupOverflowEmptyWorktableSlots({
      dryRun: b.dryRun !== false,
      limit: Math.min(Math.max(parseInt(b.limit, 10) || 200, 1), 1000),
      by: (req.admin && (req.admin.name || req.admin.username)) || 'admin',
    });
    res.json(out);
  } catch (err) { next(err); }
});

// POST /api/diag/order-mirror-repair — 작업보드 줄은 있는데 원장만 미완결(`failed` 등)로 굳은
//   주문의 완결 표시를 정정한다. 판정 근거 = `campaign_participants.order_submission_id` 링크
//   (기록 성공 후에만 남는 값 — 복구 잡이 "이미 반영됨"을 판정하는 근거와 같다).
//   ★ dryRun 기본(세어 보고 나서 사람이 실행) · 쓰기 표면 = order_submissions 완결 표시뿐.
router.post('/order-mirror-repair', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { repairWrittenMarkForBoardRows } = require('../services/sheetlessOrder.service');
    const b = req.body || {};
    const limit = Math.min(parseInt(b.limit, 10) || 500, 2000);
    const dryRun = b.dryRun !== false;          // ★ 명시적으로 false 일 때만 실제 정정
    if (b.orderSubmissionIds != null && !Array.isArray(b.orderSubmissionIds)) {
      return res.status(400).json({ ok: false, error: 'orderSubmissionIds는 배열이어야 합니다.' });
    }
    const orderSubmissionIds = Array.isArray(b.orderSubmissionIds)
      ? b.orderSubmissionIds.slice(0, 100)
      : null;
    const by = (req.admin && req.admin.name) || 'admin';
    const out = await repairWrittenMarkForBoardRows({ limit, dryRun, by, orderSubmissionIds });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// (POST·GET /order-flush-tab · POST /order-relink — 시트 탭 우선 반영·탭 리네임 재연결, 2026-10-22 제거 · 결정 273)

// (시트→DB 역동기화 입구 7개 — POST reverse-sync-detect·apply·dismiss·auto-run·rollback · GET reverse-sync-list·auto-status —
//  와 그 화이트리스트 _ORDER_LEDGER_EDIT_FIELDS 는 2026-10-23 제거 · 결정 274. 표 reverse_sync_proposals 는 기록으로 남긴다.)

// (POST /order-flush-one — 주문 하나의 시트 큐 즉시 반영, 2026-10-22 제거 · 결정 273)

// 0-based 컬럼 인덱스 → A1 컬럼 문자(AA 등 지원)
function _a1col(idx) {
  let s = '', n = idx + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// POST /api/diag/review-reflect { sheetId, tabName, gid?, dryRun? } (admin/master)
// ★ 리뷰제출 DB→시트 검토·반영: review_index.is_submitted=TRUE 인데 시트 "리뷰제출" 칸이 빈 행을 찾아
//   채운다(빈 칸에만 '제출' 기록 — 기존 값 덮어쓰기 없음). dryRun=true(기본)면 미반영 건수만 보고.
//   배경: 리뷰제출은 시트에 전경 쓰기 + 실패 시 큐 폴백인데, throttle 포화로 일부가 시트 미반영일 수 있음.
router.post('/review-reflect', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, gid } = req.body || {};
    const dryRun = req.body?.dryRun !== false; // 기본 dryRun=true(안전)
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });

    // 1) DB에서 is_submitted=TRUE 행 + submit_col
    const { rows } = await pool.query(
      `SELECT row_index, submit_col FROM review_index
        WHERE sheet_id=$1 AND tab_name=$2 AND is_submitted=TRUE AND row_index IS NOT NULL
        ORDER BY row_index ASC`,
      [sheetId, tabName]
    );
    if (!rows.length) return res.json({ ok: true, dbSubmitted: 0, unreflected: 0 });

    // submit_col 최빈값(탭 내 일관)
    const cc = {};
    rows.forEach(r => { if (r.submit_col) cc[r.submit_col] = (cc[r.submit_col] || 0) + 1; });
    const entries = Object.entries(cc).sort((a, b) => b[1] - a[1]);
    const submitCol = entries.length ? entries[0][0] : null;
    if (!submitCol) return res.json({ ok: true, dbSubmitted: rows.length, unreflected: 0, note: 'submit_col 미상(인덱스 재빌드 필요)' });

    // 2) 헤더에서 컬럼 인덱스
    const { rows: tr } = await pool.query(
      `SELECT detected_headers, headers FROM raw_sheet_tabs WHERE sheet_id=$1 AND tab_gid=$2`,
      [sheetId, String(gid || '')]
    );
    const headers = tr[0] && (Array.isArray(tr[0].detected_headers) ? tr[0].detected_headers
                    : (Array.isArray(tr[0].headers) ? tr[0].headers : null));
    if (!headers) return res.json({ ok: false, error: '헤더 메타 없음(gid 확인 또는 RAW 재미러 필요)' });
    const colIdx = headers.findIndex(h => String(h || '').trim() === String(submitCol).trim());
    if (colIdx < 0) return res.json({ ok: false, error: `submit_col '${submitCol}' 헤더 미발견`, headers: headers.slice(0, 25) });
    const colL = _a1col(colIdx);

    // 3) 시트의 그 컬럼 읽기(min..max row, 1콜)
    const minR = rows[0].row_index, maxR = rows[rows.length - 1].row_index;
    const { throttledCall } = require('../utils/sheetsThrottle');
    const grid = await throttledCall(() => readSheet(sheetId, `'${tabName}'!${colL}${minR}:${colL}${maxR}`, gid ? { gid } : {}));

    // 4) 미반영(시트 칸 빈) 찾기
    const unref = [];
    for (const r of rows) {
      const row = grid && grid[r.row_index - minR];
      const cell = row ? String(row[0] || '').trim() : '';
      if (!cell) unref.push(r.row_index);
    }
    if (dryRun) {
      return res.json({ ok: true, dryRun: true, dbSubmitted: rows.length, submitCol, unreflected: unref.length, sampleRows: unref.slice(0, 20) });
    }

    // 5) 반영: 빈 칸에만 '제출' 일괄 기록(청크 50, batchUpdate 1콜/청크)
    let reflected = 0;
    if (unref.length) {
      const { batchUpdateSheet } = require('../services/sheets.service');
      for (let i = 0; i < unref.length; i += 50) {
        const data = unref.slice(i, i + 50).map(ri => ({ range: `'${tabName}'!${colL}${ri}`, values: [['제출']] }));
        await throttledCall(() => batchUpdateSheet(sheetId, data, 'RAW', gid ? { gid } : {}));
      }
      reflected = unref.length;
    }
    res.json({ ok: true, dryRun: false, dbSubmitted: rows.length, submitCol, reflected });
  } catch (err) { next(err); }
});

// (POST /order-orphan-cleanup · GET /order-batch-state · POST /order-batch-drain — 시트 큐 고아 정리·배치 스케줄러, 2026-10-22 제거 · 결정 273)

// (GET /throttle-monitor — 시트API 모니터 화면 전용, 2026-09-29 제거 · 결정 186 76번. getThrottleMonitor 는 sheetsThrottle 에 유지)

// ═══════════════════════════════════════════════════════════
// GET /api/diag/row-claims — 행 점유 원장(sheet_row_claims) 조회 (읽기전용 진단)
//   비연속 행배정(행 건너뜀) 원인 추적용: 어떤 행이 어떤 주문/출처(source)로 언제 점유됐는지 +
//   연결 주문의 상태·재배정횟수·에러를 함께 본다. query: sheetId, tabName, fromRow?, toRow?
// ═══════════════════════════════════════════════════════════
router.get('/row-claims', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const fromRow = parseInt(req.query.fromRow, 10) || 1;
    const toRow = parseInt(req.query.toRow, 10) || 1000000;
    const { rows } = await pool.query(
      `SELECT c.sheet_row AS "row", c.source, c.dedup_key AS "dedupKey", c.order_id AS "orderId",
              c.created_at AS "claimedAt", c.updated_at AS "updatedAt",
              os.orderer, os.mirror_status AS "mirrorStatus", os.sheet_row AS "orderSheetRow",
              os.reassign_count AS "reassignCount", os.sheet_error AS "sheetError",
              os.deleted_at AS "deletedAt", os.submitted_at AS "submittedAt"
         FROM sheet_row_claims c
         LEFT JOIN order_submissions os ON os.id = c.order_id
        WHERE c.sheet_id = $1 AND c.tab_name = $2 AND c.sheet_row BETWEEN $3 AND $4
        ORDER BY c.sheet_row`,
      [sheetId, tabName, fromRow, toRow]
    );
    res.json({ ok: true, count: rows.length, claims: rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/review-type-cleanup — 탭 설정 '리뷰타입' 칸의 옛 값 정리 (★ 087)
//
//   배경: 같은 `tab_configs.review_type` 칸을 두 어휘가 나눠 쓰고 있었다.
//     · 인트라넷 발주 폼 : 포토·텍스트·구매확정·별점·혼합   ← 리뷰 결과물의 형태
//     · 옛 탭 설정 팝오버: 실배송·빈박스·구매확정·믹스        ← 앞 둘은 사실 '배송유형'
//   087 에서 선택지를 인트라넷 목록으로 통일했고, 남아 있는 옛 값을 여기서 제자리에 돌려놓는다.
//     ① 실배송 / 빈박스 → `delivery_type` 으로 이관하고 리뷰타입 칸은 비운다
//     ② 믹스 → 혼합 (같은 뜻, 표기만 통일)
//
//   ★★ ①은 `delivery_type` 이 **비어 있을 때만** 옮긴다(blank-only).
//      접수(`/order/admin/accept`)가 작업오더에서 채워 넣은 배송유형을 덮으면 안 된다.
//      이미 값이 있으면 리뷰타입 칸만 비운다 — 배송 정보는 이미 제자리에 있으므로 잃을 게 없다.
//   ★ 자동 마이그레이션으로 돌리지 않은 이유: 기존 행을 건드리는 유일한 작업이라
//      **무엇이 몇 건 바뀌는지 사람이 먼저 보고** 실행해야 한다(기본 dryRun).
//   ★ 안 돌려도 안전하다 — 목록 밖 값은 `utils/reviewType` 판정에서 null 로 떨어져
//      "오늘 동작 그대로"가 되고, 화면에는 옛 값이 그대로 표시된다.
//
//   body: { dryRun? = true } — admin/master 전용.
// ═══════════════════════════════════════════════════════════
// (POST /api/diag/review-type-cleanup 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.reviewTypeCleanup = async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun !== false;   // 기본 미리보기

    // 무엇이 바뀔지 먼저 센다(dryRun·실행 공통 — 실행 후 결과와 대조할 수 있게)
    const { rows: preview } = await pool.query(
      `SELECT review_type,
              COUNT(*)::int AS cnt,
              COUNT(*) FILTER (WHERE COALESCE(delivery_type, '') = '')::int AS delivery_empty
         FROM tab_configs
        WHERE review_type IN ('실배송', '빈박스', '믹스')
        GROUP BY review_type
        ORDER BY review_type`
    );
    const total = preview.reduce((a, r) => a + r.cnt, 0);
    if (dryRun || total === 0) {
      return res.json({ ok: true, dryRun: true, total, preview,
        note: total === 0 ? '정리할 옛 값이 없습니다.'
                          : '실제 적용하려면 {dryRun:false} 로 다시 호출하세요.' });
    }

    // ① 실배송·빈박스 → 배송유형(비어 있을 때만) + 리뷰타입 칸 비우기
    const { rowCount: moved } = await pool.query(
      `UPDATE tab_configs
          SET delivery_type = CASE WHEN COALESCE(delivery_type, '') = '' THEN review_type
                                   ELSE delivery_type END,
              review_type   = ''
        WHERE review_type IN ('실배송', '빈박스')`
    );
    // ② 믹스 → 혼합
    const { rowCount: renamed } = await pool.query(
      `UPDATE tab_configs SET review_type = '혼합' WHERE review_type = '믹스'`
    );

    logger.info(`[review-type-cleanup] 배송유형 이관 ${moved}건 · 믹스→혼합 ${renamed}건`);
    res.json({ ok: true, dryRun: false, total, preview, moved, renamed });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════
// POST /api/diag/manager-cleanup — 담당자 칸에 남은 **실명**을 닉네임으로 정리 (★ 065 후속)
//
//   배경(2026-08-23 신고 — 담당자 칩이 만두/망고/박세희/박은비 넷으로 갈림):
//     065 **이전** 접수는 `tab_configs.manager` 에 담당AE 실명(manager_name·created_by)을
//     그대로 넣었다. 065 는 `work_orders` 에 컬럼만 추가했을 뿐 **백필이 없고**, 접수 업서트가
//     blank-only(`COALESCE(NULLIF(tab_configs.manager,''), …)`)라 재접수·차수 추가로도
//     영영 고쳐지지 않는다 → 실명 행이 그대로 남아 홈 작업목록 담당자 칩이 넷으로 갈렸다.
//     게다가 소비처는 전부 닉네임 리터럴 비교라(색 배지·🥟🥭·카카오 ID) 실명 행은 **조용히** 빠진다.
//
//   ★★ 판정은 `utils/workManager.mapWorkManager` **단일 출처**다 — SQL 에 이름을 박지 않는다.
//      그래서 표기 흔들림('박 세희'·'박은비(망고)')도 같은 규칙으로 접히고, 매핑에 사람이
//      늘면 이 창구가 자동으로 따라온다.
//   ★★ **매핑되는 값만** 바꾼다 — 모르는 이름(자유입력 담당자)은 손대지 않는다(빈 값으로
//      접으면 막으려던 것보다 큰 손실). 이미 닉네임인 행도 대상이 아니다.
//   ★ 쓰기 표면 = `manager` **한 칸**뿐. `updated_at` 도 건드리지 않는다 — 이 정리는 표기
//      통일이지 내용 변경이 아니라, 타임스탬프를 흔들면 그것을 tiebreak 로 쓰는 곳이 함께 움직인다.
//   ★ 기존 행을 건드리는 작업이라 **기본 dryRun**(리뷰타입 정리와 같은 규율) — 사람이 숫자를
//      먼저 보고 [적용하기]. 안 돌려도 안전하다(칩만 갈려 보일 뿐 동작은 종전 그대로).
//
//   body: { dryRun? = true } — admin/master 전용.
// ═══════════════════════════════════════════════════════════
/** 정리 대상 테이블 — 담당자 칸을 가진 곳. ★ 이름은 코드 안 리터럴이라 주입 여지가 없다. */
const MANAGER_TABLES = [
  { table: 'tab_configs',       label: '작업 탭 담당자' },   // 홈 작업목록 담당자 칩·필터의 재료
  { table: 'recruit_campaigns', label: '모집공고 담당자' },  // 공고 카드 🥟🥭·카카오 ID 매핑의 재료
];
// (POST /api/diag/manager-cleanup 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.managerCleanup = async (req, res, next) => {
  try {
    const { mapWorkManager } = require('../utils/workManager');
    const dryRun = req.body?.dryRun !== false;   // 기본 미리보기

    // 무엇이 바뀔지 먼저 센다(dryRun·실행 공통 — 실행 후 결과와 대조할 수 있게).
    //   ★ 판정을 SQL 로 옮기지 않는다: 값 목록을 가져와 **매핑 함수로** 고른다(사본 0).
    const preview = [];
    for (const t of MANAGER_TABLES) {
      const { rows } = await pool.query(
        `SELECT manager AS raw, COUNT(*)::int AS cnt
           FROM ${t.table}
          WHERE COALESCE(btrim(manager), '') <> ''
          GROUP BY manager
          ORDER BY manager`);
      for (const r of rows) {
        const nick = mapWorkManager(r.raw);
        if (!nick || nick === r.raw) continue;   // 매핑 밖 값·이미 닉네임 = 대상 아님
        preview.push({ table: t.table, label: t.label, from: r.raw, to: nick, cnt: r.cnt });
      }
    }
    const total = preview.reduce((a, r) => a + r.cnt, 0);
    if (dryRun || total === 0) {
      return res.json({ ok: true, dryRun: true, total, preview,
        note: total === 0 ? '정리할 실명 표기가 없습니다.'
                          : '실제 적용하려면 {dryRun:false} 로 다시 호출하세요.' });
    }

    let updated = 0;
    for (const p of preview) {
      // ★ 정확일치(`manager = $1`)로만 바꾼다 — 미리보기가 보여 준 그 값만 손댄다.
      const { rowCount } = await pool.query(
        `UPDATE ${p.table} SET manager = $2 WHERE manager = $1`, [p.from, p.to]);
      p.updated = rowCount;
      updated += rowCount;
    }
    logger.info(`[manager-cleanup] 담당자 표기 정리 ${updated}건 (${preview.map(p => `${p.table}:${p.from}→${p.to}`).join(' · ')})`);
    res.json({ ok: true, dryRun: false, total, preview, updated });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════
// POST /api/diag/delivery-type-cleanup — 배송유형 칸의 **옛 어휘**를 표준 6종으로 정리
//
//   배경(2026-08-24 사용자 확정): 배송유형 어휘가 화면마다 갈려 있었다 —
//     현행 모집공고 모달은 실배송·빈박스·택배발송대행인데, 인라인 공고수정 모달과
//     구형 관리자 화면은 `빈택배`·`회수건` 을 저장하고 있었다. 그렇게 저장된 값은
//     현행 모달 select 에 해당 option 이 없어 **다시 열면 빈 값으로 보이고, 아무것도
//     안 건드리고 저장만 눌러도 조용히 지워질 수 있다**(COALESCE 가 빈 문자열은 안 막는다).
//
//   ★★ 판정은 `utils/deliveryType.canonicalDeliveryValue` **단일 출처**다 — SQL 에 어휘를
//      박지 않는다. 그래서 표기 흔들림(`빈 택배`·`회수 건`)도 같은 규칙으로 접히고,
//      어휘가 늘면 이 창구가 자동으로 따라온다.
//   ★★ **접히는 값만** 바꾼다 — 모르는 값(`기타배송(박스)`)은 손대지 않는다(빈 값으로
//      접으면 막으려던 것보다 큰 손실). 이미 표준형인 행도 대상이 아니다.
//   ★★ **부속정보가 붙은 문장은 대상이 아니다** — `회수(회수택배사: …)` 는 원문이 곧 정보라
//      기본형으로 줄이면 회수택배사가 증발한다(canonicalDeliveryValue 가 원문을 그대로 돌려준다).
//   ★ 쓰기 표면 = `delivery_type` **한 칸**뿐. `updated_at` 도 건드리지 않는다 — 표기 통일이지
//      내용 변경이 아니라, 타임스탬프를 흔들면 그것을 tiebreak 로 쓰는 곳이 함께 움직인다.
//   ★ 기존 행을 건드리므로 **기본 dryRun**(담당자 표기 정리와 같은 규율) — 사람이 숫자를 먼저
//      보고 [적용하기]. 안 돌려도 안전하다(읽을 때 접어서 판정하므로 화면·판정은 이미 정상).
//
//   body: { dryRun? = true } — admin/master 전용.
// ═══════════════════════════════════════════════════════════
/** 정리 대상 — 배송유형 칸을 가진 표. ★ 이름은 코드 안 리터럴이라 주입 여지가 없다. */
const DELIVERY_TYPE_TABLES = [
  { table: 'tab_configs',       label: '작업 탭 배송유형' },
  { table: 'recruit_campaigns', label: '모집공고 배송유형' },
  { table: 'work_orders',       label: '작업오더 배송유형' },
];
// (POST /api/diag/delivery-type-cleanup 공개 경로는 삭제 — Track B 프록시가 이 핸들러를 이름으로 부른다 · 결정 270)
_handlers.deliveryTypeCleanup = async (req, res, next) => {
  try {
    const { canonicalDeliveryValue } = require('../utils/deliveryType');
    const dryRun = req.body?.dryRun !== false;   // 기본 미리보기

    const preview = [];
    for (const t of DELIVERY_TYPE_TABLES) {
      const { rows } = await pool.query(
        `SELECT delivery_type AS raw, COUNT(*)::int AS cnt
           FROM ${t.table}
          WHERE COALESCE(btrim(delivery_type), '') <> ''
          GROUP BY delivery_type
          ORDER BY delivery_type`);
      for (const r of rows) {
        const std = canonicalDeliveryValue(r.raw);
        if (!std || std === r.raw) continue;   // 판정 밖 값·이미 표준형·부속 문장 = 대상 아님
        preview.push({ table: t.table, label: t.label, from: r.raw, to: std, cnt: r.cnt });
      }
    }
    const total = preview.reduce((a, r) => a + r.cnt, 0);
    if (dryRun || total === 0) {
      return res.json({ ok: true, dryRun: true, total, preview,
        note: total === 0 ? '정리할 옛 배송유형 표기가 없습니다.'
                          : '실제 적용하려면 {dryRun:false} 로 다시 호출하세요.' });
    }

    let updated = 0;
    for (const p of preview) {
      // ★ 정확일치로만 바꾼다 — 미리보기가 보여 준 그 값만 손댄다.
      const { rowCount } = await pool.query(
        `UPDATE ${p.table} SET delivery_type = $2 WHERE delivery_type = $1`, [p.from, p.to]);
      p.updated = rowCount;
      updated += rowCount;
    }
    logger.info(`[delivery-type-cleanup] 배송유형 표기 정리 ${updated}건 (${preview.map(x => `${x.table}:${x.from}→${x.to}`).join(' · ')})`);
    res.json({ ok: true, dryRun: false, total, preview, updated });
  } catch (err) { next(err); }
};

// (POST·GET /queue-drain · GET /order-written-sample · GET /yellow-rows-export · POST /yellow-rows-delete ·
//  GET /build-history · POST /metrics/reset — 시트 시절 복구·확인 도구, 2026-10-22 제거 · 결정 273 · 결정 186 82번)

// ★ 결정 273 에서 남긴 것: 아래 order-stuck-export 는 주문 원장(DB)을 그대로 내려주는 유일한 "누가 취소했는지"
//   진단 창구라(orderCancelProvenance 가드) 무시트 작업에도 쓰인다 — 시트 도구와 함께 지우지 않았다.
// ═══════════════════════════════════════════════════════════
// GET /api/diag/order-stuck-export?sheetId&tabName[&includeWritten=true][&format=csv] — 제출된 구매양식(DB) 추출
//   서버 DB(order_submissions = 실제 제출된 구매양식)를 내려준다. 시트 미러가 아니라 원장 원본.
//   기본: 미반영(written 아님)만. includeWritten=true(또는 all=1): 그 탭 전 주문(반영분 포함).
//   format=csv: 엑셀/구글시트 붙여넣기용 CSV(UTF-8 BOM). PII 포함 → admin/master 전용. limit 기본 2000(최대 5000).
// ═══════════════════════════════════════════════════════════
router.get('/order-stuck-export', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const includeWritten = req.query.includeWritten === 'true' || req.query.all === '1';
    const limit = Math.min(parseInt(req.query.limit, 10) || 2000, 5000);
    const statusCond = includeWritten ? '' : ` AND os.mirror_status <> 'written'`;
    const { rows } = await pool.query(
      `SELECT os.id, os.mirror_status AS "mirrorStatus", os.sheet_row AS "sheetRow",
              os.orderer, os.recipient, os.user_id AS "userId", os.phone, os.address,
              os.bank, os.account, os.depositor, os.price,
              os.order_num AS "orderNum", os.date_str AS "dateStr",
              os.selected_opt_key AS "selectedOptKey", os.memo,
              os.sheet_written_at AS "writtenAt", os.submitted_at AS "submittedAt",
              /* 취소 내력(진단 전용) — "누가 왜 취소했나"를 API 밖에서 알 방법이 없어
                 canceled 주문을 만나면 원인 추적이 막다른 길이 됐다(2026-08-19 유재휘 건).
                 ★ JSON 응답에만 실린다 — 아래 CSV 는 head 목록으로 칸을 정하므로
                   직원 붙여넣기용 CSV 의 열 구성은 한 칸도 바뀌지 않는다. */
              os.canceled_by AS "canceledBy", os.deleted_at AS "deletedAt"
         FROM order_submissions os
        WHERE os.sheet_id = $1 AND os.tab_name = $2${statusCond}
        ORDER BY os.sheet_row ASC NULLS LAST, os.submitted_at ASC
        LIMIT $3`,
      [sheetId, tabName, limit]
    );

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const stMap = { written: '반영완료', queued: '미반영(대기)', failed: '미반영(실패)', pending: '미반영', pending_no_row: '미반영(행없음)', stuck_manual: '미반영(수동입력필요)' };
      const esc = (v) => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      // 제출시각을 한국시간(KST)으로 — sv-SE 로캘이 'YYYY-MM-DD HH:mm:ss' 형식을 준다.
      const fmtKST = (d) => {
        if (!d) return '';
        const dt = d instanceof Date ? d : new Date(d);
        if (isNaN(dt.getTime())) return String(d);
        try {
          return new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          }).format(dt);
        } catch (_) { return dt.toISOString(); }
      };
      const head = ['상태', '시트행', '구매일자', '주문자', '수취인', '네이버아이디', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '주문번호', '비고', '제출시각(KST)'];
      const lines = [head.map(esc).join(',')];
      for (const o of rows) {
        let memo = o.memo || '';
        if (o.selectedOptKey) memo = (memo ? memo + ' / ' : '') + '옵션:' + o.selectedOptKey;
        const line = [
          stMap[o.mirrorStatus] || o.mirrorStatus || '', o.sheetRow || '', o.dateStr || '', o.orderer || '',
          o.recipient || '', o.userId || '', o.phone || '', o.address || '', o.bank || '', o.account || '',
          o.depositor || '', o.price || '', o.orderNum || '', memo, fmtKST(o.submittedAt),
        ];
        lines.push(line.map(esc).join(','));
      }
      const csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM
      const asciiName = `orders_${String(tabName).replace(/[^\w.()-]+/g, '_').slice(0, 60) || 'tab'}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent('구매양식_' + tabName + '.csv')}`);
      return res.send(csv);
    }

    res.json({ ok: true, count: rows.length, includeWritten, items: rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/client-error — 프론트엔드 JS 에러 수집
// ═══════════════════════════════════════════════════════════
// ★ 화면 오류 수신 — **로그인한 사람만**(직원·광고주 로그인 토큰 또는 리뷰어 세션). 결정 208.
//   2026-05-13 무인증 쓰기를 막으려 authMiddleware 를 붙였는데 화면(api.js)은 토큰 없이 보내서
//   5개월간 전부 401(화면 오류가 한 건도 안 쌓임). 화면이 가진 로그인 정보를 붙여 보내고,
//   서버는 둘 중 하나만 맞으면 받는다. 익명은 계속 거절(가짜 오류로 기록 채우기 방지).
//   authMiddleware 를 그대로 쓰지 않는 이유: 인트라넷·광고주 토큰의 경로 제한(trackb 전용)에 걸려
//   3버전 직원 화면 오류가 계속 버려진다 — 기록용 입구라 로그인 확인만 한다.
function _clientErrorReporter(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (m) {
    try {
      const d = jwt.verify(m[1], process.env.JWT_SECRET);
      // isTrustedLoginToken — 리뷰어 공고수정 토큰(via reviewer_campaign, role admin 이지만 약한 신원)은 직원으로 치지 않는다(Codex P2).
      //   그런 리뷰어는 아래 X-Reviewer-Token 으로 'reviewer' 로 정확히 기록된다.
      if (isTrustedLoginToken(d)) return { kind: 'staff', role: d.role, via: d.via || '', name: String(d.name || '').slice(0, 60) };
    } catch (_) { /* 아래 리뷰어 세션으로 */ }
  }
  const rt = req.headers['x-reviewer-token'];
  if (rt) {
    try { const sess = verifyReviewerSession(rt); if (sess && sess.ownerReviewerId) return { kind: 'reviewer', reviewer: sess.ownerReviewerId }; } catch (_) {}
  }
  return null;
}
// 보내는 사람별 분당 상한 — 화면은 2초 간격·중복 제거로 보내므로 정상 사용은 한참 아래다(Codex P2: 기록 부풀리기 방지).
const _clientErrorLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  // 보내는 사람 구분은 전역 제한과 같은 단일 출처(rateIdentity — 서명된 brand_id·advertiser_id·iu·리뷰어 id 우선, Codex P2)
  keyGenerator: (req) => 'ce:' + require('../middleware/rateLimit.middleware').rateIdentity(req).key,
  message: { ok: false, error: '오류 보고가 너무 많습니다.' },
});
const _ceStr = (v, n) => (typeof v === 'string' ? v : (v == null ? '' : String(v))).slice(0, n);
const _ceNum = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
router.post('/client-error', (req, res, next) => {
  const reporter = _clientErrorReporter(req);
  if (!reporter) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
  req._ceReporter = reporter;
  next();
}, _clientErrorLimiter, async (req, res) => {
  const reporter = req._ceReporter;
  try {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    // ★ 모든 칸 길이 상한(Codex P2) — 화면이 보내는 모양(문자열·숫자)만 받는다.
    const message = _ceStr(b.message, 500), source = _ceStr(b.source, 300), page = _ceStr(b.page, 300);
    const stack = _ceStr(b.stack, 2000), userAgent = _ceStr(b.userAgent, 200);
    const lineno = _ceNum(b.lineno), colno = _ceNum(b.colno);
    logger.error({
      message: `[ClientError] ${message}`,
      source, lineno, colno, page,
      stack: (stack || '').substring(0, 500),
      ip: req.ip,
    });
    logAbnormal({
      flow: 'client', source: 'client', severity: 'warn',
      error: { message: message || 'client error', stack },
      context: { page, source, lineno, colno, ip: req.ip, userAgent: (userAgent || req.headers['user-agent'] || '').substring(0, 120), reporter },
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});


// ═══════════════════════════════════════════════════════════
// Phase 9: 통계/리포트 대시보드 API
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// GET /api/diag/no-capture-audit?days=3&limit=200 — "구매캡쳐 미첨부" 판정 실측 검증 (admin/master)
//
// 배경: order_no_capture 판정의 근거는 `order_submissions.capture_uploaded_at IS NULL` 하나뿐이고,
//   이 값을 채우는 유일한 경로가 제출 직후의 **fire-and-forget 비동기 업로드**(search-app.js)다.
//   그 업로드가 실패하거나(네트워크·타임아웃·Drive 오류 — catch에서 console.warn만 하고 삼킨다)
//   완료 전에 리뷰어가 창을 닫으면, **실제로는 첨부했는데 미첨부로 기록된다**.
//   DB만 봐서는 "안 올림"과 "올렸는데 연결 실패"를 구분할 수 없다 → Drive 실물과 대조해야 한다.
//
// 판정: 그 탭의 [구매캡처] 폴더(회차 하위폴더 포함)를 훑어 파일명(수취인[_주문자])이 일치하는 파일을 찾는다.
//   - attachedButUnlinked : 제출 시각 근처에 파일이 실제로 있음 → **오탐**(리뷰어는 첨부했음)
//   - notAttached         : 파일 없음 → 진짜 미첨부
//   - unknown             : 폴더 미연결·조회 실패 → 판정 보류(오판 금지)
// 읽기 전용(DB·Drive 쓰기 0). Drive는 탭당 1회 재귀 조회(drive lane).
// ═══════════════════════════════════════════════════════════
router.get('/no-capture-audit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    /* ★★ 판정은 `captureLinkBackfill.service` 한 곳이 소유한다 — 연결 백필이 **같은 함수**로
       후보를 고르므로 "감사에선 A 인데 백필은 B 를 붙이는" 상태가 구조적으로 불가능하다.
       응답 shape 은 종전 그대로(가산 필드 fileId/candidates/winCandidates 만 늘었다). */
    /* ★ 이 라우트의 상한은 종전 그대로(days 1..30 · limit 1..1000) — 기존 계약이고,
       그 값이 곧 탭당 재귀 Drive 조회량이다. 더 넓은 범위가 필요한 쪽은 백필 창구가 따로 있다. */
    const r = await captureLinkBackfill.auditCaptureLinks({
      days: Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 30),
      limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000),
      maxTabs: req.query.maxTabs,
    });
    if (!r.scanned) return res.json({ ok: true, days: r.days, scanned: 0, summary: {}, items: [] });

    const tally = (arr) => arr.reduce((a, x) => {
      a[x.verdict] = (a[x.verdict] || 0) + 1;
      if (x.verdict === 'attachedButUnlinked' && x.confidence === 'high') a.attachedHigh = (a.attachedHigh || 0) + 1;
      if (x.hasOpenLog) a.openLogs = (a.openLogs || 0) + 1;
      return a;
    }, {});
    const post = r.items.filter(x => !x.preCutoff);   // ← 판단은 이쪽만 보면 된다(실제 알림 대상)
    const pre = r.items.filter(x => x.preCutoff);
    res.json({
      ok: true, days: r.days, scanned: r.scanned, tabs: r.tabs, tabsSkipped: r.tabsSkipped,
      cutoff: r.cutoff,
      summary: tally(r.items),                      // 전체(하위호환)
      current: tally(post),                         // 연결기능 배포 이후 = 지금도 유효한 신호
      legacy: tally(pre),                           // 배포 이전 = 링크 코드가 없던 시절, 알림 안 나감
      note: r.cutoff
        ? '판단은 current 기준. legacy 는 캡처↔주문 연결 배포 이전 주문이라 미링크가 정상이며 알림 대상이 아님.'
        : '컷오프를 읽지 못해 구간 구분 없음(summary 만 유효).',
      items: r.items,
    });
  } catch (err) { next(err); }
});

// ★ 이름을 빼거나 바꾸면 trackB 가 기동 시 바로 실패한다(fail-closed) — 옛 공개 경로를 지워도 Track B 는 그대로다.
router.handlers = Object.freeze(_handlers);

module.exports = router;
