'use strict';
require('./helpers/dualChannelDependencies.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const slots=require('../src/utils/captureSlots');
const snapshot={channels:{naver:{},coupang:{}},cashReceiptRequired:true};
test('snapshot roles override misleading administrative labels, receipts do not delay reviews',()=>{
 const eff=slots.effectiveCaptureSlots([{key:'slot2',label:'현영'}],'현영',null,true,snapshot);
 assert.deepEqual(eff.map(s=>[s.key,s.channel,s.role]),[['review','naver','review'],['slot2','coupang','review'],['receipt','naver','receipt'],['receipt2','coupang','receipt']]);
 assert.deepEqual(slots.requiredSlotKeys(null,'',null,false,snapshot),['review','slot2']);
 assert.equal(require('../src/services/captureVerify.service')._expectedKind('slot2',null,snapshot),'review');
});
test('Coupang slot uses existing review precheck rather than unknown-slot skip',()=>{
 const svc=require('../src/services/reviewInspect.service');
 const got=svc.precheckPolicy({slotKey:'slot2',conditionSnapshot:snapshot,classified:{kind:'review',channel:'coupang',confidence:1}});
 assert.notEqual(got.code,'not_review_slot');
});
test('snapshot hash survives PostgreSQL JSONB key reordering',()=>{
 const {digest}=require('../src/services/dualChannelReview.service');
 assert.equal(digest({z:1,a:{y:2,b:3}}),digest({a:{b:3,y:2},z:1}));
});
