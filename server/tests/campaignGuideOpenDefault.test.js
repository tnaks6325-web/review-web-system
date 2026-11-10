'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../frontend/js/campaign-workdetail.js'),'utf8');
test('source: default guide inflow is expanded; review guide remains collapsed',()=>{
 assert.ok(/_foldBox\(inflow,\s*true,\s*'유입 · 가이드유입'\)/.test(source),'guide inflow must start expanded');
 assert.ok(/_foldBox\(review,\s*false,/.test(source),'review guide default must not change');
});
let pw;try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch(e){if(process.env.PLAYWRIGHT_MODULE)throw e;}
test('real HTTP browsers: default, manual toggle, rerender, link and non-v18 preservation',{skip:pw?false:'Set PLAYWRIGHT_MODULE for real browser acceptance'},async()=>{
 const {start}=require('./helpers/campaignGuideOpenPreview');const h=await start();const results=[];
 try{
  for(const engine of ['chromium','webkit'])for(const width of [360,1280]){
   const browser=await pw[engine].launch({executablePath:pw[engine].executablePath()});
   try{for(const kind of ['guide','unit','link','admin','qna']){
    const page=await browser.newPage({viewport:{width,height:900}});const external=[];
    await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==h.base){external.push(u.origin);return route.abort();}return route.continue();});
    try{
     await page.goto(h.base+'/after?case='+kind);await page.waitForSelector('#work .cwd-box');
     const guide=page.locator('details.cwd-fold').filter({hasText:'유입 · 가이드유입'});
     if(kind==='guide'||kind==='unit'){
      assert.equal(await guide.count(),1);assert.equal(await guide.evaluate(n=>n.open),true);assert.equal(await guide.locator('.cwd-body').isVisible(),true);
      await guide.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode())));assert.equal(await guide.locator('img').evaluateAll(imgs=>imgs.every(i=>i.naturalWidth>0)),true);
      assert.match(await guide.innerText(),kind==='unit'?/선택 상품 전용 안내/:/검색 안내/);
      await guide.locator('summary').click();assert.equal(await guide.evaluate(n=>n.open),false);assert.equal(await guide.locator('.cwd-body').isVisible(),false);
      await guide.locator('summary').click();assert.equal(await guide.locator('.cwd-body').isVisible(),true);
      await page.locator('[data-cwd-all]').click();assert.equal(await page.locator('details.cwd-fold').evaluateAll(ds=>ds.every(d=>d.open)),true);
      await page.locator('[data-cwd-all]').click();assert.equal(await guide.evaluate(n=>n.open),false);
      await page.evaluate(()=>CampWorkDetail.renderInto(document.getElementById('work'),previewData,previewOptions));assert.equal(await guide.evaluate(n=>n.open),true);
     }else if(kind==='link'){
      assert.equal(await guide.count(),0);assert.equal(await page.locator('.cwd-landing-box [data-cwd-landing]').isVisible(),true);
     }else if(kind==='admin'){
      assert.equal(await page.locator('details.cwd-fold').count(),0);assert.equal(await page.locator('.cwd-v18').count(),0);
     }else assert.equal(await guide.count(),0);
     if(kind!=='admin'){
      assert.equal(await page.locator('details.cwd-fold').filter({hasText:'특이사항'}).evaluate(n=>n.open),true);
      assert.equal(await page.locator('details.cwd-fold').filter({hasText:'리뷰 가이드'}).evaluate(n=>n.open),false);
     }
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(external,[]);
     results.push({engine,width,kind,passed:true});
    }finally{await page.close();}
   }}finally{await browser.close();}
  }
  assert.equal(results.length,2*2*5);
  if(process.env.CAMPAIGN_GUIDE_RESULT)fs.writeFileSync(process.env.CAMPAIGN_GUIDE_RESULT,JSON.stringify(results,null,2));
  console.log('Real browser cases passed:',results.length);
 }finally{await h.close();}
});
