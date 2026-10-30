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
 CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,manager TEXT DEFAULT '',display_name TEXT DEFAULT '');
 INSERT INTO tab_configs VALUES('fake','가짜 작업','','가짜 상품');
 INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name) VALUES('fake-order','fake-source','랜덤','fake','가짜 작업');`);
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
 await pool.query(`UPDATE work_orders SET work_manager='박은비',sync_version=sync_version+1`);await assert.rejects(manager.answer({...args,baseVersion:q.facts.baseVersion}),/바뀐/);await manager.refresh(pool);assert.equal((await pool.query('SELECT status FROM ops_checks')).rows[0].status,'done');
 // Same current-order + tab fallback semantics, and every ineligible branch is a real SQL refresh.
 const reset=async()=>{await pool.query(`UPDATE work_orders SET status='reviewing',deleted_at=NULL,source_review_order_id='fake-source',work_manager='랜덤',linked_tab_sheet_id='fake',linked_tab_name='가짜 작업'`);await pool.query(`UPDATE tab_configs SET manager=''`);};
 for(const sql of ["status='done'","deleted_at=NOW()","source_review_order_id=''","linked_tab_sheet_id=''","work_manager='외부담당'"]){await reset();await pool.query('UPDATE work_orders SET '+sql);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items.length,0,sql);}
 for(const tabManager of ['망고','외부담당']){await reset();await pool.query('UPDATE tab_configs SET manager=$1',[tabManager]);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items.length,0,'tab fallback '+tabManager);}
 await reset();await manager.refresh(pool);
 const stable=(await manager.list({db:pool,allowed:true})).items[0].id;
 const fallbackQ=(await manager.list({db:pool,allowed:true})).items[0];await pool.query(`UPDATE tab_configs SET manager='망고'`);
 await assert.rejects(manager.answer({...args,id:fallbackQ.id,baseVersion:fallbackQ.facts.baseVersion}),/바뀐/);await pool.query(`UPDATE tab_configs SET manager=''`);
 await pool.query(`UPDATE tab_configs SET display_name='이름 바뀐 가짜 상품'`);await manager.refresh(pool);assert.equal((await manager.list({db:pool,allowed:true})).items[0].id,stable,'rename keeps stable order key');
 await pool.query(`INSERT INTO work_orders(id,source_review_order_id,work_manager,linked_tab_sheet_id,linked_tab_name,created_at) VALUES('newer-fake','fake-new-source','랜덤','fake','가짜 작업',NOW()+INTERVAL '1 second')`);
 await manager.refresh(pool);let latest=(await manager.list({db:pool,allowed:true})).items;assert.equal(latest.length,1);assert.equal(latest[0].facts.workOrderId,'newer-fake');await pool.query(`DELETE FROM work_orders WHERE id='newer-fake'`);await manager.refresh(pool);
 await pool.query(`UPDATE work_orders SET work_manager='박은비'`);await manager.refresh(pool);
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
 }finally{await new Promise(r=>server.close(r));}
 console.log('actual HTTP auth/editor + SQL assignment/answer/outbox atomicity, stale/retry/stop PASS');
 console.log('actual SQL atomic failure/concurrent/idempotent/reopen/archive/external assignment + kind isolation/pagination PASS');await db.close();}
main().catch(e=>{console.error(e);process.exit(1)});
