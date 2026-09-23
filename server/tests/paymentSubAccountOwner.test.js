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
 *  §2 등록DB 소유자가 한 명으로 확정되면 이름·시각 불일치도 본계정으로 귀속
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
    if (/FROM reviewer_phone_changes/.test(sql)) return { rows: opts.movedPhoneRows || [] };
    if (/FROM reviewer_identities/.test(sql)) return { rows: opts.identityRows || [] };
    // ── 현재 참여행 owner UUID
    if (/FROM unnest[\s\S]*JOIN campaign_participants cp/.test(sql)) return { rows: opts.viaParticipant || [] };
    // ── 폴백 ① 참여 원장
    if (/FROM unnest[\s\S]*JOIN order_submissions os/.test(sql)) {
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
      assert.strictEqual(it.isSub, false, '등록된 타계정이 아니면 소유자 본계좌로 지급한다');
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

  await ta('1e ★ 행 연락처가 다른 등록 리뷰어와 겹쳐도 참여행 owner UUID 계좌가 이긴다', async () => {
    await withStubPool(handler({
      ownRows: [{ reviewerId: '99999999-9999-9999-9999-999999999999', phone8: '87654321', name: '다른사람', bankName: '신한은행', bankAccount: '000', accountHolder: '다른사람' }],
      viaParticipant: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID, participantIdentityId: null, subPhone8: '87654321' }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'owner_participant');
      assert.strictEqual(it.bankAccount, '123456789');
      assert.strictEqual(it.ownerReviewerId, OWNER_ID);
    });
  });

  await ta('1e-2 현재 owner UUID가 없으면 행 연락처의 등록계좌가 오래된 링크보다 우선한다', async () => {
    await withStubPool(handler({
      ownRows: [{ reviewerId: '99999999-9999-9999-9999-999999999999', phone8: '87654321', name: '현재참여자', bankName: '신한은행', bankAccount: '777', accountHolder: '현재참여자' }],
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'self');
      assert.strictEqual(it.bankAccount, '777');
      assert.strictEqual(it.ownerReviewerId, '99999999-9999-9999-9999-999999999999');
    });
  });

  await ta('1f ★ 윤주희형: 행 번호가 달라도 제출 로그인 번호+등록 본인 이름이면 본계좌로 잡힌다', async () => {
    await withStubPool(handler({
      rowName: '윤주희',
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '77045262' }],
      owners: [owner({ phone8: '77045262', name: '윤주희', accountHolder: '윤주희' })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'owner_link');
      assert.strictEqual(it.ownerReviewerId, OWNER_ID);
      assert.strictEqual(it.accountHolder, '윤주희');
      assert.strictEqual(it.accountRef.subPhone8, null);
    });
  });

  await ta('1g 코드 타계정은 참여 뒤 이름·번호가 바뀌어도 participant identity로 현재 전용계좌를 쓴다', async () => {
    const identityId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await withStubPool(handler({
      viaParticipant: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID,
        participantIdentityId: identityId, subPhone8: '00000000' }],
      identityRows: [{ id: identityId, ownerReviewerId: OWNER_ID, memberNo: 1,
        currentName: '현재명의', currentPhone8: '99998888', status: 'active' }],
      owners: [owner({ subAccounts: [{ name: '현재명의', phone: '010-9999-8888', bankName: '신한은행', bankAccount: '555', accountHolder: '현재명의' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'owner_participant');
      assert.strictEqual(it.bankAccount, '555');
      assert.strictEqual(it.accountHolder, '현재명의');
      assert.strictEqual(it.accountRef.subPhone8, '99998888');
      assert.strictEqual(it.participantIdentityId, identityId);
    });
  });

  await ta('1g-2 앞 타계정 삭제로 member_no 위치가 다른 사람을 가리키면 입금을 보류한다', async () => {
    const identityId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    await withStubPool(handler({
      viaParticipant: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID,
        participantIdentityId: identityId, subPhone8: '99998888' }],
      identityRows: [{ id: identityId, ownerReviewerId: OWNER_ID, memberNo: 1,
        currentName: '원래명의', currentPhone8: '99998888', status: 'active' }],
      owners: [owner({ subAccounts: [{ name: '다른명의', phone: '010-2222-3333', bankName: '신한은행', bankAccount: '999', accountHolder: '다른명의' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, null);
      assert.notStrictEqual(it.bankAccount, '999');
    });
  });

  await ta('1h participant identity가 주문 소유자와 다르면 본계좌로 낮추지 않고 보류한다', async () => {
    const identityId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await withStubPool(handler({
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID,
        participantIdentityId: identityId, subPhone8: '87654321' }],
      identityRows: [{ id: identityId, ownerReviewerId: '22222222-2222-2222-2222-222222222222', memberNo: 1, status: 'active' }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, null);
    });
  });

  console.log('\n§2 ★ 확정 소유자는 이름·시각 불일치여도 본계정으로 귀속한다');

  await ta('2a 신원 링크의 이름이 타계정 목록과 달라도 소유자 본계정으로 채택', async () => {
    await withStubPool(handler({
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '다른사람' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(!it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, 'owner_link');
      assert.strictEqual(it.accountRef.subPhone8, null);
      assert.strictEqual(it.bankAccount, '123456789');
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

  await ta('2b-2 행 번호에 등록 본계정이 둘이면 어느 계좌도 선택하지 않는다', async () => {
    await withStubPool(handler({
      ownRows: [
        { reviewerId: OWNER_ID, phone8: '87654321', name: '동일번호1', ...OWNER_ACCT },
        { reviewerId: '22222222-2222-2222-2222-222222222222', phone8: '87654321', name: '동일번호2', bankName: '신한은행', bankAccount: '000', accountHolder: '동일번호2' },
      ],
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, null);
    });
  });

  await ta('2b-2-2 행 번호가 다른 리뷰어의 본계정·타계정에 함께 있으면 오래된 링크도 쓰지 않는다', async () => {
    await withStubPool(handler({
      subRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명의A', ownerName: '김수만', ...OWNER_ACCT }],
      ownRows: [{ reviewerId: '22222222-2222-2222-2222-222222222222', phone8: '87654321', name: '본계정B', bankName: '신한은행', bankAccount: '000', accountHolder: '본계정B' }],
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerReviewerId: OWNER_ID }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, null);
    });
  });

  await ta('2b-3 과거 다른 소유자가 썼던 번호의 링크는 현재 번호 소유자에게 넘기지 않는다', async () => {
    await withStubPool(handler({
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner()],
      movedPhoneRows: [{ phone8: '11112222', reviewerId: '22222222-2222-2222-2222-222222222222' }],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, null);
    });
  });

  await ta('2c 같은 이름의 타계정이 둘이면 어느 타계정도 고르지 않고 본계정으로 귀속', async () => {
    await withStubPool(handler({
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '명지수' }, { name: '명지수', phone: '010-1111-1111' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(!it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, 'owner_link');
      assert.strictEqual(it.accountRef.subPhone8, null);
    });
  });

  await ta('2d 행 이름이 비어 있어도 확정된 링크 소유자 본계정으로 귀속', async () => {
    await withStubPool(handler({
      rowName: '',
      viaLink: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222' }],
      owners: [owner({ subAccounts: [{ name: '명지수' }] })],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(!it.issues.includes('no_reviewer'));
      assert.strictEqual(it.accountSource, 'owner_link');
      assert.strictEqual(it.accountRef.subPhone8, null);
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

  /* ★★★ 2026-09-21 사용자 확정으로 **뒤집힌 규율** — 종전 2f 는 "등록 계좌가 언제나 이긴다" 였다.
       실사고(모기위키 439/440): 타계정 건이 양식에 김솔지 계좌를 적었는데 등록DB 주인 계좌로 나가
       김솔지가 2건 중 1건만 받았다. 전수 40건(예금주까지 다른 건 23건 · 746,800원).
       ⇒ **그 건의 구매양식 계좌가 이긴다.** 되돌리려면 env 스위치(2l)를 쓴다. */
  await ta('2f ★ 그 건의 구매양식 계좌가 등록 계좌를 이긴다(사용자 확정 2026-09-21)', async () => {
    await withStubPool(handler({
      orderRows: [ORDER_ROW],
      ownRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명지수', ...OWNER_ACCT }],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'order');
      assert.strictEqual(it.bankAccount, '100234102639', '양식에 적힌 계좌로 보낸다');
      assert.strictEqual(it.accountHolder, '최영순');
      assert.strictEqual(it.accountRef, null, '양식 계좌는 지목할 리뷰어가 없다(회차 스냅샷 가드 밖)');
      // ★ 조용히 보내지 않는다 — 화면이 두 계좌를 나란히 말할 재료를 싣는다.
      assert.ok(it.accountMismatch, 'accountMismatch 가 실려야 한다');
      assert.strictEqual(it.accountMismatch.form.accountTail, '2639');
      assert.strictEqual(it.accountMismatch.registered.accountTail, '6789');
      assert.strictEqual(it.accountMismatch.registered.accountHolder, '김수만');
      assert.strictEqual(it.accountMismatch.holderDiffers, true, '예금주까지 다른 경우');
      assert.ok(it.warnings.includes('account_form_override'));
      assert.strictEqual(it.payable, true, '경고일 뿐 보류가 아니다(체크는 화면에서 푼다)');
    });
  });

  await ta('2f-2 두 계좌가 같으면 아무 말도 하지 않는다(늑대소년 방지)', async () => {
    await withStubPool(handler({
      orderRows: [{ ...ORDER_ROW, bank: '국민은행', account: '123-456-789', depositor: '김수만' }],
      ownRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명지수', ...OWNER_ACCT }],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.bankAccount, '123456789');
      assert.strictEqual(it.accountMismatch, null, '같은 계좌인데 경고를 만들면 진짜 신호가 묻힌다');
      assert.ok(!it.warnings.includes('account_form_override'));
    });
  });

  await ta('2f-3 등록 계좌가 아예 없으면 registered 는 null(경우를 구분해 말한다)', async () => {
    await withStubPool(handler({ orderRows: [ORDER_ROW] }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.accountMismatch, '양식 계좌가 유일한 근거라는 사실도 화면이 말한다');
      assert.strictEqual(it.accountMismatch.registered, null);
      assert.strictEqual(it.accountMismatch.holderDiffers, false);
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

  /* ★★ 뒤집힌 규율(2026-09-21) — 소유자 링크로 찾은 등록 계좌보다 양식 계좌가 이긴다.
       ★ 다만 **신원 추적 필드(누가 참여했나)는 등록DB 기준을 유지**한다 — 계좌(어디로 보내나)와
         별개라, 여기까지 비우면 회차 항목의 소유자 추적이 끊긴다. */
  await ta('2h ★ 소유자 링크가 있어도 양식 계좌가 이기고, 신원 추적은 등록 기준을 유지한다', async () => {
    await withStubPool(handler({
      orderRows: [ORDER_ROW],
      viaOrder: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 10, ownerPhone8: '11112222', subPhone8: '87654321' }],
      owners: [owner()],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'order');
      assert.strictEqual(it.bankAccount, '100234102639');
      assert.strictEqual(it.ownerReviewerId, OWNER_ID, '소유자 추적은 등록DB 기준 그대로');
      assert.ok(it.accountMismatch && it.accountMismatch.registered, '가려진 등록 계좌를 화면에 알린다');
    });
  });

  await ta('2l ★ 되돌리기 — PAYMENT_FORM_ACCOUNT_FIRST=0 이면 종전(등록 계좌 우선) 동작', async () => {
    const prev = process.env.PAYMENT_FORM_ACCOUNT_FIRST;
    process.env.PAYMENT_FORM_ACCOUNT_FIRST = '0';
    try {
      await withStubPool(handler({
        orderRows: [ORDER_ROW],
        ownRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명지수', ...OWNER_ACCT }],
      }), async (svc) => {
        const it = (await svc.listPaymentTargets()).items[0];
        assert.strictEqual(it.accountSource, 'self', '스위치를 끄면 등록 계좌가 다시 이긴다');
        assert.strictEqual(it.bankAccount, '123456789');
        assert.strictEqual(it.accountMismatch, null, '종전 동작에는 이 경고가 없다');
      });
    } finally {
      if (prev === undefined) delete process.env.PAYMENT_FORM_ACCOUNT_FIRST;
      else process.env.PAYMENT_FORM_ACCOUNT_FIRST = prev;
    }
  });

  t('2i 회차 스냅샷 출처는 등록된 명의(subPhone8)가 있을 때만 sub — 없으면 소유자 본계좌(self)', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    assert.ok(/accountRef\.subPhone8 \? 'sub' : 'self'/.test(src),
      "subPhone8 없는 폴백 건을 'sub' 로 박제하면 다음 대조가 없는 명의를 찾아 mismatch 로 잡는다");
  });

  console.log('\n§3 소유자 우선 조회 · 실패해도 목록을 죽이지 않는다');

  await ta('3a 연락처 계좌가 있어도 소유자 링크를 조회한다(우연히 겹친 타인 계좌 방지)', async () => {
    await withStubPool(handler({
      ownRows: [{ reviewerId: OWNER_ID, phone8: '87654321', name: '명지수', ...OWNER_ACCT }],
    }), async (svc, calls) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountSource, 'self');
      assert.strictEqual(calls.filter(c => /FROM participation_links pl/.test(c.sql)).length, 1);
      assert.strictEqual(calls.filter(c => /FROM unnest[\s\S]*JOIN order_submissions os/.test(c.sql)).length, 1);
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

  console.log('\n§5 화면 — 양식 계좌로 보낼 때 두 계좌를 나란히 말한다(사용자 확정 2026-09-21)');

  const WD = () => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

  t('5a ★ 안내줄 렌더 3갈래 — 예금주 다름 / 계좌만 다름 / 등록 계좌 없음', () => {
    const vm = require('vm');
    const fn = WD().match(/function _pmAcctMismatchHtml\(mm\)\{[\s\S]*?\n\}/);
    assert.ok(fn, '_pmAcctMismatchHtml 이 있어야 한다');
    const ctx = { esc: s => String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) };
    vm.createContext(ctx); vm.runInContext(fn[0] + ';', ctx);

    const diffHolder = ctx._pmAcctMismatchHtml({
      form: { bankName: '국민', accountTail: '9824', accountHolder: '김솔지' },
      registered: { bankName: '신한', accountTail: '9898', accountHolder: '정재석', name: '정재석', isSub: false },
      holderDiffers: true });
    assert.ok(diffHolder.includes('9824') && diffHolder.includes('9898'), '두 계좌를 모두 보여준다');
    assert.ok(diffHolder.includes('예금주가 다른 사람입니다'), '예금주가 다르면 그 사실을 콕 집는다');

    const diffAcct = ctx._pmAcctMismatchHtml({
      form: { bankName: '국민', accountTail: '1234', accountHolder: '배미정' },
      registered: { bankName: '국민', accountTail: '6216', accountHolder: '배미정', name: '배미정', isSub: false },
      holderDiffers: false });
    assert.ok(diffAcct.includes('계좌번호가 다릅니다') && !diffAcct.includes('예금주가 다른'),
      '같은 사람의 다른 계좌는 다르게 말한다');

    const noReg = ctx._pmAcctMismatchHtml({
      form: { bankName: '케이뱅크', accountTail: '2639', accountHolder: '최영순' }, registered: null });
    assert.ok(noReg.includes('등록된 계좌가 없습니다'), '등록 계좌 부재와 불일치를 구분해 말한다');
    assert.ok(!noReg.includes('등록 계좌 —'), '없는 계좌를 지어내지 않는다');

    // ★ 사용자 확정 문구 — 체크를 풀면 그 건이 회차에서 빠진다는 사실
    for (const h of [diffHolder, diffAcct, noReg]) {
      assert.ok(h.includes('체크박스를 풀면 해당 건 입금은') && h.includes('보류'), '보류 안내 문구');
    }
    assert.strictEqual(ctx._pmAcctMismatchHtml(null), '', '값이 없으면 아무것도 그리지 않는다');

    const xss = ctx._pmAcctMismatchHtml({
      form: { bankName: '<img src=x onerror=alert(1)>', accountTail: '1', accountHolder: 'a' }, registered: null });
    assert.ok(!xss.includes('<img'), '외부발 문자열은 escape 한다');
  });

  t('5b ★ 배지·안내줄은 accountMismatch 기준(accountSource 로 띄우면 거의 모든 행에 붙어 신호가 묻힌다)', () => {
    const html = WD();
    assert.ok(/const mm = it\.accountMismatch/.test(html), '화면은 서버가 준 값만 본다(판정 사본 금지)');
    assert.ok(!/it\.accountSource===['"]order['"]\?`<span class="pmauto"/.test(html),
      "종전 '양식계좌' 배지 조건(accountSource==='order')이 되살아나면 안 된다");
    assert.ok(/pmmmchip/.test(html) && /pmmm"/.test(html), '안내줄·배지 클래스가 배선돼 있다');
  });

  t('5c ★ 표 칸 수 — 헤더 ≡ 데이터 행 ≡ 안내줄(빈 칸 1 + colspan)', () => {
    const html = WD();
    const head = html.slice(html.indexOf('<thead><tr><th>☑</th>'));
    // ★ `/<th/` 로 세면 `<thead>` 가 함께 잡혀 한 칸이 늘어난다(실측) — 여는 태그만 센다.
    const headCells = (head.slice(0, head.indexOf('</thead>')).match(/<th[\s>]/g) || []).length;
    assert.strictEqual(headCells, 11, '입금대상 표는 11칸이다');
    const mmRow = html.match(/pmmm" data-pg="\$\{i\}"><td><\/td><td colspan="(\d+)">/);
    assert.ok(mmRow, '안내줄이 행 바로 아래에 붙는다');
    assert.strictEqual(1 + Number(mmRow[1]), headCells, '빈 칸 1 + colspan 이 헤더 칸 수와 같아야 한다');
  });

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
