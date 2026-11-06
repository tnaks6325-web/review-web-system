'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'dual-test-only-not-a-real-secret-12345';
const proof = () => require('../src/services/dualPurchaseProof.service');
test('public integration API exposes real delegates',()=>{
 assert.equal(typeof proof().issueBundleApproval,'function');
 assert.equal(typeof proof().verifyBundleApprovalForSubmission,'function');
 assert.equal(typeof require('../src/services/dualPurchaseArtifacts.service').stagePurchaseArtifact,'function');
});
test('dual extraction uses real existing signature and binds decoded bytes to app/channel/role', () => {
  const p = proof();
  const identity = require('../src/services/reviewerOrderIdentity.service');
  const imageBase64 = Buffer.from('actual image byte fixture').toString('base64');
  const extracted = {recipient:'김하나',phone:'01012345678',address:'서울 강남대로 1 101호',price:'9000',store:'네이버'};
  const context = {owner:{id:'owner'},application:{id:7,campaign_id:'campaign'},selected:{identityKey:'self',cardId:'card'}};
  const issued = p.issueChannelExtraction({context,channel:'naver',role:'primary',revision:1,imageBase64,extracted,ok:true});
  assert.equal(identity.verifyExtractionProof(issued.extractToken, extracted).extractOk, true);
  const scope = {context,channel:'naver',role:'primary',revision:1,imageBase64,extracted};
  assert.equal(p.verifyChannelExtraction({...scope,extractionToken:issued.extractionToken}).byteSha256,p.sha(Buffer.from(imageBase64,'base64')));
  for (const changed of [{channel:'coupang'},{role:'supplement'},{revision:2},{context:{...context,application:{...context.application,id:8}}},{context:{...context,selected:{identityKey:'other',cardId:'card2'}}},{imageBase64:Buffer.from('swapped bytes').toString('base64')}]) {
    assert.throws(()=>p.verifyChannelExtraction({...scope,...changed,extractionToken:issued.extractionToken}), /결속/);
  }
});
