import test from 'node:test';import assert from 'node:assert/strict';import {env,d,proof,bytes,sha} from './helpers.js';import * as s from '../src/storage.js';
const enc=new TextEncoder(),j=x=>enc.encode(JSON.stringify(x));
async function index(e,g,base=null){const b=j({v:1,generation:g,baseGeneration:base,rootSetHash:'a'.repeat(64),scanComplete:true,parts:[],counts:{total:0}});await s.putManifestPart(e,{generation:g,part:'index',bytes:b,sha256:await s.digest(b)});return b;}
const rejects=(f,c)=>assert.rejects(f,e=>e.code===c);
test('manifest part immutable bytes + receipts pagination support DB-free discovery',async()=>{
 assert.equal(typeof s.putManifestPart,'function');const e=env(),r=await s.putVerifiedObject(e,{descriptor:d,proof,body:bytes});
 const b=j({v:1,generation:'1',part:'p000000',entries:[{receiptId:r.receiptId,key:r.key,fileId:d.fileId,sha256:sha,size:3,mime:d.mime,descriptor:d,proof,presence:'observed'}]});
 const part=await s.putManifestPart(e,{generation:'1',part:'p000000',bytes:b,sha256:await s.digest(b)});assert.equal(part.size,b.length);assert.deepEqual((await s.readManifest(e,{generation:'1',part:'p000000'})).bytes,b);
 assert.deepEqual(await s.putManifestPart(e,{generation:'1',part:'p000000',bytes:b,sha256:await s.digest(b)}),part);
 const rb=await s.getReceipt(e,{receiptId:r.receiptId});assert.equal(JSON.parse(new TextDecoder().decode(rb.bytes)).object.receiptId,r.receiptId);
 const list=await s.listManifests(e,{kind:'receipts',limit:1});assert.equal(list.items.length,1);assert.equal(list.truncated,false);assert.equal(list.cursor,null);
 const renamed={...d,name:'renamed'};await s.putVerifiedObject(e,{descriptor:renamed,proof,body:bytes});const first=await s.listManifests(e,{kind:'receipts',limit:1});assert.equal(first.truncated,true);const second=await s.listManifests(e,{kind:'receipts',limit:1,cursor:first.cursor});assert.equal(second.truncated,false);assert.notEqual(first.items[0].key,second.items[0].key);
});
test('current first create, BigInt monotonic CAS, delayed generation and exact retry recovery',async()=>{
 assert.equal(typeof s.commitManifest,'function');const e=env(),g='9007199254740993',next='9007199254740994';assert.equal(await s.readCurrent(e),null);
 const b=await index(e,g);const a=await s.commitManifest(e,{generation:g,baseGeneration:null,expectedEtag:null,indexBytes:b});assert.equal(a.generation,g);assert.equal(a.indexSha256,await s.digest(b));
 assert.deepEqual(await s.commitManifest(e,{generation:g,baseGeneration:null,expectedEtag:null,indexBytes:b}),a);
 const n=await index(e,next,g);await rejects(()=>s.commitManifest(e,{generation:next,baseGeneration:g,expectedEtag:'wrong',indexBytes:n}),'PRECONDITION_FAILED');
 const c=await s.commitManifest(e,{generation:next,baseGeneration:g,expectedEtag:a.etag,indexBytes:n});assert.equal(c.generation,next);await rejects(()=>s.commitManifest(e,{generation:g,baseGeneration:null,expectedEtag:null,indexBytes:b}),'PRECONDITION_FAILED');assert.equal((await s.readCurrent(e)).generation,next);
});
test('conditional null never becomes successful current; two publishers one CAS winner',async()=>{
 assert.equal(typeof s.commitManifest,'function');let e=env(),b=await index(e,'1');e.BACKUP.nullPut=true;await rejects(()=>s.commitManifest(e,{generation:'1',baseGeneration:null,expectedEtag:null,indexBytes:b}),'PRECONDITION_FAILED');
 e=env();b=await index(e,'1');const get=e.BACKUP.get.bind(e.BACKUP);let waiting=0,release;const barrier=new Promise(r=>release=r);e.BACKUP.get=async key=>{if(key==='manifests/current'){const snapshot=await get(key);if(++waiting===2)release();await barrier;return snapshot;}return get(key);};const results=await Promise.allSettled([s.commitManifest(e,{generation:'1',baseGeneration:null,expectedEtag:null,indexBytes:b}),s.commitManifest(e,{generation:'1',baseGeneration:null,expectedEtag:null,indexBytes:b})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'PRECONDITION_FAILED');
});
test('duplicate receipt IDs, mismatched receipt/key and immutable generation conflicts rejected',async()=>{
 const e=env(),r=await s.putVerifiedObject(e,{descriptor:d,proof,body:bytes}),entry={receiptId:r.receiptId,key:r.key,fileId:d.fileId,sha256:sha,size:3,mime:d.mime,descriptor:d,proof,presence:'observed'};
 for(const entries of [[entry,entry],[{...entry,key:entry.key.replace('v1/internal','v1/work')}],[{...entry,receiptId:'a'.repeat(64)}]]){const b=j({v:1,generation:'1',part:'p000000',entries});await rejects(async()=>s.putManifestPart(e,{generation:'1',part:'p000000',bytes:b,sha256:await s.digest(b)}),'BAD_DESCRIPTOR');}
 const b=await index(e,'1'),different=j({...JSON.parse(new TextDecoder().decode(b)),counts:{total:1}});await rejects(async()=>s.putManifestPart(e,{generation:'1',part:'index',bytes:different,sha256:await s.digest(different)}),'KEY_CONFLICT');
});
test('manifest schema, unknown fields, duplicate receipts, hash, limits and index base rejected',async()=>{
 assert.equal(typeof s.putManifestPart,'function');const e=env();for(const value of [{v:1,generation:'1',part:'p000000',entries:[],url:'https://evil/'},{v:1,generation:'01',part:'p000000',entries:[]}]){const b=j(value);await rejects(async()=>s.putManifestPart(e,{generation:'1',part:'p000000',bytes:b,sha256:await s.digest(b)}),'BAD_DESCRIPTOR');}
 const b=await index(e,'1');await rejects(async()=>s.putManifestPart(e,{generation:'2',part:'index',bytes:b,sha256:'b'.repeat(64)}),'VERIFY_FAILED');
 await rejects(async()=>s.putManifestPart(e,{generation:'1',part:'p000000',bytes:new Uint8Array(256*1024+1),sha256:'a'.repeat(64)}),'TOO_LARGE');
 await rejects(()=>s.commitManifest(e,{generation:'1',baseGeneration:'2',expectedEtag:null,indexBytes:b}),'BAD_DESCRIPTOR');
});
