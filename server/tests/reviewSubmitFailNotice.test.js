'use strict';
/* 결정 410 — 리뷰 제출이 실패하면 그 사실이 **화면에 남는다** · 실패 문구는 쉬운 한국어 **한 번** ·
 *            여러 건 중 일부만 실패하면 **어느 건인지**와 할 일을 알리고 그 건만 다시 낼 수 있다.
 *
 * 사고(리뷰 제출 점검 2026-11-24 M2 · M3 · L3 · L4):
 *   M2 실패 안내가 3.5초 토스트 하나 → 사진은 그대로·버튼은 「제출하기」라 화면이 누르기 전과 같았다(「제출됐나?」).
 *   M3 「모든 제출에 실패했습니다: 1번 오류: 서버 응답 파싱 실패 (HTTP 502)」 · 업로드 끊김은 토스트 2개(업로드 도구 + 화면) ·
 *      「이미지 크기가 크면 자동 압축 후 재시도됩니다」(다시 보내는 곳 0).
 *   L3 「이미 제출됬던」(오타) · 리뷰 사진인데 「다른 구매양식」 · 「책임소재 리뷰어 귀책」 · 「이 참여자는」 · 「최대 10MB」(결정 408 이후 틀림).
 *   L4 여러 건 일부 실패 = 「1건 실패 (콘솔 확인)」 · 단추 1개(그 자리에서 다시 낼 수 없음).
 *
 * search-app.js·api.js 의 **실제 함수 본문**을 vm 에서 돌리고(옛 입구 submitReview · _submitReviewSlots 그대로 호출),
 * 작은 가짜 DOM 에서 리뷰어 눈에 남는 것(토스트·남는 안내·완료 창)을 읽는다. 새 도우미가 없으면 건너뛰어
 * 옛 코드에서도 돌고 **행동으로** 실패한다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const SA = fs.readFileSync(path.join(ROOT, 'frontend/js/search-app.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'frontend/api.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'frontend/search.html'), 'utf8');
const DIAG = fs.readFileSync(path.join(ROOT, 'server/src/routes/diag.routes.js'), 'utf8');

function fn(src, name) {
  let at = src.indexOf('\nasync function ' + name + '(');
  if (at < 0) at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) return '';
  return src.slice(at + 1, src.indexOf('\n}', at) + 2);
}
const preDecls = (src) => (src.match(/^(?:const|let) _(?:pre|PRE_)\w* = [^\n]*;[^\n]*$/gm) || []).join('\n');
const named = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
const rvHelpers = (src) => named(src, /^(?:async )?function (_rv[A-Z]\w*)\(/gm);
const photoHelpers = (src) => named(src, /^(?:async )?function (_reviewPhoto\w*)\(/gm);

/* ── 작은 가짜 DOM: id 로 찾기 · 끼워 넣기 · 지우기 · closest('.step-nav') · querySelector('h2'|'.modal-box') ── */
function mkDom() {
  const byId = {};
  class El {
    constructor(tag, cls) {
      this.tagName = tag; this.className = cls || ''; this.children = []; this.parentNode = null; this.style = {};
      this._html = ''; this.textContent = ''; this.attrs = {}; this.disabled = false; this.value = ''; this.listeners = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set id(v) { this._id = v; byId[v] = this; }
    get id() { return this._id; }
    set innerHTML(v) { this._html = String(v); }
    get innerHTML() { return this._html; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(t, f) { this.listeners[t] = f; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
    remove() {
      if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; }
      if (byId[this._id] === this) delete byId[this._id];
    }
    closest(sel) { let n = this; while (n) { if (sel === '.step-nav' && /\bstep-nav\b/.test(n.className)) return n; n = n.parentNode; } return null; }
    querySelector(sel) {
      const hit = (c) => (sel === 'h2' && c.tagName === 'h2') || (sel === '.modal-box' && /\bmodal-box\b/.test(c.className));
      const walk = (n) => { for (const c of n.children) { if (hit(c)) return c; const r = walk(c); if (r) return r; } return null; };
      return walk(this);
    }
    scrollIntoView() {}
    get text() { return [this.textContent, this._html, ...this.children.map((c) => c.text)].join(' '); }
  }
  const mk = (tag, id, cls, parent) => { const e = new El(tag, cls); if (id) e.id = id; if (parent) parent.appendChild(e); return e; };
  const body = mk('body');
  const pane = mk('div', 'step2', 'pane-card', body);
  mk('textarea', 'memoTxt', '', pane);
  const nav = mk('div', '', 'step-nav', pane);
  const btn = mk('button', 'btnSubmit', 'btn-submit', nav); btn.innerHTML = '<i class="fas fa-paper-plane"></i> 제출하기';
  const modal = mk('div', 'successModal', 'modal-overlay', body);
  const box = mk('div', '', 'modal-box success-modal', modal);
  const h2 = mk('h2', '', '', box); h2.textContent = '제출 완료!';
  mk('p', 'successMessage', '', box);
  const NULLABLE = new Set(['rvSubmitFailNotice', 'btnSuccessRetryFailed']);
  const document = {
    getElementById: (id) => byId[id] || (NULLABLE.has(id) ? null : mk('div', id, '', null)),
    createElement: (tag) => new El(tag),
  };
  return { document, byId, body, pane, nav, btn, modal, h2 };
}

const SCALE = 1000;   // 화면 시간 1초 = 시험 1ms
function harness({ upload, post, rows, slots, filesBySlot, oldApi } = {}) {
  const dom = mkDom();
  const calls = { upload: [], uploadOpts: [], post: [], toast: [], shown: {} };
  const g = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Promise, Object, Array, String, Number, Set, Map, Error, AbortController, RegExp,
    setTimeout: (f, ms) => setTimeout(f, Math.max(0, (ms || 0) / SCALE)), clearTimeout,
    API_BASE_URL: 'https://fake.invalid', _PREVIEW_MODE: false,
    APP_CONFIG: { GAS_WEB_APP_URL: 'https://fake.invalid/gas', MAX_FILE_SIZE: 10 * 1024 * 1024, ALLOWED_MIME: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },
    _getAuthHeaders: () => ({}),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', blocked: false, duplicate: null }) }),
    gasPostUpload: async (p, t, opts) => {
      calls.upload.push(p); calls.uploadOpts.push(opts);
      return upload ? upload(p, calls.upload.length) : { ok: true, uploadBatchId: 'b1', files: p.files.map((f, i) => ({ fileId: 'f' + i })) };
    },
    gasPost: async (p) => { calls.post.push(p); return post ? post(p, calls.post.length) : { ok: true, complete: true, missingSlots: [] }; },
    showToast: (m, t) => calls.toast.push(String(m)),
    showLoading() {}, hideLoading() {},
    show: (id) => { calls.shown[id] = true; }, hide: (id) => { calls.shown[id] = false; },
    goStep() {}, _updateReceiptStepActions() {}, _clearSearchCache() {}, renderPreviews() {}, _preCheckFiles() {}, _preCtx: () => ({}),
    escHtml: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    extractProductOption: (row) => ({ options: row && row.opt ? [{ value: row.opt }] : [] }),
    _isBlogItem: () => false, _isPostUrl: () => false, _BLOG_POST_URL_HINT: '',
    _csIsReceiptSlot: (s) => !!(s && s.role === 'receipt'), _dualReviewItem: () => false, _dualReviewSlotsReady: () => true,
    _csShowVerdict() {}, _csClearVerdict() {}, _csShowRouteNotice() {}, _csClearRouteNotice() {},
    _preRender() {}, _preRenderDup() {}, _showDuplicateBlockModal() {},
    S: { selectedRows: rows || [], selectedRow: rows ? null : { sheetId: 'sh', tabName: 'tab', gid: '1', rowIndex: 5, recipientName: '김예시', displayName: '김예시', row: {} },
      files: [], filesByIdx: {}, filesBySlot: filesBySlot || {}, captureSlots: slots || null, receiptStepMode: false, step: 2 },
    document: dom.document,
  };
  vm.createContext(g);
  const code = [preDecls(SA), oldApi ? '' : fn(API, 'apiFriendlyErrorMessage'),
    ...['_preGet', '_preReset', '_preHasBlock', '_preBlockedMessage', '_preIsChecking', '_preAwaitChecks', '_ofFriendlyErr',
      ...photoHelpers(SA), ...rvHelpers(SA), 'removeFile', 'submitReview', '_submitReviewSlots'].map((n) => fn(SA, n))].join('\n');
  vm.runInContext(code + '\nthis.__has = (n) => typeof globalThis[n] === "function";', g);
  const notice = () => dom.byId.rvSubmitFailNotice || null;
  const seen = () => [...calls.toast, notice() ? notice().text : ''].join(' | ');
  return { g, dom, calls, notice, seen };
}
const fo = (tag) => ({ b64: 'QUFB' + tag, size: 1000, type: 'image/jpeg', name: tag + '.jpg', file: {} });
const DEV_WORDS = /HTTP|파싱|1번 오류|모든 제출|콘솔|undefined|null|Failed to fetch|Internal Server Error|자동 압축/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 주석을 뺀 코드(옛 문구를 설명하는 주석은 검사하지 않는다) */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/* ═══ M2. 실패가 화면에 남는다 ═══ */
test('M2-1 단건 업로드가 502(응답 해석 실패)면 [제출하기] 위에 안내가 남는다 — 10초 뒤에도 · 사진·버튼은 그대로', async () => {
  const h = harness({ upload: () => ({ ok: false, error: '서버 응답 파싱 실패 (HTTP 502)', _httpStatus: 502 }) });
  h.g.S.files = [fo('a')];
  h.dom.byId.memoTxt.value = '비고 메모';
  await h.g.submitReview();
  await wait(10000 / SCALE + 5);   // 토스트(3.5초)가 사라진 뒤
  const n = h.notice();
  assert.ok(n, `★ 실패 안내가 화면에 남아야 한다(종전: 토스트만) — 실제 토스트: ${JSON.stringify(h.calls.toast)}`);
  assert.equal(n.parentNode, h.dom.pane, '제출 카드 안에');
  assert.equal(h.dom.pane.children.indexOf(n) + 1, h.dom.pane.children.indexOf(h.dom.nav), '[제출하기] 줄 바로 위');
  assert.match(n.text, /제출되지 않았어요/);
  assert.match(n.text, /서버에 일시적인 문제가 있어요/);
  assert.match(n.text, /사진과 비고는 그대로/);
  assert.equal(n.attrs.role, 'alert', '화면 읽기 도구에도 알린다');
  assert.equal(h.g.S.files.length, 1, '사진 그대로');
  assert.equal(h.dom.byId.memoTxt.value, '비고 메모', '비고 그대로');
  assert.equal(h.dom.btn.disabled, false, '버튼 다시 누를 수 있음');
  assert.match(h.dom.btn.innerHTML, /제출하기/);
  assert.ok(!h.calls.shown.successModal, '완료 창 없음');
});

test('M2-2 남는 안내는 다음 제출을 누르거나 사진을 빼면 지워진다', async () => {
  let fail = true;
  const h = harness({ upload: (p) => (fail ? { ok: false, error: 'x', _httpStatus: 503 } : { ok: true, uploadBatchId: 'b', files: p.files.map((f, i) => ({ fileId: 'f' + i })) }) });
  h.g.S.files = [fo('a'), fo('b')];
  await h.g.submitReview();
  assert.ok(h.notice(), '실패 안내');
  h.g.removeFile(1);
  assert.equal(h.notice(), null, '★ 사진을 바꾸면 지난 실패 안내는 지운다');
  await h.g.submitReview();
  assert.ok(h.notice(), '다시 실패하면 다시 뜬다');
  fail = false;
  await h.g.submitReview();
  assert.equal(h.notice(), null, '★ 다음 제출이 성공하면 실패 안내가 남지 않는다');
  assert.equal(h.calls.shown.successModal, true);
  // 단계·화면 이동·처음으로에서도 지운다(실행은 DOM 이 커서 본문 확인)
  for (const f of ['goStep', 'showScreen', 'resetApp', '_reviewPhotoAdd', '_mrRemoveFile', '_csRemoveFile']) {
    assert.match(fn(SA, f), /_rvFailNoticeClear\(\)/, `${f} 이 지난 실패 안내를 지운다`);
  }
});

test('M2-3 캡처 칸 화면(_submitReviewSlots)도 업로드가 모두 실패하면 안내가 남는다(종전 토스트 「업로드 실패: …」)', async () => {
  const slots = [{ key: 'review', label: '리뷰' }];
  const h = harness({ slots, filesBySlot: { review: [fo('a')] }, upload: () => ({ ok: false, error: '서버 응답 파싱 실패 (HTTP 502)', _httpStatus: 502 }) });
  await h.g.submitReview();
  const n = h.notice();
  assert.ok(n, `★ 칸 화면도 남는 안내 — 실제 토스트: ${JSON.stringify(h.calls.toast)}`);
  assert.match(n.text, /서버에 일시적인 문제/);
  assert.doesNotMatch(h.seen(), DEV_WORDS);
  assert.equal(h.g.S.filesBySlot.review.length, 1, '사진 그대로');
  assert.equal(h.dom.btn.disabled, false);
});

/* ═══ M3. 쉬운 말 · 한 번만 · 지키지 않는 약속 없음 ═══ */
const CASES = [
  ['끊김', { ok: false, networkError: true, error: '업로드가 중단되었습니다. 네트워크 연결을 확인하세요.', _transport: true }, /인터넷 연결이 불안정해요/],
  ['시간 초과', { ok: false, networkError: true, timeout: true, error: '업로드 시간이 초과되었습니다. 이미지 크기를 줄이거나 네트워크를 확인하세요.', _transport: true }, /시간이 너무 오래 걸렸어요/],
  ['413', { ok: false, error: '서버 응답 파싱 실패 (HTTP 413)', _httpStatus: 413 }, /사진 용량이 너무 커서/],
  ['429', { ok: false, error: '이미지 분석 요청이 너무 많습니다.', _httpStatus: 429 }, /1분 뒤 \[제출하기\]를 다시/],
  ['500 영어', { ok: false, error: 'Internal Server Error', _httpStatus: 500 }, /서버에 일시적인 문제/],
  ['500 서버 내부 한국어', { ok: false, error: 'Drive 폴더 생성 실패: quota', _httpStatus: 500 }, /서버에 일시적인 문제/],
  ['서버 한국어 거절(중복)', { ok: false, error: '이미 제출했던 사진이에요', files: [{ rejected: 'duplicate_submitted', message: '이미 제출했던 사진이에요' }], _httpStatus: 200 }, /이미 제출했던 사진이에요/],
];
for (const [label, res, want] of CASES) {
  test(`M3-1 업로드 실패 「${label}」 → 쉬운 한국어 한 번 · 개발자 말 없음`, async () => {
    const h = harness({ upload: () => res });
    h.g.S.files = [fo('a')];
    await h.g.submitReview();
    const all = h.seen();
    assert.match(all, want, `실제: ${all}`);
    assert.doesNotMatch(all, DEV_WORDS, `★ 개발자 말·「모든」·「1번」이 보인다: ${all}`);
    assert.doesNotMatch(all, /분석 요청/, '업로드인데 「분석」 요청이라 하지 않는다');
    assert.ok(h.notice(), '남는 안내');
    assert.ok((h.notice().text.match(/다시 눌러/g) || []).length <= 1, `★ 할 일을 두 번 말하지 않는다: ${h.notice().text}`);
    assert.match(h.notice().text, /넣은 사진과 비고는 그대로 있어요/);
    assert.equal(h.calls.toast.length, 0, `★ 같은 실패를 토스트로 또 말하지 않는다: ${JSON.stringify(h.calls.toast)}`);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.uploadOpts[0] || null)), { quiet: true }, '★ 업로드 도구의 자체 토스트를 끈다(두 번 말하기 방지)');
  });
}

test('M3-2 마감된 건(REVIEW_CLOSED_NO_REVIEW)은 「다시 눌러」 대신 담당자 문의 · 제출 기록 실패도 쉬운 말', async () => {
  let h = harness({ upload: () => ({ ok: false, code: 'REVIEW_CLOSED_NO_REVIEW', error: '최종 제출기한이 지나 미작성으로 종결된 작업입니다.', _httpStatus: 409 }) });
  h.g.S.files = [fo('a')];
  await h.g.submitReview();
  assert.match(h.seen(), /제출 기한이 지나 마감된 건이에요\. 궁금한 점은 담당자에게 문의해 주세요/);
  assert.doesNotMatch(h.seen(), /미작성으로 종결|다시 눌러/, '★ 마감 건에 다시 누르라 하지 않는다');
  h = harness({ post: () => ({ ok: false, networkError: true, timeout: true, error: '요청 시간이 초과되었습니다.' }) });
  h.g.S.files = [fo('a')];
  await h.g.submitReview();
  assert.ok(h.notice(), '기록 단계 실패도 화면에 남는다');
  assert.match(h.notice().text, /응답이 늦어지고 있어요/);
  h = harness({ post: () => null });
  h.g.S.files = [fo('a')];
  await h.g.submitReview();
  assert.doesNotMatch(h.seen(), /서버 응답 없음|알 수 없는 오류/);
});

test('M3-5 배포 스큐 — 옛 api.js(쉬운 말 바탕 없음)가 캐시에 남아도 서버의 한국어 사유는 그대로, 영어는 쉬운 기본 문구', async () => {
  let h = harness({ oldApi: true, upload: () => ({ ok: false, error: '사진이 바뀌었습니다. 새로고침해주세요.', _httpStatus: 409 }) });
  h.g.S.files = [fo('a')];
  await h.g.submitReview();
  assert.match(h.notice().text, /사진이 바뀌었습니다/);
  h = harness({ oldApi: true, upload: () => ({ ok: false, error: 'Bad Request' , _httpStatus: 400 }) });
  h.g.S.files = [fo('a')];
  await h.g.submitReview();
  assert.match(h.notice().text, /사진을 올리지 못했어요/);
  assert.doesNotMatch(h.seen(), /Bad Request/);
});

test('M3-3 api.js gasPostUpload — quiet 면 토스트 0 · 아니면 종전처럼 1번 · 「자동 압축 후 재시도」 약속 없음 · 결과 모양 같음', async () => {
  const s = API.indexOf('async function gasPostUpload(');
  const e = API.indexOf('\n}\n', s) + 3;
  for (const mode of ['timeout', 'aborted', '네트워크 오류 — 인터넷 연결을 확인하세요.', 'weird']) {
    const results = [];
    for (const quiet of [false, true]) {
      const toasts = [];
      const ctx = { _ACTION_MAP: { uploadReviewImage: { method: 'POST', path: '/x' } }, API_BASE_URL: 'http://t',
        _uploadProgress: { show() {}, update() {}, hide() {} }, _apiToast: (m) => toasts.push(m),
        _xhrPost: async () => { throw new Error(mode); } };
      vm.createContext(ctx); vm.runInContext(API.slice(s, e) + '; this.f = gasPostUpload;', ctx);
      results.push(JSON.parse(JSON.stringify(await ctx.f({ action: 'uploadReviewImage' }, 1000, quiet ? { quiet: true } : undefined))));
      assert.equal(toasts.length, quiet ? 0 : 1, `${mode} quiet=${quiet} 토스트 수`);
      assert.ok(!toasts.some((t) => /자동 압축|재시도됩니다/.test(t)), `★ 지키지 않는 약속: ${toasts}`);
    }
    assert.deepEqual(results[0], results[1], '결과 모양은 quiet 와 상관없이 같다(다른 화면 판정 불변)');
    assert.equal(results[0]._transport, true);
  }
  assert.doesNotMatch(API, /자동 압축 후 재시도/);
});

test('M3-4 실패 문구는 한 곳(_rvFailReason) — 바탕은 결정 359 apiFriendlyErrorMessage(_ofFriendlyErr 경유) · 영어 판별 사본 없음', () => {
  const body = fn(SA, '_rvFailReason');
  assert.ok(body, '_rvFailReason 이 있다');
  assert.match(body, /_ofFriendlyErr\(/, '쉬운 말 바탕을 다시 쓰지 않고 태운다');
  assert.doesNotMatch(body, /failed to fetch|load failed|not valid json/i, '영어 판별 정규식 사본 금지');
  for (const f of ['submitReview', '_submitReviewSlots']) {
    const b = code(fn(SA, f));
    assert.doesNotMatch(b, /모든 제출에 실패|번 오류|콘솔 확인|"제출 실패: "|"업로드 실패: "|일부 업로드 실패/, `${f} 에 옛 문구가 남았다`);
    assert.match(b, /gasPostUpload\([\s\S]*?\}, 180000, \{ quiet: true \}\)/, `${f} 업로드는 quiet`);
  }
});

/* ═══ L4. 여러 건 일부 실패 ═══ */
const rows2 = () => [
  { sheetId: 'sh', tabName: 'tab', gid: '1', rowIndex: 5, recipientName: '김예시', displayName: '김예시', productName: '상품A', row: {} },
  { sheetId: 'sh', tabName: 'tab', gid: '1', rowIndex: 6, recipientName: '김예시', displayName: '김예시', productName: '상품B', row: { opt: '파랑' } },
];
test('L4-1 2건 중 2번만 실패 → 완료 창에 「2번 상품B (파랑): 이유」 + 할 일 · [닫고 실패한 1건 다시 내기] → 그 건만 다시 올린다', async () => {
  let failB = true;
  const h = harness({ rows: rows2(), upload: (p) => (failB && p.rowIndex === 6 ? { ok: false, error: '서버 응답 파싱 실패 (HTTP 502)', _httpStatus: 502 } : { ok: true, uploadBatchId: 'b' + p.rowIndex, files: p.files.map((f, i) => ({ fileId: 'f' + i })) }) });
  h.g.S.filesByIdx = { 0: [fo('a')], 1: [fo('b')] };
  await h.g.submitReview();
  const msg = h.dom.byId.successMessage.innerHTML;
  assert.equal(h.calls.shown.successModal, true);
  assert.doesNotMatch(msg, /콘솔/, `★ 「콘솔 확인」 대신 어느 건인지 — 실제: ${msg}`);
  assert.match(msg, /2번 상품B \(파랑\): 서버에 일시적인 문제가 있어요/);
  assert.match(msg, /실패한 1건 다시 내기/);
  assert.match(h.dom.h2.textContent, /일부만 제출됐어요/, '제목이 「제출 완료!」가 아니다');
  const rb = h.dom.byId.btnSuccessRetryFailed;
  assert.ok(rb && /닫고 실패한 1건 다시 내기/.test(rb.innerHTML), '그 자리에서 다시 낼 단추');
  assert.ok(h.notice() && /2번 상품B/.test(h.notice().text), '창을 닫아도 화면에 남는다');
  assert.match(h.dom.btn.innerHTML, /실패한 1건 다시 제출하기/);
  rb.listeners.click();
  assert.equal(h.calls.shown.successModal, false, '창이 닫힌다');
  assert.equal(h.dom.h2.textContent, '제출 완료!', '제목 되돌림');
  assert.equal(h.g.S.filesByIdx[1].length, 1, '실패한 건의 사진 그대로');
  failB = false;
  const before = h.calls.upload.length;
  await h.g.submitReview();
  const again = h.calls.upload.slice(before);
  assert.deepEqual(again.map((p) => p.rowIndex), [6], '★ 제출된 1번은 다시 올리지 않는다(중복 제출 없음)');
  assert.equal(h.calls.post.filter((p) => p.rowIndex === 5).length, 1, '1번 제출 기록도 한 번');
  assert.equal(h.notice(), null);
  assert.equal(h.dom.h2.textContent, '제출 완료!');
  assert.equal(h.dom.byId.btnSuccessRetryFailed, undefined, '다 되면 단추 없음');
});

test('L4-2 여러 건이 모두 실패하면 남는 안내에 건마다 이름·이유(「모든 제출에 실패」·「1번 오류」 없음)', async () => {
  const h = harness({ rows: rows2(), upload: (p) => (p.rowIndex === 5 ? { ok: false, networkError: true, error: '업로드가 중단되었습니다. 네트워크 연결을 확인하세요.', _transport: true } : { ok: false, error: 'boom', _httpStatus: 500 }) });
  h.g.S.filesByIdx = { 0: [fo('a')], 1: [fo('b')] };
  await h.g.submitReview();
  const n = h.notice();
  assert.ok(n, `★ 실제 토스트: ${JSON.stringify(h.calls.toast)}`);
  assert.match(n.text, /1번 상품A: 인터넷 연결이 불안정해요/);
  assert.match(n.text, /2번 상품B \(파랑\): 서버에 일시적인 문제/);
  assert.doesNotMatch(h.seen(), DEV_WORDS);
  assert.ok(!h.calls.shown.successModal);
});

/* ═══ L3. 리뷰어가 읽는 문구 ═══ */
test('L3-1 오타·내부 용어·딱딱한 말 정리 + 사진 칸 안내는 결정 408 규칙(원본 50MB · 줄여서 보냄)과 같은 숫자', () => {
  for (const [src, where] of [[SA, 'search-app.js'], [DIAG, 'diag.routes.js']]) assert.doesNotMatch(src, /제출됬/, `${where} 오타`);
  assert.doesNotMatch(SA, /다른 구매양식에 제출되어 반영됐어요/, '리뷰 사진에 「구매양식」');
  assert.doesNotMatch(SA, /사진 중복 여부를 확인하고 있어요/);
  assert.doesNotMatch(HTML, /책임소재|귀책|오제출 문제발생/);
  assert.doesNotMatch(HTML, /이 참여자는 이미/);
  assert.doesNotMatch(HTML, /최대 10MB/, '★ 결정 408 이후 원본 10MB 넘는 사진도 받는다');
  const hint = /<span[^>]*>JPG · PNG · GIF · WebP \/ 한 장 (\d+)MB까지\(큰 사진은 자동으로 줄여요\) \/ 여러 장 선택 가능<\/span>/.exec(HTML);
  assert.ok(hint, '사진 칸 안내');
  const rule = /maxOriginalBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(fn(SA, '_reviewPhotoRules'));
  assert.ok(rule, '_reviewPhotoRules 원본 상한');
  assert.equal(hint[1], rule[1], '★ 안내 숫자 = 실제로 받는 원본 상한');
  assert.match(SA, /이미 제출했던 사진이에요/);
  assert.match(DIAG, /message: '이미 제출했던 사진이에요'/);
  assert.match(HTML, /search-app\.js\?v=20261125-review-notice/);
});
