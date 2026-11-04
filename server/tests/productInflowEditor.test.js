/**
 * 결정 333 2단계 — 리뷰웹 공고 창의 상품 카드마다 유입방식 (사용자 확정 2026-11-04 「가」).
 *   ① 공고 창 화면 판정(vm 실행) — 카드 값 → 공고 전체 값('섞이면 guide')·줄 값('섞일 때만') · 모두 같아지면 위 버튼으로 올리고 카드 값은 비운다
 *   ② 공고 창 저장 → 오더(연결 공고 공유 저장의 되돌리기 계산 `planCampaignMoneyEdit` ⑨)
 *      섞기 · 섞임 풀기 · 그대로 다시 저장 = 쓰기 0 · 옛 화면(줄에 유입 없음) = 손대지 않음 · 담을 수 없으면 거부(추측 금지)
 *      · 링크 줄의 가이드는 오더로 옮기지 않는다
 *   ③ 오더·공고 비교 — 줄 값이 한쪽이라도 있을 때만, 실제로 쓰는 값으로 · 전체 값만 다른 기존 작업은 줄마다 쏟아지지 않는다
 *   ④ 맞추기 — 유입방식 칸이 뜨고, 공고 쪽·오더 쪽 어느 쪽을 골라도 끝 상태 차이 0
 *   ⑤ 「가이드+링크유입」 표시 — 판정 단일 출처(orderInflowMixed) · 작업보드 · 공고 카드 · 관리자 목록 배선
 *   ⑥ (PGTEST_URL) 진짜 PG + 실제 라우트 — 연결 공고 공고 창 저장: 섞기 → 오더 상품별 값 · 공고 줄 값 · 인트라넷 보낼 줄 /
 *      23호를 가이드로 되돌리는데 가이드가 없으면 거부·쓰기 0 / 섞임 풀기 → 키 지움 · 전체 값 link · 공고 줄 값 비움 / 관리자 목록 inflowMixed
 */
'use strict';
require('../scripts/test-bootstrap');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
if (process.env.PGTEST_URL) process.env.DATABASE_URL = process.env.PGTEST_URL;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const U = require('../src/utils/unitInflow');
const SE = require('../src/utils/campaignSharedEdit');
const PJ = require('../src/utils/orderToCampaignProjection');
const REC = require('../src/services/sharedReconcile.service');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail += 1; }
}
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert(i >= 0, '함수 없음: ' + name);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('중괄호 불균형: ' + name);
}

const PRODS = [
  { name: '21호 수건', url: 'https://shop.example/21', option_schema_version: 2, product_mode: 'none', guide: { text: '검색창에 21호 수건', images: [] }, base: { pay: 10000, count: 5 }, options: [] },
  { name: '23호 수건', url: 'https://shop.example/23', option_schema_version: 2, product_mode: 'none', base: { pay: 12000, count: 5 }, options: [] },
];
const PLAIN = { inflow_type: 'guide', product_options_json: JSON.stringify(PRODS), recruit_count: 10, review_fee: 0 };
const MIXED = { ...PLAIN, product_options_json: JSON.stringify(PRODS.map((p, i) => ({ ...p, inflow_type: i ? 'link' : 'guide' }))) };
const rowsOf = st => PJ.projectOrderToCampaign(st).options;
const bodyRow = (r, inflow) => {
  const o = { productName: r.key.split('|')[0], optKey: '', unitKind: 'product', payAmount: r.pay_amount, recruitTotal: r.recruit_total,
    dailyLimit: r.daily_limit, status: 'active', inflowGuideHtml: r.inflow_guide_html, inflowGuideImages: [] };
  if (inflow !== undefined) o.inflowType = inflow;
  return o;
};
const CAMP = { work_detail: { inflowType: 'guide' } };
const LIVE = rowsOf(PLAIN).map(r => ({ opt_key: r.key.split('|')[0], product_name: r.key.split('|')[0], unit_kind: 'product', status: 'active',
  pay_amount: r.pay_amount, recruit_total: r.recruit_total, daily_limit: r.daily_limit }));
const plan = (baseState, wdType, inflows) => SE.planCampaignMoneyEdit({ baseState, camp: CAMP,
  body: { work_detail: { inflowType: wdType }, options: rowsOf(baseState).map((r, i) => bodyRow(r, inflows[i])) }, campOptions: LIVE });
const prodInflows = m => JSON.parse(m.mine.product_options_json).map(p => (p.inflow_type === undefined ? null : p.inflow_type));

// ── ① 공고 창 화면 판정 ──
console.log('\n[①] 공고 창 화면 판정(vm)');
{
  const src = R('../frontend/js/index-recruit.js');
  const mkBtn = v => { const cls = new Set(); return { dataset: { inflow: v }, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: c => cls.has(c) } }; };
  const mkBox = inflow => { const btns = [mkBtn('guide'), mkBtn('link')]; return { dataset: { inflow }, btns, querySelectorAll: () => btns }; };
  const env = (top, cards) => {
    const hidden = { value: top };
    const boxes = cards.map(mkBox);
    const sb = { window: {}, Array, Set,
      document: { querySelectorAll: () => boxes, getElementById: id => (id === 'rf_inflow_type_value' ? hidden : null) } };
    vm.createContext(sb);
    ['_rfUnitInflow', '_rfTopInflow', '_rfInflowPlan', '_rfPaintCardInflows'].forEach(fn => vm.runInContext(grab(src, fn), sb));
    return { sb, hidden, boxes };
  };
  t('① 카드가 모두 위 값을 따르면 섞이지 않음 — 공고 전체 값 = 위 값 · 줄 값은 빈 값', () => {
    const { sb, boxes } = env('link', ['', '']);
    const p = vm.runInContext('_rfInflowPlan()', sb);
    assert.strictEqual(p.mixed, false); assert.strictEqual(p.campaign, 'link');
    assert.deepStrictEqual(boxes.map(b => p.unitOf(b)), ['', '']);
  });
  t('① 23호만 링크 — 섞임 · 공고 전체 값 guide · 줄 값은 카드마다 실제 값(위 값을 따르는 카드도 값을 싣는다)', () => {
    const { sb, boxes } = env('guide', ['', 'link']);
    const p = vm.runInContext('_rfInflowPlan()', sb);
    assert.strictEqual(p.mixed, true); assert.strictEqual(p.campaign, 'guide');
    assert.deepStrictEqual(boxes.map(b => p.unitOf(b)), ['guide', 'link']);
  });
  t('① 카드를 눌러 모두 같아지면 그 값을 위 버튼으로 올리고 카드 값은 비운다(따름)', () => {
    const { sb, hidden, boxes } = env('guide', ['link', 'link']);
    vm.runInContext('_rfPaintCardInflows({ settle: true })', sb);
    assert.strictEqual(hidden.value, 'link');
    assert.deepStrictEqual(boxes.map(b => b.dataset.inflow), ['', '']);
    assert.deepStrictEqual(boxes.map(b => b.dataset.effInflow), ['link', 'link']);
    assert.ok(boxes.every(b => b.btns[1].classList.has('on') && !b.btns[0].classList.has('on')), '카드 버튼이 실제 값으로 칠해진다');
  });
  t('① 상품이 하나뿐이면(카드 선택이 숨겨짐) 카드 값을 위로 올린다 — 보이는 값과 저장 값이 갈리지 않게', () => {
    const { sb, hidden, boxes } = env('guide', ['link']);
    vm.runInContext('_rfPaintCardInflows()', sb);
    assert.strictEqual(hidden.value, 'link'); assert.strictEqual(boxes[0].dataset.inflow, '');
  });
  t('① 서버가 카드 유입을 받는다고 알려 주지 않은 수정 창 — 카드 값을 무시하고 위 값만(옛 서버가 줄 값을 버려 링크 상품이 가이드로 바뀌지 않게)', () => {
    const { sb, boxes } = env('guide', ['', 'link']);
    sb.window._rfUnitInflowOk = false; sb._rfUnitInflowOk = false;
    vm.runInContext('window = this; _rfUnitInflowOk = false;', sb);
    const p = vm.runInContext('_rfInflowPlan()', sb);
    assert.strictEqual(p.mixed, false); assert.strictEqual(p.campaign, 'guide');
    assert.deepStrictEqual(boxes.map(b => p.unitOf(b)), ['', '']);
    assert.ok(/window\._rfUnitInflowOk = !!\(json && json\.unitInflow\);/.test(src), '수정 창은 서버 표시로');
    assert.ok(/wrap\.classList\.toggle\("rf-multi", boxes\.length > 1 && window\._rfUnitInflowOk !== false\);/.test(src), '표시가 없으면 카드 선택을 숨긴다');
    assert.ok(/unitInflow: 1,/.test(R('src/routes/campaign.routes.js')), '서버 상세가 표시를 준다');
  });
  t('① 다시 그리기만으로는 「작업오더에서 불러온 값」 안내를 지우지 않는다 · 값이 바뀌거나 사람이 누르면 지운다', () => {
    let e = env('guide', ['']);
    vm.runInContext('window = this; _rfInflowOrigin = "order";', e.sb);
    vm.runInContext('_rfPaintCardInflows()', e.sb);
    assert.strictEqual(vm.runInContext('window._rfInflowOrigin', e.sb), 'order');
    e = env('guide', ['link']);
    vm.runInContext('window = this; _rfInflowOrigin = "order";', e.sb);
    vm.runInContext('_rfPaintCardInflows()', e.sb);
    assert.strictEqual(vm.runInContext('window._rfInflowOrigin', e.sb), '');
    e = env('guide', ['']);
    vm.runInContext('window = this; _rfInflowOrigin = "order";', e.sb);
    vm.runInContext('_rfPaintCardInflows({ settle: true })', e.sb);
    assert.strictEqual(vm.runInContext('window._rfInflowOrigin', e.sb), '');
  });
  t('① 저장 본문 배선 — 줄마다 unitOf · 공고 전체 값은 plan.campaign · 가이드 검사도 실제 값', () => {
    assert.ok(/inflowType:\s+inflowPlan\.unitOf\(r\.closest\(\"\.rf-gp\"\)\),/.test(src));
    assert.ok(/inflowType:\s+_rfInflowPlan\(\)\.campaign,/.test(src));
    assert.ok(/validateActiveUnitInflowGuides\(_rfInflowPlan\(\)\.campaign\)/.test(src));
  });
}

// ── ② 공고 창 저장 → 오더 ──
console.log('\n[②] 공고 창 저장 → 오더 상품별 값(planCampaignMoneyEdit ⑨)');
t('② 섞기 — 23호 링크로 → 두 상품 모두 키를 싣는다(섞일 때만 · 오더 전체 값 guide 그대로)', () => {
  const m = plan(PLAIN, 'guide', ['guide', 'link']);
  assert.deepStrictEqual(m.unmappable, []);
  assert.deepStrictEqual(prodInflows(m), ['guide', 'link']);
  assert.ok(m.changed.includes('유입방식(상품별)'));
  assert.strictEqual(m.mine.inflow_type, undefined, '이미 guide');
});
t('② 섞인 오더를 그대로 다시 저장 — 쓰기 0(창을 연 뒤 인트라넷이 바꾼 값을 덮지 않는다)', () => {
  const m = plan(MIXED, 'guide', ['guide', 'link']);
  assert.deepStrictEqual(Object.keys(m.mine), []); assert.deepStrictEqual(m.unmappable, []);
});
t('② 섞임 풀기(위 버튼 링크) — 키를 지우고 오더 전체 값을 link 로', () => {
  const m = plan(MIXED, 'link', ['', '']);
  assert.deepStrictEqual(prodInflows(m), [null, null]);
  assert.strictEqual(m.mine.inflow_type, 'link');
});
t('② 화면 전체 값과 줄 값이 어긋나면(섞였는데 전체 link) 줄 값을 따르고 전체 값은 guide 로 맞춘다', () => {
  const m = plan(PLAIN, 'link', ['guide', 'link']);
  assert.deepStrictEqual(prodInflows(m), ['guide', 'link']); assert.strictEqual(m.mine.inflow_type, 'guide');
});
t('② 섞이지 않은 저장(빈 값) — 쓰기 0', () => {
  assert.deepStrictEqual(Object.keys(plan(PLAIN, 'guide', ['', '']).mine), []);
});
t('② 옛 공고 창(줄에 유입방식 없음) — 섞인 오더를 손대지 않는다', () => {
  const m = plan(MIXED, 'guide', [undefined, undefined]);
  assert.deepStrictEqual(Object.keys(m.mine), []); assert.deepStrictEqual(m.unmappable, []);
});
t('② 옛 공고 창이 상품마다 다른 오더의 전체 유입방식을 바꿈 — 거부(반만 바뀌지 않게 · 새로고침 안내)', () => {
  const m = plan(MIXED, 'link', [undefined, undefined]);
  assert.ok(m.unmappable.some(u => /새로고침/.test(u.label)), JSON.stringify(m.unmappable));
  assert.deepStrictEqual(Object.keys(plan(PLAIN, 'link', [undefined, undefined]).unmappable), [], '안 섞인 오더는 종전대로');
});
t('② 같은 상품의 옵션끼리 다른 유입방식 — 거부(유입방식은 상품마다 하나)', () => {
  const prods = [{ name: '세트', url: 'https://shop.example/s', option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0 },
    options: [{ label: 'A', pay: 1000, count: 2, guide: { text: 'A 검색', images: [] } }, { label: 'B', pay: 1000, count: 2, guide: { text: 'B 검색', images: [] } }] }];
  const st = { inflow_type: 'guide', product_options_json: JSON.stringify(prods), recruit_count: 4 };
  const live = rowsOf(st).map(r => ({ opt_key: r.key.split('|')[1], product_name: '세트', unit_kind: 'option', status: 'active', pay_amount: r.pay_amount, recruit_total: r.recruit_total, daily_limit: r.daily_limit }));
  const options = rowsOf(st).map((r, i) => ({ productName: '세트', optKey: r.key.split('|')[1], unitKind: 'option', payAmount: r.pay_amount,
    recruitTotal: r.recruit_total, dailyLimit: r.daily_limit, status: 'active', inflowGuideHtml: r.inflow_guide_html, inflowGuideImages: [], inflowType: i ? 'link' : 'guide' }));
  const m = SE.planCampaignMoneyEdit({ baseState: st, camp: CAMP, body: { work_detail: { inflowType: 'guide' }, options }, campOptions: live });
  assert.ok(m.unmappable.some(u => /같은 상품의 옵션끼리/.test(u.label)), JSON.stringify(m.unmappable));
  assert.strictEqual(m.mine.product_options_json, undefined, '쓰기 0');
});
t('② 오더에 상품 구성이 없는데 섞어 보냄 — 거부(조용히 하나로 접지 않는다)', () => {
  const st = { inflow_type: 'guide', product_options_json: '', recruit_count: 4 };
  const m = SE.planCampaignMoneyEdit({ baseState: st, camp: CAMP,
    body: { work_detail: { inflowType: 'guide' }, options: [{ productName: 'X', unitKind: 'product', inflowType: 'guide' }, { productName: 'Y', unitKind: 'product', inflowType: 'link' }] }, campOptions: [] });
  assert.ok(m.unmappable.some(u => /상품 구성이 없어/.test(u.label)), JSON.stringify(m.unmappable));
});
t('② 링크 줄의 가이드는 오더로 옮기지 않는다 · 가이드 줄의 가이드는 옮긴다', () => {
  const rows = rowsOf(MIXED);
  const options = rows.map((r, i) => ({ ...bodyRow(r, i ? 'link' : 'guide'), inflowGuideHtml: i ? '23호 남은 글' : '검색창에 21호 수건 (새 글)' }));
  const m = SE.planCampaignMoneyEdit({ baseState: MIXED, camp: CAMP, body: { work_detail: { inflowType: 'guide' }, options }, campOptions: LIVE });
  assert.deepStrictEqual(m.unmappable, [], JSON.stringify(m.unmappable));
  const out = JSON.parse(m.mine.product_options_json);
  assert.ok(/새 글/.test(out[0].guide.text), JSON.stringify(out[0].guide));
  assert.ok(!out[1].guide, '링크 상품에 가이드를 싣지 않는다');
  assert.ok(!m.changed.some(c => /유입가이드\(23호/.test(c)));
});

// ── ③ 비교 ──
console.log('\n[③] 오더·공고 비교');
const optRowsC = types => LIVE.map((r, i) => ({ ...r, inflow_type: types[i] }));
const inflowDiffs = (wo, types, wd = 'guide') => PJ.compareOrderCampaign(wo, { work_detail: { inflowType: wd } }, optRowsC(types)).filter(d => /\.inflow_type$/.test(d.field));
t('③ 섞인 오더 vs 줄 값 없는 공고 — 실제로 다른 줄(23호)만 다름 · 빈 값도 뜻이 있다(채우기로 접지 않는다)', () => {
  assert.deepStrictEqual(inflowDiffs(MIXED, ['', '']), [{ field: 'option:23호 수건.inflow_type', kind: 'diff', order: 'link', campaign: 'guide' }]);
  assert.deepStrictEqual(inflowDiffs(PLAIN, ['guide', 'link']).map(d => [d.order, d.campaign, d.kind]), [['guide', 'link', 'diff']]);
});
t('③ 같으면 0 · 줄 값이 어느 쪽에도 없으면 전체 값이 달라도 줄 칸은 비교하지 않는다(기존 작업 무변화)', () => {
  assert.deepStrictEqual(inflowDiffs(MIXED, ['guide', 'link']), []);
  assert.deepStrictEqual(inflowDiffs(PLAIN, ['', ''], 'link'), []);
  assert.deepStrictEqual(inflowDiffs(PLAIN, [null, null]), []);
});

// ── ④ 맞추기 ──
console.log('\n[④] 맞추기');
{
  const wo = { id: 'w1', source_review_order_id: 'r1', ...PLAIN, skip_weekends: false };
  const p = PJ.projectOrderToCampaign(wo);
  const camp = { id: 'c1', review_fee: 0, recruit_total: 10, skip_weekends: false, review_type: '', time_range: p.time_range, work_detail: { inflowType: 'guide' } };
  for (const k of PJ.SCALAR_KEYS) if (!(k in camp)) camp[k] = p[k];
  const opts = p.options.map((r, i) => ({ id: i + 1, opt_key: r.key.split('|')[0], product_name: r.key.split('|')[0], unit_kind: 'product', status: 'active',
    option_url: r.option_url, product_url: r.product_url, pay_amount: r.pay_amount, recruit_total: r.recruit_total, daily_limit: r.daily_limit,
    review_type_mix: [], inflow_guide_html: i ? '' : '검색창에 21호 수건', inflow_guide_images: [], inflow_type: i ? 'link' : 'guide' }));
  const plan0 = REC.planReconcile(wo, camp, opts);
  t('④ 칸 하나 — 「유입방식 (23호 수건)」 가이드유입 ↔ 링크유입 · 공고 쪽으로 옮길 수 있다', () => {
    assert.deepStrictEqual(plan0.fields.map(f => [f.id, f.label, f.orderText, f.campaignText]),
      [['option:23호 수건.inflow_type', '유입방식 (23호 수건)', '가이드유입', '링크유입']]);
    assert.deepStrictEqual(plan0.fields[0].campaignSide, { ok: true });
  });
  for (const side of ['campaign', 'order']) {
    t(`④ ${side === 'campaign' ? '공고' : '오더'} 쪽을 고르면 끝 상태 차이 0`, () => {
      const pl = REC.planReconcile(wo, camp, opts, { 'option:23호 수건.inflow_type': side });
      assert.ok(!pl.error, JSON.stringify(pl.error));
      const T = JSON.parse(pl.T.product_options_json).map(x => x.inflow_type || null);
      assert.deepStrictEqual(T, side === 'campaign' ? ['guide', 'link'] : [null, null]);
      const after = side === 'campaign' ? opts : opts.map(o => ({ ...o, inflow_type: '' }));   // 오더 쪽 = 공유 저장 투영이 줄 값을 비운다
      assert.deepStrictEqual(REC.diffFields({ ...wo, ...pl.T }, camp, after).map(f => f.id), []);
    });
  }
}

// ── ⑤ 표시 ──
console.log('\n[⑤] 「가이드+링크유입」 표시');
t('⑤ 섞였나 판정 — 실제로 쓰는 값 기준(줄 값 · 없으면 전체 값)', () => {
  assert.strictEqual(U.orderInflowMixed(MIXED.product_options_json, 'guide'), true);
  assert.strictEqual(U.orderInflowMixed(PLAIN.product_options_json, 'guide'), false);
  assert.strictEqual(U.orderInflowMixed(JSON.stringify([{ name: 'a', inflow_type: 'link' }, { name: 'b' }]), 'link'), false, '따름 = 전체 값과 같음');
  assert.strictEqual(U.orderInflowMixed(JSON.stringify([{ name: 'a', inflow_type: 'link' }, { name: 'b' }]), 'guide'), true);
  ['', null, '{oops', '[]', JSON.stringify([{ name: 'a', inflow_type: 'mixed' }])].forEach(v => assert.strictEqual(U.orderInflowMixed(v, 'guide'), false));
});
t('⑤ 상품마다 한 줄 재료 — 상품 이름 + 실제 값 · 이름 없는 상품·모르는 값은 뺀다(사용자 확정 「1」)', () => {
  assert.deepStrictEqual(U.orderInflowUnits(MIXED.product_options_json, 'guide'), [{ name: '21호 수건', type: 'guide' }, { name: '23호 수건', type: 'link' }]);
  assert.deepStrictEqual(U.orderInflowUnits(JSON.stringify([{ name: 'a|b', inflow_type: 'link' }, { name: '', inflow_type: 'guide' }, { name: 'c' }]), 'guide'),
    [{ name: 'ab', type: 'link' }, { name: 'c', type: 'guide' }]);
  assert.deepStrictEqual(U.orderInflowUnits('{oops', 'guide'), []);
});
t('⑤ 작업보드 — 오더 전체 값은 그대로 두고 표시만 따로 · 업체 화면 사본도 같은 값', () => {
  const tb = R('src/services/trackB.service.js');
  assert.ok(/inflowType: \(wo && wo\.inflowType\) \|\| null,\s*\n\s*\/\*[^*]*\*\/\s*\n\s*inflowMixed: !!\(wo && require\('\.\.\/utils\/unitInflow'\)\.orderInflowMixed\(wo\.productOptionsJson, wo\.inflowType\)\),/.test(tb));
  assert.ok(/inflowMixed: cd\.inflowMixed === true,/.test(tb));
  assert.ok(/inflowUnits: \(wo && require\('\.\.\/utils\/unitInflow'\)\.orderInflowMixed\(wo\.productOptionsJson, wo\.inflowType\)\)\s*\n\s*\? require\('\.\.\/utils\/unitInflow'\)\.orderInflowUnits\(wo\.productOptionsJson, wo\.inflowType\) : null,/.test(tb), '섞였을 때만 상품별 줄');
  assert.ok(/inflowUnits: Array\.isArray\(cd\.inflowUnits\) \? cd\.inflowUnits\.map\(u => \(\{ name: String\(u\.name \|\| ''\), type: u\.type === 'link' \? 'link' : 'guide' \}\)\) : null,/.test(tb), '업체 화면 사본 = 이름·값만');
  assert.ok(/cd\.inflowUnits\.map\(u=>`\$\{esc\(u\.name\)\} \$\{u\.type==='link'\?'링크유입':'가이드유입'\}`\)\.join\('<br>'\)/.test(R('../frontend/workdesk.html')), '작업 조건 = 상품마다 한 줄(이름은 escape)');
  assert.ok(/const inflow=cd\.inflowMixed===true\?'가이드\+링크유입':\(v=>\{/.test(R('../frontend/workdesk.html')));
});
t('⑤ 공고 카드 · 관리자 목록 — 살아 있는 줄의 실제 값이 둘 이상이면 inflowMixed', () => {
  const cr = R('src/routes/campaign.routes.js');
  assert.ok(/effectiveInflow\(/.test(cr) && /d\.inflowMixed = true/.test(cr));
  assert.ok(/inflowMixed === true/.test(R('../frontend/js/campaign-cards.js')) && /가이드\+링크유입/.test(R('../frontend/js/campaign-cards.js')));
  assert.ok(/d\.inflowUnits = \[\.\.\.\(inflowUnits\.get\(d\.id\) \|\| new Map\(\)\)\]/.test(cr), '관리자 목록 = 상품마다 한 줄');
  assert.ok(/' title="' \+ _esc\(c\.inflowUnits\.map/.test(R('../frontend/js/campaign-cards.js')), '카드 = 마우스를 올리면 상품별 목록(escape)');
});

async function pg() {
  console.log('\n[⑥] 진짜 PG — 연결 공고 공고 창 저장');
  process.env.ORDER_INTAKE_KEY = 'test-intake';
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const pool = require('../src/db/pool');
  const sw = require('../src/utils/bidirSwitch');
  const SP = require('../src/services/sharedPatch.service');
  const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
  const srv = app.listen(0);
  const port = srv.address().port;
  const stamp = Date.now();
  const sid = `ro_pinf_${stamp}`, camp = `camp_pinf_${stamp}`;
  const admin = { authorization: 'Bearer ' + jwt.sign({ id: 'admin_t', role: 'admin', name: '시험관리자' }, process.env.JWT_SECRET) };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', 'x-intake-key': 'test-intake', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const prevSetting = (await pool.query(`SELECT value FROM app_settings WHERE key = 'bidir_sync'`)).rows[0];
  const wo = async () => (await pool.query('SELECT * FROM work_orders WHERE source_review_order_id = $1', [sid])).rows[0];
  const optTypes = async () => (await pool.query(`SELECT opt_key, COALESCE(inflow_type,'') AS t FROM campaign_options WHERE campaign_id = $1 ORDER BY opt_key`, [camp])).rows.map(r => [r.opt_key, r.t]);
  const prodTypes = async () => JSON.parse((await wo()).product_options_json).map(p => [p.name, p.inflow_type === undefined ? null : p.inflow_type]);
  const pending = async () => (await pool.query(`SELECT count(*)::int n FROM shared_sync_outbox WHERE work_order_id = $1 AND status = 'pending'`, [(await wo()).id])).rows[0].n;
  const ok = async (name, fn) => { try { await fn(); console.log('  ✓ ' + name); pass += 1; } catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail += 1; } };
  try {
    const c1 = await call('POST', '/api/order/intake', { source_system: 'inadd_intranet', source_review_order_id: sid, source_revision: 1, idempotency_key: `${sid}:1:a`,
      title: '가짜 상품별 유입 오더', recruit_count: 10, review_fee: 1000, purchase_time: '13:00 ~ 18:00', review_guide: '[리뷰등록 가이드]\n사진 3장', special_notes: '없음',
      product_url: 'https://shop.example/21', inflow_type: 'guide', purchase_channel: '쿠팡', delivery_type: '실배송', review_type: '포토', skip_weekends: false, requester_name: '가짜AE',
      product_options_json: JSON.stringify(PRODS) });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    const w = await wo();
    const proj = PJ.projectOrderToCampaign(w), pre = _woCampaignPrefill(JSON.parse(JSON.stringify(w)));
    await pool.query(
      `INSERT INTO recruit_campaigns (id, title, source_work_order_id, recruit_total, review_fee, time_range, window_start, window_end, delivery_type, review_type, work_kind,
         skip_weekends, channel, channel_custom, landing_url, daily_limit, participation_mode, status, work_detail)
       VALUES ($1, '가짜 상품별 유입 공고', $2, $3, $4, $5, '13:00', '18:00', $6, $7, 'review', $8, $9, '', $10, $11, TRUE, 'active', $12::jsonb)`,
      [camp, w.id, Number(proj.recruit_total), Number(proj.review_fee), pre.time_range, proj.delivery_type, proj.review_type, proj.skip_weekends === '1', proj.channel, proj.landing_url,
        Number(proj.daily_limit) || 1, JSON.stringify({ inflowType: 'guide', reviewGuide: pre.wd_review, specialNotes: pre.wd_notes, reviewGuideImages: [], specialNotesImages: [], productLines: pre.wd_product })]);
    for (const o of pre.options) {
      await pool.query(`INSERT INTO campaign_options (campaign_id, opt_key, product_name, unit_kind, option_url, product_url, pay_amount, recruit_total, daily_limit, status, sort_order, inflow_guide_html, inflow_guide_images)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 0, $10, '[]'::jsonb)`,
        [camp, o.optKey || o.productName, o.productName, o.unitKind, o.optionUrl, o.productUrl, o.payAmount, o.recruitTotal, o.dailyLimit, o.inflowGuideHtml]);
    }
    await pool.query('UPDATE work_orders SET linked_campaign_id = $2 WHERE id = $1', [w.id, camp]);
    const ln = await SP.linkSharedOrder({ workOrderId: w.id, actor: '시험' });
    assert.equal(ln.body.state, 'on', JSON.stringify(ln.body));
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('bidir_sync', '{"in2rw":"apply","push":"on","campaign_edit":"on"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    sw._resetBidirSwitchCacheForTest();
    const openEditor = async () => {
      const d = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
      assert.equal(d.status, 200, JSON.stringify(d.body));
      const cc = d.body.data;
      return { title: cc.title, review_fee: cc.review_fee, max_slots: cc.max_slots, sort_order: cc.sort_order, deadline: cc.deadline, work_detail: { ...cc.work_detail },
        thumbnail_url: cc.thumbnail_url, time_range: cc.time_range, landing_url: cc.landing_url, channel: cc.channel, channel_custom: cc.channel_custom || '',
        window_start: String(cc.window_start || '').slice(0, 5), window_end: String(cc.window_end || '').slice(0, 5),
        options: d.body.options.map(o => ({ optKey: o.optKey, productName: o.productName, unitKind: o.unitKind, optionUrl: o.optionUrl, productUrl: o.productUrl, payAmount: o.payAmount,
          recruitTotal: o.recruitTotal, dailyLimit: o.dailyLimit, status: o.status, inflowGuideHtml: o.inflowGuideHtml || '', inflowGuideImages: o.inflowGuideImages || [], inflowType: o.inflowType })),
        fee_schedules: (d.body.feeSchedules || []).map(s => ({ effectiveFrom: s.effectiveFrom, reviewFee: s.reviewFee })),
        bidir_base_sync_version: d.body.bidir.sync_version };
    };
    const withInflow = (ed, top, types) => ({ ...ed, work_detail: { ...ed.work_detail, inflowType: top },
      options: ed.options.map(o => ({ ...o, inflowType: types[o.optKey] ?? '' })) });

    let ed = await openEditor();
    await ok('⑥ 상세가 줄 유입방식을 준다(아직 섞이지 않음 = 빈 값) · 카드 유입을 받는 서버라는 표시', async () => {
      const d = await call('GET', `/api/campaign/admin/${camp}`, null, admin);
      assert.equal(d.body.unitInflow, 1);
      assert.deepEqual(ed.options.map(o => [o.optKey, o.inflowType]), [['21호 수건', ''], ['23호 수건', '']]);
    });
    await ok('⑥ 섞기(23호 링크) → 오더 상품별 값 · 공고 줄 값 · 인트라넷 보낼 줄 · 23호 가이드 없어도 저장', async () => {
      const before = await pending();
      const r = await call('PUT', `/api/campaign/admin/${camp}`, withInflow(ed, 'guide', { '21호 수건': 'guide', '23호 수건': 'link' }), admin);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await prodTypes(), [['21호 수건', 'guide'], ['23호 수건', 'link']]);
      assert.equal((await wo()).inflow_type, 'guide');
      assert.deepEqual(await optTypes(), [['21호 수건', 'guide'], ['23호 수건', 'link']]);
      assert.ok((await pending()) > before, '인트라넷으로 보낼 줄이 쌓인다');
    });
    await ok('⑥ 관리자 목록 — 섞인 공고에 inflowMixed', async () => {
      const r = await call('GET', '/api/campaign/admin/list', null, admin);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      const me = (r.body.data || []).find(c => c.id === camp);
      assert.ok(me && me.inflowMixed === true, JSON.stringify(me && { id: me.id, inflowMixed: me.inflowMixed }));
      assert.deepEqual(me.inflowUnits, [{ name: '21호 수건', type: 'guide' }, { name: '23호 수건', type: 'link' }]);
    });
    await ok('⑥ 그대로 다시 저장 = 오더 버전 그대로(쓰기 0)', async () => {
      ed = await openEditor();
      assert.deepEqual(ed.options.map(o => o.inflowType), ['guide', 'link']);
      const v0 = Number((await wo()).sync_version);
      const r = await call('PUT', `/api/campaign/admin/${camp}`, { ...ed, title: '제목만' }, admin);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(Number((await wo()).sync_version), v0);
    });
    await ok('⑥ 23호를 가이드로 되돌리는데 가이드 없음 → 거부 · 오더·공고 그대로', async () => {
      ed = await openEditor();
      const v0 = Number((await wo()).sync_version);
      const r = await call('PUT', `/api/campaign/admin/${camp}`, withInflow(ed, 'guide', { '21호 수건': '', '23호 수건': '' }), admin);
      assert.ok(r.status === 400 || r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error || ''), /유입가이드/);
      assert.equal(Number((await wo()).sync_version), v0);
      assert.deepEqual(await optTypes(), [['21호 수건', 'guide'], ['23호 수건', 'link']]);
    });
    await ok('⑥ 섞임 풀기(전부 링크) → 키 지움 · 오더 전체 값 link · 공고 줄 값 비움 · 공고 전체 값 link', async () => {
      ed = await openEditor();
      const r = await call('PUT', `/api/campaign/admin/${camp}`, withInflow(ed, 'link', {}), admin);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await prodTypes(), [['21호 수건', null], ['23호 수건', null]]);
      assert.equal((await wo()).inflow_type, 'link');
      assert.deepEqual(await optTypes(), [['21호 수건', ''], ['23호 수건', '']]);
      const wd = (await pool.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1', [camp])).rows[0].work_detail;
      assert.equal(wd.inflowType, 'link');
    });
  } finally {
    srv.close();
    if (prevSetting) await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'bidir_sync'`, [prevSetting.value]).catch(() => {});
    else await pool.query(`DELETE FROM app_settings WHERE key = 'bidir_sync'`).catch(() => {});
    await pool.query('DELETE FROM campaign_options WHERE campaign_id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM recruit_campaigns WHERE id=$1', [camp]).catch(() => {});
    await pool.query('DELETE FROM work_orders WHERE source_review_order_id=$1', [sid]).catch(() => {});
  }
}

(async () => {
  if (process.env.PGTEST_URL) { await pg(); await require('../src/db/pool').end().catch(() => {}); }
  console.log(`\n  통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
