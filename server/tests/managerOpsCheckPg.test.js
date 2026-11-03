'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const {PGlite}=require('@electric-sql/pglite');
const ops=require('../src/services/opsCheck.service');
const manager=require('../src/services/managerOpsCheck.service');
async function main(){const db=new PGlite();
  await db.exec(`
    CREATE TABLE work_orders (
      id TEXT PRIMARY KEY, source_review_order_id TEXT NOT NULL DEFAULT '', work_manager TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'reviewing', deleted_at TIMESTAMPTZ, linked_campaign_id TEXT NOT NULL DEFAULT '',
      sync_version BIGINT NOT NULL DEFAULT 0, intranet_acked_version BIGINT NOT NULL DEFAULT 0,
      source_revision INTEGER NOT NULL DEFAULT 0, intake_idempotency_key TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), workboard_schema_version SMALLINT NOT NULL DEFAULT 1,
      work_series_id TEXT NOT NULL DEFAULT '', work_round INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '', start_date DATE, product_option TEXT NOT NULL DEFAULT '', product_options_json TEXT NOT NULL DEFAULT '[]',
      pay_amount INTEGER NOT NULL DEFAULT 0, review_fee INTEGER NOT NULL DEFAULT 0, daily_count INTEGER NOT NULL DEFAULT 0,
      daily_count_text TEXT NOT NULL DEFAULT '', product_distribution_mode TEXT NOT NULL DEFAULT 'balanced', purchase_channel TEXT NOT NULL DEFAULT '',
      purchase_time TEXT NOT NULL DEFAULT '', inflow_keyword TEXT NOT NULL DEFAULT '', inflow_type TEXT NOT NULL DEFAULT '', inflow_guide TEXT NOT NULL DEFAULT '',
      guide_images TEXT NOT NULL DEFAULT '', thumbnail_url TEXT NOT NULL DEFAULT '', required_delivery_memo TEXT NOT NULL DEFAULT '',
      delivery_type TEXT NOT NULL DEFAULT '', courier_proxy BOOLEAN NOT NULL DEFAULT FALSE, review_type TEXT NOT NULL DEFAULT '',
      delivery_type_mix TEXT NOT NULL DEFAULT '', recall_courier TEXT NOT NULL DEFAULT '', recall_product TEXT NOT NULL DEFAULT '',
      review_type_mix JSONB NOT NULL DEFAULT '[]', recruit_count INTEGER NOT NULL DEFAULT 0, review_guide TEXT NOT NULL DEFAULT '',
      special_notes TEXT NOT NULL DEFAULT '', product_url TEXT NOT NULL DEFAULT '', work_sheet_url TEXT NOT NULL DEFAULT '', goods_cost_type TEXT NOT NULL DEFAULT '',
      manager_name TEXT NOT NULL DEFAULT '', skip_weekends BOOLEAN, holidays TEXT, work_kind TEXT NOT NULL DEFAULT 'review', memo_log JSONB NOT NULL DEFAULT '[]',
      intranet_advertiser_name TEXT NOT NULL DEFAULT '', intranet_advertiser_contact TEXT NOT NULL DEFAULT '',
      intranet_advertiser_business_number TEXT NOT NULL DEFAULT '', sales_id TEXT NOT NULL DEFAULT '', quote_id TEXT NOT NULL DEFAULT '',
      contract_number TEXT NOT NULL DEFAULT '', intranet_advertiser_id TEXT NOT NULL DEFAULT '', purchase_channel_custom BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE recruit_campaigns (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', source_work_order_id TEXT NOT NULL DEFAULT '', linked_sheet_id TEXT NOT NULL DEFAULT '', linked_tab_name TEXT NOT NULL DEFAULT '', archived_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE work_order_shared_snapshots (
      work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL, origin TEXT NOT NULL, op_id TEXT NOT NULL DEFAULT '',
      state JSONB NOT NULL, actor TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (work_order_id, sync_version)
    );
    CREATE UNIQUE INDEX uq_wo_shared_snap_op ON work_order_shared_snapshots (op_id) WHERE op_id <> '';
    CREATE TABLE shared_sync_outbox (
      id BIGSERIAL PRIMARY KEY, work_order_id TEXT NOT NULL, sync_version BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (work_order_id, sync_version)
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  `);

 await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/205_ops_checks.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/206_shared_sync_outbox_scope.sql'),'utf8'));
 await db.exec(`ALTER TABLE work_orders ADD COLUMN linked_tab_sheet_id TEXT NOT NULL DEFAULT '', ADD COLUMN linked_tab_name TEXT NOT NULL DEFAULT '', ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
 CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,tab_gid TEXT,manager TEXT DEFAULT '',display_name TEXT DEFAULT '');
 CREATE TABLE trackb_tab_finished(sheet_id TEXT,tab_name TEXT,tab_gid TEXT,finished_at TIMESTAMPTZ DEFAULT NOW(),finished_by TEXT DEFAULT '',deleted_at TIMESTAMPTZ);
 INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,manager,display_name) VALUES('fake','가짜 작업','fake-gid','','가짜 상품');
 INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name) VALUES('fake-order','fake-source','랜덤','fake','가짜 작업');`);
 // Decision 323 fixtures: the real home active-list source (participants.listActiveTabs via scopedActiveTabs) + ownership.
 await db.exec(`ALTER TABLE tab_configs ADD COLUMN sheetless BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN is_closed BOOLEAN DEFAULT FALSE,
   ADD COLUMN campaign_name TEXT, ADD COLUMN work_kind TEXT DEFAULT '', ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN sheetless_at TIMESTAMPTZ;
 CREATE UNIQUE INDEX tab_configs_sheet_id_tab_name_key ON tab_configs(sheet_id,tab_name);
 UPDATE tab_configs SET sheetless=TRUE;
 CREATE TABLE raw_sheet_tabs(sheet_id TEXT,spreadsheet_title TEXT,tab_gid TEXT,tab_name TEXT,row_count INT DEFAULT 0,is_system_tab BOOLEAN DEFAULT FALSE,mirrored_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE index_master(sheet_id TEXT,tab_gid TEXT,tab_name TEXT,status TEXT,row_count INT DEFAULT 0);
 CREATE TABLE campaign_participants(sheet_id TEXT,tab_name TEXT,first_seen_at TIMESTAMPTZ DEFAULT NOW(),deleted_at TIMESTAMPTZ,active BOOLEAN DEFAULT TRUE,held_at TIMESTAMPTZ);
 CREATE TABLE advertisers(id TEXT PRIMARY KEY,name TEXT);INSERT INTO advertisers VALUES('adv-fake','가짜 업체');
 CREATE TABLE advertiser_campaigns(id SERIAL PRIMARY KEY,advertiser_id TEXT,sheet_id TEXT,tab_gid TEXT,assigned_by TEXT DEFAULT '',created_at TIMESTAMPTZ DEFAULT NOW(),deleted_at TIMESTAMPTZ);
 CREATE TABLE trackb_work_order_links(sheet_id TEXT,tab_name TEXT,work_order_id TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),deleted_at TIMESTAMPTZ);`);
 const TABQ=manager.KIND+':tab:';
 const openRefs=async()=>(await db.query(`SELECT ref_key FROM ops_checks WHERE kind=$1 AND status='open' ORDER BY id`,[manager.KIND])).rows.map(r=>r.ref_key);
 const orderOpen=refs=>refs.filter(r=>!r.startsWith(TABQ)),tabOpen=refs=>refs.filter(r=>r.startsWith(TABQ));
 const own=(sheet,gid)=>db.query(`INSERT INTO advertiser_campaigns(advertiser_id,sheet_id,tab_gid) VALUES('adv-fake',$1,$2)`,[sheet,gid]);
 const disown=()=>db.query('DELETE FROM advertiser_campaigns');
 let tail=Promise.resolve(),failAnswer=false,failQueue=false;
 const pool={query:db.query.bind(db),connect:async()=>{let release;const next=new Promise(r=>release=r);const prev=tail;tail=next;await prev;return {query:async(sql,args)=>{if(failAnswer&&/UPDATE ops_checks SET answers/.test(sql))throw Error('injected answer failure');if(failQueue&&/INSERT INTO shared_sync_outbox/.test(sql))throw Error('injected queue failure');return db.query(sql,args);},release};}};
 require.cache[require.resolve('../src/db/pool')]={id:require.resolve('../src/db/pool'),filename:require.resolve('../src/db/pool'),loaded:true,exports:pool};
 ops.__setPoolForTest(pool);await manager.refresh(pool);
 let q=(await pool.query('SELECT * FROM ops_checks')).rows[0];assert.equal(q.status,'open');assert.equal(q.ref_key,'manager_assignment:fake-order');
 const args={db:pool,id:Number(q.id),baseVersion:0,choice:'mandu',admin:{role:'master',name:'가짜 관리자'},by:'가짜 관리자'};
 for(const fail of ['answer','queue']){failAnswer=fail==='answer';failQueue=fail==='queue';await assert.rejects(manager.answer(args),/injected/);failAnswer=failQueue=false;
 assert.equal((await pool.query('SELECT work_manager FROM work_orders')).rows[0].work_manager,'랜덤');assert.equal((await pool.query('SELECT status FROM ops_checks')).rows[0].status,'open');assert.equal((await pool.query('SELECT * FROM shared_sync_outbox')).rows.length,0);}
 const concurrent=await Promise.allSettled([manager.answer(args),manager.answer({...args,choice:'mango'})]);
 assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.equal(concurrent.filter(x=>x.status==='rejected').length,1);
 q=(await pool.query('SELECT * FROM ops_checks')).rows[0];assert.equal(q.status,'done');assert.equal(q.answers.manager.choice,'mandu');
 assert.equal((await pool.query('SELECT work_manager FROM work_orders')).rows[0].work_manager,'박세희');assert.equal((await pool.query('SELECT status FROM shared_sync_outbox')).rows[0].status,'pending');
 assert.equal((await manager.answer(args)).status,'done');assert.equal((await pool.query('SELECT * FROM shared_sync_outbox')).rows.length,1);
 await assert.rejects(manager.answer({...args,choice:'random'}),/만두 또는 망고/);await assert.rejects(manager.answer({...args,admin:{role:'staff'}}),/권한/);
 await pool.query(`UPDATE work_orders SET work_manager='랜덤',sync_version=sync_version+1`);await manager.refresh(pool);q=(await pool.query('SELECT * FROM ops_checks')).rows[0];assert.equal(q.status,'open');assert.deepEqual(q.answers,{});await assert.rejects(manager.answer(args),/바뀐/);
 await pool.query(`INSERT INTO recruit_campaigns(id,source_work_order_id,archived_at) VALUES('arch','fake-order',NOW())`);await assert.rejects(manager.answer({...args,baseVersion:q.facts.baseVersion}),/보관/);
 await manager.refresh(pool);assert.equal((await pool.query('SELECT status FROM ops_checks')).rows[0].status,'done');
 await pool.query('DELETE FROM recruit_campaigns');await manager.refresh(pool);q=(await pool.query('SELECT * FROM ops_checks')).rows[0];
 await pool.query(`INSERT INTO recruit_campaigns(id,archived_at) VALUES('direct-arch',NOW())`);await pool.query(`UPDATE work_orders SET linked_campaign_id='direct-arch'`);
 await assert.rejects(manager.answer({...args,baseVersion:q.facts.baseVersion}),/보관/);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items.length,0);
 await pool.query('DELETE FROM recruit_campaigns');await pool.query(`UPDATE work_orders SET linked_campaign_id=''`);await manager.refresh(pool);q=(await pool.query('SELECT * FROM ops_checks')).rows[0];
 await pool.query(`UPDATE work_orders SET work_manager='박은비',sync_version=sync_version+1`);await assert.rejects(manager.answer({...args,baseVersion:q.facts.baseVersion}),/바뀐/);await manager.refresh(pool);assert.equal((await pool.query('SELECT status FROM ops_checks')).rows[0].status,'done');
 // Same current-order + tab fallback semantics, and every ineligible branch is a real SQL refresh.
 const reset=async()=>{await pool.query(`UPDATE work_orders SET status='reviewing',deleted_at=NULL,source_review_order_id='fake-source',work_manager='랜덤',linked_tab_sheet_id='fake',linked_tab_name='가짜 작업'`);await pool.query(`UPDATE tab_configs SET manager=''`);};
 for(const sql of ["status='done'","deleted_at=NOW()","source_review_order_id=''","linked_tab_sheet_id=''","work_manager='외부담당'"]){await reset();await pool.query('UPDATE work_orders SET '+sql);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items.length,0,sql);
  // Decision 323 (user-approved meaning change): no source / no linked order never yields an ORDER question, but the same
  // work on an advertiser-owned active tab yields a TAB question. A source order (done or external manager) still yields none.
  await own('fake','fake-gid');await manager.refresh(pool);const refs=await openRefs();
  assert.equal(orderOpen(refs).length,0,'no order question: '+sql);
  assert.deepEqual(tabOpen(refs),["deleted_at=NOW()","source_review_order_id=''","linked_tab_sheet_id=''"].includes(sql)?[TABQ+'fake:fake-gid']:[],'tab question: '+sql);
  await disown();await manager.refresh(pool);assert.equal(tabOpen(await openRefs()).length,0,'unowned tab question closes: '+sql);}
 for(const tabManager of ['망고','외부담당']){await reset();await pool.query('UPDATE tab_configs SET manager=$1',[tabManager]);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items.length,0,'tab fallback '+tabManager);}
 for(const finishedName of ['가짜 작업','옛 이름']){
  await reset();await manager.refresh(pool);const fq=(await manager.list({db:pool,allowed:true})).items[0];
  await pool.query(`INSERT INTO trackb_tab_finished(sheet_id,tab_name,tab_gid) VALUES('fake',$1,'fake-gid')`,[finishedName]);
  await assert.rejects(manager.answer({...args,id:fq.id,baseVersion:fq.facts.baseVersion}),/바뀐/,'finished tab cannot be answered even before refresh');
  await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items.length,0,'finished name/gid excluded');
  await pool.query(`DELETE FROM trackb_tab_finished`);
 }
 await reset();await manager.refresh(pool);
 const stable=(await manager.list({db:pool,allowed:true})).items[0].id;
 const fallbackQ=(await manager.list({db:pool,allowed:true})).items[0];await pool.query(`UPDATE tab_configs SET manager='망고'`);
 await assert.rejects(manager.answer({...args,id:fallbackQ.id,baseVersion:fallbackQ.facts.baseVersion}),/바뀐/);await pool.query(`UPDATE tab_configs SET manager=''`);
 await pool.query(`UPDATE tab_configs SET display_name='이름 바뀐 가짜 상품'`);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items[0].id,stable,'rename keeps stable order key');
 await pool.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name,created_at) VALUES('newer-fake','fake-new-source','랜덤','fake','가짜 작업',NOW()+INTERVAL '1 second')`);
 await manager.refresh(pool);let latest=(await manager.list({db:pool,allowed:true})).items;assert.equal(latest.length,1);assert.equal(latest[0].facts.workOrderId,'newer-fake');await pool.query(`DELETE FROM work_orders WHERE id='newer-fake'`);await manager.refresh(pool);
 await pool.query(`UPDATE work_orders SET work_manager='박은비'`);await manager.refresh(pool);
 const brokenFinished={query:async(sql,args)=>{if(/FROM trackb_tab_finished/.test(sql))throw Error('injected finish lookup failure');return pool.query(sql,args);},connect:pool.connect};
 await assert.rejects(manager.refresh(brokenFinished),/마감 여부/,'unknown finished state is not an empty success');
 // Bank questions cannot be crowded out by manager questions, and manager pagination is independent.
 await pool.query(`INSERT INTO ops_checks(kind,ref_key,facts,facts_hash,lines) VALUES('bank_cluster','bank-fixture','{}','bank','[]')`);
 const bank=await ops.listChecks();assert.equal(bank.length,1);assert.equal(bank[0].kind,'bank_cluster');
 const page=await manager.list({db:pool,allowed:true});assert.equal(page.items.length,0);
 assert.equal(page.hasMore,false);
 for(let i=0;i<52;i++)await pool.query(`INSERT INTO ops_checks(kind,ref_key,facts,facts_hash,lines) VALUES($1,$2,'{}','fixture','[]')`,[manager.KIND,'pagination:'+i]);
 const first=await manager.list({db:pool,allowed:false});assert.equal(first.items.length,50);assert.equal(first.hasMore,true);assert.ok(first.items.every(x=>!x.canAnswer));
 const second=await manager.list({db:pool,allowed:false,after:first.nextAfter});assert.equal(second.items.length,2);assert.equal(second.hasMore,false);
 assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,52);
 await pool.query(`DELETE FROM ops_checks WHERE ref_key LIKE 'pagination:%'`);
 await db.exec(`CREATE TABLE workdesk_editors(name TEXT,active BOOLEAN);INSERT INTO workdesk_editors VALUES('가짜 편집관리자',TRUE)`);
 require.cache[require.resolve('../src/db/pool')]={id:require.resolve('../src/db/pool'),filename:require.resolve('../src/db/pool'),loaded:true,exports:pool};
 require('../src/utils/workdeskEditors').invalidate();
 process.env.JWT_SECRET='local-home-fixture-only';
 const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use(express.json());app.use('/api/trackb',require('../src/routes/trackB.routes'));
 app.use((e,req,res,next)=>res.status(500).json({ok:false,error:e.message}));
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 const url=`http://127.0.0.1:${server.address().port}/api/trackb/ops-checks`;
 const call=async(path,admin,body)=>{const headers={'Content-Type':'application/json'};if(admin)headers.Authorization='Bearer '+jwt.sign(admin,process.env.JWT_SECRET);const r=await fetch(url+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
  await pool.query(`UPDATE work_orders SET work_manager='랜덤',sync_version=sync_version+1`);
  for(const admin of [null,{role:'staff',name:'가짜 직원'},{role:'advertiser',name:'가짜 업체'}]) assert.equal((await call('/managers',admin)).status,admin?403:401);
  const denied={role:'admin',name:'가짜 열람관리자'},editor={role:'admin',name:'가짜 편집관리자'};
  let response=await call('/managers',denied);assert.equal(response.status,200);let item=response.body.items[0];assert.equal(item.canAnswer,false);
  const body={choice:'mango',baseVersion:item.facts.baseVersion};
  assert.equal((await call('/'+item.id+'/manager-answer',denied,body)).status,403);
  response=await call('/managers',editor);assert.equal(response.body.items[0].canAnswer,true);
  response=await call('/'+item.id+'/manager-answer',editor,body);assert.equal(response.status,200);assert.equal(response.body.item.localSaved,true);assert.equal(response.body.item.remoteSync,'pending');
  assert.equal((await call('/'+item.id+'/manager-answer',editor,body)).status,200,'lost response retry');
  assert.equal((await call('/'+item.id+'/manager-answer',editor,{...body,choice:'mandu'})).status,409);
  assert.equal((await call('/managers?after=bad',editor)).status,400);
  process.env.BIDIR_HARD_OFF='1';assert.equal((await call('/'+item.id+'/manager-answer',editor,body)).status,503);delete process.env.BIDIR_HARD_OFF;
  // ── Decision 323: tab branch (owned + active + unfinished + empty tab cell + no intranet-linked order) ──
  await pool.query(`UPDATE work_orders SET work_manager='박은비'`);await manager.refresh(pool);
  const tabRow=(sheet,tab,gid,extra='')=>pool.query(`INSERT INTO tab_configs(sheet_id,tab_name,tab_gid,manager,display_name,sheetless) VALUES($1,$2,$3,${extra||"''"},$4,TRUE)`,[sheet,tab,gid,tab+' 표시']);
  await tabRow('ts','오더 없는 작업','t1');await own('ts','t1');                       // ① no order
  await tabRow('ts','원본 없는 오더','t2');await own('ts','t2');                         // ② latest order has no source, 랜덤
  await pool.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name) VALUES('nosrc','','랜덤','ts','원본 없는 오더')`);
  await tabRow('ts','테스트 작업','t3');                                                  // unowned test tab
  await tabRow('ts','이미 망고','t4',"'망고'");await own('ts','t4');                      // cell already filled
  await tabRow('ts','마감 작업','t5');await own('ts','t5');await pool.query(`INSERT INTO trackb_tab_finished(sheet_id,tab_name,tab_gid) VALUES('ts','마감 작업','t5')`);
  await tabRow('ts2','gid 없는 작업',null);await own('ts2',null);                        // whole-sheet owner, name key
  await tabRow('ts','수동 연결 원본','t8');await own('ts','t8');                          // manual link to a source order
  await pool.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager) VALUES('manual-src','src-m','랜덤')`);
  await pool.query(`INSERT INTO trackb_work_order_links(sheet_id,tab_name,work_order_id) VALUES('ts','수동 연결 원본','manual-src')`);
  await pool.query(`INSERT INTO raw_sheet_tabs(sheet_id,spreadsheet_title,tab_gid,tab_name) VALUES('ts3','시트','t9','설정 없는 작업')`);await pool.query(`INSERT INTO index_master(sheet_id,tab_gid,tab_name,status) VALUES('ts3','t9','설정 없는 작업','active')`);await own('ts3','t9');   // active via sheet mirror, no tab_configs row
  await manager.refresh(pool);
  const tabKeys=[TABQ+'ts:t1',TABQ+'ts:t2',TABQ+'ts2:name:gid 없는 작업',TABQ+'ts3:t9'];
  assert.deepEqual(tabOpen(await openRefs()).sort(),[...tabKeys].sort(),'only owned/active/unfinished/empty/no-source tabs');
  assert.equal(orderOpen(await openRefs()).length,0,'no order questions for source-less work');
  const byRef=async ref=>{const qid=Number((await pool.query('SELECT id FROM ops_checks WHERE ref_key=$1',[ref])).rows[0].id);return (await manager.list({db:pool,allowed:true})).items.find(x=>x.id===qid);};
  const t1=await byRef(TABQ+'ts:t1');
  assert.equal(t1.facts.target,'tab');assert.equal(t1.facts.baseVersion,0);assert.equal(t1.facts.title,'오더 없는 작업 표시');assert.equal(t1.canAnswer,true);
  assert.ok(t1.facts.workOrderId&&!(await pool.query('SELECT 1 FROM work_orders WHERE id=$1',[t1.facts.workOrderId])).rows.length,'display discriminator, never an order id');
  assert.match(t1.lines[0].text,/인트라넷 오더가 없는 작업이라 리뷰웹에만 저장됩니다/);
  const outboxBefore=(await pool.query('SELECT count(*)::int n FROM shared_sync_outbox')).rows[0].n;
  const ordersBefore=JSON.stringify((await pool.query('SELECT id,work_manager,sync_version FROM work_orders ORDER BY id')).rows);
  const tArgs={db:pool,id:t1.id,baseVersion:0,choice:'mandu',admin:{role:'master',name:'가짜 관리자'},by:'가짜 관리자'};
  const race=await Promise.allSettled([manager.answer(tArgs),manager.answer({...tArgs,choice:'mango'})]);
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1,'one of two concurrent answers wins');assert.match(race.find(x=>x.status==='rejected').reason.message,/바뀐/);
  const tabMgr=async(s,t)=>((await pool.query('SELECT manager FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2',[s,t])).rows[0]||{}).manager;
  assert.equal(await tabMgr('ts','오더 없는 작업'),'만두','normalized nickname written to the empty tab cell');
  const won=race.find(x=>x.status==='fulfilled').value;assert.equal(won.status,'done');assert.equal(won.localSaved,true);assert.equal(won.remoteSync,'not_linked');
  const again=await manager.answer(tArgs);assert.equal(again.status,'done');assert.equal(again.remoteSync,'not_linked','exact retry is idempotent');
  await assert.rejects(manager.answer({...tArgs,choice:'mango'}),/바뀐/,'different retry refused');assert.equal(await tabMgr('ts','오더 없는 작업'),'만두');
  await assert.rejects(manager.answer({...tArgs,baseVersion:1}),/바뀐/,'tab question base version is 0');
  assert.equal((await pool.query('SELECT count(*)::int n FROM shared_sync_outbox')).rows[0].n,outboxBefore,'tab branch never enqueues intranet delivery');
  assert.equal(JSON.stringify((await pool.query('SELECT id,work_manager,sync_version FROM work_orders ORDER BY id')).rows),ordersBefore,'tab branch never writes work_orders');
  // A source order attaches after the question was shown → 409, no write; refresh closes the tab question and hands over to the order branch.
  const t2=await byRef(TABQ+'ts:t2');
  await pool.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name,created_at) VALUES('src-new','src-new-ro','랜덤','ts','원본 없는 오더',NOW()+INTERVAL '1 second')`);
  await assert.rejects(manager.answer({...tArgs,id:t2.id}),/바뀐/);assert.equal(await tabMgr('ts','원본 없는 오더'),'','no write when a source order arrived');
  await manager.refresh(pool);let refs=await openRefs();assert.ok(!refs.includes(TABQ+'ts:t2'),'tab question closed');assert.ok(refs.includes(manager.KIND+':src-new'),'order question takes over');
  // An older source order still bars the tab branch even when a newer source-less order is latest.
  await pool.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name,created_at) VALUES('nosrc-newer','','랜덤','ts','원본 없는 오더',NOW()+INTERVAL '2 second')`);
  await manager.refresh(pool);assert.ok(!(await openRefs()).includes(TABQ+'ts:t2'),'any intranet-linked order keeps the tab cell untouched');
  // Finished after the question was shown → 409 and closes.
  const t6=await byRef(TABQ+'ts2:name:gid 없는 작업');
  await pool.query(`INSERT INTO trackb_tab_finished(sheet_id,tab_name,tab_gid) VALUES('ts2','gid 없는 작업','')`);
  await assert.rejects(manager.answer({...tArgs,id:t6.id}),/바뀐/);assert.equal(await tabMgr('ts2','gid 없는 작업'),'');
  await manager.refresh(pool);assert.ok(!(await openRefs()).includes(TABQ+'ts2:name:gid 없는 작업'),'finished closes');
  // Codex P2: a gid-less tab later acquires a gid and is finished by gid only → the old name-key question is obsolete:
  //   answer → 409 (no write) and refresh closes it (no reopen under the new key because it is finished).
  await tabRow('ts4','나중에 gid',null);await own('ts4',null);await manager.refresh(pool);const tg=await byRef(TABQ+'ts4:name:나중에 gid');assert.ok(tg,'name-key question while gid-less');
  await pool.query(`UPDATE tab_configs SET tab_gid='g10' WHERE sheet_id='ts4'`);
  await pool.query(`INSERT INTO trackb_tab_finished(sheet_id,tab_name,tab_gid) VALUES('ts4','옛 이름','g10')`);
  await assert.rejects(manager.answer({...tArgs,id:tg.id}),/바뀐/);assert.equal(await tabMgr('ts4','나중에 gid'),'','no write to a tab finished by its current gid');
  await manager.refresh(pool);refs=await openRefs();assert.ok(!refs.includes(TABQ+'ts4:name:나중에 gid'),'obsolete name-key closes');assert.ok(!refs.includes(TABQ+'ts4:g10'),'finished by gid: no new key');
  // Someone else filled the cell after the question was shown → 409, zero writes (blank-only).
  await tabRow('ts','나중에 채워짐','t7');await own('ts','t7');await manager.refresh(pool);const t7=await byRef(TABQ+'ts:t7');
  await pool.query(`UPDATE tab_configs SET manager='외부담당' WHERE tab_name='나중에 채워짐'`);
  await assert.rejects(manager.answer({...tArgs,id:t7.id}),/바뀐/);assert.equal(await tabMgr('ts','나중에 채워짐'),'외부담당','existing manager kept');
  await manager.refresh(pool);assert.ok(!(await openRefs()).includes(TABQ+'ts:t7'),'filled cell closes');
  // Ownership removed → closes. Re-owned → the same stable key reopens.
  await pool.query(`DELETE FROM advertiser_campaigns WHERE sheet_id='ts3'`);await manager.refresh(pool);assert.ok(!(await openRefs()).includes(TABQ+'ts3:t9'));
  await own('ts3','t9');await manager.refresh(pool);const t9=await byRef(TABQ+'ts3:t9');assert.ok(t9,'reopens under the same key');
  // Same HTTP route + permissions as the order branch; a tab without a tab_configs row gets one (tab/config upsert convention).
  assert.equal((await call('/'+t9.id+'/manager-answer',denied,{choice:'mango',baseVersion:0})).status,403);
  assert.equal(await tabMgr('ts3','설정 없는 작업'),undefined,'refusal creates no row');
  response=await call('/'+t9.id+'/manager-answer',editor,{choice:'mango',baseVersion:0});
  assert.equal(response.status,200);assert.equal(response.body.item.remoteSync,'not_linked');assert.equal(response.body.item.localSaved,true);
  assert.equal(await tabMgr('ts3','설정 없는 작업'),'망고');
  assert.equal((await call('/'+t9.id+'/manager-answer',editor,{choice:'mandu',baseVersion:0})).status,409);
  console.log('decision 323 tab branch: scope/race/retry/source-arrives/finished/filled/no-config-row/HTTP PASS');
 }finally{await new Promise(r=>server.close(r));}
 console.log('actual HTTP auth/editor + SQL assignment/answer/outbox atomicity, stale/retry/stop PASS');
 console.log('actual SQL atomic failure/concurrent/idempotent/reopen/archive/external assignment + kind isolation/pagination PASS');await db.close();}
main().catch(e=>{console.error(e);process.exit(1)});
