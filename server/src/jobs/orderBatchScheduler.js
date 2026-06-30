/**
 * orderBatchScheduler.js — 구매주문 시트반영 "상시 배치" 스케줄러 (근실시간, 공정화)
 *
 * 목적: 활성 탭의 order_append를 탭별 배치(가드 1콜 + 쓰기 1콜/청크)로 "상시" 드레인 →
 *   throttle 쿼터 안전 + 단건 대비 수십배 효율로 근실시간 시트반영.
 *
 * 공정화(레드-블루-심판 최종안):
 *  - #1 kick 타깃팅: 제출 시 kickOrderBatch(sheetId,tabName) → 그 탭이 글로벌 우선순위 밖이어도
 *    이 사이클에 "직접" 드레인(_kickQueue 우선처리) → 소량/저빈도 탭 18~20분 지연 제거.
 *  - #2 공정 선정: 건수순(count DESC) → "가장 오래 기다린 미반영 주문(min_ready)" FIFO + 대량탭 보장슬롯
 *    + 라운드로빈 커서(전탭 순회 보장 — top-N 반복편향/기아 제거).
 *  - busy(throttle>임계)면 전체 양보 대신 "oldest 1탭만" 처리(자가 throttle 봉쇄 회피).
 *
 * 각 탭은 검증된 drainTabQueueBatched(advisory lock 직렬화·멱등·손실0·markWritten 후행)로 처리.
 *
 * 게이트: ORDER_BATCH_AUTO=1 일 때만 활성. 미설정 시 no-op(기존 펌프/30초 cron = 되돌리기).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

const TICK_MAX_MS   = parseInt(process.env.ORDER_BATCH_TICK_MAX_MS || '25000', 10);  // 한 사이클 총상한
const PER_TAB_MS    = parseInt(process.env.ORDER_BATCH_PER_TAB_MS  || '12000', 10);  // 탭당 드레인 상한
const MAX_TABS      = parseInt(process.env.ORDER_BATCH_MAX_TABS    || '10', 10);     // 사이클당 탭 수
const BACKLOG_SLOTS = parseInt(process.env.ORDER_BATCH_BACKLOG_SLOTS || '3', 10);    // 대량탭 보장슬롯(기아 반대전이 방지)
// ── 인터리브(다탭 공평 드레인) — env 게이트(끄면 기존 순차 _cycle). 30탭 스태거드 버스트 공평성. ──
const INTERLEAVE        = process.env.ORDER_BATCH_INTERLEAVE === '1';
const INTERLEAVE_MAX_MS = parseInt(process.env.ORDER_BATCH_INTERLEAVE_MAX_MS || '20000', 10); // ≤ TICK_MAX_MS
const EMPTY_ROUNDS_DROP = parseInt(process.env.ORDER_BATCH_EMPTY_ROUNDS_DROP || '2', 10);     // 연속 빈 라운드 N회면 라운드서 제외
const BUSY_THRESHOLD    = parseInt(process.env.ORDER_BATCH_BUSY_THRESHOLD || '40', 10);

let _running = false, _rerun = false, _rrCursor = 0;
let _rrKey = null;                          // R6: 인터리브용 키기반 RR 커서(가변정렬 안전)
let _lastTickAt = 0, _cycleStartAt = 0;   // F3 워치독: 마지막 사이클 완료/시작 시각
const _kickQueue = [];   // #1: 타깃 탭 대기열(중복제거)

// ── 진단: 사이클 이력 링버퍼(인터리브 기아 디버그용). getDiag()/order-batch-state로 관찰. ──
let _cycleSeq = 0;
const _HISTORY_CAP = 40;
const _history = [];
function _record(e) {
  _history.push(e);
  while (_history.length > _HISTORY_CAP) _history.shift();
}

function isAutoEnabled() { return process.env.ORDER_BATCH_AUTO === '1'; }

// #2: 미반영 탭 선정 — FIFO(가장 오래 기다린 주문) + count 보장슬롯.
//   ★ sort_key=MIN(submitted_at) (상태 무관). pending_no_row도 reconcile(DB-only, 시트콜0)이 행을 주면
//   바로 빠지므로 디프라이오리티하면 안 됨(그러면 버스트 pending_no_row 다발 탭이 기아 → 무한지연).
async function _selectTabs() {
  const { rows } = await pool.query(
    `SELECT sheet_id, tab_name, COUNT(*)::int AS c,
            MIN(submitted_at) AS sort_key
       FROM order_submissions
      WHERE deleted_at IS NULL
        AND mirror_status IN ('pending','pending_no_row','queued','failed')
        AND sheet_id IS NOT NULL AND tab_name IS NOT NULL AND tab_name <> ''
      GROUP BY sheet_id, tab_name
      ORDER BY sort_key ASC`
  );
  if (!rows.length) return [];
  const fifoN = Math.max(1, MAX_TABS - BACKLOG_SLOTS);
  const picked = new Map();
  for (const r of rows.slice(0, fifoN)) picked.set(`${r.sheet_id}||${r.tab_name}`, r);  // FIFO 상위
  for (const r of [...rows].sort((a, b) => b.c - a.c)) {                                 // 보장슬롯: 대량탭
    if (picked.size >= MAX_TABS) break;
    picked.set(`${r.sheet_id}||${r.tab_name}`, r);
  }
  return [...picked.values()];
}

// 인터리브 전용 reconcile: 사이클당 탭별 1회(R1·R7·R8·R10). 락 busy면 양보(다른 경로가 reconcile 중) — 다음 사이클 재시도.
async function _reconcileOnce(sheetId, tabName, reconciledSet) {
  const key = `${sheetId}||${tabName}`;
  if (reconciledSet.has(key)) return;
  reconciledSet.add(key);                   // busy로 양보돼도 이번 사이클은 마크(다음 사이클 새 Set으로 재시도)
  const { withJobLock } = require('../utils/jobLock');
  await withJobLock('order_reconcile', async () => {
    try {
      const { reconcileStuckOrders } = require('../services/orderLedger.service');
      await reconcileStuckOrders({ sheetId, tabName, limit: 300, perTabCap: 60, useLiveMaxRow: true });
    } catch (e) { logger.warn(`[orderBatch] reconcileOnce 실패(무시): ${e && e.message}`); }
  }, { onBusy: () => null });
}

// 다탭 인터리브 드레인: 탭마다 1청크씩 라운드로빈(공평). reconcile는 탭당 사이클 1회.
async function _cycleInterleave() {
  const start = Date.now();
  const seq = ++_cycleSeq;
  const { drainTabQueueBatched } = require('../services/syncQueue.service');
  let drained = 0, succeeded = 0, rounds = 0;
  const reconciled = new Set();
  const perTab = {};                                  // 진단: tabName → 청크처리수
  const bump = (name, n) => { perTab[name] = (perTab[name] || 0) + (n || 0); };
  const beat = () => { _lastTickAt = Date.now(); };   // J-A: 사이클 길어도 heartbeat 갱신(cron 단건 백스톱 오발동 차단)

  // busy면 인터리브 대신 oldest-1탭만(자가 throttle 봉쇄 회피 — 기존 안전망 보존).
  let busy = false, throttleStart = -1;
  try {
    const { getThrottleStatus } = require('../utils/sheetsThrottle');
    throttleStart = getThrottleStatus().requestsInLastMinute;
    busy = throttleStart > BUSY_THRESHOLD;
  } catch (_) {}

  const active = new Map();   // tabKey → {sheetId,tabName,emptyStreak}
  const addTab = (sheetId, tabName) => {
    const key = `${sheetId}||${tabName}`;
    if (!active.has(key)) active.set(key, { sheetId, tabName, emptyStreak: 0 });
    return key;
  };
  let kickLen = _kickQueue.length;
  while (_kickQueue.length) {                // 진입 시 kick 1회 흡수
    const k = _kickQueue.shift();
    const sep = k.indexOf('||'); addTab(k.slice(0, sep), k.slice(sep + 2));
  }
  for (const r of await _selectTabs()) addTab(r.sheet_id, r.tab_name);
  const tabName = (k) => { const s = k.indexOf('||'); return k.slice(s + 2); };
  const activeNames = [...active.keys()].map(tabName);
  if (!active.size) {
    _record({ seq, mode: 'empty', busy, throttleStart, kickLen, activeTabs: [], perTab: {}, rounds: 0, durationMs: Date.now() - start });
    return { tabs: 0, drained: 0, succeeded: 0 };
  }

  if (busy) {                                // busy: 인터리브 폴백 = oldest(첫 active) 1탭만
    const first = active.values().next().value;
    await _reconcileOnce(first.sheetId, first.tabName, reconciled);
    try {
      const res = await drainTabQueueBatched({ sheetId: first.sheetId, tabName: first.tabName,
        maxMillis: PER_TAB_MS, oneChunk: false, runReconcileFirst: false });
      if (res && res.succeeded) { succeeded += res.succeeded; bump(first.tabName, res.succeeded); }
    } catch (e) { logger.warn(`[orderBatchTick] busy 1탭 실패(무시): ${e && e.message}`); }
    beat();
    if (succeeded) logger.info(`[orderBatchTick] interleave-busy 1탭, ${succeeded}건 반영`);
    _record({ seq, mode: 'busy', busy, throttleStart, kickLen, activeTabs: activeNames, perTab, rounds: 1, durationMs: Date.now() - start, succeeded });
    return { tabs: active.size, drained: 1, succeeded, mode: 'busy' };
  }

  // R6: 마지막 처리 키 다음부터 시작하도록 키 배열 회전.
  let keys = [...active.keys()];
  if (_rrKey) {
    const idx = keys.indexOf(_rrKey);
    if (idx >= 0) keys = keys.slice(idx + 1).concat(keys.slice(0, idx + 1));
  }

  let lastKey = _rrKey;
  while (Date.now() - start < INTERLEAVE_MAX_MS && keys.length) {
    rounds++;
    while (_kickQueue.length) {              // 라운드 중 신규 kick 합류(R3 race 완화)
      const k = _kickQueue.shift();
      const sep = k.indexOf('||'); const nk = addTab(k.slice(0, sep), k.slice(sep + 2));
      if (!keys.includes(nk)) keys.push(nk);
    }
    const nextKeys = [];
    let quotaHit = false;
    for (const key of keys) {
      if (Date.now() - start > INTERLEAVE_MAX_MS) { nextKeys.push(key); continue; }
      const t = active.get(key);
      if (!t) continue;
      await _reconcileOnce(t.sheetId, t.tabName, reconciled);
      let res = null;
      try {
        res = await drainTabQueueBatched({ sheetId: t.sheetId, tabName: t.tabName,
          maxMillis: PER_TAB_MS, oneChunk: true, runReconcileFirst: false });  // R1: reconcile 분리
      } catch (e) { logger.warn(`[orderBatchTick] tab=${t.tabName} 청크 실패(무시): ${e && e.message}`); }
      drained++; lastKey = key; beat();     // J-A: 청크마다 heartbeat
      if (res && res.succeeded) { succeeded += res.succeeded; bump(t.tabName, res.succeeded); }
      if (res && res.skipped) { nextKeys.push(key); continue; }        // 락 busy → 다음 라운드
      if (res && res.quotaExceeded) {                                  // R5: 전체 라운드 즉시 중단
        quotaHit = true;
        // J-B: 미처리 잔여(이 키 포함 이후) kick 즉시성 보존 — active 키를 _kickQueue로 복원.
        for (const rk of nextKeys) if (!_kickQueue.includes(rk)) _kickQueue.push(rk);
        if (!_kickQueue.includes(key)) _kickQueue.push(key);
        break;
      }
      if (res && res.emptied) {
        t.emptyStreak++;
        if (t.emptyStreak < EMPTY_ROUNDS_DROP) nextKeys.push(key);     // 아직 완료 단정 안 함
      } else { t.emptyStreak = 0; nextKeys.push(key); }
    }
    if (quotaHit) { _rrKey = lastKey; logger.info(`[orderBatchTick] interleave quota: ${drained}청크, ${succeeded}건`); _record({ seq, mode: 'quota', busy, throttleStart, kickLen, activeTabs: activeNames, perTab, rounds, durationMs: Date.now() - start, succeeded }); return { tabs: active.size, drained, succeeded, mode: 'quota' }; }
    keys = nextKeys;
  }
  _rrKey = lastKey;
  if (succeeded) logger.info(`[orderBatchTick] interleave ${drained}청크, ${succeeded}건 반영`);
  _record({ seq, mode: 'interleave', busy, throttleStart, kickLen, activeTabs: activeNames, perTab, rounds, durationMs: Date.now() - start, succeeded, exit: keys.length ? 'timecap' : 'drained' });
  return { tabs: active.size, drained, succeeded, mode: 'interleave' };
}

async function _cycle() {
  if (INTERLEAVE) return _cycleInterleave();      // 인터리브 게이트(끄면 아래 기존 순차 경로)
  const start = Date.now();
  const { drainTabQueueBatched } = require('../services/syncQueue.service');
  let drained = 0, succeeded = 0;
  const seen = new Set();
  const drainOne = async (sheetId, tabName) => {
    const key = `${sheetId}||${tabName}`;
    if (seen.has(key)) return null;
    seen.add(key);
    try {
      const res = await drainTabQueueBatched({ sheetId, tabName, maxMillis: PER_TAB_MS });
      drained++;
      if (res && res.succeeded) succeeded += res.succeeded;
      return res;
    } catch (e) {
      logger.warn(`[orderBatchTick] tab=${tabName} 드레인 실패(무시): ${e && e.message}`);
      return null;
    }
  };

  // #1: 타깃 큐 먼저(제출 즉시성). busy여도 제출자 탭은 처리.
  const targets = [];
  while (_kickQueue.length) targets.push(_kickQueue.shift());
  for (const key of targets) {
    if (Date.now() - start > TICK_MAX_MS) { if (!_kickQueue.includes(key)) _kickQueue.push(key); continue; }
    const sep = key.indexOf('||');
    const sheetId = key.slice(0, sep), tabName = key.slice(sep + 2);
    const res = await drainOne(sheetId, tabName);
    if (res && res.skipped && !_kickQueue.includes(key)) _kickQueue.push(key);  // 락 busy면 되돌림(다음 tick)
  }

  // busy면 전체 양보 대신 oldest 1탭만(자가 throttle 봉쇄 회피).
  let busy = false;
  try {
    const { getThrottleStatus } = require('../utils/sheetsThrottle');
    busy = getThrottleStatus().requestsInLastMinute >
           parseInt(process.env.ORDER_BATCH_BUSY_THRESHOLD || '40', 10);
  } catch (_) { /* 조회 실패는 무시 */ }

  const tabs = await _selectTabs();
  if (busy) {
    if (tabs[0]) await drainOne(tabs[0].sheet_id, tabs[0].tab_name);
    if (succeeded) logger.info(`[orderBatchTick] busy: ${drained}탭, ${succeeded}건 반영`);
    return { tabs: tabs.length, drained, succeeded, mode: 'busy' };
  }

  // #2: 라운드로빈 커서로 시작점 회전 → 전탭 순회 보장(top-N 반복편향 제거).
  const n = tabs.length;
  for (let i = 0; i < n; i++) {
    if (Date.now() - start > TICK_MAX_MS) break;
    const r = tabs[(_rrCursor + i) % n];
    await drainOne(r.sheet_id, r.tab_name);
  }
  if (n) _rrCursor = (_rrCursor + 1) % n;
  if (succeeded) logger.info(`[orderBatchTick] ${drained}탭 드레인, ${succeeded}건 반영`);
  return { tabs: n, drained, succeeded };
}

// 비차단 코얼레싱 kick. 인자(sheetId,tabName) 있으면 타깃 큐 적재(제출 즉시성), 없으면 순수 백스톱(15초 cron).
function kickOrderBatch(sheetId, tabName) {
  if (!isAutoEnabled()) return;
  if (sheetId && tabName) {
    const key = `${sheetId}||${tabName}`;
    if (!_kickQueue.includes(key)) _kickQueue.push(key);
  }
  // ★ R-F3-a 워치독: _running이 시작 후 TICK_MAX_MS*3 넘게 true면 데드(미처리 예외·OOM·재시작) 판정 →
  //   강제 리셋. 안 하면 kick이 영구 no-op(_rerun만 set) + AUTO=1이라 30초 cron도 order_append 제외 = 영구정지.
  const _cycleCap = INTERLEAVE ? Math.max(INTERLEAVE_MAX_MS, TICK_MAX_MS) : TICK_MAX_MS;
  if (_running && _cycleStartAt && (Date.now() - _cycleStartAt > _cycleCap * 3)) {
    logger.warn(`[orderBatch] _running stale ${Date.now() - _cycleStartAt}ms → 강제 리셋(워치독)`);
    _running = false;
  }
  if (_running) { _rerun = true; return; }
  _running = true; _cycleStartAt = Date.now();
  setImmediate(async () => {
    try { await _cycle(); _lastTickAt = Date.now(); }
    catch (e) { logger.warn(`[orderBatchTick] 사이클 오류(무시): ${e && e.message}`); }
    finally { _running = false; _cycleStartAt = 0; if (_rerun) { _rerun = false; kickOrderBatch(); } }
  });
}

// F3 백스톱용: cron이 배치 생존(heartbeat)을 확인 → 끊겼으면 단건 백스톱 가동.
function getHeartbeat() { return { running: _running, lastTickAt: _lastTickAt, cycleStartAt: _cycleStartAt }; }

// 진단: 스케줄러 내부상태 + 사이클 이력(인터리브 기아 디버그용).
function getDiag() {
  return {
    now: Date.now(), interleave: INTERLEAVE, running: _running, rerun: _rerun,
    cycleStartAt: _cycleStartAt, lastTickAt: _lastTickAt, rrKey: _rrKey,
    kickQueueLen: _kickQueue.length, kickQueue: _kickQueue.slice(0, 20),
    cycleSeq: _cycleSeq, history: _history.slice(-30),
    cfg: { INTERLEAVE_MAX_MS, TICK_MAX_MS, PER_TAB_MS, BUSY_THRESHOLD, EMPTY_ROUNDS_DROP, MAX_TABS, BACKLOG_SLOTS },
  };
}

module.exports = { kickOrderBatch, isAutoEnabled, _cycle, _selectTabs, getHeartbeat, getDiag };
