const cron = require('node-cron');
const { processQueue, purgeCompleted, retryAllFailed } = require('../services/syncQueue.service');
// [DEPRECATED — v11.8.0] syncSettingsOnly 제거: DB가 설정 원본이므로 시트→DB 동기화 불필요
const { logger } = require('../utils/logger');
const { logAbnormal } = require('../services/errorLog.service');
const pool = require('../db/pool');
// [REMOVED] readSheet — 세부목록→DB 자동동기화 CRON 제거됨 (DB가 원본)

/**
 * ★ 2026-10-22 시트 시절 정리 3단계(결정 273): 구글시트를 읽고 쓰던 정기 작업 —
 *   변경감지(15분)·RAW 미러(5분)·막힌 주문 리컨실(2분)·역동기화 자동(3분)·인덱스 빌드(09/15시)·
 *   전체 재빌드(04시)·상시 배치 드레인(15초)·배치 heartbeat 백스톱 — 은 삭제했다.
 *   운영은 2단계(Railway 설정)에서 이미 전부 꺼 둔 상태였다. 남은 크론은 전부 DB 안에서 끝난다.
 */
function startCronJobs() {
  // [DEPRECATED — v11.8.0] Group B 설정 동기화 CRON 제거
  // DB가 설정 원본이므로 시트→DB 설정 동기화가 불필요합니다.
  // 설정은 웹 UI(POST /api/tab/config)에서 직접 DB에 저장됩니다.

  // ── 작업보드 큐 누락 복구: 홀수 분마다(DB-only) ───────────────────────
  // 원장 저장 뒤 workboard_apply INSERT만 실패한 주문을 다시 큐에 넣는다(시트 리컨실 크론은 2026-10-22 삭제 — 결정 273).
  // 최근 48시간 중 기존 큐 이력이 전혀 없는 2분 이상 지난 주문만 재등록하며,
  // order_reconcile 락으로 수동 리컨실 경로와 겹치지 않는다. 큐 소비는 기존 30초 워커 하나가 계속 담당한다.
  if (process.env.WORKBOARD_RECONCILE_CRON !== '0') {
    const wbReconcileSchedule = process.env.WORKBOARD_RECONCILE_CRON_SCHEDULE || '1-59/2 * * * *';
    cron.schedule(wbReconcileSchedule, async () => {
      try {
        const { withJobLock } = require('../utils/jobLock');
        const { recoverMissingWorkboardQueues } = require('../services/workboardQueueApply.service');
        const r = await withJobLock('order_reconcile', () => recoverMissingWorkboardQueues({
          limit: parseInt(process.env.WORKBOARD_RECONCILE_LIMIT || '100', 10),
          staleSeconds: parseInt(process.env.WORKBOARD_RECONCILE_STALE_SECONDS || '120', 10),
          sinceHours: parseInt(process.env.WORKBOARD_RECONCILE_WINDOW_HOURS || '48', 10),
        }));
        if (r && (r.requeued > 0 || r.failed > 0)) {
          logger.info(`[CRON-WorkboardReconcile] scanned=${r.scanned} requeued=${r.requeued} failed=${r.failed}`);
        }
      } catch (err) {
        logger.error(`[CRON-WorkboardReconcile] error: ${err.message}`);
        logAbnormal({ flow: 'cron', step: 'workboard_reconcile', error: err, context: { job: 'workboard_reconcile' } });
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

  // ── 무시트 작업표 정원 자동 복구 ─────────────────────────────────────────────
  //   날짜별 조절·발주 정원 변경·과거 장애로 "총 500 / 줄 751"처럼 벌어진 경우를
  //   사람이 손으로 고치지 않아도 자동으로 수렴시킨다.
  //   빈 초과 슬롯만 후순위부터 soft-delete하고, 같은 실행에서 번호 1..N 및 원장을 재생성한다.
  //   공유 탭·비활성 행은 서비스가 안전하게 건너뛴다. 멀티 인스턴스는 DB 락으로 1회만 실행.
  //   끄기: WORKTABLE_CAP_AUTOFIX=0. 기본 5분, 배포 직후에도 30초 후 한 번 실행한다.
  if (process.env.WORKTABLE_CAP_AUTOFIX !== '0') {
    const capRepairSchedule = process.env.WORKTABLE_CAP_AUTOFIX_SCHEDULE || '1-59/5 * * * *';
    const capRepairLimit = Math.min(Math.max(parseInt(process.env.WORKTABLE_CAP_AUTOFIX_LIMIT || '30', 10) || 30, 1), 200);
    const capRepairBootDelay = Math.min(Math.max(parseInt(process.env.WORKTABLE_CAP_AUTOFIX_BOOT_DELAY_MS || '30000', 10) || 30000, 10000), 300000);
    let capRepairRunning = false;
    const runCapRepair = async (source) => {
      if (capRepairRunning) return;
      capRepairRunning = true;
      try {
        const { withJobLock } = require('../utils/jobLock');
        const { cleanupOverflowEmptyWorktableSlots } = require('../services/linkedRecruitQuota.service');
        const r = await withJobLock('worktable_cap_autofix', () => cleanupOverflowEmptyWorktableSlots({
          dryRun: false, limit: capRepairLimit, by: `cron:${source}`,
        }));
        const failures = (r && r.items || []).filter(x => x && x.error);
        if (failures.length) {
          logger.warn(`[CRON-WorktableCap] source=${source} failed=${failures.length} `
            + failures.map(x => `camp=${x.campaignId || '?'}:${x.code || x.error}`).join(' | '));
        } else if (r && !r.skipped && (r.retired || (r.items || []).some(x => x && x.projection))) {
          logger.info(`[CRON-WorktableCap] source=${source} scanned=${r.scanned} retired=${r.retired} skipped=${r.skipped}`);
        }
      } catch (err) {
        logger.error(`[CRON-WorktableCap] source=${source} error: ${err.message}`);
      } finally { capRepairRunning = false; }
    };
    setTimeout(() => { void runCapRepair('boot'); }, capRepairBootDelay);
    cron.schedule(capRepairSchedule, () => { void runCapRepair('cron'); }, { timezone: 'Asia/Seoul' });
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

  // ── 업체 ↔ 인트라넷 광고주 연결 동기화 (2026-09-28 올곧은무역·어니스트캄 — 같은 업체가 둘로 갈린 사고) ──
  //   인트라넷에서 사업자명을 정정해도 리뷰웹 업체가 따라가게 한다: 원본 ID 로 연결된 업체는 이름·사업자번호를
  //   맞추고, ID 가 비어 있는 업체는 인트라넷 사업자명이 **정확히 같은** 광고주가 하나일 때만 ID 를 채운다.
  //   ★ 자동 병합은 하지 않는다(결정 004) — 같은 업체로 보이는 두 업체는 로그로만 알린다(합치기는 사람이).
  //   ★ 인트라넷 도달 불가면 아무것도 쓰지 않는다. 되돌리기 = Railway `ADVERTISER_INTRANET_SYNC=0`.
  if (process.env.ADVERTISER_INTRANET_SYNC !== '0') {
    const asSchedule = process.env.ADVERTISER_INTRANET_SYNC_SCHEDULE || '23 * * * *';
    let asRunning = false;
    cron.schedule(asSchedule, async () => {
      if (asRunning) return;
      asRunning = true;
      try {
        const { applyIntranetSync } = require('../services/advertiserIntranetSync.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('advertiser_intranet_sync', () => applyIntranetSync({ by: 'cron' }));
        if (r && r.skipped) logger.debug('[CRON-AdvSync] lock busy — 양보');
        else if (r && r.ok) {
          const c = r.remaining || {};
          const needHuman = (c.duplicate || 0) + (c.rename_blocked || 0) + (c.name_taken || 0) + (c.suggest || 0) + (c.ambiguous || 0);
          if (needHuman) logger.warn(`[CRON-AdvSync] 사람 확인 필요 ${needHuman}건(합치기 대상 ${(c.duplicate || 0) + (c.rename_blocked || 0)}) — 업체관리 인트라넷 연결 점검`);
        } else if (r && !r.ok) logger.warn(`[CRON-AdvSync] ${r.error}`);
      } catch (err) {
        logger.error(`[CRON-AdvSync] error: ${err.message}`);
      } finally { asRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 명의 카드 거울(조각 2-1 · 결정 기록 176): 10분마다 카드를 리뷰어 정보(sub_accounts)에 맞춘다 ──
  //   ★ 저장 경로 19곳은 건드리지 않는다 — 달라진 리뷰어만 짧은 트랜잭션으로 맞춘다(FOR NO KEY UPDATE + lock_timeout).
  //   ★ 아직 아무도 카드를 읽지 않으므로 최대 10분 늦어도 영향 없다. 되돌리기 = Railway `IDENTITY_CARDS_RECONCILE=0`.
  if (process.env.IDENTITY_CARDS_RECONCILE !== '0') {
    const icSchedule = process.env.IDENTITY_CARDS_RECONCILE_SCHEDULE || '7-59/10 * * * *';
    let icRunning = false;
    cron.schedule(icSchedule, async () => {
      if (icRunning) return;
      icRunning = true;
      try {
        const { reconcileCards } = require('../services/reviewerIdentityCards.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('identity_cards_reconcile', () => reconcileCards({ dryRun: false, by: 'cron' }));
        if (r && r.skipped) logger.debug('[CRON-IdentityCards] lock busy — 양보');
      } catch (err) {
        // ★ 카드 거울이 크론을 죽이지 않는다(표 미적용 42P01 포함 — 로그만).
        logger.error(`[CRON-IdentityCards] error: ${err.message}`);
      } finally { icRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 같은 번호 타계정 정리 스위치(결정 226 3·4단계 · migration 185) ──
  //   Railway `SAME_PHONE_FOLD_MODE` — 없음/off = 아무것도 안 함 · preview · apply:<미리보기 번호> · undo_all:<실행 번호>.
  //   ★ 값을 바꾸면 Railway 가 다시 배포한다 → 기동 90초 뒤 한 번만 돈다(작업 잠금 · 끝난 실행은 다시 하지 않음).
  //   ★ 실패해도 서버·다른 작업에 영향 0(로그만). 끝나면 스위치를 off 로 돌린다.
  if (process.env.SAME_PHONE_FOLD_MODE && process.env.SAME_PHONE_FOLD_MODE !== 'off') {
    setTimeout(async () => {
      try {
        const r = await require('../services/reviewerIdentityFold.service').runFromSwitch();
        logger.info(`[CRON-IdentityFold] ${JSON.stringify(r && (r.summary || r)).slice(0, 400)}`);
      } catch (err) {
        logger.error(`[CRON-IdentityFold] error: ${err.code || ''} ${err.message}`);
      }
    }, Number(process.env.SAME_PHONE_FOLD_DELAY_MS) || 90 * 1000);
  }

  // ── Phase 4: campaign_participants를 review_index에서 주기 최신화(DB를 살아있는 원본화): 기본 OFF ──
  //   PARTICIPANTS_AUTO_SYNC=1 에서만. 시트 재읽기 0(DB→DB 복사)·라이브 소비처 없음(shadow) → 무영향.
  //   수동편집(source='manual') 행은 보존. 이미 가져온 탭만 대상(규모 작음).
  if (process.env.PARTICIPANTS_AUTO_SYNC === '1') {
    // (PARTICIPANTS_SHEET_MIRROR 동시 활성 경고 — participant_mirror 시트 되쓰기는 2026-10-23 제거 · 결정 274)
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

  // ── 작업 자동 마감: 기본 ON · 10분마다 ─────────────────────────────────────────
  //   "인원·제출·입금이 모두 채워진 작업"을 홈 작업목록에서 **마감 보관함**으로 자동 이동한다
  //   (2026-09-21 사용자 확정). 대상 판정은 화면의 `✓ 마감 후보` 배지와 **같은 함수**이고,
  //   사람이 [↩ 진행중으로 복귀]로 되돌린 작업은 다시 마감하지 않는다(서비스 주석 참조).
  //   ★ 마감은 화면 분류일 뿐이라 시트·리뷰어 화면·주문·정산 무접촉 — 되돌리기는 클릭 한 번.
  //   ★ 조회가 하나라도 실패하면 **한 건도 건드리지 않는다**(fail-closed — 서비스가 판정).
  //   되돌리기 = Railway `TAB_AUTO_FINISH=0`.
  if (process.env.TAB_AUTO_FINISH !== '0') {
    const afSchedule = process.env.TAB_AUTO_FINISH_SCHEDULE || '*/10 * * * *';
    let afRunning = false;
    cron.schedule(afSchedule, async () => {
      if (afRunning) return;
      afRunning = true;
      try {
        const { autoFinishEligibleTabs } = require('../services/trackB.service');
        const { withJobLock } = require('../utils/jobLock');
        // ★ 멀티 인스턴스가 같은 탭을 동시에 마감하지 않게(활성 1건 부분유니크가 최종 방어지만
        //   무의미한 경합 쓰기를 미리 막는다). 기존 락 이름들과 비충돌.
        const r = await withJobLock('tab_auto_finish', () => autoFinishEligibleTabs({ dryRun: false, by: '자동 마감' }));
        if (r && r.skipped) logger.debug('[CRON-AutoFinish] lock busy — 양보');
        else if (r && r.ok === false) logger.warn(`[CRON-AutoFinish] 건너뜀(${r.code}): ${r.error}`);
      } catch (err) {
        // ★ 자동 마감이 크론을 죽이지 않는다.
        logger.error(`[CRON-AutoFinish] error: ${err.message}`);
      } finally { afRunning = false; }
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

  // (Track B P2 상태 토글 write-back 크론은 2026-09-28 제거 — 결정 186 5번. TRACK_B_WRITEBACK 은 본섭 미설정이었고 전환(source_of_truth='db') 탭 0.)

  // ── Phase 2: Sync Queue 워커 — 30초마다 pending 작업 처리 ──
  // ★ A2: stuck processing 자동 감지 포함
  // ★★ 결정 271 → 274: 이 워커의 일은 작업보드 반영(DB_ONLY_QUEUE_TYPES)뿐이다. 시트 타입
  //   (order_append·order_update·order_cancel·review_submit …)은 실행부를 지웠고 클레임 SQL 이 고르지 않는다 —
  //   시트 시절 잔여 행은 기록으로 남는다(`ORDER_BATCH_AUTO` 는 더 이상 읽지 않는다).
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const result = await processQueue(10);
      if (result.processed > 0) {
        logger.info(`[CRON-Queue] 처리: ${result.succeeded}/${result.processed} 성공, ${result.failed} 실패, ${result.elapsed}ms`);
      }
    } catch (err) {
      logger.error(`[CRON-Queue] 큐 처리 오류: ${err.message}`);
      logAbnormal({ flow: 'sync_queue', step: 'process_queue', error: err, context: { job: '큐 워커' } });
    }
  });

  // ── ★ A2+C2: 매시간 stuck/failed 자동 복구 ──
  //   ★ 결정 271: 작업보드 반영 타입(DB_ONLY_QUEUE_TYPES)만 되살린다 — 시트 타입 실패분은 기록으로 남긴다.
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

  // ── (고아 캡처 자동 정리 04:40 은 2026-10-02 제거 — 결정 064 후속 · 결정 186 73번)
  //   도입(08-21) 이래 조회 칸 오류로 한 번도 돌지 않았고, 고쳐서 세어 보니 대상 72장 중 62장이
  //   **번호가 다시 매겨진 정상 리뷰 사진**(같은 작업에 같은 사람이 다른 번호로 살아 있음 — 그중 11장은
  //   유일한 리뷰 증빙일 수 있음)이었다. A 판정("붙어 있던 명단 줄이 사라짐")이 번호 재매김을 고아로 읽는다.
  //   진짜 고아는 10장 남짓이라 자동으로 돌릴 이유가 없다 → 크론 제거.
  //   수동 창구 POST /api/drive/orphan-capture-cleanup 와 정리 서비스도 2026-10-22 제거(결정 272).
  //   ★ 되살리려면 먼저 A 판정이 번호 재매김을 고아로 읽지 않게 고친다(결정 064 완화 금지).

  // ── 작업표 날짜 맞추기(결정 182 · 2026-09-26): 매일 새벽 4시 20분 ──
  //   날짜별 인원은 규칙(일건수·주말·이월·총량)이 정하고 작업표가 따라간다. 전날 못 채운 몫(이월)과
  //   종료일 연장은 날이 바뀌며 달라지므로, 조용한 시간에 작업표 빈 줄 날짜를 한 번 맞춘다.
  //   ★ 0시는 자율주문 공고가 열려 참여가 몰리는 시각이라 피한다. ★ 빈 줄만 옮기고 줄은 만들지 않는다.
  //   되돌리기 = Railway `CAMPAIGN_WORKTABLE_RELAY_CRON=0`.
  if (process.env.CAMPAIGN_WORKTABLE_RELAY_CRON !== '0') {
    const wrSchedule = process.env.CAMPAIGN_WORKTABLE_RELAY_SCHEDULE || '20 4 * * *';
    let wrRunning = false;
    cron.schedule(wrSchedule, async () => {
      if (wrRunning) return;
      wrRunning = true;
      try {
        const { relayAllCampaignWorktables } = require('../services/campaignPlan.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('campaign_worktable_relay', () => relayAllCampaignWorktables({ by: 'cron' }));
        if (r && r.skipped === true && !r.total) logger.debug('[CRON-WorktableRelay] lock busy — 양보');
        else if (r) logger.info(`[CRON-WorktableRelay] 공고 ${r.total || 0} · 옮김 ${r.moved || 0} · 비움 ${r.cleared || 0} · 실패 ${r.failed || 0}`);
      } catch (err) {
        logger.error(`[CRON-WorktableRelay] error: ${err.message}`);
      } finally { wrRunning = false; }
    }, { timezone: 'Asia/Seoul' });
  }

  // ── 순차진행 지난 날 고정(결정 228 · 레드팀 P0): 매일 0시 5분 + 서버 켜진 뒤 1분 ──
  //   어제까지의 「그날 상품」을 기록해, 설정이 바뀌어도 지난 날이 당겨지거나 끝난 상품이 다시 열리지 않게 한다.
  //   빠져도 일정표는 설정으로 계산된다(종전 동작). 되돌리기 = Railway `CAMPAIGN_SEQUENTIAL_FREEZE_CRON=0`.
  if (process.env.CAMPAIGN_SEQUENTIAL_FREEZE_CRON !== '0') {
    let sfRunning = false;
    const runFreeze = async (by) => {
      if (sfRunning) return;
      sfRunning = true;
      try {
        const { freezeSequentialPast } = require('../services/campaignSequentialEnd.service');
        const { withJobLock } = require('../utils/jobLock');
        const r = await withJobLock('campaign_sequential_freeze', () => freezeSequentialPast());
        if (r && r.frozen) logger.info(`[CRON-SequentialFreeze:${by}] 공고 ${r.campaigns} · 고정 ${r.frozen}일 · 실패 ${r.failed || 0}`);
      } catch (err) {
        logger.error(`[CRON-SequentialFreeze:${by}] error: ${err.message}`);
      } finally { sfRunning = false; }
    };
    cron.schedule(process.env.CAMPAIGN_SEQUENTIAL_FREEZE_SCHEDULE || '5 0 * * *', () => { void runFreeze('cron'); }, { timezone: 'Asia/Seoul' });
    setTimeout(() => { void runFreeze('startup'); }, 60 * 1000).unref?.();
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

  // ── 리뷰 미작성 알림톡: 기본 OFF, KST 10~18시 매시 ──
  // 공급자 최종 성공(4000)만 회차로 세며, 3회 성공 뒤 final_due_at이 지나야 별도 상태로 종결한다.
  // 일일 상한은 서비스에서 다시 적용된다. 롤링배포 중복 실행은 advisory lock으로 막는다.
  if (process.env.REVIEW_REMINDER_ENABLED === '1') {
    const reminderSchedule = process.env.REVIEW_REMINDER_CRON_SCHEDULE || '0 10-18 * * *';
    cron.schedule(reminderSchedule, async () => {
      try {
        const { withJobLock } = require('../utils/jobLock');
        const { run } = require('../services/reviewReminder.service');
        const r = await withJobLock('review_reminder_alimtalk', () => run({ dryRun: false }));
        if (r && !r.skipped && ((r.sent || 0) > 0 || (r.closed || 0) > 0
            || (r.reconciled && ((r.reconciled.delivered || 0) > 0 || (r.reconciled.failed || 0) > 0)))) {
          logger.info(`[CRON-ReviewReminder] sent=${r.sent || 0} accepted=${r.accepted || 0} `
            + `delivered=${(r.reconciled && r.reconciled.delivered) || 0} failed=${r.failed || 0} closed=${r.closed || 0}`);
        }
      } catch (err) {
        logger.error(`[CRON-ReviewReminder] ${err.message}`);
      }
    }, { timezone: 'Asia/Seoul' });
  }

  logger.info(`[CRON] 스케줄러 등록 완료: 큐워커=30초(작업보드 반영), 자동복구=매시간, 정리=매일03시, 이상로그정리=매일03시30분, 홀드스윕=매분, 리뷰알림=${process.env.REVIEW_REMINDER_ENABLED === '1' ? 'ON' : 'OFF'}`);
}

module.exports = { startCronJobs };
