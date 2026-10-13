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
    if (/JOIN payment_batch_items pi/.test(sql)) {
      if (o.throwFailed) throw new Error('failed boom');
      return { rows: o.failedRows || [] };
    }
    if (/FROM reviewer_account_change_audit/.test(sql)) {
      if (o.throwAudit) throw new Error('audit boom');
      return { rows: o.auditRows || [] };
    }
    if (/FROM order_submissions/.test(sql) && !/FROM unnest/.test(sql)) return { rows: [{
      sheetId: 'S1', tabName: 'T1', sheetRow: 18, price: '16000', feeSnapshot: null, orderedAt: ORDERED, orderUpdatedAt: o.orderUpdatedAt || null,
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

  await ta('1e2 타계정 명의 항목이 주문 뒤 바뀌었으면 고친 계좌', () =>
    run({ subRows: [{ phone8: '29893727', reviewerId: RID, name: '임혜정', ownerName: '소유자',
                      bankName: '하나은행', bankAccount: REG_GOOD, accountHolder: '임혜정' }],
          auditRows: [{ reviewerId: RID, sub: '29893727', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, REG_GOOD);
    }));

  await ta('1f 주문 기록이 내정보 변경보다 나중에 수정됐으면(관리자가 양식 계좌를 고친 경우) 양식 계좌 유지', () =>
    run({ ownRows: own(), orderUpdatedAt: '2026-10-09T09:00:00+09:00',
          auditRows: [{ reviewerId: RID, sub: '', at: '2026-10-08T10:00:00+09:00' }] }, it => {
      assert.strictEqual(it.bankAccount, FORM_BAD);
    }));

  t('1g ★ 이름으로만 찾은 타계정(번호 없음)은 예외에서 뺀다 — 회차 스냅샷이 self 로 박제돼 다운로드가 막힌다', () => {
    const src = fs.readFileSync(SRC('services/payment.service.js'), 'utf8');
    assert.ok(/const regTargetable = !!registeredAcct && !\(registeredAcct\.isSub && registeredAcct\.subPhone8 === null\);/.test(src));
    assert.ok(/sameHolder && regTargetable/.test(src));
    // 변경 기록 조회는 인덱스를 타는 uuid 비교
    assert.ok(/WHERE reviewer_id = ANY\(\$1::uuid\[\]\)/.test(src));
  });

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
    assert.ok(/includes\('failed_account'\) && !_retryOk\.has\(_pmKey\(it\)\)\) STATE\.pmExcluded\[_pmKey\(it\)\] = true/.test(WD));
    assert.ok(/if\(on\) ok\.add\(key\); else ok\.delete\(key\);/.test(WD));
  });
  t('4a2 ★ 작업 목록·선택 키는 체크 해제와 무관하게 만든다(실패 계좌 줄만 남은 작업이 사라지지 않게)', () => {
    assert.strictEqual((WD.match(/_pmWorkEntries\([^()]*,_pmOn\)/g) || []).length, 0, '작업 목록을 _pmOn 으로 만들면 체크가 다 풀린 작업이 사라진다');
    assert.ok(/const _pmSelectableRow = it => it\.payable && !_pmNeedsMemo\(it\);/.test(WD));
    // 다운로드는 여전히 체크된 줄(_pmOn)만
    assert.ok(/_pmVisibleItems\(\)\.filter\(it=>it\.bank===bank && _pmOn\(it\)\)/.test(WD));
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
