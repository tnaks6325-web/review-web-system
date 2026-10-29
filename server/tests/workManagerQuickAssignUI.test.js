'use strict';
// Local-only fake UI regression: execute actual frontend functions, not a reimplementation.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'../../frontend/workdesk.html'),'utf8');
const modal=fs.readFileSync(path.join(__dirname,'../../frontend/js/work-order-detail.js'),'utf8');
const code=src.slice(src.indexOf('const _cndManagerPending='),src.indexOf('/* ══ 공고 없는 작업의 설정 3종'));
assert.ok(code.includes('async function _cndAssignManager'));
function setup(){
 const t={sheetId:'FAKE',tabName:'가짜 작업',tabGid:'FAKE'},cd={workOrderId:'wo_FAKE',manager:{adminNick:''},managerEdit:{capable:true,workOrderId:'wo_FAKE',syncVersion:19}};
 const log={writes:[],alerts:[],rendered:[],toasts:[]},buttons=[{},{}];
 const x={STATE:{cur:t,wd:{condition:cd},canEdit:true,role:'master',wo:[{id:'wo_FAKE',work_manager:'랜덤'}]},Number,String,Set,Array,JSON,
 document:{querySelectorAll:()=>buttons},alert:m=>log.alerts.push(m),_toast:m=>log.toasts.push(m),renderWorkdesk:w=>log.rendered.push(w),
 api:async(url,opts)=>{if(opts&&opts.method==='PUT'){log.writes.push(JSON.parse(opts.body));return {ok:true,data:{id:'wo_FAKE',work_manager:'박세희'}};}return {ok:true,condition:{manager:{adminNick:'만두'}}};}};
 vm.createContext(x);vm.runInContext(code,x);return {x,cd,t,log,buttons};
}
let tests=0;
async function test(name,fn){await fn();tests++;console.log('✓ '+name);}
function plain(v){return JSON.parse(JSON.stringify(v));}
function doc(){
 const created=[];function el(tag){const n={tag,children:[],style:{},listeners:{},value:'',appendChild(c){this.children.push(c);return c;},addEventListener(e,f){(this.listeners[e]??=[]).push(f);},remove(){this.removed=true;}};created.push(n);return n;}
 return {created,body:el('body'),createElement:el,getElementById:()=>null};
}
function modalSetup(o,opts){const document=doc(),alerts=[];const x={document,console,Promise,alert:m=>alerts.push(m)};x.window=x;vm.createContext(x);vm.runInContext(modal,x);x.woAdminEditModal(o,opts);return {x,document,alerts};}
async function click(node){for(const f of node.listeners.click||[])await f({});await new Promise(r=>setImmediate(r));}
(async()=>{
 await test('permission, capability, archive and exact order identity fail closed',()=>{
  const {x,cd}=setup();assert.equal(x._cndManagerGate(cd),true);assert.equal((x._cndManagerButtons(cd).match(/class="cndmgrbtn"/g)||[]).length,2);
  for(const role of ['staff','advertiser','']){x.STATE.role=role;assert.equal(x._cndManagerButtons(cd),'');}
  x.STATE.role='admin';x.STATE.wd.archived=true;assert.equal(x._cndManagerButtons(cd),'');x.STATE.wd.archived=false;
  for(const change of [{managerEdit:undefined},{managerEdit:{capable:true,workOrderId:'other',syncVersion:19}},{managerEdit:{capable:true,workOrderId:'wo_FAKE',syncVersion:'bad'}}])assert.equal(x._cndManagerButtons({...cd,...change}),'');
 });
 await test('quick save sends manager only with displayed base version, then re-reads',async()=>{
  const {x,log,buttons}=setup();await x._cndAssignManager('박세희');assert.deepEqual(log.writes,[{id:'wo_FAKE',work_manager:'박세희',manager_base_version:19,manager_capable:1}]);assert.equal(log.rendered.length,1);assert.equal(buttons[0].disabled,false);assert.equal(x.STATE.wo[0].work_manager,'박세희');
 });
 await test('direct unauthorized calls and invalid names issue zero requests',async()=>{
  const {x,log}=setup();x.STATE.role='staff';await x._cndAssignManager('박세희');x.STATE.role='master';await x._cndAssignManager('evil');assert.equal(log.writes.length,0);
 });
 await test('failure does not change displayed manager; unlocks controls for retry',async()=>{
  const {x,log,cd,buttons}=setup();x.api=async()=>({ok:false,error:'가짜 저장 실패'});await x._cndAssignManager('박은비');assert.equal(cd.manager.adminNick,'');assert.equal(log.rendered.length,0);assert.equal(log.alerts[0],'가짜 저장 실패');assert.equal(buttons[0].disabled,false);
 });
 await test('duplicate click while saving is ignored and late response cannot redraw another tab',async()=>{
  const {x,log,cd}=setup();let resolve,requests=0;x.api=()=>{requests++;return new Promise(r=>resolve=r);};const pending=x._cndAssignManager('박세희');await x._cndAssignManager('박은비');assert.equal(requests,1);x.STATE.cur={sheetId:'FAKE-other',tabName:'다른 가짜 작업'};resolve({ok:true,data:{id:'wo_FAKE',work_manager:'박세희'}});await pending;assert.equal(log.rendered.length,0);assert.equal(cd.manager.adminNick,'');
 });
 await test('readback failure says save happened without claiming fresh screen',async()=>{
  const {x,log}=setup();let n=0;x.api=async()=>++n===1?{ok:true,data:{id:'wo_FAKE'}}:{ok:false};await x._cndAssignManager('박세희');assert.ok(log.alerts[0].includes('저장됐지만'));assert.equal(log.rendered.length,0);
 });
 await test('legacy linked modal and unauthorized modal expose no manager pills',()=>{
  for(const options of [{},{canAssignManager:true}]){const {document}=modalSetup({id:'FAKE',source_review_order_id:'IA-FAKE',work_manager:'박세희'},options);assert.equal(document.created.filter(n=>n.tag==='button'&&['만두','망고'].includes(n.textContent)).length,0);}
  const {document}=modalSetup({id:'FAKE',source_review_order_id:'IA-FAKE',manager_edit_capable:true},{});assert.equal(document.created.filter(n=>n.tag==='button'&&['만두','망고'].includes(n.textContent)).length,0);
 });
 await test('capable linked modal manager changes carry capability and base version only',async()=>{
  let sent;const {document}=modalSetup({id:'FAKE',source_review_order_id:'IA-FAKE',manager_edit_capable:true,sync_version:34,work_manager:'박세희'}, {canAssignManager:true,save:async f=>{sent=plain(f);return {ok:true};}});await click(document.created.find(n=>n.tag==='button'&&n.textContent==='망고'));await click(document.created.find(n=>n.tag==='button'&&n.textContent==='저장'));assert.deepEqual(sent,{work_manager:'박은비',manager_capable:1,manager_base_version:34});
 });
 await test('same nickname is not a spurious manager edit and sync throw leaves retry enabled',async()=>{
  let calls=0;const {document,alerts}=modalSetup({id:'FAKE',source_review_order_id:'IA-FAKE',manager_edit_capable:true,sync_version:34,work_manager:'만두'}, {canAssignManager:true,save:()=>{calls++;throw Error('FAKE network');}});await click(document.created.find(n=>n.tag==='button'&&n.textContent==='만두'));const save=document.created.find(n=>n.tag==='button'&&n.textContent==='저장');await click(save);assert.equal(calls,0);await click(document.created.find(n=>n.tag==='button'&&n.textContent==='망고'));await click(save);assert.equal(calls,1);assert.equal(save.disabled,false);assert.ok(alerts.some(a=>a.includes('FAKE network')));
 });
 console.log(`${tests} UI regression tests passed`);
})().catch(e=>{console.error(e);process.exit(1);});
