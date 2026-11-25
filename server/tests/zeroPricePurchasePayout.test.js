/**
 * 회귀가드 — 결정 376 「0원 구매 · 리뷰비만」 일반(우리 은행) 작업 지급 (사용자 확정 2026-11-16)
 *
 * 사고(2026-11-16 신고): 휴그로 자사몰 두 작업(각 10줄) — 리뷰어가 0원에 구매(작업표 결제금액 "0" · 리뷰오더 결제금액 0)했고
 *   리뷰비 1,500원만 보내면 되는데, 입금관리가 「결제금액 조회안됨」(no_price)으로 보류해 입금관리에 안 올라왔다.
 *   보완 카드는 "결제금액 칸을 채우면 풀립니다"라고 안내했는데, 그대로 상품값을 적으면 상품값 + 리뷰비가 함께 나간다(과지급).
 *
 * 고정하는 것(fail-closed — 하나라도 아니면 종전처럼 보류):
 *   §1 판정 단일 출처 payment.zeroPricePurchaseOf — 우리 은행 · Q&A 아님 · 제품비 0 · 작업표 결제금액 **명시적 0**
 *      · 주문 금액(있으면) 명시적 0 · 연결 리뷰오더 결제금액 0(옵션 금액도 0) · 리뷰비 > 0
 *   §2 입금 대상 배선 — 대상이 되면 금액 = 리뷰비 · no_price 없음 · zeroPricePurchase 표시 / 아니면 보류 그대로
 *      (빈칸·문자·음수·리뷰오더 없음·리뷰오더 금액>0·주문 금액>0·리뷰비 0·split 0원·업체입금 표기)
 *   §3 「리뷰비만 보낸 건」(isFeeOnlyItem/feeOnlyItemSql) 판정에서 빠진다 → 결과 반영 때 입금일·지급완료가 일반 건처럼 남는다
 *      · 결과 반영/통장 확인/입금일 다시 쓰기 세 경로 모두 표시를 싣는다 · 회차 담기는 서버가 다시 계산한 값만 박제
 *   §4 스키마 — migration 224 · 부팅 필수 칸
 *
 * 끝까지 실행(대상 → 회차 → 결과 반영 → 작업표 입금일)은 진짜 PG 시험 zeroPricePurchasePayoutPg.test.js(PGTEST_URL).
 * 실행: node tests/zeroPricePurchasePayout.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e)); fail++; }
}
const ROOT = path.join(__dirname, '..');
const SRC = p => path.join(ROOT, 'src', p);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

function withStubPool(handler, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const modPath = require.resolve(SRC('services/payment.service'));
  const advPath = require.resolve(SRC('services/advertiserPayout.service'));
  const stub = {
    query: async (sql, params) => (await handler(String(sql), params)) || { rows: [], rowCount: 0 },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[modPath]; delete require.cache[advPath];
  return Promise.resolve()
    .then(() => run(require(modPath)))
    .finally(() => {
      delete require.cache[modPath]; delete require.cache[advPath];
      if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
    });
}

const WO_ZERO = JSON.stringify([{ name: '더스트 휴그로 H', product_mode: 'none', base: { pay: 0, count: 10, daily: 2 }, options: [] }]);
/* o.amount: 작업표 결제금액 칸 값 · o.bank: 공고 이체은행 · o.fee · o.goods: 리뷰오더 물건비
   o.wo: 리뷰오더(null = 연결 리뷰오더 없음) { pay, options } · o.coordPrice: 좌표 주문 금액(undefined = 좌표 주문 없음)
   o.linkedPrices: 작업표 줄에 연결된 주문 금액들(공고 경유 주문) · o.linkedFail: 그 조회 실패 · o.kind: 공고 종류 */
function payHandler(o = {}) {
  const wo = o.wo === undefined ? { pay: 0, options: WO_ZERO } : o.wo;
  const woCols = wo ? { workOrderId: 'wo_1', workOrderPayAmount: wo.pay, workOrderOptionsJson: wo.options }
    : { workOrderId: null, workOrderPayAmount: null, workOrderOptionsJson: null };
  return (sql) => {
    if (/FROM review_index ri/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 3, reviewerName: '김리뷰', phone8: '12345678',
      startDate: '11 / 3 (월)', productName: '더스트 휴그로 H',
      amountCells: o.amount === undefined ? {} : { '결제금액': o.amount },
    }] };
    if (/SELECT transfer_bank FROM tab_configs/.test(sql)) return { rows: [{ transfer_bank: '' }] };
    if (/SELECT transfer_bank FROM recruit_campaigns/.test(sql)) return { rows: [] };
    if (/FROM recruit_campaigns c/.test(sql)) return { rows: [{
      id: 'camp_1', title: '휴그로 자사몰', sheetId: 'S1', tabName: 'T1', reviewFee: o.fee === undefined ? 1500 : o.fee,
      transferBank: o.bank || 'kbank', transferMemo: '휴그로망고', goodsCostType: o.goods || '계산서(농협)',
      workKind: o.kind || 'review', ...woCols }] };
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{ sheetId: 'S1', tabName: 'T1', label: '휴그로 자사몰',
      transferBank: '', depositName: '', goodsCostType: o.goods || '계산서(농협)', workKind: '', ...woCols }] };
    if (/zero_price_linked_orders/.test(sql)) {
      if (o.linkedFail) throw new Error('db down');
      return { rows: (o.linkedPrices || ['0']).map(p => ({ sheetId: 'S1', tabName: 'T1', rowIndex: 3, price: p })) };
    }
    if (/FROM order_submissions/.test(sql) && !/FROM unnest/.test(sql)) return { rows: o.coordPrice === undefined ? [] : [{
      sheetId: 'S1', tabName: 'T1', sheetRow: 3, price: o.coordPrice, feeSnapshot: null, orderedAt: '2026-11-03T09:00:00+09:00',
      bank: '국민은행', account: '12345678901', depositor: '김리뷰' }] };
    if (/FROM unnest/.test(sql) && /order_submissions/.test(sql) && /os\.bank/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 3, bank: '국민은행', account: '12345678901', depositor: '김리뷰',
      orderedAt: '2026-11-03T09:00:00+09:00' }] };
    return { rows: [] };
  };
}
/* 스텁 pool 에는 동시진행 묶음 조회 재료가 없어 dual_bundle_check_failed 가 붙는다(이 검사와 무관한 스텁 한계) — 그 사유만 빼고 본다 */
const _otherIssues = it => (it.issues || []).filter(x => x !== 'dual_bundle_check_failed');
const list = o => withStubPool(payHandler(o), async svc => {
  const r = await svc.listPaymentTargets({ includeFinished: true, includeAdvertiserPaid: true });
  assert.strictEqual(r.items.length, 1, '대상 계산에 줄이 실려야 한다');
  return r.items[0];
});

(async function main() {
  const pay = require(SRC('services/payment.service'));
  const amt = require(SRC('utils/paymentAmount'));

  console.log('\n§1 판정 단일 출처');
  await ta('1a 명시적 0 표기 — "0"·"0원"·"0 원"·"00"·"0,000"만 참 · 빈칸·문자·음수·소수·기호는 거짓', () => {
    assert.strictEqual(typeof amt.isExplicitZeroAmountText, 'function', 'isExplicitZeroAmountText 가 없다');
    for (const v of ['0', ' 0 ', '0원', '0 원', '00', '0,000']) assert.strictEqual(amt.isExplicitZeroAmountText(v), true, v);
    for (const v of ['', ' ', null, undefined, '-', '-0', '0.0', '무료', '₩0', '0원?', '1500', '10', 'O']) {
      assert.strictEqual(amt.isExplicitZeroAmountText(v), false, String(v));
    }
  });
  await ta('1a2 행 단위 — 정확일치 칸(결제금액·금액…)의 값만 본다 · 부분일치 칸(옵션금액)의 0 은 인정하지 않는다', () => {
    assert.strictEqual(amt.rowAmountIsExplicitZero({ '결제금액': '0' }), true);
    assert.strictEqual(amt.rowAmountIsExplicitZero({ '결제 금액': '0원' }), true);
    assert.strictEqual(amt.rowAmountIsExplicitZero({ '결제금액': '', '옵션금액': '0' }), false, '결제금액 빈칸');
    assert.strictEqual(amt.rowAmountIsExplicitZero({ '옵션금액': '0' }), false, '부분일치만');
    assert.strictEqual(amt.rowAmountIsExplicitZero({ '결제금액': '15900', '옵션금액': '0' }), false);
    assert.strictEqual(amt.rowAmountIsExplicitZero({ '결제금액': '-' }), false);
    assert.strictEqual(amt.rowAmountIsExplicitZero(null), false);
    assert.strictEqual(amt.rowAmountIsExplicitZero({}), false);
  });
  const base = { payoutMode: 'ours', isQna: false, productPrice: 0, workboardAmountZero: true, orderPrices: ['0'],
    workOrder: { payAmount: 0, optionsJson: WO_ZERO }, fee: 1500 };
  await ta('1b zeroPricePurchaseOf — 모든 조건이 맞을 때만 참', () => {
    assert.strictEqual(typeof pay.zeroPricePurchaseOf, 'function', 'zeroPricePurchaseOf 가 없다');
    assert.strictEqual(pay.zeroPricePurchaseOf(base), true);
    assert.strictEqual(pay.zeroPricePurchaseOf({ ...base, orderPrices: [] }), true, '주문이 없는 손 입력 줄도 리뷰오더 0 이면 대상');
  });
  await ta('1c ★ fail-closed — 하나라도 아니면 거짓(종전처럼 보류)', () => {
    const no = (patch, why) => assert.strictEqual(pay.zeroPricePurchaseOf({ ...base, ...patch }), false, why);
    no({ payoutMode: 'split' }, 'split(제품비 업체) 0원은 종전 not_purchased');
    no({ payoutMode: 'advertiser' }, '업체입금');
    no({ payoutMode: undefined }, '모드 모름');
    no({ isQna: true }, 'Q&A 는 자기 규칙(321)');
    no({ productPrice: 1000 }, '제품비 있음');
    no({ workboardAmountZero: false }, '작업표 결제금액이 명시적 0 아님');
    no({ workboardAmountZero: undefined }, '값 모름');
    no({ orderPrices: ['15900'] }, '주문 금액 > 0');
    no({ orderPrices: ['0', ''] }, '주문 금액 모름');
    no({ orderPrices: null }, '주문 금액 조회 실패');
    no({ workOrder: null }, '연결 리뷰오더 없음');
    no({ workOrder: { payAmount: 159000, optionsJson: WO_ZERO } }, '리뷰오더 결제금액 > 0');
    no({ workOrder: { payAmount: null, optionsJson: WO_ZERO } }, '리뷰오더 결제금액 모름');
    no({ workOrder: { payAmount: 0, optionsJson: JSON.stringify([{ name: 'x', base: { pay: 15900 }, options: [] }]) } }, '옵션 1건 금액 > 0');
    no({ workOrder: { payAmount: 0, optionsJson: JSON.stringify([{ name: 'x', base: { pay: 0 }, options: [{ label: '대', pay: 3000 }] }]) } }, '옵션 금액 > 0');
    no({ workOrder: { payAmount: 0, optionsJson: '{깨진' } }, '옵션 표 깨짐');
    no({ fee: 0 }, '리뷰비 0(보낼 돈 없음)');
    no({ fee: null }, '리뷰비 모름');
  });

  console.log('\n§2 입금 대상 배선(스텁 DB · 실제 listPaymentTargets)');
  await ta('2a ★★ 휴그로 모양 — 작업표 "0" · 공고 경유 주문 0 · 리뷰오더 0 · 케이뱅크 · 리뷰비 1,500 → 대상 · 금액 1,500', async () => {
    const it = await list({ amount: '0' });
    assert.deepStrictEqual(_otherIssues(it), [], JSON.stringify(it.issues));
    assert.strictEqual(it.amount, 1500); assert.strictEqual(it.productPrice, 0); assert.strictEqual(it.reviewFee, 1500);
    assert.strictEqual(it.zeroPricePurchase, true); assert.strictEqual(it.isQna, false);
    assert.strictEqual(it.payoutMode, 'ours'); assert.strictEqual(it.bank, 'kbank');
  });
  const held = async (o, issue, why) => {
    const it = await list(o);
    assert.ok(it.issues.includes(issue), why + ' → ' + JSON.stringify(it.issues));
    assert.strictEqual(it.payable, false, why);
    assert.notStrictEqual(it.zeroPricePurchase, true, why);
  };
  await ta('2b 결제금액 빈칸 → no_price 보류 그대로', () => held({ amount: '' }, 'no_price', '빈칸'));
  await ta('2c 결제금액 칸 없음 → no_price', () => held({}, 'no_price', '칸 없음'));
  await ta('2d 결제금액 "무료"(문자) → no_price', () => held({ amount: '무료' }, 'no_price', '문자'));
  await ta('2e 결제금액 "-"(미정 표기) → no_price', () => held({ amount: '-' }, 'no_price', '미정'));
  await ta('2e2 ★ 결제금액 빈칸인데 다른 금액 칸(옵션금액)만 "0" → no_price', async () => {
    const it = await withStubPool((() => { const h = payHandler({ amount: '' }); return (sql, p) => {
      const r = h(sql, p); if (/FROM review_index ri/.test(sql)) r.rows[0].amountCells = { '결제금액': '', '옵션금액': '0' }; return r; }; })(),
      async svc => (await svc.listPaymentTargets({ includeFinished: true, includeAdvertiserPaid: true })).items[0]);
    assert.ok(it.issues.includes('no_price') && !it.payable && it.zeroPricePurchase !== true, JSON.stringify(it.issues));
  });
  await ta('2f 리뷰오더 없음 → no_price', () => held({ amount: '0', wo: null }, 'no_price', '리뷰오더 없음'));
  await ta('2g ★ 리뷰오더 결제금액 > 0 인데 작업표 0 → no_price(제품값 미확인 — 리뷰비만 보내고 끝내지 않는다)', () =>
    held({ amount: '0', wo: { pay: 159000, options: JSON.stringify([{ name: 'x', base: { pay: 15900 }, options: [] }]) } }, 'no_price', '리뷰오더 금액'));
  await ta('2h 공고 경유 주문 금액 > 0 인데 작업표 0 → no_price', () => held({ amount: '0', linkedPrices: ['15900'] }, 'no_price', '주문 금액'));
  await ta('2i 연결 주문 금액 조회 실패 → no_price(fail-closed)', () => held({ amount: '0', linkedFail: true }, 'no_price', '조회 실패'));
  await ta('2j 리뷰비 0 → 보류(zero_amount · no_price)', async () => {
    const it = await list({ amount: '0', fee: 0 });
    assert.strictEqual(it.payable, false); assert.ok(it.issues.includes('no_price'), JSON.stringify(it.issues));
  });
  await ta('2k ★ split(제품비 업체 · 리뷰비 케이) 0원 → not_purchased 그대로(불변)', () =>
    held({ amount: '0', bank: 'split_kbank' }, 'not_purchased', 'split'));
  await ta('2l ★ 물건비 업체입금 + 우리 은행(결정 369) → order_goods_by_advertiser 그대로(풀어도 다른 보류는 남는다)', async () => {
    const it = await list({ amount: '0', goods: '업체입금(입금명: 휴그로)' });
    assert.ok(it.issues.includes('order_goods_by_advertiser'), JSON.stringify(it.issues));
    assert.strictEqual(it.payable, false);
  });
  await ta('2m 업체입금 작업 → advertiser_pays 맨 앞 그대로', async () => {
    const it = await list({ amount: '0', bank: 'advertiser' });
    // 스텁에는 업체 연결이 없어 _orphan 이 붙는다 — 맨 앞이 업체입금 사유인 것만 본다
    assert.ok(/^advertiser_pays/.test(it.issues[0]), JSON.stringify(it.issues)); assert.strictEqual(it.payable, false);
  });
  await ta('2n 결제금액이 있는 보통 줄은 종전 그대로(제품비 + 리뷰비 · 표시 없음)', async () => {
    const it = await list({ amount: '15,900', wo: { pay: 159000, options: JSON.stringify([{ name: 'x', base: { pay: 15900 }, options: [] }]) } });
    assert.deepStrictEqual(_otherIssues(it), []); assert.strictEqual(it.amount, 17400);
    assert.strictEqual(it.zeroPricePurchase, false);
  });
  await ta('2o Q&A 는 종전 그대로(isQna · 표시는 Q&A 쪽 하나)', async () => {
    const it = await list({ amount: undefined, kind: 'qna' });
    assert.deepStrictEqual(_otherIssues(it), []); assert.strictEqual(it.isQna, true); assert.strictEqual(it.zeroPricePurchase, false);
  });

  console.log('\n§3 「리뷰비만 보낸 건」 판정 제외 · 결과 반영 배선');
  await ta('3a isFeeOnlyItem — 0원 구매 표시가 있으면 리뷰비만 아님(JS · 두 표기)', () => {
    assert.strictEqual(pay.isFeeOnlyItem({ product_price: 0, review_fee: 1500, amount: 1500, zero_price_purchase: true }), false);
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 0, reviewFee: 1500, amount: 1500, zeroPricePurchase: true }), false);
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 0, reviewFee: 1500, amount: 1500 }), true, 'split 리뷰비만은 그대로');
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 0, reviewFee: 1500, amount: 1500, zeroPricePurchase: false, isQna: false }), true);
  });
  await ta('3b feeOnlyItemSql — 0원 구매 표시면 빠진다(Q&A 제외도 그대로)', () => {
    const s = pay.feeOnlyItemSql('i');
    assert.ok(/NOT COALESCE\(i\.is_qna, FALSE\)/.test(s), s);
    assert.ok(/NOT COALESCE\(i\.zero_price_purchase, FALSE\)/.test(s), s);
  });
  await ta('3c 결과 반영 항목 보기(_itemView)·입금일 다시 쓰기 조회가 표시를 싣는다', () => {
    const r = read('src/services/paymentResult.service.js');
    assert.ok(/zeroPricePurchase: r\.zero_price_purchase === true/.test(r), '_itemView');
    assert.ok(/i\.amount, i\.is_qna, i\.zero_price_purchase,/.test(r), '입금일 다시 쓰기 조회');
  });
  await ta('3d ★ 통장 확인(자동·수동) 항목도 Q&A·0원 구매 표시를 싣는다(빠지면 입금일 없이 끝난다)', () => {
    const b = read('src/services/paymentBank.service.js');
    const fn = b.match(/async function _loadBatchItems\([\s\S]*?\n\}/);
    assert.ok(fn, '_loadBatchItems');
    assert.ok(/isQna: r\.is_qna === true/.test(fn[0]) && /zeroPricePurchase: r\.zero_price_purchase === true/.test(fn[0]), fn[0]);
  });
  await ta('3e 회차 담기 — 서버가 다시 계산한 대상값으로만 박제(제품비 0 · 금액 = 리뷰비일 때만)', () => {
    const p = read('src/services/payment.service.js');
    assert.ok(/amount, transfer_memo, is_qna, zero_price_purchase\$\{/.test(p), 'INSERT 칸');
    // 결정 411 — 예약리뷰 무료체험형(bookingFree)도 같은 표시로 박제하지만 모양 확인(제품비 0 · 금액 = 리뷰비)은 그대로 뒤에 붙는다
    assert.ok(/\(it\.zeroPricePurchase === true(?: \|\| it\.bookingFree === true)?\) && Number\(it\.productPrice\) === 0 && Number\(it\.amount\) === Number\(it\.reviewFee\)/.test(p), '박제 조건');
  });
  await ta('3f 동시진행 묶음 줄은 이 규칙을 쓰지 않는다(종전 no_price 그대로)', () => {
    const p = read('src/services/payment.service.js');
    assert.ok(/if \(it\.zeroPricePurchase\) \{ it\.zeroPricePurchase = false; it\.issues = \[\.\.\.new Set\(\[\.\.\.it\.issues, 'no_price'\]\)\]; \}/.test(p));
  });

  console.log('\n§4 스키마');
  await ta('4a migration 224 · 부팅 필수 칸', () => {
    const m = read('migrations/224_payment_item_zero_price_purchase.sql');
    assert.ok(/ALTER TABLE payment_batch_items ADD COLUMN IF NOT EXISTS zero_price_purchase BOOLEAN NOT NULL DEFAULT FALSE/.test(m));
    assert.ok(/\['payment_batch_items', 'zero_price_purchase'\]/.test(read('index.js')));
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
