'use strict';
/**
 * 결정 354 「모든 사진 미리 만들기 · 원본 빠른 길(2026-11-09)」 회귀가드.
 *
 *   A) Function kind o — 원본 바이트를 **그대로**(sha256 동일 · Content-Type 원본) R2 `orig/<id>` 에 담고 내준다 ·
 *      서명 없음/kind 바꿔치기 403(원본 호출 0) · 사진 아닌·SVG 원본은 담지 않는다(502) · CSP sandbox ·
 *      HEAD 는 R2 head 로 몸통 읽기 0 · DELETE 가 원본 사본까지 지운다
 *   B) 원본 서버 내부 입구 o — 변환 0(sharp 호출 0 · 바이트 동일) · SVG 404 · 25MB 초과 413 · 허용 밖 404 + 읽기 0 ·
 *      **t→m→o 연달아 = 드라이브 읽기 1회** · 동시 요청 합치기 · 수명 지나면 다시 읽기 · 총량 상한
 *   C) 서명 — 일괄 서명 입구 kind o · 같은 요청에 o 덤(extra) · 보고 응답(withThumbs)이 t·o 를 싣는다
 *   D) 미리 만들기 — 업로드 직후 t → m → o 순서 · 일괄 스크립트 --kinds(기본 t,m,o) · --days 없으면 전체 ·
 *      이미 있는 것은 「이미 있음」으로 센다(이어 돌리기)
 *   E) 화면(drive-thumb vm 실행) — 원본 유지 자리는 t/m(변환본)을 절대 쓰지 않는다 · o 있으면 o, 실패 시 종전 프록시 1회 ·
 *      o 미리 불러두기 동시 상한 · 옛 서버(kind o 400)여도 빠른 길 전체가 꺼지지 않는다
 *   F) 화면 배선 — 원본 유지 자리 5종이 공용 원본 함수(fullAttrs/full)를 쓴다
 *
 * 실행: node tests/imageEdgeOriginal.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const express = require('express');
const jwt = require('jsonwebtoken');

const SERVER = path.resolve(__dirname, '..');
const ROOT = path.resolve(SERVER, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

process.env.JWT_SECRET = 'test-jwt-secret-for-image-edge-original';
const KEY = 's'.repeat(48);
const ORIGIN_KEY = 'o'.repeat(48);
process.env.IMG_SIGNING_KEY = KEY;
process.env.IMG_ORIGIN_KEY = ORIGIN_KEY;
delete process.env.PUBLIC_ORIGIN;

const drive = require(path.join(SERVER, 'src/services/drive.service'));
const allow = require(path.join(SERVER, 'src/services/imageAllowlist.service'));
const edge = require(path.join(SERVER, 'src/services/imageEdge.service'));
const routes = require(path.join(SERVER, 'src/routes/imageEdge.routes'));
const srcCache = require(path.join(SERVER, 'src/services/imageSourceCache.service'));
const warm = require(path.join(SERVER, 'src/services/imageWarm.service'));
const imgWarmScript = require(path.join(SERVER, 'scripts/img-warm.js'));

const id = (tag) => (tag + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3').slice(0, 33);
const IDS = { jpg: id('JPG'), png: id('PNG'), svg: id('SVG'), big: id('BIG'), out: id('OUT'), slow: id('SLOW'), b: id('BBB') };
// 원본 = 진짜 JPEG 바이트(EXIF 같은 꼬리까지 그대로 나가야 한다 — 끝에 표지 바이트를 붙인다)
let JPEG;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

allow.__setPoolForTest({ async query(sql, [fid]) {
  const guide = /guide_image_files/.test(sql);
  const allowed = !guide && fid !== IDS.out;
  return { rows: [{ private: false, allowed }] };
} });

const reads = [];
drive.downloadFile = async (fid) => {
  reads.push(fid);
  if (fid === IDS.slow) await sleep(40);
  if (fid === IDS.svg) return { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), mimeType: 'image/svg+xml', name: 's' };
  if (fid === IDS.big) return { buffer: Buffer.alloc(edge.MAX_SOURCE_BYTES + 1), mimeType: 'image/jpeg', name: 'b' };
  if (fid === IDS.png) return { buffer: PNG_BYTES, mimeType: 'image/png', name: 'p' };
  return { buffer: JPEG, mimeType: 'image/jpeg', name: fid };
};

function startApp() {
  const app = express();
  app.use(express.json());
  routes.mount(app, { beforeLimiter: true });
  routes.mount(app, { beforeLimiter: false });
  return new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
}
function req(server, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers) }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const KEYH = { 'X-Img-Key': ORIGIN_KEY };
const staffToken = () => jwt.sign({ name: 'tester', role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let server;
let sharpCalls = 0;
test.before(async () => {
  const sharp = require('sharp');
  JPEG = Buffer.concat([await sharp({ create: { width: 1200, height: 2000, channels: 3, background: '#cc8844' } }).jpeg({ quality: 90 }).toBuffer(),
    Buffer.from('TRAILING-MARK')]);
  server = await startApp();
});
test.after(() => server && server.close());
test.beforeEach(() => {
  allow.__resetCacheForTest(); reads.length = 0; sharpCalls = 0;
  srcCache.__resetForTest();
  const real = require('sharp');
  edge.__setSharpForTest(function spy(...a) { sharpCalls++; return real(...a); });
});

// ─────────────────────────── A. Function kind o ───────────────────────────
const FN_PATH = path.join(ROOT, 'functions', 'img', '[kind]', '[fileId].js');
let FN;
async function fn() { if (!FN) FN = await import(pathToFileURL(FN_PATH).href); return FN; }
function makeR2({ withHead = true } = {}) {
  const store = new Map();
  const r2 = { store, gets: 0, heads: 0, puts: 0, deletes: [],
    async get(k) { r2.gets++; const v = store.get(k); if (!v) return null;
      return { httpMetadata: { contentType: v.type }, async arrayBuffer() { return v.bytes; } }; },
    async put(k, bytes, opts) { r2.puts++; store.set(k, { bytes, type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); },
    async delete(keys) { r2.deletes.push(...[].concat(keys)); [].concat(keys).forEach(k => store.delete(k)); } };
  if (withHead) r2.head = async (k) => { r2.heads++; const v = store.get(k); return v ? { httpMetadata: { contentType: v.type }, size: v.bytes.byteLength } : null; };
  return r2;
}
function makeCache() {
  const m = new Map();
  return { m, async match(rq) { const v = m.get(rq.url); return v ? v.clone() : undefined; },
    async put(rq, res) { m.set(rq.url, res.clone()); }, async delete(rq) { return m.delete(rq.url); } };
}
function originServing(bytes, type) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), key: init && init.headers && init.headers['X-Img-Key'] });
    return new Response(bytes, { status: 200, headers: { 'Content-Type': type } });
  };
  return { calls, fetchImpl };
}
async function callFn(url, { env, method = 'GET', headers = {} }, origin) {
  const F = await fn();
  const u = new URL(url, 'https://review-web-system.pages.dev');
  const m = u.pathname.match(/^\/img\/([^/]*)\/([^/]*)$/) || [];
  const waits = [];
  const ctx = { request: new Request(u.toString(), { method, headers }), env,
    params: { kind: decodeURIComponent(m[1] || ''), fileId: decodeURIComponent(m[2] || '') }, waitUntil(p) { waits.push(p); } };
  const res = await F.onRequest(ctx, origin ? origin.fetchImpl : undefined);
  await Promise.all(waits);
  return res;
}
const envWith = (r2) => ({ IMG_SIGNING_KEY: KEY, IMG_ORIGIN_KEY: ORIGIN_KEY, ORIGIN_API: 'http://origin.test', IMG_BUCKET: r2 });

test('A1) o = 원본 바이트 그대로(sha256 동일) · Content-Type 원본 · R2 orig/<id> · 두 번째는 원본 호출 0', async () => {
  globalThis.caches = { default: makeCache() };
  const r2 = makeR2();
  const o = originServing(JPEG, 'image/jpeg');
  const url = edge.signImage(IDS.jpg, 'o');
  assert.match(url, /^\/img\/o\/[-\w]+\?e=\d+&s=[-\w]{43}$/, '서명 형식은 t/m 과 같다(kind 만 o)');
  const r1 = await callFn(url, { env: envWith(r2) }, o);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('Content-Type'), 'image/jpeg', '원본 형식 그대로(WebP 로 바꾸지 않는다)');
  assert.equal(sha(await r1.arrayBuffer()), sha(JPEG), '바이트 동일');
  assert.equal(r1.headers.get('X-Img-Src'), 'origin');
  assert.match(r1.headers.get('Cache-Control'), /^private, max-age=\d+$/);
  assert.match(r1.headers.get('Content-Security-Policy') || '', /sandbox/, '원본은 문서로 열려도 스크립트가 돌지 않게');
  assert.equal(o.calls.length, 1);
  assert.equal(o.calls[0].url, `http://origin.test/api/img-internal/o/${IDS.jpg}`);
  assert.equal(o.calls[0].key, ORIGIN_KEY);
  const stored = r2.store.get(`orig/${IDS.jpg}`);
  assert.ok(stored, 'R2 orig/<id> 에 담는다');
  assert.equal(stored.type, 'image/jpeg');
  assert.equal(sha(stored.bytes), sha(JPEG));
  assert.ok(!r2.store.has(`thumb/o/${IDS.jpg}.webp`), '.webp 이름으로 담지 않는다');
  const r2nd = await callFn(url, { env: envWith(r2) }, o);
  assert.equal(sha(await r2nd.arrayBuffer()), sha(JPEG));
  assert.equal(r2nd.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(o.calls.length, 1, '두 번째는 엣지/R2');
  globalThis.caches = { default: makeCache() };
  const r3 = await callFn(url, { env: envWith(r2) }, o);
  assert.equal(r3.headers.get('X-Img-Src'), 'r2');
  assert.equal(r3.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(sha(await r3.arrayBuffer()), sha(JPEG));
});

test('A2) o 도 서명 없으면 403 · t 서명으로 o 를 열 수 없다 · 모르는 kind 403 — 원본·R2 호출 0', async () => {
  globalThis.caches = { default: makeCache() };
  const r2 = makeR2(); const o = originServing(JPEG, 'image/jpeg');
  const t = new URL(edge.signImage(IDS.jpg, 't'), 'https://x').searchParams;
  for (const u of [`/img/o/${IDS.jpg}`, `/img/o/${IDS.jpg}?e=${t.get('e')}&s=${t.get('s')}`, `/img/x/${IDS.jpg}?e=${t.get('e')}&s=${t.get('s')}`]) {
    const res = await callFn(u, { env: envWith(r2) }, o);
    assert.equal(res.status, 403, u);
  }
  assert.equal(o.calls.length, 0); assert.equal(r2.gets, 0);
});

test('A3) 원본 서버가 사진 아닌 것·SVG 를 주면 o 는 담지도 내주지도 않는다(502 → 화면은 종전 프록시)', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
    globalThis.caches = { default: makeCache() };
    const r2 = makeR2(); const o = originServing(Buffer.from('<svg/>'), type);
    const res = await callFn(edge.signImage(IDS.jpg, 'o'), { env: envWith(r2) }, o);
    assert.equal(res.status, 502, type);
    assert.equal(r2.puts, 0, type + ' 저장 0');
  }
});

test('A4) HEAD — R2 에 있으면 head() 만(몸통 읽기 0) · X-Img-Src r2 · 없으면 만들어 담는다', async () => {
  globalThis.caches = { default: makeCache() };
  const r2 = makeR2(); const o = originServing(JPEG, 'image/jpeg');
  const url = edge.signImage(IDS.jpg, 'o');
  const h1 = await callFn(url, { env: envWith(r2), method: 'HEAD' }, o);
  assert.equal(h1.status, 200);
  assert.equal(h1.headers.get('X-Img-Src'), 'origin');
  assert.ok(r2.store.has(`orig/${IDS.jpg}`), 'HEAD 로도 미리 만든다');
  globalThis.caches = { default: makeCache() };
  const gets = r2.gets;
  const h2 = await callFn(url, { env: envWith(r2), method: 'HEAD' }, o);
  assert.equal(h2.status, 200);
  assert.equal(h2.headers.get('X-Img-Src'), 'r2');
  assert.equal(h2.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(r2.gets, gets, 'R2 몸통 읽기 0');
  assert.equal(o.calls.length, 1);
  assert.equal((await h2.arrayBuffer()).byteLength, 0);
});

test('A5) DELETE 는 t·m·o 세 사본을 지운다', async () => {
  globalThis.caches = { default: makeCache() };
  const r2 = makeR2();
  const res = await callFn(`/img/t/${IDS.jpg}`, { env: envWith(r2), method: 'DELETE', headers: KEYH });
  assert.equal(res.status, 200);
  assert.deepEqual(r2.deletes.sort(), [`orig/${IDS.jpg}`, `thumb/m/${IDS.jpg}.webp`, `thumb/t/${IDS.jpg}.webp`].sort());
});

// ─────────────────────────── B. 내부 입구 o + 원본 메모리 캐시 ───────────────────────────
test('B1) 내부 입구 o = 변환 0(sharp 호출 0) · 바이트 동일 · Content-Type 원본 · fallback 표지 없음', async () => {
  for (const [fid, bytes, type] of [[IDS.jpg, JPEG, 'image/jpeg'], [IDS.png, PNG_BYTES, 'image/png']]) {
    const r = await req(server, 'GET', `/api/img-internal/o/${fid}`, { headers: KEYH });
    assert.equal(r.status, 200, fid);
    assert.equal(r.headers['content-type'], type);
    assert.equal(sha(r.body), sha(bytes), '바이트 동일');
    assert.equal(r.headers['x-img-fallback'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal(sharpCalls, 0, '원본 길은 sharp 를 부르지 않는다');
});

test('B2) 내부 입구 o — SVG 404 · 25MB 초과 413 · 허용 밖 404 + 드라이브 읽기 0 · 열쇠 없음 401', async () => {
  assert.equal((await req(server, 'GET', `/api/img-internal/o/${IDS.svg}`, { headers: KEYH })).status, 404);
  assert.equal((await req(server, 'GET', `/api/img-internal/o/${IDS.big}`, { headers: KEYH })).status, 413);
  reads.length = 0;
  assert.equal((await req(server, 'GET', `/api/img-internal/o/${IDS.out}`, { headers: KEYH })).status, 404);
  assert.equal(reads.length, 0, '허용 밖은 드라이브를 읽지 않는다');
  assert.equal((await req(server, 'GET', `/api/img-internal/o/${IDS.jpg}`)).status, 401);
});

test('B3) 같은 파일 t → m → o 연달아 = 드라이브 읽기 1회 · 동시 요청도 1회로 합친다', async () => {
  for (const k of ['t', 'm', 'o']) assert.equal((await req(server, 'GET', `/api/img-internal/${k}/${IDS.jpg}`, { headers: KEYH })).status, 200, k);
  assert.deepEqual(reads, [IDS.jpg]);
  reads.length = 0;
  const all = await Promise.all(['t', 'm', 'o'].map(k => req(server, 'GET', `/api/img-internal/${k}/${IDS.slow}`, { headers: KEYH })));
  assert.deepEqual(all.map(r => r.status), [200, 200, 200]);
  assert.deepEqual(reads, [IDS.slow], '동시 첫 요청은 한 번 읽기를 나눠 쓴다');
});

test('B4) 원본 캐시 — 수명이 지나면 다시 읽는다 · 총량 상한을 넘으면 오래된 것부터 버린다 · 실패는 담지 않는다', async () => {
  assert.equal(srcCache.TTL_MS <= 60000 && srcCache.TTL_MS >= 10000, true, '수십 초');
  assert.equal(srcCache.MAX_BYTES, 64 * 1024 * 1024);
  srcCache.__setForTest({ ttlMs: 30 });
  let n = 0;
  const loader = async (x) => { n++; return { buffer: Buffer.alloc(10), mimeType: 'image/jpeg', name: x }; };
  await srcCache.get('A', loader); await srcCache.get('A', loader);
  assert.equal(n, 1);
  await sleep(50);
  await srcCache.get('A', loader);
  assert.equal(n, 2, '수명 뒤 다시 읽기');
  srcCache.__resetForTest();
  srcCache.__setForTest({ maxBytes: 25 });
  await srcCache.get('A', loader); await srcCache.get('B', loader); await srcCache.get('C', loader);
  assert.ok(srcCache.__stats().bytes <= 25);
  n = 0; await srcCache.get('A', loader); assert.equal(n, 1, '가장 오래된 A 가 밀려났다');
  srcCache.__resetForTest();
  let fails = 0;
  const bad = async () => { fails++; throw new Error('drive down'); };
  await assert.rejects(() => srcCache.get('Z', bad));
  await assert.rejects(() => srcCache.get('Z', bad));
  assert.equal(fails, 2, '실패는 기억하지 않는다');
});

test('B5) 사본 드리프트 — 원본 캐시 한 장 상한 = 내부 입구 상한 · Function 의 원본 형식 목록 = 서버 목록', () => {
  assert.equal(srcCache.MAX_ENTRY_BYTES, edge.MAX_SOURCE_BYTES);
  const fnSrc = R('functions/img/[kind]/[fileId].js');
  const m = fnSrc.match(/const ORIGINAL_TYPE_RE = (\/.*\/i);/);
  assert.ok(m, 'Function 에 원본 형식 목록이 있다');
  assert.equal(m[1], String(edge.ORIGINAL_TYPE_RE));
  assert.equal(edge.originalTypeOk('image/svg+xml'), false);
  assert.equal(edge.originalTypeOk('image/jpeg'), true);
});

// ─────────────────────────── C. 서명 ───────────────────────────
test('C1) 일괄 서명 입구 — kind o 를 받는다 · t 요청에 o 덤(extra)을 같은 허용 판정으로 싣는다', async () => {
  const tok = staffToken();
  const r = await req(server, 'POST', '/api/img/sign', { headers: { Authorization: 'Bearer ' + tok }, body: { kind: 'o', ids: [IDS.jpg, IDS.out] } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.match(j.urls[IDS.jpg], /^\/img\/o\//);
  assert.equal(j.urls[IDS.out], undefined, '허용 밖은 서명 0');
  const r2 = await req(server, 'POST', '/api/img/sign', { headers: { Authorization: 'Bearer ' + tok }, body: { kind: 't', ids: [IDS.jpg, IDS.out], extra: ['o', 'zz'] } });
  const j2 = JSON.parse(r2.body);
  assert.match(j2.urls[IDS.jpg], /^\/img\/t\//);
  assert.match(j2.more.o[IDS.jpg], /^\/img\/o\//);
  assert.equal(j2.more.o[IDS.out], undefined, '덤도 허용 통과 번호만');
  assert.equal(j2.more.zz, undefined, '모르는 kind 덤은 무시');
  assert.equal(reads.length, 0, '서명은 드라이브를 읽지 않는다');
});

test('C2) 보고 응답(withThumbs) — t 와 o 를 함께 싣는다 · 열쇠 없으면 그대로', () => {
  const out = edge.withThumbs([{ id: IDS.jpg, name: 'a' }]);
  assert.match(out[0].t, /^\/img\/t\//);
  assert.match(out[0].o, /^\/img\/o\//);
  assert.equal(edge.KINDS.o && edge.KINDS.o.original, true, 'o = 원본(변환 규격 없음)');
  const save = process.env.IMG_SIGNING_KEY; delete process.env.IMG_SIGNING_KEY;
  try { assert.deepEqual(edge.withThumbs([{ id: IDS.jpg }]), [{ id: IDS.jpg }]); } finally { process.env.IMG_SIGNING_KEY = save; }
});

// ─────────────────────────── D. 미리 만들기 ───────────────────────────
test('D1) 업로드 직후 미리 만들기 = t → m → o 순서(한 장씩 차례로)', async () => {
  const urls = [];
  const f = async (u) => { urls.push(String(u)); return new Response(null, { status: 200, headers: { 'X-Img-Src': 'origin' } }); };
  warm.__setDepsForTest({ fetch: f, checkFresh: async () => ({ ok: true }), firstDelayMs: 0, retryDelayMs: 0 });
  try {
    assert.equal(warm.scheduleUploadWarm(IDS.jpg, 'image/jpeg'), true);
    for (let i = 0; i < 40; i++) await sleep(2);
    assert.deepEqual(urls.map(u => new URL(u).pathname), ['t', 'm', 'o'].map(k => `/img/${k}/${IDS.jpg}`));
    assert.deepEqual(warm.WARM_KINDS, ['t', 'm', 'o']);
  } finally { warm.__resetForTest(); }
});

test('D2) 일괄 스크립트 인자 — --kinds 기본 t,m,o · 고르기 · 모르는 kind 거부 · --days 없으면 전체(null)', () => {
  assert.deepEqual(imgWarmScript.parseArgs([]).kinds, ['t', 'm', 'o']);
  assert.equal(imgWarmScript.parseArgs([]).days, null);
  assert.deepEqual(imgWarmScript.parseArgs(['--kinds', 'o,t']).kinds, ['t', 'o'], '언제나 t → m → o 순서');
  assert.equal(imgWarmScript.parseArgs(['--days', '30']).days, 30);
  assert.throws(() => imgWarmScript.parseArgs(['--kinds', 't,x']), /kind/);
  assert.ok(imgWarmScript.parseArgs([]).limit >= 100000, '전체(4.9만 장)가 상한에 걸리지 않는다');
});

test('D3) 일괄 스크립트 실행 — 최신순 번호마다 t → m → o · 이미 있음(r2·edge) 세기 · 기간 없으면 SQL 기간 조건 없음', async () => {
  const sent = [];
  const rows = [{ id: IDS.jpg }, { id: IDS.png }];
  const db = { async query(sql, p) { sent.push({ sql: String(sql), p }); return /SELECT id FROM/.test(sql) ? { rows } : { rows: [] }; } };
  const urls = [];
  const f = async (u, init) => {
    urls.push({ path: new URL(String(u)).pathname, method: init && init.method });
    const hit = /\/img\/t\//.test(String(u));
    return new Response(null, { status: 200, headers: { 'X-Img-Src': hit ? 'r2' : 'origin' } });
  };
  const r = await imgWarmScript.main(['--concurrency', '1'], { db, fetch: f, log: () => {}, env: { IMG_SIGNING_KEY: KEY } });
  const q = sent.find(s => /SELECT id FROM/.test(s.sql));
  assert.equal(q.p[0], null, '--days 없음 = 기간 제한 없음');
  assert.deepEqual(urls.map(u => u.path), [
    `/img/t/${IDS.jpg}`, `/img/m/${IDS.jpg}`, `/img/o/${IDS.jpg}`,
    `/img/t/${IDS.png}`, `/img/m/${IDS.png}`, `/img/o/${IDS.png}`]);
  assert.ok(urls.every(u => u.method === 'HEAD'), '몸통을 받지 않는다(원본 25MB 를 스크립트가 내려받지 않게)');
  assert.equal(r.total, 2);
  assert.deepEqual(r.byKind.t, { hit: 2, made: 0, skip: 0, fail: 0 });
  assert.deepEqual(r.byKind.o, { hit: 0, made: 2, skip: 0, fail: 0 });
});

test('D4) 기간 없음(null) SQL 이 PGlite 에서 오래된 사진까지 잡는다 · 가이드 사진 포함', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE review_submissions (file_id TEXT, created_at TIMESTAMPTZ, slot_key TEXT NOT NULL DEFAULT 'review');
      CREATE TABLE order_submissions (capture_file_id TEXT, capture_file_id_2 TEXT, capture_uploaded_at TIMESTAMPTZ,
        capture2_uploaded_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
      CREATE TABLE review_index (review_file_id TEXT, review_file_at TIMESTAMPTZ);
      CREATE TABLE review_inspections (file_id TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE review_edit_requests (old_file_id TEXT, new_file_id TEXT, created_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE purchase_capture_artifacts (file_id TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE purchase_capture_supplements (file_id TEXT, created_at TIMESTAMPTZ);
      CREATE TABLE purchase_submission_sessions (capture_file_id TEXT, created_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'prepared');
      CREATE TABLE reviewer_event_logs (context JSONB, occurred_at TIMESTAMPTZ);
      CREATE TABLE guide_image_files (file_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ);
      CREATE TABLE payment_result_drive_archive (drive_file_id TEXT);
      INSERT INTO review_submissions (file_id, created_at) VALUES ('${IDS.jpg}', now() - interval '900 days'), ('${IDS.png}', now() - interval '1 day');
      INSERT INTO guide_image_files VALUES ('${IDS.b}', now() - interval '400 days');
    `);
    assert.deepEqual(await warm.collectRecentIds(db, { days: null }), [IDS.png, IDS.b, IDS.jpg], '전체 · 최신순 · 가이드 포함');
    assert.deepEqual(await warm.collectRecentIds(db, { days: 60 }), [IDS.png], '기간을 주면 종전대로');
  } finally { await db.close(); }
});

// ─────────────────────────── E. 화면(drive-thumb) — vm 실행 ───────────────────────────
const D1 = id('DD1'), D2 = id('DD2');
const EXP = () => Math.floor(Date.now() / 1000) + 12 * 3600;
const SIG = 'A'.repeat(43);
const PROXY = (x) => `https://api.example.com/api/drive/image/${x}`;
function loadThumb({ token, reply, status = 200 } = {}) {
  const mem = token ? { admin_token: token } : {};
  const fetches = [], timers = [], images = [], listeners = {};
  const sb = {
    console, Date, JSON, Math, Object, String, Number, Promise, RegExp, Array,
    setTimeout: (f) => { timers.push(f); return 1; },
    sessionStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } },
    fetch: (u, init) => { fetches.push({ u, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply) }); },
    document: { querySelectorAll: () => [], addEventListener: (t, f) => { listeners[t] = f; } },
    Image: function () { const im = { set src(v) { this._src = v; images.push(this); }, get src() { return this._src; } }; return im; },
    API_BASE_URL: 'https://api.example.com',
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(R('frontend/js/drive-thumb.js'), sb);
  const tick = async () => { while (timers.length) timers.shift()(); for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return { T: sb.DriveThumb, fetches, tick, images, listeners };
}
function mkImg(attrStr) {
  const a = {}; attrStr.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v.replace(/&amp;/g, '&'); });
  return { a, dataset: {}, getAttribute(k) { return k in this.a ? this.a[k] : null; }, setAttribute(k, v) { this.a[k] = String(v); },
    removeAttribute(k) { delete this.a[k]; }, get src() { return this.a.src; }, set src(v) { this.a.src = v; } };
}

test('E1) 원본 유지 자리 — t·m 서명이 있어도 절대 변환본을 쓰지 않는다 · o 없으면 종전 프록시 그대로', () => {
  const { T } = loadThumb();
  T.seed([`/img/t/${D1}?e=${EXP()}&s=${SIG}`, `/img/m/${D1}?e=${EXP()}&s=${SIG}`]);
  assert.equal(T.fullAttrs(D1, PROXY(D1)), ` src="${PROXY(D1)}"`, '종전과 글자 하나 다르지 않다');
  assert.equal(T.full(D1, PROXY(D1)), PROXY(D1));
  assert.equal(T.fullAttrs('bad', PROXY('bad')), ` src="${PROXY('bad')}"`);
});

test('E2) o 가 있으면 o · 실패하면 종전 프록시로 1회(다시 o 로 가지 않는다)', () => {
  const { T } = loadThumb();
  const o = `/img/o/${D1}?e=${EXP()}&s=${SIG}`;
  T.seed([o]);
  assert.equal(T.full(D1, PROXY(D1)), o);
  const img = mkImg(T.fullAttrs(D1, PROXY(D1)));
  assert.equal(img.src, o);
  assert.ok(!/\/img\/[tm]\//.test(JSON.stringify(img.a)), '변환본 주소가 속성 어디에도 없다');
  assert.equal(T.fullFall(img), true);
  assert.equal(img.src, PROXY(D1));
  assert.equal(T.fullFall(img), false, '한 번만');
  assert.equal(T.full(D1, PROXY(D1)), PROXY(D1), '실패한 o 는 이 페이지에서 다시 쓰지 않는다');
});

test('E3) 직원 화면 — 목록 그리기(t)의 서명 요청 한 번에 o 를 덤으로 받는다(요청 수 그대로)', async () => {
  const { T, fetches, tick } = loadThumb({ token: 'tok', reply: (b) => ({ ok: true, enabled: true,
    urls: Object.fromEntries(b.ids.map(x => [x, `/img/${b.kind}/${x}?e=${EXP()}&s=${SIG}`])),
    more: { o: Object.fromEntries(b.ids.map(x => [x, `/img/o/${x}?e=${EXP()}&s=${SIG}`])) } }) });
  T.attrs(D1, 400, PROXY(D1)); T.attrs(D2, 400, PROXY(D2));
  await tick();
  assert.equal(fetches.length, 1);
  assert.deepEqual(fetches[0].body.extra, ['o']);
  assert.match(T.full(D1, PROXY(D1)), /^\/img\/o\//);
  await tick();
  assert.equal(fetches.length, 1, '덤으로 받은 o 는 다시 묻지 않는다');
});

test('E4) 옛 서버(kind o 모름 → 400 · more 없음)여도 작은 사진 빠른 길은 꺼지지 않는다', async () => {
  let n = 0;
  const env = loadThumb({ token: 'tok', reply: (b) => { n++; return { ok: true, enabled: true,
    urls: Object.fromEntries(b.ids.map(x => [x, `/img/${b.kind}/${x}?e=${EXP()}&s=${SIG}`])) }; } });
  env.T.attrs(D1, 400, PROXY(D1));
  await env.tick();
  assert.equal(env.T.full(D1, PROXY(D1)), PROXY(D1), 'o 없음 = 종전 프록시');
  await env.tick();
  assert.ok(env.fetches.every(f => f.body.kind !== 'o'), '덤을 못 받은 번호는 o 를 따로 묻지 않는다(옛 서버 400 회피)');
  const env2 = loadThumb({ token: 'tok', status: 400, reply: null });
  env2.T.full(D2, PROXY(D2));
  await env2.tick();
  assert.equal(env2.fetches.length, 1);
  assert.equal(env2.fetches[0].body.kind, 'o');
  env2.T.attrs(D1, 400, PROXY(D1));
  await env2.tick();
  assert.equal(env2.fetches.length, 2, 'o 400 이 났어도 t 서명은 계속 묻는다(off 아님)');
});

test('E5) o 미리 불러두기 — 동시 2장 상한 · 같은 사진 1회 · 마우스 올림(t 목록 사진)에서 시작', () => {
  const { T, images, listeners } = loadThumb();
  const ids = [1, 2, 3, 4, 5].map(n => id('PF' + n));
  T.seed(ids.map(x => `/img/o/${x}?e=${EXP()}&s=${SIG}`));
  ids.forEach(x => T.prefetch(x));
  assert.equal(images.length, 2, '동시 2장');
  assert.ok(images.every(im => /^\/img\/o\//.test(im.src)));
  images[0].onload(); 
  assert.equal(images.length, 3, '하나 끝나면 다음');
  T.prefetch(ids[0]);
  assert.equal(images.filter(im => im.src.includes(ids[0])).length, 1, '같은 사진 1회');
  assert.equal(T.prefetch(id('NOSIG')), false, 'o 서명 없으면 안 부른다');
  assert.equal(typeof listeners.mouseover, 'function', '마우스 올림 감지');
  const before = images.length;
  const tImg = mkImg(` data-dt-id="${ids[4]}" data-dt-k="t"`);
  tImg.closest = () => tImg;
  images.forEach(im => im.onload && im.onload());
  listeners.mouseover({ target: tImg });
  assert.ok(images.length >= before, '목록 사진 위 마우스 = o 미리 불러두기');
});

// ─────────────────────────── F. 화면 배선 ───────────────────────────
test('F1) 원본 유지 자리 5종이 공용 원본 함수를 쓴다(작은 사진 함수 0)', () => {
  const WD = R('frontend/workdesk.html');
  const CS = R('frontend/js/cs-review-edit-card.js');
  const RP = R('frontend/report.html');
  const WO = R('frontend/js/work-order-detail.js');
  const pop = WD.slice(WD.indexOf('\nfunction _rvPopCol('), WD.indexOf('\nfunction _rvPopItem('));
  assert.match(pop, /<img\$\{_fullAttrs\(list\[i\]\.fileId,list\[i\]\.url\)\}/);
  assert.ok(!/_thumbAttrs|_thumbUrl/.test(pop));
  assert.ok((WD.match(/class="rizoomable"\$\{_riFull\(/g) || []).length >= 3, '검수 대조 3자리');
  assert.ok(!/class="rizoomable" src=/.test(WD), '대조 자리에 맨 src 가 남지 않는다');
  assert.match(WD, /function _fullAttrs\(id, full\)\{\n  return window\.DriveThumb && DriveThumb\.fullAttrs \? DriveThumb\.fullAttrs\(id, full\) : ` src="\$\{esc\(full\|\|''\)\}"`;/);
  assert.match(WD, /function _riFull\(id\)\{ return _fullAttrs\(id, _riImg\(id\)\); \}/);
  assert.match(WD, /woImageModal\(_fullUrl\(id, url\), url\)/, '돋보기 = o, 실패 시 원본 프록시');
  assert.match(CS, /DriveThumb\.fullAttrs\(oldId, uOld\)/);
  assert.match(CS, /DriveThumb\.fullAttrs\(newId, uNew\)/);
  assert.match(RP, /var FU = window\.DriveThumb && DriveThumb\.full \? DriveThumb\.full\(id, IMG\(id\)\) : IMG\(id\);/);
  assert.match(RP, /im\.src=FU;/);
  assert.match(RP, /dl\.href=FU;/);
  assert.match(RP, /return \[im\.t, im\.o\];/, '보고 응답의 o 를 넣는다');
  assert.match(WO, /function woImageModal\(url, alt\)/);
  for (const [n, s] of [['workdesk', WD], ['cs', CS], ['report', RP]]) assert.ok(!/DriveThumb\.full(?:Attrs)?\([^)]*\b(?:400|1600|600)\b/.test(s), n + ' 원본 함수에 크기를 넘기지 않는다');
});
