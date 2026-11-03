'use strict';
/* 정상 차단(CORS: 허용 안 된 주소에서 온 요청)이 "서버 오류(500·error)" 로 기록되지 않게 (결정 326)
 *
 * 2026-11-03 운영 실측: 인트라넷 개발자 PC(localhost·127.0.0.1)에서 운영 API 로그인을 부른 요청이
 * CORS 로 막혔는데(응답은 이미 403), 이상로그에는 statusCode 500 · severity 'error' 로
 * "관리자 작업에서 접근 권한 오류" 347회가 쌓여 진짜 서버 오류처럼 보였다.
 *
 * 고정:
 *   ① 응답은 403 그대로 · 기록 context.statusCode = 403
 *   ② 개발자 PC·브라우저 확장 주소 → 이상로그에 남기지 않는다(소음)
 *   ③ 그 밖의 허용 안 된 주소(테스트 서버 등) → 'warn' 으로만 남긴다(정상 차단)
 *   ④ ★ 운영 화면 주소가 막히면(허용 설정 누락) → 'critical' 로 남긴다 — 진짜 이상 신호는 지우지 않는다
 *   ⑤ 운영 화면 주소(review-web-system.pages.dev 하위)는 종전대로 통과
 *   ⑥ CORS 가 아닌 진짜 500 은 종전대로 'error'
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'production';
delete process.env.ALLOWED_ORIGINS;
delete process.env.TEST_AUTO_LOGIN;
delete process.env.ERRORLOG_ENABLED;
delete process.env.ERRORLOG_AI_ENRICH;

const sentry = require('../src/utils/sentry');
const caps = [];
sentry.captureException = (e) => { caps.push(String(e && e.message)); };
const pool = require('../src/db/pool');
const inserts = [];
pool.query = async (sql, params) => {
  if (/INSERT INTO error_logs/.test(String(sql))) inserts.push({ severity: params[0], step: params[3], category: params[5], context: JSON.parse(params[11]), raw: params[8] });
  return { rows: [{ id: 1, occurrence_count: 1 }] };
};
const app = require('../src/app');
const { errorHandler } = require('../src/middleware/error.middleware');
const tick = () => new Promise((r) => setTimeout(r, 30));

function req(port, origin, method = 'POST', p = '/api/admin/intranet-login') {
  return new Promise((resolve, reject) => {
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    if (method === 'OPTIONS') Object.assign(headers, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' });
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end(method === 'POST' ? '{}' : undefined);
  });
}

const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  let n = 0;
  try {
    // ② 개발자 PC 주소 — 403, 기록 없음
    for (const o of ['http://127.0.0.1:3961', 'http://localhost:3220', 'chrome-extension://knohfebhibeknbfioecpdmdkjkjdnjnl']) {
      inserts.length = 0;
      const r = await req(port, o);
      await tick();
      assert.strictEqual(r.status, 403, o + ' 는 403');
      assert.strictEqual(inserts.length, 0, o + ' 는 이상로그에 남기지 않는다 — ' + JSON.stringify(inserts));
    }
    // 사전 확인(OPTIONS)도 같다
    inserts.length = 0;
    assert.strictEqual((await req(port, 'http://localhost:3220', 'OPTIONS')).status, 403);
    await tick();
    assert.strictEqual(inserts.length, 0);
    n++; console.log('PASS 개발자 PC·확장 주소 차단 = 403 · 기록 없음');

    // ③ 테스트 서버 등 — 403, warn · statusCode 403
    inserts.length = 0; caps.length = 0;
    const t = await req(port, 'https://testserver-inad.pages.dev');
    await tick();
    assert.strictEqual(t.status, 403);
    assert.strictEqual(inserts.length, 1, '기록은 남는다');
    assert.strictEqual(inserts[0].severity, 'warn', '정상 차단은 경고');
    assert.strictEqual(inserts[0].context.statusCode, 403, '기록된 응답코드 = 실제 403 (500 아님)');
    assert.strictEqual(inserts[0].category, 'permission');
    assert.strictEqual(inserts[0].step, 'cors_blocked');
    assert.strictEqual(caps.length, 0, '정상 차단은 Sentry 로 보내지 않는다(간접 전송 포함) — ' + JSON.stringify(caps));
    n++; console.log('PASS 허용 안 된 외부 주소 = 403 · 경고(warn) · statusCode 403');

    // ④ 운영 화면 주소가 막힘(ALLOWED_ORIGINS 누락) — critical 로 보인다
    inserts.length = 0; caps.length = 0;
    const p = await req(port, 'https://review-web-system.pages.dev');
    await tick();
    assert.strictEqual(p.status, 403);
    assert.strictEqual(inserts.length, 1);
    assert(caps.length >= 1, '운영 주소 차단은 Sentry 로 보낸다');
    assert.strictEqual(inserts[0].severity, 'critical', '운영 화면이 막히는 건 치명으로 보인다');
    assert.strictEqual(inserts[0].step, 'cors_own_origin_blocked');
    n++; console.log('PASS 운영 화면 주소 차단(설정 누락) = 치명(critical)');

    // ⑤ 운영 배포 하위 주소는 종전대로 통과
    inserts.length = 0;
    const ok = await req(port, 'https://main.review-web-system.pages.dev', 'OPTIONS');
    await tick();
    assert.strictEqual(ok.status, 204);
    assert.strictEqual(ok.headers['access-control-allow-origin'], 'https://main.review-web-system.pages.dev');
    assert.strictEqual(inserts.length, 0);
    n++; console.log('PASS 운영 화면 주소 통과(무영향)');

    // ⑥ CORS 가 아닌 진짜 서버 오류는 종전대로 error · 500
    inserts.length = 0;
    errorHandler(new Error('column reference "phone8" is ambiguous'), { path: '/api/reviewer/profile', method: 'GET', query: {}, ip: '1.1.1.1', headers: {} },
      { status() { return this; }, json() { return this; } }, () => {});
    await tick();
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].severity, 'error');
    assert.strictEqual(inserts[0].context.statusCode, 500);
    n++; console.log('PASS 진짜 서버 오류는 종전대로 error/500');

    console.log(`✅ corsBlockedErrorLog: ${n} cases passed`);
    server.close(); process.exit(0);
  } catch (e) {
    console.error('❌', e); server.close(); process.exit(1);
  }
});
