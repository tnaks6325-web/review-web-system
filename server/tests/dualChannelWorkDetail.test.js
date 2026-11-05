'use strict';
// Actual shared reviewer renderer, no browser/image requests or application APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/campaign-workdetail.js'), 'utf8');
const M = vm.runInNewContext(source + ';window.CampWorkDetail', { window: {}, URL });
const clone = value => JSON.parse(JSON.stringify(value));
const product = () => ({
  name: '동시진행 수건', base: { pay: 19000, count: 3 }, options: [], product_mode: 'none',
  channels: {
    naver: { url: 'https://naver.example/item?n=1&x=2', pay: 9000, inflow_type: 'guide', guide: { text: '네이버에서 검색\n두 번째 상품', images: [] } },
    coupang: { url: 'https://coupang.example/item/2', pay: 10000, inflow_type: 'link', guide: { text: '', images: [] } },
  },
});
const data = p => ({ workDetail: {
  dualChannelProduct: p, productLines: '옛 상품 안내', payAmount: 555,
  inflowGuideHtml: '<b>옛 공통 경로</b>', reviewGuide: '공통 리뷰 안내', specialNotes: '공통 특이사항',
}, selectedOption: { optKey: '옛 선택지', inflowGuideHtml: '<b>옛 선택지 경로</b>', optionUrl: 'https://old.example/option' },
landingUrl: 'https://old.example/landing', inflowType: 'link', qty: { purchaseQty: 2, amount: 777 } });
const render = (p, o = {}, extra = {}) => M.cardsHtml({ ...data(p), ...extra }, o);
const count = (html, text) => html.split(text).length - 1;

// These hashes were captured from the unmodified renderer before implementation.
const legacyCases = [
  [{ workDetail: {} }, '61c985910c0884059a71e3f131b9d74f1643b738058384b0b878077270d57dab'],
  [{ workDetail: { productLines: '단일상품 - 결제금액 12,000원', inflowGuideHtml: '<b>검색</b>', reviewGuide: '[리뷰등록 가이드]\n사진 한 장', specialNotes: '<주의> 그대로' }, inflowType: 'guide', landingUrl: 'https://legacy.example/product' }, 'b33db438be4837755b1896022a8d67aaea05d1824a222d44f99c8add75c9402e'],
  [{ workDetail: { productLines: '옵션상품', inflowGuideHtml: '공통 가이드' }, inflowType: 'guide', selectedOption: { optKey: '선택 A', optionUrl: 'https://legacy.example/option-a', inflowType: 'link', payAmount: 9000 } }, 'bd7f1544c9f847cda39b46670ac6cf284963d15de28c4068403a98636a22f769'],
  [{ workDetail: { productLines: '선택상품' }, selectedOption: { optKey: '선택 B', inflowGuideHtml: '<b>전용</b>', inflowGuideImages: ['https://old.example/api/order/guide-image/abcdefghijklmnopqrstuvw'] } }, '389cfb9055ba19d6b935bde1df65cbff9be753472e351eb7f16235a85e6e87ff'],
  [{ workDetail: { productLines: '수량상품 - 결제금액 10,000원' }, qty: { purchaseQty: 3, amount: 30000 }, landingUrl: 'https://legacy.example/qty', inflowType: 'link' }, '83e9842a65bae553cfaad1b0aa171ca0f54a34d458a7c232b1428708576c8866'],
];
test('preservation: missing new key keeps legacy HTML byte-for-byte and original inputs', () => {
  for (const [d, hash] of legacyCases) {
    const original = clone(d);
    assert.equal(crypto.createHash('sha256').update(M.cardsHtml(d)).digest('hex'), hash);
    assert.deepEqual(d, original);
  }
});

test('one product, one total, two required channel payments and independent inflow paths', () => {
  const p = product(), d = data(p), original = clone(d);
  const html = M.cardsHtml(d);
  assert.equal(count(html, p.name), 1);
  assert.equal(count(html, '합계 결제금액 19,000원'), 1);
  assert.match(html, /두 구매처 모두/);
  assert.match(html, /네이버/);
  assert.match(html, /쿠팡/);
  assert.match(html, /결제금액 9,000원/);
  assert.match(html, /결제금액 10,000원/);
  assert.match(html, /가이드유입/);
  assert.match(html, /링크유입/);
  assert.match(html, /네이버에서 검색\n두 번째 상품/);
  assert.match(html, /href="https:\/\/coupang.example\/item\/2"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.equal(count(html, '<a '), 1);
  for (const wrong of ['https://naver.example', 'https://old.example', '옛 상품 안내', '옛 선택지', '옛 공통 경로', '555원', '777원']) assert.ok(!html.includes(wrong), wrong);
  assert.match(html, /공통 리뷰 안내/);
  assert.match(html, /공통 특이사항/);
  assert.deepEqual(d, original, 'rendering must not normalize/mutate canonical input');
});

test('reversing channel inflows reverses only their own guides and links', () => {
  const p = product();
  p.channels.naver.inflow_type = 'link';
  p.channels.naver.guide.text = '숨길 네이버 가이드';
  p.channels.coupang.inflow_type = 'guide';
  p.channels.coupang.guide.text = '쿠팡 검색 안내';
  const html = render(p);
  assert.match(html, /href="https:\/\/naver.example\/item\?n=1&amp;x=2"/);
  assert.ok(!html.includes('coupang.example'));
  assert.ok(!html.includes('숨길 네이버 가이드'));
  assert.match(html, /쿠팡 검색 안내/);
});

for (const value of [null, undefined, '', false, 0, [], { name: '불완전 상품' }]) {
  test('explicit broken product never falls back to legacy: ' + String(value), () => {
    const html = render(value);
    assert.match(html, /동시진행/);
    assert.match(html, /확인 필요|준비 중/);
    assert.match(html, /담당자/);
    assert.match(html, /네이버/);
    assert.match(html, /쿠팡/);
    assert.ok(!html.includes('옛 상품 안내') && !html.includes('old.example'));
    assert.ok(!/NaN|undefined|\[object Object\]|결제금액 0원/.test(html));
    assert.ok(!html.includes('<a '));
  });
}

for (const value of [null, undefined, '', false, true, [], {}, '1e3', '1.5', -1, 1.5, NaN, Infinity]) {
  test('broken channel payment is unknown, not coerced: ' + String(value), () => {
    const p = product(); p.channels.coupang.pay = value;
    const html = render(p);
    assert.match(html, /결제금액 확인 필요/);
    assert.match(html, /담당자/);
    assert.ok(!/NaN|undefined|\[object Object\]|결제금액 0원/.test(html));
    assert.ok(!html.includes('coupang.example'));
  });
}

test('invalid total, missing count and inconsistent sum are not replaced with a computed total', () => {
  for (const change of [p => { p.base.pay = null; }, p => { p.base.pay = 18999; }, p => { delete p.base.count; }]) {
    const p = product(); change(p);
    const html = render(p);
    assert.match(html, /확인 필요/);
    assert.ok(!html.includes('<a '));
    assert.ok(!html.includes('합계 결제금액 19,000원'));
  }
});

test('zero is only displayed when explicitly valid; integer strings remain valid', () => {
  const p = product();
  p.base.pay = '10000'; p.base.count = '3'; p.channels.naver.pay = 0; p.channels.coupang.pay = '10000';
  const html = render(p);
  assert.match(html, /합계 결제금액 10,000원/);
  assert.match(html, /결제금액 0원/);
  assert.ok(!html.includes('확인 필요'));
});

test('missing/wrong channels keep two named notices without falling back to common inflow', () => {
  for (const change of [p => { delete p.channels; }, p => { p.channels = null; }, p => { p.channels = []; },
    p => { p.channels.coupang = null; }, p => { delete p.channels.coupang; }, p => { p.channels.extra = p.channels.coupang; },
    p => { p.channels.coupang.inflow_type = 'unknown'; }, p => { delete p.channels.coupang.inflow_type; }]) {
    const p = product(); change(p);
    const html = render(p);
    assert.match(html, /네이버/); assert.match(html, /쿠팡/);
    assert.match(html, /확인 필요/);
    assert.match(html, /담당자/);
    assert.ok(!html.includes('old.example') && !html.includes('옛 공통 경로'));
    assert.ok(!html.includes('<a '));
  }
});

for (const url of ['', null, '/relative', '//shop.example/p', 'javascript:alert(1)', 'data:text/html,x', 'file:///x',
  'https://user:pass@shop.example/p', 'https://user@shop.example/p', 'https://', 'https://[', 'https://shop.example/\nitem']) {
  test('unsafe/missing link cannot become a button or fall back: ' + String(url), () => {
    const p = product(); p.channels.coupang.url = url;
    const html = render(p);
    assert.ok(!html.includes('<a '));
    assert.match(html, /상품 주소 확인 필요/);
    assert.ok(!html.includes('old.example'));
  });
}

test('guide text is plain text, images are safe HTTP URLs and proxy host is reconstructed', () => {
  const p = product(), token = 'abcdefghijklmnopqrstuvw';
  p.name = '<svg onload=alert(1)>';
  p.channels.naver.guide = { text: '<img src=x onerror=alert(1)>\n<b>검색 & 확인</b>', images: [
    'https://images.example/guide.png?x=" onerror="alert(1)',
    'https://old.example/api/order/guide-image/' + token,
    'https://old.example/api/order/guide-image/' + token,
    'javascript:alert(1)', 'data:image/svg+xml,x', 'file:///x', '//images.example/x',
    'https://user:secret@images.example/private.png', '/relative.png', null,
  ] };
  const html = render(p, { apiBase: 'https://api.example' });
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\n&lt;b&gt;검색 &amp; 확인&lt;\/b&gt;/);
  assert.ok(!/<svg|<b>검색|<img src=x|" onerror="/.test(html));
  assert.match(html, /src="https:\/\/images.example\/guide.png\?x=&quot; onerror=&quot;alert\(1\)"/);
  assert.equal(count(html, 'src="https://api.example/api/order/guide-image/' + token + '"'), 1);
  for (const forbidden of ['javascript:', 'data:image', 'file://', 'secret@', 'old.example', '/relative.png']) assert.ok(!html.includes(forbidden), forbidden);
  assert.match(html, /가이드 사진 확인 필요/);
});

test('guide image URL lines render in document order, once, without promoting other text or mutating input', () => {
  const token = 'abcdefghijklmnopqrstuvw';
  for (const [line, images, expectedSrc] of [
    ['https://images.example/step.png', ['https://images.example/step.png'], 'https://images.example/step.png'],
    ['https://other.example/api/order/guide-image/' + token,
      ['https://old.example/api/order/guide-image/' + token, 'https://third.example/api/order/guide-image/' + token],
      'https://api.example/api/order/guide-image/' + token],
  ]) {
    const p = product();
    p.channels.naver.guide = { text: '사진 전\n' + line + '\n사진 후\nhttps://unlisted.example/plain.png\n<img src=x onerror=alert(1)>', images };
    const original = clone(p), html = render(p, { apiBase: 'https://api.example' });
    const before = html.indexOf('사진 전'), image = html.indexOf('<img '), after = html.indexOf('사진 후');
    assert.ok(before >= 0 && before < image && image < after, 'actual rendered HTML must place image between surrounding instructions');
    assert.equal(count(html, '<img '), 1, 'inline image must not be repeated in trailing list');
    assert.equal(count(html, 'src="' + expectedSrc + '"'), 1);
    assert.ok(!html.includes('\n' + line + '\n'), 'registered URL line is replaced, not retained as text');
    assert.match(html, /사진 후\nhttps:\/\/unlisted.example\/plain.png\n&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.deepEqual(p, original);
  }
});

test('guide URL substitution keeps HTML and control characters plain and unused allowed images trailing', () => {
  const p = product(), image = 'https://images.example/safe.png', attack = 'https://images.example/a?x=" onerror="alert(1)';
  p.channels.naver.guide = { text: '앞\n' + image + '\u0000\n설명 ' + image + '\n' + attack + '\n뒤', images: [image, attack] };
  const original = clone(p), html = render(p);
  assert.match(html, /앞\nhttps:\/\/images.example\/safe.png\u0000\n설명 https:\/\/images.example\/safe.png/);
  assert.ok(!html.includes('" onerror="'));
  assert.equal(count(html, '<img '), 2);
  assert.ok(html.indexOf('앞') < html.indexOf('<img ') && html.indexOf('<img ') < html.indexOf('뒤'));
  assert.ok(html.lastIndexOf('<img ') > html.indexOf('뒤'), 'unused allowlisted image remains trailing');
  assert.deepEqual(p, original);
});

test('bare carriage-return cannot split a control-containing URL into an inline image', () => {
  const p = product(), image = 'https://images.example/safe.png';
  p.channels.naver.guide = { text: '앞\n' + image + '\r금지\n뒤', images: [image] };
  const html = render(p);
  assert.ok(html.includes(image + '\r금지'));
  assert.ok(html.indexOf('<img ') > html.indexOf('뒤'));
  p.channels.naver.guide.text = '앞\r\n' + image + '\r\n뒤';
  const crlf = render(p);
  assert.ok(crlf.indexOf('앞') < crlf.indexOf('<img ') && crlf.indexOf('<img ') < crlf.indexOf('뒤'));
});

test('image-only guide is retained; broken guides are visible as unknown without old guide fallback', () => {
  const p = product(); p.channels.naver.guide = { text: '', images: ['http://images.example/only.png'] };
  assert.match(render(p), /src="http:\/\/images.example\/only.png"/);
  for (const guide of [null, {}, [], { text: {}, images: [] }, { text: '', images: [] }, { text: '', images: 'bad' }, { text: '', images: ['javascript:x'] }]) {
    const x = product(); x.channels.naver.guide = guide;
    const html = render(x);
    assert.match(html, /가이드.*확인 필요/);
    assert.match(html, /담당자/);
    assert.ok(!html.includes('옛 공통 경로'));
  }
});

test('unapproved product/type combinations show a notice, never purchasing navigation', () => {
  for (const change of [p => { p.product_mode = 'options'; }, p => { p.options = [{ name: '미지원 옵션' }]; },
    p => { p.qty_tiers = []; }]) {
    const p = product(); change(p);
    const html = render(p);
    assert.match(html, /준비 중|확인 필요/); assert.ok(!html.includes('<a '));
  }
  for (const [o, extra] of [[{ showProduct: false }, {}], [{ showInflow: false }, {}], [{}, { type: 'blog' }], [{}, { type: 'qna' }]]) {
    const html = render(product(), o, extra);
    assert.match(html, /동시진행/); assert.match(html, /준비 중|확인 필요/);
    assert.ok(!html.includes('<a ') && !html.includes('네이버에서 검색'));
  }
});

test('showLanding=false hides only purchasing navigation, not guide instructions or payments', () => {
  const html = render(product(), { showLanding: false });
  assert.ok(!html.includes('<a '));
  assert.match(html, /네이버에서 검색/);
  assert.match(html, /결제금액 10,000원/);
});
