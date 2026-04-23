/**
 * Google Sheets/Drive API 호출 속도 제한 (Throttle)
 * 
 * Google API quota: 분당 60 읽기 요청 / 사용자 (서비스 계정)
 * 안전 마진을 두고 분당 50 요청으로 제한 → 요청 간 최소 1.2초 간격
 * 
 * 주요 기능:
 *   1. throttledCall(fn) — 단일 API 호출을 큐에 넣고 순서대로 실행
 *   2. throttledMap(items, fn, concurrency) — 배열을 동시성 제한 + 간격 제어로 처리
 */

const { logger } = require('./logger');

// ═══════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════

const REQUESTS_PER_MINUTE = 50;  // 안전 마진 (실제 한도 60)
const MIN_INTERVAL_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE); // ≈ 1200ms
const DEFAULT_CONCURRENCY = 3;   // 동시 처리 수 (3개씩 → 간격 유지)

// 글로벌 요청 타임스탬프 큐 (슬라이딩 윈도우)
const _requestTimestamps = [];

/**
 * 다음 API 호출까지 대기해야 하는 시간(ms) 계산
 * 슬라이딩 윈도우: 최근 1분간 요청 수를 추적
 */
function _getWaitTime() {
  const now = Date.now();
  // 1분 이전의 타임스탬프 제거
  while (_requestTimestamps.length > 0 && _requestTimestamps[0] < now - 60000) {
    _requestTimestamps.shift();
  }
  
  // 현재 윈도우 내 요청 수가 한도 미만이면 대기 불필요
  if (_requestTimestamps.length < REQUESTS_PER_MINUTE) {
    // 단, 마지막 요청과의 최소 간격은 유지
    if (_requestTimestamps.length > 0) {
      const lastReq = _requestTimestamps[_requestTimestamps.length - 1];
      const sinceLastReq = now - lastReq;
      if (sinceLastReq < MIN_INTERVAL_MS) {
        return MIN_INTERVAL_MS - sinceLastReq;
      }
    }
    return 0;
  }
  
  // 한도 도달 → 가장 오래된 요청이 윈도우에서 빠질 때까지 대기
  const oldestInWindow = _requestTimestamps[0];
  return (oldestInWindow + 60000) - now + 100; // +100ms 여유
}

/**
 * 대기 후 타임스탬프 기록
 */
async function _waitAndRecord() {
  const waitMs = _getWaitTime();
  if (waitMs > 0) {
    logger.debug(`[throttle] API 호출 대기 ${waitMs}ms (현재 ${_requestTimestamps.length}/${REQUESTS_PER_MINUTE} req/min)`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  _requestTimestamps.push(Date.now());
}

// ═══════════════════════════════════════════════════════════
// 공개 API
// ═══════════════════════════════════════════════════════════

/**
 * 단일 Google API 호출을 throttle로 감싸기 (retry with backoff 포함)
 * @param {Function} fn — async 함수 (Google API 호출)
 * @param {number} maxRetries — 최대 재시도 횟수 (기본 2)
 * @returns {Promise<any>} — fn의 반환값
 * 
 * 사용법:
 *   const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
 */
async function throttledCall(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await _waitAndRecord();
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.response?.status || err?.status;
      const isRetryable = [429, 500, 503, 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(status)
        || (typeof err.message === 'string' && /rate limit|quota|timeout|ECONNRESET/i.test(err.message));

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 10000); // 2s, 4s, max 10s
        logger.warn(`[throttle] API 호출 실패 (attempt ${attempt + 1}/${maxRetries + 1}), ${delay}ms 후 재시도: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * 배열 항목들을 동시성 제한 + throttle로 병렬 처리
 * Promise.allSettled 대체 — quota 안전하게 병렬 처리
 * 
 * @param {Array} items — 처리할 항목 배열
 * @param {Function} fn — async (item, index) => result
 * @param {number} concurrency — 동시 실행 수 (기본 3)
 * @returns {Array<{status, value?, reason?}>} — Promise.allSettled과 동일한 형태
 * 
 * 사용법:
 *   const results = await throttledMap(sheetIds, async (sheetId) => {
 *     const meta = await getSpreadsheetMeta(sheetId);
 *     return processSheet(sheetId, meta);
 *   }, 3);
 */
async function throttledMap(items, fn, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;
  
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        await _waitAndRecord();
        results[idx] = { status: 'fulfilled', value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }
  
  // concurrency 개의 워커를 동시에 실행
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  
  return results;
}

/**
 * 현재 throttle 상태 조회 (디버깅/모니터링용)
 */
function getThrottleStatus() {
  const now = Date.now();
  const recentCount = _requestTimestamps.filter(t => t > now - 60000).length;
  return {
    requestsInLastMinute: recentCount,
    limit: REQUESTS_PER_MINUTE,
    minIntervalMs: MIN_INTERVAL_MS,
    nextWaitMs: _getWaitTime(),
  };
}

module.exports = {
  throttledCall,
  throttledMap,
  getThrottleStatus,
  // 설정값 노출 (테스트용)
  REQUESTS_PER_MINUTE,
  MIN_INTERVAL_MS,
  DEFAULT_CONCURRENCY,
};
