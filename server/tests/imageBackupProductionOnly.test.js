'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const file=path.resolve(__dirname,'../src/services/imageBackup.service.js');
function load(env){const context={module:{exports:{}},require:createRequire(file),process:{env},Buffer,setImmediate(){throw Error('reservation should not occur');},console};vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});return context.module.exports;}
test('backup remains off in PR/test Railway environments even if production variables are copied',()=>{
 for(const name of ['pr-1819','TEST_REVIEW','staging']){
  const b=load({IMAGE_BACKUP_ENABLED:'1',RAILWAY_ENVIRONMENT_NAME:name});assert.equal(b.enabled(),false);
 }
});
test('production and explicitly enabled operator CLI retain backup access',()=>{
 assert.equal(load({IMAGE_BACKUP_ENABLED:'1',RAILWAY_ENVIRONMENT_NAME:'production'}).enabled(),true);
 assert.equal(load({IMAGE_BACKUP_ENABLED:'1'}).enabled(),true);
 assert.equal(load({IMAGE_BACKUP_ENABLED:'0',RAILWAY_ENVIRONMENT_NAME:'production'}).enabled(),false);
});
test('cron reuses the same production execution gate',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../src/jobs/cron.js'),'utf8');
 assert.match(source,/if\s*\(require\('\.\.\/services\/imageBackup\.service'\)\.enabled\(\)\)/);
});
test('a direct drain in a test deployment cannot claim production backup work',async()=>{
 const b=load({IMAGE_BACKUP_ENABLED:'1',RAILWAY_ENVIRONMENT_NAME:'pr-1819'});let reads=0;
 const result=await b.drainOnce({deps:{get pool(){reads++;throw Error('no DB access allowed');}}});
 assert.equal(reads,0);assert.equal(result.claimed,0);
});
