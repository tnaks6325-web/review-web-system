'use strict';
require('./helpers/dualChannelDependencies.cjs');const {test}=require('node:test');const assert=require('node:assert/strict');
const {fixture,id,snapshot}=require('./helpers/dualChannelRealFixture');
test('direct resolveInspection uses actual lifecycle scope before UPDATE and current receipt result gates payment',async()=>{
 const db=await fixture();try{
 const review=require('../src/services/dualChannelReview.service');
 await db.query(`INSERT INTO review_submissions(sheet_id,tab_name,row_index,file_id,slot_key,order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash,completed_at)VALUES('s','t',2,'receipt-file','receipt',$1,'naver','receipt',1,$2,$3,now())`,[id,'d'.repeat(64),review.digest(snapshot)]);
 await db.exec(`INSERT INTO review_inspections(file_id,sheet_id,tab_name,row_index,slot_key,status,checks)VALUES('receipt-file','s','t',2,'receipt','suspect','{"receiptValidation":{"verdict":"warn"}}')`);
 const calls=[];const traced={...db,query:async(sql,args)=>{calls.push(sql);return db.query(sql,args)}};traced.connect=async()=>({...traced,release(){}});
 const inspect=require('../src/services/reviewInspect.service');inspect.__setPoolForTest(traced);
 try{await inspect.resolveInspection({fileId:'receipt-file',by:'staff',resolution:'bad'});}finally{inspect.__setPoolForTest(null);}
 const update=calls.findIndex(s=>/UPDATE review_inspections/.test(s));const scope=calls.findIndex(s=>/pg_advisory_xact_lock/.test(s));
 assert.ok(scope>=0&&scope<update,'direct pool UPDATE must not bypass lifecycle');
 assert.equal((await db.query(`SELECT resolution FROM review_inspections WHERE file_id='receipt-file'`)).rows[0].resolution,'bad');
 }finally{await db.close();}
});

test('two different campaign file scopes lock together in sorted order; second SQL failure rolls back removal',async()=>{
 const db=await fixture();try{
 const second='00000000-0000-4000-8000-000000000003',seat='00000000-0000-4000-8000-000000000004';
 await db.exec(`INSERT INTO recruit_campaigns SELECT 'z-campaign',work_detail,'s2','t2','g2',NULL FROM recruit_campaigns LIMIT 1;INSERT INTO campaign_applications VALUES(2,'z-campaign',NULL)`);
 await db.query(`INSERT INTO order_submissions SELECT (jsonb_populate_record(NULL::order_submissions,to_jsonb(o)||$1::jsonb)).* FROM order_submissions o WHERE id=$2`,[JSON.stringify({id:second,purchase_bundle_application_id:2,campaign_application_id:2,sheet_id:'s2',tab_name:'t2',gid:'g2'}),id]);
 await db.query('UPDATE campaign_applications SET order_submission_id=$1 WHERE id=2',[second]);
 await db.query(`INSERT INTO campaign_participants(id,order_submission_id,sheet_id,tab_name,seq,row_json)VALUES($1,$2,'s2','t2',2,'{}')`,[seat,second]);
 const review=require('../src/services/dualChannelReview.service');
 for(const [order,file,s,t] of [[id,'remove-file','s','t'],[second,'keep-file','s2','t2']])await db.query(`INSERT INTO review_submissions(sheet_id,tab_name,row_index,file_id,slot_key,order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash,completed_at)VALUES($1,$2,2,$3,'review',$4,'naver','review',1,$5,$6,now())`,[s,t,file,order,'e'.repeat(64),review.digest(snapshot)]);
 const calls=[];const traced={...db,query:async(sql,args)=>{calls.push({sql,args});return db.query(sql,args)}};traced.connect=async()=>({...traced,release(){}});
 await assert.rejects(review.withReviewFilesMutation({db:traced,fileIds:['keep-file','remove-file'],run:async c=>{await c.query(`UPDATE review_submissions SET superseded_at=now() WHERE file_id='remove-file'`);await c.query('SELECT * FROM intentionally_missing_second_statement');}}),/intentionally_missing_second_statement/);
 const locks=calls.filter(c=>c.sql.includes("hashtext('dual_channel_lifecycle')")).map(c=>c.args[0]);assert.deepEqual(locks,['campaign','z-campaign']);
 assert.equal((await db.query(`SELECT superseded_at FROM review_submissions WHERE file_id='remove-file'`)).rows[0].superseded_at,null);
 }finally{await db.close();}
});
