'use strict';
// 결정 368 보강: a dropped connection on a CHECKED-OUT business DB client must not terminate the
// whole server. pg removes the pool's idle error listener while a client is checked out, so an
// unhandled 'error' event there reaches process 'uncaughtException' (server/index.js → exit 1).
// Uses the installed pg driver with sockets forbidden; each case runs in a child process so an
// escaped 'error' event is observed as a real process exit, not a caught test exception.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const poolFile=path.resolve(__dirname,'../src/db/pool.js');
const CASES=['checked-out-query','checked-out-gap','transaction','pool-query','idle'];

if(!process.argv[2]){
 for(const mode of CASES){
  const r=spawnSync(process.execPath,[__filename,mode],{encoding:'utf8',timeout:10000,
   env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test'}});
  assert.equal(r.error,undefined,mode+' timed out');
  assert.doesNotMatch(r.stderr,/Unhandled 'error' event/,mode+': client error escaped');
  assert.equal(r.status,0,mode+' exit '+r.status+'\n'+r.stderr);
  assert.match(r.stdout,new RegExp('^OK '+mode,'m'),mode+' did not finish');
 }
 console.log('PASS dbPoolClientError: checked-out/gap/transaction/pool-query/idle survive a dropped connection (5 cases)');
 return;
}

require('node:net').Socket.prototype.connect=function(){throw Error('NETWORK_FORBIDDEN');};
const pg=require('pg');let last;
class OfflineClient extends pg.Client{
 constructor(o){super({...o,connectionString:undefined});last=this;}
 connect(cb){this._connected=true;process.nextTick(()=>cb(null));}
 end(cb){this._ending=true;process.nextTick(()=>{this.emit('end');cb&&cb();});return cb?undefined:Promise.resolve();}
}
class OfflinePool extends pg.Pool{constructor(o){super({...o,Client:OfflineClient});}}
const logs=[];const logger={info:()=>{},warn:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push(a.join(' '))};
const mod={exports:{}};
vm.runInNewContext(fs.readFileSync(poolFile,'utf8'),{module:mod,process:{env:{}},console,
 require:n=>{if(n==='pg')return {Pool:OfflinePool};if(n==='../utils/logger')return {logger};if(n==='../services/errorLog.service')return {logAbnormal:()=>{}};throw Error('unexpected require '+n);}},{filename:poolFile});
const mode=process.argv[2],pool=mod.exports;
const SECRET='postgres://user:secret@host/db';
const fault=()=>last._handleErrorEvent(Object.assign(Error('Connection terminated unexpectedly'),{detail:SECRET}));
(async()=>{
 if(mode==='transaction'){
  const c=await pool.connect();const sql=[];const q=c.query.bind(c);c.query=(s,...a)=>{sql.push(s);return s==='BEGIN'||s==='ROLLBACK'?Promise.resolve({rows:[]}):q(s,...a);};
  let caught;
  try{await c.query('BEGIN');setImmediate(fault);await c.query('SELECT 1');await c.query('COMMIT');}
  catch(e){caught=e;await c.query('ROLLBACK').catch(()=>{});}finally{c.release(caught);}
  assert.match(String(caught&&caught.message),/Connection terminated unexpectedly|not queryable/,'failure reaches caller');
  assert.deepEqual(sql,['BEGIN','SELECT 1','ROLLBACK'],'never COMMIT after a dropped connection');
  assert.equal(pool.totalCount,0,'broken client removed');
 }else if(mode==='pool-query'){
  const p=pool.query('SELECT 1');setImmediate(fault);
  await assert.rejects(p,/Connection terminated unexpectedly/);
  assert.equal(pool.totalCount,0);
 }else if(mode==='idle'){
  const c=await pool.connect();c.release();fault();await new Promise(setImmediate);
  assert.equal(pool.totalCount,0);
 }else{
  const c=await pool.connect();let caught;
  try{setImmediate(fault);if(mode==='checked-out-gap')await new Promise(setImmediate);await c.query('SELECT 1');}
  catch(e){caught=e;}finally{c.release(caught);}
  assert.match(String(caught&&caught.message),/Connection terminated unexpectedly|not queryable/,'query failure still reaches caller');
  assert.equal(pool.totalCount,0,'broken client discarded, not reused');
  const next=await pool.connect();assert.notEqual(next,c,'next work gets a fresh client');next.release();
 }
 assert(logs.every(w=>!w.includes('secret')),'log must not include connection details');
 await pool.end();
 console.log('OK '+mode);
})().catch(e=>{console.error(e);process.exitCode=2;});
