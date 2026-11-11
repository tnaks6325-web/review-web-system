// LOCAL TEST ENTRY ONLY. Never use this config/entry as a deployment target.
import worker from '../../src/index.js';
import * as storage from '../../src/storage.js';
let mode='normal';const counts={sourceGet:0,sourceHead:0,sourcePut:0,sourceDelete:0,backupGet:0,backupHead:0,backupList:0,backupPut:0,backupNull:0};
function wrapped(env) {
 const source={get:key=>{counts.sourceGet++;return env.SOURCE_IMAGES.get(key);},head:key=>{counts.sourceHead++;return env.SOURCE_IMAGES.head(key);},put(){counts.sourcePut++;throw Error('source write forbidden');},delete(){counts.sourceDelete++;throw Error('source delete forbidden');}};
 const backup={
  async put(key,...args){counts.backupPut++;if(mode==='put-null'){counts.backupNull++;return null;}if(mode==='receipt-fail'&&key.startsWith('manifests/receipts/'))throw Error('injected receipt crash');if(mode==='put-fail')throw Error('injected put failure');const r=await env.BACKUP.put(key,...args);if(r===null)counts.backupNull++;return r;},
  async get(key){counts.backupGet++;const r=await env.BACKUP.get(key);if(mode==='read-corrupt'&&r?.body&&key.startsWith('v1/'))return {...r,body:new Response(new Uint8Array(r.size)).body};return r;},
  head:key=>{counts.backupHead++;return env.BACKUP.head(key);},list:args=>{counts.backupList++;return env.BACKUP.list(args);}
 };
 return {...env,BACKUP:backup,SOURCE_IMAGES:source};
}
export default {async fetch(request,env,ctx){
 const path=new URL(request.url).pathname;
 if(path==='/__test/control'&&request.method==='POST'){const v=await request.json();mode=v.mode||'normal';if(v.seed!==undefined)await env.SOURCE_IMAGES.put('orig/file_0123456789',new TextEncoder().encode(v.seed),{httpMetadata:{contentType:'image/svg+xml'}});return Response.json({mode});}
 if(path==='/__test/counts')return Response.json(counts);
 if(path==='/__test/native'){
  const bytes=new TextEncoder().encode('abc');const md5=await storage.digest(bytes,'MD5'),sha256=await storage.digest(bytes);
  const a=await env.BACKUP.put('test-native-only',bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256});
  const b=await env.BACKUP.put('test-native-only',bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256});
  const c=await env.BACKUP.put('test-native-only',bytes,{onlyIf:{etagMatches:'wrong-etag'},sha256});
  const read=await env.BACKUP.get('test-native-only');return Response.json({md5,sha256,first:!!a,createNull:b===null,casNull:c===null,readHash:await storage.digest(await read.arrayBuffer())});
 }
 return worker.fetch(request,wrapped(env),ctx);
}};
