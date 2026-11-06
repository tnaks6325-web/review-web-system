'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, bundle, uuid, sha } = require('./dualChannelSchema.test');
const svc = require('../src/services/workTabDelete.service');
async function setup() {
  const db = await fixture();
  for (const table of [...svc.DELETE_TABLES,...svc.MONEY_TABLES.map(x=>x.table)]) {
    if (['order_submissions','review_submissions','payment_batch_items','campaign_participants','tab_configs'].includes(table)) continue;
    await db.exec(`CREATE TABLE IF NOT EXISTS ${table}(sheet_id TEXT,tab_name TEXT)`);
  }
  await db.exec(`CREATE TABLE tab_configs(sheet_id TEXT,tab_name TEXT,tab_gid TEXT,sheetless BOOLEAN);
    CREATE TABLE campaign_participants(sheet_id TEXT,tab_name TEXT,seq INTEGER,order_submission_id UUID,name TEXT,recipient TEXT,phone TEXT,is_submitted BOOLEAN,is_paid BOOLEAN);
    ALTER TABLE raw_sheet_tabs ADD COLUMN tab_gid TEXT;
    CREATE TABLE work_orders(id TEXT,title TEXT,status TEXT,created_by TEXT,deleted_at timestamptz,linked_tab_sheet_id TEXT,linked_tab_name TEXT,linked_tab_gid TEXT,tab_deleted_at timestamptz,tab_deleted_by TEXT,tab_deleted_tab TEXT,updated_at timestamptz);
    CREATE TABLE advertiser_campaigns(sheet_id TEXT,tab_gid TEXT);
    CREATE TABLE campaigns(sheet_id TEXT);
    CREATE TABLE payment_account_mismatch_reconciliations(batch_item_id UUID REFERENCES payment_batch_items(id) ON DELETE RESTRICT);
    CREATE TABLE orphan_capture_tombstones(file_id TEXT UNIQUE,file_name TEXT,sheet_id TEXT,tab_name TEXT,reviewer_name TEXT,slot_key TEXT,reason TEXT,recorded_by TEXT);
    INSERT INTO tab_configs VALUES('S','T','g',true),('S','OTHER','h',true);
    DELETE FROM payment_batch_items;
    INSERT INTO participant_edits VALUES('S','T'),('S','OTHER');`);
  await bundle(db);
  await bundle(db,3,2);
  await db.query(`UPDATE order_submissions SET sheet_id='campaign:c1',tab_name='' WHERE id=$1`,[uuid(2)]);
  await db.query(`UPDATE order_submissions SET tab_name='OTHER' WHERE id=$1`,[uuid(3)]);
  for (const [order,channel] of [[2,'naver'],[2,'coupang'],[3,'naver']]) await db.query(`INSERT INTO order_purchase_channels(order_submission_id,channel,paid_amount) VALUES($1,$2,100)`,[uuid(order),channel]);
  for (const [id,app,order,status,rev] of [[31,1,2,'committed',1],[32,3,null,'staged',1],[33,1,2,'superseded',2],[34,2,3,'committed',1]]) {
    await db.query(`INSERT INTO purchase_capture_artifacts(id,application_id,order_submission_id,channel,role,revision,file_id,byte_sha256,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status,superseded_at) VALUES($1,$2,$3,'naver','primary',$4,$5,$6,$6,$6,$6,$7,CASE WHEN $7='superseded' THEN NOW() ELSE NULL END)`,[uuid(id),app,order?uuid(order):null,rev,`file-${id}`,sha,status]);
  }
  const log=[];
  const client={query:async (sql,params)=>{log.push(sql);const r=await db.query(sql,params);return {...r,rowCount:r.affectedRows??r.rows.length};},release(){}};
  return {db,log,pool:{connect:async()=>client,query:client.query},client};
}
async function snapshot(db) {
  const out={};
  for (const t of ['order_submissions','order_purchase_channels','purchase_capture_artifacts','campaign_applications','recruit_campaigns','tab_configs','participant_edits','orphan_capture_tombstones']) out[t]=(await db.query(`SELECT to_jsonb(t) AS v FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows;
  return out;
}
test('contradictory application and parent work affinity blocks all writes',async()=>{
  const {db,pool,log}=await setup();
  try {
    await db.query(`UPDATE order_submissions SET tab_name='OTHER',sheet_id='S' WHERE id=$1`,[uuid(2)]);
    const before=await snapshot(db);
    await assert.rejects(svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false}),/Conflicting dual/);
    assert.deepEqual(await snapshot(db),before);
    assert.equal(log.filter(s=>/^\s*(DELETE|INSERT|UPDATE)/.test(s)).length,0);
  } finally {await db.close();}
});
test('partial schema, failed discovery, money refusal and untouched refusal preserve real rows',async()=>{
  const {db,pool,client,log}=await setup();
  try {
    await db.exec(`ALTER TABLE campaign_participants ADD COLUMN reviewer_name TEXT,ADD COLUMN recipient_name TEXT,ADD COLUMN phone8 TEXT;
      ALTER TABLE trackb_settlement_links ADD COLUMN linked_by TEXT;
      ALTER TABLE trackb_work_order_links ADD COLUMN work_order_id TEXT,ADD COLUMN deleted_at timestamptz;`);
    const before=await snapshot(db);
    let out=await svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,onlyIfUntouched:true,notifyIntranet:false});
    assert.equal(out.code,'not_untouched'); assert.deepEqual(await snapshot(db),before);
    assert.equal(log.filter(s=>/^\s*(INSERT|UPDATE|DELETE)/.test(s)).length,0);
    await db.query(`INSERT INTO payment_batch_items(id,sheet_id,tab_name,row_index,order_submission_id,eligibility_fingerprint) VALUES($1,'S','T',2,$2,$3)`,[uuid(41),uuid(2),sha]);
    out=await svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false});
    assert.equal(out.code,'payment_locked'); assert.deepEqual(await snapshot(db),before);
    assert.equal(log.filter(s=>/^\s*(INSERT|UPDATE|DELETE)/.test(s)).length,0);
    await db.exec('DELETE FROM payment_batch_items');
    await db.exec('ALTER TABLE order_purchase_channels RENAME TO absent_channels');
    await assert.rejects(svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false}),/Incomplete dual/);
    await db.exec('ALTER TABLE absent_channels RENAME TO order_purchase_channels');
    assert.deepEqual(await snapshot(db),before);
    const query=client.query;
    client.query=(sql,p)=>sql.includes('to_regclass')?db.query('SELECT 1/0'):query(sql,p);
    await assert.rejects(svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false}),/division by zero/);
    client.query=query; assert.deepEqual(await snapshot(db),before);
    await db.query(`INSERT INTO payment_batch_items(id,sheet_id,tab_name,row_index,order_submission_id,eligibility_fingerprint) VALUES($1,'S','T',2,$2,$3)`,[uuid(41),uuid(2),sha]);
    await db.query('INSERT INTO payment_account_mismatch_reconciliations VALUES($1)',[uuid(41)]);
    out=await svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,forcePayment:true,pool,notifyIntranet:false});
    assert.equal(out.ok,true); assert.equal((await db.query('SELECT count(*)::int n FROM payment_batch_items')).rows[0].n,0);
    assert.ok(log.findIndex(s=>s.startsWith('DELETE FROM payment_account_mismatch_reconciliations'))<log.findIndex(s=>s.startsWith('DELETE FROM payment_batch_items')));
  } finally {await db.close();}
});
test('real delete preserves all artifact tombstones, removes FK children first, leaves other work unchanged',async()=>{
  const {db,log,pool}=await setup();
  try {
    const other=(await db.query(`SELECT to_jsonb(a) v FROM purchase_capture_artifacts a WHERE application_id=2`)).rows;
    const out=await svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false});
    assert.equal(out.ok,true);
    assert.deepEqual((await db.query(`SELECT file_id FROM orphan_capture_tombstones WHERE file_id LIKE 'file-%' ORDER BY file_id`)).rows.map(r=>r.file_id),['file-31','file-32','file-33']);
    assert.deepEqual((await db.query(`SELECT to_jsonb(a) v FROM purchase_capture_artifacts a WHERE application_id=2`)).rows,other);
    assert.equal((await db.query(`SELECT count(*)::int n FROM order_submissions WHERE id=$1`,[uuid(2)])).rows[0].n,0);
    assert.equal((await db.query(`SELECT count(*)::int n FROM campaign_applications WHERE id IN(1,3)`)).rows[0].n,0);
    for (const t of ['purchase_capture_artifacts','order_purchase_channels']) assert.ok(log.findIndex(s=>s.startsWith(`DELETE FROM ${t}`)) < log.findIndex(s=>s.startsWith('DELETE FROM order_submissions')));
    assert.equal((await db.query(`SELECT count(*)::int n FROM participant_edits WHERE tab_name='OTHER'`)).rows[0].n,1);
  } finally {await db.close();}
});
test('a successful first child DELETE followed by real SQL failure rolls the entire transaction back',async()=>{
  const {db,pool,client}=await setup();
  try {
    const before=await snapshot(db); const query=client.query; let first=false;
    client.query=async(sql,params)=>{
      if(sql.startsWith('DELETE FROM order_purchase_channels')) {assert.equal(first,true); return db.query('SELECT 1/0');}
      const r=await query(sql,params); if(sql.startsWith('DELETE FROM purchase_capture_artifacts')) {first=true;assert.ok(r.rowCount>0);} return r;
    };
    await assert.rejects(svc.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false}),/division by zero/);
    assert.equal(first,true); assert.deepEqual(await snapshot(db),before);
    // Memory-only mutation: remove transaction/savepoint controls, never edit product source.
    const fs=require('node:fs'), vm=require('node:vm'), {createRequire}=require('node:module');
    const filename=require.resolve('../src/services/workTabDelete.service');
    let source=fs.readFileSync(filename,'utf8');
    for(const sql of ['BEGIN','COMMIT','ROLLBACK','SAVEPOINT orphan_tomb','RELEASE SAVEPOINT orphan_tomb','ROLLBACK TO SAVEPOINT orphan_tomb']) source=source.split(`await client.query('${sql}');`).join('');
    const context={module:{exports:{}},require:createRequire(filename),console,process};
    vm.runInNewContext(source,context,{filename}); first=false;
    await assert.rejects(context.module.exports.deleteTask({sheetId:'S',tabName:'T',confirm:true,pool,notifyIntranet:false}),/division by zero/);
    assert.equal(first,true);
    const mutated=await snapshot(db);
    assert.throws(()=>assert.deepEqual(mutated,before),assert.AssertionError);
    assert.ok(mutated.purchase_capture_artifacts.length<before.purchase_capture_artifacts.length,'no transaction mutant must persist first deletion');
    console.log('mutation detected: removing transaction boundaries loses artifacts after second SQL failure');
  } finally {await db.close();}
});
