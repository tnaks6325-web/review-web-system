/**
 * authLoginTokenKind.test.js — 관리자 라우트는 **로그인 세션 토큰만** 받는다 (결정 201 · 완화 금지).
 *
 * ★★★ 사고(2026-10-04 발견): authMiddleware 가 `jwt.verify` 서명만 봤다. 같은 JWT_SECRET 으로
 *   - 무인증 `POST /api/image/extract` 가 누구에게나 주는 추출 증명(aud reviewer-order-identity)
 *   - 무비밀번호 리뷰어 세션(aud reviewer-app · scope reviewer_session)
 *   - 관리자→리뷰어 홈 교환권(scope reviewer_home_admin)
 *   이 서명되므로, 로그인 없이 받은 토큰으로 `GET /api/reviewer/list`·`POST /api/reviewer/delete` 등
 *   authMiddleware 만 건 관리자 라우트 약 130곳에 닿았고, 전역·업로드 속도 제한도 면제됐다.
 *
 * 실행: node tests/authLoginTokenKind.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-auth-login-token-kind';
const SECRET = process.env.JWT_SECRET;
const { authMiddleware, isLoginSessionToken, isTrustedLoginToken } = require('../src/middleware/auth.middleware');

let n = 0;
const ok = (name, cond) => { assert(cond, name); n++; console.log('  ✓ ' + name); };

function run(token, { baseUrl = '/api/reviewer', p = '/list', method = 'GET' } = {}) {
  const req = { headers: token ? { authorization: 'Bearer ' + token } : {}, query: {}, baseUrl, path: p, method };
  let status = 200; let passed = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  authMiddleware(req, res, () => { passed = true; });
  return { status, passed, admin: req.admin };
}

/* ═══ 실제 발급 함수로 만든 비로그인 토큰 — 전부 거부 ═══ */
const roi = require('../src/services/reviewerOrderIdentity.service');
const extract = roi.issueExtractionProof({ imageHash: 'h', extracted: {}, ok: true }).extractToken;
ok('무인증 추출 증명 토큰은 관리자 라우트 거부(401)', run(extract).status === 401 && !run(extract).passed);

const rs = require('../src/services/reviewerSession.service');
const signReviewer = rs.signReviewerSession || rs.issueReviewerSession || rs.sign;
if (typeof signReviewer === 'function') {
  let rtok = signReviewer({ ownerReviewerId: '00000000-0000-0000-0000-000000000001', loginName: '홍길동', loginPhone8: '12345678', loginKind: 'owner' });
  if (rtok && typeof rtok === 'object') rtok = rtok.token || rtok.reviewerToken;
  ok('리뷰어 세션 토큰은 관리자 라우트 거부(401)', typeof rtok === 'string' && run(rtok).status === 401);
}
const ticket = jwt.sign({ scope: 'reviewer_home_admin', name: '홍길동', phone8: '12345678' }, SECRET, { issuer: 'review-web-system', expiresIn: '5m' });
ok('리뷰어 홈 교환권은 관리자 라우트 거부(401)', run(ticket).status === 401);
ok('role 없는 서명 토큰 거부', run(jwt.sign({ name: 'x' }, SECRET)).status === 401);
ok('알 수 없는 role 거부', run(jwt.sign({ name: 'x', role: 'reviewer' }, SECRET)).status === 401);
ok('로그인 role 이라도 aud 가 붙으면 거부', run(jwt.sign({ name: 'x', role: 'admin' }, SECRET, { audience: 'reviewer-app' })).status === 401);
ok('로그인 role 이라도 scope/purpose 가 붙으면 거부',
  run(jwt.sign({ name: 'x', role: 'admin', scope: 'reviewer_session' }, SECRET)).status === 401
  && run(jwt.sign({ name: 'x', role: 'admin', purpose: 'extract' }, SECRET)).status === 401);

/* ═══ 로그인 토큰 — 지금처럼 통과(막다른 길 없음) ═══ */
for (const role of ['master', 'admin', 'staff']) {
  const r = run(jwt.sign({ name: 'u', role }, SECRET, { expiresIn: '8h' }));
  ok(`${role} 로그인 토큰 통과`, r.passed && r.admin && r.admin.role === role);
}
// ★★ 광고주(계정·업체 링크·브랜드 링크)는 업체 화면 서버 기능(/api/trackb/*)만 — 결정 205 · 완화 금지
{
  const adv = jwt.sign({ name: 'u', role: 'advertiser', advertiser_id: 1 }, SECRET, { expiresIn: '8h' });
  ok('advertiser 로그인 토큰은 업체 화면(trackb) 통과', run(adv, { baseUrl: '/api/trackb', p: '/workdesk/tabs' }).passed);
  ok('advertiser 토큰은 직원용 라우트에서 403(리뷰어 명단·삭제 등)',
    run(adv).status === 403 && run(adv, { baseUrl: '/api/reviewer', p: '/delete', method: 'POST' }).status === 403
    && run(adv, { baseUrl: '/api/diag', p: '/reverse-sync-list' }).status === 403
    && run(adv, { baseUrl: '/api/trackbx', p: '/y' }).status === 403);
}
ok('광고주 링크 토큰(via link) 통과', run(jwt.sign({ name: 'u', role: 'advertiser', advertiser_id: 1, via: 'link' }, SECRET), { baseUrl: '/api/trackb', p: '/x' }).passed);
ok('광고주 링크 토큰도 trackb 밖은 403', run(jwt.sign({ name: 'u', role: 'advertiser', advertiser_id: 1, via: 'link' }, SECRET)).status === 403
  && run(jwt.sign({ name: 'u', role: 'advertiser', advertiser_id: 1, brand_id: 2, via: 'brand-link' }, SECRET), { baseUrl: '/api/tab', p: '/dashboard' }).status === 403);
ok('브랜드 링크 토큰(via brand-link) 통과', run(jwt.sign({ name: 'u', role: 'advertiser', advertiser_id: 1, brand_id: 2, via: 'brand-link' }, SECRET), { baseUrl: '/api/trackb', p: '/x' }).passed);
ok('인트라넷 토큰은 trackb 통과 · 그 밖 403 유지',
  run(jwt.sign({ name: 'u', role: 'admin', via: 'intranet' }, SECRET), { baseUrl: '/api/trackb', p: '/x' }).passed
  && run(jwt.sign({ name: 'u', role: 'admin', via: 'intranet' }, SECRET)).status === 403);
ok('공고수정 토큰은 허용 경로만(기존 격리 유지)',
  run(jwt.sign({ name: 'u', role: 'admin', via: 'reviewer_campaign', phone8: '1' }, SECRET), { baseUrl: '/api/campaign', p: '/admin/abc', method: 'PUT' }).passed
  && run(jwt.sign({ name: 'u', role: 'admin', via: 'reviewer_campaign', phone8: '1' }, SECRET)).status === 403);
ok('토큰 없음 401 유지', run(null).status === 401);
ok('isLoginSessionToken: null·문자열 거부', !isLoginSessionToken(null) && !isLoginSessionToken('admin'));

/* ═══ 속도 제한 면제·안내이미지 업로드도 같은 판정을 태운다(사본 금지) ═══ */
const rl = fs.readFileSync(path.join(__dirname, '../src/middleware/rateLimit.middleware.js'), 'utf8');
ok('속도 제한 면제: 서명만 보고 true 를 돌려주는 곳 0', !/jwt\.verify\([^;]*\);\s*return true/.test(rl) && !/jwt\.verify\(token, process\.env\.JWT_SECRET\);\s*\n\s*return true/.test(rl));
ok('속도 제한 면제 2곳 모두 isTrustedLoginToken', (rl.match(/return isTrustedLoginToken\(jwt\.verify\(token/g) || []).length === 2);
ok('전역 제한의 직원 통도 isTrustedLoginToken', /if \(bearerPayload && isTrustedLoginToken\(bearerPayload\)\)/.test(rl));
const order = fs.readFileSync(path.join(__dirname, '../src/routes/order.routes.js'), 'utf8');
const guide = order.slice(order.indexOf('function _guideImageAuthed'), order.indexOf('function _publicApiBase'));
ok('안내이미지 업로드 인증도 isTrustedLoginToken', /return isTrustedLoginToken\(jwt\.verify\(tok/.test(guide) && !/return true; \}/.test(guide.replace(/intakeKey === process\.env\.ORDER_INTAKE_KEY\) return true;/, '')));

/* ═══ authMiddleware 밖 직접 판정: 공고수정 토큰(무비밀번호)은 로그인으로 치지 않는다(Codex P1) ═══ */
const campTok = jwt.verify(jwt.sign({ name: 'u', role: 'admin', via: 'reviewer_campaign', phone8: '1' }, SECRET), SECRET);
ok('공고수정 토큰: authMiddleware 판정은 통과(경로 제한은 미들웨어가) · 직접 판정은 거부',
  isLoginSessionToken(campTok) && !isTrustedLoginToken(campTok));
ok('직원·광고주·인트라넷 로그인은 직접 판정 통과',
  ['master', 'admin', 'staff', 'advertiser'].every(role => isTrustedLoginToken(jwt.verify(jwt.sign({ name: 'u', role }, SECRET), SECRET)))
  && isTrustedLoginToken(jwt.verify(jwt.sign({ name: 'u', role: 'admin', via: 'intranet' }, SECRET), SECRET)));
ok('추출 증명은 직접 판정 거부', !isTrustedLoginToken(jwt.verify(extract, SECRET, { audience: 'reviewer-order-identity', issuer: 'review-web-system' })));

/* ═══ 실제 속도 제한 skip 동작 ═══ */
{
  const mod = require('../src/middleware/rateLimit.middleware');
  const limiters = Object.values(mod).filter(v => typeof v === 'function');
  ok('속도 제한 모듈 로드(순환 require 없음)', limiters.length > 0);
  const idOf = (tok) => mod.rateIdentity({ headers: { authorization: 'Bearer ' + tok, 'x-real-ip': '1.2.3.4' }, query: {}, body: {}, ip: '1.2.3.4' });
  ok('전역 제한: 관리자 로그인은 직원 통(검증됨)', idOf(jwt.sign({ name: 'u', role: 'admin' }, SECRET)).kind === 'staff');
  ok('전역 제한: 추출 증명은 직원 통이 아니고 주소 상한도 받는다', idOf(extract).kind !== 'staff' && idOf(extract).verified === false);
  ok('전역 제한: 리뷰어 홈 교환권·공고수정 토큰도 직원 통 아님',
    idOf(ticket).kind !== 'staff' && idOf(jwt.sign({ name: 'u', role: 'admin', via: 'reviewer_campaign', phone8: '1' }, SECRET)).kind !== 'staff');
}

console.log(`\n✅ authLoginTokenKind: ${n}개 통과`);
