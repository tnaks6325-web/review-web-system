const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const frontendPath = path.join(__dirname, '../../frontend/index.html');
const frontend = fs.readFileSync(frontendPath, 'utf8');
const start = frontend.indexOf('const _INTERNAL_KEY_RE');
const end = frontend.indexOf("let _mcItems = [], _mcTargetId = '';", start);
assert.ok(start >= 0 && end > start, '팝업 실행 코드를 찾을 수 없음');
const popupSource = frontend.slice(start, end);

function element() {
  const classes = new Set();
  return {
    textContent: '',
    disabled: false,
    attributes: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector() { return { focus() {} }; },
  };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

const elements = {
  overdueReviewWarning: element(),
  orwElapsed: element(),
  orwTaskName: element(),
  orwSubmittedAt: element(),
  campaignApplyButton: element(),
};
const fetchQueue = [];
const fetchCalls = [];
const opened = [];
const switched = [];
const toasts = [];
const localStorageState = new Map();
const sessionStorageState = new Map();

const target = {
  orderSubmissionId: '11111111-1111-1111-1111-111111111111',
  submittedAt: '2026-09-02T05:18:00.000Z',
  elapsedDays: 12,
  displayName: '9/10(쿠팡) 아누아 어성초 클렌징폼',
  sheetId: 'sheet-a',
  tabName: '작업표A',
  rowIndex: 7,
};
const pendingItem = { ...target, name: '테스트 리뷰어', isOrderPending: false };

const context = vm.createContext({
  console,
  Date,
  Intl,
  Math,
  Number,
  String,
  isNaN,
  API_BASE_URL: 'https://virtual.invalid',
  document: { getElementById(id) { return elements[id] || null; } },
  requestAnimationFrame(callback) { callback(); },
  fetch: async (url, options) => {
    fetchCalls.push({ url, options });
    assert.ok(fetchQueue.length, '준비되지 않은 가상 API 호출');
    return fetchQueue.shift();
  },
  getSavedUser: () => ({ reviewerToken: 'virtual-token' }),
  _refreshReviewerHomeSession: async () => ({ reviewerToken: 'refreshed-token' }),
  _reviewSubTab: 'done',
  _reviewListData: { pending: [pendingItem] },
  loadReviewList: async () => {},
  switchTab(tab) { switched.push(tab); },
  openPartInfoSheet(items, options) { opened.push({ items, options }); },
  showToast(message) { toasts.push(message); },
  localStorage: {
    setItem(key, value) { localStorageState.set(key, value); },
    getItem(key) { return localStorageState.get(key) || null; },
  },
  sessionStorage: {
    setItem(key, value) { sessionStorageState.set(key, value); },
    getItem(key) { return sessionStorageState.get(key) || null; },
  },
});
vm.runInContext(popupSource, context, { filename: frontendPath });

async function run(code) {
  return await vm.runInContext(`(async () => { ${code} })()`, context);
}

(async () => {
  // 1. 로그인 → 서버가 고른 가장 오래된 미제출 1건 → 팝업 표시 → DOM 재조회
  fetchQueue.push(response(200, { ok: true, item: target }));
  await run("await loadOverdueReviewWarning({ reviewerToken:'virtual-token' });");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.headers['X-Reviewer-Token'], 'virtual-token');
  assert.equal(elements.overdueReviewWarning.classList.contains('on'), true);
  assert.equal(elements.overdueReviewWarning.attributes['aria-hidden'], 'false');
  assert.equal(elements.orwElapsed.textContent, '리뷰 미제출 · 12일 경과');
  assert.equal(elements.orwTaskName.textContent, target.displayName);
  assert.match(elements.orwSubmittedAt.textContent, /^구매양식 제출 /);
  console.log('  ✓ 로그인 후 대상 작업·경과일·구매양식 제출시간 표시');

  // 2. X 닫기 → 팝업 상태 재조회, 캠페인 참여 버튼은 그대로 활성
  await run('closeOverdueReviewWarning();');
  assert.equal(elements.overdueReviewWarning.classList.contains('on'), false);
  assert.equal(elements.overdueReviewWarning.attributes['aria-hidden'], 'true');
  assert.equal(elements.campaignApplyButton.disabled, false);
  console.log('  ✓ X 닫기 뒤 팝업만 닫히고 캠페인 참여 상태는 변경 없음');

  // 3. CTA → 리뷰 탭 전환 → 동일 주문 UUID의 실제 작업 상세 열기
  await run('_orwPaint(_orwItem); await goToOverdueReview();');
  assert.deepEqual(switched, ['review']);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].items[0].orderSubmissionId, target.orderSubmissionId);
  assert.deepEqual(opened[0].options, { done: false });
  assert.deepEqual(toasts, []);
  console.log('  ✓ 리뷰 제출하기 버튼으로 해당 미제출 작업 상세 이동');

  // 4. 다음 로그인 상태를 재현 → 숨김 기록 없이 같은 경고를 다시 조회·표시
  await run('_orwRequested = false; _orwItem = null; closeOverdueReviewWarning();');
  fetchQueue.push(response(200, { ok: true, item: target }));
  await run("await loadOverdueReviewWarning({ reviewerToken:'virtual-token' });");
  assert.equal(elements.overdueReviewWarning.classList.contains('on'), true);
  assert.equal(fetchCalls.length, 2);
  assert.equal(localStorageState.size, 0);
  assert.equal(sessionStorageState.size, 0);
  console.log('  ✓ 다음 로그인에도 재조회·재노출, 24시간 숨김 기록 없음');

  // 5. 대상 없음 → 팝업 미표시
  await run('_orwRequested = false; _orwItem = null; closeOverdueReviewWarning();');
  fetchQueue.push(response(200, { ok: true, item: null }));
  await run("await loadOverdueReviewWarning({ reviewerToken:'virtual-token' });");
  assert.equal(elements.overdueReviewWarning.classList.contains('on'), false);
  console.log('  ✓ 10일 경과 미제출 참여건이 없으면 팝업 미표시');

  // 6. 만료 토큰 → 세션 갱신 1회 → 새 토큰으로 정상 표시
  await run('_orwRequested = false; _orwItem = null; closeOverdueReviewWarning();');
  fetchQueue.push(response(401, { ok: false }), response(200, { ok: true, item: target }));
  await run("await loadOverdueReviewWarning({ reviewerToken:'expired-token' });");
  assert.equal(fetchCalls.at(-2).options.headers['X-Reviewer-Token'], 'expired-token');
  assert.equal(fetchCalls.at(-1).options.headers['X-Reviewer-Token'], 'refreshed-token');
  assert.equal(elements.overdueReviewWarning.classList.contains('on'), true);
  console.log('  ✓ 만료 로그인 세션 갱신 후 경고 재조회');

  console.log('✅ reviewerOverdueReviewWarningSimulation — 가상 사용자 흐름 6시나리오 통과');
})().catch(err => {
  console.error('❌ ' + err.stack);
  process.exitCode = 1;
});
