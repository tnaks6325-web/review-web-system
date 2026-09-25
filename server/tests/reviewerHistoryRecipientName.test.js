/**
 * 리뷰어 참여내역 카드의 이름 = 그 참여의 명의(수취인)
 *
 * 배경(사용자 확정 2026-09-21): 작업보드에는 `주문자`(본계정)와 `수취인`(명의)이 따로 있는데
 * 리뷰어 홈 카드 첫 줄이 **주문자**를 그렸다. 파서(`columnResolver`)가 '주문자'를 이름열로
 * 최우선 채택하기 때문이라, 화면은 늘 본계정 이름을 말하고 실제 참여 명의는 사라졌다.
 * 같은 화면의 **다건 그룹 줄은 이미 수취인**(`_partInfoParticipantName`)을 그려, 한 화면에서
 * 두 규칙이 갈려 있었다 — 단건 카드를 그 단일 출처에 합류시킨다.
 *
 * ★★ 화면만 고치면 **제출완료 카드는 안 바뀐다**: 무시트 장부 재생성이 파서가 준
 *    `recipientName` 을 저장하지 않아 `review_index.recipient_name` 이 NULL 이고,
 *    제출완료 응답은 `row_json` 을 비우므로 폴백할 재료가 남지 않는다.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ledger = read('server/src/services/sheetlessLedger.service.js');
const indexBuilder = read('server/src/services/indexBuilder.service.js');
const resolver = read('server/src/services/columnResolver.js');
const home = read('frontend/index.html');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

/** 소스에서 `function <이름>(` 한 벌을 통째로 잘라낸다(다음 최상위 function 직전까지). */
function fnSlice(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, header + ' 를 찾지 못했습니다');
  const end = src.indexOf('\nfunction ', start + header.length);
  assert.ok(end > start, header + ' 의 끝을 찾지 못했습니다');
  return src.slice(start, end);
}

console.log('\n[A] 무시트 장부가 수취인을 저장한다');

const insertBlock = (() => {
  const i = ledger.indexOf('INSERT INTO review_index\n');
  assert.ok(i >= 0, '무시트 장부의 review_index INSERT 를 찾지 못했습니다');
  const end = ledger.indexOf('    }', i);
  return ledger.slice(i, end);
})();

t('A1. INSERT 컬럼 목록에 recipient_name 이 있다', () => {
  assert.ok(/\brecipient_name\b/.test(insertBlock),
    '무시트 탭만 수취인이 NULL 로 남아 제출완료 카드·수취인 검색·파일명 소급 매칭이 함께 죽는다');
});

t('A2. 값은 파서가 준 recipientName 을 그대로 넘긴다(판정 사본 0)', () => {
  assert.ok(/r\.recipientName\s*\|\|\s*null/.test(insertBlock),
    '여기서 수취인 칸을 다시 고르면 시트 경로와 규칙이 갈린다');
});

t('A3. 컬럼 수 ≡ 자리표시자 수 ≡ 파라미터 수', () => {
  const cols = insertBlock.slice(insertBlock.indexOf('('), insertBlock.indexOf(')'))
    .replace(/[()\s]/g, '').split(',').filter(Boolean);
  const valuesPart = insertBlock.slice(insertBlock.indexOf('VALUES'), insertBlock.indexOf('`,'));
  const placeholders = new Set((valuesPart.match(/\$\d+/g) || []));
  const nowCount = (valuesPart.match(/NOW\(\)/g) || []).length;
  const argsPart = insertBlock.slice(insertBlock.indexOf('`,') + 2);
  // 파라미터 배열의 최상위 쉼표만 센다(중첩 호출의 쉼표 제외).
  const arr = argsPart.slice(argsPart.indexOf('['), argsPart.lastIndexOf(']') + 1);
  let depth = 0, args = 1;
  for (const ch of arr.slice(1, -1)) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) args++;
  }
  assert.equal(cols.length, placeholders.size + nowCount,
    `컬럼 ${cols.length} vs 자리 ${placeholders.size}+NOW ${nowCount}`);
  assert.equal(placeholders.size, args, `자리 ${placeholders.size} vs 파라미터 ${args}`);
});

t('A4. 시트 경로도 종전대로 수취인을 저장한다(무회귀)', () => {
  assert.ok(/recipient_name\)\s*\n\s*VALUES/.test(indexBuilder) || /recipient_name/.test(indexBuilder),
    '시트 경로에서 수취인 저장이 사라지면 두 경로가 다시 갈린다');
  assert.ok(/row\.recipientName \|\| null/.test(indexBuilder));
});

t('A5. 파서가 recipientName 을 만들어 준다(전제)', () => {
  assert.ok(/recipientName:\s*recipientColIdx >= 0/.test(resolver),
    '이 전제가 깨지면 두 저장 경로가 모두 빈 값을 넣는다');
});

t('A6. 신고 표 그대로 파서를 돌리면 주문자·수취인이 갈라서 나온다', () => {
  /* 사용자가 보여준 작업보드(주문자 김〇〇 / 수취인 최〇〇) 구조를 그대로 넣어 본다.
     카드가 주문자를 그리던 이유 = 파서가 '주문자'를 이름열로 **최우선** 채택하기 때문이고,
     그것 자체는 도메인 규칙이라 건드리지 않는다 — 수취인은 옵으로 나오므로 그걸 쓴다. */
  const ib = require(path.join(root, 'server/src/services/indexBuilder.service'));
  const headers = ['번호', '구매일자', '주문번호', '주문자', '수취인', '연락처', '주소', '결제금액', '리뷰', '입금'];
  const out = ib.parseTabRows(
    [headers, ['1', '9 / 21 (월)', '16103099496819', '김연지', '최이정', '010-1234-5678', '서울', '12420', '', '']],
    's', 't', '0', '캠페인', null, null, null) || [];
  assert.equal(out.length, 1, '표 한 줄이 파싱되지 않았습니다');
  assert.equal(out[0].name, '김연지');
  assert.equal(out[0].recipientName, '최이정', '파서가 수취인을 돌려주지 않으면 저장해도 빈 값이다');
  assert.equal(out[0].rowJson['수취인'], '최이정', '참여중 카드의 즉시 폴백 재료');
});

console.log('\n[B] 카드·팝업이 그 명의를 그린다');

const whoSlice = fnSlice(home, 'function _partInfoParticipantName(it){');
const cardSlice = fnSlice(home, 'function renderReviewSubTab()');

t('B1. 판정은 단일 출처를 쓴다(수취인 판정 사본 금지)', () => {
  assert.ok(/_partInfoParticipantName\(item\)/.test(cardSlice),
    '단건 카드가 자체 판정을 두면 다건 그룹 줄과 다시 갈린다');
  assert.ok(!/item\.recipientName\s*\|\|\s*item\.orderer/.test(cardSlice),
    '카드 안에 수취인 판정 사본이 생겼다');
});

t('B2. 다건 그룹 줄은 종전대로 같은 판정을 쓴다', () => {
  assert.ok(/const participantName = _partInfoParticipantName\(item\)/.test(cardSlice));
});

/** 카드를 실제로 그려 첫 줄 이름을 읽는다. */
function renderFirstCard(item) {
  const made = [];
  const el = () => ({
    className: '', innerHTML: '', textContent: '',
    // ★ 카드가 검수 상태를 dataset 에 적는다(rck/rcs) — 실제 DOM 에는 항상 있다.
    //   여기서 빼면 이 가드가 그 자리에서 죽는다(검사 대상은 카드에 적히는 '이름'이다).
    dataset: {},
    classList: { toggle() {}, add() {} },
    addEventListener() {}, appendChild() {},
  });
  const byId = {};
  const sandbox = {
    window: {},
    document: {
      getElementById(id) { return byId[id] || (byId[id] = el()); },
      createElement() { const e = el(); made.push(e); return e; },
    },
    _reviewSubTab: item.isSubmitted ? 'done' : 'pending',
    _historyCounts: null,
    _historyMode: 'legacy',
    _historyCursors: { pending: null, done: null },
    _reviewListData: { pending: item.isSubmitted ? [] : [item], done: item.isSubmitted ? [item] : [] },
    _reviewListLoading: false,
    _reviewListError: '',
    _reviewListTruncated: false,
    escHtml: (s) => String(s == null ? '' : s),
    _escAttrX: (s) => String(s == null ? '' : s),
    _fnum: (n) => String(n),
    _orderStageClass: () => '', _orderStageLabel: () => '반영완료',
    _hasPendingCashReceipt: () => false,
    _taskLabel: (it, fb) => it.displayNameTC || (fb === undefined ? '참여 작업' : fb),
    _fmtReviewDate: () => '', _fmtReviewDateMeta: () => '',
    _feeForItem: () => null,
    _pendingBadgeText: () => '', _reEditBtnHtml: () => '',
    openPartInfoSheet() {}, loadMoreReviewHistory() {}, loadReviewList() {},
    getSavedUser: () => ({}),
  };
  vm.createContext(sandbox);
  vm.runInContext(whoSlice + '\n' + cardSlice, sandbox);
  sandbox.renderReviewSubTab();
  const card = made.find((m) => /c-who/.test(m.innerHTML));
  assert.ok(card, '카드가 그려지지 않았습니다');
  return (card.innerHTML.match(/class="c-who">([^<]*)</) || [, ''])[1];
}

const base = {
  displayName: '김연지', idxName: '김연지', displayNameTC: '쿠팡 모기위키 모기기피제',
  sheetId: 's', tabName: 't', rowIndex: 3, startDate: '9 / 21 (월)',
  isSubmitted: false, isOrderPending: false, reviewObligationStatus: 'ok',
};

t('B3. 수취인이 있으면 수취인을 그린다(참여중)', () => {
  assert.equal(renderFirstCard({ ...base, recipientName: '최이정', row: {} }), '최이정');
});

t('B4. 제출완료 카드도 수취인을 그린다(그 응답은 row 가 비어 있다)', () => {
  assert.equal(renderFirstCard({ ...base, isSubmitted: true, recipientName: '최이정', row: {} }), '최이정');
});

t('B5. 저장값이 없어도 표의 수취인 칸으로 접는다', () => {
  assert.equal(renderFirstCard({ ...base, recipientName: '', row: { 수취인: '최이정' } }), '최이정');
});

t('B6. 수취인을 어디서도 못 찾으면 종전 이름으로 접는다(빈칸 금지)', () => {
  assert.equal(renderFirstCard({ ...base, recipientName: '', row: {} }), '김연지');
});

t('B7. 팝업 부제도 카드와 같은 이름을 말한다', () => {
  const i = home.indexOf("(many ? ('총 ' + list.length + '건')");
  assert.ok(i > 0, '참여상품 팝업 부제를 찾지 못했습니다');
  const line = home.slice(i, i + 200);
  assert.ok(/_partInfoParticipantName\(it\)/.test(line),
    '카드는 수취인인데 열어 본 팝업이 다른 이름을 말하면 안 된다');
});

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
