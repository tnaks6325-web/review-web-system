'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,OWNER,SINGLE,BUNDLE,IMAGE}=require('./helpers/purchaseCaptureIntegrationFixture');
const {startNativeCaptureDatabase,addDeletionSchema,gate,tracedPool,waitUntilBlocked}=require('./helpers/captureNativePgFixture');
const session={ownerReviewerId:OWNER,loginKind:'self',loginPhone8:'12345678',loginName:'시험 리뷰어'};
const enabled=process.env.CAPTURE_NATIVE_PG_TEST==='1';
async function uploadArgs(h,id,channel){const {item}=await h.core.getForReviewer({session,orderSubmissionId:id});return {session,orderSubmissionId:id,channel,imageBase64:IMAGE.toString('base64'),mimeType:'image/png',requestCheck:true,requestKey:require('node:crypto').randomUUID(),expectedEvidenceHash:item.channels.find(c=>c.channel===channel).evidenceHash};}
function coreWith(h,pool,extras={}){return require('../src/services/purchaseCaptureSelfService.service').createService({db:pool,drive:{upload:h.fakeUpload,read:async id=>h.files.get(id)},requestInTx:(...a)=>h.checks.requestInTx(...a),...extras});}
const reached=(checkpoint,operation)=>Promise.race([checkpoint.promise,operation.then(()=>{throw new Error('Service completed before reaching the intended concurrency checkpoint');})]);
const tombSql=sql=>sql.includes('INSERT INTO orphan_capture_tombstones')&&sql.includes('purchase_capture_supplements');
async function savedReference(h,file){return (await h.db.query('SELECT count(*)::int n FROM orphan_capture_tombstones WHERE file_id=$1',[file])).rows[0].n;}
async function uploadFirst(h,id,channel,tab,pool){
 const held=gate(),release=gate(),deletionConnected=gate();
 const core=coreWith(h,pool,{requestInTx:async(client,args)=>{const out=await h.checks.requestInTx(client,args);held.resolve(client.processID);await release.promise;return out;}});
 const args=await uploadArgs(h,id,channel);let add,del;
 try{
  add=core.addSupplement(args);add.catch(()=>{});const writerPid=await reached(held,add);
  del=require('../src/services/workTabDelete.service').deleteTask({sheetId:'local-sheet',tabName:tab,confirm:true,pool:tracedPool(pool,{connected:pid=>deletionConnected.resolve(pid)}),notifyIntranet:false});del.catch(()=>{});
  const deletionPid=await deletionConnected.promise;await waitUntilBlocked(pool,deletionPid,writerPid);
  release.resolve();const [added,deleted]=await Promise.all([add,del]);assert.equal(deleted.ok,true);
  const file=added.item.channels.find(c=>c.channel===channel).photos.find(p=>p.isSupplement).fileId;
  assert.equal(await savedReference(h,file),1,'An actually committed supplement must be snapshotted after the writer finishes, before deletion cascades it');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_supplements WHERE order_submission_id=$1',[id])).rows[0].n,0);
  assert.equal(h.files.has(file),true,'No Drive deletion authorized by this test');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cs_messages')).rows[0].n,1,'Existing inquiry message survives order cascade');
  return {direction:'upload-first',channel,referencePreserved:true,actualLockWait:true};
 }finally{release.resolve();await Promise.allSettled([add,del].filter(Boolean));}
}
async function deletionFirst(h,id,channel,tab,pool){
 const paused=gate(),release=gate(),uploadConnected=gate();let deletingPid,add,del;
 const deleting=tracedPool(pool,{connected:pid=>{deletingPid=pid;},before:async sql=>{if(tombSql(sql)){paused.resolve();await release.promise;}}});
 const core=coreWith(h,tracedPool(pool,{connected:pid=>uploadConnected.resolve(pid)}));const args=await uploadArgs(h,id,channel);
 try{
  del=require('../src/services/workTabDelete.service').deleteTask({sheetId:'local-sheet',tabName:tab,confirm:true,pool:deleting,notifyIntranet:false});del.catch(()=>{});await reached(paused,del);
  add=core.addSupplement(args);add.catch(()=>{});const writerPid=await uploadConnected.promise;
  await waitUntilBlocked(pool,writerPid,deletingPid);release.resolve();const deleted=await del;assert.equal(deleted.ok,true);
  await assert.rejects(add,e=>[404,409,503].includes(e.status),'A deleted order must never report a newly saved supplement');
  assert.equal(h.getUploaded(),0,'Deleted-first order cannot start a new Drive upload');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,0);
  return {direction:'delete-first',channel,uploadRejected:true,actualLockWait:true};
 }finally{release.resolve();await Promise.allSettled([add,del].filter(Boolean));}
}
async function lateDrive(h,id,channel,tab,pool){
 const started=gate(),release=gate();let add;
 const core=coreWith(h,pool,{drive:{upload:async bytes=>{started.resolve();await release.promise;return h.fakeUpload(bytes);},read:async file=>h.files.get(file)}});
 try{
  add=core.addSupplement(await uploadArgs(h,id,channel));add.catch(()=>{});await reached(started,add);
  const deleted=await require('../src/services/workTabDelete.service').deleteTask({sheetId:'local-sheet',tabName:tab,confirm:true,pool,notifyIntranet:false});assert.equal(deleted.ok,true);
  release.resolve();await assert.rejects(add,e=>[404,409,503].includes(e.status));
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,0);
  assert.equal(h.getUploaded(),1,'Uncommitted storage file is retained, not falsely called accepted or destructively cleaned');
  return {direction:'drive-in-flight',channel,uploadRejected:true,uncommittedFileRetained:true};
 }finally{release.resolve();if(add)await Promise.allSettled([add]);}
}
async function renameOverlap(h,pool){
 await h.pg.exec(`ALTER TABLE review_index ADD COLUMN tab_gid text;
 ALTER TABLE campaign_participants ADD COLUMN tab_gid text,ADD COLUMN updated_at timestamptz;
 ALTER TABLE qna_slots ADD COLUMN updated_at timestamptz;
 ALTER TABLE payment_batch_items ADD COLUMN row_index int;
 ALTER TABLE payment_records ADD COLUMN status text,ADD COLUMN source_key text,ADD COLUMN row_index int;
 ALTER TABLE index_master ADD COLUMN tab_gid text;
 ALTER TABLE tab_configs ADD COLUMN sheet_url text,ADD COLUMN updated_at timestamptz;
 ALTER TABLE trackb_work_order_links ADD COLUMN deleted_at timestamptz,ADD COLUMN work_order_id text;
 INSERT INTO review_index(sheet_id,tab_name)VALUES('local-sheet','일반 시험');`);
 const held=gate(),release=gate(),deletionConnected=gate();let rename,del;
 const renaming=tracedPool(pool,{after:async(sql,args,client)=>{if(sql.trim().startsWith('UPDATE review_index')){held.resolve(client.processID);await release.promise;}}});
 try{
  rename=require('../src/services/tabRename.service').renameTabState(renaming,{sheetId:'local-sheet',oldTabName:'일반 시험',newTabName:'이름변경 시험'});rename.catch(()=>{});const renamePid=await reached(held,rename);
  del=require('../src/services/workTabDelete.service').deleteTask({sheetId:'local-sheet',tabName:'일반 시험',confirm:true,pool:tracedPool(pool,{connected:pid=>deletionConnected.resolve(pid)}),notifyIntranet:false});del.catch(()=>{});
  await waitUntilBlocked(pool,await deletionConnected.promise,renamePid);release.resolve();
  const [renamed,deleted]=await Promise.all([rename,del]);assert.equal(renamed.orderSubmissionsUpdated,1);assert.equal(deleted.ok,true);
  return {direction:'rename-overlap',bothSucceeded:true,actualLockWait:true};
 }finally{release.resolve();await Promise.allSettled([rename,del].filter(Boolean));}
}
async function deletionRollback(h,pool,failure){
 const tables=['order_submissions','purchase_capture_artifacts','order_purchase_channels','purchase_capture_supplements','cs_threads','cs_messages','orphan_capture_tombstones','tab_configs'];
 const snapshot=()=>Promise.all(tables.map(async t=>(await pool.query(`SELECT to_jsonb(t) v FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows));
 const before=await snapshot();let injected=false;
 const failing=tracedPool(pool,{before:async(sql,args,client)=>{if(failure==='tombstone'?tombSql(sql):sql.includes('pg_advisory_xact_lock')&&String(args?.[0]).startsWith('purchase_capture:')){injected=true;await client.query('SELECT 1/0');}}});
 await assert.rejects(require('../src/services/workTabDelete.service').deleteTask({sheetId:'local-sheet',tabName:'일반 시험',confirm:true,pool:failing,notifyIntranet:false}),e=>e.code==='22012');
 assert.equal(injected,true);assert.deepEqual(await snapshot(),before,'Failed deletion rolls back every existing write');
 const added=await h.core.addSupplement(await uploadArgs(h,SINGLE,'single'));assert.equal(added.item.channels[0].photos.length,3,'Rollback released the shared capture lock');
 return {direction:'delete-'+failure+'-rollback',rollbackAtomic:true,lockReleased:true};
}
async function unrelatedOrder(h,pool){
 const paused=gate(),release=gate();let del,add;
 const args=await uploadArgs(h,BUNDLE,'naver');
 try{
  del=require('../src/services/workTabDelete.service').deleteTask({sheetId:'local-sheet',tabName:'일반 시험',confirm:true,pool:tracedPool(pool,{before:async sql=>{if(tombSql(sql)){paused.resolve();await release.promise;}}}),notifyIntranet:false});del.catch(()=>{});await reached(paused,del);
  add=h.core.addSupplement(args);add.catch(()=>{});
  let timer;try{const saved=await Promise.race([add,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Unrelated order was blocked by the target deletion')),3500);})]);assert.equal(saved.item.channels.find(c=>c.channel==='naver').photos.length,3);}finally{clearTimeout(timer);}
  release.resolve();assert.equal((await del).ok,true);assert.equal((await pool.query('SELECT count(*)::int n FROM purchase_capture_supplements WHERE order_submission_id=$1',[BUNDLE])).rows[0].n,1);
  return {direction:'unrelated-order',notBlocked:true};
 }finally{release.resolve();await Promise.allSettled([del,add].filter(Boolean));}
}
test('native PostgreSQL: real core and complete deletion service serialize committed supplements', {skip:!enabled,timeout:120000},async()=>{
 const cluster=await startNativeCaptureDatabase(),results=[];
 const poolPath=require.resolve('../src/db/pool');require.cache[poolPath]={id:poolPath,filename:poolPath,loaded:true,exports:cluster.pool};
 try{
  for(const [id,channel,tab,pseudo]of [[SINGLE,'single','일반 시험'],[BUNDLE,'naver','묶음 시험'],[BUNDLE,'coupang','묶음 시험'],[BUNDLE,'naver','묶음 시험',true]])for(const scenario of [uploadFirst,deletionFirst,lateDrive]){
   await cluster.reset();const engine={query:(...a)=>cluster.pool.query(...a),exec:sql=>cluster.pool.query(sql),close:async()=>{}};
   const h=await fixture({engine,database:cluster.pool});await addDeletionSchema(h);
   if(pseudo)await h.db.query("UPDATE order_submissions SET sheet_id='campaign:local-campaign',tab_name='campaign:local-campaign' WHERE id=$1",[id]);
   const otherId=id===SINGLE?BUNDLE:SINGLE,otherBefore=(await h.db.query('SELECT to_jsonb(o) v FROM order_submissions o WHERE id=$1',[otherId])).rows;
   results.push({...await scenario(h,id,channel,tab,cluster.pool),scope:pseudo?'campaign-origin':'direct'});
   assert.deepEqual((await h.db.query('SELECT to_jsonb(o) v FROM order_submissions o WHERE id=$1',[otherId])).rows,otherBefore,'Unrelated work remains unchanged');
   console.log('PASS actual native services',scenario.name,channel);
  }
  for(const scenario of [renameOverlap,(h,p)=>deletionRollback(h,p,'lock'),(h,p)=>deletionRollback(h,p,'tombstone'),unrelatedOrder]){
   await cluster.reset();const h=await fixture({engine:{query:(...a)=>cluster.pool.query(...a),exec:sql=>cluster.pool.query(sql),close:async()=>{}},database:cluster.pool});await addDeletionSchema(h);
   results.push(await scenario(h,cluster.pool));console.log('PASS native edge case',results.at(-1).direction);
  }
  const out=process.env.CAPTURE_NATIVE_PG_OUT||path.join(cluster.dir,'results.json');fs.writeFileSync(out,JSON.stringify({version:cluster.version,results},null,2));assert.equal(results.length,4*3+4);
  console.log('NATIVE_CAPTURE_CONCURRENCY_RESULTS='+out);
 }finally{await cluster.close();console.log('Isolated native PostgreSQL stopped; no production connections.');}
});
