'use strict';
/*
 * 결정 358 후속(W4) — 리뷰 제출 화면·구매양식(frontend/js/search-app.js)의 타계정 「통째 저장」 4곳도
 * 이 화면이 서버에서 실제로 받은 목록(baseSubAccounts)을 함께 보낸다. search-app.js 의 실제 함수를 vm 으로 실행한다.
 *   ① 인라인 타계정(search.html 「타계정 정보」) — 못 받았으면 저장 0 · 받은 목록을 기준으로 · 그사이 바뀌면 서버 안내 + 다시 불러오기 + 입력 유지
 *   ② 옛 프로필 모달 삭제(deleteSubAccount) — 같은 규칙
 *   ③ 구매양식 자동 등록(_registerSubAccountFromOrder) — 저장 직전에 받은 목록이 기준 · 그사이 바뀌면 새로 받아 한 번 더(사람 조작 없이)
 *      · 두 번 연속이면 서버 안내로 멈춘다(기준 없는 통째 저장으로 되돌아가지 않는다)
 *   ④ 배선 — search-app.js 의 saveSubAccounts 호출은 전부 baseSubAccounts 를 싣는다
 * 결정 358 후속 2(W8) — search.html 인라인 내정보 불러오기 실패 화면 + 겹친 불러오기의 늦은 옛 응답
 *   ⑤ 실패 = 리뷰어 홈과 같은 오류 상자(#pfLoadError) · 본인 카드·타계정 칸·열린 폼 숨김 · 저장 0 · 「반드시 추가」 문구 안 보임
 *   ⑥ [다시 불러오기] 성공 = 상자 숨김 · 카드·칸 되돌림 · 받은 목록이 저장 기준
 *   ⑦ 늦게 온 옛 응답(인라인끼리 · 구매양식 계좌 자동완성↔인라인 · 실패 뒤 옛 성공)은 기준·화면을 덮지 않는다
 *   ⑧ 구매양식 계좌 자동완성(_prefillBankFromProfile)도 받은 전체 목록이면 found:true(기준) — 단 가장 나중에 시작한 응답일 때만
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert(start >= 0, '함수 없음: ' + name);
  const asyncPrefix = SRC.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
  // 문자열·템플릿 안의 중괄호를 건너뛰며 짝을 맞춘다(템플릿 안 ${} 도 짝이 맞는 코드라 깊이로 센다).
  let i = SRC.indexOf('{', SRC.indexOf(')', start)), depth = 0, quote = '', esc = false;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (quote) { if (c === quote) quote = ''; else if (quote === '`' && c === '{' ) depth++; else if (quote === '`' && c === '}') depth--; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) break;
  }
  return asyncPrefix + SRC.slice(start, i + 1);
}
const FUNCS = ['_parseSubAccounts', '_subAccountsBase', '_subAccountSig', '_subAccountsNotLoaded', '_afterSubAccountsSaved',
  '_reloadAfterStaleSubAccounts', '_loadInlineProfile', '_loadSecureIdentityProfile', '_renderInlineSubList',
  'toggleInlineSubForm', 'editInlineSubAccount', 'cancelInlineSubForm', 'deleteInlineSubAccount', '_inlineSubSnapshot',
  'confirmSaveInlineSubAccount', 'deleteSubAccount', '_registerSubAccountFromOrder',
  // 결정 358 후속 2(W8) — 불러오기 실패 상자 · 순서 번호
  '_claimReviewerProfileSeq', '_receivedReviewerProfile', '_showInlineProfileLoadError', 'reloadInlineProfile',
  '_loadReviewerProfileForForm', '_prefillBankFromProfile'];
// 불러오기 순서 번호(최상위 let) — 실제 선언 줄을 그대로 싣는다(값을 테스트가 지어내지 않게).
const SEQ_DECL = (SRC.match(/^let _reviewerProfileReqSeq\b[^\n]*;$/m) || [])[0];
assert(SEQ_DECL, '불러오기 순서 번호 선언 없음');

function el(id) {
  return { id, style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    focus() {}, remove() {}, scrollIntoView() {}, insertAdjacentHTML() {} };
}
function makeCtx({ server, saveImpl } = {}) {
  // server = { subAccounts } — gasGet 이 돌려주는 「서버의 지금 목록」. 저장이 성공하면 바뀐다.
  const store = server || { subAccounts: [] };
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  const calls = { posts: [], gets: 0, toasts: [], fetches: 0, modal: 0 };
  const ctx = {
    console, JSON, Array, Object, String, Number, Set, Map, Promise, parseInt,
    window: {},
    document: { getElementById: (id) => (id === 'inlineSubConfirm' ? null : getEl(id)) },
    API_BASE_URL: 'http://x', _getAuthHeaders: () => ({}),
    _getReviewerSession: () => ({ name: '본인', phone8: '99998888' }),
    confirm: () => true,
    showToast: (m) => calls.toasts.push(m),
    escHtml: (v) => String(v == null ? '' : v),
    fmtPhone: (p) => p,
    _renderReviewerProfileModal: () => { calls.modal++; },
    _initIncomeSection: (type, prof) => { calls.income = prof; },
    gasGet: async () => { calls.gets++; return store.fail ? { ok: false, error: 'Failed to fetch' }
      : { ok: true, profile: { name: '본인', phone: '010-9999-8888', subAccounts: JSON.parse(JSON.stringify(store.subAccounts)) } }; },
    gasPost: async (body) => {
      calls.posts.push(body);
      if (saveImpl) return saveImpl(body, store);
      return { ok: true };
    },
    fetch: async () => { calls.fetches++; return { ok: true, json: async () => ({ ok: true, profile: { identities: [{ type: 'self', identityKey: 'self' }] } }) }; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SEQ_DECL, ctx);
  for (const f of FUNCS) vm.runInContext(extract(f), ctx);
  return { ctx, calls, getEl, store };
}
// 서버 흉내 — 결정 358 서버 규칙(기준이 있으면 지금 목록과 비교 · 다르면 stale · 같으면 저장하고 저장 목록을 돌려준다)
function server358(body, store) {
  if (body.action !== 'saveSubAccounts') throw new Error('unexpected ' + body.action);
  const next = JSON.parse(body.subAccounts);
  if (body.baseSubAccounts !== undefined) {
    const base = JSON.parse(body.baseSubAccounts);
    if (JSON.stringify(base) !== JSON.stringify(store.subAccounts)) {
      return { ok: false, code: 'stale_sub_accounts', error: '타계정 정보가 그사이 다른 곳에서 바뀌었어요. 내 정보를 다시 불러온 뒤 한 번 더 저장해 주세요.' };
    }
  }
  store.subAccounts = next.map((s) => ({ ...s, shoppingId: s.shoppingId || 'kept' }));
  return { ok: true, subAccounts: JSON.parse(JSON.stringify(store.subAccounts)) };
}
const A = { name: '가족일', phone: '010-1111-0001', incomeName: '', jumin: '' };
const B = { name: '가족이', phone: '010-1111-0002', incomeName: '', jumin: '' };
const C = { name: '가족삼', phone: '010-1111-0003', incomeName: '', jumin: '' };
function fillForm(getEl, { name, last8, editIdx = -1 }) {
  getEl('inlineSubName').value = name; getEl('inlineSubPhone').value = last8;
  getEl('inlineSubIncomeName').value = ''; getEl('inlineSubJumin').value = '';
  getEl('inlineSubEditIdx').value = String(editIdx);
  getEl('inlineSubForm').style.display = '';
}

(async () => {
  let n = 0;
  const ok = (m) => { n++; console.log('  ✓ ' + m); };

  // ① 불러오기 실패 화면 — 저장확정·삭제·추가 폼 모두 요청 0 + 안내 + 다시 불러오기
  {
    const t = makeCtx({ server: { subAccounts: [A, B], fail: true }, saveImpl: server358 });
    t.ctx._reviewerProfile = null;
    fillForm(t.getEl, { name: '새명의', last8: '22223333' });
    await t.ctx.confirmSaveInlineSubAccount();
    await t.ctx.deleteInlineSubAccount(0);
    t.getEl('inlineSubForm').style.display = 'none';
    t.ctx.toggleInlineSubForm();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(t.calls.posts.length, 0, '받은 목록이 없으면 저장 요청 0');
    assert.strictEqual(t.getEl('inlineSubForm').style.display, 'none', '못 받은 화면에서는 추가 폼을 열지 않는다');
    assert(t.calls.toasts.some((m) => /불러오지 못했어요/.test(m)), '안내를 보인다');
    assert(t.calls.gets >= 1, '내 정보를 다시 불러온다(막다른 길 아님)');
    assert.deepStrictEqual(t.store.subAccounts, [A, B], '서버 목록 그대로');
    ok('불러오기 실패 화면 — 추가·저장·삭제 요청 0 · 안내 + 다시 불러오기');
  }

  // ② 받은 목록 기준 저장 + 서버가 돌려준 저장 목록이 다음 기준
  {
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: server358 });
    await t.ctx._loadInlineProfile();
    assert.strictEqual(t.ctx._reviewerProfile.found, true);
    fillForm(t.getEl, { name: '가족이', last8: '11110002' });
    await t.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(t.calls.posts.length, 1);
    const p = t.calls.posts[0];
    assert.deepStrictEqual(JSON.parse(p.baseSubAccounts), [A], '기준 = 받은 목록');
    assert.strictEqual(JSON.parse(p.subAccounts).length, 2);
    assert.strictEqual(t.ctx._reviewerProfile.subAccounts[0].shoppingId, 'kept', '다음 기준 = 서버가 돌려준 실제 저장 목록');
    assert.strictEqual(t.ctx._secureReviewerProfile, null, '저장 직후 옛 명의 정보(순번 짝)를 비운다');
    // 이어서 삭제 — 서버 저장 목록을 기준으로 보내므로 오탐 거절 없음
    await t.ctx.deleteInlineSubAccount(0);
    assert.strictEqual(t.calls.posts.length, 2);
    assert(!t.calls.toasts.some((m) => /그사이/.test(m)), '연속 저장이 오탐 거절되지 않는다');
    assert.strictEqual(t.store.subAccounts.length, 1);
    assert.strictEqual(t.store.subAccounts[0].name, '가족이');
    ok('받은 목록 기준 저장 · 저장 뒤 서버 저장 목록이 다음 기준(연속 저장 오탐 0)');
  }

  // ③ 그사이 다른 곳에서 바뀜(추가 모드) — 서버 안내 · 다시 불러오기 · 입력 유지 · 다시 누르면 새 기준으로 저장
  {
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: server358 });
    await t.ctx._loadInlineProfile();
    t.store.subAccounts = [A, C];   // 다른 기기에서 C 추가
    fillForm(t.getEl, { name: '가족이', last8: '11110002' });
    await t.ctx.confirmSaveInlineSubAccount();
    assert(t.calls.toasts.some((m) => /그사이 다른 곳에서 바뀌었어요/.test(m)), '서버 안내 문구를 그대로 보인다');
    assert.deepStrictEqual(t.store.subAccounts.map((s) => s.name), ['가족일', '가족삼'], '거절 = 쓰기 0(C 보존)');
    assert.deepStrictEqual(t.ctx._reviewerProfile.subAccounts.map((s) => s.name), ['가족일', '가족삼'], '내 정보를 다시 불러왔다');
    assert.strictEqual(t.getEl('inlineSubName').value, '가족이', '입력값 유지');
    assert.notStrictEqual(t.getEl('inlineSubForm').style.display, 'none', '폼을 닫지 않는다');
    await t.ctx.confirmSaveInlineSubAccount();
    assert.deepStrictEqual(t.store.subAccounts.map((s) => s.name), ['가족일', '가족삼', '가족이'], '다시 누르면 새 기준으로 저장 — C 보존');
    ok('그사이 바뀜(추가) — 안내 · 다시 불러오기 · 입력 유지 · 재저장 때 다른 기기 변경 보존');
  }

  // ④ 그사이 바뀜(수정 모드) — 수정하던 칸을 새 목록에서 다시 찾는다 · 없어졌으면 폼을 닫고 안내
  {
    const t = makeCtx({ server: { subAccounts: [A, B] }, saveImpl: server358 });
    await t.ctx._loadInlineProfile();
    t.store.subAccounts = [C, A, B];   // 다른 곳에서 앞에 C 추가 → B 는 1번 → 2번
    fillForm(t.getEl, { name: '가족이', last8: '11110002', editIdx: 1 });
    t.getEl('inlineSubIncomeName').value = '새소득명의';
    await t.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(t.getEl('inlineSubEditIdx').value, '2', '수정하던 칸(B)을 새 목록 위치로 다시 맞춘다');
    await t.ctx.confirmSaveInlineSubAccount();
    assert.deepStrictEqual(t.store.subAccounts.map((s) => s.name + ':' + s.incomeName), ['가족삼:', '가족일:', '가족이:새소득명의'],
      '엉뚱한 칸(A)을 덮지 않고 B 만 고친다');
    // 수정하던 칸이 다른 곳에서 지워진 경우
    const t2 = makeCtx({ server: { subAccounts: [A, B] }, saveImpl: server358 });
    await t2.ctx._loadInlineProfile();
    t2.store.subAccounts = [A];
    fillForm(t2.getEl, { name: '가족이', last8: '11110002', editIdx: 1 });
    await t2.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(t2.getEl('inlineSubForm').style.display, 'none', '고칠 칸이 없어졌으면 폼을 닫는다(새 칸으로 둔갑 금지)');
    assert(t2.calls.toasts.some((m) => /수정하던 타계정/.test(m)));
    assert.deepStrictEqual(t2.store.subAccounts, [A]);
    ok('그사이 바뀜(수정) — 수정 칸을 새 위치로 다시 맞춤 · 지워졌으면 닫고 안내');
  }

  // ⑤ 삭제 — 그사이 바뀌면 쓰기 0 + 다시 불러오기
  {
    const t = makeCtx({ server: { subAccounts: [A, B] }, saveImpl: server358 });
    await t.ctx._loadInlineProfile();
    t.store.subAccounts = [B];   // 다른 곳에서 A 삭제
    await t.ctx.deleteInlineSubAccount(0);   // 옛 화면 기준 0번 = A
    assert.deepStrictEqual(t.store.subAccounts, [B], 'B 를 지우지 않는다');
    assert.deepStrictEqual(t.ctx._reviewerProfile.subAccounts.map((s) => s.name), ['가족이'], '다시 불러왔다');
    ok('삭제 — 그사이 바뀌면 쓰기 0 · 다시 불러오기');
  }

  // ⑥ 옛 프로필 모달 삭제(deleteSubAccount) — 같은 규칙
  {
    const t = makeCtx({ server: { subAccounts: [A, B] }, saveImpl: server358 });
    t.ctx._reviewerProfile = null;
    await t.ctx.deleteSubAccount(0);
    assert.strictEqual(t.calls.posts.length, 0, '못 받았으면 저장 0');
    await t.ctx._loadInlineProfile();
    await t.ctx.deleteSubAccount(0);
    assert.deepStrictEqual(JSON.parse(t.calls.posts[0].baseSubAccounts), [A, B]);
    assert.deepStrictEqual(t.store.subAccounts.map((s) => s.name), ['가족이']);
    ok('옛 프로필 모달 삭제도 기준 목록을 싣고, 못 받았으면 보내지 않는다');
  }

  // ⑦ 배포 스큐 — 구버전 서버(기준 모름 · 응답에 subAccounts 없음) = 종전처럼 저장, 보낸 목록이 다음 기준
  {
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: (body, store) => { store.subAccounts = JSON.parse(body.subAccounts); return { ok: true }; } });
    await t.ctx._loadInlineProfile();
    fillForm(t.getEl, { name: '가족이', last8: '11110002' });
    await t.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(t.ctx._reviewerProfile.subAccounts.length, 2, '보낸 목록을 다음 기준으로');
    assert.strictEqual(t.ctx._reviewerProfile.found, true, '다음 저장도 가능');
    ok('구버전 서버 — 종전 저장 그대로(보낸 목록이 다음 기준)');
  }

  // ⑧ 구매양식 자동 등록 — 저장 직전에 받은 목록이 기준
  const idn = { name: '신규명의', phone: '010-2222-3333', address: '서울', bankName: '은행', bankAccount: '1', accountHolder: '신규명의' };
  {
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: server358 });
    const r = await t.ctx._registerSubAccountFromOrder({ name: '본인', phone8: '99998888' }, idn);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(t.calls.posts.length, 1);
    assert.deepStrictEqual(JSON.parse(t.calls.posts[0].baseSubAccounts), [A], '기준 = 저장 직전에 받은 목록');
    assert.strictEqual(t.calls.posts[0].origin, 'order_form', '구매양식 표시(결정 224) 유지');
    ok('구매양식 자동 등록 — 저장 직전에 받은 목록을 기준으로 싣는다');
  }
  // ⑨ 그사이 한 번 바뀜 → 새로 받아 자동으로 한 번 더(확인창 다시 안 띄움) → 다른 곳 변경 보존 + 등록
  {
    let first = true;
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: (body, store) => {
      if (first) { first = false; store.subAccounts = [A, C]; }   // 받은 직후 다른 기기에서 C 추가
      return server358(body, store);
    } });
    let confirms = 0; t.ctx.confirm = () => { confirms++; return true; };
    const r = await t.ctx._registerSubAccountFromOrder({ name: '본인', phone8: '99998888' }, idn);
    assert.strictEqual(r.ok, true, '제출을 멈추지 않는다');
    assert.strictEqual(t.calls.posts.length, 2, '자동으로 한 번 더');
    assert.strictEqual(t.calls.gets, 2, '새로 받아서');
    assert.strictEqual(confirms, 0, '사람에게 다시 묻지 않는다');
    assert.deepStrictEqual(t.store.subAccounts.map((s) => s.name), ['가족일', '가족삼', '신규명의'], '다른 기기의 C 보존');
    ok('구매양식 — 그사이 한 번 바뀌면 새로 받아 자동 재시도 · 다른 곳 변경 보존 · 제출 계속');
  }
  // ⑩ 다시 받은 목록에 그 명의가 이미 있으면(다른 곳에서 먼저 등록) 등록됨으로 통과 — 저장 1번
  {
    let first = true;
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: (body, store) => {
      if (first) { first = false; store.subAccounts = [A, { name: '신규명의', phone: '010-2222-3333' }]; }
      return server358(body, store);
    } });
    const r = await t.ctx._registerSubAccountFromOrder({ name: '본인', phone8: '99998888' }, idn);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.alreadyRegistered, true);
    assert.strictEqual(t.calls.posts.length, 1);
    ok('구매양식 — 그사이 같은 명의가 먼저 등록됐으면 등록됨으로 통과');
  }
  // ⑪ 두 번 연속 바뀜 → 서버 안내로 멈춘다 · 기준 없는 통째 저장으로 되돌아가지 않는다
  {
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: () => ({ ok: false, code: 'stale_sub_accounts', error: '타계정 정보가 그사이 다른 곳에서 바뀌었어요. 내 정보를 다시 불러온 뒤 한 번 더 저장해 주세요.' }) });
    const r = await t.ctx._registerSubAccountFromOrder({ name: '본인', phone8: '99998888' }, idn);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'stale_sub_accounts');
    assert(/그사이 다른 곳에서 바뀌었어요/.test(r.error), '서버 안내 문구');
    assert.strictEqual(t.calls.posts.length, 2, '최대 두 번');
    assert(t.calls.posts.every((p) => p.baseSubAccounts !== undefined), '기준 없이 보내는 길 없음');
    ok('구매양식 — 두 번 연속 바뀌면 서버 안내로 멈춤(기준 없는 저장으로 우회 0)');
  }

  // ⑫ 배선 — search-app.js 의 saveSubAccounts 호출은 전부 baseSubAccounts 를 싣는다
  {
    const calls = [...SRC.matchAll(/action:\s*"saveSubAccounts"[\s\S]{0,260}?\}\)/g)].map((m) => m[0]);
    assert.strictEqual(calls.length, 4, 'saveSubAccounts 호출 4곳(늘면 이 가드도 같이 본다)');
    assert(calls.every((c) => /baseSubAccounts:\s*JSON\.stringify\(base\)/.test(c)), '4곳 모두 기준 목록을 싣는다');
    ok('배선 — saveSubAccounts 4곳 모두 baseSubAccounts');
  }


  // ━━ 결정 358 후속 2(W8) — 인라인 내정보 불러오기 실패 화면 · 늦게 온 옛 응답 ━━
  const visible = (t, id) => t.getEl(id).style.display !== 'none';
  // 손으로 응답 시점을 정하는 gasGet — 부른 순서대로 resolve 함수를 모은다.
  function deferredGets(t) {
    const pending = [];
    t.ctx.gasGet = (body) => new Promise((resolve) => { t.calls.gets++; pending.push(resolve); });
    const profile = (subs) => ({ ok: true, profile: { name: '본인', phone: '010-9999-8888', bankName: '예시은행', bankAccount: '123', accountHolder: '본인', subAccounts: JSON.parse(JSON.stringify(subs)) } });
    return { pending, profile };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ⑬ 실패 = 오류 상자 + 카드·칸·열린 폼 숨김 + 저장 0 + 토스트 없음(구매양식 iframe 위로 튀지 않게)
  {
    const t = makeCtx({ server: { subAccounts: [A, B], fail: true }, saveImpl: server358 });
    t.getEl('pfLoadError').style.display = 'none';            // search.html 기본값
    t.getEl('inlineIncomeForm').style.display = '';            // 열려 있던 소득정보 폼
    t.getEl('inlineSubForm').style.display = '';               // 열려 있던 타계정 폼
    await t.ctx._loadInlineProfile();
    assert.strictEqual(visible(t, 'pfLoadError'), true, '오류 상자를 보인다');
    assert.strictEqual(visible(t, 'inlineSelfCard'), false, '본인 카드(미등록·-)를 숨긴다');
    assert.strictEqual(visible(t, 'inlineSubSection'), false, '타계정 칸(0/10 · 반드시 추가하세요 · [타계정 추가])을 숨긴다');
    assert.strictEqual(visible(t, 'inlineIncomeForm'), false, '열린 소득정보 폼을 닫는다');
    assert.strictEqual(visible(t, 'inlineSubForm'), false, '열린 타계정 폼을 닫는다');
    assert.strictEqual(t.calls.toasts.length, 0, '불러오기 실패 자체로는 토스트를 띄우지 않는다');
    assert.strictEqual(t.ctx._subAccountsBase(), null, '받은 목록 없음 → 저장 기준 없음');
    fillForm(t.getEl, { name: '새명의', last8: '22223333' });
    await t.ctx.confirmSaveInlineSubAccount();
    await t.ctx.deleteInlineSubAccount(0);
    assert.strictEqual(t.calls.posts.length, 0, '실패 화면에서 저장·삭제 요청 0');
    assert.deepStrictEqual(t.store.subAccounts, [A, B], '기존 타계정 그대로');
    ok('불러오기 실패 — 리뷰어 홈과 같은 오류 상자 · 카드·타계정 칸·열린 폼 숨김 · 저장 0 · 토스트 없음');
  }

  // ⑭ [다시 불러오기] 성공 → 상자 숨김 · 카드·칸 되돌림 · 받은 목록이 기준 · 버튼 문구 되돌림
  {
    const t = makeCtx({ server: { subAccounts: [A, B], fail: true }, saveImpl: server358 });
    await t.ctx._loadInlineProfile();
    assert.strictEqual(visible(t, 'pfLoadError'), true);
    t.store.fail = false;
    await t.ctx.reloadInlineProfile();
    assert.strictEqual(visible(t, 'pfLoadError'), false, '상자를 숨긴다');
    assert.strictEqual(visible(t, 'inlineSelfCard'), true, '본인 카드 되돌림');
    assert.strictEqual(visible(t, 'inlineSubSection'), true, '타계정 칸 되돌림');
    assert.strictEqual(t.getEl('inlineSelfPhone').textContent, '010-9999-8888');
    assert.strictEqual(t.getEl('btnReloadProfile').textContent, '다시 불러오기', '버튼 문구 되돌림');
    assert.strictEqual(t.getEl('btnReloadProfile').disabled, false, '버튼 잠금 해제');
    assert.strictEqual(t.ctx._reviewerProfile.found, true);
    fillForm(t.getEl, { name: '가족삼', last8: '11110003' });
    await t.ctx.confirmSaveInlineSubAccount();
    assert.deepStrictEqual(JSON.parse(t.calls.posts[0].baseSubAccounts), [A, B], '기준 = 다시 받은 목록');
    assert.deepStrictEqual(t.store.subAccounts.map((s) => s.name), ['가족일', '가족이', '가족삼'], '기존 타계정 보존 + 추가');
    // 세션이 끝났으면 다시 불러오지 않고 안내
    const t2 = makeCtx({ server: { subAccounts: [A] } });
    t2.ctx._getReviewerSession = () => null;
    await t2.ctx.reloadInlineProfile();
    assert.strictEqual(t2.calls.gets, 0);
    assert(t2.calls.toasts.some((m) => /세션이 만료/.test(m)));
    // 받았던 화면에서 다시 불러오기가 실패하면 — 「모름」으로 접는다(옛 목록으로 저장하지 않음)
    t.store.fail = true;
    await t.ctx.reloadInlineProfile();
    assert.strictEqual(visible(t, 'pfLoadError'), true);
    assert.strictEqual(t.ctx._subAccountsBase(), null, '다시 불러오기 실패 = 저장 기준 없음');
    ok('[다시 불러오기] 성공 — 상자 숨김 · 카드·칸 되돌림 · 받은 목록 기준 저장 · 세션 끝났으면 안내 · 다시 실패면 잠금');
  }

  // ⑮ 겹친 인라인 불러오기 — 먼저 시작한 요청의 늦은 응답(옛 목록)은 기준·화면을 덮지 않는다
  {
    const t = makeCtx({ server: { subAccounts: [] }, saveImpl: server358 });
    const d = deferredGets(t);
    const first = t.ctx._loadInlineProfile();    // 옛 목록 [A] 을 들고 늦게 온다
    const second = t.ctx._loadInlineProfile();   // 새 목록 [A, B]
    await tick();
    d.pending[1](d.profile([A, B])); await second;
    d.pending[0](d.profile([A])); await first;
    assert.deepStrictEqual(t.ctx._subAccountsBase().map((s) => s.name), ['가족일', '가족이'], '기준 = 새 목록');
    assert(/가족이/.test(t.getEl('inlineSubList').innerHTML), '화면도 새 목록');
    assert.strictEqual(t.calls.fetches, 1, '옛 응답은 화면을 다시 그리지 않는다(명의 정보 재요청 0)');
    // 늦게 온 옛 「실패」도 새 화면을 오류로 바꾸지 않는다
    const t2 = makeCtx({ server: { subAccounts: [] } });
    const d2 = deferredGets(t2);
    const f1 = t2.ctx._loadInlineProfile(); const f2 = t2.ctx._loadInlineProfile();
    await tick();
    d2.pending[1](d2.profile([A])); await f2;
    d2.pending[0]({ ok: false, networkError: true, error: '인터넷 연결이 불안정해요.' }); await f1;
    assert.strictEqual(visible(t2, 'pfLoadError'), false, '옛 실패 응답이 새 화면을 덮지 않는다');
    assert.strictEqual(t2.ctx._reviewerProfile.found, true);
    ok('겹친 인라인 불러오기 — 늦게 온 옛 응답(성공·실패 모두)은 기준·화면을 덮지 않는다');
  }

  // ⑯ 구매양식 계좌 자동완성(먼저 시작) ↔ 인라인(나중 시작) — 계좌 쪽 늦은 옛 목록이 기준이 되지 않는다
  {
    const t = makeCtx({ server: { subAccounts: [] }, saveImpl: server358 });
    const d = deferredGets(t);
    t.ctx._reviewerProfile = null;
    const pre = t.ctx._prefillBankFromProfile();   // 옛 목록 [A]
    const inl = t.ctx._loadInlineProfile();        // 새 목록 [A, B]
    await tick();
    d.pending[1](d.profile([A, B])); await inl;
    d.pending[0](d.profile([A])); await pre;
    assert.deepStrictEqual(t.ctx._subAccountsBase().map((s) => s.name), ['가족일', '가족이'], '기준 = 나중에 시작한 인라인의 새 목록');
    assert.strictEqual(t.getEl('of_bank').value, '예시은행', '계좌 빈 칸 채우기는 그대로 한다');
    assert.strictEqual(t.getEl('of_account').value, '123');
    // 반대 순서(인라인 먼저 시작 · 계좌 자동완성 나중) — 둘 다 그대로 반영, 인라인 화면은 버려지지 않는다
    const t2 = makeCtx({ server: { subAccounts: [] } });
    const d2 = deferredGets(t2);
    t2.ctx._reviewerProfile = null;
    const inl2 = t2.ctx._loadInlineProfile();       // 옛 [A] — 늦게 온다
    const pre2 = t2.ctx._prefillBankFromProfile();  // 새 [A, B]
    await tick();
    d2.pending[1](d2.profile([A, B])); await pre2;
    d2.pending[0](d2.profile([A])); await inl2;
    assert.deepStrictEqual(t2.ctx._subAccountsBase().map((s) => s.name), ['가족일', '가족이'], '기준 = 나중에 시작한 계좌 쪽의 새 목록');
    assert.strictEqual(visible(t2, 'pfLoadError'), false, '인라인 화면은 그려진다(오류 아님)');
    assert(/가족이/.test(t2.getEl('inlineSubList').innerHTML), '인라인 화면은 더 새 목록으로 그린다');
    ok('계좌 자동완성 ↔ 인라인이 겹쳐도 늦게 온 옛 목록이 기준·화면이 되지 않는다(인라인 화면은 버려지지 않음)');
  }

  // ⑰ 인라인 실패(나중 시작) 뒤에 도착한 옛 성공(계좌 자동완성)은 기준이 되지 않는다 — 화면은 오류 그대로 · 저장 0
  {
    const t = makeCtx({ server: { subAccounts: [] }, saveImpl: server358 });
    const d = deferredGets(t);
    t.ctx._reviewerProfile = null;
    const pre = t.ctx._prefillBankFromProfile();   // 먼저 시작 — 늦게 성공
    const inl = t.ctx._loadInlineProfile();        // 나중 시작 — 실패
    await tick();
    d.pending[1]({ ok: false, networkError: true, error: '인터넷 연결이 불안정해요.' }); await inl;
    d.pending[0](d.profile([A])); await pre;
    assert.strictEqual(visible(t, 'pfLoadError'), true);
    assert.strictEqual(t.ctx._subAccountsBase(), null, '옛 성공이 뒤늦게 기준이 되지 않는다');
    ok('나중 시작한 인라인이 실패하면 먼저 시작한 옛 성공이 뒤늦게 기준이 되지 않는다');
  }

  // ⑱ 계좌 자동완성 단독 — 받은 전체 목록이면 found:true(기준) · 실패면 기준 없음 그대로
  {
    const t = makeCtx({ server: { subAccounts: [A] }, saveImpl: server358 });
    t.ctx._reviewerProfile = null;
    await t.ctx._prefillBankFromProfile();
    assert.strictEqual(t.ctx._reviewerProfile.found, true, '받은 목록 = 저장 기준');
    assert.deepStrictEqual(t.ctx._subAccountsBase(), [A]);
    const t2 = makeCtx({ server: { subAccounts: [A], fail: true } });
    t2.ctx._reviewerProfile = null;
    await t2.ctx._prefillBankFromProfile();
    assert.strictEqual(t2.ctx._subAccountsBase(), null, '실패면 기준 없음');
    // 구매양식 소득신고 칸 불러오기도 같은 순서 번호를 쓴다(늦은 옛 응답은 기준을 덮지 않음)
    const t3 = makeCtx({ server: { subAccounts: [] } });
    const d3 = deferredGets(t3);
    t3.ctx._incomeType = '소득신고';
    const form = t3.ctx._loadReviewerProfileForForm();   // 옛 [A]
    const inl = t3.ctx._loadInlineProfile();             // 새 [A, B]
    await tick();
    d3.pending[1](d3.profile([A, B])); await inl;
    d3.pending[0](d3.profile([A])); await form;
    assert.deepStrictEqual(t3.ctx._subAccountsBase().map((s) => s.name), ['가족일', '가족이']);
    assert.strictEqual(t3.calls.income.subAccounts.length, 2, '소득신고 칸은 더 새 내 정보로 채운다');
    ok('계좌 자동완성 단독은 기준이 된다 · 소득신고 칸 불러오기도 같은 순서 번호');
  }

  // ⑲ search.html 배선 — 리뷰어 홈과 같은 상자·문구 · 숨길 칸 아이디 · 상자는 기본 숨김
  {
    const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/search.html'), 'utf8');
    const home = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
    const boxOf = (h) => (h.match(/<div id="pfLoadError"[^>]*>[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || '';
    const text = (b) => b.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const sBox = boxOf(html), hBox = boxOf(home);
    assert(sBox && hBox, '두 화면 모두 오류 상자');
    assert.strictEqual(text(sBox), text(hBox), '문구가 리뷰어 홈과 같다');
    assert.strictEqual((sBox.match(/^<div[^>]*>/) || [])[0], (hBox.match(/^<div[^>]*>/) || [])[0], '상자 모양(style)이 리뷰어 홈과 같다');
    assert(/onclick="reloadInlineProfile\(\)"/.test(sBox) && /id="btnReloadProfile"/.test(sBox));
    const sec = html.slice(html.indexOf('id="inlineProfileSection"'), html.indexOf('id="searchProgress"'));
    for (const id of ['pfLoadError', 'inlineSelfCard', 'inlineSubSection', 'inlineIncomeForm', 'inlineSubForm']) {
      assert(sec.includes('id="' + id + '"'), id + ' 는 인라인 내정보 칸 안에 있다');
    }
    assert.strictEqual((html.match(/id="pfLoadError"/g) || []).length, 1);
    ok('search.html — 리뷰어 홈과 같은 오류 상자(모양·문구) · 숨길 칸 아이디 · 인라인 내정보 칸 안');
  }

  console.log(`\n✅ searchAppSubAccountsStaleBase: ${n}개 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
