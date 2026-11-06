'use strict';
require('./helpers/dualChannelDependencies.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=require('node:path').resolve(__dirname,'..');
const {fixture,id,snapshot}=require(root+'/tests/helpers/dualChannelRealFixture');
(async()=>{const db=await fixture();try{
 await db.exec(`CREATE TABLE payment_batches(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,bank text,created_by text,item_count integer DEFAULT 0,total_amount integer DEFAULT 0,status text DEFAULT 'created');CREATE TABLE review_closed_targets(sheet_id text,tab_name text,row_index integer);ALTER TABLE campaign_participants ADD COLUMN submit_col2 text;ALTER TABLE payment_batch_items ADD COLUMN campaign_id text,ADD COLUMN reviewer_name text,ADD COLUMN phone8 text,ADD COLUMN owner_reviewer_id uuid,ADD COLUMN participant_identity_id uuid,ADD COLUMN bank_code text,ADD COLUMN account_reviewer_id uuid,ADD COLUMN account_source text,ADD COLUMN account_sub_phone8 text,ADD COLUMN account_fingerprint text,ADD COLUMN account_snapshot_fingerprint text,ADD COLUMN amount integer,ADD COLUMN transfer_memo text,ADD COLUMN is_qna boolean;`);await require('./helpers/dualChannelFixture').bindAutoMatch(db);
 const review=require(root+'/src/services/dualChannelReview.service');
 for(const channel of ['naver','coupang'])for(const role of ['review','receipt']){
 const slot=role==='review'?(channel==='naver'?'review':'slot2'):(channel==='naver'?'receipt':'receipt2');const file=channel+'-'+role;
 await db.query(`INSERT INTO review_submissions(sheet_id,tab_name,row_index,file_id,slot_key,order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash,completed_at)VALUES('s','t',2,$1,$2,$3,$4,$5,1,$6,$7,now())`,[file,slot,id,channel,role,require('node:crypto').createHash('sha256').update(file).digest('hex'),review.digest(snapshot)]);
 await db.query(`INSERT INTO review_inspections(file_id,status,checks)VALUES($1,'pass',$2)`,[file,JSON.stringify(role==='receipt'?{receiptValidation:{verdict:'pass'}}:{})]);
 }
 const financialContext=async()=>({bankName:'하나은행',bankAccount:'001234567',accountHolder:'가',payoutMode:'ours',reviewFee:1000,productPrice:19000,bank:'kbank',transferMemo:'',reasons:[]});
 const payout=require(root+'/src/services/dualChannelPayout.service');const target={orderSubmissionId:id,sheetId:'s',tabName:'t',rowIndex:2};
 const state=await payout.evaluateOrderPayoutEligibility(db,{target,financialContext});assert.equal(state.eligible,true);
 const fresh={...target,eligibilityFingerprint:state.fingerprint,payable:true,issues:[],bank:'kbank',payoutMode:'ours',bankName:'하나은행',bankCode:'081',bankAccount:'001234567',accountHolder:'가',productPrice:19000,reviewFee:1000,amount:20000,reviewerName:'가',phone8:'12345678',transferMemo:'',isQna:false};
 const file=root+'/src/services/payment.service.js',actualRequire=createRequire(file),mod={exports:{}};
 const traced=[];const client={query:async(sql,args)=>{traced.push(sql);const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},release(){}};
 const pool={query:client.query,connect:async()=>client};
 let code=fs.readFileSync(file,'utf8')+'\nlistPaymentTargets=async()=>({items:[__fresh]});payoutModeLocked=async()=>"ours";';
 if(process.env.REMOVE_BATCH_TX==='1'){
 const begin=code.indexOf('async function createBatch('),end=code.indexOf('async function cancelBatch(');let part=code.slice(begin,end);
 for(const statement of ["await client.query(scope?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN');","await client.query('COMMIT');","await client.query('ROLLBACK');","await client.query('SAVEPOINT sp_item');","await client.query('RELEASE SAVEPOINT sp_item');","await client.query('ROLLBACK TO SAVEPOINT sp_item');"]){assert.ok(part.includes(statement),statement);part=part.split(statement).join('');}
 code=code.slice(0,begin)+part+code.slice(end);
 }
 vm.runInNewContext(code,{module:mod,exports:mod.exports,Buffer,process,console,__fresh:fresh,require:name=>name==='../db/pool'?pool:name==='./dualChannelPayout.service'?{...payout,evaluateOrderPayoutEligibility:(db,opts)=>payout.evaluateOrderPayoutEligibility(db,{...opts,financialContext})}:actualRequire(name)},{filename:file});
 const result=await mod.exports.createBatch({bank:'kbank',rows:[{sheetId:'s',tabName:'t',rowIndex:2}],by:'staff'});assert.equal(result.ok,true);
 const saved=(await db.query('SELECT order_submission_id,eligibility_fingerprint FROM payment_batch_items')).rows;assert.equal(saved.length,1);assert.equal(saved[0].order_submission_id,id);assert.equal(saved[0].eligibility_fingerprint,state.fingerprint);
 assert.ok(traced.findIndex(s=>s.includes('pg_advisory_xact_lock'))<traced.findIndex(s=>s.includes('INSERT INTO payment_batches')));
 await assert.rejects(db.query(`INSERT INTO payment_batch_items(order_submission_id,eligibility_fingerprint,status,sheet_id,tab_name,row_index)VALUES($1,$2,'pending','different','work',3)`,[id,state.fingerprint]),/duplicate key/);
 await db.exec(`TRUNCATE payment_batch_items,payment_batches;CREATE FUNCTION reject_batch_total() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forced second business SQL failure';END$$;CREATE TRIGGER reject_total BEFORE UPDATE ON payment_batches FOR EACH ROW EXECUTE FUNCTION reject_batch_total()`);
 await assert.rejects(mod.exports.createBatch({bank:'kbank',rows:[{sheetId:'s',tabName:'t',rowIndex:2}],by:'staff'}),/forced second business SQL failure/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_batch_items')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM payment_batches')).rows[0].n,0);
 console.log('PASS actual createBatch SQL: native UUID/fingerprint, first scope lock, native duplicate unique, later total UPDATE failure rolls back batch + item. Financial/list/mode fixtures injected; not a full financial SQL/HTTP/concurrency test.');
 }finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1});
