'use strict';
const crypto=require('node:crypto');
const columns={image_backup_outbox:'id job_key file_id observation status attempts next_attempt_at lease_token lease_until receipt last_error_code created_at updated_at',image_backup_scans:'id state root_set_hash roots lease_token lease_until base_generation base_etag counts started_at completed_at',image_backup_scan_entries:'scan_id entry_key kind data job_key state'};
const getPool=()=>require('../db/imageBackupPool').getPool();
// Railway PR/test deployments may inherit variables; they must never write the live backup.
// No Railway metadata means an explicitly enabled, local operator CLI (same key/root checks).
const productionScope=()=>!process.env.RAILWAY_ENVIRONMENT_NAME||process.env.RAILWAY_ENVIRONMENT_NAME==='production';
const enabled=()=>process.env.IMAGE_BACKUP_ENABLED==='1'&&productionScope();
const canonical=v=>JSON.stringify(sort(v));
function sort(v){if(v===undefined)throw new Error('BAD_DESCRIPTOR');if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
async function checkBackupSchema({pool=getPool()}={}) {
 try {const {rows}=await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])",[Object.keys(columns)]);
 const present=new Set(rows.map(r=>r.table_name+'.'+r.column_name));const missing=[];
 for(const [t,cs]of Object.entries(columns))for(const c of cs.split(' '))if(!present.has(t+'.'+c))missing.push(t+'.'+c);
 return {ready:!missing.length,missing};}catch(_){return {ready:false,missing:['BACKUP_SCHEMA_UNAVAILABLE']};}
}
async function enqueue(event,{pool=getPool()}={}) {
 if(event.source==='payment_result')return {accepted:false};
 if(!/^[A-Za-z0-9_-]{10,200}$/.test(event.fileId||''))throw new Error('BAD_DESCRIPTOR');
 const key=event.jobKey||'upload:'+event.fileId;
 const r=await pool.query('INSERT INTO image_backup_outbox(job_key,file_id,observation) VALUES($1,$2,$3) ON CONFLICT(job_key) DO NOTHING RETURNING id',[key,event.fileId,JSON.stringify(event)]);
 return {accepted:r.rows.length===1};
}
const queue=[];let enqueueRunning=false,drainRunning=false;
function scheduleUploaded(event){
 try {
  if(!enabled()||event.source==='payment_result'||queue.length>=200)return;
  // Deliberate metadata-only projection; never retain buffer/base64/request objects.
  const safe=Object.fromEntries(['fileId','parentId','name','mime','size','uploadedAt','source'].map(k=>[k,event[k]??null]));
  if(Buffer.byteLength(JSON.stringify(safe))>8192)return;queue.push(safe);
  if(!enqueueRunning){enqueueRunning=true;setImmediate(()=>flush().catch(()=>{}));}
 }catch(_){/* Upload must remain unchanged even when reservation itself fails. */}
}
async function flush(){try{const pool=getPool();if(!(await checkBackupSchema({pool})).ready){queue.length=0;console.warn('[image-backup] BACKUP_SCHEMA_UNAVAILABLE');return;}
 while(queue.length){const e=queue.shift();try{await enqueue(e,{pool});}catch(_){console.warn('[image-backup] ENQUEUE_FAILED');}}
 }finally{enqueueRunning=false;}}
// Reservation before durable INSERT can be lost on crash. Nightly scan only repairs
// surviving originals; if the original is deleted first this gap is irrecoverable.
async function claim({pool=getPool(),limit=1}={}){
 const {rows}=await pool.query(`WITH picked AS (
 SELECT id FROM image_backup_outbox WHERE (status IN ('pending','retry') AND next_attempt_at<=now())
 OR (status='running' AND lease_until<=now()) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $1)
 UPDATE image_backup_outbox j SET status='running',lease_token=$2,lease_until=now()+interval '120 seconds',attempts=j.attempts+1,updated_at=now()
 FROM picked WHERE j.id=picked.id RETURNING j.*`,[Math.max(1,Math.min(1,limit)),crypto.randomUUID()]);return rows;
}
async function finish({pool=getPool(),job,status,receipt=null,code=null,delay=0}){
 if(!['done','retry','blocked','superseded'].includes(status))throw new Error('INVALID_STATE');
 const r=await pool.query(`UPDATE image_backup_outbox SET status=$3,receipt=$4,last_error_code=$5,
 next_attempt_at=now()+($6::double precision*interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=now()
 WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() RETURNING id`,[job.id,job.lease_token,status,receipt&&JSON.stringify(receipt),code,delay]);return r.rows.length===1;
}
async function retryJob({jobKey,pool=getPool()}){const r=await pool.query("UPDATE image_backup_outbox SET status='retry',attempts=0,next_attempt_at=now(),lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE job_key=$1 AND status='blocked' RETURNING id",[jobKey]);return {resumed:r.rows.length};}
function objectKey(descriptor,hash){const segment=(name,id)=>Buffer.from(name).toString('base64url')+'~'+id;const key='v1/'+descriptor.section+'/'+[...descriptor.chain.map(p=>segment(p.name,p.id)),segment(descriptor.name,descriptor.fileId),hash].join('/');if(Buffer.byteLength(key)>1000)throw Object.assign(new Error('TOO_LARGE'),{code:'TOO_LARGE'});return key;}
function verifyReceipt(receipt,descriptor,proof){
 const hash=receipt?.sha256;const key=objectKey(descriptor,hash);
 const expected=sha(canonical({descriptor,proof,key,sha256:hash,size:descriptor.size,mime:descriptor.mime}));
 if(receipt?.v!==1||receipt.verified!==true||receipt.fileId!==descriptor.fileId||receipt.key!==key||receipt.size!==descriptor.size||receipt.mime!==descriptor.mime||! /^[a-f0-9]{64}$/.test(hash||'')||!receipt.objectEtag||receipt.objectEtag.includes('"')||receipt.receiptId!==expected||proof.kind==='drive-sha256'&&proof.sha256!==hash)throw Object.assign(new Error('VERIFY_FAILED'),{code:'VERIFY_FAILED'});
 return receipt;
}
async function drainOnce({limit=1,signal,deps={}}={}){
 const result={claimed:0,verified:0,retry:0,blocked:0};if(!productionScope()||drainRunning)return result;drainRunning=true;
 try{
 const scan=require('./imageBackupScan.service'),d=await scan.dependencies(deps);
 if(!(await checkBackupSchema({pool:d.pool})).ready)return result;
 const jobs=await claim({pool:d.pool,limit});result.claimed=jobs.length;
 for(const job of jobs){
  try{
   signal?.throwIfAborted();const old=job.observation;let observations=[];
   // A candidate has no trusted root/reader yet. Try only approved matrix pairs;
   // failure of a required pair is not hidden by another successful reader.
   const matrix=async()=>{for(const root of d.roots)for(const kind of root.readerKinds){const reader=d.readers.find(r=>r.kind===kind);if(!reader)throw Object.assign(new Error(),{code:'READER_UNAVAILABLE'});try{const o=await scan.observe({fileId:job.file_id,rootId:root.rootId,reader,source:old.source,deps:d});observations.push(o);}catch(e){if(e.code!=='UNRESOLVED_PATH'&&e.response?.status!==404&&e.code!==404)throw e;}}};
   if(old.descriptor){const reader=d.readers.find(r=>r.kind===old.readerKind);if(!reader)throw Object.assign(new Error(),{code:'READER_UNAVAILABLE'});
    // 결정 368: moved out of its root (e.g. into another approved root) = new observation → superseded below.
    try{observations=[await scan.observe({fileId:job.file_id,rootId:old.descriptor.rootId,reader,source:old.source,deps:d})];}catch(e){if(e.code!=='UNRESOLVED_PATH')throw e;await matrix();}}
   else await matrix();
   if(!observations.length)throw Object.assign(new Error(),{code:'UNRESOLVED_PATH'});
   if(observations.some(o=>o.scope.decision==='exclude')){await finish({pool:d.pool,job,status:'superseded',code:'SCOPE_DENIED'});continue;}
   const o=observations[0];if(o.scope.decision==='retry')throw Object.assign(new Error(),{code:o.scope.reason});
   if(observations.some(x=>canonical(x.observation.descriptor)!==canonical(o.observation.descriptor)))throw Object.assign(new Error(),{code:'AMBIGUOUS_ROOT'});
   if(!old.descriptor||job.job_key!==o.jobKey){await enqueue({...o.observation,fileId:job.file_id,jobKey:o.jobKey},{pool:d.pool});await finish({pool:d.pool,job,status:'superseded'});continue;}
   const descriptor=o.observation.descriptor;const {MAX,readBounded}=require('./imageBackupClient.service');if(descriptor.size>MAX)throw Object.assign(new Error(),{code:'TOO_LARGE'});
   const reader=d.readers.find(r=>r.kind===o.observation.readerKind);let proof,receipt,body;
   if(/^[a-f0-9]{32}$/.test(o.observation.md5Checksum||'')){
    proof={kind:'drive-md5',md5:o.observation.md5Checksum,size:descriptor.size,sourceVersion:descriptor.sourceVersion};
    try{receipt=await d.api.copyOrig({descriptor,proof,signal});if(!receipt)throw Object.assign(new Error(),{code:'VERIFY_FAILED'});}catch(e){if(!['SOURCE_MISSING','SOURCE_MISMATCH'].includes(e.code))throw e;}
   }
   if(!receipt){
    const downloaded=await reader.download(job.file_id,signal);body=Buffer.isBuffer(downloaded)?downloaded:await readBounded(downloaded,MAX);
    if(body.length!==descriptor.size||body.length>MAX||proof&&crypto.createHash('md5').update(body).digest('hex')!==proof.md5)throw Object.assign(new Error(),{code:'SOURCE_CHANGED'});
    if(!proof)proof={kind:'drive-sha256',sha256:sha(body),size:body.length,sourceVersion:descriptor.sourceVersion};
    receipt=await d.api.putObject({descriptor,proof,body,signal});
   }
   // Re-read the ENTIRE parent chain too: a folder rename is a new observation.
   const after=await scan.observe({fileId:job.file_id,rootId:descriptor.rootId,reader,deps:d});
   if(after.jobKey!==o.jobKey)throw Object.assign(new Error(),{code:'SOURCE_CHANGED'});
   if(body&&sha(body)!==receipt?.sha256)throw Object.assign(new Error(),{code:'VERIFY_FAILED'});
   verifyReceipt(receipt,descriptor,proof);
   if(await finish({pool:d.pool,job,status:'done',receipt}))result.verified++;
  }catch(e){
   const code=['AUTH_REQUIRED','BAD_DESCRIPTOR','NOT_FOUND','KEY_CONFLICT','PRECONDITION_FAILED','SOURCE_CHANGED','VERIFY_FAILED','BUSY','STORE_UNAVAILABLE','SOURCE_MISSING','SOURCE_MISMATCH','TOO_LARGE','SCOPE_DENIED','UNSUPPORTED_MIME','UNRESOLVED_PATH','UNRESOLVED_VERSION','UNRESOLVED_SIZE','AMBIGUOUS_ROOT','READER_UNAVAILABLE'].includes(e.code)?e.code:'BACKUP_RETRY';
   const permanent=['AUTH_REQUIRED','BAD_DESCRIPTOR','NOT_FOUND','KEY_CONFLICT','PRECONDITION_FAILED','TOO_LARGE','SCOPE_DENIED','UNSUPPORTED_MIME'].includes(code);const blocked=permanent||job.attempts>=8;
   const delay=Math.min(21600,30*2**Math.min(job.attempts-1,10))+Math.floor(Math.random()*31);
   if(await finish({pool:d.pool,job,status:blocked?'blocked':'retry',code,delay}))result[blocked?'blocked':'retry']++;
  }
 }
 return result;
 }finally{drainRunning=false;}
}
module.exports={scheduleUploaded,enqueue,checkBackupSchema,claim,finish,retryJob,canonical,sha,enabled,objectKey,verifyReceipt,drainOnce};
