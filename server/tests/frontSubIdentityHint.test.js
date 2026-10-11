'use strict';
// 결정 222(3-3) — 타계정 저장 확인 단계의 미리 알림(막지 않음). 리뷰어 홈(index.html)·리뷰 제출 화면(search-app.js) 두 곳.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extract(src, name) {
  // 함수 하나만 정확히 잘라낸다(중괄호 짝 맞추기 — 문자열·템플릿 안의 중괄호도 짝이 맞는 코드라 충분하다).
  const start = src.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const files = {
  'index.html': fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8'),
  'search-app.js': fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8'),
};
(async () => {
for (const [label, src] of Object.entries(files)) {
  const run = (profile, session, name, phone, editIdx = -1) => {
    const ctx = { window: { _reviewerProfile: profile }, _getReviewerSession: () => session,
      _parseSubAccounts: (v) => (Array.isArray(v) ? v : []) };
    vm.createContext(ctx);
    vm.runInContext(extract(src, '_subIdentityHint'), ctx);
    return ctx._subIdentityHint(name, phone, editIdx);
  };
  const prof = { name: '인하늘', phone: '010-4149-0001', subAccounts: [{ name: '인하랑', phone: '010-9778-0002' }] };
  assert(/본인 정보와 같아요/.test(run(prof, null, '인 하늘', '01041490001')), label + ' 본인과 같으면 안내(띄어쓰기 무시)');
  assert(/이미 같은 이름·번호의 타계정/.test(run(prof, null, '인하랑', '010-9778-0002')), label + ' 이미 있는 타계정과 같으면 안내');
  assert.strictEqual(run(prof, null, '인하랑', '010-9778-0002', 0), '', label + ' 그 칸 자체를 고칠 때는 안내 없음');
  assert.strictEqual(run(prof, null, '다른이름', '010-4149-0001'), '', label + ' 번호가 같아도 이름이 다르면 안내 없음(B)');
  assert.strictEqual(run(prof, null, '새명의', '010-5555-0001'), '', label + ' 보통 저장은 안내 없음');
  assert(/본인 정보와 같아요/.test(run(null, { name: '인하늘', phone8: '41490001' }, '인하늘', '010-4149-0001')), label + ' 프로필이 없으면 로그인 정보로');
  assert.strictEqual(run(null, null, '인하늘', '010-4149-0001'), '', label + ' 본인 정보를 모르면 안내 없음(막지 않음)');
  assert(/\$\{_subIdentityHint\(name, phone, editIdx\)\}/.test(src), label + ' 확인 단계에 안내 자리');
  // Codex P2 — 확인 상자를 띄운 뒤 값이 바뀌면 저장하지 않고 다시 확인받는다
  {
    const vals = { inlineSubName: '새명의', inlineSubPhone: '5555-0001', inlineSubEditIdx: '-1' };
    const el = (id) => (id in vals ? { get value() { return vals[id]; } } : null);
    const box = { dataset: {}, remove() {} };
    let reconfirm = 0, posted = 0, toasted = '';
    const ctx = { document: { getElementById: (id) => (id === 'inlineSubConfirm' ? box : el(id)) },
      showToast: (m) => { toasted = m; }, saveInlineSubAccount: () => { reconfirm++; },
      gasPost: async () => { posted++; return { ok: true }; }, getSavedUser: () => ({ name: '인하늘', phone8: '41490001' }),
      _getReviewerSession: () => ({ name: '인하늘', phone8: '41490001' }), window: { _reviewerProfile: { subAccounts: [] } },
      _parseSubAccounts: () => [], renderInlineSubList() {}, _renderInlineSubList() {}, cancelInlineSubForm() {} };
    vm.createContext(ctx);
    vm.runInContext(extract(src, '_inlineSubSnapshot'), ctx);
    vm.runInContext(extract(src, 'confirmSaveInlineSubAccount').replace(/^/, 'async '), ctx);
    box.dataset.snap = ctx._inlineSubSnapshot();
    vals.inlineSubName = '인하늘'; vals.inlineSubPhone = '4149-0001';   // 띄운 뒤 본인 값으로 바꿈
    await ctx.confirmSaveInlineSubAccount().then(() => {
      assert.strictEqual(reconfirm, 1, label + ' 값이 바뀌면 확인 상자를 다시 띄운다');
      assert.strictEqual(posted, 0, label + ' 바뀐 값은 다시 확인 전에는 저장하지 않는다');
      assert(/다시 확인/.test(toasted));
    });
    // 값이 그대로면 종전처럼 저장한다(정상 경로 불변)
    box.dataset.snap = ctx._inlineSubSnapshot();
    await ctx.confirmSaveInlineSubAccount();
    assert.strictEqual(posted, 1, label + ' 값이 그대로면 저장');
    assert.strictEqual(reconfirm, 1, label + ' 다시 띄우지 않음');
  }
  console.log('PASS ' + label + ' — 본인 같음·중복만 안내 · 이름 다르면/모르면 안내 없음 · 값 바뀌면 다시 확인');
}
const camp = fs.readFileSync(path.resolve(__dirname, '../../frontend/campaign.html'), 'utf8');
const wd = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
assert(!/가족/.test(camp) && !/가족/.test(wd) && !/가족/.test(files['index.html']) && !/가족/.test(files['search-app.js']), '화면에 "가족" 전제 문구 없음(사용자 확정 B)');
console.log('PASS 화면 문구에 "가족" 없음');
})().catch((e) => { console.error(e); process.exit(1); });
