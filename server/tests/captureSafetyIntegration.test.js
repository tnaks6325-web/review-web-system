"use strict";
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,bundle,uuid,sha}=require('./dualChannelSchema.test');
const svc=require('../src/services/workTabDelete.service');
async function setup() {
  const db = await fixture();
  for (const table of [...svc.DELETE_TABLES,...svc.MONEY_TABLES.map(x=>x.table)]) {
    if (['order_submissions','review_submissions','payment_batch_items','campaign_participants','tab_configs'].includes(table)) continue;
    await db.exec(`CREATE TABLE IF NOT EXISTS ${table}(sheet_id TEXT,tab_name TEXT)`);
  }
  await db.exec(`CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,tab_gid TEXT,sheetless BOOLEAN);
    CREATE TABLE campaign_participants(sheet_id TEXT,tab_name TEXT,seq INTEGER,order_submission_id UUID,name TEXT,recipient TEXT,phone TEXT,is_submitted BOOLEAN,is_paid BOOLEAN);
    ALTER TABLE raw_sheet_tabs ADD COLUMN tab_gid TEXT;
    CREATE TABLE work_orders(id TEXT,title TEXT,status TEXT,created_by TEXT,deleted_at timestamptz,linked_tab_sheet_id TEXT,linked_tab_name TEXT,linked_tab_gid TEXT,tab_deleted_at timestamptz,tab_deleted_by TEXT,tab_deleted_tab TEXT,updated_at timestamptz);
    CREATE TABLE advertiser_campaigns(sheet_id TEXT,tab_gid TEXT);
    CREATE TABLE campaigns(sheet_id TEXT);
    CREATE TABLE payment_account_mismatch_reconciliations(batch_item_id UUID REFERENCES payment_batch_items(id) ON DELETE RESTRICT);
    CREATE TABLE orphan_capture_tombstones(file_id TEXT UNIQUE,file_name TEXT,sheet_id TEXT,tab_name TEXT,reviewer_name TEXT,slot_key TEXT,reason TEXT,recorded_by TEXT);
    INSERT INTO tab_configs VALUES('S','T','g',true),('S','OTHER','h',true);
    DELETE FROM payment_batch_items;
    INSERT INTO participant_edits VALUES('S','T'),('S','OTHER');`);
  await bundle(db);
  await bundle(db,3,2);
  await db.query(`UPDATE order_submissions SET sheet_id='campaign:c1',tab_name='' WHERE id=$1`,[uuid(2)]);
  await db.query(`UPDATE order_submissions SET tab_name='OTHER' WHERE id=$1`,[uuid(3)]);
  for (const [order,channel] of [[2,'naver'],[2,'coupang'],[3,'naver']]) await db.query(`INSERT INTO order_purchase_channels(order_submission_id,channel,paid_amount) VALUES($1,$2,100)`,[uuid(order),channel]);
  for (const [id,app,order,status,rev] of [[31,1,2,'committed',1],[32,3,null,'staged',1],[33,1,2,'superseded',2],[34,2,3,'committed',1]]) {
    await db.query(`INSERT INTO purchase_capture_artifacts(id,application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,superseded_at) VALUES($1,$2,$3,'naver','primary',$4,$5,$6,$6,$6,$6,$7,CASE WHEN $7='superseded' THEN NOW() ELSE NULL END)`,[uuid(id),app,order?uuid(order):null,rev,`file-${id}`,sha,status]);
  }
  const log=[];
  const client={query:async (sql,params)=>{log.push(sql);const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};},release(){}};
  return {db,log,pool:{connect:async()=>client,query:client.query},client};
}

async function supplements(db) {
 await db.exec("CREATE TABLE reviewers(id UUID PRIMARY KEY); CREATE TABLE cs_threads(id UUID PRIMARY KEY); CREATE TABLE cs_messages(id UUID PRIMARY KEY,thread_id UUID REFERENCES cs_threads(id));");
 for(const file of ['219_capture_self_service_supplements.sql','220_purchase_capture_checks.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
 await db.query('INSERT INTO reviewers VALUES($1)',[uuid(80)]);
 await db.query('INSERT INTO cs_threads VALUES($1)',[uuid(81)]);
 await db.query('INSERT INTO cs_messages VALUES($1,$2)',[uuid(82),uuid(81)]);
 for(const [n,order,channel] of [[91,1,'single'],[92,2,'naver'],[93,3,'naver']]) {
  await db.query("INSERT INTO purchase_capture_supplements(id,order_submission_id,channel,file_id,byte_sha256,mime_type,request_key,request_payload_hash,created_by) VALUES($1,$2,$3,$4,$5,'image/png',$1,$5,$6)",[uuid(n),uuid(order),channel,'supp-'+n,sha,uuid(80)]);
  await db.query("INSERT INTO purchase_capture_check_requests(id,order_submission_id,channel,evidence_hash,cs_message_id) VALUES($1,$2,$3,'hash',$4)",[uuid(n),uuid(order),channel,uuid(82)]);
  await db.query("INSERT INTO purchase_capture_check_history(request_id,status,actor,cs_message_id) VALUES($1,'confirmed','{}',$2)",[uuid(n),uuid(82)]);
 }
}
test('single and bundle supplements survive as tombstones; checks cascade, conversations and other work survive',async()=>{
 const {db,pool,log}=await setup();
 try {
  await supplements(db);
  const out=await svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false});
  assert.equal(out.ok,true);
  assert.deepEqual((await db.query("SELECT file_id FROM orphan_capture_tombstones WHERE file_id LIKE 'supp-%' ORDER BY file_id")).rows.map(r=>r.file_id),['supp-91','supp-92']);
  for(const table of ['purchase_capture_supplements','purchase_capture_check_requests','purchase_capture_check_history','cs_threads','cs_messages']) assert.equal((await db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,1,table);
  assert.ok(log.findIndex(s=>s.includes('FROM purchase_capture_supplements'))<log.findIndex(s=>s.startsWith('DELETE FROM purchase_capture_artifacts')));
 } finally {await db.close();}
});

test('all actual 219/220 columns and three tables are registered in startup preflight',async()=>{
 const {db}=await setup();
 try {
  await supplements(db);
  const src=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8'), ctx={};
  vm.runInNewContext(src.slice(src.indexOf('const REQUIRED_SCHEMA ='),src.indexOf('async function _runOneMigration')).replace('const REQUIRED_SCHEMA','this.schema').replace('const REQUIRED_TABLES','this.tables'),ctx);
  for(const table of ['purchase_capture_supplements','purchase_capture_check_requests','purchase_capture_check_history']) {
   assert.ok(ctx.tables.includes(table),table);
   const {rows}=await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table]);
   for(const {column_name:c} of rows) assert.ok(ctx.schema.some(([t,k])=>t===table&&k===c),table+'.'+c);
  }
 } finally {await db.close();}
});

function fakeDriveService(calls,db) {
 const filename=require.resolve('../src/services/workTabDelete.service');
 const localRequire=require('node:module').createRequire(filename);
 const fake={extractFolderIdFromUrl:()=> 'fake-folder-12345',trashFiles:async files=>{
  assert.equal((await db.query("SELECT count(*)::int n FROM order_submissions WHERE tab_name='T' OR sheet_id='campaign:c1'")).rows[0].n,0,'Drive only after committed deletion');
  calls.push(files); return {success:true};
 }};
 const ctx={module:{exports:{}},require:id=>id==='./drive.service'?fake:localRequire(id),console,process};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),ctx,{filename});return ctx.module.exports;
}
for(const failure of ['discovery','tombstone']) test(failure+' SQL failure preserves all evidence and prevents Drive calls',async()=>{
 const {db,pool,client,log}=await setup();
 try {
  await supplements(db);
  await db.exec("ALTER TABLE tab_configs ADD COLUMN folder_url TEXT,ADD COLUMN capture_folder_url TEXT; UPDATE tab_configs SET capture_folder_url='fake-folder-12345' WHERE tab_name='T'");
  const calls=[], service=fakeDriveService(calls,db), query=client.query;
  const tables=['order_submissions','purchase_capture_supplements','purchase_capture_check_requests','purchase_capture_check_history','orphan_capture_tombstones','purchase_capture_artifacts','tab_configs'];
  const snapshot=async()=>Promise.all(tables.map(async t=>(await db.query('SELECT to_jsonb(x) v FROM '+t+' x ORDER BY to_jsonb(x)::text')).rows));
  const before=await snapshot(); let injected=false;
  client.query=async(sql,params)=>{
   if((failure==='discovery'&&sql.includes("to_regclass('public.purchase_capture_supplements')"))||(failure==='tombstone'&&sql.includes('FROM purchase_capture_supplements s'))) {injected=true;return db.query('SELECT 1/0');}
   return query(sql,params);
  };
  await assert.rejects(service.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false,deleteDrive:true}),/division by zero/);
  assert.equal(injected,true); assert.deepEqual(await snapshot(),before); assert.equal(calls.length,0);
  assert.equal(log.filter(s=>/^\s*DELETE FROM/.test(s)).length,0,'no evidence DELETE after failed new tombstone');
 } finally {await db.close();}
});
test('fake Drive is called only after SQL commit, with additional photos already preserved',async()=>{
 const {db,pool,log}=await setup();
 try {
  await supplements(db);
  await db.exec("ALTER TABLE tab_configs ADD COLUMN folder_url TEXT,ADD COLUMN capture_folder_url TEXT; UPDATE tab_configs SET capture_folder_url='fake-folder-12345' WHERE tab_name='T'");
  const calls=[],service=fakeDriveService(calls,db);
  const result=await service.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false,deleteDrive:true});
  assert.equal(result.ok,true); assert.equal(calls.length,1); assert.ok(log.includes('COMMIT'));
  assert.equal((await db.query("SELECT count(*)::int n FROM orphan_capture_tombstones WHERE file_id LIKE 'supp-%'")).rows[0].n,2);
 } finally {await db.close();}
});

test('ordinary order supplements are preserved even when legacy database has no dual purchase tables',async()=>{
 const {db,pool}=await setup();
 try {
  await supplements(db);
  await db.exec('DROP TABLE purchase_capture_artifacts; DROP TABLE order_purchase_channels; ALTER TABLE order_submissions DROP COLUMN purchase_bundle_application_id CASCADE;');
  const result=await svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false});
  assert.equal(result.ok,true);
  assert.equal((await db.query("SELECT count(*)::int n FROM orphan_capture_tombstones WHERE file_id='supp-91'")).rows[0].n,1);
 } finally {await db.close();}
});
test('retired orphan automatic cleanup service remains absent',()=>{
 assert.equal(fs.existsSync(path.join(__dirname,'../src/services/orphanCaptureCleanup.service.js')),false);
});
