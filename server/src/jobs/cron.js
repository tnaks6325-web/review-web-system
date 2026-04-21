const cron = require('node-cron');
const { buildIndexSmart, checkDirtySheets } = require('../services/indexBuilder.service');
const { processQueue, purgeCompleted } = require('../services/syncQueue.service');
const { logger } = require('../utils/logger');
const { emitIndexBuild, broadcast } = require('../utils/sse');
const { readSheet } = require('../services/sheets.service');
const pool = require('../db/pool');

/**
 * GAS autoRebuildIndex 트리거 대체
 * 평일+토요일 9~19시 매 정시 실행
 */
function startCronJobs() {
  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9-19 * * 1-6';

  // ── 인덱스 빌드: 매 정시 ──
  cron.schedule(schedule, async () => {
    logger.info(`[CRON] 인덱스 빌드 시작: ${new Date().toISOString()}`);
    try {
      const result = await buildIndexSmart(false);
      logger.info(`[CRON] 인덱스 빌드 완료: rebuilt=${result.rebuilt}, skipped=${result.skipped}, ${result.elapsed}`);
      emitIndexBuild({ rebuilt: result.rebuilt || 0, skipped: result.skipped || 0, errors: result.errors || 0, elapsed: result.elapsed || '', trigger: 'cron' });
    } catch (err) {
      logger.error(`[CRON] 인덱스 빌드 오류: ${err.message}`);
    }
  }, {
    timezone: 'Asia/Seoul',
  });

  // ── 전체 재빌드: 6시간마다 ──
  cron.schedule('0 */4 * * *', async () => {
    logger.info('[CRON] 전체 재빌드 시작');
    try {
      await buildIndexSmart(true);
      logger.info('[CRON] 전체 재빌드 완료');
      emitIndexBuild({ trigger: 'cron_full' });
    } catch (err) {
      logger.error(`[CRON] 전체 재빌드 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── Phase 4: Dirty Check — 5분마다 변경 감지 (빌드 없이 Drive API만) ──
  cron.schedule('*/5 9-19 * * 1-6', async () => {
    try {
      const dirtySheets = await checkDirtySheets();
      if (dirtySheets.length > 0) {
        logger.info(`[CRON-Dirty] 변경 감지: ${dirtySheets.length}개 시트 — ${dirtySheets.map(s => s.campaignName).join(', ')}`);
        broadcast('dirty_detected', {
          message: `${dirtySheets.length}개 시트에 변경사항 감지`,
          dirtyCount: dirtySheets.length,
          dirtySheets,
        });
      }
    } catch (err) {
      logger.warn(`[CRON-Dirty] 변경 감지 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── Phase 2: Sync Queue 워커 — 30초마다 pending 작업 처리 ──
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const result = await processQueue(10);
      if (result.processed > 0) {
        logger.info(`[CRON-Queue] 처리: ${result.succeeded}/${result.processed} 성공, ${result.failed} 실패, ${result.elapsed}ms`);
      }
    } catch (err) {
      logger.error(`[CRON-Queue] 큐 처리 오류: ${err.message}`);
    }
  });

  // ── 완료된 큐 항목 정리: 매일 새벽 3시 (24시간 이상 경과) ──
  cron.schedule('0 3 * * *', async () => {
    try {
      const result = await purgeCompleted(24);
      logger.info(`[CRON-Queue] 정리: ${result.purged}건 완료 항목 삭제`);
    } catch (err) {
      logger.error(`[CRON-Queue] 정리 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 세부목록 → DB 자동 동기화: 매일 08:30 ──
  cron.schedule('30 8 * * 1-6', async () => {
    logger.info('[CRON] 세부목록 → DB 자동 동기화 시작');
    try {
      const baseSheetId = process.env.BASE_SHEET_ID;
      if (!baseSheetId) { logger.warn('[CRON-Sync] BASE_SHEET_ID 미설정'); return; }

      const values = await readSheet(baseSheetId, '세부목록');
      if (!values || values.length < 2) { logger.warn('[CRON-Sync] 세부목록 데이터 없음'); return; }

      const rawHeaders = values[0].map(h => String(h || '').trim().toLowerCase().replace(/^[a-z][\.:]\s*/i, ''));
      const colMap = {
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

      if (colMap.sheet_url < 0 || colMap.tab_name < 0) {
        logger.warn('[CRON-Sync] 필수 헤더 누락');
        return;
      }

      const _val = (row, idx) => idx >= 0 && idx < row.length ? String(row[idx] || '').trim() : '';
      const _bool = (row, idx) => { const v = _val(row, idx).toUpperCase(); return v === 'TRUE' || v === '1' || v === 'O'; };
      const extractSid = (url) => { const m = String(url||'').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : null; };

      let synced = 0, skipped = 0;
      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        const sheetId = extractSid(_val(row, colMap.sheet_url));
        const tabName = _val(row, colMap.tab_name);
        if (!sheetId || !tabName) { skipped++; continue; }

        try {
          await pool.query(`
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
              taekhap = EXCLUDED.taekhap, review_type = COALESCE(NULLIF(EXCLUDED.review_type,''), tab_configs.review_type),
              payment_type = COALESCE(NULLIF(EXCLUDED.payment_type,''), tab_configs.payment_type),
              display_name = COALESCE(NULLIF(EXCLUDED.display_name,''), tab_configs.display_name),
              force_done = EXCLUDED.force_done, is_closed = EXCLUDED.is_closed,
              folder_url = COALESCE(NULLIF(EXCLUDED.folder_url,''), tab_configs.folder_url),
              capture_folder_url = COALESCE(NULLIF(EXCLUDED.capture_folder_url,''), tab_configs.capture_folder_url),
              is_bulk = EXCLUDED.is_bulk, delivery_type = COALESCE(NULLIF(EXCLUDED.delivery_type,''), tab_configs.delivery_type),
              round = COALESCE(NULLIF(EXCLUDED.round,''), tab_configs.round),
              nc_mode = EXCLUDED.nc_mode, deposit_name = COALESCE(NULLIF(EXCLUDED.deposit_name,''), tab_configs.deposit_name),
              transfer_bank = COALESCE(NULLIF(EXCLUDED.transfer_bank,''), tab_configs.transfer_bank),
              income_type = COALESCE(NULLIF(EXCLUDED.income_type,''), tab_configs.income_type),
              updated_at = NOW()
          `, [
            sheetId, tabName, _val(row, colMap.sheet_url), _val(row, colMap.campaign_name),
            _val(row, colMap.manager), _val(row, colMap.time_range), _bool(row, colMap.taekhap),
            _val(row, colMap.review_type), _val(row, colMap.payment_type), _val(row, colMap.display_name),
            _bool(row, colMap.force_done), _bool(row, colMap.is_closed), _val(row, colMap.folder_url),
            _val(row, colMap.capture_folder_url), _bool(row, colMap.is_bulk), _val(row, colMap.delivery_type),
            _val(row, colMap.round), _bool(row, colMap.nc_mode), _val(row, colMap.deposit_name),
            _val(row, colMap.transfer_bank), _val(row, colMap.income_type),
          ]);
          synced++;
        } catch (_) { /* skip individual errors */ }
      }

      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('last_tab_sync', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
        [new Date().toISOString()]
      );

      logger.info(`[CRON-Sync] 세부목록 동기화 완료: ${synced}건 처리, ${skipped}건 스킵`);
      broadcast('tab_sync', { message: `세부목록 동기화 완료 (${synced}건)`, synced, skipped });
    } catch (err) {
      logger.error(`[CRON-Sync] 세부목록 동기화 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  logger.info(`[CRON] 스케줄러 등록 완료: 인덱스=${schedule}, 전체재빌드=4h, dirty=5분, 큐워커=30초, 정리=매일03시, 세부목록동기화=08:30`);
}

module.exports = { startCronJobs };
