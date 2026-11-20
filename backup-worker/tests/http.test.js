import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {env,d,proof,bytes,sha} from './helpers.js';import worker from '../src/index.js';import {admit,MAX_ACTIVE,BUDGET,BASE_RESERVE} from '../src/admission.js';import * as s from '../src/storage.js';
const fixture=JSON.parse(await readFile(new URL('./fixtures/wire-v1.json',import.meta.url)));
const auth=e=>({Authorization:'Bearer '+e.IMAGE_BACKUP_API_KEY});
async function call(e,path,method='GET',body,headers={}){return worker.fetch(new Request('http://localhost'+path,{method,headers:{...auth(e),...headers},body,...(body instanceof ReadableStream?{duplex:'half'}:{})}),e);}
async function upload(e){return call(e,'/v1/objects','PUT',bytes,{'Content-Type':'application/octet-stream','X-Backup-Descriptor':fixture.descriptorHeader});}
test('fixed wire fixture binary PUT, GET, HEAD, receipt; no CORS and safe SVG attachment',async()=>{
 const e=env(),r=await upload(e);assert.equal(r.status,200);const rec=await r.json();assert.deepEqual(rec,fixture.receipt);
 assert.equal(s.canonical({descriptor:d,proof,key:rec.key,sha256:sha,size:3,mime:d.mime}),fixture.canonicalReceiptMaterial);
 const path='/v1/objects/'+Buffer.from(rec.key).toString('base64url');const get=await call(e,path);assert.equal(get.status,200);assert.equal(get.headers.get('content-type'),d.mime);assert.match(get.headers.get('content-disposition'),/^attachment/);assert.match(get.headers.get('content-security-policy'),/sandbox/);assert.equal(get.headers.get('x-content-type-options'),'nosniff');assert.equal(get.headers.get('x-backup-sha256'),sha);assert.equal(get.headers.get('access-control-allow-origin'),null);assert.equal(await get.text(),'abc');
 const head=await call(e,path,'HEAD');assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'3');assert.equal(await head.text(),'');
 const receipt=await call(e,'/v1/manifests/receipts/'+rec.receiptId);assert.deepEqual(await receipt.json(),fixture.receiptDocument);
});
test('entire independent wire fixture joins receipt, part, index and exact current hash/etag',async()=>{
 const e=env();await (await upload(e)).text();
 for(const [part,body,hash] of [['p000000',fixture.manifestPartBodyBase64,fixture.manifestPartSha256],['index',fixture.manifestIndexBodyBase64,fixture.manifestIndexSha256]]){const r=await call(e,'/v1/manifests/'+fixture.currentRequest.generation+'/'+part,'PUT',Buffer.from(body,'base64'),{'content-type':'application/json','x-backup-sha256':hash});assert.equal(r.status,200);await r.text();}
 const r=await call(e,'/v1/manifests/current','PUT',JSON.stringify(fixture.currentRequest),{'content-type':'application/json'});assert.equal(r.status,200);assert.deepEqual(await r.json(),fixture.current);
});
test('copy fixed errors are exact fallback wire; SHA body proof path succeeds',async()=>{
 const e=env();let r=await call(e,'/v1/objects/copy','POST',JSON.stringify(fixture.envelope),{'content-type':'application/json'});assert.equal(r.status,404);assert.deepEqual(await r.json(),fixture.fallbackErrors[0].body);
 await e.SOURCE_IMAGES.put('orig/'+d.fileId,new TextEncoder().encode('abd'));r=await call(e,'/v1/objects/copy','POST',JSON.stringify(fixture.envelope),{'content-type':'application/json'});assert.equal(r.status,409);assert.deepEqual(await r.json(),fixture.fallbackErrors[1].body);
 const p={kind:'drive-sha256',sha256:sha,size:3,sourceVersion:d.sourceVersion};const envelope={v:1,descriptor:d,proof:p};r=await call(e,'/v1/objects','PUT',bytes,{'content-type':'application/octet-stream','x-backup-descriptor':Buffer.from(JSON.stringify(envelope)).toString('base64url')});assert.equal(r.status,200);assert.equal((await r.json()).sha256,sha);
});
test('HTTP strict fields, canonical base64, methods/query/key/URL rejection before storage',async()=>{
 const e=env();for(const [path,method,body,headers] of [
 ['/v1/objects','DELETE'],['/v1/objects','OPTIONS'],['/v1/objects?url=https://evil','PUT',bytes],['/v1/objects','PUT',bytes,{'content-type':'text/html'}],['/v1/objects','PUT',bytes,{'content-type':'application/octet-stream','x-backup-descriptor':fixture.descriptorHeader+'='}],['/v1/objects/copy','POST',JSON.stringify({...fixture.envelope,url:'https://evil'}),{'content-type':'application/json'}],['/v1/objects/'+Buffer.from('orig/'+d.fileId).toString('base64url'),'GET']]){
 const r=await call(e,path,method,body,headers);assert.ok([400,404].includes(r.status));await r.text();}
 assert.equal(e.BACKUP.calls.length,0);assert.equal(e.SOURCE_IMAGES.calls.length,0);
});
test('HTTP manifests/current uses exact pointer request and returns etag',async()=>{
 const e=env();const index={v:1,generation:'1',baseGeneration:null,rootSetHash:'a'.repeat(64),scanComplete:true,parts:[],counts:{total:0}},b=JSON.stringify(index),hash=await s.digest(new TextEncoder().encode(b));
 let r=await call(e,'/v1/manifests/1/index','PUT',b,{'content-type':'application/json','x-backup-sha256':hash});assert.equal(r.status,200);await r.text();
 r=await call(e,'/v1/manifests/current','PUT',JSON.stringify({v:1,generation:'1',baseGeneration:null,expectedEtag:null,indexSha256:hash}),{'content-type':'application/json'});assert.equal(r.status,200);const current=await r.json();assert.equal(current.indexSha256,hash);assert.match(current.etag,/^[a-f0-9]{32}$/);
 r=await call(e,'/v1/manifests/current');assert.deepEqual(await r.json(),current);
 r=await call(e,'/v1/manifests?kind=generations&limit=1');const list=await r.json();assert.ok(Array.isArray(list.items));assert.ok(Object.hasOwn(list,'cursor'));
});
test('an expired older response cannot release the newer request active-body slot',async()=>{
 const e=env();await (await upload(e)).text();const p='/v1/objects/'+Buffer.from(fixture.receipt.key).toString('base64url');
 const original=setTimeout;const timers=[];globalThis.setTimeout=(fn,ms)=>{const t=original(fn,ms);timers.push({fn,t});return t;};
 try {const first=await call(e,p);const old=timers.at(-1);clearTimeout(old.t);old.fn();await new Promise(r=>setImmediate(r));const second=await call(e,p);assert.equal(second.status,200);await first.body.cancel();
  // first's late cancel must not release anyone else's reservation: second + (MAX-1) more fill the isolate exactly.
  const held=[second];for(let i=1;i<MAX_ACTIVE;i++){const r=await call(e,p);assert.equal(r.status,200);held.push(r);}
  const over=await call(e,p);assert.equal(over.status,429);await over.text();for(const r of held)await r.text();}finally{globalThis.setTimeout=original;for(const {t} of timers)clearTimeout(t);}
});
test('bounded per-isolate overlap: MAX_ACTIVE concurrent requests, then BUSY, then releases after body consumed',async()=>{
 const e=env();await (await upload(e)).text();const path='/v1/objects/'+Buffer.from(fixture.receipt.key).toString('base64url');
 const held=[];for(let i=0;i<MAX_ACTIVE;i++){const r=await call(e,path);assert.equal(r.status,200,'request '+(i+1)+' admitted');held.push(r);}
 const first=held.shift();for(const r of held)await r.text();for(let i=0;i<MAX_ACTIVE-1;i++)held[i]=await call(e,path);
 const second=await call(e,path);assert.equal(second.status,429);assert.deepEqual(await second.json(),{v:1,error:{code:'BUSY',retryable:true}});await first.text();const third=await call(e,path);assert.equal(third.status,200);await third.text();for(const r of held)await r.text();
});
test('byte budget: two maximum-size bodies cannot be buffered at once; small requests still fit; release restores',()=>{
 assert.ok(MAX_ACTIVE>=2&&MAX_ACTIVE<=8,'bounded count');assert.ok(BUDGET<=64*1024*1024,'budget well under the 128MB isolate');
 const a=admit(BASE_RESERVE);a.grow(2*s.MAX_BYTES);
 const b=admit(BASE_RESERVE);assert.throws(()=>b.grow(2*s.MAX_BYTES),e=>e.code==='BUSY','second 25MiB body rejected while first buffers');
 b.release();const c=admit(BASE_RESERVE);c.grow(2*1024*1024);c.release();
 a.release();a.release();const d2=admit(BASE_RESERVE);d2.grow(2*s.MAX_BYTES);d2.release();
 const many=[];for(let i=0;i<MAX_ACTIVE;i++){const x=admit(BASE_RESERVE);x.grow(2*4*1024*1024);many.push(x);}
 assert.throws(()=>admit(BASE_RESERVE),e=>e.code==='BUSY','count cap');for(const x of many)x.release();
});
