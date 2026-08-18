'use strict';
const assert = require('assert');
const fs = require('fs');
const svc = require('../src/services/paymentResult.service');

const outside = [
  { seq: 8, memo: '올바디로션만두', holder: '리뷰어A', amount: 20300, accountTail: '1623', transferredAt: '2026.8.14 12:42', success: true },
  { seq: 9, memo: '올바디로션만두', holder: '리뷰어B', amount: 20300, accountTail: '8350', transferredAt: '2026.8.14 12:42', success: true },
];

assert.equal(typeof svc.findAccountMismatchCandidates, 'function',
  '계좌 불일치 이체의 수동 대조 후보 함수가 제공되어야 한다');
const mismatchCandidates = svc.findAccountMismatchCandidates({
  transfers: [{ seq: 31, holder: '원지웅(모임통장)', amount: 79000, accountTail: '6895', transferredAt: '2026.8.18 17:15', success: true }],
  items: [
    { id: 'target-1', tabName: '장수돌침대', reviewerName: '원지웅', amount: 79000, status: 'failed', accountTail: '0172', failReason: '이체 실패 — 결과 파일에 해당 이체내역 없음' },
    { id: 'target-2', tabName: '장수돌침대', reviewerName: '원지웅', amount: 78000, status: 'failed', accountTail: '0172', failReason: '이체 실패 — 결과 파일에 해당 이체내역 없음' },
  ],
});
assert.deepEqual(mismatchCandidates, [{
  resultSeq: 31, itemId: 'target-1', reviewerName: '원지웅', amount: 79000,
  resultAccountTail: '6895', expectedAccountTail: '0172', transferredAt: '2026.8.18 17:15',
}], '같은 이름·금액의 결과와 결과파일 누락 실패 항목만 수동 대조 후보가 된다');
assert.deepEqual(svc.findAccountMismatchCandidates({
  transfers: [{ seq: 31, holder: '원지웅(모임통장)', amount: 79000, accountTail: '6895', success: true }],
  items: [
    { id: 'target-1', reviewerName: '원지웅', amount: 79000, status: 'failed', accountTail: '0172', failReason: '이체 실패 — 결과 파일에 해당 이체내역 없음' },
    { id: 'target-2', reviewerName: '원지웅', amount: 79000, status: 'failed', accountTail: '1234', failReason: '이체 실패 — 결과 파일에 해당 이체내역 없음' },
  ],
}), [], '같은 회차에 동명이인·동일 금액 후보가 둘 이상이면 수동 대조를 허용하지 않는다');
const reconciliationMigration = fs.readFileSync(require.resolve('../migrations/119_payment_account_mismatch_reconciliations.sql'), 'utf8');
assert.match(reconciliationMigration, /payment_account_mismatch_reconciliations/);
assert.match(reconciliationMigration, /UNIQUE \(batch_id, result_seq\)/);
assert.match(reconciliationMigration, /UNIQUE \(batch_item_id\)/);
let searchSql = '';

svc.__setPoolForTest({
  async query(sql) {
    if (/GROUP BY ri\.sheet_id, ri\.tab_name/.test(sql)) {
      searchSql = sql;
      return { rows: [{ sheetId: 's1', tabName: '0807(올리브영)바디로션 100건', label: '0807(올리브영)바디로션 100건' }] };
    }
    if (/FROM payment_result_uploads WHERE id/.test(sql)) {
      return { rows: [{ summary: { preview: { unmatchedResults: outside } } }] };
    }
    if (/FROM unconfirmed_transfer_reviews WHERE upload_id/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM payment_batch_items WHERE batch_id = \$1/.test(sql)) {
      return { rows: [] };
    }
    if (/FROM review_index ri/.test(sql) && /alreadyPaid/.test(sql)) {
      assert.match(sql, /ri\.is_submitted2 = 'PAID'/);
      return { rows: [
        { reviewerName: '리뷰어A', rowIndex: 5, alreadyPaid: true },
        { reviewerName: '리뷰어B', rowIndex: 6, alreadyPaid: false },
      ] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
  },
});

(async () => {
  const search = await svc.searchUnconfirmedWorkCandidates({ query: '바디로션' });
  assert.equal(search.candidates.length, 1);
  assert.match(searchSql, /tc\.display_name/);
  assert.match(searchSql, /rc\.transfer_memo/, '공고 입금명도 미확인 이체 후보 검색에 포함한다');
  assert.match(searchSql, /AS "recommended"/, '입금명 정확 일치 후보를 추천으로 표시한다');
  assert.doesNotMatch(searchSql, /tc\.label/);

  const out = await svc.inspectUnconfirmedWorkMatch({
    batchId: 'b1', uploadId: 'u1', memo: '올바디로션만두', sheetId: 's1', tabName: '0807(올리브영)바디로션 100건',
  });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].state, 'duplicate_payment');
  assert.equal(out.results[1].state, 'candidate_unpaid');
  assert.equal(out.results[1].rowIndex, 6, 'unique workboard participant exposes its source row');
  assert.equal(out.summary.duplicatePayment, 1);
  assert.equal(out.summary.candidateUnpaid, 1);
  assert.deepEqual(out.reconciliationCandidates, []);
  const paymentResultSource = fs.readFileSync(require.resolve('../src/services/paymentResult.service.js'), 'utf8');
  assert.match(paymentResultSource, /FROM unconfirmed_transfer_reviews WHERE upload_id = \$1/,
    '이미 검토한 이체 결과는 다시 미확인 목록에 나타나지 않아야 한다');
  assert.doesNotMatch(paymentResultSource, /const state = paid.length/, '이체 성공 여부를 먼저 판정해야 한다');
  const routes = fs.readFileSync(require.resolve('../src/routes/trackB.routes.js'), 'utf8');
  assert.match(routes, /router\.get\('\/payment\/unconfirmed-work-search', authMiddleware, adminOrMasterMiddleware/);
  assert.match(routes, /router\.post\('\/payment\/batch\/:id\/unconfirmed-work-inspect', authMiddleware, adminOrMasterMiddleware/);
  assert.match(routes, /router\.post\('\/payment\/batch\/:id\/unconfirmed-reconcile', authMiddleware, adminOrMasterMiddleware/);
  assert.match(routes, /b\.confirm !== true/);
  const workdesk = fs.readFileSync(require.resolve('../../frontend/workdesk.html'), 'utf8');
  assert.match(workdesk, /작업 검색·대조/);
  assert.match(workdesk, /function _pmUnconfirmedLiveSearch\(\)/);
  assert.match(workdesk, /oninput="_pmUnconfirmedLiveSearch\(\)"/);
  assert.match(workdesk, /setTimeout\(\(\)=>_pmUnconfirmedSearch\(\{ live:true \}\),180\)/);
  assert.match(workdesk, /seq!==_pmUnconfirmedSearchSeq/);
  assert.match(workdesk, /pm-unconfirmed-candidates/);
  assert.match(workdesk, /추천 공고/);
  assert.match(workdesk, /pmUnconfirmedRecommendation/);
  assert.match(workdesk, /function _pmOpenBatchUnconfirmed\(i\)/);
  assert.match(workdesk, /function _pmOpenUnconfirmedMatchList\(i\)/,
    '미확인 이체를 여러 건 목록에서 선택해 대조하는 진입점이 있어야 한다');
  assert.match(workdesk, /pm-unconfirmed-listbox/,
    '다건 미확인 이체 목록은 고정 높이 스크롤 영역으로 렌더링해야 한다');
  assert.match(workdesk, /function _pmSelectUnconfirmedMemo\(i\)/,
    '목록에서 선택한 이체만 아래 검색 및 대조 대상으로 전환해야 한다');
  assert.match(workdesk, /pm-unconfirmed-compare-table/,
    '작업보드와 이체결과를 표 행으로 비교해야 한다');
  assert.match(workdesk, /function _pmRenderUnconfirmedDirect\(match=null\)/,
    '팝업을 열면 검색 없이 즉시 비교표를 렌더링해야 한다');
  assert.match(workdesk, /const transfers=group\?\.items\|\|\[\]/,
    '선택한 통장표시 묶음의 미확인 이체결과 전체를 비교표에 표시해야 한다');
  assert.match(workdesk, /function _pmOpenUnconfirmedWorkSearch\(\)/,
    '연결된 작업보드가 없을 때 관리자가 작업보드를 직접 연결할 수 있어야 한다');
  assert.match(workdesk, /function _pmAccountNumber\(transfer\)/,
    '계좌번호는 전체 값이 있을 때 끝자리로 축약하지 않고 표시해야 한다');
  assert.match(workdesk, /function _pmUnconfirmedStateLabel\(state\)/,
    '대조 판정 코드는 운영자가 읽을 수 있는 한글로 변환해야 한다');
  assert.match(workdesk, /function _pmReviewUnconfirmedResult\(rowIndex, action\)/,
    '여러 이체결과는 카드 전체가 아니라 행별 판정에 맞춰 처리해야 한다');
  assert.match(workdesk, /입금 성공 승인/,
    '입금 이력이 없는 행에만 대조 승인 동작을 제공해야 한다');
  assert.match(workdesk, /중복 입금 처리/,
    '이미 입금된 행은 중복입금 후속관리로 보내야 한다');
  assert.doesNotMatch(workdesk, /남은 행 전체 완료/,
    '서로 다른 판정의 행을 일괄 대조 완료할 수 없어야 한다');
  assert.match(paymentResultSource, /function _adminUnconfirmedAccountPreview\(preview, rows\)/,
    '저장본은 마스킹을 유지하고 관리자 대조 응답에서만 전체 계좌번호를 복원해야 한다');
  assert.match(workdesk, /\.lgwrap\.pm-unconfirmed-compare-table\{overflow-x:hidden;/,
    '운영 대조표는 모달 안에서 가로 스크롤을 만들지 않아야 한다');
  assert.match(workdesk, /\.pm-unconfirmed-compare-table table\.lgtable\{min-width:0;table-layout:fixed\}/,
    '운영 대조표는 공통 테이블의 최소 폭을 상속하지 않아야 한다');
  assert.match(workdesk, /table\.lgtable\.pm-unconfirmed-two-row-table\{width:100%;min-width:0;table-layout:fixed\}/,
    '7열 비교표는 모달 폭 안에서 모든 값을 보여주는 전용 폭 규칙을 가져야 한다');
  assert.match(workdesk, /\.pm-unconfirmed-two-row-table thead th:nth-child\(8\)\{width:16%\}/,
    '행별 조치 열은 밀리지 않도록 전용 폭을 가져야 한다');
  assert.match(workdesk, /function _pmReconcileMismatch\(i\)/);
  assert.match(workdesk, /unconfirmed-reconcile/);
  assert.match(workdesk, /미확인 \$\{unconfirmed\}건 조치/);
  assert.match(workdesk, /STATE\.pmUnconfirmedGroups=groups\.map/);
  assert.match(workdesk, /function _pmOpenBatchUnconfirmedGroup\(i\)/);
  assert.doesNotMatch(workdesk, /_pmOpenBatchUnconfirmedMemo\(\$\{JSON\.stringify\(memo\)\}\)/);
  const paymentService = fs.readFileSync(require.resolve('../src/services/payment.service.js'), 'utf8');
  assert.match(paymentService, /resultUnconfirmedCount: unmatched\.length/);
  assert.match(paymentService, /itemCount - resultSuccessCount/);
  console.log('payment unconfirmed work-match tests passed');
})().finally(() => svc.__setPoolForTest(null));
