'use strict';
// Real SQL + actual lifecycle/review/staff modules. Cross-worktree modules are read-only DI,
// not a claim that the unintegrated production module graph is complete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const server = path.resolve(__dirname, '..');
const serviceFile = path.join(server, 'src/services/trackB.service.js');
const orderId = '00000000-0000-4000-8000-000000000001';
const rowId = '00000000-0000-4000-8000-000000000002';
const headers = ['결제금액', '네이버 금액', '쿠팡 금액', '비고', '리뷰', '입금'];
function sourceRoot(env) { return process.env[env] || path.resolve(server, '..'); }
const sourceFiles = [serviceFile,
  path.join(sourceRoot('DUAL_CHANNEL_LIFECYCLE_ROOT'),'server/src/services/dualChannelLifecycle.service.js'),
  ...['dualChannelReview.service.js','dualChannelStaffReview.service.js'].map(f=>path.join(sourceRoot('DUAL_CHANNEL_REVIEW_ROOT'),'server/src/services',f)),
  path.join(sourceRoot('DUAL_CHANNEL_PURCHASE_ROOT'),'server/src/services/dualPurchaseProof.service.js'),
  path.join(sourceRoot('DUAL_CHANNEL_CANCEL_ROOT'),'server/src/services/orderCancellation.service.js')];
const fingerprint = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceManifest = Object.fromEntries(sourceFiles.map(f=>[f,fingerprint(f)]));
console.log('workdesk-mutations read-only module manifest:',JSON.stringify(sourceManifest));
test.after(()=>assert.deepEqual(Object.fromEntries(sourceFiles.map(f=>[f,fingerprint(f)])),sourceManifest,'source changed during focused run'));
function load(filename, overrides = {}, source) {
  const req = createRequire(filename), module = { exports: {} };
  const localRequire = id => Object.hasOwn(overrides, id) ? overrides[id] : req(id);
  vm.runInNewContext('(function(require,module,exports,__filename,__dirname){' + (source || fs.readFileSync(filename, 'utf8')) + '\n})',
    { console, process, Buffer, setTimeout, clearTimeout, Date, URL })(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}
async function fixture({ dual = true, mutateSource, overrides = {}, fault } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE FUNCTION pg_advisory_xact_lock(integer,integer) RETURNS void LANGUAGE SQL AS 'SELECT';
    CREATE TABLE recruit_campaigns(id text PRIMARY KEY,source_work_order_id text,linked_sheet_id text,linked_tab_name text,linked_tab_gid text,work_detail jsonb);
    CREATE TABLE campaign_applications(id integer PRIMARY KEY,campaign_id text,order_submission_id uuid);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY,campaign_application_id integer,purchase_bundle_application_id integer,purchase_bundle_version integer,purchase_bundle_hash text,purchase_bundle_revision integer,purchase_condition_snapshot jsonb,purchase_identity_review jsonb,sheet_id text,tab_name text,gid text,price integer,deleted_at timestamptz,date_str text,orderer text,recipient text,updated_at timestamptz,last_edit_seq bigint);
    CREATE TABLE campaign_participants(id uuid PRIMARY KEY,seq integer,sheet_id text,tab_name text,tab_gid text,source text,order_submission_id uuid,identity_key text,phone8 text,recipient_name text,reviewer_name text,option_text text,row_json jsonb,submit_col text,submit_col2 text,active boolean DEFAULT true,deleted_at timestamptz,is_submitted boolean DEFAULT false,is_paid boolean DEFAULT false,updated_at timestamptz,updated_by text);
    CREATE TABLE raw_sheet_tabs(sheet_id text,tab_name text,tab_gid text,detected_headers jsonb,headers jsonb,mirrored_at timestamptz);
    CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,workboard_schema_version integer,sheetless boolean);
    CREATE TABLE raw_sheet_rows(sheet_id text,tab_name text,tab_gid text,row_index integer,cells jsonb);
    CREATE TABLE participant_edits(id serial PRIMARY KEY,sheet_id text,tab_name text,anchor_type text,anchor_value text,field text,kind text,value_bool boolean,value_text text,created_by text,created_at timestamptz DEFAULT now(),reverted_at timestamptz,reverted_by text);
    CREATE TABLE order_purchase_channels(order_submission_id uuid,channel text,paid_amount integer);
    CREATE TABLE purchase_capture_artifacts(id uuid,order_submission_id uuid,channel text,role text,status text,superseded_at timestamptz,revision integer,file_id text,byte_sha256 text);
    CREATE TABLE payment_batches(id uuid,historical_key text);
    CREATE TABLE payment_batch_items(id uuid,batch_id uuid,order_submission_id uuid,sheet_id text,tab_name text,row_index integer,status text,paid_at timestamptz,fail_reason text,product_price integer,review_fee integer);
    CREATE TABLE review_index(sheet_id text,tab_name text,row_index integer,is_submitted boolean, built_at timestamptz,row_json jsonb);
    CREATE TABLE review_closed_targets(sheet_id text,tab_name text,row_index integer);
    CREATE TABLE index_master(sheet_id text,tab_name text,submitted_count integer,row_count integer);
    CREATE TABLE review_submissions(id uuid,file_id text,sheet_id text,tab_name text,row_index integer,slot_key text,order_submission_id uuid,purchase_channel text,evidence_role text,evidence_revision integer,byte_sha256 text,condition_snapshot_hash text,superseded_at timestamptz,completed_at timestamptz);
    CREATE TABLE review_inspections(file_id text,status text,resolution jsonb,checks jsonb);
  `);
  const product = {option_schema_version:2,product_mode:'none',name:'상품',url:'https://example.test/p',base:{pay:300,count:1,daily:1},options:[],channels:{naver:{url:'https://example.test/n',pay:100,inflow_type:'link'},coupang:{url:'https://example.test/c',pay:200,inflow_type:'link'}}};
  const snapshot = {dualChannelProduct: product};
  await pg.query('INSERT INTO recruit_campaigns VALUES ($1,NULL,$2,$3,$4,$5)', ['campaign','sheet','tab','gid', JSON.stringify(dual ? snapshot : {})]);
  await pg.query('INSERT INTO campaign_applications VALUES (1,$1,$2)', ['campaign',orderId]);
  await pg.query(`INSERT INTO order_submissions(id,campaign_application_id,purchase_bundle_application_id,purchase_bundle_version,purchase_bundle_hash,purchase_bundle_revision,purchase_condition_snapshot,sheet_id,tab_name,gid,price) VALUES($1,1,$2,$3,$4,1,$5,'sheet','tab','gid',300)`,[orderId,dual?1:null,dual?1:null,dual?'a'.repeat(64):null,JSON.stringify(snapshot)]);
  await pg.query(`INSERT INTO campaign_participants(id,seq,sheet_id,tab_name,tab_gid,source,order_submission_id,row_json,submit_col,submit_col2) VALUES($1,1,'sheet','tab','gid','order',$2,$3,'리뷰','입금')`,[rowId,orderId,JSON.stringify(Object.fromEntries(headers.map(h=>[h,h==='결제금액'?'300':''])))]);
  await pg.query('INSERT INTO raw_sheet_tabs(sheet_id,tab_name,tab_gid,detected_headers,headers) VALUES ($1,$2,$3,$4,$4)', ['sheet','tab','gid',JSON.stringify(headers)]);
  await pg.exec(`ALTER TABLE review_index ADD submit_col text; ALTER TABLE review_index ADD submit_col2 text;`);
  await pg.exec(`INSERT INTO review_index VALUES('sheet','tab',1,false,NULL,'{}'); INSERT INTO index_master VALUES('sheet','tab',0,1)`);
  await pg.query(`INSERT INTO order_purchase_channels VALUES($1,'naver',100),($1,'coupang',200)`,[orderId]);
  const calls = []; let leased = false;
  const client = {query:async(sql,params)=>{calls.push({sql:String(sql),params,client:true});if(fault?.(String(sql),calls)) return pg.query('SELECT * FROM workdesk_injected_missing_relation');return pg.query(sql,params);},release(){leased=false;}};
  const db = {query:async(sql,params)=>{assert.equal(leased,false,'pool query while transaction holds its client');calls.push({sql:String(sql),params,client:false});return pg.query(sql,params);},connect:async()=>{assert.equal(leased,false,'nested wrapper attempts to lease another client');leased=true;return client;}};
  const lifecycle = require(path.join(sourceRoot('DUAL_CHANNEL_LIFECYCLE_ROOT'),'server/src/services/dualChannelLifecycle.service.js'));
  const reviewRoot=sourceRoot('DUAL_CHANNEL_REVIEW_ROOT');
  const proof=require(path.join(sourceRoot('DUAL_CHANNEL_PURCHASE_ROOT'),'server/src/services/dualPurchaseProof.service.js'));
  const review=load(path.join(reviewRoot,'server/src/services/dualChannelReview.service.js'),{'./dualPurchaseProof.service':proof});
  const staff=load(path.join(reviewRoot,'server/src/services/dualChannelStaffReview.service.js'),{'./dualChannelReview.service':review});
  const cancellation=load(path.join(sourceRoot('DUAL_CHANNEL_CANCEL_ROOT'),'server/src/services/orderCancellation.service.js'),{'./dualChannelLifecycle.service':lifecycle,'../db/pool':db,'../utils/sse':{emitOrderLedger(){}}});
  const injected=typeof overrides==='function'?overrides({pg,db,client,review,staff,cancellation}):overrides;
  const svc=load(serviceFile,{'../db/pool':db,'./dualChannelLifecycle.service':lifecycle,'./dualChannelReview.service':review,'./dualChannelStaffReview.service':staff,'./orderCancellation.service':cancellation,'../utils/sheetlessScope':{isSheetless:async()=>true},'./qnaSlots.service':{isQnaTab:async()=>false},...injected},mutateSource?.(fs.readFileSync(serviceFile,'utf8')));
  svc.__setPoolForTest(db); svc.__setLedgerRebuildForTest(async()=>({}));
  return {pg,svc,calls,db,client,review,snapshot,close:()=>pg.close()};
}
const args = { sheetId:'sheet',tabName:'tab',rowId,by:'tester' };
function lifecycleFirst(calls) {
  const lock=calls.findIndex(c=>c.sql.includes("hashtext('dual_channel_lifecycle')"));
  const rowLock=calls.findIndex(c=>/FOR (UPDATE|SHARE)/.test(c.sql));
  assert.ok(lock>=0 && lock<rowLock,'lifecycle must precede first business row lock');
}
async function seedReview(f, channel, { fileId = channel+'_review_file_12345', revision = 1, completed = false } = {}) {
  await f.pg.query(`INSERT INTO review_submissions(id,file_id,sheet_id,tab_name,row_index,slot_key,order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash,completed_at) VALUES(gen_random_uuid(),$1,'sheet','tab',1,$2,$3,$4,'review',$5,$6,$7,$8)`,[fileId,channel==='naver'?'review':'slot2',orderId,channel,revision,(channel==='naver'?'b':'c').repeat(64),f.review.digest(f.snapshot),completed?new Date():null]);
  return fileId;
}
test('manual review cannot complete a dual order with only the first review', async()=>{
  const f=await fixture();try{
    const first=await seedReview(f,'naver');
    const out=await f.svc.manualWorkdeskReviewSubmit({...args,fileIds:[first]});
    assert.equal(out.ok,false);assert.equal(out.error,'dual_reviews_incomplete');
    assert.equal((await f.pg.query('SELECT is_submitted FROM campaign_participants')).rows[0].is_submitted,false);
    assert.equal((await f.pg.query('SELECT completed_at FROM review_submissions')).rows[0].completed_at,null);
    lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('two snapshot reviews complete despite pending identity review and missing required cash receipts', async()=>{
  const f=await fixture();try{
    f.snapshot.cashReceiptRequired=true;
    await f.pg.query('UPDATE order_submissions SET purchase_condition_snapshot=$1,purchase_identity_review=$2',[JSON.stringify(f.snapshot),JSON.stringify({decision:'pending'})]);
    const ids=[await seedReview(f,'naver'),await seedReview(f,'coupang')];
    const out=await f.svc.manualWorkdeskReviewSubmit({...args,fileIds:ids});
    assert.equal(out.ok,true);
    assert.equal((await f.pg.query('SELECT is_submitted FROM campaign_participants')).rows[0].is_submitted,true);
    assert.equal((await f.pg.query('SELECT COUNT(*)::int AS n FROM review_submissions WHERE completed_at IS NOT NULL')).rows[0].n,2);
    lifecycleFirst(f.calls);
  }finally{await f.close();}
});
test('date-only backfill cannot bypass dual review evidence', async()=>{
  const f=await fixture();try{
    const out=await f.svc.backfillWorkdeskReviewSubmitDate({...args,value:'11/6'});
    assert.equal(out.ok,false);assert.equal(out.error,'dual_reviews_incomplete');
    assert.equal((await f.pg.query('SELECT is_submitted FROM campaign_participants')).rows[0].is_submitted,false);
    lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('undo cannot restore stale dual amount overlays; unrelated undo remains valid', async()=>{
  const f=await fixture();try{
    await f.pg.query(`INSERT INTO participant_edits(sheet_id,tab_name,anchor_type,anchor_value,field,kind,value_text) VALUES('sheet','tab','order',$1,'col:결제금액','text','999'),('sheet','tab','order',$1,'col:비고','text','note')`,[orderId]);
    const out=await f.svc.revertWorkdeskEdit({...args,field:'col:결제금액'});
    assert.equal(out.ok,false);assert.equal(out.error,'dual_amount_undo_forbidden');
    assert.equal((await f.pg.query("SELECT count(*)::int AS n FROM participant_edits WHERE reverted_at IS NULL")).rows[0].n,2);
    const note=await f.svc.revertWorkdeskEdit({...args,field:'col:비고'});
    assert.equal(note.ok,true);assert.equal(note.reverted,1);lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('manual deposit lifecycle precedes row lock and second SQL failure rolls first UPDATE back', async()=>{
  let written=false;
  const f=await fixture({fault:(sql,calls)=>{
    if(/INSERT INTO participant_edits/.test(sql)){
      written=calls.some(c=>/UPDATE campaign_participants/.test(c.sql));return true;
    }
    return false;
  }});try{
    await assert.rejects(f.svc.setWorkdeskDepositDate({...args,date:'2026-11-06'}),e=>e.code==='42P01');
    assert.equal(written,true,'first real UPDATE succeeded before the second real SQL failed');
    const row=(await f.pg.query('SELECT row_json,is_paid FROM campaign_participants')).rows[0];
    assert.equal(row.row_json['입금'],'');assert.equal(row.is_paid,false);lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('unslotted reassignment moves the real row under lifecycle and rolls back a later SQL failure', async()=>{
  let failedAfterMove=false;
  const f=await fixture({fault:(sql,calls)=>{
    if(/UPDATE order_submissions SET sheet_row/.test(sql)){
      failedAfterMove=calls.filter(c=>/UPDATE campaign_participants/.test(c.sql)).length===2;return true;
    }return false;
  }});try{
    await f.pg.exec(`ALTER TABLE campaign_participants ADD round text,ADD product_name text,ADD product_url text,ADD start_date text,ADD end_date text,ADD submitted_at timestamptz,ADD paid_at timestamptz,ADD sheet_row integer,ADD last_sheet_write_sig text;
      ALTER TABLE order_submissions ADD sheet_row integer;
      CREATE TABLE trackb_work_order_links(sheet_id text,tab_name text,work_order_id text,deleted_at timestamptz);
      CREATE TABLE work_orders(id text,recruit_count integer,linked_tab_sheet_id text,linked_tab_name text,created_at timestamptz,deleted_at timestamptz);
      INSERT INTO work_orders VALUES('work',1,'sheet','tab',NOW(),NULL);
      UPDATE campaign_participants SET seq=2,reviewer_name='참여자';
      INSERT INTO campaign_participants(id,seq,sheet_id,tab_name,tab_gid,source,row_json) VALUES('00000000-0000-4000-8000-000000000003',1,'sheet','tab','gid','slot','{"번호":"1"}');`);
    await assert.rejects(f.svc.assignUnslottedOrderToOpenSlot(args),e=>e.code==='42P01');
    assert.equal(failedAfterMove,true);
    const rows=(await f.pg.query('SELECT seq,order_submission_id,deleted_at FROM campaign_participants ORDER BY seq')).rows;
    assert.equal(rows[0].order_submission_id,null);assert.equal(rows[1].deleted_at,null);lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('independent hide fallback acquires lifecycle before the participant lock', async()=>{
  const f=await fixture();try{
    await f.pg.exec(`ALTER TABLE campaign_participants ADD first_seen_at timestamptz, ADD start_date text; UPDATE campaign_participants SET order_submission_id=NULL;`);
    const out=await f.svc.hideWorkdeskRow({...args,expectedRevision:'stale'});
    assert.equal(out.error,'row_changed');lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('live hide cancellation includes the displayed tab scope and rolls parent UPDATE back on callback refusal', async()=>{
  const f=await fixture();try{
    await f.pg.exec(`ALTER TABLE campaign_participants ADD first_seen_at timestamptz,ADD start_date text;
      ALTER TABLE order_submissions ADD canceled_by text,ADD sheet_row integer,ADD mirror_status text,ADD tab_gid text;
      CREATE FUNCTION pg_try_advisory_lock(integer,integer) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
      CREATE FUNCTION pg_advisory_unlock(integer,integer) RETURNS boolean LANGUAGE SQL AS 'SELECT true';
      INSERT INTO recruit_campaigns VALUES('original',NULL,'foreign','foreign','foreign','{}');
      UPDATE campaign_applications SET campaign_id='original';
      UPDATE order_submissions SET purchase_bundle_version=NULL,purchase_bundle_application_id=NULL,purchase_bundle_hash=NULL,sheet_id='foreign',tab_name='foreign',gid='foreign';`);
    const out=await f.svc.hideWorkdeskRow({...args,expectedRevision:'stale'});
    assert.equal(out.error,'row_changed');
    assert.equal((await f.pg.query('SELECT deleted_at FROM order_submissions')).rows[0].deleted_at,null);
    const lock=f.calls.findIndex(c=>c.sql.includes("hashtext('dual_channel_lifecycle')"));
    const mutation=f.calls.findIndex(c=>/UPDATE order_submissions SET deleted_at/.test(c.sql));
    assert.ok(lock>=0 && lock<mutation,'displayed tab lifecycle must precede cancellation UPDATE');
  }finally{await f.close();}
});

test('identity parent edit and InTx projection share one client; failing projection rolls parent back', async()=>{
  let projectionStarted=false;
  const f=await fixture({overrides:({client})=>({'./sheetlessOrder.service':{
    writeOrderToWorktable:async()=>{throw new Error('nested wrapper forbidden');},
    writeOrderToWorktableInTx:async(c,input)=>{
      assert.equal(c,client);assert.ok(input.lockedScope);projectionStarted=true;
      await c.query(`UPDATE campaign_participants SET row_json=row_json||'{"수취인":"수정"}'::jsonb WHERE id=$1`,[rowId]);
      await c.query('SELECT * FROM workdesk_projection_missing_relation');
    },
  }})});try{
    await f.pg.exec("UPDATE order_submissions SET recipient='기존'");
    await assert.rejects(f.svc.setWorkdeskIdentityField({...args,field:'recipient',value:'수정'}),e=>e.code==='42P01');
    assert.equal(projectionStarted,true);
    assert.equal((await f.pg.query('SELECT recipient FROM order_submissions')).rows[0].recipient,'기존');
    assert.equal((await f.pg.query('SELECT row_json FROM campaign_participants')).rows[0].row_json['수취인'],undefined);
    lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('purchase-date parent update rolls back when the same-client projection fails', async()=>{
  const f=await fixture({overrides:({client})=>({'./sheetlessOrder.service':{
    writeOrderToWorktable:async()=>{throw new Error('nested wrapper forbidden');},
    writeOrderToWorktableInTx:async(c,input)=>{assert.equal(c,client);assert.ok(input.lockedScope);await c.query('SELECT * FROM workdesk_date_missing_relation');},
  }})});try{
    await f.pg.exec("UPDATE order_submissions SET date_str='old'");
    await assert.rejects(f.svc.setWorkdeskPurchaseDate({...args,date:'2026-11-06'}),e=>e.code==='42P01');
    assert.equal((await f.pg.query('SELECT date_str FROM order_submissions')).rows[0].date_str,'old');lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('fallback refuses a newly attached live order instead of deleting only its board row', async()=>{
  const f=await fixture();try{
    await f.pg.exec('ALTER TABLE campaign_participants ADD first_seen_at timestamptz,ADD start_date text; UPDATE campaign_participants SET order_submission_id=NULL;');
    const original=f.db.query;
    f.db.query=async(sql,params)=>{const result=await original(sql,params);if(String(sql).includes('SELECT cp.order_submission_id AS oid'))await f.pg.query('UPDATE campaign_participants SET order_submission_id=$1',[orderId]);return result;};
    const out=await f.svc.hideWorkdeskRow(args);
    assert.equal(out.error,'row_changed');
    assert.equal((await f.pg.query('SELECT deleted_at FROM order_submissions')).rows[0].deleted_at,null);
  }finally{await f.close();}
});

test('preservation: ordinary total remains an overlay; clearing keeps split and historical fees locked', async()=>{
  const f=await fixture({dual:false});try{
    assert.equal((await f.svc.editWorkdeskRow({...args,field:'col:결제금액',value:'999'})).ok,true);
    await f.pg.exec(`ALTER TABLE payment_batch_items ADD amount integer,ADD is_qna boolean;
      UPDATE campaign_participants SET row_json=row_json||'{"입금":"11/1"}'::jsonb;
      INSERT INTO payment_batches VALUES('00000000-0000-4000-8000-000000000010',NULL),('00000000-0000-4000-8000-000000000011','historical-fee:test');
      INSERT INTO payment_batch_items(id,batch_id,sheet_id,tab_name,row_index,status,product_price,review_fee,amount) VALUES
        ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000010','sheet','tab',1,'paid',300,10,310),
        ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000010','sheet','tab',1,'paid',0,10,10),
        ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000011','sheet','tab',1,'paid',300,10,310);`);
    const out=await f.svc.setWorkdeskDepositDate({...args,date:''});
    assert.equal(out.ok,true);assert.equal(out.releasedBatchItems,1);
    assert.deepEqual((await f.pg.query('SELECT status FROM payment_batch_items ORDER BY id')).rows.map(r=>r.status),['failed','paid','paid']);
  }finally{await f.close();}
});
test('memory-only total-protection mutant persists the forbidden overlay', async()=>{
  const needle='const bundleParent = amountField && await _workdeskBundleParent(client, row);';
  const f=await fixture({mutateSource:s=>{assert.equal(s.split(needle).length,2);return s.replace(needle,'const bundleParent = false;');}});try{
    const out=await f.svc.editWorkdeskRow({...args,field:'col:결제금액',value:'999'});
    assert.equal(out.ok,true);assert.equal((await f.pg.query('SELECT value_text FROM participant_edits')).rows[0].value_text,'999');
  }finally{await f.close();}
});

test('channel amount edit uses the real staff writer and one transaction, with immutable initial hash', async()=>{
  const f=await fixture();try{
    const out=await f.svc.editWorkdeskRow({...args,field:'col:네이버 금액',value:'150'});
    assert.equal(out.ok,true);assert.equal(out.amountAmendment.price,350);
    const parent=(await f.pg.query('SELECT price,purchase_bundle_revision,purchase_bundle_hash FROM order_submissions')).rows[0];
    assert.equal(parent.price,350);assert.equal(parent.purchase_bundle_revision,2);assert.equal(parent.purchase_bundle_hash,'a'.repeat(64));
    assert.equal((await f.pg.query('SELECT row_json FROM campaign_participants')).rows[0].row_json['결제금액'],'350');
    assert.equal((await f.pg.query('SELECT * FROM participant_edits')).rows.length,0);
    assert.equal(f.calls.filter(c=>c.sql==='BEGIN').length,1);lifecycleFirst(f.calls);
  }finally{await f.close();}
});

test('dual total edits reject before any overlay INSERT; ordinary note remains editable', async()=>{
  const f=await fixture();try{
    const out=await f.svc.editWorkdeskRow({...args,field:'col:결제금액',value:'999'});
    assert.equal(out.ok,false);assert.equal(out.error,'dual_total_read_only');
    assert.equal((await f.pg.query('SELECT * FROM participant_edits')).rows.length,0);
    lifecycleFirst(f.calls);
    const note=await f.svc.editWorkdeskRow({...args,field:'col:비고',value:'정상'});
    assert.equal(note.ok,true);
    assert.equal((await f.pg.query('SELECT value_text FROM participant_edits')).rows[0].value_text,'정상');
  }finally{await f.close();}
});
