'use strict';
// Actual local HTTP frontend + fake API responses. No production credentials or external network.
// NODE_PATH=/Users/sooman/motion-reel/node_modules node scripts/verify-home-manager-ui.cjs
const {chromium}=require('playwright');
const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'../frontend');
const out=process.env.HOME_MANAGER_CAPTURE_DIR||path.join(process.env.HOME,'.hermes/cache/scratch/home-manager-captures');fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost'),f=path.resolve(root,'.'+(u.pathname==='/'?'/workdesk.html':u.pathname));if(!f.startsWith(root+path.sep)||!fs.existsSync(f)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(f));});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const results=[];
 try{for(const [device,viewport] of [['pc',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,deviceScaleFactor:1});const page=await context.newPage();const errors=[],writes=[],dialogs=[];let fail=false,delay=false;
  let question={id:991,kind:'manager_assignment',canAnswer:true,status:'open',manager:'',facts:{workOrderId:'FAKE-home-order',title:'가짜상품 담당자 확인',sheetId:'FAKE-home-sheet',tabName:'가짜 작업',baseVersion:0},lines:[{key:'manager',text:'작업담당이 미지정입니다. 만두·망고 중 누가 맡을까요?'}],answers:{}};
  const bank={id:992,kind:'bank_cluster',status:'open',manager:'망고',facts:{bank:'hana',cluster:{date:'10/30',time:'12:00',rowCount:1,total:1000},short:[],outside:[{key:'out:1000',amount:1000,count:1}]},lines:[{key:'out:1000',text:'가짜 통장 확인 1,000원 × 1건'}],answers:{}};
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss();});
  await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.pathname.startsWith('/api/')){
   let body={ok:true,items:[],rows:[],tabs:[],data:[],count:0,counts:{submitted:0}};
   if(u.pathname==='/api/trackb/ops-checks')body={ok:true,items:[bank]};
   if(u.pathname==='/api/trackb/ops-checks/managers')body={ok:true,items:question.status==='open'?[question]:[],hasMore:false,nextAfter:991};
   if(u.pathname.endsWith('/manager-answer')){const b=req.postDataJSON();writes.push(b);assert.equal(b.baseVersion,0);if(delay)await new Promise(r=>setTimeout(r,250));if(fail)body={ok:false,error:'가짜 저장 실패 — 다시 선택해 주세요.'};else{question={...question,status:'done',localSaved:true,remoteSync:'pending',answers:{manager:{choice:b.choice}}};body={ok:true,item:question};}}
   await route.fulfill({json:body});return;
  }if(u.origin!==origin){await route.abort();return;}await route.continue();});
  await page.goto(origin+'/workdesk.html');await page.waitForFunction(()=>typeof renderHomeView==='function');
  await page.evaluate(()=>{STATE.role='master';STATE.name='로컬 시험관리자';STATE.view='home';renderShell();renderHomeView();});
  await page.waitForFunction(()=>Array.isArray(STATE.tckManagerItems)&&STATE.tckManagerItems.length===1);
  async function snap(name){await page.waitForTimeout(350);await page.evaluate(()=>{document.getElementById('localFixtureCaption')?.remove();const e=document.createElement('div');e.id='localFixtureCaption';e.textContent='로컬 가짜 데이터 · 운영 저장·전송 없음';e.style.cssText='position:fixed;left:8px;right:8px;'+(innerWidth<=720?'top:100px;':'bottom:8px;')+'z-index:999999;background:#fff3f3;color:#9f1239;border:2px solid #ef4444;padding:8px;font:600 12px sans-serif;pointer-events:none';document.body.append(e);});const f=path.join(out,`${device}-${name}.png`);await page.screenshot({path:f,fullPage:!(device==='mobile'&&['question-open','save-failed'].includes(name))});return f;}
  const captures=[await snap('home-unassigned')];
  await page.evaluate(()=>{STATE.tckItems=null;STATE.tckError='가짜 통장 조회 실패';_tckPaint();});
  assert.ok((await page.locator('#tckHomeMount').innerText()).includes('통장 확인 항목을 불러오지 못했습니다'));
  assert.ok((await page.locator('#tckHomeMount').innerText()).includes('가짜상품 담당자 확인'));
  captures.push(await snap('partial-bank-failure'));
  await page.evaluate(bank=>{STATE.tckItems=[bank];STATE.tckError='';_tckPaint();},bank);
  if(device==='mobile'){assert.equal(await page.locator('#tckHomeMount .tck-row').count(),2);await page.locator('#tckHomeMount .tck-row').first().click();await page.locator('#tckSheet.on').waitFor();captures.push(await snap('question-open'));}
  const scope=device==='mobile'?page.locator('#tckSheet'):page.locator('#tckHomeMount');
  fail=true;await scope.getByRole('button',{name:'만두',exact:true}).click();await page.waitForFunction(()=>!Object.keys(STATE.tckManagerSaving||{}).length);assert.equal(question.status,'open');captures.push(await snap('save-failed'));fail=false;
  delay=true;await scope.getByRole('button',{name:'만두',exact:true}).click();assert.ok(await scope.getByRole('button',{name:'만두',exact:true}).isDisabled());
  await page.waitForFunction(()=>STATE.tckManagerItems[0].status==='done');assert.equal(writes.length,2);assert.equal(question.answers.manager.choice,'mandu');
  assert.ok(await page.locator('#tckHomeMount').innerText().then(t=>t.includes('리뷰웹 저장 완료')&&t.includes('인트라넷 전달 대기')));
  if(device==='mobile')assert.equal(await page.locator('#tckSheet.on').count(),0);
  captures.push(await snap('saved-pending'));
  // Payment rendering never exposes home manager questions; bank question remains unchanged.
  assert.equal(await page.evaluate(()=>_tckHtml('payment').includes('가짜상품 담당자 확인')),false);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,device+' horizontal overflow');
  assert.deepEqual(errors,[]);results.push({device,viewport,origin,errors,writes,overflow,captures});await context.close();
 }}finally{await browser.close();server.close();}
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);server.close();process.exit(1);});
