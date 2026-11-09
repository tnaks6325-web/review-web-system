/**
 * reviewerHomeNetFailure.test.js — 결정 359 회귀가드
 * "통신 실패를 성공으로 · 오류를 빈 목록으로 · 끝없는 불러오는 중 · 개발자 영어 문구" (리뷰어 홈)
 *
 *   A. api.js gasGet/gasPost — 서버에 닿지 못함·시간 초과·응답 해석 실패에 ok:false(가산) + 쉬운 한국어.
 *      서버가 준 응답(성공·200+{error})은 손대지 않는다.
 *   B. api.js gasPostUpload — 전송 실패·응답 해석 실패(413 HTML)에 ok:false(가산) · _transport/_httpStatus 유지.
 *   C. apiFriendlyErrorMessage — 영어 개발자 문구 → 한국어 · 서버 한국어 사유는 그대로.
 *   D. reviewer-cs.js — 1:1문의 보내기 실패 때 글·사진 유지 + 안내 · 대화 조회 실패 ≠ 빈 방 · 배지 유지 · 연타 1회.
 *   E. index.html — 문의함·소식·모집공고 실패 = 오류 + [다시 불러오기] · 멈춘 서버 = 제한 시간 뒤 오류 ·
 *      수정요청/취소 실패를 접수·취소로 안내하지 않음 · 리뷰 내역 갱신 실패에도 「불러오는 중」 해제 ·
 *      서명 오류(REVIEWER_AUTH_INVALID)도 한 번 갱신 · 로그인 갱신 15초 제한.
 * 실행: node tests/reviewerHomeNetFailure.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const API = read('frontend/api.js');
const HTML = read('frontend/index.html');
const CS = read('frontend/js/reviewer-cs.js');

let passed = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  passed++;
  console.log('  ✓ ' + name);
}
const fnSrc = (src, name, prefix = 'async function ') => {
  const i = src.indexOf(prefix + name + '(');
  assert(i > -1, name + ' 없음');
  // 매개변수 괄호를 끝까지 건너뛴 뒤의 첫 { 가 본문(기본값 `opts = {}` 의 중괄호를 본문으로 오인하지 않게)
  let p = src.indexOf('(', i), pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let depth = 0; const j = src.indexOf('{', p);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
  throw new Error(name + ' 본문 끝 못 찾음');
};
const ENGLISH = /Failed to fetch|Load failed|is not valid JSON|Unexpected token|Internal Server Error/;
const NET_KO = '인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요.';
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('\n▶ 결정 359 — 리뷰어 홈 통신 실패 처리\n');

  /* ── A. gasGet / gasPost ── */
  {
    const mkCtx = (fetchImpl) => {
      const ctx = { API_BASE_URL: 'http://t', console: { warn() {}, error() {}, log() {} }, AbortController, setTimeout, clearTimeout,
        URLSearchParams, JSON, sessionStorage: { setItem() {} }, fetch: fetchImpl,
        _ACTION_MAP: { g: { method: 'GET', path: '/g' }, p: { method: 'POST', path: '/p' } },
        _resolveApiPath: (p) => p, _getAuthHeaders: () => ({}) };
      vm.createContext(ctx);
      vm.runInContext(fnSrc(API, 'gasGet') + '\n' + fnSrc(API, 'gasPost') + '\nthis.gasGet = gasGet; this.gasPost = gasPost;', ctx);
      return ctx;
    };
    const netFail = async () => { throw new TypeError('Failed to fetch'); };
    const abortFail = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const html502 = async () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected token \'<\', "<html><bod"... is not valid JSON'); } });
    const html413 = async () => ({ status: 413, ok: false, json: async () => { throw new SyntaxError('Unexpected token'); } });
    for (const fn of ['gasGet', 'gasPost']) {
      const call = (impl) => mkCtx(impl)[fn]({ action: fn === 'gasGet' ? 'g' : 'p' });
      const n = await call(netFail);
      ok(`${fn}: 끊김 → ok:false · networkError · 쉬운 한국어(영어 원문 없음)`, n.ok === false && n.networkError === true && n.error === NET_KO, n);
      const a = await call(abortFail);
      ok(`${fn}: 시간 초과 → ok:false · timeout`, a.ok === false && a.timeout === true && /시간이 초과/.test(a.error), a);
      const h = await call(html502);
      ok(`${fn}: HTML 오류 응답(502) → ok:false · badResponse · httpStatus · 'is not valid JSON' 노출 없음`,
        h.ok === false && h.badResponse === true && h.httpStatus === 502 && !ENGLISH.test(h.error) && /[가-힣]/.test(h.error), h);
      const big = await call(html413);
      ok(`${fn}: 413 HTML → 크기 안내`, big.ok === false && big.httpStatus === 413 && /너무 커요/.test(big.error), big);
      const okBody = { ok: true, threads: [1] };
      const s = await call(async () => ({ status: 200, ok: true, json: async () => okBody }));
      ok(`${fn}: 정상 응답은 그대로(가산 필드 없음)`, s === okBody && !('networkError' in s));
      const errBody = { error: '서버 오류가 발생했습니다.' };
      const e = await call(async () => ({ status: 200, ok: true, json: async () => errBody }));
      ok(`${fn}: 서버가 준 200+{error} 는 손대지 않는다(서버 사유 보존)`, e === errBody && !('ok' in e));
    }
    // 응답 본문이 끊겨 멈춰도 제한 시간이 본문 읽기까지 덮는다
    const fastCtx = mkCtx(async (url, opts) => ({ status: 200, ok: true,
      json: () => new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); })) }));
    const slow = await fastCtx.gasGet({ action: 'g' }, 20);
    ok('gasGet: 본문 읽기가 멈춰도 제한 시간 뒤 timeout 으로 끝난다', slow.ok === false && slow.timeout === true, slow);
  }

  /* ── B. gasPostUpload / _xhrPost ── */
  {
    const s = API.indexOf('async function gasPostUpload(body, timeout) {');
    const e = API.indexOf('\n}\n', s) + 3;
    const mk = (mode) => {
      const ctx = { _ACTION_MAP: { reviewEditRequest: { method: 'POST', path: '/x' } }, API_BASE_URL: 'http://t',
        _uploadProgress: { show() {}, update() {}, hide() {} }, _apiToast() {},
        _xhrPost: async () => { throw new Error(mode); } };
      vm.createContext(ctx); vm.runInContext(API.slice(s, e) + '; this.f = gasPostUpload;', ctx); return ctx.f;
    };
    for (const m of ['timeout', 'aborted', '네트워크 오류 — 인터넷 연결을 확인하세요.', 'weird']) {
      const r = await mk(m)({ action: 'reviewEditRequest' });
      ok('gasPostUpload 전송 실패(' + m + ') → ok:false · _transport 유지', r.ok === false && r._transport === true && r.networkError === true, r);
    }
    // _xhrPost onload 해석 실패(프록시 413 HTML) → ok:false + _httpStatus
    const xs = fnSrc(API, '_xhrPost', 'function ');
    class FakeXHR {
      open() {} setRequestHeader() {}
      send() { this.status = 413; this.responseText = '<html>413 Request Entity Too Large</html>'; this.onload(); }
    }
    const ctx = { XMLHttpRequest: FakeXHR, _getAuthHeaders: () => ({}), JSON };
    vm.createContext(ctx); vm.runInContext(xs + '; this.x = _xhrPost;', ctx);
    const out = await ctx.x('http://t/x', {}, 1000);
    ok('_xhrPost: 응답 해석 실패 → ok:false · _httpStatus 413', out.ok === false && out._httpStatus === 413, out);
  }

  /* ── C. apiFriendlyErrorMessage ── */
  {
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fnSrc(API, 'apiFriendlyErrorMessage', 'function ') + '; this.f = apiFriendlyErrorMessage;', ctx);
    const f = ctx.f;
    ok('Failed to fetch(크롬) → 한국어', f(new TypeError('Failed to fetch')) === NET_KO);
    ok('Load failed(아이폰 사파리) → 한국어', f(new TypeError('Load failed')) === NET_KO);
    ok("'… is not valid JSON' → 한국어", !ENGLISH.test(f(new SyntaxError('Unexpected token \'<\', "<html>"... is not valid JSON'))));
    ok('Internal Server Error → 한국어', /[가-힣]/.test(f({ error: 'Internal Server Error' })) && !ENGLISH.test(f({ error: 'Internal Server Error' })));
    const ab = new Error('x'); ab.name = 'AbortError';
    ok('AbortError → 늦어짐 안내', /늦어지고/.test(f(ab)));
    ok('업로드 응답 해석 실패 원문(서버 응답 파싱 실패 (HTTP 502)) → 쉬운 한국어', !/파싱|HTTP/.test(f({ ok: false, error: '서버 응답 파싱 실패 (HTTP 502)', _httpStatus: 502 })));
    ok('★ 서버가 준 한국어 사유는 그대로(가리지 않음)', f({ ok: false, error: '이미 처리 대기 중인 수정요청이 있습니다.' }) === '이미 처리 대기 중인 수정요청이 있습니다.');
    ok('영어만 있는 기타 원문 → 기본 문구(fallback)', f(new Error('Cannot read properties of undefined'), '다시 해 주세요') === '다시 해 주세요');
  }

  /* ── D. reviewer-cs.js ── */
  {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, innerHTML: '', value: '', textContent: '', disabled: false, style: {}, scrollTop: 0, scrollHeight: 0, addEventListener() {}, appendChild() {} });
    ['rcsOverlay', 'rcsInput', 'rcsSendBtn', 'rcsAttachBar', 'rcsThread', 'rcsTabDot'].forEach(el);
    const toasts = [];
    const calls = [];
    const plan = { send: [], messages: [], unread: [], upload: [] };
    const take = (k) => { const v = plan[k].shift(); return typeof v === 'function' ? v() : v; };
    const window = {};
    const ctx = {
      window, console, JSON, String, Date, setTimeout, clearTimeout, Promise,
      document: { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => el('x' + Math.random()), body: { appendChild() {} }, addEventListener() {} },
      setInterval: () => 0, EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
      localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
      showToast: (m) => toasts.push(String(m)), alert: (m) => toasts.push(String(m)),
      FileReader: function () { this.readAsDataURL = () => { this.result = 'data:image/png;base64,AAA'; this.onload(); }; },
      API_BASE_URL: 'http://t',
      gasGet: async (p) => { calls.push(p.action); return take(p.action === 'csReviewerMessages' ? 'messages' : 'unread'); },
      gasPost: async (p) => { calls.push(p.action); return take(p.action === 'csReviewerSend' ? 'send' : 'upload'); },
    };
    window.getSavedUser = () => ({ name: '홍길동', phone8: '12345678' });
    vm.createContext(ctx);
    // api.js 단일 출처 문구 함수도 같은 화면에 있다(실제 index.html 과 같은 순서)
    vm.runInContext(fnSrc(API, 'apiFriendlyErrorMessage', 'function '), ctx);
    vm.runInContext(CS, ctx);
    const RCS = window.ReviewerCS;
    ok('ReviewerCS 노출', !!RCS && typeof RCS.send === 'function' && typeof RCS.reload === 'function');

    // 대화 조회 실패 → 빈 방이 아니라 오류 + 다시 불러오기 (옛 모양 {error} · 새 모양 ok:false 둘 다)
    for (const failShape of [{ error: 'Failed to fetch' }, { ok: false, networkError: true, error: NET_KO }]) {
      plan.messages.push(failShape);
      await RCS.openChat('k1', '작업 A', 'review', 't1');
      const h = els.rcsThread.innerHTML;
      ok('대화 조회 실패(' + JSON.stringify(failShape).slice(0, 30) + ') → 「첫 메시지」 빈 방 아님 · 오류 + 다시 불러오기 · 영어 없음',
        !/첫 메시지/.test(h) && /불러오지 못했어요/.test(h) && /ReviewerCS\.reload\(\)/.test(h) && !ENGLISH.test(h), h);
    }
    plan.messages.push({ ok: true, threadId: 't1', messages: [] });
    plan.unread.push({ ok: true, totalUnread: 0 });
    await RCS.reload(); await tick();
    ok('정상 빈 대화는 종전대로 「첫 메시지」', /첫 메시지/.test(els.rcsThread.innerHTML));

    // 사진 첨부(업로드 성공) + 글 입력 → 보내기 끊김 → 글·사진 유지 + 안내
    plan.upload.push({ ok: true, url: 'https://img/1.png' });
    await RCS.pickFiles({ files: [{ name: 'a.png', type: 'image/png', size: 100 }], value: '' });
    ok('첨부 1장 준비됨', els.rcsAttachBar.style.display === 'flex' && /https:\/\/img\/1\.png|data:image/.test(els.rcsAttachBar.innerHTML));
    for (const failShape of [{ error: 'Failed to fetch' }, { ok: false, networkError: true, error: NET_KO }, { error: '서버 오류가 발생했습니다.' }]) {
      els.rcsInput.value = '배송이 안 왔어요';
      toasts.length = 0;
      plan.send.push(failShape);
      await RCS.send();
      ok('★ 보내기 실패(' + JSON.stringify(failShape).slice(0, 34) + ') → 쓴 글 그대로',
        els.rcsInput.value === '배송이 안 왔어요', els.rcsInput.value);
      ok('★ 보내기 실패 → 첨부 사진 그대로', els.rcsAttachBar.style.display === 'flex', els.rcsAttachBar.style);
      ok('보내기 실패 → 안내(한국어 · 영어 원문 없음)', toasts.some((t) => /전송하지 못했어요/.test(t)) && !toasts.some((t) => ENGLISH.test(t)), toasts);
      ok('보내기 버튼 다시 눌러진다', els.rcsSendBtn.disabled === false);
    }
    // 연타: 보내는 중 두 번째 누름은 무시
    let release;
    plan.send.push(() => new Promise((r) => { release = r; }));
    const before = calls.filter((c) => c === 'csReviewerSend').length;
    const p1 = RCS.send(); await tick();
    ok('보내는 중에는 버튼 잠김', els.rcsSendBtn.disabled === true);
    await RCS.send();
    ok('보내는 중 두 번째 누름은 요청을 더 보내지 않는다', calls.filter((c) => c === 'csReviewerSend').length === before + 1);
    plan.messages.push({ ok: true, threadId: 't1', messages: [{ senderRole: 'reviewer', content: '배송이 안 왔어요' }] });
    plan.unread.push({ ok: true, totalUnread: 0 });
    release({ ok: true, threadId: 't1' });
    await p1; await tick();
    ok('★ 보내기 성공 → 그때 입력칸 비움', els.rcsInput.value === '');
    ok('★ 보내기 성공 → 첨부 비움', els.rcsAttachBar.style.display === 'none');
    ok('보내기 성공 → 대화 다시 불러와 내 글 보임', /배송이 안 왔어요/.test(els.rcsThread.innerHTML));

    // 배지: 성공 3 → 실패 → 그대로 3
    plan.unread.push({ ok: true, totalUnread: 3 });
    await RCS.refreshUnread(true);
    ok('배지 3', els.rcsTabDot.textContent === '3');
    for (const failShape of [{ error: 'Failed to fetch' }, { ok: false, networkError: true, error: NET_KO }]) {
      plan.unread.push(failShape);
      await RCS.refreshUnread(true);
      ok('★ 미확인 조회 실패(' + JSON.stringify(failShape).slice(0, 26) + ') → 배지를 0으로 지우지 않는다', els.rcsTabDot.textContent === '3' && els.rcsTabDot.style.display !== 'none', els.rcsTabDot);
    }
    plan.unread.push({ ok: true, totalUnread: 0 });
    await RCS.refreshUnread(true);
    ok('정상 0 이면 종전대로 지운다', els.rcsTabDot.textContent === '' && els.rcsTabDot.style.display === 'none');
  }

  /* ── E. index.html ── */
  const homeCtx = (extra) => {
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, classList: { contains: () => true } });
    const toasts = [];
    const ctx = Object.assign({
      console, JSON, String, Number, Object, Array, Promise, Date, URLSearchParams, AbortController, setTimeout, clearTimeout, Error,
      API_BASE_URL: 'http://t', els, el, toasts,
      document: { getElementById: (id) => els[id] || null },
      escHtml: (s) => String(s == null ? '' : s).replace(/</g, '&lt;'),
      showToast: (m) => toasts.push(String(m)), confirm: () => true,
    }, extra || {});
    vm.createContext(ctx);
    vm.runInContext(fnSrc(API, 'apiFriendlyErrorMessage', 'function '), ctx);
    vm.runInContext(fnSrc(HTML, '_rhErrMsg', 'function ') + '\n' + fnSrc(HTML, '_rhFetchJson'), ctx);
    return ctx;
  };
  const hangFetch = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  const fetchCases = {
    '500 JSON(ok:false)': async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Internal Server Error' }) }),
    '200+{error}': async () => ({ ok: true, status: 200, json: async () => ({ error: '서버 오류가 발생했습니다.' }) }),
    '502 HTML': async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token \'<\'... is not valid JSON'); } }),
    '끊김': async () => { throw new TypeError('Load failed'); },
  };

  // 소식
  {
    for (const [label, f] of Object.entries(fetchCases)) {
      const ctx = homeCtx({ fetch: f }); ctx.el('reviewerNoticeList');
      vm.runInContext(fnSrc(HTML, 'loadReviewerNoticesHome'), ctx);
      await vm.runInContext('loadReviewerNoticesHome()', ctx);
      const h = ctx.els.reviewerNoticeList.innerHTML;
      ok('소식 ' + label + ' → 「새로운 소식이 없습니다」 아님 · 오류 + 다시 불러오기 · 영어 없음',
        !/새로운 소식이 없습니다/.test(h) && /불러오지 못했습니다/.test(h) && /loadReviewerNoticesHome\(\)/.test(h) && !ENGLISH.test(h), h);
    }
    const ctx = homeCtx({ fetch: hangFetch, setTimeout: (fn, ms) => setTimeout(fn, 5) }); ctx.el('reviewerNoticeList');
    vm.runInContext(fnSrc(HTML, 'loadReviewerNoticesHome'), ctx);
    await vm.runInContext('loadReviewerNoticesHome()', ctx);
    ok('★ 소식: 서버가 멈추면 제한 시간 뒤 오류 + 다시 불러오기(끝없는 「불러오는 중」 아님)', /다시 불러오기/.test(ctx.els.reviewerNoticeList.innerHTML) && /늦어지고/.test(ctx.els.reviewerNoticeList.innerHTML));
    const okCtx = homeCtx({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, notices: [] }) }) }); okCtx.el('reviewerNoticeList');
    vm.runInContext(fnSrc(HTML, 'loadReviewerNoticesHome'), okCtx);
    await vm.runInContext('loadReviewerNoticesHome()', okCtx);
    ok('소식: 정상 0건은 종전대로 「새로운 소식이 없습니다」', /새로운 소식이 없습니다/.test(okCtx.els.reviewerNoticeList.innerHTML));
    ok('소식 제한 시간 20초', /_rhFetchJson\(API_BASE_URL \+ "\/api\/reviewer\/notices", 20000\)/.test(fnSrc(HTML, 'loadReviewerNoticesHome')));
  }

  // 모집공고
  {
    const mk = (f, extra) => {
      const ctx = homeCtx(Object.assign({ fetch: f }, extra || {})); ctx.el('recruitPreviewList'); ctx.el('recruitPreviewList2');
      vm.runInContext('var _rcLastJson = null; var rendered = []; function _renderRecruitPreview(j){ rendered.push(j); document.getElementById("recruitPreviewList2").innerHTML = "LIST:" + (j.data||[]).length; }', ctx);
      vm.runInContext(fnSrc(HTML, 'loadRecruitPreview'), ctx);
      return ctx;
    };
    for (const [label, f] of Object.entries(fetchCases)) {
      const ctx = mk(f);
      await vm.runInContext('loadRecruitPreview()', ctx);
      const h = ctx.els.recruitPreviewList2.innerHTML;
      ok('모집공고 ' + label + ' → 「진행 중인 모집공고가 없습니다」 아님 · 오류 + 다시 불러오기 · 영어 없음',
        vm.runInContext('rendered.length', ctx) === 0 && /불러오지 못했습니다/.test(h) && /loadRecruitPreview\(\)/.test(h)
          && ctx.els.recruitPreviewList.innerHTML === h && !ENGLISH.test(h), h);
    }
    const hung = mk(hangFetch, { setTimeout: (fn) => setTimeout(fn, 5) });
    await vm.runInContext('loadRecruitPreview()', hung);
    ok('★ 모집공고: 서버가 멈추면 제한 시간 뒤 오류 + 다시 불러오기', /다시 불러오기/.test(hung.els.recruitPreviewList2.innerHTML));
    const good = mk(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: [{ id: 1 }] }) }));
    await vm.runInContext('loadRecruitPreview()', good);
    ok('모집공고 정상 → 종전대로 그린다', good.els.recruitPreviewList2.innerHTML === 'LIST:1');
    vm.runInContext('fetch = async () => { throw new TypeError("Failed to fetch"); }', good);
    good.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await vm.runInContext('loadRecruitPreview()', good);
    ok('모집공고 다시 부르다 실패 → 방금 보던 목록을 지우지 않는다', good.els.recruitPreviewList2.innerHTML === 'LIST:1');
  }

  // 내 문의함
  {
    for (const failShape of [{ error: 'Failed to fetch' }, { ok: false, networkError: true, error: NET_KO }, { error: '서버 오류가 발생했습니다.' }]) {
      const ctx = homeCtx({ gasGet: async () => failShape, getSavedUser: () => ({ name: 'A', phone8: '12345678' }) });
      ctx.el('csInboxList'); ctx.el('csInboxCount');
      vm.runInContext("let _csInbox = { threads: [], loading: false, error: '' };\n" + fnSrc(HTML, 'loadCsInbox') + '\n' + fnSrc(HTML, 'renderCsInbox', 'function ') + "\nfunction _csTimeLabel(){ return ''; }", ctx);
      await vm.runInContext('loadCsInbox()', ctx);
      const h = ctx.els.csInboxList.innerHTML;
      ok('★ 문의함 조회 실패(' + JSON.stringify(failShape).slice(0, 30) + ') → 「아직 남긴 문의가 없습니다」 아님 · 오류 + 다시 불러오기 · 건수 0건 아님',
        !/아직 남긴 문의가 없습니다/.test(h) && /불러오지 못했습니다/.test(h) && /loadCsInbox\(\)/.test(h) && ctx.els.csInboxCount.textContent !== '0건' && !ENGLISH.test(h), { h, c: ctx.els.csInboxCount.textContent });
    }
  }

  // 리뷰 이미지 교체 요청 · 요청 취소
  {
    const mk = (upRes, postRes) => {
      const ctx = homeCtx({ gasPostUpload: async () => upRes, gasPost: async () => postRes });
      ctx.el('reEditSubmitBtn'); ctx.el('reEditReason');
      vm.runInContext(`let _reEditCtx = { phone8:'12345678', sheetId:'s', tabName:'t', gid:'', rowIndex:3 }; let _reEditTargetOldId = 'old'; let _reEditNewB64 = 'AAA'; let reloaded = 0;
        async function _reEditLoadFiles(){ reloaded++; }\n` + fnSrc(HTML, '_reEditSubmit') + '\n' + fnSrc(HTML, '_reEditCancel'), ctx);
      return ctx;
    };
    const fails = {
      '업로드 끊김(_transport)': { error: '업로드가 중단되었습니다. 네트워크 연결을 확인하세요.', _transport: true },
      '413 HTML(옛 모양 — ok 없음)': { error: '서버 응답 파싱 실패 (HTTP 413)', _httpStatus: 413 },
      '413 JSON': { ok: false, error: '전송 용량이 초과되었습니다. 이미지 크기를 줄여 다시 시도해주세요.', _httpStatus: 413 },
      '200+{error}': { error: 'Drive quota exceeded' },
    };
    for (const [label, r] of Object.entries(fails)) {
      const ctx = mk(r, null);
      await vm.runInContext('_reEditSubmit()', ctx);
      ok('★ 교체 요청 ' + label + ' → 「접수되었습니다」 아님 · 실패 안내 · 버튼 다시 눌림',
        !ctx.toasts.some((t) => /접수되었습니다/.test(t)) && ctx.toasts.length === 1 && !ENGLISH.test(ctx.toasts[0]) && /[가-힣]/.test(ctx.toasts[0])
          && ctx.els.reEditSubmitBtn.disabled === false && vm.runInContext('reloaded', ctx) === 0, ctx.toasts);
      if (/413/.test(label)) ok('교체 요청 413 → 사진 용량 안내', /용량/.test(ctx.toasts[0]), ctx.toasts);
    }
    const good = mk({ ok: true, requestId: 9 }, null);
    await vm.runInContext('_reEditSubmit()', good);
    ok('교체 요청 정상 → 종전대로 접수 안내', good.toasts.some((t) => /접수되었습니다/.test(t)) && vm.runInContext('reloaded', good) === 1);
    for (const r of [{ error: 'Failed to fetch' }, { ok: false, networkError: true, error: NET_KO }, { error: '서버 오류가 발생했습니다.' }]) {
      const ctx = mk(null, r);
      await vm.runInContext("_reEditCancel('5')", ctx);
      ok('★ 요청 취소 실패(' + JSON.stringify(r).slice(0, 30) + ') → 「취소했습니다」 아님 · 영어 없음',
        !ctx.toasts.some((t) => /취소했습니다/.test(t)) && ctx.toasts.length === 1 && !ENGLISH.test(ctx.toasts[0]), ctx.toasts);
    }
    const c2 = mk(null, { ok: false, error: '이미 처리된 요청입니다 (approved).' });
    await vm.runInContext("_reEditCancel('5')", c2);
    ok('요청 취소 — 서버 업무 사유는 그대로 보인다', c2.toasts[0] === '이미 처리된 요청입니다 (approved).', c2.toasts);
  }

  // 리뷰 내역 — 갱신 실패에도 「불러오는 중」 해제 · 서명 오류도 한 번 갱신
  {
    const loaderSrc = read('frontend/js/reviewer-history-loader.js');
    const mk = (fetchHistory, refresh) => {
      const ctx = homeCtx({ module: undefined });
      vm.runInContext(loaderSrc.replace('typeof window===\'undefined\'?globalThis:window', 'globalThis'), ctx);
      ctx._fetchReviewHistoryImpl = fetchHistory; ctx._refreshImpl = refresh;
      vm.runInContext(`
        const _historyCoordinator = ReviewerHistoryLoader.createCoordinator();
        var _historySessionKey='', _historyMode='legacy', _historyCounts=null, _historyAppliedResponse=null, _historyGeneration=0;
        var _historyCursors={pending:null,done:null}, _historyMoreBusy=false, _orderPollTimer=null;
        var _reviewListData={pending:[],done:[]}, _reviewListError='', _reviewListLoading=true, _reviewListTruncated=false;
        var _reviewEarnings={}, _reEditTabUser=null, _reviewSubTab='pending', refreshCalls=0, renders=[];
        function _historyKey(u){ return String(u&&u.reviewerToken||'')+'|'+String(u&&u.phone8||''); }
        async function _fetchReviewHistory(u){ return _fetchReviewHistoryImpl(u); }
        async function _refreshReviewerHomeSession(u){ refreshCalls++; return _refreshImpl(u); }
        function renderReviewSubTab(){ renders.push({ loading:_reviewListLoading, error:_reviewListError }); }
        function _loadAllDoneHistory(){} function _scheduleOrderPendingRefresh(){} function _loadMissingCaptures(){} function _loadReviewEarnings(){}
      ` + fnSrc(HTML, 'loadReviewList'), ctx);
      return ctx;
    };
    const coded = (code, msg) => { const e = new Error(msg || '리뷰어 로그인이 만료되었거나 유효하지 않습니다.'); e.code = code; return e; };
    const stuck = mk(async () => { throw coded('REVIEWER_SESSION_EXPIRED'); }, async () => { throw new TypeError('Failed to fetch'); });
    await vm.runInContext("loadReviewList({ name:'A', phone8:'12345678', reviewerToken:'old' })", stuck);
    ok('★ 만료 → 재로그인 확인까지 끊김 → 「불러오는 중」 해제 + 오류(다시 불러오기 화면)',
      vm.runInContext('_reviewListLoading', stuck) === false && /[가-힣]/.test(vm.runInContext('_reviewListError', stuck)), vm.runInContext('renders', stuck));
    let n = 0;
    const inv = mk(async (u) => { n++; if (u.reviewerToken === 'bad') throw coded('REVIEWER_AUTH_INVALID'); return { ok: true, mode: 'legacy', results: [{ isSubmitted: false, id: 1 }] }; },
      async (u) => ({ ...u, reviewerToken: 'fresh' }));
    await vm.runInContext("loadReviewList({ name:'A', phone8:'12345678', reviewerToken:'bad' })", inv);
    ok('★ 서명 오류(REVIEWER_AUTH_INVALID)도 한 번 갱신 후 다시 불러온다', vm.runInContext('refreshCalls', inv) === 1 && n === 2
      && vm.runInContext('_reviewListData.pending.length', inv) === 1 && vm.runInContext('_reviewListError', inv) === '', { n, err: vm.runInContext('_reviewListError', inv) });
    const loop = mk(async () => { throw coded('REVIEWER_AUTH_INVALID'); }, async (u) => ({ ...u, reviewerToken: 'fresh2' }));
    await vm.runInContext("loadReviewList({ name:'A', phone8:'12345678', reviewerToken:'bad' })", loop);
    ok('갱신 후에도 실패하면 한 번만 다시(무한 반복 없음) · 오류 화면', vm.runInContext('refreshCalls', loop) === 1 && vm.runInContext('_reviewListLoading', loop) === false);
    const net = mk(async () => { throw new TypeError('Load failed'); }, async () => null);
    await vm.runInContext("loadReviewList({ name:'A', phone8:'12345678', reviewerToken:'t' })", net);
    ok('리뷰 내역 끊김 → 「Load failed」 대신 쉬운 한국어', vm.runInContext('_reviewListError', net) === NET_KO, vm.runInContext('_reviewListError', net));
    const legacy = mk(async () => ({ ok: false, code: 'REVIEWER_AUTH_INVALID', error: '리뷰어 정보를 찾을 수 없습니다.' }), async () => { throw new TypeError('Failed to fetch'); });
    await vm.runInContext("loadReviewList({ name:'A', phone8:'12345678', reviewerToken:'t' })", legacy);
    ok('옛 조회 응답의 인증 오류 + 갱신 끊김 → 서버 사유로 오류 화면(멈춤 없음)', vm.runInContext('_reviewListLoading', legacy) === false && vm.runInContext('_reviewListError', legacy) === '리뷰어 정보를 찾을 수 없습니다.');
  }

  // 로그인 갱신 15초 제한
  {
    const ctx = homeCtx({ fetch: hangFetch, setTimeout: (fn) => setTimeout(fn, 5), localStorage: { setItem() {} }, sessionStorage: { setItem() {} } });
    vm.runInContext('const USER_KEY="u"; const HOME_SESSION_KEY="h"; function syncSearchSession(){}\n' + fnSrc(HTML, '_refreshReviewerHomeSession'), ctx);
    const r = await vm.runInContext("_refreshReviewerHomeSession({ name:'A', phone8:'12345678' }).then(()=>'resolved', e => 'rejected:' + e.name)", ctx);
    ok('★ 로그인 갱신 요청이 멈추면 제한 시간 뒤 끝난다(끝없이 기다리지 않음)', r === 'rejected:AbortError', r);
    ok('로그인 갱신 제한 시간 15초', /setTimeout\(\(\) => ctl\.abort\(\), 15000\)/.test(fnSrc(HTML, '_refreshReviewerHomeSession')));
    ok('참여상품 정보 조회도 15초 제한', /participation-brief\?'[\s\S]{0,120}signal: ctl\.signal/.test(HTML) && /const timer = setTimeout\(\(\) => ctl\.abort\(\), 15000\);\s*\n\s*try \{\s*\n\s*const r = await fetch\(API_BASE_URL \+ '\/api\/review-edit\/participation-brief/.test(HTML));
  }

  console.log(`\nreviewerHomeNetFailure: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
