'use strict';
/* 결정 398 — 구매양식 제출이 「선택 명의 확인 중…」에서 영원히 멈추지 않는다.
 *
 * 사고(점검 2026-11-21 H2): 「캡처 없이 제출」의 무캡처 확인 요청이 끊기거나(TypeError) HTML 502(SyntaxError)를 받으면
 * 예외가 submitOrderForm 밖으로 던져져 `window._submitOrderFormInProgress` 가 true 로 남았다 → 버튼이 다시 안 풀리고,
 * 공고 화면(campaign.html `_formSubmitting`)은 "제출 중"으로 보고 만료 화면을 영영 미뤘다.
 *
 * 이 가드는 search-app.js 의 **실제 함수 본문**을 vm 에서 돌린다(문자열 검사 아님).
 *   ① 무캡처 확인 끊김 / HTML 502 / 무응답(시간 초과) → 제출 중 표시가 풀리고, 버튼이 살아나고, 쉬운 한국어 안내, 주문 전송 0
 *   ② 명의 문맥 조회 끊김·무응답도 같은 규칙(영어 'Failed to fetch' 노출 금지)
 *   ③ 제출 함수 안의 예기치 못한 예외도 표시를 푼다
 *   ④ 고장이 풀린 뒤 다시 누르면 주문은 정확히 한 번 나간다
 *   ⑤ 주문 요청을 이미 보냈고 결과를 모르면(끊김) 자동으로 다시 보내지 않는다 — [재제출]을 사람이 누른다(L6: 죽은 1회 재시도 제거)
 *   ⑥ 주문이 이미 접수된 뒤 예외가 나면 [제출]을 다시 살리지 않는다(이중 제출 금지) — 표시만 푼다
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SA = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const API = fs.readFileSync(path.resolve(__dirname, '../../frontend/api.js'), 'utf8');

function cut(source, name, required = true) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) { if (required) assert.fail('함수 없음: ' + name); return ''; }
  const ends = ['\nfunction ', '\nasync function '].map((x) => source.indexOf(x, start + 1)).filter((x) => x >= 0);
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, Math.min(...ends));
}

const NET_KO = /인터넷 연결이 불안정해요/;
const SERVER_KO = /서버에 일시적인 문제가 있어요/;
const SLOW_KO = /응답이 늦어지고 있어요/;
const RAW_EN = /Failed to fetch|Load failed|Unexpected token|not valid JSON|Internal Server Error/i;

function harness(opts = {}) {
  const nodes = {};
  const el = (value = '') => ({ value, src: '', style: {}, dataset: {}, innerHTML: '', textContent: '', disabled: false, hidden: false,
    classList: { add() {}, remove() {}, contains: () => false }, focus() {}, scrollIntoView() {}, setAttribute() {}, removeAttribute() {} });
  const fields = { orderer: '김예시', userId: 'shop-id', recipient: '김예시', phone: '010-0000-0000', address: '서울시 가짜로 1',
    price: '10000', orderNumber: 'ORD-1', memo: '', imgThumb: '' };
  for (const [k, v] of Object.entries(fields)) nodes['of_' + k] = el(v);
  nodes.of_imgThumb.src = '';           // 캡처 없음 → 무캡처 확인 경로
  nodes.of_bank = el('가짜은행'); nodes.of_account = el('000-000'); nodes.of_depositor = el('김예시');
  nodes.btnOrderFormSubmit = el(); nodes.orderIdentityAction = el();

  const toasts = [], alerts = [], submits = [], fetchLog = [], posted = [];
  const timers = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams, AbortController, JSON, Promise, Date, Math, Object, Array, String, Number, Set, Error, SyntaxError, TypeError,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = null; },
    location: { search: '?embed=1&mode=form', href: '' },
    API_BASE_URL: 'https://fake.invalid',
    _dualPurchaseController: null, _dualPurchaseLoading: false, _PREVIEW_MODE: false,
    _EMBED_CTX: { campId: 'fx_single', app: 'app_1', holdToken: 'hold_1', holdPhone8: '00000000' },
    _BATCH: null, _activeIdentityContext: opts.contextLoaded === false ? null : { ok: true, selectedIdentity: { name: '김예시' } },
    _identityContextPromise: null, _orderInfoSuggestions: [],
    _orderCardIds: ['of'], _cardAiState: { of: {} }, _selectedOptKey: '', _reviewerSelectedOptions: null,
    _OFP: { pick: {}, capName: {}, capOpt: {} },
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => null },
    sessionStorage: { removeItem() {} }, _EMBED_FORM_KEY: '', _EMBED_FORM_ID_KEY: '',
    _popularGateBeforeSubmit: async () => true, _optionFullBeforeSubmit: async () => true,
    _syncAllSharedBeforeSubmit: opts.syncThrows ? () => { throw new TypeError("Cannot read properties of undefined (reading 'value')"); } : () => {},
    _batchIdentityGuard: () => true, _ordererPickerOn: () => true, _ofpActive: () => false, _validateIncomeInput: () => true,
    _validateCardIncomeInput: () => ({ ok: true }), _ofShowError() {}, _ofReveal: (x) => x, _buildReviewerOptKey: () => '',
    _runIdentityPrecheck: async () => true, _syncSubmissionIdentityAction() {}, _renderIdentityHead() {},
    _renderSavedOrderInfoPickers() {}, _renderOrderInfoSuggestions() {}, _renderAddressTools() {},
    _renderIdentityMatchState() {}, _renderCaptureChecklist() {}, _batchClearDraft() {}, _getReviewerSession: () => null,
    _safeText: (v) => String(v), _getAuthHeaders: () => ({}),
    showToast: (m, t) => toasts.push({ m: String(m), t }), showCenterAlert: (m) => alerts.push(String(m)),
    _embedPost: (m) => posted.push(m), confirm: () => { throw new Error('예상치 못한 확인 창'); },
    gasPost: async (p) => {
      if (p.action === 'findSlot') return { ok: true, mode: 'append' };
      submits.push(p);
      return opts.gasPost ? opts.gasPost(p, submits.length) : { ok: true, campaignHold: 'confirmed', orderSubmissionId: 'os_1', captureSession: { id: 'c', token: 't' } };
    },
    fetch: (url, init) => {
      fetchLog.push(url);
      const h = opts.fetch && opts.fetch(url, init);
      if (h) return h;
      if (/order-identity-context/.test(url)) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, selectedIdentity: { name: '김예시' } }) });
      if (/manual-confirm/.test(url)) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, approvalToken: 'manual-ok' }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
  };
  ctx.window = ctx; ctx.parent = ctx;
  ctx.window._captureSkipped = true;        // [캡처 없이 제출] 을 고른 상태
  ctx.window._slotAuth = {};
  ctx.window._orderFormCtx = {};
  vm.createContext(ctx);
  // 결정 398 단일 출처(api.js) — 화면과 같은 문구표를 쓴다.
  vm.runInContext(cut(API, 'apiFriendlyErrorMessage'), ctx);
  const names = ['_reviewerIdentityRequestBody', '_loadOrderIdentityContext', '_prepareIdentityApprovals', 'submitOrderForm',
    'confirmOrderSubmit', '_closeOrderConfirm', '_proceedOrderSubmit', '_openOrderConfirm', '_cardsMissingCapture', '_finishPreviewSubmit'];
  // 새 도우미(없으면 옛 코드 — 동작으로 실패해야 한다)
  const optional = ['_ofFriendlyErr', '_ofPostJson', '_submitOrderFormEscaped',
    // 결정 399: confirmOrderSubmit·_openOrderConfirm 이 부르는 틀 안 자리 잡기 도우미(틀 밖에서는 무동작 · 검사 의미 불변)
    '_ofVisibleBand', '_ofFrameApply', '_ofFrameIsOpen', '_ofFrameReplaceAll', '_ofFrameUnwatch', '_ofFrameWatch', '_ofFramePlace'];
  for (const n of names) { const src = cut(SA, n, false); if (src) vm.runInContext(src, ctx); }
  for (const n of optional) { const src = cut(SA, n, false); if (src) vm.runInContext(src, ctx); }
  const fireTimers = (minMs = 1000) => { for (const t of timers) if (t.f && t.ms >= minMs) { const f = t.f; t.f = null; f(); } };
  return { ctx, nodes, toasts, alerts, submits, fetchLog, posted, fireTimers };
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle(p, rounds = 30) {
  let state = 'pending', value;
  p.then((v) => { state = 'resolved'; value = v; }, (e) => { state = 'rejected'; value = e; });
  for (let i = 0; i < rounds && state === 'pending'; i++) await tick();
  return { state, value };
}
function assertUnstuck(h, label) {
  assert.equal(h.ctx.window._submitOrderFormInProgress, false, label + ': 「제출 중」 표시가 남아 공고 화면이 만료를 영영 미룬다');
  assert.equal(h.nodes.btnOrderFormSubmit.disabled, false, label + ': 제출 버튼이 잠긴 채로 남는다');
  assert.ok(!/명의 확인 중|처리 중|제출 중/.test(h.nodes.btnOrderFormSubmit.innerHTML), label + ': 버튼 글자가 진행 중으로 남는다 — ' + h.nodes.btnOrderFormSubmit.innerHTML);
}

const netDrop = () => Promise.reject(new TypeError('Failed to fetch'));
const html502 = () => Promise.resolve({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token \'<\', "<!DOCTYPE html>" is not valid JSON'); } });
const hang = (url, init) => new Promise((_, rej) => {
  if (init && init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
});

for (const [label, fail, msg] of [['끊김', netDrop, NET_KO], ['HTML 502', html502, SERVER_KO]]) {
  test(`① 무캡처 확인 ${label} → 표시 풀림 · 버튼 살아남 · 한국어 안내 · 주문 전송 0`, async () => {
    const h = harness({ fetch: (url) => (/manual-confirm/.test(url) ? fail() : null) });
    const r = await settle(h.ctx.submitOrderForm());
    assert.equal(r.state, 'resolved', '제출 함수가 예외로 끝나면 부르는 쪽(confirmOrderSubmit·_proceedOrderSubmit)이 받지 않는다: ' + (r.value && r.value.message));
    assertUnstuck(h, label);
    assert.equal(h.submits.length, 0, '확인을 못 했는데 주문이 나갔다');
    const shown = h.toasts.map((t) => t.m).join(' | ');
    assert.match(shown, msg, '쉬운 한국어 안내가 없다: ' + shown);
    assert.ok(!RAW_EN.test(shown), '개발자 영어가 리뷰어에게 보인다: ' + shown);
    assert.ok(h.toasts.some((t) => t.t === 'error'), '오류 안내가 아니다');
  });
}

test('① 무캡처 확인 무응답 → 시간 제한으로 끊고 표시를 푼다', async () => {
  const h = harness({ fetch: (url, init) => (/manual-confirm/.test(url) ? hang(url, init) : null) });
  const p = h.ctx.submitOrderForm();
  await settle(Promise.race([p, new Promise((r) => setTimeout(r, 5))]), 10);
  assert.equal(h.ctx.window._submitOrderFormInProgress, true, '전제: 요청 중에는 「제출 중」');
  h.fireTimers(5000);                       // 시간 제한 도달
  const r = await settle(p);
  assert.equal(r.state, 'resolved', '무응답이면 제출이 영원히 끝나지 않는다');
  assertUnstuck(h, '무응답');
  assert.equal(h.submits.length, 0);
  assert.match(h.toasts.map((t) => t.m).join(' | '), SLOW_KO);
});

test('② 명의 문맥 조회 끊김·무응답도 영어 없이 한국어 안내 · 표시 풀림', async () => {
  {
    const h = harness({ contextLoaded: false, fetch: (url) => (/order-identity-context/.test(url) ? netDrop() : null) });
    const r = await settle(h.ctx.submitOrderForm());
    assert.equal(r.state, 'resolved');
    assertUnstuck(h, '문맥 끊김');
    const shown = h.toasts.map((t) => t.m).join(' | ');
    assert.match(shown, NET_KO, shown);
    assert.ok(!RAW_EN.test(shown), shown);
    assert.equal(h.submits.length, 0);
    assert.equal(h.ctx._identityContextPromise, null, '실패한 조회를 붙잡아 두면 다시 눌러도 같은 실패만 돌려준다');
  }
  {
    const h = harness({ contextLoaded: false, fetch: (url, init) => (/order-identity-context/.test(url) ? hang(url, init) : null) });
    const p = h.ctx.submitOrderForm();
    await settle(Promise.race([p, new Promise((r) => setTimeout(r, 5))]), 10);
    h.fireTimers(5000);
    const r = await settle(p);
    assert.equal(r.state, 'resolved', '명의 문맥이 무응답이면 「선택 명의 확인 중」에서 멈춘다');
    assertUnstuck(h, '문맥 무응답');
    assert.match(h.toasts.map((t) => t.m).join(' | '), SLOW_KO);
  }
});

test('③ 제출 함수 안의 예기치 못한 예외도 표시를 푼다(주문 전송 전)', async () => {
  const h = harness({ syncThrows: true });
  const r = await settle(h.ctx.submitOrderForm());
  assert.equal(r.state, 'resolved');
  assertUnstuck(h, '예외');
  assert.equal(h.submits.length, 0);
  const shown = h.toasts.map((t) => t.m).join(' | ');
  assert.ok(shown && !/Cannot read properties/.test(shown), '안내가 없거나 개발자 문구다: ' + shown);
});

test('④ 고장이 풀린 뒤 다시 누르면 주문은 정확히 한 번 나간다', async () => {
  let broken = true;
  const h = harness({ fetch: (url) => (/manual-confirm/.test(url) && broken ? netDrop() : null) });
  await settle(h.ctx.submitOrderForm());
  assertUnstuck(h, '첫 실패');
  broken = false;
  const r = await settle(h.ctx.submitOrderForm());
  assert.equal(r.state, 'resolved');
  assert.equal(h.submits.length, 1, '주문 전송 횟수');
  assert.equal(h.submits[0].identityApprovalToken, 'manual-ok');
  assert.equal(h.ctx.window._submitOrderFormInProgress, false);
  assert.ok(h.posted.some((m) => m.type === 'order-submitted' && m.successCount === 1), '공고 화면에 제출 완료를 알리지 않았다');
});

test('⑤ 주문 요청 결과를 모르면(끊김·예외) 자동으로 다시 보내지 않는다 — [재제출]은 사람이 누른다', async () => {
  for (const [label, impl] of [
    ['networkError 응답', () => ({ ok: false, networkError: true, error: '인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.' })],
    ['gasPost 예외', () => { throw new TypeError('Failed to fetch'); }],
  ]) {
    const h = harness({ gasPost: impl });
    const r = await settle(h.ctx.submitOrderForm());
    assert.equal(r.state, 'resolved', label);
    assert.equal(h.submits.length, 1, label + ': 결과를 모르는 주문을 화면이 스스로 다시 보냈다(이중 제출 위험)');
    assert.equal(h.ctx.window._submitOrderFormInProgress, false, label);
    assert.equal(h.nodes.btnOrderFormSubmit.disabled, false, label);
    assert.match(h.nodes.btnOrderFormSubmit.innerHTML, /재제출/, label + ': 실패 뒤 [재제출] 이 아니다');
    assert.ok(h.alerts.length >= 1, label + ': 실패 안내가 없다');
  }
});

test('⑥ 주문이 접수된 뒤 예외가 나면 [제출]을 다시 살리지 않는다 — 표시만 푼다', async () => {
  const src = cut(SA, '_submitOrderFormEscaped', false);
  assert.ok(src, '제출 밖으로 던져진 예외를 받는 도우미(_submitOrderFormEscaped)가 없다');
  const h = harness();
  h.ctx.window._submitOrderFormInProgress = true;
  h.nodes.btnOrderFormSubmit.disabled = true; h.nodes.btnOrderFormSubmit.innerHTML = '제출 중... (1/1)';
  let reset = 0;
  h.ctx._submitOrderFormEscaped(new TypeError('x is not a function'), { sent: true, okCount: 1, resetBtn: () => { reset++; } });
  assert.equal(reset, 0, '이미 접수된 주문의 [제출] 을 다시 살렸다');
  assert.equal(h.ctx.window._submitOrderFormInProgress, false);
  assert.equal(h.nodes.btnOrderFormSubmit.disabled, true);
  assert.match(h.toasts.map((t) => t.m).join(' | '), /다시 제출하지 마세요/);
  // 이미 정리된 뒤(완료 화면 이후)의 예외는 건드리지 않는다
  const h2 = harness();
  h2.ctx.window._submitOrderFormInProgress = false;
  h2.ctx._submitOrderFormEscaped(new Error('late'), { sent: true, okCount: 1, resetBtn: () => { reset++; } });
  assert.equal(reset, 0); assert.equal(h2.toasts.length, 0);
});

test('정적: 무캡처 확인·명의 문맥은 시간 제한 있는 도우미로 · 제출 본문은 예외를 받는다 · 죽은 1회 재시도 없음', () => {
  const prep = cut(SA, '_prepareIdentityApprovals');
  assert.ok(!/await fetch\(/.test(prep), '_prepareIdentityApprovals 에 맨 fetch 가 남았다(끊김·HTML 502 가 밖으로 던져진다)');
  assert.match(prep, /_ofPostJson\("\/api\/reviewer\/order-identity-match\/manual-confirm"/);
  const ctxLoad = cut(SA, '_loadOrderIdentityContext');
  assert.ok(!/await fetch\(/.test(ctxLoad), '_loadOrderIdentityContext 에 맨 fetch 가 남았다');
  const helper = cut(SA, '_ofPostJson');
  assert.match(helper, /AbortController/); assert.match(helper, /clearTimeout/);
  const submit = cut(SA, 'submitOrderForm');
  assert.match(submit, /\} catch \(_sofErr\) \{\s*\n\s*_submitOrderFormEscaped\(_sofErr, \{ sent: _sofSent, okCount: successCount, resetBtn: _resetBtn \}\);/);
  assert.ok(!/gasPost 실패/.test(submit) && !/재시도 \(1회/.test(submit), '실행되지 않는 1회 재시도 분기가 남았다');
  // 진행 표시는 여전히 한 곳에서 켜고, 이중 제출 가드는 그대로다
  assert.equal((submit.match(/window\._submitOrderFormInProgress = true;/g) || []).length, 1);
  assert.match(submit, /if \(window\._submitOrderFormInProgress\) \{ console\.warn\("\[submitOrderForm\] 진행 중 — 무시"\); return; \}/);
});

test('계층(class): 제출 버튼에서 기다리는 요청에 맨 fetch 가 없다 — 명의 문맥 · 무캡처 확인 · [내 주문이 맞습니다] · 아이디 저장', () => {
  for (const name of ['_loadOrderIdentityContext', '_prepareIdentityApprovals', '_manualConfirmIdentity', '_saveOrderShoppingIdIfRequested', 'submitOrderForm']) {
    const body = cut(SA, name);
    assert.ok(!/await fetch\(/.test(body), name + ' 에 시간 제한 없는 맨 fetch 가 남았다');
    assert.ok(!/await response\.json\(\)/.test(body), name + ' 에 예외를 던지는 response.json() 이 남았다');
  }
  assert.match(cut(SA, '_saveOrderShoppingIdIfRequested'), /_ofPostJson\([\s\S]{0,200}"PATCH"\)/);
});

test('_ofPostJson: 끊김·HTML 502·무응답은 예외 없이 error 문구 · 정상·서버 거절은 그대로 · method 전달', async () => {
  const h = harness();
  const calls = [];
  const run = async (impl, method) => { h.ctx.fetch = (url, init) => { calls.push(init.method); return impl(url, init); }; return h.ctx._ofPostJson('/api/x', { a: 1 }, 20000, method); };
  let r = await run(netDrop);
  assert.equal(r.data, null); assert.match(r.error, NET_KO);
  r = await run(html502);
  assert.equal(r.response.status, 502); assert.match(r.error, SERVER_KO);
  const p = run(hang); await tick(); h.fireTimers(5000); r = await p;
  assert.match(r.error, SLOW_KO);
  r = await run(() => Promise.resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: 'IDENTITY_MISMATCH', error: '캡처의 주문자가 참여한 명의와 다릅니다.' }) }));
  assert.equal(r.error, ''); assert.equal(r.response.status, 409); assert.equal(r.data.code, 'IDENTITY_MISMATCH', '서버가 준 판정을 가리면 안 된다');
  r = await run(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, approvalToken: 'x' }) }), 'PATCH');
  assert.equal(r.error, ''); assert.equal(r.data.approvalToken, 'x');
  assert.deepEqual(calls, ['POST', 'POST', 'POST', 'POST', 'PATCH']);
});

test('_ofFriendlyErr: 옛 api.js(문구 함수 없음)여도 한국어로 접는다 · 서버 한국어 사유는 그대로', () => {
  const ctx = {}; vm.createContext(ctx); vm.runInContext(cut(SA, '_ofFriendlyErr'), ctx);
  assert.match(ctx._ofFriendlyErr(new TypeError('Failed to fetch')), NET_KO);
  assert.equal(ctx._ofFriendlyErr(new Error('x'), '다시 눌러 주세요'), '다시 눌러 주세요');
  const h = harness();
  assert.equal(h.ctx._ofFriendlyErr('참여 시간이 지났어요.', 'fb'), '참여 시간이 지났어요.');
  assert.match(h.ctx._ofFriendlyErr(new TypeError('Load failed'), 'fb'), NET_KO);
});

/* 결정 399(사용자 추가 요청 2026-11-23): 제출 앞단에서 멈춘 뒤(결정 398 길) 버튼은 누르기 전 글자 그대로 —
 *   예전엔 기본값 '제출' 로 되돌려 [구매양식 제출] 이 [제출] 로 바뀌었다. [재제출] 처럼 글자를 넘기는 길은 그대로(⑤ 에서 확인). */
test('⑦ 앞단 실패 뒤 버튼 글자 = 누르기 전 글자([구매양식 제출]) · 이미 [재제출] 이었으면 그 글자·색 그대로', async () => {
  const ORIG = '\n        <i class="fas fa-paper-plane"></i> 구매양식 제출\n      ';
  {
    const h = harness({ fetch: (url) => (/manual-confirm/.test(url) ? netDrop() : null) });
    h.nodes.btnOrderFormSubmit.innerHTML = ORIG;
    const r = await settle(h.ctx.submitOrderForm());
    assert.equal(r.state, 'resolved');
    assertUnstuck(h, '앞단 끊김');
    assert.equal(h.nodes.btnOrderFormSubmit.innerHTML, ORIG, '버튼 글자가 누르기 전과 다르다: ' + h.nodes.btnOrderFormSubmit.innerHTML);
  }
  {
    const RETRY = '<i class="fas fa-redo"></i> 재제출';
    const h = harness({ fetch: (url) => (/manual-confirm/.test(url) ? netDrop() : null) });
    h.nodes.btnOrderFormSubmit.innerHTML = RETRY;
    h.nodes.btnOrderFormSubmit.style.background = '#DC2626'; h.nodes.btnOrderFormSubmit.style.color = '#fff';
    await settle(h.ctx.submitOrderForm());
    assertUnstuck(h, '재제출 뒤 앞단 끊김');
    assert.equal(h.nodes.btnOrderFormSubmit.innerHTML, RETRY);
    assert.equal(h.nodes.btnOrderFormSubmit.style.background, '#DC2626', '[재제출] 의 빨간 모양이 사라졌다');
  }
  // 틀 안: 명의 확인 줄 맞추기(_syncSubmissionIdentityAction)가 할 일이 없으면 글자를 '제출' 로 덮는다(실측 2026-11-23) → 누르기 전 글자로
  for (const [after, want] of [['제출', ORIG], ['내 주문이 맞습니다', '내 주문이 맞습니다']]) {
    const h = harness({ fetch: (url) => (/manual-confirm/.test(url) ? netDrop() : null) });
    const b = h.nodes.btnOrderFormSubmit;
    b.innerHTML = ORIG;
    h.ctx._syncSubmissionIdentityAction = () => { b.textContent = after; b.innerHTML = after; };
    await settle(h.ctx.submitOrderForm());
    assertUnstuck(h, '틀 안 앞단 끊김');
    assert.equal(b.innerHTML, want, `명의 확인 줄이 '${after}' 일 때 버튼 글자: ${b.innerHTML}`);
  }
});
