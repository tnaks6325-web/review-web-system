'use strict';
/**
 * 결정 353 — 사진 빠른 길의 서버 쪽 회귀가드.
 *
 *   A) signImage — 열쇠 없음/짧음 = null(화면이 옛 길) · 형식 불량 null · 6시간 칸 반올림
 *   B) 내부 생성 입구 GET /api/img-internal/:kind/:fileId (Pages Function 만 부른다, X-Img-Key)
 *      설정 없음 503 · 열쇠 없음/틀림 401 · 허용 목록 밖·이체결과 404 + 드라이브 읽기 0 ·
 *      허용 = 진짜 sharp 로 WebP(가로 400/1600 이하) · sharp 없으면 원본 그대로(X-Img-Fallback) ·
 *      사진 아님 404 · 너무 큼 413 · 드라이브 실패 502
 *   C) 일괄 서명 입구 POST /api/img/sign — 로그인 필수(req.admin) · 허용 목록 통과 번호만 ·
 *      열쇠 없으면 enabled:false · kind 불량 400 · 조회 실패(fail-open) 번호는 서명하지 않는다
 *   D) 속도 제한 우회는 **열쇠가 맞을 때만**(app.js 배선) · 서버 코드는 req.admin 만
 *   E) 옛 통로 카운터 — 출처(사이트)별로만 세고 파일 번호를 남기지 않는다
 *   F) 보고 페이지 응답이 서명 주소(t)를 싣는다(무인증 화면은 응답이 서명을 싣는 방식)
 *
 * 실행: node tests/imageEdge.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const SERVER = path.resolve(__dirname, '..');
process.env.JWT_SECRET = 'test-jwt-secret-for-image-edge';
process.env.IMG_SIGNING_KEY = 's'.repeat(48);
process.env.IMG_ORIGIN_KEY = 'o'.repeat(48);

const drive = require(path.join(SERVER, 'src/services/drive.service'));
const allow = require(path.join(SERVER, 'src/services/imageAllowlist.service'));
const edge = require(path.join(SERVER, 'src/services/imageEdge.service'));
const routes = require(path.join(SERVER, 'src/routes/imageEdge.routes'));

const id = (tag) => (tag + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3').slice(0, 33);
const IDS = { drive: id('DRV'), guide: id('GDE'), pay: id('PAY'), unknown: id('UNK'), big: id('BIG'),
  xlsx: id('XLSX'), broken: id('BRK'), fail: id('FAIL') };

// 허용 판정 DB 는 가짜(판정 SQL 이 어느 통로인지만 본다) — 판정 규칙 자체는 imageAllowlist.test.js 가 지킨다.
let dbDown = false;
allow.__setPoolForTest({ async query(sql, [fid]) {
  if (dbDown) throw new Error('db down');
  const guide = /guide_image_files/.test(sql);
  const allowed = guide ? fid === IDS.guide : [IDS.drive, IDS.big, IDS.xlsx, IDS.broken, IDS.fail, IDS.pay].includes(fid);
  return { rows: [{ private: fid === IDS.pay, allowed }] };
} });

let PNG;
const reads = [];
drive.downloadFile = async (fid) => {
  reads.push(fid);
  if (fid === IDS.fail) throw new Error('drive 500');
  if (fid === IDS.xlsx) return { buffer: Buffer.from('PK'), mimeType: 'application/vnd.ms-excel', name: 'x' };
  if (fid === IDS.big) return { buffer: Buffer.alloc(edge.MAX_SOURCE_BYTES + 1), mimeType: 'image/png', name: 'b' };
  if (fid === IDS.broken) return { buffer: Buffer.from('not really a png'), mimeType: 'image/png', name: 'k' };
  return { buffer: PNG, mimeType: 'image/png', name: fid };
};

function startApp() {
  const app = express();
  app.use(express.json());
  routes.mount(app, { beforeLimiter: true });
  app.use('/api/', (req, res, next) => { req._limited = true; res.setHeader('X-Limited', '1'); next(); });
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
const KEYH = { 'X-Img-Key': 'o'.repeat(48) };
const staffToken = () => jwt.sign({ name: 'tester', role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let server;
test.before(async () => {
  const sharp = require('sharp');
  PNG = await sharp({ create: { width: 1080, height: 2340, channels: 3, background: '#88aacc' } }).png().toBuffer();
  server = await startApp();
});
test.after(() => server && server.close());
test.beforeEach(() => { allow.__resetCacheForTest(); reads.length = 0; dbDown = false; edge.__setSharpForTest(undefined); });

test('A) signImage — 열쇠 없음·짧음 = null · 형식 불량 null · 6시간 칸', () => {
  const now = Date.UTC(2026, 10, 9, 2, 0, 0);
  const u = edge.signImage(IDS.drive, 't', now);
  assert.match(u, /^\/img\/t\/[-\w]{20,}\?e=\d+&s=[-\w]{43}$/);
  assert.equal(Number(new URL(u, 'https://x').searchParams.get('e')) % (6 * 3600), 0, '6시간 칸 경계');
  assert.equal(edge.signImage('짧은번호', 't', now), null);
  assert.equal(edge.signImage(IDS.drive, 'o', now), null, '원본 kind 는 없다(대조는 원본 통로)');
  const save = process.env.IMG_SIGNING_KEY;
  try {
    process.env.IMG_SIGNING_KEY = ''; assert.equal(edge.signImage(IDS.drive, 't', now), null);
    process.env.IMG_SIGNING_KEY = 'short-key'; assert.equal(edge.signImage(IDS.drive, 't', now), null, '32자 미만 열쇠는 끈 것과 같다');
  } finally { process.env.IMG_SIGNING_KEY = save; }
});

test('B-1) 내부 입구 — 설정 없음 503 · 열쇠 없음/틀림 401 · kind 불량 400 (드라이브 읽기 0)', async () => {
  const save = process.env.IMG_ORIGIN_KEY;
  process.env.IMG_ORIGIN_KEY = '';
  try { assert.equal((await req(server, 'GET', `/api/img-internal/t/${IDS.drive}`, { headers: KEYH })).status, 503); }
  finally { process.env.IMG_ORIGIN_KEY = save; }
  assert.equal((await req(server, 'GET', `/api/img-internal/t/${IDS.drive}`)).status, 401);
  assert.equal((await req(server, 'GET', `/api/img-internal/t/${IDS.drive}`, { headers: { 'X-Img-Key': 'x'.repeat(48) } })).status, 401);
  assert.equal((await req(server, 'GET', `/api/img-internal/o/${IDS.drive}`, { headers: KEYH })).status, 400);
  assert.equal(reads.length, 0);
});

test('B-2) 허용 목록 밖·이체결과 = 404 + 드라이브 읽기 0', async () => {
  for (const fid of [IDS.unknown, IDS.pay]) {
    const r = await req(server, 'GET', `/api/img-internal/t/${fid}`, { headers: KEYH });
    assert.equal(r.status, 404, fid);
  }
  assert.equal(reads.length, 0);
});

test('B-3) 허용 = 진짜 WebP(가로 400 / 1600 이하) · 가이드 사진도 · 원본 저장 캐시 없음(no-store)', async () => {
  const sharp = require('sharp');
  const t = await req(server, 'GET', `/api/img-internal/t/${IDS.drive}`, { headers: KEYH });
  assert.equal(t.status, 200);
  assert.equal(t.headers['content-type'], 'image/webp');
  assert.equal(t.headers['cache-control'], 'no-store');
  assert.equal(t.headers['x-img-fallback'], undefined);
  const mt = await sharp(t.body).metadata();
  assert.equal(mt.format, 'webp'); assert.equal(mt.width, 400);
  assert.ok(t.body.length < PNG.length);
  const m = await req(server, 'GET', `/api/img-internal/m/${IDS.guide}`, { headers: KEYH });
  assert.equal(m.status, 200);
  assert.equal((await sharp(m.body).metadata()).width, 1080, '작은 원본은 키우지 않는다');
  assert.equal(t.headers['x-limited'], undefined, '★ 열쇠가 맞으면 속도 제한을 거치지 않는다(Function 은 몇 개 주소로 몰려 온다)');
  const noKey = await req(server, 'GET', `/api/img-internal/t/${IDS.drive}`);
  assert.equal(noKey.headers['x-limited'], '1', '★ 열쇠가 없으면 종전대로 속도 제한을 거친다');
});

test('B-4) sharp 없음/변환 실패 = 원본 그대로(X-Img-Fallback) · 사진 아님 404 · 너무 큼 413 · 드라이브 실패 502', async () => {
  edge.__setSharpForTest(null);
  const r = await req(server, 'GET', `/api/img-internal/t/${IDS.drive}`, { headers: KEYH });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['x-img-fallback'], 'original');
  assert.equal(r.body.length, PNG.length);
  edge.__setSharpForTest(undefined);
  const br = await req(server, 'GET', `/api/img-internal/t/${IDS.broken}`, { headers: KEYH });
  assert.equal(br.status, 200); assert.equal(br.headers['x-img-fallback'], 'original');
  assert.equal((await req(server, 'GET', `/api/img-internal/t/${IDS.xlsx}`, { headers: KEYH })).status, 404);
  assert.equal((await req(server, 'GET', `/api/img-internal/t/${IDS.big}`, { headers: KEYH })).status, 413);
  assert.equal((await req(server, 'GET', `/api/img-internal/t/${IDS.fail}`, { headers: KEYH })).status, 502);
});

test('B-5) 생성 동시 처리 상한 — 한꺼번에 와도 드라이브 동시 읽기는 GEN_MAX 이하, 모두 끝나면 0', async () => {
  const save = drive.downloadFile;
  let now = 0, peak = 0;
  drive.downloadFile = async (fid) => { now++; peak = Math.max(peak, now); await new Promise(r => setTimeout(r, 20)); now--; return { buffer: PNG, mimeType: 'image/png', name: fid }; };
  edge.__setSharpForTest(null);
  try {
    const rs = await Promise.all(Array.from({ length: routes.GEN_MAX * 2 + 3 }, () => req(server, 'GET', `/api/img-internal/t/${IDS.drive}`, { headers: KEYH })));
    assert.ok(rs.every(r => r.status === 200));
    assert.ok(peak <= routes.GEN_MAX && peak > 1, 'peak ' + peak);
    assert.deepEqual(routes.__genStats(), { active: 0, queued: 0 });
  } finally { drive.downloadFile = save; }
});

test('C) 일괄 서명 — 로그인 필수 · 허용 번호만 · kind 불량 400 · 열쇠 없으면 enabled:false · fail-open 번호는 서명 0', async () => {
  const body = { kind: 't', ids: [IDS.drive, IDS.guide, IDS.unknown, IDS.pay, '짧음', IDS.drive] };
  assert.equal((await req(server, 'POST', '/api/img/sign', { body })).status, 401);
  const auth = { Authorization: 'Bearer ' + staffToken() };
  const r = await req(server, 'POST', '/api/img/sign', { body, headers: auth });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.enabled, true);
  assert.deepEqual(Object.keys(j.urls).sort(), [IDS.drive, IDS.guide].sort());
  assert.match(j.urls[IDS.drive], /^\/img\/t\//);
  assert.equal(reads.length, 0, '서명은 드라이브를 읽지 않는다');
  assert.equal((await req(server, 'POST', '/api/img/sign', { body: { kind: 'o', ids: [IDS.drive] }, headers: auth })).status, 400);
  dbDown = true; allow.__resetCacheForTest();
  const down = JSON.parse((await req(server, 'POST', '/api/img/sign', { body, headers: auth })).body);
  assert.deepEqual(down.urls, {}, 'DB 조회 실패 중에는 서명하지 않는다(화면은 옛 길 — fail-open 은 옛 통로가 맡는다)');
  dbDown = false;
  const save = process.env.IMG_SIGNING_KEY; process.env.IMG_SIGNING_KEY = '';
  try {
    const off = JSON.parse((await req(server, 'POST', '/api/img/sign', { body, headers: auth })).body);
    assert.equal(off.enabled, false); assert.deepEqual(off.urls, {});
  } finally { process.env.IMG_SIGNING_KEY = save; }
  const many = Array.from({ length: 500 }, (_, i) => id('M' + i));
  const capped = await req(server, 'POST', '/api/img/sign', { body: { kind: 'm', ids: many }, headers: auth });
  assert.equal(capped.status, 200, '많이 보내도 상한까지만 본다');
});

test('D) 배선 — app.js 가 속도 제한 앞뒤로 mount · 서버 코드는 req.admin 만(req.user 금지)', () => {
  const app = fs.readFileSync(path.join(SERVER, 'src/app.js'), 'utf8');
  const before = app.indexOf('imageEdgeRoutes.mount(app, { beforeLimiter: true })');
  const limiter = app.indexOf("app.use('/api/', rateLimiter)");
  const after = app.indexOf('imageEdgeRoutes.mount(app, { beforeLimiter: false })');
  assert.ok(before > 0 && limiter > before && after > limiter, '앞(열쇠 맞을 때만) → 속도 제한 → 뒤(나머지)');
  // 빠른 길 주소(/img/<kind>/…)를 만드는 화면 코드는 js/drive-thumb.js 한 곳(사본 0) — 서명은 서버만 만든다.
  const FE = path.resolve(SERVER, '..', 'frontend');
  const offenders = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) { if (!['docs', 'mockups', 'icons'].includes(n)) walk(p); continue; }
    if (!/\.(html|js)$/.test(n) || p.endsWith(path.join('js', 'drive-thumb.js'))) continue;
    if (/['"`]\/img\/(?:t|m|\$\{)|\/api\/img\/sign/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(FE, p));
  } })(FE);
  assert.deepEqual(offenders, [], '빠른 길 주소 규칙 사본');
  for (const f of ['src/routes/imageEdge.routes.js', 'src/services/imageEdge.service.js']) {
    const s = fs.readFileSync(path.join(SERVER, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/req\.user\b/.test(s), f);
  }
});

test('E) 옛 통로 카운터 — 사이트 출처별로만 · 파일 번호·경로 뒤쪽을 남기지 않는다', () => {
  edge.__resetLegacyForTest();
  edge.noteLegacy({ baseUrl: '/api/drive', path: `/image/${IDS.drive}`, headers: { referer: 'https://review-web-system.pages.dev/' } });
  edge.noteLegacy({ baseUrl: '/api/drive', path: `/image/${IDS.drive}`, headers: { referer: 'https://review-web-system.pages.dev/workdesk?x=1' } });
  edge.noteLegacy({ baseUrl: '/api/order', path: `/guide-image/${IDS.guide}`, headers: {} });
  const snap = edge.__legacySnapshot();
  assert.deepEqual(snap, { 'drive review-web-system.pages.dev/': 1, 'drive review-web-system.pages.dev/workdesk': 1, 'guide (none)': 1 });
  const line = edge.__legacyLogLine();
  assert.ok(line && !line.includes(IDS.drive) && !line.includes(IDS.guide) && !line.includes('x=1'), line);
});

test('F) 보고 페이지(무인증) 응답이 목록 사진마다 서명 주소 t 를 싣는다 — 열쇠 없으면 싣지 않는다', () => {
  const s = fs.readFileSync(path.join(SERVER, 'src/routes/drive.routes.js'), 'utf8');
  assert.match(s, /imageEdge\.withThumbs\(images\)/);
  const out = edge.withThumbs([{ id: IDS.drive, name: 'a' }, { id: '짧음' }]);
  assert.match(out[0].t, /^\/img\/t\//);
  assert.equal(out[1].t, undefined);
  const save = process.env.IMG_SIGNING_KEY; process.env.IMG_SIGNING_KEY = '';
  try { assert.equal(edge.withThumbs([{ id: IDS.drive }])[0].t, undefined); } finally { process.env.IMG_SIGNING_KEY = save; }
});
