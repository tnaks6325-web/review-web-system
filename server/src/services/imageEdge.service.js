'use strict';
/**
 * 결정 353 — 사진 빠른 길(Cloudflare R2 + Pages Function `/img/:kind/:fileId?e=&s=`)의 서버 쪽 단일 출처.
 *
 *   signImage(fileId, kind)  — 화면용 작은 사진의 만료 서명 주소(프론트 사이트 기준 상대경로). 열쇠 없으면 null
 *                              → 화면은 종전 주소(구글 썸네일·/api/drive/image)를 그대로 쓴다.
 *   makeThumb(buffer, kind)  — 내부 생성 입구가 쓰는 WebP 변환. sharp 를 못 쓰면 원본 그대로(fail-soft).
 *   originKeyOk(value)       — Function → 서버 내부 입구 공유 비밀(IMG_ORIGIN_KEY) 상수시간 비교.
 *   noteLegacy(req)          — 서명 없는 옛 통로 요청을 사이트 출처별로만 센다(파일 번호·개인정보 로그 금지).
 *
 * ★ 서명 형식(Function `functions/img/[kind]/[fileId].js` 의 verifySig 와 같아야 한다 — 회귀가드 imageEdgeFunction.test.js):
 *     s = base64url(HMAC-SHA256(IMG_SIGNING_KEY, `${kind}/${fileId}/${e}`))   (43자, 패딩 없음)
 *     e = ceil((지금 + 12시간) / 6시간) × 6시간  → 같은 6시간 칸이면 같은 주소(브라우저·엣지 캐시가 듣는다), 유효 12~18시간
 * ★ kind = t(목록용 가로 400) · m(크게 보기용 가로 1600). **원본은 없다** — 대조·크게 보기 원본·저장·AI 판정은
 *   종전 원본 통로 그대로(결정 008 완화 금지).
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const KINDS = Object.freeze({
  t: Object.freeze({ width: 400, quality: 72 }),
  m: Object.freeze({ width: 1600, quality: 78 }),
});
const ID_RE = /^[-\w]{20,128}$/;
const BUCKET_SEC = 6 * 3600;
const MIN_TTL_SEC = 12 * 3600;
const MIN_KEY_LEN = 32;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;   // 내부 입구가 받아들이는 원본 상한(드라이브 업로드 상한 10MB 의 2.5배)
const MAX_INPUT_PIXELS = 80 * 1000 * 1000;    // 압축 폭탄 방지(sharp limitInputPixels)

function _signingKey() {
  const k = String(process.env.IMG_SIGNING_KEY || '');
  return k.length >= MIN_KEY_LEN ? k : '';
}
function signingEnabled() { return !!_signingKey(); }

function expFor(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  return Math.ceil((now + MIN_TTL_SEC) / BUCKET_SEC) * BUCKET_SEC;
}
function _sig(key, kind, fileId, e) {
  return crypto.createHmac('sha256', key).update(`${kind}/${fileId}/${e}`).digest('base64url');
}

/** @returns {string|null} `/img/<kind>/<fileId>?e=<exp>&s=<sig>` */
function signImage(fileId, kind, nowMs = Date.now()) {
  const id = String(fileId || '');
  if (!KINDS[kind] || !ID_RE.test(id)) return null;
  const key = _signingKey();
  if (!key) return null;
  const e = expFor(nowMs);
  return `/img/${kind}/${encodeURIComponent(id)}?e=${e}&s=${_sig(key, kind, id, e)}`;
}

/** 무인증 화면(보고 페이지 등) 응답용 — 사진 목록 [{id,…}] 에 서명 주소 t 를 싣는다(열쇠 없으면 그대로). */
function withThumbs(list, kind = 't') {
  if (!Array.isArray(list) || !signingEnabled()) return list;
  return list.map(im => {
    const t = im && signImage(im.id, kind);
    return t ? Object.assign({}, im, { t }) : im;
  });
}

function _safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  if (x.length !== y.length || !x.length) return false;
  return crypto.timingSafeEqual(x, y);
}
function originKeyConfigured() { return String(process.env.IMG_ORIGIN_KEY || '').length >= MIN_KEY_LEN; }
function originKeyOk(value) {
  return originKeyConfigured() && _safeEqual(value, process.env.IMG_ORIGIN_KEY);
}

// ── sharp(선택 의존성) — 못 불러오면 원본 그대로 돌려준다(fail-soft, 한 번만 경고) ──
let _sharp;            // undefined = 아직 안 불러봄 · null = 못 씀
let _sharpOverride;    // 시험용
function _loadSharp() {
  if (_sharpOverride !== undefined) return _sharpOverride;
  if (_sharp !== undefined) return _sharp;
  try { _sharp = require('sharp'); }
  catch (e) { _sharp = null; logger.warn(`[img-edge] sharp 를 불러오지 못함 → 원본 그대로 내줌: ${e.message}`); }
  return _sharp;
}

/** @returns {Promise<{buffer:Buffer, mimeType:string, fallback:boolean}>} */
async function makeThumb(buffer, mimeType, kind) {
  const spec = KINDS[kind];
  const sharp = _loadSharp();
  if (!sharp || !spec) return { buffer, mimeType, fallback: true };
  try {
    const out = await sharp(buffer, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()                                            // EXIF 방향
      .resize({ width: spec.width, withoutEnlargement: true })
      .webp({ quality: spec.quality })
      .toBuffer();
    return { buffer: out, mimeType: 'image/webp', fallback: false };
  } catch (e) {
    logger.warn(`[img-edge] WebP 변환 실패 → 원본 그대로: ${e.message}`);
    return { buffer, mimeType, fallback: true };
  }
}

// ── 옛 통로(서명 없는 /api/drive/image · /api/order/guide-image) 카운터 — 다음 단계(강제) 판단용 ──
//   ★ 파일 번호·쿼리·개인정보는 남기지 않는다: 키 = 통로 종류 + Referer 의 호스트 + 첫 경로 조각.
//   ⚠ 프론트(_headers)가 Referrer-Policy strict-origin-when-cross-origin 이라 pages.dev → Railway 는
//     경로 없이 출처만 온다(화면별 구분은 같은 출처 화면에서만 된다).
const LEGACY_LOG_MS = 10 * 60 * 1000;
const LEGACY_MAX_KEYS = 200;
let _legacy = new Map();
let _legacyTimer = null;
function _legacyKey(req) {
  const full = (req.baseUrl || '') + (req.path || '');
  const route = /guide-image/.test(full) ? 'guide' : 'drive';
  const ref = String((req.headers && (req.headers.referer || req.headers.referrer)) || '');
  if (!ref) return `${route} (none)`;
  try {
    const u = new URL(ref);
    const seg = (u.pathname.split('/').filter(Boolean)[0] || '').replace(/\.html$/, '').slice(0, 40);
    return `${route} ${u.host}/${seg}`;
  } catch (_) { return `${route} (bad)`; }
}
function noteLegacy(req) {
  try {
    let k = _legacyKey(req);
    if (!_legacy.has(k) && _legacy.size >= LEGACY_MAX_KEYS) k = 'other';
    _legacy.set(k, (_legacy.get(k) || 0) + 1);
    if (!_legacyTimer && process.env.NODE_ENV !== 'test') {
      _legacyTimer = setInterval(_flushLegacy, LEGACY_LOG_MS);
      if (_legacyTimer.unref) _legacyTimer.unref();
    }
  } catch (_) { /* 세기 실패는 사진에 영향 0 */ }
}
function _legacyLogLine() {
  if (!_legacy.size) return '';
  const parts = [..._legacy.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`);
  return `[img-legacy] 서명 없는 옛 통로 ${LEGACY_LOG_MS / 60000}분: ${parts.join(' · ')}`;
}
function _flushLegacy() {
  const line = _legacyLogLine();
  _legacy = new Map();
  if (line) logger.info(line);
}
/** express 미들웨어 — 옛 통로 앞에 붙인다(응답에 영향 0). */
function legacyCounter(req, res, next) { if (req.method === 'GET') noteLegacy(req); next(); }

module.exports = {
  KINDS, ID_RE, BUCKET_SEC, MIN_TTL_SEC, MAX_SOURCE_BYTES,
  signImage, withThumbs, signingEnabled, expFor,
  originKeyOk, originKeyConfigured,
  makeThumb,
  noteLegacy, legacyCounter,
  __setSharpForTest(s) { _sharpOverride = s; },
  __resetLegacyForTest() { _legacy = new Map(); },
  __legacySnapshot() { return Object.fromEntries(_legacy); },
  __legacyLogLine: _legacyLogLine,
};
