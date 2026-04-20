const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, writeSheet, copySpreadsheet, copySheetToSpreadsheet, renameSheet } = require('../services/sheets.service');
const { getQueueStats, retryItem, retryAllFailed, purgeCompleted } = require('../services/syncQueue.service');
const { imageApiLimiter } = require('../middleware/rateLimit.middleware');
const { extractOrderFromImage, verifyAddressMatch } = require('../services/gemini.service');
const driveService = require('../services/drive.service');
const { getMetricsSummary, resetMetrics } = require('../middleware/metrics.middleware');
const { isSentryEnabled } = require('../utils/sentry');
const { addClient, getStatus: getSSEStatus, emitImageExtract, emitImageUpload } = require('../utils/sse');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// GET /api/diag/debug-tab — 세부목록 현재 상태 진단 (GAS: debugTabConfig)
// ═══════════════════════════════════════════════════════════
router.get('/debug-tab', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             manager, time_range AS "timeRange", review_type AS "reviewType",
             force_done AS "forceDone", is_closed AS "isClosed",
             campaign_name AS "campaignName",
             updated_at AS "updatedAt"
      FROM tab_configs
      ORDER BY updated_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, configs: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/debug-sheet — 특정 시트 파싱 가능 여부 확인 (GAS: debugSheet)
// ═══════════════════════════════════════════════════════════
router.get('/debug-sheet', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.query;
    if (!sheetId) return res.json({ error: 'sheetId 필요' });

    try {
      const meta = await getSpreadsheetMeta(sheetId);
      const tabs = meta.map(s => ({
        title: s.properties.title,
        gid: s.properties.sheetId,
        rowCount: s.properties.gridProperties?.rowCount || 0,
        colCount: s.properties.gridProperties?.columnCount || 0,
      }));
      res.json({ ok: true, sheetId, tabs });
    } catch (sheetsErr) {
      res.json({ ok: false, error: `시트 접근 불가: ${sheetsErr.message}` });
    }
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/debug-base — 베이스시트 진단 (GAS: debugBaseSheet)
// ═══════════════════════════════════════════════════════════
router.get('/debug-base', authMiddleware, async (req, res, next) => {
  try {
    const baseId = process.env.BASE_SHEET_ID;
    if (!baseId) return res.json({ error: 'BASE_SHEET_ID 미설정' });

    const meta = await getSpreadsheetMeta(baseId);
    const tabs = meta.map(s => ({
      title: s.properties.title,
      gid: s.properties.sheetId,
      rowCount: s.properties.gridProperties?.rowCount || 0,
    }));
    res.json({ ok: true, baseSheetId: baseId, tabs });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/check-duplicate — 구매양식 중복 검사 (GAS: checkDuplicateOrder)
// ═══════════════════════════════════════════════════════════
router.post('/check-duplicate', async (req, res, next) => {
  try {
    const { sheetId, tabName, userId, orderNum } = req.body;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM order_submissions
       WHERE sheet_id = $1 AND tab_name = $2 AND (user_id = $3 OR order_num = $4)`,
      [sheetId, tabName, userId || '', orderNum || '']
    );

    res.json({ ok: true, isDuplicate: parseInt(rows[0].count) > 0 });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/viewer/data — 뷰어 데이터 조회 (GAS: getViewerData)
// ═══════════════════════════════════════════════════════════
router.get('/viewer-data', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId) return res.json({ error: 'sheetId 필요' });

    // sheetId 단위 전체 캠페인 데이터 조회
    let sql = `
      SELECT
        ri.reviewer_name AS "reviewerName",
        ri.tab_name AS "tabName",
        ri.row_index AS "rowIndex",
        ri.is_submitted AS "isSubmitted",
        ri.product_name AS "productName",
        ri.campaign_name AS "campaignName",
        ri.row_json AS "rowJson",
        tc.display_name AS "displayName",
        tc.force_done AS "forceDone",
        tc.is_closed AS "isClosed"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.sheet_id = $1
    `;
    const params = [sheetId];

    if (tabName) {
      sql += ' AND ri.tab_name = $2';
      params.push(tabName);
    }

    sql += ' ORDER BY ri.tab_name, ri.row_index';
    const { rows } = await pool.query(sql, params);

    // 탭별 그룹화
    const tabMap = {};
    rows.forEach(r => {
      if (!tabMap[r.tabName]) tabMap[r.tabName] = { displayName: r.displayName || r.tabName, rows: [] };
      tabMap[r.tabName].rows.push(r);
    });

    res.json({ ok: true, rows, tabMap, total: rows.length });
  } catch (err) {
    next(err);
  }
});

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
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        await pool.query('DELETE FROM blacklist WHERE phone = $1', [cleanPhone]);
        return res.json({ ok: true });
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
// POST /api/index/new-sheet — 신규 시스템 시트 생성 (GAS: createBaseSheet)
// ═══════════════════════════════════════════════════════════
router.post('/new-sheet', authMiddleware, async (req, res, next) => {
  try {
    res.json({ ok: true, message: '신규 시트 생성 — Railway에서는 Sheets API 직접 호출 필요' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/index/add-campaign — 캠페인 추가 (GAS: addCampaign)
// ═══════════════════════════════════════════════════════════
router.post('/add-campaign', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, campaignName, sheetUrl, url } = req.body;
    const finalSheetId = sheetId || extractSheetId(url);
    const finalCampaignName = campaignName || '';

    if (!finalSheetId) {
      return res.json({ error: 'sheetId 또는 url이 필요합니다.' });
    }

    // 시트 메타데이터에서 캠페인명 가져오기
    let resolvedName = finalCampaignName;
    if (!resolvedName) {
      try {
        const meta = await getSpreadsheetMeta(finalSheetId);
        if (meta && meta.length > 0) {
          resolvedName = meta[0].properties.title || finalSheetId;
        }
      } catch (_) {
        resolvedName = finalSheetId;
      }
    }

    await pool.query(
      `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET
         sheet_url = EXCLUDED.sheet_url, updated_at = NOW()`,
      [finalSheetId, resolvedName, sheetUrl || url || `https://docs.google.com/spreadsheets/d/${finalSheetId}/edit`]
    );

    // tab_configs에도 해당 시트의 탭 목록 동기화
    try {
      const meta = await getSpreadsheetMeta(finalSheetId);
      const systemTabs = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정'];
      for (const sheet of meta) {
        const tabName = sheet.properties.title;
        if (systemTabs.includes(tabName)) continue;
        await pool.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, campaign_name, sheet_url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
             updated_at = NOW()`,
          [finalSheetId, tabName, resolvedName, sheetUrl || url || '']
        );
      }
    } catch (_) { /* 메타 로드 실패 시 무시 */ }

    res.json({ ok: true, sheetId: finalSheetId, campaignName: resolvedName });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/campaign-list — 캠페인 목록 조회 (GAS: campaignList)
// ═══════════════════════════════════════════════════════════
router.get('/campaign-list', async (req, res, next) => {
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

// ═══════════════════════════════════════════════════════════
// GET /api/diag/campaign-stats — 캠페인 통계 (GAS: getCampaignStats)
// ═══════════════════════════════════════════════════════════
router.get('/campaign-stats', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;

    let sql = `
      SELECT
        im.sheet_id AS "sheetId", im.tab_name AS "tabName",
        im.campaign_name AS "campaignName",
        im.row_count AS "totalCount", im.submitted_count AS "submittedCount",
        im.status, im.built_at AS "builtAt",
        tc.manager, tc.review_type AS "reviewType",
        tc.force_done AS "forceDone", tc.is_closed AS "isClosed"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
    `;
    const params = [];
    const where = [];
    if (sheetId) { where.push(`im.sheet_id = $${params.length + 1}`); params.push(sheetId); }
    if (tabName) { where.push(`im.tab_name = $${params.length + 1}`); params.push(tabName); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY im.built_at DESC NULLS LAST';

    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, stats: rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/inaed-list — 인애드명단 조회 (GAS: getInaedList — 구매양식 자동완성용)
// ═══════════════════════════════════════════════════════════
router.get('/inaed-list', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT name, phone, phone8, status, income_type AS "incomeType",
             sub_accounts AS "subAccounts"
      FROM reviewers
      WHERE status = 'active'
      ORDER BY name
    `);
    res.json({ ok: true, list: rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/image/drive-diag — Drive OAuth/SA 진단
// ═══════════════════════════════════════════════════════════
router.get('/drive-diag', async (req, res) => {
  const results = {
    rootFolderId: process.env.DRIVE_ROOT_FOLDER_ID || 'NOT SET',
    authStatus: driveService.getOAuthStatus(),
  };

  try {
    // 1. OAuth 업로드 테스트 (1x1 PNG)
    try {
      const uploaded = await driveService.uploadFileBase64(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        '_진단테스트_OAuth.png', 'image/png', results.rootFolderId
      );
      results.uploadFile = { ok: true, fileId: uploaded.id, method: 'OAuth' };
      // 테스트 파일 삭제 (OAuth 클라이언트로)
      try {
        const { google: g } = require('googleapis');
        const oauth2 = new g.auth.OAuth2(
          process.env.DRIVE_OAUTH_CLIENT_ID,
          process.env.DRIVE_OAUTH_CLIENT_SECRET
        );
        oauth2.setCredentials({ refresh_token: process.env.DRIVE_OAUTH_REFRESH_TOKEN });
        const tempDrive = g.drive({ version: 'v3', auth: oauth2 });
        await tempDrive.files.delete({ fileId: uploaded.id, supportsAllDrives: true });
        results.uploadFile.deleted = true;
      } catch (_) {
        results.uploadFile.deleted = false;
      }
    } catch (uploadErr) {
      results.uploadFile = { ok: false, error: uploadErr.message };
    }

    // 2. 폴더 생성 테스트 (OAuth)
    try {
      const testFolder = await driveService.createFolder('_진단테스트_삭제가능', results.rootFolderId);
      results.createFolder = { ok: true, folderId: testFolder.id, method: 'OAuth' };
      // 삭제
      try {
        const { google: g } = require('googleapis');
        const oauth2 = new g.auth.OAuth2(
          process.env.DRIVE_OAUTH_CLIENT_ID,
          process.env.DRIVE_OAUTH_CLIENT_SECRET
        );
        oauth2.setCredentials({ refresh_token: process.env.DRIVE_OAUTH_REFRESH_TOKEN });
        const tempDrive = g.drive({ version: 'v3', auth: oauth2 });
        await tempDrive.files.delete({ fileId: testFolder.id, supportsAllDrives: true });
        results.createFolder.deleted = true;
      } catch (_) {
        results.createFolder.deleted = false;
      }
    } catch (folderErr) {
      results.createFolder = { ok: false, error: folderErr.message };
    }

    res.json({ ok: true, ...results });
  } catch (err) {
    results.error = err.message;
    res.json({ ok: false, ...results });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/extract — 주문이미지 AI 분석 (Gemini Vision)
// 프론트엔드 기대 응답: { ok, orderNumber, recipient, phone, address, price, orderer, ... }
// ═══════════════════════════════════════════════════════════
router.post('/image-extract', imageApiLimiter, async (req, res, next) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.json({ ok: false, error: '이미지 데이터가 필요합니다.' });

    const result = await extractOrderFromImage(imageBase64, mimeType || 'image/jpeg');
    // result: { ok, orderNumber, recipient, phone, address, price, orderer, productName, orderDate, store, elapsed }

    // ── SSE 알림: AI 분석 완료 ──
    if (result.ok) {
      emitImageExtract({
        recipient: result.recipient || '',
        orderNumber: result.orderNumber || '',
        elapsed: result.elapsed || 0,
      });
    }

    res.json(result);
  } catch (err) {
    logger.error(`[image-extract] ${err.message}`);
    res.json({
      ok: false,
      error: err.message || '이미지 분석 중 오류가 발생했습니다.',
      orderNumber: '', recipient: '', phone: '', address: '', price: ''
    });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/upload — 주문이미지 Drive 업로드 (Google Drive API)
// 프론트엔드 페이로드: { imageBase64, mimeType, fileName, displayName, tabName, round, sheetId }
// ═══════════════════════════════════════════════════════════
router.post('/image-upload', imageApiLimiter, async (req, res, next) => {
  try {
    const { imageBase64, mimeType, fileName, displayName, tabName, round, sheetId } = req.body;
    if (!imageBase64) return res.json({ ok: false, error: '이미지 데이터가 필요합니다.' });

    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      logger.warn('[image-upload] DRIVE_ROOT_FOLDER_ID 미설정');
      return res.json({ ok: false, error: 'Drive 루트 폴더가 설정되지 않았습니다.' });
    }

    // 1. tab_configs에서 capture_folder_url 조회
    let targetFolderId = null;
    if (sheetId && tabName) {
      const { rows } = await pool.query(
        'SELECT capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      if (rows[0]?.capture_folder_url) {
        const m = rows[0].capture_folder_url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
        if (m) targetFolderId = m[1];
      }
    }

    // 2. capture_folder_url 없으면 → 캠페인 폴더 자동 생성
    if (!targetFolderId) {
      try {
        const folderName = `[캡처] ${displayName || tabName || '기타'}`;
        logger.info(`[image-upload] 폴더 검색/생성: "${folderName}" in ${rootFolderId}`);
        const folder = await driveService.findFolderByName(folderName, rootFolderId)
                    || await driveService.createFolder(folderName, rootFolderId);
        targetFolderId = folder.id;
        logger.info(`[image-upload] 폴더 확보: ${targetFolderId}`);

        // tab_configs에 캡처폴더 URL 저장
        if (sheetId && tabName) {
          const folderUrl = `https://drive.google.com/drive/folders/${folder.id}`;
          await pool.query(
            'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [folderUrl, sheetId, tabName]
          );
        }
      } catch (folderErr) {
        logger.error(`[image-upload] 폴더 생성 실패: ${folderErr.message}`);
        // 폴더 생성 실패 시 루트 폴더에 직접 업로드 시도
        targetFolderId = rootFolderId;
      }
    }

    // 3. 차수별 서브폴더 (round가 있으면)
    if (round) {
      const sub = await driveService.getOrCreateSubFolder(targetFolderId, String(round));
      targetFolderId = sub.id;
    }

    // 4. 파일 업로드
    const finalFileName = fileName || `캡처_${Date.now()}.jpg`;
    const uploaded = await driveService.uploadFileBase64(
      imageBase64, finalFileName, mimeType || 'image/jpeg', targetFolderId
    );

    logger.info(`[image-upload] 업로드 완료: ${uploaded.name} → ${uploaded.id}`);

    // ── SSE 알림: 이미지 업로드 완료 ──
    emitImageUpload({
      fileName: uploaded.name,
      fileId: uploaded.id,
      tabName: tabName || '',
      displayName: displayName || '',
    });

    res.json({
      ok: true,
      fileId: uploaded.id,
      fileName: uploaded.name,
      webViewLink: uploaded.webViewLink || '',
      webContentLink: uploaded.webContentLink || '',
    });
  } catch (err) {
    logger.error(`[image-upload] ${err.message}`);
    res.json({ ok: false, error: err.message || '이미지 업로드 중 오류가 발생했습니다.' });
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
// POST /api/diag/convert-nc-headers — NC 헤더 변환 (네이버+쿠팡 동시진행 모드)
// 주문번호 → 네이버주문번호 + 쿠팡주문번호
// 아이디   → 네이버ID + 쿠팡ID
// 결제금액 → 네이버결제금액 + 쿠팡결제금액
// ═══════════════════════════════════════════════════════════
router.post('/convert-nc-headers', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body;
    if (!sheetId || !tabName) return res.json({ ok: false, error: 'sheetId, tabName 필요' });

    // 1. 현재 헤더(1행) 읽기
    const headerRange = `'${tabName}'!1:1`;
    const rows = await readSheet(sheetId, headerRange);
    if (!rows || rows.length === 0) {
      return res.json({ ok: false, error: '시트 헤더를 읽을 수 없습니다.' });
    }

    const headers = rows[0];
    logger.info(`[NC 변환] 원본 헤더 (${headers.length}개): ${headers.slice(0, 15).join(', ')}`);

    // 2. 이미 변환 여부 확인
    const ncKeywords = ['네이버주문번호', '쿠팡주문번호', '네이버ID', '쿠팡ID', '네이버결제금액', '쿠팡결제금액'];
    const alreadyConverted = ncKeywords.some(kw => headers.includes(kw));
    if (alreadyConverted) {
      return res.json({ ok: true, alreadyConverted: true, message: '이미 네이버+쿠팡 모드로 변환된 탭입니다.' });
    }

    // 3. 변환 대상 컬럼 인덱스 찾기
    const findCol = (keywords) => headers.findIndex(h =>
      keywords.some(kw => String(h || '').includes(kw))
    );

    const orderIdx  = findCol(['주문번호', '번호']);
    const userIdx   = findCol(['아이디', 'ID', 'id']);
    const priceIdx  = findCol(['결제금액', '결제', '금액']);

    if (orderIdx < 0 && userIdx < 0 && priceIdx < 0) {
      return res.json({ ok: false, error: '변환할 헤더(주문번호/아이디/결제금액)를 찾을 수 없습니다.' });
    }

    // 4. 새 헤더 배열 구성 (원본 복사 후 치환)
    const newHeaders = [...headers];

    // 변환 매핑 (인덱스 큰 것부터 처리 → splice 영향 방지)
    const replacements = [];
    if (orderIdx >= 0) replacements.push({ idx: orderIdx, from: headers[orderIdx], to: ['네이버주문번호', '쿠팡주문번호'] });
    if (userIdx >= 0)  replacements.push({ idx: userIdx,  from: headers[userIdx],  to: ['네이버ID', '쿠팡ID'] });
    if (priceIdx >= 0) replacements.push({ idx: priceIdx, from: headers[priceIdx], to: ['네이버결제금액', '쿠팡결제금액'] });

    // 인덱스 큰 것부터 splice
    replacements.sort((a, b) => b.idx - a.idx);
    for (const r of replacements) {
      newHeaders.splice(r.idx, 1, ...r.to);
    }

    // 5. 시트에 새 헤더 쓰기
    const writeRange = `'${tabName}'!A1`;
    await writeSheet(sheetId, writeRange, [newHeaders]);

    logger.info(`[NC 변환] 완료: ${tabName} — 변환 ${replacements.length}건`);

    res.json({
      ok: true,
      alreadyConverted: false,
      converted: replacements.map(r => `${r.from} → ${r.to.join(' + ')}`),
      newHeaderCount: newHeaders.length,
    });
  } catch (err) {
    logger.error(`[NC 변환] 오류: ${err.message}`);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/create-campaign-sheet — 캠페인 시트 생성
// 모드 1 (registerMode=new): 템플릿 스프레드시트 전체 복사 → 새 파일
// 모드 2 (registerMode=existing): 템플릿의 특정 탭을 기존 시트에 복사
// 기대 응답: { ok, mode, fileTitle, campaignName, sheetUrl, sheetId, newTabName, tabUrl }
// ═══════════════════════════════════════════════════════════
router.post('/create-campaign-sheet', authMiddleware, async (req, res, next) => {
  try {
    const {
      templateSheetId,   // 템플릿 시트 ID
      fileTitle,         // 새 파일명 또는 새 탭명
      registerMode,      // 'new' | 'existing'
      campaignName,      // 캠페인명
      existingSheetId,   // 기존 시트 ID (existing 모드)
      templateTabName,   // 복사할 템플릿 탭 이름 (existing 모드)
    } = req.body;

    if (!templateSheetId || !fileTitle) {
      return res.json({ ok: false, error: '템플릿 시트ID와 파일명이 필요합니다.' });
    }

    const mode = registerMode || 'new';
    const resolvedCampaignName = campaignName || fileTitle;

    // ── 모드 1: 새 스프레드시트 생성 (전체 복사) ──
    if (mode === 'new') {
      const copied = await copySpreadsheet(templateSheetId, fileTitle);
      logger.info(`[createSheet] 새 시트 생성: ${copied.name} (${copied.id})`);

      // campaigns 테이블에 등록
      await pool.query(
        `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET
           sheet_url = EXCLUDED.sheet_url, updated_at = NOW()`,
        [copied.id, resolvedCampaignName, copied.url]
      );

      return res.json({
        ok: true,
        mode: 'new',
        fileTitle: copied.name,
        campaignName: resolvedCampaignName,
        sheetUrl: copied.url,
        sheetId: copied.id,
      });
    }

    // ── 모드 2: 기존 시트에 탭 추가 (탭 복사) ──
    if (mode === 'existing') {
      if (!existingSheetId) {
        return res.json({ ok: false, error: '기존 시트 ID가 필요합니다.' });
      }

      // 템플릿에서 복사할 탭의 sheetId(gid) 찾기
      const templateMeta = await getSpreadsheetMeta(templateSheetId);
      let sourceTab = null;

      if (templateTabName) {
        sourceTab = templateMeta.find(s => s.properties.title === templateTabName);
      }
      if (!sourceTab) {
        // 첫 번째 탭 사용
        sourceTab = templateMeta[0];
      }
      if (!sourceTab) {
        return res.json({ ok: false, error: '템플릿에서 복사할 탭을 찾을 수 없습니다.' });
      }

      const sourceGid = sourceTab.properties.sheetId;

      // 탭 복사
      const copiedTab = await copySheetToSpreadsheet(templateSheetId, sourceGid, existingSheetId);
      logger.info(`[createSheet] 탭 복사 완료: ${copiedTab.title} → gid=${copiedTab.sheetId}`);

      // 탭 이름 변경 ("Copy of 원본" → 원하는 이름)
      const newTabName = fileTitle;
      try {
        await renameSheet(existingSheetId, copiedTab.sheetId, newTabName);
        logger.info(`[createSheet] 탭 이름 변경: ${copiedTab.title} → ${newTabName}`);
      } catch (renameErr) {
        logger.warn(`[createSheet] 탭 이름 변경 실패 (무시): ${renameErr.message}`);
        // 이름 변경 실패해도 복사 자체는 성공
      }

      const sheetUrl = `https://docs.google.com/spreadsheets/d/${existingSheetId}/edit`;
      const tabUrl = `${sheetUrl}#gid=${copiedTab.sheetId}`;

      // tab_configs에 등록
      await pool.query(
        `INSERT INTO tab_configs (sheet_id, tab_name, campaign_name, sheet_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
           campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
           updated_at = NOW()`,
        [existingSheetId, newTabName, resolvedCampaignName, sheetUrl]
      );

      return res.json({
        ok: true,
        mode: 'existing',
        newTabName,
        campaignName: resolvedCampaignName,
        sheetUrl,
        tabUrl,
        sheetId: existingSheetId,
      });
    }

    return res.json({ ok: false, error: `알 수 없는 registerMode: ${mode}` });
  } catch (err) {
    logger.error(`[createSheet] 오류: ${err.message}`);
    next(err);
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

// GET /api/diag/build-history — 빌드 히스토리
router.get('/build-history', authMiddleware, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const { rows } = await pool.query(
      `SELECT id, started_at, elapsed_ms, rebuilt, skipped, errors, total, trigger_by
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
router.get('/app-url', async (req, res, next) => {
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
router.post('/app-url', async (req, res, next) => {
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
router.post('/client-error', async (req, res) => {
  try {
    const { message, source, lineno, colno, stack, page, userAgent } = req.body;
    logger.error({
      message: `[ClientError] ${message}`,
      source, lineno, colno, page,
      stack: (stack || '').substring(0, 500),
      ip: req.ip,
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
// GET /api/diag/sse-status — SSE 연결 상태 (관리자 전용)
// ═══════════════════════════════════════════════════════════
router.get('/sse-status', authMiddleware, (req, res) => {
  res.json({ ok: true, ...getSSEStatus() });
});

// ── 헬퍼 ──
function extractSheetId(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

module.exports = router;
