'use strict';
/*
 * 결정 358 — 리뷰어 홈 내정보·타계정 화면(index.html)을 vm 으로 실제 실행해 확인한다.
 *   S1 프로필을 못 받은 화면에서는 타계정을 저장하지 않는다 · 저장 때 기준 목록(baseSubAccounts)을 함께 보낸다
 *   H3 불러오기 실패 = 「미등록」이 아니라 오류 + [다시 불러오기] · 늦게 온 옛 응답은 버린다
 *   M4 타계정 저장/삭제 직후 이웃 명의의 쇼핑 아이디·명의키를 보여 주지 않는다(명의 정보 다시 받기)
 *   L6 소득명의/주민번호를 비우고 저장해도 화면은 서버에 남은 값을 보여 준다
 *   L7 고치지 않은 옛 01x 번호는 그대로 보낸다
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8');
function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert(start >= 0, '함수 없음: ' + name);
  const asyncPrefix = SRC.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '';
  let i = SRC.indexOf('{', SRC.indexOf(')', start)), depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
  return asyncPrefix + SRC.slice(start, i + 1);
}
const FUNCS = ['_parseSubAccounts', 'loadInlineProfile', '_showInlineProfileLoadError', 'reloadInlineProfile',
  'renderSelfIncomeInfo', 'loadSecureIdentityProfile', 'renderInlineSubList', '_subAccountsBase', '_afterSubAccountsSaved',
  'toggleInlineSubForm', 'editInlineSubAccount', 'cancelInlineSubForm', 'deleteInlineSubAccount', '_inlineSubSnapshot',
  '_inlineSubPhoneValue', 'confirmSaveInlineSubAccount', 'saveIncomeInfoInline', '_escAttrX'];

function el(id) {
  return { id, style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', className: '', disabled: false, attrs: {},
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute(k, v) { this.attrs[k] = v; }, focus() {}, remove() {},
    scrollIntoView() {}, insertAdjacentHTML() {} };
}
function makeCtx({ gasGet, gasPost, secure } = {}) {
  const els = new Map();
  const selfCard = el('selfCard'), subsec = el('subsec');
  const getEl = (id) => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); };
  getEl('inlineProfileSection').querySelectorAll = () => [selfCard, subsec];
  const calls = { posts: [], toasts: [], fetches: 0 };
  let secureQueue = Array.isArray(secure) ? secure.slice() : [];
  const ctx = {
    console, JSON, Array, Object, String, Number, Set, Map, Promise, parseInt,
    window: {},
    document: { getElementById: (id) => (id === 'inlineSubConfirm' ? null : getEl(id)) },
    API_BASE_URL: 'http://x', _getAuthHeaders: () => ({}),
    getSavedUser: () => ({ name: '본인', phone8: '99998888' }),
    confirm: () => true,
    showToast: (m) => calls.toasts.push(m),
    escHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    fmtPhone: (p) => p, renderSelfKakaoId() {}, renderSelfAddress() {}, renderBankInfo() {},
    gasGet: gasGet || (async () => ({ error: 'Failed to fetch' })),
    gasPost: async (body) => { calls.posts.push(body); return gasPost ? gasPost(body) : { ok: true }; },
    fetch: async () => {
      calls.fetches++;
      const next = secureQueue.length ? secureQueue.shift() : null;
      if (next === 'hang') return new Promise(() => {});
      return { ok: true, json: async () => ({ ok: true, profile: { identities: next || [{ type: 'self', identityKey: 'self' }] } }) };
    },
    _inlineProfileGen: 0, _secureProfileGen: 0, _inlineProfileUser: null,
  };
  vm.createContext(ctx);
  vm.runInContext('var _inlineProfileGen = 0, _secureProfileGen = 0, _inlineProfileUser = null;', ctx);
  for (const f of FUNCS) vm.runInContext(extract(f), ctx);
  return { ctx, getEl, selfCard, subsec, calls, setSecure: (q) => { secureQueue = q.slice(); } };
}
const PROFILE = (subs) => ({ ok: true, profile: { name: '본인', phone: '010-9999-8888', incomeType: '본인', residentNum: '9001011234567', subAccounts: subs } });
const A = { name: '김에이', phone: '010-1111-2222' };
const B = { name: '이비', phone: '010-3333-4444' };
const IDS = [{ type: 'self', identityKey: 'self' }, { type: 'sub', identityKey: 'identity:A', name: A.name, shoppingId: 'a_shop' },
  { type: 'sub', identityKey: 'identity:B', name: B.name, shoppingId: 'b_shop' }];
const tick = () => new Promise((r) => setImmediate(r));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await test('H3: 불러오기 실패 → 오류 상자 + 카드 숨김(「미등록」·0/10 을 보여 주지 않음) · 프로필은 모름(null)', async () => {
    const t = makeCtx();
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    assert.strictEqual(t.getEl('pfLoadError').style.display, '');
    assert.strictEqual(t.selfCard.style.display, 'none');
    assert.strictEqual(t.subsec.style.display, 'none');
    assert.strictEqual(t.ctx.window._reviewerProfile, null);
  });
  await test('H3: gasGet 이 예외를 던져도 같은 오류 상자', async () => {
    const t = makeCtx({ gasGet: async () => { throw new Error('boom'); } });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    assert.strictEqual(t.getEl('pfLoadError').style.display, '');
    assert.strictEqual(t.selfCard.style.display, 'none');
  });
  await test('H3: [다시 불러오기] 성공 → 오류 상자 닫고 카드·타계정 표시', async () => {
    let fail = true;
    const t = makeCtx({ gasGet: async () => (fail ? { error: 'x' } : PROFILE([A])) });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    fail = false;
    await t.ctx.reloadInlineProfile();
    assert.strictEqual(t.getEl('pfLoadError').style.display, 'none');
    assert.strictEqual(t.selfCard.style.display, '');
    assert.strictEqual(t.subsec.style.display, '');
    assert.strictEqual(t.getEl('inlineSubCount').textContent, '1/10');
    assert.strictEqual(t.ctx.window._reviewerProfile.found, true);
  });
  await test('H3: 겹친 불러오기에서 늦게 온 옛 실패 응답이 성공 화면을 덮지 않는다', async () => {
    let first;
    const t = makeCtx({ gasGet: () => (first ? Promise.resolve(PROFILE([A])) : new Promise((r) => { first = r; })) });
    const p1 = t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    const p2 = t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    await p2;
    first({ error: 'late' });
    await p1;
    assert.strictEqual(t.ctx.window._reviewerProfile.found, true);
    assert.strictEqual(t.getEl('pfLoadError').style.display, 'none');
  });
  await test('S1: 프로필을 못 받은 화면에서는 추가 폼도 안 열고 저장확정·삭제도 서버로 보내지 않는다', async () => {
    const t = makeCtx();
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    t.getEl('inlineSubForm').style.display = 'none';
    t.ctx.toggleInlineSubForm();
    assert.strictEqual(t.getEl('inlineSubForm').style.display, 'none', '추가 폼이 열리면 안 된다');
    t.getEl('inlineSubName').value = '새타계'; t.getEl('inlineSubPhone').value = '5555-6666'; t.getEl('inlineSubEditIdx').value = '-1';
    await t.ctx.confirmSaveInlineSubAccount();
    await t.ctx.deleteInlineSubAccount(0);
    assert.strictEqual(t.calls.posts.length, 0, '저장 요청 0');
    assert.ok(t.calls.toasts.some((m) => /불러오지 못/.test(m)), t.calls.toasts.join('|'));
  });
  await test('S1: 받은 화면에서 추가하면 기준 목록(받은 목록)을 함께 보내고, 서버가 돌려준 목록을 다음 기준으로 쓴다', async () => {
    const saved = [{ ...A, shoppingId: 'a_shop' }, { name: '새타계', phone: '010-5555-6666' }];
    const t = makeCtx({ gasGet: async () => PROFILE([A]), gasPost: async () => ({ ok: true, subAccounts: saved }) });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    t.getEl('inlineSubName').value = '새타계'; t.getEl('inlineSubPhone').value = '5555-6666'; t.getEl('inlineSubEditIdx').value = '-1';
    await t.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(t.calls.posts.length, 1);
    assert.deepStrictEqual(JSON.parse(t.calls.posts[0].baseSubAccounts), [A]);
    assert.deepStrictEqual(JSON.parse(t.calls.posts[0].subAccounts).map((s) => s.name), ['김에이', '새타계']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(t.ctx.window._reviewerProfile.subAccounts)), saved);
  });
  await test('S1: 서버가 stale_sub_accounts 로 거절하면 화면 목록을 바꾸지 않고 안내 + 다시 불러온다', async () => {
    let gets = 0;
    const t = makeCtx({ gasGet: async () => { gets++; return PROFILE([A]); },
      gasPost: async () => ({ ok: false, code: 'stale_sub_accounts', error: '타계정 정보가 그사이 다른 곳에서 바뀌었어요.' }) });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    t.getEl('inlineSubName').value = '새타계'; t.getEl('inlineSubPhone').value = '5555-6666'; t.getEl('inlineSubEditIdx').value = '-1';
    await t.ctx.confirmSaveInlineSubAccount();
    await tick();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(t.ctx.window._reviewerProfile.subAccounts)), [A]);
    assert.ok(t.calls.toasts.some((m) => /다른 곳에서 바뀌었/.test(m)));
    assert.strictEqual(gets, 2, '내 정보를 다시 불러온다');
  });
  await test('M4: 타계정 A 삭제 직후 남은 B 줄에 A 의 쇼핑 아이디·명의키가 보이지 않고, 다시 받은 명의로 맞춰진다', async () => {
    const t = makeCtx({ gasGet: async () => PROFILE([A, B]), gasPost: async () => ({ ok: true, subAccounts: [B] }), secure: [IDS, 'hang'] });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    assert.ok(/value="a_shop"/.test(t.getEl('inlineSubList').innerHTML), '처음에는 A 줄에 a_shop');
    await t.ctx.deleteInlineSubAccount(0);
    const html = t.getEl('inlineSubList').innerHTML;
    assert.ok(!/a_shop/.test(html) && !/identity:A/.test(html), '이웃(A) 값이 남은 B 줄에 보이면 안 된다');
    assert.strictEqual(t.calls.fetches, 2, '명의 정보를 다시 받는다');
    // 다시 받은 명의가 도착하면 B 의 값으로 맞춰진다
    t.setSecure([[IDS[0], IDS[2]]]);
    await t.ctx.loadSecureIdentityProfile();
    const html2 = t.getEl('inlineSubList').innerHTML;
    assert.ok(/value="b_shop"/.test(html2) && /identity:B/.test(html2));
  });
  await test('M4: 늦게 도착한 옛 명의 응답은 버린다(세대 번호)', async () => {
    let releaseOld;
    const t = makeCtx({ gasGet: async () => PROFILE([B]) });
    t.ctx.fetch = async () => new Promise((r) => { releaseOld = () => r({ ok: true, json: async () => ({ ok: true, profile: { identities: IDS } }) }); });
    const old = t.ctx.loadSecureIdentityProfile();
    const oldRelease = releaseOld;
    t.ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true, profile: { identities: [IDS[0], IDS[2]] } }) });
    await t.ctx.loadSecureIdentityProfile();
    oldRelease(); await old;
    assert.strictEqual(t.ctx.window._secureReviewerProfile.identities.length, 2);
  });
  await test('L6: 주민번호 칸을 비우고 소득명의만 저장해도 화면은 남아 있는 주민번호를 보여 준다', async () => {
    const t = makeCtx({ gasGet: async () => PROFILE([]) });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    t.getEl('inlineIncomeNameInput').value = '새명의'; t.getEl('inlineJuminInput').value = '';
    await t.ctx.saveIncomeInfoInline();
    assert.strictEqual(t.calls.posts[0].residentNum, '');
    assert.strictEqual(t.getEl('inlineSelfIncomeName').textContent, '새명의');
    assert.strictEqual(t.getEl('inlineSelfJumin').textContent, '900101-1••••••', '「미등록」이 아니라 기존 값');
    assert.ok(t.calls.toasts.some((m) => /기존 값/.test(m)), t.calls.toasts.join('|'));
  });
  await test('L7: 016 번호 타계정의 계좌만 고치면 번호는 그대로 016 으로 보낸다 · 번호를 고치면 010', async () => {
    const OLD = { name: '박옛번', phone: '016-123-4567', bankAccount: '1' };
    const t = makeCtx({ gasGet: async () => PROFILE([OLD]), gasPost: async (b) => ({ ok: true, subAccounts: JSON.parse(b.subAccounts) }) });
    await t.ctx.loadInlineProfile({ name: '본인', phone8: '99998888' });
    t.ctx.editInlineSubAccount(0);
    assert.ok(/016-123-4567/.test(t.getEl('inlineSubPhoneNote').textContent), '지금 번호 안내');
    t.getEl('inlineSubBankAccount').value = '2';
    await t.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(JSON.parse(t.calls.posts[0].subAccounts)[0].phone, '016-123-4567');
    t.ctx.editInlineSubAccount(0);
    t.getEl('inlineSubPhone').value = '7777-8888';
    await t.ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(JSON.parse(t.calls.posts[1].subAccounts)[0].phone, '010-7777-8888');
    // 추가 폼은 옛 번호 기억을 지운다
    t.getEl('inlineSubForm').style.display = 'none';
    t.ctx.toggleInlineSubForm();
    assert.strictEqual(t.getEl('inlineSubPhone').dataset.origPhone, '');
  });
  await test('배선: 리뷰어 홈의 타계정 저장 2곳(삭제·저장확정)은 모두 기준 목록을 싣는다', async () => {
    const calls = SRC.match(/gasPost\(\{ action: "saveSubAccounts"[^}]*\}/g) || [];
    assert.strictEqual(calls.length, 2, calls.join('\n'));
    for (const c of calls) assert.ok(/baseSubAccounts: JSON\.stringify\(base\)/.test(c), c);
  });
  console.log(`\n✅ reviewerHomeProfileSubAccounts: ${passed}개 통과`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
