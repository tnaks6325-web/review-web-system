'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const vm=require('vm');const {createRequire}=require('module');
const {PGlite}=require('@electric-sql/pglite');const {randomUUID,createHash}=require('crypto');
process.env.NODE_ENV='test';process.env.JWT_SECRET='dual-phase2-local-only-test-key-123456';
const shared=path.resolve(__dirname,'../src/services')+'/';
const migration=path.resolve(__dirname,'../migrations/215_dual_channel_purchase_bundles.sql');
const runtime=require(shared+'dualChannelRuntime.service');const lifecycle=require(shared+'dualChannelLifecycle.service');
const ready=()=>runtime.__setReadinessForTest(Object.fromEntries(['settings','roundtrip','recruitment','purchase','review','payment','operationalEnabled'].map(k=>[k,true])));
function load(name,overrides={}){const filename=name.startsWith('/')?name:path.resolve(__dirname,'../src/services/'+name+'.service.js'),req=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:n=>n in overrides?overrides[n]:req(n),process,Buffer,console,setTimeout,clearTimeout},{filename});return module.exports;}
const image=i=>Buffer.from('local-fake-image-provider-bytes-'+i).toString('base64');
async function fixture(){
 const pg=new PGlite();let tx=false;const statements=[];
 const db={query:async(sql,args)=>{statements.push(sql);if(sql==='BEGIN')tx=true;const r=await pg.query(sql,args);if(sql==='COMMIT'||sql==='ROLLBACK')tx=false;return r;},connect:async()=>({...db,release(){}})};
 await pg.exec(`CREATE TABLE reviewers(id uuid PRIMARY KEY,name text,phone text,phone8 text,address text,bank_name text,bank_account text,account_holder text,sub_accounts jsonb,shopping_id text,reviewer_no int);
 CREATE TABLE reviewer_delivery_addresses(id uuid,recipient text,address text,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identity_cards(id uuid,kind text,name_key text,phone8 text,status text,merged_into uuid,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identities(id uuid,member_no int,current_name text,current_phone text,current_phone8 text,shopping_id text,owner_reviewer_id uuid,status text);
 CREATE TABLE IF NOT EXISTS tab_configs(sheet_id text,tab_name text,income_type text);
 CREATE TABLE recruit_campaigns(id text PRIMARY KEY,multi_account_mode boolean,work_detail jsonb,channel text,source_work_order_id text,linked_sheet_id text,linked_tab_name text,linked_tab_gid text,participation_mode boolean,status text,recruit_total int,updated_at timestamptz);
 CREATE TABLE campaign_applications(id int PRIMARY KEY,campaign_id text REFERENCES recruit_campaigns(id),applicant_name text,applicant_phone text,phone8 text,owner_phone8 text,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,status text,expires_at timestamptz,hold_token text,order_submission_id uuid,review_fee_snapshot int,delivery_review_fee_mix_snapshot jsonb,blog_url text,purchase_qty int,qty_tier_amount int,option_key text,submitted_at timestamptz,late_order_id uuid);
 CREATE TABLE reviewer_identity_match_audits(campaign_application_id int,owner_reviewer_id uuid,participant_identity_id uuid,selected_identity_hash text,image_hash text,extracted_fields_hash text,status text,approval_mode text,reason_codes jsonb);
 CREATE TABLE order_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,gid text,tab_gid text,orderer text,recipient text,user_id text,phone text,address text,order_num text,date_str text,bank text,account text,depositor text,price text,memo text,source text,dedup_key text,mirror_status text,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,participant_identity_key_hash text,deleted_at timestamptz,campaign_application_id int,campaign_was_late boolean DEFAULT false,review_fee_snapshot int,delivery_review_fee_mix_snapshot jsonb,blog_url text,purchase_qty int,qty_tier_amount int,capture_file_id text,capture_file_id_2 text,capture_flags jsonb,updated_at timestamptz,submitted_at timestamptz DEFAULT now(),sheet_row int,workboard_id uuid,selected_opt_key text,selected_product text,delivery_memo text,delivery_memo_check text);
 CREATE TABLE review_submissions(id uuid PRIMARY KEY,file_id text);
 CREATE TABLE payment_batch_items(id uuid PRIMARY KEY,status text);`);
 const sql=fs.readFileSync(migration,'utf8');await pg.exec(sql);await pg.exec(sql);
 const owner=randomUUID(),product={name:'상품',channels:{naver:{pay:9000},coupang:{pay:10000}}};
 await db.query(`INSERT INTO reviewers VALUES($1,'김하나','01012345678','12345678','서울 강남대로 1 101호','은행','123','김하나','[]','id',1)`,[owner]);
 await db.query(`INSERT INTO recruit_campaigns(id,multi_account_mode,work_detail,channel,linked_sheet_id,linked_tab_name,linked_tab_gid,participation_mode,status,recruit_total) VALUES('camp',false,$1,'네이버+쿠팡','sheet','작업','',true,'active',3)`,[{dualChannelProduct:product}]);
 await db.query(`INSERT INTO campaign_applications(id,campaign_id,applicant_name,applicant_phone,phone8,owner_phone8,owner_reviewer_id,status,expires_at,hold_token,review_fee_snapshot) VALUES(7,'camp','김하나','01012345678','12345678','12345678',$1,'applied',now()+interval '1 hour','hold',2500)`,[owner]);
 const identity=load('reviewerOrderIdentity',{'../db/pool':db});const files=new Map();let uploads=0;let ioInTx=0;const folders=[];
 const drive={upload:async(bytes,mime,folder)=>{if(tx)ioInTx++;folders.push(folder);const id='file-'+(++uploads);files.set(id,bytes);return id;},read:async id=>{if(tx)ioInTx++;return files.get(id);}};
 const holds=load(path.resolve(__dirname,'../src/services/campaignHold.service.js'),{'./dualChannelLifecycle.service':lifecycle});
 ready();const service=require('../src/services/dualPurchaseSubmission.service').createService({db,identity,drive,runtime,lifecycle,confirmHoldInTx:holds.confirmHoldInTx,resolveFolder:async()=> 'server-folder',extractAI:async(b)=>({ok:true,data:{recipient:'김하나',phone:'01012345678',address:'서울 강남대로 1 101호',price:b===image(1)?'9000':'10000'}})});
 const body={campaignApplicationId:7,campaignHoldToken:'hold',bank:'은행',account:'123',depositor:'김하나',purchases:{}};const reviewerSession={ownerReviewerId:owner};
 async function stage(channel='naver',revision=1,extra={}){
  const imageBase64=image(channel==='naver'?revision:revision+10),purchase={orderNum:channel+'123456',userId:channel+'-id',recipient:'김하나',phone:'01012345678',address:'서울 강남대로 1 101호',paidAmount:product.channels[channel].pay};
  Object.assign(purchase,extra.purchase||{});
  const extracted=extra.extracted||{recipient:purchase.recipient,phone:purchase.phone,address:purchase.address,price:String(purchase.paidAmount)};
  const context=await identity.resolveApplicationIdentity({ownerReviewerId:owner,applicationId:7,campaignId:'camp',holdToken:'hold'},db);
  const proof=require('../src/services/dualPurchaseProof.service').issueChannelExtraction({context,channel,role:'primary',revision,imageBase64,extracted,ok:extra.ok!==false});
  const approval=extra.manualMode?await identity.manualConfirm({applicationId:7,campaignId:'camp',holdToken:'hold',manualConfirmed:true,mode:extra.manualMode,extractToken:proof.extractToken,extracted,formFields:purchase},reviewerSession):await identity.matchCapture({applicationId:7,campaignId:'camp',holdToken:'hold',extractToken:proof.extractToken,extracted},reviewerSession);
  const args={body:{...body,channel,role:'primary',revision,imageBase64,mimeType:'image/png',extracted,extractionToken:proof.extractionToken,identityApprovalToken:approval.approvalToken,purchase,...extra},reviewerSession};
  const artifact=await service.stagePurchaseArtifact(args);body.purchases[channel]={...purchase,primaryArtifactId:artifact.id};return {artifact,args};
 }
 async function submit(){body.bundleApprovalToken=(await service.issueBundleApproval({body,reviewerSession})).bundleApprovalToken;const purchaseBundle=await service.prepareBundle({body,reviewerSession});return service.persistBundle({purchaseBundle,sheetId:'sheet',tabName:'작업'});}
 return {pg,db,body,reviewerSession,service,identity,stage,submit,files,statements,folders,get ioInTx(){return ioInTx;},get uploads(){return uploads;}};
}
test('actual lifecycle and migration: no HTTP campaignId, real hold propagation and one parent replay',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');const first=await f.submit();assert.equal(first.holdResult,'confirmed');const second=await f.submit();assert.equal(second.orderSubmissionId,first.orderSubmissionId);
 const o=(await f.db.query('SELECT * FROM order_submissions')).rows;assert.equal(o.length,1);assert.equal(o[0].campaign_application_id,7);assert.equal(o[0].review_fee_snapshot,2500);assert.equal(o[0].price,'19000');assert.equal((await f.db.query('SELECT * FROM order_purchase_channels')).rows.length,2);
 assert.equal((await f.db.query('SELECT status FROM campaign_applications')).rows[0].status,'submitted');assert(f.statements.some(s=>s.includes("hashtext('dual_channel_lifecycle')")));
 }finally{await f.pg.close();}
});
test('Drive I/O stays outside transaction, folder is server-owned, exact stage retry uploads zero new files',async()=>{
 const f=await fixture();try{const a=await f.stage('naver',1,{folderId:'attacker-folder'});const again=await f.service.stagePurchaseArtifact(a.args);assert.equal(again.id,a.artifact.id);assert.equal(f.uploads,1);assert.deepEqual(f.folders,['server-folder']);await f.stage('coupang');await f.submit();assert.equal(f.ioInTx,0);}finally{await f.pg.close();}
});
test('failed extraction/no_capture is uncertain staff review, never a fabricated mismatch',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang',1,{manualMode:'no_capture',ok:false,extracted:{recipient:'못 읽음',phone:'00000000000',address:'판독실패'}});const x=await f.submit();const o=(await f.db.query('SELECT * FROM order_submissions WHERE id=$1',[x.orderSubmissionId])).rows[0];assert.equal(o.purchase_identity_result,'uncertain');assert.equal(o.purchase_identity_review.status,'pending');}finally{await f.pg.close();}
});
test('channel amount guard uses existing core and typed-equals-expected exception, never aggregate price',async()=>{
 const f=await fixture();try{await f.stage('naver',1,{purchase:{orderNum:'naver123456',userId:'naver-id',recipient:'김하나',phone:'01012345678',address:'서울 강남대로 1 101호',paidAmount:12000}});await f.stage('coupang');await assert.rejects(f.submit(),e=>e.code==='CAPTURE_PRICE_DIFF');f.body.purchases.naver.capturePriceAck=true;const x=await f.submit();const o=(await f.db.query('SELECT * FROM order_submissions WHERE id=$1',[x.orderSubmissionId])).rows[0];assert.equal(o.price,'22000');assert.equal(o.capture_flags.flags[0].channel,'naver');const price=require('../src/services/capturePriceCheck.service');assert.equal(price.decideForExpected({channel:'coupang',expected:10000,capturePrice:50000,typedPrice:10000}).typedMatch,true);}finally{await f.pg.close();}
});
test('committed photo replace/restore CAS preserves historical files and initial command hash',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');const x=await f.submit();const before=(await f.db.query('SELECT * FROM order_submissions')).rows[0];const old=(await f.db.query("SELECT * FROM purchase_capture_artifacts WHERE channel='naver'")).rows[0];
 const svc=require('../src/services/dualPurchaseArtifacts.service').createService({db:f.db,runtime,lifecycle,drive:{upload:async b=>{f.files.set('replacement',b);return 'replacement';},read:async id=>f.files.get(id)},resolveFolder:async()=> 'server-folder'});
 const args={orderSubmissionId:x.orderSubmissionId,channel:'naver',role:'primary',expectedArtifactId:old.id,expectedRevision:old.revision,imageBase64:image(50),mimeType:'image/png',actor:'staff-test'};
 const replacement=await svc.replacePurchaseArtifact(args);assert.equal(replacement.revision,2);await assert.rejects(svc.replacePurchaseArtifact(args),e=>e.code==='DUAL_ARTIFACT_CHANGED');
 const restored=await svc.replacePurchaseArtifact({...args,expectedArtifactId:replacement.id,expectedRevision:2,sourceArtifactId:old.id,imageBase64:undefined});assert.equal(restored.revision,3);assert.equal(restored.file_id,old.file_id);
 const all=(await f.db.query("SELECT * FROM purchase_capture_artifacts WHERE channel='naver' ORDER BY revision")).rows;assert.equal(all.length,3);assert.equal(all.filter(a=>!a.superseded_at).length,1);assert(f.files.has(old.file_id));assert(f.files.has('replacement'));
 const after=(await f.db.query('SELECT * FROM order_submissions')).rows[0];assert.equal(after.purchase_bundle_hash,before.purchase_bundle_hash);assert.equal(after.price,before.price);assert.equal(after.purchase_identity_review.status,'pending'); assert.equal(after.purchase_bundle_revision,3);
 const replay=await f.service.prepareBundle({body:f.body,reviewerSession:f.reviewerSession});const repeated=await f.service.persistBundle({purchaseBundle:replay,sheetId:'sheet',tabName:'작업'});assert.equal(repeated.orderSubmissionId,x.orderSubmissionId);assert.equal(repeated.idempotent,true);
 }finally{await f.pg.close();}
});
test('sheetless first write/replay share committed loader and InTx does not own caller commit',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');const x=await f.submit();await f.pg.exec(`CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,seq int,option_text text,order_submission_id uuid,row_json jsonb,reviewer_name text,recipient_name text,phone8 text,price text,workboard_id uuid,updated_by text,updated_at timestamptz,owner_reviewer_id uuid,participant_identity_id uuid,active boolean DEFAULT true,deleted_at timestamptz,UNIQUE(sheet_id,tab_name,seq));`);
 const headers=['수취인','연락처','주소','네이버 주문번호','쿠팡 주문번호','네이버 금액','쿠팡 금액','네이버아이디','쿠팡ID','결제금액'];await f.db.query("INSERT INTO campaign_participants(sheet_id,tab_name,seq,row_json) VALUES('sheet','작업',1,$1)",[Object.fromEntries(headers.map(h=>[h,'']))]);
 const ledger=require('../src/services/orderLedger.service');const sl=load('sheetlessOrder',{'../db/pool':f.db,'./dualChannelLifecycle.service':lifecycle,'./orderLedger.service':{...ledger,loadRawTabContext:async()=>({headers,tabGid:''})},'./rowNumbering.service':{renumberTabInTx:async()=>{}}});
 const scope=await lifecycle.discoverDualScope(f.db,[{orderSubmissionId:x.orderSubmissionId}]);await f.db.query('BEGIN');await lifecycle.lockDualScopeInTx(f.db,scope);const start=f.statements.length;
 const result=await sl.writeOrderToWorktableInTx(f.db,{sheetId:'sheet',tabName:'작업',sheetRow:1,orderSubmissionId:x.orderSubmissionId,orderData:{price:'attacker'},lockedScope:scope});assert.equal(result.ok,true);assert.equal(f.statements.slice(start).filter(s=>['BEGIN','COMMIT','ROLLBACK'].includes(s)).length,0);await f.db.query('ROLLBACK');assert.equal((await f.db.query('SELECT order_submission_id FROM campaign_participants')).rows[0].order_submission_id,null);
 for(let i=0;i<2;i++){const lockedScope=await lifecycle.discoverDualScope(f.db,[{orderSubmissionId:x.orderSubmissionId}]);await f.db.query('BEGIN');await lifecycle.lockDualScopeInTx(f.db,lockedScope);assert.equal((await sl.writeOrderToWorktableInTx(f.db,{sheetId:'sheet',tabName:'작업',sheetRow:i?undefined:1,orderSubmissionId:x.orderSubmissionId,lockedScope})).ok,true);await f.db.query('COMMIT');}
 const rows=(await f.db.query('SELECT * FROM campaign_participants')).rows;assert.equal(rows.length,1);assert.equal(rows[0].row_json['쿠팡 주문번호'],'coupang123456');assert.equal(rows[0].row_json['결제금액'],'19000');assert.equal(rows[0].row_json['쿠팡 금액'],'10000');
 }finally{await f.pg.close();}
});
test('dual worktable creation guarantees six dedicated columns without changing ordinary template',()=>{
 const plan=require('../src/utils/worktablePlan');const template={core:['수취인','연락처','주소','결제금액'],channels:{naver:['네이버아이디']}};
 const ordinary=plan.buildColumns({template,channel:'naver'}).map(c=>c.name);assert.deepEqual(ordinary,[...template.core,'네이버아이디']);
 const dual=plan.buildColumns({template,channel:'naver',dualChannel:true}).map(c=>c.name);for(const h of ['네이버 주문번호','쿠팡 주문번호','네이버 금액','쿠팡 금액','네이버아이디','쿠팡ID'])assert(dual.includes(h),h);
});
test('through-write InTx rejects bundle aggregate/identity edits before mutation',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');const x=await f.submit();const ledger=load('orderLedger',{'../db/pool':f.db});process.env.ORDER_LEDGER_WRITE_ENABLED='true';await f.db.query('BEGIN');const start=f.statements.length;await assert.rejects(ledger.syncCellToOrderIdentityInTx(f.db,{sheetId:'sheet',tabName:'작업',header:'결제금액',value:'1',orderSubmissionId:x.orderSubmissionId}),e=>e.code==='DUAL_CHANNEL_FIELD_REQUIRED');assert.equal(f.statements.slice(start).some(s=>s==='COMMIT'),false);await f.db.query('ROLLBACK');assert.equal((await f.db.query('SELECT price FROM order_submissions')).rows[0].price,'19000');}finally{await f.pg.close();}
});
test('supplement uses its own channel primary authority, not a second identity gate',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');const context=await f.identity.resolveApplicationIdentity({ownerReviewerId:f.reviewerSession.ownerReviewerId,applicationId:7,campaignId:'camp',holdToken:'hold'},f.db);const extracted={deliveryMemo:'문 앞',productName:'상품'},imageBase64=image(99);const signed=require('../src/services/dualPurchaseProof.service').issueChannelExtraction({context,channel:'naver',role:'supplement',revision:1,imageBase64,extracted,ok:true});const a=await f.service.stagePurchaseArtifact({body:{...f.body,channel:'naver',role:'supplement',revision:1,imageBase64,mimeType:'image/png',extracted,extractionToken:signed.extractionToken,purchase:f.body.purchases.naver},reviewerSession:f.reviewerSession});f.body.purchases.naver.supplementArtifactId=a.id;await f.submit();assert.equal((await f.db.query("SELECT * FROM purchase_capture_artifacts WHERE status='committed'")).rows.length,3);assert.equal((await f.db.query('SELECT capture_file_id_2 FROM order_submissions')).rows[0].capture_file_id_2,null);}finally{await f.pg.close();}
});
test('legacy capture session cannot write either parent photo column for a bundle',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');const x=await f.submit();await f.pg.exec(`CREATE TABLE purchase_submission_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_submission_id uuid,token_hash text,capture_sheet_id text,capture_tab_name text,source text,expires_at timestamptz,status text DEFAULT 'prepared',capture_file_id text,attempt_count int DEFAULT 0,failure_code text,completed_at timestamptz,updated_at timestamptz);`);const sessions=load('purchaseSubmissionSession',{'../db/pool':f.db});await assert.rejects(sessions.issueForOrder({orderSubmissionId:x.orderSubmissionId}));assert.equal((await f.db.query('SELECT * FROM purchase_submission_sessions')).rows.length,0);}finally{await f.pg.close();}
});
test('address parsing failure is uncertain, confirmed different apartment is mismatch',async()=>{
 const file=path.resolve(__dirname,'../src/services/identity.service.js');const bad=load(file,{'./gemini.service':{verifyAddressMatch:async()=>({ok:true,isSamePerson:false,confidence:0,reason:'AI 응답 파싱 실패'})}});
 const h=bad.addressHeuristic('서울 강남대로 1 101호','역삼동 55 101호');assert.equal(h.verdict,'uncertain');assert.equal((await bad.addressSame('서울 강남대로 1 101호','역삼동 55 101호')).verdict,'uncertain');assert.equal(bad.addressHeuristic('서울 강남대로 1 101호','서울 강남대로 1 202호').verdict,'mismatch');assert.equal(bad.addressHeuristic('서울 강남대로 1 101호','서울 강남대로 1 101호').verdict,'match');
});
test('server cash-receipt requirement is in the canonical snapshot shared with review/payment',async()=>{
 const f=await fixture();try{await f.db.query('ALTER TABLE recruit_campaigns ADD COLUMN cash_receipt_required boolean DEFAULT false');await f.db.query("UPDATE recruit_campaigns SET cash_receipt_required=true WHERE id='camp'");await f.stage('naver');await f.stage('coupang');await f.submit();const parent=(await f.db.query('SELECT * FROM order_submissions')).rows[0];assert.equal(parent.purchase_condition_snapshot.cashReceiptRequired,true);const review=load(path.resolve(__dirname,'../src/services/dualChannelReview.service.js'),{'./dualPurchaseProof.service':require('../src/services/dualPurchaseProof.service')});const hash=review.digest(parent.purchase_condition_snapshot);for(const a of (await f.db.query('SELECT condition_snapshot_hash FROM purchase_capture_artifacts')).rows)assert.equal(a.condition_snapshot_hash,hash);}finally{await f.pg.close();}
});
test('extract signs failed AI bytes for staff-review escape and ignores forged HTTP context',async()=>{
 const f=await fixture();try{const service=require('../src/services/dualPurchaseSubmission.service').createService({db:f.db,identity:f.identity,runtime,lifecycle,extractAI:async()=>{throw Error('fake-provider-offline');}});const body={...f.body,channel:'naver',role:'primary',revision:1,imageBase64:image(80),mimeType:'image/png',context:{owner:{id:'attacker'}}};const r=await service.extractPurchase({body,reviewerSession:f.reviewerSession});assert.equal(r.extractionOk,false);const signed=require('../src/services/dualPurchaseProof.service').verify(r.extractionToken,'extract');assert.equal(signed.scope.owner,f.reviewerSession.ownerReviewerId);assert.equal(signed.ok,false);runtime.__setReadinessForTest({});const n=f.statements.length;await assert.rejects(service.extractPurchase({body,reviewerSession:f.reviewerSession}),e=>e.code==='dual_channel_not_ready');assert.equal(f.statements.length,n);}finally{ready();await f.pg.close();}
});
test('changed final input without restaging cannot obtain a new bundle approval',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang');f.body.purchases.naver.userId='edited-without-restage';await assert.rejects(f.service.issueBundleApproval({body:f.body,reviewerSession:f.reviewerSession}),e=>e.code==='DUAL_ARTIFACT_STALE');assert.equal((await f.db.query('SELECT * FROM order_submissions')).rows.length,0);}finally{await f.pg.close();}
});
test('definite different unit blocks both purchases before parent SQL insert',async()=>{
 const f=await fixture();try{await f.stage('naver');await f.stage('coupang',1,{manualMode:'no_capture',purchase:{orderNum:'coupang123456',userId:'coupang-id',recipient:'김하나',phone:'01012345678',address:'서울 강남대로 1 202호',paidAmount:10000}});await assert.rejects(f.submit(),e=>e.code==='DUAL_ADDRESS_MISMATCH');assert.equal((await f.db.query('SELECT * FROM order_submissions')).rows.length,0);}finally{await f.pg.close();}
});
test('stage replacement preserves predecessor and COMMIT-response-loss uploaded bytes',async()=>{
 const f=await fixture();try{const first=await f.stage('naver');const real=f.db.query;let written=false;
 f.db.query=async(sql,args)=>{const r=await real(sql,args);if(sql.startsWith('INSERT INTO purchase_capture_artifacts'))written=true;if(sql==='COMMIT'&&written){written=false;throw Error('fake-commit-response-lost');}return r;};
 await assert.rejects(f.stage('naver',2,{expectedArtifactId:first.artifact.id}),/fake-commit-response-lost/);f.db.query=real;
 const rows=(await f.db.query("SELECT * FROM purchase_capture_artifacts WHERE channel='naver' ORDER BY revision")).rows;assert.equal(rows.length,2);assert.equal(rows[0].status,'superseded');assert(f.files.has(rows[0].file_id));assert(f.files.has(rows[1].file_id));const retry=await f.stage('naver',2,{expectedArtifactId:first.artifact.id});assert.equal(retry.artifact.id,rows[1].id);assert.equal(f.uploads,2);
 }finally{await f.pg.close();}
});
module.exports={fixture,load,runtime,lifecycle,ready,image,shared,migration};
