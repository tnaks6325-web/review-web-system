const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta } = require('../services/sheets.service');
const { getQueueStats, retryItem, retryAllFailed, purgeCompleted } = require('../services/syncQueue.service');

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
// POST /api/image/extract — 주문이미지 AI 분석 (GAS: extractOrderImage)
// ═══════════════════════════════════════════════════════════
router.post('/image-extract', async (req, res, next) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.json({ error: '이미지 데이터가 필요합니다.' });

    // TODO: AI API (OpenAI Vision, Gemini 등) 호출로 이미지 분석
    // 현재는 스텁 반환
    res.json({
      ok: true,
      message: '이미지 분석 — AI API 연동 필요',
      extracted: {
        orderer: '', recipient: '', phone: '', address: '',
        price: '', orderNum: '', dateStr: ''
      }
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/image/upload — 주문이미지 Drive 업로드 (GAS: uploadOrderImage)
// ═══════════════════════════════════════════════════════════
router.post('/image-upload', async (req, res, next) => {
  try {
    res.json({ ok: true, message: '이미지 업로드 — Drive API 연동 필요' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/convert-nc-headers — NC 헤더 변환 (GAS: convertToNcHeaders)
// ═══════════════════════════════════════════════════════════
router.post('/convert-nc-headers', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });
    res.json({ ok: true, message: 'NC 헤더 변환 — Sheets API 연동 필요' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/diag/create-campaign-sheet — 캠페인 시트 생성 (GAS: createCampaignSheet)
// ═══════════════════════════════════════════════════════════
router.post('/create-campaign-sheet', authMiddleware, async (req, res, next) => {
  try {
    const { templateSheetId, campaignName } = req.body;
    if (!templateSheetId || !campaignName) {
      return res.json({ error: '템플릿 시트ID와 캠페인명이 필요합니다.' });
    }
    res.json({ ok: true, message: '캠페인 시트 생성 — Sheets API 연동 필요' });
  } catch (err) {
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

// ── 헬퍼 ──
function extractSheetId(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

module.exports = router;
