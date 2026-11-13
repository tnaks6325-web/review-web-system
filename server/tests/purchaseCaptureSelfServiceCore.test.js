'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
// Hard stop on all external database/network paths. Local WASM SQL only.
const deny=()=>{throw new Error('CORE_TEST_EXTERNAL_IO_FORBIDDEN');};
for(const name of ['http','https']){require(name).request=deny;require(name).get=deny;}
require('node:net').Socket.prototype.connect=deny;
global.fetch=async()=>deny();
const realPg=require('pg');
for(const type of [realPg.Pool,realPg.Client])for(const method of ['query','connect'])type.prototype[method]=async()=>deny();
require('dotenv').config=()=>({parsed:{}});
const migration=path.join(__dirname,'../migrations/219_capture_self_service_supplements.sql');
let passed=0,failed=0,afterCase;
async function t(name,run){try{await run();console.log('PASS '+(++passed)+' '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}finally{if(afterCase)await afterCase();}}
async function rejects(run,code,status){await assert.rejects(run,e=>e.code===code&&e.status===status&&e.error===e.message,code+' / '+status);}
(async()=>{
 const pg=new PGlite();
 try{
 await pg.exec('CREATE TABLE order_submissions(id UUID PRIMARY KEY); CREATE TABLE reviewers(id UUID PRIMARY KEY);');
 await t('additive migration exists and runs twice on real PostgreSQL SQL engine',async()=>{
  assert.ok(fs.existsSync(migration),'supplement ledger migration is missing');
  await pg.exec(fs.readFileSync(migration,'utf8'));await pg.exec(fs.readFileSync(migration,'utf8'));
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM purchase_capture_supplements')).rows[0].n,0);
 });
 }finally{await pg.close();}
 await exerciseCore();
 if(failed)throw new Error(failed+' tests failed');
 console.log('purchaseCaptureSelfServiceCore: '+passed+' passed; PGlite, fake Drive, no external connections');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

const owner='11111111-1111-4111-8111-111111111111';
const foreign='22222222-2222-4222-8222-222222222222';
const single='33333333-3333-4333-8333-333333333333';
const bundle='44444444-4444-4444-8444-444444444444';
const ident='55555555-5555-4555-8555-555555555555';
const session={ownerReviewerId:owner,loginKind:'self',loginPhone8:'12345678',loginName:'본인'};
async function fixture(){
 const pg=new PGlite();
 await pg.exec(`
 CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS 'SELECT';
 CREATE FUNCTION pg_advisory_xact_lock(integer,integer) RETURNS void LANGUAGE SQL AS 'SELECT';
 CREATE TABLE reviewers(id UUID PRIMARY KEY,name TEXT,phone8 TEXT,sub_accounts JSONB);
 CREATE TABLE reviewer_identities(id UUID PRIMARY KEY,owner_reviewer_id UUID,member_no INT,current_phone8 TEXT,status TEXT);
 CREATE TABLE reviewer_identity_cards(id UUID PRIMARY KEY,owner_reviewer_id UUID,phone8 TEXT,status TEXT,kind TEXT);
 CREATE TABLE order_submissions(id UUID PRIMARY KEY,owner_reviewer_id UUID,participant_identity_id UUID,participant_card_id UUID,
 participant_identity_key_hash TEXT,campaign_application_id INT,purchase_bundle_application_id INT,purchase_bundle_version INT,purchase_bundle_hash TEXT,
 sheet_id TEXT,tab_name TEXT,gid TEXT,tab_gid TEXT,recipient TEXT,orderer TEXT,phone TEXT,deleted_at TIMESTAMPTZ,mirror_status TEXT,
 capture_file_id TEXT,capture_file_id_2 TEXT,capture_uploaded_at TIMESTAMPTZ,capture2_uploaded_at TIMESTAMPTZ,
 delivery_memo TEXT,purchase_identity_review JSONB,purchase_identity_result TEXT,submitted_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE campaign_applications(id INT PRIMARY KEY,campaign_id TEXT,order_submission_id UUID,owner_reviewer_id UUID,participant_identity_id UUID,participant_card_id UUID,phone8 TEXT,status TEXT);
 CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY,title TEXT,channel TEXT,work_detail JSONB,options JSONB,source_work_order_id TEXT,linked_sheet_id TEXT,linked_tab_name TEXT,linked_tab_gid TEXT);
 CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,tab_gid TEXT,display_name TEXT,is_closed BOOLEAN DEFAULT false);
 CREATE TABLE trackb_tab_finished(sheet_id TEXT,tab_name TEXT,tab_gid TEXT,deleted_at TIMESTAMPTZ);
 CREATE TABLE index_master_archive(sheet_id TEXT,tab_name TEXT);
 CREATE TABLE order_purchase_channels(id UUID DEFAULT gen_random_uuid(),order_submission_id UUID,channel TEXT,recipient TEXT,phone TEXT,address TEXT);
 CREATE TABLE purchase_capture_artifacts(id UUID DEFAULT gen_random_uuid(),application_id INT,order_submission_id UUID,channel TEXT,role TEXT,revision INT,file_id TEXT,byte_sha256 TEXT,status TEXT,superseded_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now());
 CREATE TABLE purchase_capture_check_requests(id UUID DEFAULT gen_random_uuid(),order_submission_id UUID,channel TEXT,evidence_hash TEXT,status TEXT,note TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
 `);
 await pg.exec(fs.readFileSync(path.join(__dirname,'../migrations/146_purchase_submission_sessions.sql'),'utf8'));
 await pg.exec(fs.readFileSync(migration,'utf8'));
 await pg.query('INSERT INTO reviewers VALUES($1,$2,$3,$4),($5,$6,$7,$8)',[owner,'본인','12345678',JSON.stringify([{name:'다른명의',phone:'01087654321'}]),foreign,'남','99999999','[]']);
 await pg.query("INSERT INTO reviewer_identities VALUES($1,$2,1,'87654321','active')",[ident,owner]);
 for(const [id,app,version]of [[single,null,null],[bundle,1,1]])await pg.query(`INSERT INTO order_submissions(id,owner_reviewer_id,sheet_id,tab_name,recipient,phone,mirror_status,capture_file_id,capture_file_id_2,delivery_memo,purchase_identity_result,purchase_identity_review,purchase_bundle_application_id,purchase_bundle_version,purchase_bundle_hash)
 VALUES($1,$2,'s','t','받는사람','01012345678','written','original-1','original-2','원래메모','match','{"status":"approved"}',$3,$4,$5)`,[id,owner,app,version,version?'bundle-hash':null]);
 await pg.query("INSERT INTO campaign_applications VALUES(1,'c',$1,$2,NULL,NULL,'12345678','submitted')",[bundle,owner]);
 await pg.exec(`INSERT INTO recruit_campaigns VALUES('c','공고 표시명','네이버+쿠팡','{}','[]',NULL,'s','t','');INSERT INTO tab_configs VALUES('s','t','','작업표 표시명',false)`);
 for(const ch of ['naver','coupang']){
 await pg.query("INSERT INTO order_purchase_channels(order_submission_id,channel,recipient,phone,address)VALUES($1,$2,'받는사람','01012345678','주소')",[bundle,ch]);
 for(const [role,n]of [['primary',1],['supplement',2]])await pg.query("INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,status)VALUES(1,$1,$2,$3,1,$4,$5,'committed')",[bundle,ch,role,ch+'-'+n,'a'.repeat(64)]);
 }
 const db={query:(...a)=>pg.query(...a),connect:async()=>({query:(...a)=>pg.query(...a),release(){}})};
 return {pg,db};
}
async function exerciseCore(){
 await t('service contract exposes factory and transaction helpers',async()=>{
 const f=path.join(__dirname,'../src/services/purchaseCaptureSelfService.service.js');
 assert.ok(fs.existsSync(f),'core service is missing');
 const mod=require(f);for(const name of ['createService','listForReviewer','getForReviewer','addSupplement','withOrderTransaction','inspectInTx','viewInTx'])assert.equal(typeof mod[name],'function',name);
 });
 const {pg,db}=await fixture();
 try{
 const files=new Map();let uploaded=0,requested=0;
 const drive={upload:async bytes=>{const id='fake-'+(++uploaded);files.set(id,Buffer.from(bytes));return id;},read:async id=>files.get(id),trash:async()=>{throw new Error('no deletion permitted');}};
 const requestInTx=async(client,{context,channel,note})=>{
  requested++;
  const hash=context.evidenceByChannel[channel].evidenceHash;
  const row=(await client.query("INSERT INTO purchase_capture_check_requests(order_submission_id,channel,evidence_hash,status,note)VALUES($1,$2,$3,'pending',$4) RETURNING *",[context.order.id,channel,hash,note||''])).rows[0];
  return {request:{id:row.id,status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,note:row.note},created:true};
 };
 const create=extras=>require('../src/services/purchaseCaptureSelfService.service').createService({db,drive,requestInTx,...extras});
 const core=create();
 const imageBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=';
 async function uploadArgs(orderSubmissionId=single,channel='single'){
 const {item}=await core.getForReviewer({session,orderSubmissionId});
 return {session,orderSubmissionId,channel,imageBase64,mimeType:'image/png',requestCheck:true,requestKey:require('node:crypto').randomUUID(),expectedEvidenceHash:item.channels.find(c=>c.channel===channel).evidenceHash};
 }
 await t('bundle originals are saved, never called missing because the old first-photo field is empty',async()=>{
 await pg.query('UPDATE order_submissions SET capture_file_id=NULL,capture_file_id_2=NULL WHERE id=$1',[bundle]);
 const {item}=await core.getForReviewer({session,orderSubmissionId:bundle});
 assert.equal(item.displayName,'공고 표시명');assert.equal(item.channels.length,2);
 for(const c of item.channels){assert.equal(c.photos.length,2);assert.equal(c.saveState,'saved');assert.equal(c.reviewState,'not_requested');assert.match(c.evidenceHash,/^[a-f0-9]{64}$/);}
 });
 afterCase=async()=>{await pg.query("UPDATE order_submissions SET owner_reviewer_id=$1,participant_identity_id=NULL,phone='01012345678',mirror_status='written'",[owner]);await pg.query('UPDATE campaign_applications SET owner_reviewer_id=$1',[owner]);};
 await t('missing session cannot inspect an order',()=>rejects(async()=>core.getForReviewer({orderSubmissionId:single}),'REVIEWER_AUTH_REQUIRED',401));
 await t('reviewer actor cannot bypass ownership',()=>rejects(async()=>core.getForReviewer({session:{...session,ownerReviewerId:foreign},actor:{role:'master'},orderSubmissionId:single}),'CAPTURE_FORBIDDEN',403));
 await t('unknown old owner is not inferred from a matching phone',async()=>{
 await pg.query('UPDATE order_submissions SET owner_reviewer_id=NULL WHERE id=$1',[single]);
 await rejects(async()=>core.getForReviewer({session,orderSubmissionId:single}),'CAPTURE_OWNERSHIP_UNKNOWN',409);
 await pg.query('UPDATE order_submissions SET owner_reviewer_id=$2 WHERE id=$1',[single,owner]);
 });
 const sub={...session,loginKind:'sub',loginPhone8:'87654321',loginName:'다른명의'};
 await t('sub account cannot read primary orders despite sharing owner',()=>rejects(async()=>core.getForReviewer({session:sub,orderSubmissionId:single}),'CAPTURE_FORBIDDEN',403));
 await t('invalid session login phone cannot impersonate current owner',()=>rejects(async()=>core.getForReviewer({session:{...session,loginPhone8:'00000000'},orderSubmissionId:single}),'REVIEWER_AUTH_INVALID',401));
 await t('staff wrapper rejects arbitrary role',()=>rejects(async()=>core.withOrderTransaction({forStaff:true,actor:{id:'x',role:'advertiser'},orderSubmissionId:single},()=>null),'CAPTURE_STAFF_FORBIDDEN',403));
 await t('staff wrapper requires actor identity even for admin',()=>rejects(async()=>core.withOrderTransaction({forStaff:true,actor:{role:'admin'},orderSubmissionId:single},()=>null),'CAPTURE_STAFF_FORBIDDEN',403));
 await t('allowed staff receives exact server context, not injected body fields',async()=>{
 const c=await core.withOrderTransaction({forStaff:true,actor:{id:'1',role:'admin'},orderSubmissionId:single,context:{order:{id:'FAKE'}}},(client,context)=>context);
 assert.equal(c.order.id,single);assert.deepEqual(c.channels,['single']);assert.ok(c.evidenceByChannel.single.evidenceHash);assert.equal(c.displayName,'작업표 표시명');
 });
 await t('cancelled order cannot be supplemented or requested',async()=>{
 await pg.query("UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1",[single]);
 const {item}=await core.getForReviewer({session,orderSubmissionId:single});assert.equal(item.channels[0].capabilities.canAdd,false);assert.equal(item.channels[0].capabilities.canRequestCheck,false);
 await pg.query("UPDATE order_submissions SET mirror_status='written' WHERE id=$1",[single]);
 });
 await t('bundle application contradicting owner rejects even explicit order owner',async()=>{
 await pg.query('UPDATE campaign_applications SET owner_reviewer_id=$1 WHERE id=1',[foreign]);
 await rejects(async()=>core.getForReviewer({session,orderSubmissionId:bundle}),'CAPTURE_AFFINITY_CHANGED',409);
 await pg.query('UPDATE campaign_applications SET owner_reviewer_id=$1 WHERE id=1',[owner]);
 });
 await t('sub participant with stable id can read its own order',async()=>{
 await pg.query('UPDATE order_submissions SET participant_identity_id=$2,phone=$3 WHERE id=$1',[single,ident,'01087654321']);
 const {item}=await core.getForReviewer({session:sub,orderSubmissionId:single});assert.equal(item.orderSubmissionId,single);
 await pg.query('UPDATE order_submissions SET participant_identity_id=NULL,phone=$2 WHERE id=$1',[single,'01012345678']);
 });
 await t('missing order is a consistent 404, not a database outage',()=>rejects(async()=>core.getForReviewer({session,orderSubmissionId:'66666666-6666-4666-8666-666666666666'}),'CAPTURE_ORDER_NOT_FOUND',404));
 for(const [id,ch] of [[single,'single'],[bundle,'naver']])await t('append third photo and atomically request check for '+ch,async()=>{
 const orders=(await pg.query('SELECT * FROM order_submissions ORDER BY id')).rows;
 const originals=(await pg.query('SELECT * FROM purchase_capture_artifacts ORDER BY id')).rows;
 const r=await core.addSupplement(await uploadArgs(id,ch));
 const cv=r.item.channels.find(c=>c.channel===ch);
 assert.equal(cv.photos.length,3);assert.equal(cv.photos[2].isSupplement,true);assert.equal(cv.reviewState,'pending');assert.equal(r.request.id,cv.request.id);
 assert.deepEqual((await pg.query('SELECT * FROM order_submissions ORDER BY id')).rows,orders);
 assert.deepEqual((await pg.query('SELECT * FROM purchase_capture_artifacts ORDER BY id')).rows,originals);
 assert.equal(files.get(cv.photos[2].fileId).toString('base64'),imageBase64);
 });
 await t('same request replay returns its original request without uploading or creating another check',async()=>{
 const args=await uploadArgs();const first=await core.addSupplement(args),before=[uploaded,requested];
 const second=await core.addSupplement(args);
 assert.deepEqual([uploaded,requested],before);assert.equal(second.request.id,first.request.id);
 assert.equal(second.item.channels[0].photos.length,first.item.channels[0].photos.length);
 });
 await t('request key cannot be reused with another payload',async()=>{
 const args=await uploadArgs();await core.addSupplement(args);
 await rejects(async()=>core.addSupplement({...args,mimeType:'image/jpeg'}),'CAPTURE_REQUEST_CONFLICT',409);
 });
 await t('retry after another append returns the earlier request, not a newly generated request',async()=>{
 const args=await uploadArgs();const first=await core.addSupplement(args);await core.addSupplement(await uploadArgs());
 const before=requested;const replay=await core.addSupplement(args);
 assert.equal(requested,before);assert.equal(replay.request.id,first.request.id);assert.notEqual(replay.item.channels[0].request.id,first.request.id);
 });
 await t('UUID spelling cannot bypass persisted idempotency',async()=>{
 const args=await uploadArgs();const first=await core.addSupplement(args),before=uploaded;
 const replay=await core.addSupplement({...args,orderSubmissionId:args.orderSubmissionId.toUpperCase(),requestKey:args.requestKey.toUpperCase()});
 assert.equal(uploaded,before);assert.equal(replay.request.id,first.request.id);
 });
 await t('HTTP-style actor and forStaff fields cannot bypass reviewer API ownership',()=>rejects(async()=>core.getForReviewer({session:{...session,ownerReviewerId:foreign},orderSubmissionId:single,forStaff:true,actor:{id:'1',role:'admin'}}),'CAPTURE_FORBIDDEN',403));
 await t('real internal login actor uses name without invented id requirement',async()=>{
 const item=await core.withOrderTransaction({forStaff:true,actor:{name:'담당자',role:'staff'},orderSubmissionId:single},(client,context)=>core.viewInTx(client,context));assert.equal(item.orderSubmissionId,single);
 });
 await t('scoped pseudo-admin is not an internal login',()=>rejects(async()=>core.withOrderTransaction({forStaff:true,actor:{id:'1',name:'fake',role:'admin',scope:'reviewer_session'},orderSubmissionId:single},()=>null),'CAPTURE_STAFF_FORBIDDEN',403));
 await t('current evidence CAS rejects stale hash before Drive upload',async()=>{
 const args=await uploadArgs();args.expectedEvidenceHash='a'.repeat(64);const n=uploaded;
 await rejects(async()=>core.addSupplement(args),'CAPTURE_EVIDENCE_CHANGED',409);assert.equal(uploaded,n);
 });
 await t('original photo changed during upload rejects append with current hash',async()=>{
 const args=await uploadArgs(),n=(await pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n;
 const svc=create({drive:{...drive,upload:async(...a)=>{const f=await drive.upload(...a);await pg.query("UPDATE order_submissions SET capture_file_id='replacement' WHERE id=$1",[single]);return f;}}});
 await rejects(async()=>svc.addSupplement(args),'CAPTURE_EVIDENCE_CHANGED',409);
 assert.equal((await pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,n);
 await pg.query("UPDATE order_submissions SET capture_file_id='original-1' WHERE id=$1",[single]);
 });
 await t('Drive readback of different bytes cannot be called a saved photo',async()=>{
 const svc=create({drive:{...drive,read:async()=>Buffer.from('wrong bytes')}});
 await rejects(async()=>svc.addSupplement(await uploadArgs()),'CAPTURE_UPLOAD_UNVERIFIED',503);
 });
 for(const [patch,code,status]of [
 [{channel:'coupang'},'CAPTURE_CHANNEL_INVALID',409],
 [{requestKey:'bad-key'},'CAPTURE_REQUEST_INVALID',409],
 [{imageBase64:'%%%not-base64'},'CAPTURE_IMAGE_INVALID',409],
 [{imageBase64:Buffer.from('not an image').toString('base64')},'CAPTURE_IMAGE_INVALID',409],
 [{mimeType:'text/html'},'CAPTURE_IMAGE_INVALID',409],
 [{imageBase64:Buffer.alloc(8*1024*1024+1,1).toString('base64')},'CAPTURE_IMAGE_TOO_LARGE',413]
 ])await t('invalid input rejected without uploading: '+code+' '+Object.keys(patch).join(','),async()=>{
 const n=uploaded;await rejects(async()=>core.addSupplement({...await uploadArgs(),...patch}),code,status);assert.equal(uploaded,n);
 });
 await t('cancelled orders reject new uploads instead of merely disabling the button',async()=>{
 const args=await uploadArgs();await pg.query("UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1",[single]);
 await rejects(async()=>core.addSupplement(args),'CAPTURE_ORDER_CLOSED',409);
 });
 await t('query failure is a safe 503, never an empty/missing response or raw SQL error',async()=>{
 const svc=create({db:{query:async()=>{throw new Error('SECRET SQL');},connect:db.connect}});
 await rejects(async()=>svc.getForReviewer({session,orderSubmissionId:single}),'CAPTURE_UNAVAILABLE',503);
 });
 await t('home lists current actionable check requests without exposing total or sensitive context',async()=>{
 const r=await core.listForReviewer({session,limit:1});
 assert.equal(r.items.length,1);assert.equal(r.hasMore,true);
 assert.deepEqual(Object.keys(r).sort(),['hasMore','items']);
 const json=JSON.stringify(r);for(const secret of ['owner_reviewer_id','phone','account','extraction','purchase_identity_review','actor'])assert.ok(!json.includes(secret),secret);
 });
 await t('sub home never includes a different name sharing the same owner',async()=>{
 const r=await core.listForReviewer({session:sub});assert.deepEqual(r.items,[]);assert.equal(r.hasMore,false);
 });
 await t('normal old saved originals with no check request never become a new reminder',async()=>{
 await pg.query("DELETE FROM purchase_capture_check_requests WHERE order_submission_id=$1",[bundle]);
 await pg.query("UPDATE order_submissions SET submitted_at=now()-interval '100 days' WHERE id=$1",[bundle]);
 const r=await core.listForReviewer({session});assert.ok(r.items.every(i=>i.orderSubmissionId!==bundle));
 });
 await t('home query failure remains an explicit 503',async()=>{
 const svc=create({db:{query:async()=>{throw new Error('SECRET');},connect:db.connect}});
 await rejects(async()=>svc.listForReviewer({session}),'CAPTURE_UNAVAILABLE',503);
 });
 await t('unknown empty original never masquerades as confirmed missing, failed session has explicit failed evidence',async()=>{
 const id='77777777-7777-4777-8777-777777777777';
 await pg.query("INSERT INTO order_submissions(id,owner_reviewer_id,sheet_id,tab_name,recipient,phone,mirror_status)VALUES($1,$2,'s','t','받는사람','01012345678','written')",[id,owner]);
 let r=await core.getForReviewer({session,orderSubmissionId:id});assert.equal(r.item.channels[0].saveState,'unknown');
 await pg.query("INSERT INTO purchase_submission_sessions(order_submission_id,token_hash,status,failure_code)VALUES($1,'fake','failed','drive_failed')",[id]);
 r=await core.getForReviewer({session,orderSubmissionId:id});assert.equal(r.item.channels[0].saveState,'failed');
 const home=await core.listForReviewer({session});assert.ok(home.items.some(i=>i.orderSubmissionId===id));
 });
 await t('explicit order owner cannot hide a foreign participant identity',async()=>{
 await pg.query('UPDATE reviewer_identities SET owner_reviewer_id=$1 WHERE id=$2',[foreign,ident]);
 await pg.query('UPDATE order_submissions SET participant_identity_id=$1 WHERE id=$2',[ident,single]);
 try{await rejects(async()=>core.getForReviewer({session,orderSubmissionId:single}),'CAPTURE_AFFINITY_CHANGED',409);}
 finally{await pg.query('UPDATE reviewer_identities SET owner_reviewer_id=$1 WHERE id=$2',[owner,ident]);}
 });
 await t('explicit order owner cannot hide a foreign identity card',async()=>{
 await pg.query("INSERT INTO reviewer_identity_cards VALUES($1,$2,'12345678','active','sub')",[ident,foreign]);
 await pg.query('UPDATE order_submissions SET participant_card_id=$1 WHERE id=$2',[ident,single]);
 try{await rejects(async()=>core.getForReviewer({session,orderSubmissionId:single}),'CAPTURE_AFFINITY_CHANGED',409);}
 finally{await pg.query('UPDATE order_submissions SET participant_card_id=NULL WHERE id=$1',[single]);await pg.query('DELETE FROM reviewer_identity_cards');}
 });
 await t('campaign connection cannot silently point at another workboard',async()=>{
 await pg.query("UPDATE recruit_campaigns SET linked_sheet_id='foreign-work' WHERE id='c'");
 try{await rejects(async()=>core.getForReviewer({session,orderSubmissionId:bundle}),'CAPTURE_AFFINITY_CHANGED',409);}
 finally{await pg.query("UPDATE recruit_campaigns SET linked_sheet_id='s' WHERE id='c'");}
 });
 await t('bundle channels must come from actual records, not only a bundle marker',async()=>{
 await pg.query("DELETE FROM order_purchase_channels WHERE order_submission_id=$1 AND channel='coupang'",[bundle]);
 try{await rejects(async()=>core.getForReviewer({session,orderSubmissionId:bundle}),'CAPTURE_AFFINITY_CHANGED',409);}
 finally{await pg.query("INSERT INTO order_purchase_channels(order_submission_id,channel)VALUES($1,'coupang')",[bundle]);}
 });
 await t('sub login cannot recover a hashed legacy identity from phone alone',async()=>{
 await pg.query('UPDATE order_submissions SET participant_identity_key_hash=$2,phone=$3 WHERE id=$1',[single,'unknown-old-identity','01087654321']);
 try{await rejects(async()=>core.getForReviewer({session:sub,orderSubmissionId:single}),'CAPTURE_OWNERSHIP_UNKNOWN',409);}
 finally{await pg.query('UPDATE order_submissions SET participant_identity_key_hash=NULL WHERE id=$1',[single]);}
 });
 await t('pending bundle identity remains separate from photo review with a safe explanation',async()=>{
 await pg.query(`UPDATE order_submissions SET purchase_identity_review='{"status":"pending"}' WHERE id=$1`,[bundle]);
 try{const r=await core.getForReviewer({session,orderSubmissionId:bundle});assert.equal(r.item.channels[0].reviewState,'not_requested');assert.match(r.item.channels[0].reason,/명의/);}
 finally{await pg.query(`UPDATE order_submissions SET purchase_identity_review='{"status":"approved"}' WHERE id=$1`,[bundle]);}
 });
 await t('new notification descriptor survives only successful commit and is absent on replay',async()=>{
 const notification={threadId:'internal-thread',reviewerPhone8:'12345678'};
 const svc=create({requestInTx:async(...a)=>({...await requestInTx(...a),notification})});
 const args=await uploadArgs();const r=await svc.addSupplement(args);
 assert.deepEqual(r.notification,notification);assert.equal(r.created,true);
 assert.ok(!JSON.stringify({item:r.item,request:r.request}).includes('internal-thread'));
 const replay=await svc.addSupplement(args);assert.equal(replay.created,false);assert.ok(!replay.notification);
 });
 await t('direct transaction inspectors return safe consistent query errors',async()=>{
 const client={query:async()=>{throw new Error('PRIVATE SQL');}};
 await rejects(async()=>core.inspectInTx(client,{session,orderSubmissionId:single}),'CAPTURE_UNAVAILABLE',503);
 });
 await t('direct public view returns safe consistent query errors',async()=>{
 const context=await core.withOrderTransaction({session,orderSubmissionId:single},(_,context)=>context);
 await rejects(async()=>core.viewInTx({query:async()=>{throw new Error('PRIVATE SQL');}},context),'CAPTURE_UNAVAILABLE',503);
 });
 await t('preservation: Drive upload failure leaves all existing records unchanged',async()=>{
 const before=(await pg.query('SELECT * FROM purchase_capture_supplements ORDER BY id')).rows;
 const svc=create({drive:{...drive,upload:async()=>{throw new Error('provider secret');}}});
 await rejects(async()=>svc.addSupplement(await uploadArgs()),'CAPTURE_UNAVAILABLE',503);
 assert.deepEqual((await pg.query('SELECT * FROM purchase_capture_supplements ORDER BY id')).rows,before);
 });
 await t('preservation: successful supplement INSERT plus later failing SQL rolls everything back',async()=>{
 const args=await uploadArgs(),before=(await pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n;
 const requests=(await pg.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n;
 const svc=create({requestInTx:async(client,args)=>{await requestInTx(client,args);await client.query('SELECT intentional_missing_column FROM purchase_capture_supplements');}});
 const fileCount=files.size;
 await rejects(async()=>svc.addSupplement(args),'CAPTURE_UNAVAILABLE',503);
 assert.equal((await pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,before);
 assert.equal((await pg.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n,requests);
 assert.equal(files.size,fileCount+1,'uncertain file stays, never automatic deletion');
 });
 await t('preservation: COMMIT applied but reply lost retains file and replay returns single committed check',async()=>{
 const args=await uploadArgs();let didInsert=false,lost=false;
 const flaky={query:db.query,connect:async()=>({release(){},query:async(sql,params)=>{
 const r=await pg.query(sql,params);
 if(sql.startsWith('INSERT INTO purchase_capture_supplements'))didInsert=true;
 if(sql==='COMMIT'&&didInsert&&!lost){lost=true;throw new Error('commit response lost');}return r;
 }})};
 const svc=create({db:flaky}),count=files.size,before=requested;
 await rejects(async()=>svc.addSupplement(args),'CAPTURE_UNAVAILABLE',503);
 assert.equal(lost,true);assert.equal(files.size,count+1);
 const replay=await core.addSupplement(args);
 assert.equal(replay.created,false);assert.equal(requested,before+1);assert.equal(files.size,count+1);
 assert.ok(files.has(replay.item.channels[0].photos.at(-1).fileId));
 });
 await t('preservation: DB connection loss after Drive retains new unlinked file',async()=>{
 const args=await uploadArgs(),count=files.size,n=uploaded;
 const svc=create({db:{query:db.query,connect:async()=>{if(uploaded>n)throw new Error('connection lost');return db.connect();}}});
 await rejects(async()=>svc.addSupplement(args),'CAPTURE_UNAVAILABLE',503);assert.equal(files.size,count+1);
 });
 await t('preservation: two tabs interleaved between short transactions create one supplement and one check',async()=>{
 const args=await uploadArgs(),before=requested,n=(await pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n;
 let winner;
 const svc=create({drive:{...drive,upload:async(...a)=>{const file=await drive.upload(...a);winner=await core.addSupplement(args);return file;}}});
 const replay=await svc.addSupplement(args);
 assert.equal(replay.request.id,winner.request.id);assert.equal(requested,before+1);
 assert.equal((await pg.query('SELECT count(*)::int n FROM purchase_capture_supplements')).rows[0].n,n+1);
 });
 await t('preservation: late failed upload cannot overwrite or delete newer winner',async()=>{
 const args=await uploadArgs();let winner;
 const svc=create({drive:{...drive,upload:async()=>{winner=await core.addSupplement(args);throw new Error('late failed request');}}});
 await rejects(async()=>svc.addSupplement(args),'CAPTURE_UNAVAILABLE',503);
 const replay=await core.addSupplement(args);assert.equal(replay.request.id,winner.request.id);
 assert.ok(files.has(winner.item.channels[0].photos.at(-1).fileId));
 });
 await t('preservation: bundle other-channel hash and original payout identity hash never change on append',async()=>{
 const before=await core.getForReviewer({session,orderSubmissionId:bundle});
 const identityBefore=(await pg.query('SELECT purchase_identity_review,purchase_bundle_hash,purchase_identity_result FROM order_submissions WHERE id=$1',[bundle])).rows;
 const result=await core.addSupplement(await uploadArgs(bundle,'naver'));
 assert.equal(result.item.channels.find(c=>c.channel==='coupang').evidenceHash,before.item.channels.find(c=>c.channel==='coupang').evidenceHash);
 assert.deepEqual((await pg.query('SELECT purchase_identity_review,purchase_bundle_hash,purchase_identity_result FROM order_submissions WHERE id=$1',[bundle])).rows,identityBefore);
 });
 await t('preservation: old confirmation is not promoted to a newer original artifact revision',async()=>{
 const args=await uploadArgs(bundle,'naver'),r=await core.addSupplement(args);
 await pg.query("UPDATE purchase_capture_check_requests SET status='confirmed' WHERE id=$1",[r.request.id]);
 await pg.query("UPDATE purchase_capture_artifacts SET revision=revision+1 WHERE order_submission_id=$1 AND channel='naver'",[bundle]);
 const next=await core.getForReviewer({session,orderSubmissionId:bundle}),c=next.item.channels.find(c=>c.channel==='naver');
 assert.notEqual(c.evidenceHash,r.item.channels.find(c=>c.channel==='naver').evidenceHash);assert.equal(c.reviewState,'not_requested');assert.equal(c.request,null);
 });
 await t('preservation: InTx functions do not own the caller transaction',async()=>{
 const before=(await pg.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n;
 await pg.query('BEGIN');
 const ctx=await core.inspectInTx(pg,{session,orderSubmissionId:single});
 await requestInTx(pg,{context:ctx,channel:'single',note:'rollback caller'});
 await core.viewInTx(pg,ctx);await pg.query('ROLLBACK');
 assert.equal((await pg.query('SELECT count(*)::int n FROM purchase_capture_check_requests')).rows[0].n,before);
 });
 await t('array identifiers are rejected rather than coerced to UUID strings',async()=>{
 await rejects(async()=>core.getForReviewer({session,orderSubmissionId:[single]}),'CAPTURE_ORDER_INVALID',404);
 await rejects(async()=>core.addSupplement({...await uploadArgs(),requestKey:[require('node:crypto').randomUUID()]}),'CAPTURE_REQUEST_INVALID',409);
 });
 await t('inherited object keys are never accepted as image MIME validators',async()=>{
 await rejects(async()=>core.addSupplement({...await uploadArgs(),mimeType:'constructor'}),'CAPTURE_IMAGE_INVALID',409);
 });
 await t('missing work configuration closes writes without pretending the order was cancelled',async()=>{
 const args=await uploadArgs();await pg.query('DELETE FROM tab_configs');
 try{const {item}=await core.getForReviewer({session,orderSubmissionId:single});assert.equal(item.channels[0].capabilities.canAdd,false);assert.match(item.channels[0].capabilities.reason,/확인/);await rejects(async()=>core.addSupplement(args),'CAPTURE_ORDER_CLOSED',409);}
 finally{await pg.query("INSERT INTO tab_configs VALUES('s','t','','작업표 표시명',false)");}
 });
 await t('finished and archived boards are not revived by new photo reminders',async()=>{
 await pg.query("INSERT INTO trackb_tab_finished VALUES('s','t','',NULL)");
 try{const r=await core.getForReviewer({session,orderSubmissionId:single});assert.equal(r.item.channels[0].capabilities.canAdd,false);const home=await core.listForReviewer({session});assert.equal(home.items.length,0);}
 finally{await pg.query('DELETE FROM trackb_tab_finished');}
 });
 }finally{afterCase=null;await pg.close();}
}
