'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const file=path.resolve(__dirname,'../src/routes/purchaseCapture.routes.js');
assert(fs.existsSync(file),'Authenticated self-service purchase capture routes have not been implemented');
const express=require('express');const jwt=require('jsonwebtoken');
const {createPurchaseCaptureRouters}=require(file);
process.env.JWT_SECRET='fictional-capture-router-test-secret-not-a-real-credential';
const {issueReviewerSession}=require('../src/services/reviewerSession.service');
const order='11111111-1111-4111-8111-111111111111',request='22222222-2222-4222-8222-222222222222';
const hash='a'.repeat(64),calls=[];
const item={orderSubmissionId:order,displayName:'가상 주문',participantName:'예시',channels:[]};
function record(method,value){return async input=>{calls.push({method,input});return value;};}
const core={listForReviewer:record('list',{items:[item],hasMore:false}),getForReviewer:record('get',item),addSupplement:record('add',{item,request:{id:request,status:'pending'},internalSecret:'never expose'})};
const checks={requestCheck:record('request',{item,request:{id:request,status:'pending'},created:true,internalSecret:'never expose'}),getForStaff:record('staff-get',{item,request:{id:request,status:'pending'}}),decideForStaff:record('decide',{item,request:{id:request,status:'confirmed'},internalSecret:'never expose'})};
const app=express();app.use(express.json({limit:'15mb'}));const routes=createPurchaseCaptureRouters({core,checks,uploadLimiter:(_q,_s,next)=>next()});app.use('/api/reviewer',routes.reviewerRouter);app.use('/api/trackb',routes.staffRouter);
const reviewer=issueReviewerSession({ownerReviewerId:'33333333-3333-4333-8333-333333333333',loginName:'가상 명의',loginPhone8:'12345678'});
const staff=(role,via)=>jwt.sign({name:'가상 담당자',role,...(via?{via}:{})},process.env.JWT_SECRET,{expiresIn:'5m'});
(async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;let passed=0;
 async function call(route,{token,method='GET',body,reviewerToken=false}={}){const headers={};if(token)headers[reviewerToken?'X-Reviewer-Token':'Authorization']=reviewerToken?token:'Bearer '+token;if(body){headers['Content-Type']='application/json';}const r=await fetch(base+route,{method,headers,body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};}
 try{
  let r=await call('/api/reviewer/purchase-captures');assert.equal(r.status,401);assert.equal(calls.length,0);passed++;
  r=await call('/api/reviewer/purchase-captures',{token:staff('admin'),reviewerToken:true});assert.equal(r.status,401);assert.equal(calls.length,0);passed++;
  r=await call('/api/reviewer/purchase-captures',{token:reviewer,reviewerToken:true});assert.equal(r.status,200);assert.equal(r.cache,'no-store');assert.equal(r.body.items[0].orderSubmissionId,order);assert.equal(calls.at(-1).input.session.loginPhone8,'12345678');passed++;
  r=await call('/api/reviewer/purchase-captures/'+order,{token:reviewer,reviewerToken:true});assert.equal(r.status,200);assert.equal(r.body.item.orderSubmissionId,order);passed++;
  let before=calls.length;r=await call('/api/reviewer/purchase-captures/not-a-uuid',{token:reviewer,reviewerToken:true});assert.equal(r.status,400);assert.equal(calls.length,before);passed++;
  r=await call('/api/reviewer/purchase-captures/'+order+'/supplements',{token:reviewer,reviewerToken:true,method:'POST',body:{channel:'single',imageBase64:'fixture',mimeType:'image/png',requestKey:request,expectedEvidenceHash:hash,session:{ownerReviewerId:'attacker'},actor:{role:'master'},folderId:'attacker-folder'}});assert.equal(r.status,200);assert(!JSON.stringify(r.body).includes('never expose'));assert.equal(calls.at(-1).input.session.ownerReviewerId,'33333333-3333-4333-8333-333333333333');assert.equal(calls.at(-1).input.actor,undefined);assert.equal(calls.at(-1).input.folderId,undefined);passed++;
  r=await call('/api/reviewer/purchase-captures/'+order+'/check-requests',{token:reviewer,reviewerToken:true,method:'POST',body:{channel:'single',expectedEvidenceHash:hash,note:'이미 냈어요'}});assert.equal(r.status,200);assert.equal(r.body.created,true);assert(!JSON.stringify(r.body).includes('never expose'));passed++;
  for(const role of ['advertiser']){before=calls.length;r=await call('/api/trackb/purchase-capture-checks/'+request,{token:staff(role)});assert.equal(r.status,403);assert.equal(calls.length,before);passed++;}
  before=calls.length;r=await call('/api/trackb/purchase-capture-checks/'+request,{token:reviewer});assert.equal(r.status,401);assert.equal(calls.length,before);passed++;
  for(const role of ['staff','admin','master']){r=await call('/api/trackb/purchase-capture-checks/'+request,{token:staff(role)});assert.equal(r.status,200);assert.equal(calls.at(-1).input.actor.role,role);passed++;}
  r=await call('/api/trackb/purchase-capture-checks/'+request+'/decision',{token:staff('staff'),method:'POST',body:{decision:'confirmed',expectedEvidenceHash:hash,note:'사진 확인',actor:{role:'advertiser'},session:{ownerReviewerId:'attacker'}}});assert.equal(r.status,200);assert.equal(calls.at(-1).input.actor.role,'staff');assert.equal(calls.at(-1).input.session,undefined);assert(!JSON.stringify(r.body).includes('never expose'));passed++;
  before=calls.length;r=await call('/api/trackb/purchase-capture-checks/'+request+'/decision',{token:staff('staff'),method:'POST',body:[]});assert.equal(r.status,400);assert.equal(calls.length,before);passed++;
  const original=core.getForReviewer;core.getForReviewer=async()=>{throw Object.assign(new Error('internal SQL and token must stay private'),{code:'XX_TEST'});};r=await call('/api/reviewer/purchase-captures/'+order,{token:reviewer,reviewerToken:true});assert.equal(r.status,500);assert(!JSON.stringify(r.body).includes('internal SQL'));core.getForReviewer=original;passed++;
  for(const via of ['intranet','reviewer_campaign'])for(const role of ['staff','admin','master','advertiser'])for(const method of ['GET','POST']){
   const before=calls.length,url='/api/trackb/purchase-capture-checks/'+request+(method==='POST'?'/decision':'');
   const r=await call(url,{token:staff(role,via),method,...(method==='POST'?{body:{decision:'confirmed',expectedEvidenceHash:hash,note:'SSO 시험'}}:{})});
   const allowed=via==='intranet'&&role!=='advertiser';assert.equal(r.status,allowed?200:403);
   assert.equal(calls.length,before+(allowed?1:0));if(allowed){assert.equal(calls.at(-1).input.actor.via,via);assert.equal(calls.at(-1).input.actor.role,role);}passed++;
  }
  console.log(`purchaseCaptureHttp: ${passed} passed`);
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
