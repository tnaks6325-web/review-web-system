const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');

// POST /api/tab/config — 탭 설정 저장/수정 (GAS: setTabConfig)
router.post('/config', authMiddleware, async (req, res, next) => {
  try {
    const b = req.body;
    const tabName = (b.tabName || '').trim();
    if (!tabName) return res.json({ error: 'tabName이 필요합니다.' });

    const sheetId = (b.sheetId || '').trim();
    if (!sheetId) return res.json({ error: 'sheetId가 필요합니다.' });

    // null 처리: undefined(미전송) = 기존값 보존, 빈문자열("") = 빈값 저장
    const fields = {
      sheet_url:    b.sheetUrl  || (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : undefined),
      manager:      b.manager      !== undefined ? b.manager      : undefined,
      time_range:   b.timeRange    !== undefined ? b.timeRange    : undefined,
      taekhap:      b.taekhap      !== undefined ? Boolean(b.taekhap) : undefined,
      review_type:  b.reviewType   !== undefined ? b.reviewType   : undefined,
      payment_type: b.paymentType  !== undefined ? b.paymentType  : undefined,
      display_name: b.displayName  !== undefined ? b.displayName  : undefined,
      delivery_type:b.deliveryType !== undefined ? b.deliveryType : undefined,
      is_bulk:      b.isBulk       !== undefined ? Boolean(b.isBulk) : undefined,
      round:        b.round        !== undefined ? b.round        : undefined,
      nc_mode:      b.ncMode       !== undefined ? Boolean(b.ncMode) : undefined,
      folder_url:   b.folderUrl    !== undefined ? b.folderUrl    : undefined,
      deposit_name: b.depositName  !== undefined ? b.depositName  : undefined,
      transfer_bank:b.transferBank !== undefined ? b.transferBank : undefined,
      income_type:  b.incomeType   !== undefined ? b.incomeType   : undefined,
      campaign_name:b.campaignName !== undefined ? b.campaignName : undefined,
    };

    // undefined 필드 제거 (기존값 보존)
    const updateEntries = Object.entries(fields).filter(([, v]) => v !== undefined);

    if (updateEntries.length === 0) {
      return res.json({ error: '업데이트할 필드가 없습니다.' });
    }

    // UPSERT SQL 동적 생성
    const colNames = updateEntries.map(([k]) => k);
    const values = updateEntries.map(([, v]) => v);
    const placeholders = values.map((_, i) => `$${i + 3}`);
    const setClause = colNames.map((k, i) => `${k} = $${i + 3}`).join(', ');

    const sql = `
      INSERT INTO tab_configs (sheet_id, tab_name, ${colNames.join(', ')}, updated_at)
      VALUES ($1, $2, ${placeholders.join(', ')}, NOW())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        ${setClause},
        updated_at = NOW()
      RETURNING *
    `;

    await pool.query(sql, [sheetId, tabName, ...values]);
    res.json({ ok: true, tabName, sheetId });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/config — 탭 설정 조회 (세부목록 전체 or 단건)
router.get('/config', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;

    let sql = `SELECT * FROM tab_configs`;
    const params = [];
    const where = [];

    if (sheetId) { where.push(`sheet_id = $${params.length + 1}`); params.push(sheetId); }
    if (tabName) { where.push(`tab_name = $${params.length + 1}`); params.push(tabName); }

    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY updated_at DESC';

    const { rows } = await pool.query(sql, params);

    // detailMap 형식으로 변환 (GAS 호환)
    const detailMap = {};
    rows.forEach(r => {
      const key = `${r.sheet_id}||${r.tab_name}`;
      detailMap[key] = {
        manager: r.manager,
        timeRange: r.time_range,
        taekhap: r.taekhap,
        reviewType: r.review_type,
        paymentType: r.payment_type,
        displayName: r.display_name,
        forceDone: r.force_done,
        isClosed: r.is_closed,
        folderUrl: r.folder_url,
        captureFolderUrl: r.capture_folder_url,
        isBulk: r.is_bulk,
        deliveryType: r.delivery_type,
        round: r.round,
        ncMode: r.nc_mode,
        depositName: r.deposit_name,
        transferBank: r.transfer_bank,
        incomeType: r.income_type,
        campaignName: r.campaign_name,
        sheetUrl: r.sheet_url,
      };
    });

    res.json({ ok: true, configs: rows, detailMap });
  } catch (err) {
    next(err);
  }
});

// POST /api/tab/force-done — 강제완료 설정 (GAS: setForceDone)
router.post('/force-done', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabs } = req.body;
    if (!sheetId || !Array.isArray(tabs)) {
      return res.json({ error: 'sheetId와 tabs 배열이 필요합니다.' });
    }

    for (const t of tabs) {
      await pool.query(
        'UPDATE tab_configs SET force_done = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
        [Boolean(t.forceDone), sheetId, t.tabName]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/tab/closed — 마감 설정 (GAS: setClosed)
router.post('/closed', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabs } = req.body;
    if (!sheetId || !Array.isArray(tabs)) {
      return res.json({ error: 'sheetId와 tabs 배열이 필요합니다.' });
    }

    for (const t of tabs) {
      await pool.query(
        'UPDATE tab_configs SET is_closed = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
        [Boolean(t.isClosed), sheetId, t.tabName]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/options — 탭 옵션 목록 (GAS: getTabOptions)
router.get('/options', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT sheet_id AS "sheetId", tab_name AS "tabName",
             campaign_name AS "campaignName", display_name AS "displayName"
      FROM tab_configs
      WHERE is_closed = FALSE AND force_done = FALSE
      ORDER BY tab_name
    `);
    res.json({ ok: true, options: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/end-date — 탭 종료일 조회 (GAS: getTabEndDate)
router.get('/end-date', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId와 tabName이 필요합니다.' });

    const { rows } = await pool.query(
      `SELECT MAX(end_date) AS "endDate" FROM review_index
       WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName]
    );
    res.json({ ok: true, endDate: rows[0]?.endDate || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/tab/stats — 탭별 상세 통계 (GAS: getCampaignStats)
router.get('/stats', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        im.sheet_id AS "sheetId",
        im.tab_name AS "tabName",
        im.campaign_name AS "campaignName",
        im.row_count AS "totalCount",
        im.submitted_count AS "submittedCount",
        im.status,
        tc.manager,
        tc.review_type AS "reviewType",
        tc.force_done AS "forceDone",
        tc.is_closed AS "isClosed"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      ORDER BY im.built_at DESC NULLS LAST
    `);
    res.json({ ok: true, stats: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
