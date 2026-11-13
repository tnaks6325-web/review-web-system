'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {fixture,OWNER,SINGLE,BUNDLE,IMAGE}=require('./helpers/purchaseCaptureIntegrationFixture');
const session={ownerReviewerId:OWNER,loginKind:'self',loginPhone8:'12345678'};
async function args(h,orderSubmissionId=SINGLE,channel='single',flag={}){
 const {item}=await h.core.getForReviewer({session,orderSubmissionId});
 return {session,orderSubmissionId,channel,imageBase64:IMAGE.toString('base64'),mimeType:'image/png',requestKey:randomUUID(),expectedEvidenceHash:item.channels.find(c=>c.channel===channel).evidenceHash,...flag};
}
async function state(h){
 const rows={};
 for(const table of ['purchase_capture_check_requests','cs_messages','cs_threads','order_submissions','purchase_capture_artifacts','order_purchase_channels','review_submissions','payment_batch_items'])rows[table]=(await h.pg.query(`SELECT * FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return rows;
}
test('explicit false saves verified photos without requests, messages, unread changes or SSE on every channel',async()=>{
 const h=await fixture(),notifications=[];
 const sse=require('../src/utils/sse'),old=sse.emitCsInquiry;sse.emitCsInquiry=n=>notifications.push(n);
 try{
  const before=await state(h);
  for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
   for(const flag of [{requestCheck:false}]){
    const input=await args(h,order,channel,flag),count=h.getUploaded();
    const result=await h.core.addSupplement(input),view=result.item.channels.find(c=>c.channel===channel);
    assert.equal(result.request,null);assert.equal(view.request,null);assert.equal(view.reviewState,'not_requested');
    assert.equal(view.saveState,'saved');assert.equal(view.capabilities.canSaveWithoutCheck,true);
    assert.equal(h.getUploaded(),count+1);assert.deepEqual(h.files.get(view.photos.at(-1).fileId),IMAGE);
    const replay=await h.core.addSupplement(input);assert.equal(replay.request,null);assert.equal(replay.created,false);assert.equal(h.getUploaded(),count+1);
   }
  }
  assert.equal((await h.pg.query('SELECT count(*)::int n FROM purchase_capture_supplements WHERE check_request_id IS NULL')).rows[0].n,3);
  assert.deepEqual(await state(h),before);assert.deepEqual(notifications,[]);
 }finally{sse.emitCsInquiry=old;await h.pg.close();}
});

test('new absent-flag uploads require refresh without any upload, storage or notification on every channel',async()=>{
 const h=await fixture(),notifications=[];
 const sse=require('../src/utils/sse'),old=sse.emitCsInquiry;sse.emitCsInquiry=n=>notifications.push(n);
 try{
  for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
   const input=await args(h,order,channel),before=await state(h),supplements=(await h.pg.query('SELECT * FROM purchase_capture_supplements')).rows,uploads=h.getUploaded();
   for(let retry=0;retry<2;retry++)await assert.rejects(h.core.addSupplement(input),e=>e.status===409&&e.code==='CAPTURE_REFRESH_REQUIRED');
   await assert.rejects(h.core.addSupplement({...input,session:{...session,ownerReviewerId:'22222222-2222-4222-8222-222222222222'}}),e=>e.status===403);
   assert.equal(h.getUploaded(),uploads);assert.deepEqual(await state(h),before);
   assert.deepEqual((await h.pg.query('SELECT * FROM purchase_capture_supplements')).rows,supplements);assert.deepEqual(notifications,[]);
  }
 }finally{sse.emitCsInquiry=old;await h.pg.close();}
});

test('request keys bind explicit opt-in and reject flag changes before the legacy refresh gate',async()=>{
 const h=await fixture();try{
  for(const flag of [{requestCheck:false},{requestCheck:true}]){
   const input=await args(h,SINGLE,'single',flag);await h.core.addSupplement(input);
   const expectedPayload=[input.imageBase64,input.mimeType,input.expectedEvidenceHash];
   if(Object.hasOwn(flag,'requestCheck'))expectedPayload.push(flag.requestCheck);
   const stored=(await h.pg.query('SELECT request_payload_hash FROM purchase_capture_supplements WHERE request_key=$1',[input.requestKey])).rows[0];
   assert.equal(stored.request_payload_hash,createHash('sha256').update(JSON.stringify(expectedPayload)).digest('hex'));
   const before=await state(h),uploads=h.getUploaded();
   for(const other of [{},{requestCheck:false},{requestCheck:true}]){
    if(JSON.stringify(other)===JSON.stringify(flag))continue;
    const changed={...input};delete changed.requestCheck;Object.assign(changed,other);
    await assert.rejects(h.core.addSupplement(changed),e=>e.code==='CAPTURE_REQUEST_CONFLICT'&&e.status===409);
   }
   assert.equal(h.getUploaded(),uploads);assert.deepEqual(await state(h),before);
  }
 }finally{await h.pg.close();}
});

test('supplied nonboolean flags are rejected before SQL, upload or writes',async()=>{
 const h=await fixture();try{
  const input=await args(h),before=await state(h);let touched=0;
  const deny=()=>{touched++;throw new Error('must validate before IO');};
  const core=require('../src/services/purchaseCaptureSelfService.service').createService({db:{query:deny,connect:deny},drive:{upload:deny,read:deny}});
  for(const requestCheck of [undefined,null,'true','false',0,1,[],{},new Boolean(false)]){
   await assert.rejects(core.addSupplement({...input,requestCheck}),e=>e.code==='CAPTURE_REQUEST_INVALID'&&e.status===400);
  }
  assert.equal(touched,0);assert.equal(h.getUploaded(),0);assert.deepEqual(await state(h),before);
 }finally{await h.pg.close();}
});

// Preservation contracts: existing transaction/replay behavior must stay green.
test('save-only retries stay request-free after newer photos, manual requests and closed work',async()=>{
 const h=await fixture();try{
  for(const [order,channel]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']]){
   const input=await args(h,order,channel,{requestCheck:false});await h.core.addSupplement(input);
   const newer=await h.core.addSupplement(await args(h,order,channel,{requestCheck:false}));
   const checked=await h.checks.requestCheck({session,orderSubmissionId:order,channel,expectedEvidenceHash:newer.item.channels.find(c=>c.channel===channel).evidenceHash,source:'original',note:'나중에 직접 요청'});
   assert.equal((await h.pg.query("SELECT content FROM cs_messages WHERE meta->'purchaseCaptureCheck'->>'requestId'=$1",[checked.request.id])).rows[0].content,'추가사진을 제출하고 확인을 요청했어요.\n나중에 직접 요청');
   const before=await state(h),uploads=h.getUploaded();
   const replay=await h.core.addSupplement(input);
   assert.equal(replay.request,null);assert.equal(replay.created,false);
   assert.equal(replay.item.channels.find(c=>c.channel===channel).request.id,checked.request.id,'Current view may show a later manual request; upload replay must not claim it');
   assert.equal(h.getUploaded(),uploads);assert.deepEqual(await state(h),before);
   await assert.rejects(h.core.addSupplement({...input,session:{...session,ownerReviewerId:'22222222-2222-4222-8222-222222222222'}}),e=>e.status===403);
   await h.pg.query('UPDATE tab_configs SET is_closed=true');
   const closed=await h.core.addSupplement(input);assert.equal(closed.request,null);assert.equal(closed.created,false);
   assert.equal(closed.item.channels.find(c=>c.channel===channel).capabilities.canSaveWithoutCheck,true);
   assert.equal(closed.item.channels.find(c=>c.channel===channel).capabilities.canAdd,false);
   await h.pg.query('UPDATE tab_configs SET is_closed=false');
  }
 }finally{await h.pg.close();}
});

test('explicit true creates exactly one request, message, unread increase and notification per channel',async()=>{
 const h=await fixture(),notifications=[];
 const sse=require('../src/utils/sse'),old=sse.emitCsInquiry;sse.emitCsInquiry=n=>notifications.push(n);
 try{
  const before=await state(h);
  for(const [i,[order,channel]]of [[SINGLE,'single'],[BUNDLE,'naver'],[BUNDLE,'coupang']].entries()){
   const input=await args(h,order,channel,{requestCheck:true}),first=await h.core.addSupplement(input),uploads=h.getUploaded();
   const replay=await h.core.addSupplement(input);
   assert.equal(first.created,true);assert.equal(replay.created,false);assert.equal(replay.request.id,first.request.id);assert.equal(h.getUploaded(),uploads);
   const row=(await h.pg.query('SELECT check_request_id FROM purchase_capture_supplements WHERE request_key=$1',[input.requestKey])).rows[0];assert.equal(row.check_request_id,first.request.id);
   assert.equal((await h.pg.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n,i+1);
   assert.equal((await h.pg.query('SELECT count(*)::int n FROM cs_messages')).rows[0].n,i+1);
   assert.equal((await h.pg.query('SELECT sum(admin_unread_count)::int n FROM cs_threads')).rows[0].n,i+1);
   assert.equal(notifications.length,i+1);
  }
  const after=await state(h);for(const table of ['order_submissions','purchase_capture_artifacts','order_purchase_channels','review_submissions','payment_batch_items'])assert.deepEqual(after[table],before[table]);
 }finally{sse.emitCsInquiry=old;await h.pg.close();}
});

test('legacy committed checked upload replays absent-field digest and never rewrites stored messages',async()=>{
 const h=await fixture();try{
  const input=await args(h,SINGLE,'single',{requestCheck:true}),first=await h.core.addSupplement(input);
  delete input.requestCheck;
  const legacyHash=createHash('sha256').update(JSON.stringify([input.imageBase64,input.mimeType,input.expectedEvidenceHash])).digest('hex');
  await h.pg.query('UPDATE purchase_capture_supplements SET request_payload_hash=$2 WHERE request_key=$1',[input.requestKey,legacyHash]);
  await h.pg.query("UPDATE cs_messages SET content='구매 사진 확인을 요청했습니다.' WHERE meta->'purchaseCaptureCheck'->>'requestId'=$1",[first.request.id]);
  await h.core.addSupplement(await args(h,SINGLE,'single',{requestCheck:false}));
  const before=await state(h),uploads=h.getUploaded();
  const replay=await h.core.addSupplement(input);assert.equal(replay.request.id,first.request.id);assert.equal(replay.created,false);
  assert.equal(h.getUploaded(),uploads);assert.deepEqual(await state(h),before);
 }finally{await h.pg.close();}
});

test('save-only lost COMMIT acknowledgement replays the committed null request without another upload',async()=>{
 const h=await fixture();try{
  const input=await args(h,SINGLE,'single',{requestCheck:false}),before=await state(h);let inserted=false,lost=false;
  const db={query:h.db.query,connect:async()=>{
   const client=await h.db.connect();return {release:()=>client.release(),query:async(sql,params)=>{
    const result=await client.query(sql,params);
    if(sql.startsWith('INSERT INTO purchase_capture_supplements'))inserted=true;
    if(sql==='COMMIT'&&inserted&&!lost){lost=true;throw new Error('commit acknowledgement lost');}
    return result;
   }};
  }};
  const core=require('../src/services/purchaseCaptureSelfService.service').createService({db,drive:{upload:h.fakeUpload,read:async id=>h.files.get(id)}});
  await assert.rejects(core.addSupplement(input),e=>e.code==='CAPTURE_UNAVAILABLE'&&e.status===503);
  assert.equal(lost,true);assert.equal(h.getUploaded(),1);
  const replay=await core.addSupplement(input);assert.equal(replay.request,null);assert.equal(replay.created,false);assert.equal(h.getUploaded(),1);
  assert.equal((await h.pg.query('SELECT count(*)::int n FROM purchase_capture_supplements WHERE check_request_id IS NULL')).rows[0].n,1);
  assert.deepEqual(await state(h),before);
 }finally{await h.pg.close();}
});
