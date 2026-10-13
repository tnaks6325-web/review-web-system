/**
 * 회귀가드 — 리뷰어가 고친 계좌를 쓴다 · 실패한 계좌로 되풀이 송금하지 않는다 (결정 231 · 사용자 확정 2026-10-13)
 *
 * 실사고(임혜정 고양이사료 18 · 풍성에프엔비 간장 398): 9/25 구매양식에 계좌를 13자리로 잘못 적어 이체 실패 →
 * 10/8 내정보에서 바로 고쳤지만 157 "구매양식 계좌가 이긴다"가 그 주문의 양식 계좌를 계속 이기게 해
 * 10/12 또 실패(간장은 4회). 실패 안내문은 "내정보에서 고치면 다음 이체 때 다시 시도" — 막다른 길이었다.
 * 같은 줄이 같은 계좌로 최대 10번 실패를 되풀이한 것도 함께 드러났다.
 *
 * 검사 방식 — 스텁 pool 로 `listPaymentTargets` **실제 실행**.
 * 실행: node tests/paymentAccountCorrection.test.js
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
  const stub = {
    query: async (sql, params) => handler(sql, params) || { rows: [], rowCount: 0 },
    connect: async () => ({ query: stub.query, release() {} }),
  };
  const orig = require.cache[poolPath];
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: stub };
  delete require.cache[svcPath];
  try { return run(require(svcPath)); }
  finally {
    delete require.cache[svcPath];
    if (orig) require.cache[poolPath] = orig; else delete require.cache[poolPath];
  }
}

const RID = '22222222-2222-2222-2222-222222222222';
const FORM_BAD = '5029108364380';    // 13자리 오타(실사고 형태)
const REG_GOOD = '50291083643807';   // 내정보에서 고친 계좌
const ORDERED = '2026-09-25T07:14:00+09:00';

function handler(o = {}) {
  return (sql) => {
    if (/FROM review_index ri/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', rowIndex: 18, reviewerName: '임혜정', phone8: '29893727',
      startDate: '9 / 25 (목)', productName: '고양이사료', amountCells: { '결제금액': '16,000' },
    }] };
    if (/FROM recruit_campaigns c/.test(sql)) return { rows: [] };
    if (/campaign_fee_schedules/.test(sql)) return { rows: [] };
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', label: '고양이사료', transferBank: '케이뱅크', depositName: '사료망고', goodsCostType: '' }] };
    if (/jsonb_array_elements/.test(sql)) return { rows: o.subRows || [] };
    if (/FROM reviewers WHERE phone8/.test(sql) && !/AS "subAccounts"/.test(sql)) return { rows: o.ownRows || [] };
    if (/FROM raw_sheet_tabs/.test(sql)) return { rows: [{ sheetId: 'S1', tabName: 'T1',
      headers: o.headers || ['번호', '이름', '은행', '계좌번호', '예금주', '은행명', '계좌비고'] }] };
    if (/JOIN participant_edits pe/.test(sql)) {
      if (o.throwWb) throw new Error('wb boom');
      return { rows: o.wbRows || [] };
    }
    if (/JOIN payment_batch_items pi/.test(sql)) {
      if (o.throwFailed) throw new Error('failed boom');
      return { rows: o.failedRows || [] };
    }
    if (/FROM reviewer_account_change_audit/.test(sql)) {
      if (o.throwAudit) throw new Error('audit boom');
      return { rows: o.auditRows || [] };
    }
    if (/FROM order_submissions/.test(sql) && !/FROM unnest/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', sheetRow: 18, price: '16000', feeSnapshot: null, orderedAt: ORDERED, lastEditSeq: o.lastEditSeq || null,
      bank: '하나은행', account: o.formAccount || FORM_BAD, depositor: o.formHolder || '임혜정' }] };
    return { rows: [] };
  };
}
const own = (over = {}) => [Object.assign({ reviewerId: RID, phone8: '29893727', name: '임혜정',
  bankName: '하나은행', bankAccount: REG_GOOD, accountHolder: '임혜정' }, over)];
const failed = (acct = FORM_BAD, n = 2) => [{ sheetId: 'S1', tabName: 'T1', rowIndex: 18, account: acct, n }];
const run = (opts, fn) => withStubPool(handler(opts), async svc => fn((await svc.listPaymentTargets()).items[0]));

(async function main() {
  console.log('\n§1 리뷰어가 고친 계좌를 쓴다');

  await ta('1a ★★ 양식 계좌가 이 줄에서 이미 실패 + 예금주 같음 → 내정보 계좌로 보낸다(실사고 형태)', () =>
    run({ ownRows: own(), failedRows: failed() }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD, '고친 계좌로 가야 한다');
      assert.strictEqual(it.accountMismatch.using, 'registered');
      assert.strictEqual(it.accountMismatch.reason, 'form_failed');
      assert.ok(!it.warnings.includes('failed_account'), '새 계좌는 실패한 적이 없다');
      assert.strictEqual(it.failedAccountCount, 0);
      assert.strictEqual(it.payable, true);
    }));

  await ta('1b ★ 주문 뒤 내정보 계좌가 바뀜(실패 전) → 내정보 계좌로 보낸다', () =>
    run({ ownRows: own(), auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD);
      assert.strictEqual(it.accountMismatch.reason, 'registered_changed');
    }));

  await ta('1c ★★ 예금주가 다르면 바꾸지 않는다(157 사고 형태 — 남의 계좌로 돌리지 않는다)', () =>
    run({ ownRows: own({ accountHolder: '정재석' }), formHolder: '김솔지', formAccount: '72560200129824',
          failedRows: failed('72560200129824', 1), auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, '72560200129824', '양식 계좌 그대로');
      assert.strictEqual(it.accountMismatch.using, 'form');
      assert.ok(it.warnings.includes('failed_account'), '실패 계좌 그대로라 경고');
    }));

  await ta('1d 내정보 변경이 주문보다 먼저면 종전대로 양식 계좌(157 유지)', () =>
    run({ ownRows: own(), auditRows: [{ reviewerId: RID, sub: '', at: '2026-09-01T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, FORM_BAD);
      assert.strictEqual(it.accountMismatch.using, 'form');
    }));

  await ta('1e 타계정은 그 명의 항목의 변경만 본다(소유자 본계좌 변경으로 바꾸지 않는다)', () =>
    run({ subRows: [{ phone8: '29893727', reviewerId: RID, name: '임혜정', ownerName: '소유자',
                      bankName: '하나은행', bankAccount: REG_GOOD, accountHolder: '임혜정' }],
          auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, FORM_BAD, '소유자 본계좌 변경은 타계정 건의 근거가 아니다');
    }));

  await ta('1e1 ★ 전용 계좌 없이 소유자 계좌를 물려 쓰는 타계정은 바꾸지 않는다(소유자 변경 시 트리거가 타계정 줄도 남긴다)', () =>
    run({ subRows: [{ phone8: '29893727', reviewerId: RID, name: '임혜정', ownerName: '소유자',
                      bankName: '하나은행', bankAccount: REG_GOOD, accountHolder: '임혜정', inheritsOwner: true }],
          failedRows: failed(),
          auditRows: [{ reviewerId: RID, sub: '29893727', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, FORM_BAD, '물려 쓰는 소유자 계좌로 돌리면 안 된다');
      assert.ok(it.warnings.includes('failed_account'));
    }));

  await ta('1e3 계좌번호는 같고 은행만 고친 경우도 고친 쪽으로', () =>
    run({ ownRows: own({ bankName: '농협', bankAccount: FORM_BAD }), failedRows: failed() }, it => {
      assert.strictEqual(it.bankName, '농협');
      assert.strictEqual(it.accountMismatch.using, 'registered');
    }));

  await ta('1e2 타계정 명의 항목이 주문 뒤 바뀌었으면 고친 계좌', () =>
    run({ subRows: [{ phone8: '29893727', reviewerId: RID, name: '임혜정', ownerName: '소유자',
                      bankName: '하나은행', bankAccount: REG_GOOD, accountHolder: '임혜정' }],
          auditRows: [{ reviewerId: RID, sub: '29893727', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD);
    }));

  await ta('1f ★ 계좌가 아닌 칸 편집(last_edit_seq·updated_at)은 양식 시각을 바꾸지 않는다 — 고객이 고친 계좌 유지', () =>
    run({ ownRows: own(), lastEditSeq: String(Date.parse('2026-10-09T09:00:00+09:00')),
          auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD, '결제금액·주소만 고쳐도 옛 양식 계좌로 돌아가면 안 된다(리뷰 지적)');
    }));

  t('1g ★ 이름으로만 찾은 타계정(번호 없음)은 예외에서 뺀다 — 회차 스냅샷이 self 로 박제돼 다운로드가 막힌다', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    assert.ok(/!\(registeredAcct\.isSub && \(registeredAcct\.subPhone8 === null \|\| registeredAcct\.inheritsOwner\)\)/.test(src));
    assert.ok(/sameHolder && regTargetable/.test(src));
    // 변경 기록 조회는 인덱스를 타는 uuid 비교
    assert.ok(/WHERE reviewer_id = ANY\(\$1::uuid\[\]\)/.test(src));
  });

  console.log('\n§1W 직원이 작업보드에서 고친 계좌 — 마지막에 바뀐 값이 이긴다 (결정 233)');
  const wb = (field, value, at, amb = false) => ({ sheetId: 'S1', tabName: 'T1', rowIndex: 18, ambiguous: amb, field, value, at });

  await ta('1W-a ★★ 직원이 양식 뒤에 고친 계좌로 보낸다(실사고 이노크아든 70 형태)', () =>
    run({ wbRows: [wb('col:계좌번호', '1234-5678-90123', '2026-10-01T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.bankAccount, '1234567890123');
      assert.strictEqual(it.bankName, '하나은행', '안 고친 칸은 지금 근거(양식)에서 채운다');
      assert.strictEqual(it.accountMismatch.using, 'workboard');
      assert.strictEqual(it.accountSource, 'workboard');
      assert.strictEqual(it.accountRef, null, '지목할 등록 리뷰어가 없다(스냅샷 대조 unverifiable)');
    }));

  await ta('1W-b ★★ 고객이 그 뒤에 내정보를 고쳤으면 고객 값(간장 398 형태 — 마지막 값 우선)', () =>
    run({ ownRows: own(), failedRows: failed(),
          auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }],
          wbRows: [wb('col:은행', '농협', '2026-10-01T10:00:00+09:00'), wb('col:계좌번호', '3020000009823', '2026-10-01T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD);
      assert.strictEqual(it.accountMismatch.using, 'registered');
    }));

  await ta('1W-c 직원이 고객보다 나중에 고쳤으면 직원 값', () =>
    run({ ownRows: own(), failedRows: failed(),
          auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }],
          wbRows: [wb('col:계좌번호', '3020000009823', '2026-10-10T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.bankAccount, '3020000009823');
      assert.strictEqual(it.accountMismatch.using, 'workboard');
    }));

  await ta('1W-d ★★ 다른 칸(결제금액 등)을 나중에 고쳐도 직원의 계좌 수정은 유지(이노크아든 재발 방지 — 리뷰 지적)', () =>
    run({ lastEditSeq: String(Date.parse('2026-10-05T10:00:00+09:00')),
          wbRows: [wb('col:계좌번호', '3020000009823', '2026-10-01T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.bankAccount, '3020000009823');
    }));

  await ta('1W-h ★★ 예금주만 다시 적어도 지금 쓰는 계좌(고객이 고친 등록 계좌)가 옛 양식 계좌로 돌아가지 않는다(리뷰 지적)', () =>
    run({ ownRows: own(), failedRows: failed(),
          wbRows: [wb('col:예금주', '임혜정', '2026-10-12T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD);
    }));

  await ta('1W-i ★ 칸마다 시각을 따로 본다 — 옛 은행 칸 수정이 더 최근의 고객 수정을 덮지 않는다', () =>
    run({ ownRows: own(), failedRows: failed(),
          auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }],
          wbRows: [wb('col:은행', '농협', '2026-10-01T10:00:00+09:00'), wb('col:예금주', '임혜정', '2026-10-12T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.bankName, '하나은행', '10/1 은행 수정은 10/8 고객 수정보다 옛것');
      assert.strictEqual(it.bankAccount, REG_GOOD);
    }));

  await ta('1W-j ★ 한 역할에 칸 둘(은행·은행명)·메모성 칸·숫자 없는 계좌는 쓰지 않는다', async () => {
    await run({ wbRows: [wb('col:은행', '농협', '2026-10-01T10:00:00+09:00'), wb('col:은행명', '국민', '2026-10-01T10:00:00+09:00'),
                         wb('col:계좌번호', '3020000009823', '2026-10-01T10:00:00+09:00')] }, it => assert.strictEqual(it.bankAccount, FORM_BAD));
    await run({ wbRows: [wb('col:계좌비고', '3020000009823', '2026-10-01T10:00:00+09:00')] }, it => assert.strictEqual(it.bankAccount, FORM_BAD));
    await run({ wbRows: [wb('col:계좌번호', '확인완료', '2026-10-01T10:00:00+09:00')] }, it => assert.strictEqual(it.bankAccount, FORM_BAD));
  });

  await ta('1W-e 예금주만 고쳐도 반영하고, 구매양식·등록 어느 쪽과도 다르면 빨간 경고', () =>
    run({ ownRows: own(), wbRows: [wb('col:예금주', '박다른', '2026-10-01T10:00:00+09:00')] }, it => {
      assert.strictEqual(it.accountHolder, '박다른');
      assert.strictEqual(it.bankAccount, FORM_BAD, '계좌번호는 양식 그대로');
      assert.strictEqual(it.accountMismatch.holderDiffers, true);
    }));

  await ta('1W-f 모호한 줄(같은 주문·신원이 여러 줄)·빈 값·조회 실패는 무시(종전 동작)', async () => {
    await run({ wbRows: [wb('col:계좌번호', '3020000009823', '2026-10-01T10:00:00+09:00', true)] }, it => assert.strictEqual(it.bankAccount, FORM_BAD));
    await run({ wbRows: [wb('col:계좌번호', '   ', '2026-10-01T10:00:00+09:00')] }, it => assert.strictEqual(it.bankAccount, FORM_BAD));
    await run({ throwWb: true }, it => assert.strictEqual(it.bankAccount, FORM_BAD));
  });

  await ta('1W-g 직원 값이 지금 쓰는 계좌와 같으면 아무 말도 하지 않는다', () =>
    run({ wbRows: [wb('col:계좌번호', FORM_BAD, '2026-10-01T10:00:00+09:00')] }, it => {
      assert.ok(!it.accountMismatch || it.accountMismatch.using !== 'workboard');
    }));

  await ta('1W-k ★ 지금 작업보드에 안 보이는 칸(이름 변경·삭제)의 옛 편집은 쓰지 않는다 · 영문 칸 이름은 읽는다', async () => {
    await run({ headers: ['번호', '이름', '은행', '예금주'], wbRows: [wb('col:계좌번호', '3020000009823', '2026-10-01T10:00:00+09:00')] },
      it => assert.strictEqual(it.bankAccount, FORM_BAD, '안 보이는 칸의 값을 송금에 쓰면 안 된다'));
    await run({ headers: ['no', 'name', 'bank', 'account', 'depositor'], wbRows: [wb('col:account', '3020000009823', '2026-10-01T10:00:00+09:00')] },
      it => assert.strictEqual(it.bankAccount, '3020000009823'));
  });

  t('1W-l ★ 수동 줄일 때 적은 편집(그 줄 자체 = 참여행 id 앵커)도 읽고, 칸마다 지금 앵커 편집이 우선', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    assert.ok(/OR \(pe\.anchor_type = 'manual' AND pe\.anchor_value = a\.id::text\)\)/.test(src));
    assert.ok(/\(pe\.anchor_type = a\.atype AND pe\.anchor_value = a\.aval\) DESC, pe\.created_at DESC/.test(src));
  });

  await ta('1W-m ★★ 관리자가 본 계좌와 회차를 만들 때 계좌가 다르면 회차를 만들지 않는다(보안 — 목록을 띄운 뒤 작업보드 계좌가 바뀐 경우)', () =>
    withStubPool(handler({ wbRows: [wb('col:계좌번호', '3020000009823', '2026-10-01T10:00:00+09:00')] }), async svc => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.ok(it.payoutFp && it.payoutFp.length === 64, '송금 계좌 지문을 화면에 싣는다');
      const stale = await svc.createBatch({ bank: 'kbank', rows: [{ sheetId: 'S1', tabName: 'T1', rowIndex: 18, payoutFp: 'x'.repeat(64) }], by: 't' });
      assert.strictEqual(stale.ok, false);
      assert.ok(stale.skipped.some(x => x.reason === 'account_changed'));
      assert.ok(/새로고침/.test(stale.error));
    }));

  console.log('\n§2 실패한 계좌로 되풀이 송금하지 않는다');

  await ta('2a ★★ 실패한 계좌 그대로(고객이 안 고침) → failed_account 경고 + 횟수, 막지는 않는다', () =>
    run({ ownRows: own({ bankAccount: FORM_BAD }), failedRows: failed(FORM_BAD, 10) }, it => {
      assert.ok(it.warnings.includes('failed_account'));
      assert.strictEqual(it.failedAccountCount, 10);
      assert.strictEqual(it.payable, true, '은행 일시 오류일 수 있어 사람이 다시 담을 수 있어야 한다');
    }));

  await ta('2b 다른 계좌의 실패 기록은 세지 않는다(숫자만 비교)', () =>
    run({ ownRows: own({ bankAccount: FORM_BAD }), failedRows: failed('1111-2222-3333', 3) }, it => {
      assert.ok(!it.warnings.includes('failed_account'));
    }));

  console.log('\n§3 실패해도 목록을 죽이지 않는다 · 되돌리기 스위치');

  await ta('3a 실패 기록·변경 기록 조회가 터져도 종전 동작(양식 계좌)', () =>
    run({ ownRows: own(), throwFailed: true, throwAudit: true }, it => {
      assert.strictEqual(it.bankAccount, FORM_BAD);
      assert.strictEqual(it.payable, true);
    }));

  await ta('3b PAYMENT_FORM_ACCOUNT_FIRST=0 이면 종전처럼 등록 계좌(스위치 왕복)', async () => {
    process.env.PAYMENT_FORM_ACCOUNT_FIRST = '0';
    try { await run({ ownRows: own() }, it => assert.strictEqual(it.bankAccount, REG_GOOD)); }
    finally { delete process.env.PAYMENT_FORM_ACCOUNT_FIRST; }
  });

  console.log('\n§4 화면 · 안내문');
  const WD = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');
  t('4a 이전 실패 계좌 줄은 처음에 체크 해제 · 사람이 다시 담으면 존중', () => {
    // 승인은 그때의 실패 횟수에 묶인다 — 다시 실패하면 횟수가 늘어 다시 기본 해제(Codex P1)
    assert.ok(/includes\('failed_account'\) && _retryOk\.get\(_pmKey\(it\)\) !== Number\(it\.failedAccountCount\|\|0\)\) STATE\.pmExcluded\[_pmKey\(it\)\] = true/.test(WD));
    assert.ok(/if\(on\) ok\.set\(key, Number\(it\.failedAccountCount\|\|0\)\); else ok\.delete\(key\);/.test(WD));
  });
  t('4a2 ★ 작업 목록·선택 키는 체크 해제와 무관하게 만든다(실패 계좌 줄만 남은 작업이 사라지지 않게)', () => {
    assert.strictEqual((WD.match(/_pmWorkEntries\([^()]*,_pmOn\)/g) || []).length, 0, '작업 목록을 _pmOn 으로 만들면 체크가 다 풀린 작업이 사라진다');
    assert.ok(/const _pmSelectableRow = it => it\.payable && !_pmNeedsMemo\(it\);/.test(WD));
    // 다운로드는 여전히 체크된 줄(_pmOn)만
    assert.ok(/_pmVisibleItems\(\)\.filter\(it=>it\.bank===bank && _pmOn\(it\)\)/.test(WD));
  });
  t('4a3 화면 배치가 바뀌어도(결정 217 되돌림) 실패 계좌 건수를 안내 줄과 표 줄이 말한다', () => {
    assert.ok(/const failedAgain = _pmFilterItems\(allItems,\{manager:_pmFilterState\(\)\.manager\}\)\.filter\(it=>it\.payable && \(it\.warnings\|\|\[\]\)\.includes\('failed_account'\)\)/.test(WD));
    assert.ok(/이미 이체가 실패한 계좌 그대로인 \$\{failedAgain\.length\}건/.test(WD));
    assert.ok(/이전 실패 계좌 \$\{Number\(it\.failedAccountCount\)\}회/.test(WD));
  });
  t('4F 다운로드 요청이 화면에 보이는 송금 계좌 지문(payoutFp)을 보낸다', () => {
    assert.ok(/rowIndex:it\.rowIndex, payoutFp:it\.payoutFp\}/.test(WD));
  });
  t('4W 안내줄이 "직원이 작업보드에서 고친 계좌로 보냅니다"를 말한다(서버 using 값으로만)', () => {
    assert.ok(/mm\.using==='workboard' && st/.test(WD) && /직원이 작업보드에서 고친 계좌로 보냅니다/.test(WD));
  });
  t('4b 안내줄이 "리뷰어가 고친 계좌로 보냅니다"를 말한다(서버 using 값으로만 갈린다)', () => {
    assert.ok(/mm\.using==='registered' && r/.test(WD) && /리뷰어가 내정보에서 고친 계좌로 보냅니다/.test(WD));
  });
  t('4c ★ 실패 안내문 3곳이 실제 동작과 같다(고친 계좌로 다시 시도)', () => {
    const notice = fs.readFileSync(SRC('services/paymentResult.service.js'), 'utf8');
    assert.ok(/수정하신 계좌로 다시 시도됩니다/.test(notice));
    assert.ok(!/다음 이체 때 자동으로 다시 시도됩니다/.test(notice));
    const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'index.html'), 'utf8');
    assert.ok(/수정하시면 다음 이체 때 수정하신 계좌로 다시 시도됩니다/.test(idx));
    const guide = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'docs', '입금관리_사용안내.html'), 'utf8');
    assert.ok(!/계좌를 고칠 필요 없이 다음 이체 때 자동으로 다시 나갑니다/.test(guide), '틀린 직원 안내가 남아 있다');
  });
  t('4d _holderKey 는 공백만 무시한다', () => {
    const svc = require(SRC('services/payment.service'));
    assert.strictEqual(svc._holderKey(' 임 혜정 '), '임혜정');
    assert.notStrictEqual(svc._holderKey('임혜정'), svc._holderKey('임혜증'));
  });

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
