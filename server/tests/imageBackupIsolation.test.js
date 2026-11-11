'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),{createRequire}=require('module');const {PGlite}=require('@electric-sql/pglite');
(async()=>{
 const filename=require.resolve('../src/services/imageBackup.service');const source=fs.readFileSync(filename,'utf8');const db=new PGlite();await db.exec(fs.readFileSync(require('path').join(__dirname,'../migrations/223_image_group_backup.sql'),'utf8'));
 let inserts=0,active=0,max=0,down=false;const callbacks=[];
 const pool={query:async(sql,args)=>{if(down)throw Error('DB down');if(sql.startsWith('INSERT')){inserts++;active++;max=Math.max(max,active);await Promise.resolve();active--;throw Error('enqueue failed');}return db.query(sql,args);}};
 const context={module:{exports:{}},Buffer,console:{warn(){}},process:{env:{IMAGE_BACKUP_ENABLED:'1'}},setImmediate:cb=>callbacks.push(cb),require:n=>n==='../db/imageBackupPool'?{getPool:()=>pool}:createRequire(filename)(n)};
 vm.runInNewContext(source,context,{filename});const svc=context.module.exports;const unhandled=[];const on=e=>unhandled.push(e);process.on('unhandledRejection',on);
 for(let i=0;i<250;i++)svc.scheduleUploaded({fileId:'file00000001',name:'x',mime:'image/jpeg',size:3,buffer:Buffer.alloc(1024),source:'upload'});
 assert.equal(callbacks.length,1);await callbacks.shift()();assert.equal(inserts,200);assert.equal(max,1);await new Promise(r=>setImmediate(r));assert.equal(unhandled.length,0);
 svc.scheduleUploaded({fileId:'file00000001',source:'payment_result'});assert.equal(callbacks.length,0);
 down=true;svc.scheduleUploaded({fileId:'file00000001',source:'upload'});await callbacks.shift()();assert.equal(inserts,200);assert.equal(unhandled.length,0);
 process.off('unhandledRejection',on);await db.close();console.log('PASS imageBackupIsolation: queue capped 200, enqueue concurrency one, rejection isolation, payment no reservation, missing schema only backup stops (5 preservation cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
