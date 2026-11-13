'use strict';
const assert=require('node:assert/strict');
const {fixture,OWNER,SINGLE,BUNDLE,IMAGE}=require('./helpers/purchaseCaptureIntegrationFixture');
process.env.NODE_ENV='test';process.env.JWT_SECRET='local-integration-only-not-a-credential';
const {issueReviewerSession}=require('../src/services/reviewerSession.service');
const jwt=require('jsonwebtoken');
(async()=>{
 const h=await fixture();
 const session={ownerReviewerId:OWNER,loginKind:'self',loginPhone8:'12345678',loginName:'시험 리뷰어'};
 try{
  const list=await h.core.listForReviewer({session});
  assert.deepEqual(list.items.map(x=>x.orderSubmissionId).sort(),[SINGLE,BUNDLE].sort(),'Saved orders must remain accessible for viewing, adding a third photo and requesting a check');
  const poolPath=require.resolve('../src/db/pool');require.cache[poolPath]={id:poolPath,filename:poolPath,loaded:true,exports:h.db};
  const drivePath=require.resolve('../src/services/drive.service');require.cache[drivePath]={id:drivePath,filename:drivePath,loaded:true,exports:{
   uploadFileBase64:async base64=>({id:await h.fakeUpload(Buffer.from(base64,'base64'))}),
   downloadFile:async id=>({buffer:h.files.get(id),mimeType:'image/png'}),
  }};
  const folderPath=require.resolve('../src/services/captureFolder.service');require.cache[folderPath]={id:folderPath,filename:folderPath,loaded:true,exports:{resolveCaptureFolder:async()=>({folderId:'local-only-folder'})}};
  process.env.DRIVE_ROOT_FOLDER_ID='local-only-folder';
  const express=require('express'),app=express();app.use(express.json({limit:'15mb'}));
  // Lose only the HTTP reply, after the real service has committed and notified.
  app.use((req,res,next)=>{if(req.headers['x-test-lose-response']==='1')res.json=()=>{res.destroy();return res;};next();});
  const {createPurchaseCaptureRouters}=require('../src/routes/purchaseCapture.routes');
  const routers=createPurchaseCaptureRouters({uploadLimiter:(_q,_s,next)=>next()});
  app.use('/api/reviewer',routers.reviewerRouter);app.use('/api/trackb',routers.staffRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const reviewer=issueReviewerSession(session),staff=jwt.sign({name:'시험 직원',role:'staff'},process.env.JWT_SECRET,{expiresIn:'5m'});
  const call=async(p,{body,token=reviewer,isStaff=false,loseResponse=false}={})=>{const r=await fetch(base+p,{method:body?'POST':'GET',headers:{[isStaff?'Authorization':'X-Reviewer-Token']:isStaff?'Bearer '+token:token,...(body?{'Content-Type':'application/json'}:{}),...(loseResponse?{'X-Test-Lose-Response':'1'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  try{
   const before=(await h.pg.query('SELECT * FROM order_submissions ORDER BY id')).rows;
   const artifactsBefore=(await h.pg.query('SELECT * FROM purchase_capture_artifacts ORDER BY id')).rows;
   const paidBefore=(await h.pg.query('SELECT * FROM payment_batch_items')).rows;
   const reviewsBefore=(await h.pg.query('SELECT * FROM review_submissions')).rows;
   const channelsBefore=(await h.pg.query('SELECT * FROM order_purchase_channels ORDER BY channel')).rows;
   const notifications=[];require('../src/utils/sse').emitCsInquiry=event=>notifications.push(event);
   for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
    const path='/api/reviewer/purchase-captures/'+order;
    let r=await call(path);assert.equal(r.status,200,JSON.stringify(r.data));
    const initial=r.data.item.channels.find(c=>c.channel===channel),count=initial.photos.length;
    assert.equal(count,2);assert.equal(initial.saveState,'saved');
    const noticesBefore=notifications.length;
    const manualBody={channel,expectedEvidenceHash:initial.evidenceHash,note:'이미 제출한 사진을 확인해 주세요',source:'supplement',photos:[{isSupplement:true}]};
    const manual=await call(path+'/check-requests',{body:manualBody});assert.equal(manual.status,200,JSON.stringify(manual.data));assert.equal(manual.data.created,true);assert.equal(notifications.length,noticesBefore+1);
    const manualText=(await h.pg.query('SELECT content FROM cs_messages WHERE meta->\'purchaseCaptureCheck\'->>\'requestId\'=$1',[manual.data.request.id])).rows[0].content;
    assert.equal(manualText,'리뷰어가 구매사진 확인을 요청했어요.\n이미 제출한 사진을 확인해 주세요');
    const duplicate=await call(path+'/check-requests',{body:manualBody});assert.equal(duplicate.status,200);assert.equal(duplicate.data.created,false);assert.equal(duplicate.data.request.id,manual.data.request.id);assert.equal(notifications.length,noticesBefore+1);
    const previousDecision=await call('/api/trackb/purchase-capture-checks/'+manual.data.request.id+'/decision',{token:staff,isStaff:true,body:{decision:'confirmed',note:'기존 사진 확인',expectedEvidenceHash:initial.evidenceHash}});assert.equal(previousDecision.status,200,JSON.stringify(previousDecision.data));
    const body={channel,imageBase64:IMAGE.toString('base64'),mimeType:'image/png',requestCheck:true,requestKey:require('node:crypto').randomUUID(),expectedEvidenceHash:initial.evidenceHash};
    r=await call(path+'/supplements',{body});assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.item.channels.find(c=>c.channel===channel).photos.length,3);
    const request=r.data.request,hash=r.data.item.channels.find(c=>c.channel===channel).evidenceHash;
    assert.ok(request,'HTTP must preserve explicit requestCheck=true');assert.equal(request.status,'pending');assert.equal('notification' in r.data,false);
    assert.equal(notifications.length,noticesBefore+2,'Each committed new request notifies the existing inquiry channel once');
    const uploaded=h.getUploaded();
    const replay=await call(path+'/supplements',{body});assert.equal(replay.status,200);assert.equal(replay.data.request.id,request.id);assert.equal(h.getUploaded(),uploaded);assert.equal(notifications.length,noticesBefore+2,'Retries must not re-notify');
    assert.equal((await h.pg.query('SELECT count(*)::int n FROM cs_messages WHERE meta->\'purchaseCaptureCheck\'->>\'requestId\'=$1',[request.id])).rows[0].n,1);
    assert.equal((await h.pg.query('SELECT content FROM cs_messages WHERE meta->\'purchaseCaptureCheck\'->>\'requestId\'=$1',[request.id])).rows[0].content,'추가사진을 제출하고 확인을 요청했어요.\n구매사진을 추가했어요. 사진 확인을 부탁드려요.');
    r=await call('/api/trackb/purchase-capture-checks/'+request.id,{token:staff,isStaff:true});assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.item.channels.find(c=>c.request?.id===request.id).channel,channel);
    const decisionPath='/api/trackb/purchase-capture-checks/'+request.id+'/decision';
    r=await call(decisionPath,{token:staff,isStaff:true,body:{decision:'needs_photo',note:'주문번호가 보이도록 추가해 주세요',expectedEvidenceHash:hash}});assert.equal(r.status,200,JSON.stringify(r.data));
    r=await call(path);assert.equal(r.data.item.channels.find(c=>c.channel===channel).reason,'주문번호가 보이도록 추가해 주세요');
    r=await call(decisionPath,{token:staff,isStaff:true,body:{decision:'confirmed',note:'',expectedEvidenceHash:hash}});assert.equal(r.status,200,JSON.stringify(r.data));
    r=await call(path);assert.equal(r.data.item.channels.find(c=>c.channel===channel).reviewState,'confirmed');
   }
   const sideEffects=async()=>{
    const result={};for(const table of ['purchase_capture_check_requests','cs_messages','cs_threads','purchase_capture_supplements'])result[table]=(await h.pg.query(`SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
   };
   for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
    const path='/api/reviewer/purchase-captures/'+order;
    for(const flag of [{},{requestCheck:false}]){
     const current=(await call(path)).data.item.channels.find(c=>c.channel===channel);
     assert.equal(current.capabilities.canSaveWithoutCheck,true);
     const body={channel,imageBase64:IMAGE.toString('base64'),mimeType:'image/png',requestKey:require('node:crypto').randomUUID(),expectedEvidenceHash:current.evidenceHash,...flag};
     const effects=await sideEffects(),notices=notifications.length,uploads=h.getUploaded();
     if(!Object.hasOwn(flag,'requestCheck')){
      const rejected=await call(path+'/supplements',{body});assert.equal(rejected.status,409);assert.equal(rejected.data.code,'CAPTURE_REFRESH_REQUIRED');
      const retry=await call(path+'/supplements',{body});assert.equal(retry.status,409);assert.equal(retry.data.code,'CAPTURE_REFRESH_REQUIRED');
      assert.equal(h.getUploaded(),uploads);assert.deepEqual(await sideEffects(),effects);assert.equal(notifications.length,notices);
      continue;
     }
     const saved=await call(path+'/supplements',{body});assert.equal(saved.status,200,JSON.stringify(saved.data));
     const view=saved.data.item.channels.find(c=>c.channel===channel);
     assert.equal(saved.data.request,null);assert.equal(view.reviewState,'not_requested');assert.equal(view.photos.length,current.photos.length+1);assert.equal(view.saveState,'saved');
     assert.deepEqual(h.files.get(view.photos.at(-1).fileId),IMAGE);
     const savedEffects=await sideEffects();assert.equal(savedEffects.purchase_capture_supplements.length,effects.purchase_capture_supplements.length+1);
     assert.deepEqual({...savedEffects,purchase_capture_supplements:effects.purchase_capture_supplements},effects);
     const replay=await call(path+'/supplements',{body});assert.equal(replay.status,200);assert.equal(replay.data.request,null);assert.equal(h.getUploaded(),uploads+1);
     assert.deepEqual(await sideEffects(),savedEffects);assert.equal(notifications.length,notices);
     for(const requestCheck of [true,false])if(!Object.hasOwn(flag,'requestCheck')||requestCheck!==flag.requestCheck){
      const conflict=await call(path+'/supplements',{body:{...body,requestCheck}});assert.equal(conflict.status,409);assert.equal(conflict.data.code,'CAPTURE_REQUEST_CONFLICT');
     }
     const absent={...body};delete absent.requestCheck;
     const conflict=await call(path+'/supplements',{body:absent});assert.equal(conflict.status,409);assert.equal(conflict.data.code,'CAPTURE_REQUEST_CONFLICT');
     assert.equal(h.getUploaded(),uploads+1);assert.deepEqual(await sideEffects(),savedEffects);assert.equal(notifications.length,notices);
    }
    const current=(await call(path)).data.item.channels.find(c=>c.channel===channel);
    const body={channel,imageBase64:IMAGE.toString('base64'),mimeType:'image/png',requestKey:require('node:crypto').randomUUID(),expectedEvidenceHash:current.evidenceHash,requestCheck:true};
    const effects=await sideEffects(),notices=notifications.length,uploads=h.getUploaded();
    for(const requestCheck of [null,'true','false',0,1,[],{}]){
     const invalid=await call(path+'/supplements',{body:{...body,requestCheck}});assert.equal(invalid.status,400);assert.equal(invalid.data.code,'CAPTURE_REQUEST_INVALID');
    }
    assert.equal(h.getUploaded(),uploads);assert.deepEqual(await sideEffects(),effects);assert.equal(notifications.length,notices);
    await assert.rejects(call(path+'/supplements',{body,loseResponse:true}),/fetch failed/);
    const recovered=await call(path+'/supplements',{body});assert.equal(recovered.status,200);assert.equal(recovered.data.request.status,'pending');
    const repeated=await call(path+'/supplements',{body});assert.equal(repeated.status,200);assert.equal(repeated.data.request.id,recovered.data.request.id);
    const after=await sideEffects();assert.equal(after.purchase_capture_check_requests.length,effects.purchase_capture_check_requests.length+1);assert.equal(after.cs_messages.length,effects.cs_messages.length+1);
    assert.equal(after.cs_threads.reduce((n,t)=>n+t.admin_unread_count,0),effects.cs_threads.reduce((n,t)=>n+t.admin_unread_count,0)+1);
    assert.equal(h.getUploaded(),uploads+1);assert.equal(notifications.length,notices+1);
   }
   assert.deepEqual((await h.pg.query('SELECT * FROM order_submissions ORDER BY id')).rows,before);
   assert.deepEqual((await h.pg.query('SELECT * FROM purchase_capture_artifacts ORDER BY id')).rows,artifactsBefore);
   assert.deepEqual((await h.pg.query('SELECT * FROM payment_batch_items')).rows,paidBefore);
   assert.deepEqual((await h.pg.query('SELECT * FROM review_submissions')).rows,reviewsBefore);
   assert.deepEqual((await h.pg.query('SELECT * FROM order_purchase_channels ORDER BY channel')).rows,channelsBefore);
   await h.pg.query("UPDATE order_submissions SET submitted_at=now()-interval '30 days' WHERE id=$1",[SINGLE]);
   const finalList=await call('/api/reviewer/purchase-captures');assert.equal(finalList.status,200);assert.equal(finalList.data.items.length,2,'Recent check results keep older orders visible');
   const foreign=issueReviewerSession({...session,ownerReviewerId:'22222222-2222-4222-8222-222222222222'});
   assert.equal((await call('/api/reviewer/purchase-captures/'+SINGLE,{token:foreign})).status,403);
   console.log('purchaseCaptureIntegration: actual production wrappers + JWT HTTP + core + checks + SQL; single/naver/coupang absent refresh gate, explicit false save-only, explicit opt-in, lost HTTP reply/retry, trusted messages, validation and original/artifact/channel/review/payment preservation passed');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 }finally{await h.pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
