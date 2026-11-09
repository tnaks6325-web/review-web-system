'use strict';
/*
 * 결정 358 후속(W4) — 리뷰 제출 화면·구매양식(frontend/js/search-app.js)의 타계정 「통째 저장」 4곳도
 * 이 화면이 서버에서 실제로 받은 목록(baseSubAccounts)을 함께 보낸다. search-app.js 의 실제 함수를 vm 으로 실행한다.
 *   ① 인라인 타계정(search.html 「타계정 정보」) — 못 받았으면 저장 0 · 받은 목록을 기준으로 · 그사이 바뀌면 서버 안내 + 다시 불러오기 + 입력 유지
 *   ② 옛 프로필 모달 삭제(deleteSubAccount) — 같은 규칙
 *   ③ 구매양식 자동 등록(_registerSubAccountFromOrder) — 저장 직전에 받은 목록이 기준 · 그사이 바뀌면 새로 받아 한 번 더(사람 조작 없이)
 *      · 두 번 연속이면 서버 안내로 멈춘다(기준 없는 통째 저장으로 되돌아가지 않는다)
 *   ④ 배선 — search-app.js 의 saveSubAccounts 호출은 전부 baseSubAccounts 를 싣는다
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
  'confirmSaveInlineSubAccount', 'deleteSubAccount', '_registerSubAccountFromOrder'];

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

  console.log(`\n✅ searchAppSubAccountsStaleBase: ${n}개 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
