'use strict';
const assert = require('assert');
const fs = require('fs');
const svc = require('../src/services/paymentResult.service');

const outside = [
  { seq: 8, memo: '올바디로션만두', holder: '리뷰어A', amount: 20300, accountTail: '1623', transferredAt: '2026.8.14 12:42' },
  { seq: 9, memo: '올바디로션만두', holder: '리뷰어B', amount: 20300, accountTail: '8350', transferredAt: '2026.8.14 12:42' },
];
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
  assert.doesNotMatch(searchSql, /tc\.label/);

  const out = await svc.inspectUnconfirmedWorkMatch({
    batchId: 'b1', uploadId: 'u1', memo: '올바디로션만두', sheetId: 's1', tabName: '0807(올리브영)바디로션 100건',
  });
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].state, 'duplicate_payment');
  assert.equal(out.results[1].state, 'candidate_unpaid');
  assert.equal(out.summary.duplicatePayment, 1);
  assert.equal(out.summary.candidateUnpaid, 1);
  const routes = fs.readFileSync(require.resolve('../src/routes/trackB.routes.js'), 'utf8');
  assert.match(routes, /router\.get\('\/payment\/unconfirmed-work-search', authMiddleware, adminOrMasterMiddleware/);
  assert.match(routes, /router\.post\('\/payment\/batch\/:id\/unconfirmed-work-inspect', authMiddleware, adminOrMasterMiddleware/);
  const workdesk = fs.readFileSync(require.resolve('../../frontend/workdesk.html'), 'utf8');
  assert.match(workdesk, /작업 검색·대조/);
  assert.match(workdesk, /function _pmUnconfirmedLiveSearch\(\)/);
  assert.match(workdesk, /oninput="_pmUnconfirmedLiveSearch\(\)"/);
  assert.match(workdesk, /setTimeout\(\(\)=>_pmUnconfirmedSearch\(\{ live:true \}\),180\)/);
  assert.match(workdesk, /seq!==_pmUnconfirmedSearchSeq/);
  assert.match(workdesk, /position:absolute;z-index:3/);
  assert.match(workdesk, /function _pmOpenBatchUnconfirmed\(i\)/);
  assert.match(workdesk, /미확인 \$\{unconfirmed\}건 조치/);
  assert.match(workdesk, /STATE\.pmUnconfirmedGroups=groups\.map/);
  assert.match(workdesk, /function _pmOpenBatchUnconfirmedGroup\(i\)/);
  assert.doesNotMatch(workdesk, /_pmOpenBatchUnconfirmedMemo\(\$\{JSON\.stringify\(memo\)\}\)/);
  const paymentService = fs.readFileSync(require.resolve('../src/services/payment.service.js'), 'utf8');
  assert.match(paymentService, /resultUnconfirmedCount: unmatched\.length/);
  assert.match(paymentService, /itemCount - resultSuccessCount/);
  console.log('payment unconfirmed work-match tests passed');
})().finally(() => svc.__setPoolForTest(null));
