'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planCampaignMoneyEdit, planCampaignSharedEdit } = require('../src/utils/campaignSharedEdit');
const { normalizeDualChannelProduct } = require('../src/utils/dualChannel');
const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');

function product() {
  return { name: '시험 상품', url: 'https://shop.example/item', option_schema_version: 2,
    product_mode: 'none', options: [], base: { pay: 19000, count: 3, daily: 1 },
    guide: { text: '기존 상품 공통 안내', images: [] },
    channels: {
      naver: { url: 'https://shop.example/naver', pay: 9000, inflow_type: 'link', guide: { text: '', images: [] } },
      coupang: { url: 'https://shop.example/coupang', pay: 10000, inflow_type: 'guide',
        guide: { text: '시험 상품을 검색하세요.', images: ['https://img.example/guide.png'] } },
    } };
}
function input(sent = product(), base = product(), body = {}) {
  return { baseState: { product_options_json: JSON.stringify([base]), recruit_count: 3,
    daily_count: 1, review_fee: 1000, inflow_type: 'guide' },
  camp: { work_detail: { dualChannelProduct: product(), productLines: '시험 상품 / 결제금액 19,000원' } },
  body: { ...body, work_detail: { ...body.work_detail, dualChannelProduct: sent } } };
}

test('구매처 금액과 상품 기본 합계를 한 상품 계획으로 함께 되돌린다', () => {
  const next = product(); next.channels.naver.pay = 11000; next.base.pay = 21000;
  const args = input(next), original = JSON.stringify(args);
  const plan = planCampaignMoneyEdit(args);
  assert.deepEqual(plan.unmappable, []);
  assert.ok(plan.mine.product_options_json, '구매처 설정을 무시하지 않고 상품 변경을 계획한다');
  assert.deepEqual(JSON.parse(plan.mine.product_options_json), [next]);
  assert.equal(plan.mine.pay_amount, undefined, '오더 전체 결제합계는 별도 공유 저장 단계가 계산한다');
  assert.equal(JSON.stringify(args), original, '계획은 입력과 기준 원문을 바꾸지 않는다');
});

test('상품이 하나여도 이름·주소 근거가 없는 다른 상품을 같은 상품으로 추측하지 않는다', () => {
  const next = product(); next.name = '전혀 다른 물건'; next.url = 'https://shop.example/other';
  next.channels.naver.pay = 11000; next.base.pay = 21000;
  const plan = planCampaignMoneyEdit(input(next, product(), { review_fee: 1500 }));
  assert.ok(plan.unmappable.length > 0);
  assert.deepEqual(plan.mine, {}, '다른 리뷰비 변경도 부분 계획으로 남기지 않는다');
});

test('포함되는 이름 또는 비어 있지 않은 같은 주소로 짝지어도 기준 상품명은 덮지 않는다', () => {
  for (const sameUrl of [false, true]) {
    const next = product(); next.name = sameUrl ? '리뷰웹 별도 이름' : '1번 시험 상품';
    if (!sameUrl) next.url = 'https://shop.example/new-main';
    next.channels.coupang.guide.text = '구매처 새 안내';
    const plan = planCampaignMoneyEdit(input(next));
    assert.deepEqual(plan.unmappable, []);
    const saved = JSON.parse(plan.mine.product_options_json)[0];
    assert.equal(saved.name, product().name);
    assert.equal(saved.url, product().url, '구매처 설정이 상품 메인 주소까지 몰래 바꾸지 않는다');
    assert.deepEqual(saved.guide, product().guide, '기존 상품 가이드와 구매처 가이드는 별개');
  }
});

test('구매처 설정과 함께 일반 옵션·새 상품을 더하는 구조 변경은 통째로 거부한다', () => {
  const next = product(); next.channels.naver.guide.text = '새 구매처 안내';
  const args = input(next, product(), { review_fee: 1500, options: [
    { unitKind: 'product', productName: '시험 상품', optKey: '시험 상품', payAmount: 19000, recruitTotal: 3 },
    { unitKind: 'product', productName: '추가 상품', optKey: '추가 상품', payAmount: 1000, recruitTotal: 1 },
  ] });
  const plan = planCampaignMoneyEdit(args);
  assert.ok(plan.unmappable.length > 0);
  assert.deepEqual(plan.mine, {});
});

test('구매처 상품의 사람 수·일건수는 기존 모집 계획과 함께 계산한다', () => {
  const next = product(); next.base.count = 5; next.base.daily = 2;
  next.channels.naver.pay = 11000; next.base.pay = 21000;
  const plan = planCampaignMoneyEdit(input(next, product(), { review_fee: 1500 }));
  assert.deepEqual(plan.unmappable, []);
  assert.deepEqual(JSON.parse(plan.mine.product_options_json), [next]);
  assert.equal(plan.mine.recruit_count, 5, '구매처 수를 곱하지 않은 사람 수');
  assert.equal(plan.mine.daily_count, 2);
  assert.equal(plan.mine.review_fee, 1500, '리뷰비는 한 사람 몫 한 번만');
});

test('옛 화면이 합계 문장만 바꿔 두 구매처 합계를 깨뜨리면 다른 변경도 거부한다', () => {
  const args = input();
  args.body = { review_fee: 1500, work_detail: { productLines: '시험 상품 / 결제금액 21,000원' } };
  const plan = planCampaignMoneyEdit(args);
  assert.ok(plan.unmappable.length > 0);
  assert.deepEqual(plan.mine, {}, '합계만 고치고 채널별 금액은 남기는 계획 금지');
});

test('기존 모집 계획이 거부되면 구매처 설정·리뷰비도 부분 계획으로 남기지 않는다', () => {
  const next = product(); next.channels.naver.guide.text = '새 안내';
  const args = input(next, product(), { review_fee: 1500, review_type_mix: [{ type: 'photo', quantity: 3 }] });
  // 선택지 구조를 모르는 인원 변경은 기존 검사에서도 거부되는 입력이다.
  args.body.options = [{ unitKind: 'product', productName: '시험 상품', optKey: '시험 상품',
    payAmount: 19000, recruitTotal: 3, dailyLimit: 2 }];
  args.body.daily_limit = 1;
  args.campOptions = [{ unit_kind: 'product', product_name: '시험 상품', opt_key: '시험 상품',
    status: 'active', pay_amount: 19000, recruit_total: 3, daily_limit: 1 }];
  const plan = planCampaignMoneyEdit(args);
  assert.ok(plan.unmappable.length > 0);
  assert.deepEqual(plan.mine, {});
});

test('일건수를 0으로 바꾸면 상품 기본값과 오더 일건수가 함께 0이 된다', () => {
  const next = product(); next.base.daily = 0;
  const plan = planCampaignMoneyEdit(input(next));
  assert.deepEqual(plan.unmappable, []);
  assert.equal(JSON.parse(plan.mine.product_options_json)[0].base.daily, 0);
  assert.equal(plan.mine.daily_count, 0);
});

test('상품 기본 혼합 수량도 기존 모집 계산에 보내 구매처 변경과 함께 보존한다', () => {
  const next = product(); next.base.review_type_mix = [{ type: 'photo', quantity: 3 }];
  next.channels.naver.guide.text = '구매처 새 안내';
  const plan = planCampaignMoneyEdit(input(next));
  assert.deepEqual(plan.unmappable, []);
  assert.deepEqual(JSON.parse(plan.mine.product_options_json)[0].base.review_type_mix, next.base.review_type_mix);
  assert.deepEqual(JSON.parse(plan.mine.review_type_mix), next.base.review_type_mix);
});

test('선택지 원장이 없어도 명시한 상품 한 줄의 기존 가이드·주소와 구매처 설정을 따로 계획한다', () => {
  const next = product(); next.base.count = 5; next.base.daily = 2;
  next.channels.naver.pay = 11000; next.base.pay = 21000;
  const plan = planCampaignMoneyEdit(input(next, product(), { options: [{ unitKind: 'product',
    productName: next.name, optKey: next.name, payAmount: 21000, recruitTotal: 5,
    productUrl: 'https://shop.example/parent-new', optionUrl: 'https://shop.example/parent-new',
    inflowGuideHtml: '상품 공통 새 안내', inflowGuideImages: [],
  }] }));
  assert.deepEqual(plan.unmappable, []);
  const saved = JSON.parse(plan.mine.product_options_json)[0];
  assert.equal(saved.base.daily, 2, '줄의 일건수가 미전송이면 구매처 상품 기본값을 쓴다');
  assert.equal(saved.url, 'https://shop.example/parent-new');
  assert.equal(saved.guide.text, '상품 공통 새 안내');
  assert.deepEqual(saved.channels, next.channels, '공통 안내가 구매처 가이드를 덮지 않는다');
});

test('검증 실패는 누락으로 꾸미지 않고 리뷰비까지 쓰기 0으로 돌려준다', () => {
  const mutations = [
    () => null, () => ({}), () => [], () => undefined,
    p => { delete p.channels; return p; },
    p => { delete p.channels.coupang; return p; },
    p => { p.channels.naver = null; return p; },
    p => { p.channels = {}; return p; },
    p => { p.base.pay = 1; return p; },
    p => { p.base.count = 0; return p; },
    p => { p.channels.naver.pay = false; return p; },
    p => { p.channels.naver.url = 'javascript:alert(1)'; return p; },
    p => { p.channels.coupang.guide = { text: '', images: [] }; return p; },
    p => { p.product_mode = 'opt'; p.options = [{ label: 'A' }]; return p; },
    p => { p.qty_tiers = []; return p; },
    p => { p.closed = true; return p; },
  ];
  for (const mutate of mutations) {
    const args = input(mutate(product()), product(), { review_fee: 1500 });
    // 기본 인자가 undefined를 정상 상품으로 바꾸지 않도록 own undefined는 따로 둔다.
    if (mutate === mutations[3]) args.body.work_detail.dualChannelProduct = undefined;
    const plan = planCampaignMoneyEdit(args);
    assert.ok(plan.unmappable.length > 0, String(mutate));
    assert.deepEqual(plan.mine, {});
  }
});

test('기존 일반 상품을 동시진행으로 바꾸거나 다상품·옵션 기준을 추측하지 않는다', () => {
  const plain = product(); delete plain.channels;
  for (const baseProducts of [[plain], [product(), product()], [{ ...product(), product_mode: 'opt', options: [{ label: 'A' }] }]]) {
    const args = input(product(), product(), { review_fee: 1500 });
    args.baseState.product_options_json = JSON.stringify(baseProducts);
    const plan = planCampaignMoneyEdit(args);
    assert.ok(plan.unmappable.length > 0);
    assert.deepEqual(plan.mine, {});
  }
});

test('미전송·상속 키·같은 설정은 새 상품 쓰기 0이며 원문을 정규화해서 다시 쓰지 않는다', () => {
  const p = product(); p.base.pay = '19000'; p.channels.naver.pay = '9000';
  for (const wd of [{}, Object.create({ dualChannelProduct: null }), { dualChannelProduct: product() }]) {
    const args = input(product(), p); args.body = { work_detail: wd };
    const before = args.baseState.product_options_json;
    const plan = planCampaignMoneyEdit(args);
    assert.deepEqual(plan.mine, {});
    assert.deepEqual(plan.changed, []);
    assert.deepEqual(plan.unmappable, []);
    assert.equal(args.baseState.product_options_json, before);
  }
});

test('합계가 같은 구매처 금액 교환과 주소·유입·글·사진 변경도 빠뜨리지 않고 왕복한다', () => {
  const changes = [
    p => { p.channels.naver.pay = 10000; p.channels.coupang.pay = 9000; },
    p => { p.channels.naver.url = 'https://shop.example/new'; },
    p => { p.channels.coupang.inflow_type = 'link'; },
    p => { p.channels.coupang.guide.text = '새 검색 안내'; },
    p => { p.channels.coupang.guide.images = ['https://img.example/new.png']; },
  ];
  for (const change of changes) {
    const next = product(); change(next);
    const args = input(next, product(), { work_detail: { productLines: '합계 문장에 다른 금액 999원' } });
    const plan = planCampaignMoneyEdit(args);
    assert.deepEqual(plan.unmappable, []);
    assert.deepEqual(projectOrderToCampaign({ ...args.baseState, ...plan.mine }).dual_channel_product.channels,
      normalizeDualChannelProduct(next).channels);
  }
});

test('리뷰가이드 글 계획과 합쳐도 구매처 설정·리뷰비 계획은 서로 덮지 않는다', () => {
  const next = product(); next.channels.coupang.guide.text = '구매처 새 안내';
  const args = input(next, product(), { review_fee: 1500, work_detail: { reviewGuide: '리뷰 작성 새 안내' } });
  const text = planCampaignSharedEdit(args), money = planCampaignMoneyEdit(args);
  assert.deepEqual([...text.unmappable, ...money.unmappable], []);
  const combined = { ...text.mine, ...money.mine };
  assert.equal(combined.review_guide, '리뷰 작성 새 안내');
  assert.equal(combined.review_fee, 1500);
  assert.deepEqual(JSON.parse(combined.product_options_json)[0].channels, next.channels);
});

test('한 상품 줄에 숨긴 이름 변경과 무관한 기존 원장은 같은 단위로 합치지 않는다', () => {
  const next = product(); next.channels.naver.guide.text = '새 안내';
  const row = { unitKind: 'product', productName: next.name, optKey: next.name, payAmount: 19000, recruitTotal: 3 };
  const cases = [
    { options: [{ ...row, optKey: '다른 상품', prevOptKey: next.name }] },
    { options: [row], campOptions: [{ unit_kind: 'product', product_name: '별개 물건', opt_key: '별개 물건', status: 'active' }] },
    { options: [{ ...row, reviewTypeMix: [{ type: 'text', quantity: 3 }] }],
      mix: [{ type: 'photo', quantity: 3 }] },
  ];
  for (const c of cases) {
    const p = structuredClone(next); if (c.mix) p.base.review_type_mix = c.mix;
    const args = input(p, product(), { review_fee: 1500, options: c.options }); args.campOptions = c.campOptions || [];
    const plan = planCampaignMoneyEdit(args);
    assert.ok(plan.unmappable.length > 0);
    assert.deepEqual(plan.mine, {});
  }
});

test('기존 상품 원장이 있는 같은 값 재저장은 쓰기 0이다', () => {
  const args = input(product(), product(), { options: [{ unitKind: 'product', productName: '시험 상품', optKey: '시험 상품',
    payAmount: 19000, recruitTotal: 3, dailyLimit: 1 }] });
  args.campOptions = [{ unit_kind: 'product', product_name: '시험 상품', opt_key: '시험 상품',
    pay_amount: 19000, recruit_total: 3, daily_limit: 1, status: 'active' }];
  const plan = planCampaignMoneyEdit(args);
  assert.deepEqual(plan.unmappable, []);
  assert.deepEqual(plan.mine, {});
  assert.deepEqual(plan.changed, []);
});