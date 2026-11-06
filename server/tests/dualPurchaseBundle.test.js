'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite'); const {randomUUID}=require('crypto');
const fs=require('fs');const vm=require('vm');const {createRequire}=require('module');const path=require('path');
process.env.JWT_SECRET='dual-only-test-key-no-production-123456';
function identityWithDb(db) {
 const filename=path.resolve(__dirname,'../src/services/reviewerOrderIdentity.service.js');const req=createRequire(filename);const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:n=>n==='../db/pool'?db:req(n),process,Buffer,console,setTimeout},{filename});return module.exports;
}
async function fixture(){
 const pg=new PGlite();const db={query:(...a)=>pg.query(...a),connect:async()=>({...db,release(){}})};
 await pg.exec(`CREATE TABLE reviewers(id uuid PRIMARY KEY,name text,phone text,phone8 text,address text,bank_name text,bank_account text,account_holder text,sub_accounts jsonb,shopping_id text,reviewer_no int);
 CREATE TABLE reviewer_delivery_addresses(id uuid,recipient text,address text,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identity_cards(id uuid,kind text,name_key text,phone8 text,status text,merged_into uuid,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identities(id uuid,member_no int,current_name text,current_phone text,current_phone8 text,shopping_id text,owner_reviewer_id uuid,status text);
 CREATE TABLE recruit_campaigns(id text PRIMARY KEY,multi_account_mode boolean,work_detail jsonb);
 CREATE TABLE campaign_applications(id int PRIMARY KEY,campaign_id text,applicant_name text,applicant_phone text,phone8 text,owner_phone8 text,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,status text,expires_at timestamptz,hold_token text,order_submission_id uuid);
 CREATE TABLE reviewer_identity_match_audits(campaign_application_id int,owner_reviewer_id uuid,participant_identity_id uuid,selected_identity_hash text,image_hash text,extracted_fields_hash text,status text,approval_mode text,reason_codes jsonb);
 CREATE TABLE order_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,gid text,tab_gid text,orderer text,recipient text,user_id text,phone text,address text,order_num text,date_str text,bank text,account text,depositor text,price text,memo text,source text,dedup_key text,mirror_status text,owner_reviewer_id uuid,participant_card_id uuid,participant_identity_key_hash text,purchase_bundle_version int,purchase_bundle_application_id int UNIQUE,purchase_bundle_hash text,purchase_condition_snapshot jsonb,purchase_identity_result text,purchase_identity_review jsonb,purchase_bundle_revision int,deleted_at timestamptz);
 CREATE TABLE order_purchase_channels(order_submission_id uuid,channel text,order_num text,user_id text,recipient text,phone text,address text,paid_amount int CHECK(paid_amount>=0),identity_result jsonb,PRIMARY KEY(order_submission_id,channel));
 CREATE TABLE review_submissions(file_id text,order_submission_id uuid,purchase_channel text,evidence_role text,byte_sha256 text);
 CREATE TABLE purchase_capture_artifacts(id uuid PRIMARY KEY,application_id int,order_submission_id uuid,channel text,role text,revision int,file_id text,byte_sha256 text,extraction_json jsonb,extraction_proof_hash text,final_input_hash text,condition_snapshot_hash text,status text,superseded_at timestamptz,created_by text,created_at timestamptz DEFAULT now(),UNIQUE(application_id,channel,role,revision));`);
 const owner=randomUUID(); const product={channels:{naver:{pay:9000},coupang:{pay:10000}}};
 await db.query(`INSERT INTO reviewers VALUES($1,'김하나','01012345678','12345678','서울 강남대로 1 101호','은행','123','김하나','[]','id',1)`,[owner]);
 await db.query(`INSERT INTO recruit_campaigns VALUES('camp',false,$1)`,[{dualChannelProduct:product}]);
 await db.query(`INSERT INTO campaign_applications VALUES(7,'camp','김하나','01012345678','12345678','12345678',$1,NULL,NULL,'held',now()+interval '1 hour','hold',NULL)`,[owner]);
 const identity=identityWithDb(db);const files=new Map();let uploads=0;
 const drive={upload:async bytes=>{const id='file-'+(++uploads);files.set(id,bytes);return id;},read:async id=>files.get(id)};
 const runtime={assertDualChannelReady(){}};
 const lifecycle={withDualLifecycleInTx:async({db,run})=>{const c=await db.connect();await c.query('BEGIN');try{const x=await run(c);await c.query('COMMIT');return x;}catch(e){await c.query('ROLLBACK');throw e;}}};
 await db.query('ALTER TABLE order_submissions ADD COLUMN capture_flags jsonb, ADD COLUMN participant_identity_id uuid');
 const service=require('../src/services/dualPurchaseSubmission.service').createService({db,identity,drive,runtime,lifecycle,resolveFolder:async()=> 'test-server-folder',confirmHoldInTx:async(c,o)=>{await c.query('UPDATE campaign_applications SET order_submission_id=$2,status=\'confirmed\' WHERE id=$1',[7,o.orderSubmissionId]);return 'confirmed';}});
 const body={campaignApplicationId:7,campaignId:'camp',campaignHoldToken:'hold',bank:'은행',account:'123',depositor:'김하나',purchases:{}};const reviewerSession={ownerReviewerId:owner};
 for(const channel of ['naver','coupang']){
  const paidAmount=product.channels[channel].pay;const imageBase64=channel==='naver'?'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const extracted={recipient:'김하나',phone:'01012345678',address:'서울 강남대로 1 101호',orderNumber:channel+'123456',price:String(paidAmount),store:channel};
  const purchase={orderNum:extracted.orderNumber,userId:channel+'-id',recipient:extracted.recipient,phone:extracted.phone,address:extracted.address,paidAmount};
  const context=await identity.resolveApplicationIdentity({ownerReviewerId:owner,applicationId:7,campaignId:'camp',holdToken:'hold'},db);
  const proof=require('../src/services/dualPurchaseProof.service').issueChannelExtraction({context,channel,role:'primary',revision:1,imageBase64,extracted,ok:true});
  const approval=await identity.matchCapture({applicationId:7,campaignId:'camp',holdToken:'hold',extractToken:proof.extractToken,extracted},reviewerSession);
  assert.equal(approval.status,'MATCH');
  const artifact=await service.stagePurchaseArtifact({body:{...body,channel,role:'primary',revision:1,imageBase64,extracted,extractionToken:proof.extractionToken,identityApprovalToken:approval.approvalToken,purchase},reviewerSession});
  body.purchases[channel]={...purchase,primaryArtifactId:artifact.id};
 }
 return {pg,db,service,body,reviewerSession,files};
}
test('two real identity-approved staged photos commit one parent/two children and replay the same parent',async()=>{
 const f=await fixture();try{
 const approved=await f.service.issueBundleApproval({body:f.body,reviewerSession:f.reviewerSession});f.body.bundleApprovalToken=approved.bundleApprovalToken;
 const missing=JSON.parse(JSON.stringify(f.body));delete missing.purchases.coupang;
 await assert.rejects(f.service.prepareBundle({body:missing,reviewerSession:f.reviewerSession}),e=>e.code==='DUAL_TWO_PRIMARY_REQUIRED');
 await assert.rejects(f.service.persistBundle({purchaseBundle:{},sheetId:'campaign:camp',tabName:'작업'}),e=>e.code==='DUAL_COMMAND_REQUIRED');
 const command=await f.service.prepareBundle({body:f.body,reviewerSession:f.reviewerSession});
 const originalQuery=f.db.query;let childWrites=0;
 f.db.query=async(sql,args)=>{
  if(sql.startsWith('INSERT INTO order_purchase_channels') && ++childWrites===2)return originalQuery('SELECT * FROM deliberately_missing_dual_table');
  return originalQuery(sql,args);
 };
 await assert.rejects(f.service.persistBundle({purchaseBundle:command,sheetId:'campaign:camp',tabName:'작업',orderData:{}}),e=>e.code==='42P01');
 f.db.query=originalQuery;
 assert.equal((await f.db.query('SELECT * FROM order_submissions')).rows.length,0);
 assert.equal((await f.db.query('SELECT * FROM order_purchase_channels')).rows.length,0);
 assert.equal((await f.db.query("SELECT * FROM purchase_capture_artifacts WHERE status='staged' AND order_submission_id IS NULL")).rows.length,2);
 const fileId=(await f.db.query('SELECT file_id FROM purchase_capture_artifacts LIMIT 1')).rows[0].file_id;
 const oldBytes=f.files.get(fileId);f.files.set(fileId,Buffer.from('swapped actual downloaded bytes'));
 await assert.rejects(f.service.persistBundle({purchaseBundle:command,sheetId:'campaign:camp',tabName:'작업'}),e=>e.code==='DUAL_FILE_BYTES_CHANGED');
 f.files.set(fileId,oldBytes);
 const ledger=require('../src/services/orderLedger.service');ledger.__setPoolForTest(f.db);
 const first=await ledger.createOrderLedgerEntry({purchaseBundle:command,sheetId:'campaign:camp',tabName:'작업',orderData:{}});
 const second=await f.service.persistBundle({purchaseBundle:command,sheetId:'campaign:camp',tabName:'작업',orderData:{}});
 assert.equal(first.orderSubmissionId,second.orderSubmissionId);
 assert.equal((await f.db.query('SELECT * FROM order_submissions')).rows.length,1);
 assert.equal((await f.db.query('SELECT * FROM order_purchase_channels')).rows.length,2);
 assert.equal((await f.db.query('SELECT * FROM campaign_applications WHERE status=\'confirmed\'')).rows.length,1);
 assert.equal((await f.db.query('SELECT price FROM order_submissions')).rows[0].price,'19000');
 const loaded=await require('../src/services/dualPurchaseProjection.service').loadCommittedOrderForProjection(f.db,first.orderSubmissionId);
 const projection=require('../src/services/dualPurchaseProjection.service').bundleWorkboardProjection(loaded);
 assert.equal(projection.price,'19000');assert.equal(projection.dualPurchases.naver.orderNum,'naver123456');
 const changed=JSON.parse(JSON.stringify(f.body));changed.bank='다른 은행';
 changed.bundleApprovalToken=(await f.service.issueBundleApproval({body:changed,reviewerSession:f.reviewerSession})).bundleApprovalToken;
 await assert.rejects(f.service.prepareBundle({body:changed,reviewerSession:f.reviewerSession}),e=>e.code==='DUAL_BUNDLE_CONFLICT');
 await f.db.query('UPDATE order_submissions SET deleted_at=now() WHERE id=$1',[first.orderSubmissionId]);
 await assert.rejects(f.service.persistBundle({purchaseBundle:command,sheetId:'campaign:camp',tabName:'작업'}),e=>e.code==='DUAL_BUNDLE_CANCELLED');
 assert.equal((await f.db.query('SELECT * FROM order_submissions')).rows.length,1);
 }finally{await f.pg.close();}
});
module.exports={fixture};
test('projection consumes channel-specific headers before generic amount/order/id',()=>{
 const {mapOrderToSheetRow}=require('../src/services/orderLedger.service');
 assert.deepEqual(mapOrderToSheetRow(['네이버 주문번호','쿠팡 주문번호','네이버 금액','쿠팡 금액','네이버아이디','쿠팡ID','결제금액'],{price:'19000',orderNum:'N',dualPurchases:{naver:{orderNum:'N',userId:'nav',paidAmount:9000},coupang:{orderNum:'C',userId:'cou',paidAmount:10000}}}),['N','C',9000,10000,'nav','cou','19000']);
});
