'use strict';
// Entry wiring only: the real controller has its own behavioral/transaction-boundary suite.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const html=fs.readFileSync(path.resolve(__dirname,'../../frontend/workdesk.html'),'utf8');
const HomePaymentResult=require('../../frontend/js/home-payment-result');
const ID='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
function fn(n,optional=false){const m=new RegExp('(?:async )?function '+n+'\\(').exec(html);if(!m){if(optional)return '';assert.fail('Missing entry '+n);}let i=html.indexOf('{',m.index),d=0;for(;i<html.length;i++){if(html[i]==='{')d++;else if(html[i]==='}'&&--d===0)return html.slice(m.index,i+1);}assert.fail(n);}
function ctx(){
 const log={uploads:[],loads:[],inputs:[],messages:[],paint:0,reset:0};let valid=true;
 const controller={capture:()=>({identity:'fake-user'}),current:()=>valid,reset(){log.reset++;valid=false;},load:async force=>{log.loads.push(force);},upload:async(f,t,s)=>{log.uploads.push({file:f,target:{...t},session:s});},isBusy:()=>false};
 const c={STATE:{role:'admin',view:'home',tckView:[],tckItems:[]},_TCK_HOME:null,_tckBusy:false,JSON,Map,Promise,
  esc:x=>String(x??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  TCK_CHOICES:[],token:()=> 'fake-session',toast:m=>log.messages.push(m),
  _tckPaint:()=>log.paint++,_tckSheetClose(){},
  document:{getElementById:()=>null,createElement:()=>({files:[],click(){log.inputs.push(this);}}),body:{appendChild(){}}},
  window:{HomePaymentResult:{...HomePaymentResult,createController:o=>{log.options=o;return controller;}}},
  api:async()=>({ok:true,items:[]}),_pmFileB64:async()=> 'fake-b64'
 };
 vm.createContext(c);
 const names=['_tckTitle','_tckSub','_tckNum','_tckWhen','_tckCardHtml','_tckHtml','_tckVisible','_tckCompact',
  '_tckHomeAllowed','_tckHomeController','_tckHomeSession','_tckHomeCurrent','_tckHomeReset','_tckHomeTarget','_tckUploadPick','_tckUploadDrop','_tckHomeUploadHtml','_tckHomeResultShow','_tckHomeResultClose','_tckLoad','_tckLoadOnce'];
 vm.runInContext('var _TCK_MQ=null;\n'+names.map(n=>fn(n,true)).join('\n'),c);
 return {c,log,controller,invalidate(){valid=false;}};
}
function card(id=ID){return {id:7,kind:'bank_cluster',status:'open',facts:{batch:{id,seq:85},bank:'kbank'},lines:[{key:'need_file',text:'결과 파일 대기'}],answers:{}};}
let passed=0;async function t(n,f){await f();passed++;console.log('  ✓ '+n);}
(async()=>{
 await t('home need-file card renders real attachment and bounded card drop entry',()=>{
  const {c}=ctx();const s=c._tckCardHtml(card(),0,'home');assert.match(s,/onclick="_tckUploadPick\(0\)"/);assert.match(s,/ondrop="_tckUploadDrop\(event,0\)"/);assert.match(s,/이체결과 파일 첨부/);
  assert.doesNotMatch(c._tckCardHtml(card(),0,'payment'),/_tckUploadPick|_tckUploadDrop/);
 });
 await t('picker freezes the batch before opening the file chooser',async()=>{
  const {c,log}=ctx();c.STATE.tckView=[card()];c._tckUploadPick(0);assert.equal(log.inputs.length,1);
  c.STATE.tckView=[card(OTHER)];const input=log.inputs[0];input.files=[{name:'fake-bank.xlsx',size:10}];await input.onchange();assert.equal(log.uploads.length,1);assert.equal(log.uploads[0].target.id,ID);
 });
 await t('drop consumes propagation and accepts exactly one file for the captured card',async()=>{
  const {c,log}=ctx();c.STATE.tckView=[card()];let stopped=0,prevented=0;
  const event=files=>({preventDefault(){prevented++;},stopPropagation(){stopped++;},currentTarget:{classList:{remove(){}}},dataTransfer:{files}});
  await c._tckUploadDrop(event([{name:'fake.xlsx',size:10}]),0);assert.equal(log.uploads[0].target.id,ID);
  await c._tckUploadDrop(event([{name:'a'},{name:'b'}]),0);assert.equal(log.uploads.length,1);assert.equal(stopped,2);assert.equal(prevented,2);
 });
 await t('controller receives no payment loader, bank sync or financial modal callback',()=>{
  const {c,log}=ctx();c._tckHomeController();assert.equal(typeof log.options.load,'function');assert.equal(typeof log.options.show,'function');assert.equal(log.options.readFile,c._pmFileB64);assert.equal(log.options.request,c.api);
  for(const n of ['_pmLoad','_pmBankRefresh','_pmResultModal'])assert.doesNotMatch(fn('_tckHomeController'),new RegExp(n));
 });
 await t('after-write reload is forwarded to the controller queue',async()=>{
  const {c,log}=ctx();await c._tckLoad(true);assert.deepEqual(log.loads,[true]);
 });
 await t('bank refresh failure preserves previous records and shows explicit uncertainty',async()=>{
  const {c}=ctx();c.STATE.tckItems=[card()];c.api=async()=>({ok:false,error:'fake failure'});const out=await c._tckLoadOnce(c._tckHomeSession());assert.equal(out?.ok,false,'query failure must be observable without rejecting the general home loader');
  assert.equal(c.STATE.tckItems.length,1);assert.match(c.STATE.tckError,/fake failure/);assert.match(c._tckHtml('home'),/불러오지|갱신하지/);assert.doesNotMatch(c._tckHtml('home'),/지금 확인할 것이 없습니다/);
 });
 await t('late response after session change cannot replace bank questions',async()=>{
  const h=ctx();h.c.STATE.tckItems=[card()];let resolve;h.c.api=()=>new Promise(r=>resolve=r);const loading=h.c._tckLoadOnce(h.c._tckHomeSession());h.invalidate();resolve({ok:true,items:[]});await loading;assert.equal(h.c.STATE.tckItems.length,1);
 });
 await t('home-module loads before the inline app boot and both session exits reset it',()=>{
  assert(html.indexOf('src="js/home-payment-result.js')>=0);assert(html.indexOf('src="js/home-payment-result.js')<html.indexOf('const TEST_AUTO_LOGIN_HOST'));
  for(const n of ['logout','_dropSession'])assert.match(fn(n),/_tckHomeReset\(/);
 });
 console.log(`workdeskHomeResultEntry: ${passed} passed`);
})().catch(e=>{console.error(e);process.exit(1);});
