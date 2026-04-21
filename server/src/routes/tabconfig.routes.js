const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');
const { readSheet } = require('../services/sheets.service');
const { logger } = require('../utils/logger');

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

// ═══════════════════════════════════════════════════════════
// POST /api/tab/sync-from-sheet — 세부목록 탭 → DB 일괄 동기화
// 베이스시트의 '세부목록' 탭을 1회 읽어 tab_configs에 UPSERT
// ═══════════════════════════════════════════════════════════
router.post('/sync-from-sheet', authMiddleware, async (req, res, next) => {
  try {
    const baseSheetId = process.env.BASE_SHEET_ID;
    if (!baseSheetId) return res.json({ ok: false, error: 'BASE_SHEET_ID 환경변수가 설정되지 않았습니다.' });

    const startTime = Date.now();

    // 세부목록 탭 전체 읽기 (1회 API 호출)
    let values;
    try {
      values = await readSheet(baseSheetId, '세부목록');
    } catch (err) {
      return res.json({ ok: false, error: `세부목록 탭 읽기 실패: ${err.message}` });
    }

    if (!values || values.length < 2) {
      return res.json({ ok: false, error: '세부목록 탭에 데이터가 없습니다.' });
    }

    // 헤더 파싱 (첫 행)
    const rawHeaders = values[0].map(h => String(h || '').trim().toLowerCase()
      .replace(/^[a-z][\.:]\s*/i, '') // "A. sheet_url" → "sheet_url" 정규화
    );

    // 컬럼 인덱스 매핑
    const COL_MAP = {
      sheet_url: rawHeaders.indexOf('sheet_url'),
      tab_name: rawHeaders.indexOf('tab_name'),
      campaign_name: rawHeaders.indexOf('campaign_name'),
      manager: rawHeaders.indexOf('manager'),
      time_range: rawHeaders.indexOf('time_range'),
      taekhap: rawHeaders.indexOf('taekhap'),
      review_type: rawHeaders.indexOf('review_type'),
      payment_type: rawHeaders.indexOf('payment_type'),
      display_name: rawHeaders.indexOf('display_name'),
      force_done: rawHeaders.indexOf('force_done'),
      is_closed: rawHeaders.indexOf('is_closed'),
      folder_url: rawHeaders.indexOf('folder_url'),
      capture_folder_url: rawHeaders.indexOf('capture_folder_url'),
      is_bulk: rawHeaders.indexOf('is_bulk'),
      delivery_type: rawHeaders.indexOf('delivery_type'),
      round: rawHeaders.indexOf('round'),
      nc_mode: rawHeaders.indexOf('nc_mode'),
      deposit_name: rawHeaders.indexOf('deposit_name'),
      transfer_bank: rawHeaders.indexOf('transfer_bank'),
      income_type: rawHeaders.indexOf('income_type'),
    };

    if (COL_MAP.sheet_url < 0 || COL_MAP.tab_name < 0) {
      return res.json({ ok: false, error: `필수 헤더 누락: sheet_url(${COL_MAP.sheet_url}), tab_name(${COL_MAP.tab_name})` });
    }

    // sheet_url에서 sheetId 추출 헬퍼
    const extractSheetId = (url) => {
      if (!url) return null;
      const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      return m ? m[1] : null;
    };

    const _val = (row, idx) => idx >= 0 && idx < row.length ? String(row[idx] || '').trim() : '';
    const _bool = (row, idx) => {
      const v = _val(row, idx).toUpperCase();
      return v === 'TRUE' || v === '1' || v === 'O';
    };

    let synced = 0, updated = 0, skipped = 0, errors = 0;
    const errorDetails = [];

    // 데이터 행 처리
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      try {
        const sheetUrl = _val(row, COL_MAP.sheet_url);
        const sheetId = extractSheetId(sheetUrl);
        const tabName = _val(row, COL_MAP.tab_name);

        if (!sheetId || !tabName) { skipped++; continue; }

        const result = await pool.query(`
          INSERT INTO tab_configs (sheet_id, tab_name, sheet_url, campaign_name,
            manager, time_range, taekhap, review_type, payment_type,
            display_name, force_done, is_closed, folder_url, capture_folder_url,
            is_bulk, delivery_type, round, nc_mode, deposit_name, transfer_bank,
            income_type, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
          ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
            sheet_url = COALESCE(NULLIF(EXCLUDED.sheet_url,''), tab_configs.sheet_url),
            campaign_name = COALESCE(NULLIF(EXCLUDED.campaign_name,''), tab_configs.campaign_name),
            manager = COALESCE(NULLIF(EXCLUDED.manager,''), tab_configs.manager),
            time_range = COALESCE(NULLIF(EXCLUDED.time_range,''), tab_configs.time_range),
            taekhap = EXCLUDED.taekhap,
            review_type = COALESCE(NULLIF(EXCLUDED.review_type,''), tab_configs.review_type),
            payment_type = COALESCE(NULLIF(EXCLUDED.payment_type,''), tab_configs.payment_type),
            display_name = COALESCE(NULLIF(EXCLUDED.display_name,''), tab_configs.display_name),
            force_done = EXCLUDED.force_done,
            is_closed = EXCLUDED.is_closed,
            folder_url = COALESCE(NULLIF(EXCLUDED.folder_url,''), tab_configs.folder_url),
            capture_folder_url = COALESCE(NULLIF(EXCLUDED.capture_folder_url,''), tab_configs.capture_folder_url),
            is_bulk = EXCLUDED.is_bulk,
            delivery_type = COALESCE(NULLIF(EXCLUDED.delivery_type,''), tab_configs.delivery_type),
            round = COALESCE(NULLIF(EXCLUDED.round,''), tab_configs.round),
            nc_mode = EXCLUDED.nc_mode,
            deposit_name = COALESCE(NULLIF(EXCLUDED.deposit_name,''), tab_configs.deposit_name),
            transfer_bank = COALESCE(NULLIF(EXCLUDED.transfer_bank,''), tab_configs.transfer_bank),
            income_type = COALESCE(NULLIF(EXCLUDED.income_type,''), tab_configs.income_type),
            updated_at = NOW()
        `, [
          sheetId, tabName, sheetUrl,
          _val(row, COL_MAP.campaign_name),
          _val(row, COL_MAP.manager),
          _val(row, COL_MAP.time_range),
          _bool(row, COL_MAP.taekhap),
          _val(row, COL_MAP.review_type),
          _val(row, COL_MAP.payment_type),
          _val(row, COL_MAP.display_name),
          _bool(row, COL_MAP.force_done),
          _bool(row, COL_MAP.is_closed),
          _val(row, COL_MAP.folder_url),
          _val(row, COL_MAP.capture_folder_url),
          _bool(row, COL_MAP.is_bulk),
          _val(row, COL_MAP.delivery_type),
          _val(row, COL_MAP.round),
          _bool(row, COL_MAP.nc_mode),
          _val(row, COL_MAP.deposit_name),
          _val(row, COL_MAP.transfer_bank),
          _val(row, COL_MAP.income_type),
        ]);

        synced++;
      } catch (err) {
        errors++;
        if (errorDetails.length < 5) errorDetails.push(`행${i+1}: ${err.message}`);
      }
    }

    // 동기화 시각 기록
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('last_tab_sync', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [new Date().toISOString()]
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[tab-sync] 세부목록 동기화 완료: ${synced}건 처리, ${skipped}건 스킵, ${errors}건 오류, ${elapsed}s`);

    res.json({
      ok: true,
      synced,
      updated,
      skipped,
      errors,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      totalRows: values.length - 1,
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/tab/clean-closed — 마감 탭 인덱스 데이터 정리
// is_closed=TRUE인 탭의 review_index + index_master 데이터 삭제
// ═══════════════════════════════════════════════════════════
router.post('/clean-closed', authMiddleware, async (req, res, next) => {
  try {
    const startTime = Date.now();

    // is_closed=TRUE인 탭 목록 조회
    const { rows: closedTabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name FROM tab_configs WHERE is_closed = TRUE`
    );

    if (closedTabs.length === 0) {
      return res.json({ ok: true, message: '마감된 탭이 없습니다.', cleaned: 0 });
    }

    let reviewDeleted = 0, masterDeleted = 0;

    for (const tab of closedTabs) {
      // review_index에서 삭제
      const r1 = await pool.query(
        'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2',
        [tab.sheet_id, tab.tab_name]
      );
      reviewDeleted += r1.rowCount || 0;

      // index_master에서 삭제
      const r2 = await pool.query(
        'DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
        [tab.sheet_id, tab.tab_name]
      );
      masterDeleted += r2.rowCount || 0;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[clean-closed] 마감 탭 정리: ${closedTabs.length}개 탭, review_index ${reviewDeleted}행 삭제, index_master ${masterDeleted}행 삭제, ${elapsed}s`);

    res.json({
      ok: true,
      closedTabs: closedTabs.length,
      reviewDeleted,
      masterDeleted,
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/tab/dashboard — 탭설정 현황 전체 조회
// 모든 tab_configs + index_master 통계를 JOIN하여 반환
// ═══════════════════════════════════════════════════════════
router.get('/dashboard', authMiddleware, async (req, res, next) => {
  try {
    // 탭설정 + 인덱스 통계 JOIN
    const { rows } = await pool.query(`
      SELECT
        tc.sheet_id, tc.tab_name, tc.sheet_url, tc.campaign_name,
        tc.manager, tc.time_range, tc.taekhap, tc.review_type,
        tc.payment_type, tc.display_name, tc.force_done, tc.is_closed,
        tc.folder_url, tc.capture_folder_url, tc.is_bulk, tc.delivery_type,
        tc.round, tc.nc_mode, tc.deposit_name, tc.transfer_bank,
        tc.income_type, tc.updated_at,
        im.row_count, im.submitted_count, im.status AS index_status,
        im.built_at AS index_built_at, im.checksum
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      ORDER BY tc.campaign_name NULLS LAST, tc.tab_name
    `);

    // 통계 계산
    const stats = {
      total: rows.length,
      active: rows.filter(r => !r.force_done && !r.is_closed).length,
      forceDone: rows.filter(r => r.force_done && !r.is_closed).length,
      closed: rows.filter(r => r.is_closed).length,
      indexed: rows.filter(r => r.index_status === 'active').length,
      noManager: rows.filter(r => !r.manager).length,
      noFolder: rows.filter(r => !r.folder_url).length,
      noCaptureFolder: rows.filter(r => !r.capture_folder_url).length,
      totalRows: rows.reduce((s, r) => s + (r.row_count || 0), 0),
      totalSubmitted: rows.reduce((s, r) => s + (r.submitted_count || 0), 0),
    };

    // 캠페인별 그룹핑
    const campaigns = {};
    rows.forEach(r => {
      const camp = r.campaign_name || '(미지정)';
      if (!campaigns[camp]) campaigns[camp] = { tabs: 0, active: 0, closed: 0, forceDone: 0 };
      campaigns[camp].tabs++;
      if (r.is_closed) campaigns[camp].closed++;
      else if (r.force_done) campaigns[camp].forceDone++;
      else campaigns[camp].active++;
    });

    // 담당자별 통계
    const managers = {};
    rows.forEach(r => {
      const mgr = r.manager || '(미지정)';
      if (!managers[mgr]) managers[mgr] = 0;
      managers[mgr]++;
    });

    // 마지막 동기화 시각
    const { rows: syncRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'last_tab_sync'`
    );
    const lastSync = syncRows[0]?.value || null;

    res.json({
      ok: true,
      stats,
      campaigns,
      managers,
      lastSync,
      tabs: rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
