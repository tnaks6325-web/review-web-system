'use strict';
const assert = require('assert');
const pool = require('../src/db/pool');
const { boundedReviewRead } = require('../src/services/boundedReviewRead.service');
const original = pool.connect;
let commands = [], releases = [], failRollback = false, connections = 0;
pool.connect = async () => {
  connections++;
  return {
    query: async sql => { commands.push(sql); if (sql === 'ROLLBACK' && failRollback) throw Error('rollback failed'); return { rows:[] }; },
    release: err => releases.push(err),
  };
};
(async () => {
  assert.equal(await boundedReviewRead(async () => 42), 42);
  assert.deepEqual(commands, ["BEGIN READ ONLY; SET LOCAL statement_timeout = '1500ms'; SET LOCAL lock_timeout = '500ms'; SET LOCAL temp_file_limit = '64MB'; SET LOCAL max_parallel_workers_per_gather = 0", 'COMMIT']);
  assert.equal(releases.length, 1);
  commands=[];
  await assert.rejects(boundedReviewRead(async () => { throw Object.assign(Error('timeout'), { code:'57014' }); }), { code:'57014' });
  assert.equal(commands.at(-1), 'ROLLBACK');
  assert.equal(releases.length, 2);
  failRollback=true;
  await assert.rejects(boundedReviewRead(async()=>{throw Error('read failed');}), /read failed/);
  assert.ok(releases.at(-1) instanceof Error, 'broken connection is discarded');
  failRollback=false;
  let finish;
  const gate=new Promise(resolve=>{finish=resolve;});
  const one=boundedReviewRead(()=>gate), two=boundedReviewRead(()=>gate);
  const before=connections;
  await assert.rejects(boundedReviewRead(async()=>{}), {code:'REVIEW_WARNING_BUSY'});
  assert.equal(connections,before,'saturated optional work does not queue DB connections');
  finish(); await Promise.all([one,two]);
  assert.equal(await boundedReviewRead(async()=>7),7,'capacity released after all outcomes');
  pool.connect=async()=>{throw Error('connect failed');};
  for(let i=0;i<3;i++) await assert.rejects(boundedReviewRead(async()=>{}),/connect failed/);
  console.log('PASS bounded optional reads: limits, success, rollback, broken release, saturation, reconnect');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{pool.connect=original;});
