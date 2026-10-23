/**
 * ═══════════════════════════════════════════════════════════
 * Phase 2: Sync Queue Service
 *
 * 처음엔 Sheets API 쓰기 재시도 큐였다. 결정 274(2026-10-23) 이후 실행부는 **DB 안에서 끝나는
 * 작업보드 반영 타입(DB_ONLY_QUEUE_TYPES)뿐**이다 — 시트 시절 타입의 남은 행은 기록으로 둔다.
 * - enqueue()         : 작업을 큐에 등록
 * - processQueue()    : pending 작업을 꺼내서 처리 (30초마다 실행 · 즉시 펌프 공유)
 * - retryItem()       : 특정 실패 항목 수동 재시도(DB_ONLY 만)
 * - retryAllFailed()  : 매시 실패·정체 복구(DB_ONLY 만)
 * - purgeCompleted()  : 완료된 항목 정리
 * ═══════════════════════════════════════════════════════════
 */

const pool = require('../db/pool');
const { logger } = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
// ★★ 큐 타입 분류 — 단일 출처 (결정 271 → 결정 274 · 시트 시절 정리 마지막 단계)
//   DB_ONLY = 구글을 부르지 않고 DB 안에서 끝나는 타입. 무시트 구매(작업보드 반영)의 **라이브 경로**다.
//             30초 워커·즉시 펌프·주문별 드레인이 처리하는 **유일한** 타입이고, 매시 retryAllFailed 도 이것만 되살린다.
//   SHEET   = 구글시트에 쓰던 시트 시절 타입. ★ 결정 274(2026-10-23)로 **실행부를 지웠고 넣는 곳도 없다**.
//             운영 sync_queue 에 남은 이 타입의 행(pending·processing·failed)은 **기록으로 남긴다** —
//             어떤 워커도 집지 않고(클레임 SQL 이 DB_ONLY 만 고른다) 지우지도 않는다.
//             목록을 남겨 두는 이유 = "이 타입을 다시 넣는 곳이 생기지 않았나"를 가드가 이 목록으로 본다.
//   ★ `_executeItem` 의 모든 case 는 DB_ONLY 에 있어야 한다(tests/syncQueueSheetTypesGate.test.js).
//     새 타입을 만들면 여기 분류부터 한다 — 빠지면 워커가 그 타입을 영원히 집지 않는다.
//   (`ORDER_BATCH_AUTO` 는 더 이상 읽지 않는다 — 시트 타입을 집을 실행부가 없으므로 뜻이 없다.)
// ═══════════════════════════════════════════════════════════
const DB_ONLY_QUEUE_TYPES = Object.freeze(['workboard_apply', 'workboard_legacy_apply', 'deposit_mark']);
const SHEET_QUEUE_TYPES = Object.freeze([
  'order_append', 'order_update', 'order_cancel', 'review_submit',
  'sheet_write', 'sheet_append', 'participant_mirror',
]);

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
    // ★★ 결정 274: 이 워커가 집는 것은 **DB_ONLY 타입뿐**이다(시트 타입 실행부 삭제).
    //   시트 시절 잔여 행(pending order_append 등)은 손대지 않는다(구글 호출 0 · 행은 기록으로 보존).
    //   onlyType 이 DB_ONLY 가 아니면 아무것도 집지 않는다.
    if (onlyType && !DB_ONLY_QUEUE_TYPES.includes(onlyType)) {
      return { processed: 0, succeeded: 0, failed: 0, elapsed: 0 };
    }
    const claimTypes = onlyType ? [onlyType] : [...DB_ONLY_QUEUE_TYPES];
    const { rows: items } = await pool.query(
      `UPDATE sync_queue SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM sync_queue
           WHERE status = 'pending' AND attempts < max_retry
             AND type = ANY($2::text[])
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [batchSize, claimTypes]
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

        // 성공 → done (실행부가 사유를 돌려주면 남긴다)
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

// (탭 우선 드레인·배치 드레인 — 2026-10-22 제거 · 결정 273.)
// (시트 타입 실행부 — order_append·order_update·order_cancel·review_submit·sheet_write·sheet_append·participant_mirror case 와
//  그것만 쓰던 도우미 _guardBlockDecision·_markSystemMemo·_releaseOrderRowClaim·_mapOrderToRow·_reportOptionSuppressed·
//  _getColLetter·_setPStatus·SHEETLESS_SKIP_NOTE — 는 2026-10-23 제거 · 결정 274. 남은 시트 탭도 시트에 쓰지 않는다.)

// ── 개별 항목 실행 ──
async function _executeItem(item) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;

  switch (item.type) {
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

    default: {
      // ★ PR-B(R12): 롤링배포 중 old 인스턴스가 new가 enqueue한 신규 타입을 만나면 throw 대신 보류(defer).
      //   ★ 결정 274: 시트 시절 타입은 클레임 SQL 이 애초에 고르지 않는다 — 여기 오면(=호출부 실수) 보류로 되돌린다
      //     (실패로 접어 `failed` 를 만들지 않는다 · 시트를 부르지 않는다).
      const e = new Error(`미지원 큐 타입(보류): ${item.type}`);
      e.__defer = true;
      throw e;
    }
  }
}

// (큐 현황 getQueueStats · 실패 항목 삭제 deleteItem/deleteAllFailed — /api/diag/sync-queue* 전용 — 는 2026-10-22 제거 · 결정 273)

// ── 특정 항목 수동 재시도 ──
async function retryItem(id) {
  const { rows } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = NULL
     WHERE id = $1 AND status = 'failed'
       AND type = ANY($2::text[])
     RETURNING id, type, payload`,
    [id, [...DB_ONLY_QUEUE_TYPES]]
  );
  // ★ 결정 274: 시트 시절 타입은 실행부가 없다 — 되살려도 아무도 집지 않으므로 처음부터 거부한다(행은 기록 그대로).
  if (rows.length === 0) throw new Error(`id=${id}인 실패 항목을 찾을 수 없습니다(작업보드 반영 타입만 재시도 가능).`);
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

// ── 특정 주문(orderSubmissionId)의 pending 큐항목을 즉시 처리(FIFO 우회) ──
//   ★ 결정 274: DB_ONLY 타입(작업보드 반영)만 집는다 — 같은 주문의 시트 시절 잔여 행은 기록으로 남긴다.
//   자동화 테스트·운영 점검용. 동기 실행(항목 소수).
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
             AND type = ANY($2::text[])
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [String(orderSubmissionId), [...DB_ONLY_QUEUE_TYPES]]
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
  enqueue,
  processQueue,
  drainOrderQueue,
  retryItem,
  retryAllFailed,
  purgeCompleted,
};
