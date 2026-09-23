'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createCoordinator}=require('../../frontend/js/reviewer-history-loader');
const history=require('../src/services/reviewerHistory.service');
const migration=require('../src/services/reviewerHistoryMigration.service');
const read=p=>fs.readFileSync(path.resolve(__dirname,'..',p),'utf8');
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
(async()=>{
 await test('중복 요청은 한 번만 실행',async()=>{
   const q=createCoordinator(),d=deferred();let n=0;const fetcher=()=>{n++;return d.promise;};
   const a=q.load('A',fetcher),b=q.load('A',fetcher);assert.equal(a,b);d.resolve(1);assert.equal((await a).value,1);assert.equal(n,1);
 });
 await test('계정 전환 응답 폐기, 제출 중 조회는 완료 후 한 번 재조회',async()=>{
   const q=createCoordinator(),d=deferred();const a=q.load('A',()=>d.promise);
   assert.equal((await q.load('B',async()=>2)).value,2);d.resolve(1);assert.equal((await a).stale,true);
   const first=deferred();let n=0;const fetcher=()=>++n===1?first.promise:Promise.resolve('fresh');
   const one=q.load('B',fetcher);q.load('B',fetcher,{force:true});q.load('B',fetcher,{force:true});first.resolve('old');
   assert.equal((await one).value,'fresh');assert.equal(n,2);
 });
 await test('커서는 소유자·명의 범위에 귀속, 과거 누락과 재개가 있으면 전환 거부',()=>{
   assert.throws(()=>history.decodeCursor(Buffer.from(JSON.stringify({owner:other,scope:'self',status:'all',id:owner,at:new Date().toISOString()})).toString('base64url'),owner,'self','all'));
   const a={sheetId:'s',tabName:'t',rowIndex:2,isSubmitted:true};
   assert.equal(migration.compare([a],[]).eligible,false);
   assert.equal(migration.compare([a],[{...a,isSubmitted:false}]).eligible,false);
   assert.equal(migration.compare([a],[a]).eligible,true);
   assert.equal(migration.compare([a],[a,a]).eligible,false);
 });
 await test('A에서 B로 전환 후 A로 복귀해도 최초 A 응답은 폐기',async()=>{
   const q=createCoordinator(),old=deferred(),fresh=deferred();let oldCalls=0;
   const a=q.load('A',()=>{oldCalls++;return old.promise;});
   await q.load('B',async()=>2);const next=q.load('A',()=>fresh.promise);
   old.resolve('old');assert.equal((await a).stale,true);assert.equal(oldCalls,1);
   fresh.resolve('fresh');assert.equal((await next).value,'fresh');
   const d=deferred(),before=q.load('A',()=>d.promise);q.reset();await q.load('A',async()=>3);
   d.resolve('late');assert.equal((await before).stale,true);
 });
 await test('클라이언트의 오류는 0건으로 덮어쓰지 않음',()=>{
   const source=read('../frontend/index.html');
   assert.doesNotMatch(source,/if \(!silent\) \{ _reviewListData = \{ pending: \[\], done: \[\] \}; _reviewListError/);
   assert.match(source,/이전 내역을 표시합니다/);assert.match(source,/loadMoreReviewHistory/);
 });
 await test('인증 없는 호출 거부, 요청값 대신 로그인 소유자로 조회',async()=>{
   const middleware=require('../src/services/reviewerSession.service').reviewerSessionMiddleware;
   let status=0;middleware({headers:{}},{status(n){status=n;return this;},json(){}},()=>assert.fail('무인증 통과'));
   assert.equal(status,401);
   const source=read('src/routes/reviewer.routes.js'),start=source.indexOf("router.get('/participations'");
   const snippet=source.slice(start,source.indexOf('\n});',start)+4);
   let chain,options,reply;const headers={};
   require('node:vm').runInNewContext(snippet,{
     router:{get(_path,...handlers){chain=handlers;}},reviewerSessionMiddleware:middleware,
     require(name){if(name.endsWith('reviewerHistory.service'))return{availability:async()=>true};
       if(name.endsWith('search.service'))return{searchByName:async(_q,_p,opts)=>{options=opts;return{mode:'owner_id',results:[]};}};
       throw new Error(name);}
   });
   assert.equal(chain[0],middleware);
   await chain[1]({reviewer:{ownerReviewerId:owner,loginPhone8:'12345678',loginKind:'self'},query:{ownerReviewerId:other}},
     {set(k,v){headers[k]=v;},json(v){reply=v;}},e=>{throw e;});
   assert.equal(options.ownerReviewerId,owner);assert.equal(reply.mode,'owner_id');assert.equal(headers['Cache-Control'],'no-store');
 });
 if(process.env.PGLITE_MODULE){
   const {PGlite}=require(process.env.PGLITE_MODULE),pg=new PGlite();
   const query=async(sql,params)=>{const r=await pg.query(sql,params);return{...r,rowCount:r.affectedRows};};
   const db={query,connect:async()=>({query,release(){}})};
   await pg.exec(`CREATE TABLE reviewers(id uuid PRIMARY KEY);
     CREATE TABLE order_submissions(id uuid PRIMARY KEY,owner_reviewer_id uuid,participant_identity_id uuid,participant_identity_key_hash text,
       campaign_application_id text,deleted_at timestamptz,mirror_status text,submitted_at timestamptz DEFAULT now(),sheet_id text,tab_name text,sheet_written_at timestamptz);
     CREATE TABLE campaign_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id text,tab_name text,tab_gid text,seq int,
       owner_reviewer_id uuid,participant_identity_id uuid,order_submission_id uuid,identity_key text,source text DEFAULT 'manual',
       first_seen_at timestamptz DEFAULT now(),active boolean DEFAULT true,deleted_at timestamptz,held_at timestamptz,
       updated_at timestamptz DEFAULT now(),updated_by text,submit_col text DEFAULT '리뷰제출',submit_col2 text,is_submitted boolean DEFAULT false,is_paid boolean DEFAULT false,
       reviewer_name text,recipient_name text,phone8 text,product_name text,round text,row_json jsonb DEFAULT '{}');
     CREATE TABLE review_index(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,tab_gid text,row_index int,reviewer_name text,recipient_name text,phone8 text,product_name text,round text,
       is_submitted boolean,is_submitted2 text,submit_col text,row_json jsonb,built_at timestamptz);
     CREATE TABLE review_index_archive(sheet_id text,tab_name text,row_index int);
     CREATE TABLE tab_configs(sheet_id text,tab_name text,is_closed boolean DEFAULT false,sheetless boolean DEFAULT true,archived_rounds text);
     CREATE TABLE index_master_archive(sheet_id text,tab_name text);
     CREATE TABLE trackb_tab_finished(sheet_id text,tab_name text,deleted_at timestamptz);
     CREATE TABLE campaign_applications(id text,owner_reviewer_id uuid);
     CREATE TABLE participation_links(sheet_id text,tab_name text,row_index int,owner_reviewer_id uuid);
     CREATE TABLE participant_edits(sheet_id text,tab_name text,anchor_type text,anchor_value text,field text,kind text,value_text text,value_bool boolean,reverted_at timestamptz);
     INSERT INTO reviewers VALUES('${owner}'),('${other}');INSERT INTO tab_configs(sheet_id,tab_name) VALUES('s','t');`);
   await pg.exec(read('migrations/160_review_reminder_alimtalk.sql'));
   await pg.exec(read('migrations/161_workdesk_review_resolutions.sql'));
   await pg.exec(read('migrations/162_reviewer_participations.sql'));
   await pg.exec(read('migrations/162_reviewer_participations.sql'));
   const insert=async(value='',who=owner)=> (await query(`INSERT INTO campaign_participants(sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,identity_key,row_json)
     VALUES('s','t',(SELECT COALESCE(max(seq),1)+1 FROM campaign_participants),'테스트','12345678',$1,gen_random_uuid()::text,$2) RETURNING id`,[who,JSON.stringify({'리뷰제출':value})])).rows[0].id;
   try{
    await test('SQL: 쓰기와 참여 상태를 같은 트랜잭션에 저장하며 지급 플래그 유지',async()=>{
      const id=await insert('톡방확인완료');
      const row=(await query('SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1',[id])).rows[0];
      assert.equal(row.review_obligation_status,'fulfilled');assert.equal(row.owner_reviewer_id,owner);
      assert.equal((await query('SELECT is_submitted FROM campaign_participants WHERE id=$1',[id])).rows[0].is_submitted,false);
      await query('BEGIN');await query(`UPDATE campaign_participants SET row_json='{}' WHERE id=$1`,[id]);await query('ROLLBACK');
      assert.equal((await query('SELECT review_obligation_status FROM reviewer_participations WHERE id=$1',[row.id])).rows[0].review_obligation_status,'fulfilled');
      await query(`UPDATE campaign_participants SET row_json='{}' WHERE id=$1`,[id]);
      assert.equal((await query('SELECT review_obligation_status FROM reviewer_participations WHERE id=$1',[row.id])).rows[0].review_obligation_status,'fulfilled');
    });
    await test('SQL: false는 미제출, 취소건 문자열은 검토대상, 오버레이와 종결 동기화',async()=>{
      const id=await insert('false');let row=(await query('SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1',[id])).rows[0];
      assert.equal(row.review_obligation_status,'pending');
      await query(`INSERT INTO participant_edits VALUES('s','t','manual',$1,'col:리뷰제출','text','톡방확인완료',NULL,NULL)`,[id]);
      assert.equal((await query('SELECT review_obligation_status FROM reviewer_participations WHERE id=$1',[row.id])).rows[0].review_obligation_status,'fulfilled');
      const cancelled=await insert('취소건');assert.equal((await query('SELECT review_obligation_status FROM reviewer_participations WHERE campaign_participant_id=$1',[cancelled])).rows[0].review_obligation_status,'unknown');
    });
    await test('SQL: 다른 소유자 노출 없이 450건을 50건씩 조회',async()=>{
      await pg.exec('TRUNCATE campaign_participants,reviewer_participations');
      await query(`INSERT INTO campaign_participants(sheet_id,tab_name,seq,reviewer_name,phone8,owner_reviewer_id,identity_key,row_json)
        SELECT 's','t',i,'명'||i,'12345678',$1,'key-'||i,'{"리뷰제출":""}'::jsonb FROM generate_series(1,450) i`,[owner]);
      await insert('',other);
      let cursor=null;const ids=[];
      do{const page=await history.loadPage(`ri.reviewer_name AS "idxName",p.review_obligation_status='fulfilled' AS "isSubmitted"`,
        {ownerReviewerId:owner,ownerPhone8s:['12345678'],historyCursor:cursor},db);
        assert.equal(page.counts.pending,450);ids.push(...page.rows.map(r=>r.participationId));cursor=page.nextCursor;
      }while(cursor);
      assert.equal(ids.length,450);assert.equal(new Set(ids).size,450);
    });
    await test('SQL: 참여행 재배정·삭제는 이력을 보존하고 기존 귀속을 종료',async()=>{
      const id=await insert('톡방확인완료');const prior=(await query('SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1',[id])).rows[0];
      await query(`UPDATE campaign_participants SET order_submission_id=$2,row_json='{"리뷰제출":""}' WHERE id=$1`,[id,other]);
      const rows=(await query('SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1 ORDER BY created_at',[id])).rows;
      assert.equal(rows.length,2);assert.equal(rows.find(r=>r.id===prior.id).lifecycle_status,'cancelled');
      assert.equal(rows.find(r=>r.id!==prior.id).review_obligation_status,'pending');
      await query('DELETE FROM campaign_participants WHERE id=$1',[id]);
      assert.equal((await query("SELECT 1 FROM reviewer_participations WHERE campaign_participant_id=$1 AND lifecycle_status='active'",[id])).rows.length,0);
    });
    await test('SQL: 검증 주문으로만 owner 보정, 자동 덮어쓰기·버전 충돌 거부',async()=>{
      const id=await insert('',null);
      await query('UPDATE campaign_participants SET order_submission_id=$2 WHERE id=$1',[id,other]);
      await query(`INSERT INTO order_submissions(id,owner_reviewer_id,participant_identity_key_hash) VALUES($1,$2,'verified-hash')`,[other,owner]);
      const revision=(await query('SELECT updated_at::text AS revision FROM campaign_participants WHERE id=$1',[id])).rows[0].revision;
      await assert.rejects(migration.applyVerified({rowId:id,expectedRevision:'old',confirm:true,by:'test'},db));
      assert.equal((await migration.applyVerified({rowId:id,expectedRevision:revision,confirm:true,by:'test'},db)).ok,true);
      assert.equal((await query('SELECT owner_reviewer_id FROM campaign_participants WHERE id=$1',[id])).rows[0].owner_reviewer_id,owner);
    });
    await test('SQL: 명의별 범위·커서 갱신·권한 검사',async()=>{
      const identity='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const id=await insert('');await query('UPDATE campaign_participants SET participant_identity_id=$2,phone8=$3 WHERE id=$1',[id,identity,'87654321']);
      const page=await history.loadPage('p.id',{ownerReviewerId:owner,restrictParticipant:true,participantIdentityId:identity,ownerPhone8s:['87654321']},db);
      assert.equal(page.rows.length,1);
      const first=await history.loadPage('p.id',{ownerReviewerId:owner,historyLimit:1},db);assert.ok(first.nextCursor);
      await query("UPDATE campaign_participants SET row_json='{\"리뷰제출\":\"톡방확인완료\"}' WHERE id=$1",[id]);
      await assert.rejects(history.loadPage('p.id',{ownerReviewerId:owner,historyCursor:first.nextCursor},db),e=>e.code==='HISTORY_CURSOR_INVALID');
      const seq=(await query('SELECT seq FROM campaign_participants WHERE id=$1',[id])).rows[0].seq;
      assert.equal(await history.ownsProjectedTarget({session:{ownerReviewerId:other},sheetId:'s',tabName:'t',rowIndex:seq,client:db}),false);
      assert.equal(await history.ownsProjectedTarget({session:{ownerReviewerId:owner},sheetId:'s',tabName:'t',rowIndex:seq,client:db}),true);
    });
    await test('SQL: 종결·마감·인덱스 재생성에서도 상태와 참여 ID 보존',async()=>{
      const id=await insert('미제출'),cp=(await query('SELECT * FROM campaign_participants WHERE id=$1',[id])).rows[0];
      const before=(await query('SELECT * FROM reviewer_participations WHERE campaign_participant_id=$1',[id])).rows[0];
      await query(`INSERT INTO workdesk_review_resolutions(participant_id,sheet_id,tab_name,row_index,identity_key,participant_source,first_seen_at,resolution,reason,resolved_by,review_participation_id)
        SELECT id,sheet_id,tab_name,seq,identity_key,source,first_seen_at,'closed_no_review','operator_confirmed','test',review_participation_id FROM campaign_participants WHERE id=$1`,[id]);
      assert.equal((await query('SELECT review_obligation_status FROM reviewer_participations WHERE id=$1',[before.id])).rows[0].review_obligation_status,'closed_no_review');
      await query(`INSERT INTO review_index(sheet_id,tab_name,row_index,reviewer_name,phone8,row_json,submit_col) VALUES('s','t',$1,'잘못된 이전 명의','99999999','{}','리뷰제출')`,[cp.seq]);
      let row=(await query('SELECT * FROM reviewer_participations WHERE id=$1',[before.id])).rows[0];
      assert.equal(row.index_snapshot.reviewer_name,cp.reviewer_name);assert.equal(row.review_obligation_status,'closed_no_review');
      await query("UPDATE tab_configs SET is_closed=TRUE WHERE sheet_id='s' AND tab_name='t'");
      assert.equal((await history.loadPage('p.id',{ownerReviewerId:owner},db)).rows.length,0);
      await query("UPDATE tab_configs SET is_closed=FALSE WHERE sheet_id='s' AND tab_name='t'");
      row=(await query('SELECT * FROM reviewer_participations WHERE id=$1',[before.id])).rows[0];
      assert.equal(row.lifecycle_status,'active');assert.equal(row.review_obligation_status,'closed_no_review');
      await query("UPDATE campaign_participants SET round='R2' WHERE id=$1",[id]);
      await query("UPDATE tab_configs SET archived_rounds=' R1, R2 ' WHERE sheet_id='s' AND tab_name='t'");
      assert.equal((await query('SELECT lifecycle_status FROM reviewer_participations WHERE id=$1',[before.id])).rows[0].lifecycle_status,'archived');
      await query("UPDATE tab_configs SET archived_rounds='' WHERE sheet_id='s' AND tab_name='t'");
    });
    await test('SQL: 새 소유자 미확정 행은 전환 인증을 만료시킴',async()=>{
      const epoch=(await query('SELECT coverage_epoch FROM reviewer_history_control')).rows[0].coverage_epoch;
      assert.equal((await migration.certify({ownerReviewerId:owner,legacy:[],projected:[],confirm:true,by:'test',coverageEpoch:epoch},db)).ok,true);
      assert.equal(await history.availability(owner,db),true);
      await insert('',null);assert.equal(await history.availability(owner,db),false);
    });
    await test('SQL: 실제 검색 응답 필드와 새 조회 쿼리 호환',async()=>{
      await pg.exec(`ALTER TABLE review_index ADD campaign_name text,ADD product_url text,ADD start_date text,ADD end_date text,ADD review_file_at timestamptz,ADD review_file_id text;
        ALTER TABLE tab_configs ADD manager text,ADD time_range text,ADD review_type text,ADD taekhap boolean,ADD delivery_type text,ADD is_bulk boolean,ADD income_type text,
        ADD campaign_name text,ADD display_name text,ADD nc_mode boolean,ADD folder_url text,ADD capture_folder_url text,ADD capture_slots jsonb;`);
      const fields=read('src/services/search.service.js').match(/const SELECT_FIELDS = (`[\s\S]*?`);/)[1];
      const selectFields=Function('submittedState','return '+fields)("p.review_obligation_status='fulfilled'");
      const page=await history.loadPage(selectFields,{ownerReviewerId:owner},db);
      assert.ok(page.rows.length>0);assert.equal(page.rows[0].sheetId,'s');assert.ok(page.rows[0].idxName);
    });
    await test('SQL: 담당자 확인 귀속은 사전검토·근거기록·버전검사 후 반영',async()=>{
      const id=await insert('',null),row=(await query('SELECT updated_at::text AS revision FROM campaign_participants WHERE id=$1',[id])).rows[0];
      const args={rowId:id,ownerReviewerId:owner,expectedRevision:row.revision,evidence:'고객 확인 문서 테스트',by:'tester'};
      assert.equal((await migration.assignReviewedOwner(args,db)).dryRun,true);
      assert.equal((await query('SELECT owner_reviewer_id FROM campaign_participants WHERE id=$1',[id])).rows[0].owner_reviewer_id,null);
      await assert.rejects(migration.assignReviewedOwner({...args,expectedRevision:'old',confirm:true},db));
      await migration.assignReviewedOwner({...args,confirm:true},db);
      assert.equal((await query('SELECT owner_reviewer_id FROM campaign_participants WHERE id=$1',[id])).rows[0].owner_reviewer_id,owner);
      assert.equal((await query('SELECT evidence FROM reviewer_owner_mapping_reviews WHERE participant_id=$1',[id])).rows[0].evidence,args.evidence);
      await assert.rejects(migration.assignReviewedOwner({...args,confirm:true,ownerReviewerId:other},db));
      assert.equal((await migration.disableOwner({ownerReviewerId:owner,confirm:true,by:'tester'},db)).ok,true);
      assert.equal(await history.availability(owner,db),false);
    });
    await test('SQL: 업체 작업 목록의 제출 집계도 같은 상태를 사용',async()=>{
      const src=read('src/services/trackB.service.js');
      const start=src.indexOf('SELECT MIN(cp.first_seen_at) AS first_seen,');
      let fragment=src.slice(start,src.indexOf(') cnt ON TRUE',start));
      fragment=Function('_filledSql','return `'+fragment+'`')(()=> 'TRUE');
      fragment=fragment.replace('FROM anchored_rows cp',`FROM (SELECT p.*,'manual'::text AS anchor_type,p.id::text AS anchor_value,1 AS anchor_count FROM campaign_participants p) cp`);
      const result=await query(`SELECT cnt.* FROM (VALUES('s','t')) t(sheet_id,tab_name)
        CROSS JOIN (SELECT '리뷰제출'::text submit_header) submit_header
        CROSS JOIN (SELECT '입금'::text paid_header) paid_header CROSS JOIN LATERAL (${fragment}) cnt`);
      const expected=await query("SELECT count(*)::int AS n FROM reviewer_participations WHERE lifecycle_status='active' AND review_obligation_status='fulfilled'");
      assert.equal(result.rows[0].submitted,expected.rows[0].n);
    });
   }finally{await pg.close();}
 }else console.log('SKIP embedded PostgreSQL (PGLITE_MODULE not set)');
 console.log(`${passed} reviewer history tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
