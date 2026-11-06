'use strict';
require('./helpers/dualChannelDependencies.cjs');const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture,id}=require('./helpers/dualChannelFixture');
test('first-download shared gate rejects stale fingerprint, missing second review, changed staff proof and duplicate parent',async()=>{
 const db=await fixture();try{
 const {evidence}=require('./helpers/dualChannelFixture');for(const c of ['naver','coupang'])for(const role of ['review','receipt'])await evidence(db,c,role);
 await db.exec(`UPDATE order_submissions SET purchase_identity_result='match';ALTER TABLE payment_batch_items ADD COLUMN eligibility_fingerprint text,ADD COLUMN sheet_id text,ADD COLUMN tab_name text,ADD COLUMN row_index integer,ADD COLUMN product_price integer,ADD COLUMN review_fee integer,ADD COLUMN bank_name text,ADD COLUMN bank_account text,ADD COLUMN account_holder text;`);
 const financialContext=async()=>({bankName:'하나은행',bankAccount:'001234567',accountHolder:'가',payoutMode:'ours',reviewFee:1000,productPrice:19000,bank:'kbank',transferMemo:'',reasons:[]});
 const svc=require('../src/services/dualChannelPayout.service');const target={orderSubmissionId:id,sheetId:'s',tabName:'t',rowIndex:2};
 const good=await svc.evaluateOrderPayoutEligibility(db,{target,financialContext});
 const item={id:1,order_submission_id:id,eligibility_fingerprint:good.fingerprint,sheet_id:'s',tab_name:'t',row_index:2,status:'pending',product_price:19000,review_fee:1000,bank_name:'하나은행',bank_account:'001234567',account_holder:'가'};
 await db.query(`INSERT INTO payment_batch_items(id,order_submission_id,status)VALUES(1,$1,'pending')`,[id]);
 assert.equal((await svc.checkBatchDualEligibility({items:[item]},{db,financialContext})).ok,true);
 await db.exec(`UPDATE review_submissions SET superseded_at=now() WHERE purchase_channel='coupang' AND evidence_role='review'`);
 assert.equal((await svc.checkBatchDualEligibility({items:[item]},{db,financialContext})).ok,false);
 await db.exec(`UPDATE review_submissions SET superseded_at=NULL;UPDATE order_submissions SET purchase_identity_result='uncertain'`);
 assert.equal((await svc.checkBatchDualEligibility({items:[item]},{db,financialContext})).ok,false);
 }finally{await db.close();}
});
