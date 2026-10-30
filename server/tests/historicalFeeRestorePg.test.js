'use strict';
const assert=require('assert'),crypto=require('crypto'),{PGlite}=require('@electric-sql/pglite');
const XLSX=require('@e965/xlsx');
const {KBANK_AOA}=require('./fixtures/paymentResultFixtures');
const svc=require('../src/services/historicalFeeRestore.service');
const proof=require('../src/services/paymentProof.service');
const id=()=>crypto.randomUUID(),pid=id(),oid=id(),owner=id(),bid=id(),uid=id();
const data={
 participants:[{id:pid,sheet_id:'first',tab_name:'작업',seq:2,order_submission_id:oid,active:true,deleted_at:null,reviewer_name:'시험자',phone8:'12345678',owner_reviewer_id:owner,participant_identity_id:null,is_paid:false,row_json:JSON.stringify({입금일:'보존'})}],
 orders:[{id:oid,sheet_id:'first',tab_name:'작업',deleted_at:null,orderer:'시험자',phone:'01012345678',owner_reviewer_id:owner,participant_identity_id:null,account:'012345',depositor:'시험자',bank:'신한',review_fee_snapshot:1000}],
 index:[{id:id(),sheet_id:'first',tab_name:'작업',row_index:2,reviewer_name:'시험자',phone8:'12345678',is_submitted2:'NOT_PAID'}],
 edits:[{id:7,sheet_id:'first',tab_name:'작업',anchor_type:'order',anchor_value:oid,field:'col:비고',value_text:'10/27입금완료',created_by:'직원',reverted_at:null}],
};
const tables={participants:'campaign_participants',orders:'order_submissions',index:'review_index',edits:'participant_edits'};
async function fixture() {
 let pg;
 if(process.env.NURU_LOCAL_TEST_URL) {
  const u=new URL(process.env.NURU_LOCAL_TEST_URL);
  assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/nuru_fee_guard_test');assert.equal(u.username,'hermes_nuru_test');
  const {Pool}=require('pg');pg=new Pool({connectionString:u.toString(),max:5});pg.exec=sql=>pg.query(sql);pg.close=()=>pg.end();
 } else pg=new PGlite();
 for(const [key,rows] of Object.entries(data)) {
  const types={seq:'integer',row_index:'integer',id:key==='edits'?'integer':'text',review_fee_snapshot:'integer',active:'boolean',is_paid:'boolean'};
  await pg.exec(`CREATE TABLE ${tables[key]} (${Object.keys(rows[0]).map(k=>`"${k}" ${types[k] || 'text'}`).join(',')})`);
  for(const row of rows) await pg.query(`INSERT INTO ${tables[key]} VALUES (${Object.keys(row).map((_,i)=>'$'+(i+1))})`,Object.values(row));
 }
 await pg.exec(`
 CREATE TABLE tab_configs(sheet_id text,tab_name text,transfer_bank text);
 INSERT INTO tab_configs VALUES('first','작업','업체입금'),('second','작업','split_kbank');
 CREATE TABLE recruit_campaigns(linked_sheet_id text);
 CREATE TABLE payment_batches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bank text,status text,item_count integer,total_amount integer,created_by text,download_count integer,last_downloaded_at timestamptz,last_downloaded_by text,historical_key text UNIQUE,applied_at timestamptz,applied_by text,board_recorded_count integer,board_queued_count integer,board_skipped_count integer,board_failed_count integer,board_stamp text,board_recorded_at timestamptz,board_recorded_by text);
 CREATE TABLE payment_batch_items(id uuid PRIMARY KEY,batch_id uuid,sheet_id text,tab_name text,row_index integer,reviewer_name text,phone8 text,bank_name text,bank_code text,bank_account text,account_holder text,product_price integer,review_fee integer,amount integer,transfer_memo text,status text,paid_at timestamptz,result_status text,result_seq integer,owner_reviewer_id text,participant_identity_id text,account_source text CHECK (account_source IN ('self','sub')),account_fingerprint text,account_snapshot_fingerprint text);
 CREATE UNIQUE INDEX uq_active ON payment_batch_items(sheet_id,tab_name,row_index) WHERE status IN ('pending','paid');
 CREATE TABLE payment_records(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,reviewer_name text,row_index integer,amount text,paid_by text,paid_at timestamptz,source_key text UNIQUE);
 CREATE TABLE payment_result_uploads(id uuid,batch_id uuid,bank text,file_name text,file_blob bytea,file_sha256 text,applied boolean,file_format text DEFAULT 'xlsx');
 CREATE TABLE unconfirmed_transfer_reviews(id uuid DEFAULT gen_random_uuid(),batch_id uuid,upload_id uuid,result_seq integer,memo text,sheet_id text,tab_name text,participant_row_index integer,decision text,review_note text,reviewed_by text,UNIQUE(upload_id,result_seq));
 CREATE TABLE payment_account_mismatch_reconciliations(upload_id uuid,result_seq integer);
 CREATE TABLE payment_amount_mismatch_reconciliations(upload_id uuid,result_seq integer);
 CREATE TABLE manual_payment_marks(sheet_id text,tab_name text,row_index integer);
 CREATE TABLE ops_checks(id integer,status text,answers jsonb); INSERT INTO ops_checks VALUES(1,'open','{}');
 CREATE TABLE payment_bank_rows(bank text,traded_at timestamptz,amount integer);
 CREATE TABLE payment_bank_sync(bank text,last_synced_at timestamptz);
 `);
 const aoa=[KBANK_AOA[0],['','2026.10.27 12:42:02','신한 012345','1,000','0','시험자','입금명','시험자','이체완료']];
 // Build the official fixture shape by header names, not guessed column positions.
 const header=KBANK_AOA[0], row=KBANK_AOA[1].slice();
 for(let i=0;i<header.length;i++) {
  const h=header[i];if(/이체.*일|처리.*일/.test(h)) row[i]='2026.10.27 12:42:02';
  if(/입금계좌/.test(h))row[i]='신한 012345'; if(/이체금액/.test(h))row[i]='1,000';
  if(/받는분/.test(h))row[i]='시험자';if(/받는통장/.test(h))row[i]='입금명';if(/처리상태/.test(h))row[i]='이체완료';
 }
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([header,row]),'결과');
 const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const loaded=require('../src/utils/spreadsheetLoad').loadSheetAoa(bytes,'result.xlsx');
 const parsed=require('../src/utils/paymentResultParse').parseResultAoa(loaded.aoa,{expectBank:'kbank'});
 assert.equal(parsed.ok,true);const rr=parsed.rows[0];
 // Header vocabulary is exercised by the real parser above.
 data.orders[0].account=rr.accountDigits; data.orders[0].depositor=rr.holder;
 await pg.query('UPDATE order_submissions SET account=$1,depositor=$2',[rr.accountDigits,rr.holder]);
 await pg.query("INSERT INTO payment_batches(id,bank,status) VALUES($1,'kbank','applied')",[bid]);
 await pg.query("INSERT INTO payment_result_uploads(id,batch_id,bank,file_name,file_blob,file_sha256,applied) VALUES($1,$2,'kbank','result.xlsx',$3,$4,true)",[uid,bid,bytes,sha]);
 const m={sheetId:'first',tabName:'작업',preserveSheetId:'second',fee:1000,expectedCount:1,paidDate:'2026-10-27',expectedFileRows:1,
 sourceBatchId:bid,uploadId:uid,fileSha256:sha,checkId:1,rows:[{participantId:pid,orderId:oid,ownerId:owner,resultSeq:rr.seq,memoEditId:7,reviewFeeSnapshot:1000,paidAt:rr.transferredAtIso}]};
 let failWrite=0,writes=0;
 const wrap=conn=>({query:async (sql,args)=>{if(/^(INSERT|UPDATE|DELETE)/.test(sql.trim())){writes++;if(failWrite===writes)throw Error('injected write failure');}return conn.query(sql,args);},release(){if(conn!==pg)conn.release();}});
 const client=wrap(pg), db={connect:async()=>process.env.NURU_LOCAL_TEST_URL ? wrap(await pg.connect()) : client};
 return {pg,db,m,client,setFail:n=>{writes=0;failWrite=n;},writes:()=>writes};
}
(async()=>{
 const f=await fixture();
 try {
  const options={db:f.db,manifest:f.m,by:'test',fingerprints:{accountFingerprint:x=>x,snapshotFingerprint:()=> 'fixture'}};
  const baseline=await svc.loadState(f.pg,f.m),before=svc.digest(baseline);
  const dry=await svc.restoreHistoricalFees(options);assert.equal(dry.planned,1);assert.equal(f.writes(),0);assert.equal(dry.beforeHash,before);
  await f.pg.query("INSERT INTO payment_batch_items(id,batch_id,sheet_id,tab_name,row_index,bank_account,amount,status,paid_at) VALUES($1,$2,'unrelated','작업',99,'012345',1000,'paid',$3)",[id(),bid,f.m.rows[0].paidAt]);
  await assert.rejects(svc.restoreHistoricalFees(options),e=>e.code==='competing_payment');
  await f.pg.query("DELETE FROM payment_batch_items WHERE sheet_id='unrelated'");
  await assert.rejects(svc.restoreHistoricalFees({...options,apply:true,expectedBeforeHash:'drift',backup:async()=>{throw Error('must not backup');}}),e=>e.code==='before_state_drift');
  for(let n=1;n<=4;n++) {
   f.setFail(n);await assert.rejects(svc.restoreHistoricalFees({...options,apply:true,expectedBeforeHash:before,backup:async s=>({path:'private-fixture',beforeHash:s.beforeHash})}));
   assert.equal(svc.digest(await svc.loadState(f.pg,f.m)),before,'every financial write failure must roll back all rows');
  }
  f.setFail(0);let backed=false;
  let applied;
  const applyOptions={...options,apply:true,expectedBeforeHash:before,backup:async s=>{backed=true;return{path:'private-fixture',beforeHash:s.beforeHash};}};
  if(process.env.NURU_LOCAL_TEST_URL) {
   const lock=await f.pg.connect();await lock.query('BEGIN');await proof.lockFileProof(lock,f.m.fileSha256);
   const waiting=svc.restoreHistoricalFees(options);
   let barrier=false;
   for(let n=0;n<100;n++) {
    const r=await f.pg.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='nuru_fee_guard_test' AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'");
    if(r.rows[0].n>0){barrier=true;break;} await new Promise(r=>setTimeout(r,20));
   }
   assert(barrier,'real second connection must wait on SHA lock');assert.equal(f.writes(),0);
   await lock.query('ROLLBACK');lock.release();await waiting;
   const race=await Promise.allSettled([svc.restoreHistoricalFees(applyOptions),svc.restoreHistoricalFees(applyOptions)]);
   const inserted=race.filter(x=>x.status==='fulfilled' && x.value.inserted===1);assert.equal(inserted.length,1);
   for(const r of race)if(r.status==='rejected')assert(['40001','23505','before_state_drift'].includes(r.reason.code),r.reason.code);
   applied=inserted[0].value;console.log('real PostgreSQL SHA wait barrier and concurrent imports PASS');
  } else applied=await svc.restoreHistoricalFees({...applyOptions,backup:async s=>{assert.equal(f.writes(),0);backed=true;return{path:'private-fixture',beforeHash:s.beforeHash};}});
  assert(backed);assert.equal(applied.inserted,1);
  const again=await svc.restoreHistoricalFees(options);assert.equal(again.inserted,0);assert.equal(again.skipped,1);
  const after=await svc.loadState(f.pg,f.m);assert.equal(svc.digest(svc.protectedState(f.m,after)),dry.invariantHash);
  const u2=id();await f.pg.query('INSERT INTO payment_result_uploads(id,batch_id,bank,file_name,file_blob,file_sha256,applied) SELECT $1,batch_id,bank,file_name,file_blob,file_sha256,false FROM payment_result_uploads WHERE id=$2',[u2,uid]);
  await assert.rejects(proof.assertProofUnused(f.pg,{sha:f.m.fileSha256,uploadId:u2,resultSeq:f.m.rows[0].resultSeq}),e=>e.code==='proof_already_used');
  await f.pg.exec('DELETE FROM payment_records');
  await assert.rejects(svc.restoreHistoricalFees(options),e=>e.code==='partial_history');
  console.log('historicalFeeRestorePg: dryrun, backup barrier, rollback every write, apply, invariant, rerun, reupload, partial conflict PASS');
 }finally{await f.pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
