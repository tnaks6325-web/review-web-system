'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
const { projectOrderToCampaign, readCampaignShared, compareOrderCampaign } = require('../src/utils/orderToCampaignProjection');

function product() {
  return { option_schema_version: 2, product_mode: 'none', name: '로컬 시험 상품',
    url: 'https://shop.example/naver', base: { pay: 19000, count: 3, daily: 1 }, options: [],
    channels: {
      naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'link', guide: { text: '', images: [] } },
      coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'guide', guide: { text: '검색창에서 시험 상품을 찾으세요.', images: ['https://img.example/guide.png'] } },
    } };
}
function order(p = product()) {
  return { product_options_json: JSON.stringify([p]), recruit_count: 3, daily_count: 1,
    pay_amount: 57000, purchase_channel: '네이버+쿠팡', inflow_type: 'guide', skip_weekends: false };
}
function campaign(p = product()) {
  const o = order(p), pref = _woCampaignPrefill(o);
  return { ...pref, skip_weekends: false,
    work_detail: { inflowType: 'guide', productLines: pref.wd_product, dualChannelProduct: p } };
}
function dualDiff(o, c) {
  return compareOrderCampaign(o, c, []).filter(d => d.field === 'dual_channel_product');
}

test('발행 프리필은 상품 하나와 두 구매처 설정을 빠짐없이 전달한다', () => {
  const p = product(), o = order(p);
  const pref = _woCampaignPrefill(o);
  assert.deepEqual(pref.dualChannelProduct, p);
  assert.equal(pref.recruit_total, 3);
  assert.equal(pref.options.length, 1, '구매처 두 개를 선택지 두 개로 복제하지 않는다');
  assert.equal(pref.options[0].payAmount, 19000);
  assert.equal(o.product_options_json, JSON.stringify([p]));
});

test('오더와 공고 비교는 선택지 원장이 없어도 구매처 설정을 본다', () => {
  const p = product();
  assert.deepEqual(projectOrderToCampaign(order()).dual_channel_product, p);
  assert.deepEqual(readCampaignShared(campaign(), []).dual_channel_product, p);
  assert.deepEqual(dualDiff(order(), campaign()), []);
});

test('구매처 금액만 서로 맞바꿔 합계가 같아도 차이를 숨기지 않는다', () => {
  const p = product(); p.channels.naver.pay = 10000; p.channels.coupang.pay = 9000;
  const diffs = dualDiff(order(), campaign(p));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'diff');
});

test('구매처별 주소·유입방식·가이드 글·가이드 사진을 각각 비교한다', () => {
  const changes = [
    p => { p.channels.naver.url = 'https://shop.example/changed'; },
    p => { p.channels.coupang.inflow_type = 'link'; },
    p => { p.channels.coupang.guide.text = '다른 안내'; },
    p => { p.channels.coupang.guide.images = ['https://img.example/other.png']; },
  ];
  for (const change of changes) {
    const p = product(); change(p);
    assert.equal(dualDiff(order(), campaign(p)).length, 1);
  }
});

test('한쪽에만 설정이 있으면 단순 채우기가 아니라 연결을 막는 차이다', () => {
  const plain = product(); delete plain.channels;
  const plainOrder = order(plain), plainCampaign = campaign(); delete plainCampaign.work_detail.dualChannelProduct;
  const a = dualDiff(order(), plainCampaign), b = dualDiff(plainOrder, campaign());
  assert.equal(a.length, 1); assert.equal(a[0].kind, 'diff');
  assert.equal(b.length, 1); assert.equal(b[0].kind, 'diff');
});

test('옛 상품에는 새 키를 만들지 않고 옛 비교 결과를 유지한다', () => {
  const p = product(); delete p.channels;
  const o = order(p), c = campaign(p); delete c.work_detail.dualChannelProduct;
  assert.equal(Object.hasOwn(_woCampaignPrefill(o), 'dualChannelProduct'), false);
  assert.equal(Object.hasOwn(projectOrderToCampaign(o), 'dual_channel_product'), false);
  assert.equal(Object.hasOwn(readCampaignShared(c, []), 'dual_channel_product'), false);
  assert.deepEqual(dualDiff(o, c), []);
});

test('공고 JSON 문자열도 읽고 반환값을 고쳐도 저장본·원문은 변하지 않는다', () => {
  const c = campaign(); c.work_detail = JSON.stringify(c.work_detail);
  const original = c.work_detail;
  const read = readCampaignShared(c, []);
  read.dual_channel_product.channels.naver.pay = 1;
  assert.equal(c.work_detail, original);
  const p = product(), o = order(p), result = _woCampaignPrefill(o);
  result.dualChannelProduct.channels.naver.pay = 1;
  assert.deepEqual(JSON.parse(o.product_options_json), [p]);
});

test('상품 이름이 시스템마다 달라도 같은 구매처 조건은 차이로 세지 않는다', () => {
  const p = product(); p.name = '리뷰웹에서 쓰는 별도 이름';
  assert.deepEqual(dualDiff(order(), campaign(p)), []);
});

test('명시한 동시진행 설정이 깨져 있으면 누락으로 꾸미지 않는다', () => {
  for (const value of [null, {}, [], { ...product(), channels: null }]) {
    const c = campaign(); c.work_detail.dualChannelProduct = value;
    assert.throws(() => readCampaignShared(c, []));
  }
});

test('전체 인원이 같아도 상품 안의 사람 수가 다르면 차이로 알린다', () => {
  const c = campaign();
  c.work_detail.dualChannelProduct.base.count = 99;
  const before = JSON.stringify(c);
  assert.equal(c.recruit_total, 3);
  const diffs = dualDiff(order(), c);
  assert.equal(diffs.length, 1, '선택지 원장이 없어도 내부 사람 수 차이를 놓치지 않는다');
  assert.equal(diffs[0].kind, 'diff');
  assert.equal(JSON.stringify(c), before);
});

test('전체 일건수가 같아도 상품 안의 일건수 차이를 알린다', () => {
  const c = campaign();
  c.work_detail.dualChannelProduct.base.daily = 2;
  assert.equal(c.daily_limit, 1);
  assert.equal(dualDiff(order(), c).length, 1);
});

test('상품 내부 일건수 미지정과 명시한 0은 같은 뜻으로 비교한다', () => {
  const p = product(); p.base.daily = 0;
  const c = campaign(p); delete c.work_detail.dualChannelProduct.base.daily;
  assert.deepEqual(dualDiff(order(p), c), []);
});
