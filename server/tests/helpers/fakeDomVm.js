'use strict';
/* 결정 377 — 화면 모듈(campaign-daily-plan.js · sequential-end-prompt.js)을 브라우저 없이 vm 으로 띄우는 아주 작은 가짜 DOM.
 *  ★ 그리기 결과(innerHTML·문구·버튼 잠금)만 본다 — 배치·픽셀은 실제 브라우저(미리보기 캡처)에서 잰다.
 *  fetch 는 넘겨준 함수로 바꾼다(외부 요청 0). */
const vm = require('vm');

function makeDom() {
  const byId = new Map();
  const mk = (tag) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), _id: '', children: [], style: {}, dataset: {}, hidden: false, disabled: false,
      textContent: '', className: '', _attrs: {}, _listeners: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = v; },
      getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      appendChild(c) { this.children.push(c); if (c && c.id) byId.set(c.id, c); return c; },
      remove() { if (this.id) byId.delete(this.id); this._removed = true; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      focus() {}, select() {}, blur() {},
    };
    let _id = '', _html = '';
    Object.defineProperty(el, 'id', { get: () => _id, set: v => { _id = String(v); byId.set(_id, el); } });
    // innerHTML 안의 id 를 가진 칸은 이름으로 찾을 수 있게 빈 칸을 만든다(그리기 함수가 다시 getElementById 로 찾는다)
    Object.defineProperty(el, 'innerHTML', { get: () => _html, set: v => {
      _html = String(v);
      const re = /id="([^"]+)"/g; let m;
      while ((m = re.exec(_html))) { const c = mk('div'); c.id = m[1]; }
    } });
    return el;
  };
  const document = {
    head: mk('head'), body: mk('body'),
    createElement: mk,
    getElementById: id => byId.get(String(id)) || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {},
  };
  return { document, byId, mk };
}

/** 모듈 하나를 새 vm 문맥에 띄운다. @returns {{win, dom, toasts}} */
function loadModule(src, { fetchImpl, extra = {} } = {}) {
  const dom = makeDom();
  const toasts = [];
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const win = {
    document: dom.document, sessionStorage: store(), localStorage: store(),
    fetch: fetchImpl || (async () => ({ status: 500, json: async () => null })),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)), clearTimeout, setInterval: () => 0, clearInterval: () => {},
    confirm: () => true, console, Date, Math, JSON, Object, Array, String, Number, Promise, RegExp, Error, Map, Set, encodeURIComponent,
    ...extra,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx, { filename: 'module.js' });
  return { win, dom, toasts };
}

/** 응답 하나를 돌려주는 가짜 fetch(경로 → 응답 본문). */
function fakeFetch(routes) {
  return async (url, opt) => {
    for (const [re, fn] of routes) {
      if (re.test(url)) { const body = await fn(url, opt); return { status: 200, json: async () => body }; }
    }
    return { status: 404, json: async () => ({ ok: false, error: 'not found ' + url }) };
  };
}

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

module.exports = { makeDom, loadModule, fakeFetch, tick };
