'use strict';
/**
 * ★ 결정 402 — 공고 화면(campaign.html)의 구매양식 틀(iframe) 주소 바꾸기는 방문 기록을 쌓지 않는다 (점검 보고서 L1)
 *
 *  옵션·개수를 바꾸면 틀 주소가 달라져 `frame.src = 새 주소` 로 다시 열었다. 이미 열린 틀의 src 를 바꾸면 브라우저가
 *  방문 기록을 한 칸 쌓는다(크롬·웹킷 실측: history.length +1). 그래서 휴대폰 [뒤로]가 공고를 떠나지 않고
 *  틀만 바꾸기 전 주소(옛 옵션 · optionKey 없음)로 되돌렸다. 만료된 명의의 틀 비우기(about:blank)도 같다.
 *
 *  고친 뒤: 이미 열린 틀은 contentWindow.location.replace(지금 칸을 바꿔 끼움) — 처음 여는 틀은 종전 그대로 src.
 *
 *  아래 가짜 틀은 브라우저 규칙(크롬·웹킷에서 잰 것)을 그대로 흉내 낸다:
 *   - 처음 여는 틀(아직 처음의 빈 문서)에 src → 기록 안 쌓임
 *   - 이미 열린 틀에 **다른 주소**로 src → 기록 1칸 쌓임 / 같은 주소로 src → 다시 열리지만 안 쌓임
 *   - location.replace → 항상 다시 열리고 안 쌓임
 *  화면 함수는 campaign.html 에서 그대로 꺼내 vm 에서 돌린다(문자열 존재만 보지 않는다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend', 'campaign.html'), 'utf8');
const SCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const ORIGIN = 'https://review.example.test';

/** 중괄호 짝 맞추기 — 따옴표·주석·정규식 밖의 중괄호만 센다(이 파일들의 함수는 정규식에 중괄호를 쓰지 않는다). */
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
/** 틀 postMessage 받는 곳(window.addEventListener('message', (ev)=>{ … })) 본문 그대로 */
function grabMessageHandler() {
  const i = SCRIPT.indexOf("window.addEventListener('message', (ev)=>{");
  assert.ok(i >= 0, '틀 메시지 받는 곳이 있어야 한다');
  const s = SCRIPT.indexOf('{', i + "window.addEventListener('message', (ev)=>".length - 1);
  return '(ev)=>' + SCRIPT.slice(s, braceEnd(SCRIPT, s) + 1);
}

const abs = (u) => (u === 'about:blank' ? u : new URL(u, ORIGIN + '/campaign.html').href);

/** 공고 화면의 작은 세계: 실제 함수 + 가짜 틀(브라우저 방문 기록 규칙 흉내) */
function world({ tabsOn = false, preview = false } = {}) {
  const hist = { pushes: 0, navs: [], opened: [] };
  const track = [];
  function makeFrame() {
    const f = {
      dataset: {}, style: { display: '' }, _attr: {}, offsetWidth: 0, loaded: '', title: '', className: '',
      classList: { add() {}, remove() {} },
      get id() { return this._attr.id || ''; }, set id(v) { this._attr.id = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attr, k) ? this._attr[k] : null; },
      setAttribute(k, v) { this._attr[k] = String(v); if (k === 'src') nav(f, String(v), 'src'); },
      removeAttribute(k) { delete this._attr[k]; },
      onerror: null,
    };
    Object.defineProperty(f, 'src', { get() { return f._attr.src ? abs(f._attr.src) : ''; }, set(v) { f.setAttribute('src', v); } });
    f.contentWindow = {
      _submitOrderFormInProgress: false,
      location: { replace(u) { nav(f, String(u), 'replace'); }, get href() { return f.loaded || 'about:blank'; } },
    };
    return f;
  }
  function nav(f, url, how) {
    // 크롬·웹킷 실측 규칙: 이미 열린 틀을 「다른 주소」로 src 이동할 때만 기록이 쌓인다.
    const push = how === 'src' && f.loaded !== '' && abs(url) !== abs(f.loaded);
    if (push) hist.pushes++;
    hist.navs.push({ p8: f.dataset.p8 || '', how, url, push });
    f.loaded = url;
  }
  const first = makeFrame(); first.id = 'orderFrame'; track.push(first);
  const els = {};
  ['wdCards', 'qnaBox', 'orderBox', 'holdLabel', 'joinedFootNote', 'pvFormNote', 'frameFallback'].forEach(id => {
    els[id] = { style: { display: '' }, textContent: '', innerHTML: '' };
  });
  els.orderTrack = { appendChild(f) { track.push(f); return f; } };
  const sb = {
    console, URL, URLSearchParams,
    location: { href: ORIGIN + '/campaign.html?id=c1', origin: ORIGIN, search: '?id=c1' },
    document: {
      getElementById(id) { if (id === 'orderFrame') return track.find(f => f.id === 'orderFrame') || null; return els[id] || null; },
      querySelectorAll(sel) { return sel === '#orderTrack iframe' ? track.slice() : []; },
      createElement(tag) { assert.strictEqual(tag, 'iframe'); return makeFrame(); },
    },
    sessionStorage: { removeItem() {} },
    window: { open(u) { hist.opened.push(String(u)); } },
    setTimeout() { return 0; },
    CAMP_ID: 'c1', PREVIEW: preview, API_BASE_URL: ORIGIN, BATCH_KEY: 'camp_batch_c1',
    _keepFrameOnce: false, _slideDir: 0, _viewDoneP8: '',
    renderAcctPanel() {}, renderJoinedOption() {}, renderJoinedQty() {}, renderQnaCard() {},
    CampWorkDetail: { renderInto() {} },
    _pvOpenSim() { return false; },
    _tabsOn() { return tabsOn; },
    startHoldCountdown() {}, startPolling() {}, show() {},
    needLogin(then) { then && then(); },
    _onTabSubmitted() { return false; }, _uploadsPendingP8: new Set(), _goTabStep() {}, _capSaveHold() {},
    renderDone() {}, renderDoneBatch() {}, pvGo() {},
  };
  sb.window.document = sb.document;
  vm.createContext(sb);
  const src = ['$', '_frameUrl', '_navFrame', '_framesAll', '_frameByP8', '_frameOfSource', '_frameFor', '_activateFrame',
    '_frameSubmitting', '_releaseFrame', '_renderJoinedView', 'openFormWindow']
    .map(n => grab(n, n === '_frameUrl' || n === '_navFrame')).join('\n');
  vm.runInContext(src + '\nthis.__onMessage = ' + grabMessageHandler() + ';', sb);
  return { sb, hist, track };
}

/** 작업 내용 응답(옵션·개수) + 자리 — 서버 모양 그대로 */
function detail({ app = 11, optionKey = '라벤더', qty = null } = {}) {
  return {
    application: { id: app, status: 'applied', optionKey, expiresAt: new Date(Date.now() + 9e5).toISOString() },
    selectedOption: optionKey ? { optKey: optionKey, selectable: true } : null,
    qty: qty ? { purchaseQty: qty, amount: qty * 10000 } : null,
    workDetail: {}, options: [],
  };
}
const HOLD = (p8 = '00000000', tok = 'tok-a') => ({ phone8: p8, holdToken: tok, expiresAt: new Date(Date.now() + 9e5).toISOString() });
const optOf = (u) => new URL(abs(u)).searchParams.get('optionKey');

test('L1 처음 여는 틀 — 종전 그대로 src 로 연다(방문 기록 0 · 주소에 옵션·자리 문맥)', () => {
  const { sb, hist, track } = world();
  sb._renderJoinedView(detail(), HOLD());
  assert.strictEqual(hist.navs.length, 1);
  assert.strictEqual(hist.navs[0].how, 'src', '처음 열기는 src 대입 그대로(첫 이동은 기록을 쌓지 않는다)');
  assert.strictEqual(hist.pushes, 0);
  const u = new URL(abs(track[0].loaded));
  assert.strictEqual(u.pathname, '/search.html');
  assert.strictEqual(u.searchParams.get('optionKey'), '라벤더');
  assert.strictEqual(u.searchParams.get('holdToken'), 'tok-a');
  assert.strictEqual(u.searchParams.get('embed'), '1');
});

test('L1 옵션을 바꾸면 틀은 새 옵션으로 다시 열리되 방문 기록을 쌓지 않는다(location.replace)', () => {
  const { sb, hist, track } = world();
  sb._renderJoinedView(detail({ optionKey: '라벤더' }), HOLD());
  sb._renderJoinedView(detail({ optionKey: '무향' }), HOLD());    // _doChangeOption → enterJoined
  assert.strictEqual(hist.navs.length, 2, '옵션이 바뀌면 틀을 다시 연다(옵션 TOCTOU 봉합 — 결정 353 ③)');
  assert.strictEqual(optOf(track[0].loaded), '무향', '틀은 새 옵션 주소');
  assert.strictEqual(hist.navs[1].how, 'replace', '이미 열린 틀은 location.replace 로');
  assert.strictEqual(hist.pushes, 0, '휴대폰 [뒤로]가 틀만 옛 옵션으로 되돌리면 안 된다(기록 0칸)');
});

test('L1 개수를 바꿔도 같다 — 기록 0칸 · 새 개수 주소', () => {
  const { sb, hist, track } = world();
  sb._renderJoinedView(detail({ qty: 1 }), HOLD());
  sb._renderJoinedView(detail({ qty: 2 }), HOLD());    // _doChangeQty → enterJoined
  assert.strictEqual(new URL(abs(track[0].loaded)).searchParams.get('qty'), '2');
  assert.strictEqual(hist.pushes, 0);
});

test('L1 같은 주소로 다시 들어와도(10초 확인·다시 연결 등) 리뷰어 화면은 종전처럼 다시 연다 — 기록 0칸', () => {
  const { sb, hist } = world();
  sb._renderJoinedView(detail(), HOLD());
  sb._renderJoinedView(detail(), HOLD());
  assert.strictEqual(hist.navs.length, 2, '리뷰어 경로는 같은 주소도 다시 연다(제출 중 옛 옵션 파기 장치 — 종전 동작 유지)');
  assert.strictEqual(hist.pushes, 0);
});

test('L1 탭 넘기기(_keepFrameOnce)는 같은 주소면 다시 열지 않는다 — 옵션을 바꾼 뒤에도(지금 주소 기준)', () => {
  const { sb, hist } = world();
  sb._renderJoinedView(detail({ optionKey: '라벤더' }), HOLD());
  sb._renderJoinedView(detail({ optionKey: '무향' }), HOLD());
  const n = hist.navs.length;
  sb._keepFrameOnce = true;
  sb._renderJoinedView(detail({ optionKey: '무향' }), HOLD());
  assert.strictEqual(hist.navs.length, n, '바뀐 주소(무향)와 같으니 그 명의의 사진·입력을 지우지 않는다');
  assert.strictEqual(sb._keepFrameOnce, false, '한 번만 쓰고 내린다');
  // 탭 넘기기라도 옵션이 달라졌으면 다시 연다(기록은 0칸)
  sb._keepFrameOnce = true;
  sb._renderJoinedView(detail({ optionKey: '라벤더' }), HOLD());
  assert.strictEqual(hist.navs.length, n + 1);
  assert.strictEqual(hist.pushes, 0);
});

test('L1 여러 명의 틀(#orderTrack iframe[data-p8]) — 명의마다 옵션을 바꿔도 기록 0칸 · 만료 틀 비우기(about:blank)도 0칸 · 비운 틀을 다른 명의가 다시 써도 0칸', () => {
  const { sb, hist, track } = world({ tabsOn: true });
  sb._renderJoinedView(detail({ app: 11 }), HOLD('00000000', 'tok-a'));
  sb._renderJoinedView(detail({ app: 12 }), HOLD('11112222', 'tok-b'));
  assert.strictEqual(track.length, 2, '명의마다 틀 하나(결정 353)');
  assert.deepStrictEqual(hist.navs.map(n => n.how), ['src', 'src'], '새 틀의 처음 열기는 src 그대로');
  sb._renderJoinedView(detail({ app: 12, optionKey: '무향' }), HOLD('11112222', 'tok-b'));
  assert.strictEqual(optOf(track[1].loaded), '무향');
  assert.strictEqual(optOf(track[0].loaded), '라벤더', '다른 명의 틀은 그대로');
  // 보고 있지 않은 명의(1번째)가 만료 → 그 틀 비우기
  sb._releaseFrame('00000000');
  assert.strictEqual(track[0].loaded, 'about:blank');
  assert.strictEqual(track[0].dataset.p8, '', '비운 틀은 다른 명의가 쓸 수 있게');
  assert.strictEqual(track[0].style.display, 'none');
  // 비운 틀을 새 명의가 다시 씀
  sb._renderJoinedView(detail({ app: 13 }), HOLD('33334444', 'tok-c'));
  assert.strictEqual(track.length, 2, '비운 틀을 다시 쓴다(틀을 더 만들지 않는다)');
  assert.strictEqual(new URL(abs(track[0].loaded)).searchParams.get('holdToken'), 'tok-c');
  assert.strictEqual(hist.pushes, 0, '틀 주소가 몇 번 바뀌어도 휴대폰 [뒤로] 한 번이면 공고를 떠난다');
});

test('L1 제출 중인 틀은 비우지 않는다(결정 351·353 그대로)', () => {
  const { sb, hist, track } = world({ tabsOn: true });
  sb._renderJoinedView(detail({ app: 11 }), HOLD('00000000', 'tok-a'));
  track[0].contentWindow._submitOrderFormInProgress = true;
  sb._releaseFrame('00000000');
  assert.strictEqual(hist.navs.length, 1);
  assert.strictEqual(track[0].dataset.p8, '00000000');
});

test('L1 로그인 위임(embed-need-login) 뒤 다시 열기 — 지금 주소(바뀐 옵션)로 · 기록 0칸', () => {
  const { sb, hist, track } = world();
  sb._renderJoinedView(detail({ optionKey: '라벤더' }), HOLD());
  sb._renderJoinedView(detail({ optionKey: '무향' }), HOLD());
  sb.__onMessage({ origin: ORIGIN, source: track[0].contentWindow, data: { type: 'embed-need-login' } });
  assert.strictEqual(hist.navs.length, 3, '로그인 뒤 틀을 다시 연다');
  assert.strictEqual(optOf(track[0].loaded), '무향', '옛 옵션 주소로 되돌아가지 않는다');
  assert.strictEqual(hist.pushes, 0);
});

test('L1 [새 창으로 열기]는 지금 틀 주소(바뀐 옵션)를 연다', () => {
  const { sb, hist } = world();
  sb._renderJoinedView(detail({ optionKey: '라벤더' }), HOLD());
  sb._renderJoinedView(detail({ optionKey: '무향' }), HOLD());
  sb.openFormWindow();
  assert.strictEqual(hist.opened.length, 1);
  assert.strictEqual(optOf(hist.opened[0]), '무향');
});

test('L1 location.replace 를 못 부르면 종전 src 로 연다(틀이 안 열리는 것보다 기록 한 칸이 낫다 — fail-open)', () => {
  const { sb, hist, track } = world();
  sb._renderJoinedView(detail({ optionKey: '라벤더' }), HOLD());
  track[0].contentWindow = null;   // 틀 창이 아직 없거나 읽히지 않음
  sb._renderJoinedView(detail({ optionKey: '무향' }), HOLD());
  assert.strictEqual(optOf(track[0].getAttribute('src')), '무향', '틀은 새 옵션 주소로 열린다');
  assert.strictEqual(hist.navs[hist.navs.length - 1].how, 'src');
});

test('L1 관리자 미리보기 — 주소가 같으면 다시 열지 않고(시트 읽기 절약 · 종전), 바뀌면 기록 0칸으로', () => {
  const { sb, hist } = world({ preview: true });
  const pv = (k) => ({ application: { id: 0, status: 'applied', optionKey: k }, selectedOption: { optKey: k, selectable: true }, workDetail: {}, options: [] });
  sb._renderJoinedView(pv('라벤더'), null);
  sb._renderJoinedView(pv('라벤더'), null);
  assert.strictEqual(hist.navs.length, 1, '미리보기는 같은 주소면 건너뛴다');
  sb._renderJoinedView(pv('무향'), null);
  assert.strictEqual(hist.navs.length, 2);
  assert.strictEqual(hist.pushes, 0);
});

test('L1 정적 전수 — campaign.html 에서 틀 주소를 바꾸는 곳은 _navFrame 하나(맨 src 대입·setAttribute(src) 는 사진 칸뿐)', () => {
  const lines = SCRIPT.split('\n');
  const nav = grab('_navFrame', true);
  assert.ok(nav, '틀 주소 바꾸기 도우미 _navFrame 이 있어야 한다');
  assert.ok(/contentWindow/.test(nav) && /\.location\.replace\(/.test(nav), '이미 열린 틀은 location.replace');
  const hits = [];
  lines.forEach((ln, i) => {
    if (/\.src\s*=(?!=)|setAttribute\(\s*['"]src['"]/.test(ln)) hits.push({ n: i + 1, ln: ln.trim() });
  });
  const navStart = SCRIPT.slice(0, SCRIPT.indexOf('function _navFrame(')).split('\n').length;
  const navEnd = navStart + nav.split('\n').length - 1;
  const outside = hits.filter(h => !(h.n >= navStart && h.n <= navEnd));
  // 남는 것은 사진(img) 두 곳뿐이어야 한다 — 도움말 사진 · 내 정보 사진 미리보기
  assert.deepStrictEqual(outside.map(h => /\bimg\.(src\s*=|setAttribute\('src')/.test(h.ln)), outside.map(() => true),
    '틀 주소를 직접 바꾸는 곳이 남아 있다: ' + JSON.stringify(outside));
  assert.strictEqual(outside.length, 2);
  assert.ok(/_navFrame\(f, 'about:blank'\)/.test(grab('_releaseFrame')), '만료 틀 비우기도 _navFrame 으로');
  // 틀 주소를 읽는 곳(같은 주소 건너뛰기 · 새 창)은 지금 연 주소(_frameUrl)를 읽는다 — src 속성은 처음 주소에 머문다
  assert.ok(!/frame\.getAttribute\('src'\)/.test(SCRIPT), '틀 주소 비교는 _frameUrl 로');
  assert.ok(/function openFormWindow\(\)\{[^\n]*_frameUrl\(/.test(SCRIPT), '[새 창으로 열기]도 _frameUrl');
});

test('L1 정적 — campaign.html 이 읽는 도우미 JS 에는 틀 주소를 바꾸는 곳이 없다 · 방문 기록은 뒤로가기 도우미(RhSheetBack) 한 곳만', () => {
  const srcs = [...CAMP.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
  assert.ok(srcs.length >= 4, srcs.join(','));
  srcs.forEach(s => {
    const js = fs.readFileSync(path.join(ROOT, 'frontend', s), 'utf8');
    assert.ok(!/(frame|Frame|iframe)[\w.$()'"\]\[]*\.src\s*=(?!=)/.test(js), s + ' 가 틀 주소를 바꾸면 안 된다');
    assert.ok(!/contentWindow\.location/.test(js), s);
  });
  // ★ 결정 403 — 창(바텀시트) 뒤로가기를 위해 리뷰어 홈 도우미를 싣는다(위 반복이 그 파일에도 틀 주소 바꾸기 0 을 확인한다).
  //   그 외의 기록 조작은 여전히 0: 화면 스크립트에 pushState·popstate 없음 · 실린 JS 중 pushState 는 도우미 하나뿐.
  assert.ok(srcs.includes('js/reviewer-sheet-back.js'), '공고 화면은 창 뒤로가기 도우미를 싣는다(결정 403)');
  assert.deepStrictEqual(srcs.filter(s => /pushState/.test(fs.readFileSync(path.join(ROOT, 'frontend', s), 'utf8'))), ['js/reviewer-sheet-back.js'],
    '방문 기록을 쌓는 JS 는 뒤로가기 도우미 하나뿐');
  assert.ok(!/pushState|onpopstate|'popstate'/.test(SCRIPT), '공고 화면은 방문 기록을 직접 쌓지 않는다');
});

test('인라인 스크립트 문법', () => {
  const blocks = [...CAMP.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 1);
  blocks.forEach((b, i) => { assert.doesNotThrow(() => new vm.Script(b, { filename: 'campaign.html#script' + i })); });
});
