const cron = require('node-cron');
const { buildIndexSmart, checkDirtySheets, buildOneSheet } = require('../services/indexBuilder.service');
const { processQueue, purgeCompleted } = require('../services/syncQueue.service');
const { syncSettingsOnly } = require('../services/masterSheet.service');
const { logger } = require('../utils/logger');
const { emitIndexBuild, broadcast } = require('../utils/sse');
// [REMOVED] readSheet, pool — 세부목록→DB 자동동기화 CRON 제거됨 (DB가 원본)

/**
 * ★ CRON 최적화 (v10.3):
 *   1. 설정 동기화(Group B): 10분마다 — API 1~2회, 1~3초
 *   2. Dirty Check + 자동 빌드: 15분마다 → 변경 시트 자동 개별 빌드
 *      (기존: 감지만 하고 알림 → 개선: 감지 + 해당 시트만 자동 빌드)
 *   3. 인덱스 전체 빌드: 하루 2회 (09시, 15시) — 대폭 축소
 *   4. 전체 재빌드: 하루 1회 새벽 4시
 *
 * ★ 핵심 개선:
 *   - Dirty Check가 변경 감지 시 buildOneSheet()로 해당 시트만 즉시 빌드
 *   - 2시간마다 전체 빌드 → 하루 2회로 축소 (Dirty 자동빌드가 대체)
 *   - API 쿼터 절감: 전체 빌드 감소 + 변경 시트만 선택적 빌드
 */
function startCronJobs() {
  // ── Group B: 마스터시트 설정 동기화 — 10분마다 (API 1~2회) ──
  cron.schedule('*/10 9-19 * * 1-6', async () => {
    try {
      const result = await syncSettingsOnly(false); // dryRun=false
      if (result.updated > 0) {
        logger.info(`[CRON-Settings] 설정 동기화: ${result.updated}건 업데이트 (${result.elapsed})`);
        broadcast('settings_synced', {
          message: `설정 ${result.updated}건 동기화 완료`,
          updated: result.updated,
          elapsed: result.elapsed,
        });
      }
    } catch (err) {
      // MASTER_SHEET_ID 미설정 등 → 경고만 (빌드 중단 아님)
      logger.warn(`[CRON-Settings] 설정 동기화 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── ★ Dirty Check + 자동 빌드: 15분마다 ──
  // 기존: 감지만 하고 SSE 알림 → 사용자가 수동 빌드
  // 개선: 변경 감지된 시트를 자동으로 개별 빌드 (buildOneSheet)
  cron.schedule('*/15 9-19 * * 1-6', async () => {
    try {
      const dirtySheets = await checkDirtySheets();
      if (dirtySheets.length === 0) return;

      logger.info(`[CRON-Dirty] 변경 감지: ${dirtySheets.length}개 시트 — ${dirtySheets.map(s => s.campaignName).join(', ')}`);
      broadcast('dirty_detected', {
        message: `${dirtySheets.length}개 시트에 변경사항 감지 → 자동 갱신 시작`,
        dirtyCount: dirtySheets.length,
        dirtySheets,
      });

      // ★ 변경된 시트만 순차적으로 개별 빌드
      // (buildOneSheet는 내부적으로 빌드 잠금을 사용하므로 동시 실행 안전)
      let builtCount = 0, failCount = 0;
      for (const dirty of dirtySheets) {
        try {
          const result = await buildOneSheet(dirty.sheetId);
          if (result.ok) {
            builtCount++;
            logger.info(`[CRON-Dirty] 자동 빌드 완료: ${dirty.campaignName} (rebuilt=${result.rebuilt}, ${result.elapsed})`);
          } else {
            // 잠금 충돌 등 → 다음 Dirty Check에서 재시도
            logger.warn(`[CRON-Dirty] 자동 빌드 스킵: ${dirty.campaignName} — ${result.error || 'locked'}`);
            break; // 잠금 충돌이면 나머지도 실패할 가능성 → 중단
          }
        } catch (err) {
          failCount++;
          logger.error(`[CRON-Dirty] 자동 빌드 실패: ${dirty.campaignName} — ${err.message}`);
        }
      }

      if (builtCount > 0) {
        emitIndexBuild({
          rebuilt: builtCount,
          skipped: 0,
          errors: failCount,
          trigger: 'dirty_auto',
          message: `Dirty 자동 빌드: ${builtCount}개 시트 갱신`,
        });
        broadcast('dirty_auto_built', {
          message: `${builtCount}개 변경 시트 자동 갱신 완료`,
          builtCount,
          failCount,
        });
      }
    } catch (err) {
      logger.warn(`[CRON-Dirty] 변경 감지 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 인덱스 전체 빌드: 하루 2회 (09시, 15시) — 기존 2시간마다에서 축소 ──
  // Dirty 자동빌드가 15분마다 변경 시트를 처리하므로 전체 빌드 빈도 대폭 축소
  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9,15 * * 1-6';
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

  // ── 전체 재빌드: 하루 1회 새벽 4시 ──
  cron.schedule('0 4 * * *', async () => {
    logger.info('[CRON] 전체 재빌드 시작 (일일 1회)');
    try {
      await buildIndexSmart(true);
      logger.info('[CRON] 전체 재빌드 완료');
      emitIndexBuild({ trigger: 'cron_full' });
    } catch (err) {
      logger.error(`[CRON] 전체 재빌드 오류: ${err.message}`);
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

  logger.info(`[CRON] 스케줄러 등록 완료: 설정동기화=10분, dirty+자동빌드=15분, 인덱스=${schedule}, 전체재빌드=매일04시, 큐워커=30초, 정리=매일03시`);
}

module.exports = { startCronJobs };
