'use strict';
// Isolated regression: no operational databases or providers are contacted.
for(const key of ['DATABASE_URL','DATABASE_PUBLIC_URL','PGTEST_URL','SOLAPI_API_KEY','SOLAPI_API_SECRET','REVIEW_REMINDER_ENABLED','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_SERVICE_ACCOUNT_JSON'])process.env[key]='';
process.env.NODE_ENV='test';process.env.TEST_SUITE='1';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),vm=require('vm');
const {performance}=require('perf_hooks');
const root=path.resolve(__dirname,'../..'),server=path.join(root,'server');
const read=p=>fs.readFileSync(path.join(server,p),'utf8');
const history=require(path.join(server,'src/services/reviewerHistory.service'));
const migration=require(path.join(server,'src/services/reviewerHistoryMigration.service'));
const obligation=require(path.join(server,'src/services/reviewObligation.service'));
const loader=require(path.join(root,'frontend/js/reviewer-history-loader'));
if(!process.env.PGLITE_MODULE){console.log('SKIP embedded PostgreSQL regression (PGLITE_MODULE not set)');process.exit(0);}
const {PGlite}=require(process.env.PGLITE_MODULE);
const disconnectedPool=require(path.join(server,'src/db/pool'));
disconnectedPool.query=async()=>{throw new Error('Audit blocked an unmocked database call');};
disconnectedPool.connect=async()=>{throw new Error('Audit blocked an unmocked database connection');};
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const order='dddddddd-dddd-4ddd-8ddd-dddddddddddd',identity='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const report={cases:[],metrics:{}};let pg,db,seq=1;
async function check(id,group,name,fn){try{const detail=await fn();report.cases.push({id,group,name,pass:true,detail:detail??null});}catch(e){report.cases.push({id,group,name,pass:false,error:e.message,actual:e.actual,expected:e.expected});}console.log(id+' '+(report.cases.at(-1).pass?'PASS':'FAIL')+' '+name);}
async function q(sql,params=[]){const r=await pg.query(sql,params);return {...r,rowCount:r.affectedRows};}
async function reset(){await pg.exec(`TRUNCATE campaign_participants,review_index,order_submissions,reviewer_participations,reviewer_participation_events,
  reviewer_owner_mapping_reviews,reviewer_history_rollouts,participant_edits,workdesk_review_resolutions,review_reminder_deliveries,review_reminder_states,
  participation_links,campaign_applications,index_master_archive,review_index_archive,trackb_tab_finished,reviewer_identities,workdesk_participant_deletions;
  TRUNCATE payment_batch_items,review_submissions,index_master,raw_sheet_tabs;
  DELETE FROM tab_configs WHERE tab_name<>'t';UPDATE tab_configs SET is_closed=FALSE,archived_rounds='';UPDATE reviewer_history_control SET coverage_epoch=1;`);seq=1;}
async function row(value='',who=owner,opts={}){const n=++seq;
 return (await q(`INSERT INTO campaign_participants(sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,identity_key,row_json,submit_col,order_submission_id,source)
  VALUES('s','t',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[n,opts.name===undefined?'가상 참여자':opts.name,opts.phone===undefined?'12345678':opts.phone,who,opts.key||'key-'+n,
 JSON.stringify(value===undefined?{}:{'리뷰제출':value}),opts.header===undefined?'리뷰제출':opts.header,opts.order||null,opts.source||'manual'])).rows[0];}
async function ledger(id){return (await q("SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1 ORDER BY (lifecycle_status='active') DESC,updated_at DESC",[id])).rows[0];}
async function page(who=owner,opts={}){return history.loadPage(`p.id,ri.reviewer_name AS name,p.review_obligation_status='fulfilled' AS "isSubmitted"`,{ownerReviewerId:who,...opts},db);}
async function index(cp,value='',submitted=false){return q(`INSERT INTO review_index(sheet_id,tab_name,row_index,reviewer_name,phone8,submit_col,row_json,is_submitted,end_date)
 VALUES('s','t',$1,'가상 참여자','12345678','리뷰제출',$2,$3,'2026-01-01')`,[cp.seq,JSON.stringify({'리뷰제출':value}),submitted]);}
async function certify(who=owner){const epoch=(await q('SELECT coverage_epoch FROM reviewer_history_control')).rows[0].coverage_epoch;
 return migration.certify({ownerReviewerId:who,legacy:[],projected:[],confirm:true,by:'isolated-test',coverageEpoch:epoch},db);}
async function seedOrder(who=owner,extra={}){return q(`INSERT INTO order_submissions(id,owner_reviewer_id,participant_identity_key_hash,mirror_status,phone,sheet_id,tab_name,sheet_row,submitted_at,sheet_written_at)
 VALUES($1,$2,'verified-test-hash',$3,'01012345678','s','t',2,$4,now())`,[extra.id||order,who,extra.status||'written',extra.at||new Date(Date.now()-86400000).toISOString()]);}
(async()=>{
 pg=new PGlite();db={query:q,connect:async()=>({query:q,release(){}})};
 const src=read('tests/reviewerHistory.test.js');
 const schema=src.match(/await pg\.exec\((`CREATE TABLE reviewers[\s\S]*?`)\);/)[1];
 await pg.exec(Function('owner','other','return '+schema)(owner,other));
 await pg.exec(`CREATE TABLE reviewer_identities(id uuid PRIMARY KEY,owner_reviewer_id uuid,current_phone8 text,status text DEFAULT 'active',member_no int);
 CREATE TABLE workdesk_participant_deletions(order_submission_id uuid,sheet_id text,tab_name text,seq int);
 CREATE TABLE payment_batch_items(sheet_id text,tab_name text,row_index int,status text);
 CREATE TABLE review_submissions(sheet_id text,tab_name text,row_index int,slot_key text,completed_at timestamptz);
 CREATE TABLE index_master(sheet_id text,tab_name text,submitted_count int);
 CREATE TABLE raw_sheet_tabs(sheet_id text,tab_name text,detected_headers jsonb,headers jsonb,mirrored_at timestamptz);
 ALTER TABLE participant_edits ADD reverted_by text;
 ALTER TABLE tab_configs ADD tab_gid text,ADD workboard_schema_version int DEFAULT 1;
 ALTER TABLE order_submissions ADD phone text,ADD sheet_row int;
 ALTER TABLE review_index ADD campaign_name text,ADD start_date text,ADD end_date text,ADD review_file_id text;
 ALTER TABLE review_submissions ADD file_id text,ADD upload_batch_id uuid;
 CREATE UNIQUE INDEX audit_cp_coord ON campaign_participants(sheet_id,tab_name,seq);
 CREATE INDEX audit_cp_order ON campaign_participants(order_submission_id);
 CREATE INDEX audit_cp_identity ON campaign_participants(sheet_id,tab_gid,identity_key) WHERE identity_key IS NOT NULL AND active;
 CREATE INDEX audit_ri_coord ON review_index(sheet_id,tab_name,row_index);
 CREATE INDEX audit_pe_anchor ON participant_edits(sheet_id,tab_name,anchor_type,anchor_value) WHERE reverted_at IS NULL;`);
 for(const file of ['160_review_reminder_alimtalk.sql','161_workdesk_review_resolutions.sql','162_reviewer_participations.sql'])await pg.exec(read('migrations/'+file));
 const values=[null,'',' ','\n','\t','\r\n','\u00a0','false',' FALSE ','false\n',false,true,0,'0','미제출',' 미제출 ','미제출\n','취소건','취소건\n','미작성 종결','톡방확인완료','톡방 확인 완료','2026-09-17','의미없는문자열'];
 for(let i=0;i<values.length;i++)await check('CELL-'+String(i+1).padStart(2,'0'),'cell','JS와 SQL 판정 일치 '+JSON.stringify(values[i]),async()=>{
  await reset();const cp=await row(values[i]);const expected=obligation.classifyCell(values[i]),actual=(await ledger(cp.id)).review_obligation_status;
  assert.equal(actual,expected);return {input:values[i],state:actual};});
 for(const state of ['pending','fulfilled','unknown'])for(const oldFlag of [false,true])await check('PAY-'+state+'-'+oldFlag,'payment','지급 플래그를 새 완료로 자동 승격하지 않음',async()=>{
  await reset();const cp=await row(state==='pending'?'false':state==='fulfilled'?'톡방확인완료':'취소건');await index(cp,'',oldFlag);
  const sql=read('src/services/payment.service.js').match(/`NOT EXISTS \(SELECT 1 FROM reviewer_participations p WHERE p\.sheet_id=ri\.sheet_id[\s\S]*?\)`/)[0];
  const gate=Function('return '+sql)();const got=await q(`SELECT 1 FROM review_index ri WHERE ri.is_submitted=TRUE AND ${gate}`);
  assert.equal(got.rows.length,oldFlag&&state==='fulfilled'?1:0);return {state,oldFlag,eligible:got.rows.length};});
 await check('STATE-01','state','완료 후 빈값·false·미제출로 수정해도 완료 유지',async()=>{
  await reset();const cp=await row('톡방확인완료'),before=await ledger(cp.id);
  for(const v of ['',false,'미제출']){await q('UPDATE campaign_participants SET row_json=$2 WHERE id=$1',[cp.id,JSON.stringify({'리뷰제출':v})]);const after=await ledger(cp.id);assert.equal(after.id,before.id);assert.equal(after.review_obligation_status,'fulfilled');}
 });
 await check('STATE-02','state','기존 완료 참여에 주문 연결만 보강해도 완료 유지',async()=>{
  await reset();const cp=await row('톡방확인완료'),before=await ledger(cp.id);await q("UPDATE campaign_participants SET row_json='{}' WHERE id=$1",[cp.id]);await seedOrder();
  await q('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[cp.id,order]);assert.equal((await ledger(cp.id)).review_obligation_status,'fulfilled');
  assert.equal((await ledger(cp.id)).id,before.id);
 });
 await check('STATE-03','state','제출 열을 뒤늦게 확인한 인덱스 재생성에서 완료 반영',async()=>{
  await reset();const cp=await row('톡방확인완료',owner,{header:null});assert.equal((await ledger(cp.id)).review_obligation_status,'unknown');await index(cp,'톡방확인완료',true);
  assert.equal((await ledger(cp.id)).review_obligation_status,'fulfilled');
 });
 await check('STATE-04','state','실제 주문 재배정은 새 참여 ID와 미제출로 시작',async()=>{
  await reset();await seedOrder();const cp=await row('톡방확인완료',owner,{order});const first=await ledger(cp.id);
  await q("UPDATE campaign_participants SET order_submission_id=$2,row_json='{}' WHERE id=$1",[cp.id,other]);const now=await ledger(cp.id);
  assert.notEqual(now.id,first.id);assert.equal(now.review_obligation_status,'pending');assert.equal((await q('SELECT lifecycle_status FROM reviewer_participations WHERE id=$1',[first.id])).rows[0].lifecycle_status,'cancelled');
 });
 await check('STATE-05','state','수동 행 소유자가 바뀌면 전 소유자 완료 증거를 승계하지 않음',async()=>{
  await reset();const cp=await row('톡방확인완료');await q("UPDATE campaign_participants SET owner_reviewer_id=$2,reviewer_name='다른 참여자',phone8='87654321',identity_key='replacement',row_json='{}' WHERE id=$1",[cp.id,other]);
  assert.equal((await ledger(cp.id)).review_obligation_status,'pending');
 });
 await check('STATE-06','state','빈 슬롯은 리뷰내역에 표시하지 않음',async()=>{
  await reset();await row('',owner,{name:null,phone:null});assert.equal((await page()).rows.length,0);
 });
 for(const kind of ['is_closed','archived_round','deleted','inactive','held'])await check('LIFE-'+kind,'lifecycle',kind+' 처리와 목록 노출',async()=>{
  await reset();const cp=await row('톡방확인완료');
  if(kind==='is_closed')await q('UPDATE tab_configs SET is_closed=TRUE');
  if(kind==='archived_round'){await q("UPDATE campaign_participants SET round='R2' WHERE id=$1",[cp.id]);await q("UPDATE tab_configs SET archived_rounds=' R1, R2 '");}
  if(kind==='deleted')await q('DELETE FROM campaign_participants WHERE id=$1',[cp.id]);
  if(kind==='inactive')await q('UPDATE campaign_participants SET active=FALSE WHERE id=$1',[cp.id]);
  if(kind==='held')await q('UPDATE campaign_participants SET held_at=now() WHERE id=$1',[cp.id]);
  // held is deliberately workboard-only separation; reviewer history remains visible.
  assert.equal((await page()).rows.length,kind==='held'?1:0);
 });
 for(const which of ['same_phone','different_phone','sub'])await check('OWNER-'+which,'owner','소유권 격리 '+which,async()=>{
  await reset();const a=await row('',owner),b=await row('',other,{phone:which==='different_phone'?'87654321':'12345678'});
  if(which==='sub'){await q('UPDATE campaign_participants SET participant_identity_id=$2 WHERE id=$1',[a.id,identity]);await q('INSERT INTO reviewer_identities(id,owner_reviewer_id,current_phone8) VALUES($1,$2,$3)',[identity,owner,'12345678']);
   assert.equal((await page(owner,{restrictParticipant:true,participantIdentityId:identity,ownerPhone8s:['12345678']})).rows.length,1);}
  assert.equal((await page()).rows.length,1);assert.equal(await history.ownsProjectedTarget({session:{ownerReviewerId:owner},sheetId:'s',tabName:'t',rowIndex:b.seq,client:db}),false);
 });
 await check('OWNER-conflict','owner','주문과 참여행의 다른 소유자는 노출·제출 차단',async()=>{
  await reset();await seedOrder(other);const cp=await row('',owner,{order});assert.equal((await ledger(cp.id)).ownership_status,'conflict');assert.equal((await page()).rows.length,0);
  assert.equal(await history.ownsProjectedTarget({session:{ownerReviewerId:owner},sheetId:'s',tabName:'t',rowIndex:cp.seq,client:db}),false);
 });
 await check('OWNER-duplicate','owner','중복 주문 연결을 해소하면 남은 정상 참여를 자동 복구',async()=>{
  await reset();await seedOrder();const a=await row('',owner,{order}),b=await row('',owner,{order});assert.equal((await ledger(b.id)).ownership_status,'conflict');
  assert.equal((await ledger(a.id)).ownership_status,'conflict');
  await q('DELETE FROM campaign_participants WHERE id=$1',[a.id]);assert.equal((await ledger(b.id)).ownership_status,'confirmed');
 });
 await check('CUTOVER-unrelated','cutover','무관한 미확정 참여 1건은 다른 소유자 전환에 영향 없음',async()=>{
  await reset();await row('',owner);await row('',other);await certify(owner);await certify(other);assert.equal(await history.availability(owner,db),true);
  await row('',null,{phone:'99999999'});assert.equal(await history.availability(owner,db),true);
 });
 await check('CUTOVER-pending','cutover','현재 미반영 주문은 기존 조회로 돌려 카드 누락 방지',async()=>{
  await reset();await row('',owner);await certify();await seedOrder(owner,{status:'pending'});assert.equal(await history.availability(owner,db),false);
 });
 await check('CUTOVER-closed','cutover','마감 작업의 과거 주문은 현재 조회 전환을 막지 않음',async()=>{
  await reset();const cp=await row('',owner);await q("INSERT INTO tab_configs(sheet_id,tab_name) VALUES('s','t2')");await q("UPDATE campaign_participants SET tab_name='t2' WHERE id=$1",[cp.id]);await certify();await seedOrder();await q("UPDATE tab_configs SET is_closed=TRUE WHERE tab_name='t'");assert.equal(await history.availability(owner,db),true);
 });
 await check('CUTOVER-oldpending','cutover','기존 14일 범위 밖인 90일 초과 미반영 주문은 전환을 막지 않음',async()=>{
  await reset();await row('',owner);await certify();await seedOrder(owner,{status:'pending',at:'2026-01-01T00:00:00Z'});assert.equal(await history.availability(owner,db),true);
  return {note:'legacy _ORDER_MERGE_DAYS=14; not a newly introduced history loss'};
 });
 await check('CUTOVER-disappeared','cutover','소유자 미확정 참여가 삭제된 뒤 재확인 없이 새 조회 복귀하지 않음',async()=>{
  await reset();await row('',owner);await certify();const unknown=await row('',null);await q('DELETE FROM campaign_participants WHERE id=$1',[unknown.id]);assert.equal(await history.availability(owner,db),false);
 });
 await check('PAGE-450','paging','450건 9페이지에 누락·중복 없음',async()=>{
  await reset();await q(`INSERT INTO campaign_participants(sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,identity_key,row_json)
   SELECT 's','t',i,'합성'||i,'12345678',$1,'page-'||i,'{"리뷰제출":""}'::jsonb FROM generate_series(1,450) i`,[owner]);
  let cursor=null,all=[],n=0;do{const p=await page(owner,{historyCursor:cursor});all.push(...p.rows.map(r=>r.participationId));cursor=p.nextCursor;n++;}while(cursor);
  assert.equal(all.length,450);assert.equal(new Set(all).size,450);assert.equal(n,9);return{rows:all.length,pages:n};
 });
 for(const [input,expected] of [[1,1],[50,50],[100,100],[500,100],[-1,1],[0,50],['bad',50],[1.5,1]])await check('LIMIT-'+input,'paging','페이지 상한 '+input,async()=>{assert.equal((await page(owner,{historyLimit:input})).rows.length,expected);});
 await check('PAGE-rebuild','paging','의미가 같은 인덱스 재생성은 다음 페이지를 끊지 않음',async()=>{
  const cp=(await q('SELECT * FROM campaign_participants LIMIT 1')).rows[0];await index(cp);const first=await page();
  await q('UPDATE review_index SET id=gen_random_uuid(),built_at=now()');
  let code=null;try{await page(owner,{historyCursor:first.nextCursor});}catch(e){code=e.code;}assert.equal(code,null);
 });
 for(const bad of ['broken',Buffer.from('{}').toString('base64url'),'x'.repeat(1201)])await check('CURSOR-'+bad.length,'paging','변조 커서 거부 '+bad.length,async()=>{await assert.rejects(page(owner,{historyCursor:bad}),e=>e.code==='HISTORY_CURSOR_INVALID');});
 for(const value of ['톡방확인완료','취소건','미제출'])await check('REMINDER-'+value,'reminder','완료·검토·과거 종결은 독촉 후보에서 제외 '+value,async()=>{
  await reset();await seedOrder();const cp=await row(value,owner,{order});await index(cp,value,false);
  const service=require(path.join(server,'src/services/reviewReminder.service')).createReviewReminderService({db,provider:{}});
  const candidates=await service.loadCandidates(100);assert.equal(candidates.length,0);return {candidates:candidates.length};
 });
 await check('MAPPING-dryrun','migration','수동 귀속 사전조회는 변경 없음',async()=>{
  await reset();const cp=await row('',null),revision=(await q('SELECT updated_at::text AS v FROM campaign_participants WHERE id=$1',[cp.id])).rows[0].v;
  await migration.assignReviewedOwner({rowId:cp.id,ownerReviewerId:owner,expectedRevision:revision,evidence:'합성 확인',by:'tester'},db);
  assert.equal((await ledger(cp.id)).owner_reviewer_id,null);assert.equal((await q('SELECT * FROM reviewer_owner_mapping_reviews')).rows.length,0);
 });
 await check('MAPPING-conflict','migration','수동 귀속은 다른 주문 소유자를 덮어쓰지 않음',async()=>{
  await reset();const cp=await row('',null);await q('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[cp.id,order]);await seedOrder(other);
  const revision=(await q('SELECT updated_at::text AS v FROM campaign_participants WHERE id=$1',[cp.id])).rows[0].v;
  await assert.rejects(migration.assignReviewedOwner({rowId:cp.id,ownerReviewerId:owner,expectedRevision:revision,evidence:'합성 확인',by:'tester',confirm:true},db));
 });
 await check('MAPPING-archivedround','migration','마감 차수 행을 소유자 보정 대상에서 제외',async()=>{
  await reset();const cp=await row('',null);await q("UPDATE campaign_participants SET round='R1' WHERE id=$1",[cp.id]);await q("UPDATE tab_configs SET archived_rounds='R1'");
  assert.equal((await migration.preview({},db)).items.length,0);
 });
 await check('MAPPING-existing-conflict','migration','기존 owner가 주문과 충돌하면 사전조회에서 충돌로 표시',async()=>{
  await reset();await seedOrder(other);await row('',owner,{order});assert.equal((await migration.preview({},db)).items[0].decision,'conflict');
 });
 await check('TX-rollback','transaction','트랜잭션 취소 시 참여 원장·감사 기록도 롤백',async()=>{
  await reset();await q('BEGIN');await row('톡방확인완료');await q('ROLLBACK');assert.equal((await q('SELECT * FROM reviewer_participations')).rows.length,0);assert.equal((await q('SELECT * FROM reviewer_participation_events')).rows.length,0);
 });
 const resolution=require(path.join(server,'src/services/workdeskReviewResolution.service'));
 const statusService=require(path.join(server,'src/services/sheetlessStatus.service'));statusService.__setPoolForTest(db);
 async function close(cp){const revision=(await q('SELECT updated_at::text AS v FROM campaign_participants WHERE id=$1',[cp.id])).rows[0]?.v;
  return resolution.closeWithoutReview({db,sheetId:'s',tabName:'t',rowId:cp.id,expectedRevision:revision,confirm:true,by:'isolated-audit',deriveAnchor:r=>({type:r.order_submission_id?'order':'manual',value:r.order_submission_id||r.id})});}
 async function submit(cp){return statusService.markStatusCell({sheetId:'s',tabName:'t',rowIndex:cp.seq,kind:'submit',value:'9/17 15:00',deferRebuild:true});}
 for(const first of ['submit','close'])await check('SEQ-'+first,'sequence','실제 저장 서비스 순서 '+first+' 우선',async()=>{
  await reset();const cp=await row('');await index(cp);await q("INSERT INTO index_master VALUES('s','t',0)");
  if(first==='submit'){assert.equal((await submit(cp)).ok,true);await assert.rejects(close(cp),e=>e.code==='review_record_exists');assert.equal((await ledger(cp.id)).review_obligation_status,'fulfilled');}
  else {assert.equal((await close(cp)).ok,true);assert.equal((await submit(cp)).ok,false);assert.equal((await ledger(cp.id)).review_obligation_status,'closed_no_review');}
 });
 await check('SEQ-cancel-submit','sequence','행 취소 이후 제출은 되살리지 않음',async()=>{
  await reset();const cp=await row('');await index(cp);await q('BEGIN');await resolution.recordResolution(db,cp,'order_cancelled','isolated','test');await q('DELETE FROM campaign_participants WHERE id=$1',[cp.id]);await q('COMMIT');
  assert.equal((await submit(cp)).ok,false);assert.equal((await ledger(cp.id)).lifecycle_status,'cancelled');
 });
 await check('SEQ-close-repeat','sequence','종결 중복 실행은 이중 감사 기록 없음',async()=>{
  await reset();const cp=await row('미제출');await index(cp);await close(cp);assert.equal((await close(cp)).alreadyClosed,true);
  assert.equal((await q('SELECT history FROM workdesk_review_resolutions')).rows[0].history.length,1);
 });
 for(const flag of ['paid','batch','file'])await check('SEQ-'+flag,'sequence',flag+' 상태에서 종결 거부',async()=>{
  await reset();const cp=await row('');await index(cp);
  if(flag==='paid')await q('UPDATE campaign_participants SET is_paid=TRUE WHERE id=$1',[cp.id]);
  if(flag==='batch')await q("INSERT INTO payment_batch_items VALUES('s','t',$1,'pending')",[cp.seq]);
  if(flag==='file')await q("INSERT INTO review_submissions(sheet_id,tab_name,row_index,slot_key,completed_at) VALUES('s','t',$1,'review',now())",[cp.seq]);
  await assert.rejects(close(cp),e=>e.code===({paid:'already_paid',batch:'payment_in_progress',file:'review_record_exists'})[flag]);
  assert.equal((await q('SELECT * FROM workdesk_review_resolutions')).rows.length,0);
 });
 await check('SEQ-archivedround-close','sequence','마감 차수에서 종결 요청 거부',async()=>{
  await reset();const cp=await row('');await index(cp);await q("UPDATE campaign_participants SET round='R1' WHERE id=$1",[cp.id]);await q("UPDATE tab_configs SET archived_rounds='R1'");
  await assert.rejects(close(cp),e=>e.code==='archived');
 });
 await check('FRONT-error-count','frontend','최초 조회 실패 때 탭 숫자도 0건으로 확정하지 않음',async()=>{
  const source=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8');
  const start=source.indexOf('function renderReviewSubTab()'),end=source.indexOf('\nfunction ',start+10);
  const elements={};const c={window:{},document:{getElementById(id){return elements[id]||(elements[id]={classList:{toggle(){}},textContent:'',innerHTML:''});}},
   _reviewSubTab:'pending',_historyCounts:null,_reviewListData:{pending:[],done:[]},_reviewListLoading:false,_reviewListError:'timeout',escHtml:s=>s};
  vm.runInNewContext(source.slice(start,end),c);c.renderReviewSubTab();
  assert.equal(elements.reviewResultsCount.textContent,'조회 실패');assert.notEqual(String(elements.subtabPendingCount.textContent),'0');
 });
 await check('FRONT-account-late','frontend','계정 전환의 지연된 성공·실패 응답을 모두 폐기',async()=>{
  for(const error of [false,true]){const c=loader.createCoordinator();let finish;const wait=new Promise((resolve,reject)=>finish=error?reject:resolve);const old=c.load('A',()=>wait);await c.load('B',async()=>2);await c.load('A',async()=>3);finish(error?new Error('old-error'):'old-data');assert.equal((await old).stale,true);}
 });
 await check('FRONT-singleflight','frontend','동일 계정 20개 동시 요청은 네트워크 1회',async()=>{
  const c=loader.createCoordinator();let n=0,resolve;const wait=new Promise(r=>resolve=r);const calls=Array.from({length:20},()=>c.load('a',()=>{n++;return wait;}));resolve(1);await Promise.all(calls);assert.equal(n,1);return {requests:20,network:n};
 });
 await check('FRONT-timeout','frontend','15초 경과 시 요청 중단과 오류 반환',async()=>{
  const src=fs.readFileSync(path.join(root,'frontend/js/reviewer-history-loader.js'),'utf8');let timer,delay,clean=false;
  const context={AbortController,setTimeout(fn,ms){timer=fn;delay=ms;return 1;},clearTimeout(){clean=true;},fetch(_url,opts){return new Promise((_resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'}))));}};
  vm.runInNewContext(src,context);const p=context.ReviewerHistoryLoader.fetchPage('','test-token','pending');timer();await assert.rejects(p,e=>e.name==='AbortError');assert.equal(delay,15000);assert.equal(clean,true);
 });
 await check('FRONT-404','frontend','서버 구버전 404만 기존 조회로 전환',async()=>{
  const src=fs.readFileSync(path.join(root,'frontend/js/reviewer-history-loader.js'),'utf8');const c={AbortController,setTimeout,clearTimeout,fetch:async()=>({status:404})};vm.runInNewContext(src,c);assert.equal((await c.ReviewerHistoryLoader.fetchPage('','x','pending')).mode,'legacy');
  c.fetch=async()=>({status:500,ok:false,json:async()=>({ok:false,error:'server-failed'})});await assert.rejects(c.ReviewerHistoryLoader.fetchPage('','x','pending'),/server-failed/);
 });
 const submitFixture=read('tests/blogPostUrlSubmit.test.js');
 let submitHelpers=submitFixture.slice(submitFixture.indexOf('function loadSubmitRouter'),submitFixture.indexOf('\nconst BASE ='));
 submitHelpers=submitHelpers.replace('markStatusCell: async () => ({ handled: false })','markStatusCell: async (args) => { if(statusResult instanceof Error) throw statusResult; return typeof statusResult === "function" ? statusResult(args) : statusResult; }');
 submitHelpers=submitHelpers.replace('markSheetlessMemo: async () => ({ handled: true, ok: true })','markSheetlessMemo: async (args) => typeof memoResult === "function" ? memoResult(args) : memoResult');
 const fixtureRequire=require('node:module').createRequire(path.join(server,'tests/blogPostUrlSubmit.test.js'));
 async function submitRoute(statusResult,queryHook=null,body={},memoResult={handled:true,ok:true}){const context={require:fixtureRequire,assert,statusResult,memoResult,setImmediate,Error};vm.runInNewContext(submitHelpers,context);
   const reminders=require(path.join(server,'src/services/reviewReminder.service')),saved=reminders.closedStateForTarget;
   reminders.closedStateForTarget=async()=>null;
   try{return await context.callReview({workKind:'blog',hasCapture:true,queryHook},{sheetId:'S',tabName:'T',rowIndex:7,submitCol:'리뷰제출',gid:'1',uploadBatchId:'11111111-1111-4111-8111-111111111111',memo:'https://example.com/review',...body});}
   finally{reminders.closedStateForTarget=saved;}}
 for(const failure of ['return','throw'])await check('SUBMIT-error-'+failure,'submit','작업보드 저장 '+failure+' 오류는 성공으로 응답하지 않음',async()=>{
  const r=await submitRoute(failure==='throw'?new Error('synthetic DB failure'):{handled:true,ok:false,reason:'write_failed'});
  assert.equal(r.payload.ok,false,JSON.stringify(r.payload));assert.equal(r.payload.code,'REVIEW_BOARD_WRITE_FAILED');return {retryable:r.payload.retryable};
 });
 await check('SUBMIT-partial','submit','실패 응답 전 제출 플래그까지 확정되지 않음',async()=>{
  const r=await submitRoute({handled:true,ok:false,reason:'write_failed'});
  assert.equal(r.payload.code,'REVIEW_BOARD_WRITE_FAILED',JSON.stringify(r.payload));
  const mutations=r.queries.filter(x=>/UPDATE campaign_participants SET is_submitted = TRUE/.test(x.sql));assert.equal(mutations.length,0);
 });
 for(const point of ['cell','batch','flag','commit','success'])await check('TX-SUBMIT-'+point,'transaction','실제 라우트·임시 DB 제출 저장 '+point,async()=>{
  await reset();const cp=await row('');await index(cp);const batch='11111111-1111-4111-8111-111111111111';
  await q("INSERT INTO review_submissions(sheet_id,tab_name,row_index,slot_key,file_id,upload_batch_id) VALUES('s','t',$1,'review','test-file',$2)",[cp.seq,batch]);
  await q("UPDATE review_index SET review_file_id='test-file'");
  let inTransaction=false,injected=false;
  const queryHook=async(sql,params)=>{
   if(sql==='BEGIN')inTransaction=true;
   if(!inTransaction)return undefined;
   const fail=(point==='cell'&&/SET row_json/.test(sql)) || (point==='batch'&&/current_batch AS/.test(sql))
     || (point==='flag'&&/UPDATE campaign_participants SET is_submitted = TRUE/.test(sql)) || (point==='commit'&&sql==='COMMIT');
   if(fail&&!injected){injected=true;throw new Error('injected '+point);}
   const result=await q(sql,params);
   if(sql==='COMMIT'||sql==='ROLLBACK')inTransaction=false;
   return result;
  };
  const r=await submitRoute(args=>statusService.markStatusCell(args),queryHook,{sheetId:'s',tabName:'t',rowIndex:cp.seq});
  assert.equal(inTransaction,false,'transaction released');
  const stored=(await q('SELECT is_submitted,row_json FROM campaign_participants WHERE id=$1',[cp.id])).rows[0];
  const file=(await q('SELECT completed_at FROM review_submissions')).rows[0];
  const ri=(await q('SELECT is_submitted FROM review_index')).rows[0];
  if(point==='success'){
   assert.equal(r.payload.ok,true,JSON.stringify(r.payload));assert.equal(stored.is_submitted,true);assert.equal(ri.is_submitted,true);
   assert.ok(file.completed_at);assert.equal((await ledger(cp.id)).review_obligation_status,'fulfilled');
   assert.ok(r.queries.findIndex(x=>x.sql==='REBUILD_AFTER_COMMIT')>r.queries.findIndex(x=>x.sql==='COMMIT'));
  }else{
   assert.equal(injected,true);assert.equal(r.payload.ok,false,JSON.stringify(r.payload));assert.equal(stored.is_submitted,false);assert.equal(ri.is_submitted,false);
   assert.equal(stored.row_json['리뷰제출'],'');assert.equal(file.completed_at,null);assert.equal((await ledger(cp.id)).review_obligation_status,'pending');
   assert.equal((await q("SELECT count(*)::int n FROM reviewer_participation_events WHERE after_state->>'review'='fulfilled'")).rows[0].n,0);
  }
  return {committed:r.payload.ok,attachmentRetained:true};
 });
 for(const point of ['return','throw','unhandled','scope','headers','missing_column','write','flag','commit','success','retry','resubmit'])await check('TX-URL-'+point,'transaction','필수 URL과 완료를 함께 저장 '+point,async()=>{
  await reset();const cp=await row('');await index(cp);
  const batch='11111111-1111-4111-8111-111111111111',oldUrl='https://example.com/previous',newUrl='https://example.com/current';
  await q(`UPDATE campaign_participants SET row_json=row_json||jsonb_build_object('포스팅',$2::text) WHERE id=$1`,[cp.id,oldUrl]);
  await q(`INSERT INTO raw_sheet_tabs(sheet_id,tab_name,detected_headers) VALUES('s','t',$1::jsonb)`,[JSON.stringify(point==='missing_column'?['리뷰제출']:['리뷰제출','포스팅','비고'])]);
  await q("INSERT INTO review_submissions(sheet_id,tab_name,row_index,slot_key,file_id,upload_batch_id) VALUES('s','t',$1,'review','test-file',$2)",[cp.seq,batch]);
  await q("UPDATE review_index SET review_file_id='test-file'");
  let inTransaction=false,memoStarted=false,inject=true;
  const queryHook=async(sql,params)=>{
   if(sql==='BEGIN')inTransaction=true;
   if(!inTransaction)return undefined;
   if(inject && ((memoStarted&&point==='scope'&&/FROM tab_configs/.test(sql))
    ||(memoStarted&&point==='headers'&&/FROM raw_sheet_tabs/.test(sql))
    ||(memoStarted&&point==='write'&&/SET row_json/.test(sql))
    ||(point==='flag'&&/UPDATE campaign_participants SET is_submitted = TRUE/.test(sql))
    ||(point==='commit'&&sql==='COMMIT')))throw Error('injected URL '+point);
   const result=await q(sql,params);if(sql==='COMMIT'||sql==='ROLLBACK')inTransaction=false;return result;
  };
  const memoResult=async args=>{
   assert.ok(args.client,'URL writer must receive completion client');memoStarted=true;
   if(inject&&['return','retry'].includes(point))return {handled:true,ok:false,reason:'injected memo failure'};
   if(inject&&point==='throw')throw Error('injected memo exception');
   if(inject&&point==='unhandled')return {handled:false};
   return statusService.markSheetlessMemo(args);
  };
  const perform=()=>submitRoute(args=>statusService.markStatusCell(args),queryHook,{sheetId:'s',tabName:'t',rowIndex:cp.seq,memo:newUrl},memoResult);
  const r=await perform(),succeeded=['success','resubmit'].includes(point);
  assert.equal(r.payload.ok,succeeded,JSON.stringify(r.payload));assert.equal(inTransaction,false);
  if(!succeeded){
   const stored=(await q('SELECT row_json,is_submitted FROM campaign_participants WHERE id=$1',[cp.id])).rows[0];
   assert.equal(stored.row_json['포스팅'],oldUrl);assert.equal(stored.row_json['리뷰제출'],'');assert.equal(stored.is_submitted,false);
   assert.equal((await q('SELECT is_submitted FROM review_index')).rows[0].is_submitted,false);
   assert.equal((await q('SELECT completed_at FROM review_submissions')).rows[0].completed_at,null);
   assert.equal((await ledger(cp.id)).review_obligation_status,'pending');
   assert.ok(!r.queries.some(x=>x.sql==='REBUILD_AFTER_COMMIT'));
   if(!['flag','commit'].includes(point))assert.equal(r.payload.code,'REVIEW_POST_URL_WRITE_FAILED');
   assert.equal(r.payload.retryable,true);
  }
  if(['retry','resubmit'].includes(point)){inject=false;memoStarted=false;assert.equal((await perform()).payload.ok,true);}
  if(succeeded||point==='retry'){
   const stored=(await q('SELECT row_json,is_submitted FROM campaign_participants WHERE id=$1',[cp.id])).rows[0];
   assert.equal(stored.row_json['포스팅'],newUrl);assert.equal(stored.is_submitted,true);
   assert.equal((await ledger(cp.id)).review_obligation_status,'fulfilled');
   assert.ok((await q('SELECT completed_at FROM review_submissions')).rows[0].completed_at);
   assert.equal((await q('SELECT count(*)::int n FROM review_submissions')).rows[0].n,1);
  }
  return {firstRequestSucceeded:succeeded,retryChecked:point==='retry',resubmitChecked:point==='resubmit'};
 });
 await check('CUTOVER-comparison-race','cutover','대조 도중 새 미확정 행이 생기면 낡은 인증 저장 거부',async()=>{
  await reset();await row('',owner);const epoch=(await q('SELECT coverage_epoch FROM reviewer_history_control')).rows[0].coverage_epoch;
  await row('',null);assert.equal((await migration.certify({ownerReviewerId:owner,legacy:[],projected:[],confirm:true,by:'test',coverageEpoch:epoch},db)).ok,false);
 });
 await check('PAGE-index-id','paging','인덱스 ID는 최신 값으로 바뀌어도 페이지 버전은 유지',async()=>{
  await reset();const cp=await row('');await index(cp);const before=await ledger(cp.id);await q('UPDATE review_index SET id=gen_random_uuid(),built_at=now()');
  const after=await ledger(cp.id);assert.notEqual(after.index_snapshot.id,before.index_snapshot.id);assert.equal(after.record_version,before.record_version);
 });
 for(const value of ['취소건\n','미제출\n','\n'])await check('REMINDER-recheck-'+JSON.stringify(value),'reminder','발송 직전 현재 셀 재검사 '+JSON.stringify(value),async()=>{
  await reset();const cp=await row('');await index(cp);assert.equal(await obligation.canRemind({sheetId:'s',tabName:'t',rowIndex:cp.seq},db),true);
  await q('UPDATE campaign_participants SET row_json=$2 WHERE id=$1',[cp.id,JSON.stringify({'리뷰제출':value})]);
  assert.equal(await obligation.canRemind({sheetId:'s',tabName:'t',rowIndex:cp.seq},db),value==='\n');
 });
 await check('CELL-unicode','cell','ECMAScript 앞뒤 공백 25종 정규화 일치',async()=>{
  for(const code of [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]){
   const space=String.fromCodePoint(code),value=space+'false'+space;
   assert.equal((await q('SELECT review_cell_text($1) AS value',[value])).rows[0].value,value.trim());
  }
 });
 for(const mode of ['dryrun','apply','paid','valid','stale'])await check('REPAIR-'+mode,'migration','오완료 보정 안전장치 '+mode,async()=>{
  await reset();const cp=await row(mode==='valid'?'톡방확인완료':'false\n');await index(cp);
  if(mode!=='valid')await q("UPDATE reviewer_participations SET review_obligation_status='fulfilled' WHERE campaign_participant_id=$1",[cp.id]);
  if(mode==='paid')await q('UPDATE campaign_participants SET is_paid=TRUE WHERE id=$1',[cp.id]);
  const p=await ledger(cp.id),args={participationId:p.id,expectedVersion:mode==='stale'?'0':p.record_version,evidence:'과거 공백 오판정 테스트',by:'test',confirm:mode!=='dryrun'};
  if(['paid','valid','stale'].includes(mode)){await assert.rejects(migration.repairInvalidFulfillment(args,db));assert.equal((await ledger(cp.id)).review_obligation_status,'fulfilled');}
  else {const result=await migration.repairInvalidFulfillment(args,db);assert.equal(result.ok,true);assert.equal((await ledger(cp.id)).review_obligation_status,mode==='apply'?'pending':'fulfilled');}
 });
 for(const mode of ['archived','inactive','legacy_closed','legacy_cancelled'])await check('SUBMIT-block-'+mode,'sequence','직접 셀 기록에서 종료 참여 차단 '+mode,async()=>{
  await reset();const cp=await row(mode==='legacy_closed'?'미제출':mode==='legacy_cancelled'?'취소건':'');await index(cp);
  if(mode==='archived'){await q("UPDATE campaign_participants SET round='R1' WHERE id=$1",[cp.id]);await q("UPDATE tab_configs SET archived_rounds='R1'");}
  if(mode==='inactive')await q('UPDATE campaign_participants SET active=FALSE WHERE id=$1',[cp.id]);
  assert.equal((await submit(cp)).ok,false);assert.equal((await q('SELECT is_submitted FROM campaign_participants WHERE id=$1',[cp.id])).rows[0].is_submitted,false);
 });
 await check('STATE-different-order-person','state','첫 주문 연결이라도 참여 연락처가 다르면 완료를 승계하지 않음',async()=>{
  await reset();const cp=await row('톡방확인완료'),before=await ledger(cp.id);await seedOrder();await q("UPDATE order_submissions SET phone='01099999999'");
  await q("UPDATE campaign_participants SET order_submission_id=$2,row_json='{}' WHERE id=$1",[cp.id,order]);
  const after=await ledger(cp.id);assert.notEqual(after.id,before.id);assert.equal(after.review_obligation_status,'pending');
 });
 for(const mode of ['recent_written','old_written','failed','stuck_manual'])await check('CUTOVER-window-'+mode,'cutover','미반영 주문 보완 범위 '+mode,async()=>{
  await reset();await row('',owner);await certify();await seedOrder(owner,{status:mode.includes('written')?'written':mode});
  if(mode==='old_written')await q("UPDATE order_submissions SET sheet_written_at=now()-interval '3 hours'");
  assert.equal(await history.availability(owner,db),mode==='old_written');
 });
 for(const value of ['미제출','취소건'])await check('SUBMIT-legacy-message-'+value,'submit','과거 종결·취소는 재시도 대신 관리자 확인 안내 '+value,async()=>{
  await reset();const cp=await row(value);await index(cp,value);await q('BEGIN');
  try {await assert.rejects(require('../src/services/reviewCompletionTransaction.service').lockTarget(db,{sheetId:'s',tabName:'t',rowIndex:cp.seq}),e=>e.code==='REVIEW_LEGACY_RESOLUTION_PENDING');}
  finally {await q('ROLLBACK');}
 });
 await check('REMINDER-round-before-rebuild','reminder','차수 마감 직후 오래된 인덱스에서도 독촉 차단',async()=>{
  await reset();await seedOrder();const cp=await row('',owner,{order});await index(cp);
  await q("UPDATE campaign_participants SET round='R1' WHERE id=$1",[cp.id]);await q("UPDATE tab_configs SET archived_rounds='R1'");
  const service=require('../src/services/reviewReminder.service').createReviewReminderService({db,provider:{}});
  assert.equal((await service.loadCandidates(100)).length,0);
  assert.equal(await obligation.canRemind({sheetId:'s',tabName:'t',rowIndex:cp.seq},db),false);
 });
 await check('PERF-write','performance','합성 500행 쓰기의 투영 비용 측정',async()=>{
  await reset();const sql=`INSERT INTO campaign_participants(sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,identity_key,row_json)
    SELECT 's','t',i,'합성'||i,'12345678',$1,'bench-'||i,'{"리뷰제출":""}'::jsonb FROM generate_series(1,500) i`;
  const times={baseline:[],projection:[]};
  for(const mode of ['baseline','projection'])for(let i=0;i<4;i++){
   await reset();await pg.exec(`ALTER TABLE campaign_participants ${mode==='baseline'?'DISABLE':'ENABLE'} TRIGGER USER`);const start=performance.now();await q(sql,[owner]);times[mode].push(performance.now()-start);
  }
  await pg.exec('ALTER TABLE campaign_participants ENABLE TRIGGER USER');
  const avg=a=>Math.round(a.slice(1).reduce((s,n)=>s+n,0)/(a.length-1)*100)/100;
  report.metrics.write500={baselineMs:avg(times.baseline),projectionMs:avg(times.projection),raw:times};return report.metrics.write500;
 });
 await check('PERF-read','performance','합성 500건 소유자 첫 50건 조회 30회',async()=>{
  const times=[];for(let i=0;i<31;i++){const start=performance.now();const p=await page();assert.equal(p.rows.length,50);times.push(performance.now()-start);}
  const sorted=times.slice(1).sort((a,b)=>a-b);report.metrics.read500={p50Ms:sorted[14],p95Ms:sorted[28],maxMs:sorted[29],n:30};return report.metrics.read500;
 });
 await pg.close();report.summary={total:report.cases.length,passed:report.cases.filter(c=>c.pass).length,failed:report.cases.filter(c=>!c.pass).length};
 console.log('AUDIT_JSON='+JSON.stringify(report));
 process.exitCode=report.summary.failed?1:0;
})().catch(async e=>{console.error(e);if(pg)await pg.close();process.exitCode=1;});
