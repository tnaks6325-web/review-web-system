'use strict';
/* 결정 417 — 리뷰어 첫 로그인의 막다른 길 세 개(첫 로그인 점검 2026-11-25 H1·H2·H3).
 *
 *   H1 공고 화면 「본인 확인」 창에 가입하는 길이 없었다 — 미가입 안내는 3초 토스트뿐, 단추는 [확인하고 계속하기]·[취소]뿐.
 *      → 창에 「처음이신가요? 리뷰어 등록하기 →」(등록 화면에 돌아올 공고 id 를 넘김) + 실패 안내를 창 안에 남긴다.
 *   H2 리뷰어 등록(search.html#register)·그 화면 로그인 탭을 마치면 옛 「아이에이리뷰」 검색 화면에 남고, 홈 신원(iad_reviewer_user)을
 *      쓰지 않아 리뷰어 홈이 다시 로그인하라고 했다.
 *      → 홈 신원을 기존 도우미(_syncReviewerHomeSessionForReturn) 하나로 적고 리뷰어 홈(또는 돌아갈 공고)으로 location.replace.
 *        구매양식 대기·틀 안·등록 화면이 아닌 진입은 종전 그대로. 홈은 홈 신원이 비었을 때 공용 세션(rapp_reviewer_auth)을 옮겨 적는다.
 *   H3 리뷰어 홈 [로그인]은 시간 제한이 없어 서버가 답을 안 하면 「확인 중...」에서 멈췄다 → 20초 제한 + 쉬운 안내 + 단추 되살림.
 *
 * 세 화면의 **실제 함수 본문**을 vm 에서 돌린다(가짜 저장소·가짜 location·가짜 타이머). 옛 코드는 행동으로 실패한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend/campaign.html'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8');
const SA = fs.readFileSync(path.join(ROOT, 'frontend/js/search-app.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'frontend/api.js'), 'utf8');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'frontend/search.html'), 'utf8');

function braceEnd(src, k) {
  let depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "'" || c === '"' || c === '`') { const q = c; for (k++; k < src.length && src[k] !== q; k++) if (src[k] === '\\') k++; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return k; }
  }
  throw new Error('중괄호 불균형');
}
/** 함수 본문 그대로(없으면 '' — 옛 코드는 아래 행동 검사에서 실패한다). */
function fn(src, name) {
  let i = src.indexOf('\nfunction ' + name + '(');
  let a = false;
  if (i < 0) { i = src.indexOf('\nasync function ' + name + '('); a = i >= 0; }
  if (i < 0) return '';
  i += 1;
  return src.slice(i, braceEnd(src, src.indexOf('{', src.indexOf(')', i))) + 1) + '\n';
}
const store = (m = {}) => ({ m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } });
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const el = (id) => ({ id, value: '', textContent: '', innerHTML: '', disabled: false, style: { display: '' }, classList: { add() {}, remove() {}, contains: () => false },
  focus() {}, select() {}, closest() { return null; } });
const NOT_REG = '가입되지 않은 정보입니다. 이름과 전화번호를 확인하시거나, 먼저 회원가입을 해주세요.';
const SLOW = '응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요.';

/* ═════════════ H1 — 공고 화면 본인 확인 창 ═════════════ */
const SHEET = CAMP.slice(CAMP.indexOf('id="loginSheet"'), CAMP.indexOf('</div>\n</div>', CAMP.indexOf('id="loginSheet"')));
const CSCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

function campWorld(fetchResult) {
  const els = { liName: el('liName'), liPhone: el('liPhone'), loginSheet: el('loginSheet') };
  if (/id="liMsg"/.test(SHEET)) els.liMsg = Object.assign(el('liMsg'), { style: { display: 'none' } });
  const log = { toasts: [], left: [], afterLogin: 0, saved: [] };
  const sb = {
    console, URLSearchParams, JSON, Promise, String, Number, setTimeout, clearTimeout, encodeURIComponent,
    document: { getElementById: (id) => els[id] || null },
    API_BASE_URL: 'http://api.test', CAMP_ID: 'c1', _CAMP_MSG_SERVER: '서버에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요.',
    toast: (m) => log.toasts.push(m), _sheetOpen: (id) => { els[id].style.display = 'flex'; }, _sheetClose: (id) => { els[id].style.display = 'none'; },
    _sheetLeave: (u) => log.left.push(u),
    _campFetch: async () => fetchResult, _campTempFail: (r) => !!(r && r.status >= 500), _campErrText: () => '인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.',
    saveSession: (...a) => log.saved.push(a),
  };
  vm.createContext(sb);
  vm.runInContext('var _afterLogin = null;\n' + ['$', 'needLogin', 'hideSheet', '_liMsg', 'doVerify', 'goRegisterNew'].map((n) => fn(CSCRIPT, n)).join('\n'), sb);
  return { sb, els, log, run: (c) => vm.runInContext(c, sb) };
}

test('H1-1 본인 확인 창에 「처음이신가요? 리뷰어 등록하기」 입구가 있고, 실패 안내 자리(#liMsg)가 창 안에 있다', () => {
  assert.ok(SHEET.length > 50, '본인 확인 창');
  assert.match(SHEET, /처음이신가요\?[\s\S]{0,120}리뷰어 등록하기/, '★ 처음 온 사람의 등록 입구');
  assert.match(SHEET, /onclick="return goRegisterNew\(\)"/, '입구는 goRegisterNew(돌아올 공고를 넘김)');
  assert.match(SHEET, /id="liMsg"[^>]*role="alert"/, '★ 실패 안내를 창 안에 남기는 자리');
  // 결정 403 — 창의 닫기 단추(마지막 hide 함수)는 그대로 hideSheet
  assert.strictEqual([...SHEET.matchAll(/onclick="(hide\w+)\(\)"/g)].map((m) => m[1]).pop(), 'hideSheet');
});

test('H1-2 [리뷰어 등록하기] = 돌아올 공고 id 를 붙여 등록 화면으로(창을 연 채 떠나므로 _sheetLeave) · 기본 이동은 막는다', () => {
  const w = campWorld(null);
  const ret = w.run('goRegisterNew()');
  assert.deepStrictEqual(w.log.left, ['/search?returnCamp=c1#register']);
  assert.strictEqual(ret, false, '<a href> 의 기본 이동은 막는다(대신 _sheetLeave)');
  w.sb.CAMP_ID = 'a/b?c';
  w.run('goRegisterNew()');
  assert.strictEqual(w.log.left[1], '/search?returnCamp=a%2Fb%3Fc#register', '공고 id 는 인코딩');
  assert.match(fn(CSCRIPT, 'goRegisterNew'), /_sheetLeave\(/, '결정 403 — 창을 연 채 떠나는 길');
  assert.match(CSCRIPT, /reason === 'not_registered'\)\{[^\n]*goRegisterNew/, '참여 거절 「리뷰어 등록 후」도 같은 길(등록 뒤 공고로 돌아옴)');
});

test('H1-3 미가입·틀린 이름 안내는 토스트만이 아니라 창 안에 남는다(서버 문구 그대로) · 다시 열면 지워진다', async () => {
  const w = campWorld({ ok: true, status: 200, j: { ok: false, error: NOT_REG, field: 'name' } });
  w.els.liName.value = '최없음'; w.els.liPhone.value = '99998888';
  w.run('needLogin(() => {})');
  await w.run('doVerify()'); await settle();
  assert.deepStrictEqual(w.log.toasts, [NOT_REG], '토스트는 종전 그대로');
  assert.ok(w.els.liMsg, '★ 창 안 안내 자리');
  assert.strictEqual(w.els.liMsg.textContent, NOT_REG, '★ 창 안에 서버 문구 그대로');
  assert.notStrictEqual(w.els.liMsg.style.display, 'none', '★ 보인다');
  assert.strictEqual(w.els.loginSheet.style.display, 'flex', '창은 열린 채');
  w.run('hideSheet()'); w.run('needLogin(() => {})');
  assert.strictEqual(w.els.liMsg.style.display, 'none', '다시 열면 지난 안내는 지운다');

  const wrong = "이 번호는 '김예시' 이름으로 가입돼 있어요. 이름을 '김예시' 그대로 넣고 로그인해 주세요.";
  const w2 = campWorld({ ok: true, status: 200, j: { ok: false, error: wrong, field: 'name' } });
  w2.els.liName.value = '홍길동'; w2.els.liPhone.value = '00000000';
  await w2.run('doVerify()'); await settle();
  assert.strictEqual(w2.els.liMsg && w2.els.liMsg.textContent, wrong, '틀린 이름 안내(가입된 이름 표시)는 문구 그대로');

  const w3 = campWorld({ ok: false, status: 503, j: {} });
  w3.els.liName.value = '김예시'; w3.els.liPhone.value = '00000000';
  await w3.run('doVerify()'); await settle();
  assert.strictEqual(w3.els.liMsg && w3.els.liMsg.textContent, w3.sb._CAMP_MSG_SERVER, '서버 일시 오류도 창 안에(결정 397 문구)');
});

test('H1-4 성공하면 종전 그대로 — 세션 저장 · 창 닫기 · 이어서 할 일', async () => {
  const w = campWorld({ ok: true, status: 200, j: { ok: true, name: '김예시', reviewerToken: 't' } });
  w.els.liName.value = '김예시'; w.els.liPhone.value = '00000000';
  let after = 0; w.sb.__after = () => after++;
  w.run('needLogin(() => __after())');
  await w.run('doVerify()'); await settle();
  assert.deepStrictEqual(w.log.saved, [['김예시', '00000000', 't']]);
  assert.strictEqual(w.els.loginSheet.style.display, 'none');
  assert.strictEqual(after, 1);
  assert.deepStrictEqual(w.log.toasts, []);
});

/* ═════════════ H2 — 등록 화면(search.html#register) 등록·로그인 뒤 ═════════════ */
function searchWorld({ hash = '#register', search = '', pending = false, framed = false, verify, register, income = null } = {}) {
  const ls = store(), ss = store();
  const ids = ['loginNameInput', 'loginPhoneInput', 'btnLoginLookup', 'nameInput', 'btnRegisterInline', 'regIncomeNameInline', 'regJuminNoInline'];
  const els = Object.fromEntries(ids.map((i) => [i, el(i)]));
  if (income) { els.regIncomeNameInline.value = income.name; els.regJuminNoInline.value = income.jumin; }
  const log = { replace: [], doSearch: 0, initOrderForm: 0, applyUI: 0, gets: [], posts: [], order: [] };
  const win = { _pendingOrderForm: pending };
  win.self = win; win.top = framed ? {} : win;
  win.location = { hash, search, replace: (u) => { log.replace.push(u); log.order.push('replace'); } };
  const sb = {
    console, URLSearchParams, JSON, Promise, String, Number, Date, setTimeout, clearTimeout, encodeURIComponent,
    window: win, location: win.location, localStorage: ls, sessionStorage: ss,
    document: { getElementById: (id) => els[id] || null },
    APP_CONFIG: { GAS_WEB_APP_URL: 'http://api.test' },
    gasGet: async (p) => { log.gets.push(p.action); if (p.action === 'verifyReviewer') return verify; return income && income.get ? income.get(p) : { ok: true }; },
    gasPost: async (p) => { log.posts.push(p.action); if (p.action === 'registerReviewer') return register; if (p.action === 'saveIncomeInfo') { await new Promise((r) => setTimeout(r, 30)); log.order.push('income'); return { ok: true }; } return { ok: true }; },
    showToast() {}, _applyLoginUI: () => { log.applyUI++; }, _clearLoginErr() {}, _hideLoginBlocked() {}, _showLoginBlocked() {}, _showLoginErr: (m) => { log.loginErr = m; },
    _clearRegErr() {}, _showRegErr() {}, _switchAuthTab() {},
    doSearch: async () => { log.doSearch++; }, initOrderFormMode: () => { log.initOrderForm++; },
  };
  vm.createContext(sb);
  const src = 'const _REVIEWER_AUTH_STORAGE_KEY = "rapp_reviewer_auth"; const REVIEWER_AUTH_KEY = "rapp_reviewer_auth"; const REVIEWER_AUTH_MS = 12*60*60*1000; let _authState = null;\n'
    + ['_getReviewerSessionStore', '_getReviewerSession', '_prepareReviewerLocalSession'].map((n) => fn(API, n)).join('')
    + ['_saveAuthSession', '_syncReviewerHomeSessionForReturn', '_authDoneDest', '_authDoneLeave', '_doLoginDirect', '_submitRegister'].map((n) => fn(SA, n)).join('');
  vm.runInContext(src, sb);
  return { sb, els, log, ls, ss, run: (c) => vm.runInContext(c, sb) };
}
const OK_VERIFY = { ok: true, name: '최신규', phone8: '55556666', reviewerToken: 'tok-new' };
const homeUser = (w) => JSON.parse(w.ls.getItem('iad_reviewer_user') || 'null');

test('H2-1 등록 화면에서 등록을 마치면 리뷰어 홈(/)으로 바꿔 가고, 홈이 읽는 기록(iad_reviewer_user)도 같이 쓴다', async () => {
  const w = searchWorld({ register: { ok: true }, verify: OK_VERIFY });
  await w.run('_submitRegister("최신규", "01055556666", "5555", "6666", "newbie_01")'); await settle();
  assert.deepStrictEqual(w.log.replace, ['/'], '★ 리뷰어 홈으로(옛 검색 화면에 남지 않음 · 방문 기록에 등록 화면 안 남김)');
  assert.strictEqual(w.log.doSearch, 0, '옛 검색 화면(doSearch)을 그리지 않는다');
  assert.strictEqual(w.log.applyUI, 0, '곧 떠날 화면에 옛 「로그인 완료」 영역을 그리지 않는다(내정보 조회가 시작됐다 끊기지 않게)');
  const u = homeUser(w);
  assert.ok(u, '★ 홈 신원 기록');
  assert.deepStrictEqual({ name: u.name, phone8: u.phone8, reviewerToken: u.reviewerToken }, { name: '최신규', phone8: '55556666', reviewerToken: 'tok-new' });
  assert.deepStrictEqual(Object.keys(u).sort(), ['loginAt', 'name', 'phone8', 'reviewerToken'], '새로 저장하는 개인정보 0(이름·뒤 8자리·열쇠뿐)');
  assert.ok(JSON.parse(w.ls.getItem('rapp_reviewer_auth')).reviewerToken === 'tok-new', '공용 세션은 종전 그대로');
});

test('H2-2 공고 창에서 왔으면(?returnCamp=) 등록 뒤 그 공고로 — 공고 id 형식만 받는다(바깥 주소로 가는 길 없음)', async () => {
  const w = searchWorld({ search: '?returnCamp=fx_single', register: { ok: true }, verify: OK_VERIFY });
  await w.run('_submitRegister("최신규", "01055556666", "5555", "6666", "newbie_01")'); await settle();
  assert.deepStrictEqual(w.log.replace, ['/campaign.html?id=fx_single']);
  assert.ok(homeUser(w), '공고로 가도 홈 신원은 같이');
  for (const bad of ['//evil.example', 'https://evil.example', '../admin', 'a b', 'x'.repeat(65)]) {
    const w2 = searchWorld({ search: '?returnCamp=' + encodeURIComponent(bad), register: { ok: true }, verify: OK_VERIFY });
    await w2.run('_submitRegister("최신규", "01055556666", "5555", "6666", "k1")'); await settle();
    assert.deepStrictEqual(w2.log.replace, ['/'], '형식이 아니면 공고로 가지 않고 홈: ' + bad);
  }
});

test('H2-3 등록 화면의 로그인 탭도 같은 길 — 홈(또는 돌아갈 공고) · 홈 신원 기록', async () => {
  const w = searchWorld({ verify: { ok: true, name: '김예시', phone8: '00000000', reviewerToken: 'tok-k' } });
  w.els.loginNameInput.value = '김예시'; w.els.loginPhoneInput.value = '00000000';
  await w.run('_doLoginDirect()'); await settle();
  assert.deepStrictEqual(w.log.replace, ['/']);
  assert.strictEqual(w.log.doSearch, 0);
  assert.strictEqual(w.log.applyUI, 0);
  assert.strictEqual(homeUser(w) && homeUser(w).reviewerToken, 'tok-k');
  const w2 = searchWorld({ search: '?returnCamp=c9', verify: { ok: true, name: '김예시', phone8: '00000000', reviewerToken: 'tok-k' } });
  w2.els.loginNameInput.value = '김예시'; w2.els.loginPhoneInput.value = '00000000';
  await w2.run('_doLoginDirect()'); await settle();
  assert.deepStrictEqual(w2.log.replace, ['/campaign.html?id=c9']);
});

test('H2-4 종전 길은 그대로 — 구매양식 대기 = 양식으로 · 틀 안 · 등록 화면이 아닌 진입(관리자 이름검색) = 옛 동작', async () => {
  const v = { ok: true, name: '김예시', phone8: '00000000', reviewerToken: 't' };
  const login = async (o) => { const w = searchWorld(Object.assign({ verify: v }, o)); w.els.loginNameInput.value = '김예시'; w.els.loginPhoneInput.value = '00000000'; await w.run('_doLoginDirect()'); await settle(); return w; };
  const a = await login({ pending: true });
  assert.deepStrictEqual([a.log.replace.length, a.log.initOrderForm, a.log.doSearch], [0, 1, 0], '구매양식 대기 → 양식');
  const b = await login({ hash: '' });
  assert.deepStrictEqual([b.log.replace.length, b.log.doSearch, b.log.applyUI], [0, 1, 1], '등록 화면이 아닌 진입 → 종전 doSearch(로그인 완료 영역도 종전처럼)');
  assert.strictEqual(a.log.applyUI, 1, '구매양식 대기도 종전처럼 로그인 완료 영역');
  const c = await login({ framed: true });
  assert.deepStrictEqual([c.log.replace.length, c.log.doSearch], [0, 1], '틀 안에서는 홈으로 가지 않는다');
  const d = searchWorld({ pending: true, register: { ok: true }, verify: OK_VERIFY });
  await d.run('_submitRegister("최신규", "01055556666", "5555", "6666", "k1")'); await settle();
  assert.deepStrictEqual([d.log.replace.length, d.log.doSearch], [0, 1], '구매양식 대기 중 등록은 종전 그대로');
  const e = await login({ verify: { ok: false, error: '가입되지 않은 정보입니다.' } });
  assert.deepStrictEqual([e.log.replace.length, homeUser(e)], [0, null], '실패면 이동·기록 0');
});

test('H2-5 등록 때 넣은 소득신고 정보 저장이 끝난 뒤 떠난다(떠나며 저장 요청이 끊기지 않게)', async () => {
  const w = searchWorld({ register: { ok: true }, verify: OK_VERIFY, income: { name: '최신규', jumin: '9001011234567' } });
  await w.run('_submitRegister("최신규", "01055556666", "5555", "6666", "k1")');
  await new Promise((r) => setTimeout(r, 80)); await settle();
  assert.deepStrictEqual(w.log.order, ['income', 'replace'], '★ 저장 → 이동 순서');
});

test('H2-6 등록 화면 스크립트는 새 판(?v=)으로 싣는다', () => {
  // 결정 425 에서 패턴만 갱신(뜻 그대로) — 결정 417 판(20261125) 이후로 올렸는가
  const ver = /js\/search-app\.js\?v=(\d{8})-[\w-]+/.exec(SEARCH_HTML);
  assert.ok(ver && ver[1] >= '20261125', `search-app.js ?v= 가 결정 417 이후 판 — 실제: ${ver && ver[0]}`);
});

/* ═════════════ H2 보강 — 홈이 공용 세션을 옮겨 적기 ═════════════ */
function homeWorld({ rapp, ssRapp, homeSession, user } = {}) {
  const ls = store(), ss = store();
  if (rapp !== undefined) ls.setItem('rapp_reviewer_auth', JSON.stringify(rapp));
  if (ssRapp !== undefined) ss.setItem('rapp_reviewer_auth', ssRapp);
  if (homeSession) ss.setItem('iad_reviewer_home_session', JSON.stringify(homeSession));
  if (user) ls.setItem('iad_reviewer_user', JSON.stringify(user));
  const sb = { console, JSON, String, Number, Date, localStorage: ls, sessionStorage: ss };
  vm.createContext(sb);
  vm.runInContext('const USER_KEY = "iad_reviewer_user"; const HOME_SESSION_KEY = "iad_reviewer_home_session";\n'
    + fn(INDEX, 'getSavedUser') + fn(INDEX, '_adoptSharedReviewerLogin'), sb);
  const adopt = () => vm.runInContext('if (typeof _adoptSharedReviewerLogin === "function" && !getSavedUser()) _adoptSharedReviewerLogin(); getSavedUser()', sb);
  return { ls, ss, adopt };
}
const LIVE = () => ({ name: '최신규', verified: true, registeredMember: true, phone8: '55556666', reviewerToken: 'tok', expAt: Date.now() + 3600e3 });

test('H2-7 홈은 홈 신원이 비었을 때만 공용 세션(이름·8자리·열쇠·12시간 안)을 옮겨 적는다 — 옛 등록 화면·구매양식 로그인 뒤에도 다시 로그인하라고 하지 않음', () => {
  const w = homeWorld({ rapp: LIVE() });
  const u = w.adopt();
  assert.ok(u, '★ 가입 직후 홈이 로그인돼 있다');
  assert.deepStrictEqual({ name: u.name, phone8: u.phone8, reviewerToken: u.reviewerToken }, { name: '최신규', phone8: '55556666', reviewerToken: 'tok' });
  assert.deepStrictEqual(Object.keys(u).sort(), ['loginAt', 'name', 'phone8', 'reviewerToken'], '옮겨 적는 칸은 그 세션에 이미 있던 것뿐');
  assert.match(INDEX, /if \(!getSavedUser\(\)\) _adoptSharedReviewerLogin\(\);[^\n]*\n\s*let user = getSavedUser\(\);/, '첫 화면(initPage)이 신원을 읽기 직전에 한 번');
});

test('H2-8 옮겨 적지 않는 경우 — 만료 · 열쇠/이름/8자리 없음 · 관리자 홈 탭 · 이미 홈 신원 있음', () => {
  assert.strictEqual(homeWorld({ rapp: Object.assign(LIVE(), { expAt: Date.now() - 1 }) }).adopt(), null, '12시간 지남');
  assert.strictEqual(homeWorld({ rapp: Object.assign(LIVE(), { expAt: undefined }) }).adopt(), null, '만료 시각 없음');
  assert.strictEqual(homeWorld({ rapp: Object.assign(LIVE(), { reviewerToken: '' }) }).adopt(), null, '열쇠 없음');
  assert.strictEqual(homeWorld({ rapp: Object.assign(LIVE(), { phone8: '5556666' }) }).adopt(), null, '8자리 아님');
  assert.strictEqual(homeWorld({ rapp: Object.assign(LIVE(), { name: '' }) }).adopt(), null, '이름 없음');
  assert.strictEqual(homeWorld({ rapp: LIVE(), ssRapp: '' }).adopt(), null, '관리자 홈 탭(탭 한정 세션 칸 있음)');
  const kept = homeWorld({ rapp: LIVE(), user: { name: '김예시', phone8: '00000000', reviewerToken: 'old' } }).adopt();
  assert.strictEqual(kept.name, '김예시', '이미 홈 신원이 있으면 덮지 않는다(결정 246 — 다른 탭 로그인으로 이 홈을 바꾸지 않음)');
  assert.strictEqual(homeWorld({}).adopt(), null, '공용 세션 없음 = 종전 로그인 화면');
});

/* ═════════════ H3 — 리뷰어 홈 [로그인] 시간 제한 ═════════════ */
function loginWorld(fetchImpl) {
  const els = { loginName: Object.assign(el('loginName'), { value: '김예시' }), loginPhone: Object.assign(el('loginPhone'), { value: '00000000' }) };
  const btn = el('btn');
  const log = { toasts: [], timers: [], fetchOpts: null, home: 0, field: null };
  const sb = {
    console, JSON, Promise, String, encodeURIComponent, Date, AbortController,
    setTimeout: (f, ms) => { const t = { f, ms, cleared: false }; log.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    document: { getElementById: (id) => els[id] || null, querySelector: (q) => (q === '.login-btn' ? btn : null) },
    localStorage: store(), API_BASE_URL: 'http://api.test', USER_KEY: 'iad_reviewer_user',
    fetch: (u, o) => { log.fetchOpts = o || null; return fetchImpl(u, o); },
    showToast: (m) => log.toasts.push(m), showHome: () => { log.home++; }, _highlightLoginField: (f) => { log.field = f; },
  };
  vm.createContext(sb);
  vm.runInContext(fn(API, 'apiFriendlyErrorMessage') + fn(INDEX, '_rhErrMsg') + fn(INDEX, 'doLogin'), sb);
  return { sb, btn, log, run: (c) => vm.runInContext(c, sb) };
}
const hang = (_u, o) => new Promise((_res, rej) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; rej(e); });
});

test('H3-1 서버가 답을 안 하면 20초 뒤 「응답이 늦어지고 있어요」 + 단추가 다시 눌린다(「확인 중...」에서 멈추지 않음)', async () => {
  const w = loginWorld(hang);
  const p = w.run('doLogin()'); await settle();
  assert.strictEqual(w.btn.disabled, true, '누르는 동안은 잠김(두 번 누르기 막음 — 종전 그대로)');
  assert.ok(w.log.fetchOpts && w.log.fetchOpts.signal, '★ 요청에 시간 제한 신호');
  const t = w.log.timers.find((x) => x.ms === 20000);
  assert.ok(t, '★ 20초 제한(_rhFetchJson 과 같은 시간)');
  t.f(); await p; await settle();
  assert.deepStrictEqual(w.log.toasts, [SLOW], '★ 쉬운 한국어(결정 359 문구)');
  assert.strictEqual(w.btn.disabled, false, '★ 단추 되살림');
  assert.match(w.btn.innerHTML, /로그인/);
  assert.strictEqual(w.log.home, 0);
});

test('H3-2 답이 오면 종전 그대로 — 성공 = 홈 · 실패 = 서버 문구 + 틀린 칸 강조 · 타이머 정리 · 끊김은 쉬운 말', async () => {
  const json = (b) => async () => ({ ok: true, status: 200, json: async () => b });
  const a = loginWorld(json({ ok: true, name: '김예시', phone: '01000000000', reviewerToken: 't' }));
  await a.run('doLogin()'); await settle();
  assert.strictEqual(a.log.home, 1);
  assert.ok(a.log.timers.every((t) => t.ms !== 20000 || t.cleared), '타이머는 끝나면 정리');
  const wrong = "이 번호는 '김예시' 이름으로 가입돼 있어요. 이름을 '김예시' 그대로 넣고 로그인해 주세요.";
  const b = loginWorld(json({ ok: false, error: wrong, field: 'name' }));
  await b.run('doLogin()'); await settle();
  assert.deepStrictEqual([b.log.toasts, b.log.field, b.btn.disabled], [[wrong], 'name', false], '틀린 이름 안내 문구·칸 강조 그대로');
  const c = loginWorld(async () => { throw new TypeError('Failed to fetch'); });
  await c.run('doLogin()'); await settle();
  assert.deepStrictEqual([c.log.toasts, c.btn.disabled], [['인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.'], false]);
  const d = loginWorld(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
  await d.run('doLogin()'); await settle();
  assert.deepStrictEqual([d.log.toasts, d.btn.disabled], [['서버에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요.'], false]);
});

test('인라인 스크립트·search-app.js 문법', () => {
  for (const [f, s] of [['campaign.html', CAMP], ['index.html', INDEX]]) {
    [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => assert.doesNotThrow(() => new vm.Script(m[1], { filename: f + '#' + i })));
  }
  assert.doesNotThrow(() => new vm.Script(SA, { filename: 'search-app.js' }));
});
