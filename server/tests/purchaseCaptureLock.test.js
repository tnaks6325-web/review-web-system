'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const file=path.resolve(__dirname,'../src/utils/purchaseCaptureLock.js');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('capture lock helper exists as the shared key source',()=>{assert(fs.existsSync(file),'Shared capture lock helper has not been implemented');});
test('capture locks normalize, deduplicate and sort the existing capture key',async()=>{const calls=[];await require(file).lockPurchaseCaptureOrdersInTx({query:async(sql,args)=>calls.push({sql,args})},[B,A.toUpperCase(),A]);assert.deepEqual(calls.map(x=>x.args[0]),['purchase_capture:'+A,'purchase_capture:'+B]);assert(calls.every(x=>x.sql==='SELECT pg_advisory_xact_lock(hashtext($1))'));});
test('capture lock helper rejects malformed server IDs before acquiring any lock',async()=>{let calls=0;const client={query:async()=>{calls++;}};for(const ids of [[A,'not-an-id'],[null],A])await assert.rejects(require(file).lockPurchaseCaptureOrdersInTx(client,ids),TypeError);assert.equal(calls,0);});
test('capture lock errors propagate to the owning transaction',async()=>{const e=new Error('synthetic lock failure');await assert.rejects(require(file).lockPurchaseCaptureOrdersInTx({query:async()=>{throw e;}},[A]),x=>x===e);});
