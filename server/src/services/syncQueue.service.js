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
const { writeSheet, appendSheet, readSheet, batchUpdateSheet, setRowBackground, setRowsBackground, invalidateSheetMeta } = require('./sheets.service');
const { throttledCall } = require('../utils/sheetsThrottle');
const { recordParticipationLink } = require('./participation.service');
const {
  loadRawTabContext,
  buildBatchUpdateData,
  buildMirrorGuardRange,
  buildMirrorGuardRanges,
  guardBlocksWrite,
  markOrderWritten,
  markOrderMirrorFailed,
  recordReviewIdentity,
  mapOrderToSheetRow,
  _osRowToOrderData,
  _fieldToCol,
  rowIdentityMatches,
} = require('./orderLedger.service');
const { logger } = require('../utils/logger');

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
async function processQueue(batchSize = 10, { interItemDelayMs = 2000 } = {}) {
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
    const skipOrderAppend = process.env.ORDER_BATCH_AUTO === '1';
    const { rows: items } = await pool.query(
      `UPDATE sync_queue SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM sync_queue
           WHERE status = 'pending' AND attempts < max_retry
             ${skipOrderAppend ? "AND type <> 'order_append'" : ''}
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [batchSize]
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
const STALE_PROCESSING_SEC = parseInt(process.env.ORDER_BATCH_STALE_PROCESSING_SEC || '20', 10); // 정체 processing 재점유 임계

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
async function drainTabQueueBatched({ sheetId, tabName, maxMillis = 60000, batchSize = BATCH_ROW_CAP, runReconcileFirst = true } = {}) {
  if (!sheetId || !tabName) throw new Error('drainTabQueueBatched: sheetId, tabName 필수');
  if (process.env.ORDER_BATCH_DRAIN !== '1') {                  // R-B10: 플래그 게이트(되돌리기)
    return drainTabQueue({ sheetId, tabName, maxMillis });      // 미설정 시 검증된 단건 경로
  }
  const { withJobLock } = require('../utils/jobLock');
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
      const start = Date.now();
      let processed = 0, succeeded = 0, failed = 0, deferred = 0;
      while (Date.now() - start < maxMillis) {
        // R-B8: 단건과 동일 클레임 조건(type='order_append') → 같은 항목은 한쪽만 점유(SKIP LOCKED).
        const { rows: items } = await pool.query(
          // ★ 버스트/백로그 대응: pending뿐 아니라 "정체된 processing"도 재점유.
          //   펌프가 submit-kick으로 항목을 즉시 processing으로 잡고 throttle 대기에 묶이면(백로그 시 다수),
          //   pending-only claim은 그 탭 항목을 못 빼낸다. 배치는 queue_pump_drain 락을 쥐어 펌프가 멈춰 있으므로,
          //   STALE_PROCESSING_SEC(기본 20s) 넘은 processing은 안전하게 재점유한다.
          //   (재처리해도 claim 2중유니크 + my-own-value 가드로 동일행 멱등 재기록 = 무해.)
          `UPDATE sync_queue SET status='processing', processed_at=NOW()
            WHERE id IN (SELECT id FROM sync_queue
               WHERE attempts<max_retry AND type='order_append'
                 AND payload->>'sheetId'=$1 AND payload->>'tabName'=$2
                 AND (status='pending'
                      OR (status='processing' AND processed_at < NOW() - ($4 || ' seconds')::interval))
               ORDER BY created_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED)
            RETURNING *`,
          [sheetId, tabName, batchSize, String(STALE_PROCESSING_SEC)]
        );
        if (!items.length) break;
        const r = await _executeBatch(items, sheetId, tabName);
        processed += r.processed; succeeded += r.succeeded; failed += r.failed; deferred += r.deferred;
        if (r.quotaExceeded) break;                             // R-B9: quota → 양보(락 해제)
      }
      return { processed, succeeded, failed, deferred, elapsedMs: Date.now() - start };
    }, { onBusy: () => ({ skipped: true, reason: 'order_reconcile_lock_busy' }) });
  }, { onBusy: () => ({ skipped: true, reason: 'queue_pump_drain_lock_busy' }) });
}

async function _executeBatch(items, sheetId, tabName) {
  let succeeded = 0, failed = 0, deferred = 0, quotaExceeded = false;
  // 실행 직전 attempts +1 (원본 시맨틱 — 클레임이 아니라 실행 단위)
  await pool.query(`UPDATE sync_queue SET attempts=attempts+1 WHERE id = ANY($1::int[])`, [items.map(it => it.id)]);

  const parsed = items.map(it => ({ item: it, p: typeof it.payload === 'string' ? JSON.parse(it.payload) : it.payload }));

  // ── J-1 (R-B6): id=ANY 단일 SELECT로 전 항목 최신값 재조회. ──
  const osIds = parsed.map(x => x.p.orderSubmissionId).filter(Boolean);
  const aliveMap = new Map();
  if (osIds.length) {
    const { rows } = await pool.query(
      `SELECT id, deleted_at, mirror_status, orderer, recipient, user_id, phone, address, bank, account,
              depositor, price, order_num, memo, date_str, selected_opt_key
         FROM order_submissions WHERE id = ANY($1::uuid[])`, [osIds]);
    for (const row of rows) aliveMap.set(row.id, row);
  }

  // ── 탭 컨텍스트 1회. 메타 없으면 전체 pending 복원(자가치유). ──
  let tabContext = null;
  try { tabContext = await loadRawTabContext(sheetId, parsed[0].p.gid, tabName); } catch (_) { tabContext = null; }
  if (!tabContext || !tabContext.headers || !tabContext.headers.length) {
    await _restorePending(items);
    return { processed: items.length, succeeded: 0, failed: 0, deferred: items.length, quotaExceeded };
  }
  const ctxTab = tabContext.tabName || tabName;
  const ctxGid = tabContext.tabGid || parsed[0].p.gid || '';

  // ── 후보 구성: deleted=큐 done, 행 미배정=pending, 그 외 J-1 최신값으로 orderData 교체. ──
  const live = [];
  for (const x of parsed) {
    const os = x.p.orderSubmissionId ? aliveMap.get(x.p.orderSubmissionId) : null;
    // ★ 공정화 #4(R1/R10 보조): deleted/written(고아)면 시트 재기록 금지 → 시트콜 0으로 큐만 done.
    //   written 재기록은 멱등이라 무해하나 throttle 낭비 → 흡수해서 신규에 예산 집중.
    if (x.p.orderSubmissionId && (!os || os.deleted_at || os.mirror_status === 'written')) {
      await pool.query(`UPDATE sync_queue SET status='done', processed_at=NOW(), error_msg=NULL WHERE id=$1`, [x.item.id]);
      continue;
    }
    if (!x.p.sheetRow) {
      await pool.query(`UPDATE sync_queue SET status='pending', processed_at=NOW() WHERE id=$1 AND status='processing'`, [x.item.id]);
      deferred++; continue;
    }
    const orderData = os ? _osRowToOrderData(os) : x.p.orderData;
    live.push({ item: x.item, p: x.p, orderData, sheetRow: parseInt(x.p.sheetRow, 10) });
  }
  if (!live.length) return { processed: items.length, succeeded, failed, deferred, quotaExceeded };

  // ── 가드 1콜 (R-B3): 모든 가드 col union을 minCol..maxCol 한 사각형으로. ──
  const allCols = new Set();
  for (const x of live) {
    x.guards = buildMirrorGuardRanges({ tabName: ctxTab, headers: tabContext.headers, targetRow: x.sheetRow, orderData: x.orderData });
    for (const g of x.guards) allCols.add(g.col);
  }
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
      x.blocked = x.guards.some(g => guardBlocksWrite(String(cells[g.col - minCol] || '').trim(), g));
    }
  }

  // ── 차단행: claim 해제(복구분만) + 큐 pending(다음 reconcile이 더 아래 행). ── (R-B1/B7)
  const passed = [];
  for (const x of live) {
    if (x.blocked) {
      if (x.p.recovered && x.p.dedupKey) {
        try { await _releaseOrderRowClaim({ sheetId, tabName: ctxTab, dedupKey: x.p.dedupKey, orderSubmissionId: x.p.orderSubmissionId }); } catch (_) {}
      }
      await pool.query(`UPDATE sync_queue SET status='pending', error_msg='guard blocked', processed_at=NOW() WHERE id=$1 AND status='processing'`, [x.item.id]);
      deferred++;
    } else {
      passed.push(x);                                           // R-B7: 단일 진실원본
    }
  }
  if (!passed.length) return { processed: items.length, succeeded, failed, deferred, quotaExceeded };

  // ── 쓰기 (R-B9 청크 캡). 청크당 batchUpdate 1콜, 순차폴백 비활성. ──
  for (let i = 0; i < passed.length; i += BATCH_ROW_CAP) {
    const chunk = passed.slice(i, i + BATCH_ROW_CAP);
    const batchData = [];
    for (const x of chunk) {
      batchData.push(...buildBatchUpdateData({ tabName: ctxTab, headers: tabContext.headers, targetRow: x.sheetRow, orderData: x.orderData }));
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
    // ── 쓰기 성공 청크에만: 신원기록 + markWritten (같은 루프, 단일 진실원본). ──
    const recoveredRows = [];
    for (const x of chunk) {
      try {
        await recordParticipationLink({ sheetId, tabName: ctxTab, rowIndex: x.sheetRow,
          phone8: x.p.loginPhone8, phone: x.orderData && x.orderData.phone,
          name: x.p.loginName || (x.orderData && x.orderData.orderer), source: 'order_batch_drain' });
        await recordReviewIdentity({ sheetId, tabName: ctxTab, tabGid: ctxGid, rowIndex: x.sheetRow,
          phone8: x.p.loginPhone8, phone: x.orderData && x.orderData.phone,
          name: x.p.loginName || (x.orderData && x.orderData.orderer), recipient: x.orderData && x.orderData.recipient });
      } catch (idErr) { logger.warn(`[batchDrain] 신원기록 실패(무시): ${idErr.message}`); }
      await markOrderWritten(x.p.orderSubmissionId, x.sheetRow);
      await pool.query(`UPDATE sync_queue SET status='done', processed_at=NOW(), error_msg=NULL WHERE id=$1`, [x.item.id]);
      succeeded++;
      if (x.p.recovered) recoveredRows.push(x.sheetRow);
    }
    // ── R-B4: 복구행 배경색 1콜(N행 묶음). best-effort. ──
    if (recoveredRows.length) {
      try {
        await throttledCall(() => setRowsBackground(sheetId, { gid: ctxGid, tabName: ctxTab,
          rowIndexes: recoveredRows, colCount: (tabContext.headers && tabContext.headers.length) || 30 }));
      } catch (bgErr) { logger.warn(`[batchDrain] 배경색 묶음 실패(무시): ${bgErr.message}`); }
    }
  }
  return { processed: items.length, succeeded, failed, deferred, quotaExceeded };
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
      let { sheetId, tabName, orderData, loginPhone8, loginName, gid, sheetRow, orderSubmissionId, recovered, dedupKey } = payload;
      if (!sheetId || !tabName) throw new Error('payload 누락');
      if (!sheetRow) throw new Error('payload 누락: sheetRow');

      try {
        // ★ PR-A 가드 + J-1(B4): 취소/삭제된 주문은 시트쓰기 skip(큐 done — markFailed/throw 금지) +
        //   동시에 최신 필드를 재조회해 orderData를 교체한다. payload는 enqueue 시점 스냅샷이라,
        //   편집(order_update) 후 deferred append되는 주문은 이 재조회가 없으면 옛값으로 기록(편집 소실).
        if (orderSubmissionId) {
          const { rows: alive } = await pool.query(
            `SELECT deleted_at, orderer, recipient, user_id, phone, address, bank, account, depositor,
                    price, order_num, memo, date_str, selected_opt_key
               FROM order_submissions WHERE id = $1`,
            [orderSubmissionId]
          );
          if (!alive.length || alive[0].deleted_at) {
            logger.info(`[order_append] 취소/삭제된 주문 — 시트쓰기 건너뜀 (id=${orderSubmissionId})`);
            return;
          }
          orderData = _osRowToOrderData(alive[0]); // ★ J-1: stale 스냅샷 대체 = 편집값 반영
        }
        const tabContext = await loadRawTabContext(sheetId, gid, tabName);
        if (!tabContext || !tabContext.headers || tabContext.headers.length === 0) {
          throw new Error('RAW 미러 헤더 메타를 찾을 수 없음');
        }
        // ★ D3a(#3): 다중컬럼 가드(연락처+주소+수취인) — 한 칸만 빈 수동입력행 덮어쓰기 방지.
        //   한 번의 행 읽기(min~max col)로 쿼터 1회 유지, 셀별 판정.
        //   D3b: 읽기 전 그리드 캐시 무효화 → append 행이 60s stale 그리드밖이라 빈배열([])로 오판되는 것 차단.
        const guards = buildMirrorGuardRanges({
          tabName: tabContext.tabName || tabName,
          headers: tabContext.headers,
          targetRow: parseInt(sheetRow, 10),
          orderData,
        });
        if (guards.length) {
          invalidateSheetMeta(sheetId);
          const colsIdx = guards.map(g => g.col);
          const minC = Math.min(...colsIdx), maxC = Math.max(...colsIdx);
          const rowRange = `'${tabContext.tabName || tabName}'!${_getColLetter(minC)}${sheetRow}:${_getColLetter(maxC)}${sheetRow}`;
          const read = await throttledCall(() =>
            readSheet(sheetId, rowRange, tabContext.tabGid ? { gid: tabContext.tabGid } : (gid ? { gid } : {}))
          );
          const cells = (read && read[0]) || [];
          // 내가 쓴 값이면(재시도 멱등) 통과, 어느 칸이든 외부/타 주문 값이면 덮어쓰기 차단
          const blocked = guards.some(g => guardBlocksWrite(String(cells[g.col - minC] || '').trim(), g));
          if (blocked) {
            // ★ 복구(append) 주문이 차단되면 = 그 하단행이 직원 수동입력 등으로 이미 채워짐.
            //   claim을 해제(행 점유/주문.sheet_row 비움)해 다음 리컨실이 "더 아래" 새 행을 잡게 한다(stuck loop 방지).
            if (recovered && dedupKey) {
              await _releaseOrderRowClaim({ sheetId, tabName: tabContext.tabName || tabName, dedupKey, orderSubmissionId });
            }
            throw new Error('target row already filled before mirror write (multi-col guard)');
          }
        }
        const batchData = buildBatchUpdateData({
          tabName: tabContext.tabName || tabName,
          headers: tabContext.headers,
          targetRow: parseInt(sheetRow, 10),
          orderData,
        });
        if (batchData.length > 0) {
          await throttledCall(() => batchUpdateSheet(
            sheetId,
            batchData,
            'RAW',
            tabContext.tabGid ? { gid: tabContext.tabGid } : (gid ? { gid } : {})
          ));
        }

        // ★ 복구 주문: 기록한 행을 노란 배경으로 표시(수동입력분·중복과 시각 구분). best-effort.
        if (recovered) {
          try {
            await throttledCall(() => setRowBackground(sheetId, {
              gid: tabContext.tabGid || gid,
              tabName: tabContext.tabName || tabName,
              rowIndex: parseInt(sheetRow, 10),
              colCount: (tabContext.headers && tabContext.headers.length) || 30,
            }));
          } catch (bgErr) {
            logger.warn(`[order_append] 복구행 배경색 적용 실패(무시): ${bgErr.message}`);
          }
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
        await markOrderWritten(orderSubmissionId, sheetRow);
      } catch (err) {
        await markOrderMirrorFailed(orderSubmissionId, err);
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
      if (!cols.length) { await markOrderWritten(orderSubmissionId, os.sheet_row); break; }
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
      await markOrderWritten(orderSubmissionId, os.sheet_row);
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
      const blank = buildBatchUpdateData({
        tabName: tabContext.tabName, headers: tabContext.headers,
        targetRow: parseInt(os.sheet_row, 10), orderData: {},                    // 매핑칸만 ''(입금칸·관리자칸은 매핑밖=보존)
      });
      if (blank.length) {
        await throttledCall(() => batchUpdateSheet(os.sheet_id, blank, 'RAW',
          tabContext.tabGid ? { gid: tabContext.tabGid } : {}));
      }
      // R13: claim 보존(_releaseOrderRowClaim 호출 안 함) → 빈 행 재점유 차단. mirror_status만 canceled.
      await pool.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
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

  return { stats, recentFailed };
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
          WHERE id = $1`,
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
  getQueueStats,
  retryItem,
  retryAllFailed,
  purgeCompleted,
  deleteItem,
  deleteAllFailed,
};
