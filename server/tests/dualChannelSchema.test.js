'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = path.join(__dirname, '../migrations/215_dual_channel_purchase_bundles.sql');
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(64);
async function fixture(apply = true) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY, linked_sheet_id TEXT, linked_tab_name TEXT, status TEXT, published_at timestamptz, archived_at timestamptz);
    CREATE TABLE campaign_applications(id SERIAL PRIMARY KEY, campaign_id TEXT REFERENCES recruit_campaigns(id) ON DELETE CASCADE);
    CREATE TABLE order_submissions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id TEXT,tab_name TEXT,deleted_at timestamptz,capture_file_id TEXT,capture_file_id_2 TEXT,orderer TEXT);
    CREATE TABLE review_submissions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),sheet_id TEXT,tab_name TEXT,file_id TEXT,file_name TEXT,reviewer_name TEXT,slot_key TEXT);
    CREATE TABLE payment_batches(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),historical_key TEXT);
    CREATE TABLE payment_batch_items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),batch_id UUID REFERENCES payment_batches(id),sheet_id TEXT,tab_name TEXT,row_index INTEGER,status TEXT DEFAULT 'pending',CONSTRAINT ck_payment_items_status CHECK(status IN ('pending','paid','failed','cancelled')));
    CREATE UNIQUE INDEX uq_payment_items_active ON payment_batch_items(sheet_id,tab_name,row_index) WHERE status IN ('pending','paid');
    INSERT INTO recruit_campaigns VALUES('c1','S','T','active',NULL,NULL),('c2','S','OTHER','active',NULL,NULL);
    INSERT INTO campaign_applications(id,campaign_id) VALUES(1,'c1'),(2,'c2'),(3,'c1');
    INSERT INTO order_submissions(id,sheet_id,tab_name) VALUES('${uuid(1)}','S','T');
    INSERT INTO review_submissions(id,sheet_id,tab_name) VALUES('${uuid(11)}','S','T');
    INSERT INTO payment_batch_items(id,sheet_id,tab_name,row_index) VALUES('${uuid(21)}','S','T',1);`);
  if (apply) { const sql = fs.readFileSync(migration,'utf8'); await db.exec(sql); await db.exec(sql); }
  return db;
}
async function bundle(db, n=2, app=1) {
  return db.query(`INSERT INTO order_submissions(id,sheet_id,tab_name,purchase_bundle_version,purchase_bundle_application_id,purchase_bundle_hash,purchase_condition_snapshot,purchase_identity_result,purchase_bundle_revision) VALUES($1,'S','T',1,$2,$3,'{}','match',1)`, [uuid(n),app,sha]);
}
module.exports = { fixture, bundle, uuid, sha, migration };
if (require.main === module) {
  test('actual SQL enforces identity, active uniqueness, FK and rollback without tightening legacy status/coordinates', async () => {
    const db=await fixture();
    try {
      await bundle(db);
      await db.query(`UPDATE order_submissions SET deleted_at=NOW() WHERE id=$1`,[uuid(2)]);
      await assert.rejects(bundle(db,3),{code:'23505'});
      await assert.rejects(bundle(db,3,999),{code:'23503'});
      await db.query(`INSERT INTO order_purchase_channels VALUES($1,'naver','n','u','r','p','a',0,'{}')`,[uuid(2)]);
      await assert.rejects(db.query(`INSERT INTO order_purchase_channels(order_submission_id,channel,paid_amount) VALUES($1,'naver',1)`,[uuid(2)]),{code:'23505'});
      for(const [channel,amount] of [['bad',0],['coupang',-1]]) await assert.rejects(db.query(`INSERT INTO order_purchase_channels(order_submission_id,channel,paid_amount) VALUES($1,$2,$3)`,[uuid(2),channel,amount]),{code:'23514'});
      await assert.rejects(db.query('DELETE FROM order_submissions WHERE id=$1',[uuid(2)]),e=>['23503','23001'].includes(e.code));
      const artifact=`INSERT INTO purchase_capture_artifacts(application_id,channel,role,revision,file_id,byte_sha256,extraction_proof_hash,final_input_hash,condition_snapshot_hash,status) VALUES(1,'naver','primary',$1,'f',$2,$2,$2,$2,'staged')`;
      await db.query(artifact,[1,sha]);
      await assert.rejects(db.query(artifact,[2,sha]),{code:'23505'});
      await db.exec(`UPDATE purchase_capture_artifacts SET superseded_at=NOW(),status='superseded'`);
      await db.query(artifact,[2,sha]); // same bytes are not globally unique
      await assert.rejects(db.query(artifact,[0,sha]),{code:'23514'});
      await assert.rejects(db.query(artifact,[3,'bad']),{code:'23514'});
      await assert.rejects(db.query('DELETE FROM campaign_applications WHERE id=1'),e=>['23503','23001'].includes(e.code));
      const review=`INSERT INTO review_submissions(order_submission_id,purchase_channel,evidence_role,evidence_revision,byte_sha256,condition_snapshot_hash) VALUES($1,'naver','review',1,$2,$2)`;
      await db.query(review,[uuid(2),sha]); await db.query(review,[uuid(2),sha]); // multi-photo legacy slots
      const pay=`INSERT INTO payment_batch_items(sheet_id,tab_name,row_index,status,order_submission_id,eligibility_fingerprint) VALUES('S','T',$1,$2,$3,$4)`;
      await db.query(pay,[2,'pending',uuid(2),sha]);
      await assert.rejects(db.query(pay,[3,'paid',uuid(2),sha]),{code:'23505'});
      await db.query(pay,[3,'failed',uuid(2),sha]); await db.query(pay,[4,'cancelled',uuid(2),sha]);
      await assert.rejects(db.query(`INSERT INTO payment_batch_items(sheet_id,tab_name,row_index,status) VALUES('S','T',1,'paid')`),{code:'23505'});
      await assert.rejects(db.query(`INSERT INTO payment_batch_items(status) VALUES('new-status')`),{code:'23514'});
      await db.exec('BEGIN'); await bundle(db,4,3);
      await assert.rejects(db.query(`INSERT INTO order_purchase_channels(order_submission_id,channel,paid_amount) VALUES($1,'bad',1)`,[uuid(4)]),{code:'23514'});
      await db.exec('ROLLBACK');
      assert.equal((await db.query('SELECT count(*)::int n FROM order_submissions WHERE id=$1',[uuid(4)])).rows[0].n,0);
    } finally {await db.close();}
  });
  test('startup preflight registers every additive column and both new tables', () => {
    const src=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
    const vm=require('node:vm'); const ctx={};
    vm.runInNewContext(src.slice(src.indexOf('const REQUIRED_SCHEMA ='),src.indexOf('async function _runOneMigration')).replace('const REQUIRED_SCHEMA','this.schema').replace('const REQUIRED_TABLES','this.tables'),ctx);
    const cols={order_submissions:['purchase_bundle_version','purchase_bundle_application_id','purchase_bundle_hash','purchase_condition_snapshot','purchase_identity_result','purchase_identity_review','purchase_bundle_revision'],review_submissions:['order_submission_id','purchase_channel','evidence_role','evidence_revision','byte_sha256','condition_snapshot_hash','superseded_at'],payment_batch_items:['order_submission_id','eligibility_fingerprint'],order_purchase_channels:['order_submission_id','channel','order_num','user_id','recipient','phone','address','paid_amount','identity_result'],purchase_capture_artifacts:['id','application_id','order_submission_id','channel','role','revision','file_id','byte_sha256','extraction_json','extraction_proof_hash','final_input_hash','condition_snapshot_hash','status','superseded_at','created_by','created_at']};
    for(const [table,columns] of Object.entries(cols)) for(const column of columns) assert.ok(ctx.schema.some(([t,c])=>t===table&&c===column),`${table}.${column}`);
    for(const table of ['order_purchase_channels','purchase_capture_artifacts']) assert.ok(ctx.tables.includes(table),table);
  });
  test('nullable legacy columns cannot form partial bundle/review/payment evidence', async () => {
    const db = await fixture();
    try {
      await assert.rejects(db.query(`UPDATE order_submissions SET purchase_bundle_hash=$1 WHERE id=$2`,[sha,uuid(1)]), {code:'23514'});
      await assert.rejects(db.query(`UPDATE review_submissions SET purchase_channel='naver' WHERE id=$1`,[uuid(11)]), {code:'23514'});
      await assert.rejects(db.query(`UPDATE payment_batch_items SET eligibility_fingerprint=$1 WHERE id=$2`,[sha,uuid(21)]), {code:'23514'});
    } finally { await db.close(); }
  });
  test('215 exists and executes twice without changing legacy rows', async () => {
    assert.ok(fs.existsSync(migration), 'migration 215 is missing');
    const db = await fixture();
    try {
      for (const table of ['order_submissions','review_submissions','payment_batch_items']) {
        const row = (await db.query(`SELECT * FROM ${table} LIMIT 1`)).rows[0];
        for (const [key,value] of Object.entries(row)) if (!['id','sheet_id','tab_name','deleted_at','capture_file_id','capture_file_id_2','orderer','file_id','file_name','reviewer_name','slot_key','batch_id','row_index','status'].includes(key)) assert.equal(value,null,key);
      }
    } finally { await db.close(); }
  });
}
