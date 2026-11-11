'use strict';
const assert=require('node:assert/strict');const path=require('node:path'),fs=require('node:fs');const {pathToFileURL}=require('node:url');
// Explicit optional cross-worktree composition. No production credentials/network.
const base=path.resolve(__dirname,'..');const worker=path.resolve(process.argv[2]||path.join(base,'../backup-worker'));
(async()=>{
 const {PGlite}=require(base+'/node_modules/@electric-sql/pglite');
 const helpers=await import(pathToFileURL(worker+'/tests/helpers.js'));const handler=(await import(pathToFileURL(worker+'/src/index.js'))).default;
 const b=require(base+'/src/services/imageBackup.service'),s=require(base+'/src/services/imageBackupScan.service');const env=helpers.env();
 const api=require(base+'/src/services/imageBackupClient.service').createClient({url:'https://backup.invalid',apiKey:env.IMAGE_BACKUP_API_KEY,fetch:(url,opts)=>handler.fetch(new Request(url,opts),env,{waitUntil(){}})});
 const root=helpers.d.rootId,folder='parent_0123456789',body=Buffer.from('abc');let name='work/name',deleted=false,downloads=0;
 const files=[{...helpers.d,fileId:'file_0123456789'},{...helpers.d,fileId:'file_fallback0000'}].map(d=>({id:d.fileId,name:d.name,mimeType:d.mime,version:'5',parents:[folder],size:'3',md5Checksum:helpers.proof.md5}));
 const reader={kind:'sa',getMetadata:async id=>id===root?{id,name:'root',mimeType:'application/vnd.google-apps.folder'}:id===folder?{id,name,mimeType:'application/vnd.google-apps.folder',parents:[root]}:files.find(f=>f.id===id),listChildren:async id=>({files:id===root?[await reader.getMetadata(folder)]:deleted?[]:files,nextPageToken:null}),download:async()=>{downloads++;return body;}};
 await env.SOURCE_IMAGES.put('orig/'+files[0].id,body);const db=new PGlite();await db.exec(fs.readFileSync(base+'/migrations/223_image_group_backup.sql','utf8'));const deps={pool:db,roots:[{rootId:root,readerKinds:['sa']}],excluded:[],readers:[reader],api,loadHints:async()=>({transferIds:new Set(),privateHints:[]})};
 async function cycle(){const scan=await s.startScan({deps});for(let i=0;i<25;i++){let state=await s.scanStep({scanId:scan.id,deps});if(state.state==='incomplete')throw Error(JSON.stringify(state));for(let j=0;j<3;j++)await b.drainOnce({deps});if(state.state==='complete')return scan.id;}throw Error('scan not complete');}
 const first=await cycle();assert.equal(downloads,1);assert.equal((await db.query("SELECT count(*)::int n FROM image_backup_outbox WHERE status='done'")).rows[0].n,2);
 name='renamed';const second=await cycle();assert.ok(BigInt(second)>BigInt(first));assert.equal((await db.query("SELECT count(*)::int n FROM image_backup_outbox WHERE status='done'")).rows[0].n,4);
 deleted=true;await cycle();assert.equal(env.BACKUP.calls.filter(c=>c[0]==='delete').length,0);
 await db.close();reader.getMetadata=async()=>{throw Error('Drive forbidden during audit');};reader.download=async()=>{throw Error('Drive forbidden during audit');};env.SOURCE_IMAGES.get=async()=>{throw Error('orig forbidden during audit');};env.SOURCE_IMAGES.head=async()=>{throw Error('orig forbidden during audit');};
 const restoreApi=Object.fromEntries(['readCurrent','listManifests','getReceipt','readManifest','headObject','getObject'].map(k=>[k,api[k]]));
 const dest=fs.mkdtempSync(path.join(process.env.TMPDIR,'backup-wire-'));try{const report=await require(base+'/scripts/image-backup').restoreAudit({api:restoreApi,directory:dest,sample:20,allBytes:true});assert.equal(report.objects,4);assert.equal(report.restored,4);assert.equal(report.indexes,3);assert.equal(report.fullByteAudit,true);console.log('PASS actual A HTTP + B client/scanner/drain/publisher/CLI: copy+Drive fallback, rename old/new, delete retention, 3 current generations, independent full local restore 4/4');}finally{fs.rmSync(dest,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
