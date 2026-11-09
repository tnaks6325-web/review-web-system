'use strict';
/**
 * 결정 354 「미리 만들기(2026-11-09)」 — 사진 빠른 길의 작은 사진(t)을 첫 조회 **전에** R2 에 만들어 둔다.
 *
 *   운영 실측: 아무도 안 본 사진의 첫 조회 1.7~2.8초(드라이브 원본 → WebP) · R2/엣지에 있으면 0.04~0.07초.
 *
 *   ★ 원본 서버(Railway)는 R2 에 직접 쓸 수 없다(S3 토큰 없음). 그래서 「미리 만들기」 = 서버가 자기 서명으로
 *     프론트 사이트의 `/img/t/<id>?e=&s=`(Pages Function)를 GET 한다 → Function 이 평소 첫 조회와 똑같이
 *     내부 입구에서 받아 R2 에 담는다(자기 호출). 새 저장 경로·새 비밀이 없다.
 *
 *   scheduleUploadWarm(id, mime) — drive.service.uploadFileBase64 가 업로드 성공 뒤 부르는 **단일 지점**.
 *       열쇠(IMG_SIGNING_KEY) 없음·사진 아님·번호 형식 불량 = 아무것도 안 함.
 *       ★ 업로드 직후엔 허용 목록 DB 기록(트랜잭션 커밋)이 아직일 수 있다 → FIRST_DELAY 뒤
 *         imageAllowlist.checkFresh(거절을 기억하지 않는 판정)로 확인하고, 아직이면 RETRY_DELAY 뒤 1회만 다시 본다.
 *         끝내 목록 밖(패배한 중복 파일·시험 업로드)이면 부르지 않는다. 조회 실패(fail-open)도 부르지 않는다.
 *       ★ 응답을 기다리지 않는다 · 실패는 삼키고 경고 로그만(파일 번호 없이) · 동시 WARM_MAX · 대기열 QUEUE_MAX(넘치면 버림).
 *   warmOne(id)                 — 한 장 GET. 응답 X-Img-Src 로 'hit'(r2·edge 이미 있음) / 'made'(origin 새로 만듦) /
 *                                 'skip'(404 — 사진 아님·허용 밖) / 'fail' / 'off'(열쇠 없음) 를 돌려준다.
 *   collectRecentIds(db, {days, limit}) — 일괄 스크립트(scripts/img-warm.js)용: 허용 목록 출처 칸에서 최근 N일 번호를
 *                                 중복 제거·최신순으로(이체결과 보관 파일·삭제된 주문 제외).
 */
const imageEdge = require('./imageEdge.service');
const { logger } = require('../utils/logger');

const DEFAULT_PUBLIC_ORIGIN = 'https://review-web-system.pages.dev';
const WARM_MAX = 2;                 // 업로드 미리 만들기 동시 수(원본 서버 내부 입구 동시 12 안쪽, 화면 첫 조회 몫을 남긴다)
const QUEUE_MAX = 200;
const FIRST_DELAY_MS = 5000;        // 업로드 → 허용 목록 기록(커밋)까지의 여유
const RETRY_DELAY_MS = 45000;       // 리뷰 캡처는 업로드 뒤 AI 판정을 거쳐 기록된다 — 1회만 다시
const FETCH_TIMEOUT_MS = 30000;

const DEFAULT_DEPS = Object.freeze({
  fetch: null,                      // null = 전역 fetch
  checkFresh: null,                 // null = imageAllowlist.checkFresh
  firstDelayMs: FIRST_DELAY_MS,
  retryDelayMs: RETRY_DELAY_MS,
  queueMax: QUEUE_MAX,
});
let _deps = Object.assign({}, DEFAULT_DEPS);
let _active = 0;
const _queue = [];
let _stats = { scheduled: 0, made: 0, hit: 0, skip: 0, failed: 0, dropped: 0, notListed: 0 };

function _fetch() { return _deps.fetch || globalThis.fetch; }
function _checkFresh(id) { return (_deps.checkFresh || require('./imageAllowlist.service').checkFresh)(id); }

function publicOrigin(env = process.env) {
  const raw = String(env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+$/i.test(raw) ? raw : DEFAULT_PUBLIC_ORIGIN;
}

/** 서명된 빠른 길 전체 주소. 열쇠 없으면 null. */
function edgeUrl(fileId, kind = 't', env = process.env) {
  const rel = imageEdge.signImage(fileId, kind);
  return rel ? publicOrigin(env) + rel : null;
}

/** @returns {Promise<'hit'|'made'|'skip'|'fail'|'off'>} — 던지지 않는다 */
async function warmOne(fileId, { fetch: fetchImpl, kind = 't', env = process.env, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = edgeUrl(fileId, kind, env);
  if (!url) return 'off';
  const f = fetchImpl || _fetch();
  try {
    const init = { method: 'GET', headers: { 'User-Agent': 'review-web-img-warm/1' } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeoutMs);
    const r = await f(url, init);
    if (!r) return 'fail';
    try { if (r.arrayBuffer) await r.arrayBuffer(); } catch (_) { /* 몸통은 버린다 */ }
    if (r.status === 404) return 'skip';
    if (r.status !== 200) return 'fail';
    const src = String((r.headers && r.headers.get && r.headers.get('X-Img-Src')) || '').toLowerCase();
    return src === 'r2' || src === 'edge' ? 'hit' : 'made';
  } catch (_) {
    return 'fail';
  }
}

// ── 업로드 미리 만들기 줄(동시 WARM_MAX) ──
function _pump() {
  while (_active < WARM_MAX && _queue.length) {
    const id = _queue.shift();
    _active++;
    warmOne(id).then((res) => {
      if (res === 'made') _stats.made++;
      else if (res === 'hit') _stats.hit++;
      else if (res === 'skip') _stats.skip++;
      else if (res === 'fail') { _stats.failed++; _warn('미리 만들기 실패(첫 조회 때 다시 만든다)'); }
    }).catch(() => { _stats.failed++; }).finally(() => { _active--; _pump(); });
  }
}
function _enqueue(id) {
  if (_queue.length >= _deps.queueMax) { _stats.dropped++; return; }   // 넘치면 버린다(첫 조회 때 만든다)
  _queue.push(id);
  _pump();
}

let _lastWarnAt = 0, _suppressed = 0;
function _warn(msg) {   // ★ 파일 번호는 남기지 않는다
  const now = Date.now();
  if (now - _lastWarnAt < 60 * 1000) { _suppressed++; return; }
  logger.warn(`[img-warm] ${msg}${_suppressed ? ` · 직전 1분 ${_suppressed}건 더` : ''}`);
  _lastWarnAt = now; _suppressed = 0;
}

function _later(ms, fn) {
  const t = setTimeout(fn, ms);
  if (t && t.unref) t.unref();
}

async function _attempt(id, tries) {
  let v;
  try { v = await _checkFresh(id); }
  catch (_) { _stats.failed++; _warn('허용 판정 실패 → 미리 만들기 건너뜀'); return; }
  if (v && v.ok && !v.failOpen) { _enqueue(id); return; }
  if (v && v.failOpen) return;                         // 조회 실패 — 서명 입구와 같이 서명하지 않는다
  if (tries < 1) { _later(_deps.retryDelayMs, () => { _attempt(id, tries + 1).catch(() => {}); }); return; }
  _stats.notListed++;                                  // 끝내 목록 밖 — 부르지 않는다
}

/**
 * drive.service.uploadFileBase64 가 업로드 성공 뒤 부른다(응답을 기다리지 않는다).
 * @returns {boolean} 예약했는가
 */
function scheduleUploadWarm(fileId, mimeType) {
  try {
    if (!imageEdge.signingEnabled()) return false;
    if (!/^image\//i.test(String(mimeType || ''))) return false;    // 이체결과(엑셀·CSV) 등 사진 아닌 파일 제외
    const id = String(fileId || '');
    if (!imageEdge.ID_RE.test(id)) return false;
    _stats.scheduled++;
    _later(_deps.firstDelayMs, () => { _attempt(id, 0).catch(() => {}); });
    return true;
  } catch (_) { return false; }
}

// ── 일괄 스크립트용 출처 표 — 허용 목록(imageAllowlist) 출처 칸 + 그 줄의 시각 칸 ──
//   ★ 허용 목록에 출처가 늘면 회귀가드 imageWarm.test.js E 가 여기에 더하라고 알린다.
const WARM_SOURCES = Object.freeze([
  { table: 'review_submissions', column: 'file_id', at: 'created_at', timeColumns: ['created_at'] },
  { table: 'order_submissions', column: 'capture_file_id', at: 'COALESCE(capture_uploaded_at, submitted_at)',
    where: 'deleted_at IS NULL', timeColumns: ['capture_uploaded_at', 'submitted_at', 'deleted_at'] },
  { table: 'order_submissions', column: 'capture_file_id_2', at: 'COALESCE(capture2_uploaded_at, submitted_at)',
    where: 'deleted_at IS NULL', timeColumns: ['capture2_uploaded_at', 'submitted_at', 'deleted_at'] },
  { table: 'review_index', column: 'review_file_id', at: 'review_file_at', timeColumns: ['review_file_at'] },
  { table: 'review_inspections', column: 'file_id', at: 'created_at', timeColumns: ['created_at'] },
  { table: 'review_edit_requests', column: 'old_file_id', at: 'created_at', timeColumns: ['created_at'] },
  { table: 'review_edit_requests', column: 'new_file_id', at: 'created_at', timeColumns: ['created_at'] },
  { table: 'purchase_capture_artifacts', column: 'file_id', at: 'created_at', timeColumns: ['created_at'] },
  { table: 'purchase_submission_sessions', column: 'capture_file_id', at: 'created_at', timeColumns: ['created_at'] },
  { table: 'reviewer_event_logs', expr: "(context->>'fileId')", at: 'occurred_at', timeColumns: ['occurred_at'] },
  { table: 'guide_image_files', column: 'file_id', at: 'created_at', timeColumns: ['created_at'] },
]);
// 일부러 빼는 출처(이유) — AI 판별 예시는 주소째 몇 장뿐이고 시각 칸이 없다(첫 조회로 충분).
const WARM_SKIPPED = Object.freeze([
  { table: 'app_settings', column: 'value', why: 'AI 판별 예시 — 주소째 저장된 몇 장, 시각 칸 없음' },
]);

function _collectSql() {
  const parts = WARM_SOURCES.map((s) => {
    const col = s.column || s.expr;
    return `SELECT ${col} AS id, ${s.at} AS at FROM ${s.table}
      WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${s.at} >= now() - make_interval(days => $1::int)${s.where ? ` AND ${s.where}` : ''}`;
  });
  const priv = require('./imageAllowlist.service').PRIVATE_SOURCES
    .map(s => `SELECT ${s.column} FROM ${s.table} WHERE ${s.column} IS NOT NULL`).join(' UNION ');
  return `SELECT id FROM (
    ${parts.join('\n    UNION ALL\n    ')}
  ) src
  WHERE id NOT IN (${priv})
  GROUP BY id
  ORDER BY max(at) DESC, id
  LIMIT $2`;
}

/** @returns {Promise<string[]>} 최근 N일 사진 번호(중복 제거·최신순). db = { query(sql, params) } */
async function collectRecentIds(db, { days = 60, limit = 50000 } = {}) {
  const d = Math.max(1, Math.min(3650, Math.floor(Number(days) || 60)));
  const l = Math.max(1, Math.min(500000, Math.floor(Number(limit) || 50000)));
  const r = await db.query(_collectSql(), [d, l]);
  return (r.rows || []).map(x => String(x.id)).filter(x => imageEdge.ID_RE.test(x));
}

module.exports = {
  WARM_MAX, QUEUE_MAX, FIRST_DELAY_MS, RETRY_DELAY_MS, DEFAULT_PUBLIC_ORIGIN,
  WARM_SOURCES, WARM_SKIPPED,
  scheduleUploadWarm, warmOne, edgeUrl, publicOrigin, collectRecentIds,
  __collectSql: _collectSql,
  __setDepsForTest(d) { Object.assign(_deps, d || {}); },
  __resetForTest() {
    _deps = Object.assign({}, DEFAULT_DEPS);
    _queue.length = 0; _active = 0;
    _stats = { scheduled: 0, made: 0, hit: 0, skip: 0, failed: 0, dropped: 0, notListed: 0 };
    _lastWarnAt = 0; _suppressed = 0;
  },
  __stats: () => Object.assign({ active: _active, queued: _queue.length }, _stats),
};
