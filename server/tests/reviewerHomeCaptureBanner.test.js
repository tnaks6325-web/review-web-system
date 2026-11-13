'use strict';
// 결정 370 — 리뷰어 홈 구매사진: 홈 탭 맨 위 한 줄 알림 + 누르면 아래에서 올라오는 창(주문 한 줄씩).
// 정적 계약(VM ·)은 항상 돈다. 실제 브라우저 검사는 Playwright 가 있을 때만 돌고, 없으면 skip 으로 드러낸다(가짜 통과 금지).
const {test:nodeTest}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'../..');
const JS=fs.readFileSync(path.join(root,'frontend/js/reviewer-purchase-capture.js'),'utf8');
const CSS=fs.readFileSync(path.join(root,'frontend/css/reviewer-purchase-capture.css'),'utf8');
const HOME=fs.readFileSync(path.join(root,'frontend/index.html'),'utf8');
let pw;
try{pw=require(process.env.PLAYWRIGHT_MODULE||'playwright');}catch(error){if(process.env.PLAYWRIGHT_MODULE)throw error;}
const test=(name,fn)=>nodeTest(name,{skip:!pw&&!name.startsWith('VM ')?'Playwright unavailable; set PLAYWRIGHT_MODULE to run real browser acceptance':false},fn);

function fnBody(src,name){
  const start=src.indexOf('function '+name+'(');assert.ok(start>=0,name+' 가 있어야 한다');
  let depth=0,i=src.indexOf('{',start);
  for(;i<src.length;i++){if(src[i]==='{')depth++;else if(src[i]==='}'&&--depth===0)break;}
  return src.slice(start,i+1);
}

test('VM 「손볼 것 있음」 판정은 한 곳 — 펼침·알림 건수·창 묶음이 같은 함수를 쓴다',()=>{
  const ctx={};vm.runInNewContext(fnBody(JS,'channelNeedsAction')+';'+fnBody(JS,'needsAction')+';this.c=channelNeedsAction;this.n=needsAction;',ctx);
  for(const s of ['missing','failed','unknown','uploading'])assert.equal(ctx.c({saveState:s,reviewState:'not_requested'}),true,s);
  assert.equal(ctx.c({saveState:'saved',reviewState:'needs_photo'}),true,'보완 요청');
  for(const r of ['not_requested','pending','confirmed'])assert.equal(ctx.c({saveState:'saved',reviewState:r}),false,r);
  assert.equal(ctx.n({channels:[{saveState:'saved',reviewState:'confirmed'},{saveState:'missing',reviewState:'not_requested'}]}),true,'동시진행은 한 갈래만 비어도 할 일');
  assert.equal(ctx.n({channels:'x'}),false);
  assert.match(fnBody(JS,'renderItem'),/channelNeedsAction\(ch\)/,'기존 펼침 목록도 같은 판정');
  assert.match(fnBody(JS,'renderCompact'),/needsAction/);
  assert.match(fnBody(JS,'banner'),/filter\(needsAction\)/);
});

test('VM 홈은 한 줄 알림(옛 모듈이면 종전 목록) · 리뷰내역·내정보·문의 탭에서는 숨긴다',()=>{
  const mount=fnBody(HOME,'_mountPurchaseCapture');
  assert.match(mount,/typeof window\.ReviewerPurchaseCapture\.banner === 'function'\) window\.ReviewerPurchaseCapture\.banner\(/);
  assert.match(mount,/else window\.ReviewerPurchaseCapture\.mount\(/,'캐시에 남은 옛 모듈도 동작');
  assert.match(mount,/\['review','cs','my'\]\.includes\(_currentTab\) \? 'none' : ''/,'첫 화면(all)=홈에서 보인다');
  const tab=fnBody(HOME,'switchTab');
  assert.match(tab,/captureSelfService === '1'\) mc\.style\.display = key === 'home' \? '' : 'none'/);
  assert.match(tab,/else if \(key === 'cs'\) mc\.style\.display = 'none';/,'옛 서버용 목록은 종전대로');
  assert.match(HOME,/reviewer-purchase-capture\.js\?v=20261113-home-banner/);
  assert.match(HOME,/reviewer-purchase-capture\.css\?v=20261113-home-banner/);
});

test('VM 새 모양은 홈 알림·리뷰어 창 안에서만 — 직원 창·기존 목록 규칙을 건드리지 않는다',()=>{
  const added=CSS.slice(CSS.lastIndexOf('/*',CSS.indexOf('결정 370')));
  for(const rule of added.replace(/\/\*[\s\S]*?\*\//g,'').split('}')){
    const sel=rule.split('{')[0].replace(/@media[^{]*\{?/,'').trim();
    if(!sel)continue;
    for(const part of sel.split(','))assert.match(part.trim(),/^(#sectionMissingCapture\.rpc-bannerhost|\.rpc-bannerhost|\.rpc-banner|\.rpc-dot|\.rpc-sheet)/,'범위 밖 규칙: '+part);
  }
  assert.match(JS,/sheet=!isStaff&&compact===true/,'직원 창은 compact 불가');
  assert.match(JS,/open:function\(opts\)\{dispose\(reviewer\);reviewer=modal\(opts,false,opts&&opts\.compact===true\)/);
  assert.match(JS,/reset:function\(\)\{dispose\(reviewer\);reviewer=null;dispose\(homeBanner\);homeBanner=null;\}/,'로그아웃 때 알림도 지운다');
});

const need=(id,name,extra={})=>({orderSubmissionId:id,displayName:name,participantName:'가상 리뷰어',channels:[{channel:'single',label:'구매사진',photos:[],evidenceHash:'h'+id,saveState:'missing',reviewState:'not_requested',reason:null,request:null,capabilities:{canAdd:true,canRequestCheck:true}}],...extra});
const done=(id,name,reviewState='not_requested')=>({orderSubmissionId:id,displayName:name,participantName:'가상 리뷰어',channels:[{channel:'single',label:'구매사진',photos:[{id:'p'+id,fileId:'photo_'+id+'000000000',isSupplement:false}],evidenceHash:'h'+id,saveState:'saved',reviewState,reason:null,request:null,capabilities:{canAdd:true,canRequestCheck:true}}]});
const dual=(id)=>({orderSubmissionId:id,displayName:'동시진행 주문',participantName:'가상 타계정',channels:[{channel:'naver',label:'네이버',photos:[],evidenceHash:'n'+id,saveState:'missing',reviewState:'not_requested',request:null,capabilities:{canAdd:true,canRequestCheck:true}},{channel:'coupang',label:'쿠팡',photos:[{id:'c',fileId:'photo_c000000000',isSupplement:false}],evidenceHash:'c'+id,saveState:'saved',reviewState:'not_requested',request:null,capabilities:{canAdd:true,canRequestCheck:true}}]});

async function harness(fn,{engine='chromium',width=390}={}){
  const server=http.createServer((req,res)=>{
    const p=req.url.split('?')[0];
    if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/frontend/css/reviewer-purchase-capture.css"><style>body{margin:0;background:#eef2f8}main{padding:16px}.home-section{padding:0 0 8px}</style><main><div class="home-section" id="sectionMissingCapture"></div><p id="next">모집공고</p></main><script src="/frontend/js/reviewer-purchase-capture.js"></script>');}
    if(p.startsWith('/api/drive/image/')){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14"/>');}
    try{res.setHeader('Content-Type',p.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(root,p)));}catch{res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await pw[engine].launch({executablePath:pw[engine].executablePath()});
  const page=await browser.newPage({viewport:{width,height:844}});page.setDefaultTimeout(15000);const writes=[],errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(u.hostname!=='127.0.0.1')return route.abort();if(r.method()!=='GET')writes.push(r.method()+' '+u.pathname);return route.continue();});
  try{await page.goto('http://127.0.0.1:'+server.address().port);await fn(page,{writes,errors});assert.deepEqual(errors,[]);}
  finally{await browser.close();await new Promise(r=>server.close(r));}
}
// 페이지 안 fetch 를 바꿔 목록 응답을 정한다(쓰기 요청은 기록만).
async function serve(page,items,{fail=0}={}){
  await page.evaluate(({items,fail})=>{
    window.listCalls=0;window.failLeft=fail;window.items=items;window.apiWrites=[];
    window.fetch=async(url,opts={})=>{
      if(opts.method&&opts.method!=='GET'){window.apiWrites.push(url);return {ok:true,status:200,json:async()=>({ok:true,item:window.items[0]})};}
      if(String(url).endsWith('/api/reviewer/purchase-captures')){window.listCalls++;if(window.failLeft>0){window.failLeft--;return {ok:false,status:503,json:async()=>({ok:false})};}return {ok:true,status:200,json:async()=>({ok:true,items:window.items,hasMore:false})};}
      return {ok:false,status:404,json:async()=>({ok:false})};
    };
  },{items,fail});
}
// 응답을 기다리지 않는다(evaluate 가 끝나지 않는 약속을 붙잡지 않게) — 결과는 화면에서 waitFor 로 본다.
const banner=page=>page.evaluate(()=>{ReviewerPurchaseCapture.banner({container:'#sectionMissingCapture',user:{name:'가상 리뷰어',phone8:'12345678'},getToken:async()=>'tab-token',apiBase:''});});
const items=[need('1','[11/03] 데일리 단백질 쉐이크 초코맛 1kg'),dual('2'),done('3','[11/09] 바삭 김부각 스낵 5봉','pending'),done('4','[11/08] 비타민C 30개'),done('5','[11/05] 위트 탈취제','confirmed')];

for(const engine of ['chromium','webkit'])for(const width of [320,390,1280]){
  test(`${engine} ${width} 홈은 한 줄 · 창은 보완 필요가 위 · 한 번에 한 줄만 펼침 · 닫으면 건수 다시 읽음`,()=>harness(async(page,{writes})=>{
    await serve(page,items);await banner(page);
    const b=page.locator('#sectionMissingCapture .rpc-banner');
    await b.waitFor();
    assert.equal(await b.locator('.rpc-banner-text').innerText().then(t=>t.replace(/\s+/g,' ').trim()),'구매사진 보완 필요 2건');
    assert.equal(await b.locator('.rpc-banner-go').innerText(),'확인하기');
    assert.equal(await page.locator('#sectionMissingCapture .rpc-item, #sectionMissingCapture details').count(),0,'홈에 카드를 쌓지 않는다');
    const h=await page.locator('#sectionMissingCapture').evaluate(n=>n.getBoundingClientRect().height);
    assert.ok(h<=56,'홈 알림 높이 '+h);
    await b.click();
    const sheet=page.locator('dialog.rpc-sheet');await sheet.locator('.rpc-row').first().waitFor();
    assert.deepEqual(await sheet.locator('.rpc-grp').allInnerTexts(),['보완 필요 2건','사진 낸 주문 3건']);
    const groups=sheet.locator('.rpc-group');
    assert.deepEqual(await groups.nth(0).locator('.rpc-rowname').allInnerTexts(),['[11/03] 데일리 단백질 쉐이크 초코맛 1kg','동시진행 주문']);
    assert.deepEqual(await groups.nth(0).locator('.rpc-row').nth(1).locator('.rpc-chip').allInnerTexts(),['네이버 사진 없음','쿠팡 접수됨'],'동시진행은 갈래별 표시');
    assert.deepEqual(await groups.nth(1).locator('.rpc-chip').allInnerTexts(),['담당자 확인 중','접수됨','확인 완료']);
    assert.equal(await sheet.locator('[data-action="add"],[data-action="request"],textarea').count(),0,'처음엔 모두 접힘');
    await groups.nth(0).locator('.rpc-rowhead').first().click();
    for(const s of ['[data-action="add"]','[data-action="request"]','textarea'])assert.equal(await sheet.locator(s).first().isVisible(),true,s);
    const bg=await sheet.locator('[data-action="request"]').evaluate(n=>getComputedStyle(n).backgroundColor);
    assert.equal(bg,'rgb(0, 113, 227)','주 단추는 파랑 채움');
    const tall=await sheet.locator('[data-action="add"],[data-action="request"],textarea').evaluateAll(ns=>ns.map(n=>Math.round(n.getBoundingClientRect().height)));
    assert.ok(tall.every(x=>x>=40),'단추·입력칸 40px 이상 '+tall);
    assert.equal(await sheet.locator('textarea').evaluate(n=>getComputedStyle(n).fontSize),'16px','아이폰 확대 방지');
    await groups.nth(1).locator('.rpc-rowhead').first().click();
    assert.equal(await sheet.locator('.rpc-row.open').count(),1,'한 번에 한 줄');
    assert.equal(await sheet.locator('.rpc-row.open .rpc-rowname').innerText(),'[11/09] 바삭 김부각 스낵 5봉');
    const sw=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(sw<=width,'옆으로 밀림 '+sw);
    const before=await page.evaluate(()=>window.listCalls);
    await page.evaluate(()=>{window.items=window.items.slice(1);});
    await sheet.locator('.rpc-x').click();
    assert.equal(await page.locator('dialog.rpc-sheet').count(),0);
    await page.waitForFunction(n=>window.listCalls>n,before);
    await page.waitForFunction(()=>document.querySelector('#sectionMissingCapture .rpc-banner-text b')?.textContent==='1건');
    assert.deepEqual(writes,[]);assert.deepEqual(await page.evaluate(()=>window.apiWrites),[]);
  },{engine,width}));
}

test('조회 실패는 「없음」으로 숨기지 않고 다시 조회를 준다 · 다 냈으면 접수 건수 · 내역 없으면 자리 차지 없음',()=>harness(async page=>{
  await serve(page,[done('3','a'),done('4','b')],{fail:1});await banner(page);
  const b=page.locator('#sectionMissingCapture .rpc-banner');await b.waitFor();
  assert.equal((await b.innerText()).replace(/\s+/g,' ').trim(),'구매사진 내역을 불러오지 못했어요 다시 조회');
  await b.click();
  await page.waitForFunction(()=>document.querySelector('#sectionMissingCapture .rpc-banner-text b')?.textContent==='2건 접수');
  assert.equal(await page.locator('#sectionMissingCapture .rpc-banner-go').innerText(),'보기');
  await serve(page,[]);await banner(page);
  await page.waitForFunction(()=>window.listCalls===1);
  assert.equal(await page.locator('#sectionMissingCapture').evaluate(n=>[n.childElementCount,getComputedStyle(n).display]).then(x=>x.join()),'0,none');
}));

test('늦게 온 옛 응답이 새 알림을 덮지 않는다 · 로그아웃(reset)이 알림을 지운다',()=>harness(async page=>{
  await page.evaluate(()=>{window.releases=[];window.fetch=()=>new Promise(r=>window.releases.push(r));});
  await banner(page);await page.waitForFunction(()=>window.releases.length===1);
  await page.evaluate(()=>{ReviewerPurchaseCapture.banner({container:'#sectionMissingCapture',user:{name:'다른 명의',phone8:'87654321'},getToken:async()=>'t2',apiBase:''});});
  await page.waitForFunction(()=>window.releases.length===2);
  await page.evaluate(()=>window.releases[1]({ok:true,status:200,json:async()=>({ok:true,items:[]})}));
  await page.evaluate(([a])=>window.releases[0]({ok:true,status:200,json:async()=>({ok:true,items:[a]})}),[need('9','옛 명의 주문')]);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#sectionMissingCapture .rpc-banner').count(),0,'옛 명의 응답이 새 화면을 덮으면 안 된다');
  // 새로 고치는 동안 지금 줄은 남아 있다(빈칸 깜빡임 없음) · 결과가 오면 바뀐다
  await serve(page,[need('1','x'),need('2','y')]);await banner(page);await page.locator('.rpc-banner-text b').waitFor();
  await page.evaluate(()=>{window.fetch=()=>new Promise(r=>window.hold=r);});await banner(page);await page.waitForTimeout(100);
  assert.equal(await page.locator('.rpc-banner-text b').innerText(),'2건','새로 고치는 중에도 지금 줄 유지');
  await page.locator('.rpc-banner').click();assert.equal(await page.locator('dialog').count(),0,'버려진 옛 줄은 창을 열지 않는다');
  await page.evaluate(i=>window.hold({ok:true,status:200,json:async()=>({ok:true,items:[i]})}),need('1','x'));
  await page.waitForFunction(()=>document.querySelector('.rpc-banner-text b')?.textContent==='1건');
  await serve(page,[need('1','x')]);await banner(page);await page.locator('.rpc-banner').waitFor();
  await page.evaluate(()=>ReviewerPurchaseCapture.reset());
  assert.equal(await page.locator('#sectionMissingCapture').evaluate(n=>n.childElementCount),0);
}));

test('직원 창·기존 펼침 목록은 종전 모양 그대로',()=>harness(async page=>{
  const v=await page.evaluate(()=>{const d=document.createElement('div');d.className='rpc rpc-dialog';const t=document.createElement('textarea');const b=document.createElement('button');b.dataset.action='request';d.append(t,b);document.body.append(d);
    const r={pad:getComputedStyle(d).paddingLeft,ta:getComputedStyle(t).minHeight,bg:getComputedStyle(b).backgroundColor};d.remove();return r;});
  assert.deepEqual(v,{pad:'16px',ta:'60px',bg:'rgba(0, 0, 0, 0)'});
}));
