'use strict';
// 정책 확정(2026-11-06 · 결정 341): 동시진행 리뷰어 화면의 품절·취소·같은 받는 사람 안내.
// 안내는 동시진행 카드와 동시진행 구매양식에만 나오고, 일반 공고 카드에는 한 글자도 나오지 않는다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '../../frontend/js');
const M = vm.runInNewContext(fs.readFileSync(path.join(root, 'campaign-workdetail.js'), 'utf8') + ';window.CampWorkDetail', { window: {}, URL });

const SOLD_OUT = '한 곳이라도 품절이면 진행할 수 없어요.';
const CANCELLED = '구매 후 한 곳 주문이 취소되면 진행이 중단되고 리뷰비는 지급되지 않아요';
const CONTACT = '리뷰 내역 → 1:1 문의로 담당자에게 알려 주세요.';
const SAME = '두 곳의 아이디는 달라도 되지만 받는 사람·연락처·배송 주소는 같아야 해요.';
const ALL = [SOLD_OUT, CANCELLED, CONTACT, SAME];
const count = (html, text) => html.split(text).length - 1;

const product = () => ({
  name: '동시진행 수건', base: { pay: 19000, count: 3 }, options: [], product_mode: 'none',
  channels: {
    naver: { url: 'https://naver.example/item', pay: 9000, inflow_type: 'guide', guide: { text: '네이버에서 검색', images: [] } },
    coupang: { url: 'https://coupang.example/item', pay: 10000, inflow_type: 'link', guide: { text: '', images: [] } },
  },
});

test('동시진행 카드: 품절·취소·같은 받는 사람 안내가 기존 동시진행 안내 줄 바로 뒤에 한 번씩', () => {
  const html = M.cardsHtml({ workDetail: { dualChannelProduct: product() } }, { apiBase: '' });
  for (const t of ALL) assert.equal(count(html, t), 1, t);
  // 참여 전(공고 미리보기)과 참여 후 모두 맞는 말 — 취소 버튼 이름은 campaign.html 의 실제 버튼과 같다.
  assert.match(html, /구매하지 말고, 이미 참여했다면 \[참여 취소\]를 눌러 주세요\./);
  const note = html.match(/<div class="cwd-note">([^]*?)<\/div>/);
  assert.ok(note, '동시진행 안내 줄');
  assert.ok(note[1].startsWith('네이버·쿠팡 동시진행 — 두 구매처 모두 진행해야 해요.'));
  for (const t of ALL) assert.ok(note[1].includes(t), '같은 안내 줄 안: ' + t);
  // 설정이 덜 된 동시진행도 같은 안내(구매 전 문의 안내와 함께)
  const broken = product(); broken.channels.naver.pay = null;
  const brokenHtml = M.cardsHtml({ workDetail: { dualChannelProduct: broken } }, {});
  for (const t of ALL) assert.equal(count(brokenHtml, t), 1, t);
});

test('일반 공고 카드에는 안내가 없다(옵션·수량·링크·가이드·현영 포함)', () => {
  const legacy = [
    { workDetail: {} },
    { workDetail: { productLines: '단일상품 - 결제금액 12,000원', inflowGuideHtml: '<b>검색</b>', reviewGuide: '사진 한 장', specialNotes: '주의' }, inflowType: 'guide', landingUrl: 'https://legacy.example/p' },
    { workDetail: { productLines: '옵션상품' }, selectedOption: { optKey: '선택 A', optionUrl: 'https://legacy.example/a', inflowType: 'link', payAmount: 9000 } },
    { workDetail: { productLines: '수량상품' }, qty: { purchaseQty: 3, amount: 30000 }, landingUrl: 'https://legacy.example/q', inflowType: 'link' },
    { workDetail: { productLines: '현영상품' }, cashReceipt: { required: true } },
  ];
  for (const d of legacy) for (const o of [{}, { showOption: false, apiBase: '' }]) {
    const html = M.cardsHtml(d, o);
    for (const t of [...ALL, '품절이면', '참여 취소']) assert.ok(!html.includes(t), t);
  }
});

function mountForm() {
  const stub = () => ({ textContent: '', hidden: false, style: {}, querySelector: stub, querySelectorAll: () => [], appendChild() {} });
  const host = { innerHTML: '', querySelector: () => stub(), querySelectorAll: () => [], appendChild() {} };
  const ctx = { window: undefined, structuredClone, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: () => stub() }, fetch: () => { throw Error('no network'); } };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'dual-channel-purchase.js'), 'utf8'), ctx);
  ctx.DualChannelPurchase.mount(host, { workDetail: { dualChannelProduct: product() }, dualPurchaseDraft: null },
    { campaignId: 'c', campaignApplicationId: 1, campaignHoldToken: 'h' }, async () => ({}), null, {});
  return host.innerHTML;
}

test('동시진행 구매양식: 입력칸 위에 같은 안내(취소 버튼은 공고 화면에 있다고 안내)', () => {
  const html = mountForm();
  for (const t of ALL) assert.equal(count(html, t), 1, t);
  assert.match(html, /구매하지 말고 공고 화면의 \[참여 취소\]를 눌러 주세요\./);
  const first = html.indexOf('<section');
  for (const t of ALL) assert.ok(html.indexOf(t) >= 0 && html.indexOf(t) < first, '첫 구매 입력보다 위: ' + t);
});
