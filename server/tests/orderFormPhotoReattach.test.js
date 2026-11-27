'use strict';
/* 결정 427 — 구매양식(공고 화면 틀 안 · 직접 링크): 넣은 사진은 새로고침을 넘지 못한다(C안 — 사진은 어디에도 보관하지 않는다).
 *   ① 사진이 들어 있는 동안만 떠나기 전 브라우저 확인(직접 링크 = 이 화면 · 틀 안 = 부모 공고 화면) · 빼거나 제출하면 끈다
 *   ② 다시 열렸을 때 사진이 있었으면 「새로고침해서 넣은 사진이 지워졌어요. 1번째 주문의 구매캡처(1장째)…를 다시 넣어 주세요.」
 *      를 사진 칸 바로 위에(+ 토스트 한 번) · 다시 넣은 칸은 문구에서 빠진다 · 표시에는 「몇 번째 주문의 몇 장째」만(사진 바이트 0)
 *   ③ (가) 새로고침해도 리뷰어가 친 쇼핑몰 아이디가 명의의 저장된 아이디에 덮이지 않는다(저장된 값은 빈 칸만)
 *   ④ 안내가 뜰 때 횟수 기록 한 번 — 본문은 { event, screen, slots } 뿐(이름·번호·사진·주문번호 0)
 *
 * search-app.js·campaign.html 의 **실제 함수 본문**(옛 입구 그대로: _processCardImgFile · _setCardImg2 · removeCardImg ·
 * removeCardImg2 · removeOrderCard · _embedSaveForm · _embedRestoreForm · _loadOrderIdentityContext · 공고 화면 메시지 받는 곳)을
 * vm 에서 가짜 DOM·같은 탭 저장소로 돌린다. 새 도우미(_ofPh*)는 있으면 싣고, 없으면(옛 코드) **행동으로** 실패한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const SA = fs.readFileSync(path.join(ROOT, 'frontend/js/search-app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'frontend/search.html'), 'utf8');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend/campaign.html'), 'utf8');
const CSCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

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
function fnIn(src, name) {
  let i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = src.indexOf('\nasync function ' + name + '(');
  if (i < 0) return '';
  i += 1;
  return src.slice(i, braceEnd(src, src.indexOf('{', src.indexOf(')', i))) + 1);
}
const fn = (name) => fnIn(SA, name);
const OLD_ENTRIES = ['_reviewerIdentityRequestBody', '_loadOrderIdentityContext', '_embedFormFields', '_embedSaveForm', '_embedFillField',
  '_embedRestoreForm', '_processCardImgFile', '_setCardImg2', 'removeCardImg', 'removeCardImg2', 'removeOrderCard', 'showToast', '_toastType'];
const NEW_HELPERS = ['_embedDraftValue', ...[...SA.matchAll(/^function (_ofPh\w+)\(/gm)].map((m) => m[1])];
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const store = (m = {}) => ({ m, getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } });

/* ── 가짜 DOM ─────────────────────────────────────────────────────────── */
function makeDoc() {
  const byId = {};
  const reg = (n) => { if (n && n.id) byId[n.id] = n; (n.children || []).forEach(reg); };
  const unreg = (n) => { if (n && n.id && byId[n.id] === n) delete byId[n.id]; (n.children || []).forEach(unreg); };
  function node(id, extra) {
    const e = Object.assign({
      id: id || '', children: [], parentNode: null, style: {}, attrs: {}, textContent: '', value: '', src: '', type: 'text', checked: false,
      className: '', dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute(k, v) { if (k === 'src') this.src = String(v); else this.attrs[k] = String(v); if (k === 'id') { this.id = String(v); } },
      getAttribute(k) { return k === 'src' ? (this.src || '') : (k in this.attrs ? this.attrs[k] : null); },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(n) { return this.insertBefore(n, null); },
      insertBefore(n, ref) {
        if (n.parentNode) n.parentNode.removeChild(n);
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
        n.parentNode = this; if (this.attached) attach(n); return n;
      },
      removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; unreg(n); return n; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      get nextSibling() { if (!this.parentNode) return null; const c = this.parentNode.children; return c[c.indexOf(this) + 1] || null; },
      querySelector(sel) {
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        const walk = (n) => { for (const c of n.children) { if (cls && String(c.className).split(' ').includes(cls)) return c; const r = walk(c); if (r) return r; } return null; };
        return walk(this);
      },
      querySelectorAll(sel) { return this._fields ? this._fields() : []; },
      closest() { return null; },
      focus() {}, scrollIntoView() {},
    }, extra || {});
    return e;
  }
  function attach(n) { n.attached = true; reg(n); (n.children || []).forEach(attach); }
  const body = node('__body'); attach(body);
  const doc = {
    body, byId,
    createElement: () => node(''),
    getElementById(id) {
      if (byId[id]) return byId[id];
      // 카드 안 잡다한 칸(로딩·오류·자물쇠 등)은 있으면 쓰는 것뿐 — 부르면 만들어 둔다(트리 밖)
      if (/^oc_\d+_(aiLoading|aiResult|aiError|identityStatus|recipient|phone|address|orderNumber|price|imgInput|imgLabel|img2Add|img2Label|identityWho)$/.test(id)) {
        const n = node(id); byId[id] = n; return n;
      }
      return null;
    },
    querySelector: () => null,
    addEventListener() {},
    node, attach,
  };
  return doc;
}
/** 카드 하나(머리 이름표 · 사진 구획 · 사진 칸 · 미리보기 · 2장째 · 입력칸 몇 개) */
function addCard(doc, cid, label, form) {
  const card = doc.node(cid);
  const head = doc.node('', { className: 'ofc-badge-num', textContent: label });
  const sec = doc.node(cid + '_aiSection');
  ['_imgZone', '_imgPreview', '_img2Box'].forEach((s) => sec.appendChild(doc.node(cid + s)));
  sec.appendChild(doc.node(cid + '_imgThumb')); sec.appendChild(doc.node(cid + '_img2Preview')); sec.appendChild(doc.node(cid + '_img2Thumb'));
  card.appendChild(head); card.appendChild(sec);
  const inputs = ['_orderNumber', '_userId', '_recipient', '_phone'].map((s) => doc.node(cid + s));
  inputs.forEach((i) => card.appendChild(i));
  form.appendChild(card);
  return card;
}

/** 구매양식 한 번 열기 — 같은 탭 저장소(ss)를 넘기면 새로고침 흉내 */
function page({ embed = true, ss = store(), parentDiffers = embed, ctxShoppingId = 'kim_shop_01', cards = [['oc_0', '1번째 주문']], fetchImpl } = {}) {
  const doc = makeDoc();
  const scr = doc.node('screenOrderForm');
  const wrap = doc.node('ofOrderCardsWrap');
  scr.appendChild(wrap); doc.body.appendChild(scr);
  const toastC = doc.node('toastContainer'); doc.body.appendChild(toastC);
  cards.forEach(([cid, label]) => addCard(doc, cid, label, wrap));
  scr._fields = () => { const out = []; const walk = (n) => { n.children.forEach((c) => { if (/_(orderNumber|userId|recipient|phone)$/.test(c.id)) out.push(c); walk(c); }); }; walk(scr); return out; };
  const listeners = {};
  const posted = [];
  const fetches = [];
  const toasts = [];
  const win = {
    addEventListener(t, f) { (listeners[t] = listeners[t] || new Set()).add(f); },
    removeEventListener(t, f) { if (listeners[t]) listeners[t].delete(f); },
    _orderFormCtx: embed ? {} : { sheetId: 'SHEET1', tabName: '탭A', ncMode: false },
  };
  const ctx = {
    window: win, document: doc, sessionStorage: ss, location: { search: embed ? '?embed=1&app=APP1&campId=C1' : '?s=SHEET1&t=탭A' },
    URLSearchParams, JSON, Object, Array, Number, String, Math, Date, Promise, console,
    setTimeout: () => 0, clearTimeout: () => {},   // 토스트 사라지기 타이머는 돌리지 않는다
    API_BASE_URL: 'https://api.example.test',
    _EMBED_CTX: embed ? { app: 'APP1', campId: 'C1', holdToken: 'H1', holdPhone8: '12345678', preview: false } : null,
    _PREVIEW_MODE: false, _BATCH: null,
    _EMBED_FORM_KEY: embed ? 'embedForm_APP1' : '', _EMBED_FORM_LAYOUT: 2, _EMBED_FORM_ID_KEY: embed ? 'embedForm_APP1:id' : '',
    _orderCardIds: cards.map((c) => c[0]), _cardAiState: Object.fromEntries(cards.map((c) => [c[0], {}])),
    _identityContextPromise: null, _activeIdentityContext: null, _orderInfoSuggestions: [],
    _embedPost: (m) => posted.push(m),
    _ofPostJson: async () => ({ response: { ok: true }, data: { ok: true, selectedIdentity: { name: '김예시', type: 'self', phone: '010-1234-5678', shoppingId: ctxShoppingId } }, error: '' }),
    _ofFriendlyErr: (e, d) => d, _safeText: (v) => String(v), _renderIdentityHead() {}, _renderSavedOrderInfoPickers() {},
    _renderOrderInfoSuggestions() {}, _renderAddressTools() {},
    _ofHideCaptureView() {}, _resetSavedIdentityPickerLabels() {}, _syncSubmissionIdentityAction() {}, _ofpOnCaptureCleared() {},
    _addrState: () => ({}), _syncAddressTools() {}, _clearImg2Product() {}, _callCardExtractAi2() {}, _rdmNeedImg2() {},
    _updateCardCountBadge() {}, _ofFramePlaceToast() {}, escHtml: (s) => String(s),
    _callCardExtractAi: async (cid, b64) => { ctx._cardAiState[cid].lastBase64 = b64; },
    FileReader: function () { this.readAsDataURL = (f) => { const self = this; Promise.resolve().then(() => self.onload({ target: { result: 'data:image/png;base64,' + f.b64 } })); }; },
    fetch: (url, init) => { fetches.push({ url, init }); return fetchImpl ? fetchImpl(url, init) : Promise.resolve({ ok: true, status: 204 }); },
  };
  win.parent = parentDiffers ? { postMessage() {} } : win;
  vm.createContext(ctx);
  const src = [...OLD_ENTRIES, ...NEW_HELPERS].map((n) => { const s = fn(n); assert.ok(s || NEW_HELPERS.includes(n), '함수 없음: ' + n); return s; }).join('\n');
  vm.runInContext(src, ctx);
  // showToast 를 기록용으로 감싼다(실제 본문은 위에서 실림 — 상자에 붙는지만 본다)
  const realToast = ctx.showToast;
  ctx.showToast = (m, t, d) => { toasts.push({ m: String(m), t }); return realToast(m, t, d); };
  /** initOrderFormMode 끝(카드를 그린 뒤) — 새 코드는 여기서 _ofPhStart 를 부른다(정적 검사 S-2 가 그 자리를 본다). */
  const open = () => { if (typeof ctx._ofPhStart === 'function') ctx._ofPhStart(); };
  const attach1 = async (cid = 'oc_0', b64 = 'AAAA') => { await ctx._processCardImgFile({ size: 10, type: 'image/png', name: 'cap.png', b64 }, cid); await settle(); };
  const attach2 = async (cid = 'oc_0', b64 = 'BBBB') => { ctx._setCardImg2({ size: 10, type: 'image/png', b64 }, cid, { deferAi: true }); await settle(); };
  const unloadPrompts = () => {
    let prevented = 0;
    for (const f of (listeners.beforeunload || [])) { const e = { preventDefault() { prevented++; }, returnValue: undefined }; f(e); }
    return prevented;
  };
  const notice = () => doc.getElementById('ofPhotoReattachNotice');
  return { ctx, doc, ss, win, listeners, posted, fetches, toasts, open, attach1, attach2, unloadPrompts, notice };
}

/* ═════════════ ① 떠나기 전 확인 ═════════════ */
test('B-1 직접 링크: 사진을 넣으면 떠나기 전 확인 · 빼면 끈다 · 제출하면 끈다', async () => {
  const p = page({ embed: false });
  p.open();
  assert.equal(p.unloadPrompts(), 0, '사진 없음 = 묻지 않는다');
  await p.attach1();
  assert.equal(p.unloadPrompts(), 1, '★ 사진이 들어 있으면 새로고침·탭 닫기 전에 묻는다');
  p.ctx.removeCardImg('oc_0'); await settle();
  assert.equal(p.unloadPrompts(), 0, '사진을 빼면 묻지 않는다');
  assert.equal((p.listeners.beforeunload || new Set()).size, 0, '듣기도 끈다');
  await p.attach1(); await p.attach2();
  assert.equal(p.unloadPrompts(), 1);
  p.ctx.removeCardImg2('oc_0');
  assert.equal(p.unloadPrompts(), 1, '2장째만 빼면 첫 장이 남아 그대로 묻는다');
  assert.equal(typeof p.ctx._ofPhSubmitted, 'function', '제출 뒤 끄는 함수');
  p.ctx._ofPhSubmitted();
  assert.equal(p.unloadPrompts(), 0, '★ 제출이 들어가면 묻지 않는다');
});

test('B-2 공고 틀 안: 틀은 스스로 묻지 않고 부모에게 「사진이 바뀌었다」만 알린다(옵션 바꾸기·틀 비우기 때 묻지 않게)', async () => {
  const p = page({ embed: true });
  p.open();
  await p.attach1();
  assert.equal((p.listeners.beforeunload || new Set()).size, 0, '★ 틀 안에서는 beforeunload 를 걸지 않는다');
  assert.ok(p.posted.some((m) => m && m.type === 'embed-photos' && m.n === 1), '★ 부모에게 사진이 들어왔다고 알린다');
  assert.equal(typeof p.win._ofHasUnsentPhotos, 'function', '부모가 셀 창구');
  assert.equal(p.win._ofHasUnsentPhotos(), true);
  p.ctx.removeCardImg('oc_0'); await settle();
  assert.equal(p.win._ofHasUnsentPhotos(), false, '빼면 없음');
  assert.ok(p.posted.some((m) => m && m.type === 'embed-photos' && m.n === 0), '빼면 0 을 알린다');
  await p.attach1();
  p.ctx._ofPhSubmitted();
  assert.equal(p.win._ofHasUnsentPhotos(), false, '★ 제출 뒤에는 사진이 메모리에 남아 있어도 「안 보낸 사진」이 아니다');
});

/* 공고 화면(campaign.html) — 틀마다 _ofHasUnsentPhotos() 로 다시 세고, 사진 있는 틀이 있을 때만 묻는다 */
function campWorld() {
  const listeners = {};
  const frames = [];
  const mkFrame = (has) => { const w = { _ofHasUnsentPhotos: () => has.v, postMessage() {} }; return { dataset: { p8: 'p' + frames.length }, id: frames.length ? '' : 'orderFrame', contentWindow: w, style: {}, has }; };
  const ctx = {
    location: { origin: 'https://review.example.test', href: 'https://review.example.test/campaign.html?id=C1' },
    document: { querySelectorAll: (sel) => (sel === '#orderTrack iframe' ? frames : []), getElementById: () => null },
    window: null, PREVIEW: false, console, JSON, Object, Array,
    _uploadsPendingP8: new Set(), _submittedTabs: {}, _tabsOn: () => frames.length > 1, $: () => null,
  };
  ctx.window = { addEventListener(t, f) { (listeners[t] = listeners[t] || new Set()).add(f); }, removeEventListener(t, f) { if (listeners[t]) listeners[t].delete(f); } };
  vm.createContext(ctx);
  const names = ['_framesAll', '_frameOfSource', '_frameHasPhotos', '_photosBeforeUnload', '_framePhotosSync'];
  vm.runInContext(names.map((n) => fnIn(CSCRIPT, n)).join('\n'), ctx);
  // 메시지 받는 곳 본문 그대로
  const i = CSCRIPT.indexOf("window.addEventListener('message', (ev)=>{");
  assert.ok(i >= 0, '메시지 받는 곳');
  const s = CSCRIPT.indexOf('{', i + "window.addEventListener('message', (ev)=>".length - 1);
  ctx.__onMessage = vm.runInContext('(ev)=>' + CSCRIPT.slice(s, braceEnd(CSCRIPT, s) + 1), ctx);
  const send = (frame, data) => ctx.__onMessage({ origin: ctx.location.origin, source: frame.contentWindow, data });
  const prompts = () => { let n = 0; for (const f of (listeners.beforeunload || [])) f({ preventDefault() { n++; } }); return n; };
  return { ctx, frames, mkFrame, send, prompts, listeners };
}

test('B-3 공고 화면: 틀에 사진이 있을 때만 떠나기 전 확인 · 틀을 바꿔 끼우면(옵션 변경) 안 묻는다 · 옛 틀이면 종전 그대로', () => {
  const w = campWorld();
  const a = { v: false }, b = { v: false };
  w.frames.push(w.mkFrame(a), w.mkFrame(b));
  a.v = true; w.send(w.frames[0], { type: 'embed-photos', n: 1 });
  assert.equal(w.prompts(), 1, '★ 사진이 든 명의 틀이 있으면 공고 화면을 떠나기 전 묻는다');
  a.v = false; b.v = true;
  assert.equal(w.prompts(), 1, '다른 명의 틀의 사진도 센다(누를 때 다시 센다)');
  b.v = false;
  assert.equal(w.prompts(), 0, '★ 틀을 바꿔 끼우거나 비우면(사진 0) 묻지 않는다');
  w.send(w.frames[1], { type: 'embed-photos', n: 0 });
  assert.equal((w.listeners.beforeunload || new Set()).size, 0, '사진이 다 없어졌다는 알림이면 듣기를 끈다');
  // 옛 틀(창구 없음) = 종전 그대로 묻지 않는다
  delete w.frames[0].contentWindow._ofHasUnsentPhotos;
  w.send(w.frames[0], { type: 'embed-photos', n: 1 });
  assert.equal(w.prompts(), 0, '옛 틀은 창구가 없어 묻지 않는다(종전)');
  // 우리 틀이 아닌 곳에서 온 알림은 무시
  const stranger = { contentWindow: { _ofHasUnsentPhotos: () => true } };
  w.send(stranger, { type: 'embed-photos', n: 1 });
  assert.equal((w.listeners.beforeunload || new Set()).size, 0, '낯선 창의 알림은 무시');
});

/* ═════════════ ② 다시 열었을 때 안내 ═════════════ */
test('R-1 공고 틀: 사진 두 장 → 새로고침 → 사진 칸 바로 위에 어느 사진을 다시 넣을지 · 쓴 글자는 종전처럼 되살아남', async () => {
  const ss = store();
  const p1 = page({ embed: true, ss });
  p1.open();
  p1.doc.getElementById('oc_0_orderNumber').value = '2026-1125-001';
  p1.doc.getElementById('oc_0_recipient').value = '김예시';
  await p1.attach1(); await p1.attach2();
  p1.ctx._embedSaveForm();
  const raw = ss.getItem('embedForm_APP1:id');
  assert.ok(raw, '초안');
  assert.ok(!/base64|data:|AAAA|BBBB/.test(raw), '★ 초안에 사진 바이트가 없다');
  const draft = JSON.parse(raw);
  assert.deepStrictEqual(draft.photos, [{ c: 'oc_0', o: '1번째 주문', s: [1, 2] }], '★ 「몇 번째 주문의 몇 장째」만 담는다');

  const p2 = page({ embed: true, ss });   // 새로고침(같은 탭 저장소)
  p2.open();
  p2.ctx._embedRestoreForm();
  assert.equal(p2.doc.getElementById('oc_0_orderNumber').value, '2026-1125-001', '쓴 글자는 종전처럼 남는다');
  const n = p2.notice();
  assert.ok(n, '★ 사진이 지워졌다는 안내가 화면에 남는다(토스트만이 아니다)');
  assert.equal(n.textContent, '새로고침해서 넣은 사진이 지워졌어요. 1번째 주문의 구매캡처(1장째)·배송메세지 사진(2장째)을 다시 넣어 주세요.');
  const zone = p2.doc.getElementById('oc_0_imgZone');
  assert.equal(n.nextSibling, zone, '★ 사진 칸 바로 위');
  assert.equal(p2.toasts.filter((t) => /지워졌어요/.test(t.m)).length, 1, '토스트도 한 번');
  assert.equal(p2.toasts[0].t, 'warning');
});

test('R-2 다시 넣은 칸은 문구에서 빠지고, 남은 칸은 다음 새로고침에도 안내 · 다 넣으면 안내를 거둔다', async () => {
  const ss = store();
  const p1 = page({ embed: true, ss }); p1.open();
  await p1.attach1(); await p1.attach2();
  const p2 = page({ embed: true, ss }); p2.open();
  await p2.attach1();
  assert.equal(p2.notice().textContent, '새로고침해서 넣은 사진이 지워졌어요. 1번째 주문의 배송메세지 사진(2장째)을 다시 넣어 주세요.', '★ 다시 넣은 첫 장은 빠진다');
  const p3 = page({ embed: true, ss }); p3.open();   // 2장째를 안 넣고 또 새로고침
  assert.match(p3.notice().textContent, /구매캡처\(1장째\)·배송메세지 사진\(2장째\)/, '지금 있던 첫 장 + 아직 안 넣은 2장째');
  await p3.attach1(); await p3.attach2();
  assert.equal(p3.notice(), null, '★ 다 넣으면 안내를 거둔다');
  assert.equal(p3.fetches.length, 1, '안내 횟수 기록은 그 화면에서 한 번뿐');
});

test('R-3 직접 링크: 표시 칸만 따로(입력값 초안은 만들지 않는다) → 새로고침 → 쓴 내용도 지워졌다고 알림', async () => {
  const ss = store();
  const p1 = page({ embed: false, ss, cards: [['oc_0', '1번째 주문'], ['oc_1', '2번째 주문']] }); p1.open();
  p1.doc.getElementById('oc_0_recipient').value = '김예시';
  await p1.attach1('oc_0'); await p1.attach1('oc_1', 'CCCC');
  const keys = Object.keys(ss.m);
  assert.deepStrictEqual(keys, ['orderFormPhotos_SHEET1:탭A'], '★ 직접 링크는 그 양식(시트·탭)별 표시 칸 하나뿐 — 입력값 초안 키는 없다');
  const raw = ss.m[keys[0]];
  assert.ok(!/김예시|base64|data:|AAAA|CCCC/.test(raw), '★ 이름·사진 바이트를 담지 않는다');
  assert.deepStrictEqual(JSON.parse(raw).photos, [{ c: 'oc_0', o: '1번째 주문', s: [1] }, { c: 'oc_1', o: '2번째 주문', s: [1] }]);
  const p2 = page({ embed: false, ss }); p2.open();
  assert.equal(p2.notice().textContent, '새로고침해서 쓴 내용과 넣은 사진이 지워졌어요. 1번째 주문의 구매캡처(1장째) · 2번째 주문의 구매캡처(1장째)를 다시 넣어 주세요.');
  p2.ctx._ofPhSubmitted();
  assert.equal(ss.getItem('orderFormPhotos_SHEET1:탭A'), null, '제출하면 표시 칸을 지운다');
  assert.equal(p2.notice(), null);
});

test('R-4 지운 주문 카드의 안내는 거둔다 · 3시간 지난 표시·깨진 표시·이상한 이름표는 읽지 않는다', async () => {
  const ss = store();
  const p1 = page({ embed: false, ss, cards: [['oc_0', '1번째 주문'], ['oc_1', '2번째 주문']] }); p1.open();
  await p1.attach1('oc_0'); await p1.attach1('oc_1', 'CCCC');
  const p2 = page({ embed: false, ss, cards: [['oc_0', '1번째 주문'], ['oc_1', '2번째 주문']] }); p2.open();
  p2.ctx.removeOrderCard('oc_1');
  assert.ok(!/2번째 주문/.test(p2.notice().textContent), '★ 지운 카드는 안내에서 빠진다');
  const k = 'orderFormPhotos_SHEET1:탭A';
  ss.setItem(k, JSON.stringify({ v: 1, at: Date.now() - 4 * 3600 * 1000, photos: [{ c: 'oc_0', o: '1번째 주문', s: [1] }] }));
  const p3 = page({ embed: false, ss }); p3.open();
  assert.equal(p3.notice(), null, '3시간 넘은 표시는 안내하지 않는다');
  ss.setItem(k, '{깨짐');
  const p4 = page({ embed: false, ss }); p4.open();
  assert.equal(p4.notice(), null, '깨진 표시 = 안내 없음(화면은 그대로)');
  ss.setItem(k, JSON.stringify({ v: 1, at: Date.now(), photos: [{ c: 'oc_0', o: '<img src=x onerror=alert(1)>', s: [1] }] }));
  const p5 = page({ embed: false, ss }); p5.open();
  assert.equal(p5.notice(), null, '이름표가 이상하면 버린다(글자로만 넣지만 애초에 받지 않는다)');
});

/* ═════════════ ③ (가) 쇼핑몰 아이디 ═════════════ */
test('I-1 (가) 새로고침해도 리뷰어가 친 쇼핑몰 아이디가 저장된 아이디에 덮이지 않는다 — 명의 응답이 복원보다 먼저 와도', async () => {
  const ss = store();
  ss.setItem('embedForm_APP1:id', JSON.stringify({ layout: 2, fields: { oc_0_userId: 'typed_shop_id', oc_0_orderNumber: 'A-1' } }));
  const p = page({ embed: true, ss });
  await p.ctx._loadOrderIdentityContext();   // 명의 응답이 먼저(실측 순서 — 복원은 300ms 뒤)
  p.ctx._embedRestoreForm();
  const el = p.doc.getElementById('oc_0_userId');
  assert.equal(el.value, 'typed_shop_id', '★ 친 값이 이긴다(종전: 저장된 kim_shop_01 로 바뀜)');
  assert.equal(el.dataset.savedValue, 'kim_shop_01', '저장된 아이디(수정 판단 기준)는 종전 그대로');
  assert.equal(p.doc.getElementById('oc_0_orderNumber').value, 'A-1');
});

test('I-2 (가) 저장된 아이디는 빈 칸만 채운다 — 초안이 없거나 비어 있으면 종전처럼 저장된 아이디 · 복원이 먼저여도 같다', async () => {
  const p1 = page({ embed: true });
  await p1.ctx._loadOrderIdentityContext();
  assert.equal(p1.doc.getElementById('oc_0_userId').value, 'kim_shop_01', '초안 없음 = 저장된 아이디');
  const ss = store({ 'embedForm_APP1:id': JSON.stringify({ layout: 2, fields: { oc_0_userId: '' } }) });
  const p2 = page({ embed: true, ss });
  await p2.ctx._loadOrderIdentityContext();
  assert.equal(p2.doc.getElementById('oc_0_userId').value, 'kim_shop_01', '초안 칸이 비었으면 저장된 아이디');
  const ss3 = store({ 'embedForm_APP1:id': JSON.stringify({ layout: 2, fields: { oc_0_userId: 'typed_shop_id' } }) });
  const p3 = page({ embed: true, ss: ss3 });
  p3.ctx._embedRestoreForm();
  await p3.ctx._loadOrderIdentityContext();
  assert.equal(p3.doc.getElementById('oc_0_userId').value, 'typed_shop_id', '복원이 먼저여도 친 값');
});

/* ═════════════ ④ 횟수 기록 ═════════════ */
test('C-1 안내가 뜰 때 횟수 기록 한 번 — 본문은 { event, screen, slots } 뿐 · 기다리지 않음 · 404·끊김은 조용히', async () => {
  const ss = store();
  const p1 = page({ embed: true, ss }); p1.open();
  p1.doc.getElementById('oc_0_recipient').value = '김예시';
  p1.doc.getElementById('oc_0_phone').value = '010-1234-5678';
  p1.doc.getElementById('oc_0_orderNumber').value = '2026-1125-001';
  await p1.attach1(); await p1.attach2();
  p1.ctx._embedSaveForm();
  assert.equal(p1.fetches.length, 0, '안내가 없으면 기록 0');
  const p2 = page({ embed: true, ss, fetchImpl: () => Promise.resolve({ ok: false, status: 404 }) }); p2.open();
  assert.equal(p2.fetches.length, 1, '★ 안내 한 번 = 기록 한 번');
  const { url, init } = p2.fetches[0];
  assert.equal(url, 'https://api.example.test/api/reviewer/ui-event');
  assert.equal(init.method, 'POST'); assert.equal(init.keepalive, true);
  const body = JSON.parse(init.body);
  assert.deepStrictEqual(body, { event: 'photo_reattach_notice', screen: 'campaign', slots: 2 }, '★ 사건·화면·칸 수만');
  assert.ok(!/김예시|1234|5678|2026-1125|APP1|C1|H1/.test(init.body), '★ 이름·번호·주문번호·참여 자리 없음');
  assert.deepStrictEqual(Object.keys(init.headers), ['Content-Type'], '로그인 머리말을 붙이지 않는다(누가 보냈는지 안 보냄)');
  p2.ctx._ofPhRenderNotice(true);
  assert.equal(p2.fetches.length, 1, '같은 화면에서 다시 그려도 기록은 한 번');
  await settle();
  const p3 = page({ embed: true, ss, fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
  assert.doesNotThrow(() => p3.open(), '끊겨도 화면은 그대로');
  await settle();
  assert.ok(p3.notice(), '기록이 실패해도 안내는 뜬다');
  const p4 = page({ embed: false, ss: store({ 'orderFormPhotos_SHEET1:탭A': JSON.stringify({ v: 1, at: Date.now(), photos: [{ c: 'oc_0', o: '1번째 주문', s: [1] }] }) }) });
  p4.open();
  assert.deepStrictEqual(JSON.parse(p4.fetches[0].init.body), { event: 'photo_reattach_notice', screen: 'direct', slots: 1 });
});

/* ═════════════ 정적 ═════════════ */
test('S-1 미리보기·동시진행·배치는 표시·안내·확인을 하지 않는다 · 초안의 photos 칸은 사진 있을 때만', async () => {
  const p = page({ embed: true });
  p.ctx._PREVIEW_MODE = true;
  await p.attach1();
  assert.equal(p.posted.filter((m) => m.type === 'embed-photos').length, 0, '관리자 미리보기 = 알림 0');
  const ss = store();
  const q = page({ embed: true, ss }); q.open();
  q.doc.getElementById('oc_0_orderNumber').value = 'A-1';
  q.ctx._embedSaveForm();
  assert.deepStrictEqual(Object.keys(JSON.parse(ss.getItem('embedForm_APP1:id'))), ['layout', 'fields'], '사진이 없으면 초안 모양은 종전 그대로');
  q.ctx.location.search = '?embed=1&app=APP1&dual=1';
  assert.equal(q.ctx._embedDraftValue('oc_0_orderNumber'), '', '동시진행은 초안을 읽지 않는다(복원과 같은 조건)');
});

test('S-2 부르는 자리 — 구매양식을 연 끝 · 제출 완료 화면 · 첨부·빼기·카드 삭제 · search.html ?v= · campaign.html 메시지', () => {
  const init = fn('initOrderFormMode');
  assert.match(init, /_ofPhStart\(\);\s*\n\s*return true;\s*\n\}$/, '★ 구매양식을 연 끝(카드를 그린 뒤)에 안내를 띄운다');
  const submit = fn('submitOrderForm');
  assert.match(submit, /window\._forceResubmit = false;\s*\n\s*if \(typeof _ofPhSubmitted === "function"\) _ofPhSubmitted\(\);/, '★ 완료 화면 직전에 거둔다');
  for (const [name, re] of [['_processCardImgFile', /_ofPhChanged\(\)/], ['_setCardImg2', /_ofPhChanged\(\)/], ['removeCardImg', /_ofPhChanged\(\)/],
    ['removeCardImg2', /_ofPhChanged\(\)/], ['removeOrderCard', /_ofPhChanged\(cid\)/]]) assert.match(fn(name), re, name);
  const ver = /js\/search-app\.js\?v=(\d{8})-([\w-]+)/.exec(HTML);
  assert.ok(ver && ver[1] >= '20261125' && ver[2] === 'photo-reattach', 'search-app.js 새 판: ' + (ver && ver[0]));
  assert.match(CSCRIPT, /if\(d\.type === 'embed-photos' && _srcFr\)\{ if\(!PREVIEW\) _framePhotosSync\(\); return; \}/, '공고 화면이 틀 알림을 받는다');
  // 틀은 스스로 beforeunload 를 걸지 않는다(공고 틀 안)
  assert.match(fn('_ofPhArm'), /if \(_EMBED_CTX && w\.parent !== w\) \{ _embedPost\(\{ type: "embed-photos"/);
  // 사진은 어디에도 보관하지 않는다(C안) — 도우미에 IndexedDB·사진 바이트 저장이 없다
  const helpers = NEW_HELPERS.map(fn).join('\n');
  assert.ok(!/indexedDB|caches\.open|setItem\([^;]*(lastBase64|dataUrl|b64)/.test(helpers), '사진 바이트를 저장하지 않는다');
});
