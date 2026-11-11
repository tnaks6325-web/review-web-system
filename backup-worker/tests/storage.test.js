import test from 'node:test';import assert from 'node:assert/strict';
import {bytes,d,proof,sha,env} from './helpers.js';
import * as s from '../src/storage.js';
const args={descriptor:d,proof,body:bytes};
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('put verifies body proof, awaits actual R2 body rehash and immutable receipt',async()=>{
 assert.equal(typeof s.putVerifiedObject,'function');const e=env();const r=await s.putVerifiedObject(e,args);
 assert.equal(r.sha256,sha);assert.equal(r.verified,true);assert.equal(r.objectEtag,'900150983cd24fb0d6963f7d28e17f72');assert.match(r.receiptId,/^[a-f0-9]{64}$/);
 const stored=e.BACKUP.objects.get('manifests/receipts/'+r.receiptId+'.json');assert.deepEqual(JSON.parse(new TextDecoder().decode(stored.data)),{v:1,descriptor:d,proof,object:r});
 const puts=e.BACKUP.calls.filter(x=>x[0]==='put');assert.equal(puts.length,2);for(const p of puts)assert.equal(p[2].onlyIf.get('If-None-Match'),'*');
 assert.equal(puts[0][2].sha256,sha);assert.deepEqual(await s.putVerifiedObject(e,args),r);
});
test('copy reads only fixed orig path and verifies MD5 or SHA bytes not source metadata',async()=>{
 assert.equal(typeof s.copyVerifiedOrig,'function');const e=env();await rejects(()=>s.copyVerifiedOrig(e,{descriptor:d,proof}),'SOURCE_MISSING');
 await e.SOURCE_IMAGES.put('orig/'+d.fileId,bytes);const r=await s.copyVerifiedOrig(e,{descriptor:d,proof});assert.equal(r.sha256,sha);
 assert.deepEqual(e.SOURCE_IMAGES.calls.filter(x=>x[0]!=='put').map(x=>x.slice(0,2)),[['get','orig/'+d.fileId],['get','orig/'+d.fileId]]);
 e.SOURCE_IMAGES.objects.get('orig/'+d.fileId).data=new TextEncoder().encode('abd');await rejects(()=>s.copyVerifiedOrig(e,{descriptor:d,proof}),'SOURCE_MISMATCH');
});
test('put null alone is failure; crash after object before receipt is repairable on retry',async()=>{
 assert.equal(typeof s.putVerifiedObject,'function');let e=env();e.BACKUP.nullPut=true;await rejects(()=>s.putVerifiedObject(e,args),'VERIFY_FAILED');
 e=env();e.BACKUP.receiptFail=true;await rejects(()=>s.putVerifiedObject(e,args),'STORE_UNAVAILABLE');assert.equal(e.BACKUP.objects.size,1);e.BACKUP.receiptFail=false;const r=await s.putVerifiedObject(e,args);assert.equal(e.BACKUP.objects.size,2);assert.equal(r.verified,true);
});
test('proof mismatch, readback corruption and immutable key collision never succeed',async()=>{
 assert.equal(typeof s.putVerifiedObject,'function');const e=env();await rejects(()=>s.putVerifiedObject(e,{...args,body:new TextEncoder().encode('abd')}),'SOURCE_MISMATCH');assert.equal(e.BACKUP.calls.length,0);
 e.BACKUP.corruptGet=true;await rejects(()=>s.putVerifiedObject(e,args),'VERIFY_FAILED');e.BACKUP.corruptGet=false;e.BACKUP.objects.get(s.buildObjectKey({descriptor:d,sha256:sha})).data=new TextEncoder().encode('abd');await rejects(()=>s.putVerifiedObject(e,args),'KEY_CONFLICT');
});
test('unknown fields, proof version, excluded ancestor, invalid MIME and byte budget rejected',async()=>{
 assert.equal(typeof s.putVerifiedObject,'function');const e=env();
 for(const descriptor of [{...d,url:'https://evil/'},{...d,size:-1},{...d,mime:'text/html'},{...d,sourceVersion:'6'},{...d,chain:[{id:d.rootId,name:'r',x:1}]}])await rejects(()=>s.putVerifiedObject(e,{...args,descriptor}),'BAD_DESCRIPTOR');
 e.IMAGE_BACKUP_EXCLUDED_ROOT_IDS=JSON.stringify([d.chain[1].id]);await rejects(()=>s.putVerifiedObject(e,args),'SCOPE_DENIED');
 e.IMAGE_BACKUP_EXCLUDED_ROOT_IDS='[]';await rejects(()=>s.putVerifiedObject(e,{...args,descriptor:{...d,size:25*1024*1024+1},proof:{...proof,size:25*1024*1024+1}}),'TOO_LARGE');
 assert.equal(e.BACKUP.calls.length,0);assert.equal(e.SOURCE_IMAGES.calls.length,0);
});
test('empty or malformed root configuration fails closed before either bucket',async()=>{
 for(const value of ['[]','bad-json','{}','[12345678901]']){const e=env();e.IMAGE_BACKUP_ALLOWED_ROOT_IDS=value;await rejects(()=>s.putVerifiedObject(e,args),'SCOPE_DENIED');assert.equal(e.BACKUP.calls.length,0);assert.equal(e.SOURCE_IMAGES.calls.length,0);}
});
test('Drive identifiers are strings not numbers coerced by regular expressions',async()=>{
 const e=env();await rejects(()=>s.putVerifiedObject(e,{...args,descriptor:{...d,fileId:12345678901}}),'BAD_DESCRIPTOR');assert.equal(e.BACKUP.calls.length,0);
});
test('get and head use only generated-key grammar and return wire metadata',async()=>{
 assert.equal(typeof s.getObject,'function');const e=env(),r=await s.putVerifiedObject(e,args);
 const o=await s.getObject(e,{key:r.key,head:false});assert.equal(o.sha256,sha);assert.equal(o.mime,d.mime);assert.equal(await new Response(o.body).text(),'abc');
 const h=await s.getObject(e,{key:r.key,head:true});assert.equal(h.body,null);assert.equal(h.size,3);await rejects(()=>s.getObject(e,{key:'orig/'+d.fileId,head:true}),'BAD_DESCRIPTOR');
});
