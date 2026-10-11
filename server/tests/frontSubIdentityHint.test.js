'use strict';
// 결정 222(3-3) — 타계정 저장 확인 단계의 미리 알림(막지 않음). 리뷰어 홈(index.html)·리뷰 제출 화면(search-app.js) 두 곳.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extract(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  const end = src.indexOf('\nasync function ', start + 1);
  return src.slice(start, end);
}
const files = {
  'index.html': fs.readFileSync(path.resolve(__dirname, '../../frontend/index.html'), 'utf8'),
  'search-app.js': fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8'),
};
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
  console.log('PASS ' + label + ' — 본인 같음·중복만 안내 · 이름 다르면/모르면 안내 없음');
}
const camp = fs.readFileSync(path.resolve(__dirname, '../../frontend/campaign.html'), 'utf8');
const wd = fs.readFileSync(path.resolve(__dirname, '../../frontend/workdesk.html'), 'utf8');
assert(!/가족/.test(camp) && !/가족/.test(wd) && !/가족/.test(files['index.html']) && !/가족/.test(files['search-app.js']), '화면에 "가족" 전제 문구 없음(사용자 확정 B)');
console.log('PASS 화면 문구에 "가족" 없음');
