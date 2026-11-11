import * as store from './storage.js';
const {BackupError,fail}=store;
const status={AUTH_REQUIRED:401,BAD_DESCRIPTOR:400,SCOPE_DENIED:403,NOT_FOUND:404,SOURCE_MISSING:404,SOURCE_MISMATCH:409,SOURCE_CHANGED:409,KEY_CONFLICT:409,PRECONDITION_FAILED:412,TOO_LARGE:413,BUSY:429,STORE_UNAVAILABLE:503,VERIFY_FAILED:502};
export function response(body,init={}) { const headers=new Headers(init.headers); headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Content-Security-Policy',"sandbox; default-src 'none'"); return new Response(body,{...init,headers}); }
export function jsonResponse(value,init={}) { return response(JSON.stringify(value),{...init,headers:{'Content-Type':'application/json',...init.headers}}); }
async function authenticate(request,env) {
 const expected=env.IMAGE_BACKUP_API_KEY,auth=request.headers.get('Authorization');
 if(typeof expected!=='string'||expected.length<32||expected.length>1024||!auth?.startsWith('Bearer ')||auth.length>1031)fail('AUTH_REQUIRED');
 const enc=new TextEncoder();const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(auth.slice(7))),crypto.subtle.digest('SHA-256',enc.encode(expected))]);
 let diff=0;const x=new Uint8Array(a),y=new Uint8Array(b);for(let i=0;i<x.length;i++)diff|=x[i]^y[i];if(diff!==0)fail('AUTH_REQUIRED');
}
function contentType(request,type) {if(!new RegExp('^'+type.replace('/','\\/')+'(?:;\\s*charset=utf-8)?$','i').test(request.headers.get('content-type')||''))fail('BAD_DESCRIPTOR');}
function lengthCheck(request,max) {const value=request.headers.get('content-length');if(value!==null){if(!/^(0|[1-9][0-9]*)$/.test(value))fail('BAD_DESCRIPTOR');if(BigInt(value)>BigInt(max))fail('TOO_LARGE');}}
async function readJson(request,limit) {contentType(request,'application/json');lengthCheck(request,limit);return store.json(await store.readBounded(request.body,limit));}
function download(body,{size,mime,etag,sha256}) {return response(body,{headers:{'Content-Length':String(size),'Content-Type':mime,'Content-Disposition':'attachment; filename="backup.bin"','ETag':'"'+etag+'"',...(sha256?{'X-Backup-Sha256':sha256}:{})}});}
async function route(request,env) {
 const u=new URL(request.url),path=u.pathname,m=request.method;
 if(path!=='/v1/manifests'&&u.search)fail('BAD_DESCRIPTOR');
 if(path==='/v1/objects'&&m==='PUT'){
  contentType(request,'application/octet-stream');lengthCheck(request,store.MAX_BYTES);
  const header=request.headers.get('x-backup-descriptor');if(!header||header.length>10924)fail('BAD_DESCRIPTOR');
  const decoded=store.unb64(header);if(decoded.byteLength>8192)fail('BAD_DESCRIPTOR');const envelope=store.validateEnvelope(env,store.json(decoded));
  return jsonResponse(await store.putVerifiedObject(env,{...envelope,body:request.body}));
 }
 if(path==='/v1/objects/copy'&&m==='POST'){
  const envelope=store.validateEnvelope(env,await readJson(request,8192));return jsonResponse(await store.copyVerifiedOrig(env,envelope));
 }
 let match;
 if((match=path.match(/^\/v1\/objects\/([A-Za-z0-9_-]+)$/))&&['GET','HEAD'].includes(m)){
  const key=store.text(store.unb64(match[1]));const object=await store.getObject(env,{key,head:m==='HEAD'});if(!object)fail('NOT_FOUND');return download(object.body,object);
 }
 if(path==='/v1/manifests/current'){
  if(m==='GET'){const current=await store.readCurrent(env);if(!current)fail('NOT_FOUND');return jsonResponse(current);}
  if(m==='PUT'){
   const input=await readJson(request,2048);store.exact(input,['v','generation','baseGeneration','expectedEtag','indexSha256']);
   if(input.v!==1||typeof input.indexSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.indexSha256))fail('BAD_DESCRIPTOR');
   const index=await store.readManifest(env,{generation:input.generation,part:'index'});if(!index)fail('NOT_FOUND');if(await store.digest(index.bytes)!==input.indexSha256)fail('VERIFY_FAILED');
   return jsonResponse(await store.commitManifest(env,{...input,indexBytes:index.bytes}));
  }
 }
 if((match=path.match(/^\/v1\/manifests\/receipts\/([a-f0-9]{64})$/))&&m==='GET'){
  const r=await store.getReceipt(env,{receiptId:match[1]});if(!r)fail('NOT_FOUND');return download(r.bytes,{size:r.bytes.length,mime:'application/json',etag:r.etag});
 }
 if((match=path.match(/^\/v1\/manifests\/([1-9][0-9]*)\/(index|p[0-9]{6})$/))){
  const generation=match[1],part=match[2];
  if(m==='PUT'){contentType(request,'application/json');const limit=part==='index'?1024*1024:256*1024;lengthCheck(request,limit);return jsonResponse(await store.putManifestPart(env,{generation,part,bytes:request.body,sha256:request.headers.get('x-backup-sha256')}));}
  if(m==='GET'){const r=await store.readManifest(env,{generation,part});if(!r)fail('NOT_FOUND');return download(r.bytes,{size:r.bytes.length,mime:'application/json',etag:r.etag,sha256:await store.digest(r.bytes)});}
 }
 if(path==='/v1/manifests'&&m==='GET'){
  const q=u.searchParams;for(const k of q.keys())if(!['kind','cursor','limit'].includes(k)||q.getAll(k).length!==1)fail('BAD_DESCRIPTOR');
  if(q.has('limit')&&!/^[1-9][0-9]{0,3}$/.test(q.get('limit')))fail('BAD_DESCRIPTOR');
  return jsonResponse(await store.listManifests(env,{kind:q.get('kind'),cursor:q.get('cursor'),limit:q.has('limit')?Number(q.get('limit')):1000}));
 }
 fail('NOT_FOUND');
}
let active=false; // Isolate-local budget only; no cross-isolate concurrency claim.
function errorResponse(request,error) {
 const code=error instanceof BackupError?error.code:'STORE_UNAVAILABLE',headers={'X-Backup-Error':code};
 return request.method==='HEAD'?response(null,{status:status[code],headers}):jsonResponse({v:1,error:{code,retryable:['BUSY','STORE_UNAVAILABLE','VERIFY_FAILED','SOURCE_CHANGED'].includes(code)}},{status:status[code],headers});
}
function releaseOnBodyEnd(res,release) {
 if(!res.body){release();return res;}
 const reader=res.body.getReader();let timer=setTimeout(()=>{void reader.cancel().catch(()=>{});release();},30000);
 const done=()=>{clearTimeout(timer);release();};
 const body=new ReadableStream({async pull(controller){try{const chunk=await reader.read();if(chunk.done){done();controller.close();}else controller.enqueue(chunk.value);}catch(e){done();controller.error(e);}},async cancel(reason){try{await reader.cancel(reason);}finally{done();}}},{highWaterMark:0});
 return new Response(body,{status:res.status,headers:res.headers});
}
export default {async fetch(request,env,ctx) {
 let owns=false;
 try {
  await authenticate(request,env);if(active)fail('BUSY');active=true;owns=true;
  let timer,timedOut=false,released=false;const release=()=>{if(!released){released=true;active=false;}};
  const pending=route(request,env).then(r=>{if(timedOut){void r.body?.cancel().catch(()=>{});release();}return r;},e=>{if(timedOut)release();throw e;});
  // R2 binding calls cannot be aborted. A timed-out operation retains its slot
  // until it settles; do not multiply live writes by releasing early.
  if(ctx)ctx.waitUntil(pending.catch(()=>{}));
  try {const r=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;owns=false;reject(new BackupError('STORE_UNAVAILABLE'));},30000);})]);clearTimeout(timer);owns=false;return releaseOnBodyEnd(r,release);}catch(e){clearTimeout(timer);throw e;}
 } catch(error) {if(owns)active=false;return errorResponse(request,error);}
}};
