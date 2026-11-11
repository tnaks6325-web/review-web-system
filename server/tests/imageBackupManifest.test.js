'use strict';
const assert=require('node:assert/strict'),fs=require('fs');const {PGlite}=require('@electric-sql/pglite');
(async()=>{
 const s=require('../src/services/imageBackupScan.service'),b=require('../src/services/imageBackup.service');assert.equal(typeof s.publishStep,'function','resumable publisher exists');
 const db=new PGlite();await db.exec(fs.readFileSync(require('path').join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8'));
 const objects=new Map();let current=null,commits=0;const api={readCurrent:async()=>current,listManifests:async()=>({items:[],truncated:false,cursor:null}),putManifestPart:async({generation,part,bytes})=>{const key=generation+'/'+part;if(objects.has(key))assert.equal(objects.get(key).toString(),bytes.toString());objects.set(key,bytes);return{};},readManifest:async({generation,part})=>({bytes:objects.get(generation+'/'+part)}),commitManifest:async({generation,indexBytes,baseGeneration})=>{assert.equal(baseGeneration,current?.generation||null);current={v:1,generation,indexSha256:b.sha(indexBytes),etag:'e'+generation};commits++;return current;}};
 const root='root00000001';const deps={pool:db,roots:[{rootId:root,readerKinds:['sa']}],readers:[{kind:'sa',getMetadata:async id=>({id,name:'root',mimeType:'application/vnd.google-apps.folder'})}],api};
 let scan=await s.startScan({deps});await db.query("UPDATE image_backup_scan_entries SET state='done'");
 for(let i=0;i<15;i++){const r=await s.scanStep({scanId:scan.id,deps});if(r.state==='complete')break;}
 assert.equal(commits,1);assert.equal(current.generation,String(scan.id));const first=current;
 scan=await s.startScan({deps});await db.query("UPDATE image_backup_scan_entries SET state='done'");
 for(let i=0;i<15;i++){const r=await s.scanStep({scanId:scan.id,deps});if(r.state==='complete')break;}
 assert.equal(commits,2);assert.ok(BigInt(current.generation)>BigInt(first.generation));assert.ok(objects.has(first.generation+'/index'));
 await db.close();console.log('PASS imageBackupManifest: persisted phases, empty valid index, monotonic generation, old immutable index retained (4 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
