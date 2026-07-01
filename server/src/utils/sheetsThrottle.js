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

const REQUESTS_PER_MINUTE = parseInt(process.env.SHEETS_REQUESTS_PER_MINUTE || '45', 10);  // 안전 마진 (실제 한도 60)
const MIN_INTERVAL_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE); // ≈ 1200ms
const DEFAULT_CONCURRENCY = 3;   // 동시 처리 수 (3개씩 → 간격 유지)

// 글로벌 요청 큐 (슬라이딩 윈도우) — {ts, label} 객체로 "어디서 호출했는지" 추적(#3 모니터).
const _requests = [];
// 최근 호출 로그(라벨 포함, 최대 120건) — 대시보드 실시간 로그용.
const _recentLog = [];
const _RECENT_CAP = 120;

// 파일명 → 친화 라벨(호출 출처 분류). 스택에서 첫 non-throttle 프레임으로 자동 귀속(호출부 수정 0).
const _FILE_LABEL = {
  'rawMirror.service.js': 'RAW미러',
  'syncQueue.service.js': '주문쓰기/큐',
  'orderLedger.service.js': '주문행배정/역동기',
  'smartBuild.service.js': '리뷰인덱스빌드',
  'indexBuilder.service.js': '리뷰인덱스빌드',
  'indexScan.service.js': '인덱스스캔',
  'submit.routes.js': '제출(리뷰/구매)',
  'tabconfig.routes.js': '탭설정',
  'diag.routes.js': '진단/수동도구',
  'drive.service.js': 'Drive',
  'sheets.service.js': '시트IO',
};
function _callerLabel() {
  const stack = (new Error().stack || '').split('\n');
  for (let i = 2; i < stack.length; i++) {
    const line = stack[i];
    if (!line || line.includes('sheetsThrottle.js')) continue;
    const m = line.match(/\/([A-Za-z0-9_.-]+\.js):\d+:\d+/);
    if (!m) continue;
    const file = m[1];
    const fnM = line.match(/at (?:async )?([A-Za-z0-9_$.<>]+)/);
    const fn = fnM ? fnM[1] : '?';
    return { label: _FILE_LABEL[file] || file, file, fn };
  }
  return { label: 'other', file: '?', fn: '?' };
}

function _prune(now) {
  while (_requests.length > 0 && _requests[0].ts < now - 60000) _requests.shift();
}

/**
 * 다음 API 호출까지 대기해야 하는 시간(ms) 계산 (슬라이딩 윈도우)
 */
function _getWaitTime() {
  const now = Date.now();
  _prune(now);
  if (_requests.length < REQUESTS_PER_MINUTE) {
    if (_requests.length > 0) {
      const sinceLastReq = now - _requests[_requests.length - 1].ts;
      if (sinceLastReq < MIN_INTERVAL_MS) return MIN_INTERVAL_MS - sinceLastReq;
    }
    return 0;
  }
  return (_requests[0].ts + 60000) - now + 100; // +100ms 여유
}

/**
 * 대기 후 타임스탬프+라벨 기록
 */
async function _waitAndRecord(caller) {
  const waitMs = _getWaitTime();
  if (waitMs > 0) {
    logger.debug(`[throttle] API 호출 대기 ${waitMs}ms (현재 ${_requests.length}/${REQUESTS_PER_MINUTE} req/min)`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  const rec = { ts: Date.now(), label: (caller && caller.label) || 'other', fn: (caller && caller.fn) || '?' };
  _requests.push(rec);
  _recentLog.push(rec);
  while (_recentLog.length > _RECENT_CAP) _recentLog.shift();
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
  const caller = _callerLabel();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await _waitAndRecord(caller);
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
  
  const caller = _callerLabel();
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        await _waitAndRecord(caller);
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
  _prune(now);
  return {
    requestsInLastMinute: _requests.length,
    limit: REQUESTS_PER_MINUTE,
    minIntervalMs: MIN_INTERVAL_MS,
    nextWaitMs: _getWaitTime(),
  };
}

// #3 모니터: 최근 1분 사용량 + 출처별 분해 + 실시간 최근 호출 로그 + 잔량.
function getThrottleMonitor() {
  const now = Date.now();
  _prune(now);
  const byLabelMap = {};
  for (const r of _requests) byLabelMap[r.label] = (byLabelMap[r.label] || 0) + 1;
  const byLabel = Object.entries(byLabelMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  const used = _requests.length;
  return {
    limit: REQUESTS_PER_MINUTE,
    used,
    remaining: Math.max(0, REQUESTS_PER_MINUTE - used),
    pct: Math.round((used / REQUESTS_PER_MINUTE) * 100),
    nextWaitMs: _getWaitTime(),
    minIntervalMs: MIN_INTERVAL_MS,
    byLabel,
    recent: _recentLog.slice(-40).reverse().map(r => ({ ageMs: now - r.ts, label: r.label, fn: r.fn })),
    ts: now,
  };
}

module.exports = {
  throttledCall,
  throttledMap,
  getThrottleStatus,
  getThrottleMonitor,
  // 설정값 노출 (테스트용)
  REQUESTS_PER_MINUTE,
  MIN_INTERVAL_MS,
  DEFAULT_CONCURRENCY,
};
