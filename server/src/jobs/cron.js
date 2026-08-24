const cron = require('node-cron');
const { buildIndexSmart, checkDirtySheets, buildOneSheet } = require('../services/indexBuilder.service');
const { processQueue, purgeCompleted, retryAllFailed } = require('../services/syncQueue.service');
const { mirrorAllSheets } = require('../services/rawMirror.service');
const { getThrottleStatus } = require('../utils/sheetsThrottle');
// [DEPRECATED — v11.8.0] syncSettingsOnly 제거: DB가 설정 원본이므로 시트→DB 동기화 불필요
// const { syncSettingsOnly } = require('../services/masterSheet.service');
const { logger } = require('../utils/logger');
const { emitIndexBuild, broadcast } = require('../utils/sse');
const { logAbnormal } = require('../services/errorLog.service');
const pool = require('../db/pool');
let rawMirrorRunning = false;
let reconcileRunning = false;
// [REMOVED] readSheet — 세부목록→DB 자동동기화 CRON 제거됨 (DB가 원본)

/**
 * ★ CRON 최적화 (v11.8.0 — 2탭 통합):
 *   1. [REMOVED] 설정 동기화(Group B) — DB가 설정 원본이므로 시트→DB 동기화 불필요
 *   2. Dirty Check + 자동 빌드: 15분마다 → 변경 시트 자동 개별 빌드
 *   3. 인덱스 전체 빌드: 하루 2회 (09시, 15시)
 *   4. 전체 재빌드: 하루 1회 새벽 4시
 */
function startCronJobs() {
  // [DEPRECATED — v11.8.0] Group B 설정 동기화 CRON 제거
  // DB가 설정 원본이므로 시트→DB 설정 동기화가 불필요합니다.
  // 설정은 웹 UI(POST /api/tab/config)에서 직접 DB에 저장됩니다.

  // ── ★ Dirty Check + 자동 빌드: 15분마다 ──
  //   #2 일원화: smartBuild(5분, 더 완전·더 근실시간)가 같은 review_index를 이미 변경감지·갱신하므로
  //   이 dirty-check(15분)는 중복 폴러다. 기본 OFF로 두어 smartBuild를 단일 폴러화(getSheetModifiedTime 폴링 감축).
  //   INDEX_DIRTY_CRON_ENABLED=true 로 즉시 원복 가능(롤백가능). 전체빌드(09/15/04)는 drift 백스톱으로 유지.
  if (process.env.INDEX_DIRTY_CRON_ENABLED === 'true') {
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
      let builtCount = 0, failCount = 0;
      for (const dirty of dirtySheets) {
        try {
          const result = await buildOneSheet(dirty.sheetId);
          if (result.ok) {
            builtCount++;
            logger.info(`[CRON-Dirty] 자동 빌드 완료: ${dirty.campaignName} (rebuilt=${result.rebuilt}, ${result.elapsed})`);
          } else {
            logger.warn(`[CRON-Dirty] 자동 빌드 스킵: ${dirty.campaignName} — ${result.error || 'locked'}`);
            break;
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
  } else {
    logger.info('[CRON] dirty-check(15분) 비활성 — smartBuild 단일 폴러(#2 일원화). INDEX_DIRTY_CRON_ENABLED=true로 원복.');
  }

  // ── 인덱스 전체 빌드: 하루 2회 (09시, 15시) ──
  // RAW mirror dirty check: keep DB source data close to manually edited Sheets.
  if (process.env.RAW_MIRROR_CRON_ENABLED !== 'false') {
    const rawMirrorSchedule = process.env.RAW_MIRROR_CRON_SCHEDULE || '*/5 * * * *';
    const bootGraceSec = (n => (Number.isFinite(n) && n >= 0 ? n : 120))(
      parseInt(process.env.RAW_MIRROR_BOOT_GRACE_SEC || '120', 10)
    );
    cron.schedule(rawMirrorSchedule, async () => {
      if (rawMirrorRunning) {
        logger.debug('[CRON-RawMirror] previous run still active, skip');
        return;
      }
      // (R1) 배포 직후 해빙 폭주 완충: 부팅 유예 — rolling 공존창(30~60s)엔 old 인스턴스가 담당,
      //   new는 유예 후 합류. 유예 중 신규 주문 시트는 _triggerSheetMirrorOnce가 자가치유(현행 백스톱).
      if (process.uptime() < bootGraceSec) {
        logger.debug(`[CRON-RawMirror] boot grace ${Math.round(process.uptime())}s/${bootGraceSec}s, skip`);
        return;
      }
      const throttle = getThrottleStatus();
      const busyThreshold = parseInt(process.env.RAW_MIRROR_BUSY_THRESHOLD || '10', 10);
      if (throttle.requestsInLastMinute > busyThreshold) {
        logger.debug(`[CRON-RawMirror] throttle busy (${throttle.requestsInLastMinute}/${throttle.limit}), skip`);
        return;
      }
      rawMirrorRunning = true;
      try {
        // (R1) 인스턴스 경계 직렬화 — rolling 배포 중 old+new 동시 미러(합산 실쿼터 초과) 차단.
        //   기존 reconcile/queuePump와 동일한 jobLock 패턴. busy면 즉시 양보(다음 5분 cron 백스톱).
        const { withJobLock } = require('../utils/jobLock');
        const result = await withJobLock('raw_mirror_all', () => mirrorAllSheets({ force: false, includeHidden: true }));
        if (result && result.skipped) {
          logger.debug('[CRON-RawMirror] raw_mirror_all lock busy — 다른 인스턴스 미러 중, 양보');
        } else if ((result.tabsMirrored || 0) > 0 || (result.errors || 0) > 0 || (result.sheetsDeferred || 0) > 0) {
          logger.info(`[CRON-RawMirror] tabs=${result.tabsMirrored}, rows=${result.rowsWritten}, skipped=${result.sheetsSkipped}, deferred=${result.sheetsDeferred || 0}, errors=${result.errors}, elapsed=${result.elapsed}`);
        }
      } catch (err) {
        logger.error(`[CRON-RawMirror] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'raw_mirror', error: err, context: { job: 'raw_mirror' } });
      } finally {
        rawMirrorRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 막힌 주문 자동복구(리컨실): 2분마다 — RAW 미러 뒤에 둠(메타 채워진 뒤 복구) ──
  //   pending_no_row/failed/정체 queued 주문을 시트에 다시 밀어넣는다(복구분은 하단 노란행).
  //   읽기 쿼터 부담 0(메타 없는 탭은 skip). 아침 폭주 시 throttle busy면 양보.
  if (process.env.ORDER_RECONCILE_CRON_ENABLED !== 'false') {
    const reconcileSchedule = process.env.ORDER_RECONCILE_CRON_SCHEDULE || '*/2 * * * *';
    cron.schedule(reconcileSchedule, async () => {
      if (reconcileRunning) return;
      // ★ AUTO 배치 시 cron reconcile 양보: 배치 스케줄러가 탭별 reconcile-first(DB-only, 시트콜0)를
      //   직접 수행하므로 이 cron은 order_reconcile 락만 점유해 배치 드레인을 skip시키는 역효과.
      //   AUTO=1이면 cron reconcile 비활성(배치가 전탭 FIFO 순회로 reconcile 커버). AUTO 끄면 복귀.
      if (process.env.ORDER_BATCH_AUTO === '1') return;
      const throttle = getThrottleStatus();
      const busyThreshold = parseInt(process.env.ORDER_RECONCILE_BUSY_THRESHOLD || '20', 10);
      if (throttle.requestsInLastMinute > busyThreshold) {
        logger.debug(`[CRON-Reconcile] throttle busy (${throttle.requestsInLastMinute}/${throttle.limit}), skip`);
        return;
      }
      reconcileRunning = true;
      try {
        const { reconcileStuckOrders } = require('../services/orderLedger.service');
        const { withJobLock } = require('../utils/jobLock');
        // ★ #1: 멀티인스턴스/rolling 배포(old+new 공존) 경합 차단 — order_reconcile advisory lock으로
        //   cron·flush·인라인 reconcile을 하나로 직렬화. 다른 인스턴스가 보유 중이면 이번 틱은 양보.
        const r = await withJobLock('order_reconcile', () => reconcileStuckOrders({ limit: 100, perTabCap: 60 }));
        if (r && (r.requeued > 0 || r.stillStuck > 0 || r.noCandidates > 0)) {
          logger.info(`[CRON-Reconcile] requeued=${r.requeued}, skippedNoMeta=${r.skippedNoMeta}, noCandidates=${r.noCandidates}, stillStuck=${r.stillStuck}`);
        } else if (r && r.skipped) {
          logger.debug('[CRON-Reconcile] order_reconcile lock busy — 다른 인스턴스 처리 중, 양보');
        }
      } catch (err) {
        logger.error(`[CRON-Reconcile] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'order_reconcile', error: err, context: { job: 'order_reconcile' } });
      } finally {
        reconcileRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── written 사후검증(유령 written 감지·자가치유 + 캡처미첨부/적체 한글로그): 기본 ON ──
  //   7/24 이지유 사건 재발방지: written 주문의 기록 행을 RAW 미러와 신원대조 →
  //   행이동=포인터 보정 / 소실=critical 알림+failed 강등(reconcile 재기록) / 반복소실=stuck_manual.
  //   전부 DB-only(시트 API 0콜) — RAW 미러(*/5)와 3분 오프셋으로 항상 미러 직후 검증.
  if (process.env.ORDER_WRITTEN_VERIFY !== '0') {
    const wvSchedule = process.env.ORDER_WRITTEN_VERIFY_SCHEDULE || '3-59/5 * * * *';
    let wvRunning = false;
    cron.schedule(wvSchedule, async () => {
      if (wvRunning) return;
      wvRunning = true;
      try {
        const { runWrittenVerifyCycle } = require('../services/writtenVerify.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('order_written_verify', () => runWrittenVerifyCycle());
        const v = (r && r.verify) || {};
        if (v.shifted || v.lost || v.lostManual || v.ambiguous
            || (r && r.capture && r.capture.flagged) || (r && r.stuck && r.stuck.flagged)) {
          logger.info(`[CRON-WrittenVerify] verified=${v.verified || 0}, shifted=${v.shifted || 0}, lost=${v.lost || 0}, lostManual=${v.lostManual || 0}, ambiguous=${v.ambiguous || 0}, noCapture=${(r.capture && r.capture.flagged) || 0}, stuck=${(r.stuck && r.stuck.flagged) || 0}`);
        }
      } catch (err) {
        logger.error(`[CRON-WrittenVerify] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'order_written_verify', error: err, context: { job: 'order_written_verify' } });
      } finally {
        wvRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 리뷰 자동검수 배치 스윕(M2): 미검수 재시도 + 과거 제출분 따라잡기 ──
  //   인라인 검수는 신규 제출만 본다. AI 가 죽어 있던 건(pending)과 배포 이전 제출분을
  //   여기서 따라잡는다. 시트 API 무접촉 — Drive 다운로드·AI 는 사이클 캡으로 통제.
  //   ★ 다른 크론과 분(minute)을 겹치지 않게 둔다(*/5 미러·*/2 리컨실과 충돌 회피).
  if (process.env.REVIEW_INSPECT !== '0' && process.env.REVIEW_INSPECT_SWEEP !== '0') {
    const riSchedule = process.env.REVIEW_INSPECT_SWEEP_SCHEDULE || '4-59/10 * * * *';
    let riRunning = false;
    cron.schedule(riSchedule, async () => {
      if (riRunning) return;
      riRunning = true;
      try {
        const { runInspectSweep } = require('../services/reviewInspect.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('review_inspect_sweep', () => runInspectSweep());
        if (r && (r.done || r.failed || r.gaveUp)) {
          logger.info(`[CRON-ReviewInspect] scanned=${r.scanned}, done=${r.done}, failed=${r.failed}, gaveUp=${r.gaveUp}`);
        }
      } catch (err) {
        logger.error(`[CRON-ReviewInspect] error: ${err.message}`);
      } finally {
        riRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 무시트 작업표 번호 자동 정리(스윕) ──────────────────────────────────────
  //   주문이 들어올 때는 그 자리에서 다시 매겨지지만(renumberTabInTx), **이미 비어 있던 줄**과
  //   그때 실패한 건은 남는다. 사람이 [🔢 번호 정리]를 누르지 않아도 채워지도록 주기로 훑는다.
  //   ★ 대상은 **한 쿼리 스캔으로 추린 작업만**(정리가 끝나면 매 사이클 쿼리 1번으로 끝난다).
  //   ★ 사이클 상한이 있어 업무 시간에 DB 를 흔들지 않는다 — 남은 것은 다음 사이클.
  //   ★ 다른 크론과 분(minute)을 겹치지 않게(*/5 미러 · */2 리컨실 · 4-59/10 검수와 오프셋).
  //   끄기: WORKTABLE_RENUMBER_SWEEP=0 (기능 전체는 WORKTABLE_AUTO_NUMBER=0)
  if (process.env.WORKTABLE_AUTO_NUMBER !== '0' && process.env.WORKTABLE_RENUMBER_SWEEP !== '0') {
    const rnSchedule = process.env.WORKTABLE_RENUMBER_SWEEP_SCHEDULE || '3-59/5 * * * *';
    let rnRunning = false;
    cron.schedule(rnSchedule, async () => {
      if (rnRunning) return;
      rnRunning = true;
      try {
        const { sweepNumbering } = require('../services/rowNumbering.service');
        const { withJobLock } = require('../utils/jobLock');
        const cap = parseInt(process.env.WORKTABLE_RENUMBER_SWEEP_CAP || '12', 10);
        const r = await withJobLock('worktable_renumber_sweep', () => sweepNumbering({ cap }));
        // 할 일이 있었을 때만 로그(평상시 로그 소음 0)
        if (r && !r.skipped && (r.changedTabs || r.failed)) {
          logger.info(`[CRON-Renumber] 대상=${r.need} 처리=${r.tabs} 작업=${r.changedTabs} 줄=${r.changedRows}`
            + `${r.failed ? ` 실패=${r.failed}` : ''}${r.remaining ? ` 남음=${r.remaining}` : ''}`);
        }
      } catch (err) {
        logger.error(`[CRON-Renumber] error: ${err.message}`);
      } finally {
        rnRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 시트→DB 역동기화 무인 사이클(detect+constrained auto-apply): 기본 OFF ──
  //   REVERSE_SYNC_AUTO=1 에서만 동작(SHEET_REVERSE_SYNC=1·ORDER_LEDGER_WRITE_ENABLED=true 추가게이트는 서비스 내부).
  //   활성탭 라운드로빈 detect → 안전필드만 apply시점 라이브 재검증 후 자동적용(전용 락 reverse_sync_auto).
  //   RAW미러(*/5)·reconcile(*/2)와 겹치지 않게 3분 오프셋. throttle busy면 서비스가 양보.
  if (process.env.REVERSE_SYNC_AUTO === '1') {
    const reverseAutoSchedule = process.env.REVERSE_SYNC_AUTO_SCHEDULE || '1-59/3 * * * *';
    let reverseAutoRunning = false;
    cron.schedule(reverseAutoSchedule, async () => {
      if (reverseAutoRunning) return;
      const throttle = getThrottleStatus();
      const busyThreshold = parseInt(process.env.REVERSE_SYNC_BUSY || '15', 10);
      if (throttle.requestsInLastMinute > busyThreshold) {
        logger.debug(`[CRON-ReverseSync] throttle busy (${throttle.requestsInLastMinute}/${throttle.limit}), skip`);
        return;
      }
      reverseAutoRunning = true;
      try {
        const { runReverseSyncAutoCycle } = require('../services/orderLedger.service');
        const r = await runReverseSyncAutoCycle({});
        if (r && !r.skipped && ((r.detected || 0) > 0 || (r.apply && (r.apply.applied || 0) > 0))) {
          logger.info(`[CRON-ReverseSync] tabs=${r.activeTabs} detectRuns=${r.detectRuns} detected=${r.detected} applied=${r.apply && r.apply.applied} orders=${r.apply && r.apply.orders} reverifyFail=${r.apply && r.apply.reverifyFail}`);
        }
      } catch (err) {
        logger.error(`[CRON-ReverseSync] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'reverse_sync_auto', error: err, context: { job: 'reverse_sync_auto' } });
      } finally {
        reverseAutoRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 무시트 주문 작업보드 인계(자동 복구): 기본 ON · 최근 창만 ─────────────────────
  //   ★★ 왜 필요한가 — 참여형(무시트) 주문의 원장 좌표는 `campaign:<공고ID>` 라 큐 리컨실이
  //     **스캔에서 제외**한다(orderLedger `NOT LIKE 'campaign:%'` — 큐는 구글시트에 쓰므로
  //     이 좌표로는 영원히 복구되지 않는다). 그래서 제출 경로에서 작업보드 기록이 한 번 실패하면
  //     (배포 스큐·공고 작업표 미연결·일시 장애) **자동 복구 경로가 0** 이었다 — 사람이
  //     `POST /api/diag/sheetless-worktable-recover` 를 부를 때까지 결제한 리뷰어가 어느 표에도
  //     없고 리뷰어 "리뷰 내역"에도 안 뜬다(2026-08-19 실사고 85건).
  //   ★★ 폭발반경 제한 3중(8/18 대량 append 사고의 교훈 — 그때 부팅 잡은 창도 상한도 없었다):
  //     ① 최근 `SHEETLESS_RECOVER_WINDOW_HOURS`(기본 48) 시간 제출분만 — 옛 고아 주문까지
  //        무인으로 줄을 이어붙이지 않는다(그건 사람이 수동 복구로 판단한다)
  //     ② 사이클당 `SHEETLESS_RECOVER_CRON_LIMIT`(기본 50) 건
  //     ③ `withJobLock('sheetless_worktable_recover')` — 수동 실행·다른 인스턴스와 상호배제
  //   ★ 중복 줄 방어는 `writeOrderToWorktable` 안에 구조적으로 있다(같은 주문번호+연락처가 이미
  //     반영돼 있으면 새 슬롯을 먹지 않고 `duplicate_row` 로 그 줄을 가리킨다).
  //   ★ 구글시트·GAS 호출 0(DB→DB) — 시트 쿼터 무영향.
  //   되돌리기 = Railway `SHEETLESS_RECOVER_CRON=0`.
  if (process.env.SHEETLESS_RECOVER_CRON !== '0') {
    const slrSchedule = process.env.SHEETLESS_RECOVER_CRON_SCHEDULE || '*/10 * * * *';
    let slrRunning = false;
    cron.schedule(slrSchedule, async () => {
      if (slrRunning) return;
      slrRunning = true;
      try {
        const { recoverUnwrittenSheetlessOrders } = require('../services/sheetlessOrder.service');
        const { withJobLock } = require('../utils/jobLock');
        const limit = parseInt(process.env.SHEETLESS_RECOVER_CRON_LIMIT || '50', 10);
        const sinceHours = parseInt(process.env.SHEETLESS_RECOVER_WINDOW_HOURS || '48', 10);
        const r = await withJobLock('sheetless_worktable_recover', () =>
          recoverUnwrittenSheetlessOrders({ limit, sinceHours, by: 'cron' }));
        if (r && r.skipped) {
          logger.debug('[CRON-SheetlessRecover] lock busy — 다른 실행 진행 중, 양보');
        } else if (r && (r.written > 0 || r.failed > 0)) {
          // ★ 조용히 넘기지 않는다 — 여기 숫자가 곧 "제출 경로가 새고 있다"는 신호다.
          logger.warn(`[CRON-SheetlessRecover] scanned=${r.scanned} written=${r.written} failed=${r.failed} noOpenSlot=${r.noOpenSlot} linked=${r.linked}`);
          if (r.failed > 0) {
            logAbnormal({
              flow: 'cron', step: 'sheetless_worktable_recover', severity: 'warn',
              error: new Error(`작업보드 인계 실패 ${r.failed}건(복구 시도 후에도 미반영)`),
              context: { job: 'sheetless_worktable_recover', scanned: r.scanned, written: r.written, failed: r.failed },
            });
          }
        }
      } catch (err) {
        logger.error(`[CRON-SheetlessRecover] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'sheetless_worktable_recover', error: err, context: { job: 'sheetless_worktable_recover' } });
      } finally { slrRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 작업표 중복 줄 감시망: 기본 ON · 읽기 전용 ─────────────────────────────
  //   ★★ 왜 필요한가 — 같은 구매가 표에 여러 줄로 늘어난 사고(2026-08-19 권정현 11줄)를
  //     **아무도 몰랐다**. 사람이 표를 보다 우연히 발견했다. 기록 경로의 2차 중복 판정이
  //     최종 방어지만, 그것이 또 뚫려도 알 길이 없는 상태를 없앤다.
  //   ★ 읽기 전용 — 줄을 내리지도 주문을 취소하지도 않는다. 정리는 사람이 [♻ 중복 줄 정리]로.
  //   ★ 같은 상태가 이어지면 알리지 않는다(직전 스냅샷과 달라졌을 때만) — 늑대소년 방지.
  //   ★ 구글시트·GAS 호출 0(DB→DB).
  //   되돌리기 = Railway `WORKTABLE_DUP_WATCH=0`.
  if (process.env.WORKTABLE_DUP_WATCH !== '0') {
    const dwSchedule = process.env.WORKTABLE_DUP_WATCH_SCHEDULE || '17 * * * *';
    let dwRunning = false;
    cron.schedule(dwSchedule, async () => {
      if (dwRunning) return;
      dwRunning = true;
      try {
        const { watchDuplicateRows } = require('../services/worktableDupWatch.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('worktable_dup_watch', () => watchDuplicateRows({ by: 'cron' }));
        if (r && r.skipped) logger.debug('[CRON-DupWatch] lock busy — 양보');
        else if (r && r.ok && r.groupCount > 0) {
          logger.warn(`[CRON-DupWatch] 중복 묶음 ${r.groupCount}개 · 군더더기 ${r.extraRows}줄 (알림 ${r.alerted ? '발신' : '생략 — 직전과 동일'})`);
        }
      } catch (err) {
        // ★ 감시망이 크론을 죽이지 않는다.
        logger.error(`[CRON-DupWatch] error: ${err.message}`);
      } finally { dwRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── Phase 4: campaign_participants를 review_index에서 주기 최신화(DB를 살아있는 원본화): 기본 OFF ──
  //   PARTICIPANTS_AUTO_SYNC=1 에서만. 시트 재읽기 0(DB→DB 복사)·라이브 소비처 없음(shadow) → 무영향.
  //   수동편집(source='manual') 행은 보존. 이미 가져온 탭만 대상(규모 작음).
  if (process.env.PARTICIPANTS_AUTO_SYNC === '1') {
    if (process.env.PARTICIPANTS_SHEET_MIRROR === '1') {
      logger.warn('[CRON-ParticipantsSync] ⚠️ AUTO_SYNC + SHEET_MIRROR 동시 활성 — sync가 최신화한 상태값이 mirror-tab 시 시트로 흐를 수 있음(빈칸-only·비파괴). 의도 확인 후 운영.');
    }
    const partSyncSchedule = process.env.PARTICIPANTS_AUTO_SYNC_SCHEDULE || '*/10 * * * *';
    let partSyncRunning = false;
    cron.schedule(partSyncSchedule, async () => {
      if (partSyncRunning) return;
      partSyncRunning = true;
      try {
        const { syncImportedTabs } = require('../services/participants.service');
        const { withJobLock } = require('../utils/jobLock');
        // rolling 배포 시 old+new 인스턴스의 두 cron이 겹쳐 seen-set 오염하는 걸 직렬화(busy면 이번 주기 skip).
        const r = await withJobLock('trackb_project', () => syncImportedTabs({ by: 'cron' }));
        if (r && (r.tabsSynced > 0) && (r.inserted > 0 || r.updated > 0)) {
          logger.info(`[CRON-ParticipantsSync] tabs=${r.tabsSynced} inserted=${r.inserted} updated=${r.updated} errors=${r.errors}`);
        }
      } catch (err) {
        logger.error(`[CRON-ParticipantsSync] error: ${err.message}`);
      } finally { partSyncRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── Track B(평행 트랙) 그림자 투영: 플래그 OFF 기본. 라이브 읽어 B 원장 최신화(추가·읽기·격리, 라이브 무영향). ──
  //   등록 자체를 TRACK_B_PROJECTION=1 게이트 뒤에 둔다(off면 스케줄 미등록). projectActive도 내부 재확인.
  if (process.env.TRACK_B_PROJECTION === '1') {
    const trackBSchedule = process.env.TRACK_B_PROJECTION_SCHEDULE || '*/10 * * * *';
    let trackBRunning = false;
    cron.schedule(trackBSchedule, async () => {
      if (trackBRunning) return;
      trackBRunning = true;
      try {
        const { projectActive } = require('../services/trackB.service');
        const { withJobLock } = require('../utils/jobLock');
        // participants sync cron 과 같은 락으로 상호배제(멀티인스턴스 이중투영·seen-set 플래핑 차단).
        const r = await withJobLock('trackb_project', () => projectActive({ by: 'cron' }));
        if (r && r.done > 0) logger.info(`[CRON-TrackB] projected tabs=${r.done}/${r.candidateTabs} errors=${r.errors}`);
      } catch (err) {
        logger.error(`[CRON-TrackB] error: ${err.message}`);
      } finally { trackBRunning = false; }
    }, { timezone: 'Asia/Seoul' });

    // ── Track B parity 일일 스냅샷: 2주 관측 정량화(추이). 투영이 켜진 경우만 의미 → 같은 게이트 안. ──
    const snapSchedule = process.env.TRACK_B_PARITY_SNAPSHOT_SCHEDULE || '30 5 * * *';   // 매일 05:30 KST
    let snapRunning = false;
    cron.schedule(snapSchedule, async () => {
      if (snapRunning) return;
      snapRunning = true;
      try {
        const { parityAll } = require('../services/trackB.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('trackb_parity_snap', () => parityAll({ store: true, source: 'cron' }));
        if (r && r.tabs) logger.info(`[CRON-TrackB-Parity] snapshot tabs=${r.tabs} realZero=${r.realZero}`);
      } catch (err) {
        logger.error(`[CRON-TrackB-Parity] error: ${err.message}`);
      } finally { snapRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── Track B P2 상태 토글 write-back(기본 OFF): cutover 탭(진실원천 플래그='db')의 is_submitted/is_paid
  //   오버레이 편집만 시트 리뷰제출/입금 상태칸에 반영. Track A 무접촉(스윕이 유일 구동자), 저우선·멱등·blank-only.
  //   ★ 플래그 판정은 writebackSweep(trackB.service, 격리 ALLOWED) 안에서만 — 이 파일은 플래그를 읽지 않는다. ──
  if (process.env.TRACK_B_WRITEBACK === '1') {
    if (process.env.PARTICIPANTS_SHEET_MIRROR === '1')
      logger.warn('[CRON-TrackB-WB] ⚠️ TRACK_B_WRITEBACK + PARTICIPANTS_SHEET_MIRROR 동시 활성 — 같은 상태칸 이중미러(blank-only라 비파괴). 같은 cutover 탭엔 하나만 권장.');
    const wbSchedule = process.env.TRACK_B_WRITEBACK_SCHEDULE || '*/5 * * * *';
    let wbRunning = false;
    cron.schedule(wbSchedule, async () => {
      if (wbRunning) return;
      wbRunning = true;
      try {
        const { writebackSweep } = require('../services/trackB.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('trackb_writeback', () => writebackSweep({}));
        if (r && r.written > 0) logger.info(`[CRON-TrackB-WB] tabs=${r.done} written=${r.written} held=${r.held} errors=${r.errors}`);
      } catch (err) {
        logger.error(`[CRON-TrackB-WB] error: ${err.message}`);
      } finally { wbRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  const schedule = process.env.INDEX_CRON_SCHEDULE || '0 9,15 * * 1-6';
  cron.schedule(schedule, async () => {
    logger.info(`[CRON] 인덱스 빌드 시작: ${new Date().toISOString()}`);
    try {
      const result = await buildIndexSmart(false);
      logger.info(`[CRON] 인덱스 빌드 완료: rebuilt=${result.rebuilt}, skipped=${result.skipped}, ${result.elapsed}`);
      emitIndexBuild({ rebuilt: result.rebuilt || 0, skipped: result.skipped || 0, errors: result.errors || 0, elapsed: result.elapsed || '', trigger: 'cron' });
    } catch (err) {
      logger.error(`[CRON] 인덱스 빌드 오류: ${err.message}`);
      logAbnormal({ flow: 'cron', step: 'index_build', error: err, context: { job: '인덱스 빌드' } });
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
      logAbnormal({ flow: 'cron', step: 'index_build', error: err, context: { job: '전체 재빌드' } });
    }
  }, { timezone: 'Asia/Seoul' });

  // ── Phase 2: Sync Queue 워커 — 30초마다 pending 작업 처리 ──
  // ★ A2: stuck processing 자동 감지 포함
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const result = await processQueue(10);
      if (result.processed > 0) {
        logger.info(`[CRON-Queue] 처리: ${result.succeeded}/${result.processed} 성공, ${result.failed} 실패, ${result.elapsed}ms`);
      }
      // ★ R-F3-a 백스톱: AUTO=1이면 평소 order_append를 배치가 전담하지만, 배치 heartbeat가
      //   STALE 이상 끊기면(워치독도 못 살린 영구정지) cron이 소량 단건으로 order_append를 흡수 → 미반영 방지.
      if (process.env.ORDER_BATCH_AUTO === '1') {
        const STALE = parseInt(process.env.ORDER_BATCH_HEARTBEAT_STALE_SEC || '120', 10);
        try {
          const { getHeartbeat } = require('../jobs/orderBatchScheduler');
          const hb = getHeartbeat();
          if (Date.now() - (hb.lastTickAt || 0) > STALE * 1000) {
            logger.warn(`[CRON-Queue] 배치 heartbeat ${Math.round((Date.now() - (hb.lastTickAt || 0)) / 1000)}s 끊김 → order_append 단건 백스톱(5건)`);
            await processQueue(5, { onlyType: 'order_append' });
          }
        } catch (hbErr) { logger.warn(`[CRON-Queue] heartbeat 백스톱 체크 실패(무시): ${hbErr.message}`); }
      }
    } catch (err) {
      logger.error(`[CRON-Queue] 큐 처리 오류: ${err.message}`);
      logAbnormal({ flow: 'sync_queue', step: 'process_queue', error: err, context: { job: '큐 워커' } });
    }
  });

  // ── ★ 상시 배치 드레인 백스톱 — 15초마다 백로그 탭을 배치로 시트반영(근실시간) ──
  //   ORDER_BATCH_AUTO=1 일 때만 동작(kickOrderBatch 내부 게이트). 코얼레싱이라 중복 사이클 없음.
  //   제출 시 즉시 kick + 이 15초 cron이 백스톱(kick 누락·재시작 잔여분 흡수).
  cron.schedule('*/15 * * * * *', () => {
    try { require('../jobs/orderBatchScheduler').kickOrderBatch(); }
    catch (err) { logger.warn(`[CRON-OrderBatch] kick 실패(무시): ${err.message}`); }
  });

  // ── ★ A2+C2: 매시간 stuck/failed 자동 복구 ──
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await retryAllFailed();
      if (result.retried > 0 || result.unstuck > 0 || result.resetExhausted > 0) {
        logger.info(`[CRON-Queue] 자동 복구: retried=${result.retried}, unstuck=${result.unstuck}, resetExhausted=${result.resetExhausted}`);
      }
    } catch (err) {
      logger.error(`[CRON-Queue] 자동 복구 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 고아 캡처 정리(A종류: 링크 끊김): 기본 ON · 매일 새벽 4시 40분 ─────────
  //   ★★ 왜 필요한가 — 행 삭제·구매기록 취소(`orderCancellation`)도, 작업 통째 삭제
  //     (`workTabDelete`)도 **Drive 파일을 건드리지 않는다**. 그래서 지울수록 "폴더엔
  //     캡처가 있는데 화면엔 리뷰 이미지 미등록"인 고아가 쌓이는데 치우는 자동 경로가
  //     어디에도 없었다(중복 정리 도구는 같은 SHA-256 지문의 사본만 잡는다).
  //   ★ 판정 근거는 file_id / review_index_id 뿐 — **위치키(row_index) 금지**
  //     (번호 정리·재배정으로 수시로 깨져 멀쩡한 캡처를 지운다. 서비스 주석 참조).
  //   ★ 삭제는 **휴지통만**(30일 복구창) · 유예 ORPHAN_CAPTURE_GRACE_DAYS(기본 7일)
  //     · 한 회차 상한 ORPHAN_CAPTURE_CLEAN_CAP(기본 200).
  //   되돌리기 = Railway `ORPHAN_CAPTURE_CLEAN=0`.
  if (process.env.ORPHAN_CAPTURE_CLEAN !== '0') {
    const occSchedule = process.env.ORPHAN_CAPTURE_CLEAN_SCHEDULE || '40 4 * * *';
    let occRunning = false;
    cron.schedule(occSchedule, async () => {
      if (occRunning) return;
      occRunning = true;
      try {
        const { trashOrphanCaptures } = require('../services/orphanCaptureCleanup.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('orphan_capture_clean',
          () => trashOrphanCaptures({ dryRun: false, by: 'cron' }));
        if (r && r.skipped) logger.debug('[CRON-OrphanCapture] lock busy — 양보');
        else if (r && r.ok && (r.trashed > 0 || r.failed > 0)) {
          logger.warn(`[CRON-OrphanCapture] 휴지통 ${r.trashed}건 · 실패 ${r.failed}건`
            + ` · 경합회피 ${r.skippedRecheck || 0}건 (유예 ${r.graceDays}일)`);
        }
      } catch (err) {
        // ★ 정리가 크론을 죽이지 않는다.
        logger.error(`[CRON-OrphanCapture] error: ${err.message}`);
      } finally { occRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 완료된 큐 항목 정리: 매일 새벽 3시 (24시간 이상 경과) ──
  cron.schedule('0 3 * * *', async () => {
    try {
      const result = await purgeCompleted(24);
      logger.info(`[CRON-Queue] 정리: ${result.purged}건 완료 항목 삭제`);
    } catch (err) {
      logger.error(`[CRON-Queue] 정리 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 이상로그(error_logs) 보존 정리: 매일 새벽 3시 30분 ──
  // 해결건은 RETENTION_DAYS(기본 30일) 후, 미해결건은 3배 기간 후 삭제(안전망)
  cron.schedule('30 3 * * *', async () => {
    try {
      const days = parseInt(process.env.ERRORLOG_RETENTION_DAYS || '30', 10);
      const { rowCount } = await pool.query(
        `DELETE FROM error_logs
         WHERE (resolved = TRUE AND resolved_at < NOW() - ($1 || ' days')::interval)
            OR (created_at < NOW() - (($1 * 3) || ' days')::interval)`,
        [days]
      );
      if (rowCount) logger.info(`[CRON-ErrorLog] 정리: ${rowCount}건 삭제 (보존 ${days}일)`);
    } catch (err) {
      logger.error(`[CRON-ErrorLog] 정리 오류: ${err.message}`);
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 참여형 캠페인 홀드 만료 스윕: 매분 (DB-only — 시트 쿼터 0) ──
  //   판정 SoT는 시각 기준(status='applied' AND expires_at>now)이라 스윕 지연·미실행은 카운터를 오염시키지 않는다.
  //   역할: 정리(expired 마킹) + late_order_id 백필(관제 수동확정 목록) + closed 영속 백스톱.
  //   멀티인스턴스: withJobLock('campaign_hold_sweep') — 기존 락 이름들과 키 비충돌 확인(심판 실측).
  let holdSweepRunning = false;
  cron.schedule('* * * * *', async () => {
    if (holdSweepRunning) return;
    holdSweepRunning = true;
    try {
      const { withJobLock } = require('../utils/jobLock');
      const { sweepExpiredHolds } = require('../services/campaignHold.service');
      const r = await withJobLock('campaign_hold_sweep', () => sweepExpiredHolds(pool));
      if (r && !r.skipped && ((r.expired || 0) > 0 || (r.closedPersisted || 0) > 0
          || (r.autoDismissed || 0) > 0 || (r.revived || 0) > 0)) {
        logger.info(`[CRON-HoldSweep] expired=${r.expired} autoDismissed=${r.autoDismissed || 0} `
          + `revived=${r.revived || 0} closedPersisted=${r.closedPersisted}`);
      }
    } catch (err) {
      logger.error(`[CRON-HoldSweep] ${err.message}`);
    } finally {
      holdSweepRunning = false;
    }
  }, { timezone: 'Asia/Seoul' });

  // ── 무시트 장부 재생성 스윕(130) — 편집 tx 가 찍은 dirty 를 탭당 1회 재생성 ──
  //   ★ 편집 경로에서 rebuild 를 빼낸 짝. 실패하면 dirty 가 남아 다음 주기에 재시도(자가치유).
  //   ★ 킬스위치 SHEETLESS_LEDGER_SWEEP=0 (그러면 편집은 오버레이로만 남는다).
  if (process.env.SHEETLESS_LEDGER_SWEEP !== '0') {
    let ledgerSweepRunning = false;
    cron.schedule(process.env.SHEETLESS_LEDGER_SWEEP_SCHEDULE || '* * * * *', async () => {
      if (ledgerSweepRunning) return;
      ledgerSweepRunning = true;
      try {
        const { withJobLock } = require('../utils/jobLock');
        const { sweepDirtyLedgers } = require('../services/sheetlessLedgerSweep.service');
        await withJobLock('sheetless_ledger_sweep', () => sweepDirtyLedgers({ by: 'cron' }));
      } catch (err) {
        logger.warn(`[CRON-LedgerSweep] ${err.message}`);
      } finally {
        ledgerSweepRunning = false;
      }
    }, { timezone: 'Asia/Seoul' });
  }

  logger.info(`[CRON] 스케줄러 등록 완료: dirty=${process.env.INDEX_DIRTY_CRON_ENABLED === 'true' ? '15분' : 'OFF(smartBuild단일)'}, 인덱스=${schedule}, 전체재빌드=매일04시, 큐워커=30초, 자동복구=매시간, 정리=매일03시, 이상로그정리=매일03시30분, 홀드스윕=매분`);
}

module.exports = { startCronJobs };
