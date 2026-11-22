'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
(async()=>{
 const source=fs.readFileSync(require.resolve('../src/jobs/cron'),'utf8');const start=source.indexOf("  if (require('../services/imageBackup.service').enabled())");assert.ok(start>0);const end=source.indexOf('  // ── 리뷰 미작성',start);assert.ok(end>start);
 const tasks=new Map();let resolveDrain,scanCalls=0,gapCalls=[];const context={process:{env:{IMAGE_BACKUP_ENABLED:'1'}},logger:{warn(){}},cron:{schedule:(key,fn,opts)=>{assert.equal(opts.timezone,'Asia/Seoul');tasks.set(key,fn);}},require:n=>{
 if(n==='../services/imageBackup.service')return {enabled:()=>true,drainOnce:()=>new Promise(r=>{resolveDrain=r;}),checkBackupSchema:async()=>({ready:true})};
 if(n==='../db/imageBackupPool')return {getPool:()=>({query:async()=>({rows:[{id:'1'}]})})};
 if(n==='../services/imageBackupScan.service')return {scanStep:async()=>{scanCalls++;},startScan:async()=>({id:'1'}),enqueueReferencedGaps:async a=>{gapCalls.push(a);return {enabled:true,enqueued:0};}};throw Error('unexpected '+n);}};
 vm.runInNewContext(source.slice(start,end),context);
 const pending=tasks.get('*/15 * * * * *')();await Promise.resolve();await tasks.get('* * * * *')();assert.equal(scanCalls,1,'minute scan must not starve behind the drain tick at second zero');
 await tasks.get('30 3 * * *')();assert.equal(scanCalls,2);assert.equal(gapCalls.length,1,'nightly lane runs the referenced gap sweep');assert.ok(gapCalls[0].limit>0&&gapCalls[0].limit<=1000,'sweep bounded per night');resolveDrain();await pending;console.log('PASS imageBackupCron: independent drain/resume/nightly lanes, KST, no minute-boundary starvation, bounded referenced gap sweep in nightly lane (4 cases)');
})().catch(e=>{console.error(e);process.exitCode=1;});
