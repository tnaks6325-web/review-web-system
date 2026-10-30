#!/usr/bin/env node
'use strict';
/** No credentials/PII in argv or stdout. Private manifest/backup must stay outside git.
 * Default: dry-run. Apply additionally requires manifest hash + fresh before-state hash.
 */
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const svc=require('../src/services/historicalFeeRestore.service');
function refuse(code) { const e=new Error(code);e.code=code;throw e; }
function privateFile(file) {
  const s=fs.statSync(file);if(!s.isFile() || (s.mode & 0o077)) refuse('private_file_permissions');
  return fs.readFileSync(file,'utf8');
}
function readPrivateBackup(file) {
  return JSON.parse(privateFile(file), (key,value)=>
    value && value.type==='Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value);
}
function writePrivate(file,data) {
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(data,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dd=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dd);}finally{fs.closeSync(dd);}
}
async function main() {
  const args=process.argv.slice(2),opts={};
  for(let i=0;i<args.length;i++) { if(args[i]==='--apply')opts.apply=true;else if(['--manifest','--output','--before-hash','--approved-manifest-sha','--release-sha'].includes(args[i]))opts[args[i].slice(2)]=args[++i];else refuse('unknown_argument'); }
  if(!opts.manifest || !opts.output) refuse('manifest_and_output_required');
  const repo=path.resolve(__dirname,'../..'),out=path.resolve(opts.output),manifestFile=path.resolve(opts.manifest);
  if(out===repo || out.startsWith(repo+path.sep) || manifestFile.startsWith(repo+path.sep))refuse('private_artifact_inside_repo');
  const dir=fs.statSync(out);if(!dir.isDirectory() || (dir.mode & 0o077))refuse('private_directory_permissions');
  const m=JSON.parse(privateFile(manifestFile)),hash=svc.digest(m);
  if(m.scope!=='nuru-first-review-fee-22' || m.expectedCount!==22 || m.fee!==1000 || m.expectedFileRows!==118 ||
      m.paidDate!=='2026-10-27')refuse('unapproved_scope');
  if(opts.apply && (opts['approved-manifest-sha']!==hash || !opts['before-hash'] || !/^[a-f0-9]{40}$/.test(opts['release-sha'] || '')))refuse('apply_approval_required');
  if(opts.apply && execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim()!==opts['release-sha'])refuse('release_code_mismatch');
  const url=process.env.HISTORICAL_RESTORE_DATABASE_URL;
  if(!url || new URL(url).hostname!==m.databaseHost)refuse('database_host_mismatch');
  const {Pool}=require('pg'),pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:10000});
  let backupPath;
  try {
    const result=await svc.restoreHistoricalFees({db:pool,manifest:m,apply:!!opts.apply,expectedBeforeHash:opts['before-hash'],by:'historical-fee-restoration',
      backup:async snapshot=>{
        backupPath=path.join(out,`before-${Date.now()}-${crypto.randomUUID()}.json`);
        writePrivate(backupPath,{...snapshot,releaseSha:opts['release-sha'],createdAt:new Date().toISOString()});
        if(svc.digest(readPrivateBackup(backupPath).state)!==snapshot.beforeHash)refuse('backup_readback_failed');
        return {path:backupPath,beforeHash:snapshot.beforeHash};
      }});
    if(opts.apply) {
      const again=await svc.restoreHistoricalFees({db:pool,manifest:m,by:'historical-fee-restoration'});
      if(again.inserted!==0 || again.skipped!==22 || again.batchId!==result.batchId)refuse('post_apply_verification_failed');
      result.readback={inserted:again.inserted,skipped:again.skipped,batchId:again.batchId};
    }
    writePrivate(path.join(out,`result-${opts.apply?'apply':'dryrun'}-${Date.now()}.json`),{...result,manifestHash:hash,backupPath});
    console.log(JSON.stringify({...result,manifestHash:hash}));
  } finally {await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code || 'restore_failed'}));process.exitCode=1;});
module.exports={privateFile,writePrivate,readPrivateBackup,main};
