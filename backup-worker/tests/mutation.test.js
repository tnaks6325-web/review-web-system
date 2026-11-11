import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {env,d,proof,bytes} from './helpers.js';import * as baseline from '../src/storage.js';
const source=await readFile(new URL('../src/storage.js',import.meta.url),'utf8');
async function mutant(old,replacement){assert.ok(source.includes(old),'mutation target must exist');return import('data:text/javascript;base64,'+Buffer.from(source.replace(old,replacement)).toString('base64'));}
test('mutation killed: removing body proof permits same-length wrong original',async()=>{
 const broken=await mutant("if(await digest(bytes,'MD5')!==p.md5)fail('SOURCE_MISMATCH');","/* deliberate isolated mutation: no MD5 proof */");
 const check=async impl=>assert.rejects(()=>impl.putVerifiedObject(env(),{descriptor:d,proof,body:new TextEncoder().encode('abd')}),e=>e.code==='SOURCE_MISMATCH');
 await check(baseline);await assert.rejects(()=>check(broken),e=>e.code==='ERR_ASSERTION');
});
test('mutation killed: removing final R2 CAS lets stale in-flight publisher replace new current',async()=>{
 const broken=await mutant("onlyIf:current?{etagMatches:expectedEtag}:new Headers({'If-None-Match':'*'})","/* deliberate isolated mutation */ onlyIf:undefined");
 async function check(impl){const e=env(),indexBytes=new TextEncoder().encode(JSON.stringify({v:1,generation:'1',baseGeneration:null,rootSetHash:'a'.repeat(64),scanComplete:true,parts:[],counts:{}}));await impl.putManifestPart(e,{generation:'1',part:'index',bytes:indexBytes,sha256:await impl.digest(indexBytes)});
 const put=e.BACKUP.put.bind(e.BACKUP);e.BACKUP.put=async(k,b,o)=>{if(k==='manifests/current'&&!e.BACKUP.objects.has(k))await put(k,new TextEncoder().encode(JSON.stringify({v:1,generation:'2',indexSha256:'b'.repeat(64)})));return put(k,b,o);};
 await assert.rejects(()=>impl.commitManifest(e,{generation:'1',baseGeneration:null,expectedEtag:null,indexBytes}),err=>err.code==='PRECONDITION_FAILED');assert.equal((await impl.readCurrent(e)).generation,'2');}
 await check(baseline);await assert.rejects(()=>check(broken),e=>e.code==='ERR_ASSERTION');
});
