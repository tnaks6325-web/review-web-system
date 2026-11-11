'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),crypto=require('crypto');const {PGlite}=require('@electric-sql/pglite');
(async()=>{
 const svc=require('../src/services/imageBackup.service');assert.equal(typeof svc.drainOnce,'function','drain is implemented');
 const root='root00000001',file='file00000001',body=Buffer.from('abc');
 let version='1',copies=0,puts=0,downloads=0,mode='fallback';
 const reader={kind:'sa',getMetadata:async id=>id===root?{id:root,name:'root',mimeType:'application/vnd.google-apps.folder'}:{id:file,name:'x',parents:[root],mimeType:'image/jpeg',size:'3',version,md5Checksum:crypto.createHash('md5').update(body).digest('hex')},download:async()=>{downloads++;return body;}};
 const api={copyOrig:async()=>{copies++;if(mode==='fallback')throw Object.assign(new Error(),{code:'SOURCE_MISSING'});if(mode==='denied')throw Object.assign(new Error(),{code:'SCOPE_DENIED'});return {};},putObject:async({descriptor,proof})=>{puts++;if(mode==='changed')version='2';const sha=svc.sha(body);const key='v1/internal/'+Buffer.from('root').toString('base64url')+'~'+root+'/'+Buffer.from('x').toString('base64url')+'~'+file+'/'+sha;const receiptId=svc.sha(svc.canonical({descriptor,proof,key,sha256:sha,size:3,mime:'image/jpeg'}));return {v:1,key,fileId:file,sha256:sha,size:3,mime:'image/jpeg',objectEtag:'etag',receiptId,verified:true};}};
 const db=new PGlite();await db.exec(fs.readFileSync(require('path').join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8'));
 const deps={pool:db,roots:[{rootId:root,readerKinds:['sa']}],excluded:[],readers:[reader],api,loadHints:async()=>({transferIds:new Set(),privateHints:[]})};
 await svc.enqueue({fileId:file},{pool:db});let r=await svc.drainOnce({limit:1,deps});assert.equal(r.verified,0); // candidate promotion only
 r=await svc.drainOnce({limit:1,deps});assert.equal(r.verified,1);assert.deepEqual([copies,puts,downloads],[1,1,1]);
 assert.equal((await db.query("SELECT count(*)::int n FROM image_backup_outbox WHERE status='done'")).rows[0].n,1);
 await db.exec("UPDATE image_backup_outbox SET status='pending' WHERE status='done'");mode='denied';r=await svc.drainOnce({deps});assert.equal(r.blocked,1);assert.equal(downloads,1);
 await svc.retryJob({pool:db,jobKey:(await db.query("SELECT job_key FROM image_backup_outbox WHERE status='blocked'")).rows[0].job_key});mode='fallback';api.putObject=async()=>{version='2';return {verified:true};};r=await svc.drainOnce({deps});assert.equal(r.verified,0);
 await db.query("UPDATE image_backup_outbox SET status='pending',next_attempt_at=now() WHERE status='retry'");version='1';api.putObject=async({descriptor,proof})=>{const sha='f'.repeat(64),key=svc.objectKey(descriptor,sha),receiptId=svc.sha(svc.canonical({descriptor,proof,key,sha256:sha,size:3,mime:'image/jpeg'}));return {v:1,key,fileId:file,sha256:sha,size:3,mime:'image/jpeg',objectEtag:'etag',receiptId,verified:true};};r=await svc.drainOnce({deps});assert.equal(r.verified,0,'known downloaded SHA must match receipt even with MD5 proof');
 await db.query("UPDATE image_backup_outbox SET status='pending',next_attempt_at=now() WHERE status='retry'");const before=downloads;api.copyOrig=async()=>null;r=await svc.drainOnce({deps});assert.equal(downloads,before,'malformed 200 receipt is not SOURCE_MISSING and cannot trigger Drive fallback');assert.equal(r.verified,0);
 await db.close();console.log('PASS imageBackupDrain: candidate promotion, orig miss fallback verified, deny no fallback, changed source not done, known downloaded SHA enforced, malformed copy no fallback (6 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
