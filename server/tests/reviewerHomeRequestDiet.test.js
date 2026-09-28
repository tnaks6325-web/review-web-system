'use strict';
// 리뷰어 홈 헛요청 줄이기 + 실제 사용자 주소로 요청 제한 (decision 189).
// 실제로 실행해서 확인한다: 서비스워커·미확인 수 합치기·공고수정 권한 기억·리뷰내역 조회 방식 기억·
// 실시간 알림 재연결 간격·CORS 허용 헤더·X-Real-IP.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const FE = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
let passed = 0; const t = async (n, f) => { await f(); passed++; console.log('PASS ' + n); };

function storage() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; }
function extractFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' 없음');
  const start = src.lastIndexOf('\n', i) + 1;
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(start, j + 1);
}

(async () => {
  // ── 1. 서비스워커: 다른 주소·실시간 알림은 건드리지 않는다 ──
  await t('서비스워커는 API 서버 요청과 실시간 알림을 가로채지 않는다', async () => {
    const listeners = {};
    const self = { location: { origin: 'https://review-web-system.pages.dev' }, addEventListener: (e, f) => { listeners[e] = f; },
      skipWaiting: () => {}, clients: { claim: () => {} } };
    vm.runInNewContext(FE('sw.js'), { self, caches: { open: async () => ({}), keys: async () => [], match: async () => null }, fetch: async () => ({}), URL, Promise });
    const run = (url, { mode = 'cors', accept = '' } = {}) => {
      let responded = false;
      listeners.fetch({ request: { method: 'GET', url, mode, headers: { get: k => (k === 'accept' ? accept : null) } }, respondWith: () => { responded = true; } });
      return responded;
    };
    assert.equal(run('https://sublime-magic-production-790b.up.railway.app/api/reviewer/cs/events?phone8=1', { accept: 'text/event-stream' }), false);
    assert.equal(run('https://sublime-magic-production-790b.up.railway.app/api/campaign/list'), false);
    assert.equal(run('https://review-web-system.pages.dev/x', { accept: 'text/event-stream' }), false);
    assert.equal(run('https://review-web-system.pages.dev/', { mode: 'navigate' }), true, '페이지 이동의 오프라인 안전망은 유지');
    assert.equal(run('https://review-web-system.pages.dev/icons/a.png'), true, '아이콘 캐시는 유지');
  });

  // ── 2. CORS: 실시간 알림 재요청 헤더 허용 ──
  await t('CORS 사전 확인이 Cache-Control·Last-Event-ID 를 허용한다', async () => {
    const express = require('express'); const cors = require('cors');
    const { corsOptions } = require('../src/middleware/cors.middleware');
    const app = express(); app.use(cors(corsOptions)); app.get('/x', (q, r) => r.end('ok'));
    const s = app.listen(0); await new Promise(r => s.once('listening', r));
    const res = await new Promise((resolve, reject) => {
      const rq = http.request({ port: s.address().port, path: '/x', method: 'OPTIONS', headers: {
        Origin: 'https://main.review-web-system.pages.dev', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control,last-event-id' } }, resolve);
      rq.on('error', reject); rq.end();
    });
    s.close();
    const allow = String(res.headers['access-control-allow-headers'] || '').toLowerCase();
    assert.ok(allow.includes('cache-control') && allow.includes('last-event-id'), allow);
  });

  // ── 3. 실시간 알림 재연결 간격 ──
  await t('리뷰어 실시간 알림은 끊기면 30초 뒤 재연결(관리자는 3초 그대로)', async () => {
    const { addClient } = require('../src/utils/sse');
    const mk = () => { const out = []; return { out, writeHead() {}, write: s => out.push(s), end() {} }; };
    const req = { ip: '1.1.1.1', on() {} };
    const r1 = mk(); addClient(req, r1, { role: 'reviewer', phone8: '12345678' });
    const r2 = mk(); addClient(req, r2, { role: 'admin' });
    assert.equal(r1.out[0], 'retry: 30000\n');
    assert.equal(r2.out[0], 'retry: 3000\n');
    assert.match(r1.out[1], /^data: /, '연결 메시지는 그대로 뒤따른다');
  });

  // ── 4. 실제 사용자 주소 ──
  await t('요청 제한은 X-Real-IP(실제 사용자 주소)로 센다 · 형식 오류·스위치 끔은 종전 주소', async () => {
    const { clientIp } = require('../src/middleware/rateLimit.middleware');
    assert.equal(clientIp({ headers: { 'x-real-ip': '118.235.66.87' }, ip: '152.233.15.120' }), '118.235.66.87');
    assert.equal(clientIp({ headers: { 'x-real-ip': '2001:db8::1' }, ip: 'p' }), '2001:db8::1');
    assert.equal(clientIp({ headers: { 'x-real-ip': '<script>' }, ip: '152.233.15.120' }), '152.233.15.120');
    assert.equal(clientIp({ headers: {}, ip: '152.233.15.120' }), '152.233.15.120');
    process.env.RL_TRUST_X_REAL_IP = '0';
    assert.equal(clientIp({ headers: { 'x-real-ip': '1.2.3.4' }, ip: 'p' }), 'p');
    delete process.env.RL_TRUST_X_REAL_IP;
    const src = fs.readFileSync(path.join(__dirname, '../src/middleware/rateLimit.middleware.js'), 'utf8');
    const limiters = src.match(/= rateLimit\(\{/g).length;
    const keyed = (src.match(/keyGenerator: \(req\) => [^\n]*clientIp\(req\)|keyGenerator: \(req\) => rateIdentity/g) || []).length;
    assert.equal(keyed, limiters, '모든 제한기가 실제 사용자 주소(또는 사람별 신원)로 센다');
    assert.ok(!/\$\{req\.ip\}/.test(src), '프록시 주소를 키로 쓰지 않는다');
  });

  // ── 5. 1:1문의 미확인 수: 동시 호출 합치기, 강제는 통과 ──
  await t('미확인 수 조회는 홈 진입 시 한 번만 · 새 메시지·열람·주기 갱신은 즉시', async () => {
    const src = FE('js/reviewer-cs.js');
    let calls = 0;
    const ctx = { window: { getSavedUser: () => ({ name: 'a', phone8: '12345678' }) }, document: { readyState: 'loading', addEventListener() {}, getElementById: () => null },
      sessionStorage: storage(), localStorage: storage(), gasGet: async () => { calls++; return { ok: true, totalUnread: 1 }; }, setInterval() {}, console, Date };
    vm.runInNewContext(src, ctx);
    const rc = ctx.window.ReviewerCS;
    await Promise.all([rc.refreshUnread(), rc.refreshUnread()]);
    assert.equal(calls, 1, '거의 동시 두 번 = 요청 1번');
    await rc.refreshUnread();
    assert.equal(calls, 1, '2초 안 재호출은 합친다');
    await rc.refreshUnread(true);
    assert.equal(calls, 2, '강제 갱신은 바로 나간다');
    assert.match(src, /refreshUnread\(true\);[\s\S]{0,40}\n[\s\S]*addEventListener\("cs_message"[\s\S]*refreshUnread\(true\)/, '새 메시지 도착은 강제');
    assert.match(src, /setInterval\(\(\) => refreshUnread\(true\), 20000\)/);
  });

  // ── 6. 공고수정 권한: 거절은 10분 기억, 새 로그인은 다시 확인 ──
  await t('공고수정 권한 거절(401)은 같은 탭에서 10분 다시 묻지 않고, 새 로그인은 기억을 지운다', async () => {
    const html = FE('index.html');
    let fetches = 0; const ss = storage();
    const ctx = { sessionStorage: ss, document: { getElementById: () => null }, API_BASE_URL: 'x', JSON, Date, String, Number,
      refreshAdminModeBanner() {}, fetch: async () => { fetches++; return { ok: false, status: 401 }; } };
    vm.runInNewContext(extractFn(html, '_campEditDenyKey') + '\n' + extractFn(html, 'maybeFetchCampEditToken') + '\nthis.f=maybeFetchCampEditToken;', ctx);
    const u = { name: '가', phone8: '12345678' };
    await ctx.f(u); await ctx.f(u);
    assert.equal(fetches, 1, '두 번째는 요청 없음');
    await ctx.f({ name: '나', phone8: '87654321' });
    assert.equal(fetches, 2, '다른 계정은 다시 확인');
    ctx.fetch = async () => { fetches++; return { ok: false, status: 500 }; };
    ss.removeItem('rapp_camp_edit_deny');
    await ctx.f(u); await ctx.f(u);
    assert.equal(fetches, 4, '서버 오류는 기억하지 않는다(다음에 다시 확인)');
    assert.match(extractFn(html, 'doLogin'), /sessionStorage\.removeItem\(_campEditDenyKey\(\)\)/);
    assert.ok(!/const CAMP_EDIT_DENY_KEY/.test(html), '선언 전 접근 오류가 나는 const 를 쓰지 않는다');
  });

  // ── 7. 리뷰내역: 옛 조회 상태를 10분 기억해 확인 요청을 생략 ──
  await t('리뷰내역은 옛 조회 상태면 다음부터 확인 없이 바로 옛 조회 한 번', async () => {
    const html = FE('index.html');
    const ss = storage(); let pages = 0, searches = 0, mode = 'legacy';
    const ctx = { sessionStorage: ss, JSON, Date, String, Number, API_BASE_URL: 'x',
      ReviewerHistoryLoader: { fetchPage: async (b, tk, st) => { pages++; return mode === 'owner_id' ? { mode, results: [], counts: {}, scopeVersion: 'v', nextCursor: null } : { ok: true, mode: 'legacy' }; } },
      gasGet: async () => { searches++; return { results: [] }; } };
    vm.runInNewContext(['_historyLegacyKey', '_historyLegacyRemembered', '_rememberHistoryLegacy', '_fetchReviewHistory'].map(n => extractFn(html, n)).join('\n') + '\nthis.f=_fetchReviewHistory;', ctx);
    const u = { reviewerToken: 't', phone8: '12345678', name: '가' };
    await ctx.f(u); assert.deepStrictEqual([pages, searches], [1, 1]);
    await ctx.f(u); assert.deepStrictEqual([pages, searches], [1, 2], '두 번째는 확인 생략');
    await ctx.f({ ...u, phone8: '99998888' }); assert.deepStrictEqual([pages, searches], [2, 3], '다른 계정은 다시 확인');
    ss.removeItem('rapp_history_legacy'); mode = 'owner_id';
    const r = await ctx.f(u); assert.equal(r.mode, 'owner_id'); assert.equal(ss.getItem('rapp_history_legacy'), null, '새 조회는 기억하지 않는다');
  });

  console.log(`${passed} reviewer-home request diet tests passed`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
