'use strict';
// Standalone opt-in: node server/tests/imageBackupNativePg.cjs [concurrency|slow|native|expiry]
// Starts ONLY a fresh loopback PostgreSQL, never reads DATABASE_URL or Drive credentials.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFileSync}=require('node:child_process');
const {Client,Pool}=require('pg');
const scan=require('../src/services/imageBackupScan.service'),backup=require('../src/services/imageBackup.service');
const mode=process.argv[2]||'all';
const root='root00000001',FOLDER='application/vnd.google-apps.folder';
const roots=[{rootId:root,readerKinds:['sa']}];
const rootMeta={id:root,name:'root',mimeType:FOLDER};
const api={readCurrent:async()=>null,listManifests:async()=>({items:[],truncated:false})};
const hints=async()=>({transferIds:new Set(),privateHints:[]});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'image-backup-pg-'));
 const clean={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LC_ALL:'C'};
 const run=(cmd,args)=>execFileSync(cmd,args,{env:clean,encoding:'utf8',stdio:'pipe'});
 let pid,pool,a,b;
 try{
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  run('initdb',['-D',dir,'--auth=trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',dir,'-l',path.join(dir,'postgres.log'),'-o',`-h 127.0.0.1 -k '' -p ${port}`,'-w','start']);
  pid=Number(fs.readFileSync(path.join(dir,'postmaster.pid'),'utf8').split('\n')[0]);
  console.log('LOCAL PostgreSQL started PID='+pid+' port='+port);
  const cfg={host:'127.0.0.1',port,user:os.userInfo().username,database:'postgres',password:'',ssl:false,connectionTimeoutMillis:3000};
  pool=new Pool({...cfg,max:4});a=new Client(cfg);b=new Client(cfg);await a.connect();await b.connect();
  const migration=fs.readFileSync(path.join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8');
  await pool.query(migration);await pool.query(migration);
  console.log('PASS migration223 actual PostgreSQL + repeat application');
  async function reset(){await pool.query('TRUNCATE image_backup_scan_entries,image_backup_outbox,image_backup_scans RESTART IDENTITY');}
  if(mode==='all'||mode==='concurrency'){
   await backup.enqueue({fileId:'file00000001'},{pool});await backup.enqueue({fileId:'file00000002'},{pool});
   await a.query('BEGIN');const first=(await backup.claim({pool:a}))[0];
   await b.query("SET statement_timeout='2000ms'");const second=(await backup.claim({pool:b}))[0];
   assert.ok(first&&second);assert.notEqual(first.id,second.id,'SKIP LOCKED must claim other unlocked row without waiting');
   await a.query('COMMIT');assert.equal((await backup.claim({pool})).length,0);
   await pool.query("UPDATE image_backup_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[first.id]);
   assert.equal(await backup.finish({pool,job:first,status:'done',receipt:{old:true}}),false,'expired token rejected');
   const replacement=(await backup.claim({pool}))[0];assert.equal(replacement.id,first.id);assert.notEqual(replacement.lease_token,first.lease_token);
   assert.equal(await backup.finish({pool,job:first,status:'done',receipt:{old:true}}),false,'old token rejected after reclaim');
   assert.equal(await backup.finish({pool,job:replacement,status:'done',receipt:{fresh:true}}),true);
   assert.deepEqual((await pool.query('SELECT receipt FROM image_backup_outbox WHERE id=$1',[first.id])).rows[0].receipt,{fresh:true});
   // Barrier forces both callers past the initial active-scan read before either inserts.
   let arrived=0,release;const barrier=new Promise(r=>release=r);
   const readers=[{kind:'sa',getMetadata:async()=>{if(++arrived===2)release();await barrier;return rootMeta;}}];
   const deps={pool,roots,readers,api,loadHints:hints};
   const both=await Promise.all([scan.startScan({deps}),scan.startScan({deps})]);assert.equal(both[0].id,both[1].id);
   assert.equal((await pool.query('SELECT count(*)::int n FROM image_backup_scans')).rows[0].n,1);
   // Separate connection: a live scan lease must not be stolen.
   await a.query("UPDATE image_backup_scans SET lease_token='00000000-0000-4000-8000-000000000001',lease_until=now()+interval '120 seconds'");
   const busy=await scan.scanStep({scanId:both[0].id,deps:{...deps,pool:b}});assert.equal(busy.cursor.reason,'LEASE_BUSY');
   console.log('PASS two connections: SKIP LOCKED, expired/stale completion CAS, scan singleton race, live scan lease');
  }
  if(mode==='all'||mode==='slow'){
   await reset();let clock=0,stepStart=0,metadataCalls=0,listCalls=0,hintCalls=0;
   const files=Array.from({length:25},(_,i)=>({id:'file'+String(i).padStart(8,'0'),name:'x'+i,parents:[root],mimeType:'image/jpeg',size:'3',version:'1'}));
   const reader={kind:'sa',getMetadata:async()=>{metadataCalls++;return rootMeta;},listChildren:async()=>{listCalls++;return {files,nextPageToken:null};}};
   const deps={pool,roots,readers:[reader],api,now:()=>clock,loadHints:async()=>{
    hintCalls++;clock+=6000;
    // Model wall-clock expiry without waiting two minutes. Baseline tries all 25 before saving.
    if(clock-stepStart>=120000)await pool.query("UPDATE image_backup_scans SET lease_until=now()-interval '1 second'");
    return hints();
   }};
   const started=await scan.startScan({deps});
   for(let i=0;i<20;i++){
    stepStart=clock;const result=await scan.scanStep({scanId:started.id,budgetMs:10000,deps});
    const n=(await pool.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n;
    if(i===0){
     if(!n){stepStart=clock;await scan.scanStep({scanId:started.id,budgetMs:10000,deps});const again=(await pool.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n;console.log('REPRO repeated slow page: firstJobs='+n+' secondJobs='+again+' hints='+hintCalls+' listCalls='+listCalls+' modeledMs='+clock);}
     assert.ok(n>0,'slow page must durably save progress before 120-second lease expiry (baseline repeats forever)');assert.ok(hintCalls<=2,'10-second budget checked per file, not per 25-file page');}
    assert.notEqual(result.state,'complete','pending backup receipts prohibit completion');
    if(n===25)break;
   }
   assert.equal((await pool.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,25);
   assert.equal((await pool.query("SELECT count(*)::int n FROM image_backup_scan_entries WHERE kind='folder' AND state<>'done'")).rows[0].n,0);
   assert.equal(listCalls,1,'durable page cursor avoids relisting a partly processed page');
   assert.equal(hintCalls,25);assert.ok(metadataCalls<=14,'parent metadata shared within each bounded step');
   console.log('PASS slow 25-file page: '+clock+'ms modeled latency, 25 durable jobs, one list, '+metadataCalls+' parent reads, bounded steps');
  }
  if(mode==='all'||mode==='native'){
   await reset();
   const native=['document','spreadsheet','presentation','drawing','form','script','site'];
   const files=native.map((type,i)=>({id:'native'+String(i).padStart(6,'0'),name:type,parents:[root],mimeType:'application/vnd.google-apps.'+type,version:'1'}));
   files.push({id:'image0000001',name:'x',parents:[root],mimeType:'image/jpeg',size:'3',version:'1'});
   const reader={kind:'sa',getMetadata:async()=>rootMeta,listChildren:async()=>({files})};
   const deps={pool,roots,readers:[reader],api,loadHints:hints};const started=await scan.startScan({deps});
   const result=await scan.scanStep({scanId:started.id,deps});
   assert.notEqual(result.state,'incomplete','confirmed native documents must not permanently block entire folder');
   const excluded=(await pool.query("SELECT data FROM image_backup_scan_entries WHERE state='excluded'")).rows;
   assert.equal(excluded.length,7);assert.ok(excluded.every(r=>r.data.reason==='NATIVE_DOCUMENT_EXCLUDED'));
   const counts=(await pool.query('SELECT counts FROM image_backup_scans')).rows[0].counts;
   assert.equal(counts.excludedNativeDocuments,7);
   assert.equal((await pool.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,1);
   for(const mime of ['application/pdf','application/octet-stream','application/vnd.google-apps.shortcut','application/vnd.google-apps.unknown']){
    const m={id:'unknown00001',name:'unknown',parents:[root],mimeType:mime,version:'1',size:'3'};
    await assert.rejects(scan.observe({fileId:m.id,rootId:root,reader:{kind:'sa',getMetadata:async id=>id===root?rootMeta:m},deps}),{code:'UNSUPPORTED_MIME'});
   }
   await assert.rejects(scan.observe({fileId:'unknown00001',rootId:root,reader:{kind:'sa',getMetadata:async id=>id===root?rootMeta:{id,name:'x',parents:[root],mimeType:'image/jpeg',version:'1'}},deps}),{code:'UNRESOLVED_SIZE'});
   console.log('PASS native explicit exclusion reason/count; PDF, unknown binaries/native MIME, shortcut and unknown image size remain blocked');
  }
  if(mode==='all'||mode==='expiry'){
   await reset();let calls=0,lists=0;
   const reader={kind:'sa',getMetadata:async()=>rootMeta,listChildren:async()=>{lists++;return {files:[1,2].map(i=>({id:'image000000'+i,name:'x'+i,parents:[root],mimeType:'image/jpeg',size:'3',version:'1'}))};}};
   const deps={pool,roots,readers:[reader],api,loadHints:async()=>{if(++calls===2)await pool.query("UPDATE image_backup_scans SET lease_until=now()-interval '1 second'");return hints();}};
   const started=await scan.startScan({deps});const result=await scan.scanStep({scanId:started.id,deps});
   assert.equal(result.state,'incomplete');assert.equal(result.cursor.reason,'LEASE_LOST');
   assert.equal((await pool.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,1,'first file committed; expired second file writes nothing');
   assert.equal((await pool.query("SELECT (data->'page'->>'offset')::int n FROM image_backup_scan_entries WHERE kind='folder'")).rows[0].n,1);
   await scan.scanStep({scanId:started.id,deps});
   assert.equal((await pool.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,2);
   assert.equal(calls,3,'only the interrupted file is retried');assert.equal(lists,1);
   console.log('PASS individual operation past lease: honest incomplete, earlier progress kept, stale write zero, durable offset recovery');
  }
  if(mode==='all'||mode==='moves'){
   // 결정 368: move between folders and superseded job during a live scan, on real PostgreSQL.
   await reset();const FA='fa0000000001',FB='fb0000000001',F1='file00000001',F2='file00000002';
   const img=(id,p)=>({id,name:'x-'+id,parents:[p],mimeType:'image/jpeg',size:'3',version:'1',modifiedTime:'2026-11-12T00:00:00.000Z',md5Checksum:'900150983cd24fb0d6963f7d28e17f72'});
   const meta={[root]:rootMeta,[FA]:{id:FA,name:'A',parents:[root],mimeType:FOLDER},[FB]:{id:FB,name:'B',parents:[root],mimeType:FOLDER},[F1]:img(F1,FA),[F2]:img(F2,FB)};
   const clone=v=>v&&JSON.parse(JSON.stringify(v));
   const reader={kind:'sa',getMetadata:async id=>clone(meta[id]),listChildren:async id=>{if(id===FB){meta[F1].parents=[FB];meta[F1].modifiedTime='2026-11-13T01:00:00.000Z';}return {files:Object.values(meta).filter(m=>(m.parents||[]).includes(id)).map(clone),nextPageToken:null};}};
   const deps={pool,roots,readers:[reader],api,loadHints:hints,excluded:[]};const started=await scan.startScan({deps});
   for(let i=0;i<3;i++)await scan.scanStep({scanId:started.id,budgetMs:60000,deps});
   const st=(await pool.query('SELECT state,counts FROM image_backup_scans')).rows[0];assert.notEqual(st.counts.lastError,'AMBIGUOUS_ROOT');
   assert.equal((await pool.query("SELECT count(*)::int n FROM image_backup_scan_entries WHERE kind='folder' AND state<>'done'")).rows[0].n,0);
   const e=(await pool.query("SELECT data,job_key FROM image_backup_scan_entries WHERE entry_key=$1",['file:'+F1])).rows[0];assert.equal(e.data.descriptor.chain.at(-1).id,FB);
   const jobs=(await pool.query('SELECT job_key,status FROM image_backup_outbox WHERE file_id=$1 ORDER BY id',[F1])).rows;assert.equal(jobs.length,2);assert.equal(jobs[0].status,'pending');assert.equal(jobs[1].job_key,e.job_key);
   console.log('PASS real PG move during scan: latest path job enqueued, earlier job kept, pages done');
   meta[F1].version='2';meta[F1].md5Checksum='e80b5017098950fc58aad83c8c14978e';
   await pool.query("UPDATE image_backup_outbox SET status='superseded' WHERE job_key=$1",[e.job_key]);await pool.query("UPDATE image_backup_outbox SET status='done' WHERE job_key<>$1",[e.job_key]);
   const r=await scan.scanStep({scanId:started.id,budgetMs:60000,deps});assert.equal(r.state,'running');assert.notEqual((await pool.query('SELECT state FROM image_backup_scans')).rows[0].state,'failed');
   const e2=(await pool.query("SELECT data,job_key,state FROM image_backup_scan_entries WHERE entry_key=$1",['file:'+F1])).rows[0];assert.equal(e2.data.descriptor.sourceVersion,'2');assert.notEqual(e2.job_key,e.job_key);
   assert.equal((await pool.query("SELECT state FROM image_backup_scan_entries WHERE entry_key=$1",['file:'+F2])).rows[0].state,'done');
   await pool.query("UPDATE image_backup_outbox SET status='done' WHERE job_key=$1",[e2.job_key]);const p=await scan.scanStep({scanId:started.id,budgetMs:60000,deps});assert.equal(p.cursor?.phase,'publishing');
   console.log('PASS real PG superseded mid-scan: only that file re-observed, others done, scan reaches publication');
  }
 }finally{
  if(a)await a.end().catch(()=>{});if(b)await b.end().catch(()=>{});if(pool)await pool.end().catch(()=>{});
  if(!pid&&fs.existsSync(path.join(dir,'postmaster.pid')))pid=Number(fs.readFileSync(path.join(dir,'postmaster.pid'),'utf8').split('\n')[0]);
  if(pid){assert.ok(Number.isInteger(pid)&&pid>1);try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}let stopped=false;for(let i=0;i<100;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){stopped=true;break;}throw e;}await sleep(50);}assert.ok(stopped,'local PostgreSQL PID must exit');console.log('LOCAL PostgreSQL stopped PID='+pid);}
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
