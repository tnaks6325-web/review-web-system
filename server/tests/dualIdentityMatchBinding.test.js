'use strict';
// An automatic identity "match" is bound to the evidence it was computed from.
// If the card/identity/recipient/photo changes after submission, payout must wait for staff.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, evidence, id } = require('./helpers/dualChannelFixture');
const payout = require('../src/services/dualChannelPayout.service');
const review = require('../src/services/dualChannelReview.service');

const target = { orderSubmissionId: id, sheetId: 's', tabName: 't', rowIndex: 2 };
const financialContext = async () => ({ bankName: '은행', bankAccount: '1', accountHolder: '가', reviewFee: 1000, payoutMode: 'ours', productPrice: 19000, reasons: [] });

async function readyBundle() {
  const db = await fixture();
  for (const c of ['naver', 'coupang']) { await evidence(db, c, 'review'); await evidence(db, c, 'receipt'); }
  return db;
}

test('match without the submission-time evidence binding is not payable', async () => {
  const db = await readyBundle();
  await db.query("UPDATE order_submissions SET purchase_identity_result='match',purchase_identity_review=$2 WHERE id=$1", [id, JSON.stringify({ status: 'not_required' })]);
  const r = await payout.evaluateOrderPayoutEligibility(db, { target, financialContext });
  assert.ok(r.reasons.includes('identity_staff_pending'), r.reasons.join(','));
});

test('match bound to current evidence is payable; changing a channel recipient afterwards blocks it', async () => {
  const db = await readyBundle();
  const bundle = (await review.evaluateBundleReviewCompletion(db, { orderSubmissionId: id })).bundle;
  const bound = review.identityEvidenceHash(bundle);
  await db.query("UPDATE order_submissions SET purchase_identity_result='match',purchase_identity_review=$2 WHERE id=$1", [id, JSON.stringify({ status: 'not_required', submittedEvidenceHash: bound })]);
  const ok = await payout.evaluateOrderPayoutEligibility(db, { target, financialContext });
  assert.equal(ok.eligible, true, ok.reasons.join(','));
  await db.query("UPDATE order_purchase_channels SET recipient='다른사람' WHERE order_submission_id=$1 AND channel='coupang'", [id]);
  const changed = await payout.evaluateOrderPayoutEligibility(db, { target, financialContext });
  assert.ok(changed.reasons.includes('identity_staff_pending'), 'changed identity evidence after an automatic match must wait for staff');
});

test('submission stores the binding hash in the same transaction as the parent order', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/dualPurchaseSubmission.service.js'), 'utf8');
  const persist = src.slice(src.indexOf('async function persistBundle('), src.indexOf("await client.query('SAVEPOINT hold_confirm')"));
  assert.match(persist, /identityEvidenceHash\(/);
  assert.match(persist, /submittedEvidenceHash/);
});
