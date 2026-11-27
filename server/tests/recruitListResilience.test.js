/**
 * recruitListResilience.test.js — 결정 430 회귀가드 (공유용 공고 목록 recruit.html)
 *
 *   H1. 목록을 못 받으면(서버 500 · 200+{ok:false} · 끊김 · 무응답) 「현재 모집 중인 캠페인이 없습니다」로 그리지 않는다.
 *       쉬운 한국어 실패 상자 + [다시 불러오기] · 15초 시간 제한 · 영어 문구(Failed to fetch 등) 금지 ·
 *       다시 부르다 실패하면 보던 목록을 그대로 둔다 · 실패 뒤/중에 탭을 눌러도 화면이 비지 않는다.
 *   M4. 탭을 빨리 바꿔도 카드가 두 벌 나오지 않는다(받아 둔 응답으로 다시 그림 + 늦게 온 응답은 버림).
 *   M5. 카운트다운이 0이 되어 다시 받을 때 목록을 먼저 비우지 않는다(받은 뒤 한 번에 바꿔 끼움).
 *
 * 방법: recruit.html 의 인라인 스크립트를 통째로 vm 에 올려 **원래 진입점**(loadCampaigns · setRecruitKind ·
 *   카드 모듈 ticker 콜백)을 가짜 fetch·가짜 DOM 으로 돌린다. 오류 문구는 api.js 의 진짜 apiFriendlyErrorMessage.
 * 실행: node --test tests/recruitListResilience.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRONT = path.resolve(__dirname, '..', '..', 'frontend');
const HTML = fs.readFileSync(path.join(FRONT, 'recruit.html'), 'utf8');
const API = fs.readFileSync(path.join(FRONT, 'api.js'), 'utf8');

const ENGLISH = /Failed to fetch|Load failed|Internal Server Error|NetworkError|AbortError|aborted|HTTP \d{3}|is not valid JSON|Unexpected token/i;

// ── 페이지 인라인 스크립트(설정·목록·카드·신청) ──
function pageScript() {
  const a = HTML.indexOf('<script>\n/* ═══');
  assert.ok(a > -1, 'recruit.html 인라인 스크립트 시작 못 찾음');
  const b = HTML.indexOf('</script>', a);
  return HTML.slice(a + '<script>'.length, b);
}
function apiFriendlySrc() {
  const i = API.indexOf('function apiFriendlyErrorMessage(');
  assert.ok(i > -1, 'api.js apiFriendlyErrorMessage 없음');
  let depth = 0; const j = API.indexOf('{', API.indexOf(')', i));
  for (let k = j; k < API.length; k++) { if (API[k] === '{') depth++; else if (API[k] === '}' && --depth === 0) return API.slice(i, k + 1); }
  throw new Error('apiFriendlyErrorMessage 끝 못 찾음');
}
// 정적 마크업에서 처음 내용·표시 상태를 읽는다(빈 상태 문구는 HTML 에 박혀 있다)
function staticDiv(id) {
  const m = HTML.match(new RegExp('<div id="' + id + '"([^>]*)>([\\s\\S]*?)</div>'));
  if (!m) return null;
  return { hidden: /display\s*:\s*none/.test(m[1]), html: m[2] };
}

// ── 가짜 DOM ──
function mkEl(tag, id) {
  const e = {
    tagName: String(tag || 'div').toUpperCase(), id: id || '', style: {}, dataset: {}, className: '', disabled: false,
    _html: '', kids: [], __frag: false,
    set innerHTML(v) { this._html = String(v); this.kids = []; },
    get innerHTML() { return this._html + this.kids.map(k => k.outerHTML).join(''); },
    get outerHTML() { return this.__frag ? this.innerHTML : `<div class="${this.className}">${this.innerHTML}</div>`; },
    set textContent(v) { this._html = String(v).replace(/</g, '&lt;'); this.kids = []; },
    get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
    appendChild(c) { if (c && c.__frag) { this.kids.push(...c.kids); c.kids = []; } else this.kids.push(c); return c; },
    replaceChildren(...n) { this._html = ''; this.kids = []; n.forEach(x => this.appendChild(x)); },
    append(...n) { n.forEach(x => this.appendChild(typeof x === 'string' ? Object.assign(mkEl('span'), { _html: x }) : x)); },
    remove() {}, setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return e;
}

function makePage(fetchImpl) {
  const els = {};
  for (const id of ['rcLoading', 'rcEmpty', 'rcError', 'rcList', 'rcActiveCount', 'rcPageTitle', 'rcFooter',
    'rcPaymentInfo', 'rcKakaoBtnMandu', 'rcKakaoBtnMango', 'rcToast', 'rcApplyModal', 'rcApplyCampName',
    'rcApplyName', 'rcApplyPhone', 'rcApplyInad', 'rcApplySubmitBtn']) {
    const s = staticDiv(id);
    if (!s && (id === 'rcError')) continue;   // 옛 화면엔 실패 상자가 없다
    const el = mkEl('div', id);
    if (s) { el._html = s.html; if (s.hidden) el.style.display = 'none'; }
    els[id] = el;
  }
  const timers = [];
  const calls = [];
  const ticker = { cb: null };
  const ctx = {
    console, Promise, JSON, Math, Date, Object, Array, String, Number, Error, TypeError, Set, Map, RegExp, URLSearchParams,
    AbortController, DOMException,
    setTimeout: (fn, ms) => { const t = { fn, ms: Number(ms) || 0, cleared: false }; timers.push(t); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval: () => {},
    API_BASE_URL: 'https://api.example',
    sessionStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {},
    scrollY: 0, pageYOffset: 0, scrollTo(x, y) { ctx.scrollY = ctx.pageYOffset = (typeof x === 'object' ? x.top : y) || 0; },
    alert() {},
    fetch: (url, init) => { calls.push(String(url)); return ctx.__fetch(String(url), init || {}); },
    __fetch: fetchImpl,
    CampCards: {
      seedThumbs() {}, setServerNow() {},
      sortByAvailability: (l) => (l || []).slice(), qnaFirst: (l) => (l || []).slice(),
      cardHtml: (c) => `<article class="pcard" data-camp-id="${c.id}"></article>`,
      startTicker: (cb) => { if (cb) ticker.cb = cb; },
    },
    document: {
      title: '',
      getElementById: (id) => els[id] || null,
      createElement: (t) => mkEl(t),
      createDocumentFragment: () => Object.assign(mkEl('frag'), { __frag: true }),
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
      body: mkEl('body'), documentElement: mkEl('html'),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(apiFriendlySrc(), ctx);
  vm.runInContext(pageScript(), ctx);
  const shown = (id) => els[id] && els[id].style.display !== 'none';
  const visibleText = () => ['rcLoading', 'rcEmpty', 'rcError', 'rcList'].filter(shown)
    .map(id => els[id].innerHTML.replace(/<[^>]*>/g, ' ')).join(' ').replace(/\s+/g, ' ').trim();
  const visibleHtml = () => ['rcLoading', 'rcEmpty', 'rcError', 'rcList'].filter(shown).map(id => els[id].innerHTML).join('\n');
  const ids = () => (els.rcList.innerHTML.match(/data-camp-id="([^"]+)"/g) || []).map(s => s.slice(14, -1));
  const legacy = () => (els.rcList.innerHTML.match(/class="rc-card /g) || []).length;
  return { ctx, els, timers, calls, ticker, shown, visibleText, visibleHtml, ids, legacy,
    run: (code) => vm.runInContext(code, ctx) };
}

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const okRes = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data, serverNow: '2026-11-27T03:00:00.000Z' }) });
const res500 = () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Internal Server Error (가짜 500)' }) });
const res200err = () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'Internal Server Error' }) });
const netFail = () => Promise.reject(new TypeError('Failed to fetch'));
const hang = (init) => new Promise((_, rej) => {
  const s = init && init.signal;
  if (s) s.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
});
function deferred() { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; }

const P = (id, kind) => ({ id, participation_mode: true, status: 'active', state: 'open', work_kind: kind || '' });
const DATA = [P('p1'), P('p2'), P('q1', 'qna'), P('b1', 'blog'),
  { id: 'l1', participation_mode: false, status: 'active', title: '옛 공고', work_kind: '' }];
const REVIEW_IDS = ['p1', 'p2', 'q1'];

async function loadOk(pg, data = DATA) { pg.ctx.__fetch = async () => okRes(data); pg.run('loadCampaigns()'); await flush(); }
function retryButtonClick(pg) {
  const h = pg.visibleHtml();
  const m = h.match(/<button[^>]*onclick="([^"]+)"[^>]*>[^<]*다시 불러오기/);
  assert.ok(m, '다시 불러오기 버튼 없음 :: ' + h.slice(0, 400));
  pg.ctx.__btn = mkEl('button');
  pg.run(`(function(){ ${m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'")} }).call(__btn)`);
}
function assertFailBox(pg, label) {
  const t = pg.visibleText();
  assert.ok(!/모집 중인 캠페인이 없습니다/.test(t), label + ': 실패를 「없습니다」로 그림 :: ' + t);
  assert.ok(/불러오지 못했/.test(t), label + ': 실패 상자 없음 :: ' + t);
  assert.ok(!ENGLISH.test(pg.visibleHtml()), label + ': 영어 오류 문구가 보임 :: ' + t);
  assert.ok(/다시 불러오기/.test(t), label + ': [다시 불러오기] 없음 :: ' + t);
  assert.ok(!/불러오는 중입니다/.test(t), label + ': 실패했는데 「불러오는 중」이 남음 :: ' + t);
}

test('H1 서버 500 → 「없습니다」 대신 실패 상자 + [다시 불러오기] → 누르면 목록이 뜬다', async () => {
  const pg = makePage(async () => res500());
  pg.run('loadCampaigns()'); await flush();
  assertFailBox(pg, '500');
  assert.ok(/서버에 일시적인 문제가 있어요/.test(pg.visibleText()), pg.visibleText());
  pg.ctx.__fetch = async () => okRes(DATA);
  retryButtonClick(pg); await flush();
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS);
  assert.strictEqual(pg.legacy(), 1);
  assert.ok(!/불러오지 못했/.test(pg.visibleText()), '성공 뒤에도 실패 상자가 남음 :: ' + pg.visibleText());
  assert.ok(!/불러오는 중입니다/.test(pg.visibleText()));
});

test('H1 200 + {ok:false, error} 도 실패로 본다(빈 목록으로 접지 않음)', async () => {
  const pg = makePage(async () => res200err());
  pg.run('loadCampaigns()'); await flush();
  assertFailBox(pg, '200+ok:false');
});

test('H1 처음부터 끊김 → 쉬운 한국어(영어 Failed to fetch 금지)', async () => {
  const pg = makePage(netFail);
  pg.run('loadCampaigns()'); await flush();
  assertFailBox(pg, 'net');
  assert.ok(/인터넷 연결이 불안정해요/.test(pg.visibleText()), pg.visibleText());
});

test('H1 서버 무응답 → 15초 안에 끊고 실패 상자', async () => {
  const pg = makePage((u, init) => hang(init));
  pg.run('loadCampaigns()'); await flush();
  assert.ok(/불러오는 중/.test(pg.visibleText()), '기다리는 동안엔 불러오는 중 :: ' + pg.visibleText());
  const t = pg.timers.filter(x => !x.cleared && x.ms > 0 && x.ms <= 15000).sort((a, b) => b.ms - a.ms)[0];
  assert.ok(t, '목록 조회에 15초 이하 시간 제한이 없다 :: ' + JSON.stringify(pg.timers.map(x => x.ms)));
  assert.ok(t.ms >= 5000, '시간 제한이 너무 짧다 ' + t.ms);
  t.fn(); await flush();
  assertFailBox(pg, 'hang');
  assert.ok(/응답이 늦어지고 있어요/.test(pg.visibleText()), pg.visibleText());
});

test('H1 진짜 빈 목록일 때만 「현재 모집 중인 캠페인이 없습니다」', async () => {
  const pg = makePage(async () => okRes([]));
  pg.run('loadCampaigns()'); await flush();
  const t = pg.visibleText();
  assert.ok(/현재 모집 중인 캠페인이 없습니다/.test(t), t);
  assert.ok(!/불러오지 못했/.test(t) && !/불러오는 중입니다/.test(t), t);
});

test('H1 다시 부르다 실패하면(카운트다운 0 · 신청 뒤) 보던 목록을 그대로 둔다', async () => {
  const pg = makePage(null);
  await loadOk(pg);
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS);
  assert.ok(typeof pg.ticker.cb === 'function', '카운트다운 콜백 없음');
  pg.ctx.__fetch = async () => res500();
  pg.ticker.cb(); await flush();
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS, '재조회 실패로 목록이 사라짐');
  assert.ok(!/불러오지 못했|없습니다/.test(pg.visibleText()), pg.visibleText());
  pg.ctx.__fetch = netFail;
  pg.run('loadCampaigns()'); await flush();
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS, '끊김 재조회로 목록이 사라짐');
});

test('H1 한 번 뜬 뒤 통신이 끊긴 상태에서 탭을 눌러도 화면이 비지 않는다', async () => {
  const pg = makePage(null);
  await loadOk(pg);
  pg.ctx.__fetch = netFail;
  pg.run("setRecruitKind('blog')"); await flush();
  assert.deepStrictEqual(pg.ids(), ['b1'], '블로그 탭이 비었다 :: ' + pg.visibleText());
  pg.ctx.__fetch = (u, init) => hang(init);
  pg.run("setRecruitKind('review')"); await flush();
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS, '리뷰 탭이 비었다 :: ' + pg.visibleText());
  assert.strictEqual(pg.legacy(), 1);
  assert.ok(!ENGLISH.test(pg.visibleHtml()));
});

test('H1 처음 불러오기가 실패한 상태에서 탭을 눌러도 빈 화면이 아니다(불러오는 중 → 실패 상자)', async () => {
  const pg = makePage(netFail);
  pg.run('loadCampaigns()'); await flush();
  assertFailBox(pg, 'first');
  const d = deferred();
  pg.ctx.__fetch = () => d.p;
  pg.run("setRecruitKind('blog')"); await flush();
  assert.ok(pg.visibleText().length > 0, '탭을 누르자 화면이 비었다');
  d.resolve(res500()); await flush();
  assertFailBox(pg, 'tab-after-fail');
  pg.ctx.__fetch = async () => okRes(DATA);
  retryButtonClick(pg); await flush();
  assert.deepStrictEqual(pg.ids(), ['b1']);
});

test('M4 탭을 빨리 바꿔도 카드가 두 벌 나오지 않는다(받아 둔 응답으로)', async () => {
  const pg = makePage(null);
  await loadOk(pg);
  const pend = [];
  pg.ctx.__fetch = () => { const d = deferred(); pend.push(d); return d.p; };
  pg.run("setRecruitKind('blog')");
  pg.run("setRecruitKind('review')"); await flush();
  pend.forEach(d => d.resolve(okRes(DATA))); await flush();
  const got = pg.ids();
  assert.strictEqual(got.length, new Set(got).size, '같은 카드가 두 번 :: ' + got.join(','));
  assert.deepStrictEqual(got, REVIEW_IDS);
  assert.strictEqual(pg.legacy(), 1, '옛 방식 카드가 두 번');
  pg.run("setRecruitKind('blog')"); pg.run("setRecruitKind('qna')"); await flush();
  pend.forEach(d => d.resolve(okRes(DATA))); await flush();
  assert.deepStrictEqual(pg.ids(), ['q1']);
});

test('M4 첫 응답을 기다리는 중 탭을 눌러도 한 번만 그린다', async () => {
  const d = deferred();
  const pg = makePage(() => d.p);
  pg.run('loadCampaigns()');
  pg.run("setRecruitKind('blog')"); await flush();
  assert.ok(/불러오는 중/.test(pg.visibleText()), pg.visibleText());
  d.resolve(okRes(DATA)); await flush(); await flush();
  assert.deepStrictEqual(pg.ids(), ['b1']);
  assert.strictEqual(pg.calls.filter(u => /\/api\/campaign\/list/.test(u)).length, 1, '탭을 누를 때마다 같은 목록을 또 부른다');
});

test('M4 늦게 온 옛 응답은 새 응답을 덮지 않는다', async () => {
  const pg = makePage(null);
  await loadOk(pg);
  const d1 = deferred(), d2 = deferred();
  const q = [d1, d2];
  pg.ctx.__fetch = () => q.shift().p;
  pg.run('loadCampaigns()'); pg.run('loadCampaigns()');
  d2.resolve(okRes([P('p9')])); await flush();
  d1.resolve(okRes(DATA)); await flush();
  assert.deepStrictEqual(pg.ids(), ['p9']);
});

test('M5 카운트다운 0 재조회는 목록을 먼저 비우지 않고 받은 뒤 한 번에 바꾼다', async () => {
  const pg = makePage(null);
  await loadOk(pg);
  const d = deferred();
  pg.ctx.__fetch = () => d.p;
  pg.ctx.scrollTo(0, 2100);
  // 아이폰 흉내: 목록이 한순간이라도 비면 문서가 짧아져 스크롤이 0 으로 잘린다
  const el = pg.els.rcList, desc = Object.getOwnPropertyDescriptor(el, 'innerHTML');
  Object.defineProperty(el, 'innerHTML', { configurable: true, get() { return desc.get.call(el); },
    set(v) { desc.set.call(el, v); if (v === '') pg.ctx.scrollY = pg.ctx.pageYOffset = 0; } });
  pg.ticker.cb(); await flush();
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS, '응답을 기다리는 동안 목록이 지워졌다(아이폰에서 맨 위로 튐)');
  assert.ok(!/불러오는 중/.test(pg.visibleText()), '조용한 재조회에 로딩 표시');
  d.resolve(okRes(DATA.map(c => c.id === 'p2' ? Object.assign({}, c, { state: 'cutoff' }) : c))); await flush();
  assert.deepStrictEqual(pg.ids(), REVIEW_IDS);
  assert.strictEqual(pg.legacy(), 1);
  assert.strictEqual(pg.ctx.scrollY, 2100, '스크롤 위치가 바뀌었다');
});

test('정적: 목록 조회는 시간 제한 도우미를 지나고, ticker 가 목록을 비우지 않는다', () => {
  const s = pageScript();
  assert.ok(!/startTicker\(\s*\(\)\s*=>\s*\{\s*container\.innerHTML\s*=\s*""/.test(s), 'ticker 가 목록을 비운다');
  // 목록 주소를 부르는 fetch 는 시간 제한 도우미(_rcFetchList) 안 한 곳뿐이어야 한다
  const h = s.indexOf('async function _rcFetchList(');
  assert.ok(h > -1, '목록 조회 도우미 _rcFetchList 없음');
  const helper = s.slice(h, s.indexOf('\n}\n', h) + 2);
  assert.ok(/new AbortController\(\)/.test(helper) && /ctl\.abort\(\)/.test(helper), '도우미에 시간 제한 없음');
  const outside = s.slice(0, h) + s.slice(h + helper.length);
  assert.ok(!/\/api\/campaign\/list/.test(outside), '도우미 밖에서 목록을 직접 부른다(시간 제한 없음)');
});
