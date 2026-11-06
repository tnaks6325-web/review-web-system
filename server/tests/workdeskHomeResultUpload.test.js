'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const modulePath = path.join(__dirname, '../../frontend/js/home-payment-result.js');
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function api() { return require(modulePath); }
const ID = '12345678-1234-4234-8234-123456789abc';
const file = { name: '결과.xls', size: 100 };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i=0; i<12; i++) await Promise.resolve(); };
test('bounded POST validates target before encoding and preserves generic route', async () => {
  const H=api(); let reads=0; const calls=[];
  const o={readFile:async()=>{ reads++; return 'B64'; }, request:async(p,o)=>{calls.push([p,o]); return {ok:true};},stillCurrent:()=>true};
  await assert.rejects(H.postFile(file,{...o,homeBatchId:'bad'}));
  assert.equal(reads,0); assert.equal(calls.length,0);
  await assert.rejects(H.postFile({...file,size:12*1024*1024+1},{...o,homeBatchId:ID}));
  assert.equal(reads,0);
  await H.postFile(file,{...o,homeBatchId:ID});
  assert.equal(calls[0][0],'/api/trackb/payment/batch/'+ID+'/home-result-auto-apply');
  assert.equal(calls[0][1].method,'POST'); assert.deepEqual(JSON.parse(calls[0][1].body),{fileName:file.name,base64:'B64'});
  await H.postFile(file,o); assert.equal(calls[1][0],'/api/trackb/payment/result-auto-apply');
});
test('projection masks raw accounts, keeps actual counts and renders escaped read-only results', () => {
  const H=api();
  const r={ok:true,autoApplied:true,applied:0,failed:2,notInFile:1,summary:{success:99,alreadyPaid:0},board:{recorded:0,queued:1,skipped:2,failed:3},notified:0,notifyTargets:2,opsWarning:'<ops>',warnings:[{message:'<warn>'}],orderAssigned:[{reviewerName:'<same>',amount:100,count:2}],unmatchedResults:[{accountNumber:'123456789012',memo:'<memo>',amount:50}],items:[{outcome:'paid',tabName:'<img onerror=x>',reviewerName:'<r>',amount:100,accountTail:'123456789012',holder:'<h>',transferredAt:'<time>',resultStatus:'<status>',secret:'SECRET'}],secret:'SECRET'};
  const m=H.project(r,{id:ID,seq:0,bankLabel:'<bank>'},'<file>');
  const serialized=JSON.stringify(m), html=H.render(m);
  assert.equal(m.applied,0); assert.equal(m.alreadyPaid,0); assert.equal(m.fileRows,null);
  assert.equal(H.countText(0),'0'); for(const x of [undefined,null,'',false,'0','1x',-1,1.2,NaN]) assert.equal(H.countText(x),'확인 불가');
  assert.equal(m.items[0].accountTail,'9012'); assert.equal(m.unmatchedResults[0].accountTail,'9012');
  assert.ok(!serialized.includes('123456789012')); assert.ok(!serialized.includes('SECRET')); assert.ok(!('response' in m));
  assert.match(html,/입금완료로 기록[\s\S]*0건/); assert.ok(!html.includes('99건'));
  for(const x of ['&lt;ops&gt;','&lt;warn&gt;','&lt;same&gt;','&lt;memo&gt;','&lt;img onerror=x&gt;','&lt;r&gt;','&lt;h&gt;','&lt;time&gt;','&lt;status&gt;','&lt;bank&gt;','&lt;file&gt;','순서대로 배정','입금일','전송','미확인 이체','분석']) assert.ok(html.includes(x),x);
  assert.equal((html.match(/<button\b/g)||[]).length,1); assert.match(html,/onclick="_tckHomeResultClose\(\)"/);
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('시안')); assert.match(html,/이체결과 확인/);
});
test('held result keeps blockers ahead of alreadyDone without losing warnings', () => {
  const H=api(); const m=H.project({alreadyDone:true,autoApplied:false,autoApply:{blockers:['duplicate_file'],warnings:['<auto>']},warnings:['<parse>']},{id:ID},'x');
  const html=H.render(m); assert.match(html,/<b>자동 반영 보류<\/b>/); assert.match(html,/이미 반영된 동일 결과 파일/); assert.match(html,/&lt;auto&gt;/); assert.match(html,/&lt;parse&gt;/);
});
test('only open bank need_file questions with valid batch and admin roles attach', () => {
 const H=api(), q={kind:'bank_cluster',status:'open',facts:{batch:{id:ID}},lines:[{key:'need_file'}]};
 for(const role of ['admin','master']) assert.equal(H.canAttach(q,role),true);
 for(const role of ['staff','manager','slot',null]) assert.equal(H.canAttach(q,role),false);
 for(const changed of [{status:'done'},{kind:'manager_assignment'},{kind:'workboard_no_slot'},{lines:[]},{facts:{batch:{id:'bad'}}}]) assert.equal(H.canAttach({...q,...changed},'admin'),false);
});
function harness(extra={}) {
 let identity='A', allowed=true, home=true; const models=[], notices=[], requests=[];
 const c=api().createController({identity:()=>identity,allowed:()=>allowed,isHome:()=>home,readFile:async()=> 'B64',request:async(p,o)=>{requests.push([p,o]);return {ok:true,autoApplied:true,applied:0};},load:async()=>({ok:true}),show:m=>models.push(m),notice:m=>notices.push(m),onBusy:()=>{},...extra});
 return {c,models,notices,requests,setIdentity:v=>identity=v,setAllowed:v=>allowed=v,setHome:v=>home=v};
}
test('loader shares exact promise and coalesces writes into one followup with no polling', async()=>{
 const ds=[]; const h=harness({load:()=>{const d=deferred();ds.push(d);return d.promise;}});
 const p=h.c.load(); assert.strictEqual(h.c.load(),p); h.c.load(true);h.c.load(true); await tick(); assert.equal(ds.length,1);
 ds[0].resolve({ok:true});await tick();assert.equal(ds.length,2);
 ds[1].resolve({ok:true});await p;await tick();assert.equal(ds.length,2);
});
test('write during followup queues another refresh and old flight cannot clear new flight',async()=>{
 const ds=[]; const h=harness({load:()=>{const d=deferred();ds.push(d);return d.promise;}});
 const old=h.c.load();h.c.load(true);await tick();ds[0].resolve();await tick();h.c.load(true);ds[1].resolve();await tick();assert.equal(ds.length,3);ds[2].resolve();await old;
 const a=h.c.load();await tick();h.c.reset();const b=h.c.load();await tick();ds[3].resolve();await a;assert.strictEqual(h.c.load(),b);ds[4].resolve();await b;await tick();assert.equal(ds.length,5);
});
test('upload succeeds once, freezes batch target, refresh failure preserves financial model',async()=>{
 const d=deferred();let loads=0;const h=harness({readFile:()=>d.promise,load:async()=>{loads++;throw Error('bank query failed');}});
 const t={id:ID,seq:7};const p=h.c.upload(file,t);assert.equal(h.c.isBusy(ID),true);
 t.id='bad';t.seq=99;await h.c.upload(file,{id:ID,seq:8});d.resolve('B64');const out=await p;
 assert.equal(h.requests.length,1);assert.equal(h.models.length,1);assert.equal(h.models[0].batchSeq,7);assert.equal(out.model,h.models[0]);assert.equal(loads,1);assert.match(h.notices.join(' '),/질문.*새로/);assert.ok(!h.notices.join(' ').includes('반영 여부 확인 불가'));assert.equal(h.c.isBusy(ID),false);
});
test('account changes during file read prevent POST',async()=>{
 const d=deferred();const h=harness({readFile:()=>d.promise});const p=h.c.upload(file,{id:ID});h.setIdentity('B');d.resolve('B64');await p;assert.equal(h.requests.length,0);assert.equal(h.models.length,0);assert.equal(h.notices.length,0);
});
test('file picker old generation does not encode or POST',async()=>{
 let reads=0;const h=harness({readFile:async()=>{reads++;return 'B64';}}),s=h.c.capture();h.c.reset();await h.c.upload(file,{id:ID},s);assert.equal(reads,0);assert.equal(h.requests.length,0);
});
test('old response cannot show models notices or refresh after identity changes',async()=>{
 const d=deferred();let loads=0;const h=harness({request:()=>d.promise,load:async()=>{loads++;}});const p=h.c.upload(file,{id:ID});await tick();h.setIdentity('B');d.resolve({ok:true,autoApplied:true});await p;assert.equal(h.models.length,0);assert.equal(h.notices.length,0);assert.equal(loads,0);
});
test('never settling unauthorized request does not keep reset session locked',async()=>{
 let calls=0;const h=harness({request:()=>{calls++;return calls===1?new Promise(()=>{}):Promise.resolve({ok:true,autoApplied:true});}});
 h.c.upload(file,{id:ID});await tick();assert.equal(h.c.isBusy(ID),true);h.c.reset();h.setIdentity('B');assert.equal(h.c.isBusy(ID),false);await h.c.upload(file,{id:ID});assert.equal(calls,2);assert.equal(h.models.length,1);
});
test('old finally cannot unlock a newer upload',async()=>{
 const ds=[deferred(),deferred()];let n=0;const h=harness({request:()=>ds[n++].promise});const a=h.c.upload(file,{id:ID});await tick();h.c.reset();const b=h.c.upload(file,{id:ID});await tick();ds[0].reject(Error('old'));await a;assert.equal(h.c.isBusy(ID),true);await h.c.upload(file,{id:ID});assert.equal(n,2);ds[1].resolve({ok:true});await b;assert.equal(h.c.isBusy(ID),false);
});
test('old server 404 and unknown POST outcome never fallback or retry',async()=>{
 for(const response of [{ok:false,status:404},null,{ok:1}]){let calls=0;const h=harness({request:async()=>{calls++;return response;}});await h.c.upload(file,{id:ID});assert.equal(calls,1);assert.equal(h.models.length,0);assert.match(h.notices.join(' '),/반영 여부 확인 불가/);}
 let calls=0;const h=harness({request:async()=>{calls++;throw Error('lost response');}});await h.c.upload(file,{id:ID});assert.equal(calls,1);assert.match(h.notices.join(' '),/반영 여부 확인 불가/);
});
test('permission loss and leaving home during read stop upload',async()=>{
 for(const change of ['setAllowed','setHome']){const d=deferred();const h=harness({readFile:()=>d.promise});const p=h.c.upload(file,{id:ID});h[change](false);d.resolve('B64');await p;assert.equal(h.requests.length,0);}
});
test('held preview analysis comes from summary but never invents newly applied count',()=>{
 const H=api(),m=H.project({autoApplied:false,summary:{success:8,failed:2,notInFile:0}}, {id:ID},'x');
 assert.equal(m.applied,null);assert.equal(m.failed,2);assert.equal(m.notInFile,0);
 const done=H.render(H.project({autoApplied:true,applied:8,board:{recorded:3,queued:0,failed:0,skipped:0}},{id:ID},'x'));
 assert.match(done,/입금일 미기록 5건/);
});
test('direct transport checks session before and after encoding and never retries 404',async()=>{
 const H=api();let reads=0,posts=0,current=false;const d=deferred(),o={readFile:()=>{reads++;return d.promise;},request:async()=>{posts++;return {ok:false,status:404};},homeBatchId:ID,stillCurrent:()=>current};
 assert.equal(await H.postFile(file,o),null);assert.equal(reads,0);current=true;const p=H.postFile(file,o);current=false;d.resolve('B64');assert.equal(await p,null);assert.equal(posts,0);
 current=true;const r=await H.postFile(file,{...o,readFile:async()=> 'B64'});assert.equal(r.status,404);assert.equal(posts,1);
});
test('browser global exact API is self-contained and no financial loader is referenced',()=>{
 const src=fs.readFileSync(modulePath,'utf8'), ctx={window:{}};vm.runInNewContext(src,ctx);
 assert.deepEqual(Object.keys(ctx.window.HomePaymentResult).sort(),['validBatchId','canAttach','postFile','project','countText','render','createController'].sort());
 assert.ok(!/_pmLoad|_pmBankRefresh|_pmResultModal|fetch\(|console\.|localStorage|sessionStorage/.test(src));
 for(const id of [null,undefined,ID+' ',ID.replace(/-/g,''),'../'+ID]) assert.equal(api().validBatchId(id),false);
 assert.equal(api().validBatchId(ID.toUpperCase()),true);
});
test('busy repaint errors are best effort and cannot block result',async()=>{
 const h=harness({onBusy:()=>{throw Error('paint');}});await h.c.upload(file,{id:ID});assert.equal(h.requests.length,1);assert.equal(h.models.length,1);assert.equal(h.c.isBusy(ID),false);
});
test('reset drops queued followup and role loss stops loader continuation',async()=>{
 let calls=0;const d=deferred(),h=harness({load:()=>{calls++;return d.promise;}});const s=h.c.capture(),p=h.c.load();h.c.load(true);await tick();h.c.reset();d.resolve();await p;await tick();assert.equal(calls,1);assert.equal(h.c.current(s),false);
 h.setAllowed(false);await h.c.load();assert.equal(calls,1);
});
test('resolved failed bank refresh warns without discarding the received financial result',async()=>{
 const h=harness({load:async()=>({ok:false})});const out=await h.c.upload(file,{id:ID});
 assert.equal(h.models.length,1);assert.strictEqual(out.model,h.models[0]);assert.match(h.notices.join(' '),/질문.*새로/);assert.doesNotMatch(h.notices.join(' '),/반영 여부 확인 불가/);
});
test('confirmed wrong-batch rejection tells the user to choose the correct file without retry',async()=>{
 const h=harness({request:async(p,o)=>{h.requests.push([p,o]);return {ok:false,code:'wrong_batch'};}});
 await h.c.upload(file,{id:ID});assert.equal(h.requests.length,1);assert.equal(h.models.length,0);assert.match(h.notices.join(' '),/선택한 대량이체의 결과가 아닙니다/);assert.doesNotMatch(h.notices.join(' '),/반영 여부 확인 불가/);
});
(async()=>{let failures=0; for(const [name,fn] of tests){try{let timer; try { await Promise.race([Promise.resolve().then(fn), new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('test did not settle')),1500);})]); } finally {clearTimeout(timer);} console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+'\n'+e.stack);}} console.log(`${tests.length} cases, ${failures} failed`);process.exitCode=failures?1:0;})();
