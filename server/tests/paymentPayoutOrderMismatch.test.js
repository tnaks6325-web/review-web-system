/**
 * 회귀가드 — 리뷰오더 물건비 「업체입금」 ↔ 이체은행 우리 은행 어긋남 (결정 369 · 사용자 요청 2026-11-13 "미연에 방지")
 *
 * 사고: 11/11 플라워민트·누룽칩 3차 — 리뷰오더 물건비는 「업체입금」인데 모집공고 이체은행이 케이뱅크로 저장됐다
 *   (공고를 만들 때 업체가 아직 작업에 연결되지 않아 업체입금 계열을 고를 수 없었다). 그 결과
 *   ① 업체 화면에 리뷰어 계좌가 안 보여 업체가 제품비를 못 보냈고 ② 우리 입금관리는 제품비까지 보내려 했다(이중 입금 위험).
 *
 * 고정하는 것:
 *   §1 판정 단일 출처 payment.goodsCostSaysAdvertiser — 프론트(index-recruit _rfOrderSaysAdv)도 같은 정규식
 *   §2 입금관리 — 이체은행이 우리 은행이고 물건비가 업체입금이면 보류(order_goods_by_advertiser) · 제품비 업체·업체입금이면 해당 없음
 *   §3 배선 — 작업 조건 카드 경고(서버 값 그대로 · 광고주 제외) · 입금관리 라벨·보완 창구 · 모집공고 창 안내·저장 확인
 *
 * 실행: node tests/paymentPayoutOrderMismatch.test.js
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
const FRONT = p => fs.readFileSync(path.join(ROOT, '..', 'frontend', p), 'utf8');

const _tbMod = require(SRC('services/trackB.service'));
_tbMod.advertiserForTab = async () => ({ id: 'adv_1', name: '스마트윈' });

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

/* o.campBank: 공고 이체은행(undefined = 공고 없음) · o.campGoods: 공고의 리뷰오더 물건비 · o.tabBank · o.tabGoods */
function payHandler(o = {}) {
  return (sql) => {
    if (/FROM review_index ri/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 7, reviewerName: '김혜진', phone8: '83540507',
      startDate: '11 / 11 (화)', productName: '인형꽃다발', amountCells: { '결제금액': '21,900' },
    }] };
    if (/SELECT transfer_bank FROM tab_configs/.test(sql)) return { rows: [{ transfer_bank: o.tabBank || '' }] };
    if (/SELECT transfer_bank FROM recruit_campaigns/.test(sql)) return { rows: [] };
    if (/FROM recruit_campaigns c/.test(sql)) return { rows: o.campBank === undefined ? [] : [{
      id: 'camp_1', title: '플라워민트', sheetId: 'S1', tabName: 'T1', reviewFee: 1000, transferBank: o.campBank,
      transferMemo: '네꽃다발만두', goodsCostType: o.campGoods || '' }] };
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{ sheetId: 'S1', tabName: 'T1', label: '플라워민트',
      transferBank: o.tabBank || '', depositName: '네꽃다발만두', goodsCostType: o.tabGoods || '' }] };
    if (/FROM order_submissions/.test(sql) && !/FROM unnest/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', sheetRow: 7, price: '21900', feeSnapshot: null, orderedAt: '2026-11-11T09:00:00+09:00',
      bank: '우리은행', account: '1002345678901', depositor: '김혜진' }] };
    return { rows: [] };
  };
}

/* 스텁 pool 에는 동시진행 묶음 조회 재료가 없어 dual_bundle_check_failed 가 붙는다(이 검사와 무관한 스텁 한계) — 그 사유만 빼고 본다 */
const _otherIssues = it => (it.issues || []).filter(x => x !== 'dual_bundle_check_failed');

(async function main() {
  console.log('\n§1 판정 단일 출처');
  const pay = require(SRC('services/payment.service'));

  await ta('1a 업체입금 표기(입금명 괄호·띄어쓰기·선입금 꼬리)는 참, 그 밖은 거짓', () => {
    for (const v of ['업체입금', '업체입금(입금명: 배성화)', '업체 입금', '업체입금 / 선입금미완료', '제품비 업체입금']) {
      assert.strictEqual(pay.goodsCostSaysAdvertiser(v), true, v);
    }
    for (const v of ['', null, undefined, '계산서(농협)', '현금(하나은행)', '계산서(법인 농협) / 선입금완료', '업체']) {
      assert.strictEqual(pay.goodsCostSaysAdvertiser(v), false, String(v));
    }
  });

  await ta('1b 프론트 판정(_rfOrderSaysAdv)이 서버와 같은 정규식', () => {
    const js = FRONT('js/index-recruit.js');
    const m = js.match(/function _rfOrderSaysAdv\([^)]*\)\s*\{[^\n]*\}/);
    assert.ok(m, '_rfOrderSaysAdv 가 없다');
    assert.ok(m[0].includes('/업체\\s*입금/'), '프론트 정규식이 서버와 다르다');
    assert.ok(/\/업체\\s\*입금\//.test(read('src/services/payment.service.js')), '서버 정규식이 바뀌었다');
  });

  console.log('\n§2 입금관리 — 어긋난 작업은 보류');

  await ta('2a ★★ 공고 이체은행 케이뱅크 + 리뷰오더 물건비 업체입금 = 보류(order_goods_by_advertiser · 이체 불가)', () =>
    withStubPool(payHandler({ campBank: 'kbank', campGoods: '업체입금(입금명: 배성화)' }), async svc => {
      const r = await svc.listPaymentTargets();
      assert.strictEqual(r.items.length, 1);
      assert.ok(r.items[0].issues.includes('order_goods_by_advertiser'), JSON.stringify(r.items[0].issues));
      assert.strictEqual(r.items[0].payable, false);
    }));

  await ta('2b ★ 탭 쪽 물건비(공고 없음)도 같은 판정 — 탭 이체은행 케이뱅크', () =>
    withStubPool(payHandler({ tabBank: '케이뱅크', tabGoods: '업체입금 / 선입금미완료' }), async svc => {
      const r = await svc.listPaymentTargets();
      assert.ok(r.items[0].issues.includes('order_goods_by_advertiser'));
      assert.strictEqual(r.items[0].payable, false);
    }));

  await ta('2c 제품비 업체 · 리뷰비 케이뱅크(split) = 해당 없음(리뷰비만 정상 지급 대상)', () =>
    withStubPool(payHandler({ campBank: 'split_kbank', campGoods: '업체입금(입금명: 배성화)' }), async svc => {
      const r = await svc.listPaymentTargets();
      assert.ok(!r.items[0].issues.includes('order_goods_by_advertiser'), JSON.stringify(r.items[0].issues));
      assert.deepStrictEqual(_otherIssues(r.items[0]), [], JSON.stringify(r.items[0].issues));
      assert.strictEqual(r.items[0].amount, 1000, '리뷰비만');
    }));

  await ta('2d 물건비가 계산서면 종전 그대로(케이뱅크 지급 가능)', () =>
    withStubPool(payHandler({ campBank: 'kbank', campGoods: '계산서(농협)' }), async svc => {
      const r = await svc.listPaymentTargets();
      assert.ok(!r.items[0].issues.includes('order_goods_by_advertiser'));
      assert.deepStrictEqual(_otherIssues(r.items[0]), [], JSON.stringify(r.items[0].issues));
    }));

  await ta('2e 업체입금 작업은 이 사유를 더하지 않는다(맨 앞 사유 advertiser_pays 그대로)', () =>
    withStubPool(payHandler({ campBank: 'advertiser', campGoods: '업체입금' }), async svc => {
      const r = await svc.listPaymentTargets({ includeAdvertiserPaid: true });
      assert.strictEqual(r.items[0].issues[0], 'advertiser_pays');
      assert.ok(!r.items[0].issues.includes('order_goods_by_advertiser'));
    }));

  console.log('\n§3 배선');
  const HTML = FRONT('workdesk.html');
  const TB = read('src/services/trackB.service.js');

  await ta('3a 작업 조건 카드 — 서버가 같은 판정 함수로 transferBankOrderMismatch 를 싣고(우리 은행일 때만), 업체 렌즈에는 없다', () => {
    assert.ok(/transferBankOrderMismatch:\s*payoutMode\.mode === 'ours'\s*&& require\('\.\/payment\.service'\)\.goodsCostSaysAdvertiser\(/.test(TB));
    const lens = TB.slice(TB.indexOf('function _condAdvertiserLens'), TB.indexOf('function _condAdvertiserLens') + 6000);
    assert.ok(!/transferBankOrderMismatch/.test(lens), '업체 렌즈로 새면 안 된다');
  });

  await ta('3b 카드 경고는 서버 값 그대로 · 광고주 제외 · 이체은행 칸 안(새 줄 없음)', () => {
    const fn = HTML.match(/function _cndBankWarn\(cd,kind,isAdv,ddHtml\)\{[\s\S]*?\n\}/);
    assert.ok(fn, '_cndBankWarn 없음');
    assert.ok(/kind!=='bank' \|\| isAdv \|\| !cd \|\| cd\.transferBankOrderMismatch!==true/.test(fn[0]));
    assert.ok(/_cndBankWarn\(cd,kind,isAdv,v==null\?unset\(kind\):val\(v,kind\)\)/.test(HTML), '카드 렌더에 안 걸렸다');
  });

  await ta('3c 입금관리 — 사유 라벨 · 작업 단위 보완(작업 조건으로 가는 버튼)', () => {
    assert.ok(/order_goods_by_advertiser:'리뷰오더 물건비가 업체입금/.test(HTML));
    assert.ok(/no_bank:'work', order_goods_by_advertiser:'work'/.test(HTML));
    assert.ok(/if\(iss\.includes\('no_bank'\) \|\| iss\.includes\('order_goods_by_advertiser'\)\)\{/.test(HTML), '행 보완이 막다른 길');
    assert.ok(/if\(w\.needPayoutMode\) need\.push\(/.test(HTML), '작업 카드에 고칠 것이 안 뜬다');
  });

  await ta('3d 모집공고 창 — 물건비 업체입금이면 안내 줄 + 우리 은행을 새로 고를 때 저장 직전 확인', () => {
    const js = FRONT('js/index-recruit.js');
    const hint = js.match(/function _rfTransferHint[\s\S]{0,1400}?\n}/);
    assert.ok(hint && /if \(_rfOrderSaysAdv\(v\)\) \{ el\.textContent = RF_ORDER_ADV_HINT\(v\)/.test(hint[0]));
    assert.ok(/if \(_rfOrderSaysAdv\(window\._rfLastGoodsCost\) && \(payload\.transfer_bank === "kbank" \|\| payload\.transfer_bank === "hana"\)/.test(js));
    assert.ok(/if \(!confirm\(RF_ORDER_ADV_CONFIRM\)\) \{ _rfSaveBlocked\(/.test(js), '취소하면 저장하지 않아야 한다');
  });

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
