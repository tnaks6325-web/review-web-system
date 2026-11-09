'use strict';
/**
 * 결정 354 「모든 사진 미리 만들기 · 원본 빠른 길(2026-11-09)」 — 내부 생성 입구의 **원본 바이트 짧은 메모리 캐시**.
 *
 *   같은 사진을 t → m → o 로 연달아 만들 때(업로드 직후 미리 만들기·일괄 스크립트·한 화면의 첫 조회) 드라이브를
 *   세 번 읽지 않게 한다(드라이브 1회 = 1.2~2.8초).
 *
 *   get(id, loader) — 살아 있는 사본이 있으면 그것, 같은 번호를 읽는 중이면 그 읽기를 함께 기다린다(동시 요청 합치기),
 *                     아니면 loader(id) 1회. 실패는 기억하지 않는다(다음 요청이 다시 읽는다).
 *
 *   ★ 수명 TTL_MS(30초) — 미리 만들기 한 장분(t·m·o)이 끝날 만큼만. 오래 두는 캐시가 아니다
 *     (결정 008 「서버 캐시는 두지 않는다 · 필요하면 총량 상한을 둔 작은 LRU」의 그 작은 LRU).
 *   ★ 총량 MAX_BYTES(64MB) — 넘으면 가장 오래 안 쓴 것부터 버린다. 한 장이 내부 입구 상한(25MB)을 넘으면 담지 않는다.
 *   ★ 돌려주는 객체는 여럿이 함께 쓴다 — 호출 쪽은 buffer 를 고치지 않는다(makeThumb·send 는 읽기만).
 *   ★ 허용 판정은 이 앞(내부 입구)에서 끝난다 — 이 캐시는 판정을 대신하지 않는다(허용 밖은 여기까지 오지 않는다).
 */
const TTL_MS = 30 * 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;   // = imageEdge.MAX_SOURCE_BYTES(순환 require 피하려고 값만 같게 — 회귀가드가 대조)

let _cfg = { ttlMs: TTL_MS, maxBytes: MAX_BYTES };
let _map = new Map();          // id → { at, f, size }   (Map 순서 = 최근 사용 순)
let _inflight = new Map();     // id → Promise
let _bytes = 0;
let _stats = { hits: 0, joins: 0, loads: 0 };
let _sweepTimer = null;

function _size(f) { return (f && f.buffer && f.buffer.length) || 0; }
function _drop(id) {
  const c = _map.get(id);
  if (!c) return;
  _map.delete(id);
  _bytes -= c.size;
}
function _sweep(now = Date.now()) {
  for (const [id, c] of _map) if (now - c.at >= _cfg.ttlMs) _drop(id);
}
function _scheduleSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setTimeout(() => { _sweepTimer = null; _sweep(); if (_map.size) _scheduleSweep(); }, _cfg.ttlMs + 50);
  if (_sweepTimer.unref) _sweepTimer.unref();
}
function _put(id, f) {
  const size = _size(f);
  if (!size || size > MAX_ENTRY_BYTES || size > _cfg.maxBytes) return;
  _drop(id);
  while (_map.size && _bytes + size > _cfg.maxBytes) _drop(_map.keys().next().value);   // 가장 오래 안 쓴 것부터
  _map.set(id, { at: Date.now(), f, size });
  _bytes += size;
  _scheduleSweep();
}

/** @returns {Promise<{buffer:Buffer, mimeType:string, name:string}>} */
function get(id, loader) {
  const key = String(id || '');
  const now = Date.now();
  const c = _map.get(key);
  if (c) {
    if (now - c.at < _cfg.ttlMs) {
      _map.delete(key); _map.set(key, c);        // 최근 사용으로(수명은 처음 읽은 때부터 — 늘리지 않는다)
      _stats.hits++;
      return Promise.resolve(c.f);
    }
    _drop(key);
  }
  const running = _inflight.get(key);
  if (running) { _stats.joins++; return running; }
  _stats.loads++;
  const p = Promise.resolve()
    .then(() => loader(key))
    .then((f) => { _put(key, f); return f; })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  return p;
}

module.exports = {
  TTL_MS, MAX_BYTES, MAX_ENTRY_BYTES,
  get,
  __setForTest(o) { Object.assign(_cfg, o || {}); },
  __resetForTest() {
    _cfg = { ttlMs: TTL_MS, maxBytes: MAX_BYTES };
    _map = new Map(); _inflight = new Map(); _bytes = 0;
    _stats = { hits: 0, joins: 0, loads: 0 };
    if (_sweepTimer) { clearTimeout(_sweepTimer); _sweepTimer = null; }
  },
  __stats: () => Object.assign({ entries: _map.size, bytes: _bytes, inflight: _inflight.size }, _stats),
};
