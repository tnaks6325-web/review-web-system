'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {fixture,OWNER,SINGLE,BUNDLE,IMAGE}=require('./helpers/purchaseCaptureIntegrationFixture');
const session={ownerReviewerId:OWNER,loginKind:'self',loginPhone8:'12345678'};
const actor={name:'가상 직원',role:'staff'};
async function args(h,orderSubmissionId,channel){const c=(await h.core.getForReviewer({session,orderSubmissionId})).item.channels.find(c=>c.channel===channel);return {session,orderSubmissionId,channel,imageBase64:IMAGE.toString('base64'),mimeType:'image/png',requestKey:randomUUID(),expectedEvidenceHash:c.evidenceHash};}
test('old screens must refresh before new photo writes, but committed legacy retries remain readable',async()=>{
 const h=await fixture();try{
  for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
   const input=await args(h,order,channel),uploads=h.getUploaded();
   const before=(await h.pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n;
   await assert.rejects(h.core.addSupplement(input),e=>e.code==='CAPTURE_REFRESH_REQUIRED'&&e.status===409);
   assert.equal(h.getUploaded(),uploads);assert.equal((await h.pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,before);
   const saved=await h.core.addSupplement({...input,requestCheck:true});
   const legacyHash=createHash('sha256').update(JSON.stringify([input.imageBase64,input.mimeType,input.expectedEvidenceHash])).digest('hex');
   await h.pg.query('UPDATE purchase_capture_supplements SET request_payload_hash=$2 WHERE request_key=$1',[input.requestKey,legacyHash]);
   const replay=await h.core.addSupplement(input);assert.equal(replay.request.id,saved.request.id);assert.equal(replay.created,false);assert.equal(h.getUploaded(),uploads+1);
  }
 }finally{await h.pg.close();}
});
test('photo-only supplements keep the original staff inquiry readable but prohibit stale decisions',async()=>{
 const h=await fixture();try{
  for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
   const input=await args(h,order,channel);
   const first=await h.checks.requestCheck({session,orderSubmissionId:order,channel,expectedEvidenceHash:input.expectedEvidenceHash,note:'원래 사진 확인'});
   const before=(await h.pg.query('SELECT * FROM purchase_capture_check_requests WHERE id=$1',[first.request.id])).rows[0];
   await h.core.addSupplement({...input,requestCheck:false});
   const detail=await h.checks.getForStaff({actor,requestId:first.request.id});
   const target=detail.item.channels.filter(c=>c.request?.id===first.request.id);assert.equal(target.length,1);assert.equal(target[0].channel,channel);assert.equal(target[0].evidenceChanged,true);assert.equal(target[0].photos.length,3);
   await assert.rejects(h.checks.decideForStaff({actor,requestId:first.request.id,decision:'confirmed',note:'',expectedEvidenceHash:target[0].evidenceHash}),e=>e.code==='STALE_EVIDENCE'&&e.status===409);
   assert.deepEqual((await h.pg.query('SELECT * FROM purchase_capture_check_requests WHERE id=$1',[first.request.id])).rows[0],before);
   const latest=await h.checks.requestCheck({session,orderSubmissionId:order,channel,expectedEvidenceHash:target[0].evidenceHash});
   const current=await h.checks.getForStaff({actor,requestId:latest.request.id});const currentChannel=current.item.channels.find(c=>c.channel===channel);
   assert.equal(currentChannel.evidenceChanged,false);assert.equal(currentChannel.request.id,latest.request.id);
   const oldAgain=await h.checks.getForStaff({actor,requestId:first.request.id});assert.equal(oldAgain.item.channels.find(c=>c.channel===channel).request.id,first.request.id);assert.equal(oldAgain.item.channels.find(c=>c.channel===channel).evidenceChanged,true);
  }
 }finally{await h.pg.close();}
});
