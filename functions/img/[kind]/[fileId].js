/**
 * 결정 353 — 사진 빠른 길: Cloudflare Pages Function  GET /img/:kind/:fileId?e=<만료>&s=<서명>
 *
 *   서명·만료 검사(상수시간) → 엣지 캐시(caches.default, 열쇠 = kind+파일 — 서명 제외)
 *   → R2(IMG_BUCKET, `thumb/<kind>/<fileId>.webp`) → 없으면 원본 서버 내부 입구
 *   (`<ORIGIN_API>/api/img-internal/<kind>/<fileId>`, 헤더 X-Img-Key) 를 불러 R2 저장 + 응답
 *   (= 첫 조회 1회로 기존 사진이 저절로 옮겨 온다).
 *
 * ★ 서명 형식은 서버 `server/src/services/imageEdge.service.js` 와 같다(회귀가드 imageEdgeFunction.test.js):
 *     s = base64url(HMAC-SHA256(IMG_SIGNING_KEY, `${kind}/${fileId}/${e}`))
 * ★ 실패 방향: 설정 없음(바인딩·비밀 미설정·배포 스큐) = 503, 서명 문제 = 403, 원본 없음 = 404 — 전부 no-store.
 *   화면(js/drive-thumb.js)은 <img onerror> 로 종전 주소에 한 번 접는다(막다른 길 0).
 * ★ 브라우저 캐시 = private, 서명 만료까지만(최대 24시간). 엣지 캐시는 서명과 무관한 열쇠로 따로 담는다.
 * ★ 이 Function 은 frontend/_routes.json 의 `/img/*` 에서만 돈다 — 정적 파일·_headers·_redirects 영향 0.
 * ★ Workers 전역(Request/Response/crypto.subtle/caches)만 쓴다 — Node 에서도 그대로 시험된다.
 *
 * 환경: IMG_SIGNING_KEY(비밀) · IMG_ORIGIN_KEY(비밀) · ORIGIN_API(선택, 기본 운영 서버) · R2 바인딩 IMG_BUCKET
 */
const KINDS = { t: true, m: true };
const ID_RE = /^[-\w]{20,128}$/;
const SIG_RE = /^[-\w]{43}$/;
const MIN_KEY_LEN = 32;
const MAX_LIFETIME_SEC = 25 * 3600;      // 서버는 12~18시간짜리만 만든다 — 그보다 먼 만료는 위조로 본다
const BROWSER_MAX_AGE = 24 * 3600;
const EDGE_MAX_AGE = 7 * 24 * 3600;
const ORIGIN_TIMEOUT_MS = 25000;
const DEFAULT_ORIGIN = 'https://sublime-magic-production-790b.up.railway.app';

const enc = new TextEncoder();
const _keys = new Map();      // 비밀 문자열 → CryptoKey (격리 안에서 재사용)
const _inflight = new Map();  // `${kind}/${fileId}` → Promise (같은 사진 동시 첫 조회 = 원본 1회)

function b64url(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function _key(secret) {
  let k = _keys.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    _keys.set(secret, k);
  }
  return k;
}
function _eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** @returns {Promise<'ok'|'missing'|'expired'|'bad'>} */
export async function verifySig(secret, kind, fileId, e, s, nowSec = Math.floor(Date.now() / 1000)) {
  if (!e || !s) return 'missing';
  if (!/^\d{9,11}$/.test(String(e)) || !SIG_RE.test(String(s))) return 'bad';
  const exp = Number(e);
  if (exp <= nowSec) return 'expired';
  if (exp > nowSec + MAX_LIFETIME_SEC) return 'bad';
  const mac = await crypto.subtle.sign('HMAC', await _key(secret), enc.encode(`${kind}/${fileId}/${exp}`));
  return _eq(b64url(mac), String(s)) ? 'ok' : 'bad';
}

function _plain(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function _image(bytes, type, exp, src) {
  const maxAge = Math.max(0, Math.min(exp - Math.floor(Date.now() / 1000), BROWSER_MAX_AGE));
  return new Response(bytes, { status: 200, headers: {
    'Content-Type': type || 'image/webp',
    'Cache-Control': `private, max-age=${maxAge}`,
    'X-Content-Type-Options': 'nosniff',
    'X-Img-Src': src,
  } });
}
function _r2Key(kind, fileId) { return `thumb/${kind}/${fileId}.webp`; }
function _cacheKey(request, kind, fileId) {
  return new Request(new URL(`/img-cache/${kind}/${fileId}`, request.url).toString(), { method: 'GET' });
}
function _cache() {
  try { return (typeof caches !== 'undefined' && caches && caches.default) || null; } catch (_) { return null; }
}
function _later(ctx, p) {
  const safe = Promise.resolve(p).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
}

async function _fromOrigin(env, kind, fileId, fetchImpl) {
  const base = String(env.ORIGIN_API || DEFAULT_ORIGIN).replace(/\/+$/, '');
  const init = { headers: { 'X-Img-Key': env.IMG_ORIGIN_KEY } };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(ORIGIN_TIMEOUT_MS);
  let r;
  try { r = await (fetchImpl || fetch)(`${base}/api/img-internal/${kind}/${encodeURIComponent(fileId)}`, init); }
  catch (_) { return { status: 502 }; }
  if (r.status === 404) return { status: 404 };
  if (r.status !== 200) return { status: 502 };
  const type = r.headers.get('Content-Type') || '';
  if (!/^image\//i.test(type)) return { status: 502 };
  return { status: 200, bytes: await r.arrayBuffer(), type, fallback: r.headers.get('X-Img-Fallback') === 'original' };
}

async function onGet(ctx, fetchImpl) {
  const { request, env = {}, params = {} } = ctx;
  const kind = String(params.kind || '');
  const fileId = String(params.fileId || '');
  if (!env.IMG_BUCKET || String(env.IMG_SIGNING_KEY || '').length < MIN_KEY_LEN) return _plain(503, 'not configured');
  if (!KINDS[kind] || !ID_RE.test(fileId)) return _plain(403, 'forbidden');
  const q = new URL(request.url).searchParams;
  const verdict = await verifySig(env.IMG_SIGNING_KEY, kind, fileId, q.get('e'), q.get('s'));
  if (verdict !== 'ok') return _plain(403, 'forbidden');
  const exp = Number(q.get('e'));

  const cache = _cache();
  const ck = _cacheKey(request, kind, fileId);
  if (cache) {
    try {
      const hit = await cache.match(ck);
      if (hit) return _image(await hit.arrayBuffer(), hit.headers.get('Content-Type'), exp, 'edge');
    } catch (_) { /* 캐시 실패 = R2 로 */ }
  }
  const remember = (bytes, type) => {
    if (!cache) return;
    _later(ctx, cache.put(ck, new Response(bytes, { headers: {
      'Content-Type': type || 'image/webp', 'Cache-Control': `public, max-age=${EDGE_MAX_AGE}` } })));
  };

  let obj = null;
  try { obj = await env.IMG_BUCKET.get(_r2Key(kind, fileId)); } catch (_) { obj = null; }
  if (obj) {
    const bytes = await obj.arrayBuffer();
    const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/webp';
    remember(bytes, type);
    return _image(bytes, type, exp, 'r2');
  }

  if (String(env.IMG_ORIGIN_KEY || '').length < MIN_KEY_LEN) return _plain(503, 'not configured');
  const jobKey = `${kind}/${fileId}`;
  let job = _inflight.get(jobKey);
  if (!job) {
    job = _fromOrigin(env, kind, fileId, fetchImpl).then(async (o) => {
      if (o.status === 200 && !o.fallback) {
        // ★ sharp 실패로 원본이 온 것(fallback)은 담지 않는다 — 고쳐진 뒤 다음 조회에서 제대로 만든다.
        _later(ctx, env.IMG_BUCKET.put(_r2Key(kind, fileId), o.bytes, { httpMetadata: { contentType: o.type } }));
        remember(o.bytes, o.type);
      }
      return o;
    }).finally(() => _inflight.delete(jobKey));
    _inflight.set(jobKey, job);
  }
  const o = await job;
  if (o.status === 404) return _plain(404, 'not found');
  if (o.status !== 200) return _plain(502, 'origin failed');
  return _image(o.bytes.slice(0), o.type, exp, 'origin');
}

/** 사본 지우기(작업 삭제·사진 교체 연동용) — 서버만 부른다(X-Img-Key). 엣지 캐시는 이 지역 것만 지워진다. */
async function onDelete(ctx) {
  const { request, env = {}, params = {} } = ctx;
  const key = String(env.IMG_ORIGIN_KEY || '');
  if (key.length < MIN_KEY_LEN || !_eq(request.headers.get('X-Img-Key') || '', key)) return _plain(401, 'unauthorized');
  if (!env.IMG_BUCKET) return _plain(503, 'not configured');
  const fileId = String(params.fileId || '');
  if (!ID_RE.test(fileId)) return _plain(400, 'bad request');
  await env.IMG_BUCKET.delete(Object.keys(KINDS).map(k => _r2Key(k, fileId)));
  const cache = _cache();
  if (cache) for (const k of Object.keys(KINDS)) { try { await cache.delete(_cacheKey(request, k, fileId)); } catch (_) {} }
  return _plain(200, 'deleted');
}

/** Pages 진입점. 두 번째 인자(fetchImpl)는 시험용 — Pages 는 넘기지 않는다. */
export async function onRequest(ctx, fetchImpl) {
  const m = ctx.request.method;
  if (m === 'GET' || m === 'HEAD') return onGet(ctx, fetchImpl);
  if (m === 'DELETE') return onDelete(ctx);
  return _plain(405, 'method not allowed');
}
