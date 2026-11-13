'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch(e){if(process.env.PLAYWRIGHT_MODULE)throw e;}
const root=path.resolve(__dirname,'../..');
const photo='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=';
for(const engine of ['chromium','webkit'])test(engine+' normal saved photo needs no check; explicit supplement consent is unchecked',{skip:!pw},async()=>{
 const server=http.createServer((q,r)=>{const p=q.url.split('?')[0];if(p==='/'){r.setHeader('Content-Type','text/html');return r.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/frontend/css/reviewer-purchase-capture.css"><div id="root"></div><script src="/frontend/js/reviewer-purchase-capture.js"></script>');}if(p.startsWith('/api/drive/image/')){r.setHeader('Content-Type','image/png');return r.end(Buffer.from(photo,'base64'));}r.setHeader('Content-Type',p.endsWith('.css')?'text/css':'text/javascript');r.end(fs.readFileSync(path.join(root,p)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await pw[engine].launch({executablePath:pw[engine].executablePath()});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}});const external=[];
  await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async base64=>{
   window.writes=[];window.fixture={orderSubmissionId:'test-order',displayName:'로컬 가상 구매',participantName:'가상 리뷰어',channels:[{channel:'single',label:'구매사진',photos:[{id:'original',fileId:'original-photo'}],evidenceHash:'original-hash',saveState:'saved',reviewState:'not_requested',request:null,capabilities:{canAdd:true,canRequestCheck:true,canSaveWithoutCheck:true}}]};
   window.ImageShrink={fromFile:async()=>({base64,mime:'image/png'})};
   window.fetch=async(url,opts={})=>{if(opts.method==='POST'){writes.push({url,body:JSON.parse(opts.body)});fixture.channels[0].photos.push({id:'extra',fileId:'extra-photo',isSupplement:true});fixture.channels[0].evidenceHash='new-hash';}return {ok:true,status:200,json:async()=>structuredClone({ok:true,items:[fixture],item:fixture,request:null})};};
   window.mount=()=>ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{id:'fake-owner'},getToken:async()=> 'fake-token'});await mount();
  },photo);
  const section=page.locator('[data-channel="single"]');
  assert.match(await section.locator('summary').innerText(),/구매사진 제출 완료/);
  assert.doesNotMatch(await section.locator('summary').innerText(),/확인 요청 전/);
  await section.locator('summary').click();
  assert.equal(await section.locator('[data-action="request"]').isVisible(),false);
  assert.equal(await section.locator('textarea').isVisible(),false);
  await section.getByRole('button',{name:'사진에 문제가 있나요?',exact:true}).click();
  assert.equal(await section.locator('[data-action="request"]').isVisible(),true);
  await section.locator('input[type=file]').setInputFiles({name:'local.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
  const consent=section.getByRole('checkbox',{name:'사진 저장 후 담당자에게 확인 요청'});await consent.waitFor();assert.equal(await consent.isChecked(),false);
  await section.locator('[data-action="save"]').click();
  await page.waitForFunction(()=>window.writes.length===1&&!document.querySelector('[data-action="save"]'));
  assert.equal((await page.evaluate(()=>writes[0])).body.requestCheck,false);
  assert.doesNotMatch(await page.locator('.rpc-message').innerText(),/담당자 확인을 기다려/);
  assert.equal(await page.evaluate(()=>writes.some(w=>w.url.endsWith('/check-requests'))),false);
  await page.evaluate(async()=>{fixture.channels[0].reviewState='needs_photo';fixture.channels[0].reason='주문번호가 필요해요';await mount();});
  assert.equal(await section.locator('[data-action="add"]').isVisible(),true);
  assert.equal(await section.locator('[data-action="request"]').isVisible(),true);
  assert.match(await section.innerText(),/주문번호가 필요해요/);
  await section.locator('input[type=file]').setInputFiles({name:'local2.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
  await section.getByRole('checkbox',{name:'사진 저장 후 담당자에게 확인 요청'}).check();
  await section.locator('[data-action="save"]').click();await page.waitForFunction(()=>window.writes.length===2&&!document.querySelector('[data-action="save"]'));
  assert.equal((await page.evaluate(()=>writes[1])).body.requestCheck,true);
  await page.evaluate(async()=>{fixture.channels[0].capabilities.canSaveWithoutCheck=undefined;await mount();});
  await section.locator('input[type=file]').setInputFiles({name:'old-server.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
  await section.locator('[data-action="save"]').waitFor();assert.equal(await section.locator('[data-action="save"]').isDisabled(),true);
  await page.evaluate(async()=>{
   fixture.channels[0].request={id:'old-card',status:'pending',note:'예전 확인 요청'};
   fixture.channels[0].evidenceChanged=true;
   window.fetch=async()=>({ok:true,status:200,json:async()=>structuredClone({ok:true,item:fixture,request:fixture.channels[0].request})});
   await PurchaseCaptureStaff.open({requestId:'old-card',getToken:async()=> 'fake-staff-token'});
  });
  const staff=page.locator('dialog.rpc-dialog');
  assert.match(await staff.innerText(),/확인 요청 뒤 사진이 바뀌었어요/);
  assert.equal(await staff.locator('[data-action="confirmed"]').count(),0);
  assert.equal(await staff.locator('[data-action="needs_photo"]').count(),0);
  assert.equal(await staff.locator('[data-action="photo"]').count(),3);
  assert.deepEqual(external,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
