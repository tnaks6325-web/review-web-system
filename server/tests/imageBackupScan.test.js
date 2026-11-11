'use strict';
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');const fs=require('fs');
(async()=>{
 const scan=require('../src/services/imageBackupScan.service');
 const root='root00000001',folder='folder000001',file='file00000001';
 const meta={[root]:{id:root,name:'root',mimeType:'application/vnd.google-apps.folder'},[folder]:{id:folder,name:'a/b',parents:[root],mimeType:'application/vnd.google-apps.folder'},[file]:{id:file,name:'x',parents:[folder],mimeType:'image/jpeg',version:'1',size:'3',md5Checksum:'900150983cd24fb0d6963f7d28e17f72'}};
 const reader={kind:'sa',getMetadata:async id=>meta[id],listChildren:async(id,token)=>id===root?{files:[meta[folder]],nextPageToken:null}:token?{files:[meta[file]],nextPageToken:null}:{files:[],nextPageToken:'next'}};
 assert.deepEqual((await scan.resolveActualPath({fileId:file,rootId:root,reader})).chain,[{id:root,name:'root'},{id:folder,name:'a/b'}]);
 const transfer=new Set([file]);assert.equal((await scan.classifyScope({chain:[],source:'guide',fileId:file,transferIds:transfer})).decision,'exclude');
 assert.equal((await scan.classifyScope({chain:[],fileId:file,transferIds:null})).decision,'retry');
 assert.equal((await scan.classifyScope({chain:[],fileId:file,source:'guide',privateHints:['cs'],transferIds:new Set()})).section,'internal');
 const db=new PGlite();await db.exec(fs.readFileSync(require('path').join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8'));
 const api={readCurrent:async()=>null,listManifests:async()=>({items:[],truncated:false,cursor:null})};
 const deps={pool:db,roots:[{rootId:root,readerKinds:['sa']}],readers:[reader],api,loadHints:async()=>({transferIds:new Set(),privateHints:[]})};
 const started=await scan.startScan({deps});
 // budget stops after a page without declaring an empty middle page complete.
 for(let i=0;i<5;i++)await scan.scanStep({scanId:started.id,budgetMs:1000,deps});
 assert.equal((await db.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM image_backup_scan_entries WHERE kind='folder' AND state<>'done'")).rows[0].n,0);
 assert.notEqual((await db.query('SELECT state FROM image_backup_scans')).rows[0].state,'complete');
 await db.query("UPDATE image_backup_outbox SET status='superseded'");const changed=await scan.scanStep({scanId:started.id,budgetMs:1000,deps});assert.equal(changed.state,'incomplete');assert.equal((await db.query('SELECT state FROM image_backup_scans')).rows[0].state,'failed','changed observation must allow a fresh scan rather than keep singleton stuck');
 await db.close();console.log('PASS imageBackupScan: actual chain, transfer precedence, failed exclusion, private precedence, empty-page cursor, persisted job, no premature complete, superseded observation restart (8 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
