'use strict';
const {sha}=require('./imageBackup.service');
const MAX=25*1024*1024;
function createClient({url=process.env.IMAGE_BACKUP_URL,apiKey=process.env.IMAGE_BACKUP_API_KEY,fetch:fetcher=globalThis.fetch}={}){
 const base=new URL(url);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('BACKUP_CONFIG_INVALID');
 if(!apiKey||/[\r\n]/.test(apiKey))throw new Error('BACKUP_CONFIG_INVALID');
 async function request(path,{method='GET',body,headers={},signal,raw=false,head=false,cap=MAX}={}){
  const timeout=AbortSignal.timeout(30000);const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const r=await fetcher(base.origin+path,{method,body,signal:combined,redirect:'error',headers:{Authorization:'Bearer '+apiKey,...(head?{'Accept-Encoding':'identity'}:{}),...headers}});
  if(!r.ok){let error;try{error=(await r.json()).error;}catch(_){}const e=new Error(error?.code||r.headers.get('X-Backup-Error')||'STORE_UNAVAILABLE');e.code=e.message;e.retryable=error?.retryable===true;throw e;}
  if(head)return {size:Number(r.headers.get('Content-Length')),mime:r.headers.get('Content-Type'),sha256:r.headers.get('X-Backup-Sha256'),etag:r.headers.get('ETag')};
  const bytes=await readBounded(r.body,cap);if(raw)return {bytes,etag:r.headers.get('ETag')};return JSON.parse(bytes.toString('utf8'));
 }
 const json=(path,value,signal,method='PUT')=>request(path,{method,signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
 const obj=key=>'/v1/objects/'+Buffer.from(key).toString('base64url');
 return {
 copyOrig:({descriptor,proof,signal})=>json('/v1/objects/copy',{v:1,descriptor,proof},signal,'POST'),
 putObject:({descriptor,proof,body,signal})=>{if(body.length>MAX)throw Object.assign(new Error('TOO_LARGE'),{code:'TOO_LARGE'});const envelope=Buffer.from(JSON.stringify({v:1,descriptor,proof}));if(envelope.length>8192)throw new Error('BAD_DESCRIPTOR');return request('/v1/objects',{method:'PUT',signal,body,headers:{'Content-Type':'application/octet-stream','X-Backup-Descriptor':envelope.toString('base64url')}});},
 getObject:({key,signal})=>request(obj(key),{signal,raw:true}),
 headObject:({key,signal})=>request(obj(key),{signal,method:'HEAD',head:true}),
 getReceipt:({receiptId,signal})=>request('/v1/manifests/receipts/'+receiptId,{signal,raw:true,cap:1024*1024}),
 putManifestPart:({generation,part,bytes,sha256,signal})=>request(`/v1/manifests/${generation}/${part}`,{method:'PUT',body:bytes,signal,headers:{'Content-Type':'application/json','X-Backup-Sha256':sha256}}),
 commitManifest:({generation,baseGeneration,expectedEtag,indexBytes,signal})=>json('/v1/manifests/current',{v:1,generation,baseGeneration,expectedEtag,indexSha256:sha(indexBytes)},signal),
 readManifest:({generation,part,signal})=>request(`/v1/manifests/${generation}/${part}`,{signal,raw:true,cap:1024*1024}),
 readCurrent:({signal}={})=>request('/v1/manifests/current',{signal}).catch(e=>{if(e.code==='NOT_FOUND')return null;throw e;}),
 listManifests:({kind,cursor,limit=1000,signal})=>request('/v1/manifests?'+new URLSearchParams({kind,limit:String(limit),...(cursor?{cursor}:{})}),{signal,cap:1024*1024})
 };
}
async function readBounded(stream,max=MAX){const parts=[];let size=0;if(!stream)return Buffer.alloc(0);try{for await(const chunk of stream){const b=Buffer.from(chunk);size+=b.length;if(size>max)throw Object.assign(new Error('TOO_LARGE'),{code:'TOO_LARGE'});parts.push(b);}return Buffer.concat(parts,size);}catch(e){stream.destroy?.();throw e;}}
const names=['putObject','copyOrig','getObject','headObject','getReceipt','putManifestPart','commitManifest','readManifest','readCurrent','listManifests'];
module.exports={createClient,readBounded,MAX,...Object.fromEntries(names.map(n=>[n,args=>createClient()[n](args)]))};
