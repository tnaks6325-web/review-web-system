const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { readSheet, getSpreadsheetMeta } = require('../services/sheets.service');

// GET /api/diag/debug-tab — 세부목록 현재 상태 진단 (GAS: debugTabConfig)
router.get('/debug-tab', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             manager, time_range AS "timeRange", review_type AS "reviewType",
             force_done AS "forceDone", is_closed AS "isClosed",
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

// GET /api/diag/debug-sheet — 특정 시트 파싱 가능 여부 확인 (GAS: debugSheet)
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

// POST /api/diag/check-duplicate — 구매양식 중복 검사 (GAS: checkDuplicateOrder)
router.post('/check-duplicate', async (req, res, next) => {
  try {
    const { orderData } = req.body;
    // TODO: 중복 검사 로직 구현
    res.json({ ok: true, isDuplicate: false, message: '중복 검사 (구현 예정)' });
  } catch (err) {
    next(err);
  }
});

// GET /api/viewer/data — 뷰어 데이터 조회 (GAS: getViewerData)
router.get('/viewer-data', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    // review_index에서 해당 탭 데이터 가져오기
    const { rows } = await pool.query(`
      SELECT
        ri.reviewer_name AS "reviewerName",
        ri.row_index AS "rowIndex",
        ri.is_submitted AS "isSubmitted",
        ri.product_name AS "productName",
        ri.row_json AS "rowJson",
        tc.display_name AS "displayName",
        tc.campaign_name AS "campaignName"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      WHERE ri.sheet_id = $1 AND ri.tab_name = $2
      ORDER BY ri.row_index
    `, [sheetId, tabName]);

    res.json({ ok: true, rows, total: rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/blacklist — 블랙리스트 관리 (GAS: blacklist)
router.post('/blacklist', authMiddleware, async (req, res, next) => {
  try {
    const { action, phone, name, reason } = req.body;

    switch (action) {
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
      case 'list': {
        const { rows } = await pool.query(
          'SELECT phone, name, reason, added_by AS "addedBy", added_at AS "addedAt" FROM blacklist ORDER BY added_at DESC'
        );
        return res.json({ ok: true, blacklist: rows, total: rows.length });
      }
      default:
        return res.json({ error: '알 수 없는 action' });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/index/new-sheet — 신규 시스템 시트 생성 (GAS: createBaseSheet)
router.post('/new-sheet', authMiddleware, async (req, res, next) => {
  try {
    // TODO: Sheets API로 신규 베이스시트 생성
    res.json({ ok: true, message: '신규 시트 생성 (구현 예정)' });
  } catch (err) {
    next(err);
  }
});

// POST /api/index/add-campaign — 캠페인 추가 (GAS: addCampaign)
router.post('/add-campaign', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, campaignName, sheetUrl } = req.body;
    if (!sheetId || !campaignName) {
      return res.json({ error: 'sheetId와 campaignName이 필요합니다.' });
    }

    await pool.query(
      `INSERT INTO campaigns (sheet_id, campaign_name, sheet_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (sheet_id, campaign_name) DO UPDATE SET
         sheet_url = EXCLUDED.sheet_url, updated_at = NOW()`,
      [sheetId, campaignName, sheetUrl || '']
    );
    res.json({ ok: true, sheetId, campaignName });
  } catch (err) {
    next(err);
  }
});

// POST /api/image/extract — 주문이미지 AI 분석 (GAS: extractOrderImage)
router.post('/image-extract', async (req, res, next) => {
  try {
    // TODO: AI API 호출로 이미지 분석
    res.json({ ok: true, message: '이미지 분석 (구현 예정)' });
  } catch (err) {
    next(err);
  }
});

// POST /api/image/upload — 주문이미지 Drive 업로드 (GAS: uploadOrderImage)
router.post('/image-upload', async (req, res, next) => {
  try {
    // TODO: Drive API로 이미지 업로드
    res.json({ ok: true, message: '이미지 업로드 (구현 예정)' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
