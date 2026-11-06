'use strict';
process.env.JWT_SECRET = require('node:crypto').randomBytes(48).toString('hex');
require('./helpers/dualChannelDependencies.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture,id,owner}=require('./helpers/dualChannelRealFixture');
const lifecycle=require('./dualChannelLifecycle.service');
test('real 215 SQL: signed actual uploaded bytes persist; tamper/current-change/foreign-owner reject; two reviews complete without receipts',async()=>{
 const db=await fixture();const files=new Map();let n=0;
 try{
 const review=require('../src/services/dualChannelReview.service');
 const svc=review.createService({db,lifecycle,drive:{upload:async bytes=>{const f='uploaded-'+(++n);files.set(f,bytes);return f;},read:async f=>files.get(f)},authorizeTarget:async()=>true});
 const base={orderSubmissionId:id,sheetId:'s',tabName:'t',rowIndex:2};const session={ownerReviewerId:owner};
 await assert.rejects(svc.stageReviewUpload({body:{...base,slotKey:'review',imageBase64:Buffer.from('bad').toString('base64'),expectedRevision:0},reviewerSession:{ownerReviewerId:'foreign'}}),/review_owner_changed/);
 const tokens=[];
 for(const key of ['review','slot2']){
 const result=await svc.stageReviewUpload({body:{...base,slotKey:key,imageBase64:Buffer.from('photo-'+key).toString('base64'),expectedRevision:0},reviewerSession:session});
 assert.ok(result.uploadToken);tokens.push(result.uploadToken);
 const row=(await db.query('SELECT * FROM review_submissions WHERE file_id=$1',[result.fileId])).rows[0];
 assert.equal(row.evidence_role,'review');assert.equal(row.purchase_channel,key==='review'?'naver':'coupang');assert.equal(row.completed_at,null);
 }
 await assert.rejects(svc.completeReviewUpload({body:{...base,uploadTokens:[tokens[0]+'x']},reviewerSession:session}),/review_upload_proof_invalid/);
 let result=await svc.completeReviewUpload({body:{...base,uploadTokens:tokens},reviewerSession:session});assert.equal(result.complete,true);
 assert.equal((await db.query('SELECT is_submitted FROM campaign_participants')).rows[0].is_submitted,true);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM review_submissions WHERE completed_at IS NOT NULL')).rows[0].n,2);
 await review.removeReviewEvidence({db,fileId:'uploaded-2',expectedRevision:1,actor:'staff'});
 assert.equal((await db.query('SELECT is_submitted FROM campaign_participants')).rows[0].is_submitted,false);
 files.set('uploaded-1',Buffer.from('changed'));
 await assert.rejects(svc.completeReviewUpload({body:{...base,uploadTokens:tokens},reviewerSession:session}),/review_file_changed/);
 }finally{await db.close();}
});
