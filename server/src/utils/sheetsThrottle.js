/**
 * Google Sheets/Drive API 호출 속도 제한 (Throttle) — lane 분리
 *
 * Google API quota: Sheets 분당 60 읽기/사용자 → 안전마진 45. Drive는 별도 쿼터(훨씬 큼) → 120.
 *
 * lane:
 *   - sheets lane(45/분): spreadsheets.* 전용. ORDER_RESERVE(8)·저우선 서브캡·getThrottleStatus()
 *     시맨틱 완전 불변 — busy-gate 소비처(cron.js, queuePump.js, orderBatchScheduler.js,
 *     syncQueue.service.js, orderLedger.service.js, diag.routes.js)가 "시트 lane 여유"로 해석한다.
 *   - drive lane(120/분): drive.files.get(modifiedTime)/drive.permissions.* 전용. 평평한 cap
 *     (priority 서브캡/_LOW_PRIORITY_LABELS 미적용). 시트 lane을 오점유하지 않는다.
 *
 * 주요 기능:
 *   1. throttledCall(fn)       — 시트 API 1회 (retry/backoff)
 *   2. driveThrottledCall(fn)  — Drive API 1회 (동일 retry/backoff, drive lane 기록)
 *   3. throttledMap(items, fn, c)  — [레거시] map 레벨에서 항목당 1슬롯 선기록
 *   4. concurrentMap(items, fn, c) — 슬롯 기록 없는 순수 동시성 map(allSettled 동일 형태).
 *        fn 내부가 스스로 throttledCall/driveThrottledCall 하는 호출처 전용(팬텀 슬롯 0).
 *
 * ⚠️ 계약: lane 로직은 반드시 이 파일 안에 둘 것 — _callerLabel()의 프레임스킵이
 *   'sheetsThrottle.js' 파일명 하드매칭이라 새 파일로 분리하면 전 호출이 오귀속된다.
 */

const { logger } = require('./logger');

// ═══════════════════════════════════════════════════════════
// 설정
// ═══════════════════════════════════════════════════════════

// env 가드: 0/음수/NaN → 기본값 (misconfig가 대기계산 크래시로 번지지 않게)
function _posInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const REQUESTS_PER_MINUTE = _posInt(process.env.SHEETS_REQUESTS_PER_MINUTE, 45);  // 안전 마진 (실제 한도 60)
const MIN_INTERVAL_MS = Math.ceil(60000 / REQUESTS_PER_MINUTE); // ≈ 1334ms
const DEFAULT_CONCURRENCY = 3;   // 동시 처리 수 (3개씩 → 간격 유지)

// ── Drive lane 분리: drive.files.get/permissions.* 는 Drive API 쿼터(사용자당 한도가 시트보다 훨씬 큼).
//    시트 lane(45/분)을 오점유하던 getSheetModifiedTime/shareSheetWithServiceAccount 를 여기로 이관.
const DRIVE_REQUESTS_PER_MINUTE = _posInt(process.env.DRIVE_REQUESTS_PER_MINUTE, 120);
const DRIVE_MIN_INTERVAL_MS = Math.ceil(60000 / DRIVE_REQUESTS_PER_MINUTE); // ≈ 500ms

// ── 버그2: order_append 기아 방지 — 저우선 서브캡. 원본 시맨틱 불변(0 허용 = 되돌리기 게이트). ──
const ORDER_RESERVE = parseInt(process.env.SHEETS_ORDER_RESERVE || '8', 10);
// 'RAW미러'를 low-priority 기본값에 추가 — 미러가 주문 예약 8슬롯을 못 침범(시트 lane에만 적용).
//   원복: SHEETS_LOW_PRIORITY_LABELS=리뷰인덱스빌드
const _LOW_PRIORITY_LABELS = new Set(
  (process.env.SHEETS_LOW_PRIORITY_LABELS || '리뷰인덱스빌드,RAW미러').split(',').map(s => s.trim()).filter(Boolean)
);
function _effectiveCap(priority) {
  if (priority === 'low' && ORDER_RESERVE > 0) return Math.max(1, REQUESTS_PER_MINUTE - ORDER_RESERVE);
  return REQUESTS_PER_MINUTE;   // normal/high(또는 미지정) → 45 전량
}

// 슬라이딩 윈도우 + 최근 로그 — lane별 분리(drive 트래픽이 시트 윈도우/로그를 오염시키지 않음)
const _requests = [];
const _recentLog = [];
const _driveRequests = [];
const _driveRecentLog = [];
const _RECENT_CAP = 120;

// lane 기술자 — cap/간격/버퍼가 전부 lane 객체 경유(시트 상수 하드바인딩 차단)
const _SHEETS_LANE = {
  name: 'sheets', requests: _requests, recentLog: _recentLog,
  minIntervalMs: MIN_INTERVAL_MS,
  cap: (priority) => _effectiveCap(priority),
  limit: REQUESTS_PER_MINUTE,
};
const _DRIVE_LANE = {
  name: 'drive', requests: _driveRequests, recentLog: _driveRecentLog,
  minIntervalMs: DRIVE_MIN_INTERVAL_MS,
  cap: () => DRIVE_REQUESTS_PER_MINUTE,   // 평평한 cap — 서브캡 없음
  limit: DRIVE_REQUESTS_PER_MINUTE,
};

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

function _pruneLane(lane, now) {
  const arr = lane.requests;
  while (arr.length > 0 && arr[0].ts < now - 60000) arr.shift();
}
function _prune(now) { _pruneLane(_SHEETS_LANE, now); } // 하위호환

/**
 * 다음 API 호출까지 대기해야 하는 시간(ms) 계산 (lane별 슬라이딩 윈도우)
 */
function _getWaitTimeLane(lane, priority) {
  const now = Date.now();
  _pruneLane(lane, now);
  const arr = lane.requests;
  const cap = lane.cap(priority);
  if (arr.length < cap) {
    if (arr.length > 0) {
      const sinceLastReq = now - arr[arr.length - 1].ts;
      if (sinceLastReq < lane.minIntervalMs) return lane.minIntervalMs - sinceLastReq;
    }
    return 0;
  }
  if (arr.length === 0) return 0; // cap<=0 misconfig에서도 arr[0] 접근 크래시 방지
  return (arr[0].ts + 60000) - now + 100; // +100ms 여유
}
function _getWaitTime(priority) { return _getWaitTimeLane(_SHEETS_LANE, priority); }  // 기존 시그니처/테스트 계약 유지
function _getDriveWaitTime() { return _getWaitTimeLane(_DRIVE_LANE); }                // 테스트용(lane 격리 검증)

/**
 * 대기 후 타임스탬프+라벨 기록 (lane별)
 */
async function _waitAndRecordLane(lane, caller, priority) {
  const waitMs = _getWaitTimeLane(lane, priority);
  if (waitMs > 0) {
    logger.debug(`[throttle:${lane.name}] API 호출 대기 ${waitMs}ms (현재 ${lane.requests.length}/${lane.limit} req/min, prio=${priority || 'normal'})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  const rec = { ts: Date.now(), label: (caller && caller.label) || 'other', fn: (caller && caller.fn) || '?', priority: priority || 'normal', lane: lane.name };
  lane.requests.push(rec);
  lane.recentLog.push(rec);
  while (lane.recentLog.length > _RECENT_CAP) lane.recentLog.shift();
}
async function _waitAndRecord(caller, priority) { return _waitAndRecordLane(_SHEETS_LANE, caller, priority); } // 하위호환(throttledMap)

// ═══════════════════════════════════════════════════════════
// 공개 API
// ═══════════════════════════════════════════════════════════

async function _throttledCallOnLane(lane, fn, maxRetries = 2, opts = {}) {
  const caller = _callerLabel(); // 이 파일 내 프레임은 전부 스킵됨(파일 분리 금지 전제)
  // drive lane은 서브캡 없음 — 'RAW미러'/'리뷰인덱스빌드' 라벨이어도 감속하지 않는다.
  const priority = lane === _DRIVE_LANE
    ? 'normal'
    : ((opts && opts.priority) || (_LOW_PRIORITY_LABELS.has(caller.label) ? 'low' : 'normal'));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await _waitAndRecordLane(lane, caller, priority);
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.response?.status || err?.status;
      const isRetryable = [429, 500, 503, 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(status)
        || (typeof err.message === 'string' && /rate limit|quota|timeout|ECONNRESET/i.test(err.message));

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 10000); // 2s, 4s, max 10s
        logger.warn(`[throttle:${lane.name}] API 호출 실패 (attempt ${attempt + 1}/${maxRetries + 1}), ${delay}ms 후 재시도: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * 단일 Google Sheets API 호출을 throttle로 감싸기 (retry with backoff 포함)
 * 사용법: const meta = await throttledCall(() => getSpreadsheetMeta(sheetId));
 */
async function throttledCall(fn, maxRetries = 2, opts = {}) {
  return _throttledCallOnLane(_SHEETS_LANE, fn, maxRetries, opts);
}

/**
 * 단일 Google Drive API 호출 (getSheetModifiedTime/permissions 등) — drive lane 기록.
 * 시트 윈도우 미기록 = busy-gate(getThrottleStatus) 오염 0.
 */
async function driveThrottledCall(fn, maxRetries = 2, opts = {}) {
  return _throttledCallOnLane(_DRIVE_LANE, fn, maxRetries, opts);
}

/**
 * [레거시] 배열 항목들을 동시성 제한 + map 레벨 슬롯 기록으로 처리.
 * fn 내부에 자체 throttledCall이 없는 호출처 전용. (신규 코드는 concurrentMap + 내부 *ThrottledCall 권장)
 */
async function throttledMap(items, fn, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const caller = _callerLabel();
  const priority = _LOW_PRIORITY_LABELS.has(caller.label) ? 'low' : 'normal';
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        await _waitAndRecord(caller, priority);
        results[idx] = { status: 'fulfilled', value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * 슬롯 기록 없는 순수 동시성 map — fn 내부가 스스로 throttledCall/driveThrottledCall을 하는
 * 호출처 전용(팬텀 슬롯 제거). 반환형·인덱스 보존·항목별 실패 격리는 throttledMap과 동일 계약.
 */
async function concurrentMap(items, fn, concurrency = DEFAULT_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * 현재 throttle 상태 조회 (busy-gate/디버깅용)
 * ⚠️ 계약: 시트 lane 전용 — busy-gate(cron.js, queuePump.js, orderBatchScheduler.js,
 *   syncQueue.service.js, orderLedger.service.js, diag.routes.js)와 테스트 mock이
 *   "시트 lane 여유"로 해석한다. drive 필드를 여기 추가하지 말 것(모니터는 getThrottleMonitor).
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

// #3 모니터: 시트 lane(기존 필드 완전 불변) + drive lane 하위객체(신규).
function getThrottleMonitor() {
  const now = Date.now();
  _pruneLane(_SHEETS_LANE, now);
  _pruneLane(_DRIVE_LANE, now);
  const byLabelMap = {};
  for (const r of _requests) byLabelMap[r.label] = (byLabelMap[r.label] || 0) + 1;
  const byLabel = Object.entries(byLabelMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  const used = _requests.length;

  const dByLabelMap = {};
  for (const r of _driveRequests) dByLabelMap[r.label] = (dByLabelMap[r.label] || 0) + 1;
  const dUsed = _driveRequests.length;

  return {
    // ── 시트 lane: 기존 필드/의미 완전 불변(구프론트/iframe 하위호환) ──
    limit: REQUESTS_PER_MINUTE,
    used,
    remaining: Math.max(0, REQUESTS_PER_MINUTE - used),
    pct: Math.round((used / REQUESTS_PER_MINUTE) * 100),
    nextWaitMs: _getWaitTime(),
    minIntervalMs: MIN_INTERVAL_MS,
    reserve: ORDER_RESERVE, lowCap: _effectiveCap('low'),
    byLabel,
    recent: _recentLog.slice(-40).reverse().map(r => ({ ageMs: now - r.ts, label: r.label, fn: r.fn, priority: r.priority, lane: 'sheets' })),
    // ── drive lane: 신규 하위객체(별도 로그 버퍼 = 시트 로그 잠식 없음) ──
    drive: {
      limit: DRIVE_REQUESTS_PER_MINUTE,
      used: dUsed,
      remaining: Math.max(0, DRIVE_REQUESTS_PER_MINUTE - dUsed),
      pct: Math.round((dUsed / DRIVE_REQUESTS_PER_MINUTE) * 100),
      nextWaitMs: _getDriveWaitTime(),
      minIntervalMs: DRIVE_MIN_INTERVAL_MS,
      byLabel: Object.entries(dByLabelMap).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
      recent: _driveRecentLog.slice(-20).reverse().map(r => ({ ageMs: now - r.ts, label: r.label, fn: r.fn, lane: 'drive' })),
    },
    ts: now,
  };
}

module.exports = {
  throttledCall,
  driveThrottledCall,       // 신설: Drive API lane
  throttledMap,             // 하위호환 유지(tabconfig.routes.js import 포함)
  concurrentMap,            // 신설: 무기록 동시성 map
  getThrottleStatus,
  getThrottleMonitor,
  // 설정값 노출 (테스트용)
  REQUESTS_PER_MINUTE,
  MIN_INTERVAL_MS,
  DRIVE_REQUESTS_PER_MINUTE,
  DRIVE_MIN_INTERVAL_MS,
  DEFAULT_CONCURRENCY,
  _effectiveCap,            // 테스트용(cap 검증)
  _getWaitTime,             // 테스트용(wait 검증)
  _getDriveWaitTime,        // 테스트용(lane 격리 검증)
  __injectRequests,         // 테스트훅
  __injectDriveRequests,    // 테스트훅(drive lane)
  __resetForTest,           // 테스트훅
};

// 테스트훅 (호이스팅되는 function 선언이므로 export 뒤 정의 무방)
function __injectRequests(n, ageMs = 5000) {
  const now = Date.now();
  for (let i = 0; i < n; i++) _requests.push({ ts: now - ageMs, label: 'test', fn: 'test', priority: 'test', lane: 'sheets' });
}
function __injectDriveRequests(n, ageMs = 5000) {
  const now = Date.now();
  for (let i = 0; i < n; i++) _driveRequests.push({ ts: now - ageMs, label: 'test', fn: 'test', priority: 'test', lane: 'drive' });
}
function __resetForTest() {
  _requests.length = 0; _recentLog.length = 0;
  _driveRequests.length = 0; _driveRecentLog.length = 0;
}
