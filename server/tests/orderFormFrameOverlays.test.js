'use strict';
/* 결정 399 — 공고 화면 틀(iframe) 안 구매양식의 확인 창·토스트를 「지금 리뷰어에게 보이는 자리」에 놓는다.
 *
 * 사고(점검 2026-11-21 M1 · 실기 안드로이드 크롬 + 아이폰 사파리): 틀은 내용 높이만큼 길어서(400~4,000px) 틀 안
 * position:fixed 창은 틀 전체의 가운데(화면 위 밖)에, 토스트는 틀 맨 아래(화면 아래 밖)에 그려졌다.
 * [구매양식 제출]을 캡처 없이 누르면 화면이 어두워지기만 하고 「구매 캡처가 없습니다」 창은 보이지 않았다(top ≈ −175..−232px).
 * L5: showToast 가 두 벌이라 `showToast(…, true)`(오류) 가 검은 일반 안내로, "warn" 은 없는 모양으로 떴다.
 * L3: 아주 긴 캡처를 [전체 보기]로 펼치면 양식이 4,000px 상한을 넘어 제출 버튼이 틀 속 스크롤로 숨었다.
 *
 * 이 가드는 search-app.js 의 **실제 함수 본문**을 vm 에서 돌린다(가짜 부모 화면 · 가짜 틀 위치). 창 카드가 놓이는 자리는
 * 덮개의 안쪽 여백 + 정렬(가운데)로 계산한다 — 브라우저 배치 규칙 그대로(덮개 inset:0, align-items:center).
 *   ① 틀 안 [제출](캡처 없음) → 「구매 캡처가 없습니다」 창 카드 전체가 보이는 자리(부모 머리·남은 시간 줄 아래) 안
 *   ② [캡처 없이 제출] → 「잠깐만요!」 창도 같은 자리 · 부모 화면을 스크롤하면 따라온다 · 닫으면 따라가기를 멈춘다
 *   ③ 안드로이드형 키보드(visualViewport offsetTop) · 아이폰형(rect 가 보이는 영역 기준) 둘 다 같은 식으로 맞는다
 *   ④ 토스트는 보이는 자리 아래 끝 위(사진 구획을 보고 있을 때 · 제출 버튼 근처일 때)
 *   ⑤ showToast 하나: true → 오류 · "warn" → warning · api.js 오류 안내도 빨간 오류
 *   ⑥ 틀 안 긴 캡처 [전체 보기] → 펼친 사진 칸 높이 제한(그 안에서 넘겨 보기) · 한 번에 하나
 *   ⑦ 직접 링크(틀 아님) → 창·토스트·사진 칸 모양이 종전 그대로(값을 하나도 넣지 않는다)
 *   ⑧ 화면 고정 창을 만드는 함수는 모두 공용 도우미를 부른다(새 창이 빠지면 여기서 걸린다)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SA = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const API = fs.readFileSync(path.resolve(__dirname, '../../frontend/api.js'), 'utf8');
const HTML = fs.readFileSync(path.resolve(__dirname, '../../frontend/search.html'), 'utf8');
const CAMP = fs.readFileSync(path.resolve(__dirname, '../../frontend/campaign.html'), 'utf8');

function cutAt(source, start) {
  const ends = ['\nfunction ', '\nasync function '].map((x) => source.indexOf(x, start + 1)).filter((x) => x >= 0);
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, Math.min(...ends));
}
function cut(source, name, required = true) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) { if (required) assert.fail('함수 없음: ' + name); return ''; }
  return cutAt(source, start);
}
/** 같은 이름이 여러 번 정의돼 있으면 모두(앞에서부터) — 페이지처럼 뒤의 것이 이긴다. */
function cutAll(source, name) {
  const out = []; let i = -1;
  while ((i = source.indexOf('\nfunction ' + name + '(', i + 1)) >= 0) out.push(cutAt(source, i + 1));
  return out;
}

/* ── 가짜 DOM ─────────────────────────────────────────────────────────── */
function makeStyle(init = {}) {
  const st = { ...init };
  Object.defineProperty(st, 'setProperty', { value(k, v) { st[k] = String(v); st[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); } });
  Object.defineProperty(st, 'removeProperty', { value(k) { delete st[k]; delete st[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]; } });
  Object.defineProperty(st, 'getPropertyValue', { value(k) { return st[k] || ''; } });
  return st;
}
function makeDom() {
  const all = [];
  class El {
    constructor(tag, opts = {}) {
      this.tagName = String(tag).toUpperCase(); this.id = opts.id || ''; this.className = opts.className || '';
      this.style = makeStyle(opts.style || {}); this.dataset = {}; this.attrs = {}; this.children = []; this.parentNode = null;
      this.hidden = false; this._html = ''; this.textContent = ''; this.src = '';
      this.css = { paddingTop: '20px', paddingBottom: '20px', bottom: 'auto', display: 'block', overflowY: 'visible', ...(opts.css || {}) };
      this.h = opts.h || 0; this.scrolled = 0;
      all.push(this);
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {   // 크게 보기 단추 안의 <img>·<span> 만 흉내
      this._html = String(v); this.children = [];
      if (/<img/.test(this._html)) this.appendChild(new El('img'));
      if (/<span/.test(this._html)) this.appendChild(new El('span'));
    }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === body; }
    get firstElementChild() { return this.children[0] || null; }
    get childElementCount() { return this.children.length; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children = p.children.filter((x) => x !== this); this.parentNode = null; } }
    after(c) { const p = this.parentNode; c.parentNode = p; p.children.splice(p.children.indexOf(this) + 1, 0, c); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    querySelector(sel) { return this.children.find((c) => c.tagName.toLowerCase() === sel) || null; }
    querySelectorAll() { return []; }
    addEventListener() {} removeEventListener() {} focus() {}
    scrollIntoView() { this.scrolled++; }
    getBoundingClientRect() { return { top: 0, bottom: this.h, height: this.h }; }
  }
  const body = new El('body');
  const doc = {
    body,
    getElementById: (id) => all.find((e) => e.id === id && e.isConnected) || null,
    createElement: (t) => new El(t),
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '[data-of-framed]') return all.filter((e) => e.isConnected && e.hasAttribute('data-of-framed'));
      if (sel === '.of-img-big') return all.filter((e) => e.isConnected && e.className === 'of-img-big');
      if (sel === '.of-img-big:not([hidden])') return all.filter((e) => e.isConnected && e.className === 'of-img-big' && !e.hidden);
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };
  const getComputedStyle = (el) => ({
    paddingTop: el.style['padding-top'] || el.style.paddingTop || el.css.paddingTop,
    paddingBottom: el.style['padding-bottom'] || el.style.paddingBottom || el.css.paddingBottom,
    bottom: el.style.bottom || el.css.bottom,
    display: el.style.display || el.css.display,
    overflowY: el.style.overflowY || el.css.overflowY,
  });
  return { El, body, doc, getComputedStyle };
}

/* 가짜 부모 화면(공고 화면): 머리 .hd 0~64 · 남은 시간 .holdbar 64~113 (둘 다 위에 붙어 있음) */
function makeParent({ innerHeight = 844, vv = { height: 844, pageTop: 0, offsetTop: 0 }, docTop = 0, bars = [[0, 64], [64, 113]] } = {}) {
  const listeners = [];
  const mk = (name) => ({ addEventListener: (ev, fn) => listeners.push({ t: name, ev, fn }),
    removeEventListener: (ev, fn) => { const i = listeners.findIndex((l) => l.t === name && l.ev === ev && l.fn === fn); if (i >= 0) listeners.splice(i, 1); } });
  const pw = { innerHeight, scrollY: 0, ...mk('window') };
  pw.visualViewport = { ...vv, ...mk('vv') };
  pw.state = { docTop, bars };
  pw.document = {
    documentElement: { getBoundingClientRect: () => ({ top: pw.state.docTop }) },
    querySelectorAll: (sel) => {
      assert.ok(/\.hd/.test(sel) && /\.holdbar/.test(sel), '부모 머리·남은 시간 줄을 찾지 않는다: ' + sel);
      return pw.state.bars.map(([t, b]) => ({ getBoundingClientRect: () => ({ top: t, bottom: b, height: b - t }) }));
    },
  };
  pw.fire = (name, ev) => listeners.filter((l) => (!name || l.t === name) && (!ev || l.ev === ev)).forEach((l) => l.fn());
  pw.listeners = listeners;
  return pw;
}

/** framed: { parent, frameTop, frameH } · 없으면 직접 링크(틀 아님). */
function harness({ framed = null } = {}) {
  const dom = makeDom();
  const { El, body, doc } = dom;
  const toastC = body.appendChild(new El('div', { id: 'toastContainer', css: { bottom: '24px' } }));
  const mkModal = (id) => {
    const ov = body.appendChild(new El('div', { id, className: 'of-modal-overlay', style: { display: 'none' }, css: { paddingTop: '20px', paddingBottom: '20px' } }));
    ov.appendChild(new El('div', { className: 'of-modal-card', h: 345 }));
    return ov;
  };
  const gate = mkModal('captureGateModal');
  const confirmM = mkModal('orderConfirmModal');
  body.appendChild(new El('div', { id: 'captureGateMsg' }));
  body.appendChild(new El('div', { id: 'of' }));          // 주문 카드(캡처 없음)
  const thumb = body.appendChild(new El('img', { id: 'of_imgThumb' }));
  const btn = body.appendChild(new El('button', { id: 'btnOrderFormSubmit' }));
  const timers = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, JSON, Math, Object, Array, String, Number, Promise, Error, Set,
    document: doc, getComputedStyle: dom.getComputedStyle,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: (f) => { f(); return 0; },
    escHtml: (s) => String(s), location: { href: 'http://x/search.html', search: '?embed=1&mode=form' },
    _orderCardIds: ['of'], _PREVIEW_MODE: false, _EMBED_CTX: framed ? { campId: 'fx_single' } : null,
    submitOrderForm: () => { ctx.submitted = (ctx.submitted || 0) + 1; },
    _ofReveal: (x) => x,
  };
  ctx.window = ctx;
  ctx.innerHeight = framed ? framed.frameH : 844;
  ctx.innerWidth = 390;
  const winListeners = [];
  ctx.addEventListener = (ev, fn) => winListeners.push({ ev, fn });
  ctx.removeEventListener = (ev, fn) => { const i = winListeners.findIndex((l) => l.ev === ev && l.fn === fn); if (i >= 0) winListeners.splice(i, 1); };
  if (framed) {
    ctx.parent = framed.parent;
    ctx.frameElement = { clientTop: 0, getBoundingClientRect: () => ({ top: framed.frameTop, bottom: framed.frameTop + framed.frameH, height: framed.frameH }) };
  } else {
    ctx.parent = ctx; ctx.frameElement = null;
    ctx.visualViewport = { height: 844, addEventListener() {}, removeEventListener() {} };
  }
  vm.createContext(ctx);
  const m = /const _OF_PARENT_TOP_BARS = [^\n]+\n/.exec(SA);
  if (m) vm.runInContext(m[0], ctx);
  const required = ['_ofVisibleBand', 'confirmOrderSubmit', '_openOrderConfirm', '_closeOrderConfirm', '_closeCaptureGate', '_captureGateSkip',
    '_cardsMissingCapture', '_ofViewCapture'];
  const optional = ['_ofFrameApply', '_ofFrameIsOpen', '_ofFrameReplaceAll', '_ofFrameUnwatch', '_ofFrameWatch', '_ofFramePlace',
    '_ofFramePlaceToast', '_toastType', '_ofCapBigInFrame'];
  for (const n of required) vm.runInContext(cut(SA, n), ctx);
  for (const n of optional) { const src = cut(SA, n, false); if (src) vm.runInContext(src, ctx); }
  for (const src of cutAll(SA, 'showToast')) vm.runInContext(src, ctx);   // 페이지처럼 뒤의 정의가 이긴다
  return { ctx, dom, gate, confirmM, toastC, thumb, btn, timers, winListeners };
}

/** 덮개(inset:0 · align-items:center) 안에서 카드가 실제로 놓이는 자리 = 안쪽 여백 사이의 가운데. */
function cardBox(ov, H) {
  const cs = (k, d) => { const v = ov.style[k]; return v == null ? d : parseFloat(v); };
  const pt = cs('padding-top', 20), pb = cs('padding-bottom', 20);
  const card = ov.firstElementChild;
  const mh = card.style['max-height'] != null ? parseFloat(card.style['max-height']) : Infinity;
  const h = Math.min(card.h, mh);
  const mid = (pt + (H - pb)) / 2;
  return { top: mid - h / 2, bottom: mid + h / 2, h };
}
function assertInside(box, band, label) {
  assert.ok(box.top >= band.top - 0.5 && box.bottom <= band.bottom + 0.5,
    `${label}: 창 카드(${Math.round(box.top)}~${Math.round(box.bottom)})가 보이는 자리(${band.top}~${band.bottom}) 밖이다`);
}

/* 휴대폰 390×844 · 틀 2,284px · 부모를 내려 틀 윗변이 화면 위 −1,200 (제출 버튼이 보이는 아래쪽) */
const PHONE = () => ({ parent: makeParent({ docTop: -1500 , vv: { height: 844, pageTop: 1500, offsetTop: 0 } }), frameTop: -1200, frameH: 2284 });
// 보이는 자리(틀 좌표) = 머리·남은 시간 줄 아래(113) ~ 화면 아래(844) → 틀 기준 1313 ~ 2044
const PHONE_BAND = { top: 113 + 1200, bottom: 844 + 1200 };

test('① 틀 안 [제출](캡처 없음) → 「구매 캡처가 없습니다」 창이 보이는 자리 안(머리·남은 시간 줄 아래)', () => {
  const fr = PHONE();
  const h = harness({ framed: fr });
  h.ctx.confirmOrderSubmit();
  assert.equal(h.gate.style.display, 'flex', '캡처 게이트가 열리지 않았다');
  assertInside(cardBox(h.gate, fr.frameH), PHONE_BAND, '캡처 게이트');
});

test('② [캡처 없이 제출] → 「잠깐만요!」 창도 보이는 자리 · 부모 스크롤을 따라온다 · 닫으면 따라가기 멈춤', () => {
  const fr = PHONE();
  const h = harness({ framed: fr });
  h.ctx.confirmOrderSubmit();
  h.ctx._captureGateSkip();
  assert.equal(h.gate.style.display, 'none');
  assert.equal(h.confirmM.style.display, 'flex', '확인 창이 열리지 않았다');
  assertInside(cardBox(h.confirmM, fr.frameH), PHONE_BAND, '확인 창');
  // 리뷰어가 부모 화면을 200px 위로 올림 → 틀 윗변 −1,000 · 문서 윗변 −1,300
  fr.frameTop = -1000; fr.parent.state.docTop = -1300; fr.parent.visualViewport.pageTop = 1300;
  fr.parent.fire('window', 'scroll');
  assertInside(cardBox(h.confirmM, fr.frameH), { top: 113 + 1000, bottom: 844 + 1000 }, '스크롤 뒤 확인 창');
  h.ctx._closeOrderConfirm();
  fr.parent.fire('window', 'scroll');
  assert.equal(fr.parent.listeners.length, 0, '창을 닫았는데 부모 화면 스크롤을 계속 듣는다');
});

test('③ 키보드가 뜬 보이는 영역 — 안드로이드형(offsetTop) · 아이폰형(rect 가 보이는 영역 기준) 둘 다', () => {
  // 안드로이드: 화면 틀 스크롤 1,000 · 보이는 영역이 그보다 300 아래(offsetTop) · 높이 450 · 위 붙은 줄은 화면 틀 맨 위(가려진 곳)
  {
    const parent = makeParent({ docTop: -1000, vv: { height: 450, pageTop: 1300, offsetTop: 300 } });
    const fr = { parent, frameTop: -700, frameH: 2284 };
    const h = harness({ framed: fr });
    const b = h.ctx._ofVisibleBand();
    assert.deepStrictEqual({ top: Math.round(b.top), bottom: Math.round(b.bottom) }, { top: 300 + 700, bottom: 750 + 700 }, '안드로이드형 보이는 자리');
    h.ctx.confirmOrderSubmit();
    assertInside(cardBox(h.gate, fr.frameH), { top: 1000, bottom: 1450 }, '안드로이드 키보드 캡처 게이트');
  }
  // 아이폰: rect 가 보이는 영역 기준(문서 윗변 = −pageTop) · 높이 450 · 위 붙은 줄이 보이는 영역 맨 위 0~113
  {
    const parent = makeParent({ docTop: -1500, vv: { height: 450, pageTop: 1500, offsetTop: 280 } });
    const fr = { parent, frameTop: -1200, frameH: 2284 };
    const h = harness({ framed: fr });
    const b = h.ctx._ofVisibleBand();
    assert.deepStrictEqual({ top: Math.round(b.top), bottom: Math.round(b.bottom) }, { top: 113 + 1200, bottom: 450 + 1200 }, '아이폰형 보이는 자리(offsetTop 을 더하면 안 된다 — 결정 393)');
    h.ctx.confirmOrderSubmit();
    const box = cardBox(h.gate, fr.frameH);
    assertInside(box, { top: 1313, bottom: 1650 }, '아이폰 키보드 캡처 게이트(보이는 높이가 카드보다 작으면 카드가 줄어 그 안에서 넘겨 본다)');
    assert.equal(h.gate.firstElementChild.style.overflowY, 'auto', '줄어든 카드 안을 넘겨 볼 수 없다');
  }
});

test('④ 토스트 — 제출 버튼 근처를 볼 때 · 맨 위 사진 구획을 볼 때 모두 보이는 자리 아래 끝 위', () => {
  for (const [label, frameTop, docTop, band] of [
    ['제출 버튼 근처', -1200, -1500, PHONE_BAND],
    ['맨 위 사진 구획', 200, -100, { top: 0, bottom: 844 - 200 }],
  ]) {
    const parent = makeParent({ docTop, vv: { height: 844, pageTop: -docTop, offsetTop: 0 } });
    const h = harness({ framed: { parent, frameTop, frameH: 2284 } });
    h.ctx.showToast('인터넷 연결이 불안정해요. 연결을 확인하고 다시 시도해 주세요.', 'error');
    const bottomCss = parseFloat(h.dom.getComputedStyle(h.toastC).bottom);
    const toastBottomY = 2284 - bottomCss;              // 토스트 상자 아래 끝(틀 좌표)
    assert.ok(toastBottomY <= band.bottom && toastBottomY - 60 >= band.top,
      `${label}: 토스트(아래 끝 ${toastBottomY})가 보이는 자리(${band.top}~${band.bottom}) 밖이다`);
    assert.equal(Math.round(band.bottom - toastBottomY), 24, `${label}: 보이는 아래 끝에서 종전과 같은 24px 띄움이 아니다`);
  }
});

test('⑤ showToast 는 하나 — true → 오류 · "warn" → warning · 종류 문자열 그대로 · api.js 오류 안내도 빨간 오류', () => {
  const h = harness();
  const last = () => h.toastC.children[h.toastC.children.length - 1].className;
  h.ctx.showToast('첫 번째 사진과 같은 사진이에요.', true); assert.match(last(), /\berror\b/, 'showToast(…, true) 가 오류 모양이 아니다: ' + last());
  h.ctx.showToast('AI 추출 정보가 적용되었습니다.', 'warn'); assert.match(last(), /\bwarning\b/, '"warn" 이 경고 모양이 아니다: ' + last());
  h.ctx.showToast('완료', 'success'); assert.match(last(), /\bsuccess\b/);
  h.ctx.showToast('안내'); assert.match(last(), /\binfo\b/);
  h.ctx.showToast('안내', false); assert.ok(!/error/.test(last()), 'false 가 오류가 됐다');
  h.ctx.showToast('오류', 'error', 5000); assert.match(last(), /\berror\b/);
  assert.equal(h.timers[h.timers.length - 1].ms, 5000, '보이는 시간(세 번째 값)이 지켜지지 않는다');
  // api.js 의 안내(오류면 true 로 넘긴다)도 같은 함수를 탄다
  vm.runInContext(cut(API, '_apiToast'), h.ctx);
  h.ctx._apiToast('서버에 일시적인 문제가 있어요.', 'error', 4000); assert.match(last(), /\berror\b/, 'api.js 오류 안내가 오류 모양이 아니다');
  h.ctx._apiToast('잠시 뒤 다시', 'warning'); assert.match(last(), /\bwarning\b/);
  assert.equal(cutAll(SA, 'showToast').length, 1, 'showToast 정의가 두 벌 이상이다(뒤의 것이 이겨 호출 뜻이 바뀐다)');
});

test('⑥ 틀 안 긴 캡처 [전체 보기] → 펼친 사진 칸 높이 제한(넘겨 보기) · 한 번에 하나', () => {
  const fr = PHONE();
  const h = harness({ framed: fr });
  const { El, body } = h.dom;
  for (const cid of ['of', 'of2']) {
    const prev = body.appendChild(new El('div', { id: cid + '_imgPreview' }));
    const th = cid === 'of' ? h.thumb : body.appendChild(new El('img', { id: cid + '_imgThumb' }));
    th.src = 'data:image/png;base64,AAAA';
    void prev;
  }
  h.ctx._ofViewCapture('of');
  const big = h.dom.doc.getElementById('of_imgBig');
  assert.ok(big && !big.hidden, '크게 보기가 열리지 않았다');
  const mh = parseFloat(big.style.maxHeight);
  assert.ok(mh >= 480 && mh <= 1600, '펼친 사진 칸 높이 제한이 없다(긴 캡처가 4,000px 틀 상한을 넘는다): ' + big.style.maxHeight);
  assert.equal(big.style.overflowY, 'auto', '높이를 묶었는데 안에서 넘겨 볼 수 없다');
  h.ctx._ofViewCapture('of2');
  assert.equal(big.hidden, true, '두 번째 사진을 펼쳤는데 첫 번째가 그대로 펼쳐져 있다');
});

test('⑦ 직접 링크(틀 아님) → 창·토스트·사진 칸에 아무 값도 넣지 않는다(종전 모양 그대로)', () => {
  const h = harness();
  h.ctx.confirmOrderSubmit();
  assert.equal(h.gate.style.display, 'flex');
  assert.deepStrictEqual(Object.keys(h.gate.style).sort(), ['display'], '직접 링크에서 캡처 게이트 모양을 건드렸다: ' + JSON.stringify(h.gate.style));
  assert.deepStrictEqual(Object.keys(h.gate.firstElementChild.style), [], '직접 링크에서 카드 모양을 건드렸다');
  h.ctx._captureGateSkip();
  assert.deepStrictEqual(Object.keys(h.confirmM.style).sort(), ['display']);
  h.ctx.showToast('안내', 'info');
  assert.deepStrictEqual(Object.keys(h.toastC.style), [], '직접 링크에서 토스트 상자 위치를 건드렸다');
  const { El, body } = h.dom;
  body.appendChild(new El('div', { id: 'of_imgPreview' })); h.thumb.src = 'data:image/png;base64,AAAA';
  h.ctx._ofViewCapture('of');
  const big = h.dom.doc.getElementById('of_imgBig');
  assert.ok(big && !big.hidden);
  assert.equal(big.style.maxHeight, undefined, '직접 링크에서 크게 보기 높이를 묶었다');
});

test('⑧ 화면 고정 창을 만드는 함수는 모두 공용 도우미로 자리를 잡는다 · 보이는 자리 계산은 한 벌', () => {
  // 동적 창: className="modal-overlay…" 또는 cssText 의 position:fixed;inset:0 를 만드는 함수 전부
  const re = /(\.className = "modal-overlay|style\.cssText = ['"]position:fixed;inset:0)/g;
  const owners = new Set(); let m;
  while ((m = re.exec(SA))) { const s = SA.lastIndexOf('\nfunction ', m.index); owners.add(/function ([\w$]+)\(/.exec(SA.slice(s))[1]); }
  assert.ok(owners.size >= 5, '창 만드는 함수를 못 찾았다: ' + [...owners]);
  for (const name of owners) assert.ok(/_ofFramePlace\((ov|overlay)\)/.test(cut(SA, name)), name + ' 이 틀 안 자리 잡기(_ofFramePlace)를 부르지 않는다');
  // 정적 창(search.html position:fixed) — 여는 자리에서 부른다
  for (const id of ['captureGateModal', 'orderConfirmModal']) assert.ok(new RegExp('id="' + id + '"[^>]*position:fixed').test(HTML), id);
  assert.ok(/gate\.style\.display = "flex";\s*\n\s*_ofFramePlace\(gate\)/.test(cut(SA, 'confirmOrderSubmit')));
  assert.ok(/m\.style\.display = "flex";\s*\n\s*_ofFramePlace\(m\)/.test(cut(SA, '_openOrderConfirm')));
  // 한 벌: 옛 parent.innerHeight 사본(_pmvPlace) 없음 · 부모 줄 선택자는 공고 화면에 실제로 있는 것
  assert.ok(!/function _pmvPlace\(/.test(SA), '보이는 자리 계산 사본(_pmvPlace)이 되살아났다');
  assert.ok(!/parent\.innerHeight/.test(SA.replace(/\/\*[\s\S]*?\*\//g, '')), 'parent.innerHeight 로 보이는 높이를 따로 계산한다');
  const sel = /const _OF_PARENT_TOP_BARS = "([^"]+)"/.exec(SA);
  assert.ok(sel, '부모 줄 선택자 없음');
  for (const s of sel[1].split(',').map((x) => x.trim())) {
    const ok = s.startsWith('#') ? CAMP.includes('id="' + s.slice(1) + '"') : CAMP.includes('class="' + s.slice(1)) && new RegExp('\\' + s + '\\{[^}]*position:sticky').test(CAMP);
    assert.ok(ok, '공고 화면에 없는(또는 위에 붙지 않는) 줄: ' + s);
  }
});
