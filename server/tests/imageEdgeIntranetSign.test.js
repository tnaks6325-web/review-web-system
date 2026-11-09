'use strict';
/**
 * 결정 354 보강 — 일괄 서명은 Track B 경로(/api/trackb/img/sign)로 받는다.
 *   운영 실측(2026-11-09): 작업보드 로그인은 인트라넷 SSO 토큰(via:'intranet')이라 authMiddleware 가
 *   /api/trackb/* 밖을 403 으로 막는다 → POST /api/img/sign 이 늘 403 → 화면은 전부 구글 썸네일(빠른 길 0장).
 *   ⭐ 수동제출·탭설정과 같은 「Track B 재기준 누락」 계열 — 같은 핸들러를 trackb 경로에 위임한다(로직 복제 0).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-intranet-sign';
const jwt = require('jsonwebtoken');
const express = require('express');
const SERVER = path.resolve(__dirname, '..');
const { authMiddleware } = require(path.join(SERVER, 'src/middleware/auth.middleware'));
const routes = require(path.join(SERVER, 'src/routes/imageEdge.routes'));

function call(server, p, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ kind: 't', ids: ['1AAAAAAAAAAAAAAAAAAAAAAAAAAAA'] });
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + token } },
    res => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); r.end(body);
  });
}

test('intranet SSO token: /api/img/sign is blocked (403) but the Track B delegate signs (200)', async () => {
  assert.equal(typeof routes.signHandler, 'function', 'imageEdge.routes must export signHandler for the Track B delegate');
  const app = express();
  app.use(express.json());
  routes.mount(app, { beforeLimiter: false });
  const tb = express.Router();
  tb.post('/img/sign', authMiddleware, routes.signHandler);
  app.use('/api/trackb', tb);
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const save = process.env.IMG_SIGNING_KEY; process.env.IMG_SIGNING_KEY = '';
  try {
    const tok = jwt.sign({ name: 'sso', role: 'admin', via: 'intranet' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await call(server, '/api/img/sign', tok)).status, 403);
    const r = await call(server, '/api/trackb/img/sign', tok);
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).ok, true);
  } finally { process.env.IMG_SIGNING_KEY = save; server.close(); }
});

test('trackB.routes delegates POST /img/sign to the same handler behind internalMiddleware', () => {
  const src = fs.readFileSync(path.join(SERVER, 'src/routes/trackB.routes.js'), 'utf8');
  assert.match(src, /router\.post\('\/img\/sign', authMiddleware, internalMiddleware, [^\n]*signHandler/);
});

test('drive-thumb.js asks the Track B sign endpoint', () => {
  const fe = fs.readFileSync(path.resolve(SERVER, '..', 'frontend/js/drive-thumb.js'), 'utf8');
  assert.match(fe, /'\/api\/trackb\/img\/sign'/);
  assert.doesNotMatch(fe, /fetch\(base \+ '\/api\/img\/sign'/);
});
