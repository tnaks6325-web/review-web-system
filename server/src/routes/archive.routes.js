const express = require('express');
const router = express.Router();
const { authMiddleware, masterOnlyMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// GET /api/archive/list — 아카이브된 캠페인 목록
// ═══════════════════════════════════════════════════════════
router.get('/list', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        ima.sheet_id        AS "sheetId",
        ima.campaign_name   AS "campaignName",
        ima.tab_name        AS "tabName",
        ima.row_count       AS "rowCount",
        ima.submitted_count AS "submittedCount",
        ima.archived_at     AS "archivedAt",
        ima.archived_by     AS "archivedBy",
        ima.archive_reason  AS "archiveReason"
      FROM index_master_archive ima
      ORDER BY ima.archived_at DESC
    `);

    // sheetId별 그룹핑
    const campMap = new Map();
    rows.forEach(r => {
      if (!campMap.has(r.sheetId)) {
        campMap.set(r.sheetId, {
          sheetId: r.sheetId,
          campaignName: r.campaignName || '미분류',
          tabs: [],
          totalRows: 0,
          totalSubmitted: 0,
          archivedAt: r.archivedAt,
          archivedBy: r.archivedBy,
        });
      }
      const camp = campMap.get(r.sheetId);
      camp.tabs.push({
        tabName: r.tabName,
        rowCount: parseInt(r.rowCount) || 0,
        submittedCount: parseInt(r.submittedCount) || 0,
        archivedAt: r.archivedAt,
        archiveReason: r.archiveReason,
      });
      camp.totalRows += parseInt(r.rowCount) || 0;
      camp.totalSubmitted += parseInt(r.submittedCount) || 0;
    });

    const campaigns = Array.from(campMap.values());
    res.json({ ok: true, campaigns, total: campaigns.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/archive/campaign — 캠페인(시트) 단위 아카이브
// body: { sheetId, reason? }
// 해당 sheetId의 모든 탭을 아카이브 테이블로 이동
// ═══════════════════════════════════════════════════════════
router.post('/campaign', authMiddleware, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { sheetId, reason } = req.body;
    if (!sheetId) return res.status(400).json({ error: 'sheetId가 필요합니다.' });

    const adminName = req.admin?.name || 'system';
    const archiveReason = reason || 'manual';

    await client.query('BEGIN');

    // 1. index_master에서 해당 시트의 탭 목록 확인
    const { rows: masterRows } = await client.query(
      'SELECT * FROM index_master WHERE sheet_id = $1', [sheetId]
    );
    if (masterRows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: false, error: '해당 시트에 인덱스 데이터가 없습니다.' });
    }

    // 2. index_master → index_master_archive 이동
    for (const row of masterRows) {
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
        row.sheet_id, row.tab_name, row.tab_gid, row.campaign_name,
        row.row_count, row.submitted_count, row.last_date, row.checksum,
        row.built_at, row.skip_reason, row.error_msg, row.sheet_modified_at,
        adminName, archiveReason,
      ]);
    }

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
      WHERE sheet_id = $1
    `, [sheetId]);

    // 4. 원본 테이블에서 삭제
    await client.query('DELETE FROM review_index WHERE sheet_id = $1', [sheetId]);
    await client.query('DELETE FROM index_master WHERE sheet_id = $1', [sheetId]);

    // 5. 아카이브 이력 기록
    const campName = masterRows[0]?.campaign_name || '미분류';
    await client.query(`
      INSERT INTO archive_history (action, sheet_id, campaign_name, tab_count, row_count, performed_by, note)
      VALUES ('archive', $1, $2, $3, $4, $5, $6)
    `, [sheetId, campName, masterRows.length, reviewCount, adminName,
        `${archiveReason}: ${masterRows.length}개 탭, ${reviewCount}개 행 아카이브`]);

    await client.query('COMMIT');

    logger.info(`[archive] 캠페인 아카이브 완료: ${campName} (${sheetId.substring(0,15)}...) → ${masterRows.length}탭, ${reviewCount}행 by ${adminName}`);

    res.json({
      ok: true,
      message: `${campName} 아카이브 완료`,
      archived: { tabCount: masterRows.length, rowCount: reviewCount },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/archive/restore — 아카이브 캠페인 복원
// body: { sheetId }
// ═══════════════════════════════════════════════════════════
router.post('/restore', authMiddleware, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { sheetId } = req.body;
    if (!sheetId) return res.status(400).json({ error: 'sheetId가 필요합니다.' });

    const adminName = req.admin?.name || 'system';

    await client.query('BEGIN');

    // 1. 아카이브 마스터 확인
    const { rows: archiveMaster } = await client.query(
      'SELECT * FROM index_master_archive WHERE sheet_id = $1', [sheetId]
    );
    if (archiveMaster.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: false, error: '아카이브된 데이터가 없습니다.' });
    }

    // 2. index_master_archive → index_master 복원
    for (const row of archiveMaster) {
      await client.query(`
        INSERT INTO index_master
          (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
           last_date, checksum, built_at, status, skip_reason, error_msg, sheet_modified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12)
        ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
          campaign_name = EXCLUDED.campaign_name,
          row_count = EXCLUDED.row_count,
          submitted_count = EXCLUDED.submitted_count,
          checksum = EXCLUDED.checksum,
          built_at = EXCLUDED.built_at,
          status = 'active'
      `, [
        row.sheet_id, row.tab_name, row.tab_gid, row.campaign_name,
        row.row_count, row.submitted_count, row.last_date, row.checksum,
        row.built_at, row.skip_reason, row.error_msg, row.sheet_modified_at,
      ]);
    }

    // 3. review_index_archive → review_index 복원
    const { rowCount: reviewCount } = await client.query(`
      INSERT INTO review_index
        (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
         row_index, is_submitted, is_submitted2, product_url, product_name,
         submit_col, submit_col2, row_json, start_date, end_date,
         round, phone8, built_at)
      SELECT
        reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
        row_index, is_submitted, is_submitted2, product_url, product_name,
        submit_col, submit_col2, row_json, start_date, end_date,
        round, phone8, built_at
      FROM review_index_archive
      WHERE sheet_id = $1
    `, [sheetId]);

    // 4. 아카이브 테이블에서 삭제
    await client.query('DELETE FROM review_index_archive WHERE sheet_id = $1', [sheetId]);
    await client.query('DELETE FROM index_master_archive WHERE sheet_id = $1', [sheetId]);

    // 5. 복원 이력 기록
    const campName = archiveMaster[0]?.campaign_name || '미분류';
    await client.query(`
      INSERT INTO archive_history (action, sheet_id, campaign_name, tab_count, row_count, performed_by, note)
      VALUES ('restore', $1, $2, $3, $4, $5, $6)
    `, [sheetId, campName, archiveMaster.length, reviewCount, adminName,
        `복원: ${archiveMaster.length}개 탭, ${reviewCount}개 행 복원`]);

    await client.query('COMMIT');

    logger.info(`[archive] 캠페인 복원 완료: ${campName} (${sheetId.substring(0,15)}...) → ${archiveMaster.length}탭, ${reviewCount}행 by ${adminName}`);

    res.json({
      ok: true,
      message: `${campName} 복원 완료`,
      restored: { tabCount: archiveMaster.length, rowCount: reviewCount },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/archive/history — 아카이브/복원 이력
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

// ═══════════════════════════════════════════════════════════
// POST /api/archive/auto — 완료 캠페인 자동 아카이브
// 모든 탭의 제출률이 100%이거나 force_done/is_closed인 캠페인을 자동 아카이브
// ═══════════════════════════════════════════════════════════
router.post('/auto', authMiddleware, async (req, res, next) => {
  try {
    const adminName = req.admin?.name || 'system';

    // sheetId별로 모든 탭이 완료인 캠페인 찾기
    const { rows } = await pool.query(`
      SELECT im.sheet_id,
        COUNT(*) AS total_tabs,
        COUNT(*) FILTER (
          WHERE im.row_count > 0 AND im.submitted_count >= im.row_count
            OR tc.force_done = TRUE
            OR tc.is_closed = TRUE
        ) AS done_tabs
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      WHERE im.status = 'active'
      GROUP BY im.sheet_id
      HAVING COUNT(*) = COUNT(*) FILTER (
        WHERE im.row_count > 0 AND im.submitted_count >= im.row_count
          OR tc.force_done = TRUE
          OR tc.is_closed = TRUE
      )
      AND COUNT(*) > 0
    `);

    if (rows.length === 0) {
      return res.json({ ok: true, message: '아카이브할 완료 캠페인이 없습니다.', archived: 0 });
    }

    let archivedCount = 0;
    const results = [];

    for (const row of rows) {
      try {
        // 내부적으로 archive/campaign과 동일한 로직 실행
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const { rows: masterRows } = await client.query(
            'SELECT * FROM index_master WHERE sheet_id = $1', [row.sheet_id]
          );

          for (const mr of masterRows) {
            await client.query(`
              INSERT INTO index_master_archive
                (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
                 last_date, checksum, built_at, status, skip_reason, error_msg,
                 sheet_modified_at, archived_by, archive_reason)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'archived',$10,$11,$12,$13,'completed')
              ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
                row_count = EXCLUDED.row_count,
                submitted_count = EXCLUDED.submitted_count,
                archived_at = NOW(),
                archive_reason = 'completed'
            `, [
              mr.sheet_id, mr.tab_name, mr.tab_gid, mr.campaign_name,
              mr.row_count, mr.submitted_count, mr.last_date, mr.checksum,
              mr.built_at, mr.skip_reason, mr.error_msg, mr.sheet_modified_at,
              adminName,
            ]);
          }

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
            FROM review_index WHERE sheet_id = $1
          `, [row.sheet_id]);

          await client.query('DELETE FROM review_index WHERE sheet_id = $1', [row.sheet_id]);
          await client.query('DELETE FROM index_master WHERE sheet_id = $1', [row.sheet_id]);

          const campName = masterRows[0]?.campaign_name || '미분류';
          await client.query(`
            INSERT INTO archive_history (action, sheet_id, campaign_name, tab_count, row_count, performed_by, note)
            VALUES ('archive', $1, $2, $3, $4, $5, $6)
          `, [row.sheet_id, campName, masterRows.length, reviewCount, adminName,
              `자동 아카이브: 모든 탭 완료`]);

          await client.query('COMMIT');
          archivedCount++;
          results.push({ sheetId: row.sheet_id, campaignName: campName, tabs: masterRows.length, rows: reviewCount });
        } catch (innerErr) {
          await client.query('ROLLBACK').catch(() => {});
          logger.error(`[archive/auto] 시트 ${row.sheet_id.substring(0,15)} 아카이브 실패: ${innerErr.message}`);
        } finally {
          client.release();
        }
      } catch (connErr) {
        logger.error(`[archive/auto] DB 연결 실패: ${connErr.message}`);
      }
    }

    logger.info(`[archive/auto] 자동 아카이브 완료: ${archivedCount}/${rows.length}개 캠페인 by ${adminName}`);
    res.json({ ok: true, archived: archivedCount, total: rows.length, results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
