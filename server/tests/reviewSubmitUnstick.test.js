'use strict';
/* 결정 406 — 리뷰 제출 [제출하기]가 「사진 중복 여부를 확인하고 있어요」에서 영영 막히지 않는다 ·
 *            사진을 한 장씩 넣어도 확인 요청이 사진 수만큼만 나가고, 확인과 업로드는 다른 통으로 센다.
 *
 * 사고(점검 2026-11-24 H1·H2):
 *   H1 사진 1차 필터(`_preCheckOne` → /api/image/review-precheck)가 시간 제한 없는 맨 fetch 라 무응답이면
 *      `checking` 이 영영 true → `_preHasBlock()` 이 두 제출 길(submitReview · _submitReviewSlots)을 영구 차단.
 *      확인 중에 누른 [제출하기]는 확인이 끝나도 이어서 제출되지 않았다(다시 눌러야 함).
 *   H2 사진을 넣고 뺄 때마다 그 칸 사진 **전부**를 다시 확인(1+2+3+4 = 10번) + 확인·업로드가 같은
 *      imageApiLimiter(주소별 분당 10) → 업로드 429 · 같은 통신사 주소의 다른 리뷰어도 막힘.
 *
 * 이 가드는 search-app.js 의 **실제 함수 본문**을 vm 에서 돌리고(문자열 검사 아님),
 * 서버 제한기는 rateLimit.middleware.js 를 실제 express 에 걸어 요청 수를 센다.
 * 옛 코드에서도 돌도록 새 함수가 없으면 건너뛰고 행동으로 실패한다(옛 코드 = 실패해야 한다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const SA = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
const API = fs.readFileSync(path.resolve(__dirname, '../../frontend/api.js'), 'utf8');

/** 맨 위 함수 하나(시작 ~ 첫 줄머리 `}`) — 없으면 '' */
function fn(src, name) {
  let at = src.indexOf('\nasync function ' + name + '(');
  if (at < 0) at = src.indexOf('\nfunction ' + name + '(');
  if (at < 0) return '';
  return src.slice(at + 1, src.indexOf('\n}', at) + 2);
}
/** 맨 위 한 줄 선언(const/let _pre… · _PRE…) 전부 */
function preDecls(src) {
  return (src.match(/^(?:const|let) _(?:pre|PRE_)\w* = [^\n]*;[^\n]*$/gm) || []).join('\n');
}

const SCALE = 1000;   // 화면 시간 1초 = 시험 1ms (20초 시간 제한 = 20ms)
function harness({ fetchImpl, uploadImpl, scale = SCALE } = {}) {
  const SCALE = scale;
  const t0 = Date.now();
  class FakeDate extends Date {}
  FakeDate.now = () => t0 + (Date.now() - t0) * SCALE;
  const nodes = {};
  const el = (id) => nodes[id] || (nodes[id] = { id, value: '', innerHTML: '<i class="fas fa-paper-plane"></i> 제출하기', textContent: '',
    disabled: false, style: {}, className: '', classList: { add() {}, remove() {}, toggle() {} } });
  const calls = { fetch: [], upload: [], post: [], toast: [], btnDuringWait: [] };
  const g = {
    console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, Math, JSON, Promise, Object, Array, String, Number, Set, Map, Error, AbortController,
    setTimeout: (f, ms) => setTimeout(f, Math.max(0, (ms || 0) / SCALE)), clearTimeout,
    API_BASE_URL: 'https://fake.invalid', _PREVIEW_MODE: false,
    APP_CONFIG: { GAS_WEB_APP_URL: 'https://fake.invalid/gas' },
    _getAuthHeaders: () => ({ 'X-Reviewer-Token': 'reviewer-jwt' }),
    fetch: (url, init) => {
      const body = JSON.parse(init.body || '{}');
      calls.fetch.push({ url, body, signal: !!init.signal });
      return fetchImpl ? fetchImpl(url, body, init) : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', message: '좋아요', blocked: false, duplicate: null }) });
    },
    gasPostUpload: async (p) => {
      calls.upload.push(p);
      calls.btnDuringWait.push(nodes.btnSubmit && nodes.btnSubmit.innerHTML);
      return uploadImpl ? uploadImpl(p) : { ok: true, uploadBatchId: 'b1', files: p.files.map((f, i) => ({ fileId: 'f' + i })) };
    },
    gasPost: async (p) => { calls.post.push(p); return { ok: true, complete: true, missingSlots: [] }; },
    showToast: (m) => calls.toast.push(String(m)), showLoading() {}, hideLoading() {}, show() {}, goStep() {},
    _updateReceiptStepActions() {}, _clearSearchCache() {}, escHtml: String, extractProductOption: () => ({ options: [] }),
    _isBlogItem: () => false, _isPostUrl: () => false, _BLOG_POST_URL_HINT: '',
    _csIsReceiptSlot: (s) => !!(s && s.role === 'receipt'), _dualReviewItem: () => false, _dualReviewSlotsReady: () => true,
    _csShowVerdict() {}, _csClearVerdict() {}, _csShowRouteNotice() {}, _csClearRouteNotice() {},
    _preRender() {}, _preRenderDup() {}, _showDuplicateBlockModal: (d) => calls.toast.push('[중복창] ' + (d && d.fileId)),
    S: { selectedRows: [], selectedRow: { sheetId: 'sh', tabName: 'tab', gid: '1', rowIndex: 5, recipientName: '김예시', displayName: '김예시', row: {} },
      files: [], filesByIdx: {}, filesBySlot: {}, captureSlots: null, receiptStepMode: false, step: 2 },
    document: { getElementById: el },
  };
  nodes.memoTxt = { value: '' };
  vm.createContext(g);
  const names = ['apiFriendlyErrorMessage'];
  const apiCode = fn(API, 'apiFriendlyErrorMessage');
  const code = [preDecls(SA), apiCode,
    ...['_preGet', '_preReset', '_preHasBlock', '_preBlockedMessage', '_preOverride', '_preCacheCtxKey', '_preCheckCached', '_preCheckOne',
      '_preIsChecking', '_preAwaitChecks', '_preCheckFiles', '_preCheckFilesInner', '_ofFriendlyErr', '_ofPostJson',
      // 결정 408: 제출 두 길이 올리기 전에 부르는 크기 판정(보낼 크기 기준) — 없으면 '' (옛 코드에서도 돈다)
      '_reviewPhotoRules', '_reviewPhotoSendCheck',
      'submitReview', '_submitReviewSlots'].map((n) => fn(SA, n))].join('\n');
  vm.runInContext(code + `
    this.__pre = {
      state: () => _preState,
      has: (n) => typeof globalThis[n] === 'function',
      checking: () => Object.values(_preState).some(s => s && s.checking),
    };`, g);
  void names;
  return { g, calls, nodes, pre: g.__pre };
}
const fo = (tag, size = 1000) => ({ b64: 'B64-' + tag, size, type: 'image/png', name: tag + '.png', file: {} });
const ctx = { sheetId: 'sh', tabName: 'tab', rowIndex: 5, reviewerName: '김예시', phone8: '12345678', slotKey: 'review' };
const hang = (url, body, init) => new Promise((resolve, reject) => {
  if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
});
/** 정해진 실제 시간(ms) 안에 끝나는지 — 끝나지 않으면 'TIMEOUT' */
const within = (p, ms) => Promise.race([p.then(() => 'DONE'), new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);

/* ═══ H1. 응답 없는 1차 필터 ═══ */
test('H1-1 1차 필터가 응답하지 않으면 시간 제한(20초) 뒤 「확인 못 함」(통과)으로 끝나고 checking 이 내려간다', async () => {
  const h = harness({ fetchImpl: hang });
  h.g.S.files = [fo('a')];
  const run = h.g._preCheckFiles('single', 'dropZone', h.g.S.files, ctx);
  assert.equal(h.pre.checking(), true, '확인 중 표시가 켜진다');
  assert.equal(await within(run, 1500), 'DONE', '★ 무응답이어도 확인이 끝나야 한다(시간 제한 없음 = H1)');
  assert.equal(h.pre.checking(), false, 'checking 이 남으면 _preHasBlock 이 제출을 영구 차단한다');
  assert.equal(h.g._preHasBlock(), false);
  assert.ok(h.calls.fetch[0].signal, '요청에 중단 신호(AbortController)를 단다');
});

test('H1-2 확인 중에 누른 [제출하기]는 확인이 끝나면 다시 누르지 않아도 이어서 제출된다(업로드 정확히 1번)', async () => {
  let release;
  // 시간 배율 10(20초 = 2초) — 상한에 닿기 전에 확인이 끝나는 정상 갈래를 본다
  const h = harness({ scale: 10, fetchImpl: () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', blocked: false, duplicate: null }) }); }) });
  h.g.S.files = [fo('a')];
  h.g._preCheckFiles('single', 'dropZone', h.g.S.files, ctx);
  const sub = h.g.submitReview();
  const sub2 = h.g.submitReview();   // 답답해서 한 번 더 누름
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.calls.upload.length, 0, '확인이 끝나기 전에는 올리지 않는다');
  assert.ok(!h.calls.toast.some((m) => /중복 여부를 확인하고 있어요/.test(m)), '★ 「확인 중」 토스트로 누름을 버리지 않는다(H1 — 다시 눌러야 했다)');
  assert.match(h.nodes.btnSubmit.innerHTML, /사진 확인 중/, '기다리는 동안 버튼이 「사진 확인 중…」');
  assert.equal(h.nodes.btnSubmit.disabled, true, '기다리는 동안 버튼은 잠긴다(두 번 제출 방지)');
  release();
  assert.equal(await within(Promise.all([sub, sub2]), 1500), 'DONE');
  assert.equal(h.calls.upload.length, 1, '★ 확인이 끝나면 저절로 이어서 제출 — 연타해도 정확히 1번');
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.nodes.btnSubmit.disabled, false, '끝나면 버튼이 풀린다');
});

test('H1-7 리뷰 지적(PR #1870): 확인을 기다리는 동안 주문이 바뀌거나 화면을 떠났다 오면 기다린 제출은 멈춘다(다른 주문 사진이 엉뚱한 주문으로 올라가지 않게)', async () => {
  for (const change of ['row', 'screen']) {
    let release;
    const h = harness({ scale: 10, fetchImpl: () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', blocked: false, duplicate: null }) }); }) });
    h.g.S.files = [fo('a')];
    h.g._preCheckFiles('single', 'dropZone', h.g.S.files, ctx);
    const sub = h.g.submitReview();
    await new Promise((r) => setTimeout(r, 100));
    if (change === 'row') h.g.S.selectedRow = { sheetId: 'sh', tabName: 'tab', gid: '1', rowIndex: 9, recipientName: '박다른', displayName: '박다른', row: {} };
    else vm.runInContext('_preSubmitGen++', h.g);
    h.g.S.files = [fo('b')];
    release();
    assert.equal(await within(sub, 1500), 'DONE');
    assert.equal(h.calls.upload.length, 0, '★ ' + change + ': 바뀐 뒤에는 기다린 제출을 이어 하지 않는다');
    assert.equal(h.calls.post.length, 0);
    assert.ok(h.calls.toast.some((m) => /다시 눌러/.test(m)), '멈춘 이유를 알린다');
  }
});

test('H1-3 1차 필터가 끝까지 응답하지 않아도 [제출하기]는 시간 안에 업로드까지 간다', async () => {
  const h = harness({ fetchImpl: (url, body, init) => (/review-precheck/.test(url) ? hang(url, body, init) : Promise.reject(new Error('unexpected'))) });
  h.g.S.files = [fo('a')];
  h.g._preCheckFiles('single', 'dropZone', h.g.S.files, ctx);
  const sub = h.g.submitReview();
  assert.equal(await within(sub, 2000), 'DONE', '★ 무응답 확인에 제출이 영원히 묶이면 안 된다(H1: 60초 뒤에도 업로드 0)');
  assert.equal(h.calls.upload.length, 1, '확인을 못 했으면 통과로 접고 올린다(서버가 업로드 때 중복을 다시 막는다)');
  assert.ok(h.calls.btnDuringWait[0] && !/사진 확인 중/.test(h.calls.btnDuringWait[0]), '업로드 때는 버튼 문구가 되돌아와 있다');
});

test('H1-4 기다림에도 상한이 있다 — 확인 표시가 어떤 이유로 안 내려가도 25초 뒤 통과로 접고 이어간다', async () => {
  const h = harness();
  if (!h.pre.has('_preAwaitChecks')) assert.fail('★ 확인 중 제출을 기다렸다 이어 주는 도우미가 없다(H1)');
  h.g._preGet('single').checking = true;   // 어떤 길로도 안 내려가는 확인
  h.g.S.files = [fo('a')];
  const sub = h.g.submitReview();
  assert.equal(await within(sub, 2000), 'DONE');
  assert.equal(h.pre.checking(), false);
  assert.equal(h.calls.upload.length, 1);
});

test('H1-5 확인이 끝나 「이미 낸 사진」으로 나오면 기다린 제출도 올리지 않는다(확정 중복은 계속 막힘)', async () => {
  let release;
  const h = harness({ fetchImpl: () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', blocked: false, duplicate: { fileId: 'old1', submittedAt: '2026-11-20' } }) }); }) });
  h.g.S.files = [fo('a')];
  h.g._preCheckFiles('single', 'dropZone', h.g.S.files, ctx);
  const sub = h.g.submitReview();
  await new Promise((r) => setTimeout(r, 10));
  release();
  assert.equal(await within(sub, 1500), 'DONE');
  assert.equal(h.calls.upload.length, 0, '확정 중복은 업로드하지 않는다');
  assert.ok(h.calls.toast.some((m) => /이미 제출됬던 사진/.test(m)), '중복 안내');
});

test('H1-6 캡처 칸 화면(_submitReviewSlots)도 확인 중 누른 제출을 이어서 한다', async () => {
  let release;
  const h = harness({ fetchImpl: () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', blocked: false, duplicate: null }) }); }) });
  h.g.S.captureSlots = [{ key: 'review', label: '리뷰', role: 'review' }];
  h.g.S.filesBySlot = { review: [fo('a')] };
  h.g._preCheckFiles('slot:review', 'csSlot_review', h.g.S.filesBySlot.review, ctx);
  const sub = h.g.submitReview();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!h.calls.toast.some((m) => /중복 여부를 확인하고 있어요/.test(m)), '★ 칸 화면도 누름을 버리지 않는다');
  release();
  assert.equal(await within(sub, 1500), 'DONE');
  assert.equal(h.calls.upload.length, 1, '칸 업로드 1번');
});

/* ═══ H2. 같은 사진을 다시 묻지 않는다 ═══ */
test('H2-1 사진을 한 장씩 4장 넣으면 확인 요청은 4번(종전 1+2+3+4 = 10번) · 빼도 0번 · 같은 사진 다시 넣어도 0번', async () => {
  const h = harness();
  const files = [];
  for (const t of ['a', 'b', 'c', 'd']) {   // addFiles 와 같은 순서: 배열에 더하고 칸 전체로 부른다
    files.push(fo(t));
    await h.g._preCheckFiles('single', 'dropZone', files, ctx);
  }
  assert.equal(h.calls.fetch.length, 4, `★ 새로 넣은 사진만 묻는다 — 실제 ${h.calls.fetch.length}번`);
  files.splice(1, 1);                        // removeFile
  await h.g._preCheckFiles('single', 'dropZone', files, ctx);
  assert.equal(h.calls.fetch.length, 4, '빼기만 하면 새로 묻지 않는다');
  files.push(fo('b'));                       // 지운 사진을 다시 고름(새 객체 · 같은 내용)
  await h.g._preCheckFiles('single', 'dropZone', files, ctx);
  assert.equal(h.calls.fetch.length, 4, '같은 사진은 다시 묻지 않는다');
  assert.equal(h.g._preHasBlock(), false);
});

test('H2-2 확인이 도는 중에 다음 사진을 넣어도 앞 사진은 다시 묻지 않는다(묻는 중인 질문을 같이 쓴다)', async () => {
  const pend = [];
  const h = harness({ fetchImpl: () => new Promise((r) => pend.push(() => r({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'pass', blocked: false, duplicate: null }) }))) });
  const files = [fo('a')];
  const r1 = h.g._preCheckFiles('single', 'dropZone', files.slice(), ctx);
  files.push(fo('b'));
  const r2 = h.g._preCheckFiles('single', 'dropZone', files.slice(), ctx);
  assert.equal(h.calls.fetch.length, 2, '앞 사진(진행 중) 1 + 새 사진 1');
  pend.forEach((f) => f());
  await Promise.all([r1, r2]);
  assert.equal(h.pre.checking(), false);
});

test('H2-3 판정을 못 받은 사진(429·끊김)은 기억하지 않는다 — 다음 첨부 때 다시 묻고, 그동안은 통과(fail-open)', async () => {
  let n = 0;
  const h = harness({ fetchImpl: () => (++n === 1
    ? Promise.resolve({ ok: false, status: 429, json: async () => ({ ok: false, error: '사진 확인 요청이 잠시 많았어요.' }) })
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, verdict: 'block', message: '리뷰 화면이 아니에요', blocked: true, duplicate: null }) })) });
  const files = [fo('a')];
  await h.g._preCheckFiles('single', 'dropZone', files, ctx);
  assert.equal(h.g._preHasBlock(), false, '429 = 무판정 통과(제출을 막지 않는다 · 서버가 업로드 때 중복을 다시 본다)');
  files.push(fo('b'));
  await h.g._preCheckFiles('single', 'dropZone', files, ctx);
  assert.equal(h.calls.fetch.length, 3, '못 받은 a 는 다시 묻고(1) 새 b 도 묻는다(1)');
  assert.equal(h.g._preHasBlock(), true, '다시 받은 판정은 그대로 반영된다');
});

test('H2-4 같은 사진이라도 다른 작업·줄이면 따로 묻는다(중복 판정은 줄마다 다르다)', async () => {
  const h = harness();
  await h.g._preCheckFiles('idx:0', 'mrSlot_0', [fo('a')], { ...ctx, rowIndex: 5 });
  await h.g._preCheckFiles('idx:1', 'mrSlot_1', [fo('a')], { ...ctx, rowIndex: 6 });
  assert.equal(h.calls.fetch.length, 2);
});

/* ═══ H2. 서버 제한기 — 확인과 업로드는 다른 통 · 검증된 리뷰어는 리뷰어별 ═══ */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'review-unstick-secret';
process.env.RL_REVIEW_IMAGE_IP_CEILING = '50';
const RL_PATH = '../src/middleware/rateLimit.middleware';

function startServer() {
  const express = require('express');
  const rl = require(RL_PATH);
  const app = express();
  app.use(express.json());
  const pre = rl.reviewPrecheckLimiter, up = rl.reviewUploadLimiter;
  app.post('/api/image/review-precheck', pre || rl.imageApiLimiter, (req, res) => res.json({ ok: true }));
  app.post('/api/image/review-upload', up || rl.imageApiLimiter, (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
function post(base, p, { ip, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': ip, ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); r.end('{}');
  });
}
const reviewer = (id) => require('../src/services/reviewerSession.service').issueReviewerSession({ ownerReviewerId: id, loginName: '김예시', loginPhone8: '12345678' });
const statuses = async (n, fnc) => { const out = []; for (let i = 0; i < n; i++) out.push((await fnc(i)).status); return out; };

test('H2-5 서버: 확인 4번 + 업로드 → 업로드가 429 로 막히지 않는다 · 같은 주소의 다른 리뷰어도 안 막힌다', async () => {
  const s = await startServer();
  const base = 'http://127.0.0.1:' + s.address().port;
  try {
    const A = { ip: '203.0.113.7', headers: { 'X-Reviewer-Token': reviewer('rA') } };
    const B = { ip: '203.0.113.7', headers: { 'X-Reviewer-Token': reviewer('rB') } };
    // 종전 화면이 실제로 보내던 수(1+2+3+4 = 10) 그대로 보내도
    assert.deepStrictEqual(await statuses(10, () => post(base, '/api/image/review-precheck', A)), Array(10).fill(200));
    assert.equal((await post(base, '/api/image/review-upload', A)).status, 200, '★ 확인이 업로드 통을 쓰지 않는다(H2: 업로드 429)');
    assert.equal((await post(base, '/api/image/review-precheck', B)).status, 200, '★ 같은 통신사 주소의 다른 리뷰어는 막히지 않는다');
    assert.equal((await post(base, '/api/image/review-upload', B)).status, 200);
  } finally { s.close(); }
});

test('H2-6 서버: 남용 방어는 그대로 — 리뷰어 한 명 확인 분당 10 · 검증 안 된 요청은 주소별 10 · 위조 토큰은 주소로 · 주소별 상한', async () => {
  const rl = require(RL_PATH);
  assert.equal(typeof rl.reviewPrecheckLimiter, 'function', '리뷰 캡처 1차 필터 전용 제한기');
  assert.equal(typeof rl.reviewUploadLimiter, 'function', '리뷰 캡처 업로드 전용 제한기');
  const s = await startServer();
  const base = 'http://127.0.0.1:' + s.address().port;
  try {
    const A = { ip: '198.51.100.1', headers: { 'X-Reviewer-Token': reviewer('rC') } };
    await statuses(10, () => post(base, '/api/image/review-precheck', A));
    const over = await post(base, '/api/image/review-precheck', A);
    assert.equal(over.status, 429, '리뷰어 한 명의 확인(AI 콜)은 분당 10 그대로');
    assert.match(over.body, /1분 뒤/, '429 안내는 얼마나 기다릴지 말한다');
    // 업로드 통 = 30
    assert.deepStrictEqual(await statuses(30, () => post(base, '/api/image/review-upload', { ...A, ip: '198.51.100.9' })), Array(30).fill(200));
    assert.equal((await post(base, '/api/image/review-upload', { ...A, ip: '198.51.100.9' })).status, 429, '업로드도 무제한이 아니다');
    // 로그인 안 한 요청 = 주소별 10(종전과 같다) — 다른 로그인 리뷰어는 영향 없음
    const anon = { ip: '198.51.100.2' };
    assert.deepStrictEqual(await statuses(10, () => post(base, '/api/image/review-precheck', anon)), Array(10).fill(200));
    assert.equal((await post(base, '/api/image/review-precheck', anon)).status, 429);
    assert.equal((await post(base, '/api/image/review-precheck', { ...anon, headers: { 'X-Reviewer-Token': 'forged.token.value' } })).status, 429, '위조 토큰은 신원이 아니다(주소 통)');
    assert.equal((await post(base, '/api/image/review-precheck', { ...anon, headers: { 'X-Reviewer-Token': reviewer('rD') } })).status, 200);
    // 검증된 리뷰어도 주소별 상한(시험값 50)을 받는다 — 세션을 여럿 만들어 AI 콜을 늘리지 못하게
    const ip = '198.51.100.3';
    const many = await statuses(51, (i) => post(base, '/api/image/review-precheck', { ip, headers: { 'X-Reviewer-Token': reviewer('m' + i) } }));
    assert.deepStrictEqual(many.slice(0, 50), Array(50).fill(200));
    assert.equal(many[50], 429, '★ 주소별 상한(완화 금지)');
  } finally { s.close(); }
});

test('H2-7 라우트 배선: 리뷰 1차 필터·업로드는 전용 제한기 · 구매 캡처 추출은 imageApiLimiter 그대로', () => {
  const DIAG = fs.readFileSync(path.resolve(__dirname, '../src/routes/diag.routes.js'), 'utf8');
  assert.match(DIAG, /router\.post\('\/review-precheck', reviewPrecheckLimiter,/);
  assert.match(DIAG, /router\.post\('\/review-upload', reviewUploadLimiter,/);
  assert.match(DIAG, /router\.post\('\/image-extract', imageApiLimiter,/);
  assert.match(DIAG, /router\.post\('\/image-upload', imageUploadLimiter,/);
});
