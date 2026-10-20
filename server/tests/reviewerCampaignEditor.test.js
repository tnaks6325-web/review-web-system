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
ok('허용: POST /api/product/preview (상품정보 자동수집·읽기전용)',
  runAuth(campTok, 'POST', '/api/product', '/preview').nexted === true);
ok('차단: 상품 라우트 타 경로(POST /api/product/other) — preview 정확일치만',
  runAuth(campTok, 'POST', '/api/product', '/other').status === 403);
ok('차단: PUT /admin/:id/status (표면 최소화 — 모달은 본 PUT 바디로 status 전송)',
  runAuth(campTok, 'PUT', '/api/campaign', '/admin/abc123/status').status === 403);

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
ok('차단: 타 관리자 API 전반(/api/admin/smart-build/stop)',
  runAuth(campTok, 'POST', '/api/admin', '/smart-build/stop').status === 403);
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

// ── ② 토큰 발급 = 인트라넷 관리자 판정(결정 257) — 인트라넷 응답 스텁(가짜 fetch)으로 실제 실행 ──
process.env.INTRANET_SSO_ADMIN_USERS = 'boss';
process.env.INTRANET_SSO_ADMIN_GROUPS = '콘텐츠운영팀|체험단파트';
delete require.cache[require.resolve('../src/services/reviewerCampaignEditor.service')];
const svc = require('../src/services/reviewerCampaignEditor.service');
const fakeIntranet = (user) => async () => ({
  ok: !!user, json: async () => (user ? { data: user } : { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }),
});

(async () => {
  const good = await svc.issueCampaignTokenForIntranetAdmin('boss', 'pw', fakeIntranet({ username: 'boss', display_name: '김수만', department: '경영', role: 'user' }));
  ok('발급: 인트라넷 지정 관리자(아이디) → 토큰', good.ok === true && !!good.token && good.name === '김수만');
  const dec = jwt.verify(good.token, process.env.JWT_SECRET);
  ok('발급 토큰 클레임: role=admin(하향) · via=reviewer_campaign · iu · ia=true · phone8 없음',
    dec.role === 'admin' && dec.via === 'reviewer_campaign' && dec.iu === 'boss' && dec.ia === true && !('phone8' in dec));
  ok('발급 토큰은 스코프 격리를 그대로 통과(공고 PUT만, DELETE 차단)',
    runAuth(good.token, 'PUT', '/api/campaign', '/admin/x').nexted === true &&
    runAuth(good.token, 'DELETE', '/api/campaign', '/admin/x').status === 403);
  ok('저장 시점 재확인: 새 토큰 통과 · 옛 phone8 토큰 거절',
    svc.isIntranetAdminCampaignToken(dec) === true &&
    svc.isIntranetAdminCampaignToken({ via: 'reviewer_campaign', role: 'admin', phone8: '85926325' }) === false &&
    svc.isIntranetAdminCampaignToken({ via: 'intranet', role: 'admin', iu: 'boss', ia: true }) === false);

  const grp = await svc.issueCampaignTokenForIntranetAdmin('kim', 'pw', fakeIntranet({ username: 'kim', display_name: '김체험', department: '콘텐츠운영팀', part: '체험단파트' }));
  ok('발급: 인트라넷 관리자 그룹(부서|파트) → 토큰', grp.ok === true && !!grp.token);

  const staff = await svc.issueCampaignTokenForIntranetAdmin('lee', 'pw', fakeIntranet({ username: 'lee', display_name: '이직원', department: 'AE', role: 'admin' }));
  ok('거부: 일반 직원(인트라넷 자체 role=admin 이어도 자기신고라 불인정) → 미발급 · 사유 not_admin',
    staff.ok === false && !staff.token && staff.reason === 'not_admin');

  const bad = await svc.issueCampaignTokenForIntranetAdmin('boss', 'wrong', fakeIntranet(null));
  ok('거부: 인트라넷 자격 불일치 → 미발급', bad.ok === false && !bad.token);
  const empty = await svc.issueCampaignTokenForIntranetAdmin('', '', fakeIntranet(null));
  ok('거부: 빈 입력 → 미발급', empty.ok === false && !empty.token);

  // ── ③ 배선 grep ──
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
  const rev = read('src/routes/reviewer.routes.js');
  const adm = read('src/routes/admin.routes.js');
  const camp = read('src/routes/campaign.routes.js');
  const prod = read('src/routes/product.routes.js');
  const cc = readF('js/campaign-cards.js');

  ok('SSRF: product/preview 사설·루프백·링크로컬 IP 차단 가드',
    /function _isBlockedHost/.test(prod) && /_isBlockedHost\(host\)/.test(prod) && /169.*254/.test(prod));

  // 레드팀 방어 배선 (campaign.routes.js)
  ok('#2/#6: PUT /admin/:id가 via=reviewer_campaign면 전용 화이트리스트 핸들러로 분기',
    /req\.admin\.via === 'reviewer_campaign'[\s\S]{0,80}_scopedCampaignEdit/.test(camp));
  ok('#2: 스코프 핸들러 UPDATE의 SET절에 linked_*·participation_mode·work_detail·deadline·chat_url 미포함', (() => {
    // 주석이 아니라 스코프 핸들러의 실제 SQL SET절만 검사(함수명 앵커 → UPDATE … RETURNING)
    const m = camp.match(/async function _scopedCampaignEdit[\s\S]*?UPDATE recruit_campaigns SET([\s\S]*?)RETURNING/);
    if (!m) return false;
    const setClause = m[1];
    return !/linked_/.test(setClause) && !/participation_mode/.test(setClause)
      && !/work_detail/.test(setClause) && !/deadline/.test(setClause) && !/chat_url/.test(setClause);
  })());
  ok('#3: 스코프 핸들러가 사용 시점 인트라넷 관리자 토큰(iu·ia) 재확인',
    /async function _scopedCampaignEdit[\s\S]{0,200}isIntranetAdminCampaignToken\(req\.admin\)/.test(camp));
  ok('자율주문: auto_order=true면 구매시간 명시적 null(전환), 아니면 빈값=현재값 유지',
    /autoOrder = b\.auto_order === true/.test(camp) && /autoOrder \? null : keep\(b\.window_start/.test(camp));
  ok('#2: 참여형 공고만 스코프 편집 허용(레거시 미접촉)',
    /_scopedCampaignEdit[\s\S]*?!c\.participation_mode/.test(camp));
  ok('#4: GET /:id는 via=reviewer_campaign면 축약 뷰(_scopedEditorView)만 반환',
    /_d\.via === 'reviewer_campaign'[\s\S]{0,120}_scopedEditorView/.test(camp));
  // work_detail은 **의도적으로 포함**(수정 모달의 유입가이드 육안 확인용, 읽기 전용).
  //   보상통제 = 저장 화이트리스트에 여전히 없음(바로 아래 가드) + 이미 홀드 보유 리뷰어에게
  //   공개되는 sanitize된 값. 나머지 연결·구조 필드는 종전대로 미노출로 고정한다.
  ok('#4: 축약 뷰에 chat_url·notes·linked_* 미포함(구조/연결 필드 격리 유지)', (() => {
    const m = camp.match(/function _scopedEditorView\(row\) \{[\s\S]*?\n\}/);
    if (!m) return false;
    const body = m[0].replace(/^\s*\/\/.*$/gm, '');   // 주석 제외 — 실제 반환 필드만 판정
    return !/chat_url/.test(body) && !/notes/.test(body) && !/linked_/.test(body) && !/source_work_order_id/.test(body);
  })());
  const idx = readF('index.html');
  // 옛 관리자 대시보드 폐기(결정 267) — index-app.js 가 없어져, 옛 명단 UI 재유입은 프론트 전체에서 본다.
  const _fe = require('fs').readdirSync(require('path').join(__dirname, '../../frontend/js')).filter(f => f.endsWith('.js')).map(f => readF('js/' + f)).concat([readF('workdesk.html'), idx]).join('\n');   // 옛 관리자 대시보드 폐기(결정 267) — admin.html 진입 경로까지 삭제
  ok('라우트: 발급=인트라넷 로그인 리미터 붙은 POST /campaign-token-intranet', /campaign-token-intranet', intranetLoginLimiter/.test(rev));
  ok('라우트: 옛 phone8 발급·명단관리 폐지', !/'\/campaign-token',/.test(rev) && !/campaign-editors', authMiddleware/.test(adm));
  ok('프론트: _adminTok에 rapp_camp_edit_token 병합', /rapp_camp_edit_token/.test(cc));
  ok('프론트: "관리자로 공고 수정" 로그인 → 인트라넷 발급 경로 · 로그아웃 시 제거',
    /openCampEditLogin\(\)/.test(idx) && /\/api\/reviewer\/campaign-token-intranet/.test(idx) && /removeItem\("rapp_camp_edit_token"\)/.test(idx));
  ok('프론트: 리뷰어 로그인 때 서버에 묻지 않는다(자동 발급 폐지)', !/\/api\/reviewer\/campaign-token"/.test(idx));
  ok('프론트: [공고 수정] 버튼은 기본 숨김(모든 리뷰어에게 보이지 않음) — 2곳 모두',
    (idx.match(/class="rc-edit-login" style="display:none"/g) || []).length === 2 && !/class="rc-edit-login"(?! style="display:none")/.test(idx));
  ok('프론트: 직원용 주소(?staff=1) 또는 받은 열쇠가 있을 때만 보인다', (() => {
    const m = idx.match(/function _campEditEntryAllowed\(\) \{[\s\S]*?\n\}/);
    if (!m) return false;
    const vm = require('vm');
    const run = (search, store) => {
      const ss = new Map(Object.entries(store || {}));
      const ctx = { URLSearchParams, location: { search, pathname: '/', hash: '' }, history: { replaceState() {} },
        sessionStorage: { getItem: k => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)) } };
      vm.runInNewContext(m[0] + '\nthis.r=_campEditEntryAllowed();', ctx);
      return ctx.r;
    };
    return run('', {}) === false && run('?staff=1', {}) === true && run('?staff=0', {}) === false
      && run('', { rapp_staff_entry: '1' }) === true && run('', { rapp_camp_edit_token: 't' }) === true;
  })());
  ok('프론트: 공고수정 로그인 창은 viewHome 밖(로그인 전 화면에서도 보인다 — Codex PR #1655)', (() => {
    const o = idx.indexOf('id="campEditLoginOvl"'), h = idx.indexOf('id="viewHome"');
    // viewHome 블록이 닫힌 뒤(=문서 끝 쪽 body 직속)에 있어야 한다
    return o > 0 && h > 0 && o > idx.lastIndexOf('id="viewHome"') && idx.slice(o).indexOf('</body>') > 0 && idx.slice(o, idx.indexOf('</body>', o)).indexOf('id="viewHome"') < 0
      && idx.lastIndexOf('<div id="campEditLoginOvl"') > idx.lastIndexOf('<div class="home-footer">');
  })());
  ok('프론트: 옛 마스터 명단 UI 제거', !/function loadCampEditors/.test(_fe) && !/loadCampEditors\(\)/.test(_fe));

  // ── ④ 리뷰어 앱 모달: 유입가이드 확인 + 마감 공고 진행과정 미리보기 ──
  ok('축약뷰에 work_detail 포함(읽기전용 프리필) — 수정 모달에서 유입가이드 육안 확인',
    /work_detail: row\.work_detail/.test(camp));
  ok('★ 쓰기 표면 불변 — 스코프 저장 UPDATE SET절에 work_detail 없음(노출은 읽기전용)', (() => {
    const m = /async function _scopedCampaignEdit[\s\S]*?UPDATE recruit_campaigns SET([\s\S]*?)WHERE id=\$1/.exec(camp);
    return !!m && !/work_detail/.test(m[1]);
  })());
  ok('모달 [리뷰어 화면]은 **진짜 admin 토큰**일 때만 preview=1 — 스코프 토큰은 preview 403이라 제외', (() => {
    const fn = /function _fullAdminTok\(\) \{[\s\S]*?\n  \}/.exec(cc);
    return !!fn && !/rapp_camp_edit_token/.test(fn[0])
      && /sessionStorage\.getItem\('admin_token'\) \|\| localStorage\.getItem\('admin_token'\)/.test(fn[0]);
  })());
  ok('미리보기 토큰은 프래그먼트(#tok=)로만 전달 — 서버 로그·Referer 미유출',
    /'&preview=1#tok=' \+ encodeURIComponent\(_pvTok\)/.test(cc));
  ok('토큰 없으면 기존 일반 링크 그대로(무토큰 동작 불변)',
    /\(_pvTok \? '&preview=1#tok=' \+ encodeURIComponent\(_pvTok\) : ''\)/.test(cc));

  console.log(`\n✅ reviewerCampaignEditor: ${passed}개 통과`);
})().catch((e) => { console.error('❌ 실패:', e.stack || e.message); process.exit(1); });
