'use strict';
const assert = require('assert');
const { validateCandidates } = require('../src/services/historicalFeeRestore.service');
const p = { id:'p1', order_submission_id:'o1', sheet_id:'work1', tab_name:'작업', seq:2, active:true,
  deleted_at:null, owner_reviewer_id:'owner1', participant_identity_id:null, reviewer_name:'시험자', phone8:'12345678' };
const o = { id:'o1', deleted_at:null, owner_reviewer_id:'owner1', participant_identity_id:null,
  orderer:'시험자', phone:'01012345678', account:'012-345', depositor:'시험자', bank:'신한', review_fee_snapshot:1000 };
const r = { seq:5, success:true, amount:1000, accountDigits:'012345',holder:'시험자',memo:'입금명',
  transferredAtIso:'2026-10-27T12:42:02+09:00',statusRaw:'이체완료' };
const e = {id:7, sheet_id:'work1', tab_name:'작업', anchor_type:'order',anchor_value:'o1',field:'col:비고',
  value_text:'10/27입금완료',created_by:'직원',reverted_at:null};
const manifest = {sheetId:'work1',tabName:'작업',fee:1000,paidDate:'2026-10-27',expectedCount:1,
  rows:[{participantId:'p1',orderId:'o1',ownerId:'owner1',resultSeq:5,memoEditId:7,reviewFeeSnapshot:1000,paidAt:r.transferredAtIso}]};
const state = {participants:[p],orders:[o],index:[{sheet_id:'work1',tab_name:'작업',row_index:2,reviewer_name:'시험자',phone8:'12345678'}],edits:[e]};
assert.equal(validateCandidates(manifest,state,[r]).length,1);
for (const mutate of [
 s=>s.participants[0].active=false,
 s=>s.participants[0].owner_reviewer_id='other',
 s=>s.orders[0].deleted_at='now',
 s=>s.index[0].phone8='00000000',
 s=>s.orders[0].account='other',
 s=>s.edits[0].created_by='업체#1',
 s=>s.edits[0].reverted_at='now',
 s=>s.participants.push({...s.participants[0],id:'p2'}),
]) { const s=JSON.parse(JSON.stringify(state));mutate(s);assert.throws(()=>validateCandidates(manifest,s,[r])); }
for(const bad of [{...r,amount:2000},{...r,success:false},{...r,transferredAtIso:'2026-10-28T12:42:02+09:00'}, {...r,transferredAtIso:null}])
 assert.throws(()=>validateCandidates(manifest,state,[bad]));
assert.throws(()=>validateCandidates({...manifest,rows:[...manifest.rows,...manifest.rows]},state,[r]));
// Current profile account is NOT the historical ORDER account.
assert.equal(validateCandidates(manifest,{...state,participants:[{...p,row_json:{계좌번호:'new-account'}}]},[r]).length,1);
assert.equal(typeof require('../src/services/historicalFeeRestore.service').restoreHistoricalFees, 'function', 'transactional restoration is required');
console.log('historical fee candidate verification passed');
