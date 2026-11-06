'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'frontend/js/index-recruit.js'), 'utf8');
// Reuse the established table DOM harness, not copies of product behavior.
const harness = fs.readFileSync(path.join(__dirname, 'campaignProdModeSplit.test.js'), 'utf8');
function editor() {
  const context = { require, __dirname, console };
  vm.createContext(context);
  vm.runInContext(harness.slice(0, harness.indexOf('/* ══════════════ A.')), context);
  const table = vm.runInContext('makeTable()', context);
  table.load = name => table.run((name === 'saveRecruitPostImpl' ? 'async ' : '') + context.grab(source, name));
  table.dom.add('rf_channel', 'input');
  table.dom.add('rf_channel_custom', 'input');
  table.dom.add('rf_channel_btns');
  table.sandbox.URL = URL;
  table.sandbox.Event = class { constructor(type) { this.type = type; } };
  const marker = '/* RF_DUAL_CHANNEL_EDITOR */';
  assert.ok(source.includes(marker), 'dual-channel editor implementation is present');
  table.run(source.slice(source.indexOf(marker), source.indexOf('/* RF_DUAL_CHANNEL_EDITOR_END */')));
  table.run('renderOptRows([], {mode:"none"})');
  return table;
}
const product = () => ({
  option_schema_version: 2, product_mode: 'none', name: '동일상품', url: 'https://shop.example/main',
  base: {pay: 19000, count: 7}, options: [],
  channels: {
    naver: {url: 'https://naver.example/a', pay: 9000, inflow_type: 'link', guide: {text: '남겨 둔 안내', images: []}},
    coupang: {url: 'https://coupang.example/b', pay: 10000, inflow_type: 'guide', guide: {text: '검색 안내', images: ['https://images.example/1.png']}}
  }
});
// 결정 341 출시: 동시진행 저장은 열렸지만, 불완전·불량 입력은 네트워크 전에 이유와 함께 막힌다.
const DUAL_SAVE_BLOCKED = /^동시진행 공고를 저장할 수 없습니다 — \S/;
function restore(t, p = product()) { t.sandbox.input = p; return t.run('rfRestoreDualChannelProduct(input)'); }
function read(t) { return JSON.parse(t.run('JSON.stringify(rfReadDualChannelProduct())')); }

test('one product restores both purchase channels, one human quota, derived sum and guides', () => {
  const t = editor();
  assert.equal(restore(t), true);
  assert.deepEqual(read(t), product());
  assert.equal(t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length, 1);
  assert.equal(t.dom.byId.rf_opt_rows.querySelectorAll('.rf-opt-row').length, 1);
  assert.equal(t.run('_prodMode()'), 'none');
  assert.equal(t.run('JSON.stringify(readOptRows())'), '[]');
  assert.equal(Number(t.dom.byId.rf_recruit_total.value), 7);
  assert.equal(t.dom.byId.rf_opt_rows.querySelector('.rf-opt-pay').readOnly, true);
  const naverPay = t.dom.byId.rf_opt_rows.querySelector('.rf-dual-naver-pay');
  naverPay.value = '9100'; naverPay.fire('input');
  assert.equal(read(t).base.pay, 19100);
  assert.equal(read(t).base.count, 7);
  assert.equal(read(t).channels.coupang.guide.text, '검색 안내');
});

test('actual save blocks incomplete dual selection with a reason before validation or any network request', async () => {
  const t = editor(); t.load('saveRecruitPostImpl');
  const blocked = [];
  t.sandbox._rfSaveBlocked = message => blocked.push(message);
  t.sandbox.fetch = () => { throw new Error('NETWORK MUST NOT RUN'); };
  t.sandbox.syncRecruitAutomaticBadges = () => { throw new Error('ordinary save validation must not run'); };
  t.dom.byId.rf_channel.value = '네이버+쿠팡';
  await t.run('saveRecruitPostImpl()');
  assert.match(blocked.pop(), DUAL_SAVE_BLOCKED);
  restore(t);
  t.dom.byId.rf_channel.value = '쿠팡'; // DOM presence must independently protect against mode drift.
  t.dom.byId.rf_opt_rows.querySelector('.rf-dual-naver-pay').value = '';
  await t.run('saveRecruitPostImpl()');
  assert.match(blocked.pop(), DUAL_SAVE_BLOCKED);
});

test('channel button enters dual editor without recreating the parent or losing legacy guides', () => {
  const t = editor(); t.load('selectRfBtn');
  t.sandbox.syncRecruitAutomaticBadges = () => {};
  t.run('renderOptRows([{productName:"기존 상품",payAmount:15000,recruitTotal:5,inflowGuideHtml:"기존 가이드",inflowGuideImages:["https://images.example/legacy.png"]}],{mode:"none"})');
  const box = t.dom.byId.rf_opt_rows.querySelector('.rf-gp');
  const before = t.run('JSON.stringify(_ugCompose(document.querySelector("#rf_opt_rows .rf-opt-row"),document.querySelector("#rf_opt_rows .rf-opt-row").dataset.ig))');
  const button = t.dom.mk('button'); button.dataset.val = '네이버+쿠팡'; t.dom.byId.rf_channel_btns.appendChild(button);
  t.sandbox.button = button;
  t.run('selectRfBtn("channel",button)');
  assert.equal(t.dom.byId.rf_opt_rows.querySelector('.rf-gp'), box);
  assert.ok(box.querySelector('.rf-dual-editor'));
  assert.equal(t.run('JSON.stringify(_ugCompose(document.querySelector("#rf_opt_rows .rf-opt-row"),document.querySelector("#rf_opt_rows .rf-opt-row").dataset.ig))'), before);
  assert.equal(Number(t.dom.byId.rf_recruit_total.value), 5);
  for (const key of ['naver', 'coupang']) {
    box.querySelector('.rf-dual-' + key + '-url').value = 'https://shop.example/' + key;
    box.querySelector('.rf-dual-' + key + '-pay').value = '9000';
  }
  const legacy = JSON.parse(before);
  assert.deepEqual(read(t).guide, {text:legacy.html, images:legacy.images});
});

test('fresh ordinary modal reset removes dual state and unlocks standard controls', () => {
  const t = editor(); restore(t);
  t.run('rfResetDualChannelEditor(); renderOptRows([])');
  assert.equal(t.run('rfDualActive()'), false);
  assert.equal(read(t), null);
  assert.equal(t.dom.byId.rf_opt_addbtn.disabled, false);
  t.run('addOptRow()');
  assert.equal(t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length, 2);
});

test('all product entry points restore canonical channels without converting them to options', () => {
  for (const entry of ['renderOptRowsWithProduct([],"",{work_detail:{dualChannelProduct:input}})',
    'applyProductRowsFromOrder({dualChannelProduct:input})', 'renderOptRows([input])']) {
    const t = editor(); t.sandbox.input = product();
    t.run(entry);
    assert.deepEqual(read(t), product(), entry);
  }
});

test('dual editor blocks add, option switching and normal rerender without losing draft fields', () => {
  const t = editor(); restore(t);
  const before = read(t);
  const box = t.dom.byId.rf_opt_rows.querySelector('.rf-gp');
  t.run('addOptRow()');
  box.querySelectorAll('.rf-gp-unit button').find(b => b.dataset.unit === 'option').onclick();
  t.run('renderOptRows([])');
  assert.deepEqual(read(t), before);
  assert.equal(t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length, 1);
  assert.equal(box.dataset.unit, 'product');
  assert.equal(t.run('rfDualSelect("쿠팡")'), false);
  box.querySelector('.rf-opt-del').onclick();
  assert.deepEqual(read(t), before);
  assert.equal(box.querySelector('.rf-opt-plus').disabled, true);
});

test('URL 내부 제어문자 복원 거부 후 현재 초안 편집과 재열기를 유지한다', () => {
  for (const channel of ['naver', 'coupang']) for (const field of ['url', 'image']) {
    const t = editor();
    assert.equal(restore(t), true);
    const box = t.dom.byId.rf_opt_rows.querySelector('.rf-gp');
    const sourceBefore = JSON.stringify(box._rfDualSource);
    const pay = box.querySelector('.rf-dual-naver-pay');
    pay.value = '11000'; pay.fire('input');
    const before = read(t);
    for (const code of [10, 9, 13, ...[...Array(32).keys()].filter(n => ![10, 9, 13].includes(n)), 127]) {
      const p = product();
      const url = 'https://shop.example/private-url-marker' + String.fromCharCode(code) + 'item';
      if (field === 'url') p.channels[channel].url = url;
      else p.channels[channel].guide.images = [url];
      const raw = JSON.stringify(p);
      assert.equal(restore(t, p), false, `${channel} ${field} control ${code}`);
      assert.equal(JSON.stringify(p), raw);
      assert.equal(t.sandbox._rfDualRejectedSource, p);
      assert.match(t.sandbox._rfDualRejectedMessage, /주소/);
      assert.doesNotMatch(t.sandbox._rfDualRejectedMessage, /private-url-marker/);
      assert.equal(t.dom.byId.rf_opt_rows.querySelector('.rf-gp'), box);
      assert.equal(JSON.stringify(box._rfDualSource), sourceBefore);
      assert.deepEqual(read(t), before);
    }
    pay.value = '12000'; pay.fire('input');
    const edited = read(t);
    assert.equal(edited.base.pay, 22000);
    const reopened = editor();
    assert.equal(restore(reopened, JSON.parse(JSON.stringify(edited))), true);
    assert.deepEqual(read(reopened), edited);
    const fresh = editor();
    assert.equal(restore(fresh, t.sandbox._rfDualRejectedSource), false);
    assert.throws(() => read(fresh), /주소/);
  }
});

test('주소 앞뒤만 trim하고 인코딩된 제어문자와 원래 철자를 재열기 후에도 보존한다', () => {
  const t = editor();
  const p = product();
  const url = 'HTTPS://Short.Example:443/a%0Ab%09c%00d%7f?q=%2f#Part';
  for (const channel of Object.values(p.channels)) {
    channel.url = '\n\t ' + url + ' \r\n';
    channel.guide.images = ['\n\t ' + url + ' \r\n'];
  }
  const raw = JSON.stringify(p);
  assert.equal(restore(t, p), true);
  assert.equal(JSON.stringify(p), raw);
  const normalized = read(t);
  for (const channel of Object.values(normalized.channels)) {
    assert.equal(channel.url, url);
    assert.deepEqual(channel.guide.images, [url]);
  }
  const reopened = editor();
  assert.equal(restore(reopened, JSON.parse(JSON.stringify(normalized))), true);
  assert.deepEqual(read(reopened), normalized);
});

test('unknown or malformed restore is preserved, visibly rejected, and cannot be read as ordinary data', async () => {
  const t = editor(); const p = product(); p.channels.naver.future = 'preserve me';
  const original = JSON.stringify(p);
  const errors = []; t.sandbox.showToast = message => errors.push(message);
  assert.equal(restore(t, p), false);
  assert.equal(JSON.stringify(p), original);
  assert.match(errors.pop(), /모르는 항목/);
  assert.throws(() => read(t), /원본|확인|모르는/);
  t.load('saveRecruitPostImpl'); t.sandbox._rfSaveBlocked = message => errors.push(message);
  await t.run('saveRecruitPostImpl()');
  assert.match(errors.pop(), DUAL_SAVE_BLOCKED);
});

test('rejected restore candidates preserve the current editable draft and local JSON round trip', async () => {
  const unknown = product(); unknown.channels.naver.future = 'x';
  for (const candidate of [unknown, null, {}]) {
    const t = editor(); const original = product();
    assert.equal(restore(t, original), true);
    const box = t.dom.byId.rf_opt_rows.querySelector('.rf-gp');
    const sourceBefore = JSON.stringify(box._rfDualSource);
    const pay = box.querySelector('.rf-dual-naver-pay');
    pay.value = '11000'; pay.fire('input');
    const before = read(t);
    const candidateBefore = JSON.stringify(candidate);
    assert.equal(restore(t, candidate), false);
    assert.equal(t.dom.byId.rf_opt_rows.querySelector('.rf-gp'), box);
    assert.equal(JSON.stringify(box._rfDualSource), sourceBefore);
    assert.equal(JSON.stringify(candidate), candidateBefore);
    assert.equal(t.sandbox._rfDualRejectedSource, candidate);
    assert.ok(t.sandbox._rfDualRejectedMessage);
    assert.equal(box.querySelector('.rf-dual-error').hidden, false);
    assert.deepEqual(read(t), before);
    pay.value = '12000'; pay.fire('input');
    const edited = read(t);
    assert.equal(edited.channels.naver.pay, 12000);
    assert.equal(edited.base.pay, 22000);
    assert.equal(edited.channels.coupang.pay, 10000);
    assert.equal(JSON.stringify(box._rfDualSource), sourceBefore);
    assert.equal(JSON.stringify(original), JSON.stringify(product()));
    assert.equal(box.querySelector('.rf-dual-error').textContent, t.sandbox._rfDualRejectedMessage);
    assert.equal(box.querySelector('.rf-dual-error').hidden, false);
    const stored = t.run('JSON.stringify(rfReadDualChannelProduct())');
    const reopened = editor();
    assert.equal(restore(reopened, JSON.parse(stored)), true);
    assert.deepEqual(read(reopened), edited);
    const blocked = []; t.load('saveRecruitPostImpl');
    t.sandbox._rfSaveBlocked = message => blocked.push(message);
    t.sandbox.fetch = () => { throw new Error('NETWORK MUST NOT RUN'); };
    await t.run('saveRecruitPostImpl()');
    assert.match(blocked.pop(), DUAL_SAVE_BLOCKED);
  }
});

test('dual entry points reject conflicting top-level quotas without replacing the current draft', async () => {
  for (const entry of ['renderOptRowsWithProduct([], "", input)', 'applyProductRowsFromOrder(input)']) {
    for (const top of [{recruit_total:7}, {daily_limit:1}, {recruit_total:'1e2'}, {daily_limit:null}]) {
      const t = editor(); restore(t);
      const pay = t.dom.byId.rf_opt_rows.querySelector('.rf-dual-naver-pay');
      pay.value = '11000'; pay.fire('input');
      const before = read(t);
      const p = product();
      if (Object.hasOwn(top, 'recruit_total') && top.recruit_total === 7) p.base.count = 99;
      t.sandbox.input = entry.startsWith('render')
        ? {...top, work_detail:{dualChannelProduct:p}} : {...top, dualChannelProduct:p};
      const raw = JSON.stringify(t.sandbox.input);
      assert.equal(t.run(entry), false, entry + JSON.stringify(top));
      assert.equal(JSON.stringify(t.sandbox.input), raw);
      assert.equal(t.sandbox._rfDualRejectedSource, p);
      assert.deepEqual(read(t), before);
      assert.match(t.dom.byId.rf_opt_rows.querySelector('.rf-dual-error').textContent, /인원|일건수/);
      pay.value = '12000'; pay.fire('input');
      assert.equal(read(t).base.pay, 22000);
      const fresh = editor(); fresh.sandbox.input = t.sandbox.input;
      assert.equal(fresh.run(entry), false);
      assert.equal(fresh.sandbox._rfDualRejected, true);
      assert.throws(() => read(fresh));
      const blocked = []; fresh.load('saveRecruitPostImpl');
      fresh.sandbox._rfSaveBlocked = message => blocked.push(message);
      fresh.sandbox.fetch = () => { throw new Error('NETWORK MUST NOT RUN'); };
      await fresh.run('saveRecruitPostImpl()');
      assert.match(blocked.pop(), DUAL_SAVE_BLOCKED);
    }
    for (const top of [{}, {recruit_total:'7',daily_limit:'0'}]) {
      const t = editor(); const p = product();
      t.sandbox.input = entry.startsWith('render')
        ? {...top, work_detail:{dualChannelProduct:p}} : {...top, dualChannelProduct:p};
      assert.equal(t.run(entry), true);
      assert.deepEqual(read(t), p);
    }
  }
});

test('missing, decimal, negative, exponent and unsafe money stay invalid instead of becoming zero', () => {
  const t = editor(); restore(t);
  const input = t.dom.byId.rf_opt_rows.querySelector('.rf-dual-naver-pay');
  for (const value of ['', '-1', '0.5', '1e3', 'true', '9007199254740992']) {
    input.value = value; input.fire('input');
    assert.equal(input.value, value);
    assert.throws(() => read(t), /결제금액/);
    assert.match(t.dom.byId.rf_opt_rows.querySelector('.rf-dual-error').textContent, /결제금액/);
    assert.match(t.dom.byId.rf_opt_rows.querySelector('.rf-dual-total').textContent, /확인 필요/);
    assert.equal(t.dom.byId.rf_opt_rows.querySelector('.rf-opt-pay').value, '');
  }
  input.value = '0'; input.fire('input');
  assert.equal(read(t).base.pay, 10000);
});

test('local JSON round trip preserves parent guide, extra parent data and inert hostile text', () => {
  const t = editor(); const p = product();
  p.guide = {text:'공통 가이드 원문',images:['https://images.example/old.png']};
  p.futureParent = {keep:true}; p.base.futureBase = 'keep';
  p.channels.naver.guide.text = '<img src=x onerror="globalThis.hacked=1">';
  assert.equal(restore(t, p), true);
  assert.deepEqual(read(t), p);
  const serialized = JSON.stringify(read(t));
  const t2 = editor(); assert.equal(restore(t2, JSON.parse(serialized)), true);
  assert.deepEqual(read(t2), p);
  assert.equal(t2.sandbox.hacked, undefined);
  assert.ok(t2.dom.byId.rf_opt_rows.querySelector('.rf-dual-preview').textContent.includes('<img'));
});

test('daily quota restores and editing it is reflected in the canonical product', () => {
  const t = editor(); const p = product(); p.base.daily = 3;
  restore(t, p);
  const daily = t.dom.byId.rf_opt_rows.querySelector('.rf-opt-dl');
  assert.equal(Number(daily.value), 3);
  daily.value = '4'; daily.fire('input');
  assert.equal(read(t).base.daily, 4);
  assert.equal(read(t).base.count, 7);
  p.base.daily = 0; restore(t, p);
  assert.equal(read(t).base.daily, 0);
});

test('null and unsupported dual values cannot silently fall through to normal saving', async () => {
  for (const p of [null, false, 0, {}, [], { ...product(), qty_tiers: [] }]) {
    const t = editor(); assert.equal(restore(t, p), false);
    assert.equal(t.sandbox._rfDualRejected, true);
    assert.deepEqual(t.sandbox._rfDualRejectedSource, p);
    assert.throws(() => read(t));
    const messages = []; t.load('saveRecruitPostImpl'); t.sandbox._rfSaveBlocked = m => messages.push(m);
    await t.run('saveRecruitPostImpl()'); assert.match(messages.pop(), DUAL_SAVE_BLOCKED);
  }
});

test('active compact modal exposes dual selection and dual-only styling', () => {
  const modal = fs.readFileSync(path.join(root, 'frontend/js/recruit-modal.js'), 'utf8');
  const active = modal.slice(modal.indexOf('<div id="rf_channel_btns" class="square-toggle">')).split('</div>')[0];
  assert.match(active, /data-val="네이버\+쿠팡"[^>]*onclick="selectRfBtn\('channel',this\)"/);
  assert.match(modal, /#recruitModal[^\n]*\.rf-dual-editor/);
});

test('ordinary products, multiple cards and options remain unchanged when the new helpers are loaded', () => {
  const t = editor();
  t.run('renderOptRows([{productName:"일반 상품",optKey:"블랙",payAmount:22000,recruitTotal:5,dailyLimit:2}],{mode:"opt"})');
  const options = JSON.parse(t.run('JSON.stringify(readOptRows())'));
  assert.equal(options.length, 1); assert.equal(options[0].optKey, '블랙');
  assert.equal(options[0].payAmount, 22000); assert.equal(options[0].recruitTotal, 5);
  assert.equal(read(t), null); assert.equal(t.run('rfDualSelect("네이버+쿠팡")'), false);
  assert.equal(t.run('_prodMode()'), 'opt');
  t.run('addOptRow({productName:"둘째 상품"})');
  assert.equal(t.dom.byId.rf_opt_rows.querySelectorAll('.rf-gp').length, 2);
  assert.equal(t.run('rfDualSelect("네이버+쿠팡")'), false);
});

test('bad channel keys, URL credentials, guide types, missing inflow and quantity tiers reject without rewriting input', () => {
  const t = editor();
  const cases = [
    p => {p.channels.unknown = {};}, p => {delete p.channels.coupang;},
    p => {p.channels.naver.url='javascript:alert(1)';}, p => {p.channels.naver.url='https://user:pass@shop.example/a';},
    p => {p.channels.naver.inflow_type='';}, p => {p.channels.coupang.guide.text='';p.channels.coupang.guide.images=[];},
    p => {p.channels.naver.guide.images=['https://images.example/a.png',''];},
    p => {p.channels.naver.guide.images=Array(5).fill('https://images.example/a.png');},
    p => {p.channels.naver.guide.html='unknown';}, p => {p.base.pay=1;},
    p => {p.base.count=0;}, p => {p.base.daily='1.5';}, p => {p.product_mode='opt';},
    p => {p.options=[{name:'옵션'}];}, p => {p.qty_tiers=[];}, p => {p.closed=true;}
  ];
  for (const change of cases) {
    const p = product(); change(p); const before = JSON.stringify(p);
    assert.equal(restore(t, p), false);
    assert.equal(JSON.stringify(p), before);
    assert.throws(() => read(t));
  }
});

test('an ordinary order prefill cannot discard unsupported source structure to enable dual mode', () => {
  const t = editor();
  t.sandbox._woPrefillOrderId = 'fake-existing-order';
  const before = t.run('JSON.stringify(_readProdRowsRaw())');
  assert.equal(t.run('rfDualSelect("네이버+쿠팡")'), false);
  assert.equal(t.run('rfDualActive()'), false);
  assert.equal(t.run('JSON.stringify(_readProdRowsRaw())'), before);
});

for (const kind of ['blog', 'qna', 'unknown']) {
  test('unapproved work kind is not silently converted into a purchase review: ' + kind, () => {
    const t = editor();
    const input = t.dom.byId.rf_work_kind || t.dom.add('rf_work_kind', 'input');
    input.value = kind;
    assert.equal(t.run('rfDualSelect("네이버+쿠팡")'), false);
    assert.equal(t.run('rfDualActive()'), false);
    assert.equal(input.value, kind);
  });
}

test('출시: 완성된 두 구매처 입력은 저장용 상품으로 그대로 읽히고 공고 본문에 실린다', () => {
  const t = editor(); restore(t);
  t.dom.byId.rf_channel.value = '네이버+쿠팡';
  const saved = JSON.parse(t.run('JSON.stringify(rfDualSaveProduct())'));
  assert.deepEqual(saved, product());
  t.sandbox.payload = { channel: '네이버+쿠팡', channel_custom: 'x', recruit_total: 7, daily_limit: 0, options: [],
    work_detail: { productLines: '동일상품', reviewGuide: '' } };
  t.sandbox.saved = saved;
  t.run('rfDualApplyToPayload(payload, saved)');
  const body = JSON.parse(JSON.stringify(t.sandbox.payload)); // vm 영역 객체를 같은 영역 값으로
  assert.equal(body.channel, '네이버+쿠팡');
  assert.equal(body.channel_custom, '');
  assert.deepEqual(body.options, []);
  assert.equal(body.work_detail.productLines, '동일상품');
  // 서버 normalizeSettings: 보낸 일건수와 상품 일건수가 같아야 한다(0 = 미지정과 같은 뜻 · 결정 338).
  assert.deepEqual(body.work_detail.dualChannelProduct, { ...product(), base: { ...product().base, daily: 0 } });
  assert.equal(body.work_detail.dualChannelProduct.base.count, body.recruit_total);
});

test('출시: 불완전·불일치 입력은 저장용 상품을 만들지 않고 이유를 낸다', () => {
  const t = editor();
  t.dom.byId.rf_channel.value = '네이버+쿠팡';
  assert.throws(() => t.run('rfDualSaveProduct()'), /구매처/);
  restore(t);
  const pay = t.dom.byId.rf_opt_rows.querySelector('.rf-dual-naver-pay'); pay.value = ''; pay.fire('input');
  assert.throws(() => t.run('rfDualSaveProduct()'), /네이버 결제금액/);
  pay.value = '9000'; pay.fire('input');
  t.dom.byId.rf_channel.value = '쿠팡';
  assert.throws(() => t.run('rfDualSaveProduct()'), /네이버\+쿠팡/);
  t.dom.byId.rf_channel.value = '네이버+쿠팡';
  const p = product(); p.base.count = 99;
  t.sandbox.input = { recruit_total: 7, dualChannelProduct: p };
  t.run('applyProductRowsFromOrder(input)');
  assert.throws(() => t.run('rfDualSaveProduct()'), /인원|확인/);
  t.sandbox.payload = { recruit_total: 8, daily_limit: 0, work_detail: {} };
  t.sandbox.saved = product();
  assert.throws(() => t.run('rfDualApplyToPayload(payload, saved)'), /모집인원/);
});
