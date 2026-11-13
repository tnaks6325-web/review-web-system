'use strict';
// 결정 368 — live service: files move / get replaced while a multi-hour full scan runs.
// One changed file must never stop the whole scan; truly unknown files stay
// 'unresolved' and the scan ends honestly incomplete without publishing.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');const {PGlite}=require('@electric-sql/pglite');
const s=require('../src/services/imageBackupScan.service'),b=require('../src/services/imageBackup.service');
const FOLDER='application/vnd.google-apps.folder',MIGRATION=fs.readFileSync(path.join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8');
const api={readCurrent:async()=>null,listManifests:async()=>({items:[],truncated:false,cursor:null})};
const hints=async()=>({transferIds:new Set(),privateHints:[]});
const R='root00000001',R2='root00000002',FA='fa0000000001',FB='fb0000000001',F1='file00000001',F2='file00000002';
function drive(meta,{onList}={}){
 const clone=v=>v&&JSON.parse(JSON.stringify(v));
 return {kind:'sa',getMetadata:async id=>clone(meta[id]),listChildren:async id=>{if(onList)onList(id);return {files:Object.values(meta).filter(m=>(m.parents||[]).includes(id)).map(clone),nextPageToken:null};}};
}
const img=(id,parent,extra={})=>({id,name:'x-'+id,parents:[parent],mimeType:'image/jpeg',size:'3',version:'1',modifiedTime:'2026-11-12T00:00:00.000Z',md5Checksum:'900150983cd24fb0d6963f7d28e17f72',...extra});
async function setup(meta,roots,opts){const db=new PGlite();await db.exec(MIGRATION);const reader=drive(meta,opts);const deps={pool:db,roots,excluded:[],readers:[reader],api,loadHints:hints};return {db,reader,deps};}
const q=async(db,sql,a)=>(await db.query(sql,a)).rows;
async function steps(id,deps,n=6){let r;for(let i=0;i<n;i++)r=await s.scanStep({scanId:id,budgetMs:60000,deps});return r;}
const cases=[],failures=[];
async function run(fn){try{await fn();}catch(e){failures.push(e.message);console.error('FAIL case:',e.message);}}
(async()=>{
 // ① same file moves to another folder of the same root during the scan (production scan 3).
 await run(async()=>{const meta={[R]:{id:R,name:'root',mimeType:FOLDER},[FA]:{id:FA,name:'A',parents:[R],mimeType:FOLDER},[FB]:{id:FB,name:'B',parents:[R],mimeType:FOLDER},[F1]:img(F1,FA),[F2]:img(F2,FB)};
  const {db,deps}=await setup(meta,[{rootId:R,readerKinds:['sa']}],{onList:id=>{if(id===FB){meta[F1].parents=[FB];meta[F1].modifiedTime='2026-11-13T01:00:00.000Z';}}});
  const scan=await s.startScan({deps});const r=await steps(scan.id,deps,3);
  const st=(await q(db,'SELECT state,counts FROM image_backup_scans'))[0];
  assert.notEqual(st.counts.lastError,'AMBIGUOUS_ROOT','moved file must not stop the folder page');
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_scan_entries WHERE kind='folder' AND state<>'done'"))[0].n,0,'every folder page finishes');
  const e=(await q(db,"SELECT data,job_key,state FROM image_backup_scan_entries WHERE entry_key=$1",['file:'+F1]))[0];
  assert.equal(e.data.descriptor.chain.at(-1).id,FB,'entry follows the latest (moved) path');assert.equal(e.state,'pending');
  const jobs=await q(db,'SELECT job_key,status,observation FROM image_backup_outbox WHERE file_id=$1 ORDER BY id',[F1]);
  assert.equal(jobs.length,2,'old path job kept, new path job enqueued');assert.equal(jobs[0].status,'pending','earlier copy/job untouched');
  assert.equal(jobs[0].observation.descriptor.chain.at(-1).id,FA);assert.equal(jobs[1].job_key,e.job_key);
  await db.query("UPDATE image_backup_outbox SET status='done'");const after=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});
  assert.equal(after.cursor?.phase,'publishing','scan proceeds to publication once jobs are done');assert.ok(r);
  await db.close();cases.push('move-during-scan follows latest path, earlier job kept, scan continues');});
 // ② a job is superseded mid-scan (photo replaced): only that file is re-observed.
 await run(async()=>{const meta={[R]:{id:R,name:'root',mimeType:FOLDER},[F1]:img(F1,R),[F2]:img(F2,R)};
  const {db,deps}=await setup(meta,[{rootId:R,readerKinds:['sa']}]);const scan=await s.startScan({deps});await steps(scan.id,deps,1);
  const oldKey=(await q(db,'SELECT job_key FROM image_backup_scan_entries WHERE entry_key=$1',['file:'+F1]))[0].job_key;
  meta[F1].version='2';meta[F1].md5Checksum='e80b5017098950fc58aad83c8c14978e';meta[F1].modifiedTime='2026-11-13T02:00:00.000Z';
  await db.query("UPDATE image_backup_outbox SET status='superseded' WHERE job_key=$1",[oldKey]);await db.query("UPDATE image_backup_outbox SET status='done' WHERE file_id=$1",[F2]);
  const r=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});
  assert.notEqual((await q(db,'SELECT state FROM image_backup_scans'))[0].state,'failed','one replaced photo must not fail the whole scan');assert.equal(r.state,'running');
  const e=(await q(db,'SELECT job_key,state,data FROM image_backup_scan_entries WHERE entry_key=$1',['file:'+F1]))[0];
  assert.notEqual(e.job_key,oldKey);assert.equal(e.data.descriptor.sourceVersion,'2');assert.equal(e.state,'pending');
  assert.equal((await q(db,'SELECT status FROM image_backup_outbox WHERE job_key=$1',[e.job_key]))[0].status,'pending','replacement job enqueued');
  assert.equal((await q(db,'SELECT status FROM image_backup_outbox WHERE job_key=$1',[oldKey]))[0].status,'superseded','earlier job row kept');
  assert.equal((await q(db,'SELECT state FROM image_backup_scan_entries WHERE entry_key=$1',['file:'+F2]))[0].state,'done','other files complete');
  await db.query("UPDATE image_backup_outbox SET status='done' WHERE job_key=$1",[e.job_key]);const after=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});
  assert.equal(after.cursor?.phase,'publishing');await db.close();cases.push('superseded job re-observes only that file; others complete');});
 // ③ truly ambiguous: same file visible live under two approved roots (nested), identical modifiedTime.
 await run(async()=>{const meta={[R]:{id:R,name:'outer',mimeType:FOLDER},[R2]:{id:R2,name:'inner',parents:[R],mimeType:FOLDER},[F1]:img(F1,R2),[F2]:img(F2,R)};
  const {db,deps}=await setup(meta,[{rootId:R,readerKinds:['sa']},{rootId:R2,readerKinds:['sa']}]);const scan=await s.startScan({deps});
  let r=await steps(scan.id,deps,4);
  assert.equal((await q(db,"SELECT count(*)::int n FROM image_backup_scan_entries WHERE kind='folder' AND state<>'done'"))[0].n,0,'other folders/files keep going');
  const e=(await q(db,'SELECT state,data FROM image_backup_scan_entries WHERE entry_key=$1',['file:'+F1]))[0];assert.equal(e.state,'unresolved');assert.equal(e.data.reason,'AMBIGUOUS_ROOT');
  await db.query("UPDATE image_backup_outbox SET status='done'");r=await steps(scan.id,deps,3);
  const st=(await q(db,'SELECT state,counts FROM image_backup_scans'))[0];
  assert.equal(r.state,'incomplete');assert.equal(r.cursor.reason,'UNRESOLVED_ENTRIES');assert.equal(st.state,'incomplete','honest incomplete, not running/complete');
  assert.equal(st.counts.unresolved,1);assert.equal(st.counts.publication,undefined,'no new current publication while unresolved remains');
  await db.close();cases.push('ambiguous two-root file unresolved alone; scan incomplete, no publish, no running loop');});
 // ④ a file that keeps changing is capped, then unresolved (no endless re-observation).
 await run(async()=>{const meta={[R]:{id:R,name:'root',mimeType:FOLDER},[F1]:img(F1,R)};
  const {db,deps}=await setup(meta,[{rootId:R,readerKinds:['sa']}]);const scan=await s.startScan({deps});await steps(scan.id,deps,1);let r;
  for(let v=2;v<=s.MAX_FILE_REVISITS+3;v++){meta[F1].version=String(v);meta[F1].modifiedTime='2026-11-13T03:00:0'+(v%10)+'.000Z';await db.query("UPDATE image_backup_outbox o SET status='superseded' FROM image_backup_scan_entries e WHERE e.job_key=o.job_key AND e.entry_key=$1",['file:'+F1]);r=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});}
  const e=(await q(db,'SELECT state,data FROM image_backup_scan_entries WHERE entry_key=$1',['file:'+F1]))[0];
  assert.equal(e.state,'unresolved');assert.equal(e.data.reason,'SOURCE_UNSTABLE');
  assert.ok((await q(db,'SELECT count(*)::int n FROM image_backup_outbox'))[0].n<=s.MAX_FILE_REVISITS+1,'bounded re-enqueue');
  assert.equal(r.state,'incomplete');assert.equal(r.cursor.reason,'UNRESOLVED_ENTRIES');assert.notEqual((await q(db,'SELECT state FROM image_backup_scans'))[0].state,'failed');
  await db.close();cases.push('continuously changing file capped then unresolved');});
 // ⑤ resume of a scan already stuck by the OLD code (production scan 3 shape): no migration.
 await run(async()=>{const meta={[R]:{id:R,name:'root',mimeType:FOLDER},[FA]:{id:FA,name:'A',parents:[R],mimeType:FOLDER},[FB]:{id:FB,name:'B',parents:[R],mimeType:FOLDER},[F1]:img(F1,FA)};
  const {db,reader,deps}=await setup(meta,[{rootId:R,readerKinds:['sa']}]);const scan=await s.startScan({deps});
  const o=await s.observe({fileId:F1,rootId:R,reader,deps});await b.enqueue({...o.observation,fileId:F1,jobKey:o.jobKey},{pool:db});
  meta[F1].parents=[FB];meta[F1].modifiedTime='2026-11-13T01:00:00.000Z';const listed=JSON.parse(JSON.stringify(meta[F1]));
  await db.query("UPDATE image_backup_scan_entries SET state='done' WHERE entry_key=$1",[`folder:${R}:sa:${R}`]);
  await db.query("INSERT INTO image_backup_scan_entries(scan_id,entry_key,kind,data,job_key,state) VALUES($1,$2,'folder',$3,NULL,'done'),($1,$4,'folder',$5,NULL,'pending'),($1,$6,'file',$7,$8,'pending')",[scan.id,`folder:${R}:sa:${FA}`,JSON.stringify({rootId:R,readerKind:'sa',folderId:FA,pageToken:null,metadata:null}),`folder:${R}:sa:${FB}`,JSON.stringify({rootId:R,readerKind:'sa',folderId:FB,pageToken:null,metadata:null,page:{files:[listed],nextPageToken:null,offset:0}}),'file:'+F1,JSON.stringify(o.observation),o.jobKey]);
  await db.query("UPDATE image_backup_scans SET state='incomplete',counts='{\"lastError\":\"AMBIGUOUS_ROOT\"}'::jsonb");
  await s.scanStep({scanId:scan.id,budgetMs:60000,deps});
  assert.equal((await q(db,"SELECT state FROM image_backup_scan_entries WHERE entry_key=$1",[`folder:${R}:sa:${FB}`]))[0].state,'done','stuck page advances past the moved file');
  assert.equal((await q(db,'SELECT data FROM image_backup_scan_entries WHERE entry_key=$1',['file:'+F1]))[0].data.descriptor.chain.at(-1).id,FB);
  assert.equal((await q(db,'SELECT count(*)::int n FROM image_backup_outbox WHERE file_id=$1',[F1]))[0].n,2);
  await db.close();cases.push('old stuck scan (AMBIGUOUS_ROOT) resumes without migration');});
 // ⑥ drain: a backup job whose file moved to ANOTHER approved root is superseded by the new-root job (not retried forever).
 await run(async()=>{const meta={[R]:{id:R,name:'r1',mimeType:FOLDER},[R2]:{id:R2,name:'r2',mimeType:FOLDER},[F1]:img(F1,R)};
  const {db,reader,deps}=await setup(meta,[{rootId:R,readerKinds:['sa']},{rootId:R2,readerKinds:['sa']}]);
  const o=await s.observe({fileId:F1,rootId:R,reader,deps});await b.enqueue({...o.observation,fileId:F1,jobKey:o.jobKey},{pool:db});
  meta[F1].parents=[R2];const r=await b.drainOnce({limit:1,deps});
  const jobs=await q(db,'SELECT job_key,status,observation FROM image_backup_outbox ORDER BY id');
  assert.equal(r.retry,0,'moved-to-other-root is a new observation, not a retry');assert.equal(jobs[0].status,'superseded');
  assert.equal(jobs.length,2);assert.equal(jobs[1].observation.descriptor.rootId,R2);assert.equal(jobs[1].status,'pending');
  await db.close();cases.push('drain follows cross-root move via superseded replacement');});
 if(failures.length)throw new Error(failures.length+' case(s) failed');
 console.log('PASS imageBackupScanMoves: '+cases.join('; ')+' ('+cases.length+' cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
