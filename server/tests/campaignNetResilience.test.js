'use strict';
/**
 * ★ 결정 397 — 공고 화면(campaign.html)의 통신 실패 처리 (점검 보고서 H1·M2·M3·M4·L2)
 *
 *  H1  참여 중(이 기기에 자리 토큰 있음)인데 작업 내용 조회가 끊기면(예외) → 참여 전 화면([참여하기])으로 보내지 않는다.
 *      토큰은 그대로(결정 356 — 서버 판정으로만 지운다) · 「다시 연결하는 중 · 참여는 유지돼요」 · 다시 시도 → 연결되면 구매양식.
 *      참여 전 화면의 15초 갱신·첫 로딩 429 재시도도 자리가 있으면 구매양식으로 다시 들어간다.
 *  M2  첫 로딩 실패 = 쉬운 말 + [다시 불러오기] + 몇 초 뒤 자동으로 다시(끊김·서버 일시 오류).
 *  M3  영어 개발자 문구(Failed to fetch · Unexpected token …)를 보이지 않는다 · 사유 없는 5xx 를 「참여할 수 없어요」로 말하지 않는다.
 *  M4  모든 서버 호출은 _campFetch 하나를 지난다(시간 제한 · 본문 읽기까지).
 *  L2  [참여하기] 응답만 못 받으면 서버에 잡힌 자리를 한 번 받아 와 이어서 연다(다시 보내지 않는다 — _applyMany 와 같은 복구).
 *
 *  화면 함수는 campaign.html 에서 그대로 꺼내 vm 에서 돌린다(문자열 존재만 보지 않는다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend', 'campaign.html'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'frontend', 'api.js'), 'utf8');
const SCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/** 함수 하나를 통째로(앞의 async 포함) — 따옴표·주석 안의 중괄호는 세지 않는다. */
function grab(src, name) {
  let i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '함수 없음: ' + name);
  if (src.slice(i - 6, i) === 'async ') i -= 6;
  let depth = 0, k = src.indexOf('{', src.indexOf(')', i));
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "'" || c === '"' || c === '`') { const q = c; for (k++; k < src.length && src[k] !== q; k++) if (src[k] === '\\') k++; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('중괄호 불균형: ' + name);
}
function helperBlock() {
  const a = SCRIPT.indexOf('/* ═══ ★ 결정 397 — 공고 화면 서버 호출 도우미');
  const b = SCRIPT.indexOf('/* ═══ 결정 397 도우미 끝 ═══ */');
  assert.ok(a >= 0 && b > a, '결정 397 호출 도우미 블록이 있어야 한다');
  return SCRIPT.slice(a, b);
}
const ENGLISH = /failed to fetch|load failed|unexpected token|is not valid json|networkerror|typeerror/i;

function el(display) { return { style: { display: display == null ? '' : display }, textContent: '', innerHTML: '', disabled: false }; }
const VIEWS = ['vLoading', 'vPre', 'vMissing', 'vJoined', 'vExpired', 'vDone', 'vBlogPending', 'vBlogRejected', 'vReconnect'];

/** 공고 화면의 작은 세계: 실제 함수 + 가짜 DOM·저장소·타이머·fetch */
function world({ fetchImpl, view = 'vPre', hold = { phone8: '00000000', holdToken: 'tok', applicationId: 7, expiresAt: new Date(Date.now() + 15 * 60000).toISOString() }, fns = [] } = {}) {
  const els = {};
  VIEWS.forEach(v => { els[v] = el(v === view ? '' : 'none'); });
  ['reconnectWhy', 'reconnectBtn', 'joinBtn', 'toast', 'loadRetryBtn'].forEach(id => { els[id] = el(''); });
  const log = { toasts: [], renderPre: 0, clearHold: 0, joinedView: 0, timers: [], intervals: [], enterJoined: 0, recover: [], fetches: [], init: 0, loadCampaign: 0, renderDone: 0, released: 0 };
  const holds = hold ? { [hold.phone8]: hold } : {};
  const sb = {
    console, Date, JSON, Math, Promise, Object, Array, String, Number, isFinite, encodeURIComponent, decodeURIComponent,
    API_BASE_URL: 'http://api.test', CAMP_ID: 'c1', PREVIEW: false,
    document: { hidden: false, addEventListener() {}, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    $: (id) => els[id] || (els[id] = el('none')),
    toast: (m) => log.toasts.push(String(m)),
    getHold: (p8) => (p8 ? holds[p8] : Object.values(holds)[0]) || null,
    _allHolds: () => holds,
    clearHold: () => { log.clearHold++; Object.keys(holds).forEach(k => delete holds[k]); },
    renderPre: () => { log.renderPre++; sb.show('vPre'); },
    _renderJoinedView: () => { log.joinedView++; sb.show('vJoined'); },
    renderDone: () => { log.renderDone++; },
    releaseExpiredHold: async () => { log.released++; },
    renderBlogPending: () => {}, renderBlogRejected: () => {},
    _formSubmitting: () => !!sb.__submitting,
    _applyChainView: () => false, _tabsOn: () => false, _isDoneDetail: () => false, _tabDoneActive: () => false,
    isQnaCampaign: () => false,
    isBookingCampaign: () => false,   // 결정 409
    CampCards: { serverNow: () => Date.now(), setServerNow() {} },
    _escAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    _p8: (v) => String(v || '').replace(/\D/g, '').slice(-8),
    // _campFetch 자기 시간 제한 타이머는 세지 않는다(빠른 응답처럼 — 시간 초과는 별도 시험에서 실제 타이머로)
    setTimeout: (fn, ms) => { if (String(fn).includes('_campNetErr(true)')) return 0; log.timers.push({ fn, ms }); return log.timers.length; },
    clearTimeout: () => {}, setInterval: (fn, ms) => { log.intervals.push({ fn, ms }); return 1; }, clearInterval: () => {},
    fetch: async (url, opts) => { log.fetches.push({ url, opts }); return fetchImpl(url, opts); },
    AbortController,
  };
  vm.createContext(sb);
  // api.js 의 문구 단일 출처를 그대로 쓴다
  vm.runInContext(grab(API, 'apiFriendlyErrorMessage'), sb);
  vm.runInContext(helperBlock(), sb);
  vm.runInContext("let _camp = null, _detail = null, _detailRetry = 0, _qnaSlotRetry = 0, _bpTimer = null, _pollTimer = null, _holdTick = null, _enterSeq = 0, _detailRetryTimer = null;", sb);
  vm.runInContext(grab(SCRIPT, 'show'), sb);
  ['enterJoined', '_detailTempFail', '_retryEnterJoined', '_showReconnect', 'retryReconnect', ...fns].forEach(n => vm.runInContext(grab(SCRIPT, n), sb));
  return { sb, els, log, holds, run: (code) => vm.runInContext(code, sb) };
}
const visible = (w) => VIEWS.filter(v => w.els[v].style.display !== 'none');
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

/* ───────────────────────── M4 · 호출 도우미 ───────────────────────── */
test('M4: 모든 서버 호출은 _campFetch 하나를 지난다(시간 제한 없는 fetch 0곳)', () => {
  const raw = SCRIPT.split('\n').filter(l => /(^|[^A-Za-z_$.])fetch\(/.test(l));
  assert.strictEqual(raw.length, 1, '맨 fetch( 는 도우미 안 한 곳뿐이어야 한다:\n' + raw.join('\n'));
  assert.ok(/Promise\.race\(\[fetch\(url, ac \?/.test(raw[0]), '그 한 곳은 _campFetch 의 시간 제한 경주');
  const n = (SCRIPT.match(/_campFetch\(API_BASE_URL/g) || []).length + (SCRIPT.match(/_pvGet = \(base\) => _campFetch\(/g) || []).length;
  assert.ok(n >= 18, '종전 fetch 18곳이 모두 도우미로(지금 ' + n + ')');
  assert.ok(!/'오류: ' \+ e\.message|'불러오기 오류: ' \+ e\.message|'확인 중 오류: ' \+ e\.message|_escAttr\(e\.message\)|\(e\.message\|\|'불러오지 못했어요'\)/.test(SCRIPT),
    '영어 오류 문구(e.message)를 그대로 붙여 보이는 곳이 없어야 한다');
});

test('M4: _campFetch — 성공 응답은 종전 뜻 그대로 · 요청 칸은 준 그대로(+signal)', async () => {
  const w = world({ fetchImpl: async () => res(200, { ok: true, v: 1 }) });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: '{"a":1}' };
  const r = await w.run('_campFetch')('http://api.test/x', opts);
  assert.deepStrictEqual({ ok: r.ok, status: r.status, j: JSON.parse(JSON.stringify(r.j)), bad: r.bad }, { ok: true, status: 200, j: { ok: true, v: 1 }, bad: false });
  const sent = w.log.fetches[0];
  assert.strictEqual(sent.url, 'http://api.test/x');
  assert.strictEqual(sent.opts.method, 'POST'); assert.strictEqual(sent.opts.body, '{"a":1}');
  assert.deepStrictEqual(sent.opts.headers, opts.headers);
  assert.ok(sent.opts.signal, '시간 제한으로 끊을 수 있게 signal 을 더한다');
  assert.deepStrictEqual(Object.keys(opts), ['method', 'headers', 'body'], '부르는 쪽 객체는 건드리지 않는다');
});

test('M4: 끊김 → 쉬운 한국어로 던진다(transport) · 못 읽은 응답 → bad · 멈춘 응답 → 시간 초과', async () => {
  // 실제 타이머를 쓰는 별도 세계(시간 제한 50ms)
  const mk = (impl) => { const sb = { setTimeout, clearTimeout, AbortController, Promise, Object, Error, fetch: impl }; vm.createContext(sb); vm.runInContext(helperBlock(), sb); return sb; };
  let sb = mk(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(vm.runInContext('_campFetch', sb)('u'), (e) => e.transport === true && !e.timeout && /인터넷 연결이 불안정/.test(e.message) && !ENGLISH.test(e.message));
  sb = mk(async () => ({ ok: false, status: 502, headers: {}, json: async () => { throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); } }));
  const r = await vm.runInContext('_campFetch', sb)('u');
  assert.strictEqual(r.bad, true); assert.strictEqual(r.status, 502); assert.deepStrictEqual(JSON.parse(JSON.stringify(r.j)), {});
  assert.strictEqual(vm.runInContext('_campTempFail', sb)(r), true, '502 HTML = 잠깐의 서버 문제');
  assert.strictEqual(vm.runInContext('_campTempFail', sb)({ ok: false, status: 409, j: { reason: 'cutoff' }, bad: false }), false, '사유 있는 거절은 서버의 진짜 판정');
  assert.strictEqual(vm.runInContext('_campTempFail', sb)({ ok: false, status: 503, j: { ok: false, error: 'x' }, bad: false }), true, '사유 없는 5xx');
  let aborted = false;
  sb = mk((u, o) => new Promise((_, rej) => { o.signal.addEventListener('abort', () => { aborted = true; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); }));
  const t0 = Date.now();
  await assert.rejects(vm.runInContext('_campFetch', sb)('u', {}, { timeoutMs: 50 }), (e) => e.transport === true && e.timeout === true && /응답이 늦어지고/.test(e.message));
  assert.ok(Date.now() - t0 < 2000 && aborted, '시간 제한에 맞춰 멈추고 요청을 끊는다');
  sb = mk(async () => ({ ok: true, status: 200, headers: {}, json: () => new Promise(() => {}) }));
  await assert.rejects(vm.runInContext('_campFetch', sb)('u', undefined, { timeoutMs: 50 }), (e) => e.timeout === true, '본문 읽기가 멈춰도 시간 제한');
  assert.strictEqual(vm.runInContext('_CAMP_FETCH_TIMEOUT_MS', sb), 15000, '기본 15초');
});

/* ───────────────────────── H1 · 참여 중 다시 열기 ───────────────────────── */
test('H1: 자리 토큰이 있는데 작업 내용 조회가 끊기면 — 참여 전 화면이 아니라 「다시 연결하는 중」 · 토큰 유지 · 다시 시도', async () => {
  let online = false;
  const w = world({ view: 'vPre', fetchImpl: async () => { if (!online) throw new TypeError('Failed to fetch'); return res(200, { ok: true, application: { expiresAt: new Date(Date.now() + 600000).toISOString() } }); } });
  await w.run('enterJoined()');
  assert.strictEqual(w.log.renderPre, 0, '참여 전 화면([참여하기])으로 보내지 않는다');
  assert.strictEqual(w.log.clearHold, 0, '토큰은 지우지 않는다(결정 356)');
  assert.strictEqual(Object.keys(w.holds).length, 1);
  assert.deepStrictEqual(visible(w), ['vReconnect']);
  assert.match(w.els.reconnectWhy.textContent, /인터넷 연결이 불안정/);
  assert.match(w.els.reconnectWhy.textContent, /남은 시간 약 1[45]분/);
  assert.ok(w.log.toasts.every(t => !ENGLISH.test(t)), '영어 문구 0: ' + w.log.toasts.join(' | '));
  assert.strictEqual(w.log.timers.length, 1, '다시 시도를 하나 예약한다');
  // 오래 끊겨도 계속 다시 묻는다(막다른 길 없음)
  for (let i = 0; i < 9; i++) { const t = w.log.timers.pop(); await t.fn(); }
  assert.deepStrictEqual(visible(w), ['vReconnect']);
  assert.ok(w.log.timers.length === 1 && w.log.timers[0].ms === 15000, '7번째부터는 15초마다 계속');
  // 연결이 돌아오면 구매양식으로
  online = true;
  await w.log.timers.pop().fn();
  assert.strictEqual(w.log.joinedView, 1, '연결되면 구매양식(참여 후 화면)으로 돌아온다');
  assert.deepStrictEqual(visible(w), ['vJoined']);
  assert.strictEqual(w.run('_detailRetry'), 0);
});

test('H1: 배포 중 502 HTML·사유 없는 5xx 도 같은 길(토큰 유지 · 다시 연결 화면 · 계속 다시 시도)', async () => {
  const w = world({ view: 'vLoading', fetchImpl: async () => ({ ok: false, status: 502, headers: {}, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
  await w.run('enterJoined()');
  assert.deepStrictEqual(visible(w), ['vReconnect']);
  assert.match(w.els.reconnectWhy.textContent, /서버에 일시적인 문제/);
  assert.strictEqual(w.log.clearHold + w.log.renderPre, 0);
  for (let i = 0; i < 8; i++) await w.log.timers.pop().fn();
  assert.strictEqual(w.log.timers.length, 1, '일시 장애는 6번에서 멈추지 않는다');
});

test('H1: 서버가 「만료·없음」이라고 답할 때만 정리한다(판정은 서버)', async () => {
  let w = world({ fetchImpl: async () => res(403, { ok: false, reason: 'no_hold' }) });
  await w.run('enterJoined()');
  assert.strictEqual(w.log.clearHold, 1); assert.strictEqual(w.log.renderPre, 1);
  w = world({ fetchImpl: async () => res(403, { ok: false, reason: 'expired' }) });
  await w.run('enterJoined()');
  assert.strictEqual(w.log.released, 1); assert.strictEqual(w.log.clearHold, 0);
});

test('H1: 구매양식을 보던 중(옵션 변경 뒤 다시 열기 등) 끊기면 그 화면을 그대로 두고 알린다(종전 5xx 처리와 같다)', async () => {
  const w = world({ view: 'vJoined', fetchImpl: async () => { throw new TypeError('Load failed'); } });
  await w.run('enterJoined()');
  assert.deepStrictEqual(visible(w), ['vJoined'], '보고 있던 구매양식을 덮지 않는다');
  assert.strictEqual(w.log.renderPre + w.log.clearHold, 0);
  assert.strictEqual(w.log.timers.length, 1);
});

test('H1: 승인 대기 화면의 30초 확인이 끊겨도 참여 전 화면으로 가지 않고 확인을 계속한다', async () => {
  const w = world({ view: 'vBlogPending', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await w.run('enterJoined()');
  assert.deepStrictEqual(visible(w), ['vBlogPending']);
  assert.ok(w.log.intervals.some(i => i.ms === 30000), '30초 확인을 다시 건다');
  assert.strictEqual(w.log.renderPre, 0);
});

test('H1: [지금 다시 연결하기] 는 기다리지 않고 바로 다시 묻는다', async () => {
  let n = 0;
  const w = world({ view: 'vPre', fetchImpl: async () => { n++; if (n === 1) throw new TypeError('Failed to fetch'); return res(200, { ok: true, application: {} }); } });
  await w.run('enterJoined()');
  assert.deepStrictEqual(visible(w), ['vReconnect']);
  await w.run('retryReconnect()');
  assert.strictEqual(n, 2); assert.deepStrictEqual(visible(w), ['vJoined']);
});

test('H1: 참여 전 화면 15초 갱신 — 이 기기에 자리가 있으면 구매양식으로 다시 들어간다 · 없으면 종전대로 공고만', async () => {
  const w = world({ view: 'vPre', fetchImpl: async () => res(200, { ok: true, application: {} }), fns: ['_preRefreshTick'] });
  w.sb.loadCampaign = async () => { w.log.loadCampaign++; };
  await w.run('_preRefreshTick()');
  assert.strictEqual(w.log.joinedView, 1); assert.strictEqual(w.log.loadCampaign, 0);
  const w2 = world({ view: 'vPre', hold: null, fetchImpl: async () => res(200, {}), fns: ['_preRefreshTick'] });
  w2.sb.loadCampaign = async () => { w2.log.loadCampaign++; };
  await w2.run('_preRefreshTick()');
  assert.strictEqual(w2.log.loadCampaign, 1); assert.strictEqual(w2.log.fetches.length, 0);
});

test('H1: 첫 로딩이 429 였으면 1분 뒤 재시도가 시작 경로 전체(자리 복원 → 구매양식)를 다시 탄다', () => {
  const w = world({ fetchImpl: async () => res(200, {}), fns: ['_scheduleCampaign429Retry'] });
  w.run('let _campaign429Retried = false; let _campBooted = false;');
  w.sb._campInit = () => { w.log.init++; };
  w.sb.loadCampaign = async () => { w.log.loadCampaign++; };
  w.run('_scheduleCampaign429Retry(62000)');
  w.log.timers.pop().fn();
  assert.strictEqual(w.log.init, 1); assert.strictEqual(w.log.loadCampaign, 0);
  w.run('_campaign429Retried = false; _campBooted = true;');
  w.run('_scheduleCampaign429Retry(62000)');
  w.log.timers.pop().fn();
  assert.strictEqual(w.log.loadCampaign, 1, '시작이 끝난 뒤엔 종전대로 공고만 다시');
});

/* ───────────────────────── M2 · 첫 로딩 실패 ───────────────────────── */
test('M2: 첫 로딩 실패 = 쉬운 말 + [다시 불러오기] + 자동으로 다시(끊김·서버 일시 오류) · 429 는 이미 예약된 한 번만', () => {
  const w = world({ view: 'vLoading', fetchImpl: async () => res(200, {}), fns: ['_campLoadFail', 'retryCampLoad', '_setLoadingView'] });
  w.run('let _campBooted = false, _bootRetryTimer = null, _bootFails = 0;');
  w.sb._campInit = () => { w.log.init++; };
  w.run('_campLoadFail(_campNetErr(false))');
  const html = w.els.vLoading.innerHTML;
  assert.match(html, /공고를 불러오지 못했어요/); assert.match(html, /인터넷 연결이 불안정/);
  assert.match(html, /id="loadRetryBtn" onclick="retryCampLoad\(\)">다시 불러오기</);
  assert.match(html, /이미 참여한 자리는 그대로 유지돼요/, '자리가 있으면 유지된다고 말한다');
  assert.ok(!ENGLISH.test(html));
  assert.strictEqual(w.log.timers.length, 1); assert.strictEqual(w.log.timers[0].ms, 5000);
  w.log.timers.pop().fn();
  assert.strictEqual(w.log.init, 1, '자동으로 시작 경로를 다시');
  w.run('_campLoadFail(_campServerErr(502))'); assert.strictEqual(w.log.timers.pop().ms, 10000, '점점 늦게(5→10→20→30초)');
  w.run("_campLoadFail(Object.assign(new Error('요청이 너무 많습니다. 잠시 후 다시 시도하세요.'), { rateLimited: true }))");
  assert.strictEqual(w.log.timers.length, 0, '429 는 loadCampaign 이 서버가 정한 시간 뒤로 이미 예약했다');
  assert.match(w.els.vLoading.innerHTML, /요청이 너무 많습니다/);
  w.run("_campLoadFail(new TypeError(\"Unexpected token '<'\"))");
  assert.ok(!ENGLISH.test(w.els.vLoading.innerHTML), '영어 문구 0');
  w.run("_campLoadFail(new Error('<img src=x onerror=alert(1)>'))");
  assert.ok(!/<img/.test(w.els.vLoading.innerHTML), '문구는 이스케이프해서 넣는다');
});

test('M2: loadCampaign — 502 HTML 은 「캠페인을 찾을 수 없어요」가 아니라 서버 일시 오류로 던진다', async () => {
  const w = world({ fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => { throw new SyntaxError('x'); } }), fns: ['loadCampaign', '_retryAfterMs', '_scheduleCampaign429Retry'] });
  w.run('let _campaignLoadPromise = null, _campaign429Retried = false, _campBooted = false, _gateMask = null, _pvStep = "pre";');
  w.sb.getSession = () => null;
  await assert.rejects(w.run('loadCampaign()'), (e) => e.server === true && /서버에 일시적인 문제/.test(e.message));
});

/* ───────────────────────── M3 · L2 · [참여하기] ───────────────────────── */
function applyWorld(fetchImpl, { recoverHold = false } = {}) {
  const w = world({ view: 'vPre', hold: null, fetchImpl, fns: ['_doApply', '_applyLostRecover', '_applyReasonText', '_isEndedRefusal', '_applyEndedMask'] });
  // ★ 결정 400(L4) — _doApply 의 거절 문구는 화면의 단일 사유표(_APPLY_REASON_TEXT)를 쓴다 → 같은 표를 함께 올린다(검사 뜻 그대로)
  { const a = SCRIPT.indexOf('const _APPLY_REASON_TEXT = {'); w.run(SCRIPT.slice(a, SCRIPT.indexOf('\n};', a) + 3)); }
  // ★ 결정 432 — _doApply 가 「끝났다」 거절(보관·모집 종료) 판정·덮기 함수를 부른다 → 그 표와 함수를 함께 올린다(검사 뜻 그대로)
  w.run((SCRIPT.match(/const _ENDED_REFUSALS = \[[^\]]*\];/) || [''])[0] + '\nlet _endedMask = null;');
  Object.assign(w.sb, {
    getSession: () => ({ name: '김예시', phone8: '00000000' }), needLogin() {}, onJoin() {}, hideOptSheet() {}, hideAcctSheet() {},
    isBlogCampaign: () => false, _isBlogUrl: () => true, _qtyViewsFor: () => null, _chainOn: () => false,
    _getAuthHeaders: () => ({ Authorization: 'Bearer r' }), activeP8: () => '', setActiveP8() {},
    setHold: (h) => { w.holds[h.phone8] = h; },
    loadCampaign: async () => { w.log.loadCampaign++; },
    enterJoined: async () => { w.log.enterJoined++; },
    recoverActiveHolds: async (p) => { w.log.recover.push(p); if (recoverHold) { w.holds['00000000'] = { phone8: '00000000', holdToken: 'srv' }; return true; } return false; },
    renderMissing() {}, openBlogSheet() {}, _renderGateBlocked() {}, _qtyRetryFromServer: () => false, renderAcctList() {}, _acctBlocked: {},
  });
  w.run('_camp = { state: "open" }; var _blogUrl = "";');
  return w;
}

test('L2: [참여하기] 응답이 끊겨도 서버에 자리가 잡혔으면 이어서 연다(다시 보내지 않는다)', async () => {
  const w = applyWorld(async () => { throw new TypeError('Failed to fetch'); }, { recoverHold: true });
  await w.run('_doApply("", null, 1)');
  assert.strictEqual(w.log.fetches.length, 1, '/apply 는 한 번만');
  assert.deepStrictEqual(w.log.recover, ['00000000'], '그 명의로 서버 자리를 한 번 받아 온다');
  assert.strictEqual(w.log.enterJoined, 1);
  assert.ok(w.log.toasts.some(t => /참여가 확인됐어요/.test(t)));
  assert.ok(w.log.toasts.every(t => !ENGLISH.test(t)));
});

test('L2·M3: 자리가 없으면(정말 못 닿음) 쉬운 말로 알리고 [참여하기]를 되살린다 — 「오류: Failed to fetch」 없음', async () => {
  const w = applyWorld(async () => { throw new TypeError('Failed to fetch'); });
  await w.run('_doApply("", null, 1)');
  assert.strictEqual(w.log.enterJoined, 0);
  assert.deepStrictEqual(w.log.toasts, ['인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.']);
  assert.strictEqual(w.els.joinBtn.disabled, false); assert.strictEqual(w.els.joinBtn.textContent, '참여하기');
});

test('M3·L2: 사유 없는 502 는 「지금은 참여할 수 없어요」(거절)가 아니라 서버 일시 오류 · 자리도 한 번 확인', async () => {
  const w = applyWorld(async () => ({ ok: false, status: 502, headers: {}, json: async () => { throw new SyntaxError('x'); } }));
  await w.run('_doApply("", null, 1)');
  assert.deepStrictEqual(w.log.toasts, ['서버에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요.']);
  assert.ok(!w.log.toasts.some(t => /참여할 수 없어요/.test(t)));
  assert.strictEqual(w.log.recover.length, 1);
});

test('M3: 진짜 거절(사유 있음)은 종전 문구 그대로 · 복구 조회 없음', async () => {
  const w = applyWorld(async () => res(409, { ok: false, reason: 'cutoff', error: '마감' }));
  await w.run('_doApply("", null, 1)');
  assert.deepStrictEqual(w.log.toasts, ['오늘 참여가 마감됐어요']);
  assert.strictEqual(w.log.recover.length, 0);
});

test('결정 432(M2): 보관 공고 거절(403 archived)이면 끝난 모습 — 옛 서버가 다시 open 을 줘도 [참여하기]를 되살리지 않는다', async () => {
  const w = applyWorld(async () => res(403, { ok: false, reason: 'archived', error: '모집이 종료된 공고입니다.' }));
  // 옛 서버: 다시 받아도 state open 그대로(종전 무한 반복의 원인)
  w.sb.loadCampaign = async () => { w.log.loadCampaign++; w.run('_camp = { state: "open" }; _applyEndedMask(_camp);'); };
  await w.run('_doApply("", null, 1)');
  assert.deepStrictEqual(w.log.toasts, ['모집이 종료됐어요']);
  assert.strictEqual(w.run('_camp.state'), 'closed');
  assert.strictEqual(w.run('_camp.stateReason'), 'archived');
  assert.ok(w.log.renderPre >= 1, '끝난 모습을 다시 그린다');
  assert.strictEqual(w.els.joinBtn.disabled, true, '[참여하기]를 되살리지 않는다');
  assert.strictEqual(w.log.recover.length, 0);
});

test('결정 432: 다시 열릴 수 있는 거절(cutoff)은 덮지 않는다 — 다시 받은 상태를 따른다', async () => {
  const w = applyWorld(async () => res(409, { ok: false, reason: 'cutoff', error: '마감' }));
  await w.run('_doApply("", null, 1)');
  assert.strictEqual(w.run('_endedMask'), null);
  assert.strictEqual(w.run('_camp.state'), 'open');
});

test('M4: [참여하기] 요청 칸은 종전 그대로(주소·본문·머리)', async () => {
  const w = applyWorld(async () => res(200, { ok: true, applicationId: 1, holdToken: 't', phone8: '00000000', expiresAt: 'x' }));
  await w.run('_doApply("opt1", null, 2)');
  const f = w.log.fetches[0];
  assert.strictEqual(f.url, 'http://api.test/api/campaign/c1/apply');
  assert.strictEqual(f.opts.method, 'POST');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f.opts.headers)), { 'Content-Type': 'application/json', Authorization: 'Bearer r' });
  assert.deepStrictEqual(JSON.parse(f.opts.body), { name: '김예시', phone: '00000000', phone8: '00000000', optionKey: 'opt1', purchaseQty: 2 });
  assert.strictEqual(w.log.enterJoined, 1);
});

test('M3: 다른 동작(개수·옵션 바꾸기·취소·본인 확인·Q&A·일반 모집 목록)도 영어 e.message 를 그대로 보이지 않는다', () => {
  for (const name of ['_doChangeQty', '_doChangeOption', 'onCancel', 'doVerify', 'onQnaSubmit', 'openPopGate']) {
    const body = grab(SCRIPT, name);
    assert.ok(/_campFetch\(/.test(body), name + ' 은 _campFetch 를 쓴다');
    assert.ok(!/e\.message/.test(body), name + ' 은 e.message 를 직접 보이지 않는다');
    assert.ok(/_campErrText\(e/.test(body), name + ' 은 실패 문구를 _campErrText(api.js 단일 출처) 로');
  }
});

test('351: 구매양식을 보던 중 예약된 다시 시도는 제출 중이면 틀을 다시 열지 않고 기다린다', async () => {
  let n = 0;
  const w = world({ view: 'vJoined', fetchImpl: async () => { n++; if (n === 1) throw new TypeError('Failed to fetch'); return res(200, { ok: true, application: {} }); } });
  await w.run('enterJoined()');
  w.sb.__submitting = true;
  await w.log.timers.pop().fn();
  assert.strictEqual(n, 1, '제출 중에는 다시 묻지 않는다(틀 다시 열기 = 제출 끊김)');
  assert.strictEqual(w.log.timers.pop().ms, 2000, '2초 뒤 다시 본다');
  w.sb.__submitting = false;
  await w.run('_retryEnterJoined()');
  assert.strictEqual(n, 2); assert.strictEqual(w.log.joinedView, 1);
});
