const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// GET /api/archive/detect — 아카이브 대상 자동 감지 (반자동: 감지만)
// 소스 1: index_master 기준 (submitted >= row_count OR closed/force_done)
// 소스 2: tab_configs 기준 (closed/force_done이지만 index_master에 없는 경우)
// ═══════════════════════════════════════════════════════════
router.get('/detect', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      -- 소스 1: index_master에 있는 완료/마감 탭
      SELECT
        im.sheet_id       AS "sheetId",
        im.tab_name       AS "tabName",
        COALESCE(tc.campaign_name, im.campaign_name) AS "campaignName",
        im.row_count      AS "rowCount",
        im.submitted_count AS "submittedCount",
        im.built_at       AS "builtAt",
        CASE
          WHEN tc.is_closed = TRUE THEN 'closed'
          WHEN tc.force_done = TRUE THEN 'force_done'
          WHEN im.row_count > 0 AND im.submitted_count >= im.row_count THEN 'completed'
          ELSE 'unknown'
        END AS "reason",
        TRUE AS "inIndex"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      WHERE im.status = 'active'
        AND (
          tc.is_closed = TRUE
          OR tc.force_done = TRUE
          OR (im.row_count > 0 AND im.submitted_count >= im.row_count)
        )

      UNION ALL

      -- 소스 2: tab_configs에만 있는 마감/강제완료 탭 (index_master에 없음)
      SELECT
        tc.sheet_id       AS "sheetId",
        tc.tab_name       AS "tabName",
        tc.campaign_name  AS "campaignName",
        0                 AS "rowCount",
        0                 AS "submittedCount",
        NULL              AS "builtAt",
        CASE
          WHEN tc.is_closed = TRUE THEN 'closed'
          WHEN tc.force_done = TRUE THEN 'force_done'
          ELSE 'unknown'
        END AS "reason",
        FALSE AS "inIndex"
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      WHERE (tc.is_closed = TRUE OR tc.force_done = TRUE)
        AND im.sheet_id IS NULL

      ORDER BY "campaignName", "tabName"
    `);

    // 캠페인별 그룹핑 (프론트엔드 표시용)
    const campMap = new Map();
    rows.forEach(r => {
      if (!campMap.has(r.sheetId)) {
        campMap.set(r.sheetId, {
          sheetId: r.sheetId,
          campaignName: r.campaignName || '미분류',
          tabs: [],
        });
      }
      campMap.get(r.sheetId).tabs.push({
        tabName: r.tabName,
        rowCount: parseInt(r.rowCount) || 0,
        submittedCount: parseInt(r.submittedCount) || 0,
        reason: r.reason,
        builtAt: r.builtAt,
        inIndex: r.inIndex,
      });
    });

    const campaigns = Array.from(campMap.values());
    res.json({
      ok: true,
      totalTabs: rows.length,
      totalCampaigns: campaigns.length,
      campaigns,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/archive/tabs — 개별 탭 단위 아카이브 실행
// body: { tabs: [{ sheetId, tabName }], reason? }
// 관리자가 감지 결과 확인 후 선택적으로 실행
// ═══════════════════════════════════════════════════════════
router.post('/tabs', authMiddleware, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { tabs, reason } = req.body;
    if (!tabs || !Array.isArray(tabs) || tabs.length === 0) {
      return res.status(400).json({ error: '아카이브할 탭 목록이 필요합니다.' });
    }

    const adminName = req.admin?.name || 'system';
    const archiveReason = reason || 'manual';

    await client.query('BEGIN');

    let archivedTabs = 0;
    let archivedRows = 0;
    const results = [];

    for (const { sheetId, tabName } of tabs) {
      if (!sheetId || !tabName) continue;

      try {
        // 1. index_master에서 해당 탭 확인
        const { rows: masterRows } = await client.query(
          'SELECT * FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );

        if (masterRows.length === 0) {
          // index_master에 없는 경우: tab_configs에서만 정리
          // (마감/강제완료 상태인데 인덱스에 없는 탭 — 과거 데이터)
          const { rows: tcRows } = await client.query(
            'SELECT * FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
            [sheetId, tabName]
          );

          if (tcRows.length > 0) {
            const tc = tcRows[0];
            // index_master_archive에 기록 (인덱스 데이터 없이 설정만)
            await client.query(`
              INSERT INTO index_master_archive
                (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
                 last_date, checksum, built_at, status, skip_reason, error_msg,
                 sheet_modified_at, archived_by, archive_reason)
              VALUES ($1,$2,$3,$4,0,0,NULL,NULL,NULL,'archived',NULL,NULL,NULL,$5,$6)
              ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
                archived_at = NOW(),
                archived_by = EXCLUDED.archived_by,
                archive_reason = EXCLUDED.archive_reason
            `, [sheetId, tabName, tc.tab_gid || null, tc.campaign_name || '미분류', adminName, archiveReason]);

            // tab_configs에서 삭제 (또는 비활성화)
            await client.query(
              'DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
              [sheetId, tabName]
            );

            archivedTabs++;
            results.push({
              sheetId, tabName,
              campaignName: tc.campaign_name || '미분류',
              rowCount: 0,
              status: 'archived_config_only',
            });
          } else {
            results.push({ sheetId, tabName, status: 'skipped', reason: '데이터 없음' });
          }
          continue;
        }

        const mr = masterRows[0];

        // 2. index_master → index_master_archive 이동
        await client.query(`
          INSERT INTO index_master_archive
            (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
             last_date, checksum, built_at, status, skip_reason, error_msg,
             sheet_modified_at, archived_by, archive_reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'archived',$10,$11,$12,$13,$14)
          ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
            campaign_name = EXCLUDED.campaign_name,
            row_count = EXCLUDED.row_count,
            submitted_count = EXCLUDED.submitted_count,
            checksum = EXCLUDED.checksum,
            built_at = EXCLUDED.built_at,
            archived_at = NOW(),
            archived_by = EXCLUDED.archived_by,
            archive_reason = EXCLUDED.archive_reason
        `, [
          mr.sheet_id, mr.tab_name, mr.tab_gid, mr.campaign_name,
          mr.row_count, mr.submitted_count, mr.last_date, mr.checksum,
          mr.built_at, mr.skip_reason, mr.error_msg, mr.sheet_modified_at,
          adminName, archiveReason,
        ]);

        // 3. review_index → review_index_archive 이동
        const { rowCount: reviewCount } = await client.query(`
          INSERT INTO review_index_archive
            (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
             row_index, is_submitted, is_submitted2, product_url, product_name,
             submit_col, submit_col2, row_json, start_date, end_date,
             round, phone8, built_at, archived_at)
          SELECT
            reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
            row_index, is_submitted, is_submitted2, product_url, product_name,
            submit_col, submit_col2, row_json, start_date, end_date,
            round, phone8, built_at, NOW()
          FROM review_index
          WHERE sheet_id = $1 AND tab_name = $2
        `, [sheetId, tabName]);

        // 4. 원본 테이블에서 삭제
        await client.query(
          'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );
        await client.query(
          'DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );
        // tab_configs도 함께 정리 (마감/완료 설정 포함)
        await client.query(
          'DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );

        archivedTabs++;
        archivedRows += reviewCount;
        results.push({
          sheetId, tabName,
          campaignName: mr.campaign_name,
          rowCount: reviewCount,
          status: 'archived',
        });

      } catch (tabErr) {
        results.push({ sheetId, tabName, status: 'error', error: tabErr.message });
        logger.error(`[archive/tabs] 탭 아카이브 실패: ${sheetId}/${tabName} — ${tabErr.message}`);
      }
    }

    // 5. 아카이브 이력 기록 (전체를 한 건으로)
    if (archivedTabs > 0) {
      await client.query(`
        INSERT INTO archive_history (action, sheet_id, campaign_name, tab_count, row_count, performed_by, note)
        VALUES ('archive', $1, $2, $3, $4, $5, $6)
      `, [
        'multi', '일괄 아카이브', archivedTabs, archivedRows, adminName,
        `${archiveReason}: ${archivedTabs}개 탭, ${archivedRows}개 행 아카이브`,
      ]);
    }

    await client.query('COMMIT');

    logger.info(`[archive/tabs] 탭 아카이브 완료: ${archivedTabs}탭, ${archivedRows}행 by ${adminName}`);

    res.json({
      ok: true,
      archivedTabs,
      archivedRows,
      results,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/archive/list — 아카이브된 탭 목록 (조회/검색/기간필터)
// query: ?q=검색어&from=2026-01-01&to=2026-04-20&page=1&limit=50
// ═══════════════════════════════════════════════════════════
router.get('/list', authMiddleware, async (req, res, next) => {
  try {
    const { q, from, to, page = 1, limit = 200 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];
    let paramIdx = 1;

    if (q) {
      conditions.push(`(ima.campaign_name ILIKE $${paramIdx} OR ima.tab_name ILIKE $${paramIdx})`);
      params.push(`%${q}%`);
      paramIdx++;
    }
    if (from) {
      conditions.push(`ima.archived_at >= $${paramIdx}`);
      params.push(from);
      paramIdx++;
    }
    if (to) {
      conditions.push(`ima.archived_at <= $${paramIdx}::date + interval '1 day'`);
      params.push(to);
      paramIdx++;
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // 전체 카운트
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM index_master_archive ima ${whereClause}`,
      params
    );
    const totalCount = parseInt(countRows[0].total);

    // 데이터 조회
    const { rows } = await pool.query(`
      SELECT
        ima.sheet_id        AS "sheetId",
        ima.campaign_name   AS "campaignName",
        ima.tab_name        AS "tabName",
        ima.row_count       AS "rowCount",
        ima.submitted_count AS "submittedCount",
        ima.archived_at     AS "archivedAt",
        ima.archived_by     AS "archivedBy",
        ima.archive_reason  AS "archiveReason",
        ima.built_at        AS "builtAt"
      FROM index_master_archive ima
      ${whereClause}
      ORDER BY ima.archived_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, [...params, parseInt(limit), offset]);

    // sheetId별 그룹핑
    const campMap = new Map();
    let totalRows = 0, totalSubmitted = 0;
    rows.forEach(r => {
      if (!campMap.has(r.sheetId)) {
        campMap.set(r.sheetId, {
          sheetId: r.sheetId,
          campaignName: r.campaignName || '미분류',
          tabs: [],
          totalRows: 0,
          totalSubmitted: 0,
        });
      }
      const camp = campMap.get(r.sheetId);
      const rowCount = parseInt(r.rowCount) || 0;
      const submittedCount = parseInt(r.submittedCount) || 0;
      camp.tabs.push({
        tabName: r.tabName,
        rowCount,
        submittedCount,
        archivedAt: r.archivedAt,
        archivedBy: r.archivedBy,
        archiveReason: r.archiveReason,
      });
      camp.totalRows += rowCount;
      camp.totalSubmitted += submittedCount;
      totalRows += rowCount;
      totalSubmitted += submittedCount;
    });

    const campaigns = Array.from(campMap.values());
    res.json({
      ok: true,
      campaigns,
      totalCampaigns: campaigns.length,
      totalTabs: totalCount,
      totalRows,
      totalSubmitted,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/archive/history — 아카이브 이력
// ═══════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const { rows } = await pool.query(`
      SELECT
        id, action, sheet_id AS "sheetId", campaign_name AS "campaignName",
        tab_count AS "tabCount", row_count AS "rowCount",
        performed_by AS "performedBy", performed_at AS "performedAt", note
      FROM archive_history
      ORDER BY performed_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ ok: true, history: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
