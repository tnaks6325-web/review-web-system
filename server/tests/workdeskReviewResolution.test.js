'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { closeWithoutReview, recordResolution } = require('../src/services/workdeskReviewResolution.service');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('../frontend/workdesk.html');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function fn(name) {
  const match = html.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));
  assert(match, name); return match[0];
}
function menuContext({ field='col:리뷰제출', role='staff', count=1, archived=false, sheetless=true }={}) {
  const menu={innerHTML:'',classList:{add(){}},style:{}};
  const td={getAttribute:k=>k==='data-id'?'row-1':k==='data-field'?field:null,classList:{contains:()=>false}};
  const context={STATE:{role,canEdit:!archived&&role!=='advertiser',cur:{sheetless},wd:{roster:[{id:'row-1',name:'참여자',revision:'r1',filled:true}]}},
    $:()=>menu,_selectionGrid:()=>[Array(count).fill(td)],_canEditCells:()=>true,
    _workdeskStatusKindForField:f=>f==='col:리뷰제출'?'review':'',_isInternalRole:()=>['master','admin','staff'].includes(role),
    _isPurchaseDateHeader:()=>false,_msgCanSend:()=>false,esc:s=>s,_CELL_COLORS:[],_selRanges:()=>[1],
    _cellLockReason:()=>'',window:{innerWidth:900,innerHeight:900}};
  vm.createContext(context); vm.runInContext(fn('_openCellMenu'),context); context._openCellMenu(100,100,td);
  return menu.innerHTML;
}

(async()=>{
  await test('리뷰제출 한 칸에만 두 처리 메뉴 표시',()=>{
    const menu=menuContext();
    assert.match(menu,/미작성 종결/); assert.match(menu,/주문 취소/); assert.match(menu,/리뷰 대신 제출/);
    assert.doesNotMatch(menu,/행 삭제 · 구매기록 취소/);
    assert.doesNotMatch(menuContext({field:'col:비고'}),/_menuCloseReview/);
    assert.doesNotMatch(menuContext({count:2}),/_menuCloseReview/);
    for(const options of [{role:'advertiser'},{archived:true},{sheetless:false}]) {
      const disabled=menuContext(options);
      assert.match(disabled,/<button[^>]*disabled[^>]*onclick="_menuCloseReview\(\)"/);
      assert.match(disabled,/<button[^>]*disabled[^>]*onclick="_menuCancelReviewOrder\(\)"/);
    }
  });
  await test('확인 취소는 요청 없음, 승인 요청에는 선택한 행과 버전 포함',async()=>{
    let approve=false; const calls=[]; let reloads=0;
    const context={STATE:{canEdit:true,cur:{sheetId:'s',tabName:'t',sheetless:true},_gMenuRowId:'r',wd:{roster:[{id:'r',seq:2,name:'참여자',revision:'revision-1'}]}},
      _closeCellMenu(){},_isInternalRole:()=>true,confirm:()=>approve,alert(){},toast(){},
      api:async(url,args)=>{calls.push({url,body:JSON.parse(args.body)});return{ok:true};},reloadWorkdesk:async()=>reloads++};
    vm.createContext(context); vm.runInContext(fn('_menuCloseReview'),context);
    await context._menuCloseReview(); assert.equal(calls.length,0);
    approve=true; await context._menuCloseReview();
    assert.equal(calls[0].url,'/api/trackb/workdesk/review-close');
    assert.equal(calls[0].body.expectedRevision,'revision-1'); assert.equal(calls[0].body.confirm,true);
    assert.equal(calls[0].body.rowId,'r'); assert.equal(reloads,1); assert.equal(context.STATE._reviewCloseBusy,false);
  });
  await test('서버 확인·식별자 검사와 내부 권한 게이트',async()=>{
    await assert.rejects(closeWithoutReview({db:{connect(){throw Error('must not connect');}}}),{code:'confirmation_required'});
    assert.match(read('src/routes/trackB.routes.js'),/router.post\('\/workdesk\/review-close', authMiddleware, internalMiddleware/);
    assert.match(fn('_menuCancelReviewOrder'),/_menuDeleteRow\(\)/);
  });
  await test('원장 재생성에서 미작성 종결은 미제출, 톡방 확인은 완료 유지',()=>{
    const {parseTabRows}=require('../src/services/columnResolver');
    const keywords={NAME_KEYWORDS:['주문자'],SUBMIT_KEYWORDS:['리뷰제출'],DATA_TAB_KEYWORDS:['번호','주문자'],SUBMITTED_VALUES:['O']};
    const rows=parseTabRows([['번호','주문자','리뷰제출'],['1','종결자','미작성 종결'],['2','톡방제출자','톡방확인완료']], 's','t','g','c',keywords);
    assert.equal(rows[0].isSubmitted,false); assert.equal(rows[1].isSubmitted,true);
  });
  await test('종결 조회는 홈·리뷰내역·입금·알림에서 공용 뷰 사용',()=>{
    for(const p of ['src/services/search.service.js','src/routes/reviewer.routes.js','src/services/payment.service.js','src/routes/payment.routes.js','src/services/reviewReminder.service.js']) {
      assert.match(read(p),/FROM review_closed_targets/,p);
    }
    assert.match(read('src/services/trackB.service.js'),/recordResolution\(client, row, 'order_cancelled'/);
    assert.match(read('src/services/sheetlessStatus.service.js'),/review_cell_text\(row_json ->> \$4\) NOT IN \('미작성 종결','미제출','취소건'\)/);
  });

  // Optional embedded PostgreSQL run. Uses only an in-memory database, never a URL.
  if (process.env.PGLITE_MODULE) {
    const {PGlite}=require(process.env.PGLITE_MODULE);
    const pg=new PGlite();
    const query=async(sql,params)=>{const r=await pg.query(sql,params);return{...r,rowCount:r.affectedRows};};
    const client={query,release(){}}; const db={query,connect:async()=>client};
    const rowId='11111111-1111-4111-8111-111111111111', orderId='22222222-2222-4222-8222-222222222222';
    await pg.exec(`
      CREATE TABLE order_submissions(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE campaign_participants(id uuid PRIMARY KEY,sheet_id text,tab_name text,seq integer,active boolean DEFAULT true,deleted_at timestamptz,
        order_submission_id uuid,identity_key text,source text,first_seen_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        updated_by text,submit_col text DEFAULT '리뷰제출',is_submitted boolean DEFAULT false,is_paid boolean DEFAULT false,row_json jsonb);
      CREATE TABLE tab_configs(sheet_id text,tab_name text,is_closed boolean DEFAULT false,sheetless boolean DEFAULT true,archived_rounds text);
      CREATE TABLE index_master_archive(sheet_id text,tab_name text);
      CREATE TABLE review_index(id uuid DEFAULT gen_random_uuid(),sheet_id text,tab_name text,row_index integer,is_submitted boolean DEFAULT false,is_submitted2 text,row_json jsonb,built_at timestamptz);
      CREATE TABLE participant_edits(sheet_id text,tab_name text,anchor_type text,anchor_value text,field text,kind text,value_text text,value_bool boolean,reverted_at timestamptz,reverted_by text);
      CREATE TABLE payment_batch_items(sheet_id text,tab_name text,row_index integer,status text);
      CREATE TABLE review_submissions(sheet_id text,tab_name text,row_index integer,slot_key text,completed_at timestamptz);
      CREATE TABLE reviewer_participations(campaign_participant_id uuid,lifecycle_status text,review_obligation_status text);
      CREATE TABLE index_master(sheet_id text,tab_name text,submitted_count integer);
    `);
    await pg.exec(read('migrations/160_review_reminder_alimtalk.sql'));
    const migration=read('migrations/161_workdesk_review_resolutions.sql');
    await pg.exec(migration); await pg.exec(migration);
    async function seed({value='',source='manual',order=false,paid=false,batch=false,files=false,fulfilled=false}={}) {
      await pg.exec(`TRUNCATE review_reminder_deliveries,review_reminder_states,workdesk_review_resolutions,campaign_participants,
        order_submissions,tab_configs,index_master_archive,review_index,participant_edits,payment_batch_items,review_submissions,index_master,reviewer_participations CASCADE;
        INSERT INTO tab_configs(sheet_id,tab_name) VALUES('s','t'); INSERT INTO index_master VALUES('s','t',1);`);
      if(order) await query('INSERT INTO order_submissions(id) VALUES($1)',[orderId]);
      await query(`INSERT INTO campaign_participants(id,sheet_id,tab_name,seq,order_submission_id,identity_key,source,row_json,is_paid)
        VALUES($1,'s','t',2,$2,'stable-identity',$3,$4,$5)`,[rowId,order?orderId:null,source,JSON.stringify({'리뷰제출':value}),paid]);
      await query(`INSERT INTO review_index(sheet_id,tab_name,row_index,row_json) VALUES('s','t',2,$1)`,[JSON.stringify({'리뷰제출':value})]);
      if(batch) await pg.exec("INSERT INTO payment_batch_items VALUES('s','t',2,'pending')");
      if(files) await pg.exec("INSERT INTO review_submissions VALUES('s','t',2,'review',now())");
      if(fulfilled) await query("INSERT INTO reviewer_participations VALUES($1,'active','fulfilled')",[rowId]);
      return (await query('SELECT updated_at::text AS revision FROM campaign_participants')).rows[0].revision;
    }
    async function close(expectedRevision,extra={}) {
      return closeWithoutReview({db,sheetId:'s',tabName:'t',rowId,expectedRevision,confirm:true,by:'테스트 담당자',
        deriveAnchor:r=>({type:r.order_submission_id?'order':r.source==='manual'?'manual':'identity',value:r.order_submission_id|| (r.source==='manual'?r.id:r.identity_key)}),...extra});
    }
    try {
      await test('SQL: 확인한 빈값·false·미제출만 종결, 기록과 제출 플래그 분리',async()=>{
        for(const value of ['',false,'false','미제출']) {
          const revision=await seed({value}); const out=await close(revision); assert.equal(out.ok,true);
          const row=(await query('SELECT * FROM campaign_participants')).rows[0];
          assert.equal(row.row_json['리뷰제출'],'미작성 종결'); assert.equal(row.is_submitted,false);
          assert.equal((await query('SELECT is_submitted FROM review_index')).rows[0].is_submitted,false);
          const audit=(await query('SELECT * FROM workdesk_review_resolutions')).rows[0];
          assert.equal(audit.resolution,'closed_no_review'); assert.equal(audit.resolved_by,'테스트 담당자'); assert.equal(audit.history.length,1);
          assert.equal((await query('SELECT * FROM review_closed_targets')).rows.length,1);
          assert.equal((await query('SELECT submitted_count FROM index_master')).rows[0].submitted_count,0);
        }
      });
      await test('SQL: 완료·카카오톡·임의 문자열·입금·이체대기·완료 첨부는 변경 없이 거부',async()=>{
        for(const [options,code] of [
          [{value:'9/17 12:00'},'review_record_exists'],[{value:'톡방확인완료'},'review_record_exists'],[{value:'임의문자'},'review_record_exists'],
          [{paid:true},'already_paid'],[{batch:true},'payment_in_progress'],[{files:true},'review_record_exists'],[{fulfilled:true},'review_record_exists']]) {
          const revision=await seed(options); await assert.rejects(close(revision),{code});
          assert.equal((await query('SELECT * FROM workdesk_review_resolutions')).rows.length,0);
          assert.notEqual((await query('SELECT row_json FROM campaign_participants')).rows[0].row_json['리뷰제출'],'미작성 종결');
        }
      });
      await test('SQL: 오래된 선택·취소 주문·권한 범위 밖 행·닫힌 작업 거부',async()=>{
        let revision=await seed(); await assert.rejects(close('old-revision'),{code:'row_changed'});
        await assert.rejects(close(revision,{tabName:'other'}),{code:'row_not_found'});
        await pg.exec('UPDATE tab_configs SET is_closed=true'); await assert.rejects(close(revision),{code:'archived'});
        revision=await seed({order:true}); await pg.exec('UPDATE order_submissions SET deleted_at=now()');
        await assert.rejects(close(revision),{code:'order_cancelled'});
      });
      await test('SQL: 오래된 오버레이 제거, 재요청은 감사 기록 중복 없음',async()=>{
        let revision=await seed({value:'미제출'});
        await query(`INSERT INTO participant_edits(sheet_id,tab_name,anchor_type,anchor_value,field,kind,value_text) VALUES('s','t','manual',$1,'col:리뷰제출','text','false')`,[rowId]);
        await close(revision);
        assert.ok((await query('SELECT reverted_at FROM participant_edits')).rows[0].reverted_at);
        revision=(await query('SELECT updated_at::text AS revision FROM campaign_participants')).rows[0].revision;
        assert.equal((await close(revision)).alreadyClosed,true);
        assert.equal((await query('SELECT history FROM workdesk_review_resolutions')).rows[0].history.length,1);
      });
      await test('SQL: 다른 주문으로 재배정되면 종결 상태를 물려받지 않음',async()=>{
        const revision=await seed({order:true}); await close(revision);
        await query('UPDATE campaign_participants SET order_submission_id=$1',['33333333-3333-4333-8333-333333333333']);
        assert.equal((await query('SELECT * FROM review_closed_targets')).rows.length,0);
      });
      await test('SQL: 중복 주문 연결·시트 작업·보관 작업은 종결 거부',async()=>{
        let revision=await seed({order:true});
        await query(`INSERT INTO campaign_participants(id,sheet_id,tab_name,seq,order_submission_id,source)
          VALUES('33333333-3333-4333-8333-333333333333','s','t',3,$1,'import')`,[orderId]);
        await assert.rejects(close(revision),{code:'ambiguous_participant'});
        revision=await seed(); await pg.exec('UPDATE tab_configs SET sheetless=false');
        await assert.rejects(close(revision),{code:'not_sheetless'});
        revision=await seed(); await pg.exec("INSERT INTO index_master_archive VALUES('s','t')");
        await assert.rejects(close(revision),{code:'archived'});
      });
      await test('SQL: 저장 도중 오류가 나면 상태·셀·감사 기록을 모두 롤백',async()=>{
        const revision=await seed();
        const failing={query:async(sql,params)=>{
          if (/UPDATE review_index SET/.test(sql)) throw Error('injected failure');
          return query(sql,params);
        },release(){}};
        await assert.rejects(close(revision,{db:{connect:async()=>failing}}),/injected failure/);
        assert.equal((await query('SELECT * FROM workdesk_review_resolutions')).rows.length,0);
        assert.equal((await query('SELECT row_json FROM campaign_participants')).rows[0].row_json['리뷰제출'],'');
      });
      await test('SQL: 주문 취소 기록은 참여행 삭제 후에도 보존, 롤백도 함께 적용',async()=>{
        await seed({order:true}); let row=(await query('SELECT * FROM campaign_participants')).rows[0];
        await query('BEGIN'); await recordResolution(client,row,'order_cancelled','담당자','workdesk_participant_removed');
        await query('DELETE FROM campaign_participants WHERE id=$1',[rowId]); await query('ROLLBACK');
        assert.equal((await query('SELECT * FROM campaign_participants')).rows.length,1);
        assert.equal((await query('SELECT * FROM workdesk_review_resolutions')).rows.length,0);
        await query('BEGIN'); await recordResolution(client,row,'order_cancelled','담당자','workdesk_participant_removed');
        await query('DELETE FROM campaign_participants WHERE id=$1',[rowId]); await query('COMMIT');
        assert.equal((await query('SELECT resolution FROM workdesk_review_resolutions')).rows[0].resolution,'order_cancelled');
        assert.equal((await query('SELECT * FROM review_closed_targets')).rows.length,0);
      });
    } finally { await pg.close(); }
  } else console.log('SKIP embedded PostgreSQL (set PGLITE_MODULE to an installed @electric-sql/pglite path)');
  console.log(`${passed} workdesk review resolution tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
