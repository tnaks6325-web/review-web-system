/**
 * 리뷰 내역 「참여중」 카드 상태 — 한 함수가 정하고, 할 일을 말하고, 못 누르는 카드엔 이유를 보인다 (결정 371)
 *
 *   감사(2026-11-09) 라이브 13 + 코드 L1:
 *     · 단건 카드는 고정 문구 「구매양식반영완료」, 다건 그룹 줄은 `_pendingBadgeText` — 같은 상태가 두 규칙으로 갈렸다
 *       (단건 카드는 「리뷰 1/2 제출」을 못 보여 줬다).
 *     · 「구매양식 반영중」「반영완료」「관리자 확인 중」 카드는 눌러도 아무 일이 없는데 이유가 없었다.
 *   라이브 21: 머리글 「리뷰 내역 N건」이 예전 조회는 '지금 탭 개수', 새 조회는 '전체 개수'를 말했다 → 숫자를 뺀다
 *     (탭 두 개가 이미 개수를 보여 준다). 「조회 실패」 표시는 그대로.
 *
 *   ★ 실제 index.html 의 함수(_pendingCardState · _pendingBadgeText · renderReviewSubTab)를 vm 으로 돌린다.
 *   ★ 누를 수 있는 카드 집합은 종전과 같다(isOrderPending 또는 reviewObligationStatus==='unknown' 만 못 누름).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const home = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
function fnSlice(src, head) {
  const s = src.indexOf(head);
  assert.ok(s >= 0, `${head} 를 찾지 못했습니다`);
  const e = src.indexOf('\nfunction ', s + head.length);
  return src.slice(s, e < 0 ? undefined : e);
}

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

const stateSrc = fnSlice(home, 'function _pendingCardState(item)');
const badgeSrc = fnSlice(home, 'function _pendingBadgeText(item)');
const cardSrc = fnSlice(home, 'function renderReviewSubTab()');
const whoSrc = fnSlice(home, 'function _partInfoParticipantName(it){');

function makeCtx({ pending = [], done = [], subTab = 'pending', counts = null, error = '', loading = false } = {}) {
  const made = [];
  const el = (tag) => ({
    tag, className: '', innerHTML: '', textContent: '', hidden: false, style: {}, listeners: {},
    classList: { _s: new Set(), toggle() {}, add(c) { this._s.add(c); }, remove() {}, contains(c) { return this._s.has(c); } },
    addEventListener(ev, fn) { this.listeners[ev] = fn; }, appendChild() {},
  });
  const byId = {};
  const opened = [];
  const ctx = {
    window: {},
    document: {
      getElementById(id) { return byId[id] || (byId[id] = el('#' + id)); },
      createElement(tag) { const e = el(tag); made.push(e); return e; },
      addEventListener() {},
    },
    _reviewSubTab: subTab, _reviewDoneSort: 'recent',
    _historyCounts: counts, _historyMode: counts ? 'owner_id' : 'legacy', _historyCursors: { pending: null, done: null },
    _historyMoreBusy: false,
    _reviewListData: { pending, done },
    _reviewListLoading: loading, _reviewListError: error, _reviewListTruncated: false,
    escHtml: (s) => String(s == null ? '' : s).replace(/</g, '&lt;'), _escAttrX: (s) => String(s == null ? '' : s), _fnum: (n) => String(n),
    _hasPendingCashReceipt: () => false,
    _taskLabel: (it) => it.displayNameTC || '참여 작업',
    _fmtReviewDate: () => '', _fmtReviewDateMeta: () => '', _feeForItem: () => null,
    _reEditBtnHtml: () => '', _sortDoneHistory: (l) => l, _reviewSortBarEl: () => el('sortbar'),
    openPartInfoSheet(items, opts) { opened.push({ items, opts }); }, loadReviewList() {}, getSavedUser: () => ({}),
    loadMoreReviewHistory() {},
  };
  vm.createContext(ctx);
  vm.runInContext([whoSrc, stateSrc, badgeSrc, cardSrc].join('\n'), ctx);
  ctx.__made = made; ctx.__byId = byId; ctx.__opened = opened;
  return ctx;
}
const cards = (ctx) => ctx.__made.filter(m => /result-card|result-group-card/.test(m.className));
const base = (extra = {}) => ({ displayName: '김가짜', displayNameTC: '가짜 작업', sheetId: 's', tabName: 't', rowIndex: 3, isSubmitted: false, ...extra });

console.log('\n[참여중 카드 상태 — 단일 출처]');
const S = makeCtx();
const st = (it) => JSON.parse(JSON.stringify(S._pendingCardState(it)));

t('1. 리뷰를 쓸 차례인 카드 = 「리뷰 제출 필요」 · 누를 수 있다 · 이유 줄 없음', () => {
  const s = st(base());
  assert.equal(s.text, '리뷰 제출 필요'); assert.equal(s.tappable, true); assert.equal(s.reason, '');
});
t('2. 여러 장 중 일부만 낸 카드 = 「리뷰 1/2 제출」(종전 문구 유지)', () => {
  const s = st(base({ captureSlots: [{ key: 'review' }, { key: 'receipt' }], submittedSlots: ['review'] }));
  assert.equal(s.text, '리뷰 1/2 제출'); assert.equal(s.tappable, true);
});
t('3. 구매양식이 아직 반영 중(processing·reflected) = 「반영 중」 · 못 누름 · 잠시 뒤 가능하다는 이유', () => {
  for (const stage of ['processing', 'reflected', undefined]) {
    const s = st(base({ isOrderPending: true, orderStage: stage, rowIndex: null }));
    assert.equal(s.text, '반영 중', stage); assert.equal(s.tappable, false);
    assert.match(s.reason, /잠시 뒤 리뷰를 제출할 수 있어요/);
  }
});
t('4. 담당자 확인이 필요한 카드(unknown · attention) = 「담당자 확인 중」 · 못 누름 · 할 일 없다는 이유', () => {
  for (const it of [base({ reviewObligationStatus: 'unknown' }), base({ isOrderPending: true, orderStage: 'attention' })]) {
    const s = st(it);
    assert.equal(s.text, '담당자 확인 중'); assert.equal(s.tappable, false);
    assert.match(s.reason, /따로 하실 일은 없어요/);
  }
});
t('5. _pendingBadgeText 는 같은 함수의 글자만 돌려준다(사본 없음)', () => {
  for (const it of [base(), base({ isOrderPending: true }), base({ reviewObligationStatus: 'unknown' })]) {
    assert.equal(S._pendingBadgeText(it), S._pendingCardState(it).text);
  }
});

console.log('\n[카드 그리기]');
t('6. 단건 카드도 같은 함수 글자를 쓴다 — 「리뷰 1/2 제출」이 단건에도 보인다', () => {
  const ctx = makeCtx({ pending: [base({ captureSlots: [{ key: 'a' }, { key: 'b' }], submittedSlots: ['a'] })] });
  ctx.renderReviewSubTab();
  const c = cards(ctx)[0];
  assert.match(c.innerHTML, /리뷰 1\/2 제출/);
  assert.doesNotMatch(c.innerHTML, /구매양식반영완료/);
  assert.ok(c.listeners.click, '누를 수 있는 카드는 종전처럼 눌린다');
});
t('7. 못 누르는 단건 카드 = 이유 줄이 보이고 · 눌러도 종전처럼 아무 일 없음 · 화살표 없음', () => {
  for (const it of [base({ isOrderPending: true, orderStage: 'processing', rowIndex: null }), base({ reviewObligationStatus: 'unknown' })]) {
    const ctx = makeCtx({ pending: [it] });
    ctx.renderReviewSubTab();
    const c = cards(ctx)[0];
    assert.match(c.innerHTML, /class="c-reason"/);
    assert.match(c.innerHTML, /잠시 뒤 리뷰를 제출할 수 있어요|따로 하실 일은 없어요/);
    assert.ok(!c.listeners.click, '못 누르는 카드에 새 동작을 붙이지 않는다');
    assert.doesNotMatch(c.innerHTML, /result-chevron/);
    assert.ok(c.classList.contains('is-order-pending'));
  }
});
t('8. 누를 수 있는 카드엔 이유 줄이 없다', () => {
  const ctx = makeCtx({ pending: [base()] });
  ctx.renderReviewSubTab();
  assert.doesNotMatch(cards(ctx)[0].innerHTML, /c-reason/);
});
t('9. 다건 그룹 = 줄마다 같은 함수 글자 · 못 누르는 줄이 있으면 그 이유를 아래에 한 번 · 누를 수 있는 줄만 넘긴다', () => {
  const a = base({ rowIndex: 1, recipientName: '가' });
  const b = base({ rowIndex: 2, recipientName: '나', isOrderPending: true, orderStage: 'processing' });
  const c2 = base({ rowIndex: 3, recipientName: '다', isOrderPending: true, orderStage: 'reflected' });
  const ctx = makeCtx({ pending: [a, b, c2] });
  ctx.renderReviewSubTab();
  const g = cards(ctx)[0];
  assert.match(g.className, /result-group-card/);
  assert.match(g.innerHTML, /리뷰 제출 필요/);
  assert.equal((g.innerHTML.match(/result-group-item-badge wait">반영 중</g) || []).length, 2);
  assert.equal((g.innerHTML.match(/잠시 뒤 리뷰를 제출할 수 있어요/g) || []).length, 1, '같은 이유는 한 번만');
  g.listeners.click();
  assert.equal(ctx.__opened[0].items.length, 1, '누를 수 있는 줄만 넘긴다(종전과 같다)');
});
t('10. 제출완료 탭은 그대로 「제출완료」', () => {
  const ctx = makeCtx({ subTab: 'done', done: [base({ isSubmitted: true })] });
  ctx.renderReviewSubTab();
  assert.match(cards(ctx)[0].innerHTML, /제출완료/);
  assert.doesNotMatch(cards(ctx)[0].innerHTML, /c-reason/);
});

console.log('\n[머리글 「리뷰 내역」 숫자 — 한 가지 뜻]');
t('11. 예전 조회·새 조회 모두 머리글 숫자를 보이지 않는다(탭에 개수가 있다)', () => {
  for (const counts of [null, { pending: 2, done: 7 }]) {
    const ctx = makeCtx({ pending: [base(), base({ tabName: 't2' })], counts });
    ctx.renderReviewSubTab();
    const h = ctx.__byId.reviewResultsCount;
    assert.equal(h.textContent, ''); assert.equal(h.hidden, true);
    assert.equal(String(ctx.__byId.subtabPendingCount.textContent), counts ? '2' : '2');
  }
});
t('12. 불러오는 중에도 숫자 없음 · 조회 실패는 머리글에 「조회 실패」로 보인다(결정 359 그대로)', () => {
  const l = makeCtx({ loading: true }); l.renderReviewSubTab();
  assert.equal(l.__byId.reviewResultsCount.hidden, true);
  const e = makeCtx({ error: 'timeout' }); e.renderReviewSubTab();
  assert.equal(e.__byId.reviewResultsCount.textContent, '조회 실패'); assert.equal(e.__byId.reviewResultsCount.hidden, false);
});
t('13. 화면 첫 모습에도 「0건」이 없다', () => {
  assert.match(home, /<span id="reviewResultsCount" class="results-badge" hidden><\/span>/);
});

console.log('\n[사본 금지]');
t('14. 옛 고정 문구·옛 단계 함수가 남아 있지 않다', () => {
  assert.doesNotMatch(home, /구매양식반영완료/);
  assert.doesNotMatch(home, /function _orderStageLabel|function _orderStageClass/);
  assert.equal((cardSrc.match(/isOrderPending\s*\|\|\s*item\.reviewObligationStatus/g) || []).length, 0,
    '누를 수 있는지는 _pendingCardState 하나가 정한다');
});

console.log(`\n✓ reviewListBadgeState: ${passed} passed`);
