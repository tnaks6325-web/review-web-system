'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = path.resolve(__dirname, '../../frontend/js/dual-channel-purchase.js');
const vm = require('node:vm');
function frontendFunction(file,name,globals={}) {
  const source=fs.readFileSync(path.resolve(__dirname,'../../frontend',file),'utf8');
  const start=source.indexOf('function '+name+'(');
  assert.notEqual(start,-1,name+' missing');
  let end=source.indexOf('\n}',start)+2;
  return vm.runInNewContext('('+source.slice(start,end)+')',globals);
}
test('real reviewer slot entry consumes snapshot roles without changing legacy slots',()=>{
  const fn=frontendFunction('js/search-app.js','_dualSlotsForItem');
  const legacy=[{key:'slot2',label:'현영'}]; assert.equal(fn({captureSlots:legacy}),legacy);
  assert.throws(()=>fn({purchaseConditionSnapshot:{channels:{}},captureSlots:legacy}),/새로고침/);
  const slots=[{key:'review',channel:'naver',role:'review'},{key:'slot2',channel:'coupang',role:'review'},{key:'receipt',role:'receipt',required:false},{key:'receipt2',role:'receipt',required:false}];
  assert.equal(fn({purchaseConditionSnapshot:{},captureSlots:slots}),slots);
});
test('staff preview stays one parent with channel amounts and explicit verification actions',()=>{
 const fn=frontendFunction('workdesk.html','_dualPurchasePanel',{esc:String,_isInternalRole:()=>true,_rvUrl:x=>'/fake/'+x});
 assert.equal(fn({}), '');
 const html=fn({id:'row',dualPurchase:{orderSubmissionId:'parent',revision:1,bundleHash:'hash',identityResult:'uncertain',purchases:{naver:{paidAmount:9000},coupang:{paidAmount:10000}},artifacts:[{id:'a',channel:'naver',role:'primary',fileId:'n',revision:1},{id:'b',channel:'coupang',role:'primary',fileId:'c',revision:1},{id:'ns',channel:'naver',role:'supplement',fileId:'ns-file',revision:1,primaryArtifactId:'a',primaryRevision:1}]}});
 assert.match(html,/19,000/); assert.match(html,/9,000/); assert.match(html,/10,000/); assert.match(html,/배송지 확인 완료/); assert.match(html,/금액 정정/);
 assert.match(html,/<a[^>]+href="\/fake\/ns-file"[^>]*>보충캡처<\/a>/);
});
function purchaseFixture(options={}) {
 const calls=[]; let failRole='';
 const request=async(url,body)=>{calls.push({url,body:structuredClone(body)});if(options.onRequest)options.onRequest(url,body);
  if(url.endsWith('/extract'))return {ok:true,extractToken:'legacy-'+body.channel,extractionToken:'bound-'+body.channel,extracted:body.role==='supplement'?{deliveryMemo:'보충 메모'}:{recipient:'시험명',phone:'01000000000',address:'시험시 시험로 1'}};
  if(url.includes('order-identity-match'))return {ok:true,status:'MATCH',approvalToken:'identity-'+body.channel};
  if(url.endsWith('/artifacts')){if(failRole===body.role)throw Error('시험 사진 저장 실패');return {ok:true,artifact:{id:body.channel+'-'+body.role+'-'+body.revision,channel:body.channel,role:body.role,revision:body.revision,...(body.role==='supplement'?{primaryArtifactId:body.primaryArtifactId,primaryRevision:body.primaryRevision}:{})}};}
  if(url.endsWith('/approve'))return {ok:true,bundleApprovalToken:'bundle'};
  return {ok:true,orderSubmissionId:'parent'};
 };
 const c=require(helper).createController({campaignId:'campaign',campaignApplicationId:11,campaignHoldToken:'hold'},request,options);
 const values={orderNum:'order',userId:'id',recipient:'시험명',phone:'01000000000',address:'시험시 시험로 1',paidAmount:9000};
 c.setValues('naver',values);c.setValues('coupang',{...values,userId:'different',paidAmount:10000});c.setBank({bank:'시험은행',account:'000000',depositor:'시험명'});
 return {c,calls,fail:role=>{failRole=role;}};
}
test('supplement is optional, stays bound to its own primary and never supplies identity approval',async()=>{
 const {c,calls,fail}=purchaseFixture();
 await assert.rejects(c.setSupplementImage('naver',{imageBase64:'NN',mimeType:'image/png'}),/첫.*사진/);
 for(const ch of ['naver','coupang']){await c.setImage(ch,{imageBase64:ch,mimeType:'image/png'});await c.stage(ch);}
 await c.setSupplementImage('naver',{imageBase64:'supplement',mimeType:'image/png'});
 fail('supplement');await assert.rejects(c.stageSupplement('naver'),/저장 실패/);
 assert.equal(c.state.purchases.naver.primaryArtifactId,'naver-primary-1');
 await assert.rejects(c.submit(),/보충사진/); // selected-but-failed supplement cannot silently disappear
 fail('');await c.stageSupplement('naver');await c.submit();
 const s=calls.find(x=>x.url.endsWith('/artifacts')&&x.body.role==='supplement').body;
 assert.equal(s.channel,'naver');assert.equal(s.primaryArtifactId,'naver-primary-1');assert.equal(s.primaryRevision,1);assert.equal(s.identityApprovalToken,'identity-naver');
 assert.equal(calls.filter(x=>x.url.includes('order-identity-match')).length,2);
 const final=calls.find(x=>x.url==='/api/submit/order').body;
 assert.equal(final.purchases.naver.supplementArtifactId,'naver-supplement-1');assert.equal(final.purchases.coupang.supplementArtifactId,undefined);assert.equal(final.capture_file_id_2,undefined);
 c.setValues('naver',{...c.state.purchases.naver,orderNum:'changed'});
 assert.equal(c.state.purchases.naver.primaryArtifactId,undefined);assert.equal(c.state.purchases.naver.supplementArtifactId,undefined);assert.equal(c.state.channels.naver.approvalToken,'');
 await assert.rejects(c.submit(),/두 구매처/);
});
function serverDraft(overrides={}) {return {version:1,campaignApplicationId:11,conditionFingerprint:'conditions-1',identityFingerprint:'identity-1',artifacts:[],committedOrderSubmissionId:null,...overrides};}
test('reopen restores only inputs, requires fresh server refs and invalidates changed conditions or identity',async()=>{
 const f=purchaseFixture();const {c}=f;
 for(const ch of ['naver','coupang']){await c.setImage(ch,{imageBase64:ch,mimeType:'image/png'});await c.stage(ch);}
 const draft=c.exportDraft();const json=JSON.stringify(draft);
 assert.doesNotMatch(json,/approvalToken|ArtifactId|imageBase64|hold|extractionToken/);
 const next=purchaseFixture({requireServerState:true});
 assert.equal(next.c.restoreDraft({...draft,bundleApprovalToken:'forged',completed:true,purchases:{naver:{primaryArtifactId:'forged'}}}),true);
 assert.equal(next.c.state.purchases.naver.orderNum,'order');assert.equal(next.c.state.bundleApprovalToken,'');assert.equal(next.c.state.purchases.naver.primaryArtifactId,undefined);
 await next.c.setImage('naver',{imageBase64:'new',mimeType:'image/png'});
 await assert.rejects(next.c.stage('naver'),/現在|현재.*사진|준비 중/);assert.equal(next.calls.length,0);
 const refs=[{id:'stored-n',channel:'naver',role:'primary',revision:3}];next.c.updateServerState(serverDraft({artifacts:refs}));
 await next.c.stage('naver');const upload=next.calls.find(x=>x.url.endsWith('/artifacts')).body;
 assert.equal(upload.expectedArtifactId,'stored-n');assert.equal(upload.revision,4);
 for(const key of ['conditionFingerprint','identityFingerprint']){
  next.c.updateServerState(serverDraft({artifacts:[{id:'naver-primary-4',channel:'naver',role:'primary',revision:4}],[key]:'changed'}));
  assert.equal(next.c.state.channels.naver.approvalToken,'');assert.equal(next.c.state.purchases.naver.primaryArtifactId,undefined);assert.equal(next.c.state.purchases.naver.orderNum,'order');
  await assert.rejects(next.c.submit(),/두 구매처/);
 }
 next.c.updateServerState(serverDraft({committedOrderSubmissionId:'existing-parent'}));
 await assert.rejects(next.c.stage('naver'),/이미 접수/);
 assert.equal(next.c.restoreDraft({...draft,campaignApplicationId:99}),false);
});
test('expired server proof invalidates approval without losing typed values or photos',async()=>{
 let stale=true;
 const {c,calls}=purchaseFixture({onRequest:url=>{if(url==='/api/submit/order'&&stale)throw Object.assign(Error('승인이 만료됐습니다.'),{status:409,code:'DUAL_PROOF_INVALID'});}});
 for(const ch of ['naver','coupang']){await c.setImage(ch,{imageBase64:ch,mimeType:'image/png'});await c.stage(ch);}
 await assert.rejects(c.submit(),/만료/);
 assert.equal(c.state.bundleApprovalToken,'');assert.equal(c.state.channels.naver.approvalToken,'');assert.equal(c.state.channels.naver.image.imageBase64,'naver');assert.equal(c.state.purchases.naver.orderNum,'order');
 stale=false;await assert.rejects(c.submit(),/두 구매처/);
 for(const ch of ['naver','coupang'])await c.stage(ch);
 await c.submit();assert.equal(calls.filter(x=>x.url.endsWith('/approve')).length,2);
});
test('ordinary and existing NC final payload bytes equal untouched HEAD through real submit function',async()=>{
 const cp=require('node:child_process');
 const baseline=cp.execFileSync('git',['show','HEAD:frontend/js/search-app.js'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'});
 const current=fs.readFileSync(path.resolve(__dirname,'../../frontend/js/search-app.js'),'utf8');
 async function collect(source,nc){
  const start=source.indexOf('async function submitOrderForm('),end=source.indexOf('\n}',start)+2;
  const ids=nc?['of','oc2']:['of'],nodes={},payloads=[];let done;
  const captured=new Promise(r=>done=r);
  for(const [i,cid]of ids.entries())for(const [k,v]of Object.entries({orderer:'시험명',userId:'id-'+i,recipient:'시험명',phone:'01000000000',address:'시험시 시험로 '+(i+1),price:i?'10000':'9000',orderNumber:'order-'+i,memo:'memo-'+i,bank:'시험은행',account:'000000',depositor:'시험명',imgThumb:''}))nodes[cid+'_'+k]={value:v,src:k==='imgThumb'?'data:image/png;base64,ZmFrZQ==':'',style:{}};
  const state=Object.fromEntries(ids.map(cid=>[cid,{extracted:{recipient:'사진명',phone:'01000000000',address:'사진주소',price:'9000'},deliveryMemoToken:'memo-primary',img2:{dataUrl:'data:image/png;base64,c2Vjb25k',mime:'image/png',memoToken:'memo-second',capture2Token:'capture-second'}}]));
  const FixedDate=class extends Date {constructor(...args){super(...(args.length?args:['2026-11-06T00:00:00Z']));}};
  const g={Date:FixedDate,console:{log(){},warn(){},error(){}},setTimeout,URLSearchParams,location:{search:''},_dualPurchaseController:null,_dualPurchaseLoading:false,_PREVIEW_MODE:false,_EMBED_CTX:nc?null:{campId:'campaign',app:11,holdToken:'hold',holdPhone8:'00000000'},_BATCH:null,_activeIdentityContext:null,_orderCardIds:ids,_cardAiState:state,_selectedOptKey:'상품',_reviewerSelectedOptions:null,_OFP:{pick:{},capName:{of:'상품',oc2:'상품'},capOpt:{}},document:{getElementById:id=>nodes[id]||null,querySelector:()=>null},window:{_ncMode:nc,_ncVerifyPassed:true,_slotAuth:{name:'로그인명',phone8:'00000000'},_orderFormCtx:{sheetId:'sheet',tabName:'tab',gid:'0'}},_popularGateBeforeSubmit:async()=>true,_optionFullBeforeSubmit:async()=>true,_syncAllSharedBeforeSubmit(){},_batchIdentityGuard:()=>true,_ordererPickerOn:()=>true,_ofpActive:()=>false,_validateIncomeInput:()=>true,_prepareIdentityApprovals:async orders=>{orders.forEach(o=>o.identityApprovalToken='approved');return true;},_runIdentityPrecheck:async()=>true,
   gasPost:async p=>{if(p.action==='findSlot')return {ok:true,mode:'append'};payloads.push(JSON.stringify(p));if(payloads.length===ids.length){done();return new Promise(()=>{});}return {ok:true,alreadySubmitted:true};}};
  vm.runInNewContext('('+source.slice(start,end)+')',g)();await captured;return payloads;
 }
 for(const nc of [false,true])assert.deepEqual(await collect(current,nc),await collect(baseline,nc));
});
test('two current primary artifacts and approvals submit one command; failure preserves state', async () => {
  assert.ok(fs.existsSync(helper), 'dedicated purchase controller is missing');
  const { createController } = require(helper);
  const calls = []; let fail = true;
  const request = async (url, body) => { calls.push({url,body});
    if (url.endsWith('/extract')) return {ok:true,extractToken:'extract-'+body.channel,extractionToken:'bound-'+body.channel,extracted:{recipient:'시험명',phone:'01000000000',address:'시험시 시험로 1'}};
    if (url.endsWith('order-identity-match')) return {ok:true,status:'MATCH',approvalToken:'identity-'+body.channel};
    if (url.endsWith('/artifacts')) return {ok:true,artifact:{id:'artifact-'+body.channel,revision:1}};
    if (url.endsWith('/approve')) return {ok:true,bundleApprovalToken:'bundle'};
    if (fail) throw Error('저장 실패');
    return {ok:true,orderSubmissionId:'one-parent'};
  };
  const c = createController({campaignApplicationId:11,campaignHoldToken:'hold'},request);
  const values = {orderNum:'order',userId:'id',recipient:'시험명',phone:'01000000000',address:'시험시 시험로 1',paidAmount:9000};
  c.setValues('naver',values); c.setValues('coupang',{...values,userId:'different',paidAmount:10000}); c.setBank({bank:'시험은행',account:'000000',depositor:'시험명'});
  await assert.rejects(c.submit(),/두 구매처/); assert.equal(calls.length,0);
  await c.setImage('naver',{imageBase64:'AAA',mimeType:'image/png'}); await c.stage('naver');
  const staged=calls.find(x=>x.url.endsWith('/artifacts')).body;
  assert.equal(staged.extractionToken,'bound-naver');
  assert.equal(staged.revision,1);
  assert.equal(staged.purchase.userId,'id');
  assert.equal(staged.extracted.recipient,'시험명');
  assert.equal(staged.imageBase64,calls.find(x=>x.url.endsWith('/extract')).body.imageBase64);
  assert.equal(staged.mimeType,'image/png');
  await assert.rejects(c.submit(),/두 구매처/);
  await c.setImage('coupang',{imageBase64:'BBB',mimeType:'image/png'}); await c.stage('coupang');
  await assert.rejects(c.submit(),/저장 실패/); assert.equal(c.state.purchases.naver.primaryArtifactId,'artifact-naver');
  fail=false; await Promise.all([c.submit(),c.submit()]);
  assert.equal(calls.filter(x=>x.url==='/api/submit/order').length,2); // one failed attempt, one retry
  const body=calls.filter(x=>x.url==='/api/submit/order').at(-1).body;
  assert.equal(body.purchases.coupang.userId,'different'); assert.equal(body.bundleApprovalToken,'bundle');
  assert.equal(body.allowDualChannels,undefined);
  await c.setImage('naver',{imageBase64:'CCC',mimeType:'image/png'});
  assert.equal(c.state.bundleApprovalToken,''); assert.equal(c.state.purchases.naver.primaryArtifactId,undefined);
  const other=createController({campaignApplicationId:12,campaignHoldToken:'other'},request);
  assert.equal(other.state.channels.naver.approvalToken,undefined);
});
