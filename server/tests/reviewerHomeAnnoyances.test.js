'use strict';
// 결정 372 — 리뷰어 홈 자잘한 불편 5건.
//  ① 리뷰 미제출 경고: 같은 탭·같은 로그인·같은 날에는 한 번만(새로 로그인·새 탭·다음 날엔 다시) · 경과일은 서버 값 그대로
//  ② 휴대폰 뒤로가기 = 열린 창 닫기(홈에 남는다) · 단추로 닫은 뒤 뒤로가기는 한 번에 나간다
//  ③ 광고 배너는 홈 탭에서만 · 내정보 탭은 [로그아웃]이 맨 끝
//  ④ 내정보 작은 단추(수정·보기) 누르는 자리 28px 이상
//  ⑤ 좁은 화면에서 예금주 이름이 중간에서 안 끊긴다
// VM 검사는 항상 돈다. 실제 브라우저 검사는 Playwright 가 있을 때만 돌고 없으면 skip 으로 드러낸다(가짜 통과 금지).
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '../..');
const HOME = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const CS = fs.readFileSync(path.join(root, 'frontend/js/reviewer-cs.js'), 'utf8');
const SB_PATH = path.join(root, 'frontend/js/reviewer-sheet-back.js');
const SB = fs.existsSync(SB_PATH) ? fs.readFileSync(SB_PATH, 'utf8') : '';
let pw;
try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch (error) { if (process.env.PLAYWRIGHT_MODULE) throw error; }
const test = (name, fn) => nodeTest(name, { skip: !pw && !name.startsWith('VM ') ? 'Playwright unavailable; set PLAYWRIGHT_MODULE to run real browser acceptance' : false }, fn);

function fnSrc(src, name) {
  const re = new RegExp('(?:async\\s+)?function ' + name.replace(/[$]/g, '\\$') + '\\s*\\(');
  const m = re.exec(src); assert.ok(m, name + ' 가 있어야 한다');
  let depth = 0, i = src.indexOf('{', m.index);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(m.index, i + 1);
}
// 도우미의 0ms 타이머(되돌리기 → popstate)가 다 돈 뒤까지 기다린다(차례대로 0ms 타이머 6번 — 시간 재기에 기대지 않는다).
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

/* ── 가짜 브라우저 히스토리: 항목 목록 + 비동기 popstate(실제 브라우저처럼) ── */
function fakeWindow() {
  const entries = [{ state: null }]; let idx = 0; const pops = [];
  const w = { left: 0, replaced: null, navigated: null, events: {} };
  w.history = {
    get state() { return entries[idx].state; },
    get length() { return entries.length; },
    pushState(s) { entries.splice(idx + 1); entries.push({ state: s }); idx++; },
    replaceState(s) { entries[idx] = { state: s }; },
    go(n) { setTimeout(() => { const t = idx + n; if (t < 0) { w.left++; return; } if (t >= entries.length || t === idx) return; idx = t; pops.forEach(f => f({ state: entries[idx].state })); }, 0); },
    back() { this.go(-1); },
  };
  w.location = { href: 'http://127.0.0.1/index.html', replace(u) { w.replaced = u; } };
  Object.defineProperty(w.location, 'assign', { value(u) { w.navigated = u; } });
  w.addEventListener = (type, fn) => { if (type === 'popstate') pops.push(fn); else w.events[type] = fn; };
  w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
  w.depth = () => entries.length - 1; w.idx = () => idx;
  w.window = w;
  return w;
}
function loadSheetBack() {
  assert.ok(SB, 'frontend/js/reviewer-sheet-back.js 가 있어야 한다');
  const w = fakeWindow();
  vm.runInNewContext(SB, w);
  assert.ok(w.RhSheetBack, 'window.RhSheetBack 이 있어야 한다');
  return w;
}
function sheet(w, id) {
  const s = { id, open: false, closes: 0 };
  s.show = () => { s.open = true; w.RhSheetBack.opened(id, s.hide); };
  s.hide = () => { if (!s.open) return; s.open = false; s.closes++; w.RhSheetBack.closed(id); };
  return s;
}

test('VM 뒤로가기 = 맨 위 창 하나만 닫는다 · 항목은 창 하나에 한 칸 · 같은 창 다시 열기는 안 쌓는다', async () => {
  const w = loadSheetBack(); const a = sheet(w, 'a'), b = sheet(w, 'b');
  a.show(); assert.equal(w.depth(), 1); a.show(); assert.equal(w.depth(), 1, '같은 창 재열기(내용만 바꿈)는 칸을 더 쌓지 않는다');
  b.show(); assert.equal(w.depth(), 2, '겹친 창');
  w.history.back(); await tick();
  assert.deepEqual([a.open, b.open], [true, false], '뒤로가기 한 번 = 위 창만');
  w.history.back(); await tick();
  assert.deepEqual([a.open, b.open], [false, false]);
  assert.equal(w.left, 0, '창을 닫는 동안 페이지를 떠나지 않는다');
  w.history.back(); await tick();
  assert.equal(w.left, 1, '창이 없으면 뒤로가기는 그대로 나간다');
  assert.equal(a.closes + b.closes, 2, '닫기는 창마다 한 번(두 번 닫기 없음)');
});

test('VM 단추로 닫으면 쌓은 칸을 조용히 되돌린다 → 다음 뒤로가기 한 번에 나간다', async () => {
  const w = loadSheetBack(); const a = sheet(w, 'a');
  a.show(); a.hide(); await tick();
  assert.equal(w.idx(), 0, '쌓은 칸 소비');
  assert.equal(a.closes, 1);
  w.history.back(); await tick();
  assert.equal(w.left, 1, '한 번 눌러 나간다(두 번 아님)');
});

test('VM 닫자마자 다른 창을 열면(경고→참여상품, 참여상품→1:1 대화) 칸을 되돌리지 않고 이어 쓴다', async () => {
  const w = loadSheetBack(); const a = sheet(w, 'a'), b = sheet(w, 'b');
  a.show(); a.hide(); b.show(); await tick();
  assert.equal(w.idx(), 1); assert.equal(w.depth(), 1, '칸 하나만');
  assert.equal(b.open, true, '새 창이 되돌리기에 닫히지 않는다');
  w.history.back(); await tick();
  assert.equal(b.open, false); assert.equal(w.left, 0);
  w.history.back(); await tick(); assert.equal(w.left, 1);
});

test('VM 창을 연 채 다른 화면으로 이동(leave) — 되돌리기와 겹치지 않고 창 칸을 그 주소로 바꾼다', async () => {
  const w = loadSheetBack(); const a = sheet(w, 'a');
  a.show(); a.hide(); w.RhSheetBack.leave('/search'); await tick();
  assert.equal(w.replaced, '/search', '창 칸을 이동할 주소로 교체');
  assert.equal(w.idx(), 1, '이동 중에 뒤로가기를 부르지 않는다');
  const w2 = loadSheetBack(); w2.RhSheetBack.leave('/search');
  assert.equal(w2.navigated, '/search', '창이 없던 때는 보통 이동(교체 아님)');
});

test('VM 새로고침 뒤 남은 창 칸 위에서도 뒤로가기가 새 창을 닫는다', async () => {
  const w = fakeWindow(); w.history.replaceState({ rhSheetDepth: 1 }); // 창을 연 채 새로고침한 칸
  vm.runInNewContext(SB, w); const a = sheet(w, 'a');
  a.show(); w.history.back(); await tick();
  assert.equal(a.open, false, '기준 칸이 0이 아니어도 위 창을 닫는다');
});

test('VM 창을 연 채 새로고침한 뒤 창 없는 칸에서 뒤로가기 — 헛 칸을 건너 한 번에 떠난다 · 되돌리기는 건너뛰지 않는다', async () => {
  const w = fakeWindow(); w.history.pushState({ rhSheetDepth: 1 }); // 이전 화면에서 창을 연 채 새로고침: [기본, 창 칸] 위에 있음
  vm.runInNewContext(SB, w);
  w.history.back(); await tick(); await tick();
  assert.equal(w.left, 1, '아무것도 안 닫는 뒤로가기는 한 번 더 뒤로(헛 누름 없음)');
  const w2 = loadSheetBack(); const a = sheet(w2, 'a');
  a.show(); a.hide(); await tick(); await tick();
  assert.equal(w2.left, 0, '단추로 닫은 뒤 되돌리기가 페이지를 떠나게 하지 않는다');
  assert.equal(w2.idx(), 0);
});

test('VM 화면 배선 — 창 7종이 열 때 opened·닫을 때 closed 를 부른다 · 리뷰 제출 이동은 leave', () => {
  const pairs = [
    ['openPartInfoSheet', 'closePartInfo', 'partInfo'],
    ['openReviewEditModal', 'closeReviewEditModal', 'reEdit'],
    ['_orwPaint', 'closeOverdueReviewWarning', 'overdueWarning'],
    ['_ifnShowIfReady', 'closeIdentityFoldNotice', 'identityFold'],
    ['openOnboard', 'closeOnboard', 'guide'],
  ];
  for (const [open, close, id] of pairs) {
    assert.match(fnSrc(HOME, open), new RegExp("_rhSheetOpened\\('" + id + "', " + close + '\\)'), open);
    assert.match(fnSrc(HOME, close), new RegExp("_rhSheetClosed\\('" + id + "'\\)"), close);
  }
  assert.match(fnSrc(HOME, 'goToSubmit'), /_rhSheetLeave\('\/search'\)/);
  assert.match(HOME, /<script src="js\/reviewer-sheet-back\.js\?v=[^"]+"><\/script>/);
  assert.match(HOME, /<script src="js\/reviewer-cs\.js\?v=[^"]+"><\/script>/, '대화창 파일도 새로 받게');
  assert.match(fnSrc(CS, 'openChat'), /sheetBack\('opened', 'csChat', backToInbox\)/);
  assert.match(fnSrc(CS, 'closeAll'), /sheetBack\('closed', 'csChat'\)/);
  assert.match(fnSrc(CS, 'viewImage'), /sheetBack\('opened', 'csImage'/);
  // 옛 화면 파일과 섞여도 깨지지 않게 — 도우미가 없으면 아무 일도 안 한다
  for (const fn of ['_rhSheetOpened', '_rhSheetClosed', '_rhSheetLeave']) assert.match(fnSrc(HOME, fn), /window\.RhSheetBack/);
  assert.match(fnSrc(CS, 'sheetBack'), /window\.RhSheetBack/);
  assert.doesNotMatch(fnSrc(HOME, 'switchTab'), /pushState|_rhSheetOpened/, '하단 탭 전환은 히스토리에 쌓지 않는다');
});

/* ── ① 미제출 경고 ── */
function warningSandbox({ session = new Map(), local = new Map(), item } = {}) {
  const start = HOME.indexOf('const _INTERNAL_KEY_RE');
  const end = HOME.indexOf("let _mcItems = [], _mcTargetId = '';", start);
  assert.ok(start >= 0 && end > start);
  const el = () => { const c = new Set(); return { textContent: '', attributes: {}, classList: { add: n => c.add(n), remove: n => c.delete(n), contains: n => c.has(n) }, setAttribute(k, v) { this.attributes[k] = v; }, querySelector: () => ({ focus() {} }) }; };
  const els = { overdueReviewWarning: el(), orwElapsed: el(), orwTaskName: el(), orwSubmittedAt: el() };
  const calls = [];
  const store = m => ({ getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) });
  const ctx = vm.createContext({
    console, Date, Intl, Math, Number, String, isNaN, JSON,
    API_BASE_URL: 'https://virtual.invalid',
    document: { getElementById: id => els[id] || null },
    requestAnimationFrame: cb => cb(),
    fetch: async (url) => { calls.push(url); return { status: 200, ok: true, json: async () => ({ ok: true, item: item === undefined ? { displayName: '가상 작업', elapsedDays: 12 } : item }) }; },
    getSavedUser: () => null, _refreshReviewerHomeSession: async () => null,
    localStorage: store(local), sessionStorage: store(session),
    window: {},
  });
  vm.runInContext(HOME.slice(start, end), ctx);
  const load = async (user) => { vm.runInContext('_orwRequested = false; _orwItem = null; closeOverdueReviewWarning();', ctx); await vm.runInContext('loadOverdueReviewWarning', ctx)(user); return els.overdueReviewWarning.classList.contains('on'); };
  return { ctx, els, calls, load, session, local };
}
const U = (o = {}) => ({ name: '가상 리뷰어', phone8: '00001111', reviewerToken: 't', loginAt: 1000, ...o });

test('VM 미제출 경고 — 같은 탭·같은 로그인·같은 날 두 번째부터는 안 뜨고(조회도 안 함) · 새 로그인·새 탭엔 다시', async () => {
  const session = new Map();
  const s1 = warningSandbox({ session });
  assert.equal(await s1.load(U()), true, '첫 화면에서 뜬다');
  assert.equal(await s1.load(U()), false, '새로고침·다른 화면 갔다 오기(같은 탭) → 안 뜬다');
  assert.equal(s1.calls.length, 1, '두 번째는 서버 조회도 안 한다');
  assert.equal(await s1.load(U({ loginAt: 2000 })), true, '새로 로그인하면 다시 뜬다');
  assert.equal(await s1.load(U({ phone8: '22223333' })), true, '다른 리뷰어는 따로');
  assert.equal(s1.local.size, 0, '오래 남는 숨김 기록(localStorage) 없음');
  const fresh = warningSandbox();
  assert.equal(await fresh.load(U()), true, '새 탭(세션 저장소 비어 있음) → 다시 뜬다');
  const noItem = warningSandbox({ item: null });
  assert.equal(await noItem.load(U()), false);
  assert.equal(noItem.session.size, 0, '띄운 적 없으면 기록도 안 남긴다');
});

test('VM 미제출 경고 — 날짜가 바뀌면 다시 · 저장소를 못 쓰거나 phone8 이 없으면 숨기지 않고 보여준다', async () => {
  const session = new Map();
  const s = warningSandbox({ session });
  assert.equal(await s.load(U()), true);
  for (const k of session.keys()) session.set(k, session.get(k).replace(/\d{4}-\d{2}-\d{2}/, '2000-01-01'));
  assert.equal(await s.load(U()), true, '어제 본 기록이면 오늘 다시 뜬다');
  const broken = warningSandbox();
  broken.ctx.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(await broken.load(U()), true);
  assert.equal(await broken.load(U()), true, '기록을 못 남기면 모른다 → 보여준다(fail-open, 종전과 같음)');
  const nophone = warningSandbox();
  assert.equal(await nophone.load({ reviewerToken: 't' }), true);
  assert.equal(await nophone.load({ reviewerToken: 't' }), true);
});

test('VM 미제출 경고 — 경과일은 서버 값 그대로(10 하한 사본 없음) · 값이 없으면 날짜 수를 빼고 말한다', async () => {
  for (const [days, text] of [[3, '리뷰 미제출 · 3일 경과'], [12, '리뷰 미제출 · 12일 경과'], [undefined, '리뷰 미제출'], [null, '리뷰 미제출'], ['abc', '리뷰 미제출'], [0, '리뷰 미제출']]) {
    const s = warningSandbox({ item: { displayName: 'x', elapsedDays: days } });
    await s.load(U());
    assert.equal(s.els.orwElapsed.textContent, text, String(days));
  }
  assert.doesNotMatch(fnSrc(HOME, '_orwPaint'), /Math\.max\(10/);
  assert.match(HOME, /<span id="orwElapsed">리뷰 미제출<\/span>/, '정적 기본 문구에도 10일 사본 없음');
});

/* ── ③ 배너는 홈 탭에서만 ── */
test('VM 광고 배너 — 홈 탭에서만 보이고, 배너가 없으면 홈에서도 숨김 · 늦게 온 응답도 지금 탭을 따른다', async () => {
  const el = (id) => ({ id, style: { display: '' }, dataset: {}, innerHTML: '', classList: { add() {}, remove() {} } });
  const els = { reviewerHomeBanner: el('reviewerHomeBanner'), sectionProfile: el('p'), sectionReviewList: el('r'), sectionRecruit: el('rc'), sectionNews: el('n'), sectionCsInbox: el('c'), greetingText: el('g') };
  let bannerJson = { ok: true, banner: { imageUrl: 'https://img.example/a.png', clickUrl: 'https://ad.example/' } };
  let release;
  const ctx = vm.createContext({
    document: { getElementById: id => els[id] || null, querySelectorAll: () => [], querySelector: () => null },
    window: { scrollTo() {} }, getSavedUser: () => null, loadReviewList() {}, loadCsInbox() {}, _saveReviewerHomeView() {},
    escHtml: s => String(s), API_BASE_URL: '',
    fetch: () => new Promise(r => { release = () => r({ json: async () => bannerJson }); }),
  });
  vm.runInContext("let _currentTab = 'all'; let _mcItems = [];" + fnSrc(HOME, '_rhSyncHomeOnly') + fnSrc(HOME, 'switchTab') + fnSrc(HOME, 'loadReviewerHomeBanner') + ';this.sw=switchTab;this.lb=loadReviewerHomeBanner;', ctx);
  const b = els.reviewerHomeBanner;
  const p = ctx.lb(); ctx.sw('my'); release(); await p;
  assert.equal(b.style.display, 'none', '내정보 탭에 있을 때 늦게 온 배너는 숨김');
  ctx.sw('home'); assert.equal(b.style.display, '', '홈으로 오면 보인다');
  for (const t of ['review', 'cs', 'my']) { ctx.sw(t); assert.equal(b.style.display, 'none', t); }
  bannerJson = { ok: true, banner: null };
  ctx.sw('home'); const p2 = ctx.lb(); release(); await p2;
  assert.equal(b.style.display, 'none', '배너가 없으면 홈에서도 숨김(종전과 같음)');
  ctx.sw('my'); ctx.sw('home'); assert.equal(b.style.display, 'none', '없는 배너를 탭 전환이 되살리지 않는다');
});

/* ── ④ ⑤ 내정보 단추·계좌 줄 ── */
test('VM 내정보 작은 단추는 누르는 자리 28px 이상 · 예금주·은행 이름은 줄바꿈 금지 조각', () => {
  const rule = sel => { const m = new RegExp('\\n\\s*' + sel.replace(/[.:]/g, c => '\\' + c) + '\\s*\\{([^}]*)\\}').exec(HOME); assert.ok(m, sel); return m[1]; };
  // 보이는 알약 = 글자 12px + 위아래 5px = 22px, 누르는 자리 = ::after 로 위아래 4px 씩 더 = 30px (실제 값은 브라우저 검사가 잰다)
  for (const sel of ['.pf-edit', '.pf-eye']) {
    const r = rule(sel);
    assert.match(r, /position:\s*relative/, sel);
    assert.match(r, /font-size:\s*\.75rem/, sel);
    assert.match(r, /padding:\s*5px/, sel);
  }
  assert.match(rule('.pf-edit::after, .pf-eye::after'), /content:\s*""[\s\S]*position:\s*absolute[\s\S]*inset:\s*-4px/);
  const ctx = { document: { getElementById: id => ctx.els[id] }, els: { pfBankLine: { classList: { remove() {}, add() {} }, innerHTML: '' }, btnAddBankInfo: {} }, escHtml: s => String(s) };
  vm.runInNewContext(fnSrc(HOME, 'renderBankInfo') + ';renderBankInfo("예시은행","000-00-0000","김예시");', ctx);
  assert.match(ctx.els.pfBankLine.innerHTML, /<span class="pf-keep">예시은행<\/span>/);
  assert.match(ctx.els.pfBankLine.innerHTML, /<span class="pf-keep">김예시<\/span>/);
  assert.match(rule('.pf-keep'), /white-space:\s*nowrap/);
  const sub = fnSrc(HOME, 'renderInlineSubList');
  assert.match(sub, /if \(sub\.bankName\) bankParts\.push\('<span class="pf-keep">'/, '타계정 계좌 줄도 같은 규칙');
  assert.match(sub, /if \(sub\.accountHolder\) bankParts\.push\('<span class="pf-keep">'/);
  assert.match(rule('.pf-v'), /min-width:\s*0/, '좁은 화면에서 [저장] 단추가 칸 밖으로 밀리지 않게');
});

/* ════ 실제 브라우저(실 http 오리진 + 가짜 API) ════ */
const FAKE_ITEM = { sheetId: 'sh_a', tabName: '탭A', gid: '0', rowIndex: 3, startDate: '11/05', displayName: '가상 탈취제', productName: '', isSubmitted: false, isPaid: false, isOrderPending: false, recipientName: '가상 리뷰어', row: { '수취인': '가상 리뷰어' } };
function fakeJwt() { const b = o => Buffer.from(JSON.stringify(o)).toString('base64url'); return b({ alg: 'HS256' }) + '.' + b({ exp: Math.floor(Date.now() / 1000) + 86400 }) + '.x'; }
function api(p, overdue) {
  switch (p) {
    case '/api/reviewer/overdue-review-warning': return overdue ? { ok: true, item: { ...FAKE_ITEM, elapsedDays: 14, submittedAt: new Date(Date.now() - 14 * 864e5).toISOString() } } : { ok: true, item: null };
    case '/api/reviewer/identity-fold-notice': return { ok: true, notice: null };
    case '/api/reviewer/home-banner': return { ok: true, banner: { imageUrl: 'http://127.0.0.1/fake.svg', clickUrl: 'https://ad.example/' } };
    case '/api/reviewer/participations': return { ok: true, mode: 'legacy' };
    case '/api/search': return { ok: true, results: [FAKE_ITEM] };
    case '/api/reviewer/profile': return { ok: true, profile: { name: '가상 리뷰어', phone: '01000001111', bankName: '가상은행', bankAccount: '000000-00-000000', accountHolder: '김예시', subAccounts: [] } };
    case '/api/reviewer/profile/secure': return { ok: true, profile: { identities: [{ type: 'self', identityKey: 'self', shoppingId: '' }] } };
    case '/api/reviewer/notices': return { ok: true, notices: [] };
    case '/api/campaign/list': return { ok: true, data: [] };
    case '/api/reviewer/cs/threads': return { ok: true, threads: [] };
    case '/api/reviewer/cs/unread': return { ok: true, totalUnread: 0 };
    case '/api/reviewer/cs/messages': return { ok: true, threadId: null, messages: [] };
    case '/api/review-edit/participation-brief': return { ok: true, brief: { productLines: '가상 상품' } };
    case '/api/review-edit/my-files': return { ok: true, files: [], pending: [] };
    case '/api/reviewer/purchase-captures': return { ok: true, items: [], hasMore: false };
    case '/api/reviewer/my-missing-captures': return { ok: true, items: [] };
    default: return { ok: true };
  }
}
async function home(fn, { engine = 'chromium', width = 390, overdue = false } = {}) {
  const fe = path.join(root, 'frontend');
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/search') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end('<!doctype html><meta charset="utf-8"><title>search</title><p>가짜 제출 화면</p>'); }
    if (p === '/start.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end('<!doctype html><meta charset="utf-8"><title>start</title><p>이전 페이지</p>'); }
    if (p === '/fake.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="240"><rect width="1080" height="240" fill="#fc8"/></svg>'); }
    if (p.startsWith('/api/')) { res.setHeader('Content-Type', p === '/api/reviewer/cs/events' ? 'text/event-stream' : 'application/json'); return res.end(p === '/api/reviewer/cs/events' ? 'retry: 3600000\n\n' : JSON.stringify(api(p, overdue))); }
    const file = path.join(fe, p === '/' ? 'index.html' : p);
    if (!file.startsWith(fe)) { res.statusCode = 403; return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript');
      res.end(buf);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw[engine].launch({ executablePath: pw[engine].executablePath() });
  try {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
    await ctx.route('**/*', route => { const u = new URL(route.request().url()); return u.origin === origin ? route.continue() : route.abort(); });
    await ctx.addInitScript(({ user }) => {
      window.REVIEW_API_URL = location.origin;
      if (!localStorage.getItem('iad_reviewer_user')) { localStorage.setItem('iad_reviewer_user', JSON.stringify(user)); localStorage.setItem('inad_onboarded', '1'); }
    }, { user: { name: '가상 리뷰어', phone: '010-0000-1111', phone8: '00001111', reviewerToken: fakeJwt(), loginAt: 1700000000000 } });
    const page = await ctx.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(origin + '/start.html');
    await page.goto(origin + '/index.html');
    await page.locator('#viewHome').waitFor();
    await fn(page, { origin, errors });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
}
const onHome = async (page) => { assert.match(page.url(), /\/index\.html$/); assert.equal(await page.locator('#viewHome').isVisible(), true); };
const isOn = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!(e && (e.classList.contains('on') || (e.style.display && e.style.display !== 'none')) && getComputedStyle(e).display !== 'none'); }, sel);
// 창을 연다(돌아오는 약속을 붙잡지 않게 중괄호로 감싼다)
const openPart = page => page.evaluate(() => { openPartInfoSheet([window.__item || { sheetId: 'sh_a', tabName: '탭A', rowIndex: 3, startDate: '11/05', displayName: '가상 탈취제', row: {} }], { done: false }); });

for (const engine of ['chromium', 'webkit']) {
  test(`${engine} 뒤로가기 = 창 닫기(홈에 남음) · 단추로 닫은 뒤엔 한 번에 나감 · 두 창 잇달아`, () => home(async (page, { origin }) => {
    await openPart(page); assert.equal(await isOn(page, '#partInfoOvl'), true);
    await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(250);
    assert.equal(await isOn(page, '#partInfoOvl'), false, '뒤로가기로 창이 닫힌다'); await onHome(page);
    // 단추로 닫기 → 뒤로가기 한 번 = 이전 페이지
    await openPart(page); await page.locator('#partInfoOvl .re-edit-x').click(); await page.waitForTimeout(250);
    await onHome(page);
    // 두 창 잇달아: 참여상품 정보 → 단추로 닫고 → 가이드 열기 → 뒤로가기 = 가이드만 닫힘
    await openPart(page); await page.locator('#partInfoOvl .re-edit-x').click();
    await page.evaluate(() => { openOnboard(); }); assert.equal(await isOn(page, '#onboard'), true);
    await page.waitForTimeout(250);
    await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(250);
    assert.equal(await isOn(page, '#onboard'), false); await onHome(page);
    // 참여상품 정보 → [1:1 문의하기](닫고 대화창 열기) → 뒤로가기 = 대화창만 닫힘, 홈에 남음
    await openPart(page); await page.evaluate(() => { _partInfoCsCtx = { campaignKey: 'sh_a||탭A', campaignLabel: '가상' }; _partInfoOpenCs(); });
    await page.locator('#rcsOverlay').waitFor();
    await page.waitForTimeout(250);
    await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(250);
    assert.equal(await isOn(page, '#rcsOverlay'), false, '대화창 닫힘'); assert.equal(await isOn(page, '#partInfoOvl'), false); await onHome(page);
    // 남은 칸 없음: 한 번 더 누르면 바로 이전 페이지
    await page.goBack(); await page.waitForURL(origin + '/start.html');
  }, { engine }));

  test(`${engine} 창을 연 채 새로고침 → 뒤로가기 한 번에 이전 페이지`, () => home(async (page, { origin }) => {
    await page.evaluate(() => { openOnboard(); }); await page.waitForTimeout(150);
    await page.reload(); await page.locator('#viewHome').waitFor(); await page.waitForTimeout(400);
    await page.goBack({ waitUntil: 'commit' }).catch(() => {});
    await page.waitForURL(origin + '/start.html');
  }, { engine }));

  test(`${engine} 창 안 [리뷰 제출하기]로 다른 화면 이동 — 이동이 취소되지 않고, 돌아와서 뒤로가기 한 번에 나간다`, () => home(async (page, { origin }) => {
    await openPart(page);
    await page.evaluate(() => { _partInfoSubmit(0); });
    await page.waitForURL(u => /\/search(\.html)?$/.test(new URL(u).pathname));
    await page.waitForTimeout(300);
    assert.match(new URL(page.url()).pathname, /^\/search/, '되돌리기가 이동을 취소하지 않는다');
    await page.goBack(); await page.waitForURL(origin + '/index.html'); await page.locator('#viewHome').waitFor();
    assert.equal(await isOn(page, '#partInfoOvl'), false);
    await page.goBack(); await page.waitForURL(origin + '/start.html');
  }, { engine }));

  test(`${engine} 미제출 경고 — 뒤로가기로 닫힘 · 같은 탭 새로고침엔 다시 안 뜸 · 경과일 서버 값`, () => home(async (page) => {
    await page.locator('#overdueReviewWarning.on').waitFor();
    assert.equal(await page.locator('#orwElapsed').innerText(), '리뷰 미제출 · 14일 경과');
    await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(250);
    assert.equal(await isOn(page, '#overdueReviewWarning'), false); await onHome(page);
    await page.reload(); await page.locator('#viewHome').waitFor(); await page.waitForTimeout(800);
    assert.equal(await isOn(page, '#overdueReviewWarning'), false, '같은 탭·같은 날 두 번째 화면에선 안 뜬다');
  }, { engine, overdue: true }));

  for (const width of [320, 390]) {
    test(`${engine} ${width} 배너는 홈에서만 · 내정보는 로그아웃이 맨 끝 · 작은 단추 28px · 예금주 한 줄`, () => home(async (page) => {
      await page.locator('#reviewerHomeBanner img').waitFor();
      assert.equal(await page.locator('#reviewerHomeBanner').isVisible(), true);
      for (const t of ['review', 'cs', 'my']) { await page.evaluate(x => { switchTab(x); }, t); assert.equal(await page.locator('#reviewerHomeBanner').isVisible(), false, t); }
      await page.locator('#pfBankLine .pf-keep').first().waitFor();
      const m = await page.evaluate(() => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
        scrollTo(0, document.body.scrollHeight);
        const logout = [...document.querySelectorAll('#sectionProfile button')].filter(b => /로그아웃/.test(b.textContent) && vis(b)).pop();
        const lb = logout.getBoundingClientRect().bottom + scrollY;
        const below = [...document.querySelectorAll('#viewHome *')].filter(e => vis(e) && !e.closest('.tabbar') && getComputedStyle(e).position !== 'fixed' && e.getBoundingClientRect().top + scrollY > lb + 1 && !e.closest('#sectionProfile')).map(e => (e.id || e.className || e.tagName) + ':' + (e.textContent || '').trim().slice(0, 20));
        // 누르는 자리 = 단추 가운데 세로줄에서 elementFromPoint 가 그 단추를 돌려주는 높이
        const btns = [...document.querySelectorAll('#sectionProfile .pf-edit, #sectionProfile .pf-eye')].filter(vis).map(b => {
          b.scrollIntoView({ block: 'center' });
          const r = b.getBoundingClientRect(); const x = r.left + r.width / 2; let hit = 0;
          for (let y = Math.floor(r.top) - 12; y <= Math.ceil(r.bottom) + 12; y++) { const e = document.elementFromPoint(x, y); if (e && e.closest('.pf-edit, .pf-eye') === b) hit++; }
          return hit;
        });
        scrollTo(0, document.body.scrollHeight);
        const holder = [...document.querySelectorAll('#pfBankLine .pf-keep')].map(s => s.getClientRects().length);
        const spill = [...document.querySelectorAll('#sectionProfile .pf-edit')].filter(vis).filter(b => b.getBoundingClientRect().right > b.closest('.pf-ln, .pf-v, div').getBoundingClientRect().right + 0.5 || b.getBoundingClientRect().right > b.closest('.pf-ln').getBoundingClientRect().right + 0.5).map(b => b.textContent);
        return { below, btns, holder, spill, sw: document.documentElement.scrollWidth };
      });
      assert.deepEqual(m.below, [], '로그아웃 아래에 보이는 것이 없어야 한다');
      assert.ok(m.btns.length >= 3 && m.btns.every(h => h >= 28), '작은 단추 높이 ' + m.btns);
      assert.ok(m.holder.length === 2 && m.holder.every(n => n === 1), '은행·예금주 이름이 한 줄 ' + m.holder);
      assert.ok(m.sw <= width, '옆으로 밀림 ' + m.sw);
      assert.deepEqual(m.spill, [], '단추가 줄 밖으로 밀려나지 않는다');
      await page.evaluate(() => { switchTab('home'); });
      assert.equal(await page.locator('#reviewerHomeBanner').isVisible(), true, '홈으로 오면 다시 보인다');
    }, { engine, width }));
  }
}
