'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');const {PGlite}=require('@electric-sql/pglite');
(async()=>{
 const s=require('../src/services/imageBackupScan.service'),b=require('../src/services/imageBackup.service');
 const root='root00000001';let reject=false,rollback=false,pages=0;
 const files=Array.from({length:1001},(_,i)=>({id:'file'+String(i).padStart(10,'0'),name:'x'+i,mimeType:'image/jpeg',size:'3',version:'1',md5Checksum:'900150983cd24fb0d6963f7d28e17f72',parents:[root]}));
 const reader={kind:'sa',getMetadata:async id=>id===root?{id:root,name:'root',mimeType:'application/vnd.google-apps.folder'}:files.find(f=>f.id===id),listChildren:async(id,t)=>{pages++;if(reject)throw Error('permission denied');if(!t)return {files:files.slice(0,501),nextPageToken:'empty'};if(t==='empty')return {files:[],nextPageToken:'last'};return {files:files.slice(501),nextPageToken:null};}};
 const db=new PGlite();await db.exec(fs.readFileSync(path.join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8'));
 const pool={query:async(sql,args)=>{if(rollback&&sql.startsWith('INSERT INTO image_backup_scan_entries')&&args?.[2]==='file'){rollback=false;throw Error('injected after outbox INSERT');}return db.query(sql,args);}};
 const deps={pool,roots:[{rootId:root,readerKinds:['sa']}],readers:[reader],api:{readCurrent:async()=>null,listManifests:async()=>({items:[],truncated:false,cursor:null})},loadHints:async()=>({transferIds:new Set(),privateHints:[]})};
 const scan=await s.startScan({deps});rollback=true;let r=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});
 assert.equal(r.state,'incomplete');assert.equal((await db.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,0,'file rollback must undo enqueue');
 assert.equal((await db.query("SELECT (data->'page'->>'offset')::int n FROM image_backup_scan_entries WHERE kind='folder' LIMIT 1")).rows[0].n,0,'failed file does not advance durable offset');
 await s.scanStep({scanId:scan.id,budgetMs:60000,deps});assert.equal((await db.query('SELECT count(*)::int n FROM image_backup_outbox')).rows[0].n,1001);assert.equal(pages,3,'durable first page is reused after rollback; empty and last pages still read');
 await db.query("UPDATE image_backup_scan_entries SET state='pending' WHERE kind='folder'");reject=true;r=await s.scanStep({scanId:scan.id,budgetMs:60000,deps});assert.equal(r.state,'incomplete');assert.equal((await db.query('SELECT base_generation FROM image_backup_scans')).rows[0].base_generation,null);
 assert.equal((await b.checkBackupSchema({pool:{query:async()=>{throw Error('down');}}})).ready,false);
 await db.query("UPDATE image_backup_outbox SET status='blocked',attempts=8 WHERE id=(SELECT min(id) FROM image_backup_outbox)");assert.equal((await b.retryJob({pool,jobKey:'unknown'})).resumed,0);const row=(await db.query("SELECT job_key FROM image_backup_outbox WHERE status='blocked' LIMIT 1")).rows[0];assert.equal((await b.retryJob({pool,jobKey:row.job_key})).resumed,1);
 await db.close();console.log('PASS imageBackupAdversarial: >1000 files, empty token page, page rollback, permission incomplete, schema failure OFF, blocked retry (6 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
