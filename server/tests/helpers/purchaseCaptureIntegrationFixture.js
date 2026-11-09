'use strict';
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const OWNER='11111111-1111-4111-8111-111111111111';
const SINGLE='33333333-3333-4333-8333-333333333333';
const BUNDLE='44444444-4444-4444-8444-444444444444';
const IMAGE=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=','base64');
async function fixture({engine,database}={}){
 const pg=engine||new PGlite();
 if(!engine)await pg.exec("CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS 'SELECT'; CREATE FUNCTION pg_advisory_xact_lock(integer,integer) RETURNS void LANGUAGE SQL AS 'SELECT';");
 await pg.exec(`
 CREATE TABLE reviewers(id uuid PRIMARY KEY,name text,phone text,phone8 text,sub_accounts jsonb,admin_memo text);
 CREATE TABLE reviewer_identities(id uuid PRIMARY KEY,owner_reviewer_id uuid,member_no int,current_phone8 text,status text);
 CREATE TABLE reviewer_identity_cards(id uuid PRIMARY KEY,owner_reviewer_id uuid,phone8 text,status text,kind text);
 CREATE TABLE order_submissions(id uuid PRIMARY KEY,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,
 participant_identity_key_hash text,campaign_application_id int,sheet_id text,tab_name text,gid text,tab_gid text,
 recipient text,orderer text,phone text,deleted_at timestamptz,mirror_status text,
 capture_file_id text,capture_file_id_2 text,capture_uploaded_at timestamptz,capture2_uploaded_at timestamptz,
 delivery_memo text,submitted_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE campaign_applications(id int PRIMARY KEY,campaign_id text,order_submission_id uuid,owner_reviewer_id uuid,participant_identity_id uuid,participant_card_id uuid,phone8 text,status text);
 CREATE TABLE recruit_campaigns(id text PRIMARY KEY,title text,channel text,work_detail jsonb,options jsonb,source_work_order_id text,linked_sheet_id text,linked_tab_name text,linked_tab_gid text);
 CREATE TABLE tab_configs(sheet_id text,tab_name text,tab_gid text,display_name text,is_closed boolean DEFAULT false);
 CREATE TABLE trackb_tab_finished(sheet_id text,tab_name text,tab_gid text,deleted_at timestamptz);
 CREATE TABLE index_master_archive(sheet_id text,tab_name text);
 CREATE TABLE review_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
 CREATE TABLE payment_batch_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text DEFAULT 'pending');
 `);
 for(const m of ['030_cs_inquiry.sql','080_cs_message_card.sql','146_purchase_submission_sessions.sql','215_dual_channel_purchase_bundles.sql','219_capture_self_service_supplements.sql','220_purchase_capture_checks.sql'])await pg.exec(fs.readFileSync(path.resolve(__dirname,'../../migrations',m),'utf8'));
 await pg.query('INSERT INTO reviewers VALUES($1,$2,$3,$4,$5,NULL)',[OWNER,'시험 리뷰어','01012345678','12345678','[]']);
 for(const [id,tab]of [[SINGLE,'일반 시험'],[BUNDLE,'묶음 시험']]){
  await pg.query("INSERT INTO order_submissions(id,owner_reviewer_id,sheet_id,tab_name,recipient,phone,mirror_status,capture_file_id,capture_file_id_2,delivery_memo)VALUES($1,$2,'local-sheet',$3,'시험 명의','01012345678','written','original-1','original-2','원래 배송메모')",[id,OWNER,tab]);
  await pg.query("INSERT INTO tab_configs VALUES('local-sheet',$1,'',$2,false)",[tab,tab]);
 }
 await pg.query("INSERT INTO campaign_applications VALUES(1,'local-campaign',$1,$2,NULL,NULL,'12345678','submitted')",[BUNDLE,OWNER]);
 await pg.exec("INSERT INTO recruit_campaigns VALUES('local-campaign','네이버·쿠팡 시험','네이버+쿠팡','{}','[]',NULL,'local-sheet','묶음 시험','')");
 await pg.query("UPDATE order_submissions SET purchase_bundle_application_id=1,purchase_bundle_version=1,purchase_bundle_hash=$2,purchase_condition_snapshot='{}',purchase_identity_result='match',purchase_bundle_revision=1,purchase_identity_review='{\"status\":\"approved\"}',capture_file_id=NULL,capture_file_id_2=NULL WHERE id=$1",[BUNDLE,'a'.repeat(64)]);
 for(const channel of ['naver','coupang']){
  await pg.query('INSERT INTO order_purchase_channels(order_submission_id,channel,paid_amount)VALUES($1,$2,10000)',[BUNDLE,channel]);
  for(const role of ['primary','supplement'])await pg.query("INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status)VALUES(1,$1,$2,$3,1,$4,$5,$5,$5,$5,'committed')",[BUNDLE,channel,role,channel+'-'+role,'b'.repeat(64)]);
 }
 await pg.query("INSERT INTO payment_batch_items(order_submission_id,eligibility_fingerprint,status)VALUES($1,$2,'pending')",[BUNDLE,'c'.repeat(64)]);
 await pg.exec('INSERT INTO review_submissions DEFAULT VALUES');
 const originalIds=['original-1','original-2','naver-primary','naver-supplement','coupang-primary','coupang-supplement'];
 const files=new Map(originalIds.map(id=>[id+'_00000000000000000000',IMAGE]));
 await pg.exec("UPDATE order_submissions SET capture_file_id=capture_file_id||'_00000000000000000000',capture_file_id_2=capture_file_id_2||'_00000000000000000000';UPDATE purchase_capture_artifacts SET file_id=file_id||'_00000000000000000000'");
 let uploaded=0;const drive={upload:async bytes=>{const id='local-supplement-'+(++uploaded)+'_00000000000000000000';files.set(id,Buffer.from(bytes));return id;},read:async id=>files.get(id)};
 // PGlite has one connection: serialize independent clients rather than nest BEGINs.
 let tail=Promise.resolve();
 async function acquire(){let release;const previous=tail;tail=new Promise(r=>{release=r;});await previous;return release;}
 const db=database||{query:async(...a)=>{const release=await acquire();try{return await pg.query(...a);}finally{release();}},connect:async()=>{const release=await acquire();return {query:(...a)=>pg.query(...a),release};}};
 let checks;const core=require('../../src/services/purchaseCaptureSelfService.service').createService({db,drive,requestInTx:(...args)=>checks.requestInTx(...args)});
 checks=require('../../src/services/purchaseCaptureCheck.service').createService({db,core});
 return {pg,db,files,core,checks,fakeUpload:drive.upload,getUploaded:()=>uploaded};
}
module.exports={fixture,OWNER,SINGLE,BUNDLE,IMAGE};
