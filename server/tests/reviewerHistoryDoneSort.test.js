/**
 * 리뷰 내역 「제출완료」 정렬 — 최근 제출순(기본) / 오래된 제출순 (사용자 요청 2026-11-05).
 * 기준 = 카드의 「제출 MM.DD」와 같은 값(reviewFileAt). 제출일 없는 건은 두 순서 모두 맨 뒤.
 * 실제 renderReviewSubTab 을 vm 으로 돌려 카드가 그려지는 순서를 본다.
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
function blockSlice(src, from, to) {
  const s = src.indexOf(from), e = src.indexOf(to, s);
  assert.ok(s >= 0 && e > s, `${from} 구간을 찾지 못했습니다`);
  return src.slice(s, e);
}
const sortBlock = blockSlice(home, '/** 제출완료 정렬', '/** 대기 건 배지 텍스트');
const cardSlice = fnSlice(home, 'function renderReviewSubTab()');
const whoSlice = fnSlice(home, 'function _partInfoParticipantName(it){');

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }

function makeCtx({ subTab = 'done', done = [], pending = [], sort = 'recent', counts = null, mode = 'legacy', cursors = null } = {}) {
  const made = [];
  const el = () => ({
    className: '', innerHTML: '', textContent: '', style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {},
  });
  const byId = {};
  const ctx = {
    window: {},
    document: {
      getElementById(id) { return byId[id] || (byId[id] = el()); },
      createElement() { const e = el(); made.push(e); return e; },
      addEventListener() {},
    },
    _reviewSubTab: subTab, _reviewDoneSort: sort,
    _historyCounts: counts, _historyMode: mode, _historyCursors: cursors || { pending: null, done: null },
    _historyMoreBusy: false,
    _reviewListData: { pending, done },
    _reviewListLoading: false, _reviewListError: '', _reviewListTruncated: false,
    escHtml: (s) => String(s == null ? '' : s), _escAttrX: (s) => String(s == null ? '' : s), _fnum: (n) => String(n),
    _orderStageClass: () => '', _orderStageLabel: () => '반영완료', _hasPendingCashReceipt: () => false,
    _taskLabel: (it) => it.displayNameTC || '참여 작업',
    _fmtReviewDate: () => '', _fmtReviewDateMeta: () => '', _feeForItem: () => null,
    _pendingBadgeText: () => '', _reEditBtnHtml: () => '',
    openPartInfoSheet() {}, loadReviewList() {}, getSavedUser: () => ({}),
    loadMoreReviewHistory() {},
  };
  vm.createContext(ctx);
  vm.runInContext(whoSlice + '\n' + sortBlock + '\n' + cardSlice, ctx);
  ctx.__made = made;
  return ctx;
}
const order = (ctx) => ctx.__made.map(m => (m.innerHTML.match(/class="c-who">([^<]*)</) || [])[1]).filter(Boolean);
const item = (who, at, extra = {}) => ({ isSubmitted: true, displayName: '상품 ' + who, sheetId: 's', tabName: 'tab-' + who, orderer: who, reviewFileAt: at, ...extra });

const rows = [
  item('B', '2026-09-11T03:00:00Z'),
  item('없음1', null),
  item('A', '2026-09-15T03:00:00Z'),
  item('C', '2026-08-30T03:00:00Z'),
  item('없음2', ''),
];

(async () => {
  console.log('\n[리뷰 내역 제출완료 정렬]');

  await t('1. 기본(최근 제출순) — 최근 → 오래된, 제출일 없는 건은 받은 순서로 맨 뒤', () => {
    const ctx = makeCtx({ done: rows });
    ctx.renderReviewSubTab();
    assert.deepStrictEqual(order(ctx), ['A', 'B', 'C', '없음1', '없음2']);
  });

  await t('2. 오래된 제출순 — 오래된 → 최근, 제출일 없는 건은 여전히 맨 뒤', () => {
    const ctx = makeCtx({ done: rows, sort: 'old' });
    ctx.renderReviewSubTab();
    assert.deepStrictEqual(order(ctx), ['C', 'B', 'A', '없음1', '없음2']);
  });

  await t('3. 원본 목록은 바꾸지 않는다(다른 화면이 같은 배열을 본다)', () => {
    const copy = rows.slice();
    const ctx = makeCtx({ done: copy, sort: 'old' });
    ctx.renderReviewSubTab();
    assert.deepStrictEqual(copy.map(r => r.orderer), rows.map(r => r.orderer));
  });

  await t('4. 같은 시각이면 받은 순서를 지킨다', () => {
    const same = [item('X', '2026-09-01T00:00:00Z'), item('Y', '2026-09-01T00:00:00Z'), item('Z', '2026-09-01T00:00:00Z')];
    for (const sort of ['recent', 'old']) {
      const ctx = makeCtx({ done: same, sort });
      ctx.renderReviewSubTab();
      assert.deepStrictEqual(order(ctx), ['X', 'Y', 'Z']);
    }
  });

  await t('5. 정렬 줄 — 제출완료 탭에서만, 「제출완료 내역 N건」과 고른 정렬이 보인다', () => {
    const ctx = makeCtx({ done: rows, sort: 'old', counts: { pending: 3, done: 151 } });
    ctx.renderReviewSubTab();
    const bar = ctx.__made.find(m => m.className === 'review-sortbar');
    assert.ok(bar, '정렬 줄이 그려지지 않았습니다');
    assert.ok(/제출완료 내역 151건/.test(bar.innerHTML));
    assert.ok(/<\/i>오래된 제출순<i class="fas fa-chevron-down/.test(bar.innerHTML), '버튼에 고른 정렬이 보여야 한다');
    assert.ok(/class="rs-opt on"[^>]*onclick="setReviewDoneSort\('old'\)"/.test(bar.innerHTML), '고른 항목에 체크');
    assert.strictEqual(ctx.__made.indexOf(bar), 0, '정렬 줄은 목록 맨 위');

    const pend = makeCtx({ subTab: 'pending', pending: [{ ...item('P', null), isSubmitted: false }] });
    pend.renderReviewSubTab();
    assert.ok(!pend.__made.some(m => m.className === 'review-sortbar'), '참여중 탭에는 정렬 줄이 없다');

    const empty = makeCtx({ done: [] });
    empty.renderReviewSubTab();
    assert.ok(!empty.__made.some(m => m.className === 'review-sortbar'), '빈 목록에는 정렬 줄이 없다');
  });

  await t('6. 나눠 받는 조회에서 「오래된 제출순」을 고르면 남은 제출완료를 끝까지 받는다', async () => {
    let calls = 0;
    const ctx = makeCtx({ done: rows, mode: 'owner_id', cursors: { pending: null, done: 'c1' } });
    ctx.loadMoreReviewHistory = async () => { calls++; ctx._historyCursors.done = calls < 3 ? 'c' + (calls + 1) : null; };
    await ctx.setReviewDoneSort('old');
    assert.strictEqual(calls, 3);
    assert.strictEqual(ctx._reviewDoneSort, 'old');

    let calls2 = 0;
    const ctx2 = makeCtx({ done: rows, mode: 'owner_id', cursors: { pending: null, done: 'c1' } });
    ctx2.loadMoreReviewHistory = async () => { calls2++; };
    await ctx2.setReviewDoneSort('recent');
    assert.strictEqual(calls2, 0, '최근 제출순은 추가로 받지 않는다');
  });

  await t('7. 기본값은 최근 제출순', () => {
    assert.ok(/let _reviewDoneSort = 'recent';/.test(home));
  });

  console.log(`\nPASS review history done sort: ${passed}`);
})().catch(e => { console.error(e); process.exitCode = 1; });
