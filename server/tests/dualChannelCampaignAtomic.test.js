'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const runtime = require('../src/services/dualChannelRuntime.service');
const pool = require('../src/db/pool');
const shared = require('../src/services/sharedPatch.service');
const product = () => ({ name:'리뷰웹 이름',option_schema_version:2,product_mode:'none',options:[],url:'https://shop.example/n',base:{pay:19000,count:3,daily:1},channels:{naver:{url:'https://shop.example/n',pay:9000,inflow_type:'link'},coupang:{url:'https://shop.example/c',pay:10000,inflow_type:'link'}} });
async function setup() {
 const pg = new PGlite(); const calls=[];
 const source=f=>fs.readFileSync(path.resolve(__dirname,'../src',f),'utf8');
 const cols = source('routes/order.routes.js').match(/INSERT INTO work_orders\s*\(([^)]+)\)\s*VALUES/)[1].split(',').map(x=>x.trim());
 const ints=new Set(['pay_amount','review_fee','daily_count','recruit_count','source_revision','workboard_schema_version','work_round']);
 const bools=new Set(['courier_proxy','skip_weekends']);
 await pg.exec(`CREATE TABLE work_orders (${cols.map(k=>`${k} ${ints.has(k)?'INTEGER':bools.has(k)?'BOOLEAN':'TEXT'}${k==='id'?' PRIMARY KEY':''}`).join(',')},created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),deleted_at TIMESTAMPTZ,linked_campaign_id TEXT DEFAULT '',bidir_state TEXT DEFAULT 'off',sync_version BIGINT DEFAULT 0,intranet_acked_version BIGINT DEFAULT 0,advertiser_id TEXT DEFAULT '',tab_deleted_at TIMESTAMPTZ);
 CREATE TABLE work_order_shared_snapshots(work_order_id TEXT,sync_version BIGINT,origin TEXT,op_id TEXT DEFAULT '',state JSONB,actor TEXT,PRIMARY KEY(work_order_id,sync_version));
 CREATE TABLE shared_sync_outbox(work_order_id TEXT,sync_version BIGINT,view_scope TEXT DEFAULT 'full',status TEXT DEFAULT 'pending',attempts INT DEFAULT 0,next_at TIMESTAMPTZ DEFAULT NOW(),last_error TEXT DEFAULT '',updated_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(work_order_id,sync_version));
 CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_settings VALUES ('bidir_sync','{"in2rw":"apply","campaign_edit":"on","publish_reconcile":"on"}');`);
 const cs=source('routes/campaign.routes.js').match(/INSERT INTO recruit_campaigns\s*\(([^)]+)\)\s*VALUES/)[1].split(',').map(x=>x.trim());
 const cn=new Set(['review_fee','sort_order','max_slots','daily_limit','recruit_total','close_buffer_min','hold_ttl_min','multi_daily_limit','sub_hold_ttl_min','repurchase_days']);
 const cb=new Set(['participation_mode','multi_account_mode','reviewer_hidden','skip_weekends','cash_receipt_required']);
 const cj=new Set(['work_detail','badges','review_type_mix','delivery_type_mix','delivery_review_fee_mix']);
 await pg.exec(`CREATE TABLE recruit_campaigns(${cs.map(k=>`${k} ${cn.has(k)?'INTEGER':cb.has(k)?'BOOLEAN':cj.has(k)?'JSONB':'TEXT'}${k==='id'?' PRIMARY KEY':''}`).join(',')},archived_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),required_delivery_memo TEXT DEFAULT '',published_at TIMESTAMPTZ);
 CREATE TABLE campaign_options(id SERIAL PRIMARY KEY,campaign_id TEXT,sort_order INT DEFAULT 0,status TEXT DEFAULT 'active',opt_key TEXT,product_name TEXT,unit_kind TEXT,option_url TEXT,product_url TEXT,pay_amount INT,recruit_total INT,daily_limit INT,review_type_mix JSONB,inflow_guide_html TEXT,inflow_guide_images JSONB,inflow_type TEXT,updated_at TIMESTAMPTZ);
 CREATE TABLE campaign_fee_schedules(campaign_id TEXT,effective_from DATE,review_fee INT,memo TEXT,updated_at TIMESTAMPTZ,PRIMARY KEY(campaign_id,effective_from));
 CREATE TABLE blacklist(phone TEXT,name TEXT,added_at TIMESTAMPTZ);
 CREATE TABLE campaign_reviewer_gates(campaign_id TEXT,phone8 TEXT,reviewer_name TEXT,mode TEXT,message_type TEXT,created_by TEXT,released_at TIMESTAMPTZ);`);
 const runtimeDdl = source('routes/order.routes.js').match(/async function _ensureTables\(\) \{[\s\S]*?\n\}/)[0];
 for (const match of runtimeDdl.matchAll(/pool\.query\(`(ALTER TABLE work_orders[^`]+)`\)/g)) await pg.exec(match[1]);
 const originals={query:pool.query,connect:pool.connect};
 // Explicit cross-team DI: execute the quota owner's real InTx SQL against
 // this fixture, with this worktree's lifecycle/pool dependencies. No file copy.
 const quotaPath=path.resolve(__dirname,'../src/services/linkedRecruitQuota.service.js');
 const quota=require(quotaPath);const previousQuota=quota.syncCampaignRecruitTotalInTx;
 if (!previousQuota) {
  const peerPath=process.env.DUAL_QUOTA_PEER;
  assert.ok(peerPath,'integrate quota InTx export, or explicitly provide DUAL_QUOTA_PEER for cross-team SQL composition');
  const peerSource=fs.readFileSync(peerPath,'utf8');
  console.log('explicit quota DI',peerPath,require('node:crypto').createHash('sha256').update(peerSource).digest('hex'));
  const Module=require('node:module');const peer=new Module(quotaPath,module);peer.filename=quotaPath;peer.paths=module.paths;
  peer._compile(peerSource,quotaPath);quota.syncCampaignRecruitTotalInTx=peer.exports.syncCampaignRecruitTotalInTx;
 }
 assert.equal(typeof quota.syncCampaignRecruitTotalInTx,'function','quota InTx export required');
 const query=async(s,p)=>{calls.push(String(s)); return pg.query(s,p)};
 pool.query=query; pool.connect=async()=>({query,release(){}});
 process.env.ORDER_INTAKE_KEY='local-atomic';
 runtime.__setReadinessForTest({settings:true,roundtrip:true});
 const orders=require('../src/routes/order.routes'); const campaigns=require('../src/routes/campaign.routes');
 const call=async(handler,body,params={})=>{
  const res={statusCode:200,status(n){this.statusCode=n;return this},json(b){this.body=b;return this}};let error;
  await handler({body,params,admin:{name:'local',role:'admin'},headers:{'x-intake-key':'local-atomic'},query:{}},res,e=>{error=e});
  if(error) throw error;return res;
 };
 const intake=orders.stack.find(l=>l.route?.path==='/intake'&&l.route.methods.post).route.stack.at(-1).handle;
 const body={title:'local dual',source_system:'inadd_intranet',source_review_order_id:'source_local',source_revision:1,idempotency_key:'source_local:1:a',product_options_json:JSON.stringify([product()]),work_kind:'review',recruit_count:3,daily_count:1,pay_amount:57000,skip_weekends:false,purchase_channel:'네이버+쿠팡',inflow_type:'link'};
 const intakeResult=await call(intake,body);assert.equal(intakeResult.statusCode,200,JSON.stringify(intakeResult.body));
 const wo=intakeResult.body.data;
 const campaignBody={...require('../src/utils/woCampaignPrefill.generated')._woCampaignPrefill(wo),title:'local campaign',status:'draft',review_type_mix:[],delivery_type_mix:[],delivery_review_fee_mix:[],source_work_order_id:wo.id,channel:'네이버+쿠팡',recruit_total:3,daily_limit:1,work_kind:'review',required_delivery_memo:'문앞',work_detail:{dualChannelProduct:product(),other:'keep'}};
 return {pg,calls,call,orders,campaigns,wo,body,campaignBody,close:async()=>{quota.syncCampaignRecruitTotalInTx=previousQuota;pool.query=originals.query;pool.connect=originals.connect;runtime.__setReadinessForTest(null);await pg.close()}};
}
test('actual campaign create saves body conditions quota link snapshot and outbox in one transaction', async()=>{
 const f=await setup();try{
  const out=await f.call(f.campaigns.handlers.adminCreate,f.campaignBody);
  assert.equal(out.statusCode,200,JSON.stringify(out.body));
  const c=(await f.pg.query('SELECT * FROM recruit_campaigns')).rows[0];
  const w=(await f.pg.query('SELECT * FROM work_orders')).rows[0];
  assert.equal(c.required_delivery_memo,'문앞');assert.equal(c.work_detail.dualChannelProduct.channels.coupang.pay,10000);
  assert.equal(w.linked_campaign_id,c.id);assert.equal(w.bidir_state,'on');assert.equal(w.recruit_count,3);
  assert.equal((await f.pg.query('SELECT * FROM work_order_shared_snapshots')).rows.length>0,true);
  assert.equal((await f.pg.query('SELECT * FROM shared_sync_outbox')).rows.length,1);
  const business=f.calls.slice(0,f.calls.indexOf('COMMIT')+1);
  assert.equal(business.filter(s=>s==='BEGIN').length,1);
  for(const table of ['recruit_campaigns','work_orders','work_order_shared_snapshots','shared_sync_outbox']) assert.ok(business.some(s=>new RegExp('(?:INSERT INTO|UPDATE) '+table+'\\b').test(s)),table);
 }finally{await f.close()}
});
test('actual campaign update shares new channel conditions atomically and old editor omission preserves them', async()=>{
 const f=await setup();try{
  const created=await f.call(f.campaigns.handlers.adminCreate,f.campaignBody);assert.equal(created.statusCode,200,JSON.stringify(created.body));
  const c=created.body.data;const w=(await f.pg.query('SELECT * FROM work_orders')).rows[0];
  const p=product();p.channels.naver.url='https://shop.example/new-channel';
  const out=await f.call(f.campaigns.handlers.adminUpdate,{title:'수정 제목',bidir_base_sync_version:Number(w.sync_version),work_detail:{dualChannelProduct:p}}, {id:c.id});
  assert.equal(out.statusCode,200,JSON.stringify(out.body));
  let saved=(await f.pg.query('SELECT * FROM recruit_campaigns')).rows[0];
  assert.equal(saved.title,'수정 제목');assert.equal(saved.work_detail.other,'keep');assert.equal(saved.work_detail.dualChannelProduct.channels.naver.url,p.channels.naver.url);
  let wo=(await f.pg.query('SELECT * FROM work_orders')).rows[0];assert.equal(JSON.parse(wo.product_options_json)[0].channels.naver.url,p.channels.naver.url);
  const omitted=await f.call(f.campaigns.handlers.adminUpdate,{title:'옛 편집창',bidir_base_sync_version:Number(wo.sync_version),work_detail:{productLines:'사람이 쓴 안내'}},{id:c.id});
  assert.equal(omitted.statusCode,200,JSON.stringify(omitted.body));
  saved=(await f.pg.query('SELECT * FROM recruit_campaigns')).rows[0];assert.equal(saved.work_detail.dualChannelProduct.channels.naver.url,p.channels.naver.url);
 }finally{await f.close()}
});
test('actual campaign second SQL failure rolls back the already inserted body and all related writes', async()=>{
 const f=await setup();try{
  const before=(await f.pg.query('SELECT * FROM work_orders')).rows;
  await f.pg.exec(`ALTER TABLE recruit_campaigns ADD CONSTRAINT reject_second_write CHECK(required_delivery_memo <> '문앞')`);
  f.calls.length=0;
  await assert.rejects(f.call(f.campaigns.handlers.adminCreate,f.campaignBody),/reject_second_write/);
  assert.ok(f.calls.some(s=>/INSERT INTO recruit_campaigns/.test(s)),'first INSERT was really executed');
  assert.ok(f.calls.some(s=>/UPDATE recruit_campaigns SET required_delivery_memo/.test(s)),'second real SQL was attempted');
  assert.equal((await f.pg.query('SELECT * FROM recruit_campaigns')).rows.length,0);
  assert.deepEqual((await f.pg.query('SELECT * FROM work_orders')).rows,before);
  assert.equal((await f.pg.query('SELECT * FROM work_order_shared_snapshots')).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM shared_sync_outbox')).rows.length,0);
 }finally{await f.close()}
});
test('actual campaign update second shared SQL failure restores campaign order snapshots and outbox', async()=>{
 const f=await setup();try{
  const created=await f.call(f.campaigns.handlers.adminCreate,f.campaignBody);assert.equal(created.statusCode,200);
  const tables=['work_orders','recruit_campaigns','work_order_shared_snapshots','shared_sync_outbox'];
  const before=await Promise.all(tables.map(t=>f.pg.query(`SELECT * FROM ${t}`)));
  const w=before[0].rows[0];
  await f.pg.exec(`ALTER TABLE work_order_shared_snapshots ADD CONSTRAINT reject_second_shared_write CHECK(origin <> 'campaign')`);
  const p=product();p.channels.naver.url='https://shop.example/will-rollback';
  await assert.rejects(f.call(f.campaigns.handlers.adminUpdate,{title:'will rollback',bidir_base_sync_version:Number(w.sync_version),work_detail:{dualChannelProduct:p}},{id:created.body.data.id}),/reject_second_shared_write/);
  for(let i=0;i<tables.length;i++) assert.deepEqual((await f.pg.query(`SELECT * FROM ${tables[i]}`)).rows,before[i].rows,tables[i]);
 }finally{await f.close()}
});
test('caller can roll back successful real shared InTx writes without nested transaction controls', async()=>{
 const f=await setup();try{
  const created=await f.call(f.campaigns.handlers.adminCreate,f.campaignBody);assert.equal(created.statusCode,200);
  const wo=(await f.pg.query('SELECT * FROM work_orders')).rows[0];
  const before=(await f.pg.query('SELECT * FROM work_order_shared_snapshots')).rows;
  const lifecycle=require('../src/services/dualChannelLifecycle.service');
  const scope=await lifecycle.discoverDualScope(f.pg,[{campaignId:created.body.data.id}]);
  const client=await pool.connect();await client.query('BEGIN');await lifecycle.lockDualScopeInTx(client,scope);await lifecycle.assertDualProvenanceUnchanged(client,scope);
  f.calls.length=0;
  const linked=await shared.linkSharedOrderInTx(client,{workOrderId:wo.id});assert.equal(linked.status,200);
  const p=product();p.channels.naver.url='https://shop.example/in-tx';
  const out=await shared.applySharedPatchInTx(client,{workOrderId:wo.id,baseVersion:Number(wo.sync_version),origin:'campaign',mine:{product_options_json:JSON.stringify([p])}});
  assert.equal(out.status,200,JSON.stringify(out.body));
  assert.equal(f.calls.some(s=>/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)),false);
  assert.equal(JSON.parse((await f.pg.query('SELECT product_options_json FROM work_orders')).rows[0].product_options_json)[0].channels.naver.url,p.channels.naver.url);
  await client.query('ROLLBACK');client.release();
  assert.deepEqual((await f.pg.query('SELECT * FROM work_orders')).rows[0],wo);assert.deepEqual((await f.pg.query('SELECT * FROM work_order_shared_snapshots')).rows,before);
 }finally{await f.close()}
});
test('actual source revision aligns independent names before restoring omitted channels and preserves revision retry rules', async()=>{
 const f=await setup();try{
  const created=await f.call(f.campaigns.handlers.adminCreate,f.campaignBody);assert.equal(created.statusCode,200,JSON.stringify(created.body));
  const w=(await f.pg.query('SELECT * FROM work_orders')).rows[0];
  const p=product();delete p.channels;p.name='인트라넷 별도 이름';p.url='https://shop.example/edited';
  const body={...f.body,source_revision:2,idempotency_key:'source_local:2:b',product_option:'1. 인트라넷 별도 이름',product_options_json:JSON.stringify([p]),bidir:{base_sync_version:Number(w.sync_version),rw_names:{'인트라넷 별도 이름':'리뷰웹 이름'},money:1,counts:1,structure:1,rename:1,guide:1,weekends:1,reviewtype:1,delivery:1,mode:1}};
  const handler=f.orders.stack.find(l=>l.route?.path==='/intake/source/:sourceReviewOrderId').route.stack.at(-1).handle;
  const save=b=>f.call(handler,b,{sourceReviewOrderId:'source_local'});
  const out=await save(body);assert.equal(out.statusCode,200,JSON.stringify(out.body));
  const saved=(await f.pg.query('SELECT * FROM work_orders')).rows[0];const pp=JSON.parse(saved.product_options_json)[0];
  assert.equal(saved.source_revision,2);assert.equal(pp.name,'리뷰웹 이름');assert.equal(pp.channels.coupang.pay,10000);assert.equal(pp.url,p.url);
  assert.equal(String(saved.product_option).includes('인트라넷 별도 이름'),false,'IN summary must not overwrite RW names');
  assert.equal((await save(body)).body.idempotent,true);
  const wrong=await save({...body,idempotency_key:'source_local:2:c'});assert.equal(wrong.statusCode,409);assert.equal(wrong.body.code,'revision_already_applied');
  const gap=await save({...body,source_revision:4,idempotency_key:'source_local:4:c'});assert.equal(gap.body.code,'revision_gap');
 }finally{await f.close()}
});
