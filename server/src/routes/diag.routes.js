const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware, isTrustedLoginToken } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta } = require('../services/sheets.service');
const { getQueueStats, retryItem, retryAllFailed, purgeCompleted, deleteItem, deleteAllFailed, processQueue, drainTabQueue } = require('../services/syncQueue.service');
const { imageApiLimiter, imageUploadLimiter } = require('../middleware/rateLimit.middleware');
const captureLinkBackfill = require('../services/captureLinkBackfill.service');
const { extractOrderFromImage, verifyAddressMatch } = require('../services/gemini.service');
const driveService = require('../services/drive.service');
const { getMetricsSummary, resetMetrics } = require('../middleware/metrics.middleware');
const { isSentryEnabled } = require('../utils/sentry');
const { addClient, emitImageExtract, emitImageUpload } = require('../utils/sse');
const { logger } = require('../utils/logger');
const { slotLabel: slotLabelOf, effectiveCaptureSlots, isCashReceiptSlot } = require('../utils/captureSlots');
const { verifyCapture, logCaptureMismatch, resolveCaptureMismatch } = require('../services/captureVerify.service');
const { logAbnormal } = require('../services/errorLog.service');
const { buildOneSheet } = require('../services/indexBuilder.service');
const { allowManualRegister, REGISTER_GUIDE_MSG } = require('../utils/tabRegistration');
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

// ═══════════════════════════════════════════════════════════
// GET /api/diag/preview-tab — 탭 URL(gid 포함) 미리보기 (등록 전 확인용)
// query: { url }
// ★ v10.5: 모든 비시스템 탭을 조회하여 등록/미등록 상태를 각각 반환
// ═══════════════════════════════════════════════════════════
router.get('/preview-tab', authMiddleware, async (req, res, next) => {
  try {
    const { url } = req.query;
    if (!url) return res.json({ error: 'url이 필요합니다.' });

    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
    if (!sheetIdMatch) return res.json({ error: '유효한 구글 스프레드시트 URL이 아닙니다.' });
    const sheetId = sheetIdMatch[1];

    const gidMatch = url.match(/[#&]gid=(\d+)/);
    const targetGid = gidMatch ? gidMatch[1] : null;

    let meta;
    try {
      meta = await getSpreadsheetMeta(sheetId);
    } catch (metaErr) {
      const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
      return res.json({
        error: '시트 접근 권한이 없습니다. 서비스 계정을 편집자로 추가해주세요.',
        serviceAccount: sa,
      });
    }

    const spreadsheetTitle = meta._spreadsheetTitle || sheetId;

    // 시스템 탭 필터
    const systemTabs = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정',
                        '시트DB', '탭목록', 'tab_configs', '캠페인목록', '시트목록', '매크로', '서식', '요약', '대시보드', '템플릿', '양식'];

    // 모든 비시스템, 비숨김 탭 추출
    const allTabs = meta
      .filter(s => !systemTabs.includes(s.properties.title) && !s.properties.hidden)
      .map(s => ({
        name: s.properties.title,
        gid: String(s.properties.sheetId),
        url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${s.properties.sheetId}`,
      }));

    if (allTabs.length === 0) {
      return res.json({ error: '등록 가능한 탭이 없습니다 (시스템 탭 제외).' });
    }

    // targetGid가 있는 탭이 존재하는지 확인
    if (targetGid) {
      const found = allTabs.find(t => t.gid === targetGid);
      if (!found) {
        return res.json({ error: `gid=${targetGid}에 해당하는 탭을 찾을 수 없습니다.` });
      }
    }

    // DB에서 해당 시트의 모든 등록된 탭 조회 (차수 마감 정보 포함)
    // ★ tab_gid 포함 — 탭 이름이 변경돼도 gid로 동일 탭을 인식
    const { rows: registeredTabs } = await pool.query(
      'SELECT tab_name, tab_gid, is_closed, closed_rounds, archived_rounds FROM tab_configs WHERE sheet_id = $1',
      [sheetId]
    );
    const registeredSet = new Set(registeredTabs.map(r => r.tab_name));
    const closedInConfigSet = new Set(registeredTabs.filter(r => r.is_closed).map(r => r.tab_name));
    // ★ gid 기반 매핑 (탭 이름 변경 대응)
    const tcByName = new Map(registeredTabs.map(r => [r.tab_name, r]));
    const tcByGid = new Map(registeredTabs.filter(r => r.tab_gid).map(r => [String(r.tab_gid), r]));

    // 차수 마감/아카이브 정보 맵
    const roundInfoMap = {};
    for (const r of registeredTabs) {
      const closed = (r.closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      const archived = (r.archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
      if (closed.length > 0 || archived.length > 0) {
        roundInfoMap[r.tab_name] = { closedRounds: closed, archivedRounds: archived };
      }
    }

    // ★ 마감/아카이브된 탭 조회 (index_master_archive) — 이름 + gid 양쪽 매칭
    const { rows: archivedTabs } = await pool.query(
      'SELECT tab_name, tab_gid FROM index_master_archive WHERE sheet_id = $1',
      [sheetId]
    );
    const archivedSet = new Set(archivedTabs.map(r => r.tab_name));
    const archivedGidSet = new Set(archivedTabs.filter(r => r.tab_gid).map(r => String(r.tab_gid)));

    // 해당 시트의 인덱스 데이터 조회
    const { rows: indexRows } = await pool.query(
      'SELECT tab_name, row_count, submitted_count FROM index_master WHERE sheet_id = $1',
      [sheetId]
    );
    const indexMap = {};
    for (const ir of indexRows) {
      indexMap[ir.tab_name] = { rowCount: ir.row_count, submittedCount: ir.submitted_count };
    }

    // ★ 각 탭의 차수별 현황 조회 (review_index에서 고유 round 값 + 건수)
    const { rows: roundRows } = await pool.query(
      `SELECT tab_name, round,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE is_submitted = TRUE) AS submitted
       FROM review_index
       WHERE sheet_id = $1 AND round IS NOT NULL AND round != ''
       GROUP BY tab_name, round
       ORDER BY tab_name, round`,
      [sheetId]
    );
    const roundDataMap = {}; // tabName → [{round, total, submitted, status}]
    for (const rr of roundRows) {
      if (!roundDataMap[rr.tab_name]) roundDataMap[rr.tab_name] = [];
      const ri = roundInfoMap[rr.tab_name] || { closedRounds: [], archivedRounds: [] };
      let roundStatus = 'active';
      if (ri.archivedRounds.includes(rr.round)) roundStatus = 'archived';
      else if (ri.closedRounds.includes(rr.round)) roundStatus = 'closed';
      roundDataMap[rr.tab_name].push({
        round: rr.round,
        total: +rr.total,
        submitted: +rr.submitted,
        status: roundStatus,
      });
    }

    // ★ 아카이브된 차수도 review_index_archive에서 조회 (이미 review_index에 없는 차수)
    const { rows: archivedRoundRows } = await pool.query(
      `SELECT tab_name, round,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE is_submitted = TRUE) AS submitted
       FROM review_index_archive
       WHERE sheet_id = $1 AND round IS NOT NULL AND round != ''
       GROUP BY tab_name, round
       ORDER BY tab_name, round`,
      [sheetId]
    );
    for (const ar of archivedRoundRows) {
      if (!roundDataMap[ar.tab_name]) roundDataMap[ar.tab_name] = [];
      // 이미 있는 차수는 스킵 (review_index에 남아있는 경우)
      const existing = roundDataMap[ar.tab_name].find(x => x.round === ar.round);
      if (!existing) {
        roundDataMap[ar.tab_name].push({
          round: ar.round,
          total: +ar.total,
          submitted: +ar.submitted,
          status: 'archived',
        });
      }
    }

    // 차수 정렬 (숫자 기준)
    for (const tabName of Object.keys(roundDataMap)) {
      roundDataMap[tabName].sort((a, b) => {
        const numA = parseInt(a.round) || 0;
        const numB = parseInt(b.round) || 0;
        return numA - numB;
      });
    }

    // 각 탭에 등록 상태 추가 (등록됨 / 마감됨 / 신규)
    // ★ 이름 우선, 없으면 gid로 매칭 (구글시트에서 탭 이름이 변경된 경우 대응)
    const tabsWithStatus = allTabs.map(tab => {
      const tc = tcByName.get(tab.name) || tcByGid.get(String(tab.gid)) || null;
      const isRegistered = !!tc;
      const isClosed = !!(tc && tc.is_closed);
      const isArchived = archivedSet.has(tab.name) || archivedGidSet.has(String(tab.gid));
      // DB에 저장된 탭명 (이름이 바뀐 경우 인덱스/차수 조회는 DB 이름 기준)
      const dbName = tc ? tc.tab_name : tab.name;
      let status = 'new'; // 기본: 신규
      if (isRegistered && !isClosed) status = 'registered'; // 활성 등록
      else if (isRegistered && isClosed) status = 'closed';  // 마감 (tab_configs에 남아있음)
      else if (isArchived) status = 'archived'; // 아카이브됨 (tab_configs에서 삭제됨)
      return {
        ...tab,
        registered: isRegistered || isArchived,
        status,
        indexData: indexMap[dbName] || indexMap[tab.name] || null,
        rounds: roundDataMap[dbName] || roundDataMap[tab.name] || [],
      };
    });

    const newTabs = tabsWithStatus.filter(t => t.status === 'new');
    const existingTabs = tabsWithStatus.filter(t => t.status === 'registered');
    const closedTabs = tabsWithStatus.filter(t => t.status === 'closed' || t.status === 'archived');

    res.json({
      ok: true,
      sheetId,
      campaignName: spreadsheetTitle,
      // 기존 단일 탭 호환 필드 (targetGid에 해당하는 탭)
      tabName: targetGid ? (allTabs.find(t => t.gid === targetGid)?.name || allTabs[0].name) : allTabs[0].name,
      tabGid: targetGid || allTabs[0].gid,
      tabUrl: targetGid
        ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${targetGid}`
        : allTabs[0].url,
      // ★ 신규: 전체 탭 목록 + 등록 상태
      allTabs: tabsWithStatus,
      newTabs,
      existingTabs,
      closedTabs,
      totalTabCount: allTabs.length,
      newTabCount: newTabs.length,
      existingTabCount: existingTabs.length,
      closedTabCount: closedTabs.length,
      // 기존 호환
      alreadyRegistered: newTabs.length === 0,
      indexData: indexMap[targetGid ? (allTabs.find(t => t.gid === targetGid)?.name) : allTabs[0].name] || null,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/add-tab — 탭 URL(gid 포함)로 즉시 등록 + 인덱스 빌드
// body: { url } (예: https://docs.google.com/spreadsheets/d/xxx/edit#gid=123)
// ★ v10.5: 신규 탭만 tab_configs에 추가, 이미 등록된 탭은 스킵
// ═══════════════════════════════════════════════════════════
router.post('/add-tab', authMiddleware, async (req, res, next) => {
  try {
    // ★ 등록 단일경로 게이트: 신규 등록은 작업오더 접수로만 (TAB_REGISTRATION_MODE=manual로 일시 재개 가능)
    if (!allowManualRegister()) {
      return res.json({ ok: false, error: REGISTER_GUIDE_MSG, registrationLocked: true });
    }
    const { url } = req.body;
    if (!url) return res.json({ error: 'url이 필요합니다.' });

    // sheetId 추출
    const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
    if (!sheetIdMatch) return res.json({ error: '유효한 구글 스프레드시트 URL이 아닙니다.' });
    const sheetId = sheetIdMatch[1];

    // 1. 시트 메타 조회 → 캠페인명 + 전체 탭 확인
    let meta;
    try {
      meta = await getSpreadsheetMeta(sheetId);
    } catch (metaErr) {
      const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
      return res.json({
        error: '시트 접근 권한이 없습니다. 서비스 계정을 편집자로 추가해주세요.',
        serviceAccount: sa,
      });
    }

    const spreadsheetTitle = meta._spreadsheetTitle || sheetId;

    // 시스템 탭 필터
    const systemTabs = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정',
                        '시트DB', '탭목록', 'tab_configs', '캠페인목록', '시트목록', '매크로', '서식', '요약', '대시보드', '템플릿', '양식'];

    // 모든 비시스템, 비숨김 탭 추출
    const allTabs = meta
      .filter(s => !systemTabs.includes(s.properties.title) && !s.properties.hidden)
      .map(s => ({
        name: s.properties.title,
        gid: String(s.properties.sheetId),
      }));

    if (allTabs.length === 0) {
      return res.json({ error: '등록 가능한 탭이 없습니다.' });
    }

    // DB에서 이미 등록된 탭 목록 조회 (★ tab_gid 포함 — 탭 이름 변경 대응)
    const { rows: registeredTabs } = await pool.query(
      'SELECT tab_name, tab_gid FROM tab_configs WHERE sheet_id = $1',
      [sheetId]
    );
    const registeredSet = new Set(registeredTabs.map(r => r.tab_name));
    const registeredGidSet = new Set(registeredTabs.filter(r => r.tab_gid).map(r => String(r.tab_gid)));

    // ★ 마감/아카이브된 탭도 조회 (재등록 방지)
    const { rows: archivedTabs } = await pool.query(
      'SELECT tab_name, tab_gid FROM index_master_archive WHERE sheet_id = $1',
      [sheetId]
    );
    const archivedSet = new Set(archivedTabs.map(r => r.tab_name));
    const archivedGidSet = new Set(archivedTabs.filter(r => r.tab_gid).map(r => String(r.tab_gid)));

    // 신규 탭만 필터링 (등록됨 + 마감됨 모두 제외)
    // ★ 탭 이름(tab_name) + GID(tab_gid) 양쪽으로 매칭 — 구글시트에서 탭 이름이 변경돼도
    //   gid는 유지되므로, 마감/아카이브된 탭이 "신규"로 오인되어 재등록되는 것을 방지
    const newTabs = allTabs.filter(t =>
      !registeredSet.has(t.name) && !registeredGidSet.has(String(t.gid)) &&
      !archivedSet.has(t.name)   && !archivedGidSet.has(String(t.gid))
    );

    if (newTabs.length === 0) {
      return res.json({
        ok: true,
        sheetId,
        campaignName: spreadsheetTitle,
        message: '모든 탭이 이미 등록 또는 마감되어 있습니다. 신규 탭이 없습니다.',
        newTabCount: 0,
        totalTabCount: allTabs.length,
        registeredTabCount: registeredSet.size,
        archivedTabCount: archivedSet.size,
      });
    }

    // 2. campaigns 테이블에 시트 등록 (없으면 추가)
    await pool.query(
      `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET
         sheet_url = EXCLUDED.sheet_url, updated_at = NOW()`,
      [sheetId, spreadsheetTitle, `https://docs.google.com/spreadsheets/d/${sheetId}/edit`]
    );

    // 3. 신규 탭만 tab_configs에 UPSERT
    const addedTabs = [];
    for (const tab of newTabs) {
      const tabSheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${tab.gid}`;
      await pool.query(
        `INSERT INTO tab_configs (sheet_id, tab_name, campaign_name, sheet_url, tab_gid)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
           campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
           sheet_url = EXCLUDED.sheet_url,
           tab_gid = COALESCE(NULLIF(tab_configs.tab_gid,''), EXCLUDED.tab_gid),
           updated_at = NOW()`,
        [sheetId, tab.name, spreadsheetTitle, tabSheetUrl, tab.gid]
      );
      addedTabs.push(tab.name);
    }

    // 4. 즉시 인덱스 빌드 (해당 시트 전체)
    let buildResult = null;
    try {
      buildResult = await buildOneSheet(sheetId);
    } catch (buildErr) {
      logger.warn(`[add-tab] 인덱스 빌드 실패 (등록은 완료): ${buildErr.message}`);
      buildResult = { ok: false, error: buildErr.message };
    }

    // 5. 빌드 후 신규 탭들의 인덱스 데이터 확인
    const { rows: indexCheck } = await pool.query(
      'SELECT tab_name, row_count, submitted_count FROM index_master WHERE sheet_id = $1 AND tab_name = ANY($2)',
      [sheetId, addedTabs]
    );
    const indexDataMap = {};
    for (const row of indexCheck) {
      indexDataMap[row.tab_name] = { rowCount: row.row_count, submittedCount: row.submitted_count };
    }

    logger.info(`[add-tab] 신규 탭 등록 완료: ${spreadsheetTitle} / [${addedTabs.join(', ')}] (${addedTabs.length}개 신규, ${registeredSet.size}개 기존)`);

    res.json({
      ok: true,
      sheetId,
      campaignName: spreadsheetTitle,
      // 기존 호환 (첫 번째 신규 탭 정보)
      tabName: addedTabs[0],
      tabGid: newTabs[0].gid,
      tabUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${newTabs[0].gid}`,
      // ★ 신규: 추가된 탭 목록 정보
      addedTabs,
      addedTabCount: addedTabs.length,
      totalTabCount: allTabs.length,
      existingTabCount: registeredSet.size,
      indexDataMap,
      buildResult: buildResult ? { ok: buildResult.ok, rebuilt: buildResult.rebuilt, elapsed: buildResult.elapsed } : null,
      // 기존 호환
      indexData: indexDataMap[addedTabs[0]] || null,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// DELETE /api/diag/delete-campaign — 캠페인 삭제 (잘못 등록된 캠페인 제거)
// body: { sheetId, campaignName?, confirm?: boolean }
// confirm=false(기본)이면 삭제 영향 범위만 조회하여 반환 (dry-run)
// confirm=true이면 실제 삭제 수행
// ═══════════════════════════════════════════════════════════
router.delete('/delete-campaign', authMiddleware, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { sheetId, campaignName, confirm } = req.body;
    if (!sheetId) {
      return res.status(400).json({ error: 'sheetId가 필요합니다.' });
    }

    // 삭제 영향 범위 조회 (dry-run)
    const { rows: campRows } = await client.query(
      'SELECT campaign_name FROM campaigns WHERE sheet_id = $1', [sheetId]
    );
    const { rows: tabRows } = await client.query(
      'SELECT tab_name FROM tab_configs WHERE sheet_id = $1', [sheetId]
    );
    const { rows: masterRows } = await client.query(
      'SELECT tab_name, row_count, submitted_count FROM index_master WHERE sheet_id = $1', [sheetId]
    );
    const { rows: reviewCountRows } = await client.query(
      'SELECT count(*) as cnt FROM review_index WHERE sheet_id = $1', [sheetId]
    );

    const impact = {
      campaignName: campRows[0]?.campaign_name || '(알 수 없음)',
      tabCount: tabRows.length,
      tabs: tabRows.map(r => r.tab_name).slice(0, 20),
      indexMasterCount: masterRows.length,
      totalRows: masterRows.reduce((s, r) => s + (r.row_count || 0), 0),
      totalSubmitted: masterRows.reduce((s, r) => s + (r.submitted_count || 0), 0),
      reviewIndexCount: parseInt(reviewCountRows[0]?.cnt || '0', 10),
    };

    // confirm이 아니면 dry-run 결과만 반환
    if (!confirm) {
      return res.json({
        ok: true,
        dryRun: true,
        impact,
        message: `이 작업은 "${impact.campaignName}" 캠페인의 모든 데이터를 삭제합니다. (탭 ${impact.tabCount}개, 리뷰 인덱스 ${impact.reviewIndexCount}건) confirm:true로 재요청하면 실제 삭제됩니다.`,
      });
    }

    // 실제 삭제 수행
    await client.query('BEGIN');

    // 1. review_index 삭제
    const { rowCount: reviewDeleted } = await client.query(
      'DELETE FROM review_index WHERE sheet_id = $1', [sheetId]
    );

    // 2. index_master 삭제
    const { rowCount: masterDeleted } = await client.query(
      'DELETE FROM index_master WHERE sheet_id = $1', [sheetId]
    );

    // 3. tab_configs 삭제
    const { rowCount: tabDeleted } = await client.query(
      'DELETE FROM tab_configs WHERE sheet_id = $1', [sheetId]
    );

    // 4. campaigns 삭제
    const { rowCount: campDeleted } = await client.query(
      'DELETE FROM campaigns WHERE sheet_id = $1', [sheetId]
    );

    await client.query('COMMIT');

    logger.info(`[delete-campaign] 캠페인 삭제 완료: sheetId=${sheetId.substring(0,15)}... campaign=${campDeleted}, tabs=${tabDeleted}, master=${masterDeleted}, reviews=${reviewDeleted}`);
    res.json({
      ok: true,
      deleted: { campaigns: campDeleted, tabConfigs: tabDeleted, indexMaster: masterDeleted, reviewIndex: reviewDeleted },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[delete-campaign] 오류: ${err.message}`);
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/campaign-list — 캠페인 목록 조회 (GAS: campaignList)
// ═══════════════════════════════════════════════════════════
router.get('/campaign-list', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT sheet_id AS "sheetId", campaign_name AS "campaignName", sheet_url AS "sheetUrl"
      FROM campaigns
      ORDER BY campaign_name
    `);
    res.json({ ok: true, campaigns: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

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
    const result = await extractOrderFromImage(imageBase64, mimeType || 'image/jpeg', { samples: extractionSamples });
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
    res.json({ ...result, ...proof, productLabel });
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
    res.json({ ...failed, ...proof });
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
  try {
    const { imageBase64, mimeType, fileName, displayName, round,
            orderSubmissionId, captureSessionId, captureSessionToken } = req.body;
    if (!imageBase64) return res.json({ ok: false, error: '이미지 데이터가 필요합니다.' });

    // 구매캡처는 서버가 주문 응답으로 발급한 세션과 주문 ID가 모두 맞아야 한다.
    // 이름·최근시각 추정이나 클라이언트가 보낸 폴더 URL은 신뢰하지 않는다.
    const uploadCtx = await purchaseSessions.inspectForUpload({
      sessionId: captureSessionId,
      sessionToken: captureSessionToken,
      orderSubmissionId,
    });
    if (!uploadCtx.ok) {
      return res.status(403).json({ ok: false, code: uploadCtx.code, error: '구매캡처 제출 세션이 유효하지 않습니다. 구매양식을 다시 열어주세요.' });
    }
    if (uploadCtx.alreadyCompleted) {
      return res.json({ ok: true, alreadyCompleted: true, fileId: uploadCtx.captureFileId });
    }
    const claimed = await purchaseSessions.markUploading({ sessionId: captureSessionId, orderSubmissionId });
    if (!claimed) {
      return res.status(409).json({ ok: false, code: 'capture_upload_in_progress', retryable: true, error: '같은 구매캡처가 이미 업로드 중입니다.' });
    }
    const sheetId = uploadCtx.captureSheetId;
    const tabName = uploadCtx.captureTabName;

    const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      logger.warn('[image-upload] AI_REVIEW_FOLDER_ID 미설정');
      return res.json({ ok: false, error: 'Drive 루트 폴더가 설정되지 않았습니다. (AI_REVIEW_FOLDER_ID)' });
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

    // ── 3단계: 중복 파일 처리 (동일 이름 → 휴지통 이동) ──
    const rawName = String(fileName || '주문캡처.jpg');
    const dot = rawName.lastIndexOf('.');
    const baseName = (dot > 0 ? rawName.slice(0, dot) : rawName).slice(0, 80) || '주문캡처';
    const ext = (dot > 0 ? rawName.slice(dot + 1) : 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'jpg';
    // 같은 주문의 네트워크 재시도는 같은 파일명으로 수렴하고, 동명이인의 파일은 충돌하지 않는다.
    const finalFileName = `${baseName}__${String(orderSubmissionId).slice(0, 8)}_${String(captureSessionId).slice(0, 8)}.${ext}`;
    try {
      await driveService.trashDuplicateFile(targetFolderId, finalFileName);
    } catch (trashErr) {
      logger.warn(`[image-upload] 중복 파일 처리 실패 (무시): ${trashErr.message}`);
    }

    // ── 4단계: 파일 업로드 ──
    const uploaded = await driveService.uploadFileBase64(
      imageBase64, finalFileName, mimeType || 'image/jpeg', targetFolderId
    );

    logger.info(`[image-upload] 업로드 완료: ${uploaded.name} → ${uploaded.id}`);

    // ── 캡처↔주문 연결 — 세션+주문ID 정확일치, 주문 단위 직렬화 ──
    let finalLinkedFileId = uploaded.id;
    try {
      const linked = await purchaseSessions.completeCapture({
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
      }
    } catch (linkErr) {
      await purchaseSessions.markFailed({ sessionId: captureSessionId, orderSubmissionId, code: linkErr.code || 'db_link_failed' });
      logger.error(`[image-upload] 캡처↔주문 연결 실패: ${linkErr.message}`);
      return res.status(503).json({
        ok: false,
        code: 'capture_link_failed',
        retryable: true,
        error: '캡처 파일은 임시 저장됐지만 주문 연결에 실패했습니다. 다시 시도해주세요.',
      });
    }

    // ── SSE 알림 ──
    emitImageUpload({
      fileName: uploaded.name,
      fileId: finalLinkedFileId,
      tabName: tabName || '',
      displayName: displayName || '',
    });

    res.json({
      ok: true,
      fileId: finalLinkedFileId,
      alreadyCompleted: finalLinkedFileId !== uploaded.id,
      fileName: uploaded.name,
      webViewLink: uploaded.webViewLink || '',
      webContentLink: uploaded.webContentLink || '',
      captureFolderUrl: captureFolderUrl || '',
    });
  } catch (err) {
    await purchaseSessions.markFailed({
      sessionId: req.body && req.body.captureSessionId,
      orderSubmissionId: req.body && req.body.orderSubmissionId,
      code: err.code || 'upload_failed',
    });
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

// ═══════════════════════════════════════════════════════════
// Phase 2: Sync Queue 모니터링 엔드포인트
// ═══════════════════════════════════════════════════════════

// GET /api/diag/sync-queue — 큐 현황
router.get('/sync-queue', authMiddleware, async (req, res, next) => {
  try {
    const result = await getQueueStats();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/diag/sync-queue/retry — 특정 항목 재시도
router.post('/sync-queue/retry', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.body;
    if (id === 'all') {
      const result = await retryAllFailed();
      return res.json({ ok: true, ...result });
    }
    if (!id) return res.json({ error: 'id 필요' });
    const result = await retryItem(parseInt(id));
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/diag/sync-queue/purge — 완료 항목 정리
router.post('/sync-queue/purge', authMiddleware, async (req, res, next) => {
  try {
    const hours = parseInt(req.body.hours) || 24;
    const result = await purgeCompleted(hours);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// POST /api/diag/sync-queue/delete — 실패 항목 개별/일괄 삭제
router.post('/sync-queue/delete', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.body;
    if (id === 'all') {
      const result = await deleteAllFailed();
      return res.json({ ok: true, ...result });
    }
    if (!id) return res.json({ error: 'id 필요' });
    const result = await deleteItem(parseInt(id));
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/order-mirror-status — 구매주문 시트반영 현황(막힌 주문 가시성)
//   mirror_status 카운트 + 최근 막힌 주문 + 영향탭 롤업(hasRawMeta로 "먼저 RAW 미러 필요" 판단)
// ═══════════════════════════════════════════════════════════
router.get('/order-mirror-status', authMiddleware, async (req, res, next) => {
  try {
    const { rows: counts } = await pool.query(
      `SELECT mirror_status AS "mirrorStatus", COUNT(*)::int AS count
         FROM order_submissions GROUP BY mirror_status ORDER BY count DESC`
    );
    const { rows: stuck } = await pool.query(
      `SELECT os.id, os.sheet_id AS "sheetId", os.tab_name AS "tabName",
              tc.display_name AS "displayName",
              os.mirror_status AS "mirrorStatus", os.sheet_error AS "sheetError",
              os.submitted_at AS "submittedAt", os.queued_at AS "queuedAt",
              (rst.detected_headers IS NOT NULL) AS "hasRawMeta"
         FROM order_submissions os
         LEFT JOIN tab_configs tc ON tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
         LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id = os.sheet_id
              AND (rst.tab_gid = NULLIF(os.tab_gid, '') OR rst.tab_name = os.tab_name)
        WHERE os.mirror_status IN ('pending','pending_no_row','failed','queued','stuck_manual')
        ORDER BY os.submitted_at DESC
        LIMIT 50`
    );
    const { rows: byTab } = await pool.query(
      `SELECT os.sheet_id AS "sheetId", os.tab_name AS "tabName",
              COALESCE(MAX(NULLIF(os.tab_gid, '')), MAX(rst.tab_gid), MAX(tc.tab_gid)) AS "tabGid",
              MAX(tc.display_name) AS "displayName",
              COUNT(*)::int AS stuck,
              COUNT(*) FILTER (WHERE os.mirror_status = 'pending_no_row')::int AS "noRow",
              COUNT(*) FILTER (WHERE os.mirror_status = 'stuck_manual')::int AS "needManual",
              bool_or(rst.detected_headers IS NOT NULL) AS "hasRawMeta"
         FROM order_submissions os
         LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id = os.sheet_id
              AND (rst.tab_gid = NULLIF(os.tab_gid, '') OR rst.tab_name = os.tab_name)
         LEFT JOIN tab_configs tc ON tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
        WHERE os.mirror_status IN ('pending','pending_no_row','failed','queued','stuck_manual')
        GROUP BY os.sheet_id, os.tab_name
        ORDER BY stuck DESC LIMIT 500`
    );
    res.json({ ok: true, counts, byTab, stuck });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/order-reconcile — 막힌 주문 강제 복구(리컨실)
//   body: { sheetId?, limit?, dryRun? } — 시트 쓰기 유발이므로 admin/master 전용
// ═══════════════════════════════════════════════════════════
router.post('/order-reconcile', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { reconcileStuckOrders } = require('../services/orderLedger.service');
    const { withJobLock } = require('../utils/jobLock');
    const { sheetId, limit, dryRun } = req.body || {};
    const opts = {
      sheetId: sheetId || null,
      limit: Math.min(parseInt(limit, 10) || 100, 1000),
      perTabCap: sheetId ? 1000 : 20, // 시트 지정 강제복구는 탭 cap 해제(이벤트 일괄)
      dryRun: !!dryRun,
    };
    // ★ #1: dryRun(읽기전용 분류)은 락 불필요. 실제 복구는 cron/flush와 order_reconcile 락으로 직렬화.
    const r = opts.dryRun
      ? await reconcileStuckOrders(opts)
      : await withJobLock('order_reconcile', () => reconcileStuckOrders(opts));
    if (r && r.skipped) {
      return res.json({ ok: false, busy: true, error: '다른 reconcile(cron/flush)이 진행 중입니다. 잠시 후 다시 시도하세요.' });
    }
    res.json({ ok: true, ...r });
  } catch (err) {
    next(err);
  }
});

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

// ═══════════════════════════════════════════════════════════
// POST /api/diag/order-flush-tab — 특정 탭만 우선 시트반영(FIFO 우회, 백그라운드)
//   글로벌 큐는 created_at FIFO라 최근 캠페인 탭이 뒤로 밀린다. 이 엔드포인트는
//   ① 그 탭의 막힌 주문을 reconcile(탭 필터)로 enqueue → ② 그 탭의 order_append만 골라
//   즉시 드레인(throttle만 가드). 관리자 "이 캠페인 지금 반영" 용도. admin/master.
//   body: { sheetId, tabName, maxMillis?, untilEmpty? }
//   untilEmpty:true → 그 탭의 미반영(written 아님)이 0이 될 때까지 reconcile+drain 반복(하드캡 30분).
// ═══════════════════════════════════════════════════════════
let _flushTabRunning = false;
let _lastFlushTab = null;
async function _tabRemaining(sheetId, tabName) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM order_submissions
      WHERE sheet_id = $1 AND tab_name = $2 AND mirror_status <> 'written'`,
    [sheetId, tabName]
  );
  return rows[0] ? rows[0].c : 0;
}
router.post('/order-flush-tab', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    if (_flushTabRunning) return res.json({ ok: false, running: true, error: '다른 탭 우선반영이 진행 중입니다.', last: _lastFlushTab });
    const untilEmpty = req.body?.untilEmpty === true;
    const maxMillis = Math.min(Math.max(parseInt(req.body?.maxMillis, 10) || 60000, 2000), 180000);
    res.json({ ok: true, mode: 'async', untilEmpty, message: `'${tabName}' 우선 반영을 시작했습니다. 현황으로 확인하세요.`, maxMillis });

    _flushTabRunning = true;
    setImmediate(async () => {
      const start = Date.now();
      const HARD_CAP = 30 * 60 * 1000; // until-empty 안전 상한 30분
      let rounds = 0, totalReq = 0, totalDrained = 0, remaining = null;
      try {
        const { reconcileStuckOrders } = require('../services/orderLedger.service');
        const { withJobLock } = require('../utils/jobLock');
        do {
          rounds++;
          // ① 탭 단위로 막힌 주문 enqueue(행배정 포함). ★ #1: cron/인라인 reconcile과 order_reconcile 락으로 직렬화.
          const rec = await withJobLock('order_reconcile', () => reconcileStuckOrders({ sheetId, tabName, limit: 1000, perTabCap: 1000 }));
          const recSkipped = !!(rec && rec.skipped);
          const recRequeued = (rec && rec.requeued) || 0;
          totalReq += recRequeued;
          // ② 그 탭의 order_append만 우선 드레인(FIFO 우회). 큐 클레임(#2)으로 글로벌 워커와 비경합.
          const drainMs = untilEmpty ? 60000 : Math.max(maxMillis - (Date.now() - start), 2000);
          const drain = await drainTabQueue({ sheetId, tabName, maxMillis: drainMs });
          totalDrained += drain.succeeded || 0;
          remaining = await _tabRemaining(sheetId, tabName);
          _lastFlushTab = { sheetId, tabName, untilEmpty, rounds, totalRequeued: totalReq, totalDrained,
            remaining, running: true, elapsedMs: Date.now() - start };
          if (!untilEmpty) break;
          if (remaining === 0) break;
          // 이번 라운드에 아무 진전 없음 — 시트 반영 성공(succeeded) 기준으로 판정.
          //   (processed 기준이면 claim 후 전부 실패→pending 복원된 라운드도 '진전'으로 오인해
          //    같은 항목을 HARD_CAP까지 빠르게 재시도하며 쿼터를 낭비할 수 있음.)
          if ((drain.succeeded || 0) === 0 && recRequeued === 0) {
            // reconcile이 락 경합으로 양보됐을 뿐이면(다른 reconcile 진행 중) busy-spin 없이 잠깐 대기 후 재시도.
            if (recSkipped) { await new Promise(r => setTimeout(r, 5000)); continue; }
            break; // 진짜 진전 없음(메타없음 등 막힘) → 무한루프 방지 종료
          }
        } while (Date.now() - start < HARD_CAP);
        _lastFlushTab = { sheetId, tabName, untilEmpty, rounds, totalRequeued: totalReq, totalDrained,
          remaining, running: false, elapsedMs: Date.now() - start, finishedAt: new Date().toISOString() };
        logger.info(`[order-flush-tab] '${tabName}' 완료: rounds=${rounds}, drained=${totalDrained}, remaining=${remaining}, ${Date.now() - start}ms`);
      } catch (err) {
        _lastFlushTab = { sheetId, tabName, error: err.message, rounds, totalDrained, finishedAt: new Date().toISOString() };
        logger.error(`[order-flush-tab] '${tabName}' 오류: ${err.message}`);
      } finally {
        _flushTabRunning = false;
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/diag/order-flush-tab — 마지막 탭 우선반영 결과/진행 상태
router.get('/order-flush-tab', authMiddleware, async (req, res, next) => {
  try {
    res.json({ ok: true, running: _flushTabRunning, last: _lastFlushTab });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/order-relink — 탭 리네임으로 끊긴 막힌 주문을 현재 탭에 재연결
//   시트 탭 이름이 바뀌어(예: '…100건'→'…81건') gid 없이 저장된 주문이
//   현재 탭과 매칭되지 않아 영구 적체될 때, fromTabName 주문들의 tab_gid/tab_name을
//   현재 탭(toTabGid/toTabName)으로 backfill + sheet_row 초기화 → 이후 reconcile이
//   현재 탭 하단에 노란행으로 복구. 막힌(pending/pending_no_row/failed) 건만 대상.
//   body: { sheetId, fromTabName, toTabGid, toTabName?, toSheetId?, dryRun? } — admin/master 전용
//   toSheetId: sheet_id 자체가 손상된 주문(단축URL 혼입 등)을 올바른 시트로 이전할 때 사용.
// ═══════════════════════════════════════════════════════════
router.post('/order-relink', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, fromTabName, toTabGid, toTabName, toSheetId, dryRun } = req.body || {};
    if (!sheetId || !fromTabName || !toTabGid) {
      return res.status(400).json({ ok: false, error: 'sheetId, fromTabName, toTabGid 필수' });
    }
    const targetName = toTabName || fromTabName;
    const targetSheetId = toSheetId || sheetId;
    const { rows: cntRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM order_submissions
        WHERE sheet_id = $1 AND tab_name = $2
          AND deleted_at IS NULL
          AND mirror_status IN ('pending','pending_no_row','failed')`,
      [sheetId, fromTabName]
    );
    const matched = cntRows[0]?.cnt || 0;

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, matched, toSheetId: targetSheetId, toTabGid, toTabName: targetName });
    }

    // 1) 옛 탭명으로 남은 phantom claim 제거(있다면) — 현재 탭명 네임스페이스로 재claim 유도
    const { rowCount: claimsCleared } = await pool.query(
      `DELETE FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, fromTabName]
    );
    // 2) 막힌 주문을 현재 시트/탭으로 재연결 + 행 초기화(reconcile이 하단 append 재배정)
    const { rows: updated } = await pool.query(
      `UPDATE order_submissions
          SET sheet_id = $5, tab_gid = $3, tab_name = $4,
              sheet_row = NULL, mirror_status = 'pending_no_row', sheet_error = NULL
        WHERE sheet_id = $1 AND tab_name = $2
          AND deleted_at IS NULL
          AND mirror_status IN ('pending','pending_no_row','failed')
        RETURNING id`,
      [sheetId, fromTabName, String(toTabGid), targetName, targetSheetId]
    );
    res.json({ ok: true, matched, relinked: updated.length, claimsCleared, toSheetId: targetSheetId, toTabGid, toTabName: targetName });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 주문 원장(order ledger) PR-B — 인라인 편집/취소/수동추가/조회 (admin/master 전용)
//   쓰기 3종은 ORDER_LEDGER_WRITE_ENABLED='true'에서만 동작(롤링배포·점진 활성 게이트).
//   편집/취소는 per-order 락(order_ledger:<id>)로 DB UPDATE 직렬화 → 큐(order_update/order_cancel)로 in-place 시트반영.
// ═══════════════════════════════════════════════════════════
const _ORDER_LEDGER_EDIT_FIELDS = ['orderer','recipient','user_id','phone','address','bank','account','depositor','price','order_num','memo','date_str','selected_opt_key'];

// POST /api/diag/order-edit — 주문 필드 편집 → DB 즉시 + 큐(order_update) in-place 시트반영
router.post('/order-edit', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return res.status(503).json({ ok: false, error: 'order ledger 쓰기 비활성(ORDER_LEDGER_WRITE_ENABLED)' });
    const { orderSubmissionId } = req.body || {};
    const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
    if (!orderSubmissionId || !edits.length) return res.status(400).json({ ok: false, error: 'orderSubmissionId, edits 필수' });
    const clean = [];
    for (const e of edits) {
      if (!e || !_ORDER_LEDGER_EDIT_FIELDS.includes(e.field)) return res.status(400).json({ ok: false, error: `허용되지 않은 편집 필드: ${e && e.field}` });
      clean.push({ field: e.field, oldValue: e.oldValue == null ? '' : String(e.oldValue), newValue: e.newValue == null ? '' : String(e.newValue) });
    }
    const editSeq = Date.now(); // per-order 락 직렬화 하 단조(시트 stale 편집 무시 기준)
    const { withJobLock } = require('../utils/jobLock');
    const { enqueue } = require('../services/syncQueue.service');
    const out = await withJobLock('order_ledger:' + orderSubmissionId, async () => {
      const sets = clean.map((e, idx) => `${e.field} = $${idx + 2}`); // field는 화이트리스트라 인젝션 불가
      const vals = [orderSubmissionId, ...clean.map(e => e.newValue)];
      // 심판[치명1]: 편집 확정 즉시 last_edit_seq 단조증가(큐워커 지연 무관) → 무인 역동기가 이 편집을 stale로 인식·보존.
      const { rows } = await pool.query(
        `UPDATE order_submissions SET ${sets.join(', ')}, updated_at = NOW(),
                last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $${clean.length + 2})
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, mirror_status, sheet_id, tab_name, tab_gid, gid, sheet_row`,
        [...vals, editSeq]
      );
      if (!rows.length) return { notFound: true };
      /* ★★ 무시트 탭은 큐 대신 작업표에 바로 재기록한다 (2026-08-21 실측 결함 수정).
         종전엔 order_update 를 그대로 큐에 넣었는데 큐 실행부의 무시트 백스톱이 그 항목을
         "작업표 기록 경로가 담당"이라며 done 으로 삼켰고, **update 는 그 경로가 없어** 관리자
         주문 편집이 원장(DB)에만 남고 작업표 row_json·장부(검색·리뷰어 화면)에는 영영 반영되지
         않았다(조용한 소실). 실행부는 manualOrder ④ 와 같은 `writeOrderToWorktable` 한 벌 —
         기존 연결 행(order_submission_id)을 잠가 최신 DB 값으로 병합하고 장부까지 재생성한다.
         ★ 판정 실패·기록 실패는 종전 경로(enqueue) 폴백 — 백스톱이 삼키는 건 같지만 동작이
           조용히 나빠지지는 않고, 응답 `sheetlessApplied` 로 사실을 말한다(조용한 누락 금지). */
      const os = rows[0];
      let sheetlessApplied = null;
      let isSl = false;
      try { isSl = await require('../utils/sheetlessScope').isSheetless(pool, os.sheet_id, os.tab_name); } catch (_) { isSl = false; }
      if (isSl && os.sheet_row) {
        try {
          const { rows: full } = await pool.query(`SELECT * FROM order_submissions WHERE id = $1`, [orderSubmissionId]);
          const { _osRowToOrderData } = require('../services/orderLedger.service');
          sheetlessApplied = await require('../services/sheetlessOrder.service').writeOrderToWorktable({
            sheetId: os.sheet_id, tabName: os.tab_name, tabGid: os.tab_gid || os.gid || '',
            sheetRow: os.sheet_row, orderData: _osRowToOrderData(full[0]), orderSubmissionId,
          });
        } catch (e) { sheetlessApplied = { ok: false, reason: 'exception', message: e.message }; }
      }
      if (!sheetlessApplied || !sheetlessApplied.ok) {
        await enqueue('order_update', { orderSubmissionId, editSeq, edits: clean });
      }
      return { mirrorStatus: os.mirror_status, sheetlessApplied };
    });
    if (out && out.skipped) return res.status(409).json({ ok: false, error: '다른 편집/취소 진행 중 — 재시도하세요' });
    if (out && out.notFound) return res.status(404).json({ ok: false, error: '주문 없음 또는 이미 취소됨' });
    require('../jobs/queuePump').kickQueuePump();
    require('../utils/sse').emitOrderLedger({ action: 'edit', orderSubmissionId, mirror_status: out.mirrorStatus });
    res.json({ ok: true, queued: !(out.sheetlessApplied && out.sheetlessApplied.ok), editSeq, sheetlessApplied: out.sheetlessApplied || null });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// 시트→DB 역동기화(옵션·수동·기본 OFF) — 감지/조회/적용. (admin/master 전용)
//   SHEET_REVERSE_SYNC='1' 에서만 동작. 적대검증(레드→블루→심판) 최종설계 반영.
//   자동 무인 동기 없음: detect로 "제안" 생성 → 사람이 목록 검토 → apply로 명시 적용(order_update 위임).
// ═══════════════════════════════════════════════════════════

// POST /api/diag/reverse-sync-detect { sheetId, tabName, includeNullSig? } — 감지(읽기전용, 제안 생성)
router.post('/reverse-sync-detect', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.SHEET_REVERSE_SYNC !== '1') return res.status(403).json({ ok: false, error: '역동기화 비활성(SHEET_REVERSE_SYNC)' });
    const { sheetId, tabName, includeNullSig } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const { detectReverseSyncProposals } = require('../services/orderLedger.service');
    // 수동 트리거: throttle busy여도 1콜 기다려 실행(관리자 즉시 결과). cron은 ignoreBusy 미전달로 양보.
    const out = await detectReverseSyncProposals({ sheetId, tabName, includeNullSig: includeNullSig === true, ignoreBusy: true });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// GET /api/diag/reverse-sync-list?sheetId&tabName&status=open — 제안 목록(검토용)
router.get('/reverse-sync-list', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const status = ['open', 'applied', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
    const params = [status];
    const conds = ['status = $1'];
    if (req.query.sheetId) { params.push(req.query.sheetId); conds.push(`sheet_id = $${params.length}`); }
    if (req.query.tabName) { params.push(req.query.tabName); conds.push(`tab_name = $${params.length}`); }
    /* 종류 필터 — 화면 뱃지는 **손댈 수 있는 것만** 센다. `cancel_suspect` 는 설계상 영영 플래그로만
       남으므로(자동취소 금지) 함께 세면 "584건"처럼 손쓸 수 없는 숫자가 떠 담당자가 곧 무시하게 된다. */
    if (['edit', 'cancel_suspect'].includes(req.query.type)) {
      params.push(req.query.type); conds.push(`proposal_type = $${params.length}`);
    }
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const where = conds.join(' AND ');
    const { rows } = await pool.query(
      `SELECT id, os_id AS "osId", sheet_id AS "sheetId", tab_name AS "tabName", sheet_row AS "sheetRow",
              proposal_type AS "type", field, old_value AS "oldValue", new_value AS "newValue",
              status, detected_at AS "detectedAt", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
         FROM reverse_sync_proposals WHERE ${where}
        ORDER BY detected_at DESC LIMIT ${lim}`,
      params
    );
    /* ★★ `total` 은 **자르기 전** 개수다. 종전에는 `count: rows.length` 뿐이라 584건이 쌓여 있어도
       limit 만큼만 보였고, 호출부는 잘렸다는 사실 자체를 알 수 없었다(조용한 누락).
       COUNT 는 (status, proposal_type) 조건이라 인덱스를 타고, 뱃지가 limit=1 로 싸게 총계를 얻는다. */
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM reverse_sync_proposals WHERE ${where}`, params);
    const total = (cnt[0] && cnt[0].n) || 0;
    res.json({ ok: true, count: rows.length, total, truncated: total > rows.length, items: rows });
  } catch (err) { next(err); }
});

// POST /api/diag/reverse-sync-apply { proposalId } — edit 제안 적용(order_update 위임). cancel_suspect 거부.
router.post('/reverse-sync-apply', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.SHEET_REVERSE_SYNC !== '1') return res.status(403).json({ ok: false, error: '역동기화 비활성(SHEET_REVERSE_SYNC)' });
    if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return res.status(503).json({ ok: false, error: 'order ledger 쓰기 비활성(ORDER_LEDGER_WRITE_ENABLED)' });
    const { proposalId } = req.body || {};
    if (!proposalId) return res.status(400).json({ ok: false, error: 'proposalId 필수' });
    const { rows } = await pool.query(`SELECT * FROM reverse_sync_proposals WHERE id = $1 AND status = 'open'`, [proposalId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'not_found_or_resolved' });
    const p = rows[0];
    if (p.proposal_type === 'cancel_suspect') return res.status(409).json({ ok: false, error: 'cancel은 order-cancel 엔드포인트로 명시 처리하세요' }); // R4
    // G1: field 화이트리스트 재검증(인젝션/오염 방어).
    if (!_ORDER_LEDGER_EDIT_FIELDS.includes(p.field)) return res.status(400).json({ ok: false, error: `허용되지 않은 필드: ${p.field}` });

    const by = String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100);
    const editSeq = Date.now();
    const { withJobLock } = require('../utils/jobLock');
    const { enqueue } = require('../services/syncQueue.service');
    // R5/R7/G6: 기존 order-edit과 동일 per-order 락 + deleted_at + edit_seq 불변 검증 후 order_update 위임.
    const out = await withJobLock('order_ledger:' + p.os_id, async () => {
      const { rows: cur } = await pool.query(`SELECT last_edit_seq, deleted_at FROM order_submissions WHERE id = $1`, [p.os_id]);
      if (!cur.length || cur[0].deleted_at) return { stale: true };
      // G6: 감지 후 정식 편집/취소가 있었으면 stale → 거부(최신편집을 옛 시트값으로 덮음 방지).
      if (p.detected_edit_seq != null && Number(cur[0].last_edit_seq) !== Number(p.detected_edit_seq)) return { stale: true };
      const { rows: up } = await pool.query(
        `UPDATE order_submissions SET ${p.field} = $2, updated_at = NOW(),
                last_edit_seq = GREATEST(COALESCE(last_edit_seq, 0), $3)
           WHERE id = $1 AND deleted_at IS NULL RETURNING mirror_status`,     // field=화이트리스트라 인젝션 불가, 치명1: seq 단조증가
        [p.os_id, p.new_value, editSeq]
      );
      if (!up.length) return { stale: true };
      // ★ 같은 감지 묶음의 **형제 제안**을 살려 둔다.
      //   한 주문에 은행·계좌·예금주가 함께 어긋나면 detect 는 같은 detected_edit_seq·detected_sig 로
      //   제안을 여러 건 만든다(_replaceOpenProposalEdits — 실측 28건 중 세 칸이 모두 깨진 행이 있다).
      //   그런데 바로 위 UPDATE 가 last_edit_seq 를 올리므로 두 번째 제안부터는 G6 가 stale 로 보고
      //   **조용히 기각**해 버렸다 — 담당자가 세 칸을 다 고칠 방법이 없고, 못 고친 건은 목록에서 사라진다.
      //   G6 가 막으려는 것은 "감지 뒤 **다른** 편집이 끼어든 경우"다. 방금 우리가 만든 편집은
      //   같은 시트 읽기에서 나온 형제라 그 스냅샷을 무효화하지 않는다 → seq 만 이월한다.
      //   detected_sig 까지 같을 때만 이월한다(다른 감지 회차의 제안은 그대로 stale 로 남아야 한다).
      //   detected_edit_seq 가 null 인 제안은 애초에 G6 검사 대상이 아니므로 건드리지 않는다.
      if (p.detected_edit_seq != null) {
        await pool.query(
          `UPDATE reverse_sync_proposals SET detected_edit_seq = $3
             WHERE os_id = $1 AND id <> $2 AND status = 'open' AND proposal_type = 'edit'
               AND detected_edit_seq = $4
               AND detected_sig IS NOT DISTINCT FROM $5`,
          [p.os_id, p.id, editSeq, p.detected_edit_seq, p.detected_sig]
        );
      }
      await enqueue('order_update', { orderSubmissionId: p.os_id, editSeq, edits: [{ field: p.field, oldValue: p.old_value, newValue: p.new_value }] });
      return { mirrorStatus: up[0].mirror_status };
    });
    if (out && out.skipped) return res.status(409).json({ ok: false, error: '다른 편집/취소 진행 중 — 재시도하세요' });
    if (out && out.stale) {
      await pool.query(`UPDATE reverse_sync_proposals SET status='dismissed', resolved_at=NOW(), resolved_by=$2 WHERE id=$1`, [proposalId, by]);
      return res.status(409).json({ ok: false, error: 'stale_proposal_dismissed (감지 후 주문이 편집/취소됨)' });
    }
    await pool.query(`UPDATE reverse_sync_proposals SET status='applied', resolved_at=NOW(), resolved_by=$2 WHERE id=$1`, [proposalId, by]);
    require('../jobs/queuePump').kickQueuePump();
    res.json({ ok: true, applied: true, field: p.field, editSeq });
  } catch (err) { next(err); }
});

// POST /api/diag/reverse-sync-dismiss { proposalId } — 제안 기각(적용 안 함)
router.post('/reverse-sync-dismiss', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { proposalId } = req.body || {};
    if (!proposalId) return res.status(400).json({ ok: false, error: 'proposalId 필수' });
    const by = String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100);
    const { rowCount } = await pool.query(
      `UPDATE reverse_sync_proposals SET status='dismissed', resolved_at=NOW(), resolved_by=$2 WHERE id=$1 AND status='open'`,
      [proposalId, by]
    );
    res.json({ ok: true, dismissed: rowCount });
  } catch (err) { next(err); }
});

// ── 무인 자동적용(constrained auto-apply) — 강제 트리거/롤백/상태 (admin/master) ──
//   게이트는 서비스 내부(SHEET_REVERSE_SYNC=1·REVERSE_SYNC_AUTO=1·ORDER_LEDGER_WRITE_ENABLED=true).
//   평상시 cron이 자동 수행. 아래는 수동 강제/되돌리기/관측용.

// POST /api/diag/reverse-sync-auto-run { dryRun? } — 무인 사이클 즉시 실행(관리자 강제)
router.post('/reverse-sync-auto-run', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.SHEET_REVERSE_SYNC !== '1') return res.status(403).json({ ok: false, error: '역동기화 비활성(SHEET_REVERSE_SYNC)' });
    if (process.env.REVERSE_SYNC_AUTO !== '1') return res.status(403).json({ ok: false, error: '무인 자동적용 비활성(REVERSE_SYNC_AUTO)' });
    const dryRun = req.body && req.body.dryRun === true;
    if (dryRun) {
      // dryRun: detect는 건너뛰고 현재 open 제안에 대한 apply 시뮬레이션만(쓰기 없음).
      const { autoApplyReverseSync } = require('../services/orderLedger.service');
      const out = await autoApplyReverseSync({ dryRun: true });
      return res.json({ ok: true, dryRun: true, apply: out });
    }
    const { runReverseSyncAutoCycle } = require('../services/orderLedger.service');
    const out = await runReverseSyncAutoCycle({});
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// POST /api/diag/reverse-sync-rollback { proposalId | osId } — 자동적용 되돌리기(DB+시트 원복)
router.post('/reverse-sync-rollback', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return res.status(503).json({ ok: false, error: 'order ledger 쓰기 비활성(ORDER_LEDGER_WRITE_ENABLED)' });
    const { proposalId, osId } = req.body || {};
    if (!proposalId && !osId) return res.status(400).json({ ok: false, error: 'proposalId 또는 osId 필수' });
    const { rollbackAutoApplied } = require('../services/orderLedger.service');
    const out = await rollbackAutoApplied({ proposalId, osId });
    if (out && out.skipped) return res.status(409).json({ ok: false, error: '다른 편집 진행 중 — 재시도하세요' });
    if (!out || !out.rolledBack) return res.status(404).json({ ok: false, error: (out && out.reason) || 'not_found' });
    require('../jobs/queuePump').kickQueuePump();
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

// GET /api/diag/reverse-sync-auto-status — 무인 자동적용 상태/집계(관측)
router.get('/reverse-sync-auto-status', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { autoApplyReverseSync } = require('../services/orderLedger.service');
    // 심판[중대3]: dryRun은 ORDER_LEDGER_WRITE_ENABLED 게이트를 건너뛰므로, 쓰기 OFF에서 관측용 GET이
    //   시트 라이브읽기(쿼터 소모)를 하지 않도록 프리뷰는 쓰기게이트 ON일 때만.
    const dry = (process.env.ORDER_LEDGER_WRITE_ENABLED === 'true')
      ? await autoApplyReverseSync({ dryRun: true })
      : { skipped: true, reason: 'ledger_write_disabled_preview_off' };
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='open'  AND proposal_type='edit')          AS open_edits,
         COUNT(*) FILTER (WHERE status='open'  AND proposal_type='cancel_suspect') AS open_cancel_suspects,
         COUNT(*) FILTER (WHERE status='applied' AND auto_applied=TRUE)            AS auto_applied_total,
         COUNT(*) FILTER (WHERE status='applied' AND auto_applied=TRUE AND resolved_at > NOW() - INTERVAL '24 hours') AS auto_applied_24h
       FROM reverse_sync_proposals`
    );
    res.json({
      ok: true,
      gates: {
        SHEET_REVERSE_SYNC: process.env.SHEET_REVERSE_SYNC === '1',
        REVERSE_SYNC_AUTO: process.env.REVERSE_SYNC_AUTO === '1',
        ORDER_LEDGER_WRITE_ENABLED: process.env.ORDER_LEDGER_WRITE_ENABLED === 'true',
      },
      safeFields: require('../services/orderLedger.service')._autoSafeFields(),
      counts: rows[0],
      dryRunPreview: dry,
    });
  } catch (err) { next(err); }
});


router.post('/order-cancel', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return res.status(503).json({ ok: false, error: 'order ledger 쓰기 비활성' });
    const { orderSubmissionId } = req.body || {};
    if (!orderSubmissionId) return res.status(400).json({ ok: false, error: 'orderSubmissionId 필수' });
    const { cancelOrderSubmission } = require('../services/orderCancellation.service');
    const out = await cancelOrderSubmission({
      orderSubmissionId,
      canceledBy: String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100),
    });
    res.status(out.ok ? 200 : (out.code === 'concurrent_cancel' ? 409 : 400)).json(out);
  } catch (err) { next(err); }
});

// POST /api/diag/order-manual-add — 수동 주문추가(원자 INSERT, source=manual, osid dedup, 하단 노란행 append)
router.post('/order-manual-add', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return res.status(503).json({ ok: false, error: 'order ledger 쓰기 비활성' });
    const { sheetId, tabName, gid, phone } = req.body || {};
    const od = (req.body && req.body.orderData) || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    if (!gid) return res.status(400).json({ ok: false, error: 'gid 필수(동명탭 오배정 방지)' });
    const { loadRawTabContext, buildCandidateRows, claimRow, markOrderQueued } = require('../services/orderLedger.service');
    const { enqueue } = require('../services/syncQueue.service');
    const { emitOrderLedger } = require('../utils/sse');
    const odPhone = phone || od.phone || '';
    const { rows: ins } = await pool.query(
      `INSERT INTO order_submissions
         (sheet_id, tab_name, gid, tab_gid, orderer, recipient, user_id, phone, address, bank, account,
          depositor, price, order_num, date_str, selected_opt_key, memo, source, mirror_status, submitted_at)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'manual','pending',NOW())
       RETURNING id`,
      [sheetId, tabName, String(gid), od.orderer||'', od.recipient||'', od.userId||'', odPhone, od.address||'',
       od.bank||'', od.account||'', od.depositor||'', od.price||'', od.orderNum||'', od.dateStr||'', od.selectedOptKey||'', od.memo||'']
    );
    const orderId = ins[0].id;
    const dedupKey = 'osid:' + orderId;
    await pool.query(`UPDATE order_submissions SET dedup_key = $2 WHERE id = $1`, [orderId, dedupKey]);
    const odForMap = { orderer: od.orderer||'', recipient: od.recipient||'', userId: od.userId||'', phone: odPhone,
      address: od.address||'', bank: od.bank||'', account: od.account||'', depositor: od.depositor||'',
      price: od.price||'', orderNum: od.orderNum||'', dateStr: od.dateStr||'', selectedOptKey: od.selectedOptKey||'', memo: od.memo||'' };

    const tabContext = await loadRawTabContext(sheetId, String(gid), tabName);
    if (!tabContext || !tabContext.headers || !tabContext.headers.length) {
      await pool.query(`UPDATE order_submissions SET mirror_status='pending_no_row' WHERE id=$1`, [orderId]);
      emitOrderLedger({ action: 'created', orderSubmissionId: orderId, mirror_status: 'pending_no_row' });
      return res.json({ ok: true, orderSubmissionId: orderId, mirrorStatus: 'pending_no_row', note: 'RAW 메타 없음 — reconcile가 흡수' });
    }
    if (tabContext.tabName && tabContext.tabName !== tabName) { // R9: stale gid 오탭 방지
      await pool.query(`UPDATE order_submissions SET mirror_status='pending_no_row', sheet_error='gid/tabName 불일치' WHERE id=$1`, [orderId]);
      return res.status(400).json({ ok: false, error: `gid가 다른 탭(${tabContext.tabName})을 가리킵니다`, orderSubmissionId: orderId });
    }
    const candidateRows = buildCandidateRows({ headers: tabContext.headers, dataRows: tabContext.dataRows, headerRowIndex: tabContext.headerRowIndex, orderData: odForMap, appendOnly: true });
    const client = await pool.connect();
    let claim = { row: null };
    try {
      await client.query('BEGIN');
      claim = await claimRow({ client, sheetId, tabGid: tabContext.tabGid || String(gid), tabName, dedupKey, candidateRows, orderId, meta: { name: od.orderer || od.recipient || '', phone: odPhone, source: 'manual' } });
      await client.query(
        `UPDATE order_submissions SET sheet_row = $2::int, tab_gid = COALESCE(NULLIF($3,''), tab_gid),
            mirror_status = CASE WHEN $2::int IS NULL THEN 'pending_no_row' ELSE 'pending' END WHERE id = $1`,
        [orderId, claim.row || null, tabContext.tabGid || String(gid)]
      );
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} client.release(); throw e; }
    client.release();
    if (claim.row) {
      await enqueue('order_append', { sheetId, tabName, gid: tabContext.tabGid || String(gid), orderData: odForMap, orderSubmissionId: orderId, sheetRow: claim.row, dedupKey, loginPhone8: '', loginName: '', recovered: true });
      await markOrderQueued(orderId);
      require('../jobs/queuePump').kickQueuePump();
      emitOrderLedger({ action: 'created', orderSubmissionId: orderId, mirror_status: 'queued' });
      return res.json({ ok: true, orderSubmissionId: orderId, sheetRow: claim.row, mirrorStatus: 'queued' });
    }
    emitOrderLedger({ action: 'created', orderSubmissionId: orderId, mirror_status: 'pending_no_row' });
    res.json({ ok: true, orderSubmissionId: orderId, mirrorStatus: 'pending_no_row', note: '행 배정 실패 — reconcile가 흡수' });
  } catch (err) { next(err); }
});

// POST /api/diag/order-flush-one — 특정 주문의 pending 큐항목(append/update/cancel)을 즉시 반영(FIFO 우회).
//   글로벌 큐 백로그 시 편집/취소가 밀리므로 "이 주문만 지금 반영". 동기 실행(항목 소수, throttle 가드).
router.post('/order-flush-one', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { orderSubmissionId } = req.body || {};
    if (!orderSubmissionId) return res.status(400).json({ ok: false, error: 'orderSubmissionId 필수' });
    const { drainOrderQueue } = require('../services/syncQueue.service');
    const r = await drainOrderQueue(orderSubmissionId, { maxItems: 5 });
    res.json({ ok: true, ...r });
  } catch (err) { next(err); }
});

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

// POST /api/diag/order-orphan-cleanup { dryRun? } (admin/master)
// ★ 고아 큐 정리: written/deleted된 주문의 잔여 pending/processing order_append를 시트콜 0으로 done 처리.
//   reconcile 재큐잉이 남긴 고아가 throttle를 반복 잠식하던 것을 1회성으로 청소. dryRun=true면 카운트만.
//   (공정화 #3 dup-guard가 신규 고아 발생을 막으므로 이건 기존 잔량 정리용.)
router.post('/order-orphan-cleanup', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun !== false; // 기본 dryRun=true(안전)
    const sel = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sync_queue sq
        WHERE sq.type = 'order_append' AND sq.status IN ('pending','processing')
          AND EXISTS (SELECT 1 FROM order_submissions os
                       WHERE os.id::text = (sq.payload->>'orderSubmissionId')
                         AND (os.mirror_status = 'written' OR os.deleted_at IS NOT NULL))`
    );
    const orphanCount = sel.rows[0].n;
    if (dryRun) return res.json({ ok: true, dryRun: true, orphanCount });
    const upd = await pool.query(
      `UPDATE sync_queue sq SET status='done', processed_at=NOW(), error_msg='orphan_cleanup'
        WHERE sq.type = 'order_append' AND sq.status IN ('pending','processing')
          AND EXISTS (SELECT 1 FROM order_submissions os
                       WHERE os.id::text = (sq.payload->>'orderSubmissionId')
                         AND (os.mirror_status = 'written' OR os.deleted_at IS NOT NULL))`
    );
    res.json({ ok: true, dryRun: false, cleaned: upd.rowCount });
  } catch (err) { next(err); }
});

// (GET /throttle-monitor — 시트API 모니터 화면 전용, 2026-09-29 제거 · 결정 186 76번. getThrottleMonitor 는 sheetsThrottle 에 유지)

// GET /api/diag/order-batch-state — 배치 스케줄러 내부상태 + 사이클 이력(인터리브 기아 디버그)
router.get('/order-batch-state', authMiddleware, async (req, res, next) => {
  try {
    const { getDiag } = require('../jobs/orderBatchScheduler');
    res.json({ ok: true, ...getDiag() });
  } catch (err) { next(err); }
});

// POST /api/diag/order-batch-drain { sheetId, tabName, maxMillis? } (admin/master)
// ★ 빈 시트 버스트 전용: 한 탭을 가드 batchGet 1콜 + batchUpdate 1콜(청크당)로 빠르게 반영.
//   ORDER_BATCH_DRAIN=1 일 때만 배치 경로, 아니면 drainTabQueueBatched가 단건 drainTabQueue로 폴백.
//   비차단(즉시 응답 + 백그라운드 실행). 진행/결과는 order-mirror-status·서버 로그로 관찰.
router.post('/order-batch-drain', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, sync } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    const flag = process.env.ORDER_BATCH_DRAIN === '1' ? 'batch' : 'single(fallback)';
    const { drainTabQueueBatched } = require('../services/syncQueue.service');
    // sync 모드: 결과를 동기 반환(진단·소량). maxMillis 25s 상한(HTTP 타임아웃 회피).
    if (sync) {
      const maxMillis = Math.min(Math.max(parseInt(req.body?.maxMillis, 10) || 20000, 2000), 25000);
      try {
        const r = await drainTabQueueBatched({ sheetId, tabName, maxMillis });
        return res.json({ ok: true, mode: 'sync', flag, result: r });
      } catch (e) {
        return res.json({ ok: false, mode: 'sync', flag, error: String(e && e.message), stack: String(e && e.stack).split('\n').slice(0, 4) });
      }
    }
    const maxMillis = Math.min(Math.max(parseInt(req.body?.maxMillis, 10) || 60000, 2000), 180000);
    res.json({ ok: true, mode: 'async', message: '배치 드레인 시작', flag });
    setImmediate(async () => {
      try {
        const r = await drainTabQueueBatched({ sheetId, tabName, maxMillis });
        console.log('[order-batch-drain] 완료:', JSON.stringify(r));
      } catch (e) {
        console.error('[order-batch-drain] 실패:', e.message);
      }
    });
  } catch (err) { next(err); }
});

// GET /api/diag/order-ledger — 원장 그리드(keyset 커서, PII는 admin/master만). 읽기 전용(flag 무관).
router.get('/order-ledger', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const where = []; const params = [];
    if (!(req.query.includeCanceled === 'true' || req.query.includeCanceled === '1')) where.push('deleted_at IS NULL');
    if (req.query.sheetId) { params.push(req.query.sheetId); where.push(`sheet_id = $${params.length}`); }
    if (req.query.tabName) { params.push(req.query.tabName); where.push(`tab_name = $${params.length}`); }
    if (req.query.mirrorStatus) { params.push(req.query.mirrorStatus); where.push(`mirror_status = $${params.length}`); }
    if (req.query.q) { params.push('%' + String(req.query.q) + '%'); const i = params.length; where.push(`(orderer ILIKE $${i} OR recipient ILIKE $${i} OR phone ILIKE $${i} OR order_num ILIKE $${i})`); }
    if (req.query.cursor) { // keyset: "<submitted_at_iso>|<id>"
      const [cAt, cId] = String(req.query.cursor).split('|');
      params.push(cAt); const a = params.length; params.push(cId); const b = params.length;
      where.push(`(submitted_at, id) < ($${a}::timestamptz, $${b}::uuid)`);
    }
    const sql = `SELECT id, sheet_id AS "sheetId", tab_name AS "tabName", orderer, recipient, user_id AS "userId",
            phone, address, bank, account, depositor, price, order_num AS "orderNum", date_str AS "dateStr",
            selected_opt_key AS "selectedOptKey", memo, mirror_status AS "mirrorStatus", sheet_row AS "sheetRow",
            sheet_error AS "sheetError", source, deleted_at AS "deletedAt", last_edit_seq AS "lastEditSeq",
            submitted_at AS "submittedAt",
            (SELECT jsonb_build_object('id',sq.id,'status',sq.status,'attempts',sq.attempts,'maxRetry',sq.max_retry)
               FROM sync_queue sq
              WHERE sq.payload->>'orderSubmissionId'=order_submissions.id::text
                AND sq.type IN ('workboard_apply','workboard_legacy_apply')
              ORDER BY sq.created_at DESC LIMIT 1) AS queue
       FROM order_submissions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY submitted_at DESC, id DESC LIMIT ${lim + 1}`;
    const { rows } = await pool.query(sql, params);
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? `${new Date(last.submittedAt).toISOString()}|${last.id}` : null;
    res.json({ ok: true, rows: page, nextCursor, count: page.length });
  } catch (err) { next(err); }
});

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
router.post('/review-type-cleanup', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
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
});

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
router.post('/manager-cleanup', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
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
});

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
router.post('/delivery-type-cleanup', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
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
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/queue-drain — 백로그 가속 드레인(선택적·온디맨드, 백그라운드)
//   평상시 큐워커는 항목당 2초 안전대기(쿼터 보수)로 ~20/분. 이 엔드포인트는 그 대기를
//   0으로 두고 sheetsThrottle(45/분)만 가드로 삼아 더 빨리 빼낸다. throttle 때문에 한 배치가
//   길어질 수 있어 **백그라운드 실행 후 즉시 응답**(HTTP 타임아웃 방지) — 진행은 큐/현황으로 관찰.
//   body: { maxMillis?, batchSize? } — admin/master 전용. 라이브 이벤트 중엔 사용 자제.
// ═══════════════════════════════════════════════════════════
let _queueDrainRunning = false;
let _lastQueueDrain = null;
router.post('/queue-drain', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (_queueDrainRunning) {
      return res.json({ ok: false, running: true, error: '가속 드레인이 이미 진행 중입니다.', last: _lastQueueDrain });
    }
    const maxMillis = Math.min(Math.max(parseInt(req.body?.maxMillis, 10) || 60000, 2000), 180000);
    const batchSize = Math.min(Math.max(parseInt(req.body?.batchSize, 10) || 20, 1), 50);
    res.json({ ok: true, mode: 'async', message: '가속 드레인을 시작했습니다. 현황/큐로 진행을 확인하세요.', maxMillis, batchSize });

    _queueDrainRunning = true;
    setImmediate(async () => {
      const start = Date.now();
      let rounds = 0, processed = 0, succeeded = 0, failed = 0;
      try {
        const { withJobLock } = require('../utils/jobLock');
        // ★ R6: 펌프(queuePump)와 동일 advisory lock에 합류 — 펌프·관리자 가속드레인이 동시에
        //   시트를 드레인해 throttle를 3중 경쟁하지 않도록 동시 1개만 가동. 펌프가 락 보유 중이면
        //   여기선 즉시 양보(펌프가 이미 처리 중). flush-tab은 별 집합(drainTabQueue)이라 합류 제외.
        const lockResult = await withJobLock('queue_pump_drain', async () => {
          while (Date.now() - start < maxMillis) {
            const r = await processQueue(batchSize, { interItemDelayMs: 0 });
            rounds++;
            processed += r.processed || 0;
            succeeded += r.succeeded || 0;
            failed += r.failed || 0;
            if ((r.processed || 0) === 0) break; // 큐 비었음
            if (r.quotaExceeded) break;           // quota → cron 백오프에 양보
          }
        });
        const skipped = !!(lockResult && lockResult.skipped);
        _lastQueueDrain = { rounds, processed, succeeded, failed, skipped, elapsedMs: Date.now() - start, finishedAt: new Date().toISOString() };
        logger.info(`[queue-drain] 완료: rounds=${rounds}, processed=${processed}, succeeded=${succeeded}, failed=${failed}${skipped ? ' (펌프 가동 중 — 양보)' : ''}, ${Date.now() - start}ms`);
      } catch (err) {
        _lastQueueDrain = { error: err.message, finishedAt: new Date().toISOString() };
        logger.error(`[queue-drain] 오류: ${err.message}`);
      } finally {
        _queueDrainRunning = false;
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/diag/queue-drain — 마지막 가속 드레인 결과/진행 상태
router.get('/queue-drain', authMiddleware, async (req, res, next) => {
  try {
    const { rows: pend } = await pool.query(
      `SELECT COUNT(*)::int AS remaining FROM sync_queue WHERE status = 'pending' AND attempts < max_retry`
    );
    res.json({ ok: true, running: _queueDrainRunning, last: _lastQueueDrain, remaining: pend[0]?.remaining || 0 });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/order-written-sample — 시트에 반영 완료된 주문 샘플(노란 복구행 육안확인용)
//   query: { sheetId?, tabName?, limit? } — 최근 sheet_written_at 순. 행번호로 시트에서 직접 확인.
//   reconcile(복구) 경로로 써진 행은 시트 하단에 노란 배경 → 이 목록의 sheetRow로 대조.
// ═══════════════════════════════════════════════════════════
router.get('/order-written-sample', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    const params = [];
    const conds = [`os.mirror_status = 'written'`, `os.sheet_row IS NOT NULL`];
    if (sheetId) { params.push(sheetId); conds.push(`os.sheet_id = $${params.length}`); }
    if (tabName) { params.push(tabName); conds.push(`os.tab_name = $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT os.id, os.sheet_id AS "sheetId", os.tab_name AS "tabName",
              COALESCE(NULLIF(os.tab_gid, ''), rst.tab_gid) AS "tabGid",
              os.sheet_row AS "sheetRow",
              os.orderer, os.recipient, os.order_num AS "orderNum",
              RIGHT(regexp_replace(COALESCE(os.phone, ''), '[^0-9]', '', 'g'), 4) AS "phone4",
              os.sheet_written_at AS "writtenAt"
         FROM order_submissions os
         LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id = os.sheet_id
              AND (rst.tab_gid = NULLIF(os.tab_gid, '') OR rst.tab_name = os.tab_name)
        WHERE ${conds.join(' AND ')}
        ORDER BY os.sheet_written_at DESC NULLS LAST
        LIMIT $${params.length}`,
      params
    );
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    next(err);
  }
});

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
// GET /api/diag/yellow-rows-export — 노란배경(복구/수동추가) 행이 있는 탭 목록 추출
//   배경: reconcile 자동복구·order-manual-add 는 시트 하단에 새 행을 append 하고
//     연한 노랑({red:1,green:0.95,blue:0.6}) 배경으로 표시한다(수동입력분과 시각 구분).
//     그 행들은 sheet_row_claims 에 source='order_reconcile'(적체복구) 또는 'manual'(수동추가)
//     로 기록된다. 쓰기 차단 시 claim 은 삭제(_releaseOrderRowClaim)되므로, 남아있는 claim
//     = 실제로 (거의 다) 시트에 기록된 노란행.
//   이 엔드포인트는 그 claim 들을 탭별로 집계해 "노란행이 있는 탭"의 탭명/시트탭URL/행번호를
//     CSV(또는 JSON)로 내려준다. 사용자가 수동 확인 후 삭제하는 용도. admin/master 전용.
//   query: { format: ''(json)|csv|detail.csv, source: all|reconcile|manual, sheetId?, writtenOnly? }
//   - format=csv      : 탭 단위 요약(탭명·시트탭URL·노란행수·행번호목록)
//   - format=detail.csv: 행 단위 상세(시트행·주문자·주문번호·상태 포함)
//   한계: 실시간 주문이 실패 후 "제자리(원래 행)"에서 복구돼 노란색이 된 경우는 claim source가
//     'order_submit' 이라 빠질 수 있다(append 신규행이 아닌 in-place 복구). 대부분의 적체 노란행은
//     하단 append(=reconcile/manual)이므로 본 목록으로 커버된다.
// ═══════════════════════════════════════════════════════════
router.get('/yellow-rows-export', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const format = String(req.query.format || '').toLowerCase();
    const srcParam = String(req.query.source || 'all').toLowerCase();
    const sources = srcParam === 'reconcile' ? ['order_reconcile']
      : srcParam === 'manual' ? ['manual']
      : ['order_reconcile', 'manual'];
    const writtenOnly = req.query.writtenOnly === '1' || req.query.writtenOnly === 'true';

    const params = [sources];
    let whereExtra = '';
    if (req.query.sheetId) { params.push(String(req.query.sheetId)); whereExtra += ` AND c.sheet_id = $${params.length}`; }
    const writtenCond = writtenOnly ? ` AND os.mirror_status = 'written'` : '';

    const sheetUrl = (sheetId, gid) => {
      const base = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
      return (gid !== null && gid !== undefined && String(gid) !== '') ? `${base}#gid=${gid}` : base;
    };
    const esc = (v) => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
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
    const srcMap = { order_reconcile: '복구(적체)', manual: '수동추가' };

    // ── 행 단위 상세 (format=detail.csv) ──
    if (format === 'detail.csv' || format === 'detail' || req.query.detail === '1') {
      const { rows } = await pool.query(
        `SELECT c.sheet_id, c.tab_gid, c.tab_name, c.sheet_row, c.source,
                os.orderer, os.recipient, os.phone, os.order_num,
                os.mirror_status, os.submitted_at, c.created_at
           FROM sheet_row_claims c
           LEFT JOIN order_submissions os ON os.id = c.order_id
          WHERE c.source = ANY($1) AND c.sheet_row IS NOT NULL${whereExtra}${writtenCond}
          ORDER BY c.sheet_id, c.tab_name, c.sheet_row`,
        params
      );
      const head = ['탭명', '시트탭URL', '시트행', '출처', '주문자', '수취인', '연락처', '주문번호', '상태', '제출시각(KST)', '기록시각(KST)', '시트ID', 'gid'];
      const lines = [head.map(esc).join(',')];
      for (const r of rows) {
        lines.push([
          r.tab_name || '', sheetUrl(r.sheet_id, r.tab_gid), r.sheet_row || '',
          srcMap[r.source] || r.source || '', r.orderer || '', r.recipient || '', r.phone || '',
          r.order_num || '', r.mirror_status || '', fmtKST(r.submitted_at), fmtKST(r.created_at),
          r.sheet_id || '', r.tab_gid || '',
        ].map(esc).join(','));
      }
      const csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="yellow_rows_detail.csv"; filename*=UTF-8''${encodeURIComponent('노란행_상세.csv')}`);
      return res.send(csv);
    }

    // ── 탭 단위 집계 (기본 JSON / format=csv) ──
    const { rows } = await pool.query(
      `SELECT c.sheet_id, c.tab_gid, c.tab_name,
              COUNT(*)::int AS yellow_rows,
              COUNT(*) FILTER (WHERE c.source = 'order_reconcile')::int AS reconcile_rows,
              COUNT(*) FILTER (WHERE c.source = 'manual')::int AS manual_rows,
              COUNT(*) FILTER (WHERE os.mirror_status = 'written')::int AS written_rows,
              MIN(c.sheet_row)::int AS min_row,
              MAX(c.sheet_row)::int AS max_row,
              array_agg(c.sheet_row ORDER BY c.sheet_row) AS row_numbers,
              MAX(c.created_at) AS last_claim_at
         FROM sheet_row_claims c
         LEFT JOIN order_submissions os ON os.id = c.order_id
        WHERE c.source = ANY($1) AND c.sheet_row IS NOT NULL${whereExtra}${writtenCond}
        GROUP BY c.sheet_id, c.tab_gid, c.tab_name
        ORDER BY c.sheet_id, c.tab_name`,
      params
    );

    if (format === 'csv') {
      const head = ['탭명', '시트탭URL', '노란행수', '복구(적체)', '수동추가', '반영확인(written)', '행번호목록', '시트ID', 'gid'];
      const lines = [head.map(esc).join(',')];
      for (const r of rows) {
        const rowNums = (r.row_numbers || []).join(' ');
        lines.push([
          r.tab_name || '', sheetUrl(r.sheet_id, r.tab_gid), r.yellow_rows || 0,
          r.reconcile_rows || 0, r.manual_rows || 0, r.written_rows || 0, rowNums,
          r.sheet_id || '', r.tab_gid || '',
        ].map(esc).join(','));
      }
      const csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="yellow_rows_tabs.csv"; filename*=UTF-8''${encodeURIComponent('노란행_탭목록.csv')}`);
      return res.send(csv);
    }

    const items = rows.map(r => ({
      tabName: r.tab_name, sheetId: r.sheet_id, gid: r.tab_gid,
      sheetTabUrl: sheetUrl(r.sheet_id, r.tab_gid),
      yellowRows: r.yellow_rows, reconcileRows: r.reconcile_rows, manualRows: r.manual_rows,
      writtenRows: r.written_rows, minRow: r.min_row, maxRow: r.max_row,
      rowNumbers: r.row_numbers || [], lastClaimAt: r.last_claim_at,
    }));
    res.json({
      ok: true, source: srcParam, writtenOnly,
      tabCount: items.length,
      totalYellowRows: items.reduce((s, i) => s + (i.yellowRows || 0), 0),
      items,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/yellow-rows-delete — 노란 복구행(적체) 삭제 (탭 단위, admin/master, 되돌릴 수 없음)
//   body: { sheetId, gid, tabName?, beforeDateKst:'YYYY-MM-DD', source?:'reconcile'|'manual'|'all', confirm? }
//   - 대상: source(복구/수동) 의 'written' claim 중 주문 submitted_at < (beforeDateKst 00:00 KST) 인 행.
//   - 안전장치:
//     ① 실행 직전 시트의 현재 배경색을 다시 읽어, DB가 아는 노란행 집합(EXPECTED=written claim)과
//        시트 실제 노란행 집합(ACTUAL)이 '완전히 일치'할 때만 진행. 불일치(행 밀림/수동변경) → 삭제 없이 mismatch 보고.
//     ② 삭제는 아래→위(내림차순) + 연속구간 병합. 삭제 전 행 내용을 backup으로 반환(복구 대비).
//     ③ confirm !== true 면 dry-run(무엇을 지울지만 반환).
//     ④ 삭제 후: 삭제행 claim 제거 + 이 탭 잔여 claim의 sheet_row를 밀림만큼 보정(다음 6/30 작업 정합).
// ═══════════════════════════════════════════════════════════
router.post('/yellow-rows-delete', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { readRowsWithFormat, deleteRows } = require('../services/sheets.service');
    const { throttledCall } = require('../utils/sheetsThrottle');
    const { withJobLock } = require('../utils/jobLock');
    const b = req.body || {};
    const sheetId = b.sheetId;
    const gid = (b.gid != null && b.gid !== '') ? String(b.gid) : '';
    const tabNameIn = b.tabName ? String(b.tabName) : '';
    const beforeDateKst = String(b.beforeDateKst || '').trim();
    const srcParam = String(b.source || 'reconcile').toLowerCase();
    const confirm = b.confirm === true || b.confirm === 'true';
    if (!sheetId || (!gid && !tabNameIn)) return res.status(400).json({ ok: false, error: 'sheetId 와 gid(또는 tabName) 필수' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDateKst)) return res.status(400).json({ ok: false, error: "beforeDateKst='YYYY-MM-DD' 형식 필수" });
    const sources = srcParam === 'all' ? ['order_reconcile', 'manual'] : srcParam === 'manual' ? ['manual'] : ['order_reconcile'];

    const isYellow = (c) => {
      if (!c) return false;
      const r = c.red == null ? 0 : c.red, g = c.green == null ? 0 : c.green, bl = c.blue == null ? 0 : c.blue;
      // 연한 노랑 {red:1, green:0.95, blue:0.6} ± 허용. 흰색(1,1,1)·기타색 제외.
      return r >= 0.92 && g >= 0.88 && g <= 0.99 && bl >= 0.50 && bl <= 0.72;
    };
    const onlyDigits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

    // EXPECTED: 이 탭의 복구/수동 claim (order 조인 — 날짜·written 여부·내용대조 키)
    const params = [sources, sheetId];
    let tabCond = '';
    if (gid) { params.push(gid); tabCond += ` AND c.tab_gid = $${params.length}`; }
    if (tabNameIn) { params.push(tabNameIn); tabCond += ` AND c.tab_name = $${params.length}`; }
    const { rows: claimRows } = await pool.query(
      `SELECT c.sheet_row, c.tab_name, os.submitted_at, os.mirror_status, os.order_num, os.phone
         FROM sheet_row_claims c
         LEFT JOIN order_submissions os ON os.id = c.order_id
        WHERE c.source = ANY($1) AND c.sheet_id = $2 AND c.sheet_row IS NOT NULL${tabCond}`,
      params
    );
    // 'written' 만 실제 노란행(yellow는 쓰기 성공 후 적용)
    const writtenClaims = claimRows.filter(r => r.mirror_status === 'written');
    const resolvedTabName = tabNameIn || (writtenClaims[0] && writtenClaims[0].tab_name) || '';
    if (!writtenClaims.length) {
      return res.json({ ok: true, tab: resolvedTabName, gid, deleted: 0, note: '이 탭에 written 복구/수동 행 없음' });
    }
    const writtenRowSet = new Set(writtenClaims.map(r => Number(r.sheet_row)));
    const boundary = new Date(`${beforeDateKst}T00:00:00+09:00`); // KST(UTC+9) 00:00 이전 = 삭제 대상

    // ── 임계영역: 게이트 읽기 ~ 삭제 ~ DB 정리를 reconcile/queue 와 같은 락으로 직렬화(TOCTOU 차단). ──
    //   락 보유 중 시트 현재 상태를 다시 읽어 행번호가 실행시점과 일치함을 보장한다.
    const work = async () => {
      // 시트 현재 상태(값+배경색) 1회 읽기
      const grid = await throttledCall(() => readRowsWithFormat(sheetId, { gid, tabName: resolvedTabName }));
      const tabTitle = grid.title || resolvedTabName;
      const actualYellow = new Set();
      for (const [row, info] of grid.rows.entries()) { if (isYellow(info.bg)) actualYellow.add(row); }
      const extraYellow = [...actualYellow].filter(r => !writtenRowSet.has(r)).sort((a, b) => a - b); // 정보용(order_submit 복구분 등)

      const candidates = writtenClaims.filter(r => r.submitted_at && new Date(r.submitted_at) < boundary);
      const undatedKept = writtenClaims.filter(r => !r.submitted_at).map(r => Number(r.sheet_row)).sort((a, b) => a - b);

      // 행별 검증: ① 현재 노란색 ② 행 내용이 그 주문의 주문번호/연락처(끝8)를 포함(=밀림/오매칭 차단).
      //   키가 없으면(주문번호·연락처 모두 없음) 노란색만으로 허용(드묾).
      const delRows = [], backup = [], skippedRows = [];
      for (const c of candidates) {
        const row = Number(c.sheet_row);
        const info = grid.rows.get(row);
        if (!info || !isYellow(info.bg)) { skippedRows.push({ row, reason: 'not-yellow' }); continue; }
        const rowDigits = onlyDigits((info.values || []).join('|'));
        const onum = onlyDigits(c.order_num);
        const ph8 = onlyDigits(c.phone).slice(-8);
        const hasKey = onum.length >= 5 || ph8.length >= 8;
        const matched = !hasKey || (onum.length >= 5 && rowDigits.includes(onum)) || (ph8.length >= 8 && rowDigits.includes(ph8));
        if (!matched) { skippedRows.push({ row, reason: 'content-mismatch' }); continue; }
        delRows.push(row);
        backup.push({ row, values: info.values || [] });
      }
      delRows.sort((a, b) => a - b);

      const baseResp = {
        ok: true, tab: tabTitle, gid, expectedWritten: writtenClaims.length,
        actualYellow: actualYellow.size, extraYellow: extraYellow.length, extraYellowRows: extraYellow.slice(0, 50),
        skippedCount: skippedRows.length, skippedRows: skippedRows.slice(0, 50), undatedKept,
      };

      if (!delRows.length) return { ...baseResp, deleted: 0, note: '삭제 대상(기준일 이전 · 노란 · 내용일치) 없음' };
      if (!confirm) return { ...baseResp, dryRun: true, wouldDelete: delRows.length, rows: delRows, backup };

      // #6: 확정 삭제는 백업이 행 수만큼 갖춰졌을 때만(백업 없는 비가역 삭제 금지)
      if (backup.length !== delRows.length) {
        return { ...baseResp, ok: false, deleted: 0, error: '백업 구성 실패 — 안전을 위해 삭제 중단(재시도 요망)' };
      }

      // 실제 삭제(아래→위)
      await throttledCall(() => deleteRows(sheetId, { gid, tabName: tabTitle, rowIndexes: delRows }));

      // DB 정리(트랜잭션): 삭제행 claim 제거 + 잔여 claim sheet_row 밀림 보정(이 탭).
      //   밀림 보정은 유니크(sheet_id,tab_name,sheet_row) 행별 즉시검사 때문에 단일 UPDATE면 과도기
      //   중복키가 날 수 있어 오름차순 한 행씩 갱신(낮은 행 먼저 비워져 충돌 없음).
      //   claim 은 저장된 tab_name 으로 키잉(시트는 gid/현재제목, DB는 claimTab).
      const claimTab = resolvedTabName || tabTitle;
      const delSet = new Set(delRows);
      let claimCleanupFailed = false;
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        await dbClient.query(
          `DELETE FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2 AND sheet_row = ANY($3::int[])`,
          [sheetId, claimTab, delRows]
        );
        const { rows: shiftRows } = await dbClient.query(
          `SELECT id, sheet_row FROM sheet_row_claims
            WHERE sheet_id = $1 AND tab_name = $2 AND sheet_row IS NOT NULL
              AND (SELECT count(*) FROM unnest($3::int[]) d WHERE d < sheet_row) > 0
            ORDER BY sheet_row ASC`,
          [sheetId, claimTab, delRows]
        );
        for (const s of shiftRows) {
          const r = Number(s.sheet_row);
          let shift = 0; for (const d of delSet) { if (d < r) shift++; }
          if (shift > 0) await dbClient.query(`UPDATE sheet_row_claims SET sheet_row = $2, updated_at = NOW() WHERE id = $1`, [s.id, r - shift]);
        }
        await dbClient.query('COMMIT');
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (_) {}
        claimCleanupFailed = true; // ★ 시트는 지워졌으나 DB가 불일치 → 응답으로 알려 재실행 금지 유도
        logger.error(`[yellow-delete] claim 정리 실패(시트 삭제 완료됨, DB 불일치!): ${dbErr.message}`);
      } finally {
        dbClient.release();
      }

      logger.info(`[yellow-delete] tab="${tabTitle}" sheet=${sheetId} 삭제 ${delRows.length}행 (기준 ${beforeDateKst} KST 이전)`);
      return { ...baseResp, deleted: delRows.length, rows: delRows, backup, claimCleanupFailed };
    };

    // dry-run(읽기 전용)은 락 불필요. 확정 삭제만 order_reconcile 락으로 직렬화.
    const result = confirm
      ? await withJobLock('order_reconcile', work, {
          onBusy: () => ({ ok: true, skipped: 'busy', deleted: 0, tab: resolvedTabName, gid, reason: 'reconcile/queue 작업 진행 중 — 잠시 후 재시도' }),
        })
      : await work();
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/diag/build-history — 빌드 히스토리
router.get('/build-history', authMiddleware, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const { rows } = await pool.query(
      `SELECT id, started_at, elapsed_ms, rebuilt, skipped, errors, total, trigger_by, build_log
       FROM build_history
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, history: rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/app-url — 앱 URL 조회 (GAS: getAppUrl)
// ═══════════════════════════════════════════════════════════
router.get('/app-url', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'APP_URL'"
    );
    const url = rows[0]?.value || '';
    res.json({ ok: true, url });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/app-url — 앱 URL 저장 (GAS: saveAppUrl)
// ═══════════════════════════════════════════════════════════
router.post('/app-url', authMiddleware, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.json({ ok: false, error: 'URL이 필요합니다.' });

    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('APP_URL', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [url]
    );
    res.json({ ok: true, url });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/metrics — API 메트릭 조회 (관리자 전용)
// ═══════════════════════════════════════════════════════════
router.get('/metrics', authMiddleware, async (req, res) => {
  const summary = getMetricsSummary();
  res.json({
    ok: true,
    sentry: isSentryEnabled() ? 'active' : 'inactive',
    ...summary,
  });
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/metrics/reset — 메트릭 초기화 (관리자 전용)
// ═══════════════════════════════════════════════════════════
router.post('/metrics/reset', authMiddleware, async (req, res) => {
  resetMetrics();
  logger.info('[Metrics] 메트릭 수동 초기화');
  res.json({ ok: true, message: '메트릭 초기화 완료' });
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
  keyGenerator: (req) => 'ce:' + (req._ceReporterKey || req.ip),
  message: { ok: false, error: '오류 보고가 너무 많습니다.' },
});
const _ceStr = (v, n) => (typeof v === 'string' ? v : (v == null ? '' : String(v))).slice(0, n);
const _ceNum = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
router.post('/client-error', (req, res, next) => {
  const reporter = _clientErrorReporter(req);
  if (!reporter) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
  req._ceReporter = reporter;
  req._ceReporterKey = reporter.kind === 'reviewer' ? 'r:' + reporter.reviewer : `s:${reporter.role}:${reporter.via}:${reporter.name}`;
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
// GET /api/diag/events — SSE 실시간 알림 스트림 (관리자 전용)
// Phase 8: 새 제출/분석완료 알림을 대시보드에 실시간 전달
// ═══════════════════════════════════════════════════════════
router.get('/events', authMiddleware, (req, res) => {
  addClient(req, res);
});


// ═══════════════════════════════════════════════════════════
// Phase 9: 통계/리포트 대시보드 API
// ═══════════════════════════════════════════════════════════

// GET /api/diag/stats/campaigns — 캠페인별 제출률 통계
router.get('/stats/campaigns', authMiddleware, async (req, res, next) => {
  try {
    // 캠페인(탭)별 전체·제출·미제출 집계
    const { rows } = await pool.query(`
      SELECT
        ri.campaign_name AS "campaignName",
        ri.sheet_id      AS "sheetId",
        ri.tab_name       AS "tabName",
        tc.display_name   AS "displayName",
        tc.manager,
        tc.review_type    AS "reviewType",
        tc.is_closed      AS "isClosed",
        COUNT(*)                              AS "totalCount",
        COUNT(*) FILTER (WHERE ri.is_submitted)  AS "submittedCount",
        COUNT(*) FILTER (WHERE NOT ri.is_submitted) AS "pendingCount",
        CASE WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE ri.is_submitted) / COUNT(*), 1)
          ELSE 0 END                          AS "submitRate"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      GROUP BY ri.campaign_name, ri.sheet_id, ri.tab_name,
               tc.display_name, tc.manager, tc.review_type, tc.is_closed
      ORDER BY "submitRate" DESC, "totalCount" DESC
    `);

    // 전체 요약
    const totals = rows.reduce((acc, r) => {
      acc.total += parseInt(r.totalCount);
      acc.submitted += parseInt(r.submittedCount);
      acc.pending += parseInt(r.pendingCount);
      return acc;
    }, { total: 0, submitted: 0, pending: 0 });
    totals.submitRate = totals.total > 0
      ? Math.round(1000 * totals.submitted / totals.total) / 10
      : 0;

    res.json({ ok: true, campaigns: rows, totals, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/diag/stats/reviewers — 리뷰어 활동량 통계
router.get('/stats/reviewers', authMiddleware, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 30;

    // 리뷰어별 총 건수, 제출 건수, 미제출 건수
    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name          AS "name",
        COUNT(*)                  AS "totalCount",
        COUNT(*) FILTER (WHERE ri.is_submitted)    AS "submittedCount",
        COUNT(*) FILTER (WHERE NOT ri.is_submitted) AS "pendingCount",
        COUNT(DISTINCT ri.campaign_name)            AS "campaignCount",
        MAX(ri.built_at)                            AS "lastActivity"
      FROM review_index ri
      GROUP BY ri.reviewer_name
      ORDER BY "totalCount" DESC
      LIMIT $1
    `, [limit]);

    // 구매양식 제출 건수 병합
    const { rows: orderRows } = await pool.query(`
      SELECT orderer AS "name", COUNT(*) AS "orderCount"
      FROM order_submissions
      GROUP BY orderer
    `);
    const orderMap = {};
    orderRows.forEach(r => { orderMap[r.name] = parseInt(r.orderCount); });

    const reviewers = rows.map(r => ({
      ...r,
      totalCount: parseInt(r.totalCount),
      submittedCount: parseInt(r.submittedCount),
      pendingCount: parseInt(r.pendingCount),
      campaignCount: parseInt(r.campaignCount),
      orderCount: orderMap[r.name] || 0,
    }));

    res.json({ ok: true, reviewers, count: reviewers.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/diag/stats/payments — 입금 현황 통계
router.get('/stats/payments', authMiddleware, async (req, res, next) => {
  try {
    // 탭별 입금 집계
    const { rows: byTab } = await pool.query(`
      SELECT
        pr.tab_name       AS "tabName",
        pr.sheet_id       AS "sheetId",
        tc.campaign_name  AS "campaignName",
        tc.display_name   AS "displayName",
        pr.status,
        COUNT(*)          AS "count",
        COALESCE(SUM(
          CASE WHEN pr.amount ~ '^[0-9,.]+$'
               THEN REPLACE(pr.amount, ',', '')::NUMERIC
               ELSE 0 END
        ), 0)             AS "totalAmount"
      FROM payment_records pr
      LEFT JOIN tab_configs tc ON pr.sheet_id = tc.sheet_id AND pr.tab_name = tc.tab_name
      GROUP BY pr.tab_name, pr.sheet_id, tc.campaign_name, tc.display_name, pr.status
      ORDER BY "totalAmount" DESC
    `);

    // 일별 입금 추이 (최근 30일)
    const { rows: daily } = await pool.query(`
      SELECT
        TO_CHAR(paid_at, 'YYYY-MM-DD') AS "date",
        COUNT(*)                        AS "count",
        COALESCE(SUM(
          CASE WHEN amount ~ '^[0-9,.]+$'
               THEN REPLACE(amount, ',', '')::NUMERIC
               ELSE 0 END
        ), 0)                           AS "totalAmount"
      FROM payment_records
      WHERE paid_at >= NOW() - INTERVAL '30 days'
      GROUP BY TO_CHAR(paid_at, 'YYYY-MM-DD')
      ORDER BY "date" ASC
    `);

    // 전체 요약
    const { rows: summaryRows } = await pool.query(`
      SELECT
        COUNT(*) AS "totalPayments",
        COUNT(DISTINCT reviewer_name) AS "uniqueReviewers",
        COALESCE(SUM(
          CASE WHEN amount ~ '^[0-9,.]+$'
               THEN REPLACE(amount, ',', '')::NUMERIC
               ELSE 0 END
        ), 0) AS "grandTotal"
      FROM payment_records
    `);
    const summary = summaryRows[0] || { totalPayments: 0, uniqueReviewers: 0, grandTotal: 0 };

    res.json({
      ok: true,
      byTab,
      daily,
      summary: {
        totalPayments: parseInt(summary.totalPayments),
        uniqueReviewers: parseInt(summary.uniqueReviewers),
        grandTotal: parseFloat(summary.grandTotal),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/diag/stats/overview — 전체 대시보드 요약 (한 번에 로드)
router.get('/stats/overview', authMiddleware, async (req, res, next) => {
  try {
    const [
      { rows: campaignSummary },
      { rows: recentSubmits },
      { rows: recentOrders },
      { rows: paymentSummary },
      { rows: dailyActivity },
    ] = await Promise.all([
      // 1. 캠페인 요약
      pool.query(`
        SELECT
          COUNT(DISTINCT campaign_name) AS "campaignCount",
          COUNT(*)                      AS "totalReviews",
          COUNT(*) FILTER (WHERE is_submitted) AS "submitted",
          COUNT(*) FILTER (WHERE NOT is_submitted) AS "pending"
        FROM review_index
      `),
      // 2. 최근 리뷰 제출 (7일)
      pool.query(`
        SELECT TO_CHAR(built_at, 'YYYY-MM-DD') AS "date", COUNT(*) AS "count"
        FROM review_index
        WHERE is_submitted = TRUE AND built_at >= NOW() - INTERVAL '7 days'
        GROUP BY TO_CHAR(built_at, 'YYYY-MM-DD')
        ORDER BY "date" ASC
      `),
      // 3. 최근 구매양식 제출 (7일)
      pool.query(`
        SELECT TO_CHAR(submitted_at, 'YYYY-MM-DD') AS "date", COUNT(*) AS "count"
        FROM order_submissions
        WHERE submitted_at >= NOW() - INTERVAL '7 days'
        GROUP BY TO_CHAR(submitted_at, 'YYYY-MM-DD')
        ORDER BY "date" ASC
      `),
      // 4. 입금 요약
      pool.query(`
        SELECT
          COUNT(*) AS "totalPayments",
          COALESCE(SUM(
            CASE WHEN amount ~ '^[0-9,.]+$'
                 THEN REPLACE(amount, ',', '')::NUMERIC ELSE 0 END
          ), 0) AS "grandTotal"
        FROM payment_records
      `),
      // 5. 일별 활동량 (7일)
      pool.query(`
        SELECT d::DATE AS "date",
          COALESCE(r.cnt, 0) AS "reviews",
          COALESCE(o.cnt, 0) AS "orders"
        FROM generate_series(NOW() - INTERVAL '6 days', NOW(), '1 day') d
        LEFT JOIN (
          SELECT DATE(built_at) AS dt, COUNT(*) AS cnt
          FROM review_index WHERE is_submitted AND built_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(built_at)
        ) r ON r.dt = d::DATE
        LEFT JOIN (
          SELECT DATE(submitted_at) AS dt, COUNT(*) AS cnt
          FROM order_submissions WHERE submitted_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(submitted_at)
        ) o ON o.dt = d::DATE
        ORDER BY d ASC
      `),
    ]);

    const cs = campaignSummary[0] || {};
    const ps = paymentSummary[0] || {};

    res.json({
      ok: true,
      overview: {
        campaigns: parseInt(cs.campaignCount) || 0,
        totalReviews: parseInt(cs.totalReviews) || 0,
        submitted: parseInt(cs.submitted) || 0,
        pending: parseInt(cs.pending) || 0,
        submitRate: cs.totalReviews > 0
          ? Math.round(1000 * cs.submitted / cs.totalReviews) / 10
          : 0,
        totalPayments: parseInt(ps.totalPayments) || 0,
        paymentTotal: parseFloat(ps.grandTotal) || 0,
      },
      dailyActivity: dailyActivity.map(r => ({
        date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date).split('T')[0],
        reviews: parseInt(r.reviews),
        orders: parseInt(r.orders),
      })),
      recentSubmits,
      recentOrders,
    });
  } catch (err) {
    next(err);
  }
});




// ═══════════════════════════════════════════════════════════
// GET /api/diag/pending-rows — 특정 탭의 미제출 행 조회
// ═══════════════════════════════════════════════════════════
router.get('/pending-rows', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, round } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    // 먼저 테이블 컬럼 확인
    const colCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'review_index' ORDER BY ordinal_position`
    );
    const columns = colCheck.rows.map(r => r.column_name);

    // 존재하는 컬럼만 SELECT
    const selectCols = ['row_index', 'reviewer_name', 'phone', 'submit_value', 'submit_col', 'round', 'built_at']
      .filter(c => columns.includes(c));

    // ★ round 필터링 적용
    const roundCond = round ? ` AND round = $3` : '';
    const params = round ? [sheetId, tabName, round] : [sheetId, tabName];

    const { rows } = await pool.query(
      `SELECT ${selectCols.join(', ')}
       FROM review_index
       WHERE sheet_id = $1 AND tab_name = $2 AND is_submitted = false${roundCond}
       ORDER BY row_index`,
      params
    );

    const countRes = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE is_submitted = true) as submitted,
              COUNT(*) FILTER (WHERE is_submitted = false) as pending
       FROM review_index WHERE sheet_id = $1 AND tab_name = $2${roundCond}`,
      params
    );

    res.json({ ok: true, counts: countRes.rows[0], pendingRows: rows, availableColumns: columns, round: round || '' });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/unpaid-rows — 특정 탭의 미입금 행 조회
// (제출 완료 + 미입금 상태인 행)
// ═══════════════════════════════════════════════════════════
router.get('/unpaid-rows', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, round } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    // round 조건 추가
    const roundCond = round ? ` AND round = $3` : '';
    const params = round ? [sheetId, tabName, round] : [sheetId, tabName];

    const { rows } = await pool.query(
      `SELECT row_index, reviewer_name, round
       FROM review_index
       WHERE sheet_id = $1 AND tab_name = $2
         AND is_submitted = true
         AND (is_submitted2 IS NULL OR is_submitted2 = 'NONE')${roundCond}
       ORDER BY row_index`,
      params
    );

    const countRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_submitted = true) AS submitted,
         COUNT(*) FILTER (WHERE is_submitted2 = 'PAID') AS paid,
         COUNT(*) FILTER (WHERE is_submitted = true AND (is_submitted2 IS NULL OR is_submitted2 = 'NONE')) AS unpaid
       FROM review_index WHERE sheet_id = $1 AND tab_name = $2${roundCond}`,
      params
    );

    res.json({ ok: true, counts: countRes.rows[0], unpaidRows: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

module.exports = router;
