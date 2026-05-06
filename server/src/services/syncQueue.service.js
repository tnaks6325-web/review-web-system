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
const { writeSheet, appendSheet, readSheet } = require('./sheets.service');
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
async function processQueue(batchSize = 10) {
  const startTime = Date.now();
  let processed = 0, succeeded = 0, failed = 0;

  try {
    // pending 상태이고 최대 재시도 미달인 항목을 가져옴
    const { rows: items } = await pool.query(
      `SELECT * FROM sync_queue
       WHERE status = 'pending' AND attempts < max_retry
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize]
    );

    if (items.length === 0) return { processed: 0, succeeded: 0, failed: 0, elapsed: 0 };

    logger.info(`[syncQueue] ${items.length}건 처리 시작`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      processed++;

      // ★ A1: Exponential backoff — Quota 에러 이력이 있으면 대기 시간 증가
      const baseDelay = 2000; // 기본 2초
      const backoffDelay = item.attempts > 0
        ? Math.min(baseDelay * Math.pow(2, item.attempts), 30000) // 최대 30초
        : (i > 0 ? baseDelay : 0); // 첫 항목은 즉시, 이후 2초
      if (backoffDelay > 0) {
        await new Promise(r => setTimeout(r, backoffDelay));
      }

      // processing 상태로 변경
      await pool.query(
        `UPDATE sync_queue SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
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
            logger.warn(`[syncQueue] ⚠️ id=${item.id} Quota 에러 — 나머지 ${items.length - i - 1}건 다음 사이클로 연기`);
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

  return { processed, succeeded, failed, elapsed };
}

// ── 개별 항목 실행 ──
async function _executeItem(item) {
  const payload = typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;

  switch (item.type) {
    case 'sheet_write': {
      // writeSheet(sheetId, range, values)
      const { sheetId, range, values } = payload;
      if (!sheetId || !range || !values) throw new Error('payload 누락: sheetId, range, values');
      await writeSheet(sheetId, range, values);
      break;
    }

    case 'sheet_append': {
      // appendSheet(sheetId, range, values)
      const { sheetId, range, values } = payload;
      if (!sheetId || !range || !values) throw new Error('payload 누락: sheetId, range, values');
      await appendSheet(sheetId, range, values);
      break;
    }

    case 'review_submit': {
      // ★ C1: 큐 재시도 시 항상 신선한 헤더를 읽음 (캐시된 헤더 사용 안 함)
      const { sheetId, tabName, rowIndex, submitCol, value } = payload;
      if (!sheetId || !tabName || !rowIndex) throw new Error('payload 누락');

      // 헤더 행을 최대 50행까지 읽어서 실제 헤더 위치 찾기
      const headerValues = await readSheet(sheetId, `'${tabName}'!1:50`);
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
          await writeSheet(sheetId, range, [[value || '제출']]);
        } else {
          throw new Error(`submitCol '${submitCol}' 을 헤더에서 찾을 수 없음 (헤더: ${headers.slice(0, 10).join(',')})`);
        }
      } else {
        throw new Error('헤더 행을 읽을 수 없음');
      }
      break;
    }

    case 'order_append': {
      // ★ C1: 큐 재시도 시 항상 신선한 헤더를 읽음 (최대 50행에서 탐색)
      const { sheetId, tabName, orderData } = payload;
      if (!sheetId || !tabName) throw new Error('payload 누락');

      const headerValues = await readSheet(sheetId, `'${tabName}'!1:50`);
      if (headerValues && headerValues.length > 0) {
        const HEADER_KEYWORDS = ['주문자', '수취인', '연락처', '주소', '은행', '계좌', '금액', '아이디', '인애드'];
        let headerRow = headerValues[0];
        for (const row of headerValues) {
          const matchCount = row.filter(c => HEADER_KEYWORDS.some(k => String(c || '').includes(k))).length;
          if (matchCount >= 2) { headerRow = row; break; }
        }
        const headers = headerRow.map(h => String(h || '').trim());
        const rowData = _mapOrderToRow(headers, orderData);
        await appendSheet(sheetId, `'${tabName}'!A:A`, [rowData]);
      } else {
        throw new Error('헤더 행을 읽을 수 없음');
      }
      break;
    }

    default:
      throw new Error(`알 수 없는 큐 타입: ${item.type}`);
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
  // stuck된 processing 항목도 함께 리셋 (5분 이상 경과)
  const { rowCount: unstuck } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = 'reset: stuck processing'
     WHERE status = 'processing'
       AND (processed_at IS NULL OR processed_at < NOW() - INTERVAL '5 minutes')`
  );
  if (unstuck > 0) {
    logger.info(`[syncQueue] ${unstuck}건 stuck processing 항목 리셋`);
  }

  // failed 상태 항목 재시도
  const { rowCount } = await pool.query(
    `UPDATE sync_queue
     SET status = 'pending', attempts = 0, error_msg = NULL
     WHERE status = 'failed'`
  );

  // pending이지만 attempts >= max_retry로 처리 불가능한 항목도 리셋
  const { rowCount: resetExhausted } = await pool.query(
    `UPDATE sync_queue
     SET attempts = 0, error_msg = NULL
     WHERE status = 'pending' AND attempts >= max_retry`
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
  return headers.map(h => {
    const key = h.toLowerCase();
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
    if (key.includes('비고') || key.includes('memo')) return orderData.memo || '';
    if (key.includes('옵션') || key.includes('option')) return orderData.selectedOptKey || '';
    return '';
  });
}

module.exports = {
  enqueue,
  processQueue,
  getQueueStats,
  retryItem,
  retryAllFailed,
  purgeCompleted,
};
