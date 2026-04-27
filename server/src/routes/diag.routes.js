const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, writeSheet, appendSheet, copySpreadsheet, copySheetToSpreadsheet, renameSheet } = require('../services/sheets.service');
const { getQueueStats, retryItem, retryAllFailed, purgeCompleted } = require('../services/syncQueue.service');
const { imageApiLimiter } = require('../middleware/rateLimit.middleware');
const { extractOrderFromImage, verifyAddressMatch } = require('../services/gemini.service');
const driveService = require('../services/drive.service');
const { getMetricsSummary, resetMetrics } = require('../middleware/metrics.middleware');
const { isSentryEnabled } = require('../utils/sentry');
const { addClient, getStatus: getSSEStatus, emitImageExtract, emitImageUpload } = require('../utils/sse');
const { logger } = require('../utils/logger');
const { parseTabRows } = require('../services/indexBuilder.service');

// ═══════════════════════════════════════════════════════════
// GET /api/diag/debug-tab — 세부목록 현재 상태 진단 (GAS: debugTabConfig)
// ═══════════════════════════════════════════════════════════
router.get('/debug-tab', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             manager, time_range AS "timeRange", review_type AS "reviewType",
             is_closed AS "isClosed",
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
// GET /api/diag/debug-base — [DEPRECATED] 베이스시트 진단
// 베이스시트 의존성 제거됨 — DB(tab_configs)가 원본
// 하위 호환을 위해 엔드포인트는 유지하되, DB 기반 정보 반환
// ═══════════════════════════════════════════════════════════
router.get('/debug-base', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE NOT is_closed) AS active,
              COUNT(*) FILTER (WHERE is_closed) AS closed,
              COUNT(DISTINCT sheet_id) AS sheets
       FROM tab_configs`
    );
    const s = rows[0] || {};
    res.json({
      ok: true,
      message: '베이스시트 의존성 제거됨 — DB(tab_configs) 기반 정보 반환',
      stats: { total: +s.total, active: +s.active, closed: +s.closed, sheets: +s.sheets },
    });
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
// GET /api/index/preview-campaign — 캠페인 추가 전 시트 미리보기
// sheetId로 시트 제목과 탭 목록을 반환 (등록 전 확인용)
// ═══════════════════════════════════════════════════════════
router.get('/preview-campaign', authMiddleware, async (req, res, next) => {
  try {
    const { url, sheetId: rawSheetId } = req.query;
    const finalSheetId = rawSheetId || extractSheetId(url);
    if (!finalSheetId) {
      return res.json({ ok: false, error: 'sheetId 또는 url이 필요합니다.' });
    }

    // 시트 메타데이터 조회
    const meta = await getSpreadsheetMeta(finalSheetId);
    if (!meta || meta.length === 0) {
      return res.json({ ok: false, error: '시트에 접근할 수 없습니다. 서비스 계정에 공유되어 있는지 확인하세요.' });
    }

    const spreadsheetTitle = meta._spreadsheetTitle || finalSheetId;
    const systemTabs = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정',
                        '시트DB', '탭목록', 'tab_configs', '캠페인목록', '시트목록', '매크로', '서식', '요약', '대시보드', '템플릿', '양식'];
    const tabs = meta
      .filter(s => !systemTabs.includes(s.properties.title) && !s.properties.hidden)
      .map(s => ({
        name: s.properties.title,
        gid: String(s.properties.sheetId),
      }));

    // 이미 등록된 캠페인인지 확인
    const { rows: existingCamp } = await pool.query(
      'SELECT campaign_name FROM campaigns WHERE sheet_id = $1 LIMIT 1',
      [finalSheetId]
    );

    res.json({
      ok: true,
      sheetId: finalSheetId,
      spreadsheetTitle,
      tabs,
      tabCount: tabs.length,
      alreadyRegistered: existingCamp.length > 0,
      existingName: existingCamp[0]?.campaign_name || null,
    });
  } catch (err) {
    if (err.message && (err.message.includes('not found') || err.message.includes('404'))) {
      return res.json({ ok: false, error: '시트를 찾을 수 없습니다. URL을 확인하세요.' });
    }
    if (err.message && err.message.includes('permission')) {
      return res.json({ ok: false, error: '시트 접근 권한이 없습니다. 서비스 계정에 공유해주세요.' });
    }
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

    // ★ 시트DB 탭에도 추가 (A열: sheet_url, B열: campaign_name)
    const finalUrl = sheetUrl || url || `https://docs.google.com/spreadsheets/d/${finalSheetId}/edit`;
    let addedToSheetDB = false;
    try {
      const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID || '';
      if (MASTER_SHEET_ID) {
        // 시트DB 탭에서 기존 URL 목록 읽기 (중복 방지)
        const existing = await readSheet(MASTER_SHEET_ID, "'시트DB'!A:A");
        const existingIds = new Set();
        if (existing) {
          for (const row of existing) {
            const u = (row[0] || '').toString().trim();
            const m = u.match(/\/d\/([a-zA-Z0-9_-]+)/);
            if (m) existingIds.add(m[1]);
          }
        }

        if (!existingIds.has(finalSheetId)) {
          // 마지막 행 다음에 추가
          await appendSheet(MASTER_SHEET_ID, "'시트DB'!A:B", [[finalUrl, resolvedName]]);
          addedToSheetDB = true;
          logger.info(`[add-campaign] 시트DB에 추가: ${resolvedName} (${finalSheetId})`);
        } else {
          logger.info(`[add-campaign] 시트DB에 이미 존재: ${finalSheetId}`);
        }
      } else {
        logger.warn('[add-campaign] MASTER_SHEET_ID 미설정 — 시트DB 동기화 건너뜀');
      }
    } catch (sheetErr) {
      logger.error(`[add-campaign] 시트DB 추가 실패 (DB 등록은 완료): ${sheetErr.message}`);
    }

    res.json({ ok: true, sheetId: finalSheetId, campaignName: resolvedName, addedToSheetDB });
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
        im.tab_gid AS "imTabGid", tc.tab_gid AS "tcTabGid",
        COALESCE(im.tab_gid, tc.tab_gid) AS "tabGid",
        im.campaign_name AS "campaignName",
        im.row_count AS "totalCount", im.submitted_count AS "submittedCount",
        im.status, im.built_at AS "builtAt",
        tc.manager, tc.review_type AS "reviewType",
        tc.is_closed AS "isClosed"
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
// GET /api/diag/tab-gid-check — gid↔tab_name 매핑 검증 (임시 진단용)
// 특정 sheetId의 모든 탭에 대해 DB와 구글시트 실제 매핑을 비교
// ═══════════════════════════════════════════════════════════
router.get('/tab-gid-check', async (req, res, next) => {
  try {
    const { sheetId, gid } = req.query;
    if (!sheetId) return res.status(400).json({ ok: false, error: 'sheetId required' });

    // DB에서 해당 시트의 탭 매핑 (index_master + tab_configs)
    const { rows: imRows } = await pool.query(
      'SELECT tab_name, tab_gid, row_count, status FROM index_master WHERE sheet_id = $1 ORDER BY tab_name', [sheetId]
    );
    const { rows: tcRows } = await pool.query(
      'SELECT tab_name, tab_gid FROM tab_configs WHERE sheet_id = $1 ORDER BY tab_name', [sheetId]
    );

    // 대시보드 쿼리와 동일한 COALESCE 결과 확인
    let dashboardQuery = `
      SELECT im.tab_name, COALESCE(im.tab_gid, tc.tab_gid) AS "tabGid",
             im.tab_gid AS "imGid", tc.tab_gid AS "tcGid", im.row_count
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      WHERE im.sheet_id = $1 AND im.status = 'active'
    `;
    const params = [sheetId];
    if (gid) {
      dashboardQuery += ` AND (im.tab_gid = $2 OR tc.tab_gid = $2)`;
      params.push(gid);
    }
    dashboardQuery += ' ORDER BY im.tab_name';
    const { rows: dashRows } = await pool.query(dashboardQuery, params);

    res.json({
      ok: true,
      sheetId,
      filterGid: gid || null,
      indexMaster: gid ? imRows.filter(r => r.tab_gid === gid) : imRows.slice(0, 20),
      tabConfigs: gid ? tcRows.filter(r => r.tab_gid === gid) : tcRows.slice(0, 20),
      dashboardView: dashRows,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/dashboard-check — 대시보드 API와 동일 쿼리로 gid↔tab_name 검증
// ═══════════════════════════════════════════════════════════
router.get('/dashboard-check', async (req, res, next) => {
  try {
    const { sheetId, gid, tabName } = req.query;
    
    let sql = `
      SELECT
        im.sheet_id AS "sheetId",
        im.tab_name AS "tabName",
        COALESCE(im.tab_gid, tc.tab_gid) AS "tabGid",
        im.tab_gid AS "imTabGid",
        tc.tab_gid AS "tcTabGid",
        im.campaign_name AS "campaignName",
        im.row_count AS "totalCount",
        im.submitted_count AS "submittedCount",
        im.status
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      WHERE im.status = 'active'
    `;
    const params = [];
    if (sheetId) { params.push(sheetId); sql += ` AND im.sheet_id = $${params.length}`; }
    if (gid) { params.push(gid); sql += ` AND (im.tab_gid = $${params.length} OR tc.tab_gid = $${params.length})`; }
    if (tabName) { params.push(tabName); sql += ` AND im.tab_name = $${params.length}`; }
    sql += ' ORDER BY im.built_at DESC NULLS LAST';
    
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, count: rows.length, rows });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/sheet-meta — 구글시트 API에서 실제 탭 메타데이터 조회 (gid 검증용)
// ═══════════════════════════════════════════════════════════
router.get('/sheet-meta', async (req, res, next) => {
  try {
    const { sheetId } = req.query;
    if (!sheetId) return res.status(400).json({ error: 'sheetId 필수' });

    const meta = await getSpreadsheetMeta(sheetId);
    if (!meta || meta.length === 0) {
      return res.json({ ok: false, error: '메타데이터 조회 실패' });
    }

    const tabs = meta
      .filter(s => s.properties)
      .map(s => ({
        tabName: s.properties.title,
        gid: String(s.properties.sheetId),
        index: s.properties.index,
        hidden: !!s.properties.hidden,
      }));

    // DB의 tab_configs/index_master와 비교
    const { rows: dbTabs } = await pool.query(
      `SELECT tc.tab_name, tc.tab_gid AS tc_gid, im.tab_gid AS im_gid
       FROM tab_configs tc
       LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
       WHERE tc.sheet_id = $1
       ORDER BY tc.tab_name`,
      [sheetId]
    );

    // 불일치 감지
    const dbMap = new Map(dbTabs.map(t => [t.tab_name, t]));
    const mismatches = [];
    for (const tab of tabs) {
      const db = dbMap.get(tab.tabName);
      if (db) {
        const dbGid = db.tc_gid || db.im_gid;
        if (dbGid && dbGid !== tab.gid) {
          mismatches.push({
            tabName: tab.tabName,
            actualGid: tab.gid,
            dbGid,
            source: db.tc_gid ? 'tab_configs' : 'index_master',
          });
        }
      }
    }

    res.json({
      ok: true,
      title: meta._spreadsheetTitle || '',
      totalTabs: tabs.length,
      hiddenTabs: tabs.filter(t => t.hidden).length,
      dbTabs: dbTabs.length,
      mismatches: mismatches.length,
      mismatchDetails: mismatches,
      hiddenDetails: tabs.filter(t => t.hidden).map(t => ({ tabName: t.tabName, gid: t.gid })),
      tabs: tabs,
    });
  } catch (err) {
    next(err);
  }
});

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
// POST /api/diag/fix-campaign-names — 캠페인명 일괄 수정
// 각 sheetId에 대해 Google Sheets API로 실제 스프레드시트 제목을 가져와
// index_master와 review_index의 campaign_name을 업데이트
// ═══════════════════════════════════════════════════════════
router.post('/fix-campaign-names', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun } = req.body || {};

    // 1. 고유 sheetId 목록 조회
    const { rows: sheetRows } = await pool.query(`
      SELECT DISTINCT sheet_id FROM index_master WHERE status = 'active'
    `);

    if (sheetRows.length === 0) {
      return res.json({ ok: true, message: '업데이트할 시트가 없습니다.', updated: 0 });
    }

    const results = [];
    let updatedSheets = 0;
    let updatedMasterRows = 0;
    let updatedIndexRows = 0;
    let errorCount = 0;

    // 2. 각 sheetId에 대해 스프레드시트 제목 조회
    for (const row of sheetRows) {
      const sheetId = row.sheet_id;
      try {
        const meta = await getSpreadsheetMeta(sheetId);
        const spreadsheetTitle = meta._spreadsheetTitle || '';

        if (!spreadsheetTitle) {
          results.push({ sheetId: sheetId.substring(0, 20) + '...', title: '(제목 없음)', status: 'skipped' });
          continue;
        }

        // 현재 DB의 캠페인명 확인
        const { rows: currentNames } = await pool.query(
          `SELECT DISTINCT campaign_name FROM index_master WHERE sheet_id = $1`,
          [sheetId]
        );
        const currentName = currentNames.map(r => r.campaign_name).join(', ');

        if (!dryRun) {
          // index_master 업데이트
          const masterResult = await pool.query(
            `UPDATE index_master SET campaign_name = $1 WHERE sheet_id = $2 AND campaign_name != $1`,
            [spreadsheetTitle, sheetId]
          );
          updatedMasterRows += masterResult.rowCount;

          // review_index 업데이트
          const indexResult = await pool.query(
            `UPDATE review_index SET campaign_name = $1 WHERE sheet_id = $2 AND campaign_name != $1`,
            [spreadsheetTitle, sheetId]
          );
          updatedIndexRows += indexResult.rowCount;
        }

        results.push({
          sheetId: sheetId.substring(0, 20) + '...',
          oldCampaignName: currentName,
          newCampaignName: spreadsheetTitle,
          changed: currentName !== spreadsheetTitle,
          status: dryRun ? 'dry_run' : 'updated',
        });
        updatedSheets++;

      } catch (err) {
        results.push({
          sheetId: sheetId.substring(0, 20) + '...',
          status: 'error',
          error: err.message,
        });
        errorCount++;
      }
    }

    res.json({
      ok: true,
      dryRun: !!dryRun,
      totalSheets: sheetRows.length,
      updatedSheets,
      updatedMasterRows,
      updatedIndexRows,
      errorCount,
      results,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/sheet-titles — 현재 등록된 모든 시트의 실제 제목 조회 (진단용)
// ═══════════════════════════════════════════════════════════
router.get('/sheet-titles', authMiddleware, async (req, res, next) => {
  try {
    // DB에서 고유 sheetId + 현재 campaign_name 조회
    const { rows: sheetRows } = await pool.query(`
      SELECT sheet_id, campaign_name, COUNT(*) AS tab_count
      FROM index_master
      WHERE status = 'active'
      GROUP BY sheet_id, campaign_name
      ORDER BY tab_count DESC
    `);

    // 각 sheetId에 대해 Google API로 실제 제목 조회
    const titles = [];
    for (const row of sheetRows) {
      const sheetId = row.sheet_id;
      let actualTitle = null;
      let error = null;

      try {
        const meta = await getSpreadsheetMeta(sheetId);
        actualTitle = meta._spreadsheetTitle || null;
      } catch (err) {
        error = err.message;
      }

      titles.push({
        sheetId: sheetId.substring(0, 20) + '...',
        fullSheetId: sheetId,
        currentCampaignName: row.campaign_name,
        actualSpreadsheetTitle: actualTitle,
        tabCount: parseInt(row.tab_count),
        mismatch: actualTitle && actualTitle !== row.campaign_name,
        error,
      });
    }

    res.json({
      ok: true,
      total: titles.length,
      mismatches: titles.filter(t => t.mismatch).length,
      titles,
    });
  } catch (err) {
    next(err);
  }
});

// ── 헬퍼 ──
function extractSheetId(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════════════════════
// POST /api/diag/cleanup-empty-indexes — row_count=0인 탭 일괄 정리
// ═══════════════════════════════════════════════════════════
router.post('/cleanup-empty-indexes', authMiddleware, async (req, res) => {
  try {
    const dryRun = req.body.dryRun !== false; // 기본값 dry-run

    // 정리 대상 조회
    const { rows: targets } = await pool.query(`
      SELECT sheet_id, tab_name, campaign_name, row_count, submitted_count
      FROM index_master
      WHERE row_count = 0 OR row_count IS NULL
      ORDER BY campaign_name, tab_name
    `);

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        totalTargets: targets.length,
        targets: targets.map(t => ({
          sheetId: t.sheet_id,
          tabName: t.tab_name,
          campaignName: t.campaign_name,
        })),
      });
    }

    // 실제 삭제 실행
    let masterDeleted = 0, indexDeleted = 0;
    for (const t of targets) {
      const r1 = await pool.query(
        'DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
        [t.sheet_id, t.tab_name]
      );
      const r2 = await pool.query(
        'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2',
        [t.sheet_id, t.tab_name]
      );
      masterDeleted += r1.rowCount;
      indexDeleted += r2.rowCount;
    }

    res.json({
      ok: true,
      dryRun: false,
      totalTargets: targets.length,
      masterDeleted,
      indexDeleted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/debug-parse — 특정 탭의 parseTabRows 디버그
//   ?sheetId=xxx&tabName=xxx
// ═══════════════════════════════════════════════════════════
router.get('/debug-parse', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    const { batchReadSheet } = require('../services/sheets.service');

    // 시트 데이터 읽기 (두 가지 방식 비교)
    let values, valuesBatch;
    // 방식 1: readSheet (단일 get)
    try {
      const result = await readSheet(sheetId, `'${tabName}'`);
      values = result || [];
    } catch (err) {
      return res.json({ ok: false, error: `시트 읽기 실패: ${err.message}` });
    }
    // 방식 2: batchReadSheet (batchGet — buildIndexSmart와 동일)
    try {
      const batchResult = await batchReadSheet(sheetId, [`'${tabName}'!A:Z`]);
      const batchItem = batchResult[0];
      valuesBatch = batchItem?.values || [];
    } catch (err) {
      valuesBatch = [];
    }

    // DB에서 키워드 로드
    let dataTabKeywords, nameKeywords;
    try {
      const { rows } = await pool.query(
        "SELECT category, keyword FROM index_keywords WHERE active = TRUE ORDER BY category, keyword"
      );
      const grouped = {};
      rows.forEach(r => {
        if (!grouped[r.category]) grouped[r.category] = [];
        grouped[r.category].push(r.keyword);
      });
      dataTabKeywords = grouped['data_tab'] || ['번호','주문자','수취인','수취인명','성함','이름','성명','신청자','연락처','전화번호'];
      nameKeywords = grouped['name'] || ['수취인','이름','신청자','참여자','수취인명','주문자','성함','예금주','성명'];
    } catch (_) {
      dataTabKeywords = ['번호','주문자','수취인','수취인명','성함','이름','성명','신청자','연락처','전화번호'];
      nameKeywords = ['수취인','이름','신청자','참여자','수취인명','주문자','성함','예금주','성명'];
    }

    // _isDataTabRow 시뮬레이션 (50행 스캔)
    const HEADER_SCAN_LIMIT = 50;
    let headerRowIdx = -1;
    const scanResults = [];

    for (let i = 0; i < Math.min(values.length, HEADER_SCAN_LIMIT); i++) {
      const cells = values[i] ? values[i].map(c => String(c || '').trim()) : [];
      let matchCount = 0;
      const matchedKws = [];
      for (const kw of dataTabKeywords) {
        const found = kw === '번호'
          ? cells.includes(kw)
          : cells.some(c => c.includes(kw));
        if (found) {
          matchCount++;
          matchedKws.push(kw);
        }
      }
      if (matchCount >= 1) {
        scanResults.push({ row: i, matchCount, matchedKws, cells: cells.slice(0, 20), isHeader: matchCount >= 2 });
      }
      if (matchCount >= 2 && headerRowIdx < 0) {
        headerRowIdx = i;
      }
    }

    // nameCol 매칭 시뮬레이션
    let nameColIdx = -1;
    let nameMatchDetail = null;
    if (headerRowIdx >= 0) {
      const headers = values[headerRowIdx].map(h => String(h || '').trim());
      nameColIdx = headers.findIndex(h => nameKeywords.some(k => h.includes(k)));
      if (nameColIdx >= 0) {
        const matchedKw = nameKeywords.find(k => headers[nameColIdx].includes(k));
        nameMatchDetail = { colIdx: nameColIdx, header: headers[nameColIdx], matchedKeyword: matchedKw };
      }
    }

    // 실제 parseTabRows 호출 결과 (production과 동일한 코드 사용)
    let realParseResult = null;
    try {
      const realRows = parseTabRows(values, sheetId, tabName, '0', 'debug');
      realParseResult = {
        rowCount: realRows.length,
        firstRow: realRows.length > 0 ? { name: realRows[0].name, rowIndex: realRows[0].rowIndex, submitCol: realRows[0].submitCol } : null,
      };
    } catch (parseErr) {
      realParseResult = { error: parseErr.message };
    }

    // batchGet 데이터로도 parseTabRows 호출
    let batchParseResult = null;
    try {
      const batchRows = parseTabRows(valuesBatch, sheetId, tabName, '0', 'debug-batch');
      batchParseResult = {
        rowCount: batchRows.length,
        firstRow: batchRows.length > 0 ? { name: batchRows[0].name, rowIndex: batchRows[0].rowIndex, submitCol: batchRows[0].submitCol } : null,
      };
    } catch (parseErr) {
      batchParseResult = { error: parseErr.message };
    }

    res.json({
      ok: true,
      totalRows: values.length,
      totalCols: values[0] ? values[0].length : 0,
      headerRowIdx,
      nameColIdx,
      nameMatchDetail,
      scanResults,
      dataTabKeywords,
      nameKeywords,
      realParseResult,
      batchParseResult,
      batchComparison: {
        batchRows: valuesBatch.length,
        batchCols: valuesBatch[0] ? valuesBatch[0].length : 0,
        headerRowMatch: valuesBatch.length > headerRowIdx && headerRowIdx >= 0
          ? (valuesBatch[headerRowIdx] || []).map(c => String(c || '').trim()).slice(0, 20)
          : null,
        identical: values.length === valuesBatch.length,
      },
      firstRows: values.slice(0, Math.min(values.length, 55)).map((r, i) => ({
        row: i,
        cols: (r || []).length,
        cells: (r || []).map(c => String(c || '').trim()).slice(0, 20)
      }))
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/archive-detect-debug — 아카이브 감지 디버그
// tab_configs(is_closed)와 index_master 매칭 확인
// ═══════════════════════════════════════════════════════════
router.get('/archive-detect-debug', authMiddleware, async (req, res, next) => {
  try {
    // 1) tab_configs에서 is_closed 탭 수
    const { rows: tcStats } = await pool.query(`
      SELECT 
        count(*) AS total,
        count(*) FILTER (WHERE is_closed = TRUE) AS closed_count,
        count(*) FILTER (WHERE is_closed = TRUE) AS either_count
      FROM tab_configs
    `);

    // 2) index_master 총 건수 및 status 분포
    const { rows: imStats } = await pool.query(`
      SELECT 
        count(*) AS total,
        count(*) FILTER (WHERE status = 'active') AS active_count,
        count(*) FILTER (WHERE row_count > 0 AND submitted_count >= row_count) AS completed_count
      FROM index_master
    `);

    // 3) tab_configs(closed)와 index_master의 교집합
    const { rows: joinStats } = await pool.query(`
      SELECT 
        count(*) AS matched_count
      FROM tab_configs tc
      INNER JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      WHERE tc.is_closed = TRUE
        AND im.status = 'active'
    `);

    // 4) tab_configs(closed)인데 index_master에 없는 탭 (샘플 10개)
    const { rows: missingInIM } = await pool.query(`
      SELECT tc.sheet_id, tc.tab_name, tc.is_closed, tc.campaign_name
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      WHERE tc.is_closed = TRUE
        AND im.sheet_id IS NULL
      LIMIT 10
    `);

    // 5) tab_configs(closed)인데 index_master status != 'active'
    const { rows: notActiveInIM } = await pool.query(`
      SELECT im.sheet_id, im.tab_name, im.status, tc.is_closed
      FROM tab_configs tc
      INNER JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      WHERE tc.is_closed = TRUE
        AND im.status != 'active'
      LIMIT 10
    `);

    // 6) 현재 detect 쿼리와 동일한 결과 (건수만)
    const { rows: detectResult } = await pool.query(`
      SELECT count(*) AS detect_count
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      WHERE im.status = 'active'
        AND (
          tc.is_closed = TRUE
          OR (im.row_count > 0 AND im.submitted_count >= im.row_count)
        )
    `);

    res.json({
      ok: true,
      tab_configs: tcStats[0],
      index_master: imStats[0],
      matched_active_count: joinStats[0]?.matched_count || 0,
      missing_in_index_master: { count: missingInIM.length, sample: missingInIM },
      not_active_in_index_master: { count: notActiveInIM.length, sample: notActiveInIM },
      detect_query_count: detectResult[0]?.detect_count || 0,
    });
  } catch (err) { next(err); }
});

module.exports = router;
