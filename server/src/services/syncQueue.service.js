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
    // ★ 제안A: ORDER_BATCH_AUTO=1이면 order_append는 상시 배치 스케줄러 전담(단건 2콜/건 금지).
    //   30초 cron의 단건 order_append가 throttle 45/분을 최대 40콜/분 잠식하던 것을 제거 →
    //   배치(라운드당 2콜)로 단일화해 쿼터 효율 극대화. review/deposit 등 다른 타입은 계속 처리(손실0).
    //   AUTO 끄면 즉시 단건 cron이 order_append 흡수(되돌리기). 큐 백스톱은 15초 배치 cron이 담당.
    //   ★ F3 백스톱(심판 D4b): onlyType='order_append' 면 skipOrderAppend를 무시하고 그 타입만 처리.
    //     배치 heartbeat가 끊긴 비상시에만 cron이 소량(5건) 단건으로 호출 → 영구 미반영 방지.
    const skipOrderAppend = process.env.ORDER_BATCH_AUTO === '1' && !onlyType;
    const { rows: items } = await pool.query(
      `UPDATE sync_queue SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM sync_queue
           WHERE status = 'pending' AND attempts < max_retry
             ${onlyType ? 'AND type = $2' : (skipOrderAppend ? "AND type <> 'order_append'" : '')}
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      onlyType ? [batchSize, onlyType] : [batchSize]
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
        await _executeItem(item);

        // 성공 → done
        await pool.query(
          `UPDATE sync_queue SET status = 'done', processed_at = NOW(), error_msg = NULL WHERE id = $1`,
          [item.id]
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

// ── 특정 탭만 우선 드레인(FIFO 우회) ──
//   글로벌 큐는 created_at FIFO라 최근 탭이 뒤로 밀린다. 이 함수는 payload의 sheetId+tabName이
//   일치하는 order_append만 골라 즉시 처리(대기 0, sheetsThrottle이 쿼터 가드). 관리자 "탭 우선 반영"용.
async function drainTabQueue({ sheetId, tabName, maxMillis = 30000, batchSize = 20 } = {}) {
  if (!sheetId || !tabName) throw new Error('drainTabQueue: sheetId, tabName 필수');
  const start = Date.now();
  let processed = 0, succeeded = 0, failed = 0;
  while (Date.now() - start < maxMillis) {
    // ★ #2: 글로벌 큐워커와 동시에 돌아도 같은 항목을 이중처리하지 않도록 원자 클레임(SKIP LOCKED).
    //   (탭 우선 flush가 글로벌 워커와 경합해 stall 나던 직접 원인 제거.)
    const { rows: items } = await pool.query(
      `UPDATE sync_queue SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM sync_queue
           WHERE status = 'pending' AND attempts < max_retry AND type = 'order_append'
             AND payload->>'sheetId' = $1 AND payload->>'tabName' = $2
           ORDER BY created_at ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [sheetId, tabName, batchSize]
    );
    if (!items.length) break;
    for (const item of items) {
      processed++;
      await pool.query(`UPDATE sync_queue SET attempts = attempts + 1 WHERE id = $1`, [item.id]);
      try {
        await _executeItem(item);
        await pool.query(`UPDATE sync_queue SET status = 'done', processed_at = NOW(), error_msg = NULL WHERE id = $1`, [item.id]);
        succeeded++;
      } catch (err) {
        if (err && err.__defer) {
          await pool.query(`UPDATE sync_queue SET status='pending', attempts=GREATEST(attempts-1,0), processed_at=NOW() WHERE id=$1`, [item.id]);
          continue;
        }
        const newAttempts = (item.attempts || 0) + 1;
        const newStatus = newAttempts >= item.max_retry ? 'failed' : 'pending';
        await pool.query(`UPDATE sync_queue SET status = $1, error_msg = $2, processed_at = NOW() WHERE id = $3`,
          [newStatus, String(err.message || '').substring(0, 500), item.id]);
        failed++;
      }
    }
  }
  return { processed, succeeded, failed, elapsedMs: Date.now() - start };
}

// ═══════════════════════════════════════════════════════════
// ★ 배치 드레인 (버스트 전용) — 한 탭 order_append를 가드 1콜 + write 1콜(청크당)로 반영.
//   라이브 핫패스. 레드-블루-심판 적대검증 통과(R-B1~B10 방어). ORDER_BATCH_DRAIN=1 일 때만 활성.
// ═══════════════════════════════════════════════════════════
const BATCH_ROW_CAP = parseInt(process.env.ORDER_BATCH_ROW_CAP || '50', 10); // R-B9: 1콜당 행 상한
// R-1b: 락분리(AUTO=1) 시 단건 백스톱과 배치가 같은 항목을 동시에 잡지 않도록 재점유 임계를 충분히 키운다(단건 throttle 대기 상한 초과).
const STALE_PROCESSING_SEC = parseInt(process.env.ORDER_BATCH_STALE_PROCESSING_SEC || '60', 10); // 정체 processing 재점유 임계

function _isQuota(err) {
  if (!err) return false;
  const m = String(err.message || '');
  const status = err.code || err.status || (err.response && err.response.status);
  return status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED|429/i.test(m);
}

async function _restorePending(items) {
  const ids = (items || []).map(it => it.id);
  if (ids.length) {
    await pool.query(
      `UPDATE sync_queue SET status='pending', processed_at=NOW() WHERE id = ANY($1::int[]) AND status='processing'`,
      [ids]
    );
  }
}

// ★ R-B3: values.batchGet 금지. readSheet(GID모드 _readSheetByGridData) 단일 사각형 1콜.
//   여러 targetRow를 minRow:maxRow × minCol:maxCol 한 사각형으로 읽고 행→cells 맵 반환.
//   그리드밖 행 = 사각형이 []거나 짧은 배열 → 없는 행은 [] = 빈칸 통과(단건경로 시맨틱 동일).
//   minCol/maxCol/cols 는 0-based(buildMirrorGuardRanges의 g.col, _getColLetter 와 동일).
async function _readGuardWindow(sheetId, tabName, gid, rows, minCol, maxCol, _reader) {
  const nums = [...new Set(rows.map(r => parseInt(r, 10)).filter(n => Number.isInteger(n) && n > 0))];
  if (!nums.length) return new Map();
  const minRow = Math.min(...nums), maxRow = Math.max(...nums);
  const range = `'${tabName}'!${_getColLetter(minCol)}${minRow}:${_getColLetter(maxCol)}${maxRow}`;
  // _reader: 테스트 주입용(없으면 실제 throttled readSheet). 반환은 행배열의 배열(grid).
  const read = _reader || ((rng, opts) => throttledCall(() => readSheet(sheetId, rng, opts)));
  const grid = await read(range, gid ? { gid } : {});
  const map = new Map();
  for (const r of nums) {
    const off = r - minRow;
    map.set(r, (grid && grid[off]) || []); // 없으면 [] = guardBlocksWrite false(통과)
  }
  return map;
}

// 한 탭의 pending order_append를 묶어 가드 1콜 + write 1콜(청크당)으로 반영.
// ★ R-B1: queue_pump_drain + order_reconcile 두 락 중첩 → 펌프·가속드레인·reconcile 모두와 직렬화.
async function drainTabQueueBatched({ sheetId, tabName, maxMillis = 60000, batchSize = BATCH_ROW_CAP, runReconcileFirst = true, oneChunk = false } = {}) {
  if (!sheetId || !tabName) throw new Error('drainTabQueueBatched: sheetId, tabName 필수');
  if (process.env.ORDER_BATCH_DRAIN !== '1') {                  // R-B10: 플래그 게이트(되돌리기)
    return drainTabQueue({ sheetId, tabName, maxMillis });      // 미설정 시 검증된 단건 경로
  }
  const { withJobLock } = require('../utils/jobLock');

  // ── F1(심판 D1): AUTO=1일 때만 락 분리(정체 직접원인 제거). AUTO=0이면 기존 2중락 유지(R-J1: 펌프 공존 안전). ──
  const lockSplit = process.env.ORDER_BATCH_AUTO === '1';
  if (!lockSplit) {
    // 락 중첩: 바깥 queue_pump_drain(펌프/가속드레인 배제) → 안 order_reconcile(reconcile 배제).
    return withJobLock('queue_pump_drain', async () => {
      return withJobLock('order_reconcile', async () => {
        // ★ R-B5 완화: 배치는 큐만 드레인 → 행 미배정 주문(pending_no_row)은 큐에 없다.
        //   같은 락 안에서 reconcile 먼저 돌려 행배정+enqueue → 그 큐를 곧바로 빼낸다.
        if (runReconcileFirst) {
          try {
            const { reconcileStuckOrders } = require('./orderLedger.service');
            await reconcileStuckOrders({ sheetId, tabName, limit: 1000, perTabCap: 1000 });
          } catch (e) { logger.warn(`[batchDrain] reconcile 선행 실패(무시): ${e.message}`); }
        }
        return _drainLoop({ sheetId, tabName, maxMillis, batchSize });
      }, { onBusy: () => ({ skipped: true, reason: 'order_reconcile_lock_busy' }) });
    }, { onBusy: () => ({ skipped: true, reason: 'queue_pump_drain_lock_busy' }) });
  }

  // ── AUTO=1: (1) reconcile만 짧은 단독락(DB-only + maxRow 라이브 탭당1콜). 락 busy면 양보(이미 다른 경로가 reconcile 중). ──
  if (runReconcileFirst) {
    await withJobLock('order_reconcile', async () => {
      try {
        const { reconcileStuckOrders } = require('./orderLedger.service');
        return await reconcileStuckOrders({ sheetId, tabName, limit: 300, perTabCap: 60, useLiveMaxRow: true });
      } catch (e) { logger.warn(`[batchDrain] reconcile 선행 실패(무시): ${e.message}`); return null; }
    }, { onBusy: () => ({ skipped: true, reason: 'order_reconcile_lock_busy' }) });
    // 락 busy여도 큐 드레인은 계속(이미 행배정된 항목 빼냄).
  }
  // ── (2) 큐 드레인: 락 밖. SKIP LOCKED + STALE(60s) 재점유가 이중처리 차단(R-1b 조건부 written이 안전 흡수). ──
  return _drainLoop({ sheetId, tabName, maxMillis, batchSize, oneChunk });
}

// 드레인 루프(락 안/밖 공용). 한 탭 order_append를 청크 배치(가드1콜+쓰기1콜)로 반영.
// oneChunk=true(인터리브): 1 batch만 처리하고 반환(점유시간 최소·공평 양보). emptied=클레임 0행(이번 라운드 비움 — 완료 단정 아님).
async function _drainLoop({ sheetId, tabName, maxMillis, batchSize, oneChunk = false }) {
  const start = Date.now();
  let processed = 0, succeeded = 0, failed = 0, deferred = 0, quotaExceeded = false, emptied = false;
  // ★ 버그1(R3): 이번 드레인콜에서 defer된 항목은 재클레임 제외(옛 stale sheetRow 재읽기·throttle 낭비·busy-spin 차단).
  const skipIds = [];
  while (Date.now() - start < maxMillis) {
    // R-B8: 단건과 동일 클레임 조건(type='order_append') → 같은 항목은 한쪽만 점유(SKIP LOCKED).
    const { rows: items } = await pool.query(
      // ★ 버스트/백로그 대응: pending뿐 아니라 "정체된 processing"도 재점유.
      //   STALE_PROCESSING_SEC(기본 60s) 넘은 processing은 재점유한다(R-1b: 단건 백스톱과 겹쳐도
      //   조건부 written이 이중쓰기를 멱등 흡수).
      //   ★ ($5 IS NULL OR id <> ALL($5)) 선행 필수: id<>ALL(NULL)은 NULL이라 전건 제외되므로 skipIds 없을 땐 NULL 전달.
      `UPDATE sync_queue SET status='processing', processed_at=NOW()
        WHERE id IN (SELECT id FROM sync_queue
           WHERE attempts<max_retry AND type='order_append'
             AND payload->>'sheetId'=$1 AND payload->>'tabName'=$2
             AND ($5::int[] IS NULL OR id <> ALL($5::int[]))
             AND (status='pending'
                  OR (status='processing' AND processed_at < NOW() - ($4 || ' seconds')::interval))
           ORDER BY created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [sheetId, tabName, batchSize, String(STALE_PROCESSING_SEC), skipIds.length ? skipIds : null]
    );
    if (!items.length) { emptied = true; break; }           // 빈 큐 = 이번 라운드 비움(완료 신호 아님)
    const r = await _executeBatch(items, sheetId, tabName);
    processed += r.processed; succeeded += r.succeeded; failed += r.failed; deferred += r.deferred;
    if (Array.isArray(r.deferredIds)) for (const id of r.deferredIds) if (!skipIds.includes(id)) skipIds.push(id);
    if (r.quotaExceeded) { quotaExceeded = true; break; }   // R-B9: quota → 양보(락 해제)
    if (oneChunk) break;                                     // R2/R5: 1청크만 → 점유시간 최소·공평 양보
  }
  return { processed, succeeded, failed, deferred, quotaExceeded, emptied, elapsedMs: Date.now() - start };
}

async function _executeBatch(items, sheetId, tabName) {
  let succeeded = 0, failed = 0, deferred = 0, quotaExceeded = false;
  const deferredIds = [];   // 버그1(R3): 같은 드레인콜서 재클레임 제외할 defer 항목(스핀/throttle 낭비 차단)

  /* ★★ 무시트 백스톱(탈 구글시트 W2 · fail-closed) — **쓰기 직전 마지막 방어**.
     제출·수동제출·복구 경로가 이미 큐를 안 태우지만, ① 이관 **전에** 쌓여 있던 큐 항목
     ② 앞으로 생길 새 호출부 ③ 판정 실패(fail-open)로 새어 들어온 건이 남아 있다.
     여기서 막지 않으면 **이관해 놓은 작업의 옛 시트에 주문이 다시 쓰인다**(장부와 갈라짐).
     ★ 큐 항목은 버리지 않고 `done` + 사유 — 주문 자체는 무시트 기록 경로가 완결시킨다. */
  try {
    const { isSheetless } = require('../utils/sheetlessScope');
    if (await isSheetless(pool, sheetId, tabName)) {
      await pool.query(
        `UPDATE sync_queue SET status='done', error_msg='sheetless tab — 시트 쓰기 생략(작업표 기록 경로가 담당)',
                processed_at=NOW() WHERE id = ANY($1::int[])`, [items.map(it => it.id)]);
      logger.warn(`[syncQueue] 무시트 탭 시트쓰기 차단 tab=${tabName} items=${items.length}`);
      return { processed: items.length, succeeded: 0, failed: 0, deferred: items.length, quotaExceeded: false, deferredIds: [] };
    }
  } catch (_) { /* 판정 실패는 종전 경로(fail-open) — 제출 시점 게이트가 1차 방어 */ }

  // 실행 직전 attempts +1 (원본 시맨틱 — 클레임이 아니라 실행 단위)
  await pool.query(`UPDATE sync_queue SET attempts=attempts+1 WHERE id = ANY($1::int[])`, [items.map(it => it.id)]);

  const parsed = items.map(it => ({ item: it, p: typeof it.payload === 'string' ? JSON.parse(it.payload) : it.payload }));

  // ── J-1 (R-B6): id=ANY 단일 SELECT로 전 항목 최신값 재조회. ──
  const osIds = parsed.map(x => x.p.orderSubmissionId).filter(Boolean);
  const aliveMap = new Map();
  if (osIds.length) {
    const { rows } = await pool.query(
      `SELECT id, deleted_at, mirror_status, orderer, recipient, user_id, phone, address, bank, account,
              depositor, price, order_num, memo, date_str, selected_opt_key,
              submitted_at, reassign_count
         FROM order_submissions WHERE id = ANY($1::uuid[])`, [osIds]);
    for (const row of rows) aliveMap.set(row.id, row);
  }

  // ── 탭 컨텍스트 1회. 메타 없으면 전체 pending 복원(자가치유). ──
  let tabContext = null;
  try { tabContext = await loadRawTabContext(sheetId, parsed[0].p.gid, tabName); } catch (_) { tabContext = null; }
  if (!tabContext || !tabContext.headers || !tabContext.headers.length) {
    await _restorePending(items);
    return { processed: items.length, succeeded: 0, failed: 0, deferred: items.length, quotaExceeded,
             deferredIds: items.map(it => it.id) };
  }
  const ctxTab = tabContext.tabName || tabName;
  const ctxGid = tabContext.tabGid || parsed[0].p.gid || '';

  // ── 후보 구성: deleted=큐 done, 행 미배정=pending, 그 외 J-1 최신값으로 orderData 교체. ──
  const live = [];
  for (const x of parsed) {
    const os = x.p.orderSubmissionId ? aliveMap.get(x.p.orderSubmissionId) : null;
    // ★ 공정화 #4(R1/R10 보조): deleted/written(고아)면 시트 재기록 금지 → 시트콜 0으로 큐만 done.
    //   written 재기록은 멱등이라 무해하나 throttle 낭비 → 흡수해서 신규에 예산 집중.
    if (x.p.orderSubmissionId && (!os || os.deleted_at || os.mirror_status === 'written' || os.mirror_status === 'stuck_manual')) {
      await pool.query(`UPDATE sync_queue SET status='done', processed_at=NOW(), error_msg=NULL WHERE id=$1`, [x.item.id]);
      continue;
    }
    if (!x.p.sheetRow) {
      await pool.query(`UPDATE sync_queue SET status='pending', attempts=GREATEST(attempts-1,0), processed_at=NOW() WHERE id=$1 AND status='processing'`, [x.item.id]);
      deferredIds.push(x.item.id); deferred++; continue;
    }
    const orderData = os ? _osRowToOrderData(os) : x.p.orderData;
    live.push({ item: x.item, p: x.p, orderData, sheetRow: parseInt(x.p.sheetRow, 10) });
  }
  if (!live.length) return { processed: items.length, succeeded, failed, deferred, quotaExceeded, deferredIds };

  // ── 가드 1콜 (R-B3): 모든 가드 col union을 minCol..maxCol 한 사각형으로. ──
  const allCols = new Set();
  const _optCols = optionWriteColumns(tabContext.headers);      // ★ C′: 같은 사각형에 합류(콜 순증 0)
  for (const x of live) {
    x.guards = buildMirrorGuardRanges({ tabName: ctxTab, headers: tabContext.headers, targetRow: x.sheetRow, orderData: x.orderData });
    for (const g of x.guards) allCols.add(g.col);
  }
  for (const c of _optCols) allCols.add(c);
  invalidateSheetMeta(sheetId);                                 // D3b: stale 그리드 무효화
  if (allCols.size) {
    const cols = [...allCols];
    const minCol = Math.min(...cols), maxCol = Math.max(...cols);
    let guardMap;
    try {
      guardMap = await _readGuardWindow(sheetId, ctxTab, ctxGid, live.map(x => x.sheetRow), minCol, maxCol);
    } catch (err) {
      await _restorePending(items);                             // 가드 실패=전체 보류(쓰기 금지)
      if (_isQuota(err)) return { processed: items.length, succeeded, failed, deferred, quotaExceeded: true };
      throw err;
    }
    for (const x of live) {
      const cells = guardMap.get(x.sheetRow) || [];
      x.optProbe = (col) => ({ known: true, value: String(cells[col - minCol] || '') });
      x.blocked = x.guards.some(g => guardBlocksWrite(String(cells[g.col - minCol] || '').trim(), g));
    }
  }

  // ── 차단행 처리(버그1): defer(유예)/release(재배정)/giveup(수동전환·상한). ── (R1/R2/R3/R6)
  //   release: 큐항목 'done'을 '먼저' → 그 뒤 claim 해제/강등(크래시 시에도 stale 재드레인 churn 불가·J1).
  //   defer:   attempts 되돌림 + deferredIds로 동일 드레인콜 재클레임 제외(옛 점유행 재읽기·busy-spin 차단·R3).
  //   giveup:  reassign 상한 초과 → stuck_manual(reconcile/스케줄러 제외 = 무한 append 종결·R2) + claim 보존.
  const passed = [];
  let anyBlocked = false;
  for (const x of live) {
    if (!x.blocked) { passed.push(x); continue; }               // R-B7: 단일 진실원본
    anyBlocked = true;
    const os = x.p.orderSubmissionId ? aliveMap.get(x.p.orderSubmissionId) : null;
    const decision = _guardBlockDecision({
      recovered: x.p.recovered, submittedAt: os && os.submitted_at, reassignCount: os && os.reassign_count });
    if (decision === 'giveup') {
      await pool.query(
        `UPDATE order_submissions SET mirror_status='stuck_manual',
                sheet_error='guard blocked; exceeded max reassign — needs manual entry'
          WHERE id=$1 AND mirror_status<>'written'`, [x.p.orderSubmissionId]);
      await pool.query(`UPDATE sync_queue SET status='done', error_msg='guard blocked; giveup(stuck_manual)', processed_at=NOW() WHERE id=$1 AND status='processing'`, [x.item.id]);
      deferred++;
    } else if (decision === 'release') {
      // J1: 큐 'done'을 release '앞에' → 크래시-윈도에도 stale 항목 재드레인 없음(order는 done된 큐 없이 reconcile 재진입).
      await pool.query(`UPDATE sync_queue SET status='done', error_msg='guard blocked; released for reassignment', processed_at=NOW() WHERE id=$1 AND status='processing'`, [x.item.id]);
      // J2: dedupKey 유무와 무관하게 무조건 호출(내부에서 dedupKey/orderId 가드) → sheet_row NULL·failed로 reconcile 재배정.
      try { await _releaseOrderRowClaim({ sheetId, tabName: ctxTab, dedupKey: x.p.dedupKey, orderId: x.p.orderSubmissionId, orderSubmissionId: x.p.orderSubmissionId }); } catch (_) {}
      await pool.query(`UPDATE order_submissions SET reassign_count=COALESCE(reassign_count,0)+1 WHERE id=$1`, [x.p.orderSubmissionId]);
      deferred++;
    } else { // defer(유예): grace 미경과 실시간 주문 — 일시 write 경합을 영구소실로 오판하지 않음(R6)
      await pool.query(`UPDATE sync_queue SET status='pending', attempts=GREATEST(attempts-1,0), error_msg='guard blocked (grace/defer)', processed_at=NOW() WHERE id=$1 AND status='processing'`, [x.item.id]);
      deferredIds.push(x.item.id); deferred++;
    }
  }
  // ★ 시트 변경 감지(이벤트 기반): 가드 차단 = "시트가 예상과 다름"(수동 편집/재배치 신호) →
  //   그 시트만 자동 재미러+리컨실(triggerSheetMirrorOnce, 60초/시트 debounce·order_reconcile 락).
  //   released 주문이 사람 클릭 없이 현재 실제 하단 빈 행으로 재배정된다. best-effort(백그라운드).
  if (anyBlocked) {
    try { require('./orderLedger.service').triggerSheetMirrorOnce(sheetId); } catch (_) {}
  }
  if (!passed.length) return { processed: items.length, succeeded, failed, deferred, quotaExceeded, deferredIds };

  // ── 쓰기 (R-B9 청크 캡). 청크당 batchUpdate 1콜, 순차폴백 비활성. ──
  for (let i = 0; i < passed.length; i += BATCH_ROW_CAP) {
    const chunk = passed.slice(i, i + BATCH_ROW_CAP);
    const batchData = [];
    for (const x of chunk) {
      // 복구분(재배정 append)은 배경색 대신 비고란에 'system' 표기.
      const od = x.p.recovered ? { ...x.orderData, memo: _markSystemMemo(x.orderData && x.orderData.memo, x.p.recoverReason) } : x.orderData;
      const _bd = buildBatchUpdateData({ tabName: ctxTab, headers: tabContext.headers, targetRow: x.sheetRow, orderData: od });
      // ★ C′: optProbe 없으면(가드 읽기 미수행) 옵션 칸은 쓰지 않는다(fail-closed)
      const _optFilt = filterOptionWritesBlankOnly({ batchData: _bd, headers: tabContext.headers,
        tabName: ctxTab, targetRow: x.sheetRow, probe: x.optProbe });
      batchData.push(..._optFilt.data);
      _reportOptionSuppressed(_optFilt.suppressed, { sheetId, tabName: ctxTab, gid: ctxGid,
        sheetRow: x.sheetRow, orderSubmissionId: x.p.orderSubmissionId });
    }
    try {
      if (batchData.length) {
        await throttledCall(() => batchUpdateSheet(sheetId, batchData, 'RAW',
          { ...(ctxGid ? { gid: ctxGid } : {}), noSequentialFallback: true }));  // R-B9
      }
    } catch (err) {
      await _restorePending(chunk.map(x => x.item));             // R-B2: 청크 전체 멱등 재시도
      if (_isQuota(err)) { quotaExceeded = true; break; }
      failed += chunk.length; continue;
    }
    // ── 쓰기 성공 청크에만: 조건부 written + 신원기록 (같은 루프, 단일 진실원본). ──
    for (const x of chunk) {
      // ★ R-1b: 조건부 written(mirror_status<>'written'). 락분리(AUTO=1)로 단건 백스톱이
      //   같은 주문을 먼저 썼다면 0행 갱신 → 신원기록 생략(이중 흡수). markOrderWritten 전역함수는
      //   reconcile 등 타 호출자 보존 위해 손대지 않고 여기서 로컬 조건부 UPDATE.
      // 역동기 provenance(R1): 방금 쓴 매핑칸 서명 기록 → detect가 내 흔적을 변경으로 오인 안 함.
      let _sig = null;
      try { _sig = computeRowWriteSig(tabContext.headers, x.orderData); } catch (_) {}
      const w = await pool.query(
        `UPDATE order_submissions SET mirror_status='written',
                sheet_row=COALESCE($2::int, sheet_row), sheet_written_at=NOW(), sheet_error=NULL,
                last_sheet_write_sig=COALESCE($3, last_sheet_write_sig)
          WHERE id=$1 AND mirror_status<>'written' RETURNING id`,
        [x.p.orderSubmissionId, x.sheetRow, _sig]
      );
      if (w.rowCount === 0) {
        await pool.query(`UPDATE sync_queue SET status='done', processed_at=NOW(), error_msg=NULL WHERE id=$1`, [x.item.id]);
        continue;  // 이미 written(다른 경로가 먼저 씀) → 신원기록 생략(이중 흡수)
      }
      try {
        await recordParticipationLink({ sheetId, tabName: ctxTab, rowIndex: x.sheetRow,
          phone8: x.p.loginPhone8, phone: x.orderData && x.orderData.phone,
          name: x.p.loginName || (x.orderData && x.orderData.orderer), source: 'order_batch_drain' });
        await recordReviewIdentity({ sheetId, tabName: ctxTab, tabGid: ctxGid, rowIndex: x.sheetRow,
          phone8: x.p.loginPhone8, phone: x.orderData && x.orderData.phone,
          name: x.p.loginName || (x.orderData && x.orderData.orderer), recipient: x.orderData && x.orderData.recipient });
      } catch (idErr) { logger.warn(`[batchDrain] 신원기록 실패(무시): ${idErr.message}`); }
      await pool.query(`UPDATE sync_queue SET status='done', processed_at=NOW(), error_msg=NULL WHERE id=$1`, [x.item.id]);
      succeeded++;
    }
    // (복구행 표식은 배경색 대신 비고란 'system'으로 대체 — 위 batchData 생성 시 반영.)
  }
  return { processed: items.length, succeeded, failed, deferred, quotaExceeded, deferredIds };
}

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
      const { sheetId, tabName, rowIndex, submitCol, value } = payload;
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
      } else {
        throw new Error('헤더 행을 읽을 수 없음');
      }
      break;
    }

    case 'deposit_mark': {
      // 입금처리 이체완료시각을 구글시트 입금칸(submit_col2)에 기록 (재시도)
      const { sheetId, tabName, rowIndex, depositColKey, value, gid } = payload;
      if (!sheetId || !tabName || !rowIndex || !depositColKey) throw new Error('payload 누락');

      const headerValues = await throttledCall(() => readSheet(sheetId, `'${tabName}'!1:50`));
      if (!headerValues || headerValues.length === 0) throw new Error('헤더 행을 읽을 수 없음');

      const HEADER_KEYWORDS = ['주문자', '수취인', '연락처', '주소', '은행', '계좌', '금액', '아이디', '인애드', '리뷰', '입금'];
      let headerRow = headerValues[0];
      for (const row of headerValues) {
        const matchCount = (row || []).filter(c => HEADER_KEYWORDS.some(k => String(c || '').includes(k))).length;
        if (matchCount >= 2) { headerRow = row; break; }
      }
      const headers = (headerRow || []).map(h => String(h || '').trim());
      const colIdx = headers.findIndex(h => h === depositColKey);
      if (colIdx < 0) throw new Error(`입금컬럼 '${depositColKey}' 을 헤더에서 찾을 수 없음`);

      const colLetter = _getColLetter(colIdx);
      const range = `'${tabName}'!${colLetter}${rowIndex}`;
      await throttledCall(() => writeSheet(sheetId, range, [[value || '']], gid ? { gid } : {}));
      break;
    }

    case 'order_append': {
      let { sheetId, tabName, orderData, loginPhone8, loginName, gid, sheetRow, orderSubmissionId, recovered, recoverReason, dedupKey } = payload;
      if (!sheetId || !tabName) throw new Error('payload 누락');
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

        await recordParticipationLink({
          sheetId, tabName: tabContext.tabName || tabName, rowIndex: sheetRow,
          phone8: loginPhone8, phone: orderData && orderData.phone,
          name: loginName || (orderData && orderData.orderer),
          source: 'order_submit_queue',
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

// ── 큐 통계 조회 ──
async function getQueueStats() {
  const { rows } = await pool.query(`
    SELECT
      status,
      COUNT(*) as count,
      MAX(created_at) as latest_created,
      MAX(processed_at) as latest_processed
    FROM sync_queue
    GROUP BY status
    ORDER BY status
  `);

  const stats = { pending: 0, processing: 0, done: 0, failed: 0, total: 0 };
  rows.forEach(r => {
    stats[r.status] = parseInt(r.count);
    stats.total += parseInt(r.count);
  });

  // 최근 실패 항목 (payload 포함 — 어떤 탭/시트에서 실패했는지 확인용)
  const { rows: recentFailed } = await pool.query(`
    SELECT id, type, error_msg, attempts, max_retry, created_at, processed_at, payload
    FROM sync_queue
    WHERE status = 'failed'
    ORDER BY processed_at DESC NULLS LAST
    LIMIT 5
  `);

  // ★ 타입×상태 분해(적체 원인 진단: review_submit vs order_append 고아 구분)
  const { rows: byType } = await pool.query(`
    SELECT type, status, COUNT(*)::int AS count
    FROM sync_queue
    GROUP BY type, status
    ORDER BY type, status
  `);
  // pending order_append 중 "이미 written/canceled/삭제된 주문"(고아) 수 — 실제 미반영과 구분
  const { rows: orphanRows } = await pool.query(`
    SELECT COUNT(*)::int AS orphans
    FROM sync_queue sq
    JOIN order_submissions os ON os.id = (sq.payload->>'orderSubmissionId')::uuid
    WHERE sq.type='order_append' AND sq.status='pending'
      AND (os.deleted_at IS NOT NULL OR os.mirror_status IN ('written','canceled'))
  `).catch(() => [{ orphans: null }]);

  return { stats, recentFailed, byType, orphanOrderAppendPending: orphanRows[0] && orphanRows[0].orphans };
}

// ── 특정 항목 수동 재시도 ──
async function retryItem(id) {
  const { rows } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = NULL
     WHERE id = $1 AND status = 'failed'
     RETURNING id, type`,
    [id]
  );
  if (rows.length === 0) throw new Error(`id=${id}인 실패 항목을 찾을 수 없습니다.`);
  return rows[0];
}

// ── 모든 실패 항목 재시도 ──
async function retryAllFailed() {
  // ★ PR-B(R6): order_update/order_cancel은 backstop 재시도 대상에서 제외.
  //   이미 conflict/canceled_sheet_dirty로 "판정·안전정지"한 건을 시간차 재실행해
  //   사람 재사용행 클리어(R1)·클로버(R3) 파괴를 재발시키지 않게 한다. (3개 쿼리 모두 적용)
  // stuck된 processing 항목도 함께 리셋 (5분 이상 경과)
  const { rowCount: unstuck } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = 'reset: stuck processing'
     WHERE status = 'processing'
       AND (processed_at IS NULL OR processed_at < NOW() - INTERVAL '5 minutes')
       AND type NOT IN ('order_update','order_cancel')`
  );
  if (unstuck > 0) {
    logger.info(`[syncQueue] ${unstuck}건 stuck processing 항목 리셋`);
  }

  // failed 상태 항목 재시도
  const { rowCount } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = NULL
     WHERE status = 'failed'
       AND type NOT IN ('order_update','order_cancel')`
  );

  // pending이지만 attempts >= max_retry로 처리 불가능한 항목도 리셋
  const { rowCount: resetExhausted } = await pool.query(
    `UPDATE sync_queue
     SET attempts = 0, error_msg = NULL
     WHERE status = 'pending' AND attempts >= max_retry
       AND type NOT IN ('order_update','order_cancel')`
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

// ── 특정 항목 삭제 (failed 상태만) ──
async function deleteItem(id) {
  const { rows } = await pool.query(
    `DELETE FROM sync_queue
     WHERE id = $1 AND status = 'failed'
     RETURNING id, type`,
    [id]
  );
  if (rows.length === 0) throw new Error(`id=${id}인 실패 항목을 찾을 수 없거나 이미 삭제됨`);
  logger.info(`[syncQueue] 🗑️ id=${id} type=${rows[0].type} 삭제 완료`);
  return rows[0];
}

// ── 모든 실패 항목 삭제 ──
async function deleteAllFailed() {
  const { rowCount } = await pool.query(
    `DELETE FROM sync_queue WHERE status = 'failed'`
  );
  logger.info(`[syncQueue] 🗑️ 실패 항목 ${rowCount}건 일괄 삭제`);
  return { deleted: rowCount };
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
      await _executeItem(item);
      await pool.query(`UPDATE sync_queue SET status = 'done', processed_at = NOW(), error_msg = NULL WHERE id = $1`, [item.id]);
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
      failed++;
      if (isQuotaError) break;
    }
  }
  return { processed, succeeded, failed };
}

module.exports = {
  enqueue,
  processQueue,
  drainTabQueue,
  drainTabQueueBatched,
  drainOrderQueue,
  _isQuota,            // 테스트용
  _readGuardWindow,    // 테스트용(reader 주입)
  _guardBlockDecision, // 테스트용(defer/release/giveup 진리표)
  _markSystemMemo,     // 테스트용(복구행 비고 'system' 표기)
  getQueueStats,
  retryItem,
  retryAllFailed,
  purgeCompleted,
  deleteItem,
  deleteAllFailed,
};
