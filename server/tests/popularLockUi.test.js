/**
 * 인기상품 참여권 — 리뷰어 화면 잠금 표시 회귀가드
 *
 * 배경(2026-08-20 신고 재현): 서버 apply 게이트는 "일반 공고 구매양식 제출완료(submitted)"만
 * 크레딧으로 인정해 신청 직후 취소로는 뚫리지 않는다(실측 확인). 그런데 화면이 잠금 상태를
 * 전혀 조회하지 않아 [참여하기]가 항상 활성 → 리뷰어에겐 "참여 가능"으로 보였다.
 *
 * 이 가드가 고정하는 규율:
 *   ① 모르면 잠그지 않는다(fail-open) — 조회 실패·비로그인·미리보기·구버전 백엔드
 *   ② 타계정 참여가 열린 공고는 잠그지 않는다(크레딧은 명의별 — 소유자 0이어도 타계정은 가능)
 *   ③ 다른 사유(마감·옵션 마감)로 이미 잠긴 버튼의 문구를 덮지 않는다
 *   ④ 수치는 서버가 준 값만 — 0건으로 꾸미지 않는다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const campaign = fs.readFileSync(path.join(root, 'frontend', 'campaign.html'), 'utf8');

// ── 배선 ──
assert(campaign.includes("'/api/campaign/popular-status?phone8='"),
  '리뷰어 화면이 참여권 상태를 조회해야 한다(누르기 전 고지)');
{
  const pre = campaign.slice(campaign.indexOf('function renderPre(){'), campaign.indexOf("  show('vPre');"));
  const iNotice = pre.indexOf('renderPopNotice();');
  const iLock = pre.indexOf('_applyPopLock();');
  const iLoad = pre.indexOf('loadPopCredit();');
  assert(iNotice > -1 && iLock > iNotice && iLoad > iLock,
    'renderPre 는 안내 → 잠금 → 조회 순으로 배선돼야 한다');
}
assert(/if\(j\.reason === 'popular_locked'\)\{[\s\S]{0,300}_setPopCredit\(j\)/.test(campaign),
  'apply 403 응답의 최신 수치로 화면을 맞춰야 한다(다음 클릭부터 누르기 전에 잠겨 보인다)');
assert(campaign.includes('const info = gateInfo || _popCredit;'),
  '게이트 모달 수치 출처는 한 곳(gateInfo → 조회해 둔 상태)');

// ── 함수 블록을 실제로 실행 ──
const start = campaign.indexOf('let _popCredit = null;');
const end = campaign.indexOf('function renderPopNotice(){');
assert(start > 0 && end > start, '참여권 블록을 찾지 못했다(구조가 바뀌면 가드를 함께 갱신할 것)');
const block = campaign.slice(start, end);

function run({ camp, preview = false, credit = null, btn = { disabled: false, textContent: '참여하기' } }) {
  const sandbox = {
    _camp: camp, PREVIEW: preview,
    API_BASE_URL: 'http://x', getSession: () => ({ phone8: '99998888' }),
    $: (id) => (id === 'joinBtn' ? btn : { style: { display: 'none' } }),
    renderPopNotice: () => {}, fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  if (credit) vm.runInContext(`_setPopCredit(${JSON.stringify(credit)})`, sandbox);
  vm.runInContext('_applyPopLock()', sandbox);
  // ★ `let` 선언은 vm sandbox 객체에 붙지 않는다 — 컨텍스트 안에서 읽는다
  return { btn, locked: vm.runInContext('_popLockable()', sandbox), state: vm.runInContext('_popCredit', sandbox) };
}

const POP = { is_popular: true };

// ① 크레딧 0 → 잠금 + 사유 문구
{
  const r = run({ camp: POP, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, true);
  assert.equal(r.btn.disabled, true, '참여권 0건이면 [참여하기]를 비활성화한다');
  assert(r.btn.textContent.includes('일반 모집 제출완료'), '잠금 사유를 버튼이 말해야 한다');
}
// ② 크레딧 1 이상 → 잠그지 않는다
{
  const r = run({ camp: POP, credit: { normalDone: 1, popularUsed: 0 } });
  assert.equal(r.locked, false);
  assert.equal(r.btn.disabled, false, '참여권이 있으면 종전대로 참여할 수 있어야 한다');
  assert.equal(r.state.credits, 1);
}
// ③ 모름(조회 실패·구버전 백엔드) → 잠그지 않는다(fail-open)
{
  const r = run({ camp: POP, credit: null });
  assert.equal(r.locked, false, '모르면 잠그지 않는다 — 우리 오류로 정당한 참여를 막지 않는다');
  assert.equal(r.btn.disabled, false);
}
// ④ 타계정 참여가 열린 공고 → 잠그지 않는다(크레딧은 명의별)
{
  const r = run({ camp: { is_popular: true, multi_account_mode: true }, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, false, '타계정 명의로는 참여할 수 있으므로 소유자 크레딧으로 잠그지 않는다');
  assert.equal(r.btn.disabled, false);
}
// ⑤ 관리자 미리보기 → 잠그지 않는다(진행 화면 확인이 목적)
{
  const r = run({ camp: POP, preview: true, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, false);
}
// ⑥ 인기 공고가 아니면 무동작(무회귀)
{
  const r = run({ camp: { is_popular: false }, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, false);
  assert.equal(r.btn.disabled, false);
}
// ⑦ 다른 사유로 이미 잠긴 버튼의 문구는 덮지 않는다
{
  const r = run({ camp: POP, credit: { normalDone: 0, popularUsed: 0 },
                  btn: { disabled: true, textContent: '오늘 참여 마감' } });
  assert.equal(r.btn.textContent, '오늘 참여 마감', '마감·옵션 마감 사유가 우선한다');
}
// ⑧ 크레딧 계산은 음수로 내려가지 않는다
{
  const r = run({ camp: POP, credit: { normalDone: 1, popularUsed: 3 } });
  assert.equal(r.state.credits, 0);
  assert.equal(r.locked, true);
}

console.log('popularLockUi: passed');
