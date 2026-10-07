/**
 * clientErrorReport.test.js — 화면 오류 보고(`POST /api/diag/client-error`)는 로그인한 사람의 것만 받는다 (결정 208).
 *
 * ★ 사고(2026-05-13 ~ 2026-10-07): 무인증 쓰기를 막으려 서버에 authMiddleware 를 붙였지만 화면(api.js)이
 *   토큰 없이 보내 **5개월간 전부 401** — 화면 오류가 한 건도 기록되지 않았다(10/7 하루 48건 버려짐).
 *
 * 실행: node tests/clientErrorReport.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Module = require('module');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-client-error';
const SECRET = process.env.JWT_SECRET;
let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

// diag.routes 는 무거운 의존성이 많다 — 오류 기록부만 가로채 실제 라우트 코드를 그대로 태운다
const logged = [];
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (/errorLog\.service$/.test(req)) return { logAbnormal: (e) => logged.push(e) };
  // ★ 실제 DB 에 닿지 않게(Codex P2) — diag.routes 는 불러올 때 스키마 보정 쿼리를 날린다
  if (/db\/pool$/.test(req)) return { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }), on() {} };
  return origLoad.apply(this, arguments);
};
const diag = require('../src/routes/diag.routes');
Module._load = origLoad;
const { issueReviewerSession } = require('../src/services/reviewerSession.service');
const roi = require('../src/services/reviewerOrderIdentity.service');

(async () => {
  const app = express(); app.use(express.json()); app.use('/api/diag', diag);
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const post = (headers, payload) => new Promise((resolve) => {
    const body = JSON.stringify(payload || { message: 'TypeError: x', page: '/workdesk', source: 'a.js', lineno: 1 });
    const q = http.request({ port, path: '/api/diag/client-error', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.end(body);
  });
  try {
    const bearer = (p, o) => ({ Authorization: 'Bearer ' + jwt.sign(p, SECRET, o) });
    ok('직원(admin) 로그인 → 받음', (await post(bearer({ name: 'u', role: 'admin' }))) === 200);
    ok('3버전 인트라넷 직원 → 받음(경로 제한은 기록 입구에 적용 안 함)', (await post(bearer({ name: 'u', role: 'staff', via: 'intranet' }))) === 200);
    ok('광고주 로그인 → 받음', (await post(bearer({ name: 'a', role: 'advertiser', advertiser_id: 1 }))) === 200);
    let rt = issueReviewerSession({ ownerReviewerId: '00000000-0000-0000-0000-000000000001', loginName: '홍길동', loginPhone8: '12345678' });
    if (rt && typeof rt === 'object') rt = rt.token || rt.reviewerToken;
    ok('리뷰어 세션(X-Reviewer-Token) → 받음', (await post({ 'X-Reviewer-Token': rt })) === 200);
    ok('토큰 없음 → 401(익명 기록 금지)', (await post({})) === 401);
    ok('가짜 서명 → 401', (await post({ Authorization: 'Bearer ' + jwt.sign({ role: 'admin' }, 'wrong') })) === 401);
    const extract = roi.issueExtractionProof({ imageHash: 'h', extracted: {}, ok: true }).extractToken;
    ok('무인증으로 받는 추출 증명 → 401(결정 201 기준과 같다)', (await post({ Authorization: 'Bearer ' + extract })) === 401);
    ok('기록에 보낸 사람 종류가 남는다', logged.length === 4 && logged.every(e => e.context && e.context.reporter && e.context.reporter.kind));
    // Codex P2 ① 공고수정 토큰(role admin · via reviewer_campaign)은 직원으로 치지 않는다 → 리뷰어 세션으로 기록
    logged.length = 0;
    const camp = 'Bearer ' + jwt.sign({ name: 'r', role: 'admin', via: 'reviewer_campaign', phone8: '1' }, SECRET);
    ok('공고수정 토큰 단독 → 401', (await post({ Authorization: camp })) === 401);
    ok('공고수정 토큰 + 리뷰어 세션 → 리뷰어로 기록', (await post({ Authorization: camp, 'X-Reviewer-Token': rt })) === 200 && logged[0].context.reporter.kind === 'reviewer');
    // Codex P2 ② 칸 길이 상한
    logged.length = 0;
    await post(bearer({ name: 'cap', role: 'admin' }), { message: 'm'.repeat(5000), stack: 's'.repeat(9000), page: { x: 1 }, lineno: 'abc' });
    const e = logged[0];
    ok('긴 글자는 잘라서 저장(메시지 500·스택 2000)', e && e.error.message.length === 500 && e.error.stack.length === 2000 && e.context.lineno === null);
    // Codex P2 ③ 보내는 사람별 분당 상한(20)
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push(await post(bearer({ name: 'flood', role: 'staff' })));
    ok('한 사람이 분당 20건을 넘기면 429', codes.filter(c => c === 200).length === 20 && codes.slice(20).every(c => c === 429));
    // 같은 이름의 브랜드 링크 두 곳은 서로의 상한을 나눠 쓰지 않는다(서명된 brand_id 로 구분 — Codex P2)
    const b1 = bearer({ name: '같은이름', role: 'advertiser', advertiser_id: 7, brand_id: 101, via: 'brand-link' });
    const b2 = bearer({ name: '같은이름', role: 'advertiser', advertiser_id: 8, brand_id: 202, via: 'brand-link' });
    for (let i = 0; i < 20; i++) await post(b1);
    ok('브랜드 A 가 상한을 다 써도 같은 이름 브랜드 B 는 받는다', (await post(b1)) === 429 && (await post(b2)) === 200);
  } finally { server.close(); }

  const api = fs.readFileSync(path.join(__dirname, '../../frontend/api.js'), 'utf8');
  const sender = api.slice(api.indexOf("'/api/diag/client-error'") - 1200, api.indexOf("'/api/diag/client-error'") + 300);
  ok('화면은 로그인 정보를 붙여 보낸다(_getAuthHeaders)', /_getAuthHeaders\(\)/.test(sender) && /\.\.\.authHeaders/.test(sender));
  ok('공고 미리보기 탭은 전용 관리자 토큰만 붙인다(리뷰어 세션 미부착)', /sessionStorage\.getItem\('camp_preview_tok'\)[\s\S]{0,120}authHeaders = \{ Authorization: 'Bearer ' \+ pvTok \}/.test(sender));
  console.log(`\n✅ clientErrorReport: ${n}개 통과`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
