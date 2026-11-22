'use strict';
// 결정 368 — 「참조 사진」 모드: 승인 폴더 밖(내 드라이브 맨 위 등)에 있지만 리뷰 시스템이 실제로 쓰는 사진만 백업한다.
// 폴더 전체를 훑지 않는다(scan roots 불변). 기본 OFF = 종전과 동일. 이체결과·제외 root·크기/형식/버전 규칙은 그대로.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');const {PGlite}=require('@electric-sql/pglite');
const s=require('../src/services/imageBackupScan.service'),b=require('../src/services/imageBackup.service');
const FOLDER='application/vnd.google-apps.folder';
const MIGRATIONS=['223_image_group_backup.sql','226_image_backup_outbox_file_idx.sql'].map(f=>fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
const BUSINESS=`CREATE TABLE tab_configs(sheet_id text,tab_name text,capture_slots jsonb,income_type text);
CREATE TABLE review_submissions(file_id text,slot_key text,evidence_role text,sheet_id text,tab_name text);
CREATE TABLE review_edit_requests(new_file_id text,old_file_id text,slot_key text,status text,sheet_id text,tab_name text);
CREATE TABLE guide_image_files(file_id text PRIMARY KEY,source text);
CREATE TABLE payment_result_drive_archive(drive_file_id text);
CREATE TABLE order_submissions(capture_file_id text,capture_file_id_2 text);
CREATE TABLE purchase_capture_artifacts(file_id text);CREATE TABLE purchase_capture_supplements(file_id text);
CREATE TABLE purchase_submission_sessions(capture_file_id text);CREATE TABLE review_index(review_file_id text);
CREATE TABLE review_inspections(file_id text);CREATE TABLE review_photo_relinks(file_id text);`;
const MYD='mydrive00000001',R='root00000001',X='excl00000001',FA='folderA00001',F1='file00000001',F2='file00000002',F3='file00000003';
const body=Buffer.from('abc'),MD5=crypto.createHash('md5').update(body).digest('hex');
const img=(id,parent,extra={})=>({id,name:'x-'+id+'.jpg',parents:[parent],mimeType:'image/jpeg',size:'3',version:'1',modifiedTime:'2026-11-22T00:00:00.000Z',md5Checksum:MD5,...extra});
function drive(meta,kind='oauth'){const clone=v=>v&&JSON.parse(JSON.stringify(v));let downloads=0;
 return {kind,get downloads(){return downloads;},getMetadata:async id=>{if(!meta[id]||meta[id].gone)throw Object.assign(new Error('File not found'),{code:404});return clone(meta[id]);},listChildren:async id=>({files:Object.values(meta).filter(m=>(m.parents||[]).includes(id)).map(clone),nextPageToken:null}),download:async()=>{downloads++;return body;}};}
function fakeApi(){const puts=[];return {puts,readCurrent:async()=>null,listManifests:async()=>({items:[],truncated:false,cursor:null}),copyOrig:async()=>{throw Object.assign(new Error(),{code:'SOURCE_MISSING'});},
 putObject:async({descriptor,proof})=>{puts.push(descriptor);const sha=b.sha(body),key=b.objectKey(descriptor,sha);return {v:1,key,fileId:descriptor.fileId,sha256:sha,size:3,mime:descriptor.mime,objectEtag:'etag',receiptId:b.sha(b.canonical({descriptor,proof,key,sha256:sha,size:3,mime:descriptor.mime})),verified:true};}};}
const baseMeta=()=>({[MYD]:{id:MYD,name:'내 드라이브',mimeType:FOLDER},[R]:{id:R,name:'[리뷰]',parents:[MYD],mimeType:FOLDER},[X]:{id:X,name:'이체결과',parents:[MYD],mimeType:FOLDER},[FA]:{id:FA,name:'A',parents:[MYD],mimeType:FOLDER}});
async function setup({meta=baseMeta(),referenced=[MYD],excluded=[X]}={}){const db=new PGlite();for(const m of MIGRATIONS)await db.exec(m);await db.exec(BUSINESS);
 const reader=drive(meta,'oauth'),api=fakeApi();const deps={pool:db,roots:[{rootId:R,readerKinds:['oauth']}],excluded,referenced,readers:[reader],api,loadHints:s.loadHints};return {db,meta,reader,api,deps};}
const q=async(db,sql,a)=>(await db.query(sql,a)).rows;
const upload=(db,fileId)=>b.enqueue({fileId,source:'upload',name:'x',mime:'image/jpeg',size:3,parentId:MYD,uploadedAt:'2026-11-22T00:00:00.000Z'},{pool:db});
const cases=[],failures=[];
async function run(name,fn){try{await fn();cases.push(name);}catch(e){failures.push(name+': '+e.message);console.error('FAIL case:',name,e);}}
(async()=>{
 // ① referenced photo sitting directly in the My Drive root is backed up with rootId = top ancestor.
 await run('referenced My-Drive-root photo backed up (rootId=top, chain[0]=top), upload job completes',async()=>{const {db,meta,api,deps}=await setup();meta[F1]=img(F1,MYD);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);
  let r=await b.drainOnce({limit:1,deps});assert.equal(r.retry,0,'candidate promoted, not UNRESOLVED_PATH');
  const jobs=await q(db,'SELECT job_key,status,observation FROM image_backup_outbox ORDER BY id');assert.equal(jobs.length,2);assert.equal(jobs[0].status,'superseded');
  const d=jobs[1].observation.descriptor;assert.equal(d.rootId,MYD);assert.equal(d.chain[0].id,MYD);assert.deepEqual(d.chain,[{id:MYD,name:'내 드라이브'}]);assert.equal(d.section,'internal');assert.equal(jobs[1].observation.readerKind,'oauth');
  r=await b.drainOnce({limit:1,deps});assert.equal(r.verified,1,'upload of referenced photo completes');assert.equal(api.puts.length,1);
  const done=(await q(db,"SELECT receipt FROM image_backup_outbox WHERE status='done'"))[0];assert.ok(done.receipt.key.startsWith('v1/internal/'+Buffer.from('내 드라이브').toString('base64url')+'~'+MYD+'/'));
  await db.close();});
 // ② other referenced column (order capture) inside a top-level folder under My Drive.
 await run('referenced order capture in other top-level folder backed up with folder chain',async()=>{const {db,meta,deps}=await setup();meta[F1]=img(F1,FA);
  await db.query('INSERT INTO order_submissions(capture_file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});
  const d=(await q(db,"SELECT observation FROM image_backup_outbox WHERE status='pending'"))[0].observation.descriptor;assert.deepEqual(d.chain.map(c=>c.id),[MYD,FA]);await db.close();});
 // ③ NOT referenced by the review system → never backed up; same UNRESOLVED_PATH retry → blocked as today.
 await run('unreferenced photo outside approved roots stays UNRESOLVED_PATH retry then blocked',async()=>{const {db,meta,deps,api}=await setup();meta[F1]=img(F1,MYD);await upload(db,F1);
  let r=await b.drainOnce({limit:1,deps});assert.equal(r.retry,1);let job=(await q(db,'SELECT status,last_error_code FROM image_backup_outbox'))[0];assert.equal(job.status,'retry');assert.equal(job.last_error_code,'UNRESOLVED_PATH');
  await db.query("UPDATE image_backup_outbox SET attempts=8,next_attempt_at=now()");r=await b.drainOnce({limit:1,deps});assert.equal(r.blocked,1);
  job=(await q(db,'SELECT status FROM image_backup_outbox'))[0];assert.equal(job.status,'blocked');assert.equal(api.puts.length,0);await db.close();});
 // ④ payment result file and excluded root stay excluded even when referenced.
 await run('payment archive id and excluded-root chain stay excluded (SCOPE_DENIED)',async()=>{const {db,meta,deps,api}=await setup();meta[F1]=img(F1,MYD);meta[F2]=img(F2,X);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1),($2)',[F1,F2]);await db.query('INSERT INTO payment_result_drive_archive(drive_file_id) VALUES($1)',[F1]);
  await upload(db,F1);await upload(db,F2);await b.drainOnce({limit:1,deps});await b.drainOnce({limit:1,deps});
  const jobs=await q(db,'SELECT file_id,status,last_error_code FROM image_backup_outbox ORDER BY id');assert.equal(jobs.length,2,'no new observation job');
  for(const j of jobs){assert.equal(j.status,'superseded');assert.equal(j.last_error_code,'SCOPE_DENIED');}assert.equal(api.puts.length,0);await db.close();});
 // ⑤ feature off (empty config) = identical to today.
 await run('feature off: empty referenced config keeps UNRESOLVED_PATH and sweep is a no-op',async()=>{const {db,meta,deps}=await setup({referenced:[]});meta[F1]=img(F1,MYD);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);const r=await b.drainOnce({limit:1,deps});assert.equal(r.retry,1);
  assert.equal((await q(db,'SELECT last_error_code FROM image_backup_outbox'))[0].last_error_code,'UNRESOLVED_PATH');
  const g=await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[]});assert.equal(g.enabled,false);assert.equal((await q(db,'SELECT count(*)::int n FROM image_backup_outbox'))[0].n,1);
  const base={IMAGE_BACKUP_ALLOWED_ROOT_IDS:JSON.stringify([R]),IMAGE_BACKUP_EXCLUDED_ROOT_IDS:'[]',IMAGE_BACKUP_ROOT_READERS:JSON.stringify([{rootId:R,readerKinds:['sa']}])};
  assert.deepEqual(s.config(base).referenced,[]);assert.deepEqual(s.config({...base,IMAGE_BACKUP_REFERENCED_ROOT_IDS:'[]'}),s.config(base));await db.close();});
 // ⑥ approved root wins: a referenced photo inside an approved root (nested under the referenced top) gets ONE approved observation.
 await run('approved root observation wins over referenced (single job, rootId=approved)',async()=>{const {db,meta,deps}=await setup();meta[F1]=img(F1,R);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});
  const jobs=await q(db,"SELECT observation FROM image_backup_outbox WHERE status='pending'");assert.equal(jobs.length,1);assert.equal(jobs[0].observation.descriptor.rootId,R);
  // the referenced resolver itself refuses a chain that passes through an approved root.
  await assert.rejects(s.observeReferenced({fileId:F1,reader:deps.readers[0],deps}),e=>e.code==='UNRESOLVED_PATH');
  // existing referenced job whose photo later moved INTO the approved root → superseded by approved observation.
  await db.query("UPDATE image_backup_outbox SET status='superseded'");meta[F2]=img(F2,MYD);await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F2]);await upload(db,F2);await b.drainOnce({limit:1,deps});
  const ref=(await q(db,"SELECT job_key,observation FROM image_backup_outbox WHERE file_id=$1 AND status='pending'",[F2]))[0];assert.equal(ref.observation.descriptor.rootId,MYD);
  meta[F2].parents=[R];await b.drainOnce({limit:1,deps});
  const after=await q(db,'SELECT job_key,status,observation FROM image_backup_outbox WHERE file_id=$1 ORDER BY id',[F2]);
  assert.equal(after.find(j=>j.job_key===ref.job_key).status,'superseded');assert.equal(after.at(-1).observation.descriptor.rootId,R);assert.equal(after.at(-1).status,'pending');await db.close();});
 // ⑦ moved out of everything: an existing referenced job is not silently done; transient errors are retried (never gone).
 await run('referenced job: transient reader error retries, trashed superseded SOURCE_TRASHED',async()=>{const {db,meta,deps,reader}=await setup();meta[F1]=img(F1,MYD);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});
  const get=reader.getMetadata;reader.getMetadata=async id=>{if(id===F1)throw Object.assign(new Error('getaddrinfo ENOTFOUND'),{code:'ENOTFOUND'});return get(id);};
  let r=await b.drainOnce({limit:1,deps});assert.equal(r.retry,1,'network failure retried');reader.getMetadata=get;
  meta[F1].trashed=true;await db.query("UPDATE image_backup_outbox SET next_attempt_at=now() WHERE status='retry'");r=await b.drainOnce({limit:1,deps});
  const j=(await q(db,"SELECT status,last_error_code FROM image_backup_outbox ORDER BY id DESC LIMIT 1"))[0];assert.equal(j.status,'superseded');assert.equal(j.last_error_code,'SOURCE_TRASHED');await db.close();});
 // ⑧ the re-read after upload uses the referenced resolver: a rename of the top/chain mid-upload is SOURCE_CHANGED, not done.
 await run('after-upload re-read uses referenced resolver (folder rename mid-upload = SOURCE_CHANGED)',async()=>{const {db,meta,deps,api}=await setup();meta[F1]=img(F1,FA);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});
  const put=api.putObject;api.putObject=async a=>{meta[FA].name='A-renamed';return put(a);};const r=await b.drainOnce({limit:1,deps});
  assert.equal(r.verified,0);assert.equal(r.retry,1);assert.equal((await q(db,"SELECT last_error_code FROM image_backup_outbox ORDER BY id DESC LIMIT 1"))[0].last_error_code,'SOURCE_CHANGED');await db.close();});
 // ⑨ sa fallback after oauth: only SA sees a shared folder whose top has no visible parent.
 await run('referenced resolver tries oauth then sa; shared-folder top via SA',async()=>{const SH='shared000001',meta=baseMeta();meta[SH]={id:SH,name:'공유폴더',mimeType:FOLDER};meta[F1]=img(F1,SH);
  const {db,deps}=await setup({meta,referenced:[MYD,SH]});const sa=drive(meta,'sa'),oauth=deps.readers[0];const og=oauth.getMetadata;oauth.getMetadata=async id=>{if(id===F1||id===SH)throw Object.assign(new Error('nf'),{code:404});return og(id);};
  deps.readers=[sa,oauth];await db.query('INSERT INTO review_inspections(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});
  const o=(await q(db,"SELECT observation FROM image_backup_outbox WHERE status='pending'"))[0].observation;assert.equal(o.readerKind,'sa');assert.equal(o.descriptor.rootId,SH);await db.close();});
 // ⑩ gap sweep: only referenced ids with NO outbox row, bounded, idempotent; payment ids skipped.
 await run('gap sweep enqueues only referenced ids without any outbox row, bounded and idempotent',async()=>{const {db}=await setup();
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1),($2)',[F1,'bad id']);await db.query('INSERT INTO order_submissions(capture_file_id,capture_file_id_2) VALUES($1,$1),(NULL,NULL)',[F2]);
  await db.query('INSERT INTO review_edit_requests(old_file_id,new_file_id) VALUES($1,$2)',[F3,F1]);await db.query('INSERT INTO review_photo_relinks(file_id) VALUES($1)',['file00000004']);
  await db.query('INSERT INTO guide_image_files(file_id,source) VALUES($1,$2)',['file00000005','upload:order']);await db.query('INSERT INTO review_index(review_file_id) VALUES($1)',['file00000006']);
  await db.query('INSERT INTO purchase_capture_artifacts(file_id) VALUES($1)',['paid00000001']);await db.query('INSERT INTO payment_result_drive_archive(drive_file_id) VALUES($1)',['paid00000001']);
  await b.enqueue({fileId:'file00000006',jobKey:'obs:already'},{pool:db});
  let g=await s.enqueueReferencedGaps({pool:db,limit:2,referenced:[MYD]});assert.equal(g.enabled,true);assert.equal(g.enqueued,2,'bounded per call');
  g=await s.enqueueReferencedGaps({pool:db,limit:100,referenced:[MYD]});assert.equal(g.enqueued,3);
  g=await s.enqueueReferencedGaps({pool:db,limit:100,referenced:[MYD]});assert.equal(g.enqueued,0,'idempotent');
  const rows=await q(db,"SELECT job_key,file_id,observation FROM image_backup_outbox WHERE job_key LIKE 'ref:%' ORDER BY file_id");
  assert.deepEqual(rows.map(r=>r.file_id),[F1,F2,F3,'file00000004','file00000005']);for(const r of rows){assert.equal(r.job_key,'ref:'+r.file_id);assert.equal(r.observation.source,'referenced');}
  await assert.rejects(s.enqueueReferencedGaps({pool:db,limit:0,referenced:[MYD]}),e=>e.code==='BAD_LIMIT');
  assert.equal((await q(db,"SELECT count(*)::int n FROM pg_indexes WHERE tablename='image_backup_outbox' AND indexdef LIKE '%(file_id)%'"))[0].n,1,'anti-join is index-backed (migration 226)');await db.close();});
 // ⑩-b single source: every referenced column is one the review system already serves photos from (결정 352 목록).
 await run('referenced columns are a subset of the image allowlist single source',async()=>{const a=require('../src/services/imageAllowlist.service');
  const known=new Set([...a.DRIVE_IMAGE_SOURCES,...a.GUIDE_IMAGE_SOURCES].filter(x=>x.column&&!x.contains).map(x=>x.table+'.'+x.column));known.add('review_photo_relinks.file_id'); // 재연결 기록(사용자 지정 목록) — 화면 통로는 아니지만 리뷰 사진 번호
  assert.ok(s.REFERENCE_SOURCES.length>=12);for(const x of s.REFERENCE_SOURCES)assert.ok(known.has(x.table+'.'+x.column),x.table+'.'+x.column);
  for(const x of a.PRIVATE_SOURCES)assert.ok(!s.REFERENCE_SOURCES.some(r=>r.table===x.table),'payment archive is never a reference source');});
 // ⑪ sweep jobs never block publication: deleted (404 everywhere) → superseded SOURCE_GONE at once; out of scope → superseded at the attempt cap.
 await run('sweep job: Drive-deleted superseded SOURCE_GONE, out-of-scope superseded at cap (no blocked)',async()=>{const {db,meta,deps}=await setup();const OT='othertop0001';meta[OT]={id:OT,name:'남의 폴더',mimeType:FOLDER};meta[F2]=img(F2,OT);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1),($2)',[F1,F2]);await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD]});
  await b.drainOnce({limit:1,deps});await b.drainOnce({limit:1,deps});
  let jobs=await q(db,'SELECT file_id,status,last_error_code FROM image_backup_outbox ORDER BY file_id');assert.equal(jobs[0].status,'superseded');assert.equal(jobs[0].last_error_code,'SOURCE_GONE');
  assert.equal(jobs[1].status,'retry');assert.equal(jobs[1].last_error_code,'UNRESOLVED_PATH');
  await db.query("UPDATE image_backup_outbox SET attempts=8,next_attempt_at=now() WHERE file_id=$1",[F2]);await b.drainOnce({limit:1,deps});
  jobs=await q(db,'SELECT status,last_error_code FROM image_backup_outbox WHERE file_id=$1',[F2]);assert.equal(jobs[0].status,'superseded');assert.equal(jobs[0].last_error_code,'UNRESOLVED_PATH');
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE status IN ('blocked','pending','retry','running')"))[0].n,0,'nothing left to block publication');
  // an upload job (not sweep) for a deleted file keeps today's retry semantics.
  await upload(db,'file00000009');const r=await b.drainOnce({limit:1,deps});assert.equal(r.retry,1);await db.close();});
 // ⑫ config validation fails closed.
 await run('referenced config: overlap with allowed/excluded, malformed, bad id, duplicate rejected',async()=>{
  const base={IMAGE_BACKUP_ALLOWED_ROOT_IDS:JSON.stringify([R]),IMAGE_BACKUP_EXCLUDED_ROOT_IDS:JSON.stringify([X]),IMAGE_BACKUP_ROOT_READERS:JSON.stringify([{rootId:R,readerKinds:['sa']}])};
  assert.deepEqual(s.config({...base,IMAGE_BACKUP_REFERENCED_ROOT_IDS:JSON.stringify([MYD])}).referenced,[MYD]);
  for(const v of [JSON.stringify([R]),JSON.stringify([X]),'{"a":1}','"x"',JSON.stringify(['short']),JSON.stringify([MYD,MYD]),JSON.stringify([12345678901])])assert.throws(()=>s.config({...base,IMAGE_BACKUP_REFERENCED_ROOT_IDS:v}),e=>e.code==='BACKUP_CONFIG_INVALID',v);
  assert.throws(()=>s.config({...base,IMAGE_BACKUP_REFERENCED_ROOT_IDS:'not-json'}));
  // drain skips stale descriptors whose root is no longer configured (never re-observed under an unapproved root).
  const {db,meta,deps}=await setup();meta[F1]=img(F1,MYD);await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});
  deps.referenced=[];const r=await b.drainOnce({limit:1,deps});assert.equal(r.verified,0);assert.equal(r.retry,1);assert.equal((await q(db,"SELECT last_error_code FROM image_backup_outbox ORDER BY id DESC LIMIT 1"))[0].last_error_code,'UNRESOLVED_PATH');await db.close();});
 // ⑬ referenced done job is published by the existing publisher (presence not_observed) — scan roots unchanged.
 await run('done referenced job published as not_observed; scan never enumerates referenced roots',async()=>{const {db,meta,deps}=await setup();meta[F1]=img(F1,MYD);const listed=[];const lc=deps.readers[0].listChildren;deps.readers[0].listChildren=async id=>{listed.push(id);return lc(id);};
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});await b.drainOnce({limit:1,deps});
  const objects=new Map();let current=null;Object.assign(deps.api,{putManifestPart:async({generation,part,bytes})=>{objects.set(generation+'/'+part,bytes);return {};},readManifest:async({generation,part})=>({bytes:objects.get(generation+'/'+part)}),readCurrent:async()=>current,commitManifest:async({generation,indexBytes})=>{current={v:1,generation,indexSha256:b.sha(indexBytes),etag:'e'};return current;}});
  const scan=await s.startScan({deps});let r;for(let i=0;i<20;i++){r=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});if(r.state==='complete'||r.state==='incomplete')break;}
  assert.equal(r.state,'complete',JSON.stringify(r));assert.ok(!listed.includes(MYD),'referenced root never listed');
  const part=JSON.parse(objects.get(scan.id+'/p000000'));assert.equal(part.entries.length,1);assert.equal(part.entries[0].descriptor.rootId,MYD);assert.equal(part.entries[0].presence,'not_observed');await db.close();});
 if(failures.length)throw new Error(failures.length+' case(s) failed: '+failures.join(' | '));
 console.log('PASS imageBackupReferenced: '+cases.join('; ')+' ('+cases.length+' cases)');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
