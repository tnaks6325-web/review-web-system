/**
 * splitPayout.test.js — 결정 292 「제품비 업체 · 리뷰비 우리」 회귀가드(스텁 · DB 없이)
 * 끝까지 실제 PG 로 도는 검증은 splitPayoutPg.test.js(PGTEST_URL 필요).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}

(async () => {
  const pay = require('../src/services/payment.service');

  console.log('§1 판정');
  await t('1a 입금 방식 = 이체은행과 같은 순서(공고 명시값 > 탭)', () => {
    assert.deepStrictEqual(pay.payoutModeFrom('split_kbank', null), { mode: 'split', bank: 'kbank', source: 'campaign' });
    assert.strictEqual(pay.payoutModeFrom('hana', '제품비업체·리뷰비케이뱅크').mode, 'ours');
    assert.deepStrictEqual(pay.payoutModeFrom('', '제품비업체·리뷰비하나은행'), { mode: 'split', bank: 'hana', source: 'tab' });
    assert.strictEqual(pay.payoutModeFrom('advertiser', null).mode, 'advertiser');
    assert.strictEqual(pay.payoutModeFrom(null, '업체입금').mode, 'advertiser');
    assert.strictEqual(pay.payoutModeFrom(null, '케이뱅크').mode, 'ours');
  });
  await t('1b ★ split 값은 이체 서식 은행으로 읽히지 않는다(normalizeBankChoice 는 kbank|hana 만)', () => {
    for (const v of ['split_kbank', 'split_hana', '제품비업체·리뷰비케이뱅크', '제품비업체·리뷰비하나은행']) assert.strictEqual(pay.normalizeBankChoice(v), null, v);
    assert.strictEqual(pay.advertiserPaysFrom('split_kbank', null), false, '업체입금(우리 목록에서 통째로 뺌) 판정에 split 이 섞이면 리뷰비가 안 나간다');
    assert.strictEqual(pay.advertiserGoodsFrom('split_kbank', null), true);
  });
  await t('1c 리뷰비 전용 항목 = 제품비 0 · 금액 = 리뷰비 > 0 (그 외는 아니다)', () => {
    assert.strictEqual(pay.isFeeOnlyItem({ product_price: 0, review_fee: 1000, amount: 1000 }), true);
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 0, reviewFee: 1000, amount: 1000 }), true);
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 5980, reviewFee: 1000, amount: 6980 }), false);
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 0, reviewFee: 0, amount: 0 }), false);
    assert.strictEqual(pay.isFeeOnlyItem({ productPrice: 5980, reviewFee: 0, amount: 5980 }), false);
    assert.match(pay.feeOnlyItemSql('i'), /COALESCE\(i\.product_price, 0\) = 0 AND COALESCE\(i\.review_fee, 0\) > 0 AND i\.amount = i\.review_fee/);
  });

  console.log('§2 이중 지급 방지 배선');
  const ps = read('src/services/payment.service.js');
  await t('2a ★ 후보 SQL 의 공백 제거가 템플릿에서 살아남는다(\\s 는 템플릿 문자열에서 s 가 된다 — 레드팀 치명 1)', () => {
    const fn = ps.slice(ps.indexOf('async function _splitCandidateKeys('), ps.indexOf('async function _splitCandidateKeys(') + 1500);
    assert.ok(!/'\\s'/.test(fn), "regexp_replace 에 '\\s' 를 쓰지 말 것");
    assert.strictEqual((fn.match(/'\[\[:space:\]\]'/g) || []).length, 2);
  });
  await t('2b ★ split 에서도 입금 칸은 "업체가 넣은 값"일 때만 풀고, 8/11 수동 입금은 풀지 않는다', () => {
    assert.match(ps, /left\(pe\.created_by, 3\) = '업체#' AND btrim\(COALESCE\(pe\.value_text, ''\)\) = btrim\(kv\.value\)/);
    assert.ok(!/strict\(`NOT EXISTS \(\s*SELECT 1 FROM manual_paid/.test(ps), 'manual_paid 를 strict(완화)로 감싸지 말 것');
  });
  await t('2c ★ 우리 원장 잠금 예외 — 업체가 비운 기록은 정정이 아니고, split 후보에서는 예외 없음', () => {
    assert.match(ps, /AND \(\$\{inSplit\} OR NOT EXISTS \(/);
    assert.match(ps, /AND left\(COALESCE\(pe\.created_by, ''\), 3\) <> '업체#'/);
  });
  await t('2d 회차 — 화면이 본 입금 방식 대조(split 이면 필수) · 잠금 안 재확인 · 제품비 0 박제', () => {
    assert.match(ps, /\(w\.payoutMode != null \|\| it\.payoutMode === 'split'\)/);
    assert.match(ps, /lateMode !== \(it\.payoutMode \|\| 'ours'\) \? 'payout_mode_changed'/);
    // Codex PR #1699 — split 이라도 잠근 뒤 입금 칸 값이 업체가 넣은 것인지 다시 본다(직원이 그 사이 적은 날짜 = already_paid)
    assert.match(ps, /\(lockedPaid && !\(lateMode === 'split' && advEntered\)\) \? 'already_paid'/);
    assert.match(ps, /WHERE cp\.id = \$1 AND pe\.field = 'col:' \|\| \$2 AND pe\.reverted_at IS NULL\s*AND left\(pe\.created_by, 3\) = '업체#'/);
    assert.match(ps, /it\.goodsByAdvertiser \? 0 : it\.productPrice, it\.reviewFee, it\.amount, it\.transferMemo/);
  });
  const ap = read('src/services/paymentApply.service.js');
  await t('2e ★ 결과 반영 — 리뷰비 전용은 PAID(페이백 완료)·입금 칸을 건드리지 않고 원장만', () => {
    const rd = ap.slice(ap.indexOf('async function recordDeposits('), ap.indexOf('async function markDepositCells('));
    const fo = rd.indexOf('if (item.feeOnly === true)'), v2 = rd.indexOf('payment_before_review'), paid = rd.indexOf("is_submitted2 = 'PAID'");
    assert.ok(fo > 0 && fo < v2 && fo < paid, 'feeOnly 분기가 v2 검사·PAID 표시보다 앞');
    assert.match(ap, /if \(item\.feeOnly === true\) \{ outcome\.recorded \+= 1; continue; \}/);
    assert.match(ap, /if \(item\.feeOnly === true\) \{ outcome\.verified \+= 1; continue; \}/);
  });
  const pr = read('src/services/paymentResult.service.js');
  await t('2f 결과 반영 네 경로가 feeOnly 를 넘긴다 · 회차 밖 이체 승인은 split 에서 거부', () => {
    assert.ok((pr.match(/feeOnly: _feeOnly\(/g) || []).length >= 4);
    assert.match(pr, /if \(approvedMode === 'split'\) \{\s*throw new ResultError\('split_payout_unconfirmed'/);
    assert.match(pr, /return item && !_feeOnly\(item\) && \(item\.status === 'pending'/, '금액 조정 후보에서 리뷰비 전용 제외');
  });

  console.log('§3 업체 화면 · 리뷰어 화면 · 종결');
  const tb = read('src/services/trackB.service.js');
  await t('3a ★ 우리가 제품비를 보낸(보내는) 줄은 업체 화면에 계좌를 싣지 않는다 · 조회 실패면 전부 숨김', () => {
    assert.match(tb, /if \(advPayout\.batchSeqs\.has\(Number\(r\.seq\)\)\) \{ cur\[h\] = h === '은행' \? '인애드가 제품비 지급 — 보내지 마세요' : ''; continue; \}/);
    assert.match(tb, /if \(advPayout\.lockAll === 'unknown'\) \{ cur\[h\]/);
  });
  await t('3b 업체 기록 — split 도 열고, 리뷰비 전용 회차는 막지 않고, 비워도 리뷰비 항목을 풀지 않는다', () => {
    assert.match(tb, /if \(advMode === 'ours'\) \{ await client\.query\('ROLLBACK'\); return \{ ok: false, error: 'advertiser_payout_off' \}; \}/);
    assert.ok((tb.match(/NOT \$\{require\('\.\/payment\.service'\)\.feeOnlyItemSql\(\)\}/g) || []).length >= 3);
  });
  await t('3c 리뷰어 참여정보 팝업은 리뷰비 전용 항목을 페이백으로 보이지 않는다', () => {
    assert.match(read('src/routes/reviewEdit.routes.js'), /AND NOT \$\{require\('\.\.\/services\/payment\.service'\)\.feeOnlyItemSql\(\)\}/);
  });
  await t('3d 미작성 종결은 리뷰비 전용 항목에 막히지 않는다(막다른 길 방지)', () => {
    assert.match(read('src/services/workdeskReviewResolution.service.js'), /AND NOT \$\{require\('\.\/payment\.service'\)\.feeOnlyItemSql\(\)\} LIMIT 1/);
  });

  console.log('§4 이체은행 쓰기 규칙(업체입금 ↔ 제품비 업체)');
  const pool = require('../src/db/pool');
  const realQuery = pool.query;
  const guard = require('../src/services/advertiserPayout.service').guardTransferBankWrite;
  const withCounts = async (n, fn) => {
    pool.query = async sql => {
      if (/FROM participant_edits/.test(sql) || /FROM payment_batch_items/.test(sql)) return { rows: [{ n }] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ sheetless: true }] };
      if (/advertiser_campaigns/.test(sql)) return { rows: [{ advertiserId: 'a1', advertiserName: '업체', tabGid: null }] };
      return { rows: [] };
    };
    try { return await fn(); } finally { pool.query = realQuery; }
  };
  await t('4a ★ 업체가 기록한 줄이 있으면 업체입금 → 제품비 업체 거부', async () => {
    const g = await withCounts(3, () => guard({ current: 'advertiser', incoming: 'split_kbank', sheetId: 's', tabName: 't' }));
    assert.strictEqual(g.action, 'reject'); assert.strictEqual(g.error, 'advertiser_recorded');
  });
  await t('4b ★ 리뷰비를 보낸 줄이 있으면 제품비 업체 → 업체입금 거부', async () => {
    const g = await withCounts(1, () => guard({ current: '제품비업체·리뷰비케이뱅크', incoming: 'advertiser', sheetId: 's', tabName: 't' }));
    assert.strictEqual(g.action, 'reject'); assert.strictEqual(g.error, 'fee_paid');
  });
  await t('4c 기록이 없으면 업체입금 ↔ 제품비 업체 전환은 확인 없이 쓴다', async () => {
    const g = await withCounts(0, () => guard({ current: 'advertiser', incoming: 'split_hana', sheetId: 's', tabName: 't' }));
    assert.strictEqual(g.action, 'write');
  });
  await t('4d 제품비 업체 → 우리 입금은 확인 표시가 있어야(없으면 유지)', async () => {
    const kept = await withCounts(0, () => guard({ current: 'split_kbank', incoming: 'kbank', sheetId: 's', tabName: 't' }));
    assert.strictEqual(kept.action, 'keep');
    const ok = await withCounts(0, () => guard({ current: 'split_kbank', incoming: 'kbank', ack: true, sheetId: 's', tabName: 't' }));
    assert.strictEqual(ok.action, 'write');
  });
  await t('4f ★ 실제 입금 방식으로 판정 — 탭 업체입금 + 공고 split 에서 공고를 「자동」으로 비우면 split→업체입금 전환으로 본다', async () => {
    pool.query = async (sql) => {
      if (/FROM recruit_campaigns/.test(sql)) return { rows: [{ id: 'c1', transfer_bank: 'split_kbank' }] };
      if (/SELECT transfer_bank FROM tab_configs/.test(sql)) return { rows: [{ transfer_bank: '업체입금' }] };
      if (/FROM payment_batch_items/.test(sql)) return { rows: [{ n: 2 }] };
      if (/FROM tab_configs/.test(sql)) return { rows: [{ sheetless: true }] };
      if (/advertiser_campaigns/.test(sql)) return { rows: [{ advertiserId: 'a1', advertiserName: '업체', tabGid: null }] };
      return { rows: [] };
    };
    try {
      const g = await guard({ current: 'split_kbank', incoming: '', ack: true, sheetId: 's', tabName: 't', slot: 'campaign', campaignId: 'c1' });
      assert.strictEqual(g.action, 'reject'); assert.strictEqual(g.error, 'fee_paid');
    } finally { pool.query = realQuery; }
  });
  await t('4e 조회 실패 = 바꾸지 않는다(fail-closed)', async () => {
    pool.query = async sql => { if (/participant_edits/.test(sql)) throw new Error('boom'); return { rows: [{ sheetless: true }] }; };
    try {
      const g = await guard({ current: 'advertiser', incoming: 'split_kbank', sheetId: 's', tabName: 't' });
      assert.strictEqual(g.action, 'reject');
    } finally { pool.query = realQuery; }
  });

  console.log('§5 화면');
  const html = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'workdesk.html'), 'utf8');
  await t('5a 탭 이체은행 창 · 모집공고 창 세 모양에 선택지 · 끌 때 확인 규칙이 서버와 같다', () => {
    assert.match(html, /\['split_kbank','🏢 제품비 업체 · 리뷰비 케이뱅크'\],\['split_hana','🏢 제품비 업체 · 리뷰비 하나은행'\]/);
    assert.match(html, /const disabling = _isGoodsAdvBank\(cur\) && !_isGoodsAdvBank\(sel\.dataset\.v\);/);
    const rm = fs.readFileSync(path.join(ROOT, '..', 'frontend', 'js', 'recruit-modal.js'), 'utf8');
    assert.strictEqual((rm.match(/data-group="transfer_bank" data-val="split_kbank"/g) || []).length, 3);
    assert.strictEqual((rm.match(/data-group="transfer_bank" data-val="split_hana"/g) || []).length, 3);
  });
  await t('5b 입금관리 — 새 사유 문구 · 작업별 진행 안내 · 회차 요청에 입금 방식', () => {
    assert.match(html, /not_purchased:'구매 전/);
    assert.match(html, /split_no_fee:'리뷰비 미설정/);
    assert.match(html, /\$\{_pmFinishedNoteHtml\(\)\}\$\{_pmAdvPaidNoteHtml\(\)\}\$\{_pmSplitNoteHtml\(\)\}/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
