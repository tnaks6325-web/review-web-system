'use strict';
/**
 * ★ 결정 400 — 공고 화면(campaign.html) 리뷰어 문구를 한 가지로 (점검 보고서 2026-11-21 M5·L7·L4)
 *
 *  M5  만료 화면과 서버 만료 안내가 같은 말을 한다(사용자 확정 2026-11-23 「가」):
 *      「이미 구매하셨다면 [다시 참여하기]로 새 구매양식을 열어 제출하세요. 자리가 없으면 운영자에게 문의해주세요.」
 *      다시 참여할 수 없는 상태(모집 종료·오늘 마감·인원 마감·잔여 대기·품절 멈춤)면 다시 참여하라고 하지 않는다
 *      — [다시 참여하기]를 숨기고 운영자 문의 한 줄만. 상태를 모르면(공고 조회 전·실패) 승인 문구 두 문장 그대로.
 *  L7  참여 취소 응답 문구가 실제 규칙과 같다 — 취소는 같은 날 다시 참여를 막지 않는다(막는 것은 제출 완료 이력뿐).
 *  L4  참여 거절 사유 문구표는 하나(_APPLY_REASON_TEXT) — 한 명의(_doApply)·여러 명의(_applyMany)가 같은 표를 쓴다.
 *
 *  화면 함수는 campaign.html 에서 그대로 꺼내 vm 에서 돌린다(문자열 존재만 보지 않는다).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CAMP = fs.readFileSync(path.join(ROOT, 'frontend', 'campaign.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'server', 'src', 'routes', 'campaign.routes.js'), 'utf8');
const SCRIPT = (CAMP.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/** 함수 하나를 통째로(앞의 async 포함) — 따옴표·주석 안의 중괄호는 세지 않는다. */
function grab(src, name) {
  let i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, '함수 없음: ' + name);
  if (src.slice(i - 6, i) === 'async ') i -= 6;
  let depth = 0, k = src.indexOf('{', src.indexOf(')', i));
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "'" || c === '"' || c === '`') { const q = c; for (k++; k < src.length && src[k] !== q; k++) if (src[k] === '\\') k++; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && src[k + 1] === '*') { k = src.indexOf('*/', k) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('중괄호 불균형: ' + name);
}
/** `const NAME = { ... };` 한 덩어리 */
function grabConst(src, name) {
  const i = src.indexOf('const ' + name + ' = {');
  assert.ok(i >= 0, '상수 없음: ' + name);
  const e = src.indexOf('\n};', i);
  assert.ok(e > i, '상수 끝 없음: ' + name);
  return src.slice(i, e + 3);
}
/** 라우트 핸들러 본문(다음 router. 앞까지) */
function routeBody(sig) {
  const i = ROUTES.indexOf(sig);
  assert.ok(i >= 0, '라우트 없음: ' + sig);
  const e = ROUTES.indexOf('\nrouter.', i + sig.length);
  return ROUTES.slice(i, e > i ? e : undefined);
}

// 사용자 승인 문구(2026-11-23 「가」) — 화면·서버가 같은 두 문장
const REJOIN = '[다시 참여하기]로 새 구매양식을 열어 제출하세요';
const NO_SEAT = '자리가 없으면 운영자에게 문의해주세요';

/* ───────────────────────── M5 · 만료 안내 ───────────────────────── */
function expiredBlock() {
  const a = CAMP.indexOf('<div id="vExpired"');
  assert.ok(a >= 0, '#vExpired 화면이 있어야 한다');
  const b = CAMP.indexOf('<!-- 제출 완료 -->', a);
  return CAMP.slice(a, b > a ? b : a + 2000);
}
function el(display) { return { style: { display: display == null ? '' : display }, textContent: '', innerHTML: '' }; }
function expiredWorld(camp, { gateMask = null } = {}) {
  const els = {};
  ['vExpired', 'vPre', 'vLoading', 'vJoined', 'expiredRejoinBtn', 'expiredLead', 'expiredBoughtText'].forEach(id => { els[id] = el(id === 'vExpired' ? '' : ''); });
  const sb = { $: (id) => els[id] || (els[id] = el('')), _camp: camp, _gateMask: gateMask, String, Array, Object };
  vm.createContext(sb);
  vm.runInContext('var _camp = this._camp, _gateMask = this._gateMask;', sb);
  vm.runInContext(grab(SCRIPT, '_expiredCanRejoin'), sb);
  vm.runInContext(grab(SCRIPT, '_renderExpiredGuide'), sb);
  return { sb, els, run: (c) => vm.runInContext(c, sb) };
}
const allText = (w) => [w.els.expiredLead.textContent, w.els.expiredBoughtText.textContent].join(' / ');

test('M5: 만료 화면 기본 문구 = 승인 문구 두 문장 · 옛 「이미 제출한 경우에만 운영자에게」 없음', () => {
  const blk = expiredBlock();
  assert.ok(!blk.includes('구매양식을 이미 제출한 경우에만'), '옛 문구(산 사람에게 문의하지 말라고 읽힘)가 남아 있으면 안 된다');
  assert.ok(blk.includes('이미 구매하셨나요?'), '「이미 구매하셨나요?」 묶음은 그대로');
  assert.ok(blk.includes(REJOIN) && blk.includes(NO_SEAT), '승인 문구 두 문장: ' + REJOIN + ' / ' + NO_SEAT);
  assert.ok(/id="expiredRejoinBtn"[^>]*>다시 참여하기</.test(blk), '[다시 참여하기] 버튼 글자와 문구가 같다');
  assert.ok(/id="expiredBoughtText"/.test(blk) && /id="expiredLead"/.test(blk), '상태에 따라 바꿀 칸에 이름이 있다');
});

test('M5: 서버 만료 안내(work-detail expired)도 같은 두 문장 · 「이미 구매하셨다면 운영자에게 문의」만 하는 옛 안내 없음', () => {
  const m = ROUTES.match(/ok: false, reason: 'expired',[\s\S]{0,400}?error: '([^']*)'/);
  assert.ok(m, 'work-detail 의 만료 응답 문구를 찾을 수 있어야 한다');
  assert.ok(m[1].includes('이미 구매하셨다면 ' + REJOIN), '서버: 이미 구매했으면 [다시 참여하기]로 새 구매양식 — ' + m[1]);
  assert.ok(m[1].includes(NO_SEAT), '서버: 자리가 없으면 운영자 문의 — ' + m[1]);
  assert.ok(!/이미 구매하셨다면 운영자에게 문의/.test(ROUTES), '산 사람을 곧장 운영자에게 보내는 옛 안내가 남아 있으면 안 된다');
});

test('M5: 다시 참여할 수 있는(열린) 공고 · 상태 모름 → 승인 문구 두 문장 + [다시 참여하기] 보임', () => {
  for (const camp of [{ state: 'open' }, { state: 'open', soldoutPaused: false, options: [{ selectable: true }] }, null, {}]) {
    const w = expiredWorld(camp);
    w.run('_renderExpiredGuide()');
    assert.ok(w.els.expiredBoughtText.textContent.includes(REJOIN) && w.els.expiredBoughtText.textContent.includes(NO_SEAT), JSON.stringify(camp) + ' → ' + allText(w));
    assert.notStrictEqual(w.els.expiredRejoinBtn.style.display, 'none', '[다시 참여하기] 보임: ' + JSON.stringify(camp));
    assert.ok(w.els.expiredLead.textContent.includes('다시 참여할 수 있어요'), '열림/모름이면 다시 참여 가능 안내 유지');
  }
});

test('M5: 다시 참여할 수 없는 상태 → 다시 참여하라고 하지 않는다(버튼 숨김 · 운영자 문의 한 줄)', () => {
  const cases = [{ state: 'closed' }, { state: 'cutoff' }, { state: 'daily_done' }, { state: 'soft_full' }, { state: 'preopen' },
    { state: 'open', soldoutPaused: true }, { state: 'open', options: [{ selectable: false }] }];
  for (const camp of cases) {
    const w = expiredWorld(camp);
    w.run('_renderExpiredGuide()');
    const t = allText(w);
    assert.strictEqual(w.els.expiredRejoinBtn.style.display, 'none', '[다시 참여하기] 숨김: ' + JSON.stringify(camp));
    assert.ok(!t.includes('[다시 참여하기]') && !/다시 참여할 수 있어요/.test(t), '다시 참여하라는 말 없음: ' + JSON.stringify(camp) + ' → ' + t);
    assert.ok(w.els.expiredBoughtText.textContent.includes('운영자에게 문의해주세요'), '운영자 문의 안내: ' + t);
  }
  // 참여 리뷰어 게이트(사유 고지형)로 막힌 화면도 다시 참여할 수 없다
  const g = expiredWorld({ state: 'open' }, { gateMask: 'policy' });
  g.run('_renderExpiredGuide()');
  assert.strictEqual(g.els.expiredRejoinBtn.style.display, 'none');
  // 다시 열리면(상태가 open 으로 돌아오면) 버튼·문구가 되돌아온다
  const w = expiredWorld({ state: 'cutoff' });
  w.run('_renderExpiredGuide()');
  w.run("_camp = { state: 'open' }; _renderExpiredGuide()");
  assert.notStrictEqual(w.els.expiredRejoinBtn.style.display, 'none');
  assert.ok(w.els.expiredBoughtText.textContent.includes(REJOIN));
});

test('M5: releaseExpiredHold — 만료 화면을 띄운 뒤 공고를 다시 불러오면 그 상태로 안내를 다시 그린다', async () => {
  const els = {};
  ['vExpired', 'vPre', 'vLoading', 'vJoined', 'expiredRejoinBtn', 'expiredLead', 'expiredBoughtText', 'orderFrame'].forEach(id => { els[id] = el(''); });
  const log = { shows: [], cleared: [] };
  const sb = {
    $: (id) => els[id] || (els[id] = el('')), String, Array, Object, Promise,
    PREVIEW: false, _formSubmitting: () => false, clearInterval() {}, setTimeout() {},
    clearHold: (p8) => log.cleared.push(p8), _allHolds: () => ({}),
    show: (v) => { log.shows.push(v); },
    toast() {}, enterJoined: async () => {}, _releaseFrame() {}, pollOnce() {},
  };
  vm.createContext(sb);
  vm.runInContext("var _camp = { state: 'open' }, _gateMask = null, _pollTimer = 0, _holdTick = 0, _detail = null, _detailRetry = 0, _slideDir = 0, _keepFrameOnce = false;", sb);
  vm.runInContext("async function loadCampaign(){ _camp = { state: 'cutoff' }; }", sb);
  ['_expiredCanRejoin', '_renderExpiredGuide', 'releaseExpiredHold'].forEach(n => vm.runInContext(grab(SCRIPT, n), sb));
  await vm.runInContext("releaseExpiredHold({ phone8: '00000000', holdToken: 't' })", sb);
  assert.deepStrictEqual(log.shows, ['vExpired']);
  assert.deepStrictEqual(log.cleared, ['00000000'], '결정 351/356 — 서버가 만료라고 한 뒤에만 오는 길 · 토큰 정리 그대로');
  assert.strictEqual(els.expiredRejoinBtn.style.display, 'none', '다시 불러온 공고가 오늘 마감이면 [다시 참여하기]를 숨긴다');
  assert.ok(els.expiredBoughtText.textContent.includes('운영자에게 문의해주세요'));
});

/* ───────────────────────── L7 · 참여 취소 ───────────────────────── */
test('L7: 취소 응답 문구 = 실제 규칙(제출하지 않았다면 오늘 다시 참여할 수 있음) · 화면 확인 창과 같은 말', () => {
  const cancel = routeBody("router.post('/:id/cancel'");
  const m = cancel.match(/res\.json\(\{ ok: true, message: '([^']*)' \}\)/);
  assert.ok(m, '취소 성공 응답 문구를 찾을 수 있어야 한다');
  assert.ok(!/다시 참여할 수 없/.test(m[1]), '취소가 같은 날 다시 참여를 막는다고 말하면 안 된다 — ' + m[1]);
  assert.ok(m[1].includes('구매양식을 제출하지 않았다면 오늘 다시 참여할 수 있어요'), '서버 — ' + m[1]);
  assert.ok(!/당일 재신청은 불가/.test(cancel), '취소 라우트 설명도 실제 규칙과 같다');
  assert.ok(/참여를 취소할까요\?\\n구매양식을 제출하지 않았다면 오늘 다시 참여할 수 있어요\./.test(SCRIPT), '화면 확인 창 문구(종전 그대로)');
});

test('L7: 실제 규칙 — 참여 신청 판정은 취소(cancelled) 이력을 보지 않는다(같은 명의 차단은 제출 완료 이력뿐)', () => {
  const i = ROUTES.indexOf('async function _applyParticipation(');
  const e = ROUTES.indexOf("router.post('/:id/apply'", i);
  assert.ok(i >= 0 && e > i, '참여 신청 판정 함수');
  const apply = ROUTES.slice(i, e);
  assert.ok(!/cancelled/.test(apply), '참여 신청 판정이 취소 이력을 읽으면 취소 문구를 다시 맞춰야 한다');
  assert.ok(/WHERE campaign_id = \$1 AND phone8 = \$2 AND status = 'submitted'/.test(apply), '같은 공고 같은 명의 이력 판정 = 제출 완료만');
  // 동시 자리 중복 막기(부분 유니크)도 살아 있는 자리(applied)만 본다(migration 113)
  const m113 = fs.readFileSync(path.join(ROOT, 'server', 'migrations', '113_campaign_expired_hold_rejoin.sql'), 'utf8');
  assert.ok(/uq_campaign_apps_active_hold[\s\S]*WHERE status = 'applied'/.test(m113));
});

/* ───────────────────────── L4 · 거절 사유 문구표 하나 ───────────────────────── */
function reasonWorld() {
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(grabConst(SCRIPT, '_APPLY_REASON_TEXT'), sb);
  vm.runInContext(grab(SCRIPT, '_applyReasonText'), sb);
  vm.runInContext('this.T = _APPLY_REASON_TEXT;', sb);
  return sb;
}

test('L4: 사유 문구표는 화면 전체에 하나 — _doApply 도 _applyReasonText(같은 표)를 쓴다', () => {
  assert.strictEqual((SCRIPT.match(/preopen:'아직 오픈 전/g) || []).length, 1, '사유 문구표 사본이 있으면 안 된다(preopen 거절 문구가 한 번만)');
  assert.strictEqual((SCRIPT.match(/hold_cap:'/g) || []).length, 2, 'hold_cap·owner_hold_cap 문구도 한 번씩만');
  assert.strictEqual((SCRIPT.match(/const _APPLY_REASON_TEXT = \{/g) || []).length, 1);
  const doApply = grab(SCRIPT, '_doApply');
  assert.ok(/const msg = _applyReasonText\(j\);/.test(doApply), '_doApply 의 안내문 = _applyReasonText(j)');
  assert.ok(!/\}\[j\.reason\]/.test(doApply), '_doApply 안에 자기 표가 없다');
  const many = grab(SCRIPT, '_applyMany');
  assert.ok(/const why = _applyReasonText\(j\);/.test(many), '_applyMany 도 같은 함수');
});

test('L4: 표 내용 — hold_cap 포함 · 서버가 보내지 않는 already_today/already_submitted 없음 · 모르는 사유는 서버 문구', () => {
  const sb = reasonWorld();
  const T = sb.T;
  assert.ok(T.hold_cap && /2개까지/.test(T.hold_cap), 'hold_cap(동시 2건) 문구');
  assert.ok(!/already_today|already_submitted/.test(CAMP), '서버가 보내지 않는 사유(재참여 기간 판정으로 바뀜 — campaignMultiAccountDefense 가드)');
  assert.ok(!/already_today|already_submitted/.test(ROUTES), '서버도 보내지 않는다');
  // 서버가 실제로 보내는 명의·한도 사유는 모두 문구가 있다
  const SENT = ['hold_cap', 'owner_hold_cap', 'duplicate_hold', 'daily_apply_cap', 'one_per_person', 'sub_daily_limit', 'sub_invalid',
    'sub_not_registered', 'sub_shares_owner_phone', 'sub_is_registered_reviewer', 'blocked_by_other_owner', 'chain_after_close',
    'popular_locked', 'campaign_paused', 'soft_full', 'rate_limited'];
  for (const r of SENT) {
    assert.ok(ROUTES.includes("reason: '" + r + "'"), '서버가 보내는 사유여야 한다(목록이 낡으면 고친다): ' + r);
    assert.ok(typeof T[r] === 'string' && T[r].length > 3, '문구 있음: ' + r);
  }
  for (const r of ['preopen', 'cutoff', 'daily_done', 'closed']) assert.ok(T[r], '공고 상태 사유(서버 st.state): ' + r);
  // 기존 가드가 요구하는 문구(뜻 그대로)
  assert.strictEqual(T.soft_full, '잔여 대기 중이에요 — 자리가 나면 열려요');
  assert.strictEqual(sb._applyReasonText({ reason: 'hold_cap' }), T.hold_cap);
  assert.strictEqual(sb._applyReasonText({ reason: 'repurchase_window', error: '이 작업은 최근 30일 안에 이미 참여한 이력이 있어요' }), '이 작업은 최근 30일 안에 이미 참여한 이력이 있어요');
  assert.strictEqual(sb._applyReasonText({}), '지금은 참여할 수 없어요');
  assert.strictEqual(sb._applyReasonText(null), '지금은 참여할 수 없어요');
  for (const [k, v] of Object.entries(T)) assert.ok(!/[A-Za-z]{3,}/.test(v), '쉬운 한국어(영어 코드 없음): ' + k + ' = ' + v);
});

test('L4: 여러 명의 명의 사유 목록·한 명의 잠금 목록에도 죽은 사유가 없다', () => {
  const many = SCRIPT.slice(SCRIPT.indexOf('const _MANY_IDENTITY_REASONS = ['), SCRIPT.indexOf('];', SCRIPT.indexOf('const _MANY_IDENTITY_REASONS = [')));
  assert.ok(many.length > 30 && /'hold_cap'|'owner_hold_cap'/.test(many));
  assert.ok(!/already_/.test(many));
});

/* ───────────────────────── 공통 · 문법 ───────────────────────── */
test('campaign.html 의 모든 인라인 스크립트가 문법 오류 없이 읽힌다', () => {
  const blocks = [...CAMP.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(blocks.length >= 1);
  blocks.forEach((b, i) => { assert.doesNotThrow(() => new vm.Script(b, { filename: 'campaign.html#script' + i })); });
});
