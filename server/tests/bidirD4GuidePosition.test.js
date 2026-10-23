/**
 * 결정 278(D4 「나」 · 사용자 확정 2026-10-22) — 선택지 유입가이드의 사진 자리.
 *   사진 자리 = 오더 글 속 **사진 주소 한 줄**(새 저장 칸 없음). 맨 끝 사진은 자리 표시 없이 목록에만.
 *   ① 비교 규칙이 사진 자리를 본다 · 맨 끝 사진은 옛 모양과 열쇠가 같다(기존 비교 결과 불변)
 *   ② 오더 글 → 공고 HTML → 오더 글 왕복이 글자 그대로
 *   ③ 공고 창에서 사진을 글 중간으로 옮기면 오더 글에 주소 줄이 생긴다 · 옮기지 않은 저장은 쓰기 0
 *   ④ 옛 화면이 주소 줄을 지우면 사진은 맨 끝으로(사라지지 않음)
 */
const assert = require('assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const G = require('../src/utils/guideCanon');
const compose = require('../src/utils/inflowGuideCompose');
const E = require('../src/utils/campaignSharedEdit');
const { projectOrderToCampaign } = require('../src/utils/orderToCampaignProjection');

const IMG = n => `https://x.up.railway.app/api/order/guide-image/FAKEguideImageId0000000${n}`;
const tag = u => `<img src="${u}" alt="유입가이드 이미지">`;

// ── ① 비교 규칙 ──
{
  // 옛 모양(사진은 모두 글 뒤) = 예전 열쇠 그대로 — 운영 데이터의 비교 결과가 바뀌지 않는다
  const legacy = [
    ['검색창에 &quot;블랙&quot;<br>두 번째 줄' + tag(IMG(1)), [IMG(1)]],
    ['글만', []],
    ['', [IMG(1), IMG(2)]],
    ['<p>첫 줄</p><p>둘째 줄</p>' + tag(IMG(2)), [IMG(1)]],
  ];
  for (const [h, l] of legacy) {
    const g = G.canonGuide(h, l);
    assert.equal(G.canonGuideKey(h, l), (!g.view && !g.images.length) ? '' : JSON.stringify([G.guideHtmlText(h), g.images.map(G.imageKey)]), '옛 모양 열쇠 불변: ' + h);
    assert.equal(g.text, G.guideHtmlText(h), '옛 모양은 오더 글에 주소 줄이 생기지 않는다: ' + h);
  }
  // 글 뒤 사진(HTML) = 글 + 목록 사진
  assert.equal(G.canonGuideKey('가<br>나' + tag(IMG(1)), []), G.canonGuideKey('가<br>나', [IMG(1)]));
  // 자리가 다르면 다른 가이드
  assert.notEqual(G.canonGuideKey('가' + tag(IMG(1)) + '나', [IMG(1)]), G.canonGuideKey('가<br>나', [IMG(1)]));
  assert.notEqual(G.canonGuideKey(tag(IMG(1)) + '가<br>나', []), G.canonGuideKey('가' + tag(IMG(1)) + '나', []));
  // 두 사진 순서가 바뀌면 다름
  assert.notEqual(G.canonGuideKey('가' + tag(IMG(1)) + '나' + tag(IMG(2)) + '다', []), G.canonGuideKey('가' + tag(IMG(2)) + '나' + tag(IMG(1)) + '다', []));
  // 같은 파일(호스트만 다름) = 같음 — 자리 표시도 주소가 아니라 번호
  assert.equal(G.canonGuideKey('가' + tag(IMG(1)) + '나', []), G.canonGuideKey('가' + tag(IMG(1).replace('https://x.up', 'http://y.up')) + '나', []));
  const v = G.canonGuide('가' + tag(IMG(1)) + '나' + tag(IMG(2)), []);
  assert.equal(v.view, '가\n⟦사진 1⟧\n나', '비교용 글: 주소 대신 번호 · 맨 끝 사진은 표시 없음');
  assert.deepEqual(v.images, [IMG(1), IMG(2)]);
  // 같은 사진이 HTML 과 목록에 = 한 번 · 앞 자리가 이긴다
  assert.deepEqual(G.canonGuide('가' + tag(IMG(1)) + '나', [IMG(1)]).images, [IMG(1)]);
}

// ── ② 오더 글 → 공고 HTML → 오더 글 왕복 ──
{
  const cases = [
    { text: '1) 검색하세요.\n' + IMG(1) + '\n2) 세 번째 상품\n3) 구매하기', images: [IMG(1), IMG(2)] },
    { text: IMG(2) + '\n맨 위 사진 다음 글', images: [IMG(2)] },
    { text: '가\n' + IMG(1) + '\n' + IMG(2) + '\n나', images: [IMG(1), IMG(2)] },   // 두 사진이 붙어 있음
    { text: '글만', images: [IMG(1)] },
  ];
  for (const g of cases) {
    const c = compose.composeUnitGuide({ guide: g });
    const back = G.canonGuide(c.html, c.images);
    assert.equal(back.text, g.text, '왕복 글 그대로: ' + JSON.stringify(g));
    assert.deepEqual(back.images, g.images, '왕복 사진 그대로');
  }
  // 오더 투영 비교: 오더(주소 줄) ↔ 공고 창 저장(자리 <img> + 끝 <img>) = 같다
  const products = [{ name: '샴푸', url: 'https://www.coupang.com/vp/products/1', option_schema_version: 2, product_mode: 'opt',
    base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
    options: [{ option_1: { name: '', value: '500ml' }, label: '500ml', url: 'https://www.coupang.com/vp/products/1', pay: 9000, count: 3, daily: 1, review_type_mix: [],
      guide: cases[0] }] }];
  const proj = projectOrderToCampaign({ product_options_json: JSON.stringify(products) });
  const o = proj.options[0];
  const camp = { optKey: '500ml', productName: '샴푸', unitKind: 'option', optionUrl: o.option_url, payAmount: 9000, recruitTotal: 3, dailyLimit: 1,
    inflowGuideHtml: '1) 검색하세요.' + tag(IMG(1)) + '2) 세 번째 상품<br>3) 구매하기' + tag(IMG(2)), inflowGuideImages: [IMG(1), IMG(2)] };
  const camp2 = { ...camp, inflowGuideHtml: '1) 검색하세요.<br>2) 세 번째 상품<br>3) 구매하기' + tag(IMG(1)) + tag(IMG(2)) };
  const { optionShape } = require('../src/utils/orderToCampaignProjection');
  assert.equal(optionShape(camp).inflow_guide_html, o.inflow_guide_html, '자리 같음 = 같은 값');
  assert.equal(optionShape(camp).inflow_guide_images, o.inflow_guide_images);
  assert.notEqual(optionShape(camp2).inflow_guide_html, o.inflow_guide_html, '사진을 끝으로 옮김 = 다름');
  assert.equal(o.inflow_guide_html, '1) 검색하세요.\n\u27e6사진 1\u27e7\n2) 세 번째 상품\n3) 구매하기');
}

// ── ③ 공고 창 저장 → 오더 ──
{
  const guide0 = { text: '1) 검색하세요.\n2) 세 번째 상품', images: [IMG(1)] };
  const products = [{ name: '샴푸', url: 'https://www.coupang.com/vp/products/1', option_schema_version: 2, product_mode: 'opt',
    base: { pay: 0, count: 0, daily: 0, review_type_mix: [] },
    options: [{ option_1: { name: '', value: '500ml' }, label: '500ml', url: 'https://www.coupang.com/vp/products/1', pay: 9000, count: 3, daily: 1, review_type_mix: [], guide: guide0 }] }];
  const base = { product_options_json: JSON.stringify(products), inflow_type: 'guide' };
  const campOptions = [{ opt_key: '500ml', product_name: '샴푸', unit_kind: 'option', pay_amount: 9000 }];
  const opt = (html, imgs) => ({ optKey: '500ml', productName: '샴푸', unitKind: 'option', payAmount: 9000, inflowGuideHtml: html, inflowGuideImages: imgs });
  // 손대지 않음(창 저장 모양 = 글 + 끝 <img>) → 쓰기 0
  let p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: [opt('1) 검색하세요.<br>2) 세 번째 상품' + tag(IMG(1)), [IMG(1)])], work_detail: { inflowType: 'guide' } }, campOptions });
  assert.deepEqual(p.mine, {}); assert.deepEqual(p.unmappable, []);
  // 사진을 첫 줄 뒤로 옮김 → 오더 글에 주소 줄
  p = E.planCampaignMoneyEdit({ baseState: base, camp: {}, body: { options: [opt('1) 검색하세요.<br>' + tag(IMG(1)) + '<br>2) 세 번째 상품', [IMG(1)])], work_detail: { inflowType: 'guide' } }, campOptions });
  assert.deepEqual(p.unmappable, []);
  assert.deepEqual(JSON.parse(p.mine.product_options_json)[0].options[0].guide, { text: '1) 검색하세요.\n' + IMG(1) + '\n2) 세 번째 상품', images: [IMG(1)] });
  // 그 오더를 다시 열어(투영) 손대지 않고 저장 → 쓰기 0
  const moved = JSON.parse(p.mine.product_options_json);
  const base2 = { product_options_json: JSON.stringify(moved), inflow_type: 'guide' };
  const c2 = compose.composeUnitGuide(moved[0].options[0]);
  p = E.planCampaignMoneyEdit({ baseState: base2, camp: {}, body: { options: [opt(c2.html, c2.images)], work_detail: { inflowType: 'guide' } }, campOptions });
  assert.deepEqual(p.mine, {}, '자리 든 가이드를 손대지 않은 저장 = 쓰기 0');

  // ── ④ 옛 화면이 주소 줄을 지움 → 사진은 맨 끝(목록) — 사라지지 않는다 ──
  const oldScreen = { text: '1) 검색하세요.\n2) 세 번째 상품', images: moved[0].options[0].guide.images };
  const c3 = compose.composeUnitGuide({ guide: oldScreen });
  const g3 = G.canonGuide(c3.html, c3.images);
  assert.deepEqual(g3.images, [IMG(1)]);
  assert.equal(g3.text, '1) 검색하세요.\n2) 세 번째 상품');
}

console.log('bidirD4GuidePosition: passed');
