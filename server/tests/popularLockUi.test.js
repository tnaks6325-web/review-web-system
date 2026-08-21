/**
 * 인기상품 참여권 — 리뷰어 화면 잠금 표시 회귀가드
 *
 * 배경(2026-08-20 신고 재현): 서버 apply 게이트는 "일반 공고 구매양식 제출완료(submitted)"만
 * 크레딧으로 인정해 신청 직후 취소로는 뚫리지 않는다(실측 확인). 그런데 화면이 잠금 상태를
 * 전혀 조회하지 않아 [참여하기]가 항상 활성 → 리뷰어에겐 "참여 가능"으로 보였다.
 *
 * 2026-08-21 본섭 재현으로 드러난 것: 인기 공고 다수가 **타계정 참여 허용**이라
 * "타계정 공고는 잠그지 않는다"는 초기 규칙 때문에 잠금이 거의 보이지 않았다 →
 * **등록된 전 명의를 각각 조회해 모두 0일 때만 잠근다**(사용자 확정).
 *
 * 이 가드가 고정하는 규율:
 *   ① 모르면 잠그지 않는다(fail-open) — 조회 실패·비로그인·미리보기·구버전 백엔드
 *   ② 참여권은 명의별 — 어느 한 명의라도 참여권이 있으면 잠그지 않는다
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
  // ★ 줄 주석을 지우고 본다 — 호출을 주석 처리한 변이를 "있다"로 읽으면 안 된다(변이시험 실측).
  const pre = campaign.slice(campaign.indexOf('function renderPre(){'), campaign.indexOf("  show('vPre');"))
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const iNotice = pre.indexOf('renderPopNotice();');
  const iLock = pre.indexOf('_applyPopLock();');
  const iLoad = pre.indexOf('loadPopCredit();');
  assert(iNotice > -1 && iLock > iNotice && iLoad > iLock,
    'renderPre 는 안내 → 잠금 → 조회 순으로 배선돼야 한다');
}
{
  // apply 403 수치 반영 — 타계정으로 시도했으면 **그 명의 칸**을 갱신해야 한다(본계정 값을 덮지 않는다)
  const i = campaign.indexOf("if(j.reason === 'popular_locked')");
  assert(i > 0, 'apply 403 popular_locked 분기가 있어야 한다');
  const blk = campaign.slice(i, i + 900).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert(blk.includes('_popSubCredits[_subP8]'), '타계정 시도의 수치는 그 명의 칸에 기록해야 한다');
  // ★ 본계정 갱신은 **else 분기 안 한 번뿐** — 밖에서 한 번 더 부르면 타계정 수치가
  //   본계정을 덮어 화면이 남의 명의 수치를 본계정으로 말한다(변이시험이 통과시켰던 구멍).
  assert.equal((blk.match(/_setPopCredit\(j\)/g) || []).length, 1,
    '본계정 수치 갱신은 else 분기 한 곳뿐이어야 한다');
  assert(/\}else\{\s*_setPopCredit\(j\);\s*\}/.test(blk),
    '본계정 시도(else 분기)에서만 본계정 수치를 갱신해야 한다');
  assert(blk.includes('_applyPopLock()'), '수치 갱신 뒤 잠금을 다시 적용해야 한다');
}
assert(campaign.includes('const info = gateInfo || _popCredit;'),
  '게이트 모달 수치 출처는 한 곳(gateInfo → 조회해 둔 상태)');
{
  // 게이트 모달도 명의별 참여권을 말한다 — 안내 카드와 **같은 함수**를 쓴다(문장이 갈리면 안 된다)
  const gate = campaign.slice(campaign.indexOf('async function openPopGate('), campaign.indexOf('function goPopNormal('));
  assert(gate.includes('_popSubsWithCredit()'), '게이트 모달의 명의 표기는 안내 카드와 같은 출처를 쓴다');
  assert(/multiEnabled\(\) && _popSubCredits/.test(gate), '타계정 허용 공고 + 조회 완료일 때만 말한다(모르면 침묵)');
  assert(gate.includes('_popEsc('), '명의 이름은 사용자 입력 — escape 한다');
  assert(campaign.includes('id="popGateSubs"'), '표기 자리(마크업)가 있어야 한다');
}

// ── 함수 블록을 실제로 실행 ──
const start = campaign.indexOf('let _popCredit = null;');
const end = campaign.indexOf('function renderPopNotice(){');
assert(start > 0 && end > start, '참여권 블록을 찾지 못했다(구조가 바뀌면 가드를 함께 갱신할 것)');
const block = campaign.slice(start, end);

function ctx({ camp, preview = false, btn = { disabled: false, textContent: '참여하기' }, subs = [], api = {} }) {
  const calls = [];
  const sandbox = {
    _camp: camp, PREVIEW: preview,
    API_BASE_URL: 'http://x',
    getSession: () => ({ phone8: '99998888', name: '나' }),
    multiEnabled: () => !!(camp && camp.multi_account_mode === true),
    loadSubs: async () => subs,
    _p8: (v) => String(v || '').replace(/\D/g, '').slice(-8),
    $: (id) => (id === 'joinBtn' ? btn : { style: { display: 'none' } }),
    renderPopNotice: () => {},
    fetch: async (url) => {
      const p8 = decodeURIComponent(String(url).split('phone8=')[1] || '');
      calls.push(p8);
      const v = api[p8];
      if (v === 'fail') return { ok: false, json: async () => ({ ok: false }) };
      return { ok: true, json: async () => Object.assign({ ok: true }, v || { normalDone: 0, popularUsed: 0 }) };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  return { sandbox, btn, calls };
}
function run(opts) {
  const c = ctx(opts);
  if (opts.credit) vm.runInContext(`_setPopCredit(${JSON.stringify(opts.credit)})`, c.sandbox);
  if (opts.subCredits) vm.runInContext(`_popSubCredits = ${JSON.stringify(opts.subCredits)}`, c.sandbox);
  if (opts.unknown) vm.runInContext('_popUnknown = true', c.sandbox);
  vm.runInContext('_applyPopLock()', c.sandbox);
  return { btn: c.btn, locked: vm.runInContext('_popLockable()', c.sandbox), state: vm.runInContext('_popCredit', c.sandbox) };
}
async function load(opts) {
  const c = ctx(opts);
  await vm.runInContext('loadPopCredit()', c.sandbox);
  vm.runInContext('_applyPopLock()', c.sandbox);
  return {
    btn: c.btn, calls: c.calls,
    locked: vm.runInContext('_popLockable()', c.sandbox),
    own: vm.runInContext('_popCredit', c.sandbox),
    subs: vm.runInContext('_popSubCredits', c.sandbox),
    unknown: vm.runInContext('_popUnknown', c.sandbox),
  };
}

const POP = { is_popular: true };
const POP_MULTI = { is_popular: true, multi_account_mode: true };

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
// ④ 타계정 허용 공고 — 조회 전(명의 상태 모름)이면 잠그지 않는다
{
  const r = run({ camp: POP_MULTI, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, false, '타계정 명의를 조회하기 전에는 잠그지 않는다');
}
// ⑤ 타계정 허용 공고 — 전 명의 0건이면 잠근다(본섭 신고 케이스)
{
  const r = run({ camp: POP_MULTI, credit: { normalDone: 0, popularUsed: 0 },
                  subCredits: { '11112222': { name: 'S', normalDone: 1, popularUsed: 1, credits: 0 } } });
  assert.equal(r.locked, true, '참여할 수 있는 명의가 하나도 없으면 잠근다');
  assert.equal(r.btn.disabled, true);
}
// ⑥ 타계정 허용 공고 — 한 명의라도 참여권이 있으면 잠그지 않는다
{
  const r = run({ camp: POP_MULTI, credit: { normalDone: 0, popularUsed: 0 },
                  subCredits: { '11112222': { name: 'S', normalDone: 1, popularUsed: 0, credits: 1 } } });
  assert.equal(r.locked, false, '그 명의로는 정당하게 참여할 수 있다 — 잠그면 안 된다');
  assert.equal(r.btn.disabled, false);
}
// ⑦ 한 명의라도 조회 실패면 잠그지 않는다(fail-open)
{
  const r = run({ camp: POP_MULTI, credit: { normalDone: 0, popularUsed: 0 },
                  subCredits: {}, unknown: true });
  assert.equal(r.locked, false);
}
// ⑧ 관리자 미리보기 → 잠그지 않는다(진행 화면 확인이 목적)
{
  const r = run({ camp: POP, preview: true, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, false);
}
// ⑨ 인기 공고가 아니면 무동작(무회귀)
{
  const r = run({ camp: { is_popular: false }, credit: { normalDone: 0, popularUsed: 0 } });
  assert.equal(r.locked, false);
  assert.equal(r.btn.disabled, false);
}
// ⑩ 다른 사유로 이미 잠긴 버튼의 문구는 덮지 않는다
{
  const r = run({ camp: POP, credit: { normalDone: 0, popularUsed: 0 },
                  btn: { disabled: true, textContent: '오늘 참여 마감' } });
  assert.equal(r.btn.textContent, '오늘 참여 마감', '마감·옵션 마감 사유가 우선한다');
}
// ⑪ 크레딧 계산은 음수로 내려가지 않는다
{
  const r = run({ camp: POP, credit: { normalDone: 1, popularUsed: 3 } });
  assert.equal(r.state.credits, 0);
  assert.equal(r.locked, true);
}

// ⑪-2 안내 문구는 "없다"와 "모른다"를 구분한다(조회 실패·타계정 0개를 "없어요"로 단정하지 않는다)
{
  const notice = campaign.slice(campaign.indexOf('function renderPopNotice(){'),
                                campaign.indexOf('async function openPopGate('));
  assert(/if\(_popUnknown\)\{[\s\S]{0,200}확인하지 못했어요/.test(notice),
    '한 명의라도 모르면 "참여권이 없다"고 단정하지 않는다');
  assert(/\}else if\(_n\)\{[\s\S]{0,200}명의도 참여권이 없어요/.test(notice),
    '등록한 타계정이 있을 때만 "타계정 명의도 없다"를 말한다(0개면 그 문장이 성립하지 않는다)');
}

(async () => {
  // ⑫ 타계정 허용 공고: 명의별로 각각 조회한다(본계정 + 타계정 전부, 명의당 1회)
  {
    const r = await load({
      camp: POP_MULTI,
      subs: [{ name: 'S1', phone: '010-1111-2222' }, { name: 'S2', phone: '010-3333-4444' }],
      api: { '99998888': { normalDone: 0, popularUsed: 0 },
             '11112222': { normalDone: 0, popularUsed: 0 },
             '33334444': { normalDone: 0, popularUsed: 0 } },
    });
    assert.deepEqual(r.calls.sort(), ['11112222', '33334444', '99998888'], '본계정 + 타계정 전 명의를 조회해야 한다');
    assert.equal(r.locked, true, '전 명의 0건 → 잠금');
    assert.equal(r.btn.disabled, true);
  }
  // ⑬ 타계정 한 명의가 참여권 보유 → 잠그지 않고, 그 명의를 안내에 쓸 수 있게 보관한다
  {
    const r = await load({
      camp: POP_MULTI,
      subs: [{ name: 'S1', phone: '010-1111-2222' }],
      api: { '99998888': { normalDone: 0, popularUsed: 0 }, '11112222': { normalDone: 2, popularUsed: 1 } },
    });
    assert.equal(r.locked, false);
    assert.equal(r.subs['11112222'].credits, 1);
    assert.equal(r.subs['11112222'].name, 'S1', '안내 문구용 이름을 함께 보관한다');
  }
  // ⑭ 타계정 한 명의의 조회가 실패하면 잠그지 않는다(모르면 잠그지 않는다)
  {
    const r = await load({
      camp: POP_MULTI,
      subs: [{ name: 'S1', phone: '010-1111-2222' }],
      api: { '99998888': { normalDone: 0, popularUsed: 0 }, '11112222': 'fail' },
    });
    assert.equal(r.unknown, true);
    assert.equal(r.locked, false);
    assert.equal(r.btn.disabled, false);
  }
  // ⑮ 본계정 조회 실패 → 타계정을 조회하지 않고 잠그지 않는다
  {
    const r = await load({ camp: POP_MULTI, subs: [{ name: 'S1', phone: '010-1111-2222' }],
                           api: { '99998888': 'fail' } });
    assert.deepEqual(r.calls, ['99998888']);
    assert.equal(r.locked, false);
  }
  // ⑯ 타계정 참여가 열리지 않은 공고는 타계정을 조회하지 않는다(요청 순증 0)
  {
    const r = await load({ camp: POP, subs: [{ name: 'S1', phone: '010-1111-2222' }],
                           api: { '99998888': { normalDone: 0, popularUsed: 0 } } });
    assert.deepEqual(r.calls, ['99998888']);
    assert.equal(r.locked, true);
  }
  // ⑰ 소유자와 같은 번호·중복 타계정은 한 번만 조회한다
  {
    const r = await load({
      camp: POP_MULTI,
      subs: [{ name: '나', phone: '010-9999-8888' }, { name: 'S1', phone: '010-1111-2222' }, { name: 'S1b', phone: '01011112222' }],
      api: { '99998888': { normalDone: 0, popularUsed: 0 }, '11112222': { normalDone: 0, popularUsed: 0 } },
    });
    assert.deepEqual(r.calls.sort(), ['11112222', '99998888']);
  }
  // ⑱ 비로그인·미리보기는 조회 자체를 하지 않는다
  {
    const c = ctx({ camp: POP_MULTI });
    vm.runInContext('getSession = () => null', c.sandbox);
    await vm.runInContext('loadPopCredit()', c.sandbox);
    assert.deepEqual(c.calls, [], '비로그인은 조회하지 않는다');
    const c2 = ctx({ camp: POP_MULTI, preview: true });
    await vm.runInContext('loadPopCredit()', c2.sandbox);
    assert.deepEqual(c2.calls, [], '미리보기는 조회하지 않는다');
  }
  // ⑲ 명의 선택 시트: 참여권 0인 명의는 고를 수 없고, 남은 명의는 건수를 말한다
  {
    const c = ctx({ camp: POP_MULTI });
    // 시트 렌더 블록은 별도 위치라 필요한 함수만 꺼내 같은 sandbox 에서 실행한다
    const rowsSrc = campaign.slice(campaign.indexOf('function _acctRows(){'), campaign.indexOf('function renderAcctList(){'));
    Object.assign(c.sandbox, {
      _allHolds: () => ({}), _acctBlocked: {}, _subs: [{ name: 'S1', phone: '010-1111-2222' }, { name: 'S2', phone: '010-3333-4444' }],
      _escAttr: (v) => String(v == null ? '' : v),
    });
    vm.runInContext(rowsSrc, c.sandbox);
    vm.runInContext("_popCredit = { normalDone:0, popularUsed:0, credits:0 }", c.sandbox);
    vm.runInContext("_popSubCredits = { '11112222': { name:'S1', normalDone:2, popularUsed:1, credits:1 }, '33334444': { name:'S2', normalDone:0, popularUsed:0, credits:0 } }", c.sandbox);
    const rows = vm.runInContext('_acctRows()', c.sandbox);
    const byName = Object.fromEntries(rows.map(r => [r.name, r]));
    assert.equal(byName['나'].state, 'nocredit', '참여권 0인 본계정은 고를 수 없어야 한다');
    assert.equal(byName['S1'].state, 'ok', '참여권이 있는 명의는 그대로 고를 수 있다');
    assert.equal(byName['S1'].credits, 1);
    assert.equal(byName['S2'].state, 'nocredit');
    const txt = (r) => vm.runInContext('_acctStateText(' + JSON.stringify(r) + ')', c.sandbox);
    assert(txt(byName['S1']).includes('참여권 1건'), '남은 참여권 건수를 말해야 한다');
    assert(txt(byName['S2']).includes('참여권 없음'), '참여권 0은 사유를 말해야 한다');
  }
  // ⑳ 모르면(인기 공고 아님·조회 전) 시트를 손대지 않는다 — 종전 동작
  {
    for (const camp of [{ is_popular: false, multi_account_mode: true }, POP_MULTI]) {
      const c = ctx({ camp });
      const rowsSrc = campaign.slice(campaign.indexOf('function _acctRows(){'), campaign.indexOf('function renderAcctList(){'));
      Object.assign(c.sandbox, { _allHolds: () => ({}), _acctBlocked: {}, _subs: [{ name: 'S1', phone: '010-1111-2222' }] });
      vm.runInContext(rowsSrc, c.sandbox);
      // ★ 인기 공고가 아닌데 참여권 값이 남아 있어도 명의를 잠그면 안 된다(변이시험이 통과시켰던 구멍)
      if (camp.is_popular === false) {
        vm.runInContext("_popCredit = { normalDone:0, popularUsed:0, credits:0 }", c.sandbox);
        vm.runInContext("_popSubCredits = { '11112222': { name:'S1', credits:0 } }", c.sandbox);
      }
      const rows = vm.runInContext('_acctRows()', c.sandbox);   // 참여권 조회 전(또는 비인기 공고)
      assert(rows.every(r => r.state === 'ok'), '모르면·인기 공고가 아니면 명의를 잠그지 않는다');
    }
  }
  console.log('popularLockUi: passed');
})();
