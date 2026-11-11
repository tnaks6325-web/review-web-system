import {createHash,webcrypto} from 'node:crypto';
// Node lacks workerd's MD5 WebCrypto extension; runtime suite verifies native MD5.
Object.defineProperty(globalThis,'crypto',{value:{subtle:{digest:(a,b)=>a==='MD5'?Promise.resolve(createHash('md5').update(new Uint8Array(b)).digest().buffer):webcrypto.subtle.digest(a,b)}},configurable:true});
export const bytes=new TextEncoder().encode('abc');
export const d={fileId:'file_0123456789',rootId:'root_0123456789',chain:[{id:'root_0123456789',name:'root'},{id:'parent_0123456789',name:'work/name'}],name:'photo.svg',mime:'image/svg+xml',size:3,sourceVersion:'5',section:'internal'};
export const proof={kind:'drive-md5',md5:'900150983cd24fb0d6963f7d28e17f72',size:3,sourceVersion:'5'};
export const sha='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
export class Bucket {
 constructor(){this.objects=new Map();this.calls=[];this.nullPut=false;this.corruptGet=false;this.throwPut=false;this.receiptFail=false;}
 async put(key,body,options={}) {
 this.calls.push(['put',key,options]);if(this.throwPut||this.receiptFail&&key.startsWith('manifests/receipts/'))throw Error('injected');
 const prior=this.objects.get(key);if(this.nullPut||options.onlyIf instanceof Headers&&prior||options.onlyIf?.etagMatches&&prior?.etag!==options.onlyIf.etagMatches)return null;
 const data=new Uint8Array(body).slice();const obj={data,size:data.length,etag:createHash('md5').update(data).digest('hex'),customMetadata:options.customMetadata||{},httpMetadata:options.httpMetadata||{}};this.objects.set(key,obj);return obj;
 }
 async get(key){this.calls.push(['get',key]);const o=this.objects.get(key);if(!o)return null;const data=this.corruptGet?new Uint8Array(o.size):o.data.slice();return {...o,body:new Response(data).body};}
 async head(key){this.calls.push(['head',key]);return this.objects.get(key)||null;}
 async list({prefix,cursor,limit}){this.calls.push(['list',prefix]);const all=[...this.objects].filter(([k])=>k.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b));const start=cursor?Number(cursor):0;const objects=all.slice(start,start+limit).map(([key,x])=>({key,...x}));const truncated=start+limit<all.length;return {objects,truncated,cursor:truncated?String(start+limit):undefined};}
}
export function env(){return {BACKUP:new Bucket(),SOURCE_IMAGES:new Bucket(),IMAGE_BACKUP_ALLOWED_ROOT_IDS:JSON.stringify([d.rootId]),IMAGE_BACKUP_EXCLUDED_ROOT_IDS:'[]',IMAGE_BACKUP_API_KEY:'unit-test-only-not-a-production-secret'};}
