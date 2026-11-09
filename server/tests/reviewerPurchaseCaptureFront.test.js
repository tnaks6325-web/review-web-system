'use strict';
const {test:nodeTest}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'../..');
const source=path.join(root,'frontend/js/reviewer-purchase-capture.js');
let pw;
try { pw=require(process.env.PLAYWRIGHT_MODULE||'playwright'); }
catch(error) {
 if(process.env.PLAYWRIGHT_MODULE) throw error;

}
// VM contract always runs. Browser coverage is explicitly skipped, never faked,
// on CI hosts without the optional browser harness; local acceptance must show 0 skips.
const test=(name,fn)=>nodeTest(name,{skip:!pw&&!name.startsWith('VM ') ? 'Playwright unavailable; set PLAYWRIGHT_MODULE to run real browser acceptance' : false},fn);
const item=(id='1')=>({orderSubmissionId:id,displayName:'핫팩 <img src=x onerror=alert(1)>',participantName:'홍길동',channels:[{channel:'naver',label:'네이버',photos:[{id:'1',fileId:'photo_1234567890',isSupplement:false},{id:'2',fileId:'photo_2234567890',isSupplement:false}],evidenceHash:'hash-1',saveState:'saved',reviewState:'not_requested',reason:null,request:null,capabilities:{canAdd:true,canRequestCheck:true,reason:''}},{channel:'coupang',label:'쿠팡',photos:[],evidenceHash:'hash-2',saveState:'unknown',reviewState:'needs_photo',reason:'주문번호가 필요해요',request:null,capabilities:{canAdd:true,canRequestCheck:true}}]});
async function harness(fn,engine='chromium',width=390){
 const server=http.createServer((req,res)=>{let p=req.url.split('?')[0];if(p==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/frontend/css/reviewer-purchase-capture.css"><div id="root"></div><script src="/frontend/js/reviewer-purchase-capture.js"></script>');}try{res.setHeader('Content-Type',p.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(root,p)));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await pw[engine].launch({executablePath:pw[engine].executablePath()});
 const page=await browser.newPage({viewport:{width,height:850}});const external=[];
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='127.0.0.1'){external.push(u.href);return route.abort();}route.continue();});
 try{await page.goto('http://127.0.0.1:'+server.address().port);await fn(page,external);}finally{await browser.close();await new Promise(r=>server.close(r));}
}
async function setup(page,data=item()){
 await page.evaluate(data=>{window.fixture=data;window.calls=[];window.getToken=async opts=>{window.calls.push({token:true,opts});return 'tab-token';};window.fetch=async(url,opts={})=>{window.calls.push({url,opts});if(url.includes('/trackb/'))window.fixture.channels[0].request={id:'r1',status:'pending',createdAt:null,updatedAt:null,note:null};return {ok:true,status:200,json:async()=>url.endsWith('purchase-captures')?{ok:true,items:[window.fixture],hasMore:true}:{ok:true,item:window.fixture,request:{id:'r1',status:'pending',createdAt:null,updatedAt:null,note:null}}};};},data);
 await page.evaluate(()=>window.ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{id:'a',name:'홍길동'},getToken:window.getToken,apiBase:''}));
}
test('VM exposes isolated reviewer and staff public contracts',()=>{assert.ok(fs.existsSync(source),'new front module must exist');const window={};vm.runInNewContext(fs.readFileSync(source,'utf8'),{window});assert.equal(typeof window.ReviewerPurchaseCapture.mount,'function');assert.equal(typeof window.ReviewerPurchaseCapture.open,'function');assert.equal(typeof window.ReviewerPurchaseCapture.reset,'function');assert.equal(typeof window.PurchaseCaptureStaff.open,'function');});
test('saved two-photo purchase is not fabricated missing or finally approved; append stays enabled',async()=>harness(async page=>{await setup(page);assert.match(await page.locator('#root').innerText(),/사진 접수/);assert.doesNotMatch(await page.locator('[data-channel="naver"]').innerText(),/사진 누락|사진 확인 완료/);assert.equal(await page.locator('[data-channel="naver"] button[data-action="add"]').isEnabled(),true);assert.equal(await page.locator('[data-channel="naver"]').getAttribute('open'),null);assert.notEqual(await page.locator('[data-channel="coupang"]').getAttribute('open'),null);assert.equal(await page.locator('#root img[src="x"]').count(),0);assert.match(await page.locator('#root').innerText(),/더 있을 수/);}));
test('single purchase label is not repeated with actual server channel labels',async()=>harness(async page=>{const data=item();data.channels=[{...data.channels[0],channel:'single',label:'구매사진'}];await setup(page,data);assert.equal(await page.locator('summary strong').innerText(),'구매사진');}));
test('a failed refresh keeps visible records but blocks stale writes',async()=>harness(async page=>{await setup(page);await page.locator('[data-channel="naver"] summary').click();await page.evaluate(()=>{window.fetch=async()=>({ok:false,status:503,json:async()=>({ok:false,error:'SQL secret'})});});await page.locator('[data-channel="naver"] [data-action="request"]').click();await page.waitForFunction(()=>document.querySelector('[data-action="reload"]'));assert.match(await page.locator('#root').innerText(),/불러오지 못했어요/);assert.doesNotMatch(await page.locator('#root').innerText(),/SQL secret|지금 표시할 구매사진 내역이 없어요/);assert.equal(await page.locator('[data-channel="naver"] [data-action="add"]').isDisabled(),true);}));
test('write response must belong to exact target order even from home list',async()=>harness(async page=>{await setup(page);await page.evaluate(()=>{window.changed=0;const original=window.fetch;window.fetch=async(url,opts)=>opts.method==='POST'?{ok:true,status:200,json:async()=>({ok:true,item:{...fixture,orderSubmissionId:'someone-else'}})}:original(url,opts);});await page.locator('[data-channel="naver"] summary').click();await page.locator('[data-channel="naver"] [data-action="request"]').click();await page.waitForFunction(()=>!document.querySelector('[data-channel="naver"] [data-action="request"]').disabled);assert.doesNotMatch(await page.locator('#root').innerText(),/확인 요청을 접수했어요/);assert.match(await page.locator('#root').innerText(),/성공으로 확정하지 않았어요/);}));
test('reset removes enlarged private photo as well as main sheet',async()=>harness(async page=>{await setup(page);await page.locator('[data-channel="naver"] summary').click();await page.locator('[data-channel="naver"] [data-action="photo"]').first().click();assert.equal(await page.locator('dialog').count(),1);await page.evaluate(()=>window.ReviewerPurchaseCapture.reset());assert.equal(await page.locator('dialog').count(),0);}));
test('new append retains an opened normal section so save remains reachable',async()=>harness(async page=>{await setup(page);await page.locator('[data-channel="naver"] summary').click();await page.locator('[data-channel="naver"] input[type=file]').setInputFiles({name:'extra.png',mimeType:'image/png',buffer:Buffer.from('image')});await page.waitForSelector('[data-action="save"]',{state:'attached'});assert.equal(await page.locator('[data-action="save"]').isVisible(),true);}));
test('staff callback failure cannot turn committed photo decision into save failure',async()=>harness(async page=>{await setup(page);await page.evaluate(()=>window.PurchaseCaptureStaff.open({requestId:'r1',getToken:async()=> 'jwt-only',onChanged:()=>{throw new Error('parent failed');}}));await page.locator('dialog input[type=checkbox]').check();await page.locator('dialog [data-action="confirmed"]').click();await page.waitForFunction(()=>!document.querySelector('dialog input[type=checkbox]').disabled);assert.match(await page.locator('dialog').innerText(),/사진 확인 완료를 기록했어요/);assert.doesNotMatch(await page.locator('dialog').innerText(),/성공으로 확정하지 않았어요/);}));
test('staff decision rejects a response belonging to another order',async()=>harness(async page=>{await setup(page);await page.evaluate(()=>window.PurchaseCaptureStaff.open({requestId:'r1',getToken:async()=> 'jwt'}));await page.evaluate(()=>{const original=window.fetch;window.fetch=async(url,opts)=>opts.method==='POST'?{ok:true,status:200,json:async()=>({ok:true,request:{id:'r1',status:'pending',createdAt:null,updatedAt:null,note:null},item:{...fixture,orderSubmissionId:'other-order'}})}:original(url,opts);});await page.locator('dialog input[type=checkbox]').check();await page.locator('dialog [data-action="confirmed"]').click();await page.waitForFunction(()=>!document.querySelector('dialog input[type=checkbox]').disabled);assert.doesNotMatch(await page.locator('dialog').innerText(),/사진 확인 완료를 기록했어요/);}));
test('malformed channel response remains an explicit load error, not unhandled render or empty list',async()=>harness(async page=>{await page.evaluate(()=>{window.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,items:[{orderSubmissionId:'1',channels:[null]}]})});});await page.evaluate(()=>window.ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{id:'a'},getToken:async()=> 't'}));assert.match(await page.locator('#root').innerText(),/불러오지 못했어요/);assert.equal(await page.locator('[data-action="reload"]').count(),1);assert.doesNotMatch(await page.locator('#root').innerText(),/지금 표시할 구매사진 내역이 없어요/);}));
test('401 refreshes token once only; failed auth is never an empty list',async()=>harness(async page=>{
 await page.evaluate(()=>{window.attempts=[];window.tokens=[];window.fetch=async(url,opts)=>{attempts.push(opts.headers);return {status:401,ok:false,json:async()=>({ok:false,error:'internal auth detail'})};};});
 await page.evaluate(()=>window.ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{name:'홍길동',phone8:'12345678',reviewerToken:'snapshot'},getToken:async function(arg){tokens.push({count:arguments.length,arg});return arg?'fresh':'old';}}));
 const result=await page.evaluate(()=>({attempts,tokens,text:document.querySelector('#root').innerText}));
 assert.equal(result.attempts.length,2);assert.equal(result.tokens.length,2);assert.equal(result.tokens[0].count,0);assert.equal(result.tokens[0].arg,undefined);assert.deepEqual(result.tokens[1].arg,{forceRefresh:true});assert.equal(result.attempts[1]['X-Reviewer-Token'],'fresh');assert.match(result.text,/로그인이 만료/);assert.doesNotMatch(result.text,/내역이 없어요|internal auth detail/);
}));
test('late list success and late upload failure are discarded after account switch',async()=>harness(async page=>{
 await setup(page);
 await page.evaluate(()=>{window.originalFetch=fetch;window.fetch=()=>new Promise(r=>window.releaseList=r);window.oldLoad=ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{name:'old',phone8:'11111111'},getToken:async()=> 'old'});});
 await page.waitForFunction(()=>!!window.releaseList);
 await page.evaluate(async()=>{window.fetch=originalFetch;fixture.displayName='새 계정 주문';await ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{name:'new',phone8:'22222222'},getToken:async()=> 'new'});releaseList({ok:true,status:200,json:async()=>({ok:true,items:[{...fixture,displayName:'옛 계정 비밀'}]})});await oldLoad;});
 assert.match(await page.locator('#root').innerText(),/새 계정 주문/);assert.doesNotMatch(await page.locator('#root').innerText(),/옛 계정 비밀/);
 await page.locator('[data-channel="naver"] summary').click();await page.locator('[data-channel="naver"] input[type=file]').setInputFiles({name:'extra.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});await page.waitForSelector('[data-action="save"]');
 await page.evaluate(()=>{window.fetch=(url,opts)=>opts.method==='POST'?new Promise((_,r)=>window.failOld=r):originalFetch(url,opts);});
 await page.locator('[data-action="save"]').click();await page.waitForFunction(()=>!!window.failOld);
 await page.evaluate(async()=>{window.fetch=originalFetch;await ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user:{name:'third',phone8:'33333333'},getToken:async()=> 'third'});failOld(new Error('late failure'));});
 assert.doesNotMatch(await page.locator('#root').innerText(),/성공으로 확정하지 않았어요|연결하지 못했어요/);assert.equal(await page.locator('[data-action="save"]').count(),0);
}));
test('missing capabilities disable both actions with a reason; unknown review is not pending',async()=>harness(async page=>{
 const data=item();delete data.channels[1].capabilities;delete data.channels[1].reviewState;await setup(page,data);
 const area=page.locator('[data-channel="coupang"]');assert.equal(await area.locator('[data-action="add"]').isDisabled(),true);assert.equal(await area.locator('[data-action="request"]').isDisabled(),true);assert.match(await area.innerText(),/현재 이 작업을 사용할 수 없어요|확인 상태 없음/);assert.doesNotMatch(await area.innerText(),/담당자 확인 중/);
}));
for(const engine of ['chromium','webkit']) for(const width of [390,1280]) test(`${engine} ${width}: append retry, request, staff decision, scroll-end photo and no clipping/external requests`,async()=>harness(async(page,external)=>{
 const fixture=item();fixture.channels[0].photos=Array.from({length:24},(_,i)=>({id:String(i),fileId:'original_photo_'+i,isSupplement:false}));
 await setup(page,fixture);
 await page.evaluate(()=>{
   window.keys=new Map();window.loseNext=true;window.writes=[];window.staffReads=0;
   const response=data=>({ok:true,status:200,json:async()=>structuredClone(data)});
   window.fetch=async(url,opts={})=>{
     calls.push({url,opts});
     if(opts.method==='POST'){
       const body=JSON.parse(opts.body);writes.push({url,headers:opts.headers,body});
       const channel=fixture.channels.find(c=>c.channel===(body.channel||'naver'));
       if(url.endsWith('/supplements')){
         if(!keys.has(body.requestKey)){channel.photos.push({id:'extra-1',fileId:'extra_photo_1',isSupplement:true});channel.evidenceHash='next-hash';channel.reviewState='pending';keys.set(body.requestKey,true);}
         if(loseNext){loseNext=false;throw new Error('commit response lost');}
       }else if(url.endsWith('/check-requests')){channel.reviewState='pending';channel.request={id:'r1',status:'pending',note:body.note};}
       else if(url.endsWith('/decision')){channel.reviewState=body.decision;channel.reason=body.note;}
       return response({ok:true,item:fixture,request:{id:'r1',status:'pending',createdAt:null,updatedAt:null,note:null},created:true});
     }
     if(url.includes('/trackb/'))staffReads++;
     return response(url.endsWith('purchase-captures')?{ok:true,items:[fixture],hasMore:false}:{ok:true,item:fixture,request:{id:'r1',status:'pending',createdAt:null,updatedAt:null,note:null}});
   };
 });
 await page.locator('[data-channel="naver"] summary').click();
 const row=page.locator('[data-channel="naver"] .rpc-photos');assert.equal(await row.evaluate(n=>n.scrollWidth>n.clientWidth),true);await row.evaluate(n=>n.scrollLeft=n.scrollWidth);
 // Give the target a real image: other thumbnails stay broken, while the full-size
 // URL/decoded-image assertion cannot race with intentional 404 error replacement.
 await page.route('**/api/drive/image/original_photo_23',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')}));
 await page.locator('[data-channel="naver"] [data-action="photo"]').last().click();assert.equal(await page.locator('dialog img').getAttribute('src'),'/api/drive/image/original_photo_23');await page.waitForFunction(()=>document.querySelector('dialog img')?.naturalWidth>0);await page.locator('[data-action="close-photo"]').click();
 // Broken display is explicitly not a DB save failure.
 await page.waitForFunction(()=>document.querySelector('[data-channel="naver"]').innerText.includes('사진 연결 확인 불가'));
 assert.doesNotMatch(await page.locator('[data-channel="naver"] summary').innerText(),/저장 실패/);
 await page.locator('[data-channel="naver"] input[type=file]').setInputFiles({name:'extra.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture photo')});await page.waitForSelector('[data-action="save"]');
 await page.locator('[data-action="save"]').click();await page.waitForFunction(()=>document.querySelector('.rpc-message').textContent.includes('성공으로 확정하지 않았어요'));
 assert.equal(await page.locator('[data-channel="naver"] .rpc-thumb').count(),25);
 await page.locator('[data-action="save"]').click();await page.waitForFunction(()=>document.querySelector('.rpc-message').textContent.includes('사진을 접수했어요'));
 assert.equal(await page.locator('[data-channel="naver"] .rpc-thumb').count(),25);assert.equal(await page.locator('[data-action="save"]').count(),0);
 const writes=await page.evaluate(()=>window.writes);assert.equal(writes.length,2);assert.deepEqual(writes[0].body,writes[1].body);assert.equal(writes[0].body.expectedEvidenceHash,'hash-1');assert.deepEqual(Object.keys(writes[0].body).sort(),['channel','expectedEvidenceHash','imageBase64','mimeType','requestKey'].sort());
 assert.equal(await page.locator('[data-channel="coupang"] .rpc-thumb').count(),0);
 await page.locator('[data-channel="naver"] textarea').fill('이미 제출했어요');await page.locator('[data-channel="naver"] [data-action="request"]').click();await page.waitForFunction(()=>document.querySelector('.rpc-message').textContent.includes('확인 요청을 접수했어요'));
 assert.match(await page.locator('[data-channel="naver"] summary').innerText(),/담당자 확인 중/);assert.doesNotMatch(await page.locator('[data-channel="naver"] summary').innerText(),/사진 확인 완료/);
 await page.evaluate(()=>window.PurchaseCaptureStaff.open({requestId:'r1',apiBase:'',getToken:async()=> 'staff-jwt',onChanged:()=>window.staffChanged=true}));
 const dialog=page.locator('dialog.rpc-dialog');assert.equal(await dialog.locator('[data-action="confirmed"]').isDisabled(),true);
 await dialog.locator('input[type=checkbox]').check();await dialog.locator('[data-action="needs_photo"]').click();assert.match(await dialog.innerText(),/보완 사유를 적어/);
 const before=await page.evaluate(()=>writes.length);await dialog.locator('textarea').fill('주문번호가 보여야 해요');await dialog.locator('[data-action="needs_photo"]').click();await page.waitForFunction(()=>document.querySelector('dialog .rpc-message').textContent.includes('보완 사유를 전달했어요'));
 assert.equal(await page.evaluate(()=>writes.length),before+1);assert.match(await dialog.innerText(),/명의·입금 승인은 별도로/);
 await dialog.locator('input[type=checkbox]').check();await dialog.locator('[data-action="confirmed"]').click();await page.waitForFunction(()=>document.querySelector('dialog .rpc-message').textContent.includes('사진 확인 완료를 기록했어요'));
 const final=await page.evaluate(()=>({writes,staffReads,changed:staffChanged}));assert.ok(final.staffReads>=3);assert.equal(final.changed,true);assert.equal(final.writes.at(-1).headers.Authorization,'Bearer staff-jwt');assert.equal(final.writes.at(-1).headers['X-Reviewer-Token'],undefined);assert.equal(final.writes.at(-1).body.expectedEvidenceHash,'next-hash');
 const dimensions=await page.evaluate(()=>({page:document.documentElement.scrollWidth,width:innerWidth,dialogs:[...document.querySelectorAll('dialog')].map(n=>({scroll:n.scrollWidth,width:n.clientWidth,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right}))}));assert.ok(dimensions.page<=dimensions.width);for(const d of dimensions.dialogs){assert.ok(d.scroll<=d.width+1);assert.ok(d.left>=0&&d.right<=width);}
 assert.deepEqual(external,[]);
 if(process.env.CAPTURE_SHOTS){fs.mkdirSync(process.env.CAPTURE_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.CAPTURE_SHOTS,`${engine}-${width}-staff.png`),fullPage:true});await dialog.locator('[data-action="close"]').click();await page.screenshot({path:path.join(process.env.CAPTURE_SHOTS,`${engine}-${width}-reviewer.png`),fullPage:true});}
},engine,width));
test('same-account token renewal may update snapshot token without invalidating identity',async()=>harness(async page=>{
 await page.evaluate(()=>{window.user={name:'홍길동',phone8:'12345678',reviewerToken:'old'};window.n=0;window.fetch=async()=>++n===1?{ok:false,status:401,json:async()=>({ok:false})}:{ok:true,status:200,json:async()=>({ok:true,items:[],hasMore:false})};});
 await page.evaluate(()=>ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user,getToken:async force=>{if(force)user.reviewerToken='renewed';return user.reviewerToken;}}));assert.match(await page.locator('#root').innerText(),/지금 표시할 구매사진 내역이 없어요/);
}));
test('account identity mutation during token await cannot send request',async()=>harness(async page=>{
 await page.evaluate(()=>{window.user={name:'홍길동',phone8:'12345678'};window.requests=0;window.fetch=async()=>{requests++;throw Error('must not call');};window.loading=ReviewerPurchaseCapture.mount({container:document.querySelector('#root'),user,getToken:()=>new Promise(r=>window.releaseToken=r)});});
 await page.evaluate(async()=>{user.phone8='87654321';releaseToken('old-token');await loading;});assert.equal(await page.evaluate(()=>requests),0);
}));
test('append is locked until response and readback finish; close/Escape cannot abandon it',async()=>harness(async page=>{
 await setup(page);await page.evaluate(()=>ReviewerPurchaseCapture.open({orderSubmissionId:'1',user:{name:'홍길동',phone8:'12345678'},getToken:async()=> 'snapshot'}));
 await page.locator('dialog [data-channel="naver"] summary').click();await page.locator('dialog [data-channel="naver"] input[type=file]').setInputFiles({name:'photo.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});await page.waitForSelector('dialog [data-action="save"]');
 await page.evaluate(()=>{const original=fetch;window.fetch=(url,opts)=>opts.method==='POST'?new Promise(r=>window.finishUpload=()=>r({ok:true,status:200,json:async()=>({ok:true,item:fixture})})):original(url,opts);});
 await page.locator('dialog [data-action="save"]').click();await page.waitForFunction(()=>!!window.finishUpload);assert.equal(await page.locator('dialog [data-action="close"]').isDisabled(),true);assert.equal(await page.locator('dialog [data-action="request"]').first().isDisabled(),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),1);await page.evaluate(()=>finishUpload());await page.waitForFunction(()=>!document.querySelector('dialog [data-action="close"]').disabled);assert.match(await page.locator('dialog').innerText(),/사진을 접수했어요/);
}));
test('single-channel original two photos permit append and reuse ImageShrink longest-side helper',async()=>harness(async page=>{
 const data=item();data.channels=[{...data.channels[0],channel:'single',label:'구매처'}];await setup(page,data);
 await page.evaluate(()=>{window.shrinkArgs=null;window.ImageShrink={fromFile:async(file,max,quality,opts)=>{shrinkArgs={name:file.name,max,quality,opts};return {base64:'Zml4dHVyZQ==',mime:'image/jpeg'};}};});
 await page.locator('[data-channel="single"] summary').click();await page.locator('input[type=file]').setInputFiles({name:'third.png',mimeType:'image/png',buffer:Buffer.from('fixture')});await page.waitForSelector('[data-action="save"]');await page.locator('[data-action="save"]').click();await page.waitForFunction(()=>document.querySelector('.rpc-message').textContent.includes('사진을 접수했어요'));
 const dataOut=await page.evaluate(()=>({args:shrinkArgs,writes:calls.filter(x=>x.opts&&x.opts.method==='POST')}));assert.deepEqual(dataOut.args,{name:'third.png',max:1920,quality:0.8,opts:{longest:true}});assert.equal(JSON.parse(dataOut.writes[0].opts.body).channel,'single');assert.equal(await page.locator('.rpc-thumb').count(),2);
}));
test('order change discards delayed detail and fails closed for mismatching detail response',async()=>harness(async page=>{
 await setup(page);await page.evaluate(()=>{window.originalFetch=fetch;window.fetch=()=>new Promise(r=>window.finishDetail=r);window.first=ReviewerPurchaseCapture.open({orderSubmissionId:'1',user:{name:'A',phone8:'12345678'},getToken:async()=> 'a'});});await page.waitForFunction(()=>!!window.finishDetail);
 await page.evaluate(async()=>{window.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,item:{...fixture,orderSubmissionId:'2',displayName:'두 번째 주문'}})});await ReviewerPurchaseCapture.open({orderSubmissionId:'2',user:{name:'A',phone8:'12345678'},getToken:async()=> 'a'});finishDetail({ok:true,status:200,json:async()=>({ok:true,item:fixture})});await first;});assert.match(await page.locator('dialog').innerText(),/두 번째 주문/);assert.doesNotMatch(await page.locator('dialog').innerText(),/핫팩/);
 await page.evaluate(()=>ReviewerPurchaseCapture.open({orderSubmissionId:'3',user:{name:'A',phone8:'12345678'},getToken:async()=> 'a'}));assert.match(await page.locator('dialog').innerText(),/불러오지 못했어요/);assert.equal(await page.locator('dialog [data-action="request"]').count(),0);
}));
test('write response must contain the exact requested purchase channel',async()=>harness(async page=>{
 await setup(page);await page.evaluate(()=>{const original=fetch;window.fetch=(url,opts)=>opts.method==='POST'?Promise.resolve({ok:true,status:200,json:async()=>({ok:true,item:{...fixture,channels:[fixture.channels[1]]}})}):original(url,opts);});await page.locator('[data-channel="naver"] summary').click();await page.locator('[data-channel="naver"] [data-action="request"]').click();await page.waitForFunction(()=>!document.querySelector('[data-channel="naver"] [data-action="request"]').disabled);assert.doesNotMatch(await page.locator('#root').innerText(),/확인 요청을 접수했어요/);
}));
test('requesting a check cannot silently discard an unsubmitted selected supplement',async()=>harness(async page=>{
 await setup(page);await page.locator('[data-channel="naver"] summary').click();await page.locator('[data-channel="naver"] input[type=file]').setInputFiles({name:'selected.jpg',mimeType:'image/jpeg',buffer:Buffer.from('fixture')});await page.waitForSelector('[data-action="save"]');await page.locator('[data-channel="naver"] [data-action="request"]').click();await page.waitForFunction(()=>document.querySelector('.rpc-message').textContent.includes('확인 요청을 접수했어요'));assert.equal(await page.locator('[data-action="save"]').count(),1);
}));
test('staff resolves target only from nested channel request id, not missing top-level channel or first channel',async()=>harness(async page=>{
 await setup(page);await page.evaluate(()=>{fixture.channels[1].request={id:'r2',status:'pending',note:null};window.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,item:fixture,request:{id:'r2',status:'pending',createdAt:null,updatedAt:null,note:null}})});return PurchaseCaptureStaff.open({requestId:'r2',getToken:async()=> 'jwt'});});assert.match(await page.locator('dialog .rpc-staff').innerText(),/쿠팡 사진 처리/);assert.doesNotMatch(await page.locator('dialog .rpc-staff').innerText(),/네이버 사진 처리/);
}));
module.exports={harness,setup,item};
