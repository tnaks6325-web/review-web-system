/**
 * 회귀가드 — 입금관리 보류 사유 보완(작업 이체설정 · 리뷰어 계좌 · 결제금액 시트 폴백)
 *
 * 검사 방식
 *  §1 결제금액 판정: 순수함수 **실행**(사본 부재 포함)
 *  §2 은행 표기 해석: 순수함수 **실행**(모르는 값은 null = 추측 금지)
 *  §3 대상 추출: 스텁 pool 로 listPaymentTargets **실제 실행** — 우선순위·폴백·accountRef
 *  §4 보완 저장: 스텁 pool 로 서비스 **실제 실행** — 쓰기 표면·검증·오배정 차단
 *  §5 라우트: 라우터 스택 실검사 + 권한 미들웨어
 *  §6 프론트 배선: 묶음 목록·팝업·XSS(인덱스 전달) 고정
 *
 * 실행: node tests/paymentIssueFix.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const SRC = p => path.join(__dirname, '..', 'src', p);
const read = p => fs.readFileSync(SRC(p), 'utf8');
/** 줄 주석만 제거(블록 주석 정규식은 이 레포의 정규식 리터럴을 물어 코드를 통째로 지운다 — 실측) */
const noLineComments = s => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

/* ══════════════ 스텁 pool 주입 ══════════════
   payment.service 는 `require('../db/pool')` 로 pool 을 **직접** 받는다(구조분해 아님). */
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

(async function main() {

  /* ══════════════════════════════════════════════════════════
     §1 결제금액 판정 — 단일 출처
     ══════════════════════════════════════════════════════════ */
  console.log('\n§1 결제금액 판정(utils/paymentAmount)');
  const PA = require(SRC('utils/paymentAmount'));

  t('1a 정확일치가 부분일치를 이긴다 — 옵션금액이 결제금액을 못 이김', () => {
    assert.strictEqual(PA.extractAmountNumber({ '옵션금액': '9,900', '결제금액': '22,000원' }), 22000);
  });
  t('1b 통화·공백 표기를 숫자로', () => {
    assert.strictEqual(PA.extractAmountNumber({ '결제 금액': ' 31,400 원 ' }), 31400);
  });
  t('1c 부분일치 폴백(결제금액 칸이 없을 때)', () => {
    assert.strictEqual(PA.extractAmountNumber({ '소계금액': '12000' }), 12000);
  });
  t('1d 값이 없으면 0 — 추측하지 않는다', () => {
    assert.strictEqual(PA.extractAmountNumber({ '결제금액': '' }), 0);
    assert.strictEqual(PA.extractAmountNumber(null), 0);
    assert.strictEqual(PA.extractAmountNumber({ '이름': '홍길동' }), 0);
  });
  t('1e ★ 마이너스 표기를 음수로 읽지 않는다(합계가 조용히 줄면 입금 사고)', () => {
    assert.strictEqual(PA.extractAmountNumber({ '결제금액': '-' }), 0);
    assert.strictEqual(PA.extractAmountNumber({ '결제금액': '-5000' }), 5000, '부호는 버리고 금액만');
  });
  t('1f ★ 레거시 라우트가 사본을 다시 만들지 않았다(공용 함수 require)', () => {
    const src = read('routes/payment.routes.js');
    assert.ok(/require\(['"]\.\.\/utils\/paymentAmount['"]\)/.test(src), 'paymentAmount 를 require 해야 한다');
    assert.ok(!/function\s+_extractAmount\s*\(/.test(src), '_extractAmount 사본이 되살아났다');
  });
  t('1g SQL 필터는 판정의 **상위집합**이다(정확일치 후보가 필터에 포함)', () => {
    for (const k of PA.EXACT_KEYS) assert.ok(PA.isAmountCandidateHeader(k), k + ' 가 후보에서 빠졌다');
    assert.ok(PA.isAmountCandidateHeader('옵션금액'));
    assert.ok(!PA.isAmountCandidateHeader('수취인'));
  });

  /* ══════════════════════════════════════════════════════════
     §2 은행 표기 해석
     ══════════════════════════════════════════════════════════ */
  console.log('\n§2 이체은행 표기 해석');
  const svc0 = require(SRC('services/payment.service'));

  t('2a 코드값·한글 라벨 양쪽을 해석(저장소가 둘이다)', () => {
    assert.strictEqual(svc0.normalizeBankChoice('kbank'), 'kbank');
    assert.strictEqual(svc0.normalizeBankChoice('케이뱅크'), 'kbank');
    assert.strictEqual(svc0.normalizeBankChoice('하나은행'), 'hana');
    assert.strictEqual(svc0.normalizeBankChoice(' 하나 '), 'hana');
  });
  t('2b ★ 모르는 값은 null — 추측하면 남의 계좌로 송금된다(정확일치만)', () => {
    // ★ 부분일치로 완화하면 아래가 조용히 통과한다 — 두 은행 **양쪽** 다 막는다
    //   (한쪽만 검사하면 반대쪽 완화를 가드가 놓친다 — 변이시험으로 실측)
    for (const bad of ['하나증권', '하나증권주식회사', '케이뱅크증권', '케이뱅크저축은행',
                       '구 하나은행', '하나은행(구)', '국민은행', '카카오뱅크', '토스뱅크', '  ']) {
      assert.strictEqual(svc0.normalizeBankChoice(bad), null, `'${bad}' 을 해석하면 안 된다`);
    }
    assert.strictEqual(svc0.normalizeBankChoice(''), null);
    assert.strictEqual(svc0.normalizeBankChoice(null), null);
    assert.strictEqual(svc0.normalizeBankChoice(undefined), null);
  });
  t('2c 탭 설정에 되쓰는 표기는 **한글 라벨**(관리자 대시보드가 문자열 비교로 배지를 그린다)', () => {
    assert.strictEqual(svc0.tabBankLabel('kbank'), '케이뱅크');
    assert.strictEqual(svc0.tabBankLabel('hana'), '하나은행');
    const admin = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'index-app.js'), 'utf8');
    assert.ok(admin.includes("transferBank === '케이뱅크'"), '탭설정 화면이 한글 라벨을 비교한다 — 표기를 바꾸면 그 배지가 죽는다');
  });

  /* ══════════════════════════════════════════════════════════
     §3 입금대상 추출 — 우선순위·폴백·편집 대상
     ══════════════════════════════════════════════════════════ */
  console.log('\n§3 입금대상 추출(listPaymentTargets 실행)');

  // 공통 스텁: 대상 1행 + 탭 메타 + 계좌
  function targetsHandler(opts) {
    return (sql) => {
      if (/FROM review_index ri/.test(sql)) {
        return { rows: [{
          sheetId: 'S1', tabName: 'T1', rowIndex: 10, reviewerName: '홍길동', phone8: '12345678',
          startDate: '5 / 8 (목)', productName: '욕실화',
          amountCells: opts.amountCells || null,
        }] };
      }
      if (/FROM recruit_campaigns c/.test(sql)) return { rows: opts.campRows || [] };
      if (/campaign_fee_schedules/.test(sql)) return { rows: [] };
      if (/FROM order_submissions/.test(sql)) return { rows: opts.orderRows || [] };
      if (/jsonb_array_elements/.test(sql)) return { rows: opts.subRows || [] };
      if (/FROM reviewers WHERE phone8/.test(sql)) return { rows: opts.ownRows || [] };
      if (/FROM tab_configs tc/.test(sql)) return { rows: opts.tabRows || [] };
      return { rows: [] };
    };
  }

  await ta('3a ★ 탭 설정 이체은행을 인정한다(공고 없는 옛 작업의 no_bank 해소)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: '(완)5/8', transferBank: '케이뱅크', depositName: '망고', goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '123456', accountHolder: '홍길동' }],
      amountCells: { '결제금액': '22,000' },
    }), async (svc) => {
      const { items } = await svc.listPaymentTargets();
      const it = items[0];
      assert.strictEqual(it.bank, 'kbank');
      assert.strictEqual(it.bankSource, 'tab');
      assert.ok(!it.issues.includes('no_bank'), '보류가 풀려야 한다: ' + it.issues.join(','));
      assert.strictEqual(it.transferMemo, '망고');
      assert.strictEqual(it.memoSource, 'tab');
    });
  });

  await ta('3b 공고 값이 탭 값을 이긴다(판정 순서 = 저장 대상 선택과 같다)', async () => {
    await withStubPool(targetsHandler({
      campRows: [{ id: 'C1', title: '공고', sheetId: 'S1', tabName: 'T1', reviewFee: 1000,
        transferBank: 'hana', transferMemo: '공고표시', campStartDate: null, goodsCostType: '' }],
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '케이뱅크', depositName: '탭표시', goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.bank, 'hana');
      assert.strictEqual(it.bankSource, 'campaign');
      assert.strictEqual(it.transferMemo, '공고표시');
    });
  });

  await ta('3c 자동판정은 탭 기준으로도 동작(공고 없는 작업도 물건비를 본다)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '', depositName: '', goodsCostType: '현금이체' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.bank, 'hana');
      assert.strictEqual(it.bankSource, 'auto');
      assert.strictEqual(it.bankAuto, true);
    });
  });

  await ta('3d ★ 상품비 시트 폴백 — 주문 원장이 없어도 금액이 선다', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '22,000원' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.productPrice, 22000);
      assert.strictEqual(it.priceSource, 'sheet');
      assert.ok(!it.issues.includes('no_price'));
      assert.ok(!it.issues.includes('zero_amount'));
      assert.strictEqual(it.payable, true);
    });
  });

  await ta('3e 주문 원장이 있으면 그 값이 우선(폴백은 없을 때만)', async () => {
    await withStubPool(targetsHandler({
      orderRows: [{ sheetId: 'S1', tabName: 'T1', sheetRow: 10, price: 30000, feeSnapshot: null, orderedAt: null }],
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '22,000원' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.productPrice, 30000);
      assert.strictEqual(it.priceSource, 'order');
    });
  });

  await ta('3f 시트에도 금액이 없으면 보류 유지(꾸미지 않는다)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: null,
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.productPrice, 0);
      assert.strictEqual(it.priceSource, null);
      assert.ok(it.issues.includes('no_price'));
      assert.strictEqual(it.payable, false);
    });
  });

  await ta('3g accountRef = reviewers.id (★ phone8 로 지목하지 않는다)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', goodsCostType: '' }],
      ownRows: [{ reviewerId: '22222222-2222-2222-2222-222222222222', phone8: '12345678', bankName: '', bankAccount: '', accountHolder: '' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountRef.reviewerId, '22222222-2222-2222-2222-222222222222');
      assert.strictEqual(it.accountRef.subPhone8, null, '본계정은 sub 키가 없어야 한다');
      assert.ok(it.issues.includes('no_account'));
    });
  });

  await ta('3h 타계정은 소유자 id + 그 명의 phone8 을 함께 지목', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', goodsCostType: '' }],
      subRows: [{ phone8: '12345678', reviewerId: '33333333-3333-3333-3333-333333333333', name: '홍길동', bankName: '', bankAccount: '', accountHolder: '' }],
      ownRows: [],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.isSub, true);
      assert.strictEqual(it.accountRef.reviewerId, '33333333-3333-3333-3333-333333333333');
      assert.strictEqual(it.accountRef.subPhone8, '12345678');
    });
  });

  await ta('3i 리뷰어 미등록이면 accountRef 는 null(고칠 대상이 없음을 화면이 알아야 한다)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', goodsCostType: '' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.accountRef, null);
      assert.ok(it.issues.includes('no_reviewer'));
    });
  });

  await ta('3j ★ 자리표시자 정합 — 금액 후보($2)와 선택 필터($3·$4)가 안 어긋난다', async () => {
    await withStubPool(targetsHandler({ tabRows: [], amountCells: null }), async (svc, calls) => {
      await svc.listPaymentTargets({ sheetId: 'S1', tabName: 'T1' });
      const q = calls.find(c => /FROM review_index ri/.test(c.sql));
      const used = new Set((q.sql.match(/\$\d+/g) || []).map(s => parseInt(s.slice(1), 10)));
      assert.strictEqual(q.params.length, 4, '파라미터 4개');
      for (const n of used) assert.ok(n <= q.params.length, `$${n} 자리표시자에 파라미터가 없다`);
      assert.deepStrictEqual(q.params[1], PA.EXACT_KEYS, '$2 = 결제금액 정확일치 후보');
      assert.strictEqual(q.params[2], 'S1');
      assert.strictEqual(q.params[3], 'T1');
    });
  });

  t('3k ★ row_json 을 통째로 SELECT 하지 않는다(2000행 전송 방지)', () => {
    const src = noLineComments(read('services/payment.service.js'));
    const q = src.slice(src.indexOf('FROM review_index ri') - 2000, src.indexOf('FROM review_index ri'));
    assert.ok(!/ri\.row_json\s+AS/.test(q), 'row_json 을 통째로 싣고 있다');
    assert.ok(/jsonb_object_agg/.test(src), '후보 칸만 모으는 집계가 있어야 한다');
  });

  /* ══════════════════════════════════════════════════════════
     §4 보완 저장
     ══════════════════════════════════════════════════════════ */
  console.log('\n§4 보완 저장(saveTransferSetting · saveReviewerAccount)');

  await ta('4a 공고가 있으면 공고에 저장 — 이체설정 2칸만 UPDATE', async () => {
    await withStubPool((sql) => {
      if (/FROM recruit_campaigns/.test(sql) && /linked_sheet_id/.test(sql)) return { rows: [{ id: 'C1' }] };
      return { rows: [], rowCount: 1 };
    }, async (svc, calls) => {
      const out = await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', campaignId: 'C1', bank: 'kbank', memo: '망고' });
      assert.strictEqual(out.target, 'campaign');
      const upd = calls.find(c => /UPDATE recruit_campaigns/.test(c.sql));
      assert.ok(upd, '공고 UPDATE 가 없다');
      const setCols = (upd.sql.match(/SET([\s\S]*?)WHERE/)[1].match(/(\w+)\s*=\s*CASE/g) || []);
      assert.deepStrictEqual(setCols.map(s => s.split(/\s/)[0]).sort(), ['transfer_bank', 'transfer_memo'],
        '★ 공고의 다른 설정을 건드리면 안 된다(축약 폼 클로버)');
    });
  });

  await ta('4b 공고가 없으면 탭 설정에 저장 — 표기는 한글 라벨', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      const out = await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', campaignId: null, bank: 'hana', memo: '망고' });
      assert.strictEqual(out.target, 'tab');
      const upd = calls.find(c => /UPDATE tab_configs/.test(c.sql));
      assert.ok(upd.params.includes('하나은행'), '탭에는 한글 라벨로 저장해야 한다: ' + JSON.stringify(upd.params));
      assert.ok(/deposit_name/.test(upd.sql), '통장표시는 tab_configs.deposit_name');
    });
  });

  await ta('4c ★ 그 탭에 연결되지 않은 공고는 거부(낡은 화면이 남의 공고를 덮는 것 차단)', async () => {
    await withStubPool((sql) => {
      if (/FROM recruit_campaigns/.test(sql)) return { rows: [] };   // 연결 아님
      return { rows: [], rowCount: 1 };
    }, async (svc, calls) => {
      await assert.rejects(() => svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', campaignId: 'CX', bank: 'hana' }),
        e => e.code === 'campaign_mismatch');
      assert.ok(!calls.some(c => /UPDATE/.test(c.sql)), '거부 시 쓰기 쿼리 0건이어야 한다');
    });
  });

  await ta('4d 모르는 은행 표기는 저장하지 않는다', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      await assert.rejects(() => svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', bank: '하나증권' }),
        e => e.code === 'bad_bank');
      assert.ok(!calls.some(c => /UPDATE/.test(c.sql)), '쓰기 0건');
    });
  });

  await ta('4e 미전송 필드는 건드리지 않는다(부분 저장)', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', bank: 'hana' });   // memo 미전송
      const upd = calls.find(c => /UPDATE tab_configs/.test(c.sql));
      assert.strictEqual(upd.params[4], false, 'memo 를 안 보냈으면 touchMemo=false 여야 한다');
      await assert.rejects(() => svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1' }), e => e.code === 'empty');
    });
  });

  await ta('4f 탭 설정 행이 없으면 사유를 말한다(조용한 성공 금지)', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 0 }), async (svc) => {
      await assert.rejects(() => svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', bank: 'hana' }),
        e => e.code === 'tab_not_found');
    });
  });

  await ta('4g 리뷰어 계좌 — reviewers.id 로 지목하고 빈 칸은 안 덮는다', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      const out = await svc.saveReviewerAccount({
        reviewerId: '22222222-2222-2222-2222-222222222222',
        bankName: '국민은행', bankAccount: '123-456', accountHolder: '',
      });
      assert.strictEqual(out.target, 'self');
      const upd = calls.find(c => /UPDATE reviewers/.test(c.sql));
      assert.ok(/WHERE id = \$1/.test(upd.sql), '★ phone8 이 아니라 id 로 지목해야 한다');
      assert.ok(!/phone8/.test(upd.sql), 'phone8 을 키로 쓰면 같은 뒤8자리 타인 계좌를 덮는다');
      assert.strictEqual(upd.params[3], '', '빈 예금주는 CASE 로 미갱신');
      assert.ok(/CASE WHEN \$4::text <> ''/.test(upd.sql));
      assert.strictEqual(upd.params[2], '123456', '계좌번호는 정규화(숫자만)');
    });
  });

  await ta('4h ★ 인식 못 하는 은행명은 저장 시점에 막는다(막다른 길 방지)', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      await assert.rejects(() => svc.saveReviewerAccount({
        reviewerId: '22222222-2222-2222-2222-222222222222', bankName: '없는은행',
      }), e => e.code === 'bad_bank_name');
      assert.ok(!calls.some(c => /UPDATE/.test(c.sql)), '쓰기 0건');
    });
  });

  await ta('4i 타계정은 그 명의 항목만 병합(소유자 공통계좌 보존)', async () => {
    await withStubPool((sql) => {
      if (/SELECT sub_accounts/.test(sql)) return { rows: [{ sub_accounts: [
        { name: 'A', phone: '010-1111-2222', bankAccount: '기존A' },
        { name: 'B', phone: '010-3333-4444' },
      ] }] };
      return { rows: [], rowCount: 1 };
    }, async (svc, calls) => {
      const out = await svc.saveReviewerAccount({
        reviewerId: '22222222-2222-2222-2222-222222222222', subPhone8: '33334444',
        bankName: '카카오뱅크', bankAccount: '9999', accountHolder: 'B',
      });
      assert.strictEqual(out.target, 'sub');
      const upd = calls.find(c => /UPDATE reviewers SET sub_accounts/.test(c.sql));
      const arr = JSON.parse(upd.params[1]);
      assert.strictEqual(arr[0].bankAccount, '기존A', '★ 다른 명의 항목을 건드리면 안 된다');
      assert.strictEqual(arr[1].bankAccount, '9999');
      assert.strictEqual(arr[1].bankName, '카카오뱅크');
      assert.ok(!/bank_name/.test(upd.sql), '타계정 저장이 소유자 공통계좌 컬럼을 덮으면 안 된다');
    });
  });

  await ta('4j 없는 타계정은 거부', async () => {
    await withStubPool((sql) => {
      if (/SELECT sub_accounts/.test(sql)) return { rows: [{ sub_accounts: [] }] };
      return { rows: [], rowCount: 1 };
    }, async (svc) => {
      await assert.rejects(() => svc.saveReviewerAccount({
        reviewerId: '22222222-2222-2222-2222-222222222222', subPhone8: '99999999', bankName: '국민은행',
      }), e => e.code === 'sub_not_found');
    });
  });

  t('4k ★ 쓰기 표면 = 공고 이체설정 · 탭 이체설정 · 리뷰어 계좌 뿐', () => {
    const src = noLineComments(read('services/payment.service.js'));
    const fixBlock = src.slice(src.indexOf('class PaymentFixError'));
    const writes = (fixBlock.match(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(\w+)/g) || []).map(s => s.split(/\s+/).pop());
    assert.deepStrictEqual([...new Set(writes)].sort(), ['recruit_campaigns', 'reviewers', 'tab_configs'],
      '보완 경로가 다른 테이블을 건드린다: ' + writes.join(','));
    assert.ok(!/order_submissions|payment_batch|review_index/.test(fixBlock.replace(/\/\/.*$/gm, '')),
      '주문 원장·회차·검색인덱스는 보완 경로가 건드리지 않는다');
  });

  /* ══════════════════════════════════════════════════════════
     §5 라우트
     ══════════════════════════════════════════════════════════ */
  console.log('\n§5 라우트');

  t('5a 두 라우트가 실제로 등록돼 있고 adminOrMaster 게이트를 탄다', () => {
    const router = require(SRC('routes/trackB.routes'));
    const find = p => router.stack.find(l => l.route && l.route.path === p && l.route.methods.post);
    for (const p of ['/payment/transfer-setting', '/payment/reviewer-account']) {
      const layer = find(p);
      assert.ok(layer, p + ' 라우트가 없다');
      const names = layer.route.stack.map(s => s.handle.name);
      assert.ok(names.includes('authMiddleware'), p + ' — authMiddleware 누락(역할 미들웨어가 req.admin 을 못 읽는다)');
      assert.ok(names.some(n => /adminOrMaster/.test(n)), p + ' — adminOrMaster 누락');
    }
  });

  t('5b 검증 실패는 400대로 내려간다(errorHandler 500 마스킹 방지)', () => {
    const src = noLineComments(read('routes/trackB.routes.js'));
    const blk = src.slice(src.indexOf('_PAY_FIX_STATUS'), src.indexOf('_PAY_FIX_STATUS') + 900);
    for (const code of ['bad_target', 'empty', 'bad_bank', 'bad_bank_name', 'campaign_mismatch', 'tab_not_found', 'reviewer_not_found', 'sub_not_found']) {
      assert.ok(blk.includes(code), code + ' 매핑 누락');
    }
    assert.ok(/42P01/.test(src) && /not_ready/.test(src), '스키마 미적용 사유를 말해야 한다');
  });

  /* ══════════════════════════════════════════════════════════
     §6 프론트 배선
     ══════════════════════════════════════════════════════════ */
  console.log('\n§6 프론트 배선(workdesk.html)');
  const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'workdesk.html'), 'utf8');

  t('6a 인라인 스크립트가 파싱된다', () => {
    const vm = require('vm');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m, n = 0;
    while ((m = re.exec(HTML))) { n++; new vm.Script(m[1]); }
    assert.ok(n >= 1);
  });

  t('6b 상단 묶음 목록 + 팝업 2종 + 행별 [보완] 이 모두 배선돼 있다', () => {
    for (const s of ['_pmBuildFix', '_pmFixBlock', '_pmFixWork', '_pmFixAcct', '_pmRowFix', '_pmRowMemo', '_pmDialog']) {
      assert.ok(HTML.includes('function ' + s), s + ' 없음');
    }
    assert.ok(/\$\{_pmFixBlock\(\)\}/.test(HTML), '묶음 목록이 화면에 렌더되지 않는다');
    assert.ok(/onclick="_pmRowFix\(\$\{idx\}\)"/.test(HTML), '행별 [보완] 버튼 배선 없음');
  });

  t('6c ★★ onclick 에 시트발 문자열을 보간하지 않는다(인덱스만)', () => {
    // 표 행의 모든 onclick 인자가 숫자 인덱스여야 한다
    const tbl = HTML.slice(HTML.indexOf('function _pmTargetTable'), HTML.indexOf('function _pmBatchTable'));
    const handlers = tbl.match(/onclick="[^"]*"|onchange="[^"]*"/g) || [];
    assert.ok(handlers.length >= 3, '표에 핸들러가 없다');
    for (const h of handlers) {
      assert.ok(/\(\$\{idx\}(,[^)]*)?\)/.test(h), '인덱스가 아닌 값을 넘긴다: ' + h);
      assert.ok(!/esc\(/.test(h), 'onclick 안에서 esc() 로 문자열을 보간하고 있다(엔티티 디코드로 탈출된다): ' + h);
    }
  });

  t('6d 팝업은 body 직속이고 바깥클릭으로 닫히지 않는다(입력값 보호)', () => {
    const dlg = HTML.slice(HTML.indexOf('function _pmDialog'), HTML.indexOf('function _pmCloseDialog'));
    assert.ok(/document\.body\.appendChild\(ov\)/.test(dlg), 'body 직속 마운트가 아니다');
    assert.ok(!/ov\.onclick/.test(dlg) && !/ov\.addEventListener\('click'/.test(dlg), '바깥클릭 닫기가 생겼다');
    assert.ok(/Escape/.test(dlg), 'Esc 로 닫는 길이 없다');
    assert.ok(/pmFixCancel/.test(dlg), '[취소] 버튼이 없다 — 못 닫는 팝업 금지');
  });

  t('6e Esc 리스너는 닫을 때 떼어낸다(겹쳐 쌓이지 않게)', () => {
    const close = HTML.slice(HTML.indexOf('function _pmCloseDialog'), HTML.indexOf('function _pmCloseDialog') + 400);
    assert.ok(/removeEventListener\('keydown'/.test(close), '리스너 해제가 없다');
  });

  t('6f 고칠 수 없는 사유는 버튼이 아니라 문장으로 안내한다', () => {
    const blk = HTML.slice(HTML.indexOf('function _pmFixBlock'), HTML.indexOf('function _pmFixWork'));
    assert.ok(/등록된 리뷰어가 없어/.test(blk), '리뷰어 미등록 안내 없음');
    assert.ok(/시트 결제금액 칸에도/.test(blk), '결제금액 없음 안내 없음');
    // 그 카드에는 보완 버튼이 없어야 한다
    const infoCards = blk.match(/pmfixcard info[\s\S]*?<\/div>`/g) || [];
    assert.ok(infoCards.length >= 2, '안내 카드 2종이 있어야 한다');
    for (const c of infoCards) assert.ok(!/_pmFix(Work|Acct)\(/.test(c), '고칠 수 없는 사유에 버튼이 붙었다');
  });

  t('6h ★ 저장 성공 뒤 순서 = 닫기 → 안내 → 재조회(후처리 실패가 성공을 실패처럼 보이게 하면 안 된다)', () => {
    const fn = HTML.slice(HTML.indexOf('function _pmAfterFix'), HTML.indexOf('/* ── 공용 팝업 골격'));
    const close = fn.indexOf('_pmCloseDialog()'), t2 = fn.indexOf('toast('), load = fn.indexOf('_pmLoad()');
    assert.ok(close >= 0 && t2 > close && load > close, '닫기가 먼저여야 한다: ' + fn);
    assert.ok(/try\{\s*toast\(/.test(fn), '안내 실패가 재조회를 막으면 안 된다');
    // 두 팝업 모두 이 마무리를 쓴다(사본을 두면 한쪽만 안 닫힌다)
    const work = HTML.slice(HTML.indexOf('function _pmFixWork'), HTML.indexOf('function _pmPickBank'));
    const acct = HTML.slice(HTML.indexOf('function _pmFixAcct'), HTML.indexOf('/** 저장 성공 뒤 공통 마무리'));
    for (const [n, s] of [['작업', work], ['리뷰어', acct]]) {
      assert.ok(/_pmAfterFix\(/.test(s), n + ' 팝업이 공통 마무리를 쓰지 않는다');
      assert.ok(!/await _pmLoad\(\);\s*return true/.test(s), n + ' 팝업이 옛 순서(재조회 후 닫기)로 되돌아갔다');
    }
  });

  t('6i onOk 예외를 삼키지 않고 사유를 말한다(조용히 버튼만 되살아나면 원인을 모른다)', () => {
    const dlg = HTML.slice(HTML.indexOf('function _pmDialog'), HTML.indexOf('function _pmCloseDialog'));
    assert.ok(/catch\(e\)\{[\s\S]*?toast\(/.test(dlg), 'onOk 예외 안내가 없다');
  });

  t('6g 표 [보완] 버튼은 고칠 수 있을 때만 그린다(죽은 버튼 금지)', () => {
    const tbl = HTML.slice(HTML.indexOf('function _pmTargetTable'), HTML.indexOf('function _pmBatchTable'));
    assert.ok(/const fixable[\s\S]*?PAY_FIX_KIND/.test(tbl), '고칠 수 있는지 판정이 없다');
    assert.ok(/accountRef && it\.accountRef\.reviewerId/.test(tbl), '리뷰어 지목이 불가능한 행까지 버튼을 그린다');
    assert.ok(/fixable \? `<button/.test(tbl), '조건부 렌더가 아니다');
  });

  /* ══════════════════════════════════════════════════════════
     §7 묶음 판정 **실행** — 정적 검사로는 "일괄 해결"이 고정되지 않는다
     ══════════════════════════════════════════════════════════ */
  console.log('\n§7 묶음 판정 실행(_pmBuildFix / _pmFixBlock)');

  function loadFixFns() {
    const vm = require('vm');
    const pick = name => {
      const i = HTML.indexOf('function ' + name + '(');
      assert.ok(i > 0, name + ' 를 찾지 못했다');
      // 함수 끝 = 다음 최상위 `function ` 선언 직전(이 블록은 최상위 함수들이 나란히 있다)
      const j = HTML.indexOf('\nfunction ', i + 1);
      return HTML.slice(i, j > 0 ? j : i + 6000);
    };
    const src = [pick('_pmBuildFix'), pick('_pmFixBlock')].join('\n');
    const sandbox = {
      esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      _pmKey: it => it.sheetId + '||' + it.tabName + '||' + it.rowIndex,
      PAY_ACCT_ISSUES: ['bank_unknown', 'no_account', 'no_holder'],
      PAY_ISSUE_LABEL: { no_account: '계좌 미등록', bank_unknown: '은행명 인식불가', no_holder: '예금주 미등록' },
      STATE: {},
    };
    vm.createContext(sandbox);
    new vm.Script(src).runInContext(sandbox);
    return sandbox;
  }

  const mkItem = (o = {}) => Object.assign({
    sheetId: 'S1', tabName: 'T1', rowIndex: 1, tabLabel: '(완)5/8_쟈니베어', reviewerName: '차세희',
    campaignId: null, campaignTitle: '', bank: '', bankSource: null, transferMemo: '', memoSource: null,
    isSub: false, bankName: '', bankAccount: '', accountHolder: '', accountRef: null,
    issues: [], warnings: [],
  }, o);

  t('7a ★ 같은 작업의 이체은행 미지정 N건이 **한 묶음**이 된다(일괄 해결의 근거)', () => {
    const S = loadFixFns();
    const items = [1, 2, 3].map(i => mkItem({ rowIndex: i, issues: ['no_bank'] }));
    const f = S._pmBuildFix(items);
    assert.strictEqual(f.works.length, 1, '작업 1개로 묶여야 한다');
    assert.strictEqual(f.works[0].rows, 3, '3건이 함께 걸려야 한다');
    assert.strictEqual(f.works[0].needBank, true);
  });

  t('7b 다른 작업은 따로 묶이고, 건수 많은 작업이 먼저 온다', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix([
      mkItem({ rowIndex: 1, issues: ['no_bank'] }),
      mkItem({ tabName: 'T2', tabLabel: 'B작업', rowIndex: 2, issues: ['no_bank'] }),
      mkItem({ tabName: 'T2', tabLabel: 'B작업', rowIndex: 3, issues: ['no_bank'] }),
    ]);
    assert.strictEqual(f.works.length, 2);
    assert.strictEqual(f.works[0].tabName, 'T2', '건수 많은 작업 우선');
  });

  t('7c 통장표시(warning)도 같은 작업 묶음에 합류한다', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix([mkItem({ issues: [], warnings: ['no_memo'] })]);
    assert.strictEqual(f.works.length, 1);
    assert.strictEqual(f.works[0].needMemo, true);
    assert.strictEqual(f.works[0].needBank, false, '은행은 멀쩡한데 은행 카드에 들어가면 안 된다');
  });

  t('7d ★ 리뷰어는 accountRef 기준으로 묶인다(같은 사람의 여러 작업이 한 번에)', () => {
    const S = loadFixFns();
    const ref = { reviewerId: 'r-1', subPhone8: null };
    const f = S._pmBuildFix([
      mkItem({ rowIndex: 1, issues: ['no_account'], accountRef: ref }),
      mkItem({ tabName: 'T2', rowIndex: 2, issues: ['no_holder'], accountRef: ref }),
    ]);
    assert.strictEqual(f.accts.length, 1, '같은 리뷰어는 한 묶음');
    assert.strictEqual(f.accts[0].rows, 2);
    // vm 컨텍스트의 배열은 프로토타입이 달라 deepStrictEqual 이 참조 비교에서 걸린다 — 값으로 본다
    assert.strictEqual([...f.accts[0].issues].sort().join(','), 'no_account,no_holder');
  });

  t('7e 본계정과 타계정은 **다른 묶음**(전용계좌를 공통계좌로 덮지 않게)', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix([
      mkItem({ rowIndex: 1, issues: ['no_account'], accountRef: { reviewerId: 'r-1', subPhone8: null } }),
      mkItem({ rowIndex: 2, issues: ['no_account'], isSub: true, accountRef: { reviewerId: 'r-1', subPhone8: '12345678' } }),
    ]);
    assert.strictEqual(f.accts.length, 2);
  });

  t('7f 지목 불가(리뷰어 미등록)는 고칠 목록이 아니라 안내로 센다', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix([mkItem({ issues: ['no_reviewer', 'no_account'], accountRef: null })]);
    assert.strictEqual(f.accts.length, 0, '버튼을 만들면 눌러도 아무 일 없는 막다른 길이 된다');
    assert.strictEqual(f.noReviewer, 1, '같은 행을 두 번 세면 안 된다');
  });

  t('7g 결제금액 없음은 별도 안내(서버 시트 폴백 뒤에도 남은 건)', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix([mkItem({ issues: ['no_price', 'zero_amount'] })]);
    assert.strictEqual(f.noPrice, 1);
    assert.strictEqual(f.works.length, 0);
  });

  t('7h 보류가 하나도 없으면 묶음 블록을 아예 그리지 않는다', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([mkItem({ transferMemo: '망고', warnings: [] })]);
    assert.strictEqual(S._pmFixBlock(), '', '고칠 게 없는데 노란 박스가 뜨면 신호가 죽는다');
  });

  t('7i ★ 묶음 블록 렌더 — 작업명이 이스케이프되고 버튼은 인덱스만 넘긴다', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabLabel: `x"><img src=x onerror=alert(1)>`, issues: ['no_bank'] }),
      mkItem({ rowIndex: 2, issues: ['no_account'], accountRef: { reviewerId: 'r-1', subPhone8: null }, reviewerName: `<script>` }),
    ]);
    const html = S._pmFixBlock();
    assert.ok(!/<img src=x/.test(html), '작업명이 이스케이프되지 않았다');
    assert.ok(!/<script>/.test(html.replace(/&lt;script&gt;/g, '')), '리뷰어명이 이스케이프되지 않았다');
    assert.ok(/_pmFixWork\(0\)/.test(html), '작업 버튼이 인덱스를 넘겨야 한다');
    assert.ok(/_pmFixAcct\(0\)/.test(html), '리뷰어 버튼이 인덱스를 넘겨야 한다');
    assert.ok(/이체은행 미지정/.test(html) && /계좌 정보 보완/.test(html));
  });

  t('7j 묶음 인덱스 = STATE.pmFix 배열 인덱스(팝업이 엉뚱한 작업을 열지 않게)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabName: 'T1', tabLabel: 'A', issues: [], warnings: ['no_memo'] }),        // memo 전용
      mkItem({ tabName: 'T2', tabLabel: 'B', rowIndex: 2, issues: ['no_bank'] }),
      mkItem({ tabName: 'T2', tabLabel: 'B', rowIndex: 3, issues: ['no_bank'] }),
    ]);
    const html = S._pmFixBlock();
    // 은행 카드의 버튼 인덱스는 works 배열에서 T2 의 위치여야 한다(필터된 배열 위치가 아니라)
    const bankCard = html.slice(html.indexOf('이체은행 미지정'), html.indexOf('통장표시 없음'));
    const idx = parseInt(bankCard.match(/_pmFixWork\((\d+)\)/)[1], 10);
    assert.strictEqual(S.STATE.pmFix.works[idx].tabName, 'T2',
      '★ 필터한 배열의 인덱스를 넘기면 다른 작업이 열린다');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
