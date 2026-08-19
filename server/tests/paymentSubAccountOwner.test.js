/**
 * 회귀가드 — 타계정 참여 건의 입금대상 통과(소유자 계좌 폴백)
 *
 * 실사고(2026-08-19 "김수만/명지수"): 타계정 명의로 참여한 건이 입금대상에서
 * `리뷰어 정보 없음`(no_reviewer)으로 영구 보류됐다. 타계정 매칭 키가
 * `sub_accounts[].phone` 하나뿐이라, 소유자가 타계정을 **이름만** 등록했거나
 * 번호를 다르게 적어 두면 계좌(소유자 것)가 멀쩡히 있어도 지목할 길이 없었다.
 *
 * 검사 방식 — 스텁 pool 로 `listPaymentTargets` **실제 실행**
 *  §1 폴백이 실제로 보류를 푸는가(참여 원장 · 제출 신원 링크 두 경로)
 *  §2 ★ 이름 추측 금지 — 근거 없는 건은 계속 보류(fail-closed)
 *  §3 폴백은 필요할 때만 돈다 · 실패해도 목록을 죽이지 않는다
 *  §4 배선(정규화 사본 부재 · 화면 근거 표기)
 *
 * 실행: node tests/paymentSubAccountOwner.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
const SRC = p => path.join(__dirname, '..', 'src', p);

function withStubPool(handler, run) {
  const poolPath = require.resolve(SRC('db/pool'));
  const svcPath = require.resolve(SRC('services/payment.service'));
  const calls = [];
  const stub = {
    query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params, calls) || { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[svcPath];
  try { return run(require(svcPath), calls); }
  finally {
    delete require.cache[svcPath];
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
  }
}

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ACCT = { bankName: '국민은행', bankAccount: '123456789', accountHolder: '김수만' };

/** 대상 1행 = 타계정 명의(명지수, 연락처 87654321) — 그 번호로는 계좌를 못 찾는다 */
function handler(opts) {
  return (sql) => {
    if (/FROM review_index ri/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 10,
      reviewerName: opts.rowName === undefined ? '명지수' : opts.rowName,
      phone8: '87654321', startDate: '8 / 12 (수)', productName: '상황버섯',
      amountCells: { '결제금액': '20,000' },
    }] };
    if (/FROM recruit_campaigns c/.test(sql)) return { rows: [] };
    if (/campaign_fee_schedules/.test(sql)) return { rows: [] };
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', label: '작업', transferBank: '케이뱅크', depositName: '망고', goodsCostType: '' }] };
    // ── 계좌 1차 매칭(연락처) — 둘 다 빈 결과 = 타계정 미등록 상황
    if (/jsonb_array_elements/.test(sql)) return { rows: opts.subRows || [] };
    if (/FROM reviewers WHERE phone8/.test(sql) && !/AS "subAccounts"/.test(sql)) return { rows: opts.ownRows || [] };
    // ── 폴백 ① 참여 원장
    if (/campaign_applications ca ON ca\.order_submission_id/.test(sql)) {
      if (opts.throwOnFallback) throw new Error('boom');
      return { rows: opts.viaOrder || [] };
    }
    // ── 폴백 ② 제출 신원 링크
    if (/FROM participation_links pl/.test(sql)) return { rows: opts.viaLink || [] };
    // ── 폴백 소유자 조회
    if (/AS "subAccounts"/.test(sql)) return { rows: opts.owners || [] };
    if (/FROM order_submissions/.test(sql)) return { rows: opts.orderRows || [] };  // 가격 + 제출 계좌
    return { rows: [] };
  };
}
const owner = (over = {}) => Object.assign({
  reviewerId: OWNER_ID, phone8: '11112222', name: '김수만', subAccounts: [], ...OWNER_ACCT }, over);

(async function main() {

  console.log('\n§1 소유자 링크 폴백 — 보류가 실제로 풀린다');

  await ta('1a ★ 참여 원장(owner_phone8)으로 소유자 계좌를 찾아 통과한다', async () => {
    await withStubPool(handler({
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222', subPhone8: '87654321' }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(!it.issues.includes('no_reviewer'), '보류가 풀려야 한다: ' + it.issues.join(','));
      assert.strictEqual(it.payable, true, '남은 보류: ' + it.issues.join(','));
      assert.strictEqual(it.bankAccount, '123456789');
      assert.strictEqual(it.accountHolder, '김수만');
      assert.strictEqual(it.accountSource, 'owner_order');
      assert.strictEqual(it.isSub, true);
      assert.strictEqual(it.accountOwner, '김수만');
    });
  });

  await ta('1b ★ 타계정을 이름만 등록해도 통과(신원 링크 + 명의 이름 일치) — 이번 사고의 형태', async () => {
    await withStubPool(handler({
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '명지수' }] })],   // 번호 없음 = 1차 매칭 불가
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.payable, true, '남은 보류: ' + it.issues.join(','));
      assert.strictEqual(it.accountSource, 'owner_link');
      assert.strictEqual(it.bankAccount, '123456789');
      // 등록된 번호가 없으니 타계정으로 지목하지 않는다(보완 저장이 sub_not_found 로 죽는다)
      assert.deepStrictEqual(it.accountRef, { reviewerId: OWNER_ID, subPhone8: null });
    });
  });

  await ta('1c 타계정 전용계좌가 있으면 그것을 쓴다(소유자 공통계좌보다 우선)', async () => {
    await withStubPool(handler({
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222', subPhone8: '87654321' }],
      owners: [owner({ subAccounts: [{ name: '명지수', phone: '010-8765-4321', bankName: '신한은행', bankAccount: '999', accountHolder: '명지수' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.bankAccount, '999');
      assert.strictEqual(it.accountHolder, '명지수');
      assert.strictEqual(it.accountRef.subPhone8, '87654321', '등록된 명의는 타계정으로 지목한다');
    });
  });

  await ta('1d ★ 참여 원장이 신원 링크를 이긴다(더 강한 근거)', async () => {
    await withStubPool(handler({
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222', subPhone8: '87654321' }],
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '33334444' }],
      owners: [owner(), owner({ reviewerId: '22222222-2222-2222-2222-222222222222', phone8: '33334444', name: '남', bankAccount: '000', subAccounts: [{ name: '명지수' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'owner_order');
      assert.strictEqual(it.bankAccount, '123456789');
    });
  });

  console.log('\n§2 ★ 이름으로 소유자를 추측하지 않는다 — 근거 없으면 계속 보류(fail-closed)');

  await ta('2a 신원 링크만 있고 그 이름이 소유자 타계정 목록에 없으면 미채택(stale 링크 보호)', async () => {
    await withStubPool(handler({
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '다른사람' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'), '근거 없이 통과하면 안 된다');
      assert.strictEqual(it.accountSource, null);
    });
  });

  await ta('2b 소유자 후보가 둘 이상(phone8 은 비유니크)이면 미채택 — 남의 계좌 송금 차단', async () => {
    await withStubPool(handler({
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222', subPhone8: '87654321' }],
      owners: [owner(), owner({ reviewerId: '22222222-2222-2222-2222-222222222222', name: '동명이인', bankAccount: '000' })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'), '모호하면 통과시키지 않는다');
    });
  });

  await ta('2c 같은 이름이 타계정 목록에 둘이면 명의를 정할 수 없어 미채택(링크 경로)', async () => {
    await withStubPool(handler({
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '명지수' }, { name: '명지수', phone: '010-1111-1111' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
    });
  });

  await ta('2d 행 이름이 비어 있으면 링크 경로는 대조 근거가 없어 미채택', async () => {
    await withStubPool(handler({
      rowName: '',
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '명지수' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
    });
  });

  console.log('\n§2-2 그 건의 제출 계좌(구매양식) — 등록 계좌가 없을 때의 마지막 근거');

  const ORDER_ROW = { sheetId: 'S1', tabName: 'T1', sheetRow: 10, price: '20000', feeSnapshot: null,
                      orderedAt: null, bank: '케이뱅크', account: '100-234-102639', depositor: '최영순' };

  await ta('2e ★ 등록 계좌가 없어도 구매양식으로 제출된 계좌로 통과한다(최영순7 사고)', async () => {
    await withStubPool(handler({ orderRows: [ORDER_ROW] }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.payable, true, '남은 보류: ' + it.issues.join(','));
      assert.strictEqual(it.accountSource, 'order');
      assert.strictEqual(it.bankAccount, '100234102639', '계좌는 숫자만으로 정규화');
      assert.strictEqual(it.accountHolder, '최영순');
      assert.strictEqual(it.accountRef, null, '지목할 리뷰어가 없다 = 보완 팝업 대상 아님');
    });
  });

  await ta('2f 등록 계좌가 언제나 이긴다(기존 동작 보존 — 제출 계좌가 덮지 않는다)', async () => {
    await withStubPool(handler({
      orderRows: [ORDER_ROW],
      ownRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명지수', ...OWNER_ACCT }],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'self');
      assert.strictEqual(it.bankAccount, '123456789');
    });
  });

  await ta('2g 반쪽 값(은행·계좌·예금주 중 하나라도 빔)은 인정하지 않는다 — 은행이 거부하는 파일', async () => {
    for (const gap of [{ bank: '' }, { account: '' }, { depositor: '' }]) {
      await withStubPool(handler({ orderRows: [{ ...ORDER_ROW, ...gap }] }), async (svc) => {
        const it = (await svc.listPaymentTargets()).items[0];
        assert.ok(it.issues.includes('no_reviewer'), '빈 값을 채워 통과시키면 안 된다: ' + JSON.stringify(gap));
      });
    }
  });

  await ta('2h 소유자 링크가 제출 계좌보다 우선(등록된 계좌가 관리 원장)', async () => {
    await withStubPool(handler({
      orderRows: [ORDER_ROW],
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222', subPhone8: '87654321' }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'owner_order');
      assert.strictEqual(it.bankAccount, '123456789');
    });
  });

  t('2i 회차 스냅샷 출처는 등록된 명의(subPhone8)가 있을 때만 sub — 없으면 소유자 본계좌(self)', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    assert.ok(/accountRef\.subPhone8 \? 'sub' : 'self'/.test(src),
      "subPhone8 없는 폴백 건을 'sub' 로 박제하면 다음 대조가 없는 명의를 찾아 mismatch 로 잡는다");
  });

  console.log('\n§3 폴백은 필요할 때만 · 실패해도 목록을 죽이지 않는다');

  await ta('3a 연락처로 이미 찾은 건에는 폴백 쿼리가 아예 안 나간다', async () => {
    await withStubPool(handler({
      ownRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명지수', ...OWNER_ACCT }],
    }), async (svc, calls) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'self');
      assert.strictEqual(calls.filter(c => /FROM participation_links pl/.test(c.sql)).length, 0);
      assert.strictEqual(calls.filter(c => /campaign_applications ca ON ca\.order_submission_id/.test(c.sql)).length, 0);
    });
  });

  await ta('3b 폴백 조회가 실패해도 throw 하지 않고 종전 보류로 끝난다', async () => {
    await withStubPool(handler({ throwOnFallback: true }), async (svc) => {
      const { items } = await svc.listPaymentTargets();
      assert.strictEqual(items.length, 1);
      assert.ok(items[0].issues.includes('no_reviewer'));
    });
  });

  console.log('\n§4 배선');

  t('4a 이름 정규화는 identity.service 재사용(사본 금지 — 판정이 갈리면 안 된다)', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    assert.ok(/require\('\.\/identity\.service'\)/.test(src), 'identity.service 를 쓴다');
    assert.ok(/normName/.test(src));
    assert.ok(!/function\s+normName/.test(src), 'payment.service 안에 사본을 만들지 않는다');
  });

  t('4b ★ 폴백 판정 근거는 하드 링크 두 개뿐(이름만으로 소유자를 찾는 쿼리가 없다)', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    const body = src.slice(src.indexOf('async function _loadOwnerAccountsByRow'),
                           src.indexOf('async function _loadTabMeta'));
    assert.ok(/campaign_applications/.test(body) && /participation_links/.test(body));
    assert.ok(!/reviewers\s+WHERE\s+name/i.test(body), '이름으로 리뷰어를 찾으면 안 된다');
    assert.ok(/list\.length === 1/.test(body), '소유자 후보가 유일할 때만 채택');
  });

  t('4c 화면이 "어떻게 찾았는지" 근거를 말한다(툴팁)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
    assert.ok(html.includes('function _pmAcctSrcTip('), '근거 표기 헬퍼');
    assert.ok(/_pmAcctSrcTip\(it\)[\s\S]{0,40}타계정/.test(html), '타계정 배지에 근거 툴팁이 붙는다');
    assert.ok(html.includes('owner_order') && html.includes('owner_link'));
  });

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
