'use strict';
// Actual boot → advertiser loadTabs receiver with fake auth/data. No server/clipboard IO.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const html=fs.readFileSync(path.resolve(__dirname,'../../frontend/workdesk.html'),'utf8');
function fn(name,optional=false){
 const m=new RegExp('(?:async )?function '+name+'\\(').exec(html);
 if(!m){if(optional)return '';assert.fail('Missing function '+name);}
 let i=html.indexOf('{',m.index),d=0;
 for(;i<html.length;i++){if(html[i]==='{')d++;else if(html[i]==='}'&&--d===0)return html.slice(m.index,i+1);}
 assert.fail('Unclosed function '+name);
}
const rows=[{sheetId:'S',tabName:'작업 1'},{sheetId:'S',tabName:'작업 2'},{sheetId:'S',tabName:'작업 3'}];
const key=w=>'&work='+encodeURIComponent(JSON.stringify(w));
function receiver(hash,opts={}){
 const log={opened:[],messages:[],home:0,restored:0,urls:[],calls:[]};
 const location={origin:'https://preview.invalid',pathname:'/workdesk',search:'?demo=1',hash};
 const ctx={STATE:{tabs:[],cur:null},location,_GO:null,_VIEW:'',_PICK:'',_SHARE:null,_SHARE_ERR:'',_ADV_WORK:null,
  history:{state:opts.history||null,replaceState(_a,_b,url){log.urls.push(url);location.hash=new URL(url,location.origin).hash;}},
  sessionStorage:{getItem:()=> 'fake-access',setItem(){},removeItem(){}},
  token:()=> 'fake-session',parseJwt:()=>({role:opts.role||'advertiser',exp:Math.floor(Date.now()/1000)+3600}),
  fetch:async()=>({json:async()=>({success:true,token:'fake-session'})}),API_BASE:'https://api.invalid',
  window:{},Date,JSON,decodeURIComponent,encodeURIComponent,setTimeout:()=>0,alert:m=>log.messages.push(m),toast:m=>log.messages.push(m),
  _navCanRestore:()=>true,_navRestoreState(){log.restored++;},_wbOrderLiveStart(){},_isInternalRole:()=>false,
  _brandLens(){},_renderAdvSidebar(){},refreshUnseen(){},_renderAdvHome(){log.home++;},
  selTab(i){log.opened.push(JSON.parse(JSON.stringify(ctx.STATE.tabs[i])));ctx.STATE.cur=ctx.STATE.tabs[i];},
  $:()=>null,
  api:async url=>{log.calls.push(url);if(url.includes('my-work-summary'))return opts.summary===undefined?{ok:true,items:[]}:opts.summary;
   if(opts.rejectTabs)throw Error('fake failed query');return opts.tabs===undefined?{ok:true,tabs:rows.map(x=>({...x}))}:opts.tabs;},
  renderShell(){ctx.loaded=ctx.loadTabs();},renderLogin:m=>log.messages.push(m)
 };
 vm.createContext(ctx);
 vm.runInContext(['_readAdvertiserWork','_consumeAdvertiserWork','_clearAdvertiserWorkHash','_openPendingAdvertiserWork'].map(n=>fn(n,true)).join('\n')+'\n'+['boot','_consumeGo','_consumeShare','loadTabs'].map(n=>fn(n)).join('\n'),ctx);
 // Mirror the real pre-initToken capture. A baseline without the feature still boots normally.
 ctx._ADV_WORK=ctx._readAdvertiserWork?ctx._readAdvertiserWork(hash):null;
 return {ctx,log,async boot(){await ctx.boot();await ctx.loaded;}};
}
let count=0;
async function t(name,f){await f();count++;console.log('  ✓ '+name);}
(async()=>{
 await t('actual boot opens the designated owned work, not the dashboard',async()=>{
  const h=receiver('#a=fake-access'+key({s:'S',t:'작업 2'}));await h.boot();assert.deepEqual(h.log.opened.map(x=>x.tabName),['작업 2']);assert.equal(h.log.home,0);
 });
 await t('new target is captured before initToken and overrides restored history',async()=>{
  assert(html.indexOf('let _ADV_WORK=')<html.indexOf('(function initToken()'));
  const h=receiver('#a=fake-access'+key({s:'S',t:'작업 2'}),{history:{old:true}});await h.boot();assert.equal(h.log.restored,0);assert.equal(h.ctx.STATE.cur.tabName,'작업 2');
 });
 await t('logout and expired session clear both queued and unconsumed targets',()=>{
  for(const name of ['logout','_dropSession']){
   const h=receiver('#a=fake-access');
   Object.assign(h.ctx,{_pmLoadGeneration:0,_pmLoadInFlight:null,_NAVCS:{},_NAVRI:{},localStorage:{removeItem(){}},boot(){}});
   h.ctx.STATE.pendingAdvertiserWork={s:'OLD',t:'다른 계정 작업'};h.ctx._ADV_WORK={s:'OLD',t:'남은 주소'};
   vm.runInContext(fn(name),h.ctx);h.ctx[name]();
   assert.equal(h.ctx.STATE.pendingAdvertiserWork,null,name);assert.equal(h.ctx._ADV_WORK,null,name);
  }
 });
 await t('short and legacy access keys survive; work key is consumed only once',async()=>{
  for(const access of['a','adv']){const h=receiver('#'+access+'=fake-access'+key({s:'S',t:'작업 2'}));await h.boot();assert.equal(h.ctx.location.hash,'#'+access+'=fake-access');assert.equal(h.ctx.STATE.pendingAdvertiserWork,null);h.ctx.selTab(2);assert.equal(h.ctx.STATE.cur.tabName,'작업 3');assert.equal(h.ctx.STATE.tabs.length,3);}
 });
 await t('representative advertiser address stays on the existing dashboard',async()=>{
  const h=receiver('#a=fake-access');await h.boot();assert.equal(h.log.opened.length,0);assert.equal(h.log.home,1);assert.equal(h.ctx.location.hash,'#a=fake-access');
 });
 await t('missing, transferred and other-brand targets are not inserted into owned tabs',async()=>{
  const h=receiver('#a=fake-access'+key({s:'OTHER',t:'private'}));await h.boot();assert.equal(h.log.opened.length,0);assert.equal(h.ctx.STATE.tabs.length,3);assert.match(h.log.messages.join(' '),/더 이상|찾지 못|열 수 없/);assert.equal(h.ctx.location.hash,'#a=fake-access');
 });
 await t('summary-only completed work is an authorized target',async()=>{
  const h=receiver('#adv=fake-access'+key({s:'ARCHIVE',t:'완료 작업'}),{summary:{ok:true,items:[{sheetId:'ARCHIVE',tabName:'완료 작업'}]}});await h.boot();assert.equal(h.ctx.STATE.cur.tabName,'완료 작업');assert.equal(h.ctx.STATE.tabs.length,4);
 });
 await t('summary failure is unknown, not permission denied; target survives retry',async()=>{
  const h=receiver('#a=fake-access'+key({s:'ARCHIVE',t:'완료 작업'}),{summary:{ok:false,error:'fake'}});await h.boot();assert.equal(h.log.opened.length,0);assert.match(h.log.messages.join(' '),/불러오지|다시/);assert.match(h.ctx.location.hash,/work=/);assert(h.ctx.STATE.pendingAdvertiserWork);
 });
 await t('tabs query rejection is recoverable and preserves the requested target',async()=>{
  const h=receiver('#a=fake-access'+key({s:'MISSING',t:'작업'}),{rejectTabs:true,summary:{ok:false}});await h.boot();assert.equal(h.log.opened.length,0);assert.match(h.log.messages.join(' '),/불러오지|다시/);assert.match(h.ctx.location.hash,/work=/);
 });
 await t('known owned work still opens when the other query fails',async()=>{
  const h=receiver('#a=fake-access'+key({s:'S',t:'작업 1'}),{summary:{ok:false}});await h.boot();assert.equal(h.ctx.STATE.cur.tabName,'작업 1');
 });
 await t('broken encoding and invalid coordinate types never open a work',async()=>{
  for(const v of['%E0%A4%A','null','[]',encodeURIComponent(JSON.stringify({s:[],t:'X'})),encodeURIComponent(JSON.stringify({s:'S',t:''}))]){const h=receiver('#a=fake-access&work='+v);await h.boot();assert.equal(h.log.opened.length,0);assert.match(h.log.messages.join(' '),/주소|링크/);assert.equal(h.ctx.location.hash,'#a=fake-access');}
 });
 await t('representative URL keeps its exact value; work URL includes only coordinates',()=>{
  const ctx={location:{origin:'https://preview.invalid'},encodeURIComponent,JSON};vm.createContext(ctx);vm.runInContext(fn('_advLinkUrl')+'\n'+fn('_advWorkLinkUrl'),ctx);assert.equal(ctx._advLinkUrl('fake'),'https://preview.invalid/workdesk#a=fake');const u=new URL(ctx._advWorkLinkUrl('fake',{sheetId:'S',tabName:'한글 & "작업"',phone:'never',name:'never'}));const p=new URLSearchParams(u.hash.slice(1));assert.deepEqual(JSON.parse(p.get('work')),{s:'S',t:'한글 & "작업"'});assert.equal(p.get('a'),'fake');
 });
 console.log(`advertiserWorkDeeplink: ${count} passed`);
})().catch(e=>{console.error(e);process.exit(1);});
