const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta, writeSheet, appendSheet, copySpreadsheet, copySheetToSpreadsheet, renameSheet, shareSheetWithServiceAccount, checkSheetWriteAccess } = require('../services/sheets.service');
const { getQueueStats, retryItem, retryAllFailed, purgeCompleted, deleteItem, deleteAllFailed, processQueue, drainTabQueue } = require('../services/syncQueue.service');
const { imageApiLimiter } = require('../middleware/rateLimit.middleware');
const { extractOrderFromImage, verifyAddressMatch } = require('../services/gemini.service');
const driveService = require('../services/drive.service');
const { getMetricsSummary, resetMetrics } = require('../middleware/metrics.middleware');
const { isSentryEnabled } = require('../utils/sentry');
const { addClient, getStatus: getSSEStatus, emitImageExtract, emitImageUpload } = require('../utils/sse');
const { logger } = require('../utils/logger');
const { logAbnormal } = require('../services/errorLog.service');
const { parseTabRows, buildOneSheet } = require('../services/indexBuilder.service');
const { mirrorOneSheet } = require('../services/rawMirror.service');

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
router.post('/check-duplicate', authMiddleware, async (req, res, next) => {
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
router.get('/viewer-data', authMiddleware, async (req, res, next) => {
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
      const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '(미설정)';
      return res.json({ ok: false, error: `시트에 접근할 수 없습니다. 아래 서비스 계정에 공유해주세요.`, serviceAccount: sa });
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
      const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '(미설정)';
      return res.json({ ok: false, error: `시트 접근 권한이 없습니다. 아래 서비스 계정에 공유해주세요.`, serviceAccount: sa });
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

    // ★ 중복 등록 방지: 이미 campaigns에 등록된 sheet_id인지 확인
    const { rows: existingCampaigns } = await pool.query(
      'SELECT campaign_name FROM campaigns WHERE sheet_id = $1 LIMIT 1',
      [finalSheetId]
    );
    if (existingCampaigns.length > 0) {
      const existingName = existingCampaigns[0].campaign_name;
      return res.json({
        error: `이미 등록된 캠페인입니다 (${existingName}).\n기존에 등록된 작업시트는 스마트빌드 갱신 시 새 탭이 자동으로 인식됩니다.\n별도로 다시 등록할 필요가 없습니다.`,
        duplicate: true,
        existingCampaignName: existingName,
        sheetId: finalSheetId,
      });
    }

    // 시트 메타데이터에서 캠페인명 가져오기
    // ★ meta._spreadsheetTitle = 스프레드시트 전체 제목 (문서명)
    // ★ meta[0].properties.title = 첫 번째 탭 이름 (잘못된 값이었음)
    let resolvedName = finalCampaignName;
    if (!resolvedName) {
      try {
        const meta = await getSpreadsheetMeta(finalSheetId);
        if (meta && meta._spreadsheetTitle) {
          resolvedName = meta._spreadsheetTitle;
        } else if (meta && meta.length > 0) {
          resolvedName = finalSheetId; // fallback: sheetId 사용 (탭명 사용 안 함)
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

    // tab_configs에도 해당 시트의 탭 목록 동기화 (★ GID + sheet_url#gid= 포함)
    let autoInsertedTabs = 0;
    try {
      const meta = await getSpreadsheetMeta(finalSheetId);
      const systemTabs = ['세부목록', '검색인덱스', '인덱스마스터', '인덱스데이터', '마감', '상세목록', '탭설정', '설정'];
      // ★ 아카이브된 탭은 재등록하지 않음 (이름 + gid 양쪽 매칭)
      const { rows: archivedTabs } = await pool.query(
        'SELECT tab_name, tab_gid FROM index_master_archive WHERE sheet_id = $1',
        [finalSheetId]
      );
      const archivedSet = new Set(archivedTabs.map(r => r.tab_name));
      const archivedGidSet = new Set(archivedTabs.filter(r => r.tab_gid).map(r => String(r.tab_gid)));
      for (const sheet of meta) {
        const tabName = sheet.properties.title;
        if (systemTabs.includes(tabName)) continue;
        const tabGid = String(sheet.properties.sheetId);
        // 아카이브된(마감 후 정리된) 탭이면 스킵 — 대시보드 재등장 방지
        if (archivedSet.has(tabName) || archivedGidSet.has(tabGid)) continue;
        const tabSheetUrl = `https://docs.google.com/spreadsheets/d/${finalSheetId}/edit#gid=${tabGid}`;
        await pool.query(
          `INSERT INTO tab_configs (sheet_id, tab_name, campaign_name, sheet_url, tab_gid)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
             campaign_name = COALESCE(NULLIF(tab_configs.campaign_name,''), EXCLUDED.campaign_name),
             sheet_url = EXCLUDED.sheet_url,
             tab_gid = COALESCE(NULLIF(tab_configs.tab_gid,''), EXCLUDED.tab_gid),
             updated_at = NOW()`,
          [finalSheetId, tabName, resolvedName, tabSheetUrl, tabGid]
        );
        autoInsertedTabs++;
      }
    } catch (_) { /* 메타 로드 실패 시 무시 */ }

    // ★ 서비스 계정에 시트 편집자 권한 자동 부여 (비차단: 실패해도 등록은 유지)
    let shareResult = null;
    try {
      shareResult = await shareSheetWithServiceAccount(finalSheetId);
      if (shareResult.alreadyShared) {
        logger.info(`[add-campaign] 시트 권한 이미 존재: ${finalSheetId} (${shareResult.method})`);
      } else {
        logger.info(`[add-campaign] 시트 권한 자동 부여 완료: ${finalSheetId} (${shareResult.method})`);
      }
    } catch (shareErr) {
      logger.warn(`[add-campaign] 시트 권한 자동 부여 실패 (등록은 완료): ${finalSheetId} — ${shareErr.message}`);
      shareResult = { ok: false, error: shareErr.message };
    }

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

    // ★ RAW 미러 즉시 반영 (best-effort, 비차단 — 등록과 동시에 RAW 미러에 채워짐)
    //   단일 시트만 미러(전체 미러 대기 없음), throttle 경유라 쿼터 안전. 실패해도 등록은 유지.
    setImmediate(() => {
      mirrorOneSheet(finalSheetId).catch(mirrorErr =>
        logger.warn(`[add-campaign] RAW 미러 즉시반영 실패 (등록은 완료): ${mirrorErr.message}`)
      );
    });

    res.json({ ok: true, sheetId: finalSheetId, campaignName: resolvedName, addedToSheetDB, shareResult, autoInsertedTabs, url: `https://docs.google.com/spreadsheets/d/${finalSheetId}/edit` });
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

// ═══════════════════════════════════════════════════════════
// GET /api/diag/campaign-stats — 캠페인 통계 (GAS: getCampaignStats)
// ═══════════════════════════════════════════════════════════
router.get('/campaign-stats', authMiddleware, async (req, res, next) => {
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
router.get('/tab-gid-check', authMiddleware, async (req, res, next) => {
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
router.get('/dashboard-check', authMiddleware, async (req, res, next) => {
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
// GET /api/diag/dashboard-roundlist — 대시보드에서 roundList가 어떻게 생성되는지 확인
// ═══════════════════════════════════════════════════════════
router.get('/dashboard-roundlist', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.query;
    // 대시보드 API와 동일한 쿼리로 roundDataMap 구성
    let reviewSql = `
      SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
             ri.is_submitted AS "isSubmitted", ri.round,
             ri.start_date AS "startDate"
      FROM review_index ri
      INNER JOIN index_master im ON ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name
      WHERE im.status = 'active'
    `;
    const params = [];
    if (sheetId) { params.push(sheetId); reviewSql += ` AND ri.sheet_id = $${params.length}`; }
    const { rows: reviewRows } = await pool.query(reviewSql, params);

    const roundDataMap = {};
    for (const row of reviewRows) {
      const tabKey = `${row.sheetId}||${row.tabName}`;
      const roundVal = (row.round || '').trim();
      if (roundVal) {
        if (!roundDataMap[tabKey]) roundDataMap[tabKey] = {};
        if (!roundDataMap[tabKey][roundVal]) {
          roundDataMap[tabKey][roundVal] = { total: 0, submitted: 0, pending: 0, startDate: null };
        }
        const rd = roundDataMap[tabKey][roundVal];
        rd.total++;
        if (row.isSubmitted) rd.submitted++;
        else rd.pending++;
        if (row.startDate) {
          if (!rd.startDate || row.startDate < rd.startDate) rd.startDate = row.startDate;
        }
      }
    }

    // roundList 생성 (대시보드와 동일 로직)
    const result = {};
    for (const [tabKey, rdMap] of Object.entries(roundDataMap)) {
      const roundList = Object.entries(rdMap)
        .map(([roundVal, rd]) => ({
          round: roundVal, total: rd.total, submitted: rd.submitted, pending: rd.pending, startDate: rd.startDate || '',
        }))
        .sort((a, b) => {
          const numA = parseInt(a.round.replace(/[^0-9]/g, '')) || 0;
          const numB = parseInt(b.round.replace(/[^0-9]/g, '')) || 0;
          return numA - numB;
        });
      result[tabKey] = roundList;
    }

    res.json({ ok: true, totalReviewRows: reviewRows.length, roundLists: result });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/round-check — review_index의 round 데이터 진단
// ═══════════════════════════════════════════════════════════
router.get('/round-check', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    let sql = `
      SELECT ri.sheet_id AS "sheetId", ri.tab_name AS "tabName",
             ri.round, COUNT(*) AS cnt,
             COUNT(*) FILTER (WHERE ri.is_submitted) AS submitted,
             COUNT(*) FILTER (WHERE NOT ri.is_submitted) AS pending
      FROM review_index ri
      INNER JOIN index_master im ON ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name AND im.status = 'active'
    `;
    const params = [];
    if (sheetId) { params.push(sheetId); sql += ` AND ri.sheet_id = $${params.length}`; }
    if (tabName) { params.push(tabName); sql += ` AND ri.tab_name = $${params.length}`; }
    sql += ` GROUP BY ri.sheet_id, ri.tab_name, ri.round ORDER BY ri.sheet_id, ri.tab_name, ri.round`;
    const { rows } = await pool.query(sql, params);

    // 탭별 요약
    const summary = {};
    for (const r of rows) {
      const key = `${r.sheetId}||${r.tabName}`;
      if (!summary[key]) summary[key] = { sheetId: r.sheetId, tabName: r.tabName, rounds: [] };
      summary[key].rounds.push({
        round: r.round || '(빈값)',
        count: +r.cnt,
        submitted: +r.submitted,
        pending: +r.pending,
      });
    }
    res.json({ ok: true, totalRows: rows.length, tabs: Object.values(summary) });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/sheet-meta — 구글시트 API에서 실제 탭 메타데이터 조회 (gid 검증용)
// ═══════════════════════════════════════════════════════════
router.get('/sheet-meta', authMiddleware, async (req, res, next) => {
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

router.get('/inaed-list', authMiddleware, async (req, res, next) => {
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
router.get('/drive-diag', authMiddleware, async (req, res) => {
  const results = {
    rootFolderId: process.env.DRIVE_ROOT_FOLDER_ID || 'NOT SET',
    authStatus: driveService.getOAuthStatus(),
  };

  // 실제 OAuth 계정/쿼터 — 업로드 용량이 어느 계정에 귀속되는지
  try {
    results.accountDiagnostics = await driveService.getAccountDiagnostics();
  } catch (e) {
    results.accountDiagnostics = { error: e.message };
  }

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
    logAbnormal({
      flow: 'image_extract', step: 'gemini_call', source: 'external_api', error: err,
      context: { path: req.path, method: 'POST' },
    });
    res.json({
      ok: false,
      error: err.message || '이미지 분석 중 오류가 발생했습니다.',
      orderNumber: '', recipient: '', phone: '', address: '', price: ''
    });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/upload — 주문캡처 이미지 Drive 업로드 (새 3단계 구조)
//
// 폴더 구조: AI_REVIEW_FOLDER → {시트제목} → {탭명} → [구매캡처]
// 프론트엔드 페이로드:
//   { imageBase64, mimeType, fileName, displayName, tabName, round, sheetId,
//     savedCaptureFolderUrl }
//
// 폴더 접근 우선순위:
//   1. savedCaptureFolderUrl (프론트엔드 전달)
//   2. tab_configs.capture_folder_url (DB)
//   3. 자동 생성 (ensureCaptureFolderPath)
// ═══════════════════════════════════════════════════════════
router.post('/image-upload', imageApiLimiter, async (req, res, next) => {
  try {
    const { imageBase64, mimeType, fileName, displayName, tabName, round, sheetId, savedCaptureFolderUrl } = req.body;
    if (!imageBase64) return res.json({ ok: false, error: '이미지 데이터가 필요합니다.' });

    const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      logger.warn('[image-upload] AI_REVIEW_FOLDER_ID 미설정');
      return res.json({ ok: false, error: 'Drive 루트 폴더가 설정되지 않았습니다. (AI_REVIEW_FOLDER_ID)' });
    }

    // ── 1단계: 캡처 폴더 ID 확보 (3단계 폴백) ──
    let targetFolderId = null;
    let captureFolderUrl = null;

    // STEP 1: savedCaptureFolderUrl (프론트엔드 전달)
    if (savedCaptureFolderUrl) {
      targetFolderId = driveService.extractFolderIdFromUrl(savedCaptureFolderUrl);
      if (targetFolderId) {
        captureFolderUrl = savedCaptureFolderUrl;
        logger.info(`[image-upload] savedCaptureFolderUrl 사용: ${targetFolderId}`);
      }
    }

    // STEP 2: tab_configs.capture_folder_url (DB)
    if (!targetFolderId && sheetId && tabName) {
      const { rows } = await pool.query(
        'SELECT capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      if (rows[0]?.capture_folder_url) {
        targetFolderId = driveService.extractFolderIdFromUrl(rows[0].capture_folder_url);
        if (targetFolderId) {
          captureFolderUrl = rows[0].capture_folder_url;
          logger.info(`[image-upload] DB capture_folder_url 사용: ${targetFolderId}`);
        }
      }
    }

    // STEP 3: 자동 생성 (3단계 구조: 시트제목 → 탭명 → [구매캡처])
    if (!targetFolderId) {
      try {
        // 시트 제목 조회
        let sheetTitle = displayName || tabName || '기타';
        if (sheetId) {
          try {
            // campaign_name에서 먼저 조회
            const { rows: campRows } = await pool.query(
              `SELECT DISTINCT campaign_name FROM tab_configs WHERE sheet_id = $1 AND campaign_name IS NOT NULL AND campaign_name <> '' LIMIT 1`,
              [sheetId]
            );
            if (campRows[0]?.campaign_name) {
              sheetTitle = campRows[0].campaign_name;
            } else {
              // Sheets API로 시트 제목 조회
              const meta = await getSpreadsheetMeta(sheetId);
              if (meta._spreadsheetTitle) sheetTitle = meta._spreadsheetTitle;
            }
          } catch (_) {}
        }

        const tabFolderName = tabName || '기타';
        logger.info(`[image-upload] 폴더 자동 생성: ${sheetTitle} → ${tabFolderName} → [구매캡처]`);

        const result = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tabFolderName);
        targetFolderId = result.id;
        captureFolderUrl = result.url;

        logger.info(`[image-upload] 캡처폴더 확보: ${targetFolderId} (${result.path.join(' → ')})`);

        // tab_configs에 캡처폴더 URL 저장
        if (sheetId && tabName) {
          await pool.query(
            'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [captureFolderUrl, sheetId, tabName]
          );
        }
      } catch (folderErr) {
        logger.error(`[image-upload] 폴더 생성 실패: ${folderErr.message}`);
        targetFolderId = rootFolderId;
      }
    }

    // ── 2단계: 차수별 서브폴더 (round) ──
    if (round) {
      const sub = await driveService.getOrCreateSubFolder(targetFolderId, String(round));
      targetFolderId = sub.id;
    }

    // ── 3단계: 중복 파일 처리 (동일 이름 → 휴지통 이동) ──
    const finalFileName = fileName || `캡처_${Date.now()}.jpg`;
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

    // ── SSE 알림 ──
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
      captureFolderUrl: captureFolderUrl || '',
    });
  } catch (err) {
    logger.error(`[image-upload] ${err.message}`);
    logAbnormal({
      flow: 'order_submit', step: 'image_upload', source: 'external_api', error: err,
      context: { path: req.path, method: 'POST', tabName: req.body?.tabName, round: req.body?.round, sheetId: req.body?.sheetId },
    });
    res.json({ ok: false, error: err.message || '이미지 업로드 중 오류가 발생했습니다.' });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/review-upload — 리뷰 이미지 Drive 업로드 (새 4단계 구조)
//
// 폴더 구조: AI_REVIEW_FOLDER → {시트제목} → {탭명} → [리뷰] → [옵션(선택)]
// 파일명 규칙: {reviewerName}_{index}_{yyyyMMdd_HHmmss}.{ext}
//
// 프론트엔드 페이로드:
//   { sheetId, tabName, reviewerName, campaignName, optionFolderName,
//     files: [{ data: base64, mimeType, name? }] }
// ═══════════════════════════════════════════════════════════
router.post('/review-upload', imageApiLimiter, async (req, res, next) => {
  try {
    const { sheetId, tabName, reviewerName, campaignName, optionFolderName, files, gid, rowIndex, submitCol, memo, slotKey } = req.body;
    const slot = (slotKey || 'review').toString().trim() || 'review';

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.json({ ok: false, error: '업로드할 파일이 필요합니다.' });
    }
    if (!sheetId || !tabName) {
      return res.json({ ok: false, error: 'sheetId, tabName이 필요합니다.' });
    }

    const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      return res.json({ ok: false, error: 'AI_REVIEW_FOLDER_ID 미설정' });
    }

    // ── 1단계: 리뷰 폴더 ID 확보 ──
    let targetFolderId = null;
    let reviewFolderUrl = null;

    // STEP 1: tab_configs.folder_url (DB)
    const { rows: tabRows } = await pool.query(
      'SELECT folder_url, campaign_name, capture_slots FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );

    // 슬롯 라벨 해석: capture_slots에서 slot.key에 매칭되는 label을 찾는다.
    //   기본 'review' 슬롯은 하위폴더를 만들지 않아 기존 레이아웃을 그대로 유지한다.
    let slotLabel = null;
    if (slot !== 'review') {
      const slotsCfg = Array.isArray(tabRows[0]?.capture_slots) ? tabRows[0].capture_slots : [];
      const matched = slotsCfg.find(s => s && s.key === slot);
      slotLabel = (matched?.label || slot).toString().trim() || null;
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
      if (sheetId) {
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

    // ── 1.5단계: 슬롯 서브폴더 ([리뷰] → {슬롯라벨}) ──
    // 'review'(기본) 슬롯은 하위폴더 없이 [리뷰] 바로 아래 — 기존 동작/정리로직 보존.
    // 그 외 슬롯(예: 현금영수증)은 라벨 서브폴더로 분리한다.
    if (slotLabel) {
      const slotFolder = await driveService.getOrCreateSubFolder(targetFolderId, slotLabel);
      targetFolderId = slotFolder.id;
      logger.info(`[review-upload] 슬롯 서브폴더: ${slotLabel} → ${slotFolder.id}`);
    }

    // ── 2단계: 옵션 서브폴더 (있으면) ──
    if (optionFolderName) {
      const optFolder = await driveService.getOrCreateSubFolder(targetFolderId, optionFolderName);
      targetFolderId = optFolder.id;
      logger.info(`[review-upload] 옵션 서브폴더: ${optionFolderName} → ${optFolder.id}`);
    }

    // ── 3단계: 파일 업로드 (복수 파일 루프) ──
    const uploadResults = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.data) continue;

      // 파일명 생성: {reviewerName}_{index}_{yyyyMMdd_HHmmss}.{ext}
      const reviewFileName = driveService.generateReviewFileName(
        reviewerName || '익명',
        i + 1,
        file.mimeType || 'image/jpeg'
      );

      try {
        const uploaded = await driveService.uploadFileBase64(
          file.data,
          reviewFileName,
          file.mimeType || 'image/jpeg',
          targetFolderId
        );

        uploadResults.push({
          index: i + 1,
          fileId: uploaded.id,
          fileName: uploaded.name,
          webViewLink: uploaded.webViewLink || '',
        });

        logger.info(`[review-upload] 파일 ${i + 1}/${files.length} 업로드: ${uploaded.name} → ${uploaded.id}`);
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
      //     대표 리뷰 이미지를 덮어쓰지 않도록 가드(슬롯별 진실은 A-2 원장에 있음).
      if (slot === 'review') {
        try {
          const fileUrl = primary.webViewLink || `https://drive.google.com/file/d/${primary.fileId}/view`;
          await pool.query(
            `UPDATE review_index
                SET review_file_id = $1, review_file_url = $2, review_file_name = $3,
                    review_file_count = $4, review_file_at = NOW()
              WHERE sheet_id = $5 AND tab_name = $6 AND row_index = $7`,
            [primary.fileId, fileUrl, primary.fileName, successCount, sheetId, tabName, rowIdx]
          );
        } catch (linkErr) {
          logger.warn(`[review-upload] 인덱스 파일링크 저장 실패 (무시): ${linkErr.message}`);
        }
      }

      // A-2: 업로드된 모든 파일을 review_submissions 원장에 적재 (file_id 업서트)
      for (const r of uploadResults) {
        if (!r.fileId) continue;
        try {
          const fUrl = r.webViewLink || `https://drive.google.com/file/d/${r.fileId}/view`;
          await pool.query(
            `INSERT INTO review_submissions
               (sheet_id, tab_name, tab_gid, row_index, reviewer_name, review_index_id,
                file_id, file_url, file_name, source, slot_key, uploaded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'upload',$10,NOW())
             ON CONFLICT (file_id) DO UPDATE
               SET file_url = EXCLUDED.file_url, file_name = EXCLUDED.file_name,
                   row_index = EXCLUDED.row_index, review_index_id = EXCLUDED.review_index_id,
                   reviewer_name = EXCLUDED.reviewer_name, slot_key = EXCLUDED.slot_key`,
            [sheetId, tabName, gid || null, rowIdx, reviewerName || null, reviewIndexId,
             r.fileId, fUrl, r.fileName, slot]
          );
        } catch (subErr) {
          logger.warn(`[review-upload] 제출원장 기록 실패 (무시): ${subErr.message}`);
        }
      }
    }

    res.json({
      ok: successCount > 0,
      uploaded: successCount,
      total: files.length,
      files: uploadResults,
      reviewFolderUrl: reviewFolderUrl || '',
    });
  } catch (err) {
    logger.error(`[review-upload] ${err.message}`);
    res.json({ ok: false, error: err.message || '리뷰 이미지 업로드 중 오류가 발생했습니다.' });
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
    // ★ mode=new: fileTitle = 새 파일명(=시트 제목) → 캠페인명으로 적절
    // ★ mode=existing: fileTitle = 새 탭명 → 캠페인명으로 부적절! 시트 제목을 조회해야 함
    let resolvedCampaignName = campaignName || '';

    // ── 모드 1: 새 스프레드시트 생성 (전체 복사) ──
    if (mode === 'new') {
      // mode=new에서는 fileTitle이 곧 새 시트 제목이므로 캠페인명으로 사용 가능
      if (!resolvedCampaignName) resolvedCampaignName = fileTitle;
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

      // ★ 서비스 계정에 시트 편집자 권한 자동 부여 (복사된 시트)
      let shareResult = null;
      try {
        shareResult = await shareSheetWithServiceAccount(copied.id);
        if (shareResult.alreadyShared) {
          logger.info(`[createSheet:new] 시트 권한 이미 존재: ${copied.id} (${shareResult.method})`);
        } else {
          logger.info(`[createSheet:new] 시트 권한 자동 부여 완료: ${copied.id} (${shareResult.method})`);
        }
      } catch (shareErr) {
        logger.warn(`[createSheet:new] 시트 권한 자동 부여 실패 (등록은 완료): ${copied.id} — ${shareErr.message}`);
        shareResult = { ok: false, error: shareErr.message };
      }

      return res.json({
        ok: true,
        mode: 'new',
        fileTitle: copied.name,
        campaignName: resolvedCampaignName,
        sheetUrl: copied.url,
        sheetId: copied.id,
        shareResult,
      });
    }

    // ── 모드 2: 기존 시트에 탭 추가 (탭 복사) ──
    if (mode === 'existing') {
      if (!existingSheetId) {
        return res.json({ ok: false, error: '기존 시트 ID가 필요합니다.' });
      }

      // ★ mode=existing: campaignName이 비었으면 기존 시트의 제목(spreadsheetTitle)을 조회
      //    fileTitle은 새 탭 이름이므로 캠페인명으로 사용하면 안 됨
      if (!resolvedCampaignName) {
        try {
          const existingMeta = await getSpreadsheetMeta(existingSheetId);
          resolvedCampaignName = existingMeta._spreadsheetTitle || '';
        } catch (_) {}
        // 그래도 비어있으면 campaigns 테이블에서 조회
        if (!resolvedCampaignName) {
          try {
            const { rows: campRows } = await pool.query(
              'SELECT campaign_name FROM campaigns WHERE sheet_id = $1 LIMIT 1',
              [existingSheetId]
            );
            if (campRows.length > 0 && campRows[0].campaign_name) {
              resolvedCampaignName = campRows[0].campaign_name;
            }
          } catch (_) {}
        }
        // 최종 fallback: 빈 문자열 (탭 이름을 캠페인명으로 사용하지 않음)
        if (!resolvedCampaignName) resolvedCampaignName = '';
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

      // ★ 서비스 계정에 시트 편집자 권한 자동 부여 (기존 시트)
      let shareResult = null;
      try {
        shareResult = await shareSheetWithServiceAccount(existingSheetId);
        if (shareResult.alreadyShared) {
          logger.info(`[createSheet:existing] 시트 권한 이미 존재: ${existingSheetId} (${shareResult.method})`);
        } else {
          logger.info(`[createSheet:existing] 시트 권한 자동 부여 완료: ${existingSheetId} (${shareResult.method})`);
        }
      } catch (shareErr) {
        logger.warn(`[createSheet:existing] 시트 권한 자동 부여 실패 (등록은 완료): ${existingSheetId} — ${shareErr.message}`);
        shareResult = { ok: false, error: shareErr.message };
      }

      return res.json({
        ok: true,
        mode: 'existing',
        newTabName,
        campaignName: resolvedCampaignName,
        sheetUrl,
        tabUrl,
        sheetId: existingSheetId,
        shareResult,
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
        WHERE os.mirror_status IN ('pending','pending_no_row','failed','queued')
        ORDER BY os.submitted_at DESC
        LIMIT 50`
    );
    const { rows: byTab } = await pool.query(
      `SELECT os.sheet_id AS "sheetId", os.tab_name AS "tabName",
              COALESCE(MAX(NULLIF(os.tab_gid, '')), MAX(rst.tab_gid), MAX(tc.tab_gid)) AS "tabGid",
              MAX(tc.display_name) AS "displayName",
              COUNT(*)::int AS stuck,
              COUNT(*) FILTER (WHERE os.mirror_status = 'pending_no_row')::int AS "noRow",
              bool_or(rst.detected_headers IS NOT NULL) AS "hasRawMeta"
         FROM order_submissions os
         LEFT JOIN raw_sheet_tabs rst ON rst.sheet_id = os.sheet_id
              AND (rst.tab_gid = NULLIF(os.tab_gid, '') OR rst.tab_name = os.tab_name)
         LEFT JOIN tab_configs tc ON tc.sheet_id = os.sheet_id AND tc.tab_name = os.tab_name
        WHERE os.mirror_status IN ('pending','pending_no_row','failed','queued')
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
      const { rows } = await pool.query(
        `UPDATE order_submissions SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, mirror_status`,
        vals
      );
      if (!rows.length) return { notFound: true };
      await enqueue('order_update', { orderSubmissionId, editSeq, edits: clean });
      return { mirrorStatus: rows[0].mirror_status };
    });
    if (out && out.skipped) return res.status(409).json({ ok: false, error: '다른 편집/취소 진행 중 — 재시도하세요' });
    if (out && out.notFound) return res.status(404).json({ ok: false, error: '주문 없음 또는 이미 취소됨' });
    require('../jobs/queuePump').kickQueuePump();
    require('../utils/sse').emitOrderLedger({ action: 'edit', orderSubmissionId, mirror_status: out.mirrorStatus });
    res.json({ ok: true, queued: true, editSeq });
  } catch (err) { next(err); }
});

// POST /api/diag/order-cancel — 주문 소프트삭제(deleted_at) + 시트행 클리어(written이면 큐 order_cancel)
router.post('/order-cancel', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    if (process.env.ORDER_LEDGER_WRITE_ENABLED !== 'true') return res.status(503).json({ ok: false, error: 'order ledger 쓰기 비활성' });
    const { orderSubmissionId } = req.body || {};
    if (!orderSubmissionId) return res.status(400).json({ ok: false, error: 'orderSubmissionId 필수' });
    const canceledBy = String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100);
    const { withJobLock } = require('../utils/jobLock');
    const { enqueue } = require('../services/syncQueue.service');
    const out = await withJobLock('order_ledger:' + orderSubmissionId, async () => {
      const { rows } = await pool.query(
        `UPDATE order_submissions SET deleted_at = NOW(), canceled_by = $2, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING sheet_row, mirror_status`,
        [orderSubmissionId, canceledBy]
      );
      if (!rows.length) return { alreadyCanceled: true };
      // in-flight 선삭제(pending만; processing은 PR-A의 order_append deleted_at 가드가 done-noop).
      //   deposit_mark는 payload에 osid가 없고 입금칸은 클리어 매핑 밖이라 제외.
      await pool.query(
        `DELETE FROM sync_queue WHERE status = 'pending'
           AND type IN ('order_append','order_update','order_cancel')
           AND (payload->>'orderSubmissionId') = $1`,
        [String(orderSubmissionId)]
      );
      const os = rows[0];
      if (!os.sheet_row || os.mirror_status !== 'written') {
        // 시트 미반영 → 클리어 불필요. 점유한 빈 행 claim은 해제(재사용 허용; 쓰인 데이터 없음).
        try { await pool.query(`DELETE FROM sheet_row_claims WHERE order_id = $1::uuid`, [orderSubmissionId]); } catch (_) {}
        await pool.query(`UPDATE order_submissions SET mirror_status = 'canceled' WHERE id = $1`, [orderSubmissionId]);
        return { cleared: false };
      }
      await enqueue('order_cancel', { orderSubmissionId });
      return { cleared: true };
    });
    if (out && out.skipped) return res.status(409).json({ ok: false, error: '다른 편집/취소 진행 중 — 재시도하세요' });
    if (out && out.alreadyCanceled) return res.json({ ok: true, alreadyCanceled: true });
    if (out.cleared) require('../jobs/queuePump').kickQueuePump();
    require('../utils/sse').emitOrderLedger({ action: 'canceled', orderSubmissionId });
    res.json({ ok: true, cleared: out.cleared });
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

// POST /api/diag/test-tab-reset { sheetId, tabName, gid?, confirm:'RESET-TEST' } (admin/master)
// ★ 테스트 탭 초기화: 그 탭의 주문 소프트삭제 + claim/큐 정리 + 시트 데이터행 클리어.
//   파괴적이라 confirm='RESET-TEST' 필수. order_submissions는 deleted_at(복구가능), claim/큐는 하드삭제.
//   ★ 테스트 전용 — 실제 캠페인 탭에 쓰지 말 것(주문이 stuck/스케줄러에서 사라짐).
router.post('/test-tab-reset', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, gid, confirm } = req.body || {};
    if (!sheetId || !tabName) return res.status(400).json({ ok: false, error: 'sheetId, tabName 필수' });
    if (confirm !== 'RESET-TEST') return res.status(400).json({ ok: false, error: "confirm:'RESET-TEST' 필요(파괴적)" });
    const by = String((req.admin && (req.admin.name || req.admin.role)) || 'admin').slice(0, 100);

    // 1) 주문 소프트삭제(복구가능) — 미반영분 포함 전부
    const del = await pool.query(
      `UPDATE order_submissions SET deleted_at = NOW(), canceled_by = $3, mirror_status = 'canceled', updated_at = NOW()
        WHERE sheet_id = $1 AND tab_name = $2 AND deleted_at IS NULL
        RETURNING id`,
      [sheetId, tabName, by]
    );
    // 2) claim/큐 하드삭제(이 탭)
    const claims = await pool.query(`DELETE FROM sheet_row_claims WHERE sheet_id = $1 AND tab_name = $2`, [sheetId, tabName]);
    const q = await pool.query(
      `DELETE FROM sync_queue WHERE type IN ('order_append','order_update','order_cancel')
         AND payload->>'sheetId' = $1 AND payload->>'tabName' = $2`,
      [sheetId, tabName]
    );
    // 3) 시트 데이터행 클리어(헤더 아래 전부). gid 슬래시탭 아니므로 A1 range 사용.
    let sheetCleared = false;
    try {
      const { rows: tabRows } = await pool.query(
        `SELECT header_row_index FROM raw_sheet_tabs WHERE sheet_id = $1 AND tab_gid = $2`,
        [sheetId, String(gid || '')]
      );
      const hdrIdx = (tabRows[0] && Number.isInteger(tabRows[0].header_row_index)) ? tabRows[0].header_row_index : 9;
      const dataStart = hdrIdx + 2; // 0-based header → 1-based 데이터 시작 = hdrIdx+2
      const { clearSheetValues } = require('../services/sheets.service');
      await clearSheetValues(sheetId, `'${tabName}'!A${dataStart}:BZ5000`);
      sheetCleared = true;
    } catch (clearErr) {
      return res.json({ ok: true, ordersDeleted: del.rowCount, claimsDeleted: claims.rowCount, queueDeleted: q.rowCount, sheetCleared: false, sheetClearError: String(clearErr.message) });
    }
    res.json({ ok: true, ordersDeleted: del.rowCount, claimsDeleted: claims.rowCount, queueDeleted: q.rowCount, sheetCleared });
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
            source, deleted_at AS "deletedAt", last_edit_seq AS "lastEditSeq", submitted_at AS "submittedAt"
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
// POST /api/diag/participation-cleanup — 리뷰어 교차노출 오염 정리(participation_links)
//   배경: 과거 구매양식 제출이 가드/시트쓰기 검증 전에 "낙관적 claim 행"에 신원을 미리 찍어,
//        미러 stale·로스터 선기입 탭에서 '다른 리뷰어의 행'에 phone8을 남겼다(리뷰어 교차노출).
//        그 오염 pl 행은 = "해당 (sheet,tab,row)에 실제로 written 된 주문이 없는" 행이다
//        (정상 pl은 큐 워커가 가드 통과+쓰기 성공 후 그 행에만 기록 → written 주문이 반드시 존재).
//   동작: written 주문이 없는 participation_links 행을 삭제(가짜 신원링크 제거). 정상 pl은 보존.
//        삭제해도 리뷰어는 이름/재빌드된 phone8 매칭으로 정상 조회된다(P5 단축키만 사라짐).
//   주의: 파괴적 → 기본 dryRun(카운트만). 실제 삭제는 {dryRun:false} 명시 필요.
//        review_index.phone8 오염은 강제 전체 재빌드(POST /api/index/build {forceFullRebuild:true})로 정리.
//   body: { sheetId?, tabName?, dryRun? } — admin/master 전용.
// ═══════════════════════════════════════════════════════════
router.post('/participation-cleanup', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, dryRun = true } = req.body || {};
    const params = [];
    let scope = '';
    if (sheetId) { params.push(sheetId); scope += ` AND pl.sheet_id = $${params.length}`; }
    if (tabName) { params.push(tabName); scope += ` AND pl.tab_name = $${params.length}`; }

    // 오염 후보 = 해당 (sheet,tab,row)에 written 주문이 없는 pl 행
    const orphanWhere = `
      WHERE NOT EXISTS (
        SELECT 1 FROM order_submissions os
         WHERE os.sheet_id = pl.sheet_id
           AND os.tab_name = pl.tab_name
           AND os.sheet_row = pl.row_index
           AND os.mirror_status = 'written'
      )${scope}`;

    const { rows: cntRows } = await pool.query(
      `SELECT COUNT(*)::int AS orphans FROM participation_links pl ${orphanWhere}`,
      params
    );
    const orphans = cntRows[0]?.orphans || 0;

    // 전체 pl 수(스코프 내) — 비율 가시화
    const totParams = [];
    let totScope = '';
    if (sheetId) { totParams.push(sheetId); totScope += ` AND sheet_id = $${totParams.length}`; }
    if (tabName) { totParams.push(tabName); totScope += ` AND tab_name = $${totParams.length}`; }
    const { rows: totRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM participation_links WHERE TRUE${totScope}`,
      totParams
    );
    const totalInScope = totRows[0]?.cnt || 0;

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, totalInScope, orphansToDelete: orphans, sheetId: sheetId || null, tabName: tabName || null });
    }

    const { rowCount: deleted } = await pool.query(
      `DELETE FROM participation_links pl ${orphanWhere}`,
      params
    );
    res.json({ ok: true, dryRun: false, totalInScope, deleted, sheetId: sheetId || null, tabName: tabName || null });
  } catch (err) {
    next(err);
  }
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
              os.sheet_written_at AS "writtenAt", os.submitted_at AS "submittedAt"
         FROM order_submissions os
        WHERE os.sheet_id = $1 AND os.tab_name = $2${statusCond}
        ORDER BY os.sheet_row ASC NULLS LAST, os.submitted_at ASC
        LIMIT $3`,
      [sheetId, tabName, limit]
    );

    if (String(req.query.format || '').toLowerCase() === 'csv') {
      const stMap = { written: '반영완료', queued: '미반영(대기)', failed: '미반영(실패)', pending: '미반영', pending_no_row: '미반영(행없음)' };
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
router.post('/client-error', authMiddleware, async (req, res) => {
  try {
    const { message, source, lineno, colno, stack, page, userAgent } = req.body;
    logger.error({
      message: `[ClientError] ${message}`,
      source, lineno, colno, page,
      stack: (stack || '').substring(0, 500),
      ip: req.ip,
    });
    logAbnormal({
      flow: 'client', source: 'client', severity: 'warn',
      error: { message: message || 'client error', stack },
      context: { page, source, lineno, colno, ip: req.ip, userAgent: (userAgent || req.headers['user-agent'] || '').substring(0, 120) },
    });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/payment-check — 입금 헤더 감지 진단 (임시)
// ═══════════════════════════════════════════════════════════
router.get('/payment-check', authMiddleware, async (req, res) => {
  try {
    // 1) is_submitted2 상태 요약
    const { rows: summary } = await pool.query(`
      SELECT 
        COUNT(*) AS "total",
        COUNT(*) FILTER (WHERE is_submitted2 = 'PAID') AS "paidCount",
        COUNT(*) FILTER (WHERE is_submitted2 IS NOT NULL AND is_submitted2 != 'PAID') AS "otherCount",
        COUNT(*) FILTER (WHERE is_submitted2 IS NULL) AS "nullCount",
        COUNT(DISTINCT submit_col2) FILTER (WHERE submit_col2 IS NOT NULL AND submit_col2 != '') AS "uniquePaymentCols"
      FROM review_index
    `);

    // 2) submit_col2 (입금 헤더명) 분포
    const { rows: colDist } = await pool.query(`
      SELECT submit_col2 AS "paymentHeader", COUNT(*) AS "rowCount"
      FROM review_index
      WHERE submit_col2 IS NOT NULL AND submit_col2 != ''
      GROUP BY submit_col2
      ORDER BY "rowCount" DESC
      LIMIT 20
    `);

    // 3) 탭별 입금 현황 (상위 20개)
    const { rows: byTab } = await pool.query(`
      SELECT 
        ri.tab_name AS "tabName",
        COALESCE(tc.campaign_name, ri.campaign_name) AS "campaignName",
        COUNT(*) AS "totalRows",
        COUNT(*) FILTER (WHERE ri.is_submitted2 = 'PAID') AS "paidRows",
        MAX(ri.submit_col2) AS "paymentHeader",
        MAX(ri.built_at) AS "lastBuilt"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      GROUP BY ri.tab_name, ri.sheet_id, tc.campaign_name, ri.campaign_name
      HAVING COUNT(*) FILTER (WHERE ri.is_submitted2 = 'PAID') > 0
         OR MAX(ri.submit_col2) IS NOT NULL AND MAX(ri.submit_col2) != ''
      ORDER BY "paidRows" DESC
      LIMIT 20
    `);

    // 4) 최근 빌드된 탭의 헤더 샘플 (row_json에서 키 추출)
    const { rows: headerSample } = await pool.query(`
      SELECT DISTINCT ON (ri.sheet_id, ri.tab_name)
        ri.tab_name AS "tabName",
        COALESCE(tc.campaign_name, ri.campaign_name) AS "campaignName",
        ri.submit_col AS "submitHeader",
        ri.submit_col2 AS "paymentHeader",
        ARRAY(SELECT jsonb_object_keys(ri.row_json::jsonb)) AS "allHeaders"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.built_at >= NOW() - INTERVAL '1 hour'
      ORDER BY ri.sheet_id, ri.tab_name, ri.row_index
      LIMIT 10
    `);

    // 5) is_submitted2 값 분포 (어떤 값이 들어있는지 확인)
    const { rows: valueDist } = await pool.query(`
      SELECT is_submitted2 AS "value", COUNT(*) AS "count"
      FROM review_index
      GROUP BY is_submitted2
      ORDER BY "count" DESC
      LIMIT 20
    `);

    // 6) 헤더에 '입금'이 포함된 탭 목록 (row_json 키 기준)
    const { rows: tabsWithPaymentHeader } = await pool.query(`
      SELECT DISTINCT ON (ri.sheet_id, ri.tab_name)
        ri.tab_name AS "tabName",
        ri.campaign_name AS "campaignName",
        ri.submit_col2 AS "paymentHeader",
        ri.is_submitted2 AS "isSubmitted2Sample",
        ARRAY(SELECT jsonb_object_keys(ri.row_json::jsonb)) AS "allHeaders"
      FROM review_index ri
      WHERE ri.row_json::text LIKE '%입금%' OR ri.submit_col2 = '결제금액'
      ORDER BY ri.sheet_id, ri.tab_name, ri.row_index
      LIMIT 20
    `);

    res.json({
      ok: true,
      summary: summary[0],
      is_submitted2_values: valueDist,
      paymentHeaderDistribution: colDist,
      tabsWithPaymentInRowJson: tabsWithPaymentHeader,
      tabsWithPayment: byTab,
      recentBuildHeaders: headerSample,
      note: '인덱스 재빌드 후 이 데이터가 갱신됩니다'
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
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

// ═══════════════════════════════════════════════════════════
// GET /api/diag/slot-locks — 슬롯 잠금 테이블 진단
// ═══════════════════════════════════════════════════════════
router.get('/slot-locks', authMiddleware, async (req, res, next) => {
  try {
    // 테이블 존재 확인
    const { rows: tableCheck } = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'slot_locks'
      ) AS "exists"
    `);
    const tableExists = tableCheck[0]?.exists || false;

    if (!tableExists) {
      return res.json({ ok: true, tableExists: false, message: 'slot_locks 테이블이 아직 생성되지 않았습니다.' });
    }

    // 최근 잠금 레코드 조회
    const { rows: recentLocks } = await pool.query(`
      SELECT sheet_id, tab_name, row_number, inad_name,
             locked_by_phone8, locked_by_name, is_submitted,
             locked_at, submitted_at
      FROM slot_locks
      ORDER BY locked_at DESC
      LIMIT 20
    `);

    // 통계
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE is_submitted = TRUE) AS submitted,
        COUNT(*) FILTER (WHERE is_submitted = FALSE) AS pending
      FROM slot_locks
    `);

    res.json({
      ok: true,
      tableExists: true,
      stats: stats[0] || { total: 0, submitted: 0, pending: 0 },
      recentLocks,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/share-sheet — 서비스 계정에 시트 편집자 권한 부여
// ═══════════════════════════════════════════════════════════
router.post('/share-sheet', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId } = req.body;
    if (!sheetId) return res.json({ ok: false, error: 'sheetId 필요' });

    const result = await shareSheetWithServiceAccount(sheetId);
    res.json(result);
  } catch (err) {
    // 권한 부여 실패 — 시트 소유자가 아닌 경우 등
    const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '(미설정)';
    res.json({
      ok: false,
      error: err.message,
      hint: `서비스 계정(${sa})에 시트 편집자 권한을 수동으로 부여해주세요.`,
      serviceAccount: sa,
    });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/share-all-sheets — 대시보드 전체 캠페인 시트에 편집자 권한 일괄 부여
// ═══════════════════════════════════════════════════════════
router.post('/share-all-sheets', authMiddleware, async (req, res, next) => {
  try {
    const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
    if (!sa) return res.json({ ok: false, error: 'GOOGLE_SERVICE_ACCOUNT_EMAIL 미설정' });

    // 고유 시트 ID 목록 조회 (tab_configs에서 중복 제거)
    const { rows: sheetRows } = await pool.query(
      `SELECT DISTINCT sheet_id FROM tab_configs WHERE sheet_id IS NOT NULL AND sheet_id != ''`
    );

    const results = [];
    let successCount = 0;
    let alreadyCount = 0;
    let failCount = 0;

    for (const row of sheetRows) {
      const sid = row.sheet_id;
      try {
        const r = await shareSheetWithServiceAccount(sid);
        if (r.alreadyShared) {
          alreadyCount++;
          results.push({ sheetId: sid, status: 'already', role: r.role });
        } else {
          successCount++;
          results.push({ sheetId: sid, status: 'shared', role: r.role });
        }
      } catch (err) {
        failCount++;
        results.push({ sheetId: sid, status: 'error', error: err.message });
      }
    }

    res.json({
      ok: true,
      serviceAccount: sa,
      total: sheetRows.length,
      success: successCount,
      already: alreadyCount,
      failed: failCount,
      details: results,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/diag/sheet-permissions — 대시보드 전체 시트의 쓰기 권한 상태 확인
// ═══════════════════════════════════════════════════════════
router.get('/sheet-permissions', authMiddleware, async (req, res, next) => {
  try {
    const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';

    // 고유 시트 ID + 캠페인명 목록
    const { rows: sheetRows } = await pool.query(
      `SELECT DISTINCT ON (tc.sheet_id)
              tc.sheet_id,
              c.campaign_name
       FROM tab_configs tc
       LEFT JOIN campaigns c ON tc.sheet_id = c.sheet_id
       WHERE tc.sheet_id IS NOT NULL AND tc.sheet_id != ''
       ORDER BY tc.sheet_id, c.campaign_name`
    );

    const results = [];
    for (const row of sheetRows) {
      try {
        const access = await checkSheetWriteAccess(row.sheet_id);
        results.push({
          sheetId: row.sheet_id,
          campaignName: row.campaign_name || '(미등록)',
          hasWriteAccess: access.hasWriteAccess,
          role: access.role,
        });
      } catch (err) {
        results.push({
          sheetId: row.sheet_id,
          campaignName: row.campaign_name || '(미등록)',
          hasWriteAccess: false,
          role: null,
          error: err.message,
        });
      }
    }

    const noAccess = results.filter(r => !r.hasWriteAccess);
    res.json({
      ok: true,
      serviceAccount: sa,
      total: results.length,
      writeOk: results.filter(r => r.hasWriteAccess).length,
      noWrite: noAccess.length,
      sheets: results,
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

module.exports = router;
