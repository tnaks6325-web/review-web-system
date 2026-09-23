'use strict';
// In-memory SQL only. Never connect to an operational database or send notifications.
for (const key of ['DATABASE_URL','DATABASE_PUBLIC_URL','PGTEST_URL']) process.env[key]='';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.resolve(__dirname,'..',p),'utf8');
const {closeWithoutReview}=require('../src/services/workdeskReviewResolution.service');
if(!process.env.PGLITE_MODULE) throw Error('Embedded PostgreSQL is required for closure regression');
const {PGlite}=require(process.env.PGLITE_MODULE);
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const order='dddddddd-dddd-4ddd-8ddd-dddddddddddd',identity='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let pg,passed=0;
async function q(sql,params=[]){const r=await pg.query(sql,params);return {...r,rowCount:r.affectedRows};}
const db={query:q,connect:async()=>({query:q,release(){}})};
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function reset(){await pg.exec(`TRUNCATE campaign_participants,review_index,order_submissions,reviewer_participations,
 reviewer_participation_events,workdesk_review_resolutions,review_reminder_states,review_reminder_deliveries,
 participant_edits,reviewer_history_rollouts,reviewer_owner_mapping_reviews;
 UPDATE tab_configs SET is_closed=FALSE,archived_rounds='';`);}
async function cpRow(id){return (await q('SELECT *,updated_at::text AS revision FROM campaign_participants WHERE id=$1',[id])).rows[0];}
async function state(id){return (await q(`SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1
 ORDER BY (lifecycle_status='active') DESC,updated_at DESC,id DESC LIMIT 1`,[id])).rows[0];}
async function closed(id){return (await q('SELECT * FROM review_closed_targets WHERE resolution_id=$1',[id])).rows;}
async function seed(who=owner,extra={}){
 const row=(await q(`INSERT INTO campaign_participants(sheet_id,tab_name,seq,owner_reviewer_id,identity_key,phone8,reviewer_name,row_json,order_submission_id)
 VALUES('s','t',2,$1,$2,$3,$4,'{}',$5) RETURNING *`,[who,extra.key===undefined?'stable-key':extra.key,
 extra.phone===undefined?'12345678':extra.phone,extra.name===undefined?'합성 참여자':extra.name,extra.order||null])).rows[0];
 await q(`INSERT INTO review_index(sheet_id,tab_name,row_index,reviewer_name,phone8,submit_col,row_json)
 VALUES('s','t',2,$1,$2,'리뷰제출','{}')`,[row.reviewer_name,row.phone8]);
 await close(row.id);return cpRow(row.id);
}
async function close(id){const row=await cpRow(id);return closeWithoutReview({db,sheetId:'s',tabName:'t',rowId:id,
 expectedRevision:row.revision,confirm:true,by:'격리 검사',deriveAnchor:r=>({type:r.order_submission_id?'order':'manual',value:r.order_submission_id||r.id})});}
async function seedOrder(who=owner,opts={}){await q(`INSERT INTO order_submissions(id,owner_reviewer_id,participant_identity_key_hash,participant_identity_id,phone)
 VALUES($1,$2,$3,$4,$5)`,[order,who,opts.verified===false?null:'verified-hash',opts.identity||null,opts.phone||'01012345678']);}
(async()=>{
 pg=new PGlite();
 try{
 const schema=read('tests/reviewerHistory.test.js').match(/await pg\.exec\((`CREATE TABLE reviewers[\s\S]*?`)\);/)[1];
 await pg.exec(Function('owner','other','return '+schema)(owner,other));
 await pg.exec(`ALTER TABLE order_submissions ADD phone text;
 ALTER TABLE participant_edits ADD reverted_by text;
 CREATE TABLE reviewer_identities(id uuid,owner_reviewer_id uuid,current_phone8 text,status text);
 CREATE TABLE payment_batch_items(sheet_id text,tab_name text,row_index int,status text);
 CREATE TABLE review_submissions(sheet_id text,tab_name text,row_index int,slot_key text,completed_at timestamptz);
 CREATE TABLE index_master(sheet_id text,tab_name text,submitted_count int);`);
 for(const file of ['160_review_reminder_alimtalk.sql','161_workdesk_review_resolutions.sql','162_reviewer_participations.sql'])await pg.exec(read('migrations/'+file));
 await test('참여자 전체 교체는 새 참여: 이전 종결과 감사 이력 보존',async()=>{
  await reset();const cp=await seed(),before=await state(cp.id);
  await q(`UPDATE campaign_participants SET owner_reviewer_id=$2,identity_key='replacement',phone8='87654321',reviewer_name='새 참여자',row_json='{}' WHERE id=$1`,[cp.id,other]);
  assert.equal((await closed(cp.id)).length,0);const after=await state(cp.id);
  assert.equal(after.review_obligation_status,'pending');assert.notEqual(after.id,before.id);
  assert.notEqual((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  const old=(await q('SELECT lifecycle_status,review_obligation_status FROM reviewer_participations WHERE id=$1',[before.id])).rows[0];
  assert.deepEqual(old,{lifecycle_status:'cancelled',review_obligation_status:'closed_no_review'});
  assert.equal((await q('SELECT history FROM workdesk_review_resolutions WHERE participant_id=$1',[cp.id])).rows[0].history.length,1);
 });
 await test('동일 참여 최초 주문 연결은 종결·참여 ID 유지, 주문별 조회에도 반영',async()=>{
  await reset();const cp=await seed(),before=await state(cp.id);await seedOrder();
  await q('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[cp.id,order]);
  assert.equal((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  assert.equal((await state(cp.id)).id,before.id);assert.equal((await state(cp.id)).review_obligation_status,'closed_no_review');
  assert.equal((await closed(cp.id))[0].order_submission_id,order);
  assert.equal((await close(cp.id)).alreadyClosed,true);
 });
 await test('소유자 최초 확인은 기존 식별정보가 유지되면 종결 보존',async()=>{
  await reset();const cp=await seed(null),before=await state(cp.id);
  await q('UPDATE campaign_participants SET owner_reviewer_id=$2 WHERE id=$1',[cp.id,owner]);
  assert.equal((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  assert.equal((await state(cp.id)).id,before.id);assert.equal((await state(cp.id)).review_obligation_status,'closed_no_review');
 });
 await test('검증 주문 연결과 소유자 최초 확인이 함께 일어나도 종결 보존',async()=>{
  await reset();const cp=await seed(null);await seedOrder();
  await q('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[cp.id,order]);
  assert.equal((await cpRow(cp.id)).owner_reviewer_id,owner);
  assert.equal((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  assert.equal((await state(cp.id)).review_obligation_status,'closed_no_review');
 });
 for(const [label,sql,params] of [
  ['소유자만 교체','owner_reviewer_id=$2',[other]],
  ['명의 식별자 교체',"participant_identity_id=$2",[identity]],
  ['참여 키 교체',"identity_key='replacement'",[]],
  ['전화번호 교체',"phone8='87654321'",[]],
  ['참여자 이름 교체',"reviewer_name='다른 참여자'",[]],
  ['최초 참여 시각 교체',"first_seen_at=first_seen_at+interval '1 second'",[]]
 ])await test(label+' 시 이전 종결 자동 승계 금지',async()=>{
  await reset();const cp=await seed();
  // Establish a different known identity before testing its replacement.
  if(label==='명의 식별자 교체'){
   await q('UPDATE campaign_participants SET participant_identity_id=$2 WHERE id=$1',[cp.id,other]);
   assert.equal((await closed(cp.id)).length,1);
  }
  await q('UPDATE campaign_participants SET '+sql+' WHERE id=$1',[cp.id,...params]);
  assert.equal((await closed(cp.id)).length,0);assert.equal((await state(cp.id)).review_obligation_status,'unknown');
 });
 for(const [label,who,opts] of [
  ['다른 소유자 주문',other,{}],['다른 전화번호 주문',owner,{phone:'01087654321'}],
  ['미검증 주문',owner,{verified:false}],['확인되지 않은 명의 주문',owner,{identity}]
 ])await test(label+' 연결은 종결을 자동 승계하지 않음',async()=>{
  await reset();const cp=await seed();await seedOrder(who,opts);
  await q('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[cp.id,order]);
  assert.equal((await closed(cp.id)).length,0);assert.notEqual((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  assert.equal((await state(cp.id)).review_obligation_status,'unknown');
 });
 await test('검증된 명의까지 일치한 주문 연결은 종결 유지',async()=>{
  await reset();const cp=await seed();await q('UPDATE campaign_participants SET participant_identity_id=$2 WHERE id=$1',[cp.id,identity]);
  await seedOrder(owner,{identity});await q('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[cp.id,order]);
  assert.equal((await closed(cp.id)).length,1);assert.equal((await state(cp.id)).review_obligation_status,'closed_no_review');
 });
 await test('정보 없는 행의 소유자 지정은 이전 종결 승계 금지',async()=>{
  await reset();const cp=await seed(null,{key:null,phone:null,name:null});
  await q('UPDATE campaign_participants SET owner_reviewer_id=$2 WHERE id=$1',[cp.id,owner]);
  assert.equal((await closed(cp.id)).length,0);
 });
 await test('A → B → A 재배정과 옛 토큰 직접 지정으로 종결이 되살아나지 않음',async()=>{
  await reset();const cp=await seed();await q('UPDATE campaign_participants SET owner_reviewer_id=$2 WHERE id=$1',[cp.id,other]);
  await q('UPDATE campaign_participants SET owner_reviewer_id=$2,review_participation_id=$3 WHERE id=$1',[cp.id,owner,cp.review_participation_id]);
  assert.equal((await closed(cp.id)).length,0);assert.notEqual((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  await q('UPDATE campaign_participants SET review_participation_id=$2 WHERE id=$1',[cp.id,cp.review_participation_id]);
  assert.equal((await closed(cp.id)).length,0);
 });
 await test('좌표 이동·메모·마감/재개·인덱스 재생성은 동일 참여 종결 유지',async()=>{
  await reset();const cp=await seed(),before=await state(cp.id);
  await q(`UPDATE campaign_participants SET seq=3,row_json=row_json||'{"비고":"확인"}'::jsonb,updated_at=now() WHERE id=$1`,[cp.id]);
  await q('UPDATE review_index SET row_index=3,id=gen_random_uuid(),built_at=now()');
  await q('UPDATE tab_configs SET is_closed=TRUE');await q('UPDATE tab_configs SET is_closed=FALSE');
  assert.equal((await closed(cp.id))[0].row_index,3);assert.equal((await state(cp.id)).id,before.id);
  assert.equal((await state(cp.id)).review_obligation_status,'closed_no_review');
 });
 await test('재배정 롤백은 참여 식별값·종결·장부를 함께 복구',async()=>{
  await reset();const cp=await seed(),before=await state(cp.id);await q('BEGIN');
  await q('UPDATE campaign_participants SET owner_reviewer_id=$2 WHERE id=$1',[cp.id,other]);await q('ROLLBACK');
  assert.equal((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);
  assert.equal((await state(cp.id)).id,before.id);assert.equal((await closed(cp.id)).length,1);
 });
 await test('알림 원장의 종결 복사본도 새 참여자에게 이전 결정을 재적용하지 않음',async()=>{
  await reset();await seedOrder();const cp=await seed(owner,{order});
  await q(`INSERT INTO review_reminder_states(order_submission_id,review_index_id,sheet_id,tab_name,row_index,review_deadline_at,review_status)
   VALUES($1,gen_random_uuid(),'s','t',2,now(),'closed_no_review')`,[order]);
  assert.equal((await q('SELECT * FROM review_closed_targets')).rows.length,1);
  await q("UPDATE campaign_participants SET owner_reviewer_id=$2,row_json='{}' WHERE id=$1",[cp.id,other]);
  assert.equal((await q('SELECT * FROM review_closed_targets')).rows.length,0);
  assert.notEqual((await state(cp.id)).review_obligation_status,'closed_no_review');
 });
 await test('식별값 없는 과거 종결을 현재 참여에 추정 연결하지 않음',async()=>{
  await reset();const cp=await seed();await q('UPDATE workdesk_review_resolutions SET review_participation_id=NULL WHERE participant_id=$1',[cp.id]);
  assert.equal((await closed(cp.id)).length,0);assert.equal((await state(cp.id)).review_obligation_status,'unknown');
 });
 await test('마이그레이션 재실행은 기존 참여 식별값과 종결을 보존',async()=>{
  await reset();const cp=await seed();await pg.exec(read('migrations/161_workdesk_review_resolutions.sql'));await pg.exec(read('migrations/162_reviewer_participations.sql'));
  await q('SELECT refresh_reviewer_participation($1)',[cp.id]);
  assert.equal((await cpRow(cp.id)).review_participation_id,cp.review_participation_id);assert.equal((await closed(cp.id)).length,1);
 });
 console.log(`${passed} closure assignment tests passed`);
 }finally{await pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
