'use strict';
const assert=require('assert'),crypto=require('crypto');
const service=require('../src/services/paymentResult.service');
const bytes=Buffer.from('synthetic result file'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
const writes=[];
const client={query:async(sql,args=[])=>{
 if(/^BEGIN|^COMMIT|^ROLLBACK|^SELECT pg_advisory/.test(sql))return{rows:[]};
 if(/SELECT historical_key/.test(sql))return{rows:[{historical_key:null}]};
 if(/SELECT id, batch_id, file_format/.test(sql))return{rows:[{id:'upload',batch_id:'batch',file_format:'xlsx',file_blob:bytes,file_sha256:sha,applied:false}]};
 if(/FROM unconfirmed_transfer_reviews/.test(sql))return{rows:Array.isArray(args[1]) && args[1].includes(1)?[{used:1}]:[]};
 if(/FROM payment_(account|amount)_mismatch|JOIN payment_batch_items i|FROM payment_records WHERE source_key/.test(sql))return{rows:[]};
 if(/SELECT \* FROM payment_batches/.test(sql))return{rows:[{id:'batch',status:'created',historical_key:null}]};
 if(/COUNT\(\*\)/.test(sql))return{rows:[{n:2}]};
 if(/^\s*(INSERT|UPDATE)/.test(sql)){writes.push(sql);return{rows:[{notified_at:null}],rowCount:1};}
 if(/FROM review_index/.test(sql))return{rows:[]};
 throw Error('Unexpected test query');
},release(){}};
service.__setPoolForTest({...client,connect:async()=>client});
service.__setPaymentApplyForTest({markDepositCells:async()=>({}),verifyDepositCells:async()=>({})});
(async()=>{
 const item={id:'item',sheetId:'sheet',tabName:'tab',rowIndex:2,amount:1000,productPrice:0,reviewFee:1000};
 await assert.rejects(service._commitBatchOutcome({batchId:'batch',by:'test',notifyFailed:false,
  duplicateSha:{sha,uploadId:'upload'},paid:[{item,seq:1},{item:{...item,id:'other',rowIndex:3},seq:2}],
  failed:[{item:{...item,id:'failed',rowIndex:4},seq:3}]}),e=>e.code==='proof_already_used');
 assert.equal(writes.length,0,'one conflicting row must refuse the whole apply before mutations');
 console.log('paymentProofConflictRollback: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{service.__setPoolForTest(null);service.__setPaymentApplyForTest(null);});
