'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture,evidence,id,snapshot,hash}=require('./helpers/dualChannelFixture');
const crypto=require('node:crypto');
test('actual SQL: reviews complete independently, staff pending and both receipt validations gate payment',async()=>{
 const db=await fixture(); try{
 const review=require('../src/services/dualChannelReview.service');
 const payout=require('../src/services/dualChannelPayout.service');
 for(const c of ['naver','coupang'])await evidence(db,c,'review');
 assert.equal((await review.evaluateBundleReviewCompletion(db,{orderSubmissionId:id})).complete,true);
 await db.query(`UPDATE review_submissions SET superseded_at=now() WHERE purchase_channel='coupang'`);
 assert.equal((await review.evaluateBundleReviewCompletion(db,{orderSubmissionId:id})).complete,false);
 await db.exec(`UPDATE review_submissions SET superseded_at=NULL`);
 await db.exec(`UPDATE review_submissions SET byte_sha256=(SELECT byte_sha256 FROM review_submissions WHERE purchase_channel='naver' LIMIT 1) WHERE purchase_channel='coupang'`);
 assert.ok((await review.evaluateBundleReviewCompletion(db,{orderSubmissionId:id})).reasons.includes('duplicate_evidence'));
 await db.query('UPDATE review_submissions SET byte_sha256=$1 WHERE purchase_channel=\'coupang\'',[crypto.createHash('sha256').update('coupang-review').digest('hex')]);
 const financialContext=async()=>({bankName:'은행',bankAccount:'1234567',accountHolder:'가',payoutMode:'ours',reviewFee:1000,productPrice:19000});
 const options={target:{orderSubmissionId:id,sheetId:'s',tabName:'t',rowIndex:2},financialContext};
 let result=await payout.evaluateOrderPayoutEligibility(db,options);
 assert.equal(result.eligible,false);assert.ok(result.reasons.includes('identity_staff_pending'));
 for(const c of ['naver','coupang']) await evidence(db,c,'receipt');
 result=await payout.evaluateOrderPayoutEligibility(db,options);assert.equal(result.eligible,false);
 await db.query(`UPDATE order_submissions SET purchase_identity_result='match' WHERE id=$1`,[id]);
 result=await payout.evaluateOrderPayoutEligibility(db,options);assert.equal(result.eligible,true);assert.equal(result.productPrice,19000);assert.equal(result.reviewFee,1000);
 const goodFingerprint=result.fingerprint;
 const split=await payout.evaluateOrderPayoutEligibility(db,{...options,financialContext:async()=>({...await financialContext(),payoutMode:'split'})});
 assert.equal(split.productPrice,0);assert.equal(split.reviewFee,1000);assert.equal(split.eligible,true);
 await db.exec(`UPDATE campaign_participants SET row_json=row_json-'결제금액'`);
 assert.ok((await payout.evaluateOrderPayoutEligibility(db,options)).reasons.includes('workboard_total_mismatch'));
 await db.exec(`UPDATE campaign_participants SET row_json=row_json||'{"결제금액":"19000"}'`);
 await db.exec('UPDATE order_submissions SET deleted_at=now()');
 assert.ok((await payout.evaluateOrderPayoutEligibility(db,options)).reasons.includes('order_cancelled'));
 await db.exec('UPDATE order_submissions SET deleted_at=NULL');
 assert.equal((await payout.evaluateOrderPayoutEligibility(db,options)).fingerprint,goodFingerprint);
 await db.query(`INSERT INTO payment_batch_items(order_submission_id,status)VALUES($1,'pending')`,[id]);
 assert.ok((await payout.evaluateOrderPayoutEligibility(db,options)).reasons.includes('already_locked'));
 }finally{await db.close();}
});
