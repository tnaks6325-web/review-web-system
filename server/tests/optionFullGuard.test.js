/**
 * 결정 252 — 정원 찬 상품 바로 구매: 상품 1개 공고는 표기와 무관하게 센다 · 구매양식 안내 · 작업보드 ⚠ "정원 넘친 상품 구매".
 *
 * 발단(운영 2026-10-14): 고양이사료 1번 상품 126/100(10/2 구매양식 링크 바로 구매 25명 — 정원을 보지 않는 길) ·
 *   블랑카우 크림(상품 1개 공고) 바로 구매 29건 중 15건을 "이름 표기가 달라" 상품에 못 세어 200 중 185로 보임.
 *
 *   [1] 상품 1개 공고 = 표기가 달라도·비어 있어도 그 상품(matchOrderOption) · 2개 이상은 종전(못 맞추면 null)
 *   [2] 끄는 스위치 CAMPAIGN_OPTION_SINGLE_FALLBACK=0 = 종전
 *   [3] 위반 코드·이름(option_full) — 표시 문구는 서버 이름표 하나
 *   [4] 구매 시점에 이미 정원이 찼나(optionFullAtPurchase · 스텁 DB 로 실제 실행) — 마지막 자리는 위반 아님 · 셈에 안 들어간 주문은 아님 · 모름은 throw
 *   [5] 구매양식 안내 재료(서버 배선) — 참여 버튼과 같은 셈(soldout) · 실패 = 안내 없음
 *   [6] 화면 — 막지 않는다 · 상품마다 한 번 · 제출 직전 확인 · 옛 서버(필드 없음) = 안내 없음
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const st = require('../src/services/campaignState.service');
const rules = require('../src/services/directPurchaseRules.service');

let pass = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { console.log('  ✗', name); throw e; }
}

const ONE = [{ opt_key: '쿠팡 블랑카우 고보습 리페어크림  쿠팡상품번호: 9323064309 - 27634035119', product_name: '쿠팡 블랑카우 고보습 리페어크림  쿠팡상품번호: 9323064309 - 27634035119' }];
const TWO = [{ opt_key: '3. 퀸더블', product_name: '3. 퀸더블' }, { opt_key: '4. 킹(분리난방)', product_name: '4. 킹(분리난방)' }];

(async () => {
  console.log('[1] 상품 1개 공고는 표기와 무관하게 그 상품');
  await ok('표기가 다른 바로 구매(「…1개, 200ml」) → 그 상품', () => {
    assert.strictEqual(st.matchOrderOption(ONE, { selectedProduct: '블랑카우 고보습 리페어크림 1개, 200ml' }), ONE[0].opt_key);
  });
  await ok('상품 칸이 비어 있어도 → 그 상품', () => {
    assert.strictEqual(st.matchOrderOption(ONE, {}), ONE[0].opt_key);
  });
  await ok('상품 2개 공고에서 못 맞추면 종전대로 null(대충 비슷하면 귀속 금지 — 결정 210)', () => {
    assert.strictEqual(st.matchOrderOption(TWO, { selectedProduct: '탄소매트 1개' }), null);
    assert.strictEqual(st.matchOrderOption(TWO, {}), null);
  });
  await ok('마감 상품까지 2개면 예외 아님(살아 있는 상품이 1개여도 null)', () => {
    const withClosed = [{ ...TWO[0], status: 'closed' }, TWO[1]];
    assert.strictEqual(st.matchOrderOption(withClosed, { selectedProduct: '탄소매트 1개' }), null);
  });
  await ok('상품 2개 공고의 정확한 짝짓기는 그대로', () => {
    assert.strictEqual(st.matchOrderOption(TWO, { selectedProduct: '4. 킹(분리난방)' }), '4. 킹(분리난방)');
  });

  console.log('[2] 끄는 스위치');
  await ok('CAMPAIGN_OPTION_SINGLE_FALLBACK=0 → 종전(표기가 다르면 null)', () => {
    const out = execFileSync(process.execPath, ['-e', `
      const st = require(${JSON.stringify(path.join(__dirname, '../src/services/campaignState.service'))});
      console.log(JSON.stringify(st.matchOrderOption(${JSON.stringify(ONE)}, { selectedProduct: '블랑카우 고보습 리페어크림 1개, 200ml' })));`],
    { env: { ...process.env, CAMPAIGN_OPTION_SINGLE_FALLBACK: '0' } }).toString().trim();
    assert.strictEqual(out, 'null');
  });

  console.log('[3] 위반 코드·이름');
  await ok('option_full = "정원 넘친 상품 구매"', () => {
    assert.strictEqual(rules.RULE_LABELS.option_full, '정원 넘친 상품 구매');
  });
  await ok('optionFull true 일 때만 붙는다(모름·false 는 안 붙음)', () => {
    const base = { registered: true, repurchaseBlocked: false, onePerPersonBlocked: false, popular: false, todayBefore: 0, dailyCap: 10 };
    assert.deepStrictEqual(rules.collectFlags({ ...base, optionFull: true }), [{ code: 'option_full' }]);
    assert.deepStrictEqual(rules.collectFlags({ ...base, optionFull: false }), []);
    assert.deepStrictEqual(rules.collectFlags({ ...base }), []);
  });
  await ok('판정이 실제로 그 값을 쓴다(judgeDirectPurchase → optionFullAtPurchase → collectFlags)', () => {
    const src = read('server/src/services/directPurchaseRules.service.js');
    const j = src.slice(src.indexOf('async function judgeDirectPurchase'), src.indexOf('function judgeLater'));
    assert.ok(/const optionFull = await optionFullAtPurchase\(db, camp\.id, o\);/.test(j));
    assert.ok(/dailyCap: _dailyCap\(\), optionFull,/.test(j));
  });

  console.log('[4] 구매 시점에 이미 정원이 찼나(스텁 DB 로 실제 실행)');
  const KEY = TWO[0].opt_key;
  const AT = '2026-10-02T06:00:00.000Z';
  const mkDb = ({ cap = 2, ext = [], apps = 0, extFail = false } = {}) => ({
    calls: [],
    async query(sql, params) {
      this.calls.push(sql);
      if (/SELECT opt_key, recruit_total FROM campaign_options/.test(sql)) return { rows: TWO.map(o => ({ opt_key: o.opt_key, recruit_total: o.opt_key === KEY ? cap : 50 })) };
      if (/SELECT campaign_id, opt_key, product_name FROM campaign_options/.test(sql)) return { rows: TWO.map(o => ({ campaign_id: 'c1', ...o })) };
      if (/DISTINCT ON/.test(sql)) {
        if (extFail) throw new Error('boom');
        return { rows: ext.map(e => ({ campaign_id: 'c1', order_id: e.id, submitted_at: new Date(e.at), selected_product: e.p, is_today: false })) };
      }
      if (/FROM campaign_applications/.test(sql) && /COUNT/.test(sql)) {
        assert.strictEqual(params[1], KEY, '같은 상품의 공고 참여만 센다');
        assert.strictEqual(params[3], '73000001', '구매자 본인 연락처를 넘겨 자기 자리를 뺀다');
        assert.ok(/NOT \(phone8 = \$4 AND \$4 <> ''\)/.test(sql), '본인이 잡아 둔 살아 있는 자리는 앞선 자리로 세지 않는다');
        return { rows: [{ n: apps }] };
      }
      throw new Error('unexpected sql: ' + sql.slice(0, 80));
    },
  });
  const me = { id: 'o-me', submitted_at: AT, phone8: '73000001' };
  const before = (id) => ({ id, at: '2026-10-02T05:00:00.000Z', p: KEY });
  const after = (id) => ({ id, at: '2026-10-02T07:00:00.000Z', p: KEY });
  await ok('정원 2 · 앞에 바로 구매 1 + 공고 참여 1 → 이 구매는 정원 찬 뒤(true)', async () => {
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ ext: [before('o1'), { id: 'o-me', at: AT, p: KEY }], apps: 1 }), 'c1', me), true);
  });
  await ok('정원 2 · 앞에 1명 → 이 구매가 마지막 자리(false)', async () => {
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ ext: [before('o1'), { id: 'o-me', at: AT, p: KEY }], apps: 0 }), 'c1', me), false);
  });
  await ok('뒤에 들어온 구매는 이 구매의 자리를 빼앗지 않는다(false)', async () => {
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ ext: [after('o2'), after('o3'), { id: 'o-me', at: AT, p: KEY }], apps: 1 }), 'c1', me), false);
  });
  await ok('셈에 안 들어간 주문(상품 모름·중복) → false', async () => {
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ ext: [before('o1'), before('o2')], apps: 5 }), 'c1', me), false);
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ ext: [{ id: 'o-me', at: AT, p: '모르는 상품' }], apps: 5 }), 'c1', me), false);
  });
  await ok('같은 시각이면 주문 id 순(결정적) — id 가 앞선 것만 "앞"', async () => {
    const same = (id) => ({ id, at: AT, p: KEY });
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ cap: 1, ext: [same('o-a'), { id: 'o-me', at: AT, p: KEY }] }), 'c1', me), true);
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ cap: 1, ext: [same('o-z'), { id: 'o-me', at: AT, p: KEY }] }), 'c1', me), false);
  });
  await ok('정원 0(무제한) → false', async () => {
    assert.strictEqual(await rules.optionFullAtPurchase(mkDb({ cap: 0, ext: [before('o1'), { id: 'o-me', at: AT, p: KEY }], apps: 9 }), 'c1', me), false);
  });
  await ok('정원 셈 조회 실패 → throw(판정 전체가 모름 — "위반 없음"으로 적지 않는다)', async () => {
    await assert.rejects(() => rules.optionFullAtPurchase(mkDb({ extFail: true }), 'c1', me));
  });
  await ok('끄는 스위치 DIRECT_PURCHASE_OPTION_FULL_FLAG=0 → false(DB 조회 없음)', async () => {
    process.env.DIRECT_PURCHASE_OPTION_FULL_FLAG = '0';
    try {
      const db = mkDb({ ext: [before('o1'), { id: 'o-me', at: AT, p: KEY }], apps: 5 });
      assert.strictEqual(await rules.optionFullAtPurchase(db, 'c1', me), false);
      assert.strictEqual(db.calls.length, 0);
    } finally { delete process.env.DIRECT_PURCHASE_OPTION_FULL_FLAG; }
  });

  await ok('정원 엔진 스위치(CAMPAIGN_OPTION_EXTERNAL_ORDERS=0)가 꺼져 있으면 이 항목만 false — throw 로 다른 위반 표시까지 지우지 않는다', () => {
    const out = execFileSync(process.execPath, ['-e', `
      const r = require(${JSON.stringify(path.join(__dirname, '../src/services/directPurchaseRules.service'))});
      const db = { calls: 0, async query() { this.calls++; return { rows: [] }; } };
      r.optionFullAtPurchase(db, 'c1', { id: 'x', submitted_at: new Date() }).then(v => console.log(JSON.stringify({ v, calls: db.calls })), e => console.log('THROW ' + e.message));`],
    { env: { ...process.env, CAMPAIGN_OPTION_EXTERNAL_ORDERS: '0' } }).toString().trim();
    assert.strictEqual(out, '{"v":false,"calls":0}');
  });
  await ok('캡처로 상품을 채우는 제출은 채운 **뒤에** 판정(먼저 돌면 "위반 없음"으로 굳는다)', () => {
    const sr = read('server/src/routes/submit.routes.js');
    assert.ok(/_judgeAfterCapFill = true;/.test(sr));
    assert.ok(/\.finally\(\(\) => require\('\.\.\/services\/directPurchaseRules\.service'\)\.judgeLater\(_cap\.orderSubmissionId, 'submit'\)\)/.test(sr));
    assert.ok(/if \(!_judgeAfterCapFill\) require\('\.\.\/services\/directPurchaseRules\.service'\)\.judgeLater\(ledger\.orderSubmissionId, 'submit'\);/.test(sr));
  });

  console.log('[5] 구매양식 안내 재료(서버 배선)');
  const r = read('server/src/routes/campaign.routes.js');
  const fn = r.slice(r.indexOf('async function _orderFormOptionFull'), r.indexOf("router.get('/order-form-gate'"));
  const gate = r.slice(r.indexOf("router.get('/order-form-gate'"), r.indexOf('\n});', r.indexOf("router.get('/order-form-gate'")));
  await ok('참여 버튼과 같은 셈(fetchOptionCounts + computeOptionViews 의 soldout)', () => {
    assert.ok(/fetchOptionCounts\(pool, camp\.id, now\)/.test(fn) && /computeOptionViews\(optRows, counts, null, \{ sequential \}\)/.test(fn));
    assert.ok(/v\.status === 'soldout'/.test(fn));
  });
  await ok('양식 표기 → 상품은 바로 구매를 세는 것과 같은 짝짓기(matchOrderOption) · 양식 선택지는 같은 함수(listProductChoices)', () => {
    assert.ok(/matchOrderOption\(optRows, \{ selectedProduct: label \}\)/.test(fn) && /listProductChoices\(pool, sheetId, tabName\)/.test(fn));
  });
  await ok('보관 공고·스위치 끔·실패 = null(안내 없음 · fail-open)', () => {
    assert.ok(/camp\.archived_at/.test(fn) && /ORDER_FORM_OPTION_FULL_NOTICE === '0'/.test(fn));
    assert.ok(/catch \(e\) \{[\s\S]*return null;/.test(fn));
  });
  await ok('일반 공고에도 싣고, 인기 공고 응답에도 싣는다(참여권 판정은 무접촉)', () => {
    assert.ok(/return res\.json\(\{ ok: true, gate: false, \.\.\.of \}\)/.test(gate));
    assert.ok(/gate: credits <= 0, credits, campaignId: camp\.id, title: String\(camp\.title \|\| ''\), \.\.\.of \}\)/.test(gate));
  });

  console.log('[6] 화면');
  const sa = read('frontend/js/search-app.js');
  const ui = sa.slice(sa.indexOf('let _OPTION_FULL = null;'), sa.indexOf('function initOrderFormMode('));
  await ok('막지 않는다 — [그래도 제출하기] = 계속(true) · 닫기·Esc 도 계속', () => {
    assert.ok(/data-of-continue/.test(ui) && /if \(e\.target\.closest\("\[data-of-continue\]"\)\) finish\(true\);/.test(ui));
    assert.ok(/if \(e\.key === "Escape"\) finish\(true\);/.test(ui));
  });
  await ok('기존 구매양식 창 모양(새 스타일 없음)', () => {
    assert.ok(/ov\.id = "ofOptionFull";\s*ov\.className = "modal-overlay";/.test(ui) && /class="modal-box"/.test(ui) && /class="modal-actions"/.test(ui));
  });
  await ok('상품마다 한 번만 묻는다 · 정원 찬 상품만', () => {
    assert.ok(/g\.fullProducts\.indexOf\(label\) < 0 \|\| g\.acked\[label\]\) return;\s*g\.acked\[label\] = true;/.test(ui));
  });
  await ok('옛 서버(필드 없음) = 안내 없음 · 인기 안내가 먼저(겹치지 않게)', () => {
    assert.ok(/_OPTION_FULL = \(of && of\.campaignId && Array\.isArray\(of\.fullProducts\)\)/.test(ui));
    assert.ok(/if \(document\.getElementById\("ofOptionFull"\) \|\| document\.getElementById\("ofPopularGate"\)\)/.test(ui));
    assert.ok(ui.indexOf('await _popularGateModal(_POPULAR_GATE, { cards: 1 })') < ui.indexOf('_OPTION_FULL.singleFull) {'));
  });
  await ok('제출 직전 확인은 인기 공고 확인 뒤 · 공고로 가면 제출하지 않는다', () => {
    const i1 = sa.indexOf('if (!(await _popularGateBeforeSubmit()))');
    const i2 = sa.indexOf('if (!(await _optionFullBeforeSubmit()))');
    assert.ok(i1 > 0 && i2 > i1 && i2 - i1 < 600);
    assert.ok(/if \(!\(await _optionFullBeforeSubmit\(\)\)\) \{ try \{ location\.href = "campaign\.html\?id=" \+ encodeURIComponent\(_OPTION_FULL\.campaignId\); \} catch \(_\) \{\} return; \}/.test(sa));
  });
  await ok('다른 안내 창 때문에 못 띄우면("busy") 안내한 것으로 치지 않는다 — 제출 직전에 다시 묻는다', () => {
    assert.ok(/getElementById\("ofPopularGate"\)\) \{ resolve\("busy"\); return; \}/.test(ui));
    assert.ok(/_optionFullModal\(g, label\)\.then\(v => \{ if \(v === "busy"\) delete g\.acked\[label\]; \}\);/.test(ui));
    assert.ok(/if \(v === "busy"\) \{ delete g\.acked\[label\]; continue; \}/.test(ui));
  });
  await ok('상품을 고를 때·캡처로 골라 둘 때 안내(함수가 없으면 아무것도 안 함)', () => {
    assert.ok(/if \(typeof _optionFullOnPick === "function"\) _optionFullOnPick\(_OFP\.pick\[c\]\);/.test(sa));
    assert.ok(/if \(_OFP\.pick\[cid\] === ok && typeof _optionFullOnPick === "function"\) _optionFullOnPick\(ok\);/.test(sa));
  });

  console.log(`\n✅ optionFullGuard: ${pass} passed`);
})().catch(e => { console.error(e); process.exit(1); });
