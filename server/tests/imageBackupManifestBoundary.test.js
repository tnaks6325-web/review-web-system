'use strict';
// Preservation contract: manifest byte budget must not publish the over-budget candidate.
const assert=require('node:assert/strict');
const {publishStep}=require('../src/services/imageBackupScan.service');
(async()=>{
 const rows=Array.from({length:100},(_,i)=>({entry_key:'receipt:'+String(i).padStart(3,'0'),data:{testPayload:'가'.repeat(2000),sequence:i}}));
 let payload,saved;
 const pool={query:async(sql,args)=>{
  if(sql.startsWith('SELECT entry_key,data'))return {rows};
  if(sql.startsWith('UPDATE image_backup_scans')){saved=JSON.parse(args[2]);return {rows:[{id:1}]};}
  throw Error('unexpected SQL');
 }};
 const scan={id:'1',counts:{publication:{phase:'parts',parts:[],partAfter:''}}};
 const api={putManifestPart:async({bytes})=>{assert.ok(bytes.length<=256*1024);payload=JSON.parse(bytes);}};
 assert.equal(await publishStep({scan,token:'test',deps:{pool,api}}),false);
 assert.ok(payload.entries.length>0&&payload.entries.length<100);
 assert.equal(saved.parts[0].count,payload.entries.length);
 assert.equal(saved.partAfter,rows[payload.entries.length-1].entry_key);
 const next=Buffer.from(JSON.stringify({...payload,entries:[...payload.entries,rows[payload.entries.length].data]}));
 assert.ok(next.length>256*1024);
 console.log('PASS manifest boundary preservation: stored bytes fit cap, count matches, next entry preserved for next part');
})().catch(e=>{console.error(e);process.exitCode=1;});
