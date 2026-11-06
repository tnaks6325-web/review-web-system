'use strict';
require('./dualChannelDependencies.cjs');
const {PGlite}=require('@electric-sql/pglite');
const crypto=require('node:crypto');
const snapshot={channels:{naver:{},coupang:{}},cashReceiptRequired:true};
const hash=require('../../src/services/dualChannelReview.service').digest(snapshot);
const id='00000000-0000-4000-8000-000000000001';
async function fixture(){
 require('./dualChannelRuntime.service').__setReadinessForTest({settings:true,roundtrip:true,purchase:true,review:true,payment:true});
 const pg=new PGlite(); await pg.exec(`
 CREATE TABLE order_submissions(id uuid PRIMARY KEY,price integer,purchase_bundle_version integer,purchase_bundle_revision integer,purchase_bundle_hash text,purchase_condition_snapshot jsonb,purchase_identity_result text,purchase_identity_review jsonb,deleted_at timestamptz);
 CREATE TABLE order_purchase_channels(order_submission_id uuid,channel text,paid_amount integer,recipient text,phone text,address text);
 CREATE TABLE purchase_capture_artifacts(id uuid,order_submission_id uuid,channel text,role text,revision integer,file_id text,byte_sha256 text,status text,superseded_at timestamptz);
 CREATE TABLE review_submissions(id serial,order_submission_id uuid,purchase_channel text,evidence_role text,evidence_revision integer,slot_key text,file_id text,byte_sha256 text,condition_snapshot_hash text,superseded_at timestamptz,completed_at timestamptz DEFAULT now());
 CREATE TABLE review_inspections(file_id text,status text,resolution text,checks jsonb);
 CREATE TABLE payment_batch_items(id serial,order_submission_id uuid,status text);
 CREATE UNIQUE INDEX active_order ON payment_batch_items(order_submission_id) WHERE status IN ('pending','paid');
 CREATE TABLE campaign_participants(id serial,order_submission_id uuid,sheet_id text,tab_name text,seq integer,active boolean,deleted_at timestamptz,row_json jsonb,identity_key text,source text,updated_at timestamptz);
 CREATE TABLE participant_edits(id serial,sheet_id text,tab_name text,anchor_type text,anchor_value text,field text,kind text,value_text text,value_bool boolean,created_by text,created_at timestamptz DEFAULT now(),reverted_at timestamptz,reverted_by text);
 CREATE UNIQUE INDEX active_edit ON participant_edits(sheet_id,tab_name,anchor_type,anchor_value,field) WHERE reverted_at IS NULL;
 CREATE TABLE raw_sheet_rows(sheet_id text,tab_name text,tab_gid text,row_index integer,cells jsonb);
 CREATE TABLE raw_sheet_tabs(sheet_id text,tab_name text,tab_gid text,headers jsonb,detected_headers jsonb);
 CREATE TABLE review_index(sheet_id text,tab_name text,row_index integer,row_json jsonb);
 `);
 await pg.query('INSERT INTO order_submissions VALUES ($1,19000,1,1,$2,$3,\'uncertain\',NULL,NULL)',[id,'a'.repeat(64),JSON.stringify(snapshot)]);
 for(const [channel,amount] of [['naver',9000],['coupang',10000]]){
 await pg.query('INSERT INTO order_purchase_channels VALUES ($1,$2,$3,\'가\',\'01012345678\',\'주소\')',[id,channel,amount]);
 await pg.query('INSERT INTO purchase_capture_artifacts VALUES ($1,$2,$3,\'primary\',1,$4,$5,\'committed\',NULL)',[crypto.randomUUID(),id,channel,'purchase-'+channel,(channel==='naver'?'b':'c').repeat(64)]);
 }
 await pg.query(`INSERT INTO campaign_participants(order_submission_id,sheet_id,tab_name,seq,active,row_json) VALUES ($1,'s','t',2,true,'{"결제금액":"19000","네이버 금액":"9000","쿠팡 금액":"10000"}')`,[id]);
 await pg.exec(`INSERT INTO review_index VALUES ('s','t',2,'{"결제금액":"19000"}')`);
 return {query:pg.query.bind(pg),exec:pg.exec.bind(pg),close:pg.close.bind(pg)};
}
async function evidence(db,channel,role){ const file=channel+'-'+role; const key=role==='review'?(channel==='naver'?'review':'slot2'):(channel==='naver'?'receipt':'receipt2');
 await db.query('INSERT INTO review_submissions(order_submission_id,purchase_channel,evidence_role,evidence_revision,slot_key,file_id,byte_sha256,condition_snapshot_hash) VALUES($1,$2,$3,1,$4,$5,$6,$7)',[id,channel,role,key,file,crypto.createHash('sha256').update(file).digest('hex'),hash]);
 await db.query(`INSERT INTO review_inspections VALUES($1,$2,NULL,$3)`,[file,role==='receipt'?'pass':'warning',JSON.stringify(role==='receipt'?{receiptValidation:{verdict:'pass'}}:{})]);
}
// Automatic identity match as the real submission records it: verdict + binding to the evidence it was computed from.
async function bindAutoMatch(db,orderId=id){
 const review=require('../../src/services/dualChannelReview.service');
 const bound=review.identityEvidenceHash(await review.loadBundle(db,orderId));
 await db.query("UPDATE order_submissions SET purchase_identity_result='match',purchase_identity_review=COALESCE(purchase_identity_review,'{}'::jsonb)||jsonb_build_object('submittedEvidenceHash',$2::text) WHERE id=$1",[orderId,bound]);
}
module.exports={fixture,evidence,id,snapshot,hash,bindAutoMatch};
