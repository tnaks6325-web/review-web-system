/**
 * workdeskSettingsTab.test.js — 통합 작업대 '설정' 탭 회귀가드
 * 실행: node tests/workdeskSettingsTab.test.js
 *
 * 이 화면의 위험은 셋이다.
 *  ① **권한** — 회사 사업자번호·리뷰어 소식·공지는 전사 설정이고 공지는 리뷰어 홈에 그대로 나간다.
 *     게이트가 한 칸만 어긋나면 AE·광고주가 누른다. 그리고 레포가 이미 밟은 함정 —
 *     역할 미들웨어 앞에 `authMiddleware` 를 빠뜨리면 **마스터 포함 전원 403** 이 된다.
 *     → 라우터 스택을 **실제로 검사**한다.
 *  ② **사본 드리프트** — 설정 화면을 통합 작업대용으로 베끼면 관리자 대시보드와 계속 어긋난다.
 *     → 마크업·로직이 공유 모듈 한 벌인지, 화면들이 마운트만 하는지 고정한다.
 *  ③ **모듈 단독 실행** — 공유 모듈이 호스트 전역(gasGet·escHtml·API_BASE_URL)에 의존하면
 *     통합 작업대에서 조용히 죽는다(work-order-detail.js 를 뺄 때 실제로 밟은 함정).
 *     → 전역 0인 가짜 DOM 에서 **실제로 mount() 를 실행**해 본다.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const F = p => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');

let pass = 0;
const t = (name, cond) => { assert(cond, name); pass++; console.log('  ✓ ' + name); };

console.log('\n▶ 통합 작업대 설정 탭 회귀가드\n');

/* ── 1) 권한 — 라우터 스택 실검사 ──────────────────────────── */
console.log('1) 권한 게이트');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const router = require('../src/routes/trackB.routes');
const L = {};
router.stack.filter(l => l.route).forEach(l => {
  const m = Object.keys(l.route.methods)[0];
  L[m.toUpperCase() + ' ' + l.route.path] = l.route.stack.map(s => s.name);
});

// 본인 계정 설정 = 내부인 전원(master/admin/AE). 광고주·리뷰어는 internalMiddleware 가 막는다.
const INTERNAL = ['GET /settings/my-nickname', 'POST /settings/my-nickname'];
// 전사 설정·리뷰어 노출 = master/admin 전용(원본 라우트와 1:1)
const ADMIN_ONLY = [
  'GET /settings/provider-info',
  'POST /settings/company-business-no',
  'POST /settings/cash-receipt-guide',
  'POST /settings/guide-image',
  'GET /settings/notices',
  'POST /settings/notices/save',
  'POST /settings/notices/delete',
];

INTERNAL.concat(ADMIN_ONLY).forEach(k => t('라우트 존재: ' + k, Array.isArray(L[k])));
t('★★ 모든 설정 라우트가 authMiddleware 로 시작 — 빠뜨리면 마스터 포함 전원 403(레포 실측 사고)',
  INTERNAL.concat(ADMIN_ONLY).every(k => L[k] && L[k][0] === 'authMiddleware'));
t('내 닉네임 = 내부인 전원(AE 포함) · 광고주 차단',
  INTERNAL.every(k => L[k].includes('internalMiddleware') && !L[k].includes('adminOrMasterMiddleware')));
t('★ 사업자번호·현영 이미지·리뷰어 공지 = master/admin 전용(AE 도 차단)',
  ADMIN_ONLY.every(k => L[k].includes('adminOrMasterMiddleware')));
t('★ /settings/guide-image 는 원본(무인증)보다 좁다 — 업로드 창구를 넓히지 않는다',
  L['POST /settings/guide-image'].includes('adminOrMasterMiddleware')
  && !/router\.post\('\/guide-image',\s*authMiddleware/.test(R('src/routes/order.routes.js')));

/* ── 2) 로직 복제 0 — 기존 핸들러 위임만 ───────────────────── */
console.log('\n2) 사본 금지(서버)');
const tb = R('src/routes/trackB.routes.js');
t('설정 라우트는 _delegate 로 기존 핸들러를 태운다',
  /_setHandlers\s*=\s*\{[\s\S]*?_delegate\(_adminRoutes, 'get', '\/my-nickname'\)/.test(tb)
  && /_delegate\(_tabRoutes, 'post', '\/company-business-no'\)/.test(tb)
  && /_delegate\(_reviewerRoutes, 'post', '\/notices\/save'\)/.test(tb));
t('★ SQL·저장 로직을 베끼지 않았다(원장 테이블 이름이 trackB 라우트에 없음)',
  !/admin_nicknames/.test(tb) && !/reviewer_notices/.test(tb) && !/company_business_no/.test(tb));
t('★ 위임 대상이 사라지면 부팅 시 throw — 조용한 404 금지',
  /위임 대상 라우트를 찾지 못함/.test(tb));
t('원본 라우트는 무변경 — /api/admin·/api/tab·/api/reviewer 게이트 그대로',
  /router\.get\('\/my-nickname', authMiddleware,/.test(R('src/routes/admin.routes.js'))
  && /router\.post\('\/company-business-no', authMiddleware, adminOrMasterMiddleware,/.test(R('src/routes/tabconfig.routes.js'))
  && /router\.get\('\/notices\/all', authMiddleware, adminOrMasterMiddleware,/.test(R('src/routes/reviewer.routes.js')));

/* ── 3) 사본 금지(프론트) ──────────────────────────────────── */
console.log('\n3) 사본 금지(프론트)');
const mod = F('js/admin-settings.js');
const adm = F('admin.html');
const siand = F('admin-siand.html');
const wdk = F('workdesk.html');
const app = F('js/index-app.js');

t('마크업·로직은 공유 모듈 한 벌', /window\.AdminSettings\s*=/.test(mod)
  && /function _nicknameHtml/.test(mod) && /function _businessHtml/.test(mod) && /function _noticeHtml/.test(mod));
t('★ 세 화면이 같은 모듈을 로드한다', [adm, siand, wdk].every(h => /js\/admin-settings\.js/.test(h)));
t('★ 화면에는 사본이 없다 — 마운트 지점만',
  !/id="myNicknameInput"/.test(adm) && !/id="companyBusinessNoInput"/.test(adm) && !/id="rvNoticeList"/.test(adm)
  && !/id="myNicknameInput"/.test(siand)
  && /id="adminSettingsMount"/.test(adm) && /id="rvNoticeMount"/.test(adm)
  && /id="adminSettingsMount"/.test(siand) && /id="adminSettingsMount"/.test(wdk));
t('★ index-app.js 에 같은 이름의 선언이 남아 있지 않다(뒤에 로드되어 모듈 전역을 덮는다)',
  !/function saveMyNickname/.test(app) && !/function saveCompanyBusinessNo/.test(app)
  && !/function uploadCashReceiptGuide/.test(app) && !/function saveReviewerNotice/.test(app)
  && !/const CR_GUIDE_CHANNELS/.test(app));
t('★ 모듈은 index-app.js **앞**에 로드된다(순서가 바뀌면 전역이 덮인다)',
  [adm, siand].every(h => h.indexOf('js/admin-settings.js') < h.indexOf('js/index-app.js')));
t('탭 전환 훅(호출부)은 그대로 — 로드 타이밍 불변',
  /tabName === "settings"[\s\S]{0,400}loadMyNickname/.test(app)
  && /tabName === "dashboard"[\s\S]{0,400}loadReviewerNoticesAdmin/.test(app)
  && /autoload: false/.test(adm));

/* ── 4) 통합 작업대 배선 ───────────────────────────────────── */
console.log('\n4) 통합 작업대 배선');
t('nav 에 설정 탭(관리자·AE 양쪽)', (wdk.match(/data-v="settings"/g) || []).length === 2);
t('switchView 분기', /v==='settings'\) renderSettingsView\(\)/.test(wdk));
t('★ 서버 경로 재기준 — /api/trackb/settings (SSO 토큰이 도달 가능한 유일 경로)',
  /window\.ADMIN_SETTINGS_API\s*=\s*'\/api\/trackb\/settings'/.test(wdk));
t('★ 패널 노출 = 서버 게이트와 1:1(AE 는 닉네임만)',
  /isAdmin \? \['nickname','business','notice'\] : \['nickname'\]/.test(wdk));
t('모듈 미로드 시 조용히 빈 화면이 아니라 사유를 보여준다',
  /설정 모듈\(js\/admin-settings\.js\)을 불러오지 못했습니다/.test(wdk));

/* ── 5) 모듈 자립성 ────────────────────────────────────────── */
console.log('\n5) 모듈 자립성(호스트 전역 없이 동작)');
t('★ gasGet/gasPost 미사용 — 액션맵은 경로가 고정이라 Track B 로 재기준할 수 없다',
  !/gasGet\(/.test(mod) && !/gasPost\(/.test(mod));
t('API_BASE_URL 은 typeof 로 감싸 참조(없는 화면에서도 안 죽는다)',
  /typeof API_BASE_URL !== "undefined"/.test(mod));
t('escHtml 은 **호출 시점**에 찾는다(로드 순서상 캡처하면 늘 폴백이 잡힌다)',
  /function escHtml\(s\) \{[\s\S]{0,200}window\.escHtml/.test(mod));
t('경로 매핑이 기본값·접미사 양쪽에 같은 키를 갖는다(한쪽만 늘리면 404)',
  (() => {
    const g = re => [...mod.matchAll(re)].map(m => m[1]);
    const a = g(/^\s{4}(\w+):\s+"\/api\//gm);
    const b = g(/^\s{4}(\w+):\s+"\/(?!api)/gm);
    return a.length === 8 && a.join(',') === b.join(',');
  })());

// 실제 실행 — 전역이 하나도 없는 가짜 DOM 에서 mount() 가 도는지
const captured = {};
function fakeEl(id) {
  return {
    id, innerHTML: '', classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    appendChild() {}, setAttribute() {},
  };
}
const doc = {
  _els: {},
  getElementById(id) { if (id === 'adminSettingsStyles') return null; return this._els[id] || (this._els[id] = fakeEl(id)); },
  createElement() { return { set textContent(v) { captured.css = v; }, get textContent() { return captured.css; } }; },
  head: { appendChild() {} },
  documentElement: {},
  addEventListener() {},
};
const sandbox = {
  window: {}, document: doc, console: { log() {}, warn() {} },
  sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),   // 테마 없는 호스트 = 통합 작업대
  fetch: () => Promise.reject(new Error('no network in test')),
  FileReader: function () {}, setTimeout, clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(mod, sandbox, { filename: 'admin-settings.js' });

t('★ 호스트 전역 0인 환경에서 모듈이 로드된다(미해결 참조 없음)',
  typeof sandbox.window.AdminSettings === 'object' && typeof sandbox.window.AdminSettings.mount === 'function');
t('★ mount() 실행 — 세 패널이 실제로 그려진다', (() => {
  const okRet = sandbox.window.AdminSettings.mount('adminSettingsMount', { panels: ['nickname', 'business', 'notice'], autoload: false });
  const html = doc._els.adminSettingsMount.innerHTML;
  return okRet === true
    && /id="myNicknameInput"/.test(html) && /id="companyBusinessNoInput"/.test(html) && /id="rvNoticeList"/.test(html);
})());
t('★ 채널 4칸이 표에서 생성된다(하드코딩 아님)', (() => {
  const html = doc._els.adminSettingsMount.innerHTML;
  return ['Coupang', 'Naver', 'Oliveyoung', 'Kakao'].every(c =>
    html.includes('id="crGuideFile' + c + '"') && html.includes('id="crGuideImg' + c + '"'));
})());
t('★ 테마 없는 호스트엔 as-standalone 이 붙는다(admin.html 은 테마가 있어 안 붙음 = 렌더 불변)',
  doc._els.adminSettingsMount.classList.contains('as-standalone')
  && /--t1:#0F172A/.test(captured.css || ''));
t('AE 용 부분 마운트 — 닉네임만 그린다', (() => {
  const el = doc._els.adminSettingsMount;
  el.innerHTML = ''; el.classList._s.clear();
  sandbox.window.AdminSettings.mount('adminSettingsMount', { panels: ['nickname'], autoload: false });
  return /id="myNicknameInput"/.test(el.innerHTML)
    && !/id="companyBusinessNoInput"/.test(el.innerHTML) && !/id="rvNoticeList"/.test(el.innerHTML);
})());
t('전역 노출 — 생성 HTML 의 onclick 이 이름으로 찾는 함수들',
  ['saveMyNickname', 'saveCompanyBusinessNo', 'uploadCashReceiptGuide', 'clearCashReceiptGuide',
   'loadReviewerNoticesAdmin', 'saveReviewerNotice', 'toggleReviewerNoticeForm', 'editReviewerNotice',
   'cancelReviewerNoticeEdit', 'toggleReviewerNotice', 'deleteReviewerNotice',
   'loadMyNickname', 'loadCompanyBusinessNo'].every(n => typeof sandbox.window[n] === 'function'));
t('★ 닉네임 저장 후 열린 문의방 갱신은 cs-inquiry 훅으로(모듈 스코프 threadId 를 베끼지 않음)',
  /window\.csReloadActiveConversation/.test(mod)
  && /csReloadActiveConversation: function \(\)/.test(F('js/cs-inquiry.js')));

console.log(`\n✅ workdeskSettingsTab: ${pass}개 통과\n`);
process.exit(0);   // trackB.routes 를 require 하면 DB 풀 핸들이 열려 자연 종료가 안 됨
