'use strict';
/**
 * 결정 353 — 사진 빠른 길(Cloudflare Pages Function `/img/:kind/:fileId?e=&s=`) 회귀가드.
 *
 *   ① 서버(Node crypto)가 만든 서명을 Function(crypto.subtle)이 그대로 받아들인다(형식 호환).
 *   ② 서명 없음·위조·만료·다른 파일·kind 바꿔치기·지나치게 먼 만료 = 403, 드라이브(원본 서버) 호출 0.
 *   ③ 설정 없음(R2 바인딩·서명 열쇠 없음) = 503 → 화면이 옛 길로 접는다.
 *   ④ 흐름: 엣지 캐시 → R2 → 원본 서버 내부 입구(X-Img-Key) → R2 저장 + 캐시. 두 번째는 원본 호출 0.
 *   ⑤ 원본이 sharp 실패로 원본 바이트를 주면(X-Img-Fallback) R2 에 저장하지 않는다.
 *   ⑥ 브라우저 캐시는 private + 서명 만료까지만.
 *   ⑦ DELETE(내부 열쇠) = R2 사본 두 종 삭제.
 *
 * Function 은 Workers 전역(Request/Response/crypto.subtle/caches)만 쓴다 — Node 의 같은 전역으로 실행한다.
 * 실행: node tests/imageEdgeFunction.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const FN_PATH = path.resolve(__dirname, '..', '..', 'functions', 'img', '[kind]', '[fileId].js');
const KEY = 'k'.repeat(48);
const ORIGIN_KEY = 'o'.repeat(48);
const FID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123';
const FID2 = '1ZzZzZzZzZzZzZzZzZzZzZzZzZz9999';

function loadServerSigner() {
  process.env.IMG_SIGNING_KEY = KEY;
  delete require.cache[require.resolve('../src/services/imageEdge.service')];
  return require('../src/services/imageEdge.service');
}

function makeR2() {
  const store = new Map();
  const r2 = {
    store, gets: 0, puts: 0, deletes: [],
    async get(k) { r2.gets++; const v = store.get(k); if (!v) return null;
      return { httpMetadata: { contentType: v.type }, async arrayBuffer() { return v.bytes; } }; },
    async put(k, bytes, opts) { r2.puts++; store.set(k, { bytes, type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); },
    async delete(keys) { r2.deletes.push(...[].concat(keys)); [].concat(keys).forEach(k => store.delete(k)); },
  };
  return r2;
}
function makeCache() {
  const m = new Map();
  return { m, async match(req) { const v = m.get(typeof req === 'string' ? req : req.url); return v ? v.clone() : undefined; },
    async put(req, res) { m.set(typeof req === 'string' ? req : req.url, res.clone()); },
    async delete(req) { return m.delete(typeof req === 'string' ? req : req.url); } };
}

let FN;
async function fn() { if (!FN) FN = await import(pathToFileURL(FN_PATH).href); return FN; }

function ctxFor(url, { env, method = 'GET', headers = {} } = {}) {
  const u = new URL(url, 'https://review-web-system.pages.dev');
  const m = u.pathname.match(/^\/img\/([^/]*)\/([^/]*)$/) || [];
  const waits = [];
  return { waits, ctx: {
    request: new Request(u.toString(), { method, headers }),
    env, params: { kind: decodeURIComponent(m[1] || ''), fileId: decodeURIComponent(m[2] || '') },
    waitUntil(p) { waits.push(p); },
  } };
}

function fakeOrigin(behaviour = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), key: init && init.headers && (init.headers['X-Img-Key'] || init.headers['x-img-key']) });
    if (behaviour.status && behaviour.status !== 200) return new Response('x', { status: behaviour.status });
    const h = { 'Content-Type': behaviour.type || 'image/webp' };
    if (behaviour.fallback) h['X-Img-Fallback'] = 'original';
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: h });
  };
  return { calls, fetchImpl };
}

function envWith(r2, extra = {}) {
  return Object.assign({ IMG_SIGNING_KEY: KEY, IMG_ORIGIN_KEY: ORIGIN_KEY, ORIGIN_API: 'http://origin.test', IMG_BUCKET: r2 }, extra);
}

async function call(url, opts, origin) {
  const F = await fn();
  const { ctx, waits } = ctxFor(url, opts);
  const res = await F.onRequest(ctx, origin ? origin.fetchImpl : undefined);
  await Promise.all(waits);
  return res;
}

test('① 서버가 만든 서명 주소를 Function 이 그대로 받는다(형식 호환) + 같은 6시간 칸은 같은 주소', async () => {
  const S = loadServerSigner();
  const now = Date.UTC(2026, 10, 9, 1, 0, 0);
  const u1 = S.signImage(FID, 't', now);
  const u2 = S.signImage(FID, 't', now + 3600 * 1000);
  assert.match(u1, /^\/img\/t\/[-\w]+\?e=\d+&s=[-\w]{43}$/);
  assert.equal(u1, u2, '같은 칸 안 1시간 차이 = 같은 주소(브라우저·엣지 캐시가 듣는다)');
  const e = Number(new URL(u1, 'https://x').searchParams.get('e'));
  assert.ok(e * 1000 - now >= 12 * 3600 * 1000 && e * 1000 - now <= 18 * 3600 * 1000, '유효 12~18시간');
  const F = await fn();
  const q = new URL(u1, 'https://x').searchParams;
  assert.equal(await F.verifySig(KEY, 't', FID, q.get('e'), q.get('s'), Math.floor(now / 1000)), 'ok');
});

test('② 403 — 서명 없음·위조·만료·다른 파일·kind 바꿔치기·먼 만료 (원본 호출 0)', async () => {
  const S = loadServerSigner();
  const r2 = makeR2(); const origin = fakeOrigin();
  globalThis.caches = { default: makeCache() };
  const good = S.signImage(FID, 't');
  const q = new URL(good, 'https://x').searchParams;
  const cases = {
    '서명 없음': `/img/t/${FID}`,
    '위조': `/img/t/${FID}?e=${q.get('e')}&s=${'A'.repeat(43)}`,
    '다른 파일': `/img/t/${FID2}?e=${q.get('e')}&s=${q.get('s')}`,
    'kind 바꿔치기': `/img/m/${FID}?e=${q.get('e')}&s=${q.get('s')}`,
    '모르는 kind': `/img/o/${FID}?e=${q.get('e')}&s=${q.get('s')}`,
  };
  for (const [name, url] of Object.entries(cases)) {
    const res = await call(url, { env: envWith(r2) }, origin);
    assert.equal(res.status, 403, name);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', name + ' no-store');
  }
  // 만료: 과거 시각으로 서명
  const past = S.signImage(FID, 't', Date.now() - 48 * 3600 * 1000);
  assert.equal((await call(past, { env: envWith(r2) }, origin)).status, 403, '만료');
  // 먼 만료: 열쇠가 맞아도 유효기간 상한(25시간)을 넘는 주소는 거절
  const far = S.signImage(FID, 't', Date.now() + 72 * 3600 * 1000);
  assert.equal((await call(far, { env: envWith(r2) }, origin)).status, 403, '먼 만료');
  assert.equal(origin.calls.length, 0, '거절 때 원본 서버 호출 0');
  assert.equal(r2.gets, 0, '거절 때 R2 읽기 0');
});

test('③ 설정 없음 = 503(화면이 옛 길로) — R2 바인딩·서명 열쇠·짧은 열쇠', async () => {
  const S = loadServerSigner();
  const url = S.signImage(FID, 't');
  const r2 = makeR2();
  for (const [name, env] of Object.entries({
    'R2 없음': envWith(undefined),
    '서명 열쇠 없음': envWith(r2, { IMG_SIGNING_KEY: '' }),
    '짧은 열쇠': envWith(r2, { IMG_SIGNING_KEY: 'short' }),
  })) {
    const res = await call(url, { env }, fakeOrigin());
    assert.equal(res.status, 503, name);
  }
});

test('④ 첫 조회 = 원본 입구(X-Img-Key) → R2 저장 · 두 번째 = 엣지 캐시(원본 0) · 캐시 비어도 R2(원본 0)', async () => {
  const S = loadServerSigner();
  const r2 = makeR2(); const origin = fakeOrigin();
  const cache = makeCache(); globalThis.caches = { default: cache };
  const url = S.signImage(FID, 't');
  const r1 = await call(url, { env: envWith(r2) }, origin);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('Content-Type'), 'image/webp');
  assert.equal(r1.headers.get('X-Img-Src'), 'origin');
  assert.equal(origin.calls.length, 1);
  assert.equal(origin.calls[0].url, `http://origin.test/api/img-internal/t/${FID}`);
  assert.equal(origin.calls[0].key, ORIGIN_KEY, '내부 열쇠를 헤더로');
  assert.ok(r2.store.has(`thumb/t/${FID}.webp`), 'R2 에 저장');

  // ⑥ 브라우저 캐시 = private, 서명 만료까지만(24시간 상한)
  const cc = r1.headers.get('Cache-Control');
  const exp = Number(new URL(url, 'https://x').searchParams.get('e'));
  const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1]);
  assert.match(cc, /^private, max-age=\d+$/);
  assert.ok(maxAge <= exp - Math.floor(Date.now() / 1000) && maxAge <= 86400, cc);

  const r2nd = await call(url, { env: envWith(r2) }, origin);
  assert.equal(r2nd.status, 200);
  assert.equal(r2nd.headers.get('X-Img-Src'), 'edge');
  assert.equal(origin.calls.length, 1, '두 번째는 원본 호출 0');

  cache.m.clear();
  const r3 = await call(url, { env: envWith(r2) }, origin);
  assert.equal(r3.headers.get('X-Img-Src'), 'r2');
  assert.equal(origin.calls.length, 1, '엣지 캐시가 비어도 R2 에서(원본 0)');
  assert.deepEqual(new Uint8Array(await r3.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  // 엣지 캐시 열쇠는 서명을 빼고 kind+파일 — 다음 6시간 칸의 다른 서명도 같은 사본
  const next = S.signImage(FID, 't', Date.now() + 6 * 3600 * 1000);
  assert.notEqual(next, url);
  const r4 = await call(next, { env: envWith(r2) }, origin);
  assert.equal(r4.headers.get('X-Img-Src'), 'edge');
  assert.ok([...cache.m.keys()].every(k => !/[?&]s=/.test(k)), '캐시 열쇠에 서명이 없다');
});

test('④-2 원본이 없다고 하면(404) 404 · 원본 오류는 502 · 원본 열쇠 없음 503 (모두 no-store, R2 저장 0)', async () => {
  const S = loadServerSigner();
  globalThis.caches = { default: makeCache() };
  const url = S.signImage(FID, 'm');
  for (const [st, want] of [[404, 404], [500, 502], [401, 502]]) {
    const r2 = makeR2();
    const res = await call(url, { env: envWith(r2) }, fakeOrigin({ status: st }));
    assert.equal(res.status, want, `원본 ${st}`);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(r2.puts, 0);
  }
  const r2 = makeR2();
  assert.equal((await call(url, { env: envWith(r2, { IMG_ORIGIN_KEY: '' }) }, fakeOrigin())).status, 503);
  // 원본이 사진이 아닌 것을 주면 내주지 않는다
  assert.equal((await call(url, { env: envWith(makeR2()) }, fakeOrigin({ type: 'text/html' }))).status, 502);
});

test('⑤ 원본이 sharp 실패로 원본 바이트를 주면(X-Img-Fallback) 내주되 R2·엣지에 저장하지 않는다', async () => {
  const S = loadServerSigner();
  const r2 = makeR2(); const cache = makeCache(); globalThis.caches = { default: cache };
  const url = S.signImage(FID, 't');
  const res = await call(url, { env: envWith(r2) }, fakeOrigin({ fallback: true, type: 'image/jpeg' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(r2.puts, 0);
  assert.equal(cache.m.size, 0);
});

test('⑦ DELETE — 내부 열쇠 있어야, R2 사본 두 종 삭제 · 열쇠 없음 401', async () => {
  const r2 = makeR2(); globalThis.caches = { default: makeCache() };
  r2.store.set(`thumb/t/${FID}.webp`, { bytes: new Uint8Array([1]) });
  const bad = await call(`/img/t/${FID}`, { env: envWith(r2), method: 'DELETE' });
  assert.equal(bad.status, 401);
  assert.equal(r2.deletes.length, 0);
  const ok = await call(`/img/t/${FID}`, { env: envWith(r2), method: 'DELETE', headers: { 'X-Img-Key': ORIGIN_KEY } });
  assert.equal(ok.status, 200);
  assert.deepEqual(r2.deletes.sort(), [`thumb/m/${FID}.webp`, `thumb/t/${FID}.webp`]);
});

test('⑧ 다른 경로 영향 0 — frontend/_routes.json 이 /img/* 만 Function 으로 보낸다', () => {
  const routes = require(path.resolve(__dirname, '..', '..', 'frontend', '_routes.json'));
  assert.deepEqual(routes, { version: 1, include: ['/img/*'], exclude: [] });
  const fs = require('fs');
  const fnDir = path.resolve(__dirname, '..', '..', 'functions');
  const files = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n);
    fs.statSync(p).isDirectory() ? walk(p) : files.push(path.relative(fnDir, p)); } })(fnDir);
  assert.deepEqual(files.filter(f => !f.endsWith('.md')), [path.join('img', '[kind]', '[fileId].js')],
    '_middleware 등 다른 Function 이 없다(정적 파일·_headers·_redirects 동작 불변)');
  assert.ok(!fs.existsSync(path.resolve(__dirname, '..', '..', 'wrangler.toml')), 'wrangler.toml 금지(대시보드 설정 덮어씀)');
});
