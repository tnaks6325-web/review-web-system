'use strict';
for(const key of ['DATABASE_URL','DATABASE_PUBLIC_URL','PGTEST_URL'])process.env[key]='';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
if(!process.env.PGLITE_MODULE)throw Error('Embedded PostgreSQL required');
const {PGlite}=require(process.env.PGLITE_MODULE);
const source=fs.readFileSync(path.join(__dirname,'../src/services/search.service.js'),'utf8').replace(/\r\n/g,'\n');
function functionSource(name){const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}',start)+2;return source.slice(source.slice(start-6,start)==='async '?start-6:start,end);}
const identitySql=Function('return ('+functionSource('_participantIdentityByOwnerSql')+')')();
const open=Function('return '+source.match(/const OPEN_REVIEW_COND = (`[\s\S]*?`);/)[1])();
let captured;
const load=Function('pool','reviewObligation','OPEN_REVIEW_COND','_participantIdentityByOwnerSql','return ('+functionSource('_loadOwnerReviewRows')+')')(
 {query:async(sql,params)=>{captured={sql,params};return{rows:[]};}},require('../src/services/reviewObligation.service'),open,identitySql);
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const identity='cccccccc-cccc-4ccc-8ccc-cccccccccccc',otherIdentity='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const phone='12345678',otherPhone='87654321';
let pg,n=0,checks=0;
const q=(sql,args=[])=>pg.query(sql,args);
async function seed(o={}){
 const id=++n,cp='10000000-0000-4000-8000-'+String(id).padStart(12,'0'),order='20000000-0000-4000-8000-'+String(id).padStart(12,'0');
 await q(`INSERT INTO review_index VALUES($1,'s','t',$1,$2,$3,DATE '2026-01-01'+$1::integer)`,[id,o.riPhone===undefined?otherPhone:o.riPhone,!!o.submitted]);
 if(o.cp!==false)await q(`INSERT INTO campaign_participants VALUES($1,'s','t',$2,$3,$4,$5,$6,$7,$8,$9)`,
  [cp,id,o.cpOwner||null,o.cpPhone===undefined?otherPhone:o.cpPhone,o.order?order:null,o.cpIdentity||null,o.active!==false,o.deleted?new Date():null,!!o.submitted]);
 if(o.order)await q('INSERT INTO order_submissions VALUES($1,$2,$3,$4,$5)',[order,o.osOwner||null,o.appLink==='direct'?'app-'+id:null,o.osIdentity||null,o.orderDeleted?new Date():null]);
 if(o.appLink)await q('INSERT INTO campaign_applications VALUES($1,$2,$3,$4,$5,now())',['app-'+id,o.caOwner||null,o.caPhone||null,o.caIdentity||null,o.appLink==='backlink'?order:null]);
 if(o.link)await q("INSERT INTO participation_links VALUES('s','t',$1,$2,$3,$4)",[id,o.plOwner||null,o.plPhone||null,o.plIdentity||null]);
 return id;
}
async function compare(who=owner,phones=[phone],submitted=true,subIdentity=null,sub=false){
 await load('ri.id,ri.row_index,COALESCE(cp.is_submitted,ri.is_submitted) AS submitted',who,phones,submitted,subIdentity,sub);
 const optimized=captured.sql;
 assert.match(optimized,/WITH owner_candidate_coordinates AS MATERIALIZED/);
 const baseline=optimized.slice(optimized.indexOf('\n     SELECT ')+1).replace(/\n       JOIN owner_candidate_coordinates candidate\n         ON candidate.sheet_id=ri.sheet_id AND candidate.tab_name=ri.tab_name AND candidate.row_index=ri.row_index/,'');
 assert.ok(!baseline.includes('owner_candidate_coordinates'));
 const before=(await q(baseline,captured.params)).rows,after=(await q(optimized,captured.params)).rows;
 assert.deepEqual(after,before,'Candidate narrowing changed visibility/order');checks++;return after;
}
(async()=>{pg=new PGlite();try{
 await pg.exec(`CREATE TABLE reviewers(id uuid PRIMARY KEY,phone8 text,sub_accounts jsonb DEFAULT '[]');
 CREATE TABLE review_index(id integer PRIMARY KEY,sheet_id text,tab_name text,row_index integer,phone8 text,is_submitted boolean,start_date date);
 CREATE TABLE tab_configs(sheet_id text,tab_name text);
 CREATE TABLE campaign_participants(id uuid PRIMARY KEY,sheet_id text,tab_name text,seq integer,owner_reviewer_id uuid,phone8 text,order_submission_id uuid,participant_identity_id uuid,active boolean,deleted_at timestamptz,is_submitted boolean);
 CREATE TABLE order_submissions(id uuid PRIMARY KEY,owner_reviewer_id uuid,campaign_application_id text,participant_identity_id uuid,deleted_at timestamptz);
 CREATE TABLE campaign_applications(id text PRIMARY KEY,owner_reviewer_id uuid,owner_phone8 text,participant_identity_id uuid,order_submission_id uuid,applied_at timestamptz);
 CREATE TABLE participation_links(sheet_id text,tab_name text,row_index integer,owner_reviewer_id uuid,phone8 text,participant_identity_id uuid);
 CREATE TABLE reviewer_phone_changes(old_phone8 text,reviewer_id uuid);
 CREATE TABLE reviewer_identities(id uuid,owner_reviewer_id uuid);
 CREATE TABLE reviewer_identity_aliases(phone8 text,identity_id uuid);
 CREATE TABLE reviewer_participations(sheet_id text,tab_name text,row_index integer,lifecycle_status text,review_obligation_status text);
 CREATE TABLE review_closed_targets(sheet_id text,tab_name text,row_index integer,review_status text);
 INSERT INTO tab_configs VALUES('s','t');`);
 await q('INSERT INTO reviewers(id,phone8) VALUES($1,$3),($2,$4)',[owner,other,phone,otherPhone]);
 const yes=[],no=[];
 yes.push(await seed({cpOwner:owner,order:true,osOwner:other,link:true,plOwner:other}));
 no.push(await seed({cpOwner:other,cpPhone:phone,order:true,osOwner:owner,riPhone:phone}));
 yes.push(await seed({order:true,osOwner:owner}));
 yes.push(await seed({order:true,appLink:'direct',caOwner:owner}));
 yes.push(await seed({order:true,appLink:'backlink',caOwner:owner}));
 yes.push(await seed({order:true,appLink:'backlink',caPhone:phone}));
 yes.push(await seed({cpPhone:null,link:true,plOwner:owner}));
 yes.push(await seed({cpPhone:phone}));
 yes.push(await seed({cp:false,riPhone:phone}));
 yes.push(await seed({cp:false,riPhone:null,link:true,plPhone:phone}));
 no.push(await seed({cp:false,riPhone:otherPhone,link:true,plPhone:phone}));
 no.push(await seed({cpPhone:otherPhone,link:true,plOwner:owner}));
 yes.push(await seed({cpOwner:owner,cpIdentity:identity}));
 no.push(await seed({cp:false,riPhone:phone,link:true,plOwner:other}));
 let found=(await compare()).map(r=>r.id);
 for(const id of yes)assert.ok(found.includes(id),'Missing ownership source '+id);
 for(const id of no)assert.ok(!found.includes(id),'Other-owner row disclosed '+id);
 const owners=[null,owner,other],phones=[null,phone,otherPhone];
 for(let i=0;i<180;i++)await seed({cp:i%11!==0,cpOwner:owners[i%3],cpPhone:phones[Math.floor(i/3)%3],riPhone:phones[Math.floor(i/9)%3],
  order:i%2===0,osOwner:owners[Math.floor(i/7)%3],appLink:i%4===0?'direct':i%4===2?'backlink':null,
  caOwner:owners[Math.floor(i/5)%3],caPhone:phones[i%3],link:i%2===1,plOwner:owners[Math.floor(i/4)%3],plPhone:phones[i%3],
  cpIdentity:i%3===0?identity:null,osIdentity:i%4===0?otherIdentity:null,caIdentity:identity,plIdentity:otherIdentity,
  active:i%17!==0,deleted:i%19===0,orderDeleted:i%23===0,submitted:i%2===0});
 for(const who of [owner,other])for(const include of [true,false])for(const sub of [false,true])for(const selectedIdentity of [null,identity]){
  await compare(who,[who===owner?phone:otherPhone],include,selectedIdentity,sub);
 }
 await q('INSERT INTO reviewer_phone_changes VALUES($1,$2)',[phone,other]);await compare();
 await q('INSERT INTO reviewer_identities VALUES($1,$2)',[otherIdentity,other]);
 await q('INSERT INTO reviewer_identity_aliases VALUES($1,$2)',[phone,otherIdentity]);await compare();
 await q('UPDATE reviewers SET sub_accounts=$2 WHERE id=$1',[other,JSON.stringify([{phone:'010'+phone}])]);await compare();
 await q("INSERT INTO review_closed_targets VALUES('s','t',$1,'closed_no_review')",[yes[0]]);await compare();
 await q("INSERT INTO reviewer_participations VALUES('s','t',$1,'active','fulfilled')",[yes[1]]);await compare(owner,[phone],false);
 for(let i=0;i<450;i++)await seed({cpOwner:owner,cpPhone:phone,submitted:i%2===0});
 assert.equal((await compare()).length,400);await compare(owner,[phone],false,identity,true);
 console.log('PASS owner query equivalence: '+checks+' comparisons, '+n+' synthetic rows; all ownership sources, aliases, sub-account scope, completion, closure, and 400-row cap');
 }finally{await pg.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
