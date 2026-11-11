'use strict';
// Focused preservation contracts. Actual route handlers + actual common uploader;
// local SQL/fake business lookups, fake Drive SDK/AI/folder service. No external IO.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const crypto=require('node:crypto'),express=require('express'),jwt=require('jsonwebtoken');
require('dotenv').config=()=>({parsed:{}});
process.env.JWT_SECRET=crypto.randomBytes(32).toString('hex');
process.env.AI_REVIEW_FOLDER_ID='root00000001';
for(const n of ['http','https']){const mod=require(n),request=mod.request;mod.request=function(...args){const target=args[0];if(n==='https'||!String(target?.hostname||target?.host||target).includes('127.0.0.1'))throw Error('EXTERNAL_IO_FORBIDDEN');return request.apply(this,args);};}
const pg=require('pg');for(const t of [pg.Client,pg.Pool])for(const m of ['query','connect'])t.prototype[m]=async()=>{throw Error('REAL_PG_FORBIDDEN');};
const net=require('node:net'),connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const opts=Array.isArray(args[0])?args[0][0]:args[0];const host=opts?.host||opts?.hostname;if(host&&!['127.0.0.1','localhost','::1'].includes(host))throw Error('EXTERNAL_NET_FORBIDDEN');return connect.apply(this,args);};
require('./helpers/dualChannelDependencies.cjs');
const SRC=path.resolve(__dirname,'../src');
function replace(relative,exports){const file=require.resolve(path.join(SRC,relative));require.cache[file]={id:file,filename:file,loaded:true,exports};}
let mode='off',scheduled=0,uploads=0,shares=0,warm=0;const files=new Map();
const logger={info(){},warn(){},error(){}};
replace('utils/logger',{logger});replace('db/pool',{query:async()=>{throw Error('UNINJECTED_POOL');},on(){}});
replace('services/captureFolder.service',{resolveCaptureFolder:async()=>({folderId:'folder000001'})});
const drivePath=path.join(SRC,'services/drive.service.js');
const fake={files:{create:async p=>{const chunks=[];for await(const c of p.media.body)chunks.push(Buffer.from(c));const id='file'+String(++uploads).padStart(8,'0');files.set(id,Buffer.concat(chunks));return {data:{id,name:'stable-name',webViewLink:'local:'+id}};},get:async p=>({data:files.get(p.fileId)})},permissions:{create:async()=>{shares++;}}};
const driveSandbox={module:{exports:{}},exports:{},Buffer,console,setImmediate,setTimeout,clearTimeout,process,require:n=>{
 if(n==='./sheets.service')return {drive:fake};if(n==='../utils/logger')return {logger};
 if(n==='./imageWarm.service')return {scheduleUploadWarm:()=>warm++};
 if(n==='./imageBackup.service'){
  if(mode==='import')throw Error('injected backup import failure');
  return {scheduleUploaded:e=>{scheduled++;assert.ok(e.fileId);assert.equal('buffer' in e,false);if(mode==='sync')throw Error('injected reservation failure');if(mode==='async')return Promise.reject(Error('injected async failure'));}};
 }
 return Module.createRequire(drivePath)(n);
}};
vm.runInNewContext(fs.readFileSync(drivePath,'utf8'),driveSandbox,{filename:drivePath});
const drive=driveSandbox.module.exports;
// Folder/provider boundaries are fake; uploader including real backup root hook is not.
drive.getOrCreateSubFolder=async()=>({id:'folder000001'});
drive.downloadFile=async id=>({buffer:files.get(id)});
replace('services/drive.service',drive);
const {lastRouteHandler}=require('../src/utils/routeHandlers');
const sessions=require('../src/services/reviewerSession.service');
const pass=(_req,_res,next)=>next();
replace('middleware/rateLimit.middleware',{imageApiLimiter:pass,imageUploadLimiter:pass});
function extract(src,start,end){const a=src.indexOf(start),b=src.indexOf(end,a);assert.ok(a>=0&&b>a,start);return src.slice(a,b);}
async function withHttp(router,run){const app=express();app.use(express.json({limit:'2mb'}));app.use(router);const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 const post=async(url,body,headers={})=>{const r=await fetch('http://127.0.0.1:'+server.address().port+url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{return await run(post);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
const states=['off','import','sync','async'];
function setMode(m){mode=m;process.env.IMAGE_BACKUP_ENABLED=m==='off'?'0':'1';uploads=shares=warm=scheduled=0;files.clear();}
function invariant(){assert.equal(uploads,1);assert.equal(warm,1);assert.equal(shares,2);assert.equal(scheduled,['sync','async'].includes(mode)?1:0);}
function normalize(v){return JSON.parse(JSON.stringify(v,(k,val)=>['uploadBatchId','uploadToken','id','created_at','uploaded_at','updated_at','createdAt','updatedAt','check_request_id','request_key','request_payload_hash'].includes(k)?'<volatile>':val));}
(async()=>{
 const unhandled=[];const rejection=e=>unhandled.push(e);process.on('unhandledRejection',rejection);
 try{
  // Load only the exact registered legacy handler and its real identity helpers.
  // This deliberately excludes unrelated diag startup/migration side effects.
  const diag=fs.readFileSync(path.join(SRC,'routes/diag.routes.js'),'utf8');
  let writes=[];const pool={query:async(sql,args)=>{
   if(sql.includes('SELECT folder_url'))return {rows:[{folder_url:'https://drive.google.com/drive/folders/folder000001'}]};
   if(sql.includes('INSERT INTO review_submissions'))writes.push({fileId:args[6],slot:args[9],hash:args[10]});
   return {rows:[],rowCount:1};
  }};
  const inspection={findOwnDuplicate:async()=>null,hashBase64:b=>crypto.createHash('sha256').update(Buffer.from(b,'base64')).digest('hex'),loadTabExpectations:async()=>({}),submissionSamples:async()=>[],inspectSubmission:async()=>null};
  const stubs={
   '../services/reviewerTargetOwnership.service':{ownsReviewerTarget:async()=>true},
   '../services/reviewReminder.service':{closedStateForTarget:async()=>null},
   '../services/reviewInspect.service':inspection,
   '../services/cashReceiptContext.service':{cashReceiptRequirementsForRows:async()=>new Map(),cashReceiptRequiredForTab:async()=>false},
   '../services/reviewTypeContext.service':{reviewTypeForRow:async()=>null},
   '../services/workKindContext.service':{workKindForTab:async()=>null},
   '../services/fileRoute.service':{},
  };
  const router=express.Router(),sandbox={router,_handlers:{},lastRouteHandler,imageApiLimiter:pass,pool,driveService:drive,logger,process,Buffer,console,
   randomUUID:crypto.randomUUID,jwt,verifyReviewerSession:sessions.verifyReviewerSession,
   reviewTypeForTab:async()=>null,recipientNameForRow:async()=> 'local-recipient',verifyCapture:async()=>null,
   ...Object.fromEntries(Object.entries(require('../src/utils/captureSlots')).map(([k,v])=>[k==='slotLabel'?'slotLabelOf':k,v])),
   require:n=>Object.hasOwn(stubs,n)?stubs[n]:Module.createRequire(path.join(SRC,'routes/diag.routes.js'))(n)};
  const body=extract(diag,"router.post('/review-upload'",'_handlers.reviewUpload =');
  vm.runInNewContext(extract(diag,'function verifiedReviewerIdentity','// ── Auto-migration')+'\n'+body+'\n_handlers.reviewUpload=lastRouteHandler(router);',sandbox);
  const staffSource=fs.readFileSync(path.join(SRC,'routes/trackB.routes.js'),'utf8');
  sandbox._workdeskReviewUpload=sandbox._handlers.reviewUpload;sandbox.authMiddleware=pass;sandbox.internalMiddleware=pass;
  vm.runInNewContext(extract(staffSource,"router.post('/workdesk/review-upload'",'// 관리자 수동 리뷰제출'),sandbox);
  const token=sessions.issueReviewerSession({ownerReviewerId:'local-owner',loginName:'local',loginPhone8:'12345678'});
  const staff=jwt.sign({id:'local-staff',role:'staff',via:'intranet'},process.env.JWT_SECRET);
  await withHttp(router,async post=>{
   for(const [label,url,headers] of [['ordinary','/review-upload',{'x-reviewer-token':token}],['staff-delegated','/workdesk/review-upload',{authorization:'Bearer '+staff}]]){
    let expected;
    for(const m of states){setMode(m);writes=[];const r=await post(url,{sheetId:'local-sheet',tabName:'local-tab',rowIndex:2,slotKey:'review',files:[{data:Buffer.from('local-image').toString('base64'),mimeType:'image/png'}]},headers);await new Promise(r=>setImmediate(r));
     assert.equal(r.status,200);assert.equal(r.body.ok,true,JSON.stringify(r.body));assert.equal(r.body.uploaded,1);assert.equal(writes.length,1);invariant();const got=normalize({r,writes});if(!expected)expected=got;else assert.deepEqual(got,expected,label+' response and write unchanged: '+m);
    }
    console.log('PASS '+label+': actual HTTP handler + uploader, backup OFF vs ON import/sync/async failure response/ledger identical');
   }
  });
  // Real dual service/default uploader with actual PGlite SQL and HTTP adapter.
  const dualFixture=require('./helpers/dualChannelRealFixture');
  for(const m of states){setMode(m);const db=await dualFixture.fixture();try{
   const review=require('../src/services/dualChannelReview.service').createService({db,authorizeTarget:async()=>true,folderForSlot:async()=> 'folder000001'});
   const dualRouter=require('../src/routes/dualChannelHttp.routes').createDualPurchaseImageRouter({reviewService:review});
   await withHttp(dualRouter,async post=>{const token=sessions.issueReviewerSession({ownerReviewerId:dualFixture.owner,loginName:'local',loginPhone8:'12345678'});const r=await post('/review-stage',{orderSubmissionId:dualFixture.id,sheetId:'s',tabName:'t',rowIndex:2,slotKey:'review',imageBase64:Buffer.from('local-dual-image').toString('base64'),mimeType:'image/png',expectedRevision:0},{'x-reviewer-token':token});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.ok,true);assert.equal(r.body.revision,1);assert.equal(r.body.fileId,'file00000001');});
   const rows=(await db.query('SELECT file_id,evidence_role,evidence_revision,byte_sha256,completed_at FROM review_submissions')).rows;
   assert.deepEqual(rows,[{file_id:'file00000001',evidence_role:'review',evidence_revision:1,byte_sha256:crypto.createHash('sha256').update('local-dual-image').digest('hex'),completed_at:null}]);
   await new Promise(r=>setImmediate(r));invariant();
  }finally{await db.close();}}
  console.log('PASS dual: actual HTTP adapter + SQL service + default uploader, OFF/ON faults preserve successful evidence write (not completion/payment E2E)');
  // Actual supplemental upload router/core/default uploader; existing local SQL fixture.
  const captureFixture=require('./helpers/purchaseCaptureIntegrationFixture');
  for(const m of states){setMode(m);const f=await captureFixture.fixture();try{
   let core;const requestInTx=async(client,{context,channel,note})=>{const row=(await client.query("INSERT INTO purchase_capture_check_requests(order_submission_id,channel,evidence_hash,status,note)VALUES($1,$2,$3,'pending',$4) RETURNING *",[context.order.id,channel,context.evidenceByChannel[channel].evidenceHash,note])).rows[0];return {request:row,created:true};};
   core=require('../src/services/purchaseCaptureSelfService.service').createService({db:f.db,requestInTx});
   const router=require('../src/routes/purchaseCapture.routes').createPurchaseCaptureRouters({core,uploadLimiter:pass}).reviewerRouter;
   const session={ownerReviewerId:captureFixture.OWNER,loginKind:'self',loginPhone8:'12345678'};
   const before=(await f.db.query('SELECT * FROM order_submissions ORDER BY id')).rows;
   const {item}=await core.getForReviewer({session,orderSubmissionId:captureFixture.SINGLE});
   await withHttp(router,async post=>{const token=sessions.issueReviewerSession({...session,loginName:'local'});const r=await post('/purchase-captures/'+captureFixture.SINGLE+'/supplements',{channel:'single',imageBase64:captureFixture.IMAGE.toString('base64'),mimeType:'image/png',requestKey:crypto.randomUUID(),expectedEvidenceHash:item.channels[0].evidenceHash},{'x-reviewer-token':token});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.ok,true);assert.equal(r.body.item.channels[0].photos.length,3);assert.equal(r.body.item.channels[0].photos[2].fileId,'file00000001');});
   assert.deepEqual((await f.db.query('SELECT * FROM order_submissions ORDER BY id')).rows,before);
   assert.equal((await f.db.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,1);
   await new Promise(r=>setImmediate(r));invariant();
  }finally{await f.pg.close();}}
  console.log('PASS additional: actual HTTP router + SQL core + default uploader, OFF/ON faults preserve third photo, check request, original orders');
  assert.equal(unhandled.length,0);console.log('LIMIT: fake Drive SDK/AI/folder resolution; ordinary/staff business reads/writes stubbed; staff auth middleware not exercised; dual completion/payment and browser submission NOT verified.');
 }finally{process.off('unhandledRejection',rejection);}
})().catch(e=>{console.error(e);process.exitCode=1;});
