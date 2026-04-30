const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');
const { getSpreadsheetMeta } = require('../services/sheets.service');
// [DEPRECATED — v11.8.0] masterSheet.service.js 함수들은 2탭 통합으로 deprecated
// import는 유지하되 라우트에서 deprecated 응답 반환
const { syncMasterSheetToDB, scanAndPopulateMaster, applyCachedScanAndSync, hasScanCache, syncSettingsOnly } = require('../services/masterSheet.service');
const { runIndexScan, applyCachedIndexScan, hasIndexScanCache, syncTabListToDB } = require('../services/indexScan.service');
const { logger } = require('../utils/logger');
const { throttledCall, throttledMap } = require('../utils/sheetsThrottle');

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
      capture_folder_url: b.captureFolderUrl !== undefined ? b.captureFolderUrl : undefined,
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

// POST /api/tab/closed — 마감 설정 (GAS: setClosed)
// ★ 차수 단위 마감 지원: items[].round 가 있으면 closed_rounds에 추가/제거
// round가 없으면 기존처럼 탭 전체 is_closed 토글
router.post('/closed', authMiddleware, async (req, res, next) => {
  try {
    // 두 가지 형태 지원: { sheetId, tabs } 또는 { items }
    const items = req.body.items || req.body.tabs;
    const topSheetId = req.body.sheetId;

    if (!Array.isArray(items)) {
      return res.json({ error: 'items(또는 tabs) 배열이 필요합니다.' });
    }

    for (const t of items) {
      const sid = t.sheetId || topSheetId;
      if (!sid || !t.tabName) continue;

      if (t.round) {
        // ── 차수 단위 마감/해제 ──
        const { rows } = await pool.query(
          'SELECT closed_rounds FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
          [sid, t.tabName]
        );
        if (rows.length === 0) continue;

        const existing = (rows[0].closed_rounds || '').split(',').map(s => s.trim()).filter(Boolean);
        const roundSet = new Set(existing);

        if (t.isClosed) {
          roundSet.add(t.round);
        } else {
          roundSet.delete(t.round);
        }

        const newClosedRounds = Array.from(roundSet).join(',');

        await pool.query(
          'UPDATE tab_configs SET closed_rounds = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [newClosedRounds, sid, t.tabName]
        );
      } else {
        // ── 기존 탭 전체 마감/해제 ──
        await pool.query(
          'UPDATE tab_configs SET is_closed = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [Boolean(t.isClosed), sid, t.tabName]
        );
      }
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
      WHERE is_closed = FALSE
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
// POST /api/tab/sync-from-sheet — [DEPRECATED] 베이스시트 의존성 완전 제거됨
// DB(tab_configs)가 원본 — 이 엔드포인트는 더 이상 사용하지 않음
// ═══════════════════════════════════════════════════════════
router.post('/sync-from-sheet', authMiddleware, async (req, res) => {
  res.json({
    ok: false,
    deprecated: true,
    message: '베이스시트 의존성이 제거되었습니다. DB(tab_configs)가 원본이므로 시트 동기화가 필요하지 않습니다. 웹 UI에서 직접 탭을 관리하세요.',
  });
});

// ═══════════════════════════════════════════════════════════
// POST /api/tab/sync-tab-names — 시트 탭명·URL·GID 실시간 동기화
// Google Sheets API로 각 시트의 실제 탭명(GID 기반)을 조회하여
// tab_configs, index_master, review_index의 탭명과 URL을 일괄 업데이트
//
// ★ Phase 7.1: GID 없는 탭 자동 보충 로직 추가
//   - index_master에 tab_gid가 없는 탭: 시트 메타에서 이름 매칭으로 GID 찾아 업데이트
//   - GID 보충 후 다음 빌드/동기화부터 정확한 GID 기반 매칭 가능
//   - 권한 오류 시 해당 시트에 속한 캠페인 목록도 표시
// ═══════════════════════════════════════════════════════════
router.post('/sync-tab-names', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun } = req.body || {};
    const startTime = Date.now();

    // 1. 활성 탭 목록 + index_master의 tab_gid 정보 수집
    //    LEFT JOIN으로 index_master에 없는 탭도 포함
    const { rows: allTabs } = await pool.query(`
      SELECT tc.sheet_id, tc.tab_name, tc.sheet_url, tc.campaign_name,
             tc.is_closed,
             im.tab_gid, im.tab_name AS index_tab_name
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      ORDER BY tc.campaign_name, tc.tab_name
    `);

    // 2. 고유 sheet_id 별로 그룹핑
    const sheetMap = {};
    allTabs.forEach(t => {
      if (!sheetMap[t.sheet_id]) sheetMap[t.sheet_id] = [];
      sheetMap[t.sheet_id].push(t);
    });

    const sheetIds = Object.keys(sheetMap);
    logger.info(`[sync-tab-names] ${sheetIds.length}개 시트, ${allTabs.length}개 탭 대상`);

    const results = [];
    let renamed = 0, urlFixed = 0, gidFilled = 0, skipped = 0, errors = 0;
    const errorDetails = [];

    // 3. 각 시트별로 실제 탭 메타 조회 (배치 병렬 처리 — quota 안전 + 속도 최적화)
    //    Google API 읽기 quota: 분당 60 → 5개씩 병렬 요청, 배치 간 2초 간격
    const BATCH_SIZE = 5;
    const quotaFailedSheetIds = []; // quota 초과로 실패한 시트 → 나중에 재시도

    async function processBatch(batchSheetIds) {
      const batchResults = await Promise.allSettled(
        batchSheetIds.map(sheetId => getSpreadsheetMeta(sheetId).then(meta => ({ sheetId, meta })))
      );

      const retryIds = [];
      for (let idx = 0; idx < batchResults.length; idx++) {
        const result = batchResults[idx];
        if (result.status === 'rejected') {
          const errSheetId = batchSheetIds[idx];
          const sheetErr = result.reason;
          // quota 초과는 재시도 대상
          if (sheetErr.message && /quota|rate limit/i.test(sheetErr.message)) {
            retryIds.push(errSheetId);
            continue;
          }
          // 기타 에러는 즉시 기록
          const dbTabs = sheetMap[errSheetId] || [];
          const campaigns = [...new Set(dbTabs.map(t => t.campaign_name).filter(Boolean))];
          const tabNames = dbTabs.map(t => t.tab_name).slice(0, 5);
          if (errorDetails.length < 10) {
            errorDetails.push(`시트 ${errSheetId.substring(0, 15)}... (${campaigns.join(', ') || '미분류'}): ${sheetErr.message}`);
          }
          results.push({
            sheetId: errSheetId.substring(0, 15) + '...',
            status: 'sheet_error',
            error: sheetErr.message,
            campaign: campaigns.join(', ') || '미분류',
            affectedTabs: tabNames,
            affectedTabCount: dbTabs.length,
            hint: sheetErr.message.includes('permission')
              ? '서비스 계정에 시트 편집 권한을 공유해주세요.'
              : sheetErr.message.includes('not found')
                ? '시트가 삭제되었거나 ID가 잘못되었습니다.'
                : undefined,
          });
          errors++;
          continue;
        }

        const { sheetId, meta } = result.value;
        if (!meta || meta.length === 0) { skipped++; continue; }

        const realGidMap = {};
        const realNameMap = {};
        meta.forEach(s => {
          const gid = String(s.properties.sheetId);
          const title = s.properties.title;
          realGidMap[gid] = { title, gid };
          realNameMap[title] = { title, gid };
        });

        const dbTabs = sheetMap[sheetId];
        const correctSheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

        for (const dbTab of dbTabs) {
          const oldName = dbTab.tab_name;
          const dbGid = dbTab.tab_gid ? String(dbTab.tab_gid) : null;
          let newName = null;
          let matchMethod = null;
          let shouldFillGid = false;  // GID 보충 필요 여부
          let fillGidValue = null;    // 보충할 GID 값

          // ── 방법 1: GID 기반 매칭 (가장 정확) ──
          if (dbGid && realGidMap[dbGid]) {
            const real = realGidMap[dbGid];
            if (real.title !== oldName) {
              newName = real.title;
              matchMethod = 'gid';
            }
          }

          // ── 방법 2: GID 없을 때 — 이름 기반 매칭 + GID 자동 보충 ──
          if (!dbGid) {
            if (realNameMap[oldName]) {
              // DB 탭명이 시트에 존재 → GID를 보충 (이름은 정확히 일치)
              shouldFillGid = true;
              fillGidValue = realNameMap[oldName].gid;
              matchMethod = 'name_match_gid_fill';
            } else {
              // DB 탭명이 시트에 없음 → 시트에서 삭제되었거나 이름이 변경됨
              // 이름이 변경된 경우, GID 없이는 어느 탭인지 특정할 수 없음
              results.push({
                sheetId: sheetId.substring(0, 15) + '...',
                oldName,
                newName: null,
                status: 'no_gid_missing',
                campaign: dbTab.campaign_name || '',
                message: 'GID 없음 + 시트에 해당 탭명 없음 — 삭제되었거나 이름 변경됨',
                hint: '인덱스 전체 갱신을 실행하면 GID가 자동으로 매핑됩니다.',
                sheetTabs: meta.map(s => s.properties.title).slice(0, 10),
              });
              skipped++;
              continue;
            }
          }

          // ── URL 불일치 확인 ──
          const currentUrl = (dbTab.sheet_url || '').split('#')[0];
          const urlMismatch = currentUrl && currentUrl !== correctSheetUrl;

          // 변경 없고 URL도 맞고 GID 보충도 불필요 → 스킵
          if (!newName && !urlMismatch && !shouldFillGid) {
            skipped++;
            continue;
          }

          // ── 변경 사항 발견 → 결과 엔트리 생성 ──
          const entry = {
            sheetId: sheetId.substring(0, 15) + '...',
            fullSheetId: sheetId,
            oldName,
            newName: newName || oldName,
            matchMethod: matchMethod || 'name_ok',
            campaign: dbTab.campaign_name || '',
            urlFixed: urlMismatch,
            oldUrl: urlMismatch ? currentUrl : null,
            newUrl: urlMismatch ? correctSheetUrl : null,
            gidFilled: shouldFillGid,
            filledGid: fillGidValue,
          };

          if (newName) {
            entry.status = dryRun ? 'dry_run' : 'renamed';
          } else if (shouldFillGid && !urlMismatch) {
            entry.status = dryRun ? 'dry_run_gid' : 'gid_filled';
          } else if (urlMismatch) {
            entry.status = dryRun ? 'dry_run_url' : 'url_fixed';
          }

          if (!dryRun) {
            try {
              // ── 탭명 변경 (GID 기반으로 확인된 rename) ──
              if (newName) {
                await pool.query(
                  `UPDATE tab_configs SET tab_name = $1, sheet_url = $2, updated_at = NOW()
                   WHERE sheet_id = $3 AND tab_name = $4`,
                  [newName, correctSheetUrl, sheetId, oldName]
                );
                await pool.query(
                  'UPDATE index_master SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3',
                  [newName, sheetId, oldName]
                );
                const riResult = await pool.query(
                  'UPDATE review_index SET tab_name = $1 WHERE sheet_id = $2 AND tab_name = $3',
                  [newName, sheetId, oldName]
                );
                entry.reviewIndexUpdated = riResult.rowCount;
                renamed++;
                logger.info(`[sync-tab-names] 탭명 변경: "${oldName}" → "${newName}" (sheet=${sheetId.substring(0, 15)})`);
              }

              // ── GID 보충 (index_master에 tab_gid 업데이트) ──
              if (shouldFillGid && fillGidValue) {
                const gidResult = await pool.query(
                  'UPDATE index_master SET tab_gid = $1 WHERE sheet_id = $2 AND tab_name = $3 AND (tab_gid IS NULL OR tab_gid = \'\')',
                  [fillGidValue, sheetId, newName || oldName]
                );
                // review_index에도 tab_gid 보충
                await pool.query(
                  'UPDATE review_index SET tab_gid = $1 WHERE sheet_id = $2 AND tab_name = $3 AND (tab_gid IS NULL OR tab_gid = \'\')',
                  [fillGidValue, sheetId, newName || oldName]
                );
                if (gidResult.rowCount > 0) {
                  gidFilled++;
                  logger.info(`[sync-tab-names] GID 보충: "${newName || oldName}" → gid=${fillGidValue} (sheet=${sheetId.substring(0, 15)})`);
                }
              }

              // ── URL 교정 ──
              if (urlMismatch) {
                await pool.query(
                  'UPDATE tab_configs SET sheet_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
                  [correctSheetUrl, sheetId, newName || oldName]
                );
                urlFixed++;
              }
            } catch (updateErr) {
              entry.status = 'error';
              entry.error = updateErr.message;
              errors++;
              if (errorDetails.length < 10) errorDetails.push(`${oldName}: ${updateErr.message}`);
            }
          }

          results.push(entry);
        }
      }

      return retryIds;
    } // end processBatch

    // ── 메인 배치 루프 ──
    for (let i = 0; i < sheetIds.length; i += BATCH_SIZE) {
      const batch = sheetIds.slice(i, i + BATCH_SIZE);
      const retryIds = await processBatch(batch);
      quotaFailedSheetIds.push(...retryIds);

      // 배치 간 2초 대기 (Google API quota: 분당 60 읽기 → 5개/2초 = ~25회/분, 다른 서비스와 quota 공유)
      if (i + BATCH_SIZE < sheetIds.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // ── Quota 실패 시트 재시도 (3초 대기 후 1개씩 순차 처리, 50초 초과시 스킵) ──
    if (quotaFailedSheetIds.length > 0) {
      const elapsedSoFar = (Date.now() - startTime) / 1000;
      if (elapsedSoFar < 45) {
        logger.info(`[sync-tab-names] quota 실패 ${quotaFailedSheetIds.length}건 → 3초 후 재시도 (경과 ${elapsedSoFar.toFixed(1)}s)`);
        await new Promise(r => setTimeout(r, 3000));
        for (const retryId of quotaFailedSheetIds) {
          if ((Date.now() - startTime) / 1000 > 55) {
            logger.warn(`[sync-tab-names] 55초 초과 — 남은 재시도 스킵`);
            break;
          }
          const retryFailed = await processBatch([retryId]);
          if (retryFailed.length > 0) {
            errors++;
            const dbTabs = sheetMap[retryId] || [];
            const campaigns = [...new Set(dbTabs.map(t => t.campaign_name).filter(Boolean))];
            if (errorDetails.length < 10) {
              errorDetails.push(`시트 ${retryId.substring(0, 15)}... (${campaigns.join(', ') || '미분류'}): Quota 재시도 실패`);
            }
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      } else {
        logger.warn(`[sync-tab-names] 이미 ${elapsedSoFar.toFixed(1)}초 경과 — 재시도 스킵 (${quotaFailedSheetIds.length}건)`);
        for (const retryId of quotaFailedSheetIds) {
          errors++;
          const dbTabs = sheetMap[retryId] || [];
          const campaigns = [...new Set(dbTabs.map(t => t.campaign_name).filter(Boolean))];
          if (errorDetails.length < 10) {
            errorDetails.push(`시트 ${retryId.substring(0, 15)}... (${campaigns.join(', ') || '미분류'}): Quota 초과 (시간 초과로 재시도 스킵)`);
          }
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[sync-tab-names] 완료: renamed=${renamed}, urlFixed=${urlFixed}, gidFilled=${gidFilled}, skipped=${skipped}, errors=${errors}, ${elapsed}s`);

    res.json({
      ok: true,
      dryRun: !!dryRun,
      totalSheets: sheetIds.length,
      totalTabs: allTabs.length,
      renamed,
      urlFixed,
      gidFilled,
      skipped,
      errors,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      elapsed: `${elapsed}s`,
      results: results.filter(r => r.status !== undefined), // 변경 있는 것만
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/tab/fix-campaign-tab-swap — 캠페인명/탭명 뒤바뀜 교정
// 특정 시트(또는 전체)의 tab_configs를 구글시트 메타데이터와 비교하여
// campaign_name ↔ tab_name이 뒤바뀐 행을 감지하고 교정
// 동시에 tab_gid가 null인 행에 대해 gid를 보충
// ═══════════════════════════════════════════════════════════
router.post('/fix-campaign-tab-swap', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, dryRun = true } = req.body || {};
    const startTime = Date.now();

    // 1. 대상 탭 조회 (sheetId 지정 시 해당 시트만, 없으면 전체)
    let query = `
      SELECT tc.sheet_id, tc.tab_name, tc.campaign_name, tc.sheet_url, tc.tab_gid,
             im.tab_gid AS im_tab_gid
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
    `;
    const params = [];
    if (sheetId) {
      query += ' WHERE tc.sheet_id = $1';
      params.push(sheetId);
    }
    query += ' ORDER BY tc.sheet_id, tc.tab_name';

    const { rows: allTabs } = await pool.query(query, params);

    // 2. 시트별 그룹핑
    const sheetMap = {};
    allTabs.forEach(t => {
      if (!sheetMap[t.sheet_id]) sheetMap[t.sheet_id] = [];
      sheetMap[t.sheet_id].push(t);
    });

    const sheetIds = Object.keys(sheetMap);
    logger.info(`[fix-swap] 대상: ${sheetIds.length}개 시트, ${allTabs.length}개 탭 (dryRun=${dryRun})`);

    const fixes = [];
    let fixed = 0, gidFilled = 0, skipped = 0, errors = 0;
    const errorDetails = [];

    // 3. 각 시트별 메타데이터 조회 및 교정
    for (const sid of sheetIds) {
      let meta;
      try {
        meta = await throttledCall(() => getSpreadsheetMeta(sid));
      } catch (err) {
        errors++;
        if (errorDetails.length < 10) {
          errorDetails.push(`시트 ${sid.substring(0, 15)}...: ${err.message}`);
        }
        continue;
      }

      if (!meta || meta.length === 0) { skipped++; continue; }

      // 실제 시트 탭 정보
      const realTabs = {};  // tabName → { gid, title }
      const spreadsheetTitle = meta._spreadsheetTitle || '';
      meta.forEach(s => {
        const title = s.properties.title;
        const gid = String(s.properties.sheetId);
        realTabs[title] = { gid, title };
      });

      const dbTabs = sheetMap[sid];
      const correctSheetUrl = `https://docs.google.com/spreadsheets/d/${sid}/edit`;

      for (const dbTab of dbTabs) {
        const dbTabName = dbTab.tab_name;
        const dbCampaignName = dbTab.campaign_name || '';

        // ─── 교정 로직 ───
        // 상황: DB의 tab_name이 시트에 실제 탭으로 존재하지 않지만,
        //       DB의 campaign_name이 시트에 실제 탭으로 존재하는 경우
        //       → campaign_name과 tab_name이 뒤바뀐 것
        const tabExistsInSheet = !!realTabs[dbTabName];
        const campaignExistsAsTab = !!realTabs[dbCampaignName];

        if (!tabExistsInSheet && campaignExistsAsTab) {
          // ★ 뒤바뀜 감지: campaign_name이 실제 탭명이고, tab_name은 캠페인명
          const realTab = realTabs[dbCampaignName];
          const newTabName = dbCampaignName;  // 실제 탭명
          const newCampaignName = spreadsheetTitle || dbTabName;  // 시트 제목 또는 기존 tab_name(=캠페인명)
          const newGid = realTab.gid;

          const fix = {
            sheetId: sid.substring(0, 15) + '...',
            fullSheetId: sid,
            type: 'swap',
            oldTabName: dbTabName,
            oldCampaignName: dbCampaignName,
            newTabName,
            newCampaignName,
            newGid,
            spreadsheetTitle,
          };

          if (!dryRun) {
            try {
              // tab_configs: 기존 행 삭제 후 새 행 INSERT (PK가 sheet_id+tab_name이므로)
              await pool.query(
                'DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2',
                [sid, dbTabName]
              );
              await pool.query(
                `INSERT INTO tab_configs (sheet_id, tab_name, campaign_name, sheet_url, tab_gid, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
                   campaign_name = $3, sheet_url = $4, tab_gid = $5, updated_at = NOW()`,
                [sid, newTabName, newCampaignName, correctSheetUrl, newGid]
              );
              // index_master 교정
              await pool.query(
                'DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
                [sid, dbTabName]
              );
              await pool.query(
                `INSERT INTO index_master (sheet_id, tab_name, tab_gid, campaign_name, row_count, submitted_count, status, built_at)
                 VALUES ($1, $2, $3, $4, 0, 0, 'active', NOW())
                 ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
                   tab_gid = $3, campaign_name = $4, status = 'active', built_at = NOW()`,
                [sid, newTabName, newGid, newCampaignName]
              );
              // review_index 교정
              await pool.query(
                'UPDATE review_index SET tab_name = $1, tab_gid = $2 WHERE sheet_id = $3 AND tab_name = $4',
                [newTabName, newGid, sid, dbTabName]
              );
              fix.status = 'fixed';
              fixed++;
              logger.info(`[fix-swap] 교정: "${dbTabName}" → tab="${newTabName}", campaign="${newCampaignName}", gid=${newGid}`);
            } catch (updateErr) {
              fix.status = 'error';
              fix.error = updateErr.message;
              errors++;
            }
          } else {
            fix.status = 'dry_run';
          }

          fixes.push(fix);
        } else if (tabExistsInSheet) {
          // 탭명은 맞지만 tab_gid가 없는 경우 → GID만 보충
          const currentGid = dbTab.tab_gid || dbTab.im_tab_gid;
          const realGid = realTabs[dbTabName].gid;

          if (!currentGid && realGid) {
            const gidFix = {
              sheetId: sid.substring(0, 15) + '...',
              fullSheetId: sid,
              type: 'gid_fill',
              tabName: dbTabName,
              gid: realGid,
            };

            if (!dryRun) {
              try {
                await pool.query(
                  'UPDATE tab_configs SET tab_gid = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
                  [realGid, sid, dbTabName]
                );
                await pool.query(
                  'UPDATE index_master SET tab_gid = $1 WHERE sheet_id = $2 AND tab_name = $3 AND (tab_gid IS NULL OR tab_gid = \'\')',
                  [realGid, sid, dbTabName]
                );
                gidFix.status = 'filled';
                gidFilled++;
              } catch (gErr) {
                gidFix.status = 'error';
                gidFix.error = gErr.message;
                errors++;
              }
            } else {
              gidFix.status = 'dry_run';
            }

            fixes.push(gidFix);
          } else {
            // campaign_name도 확인 - 시트 제목과 다르면 교정
            if (spreadsheetTitle && dbCampaignName && dbCampaignName !== spreadsheetTitle) {
              // campaign_name이 다른 탭명과 같으면 스왑 의심
              const campIsAnotherTab = !!realTabs[dbCampaignName] && dbCampaignName !== dbTabName;
              if (campIsAnotherTab) {
                const campFix = {
                  sheetId: sid.substring(0, 15) + '...',
                  fullSheetId: sid,
                  type: 'campaign_fix',
                  tabName: dbTabName,
                  oldCampaignName: dbCampaignName,
                  newCampaignName: spreadsheetTitle,
                  gid: realTabs[dbTabName].gid,
                };

                if (!dryRun) {
                  try {
                    const gid = realTabs[dbTabName].gid;
                    await pool.query(
                      'UPDATE tab_configs SET campaign_name = $1, tab_gid = COALESCE(NULLIF(tab_gid, \'\'), $2), updated_at = NOW() WHERE sheet_id = $3 AND tab_name = $4',
                      [spreadsheetTitle, gid, sid, dbTabName]
                    );
                    await pool.query(
                      'UPDATE index_master SET campaign_name = $1, tab_gid = COALESCE(NULLIF(tab_gid, \'\'), $2) WHERE sheet_id = $3 AND tab_name = $4',
                      [spreadsheetTitle, gid, sid, dbTabName]
                    );
                    campFix.status = 'fixed';
                    fixed++;
                  } catch (cErr) {
                    campFix.status = 'error';
                    campFix.error = cErr.message;
                    errors++;
                  }
                } else {
                  campFix.status = 'dry_run';
                }

                fixes.push(campFix);
              } else {
                skipped++;
              }
            } else {
              skipped++;
            }
          }
        } else {
          // tab_name이 시트에도 없고 campaign_name도 시트 탭이 아님
          // → 시트에서 삭제되었거나 다른 문제
          skipped++;
        }
      }

      // API quota 보호: 배치 간 1초 대기
      await new Promise(r => setTimeout(r, 1000));
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[fix-swap] 완료: fixed=${fixed}, gidFilled=${gidFilled}, skipped=${skipped}, errors=${errors}, ${elapsed}s`);

    res.json({
      ok: true,
      dryRun: !!dryRun,
      totalSheets: sheetIds.length,
      totalTabs: allTabs.length,
      fixed,
      gidFilled,
      skipped,
      errors,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      elapsed: `${elapsed}s`,
      fixes: fixes.slice(0, 100),  // 최대 100개까지만 응답
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/tab/clean-closed — 마감 탭 정리 (아카이브로 이동)
// is_closed=TRUE인 탭의 review_index + index_master 데이터를
// 아카이브 테이블로 이동한 뒤 원본에서 삭제, tab_configs도 삭제
// ═══════════════════════════════════════════════════════════
router.post('/clean-closed', authMiddleware, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const startTime = Date.now();
    const adminName = req.admin?.name || 'system';

    // is_closed=TRUE인 탭 목록 조회
    const { rows: closedTabs } = await client.query(
      `SELECT tc.sheet_id, tc.tab_name, tc.tab_gid, tc.campaign_name
       FROM tab_configs tc
       WHERE tc.is_closed = TRUE`
    );

    if (closedTabs.length === 0) {
      client.release();
      return res.json({ ok: true, message: '마감된 탭이 없습니다.', cleaned: 0 });
    }

    await client.query('BEGIN');

    let archivedTabs = 0, archivedRows = 0;
    let reviewArchived = 0, masterArchived = 0;
    const results = [];

    for (const tab of closedTabs) {
      try {
        // 1. index_master 확인
        const { rows: masterRows } = await client.query(
          'SELECT * FROM index_master WHERE sheet_id = $1 AND tab_name = $2',
          [tab.sheet_id, tab.tab_name]
        );

        if (masterRows.length > 0) {
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
            adminName, 'clean-closed',
          ]);
          masterArchived++;

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
          `, [tab.sheet_id, tab.tab_name]);
          reviewArchived += reviewCount;

          // 4. 원본 삭제
          await client.query('DELETE FROM review_index WHERE sheet_id = $1 AND tab_name = $2', [tab.sheet_id, tab.tab_name]);
          await client.query('DELETE FROM index_master WHERE sheet_id = $1 AND tab_name = $2', [tab.sheet_id, tab.tab_name]);

          archivedRows += reviewCount;
        } else {
          // index_master에 없는 경우: tab_configs 설정만 아카이브 기록
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
          `, [tab.sheet_id, tab.tab_name, tab.tab_gid || null, tab.campaign_name || '미분류', adminName, 'clean-closed']);
          masterArchived++;
        }

        // 5. tab_configs 삭제 (아카이브 완료 후)
        await client.query('DELETE FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2', [tab.sheet_id, tab.tab_name]);

        archivedTabs++;
        results.push({ sheetId: tab.sheet_id, tabName: tab.tab_name, status: 'archived' });
      } catch (tabErr) {
        logger.error(`[clean-closed] 탭 아카이브 실패: ${tab.sheet_id}/${tab.tab_name} — ${tabErr.message}`);
        results.push({ sheetId: tab.sheet_id, tabName: tab.tab_name, status: 'error', error: tabErr.message });
      }
    }

    // 6. 아카이브 이력 기록
    if (archivedTabs > 0) {
      await client.query(`
        INSERT INTO archive_history (action, sheet_id, campaign_name, tab_count, row_count, performed_by, note)
        VALUES ('archive', 'clean-closed', '마감탭 일괄 아카이브', $1, $2, $3, $4)
      `, [archivedTabs, archivedRows, adminName, `마감탭 정리: ${archivedTabs}개 탭, ${archivedRows}개 행 아카이브`]);
    }

    await client.query('COMMIT');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[clean-closed] 마감 탭 아카이브: ${archivedTabs}개 탭, review_index ${reviewArchived}행 이동, index_master ${masterArchived}행 이동, ${elapsed}s`);

    res.json({
      ok: true,
      closedTabs: archivedTabs,
      reviewArchived,
      masterArchived,
      archivedRows,
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
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
        COALESCE(tc.tab_gid, im.tab_gid) AS tab_gid,
        tc.manager, tc.time_range, tc.taekhap, tc.review_type,
        tc.payment_type, tc.display_name, tc.is_closed,
        tc.folder_url, tc.capture_folder_url, tc.is_bulk, tc.delivery_type,
        tc.round, tc.nc_mode, tc.deposit_name, tc.transfer_bank,
        tc.income_type, tc.updated_at, tc.closed_rounds,
        im.row_count, im.submitted_count, im.status AS index_status,
        im.built_at AS index_built_at, im.checksum
      FROM tab_configs tc
      LEFT JOIN index_master im ON tc.sheet_id = im.sheet_id AND tc.tab_name = im.tab_name
      ORDER BY tc.campaign_name NULLS LAST, tc.tab_name
    `);

    // ★ 차수별 집계: review_index에서 round 값이 있는 행을 탭별로 그룹핑
    const { rows: roundRows } = await pool.query(`
      SELECT ri.sheet_id, ri.tab_name, ri.round,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE ri.is_submitted) AS submitted
      FROM review_index ri
      INNER JOIN index_master im ON ri.sheet_id = im.sheet_id AND ri.tab_name = im.tab_name AND im.status = 'active'
      WHERE ri.round IS NOT NULL AND ri.round != ''
      GROUP BY ri.sheet_id, ri.tab_name, ri.round
      ORDER BY ri.sheet_id, ri.tab_name, ri.round
    `);

    // 탭별 roundList 맵 구성
    const roundMap = {}; // "sheet_id||tab_name" → [{ round, total, submitted }]
    for (const rr of roundRows) {
      const key = `${rr.sheet_id}||${rr.tab_name}`;
      if (!roundMap[key]) roundMap[key] = [];
      roundMap[key].push({
        round: rr.round,
        total: parseInt(rr.total) || 0,
        submitted: parseInt(rr.submitted) || 0,
      });
    }
    // roundList 숫자순 정렬
    for (const key of Object.keys(roundMap)) {
      roundMap[key].sort((a, b) => {
        const numA = parseInt(a.round.replace(/[^0-9]/g, '')) || 0;
        const numB = parseInt(b.round.replace(/[^0-9]/g, '')) || 0;
        return numA - numB;
      });
    }

    // 각 탭에 roundList 추가
    const tabsWithRounds = rows.map(r => {
      const key = `${r.sheet_id}||${r.tab_name}`;
      return {
        ...r,
        roundList: roundMap[key] || [],
      };
    });

    // 통계 계산
    const stats = {
      total: rows.length,
      active: rows.filter(r => !r.is_closed).length,
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
      if (!campaigns[camp]) campaigns[camp] = { tabs: 0, active: 0, closed: 0 };
      campaigns[camp].tabs++;
      if (r.is_closed) campaigns[camp].closed++;
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
      tabs: tabsWithRounds,
    });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/scan-master — [DEPRECATED v11.8.0] 2탭 통합으로 폐기
// → 인덱스 스캔(/api/tab/index-scan)을 사용하세요
// ══════════════════════════════════════════════════════════════
router.post('/scan-master', authMiddleware, async (req, res) => {
  res.json({
    ok: false,
    deprecated: true,
    message: '[v11.8.0] scan-master는 폐기되었습니다. /api/tab/index-scan을 사용하세요.',
    redirect: '/api/tab/index-scan',
  });
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/sync-master — [DEPRECATED v11.8.0] 2탭 통합으로 폐기
// → DB 동기화는 /api/tab/index-scan-sync 를 사용하세요
// ══════════════════════════════════════════════════════════════
router.post('/sync-master', authMiddleware, async (req, res) => {
  res.json({
    ok: false,
    deprecated: true,
    message: '[v11.8.0] sync-master는 폐기되었습니다. /api/tab/index-scan-sync를 사용하세요.',
    redirect: '/api/tab/index-scan-sync',
  });
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/full-sync — [DEPRECATED v11.8.0] 2탭 통합으로 폐기
// → 인덱스 스캔(/api/tab/index-scan) + DB 동기화(/api/tab/index-scan-sync) 사용
// ══════════════════════════════════════════════════════════════
router.post('/full-sync', authMiddleware, async (req, res) => {
  res.json({
    ok: false,
    deprecated: true,
    message: '[v11.8.0] full-sync는 폐기되었습니다. /api/tab/index-scan → /api/tab/index-scan-sync 를 순서대로 사용하세요.',
    redirect: '/api/tab/index-scan',
  });
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/sync-settings — [DEPRECATED v11.8.0] 2탭 통합으로 폐기
// DB가 설정 원본이므로 시트→DB 설정 동기화가 불필요합니다.
// 설정은 웹 UI(POST /api/tab/config)에서 직접 DB에 저장됩니다.
// ══════════════════════════════════════════════════════════════
router.post('/sync-settings', authMiddleware, async (req, res) => {
  res.json({
    ok: false,
    deprecated: true,
    message: '[v11.8.0] sync-settings는 폐기되었습니다. DB가 설정 원본이므로 시트→DB 설정 동기화가 불필요합니다. 웹 UI에서 직접 설정하세요.',
  });
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/index-scan — ★ 인덱스 스캔: 시트DB → 각 시트 파싱 → 탭목록 쓰기
// 미리보기: 시트 스캔 → 결과 캐시 저장 (5분 유효)
// 실행:     캐시가 있으면 재스캔 없이 바로 적용, 없으면 새로 스캔
// ══════════════════════════════════════════════════════════════
router.post('/index-scan', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun = true } = req.body;
    logger.info(`[index-scan] ${dryRun ? '미리보기' : '실행'} 요청 — by ${req.admin?.name || 'unknown'}`);

    if (dryRun) {
      // ── 미리보기: 시트 스캔 + 결과 캐시 ──
      const result = await runIndexScan(true);
      return res.json({
        ok: true, dryRun: true, ...result,
        message: `미리보기: ${result.totalTabs}개 탭 (${result.sheetsScanned}개 시트 스캔, 오류 ${result.errors}건)`,
      });
    }

    // ── 실행: 캐시 있으면 재스캔 없이 바로 적용 ──
    if (hasIndexScanCache()) {
      logger.info('[index-scan] ★ 캐시된 스캔 결과로 바로 적용 (재스캔 생략)');
      const result = await applyCachedIndexScan();
      return res.json({
        ok: true, dryRun: false, ...result,
        message: `완료(캐시): ${result.totalTabs}개 탭 → 탭목록 기록 완료`,
      });
    }

    // ── 캐시 없음: 새로 스캔 + 즉시 적용 ──
    logger.info('[index-scan] 캐시 없음 — 새로 스캔 후 적용');
    const result = await runIndexScan(false);
    res.json({
      ok: true, dryRun: false, ...result,
      message: `완료: ${result.totalTabs}개 탭 → 탭목록 기록 완료 (${result.elapsed})`,
    });
  } catch (err) {
    logger.error(`[index-scan] 오류: ${err.message}`);
    res.status(500).json({ error: err.message, stack: process.env.NODE_ENV === 'development' ? err.stack : undefined });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/index-scan-sync — ★ 탭목록 → DB 직접 동기화
// 인덱스 스캔 결과(탭목록 시트 or 캐시)를 DB에 반영
// campaigns, tab_configs, index_master에 UPSERT
// ══════════════════════════════════════════════════════════════
router.post('/index-scan-sync', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun = true, fromCache = false } = req.body;
    logger.info(`[index-scan-sync] ${dryRun ? '미리보기' : '실행'} 요청 (source: ${fromCache ? '캐시' : '탭목록 시트'}) — by ${req.admin?.name || 'unknown'}`);

    const result = await syncTabListToDB({ dryRun: !!dryRun, fromCache: !!fromCache });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error(`[index-scan-sync] 오류: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/tab/reset-all — 선택적 DB 초기화
// targets 배열로 초기화할 그룹을 선택
// ⚠ 사용자/관리자/설정/메모 등은 유지
// ══════════════════════════════════════════════════════════════
router.post('/reset-all', authMiddleware, async (req, res, next) => {
  try {
    const { confirm, targets } = req.body;
    if (confirm !== 'RESET_ALL_DATA') {
      return res.status(400).json({ error: '확인 코드가 올바르지 않습니다. confirm: "RESET_ALL_DATA" 필요' });
    }

    // 허용 그룹 정의
    const TARGET_GROUPS = {
      dashboard:    ['review_index', 'index_master', 'tab_configs', 'campaigns'],
      archive:      ['review_index_archive', 'index_master_archive', 'archive_history'],
      unrecognized: ['unrecognized_tabs'],
    };

    // targets가 없거나 빈 배열이면 전체 초기화
    const selectedTargets = (Array.isArray(targets) && targets.length > 0)
      ? targets
      : Object.keys(TARGET_GROUPS);

    // 유효하지 않은 target 필터링
    const validTargets = selectedTargets.filter(t => TARGET_GROUPS[t]);
    if (validTargets.length === 0) {
      return res.status(400).json({ error: '유효한 초기화 대상이 없습니다. targets: ["dashboard", "archive", "unrecognized"]' });
    }

    // 삭제할 테이블 목록 결합
    const tablesToDelete = [];
    validTargets.forEach(t => tablesToDelete.push(...TARGET_GROUPS[t]));

    logger.warn(`[reset-all] ⚠ 선택적 초기화 요청 — targets: [${validTargets.join(', ')}], tables: [${tablesToDelete.join(', ')}] — by ${req.admin?.name || 'unknown'}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const deleted = {};
      for (const table of tablesToDelete) {
        const r = await client.query(`DELETE FROM ${table}`);
        deleted[table] = r.rowCount;
      }

      await client.query('COMMIT');

      const logParts = Object.entries(deleted).map(([k, v]) => `${k}=${v}`).join(', ');
      logger.warn(`[reset-all] ✅ 초기화 완료: ${logParts}`);

      res.json({ ok: true, targets: validTargets, deleted });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`[reset-all] 오류: ${err.message}`);
    next(err);
  }
});

module.exports = router;
