'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');

function functionSource(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0);
  assert(start >= 0, `${name} 시작점을 찾을 수 없음`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const char = source[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 끝점을 찾을 수 없음`);
}

function makeContext({ profile, prechecks = [], saveResponse = { ok: true } }) {
  const calls = [];
  const toasts = [];
  const storedProfile = JSON.parse(JSON.stringify(profile));
  let confirmCount = 0;
  const context = {
    console,
    window: {},
    _showProfileGateBanner: () => {},
    showToast: (message, type) => toasts.push({ message, type }),
    confirm: () => { confirmCount++; return true; },
    gasGet: async body => {
      calls.push({ kind: 'get', body });
      return { ok: true, profile: JSON.parse(JSON.stringify(storedProfile)) };
    },
    gasPost: async body => {
      calls.push({ kind: 'post', body });
      if (body.action === 'identityPrecheck') return prechecks.shift() || { ok: true, results: [] };
      if (body.action === 'saveSubAccounts') {
        if (saveResponse.ok) storedProfile.subAccounts = JSON.parse(body.subAccounts);
        return saveResponse;
      }
      throw new Error(`unexpected action ${body.action}`);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(`${functionSource('_registerSubAccountFromOrder')}\n${functionSource('_runIdentityPrecheck')}`, context);
  return { context, calls, toasts, confirmCount: () => confirmCount };
}

function identity(name = '신규명의', phone = '010-2222-3333') {
  return { name, phone, address: '서울시 테스트로 1', bankName: '테스트은행', bankAccount: '1234', accountHolder: name };
}

function order(name = '신규명의', phone = '010-2222-3333') {
  return {
    recipient: name, phone, address: '서울시 테스트로 1', bank: '테스트은행', account: '1234', depositor: name,
    extractedRecipient: name, extractedPhone: phone, extractedAddress: '서울시 테스트로 1', identityConfirmed: false,
  };
}

(async () => {
  {
    const h = makeContext({ profile: { subAccounts: [{ name: '기존명의', phone: '010-2222-3333' }] } });
    const result = await h.context._registerSubAccountFromOrder({ name: '본인', phone8: '11112222' }, identity());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'SUB_PHONE_NAME_MISMATCH');
    assert(result.error.includes('기존명의'));
    assert.strictEqual(h.calls.filter(call => call.body.action === 'saveSubAccounts').length, 0);
    console.log('  ✓ 같은 연락처·다른 이름은 중복 저장하지 않고 등록 이름을 안내');
  }

  {
    const h = makeContext({ profile: { subAccounts: [{ name: '신규 명의', phone: '010-2222-3333' }] } });
    const result = await h.context._registerSubAccountFromOrder({ name: '본인', phone8: '11112222' }, identity('신규명의'));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.alreadyRegistered, true);
    assert.strictEqual(h.calls.filter(call => call.body.action === 'saveSubAccounts').length, 0);
    console.log('  ✓ 같은 이름·연락처는 재등록 없이 기존 타계정으로 인정');
  }

  {
    const h = makeContext({
      profile: { subAccounts: [] },
      prechecks: [
        { ok: true, results: [{ idx: 0, status: 'NEED_SUB_REGISTER', identity: identity() }] },
        { ok: true, results: [{ idx: 0, status: 'SUB', identity: identity() }] },
      ],
    });
    const orders = [order()];
    const ready = await h.context._runIdentityPrecheck({ name: '본인', phone8: '11112222' }, orders);
    assert.strictEqual(ready, true);
    assert.strictEqual(h.confirmCount(), 1);
    assert.deepStrictEqual(h.calls.filter(call => call.kind === 'post').map(call => call.body.action),
      ['identityPrecheck', 'saveSubAccounts', 'identityPrecheck']);
    console.log('  ✓ 신규 타계정은 저장 후 재검증을 통과해야 제출 단계로 진행');
  }

  {
    const h = makeContext({
      profile: { subAccounts: [{ name: '기존명의', phone: '010-2222-3333' }] },
      prechecks: [{
        ok: true,
        results: [{ idx: 0, status: 'NEED_CONFIRM', reasons: ['등록된 타계정 이름과 입력 이름이 다름'] }],
      }],
    });
    const orders = [order('기존명의님')];
    const ready = await h.context._runIdentityPrecheck({ name: '본인', phone8: '11112222' }, orders);
    assert.strictEqual(ready, true);
    assert.strictEqual(orders[0].identityConfirmed, true);
    assert.strictEqual(h.confirmCount(), 1);
    assert.strictEqual(h.calls.filter(call => call.body.action === 'saveSubAccounts').length, 0);
    console.log('  ✓ 같은 연락처·다른 이름은 새 등록 없이 명시적 확인으로 진행');
  }

  {
    const identities = Array.from({ length: 5 }, (_, index) =>
      identity(`신규명의${index + 1}`, `010-2222-${String(3301 + index).padStart(4, '0')}`));
    const initialResults = identities.map((item, idx) => ({ idx, status: 'NEED_SUB_REGISTER', identity: item }));
    const finalResults = identities.map((item, idx) => ({ idx, status: 'SUB', identity: item }));
    const h = makeContext({
      profile: { subAccounts: [] },
      prechecks: [{ ok: true, results: initialResults }, { ok: true, results: finalResults }],
    });
    const ready = await h.context._runIdentityPrecheck(
      { name: '본인', phone8: '11112222' },
      identities.map(item => order(item.name, item.phone))
    );
    assert.strictEqual(ready, true);
    assert.strictEqual(h.confirmCount(), 5);
    assert.strictEqual(h.calls.filter(call => call.body.action === 'saveSubAccounts').length, 5);
    assert.strictEqual(h.calls.filter(call => call.body.action === 'identityPrecheck').length, 2);
    console.log('  ✓ 5건 신규 타계정도 사전검증은 최초·최종 2회만 호출');
  }

  {
    const h = makeContext({
      profile: { subAccounts: [] },
      prechecks: [
        { ok: true, results: [{ idx: 0, status: 'NEED_SUB_REGISTER', identity: identity() }] },
        { ok: true, results: [{ idx: 0, status: 'NEED_SUB_REGISTER', identity: identity() }] },
      ],
    });
    const ready = await h.context._runIdentityPrecheck({ name: '본인', phone8: '11112222' }, [order()]);
    assert.strictEqual(ready, false);
    assert.strictEqual(h.confirmCount(), 1);
    assert(h.toasts.some(toast => toast.message.includes('등록 후에도')));
    console.log('  ✓ 저장 뒤에도 불일치하면 재등록 반복 없이 제출 중단');
  }

  {
    const h = makeContext({
      profile: { subAccounts: [] },
      prechecks: [{ ok: true, results: [{ idx: 0, status: 'NEED_SUB_REGISTER', identity: identity() }] }],
      saveResponse: { ok: false, code: 'SAME_PHONE', error: '같은 연락처의 타계정은 한 번만 등록할 수 있습니다.' },
    });
    const ready = await h.context._runIdentityPrecheck({ name: '본인', phone8: '11112222' }, [order()]);
    assert.strictEqual(ready, false);
    assert(h.toasts.some(toast => toast.message.includes('같은 연락처')));
    console.log('  ✓ 저장 실패 시 서버의 실제 거절 사유를 화면에 표시');
  }

  {
    const ten = Array.from({ length: 10 }, (_, index) => ({ name: `명의${index}`, phone: `010-0000-${String(index).padStart(4, '0')}` }));
    const h = makeContext({ profile: { subAccounts: ten } });
    const result = await h.context._registerSubAccountFromOrder({ name: '본인', phone8: '11112222' }, identity());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'SUB_ACCOUNT_LIMIT');
    assert(result.error.includes('최대 10개'));
    console.log('  ✓ 타계정 10개 제한은 이유와 조치가 포함된 오류로 반환');
  }

  console.log('\n✅ subAccountAutoRegistrationFlow: 8개 통과');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
