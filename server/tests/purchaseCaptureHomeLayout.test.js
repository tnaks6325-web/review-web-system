'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'../..');
let pw;
try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch(error){if(process.env.PLAYWRIGHT_MODULE)throw error;}
const item={orderSubmissionId:'layout-only',displayName:'화면 확인용 베개커버 블루, 40x60cm',participantName:'가상 리뷰어',channels:[{channel:'single',label:'구매사진',saveState:'saved',reviewState:'not_requested',photos:[],evidenceHash:'local-fixture',capabilities:{canAdd:true,canRequestCheck:true}}]};

test('reviewer home keeps purchase text inside white section without changing dialog spacing',{skip:pw?false:'Playwright unavailable; set PLAYWRIGHT_MODULE for layout acceptance'},async t=>{
 const html=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 const assets=new Map([
  ['/css/reviewer-purchase-capture.css','text/css'],
  ['/css/toss-theme.css','text/css'],
  ['/js/reviewer-purchase-capture.js','text/javascript'],
 ]);
 const server=http.createServer((req,res)=>{
  const pathname=req.url.split('?')[0];
  if(pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
  if(assets.has(pathname)){res.setHeader('Content-Type',assets.get(pathname));return res.end(fs.readFileSync(path.join(root,'frontend',pathname)));}
  res.statusCode=404;res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const engine of ['chromium','webkit']){
   const browser=await pw[engine].launch({executablePath:pw[engine].executablePath()});
   try{
    for(const width of [320,390,440,1280])await t.test(`${engine} ${width}`,async()=>{
     const page=await browser.newPage({viewport:{width,height:820},deviceScaleFactor:2});
     const writes=[];
     try{
      await page.route('**/*',route=>{
       const request=route.request(),url=new URL(request.url());
       if(!request.url().startsWith(base+'/'))return route.abort();
       if(request.method()!=='GET'){writes.push(request.method()+' '+url.pathname);return route.abort();}
       if(url.pathname==='/api/reviewer/purchase-captures')return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,items:[item]})});
       return route.continue();
      });
      await page.goto(base,{waitUntil:'load'});
      await page.addScriptTag({url:base+'/js/reviewer-purchase-capture.js'});
      await page.evaluate(async()=>{
       document.querySelector('#viewLogin').style.display='none';
       document.querySelector('#viewHome').style.display='';
       document.querySelectorAll('.home-section').forEach(n=>n.style.display='none');
       document.querySelector('#sectionMissingCapture').style.display='';
       document.querySelector('#sectionReviewList').style.display='';
       document.querySelector('#greetingText').textContent='리뷰 내역';
       await ReviewerPurchaseCapture.mount({container:'#sectionMissingCapture',user:{name:'가상 리뷰어'},getToken:async()=>'local-layout-only',apiBase:location.origin});
      });
      const measure=()=>page.evaluate(()=>{
       const box=document.querySelector('#sectionMissingCapture').getBoundingClientRect();
       const textRect=selector=>{const range=document.createRange();range.selectNodeContents(document.querySelector(selector));const r=range.getBoundingClientRect();return {left:r.left,right:r.right};};
       return {left:textRect('.rpc-item h3').left-box.left,right:box.right-textRect('.rpc summary span').right,documentWidth:document.documentElement.scrollWidth,width:innerWidth};
      });
      const dimensions=await measure();
      if(process.env.CAPTURE_LAYOUT_OUT){
       fs.mkdirSync(process.env.CAPTURE_LAYOUT_OUT,{recursive:true});
       await page.screenshot({path:path.join(process.env.CAPTURE_LAYOUT_OUT,`${engine}-${width}-closed.png`)});
       fs.writeFileSync(path.join(process.env.CAPTURE_LAYOUT_OUT,`${engine}-${width}.json`),JSON.stringify(dimensions,null,2));
      }
      assert.ok(dimensions.left>=15.5,`product text left inset must be at least 16px: ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.right>=15.5,`status text right inset must be at least 16px: ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.documentWidth<=width,'home must not overflow horizontally');
      await page.locator('.rpc summary').click();
      // 결정 373: 정상 제출 사진은 「사진에 문제가 있나요?」를 눌러야 추가·확인 요청이 보인다 — 펼친 뒤 같은 여백을 잰다.
      assert.equal(await page.locator('[data-action="add"]').isVisible(),false);
      await page.locator('[data-action="problem"]').click();
      assert.equal(await page.locator('[data-action="add"]').isVisible(),true);
      assert.equal(await page.locator('[data-action="request"]').isVisible(),true);
      assert.equal(await page.locator('textarea').isVisible(),true);
      const expanded=await measure();
      assert.ok(expanded.left>=15.5&&expanded.right>=15.5);
      assert.ok(expanded.documentWidth<=width,'expanded actions must not overflow horizontally');
      if(process.env.CAPTURE_LAYOUT_OUT)await page.screenshot({path:path.join(process.env.CAPTURE_LAYOUT_OUT,`${engine}-${width}-open.png`)});
      const otherInset=await page.evaluate(()=>{
       const dialog=document.createElement('div');dialog.className='rpc rpc-dialog';
       const section=document.createElement('section');section.className='rpc-item';dialog.append(section);document.body.append(dialog);
       const padding=getComputedStyle(section).paddingLeft;dialog.remove();return padding;
      });
      assert.equal(otherInset,'0px','staff and reviewer dialogs retain existing item spacing');
      assert.deepEqual(writes,[],'layout acceptance must not submit any data');
     }finally{await page.close();}
    });
   }finally{await browser.close();}
  }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
