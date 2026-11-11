// The HTTP handler and injected local tests share this storage boundary.
export const MAX_BYTES = 25 * 1024 * 1024;
export const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const ID = /^[A-Za-z0-9_-]{10,200}$/;
const SHA = /^[a-f0-9]{64}$/;
export class BackupError extends Error { constructor(code) { super(code); this.code=code; } }
export function fail(code) { throw new BackupError(code); }
export function exact(value, keys) {
 if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || keys.some(k=>!Object.hasOwn(value,k))) fail('BAD_DESCRIPTOR');
}
export function b64(bytes) { let s=''; for(const n of bytes)s+=String.fromCharCode(n); return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
export function unb64(s) {
 if(typeof s!=='string'||!s||!/^[A-Za-z0-9_-]+$/.test(s)||s.length%4===1)fail('BAD_DESCRIPTOR');
 try {const bytes=Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(b64(bytes)!==s)fail('BAD_DESCRIPTOR');return bytes;} catch {fail('BAD_DESCRIPTOR');}
}
export function text(bytes) {try{return decoder.decode(bytes);}catch{fail('BAD_DESCRIPTOR');}}
export function json(bytes) {try{return JSON.parse(text(bytes));}catch{fail('BAD_DESCRIPTOR');}}
export function canonical(value) {
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 fail('BAD_DESCRIPTOR');
}
export async function digest(bytes,algorithm='SHA-256') {return Array.from(new Uint8Array(await crypto.subtle.digest(algorithm,bytes)),v=>v.toString(16).padStart(2,'0')).join('');}
function validName(s) {if(typeof s!=='string'||!s||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s))fail('BAD_DESCRIPTOR');}
function validDescriptor(d) {
 exact(d,['fileId','rootId','chain','name','mime','size','sourceVersion','section']);
 if(typeof d.fileId!=='string'||typeof d.rootId!=='string'||!ID.test(d.fileId)||!ID.test(d.rootId)||!['work','common','internal'].includes(d.section)||!Number.isSafeInteger(d.size)||d.size<0||typeof d.sourceVersion!=='string'||!/^\d+$/.test(d.sourceVersion)||typeof d.mime!=='string'||!/^image\/[a-z0-9.+-]+$/.test(d.mime))fail('BAD_DESCRIPTOR');
 if(d.size>MAX_BYTES)fail('TOO_LARGE');
 validName(d.name);
 if(!Array.isArray(d.chain)||d.chain.length<1||d.chain.length>100||d.chain[0]?.id!==d.rootId)fail('BAD_DESCRIPTOR');
 const ids=new Set();for(const item of d.chain){exact(item,['id','name']);if(typeof item.id!=='string'||!ID.test(item.id)||ids.has(item.id))fail('BAD_DESCRIPTOR');ids.add(item.id);validName(item.name);}
}
export function validateEnvelope(env,e) {
 exact(e,['v','descriptor','proof']);if(e.v!==1)fail('BAD_DESCRIPTOR');const d=e.descriptor,p=e.proof;validDescriptor(d);
 const field=p?.kind==='drive-md5'?'md5':p?.kind==='drive-sha256'?'sha256':null;
 if(!field)fail('BAD_DESCRIPTOR');exact(p,['kind',field,'size','sourceVersion']);
 if(typeof p[field]!=='string'||!(field==='md5'?/^[a-f0-9]{32}$/:SHA).test(p[field])||p.size!==d.size||p.sourceVersion!==d.sourceVersion)fail('BAD_DESCRIPTOR');
 let allowed,excluded;
 try {allowed=JSON.parse(env.IMAGE_BACKUP_ALLOWED_ROOT_IDS);excluded=JSON.parse(env.IMAGE_BACKUP_EXCLUDED_ROOT_IDS);}catch{fail('SCOPE_DENIED');}
 if(!Array.isArray(allowed)||!Array.isArray(excluded)||!allowed.every(v=>typeof v==='string'&&ID.test(v))||!excluded.every(v=>typeof v==='string'&&ID.test(v))||!allowed.includes(d.rootId)||d.chain.some(x=>excluded.includes(x.id)))fail('SCOPE_DENIED');
 return e;
}
export function buildObjectKey({descriptor:d,sha256}) {
 validDescriptor(d);if(!SHA.test(sha256))fail('BAD_DESCRIPTOR');
 const seg=(name,id)=>b64(encoder.encode(name))+'~'+id;
 const key=['v1',d.section,...d.chain.map(x=>seg(x.name,x.id)),seg(d.name,d.fileId),sha256].join('/');
 if(encoder.encode(key).length>1000)fail('TOO_LARGE');return key;
}
export function validateKey(key) {
 if(typeof key!=='string'||encoder.encode(key).length>1000)fail('BAD_DESCRIPTOR');
 const p=key.split('/');if(p.length<5||p[0]!=='v1'||!['work','common','internal'].includes(p[1])||!SHA.test(p.at(-1)))fail('BAD_DESCRIPTOR');
 for(const seg of p.slice(2,-1)){const pair=seg.split('~');if(pair.length!==2||!ID.test(pair[1]))fail('BAD_DESCRIPTOR');validName(text(unb64(pair[0])));}
 return key;
}

// Bounded reads cancel the underlying stream, rather than leaving timed-out I/O active.
export async function readBounded(body, limit, expectedSize) {
 if(body instanceof ArrayBuffer)body=new Uint8Array(body);
 if(body instanceof Uint8Array){if(body.byteLength>limit)fail('TOO_LARGE');return body;}
 if(!body)return new Uint8Array(0);
 const reader=body.getReader();const out=new Uint8Array(expectedSize===undefined?limit:Math.min(expectedSize,limit));
 let n=0,timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new BackupError('STORE_UNAVAILABLE'));},30000);});
 try {for(;;){const chunk=await Promise.race([reader.read(),timeout]);if(chunk.done)break;if(n+chunk.value.byteLength>out.byteLength){void reader.cancel().catch(()=>{});fail('TOO_LARGE');}out.set(chunk.value,n);n+=chunk.value.byteLength;}return n===out.length?out:out.slice(0,n);}finally{clearTimeout(timer);reader.releaseLock();}
}
async function storeCall(fn) {try{return await fn();}catch(e){if(e instanceof BackupError)throw e;fail('STORE_UNAVAILABLE');}}
async function immutable(env,key,bytes,{mime='application/json',sha256}={}) {
 const sha=sha256||await digest(bytes);
 const saved=await storeCall(()=>env.BACKUP.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:sha,httpMetadata:{contentType:mime},customMetadata:{sha256:sha}}));
 const back=await storeCall(()=>env.BACKUP.get(key));
 if(!back?.body||back.size!==bytes.byteLength)fail(saved===null&&back?'KEY_CONFLICT':'VERIFY_FAILED');
 const actual=await readBounded(back.body,Math.max(bytes.byteLength,1),back.size);
 if(actual.byteLength!==bytes.byteLength||await digest(actual)!==sha)fail(saved===null?'KEY_CONFLICT':'VERIFY_FAILED');
 return back;
}
async function verifyProof(bytes,d,p) {
 if(bytes.byteLength!==d.size)fail('SOURCE_MISMATCH');
 const sha=await digest(bytes);
 if(p.kind==='drive-md5'){if(await digest(bytes,'MD5')!==p.md5)fail('SOURCE_MISMATCH');}else if(sha!==p.sha256)fail('SOURCE_MISMATCH');
 return sha;
}
async function saveObject(env,{descriptor,proof,body}) {
 const bytes=await readBounded(body,MAX_BYTES,descriptor.size);const sha256=await verifyProof(bytes,descriptor,proof);
 const key=buildObjectKey({descriptor,sha256});const saved=await immutable(env,key,bytes,{mime:descriptor.mime,sha256});
 const {fileId,size,mime}=descriptor;const receiptId=await digest(encoder.encode(canonical({descriptor,proof,key,sha256,size,mime})));
 const receipt={v:1,key,fileId,sha256,size,mime,objectEtag:saved.etag,receiptId,verified:true};
 await immutable(env,'manifests/receipts/'+receiptId+'.json',encoder.encode(canonical({v:1,descriptor,proof,object:receipt})));
 return receipt;
}
export async function putVerifiedObject(env,args) {
 validateEnvelope(env,{v:1,descriptor:args.descriptor,proof:args.proof});return saveObject(env,args);
}
// Intentionally expose only a get/head wrapper over orig/<validated ID>. The
// binding itself is NOT a read-only capability; do not claim otherwise.
function sourceOrig(env,fileId) {if(!ID.test(fileId))fail('BAD_DESCRIPTOR');const key='orig/'+fileId;return {get:()=>storeCall(()=>env.SOURCE_IMAGES.get(key)),head:()=>storeCall(()=>env.SOURCE_IMAGES.head(key))};}
export async function copyVerifiedOrig(env,{descriptor,proof}) {
 validateEnvelope(env,{v:1,descriptor,proof});const source=await sourceOrig(env,descriptor.fileId).get();
 if(!source)fail('SOURCE_MISSING');
 if(source.size!==descriptor.size){if(source.body)void source.body.cancel().catch(()=>{});fail('SOURCE_MISMATCH');}
 if(!source.body)fail('VERIFY_FAILED');return saveObject(env,{descriptor,proof,body:source.body});
}
export async function getObject(env,{key,head=false}) {
 validateKey(key);const o=await storeCall(()=>head?env.BACKUP.head(key):env.BACKUP.get(key));if(!o)return null;
 return {body:head?null:o.body,size:o.size,mime:o.httpMetadata?.contentType||'application/octet-stream',sha256:key.split('/').at(-1),etag:o.etag};
}

function generation(g) {if(typeof g!=='string'||!(/^[1-9][0-9]{0,99}$/).test(g))fail('BAD_DESCRIPTOR');return g;}
function partName(p) {if(p!=='index'&&!/^p[0-9]{6}$/.test(p))fail('BAD_DESCRIPTOR');return p;}
function partKey(g,p) {return 'manifests/'+generation(g)+'/'+partName(p);}
function nonnegative(n) {if(!Number.isSafeInteger(n)||n<0)fail('BAD_DESCRIPTOR');}
function hex(s) {if(typeof s!=='string'||!SHA.test(s))fail('BAD_DESCRIPTOR');}
function indexSchema(i,g) {
 exact(i,['v','generation','baseGeneration','rootSetHash','scanComplete','parts','counts']);
 if(i.v!==1||i.generation!==g||i.scanComplete!==true)fail('BAD_DESCRIPTOR');
 generation(i.generation);if(i.baseGeneration!==null){generation(i.baseGeneration);if(BigInt(i.baseGeneration)>=BigInt(g))fail('BAD_DESCRIPTOR');}
 hex(i.rootSetHash);if(!Array.isArray(i.parts)||i.parts.length>1000000)fail('BAD_DESCRIPTOR');
 let last='';for(const p of i.parts){exact(p,['part','sha256','size','count']);if(!/^p[0-9]{6}$/.test(p.part)||p.part<=last)fail('BAD_DESCRIPTOR');last=p.part;hex(p.sha256);nonnegative(p.size);nonnegative(p.count);if(p.size>256*1024)fail('TOO_LARGE');}
 if(!i.counts||typeof i.counts!=='object'||Array.isArray(i.counts))fail('BAD_DESCRIPTOR');for(const [k,n] of Object.entries(i.counts)){if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k))fail('BAD_DESCRIPTOR');nonnegative(n);}
 return i;
}
async function partSchema(env,i,g,p) {
 exact(i,['v','generation','part','entries']);if(i.v!==1||i.generation!==g||i.part!==p||!Array.isArray(i.entries))fail('BAD_DESCRIPTOR');
 const seen=new Set();for(const e of i.entries){
  exact(e,['receiptId','key','fileId','sha256','size','mime','descriptor','proof','presence']);hex(e.receiptId);hex(e.sha256);
  if(seen.has(e.receiptId)||!['observed','not_observed','unresolved'].includes(e.presence))fail('BAD_DESCRIPTOR');seen.add(e.receiptId);
  validateEnvelope(env,{v:1,descriptor:e.descriptor,proof:e.proof});
  if(e.key!==buildObjectKey({descriptor:e.descriptor,sha256:e.sha256})||e.fileId!==e.descriptor.fileId||e.size!==e.descriptor.size||e.mime!==e.descriptor.mime||e.proof.kind==='drive-sha256'&&e.proof.sha256!==e.sha256)fail('BAD_DESCRIPTOR');
  const material={descriptor:e.descriptor,proof:e.proof,key:e.key,sha256:e.sha256,size:e.size,mime:e.mime};
  if(await digest(encoder.encode(canonical(material)))!==e.receiptId)fail('BAD_DESCRIPTOR');
 }
}
export async function putManifestPart(env,{generation:g,part,bytes,sha256}) {
 const key=partKey(g,part);hex(sha256);bytes=await readBounded(bytes,part==='index'?1024*1024:256*1024);
 if(await digest(bytes)!==sha256)fail('VERIFY_FAILED');const parsed=json(bytes);
 if(part==='index')indexSchema(parsed,g);else await partSchema(env,parsed,g,part);
 await immutable(env,key,bytes,{sha256});return {key,sha256,size:bytes.byteLength};
}
async function readRecord(env,key,limit) {
 const o=await storeCall(()=>env.BACKUP.get(key));if(!o)return null;
 if(!o.body)fail('VERIFY_FAILED');const bytes=await readBounded(o.body,limit,o.size);if(bytes.length!==o.size)fail('VERIFY_FAILED');return {bytes,etag:o.etag};
}
export function readManifest(env,{generation:g,part}) {return readRecord(env,partKey(g,part),part==='index'?1024*1024:256*1024);}
export function getReceipt(env,{receiptId}) {hex(receiptId);return readRecord(env,'manifests/receipts/'+receiptId+'.json',32*1024);}
export async function readCurrent(env) {
 const record=await readRecord(env,'manifests/current',2048);if(!record)return null;
 const current=json(record.bytes);exact(current,['v','generation','indexSha256']);if(current.v!==1)fail('VERIFY_FAILED');generation(current.generation);hex(current.indexSha256);return {...current,etag:record.etag};
}
export async function commitManifest(env,{generation:g,baseGeneration,expectedEtag,indexBytes}) {
 generation(g);if(baseGeneration!==null)generation(baseGeneration);
 if(expectedEtag!==null&&(typeof expectedEtag!=='string'||!expectedEtag||expectedEtag.length>200||/["\r\n]/.test(expectedEtag)))fail('BAD_DESCRIPTOR');
 if((baseGeneration===null)!==(expectedEtag===null))fail('BAD_DESCRIPTOR');
 indexBytes=await readBounded(indexBytes,1024*1024);const index=indexSchema(json(indexBytes),g);
 if(index.baseGeneration!==baseGeneration)fail('BAD_DESCRIPTOR');
 const indexSha256=await digest(indexBytes),savedIndex=await readManifest(env,{generation:g,part:'index'});
 if(!savedIndex||await digest(savedIndex.bytes)!==indexSha256)fail('VERIFY_FAILED');
 const current=await readCurrent(env);
 // Recover a lost success response without a second write. A losing conditional
 // put, however, always fails; it is never reinterpreted as success after null.
 if(current?.generation===g&&current.indexSha256===indexSha256)return current;
 if((current?.generation??null)!==baseGeneration||(current?.etag??null)!==expectedEtag||BigInt(g)<=BigInt(current?.generation??'0'))fail('PRECONDITION_FAILED');
 const pointer={v:1,generation:g,indexSha256};
 const saved=await storeCall(()=>env.BACKUP.put('manifests/current',encoder.encode(canonical(pointer)),{onlyIf:current?{etagMatches:expectedEtag}:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/json'}}));
 if(saved===null)fail('PRECONDITION_FAILED');return {...pointer,etag:saved.etag};
}
export async function listManifests(env,{kind,cursor=null,limit=1000}) {
 if(!['receipts','generations'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>1000||cursor!==null&&(typeof cursor!=='string'||cursor.length>8192))fail('BAD_DESCRIPTOR');
 // R2 does not support a numeric-directory-only prefix. Filter at a fixed
 // manifests/ prefix and preserve its opaque cursor, including empty pages.
 const result=await storeCall(()=>env.BACKUP.list({prefix:kind==='receipts'?'manifests/receipts/':'manifests/',limit,...(cursor===null?{}:{cursor})}));
 const pattern=kind==='receipts'?/^manifests\/receipts\/[a-f0-9]{64}\.json$/:/^manifests\/[1-9][0-9]*\/(?:index|p[0-9]{6})$/;
 if(result.truncated&&!result.cursor)fail('STORE_UNAVAILABLE');
 return {items:result.objects.filter(o=>pattern.test(o.key)).map(({key,size,etag})=>({key,size,etag})),truncated:result.truncated,cursor:result.truncated?result.cursor:null};
}
