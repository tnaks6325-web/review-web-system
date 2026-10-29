'use strict';
// Execute the actual condition-loading SQL, including manual-link priority, in isolated PostgreSQL.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');
const src = fs.readFileSync(require.resolve('../src/services/trackB.service'), 'utf8');
async function main() {
  const db = new PGlite();
  const load = src.slice(src.indexOf('  const { rows: wo } = await db.query(', src.indexOf('async function workdeskTab')), src.indexOf('  // 명단(활성)', src.indexOf('async function workdeskTab')));
  const helper = src.slice(src.indexOf('async function _effectiveLinkedWorkOrderId('), src.indexOf('// 링크 후보 발주 목록'));
  await db.exec(`CREATE TABLE trackb_work_order_links(sheet_id TEXT,tab_name TEXT,work_order_id TEXT,deleted_at TIMESTAMPTZ);
    CREATE TABLE work_orders(id TEXT PRIMARY KEY,title TEXT,product_option TEXT,product_options_json TEXT,source_review_order_id TEXT,bidir_state TEXT,sync_version BIGINT,linked_campaign_id TEXT,pay_amount INTEGER,review_fee INTEGER,daily_count INTEGER,daily_count_text TEXT,purchase_time TEXT,inflow_keyword TEXT,inflow_type TEXT,inflow_guide TEXT,delivery_type TEXT,courier_proxy BOOLEAN,review_type TEXT,recruit_count INTEGER,review_guide TEXT,special_notes TEXT,product_url TEXT,start_date DATE,manager_name TEXT,work_manager TEXT,created_by TEXT,status TEXT,goods_cost_type TEXT,deleted_at TIMESTAMPTZ,linked_tab_sheet_id TEXT,linked_tab_name TEXT,created_at TIMESTAMPTZ);
    INSERT INTO work_orders(id,pay_amount,product_url,inflow_guide,recruit_count,work_manager,created_by,created_at)
      VALUES('manual',12345,'https://fake.invalid/product','가짜 수동 가이드',7,'박은비','가짜AE','2026-01-01');
    INSERT INTO trackb_work_order_links VALUES('FAKE','가짜','manual',NULL);`);
  const run = () => vm.runInNewContext(`(async()=>{${helper}\n${load}\nreturn {wo, managerWo:typeof managerWo==='undefined'?undefined:managerWo};})()`, {
    db, sheetId:'FAKE',tabName:'가짜',_parseWoOptions:()=>[],logger:{warn:()=>{}}
  });
  let result = await run();
  assert.equal(result.wo.length,1,'manual-only link must keep its existing conditions');
  assert.equal(result.wo[0].id,'manual'); assert.equal(result.wo[0].payAmount,12345);
  assert.equal(Object.hasOwn(result.wo[0],'workManager'),false,'public detail query must not carry canonical manager real names');
  assert.equal(result.wo[0].productUrl,'https://fake.invalid/product');
  assert.equal(result.wo[0].inflowGuide,'가짜 수동 가이드');
  // A different/newer direct-linked order controls manager only, never replaces manually linked money/URL.
  await db.exec(`INSERT INTO work_orders(id,work_manager,linked_tab_sheet_id,linked_tab_name,created_at) VALUES
    ('direct-old','박은비','FAKE','가짜','2026-02-01'),('direct-new','박세희','FAKE','가짜','2026-03-01'),
    ('deleted','박은비','FAKE','가짜','2026-04-01'); UPDATE work_orders SET deleted_at=NOW() WHERE id='deleted';`);
  result=await run();
  assert.equal(result.wo[0].id,'manual');
  assert.equal(result.managerWo[0].id,'direct-new');
  const pool=require('../src/db/pool'); pool.query=async()=>({rows:[]});
  const svc=require('../src/services/trackB.service');
  const summary=await svc.tabConditionSummary({query:pool.query},{sheetId:'FAKE',tabName:'가짜',meta:{manager:'망고'},wo:result.wo[0],managerWo:result.managerWo[0]});
  assert.ok(summary); assert.equal(summary.workOrderId,'manual');
  assert.equal(summary.productUrl,'https://fake.invalid/product'); assert.equal(summary.manager.adminNick,'만두');
  assert.equal(summary.manager.ae,'가짜AE'); assert.equal(summary.managerWorkOrderId,'direct-new');
  // Execute the actual workdesk summary/capability assembly too, not just the result object.
  const gateStart=src.indexOf('  const _cond = await tabConditionSummary(');
  const gateEnd=src.indexOf('  /* 총 모집완료 표기는',gateStart);
  const assembled=await vm.runInNewContext(`(async()=>{${src.slice(gateStart,gateEnd)};return _cond;})()`,{
    tabConditionSummary:svc.tabConditionSummary,db:{query:pool.query},sheetId:'FAKE',tabName:'가짜',
    meta:[{manager:'망고'}],wo:result.wo,managerWo:[{...result.managerWo[0],sourceReviewOrderId:'IA-FAKE',status:'reviewing',syncVersion:12}],
    showEdits:true,managerEditAllowed:true,role:'admin',process:{env:{}},logger:{warn:()=>{}}
  });
  assert.equal(assembled.workOrderId,'manual');assert.equal(assembled.managerEdit.workOrderId,'direct-new');
  assert.equal(assembled.managerEdit.syncVersion,12);assert.equal(assembled.manager.adminNick,'만두');
  await db.exec(`UPDATE trackb_work_order_links SET deleted_at=NOW();`);
  result=await run();assert.equal(result.wo[0].id,'direct-new','deleted manual link falls back to newest live direct order');
  await db.close(); console.log('manualLinkedConditions: actual SQL manual-only/mixed/deleted links + actual summary PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
