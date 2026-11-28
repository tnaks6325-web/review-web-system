'use strict';
/**
 * ★ 결정 416 — 공고 화면(campaign.html)이 다음 단계로 바뀌면 새 단계의 맨 위를 위쪽 띠(머리·남은 시간·명의 탭) 아래로 보여 준다
 *
 *  종전(실기 확인 2026-11-25): [참여하기]·[예약내역 제출]·[리뷰 캡처 제출]·구매양식 제출·Q&A 캡처 제출 뒤 화면이 바뀌어도
 *  누른 자리(아래쪽)에 그대로 머물러, 새 단계 맨 윗줄(예약 카드 첫 줄·방문일 칩, 완료 화면의 ✅)이 위쪽 띠 밑에 가려졌다.
 *  안드로이드는 참여 직후 남은 시간이 0.5~1초 「--:--」로 보였다.
 *
 *  고친 뒤: 화면 바꾸기 함수 show() 한 곳이 「단계가 바뀌었나」를 보고 도우미 하나(_stageAfterShow)가 올린다 — 종류별 사본 없음.
 *   · 처음 열 때(새로고침·재방문 복원)는 올리지 않는다(브라우저가 기억한 자리 그대로) — 시작 경로가 끝난 뒤(_stageArm)부터.
 *   · 같은 단계를 다시 그리는 것(10초 확인·다시 불러오기·옵션 변경)은 올리지 않는다.
 *   · 리뷰어가 보이는 칸에 입력 중이면(키보드·구매양식 틀) 올리지 않는다.
 *   · 움직임 줄이기 설정이면 한 번에(부드럽게 X).
 *  아래 시험은 campaign.html 의 함수를 그대로 꺼내 가짜 화면에서 실제로 돌린다(문자열 존재만 보지 않는다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend', 'campaign.html'), 'utf8');
const SCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
const SEARCH_APP = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'search-app.js'), 'utf8');
const VIEWS = ['vLoading', 'vPre', 'vMissing', 'vJoined', 'vExpired', 'vDone', 'vBlogPending', 'vBlogRejected', 'vReconnect'];

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
function grab(name) {
  let i = SCRIPT.indexOf('function ' + name + '(');
  if (i < 0) assert.fail('함수 없음: ' + name);
  if (SCRIPT.slice(i - 6, i) === 'async ') i -= 6;
  return SCRIPT.slice(i, braceEnd(SCRIPT, SCRIPT.indexOf('{', SCRIPT.indexOf(')', i))) + 1);
}
function grabLet(name) {
  const m = SCRIPT.match(new RegExp('\\n(let|const) ' + name.replace(/\$/g, '\\$') + ' = [^\\n]*'));
  if (!m) assert.fail('선언 없음: ' + name);
  return m[0];
}

/** 가짜 화면: 문서 좌표(docTop)·높이·부모·위치(sticky) 를 가진 요소들. window.scrollY 를 움직이면 화면 좌표가 따라 움직인다. */
function world({ reduce = false, scrollY = 900 } = {}) {
  const els = {};
  const win = { scrollY, pageYOffset: scrollY, scrolls: [], throwOpts: false, throwAll: false };
  const el = (id, o = {}) => {
    const e = {
      id, tagName: (o.tag || 'DIV').toUpperCase(), type: o.type || '', parent: o.parent || null,
      style: { display: o.display == null ? '' : o.display }, dataset: {}, docTop: o.top || 0, height: o.h || 40,
      pos: o.pos || 'static', stickyTop: o.stickyTop || 0, textContent: '', innerHTML: '', isContentEditable: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      closest() { return null; },
      contains(x) { for (let n = x; n; n = n.parent) if (n === e) return true; return false; },
      visible() { for (let n = e; n; n = n.parent) if (n.style.display === 'none' || n.hiddenAttr) return false; return true; },
      getClientRects() { return e.visible() ? [{}] : []; },
      getBoundingClientRect() {
        if (!e.visible()) return { top: 0, bottom: 0, height: 0 };
        const top = e.pos === 'sticky' ? Math.max(e.stickyTop, e.docTop - win.scrollY) : e.docTop - win.scrollY;
        return { top, bottom: top + e.height, height: e.height };
      },
    };
    els[id] = e; return e;
  };
  // 머리(위 띠) — 문서 맨 위 · 64px · 화면 위에 붙음
  el('hd', { pos: 'sticky', stickyTop: 0, top: 0, h: 64 });
  el('pvBar', { pos: 'sticky', stickyTop: 0, top: 0, h: 80, display: 'none' });
  for (const v of VIEWS) el(v, { top: 64, h: 2000, display: v === 'vLoading' ? '' : 'none' });
  // 참여 후 화면 안: 남은 시간 줄(64px 아래 붙음) · 명의 탭(숨김) · 작업 내용 카드 · 예약 카드
  el('holdbar', { parent: els.vJoined, pos: 'sticky', stickyTop: 64, top: 64, h: 49 });
  el('acctTabs', { parent: els.vJoined, pos: 'sticky', stickyTop: 113, top: 113, h: 44 }).hiddenAttr = true;
  el('wdCards', { parent: els.vJoined, top: 113, h: 600 });
  el('bookingBox', { parent: els.vJoined, top: 713, h: 700, display: 'none' });
  el('bookingTitle', { parent: els.bookingBox });
  el('bookingBody', { parent: els.bookingBox });
  el('holdLabel', { parent: els.holdbar }); el('holdCd', { parent: els.holdbar });
  els.holdCd.textContent = '--:--';
  els.holdCd.closest = () => els.holdbar;
  el('joinedFootNote', { parent: els.vJoined }); el('joinedCancelBtn', { parent: els.vJoined });
  el('bkResvNo', { parent: els.bookingBox, tag: 'input', type: 'text', top: 900 });
  el('orderFrame', { parent: els.vJoined, tag: 'iframe', top: 700, h: 1200 });
  el('loginSheet', { display: 'none' }); el('liName', { parent: els.loginSheet, tag: 'input', type: 'text' });
  el('joinBtn', { parent: els.vPre, tag: 'button', type: 'button', top: 1500 });
  el('body', { tag: 'body' });
  const BARS = [els.pvBar, els.hd, els.holdbar, els.acctTabs];
  const log = { scrolls: win.scrolls, polls: 0, timeUp: 0, intervals: [] };
  const sb = {
    console, Math, Number, String, JSON, Date, Object, Array, isFinite, parseFloat,
    PREVIEW: false,
    $: (id) => els[id] || null,
    document: {
      body: els.body, documentElement: { tagName: 'HTML' }, activeElement: els.body,
      querySelectorAll: (sel) => {
        assert.strictEqual(sel, '#pvBar, .hd, .holdbar, .acct-tabs', '위쪽 띠 목록은 틀 안 계산(결정 399)과 같은 네 가지');
        return BARS;
      },
    },
    window: {
      get scrollY() { return win.scrollY; }, get pageYOffset() { return win.scrollY; },
      matchMedia: (q) => ({ matches: reduce && /prefers-reduced-motion:\s*reduce/.test(q) }),
      scrollTo(a, b) {
        if (win.throwAll) throw new Error('scroll 불가');
        if (typeof a === 'object') { if (win.throwOpts) throw new TypeError('옛 브라우저'); win.scrolls.push({ top: a.top, behavior: a.behavior }); win.scrollY = a.top; return; }
        win.scrolls.push({ top: b, behavior: 'legacy' }); win.scrollY = b;
      },
    },
    getComputedStyle: (e) => ({ position: e.pos, top: e.stickyTop + 'px' }),
    CampCards: { serverNow: () => sb.__now, _fmtHM: () => '12:00' },
    __now: Date.parse('2026-11-25T03:00:00Z'),
    getHold: () => null, _camp: null,
    setInterval: (fn, ms) => { log.intervals.push({ fn, ms }); return log.intervals.length; }, clearInterval: () => {},
    pollOnce: () => { log.polls++; }, _onHoldTimeUp: () => { log.timeUp++; },
    _qnaDateLabel: (d) => (d ? '11월 30일 (월)' : ''), _escAttr: (s) => String(s), _bkShort: () => '11/30 (월)', _qnaHm: () => '13:56',
    _holdTick: null, _bkResvB64: '', _bkReviewB64: '',
  };
  vm.createContext(sb);
  vm.runInContext([grabLet('_STAGE_TOP_BARS'), grabLet('_stageSeen'), grabLet('_stageArmed'),
    grab('show'), grab('_stageAfterShow'), grab('_stageArm'), grab('_stageScrollTop'), grab('_stageBandBottom'), grab('_stageTyping'),
    grab('renderBookingCard'), grab('startHoldCountdown'), grab('_holdCdText')].join('\n'), sb);
  const run = (code) => vm.runInContext(code, sb);
  const visible = () => VIEWS.filter(v => els[v].style.display !== 'none');
  return { sb, els, win, log, run, visible, setScroll: (y) => { win.scrollY = y; } };
}

const bookingDetail = (status) => ({ application: { status, expiresAt: '2026-11-25T03:20:00Z' },
  bookingSlot: { date: '2026-11-30', reservationNo: status === 'submitted' ? 'NB-1' : '', reviewDeadline: '2026-12-03', deadline: '2026-11-25T04:56:00Z',
    place: { placeName: '가짜식당 강남점', placeAddress: '서울 가짜구 가짜로 1', bookingUrl: 'https://booking.naver.com/x', payMode: 'refund' } } });

/* ───────────── 처음 열기 · 같은 단계 다시 그리기 = 올리지 않는다 ───────────── */
test('처음 열 때(시작 경로가 끝나기 전)는 단계가 바뀌어도 올리지 않는다 — 새로고침·재방문 자리 그대로', () => {
  const w = world();
  w.run("show('vPre'); show('vLoading'); show('vJoined');");
  assert.deepStrictEqual(w.visible(), ['vJoined']);
  assert.deepStrictEqual(w.win.scrolls, [], '시작 경로 중에는 스크롤 0');
  w.run('_stageArm()');
  w.run("show('vJoined'); show('vJoined');");
  assert.deepStrictEqual(w.win.scrolls, [], '같은 단계를 다시 그리는 것(10초 확인·옵션 변경)은 스크롤 0');
});

test('불러오는 중 화면은 단계로 치지 않는다 — 시작 뒤 vLoading 을 거쳐도 같은 단계로 돌아오면 그대로', () => {
  const w = world();
  w.run("show('vJoined'); _stageArm(); show('vLoading'); show('vJoined');");
  assert.deepStrictEqual(w.win.scrolls, []);
});

/* ───────────── 참여 · 제출 · 완료 = 새 단계 맨 위로 ───────────── */
test('[참여하기] — 참여 전 → 참여 후로 바뀌면 화면 맨 위(머리 바로 아래에 새 단계 시작)로 부드럽게', () => {
  const w = world({ scrollY: 1400 });
  w.run("show('vPre'); _stageArm();");
  w.run("show('vJoined')");
  assert.deepStrictEqual(w.win.scrolls, [{ top: 0, behavior: 'smooth' }]);
  // 머리 아래 = 새 단계 맨 위(남은 시간 줄은 단계 안에 있어 단계와 함께 맨 위에 선다)
  assert.strictEqual(w.els.vJoined.getBoundingClientRect().top, 64);
  assert.strictEqual(w.els.holdbar.getBoundingClientRect().top, 64);
});

test('예약 공고: [예약내역 제출] 뒤 같은 참여 화면 안에서 리뷰 단계로 바뀌면 예약 카드 맨 위를 위쪽 띠(머리+남은 시간) 바로 아래로', () => {
  const w = world({ scrollY: 1300 });
  w.run("show('vPre'); _stageArm();");
  w.els.bookingBox.style.display = '';
  w.run('renderBookingCard')(bookingDetail('applied'), null);
  w.run("show('vJoined')");
  assert.strictEqual(w.els.bookingBox.dataset.stage, 'resv', '실제 실행: 예약 카드가 지금 단계를 적어 둔다');
  w.setScroll(1300); w.win.scrolls.length = 0;
  w.run('renderBookingCard')(bookingDetail('submitted'), null);
  assert.strictEqual(w.els.bookingBox.dataset.stage, 'review');
  w.run("show('vJoined')");
  assert.strictEqual(w.win.scrolls.length, 1, '단계가 바뀌었으니 한 번 올린다');
  const band = 64 + 49;
  assert.strictEqual(w.win.scrolls[0].top, 713 - band, '예약 카드 맨 위 = 머리(64)+남은 시간 줄(49) 바로 아래');
  assert.strictEqual(w.els.bookingBox.getBoundingClientRect().top, band);
  w.win.scrolls.length = 0;
  w.run('renderBookingCard')(bookingDetail('submitted'), null); w.run("show('vJoined')");
  assert.deepStrictEqual(w.win.scrolls, [], '리뷰 단계를 다시 그리는 것(10초 확인)은 그대로');
});

test('명의 탭이 보이면 탭 줄까지 띠로 친다 · 숨은 띠·단계 안의 띠는 치지 않는다', () => {
  const w = world({ scrollY: 1300 });
  w.els.acctTabs.hiddenAttr = false;
  w.run("show('vJoined')");
  w.els.bookingBox.style.display = '';
  assert.strictEqual(w.run('_stageBandBottom')(w.els.bookingBox), 113 + 44);
  assert.strictEqual(w.run('_stageBandBottom')(w.els.vJoined), 64, '새 단계 자체를 올릴 때는 그 안의 띠(남은 시간·탭)는 단계와 함께 움직인다');
  w.els.acctTabs.hiddenAttr = true;
  assert.strictEqual(w.run('_stageBandBottom')(w.els.bookingBox), 113);
});

test('완료 — 리뷰 캡처 제출 · 구매양식 제출 · Q&A 캡처 제출 뒤 완료 화면(✅)으로 바뀌면 맨 위로', () => {
  for (const from of ['vJoined']) {
    const w = world({ scrollY: 2200 });
    w.run(`show('${from}'); _stageArm(); show('vDone');`);
    assert.deepStrictEqual(w.win.scrolls, [{ top: 0, behavior: 'smooth' }]);
  }
});

test('만료·다시 연결·참여 전으로 돌아가기 등 다른 단계 바뀜도 같은 도우미 하나(종류별 사본 없음)', () => {
  const w = world({ scrollY: 800 });
  w.run("show('vJoined'); _stageArm(); show('vExpired');");
  w.setScroll(500); w.run("show('vPre')");
  assert.deepStrictEqual(w.win.scrolls.map(s => s.top), [0, 0]);
});

/* ───────────── 입력 중 · 움직임 줄이기 · 실패해도 화면은 바뀐다 ───────────── */
test('리뷰어가 보이는 칸에 입력 중이면 올리지 않는다(보이는 입력칸 · 구매양식 틀)', () => {
  const w = world({ scrollY: 900 });
  w.run("show('vPre'); _stageArm();");
  w.els.loginSheet.style.display = 'flex';
  w.sb.document.activeElement = w.els.liName;   // 단계 밖(창)의 보이는 입력칸
  w.run("show('vJoined')");
  assert.deepStrictEqual(w.win.scrolls, [], '보이는 입력칸에 커서 = 입력 중');
  w.els.loginSheet.style.display = 'none';
  const w2 = world({ scrollY: 900 });
  w2.run("show('vJoined'); _stageArm();");
  w2.sb.document.activeElement = w2.els.orderFrame;
  w2.els.bookingBox.style.display = ''; w2.els.bookingBox.dataset.stage = 'review';
  w2.run("show('vJoined')");
  assert.deepStrictEqual(w2.win.scrolls, [], '구매양식 틀 안에 입력 중');
});

test('지나간 단계(이제 숨은 칸)에 남은 커서는 입력 중이 아니다 — 제출 뒤 완료 화면은 올린다', () => {
  const w = world({ scrollY: 1500 });
  w.run("show('vJoined'); _stageArm();");
  w.sb.document.activeElement = w.els.orderFrame;
  w.run("show('vDone')");
  assert.deepStrictEqual(w.win.scrolls, [{ top: 0, behavior: 'smooth' }]);
  const w2 = world({ scrollY: 1500 });
  w2.run("show('vPre'); _stageArm();");
  w2.sb.document.activeElement = w2.els.joinBtn;   // 누른 [참여하기] 단추 = 입력칸 아님
  w2.run("show('vJoined')");
  assert.strictEqual(w2.win.scrolls.length, 1);
});

test('움직임 줄이기 설정이면 한 번에(부드럽게 X)', () => {
  const w = world({ reduce: true, scrollY: 1500 });
  w.run("show('vPre'); _stageArm(); show('vJoined');");
  assert.deepStrictEqual(w.win.scrolls, [{ top: 0, behavior: 'auto' }]);
});

test('스크롤 실패가 화면 바꾸기를 막지 않는다(옛 브라우저 = 숫자 두 개로 · 그마저 실패해도 화면은 바뀐다)', () => {
  const w = world({ scrollY: 1500 });
  w.win.throwOpts = true;
  w.run("show('vPre'); _stageArm(); show('vJoined');");
  assert.deepStrictEqual(w.win.scrolls, [{ top: 0, behavior: 'legacy' }]);
  const w2 = world({ scrollY: 1500 });
  w2.win.throwAll = true;
  w2.run("show('vPre'); _stageArm(); show('vDone');");
  assert.deepStrictEqual(w2.visible(), ['vDone']);
});

/* ───────────── 남은 시간: 바로 숫자 ───────────── */
test('남은 시간은 첫 틱(0.5초)을 기다리지 않고 바로 숫자로(종전 「--:--」)', () => {
  const w = world();
  w.sb.__now = Date.parse('2026-11-25T03:00:00Z');
  w.run('startHoldCountdown')('2026-11-25T03:19:59Z');
  assert.strictEqual(w.els.holdCd.textContent, '19 : 59');
  assert.strictEqual(w.log.intervals.length, 1, '틱은 종전처럼 0.5초마다');
  assert.strictEqual(w.log.intervals[0].ms, 500);
  w.run('startHoldCountdown')('2026-11-26T05:00:00Z');
  assert.strictEqual(w.els.holdCd.textContent, '26시간 00분', '1시간 이상은 시:분 — 틱과 같은 글자');
});

test('남은 시간: 이미 끝난 시간·모르는 시간은 바로 그리지 않는다 — 만료 처리(만료 화면·확인)는 종전처럼 틱이 한다', () => {
  const w = world();
  w.run('startHoldCountdown')('2026-11-25T02:59:00Z');
  assert.strictEqual(w.els.holdCd.textContent, '--:--', '끝난 시간은 바로 덮지 않는다');
  assert.strictEqual(w.log.polls + w.log.timeUp, 0, '시작 자리에서 만료 처리를 앞당겨 부르지 않는다(화면이 아직 안 바뀐 순간)');
  w.log.intervals[0].fn();
  assert.strictEqual(w.els.holdCd.textContent, '00 : 00');
  assert.strictEqual(w.log.polls, 1); assert.strictEqual(w.log.timeUp, 1);
  const w2 = world();
  w2.run('startHoldCountdown')('');
  assert.strictEqual(w2.els.holdCd.textContent, '--:--');
});

test('틱이 그리는 글자 = 바로 그리는 글자(한 함수 _holdCdText)', () => {
  const w = world();
  w.run('startHoldCountdown')('2026-11-25T03:05:07Z');
  const first = w.els.holdCd.textContent;
  w.log.intervals[0].fn();
  assert.strictEqual(w.els.holdCd.textContent, first);
  assert.strictEqual(first, '05 : 07');
});

/* ───────────── 구조 가드 ───────────── */
test('구조: 화면 바꾸기 show() 한 곳이 도우미를 부르고(실패는 삼킨다) · 시작 경로가 끝난 뒤에만 켠다', () => {
  const show = grab('show');
  assert.ok(/_stageAfterShow\(view\)/.test(show) && /try\{/.test(show), 'show() 안에서 try 로 감싸 부른다');
  const init = grab('_campInit');
  const arm = init.lastIndexOf('_stageArm()');
  assert.ok(arm > init.indexOf('if(h) await enterJoined();'), '재방문 복원(enterJoined) 뒤에 켠다');
  assert.ok(/if\(PREVIEW\)\{ await _enterPreview\(\); _stageArm\(\); return; \}/.test(init), '미리보기 시작도 끝난 뒤 켠다');
  assert.strictEqual((SCRIPT.match(/_stageScrollTop\(/g) || []).length, 2, '스크롤 도우미는 정의 1 + 부르는 곳 1(_stageAfterShow)뿐');
  assert.ok(!/window\.scrollTo\(0, 0\)/.test(SCRIPT), '단계 바꿀 때 따로 맨 위로 올리는 사본이 없다(만료 → 다시 참여하기도 같은 도우미)');
  for (const fn of ['renderDone', 'renderDoneBatch']) assert.ok(/show\('vDone'\);\s*\}$/.test(grab(fn)), fn + ' 는 show 로 끝난다');
  assert.strictEqual((grab('_renderJoinedView').match(/show\('vJoined'\)/g) || []).length, 4, '참여 후 화면 네 갈래(영수증·예약·Q&A·구매양식) 모두 show');   // 결정 434: 영수증리뷰 갈래 추가(검사 의미 불변 — 갈래마다 show)
});

/* ───────────── 일반 구매 공고: 틀(구매양식) 안 첫 주문 칸이 부모 화면을 끌어내리지 않는다 ───────────── */
function searchAppGrab(name) {
  const i = SEARCH_APP.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '함수 없음: ' + name);
  return SEARCH_APP.slice(i, braceEnd(SEARCH_APP, SEARCH_APP.indexOf('{', SEARCH_APP.indexOf(')', i))) + 1);
}
function addCardWorld({ embed, framed }) {
  const scrolled = [];
  const timers = [];
  const mk = (id) => ({ id, hidden: true, scrollIntoView(o) { scrolled.push({ id, o }); }, appendChild() {}, firstElementChild: null });
  const wrap = mk('ofOrderCardsWrap');
  const sb = {
    MAX_ORDER_CARDS: 10, _orderCardIds: [], _cardAiState: {}, _activeIdentityContext: null, _seq: 0,
    _EMBED_CTX: embed ? { app: '1', campId: 'c1' } : null,
    window: {}, showToast() {},
    document: { getElementById: (id) => (id === 'ofOrderCardsWrap' ? wrap : (id === 'ofCardTabs' ? { hidden: true } : null)), createElement: () => ({ set innerHTML(_) {}, get firstElementChild() { return mk('card' + sb._seq); } }) },
    _newCardId: () => 'c' + (++sb._seq), _buildOrderCardHtml: () => '', _syncSharedInfoToCard() {}, _onCardAddedIncome() {},
    _renderSavedOrderInfoPickers() {}, _renderOrderInfoSuggestions() {}, _updateCardCountBadge() {}, _ofpRender() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  };
  sb.window.parent = framed ? {} : sb.window;
  sb.window.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(searchAppGrab('addOrderCard') + '\nthis.addOrderCard = addOrderCard;', sb);
  return { add: () => { sb.addOrderCard(); timers.splice(0).forEach(f => f()); }, scrolled };
}

test('일반 구매 공고: 공고 화면 틀 안 첫 주문 칸은 화면을 옮기지 않는다(틀 안 scrollIntoView 가 부모 공고 화면을 주문 칸으로 끌어내려 새 단계 맨 위를 지나쳤다)', () => {
  const w = addCardWorld({ embed: true, framed: true });
  w.add();
  assert.deepStrictEqual(w.scrolled, [], '첫 칸 — 자리는 부모(결정 416 도우미)가 정한다');
  w.add();
  assert.strictEqual(w.scrolled.length, 1, '두 번째 칸부터(리뷰어가 더한 칸)는 종전처럼 그 칸으로');
});

test('구매양식을 직접 연 화면(틀 아님)·embed 아닌 화면은 종전 그대로 첫 칸으로 스크롤', () => {
  for (const o of [{ embed: false, framed: false }, { embed: true, framed: false }, { embed: false, framed: true }]) {
    const w = addCardWorld(o);
    w.add();
    assert.strictEqual(w.scrolled.length, 1, JSON.stringify(o));
  }
});

test('구조: 위쪽 띠 목록 = 틀 안 「보이는 자리」 계산(결정 399 _OF_PARENT_TOP_BARS)과 같은 네 가지', () => {
  const inFrame = (SEARCH_APP.match(/const _OF_PARENT_TOP_BARS = "([^"]+)"/) || [])[1];
  const here = (SCRIPT.match(/const _STAGE_TOP_BARS = '([^']+)'/) || [])[1];
  assert.ok(inFrame && here, '두 목록 모두 있다');
  assert.strictEqual(here, inFrame);
});
