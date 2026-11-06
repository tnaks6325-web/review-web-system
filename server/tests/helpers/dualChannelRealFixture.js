'use strict';
require('./dualChannelDependencies.cjs');
const {PGlite}=require('@electric-sql/pglite');const fs=require('node:fs');const path=require('node:path');
const id='00000000-0000-4000-8000-000000000001';const owner='00000000-0000-4000-8000-000000000002';
const snapshot={channels:{naver:{url:'https://naver.invalid',pay:9000},coupang:{url:'https://coupang.invalid',pay:10000}},cashReceiptRequired:true};
async function fixture(){
 require('./dualChannelRuntime.service').__setReadinessForTest({settings:true,roundtrip:true,purchase:true,review:true,payment:true});
 const pg=new PGlite();await pg.exec(`
 CREATE TABLE recruit_campaigns(id text PRIMARY KEY,work_detail jsonb,linked_sheet_id text,linked_tab_name text,linked_tab_gid text,source_work_order_id text);
 CREATE TABLE campaign_applications(id integer PRIMARY KEY,campaign_id text,order_submission_id uuid);
 CREATE TABLE work_orders(id text PRIMARY KEY,linked_campaign_id text);
 CREATE TABLE order_submissions(id uuid PRIMARY KEY,price text,deleted_at timestamptz,owner_reviewer_id uuid,campaign_application_id integer,sheet_id text,tab_name text,gid text);
 CREATE TABLE campaign_participants(id uuid PRIMARY KEY,order_submission_id uuid,sheet_id text,tab_name text,seq integer,active boolean DEFAULT true,deleted_at timestamptz,row_json jsonb,identity_key text,source text,updated_at timestamptz,submit_col text,is_submitted boolean DEFAULT false);
 CREATE TABLE review_submissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,reviewer_name text,slot_key text,file_id text UNIQUE,file_url text,file_name text,file_hash text,source text,uploaded_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),upload_batch_id uuid,completed_at timestamptz);
 CREATE TABLE review_inspections(file_id text PRIMARY KEY,sheet_id text,tab_name text,row_index integer,reviewer_name text,slot_key text,status text,checks jsonb,resolution text,updated_at timestamptz,product_resolution text,ocr_product text,resolved_at timestamptz,resolved_by text);
 CREATE TABLE review_index(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,row_json jsonb,is_submitted boolean DEFAULT false,review_file_id text,review_file_url text,review_file_name text,review_file_count integer);
 CREATE TABLE payment_batch_items(id uuid DEFAULT gen_random_uuid(),batch_id uuid,status text DEFAULT 'pending',sheet_id text,tab_name text,row_index integer,product_price integer,review_fee integer,bank_name text,bank_account text,account_holder text);
 CREATE TABLE participant_edits(id serial,sheet_id text,tab_name text,anchor_type text,anchor_value text,field text,kind text,value_text text,value_bool boolean,created_by text,created_at timestamptz DEFAULT now(),reverted_at timestamptz,reverted_by text);
 CREATE TABLE raw_sheet_tabs(sheet_id text,tab_name text,tab_gid text,headers jsonb,detected_headers jsonb);
 CREATE TABLE raw_sheet_rows(sheet_id text,tab_name text,tab_gid text,row_index integer,cells jsonb);
 `);
 const local=path.resolve(__dirname,'../../migrations/215_dual_channel_purchase_bundles.sql');
 const migration=fs.readFileSync(fs.existsSync(local)?local:'/Users/sooman/dev/wt/rw-dualchannel-storage/server/migrations/215_dual_channel_purchase_bundles.sql','utf8');
 await pg.exec(migration);await pg.exec(migration);
 await pg.query(`INSERT INTO recruit_campaigns VALUES('campaign',$1,'s','t','g',NULL)`,[JSON.stringify({dualChannelProduct:snapshot})]);
 await pg.exec(`INSERT INTO campaign_applications VALUES(1,'campaign',NULL)`);
 await pg.query(`INSERT INTO order_submissions(id,price,owner_reviewer_id,campaign_application_id,sheet_id,tab_name,gid,purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_bundle_revision) VALUES($1,'19000',$2,1,'s','t','g',1,1,$3,$4,'uncertain',1)`,[id,owner,'a'.repeat(64),JSON.stringify(snapshot)]);
 await pg.query('UPDATE campaign_applications SET order_submission_id=$1',[id]);
 for(const [c,n] of [['naver',9000],['coupang',10000]]){
 await pg.query('INSERT INTO order_purchase_channels VALUES($1,$2,\'num\',\'uid\',\'가\',\'01012345678\',\'주소\',$3,NULL)',[id,c,n]);
 await pg.query(`INSERT INTO purchase_capture_artifacts(application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status) VALUES(1,$1,$2,'primary',1,$3,$4,$4,$4,$4,'committed')`,[id,c,'purchase-'+c,(c==='naver'?'b':'c').repeat(64)]);
 }
 await pg.query(`INSERT INTO campaign_participants(id,order_submission_id,sheet_id,tab_name,seq,row_json,submit_col) VALUES($1,$2,'s','t',2,'{"결제금액":"19000"}','리뷰제출')`,[owner,id]);
 await pg.exec(`INSERT INTO review_index(sheet_id,tab_name,row_index,row_json)VALUES('s','t',2,'{"결제금액":"19000"}')`);
 const db={query:pg.query.bind(pg),exec:pg.exec.bind(pg),close:pg.close.bind(pg)};
 db.connect=async()=>({...db,release(){}});return db;
}
module.exports={fixture,id,owner,snapshot};
