'use strict';
// 읽기 표시만: 가짜 자료 + 메모리 PostgreSQL. 외부 연결/운영 자료 사용 없음.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');
(async () => {
  let passed = 0;
  const test = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE recruit_campaigns(id TEXT PRIMARY KEY,title TEXT,thumbnail_url TEXT,manager TEXT,linked_tab_name TEXT,work_detail JSONB,archived_at TIMESTAMPTZ);
    CREATE TABLE campaign_options(campaign_id TEXT,opt_key TEXT,status TEXT,pay_amount INT,thumbnail_url TEXT);
    CREATE TABLE order_submissions(id TEXT PRIMARY KEY,campaign_application_id INT,orderer TEXT,phone TEXT,capture_flags JSONB);
    CREATE TABLE campaign_applications(id INT PRIMARY KEY,campaign_id TEXT,order_submission_id TEXT,applicant_name TEXT,applicant_phone TEXT,applied_at TIMESTAMPTZ);
    CREATE TABLE reviewer_event_logs(order_submission_id TEXT,event_type TEXT,context JSONB);
  `);
  await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/194_campaign_price_reports.sql'),'utf8'));
  const calls = [];
  const P = {query: (sql,args) => { calls.push(sql); return db.query(sql,args); }};
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = {id:poolPath,filename:poolPath,loaded:true,exports:P};
  const svc = require('../src/services/campaignPriceReport.service');
  await db.exec(`
    INSERT INTO recruit_campaigns VALUES ('c','가짜 공고','','','','{"payAmount":25000}',NULL);
    INSERT INTO order_submissions VALUES
      ('o1',1,'주문 가명','010-1111-2222','{"flags":[{"code":"price_diff","expected":25000,"paid":43000}]}'),
      ('o2',NULL,'직접 가명','01033334444',NULL),
      ('o3',NULL,'노출 금지','01099998888','{"flags":[{"code":"product_differs"}]}'),
      ('o4',NULL,'뒤 여덟자리','55556666',NULL);
    INSERT INTO campaign_applications VALUES
      (1,'c','o1','신청 가명','01011112222',NOW()),
      (2,'c','o1','중복 신청','01011112222',NOW()),
      (3,'c','o3','다른 사람','01099998888',NOW()),
      (4,'c','unrelated','연결 안 됨','01055556666',NOW());
    INSERT INTO reviewer_event_logs VALUES
      ('o1','order_canceled_by_reviewer','{"reasonKey":"price"}'),
      ('o1','order_canceled_by_reviewer','{"reasonKey":"price"}'),
      ('o2','order_canceled_by_reviewer','{"reasonKey":"price"}'),
      ('o3','order_canceled_by_reviewer','{"reasonKey":"personal"}');
    INSERT INTO campaign_price_reports(campaign_id,opt_key,order_submission_id,reporter,created_at) VALUES
      ('c','','o1','11112222','2026-10-20T01:02:00Z'),
      ('c','','o2','33334444','2026-10-21T01:02:00Z'),
      ('c','','o3','55556666','2026-10-22T01:02:00Z'),
      ('c','','o4','55556666','2026-10-23T01:02:00Z'),
      ('c','','missing','','2026-10-24T01:02:00Z');
    INSERT INTO campaign_price_alerts(campaign_id,opt_key,report_count) VALUES ('c','',4);
  `);
  await test('기존 건수·이력 계약 보존 + 신고자 별도 배열과 정확한 주문 결합', async () => {
    const card = await svc.priceReportsForCampaign(P,'c');
    assert.deepEqual(card.open,[{optKey:'',reports:4}]);
    assert.deepEqual(card.history,[]);
    assert.equal(card.reporters.length,5);
    const first = card.reporters.find(r=>r.orderSubmissionId==='o1');
    assert.equal(first.name,'신청 가명');
    assert.equal(first.phone,'01011112222');
    assert.equal(new Date(first.reportedAt).toISOString(),'2026-10-20T01:02:00.000Z');
    assert.deepEqual(first.sources,['capture_price_check','reviewer_price_cancel']);
    assert.equal(first.routeConfirmed,false);
    assert.equal(first.evidenceLevel,'record_evidence');
    assert.equal(first.expectedAmount,25000); assert.equal(first.paidAmount,43000);
    assert.match(first.reason,/금액 차이 검사/); assert.match(first.reason,/직접 가격 신고/);
  });
  await test('직접 신고만/미확인·다른 번호·전체번호 없음·주문 없음은 추정하지 않음', async () => {
    const rows = (await svc.priceReportsForCampaign(P,'c')).reporters;
    const direct = rows.find(r=>r.orderSubmissionId==='o2');
    assert.deepEqual(direct.sources,['reviewer_price_cancel']); assert.equal(direct.name,'직접 가명');
    for (const id of ['o3','o4','missing']) {
      const r = rows.find(x=>x.orderSubmissionId===id);
      assert.equal(r.phone,null); assert.equal(r.name,null);
      assert.deepEqual(r.sources,[]); assert.equal(r.evidenceLevel,'unknown');
      assert.equal(r.reason,'신고 경로 확인 안 됨'); assert.equal(r.expectedAmount,null);
    }
  });
  await test('팝업도 공통 조회 사용 · 일괄 1회 · 읽기만 · 알림 수/현재금액 불변', async () => {
    calls.length=0;
    const items=(await svc.listOpenAlerts({pool:P})).items;
    assert.equal(items[0].reporters.length,5); assert.equal(items[0].reportCount,4); assert.equal(items[0].currentAmount,25000);
    assert.equal(calls.filter(s=>s.includes('r.order_submission_id AS')).length,1);
    assert.ok(calls.every(s=>/^\s*SELECT/.test(s)));
  });
  await test('상세조회 실패는 null이며 기존 건수·금액은 보존', async () => {
    const bad={query:(s,p)=>s.includes('r.order_submission_id AS')?Promise.reject(new Error('fake failure')):P.query(s,p)};
    const card=await svc.priceReportsForCampaign(bad,'c');
    assert.equal(card.reporters,null); assert.equal(card.open[0].reports,4);
    const items=(await svc.listOpenAlerts({pool:bad})).items;
    assert.equal(items[0].reporters,null); assert.equal(items[0].currentAmount,25000);
  });
  await test('자동 검사 단독(price_over) · 금액 0과 모름 구분 · 정리/마감된 신고 제외 · 다른 상품/공고 분리',async()=>{
    await db.exec(`
      INSERT INTO recruit_campaigns VALUES ('other','다른 가짜 공고','','','','{"payAmount":9000}',NULL);
      INSERT INTO campaign_options VALUES ('other','살아 있음','active',9000,''),('other','닫힘','closed',9000,'');
      INSERT INTO order_submissions VALUES ('over',NULL,'자동 가명','01077778888','{"flags":[{"code":"price_over","expected":0,"paid":null}]}');
      INSERT INTO campaign_price_reports(campaign_id,opt_key,order_submission_id,reporter) VALUES
        ('other','살아 있음','over','77778888'),('other','닫힘','closed',''),('other','','whole','');
      INSERT INTO campaign_price_reports(campaign_id,opt_key,order_submission_id,reporter,cleared_at) VALUES ('other','살아 있음','cleared','',NOW());
      INSERT INTO campaign_price_alerts(campaign_id,opt_key,report_count) VALUES ('other','살아 있음',2);
    `);
    const card=await svc.priceReportsForCampaign(P,'other');
    assert.equal(card.reporters.length,1);
    assert.deepEqual(card.reporters[0].sources,['capture_price_check']);
    assert.equal(card.reporters[0].expectedAmount,0);assert.equal(card.reporters[0].paidAmount,null);
    calls.length=0;
    const items=(await svc.listOpenAlerts({pool:P})).items;
    assert.equal(items.find(x=>x.campaignId==='other').reporters.length,1);
    assert.equal(items.find(x=>x.campaignId==='c').reporters.length,5);
    assert.equal(calls.filter(s=>s.includes('r.order_submission_id AS')).length,1);
  });
  const popupSource=fs.readFileSync(path.join(__dirname,'../../frontend/js/price-alert-prompt.js'),'utf8');
  const deskSource=fs.readFileSync(path.join(__dirname,'../../frontend/workdesk.html'),'utf8');
  const rowSource=deskSource.slice(deskSource.indexOf('function _cndPriceRow(cd){'),deskSource.indexOf('async function _cndSale(i){'));
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fakeReporter={name:'<img src=x onerror=bad()>',phone:'01012345678',reportedAt:'2026-10-20T01:02:00Z',reason:'<script>bad()</script>',optKey:'<b>옵션</b>',expectedAmount:25000,paidAmount:43000};
  await test('조건 카드: 작은 표 · 전체번호 · 시간 · 이유/당시 금액 · XSS · 실패/구서버 · 내부권한',async()=>{
    const ctx={STATE:{role:'staff'},esc}; vm.createContext(ctx);vm.runInContext(rowSource+';this.render=_cndPriceRow;',ctx);
    const cd={campaignId:'c',priceReports:{open:[{optKey:'',reports:1}],history:[],reporters:[fakeReporter]}};
    const html=ctx.render(cd);
    assert.match(html,/<table/);assert.match(html,/overflow-x:auto/);assert.match(html,/01012345678/);
    assert.match(html,/25,000원/);assert.match(html,/43,000원/);assert.match(html,/10\/20/);
    assert.match(html,/당시 신고 경로를 확정/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.ok(!html.includes('<script>'));
    cd.priceReports.reporters=null;assert.match(ctx.render(cd),/불러오지 못/);
    cd.priceReports=null;assert.match(ctx.render(cd),/불러오지 못/);
    delete cd.priceReports;assert.equal(ctx.render(cd),'');
    cd.priceReports={open:[],history:[],reporters:[fakeReporter]};
    for(const role of ['advertiser','reviewer','unknown']) {ctx.STATE.role=role;assert.equal(ctx.render(cd),'');}
    for(const role of ['master','admin','staff']) {ctx.STATE.role=role;assert.match(ctx.render(cd),/01012345678/);}
  });
  await test('팝업: 표/실패표시 · 취소 단정 제거 · 개인정보 저장·컴퓨터알림 미추가',async()=>{
    const nodes=[];
    const el=()=>({id:'',innerHTML:'',setAttribute(){},addEventListener(){},remove(){nodes.splice(nodes.indexOf(this),1);},contains(){return false;}});
    const saved=[];const store={getItem:()=>null,setItem:(k,v)=>saved.push(v),removeItem(){}};
    const ctx={window:{},document:{getElementById:id=>nodes.find(x=>x.id===id),createElement:el,body:{appendChild:x=>nodes.push(x)},head:{appendChild(){}}},sessionStorage:store,localStorage:store,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},console};
    vm.createContext(ctx);vm.runInContext(popupSource,ctx);
    const pa=ctx.window.PriceAlertPrompt;
    pa.start({api:async()=>({ok:true,items:[]}),name:'가짜 직원'});
    pa._state.items=[{id:1,title:'가짜 공고',reportCount:2,reporters:[fakeReporter]}];pa._render(true);
    let html=nodes.find(x=>x.id==='paOv').innerHTML;
    assert.match(html,/<table/);assert.match(html,/01012345678/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
    assert.match(html,/직접 가격 신고/);assert.match(html,/금액 차이 검사/);assert.match(html,/당시 신고 경로를 확정/);
    assert.ok(!html.includes('로 주문을 취소했어요')); assert.ok(!html.includes('모두 취소했어요'));
    pa._state.items[0].reporters=null;pa._render(true);assert.match(nodes.find(x=>x.id==='paOv').innerHTML,/불러오지 못/);
    assert.ok(saved.every(x=>!x.includes('01012345678')&&!x.includes('onerror')));
    const notify=popupSource.slice(popupSource.indexOf('function notifyNew()'),popupSource.indexOf('async function load('));
    assert.ok(!/reporters|reportedAt|\.phone|\.reason/.test(notify));
    pa.stop();
  });
  await db.close();
  console.log(`priceReporters: ${passed}개 통과`);
})().catch(e=>{console.error(e);process.exitCode=1;});
