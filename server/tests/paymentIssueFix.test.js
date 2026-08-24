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
        if (opts.rows) return { rows: opts.rows.map(r => Object.assign({ amountCells: opts.amountCells || null }, r)) };
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

  /* ── 리뷰비(128) — 판정은 여전히 082 단일 출처, **폴백 순서만** 공고 → 탭으로 넓혔다 ── */
  await ta('3c2 ★ 공고 없는 작업도 탭 리뷰비가 이체금액에 실린다(상품비만 나가던 것)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', reviewFee: 3000, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '22,000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.reviewFee, 3000);
      assert.strictEqual(it.feeSource, 'tab');
      assert.strictEqual(it.amount, 25000, '이체금액 = 상품비 + 리뷰비');
      assert.ok(!(it.warnings || []).includes('no_review_fee'));
    });
  });

  await ta('3c3 공고 리뷰비가 탭 값을 이긴다 · 탭 미설정이면 0(추측 금지)', async () => {
    await withStubPool(targetsHandler({
      campRows: [{ id: 'C1', title: '공고', sheetId: 'S1', tabName: 'T1', reviewFee: 1500,
        transferBank: 'hana', transferMemo: 'M', campStartDate: null, goodsCostType: '' }],
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '', depositName: '', reviewFee: 3000, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.reviewFee, 1500);
      assert.strictEqual(it.feeSource, 'campaign');
    });
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', reviewFee: null, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.reviewFee, 0);
      assert.strictEqual(it.feeSource, null, '미설정을 "탭에서 왔다"고 말하면 안 된다');
      assert.ok(!(it.warnings || []).includes('no_review_fee'), '★ 0 = 리뷰비 없는 작업 — 경고하지 않는다');
    });
  });

  await ta('3c4 ★★ 스냅샷은 여전히 최우선 — 탭 리뷰비가 참여 시점 금액을 덮지 않는다', async () => {
    await withStubPool(targetsHandler({
      orderRows: [{ sheetId: 'S1', tabName: 'T1', sheetRow: 10, price: 1000, feeSnapshot: 700, orderDate: '2026-08-01' }],
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', reviewFee: 3000, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.reviewFee, 700, '★ 스냅샷 우선(082 완화 금지)');
      assert.strictEqual(it.feeSource, 'snapshot');
    });
  });

  await ta('3c5 ★ 탭 메타 SELECT 가 review_fee 를 실제로 읽는다(스텁은 SQL 을 해석하지 않는다)', async () => {
    await withStubPool(targetsHandler({}), async (svc, calls) => {
      await svc.listPaymentTargets();
      const q = calls.find(c => /FROM tab_configs tc/.test(c.sql));
      assert.ok(q && /tc\.review_fee\s+AS\s+"reviewFee"/.test(q.sql), '탭 리뷰비를 안 읽으면 저장해도 화면이 안 바뀐다');
    });
  });

  /* ── 0원 = 무상 확정 (사용자 확정 2026-08-19) ─────────────────────────────
     이 계정은 상품비만 주는 작업이 다수(실측 공고 32건 중 27건이 0원)라, 0 을 "미설정"으로
     읽으면 입금관리가 상시 경고로 뒤덮여 진짜 신호(계좌·은행 미비)가 묻힌다.
     ★ 종전 버그: 공고 로더가 COALESCE(...,0) + `|| 0` 로 0 과 NULL 을 같은 값으로 만들고,
       campFee 가 truthiness 로 0 을 걸러 **무상 작업 전건이 경고**를 달았다(위프 800건 24/24). */
  await ta('3c6 ★★ 공고 리뷰비 0원 = 사람이 정한 무상 — 경고를 띄우지 않는다', async () => {
    await withStubPool(targetsHandler({
      campRows: [{ id: 'C1', title: '무상 작업', sheetId: 'S1', tabName: 'T1', reviewFee: 0,
        transferBank: 'kbank', transferMemo: 'M', campStartDate: null, goodsCostType: '' }],
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '', depositName: '', reviewFee: null, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '22,000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.reviewFee, 0);
      assert.strictEqual(it.feeSource, 'campaign', '0 도 "공고에서 온 값"이다');
      assert.strictEqual(it.campaignReviewFee, 0, '★ 0 을 null 로 접으면 팝업 프리필도 비어 보인다');
      assert.ok(!(it.warnings || []).includes('no_review_fee'), '★ 0원 설정에는 경고가 없다');
      assert.strictEqual(it.amount, 22000, '이체금액은 상품비 그대로');
      assert.strictEqual(it.payable, true);
    });
  });

  await ta('3c7 ★ 탭 리뷰비 0원도 무상 확정 · 근거가 아예 없을 때만 경고', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', reviewFee: 0, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.feeSource, 'tab');
      assert.ok(!(it.warnings || []).includes('no_review_fee'));
    });
    // 공고도 탭도 없는 줄 = 근거 없음 → **경고하지 않는다**(0 = 리뷰비 없는 작업, 사용자 확정 2026-08-24)
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M', reviewFee: null, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.feeSource, null);
      assert.ok(!(it.warnings || []).includes('no_review_fee'),
        '★ 0 = 리뷰비 없는 작업(사용자 확정 2026-08-24) — 근거가 없어도 경고하지 않는다. 정하려면 작업 조건 카드에서.');
    });
  });

  await ta('3c7b ★ 공고는 있는데 리뷰비가 NULL = 미설정 — 0 으로 접지 않는다', async () => {
    await withStubPool(targetsHandler({
      campRows: [{ id: 'C1', title: '공고', sheetId: 'S1', tabName: 'T1', reviewFee: null,
        transferBank: 'kbank', transferMemo: 'M', campStartDate: null, goodsCostType: '' }],
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '', depositName: '', reviewFee: null, goodsCostType: '' }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.campaignReviewFee, null, '★ NULL 을 0 으로 바꾸면 미설정이 무상으로 둔갑한다');
      assert.strictEqual(it.feeSource, null, '근거 없음은 계속 null 로 말한다(작업 조건 카드가 [미설정]로 그린다)');
    });
  });

  await ta('3c8 ★ 공고 로더가 0 과 NULL 을 구분해 읽는다(COALESCE 로 접지 않는다)', async () => {
    await withStubPool(targetsHandler({}), async (svc, calls) => {
      await svc.listPaymentTargets();
      const q = calls.find(c => /FROM recruit_campaigns c/.test(c.sql));
      assert.ok(q, '공고 로더 쿼리를 찾지 못했다');
      assert.ok(!/COALESCE\(c\.review_fee/.test(q.sql), '★ COALESCE 로 0 과 NULL 을 같은 값으로 만들지 않는다');
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

  await ta('4a 공고가 있으면 공고에 저장 — 이체설정 2칸 + 리뷰비만 UPDATE', async () => {
    await withStubPool((sql) => {
      if (/FROM recruit_campaigns/.test(sql) && /linked_sheet_id/.test(sql)) return { rows: [{ id: 'C1' }] };
      return { rows: [], rowCount: 1 };
    }, async (svc, calls) => {
      const out = await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', campaignId: 'C1', bank: 'kbank', memo: '망고' });
      assert.strictEqual(out.target, 'campaign');
      const upd = calls.find(c => /UPDATE recruit_campaigns/.test(c.sql));
      assert.ok(upd, '공고 UPDATE 가 없다');
      const setCols = (upd.sql.match(/SET([\s\S]*?)WHERE/)[1].match(/(\w+)\s*=\s*CASE/g) || []);
      // 128 로 `review_fee` 가 합류했다(사용자 확정 — 보류 보완에서 리뷰비도 정한다).
      // ★ 그 외 칸이 늘면 축약 폼이 공고 설정을 조용히 덮는다 = 이 단언이 막는 것.
      assert.deepStrictEqual(setCols.map(s => s.split(/\s/)[0]).sort(), ['review_fee', 'transfer_bank', 'transfer_memo'],
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

  /* ── 리뷰비(128) — 통장표시와 같은 팝업에서 정하고, 저장처도 같은 규칙(공고 → 탭) ── */
  await ta('4f2 리뷰비 — 공고가 있으면 공고 review_fee, 없으면 탭 review_fee', async () => {
    await withStubPool((sql) => {
      if (/FROM recruit_campaigns/.test(sql) && /linked_sheet_id/.test(sql)) return { rows: [{ id: 'C1' }] };
      return { rows: [], rowCount: 1 };
    }, async (svc, calls) => {
      const out = await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', campaignId: 'C1', reviewFee: '3,000' });
      assert.strictEqual(out.target, 'campaign');
      assert.strictEqual(out.reviewFee, 3000, '쉼표는 걷어내고 숫자로 저장한다');
      const upd = calls.find(c => /UPDATE recruit_campaigns/.test(c.sql));
      assert.ok(/review_fee\s*=\s*CASE/.test(upd.sql), '공고 저장처는 recruit_campaigns.review_fee');
      assert.strictEqual(upd.params[1], false, '★ 미전송 은행은 그대로(부분 저장)');
      assert.strictEqual(upd.params[3], false, '★ 미전송 통장표시도 그대로');
      assert.strictEqual(upd.params[5], true);
      assert.strictEqual(upd.params[6], 3000);
    });
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      const out = await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', reviewFee: 2500 });
      assert.strictEqual(out.target, 'tab');
      const upd = calls.find(c => /UPDATE tab_configs/.test(c.sql));
      assert.ok(/review_fee\s*=\s*CASE WHEN \$7::bool THEN \$8::int/.test(upd.sql),
        '★ 탭 리뷰비는 int 그대로 — 텍스트로 넣으면 다음 조회가 숫자로 못 읽는다');
      assert.strictEqual(upd.params[6], true);
      assert.strictEqual(upd.params[7], 2500);
    });
  });

  await ta('4f3 ★ 빈 리뷰비 = 미설정으로 되돌림(0 지정과 구분) · 미전송은 변경 없음', async () => {
    await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
      await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', reviewFee: '' });
      let upd = calls.find(c => /UPDATE tab_configs/.test(c.sql));
      assert.strictEqual(upd.params[6], true, '빈 값도 "고치는 것"이다');
      assert.strictEqual(upd.params[7], null, '★ 탭은 NULL = 미설정(0 으로 접으면 공고 폴백과 구분이 사라진다)');
      calls.length = 0;
      await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', reviewFee: 0 });
      upd = calls.find(c => /UPDATE tab_configs/.test(c.sql));
      assert.strictEqual(upd.params[7], 0, '0 은 "무상 지정" 이라 그대로 저장한다');
      calls.length = 0;
      await svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', bank: 'hana' });
      upd = calls.find(c => /UPDATE tab_configs/.test(c.sql));
      assert.strictEqual(upd.params[6], false, '★ 리뷰비 칸이 없는 화면이 저장해도 리뷰비가 지워지면 안 된다');
    });
  });

  await ta('4f4 리뷰비 형식은 서버가 최종 판정 — 숫자 아님·음수는 쓰기 0건', async () => {
    for (const bad of ['삼천원', -1, '1e9999']) {
      await withStubPool(() => ({ rows: [], rowCount: 1 }), async (svc, calls) => {
        await assert.rejects(() => svc.saveTransferSetting({ sheetId: 'S1', tabName: 'T1', reviewFee: bad }),
          e => e.code === 'bad_fee', '거부해야 한다: ' + bad);
        assert.ok(!calls.some(c => /UPDATE/.test(c.sql)), '거부 시 쓰기 0건: ' + bad);
      });
    }
  });

  await ta('4g 리뷰어 계좌 — reviewers.id 로 지목하고 빈 칸은 안 덮는다', async () => {
    await withStubPool((sql) => (/SELECT bank_name, bank_account FROM reviewers/.test(sql)
      ? { rows: [{ bank_name: '국민은행', bank_account: '0000' }], rowCount: 1 }
      : { rows: [], rowCount: 1 }), async (svc, calls) => {
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

  t('6b 상단 묶음 목록 + 계좌 팝업 + 행별 [보완] 이 모두 배선돼 있다', () => {
    for (const s of ['_pmBuildFix', '_pmFixBlock', '_pmFixAcct', '_pmRowFix', '_pmRowMemo', '_pmDialog', '_pmOpenBoard']) {
      assert.ok(HTML.includes('function ' + s), s + ' 없음');
    }
    assert.ok(/\$\{_pmFixBlock\(\)\}/.test(HTML), '묶음 목록이 화면에 렌더되지 않는다');
    assert.ok(/onclick="_pmRowFix\(\$\{idx\}\)"/.test(HTML), '행별 [보완] 버튼 배선 없음');
  });

  t('6b2 ★★ 작업 단위 값(이체은행·통장표시)을 고치는 창구는 **작업 조건 카드 하나**다', () => {
    // 입금관리에는 그 전용 팝업이 없다(창구 둘이면 문구·권한이 갈린다 — 사용자 확정 2026-08-24)
    assert.ok(!/function _pmFixWork\(/.test(HTML), '★ 입금관리 전용 보완 팝업이 되살아났다');
    assert.ok(!/id="pmBankPick"/.test(HTML) && !/id="pmMemoIn"/.test(HTML),
      '★ 입금관리에 이체은행·통장표시 입력칸이 되살아났다');
    // 대신 그 작업의 작업보드로 보낸다
    const blk = HTML.slice(HTML.indexOf('function _pmFixBlock'), HTML.indexOf('function _pmRowFix'));
    assert.ok(/_pmBoardBtn\(i\)/.test(blk), '묶은 줄이 작업보드로 보내지 않는다');
    const rowFix = HTML.slice(HTML.indexOf('function _pmRowFix'), HTML.indexOf('function _pmRowMemo'));
    assert.ok(/_pmOpenBoard\(i\)/.test(rowFix), '표의 [보완](이체은행)이 작업보드로 가지 않는다');
    const rowMemo = HTML.slice(HTML.indexOf('function _pmRowMemo'), HTML.indexOf('function _pmRowMemo') + 500);
    assert.ok(/_pmOpenBoard\(i\)/.test(rowMemo), '표의 통장표시 [미설정]이 작업보드로 가지 않는다');
    // 작업 조건 카드에 세 값의 창구가 모두 있다
    assert.ok(/\['이체은행','bank'/.test(HTML), '작업 조건에 이체은행 줄이 없다');
    assert.ok(/\['리뷰비','fee'/.test(HTML) && /\['입금명','memo'/.test(HTML), '작업 조건에 리뷰비·입금명 줄이 없다');
    assert.ok(/function _cndBankModal\(/.test(HTML), '공고 없는 작업의 이체은행 저장 창구가 없다');
  });

  t('6c ★★ onclick 에 시트발 문자열을 보간하지 않는다(인덱스만)', () => {
    // 표 행의 모든 onclick 인자가 숫자 인덱스여야 한다
    const tbl = HTML.slice(HTML.indexOf('function _pmTargetTable'), HTML.indexOf('function _pmBatchTable'));
    const handlers = tbl.match(/onclick="[^"]*"|onchange="[^"]*"/g) || [];
    assert.ok(handlers.length >= 3, '표에 핸들러가 없다');
    for (const h of handlers) {
      assert.ok(/\(\$\{(?:idx|i)\}(,[^)]*)?\)/.test(h), '인덱스가 아닌 값을 넘긴다: ' + h);
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
    const blk = HTML.slice(HTML.indexOf('function _pmFixBlock'), HTML.indexOf('/* ── 작업 단위 보완 팝업'));
    assert.ok(/리뷰어 미등록/.test(blk) && /등록리뷰어DB/.test(blk), '리뷰어 미등록 안내 없음');
    assert.ok(/결제금액 없음/.test(blk) && /시트 결제금액 칸/.test(blk), '결제금액 없음 안내 없음');
    // 그 줄에는 보완 버튼이 없어야 한다(눌러도 아무 일 없는 버튼 금지)
    const infoRows = blk.match(/pmfixrow info[\s\S]*?<\/div>`\)/g) || [];
    assert.ok(infoRows.length >= 2, '안내 줄 2종이 있어야 한다');
    for (const c of infoRows) assert.ok(!/_pmFix(Work|Acct)\(/.test(c), '고칠 수 없는 사유에 버튼이 붙었다');
  });

  t('6h ★ 저장 성공 뒤 순서 = 닫기 → 안내 → 재조회(후처리 실패가 성공을 실패처럼 보이게 하면 안 된다)', () => {
    const fn = HTML.slice(HTML.indexOf('function _pmAfterFix'), HTML.indexOf('/* ── 공용 팝업 골격'));
    const close = fn.indexOf('_pmCloseDialog()'), t2 = fn.indexOf('toast('), load = fn.indexOf('_pmLoad()');
    assert.ok(close >= 0 && t2 > close && load > close, '닫기가 먼저여야 한다: ' + fn);
    assert.ok(/try\{\s*toast\(/.test(fn), '안내 실패가 재조회를 막으면 안 된다');
    // 남은 팝업(리뷰어 계좌)이 이 마무리를 쓴다 — 작업 단위 팝업은 작업 조건 카드로 옮겨 없앴다
    const acct = HTML.slice(HTML.indexOf('function _pmFixAcct'), HTML.indexOf('/** 저장 성공 뒤 공통 마무리'));
    for (const [n, s] of [['리뷰어', acct]]) {
      assert.ok(/_pmAfterFix\(/.test(s), n + ' 팝업이 공통 마무리를 쓰지 않는다');
      assert.ok(!/await _pmLoad\(\);\s*return true/.test(s), n + ' 팝업이 옛 순서(재조회 후 닫기)로 되돌아갔다');
    }
  });

  t('6i-2 계좌 칸은 "숫자만 입력" 대신 자동 정규화를 안내한다(서버가 이미 - 를 뺀다)', () => {
    const acct = HTML.slice(HTML.indexOf('function _pmFixAcct'), HTML.indexOf('/** 저장 성공 뒤 공통 마무리'));
    const line = (acct.match(/id="pmAcctIn"[^\n]*/) || [''])[0];
    assert.ok(line, 'pmAcctIn 입력칸을 못 찾았다');
    assert.ok(!/숫자만 입력/.test(line), '★ 지시대로 제거한 placeholder 가 되살아났다');
    assert.ok(/자동으로 빠지고/.test(acct) && /앞자리/.test(acct),
      '- 자동 제거 · 앞 0 유지 안내가 없다(사용자가 손으로 지우게 된다)');
  });

  t('6i onOk 예외를 삼키지 않고 사유를 말한다(조용히 버튼만 되살아나면 원인을 모른다)', () => {
    const dlg = HTML.slice(HTML.indexOf('function _pmDialog'), HTML.indexOf('function _pmCloseDialog'));
    assert.ok(/catch\(e\)\{[\s\S]*?toast\(/.test(dlg), 'onOk 예외 안내가 없다');
  });

  t('6j ★ 리뷰비·입금명·이체은행 저장은 **작업 조건 카드**가 같은 API 로 한다(신규 경로 0)', () => {
    const tabVal = HTML.slice(HTML.indexOf('function _cndTabValueModal'), HTML.indexOf('function _cndRtypeModal'));
    assert.ok(/body\.reviewFee=v/.test(tabVal) && /body\.memo=v/.test(tabVal), '리뷰비·입금명 저장이 없다');
    assert.ok(/payment\/transfer-setting/.test(tabVal), '기존 저장 API 를 쓰지 않는다');
    const bank = HTML.slice(HTML.indexOf('function _cndBankModal'), HTML.indexOf('function _cndBkPick'));
    assert.ok(/payment\/transfer-setting/.test(bank) && /bank:sel\.dataset\.v/.test(bank),
      '이체은행 저장이 같은 API 를 쓰지 않는다');
    // 서버 계약(undefined = 변경 없음)이 라우트까지 이어지는지
    const routes = read('routes/trackB.routes.js');
    const seg = routes.slice(routes.indexOf("'/payment/transfer-setting'"), routes.indexOf("'/payment/reviewer-account'"));
    assert.ok(/reviewFee:\s*b\.reviewFee/.test(seg), '라우트가 리뷰비를 서비스로 넘기지 않는다');
    assert.ok(!/b\.reviewFee\s*\|\|/.test(seg), "★ `|| 0` 로 접으면 미전송이 '0원 지정'이 된다");
  });

  t('6k ★ 묶은 줄은 말줄임 대신 접어서 다 보여준다(항목이 셋이면 좁은 카드에서 잘린다)', () => {
    assert.ok(/\.pmfixrow\.work \.nm\{[^}]*white-space:normal/.test(HTML),
      '묶음 줄이 nowrap 이면 "이체은행 · 통장…" 으로 잘려 무엇을 입력할지 알 수 없다');
  });

  t('6g 표 [보완] 버튼은 고칠 수 있을 때만 그린다(죽은 버튼 금지)', () => {
    const tbl = HTML.slice(HTML.indexOf('function _pmTargetTable'), HTML.indexOf('function _pmBatchTable'));
    assert.ok(/const isFixable[\s\S]*?PAY_FIX_KIND/.test(tbl), '고칠 수 있는지 판정이 없다');
    assert.ok(/accountRef && it\.accountRef\.reviewerId/.test(tbl), '리뷰어 지목이 불가능한 행까지 버튼을 그린다');
    // ★ 판정은 한 곳(isFixable)이고 **줄과 그룹 머리줄 둘 다** 그것으로 조건부 렌더한다
    //   (머리줄에만 걸면 못 고치는 작업에 죽은 버튼이 생긴다)
    assert.strictEqual((tbl.match(/isFixable\((?:it|g\.items\[0\])\) *\? *`<button/g) || []).length, 2,
      '조건부 렌더가 아니거나 판정 사본이 생겼다');
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
    // ★ 상한 상수도 **소스에서 그대로** 가져온다(테스트에 사본을 두면 값이 조용히 갈린다)
    const capLine = (HTML.match(/const _PM_FIX_CARD_CAP\s*=\s*\d+;/) || [])[0];
    assert.ok(capLine, '_PM_FIX_CARD_CAP 선언을 찾지 못했다');
    // vm 최상위 `const` 는 전역 객체에 안 붙는다 → 값을 밖에서도 읽도록 `var` 로만 바꿔 주입(값은 소스 그대로)
    const src = [capLine.replace(/^const/, 'var'), pick('_pmBoardBtn'),
      pick('_pmBuildFix'), pick('_pmAcctName'), pick('_pmAcctTail'), pick('_pmAcctLabel'),
      pick('_pmAcctPlain'), pick('_pmFixBlock'), pick('_pmFixAcct')].join('\n');
    const sandbox = {
      esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      _pmKey: it => it.sheetId + '||' + it.tabName + '||' + it.rowIndex,
      PAY_ACCT_ISSUES: ['bank_unknown', 'no_account', 'no_holder'],
      PAY_ISSUE_LABEL: { no_account: '계좌 미등록', bank_unknown: '은행명 인식불가', no_holder: '예금주 미등록' },
      STATE: {},
      _dlg: null,
      _pmDialog(o) { sandbox._dlg = o; },       // 팝업은 열지 않고 인자만 잡아 둔다
      _went: null,
      _pmCloseDialog() {},
      switchView(v) { sandbox._went = v; },     // 작업보드 이동은 뷰 전환만 잡아 둔다
    };
    vm.createContext(sandbox);
    new vm.Script(src).runInContext(sandbox);
    return sandbox;
  }

  const mkItem = (o = {}) => Object.assign({
    sheetId: 'S1', tabName: 'T1', rowIndex: 1, tabLabel: '(완)5/8_쟈니베어', reviewerName: '차세희',
    campaignId: null, campaignTitle: '', bank: '', bankSource: null, transferMemo: '', memoSource: null,
    isSub: false, bankName: '', bankAccount: '', accountHolder: '', accountRef: null,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=7', sheetless: false,
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

  t('7c2 ★★ 리뷰비는 보완 목록에 넣지 않는다 — 0 = 리뷰비 없는 작업(사용자 확정 2026-08-24)', () => {
    const S = loadFixFns();
    // 서버가 더 이상 no_review_fee 를 만들지 않지만, 옛 응답이 와도 화면이 그 줄을 만들지 않는다
    S.STATE.pmFix = S._pmBuildFix([mkItem({ transferMemo: '망고', bank: 'hana', warnings: ['no_review_fee'] })]);
    assert.strictEqual(S.STATE.pmFix.works.length, 0,
      '★ 리뷰비만 비었는데 보완 카드가 뜬다 — 상품비만 주는 작업이 상시 경고가 된다');
    assert.strictEqual(S._pmFixBlock(), '');
  });

  t('7c3 ★ 리뷰비 창구는 **작업 조건 카드**다 — 값의 출처(스냅샷·구간)를 그곳이 말한다', () => {
    // 입금관리에는 리뷰비 입력칸이 없다(창구 하나 — 사용자 확정 2026-08-24)
    assert.ok(!/id="pmFeeIn"/.test(HTML), '★ 입금관리에 리뷰비 입력칸이 되살아났다');
    // 작업 조건 카드가 리뷰비 줄과 저장 창구를 갖는다
    assert.ok(/\['리뷰비','fee'/.test(HTML), '작업 조건에 리뷰비 줄이 없다');
    const tabVal = HTML.slice(HTML.indexOf('function _cndTabValueModal'), HTML.indexOf('function _cndRtypeModal'));
    assert.ok(/리뷰비\(원\)/.test(tabVal), '공고 없는 작업의 리뷰비 입력칸이 없다');
    assert.ok(/0 = 무상/.test(tabVal), '0 의 뜻(무상)을 말하지 않는다');
    // 구간(082)에서 온 값이면 카드가 그 사실을 칩으로 말한다
    assert.ok(/feeSource==='schedule'/.test(HTML), '기간별 구간 표기가 없다');
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

  t('7g 결제금액 없음은 그 작업 카드 안에 **안내로만** 실린다(고칠 버튼 없음)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([mkItem({ issues: ['no_price', 'zero_amount'] })]);
    const f = S.STATE.pmFix;
    assert.strictEqual(f.noPrice, 1);
    // ★ 작업 단위로 묶이므로 카드는 생기되(어느 작업인지 알아야 시트를 연다) 보완 버튼은 없다
    assert.strictEqual(f.works.length, 1, '작업 카드로 묶여야 한다');
    assert.strictEqual(f.works[0].noPrice, 1);
    assert.strictEqual(f.works[0].needBank, false);
    const html = S._pmFixBlock();
    assert.ok(/결제금액 없음 1건/.test(html), '건수 안내가 없다');
    assert.ok(!/_pmFixWork\(/.test(html) && !/_pmFixAcct\(/.test(html),
      '★ 고칠 수 없는 사유뿐인데 보완 버튼이 생겼다(죽은 버튼)');
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
    assert.ok(/_pmOpenBoard\(0\)/.test(html), '작업 버튼(작업보드)이 인덱스를 넘겨야 한다');
    assert.ok(/_pmFixAcct\(0\)/.test(html), '리뷰어 버튼이 인덱스를 넘겨야 한다');
    assert.ok(/이체은행/.test(html) && /계좌 —/.test(html));
  });

  t('7j 묶음 인덱스 = STATE.pmFix 배열 인덱스(팝업이 엉뚱한 작업을 열지 않게)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabName: 'T1', tabLabel: 'A', issues: [], warnings: ['no_memo'] }),        // memo 전용
      mkItem({ tabName: 'T2', tabLabel: 'B', rowIndex: 2, issues: ['no_bank'] }),
      mkItem({ tabName: 'T2', tabLabel: 'B', rowIndex: 3, issues: ['no_bank'] }),
    ]);
    const html = S._pmFixBlock();
    // 은행 줄의 버튼 인덱스는 works 배열에서 T2 의 위치여야 한다(카드 표시 순서가 아니라)
    const idx = parseInt(html.slice(html.indexOf('이체은행')).match(/_pmOpenBoard\((\d+)\)/)[1], 10);
    assert.strictEqual(S.STATE.pmFix.works[idx].tabName, 'T2',
      '★ 표시 순서를 인덱스로 넘기면 다른 작업의 보드가 열린다');
  });

  t('7k ★ 사유가 여럿이어도 그 작업은 카드 하나(사유별로 흩어 놓지 않는다)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabName: 'T1', tabLabel: 'A', issues: ['no_bank'], warnings: ['no_memo'] }),
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 2, issues: ['no_account'],
        accountRef: { reviewerId: 'r-1', subPhone8: null }, warnings: [] }),
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 3, issues: ['no_price'], warnings: [] }),
    ]);
    const f = S.STATE.pmFix;
    assert.strictEqual(f.works.length, 1, '한 작업이 여러 카드로 쪼개졌다');
    const w = f.works[0];
    assert.strictEqual(w.rows, 3);
    assert.ok(w.needBank && w.needMemo && w.accts.length === 1 && w.noPrice === 1,
      '한 카드가 그 작업의 할 일을 전부 담아야 한다');
    const html = S._pmFixBlock();
    assert.strictEqual((html.match(/pmfixcard/g) || []).length, 1, '카드가 하나여야 한다');
  });

  t('7k2 ★★ 작업 단위(이체은행·통장표시)는 **한 줄**로 묶이고 작업보드로 보낸다', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 1, issues: ['no_bank'], warnings: ['no_memo'] }),
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 2, issues: [], warnings: ['no_memo'] }),
      // ★ 카드 전체 행 수(w.rows=3)와 **다른 숫자**여야 검사가 공허해지지 않는다
      //   (결제금액 없음은 작업 설정으로 못 고치는 사유 = setupRows 에 안 들어간다)
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 3, issues: ['no_price'], warnings: [] }),
    ]);
    const w = S.STATE.pmFix.works[0];
    assert.strictEqual(w.rows, 3, '카드에 걸린 행 수');
    assert.strictEqual(w.setupRows, 2, '작업 설정 보완이 필요한 행 수는 **합집합**이어야 한다(두 사유)');
    const html = S._pmFixBlock();
    assert.strictEqual((html.match(/pmfixrow work/g) || []).length, 1,
      '★ 사유별로 줄이 갈리면 같은 [보완] 버튼이 세 번 반복된다');
    // 카드 머리 + 묶은 줄 = 같은 작업보드로 가는 두 자리(사유별로 반복되지 않는다)
    assert.strictEqual((html.match(/_pmOpenBoard\(/g) || []).length, 2,
      '★ 사유마다 버튼이 반복되면 "두 번 해야 하나"로 읽힌다');
    // 두 항목이 그 한 줄에 다 적힌다(열어보지 않고 무엇을 설정할지 알 수 있게)
    for (const k of ['이체은행', '통장표시'])
      assert.ok(html.includes(k), k + ' 가 줄에서 사라졌다');
    assert.ok(/작업 조건/.test(html), '★ 어디서 고치는지(작업 조건)를 말해야 한다');
    assert.ok(!/리뷰비/.test(html), '★ 리뷰비는 보완 대상이 아니다(0 = 없는 작업)');
    // ★ 사유별 건수를 조용히 버리지 않는다(title 로 남는다)
    assert.ok(/이체은행 미지정 1건/.test(html) && /통장표시 없음 2건/.test(html),
      '사유별 건수가 어디에도 남지 않았다: ' + html);
    // ★ 줄에 적히는 건수는 그 줄을 눌러 풀리는 건수(합집합)여야 한다 — 카드 전체 건수가 아니다
    // ★ 카드 머리의 건수(3건 = 카드에 걸린 전체)와 헷갈리지 않게 **묶은 줄만** 잘라서 본다
    const workRow = html.slice(html.indexOf('pmfixrow work'));
    const n = (workRow.match(/<span class="n">(\d+)건<\/span>/) || [])[1];
    assert.strictEqual(n, '2', '묶은 줄이 작업 설정으로 못 고치는 건까지 세고 있다: ' + workRow.slice(0, 300));
  });

  t('7k3 ★ 한 종류만 필요하면 그것만 적는다(멀쩡한 항목을 입력할 것처럼 말하지 않는다)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([mkItem({ transferMemo: '', bank: 'hana', warnings: ['no_memo'] })]);
    const html = S._pmFixBlock();
    assert.ok(/통장표시/.test(html));
    assert.ok(!/이체은행/.test(html),
      '★ 멀쩡한 항목이 보완 줄에 들어가면 담당자가 값을 덮어쓰게 된다');
    assert.strictEqual((html.match(/pmfixrow work/g) || []).length, 1);
  });

  t('7m ★ 계좌 버튼 인덱스는 accts 배열 위치(카드 안 순번이면 남의 계좌 창이 열린다)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 1, issues: ['no_account'], reviewerName: '가',
        accountRef: { reviewerId: 'r-1', subPhone8: null }, warnings: [] }),
      mkItem({ tabName: 'T1', tabLabel: 'A', rowIndex: 2, issues: ['no_account'], reviewerName: '가',
        accountRef: { reviewerId: 'r-1', subPhone8: null }, warnings: [] }),
      mkItem({ tabName: 'T2', tabLabel: 'B', rowIndex: 3, issues: ['no_account'], reviewerName: '나',
        accountRef: { reviewerId: 'r-2', subPhone8: null }, warnings: [] }),
    ]);
    const f = S.STATE.pmFix;
    assert.strictEqual(f.accts.length, 2);
    // 각 카드가 넘기는 인덱스가 그 카드에 적힌 리뷰어를 가리켜야 한다
    for (const card of S._pmFixBlock().split('pmfixcard').slice(1)) {
      const m = card.match(/_pmFixAcct\((\d+)\)/); assert.ok(m, '계좌 버튼이 없다');
      // 보이는 라벨(💳 뒤)에서 읽는다 — title 속성에도 같은 문구가 있어 앞에서 자르면 태그를 문다
      const nm = card.match(/💳 계좌 — ([^<]+)/)[1].trim();
      assert.strictEqual(f.accts[+m[1]].name, nm, '★ 버튼이 다른 리뷰어의 계좌 창을 연다');
    }
  });

  t('7l 카드 수 상한을 넘으면 남은 작업 수를 고지한다(조용히 자르지 않는다)', () => {
    const S = loadFixFns();
    const many = [];
    for (let i = 0; i < S._PM_FIX_CARD_CAP + 3; i++) many.push(mkItem({ tabName: 'T' + i, tabLabel: 'W' + i, issues: ['no_bank'] }));
    S.STATE.pmFix = S._pmBuildFix(many);
    const html = S._pmFixBlock();
    assert.strictEqual((html.match(/pmfixcard/g) || []).length, S._PM_FIX_CARD_CAP, '상한만큼만 카드로 편다');
    assert.ok(/외 3개 작업/.test(html), '남은 작업 수 고지가 없다');
  });

  /* ══════════════════════════════════════════════════════════
     §7B 입금 대상 표 — 같은 작업을 줄마다 되풀이하지 않는다(사용자 확정 2026-08-24)
       실사고 아님: 50건짜리 작업에서 작업명·이체은행·통장표시가 50번 반복돼
       정작 줄마다 다른 값(리뷰어·금액·계좌)이 묻혔다.
     ══════════════════════════════════════════════════════════ */
  console.log('\n§7B 입금 대상 표 그룹 묶음(_pmTargetTable)');

  /** 표 렌더러를 vm 으로 꺼내 실제 실행한다(정적 검사로는 "되풀이하지 않는다"가 고정되지 않는다) */
  function loadTableFns(items) {
    const vm = require('vm');
    const pick = name => {
      const i = HTML.indexOf('function ' + name + '(');
      assert.ok(i > 0, name + ' 를 찾지 못했다');
      const j = HTML.indexOf('\nfunction ', i + 1);
      return HTML.slice(i, j > 0 ? j : i + 9000);
    };
    const sandbox = {
      esc: v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      _pmNum: n => String(Number(n) || 0),
      _pmOn: it => it.payable && !it.excluded,
      _pmAcctSrcTip: () => '',
      PAY_FIX_KIND: { no_bank: 'work', no_account: 'account', bank_unknown: 'account', no_holder: 'account' },
      PAY_ISSUE_LABEL: { no_bank: '이체은행 미지정', no_account: '계좌 미등록', bank_unknown: '은행명 인식불가' },
      STATE: { pmItems: items },
      document: { querySelector: () => null },
    };
    vm.createContext(sandbox);
    new vm.Script([pick('_pmWorkKey'), pick('_pmTargetTable'), pick('_pmFoldWork')].join('\n')).runInContext(sandbox);
    return sandbox;
  }
  /** 이체 가능한 한 줄(대상) */
  const payRow = (o = {}) => mkItem(Object.assign({
    payable: true, bank: 'hana', bankLabel: '하나은행', bankAuto: false, transferMemo: '망고',
    amount: 20000, productPrice: 17000, reviewFee: 3000, accountHolder: '홍길동',
    bankName: '국민', bankOfficial: '국민은행', bankAccount: '1234', startDate: '8 / 5',
  }, o));
  // ★ 표 머리(thead)까지 세면 검사가 엉뚱한 이유로 빨개진다 — tbody 안만 본다
  const tbodyOf = html => html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const dataRows = html => tbodyOf(html).split('<tr').slice(1).filter(r => !/class="pmgrp"/.test(r));

  t('7B-a ★★ 같은 작업 50줄이어도 작업명은 **머리줄 한 번**만 적힌다', () => {
    const items = [];
    for (let i = 1; i <= 50; i++) items.push(payRow({ rowIndex: i, reviewerName: 'R' + i, tabLabel: '0804)비타민,글루타치온_블로그 50건' }));
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    assert.strictEqual((html.match(/class="pmgrp"/g) || []).length, 1, '그룹 머리줄이 하나여야 한다');
    assert.strictEqual((html.match(/0804\)비타민/g) || []).length, 2,
      '★ 작업명이 줄마다 되풀이된다(머리줄 본문 + title 로 2회가 정상): ' + (html.match(/0804\)비타민/g) || []).length);
    assert.strictEqual(dataRows(html).length, 50, '줄이 사라지면 안 된다(감추는 게 아니라 안 적을 뿐)');
  });

  t('7B-b ★★ 그 작업에서 값이 **같은 칸**(이체은행·통장표시)은 머리줄로만 올린다', () => {
    const items = [payRow({ rowIndex: 1 }), payRow({ rowIndex: 2 }), payRow({ rowIndex: 3 })];
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    assert.strictEqual((html.match(/하나은행/g) || []).length, 1, '이체은행이 줄마다 반복된다');
    assert.strictEqual((html.match(/망고/g) || []).length, 1, '통장표시가 줄마다 반복된다');
  });

  t('7B-c ★★ 값이 하나라도 다르면 그 칸은 **줄마다** 그린다(조용히 숨기지 않는다)', () => {
    const items = [payRow({ rowIndex: 1, transferMemo: '망고' }),
      payRow({ rowIndex: 2, transferMemo: '만두' }), payRow({ rowIndex: 3, transferMemo: '망고' })];
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    assert.ok(/만두/.test(html) && (html.match(/망고/g) || []).length === 2,
      '★ 서로 다른 통장표시가 한 값으로 뭉개졌다: ' + html);
    // 이체은행은 셋 다 같으니 여전히 머리줄로만
    assert.strictEqual((html.match(/하나은행/g) || []).length, 1);
  });

  t('7B-d 작업이 바뀌면 머리줄이 새로 생기고, 순서는 그대로다', () => {
    const items = [payRow({ rowIndex: 1, tabLabel: 'A작업' }),
      payRow({ sheetId: 'S2', rowIndex: 2, tabLabel: 'B작업' }), payRow({ sheetId: 'S2', rowIndex: 3, tabLabel: 'B작업' })];
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    assert.strictEqual((html.match(/class="pmgrp"/g) || []).length, 2);
    assert.ok(html.indexOf('A작업') < html.indexOf('B작업'), '서버가 준 순서를 바꾸면 안 된다');
    assert.strictEqual(dataRows(html).length, 3);
  });

  t('7B-e ★ 머리줄이 선택 건수·합계를 말한다(접어도 무엇이 담겼는지 알 수 있게)', () => {
    const items = [payRow({ rowIndex: 1 }), payRow({ rowIndex: 2, excluded: true }), payRow({ rowIndex: 3 })];
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    assert.ok(/선택 2\/3건/.test(html), '선택 현황이 없다: ' + html);
    assert.ok(/40000원/.test(html), '선택 합계가 없다');
  });

  t('7B-f ★★ 접기는 **표시 전용** — 체크 상태·이체 대상은 건드리지 않는다', () => {
    const items = [payRow({ rowIndex: 1 }), payRow({ rowIndex: 2 })];
    const S = loadTableFns(items);
    S._pmTargetTable(items);                       // STATE.pmGroups 채움
    const before = items.map(it => S._pmOn(it)).join(',');
    S._pmFoldWork(0);                              // document 스텁이라 DOM 조작은 no-op
    assert.strictEqual(items.map(it => S._pmOn(it)).join(','), before, '★ 접었더니 이체 대상이 달라졌다');
    assert.strictEqual(S.STATE.pmFold[S.STATE.pmGroups[0]], true, '접힘 상태가 기록되지 않았다');
    // 다시 그리면 그 그룹 줄만 감춰지고, 줄 자체는 남는다
    const html = S._pmTargetTable(items);
    assert.strictEqual(dataRows(html).length, 2, '접었다고 줄을 지우면 안 된다');
    assert.strictEqual((html.match(/pmhide/g) || []).length, 2, '접힘이 화면에 반영되지 않았다');
    S._pmFoldWork(0);
    assert.ok(!S.STATE.pmFold[S.STATE.pmGroups[0]], '다시 눌러도 안 펴진다');
  });

  t('7B-g ★★ 머리줄·데이터 줄의 onclick 은 인덱스만(작업명은 시트발 문자열)', () => {
    const items = [payRow({ rowIndex: 1, tabLabel: `x"><img src=x onerror=alert(1)>`, transferMemo: '', warnings: ['no_memo'] })];
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    assert.ok(!/<img src=x/.test(html), '작업명이 이스케이프되지 않았다');
    for (const h of html.match(/onclick="[^"]*"/g) || [])
      assert.ok(/\((\d+)(,[^)]*)?\)/.test(h), '인덱스가 아닌 값을 넘긴다: ' + h);
  });

  t('7B-h ★ 머리줄 칸 수(colspan) = 표 머리 칸 수 — 어긋나면 표가 통째로 밀린다', () => {
    const items = [payRow({ rowIndex: 1 })];
    const S = loadTableFns(items);
    const html = S._pmTargetTable(items);
    const heads = (html.match(/<th\b[^>]*>/g) || []).length;
    const span = Number((html.match(/colspan="(\d+)"/) || [])[1]);
    assert.strictEqual(span, heads, `머리줄 colspan=${span} ≠ 표 머리 ${heads}칸`);
    // 데이터 줄의 칸 수도 같아야 한다(작업 칸을 지우지 않고 **비운다**)
    const tds = (dataRows(html)[0].match(/<td/g) || []).length;
    assert.strictEqual(tds, heads, `데이터 줄 ${tds}칸 ≠ 표 머리 ${heads}칸`);
  });

  /* ══════════════════════════════════════════════════════════
     §7C 계좌 **명의** 구분 — 한 소유자가 본인 명의 + 타계정 명의로 참여하면
       이름만으로는 어느 계좌를 고치라는 건지 알 수 없다(실사고 2026-08-10 정라희/정석진)
     ══════════════════════════════════════════════════════════ */
  console.log('\n§7C 계좌 명의 구분(본인 ↔ 타계정)');

  const RID = '33333333-3333-3333-3333-333333333333';
  /** 실사고 재현: 같은 소유자(정라희)가 본인 명의 1건 + 타계정(정석진) 명의 1건 */
  const twoIdentities = () => [
    mkItem({ rowIndex: 32, reviewerName: '정라희', phone8: '73052121', isSub: false,
      accountName: '정라희', accountOwner: '정라희', bankName: '신한', bankAccount: '',
      issues: ['no_account'], accountRef: { reviewerId: RID, subPhone8: null } }),
    mkItem({ rowIndex: 275, reviewerName: '정라희', phone8: '53690101', isSub: true,
      accountName: '정석진', accountOwner: '정라희', bankName: '토스뱅크', bankAccount: '',
      issues: ['no_account'], accountRef: { reviewerId: RID, subPhone8: '53690101' } }),
  ];

  t('7C-a ★★ 본인 명의와 타계정 명의가 **별개 항목**으로 갈린다', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix(twoIdentities());
    assert.strictEqual(f.accts.length, 2, '두 명의가 한 항목으로 뭉치면 어느 계좌인지 알 수 없다');
    // vm 배열은 프로토타입이 달라 deepStrictEqual 이 참조 비교에서 걸린다 — 값으로 본다
    const names = [...f.accts].map(a => a.name).sort().join(',');
    assert.strictEqual(names, '정라희,정석진', '명의 이름이 계좌 원장 값이어야 한다: ' + names);
  });

  t('7C-b ★ 명의 이름은 시트 이름 칸이 아니라 계좌 원장(accountName)을 쓴다', () => {
    const S = loadFixFns();
    const f = S._pmBuildFix(twoIdentities());
    const sub = f.accts.find(a => a.isSub);
    assert.strictEqual(sub.name, '정석진',
      '시트 이름 칸(reviewerName=정라희)을 쓰면 타계정 카드가 소유자 이름으로 뜬다');
    assert.strictEqual(sub.owner, '정라희', '소유자 이름이 있어야 "누구의 타계정"을 말할 수 있다');
  });

  t('7C-c ★ 카드 줄이 두 명의를 눈으로 구분시킨다(이름 + 연락처 뒤4 + 타계정 표기)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix(twoIdentities());
    const html = S._pmFixBlock();
    assert.ok(/정라희[\s\S]*?·2121/.test(html), '본인 명의 줄에 연락처 뒤4자리가 없다');
    assert.ok(/정석진[\s\S]*?·0101/.test(html), '타계정 명의 줄에 연락처 뒤4자리가 없다');
    assert.ok(/정라희의 타계정/.test(html), '"누구의 타계정"인지 카드가 말하지 않는다');
    // 두 줄의 [보완] 버튼이 서로 다른 항목을 가리켜야 한다
    const idxs = [...html.matchAll(/_pmFixAcct\((\d+)\)/g)].map(m => m[1]);
    assert.strictEqual(new Set(idxs).size, 2, '두 명의가 같은 항목을 가리킨다: ' + idxs.join(','));
  });

  t('7C-d ★★ 팝업이 "누구 명의 계좌인가"를 맨 위에서 못박는다', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix(twoIdentities());
    const i = S.STATE.pmFix.accts.findIndex(a => a.isSub);
    S._pmFixAcct(i);
    const d = S._dlg;
    assert.ok(d, '팝업이 열리지 않았다');
    assert.ok(/정석진/.test(d.title) && /정라희의 타계정/.test(d.title), '제목이 명의를 말하지 않는다: ' + d.title);
    assert.ok(/pmwho/.test(d.body), '명의 확인 블록이 없다');
    assert.ok(/정석진<\/b> 명의 계좌/.test(d.body), '본문이 명의를 못박지 않는다');
    assert.ok(/·0101/.test(d.body), '연락처 뒤4자리가 없다(동명이인 구분 단서)');
  });

  t('7C-e ★ 같은 소유자의 다른 명의를 목록으로 보여주고 바로 건너뛴다(인덱스만 전달)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix(twoIdentities());
    const self = S.STATE.pmFix.accts.findIndex(a => !a.isSub);
    const other = S.STATE.pmFix.accts.findIndex(a => a.isSub);
    S._pmFixAcct(self);
    const d = S._dlg;
    assert.ok(/같은 소유자의 다른 명의/.test(d.body), '형제 명의 안내가 없다');
    assert.ok(new RegExp('_pmFixAcct\\(' + other + '\\)').test(d.body),
      '다른 명의로 건너뛰는 버튼이 그 항목을 가리키지 않는다');
    assert.ok(!/_pmFixAcct\('/.test(d.body), 'onclick 에 문자열을 보간했다(인덱스만 넘긴다)');
  });

  t('7C-f 명의가 하나뿐이면 형제 안내를 띄우지 않는다(없는 혼동을 만들지 않는다)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([twoIdentities()[0]]);
    S._pmFixAcct(0);
    assert.ok(!/같은 소유자의 다른 명의/.test(S._dlg.body), '형제가 없는데 안내가 떴다');
  });

  t('7C-g 팝업이 그 명의가 걸린 작업을 말한다(어느 건인지 확인 근거)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix(twoIdentities());
    S._pmFixAcct(0);
    assert.ok(/작업: /.test(S._dlg.sub), '작업 목록이 없다: ' + S._dlg.sub);
    assert.ok(/이 명의로 참여한/.test(S._dlg.sub), '"이 리뷰어" 가 아니라 "이 명의" 라고 말해야 한다');
  });

  t('7C-h ★ 명의 표기는 한 벌(_pmAcctLabel) — 카드·팝업이 사본을 두지 않는다', () => {
    const blk = HTML.slice(HTML.indexOf('function _pmFixBlock'), HTML.indexOf('function _pmRowFix'));
    const acct = HTML.slice(HTML.indexOf('function _pmFixAcct'), HTML.indexOf('/** 저장 성공 뒤 공통 마무리'));
    assert.ok(/_pmAcctLabel\(/.test(blk), '카드 줄이 공용 표기 함수를 쓰지 않는다');
    assert.ok(/_pmAcctPlain\(/.test(acct) && /_pmAcctName\(/.test(acct), '팝업이 공용 표기 함수를 쓰지 않는다');
    for (const [n, s] of [['카드', blk], ['팝업', acct]]) {
      assert.ok(!/esc\(a\.name\)/.test(s), n + ' 에 명의 표기 사본이 남아 있다(a.name 직접 렌더)');
    }
  });

  t('7C-i ★ 서버가 계좌 명의·소유자 이름을 실어 준다(화면이 추측하지 않게)', () => {
    const src = read('services/payment.service.js');
    const load = src.slice(src.indexOf('async function _loadAccounts'), src.indexOf('async function _loadTabMeta'));
    assert.ok(/AS "ownerName"/.test(load), '소유자 이름을 안 읽으면 "누구의 타계정"을 말할 수 없다');
    assert.ok(/name: s\.name/.test(load) && /ownerName: s\.ownerName/.test(load), '타계정 맵에 명의·소유자 이름이 없다');
    assert.ok(/name: r\.name/.test(load), '본계정 맵에 이름이 없다');
    assert.ok(/accountName:/.test(src) && /accountOwner:/.test(src), '항목에 명의 필드가 실리지 않는다');
  });

  /* ══════════════════════════════════════════════════════════
     §8 작업별 시트 바로가기 — 아직 구글시트를 직접 봐야 하는 값이 있다
       ★ 죽은 링크(무시트 작업의 가상 ID)를 만들지 않는다 = 빈 링크 + 사유
     ══════════════════════════════════════════════════════════ */
  console.log('\n§8 작업별 시트 바로가기');

  t('8a tabSheetUrl — gid 를 알면 그 탭까지, 모르면 시트만', () => {
    const svc = require(SRC('services/payment.service'));
    assert.strictEqual(svc.tabSheetUrl({ sheetId: 'ABC', tabGid: '123' }),
      'https://docs.google.com/spreadsheets/d/ABC/edit#gid=123');
    assert.strictEqual(svc.tabSheetUrl({ sheetId: 'ABC', tabGid: '' }),
      'https://docs.google.com/spreadsheets/d/ABC/edit');
  });

  t('8b ★★ 이관된 작업(sheetless)도 링크를 만든다 — 막는 것은 "시트가 없는 경우"뿐', () => {
    const svc = require(SRC('services/payment.service'));
    // 사용자 확정: 초도 보완에 시트 참고가 필요하다 → sheetless 여도 진짜 시트ID면 연다(경고는 화면이)
    assert.strictEqual(svc.tabSheetUrl({ sheetId: '1AbCrealSheetId', tabGid: '9', sheetless: true }),
      'https://docs.google.com/spreadsheets/d/1AbCrealSheetId/edit#gid=9');
    // 시스템이 만든 가상 시트ID = 애초에 열 시트가 없다 → 죽은 링크 금지
    assert.strictEqual(svc.tabSheetUrl({ sheetId: 'wt_abc', tabGid: '1', sheetless: true }), '');
    assert.strictEqual(svc.tabSheetUrl({ sheetId: '', tabGid: '9' }), '');
  });

  t('8b2 가상 시트ID 판정은 sheetlessAccept 단일 출처(접두 사본 금지)', () => {
    const src = noLineComments(read('services/payment.service.js'));
    assert.ok(/isVirtualSheetId/.test(src), '판정 함수를 쓰지 않는다');
    assert.ok(!/['"`]wt_['"`]/.test(src), '★ 접두 문자열 사본이 생겼다(한쪽만 바뀌면 죽은 링크가 되살아난다)');
    // 실제로 그 함수의 판정을 따르는지 실행으로 확인
    const { VIRTUAL_SHEET_PREFIX } = require(SRC('services/sheetlessAccept.service'));
    assert.strictEqual(require(SRC('services/payment.service'))
      .tabSheetUrl({ sheetId: VIRTUAL_SHEET_PREFIX + 'deadbeef', tabGid: '1' }), '');
  });

  await ta('8c 대상 목록에 sheetUrl·sheetless 가 실린다(화면이 재조립하지 않게)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M',
        goodsCostType: '', tabGid: '77', sheetless: false }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.sheetUrl, 'https://docs.google.com/spreadsheets/d/S1/edit#gid=77');
      assert.strictEqual(it.sheetless, false);
    });
  });

  await ta('8d ★ 이관된 작업 = 링크 + sheetless 신호(화면이 경고 팝업을 띄울 근거)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M',
        goodsCostType: '', tabGid: '77', sheetless: true }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.sheetUrl, 'https://docs.google.com/spreadsheets/d/S1/edit#gid=77');
      assert.strictEqual(it.sheetless, true);
    });
  });

  await ta('8d1 시스템이 만든 무시트 작업(가상 ID)은 빈 링크', async () => {
    await withStubPool(targetsHandler({
      rows: [{ sheetId: 'wt_0123456789abcdef', tabName: 'T1', rowIndex: 1, reviewerName: '차', phone8: '12345678' }],
      tabRows: [{ sheetId: 'wt_0123456789abcdef', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M',
        goodsCostType: '', tabGid: '100000001', sheetless: true }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.sheetUrl, '');
      assert.strictEqual(it.sheetless, true);
    });
  });

  t('8d2 ★ 탭 메타 SELECT 가 판정 재료를 실제로 읽는다(스텁은 SQL 을 해석하지 않는다)', () => {
    const src = noLineComments(read('services/payment.service.js'));
    const q = src.slice(src.indexOf('async function _loadTabMeta'), src.indexOf('function tabSheetUrl'));
    assert.ok(/tc\.sheetless AS "sheetless"/.test(q), '★ sheetless 를 안 읽으면 무시트 작업에 죽은 링크가 생긴다');
    assert.ok(/tc\.tab_gid AS "tabGid"/.test(q), 'gid 를 안 읽으면 시트만 열려 엉뚱한 탭을 본다');
  });

  /* ── UI 는 **구글시트로 보내지 않는다**(사용자 확정 2026-08-19) ──
       탈시트 이후 진실원본은 작업보드 표다. 시트를 열어 두면 거기서 고친 값이
       시스템에 반영되지 않아 사고가 난다 → 보완 창구의 바로가기는 작업보드 하나. */
  t('8e ★★ 보완 창구에 구글시트 링크·버튼이 남아 있지 않다', () => {
    const blk = HTML.slice(HTML.indexOf('function _pmBoardBtn'), HTML.indexOf('const _PM_FIX_CARD_CAP'));
    assert.ok(blk.length > 100 && /_pmOpenBoard/.test(blk), '바로가기 블록을 잘못 잘랐다(빈 문자열은 무엇이든 통과한다)');
    const fix = HTML.slice(HTML.indexOf('function _pmFixBlock'), HTML.indexOf('function _pmFixAcct'));
    for (const [n, src] of [['바로가기', blk], ['보완 카드·팝업', fix]]) {
      assert.ok(!/docs\.google\.com/.test(src), n + ' 에 구글시트 주소가 남아 있다');
      assert.ok(!/_pmOpenSheet|_pmSheetBtn|_pmSheetOk/.test(src), n + ' 에 옛 시트 버튼이 되살아났다');
    }
    assert.ok(!/function _pmOpenSheet|function _pmSheetBtn|function _pmSheetOk/.test(HTML),
      '★ 시트 열기 함수가 되살아났다(창구가 둘이 되면 시트에서 고친 값이 조용히 사라진다)');
    /* ★ 안내 **문구**도 없는 버튼을 가리키면 안 된다 — 버튼은 [📋 작업보드]인데 문장만 [📄 시트]로
         남아 담당자가 화면에 없는 버튼을 찾던 드리프트가 실제로 있었다(2026-08-19). */
    assert.ok(!/\[📄 시트\]/.test(fix), '★ 보완 안내 문구가 아직 [📄 시트]를 가리킨다(그 버튼은 없다)');
    assert.ok(/\[📋 작업보드\]/.test(fix), '보완 안내 문구가 작업보드 바로가기를 말해야 한다');
  });

  t('8f 작업보드 버튼 — 인덱스만 넘긴다(카드·묶은 줄이 같은 렌더러)', () => {
    const S = loadFixFns();
    S.STATE.pmFix = S._pmBuildFix([
      mkItem({ tabName: 'T1', tabLabel: 'A', issues: ['no_bank'] }),
      mkItem({ tabName: 'T2', tabLabel: 'B', rowIndex: 2, issues: ['no_bank'], sheetless: true }),
    ]);
    const html = S._pmFixBlock();
    assert.strictEqual((html.match(/onclick="_pmOpenBoard\(\d+\)"/g) || []).length, 4,
      '★ 작업마다 카드 머리 + 묶은 줄 두 곳에서 작업보드로 갈 수 있어야 한다(이관 작업도 동일)');
    assert.ok(!/onclick="_pmOpenBoard\([^)]*['"]/.test(html), '★ onclick 에 문자열을 보간했다');
    assert.ok(!/disabled/.test(html.slice(html.indexOf('작업보드') - 200, html.indexOf('작업보드') + 40)),
      '작업보드는 항상 열 수 있다 — 비활성 버튼이 되면 안 된다');
    // 사본 금지: 카드 머리줄과 묶은 줄이 같은 렌더러를 쓴다
    const blk = HTML.slice(HTML.indexOf('function _pmFixBlock'), HTML.indexOf('function _pmRowFix'));
    assert.strictEqual((blk.match(/_pmBoardBtn\(i\)/g) || []).length, 2,
      '카드 머리와 묶은 줄이 같은 렌더러(_pmBoardBtn)를 써야 한다');
  });

  t('8g ★ 작업보드 이동은 pendingTab 계약 그대로(사본 금지) + 팝업을 먼저 닫는다', () => {
    const fn = HTML.slice(HTML.indexOf('function _pmOpenBoard'), HTML.indexOf('const _PM_FIX_CARD_CAP'));
    const close = fn.indexOf('_pmCloseDialog()'), pend = fn.indexOf('STATE.pendingTab'), sw = fn.indexOf("switchView('workdesk')");
    assert.ok(close >= 0, '팝업을 안 닫으면 오버레이가 작업보드를 가린다');
    assert.ok(pend > close && sw > pend, '닫기 → 예약 → 화면 전환 순서여야 한다');
    assert.ok(/sheetId:w\.sheetId, tabName:w\.tabName/.test(fn.replace(/\s+/g, ' ')), '탭 지목 재료가 없다');
    assert.ok(/tabGid:w\.tabGid/.test(fn), '★ gid 를 빠뜨리면 목록에 없는 탭이 gid 없이 열린다');
  });

  await ta('8h ★ 작업보드 바로가기 재료(tabGid)를 서버가 실어 준다(화면이 추측하지 않게)', async () => {
    await withStubPool(targetsHandler({
      tabRows: [{ sheetId: 'S1', tabName: 'T1', label: 'T1', transferBank: '하나은행', depositName: 'M',
        goodsCostType: '', tabGid: '77', sheetless: false }],
      ownRows: [{ reviewerId: '11111111-1111-1111-1111-111111111111', phone8: '12345678', bankName: '국민은행', bankAccount: '1', accountHolder: '홍' }],
      amountCells: { '결제금액': '1000' },
    }), async (svc) => {
      const it = (await svc.listPaymentTargets()).items[0];
      assert.strictEqual(it.tabGid, '77');
    });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
