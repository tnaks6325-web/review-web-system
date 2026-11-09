'use strict';
// Execute the production candidate SQL, not a rewritten approximation. No external DB or API.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {isDualBundleSql,dualCaptureCompleteSql}=require('../src/utils/dualCaptureComplete');
const {PGlite}=require('@electric-sql/pglite');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src/routes/reviewer.routes.js'),'utf8');
const candidate=source.slice(source.indexOf("router.get('/my-missing-captures'"));
const query=candidate.match(/const \{ rows \} = await pool\.query\(`([\s\S]*?)`, \[phone8, String\(days\), cutoff\]\)/);
assert(query,'The actual missing-capture candidate SQL must be exercised');
const fixture=fs.readFileSync(path.join(__dirname,'reviewerMissingCapturePg.test.js'),'utf8');
const ddl=fixture.slice(fixture.indexOf('async function schema()')).match(/await pool\.query\(`([\s\S]*?)`\)/)[1].replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
const id='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
(async()=>{
 const db=new PGlite();let passed=0;
 try{
  await db.exec(ddl);
  await db.exec(`INSERT INTO recruit_campaigns(id,title) VALUES ('fictional','가상 동시구매');
    INSERT INTO campaign_applications(id,campaign_id,phone8) VALUES (1,'fictional','12345678');
    INSERT INTO order_submissions(id,sheet_id,tab_name,phone,campaign_application_id)
    VALUES ('${id}','campaign:fictional','campaign:fictional','01012345678',1);`);
  await db.exec(`CREATE TABLE purchase_capture_artifacts(order_submission_id uuid,channel text,role text,status text,file_id text,superseded_at timestamptz)`);
  const actualSql=Function('isDualBundleSql','dualCaptureCompleteSql','return `'+query[1]+'`;')(isDualBundleSql,dualCaptureCompleteSql);
  const run=()=>db.query(actualSql,['12345678','30',null]);
  assert.equal((await run()).rows.length,1,'legacy missing photo still appears even on pre-bundle fixture schema');
  passed++;console.log('PASS legacy missing photo and old schema compatibility');
  await db.exec(`ALTER TABLE order_submissions ADD COLUMN purchase_bundle_version INTEGER;
    UPDATE order_submissions SET purchase_bundle_version=1 WHERE id='${id}';
    INSERT INTO purchase_capture_artifacts VALUES ('${id}','naver','primary','committed','fixture-naver',NULL),('${id}','coupang','primary','committed','fixture-coupang',NULL);`);
  assert.equal((await db.query("SELECT count(*)::int n FROM purchase_capture_artifacts WHERE status='committed'")).rows[0].n,2);
  assert.equal((await run()).rows.length,0,'two committed dual purchase photos must not become a missing legacy photo alert');
  passed++;console.log('PASS saved dual photos excluded from incompatible legacy retry');
  await db.exec(`INSERT INTO order_submissions(id,sheet_id,tab_name,phone,campaign_application_id)
    VALUES ('${second}','campaign:fictional','campaign:fictional','01012345678',1);`);
  const mixed=(await run()).rows;
  assert.equal(mixed.length,1);assert.equal(mixed[0].id,second,'the exclusion must not hide an ordinary missing capture');
  passed++;console.log('PASS ordinary missing photo preserved alongside dual bundle');
  await db.exec(`DELETE FROM purchase_capture_artifacts WHERE channel='coupang'`);
  const incomplete=(await run()).rows;
  assert.equal(incomplete.length,2,'retain the production legacy-cache contract: genuinely incomplete bundles remain visible');
  assert.equal(incomplete.find(x=>x.id===id).dualBundle,true,'old cached screens identify bundles instead of attempting the legacy upload session');
  passed++;console.log('PASS incomplete dual bundle preserves upstream fallback; new authenticated screen is verified separately');
  console.log(`reviewerMissingCaptureDual: ${passed} passed`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
