'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
// No inherited production DB, webhook or network is allowed in this process.
delete process.env.DATABASE_URL;
const deny = () => { throw new Error('External IO forbidden in purchase capture checks'); };
require('pg').Pool.prototype.query = deny;
require('pg').Pool.prototype.connect = deny;
require('node:net').Socket.prototype.connect = deny;
for (const name of ['node:http','node:https']) { require(name).request=deny; require(name).get=deny; }
global.fetch=deny;
const migration = path.join(__dirname, '../migrations/220_purchase_capture_checks.sql');
const ORDER = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE reviewers(id uuid PRIMARY KEY,name text,phone text,admin_memo text);
    CREATE TABLE order_submissions(id uuid PRIMARY KEY,owner_reviewer_id uuid,sheet_id text,tab_name text,
      capture_file_id text, capture_file_id_2 text,purchase_identity_review jsonb,purchase_identity_result text,paid boolean);
    INSERT INTO reviewers VALUES('${OWNER}','본계정','01012345678',NULL);
    INSERT INTO order_submissions VALUES('${ORDER}','${OWNER}','sheet','tab','first','second','{"keep":true}','pending',false);`);
  await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/030_cs_inquiry.sql'),'utf8'));
  await db.exec(`ALTER TABLE cs_messages ADD COLUMN msg_type text NOT NULL DEFAULT 'text' CHECK(msg_type='text');
    ALTER TABLE cs_messages ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';`);
  return db;
}

test('migration executes twice and enforces request identity, status and foreign keys', async () => {
  const db = await fixture();
  try {
    const sql = fs.readFileSync(migration,'utf8');
    await db.exec(sql); await db.exec(sql);
    await db.query(`INSERT INTO purchase_capture_check_requests(order_submission_id,channel,evidence_hash) VALUES($1,'single','hash')`,[ORDER]);
    await assert.rejects(db.query(`INSERT INTO purchase_capture_check_requests(order_submission_id,channel,evidence_hash) VALUES($1,'single','hash')`,[ORDER]), /unique/i);
    await assert.rejects(db.query(`UPDATE purchase_capture_check_requests SET status='approved'`), /check constraint/i);
    await assert.rejects(db.query(`INSERT INTO purchase_capture_check_requests(order_submission_id,channel,evidence_hash) VALUES($1,'single','x')`,[OWNER]), /foreign key/i);
  } finally { await db.close(); }
});
const actor = {role:'staff',name:'직원실명'};
async function harness(channels=['single']) {
  const db = await fixture(); await db.exec(fs.readFileSync(migration,'utf8'));
  const calls = []; const notifications = [];
  const session = { ownerReviewerId: OWNER, loginPhone8: '12345678', loginName:'본계정' };
  let hash = 'hash-v1';
  let canRequestCheck = true;
  async function inspectInTx(client,args) {
    calls.push(['inspect',args]);
    if (!args.forStaff && args.session?.ownerReviewerId !== OWNER) throw Object.assign(new Error('타인 주문'),{status:403});
    const order = (await client.query('SELECT * FROM order_submissions WHERE id=$1 FOR UPDATE',[args.orderSubmissionId])).rows[0];
    if(!order) throw Object.assign(new Error('주문 없음'),{status:404});
    return {order,session:args.session,actor:args.actor,displayName:'공개 작업',participantName:'참여 명의',
      channels,evidenceByChannel:Object.fromEntries(channels.map(c=>[c,{evidenceHash:hash,photos:[{fileId:'first'},{fileId:'second'}],capabilities:{canRequestCheck}}]))};
  }
  const core = { inspectInTx,
    async withOrderTransaction(args,run) {
      calls.push(['transaction',args]);
      return db.transaction(async client => run(client,await inspectInTx(client,args)));
    },
    async viewInTx(client,ctx) {
      const request = (await client.query('SELECT id,status,note FROM purchase_capture_check_requests WHERE order_submission_id=$1 AND evidence_hash=$2',[ctx.order.id,hash])).rows[0] || null;
      return {orderSubmissionId:ctx.order.id,displayName:ctx.displayName,channels:[{channel:'single',evidenceHash:hash,reviewState:request?.status||'not_requested',request}]};
    }
  };
  const { createService } = require('../src/services/purchaseCaptureCheck.service');
  const service = createService({db,core,notify:async event=>{
    assert.equal((await db.query('SELECT count(*)::int n FROM purchase_capture_check_requests WHERE id=$1',[event.request.id])).rows[0].n,1,'notify only after committed SQL');
    notifications.push(event);
  }});
  return {db,core,service,calls,notifications,session,setHash:x=>{hash=x;},setCanRequest:x=>{canRequestCheck=x;}};
}

test('same photo request replays without duplicate messages, unread counts or notifications', async () => {
  const h=await harness();
  try {
    const args={session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1',note:'사진 확인 부탁드립니다',phone8:'99999999',campaignLabel:'공격'};
    const before=(await h.db.query('SELECT * FROM order_submissions')).rows;
    const a=await h.service.requestCheck(args); const b=await h.service.requestCheck(args);
    assert.equal(a.created,true);assert.equal(b.created,false); assert.deepEqual(b.request,a.request);
    assert.equal(a.item.channels[0].reviewState,'pending'); assert.equal(h.notifications.length,1);
    const threads=(await h.db.query('SELECT * FROM cs_threads')).rows;
    assert.equal(threads.length,1);assert.equal(threads[0].campaign_key,'sheet||tab');
    assert.equal(threads[0].reviewer_phone8,'12345678');assert.equal(threads[0].reviewer_name,'본계정');
    assert.equal(threads[0].campaign_label,'공개 작업');assert.equal(threads[0].admin_unread_count,1);
    const messages=(await h.db.query('SELECT * FROM cs_messages')).rows;
    assert.equal(messages.length,1);assert.equal(messages[0].msg_type,'text');
    assert.deepEqual(messages[0].meta,{purchaseCaptureCheck:{requestId:a.request.id,orderSubmissionId:ORDER,channel:'single',evidenceHash:'hash-v1',status:'pending'}});
    assert.deepEqual((await h.db.query('SELECT * FROM order_submissions')).rows,before);
  } finally {await h.db.close();}
});

test('committed requests replay after capabilities disable new requests without writing',async()=>{
 const h=await harness();try{
  const args={session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'};
  const a=await h.service.requestCheck(args);
  h.setCanRequest(false);
  const b=await h.service.requestCheck(args);
  assert.equal(b.created,false);assert.deepEqual(b.request,a.request);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cs_messages')).rows[0].n,1);
  assert.equal((await h.db.query('SELECT admin_unread_count n FROM cs_threads')).rows[0].n,1);
  assert.equal(h.notifications.length,1);
  h.setHash('hash-v2');
  await assert.rejects(h.service.requestCheck({...args,expectedEvidenceHash:'hash-v2'}),e=>e.status===409);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n,1);
 }finally{await h.db.close();}
});

test('staff decision is atomic, replay safe and private while reviewer state matches', async () => {
  const h=await harness();
  try {
    const before=(await h.db.query('SELECT * FROM order_submissions')).rows;
    const a=await h.service.requestCheck({session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'});
    const args={actor,requestId:a.request.id,decision:'needs_photo',note:'주문번호가 보이게 찍어주세요',expectedEvidenceHash:'hash-v1'};
    const out=await h.service.decideForStaff(args);
    assert.equal(out.request.status,'needs_photo');assert.equal(out.item.channels[0].reviewState,'needs_photo');
    const replay=await h.service.decideForStaff(args);assert.deepEqual(replay,out);
    const staff=await h.service.getForStaff({actor,requestId:a.request.id});assert.deepEqual(staff,out);
    assert(h.calls.some(c=>c[0]==='inspect'&&c[1].forStaff===true&&c[1].actor===actor));
    const messages=(await h.db.query('SELECT * FROM cs_messages ORDER BY created_at,id')).rows;
    assert.equal(messages.length,2);
    const reply=messages.find(m=>m.sender_role==='admin');assert.equal(reply.sender_name,'담당자');assert.match(reply.content,/주문번호/);
    assert.equal(reply.meta.purchaseCaptureCheck.status,'needs_photo');
    assert.equal(messages.find(m=>m.sender_role==='reviewer').meta.purchaseCaptureCheck.status,'needs_photo');
    assert(!JSON.stringify({out,messages}).includes('직원실명'));
    const history=(await h.db.query('SELECT * FROM purchase_capture_check_history')).rows;
    assert.equal(history.length,1);assert.deepEqual(history[0].actor,{role:'staff',name:'직원실명'});
    assert.equal((await h.db.query('SELECT reviewer_unread_count n FROM cs_threads')).rows[0].n,1);
    await h.service.decideForStaff({...args,decision:'confirmed',note:''});
    assert.equal((await h.service.getForStaff({actor,requestId:a.request.id})).request.status,'confirmed');
    assert.equal(h.notifications.length,1);
    assert.deepEqual((await h.db.query('SELECT * FROM order_submissions')).rows,before);
  } finally {await h.db.close();}
});

test('staff validation rejects forbidden actors before lookup, missing reasons and stale photos', async()=>{
 const h=await harness();try {
  const a=await h.service.requestCheck({session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'});
  const args={actor,requestId:a.request.id,decision:'needs_photo',note:'',expectedEvidenceHash:'hash-v1'};
  for(const bad of [null,{role:'advertiser'},{role:'reviewer'},{role:'admin',via:'reviewer_campaign'},{role:'admin',scope:'reviewer_session'},{role:'admin',aud:'reviewer-app'}]) {
   const n=h.calls.length;
   await assert.rejects(h.service.getForStaff({actor:bad,requestId:a.request.id}),e=>e.status===403);
   await assert.rejects(h.service.decideForStaff({...args,actor:bad,note:'사진 보완'}),e=>e.status===403);
   assert.equal(h.calls.length,n);
  }
  await assert.rejects(h.service.decideForStaff(args),e=>e.status===400);
  await assert.rejects(h.service.decideForStaff({...args,decision:'approved',note:'x'}),e=>e.status===400);
  await assert.rejects(h.service.decideForStaff({...args,decision:'confirmed',expectedEvidenceHash:undefined}),e=>e.status===409);
  h.setHash('hash-v2');
  await assert.rejects(h.service.decideForStaff({...args,decision:'confirmed'}),e=>e.status===409);
  assert.equal((await h.db.query('SELECT status FROM purchase_capture_check_requests')).rows[0].status,'pending');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_check_history')).rows[0].n,0);
 }finally{await h.db.close();}
});

test('production wrappers use the same database-backed factory and export staff operations',async()=>{
 const h=await harness();try {
  const vm=require('node:vm'); const filename=path.join(__dirname,'../src/services/purchaseCaptureCheck.service.js');
  const realRequire=require('node:module').createRequire(filename);
  const module={exports:{}}; let constructed=0;
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:name=>{
   if(name==='../db/pool')return h.db;
   if(name==='./purchaseCaptureSelfService.service')return {createService:({db})=>{assert.equal(db,h.db);constructed++;return h.core;}};
   return realRequire(name);
  }},{filename});
  for(const name of ['requestInTx','requestCheck','getForStaff','decideForStaff']) assert.equal(typeof module.exports[name],'function');
  const a=await module.exports.requestCheck({session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'});
  await module.exports.getForStaff({actor,requestId:a.request.id});
  await module.exports.decideForStaff({actor,requestId:a.request.id,decision:'confirmed',expectedEvidenceHash:'hash-v1'});
  assert.equal(constructed,1);
 } finally{await h.db.close();}
});

// Preservation contracts: these exercise the already-green transaction path against real SQL failures.
test('message and late unread failures roll back requests, rooms, messages and notification',async()=>{
 const h=await harness();try {
  const args={session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'};
  await h.db.exec(`ALTER TABLE cs_messages ADD CONSTRAINT forced_message_failure CHECK(content='FORCED')`);
  await assert.rejects(h.service.requestCheck(args),/forced_message_failure/);
  for(const table of ['purchase_capture_check_requests','cs_threads','cs_messages']) assert.equal((await h.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  assert.equal(h.notifications.length,0);
  await h.db.exec(`ALTER TABLE cs_messages DROP CONSTRAINT forced_message_failure;
    ALTER TABLE cs_threads ADD CONSTRAINT forced_unread_failure CHECK(admin_unread_count=0)`);
  await assert.rejects(h.service.requestCheck(args),/forced_unread_failure/);
  for(const table of ['purchase_capture_check_requests','cs_threads','cs_messages']) assert.equal((await h.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  await h.db.exec('ALTER TABLE cs_threads DROP CONSTRAINT forced_unread_failure');
  const a=await h.service.requestCheck(args);
  await h.db.exec('ALTER TABLE cs_threads ADD CONSTRAINT forced_reply_failure CHECK(reviewer_unread_count=0)');
  await assert.rejects(h.service.decideForStaff({actor,requestId:a.request.id,decision:'confirmed',expectedEvidenceHash:'hash-v1'}),/forced_reply_failure/);
  assert.equal((await h.db.query('SELECT status FROM purchase_capture_check_requests')).rows[0].status,'pending');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cs_messages')).rows[0].n,1);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_check_history')).rows[0].n,0);
  assert.equal((await h.db.query('SELECT meta FROM cs_messages')).rows[0].meta.purchaseCaptureCheck.status,'pending');
 }finally{await h.db.close();}
});

test('requestInTx shares the caller transaction and never sends notifications',async()=>{
 const h=await harness();try {
  const queries=[];
  await assert.rejects(h.db.transaction(async client=>{
   const ctx=await h.core.inspectInTx(client,{session:h.session,orderSubmissionId:ORDER});
   const traced={query:(sql,args)=>{queries.push(sql);return client.query(sql,args);}};
   const a=await h.service.requestInTx(traced,{context:ctx,channel:'single',note:'추가 사진'});
   assert.equal(a.created,true);
   const b=await h.service.requestInTx(traced,{context:ctx,channel:'single',note:'재시도'});assert.equal(b.created,false);
   assert.equal((await client.query('SELECT count(*)::int n FROM cs_messages')).rows[0].n,1);
   await client.query('SELECT * FROM intentionally_missing_for_rollback');
  }),/intentionally_missing_for_rollback/);
  assert(!queries.some(sql=>/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(sql)));
  for(const table of ['purchase_capture_check_requests','cs_threads','cs_messages']) assert.equal((await h.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  assert.equal(h.notifications.length,0);
 }finally{await h.db.close();}
});

test('changed hashes create a new check on the same room, preserve labels and reject stale decisions',async()=>{
 const h=await harness();try {
  const args={session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'};
  const [a,b]=await Promise.all([h.service.requestCheck(args),h.service.requestCheck(args)]);
  assert.equal(a.request.id,b.request.id);assert.equal([a,b].filter(x=>x.created).length,1);
  await h.db.query("UPDATE cs_threads SET campaign_label='원래 작업명',reviewer_name='원래 이름',status='closed'");
  h.setHash('hash-v2');
  await assert.rejects(h.service.requestCheck(args),e=>e.status===409);
  await assert.rejects(h.service.decideForStaff({actor,requestId:a.request.id,decision:'confirmed',expectedEvidenceHash:'hash-v2'}),e=>e.status===409);
  const c=await h.service.requestCheck({...args,expectedEvidenceHash:'hash-v2'});assert.notEqual(c.request.id,a.request.id);
  const t=(await h.db.query('SELECT * FROM cs_threads')).rows;
  assert.equal(t.length,1);assert.equal(t[0].campaign_label,'원래 작업명');assert.equal(t[0].reviewer_name,'원래 이름');
  assert.equal(t[0].admin_unread_count,2);assert.equal(t[0].status,'open');
  assert.equal(h.notifications.length,2);
 }finally{await h.db.close();}
});

test('authorization and channel failures leave all storage unchanged',async()=>{
 const h=await harness();try {
  const args={session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'};
  await assert.rejects(h.service.requestCheck({...args,session:{ownerReviewerId:'foreign'}}),e=>e.status===403);
  await assert.rejects(h.service.requestCheck({...args,channel:'naver'}),e=>e.status===409);
  await assert.rejects(h.service.requestCheck({...args,note:'x'.repeat(1001)}),e=>e.status===400);
  await assert.rejects(h.service.getForStaff({actor,requestId:'bad-uuid'}),e=>e.status===404);
  await assert.rejects(h.service.getForStaff({actor,requestId:OWNER}),e=>e.status===404);
  await h.db.query('DELETE FROM reviewers');
  await assert.rejects(h.service.requestCheck(args),e=>e.status===409);
  for(const table of ['purchase_capture_check_requests','cs_threads','cs_messages']) assert.equal((await h.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
 }finally{await h.db.close();}
});

test('deletion cascades checks/history only from orders, and detaches deleted messages',async()=>{
 const h=await harness();try {
  const a=await h.service.requestCheck({session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'});
  await h.service.decideForStaff({actor,requestId:a.request.id,decision:'confirmed',expectedEvidenceHash:'hash-v1'});
  await h.db.exec('DELETE FROM cs_messages');
  assert.equal((await h.db.query('SELECT cs_message_id FROM purchase_capture_check_requests')).rows[0].cs_message_id,null);
  assert.equal((await h.db.query('SELECT cs_message_id FROM purchase_capture_check_history')).rows[0].cs_message_id,null);
  await h.db.exec('DELETE FROM order_submissions');
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n,0);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_check_history')).rows[0].n,0);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cs_threads')).rows[0].n,1);
 }finally{await h.db.close();}
});

test('core transaction error adapter preserves checks status rather than turning stale into unavailable',async()=>{
 const h=await harness();try {
  const original=h.core.withOrderTransaction;
  h.core.withOrderTransaction=async(...args)=>{try{return await original(...args);}catch(e){
    if(e.status&&e.error)throw e;
    throw Object.assign(new Error('unavailable'),{status:503});
  }};
  await assert.rejects(h.service.requestCheck({session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'old'}),e=>e.status===409);
 }finally{await h.db.close();}
});

test('core capabilities deny new requests even if a photo hash exists',async()=>{
 const h=await harness();try {
  await h.db.transaction(async client=>{
   const ctx=await h.core.inspectInTx(client,{session:h.session,orderSubmissionId:ORDER});
   ctx.evidenceByChannel.single.capabilities.canRequestCheck=false;
   await assert.rejects(h.service.requestInTx(client,{context:ctx,channel:'single'}),e=>e.status===409);
  });
  assert.equal((await h.db.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n,0);
 }finally{await h.db.close();}
});

test('naver and coupang requests remain independent and all internal roles can inspect',async()=>{
 const h=await harness(['naver','coupang']);try {
  const before=(await h.db.query('SELECT * FROM order_submissions')).rows;
  const args={session:h.session,orderSubmissionId:ORDER,expectedEvidenceHash:'hash-v1'};
  const n=await h.service.requestCheck({...args,channel:'naver'});
  const c=await h.service.requestCheck({...args,channel:'coupang'});
  assert.notEqual(n.request.id,c.request.id);
  assert.equal((await h.service.requestCheck({...args,channel:'naver'})).created,false);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cs_threads')).rows[0].n,1);
  assert.equal((await h.db.query('SELECT admin_unread_count n FROM cs_threads')).rows[0].n,2);
  for(const role of ['master','admin','staff']){
   const out=await h.service.getForStaff({actor:{role,id:'internal-id',name:'직원'},requestId:n.request.id});
   assert.equal(out.request.id,n.request.id);
  }
  await assert.rejects(h.service.requestCheck({...args,channel:'single'}),e=>e.status===409);
  assert.deepEqual((await h.db.query('SELECT * FROM order_submissions')).rows,before);
 }finally{await h.db.close();}
});

test('internal actor identity is recorded without leaking into messages or public responses',async()=>{
 const h=await harness();try{
  const a=await h.service.requestCheck({session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'});
  const out=await h.service.decideForStaff({actor:{id:'staff-id-7',role:'staff',name:'직원실명'},requestId:a.request.id,decision:'confirmed',expectedEvidenceHash:'hash-v1'});
  assert.equal((await h.db.query('SELECT actor FROM purchase_capture_check_history')).rows[0].actor.id,'staff-id-7');
  const messages=(await h.db.query('SELECT * FROM cs_messages')).rows;
  assert(!JSON.stringify({out,messages}).includes('staff-id-7'));
 }finally{await h.db.close();}
});

test('notification failure cannot erase committed SQL or produce a second notification on replay',async()=>{
 const h=await harness();try{
  let attempted=0;
  const service=require('../src/services/purchaseCaptureCheck.service').createService({db:h.db,core:h.core,notify:async()=>{attempted++;throw new Error('fake notifier failed');}});
  const args={session:h.session,orderSubmissionId:ORDER,channel:'single',expectedEvidenceHash:'hash-v1'};
  const a=await service.requestCheck(args);assert.equal(a.created,true);
  const b=await service.requestCheck(args);assert.equal(b.created,false);assert.equal(attempted,1);
  assert.equal((await h.db.query('SELECT count(*)::int n FROM cs_messages')).rows[0].n,1);
  assert.equal((await h.db.query('SELECT admin_unread_count n FROM cs_threads')).rows[0].n,1);
 }finally{await h.db.close();}
});
