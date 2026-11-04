/**
 * 결정 333 — 상품마다 유입방식 (사용자 확정 2026-11-04 「가」).
 * 한 작업에 「21호 가이드유입 + 23호 링크유입」처럼 상품마다 유입이 다를 때, 오더·공고 하나로 끝까지 가는가.
 *   ① 규칙 단일 출처(utils/unitInflow) — 값 정규화 · 실제로 쓰는 유입방식 · 가이드 필수 판정 · 옛 창 값 보존(바이트 동일)
 *   ② 접수 정규화 — 상품별 값만 남기고 빈 값·오타는 키째 뺀다
 *   ③ 선택지 추출(금액 전파·유입 전파 공용) · 발행 프리필 줄에 유입방식이 실린다
 *   ④ 리뷰어 화면(공용 렌더러 vm 실행) — 링크 상품은 그 상품 주소 버튼 · 가이드 상품은 버튼 없음 · 주소 없으면 대표 주소로 접지 않음
 *   ⑤ 공고 저장 검사 — 링크 상품 줄은 가이드를 요구하지 않는다 · 안 보낸 줄은 저장된 값으로
 *   ⑥ 양방향 판정·적용 — 상품 칸만 쓸 수 있고 옵션 칸은 막힌다 · 키 없음 = 지움(따름)
 *   ⑦ 진짜 PostgreSQL(임베디드) — 옛 원본 수정 전파 · 공유 저장 투영이 줄 값을 쓰고, 최종 상태로 가이드를 검사하고, 거부면 되돌아간다
 *   ⑧ 배선 — 옛 인트라넷 창 값 보존이 공유 저장·종전 경로 앞에 있다 · 잠금에서 상품별 유입이 열렸다 · 필수 스키마
 */
'use strict';
require('../scripts/test-bootstrap');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const R = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const U = require('../src/utils/unitInflow');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail += 1; }
}

const PRODUCTS = [
  { name: '21호', product_mode: 'none', url: 'https://shop.example/21', base: { pay: 10000, count: 5 }, options: [],
    guide: { text: '검색창에 「21호 수건」 검색 → 3번째 상품', images: [] }, inflow_type: 'guide' },
  { name: '23호', product_mode: 'none', url: 'https://shop.example/23', base: { pay: 12000, count: 5 }, options: [], inflow_type: 'link' },
];

(async () => {
  // ── ① 규칙 단일 출처 ──
  await t('① 값 정규화 — guide·link 만, 나머지는 따름("")', () => {
    assert.strictEqual(U.unitInflowType('guide'), 'guide');
    assert.strictEqual(U.unitInflowType(' link '), 'link');
    ['', null, undefined, 'mixed', 'Guide', 0].forEach(v => assert.strictEqual(U.unitInflowType(v), ''));
    assert.strictEqual(U.effectiveInflow('link', 'guide'), 'link');
    assert.strictEqual(U.effectiveInflow('', 'guide'), 'guide');
    assert.strictEqual(U.effectiveInflow('xyz', 'guide'), 'guide', '오타가 공고 값을 이기지 않는다(R15)');
  });
  await t('① 가이드 필수 판정 — 링크 상품 줄은 가이드가 없어도 된다 · 따름 줄은 공고 값으로', () => {
    const rows = [
      { opt_key: '21호', inflow_type: 'guide', inflow_guide_html: '<b>검색</b>', inflow_guide_images: [] },
      { opt_key: '23호', inflow_type: 'link', inflow_guide_html: '', inflow_guide_images: [] },
      { opt_key: '25호', inflow_type: null, inflow_guide_html: '', inflow_guide_images: [] },
    ];
    assert.deepStrictEqual(U.guideMissingUnits(rows, 'guide'), ['25호']);
    assert.deepStrictEqual(U.guideMissingUnits(rows, 'link'), [], '전부 링크인 공고는 따름 줄도 가이드가 필요 없다(종전 동작)');
    assert.deepStrictEqual(U.guideMissingUnits([{ optKey: 'A', inflowType: 'guide', inflowGuideHtml: '', inflowGuideImages: ['x'] }], 'link'), [],
      '사진만 있어도 가이드가 있는 것이다(화면 옵션 모양도 받는다)');
    assert.deepStrictEqual(U.guideMissingUnits([{ optKey: 'A', inflowType: 'guide' }], 'link'), ['A'], '링크 공고 안의 가이드 상품은 가이드가 필요하다');
  });
  await t('① 옛 인트라넷 창 — 키가 빠진 상품에 저장된 값을 옮겨 붙인다 · 옮길 것이 없으면 받은 글자 그대로', () => {
    const cur = JSON.stringify(PRODUCTS);
    const old = JSON.stringify(PRODUCTS.map(({ inflow_type, ...p }) => p));
    const kept = JSON.parse(U.keepUnitInflowTypes(cur, old));
    assert.deepStrictEqual(kept.map(p => p.inflow_type), ['guide', 'link']);
    const none = JSON.stringify([{ name: 'A', product_mode: 'none', options: [] }]);
    assert.strictEqual(U.keepUnitInflowTypes(none, old), old, '저장본에 상품별 값이 없으면 바이트 그대로');
    assert.strictEqual(U.keepUnitInflowTypes(cur, cur), cur, '이미 키가 있으면 바이트 그대로(덮지 않는다)');
    const renamed = JSON.stringify([{ name: '23호 큰것', prev_name: '23호', product_mode: 'none', options: [] }]);
    assert.strictEqual(JSON.parse(U.keepUnitInflowTypes(cur, renamed))[0].inflow_type, 'link', '이름을 바꾼 상품은 원래 이름으로 찾는다');
    assert.strictEqual(U.keepUnitInflowTypes(cur, ''), '', '상품 구성을 안 보낸 저장은 그대로');
    assert.strictEqual(U.keepUnitInflowTypes('not json', old), old);
  });
  await t('① 능력 표시 — bidir.inflow 1/true/"1" 만', () => {
    assert.strictEqual(U.inflowCapable({ bidir: { inflow: 1 } }), true);
    assert.strictEqual(U.inflowCapable({ bidir: { inflow: '1' } }), true);
    assert.strictEqual(U.inflowCapable({ bidir: { guide: 1 } }), false);
    assert.strictEqual(U.inflowCapable({}), false);
    assert.strictEqual(U.inflowCapable({ bidir: [1] }), false);
  });

  // ── ② 접수 정규화 ──
  await t('② 접수 정규화 — 상품별 값은 남기고 빈 값·오타는 키째 뺀다(빈 값 ≠ 키 없음 가짜 차이 방지 · R13)', () => {
    const { normalizeProductOptionsJson } = require('../src/services/productOptions.service');
    const raw = JSON.stringify([
      { ...PRODUCTS[0] }, { ...PRODUCTS[1] },
      { name: '25호', product_mode: 'none', options: [], inflow_type: '' },
      { name: '27호', product_mode: 'none', options: [], inflow_type: 'mixed' },
    ]);
    const out = normalizeProductOptionsJson(raw).value;
    assert.deepStrictEqual(out.map(p => Object.prototype.hasOwnProperty.call(p, 'inflow_type') ? p.inflow_type : '∅'), ['guide', 'link', '∅', '∅']);
  });

  // ── ③ 선택지 추출 · 발행 프리필 ──
  await t('③ 선택지 추출(금액·유입 전파 공용)에 상품 유입방식이 실린다 · 옵션은 상품을 따른다', () => {
    const { payAmountsFromWorkOrder } = require('../src/utils/workOrderPayAmounts');
    const withOpt = [...PRODUCTS, { name: '30호', product_mode: 'opt', inflow_type: 'link', base: { pay: 0 },
      options: [{ option_1: { name: '색', value: '빨강' }, label: '빨강', pay: 9000 }] }];
    const units = payAmountsFromWorkOrder(JSON.stringify(withOpt)).units;
    assert.deepStrictEqual(units.map(u => [u.optKey || u.productName, u.inflowType]), [['21호', 'guide'], ['23호', 'link'], ['빨강', 'link']]);
    assert.strictEqual(payAmountsFromWorkOrder(JSON.stringify([{ name: 'A', base: { pay: 1 }, options: [] }])).units[0].inflowType, '', '키 없음 = 따름');
  });
  await t('③ 발행 프리필 줄(화면 원본 = 서버 사본)에 상품별 유입방식이 실린다', () => {
    const { _woCampaignPrefill } = require('../src/utils/woCampaignPrefill.generated');
    const pre = _woCampaignPrefill({ inflow_type: 'guide', product_options_json: JSON.stringify(PRODUCTS) });
    assert.deepStrictEqual(pre.options.map(o => [o.productName, o.unitKind, o.inflowType]), [['21호', 'product', 'guide'], ['23호', 'product', 'link']]);
    assert.strictEqual(pre.inflowType, 'guide', '공고 전체 값은 종전처럼 하나(섞이면 가이드)');
    const old = _woCampaignPrefill({ inflow_type: 'link', product_options_json: JSON.stringify(PRODUCTS.map(({ inflow_type, ...p }) => p)) });
    assert.deepStrictEqual(old.options.map(o => o.inflowType), ['', ''], '옛 오더 = 따름(종전 동작)');
    const front = R('../frontend/js/work-order-detail.js');
    assert.ok(/inflowType: prodInflow,/.test(front) && (front.match(/inflowType: prodInflow,/g) || []).length === 2, '화면 원본 두 갈래(옵션·옵션 없는 상품) 모두');
  });

  // ── ④ 리뷰어 화면 ──
  const wdSrc = R('../frontend/js/campaign-workdetail.js');
  const M = vm.runInNewContext(wdSrc + '; window.CampWorkDetail',
    { window: {}, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } } });
  const card = (so, d = {}) => M.cardsHtml({ workDetail: { inflowGuideHtml: '<b>21호 검색 경로</b>' }, landingUrl: 'https://shop.example/21', inflowType: 'guide', ...d, selectedOption: so });
  await t('④ 섞인 공고 · 링크 상품 리뷰어 — 그 상품 주소 버튼 + 링크 안내(가이드 상품의 공통 경로로 접지 않는다)', () => {
    const html = card({ optKey: '23호', unitKind: 'product', optionUrl: 'https://shop.example/23', inflowType: 'link' });
    assert.ok(html.includes('data-cwd-landing="https://shop.example/23"'), html);
    assert.ok(!html.includes('21호 검색 경로'), '남의 상품 검색 경로가 보이면 안 된다');
    assert.ok(/링크유입 — 아래 버튼/.test(html));
  });
  await t('④ 섞인 공고 · 가이드 상품 리뷰어 — 버튼 없음(유입가이드 무력화 방지 · 결정 124)', () => {
    const html = card({ optKey: '21호', unitKind: 'product', optionUrl: 'https://shop.example/21', inflowType: 'guide', inflowGuideHtml: '<b>21호 수건 검색</b>' });
    assert.ok(!html.includes('data-cwd-landing'), html);
    assert.ok(html.includes('21호 수건 검색'));
  });
  await t('④ 링크 상품인데 상품 주소가 비면 — 공고 대표 주소(다른 상품)로 접지 않고 안내만(R8)', () => {
    const html = card({ optKey: '23호', unitKind: 'product', optionUrl: '', inflowType: 'link' });
    assert.ok(!html.includes('data-cwd-landing'), '대표 주소 = 21호 — 남의 상품을 사게 된다');
    assert.ok(/상품 주소가 아직 등록되지 않았어요/.test(html));
  });
  await t('④ 줄 값이 없으면 종전 그대로 — 링크 공고는 대표 주소 버튼 · 가이드 공고는 버튼 없음', () => {
    assert.ok(card({ optKey: 'A', unitKind: 'product', optionUrl: '' }, { inflowType: 'link', workDetail: {} }).includes('data-cwd-landing="https://shop.example/21"'));
    assert.ok(!card({ optKey: 'A', unitKind: 'product', optionUrl: 'https://x/a' }).includes('data-cwd-landing'));
  });
  await t('④ 링크 공고 안의 가이드 상품 — 버튼 없음(줄 값이 공고 값을 이긴다)', () => {
    const html = card({ optKey: 'A', unitKind: 'product', optionUrl: 'https://x/a', inflowType: 'guide', inflowGuideHtml: '<i>경로</i>' }, { inflowType: 'link' });
    assert.ok(!html.includes('data-cwd-landing'), html);
  });
  await t('④ 서버 선택지 뷰가 유입방식을 싣는다(SELECT 칸 없으면 "" = 종전)', () => {
    const CS = require('../src/services/campaignState.service');
    const base = { opt_key: 'A', recruit_total: 5, daily_limit: 0, status: 'active' };
    assert.strictEqual(CS.computeOptionView({ ...base, inflow_type: 'link' }, {}, { state: 'open' }).inflowType, 'link');
    assert.strictEqual(CS.computeOptionView(base, {}, { state: 'open' }).inflowType, '');
    const routes = R('src/routes/campaign.routes.js');
    assert.ok(/status, inflow_type,\n\s*product_name, unit_kind, inflow_guide_html, inflow_guide_images, thumbnail_url, paused_at\n\s*FROM campaign_options WHERE campaign_id=\$1/.test(routes), '리뷰어 작업 안내가 읽는 선택지 조회');
  });

  // ── ⑤ 공고 저장 검사 ──
  const routes = R('src/routes/campaign.routes.js');
  const fnSrc = routes.slice(routes.indexOf('function _validateActiveUnitInflowGuides('), routes.indexOf('\n}\n', routes.indexOf('function _validateActiveUnitInflowGuides(')) + 2);
  const V = vm.runInNewContext(fnSrc + '; _validateActiveUnitInflowGuides', { guideMissingUnits: U.guideMissingUnits });
  await t('⑤ 공고 저장 — 가이드 공고 안의 링크 상품 줄은 가이드를 요구하지 않는다', () => {
    const opts = [
      { optKey: '21호', status: null, inflowType: 'guide', inflowGuideHtml: '<b>g</b>', inflowGuideImages: [] },
      { optKey: '23호', status: null, inflowType: 'link', inflowGuideHtml: '', inflowGuideImages: [] },
    ];
    assert.strictEqual(V('guide', opts), '');
    assert.match(V('guide', [{ ...opts[1], inflowType: '' }]), /23호/, '따름 줄은 종전대로 가이드 필요');
    assert.strictEqual(V('link', [{ ...opts[1], inflowType: '' }]), '', '링크 공고는 종전대로 검사 없음');
    assert.strictEqual(V('guide', [{ ...opts[1], status: 'closed', inflowType: '' }]), '', '마감 줄 제외(종전)');
  });
  await t('⑤ 유입방식을 안 보낸 줄(옛 공고 창 · null)은 저장된 줄 값으로 판정한다', () => {
    const opt = { optKey: '23호', status: null, inflowType: null, inflowGuideHtml: '', inflowGuideImages: [] };
    assert.strictEqual(V('guide', [opt], new Map([['23호', 'link']])), '');
    assert.match(V('guide', [opt], new Map()), /23호/);
  });
  await t('⑤ 저장 — 안 보냄(null)은 저장값 유지(COALESCE) · 연결 공고는 줄 유입방식을 쓰지 않는다(공유 저장만)', () => {
    assert.ok(/inflow_type=COALESCE\(\$16, campaign_options\.inflow_type\)/.test(routes));
    assert.ok(/COALESCE\(\$16,''\),NOW\(\)\)/.test(routes), '새 줄은 빈 값(따름)');
    assert.ok(/\.map\(o => \(\{ \.\.\.o, status: null, inflowType: null \}\)\)/.test(routes), '연결 공고 = null(유지)');
    assert.ok(/const storedInflow = new Map\(storedInflowRows\.map/.test(routes) && /_validateActiveUnitInflowGuides\(requestedInflowType, normOpts, storedInflow\)/.test(routes));
  });

  // ── ⑥ 양방향 판정·적용 ──
  const SP = require('../src/services/sharedPatch.service');
  const { ABSENT } = require('../src/utils/sharedPatchPlan');
  await t('⑥ 쓸 수 있는 칸 — 상품의 유입방식만(옵션 칸은 막힘 · 옵션은 상품을 따른다)', () => {
    assert.strictEqual(SP.writablePath({ meta: { kind: 'leaf', key: 'inflow_type', parent: 'p:23호' }, base: ABSENT, mine: 'link' }, 'intranet'), true);
    assert.strictEqual(SP.writablePath({ meta: { kind: 'leaf', key: 'inflow_type', parent: 'p:23호' }, base: 'link', mine: ABSENT }, 'intranet'), true);
    assert.strictEqual(SP.writablePath({ meta: { kind: 'leaf', key: 'inflow_type', parent: 'p:30호|o:빨강' }, base: ABSENT, mine: 'link' }, 'intranet'), false);
  });
  await t('⑥ 적용 — 값이면 쓰고 키 없음이면 지운다(따름) · 표시가 선다 · 다른 칸 무접촉', () => {
    const theirs = { product_options_json: JSON.stringify(PRODUCTS.map(({ inflow_type, ...p }) => p)) };
    const mine = { product_options_json: JSON.stringify(PRODUCTS) };
    const w = (name, mineV) => ({ path: `p:${name}.inflow_type`, meta: { kind: 'leaf', key: 'inflow_type', parent: `p:${name}` }, base: ABSENT, mine: mineV });
    const out = SP.applyWrites(theirs, mine, [w('21호', 'guide'), w('23호', 'link')]);
    assert.deepStrictEqual(out.missed, []);
    assert.strictEqual(out.inflowUnitTouched, true);
    const next = JSON.parse(out.next.product_options_json);
    assert.deepStrictEqual(next.map(p => p.inflow_type), ['guide', 'link']);
    assert.deepStrictEqual(next.map(p => p.base.pay), [10000, 12000], '금액 무접촉');
    const back = SP.applyWrites({ product_options_json: JSON.stringify(PRODUCTS) }, { product_options_json: JSON.stringify(PRODUCTS.map(({ inflow_type, ...p }) => p)) },
      [{ ...w('23호', ABSENT), base: 'link' }]);
    assert.ok(!('inflow_type' in JSON.parse(back.next.product_options_json)[1]), '섞임이 풀리면 키를 뺀다');
  });
  await t('⑥ 링크 상품의 "가이드 안 실음"은 지움이 아니다 — 판정이 그 상품의 유입방식을 본다(R10)', () => {
    const src = R('src/services/sharedPatch.service.js');
    assert.ok(/const dropGuide = w => isGuide\(w\) && \(p\.guideCapable === false \|\| \(linkInflow\(w\) && w\.mine === ABSENT\)\);/.test(src));
    assert.ok(/return \(unitInflowType\(prod && prod\.inflow_type\) \|\| String\(\(p\.mine && p\.mine\.inflow_type\) \|\| ''\)\.trim\(\)\) !== 'guide';/.test(src));
  });

  // ── ⑦ 진짜 PostgreSQL ──
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  await pg.query(`CREATE TABLE work_orders(id TEXT PRIMARY KEY, linked_campaign_id TEXT, deleted_at TIMESTAMPTZ)`);
  await pg.query(`CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY, source_work_order_id TEXT, linked_sheet_id TEXT, linked_tab_name TEXT,
    participation_mode BOOLEAN DEFAULT TRUE, work_detail JSONB, landing_url TEXT DEFAULT '', channel TEXT, channel_custom TEXT,
    window_start TIME, window_end TIME, time_range TEXT DEFAULT '', updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pg.query(`CREATE TABLE campaign_options(id SERIAL PRIMARY KEY, campaign_id TEXT, opt_key TEXT, product_name TEXT, unit_kind TEXT DEFAULT 'option',
    status TEXT DEFAULT 'active', sort_order INT DEFAULT 0, option_url TEXT DEFAULT '', product_url TEXT,
    inflow_guide_html TEXT NOT NULL DEFAULT '', inflow_guide_images JSONB NOT NULL DEFAULT '[]'::jsonb,
    inflow_type TEXT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`);
  const client = { query: (sql, params) => pg.query(String(sql), params || []), release: () => {} };
  async function reset({ wdType = 'guide', b = {} } = {}) {
    for (const tb of ['campaign_options', 'recruit_campaigns', 'work_orders']) await pg.query(`DELETE FROM ${tb}`);
    await pg.query(`INSERT INTO work_orders(id, linked_campaign_id) VALUES('wo_1','camp_1')`);
    await pg.query(`INSERT INTO recruit_campaigns(id, source_work_order_id, work_detail) VALUES('camp_1','wo_1',$1::jsonb)`, [JSON.stringify({ inflowType: wdType })]);
    await pg.query(`INSERT INTO campaign_options(campaign_id, opt_key, product_name, unit_kind, option_url, inflow_guide_html, inflow_type)
      VALUES('camp_1','21호','21호','product','https://shop.example/21','<b>검색</b>','guide'),
            ('camp_1','23호','23호','product','https://shop.example/23',$1,$2)`, [b.html || '', b.type === undefined ? null : b.type]);
  }
  const optRows = async () => (await pg.query(`SELECT opt_key, COALESCE(inflow_type,'') AS t, inflow_guide_html AS h FROM campaign_options ORDER BY opt_key`)).rows;
  const wdOf = async () => (await pg.query(`SELECT work_detail FROM recruit_campaigns WHERE id='camp_1'`)).rows[0].work_detail;
  const camp = { id: 'camp_1' };
  const order = (products, inflow_type = 'guide') => ({ inflow_type, product_options_json: JSON.stringify(products) });
  const runProj = async (next, written = [], extra = {}) => {
    await pg.query('BEGIN');
    const r = await SP.projectToCampaignInTx(client, camp, next, new Set(written), false, { prev: {}, inflowUnitTouched: true, ...extra });
    await pg.query(r.reject ? 'ROLLBACK' : 'COMMIT');
    return r;
  };

  await t('⑦ 공유 저장 — 섞인 오더(21호 가이드 · 23호 링크)가 공고 줄 값으로 실제 저장된다 · 23호 가이드 없어도 통과', async () => {
    await reset();
    const r = await runProj(order(PRODUCTS));
    assert.ok(!r.reject, JSON.stringify(r.reject));
    assert.deepStrictEqual((await optRows()).map(x => [x.opt_key, x.t]), [['21호', 'guide'], ['23호', 'link']]);
  });
  await t('⑦ 공유 저장 — 23호를 링크→가이드로 바꾸는데 가이드가 없으면 **통째로 되돌린다**(최종 상태 판정)', async () => {
    await reset({ b: { type: 'link' } });
    const next = order([PRODUCTS[0], { ...PRODUCTS[1], inflow_type: 'guide' }]);
    const r = await runProj(next);
    assert.ok(r.reject && r.reject.out.reason === 'guide_missing', JSON.stringify(r));
    assert.deepStrictEqual(r.reject.out.detail.missing, ['23호']);
    assert.strictEqual((await optRows())[1].t, 'link', '되돌림 뒤 DB 무변경');
  });
  await t('⑦ 공유 저장 — 링크→가이드 + 가이드를 같은 저장에 넣으면 통과(가이드 투영 뒤에 검사한다)', async () => {
    await reset({ b: { type: 'link' } });
    const next = order([PRODUCTS[0], { ...PRODUCTS[1], inflow_type: 'guide', guide: { text: '23호 검색', images: [] } }]);
    const r = await runProj(next, [], { guideTouched: true });
    assert.ok(!r.reject, JSON.stringify(r.reject));
    const rows = await optRows();
    assert.strictEqual(rows[1].t, 'guide');
    assert.ok(/23호 검색/.test(rows[1].h), rows[1].h);
  });
  await t('⑦ 공유 저장 — 섞임이 풀려 전부 링크(오더 전체 link · 키 없음)면 공고 전체 값과 줄 값이 함께 바뀐다', async () => {
    await reset({ b: { type: 'link' } });
    const next = order(PRODUCTS.map(({ inflow_type, guide, ...p }) => p), 'link');
    const r = await runProj(next, ['inflow_type']);
    assert.ok(!r.reject, JSON.stringify(r.reject));
    assert.strictEqual((await wdOf()).inflowType, 'link');
    assert.deepStrictEqual((await optRows()).map(x => x.t), ['', ''], '줄 값은 따름으로');
  });
  await t('⑦ 공유 저장 — 상품별 값이 있는데 공고에서 그 줄을 못 찾으면 거부(오더만 바뀌지 않게)', async () => {
    await reset();
    const r = await runProj(order([PRODUCTS[0], { ...PRODUCTS[1], name: '99호' }]));
    assert.ok(r.reject && r.reject.out.reason === 'option_key_mismatch', JSON.stringify(r));
    assert.match(r.reject.error, /99호/);
  });

  await t('⑦ 공유 저장 — 옵션 줄 없는 공고를 링크→가이드로 바꾸는데 공통 가이드가 비면 거부(164 · 종전 유입 전파 검사를 옮긴 자리)', async () => {
    await reset({ wdType: 'link' });
    await pg.query('DELETE FROM campaign_options');
    const r = await runProj({ inflow_type: 'guide', product_options_json: '' }, ['inflow_type'], { inflowUnitTouched: false });
    assert.ok(r.reject && r.reject.out.reason === 'guide_missing', JSON.stringify(r));
    assert.deepStrictEqual(r.reject.out.detail.missing, ['공통 유입가이드']);
    assert.strictEqual(r.reject.error, undefined, '유입방식만 바뀐 저장은 종전 거부 모양(문구는 campaignSyncNotice)');
    assert.strictEqual((await wdOf()).inflowType, 'link', '되돌림');
  });
  await t('⑦ 공유 저장 — 같은 저장에 공통 가이드를 넣으면 통과(공통 가이드까지 쓴 뒤 검사한다)', async () => {
    await reset({ wdType: 'link' });
    await pg.query('DELETE FROM campaign_options');
    const r = await runProj({ inflow_type: 'guide', inflow_guide: '검색창에 「수건」 검색', product_options_json: '' }, ['inflow_type', 'inflow_guide'], { inflowUnitTouched: false });
    assert.ok(!r.reject, JSON.stringify(r.reject));
    const wd = await wdOf();
    assert.strictEqual(wd.inflowType, 'guide');
    assert.ok(/수건/.test(wd.inflowGuideHtml || ''), JSON.stringify(wd));
  });

  const sync = require('../src/services/campaignPayAmountSync.service');
  sync.__setPoolForTest({ connect: async () => client });
  await t('⑦ 옛 원본 수정 경로 — 상품 구성이 바뀌면 줄 유입방식을 쓰고 줄마다 가이드를 검사한다(실제 저장)', async () => {
    await reset();
    const r = await sync.syncCampaignInflow({ workOrderId: 'wo_1', productOptionsJson: JSON.stringify(PRODUCTS), by: 'test' });
    assert.ok(r.applied, JSON.stringify(r));
    assert.deepStrictEqual((await optRows()).map(x => x.t), ['guide', 'link']);
  });
  await t('⑦ 옛 원본 수정 경로 — 링크→가이드인데 가이드 없음 = 거부 + 되돌림', async () => {
    await reset({ b: { type: 'link' } });
    const r = await sync.syncCampaignInflow({ workOrderId: 'wo_1', productOptionsJson: JSON.stringify([PRODUCTS[0], { ...PRODUCTS[1], inflow_type: 'guide' }]), by: 'test' });
    assert.strictEqual(r.reason, 'guide_missing', JSON.stringify(r));
    assert.strictEqual((await optRows())[1].t, 'link');
  });

  // ── ⑧ 배선 ──
  await t('⑧ 옛 인트라넷 창 값 보존은 원본 수정의 모든 갈래(공유 저장·담당자·종전 경로) 앞에서 한 번', () => {
    const o = R('src/routes/order.routes.js');
    const keep = o.indexOf("optionsJson = require('../utils/unitInflow').keepUnitInflowTypes(current.product_options_json, optionsJson)");
    assert.ok(keep > 0 && /if \(optionsJson && !require\('\.\.\/utils\/unitInflow'\)\.inflowCapable\(b\)\) \{/.test(o));
    const firstUse = o.indexOf('_qnaLockedFields(current, b, optionsJson)');
    assert.ok(keep < firstUse && keep < o.indexOf('return await _intakeSourceBidir(res, { b, source, current, optionsJson'), '갈라지기 전에');
    assert.ok(/const PRODUCT_OPTION_EDITABLE_KEYS = new Set\(\['url', 'guide', 'pay', 'inflow_type'\]\);/.test(o), '접수 뒤 상품별 유입방식 수정 허용(사용자 확정 「가」)');
  });
  await t('⑧ 필수 스키마 · 마이그레이션은 칸 추가만', () => {
    assert.ok(/\['campaign_options', 'inflow_type'\]/.test(R('index.js')));
    const mig = R('migrations/213_campaign_option_inflow_type.sql').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
    assert.ok(/ALTER TABLE campaign_options ADD COLUMN IF NOT EXISTS inflow_type TEXT NULL;/.test(mig));
    assert.ok(!/UPDATE|CHECK|DEFAULT|DROP|TRIGGER/i.test(mig), mig);
  });

  console.log(`\n  통과 ${pass} · 실패 ${fail}`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
