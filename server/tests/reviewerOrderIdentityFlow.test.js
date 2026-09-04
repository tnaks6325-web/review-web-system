'use strict';
const assert = require('assert');

process.env.JWT_SECRET = 'reviewer-order-identity-flow-test-secret-32-bytes';
process.env.REVIEWER_CAPTURE_IDENTITY_ENABLED = 'true';

const pool = require('../src/db/pool');
const identity = require('../src/services/reviewerOrderIdentity.service');

const ownerId = '11111111-1111-4111-8111-111111111111';
const selfId = '22222222-2222-4222-8222-222222222222';
const selectedId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
let selectedAddress = '서울 강남구 테헤란로 10 101동 1203호';

const originalQuery = pool.query;
pool.query = async (sql) => {
  if (/FROM reviewers WHERE id = \$1/.test(sql)) return { rows: [{
    id: ownerId, name:'본인', phone:'010-1010-1010', phone8:'10101010', address:'서울 본인주소',
    bank_name:'은행', bank_account:'123', account_holder:'본인', shopping_id:'self-id', reviewer_no:7,
    sub_accounts:[
      { name:'김민수', phone:'010-1234-5678', address:selectedAddress, shoppingId:'selected-id' },
      { name:'박영희', phone:'010-9999-8888', address:'부산 해운대구 센텀로 20 202동 505호', shoppingId:'other-id' },
    ],
  }] };
  if (/FROM reviewer_identities/.test(sql)) return { rows: [
    { id:selfId, member_no:0, current_name:'본인', current_phone:'010-1010-1010', current_phone8:'10101010', shopping_id:'self-id' },
    { id:selectedId, member_no:1, current_name:'김민수', current_phone:'010-1234-5678', current_phone8:'12345678', shopping_id:'selected-id' },
    { id:otherId, member_no:2, current_name:'박영희', current_phone:'010-9999-8888', current_phone8:'99998888', shopping_id:'other-id' },
  ] };
  if (/FROM campaign_applications ca/.test(sql)) return { rows: [{
    id:123, campaign_id:'camp-1', applicant_name:'김민수', applicant_phone:'010-1234-5678', phone8:'12345678',
    owner_phone8:'10101010', owner_reviewer_id:ownerId, participant_identity_id:selectedId,
    status:'applied', expires_at:new Date(Date.now() + 600000).toISOString(), multi_account_mode:true,
  }] };
  if (/INSERT INTO reviewer_identity_match_audits/.test(sql)) return { rows: [], rowCount: 1 };
  throw new Error('unexpected query: ' + sql);
};

const reviewer = { ownerReviewerId: ownerId };
const base = { campaignApplicationId:123, campaignId:'camp-1', holdToken:'hold-token' };
const selectedFields = { recipient:'김민수', phone:'010-1234-5678', address:selectedAddress };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await test('자동 MATCH 승인토큰은 선택 명의와 최종 제출필드에 결속된다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'a'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    assert.strictEqual(matched.status, 'MATCH');
    assert.ok(matched.approvalToken);
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:matched.approvalToken }, reviewer);
    await assert.rejects(
      identity.verifyApprovalForSubmission({ ...base, ...selectedFields, address:'다른 주소', identityApprovalToken:matched.approvalToken }, reviewer),
      (err) => err.code === 'IDENTITY_APPROVAL_STALE'
    );
  });

  await test('AI 추출필드 조작은 명의매칭 전에 차단된다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'b'.repeat(64), extracted:selectedFields, ok:true });
    await assert.rejects(
      identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:{ ...selectedFields, recipient:'박영희' } }, reviewer),
      (err) => err.code === 'EXTRACT_FIELDS_TAMPERED'
    );
  });

  await test('부분충돌 REVIEW는 사용자 수동확인 뒤 제출 가능하다', async () => {
    const extracted = { ...selectedFields, phone:'010-0000-9999' };
    const proof = identity.issueExtractionProof({ imageHash:'c'.repeat(64), extracted, ok:true });
    const reviewed = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted }, reviewer);
    assert.strictEqual(reviewed.status, 'REVIEW');
    assert.ok(reviewed.reviewToken);
    const manual = await identity.manualConfirm({
      ...base, mode:'review', manualConfirmed:true, reviewToken:reviewed.reviewToken, formFields:selectedFields,
    }, reviewer);
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:manual.approvalToken }, reviewer);
  });

  await test('자동 MATCH 뒤 입력값을 수정하면 기존 승인증명으로 재확인해 새 토큰을 발급한다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'1'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    const editedFields = { ...selectedFields, phone:'01012345678' };
    const manual = await identity.manualConfirm({
      ...base, mode:'form_edit', manualConfirmed:true,
      priorApprovalToken:matched.approvalToken, extractToken:proof.extractToken,
      extracted:selectedFields, formFields:editedFields,
    }, reviewer);
    assert.strictEqual(manual.mode, 'form_edit');
    await identity.verifyApprovalForSubmission({ ...base, ...editedFields, identityApprovalToken:manual.approvalToken }, reviewer);
  });

  await test('가림정보 보완 MATCH도 원본 추출증명과 수정값을 분리해 재확인한다', async () => {
    const maskedFields = {
      recipient:'김*수', phone:'010-****-5678', address:'서울 강남구 테헤란로 ** 101동 1203호',
    };
    const proof = identity.issueExtractionProof({ imageHash:'6'.repeat(64), extracted:maskedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:maskedFields }, reviewer);
    assert.strictEqual(matched.status, 'MATCH');
    assert.strictEqual(matched.resolved.address, selectedAddress);
    const manual = await identity.manualConfirm({
      ...base, mode:'form_edit', manualConfirmed:true,
      priorApprovalToken:matched.approvalToken, extractToken:proof.extractToken,
      extracted:maskedFields, formFields:selectedFields,
    }, reviewer);
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:manual.approvalToken }, reviewer);
  });

  await test('수정 재확인은 같은 캡처의 기존 승인증명이 없으면 허용하지 않는다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'2'.repeat(64), extracted:selectedFields, ok:true });
    await assert.rejects(identity.manualConfirm({
      ...base, mode:'form_edit', manualConfirmed:true, priorApprovalToken:'',
      extractToken:proof.extractToken, extracted:selectedFields, formFields:selectedFields,
    }, reviewer), (err) => err.code === 'IDENTITY_TOKEN_INVALID');
  });

  await test('다른 캡처의 승인증명으로 수정 재확인을 우회할 수 없다', async () => {
    const matchedProof = identity.issueExtractionProof({ imageHash:'3'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:matchedProof.extractToken, extracted:selectedFields }, reviewer);
    const otherFields = { recipient:'박영희', phone:'010-9999-8888', address:'부산 해운대구 센텀로 20 202동 505호' };
    const otherProof = identity.issueExtractionProof({ imageHash:'4'.repeat(64), extracted:otherFields, ok:true });
    await assert.rejects(identity.manualConfirm({
      ...base, mode:'form_edit', manualConfirmed:true, priorApprovalToken:matched.approvalToken,
      extractToken:otherProof.extractToken, extracted:otherFields, formFields:selectedFields,
    }, reviewer), (err) => err.code === 'IDENTITY_CONTEXT_CHANGED');
  });

  await test('수정 재확인도 다른 명의로 바꾼 입력은 차단한다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'5'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    const otherFields = { recipient:'박영희', phone:'010-9999-8888', address:'부산 해운대구 센텀로 20 202동 505호' };
    await assert.rejects(identity.manualConfirm({
      ...base, mode:'form_edit', manualConfirmed:true, priorApprovalToken:matched.approvalToken,
      extractToken:proof.extractToken, extracted:selectedFields, formFields:otherFields,
    }, reviewer), (err) => err.code === 'IDENTITY_MISMATCH');
  });

  await test('AI 장애는 실패 추출증명과 사용자 확인이 모두 있어야 제출 가능하다', async () => {
    const failed = identity.issueExtractionProof({ imageHash:'d'.repeat(64), extracted:{}, ok:false, errorCode:'timeout' });
    const manual = await identity.manualConfirm({
      ...base, mode:'ai_error', manualConfirmed:true, extractToken:failed.extractToken, extracted:{}, formFields:selectedFields,
    }, reviewer);
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:manual.approvalToken }, reviewer);
  });

  await test('명의 매칭 AI 장애도 성공 추출증명과 결정적 불일치 재검사 후 수동확인 가능하다', async () => {
    const extracted = { ...selectedFields };
    const proof = identity.issueExtractionProof({ imageHash:'9'.repeat(64), extracted, ok:true });
    const manual = await identity.manualConfirm({
      ...base, mode:'match_error', manualConfirmed:true, extractToken:proof.extractToken,
      extracted, formFields:selectedFields,
    }, reviewer);
    assert.strictEqual(manual.mode, 'match_error');
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:manual.approvalToken }, reviewer);
  });

  await test('명의 매칭 장애 수동확인도 다른 명의의 입력은 차단한다', async () => {
    const otherFields = { recipient:'박영희', phone:'010-9999-8888', address:'부산 해운대구 센텀로 20 202동 505호' };
    const proof = identity.issueExtractionProof({ imageHash:'8'.repeat(64), extracted:otherFields, ok:true });
    await assert.rejects(identity.manualConfirm({
      ...base, mode:'match_error', manualConfirmed:true, extractToken:proof.extractToken,
      extracted:otherFields, formFields:otherFields,
    }, reviewer), (err) => err.code === 'IDENTITY_MISMATCH');
  });

  await test('캡처 없이 제출 예외도 사용자 확인 토큰을 발급한다', async () => {
    const manual = await identity.manualConfirm({
      ...base, mode:'no_capture', manualConfirmed:true, formFields:selectedFields,
    }, reviewer);
    assert.strictEqual(manual.mode, 'no_capture');
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:manual.approvalToken }, reviewer);
  });

  await test('승인 뒤 저장 명의 주소가 바뀌면 기존 토큰은 폐기된다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'e'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    selectedAddress = '서울 강남구 변경로 99 101동 1203호';
    await assert.rejects(
      identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:matched.approvalToken }, reviewer),
      (err) => err.code === 'IDENTITY_APPROVAL_STALE'
    );
    selectedAddress = selectedFields.address;
  });

  await test('실제 다른 저장 명의의 캡처는 승인·수동확인 토큰을 주지 않는다', async () => {
    const otherFields = { recipient:'박영희', phone:'010-9999-8888', address:'부산 해운대구 센텀로 20 202동 505호' };
    const proof = identity.issueExtractionProof({ imageHash:'f'.repeat(64), extracted:otherFields, ok:true });
    const mismatch = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:otherFields }, reviewer);
    assert.strictEqual(mismatch.status, 'MISMATCH');
    assert.strictEqual(mismatch.approvalToken, '');
    assert.strictEqual(mismatch.reviewToken, '');
  });

  console.log(`\n✅ reviewerOrderIdentityFlow: ${passed}개 통과`);
})().catch((err) => { console.error('❌', err.stack || err.message); process.exitCode = 1; })
  .finally(async () => { pool.query = originalQuery; await pool.end(); });
