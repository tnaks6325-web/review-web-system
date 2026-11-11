'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),{createRequire}=require('module');
const filename=require.resolve('../src/services/drive.service');
(async()=>{
 let scheduled=0,warm=0,shares=0,gets=[];let mode='record';const unhandled=[];const onUnhandled=e=>unhandled.push(e);process.on('unhandledRejection',onUnhandled);
 const fake={files:{create:async()=>({data:{id:'file00000001',name:'x'}}),get:async(p,o)=>{gets.push({p,o});return {data:{id:p.fileId}};},list:async(p,o)=>{gets.push({p,o});return {data:{files:[],nextPageToken:'next',incompleteSearch:false}};}},permissions:{create:async()=>{shares++;}},about:{get:async()=>({data:{}})}};
 const sandbox={module:{exports:{}},exports:{},process:{env:{IMAGE_BACKUP_ENABLED:'1'}},Buffer,console,setImmediate,setTimeout,clearTimeout,require:name=>{
 if(name==='./sheets.service')return {drive:fake};if(name==='./imageWarm.service')return {scheduleUploadWarm:()=>warm++};if(name==='../utils/logger')return {logger:{warn(){},info(){},error(){}}};
 if(name==='./imageBackup.service'){if(mode==='import')throw new Error('broken import');return {scheduleUploaded:e=>{scheduled++;assert.equal(e.size,3);assert.equal(e.parentId,'root00000001');assert.equal('buffer'in e,false);if(mode==='sync')throw Error('sync');if(mode==='async')return Promise.reject(Error('async'));}};}return createRequire(filename)(name);}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),sandbox,{filename});const D=sandbox.module.exports;
 assert.equal(typeof D.getBackupReadClients,'function','read-only adapters exported');
 for(mode of ['record','import','sync','async']){const up=await D.uploadFileBase64('YWJj','x','image/jpeg','root00000001');assert.equal(up.id,'file00000001');}
 await new Promise(r=>setImmediate(r));assert.equal(warm,4);assert.equal(shares,8);assert.equal(unhandled.length,0);assert.equal(scheduled,3);
 const readers=D.getBackupReadClients();assert.deepEqual(Object.keys(readers[0]).sort(),['download','getMetadata','kind','listChildren']);await readers[0].getMetadata('file00000001');await readers[0].listChildren('root00000001','p');assert.ok(gets[1].p.fields.includes('nextPageToken'));assert.ok(gets[1].p.fields.includes('incompleteSearch'));assert.equal(gets[1].p.pageToken,'p');assert.equal(gets[1].o.timeout,30000);
 process.off('unhandledRejection',onUnhandled);console.log('PASS imageBackupUpload: real common uploader metadata-only, import/sync/async failure isolation, warm/share invariant, read-only adapter wire (6 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
