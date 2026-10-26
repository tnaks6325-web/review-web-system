/**
 * qtyTiersPurchaseAmount.test.js — 결정 289 ③-다 회귀가드 (사용자 확정 2026-10-26 「가」)
 *   ① 잘못 구매 판정의 "고른 상품 금액" = 고른 개수의 단계 금액(A 2개 20,000원을 B 1개 가격 20,000원으로 오해하지 않는다)
 *   ② 고른 개수와 다른 개수를 샀으면 묻는다(PRODUCT_QTY_MISMATCH) → 고른 개수 = 접수 + 기록 / 다른 개수 = 제출 불가
 *   ③ 담당자 수동 입력은 개수를 모른다 — 고른 상품이 낼 수 있는 금액(어느 개수든)이면 경고하지 않는다
 *   ④ 구매양식에 고른 개수·금액 표시(표시용 — 판정은 서버가 신청 기록으로)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _queue = [];
function t(name, fn) { _queue.push([name, fn]); }
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const readFront = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', rel), 'utf8');

const pv = require('../src/services/productMismatchVerify.service');
const qt = require('../src/services/campaignQtyTiers.service');

const A = 'A 탄소매트 퀸', B = 'B 탄소매트 킹';
const OPTS = [
  { opt_key: A, product_name: '탄소매트A', status: 'active', pay_amount: 10000 },
  { opt_key: B, product_name: '탄소매트B', status: 'active', pay_amount: 20000 },
];
const TIERS_A = [
  { product_name: '탄소매트A', opt_key: null, qty: 1, people: 5, pay_amount: 10000, buy_method: 'qty', sort_order: 0 },
  { product_name: '탄소매트A', opt_key: null, qty: 2, people: 5, pay_amount: 20000, buy_method: 'qty', sort_order: 1 },
  { product_name: '탄소매트A', opt_key: null, qty: 3, people: 5, pay_amount: 29000, buy_method: 'qty', sort_order: 2 },
];
const ctxOf = (tiers, opts = OPTS) => ({ tiers, optProduct: new Map(opts.map(o => [o.opt_key, o.product_name])) });

function stubDb(routes, opts = {}) {
  return {
    query: async (sql, params) => {
      if (opts.throws) throw new Error('db down');
      if (/\b(UPDATE|INSERT|DELETE)\b/i.test(sql)) throw new Error('쓰기 금지 — 판정은 쓰기 0');
      for (const [re, rows] of routes) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
      return { rows: [] };
    },
  };
}
const tierDb = (tiers = TIERS_A, opts = OPTS, more = []) => stubDb([[/FROM campaign_qty_tiers/, tiers], [/FROM campaign_options/, opts], ...more]);
const HOLD = (over = {}) => ({ verified: true, optionKey: A, campaignId: 'camp_qty', phone8: '12345678', holdToken: 'tok', applicationId: 9,
  purchaseQty: 2, qtyTierAmount: 20000, ...over });

// ── 1. 금액 근거(순수 함수) ──
t('1a 단계가 없으면 종전 판정 그대로(priceOtherOption 4번째 인자 없음 = 결정 230·236)', () => {
  assert.deepStrictEqual(pv.priceOtherOption(OPTS, A, '20,000'), { key: B, paid: 20000, heldPay: 10000 });
  assert.deepStrictEqual(pv.priceOtherOption(OPTS, A, '20,000', null, 20000), { key: B, paid: 20000, heldPay: 10000 }, 'tierCtx=null 이면 heldAmount 무시');
});
t('1b ★ A 2개(20,000원)를 샀는데 B 1개 가격도 20,000원 → 다른 상품 근거 아님(③-다가 막는 오경고)', () => {
  assert.strictEqual(pv.priceOtherOption(OPTS, A, '20,000', ctxOf(TIERS_A), 20000), null);
});
t('1c 고른 상품이 낼 수 있는 다른 개수 금액은 상품 근거가 아니다 — 개수 판정의 몫', () => {
  assert.strictEqual(pv.priceOtherOption(OPTS, A, '10,000', ctxOf(TIERS_A), 20000), null);
  assert.deepStrictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 2, 20000, '10,000원', OPTS), { qty: 1, paid: 10000, heldQty: 2, heldAmount: 20000 });
  assert.deepStrictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 2, 20000, '29000', OPTS), { qty: 3, paid: 29000, heldQty: 2, heldAmount: 20000 });
});
t('1d 고른 개수 금액·어느 금액과도 안 맞는 금액(쿠폰 등) → 아무 일도 없음', () => {
  assert.strictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 2, 20000, '20000', OPTS), null);
  assert.strictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 2, 20000, '17,000', OPTS), null);
  assert.strictEqual(pv.priceOtherOption(OPTS, A, '17,000', ctxOf(TIERS_A), 20000), null);
  assert.strictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 2, 20000, '', OPTS), null);
  assert.strictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 0, 20000, '10000', OPTS), null, '고른 개수 모름');
  assert.strictEqual(pv.qtyOtherTier(ctxOf(TIERS_A), A, 2, 0, '10000', OPTS), null, '고른 금액 모름');
  assert.strictEqual(pv.qtyOtherTier(null, A, 2, 20000, '10000', OPTS), null, '단계 없음');
});
t('1e 단계가 없는 상품(B)을 골랐는데 A 단계 금액을 냄 → 다른 상품 A 하나(그 상품의 단계 금액도 후보)', () => {
  assert.deepStrictEqual(pv.priceOtherOption(OPTS, B, '29,000', ctxOf(TIERS_A), 0), { key: A, paid: 29000, heldPay: 20000 });
  assert.strictEqual(pv.priceOtherOption(OPTS, B, '20,000', ctxOf(TIERS_A), 0), null, 'B 가격 그대로');
});
t('1f 같은 상품 공통 단계를 쓰는 옵션끼리는 금액이 같다 — 상품 근거가 아니고 개수 판정만', () => {
  const sib = [{ opt_key: 'A-블루', product_name: '탄소매트A', status: 'active', pay_amount: 10000 },
               { opt_key: 'A-그레이', product_name: '탄소매트A', status: 'active', pay_amount: 10000 }];
  assert.strictEqual(pv.priceOtherOption(sib, 'A-블루', '10000', ctxOf(TIERS_A, sib), 20000), null);
  assert.deepStrictEqual(pv.qtyOtherTier(ctxOf(TIERS_A, sib), 'A-블루', 2, 20000, '10000', sib).qty, 1);
});
t('1g 같은 금액 개수가 둘이면 모른다 · 1개 단계 줄이 없으면 1개 가격 = 1개 구매', () => {
  const dup = [...TIERS_A, { ...TIERS_A[2], qty: 4, pay_amount: 10000 }];
  assert.strictEqual(pv.qtyOtherTier(ctxOf(dup), A, 2, 20000, '10000', OPTS), null);
  const no1 = TIERS_A.filter(x => x.qty !== 1);
  assert.strictEqual(pv.qtyOtherTier(ctxOf(no1), A, 2, 20000, '10000', OPTS).qty, 1);
});
t('1h 담당자 수동 입력(개수 모름 · heldAmount 없음) — 고른 상품이 낼 수 있는 금액이면 근거 없음', () => {
  for (const p of ['10000', '20000', '29000']) assert.strictEqual(pv.priceOtherOption(OPTS, A, p, ctxOf(TIERS_A)), null, p);
});
t('1i 옵션 없는 공고(고른 키 없음) — 공고 하나의 공통 단계로 개수 판정', () => {
  const one = [{ opt_key: '탄소매트A', product_name: '탄소매트A', status: 'active', pay_amount: 10000 }];
  assert.strictEqual(pv.qtyOtherTier(ctxOf(TIERS_A, one), null, 3, 29000, '20000', one).qty, 2);
});

// ── 2. 제출 때 개수 판정 ──
t('2a ★ 2개를 골랐는데 결제금액이 1개 금액 → prompt(고른/금액이 같은 개수 · 금액)', async () => {
  const d = await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10,000', db: tierDb() });
  assert.strictEqual(d.action, 'prompt');
  assert.deepStrictEqual(d.chosen, { qty: 2, label: '2개', amount: 20000 });
  assert.deepStrictEqual(d.captured, { qty: 1, label: '1개', amount: 10000 });
  assert.strictEqual(d.paid, 10000);
});
t('2b "고른 개수를 샀어요" → keep / "다른 개수" → wrong(제출 불가 문구) / 지어낸 개수 → 다시 prompt', async () => {
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', confirmedQty: '2', db: tierDb() })).action, 'keep');
  const w = await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', confirmedQty: 1, db: tierDb() });
  assert.strictEqual(w.action, 'wrong');
  assert.strictEqual(w.bought.qty, 1);
  assert.ok(/2개와 다른 1개를 구매했어요/.test(w.error) && /제출할 수 없어요/.test(w.error), w.error);
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', confirmedQty: '7', db: tierDb() })).action, 'prompt');
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', confirmedQty: 'abc', db: tierDb() })).action, 'prompt');
});
t('2c 근거 없음 = none(고른 금액 · 다른 상품 금액 · 판독값 없음 · 단계 없음 · 개수 없음 · 이미 접수)', async () => {
  for (const p of ['20000', '17000', '', '30000']) assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: p, db: tierDb() })).action, 'none', p);
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', db: tierDb([]) })).action, 'none');
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD({ purchaseQty: null }), capturePrice: '10000', db: tierDb() })).action, 'none');
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD({ qtyTierAmount: 0 }), capturePrice: '10000', db: tierDb() })).action, 'none');
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD({ doneKind: 'confirmed' }), capturePrice: '10000', db: tierDb() })).action, 'none');
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD({ verified: false }), capturePrice: '10000', db: tierDb() })).action, 'none');
});
t('2d fail-open — 조회 실패 · 스위치 두 개(CAMPAIGN_PRODUCT_VERIFY=0 · CAMPAIGN_QTY_TIERS=0)', async () => {
  assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', db: stubDb([], { throws: true }) })).action, 'none');
  for (const [k, v] of [['CAMPAIGN_PRODUCT_VERIFY', '0'], ['CAMPAIGN_QTY_TIERS', '0']]) {
    const old = process.env[k]; process.env[k] = v;
    try { assert.strictEqual((await pv.decideQtyAtSubmit({ holdCtx: HOLD(), capturePrice: '10000', db: tierDb() })).action, 'none', k); }
    finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; }
  }
});

// ── 3. 상품 판정이 단계 금액을 쓴다 ──
t('3a ★ decideAtSubmit: A 2개 20,000원 → 상품 경고 없음(옛 판정은 "B 가격과 같아요"로 물었다)', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: HOLD(), captureText: '', capturePrice: '20,000', db: tierDb() });
  assert.strictEqual(d.action, 'none');
  const old = await pv.decideAtSubmit({ holdCtx: HOLD(), captureText: '', capturePrice: '20,000', db: tierDb([]) });
  assert.strictEqual(old.action, 'prompt', '단계가 없는 공고는 종전 그대로(대조군)');
  assert.strictEqual(old.basis, 'price');
});
t('3b decideAtSubmit: "고른 상품이 맞다" + 고른 개수 금액 → 다시 묻지 않고 keep', async () => {
  const d = await pv.decideAtSubmit({ holdCtx: HOLD(), captureText: '', capturePrice: '20000', confirmedKey: A, db: tierDb() });
  assert.strictEqual(d.action, 'keep');
  assert.strictEqual(d.priceOther, '');
});
t('3c 단계 조회 실패는 상품 판정 전체를 종전 fail-open 으로(접수)', async () => {
  const db = stubDb([[/FROM campaign_qty_tiers/, () => { throw new Error('boom'); }], [/FROM campaign_options/, OPTS]]);
  assert.strictEqual((await pv.decideAtSubmit({ holdCtx: HOLD(), captureText: '', capturePrice: '20000', db })).action, 'none');
});

// ── 4. 담당자 수동 입력 ──
t('4a checkManualEntries: 단계 공고에서 A 를 고르고 2개 금액 → 금액 경고 없음 / 단계 없는 공고는 종전대로 경고', async () => {
  const items = [{ index: 0, name: '홍', chosenKey: A, price: '20,000' }];
  assert.deepStrictEqual(await pv.checkManualEntries({ campaignId: 'camp_qty', items, db: tierDb() }), []);
  const old = await pv.checkManualEntries({ campaignId: 'camp_qty', items, db: tierDb([]) });
  assert.strictEqual(old.length, 1);
  assert.deepStrictEqual(old[0].kinds, ['price']);
});
t('4b checkManualEntries: 단계 조회 실패 → 종전 판정(경고는 그대로 · 접수를 막지 않는다)', async () => {
  const db = stubDb([[/FROM campaign_qty_tiers/, () => { throw new Error('boom'); }], [/FROM campaign_options/, OPTS]]);
  const out = await pv.checkManualEntries({ campaignId: 'camp_qty', items: [{ index: 0, chosenKey: A, price: '20000' }], db });
  assert.strictEqual(out.length, 1);
});

// ── 5. 연결(정적) ──
t('5a 제출 라우트 — 홀드에서 개수·금액을 같은 왕복으로 읽고, 상품 판정 뒤·신원 게이트 앞에서 개수 판정', () => {
  const r = read('src/routes/submit.routes.js');
  assert.ok(/ca\.purchase_qty, ca\.qty_tier_amount/.test(r));
  assert.ok(/ctx\.purchaseQty = rows\[0\]\.purchase_qty == null \? null/.test(r));
  const iProd = r.indexOf("code: 'PRODUCT_WRONG_PURCHASE', chosen: decision.chosen");
  const iQty = r.indexOf("pv.decideQtyAtSubmit({ holdCtx, capturePrice: b.productCapturePrice, confirmedQty: b.confirmedPurchaseQty })");
  const iId = r.indexOf('B안 — 구매양식 링크로 들어온 리뷰어가 고른');
  assert.ok(iProd > 0 && iQty > iProd && iId > iQty, '순서: 상품 판정 → 개수 판정 → 그 뒤 단계');
  assert.ok(/code: 'PRODUCT_QTY_MISMATCH'/.test(r) && /화면을 새로고침한 뒤 다시 제출해 주세요/.test(r.slice(iQty, iQty + 1200)));
  assert.ok(/step: qd\.action === 'wrong' \? 'wrong_qty_purchase' : 'capture_qty_mismatch_confirmed'/.test(r));
  assert.ok(/if \(qd\.action === 'wrong'\) \{\s*return res\.json\(\{ ok: false, code: 'PRODUCT_WRONG_PURCHASE'/.test(r), '다른 개수 = 제출 불가');
});
t('5b 구매양식 — 개수 확인 창(PRODUCT_QTY_MISMATCH) · 고른 개수로 다시 제출 · 잘못 구매 처리보다 먼저', () => {
  const f = readFront('js/search-app.js');
  const iQ = f.indexOf('res.code === "PRODUCT_QTY_MISMATCH"'), iW = f.indexOf('res.code === "PRODUCT_WRONG_PURCHASE"');
  const iR = f.indexOf('res.code === "PRODUCT_PRICE_RECHECK"');
  assert.ok(iR > 0 && iQ > iR && iW > iQ, '순서: 다시 묻기 → 개수 → 잘못 구매');
  assert.ok(/payload\.confirmedPurchaseQty = pickedQty;/.test(f));
  assert.ok(/const qtyMode = mode === "qty";/.test(f) && /구매 개수를 확인해 주세요/.test(f) && /고른 개수와 다르게 사서/.test(f));
  assert.ok(/qty: Math\.max\(0, Math\.floor\(Number\(q\.get\("qty"\)\) \|\| 0\)\)/.test(f), '표시용 개수는 숫자로만');
  assert.ok(/id="of_qty_note"/.test(f) && /참여한 구매수량/.test(f));
});
t('5c 참여 화면 — 구매양식 주소에 개수·금액(미리보기 제외)', () => {
  const c = readFront('campaign.html');
  assert.ok(/if\(!PREVIEW && j\.qty && j\.qty\.purchaseQty != null\)\{\s*qp\.set\('qty', String\(j\.qty\.purchaseQty\)\);/.test(c));
  assert.ok(c.indexOf("qp.set('qty'") < c.indexOf("const _src = '/search.html?' + qp.toString();"));
});
t('5d 이상로그 단계 이름표', () => {
  const { STEP_LABELS } = require('../src/services/errorLog.service');
  for (const k of ['wrong_qty_purchase', 'capture_qty_mismatch_confirmed']) assert.ok(STEP_LABELS[k], k);
  assert.strictEqual(typeof qt.scopeFor, 'function');
});

(async () => {
  for (const [name, fn] of _queue) {
    try { await fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n     ' + (e && e.message)); }
  }
  console.log(`\n${fail ? '❌' : '✅'} qtyTiersPurchaseAmount: ${pass}개 통과 / ${fail}개 실패`);
  if (fail) process.exit(1);
})();
