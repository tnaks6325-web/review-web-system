import test from 'node:test';
import assert from 'node:assert/strict';
const storage = await import('../src/storage.js').catch(()=>({}));
const worker = (await import('../src/index.js').catch(()=>({}))).default;
const descriptor={fileId:'file_0123456789',rootId:'root_0123456789',chain:[{id:'root_0123456789',name:'루트/..'},{id:'folder_0123456789',name:'작업'}],name:'무확장',mime:'image/jpeg',size:3,sourceVersion:'123',section:'work'};
export {descriptor};
test('key is reversible actual Drive ID chain plus name, no normalization',()=>{
 assert.equal(typeof storage.buildObjectKey,'function');
 assert.equal(storage.buildObjectKey({descriptor,sha256:'a'.repeat(64)}),`v1/work/${Buffer.from('루트/..').toString('base64url')}~root_0123456789/${Buffer.from('작업').toString('base64url')}~folder_0123456789/${Buffer.from('무확장').toString('base64url')}~file_0123456789/${'a'.repeat(64)}`);
});
test('names preserve slash, traversal-looking text, Unicode forms and folder IDs; keys never truncate',()=>{
 const sha256='a'.repeat(64),base={descriptor,sha256};const key=storage.buildObjectKey(base);
 for(const change of [{...descriptor,name:'../x\\y\u0000'},{...descriptor,name:'é'},{...descriptor,name:'é'},{...descriptor,chain:[{...descriptor.chain[0]},{...descriptor.chain[1],id:'different_0123456789'}]}])assert.notEqual(storage.buildObjectKey({...base,descriptor:change}),key);
 assert.notEqual(storage.buildObjectKey({...base,descriptor:{...descriptor,name:'é'}}),storage.buildObjectKey({...base,descriptor:{...descriptor,name:'é'}}));
 assert.throws(()=>storage.buildObjectKey({...base,descriptor:{...descriptor,name:'한'.repeat(300)}}),e=>e.code==='TOO_LARGE');
});
test('name-length overflow is a key byte-budget error, never truncated or mislabeled',()=>{
 assert.throws(()=>storage.buildObjectKey({descriptor:{...descriptor,name:'x'.repeat(1001)},sha256:'a'.repeat(64)}),e=>e.code==='TOO_LARGE');
});
test('authentication precedes every route and any R2 access',async()=>{
 assert.equal(typeof worker?.fetch,'function');
 let calls=0;const bucket=new Proxy({}, {get(){calls++;throw Error('R2 touched');}});
 for(const path of ['/v1/objects','/v1/objects/copy','/v1/manifests/current','/v1/manifests/1/index','/v1/manifests/receipts/'+ 'a'.repeat(64),'/v1/manifests?kind=receipts']){
 for(const method of ['GET','HEAD','PUT','POST','DELETE','OPTIONS'])for(const token of [null,'Bearer advertiser.jwt.invalid','Bearer oldimagekey']){
 const r=await worker.fetch(new Request('http://localhost'+path,{method,headers:token?{authorization:token}:{}}),{BACKUP:bucket,SOURCE_IMAGES:bucket,IMAGE_BACKUP_API_KEY:'unit-test-only-not-a-production-secret'});
 assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);
 if(method==='HEAD')assert.equal(r.headers.get('x-backup-error'),'AUTH_REQUIRED');else assert.deepEqual(await r.json(),{v:1,error:{code:'AUTH_REQUIRED',retryable:false}});
 }}assert.equal(calls,0);
});
