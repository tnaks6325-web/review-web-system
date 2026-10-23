/**
 * 결정 277(사용자 확정 2026-10-22 「2.가」「4.가」) — 상품 메인 주소 칸 · 옵션 주소·상품 주소 양방향.
 *   ① 발행 프리필·비교: 줄마다 그 상품의 주소(product_url) · 공고 쪽이 비어 있으면(198 이전 줄) 비교하지 않는다
 *   ② 공고 창 → 오더: 옵션 주소 = 그 옵션 url · 상품 주소 = 그 상품 url(+ 첫 상품이면 오더 상품 페이지 칸) · 옵션 없는 상품 = 상품 url 하나
 *   ③ 손대지 않음: 기준과 같음 · 지금 공고 값과 같음(공고에서만 고쳐 둔 옛 주소) · 안 보냄(null)
 *   ④ 못 담음: 옵션 주소를 비움(오더에서 상품 주소로 접힘) · 옵션 없는 상품의 두 칸을 다르게 · 같은 상품 줄마다 다른 상품 주소
 *   ⑤ 옛 화면(기준 버전 없음)이 주소를 바꾸면 거부 목록에 「주소」
 *   ⑥ 인트라넷 쪽 적용: 상품 url 이 바뀌면 그 상품 줄 전부의 product_url 이 따라간다(공고 투영 · SQL 배선)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/utils/campaignSharedEdit');
const P = require('../src/utils/orderToCampaignProjection');

const U = n => `https://smartstore.naver.com/x/products/${n}`;
const PRODUCTS = [
  { name: '탈취제', url: U(1), option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [
    { option_1: { name: '', value: '블랙' }, label: '블랙', url: U(11), pay: 10000, count: 5, daily: 1, review_type_mix: [] },
    { option_1: { name: '', value: '화이트' }, label: '화이트', url: U(12), pay: 12000, count: 5, daily: 1, review_type_mix: [] }] },
  { name: '방향제', url: U(2), option_schema_version: 2, product_mode: 'none', base: { pay: 9000, count: 4, daily: 1, review_type_mix: [] }, options: [] },
];
const base = { product_options_json: JSON.stringify(PRODUCTS), product_url: U(1), inflow_type: 'link' };

// ── ① 프리필·비교 ──
const rows = P.projectOrderToCampaign(base).options;
assert.deepEqual(rows.map(r => [r.key, r.option_url, r.product_url]), [
  ['탈취제|블랙', U(11), U(1)], ['탈취제|화이트', U(12), U(1)], ['방향제|', U(2), U(2)]]);
const campRows = (over = {}) => [
  { opt_key: '블랙', product_name: '탈취제', unit_kind: 'option', option_url: U(11), product_url: null, pay_amount: 10000, recruit_total: 5, daily_limit: 1, status: 'active', ...(over['블랙'] || {}) },
  { opt_key: '화이트', product_name: '탈취제', unit_kind: 'option', option_url: U(12), product_url: null, pay_amount: 12000, recruit_total: 5, daily_limit: 1, status: 'active', ...(over['화이트'] || {}) },
  { opt_key: '방향제', product_name: '방향제', unit_kind: 'product', option_url: U(2), product_url: null, pay_amount: 9000, recruit_total: 4, daily_limit: 1, status: 'active', ...(over['방향제'] || {}) }];
const camp = { review_fee: 0, recruit_total: 14, daily_limit: 3, landing_url: U(1) };
const diffs = (opts) => P.compareOrderCampaign(base, camp, opts).filter(d => /product_url/.test(d.field)).map(d => d.field);
assert.deepEqual(diffs(campRows()), [], '공고 상품 주소가 비어 있으면(198 이전) 비교하지 않는다 — 연결된 공고가 전부 "다름" 이 되지 않게');
assert.deepEqual(diffs(campRows({ 블랙: { product_url: U(1) }, 화이트: { product_url: U(1) } })), [], '같으면 차이 없음');
assert.deepEqual(diffs(campRows({ 블랙: { product_url: U(9) } })), ['option:탈취제 / 블랙.product_url'], '다르면 차이');

// ── ② 공고 창 → 오더 ──
const opt = (k, o = {}) => ({ optKey: k, productName: '탈취제', unitKind: 'option', payAmount: k === '블랙' ? 10000 : 12000, recruitTotal: 5, dailyLimit: 1,
  optionUrl: k === '블랙' ? U(11) : U(12), productUrl: U(1), ...o });
const unit = (o = {}) => ({ optKey: '', productName: '방향제', unitKind: 'product', payAmount: 9000, recruitTotal: 4, dailyLimit: 1, optionUrl: U(2), productUrl: U(2), ...o });
const plan = (options, campOptions = campRows()) => E.planCampaignMoneyEdit({ baseState: base, camp, body: { options }, campOptions });
{
  const p = plan([opt('블랙'), opt('화이트'), unit()]);
  assert.deepEqual(p.mine, {}, '손대지 않은 저장 = 아무것도 안 보냄'); assert.deepEqual(p.unmappable, []);
}
{
  const p = plan([opt('블랙', { optionUrl: U(31) }), opt('화이트'), unit()]);
  assert.deepEqual(p.unmappable, []);
  const j = JSON.parse(p.mine.product_options_json);
  assert.equal(j[0].options[0].url, U(31), '옵션 주소 → 그 옵션 url');
  assert.equal(j[0].options[1].url, U(12)); assert.equal(j[0].url, U(1));
  assert.equal(p.mine.product_url, undefined, '상품 주소를 안 바꾸면 오더 상품 페이지 칸도 그대로');
  assert.ok(p.changed.includes('주소(탈취제 / 블랙)'), JSON.stringify(p.changed));
}
{
  const p = plan([opt('블랙', { productUrl: U(41) }), opt('화이트', { productUrl: U(41) }), unit()]);
  assert.deepEqual(p.unmappable, []);
  const j = JSON.parse(p.mine.product_options_json);
  assert.equal(j[0].url, U(41), '상품 주소 → 그 상품 url');
  assert.equal(p.mine.product_url, U(41), '첫 상품 주소 = 오더 상품 페이지 칸도 같이(같았을 때만)');
}
{
  // 오더 상품 페이지 칸이 첫 상품 주소와 달랐으면(다른 값을 일부러 둔 오더) 그 칸은 건드리지 않는다
  const p = E.planCampaignMoneyEdit({ baseState: { ...base, product_url: U(77) }, camp, body: { options: [opt('블랙', { productUrl: U(41) }), opt('화이트', { productUrl: U(41) }), unit()] }, campOptions: campRows() });
  assert.equal(p.mine.product_url, undefined);
}
{
  const p = plan([opt('블랙'), opt('화이트'), unit({ optionUrl: U(52), productUrl: U(52) })]);
  assert.deepEqual(p.unmappable, []);
  assert.equal(JSON.parse(p.mine.product_options_json)[1].url, U(52), '옵션 없는 상품 = 상품 url 하나');
}
{
  // 오더 옵션 주소가 빈 옵션(상품 주소를 따라가는 줄) — 상품 주소만 바꾸고 옵션 칸은 옛 주소 그대로 보내도 막지 않는다(그 줄은 새 상품 주소를 따라간다)
  const P2 = JSON.parse(JSON.stringify(PRODUCTS)); P2[0].options.forEach(o => { o.url = ''; });
  const base2 = { ...base, product_options_json: JSON.stringify(P2) };
  const rows2 = campRows({ 블랙: { option_url: U(1) }, 화이트: { option_url: U(1) } });
  const p = E.planCampaignMoneyEdit({ baseState: base2, camp, body: { options: [opt('블랙', { optionUrl: U(1), productUrl: U(44) }), opt('화이트', { optionUrl: U(1), productUrl: U(44) }), unit()] }, campOptions: rows2 });
  assert.deepEqual(p.unmappable, [], JSON.stringify(p.unmappable));
  const j = JSON.parse(p.mine.product_options_json);
  assert.equal(j[0].url, U(44)); assert.deepEqual(j[0].options.map(o => o.url), ['', ''], '옵션은 계속 상품 주소를 따라간다');
}
// ── ③ 손대지 않음 ──
{
  // 공고에서만 고쳐 둔 옛 옵션 주소(지금 공고 값)를 그대로 보내면 = 손대지 않음
  const p = plan([opt('블랙', { optionUrl: U(66) }), opt('화이트'), unit()], campRows({ 블랙: { option_url: U(66) } }));
  assert.deepEqual(p.mine, {});
  // 상품 주소를 안 보냄(null) = 손대지 않음 — 198 이전 줄을 처음 연 창(상품 주소 칸을 안 건드림)
  const q = plan([opt('블랙', { productUrl: null }), opt('화이트', { productUrl: null }), unit({ productUrl: null })]);
  assert.deepEqual(q.mine, {});
}
{
  // ★ 코드 리뷰 실측(2026-10-22) — 옵션 없는 상품 줄의 상품 주소가 NULL(198 이전)이고 공고 줄 주소가 오더와 다르면,
  //   그 줄 주소를 그대로 보낸 손대지 않은 저장이 오더 상품 주소를 덮었다. 옵션 없는 상품은 두 칸이 같은 값 → 줄 주소가 지금 값.
  const p = plan([opt('블랙'), opt('화이트'), unit({ optionUrl: U(70), productUrl: U(70) })], campRows({ 방향제: { option_url: U(70) } }));
  assert.deepEqual(p.mine, {}, '공고에만 다르게 적혀 있던 옛 상품 주소 = 손대지 않음 ' + JSON.stringify(p.changed));
  // 표기만 다른 주소(공고는 저장 때 URL.href 정규화 — 한글 → %XX)도 손대지 않음
  const KO = 'https://smartstore.naver.com/x/products/2?q=한글';
  const PK = JSON.parse(JSON.stringify(PRODUCTS)); PK[1].url = KO;
  const enc = new URL(KO).href;
  const q = E.planCampaignMoneyEdit({ baseState: { ...base, product_options_json: JSON.stringify(PK) }, camp,
    body: { options: [opt('블랙'), opt('화이트'), unit({ optionUrl: enc, productUrl: enc })] }, campOptions: campRows({ 방향제: { option_url: enc } }) });
  assert.deepEqual(q.mine, {}, '인코딩만 다른 주소 = 손대지 않음 ' + JSON.stringify(q.changed));
  // 사람이 정말 고치면 그대로 간다
  const r = plan([opt('블랙'), opt('화이트'), unit({ optionUrl: U(71), productUrl: U(71) })], campRows({ 방향제: { option_url: U(70) } }));
  assert.equal(JSON.parse(r.mine.product_options_json)[1].url, U(71));
}
// ── ④ 못 담음 ──
{
  let p = plan([opt('블랙', { optionUrl: '' }), opt('화이트'), unit()]);
  assert.ok(p.unmappable.some(u => /옵션 주소/.test(u.label)), '옵션 주소 비우기 = 오더에서 상품 주소로 접혀 못 담음 ' + JSON.stringify(p.unmappable));
  assert.equal(p.mine.product_options_json, undefined, '못 담으면 상품 구성을 보내지 않는다');
  p = plan([opt('블랙'), opt('화이트'), unit({ optionUrl: U(81), productUrl: U(82) })]);
  assert.ok(p.unmappable.some(u => /상품 주소 하나/.test(u.label)), JSON.stringify(p.unmappable));
  p = plan([opt('블랙', { productUrl: U(91) }), opt('화이트', { productUrl: U(92) }), unit()]);
  assert.ok(p.unmappable.some(u => /같은 상품의 줄마다 다른 주소/.test(u.label)), JSON.stringify(p.unmappable));
}
// ── ⑤ 옛 화면 ──
{
  assert.deepEqual(E.moneyDriftFromCampaign(camp, { options: [opt('블랙'), opt('화이트'), unit()] }, campRows()), [], '같은 주소 = 통과(상품 주소 NULL 은 비교 안 함)');
  assert.ok(E.moneyDriftFromCampaign(camp, { options: [opt('블랙', { optionUrl: U(5) }), opt('화이트'), unit()] }, campRows()).includes('주소'));
  assert.ok(E.moneyDriftFromCampaign(camp, { options: [opt('블랙', { productUrl: U(5) }), opt('화이트'), unit()] }, campRows({ 블랙: { product_url: U(1) } })).includes('주소'));
  assert.deepEqual(E.moneyDriftFromCampaign(camp, { options: [opt('블랙', { optionUrl: 'https://smartstore.naver.com/x/products/11' })] }, campRows()), [], '표기만 같은 주소');
}
// ── ⑥ 배선(공고 투영 · 저장 · 보호 · 맞추기) ──
{
  const sp = fs.readFileSync(path.join(__dirname, '../src/services/sharedPatch.service.js'), 'utf8');
  assert.match(sp, /if \(urlTouched \|\| has\('product_url'\) \|\| extra\.structureTouched\) \{\n\s*const prodUrls = new Map\(\);/, '주소가 움직였거나 줄을 더한 저장 = 상품 주소 투영');
  assert.match(sp, /UPDATE campaign_options SET product_url = \$3, updated_at = NOW\(\)/);
  const ss = fs.readFileSync(path.join(__dirname, '../src/services/campaignSharedSave.service.js'), 'utf8');
  assert.match(ss, /typeof o\.productUrl === 'string' && mine\.product_url === b\.product_url && c\.product_url && c\.product_url !== b\.product_url/, '창을 연 뒤 리뷰오더에서 바뀐 상품 주소는 지킨다');
  const rc = fs.readFileSync(path.join(__dirname, '../src/services/sharedReconcile.service.js'), 'utf8');
  assert.match(rc, /const ORDER_ONLY_LEAVES = new Set\(\[\]\);/, '맞추기 화면 — 주소도 공고 쪽으로 고를 수 있다');
  assert.match(rc, /if \(L\('option_url'\)\) row\.optionUrl = t\.option_url;\n\s*if \(L\('product_url'\)\) row\.productUrl = t\.product_url;/);
}
console.log('campaignProductUrlBidir: passed');
