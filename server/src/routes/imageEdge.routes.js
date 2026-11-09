'use strict';
/**
 * 결정 354 — 사진 빠른 길 서버 입구 2개.
 *
 *   POST /api/img/sign              로그인 화면(작업보드 등)용 일괄 서명. 로그인 필수(req.admin),
 *                                   허용 목록(결정 352 imageAllowlist — drive 또는 guide) 통과 번호만 서명.
 *   GET  /api/img-internal/:kind/:fileId
 *                                   Pages Function 만 부르는 내부 생성 입구(X-Img-Key = IMG_ORIGIN_KEY).
 *                                   허용 판정 → 드라이브 원본(짧은 메모리 캐시 — imageSourceCache) →
 *                                   t·m = sharp WebP(실패 시 원본 그대로 + X-Img-Fallback) /
 *                                   o = 원본 바이트 그대로(변환 0 · Content-Type 원본 · 래스터 사진만).
 *
 * ★ 무인증 화면(보고 페이지)은 그 응답을 만드는 서버가 서명을 싣는다(imageEdge.withThumbs) — 이 입구를 열지 않는다.
 * ★ 내부 입구는 Cloudflare 의 몇 개 주소로 몰려 와서 주소별 속도 제한(분당 120)에 걸린다 → **열쇠가 맞을 때만**
 *   속도 제한 앞에서 처리하고, 나머지(열쇠 없음·틀림)는 종전대로 제한을 거친 뒤 401.
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth.middleware');
const imageAllowlist = require('../services/imageAllowlist.service');
const driveService = require('../services/drive.service');
const edge = require('../services/imageEdge.service');
const sourceCache = require('../services/imageSourceCache.service');
const { logger } = require('../utils/logger');

const SIGN_MAX_IDS = edge.SIGN_MAX_IDS;

// ── 생성 동시 처리 상한 — 처음 여는 큰 목록(수백 장)이 한꺼번에 와도 드라이브 동시 읽기·메모리를 묶는다.
//   줄이 넘치면 503 → Function 502 → 화면은 종전 주소로(다음 조회 때 다시 만든다).
const GEN_MAX = 12;
const GEN_QUEUE_MAX = 300;
let _genActive = 0;
const _genQueue = [];
function _genAcquire() {
  if (_genActive < GEN_MAX) { _genActive++; return Promise.resolve(); }
  if (_genQueue.length >= GEN_QUEUE_MAX) return null;
  return new Promise(r => _genQueue.push(r));
}
function _genRelease() {
  const next = _genQueue.shift();
  if (next) next(); else _genActive--;
}

/** 허용 판정 = imageEdge.allowVerdict 한 곳(일괄 서명·응답 서명과 같은 판정 — 사본 0). */
const _verdict = (id) => edge.allowVerdict(id);

// ── POST /api/img/sign ──
const signRouter = express.Router();
async function signHandler(req, res) {
  const who = req.admin;   // ★ req.admin 만(결정 201 — req.user 금지)
  if (!who) return res.status(401).json({ ok: false, error: '인증이 필요합니다.' });
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!edge.KINDS[kind]) return res.status(400).json({ ok: false, error: 'bad kind' });
  res.set('Cache-Control', 'no-store');
  if (!edge.signingEnabled()) return res.json({ ok: true, enabled: false, urls: {} });
  // ★ 허용 목록 통과 번호만 · 조회 실패(fail-open)는 서명 0 — 판정·서명은 서비스 한 곳(edge.signAllowed)
  const urls = await edge.signAllowed(Array.isArray(b.ids) ? b.ids : [], kind, { max: SIGN_MAX_IDS });
  // 덤(extra) — 목록 작은 사진(t)을 받는 김에 크게 보기 원본(o) 서명도 같은 허용 판정 결과로 싣는다(요청·판정 추가 0).
  //   ★ 위에서 통과한 번호에만 붙인다(덤이 판정을 건너뛰는 길이 되지 않게). 옛 화면은 extra 를 안 보내 응답 불변.
  const extra = [...new Set((Array.isArray(b.extra) ? b.extra : []).map(String))].filter(k => edge.KINDS[k] && k !== kind).slice(0, 2);
  if (!extra.length) return res.json({ ok: true, enabled: true, urls });
  const more = {};
  for (const k of extra) {
    more[k] = {};
    for (const fid of Object.keys(urls)) { const u = edge.signImage(fid, k); if (u) more[k][fid] = u; }
  }
  return res.json({ ok: true, enabled: true, urls, more });
}
signRouter.post('/sign', authMiddleware, signHandler);

// ── GET /api/img-internal/:kind/:fileId ──
const internalRouter = express.Router();
internalRouter.get('/:kind/:fileId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!edge.originKeyConfigured()) return res.status(503).send('not configured');
  if (!edge.originKeyOk(req.get('x-img-key'))) return res.status(401).send('unauthorized');
  const kind = String(req.params.kind || '');
  const id = String(req.params.fileId || '');
  if (!edge.KINDS[kind] || !edge.ID_RE.test(id)) return res.status(400).send('bad request');
  const v = await _verdict(id);
  if (!v.ok) return res.status(404).send('not found');               // ★ 드라이브 읽기 0(결정 352 완화 금지)
  const slot = _genAcquire();
  if (!slot) return res.status(503).send('busy');
  await slot;
  try {
    let f;
    // ★ 같은 사진을 t → m → o 로 연달아 만들 때 드라이브를 한 번만 읽는다(수명 30초 · 총량 64MB · 동시 요청 합치기).
    try { f = await sourceCache.get(id, (x) => driveService.downloadFile(x)); }
    catch (e) { logger.warn(`[img-edge] 원본 읽기 실패: ${e.message}`); return res.status(502).send('origin failed'); }
    // ★ 사진만 — fail-open 때든 아니든 사진이 아니면 내주지 않는다(Function 이 R2 에 담는 것은 사진뿐).
    if (!imageAllowlist.isImageMime(f.mimeType)) return res.status(404).send('not found');
    if (!f.buffer || f.buffer.length > edge.MAX_SOURCE_BYTES) return res.status(413).send('too large');
    if (edge.KINDS[kind].original) {
      // ★ o = 원본 바이트 그대로 — 재압축·변환·형식 바꾸기 0(결정 008 원본 유지 · 결정 354 원본 빠른 길).
      //   래스터 사진만(SVG 등은 404 → 화면이 종전 원본 프록시로 1회 접는다).
      if (!edge.originalTypeOk(f.mimeType)) return res.status(404).send('not found');
      res.set('Content-Type', f.mimeType);
      res.set('X-Content-Type-Options', 'nosniff');
      return res.send(f.buffer);
    }
    const out = await edge.makeThumb(f.buffer, f.mimeType, kind);
    res.set('Content-Type', out.mimeType || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    if (out.fallback) res.set('X-Img-Fallback', 'original');   // Function 은 이것을 R2 에 담지 않는다
    return res.send(out.buffer);
  } finally { _genRelease(); }
});

/** 속도 제한 앞 단계 — 열쇠가 맞는 요청만 여기서 처리, 나머지는 그대로 다음(제한 → 뒤 단계 401). */
function _internalIfKeyed(req, res, next) {
  if (edge.originKeyOk(req.get('x-img-key'))) return internalRouter(req, res, next);
  return next();
}

/**
 * app.js 배선 — 속도 제한(`app.use('/api/', rateLimiter)`) **앞에서** `{beforeLimiter:true}`,
 * **뒤에서** `{beforeLimiter:false}` 로 한 번씩 부른다(회귀가드 imageEdge.test.js D).
 */
function mount(app, { beforeLimiter }) {
  if (beforeLimiter) {
    app.use('/api/img-internal', _internalIfKeyed);
    return;
  }
  // 옛 통로 카운터(응답 영향 0) — 라우터보다 앞에 둔다
  app.use(['/api/drive/image', '/api/order/guide-image'], edge.legacyCounter);
  app.use('/api/img', signRouter);
  app.use('/api/img-internal', internalRouter);
}

module.exports = { mount, signRouter, signHandler, internalRouter, GEN_MAX, __genStats: () => ({ active: _genActive, queued: _genQueue.length }) };
