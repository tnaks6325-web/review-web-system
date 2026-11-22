'use strict';
// 결정 368 참조 사진 — PR #1855 리뷰 2건: ① 처음 백업된 참조 사진도 기간마다 다시 관찰(경로·이름·버전 변경 추적)
// ② 빈틈 찾기 진도를 표에 남겨 시간 예산이 앞 표에서 끝나도 다음 호출이 이어서 뒤 표까지 본다(마지막 표 뒤 처음으로).
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
const cursor=async db=>(await q(db,'SELECT source,after_id,version FROM image_backup_referenced_cursor WHERE id=1'))[0];
(async()=>{
 // ① a referenced photo already backed up is re-observed once per period; unchanged = no upload, no retry/blocked.
 await run('referenced done photo rechecked once per period; unchanged recheck superseded without upload',async()=>{const {db,meta,api,deps}=await setup();meta[F1]=img(F1,FA);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});await b.drainOnce({limit:1,deps});assert.equal(api.puts.length,1);
  let g=await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD],period:'2026-11'});assert.equal(g.enqueued,1,'recheck candidate for a done referenced photo');
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE job_key=$1",['ref:'+F1+':2026-11']))[0].n,1);
  g=await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD],period:'2026-11'});assert.equal(g.enqueued,0,'at most once per period');
  const r=await b.drainOnce({limit:1,deps});assert.deepEqual([r.retry,r.blocked,r.verified],[0,0,0]);assert.equal(api.puts.length,1,'unchanged recheck uploads nothing');
  const c=(await q(db,'SELECT status FROM image_backup_outbox WHERE job_key=$1',['ref:'+F1+':2026-11']))[0];assert.equal(c.status,'superseded');
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE status NOT IN ('done','superseded')"))[0].n,0,'nothing left to hold publication');await db.close();});
 await run('changed referenced photo (folder rename) gets a new observation and copy next period; earlier copy kept',async()=>{const {db,meta,api,deps}=await setup();meta[F1]=img(F1,FA);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);await upload(db,F1);await b.drainOnce({limit:1,deps});await b.drainOnce({limit:1,deps});
  meta[FA].name='A-renamed';await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD],period:'2026-12'});
  await b.drainOnce({limit:1,deps});const r=await b.drainOnce({limit:1,deps});assert.equal(r.verified,1);assert.equal(api.puts.length,2);
  const done=await q(db,"SELECT observation FROM image_backup_outbox WHERE status='done' ORDER BY id");assert.equal(done.length,2,'earlier copy job kept');
  assert.deepEqual(done.map(d=>d.observation.descriptor.chain[1].name),['A','A-renamed']);
  // a photo whose latest job sits under an APPROVED root is left to the folder scan (no recheck).
  meta[F2]=img(F2,R);await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F2]);await upload(db,F2);await b.drainOnce({limit:1,deps});await b.drainOnce({limit:1,deps});
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE file_id=$1 AND status='done'",[F2]))[0].n,1);
  await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD],period:'2027-01'});
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE job_key=$1",['ref:'+F2+':2027-01']))[0].n,0);await db.close();});
 // ② budget exhausted on a covered prefix: the durable cursor makes later calls reach later tables, then wrap.
 await run('durable cursor: budget exhaustion continues next call, reaches later tables, wraps after the last',async()=>{const {db}=await setup();
  for(const id of ['covered00001','covered00002','covered00003']){await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[id]);await b.enqueue({fileId:id,jobKey:'obs:'+id},{pool:db});}
  await db.query('INSERT INTO order_submissions(capture_file_id) VALUES($1)',['laterGap0001']);
  let t=0;const now=()=>(t+=10);const call=()=>s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD],window:2,budgetMs:15,now});
  let g=await call();assert.equal(g.enqueued,0);assert.deepEqual(await cursor(db).then(c=>[c.source,c.after_id]),['review_submissions.file_id','covered00002'],'progress persisted mid-table');
  g=await call();g=await call();assert.equal(g.enqueued,1,'later table reached across calls');
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE job_key='ref:laterGap0001'"))[0].n,1);
  for(let i=0;i<30;i++)await call();const c=await cursor(db);assert.ok(c.version>3);
  await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',['aaaFirstGap1']);for(let i=0;i<30&&!(await q(db,"SELECT 1 FROM image_backup_outbox WHERE job_key='ref:aaaFirstGap1'")).length;i++)await call();
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE job_key='ref:aaaFirstGap1'"))[0].n,1,'wraps around to the first table');await db.close();});
 await run('failing source table skipped, counted, cursor moves past it',async()=>{const {db}=await setup();await db.exec('DROP TABLE order_submissions');
  await db.query('INSERT INTO review_index(review_file_id) VALUES($1)',['afterBroken1']);
  const g=await s.enqueueReferencedGaps({pool:db,limit:10,referenced:[MYD]});assert.ok(g.failedSources>=1);
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE job_key='ref:afterBroken1'"))[0].n,1,'tables after the broken one still examined');await db.close();});
 await run('concurrent caller: stale cursor write is rejected (CAS), other caller value kept',async()=>{const {db}=await setup();await db.query('INSERT INTO review_submissions(file_id) VALUES($1)',[F1]);
  let raced=false;const pool={query:async(sql,a)=>{if(!raced&&/UPDATE image_backup_referenced_cursor/.test(sql)){raced=true;await db.query("UPDATE image_backup_referenced_cursor SET source='review_index.review_file_id',after_id='zzz',version=version+1 WHERE id=1");}return db.query(sql,a);}};
  const g=await s.enqueueReferencedGaps({pool,limit:10,referenced:[MYD]});assert.equal(g.raced,true);
  const c=await cursor(db);assert.deepEqual([c.source,c.after_id],['review_index.review_file_id','zzz'],'other caller progress not overwritten');
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_outbox WHERE job_key=$1",['ref:'+F1]))[0].n,1,'work done before the race is idempotent and kept');await db.close();});
 if(failures.length)throw new Error(failures.length+' case(s) failed: '+failures.join(' | '));
 console.log('PASS imageBackupReferencedSweep: '+cases.join('; ')+' ('+cases.length+' cases)');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
