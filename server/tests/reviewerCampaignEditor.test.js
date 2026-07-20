/**
 * reviewerCampaignEditor.test.js — 리뷰어 앱 공고수정 권한(마스터 허용명단) 회귀가드
 *  ① authMiddleware의 via:'reviewer_campaign' 스코프 격리(공고 PUT 전용) — 실 JWT
 *  ② issueCampaignToken 이중 게이트(리뷰어 신원 + active 명단) + 최소권한 토큰 클레임 — DB/verify 스텁
 *  ③ 배선(라우트·프론트) grep
 * 실행: node tests/reviewerCampaignEditor.test.js
 */
const assert = require('assert');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = 'test-secret-reviewer-camp';
let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

// ── 공용: authMiddleware 실행 헬퍼 ──
const { authMiddleware } = require('../src/middleware/auth.middleware');
function runAuth(token, method, baseUrl, p) {
  const req = { headers: { authorization: 'Bearer ' + token }, method, baseUrl, path: p, query: {} };
  let status = 200, body = null, nexted = false;
  const res = { status(c) { status = c; return this; }, json(o) { body = o; return this; } };
  authMiddleware(req, res, () => { nexted = true; });
  return { nexted, status, body };
}
const sign = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '2h' });

// ── ① 스코프 격리 ──
const campTok = sign({ name: '김수만', role: 'admin', via: 'reviewer_campaign' });

ok('허용: PUT /api/campaign/admin/:id (공고 수정)',
  runAuth(campTok, 'PUT', '/api/campaign', '/admin/abc123').nexted === true);
ok('허용: PUT /api/campaign/admin/:id/status (상태 변경)',
  runAuth(campTok, 'PUT', '/api/campaign', '/admin/abc123/status').nexted === true);

ok('차단: POST /api/campaign/admin/create (공고 생성)',
  runAuth(campTok, 'POST', '/api/campaign', '/admin/create').status === 403);
ok('차단: DELETE /api/campaign/admin/:id (공고 삭제)',
  runAuth(campTok, 'DELETE', '/api/campaign', '/admin/abc123').status === 403);
ok('차단: POST /admin/:id/confirm (수동확정 — 주문링크 조작 방지)',
  runAuth(campTok, 'POST', '/api/campaign', '/admin/abc123/confirm').status === 403);
ok('차단: GET /admin/:id/applications (신청자 명단)',
  runAuth(campTok, 'GET', '/api/campaign', '/admin/abc123/applications').status === 403);
ok('차단: POST /api/admin/campaign-editors (허용명단 자기증식 불가)',
  runAuth(campTok, 'POST', '/api/admin', '/campaign-editors').status === 403);
ok('차단: 타 관리자 API 전반(/api/admin/db-rebuild)',
  runAuth(campTok, 'POST', '/api/admin', '/db-rebuild').status === 403);
ok('차단: Track B(/api/trackb/*)',
  runAuth(campTok, 'GET', '/api/trackb', '/overview').status === 403);
ok('차단: 주문 원장(/api/order/*)',
  runAuth(campTok, 'POST', '/api/order', '/submit').status === 403);

// 회귀: 일반 관리자 토큰(via 없음)은 어디든 통과(무영향)
const adminTok = sign({ name: 'master', role: 'master' });
ok('회귀: 일반 관리자 토큰은 공고 생성/삭제 통과(무영향)',
  runAuth(adminTok, 'POST', '/api/campaign', '/admin/create').nexted === true &&
  runAuth(adminTok, 'DELETE', '/api/campaign', '/admin/abc').nexted === true);
ok('회귀: 인트라넷 토큰은 여전히 Track B 전용',
  runAuth(sign({ name: 'x', role: 'staff', via: 'intranet' }), 'PUT', '/api/campaign', '/admin/abc').status === 403 &&
  runAuth(sign({ name: 'x', role: 'staff', via: 'intranet' }), 'GET', '/api/trackb', '/overview').nexted === true);
ok('만료 토큰 거부(핵심 계약)', (() => {
  const exp = jwt.sign({ name: 'x', role: 'admin', via: 'reviewer_campaign' }, process.env.JWT_SECRET, { expiresIn: -10 });
  return runAuth(exp, 'PUT', '/api/campaign', '/admin/abc').status === 401;
})());

// ── ② 토큰 발급 이중 게이트 (pool·verifyReviewer 스텁) ──
let _verifyResult = { ok: true, name: '김수만' };
let _isEditorRows = [{ x: 1 }];
require.cache[require.resolve('../src/db/pool')] = {
  id: require.resolve('../src/db/pool'), exports: {
    query: async (q) => /reviewer_campaign_editors/.test(q) ? { rows: _isEditorRows } : { rows: [] },
  },
};
require.cache[require.resolve('../src/services/reviewer.service')] = {
  id: require.resolve('../src/services/reviewer.service'), exports: { verifyReviewer: async () => _verifyResult },
};
delete require.cache[require.resolve('../src/services/reviewerCampaignEditor.service')];
const svc = require('../src/services/reviewerCampaignEditor.service');

ok('_norm8: 하이픈·11자리 → 뒤 8자리', svc._norm8('010-8592-6325') === '85926325' && svc._norm8('85926325') === '85926325');

(async () => {
  _verifyResult = { ok: true, name: '김수만' }; _isEditorRows = [{ x: 1 }];
  const good = await svc.issueCampaignToken('김수만', '01085926325');
  ok('발급: 신원확인+명단 통과 시 토큰 발급', good.ok === true && !!good.token);
  const dec = jwt.verify(good.token, process.env.JWT_SECRET);
  ok('발급 토큰 클레임: role=admin(최소권한 하향) · via=reviewer_campaign', dec.role === 'admin' && dec.via === 'reviewer_campaign');
  ok('발급 토큰은 방금 만든 스코프 격리를 그대로 통과(공고 PUT만)',
    runAuth(good.token, 'PUT', '/api/campaign', '/admin/x').nexted === true &&
    runAuth(good.token, 'DELETE', '/api/campaign', '/admin/x').status === 403);

  _verifyResult = { ok: false }; _isEditorRows = [{ x: 1 }];
  const badId = await svc.issueCampaignToken('사칭', '85926325');
  ok('거부: 리뷰어 신원 불일치(명단에 있어도 미발급)', badId.ok === false && !badId.token);

  _verifyResult = { ok: true, name: '김수만' }; _isEditorRows = [];
  const notEd = await svc.issueCampaignToken('김수만', '85926325');
  ok('거부: 실 리뷰어지만 허용명단 밖 → 미발급', notEd.ok === false && !notEd.token);

  ok('거부 메시지는 존재여부 노출 최소화(동일 문구)', badId.error === notEd.error);

  // ── ③ 배선 grep ──
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
  const rev = read('src/routes/reviewer.routes.js');
  const adm = read('src/routes/admin.routes.js');
  const cc = readF('js/campaign-cards.js');
  const idx = readF('index.html');
  const app = readF('js/index-app.js');
  ok('라우트: 발급=리미터 붙은 공개 POST /campaign-token', /campaign-token', campaignTokenLimiter/.test(rev));
  ok('라우트: 명단관리=masterOnly (/api/admin/campaign-editors)',
    /campaign-editors', authMiddleware, masterOnlyMiddleware/.test(adm));
  ok('프론트: _adminTok에 rapp_camp_edit_token 병합', /rapp_camp_edit_token/.test(cc));
  ok('프론트: 로그인 시 토큰 발급 시도 + 로그아웃 시 제거',
    /maybeFetchCampEditToken/.test(idx) && /removeItem\("rapp_camp_edit_token"\)/.test(idx));
  ok('프론트: 마스터 명단 UI(설정 탭 loadCampEditors)', /function loadCampEditors/.test(app) && /loadCampEditors\(\)/.test(app));

  console.log(`\n✅ reviewerCampaignEditor: ${passed}개 통과`);
})().catch((e) => { console.error('❌ 실패:', e.stack || e.message); process.exit(1); });
