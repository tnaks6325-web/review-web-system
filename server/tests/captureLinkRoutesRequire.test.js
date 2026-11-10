/**
 * captureLinkRoutesRequire.test.js — 「구매 캡처 연결 복구」 두 경로가 실제로 돈다.
 *
 * 사고(2026-11-10 발견): 코드 다이어트(6a097320, 결정 186)에서 trackB.routes 맨 위의
 *   `const captureLinkBackfill = require(...)` 가 함께 지워져 GET /api/trackb/capture-link/audit 와
 *   POST /api/trackb/capture-link/backfill 이 매번 "captureLinkBackfill is not defined" 로 500 이 났다.
 *   기존 가드(captureLinkBackfill.test.js)는 소스 문자열만 봐서 못 잡았다 → 여기서는 실제 핸들러를 부른다.
 *
 * 실행: node tests/captureLinkRoutesRequire.test.js
 */
const assert = require('assert');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:y@127.0.0.1:1/none';

const svc = require(path.join(__dirname, '..', 'src', 'services', 'captureLinkBackfill.service.js'));
const calls = [];
svc.auditCaptureLinks = async (o) => { calls.push(['audit', o]); return { audited: 0 }; };
svc.backfillCaptureLinks = async (o) => { calls.push(['backfill', o]); return { linked: 0 }; };

const router = require(path.join(__dirname, '..', 'src', 'routes', 'trackB.routes.js'));

function handlerOf(method, p) {
  const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
  assert.ok(layer, `경로 없음: ${method.toUpperCase()} ${p}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function run(h, req) {
  return new Promise((resolve) => {
    h(req, { json: (body) => resolve({ body }) }, (err) => resolve({ err }));
  });
}

(async () => {
  let n = 0;
  const a = await run(handlerOf('get', '/capture-link/audit'), { query: { days: '7' } });
  assert.ok(!a.err, `감사 경로가 오류로 끝남: ${a.err && a.err.message}`);
  assert.strictEqual(a.body.ok, true); assert.strictEqual(a.body.audited, 0); n++;

  const b = await run(handlerOf('post', '/capture-link/backfill'),
    { body: { days: 7 }, user: { username: 'tester' }, admin: { username: 'tester' } });
  assert.ok(!b.err, `복구 경로가 오류로 끝남: ${b.err && b.err.message}`);
  assert.strictEqual(b.body.ok, true); n++;

  assert.deepStrictEqual(calls.map((c) => c[0]), ['audit', 'backfill']); n++;
  assert.strictEqual(calls[1][1].dryRun, true, '미리보기 기본(dryRun) 유지'); n++;
  assert.strictEqual(calls[1][1].confirm, false, 'confirm 기본 false 유지'); n++;

  console.log(`✅ captureLinkRoutesRequire: ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error('❌', e && e.stack || e); process.exit(1); });
