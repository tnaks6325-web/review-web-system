const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const { getSpreadsheetMeta, setSheetHidden } = require('../services/sheets.service');

// ═══════════════════════════════════════════════════════════
// GET /api/archive/detect — 아카이브 대상 자동 감지 (반자동: 감지만)
// 소스 1: index_master 기준 (submitted >= row_count OR closed OR (완) 접두사)
// 소스 2: tab_configs 기준 (closed이지만 index_master에 없는 경우)
// ★ 소스 3: 차수별 마감된 차수 (closed_rounds) — 차수 단위 아카이브 대상
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
        COALESCE(paid.paid_count, 0) AS "paidCount",
        COALESCE(tc.tab_gid, im.tab_gid) AS "tabGid",
        im.built_at       AS "builtAt",
        CASE
          WHEN tc.is_closed = TRUE THEN 'closed'
          WHEN im.row_count > 0 AND im.submitted_count >= im.row_count
               AND COALESCE(paid.paid_count, 0) >= im.row_count THEN 'fully_completed'
          WHEN im.row_count > 0 AND im.submitted_count >= im.row_count THEN 'completed'
          WHEN im.tab_name LIKE '(완)%' THEN 'name_completed'
          ELSE 'unknown'
        END AS "reason",
        TRUE AS "inIndex",
        NULL AS "round"
      FROM index_master im
      LEFT JOIN tab_configs tc ON im.sheet_id = tc.sheet_id AND im.tab_name = tc.tab_name
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE ri.is_submitted2 = 'PAID') AS paid_count
        FROM review_index ri
        WHERE ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name
      ) paid ON true
      WHERE im.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM index_master_archive ima
          WHERE ima.sheet_id = im.sheet_id AND (ima.tab_name = im.tab_name OR ima.tab_gid = im.tab_gid)
        )
        AND (
          tc.is_closed = TRUE
          OR (im.row_count > 0 AND im.submitted_count >= im.row_count)
          OR im.tab_name LIKE '(완)%'
        )

      UNION ALL

      -- 소스 2: tab_configs에만 있는 마감 탭 (index_master에 없음)
      SELECT
        tc.sheet_id       AS "sheetId",
        tc.tab_name       AS "tabName",
        tc.campaign_name  AS "campaignName",
        0                 AS "rowCount",
        0                 AS "submittedCount",
        0                 AS "paidCount",
        tc.tab_gid        AS "tabGid",
        NULL              AS "builtAt",
        CASE
          WHEN tc.is_closed = TRUE THEN 'closed'
          ELSE 'unknown'
        END AS "reason",
        FALSE AS "inIndex",
        NULL AS "round"
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      WHERE tc.is_closed = TRUE
        AND im.sheet_id IS NULL

      ORDER BY "campaignName", "tabName"
    `);

    // ★ 소스 3: 차수별 마감 감지 (closed_rounds에 값이 있는 탭)
    const { rows: roundClosedRows } = await pool.query(`
      SELECT tc.sheet_id AS "sheetId", tc.tab_name AS "tabName",
             tc.campaign_name AS "campaignName", tc.closed_rounds AS "closedRounds",
             tc.tab_gid AS "tabGid",
             tc.archived_rounds AS "archivedRounds"
      FROM tab_configs tc
      WHERE tc.closed_rounds IS NOT NULL AND tc.closed_rounds != ''
        AND tc.is_closed = FALSE
    `);

    // ★ 소스 4: 자동 감지 — 차수별 리뷰완료 + 입금완료 모두 충족된 차수
    // 조건: 해당 차수의 전체 행에서 is_submitted=TRUE AND is_submitted2='PAID'
    // → 리뷰헤더 + 입금헤더 모두 데이터가 채워진 차수 = 아카이브 대상
    // ★ archived_rounds에 이미 포함된 차수는 제외
    const { rows: autoDetectRows } = await pool.query(`
      SELECT
        ri.sheet_id AS "sheetId",
        ri.tab_name AS "tabName",
        COALESCE(tc.campaign_name, ri.campaign_name) AS "campaignName",
        COALESCE(tc.tab_gid, im.tab_gid) AS "tabGid",
        ri.round,
        tc.archived_rounds AS "archivedRounds",
        COUNT(*) AS "totalCount",
        COUNT(*) FILTER (WHERE ri.is_submitted = TRUE) AS "submittedCount",
        COUNT(*) FILTER (WHERE ri.is_submitted2 = 'PAID') AS "paidCount"
      FROM review_index ri
      LEFT JOIN tab_configs tc ON ri.sheet_id = tc.sheet_id AND ri.tab_name = tc.tab_name
      INNER JOIN index_master im ON ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name
      WHERE im.status = 'active'
        AND (tc.is_closed IS NULL OR tc.is_closed = FALSE)
        AND ri.round IS NOT NULL AND ri.round != ''
      GROUP BY ri.sheet_id, ri.tab_name, COALESCE(tc.campaign_name, ri.campaign_name), COALESCE(tc.tab_gid, im.tab_gid), ri.round, tc.archived_rounds
      HAVING
        COUNT(*) > 0
        AND COUNT(*) = COUNT(*) FILTER (WHERE ri.is_submitted = TRUE)
        AND COUNT(*) = COUNT(*) FILTER (WHERE ri.is_submitted2 = 'PAID')
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
        paidCount: parseInt(r.paidCount) || 0,
        tabGid: r.tabGid || null,
        reason: r.reason,
        builtAt: r.builtAt,
        inIndex: r.inIndex,
        round: r.round || null,
      });
    });

    // ★ 차수별 마감 항목 추가 (탭이 아직 전체 마감이 아닌 경우)
    // ★ archived_rounds에 이미 포함된 차수는 제외 (아카이브 후 재표시 방지)
    for (const rc of roundClosedRows) {
      const rounds = rc.closedRounds.split(',').map(s => s.trim()).filter(Boolean);
      if (rounds.length === 0) continue;

      // archived_rounds에 이미 포함된 차수 제외
      const archivedSet = new Set(
        (rc.archivedRounds || '').split(',').map(s => s.trim()).filter(Boolean)
      );
      const activeRounds = rounds.filter(r => !archivedSet.has(r));
      if (activeRounds.length === 0) continue;

      if (!campMap.has(rc.sheetId)) {
        campMap.set(rc.sheetId, {
          sheetId: rc.sheetId,
          campaignName: rc.campaignName || '미분류',
          tabs: [],
        });
      }
      activeRounds.forEach(round => {
        campMap.get(rc.sheetId).tabs.push({
          tabName: rc.tabName,
          rowCount: 0,
          submittedCount: 0,
          tabGid: rc.tabGid || null,
          reason: 'round_closed',
          builtAt: null,
          inIndex: true,
          round,
        });
      });
    }

    // ★ 소스 4 결과 추가: 리뷰완료 + 입금완료 모두 충족된 차수 (자동 감지)
    // 이미 closed_rounds에 포함된 차수나 이미 감지된 항목은 중복 제외
    const existingKeys = new Set();
    for (const [, camp] of campMap) {
      for (const tab of camp.tabs) {
        if (tab.round) {
          existingKeys.add(`${camp.sheetId}||${tab.tabName}||${tab.round}`);
        }
      }
    }

    for (const ad of autoDetectRows) {
      const key = `${ad.sheetId}||${ad.tabName}||${ad.round}`;
      if (existingKeys.has(key)) continue; // 이미 감지된 항목 → 중복 방지

      // ★ archived_rounds에 이미 포함된 차수는 제외 (아카이브 후 재표시 방지)
      if (ad.archivedRounds) {
        const archivedSet = new Set(ad.archivedRounds.split(',').map(s => s.trim()).filter(Boolean));
        if (archivedSet.has(ad.round.trim())) continue;
      }

      if (!campMap.has(ad.sheetId)) {
        campMap.set(ad.sheetId, {
          sheetId: ad.sheetId,
          campaignName: ad.campaignName || '미분류',
          tabs: [],
        });
      }
      campMap.get(ad.sheetId).tabs.push({
        tabName: ad.tabName,
        rowCount: parseInt(ad.totalCount) || 0,
        submittedCount: parseInt(ad.submittedCount) || 0,
        paidCount: parseInt(ad.paidCount) || 0,
        tabGid: ad.tabGid || null,
        reason: 'auto_complete',  // 리뷰+입금 모두 완료 자동감지
        builtAt: null,
        inIndex: true,
        round: ad.round,
      });
      existingKeys.add(key);
    }

    // ★ Google Sheets API로 실시간 gid 조회 → DB의 stale gid 교체
    const campaigns = Array.from(campMap.values());
    const uniqueSheetIds = [...new Set(campaigns.map(c => c.sheetId))];
    
    // 시트별 tabName→gid 실시간 맵 구축 + hidden 상태 포함
    const liveGidMap = {}; // { sheetId: { tabName: gid } }
    const hiddenGidMap = {}; // { sheetId: Set(gid) } — 숨김 탭 gid 집합
    await Promise.all(uniqueSheetIds.map(async (sheetId) => {
      try {
        const meta = await getSpreadsheetMeta(sheetId);
        const map = {};
        const hiddenSet = new Set();
        for (const s of (meta || [])) {
          if (s.properties) {
            const gidStr = String(s.properties.sheetId);
            map[s.properties.title] = gidStr;
            // hidden 상태 감지: properties.hidden === true
            if (s.properties.hidden) {
              hiddenSet.add(gidStr);
            }
          }
        }
        liveGidMap[sheetId] = map;
        hiddenGidMap[sheetId] = hiddenSet;
      } catch (e) {
        logger.warn(`[archive/detect] sheet meta 조회 실패: ${sheetId.substring(0,15)}... — ${e.message}`);
        liveGidMap[sheetId] = null; // 실패 시 DB값 유지
        hiddenGidMap[sheetId] = new Set();
      }
    }));

    // 각 탭의 tabGid를 실시간 값으로 교체 + hidden 상태 표시
    // 전략: 1) tabName으로 매칭 → 2) DB gid가 시트에 존재하면 유지 → 3) 없으면 null
    for (const camp of campaigns) {
      const map = liveGidMap[camp.sheetId];
      if (!map) continue; // 조회 실패 시 DB값 유지

      const hiddenSet = hiddenGidMap[camp.sheetId] || new Set();

      // gid→tabName 역방향 맵 구축 (이름 변경 대응)
      const gidToName = {};
      for (const [name, gid] of Object.entries(map)) {
        gidToName[gid] = name;
      }
      // 유효한 gid 집합
      const validGids = new Set(Object.values(map));

      for (const tab of camp.tabs) {
        // 1) tabName 정확 매칭 → 최우선
        const liveGid = map[tab.tabName];
        if (liveGid) {
          tab.tabGid = liveGid;
          // ★ 숨김 탭 여부 표시
          if (hiddenSet.has(liveGid)) {
            tab.hidden = true;
          }
          continue;
        }
        // 2) DB gid가 시트에 여전히 존재 → gid 유효, 탭 이름만 변경됨
        const dbGidStr = tab.tabGid ? String(tab.tabGid) : null;
        if (dbGidStr && validGids.has(dbGidStr)) {
          // gid는 유효 — 실제 탭 이름을 표시용으로 추가
          tab.liveTabName = gidToName[dbGidStr] || null;
          // ★ 숨김 탭 여부 표시
          if (hiddenSet.has(dbGidStr)) {
            tab.hidden = true;
          }
          continue;
        }
        // 3) 탭이 시트에서 완전히 삭제됨 → gid 무효화
        tab.tabGid = null;
        tab.deleted = true;
      }
    }

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
// POST /api/archive/tabs — 개별 탭/차수 단위 아카이브 실행
// body: { tabs: [{ sheetId, tabName, round? }], reason? }
// ★ round가 있으면 해당 차수의 review_index 행만 아카이브
// round가 없으면 기존처럼 탭 전체 아카이브
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

    for (const { sheetId, tabName, round } of tabs) {
      if (!sheetId || !tabName) continue;

      try {
        // ★ 차수 단위 아카이브: round가 지정된 경우 해당 차수의 review_index 행만 이동
        if (round) {
          // review_index에서 해당 차수 행만 아카이브
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
            WHERE sheet_id = $1 AND tab_name = $2 AND round = $3
          `, [sheetId, tabName, round]);

          // 원본에서 해당 차수 행 삭제
          await client.query(
            'DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2 AND round = $3',
            [sheetId, tabName, round]
          );

          // index_master의 row_count/submitted_count 갱신
          const { rows: remaining } = await client.query(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN is_submitted THEN 1 ELSE 0 END) AS submitted
            FROM review_index
            WHERE sheet_id = $1 AND tab_name = $2
          `, [sheetId, tabName]);

          const newTotal = parseInt(remaining[0]?.total) || 0;
          const newSubmitted = parseInt(remaining[0]?.submitted) || 0;

          if (newTotal > 0) {
            await client.query(
              'UPDATE index_master SET row_count = $1, submitted_count = $2 WHERE sheet_id = $3 AND tab_name = $4',
              [newTotal, newSubmitted, sheetId, tabName]
            );
          } else {
            // 남은 행이 없으면 index_master도 아카이브
            const { rows: masterRows } = await client.query(
              'SELECT * FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
              [sheetId, tabName]
            );
            if (masterRows.length > 0) {
              const mr = masterRows[0];
              await client.query(`
                INSERT INTO index_master_archive
                  (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count,
                   last_date, checksum, built_at, status, skip_reason, error_msg,
                   sheet_modified_at, archived_by, archive_reason)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'archived',$10,$11,$12,$13,$14)
                ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
                  archived_at = NOW(), archived_by = EXCLUDED.archived_by,
                  archive_reason = EXCLUDED.archive_reason
              `, [
                mr.sheet_id, mr.tab_name, mr.tab_gid, mr.campaign_name,
                mr.row_count, mr.submitted_count, mr.last_date, mr.checksum,
                mr.built_at, mr.skip_reason, mr.error_msg, mr.sheet_modified_at,
                adminName, archiveReason,
              ]);
              await client.query(
                'DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
                [sheetId, tabName]
              );
            }
          }

          // closed_rounds에서 해당 차수 제거 + archived_rounds에 추가
          const { rows: tcRows } = await client.query(
            'SELECT closed_rounds, archived_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
            [sheetId, tabName]
          );
          if (tcRows.length > 0) {
            const existing = (tcRows[0].closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
            const updated = existing.filter(r => r !== round).join(',');
            // archived_rounds에 해당 차수 추가 (중복 방지)
            const archivedExisting = (tcRows[0].archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
            if (!archivedExisting.includes(round)) archivedExisting.push(round);
            const archivedUpdated = archivedExisting.join(',');
            await client.query(
              'UPDATE tab_configs SET closed_rounds = $1, archived_rounds = $2, updated_at = NOW() WHERE sheet_id = $3 AND tab_name = $4',
              [updated, archivedUpdated, sheetId, tabName]
            );
          }

          archivedTabs++;
          archivedRows += reviewCount;
          results.push({
            sheetId, tabName, round,
            rowCount: reviewCount,
            status: 'archived_round',
          });
          continue;
        }

        // ── 기존 탭 전체 아카이브 ──
        // 1. index_master에서 해당 탭 확인
        const { rows: masterRows } = await client.query(
          'SELECT * FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );

        if (masterRows.length === 0) {
          // index_master에 없는 경우: tab_configs에서만 정리
          // (마감 상태인데 인덱스에 없는 탭 — 과거 데이터)
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
// ★ 차수 단위 아카이브도 포함 (review_index_archive에서 직접 조회)
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

    // 데이터 조회 (차수 정보 포함)
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
        ima.built_at        AS "builtAt",
        (
          SELECT STRING_AGG(DISTINCT ria.round, ', ' ORDER BY ria.round)
          FROM review_index_archive ria
          WHERE ria.sheet_id = ima.sheet_id AND ria.tab_name = ima.tab_name
            AND ria.round IS NOT NULL AND ria.round != ''
        ) AS "rounds"
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
        rounds: r.rounds || null,
      });
      camp.totalRows += rowCount;
      camp.totalSubmitted += submittedCount;
      totalRows += rowCount;
      totalSubmitted += submittedCount;
    });

    // ★ 차수 단위 아카이브: index_master_archive에 없지만 review_index_archive에만 있는 항목
    // (탭이 아직 활성이지만 특정 차수만 아카이브된 경우)
    const roundOnlyParams = [];
    const roundOnlyConditions = [];
    let roParamIdx = 1;

    if (q) {
      roundOnlyConditions.push(`(ria.campaign_name ILIKE $${roParamIdx} OR ria.tab_name ILIKE $${roParamIdx})`);
      roundOnlyParams.push(`%${q}%`);
      roParamIdx++;
    }
    if (from) {
      roundOnlyConditions.push(`ria.archived_at >= $${roParamIdx}`);
      roundOnlyParams.push(from);
      roParamIdx++;
    }
    if (to) {
      roundOnlyConditions.push(`ria.archived_at <= $${roParamIdx}::date + interval '1 day'`);
      roundOnlyParams.push(to);
      roParamIdx++;
    }

    const roWhereClause = roundOnlyConditions.length > 0
      ? 'AND ' + roundOnlyConditions.join(' AND ')
      : '';

    const { rows: roundOnlyRows } = await pool.query(`
      SELECT
        ria.sheet_id        AS "sheetId",
        ria.campaign_name   AS "campaignName",
        ria.tab_name        AS "tabName",
        ria.round,
        COUNT(*)            AS "rowCount",
        COUNT(*) FILTER (WHERE ria.is_submitted = TRUE) AS "submittedCount",
        MAX(ria.archived_at) AS "archivedAt"
      FROM review_index_archive ria
      WHERE ria.round IS NOT NULL AND ria.round != ''
        AND NOT EXISTS (
          SELECT 1 FROM index_master_archive ima
          WHERE ima.sheet_id = ria.sheet_id AND ima.tab_name = ria.tab_name
        )
        ${roWhereClause}
      GROUP BY ria.sheet_id, ria.campaign_name, ria.tab_name, ria.round
      ORDER BY MAX(ria.archived_at) DESC
    `, roundOnlyParams);

    // 차수 단위 아카이브 항목을 campMap에 추가
    for (const r of roundOnlyRows) {
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
        archivedBy: 'system',
        archiveReason: 'round_archive',
        rounds: r.round,
        roundOnly: true,  // ★ 프론트엔드에서 차수 단위임을 구분
      });
      camp.totalRows += rowCount;
      camp.totalSubmitted += submittedCount;
      totalRows += rowCount;
      totalSubmitted += submittedCount;
    }

    const campaigns = Array.from(campMap.values());
    res.json({
      ok: true,
      campaigns,
      totalCampaigns: campaigns.length,
      totalTabs: totalCount + roundOnlyRows.length,
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

// ═══════════════════════════════════════════════════════════
// POST /api/archive/restore — 아카이브된 탭을 대시보드로 복원
// body: { tabs: [{ sheetId, tabName }] }
// index_master_archive → index_master, review_index_archive → review_index 복원
// tab_configs 재생성
// ═══════════════════════════════════════════════════════════
router.post('/restore', authMiddleware, async (req, res, next) => {
  try {
    const { tabs } = req.body;
    if (!tabs || !Array.isArray(tabs) || tabs.length === 0) {
      return res.status(400).json({ error: '복원할 탭 목록이 필요합니다.' });
    }

    const adminName = req.adminName || 'admin';
    const client = await pool.connect();
    let restoredTabs = 0;
    let restoredRows = 0;
    const results = [];

    try {
      await client.query('BEGIN');

      for (const tab of tabs) {
        const { sheetId, tabName } = tab;
        if (!sheetId || !tabName) {
          results.push({ sheetId, tabName, status: 'skipped', reason: 'sheetId/tabName 누락' });
          continue;
        }

        // 1. index_master_archive에서 해당 탭 확인
        const { rows: archiveRows } = await client.query(
          'SELECT * FROM index_master_archive WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );

        if (archiveRows.length === 0) {
          results.push({ sheetId, tabName, status: 'skipped', reason: '아카이브에 없음' });
          continue;
        }

        const ar = archiveRows[0];

        // 2. index_master_archive → index_master 복원
        await client.query(`
          INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, checksum, built_at,
                                    row_count, submitted_count, status, sheet_modified_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
          ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
            tab_gid = EXCLUDED.tab_gid,
            campaign_name = EXCLUDED.campaign_name,
            checksum = EXCLUDED.checksum,
            built_at = EXCLUDED.built_at,
            row_count = EXCLUDED.row_count,
            submitted_count = EXCLUDED.submitted_count,
            status = 'active',
            sheet_modified_at = EXCLUDED.sheet_modified_at
        `, [
          ar.sheet_id, ar.tab_name, ar.tab_gid, ar.campaign_name,
          ar.checksum, ar.built_at, ar.row_count, ar.submitted_count,
          ar.sheet_modified_at
        ]);

        // 3. review_index_archive → review_index 복원
        // ★ DISTINCT ON으로 중복 row_index 제거 (ON CONFLICT 중복 에러 방지)
        const { rowCount: reviewCount } = await client.query(`
          INSERT INTO review_index
            (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
             row_index, is_submitted, is_submitted2, product_url, product_name,
             submit_col, submit_col2, row_json, start_date, end_date,
             round, phone8, built_at)
          SELECT DISTINCT ON (sheet_id, tab_name, row_index)
            reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
            row_index, is_submitted, is_submitted2, product_url, product_name,
            submit_col, submit_col2, row_json, start_date, end_date,
            round, phone8, built_at
          FROM review_index_archive
          WHERE sheet_id = $1 AND tab_name = $2
          ORDER BY sheet_id, tab_name, row_index, built_at DESC
          ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
            reviewer_name = EXCLUDED.reviewer_name,
            is_submitted = EXCLUDED.is_submitted,
            is_submitted2 = EXCLUDED.is_submitted2,
            built_at = EXCLUDED.built_at
        `, [sheetId, tabName]);

        // 4. review_index_archive에서 삭제
        await client.query(
          'DELETE FROM review_index_archive WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );

        // 5. index_master_archive에서 삭제
        await client.query(
          'DELETE FROM index_master_archive WHERE sheet_id = $1 AND tab_name = $2',
          [sheetId, tabName]
        );

        // 6. tab_configs 재생성 (없으면 생성)
        await client.query(`
          INSERT INTO tab_configs (sheet_id, tab_name, tab_gid, campaign_name, sheet_url, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
            tab_gid = COALESCE(EXCLUDED.tab_gid, tab_configs.tab_gid),
            campaign_name = COALESCE(NULLIF(EXCLUDED.campaign_name, ''), tab_configs.campaign_name),
            is_closed = FALSE,
            updated_at = NOW()
        `, [
          sheetId, tabName, ar.tab_gid || null,
          ar.campaign_name || '',
          `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
        ]);

        // 7. archived_rounds에서 관련 차수 제거 (차수 단위 아카이브였을 경우 대비)
        await client.query(`
          UPDATE tab_configs SET archived_rounds = '' WHERE sheet_id = $1 AND tab_name = $2
        `, [sheetId, tabName]);

        restoredTabs++;
        restoredRows += reviewCount;
        results.push({
          sheetId, tabName,
          campaignName: ar.campaign_name,
          rowCount: reviewCount,
          status: 'restored',
        });
      }

      // 8. 이력 기록
      await client.query(`
        INSERT INTO archive_history (action, sheet_id, campaign_name, tab_count, row_count, performed_by, note)
        VALUES ('restore', $1, $2, $3, $4, $5, $6)
      `, [
        tabs[0]?.sheetId || '',
        results.find(r => r.campaignName)?.campaignName || '복원',
        restoredTabs,
        restoredRows,
        adminName,
        `복원: ${results.filter(r => r.status === 'restored').map(r => r.tabName).join(', ')}`
      ]);

      await client.query('COMMIT');

      logger.info(`[archive/restore] ${adminName}: ${restoredTabs}개 탭, ${restoredRows}행 복원 완료`);
      res.json({
        ok: true,
        restoredTabs,
        restoredRows,
        results,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`[archive/restore] 오류: ${err.message}`, err.stack);
    res.status(500).json({ error: '아카이브 복원 중 오류가 발생했습니다.', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/archive/restore-round — 차수 단위 아카이브 복원
// body: { sheetId, tabName, round }
// ★ tab_configs.archived_rounds에서 해당 차수 제거
// ★ review_index_archive → review_index 복원 (해당 차수만)
// ═══════════════════════════════════════════════════════════
router.post('/restore-round', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, round } = req.body;
    if (!sheetId || !tabName || !round) {
      return res.status(400).json({ error: 'sheetId, tabName, round 모두 필요합니다.' });
    }

    const adminName = req.adminName || 'admin';
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. tab_configs에서 archived_rounds 업데이트 (해당 차수 제거)
      const { rows: tcRows } = await client.query(
        'SELECT archived_rounds, closed_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
        [sheetId, tabName]
      );

      if (tcRows.length > 0) {
        const archivedRounds = (tcRows[0].archived_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
        const newArchived = archivedRounds.filter(r => r !== String(round));
        // closed_rounds에서도 제거 (복원하면 다시 활성 차수)
        const closedRounds = (tcRows[0].closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
        const newClosed = closedRounds.filter(r => r !== String(round));

        await client.query(
          'UPDATE tab_configs SET archived_rounds = $1, closed_rounds = $2, updated_at = NOW() WHERE sheet_id = $3 AND tab_name = $4',
          [newArchived.join(','), newClosed.join(','), sheetId, tabName]
        );
      }

      // 2. review_index_archive → review_index 복원 (해당 차수만)
      const { rowCount: reviewCount } = await client.query(`
        INSERT INTO review_index
          (reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
           row_index, is_submitted, is_submitted2, product_url, product_name,
           submit_col, submit_col2, row_json, start_date, end_date,
           round, phone8, built_at)
        SELECT DISTINCT ON (sheet_id, tab_name, row_index)
          reviewer_name, sheet_id, tab_gid, tab_name, campaign_name,
          row_index, is_submitted, is_submitted2, product_url, product_name,
          submit_col, submit_col2, row_json, start_date, end_date,
          round, phone8, built_at
        FROM review_index_archive
        WHERE sheet_id = $1 AND tab_name = $2 AND round = $3
        ORDER BY sheet_id, tab_name, row_index, built_at DESC
        ON CONFLICT (sheet_id, tab_name, row_index) DO UPDATE SET
          reviewer_name = EXCLUDED.reviewer_name,
          is_submitted = EXCLUDED.is_submitted,
          is_submitted2 = EXCLUDED.is_submitted2,
          round = EXCLUDED.round,
          built_at = EXCLUDED.built_at
      `, [sheetId, tabName, String(round)]);

      // 3. review_index_archive에서 해당 차수 삭제
      await client.query(
        'DELETE FROM review_index_archive WHERE sheet_id = $1 AND tab_name = $2 AND round = $3',
        [sheetId, tabName, String(round)]
      );

      // 4. 아카이브 이력 기록
      await client.query(`
        INSERT INTO archive_history (action, admin_name, tab_count, row_count, note)
        VALUES ('restore_round', $1, 1, $2, $3)
      `, [adminName, reviewCount, `차수 복원: ${tabName} ${round}차`]);

      await client.query('COMMIT');

      logger.info(`[archive/restore-round] ${adminName}: ${tabName} ${round}차 복원 (${reviewCount}행)`);
      res.json({
        ok: true,
        restored: true,
        tabName,
        round,
        reviewCount,
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`[archive/restore-round] 오류: ${err.message}`, err.stack);
    res.status(500).json({ error: '차수 복원 중 오류가 발생했습니다.', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/archive/unhide-tab — 숨김 탭을 표시(unhide) 처리
// body: { sheetId, tabGid }
// Google Sheets API로 해당 탭의 hidden 속성을 false로 변경
// ═══════════════════════════════════════════════════════════
router.post('/unhide-tab', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabGid } = req.body;
    if (!sheetId || !tabGid) {
      return res.status(400).json({ error: 'sheetId와 tabGid가 필요합니다.' });
    }
    await setSheetHidden(sheetId, parseInt(tabGid), false);
    logger.info(`[archive/unhide-tab] 탭 표시 처리 완료: sheet=${sheetId.substring(0,15)}... gid=${tabGid}`);
    res.json({ ok: true, message: '탭이 표시(unhide) 처리되었습니다.' });
  } catch (err) {
    logger.error(`[archive/unhide-tab] 실패: ${err.message}`);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/archive/hide-tab — 탭을 숨김(hide) 처리
// body: { sheetId, tabGid }
// Google Sheets API로 해당 탭의 hidden 속성을 true로 변경
// ═══════════════════════════════════════════════════════════
router.post('/hide-tab', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabGid } = req.body;
    if (!sheetId || !tabGid) {
      return res.status(400).json({ error: 'sheetId와 tabGid가 필요합니다.' });
    }
    await setSheetHidden(sheetId, parseInt(tabGid), true);
    logger.info(`[archive/hide-tab] 탭 숨김 처리 완료: sheet=${sheetId.substring(0,15)}... gid=${tabGid}`);
    res.json({ ok: true, message: '탭이 숨김(hide) 처리되었습니다.' });
  } catch (err) {
    logger.error(`[archive/hide-tab] 실패: ${err.message}`);
    next(err);
  }
});

module.exports = router;
