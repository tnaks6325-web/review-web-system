'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let pw;
try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch(error){if(process.env.PLAYWRIGHT_MODULE)throw error;}
const {start}=require('./helpers/purchaseCaptureBrowserHarness');
const {SINGLE,BUNDLE}=require('./helpers/purchaseCaptureIntegrationFixture');
require('node:test').test('actual connected browser integration: all 12 engine/width/channel cases',{skip:pw?false:'Playwright unavailable; set PLAYWRIGHT_MODULE for local browser acceptance'},async()=>{
 const h=await start(),out=process.env.CAPTURE_E2E_OUT||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'capture-integrated-e2e-'));fs.mkdirSync(out,{recursive:true});
 const snapshots=async()=>Object.fromEntries(await Promise.all(['order_submissions','purchase_capture_artifacts','order_purchase_channels','payment_batch_items','review_submissions'].map(async t=>[t,(await h.db.query(`SELECT to_jsonb(t) v FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows])));
 const before=await snapshots(),results=[];
 try{
  for(const engine of ['chromium','webkit'])for(const width of [390,1280])for(const [orderId,channel,label]of [[SINGLE,'single','일반 시험'],[BUNDLE,'naver','네이버·쿠팡 시험'],[BUNDLE,'coupang','네이버·쿠팡 시험']]){
   const browser=await pw[engine].launch({executablePath:pw[engine].executablePath()});
   const context=await browser.newContext({viewport:{width,height:900}}),blocked=[],featureErrors=[],featureResponses=[];
   await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1'){blocked.push(u.href);return route.abort();}return route.continue();});
   const page=await context.newPage();
   page.on('pageerror',e=>{if(String(e.stack).includes('reviewer-purchase-capture'))featureErrors.push(String(e));});
   page.on('response',r=>{if(r.url().includes('purchase-capture')||r.url().includes('/api/drive/image/'))featureResponses.push({url:r.url(),status:r.status()});});
   try{
    await page.setContent('<meta charset="utf-8"><h1>로컬 시험용 구매사진</h1><p>주문번호 TEST-0001 · 실제 고객 자료가 아닙니다.</p>');
    const photo=await page.screenshot({type:'png'});fs.writeFileSync(path.join(out,'local-proof.png'),photo);for(const id of h.files.keys())h.files.set(id,Buffer.from(photo));
    await page.goto(h.base+'/integrated-preview',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelectorAll('#sectionMissingCapture .rpc-item').length===2);
    const item=page.locator('#sectionMissingCapture .rpc-item').filter({hasText:label}),section=item.locator(`details[data-channel="${channel}"]`);
    const previousPhotos=await section.locator('[data-action="photo"]').count();assert(previousPhotos>=2);
    await section.locator('summary').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('#sectionMissingCapture details[open] img')].every(i=>i.complete&&i.naturalWidth>0));
    await page.locator('#sectionMissingCapture').screenshot({path:path.join(out,`${engine}-${width}-${channel}-before.png`)});
    await section.locator('input[type=file]').setInputFiles({name:'local-proof.png',mimeType:'image/png',buffer:photo});
    await section.locator('[data-action="save"]').waitFor({state:'visible'});
    await section.locator('[data-action="save"]').click();
    await page.waitForFunction(()=>document.querySelector('#sectionMissingCapture .rpc-message').textContent.includes('사진을 접수했어요'));
    assert.equal(await section.locator('[data-action="photo"]').count(),previousPhotos+1);
    const added=(await h.db.query('SELECT check_request_id,file_id FROM purchase_capture_supplements WHERE order_submission_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[orderId])).rows[0];
    assert(added?.check_request_id);assert.equal(h.files.get(added.file_id).length>0,true);
    const req=(await h.db.query('SELECT * FROM purchase_capture_check_requests WHERE id=$1',[added.check_request_id])).rows[0];
    const thread=(await h.db.query('SELECT thread_id FROM cs_messages WHERE id=$1',[req.cs_message_id])).rows[0];
    const staff=await context.newPage();staff.on('pageerror',e=>{if(String(e.stack).includes('reviewer-purchase-capture'))featureErrors.push(String(e));});
    staff.on('response',r=>{if(r.url().includes('purchase-capture')||r.url().includes('/api/drive/image/'))featureResponses.push({url:r.url(),status:r.status()});});
    await staff.goto(h.base+'/staff-preview',{waitUntil:'domcontentloaded'});
    const room=staff.locator(`.cs-room-row[data-tid="${thread.thread_id}"]`);await room.waitFor({state:'visible'});await room.click();
    const card=staff.locator(`[onclick="csOpenPurchaseCaptureCheck('${req.id}')"]`).last();await card.waitFor({state:'visible'});await card.click();
    const dialog=staff.locator('dialog.rpc-dialog');await dialog.locator('.rpc-staff').waitFor();
    await dialog.locator('.rpc-staff textarea').fill('주문번호가 보이도록 사진을 추가해 주세요');
    await dialog.locator('.rpc-staff input[type=checkbox]').check();
    await dialog.locator('[data-action="needs_photo"]').click();
    await staff.waitForFunction(()=>document.querySelector('dialog.rpc-dialog .rpc-message').textContent.includes('보완 사유를 전달'));
    await page.evaluate(()=>window._mountPurchaseCapture(window.CAPTURE_TEST_USER));
    await page.waitForFunction(()=>document.querySelector('#sectionMissingCapture').textContent.includes('주문번호가 보이도록 사진을 추가해 주세요'));
    await page.locator('#sectionMissingCapture').screenshot({path:path.join(out,`${engine}-${width}-${channel}-needs-photo.png`)});
    await dialog.locator('.rpc-staff input[type=checkbox]').check();await dialog.locator('[data-action="confirmed"]').click();
    await staff.waitForFunction(()=>document.querySelector('dialog.rpc-dialog .rpc-message').textContent.includes('사진 확인 완료를 기록'));
    await dialog.screenshot({path:path.join(out,`${engine}-${width}-${channel}-staff.png`)});
    await page.evaluate(()=>window._mountPurchaseCapture(window.CAPTURE_TEST_USER));
    await page.waitForFunction(()=>document.querySelector('#sectionMissingCapture').textContent.includes('사진 확인 완료'));
    await page.locator('#sectionMissingCapture').screenshot({path:path.join(out,`${engine}-${width}-${channel}-confirmed.png`)});
    const last=section.locator('[data-action="photo"]').last();if(!await last.isVisible())await section.locator('summary').click();await last.click();
    await page.waitForFunction(()=>{const img=document.querySelector('dialog.rpc-photo-dialog img');return img&&img.complete&&img.naturalWidth>0;});
    await page.locator('[data-action="close-photo"]').click();
    const measurement=await page.locator('#sectionMissingCapture').evaluate(n=>({viewport:innerWidth,document:document.documentElement.scrollWidth,section:n.getBoundingClientRect().width}));
    assert(measurement.document<=width,JSON.stringify(measurement));assert.equal(featureErrors.length,0,featureErrors.join('\n'));
    assert(featureResponses.every(r=>r.status===200),JSON.stringify(featureResponses.filter(r=>r.status!==200)));
    assert.deepEqual(await snapshots(),before,'Original purchase/review/payment state must not change');
    results.push({engine,width,orderId,channel,previousPhotos,afterPhotos:previousPhotos+1,requestId:req.id,measurement,featureErrors,featureResponses,blockedExternal:blocked.length});
    console.log('PASS actual connected browser',engine,width,channel,'photo → CS card → reason → confirmation → original preservation');
   }catch(error){for(const [i,p]of context.pages().entries())await p.screenshot({path:path.join(out,`${engine}-${width}-${channel}-failure-${i}.png`),fullPage:true}).catch(()=>{});throw error;}
   finally{await browser.close();}
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));assert.equal(results.length,2*2*3);
  console.log('purchaseCaptureBrowserIntegration: 12/12 actual page entrypoint + actual inquiry module + HTTP + SQL + fake Drive passed');
 }finally{await h.close();}
});
