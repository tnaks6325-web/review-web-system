'use strict';
/**
 * ★ 결정 403 — 공고 화면(campaign.html)의 창(바텀시트)이 열린 채 휴대폰 [뒤로]를 누르면 그 창 하나만 닫는다
 *
 *  종전: 공고 화면에는 뒤로가기 처리가 없어 명의 고르기·본인 확인·옵션·개수 창 등을 연 채 [뒤로]를 누르면
 *  창이 닫히는 대신 공고 화면을 통째로 떠났다(결정 402 「뒤로가기 관련 확인」에 적어 둔 남은 문제).
 *  고친 뒤: 리뷰어 홈과 같은 도우미(js/reviewer-sheet-back.js · RhSheetBack, 결정 370·372)를 싣고,
 *  창 열기·닫기를 _sheetOpen / _sheetClose 한 벌로 모아 도우미에 알린다.
 *
 *  아래 가짜 브라우저는 방문 기록 규칙을 흉내 낸다: pushState = 같은 문서에 칸 추가(앞쪽 칸 버림) · go(n) = 비동기 ·
 *  같은 문서 칸으로 가면 popstate · 다른 문서 칸으로 가면 「떠남」 · location.replace = 지금 칸을 다른 문서로 · assign = 새 칸.
 *  도우미 파일은 진짜를 그대로 싣고, 화면 함수는 campaign.html 에서 그대로 꺼내 vm 에서 돌린다(문자열 존재만 보지 않는다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend', 'campaign.html'), 'utf8');
const SCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const HELPER = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'reviewer-sheet-back.js'), 'utf8');
const ORIGIN = 'https://review.example.test';
const HOME = ORIGIN + '/';
const PAGE = ORIGIN + '/campaign.html?id=c1';
const SHEETS = [...CAMP.matchAll(/<div class="sheet-ovl" id="(\w+)"/g)].map(m => m[1]);

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
function grab(name, optional) {
  let i = SCRIPT.indexOf('function ' + name + '(');
  if (i < 0) { if (optional) return ''; assert.fail('함수 없음: ' + name); }
  if (SCRIPT.slice(i - 6, i) === 'async ') i -= 6;
  return SCRIPT.slice(i, braceEnd(SCRIPT, SCRIPT.indexOf('{', SCRIPT.indexOf(')', i))) + 1);
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

const FUNCS = ['$', 'needLogin', 'hideSheet', 'openOptSheet', 'openChangeOptSheet', 'hideOptSheet', 'onOptSheetConfirm',
  'openQtySheet', 'hideQtySheet', 'onQtySheetConfirm', 'openChangeQtySheet', '_qtyNoteText', 'openMultiHelp', 'hideMultiHelp',
  '_syncAcctGo', 'openAcctSheet', 'hideAcctSheet', 'openAcctEmpty', 'hideAcctEmpty', 'goRegisterSub', 'onAcctSheetConfirm',
  '_applyInitialAcct', '_continueInitialAcct', 'openBlogSheet', 'hideBlogSheet', 'onBlogSheetConfirm', 'openPopGate', 'hidePopGate',
  'goPopNormal'];
const NEW_FUNCS = ['_sheetHideOf', '_sheetOpen', '_sheetClose', '_sheetLeave', 'onReceiptZoom'];   // 결정 403 · 434(영수증 크게 보기) — 옛 화면에는 없다(없으면 건너뛴다)

/** 공고 화면 + 가짜 브라우저. 리뷰어 홈(index) → 공고 화면으로 들어온 상태에서 시작한다. */
function world({ helper = true, subsDelay = 0 } = {}) {
  const B = { entries: [{ doc: 'index', url: HOME, state: null }, { doc: 'campaign', url: PAGE, state: null }], idx: 1, left: null, how: '', listeners: {} };
  const log = { apply: [], many: [], join: [], changeOpt: [], changeQty: [], toasts: [], afterLogin: 0 };
  const fire = (type, ev) => (B.listeners[type] || []).forEach(fn => fn(ev || {}));
  function traverse(n) {
    if (B.left) return;
    const t = Math.max(0, Math.min(B.entries.length - 1, B.idx + n));
    if (t === B.idx) return;
    B.idx = t;
    const e = B.entries[t];
    if (e.doc !== 'campaign') { B.left = e.url; B.how = 'back'; fire('pagehide'); return; }
    fire('popstate', { state: clone(e.state) });
  }
  const history = {
    get state() { return clone(B.entries[B.idx].state); },
    get length() { return B.entries.length; },
    pushState(st, _t, u) { B.entries.splice(B.idx + 1); B.entries.push({ doc: 'campaign', url: String(u || B.entries[B.idx].url), state: clone(st) }); B.idx++; },
    replaceState(st, _t, u) { const e = B.entries[B.idx]; B.entries[B.idx] = { doc: e.doc, url: String(u || e.url), state: clone(st) }; },
    go(n) { setTimeout(() => traverse(n), 0); },
    back() { this.go(-1); },
  };
  const location = {
    get href() { return B.entries[B.idx].url; },
    set href(u) { location.assign(u); },
    replace(u) { B.entries[B.idx] = { doc: 'other', url: String(u), state: null }; B.left = String(u); B.how = 'replace'; fire('pagehide'); },
    assign(u) { B.entries.splice(B.idx + 1); B.entries.push({ doc: 'other', url: String(u), state: null }); B.idx++; B.left = String(u); B.how = 'assign'; fire('pagehide'); },
    search: '?id=c1', pathname: '/campaign.html', origin: ORIGIN,
  };
  const els = {};
  const mk = (id) => ({ id, style: { display: SHEETS.includes(id) ? 'none' : '' }, textContent: '', innerHTML: '', value: '', disabled: false,
    children: [], _a: {}, appendChild(c) { this.children.push(c); return c; }, querySelector() { return null; },
    getAttribute(k) { return this._a[k] == null ? null : this._a[k]; }, setAttribute(k, v) { this._a[k] = String(v); }, focus() {},
    classList: { add() {}, remove() {} }, scrollTop: 0 });
  // body = 화면에 붙인 동적 창(영수증 [크게 보기] · 결정 434). remove() = 그 창을 떼어 낸다.
  const body = { children: [], appendChild(c) { c.parentNode = body; body.children.push(c); return c; } };
  const mkDyn = () => Object.assign(mk(''), { className: '', parentNode: null, onclick: null,
    remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } } });
  const document = { getElementById(id) { return els[id] || (els[id] = mk(id)); }, createElement() { return mkDyn(); }, querySelectorAll() { return []; }, body };
  const store = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };
  const sb = {
    console, URL, URLSearchParams, JSON, Math, Object, Array, Promise, String, Number, Set,
    setTimeout, clearTimeout, history, location, document, sessionStorage: store(), localStorage: store(),
    addEventListener(type, fn) { (B.listeners[type] = B.listeners[type] || []).push(fn); },
    CAMP_ID: 'c1', PREVIEW: false, API_BASE_URL: ORIGIN,
    toast(m) { log.toasts.push(m); }, isQnaCampaign: () => false, _renderOptSheetList() {}, _updateOptGo() {},
    loadSubs: () => new Promise(r => (subsDelay ? setTimeout(r, subsDelay) : r())), loadPopCredit: async () => {},
    _chainOn: () => false, _allHolds: () => ({}), recoverActiveHolds: async () => {},
    _acctRows: () => [{ type: 'self', state: 'ok' }], renderAcctList() {}, _acctMultiPick: () => false, multiEnabled: () => true,
    acctChoiceEnabled: () => false, _popSubsWithCredit: () => [], _popEsc: (s) => String(s), _escAttr: (s) => String(s),
    _campFetch: async () => ({ ok: true, status: 200, j: { ok: true, data: [] } }), _campServerErr: () => new Error('x'), _campErrText: () => '오류',
    CampCards: { seedThumbs() {}, _fmtHM: () => '' },
    _pvBlock() {}, loadCampaign: async () => {},
    _doApply(...a) { log.apply.push(a); }, _applyMany(...a) { log.many.push(a); }, _joinWithOption(k) { log.join.push(k); },
    _doChangeOption(...a) { log.changeOpt.push(a); }, _doChangeQty(q) { log.changeQty.push(q); },
    _isBlogUrl: (v) => /^https?:\/\//.test(v), _BLOG_URL_LS: 'blog_url', _BLOG_URL_HINT: 'https://',
  };
  sb.window = sb;
  vm.createContext(sb);
  if (helper) vm.runInContext(HELPER, sb, { filename: 'reviewer-sheet-back.js' });
  const src = FUNCS.map(n => grab(n)).concat(NEW_FUNCS.map(n => grab(n, true))).join('\n');
  vm.runInContext(
    'var _afterLogin = null, _optSheetMode = "join", _optSheetSel = null, _qtyPending = null, _qtySel = null,' +
    ' _acctOptKey = null, _acctNext = "apply", _acctSel = null, _acctSelMany = [], _initialAcctSel = null, _initialAcctSels = null,' +
    ' _blogUrl = "", _blogPending = null, _subs = [{ name: "타계정", phone: "01011112222" }], _subsLoadError = false,' +
    ' _chainLate = new Set(), _acctBlocked = {}, _popCredit = null, _popSubCredits = null,' +
    ' _camp = { options: [{ optKey: "a", selectable: true }, { optKey: "b", selectable: true }] }, _detail = null, _rcImgUrl = \"\";\n' + src, sb, { filename: 'campaign.html#sheets' });
  const run = (code) => vm.runInContext(code, sb);
  const shown = (id) => els[id] ? els[id].style.display : 'none';
  const open = () => SHEETS.filter(id => shown(id) === 'flex');
  async function back() { traverse(-1); await settle(); }
  const zooms = () => body.children.filter(c => c.className === 'rc-zoom');
  return { B, log, sb, run, shown, open, back, els, zooms };
}

/** 창마다 여는 방법 — 화면에서 실제로 쓰는 여는 함수 그대로 */
const OPENERS = {
  loginSheet: 'needLogin(() => { /* 이어서 할 일 */ })',
  optSheet: 'openOptSheet()',
  qtySheet: "openQtySheet({ mode:'join', optionKey:'a', views:[{ qty:1, status:'open', remaining:5 }, { qty:2, status:'open', remaining:5 }] })",
  blogSheet: "openBlogSheet('a', null)",
  acctSheet: 'openAcctSheet(null)',
  multiHelp: 'openMultiHelp()',
  acctEmpty: 'openAcctEmpty()',
  popGate: 'openPopGate()',
};
const CLOSERS = { loginSheet: 'hideSheet()', optSheet: 'hideOptSheet()', qtySheet: 'hideQtySheet()', blogSheet: 'hideBlogSheet()',
  acctSheet: 'hideAcctSheet()', multiHelp: 'hideMultiHelp()', acctEmpty: 'hideAcctEmpty()', popGate: 'hidePopGate()' };

test('창 목록 — 공고 화면의 바텀시트 8개가 모두 시험 대상이다', () => {
  assert.deepStrictEqual(SHEETS.slice().sort(), Object.keys(OPENERS).sort());
});

for (const id of Object.keys(OPENERS)) {
  test(`${id}: 연 채 [뒤로] → 그 창만 닫히고 공고에 남는다 → 한 번 더 [뒤로] = 공고를 떠난다`, async () => {
    const w = world();
    await w.run(OPENERS[id]); await settle();
    assert.deepStrictEqual(w.open(), [id]);
    await w.back();
    assert.strictEqual(w.B.left, null, '창을 연 채 누른 [뒤로]가 공고 화면을 떠나면 안 된다');
    assert.deepStrictEqual(w.open(), [], '창은 닫힌다');
    await w.back();
    assert.strictEqual(w.B.left, HOME, '창이 닫힌 뒤 [뒤로] 한 번에 떠난다(헛 누름 없음)');
  });

  test(`${id}: [취소]·단추로 닫은 뒤에는 [뒤로] 한 번에 떠난다(쌓은 칸을 되돌린다)`, async () => {
    const w = world();
    await w.run(OPENERS[id]); await settle();
    w.run(CLOSERS[id]); await settle();
    assert.deepStrictEqual(w.open(), []);
    assert.strictEqual(w.B.idx, 1, '쌓은 칸은 되돌려졌다');
    await w.back();
    assert.strictEqual(w.B.left, HOME);
  });
}

test('[옵션 변경]·[개수 바꾸기](참여 뒤 창)도 [뒤로]로 그 창만 닫힌다', async () => {
  const w = world();
  w.run("_detail = { options: [], application: { optionKey: 'a' }, qty: { tiers: [{ qty:1, status:'open', remaining:3 }, { qty:2, status:'open', remaining:3 }], purchaseQty: 1 } }");
  w.run('openChangeOptSheet()'); await settle();
  assert.deepStrictEqual(w.open(), ['optSheet']);
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, []]);
  w.run('openChangeQtySheet()'); await settle();
  assert.deepStrictEqual(w.open(), ['qtySheet']);
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, []]);
  assert.deepStrictEqual(w.log.changeOpt.concat(w.log.changeQty), [], '[뒤로]는 [취소]와 같다 — 바꾸지 않는다');
  await w.back();
  assert.strictEqual(w.B.left, HOME, '창을 두 번 열고 닫아도 [뒤로] 한 번에 떠난다');
});

test('겹친 창: 명의 고르기 위 「어떻게 하나요?」 → [뒤로]마다 맨 위 하나씩 → 그다음 떠남', async () => {
  const w = world();
  await w.run('openAcctSheet(null)'); await settle();
  w.run('openMultiHelp()'); await settle();
  assert.deepStrictEqual(w.open().sort(), ['acctSheet', 'multiHelp']);
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, ['acctSheet']], '도움말만 닫힌다');
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, []]);
  await w.back();
  assert.strictEqual(w.B.left, HOME);
});

test('도움말 바깥(어두운 곳)을 눌러 닫아도 [뒤로]는 명의 창 → 떠남 순서 그대로', async () => {
  const w = world();
  await w.run('openAcctSheet(null)'); await settle();
  w.run('openMultiHelp()'); await settle();
  w.run('hideMultiHelp()'); await settle();   // 바깥 누르기 = onclick 의 hideMultiHelp()
  assert.deepStrictEqual(w.open(), ['acctSheet']);
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, []]);
  await w.back();
  assert.strictEqual(w.B.left, HOME);
});

test('창이 바로 다음 창으로 이어질 때(명의 → 옵션) 칸은 하나 — [뒤로] 한 번에 옵션 창 닫힘 · 한 번 더 떠남', async () => {
  const w = world();
  await w.run("openAcctSheet(null, 'option')"); await settle();
  w.run("_acctSel = { type: 'self' }"); w.run('onAcctSheetConfirm()'); await settle();
  assert.deepStrictEqual(w.open(), ['optSheet'], '명의를 고르면 옵션 창');
  assert.strictEqual(w.B.entries.length, 3, '칸은 하나만(명의 창 칸을 옵션 창이 이어 쓴다)');
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, []]);
  await w.back();
  assert.strictEqual(w.B.left, HOME);
});

test('창 사이에 서버 응답을 기다려도(옵션 → 명의, 명의 목록 조회 중) 칸이 맞는다', async () => {
  const w = world({ subsDelay: 15 });
  w.run('openOptSheet()'); await settle();
  w.run("_optSheetMode = 'join_sub'; _optSheetSel = 'b'"); w.run('onOptSheetConfirm()');
  await new Promise(r => setTimeout(r, 40)); await settle();
  assert.deepStrictEqual(w.open(), ['acctSheet']);
  await w.back();
  assert.deepStrictEqual([w.B.left, w.open()], [null, []]);
  await w.back();
  assert.strictEqual(w.B.left, HOME, '헛 칸이 남지 않는다');
});

test('성공해서 닫히는 길(개수 고르고 참여) — 창이 닫히고 [뒤로] 한 번에 떠난다 · 참여는 한 번', async () => {
  const w = world();
  w.run(OPENERS.qtySheet); await settle();
  w.run('_qtySel = 2'); w.run('onQtySheetConfirm()'); await settle();
  assert.deepStrictEqual(w.log.apply.map(a => a[2]), [2]);
  assert.deepStrictEqual(w.open(), []);
  w.run('hideOptSheet(); hideAcctSheet();'); await settle();   // 참여 화면으로 가며 다시 닫기(enterJoined·_applyMany 처럼) — 두 번 되돌리지 않는다
  assert.strictEqual(w.B.idx, 1);
  await w.back();
  assert.strictEqual(w.B.left, HOME);
});

test('[뒤로]는 [취소]와 같다 — 본인 확인 뒤 이어서 할 일·개수 참여를 실행하지 않는다', async () => {
  const w = world();
  w.run('needLogin(() => { _afterLoginRan = 1; })'); await settle();
  await w.back();
  assert.strictEqual(w.sb._afterLoginRan, undefined);
  w.run(OPENERS.qtySheet); await settle();
  await w.back();
  assert.deepStrictEqual(w.log.apply, []);
  assert.strictEqual(w.B.left, null);
});

test('창을 연 채 다른 화면으로(타계정 등록 · 인기상품의 일반 모집) — 창 칸을 그 주소로 바꾼다(돌아오면 공고 · 헛 칸 0)', async () => {
  const w = world();
  w.run('openAcctEmpty()'); await settle();
  w.run('goRegisterSub()'); await settle();
  assert.strictEqual(w.B.how, 'replace');
  assert.match(w.B.left, /\/index\.html\?returnCamp=c1#my$/);
  assert.deepStrictEqual(w.B.entries.map(e => e.doc), ['index', 'campaign', 'other'], '그 화면에서 [뒤로] 한 번이면 공고로 돌아온다');
  const w2 = world();
  await w2.run('openPopGate()'); await settle();
  w2.run("goPopNormal('c2')"); await settle();
  assert.deepStrictEqual([w2.B.how, w2.B.left], ['replace', 'campaign.html?id=c2']);
  assert.deepStrictEqual(w2.B.entries.map(e => e.doc), ['index', 'campaign', 'other']);
});

test('리뷰 지적(PR #1864→1867): 창을 연 채 떠난 화면에서 [뒤로]로 공고에 돌아오면(저장된 화면 복원) 공고에 머문다 — 헛 칸으로 보고 한 번 더 뒤로 가지 않는다', async () => {
  for (const [opener, go] of [['openAcctEmpty()', 'goRegisterSub()'], ['openPopGate()', "goPopNormal('c2')"]]) {
    const w = world();
    await w.run(opener); await settle();
    w.run(go); await settle();
    assert.strictEqual(w.B.how, 'replace');
    // 그 화면에서 [뒤로] → 브라우저가 저장해 둔 공고 화면을 되살린다(같은 문서 · 창 칸이 아닌 첫 칸)
    w.B.left = null; w.B.idx = 1;
    (w.B.listeners.pageshow || []).forEach(fn => fn({ persisted: true }));
    (w.B.listeners.popstate || []).forEach(fn => fn({ state: null }));
    await settle();
    assert.strictEqual(w.B.left, null, opener + ' 뒤 돌아온 공고에서 또 뒤로 가지 않는다');
    assert.strictEqual(w.B.idx, 1, '공고 칸에 머문다');
  }
});

test('창이 없을 때 떠나는 길은 종전처럼 새 칸(location.assign) — 공고로 돌아올 칸이 남는다', async () => {
  const w = world();
  w.run("goPopNormal('c3')"); await settle();
  assert.deepStrictEqual([w.B.how, w.B.entries.map(e => e.doc)], ['assign', ['index', 'campaign', 'other']]);
});

test('도우미가 없으면(옛 캐시·차단) 아무 일도 안 한다 — 창은 단추로 종전처럼 열리고 닫힌다', async () => {
  const w = world({ helper: false });
  for (const id of Object.keys(OPENERS)) {
    await w.run(OPENERS[id]); await settle();
    assert.deepStrictEqual(w.open(), [id]);
    w.run(CLOSERS[id]); await settle();
    assert.deepStrictEqual(w.open(), []);
  }
  assert.strictEqual(w.B.entries.length, 2, '방문 기록을 건드리지 않는다');
  w.run('openAcctEmpty()'); w.run('goRegisterSub()');
  assert.strictEqual(w.B.how, 'assign', '이동은 종전 location.href 그대로');
});

/* ───────────── 정적 전수(문자열이 아니라 「빠진 길이 없는지」를 센다) ───────────── */
test('정적 — 도우미를 싣고, 창 8개 모두 「여는 곳 = _sheetOpen · 닫는 곳 = _sheetClose · 뒤로가기 닫기 = [취소]와 같은 함수」', () => {
  const tags = [...CAMP.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  const iHelper = tags.findIndex(t => /src="js\/reviewer-sheet-back\.js\?v=/.test(t));
  const iInline = tags.findIndex(t => t === '<script>');
  assert.ok(iHelper >= 0 && iHelper < iInline, '도우미는 화면 스크립트보다 먼저 싣는다');
  const hideOf = grab('_sheetHideOf');
  for (const id of SHEETS) {
    const blk = CAMP.slice(CAMP.indexOf('id="' + id + '"'), CAMP.indexOf('</div>\n</div>', CAMP.indexOf('id="' + id + '"')));
    const cancel = [...blk.matchAll(/onclick="(hide\w+)\(\)"/g)].map(m => m[1]).pop();
    assert.ok(cancel, id + ' 의 닫기 단추');
    assert.match(hideOf, new RegExp("case '" + id + "':\\s*return " + cancel + ';'), id + ' 뒤로가기 = ' + cancel);
    assert.match(grab(cancel), new RegExp("_sheetClose\\('" + id + "'\\)"), cancel + ' 은 _sheetClose 로 닫는다');
    assert.ok(!new RegExp("\\$\\('" + id + "'\\)\\.style\\.display\\s*=").test(SCRIPT), id + ' 를 직접 보이거나 숨기지 않는다(_sheetOpen/_sheetClose 로만)');
  }
  assert.ok(!/ovl\.style\.display\s*=/.test(SCRIPT), '창 덮개를 직접 바꾸지 않는다');
  assert.strictEqual((SCRIPT.match(/_sheetOpen\('/g) || []).length, 12, '창을 여는 곳 12곳(로그인1·인기1·옵션3·개수1·도움말1·명의3·미등록1·블로그1)');
  assert.ok(!/pushState|onpopstate|'popstate'/.test(SCRIPT), '방문 기록 조작은 도우미 한 곳(결정 372) — 화면에 따로 두지 않는다');
  for (const fn of ['goPopNormal', 'goRegisterSub']) assert.match(grab(fn), /_sheetLeave\(/, fn + ' 는 창을 연 채 떠난다 → _sheetLeave');
});

/* ★ 결정 434 — 영수증 [크게 보기](화면 위 창)도 같은 규칙: 연 채 [뒤로] = 그 창만 닫힘 · 단추로 닫은 뒤 [뒤로] 한 번 = 떠남.
     실기(안드로이드 크롬 · 2026-11-27)에서 크게 보기를 연 채 [뒤로]를 누르면 공고 화면을 통째로 떠났다(창은 그대로 사라짐). */
test('🧾 영수증 [크게 보기]: 연 채 [뒤로] → 크게 보기만 닫히고 공고에 남는다 → 한 번 더 [뒤로] = 떠난다', async () => {
  const w = world();
  w.run("_rcImgUrl = 'blob:fake'; onReceiptZoom()"); await settle();
  assert.strictEqual(w.zooms().length, 1, '크게 보기가 열린다');
  await w.back();
  assert.strictEqual(w.B.left, null, '크게 보기를 연 채 누른 [뒤로]가 공고 화면을 떠나면 안 된다');
  assert.strictEqual(w.zooms().length, 0, '크게 보기는 닫힌다');
  await w.back();
  assert.strictEqual(w.B.left, HOME, '닫힌 뒤 [뒤로] 한 번에 떠난다(헛 누름 없음)');
});

for (const how of ['button', 'backdrop']) {
  test(`🧾 영수증 [크게 보기]: ${how === 'button' ? '[닫기] 단추로' : '어두운 바깥을 눌러'} 닫은 뒤 [뒤로] 한 번에 떠난다`, async () => {
    const w = world();
    w.run("_rcImgUrl = 'blob:fake'; onReceiptZoom()"); await settle();
    const z = w.zooms()[0];
    z.onclick({ target: how === 'button' ? { tagName: 'BUTTON' } : z }); await settle();
    assert.strictEqual(w.zooms().length, 0);
    assert.strictEqual(w.B.idx, 1, '쌓은 칸은 되돌려졌다');
    await w.back();
    assert.strictEqual(w.B.left, HOME);
  });
}

test('🧾 영수증 [크게 보기]: 사진을 아직 못 불러왔으면 창도 칸도 만들지 않는다', async () => {
  const w = world();
  w.run('onReceiptZoom()'); await settle();
  assert.deepStrictEqual([w.zooms().length, w.B.idx, w.log.toasts.length], [0, 1, 1]);
});

test('인라인 스크립트 문법', () => {
  const blocks = [...CAMP.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 1);
  blocks.forEach((b, i) => { assert.doesNotThrow(() => new vm.Script(b, { filename: 'campaign.html#script' + i })); });
});
