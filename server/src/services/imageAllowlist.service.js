'use strict';
/**
 * 결정 352 — 무인증 사진 통로 2곳의 허용 목록(단일 출처).
 *
 *   GET /api/drive/image/:id       → DRIVE_IMAGE_SOURCES 에 기록된 번호만(구매·리뷰 캡처 등 화면이 띄우는 파일)
 *   GET /api/order/guide-image/:id → guide_image_files 에 기록된 번호만(가이드·공고·C/S 첨부 등 올린 사진)
 *   두 통로 모두 PRIVATE_SOURCES(이체결과 보관 파일 — 리뷰어 이름·계좌 전체, 결정 316)는 거절.
 *
 * ★ 속도(사용자 확정 「사진 로딩은 매우 빨라야 한다」):
 *   - 판정 = 인덱스 조회 1회(OR 로 묶은 EXISTS — 앞 칸에서 찾으면 뒤 칸은 보지 않는다. 자주 쓰는 칸이 앞).
 *   - 번호별 판정을 프로세스 메모리에 기억 — 허용 10분(브라우저 캐시 max-age=600 과 같은 길이), 거절 5초.
 *   - 같은 번호를 동시에 묻는 요청(썸네일 격자)은 진행 중 판정 하나를 함께 기다린다(조회 1회).
 * ★ fail 방향:
 *   - DB 조회 실패·지연(>1초) = **fail-open**(사진이 안 뜨면 업무가 막힌다) + 경고 로그. 이 판정은 기억하지 않는다.
 *     단 그때는 내려받은 파일이 사진(image/*)일 때만 내준다 — 이체결과 파일(엑셀·CSV)은 조회 실패 중에도 거절.
 *   - 목록 밖 = 404, **드라이브 읽기 0**, 구글 썸네일로 돌리지도 않는다(그쪽으로 돌리면 목록이 무의미).
 */
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

let testPool = null;
function _db() { return testPool || pool; }

// 화면 14곳(결정 352 표)이 사진 번호를 받아 오는 칸. 순서 = 조회 순서(많이 쓰는 칸 먼저).
//   ★ 화면이 새 칸에서 번호를 받기 시작하면 여기에 더한다(회귀가드 imageAllowlist.test.js 가 목록·인덱스를 대조).
const DRIVE_IMAGE_SOURCES = Object.freeze([
  { table: 'review_submissions', column: 'file_id' },
  { table: 'order_submissions', column: 'capture_file_id' },
  { table: 'order_submissions', column: 'capture_file_id_2' },
  { table: 'review_index', column: 'review_file_id' },
  { table: 'review_inspections', column: 'file_id' },
  { table: 'review_edit_requests', column: 'old_file_id' },
  { table: 'review_edit_requests', column: 'new_file_id' },
  { table: 'purchase_capture_artifacts', column: 'file_id' },
  { table: 'purchase_capture_supplements', column: 'file_id' },
  { table: 'purchase_submission_sessions', column: 'capture_file_id' },
  { table: 'reviewer_event_logs', expr: "(context->>'fileId')" },
  // AI 판별 예시 — 주소째(`…/api/drive/image/<id>`) 저장된다. 설정 표는 수백 줄이라 인덱스 없이도 즉시.
  { table: 'app_settings', column: 'value', contains: '/api/drive/image/', smallTable: true },
]);
const PRIVATE_SOURCES = Object.freeze([
  { table: 'payment_result_drive_archive', column: 'drive_file_id' },
]);
const GUIDE_IMAGE_SOURCES = Object.freeze([
  { table: 'guide_image_files', column: 'file_id' },
]);

function _branchSql(s) {
  if (s.contains) return `SELECT 1 FROM ${s.table} WHERE strpos(${s.column}, '${s.contains}' || $1) > 0`;
  return `SELECT 1 FROM ${s.table} WHERE ${s.column || s.expr} = $1`;
}
function _verdictSql(sources) {
  const allowed = sources.map(s => `EXISTS (${_branchSql(s)} )`).join('\n    OR ');
  const priv = PRIVATE_SOURCES.map(s => `EXISTS (${_branchSql(s)} )`).join(' OR ');
  return `SELECT (${priv}) AS private,\n  (${allowed}) AS allowed`;
}
const SQL = { drive: _verdictSql(DRIVE_IMAGE_SOURCES), guide: _verdictSql(GUIDE_IMAGE_SOURCES) };

const ALLOW_TTL_MS = 10 * 60 * 1000;
const DENY_TTL_MS = 5 * 1000;
const QUERY_TIMEOUT_MS = 1000;
const CACHE_MAX = 20000;
const cache = new Map();      // `${kind}:${id}` → { ok, until }
const inflight = new Map();   // `${kind}:${id}` → Promise<verdict>

function _remember(key, ok) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);   // 가장 오래된 것부터
  cache.set(key, { ok, until: Date.now() + (ok ? ALLOW_TTL_MS : DENY_TTL_MS) });
}

let _lastWarnAt = 0;
let _suppressed = 0;
function _warnFailOpen(kind, id, err) {
  const now = Date.now();
  if (now - _lastWarnAt < 60 * 1000) { _suppressed++; return; }
  logger.warn(`[image-allowlist] ${kind} 허용 판정 조회 실패 → 사진만 통과(fail-open)` +
    `${_suppressed ? ` · 직전 1분 ${_suppressed}건 더` : ''}: ${id} ${err && err.message}`);
  _lastWarnAt = now; _suppressed = 0;
}

function _withTimeout(p) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`판정 조회 ${QUERY_TIMEOUT_MS}ms 초과`)), QUERY_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @returns {Promise<{ok:boolean, failOpen?:boolean}>}
 *   ok=false → 404(드라이브 읽기 0) · failOpen=true → 내려받은 뒤 image/* 일 때만 내준다.
 */
async function check(kind, id, opts = {}) {
  const key = `${kind}:${id}`;
  const hit = cache.get(key);
  // fresh = 기억된 거절은 무시하고 다시 본다(통과 기억은 그대로 쓴다)
  if (hit && hit.until > Date.now() && (hit.ok || !opts.fresh)) return { ok: hit.ok };
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const { rows } = await _withTimeout(_db().query(SQL[kind], [id]));
      const r = rows && rows[0] || {};
      const ok = !r.private && !!r.allowed;
      if (ok || !opts.fresh) _remember(key, ok);
      else cache.delete(key);
      return { ok };
    } catch (err) {
      _warnFailOpen(kind, id, err);
      return { ok: true, failOpen: true };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 조회 실패(fail-open) 때 내줘도 되는 파일인가 — 사진만. 이체결과(엑셀·CSV)는 여기서 걸린다. */
function isImageMime(mime) { return /^image\//i.test(String(mime || '')); }

/**
 * 결정 354 미리 만들기 — 업로드 직후(아직 DB 기록 전일 수 있다) 서버가 스스로 묻는 판정.
 *   ★ 거절을 기억하지 않는다 — 기억하면 바로 뒤 화면 판정이 5초 동안 404(옛 통로)·서명 0 이 된다.
 *   ★ 기억된 거절도 무시하고 다시 본다. 통과는 기억한다(뒤이은 내부 생성 입구 판정이 조회 0).
 *   drive 통로 먼저, 아니면 guide 통로. 조회 실패 = { ok:true, failOpen:true } (호출 쪽이 건너뛴다).
 */
async function checkFresh(id) {
  const d = await check('drive', id, { fresh: true });
  if (d.ok && !d.failOpen) return d;
  const g = await check('guide', id, { fresh: true });
  if (g.ok && !g.failOpen) return g;
  if (d.failOpen || g.failOpen) return { ok: true, failOpen: true };
  return { ok: false };
}

/**
 * guide-image 주소를 만들기 **전에** 부른다(올린 즉시 열리게). 실패하면 던진다 —
 * 목록에 없는 주소를 돌려주면 그 사진은 영영 안 뜬다(올리기 실패가 차라리 다시 시도할 수 있다).
 */
async function registerGuideImage(fileId, source) {
  const id = String(fileId || '');
  if (!/^[-\w]{20,}$/.test(id)) return;
  await _db().query(
    `INSERT INTO guide_image_files (file_id, source) VALUES ($1, $2) ON CONFLICT (file_id) DO NOTHING`,
    [id, String(source || '').slice(0, 60)]);
  cache.delete(`guide:${id}`);
}

module.exports = {
  checkDriveImage: (id) => check('drive', id),
  checkGuideImage: (id) => check('guide', id),
  checkFresh,
  isImageMime,
  registerGuideImage,
  DRIVE_IMAGE_SOURCES,
  PRIVATE_SOURCES,
  GUIDE_IMAGE_SOURCES,
  __setPoolForTest(db) { testPool = db || null; },
  __resetCacheForTest() { cache.clear(); inflight.clear(); },
  __branchSql: _branchSql,
  __driveSql: () => SQL.drive,
  __guideSql: () => SQL.guide,
};
