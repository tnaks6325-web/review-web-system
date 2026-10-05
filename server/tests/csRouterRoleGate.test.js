/**
 * csRouterRoleGate.test.js — 옛 대시보드 C/S(`/api/cs/*`) 역할 게이트가 실제로 직원을 통과시킨다.
 *
 * ★★ 사고(2026-08-26 ~ 2026-10-05): cs.routes 의 internalMiddleware 가 `req.user?.role` 을 읽었는데
 *   authMiddleware 는 토큰 내용을 `req.admin` 에 둔다 → 마스터·관리자·영업담당자 **전원 403**.
 *   옛 대시보드 C/S 탭·안 읽은 개수가 두 달 넘게 막혀 있었다(운영 로그 10/2 다수 403). 3버전은
 *   /api/trackb/cs 위임 경로라 무관했다. 같은 오독(기록자 이름)이 admin·diag·drive 에도 6곳 있었다.
 *
 * 실행: node tests/csRouterRoleGate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cs-gate';
const SECRET = process.env.JWT_SECRET;
let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

(async () => {
  const app = express();
  app.use('/api/cs', require('../src/routes/cs.routes'));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  // 라우터 안에 없는 경로 — 게이트를 통과하면 404, 막히면 403/401 (DB 를 건드리지 않는다)
  const hit = (token) => new Promise((resolve) => {
    const req = http.request({ port, path: '/api/cs/__gate_probe__', method: 'GET', headers: token ? { Authorization: 'Bearer ' + token } : {} },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.end();
  });
  try {
    for (const role of ['master', 'admin', 'staff']) {
      const s = await hit(jwt.sign({ name: 'u', role }, SECRET));
      ok(`${role} 로그인은 C/S 게이트 통과(403 아님 · got ${s})`, s === 404);
    }
    ok('광고주는 C/S 게이트에서 막힌다(403)', (await hit(jwt.sign({ name: 'a', role: 'advertiser', advertiser_id: 1 }, SECRET))) === 403);
    ok('토큰 없음 401', (await hit(null)) === 401);
    ok('인트라넷 토큰은 /api/cs 에 못 온다(403 — trackb 전용)', (await hit(jwt.sign({ name: 'i', role: 'admin', via: 'intranet' }, SECRET))) === 403);
  } finally { server.close(); }

  // authMiddleware 는 req.user 를 세우지 않는다 → 서버 코드가 req.user 를 읽으면 늘 비어 있다(재발 방지)
  const offenders = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.js')) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/\breq\.user\b/.test(code)) offenders.push(`${path.relative(path.join(__dirname, '..'), f)}:${i + 1}`);
      });
    }
  })(path.join(__dirname, '..', 'src'));
  ok('서버 코드가 req.user 를 읽지 않는다(토큰은 req.admin)' + (offenders.length ? ' → ' + offenders.join(', ') : ''), offenders.length === 0);
  console.log(`\n✅ csRouterRoleGate: ${n}개 통과`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
