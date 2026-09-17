'use strict';
const assert=require('assert');
const fs=require('fs');
const {PGlite}=require('@electric-sql/pglite');
const {earningsCandidates}=require('../src/services/reviewEarningsCandidates.service');
const source=fs.readFileSync(require.resolve('../src/routes/reviewer.routes'),'utf8');
const identitySource=source.slice(source.indexOf('function _participantIdentityByOwnerSql'),source.indexOf('function sendReviewerIdentityError'));
const identity=Function(identitySource+';return _participantIdentityByOwnerSql;')();
const route=source.slice(source.indexOf("router.get('/review-earnings'"),source.indexOf("router.get('/my-payments'"));
const templates=[...route.matchAll(/boundedReviewRead\(client => client\.query\(\s*`([\s\S]*?)`,/g)].map(m=>m[1]);
assert.equal(templates.length,3);
const routeRequire=require('module').createRequire(require.resolve('../src/routes/reviewer.routes'));
const sqls=templates.map(t=>Function('earningsCandidates','_participantIdentityByOwnerSql','require','return `'+t+'`;')(earningsCandidates,identity,routeRequire));
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',foreign='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ident='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const uid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const db=new PGlite();
const canon=rows=>rows.map(r=>JSON.stringify(r)).sort();
(async()=>{try{
 await db.exec(`
 CREATE TABLE reviewers(id uuid,phone8 text,sub_accounts jsonb DEFAULT '[]');
 CREATE TABLE reviewer_phone_changes(reviewer_id uuid,old_phone8 text);
 CREATE TABLE reviewer_identities(id uuid,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identity_aliases(identity_id uuid,phone8 text);
 CREATE TABLE review_index(sheet_id text,tab_name text,row_index int,is_submitted boolean,is_submitted2 text,start_date text,row_json jsonb,phone8 text);
 CREATE TABLE campaign_participants(id uuid,order_submission_id uuid,sheet_id text,tab_name text,seq int,owner_reviewer_id uuid,phone8 text,active boolean,deleted_at timestamptz,participant_identity_id uuid,row_json jsonb);
 CREATE TABLE reviewer_participations(sheet_id text,tab_name text,row_index int,lifecycle_status text,review_obligation_status text);
 CREATE TABLE order_submissions(id uuid,sheet_id text,tab_name text,sheet_row int,phone text,owner_reviewer_id uuid,deleted_at timestamptz,campaign_application_id uuid,participant_identity_id uuid,price text,review_fee_snapshot int,delivery_review_fee_mix_snapshot jsonb,submitted_at timestamptz);
 CREATE TABLE campaign_applications(id uuid,order_submission_id uuid,campaign_id text,owner_reviewer_id uuid,owner_phone8 text,phone8 text,participant_identity_id uuid,applied_at timestamptz);
 CREATE TABLE participation_links(sheet_id text,tab_name text,row_index int,phone8 text,owner_reviewer_id uuid,participant_identity_id uuid);
 CREATE TABLE review_closed_targets(sheet_id text,tab_name text,row_index int,order_submission_id uuid,review_status text);
 CREATE TABLE recruit_campaigns(id text,review_fee int,delivery_review_fee_mix jsonb,thumbnail_url text,start_date date);
 `);
 await db.query("INSERT INTO reviewers VALUES ($1,'11112222','[]'),($2,'99998888','[]')",[owner,foreign]);
 await db.query("INSERT INTO reviewer_identities VALUES ($1,$2)",[ident,owner]);
 const owners=[null,owner,foreign];
 // Every owner-priority combination, plus missing participants, application
 // backlinks, legacy links, phone fallbacks, deletion and closed-row cases.
 for(let n=1;n<=162;n++){
  const k=n-1,cpOwner=owners[k%3],osOwner=owners[Math.floor(k/3)%3],appOwner=owners[Math.floor(k/9)%3],plOwner=owners[Math.floor(k/27)%3];
  const sheet='campaign:case'+n,tab='작업'+n,id=uid(n),appId=uid(n+1000),cpId=uid(n+2000),phone=n%2?'11112222':'99998888';
  await db.query(`INSERT INTO order_submissions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'10000',1000,'[]','2026-08-01')`,[id,sheet,tab,n,'010'+phone,osOwner,n%29===0?'2026-08-02':null,n%4===0?null:appId,n%3?ident:null]);
  await db.query(`INSERT INTO campaign_applications VALUES($1,$2,$3,$4,$5,$6,$7,'2026-07-01')`,[appId,id,'case'+n,appOwner,n%5===0?'':phone,phone,ident]);
  if(n%7!==0) await db.query(`INSERT INTO campaign_participants VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{"결제금액":"10000"}')`,[cpId,id,sheet,tab,n,cpOwner,phone,n%19!==0,n%23===0?'2026-08-02':null,n%2?ident:null]);
  if(n%11!==0) await db.query(`INSERT INTO review_index VALUES($1,$2,$3,$4,$5,'2026-08-01',$6,$7)`,[sheet,tab,n,n%3===0,n%5===0?'PAID':null,n%2?'{}':'{"입금":"완료"}',n%13===0?null:phone]);
  await db.query(`INSERT INTO participation_links VALUES($1,$2,$3,$4,$5,$6)`,[sheet,tab,n,phone,plOwner,n%2?ident:null]);
  await db.query(`INSERT INTO recruit_campaigns VALUES($1,1000,'[]','','2026-08-01')`,['case'+n]);
  if(n%17===0)await db.query(`INSERT INTO review_closed_targets VALUES($1,$2,$3,$4,'closed_no_review')`,[sheet,tab,n,id]);
 }
 await db.exec('ALTER TABLE campaign_participants ADD COLUMN is_submitted boolean DEFAULT false');
 const sheetIds=(await db.query('SELECT DISTINCT sheet_id FROM order_submissions')).rows.map(r=>r.sheet_id);
 let comparisons=0,nonempty=0;
 for(const recycled of [false,true]){
  if(recycled){await db.query('INSERT INTO reviewer_phone_changes VALUES($1,$2)',[foreign,'11112222']);await db.query('INSERT INTO reviewer_identities VALUES($1,$2)',[uid(9999),foreign]);await db.query('INSERT INTO reviewer_identity_aliases VALUES($1,$2)',[uid(9999),'11112222']);}
  for(const who of [owner,foreign,null])for(const restrict of [false,true])for(let i=0;i<3;i++){
   const params=i===0?[['11112222'],['%입금%'],who,restrict,ident]:i===1?[['11112222'],sheetIds,who,restrict,ident]:[['11112222'],who,restrict,ident];
   const marker=i===0?'SELECT ri.sheet_id AS':i===1?'SELECT os.sheet_id AS':'SELECT os.id, os.sheet_id AS';
   const baseline=sqls[i].slice(sqls[i].indexOf(marker)).replace('FROM earnings_rows ri','FROM review_index ri').replace('FROM earnings_orders os','FROM order_submissions os');
   const before=await db.query(baseline,params),after=await db.query(sqls[i],params);
   assert.deepStrictEqual(canon(after.rows),canon(before.rows),`query ${i}, owner ${who}, restricted ${restrict}, recycled ${recycled}`);
   comparisons++;if(after.rows.length)nonempty++;
  }
 }
 assert.ok(nonempty>15,'fixture must exercise actual returned amounts');
 // Isolate completion cases from the recycled-phone fixtures above.
 await db.exec('DELETE FROM reviewer_phone_changes; DELETE FROM reviewer_identity_aliases');
 const sheetless=()=>db.query(sqls[2],[['11112222'],owner,false,ident]);
 const indexed=()=>db.query(sqls[0],[['11112222'],['%입금%'],owner,false,ident]);
 assert.equal((await sheetless()).rows.find(r=>r.id===uid(11)).isSubmitted,false,'unsubmitted sheetless order remains pending');
 await db.query('UPDATE campaign_participants SET is_submitted=true WHERE order_submission_id=$1',[uid(11)]);
 assert.equal((await sheetless()).rows.find(r=>r.id===uid(11)).isSubmitted,true,'completed workboard without index supplies completion');
 await db.query('UPDATE campaign_participants SET is_submitted=false WHERE order_submission_id=$1',[uid(11)]);
 await db.query("INSERT INTO reviewer_participations VALUES('campaign:case11','작업11',11,'active','fulfilled')");
 assert.equal((await sheetless()).rows.find(r=>r.id===uid(11)).isSubmitted,true,'fulfilled participation ledger is respected');
 await db.query("UPDATE reviewer_participations SET lifecycle_status='cancelled'");
 assert.equal((await sheetless()).rows.find(r=>r.id===uid(11)).isSubmitted,false,'a replaced participant does not inherit cancelled completion');
 await db.query('UPDATE campaign_participants SET is_submitted=true WHERE order_submission_id=$1',[uid(1)]);
 assert.equal((await indexed()).rows.find(r=>r.rowIndex===1).isSubmitted,true,'workboard completion wins over lagging index false');
 await db.query('UPDATE review_index SET is_submitted=true WHERE row_index=1');
 assert.ok(!(await sheetless()).rows.some(r=>r.id===uid(1)),'completed index suppresses the duplicate sheetless order');
 await db.query('UPDATE campaign_participants SET owner_reviewer_id=$1 WHERE order_submission_id=$2',[foreign,uid(11)]);
 assert.ok(!(await sheetless()).rows.some(r=>r.id===uid(11)),'completion cannot expose another owner order');
 assert.match(route,/status\(503\)\.json\(\{ ok: false, code: 'REVIEW_EARNINGS_DEFERRED'/);
 assert.doesNotMatch(route,/catch \(err\)[\s\S]*grandTotal: 0/,'failed query must not claim zero earnings');
 console.log(`PASS earnings SQL parity: ${comparisons} comparisons on 162 ownership/legacy fixtures; ${nonempty} nonempty results; 7 completion regressions`);
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
