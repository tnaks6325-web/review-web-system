/**
 * ═══════════════════════════════════════════════════════════
 * Phase 2: Sync Queue Service
 *
 * Sheets API 쓰기 실패 시 자동 재시도를 위한 큐 시스템.
 * - enqueue()         : 실패한 작업을 큐에 등록
 * - processQueue()    : pending 작업을 꺼내서 처리 (30초마다 실행)
 * - getQueueStats()   : 큐 현황 통계 반환
 * - retryItem()       : 특정 항목 수동 재시도
 * - purgeCompleted()  : 완료된 항목 정리
 * ═══════════════════════════════════════════════════════════
 */

const pool = require('../db/pool');
const { writeSheet, appendSheet, readSheet, batchUpdateSheet, invalidateSheetMeta } = require('./sheets.service');
const { throttledCall } = require('../utils/sheetsThrottle');
const { recordParticipationLink } = require('./participation.service');
const {
  loadRawTabContext,
  buildBatchUpdateData,
  optionWriteColumns,
  filterOptionWritesBlankOnly,
  buildMirrorGuardRange,
  buildMirrorGuardRanges,
  guardBlocksWrite,
  markOrderWritten,
  markOrderMirrorFailed,
  recordReviewIdentity,
  mapOrderToSheetRow,
  _osRowToOrderData,
  _fieldToCol,
  unmappedSubmittedFields,
  rowIdentityMatches,
  computeRowWriteSig,
} = require('./orderLedger.service');
const { logger } = require('../utils/logger');
const { logAbnormal } = require('./errorLog.service');
// 비고/포스팅 열 고르기 — 제출 경로(submit.routes)·무시트 기록과 **같은 규칙**(사본 금지)
const { pickMemoColumnIndex, pickPostDateColumnIndex } = require('../utils/memoColumn');
const { mergeDepositStamps } = require('../utils/depositStamp');

// ═══════════════════════════════════════════════════════════
// ★★ 큐 타입 분류 — 단일 출처 (결정 271 · 시트 시절 정리 1단계)
//   DB_ONLY  = 구글을 부르지 않고 DB 안에서 끝나는 타입. 무시트 구매(작업보드 반영)의 **라이브 경로**다.
//              30초 워커·즉시 펌프는 언제나 이것을 처리하고, 매시 retryAllFailed 도 이것만 되살린다.
//   SHEET    = 구글시트에 쓰는 시트 시절 타입. 30초 워커·즉시 펌프는 `ORDER_BATCH_AUTO=1` 일 때만 집는다
//              (=오늘의 동작 그대로). 2단계에서 `ORDER_BATCH_AUTO` 를 끄면 이 타입의 남은 행
//              (pending order_append·processing order_update 등)은 **손대지 않고 기록으로 남는다**.
//   ★ `_executeItem` 의 모든 case 는 둘 중 하나에 있어야 한다(tests/syncQueueSheetTypesGate.test.js).
//     새 타입을 만들면 여기 분류부터 한다 — 빠지면 시트가 꺼진 뒤 그 타입이 영원히 대기한다.
// ═══════════════════════════════════════════════════════════
const DB_ONLY_QUEUE_TYPES = Object.freeze(['workboard_apply', 'workboard_legacy_apply', 'deposit_mark']);
const SHEET_QUEUE_TYPES = Object.freeze([
  'order_append', 'order_update', 'order_cancel', 'review_submit',
  'sheet_write', 'sheet_append', 'participant_mirror',
]);
/** 30초 워커·즉시 펌프가 시트 타입을 집는가 — 기존 `ORDER_BATCH_AUTO=1` 의미에 얹는다(새 스위치 없음). */
function sheetQueueTypesEnabled() {
  return process.env.ORDER_BATCH_AUTO === '1';
}

// ── 큐에 작업 추가 ──
async function enqueue(type, payload, maxRetry = 3) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO sync_queue (type, payload, status, max_retry)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id`,
      [type, JSON.stringify(payload), maxRetry]
    );
    logger.info(`[syncQueue] 등록: type=${type}, id=${rows[0].id}`);
    return rows[0].id;
  } catch (err) {
    logger.error(`[syncQueue] 등록 실패: ${err.message}`);
    throw err;
  }
}

async function markWorkboardQueueOrderState(item, queueStatus, err) {
  if (!item || !['workboard_apply', 'workboard_legacy_apply'].includes(item.type)) return;
  let payload = item.payload || {};
  try { if (typeof payload === 'string') payload = JSON.parse(payload); }
  catch (_) { return; }
  if (!payload.orderSubmissionId) return;
  await pool.query(
    `UPDATE order_submissions
        SET mirror_status = CASE WHEN $2 = 'failed' THEN 'failed' ELSE 'queued' END,
            sheet_error = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END, updated_at = NOW()
      WHERE id = $1 AND mirror_status <> 'written' AND deleted_at IS NULL`,
    [payload.orderSubmissionId, queueStatus, String((err && err.message) || err || '').slice(0, 500)]
  );
}

// ── 큐 처리 (pending → processing → done/failed) ──
async function processQueue(batchSize = 10, { interItemDelayMs = 2000, onlyType = null } = {}) {
  const startTime = Date.now();
  let processed = 0, succeeded = 0, failed = 0;
  let quotaExceeded = false;   // ★ R2: quota 에러로 배치 중단 시 true → 펌프(queuePump)가 보고 양보

  try {
    // ★ #2 큐 클레임 원자화: SELECT … FOR UPDATE SKIP LOCKED 로 batch를 한 번에 'processing'으로
    //   점유한다. 멀티워커/멀티인스턴스(또는 rolling 배포 중 old+new 공존)에서 두 워커가 같은
    //   pending 항목을 동시에 집어 이중 시트쓰기(중복행)·정체(processing stall)가 나던 경합을 차단.
    //   - 다른 워커가 이미 잠근 행은 SKIP LOCKED 로 건너뛴다(대기 없음).
    //   - attempts는 여기서 올리지 않는다(원본 시맨틱 유지: 항목별 실행 직전에 +1).
    // ★ 결정 273(2026-10-22): 상시 배치 스케줄러(order_append 전담)를 지웠다. AUTO=1 이면 이 단건 워커가
    //   order_append 까지 모든 타입을 집는다(배치 이전의 동작). AUTO 꺼짐(=운영)은 결정 271 그대로 작업보드 반영만.
    // ★★ 결정 271: 시트 타입은 ORDER_BATCH_AUTO=1 일 때만 집는다. 꺼지면 DB_ONLY(작업보드 반영)만 —
    //   시트 시절 잔여 행(pending order_append 등)은 손대지 않는다(구글 호출 0 · 행은 기록으로 보존).
    const sheetTypesOn = sheetQueueTypesEnabled();
    if (!sheetTypesOn && onlyType && !DB_ONLY_QUEUE_TYPES.includes(onlyType)) {
      return { processed: 0, succeeded: 0, failed: 0, elapsed: 0 };
    }
    const typeFilter = onlyType
      ? 'AND type = $2'
      : (!sheetTypesOn ? 'AND type = ANY($2::text[])' : '');
    const params = onlyType ? [batchSize, onlyType]
      : (!sheetTypesOn ? [batchSize, [...DB_ONLY_QUEUE_TYPES]] : [batchSize]);
    const { rows: items } = await pool.query(
      `UPDATE sync_queue SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM sync_queue
           WHERE status = 'pending' AND attempts < max_retry
             ${typeFilter}
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      params
    );

    if (items.length === 0) return { processed: 0, succeeded: 0, failed: 0, elapsed: 0 };

    logger.info(`[syncQueue] ${items.length}건 처리 시작`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      processed++;

      // ★ A1: Exponential backoff — Quota 에러 이력이 있으면 대기 시간 증가
      const baseDelay = 2000; // 기본 2초
      // 가속 드레인(interItemDelayMs===0): 모든 대기 제거(재시도 지수백오프 포함) — sheetsThrottle(45/분)이 쿼터 가드.
      //   백오프를 두면 한 라운드가 항목당 최대 30초씩 늘어 HTTP가 막힌다(평상시 cron은 기본 2000으로 보수적 유지).
      const backoffDelay = interItemDelayMs === 0
        ? 0
        : (item.attempts > 0
            ? Math.min(baseDelay * Math.pow(2, item.attempts), 30000) // 최대 30초
            : (i > 0 ? interItemDelayMs : 0)); // 첫 항목은 즉시, 이후 interItemDelayMs
      if (backoffDelay > 0) {
        await new Promise(r => setTimeout(r, backoffDelay));
      }

      // ★ #2: 이미 위 원자 클레임에서 'processing'으로 점유됨 → 여기선 시도횟수만 증가(원본 시맨틱 유지).
      await pool.query(
        `UPDATE sync_queue SET attempts = attempts + 1 WHERE id = $1`,
        [item.id]
      );

      try {
        const execOut = await _executeItem(item);

        // 성공 → done (무시트 백스톱으로 건너뛴 항목은 사유를 남긴다)
        await pool.query(
          `UPDATE sync_queue SET status = 'done', processed_at = NOW(), error_msg = $2 WHERE id = $1`,
          [item.id, (execOut && execOut.doneNote) || null]
        );
        succeeded++;
        logger.info(`[syncQueue] ✅ id=${item.id} type=${item.type} 완료`);

      } catch (err) {
        // ★ PR-B(R4/R12): execute가 보류(defer) 신호(err.__defer)를 던지면 done도 failed도 아닌 pending 복원.
        //   락 busy/old 인스턴스가 신규 큐타입 만남 → 실행 직전 +1한 attempts를 되돌려 다음 사이클 재처리.
        if (err && err.__defer) {
          await pool.query(
            `UPDATE sync_queue SET status='pending', attempts=GREATEST(attempts-1,0), processed_at=NOW() WHERE id=$1`,
            [item.id]
          );
          logger.debug(`[syncQueue] id=${item.id} 보류(defer) → pending 복원`);
          continue;
        }
        const newAttempts = (item.attempts || 0) + 1;
        const isQuotaError = err.message && (err.message.includes('Quota exceeded') || err.message.includes('429') || err.message.includes('RATE_LIMIT'));
        // quota 에러 시 재시도 기회 보존 (max_retry를 초과하지 않도록)
        const newStatus = (newAttempts >= item.max_retry && !isQuotaError) ? 'failed' : 'pending';

        await pool.query(
          `UPDATE sync_queue SET status = $1, error_msg = $2, processed_at = NOW() WHERE id = $3`,
          [newStatus, err.message.substring(0, 500), item.id]
        );
        await markWorkboardQueueOrderState(item, newStatus, err);

        if (newStatus === 'failed') {
          failed++;
          logger.error(`[syncQueue] ❌ id=${item.id} 최종 실패 (${newAttempts}회): ${err.message}`);
        } else {
          // ★ Quota 에러 시 남은 항목 스킵 (backoff 대기 후 다음 CRON 사이클에서 처리)
          if (isQuotaError) {
            // ★ #2: 원자 클레임으로 나머지 항목도 이미 'processing' 상태다. 이번 사이클에 손대지 않으므로
            //   다시 'pending'으로 되돌려 다음 큐워커 사이클(30초)이 집게 한다(processing stall 방지).
            const restIds = items.slice(i + 1).map(it => it.id);
            if (restIds.length) {
              try {
                await pool.query(
                  `UPDATE sync_queue SET status = 'pending' WHERE id = ANY($1::int[]) AND status = 'processing'`,
                  [restIds]
                );
              } catch (relErr) {
                logger.warn(`[syncQueue] quota 연기 중 나머지 ${restIds.length}건 pending 복원 실패(매시 retryAllFailed가 backstop): ${relErr.message}`);
              }
            }
            logger.warn(`[syncQueue] ⚠️ id=${item.id} Quota 에러 — 나머지 ${restIds.length}건 다음 사이클로 연기`);
            quotaExceeded = true;   // ★ R2: 펌프가 이 플래그 보고 중단 → 30초 cron 백오프에 양보
            break;
          }
          logger.warn(`[syncQueue] ⚠️ id=${item.id} 재시도 예정 (${newAttempts}/${item.max_retry}): ${err.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[syncQueue] 큐 처리 오류: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  if (processed > 0) {
    logger.info(`[syncQueue] 처리 완료: ${succeeded}/${processed} 성공, ${failed} 실패, ${elapsed}ms`);
  }

  return { processed, succeeded, failed, elapsed, quotaExceeded };
}

// (탭 우선 드레인 drainTabQueue · 배치 드레인 drainTabQueueBatched/_drainLoop/_executeBatch/_readGuardWindow —
//  관리자 order-flush-tab·order-batch-drain 과 상시 배치 스케줄러(orderBatchScheduler) 전용 — 는 2026-10-22 제거 · 결정 273.
//  시트 타입 큐는 ORDER_BATCH_AUTO=1 일 때 아래 단건 워커(processQueue)가 order_append 까지 함께 처리한다.)

// 무시트 백스톱으로 시트 쓰기를 생략한 큐 항목에 남기는 사유(done + 사유 — 무신호 금지)
const SHEETLESS_SKIP_NOTE = 'sheetless tab — 시트 쓰기 생략(작업표 기록 경로가 담당)';

// ── 개별 항목 실행 ──
async function _executeItem(item) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;

  switch (item.type) {
    case 'sheet_write': {
      // writeSheet(sheetId, range, values)
      const { sheetId, range, values } = payload;
      if (!sheetId || !range || !values) throw new Error('payload 누락: sheetId, range, values');
      await throttledCall(() => writeSheet(sheetId, range, values));
      break;
    }

    case 'sheet_append': {
      // appendSheet(sheetId, range, values)
      const { sheetId, range, values } = payload;
      if (!sheetId || !range || !values) throw new Error('payload 누락: sheetId, range, values');
      await throttledCall(() => appendSheet(sheetId, range, values));
      break;
    }

    case 'review_submit': {
      // ★ C1: 큐 재시도 시 항상 신선한 헤더를 읽음 (캐시된 헤더 사용 안 함)
      /* ★★ `memo` 를 반드시 함께 소비한다(2026-08 수리): 종전엔 payload 에 실려 오는 memo 를
         읽지도 쓰지도 않아 **시트 쓰기가 한 번 실패해 큐로 내려가면 비고/포스팅URL 이 영구 유실**됐다
         (제출열만 다시 써지고 memo 는 사라진다). 블로그체험단은 그 값이 곧 결과물이라 치명적이지만,
         리뷰체험단에서도 현행 버그였다. 열 고르기는 `utils/memoColumn` 단일 출처(제출 경로와 같은 규칙). */
      const { sheetId, tabName, rowIndex, submitCol, value, memo, blog, postDate } = payload;
      if (!sheetId || !tabName || !rowIndex) throw new Error('payload 누락');

      // 헤더 행을 최대 50행까지 읽어서 실제 헤더 위치 찾기
      const headerValues = await throttledCall(() => readSheet(sheetId, `'${tabName}'!1:50`));
      if (headerValues && headerValues.length > 0) {
        // 실제 헤더 행 탐색 (키워드 2개 이상 포함된 행)
        const HEADER_KEYWORDS = ['주문자', '수취인', '연락처', '주소', '은행', '계좌', '금액', '아이디', '인애드', '리뷰'];
        let headerRow = headerValues[0];
        for (const row of headerValues) {
          const matchCount = row.filter(c => HEADER_KEYWORDS.some(k => String(c || '').includes(k))).length;
          if (matchCount >= 2) { headerRow = row; break; }
        }
        const headers = headerRow.map(h => String(h || '').trim());
        const colIdx = headers.findIndex(h => h === submitCol);
        if (colIdx >= 0) {
          const colLetter = _getColLetter(colIdx);
          const range = `'${tabName}'!${colLetter}${rowIndex}`;
          await throttledCall(() => writeSheet(sheetId, range, [[value || '제출']]));
        } else {
          throw new Error(`submitCol '${submitCol}' 을 헤더에서 찾을 수 없음 (헤더: ${headers.slice(0, 10).join(',')})`);
        }

        // ── 비고/포스팅 컬럼 재기록(유실 방지) ──
        //   ★ 제출열 쓰기가 성공한 뒤에만 시도한다 — memo 실패로 항목이 재시도되면
        //     제출열은 멱등이라 안전하고, memo 만 다시 쓰인다.
        const memoText = String(memo == null ? '' : memo).trim();
        if (memoText) {
          const memoIdx = pickMemoColumnIndex(headers, { blog: blog === true });
          if (memoIdx >= 0) {
            const memoRange = `'${tabName}'!${_getColLetter(memoIdx)}${rowIndex}`;
            await throttledCall(() => writeSheet(sheetId, memoRange, [[memoText]]));
          } else {
            // 조용히 넘기지 않는다 — 그 탭에 비고/포스팅 열이 없다는 신호(담당자 조치 대상).
            logger.warn(`[queue:review_submit] 비고/포스팅 열 없음 tab=${tabName} row=${rowIndex}`);
          }
        }
        /* ★ 127: 포스팅제출일(blog 완료 시각) — 제출 시점에 계산된 날짜를 그대로 쓴다
           (재시도 시각으로 다시 만들면 실제 제출일과 어긋난다). 열 고르기 단일 출처 = memoColumn. */
        const postDateText = String(postDate == null ? '' : postDate).trim();
        if (postDateText) {
          const dateIdx = pickPostDateColumnIndex(headers);
          if (dateIdx >= 0) {
            const dateRange = `'${tabName}'!${_getColLetter(dateIdx)}${rowIndex}`;
            await throttledCall(() => writeSheet(sheetId, dateRange, [[postDateText]]));
          } else {
            logger.warn(`[queue:review_submit] 포스팅제출일 열 없음 tab=${tabName} row=${rowIndex}`);
          }
        }
      } else {
        throw new Error('헤더 행을 읽을 수 없음');
      }
      break;
    }

    case 'deposit_mark': {
      // 입금 기록은 서버 DB 작업보드만 사용한다. 이전 배포에서 남은 큐는
      // 구글시트에 쓰지 않고 정상 소진해 재시도 루프를 막는다.
      logger.info('[queue:deposit_mark] DB-only 입금 정책으로 구글시트 기록 건너뜀');
      break;
    }

    case 'workboard_apply': {
      // 새 통폐합 경로. legacy/미이관 대상이면 __defer로 pending을 유지해 기존 직접 경로와 섞지 않는다.
      await require('./workboardQueueApply.service').applyQueuedWorkboardOrder(payload);
      break;
    }

    case 'workboard_legacy_apply': {
      await require('./workboardQueueApply.service').applyLegacyRecoveryOrder(payload);
      break;
    }

    case 'order_append': {
      let { sheetId, tabName, orderData, loginPhone8, loginName, gid, sheetRow, orderSubmissionId, recovered, recoverReason, dedupKey } = payload;
      if (!sheetId || !tabName) throw new Error('payload 누락');
      /* ★★ 무시트 백스톱(탈 구글시트 W2 · fail-closed) — **시트를 읽거나 쓰기 전 마지막 방어**.
         제출·수동제출·복구 경로가 이미 큐를 안 태우지만, ① 이관 **전에** 쌓여 있던 큐 항목
         ② 앞으로 생길 새 호출부 ③ 판정 실패(fail-open)로 새어 들어온 건이 남아 있다.
         여기서 막지 않으면 **이관해 놓은 작업의 옛 시트에 주문이 다시 쓰인다**(장부와 갈라짐)
         — 가상 시트ID(wt_…)면 RAW 메타 조회가 자동 미러로 구글을 부르기도 한다.
         ★ 큐 항목은 버리지 않고 `done` + 사유 — 주문 자체는 무시트 기록 경로가 완결시킨다.
         ★ 결정 273: 이 방어는 배치 경로(_executeBatch)에 있었다. 배치 스케줄러를 지우며 order_append 를
           이 단건 경로가 맡게 됐으므로 같은 판정·같은 사유 문구로 옮겼다(완화 아님). */
      try {
        const { isSheetless } = require('../utils/sheetlessScope');
        if (await isSheetless(pool, sheetId, tabName)) {
          logger.warn(`[syncQueue] 무시트 탭 시트쓰기 차단 tab=${tabName} id=${item.id}`);
          return { doneNote: SHEETLESS_SKIP_NOTE };
        }
      } catch (_) { /* 판정 실패는 종전 경로(fail-open) — 제출 시점 게이트가 1차 방어 */ }
      if (!sheetRow) throw new Error('payload 누락: sheetRow');

      try {
        // ★ PR-A 가드 + J-1(B4): 취소/삭제된 주문은 시트쓰기 skip(큐 done — markFailed/throw 금지) +
        //   동시에 최신 필드를 재조회해 orderData를 교체한다. payload는 enqueue 시점 스냅샷이라,
        //   편집(order_update) 후 deferred append되는 주문은 이 재조회가 없으면 옛값으로 기록(편집 소실).
        let osMeta = null;
        if (orderSubmissionId) {
          const { rows: alive } = await pool.query(
            `SELECT deleted_at, mirror_status, orderer, recipient, user_id, phone, address, bank, account, depositor,
                    price, order_num, memo, date_str, selected_opt_key, submitted_at, reassign_count
               FROM order_submissions WHERE id = $1`,
            [orderSubmissionId]
          );
          // J3: written/stuck_manual(종결)도 skip — stale 재드레인이 written 주문을 release→failed 강등→중복행 방지.
          if (!alive.length || alive[0].deleted_at || alive[0].mirror_status === 'written' || alive[0].mirror_status === 'stuck_manual') {
            logger.info(`[order_append] 취소/삭제/이미반영·수동 주문 — 시트쓰기 건너뜀 (id=${orderSubmissionId})`);
            return;
          }
          osMeta = alive[0];
          orderData = _osRowToOrderData(alive[0]); // ★ J-1: stale 스냅샷 대체 = 편집값 반영
        }
        const tabContext = await loadRawTabContext(sheetId, gid, tabName);
        if (!tabContext || !tabContext.headers || tabContext.headers.length === 0) {
          throw new Error('RAW 미러 헤더 메타를 찾을 수 없음');
        }
        // ★ 재발방지(#1): 제출값이 있는데 넣을 열을 못 찾은 필드가 있으면 경고 — '쿠팡id'류 헤더 미인식이
        //   조용히 새지 않게 즉시 신호로 남긴다(쓰기는 계속: 매칭된 열만 기록). best-effort.
        try {
          const _unmapped = unmappedSubmittedFields(tabContext.headers, orderData);
          if (_unmapped.length) {
            logger.warn(`[order_append] ⚠️ 시트에 넣을 열 못 찾은 제출필드: ${_unmapped.join(',')} (tab=${tabContext.tabName || tabName}) — 헤더 확인 필요`);
            logAbnormal({
              flow: 'order_mirror', step: 'field_unmapped', severity: 'warn',
              error: new Error('제출 필드 미매핑: ' + _unmapped.join(',')),
              context: { sheetId, tabName: tabContext.tabName || tabName, gid: tabContext.tabGid || gid, unmapped: _unmapped, orderSubmissionId },
            });
          }
        } catch (_) { /* 관측용 — 실패해도 쓰기 진행 */ }
        // ★ D3a(#3): 다중컬럼 가드(연락처+주소+수취인) — 한 칸만 빈 수동입력행 덮어쓰기 방지.
        //   한 번의 행 읽기(min~max col)로 쿼터 1회 유지, 셀별 판정.
        //   D3b: 읽기 전 그리드 캐시 무효화 → append 행이 60s stale 그리드밖이라 빈배열([])로 오판되는 것 차단.
        const guards = buildMirrorGuardRanges({
          tabName: tabContext.tabName || tabName,
          headers: tabContext.headers,
          targetRow: parseInt(sheetRow, 10),
          orderData,
        });
        // ★ C′: 옵션 칸 blank-only 판정을 위해 **같은 사각형**에 옵션 열을 합류(콜 순증 0).
        const _optCols = optionWriteColumns(tabContext.headers);
        const _probeCols = [...new Set([...guards.map(g => g.col), ..._optCols])];
        let _optProbe = null;                    // null = 미확인 → 옵션 칸 쓰기 생략(fail-closed)
        if (_probeCols.length) {
          invalidateSheetMeta(sheetId);
          const minC = Math.min(..._probeCols), maxC = Math.max(..._probeCols);
          const rowRange = `'${tabContext.tabName || tabName}'!${_getColLetter(minC)}${sheetRow}:${_getColLetter(maxC)}${sheetRow}`;
          const read = await throttledCall(() =>
            readSheet(sheetId, rowRange, tabContext.tabGid ? { gid: tabContext.tabGid } : (gid ? { gid } : {}))
          );
          const cells = (read && read[0]) || [];
          // 그리드밖 행은 read=[] → cells[]=undefined → '' (빈칸=기입 허용). 단건/배치 시맨틱 동일.
          _optProbe = (col) => ({ known: true, value: String(cells[col - minC] || '') });
          // 내가 쓴 값이면(재시도 멱등) 통과, 어느 칸이든 외부/타 주문 값이면 덮어쓰기 차단
          const blocked = guards.some(g => guardBlocksWrite(String(cells[g.col - minC] || '').trim(), g));
          if (blocked) {
            // 버그1: 차단 = 배정행이 이미 타인 데이터로 채워짐. 복구분/grace경과 실시간건은 release(재배정),
            //   grace 미경과 실시간건은 defer(일시경합 오판 방지), reassign 상한 초과는 giveup(수동전환·무한루프 종결).
            // ★ 시트 변경 감지(이벤트 기반): 차단 신호로 그 시트만 자동 재미러+리컨실(60초 debounce, best-effort).
            try { require('./orderLedger.service').triggerSheetMirrorOnce(sheetId); } catch (_) {}
            const decision = _guardBlockDecision({
              recovered, submittedAt: osMeta && osMeta.submitted_at, reassignCount: osMeta && osMeta.reassign_count });
            if (decision === 'release') {
              // J2: 무조건 호출(내부 dedupKey/orderId 가드) → sheet_row NULL·failed로 reconcile이 하단 새 행 재배정.
              try { await _releaseOrderRowClaim({ sheetId, tabName: tabContext.tabName || tabName, dedupKey, orderId: orderSubmissionId, orderSubmissionId }); } catch (_) {}
              await pool.query(`UPDATE order_submissions SET reassign_count=COALESCE(reassign_count,0)+1 WHERE id=$1`, [orderSubmissionId]);
              return;   // 큐항목 done(성공경로) — reconcile이 새 행 재배정
            }
            if (decision === 'giveup') {
              await pool.query(`UPDATE order_submissions SET mirror_status='stuck_manual', sheet_error='guard blocked; exceeded max reassign — needs manual entry' WHERE id=$1 AND mirror_status<>'written'`, [orderSubmissionId]);
              return;   // 큐항목 done(수동입력 대상)
            }
            const e = new Error('target row occupied — defer (grace)'); e.__defer = true; throw e;  // defer: attempts 되돌림, failed 마킹 금지
          }
        }
        // 복구분(재배정 append)은 배경색 대신 비고란에 'system' 표기(수동입력분·실시간분과 구분).
        const _od = recovered ? { ...orderData, memo: _markSystemMemo(orderData && orderData.memo, recoverReason) } : orderData;
        const _bd = buildBatchUpdateData({
          tabName: tabContext.tabName || tabName,
          headers: tabContext.headers,
          targetRow: parseInt(sheetRow, 10),
          orderData: _od,
        });
        // ★ C′: 옵션 칸은 라이브 셀이 비어 있을 때만 기입(확인 불가 = 기입 생략).
        const _optFilt = filterOptionWritesBlankOnly({
          batchData: _bd, headers: tabContext.headers,
          tabName: tabContext.tabName || tabName, targetRow: parseInt(sheetRow, 10), probe: _optProbe,
        });
        const batchData = _optFilt.data;
        _reportOptionSuppressed(_optFilt.suppressed, {
          sheetId, tabName: tabContext.tabName || tabName,
          gid: tabContext.tabGid || gid, sheetRow, orderSubmissionId,
        });
        if (batchData.length > 0) {
          await throttledCall(() => batchUpdateSheet(
            sheetId,
            batchData,
            'RAW',
            tabContext.tabGid ? { gid: tabContext.tabGid } : (gid ? { gid } : {})
          ));
        }

        const { rows: codeRows } = await pool.query(
          `SELECT owner_reviewer_id AS "ownerReviewerId", participant_identity_id AS "participantIdentityId"
             FROM order_submissions WHERE id = $1`, [orderSubmissionId]
        );
        const codeIdentity = codeRows[0] || {};
        await recordParticipationLink({
          sheetId, tabName: tabContext.tabName || tabName, rowIndex: sheetRow,
          phone8: loginPhone8, phone: orderData && orderData.phone,
          name: loginName || (orderData && orderData.orderer),
          source: 'order_submit_queue',
          ownerReviewerId: codeIdentity.ownerReviewerId, participantIdentityId: codeIdentity.participantIdentityId,
        });
        await recordReviewIdentity({
          sheetId, tabName: tabContext.tabName || tabName, tabGid: tabContext.tabGid || gid,
          rowIndex: sheetRow,
          phone8: loginPhone8, phone: orderData && orderData.phone,
          name: loginName || (orderData && orderData.orderer),
          recipient: orderData && orderData.recipient,
        });
        let _sig = null; try { _sig = computeRowWriteSig(tabContext.headers, orderData); } catch (_) {}
        await markOrderWritten(orderSubmissionId, sheetRow, _sig);
      } catch (err) {
        // defer(grace 미경과 일시경합)는 주문을 'failed'로 강등하지 않는다(queued 유지 → 재시도/grace 후 release).
        if (!(err && err.__defer)) await markOrderMirrorFailed(orderSubmissionId, err);
        throw err;
      }
      break;
    }

    // ── PR-B: 주문 편집(in-place 시트반영). execute는 락-프리(claims가 동시성), 엔드포인트가 per-order 락. ──
    case 'order_update': {
      const { orderSubmissionId, editSeq, edits } = payload;
      if (!orderSubmissionId) throw new Error('payload 누락: orderSubmissionId');
      const { rows } = await pool.query(
        `SELECT deleted_at, last_edit_seq, sheet_row, tab_gid, gid, tab_name, sheet_id, mirror_status,
                orderer, recipient, user_id, phone, address, bank, account, depositor,
                price, order_num, memo, date_str, selected_opt_key
           FROM order_submissions WHERE id = $1`,
        [orderSubmissionId]
      );
      if (!rows.length || rows[0].deleted_at) return;                            // R7: 취소/삭제 → done-noop
      const os = rows[0];
      if (editSeq != null && Number(editSeq) < Number(os.last_edit_seq)) return; // R5: stale 편집 → done-noop
      // R10/J-1: 아직 시트반영 전(written 아님)이면 손대지 않음 — order_append이 B4(fresh DB값)로 최신 기록.
      if (os.mirror_status !== 'written' || !os.sheet_row) return;
      const tabContext = await loadRawTabContext(os.sheet_id, os.tab_gid || os.gid, os.tab_name);
      if (!tabContext || !tabContext.headers || !tabContext.headers.length) throw new Error('RAW 메타 없음'); // 재시도
      const fullRow = mapOrderToSheetRow(tabContext.headers, _osRowToOrderData(os)); // 최신 DB값(=newValue)
      const cols = (edits || []).map(e => _fieldToCol(tabContext.headers, e.field)).filter(c => c >= 0);
      if (!cols.length) { let _s=null; try{_s=computeRowWriteSig(tabContext.headers,_osRowToOrderData(os));}catch(_){} await markOrderWritten(orderSubmissionId, os.sheet_row, _s); break; }
      const minC = Math.min(...cols), maxC = Math.max(...cols);
      invalidateSheetMeta(os.sheet_id);
      const rowRange = `'${tabContext.tabName}'!${_getColLetter(minC)}${os.sheet_row}:${_getColLetter(maxC)}${os.sheet_row}`;
      const read = await throttledCall(() => readSheet(os.sheet_id, rowRange,
        tabContext.tabGid ? { gid: tabContext.tabGid } : {}));
      const cells = (read && read[0]) || [];
      const gridOutOfRange = !read || read.length === 0;                         // J-2: 그리드밖=빈읽기(사람 손 불가)
      const writeData = [];
      for (const e of (edits || [])) {
        const col = _fieldToCol(tabContext.headers, e.field); if (col < 0) continue;
        const wantNew = String(fullRow[col] == null ? '' : fullRow[col]).trim();
        const cur = gridOutOfRange ? '' : String(cells[col - minC] || '').trim();
        const wantOld = String(e.oldValue == null ? '' : e.oldValue).trim();
        if (cur === wantNew) continue;                                           // 멱등 no-op(R5 흡수)
        if (gridOutOfRange || cur === '' || cur === wantOld) {                    // 빈칸/내옛값/그리드밖 → 안전 쓰기
          writeData.push({ range: `'${tabContext.tabName}'!${_getColLetter(col)}${os.sheet_row}`, values: [[wantNew]] });
        } else {                                                                 // R3: 사람이 다른값 → 클로버 금지, 안전정지
          await pool.query(
            `UPDATE order_submissions SET mirror_status='conflict', sheet_error=$2 WHERE id=$1`,
            [orderSubmissionId, `cell conflict col=${col} cur=${cur.slice(0, 40)}`]
          );
          return;                                                                // R11: idx_os_attention로 가시화
        }
      }
      if (writeData.length) {
        await throttledCall(() => batchUpdateSheet(os.sheet_id, writeData, 'RAW',
          tabContext.tabGid ? { gid: tabContext.tabGid } : {}));
      }
      await pool.query(
        `UPDATE order_submissions SET last_edit_seq = GREATEST(last_edit_seq, $2) WHERE id = $1`,
        [orderSubmissionId, Number(editSeq) || 0]
      );
      { let _sig = null; try { _sig = computeRowWriteSig(tabContext.headers, _osRowToOrderData(os)); } catch (_) {}
        await markOrderWritten(orderSubmissionId, os.sheet_row, _sig); }
      break;
    }

    // ── PR-B: 주문 취소(소프트삭제 후 시트행 클리어). identity-match로 사람 재사용행 파괴 차단. ──
    case 'order_cancel': {
      const { orderSubmissionId } = payload;
      if (!orderSubmissionId) throw new Error('payload 누락: orderSubmissionId');
      const { rows } = await pool.query(
        `SELECT deleted_at, sheet_row, tab_gid, gid, tab_name, sheet_id, dedup_key,
                orderer, recipient, phone, address FROM order_submissions WHERE id = $1`,
        [orderSubmissionId]
      );
      if (!rows.length || !rows[0].deleted_at) return;                           // 취소 아님 → noop
      const os = rows[0];
      if (!os.sheet_row) return;                                                 // 시트 미반영 → 클리어 불필요
      // ★ 결정 271 백스톱: 무시트 좌표에는 비울 시트 행이 없다(취소 서비스는 이제 큐에 넣지 않는다 —
      //   배포 중 구버전이 넣은 것·사람이 retryItem 한 옛 실패분만 여기 온다). 성공했을 때와 같은 상태로 끝낸다.
      if (await require('../utils/sheetlessScope').isSheetlessOrderCoord(pool, {
        sheetId: os.sheet_id, tabName: os.tab_name, tabGid: os.tab_gid || os.gid,
      })) {
        await pool.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
        return;
      }
      const tabContext = await loadRawTabContext(os.sheet_id, os.tab_gid || os.gid, os.tab_name);
      if (!tabContext || !tabContext.headers || !tabContext.headers.length) throw new Error('RAW 메타 없음'); // 재시도
      // R1/J-2: identity-match(연락처+수취인+주소 AND). 그리드밖(빈읽기)=사람 손 불가 → 클리어 진행.
      const idy = await rowIdentityMatches(os, tabContext);
      if (!idy.match && !idy.gridOutOfRange) {
        await pool.query(`UPDATE order_submissions SET mirror_status='canceled_sheet_dirty' WHERE id=$1`, [orderSubmissionId]);
        return;                                                                  // R1: 사람 재사용행 → 클리어 금지(R11 가시화)
      }
      const _blankAll = buildBatchUpdateData({
        tabName: tabContext.tabName, headers: tabContext.headers,
        targetRow: parseInt(os.sheet_row, 10), orderData: {},                    // 매핑칸만 ''(입금칸·관리자칸은 매핑밖=보존)
      });
      // ★ C′: 옵션 칸은 관리자 작업지시(리뷰형태)일 수 있어 **취소로도 지우지 않는다**.
      const _cancelOptCols = new Set(optionWriteColumns(tabContext.headers)
        .map(c => `'${tabContext.tabName}'!${_getColLetter(c)}${parseInt(os.sheet_row, 10)}`));
      const blank = (process.env.ORDER_OPTION_BLANK_ONLY === '0')
        ? _blankAll : _blankAll.filter(u => !_cancelOptCols.has(u.range));
      if (blank.length) {
        await throttledCall(() => batchUpdateSheet(os.sheet_id, blank, 'RAW',
          tabContext.tabGid ? { gid: tabContext.tabGid } : {}));
      }
      // R13: claim 보존(_releaseOrderRowClaim 호출 안 함) → 빈 행 재점유 차단. mirror_status만 canceled.
      await pool.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
      break;
    }

    // ── Phase 2b: 참여자 로스터 → 시트 되쓰기(DB→시트 단방향). order_update/order_cancel 가드 이식. ──
    case 'participant_mirror': {
      if (process.env.PARTICIPANTS_SHEET_MIRROR !== '1') return;              // R9: 런타임 이중게이트(끄면 무동작·done)
      const { sheetId, tabName, ids } = payload;
      if (!sheetId || !tabName || !Array.isArray(ids) || !ids.length) return;
      const { _normSubmitCell, _wantMark } = require('./participantMirror.service');
      const { rowIdentityMatches, loadRawTabContext } = require('./orderLedger.service');
      const { getThrottleStatus } = require('../utils/sheetsThrottle');
      const BUSY = parseInt(process.env.PARTICIPANT_MIRROR_BUSY_THRESHOLD || '20', 10);

      const { rows: parts } = await pool.query(
        `SELECT id, seq, sheet_row, tab_gid, tab_name, sheet_id, phone8, recipient_name,
                is_submitted, is_paid, submit_col, submit_col2
           FROM campaign_participants
          WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
            AND source='import' AND sheet_row IS NOT NULL AND tab_gid IS NOT NULL`,
        [ids]);
      if (!parts.length) return;

      const tabContext = await loadRawTabContext(sheetId, parts[0].tab_gid, tabName);
      if (!tabContext || !tabContext.headers || !tabContext.headers.length) throw new Error('RAW 메타 없음'); // 재시도
      const headers = tabContext.headers;

      for (const p of parts) {
        // R6: throttle busy면 남은 참여자 양보(멱등이라 재큐 안전).
        if (getThrottleStatus().requestsInLastMinute > BUSY) {
          const e = new Error('throttle busy — 참여자 미러 양보'); e.__defer = true; throw e;
        }
        // R1: 저장 헤더명 정확일치만(라이브 재감지 금지 — 오감지 열 덮어쓰기 차단).
        const c1 = p.submit_col ? headers.indexOf(p.submit_col) : -1;
        const c2 = p.submit_col2 ? headers.indexOf(p.submit_col2) : -1;
        if (c1 < 0 && c2 < 0) { await _setPStatus(pool, p.id, 'no_col'); continue; }

        // R3: 신원 최소 2칸(연락처+수취인) 둘 다 유효해야 미러 허용(교차오염 방어).
        //   recipient_name NULL(구 import·미감지 탭)이면 phone 1칸으로 축소되어 위험 → 선차단(no_identity, 자가치유).
        if (!p.phone8 || !p.recipient_name) { await _setPStatus(pool, p.id, 'no_identity'); continue; }
        const osLike = { sheet_id: sheetId, sheet_row: p.sheet_row, tab_gid: p.tab_gid, tab_name: tabName,
                         phone: p.phone8, recipient: p.recipient_name, address: null };
        const idy = await rowIdentityMatches(osLike, tabContext);            // 1콜(사각형)
        if (!idy.match) { await _setPStatus(pool, p.id, 'identity_mismatch'); continue; } // 그리드밖도 미러 안 함

        // R2/R6: 제출·입금 셀을 한 사각형으로 읽어 가드(행당 1콜). 빈칸-only 쓰기.
        const cols = [c1, c2].filter(c => c >= 0);
        const minC = Math.min(...cols), maxC = Math.max(...cols);
        invalidateSheetMeta(sheetId);
        const rng = `'${tabName}'!${_getColLetter(minC)}${p.sheet_row}:${_getColLetter(maxC)}${p.sheet_row}`;
        const read = await throttledCall(() => readSheet(sheetId, rng, { gid: p.tab_gid }));
        const cells = (read && read[0]) || [];
        const writeData = [];
        let conflict = false;
        for (const [col, flag] of [[c1, p.is_submitted], [c2, p.is_paid]]) {
          if (col < 0) continue;
          const wantNew = _normSubmitCell(_wantMark(flag));
          const cur = _normSubmitCell(cells[col - minC]);
          if (cur === wantNew) continue;                                     // R5: 멱등 no-op
          if (cur === '') {                                                  // R2: 빈칸-only(보수)
            writeData.push({ range: `'${tabName}'!${_getColLetter(col)}${p.sheet_row}`, values: [[_wantMark(flag)]] });
          } else { conflict = true; }                                        // R3: 사람 손 → 클로버 금지
        }
        if (writeData.length) {
          await throttledCall(() => batchUpdateSheet(sheetId, writeData, 'RAW', { gid: p.tab_gid }));
        }
        const sig = `s=${_normSubmitCell(_wantMark(p.is_submitted))}|p=${_normSubmitCell(_wantMark(p.is_paid))}`;
        await pool.query(
          `UPDATE campaign_participants SET last_sheet_write_sig=$2, mirror_status=$3, updated_at=NOW() WHERE id=$1`,
          [p.id, sig, conflict ? 'conflict' : 'written']);
      }
      break;
    }

    default: {
      // ★ PR-B(R12): 롤링배포 중 old 인스턴스가 new가 enqueue한 신규 타입을 만나면 throw 대신 보류(defer).
      const e = new Error(`미지원 큐 타입(보류): ${item.type}`);
      e.__defer = true;
      throw e;
    }
  }
}

async function _setPStatus(pool, id, st) {
  await pool.query(`UPDATE campaign_participants SET mirror_status=$2, updated_at=NOW() WHERE id=$1`, [id, st]);
}

// (큐 현황 getQueueStats · 실패 항목 삭제 deleteItem/deleteAllFailed — /api/diag/sync-queue* 전용 — 는 2026-10-22 제거 · 결정 273)

// ── 특정 항목 수동 재시도 ──
async function retryItem(id) {
  const { rows } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = NULL
     WHERE id = $1 AND status = 'failed'
     RETURNING id, type, payload`,
    [id]
  );
  if (rows.length === 0) throw new Error(`id=${id}인 실패 항목을 찾을 수 없습니다.`);
  await markWorkboardQueueOrderState(rows[0], 'pending', null);
  return { id: rows[0].id, type: rows[0].type };
}

// ── 모든 실패 항목 재시도 ──
async function retryAllFailed() {
  // ★★ 결정 271: **DB_ONLY 타입(작업보드 반영)만** 되살린다 — 시트 타입은 매시 되살리지 않는다.
  //   종전엔 order_append·review_submit·sheet_* 실패분을 매시간 pending 으로 되돌려, 무시트 가상 시트ID
  //   (`wt_…`)로 구글을 다시 부르고 또 실패하는 일을 반복했다. 시트 타입 실패·정체 행은 그대로 기록으로 남긴다.
  //   (종전 PR-B(R6)의 order_update/order_cancel 제외는 이 허용목록에 자연히 포함된다 — 둘 다 시트 타입.)
  //   시트 타입 한 건을 꼭 다시 돌려야 하면 사람이 retryItem(id) 으로 한 줄씩 한다.
  const live = [...DB_ONLY_QUEUE_TYPES];
  // stuck된 processing 항목도 함께 리셋 (5분 이상 경과)
  const { rowCount: unstuck } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = 'reset: stuck processing'
     WHERE status = 'processing'
       AND (processed_at IS NULL OR processed_at < NOW() - INTERVAL '5 minutes')
       AND type = ANY($1::text[])`,
    [live]
  );
  if (unstuck > 0) {
    logger.info(`[syncQueue] ${unstuck}건 stuck processing 항목 리셋`);
  }

  // failed 상태 항목 재시도
  const { rowCount } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = NULL
     WHERE status = 'failed'
       AND type = ANY($1::text[])`,
    [live]
  );

  // pending이지만 attempts >= max_retry로 처리 불가능한 항목도 리셋
  const { rowCount: resetExhausted } = await pool.query(
    `UPDATE sync_queue
     SET attempts = 0, error_msg = NULL
     WHERE status = 'pending' AND attempts >= max_retry
       AND type = ANY($1::text[])`,
    [live]
  );
  if (resetExhausted > 0) {
    logger.info(`[syncQueue] ${resetExhausted}건 exhausted pending 항목 attempts 리셋`);
  }

  return { retried: rowCount, unstuck, resetExhausted };
}

// ── 완료된 항목 정리 (24시간 이상 경과) ──
async function purgeCompleted(hoursOld = 24) {
  const { rowCount } = await pool.query(
    `DELETE FROM sync_queue
     WHERE status = 'done' AND processed_at < NOW() - INTERVAL '${hoursOld} hours'`
  );
  logger.info(`[syncQueue] ${rowCount}건 완료 항목 정리 (${hoursOld}시간 이상 경과)`);
  return { purged: rowCount };
}

// ── 가드 차단 행동 결정(버그1): defer(유예)/release(재배정)/giveup(수동전환·상한) ──
//   유예는 배치공유 attempts가 아니라 "주문 단위 시각(submitted_at)"으로 판정(R6: 방금 제출한 실시간 주문의
//   일시 write 경합을 영구소실로 오판하지 않음).
//   ★ 기본 ON: 가드는 남의 데이터를 절대 덮지 않고(차선책) 하단 빈 행 재배정으로 폴백 = 손실 0·수동 0.
//     끄려면 ORDER_GUARD_REASSIGN=0 (OFF: 비복구는 defer만 = 재배정 안 함, 복구분만 release — 순수 R1/R3 픽스).
// 복구(재배정 append) 행 표식: 배경색 대신 비고란에 표기(수동입력분·실시간분과 구분).
//   · 일반 복구(큐 지연·행배정 실패 등) → [시스템 재기록]
//   · 소실 복구(사후검증이 "기록했던 행이 사라졌다"고 판정한 사고 건) → [시스템 재기록 · 확인요망]
//     사고 건은 원래 자리가 아닌 하단에 다시 적히므로 사람이 한 번 확인해야 한다.
//   기존 메모가 있으면 보존하며 마커만 덧붙임(비파괴). 이미 표기돼 있으면 중복 안 함(재시도 멱등).
//   구 표기('system')만 있는 행이 뒤늦게 소실 판정을 받으면 확인요망으로 승격한다.
const MEMO_SYS = '[시스템 재기록]';
const MEMO_LOST = '[시스템 재기록 · 확인요망]';
function _markSystemMemo(memo, reason) {
  const s = String(memo == null ? '' : memo).trim();
  if (reason === 'lost') {
    if (/확인요망/.test(s)) return s;                                   // 이미 표기됨(멱등)
    const base = s.replace(/\[시스템 재기록\]/g, '')
                  .replace(/\[system\]/ig, '')
                  .replace(/^system$/i, '')
                  .trim();                                              // 약한/구 표기는 승격 대상
    return base ? `${base} ${MEMO_LOST}` : MEMO_LOST;
  }
  if (/시스템 재기록|\bsystem\b/i.test(s)) return s;                    // 이미 표기됨(멱등)
  return s ? `${s} ${MEMO_SYS}` : MEMO_SYS;
}

function _guardBlockDecision({ recovered, submittedAt, reassignCount } = {}) {
  const gateOn = process.env.ORDER_GUARD_REASSIGN !== '0';
  const maxReassign = parseInt(process.env.ORDER_MAX_REASSIGN || '5', 10);
  const rc = parseInt(reassignCount, 10) || 0;
  if (gateOn && rc >= maxReassign) return 'giveup';    // R2: 무한 append 종결(수동전환)
  if (recovered) return 'release';                     // 복구분 — 항상 done경로 release(순수 R1/R3 픽스)
  if (!gateOn) return 'defer';                         // 게이트 OFF → 비복구는 현행(release 안 함)
  const graceSec = parseInt(process.env.ORDER_BLOCK_GRACE_SEC || '90', 10);
  const t = submittedAt ? new Date(submittedAt).getTime() : NaN;
  const ageMs = Number.isFinite(t) ? (Date.now() - t) : Infinity;
  return ageMs >= graceSec * 1000 ? 'release' : 'defer';  // grace 경과 후에만 release(일시경합 오판 방지)
}

// ── 헬퍼: 복구 append가 가드에 막히면 claim 해제 → 다음 리컨실이 더 아래 새 행 재배정 ──
async function _releaseOrderRowClaim({ sheetId, tabName, dedupKey, orderSubmissionId, orderId = null, skipFail = false }) {
  try {
    if (sheetId && tabName && dedupKey) {
      // ★ PR-A(#1): orderId가 주어지면 그 주문이 보유한 claim만 삭제(엉뚱한 주문의 claim 삭제 차단).
      //   orderId 없으면(기존 호출부) dedup_key 기준 삭제로 하위호환.
      await pool.query(
        `DELETE FROM sheet_row_claims
          WHERE sheet_id = $1 AND tab_name = $2 AND dedup_key = $3
            AND ($4::uuid IS NULL OR order_id = $4)`,
        [sheetId, tabName, dedupKey, orderId]
      );
    }
  } catch (e) {
    logger.warn(`[order_append] claim 해제 실패(무시): ${e.message}`);
  }
  // ★ PR-A: skipFail=true면 order_submissions를 'failed'로 마킹하지 않는다(취소(order_cancel) 경로용 — 취소건을 failed로 되돌려 부활시키지 않게).
  if (orderSubmissionId && !skipFail) {
    try {
      await pool.query(
        `UPDATE order_submissions
            SET sheet_row = NULL, mirror_status = 'failed',
                sheet_error = 'append row occupied — claim released for re-assignment'
          WHERE id = $1 AND mirror_status <> 'written'`,
        [orderSubmissionId]
      );
    } catch (e) {
      logger.warn(`[order_append] claim 해제 후 상태갱신 실패(무시): ${e.message}`);
    }
  }
}

// ── 헬퍼: 열 인덱스 → 알파벳 ──
function _getColLetter(colIdx) {
  let letter = '';
  let idx = colIdx;
  while (idx >= 0) {
    letter = String.fromCharCode((idx % 26) + 65) + letter;
    idx = Math.floor(idx / 26) - 1;
  }
  return letter;
}

// ★ C′ 관측: "빈 칸이라 그냥 썼다"·"선택 없음"은 무음. 리뷰어가 고른 값이 있는데 셀에
//   다른 값이 있어 못 쓴 경우(=사람이 봐야 하는 케이스)만 warn. reviewer_event_logs 미사용(도배 방지).
function _reportOptionSuppressed(list, ctx) {
  try {
    for (const s of (list || [])) {
      if (s.reason === 'unverified') {
        logger.warn(`[order_append] 옵션칸 라이브 확인 불가 → 기입 생략(보수적) col=${s.col} os=${ctx.orderSubmissionId}`);
        continue;
      }
      if (!s.want || s.want === s.cur) continue;              // 선택 없음 = 정상(로스터 값 보존)
      logger.warn(`[order_append] ⚠️ 옵션칸 기존값 보존 — 기입 생략: col=${s.col} 기존="${s.cur}" 선택="${s.want}" row=${ctx.sheetRow} os=${ctx.orderSubmissionId}`);
      logAbnormal({
        flow: 'order_mirror', step: 'option_cell_occupied', severity: 'warn',
        error: new Error(`option cell occupied: "${s.cur}" != "${s.want}"`),
        context: { ...ctx, col: s.col },
      });
    }
  } catch (_) { /* 관측 실패가 쓰기를 막지 않는다 */ }
}

// ── 헬퍼: 주문 데이터를 헤더에 맞게 매핑 ──
function _mapOrderToRow(headers, orderData) {
  // ★ 관리자 전용 열: 절대 덮어쓰면 안 되는 키워드 목록
  const ADMIN_ONLY_KEYWORDS = ['번호', 'no', '#', '인애드', '카톡', '닉네임', '상품', '상품명'];
  // 옵션 키를 파이프로 분리
  const optParts = (orderData.selectedOptKey || '').split('|').map(v => v.trim());
  let optColCounter = 0;

  return headers.map(h => {
    const key = h.toLowerCase().trim();
    // ★ 관리자 전용 열 보호
    if (ADMIN_ONLY_KEYWORDS.some(kw => key === kw)) return null;
    if (key.includes('인애드')) return null;
    if (key.includes('주문자') || key.includes('orderer')) return orderData.orderer || '';
    if (key.includes('수취인') || key.includes('이름') || key.includes('recipient')) return orderData.recipient || '';
    if (key.includes('아이디') || key.includes('userid') || key.includes('id')) return orderData.userId || '';
    if (key.includes('전화') || key.includes('연락') || key.includes('phone')) return orderData.phone || '';
    if (key.includes('주소') || key.includes('address')) return orderData.address || '';
    if (key.includes('은행') || key.includes('bank')) return orderData.bank || '';
    if (key.includes('계좌') || key.includes('account')) return orderData.account || '';
    if (key.includes('예금주') || key.includes('depositor')) return orderData.depositor || '';
    if (key.includes('금액') || key.includes('price')) return orderData.price || '';
    if (key.includes('일자') || key.includes('날짜') || key.includes('date')) return orderData.dateStr || '';
    if (key.includes('주문번호') || key.includes('ordernum')) return orderData.orderNum || '';
    if (key.includes('비고') || key.includes('특이사항') || key.includes('memo')) return orderData.memo || '';
    if (key.includes('옵션') || key.includes('option')) {
      const val = optParts[optColCounter] || '';
      optColCounter++;
      return val;
    }
    // ★ 매칭되지 않는 열은 null → 기존 값 보존
    return null;
  });
}

// ── 특정 주문(orderSubmissionId)의 pending 큐항목을 즉시 처리(FIFO 우회) ──
//   order_append/order_update/order_cancel은 payload에 orderSubmissionId가 있다(tabName은 update/cancel엔 없음).
//   글로벌 큐가 백로그면 편집/취소가 FIFO 뒤로 밀리는데, 이 함수로 그 주문의 항목만 골라 즉시 반영한다.
//   sheetsThrottle(45/분)이 쿼터 가드. 관리자 "이 주문 즉시 반영" + 자동화 테스트용. 동기 실행(항목 소수).
async function drainOrderQueue(orderSubmissionId, { maxItems = 5 } = {}) {
  if (!orderSubmissionId) throw new Error('drainOrderQueue: orderSubmissionId 필수');
  let processed = 0, succeeded = 0, failed = 0;
  for (let n = 0; n < maxItems; n++) {
    const { rows: items } = await pool.query(
      `UPDATE sync_queue SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM sync_queue
           WHERE status = 'pending' AND attempts < max_retry
             AND (payload->>'orderSubmissionId') = $1
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [String(orderSubmissionId)]
    );
    if (!items.length) break;
    const item = items[0];
    processed++;
    await pool.query(`UPDATE sync_queue SET attempts = attempts + 1 WHERE id = $1`, [item.id]);
    try {
      const execOut = await _executeItem(item);
      await pool.query(`UPDATE sync_queue SET status = 'done', processed_at = NOW(), error_msg = $2 WHERE id = $1`,
        [item.id, (execOut && execOut.doneNote) || null]);
      succeeded++;
    } catch (err) {
      if (err && err.__defer) {
        await pool.query(`UPDATE sync_queue SET status='pending', attempts=GREATEST(attempts-1,0), processed_at=NOW() WHERE id=$1`, [item.id]);
        break;
      }
      const newAttempts = (item.attempts || 0) + 1;
      const isQuotaError = err.message && (err.message.includes('Quota exceeded') || err.message.includes('429') || err.message.includes('RATE_LIMIT'));
      const newStatus = (newAttempts >= item.max_retry && !isQuotaError) ? 'failed' : 'pending';
      await pool.query(`UPDATE sync_queue SET status = $1, error_msg = $2, processed_at = NOW() WHERE id = $3`,
        [newStatus, String(err.message || '').substring(0, 500), item.id]);
      await markWorkboardQueueOrderState(item, newStatus, err);
      failed++;
      if (isQuotaError) break;
    }
  }
  return { processed, succeeded, failed };
}

module.exports = {
  DB_ONLY_QUEUE_TYPES,
  SHEET_QUEUE_TYPES,
  sheetQueueTypesEnabled,
  enqueue,
  processQueue,
  drainOrderQueue,
  _guardBlockDecision, // 테스트용(defer/release/giveup 진리표)
  _markSystemMemo,     // 테스트용(복구행 비고 'system' 표기)
  retryItem,
  retryAllFailed,
  purgeCompleted,
};
