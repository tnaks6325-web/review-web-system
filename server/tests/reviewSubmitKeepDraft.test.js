'use strict';
/* 결정 413 — 리뷰 제출 화면: 새로고침해도 같은 건의 제출 화면으로 돌아오고, 넣은 사진·쓴 비고를 말없이 버리지 않으며,
 *            휴대폰 [뒤로]는 열린 창만 닫는다(리뷰어 홈 도우미 RhSheetBack 그대로).
 *
 * 사고(리뷰 제출 점검 2026-11-24 M4 · L1):
 *   M4 리뷰어 홈이 넘긴 대상(sessionStorage iad_direct_submit_items)을 제출 화면이 읽자마자 지워, 새로고침하면 대상이 없어
 *      리뷰어 홈으로 튕겼다(넣은 사진·쓴 비고는 안내 없이 사라짐). 위쪽 [←]도 묻지 않고 바로 홈(location.href='/').
 *   L1 이 화면엔 휴대폰 [뒤로] 처리가 없었다 — 「이미 제출했던 사진이에요」 창을 연 채 [뒤로]면 사진째 홈으로,
 *      [←] 로 홈에 간 뒤 [뒤로]는 제출 화면 → 다시 홈으로 튕겨 「뒤로가 안 먹는다」처럼 보였다.
 *
 * search-app.js 의 **실제 함수 본문**(옛 입구 그대로: 첫 화면 문지기 블록 · _restoreReviewerSession · backToSearch ·
 * renderPreviews · removeFile · _showDuplicateBlockModal · submitReview · goToReviewerMain)과 **진짜 도우미 파일**을 vm 에서 돌리고,
 * 가짜 브라우저(방문 기록 칸 · 비동기 go · popstate · 다른 문서로 가면 「떠남」 · replace/assign · sessionStorage 공유 새로고침)로 센다.
 * 새 도우미가 없으면(옛 코드) 건너뛰지 않고 **행동으로** 실패한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const SA = fs.readFileSync(path.join(ROOT, 'frontend/js/search-app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'frontend/search.html'), 'utf8');
const HELPER = fs.readFileSync(path.join(ROOT, 'frontend/js/reviewer-sheet-back.js'), 'utf8');
const ORIGIN = 'https://review-web-system.pages.dev';
const HOME = ORIGIN + '/';
const PAGE = ORIGIN + '/search';

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
function fn(name) {
  let i = SA.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = SA.indexOf('\nasync function ' + name + '(');
  if (i < 0) return '';
  i += 1;
  return SA.slice(i, braceEnd(SA, SA.indexOf('{', SA.indexOf(')', i))) + 1);
}
const rvHelpers = [...SA.matchAll(/^(?:async )?function (_rv[A-Z]\w*)\(/gm)].map((m) => m[1]);
/** 첫 화면 문지기(DOMContentLoaded 안 「일반 진입은 리뷰어 홈으로」 블록) — 실제 본문을 함수로 감싸 돌린다. */
function gateSrc() {
  const a = SA.indexOf('  const _hasAdminSession = ');
  const b = SA.indexOf('  // 일반 모드: 검색 화면 활성화', a);
  assert.ok(a > 0 && b > a, '첫 화면 문지기 블록');
  return 'function __gate() {\n' + SA.slice(a, b) + '\n  return "stay";\n}';
}
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const store = (m = {}) => ({ m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } });
const ITEM_A = { sheetId: 'sh', tabName: '탭A', gid: '1', rowIndex: 5, recipientName: '김예시', displayName: '김예시', productName: '라벤더향', row: {} };
const ITEM_B = { sheetId: 'sh', tabName: '탭A', gid: '1', rowIndex: 6, recipientName: '김예시', displayName: '김예시', productName: '무향', row: {} };
const PHOTO = (t) => ({ b64: 'QUFB' + t, size: 1000, type: 'image/jpeg', name: t + '.jpg', file: {} });

/**
 * 리뷰어 홈(index) → 제출 화면(/search)으로 들어온 상태. ss = 같은 탭의 sessionStorage(새로고침이면 넘겨 준다).
 * entries 를 주면 그 방문 기록(새로고침 = 지금 칸 그대로 다시 불러옴)에서 시작한다.
 */
function world({ ss, sess = { name: '김예시', phone8: '00000000', reviewerToken: 't' }, handoff = null, helper = true,
  framed = false, entries = null, idx = null, answer = true, post = null } = {}) {
  ss = ss || store();
  if (handoff) ss.setItem('iad_direct_submit_items', JSON.stringify(handoff));
  const B = { entries: entries ? entries.map(clone) : [{ doc: 'other', url: ORIGIN + '/prev', state: null }, { doc: 'index', url: HOME, state: null }, { doc: 'search', url: PAGE, state: null }],
    idx: 0, left: null, how: '', listeners: {} };
  B.idx = idx == null ? B.entries.length - 1 : idx;
  B.entries[B.idx].doc = 'search';
  const log = { opened: [], searched: 0, toasts: [], confirms: [], uploads: 0, posts: 0 };
  const fire = (type, ev) => (B.listeners[type] || []).slice().forEach((f) => f(ev || {}));
  function traverse(n) {
    if (B.left) return;
    const t = Math.max(0, Math.min(B.entries.length - 1, B.idx + n));
    if (t === B.idx) return;
    B.idx = t;
    const e = B.entries[t];
    if (e.doc !== 'search') { B.left = e.url; B.how = 'back'; fire('pagehide'); return; }
    fire('popstate', { state: clone(e.state) });
  }
  const history = {
    get state() { return clone(B.entries[B.idx].state); },
    get length() { return B.entries.length; },
    pushState(st, _t, u) { if (B.left) return; B.entries.splice(B.idx + 1); B.entries.push({ doc: 'search', url: String(u || B.entries[B.idx].url), state: clone(st) }); B.idx++; },
    replaceState(st, _t, u) { if (B.left) return; const e = B.entries[B.idx]; B.entries[B.idx] = { doc: e.doc, url: String(u || e.url), state: clone(st) }; },
    go(n) { setTimeout(() => traverse(n), 0); },
    back() { this.go(-1); },
  };
  const location = {
    get href() { return B.entries[B.idx].url; },
    set href(u) { location.assign(u); },
    replace(u) { if (B.left) return; B.entries[B.idx] = { doc: 'other', url: new URL(String(u), PAGE).href, state: null }; B.left = B.entries[B.idx].url; B.how = 'replace'; fire('pagehide'); },
    assign(u) { if (B.left) return; B.entries.splice(B.idx + 1); B.entries.push({ doc: 'other', url: new URL(String(u), PAGE).href, state: null }); B.idx++; B.left = B.entries[B.idx].url; B.how = 'assign'; fire('pagehide'); },
    origin: ORIGIN, pathname: '/search', hash: '', search: '',
  };
  /* 작은 가짜 DOM */
  const reg = {};
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this._html = ''; this.value = ''; this.attrs = {};
      this.listeners = {}; this.className = ''; this.dataset = {}; this.disabled = false; this.textContent = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set id(v) { this._id = v; } get id() { return this._id; }
    set innerHTML(v) { this._html = String(v); } get innerHTML() { return this._html; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    appendChild(c) { c.parentNode = this; this.children.push(c); if (c._id) reg[c._id] = c; return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); if (c._id) reg[c._id] = c; return c; }
    remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } if (reg[this._id] === this) delete reg[this._id]; }
    querySelector(sel) { if (sel === 'button') return this._btn || (this._btn = new El('button')); if (this._q) return this._q(sel); return null; }
    closest() { return null; }
    matches() { return false; }
    scrollIntoView() {}
    click() { this.clicks = (this.clicks || 0) + 1; (this.listeners.click || []).forEach((f) => f({ stopPropagation() {} })); }
  }
  const mk = (tag, id) => { const e = new El(tag); e.id = id; reg[id] = e; return e; };
  const body = mk('body', '__body');
  ['dzPlaceholder', 'dzPreview', 'memoTxt', 'imgInput', 'successModal', 'successMessage', 'btnSubmit', 'nameInput'].forEach((id) => mk('div', id));
  const dropZone = mk('div', 'dropZone'); dropZone._q = (sel) => (/file/.test(sel) ? reg.imgInput : null);
  reg.successModal.style.display = 'none';
  const docListeners = {};
  const document = {
    getElementById: (id) => reg[id] || null,
    createElement: (tag) => new El(tag),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    body, referrer: HOME,
  };
  const S = { selectedRow: null, selectedRows: [], filesByIdx: {}, memoByIdx: {}, files: [], filesBySlot: {}, captureSlots: null, step: 1, receiptStepMode: false };
  const sb = {
    console: { log() {}, warn() {}, error() {} }, URL, JSON, Math, Object, Array, Promise, String, Number, Set, Map, Error, Date, RegExp,
    setTimeout, clearTimeout, history, location, document, sessionStorage: ss, localStorage: store(),
    addEventListener(type, f) { (B.listeners[type] = B.listeners[type] || []).push(f); },
    removeEventListener(type, f) { B.listeners[type] = (B.listeners[type] || []).filter((x) => x !== f); },
    ADMIN_BYPASS_KEY: 'admin_bypass_until', API_BASE_URL: ORIGIN, APP_CONFIG: { GAS_WEB_APP_URL: ORIGIN + '/gas' },
    S,
    _getReviewerSession: () => sess, _loadAuthSession: () => sess, _applyLoginUI() {}, _revealBodyIfHidden() {},
    doSearch: async () => { log.searched++; },
    openSubmitMulti(items) { log.opened.push(items); S.selectedRows = items; S.selectedRow = items[0]; S.files = []; S.filesByIdx = {}; S.filesBySlot = {};
      items.forEach((_, i) => { if (items.length > 1 && !reg['mrMemo_' + i]) mk('textarea', 'mrMemo_' + i); }); },
    showToast: (m) => log.toasts.push(String(m)), show: (el, d) => { const e = typeof el === 'string' ? reg[el] : el; if (e) e.style.display = d || ''; },
    hide: (el) => { const e = typeof el === 'string' ? reg[el] : el; if (e) e.style.display = 'none'; },
    confirm: (m) => { log.confirms.push(String(m)); return typeof answer === 'function' ? answer(m) : answer; },
    escHtml: (s) => String(s), _duplicateHistoryLine: () => '11/20(목) 김예시 참여건에 제출된 리뷰캡처 입니다.', _ofFramePlace() {},
    _preCheckFiles() {}, _preCtx: () => ({}), _preAwaitChecks: async () => true, _preHasBlock: () => false, _preBlockedMessage: () => '',
    _reviewPhotoSendCheck: () => '', _isBlogItem: () => false, _isPostUrl: () => false, _BLOG_POST_URL_HINT: '',
    showLoading() {}, hideLoading() {}, goStep() {}, _updateReceiptStepActions() {}, _clearSearchCache() {},
    extractProductOption: () => ({ options: [] }), _ofFriendlyErr: (e, d) => d, apiFriendlyErrorMessage: (e, d) => d,
    gasPostUpload: async (p) => { log.uploads++; return { ok: true, uploadBatchId: 'b' + log.uploads, files: p.files.map((f, i) => ({ fileId: 'f' + i })) }; },
    gasPost: async (p) => { log.posts++; return post ? post(p, log.posts) : { ok: true }; },
    resetOrderFormForReentry() {}, _syncReviewerHomeSessionForReturn() {},
  };
  sb.window = sb;
  sb.parent = framed ? {} : sb;
  vm.createContext(sb);
  if (helper) vm.runInContext(HELPER, sb, { filename: 'reviewer-sheet-back.js' });
  const names = ['_consumeDirectSubmitItems', '_restoreReviewerSession', 'backToSearch', 'goToReviewerMain', '_showDuplicateBlockModal',
    'renderPreviews', 'removeFile', 'submitReview', ...rvHelpers];
  vm.runInContext('var _authState = null, _preSubmitGen = 0;\n' + gateSrc() + '\n' + [...new Set(names)].map(fn).filter(Boolean).join('\n')
    + '\nthis.__has = (n) => typeof globalThis[n] === "function";', sb, { filename: 'search-app.js#keep' });
  const run = (code) => vm.runInContext(code, sb);
  /** 페이지 열기 = 첫 화면 문지기 → (남으면) 리뷰어 세션 복원. */
  async function boot() {
    const g = run('__gate()');
    if (g === 'stay' && !B.left) await run('_restoreReviewerSession()');
    await settle();
  }
  const typeMemo = (v, id = 'memoTxt') => { reg[id].value = v; (docListeners.input || []).forEach((f) => f({ target: reg[id] })); };
  const addPhoto = (t) => { S.files.push(PHOTO(t)); run('renderPreviews()'); };
  const back = async () => { traverse(-1); await settle(); };
  const unloadBlocks = () => (B.listeners.beforeunload || []).some((f) => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; const r = f(e); return e.prevented || typeof r === 'string'; });
  /** 새로고침 = 같은 탭 저장소·같은 방문 기록 칸에서 새 문서로 */
  const reload = (o = {}) => world({ ss, sess, helper, entries: B.entries, idx: B.idx, ...o });
  return { B, log, sb, run, reg, S, ss, boot, typeMemo, addPhoto, back, unloadBlocks, reload, docListeners };
}
const onSubmit = (w) => !w.B.left && w.log.opened.length > 0;

/* ═══ M4. 새로고침해도 같은 건 ═══ */
test('M4-1 홈에서 넘겨받아 연 제출 화면을 새로고침하면 같은 건의 제출 화면이 다시 열린다(리뷰어 홈으로 튕기지 않음)', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  assert.ok(onSubmit(w), '처음 열기');
  assert.equal(w.ss.getItem('iad_direct_submit_items'), null, '넘겨받음 신호는 종전처럼 바로 지운다(옛 홈·새 홈 공통 계약)');
  const r = w.reload();
  await r.boot();
  assert.equal(r.B.left, null, `★ 새로고침이 홈으로 튕기지 않는다 — 실제: ${r.B.how} ${r.B.left}`);
  assert.equal(r.log.opened.length, 1, '같은 제출 화면을 다시 연다');
  assert.equal(r.log.opened[0][0].rowIndex, 5, '같은 건(같은 주문 줄)');
  assert.equal(r.log.searched, 0, '옛 검색 화면으로 빠지지 않는다');
});

test('M4-2 쓴 비고는 새로고침 뒤에도 남고, 넣었던 사진은 지워졌으니 다시 넣으라고 알린다', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  w.typeMemo('배송이 빨랐어요');
  w.addPhoto('a');
  const r = w.reload();
  await r.boot();
  assert.ok(onSubmit(r), '같은 화면');
  assert.equal(r.reg.memoTxt.value, '배송이 빨랐어요', '★ 비고가 남는다');
  assert.equal(r.S.files.length, 0, '사진은 메모리에만 있어 새로고침을 넘지 못한다(그대로 인정)');
  assert.ok(r.log.toasts.some((t) => /사진을 다시 넣어/.test(t)), `사진 다시 넣기 안내 — 실제: ${JSON.stringify(r.log.toasts)}`);
  // 사진 없이 비고만 있었으면 사진 안내는 없다
  const r2 = r.reload();
  await r2.boot();
  assert.ok(!r2.log.toasts.some((t) => /사진을 다시 넣어/.test(t)), '사진이 없던 새로고침엔 사진 안내 없음');
  assert.equal(r2.reg.memoTxt.value, '배송이 빨랐어요');
});

test('M4-3 다른 리뷰어로 바뀌었거나 · 시간이 오래 지났거나 · 로그인이 없으면 다시 열지 않고 종전처럼 리뷰어 홈', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  const other = w.reload({ sess: { name: '이타계', phone8: '11112222', reviewerToken: 'u' } });
  await other.boot();
  assert.equal(other.log.opened.length, 0, '다른 사람 화면에 앞 사람 주문을 열지 않는다');
  assert.equal(other.B.how, 'replace'); assert.equal(other.B.left, HOME);
  assert.equal(other.ss.getItem('iad_direct_submit_keep_v1'), null, '남은 칸을 지운다');

  const w2 = world({ handoff: [ITEM_A] });
  await w2.boot();
  const k = JSON.parse(w2.ss.getItem('iad_direct_submit_keep_v1') || 'null');
  assert.ok(k, '이어서 보기 칸');
  k.at = Date.now() - 4 * 60 * 60 * 1000; w2.ss.setItem('iad_direct_submit_keep_v1', JSON.stringify(k));
  const old = w2.reload();
  await old.boot();
  assert.equal(old.log.opened.length, 0, '시간이 지난 칸은 열지 않는다'); assert.equal(old.B.left, HOME);

  const w3 = world({ handoff: [ITEM_A] });
  await w3.boot();
  const noLogin = w3.reload({ sess: null });
  await noLogin.boot();
  assert.equal(noLogin.log.opened.length, 0); assert.equal(noLogin.B.left, HOME, '로그인 없음 = 리뷰어 홈');
});

test('M4-4 제출이 성공하면 새로고침해도 제출 화면을 다시 열지 않는다(이미 낸 건을 또 내게 하지 않음)', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  w.addPhoto('a');
  await w.run('submitReview()'); await settle();
  assert.equal(w.reg.successModal.style.display, 'flex', '제출 완료 창');
  assert.equal(w.ss.getItem('iad_direct_submit_keep_v1'), null, '★ 성공하면 이어서 보기 칸을 지운다');
  const r = w.reload();
  await r.boot();
  assert.equal(r.log.opened.length, 0, '다시 열지 않는다'); assert.equal(r.B.left, HOME);
});

test('M4-5 새로 넘겨받으면 지난 건(이어서 보기 칸)은 버린다 — 다른 주문 카드를 눌렀을 때 앞 주문이 열리지 않는다', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  w.typeMemo('앞 주문 비고');
  const r = w.reload({ handoff: [ITEM_B] });
  await r.boot();
  assert.equal(r.log.opened[0][0].rowIndex, 6, '새로 넘긴 주문');
  assert.equal(r.reg.memoTxt.value, '', '앞 주문 비고를 새 주문에 붙이지 않는다');
});

/* ═══ M4. 떠나기 전 확인 ═══ */
test('M4-6 사진을 넣은 채 위쪽 [←] = 한 번 묻는다 · [취소]면 사진 그대로 남고 · [확인]이면 리뷰어 홈', async () => {
  const w = world({ handoff: [ITEM_A], answer: false });
  await w.boot();
  w.addPhoto('a');
  w.run('backToSearch()'); await settle();
  assert.equal(w.log.confirms.length, 1, `★ 묻는다 — 실제 이동: ${w.B.how} ${w.B.left}`);
  assert.match(w.log.confirms[0], /넣은 사진이 지워져요\. 나갈까요\?/);
  assert.equal(w.B.left, null, '[취소] = 남는다'); assert.equal(w.S.files.length, 1, '사진 그대로');
  w.sb.confirm = (m) => { w.log.confirms.push(m); return true; };
  w.run('backToSearch()'); await settle();
  assert.equal(w.B.left, HOME, '[확인] = 리뷰어 홈');
  assert.equal(w.ss.getItem('iad_direct_submit_keep_v1'), null, '스스로 나가면 이어서 보기 칸을 지운다');
});

test('M4-7 사진·비고가 없으면 [←]는 묻지 않고 홈 · 비고만 있으면 비고가 지워진다고 묻는다', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  w.run('backToSearch()'); await settle();
  assert.equal(w.log.confirms.length, 0); assert.equal(w.B.left, HOME);
  const v = world({ handoff: [ITEM_A], answer: false });
  await v.boot();
  v.typeMemo('비고만');
  v.run('backToSearch()'); await settle();
  assert.equal(v.log.confirms.length, 1); assert.match(v.log.confirms[0], /쓴 비고가 지워져요/); assert.equal(v.B.left, null);
});

test('M4-8 브라우저 자체 확인(beforeunload)은 사진이 있을 때만 — 사진을 빼거나 제출을 마치면 끈다', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  assert.equal(w.unloadBlocks(), false, '사진 없음 = 없음');
  w.typeMemo('비고');
  assert.equal(w.unloadBlocks(), false, '비고만 = 없음(비고는 새로고침을 넘는다)');
  w.addPhoto('a');
  assert.equal(w.unloadBlocks(), true, '★ 사진이 있으면 새로고침·탭 닫기 전에 브라우저가 묻는다');
  w.run('removeFile(0)');
  assert.equal(w.unloadBlocks(), false, '사진을 빼면 끈다');
  w.addPhoto('b');
  await w.run('submitReview()'); await settle();
  assert.equal(w.unloadBlocks(), false, '제출을 마치면 끈다');
});

/* ═══ L1. 휴대폰 [뒤로] ═══ */
test('L1-1 「이미 제출했던 사진이에요」 창을 연 채 [뒤로] = 그 창만 닫힌다(사진 그대로 · 화면에 남음) → 다음 [뒤로] = 떠나기 확인', async () => {
  const w = world({ handoff: [ITEM_A], answer: false });
  await w.boot();
  w.addPhoto('dup');
  w.run("_showDuplicateBlockModal({ fileId: 'f1', submittedAt: '2026-11-20T01:00:00Z' }, document.getElementById('dropZone'))");
  assert.ok(w.reg._reviewDuplicateBlockModal, '창이 열렸다');
  await w.back();
  assert.equal(w.B.left, null, `★ 화면을 떠나지 않는다 — 실제: ${w.B.left}`);
  assert.equal(w.reg._reviewDuplicateBlockModal, undefined, '그 창만 닫혔다');
  assert.equal(w.S.files.length, 1, '사진 그대로');
  assert.equal(w.reg.imgInput.clicks || 0, 0, '[뒤로]는 [다른 사진 선택]과 달리 사진 고르기를 열지 않는다');
  assert.equal(w.log.confirms.length, 0, '창을 닫을 땐 묻지 않는다');
  await w.back();
  assert.equal(w.log.confirms.length, 1, '다음 [뒤로] = 떠나기 확인'); assert.equal(w.B.left, null, '[취소] = 남는다');
  assert.equal(w.S.files.length, 1);
  w.sb.confirm = () => true;
  await w.back();
  assert.equal(w.B.left, HOME, '[확인] = 리뷰어 홈(들어온 칸)');
});

test('L1-2 같은 사진 창을 [다른 사진 선택]으로 닫으면 쌓은 칸을 되돌린다 — 그다음 [뒤로]는 창 없이 떠나기 확인 한 번', async () => {
  const w = world({ handoff: [ITEM_A], answer: true });
  await w.boot();
  w.addPhoto('dup');
  w.run("_showDuplicateBlockModal({ fileId: 'f1' }, document.getElementById('dropZone'))");
  w.reg._reviewDuplicateBlockModal._btn.click(); await settle();
  assert.equal(w.reg.imgInput.clicks, 1, '단추 = 사진 고르기 열기(종전 그대로)');
  await w.back();
  assert.equal(w.log.confirms.length, 1, '헛 누름 없이 바로 떠나기 확인');
  assert.equal(w.B.left, HOME);
});

test('L1-3 사진이 있을 때 휴대폰 [뒤로] = 한 번 묻기 · [취소]면 사진 그대로 화면에 남고 다시 [뒤로]도 묻는다', async () => {
  const w = world({ handoff: [ITEM_A], answer: false });
  await w.boot();
  w.addPhoto('a');
  await w.back();
  assert.equal(w.B.left, null, `★ 묻지 않고 떠나지 않는다 — 실제: ${w.B.left}`);
  assert.equal(w.log.confirms.length, 1); assert.equal(w.S.files.length, 1);
  await w.back();
  assert.equal(w.log.confirms.length, 2, '[취소] 뒤 다시 [뒤로]도 묻는다(확인 칸을 다시 세움)'); assert.equal(w.B.left, null);
  w.sb.confirm = () => true;
  await w.back();
  assert.equal(w.B.left, HOME);
  assert.equal(w.B.entries[w.B.idx].doc, 'index', '들어온 리뷰어 홈 칸으로 돌아간다(새 칸 아님)');
});

test('L1-4 사진이 없으면 휴대폰 [뒤로] = 바로 홈 · 그 홈에서 [뒤로]는 제출 화면으로 튕기지 않는다', async () => {
  const w = world({ handoff: [ITEM_A] });
  await w.boot();
  await w.back();
  assert.equal(w.B.left, HOME); assert.equal(w.log.confirms.length, 0);
  const before = w.B.entries[w.B.idx - 1];
  assert.notEqual(before && before.doc, 'search', '홈 뒤 칸은 제출 화면이 아니다');
});

test('L1-5 위쪽 [←]로 홈에 가면 새 칸을 쌓지 않는다 — 홈에서 [뒤로]가 제출 화면 → 홈으로 튕기지 않는다(사진 있을 때 · 없을 때)', async () => {
  for (const withPhoto of [false, true]) {
    const w = world({ handoff: [ITEM_A], answer: true });
    await w.boot();
    if (withPhoto) w.addPhoto('a');
    w.run('backToSearch()'); await settle();
    assert.equal(w.B.left, HOME, `홈으로(${withPhoto ? '사진 있음' : '없음'})`);
    assert.equal(w.B.how, 'back', `★ 들어온 칸(홈)으로 되돌아간다 — 실제: ${w.B.how}(새 칸이면 [뒤로]가 제출 화면으로 튕긴다)`);
    assert.equal(w.B.entries[w.B.idx].doc, 'index');
    assert.equal(w.B.entries[w.B.idx - 1].doc, 'other', '홈 뒤 칸 = 홈에 오기 전 화면');
  }
});

test('L1-6 일부만 제출된 완료 창을 연 채 [뒤로] = [닫고 실패한 건 다시 내기]처럼 창만 닫힘 · [리뷰 내역으로]는 홈 칸으로', async () => {
  const w = world({ handoff: [ITEM_A, ITEM_B], answer: false, post: (p, n) => (n === 2 ? { ok: false, error: '(가짜 실패)' } : { ok: true }) });
  await w.boot();
  w.S.filesByIdx = { 0: [PHOTO('a')], 1: [PHOTO('b')] };
  w.run('renderPreviews()');
  await w.run('submitReview()'); await settle();
  assert.equal(w.reg.successModal.style.display, 'flex', '일부만 제출됐어요 창');
  await w.back();
  assert.equal(w.B.left, null, `★ 화면에 남는다 — 실제: ${w.B.left}`);
  assert.equal(w.reg.successModal.style.display, 'none', '완료 창만 닫혔다');
  assert.equal(w.log.confirms.length, 0, '창을 닫을 땐 묻지 않는다');
  const v = world({ handoff: [ITEM_A, ITEM_B], post: (p, n) => (n === 2 ? { ok: false, error: '(가짜 실패)' } : { ok: true }) });
  await v.boot();
  v.S.filesByIdx = { 0: [PHOTO('a')], 1: [PHOTO('b')] };
  v.run('renderPreviews()');
  await v.run('submitReview()'); await settle();
  v.run("goToReviewerMain('review')"); await settle();
  assert.equal(v.B.left, HOME, '창 칸 위에서는 새 칸을 쌓지 않고 들어온 홈 칸으로');
  assert.equal(v.B.how, 'back');
});

test('L1-7 모두 제출된 완료 창: 떠나기 확인 칸은 거둔다 — [뒤로]·[리뷰 내역으로] 모두 묻지 않음 · [리뷰 내역으로]는 종전처럼 리뷰 내역(#review)', async () => {
  const w = world({ handoff: [ITEM_A], answer: false });
  await w.boot();
  w.addPhoto('a');
  await w.run('submitReview()'); await settle();
  assert.equal(w.B.idx, 2, '떠나기 확인 칸을 되돌렸다(제출 화면 첫 칸으로)'); assert.equal(w.sb.history.state, null);
  w.run("goToReviewerMain('review')"); await settle();
  assert.equal(w.log.confirms.length, 0);
  assert.equal(w.B.left, ORIGIN + '/index.html#review', '종전 그대로 리뷰 내역 제출완료로');
  const b = world({ handoff: [ITEM_A], answer: false });
  await b.boot();
  b.addPhoto('a');
  await b.run('submitReview()'); await settle();
  await b.back();
  assert.equal(b.log.confirms.length, 0); assert.equal(b.B.left, HOME, '[뒤로] = 홈(묻지 않음)');
});

test('L1-8 칸은 리뷰어가 손댄 뒤에만 쌓는다 — 새로고침으로 비고만 되살린 화면은 칸 0(손길 없이 쌓은 칸은 브라우저가 건너뛴다) · [←]는 그래도 묻는다', async () => {
  const w = world({ handoff: [ITEM_A], answer: false });
  await w.boot();
  w.typeMemo('비고');
  const r = w.reload({ answer: false, entries: w.B.entries.slice(0, 3), idx: 2 });
  await r.boot();
  assert.equal(r.B.entries.length, 3, '다시 열 때 칸을 쌓지 않는다');
  r.run('backToSearch()'); await settle();
  assert.equal(r.log.confirms.length, 1, '되살린 비고도 [←]에서 묻는다');
});

test('L1-9 틀(iframe) 안·도우미가 없을 때는 방문 기록을 건드리지 않는다 — [←] 확인·새로고침 유지는 그대로', async () => {
  const f = world({ handoff: [ITEM_A], framed: true, answer: false });
  await f.boot();
  f.addPhoto('a');
  assert.equal(f.B.entries.length, 3, '틀 안 = 칸 0');
  const n = world({ handoff: [ITEM_A], helper: false, answer: false });
  await n.boot();
  n.addPhoto('a');
  assert.equal(n.B.entries.length, 3, '도우미 없음 = 칸 0(옛 캐시·차단)');
  n.run('backToSearch()'); await settle();
  assert.equal(n.log.confirms.length, 1, '[←] 확인은 도우미 없이도');
  const r = n.reload({ helper: false });
  await r.boot();
  assert.equal(r.log.opened.length, 1, '새로고침 유지도 도우미 없이');
});

/* ═══ 정적 — 배선·한 벌·배포 스큐 ═══ */
test('L1-10 아이폰 실기: 저장돼 있던 지난 제출 화면이 [뒤로]로 되살아나면(그 건은 이미 끝났거나 다른 건으로 바뀜) 홈으로 — 같은 건이면 그대로', async () => {
  const fire = (w) => (w.B.listeners.pageshow || []).forEach((f) => f({ persisted: true }));
  // ① 같은 건 그대로 — 남는다
  const w1 = world({ handoff: [ITEM_A] }); await w1.boot(); w1.typeMemo('배송이 빨랐어요');
  fire(w1); await settle();
  assert.equal(w1.B.left, null, '같은 건의 화면이 되살아나면 그대로 둔다');
  // ② 그 건이 끝남(이어서 보기 칸 비움 — 다른 문서에서 나가기·제출) — 홈으로
  const w2 = world({ handoff: [ITEM_A] }); await w2.boot(); w2.typeMemo('배송이 빨랐어요');
  w2.ss.removeItem('iad_direct_submit_keep_v1');
  fire(w2); await settle();
  assert.ok(w2.B.left && /\/$/.test(new URL(w2.B.left).pathname), '★ 끝난 건의 지난 화면은 홈으로 — 실제: ' + w2.B.left);
  // ③ 다른 건으로 바뀜 — 홈으로
  const w3 = world({ handoff: [ITEM_A] }); await w3.boot();
  const k = JSON.parse(w3.ss.getItem('iad_direct_submit_keep_v1')); k.items = [ITEM_B]; w3.ss.setItem('iad_direct_submit_keep_v1', JSON.stringify(k));
  fire(w3); await settle();
  assert.ok(w3.B.left, '★ 다른 건이 열려 있으면 지난 건 화면은 홈으로');
});

test('S-1 search.html 은 도우미를 search-app.js 보다 먼저 싣고 둘 다 ?v= 를 올렸다 · 머리 스크립트는 새로고침 칸도 가린다', () => {
  const tags = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const iH = tags.findIndex((t) => /^js\/reviewer-sheet-back\.js\?v=/.test(t));
  const iA = tags.findIndex((t) => /^js\/search-app\.js\?v=/.test(t));
  assert.ok(iH >= 0, '★ 리뷰어 홈 도우미를 싣는다(사본 금지 — 결정 372·403)');
  assert.ok(iA > iH, '도우미가 먼저');
  { const v = /v=(\d{8})-[\w-]+/.exec(tags[iA]); assert.ok(v && v[1] >= '20261125', tags[iA]); }   // 결정 417·425 가 search-app.js 를 다시 올렸다(뜻 그대로 — 413 판(20261125) 이후로 올렸는가)
  assert.match(HTML, /sessionStorage\.getItem\("iad_direct_submit_items"\) \|\| sessionStorage\.getItem\("iad_direct_submit_keep_v1"\)/);
});

test('S-2 방문 기록은 도우미 하나로 — search-app.js 에 pushState·popstate 0 · 성공 지점 전부 _rvDraftSubmitted · 그리기 3곳 _rvDraftSync', () => {
  assert.ok(!/pushState|onpopstate|'popstate'|"popstate"/.test(SA), '화면 스크립트에 방문 기록 조작 0');
  const body = fn('submitReview') + fn('_submitReviewSlots');
  const shows = (body.match(/show\("successModal", "flex"\)/g) || []).length;
  const marks = (body.match(/_rvDraftSubmitted\([^\n]*\);[^\n]*\n\s*show\("successModal", "flex"\)/g) || []).length;
  assert.equal(marks, shows, `완료 창을 띄우는 곳(${shows})마다 바로 앞에서 제출됨 표시`);
  assert.match(fn('_submitReviewSlots'), /_rvDraftSubmitted\(false\);[^\n]*\n\s*goStep\(3\)/, '리뷰 → 현금영수증 단계도 제출됨');
  for (const f of ['renderPreviews', '_mrRenderPreview', '_csRenderPreview']) assert.match(fn(f), /_rvDraftSync\(\);/, f);
  assert.match(fn('_showDuplicateBlockModal'), /_rvBackOpened\('_reviewDuplicateBlockModal'/);
  assert.match(fn('_rvCloseForRetry'), /_rvBackClosed\("successModal"\)/);
  assert.match(fn('resetApp'), /_rvDraftEnd\(true\)/);
  assert.match(fn('_logout'), /_rvKeepDrop\(\)/);
  assert.ok(!/window\.location\.href = '\/'/.test(fn('backToSearch')), '[←] 가 새 칸으로 홈을 열지 않는다');
});

test('S-3 도우미 depth() 는 읽기만 — 기존 opened/closed/leave 그대로', () => {
  assert.match(HELPER, /w\.RhSheetBack = \{ opened: opened, closed: closed, leave: leave, depth: curDepth \};/);
});
