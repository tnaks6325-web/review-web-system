/**
 * 결정 252 — 정원 찬 상품 바로 구매: 상품 1개 공고는 표기와 무관하게 센다 · 구매양식 접수 거절 · 작업보드 ⚠ "정원 넘친 상품 구매".
 *
 * 발단(운영 2026-10-14): 고양이사료 1번 상품 126/100(10/2 구매양식 링크 바로 구매 25명 — 정원을 보지 않는 길) ·
 *   블랑카우 크림(상품 1개 공고) 바로 구매 29건 중 15건을 "이름 표기가 달라" 상품에 못 세어 200 중 185로 보임.
 *
 *   [1] 상품 1개 공고 = 표기가 달라도·비어 있어도 그 상품(matchOrderOption) · 2개 이상은 종전(못 맞추면 null)
 *   [2] 끄는 스위치 CAMPAIGN_OPTION_SINGLE_FALLBACK=0 = 종전
 *   [3] 위반 코드·이름(option_full) — 표시 문구는 서버 이름표 하나
 *   [4] 구매 시점에 이미 정원이 찼나(optionFullAtPurchase · 스텁 DB 로 실제 실행) — 마지막 자리는 위반 아님 · 셈에 안 들어간 주문은 아님 · 모름은 throw
 *   [5] 구매양식 정원 판정(서버) — 참여 버튼과 같은 셈(soldout) · 안내와 거절이 같은 함수 · 쓰기 전 거절 · 모르면 받음 · 스위치
 *   [6] 화면 — 「모집 끝」 표시 · 거절 창(그래도 제출하기 없음) · 제출 직전 다시 막음 · 서버 거절 처리 · 스위치를 끄면 종전 안내
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
      if (/SELECT campaign_id, opt_key, product_name(, sole_until)? FROM campaign_options/.test(sql)) return { rows: TWO.map(o => ({ campaign_id: 'c1', ...o })) };   // 195 sole_until 더함(검사 의미 불변)
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

  await ok('구매 시각 기준 자리 — 그사이 만료된 신청도 그때 살아 있었으면 센다(applied·expired 중 expires_at > 구매 시각)', () => {
    const src = read('server/src/services/directPurchaseRules.service.js');
    assert.ok(/status IN \('applied', 'expired'\) AND expires_at > \$3 AND NOT \(phone8 = \$4 AND \$4 <> ''\)/.test(src));
    assert.ok(!/expires_at > NOW\(\)/.test(src.slice(src.indexOf('async function optionFullAtPurchase'), src.indexOf('async function judgeDirectPurchase'))));
  });
  await ok('공고 참여 좌표(campaign:<id>)에 남은 바로 구매는 그 공고로 판정(정원 셈과 같은 공고)', () => {
    const src = read('server/src/services/directPurchaseRules.service.js');
    assert.ok(/const _vm = \/\^campaign:\(\.\+\)\$\/\.exec\(String\(o\.sheet_id \|\| ''\)\);/.test(src));
    assert.ok(/\(_vm && o\.tab_name === o\.sheet_id\)[\s\S]{0,300}WHERE rc\.id = \$1 AND rc\.participation_mode IS TRUE LIMIT 1`, \[_vm\[1\]\]\)/.test(src));
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

  console.log('[5] 구매양식 정원 판정(서버 — 안내와 거절이 같은 함수)');
  const ofsSrc = read('server/src/services/orderFormOptionFull.service.js');
  const ofs = require('../src/services/orderFormOptionFull.service');
  await ok('참여 버튼과 같은 셈(fetchOptionCounts + computeOptionViews 의 soldout) · 짝짓기 matchOrderOption · 양식 선택지 listProductChoices', () => {
    assert.ok(/st\.fetchOptionCounts\(db, camp\.id, now\)/.test(ofsSrc) && /st\.computeOptionViews\(optRows, counts, null, \{ sequential \}\)/.test(ofsSrc));
    assert.ok(/v\.status === 'soldout'/.test(ofsSrc));
    assert.ok(/st\.matchOrderOption\(optRows, \{ selectedProduct: label \}\)/.test(ofsSrc));
    assert.ok(/listProductChoices\(db, camp\.linked_sheet_id \|\| sheetId, camp\.linked_tab_name \|\| tabName\)/.test(ofsSrc), '탭 이름이 바뀐 옛 링크도 공고의 지금 탭으로 선택지를 읽는다');
  });
  await ok('보관·마감 공고·안내 스위치 끔·정원 있는 상품 없음·공고 여럿인 작업표·실패 = null(안내·거절 없음 · fail-open)', () => {
    assert.ok(/camp\.archived_at \|\| camp\.status !== 'active'/.test(ofsSrc) && /ORDER_FORM_OPTION_FULL_NOTICE === '0'/.test(ofsSrc));
    assert.ok(/if \(\(await _liveCampaignsOnTab\(db, camp\)\) > 1\) return null;/.test(ofsSrc));
    assert.ok(/if \(!optRows\.some\(o => Number\(o\.recruit_total\) > 0\)\) return null;/.test(ofsSrc));
    const lf = ofsSrc.slice(ofsSrc.indexOf('async function loadFormOptionFull'), ofsSrc.indexOf('function publicView'));
    assert.ok(/catch \(e\) \{[\s\S]*return null;/.test(lf));
  });
  await ok('화면에 내보낼 때 내부 재료(상품 행·키)는 지운다', () => {
    const pub = ofs.publicView({ campaignId: 'c', fullProducts: [], singleFull: false, blocking: true, _optRows: [1], _fullKeys: new Set(), _singleKey: 'k', _choices: [], _views: new Map() });
    assert.deepStrictEqual(Object.keys(pub).sort(), ['blocking', 'campaignId', 'fullProducts', 'singleFull']);
  });
  await ok('거절 스위치 ORDER_FORM_OPTION_FULL_BLOCK=0 → 거절 없음(DB 조회도 없음) · 응답 blocking:false = 화면은 안내만', async () => {
    process.env.ORDER_FORM_OPTION_FULL_BLOCK = '0';
    try {
      const db = { async query() { throw new Error('조회하면 안 됨'); } };
      assert.strictEqual(await ofs.submitBlock(db, { sheetId: 's', tabName: 't', gid: '', picked: 'x' }), null);
      assert.strictEqual(ofs.blockingEnabled(), false);
    } finally { delete process.env.ORDER_FORM_OPTION_FULL_BLOCK; }
    assert.strictEqual(ofs.blockingEnabled(), true);
  });
  await ok('거절 판정 — 고른 상품이 찼으면 거절 · 상품 하나짜리 양식은 그 하나 · 여러 상품인데 안 골랐으면 받음 · 실패는 받음', () => {
    const sb = ofsSrc.slice(ofsSrc.indexOf('async function _submitBlock'), ofsSrc.indexOf('const BLOCK_MESSAGE'));
    assert.ok(/if \(picked\) key = require\('\.\/campaignState\.service'\)\.matchOrderOption\(info\._optRows, \{ selectedProduct: picked \}\);/.test(sb));
    assert.ok(/else if \(info\._choices\.length < 2\) key = info\._singleKey;/.test(sb));
    assert.ok(/if \(!key \|\| !info\._fullKeys\.has\(key\)\) return null;/.test(sb));
    assert.ok(/catch \(e\) \{[\s\S]*return null;/.test(sb));
    assert.ok(/Promise\.race\(\[_submitBlock\(db, args\), timeout\]\)/.test(sb) && /if \(r === 'timeout'\)[^\n]*return null;/.test(sb), '제한 시간을 넘기면 받는다');
    assert.strictEqual(ofs.BLOCK_MESSAGE, '모집이 끝난 상품이라 접수할 수 없어요. 이미 결제했다면 쿠팡에서 주문을 취소해 주세요.');
  });
  await ok('본인 것 빼고 센다 — 같은 구매가 이미 있으면 받음(원장 중복 처리) · 본인이 잡아 둔 살아 있는 자리는 남의 자리 아님(코드리뷰 🔴)', () => {
    const sb = ofsSrc.slice(ofsSrc.indexOf('async function _submitBlock'), ofsSrc.indexOf('async function submitBlock'));
    assert.ok(/os\.dedup_key = \$1[\s\S]{0,200}= ANY\(\$2::text\[\]\) LIMIT 1`, \[`num:\$\{num\}`, p8s\]\);\s*if \(rows\.length\) return null;/.test(sb));
    assert.ok(/status = 'applied' AND expires_at > NOW\(\)\s*AND \(phone8 = ANY\(\$3::text\[\]\) OR owner_phone8 = ANY\(\$3::text\[\]\)\)/.test(sb));
    assert.ok(/if \(cap > 0 && used < cap\) return null;/.test(sb));
  });
  const sr = read('server/src/routes/submit.routes.js');
  await ok('제출: 아무것도 쓰기 전에 거절 — 신원 확인(정보 보강·기록)과 원장 쓰기보다 앞 · 홀드 문맥·네이버+쿠팡은 대상 아님 · 막힌 시도는 담당자 확인 기록', () => {
    const bi = sr.indexOf("const blocked = await ofs.submitBlock(pool,");
    assert.ok(bi > 0 && bi < sr.indexOf('const _newIdentityGate = reviewerOrderIdentity.isEnabled()') && bi < sr.indexOf('const ledger = await createOrderLedgerEntry({'));
    assert.ok(/if \(!holdCtx && !ncMode\) \{\s*const ofs = require\('\.\.\/services\/orderFormOptionFull\.service'\);/.test(sr));
    assert.ok(/picked: formPickedProduct, choices: formChoices, phones: \[loginPhone8, phone\], orderNum \}\);/.test(sr));
    assert.ok(/AND occurred_at > NOW\(\) - INTERVAL '10 minutes' LIMIT 1/.test(sr), '같은 연락처·주문번호는 10분에 한 번만 기록');
    assert.ok(/orderNum \}\);\s*if \(blocked\) \{/.test(sr), '판정 결과가 있으면 바로 거절 분기');
    const blk = sr.slice(sr.indexOf('      if (blocked) {'), sr.indexOf("error: ofs.BLOCK_MESSAGE });") + 30);
    assert.ok(/return res\.json\(\{ ok: false, code: 'OPTION_FULL'/.test(blk) && !/createOrderLedgerEntry/.test(blk), '거절 분기는 쓰기 없이 응답하고 끝난다');
    assert.ok(/eventType: 'order_option_full_blocked'/.test(sr));
    assert.ok(/return res\.json\(\{ ok: false, code: 'OPTION_FULL', product: blocked\.name, campaignId: blocked\.campaignId, error: ofs\.BLOCK_MESSAGE \}\);/.test(sr));
  });
  await ok('담당자 확인 기록 문구(오류내용·조치안내)', () => {
    const d = require('../src/services/reviewerEventLog.service').describeEvent
      || null;
    const ev = read('server/src/services/reviewerEventLog.service.js');
    assert.ok(/case 'order_option_full_blocked':/.test(ev) && /쿠팡 주문 취소를 안내/.test(ev));
    if (d) { const x = d({ eventType: 'order_option_full_blocked', context: { product: 'A', orderNum: '1' } }); assert.ok(/정원이 찬 상품\(A\)/.test(x.problem)); }
  });
  await ok('양식 응답 — 일반 공고에도 싣고 인기 공고 응답에도 싣는다(참여권 판정 무접촉) · 같은 함수', () => {
    const r = read('server/src/routes/campaign.routes.js');
    const gate = r.slice(r.indexOf("router.get('/order-form-gate'"), r.indexOf('\n});', r.indexOf("router.get('/order-form-gate'")));
    assert.ok(/ofs\.publicView\(camp \? await ofs\.loadFormOptionFull\(pool, camp, \{ sheetId, tabName \}\) : null\)/.test(gate));
    assert.ok(/return res\.json\(\{ ok: true, gate: false, \.\.\.of \}\)/.test(gate));
    assert.ok(/title: String\(camp\.title \|\| ''\), \.\.\.of \}\)/.test(gate));
    assert.ok(/let of = \{\};/.test(gate) && /res\.json\(\{ ok: true, gate: false, unknown: true, \.\.\.of \}\)/.test(gate), '참여권 조회가 실패해도 정원 재료는 버리지 않는다');
  });

  console.log('[6] 화면');
  const sa = read('frontend/js/search-app.js');
  const ui = sa.slice(sa.indexOf('let _OPTION_FULL = null;'), sa.indexOf('function initOrderFormMode('));
  await ok('거절 모드 창 — "접수할 수 없어요" · 취소 안내 · [그래도 제출하기] 없음(닫기/다른 상품 고르기 · 참여 가능한 상품 보기)', () => {
    assert.ok(/block \? '모집이 끝나 접수할 수 없어요'/.test(ui));
    assert.ok(/이미 결제했다면 쿠팡에서 주문을 취소해 주세요/.test(ui));
    assert.ok(/\(block \? \(multi \? '다른 상품 고르기' : '닫기'\) : '이미 구매했어요 — 그래도 제출하기'\)/.test(ui));
  });
  await ok('거절 모드 제출 직전 — 다시 받아 온 뒤 찬 상품이 있으면 제출하지 않는다("stop") · 일부 카드만 찼으면 [나머지 주문만 제출] · 공고 보기만 이동("go")', () => {
    assert.ok(/async function _optionFullBeforeSubmit\(\) \{\s*try \{\s*await _optionFullRefresh\(\);/.test(ui), '제출 직전 항상 다시 받아 온다(첫 요청 대기 포함)');
    assert.ok(/if \(_OPTION_FULL_PENDING\) \{ try \{ await _OPTION_FULL_PENDING; \} catch \(_\) \{\} \}/.test(ui), '첫 요청이 끝나기 전에 제출하면 기다린다');
    assert.ok(/_OPTION_FULL_PENDING = _orderFormPopularGate\(/.test(sa));
    assert.ok(/async function _orderFormPopularGate\(\{ sheetId, tabName, gid, token \}\) \{\s*_OPTION_FULL_SRC = \{ sheetId, tabName, gid, token \};/.test(ui), '첫 요청이 실패해도 다시 받을 주소를 기억');
    assert.ok(/if \(g\.blocking !== false\) \{\s*const g2 = _OPTION_FULL;/.test(ui));
    assert.ok(/const partial = \(!g2\.singleFull && hitCards\.length && hitCards\.length < picks\.length\) \? hitCards : null;/.test(ui));
    assert.ok(/if \(v === "rest" && partial\) return true;\s*return v === false \? "go" : "stop";/.test(ui));
    assert.ok(/data-of-rest>나머지 주문만 제출/.test(ui));
    assert.ok(/const _ofr = await _optionFullBeforeSubmit\(\);\s*if \(_ofr !== true\) \{ if \(_ofr === "go"\)/.test(sa));
  });
  await ok('제출 직전 확인은 인기 공고 확인 뒤', () => {
    const i1 = sa.indexOf('if (!(await _popularGateBeforeSubmit()))');
    const i2 = sa.indexOf('const _ofr = await _optionFullBeforeSubmit();');
    assert.ok(i1 > 0 && i2 > i1 && i2 - i1 < 600);
  });
  await ok('서버가 거절(OPTION_FULL)하면 그 주문은 제출하지 않음으로 처리', () => {
    assert.ok(/if \(!res\.ok && res\.code === "OPTION_FULL"\) \{[\s\S]{0,400}results\.push\([\s\S]{0,200}continue;/.test(sa));
  });
  await ok('상품 고르기에 "모집 끝" 표시 · 응답이 오면 다시 그림', () => {
    assert.ok(/_optionFullIs\(P\[i\]\) \? '<span class="ofp-match ofp-full"/.test(sa));
    assert.ok(/blocking: of\.blocking === true, acked: \{\} \}\s*: null;\s*if \(_OPTION_FULL && typeof _ofpActive === "function" && _ofpActive\(\)\) _orderCardIds\.forEach\(_ofpRender\);/.test(ui));
  });
  await ok('안내 모드(스위치로 거절을 끈 때)는 종전 — 상품마다 한 번 · busy 면 다시 묻기', () => {
    assert.ok(/if \(g\.acked\[label\]\) return;\s*g\.acked\[label\] = true;/.test(ui));
    assert.ok(/_optionFullModal\(g, label\)\.then\(v => \{ if \(v === "busy"\) delete g\.acked\[label\]; \}\);/.test(ui));
  });
  await ok('네이버+쿠팡 모드는 대상 아님(화면)', () => {
    assert.ok(/window\._ncMode\) \? null : j\.optionFull;/.test(ui));
  });
  await ok('기존 구매양식 창 모양(새 스타일 없음) · 옛 서버(필드 없음) = 아무것도 안 함 · 인기 안내와 겹치지 않음', () => {
    assert.ok(/ov\.id = "ofOptionFull";\s*ov\.className = "modal-overlay";/.test(ui) && /class="modal-box"/.test(ui) && /class="modal-actions"/.test(ui));
    assert.ok(/_OPTION_FULL = \(of && of\.campaignId && Array\.isArray\(of\.fullProducts\)\)/.test(ui));
    assert.ok(/getElementById\("ofPopularGate"\)\) \{ resolve\("busy"\); return; \}/.test(ui));
  });
  await ok('상품을 고를 때·캡처로 골라 둘 때 알림(함수가 없으면 아무것도 안 함)', () => {
    assert.ok(/if \(typeof _optionFullOnPick === "function"\) _optionFullOnPick\(_OFP\.pick\[c\]\);/.test(sa));
    assert.ok(/if \(_OFP\.pick\[cid\] === ok && typeof _optionFullOnPick === "function"\) _optionFullOnPick\(ok\);/.test(sa));
  });

  console.log(`\n✅ optionFullGuard: ${pass} passed`);
})().catch(e => { console.error(e); process.exit(1); });
