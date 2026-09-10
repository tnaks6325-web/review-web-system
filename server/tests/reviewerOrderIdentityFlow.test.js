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
let selectedCurrentPhone = '010-1234-5678';
let applicationIdentity = 'sub';
const audits = [];

const originalQuery = pool.query;
pool.query = async (sql, params) => {
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
    { id:selectedId, member_no:1, current_name:'김민수', current_phone:selectedCurrentPhone, current_phone8:selectedCurrentPhone.replace(/\D/g, '').slice(-8), shopping_id:'selected-id' },
    { id:otherId, member_no:2, current_name:'박영희', current_phone:'010-9999-8888', current_phone8:'99998888', shopping_id:'other-id' },
  ] };
  if (/FROM campaign_applications ca/.test(sql)) {
    const isSub = applicationIdentity === 'sub';
    return { rows: [{
      id:123, campaign_id:'camp-1', applicant_name:isSub ? '김민수' : '본인',
      applicant_phone:isSub ? '010-1234-5678' : '010-1010-1010', phone8:isSub ? '12345678' : '10101010',
      owner_phone8:'10101010', owner_reviewer_id:ownerId, participant_identity_id:isSub ? selectedId : selfId,
      status:'applied', expires_at:new Date(Date.now() + 600000).toISOString(), multi_account_mode:isSub,
    }] };
  }
  if (/INSERT INTO reviewer_identity_match_audits/.test(sql)) { audits.push(params); return { rows: [], rowCount: 1 }; }
  throw new Error('unexpected query: ' + sql);
};

const reviewer = { ownerReviewerId: ownerId };
const base = { campaignApplicationId:123, campaignId:'camp-1', holdToken:'hold-token' };
const selectedFields = { recipient:'김민수', phone:'010-1234-5678', address:selectedAddress };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  await test('참여 명의에 따라 구매양식 내정보 목록 범위를 제한한다', async () => {
    const sub = await identity.getParticipationIdentityContext(base, reviewer);
    assert.strictEqual(sub.selectedIdentity.identityKey, `identity:${selectedId}`);
    assert.deepStrictEqual(sub.savedIdentities.map((item) => item.identityKey), [`identity:${selectedId}`]);

    applicationIdentity = 'self';
    const self = await identity.getParticipationIdentityContext(base, reviewer);
    assert.strictEqual(self.selectedIdentity.identityKey, `identity:${selfId}`);
    assert.deepStrictEqual(self.savedIdentities.map((item) => item.identityKey),
      [selfId, selectedId, otherId].map((id) => `identity:${id}`));
    applicationIdentity = 'sub';
  });

  await test('타계정 전화번호가 이후 수정돼도 참여 신청 당시 전화번호를 표시·검증한다', async () => {
    selectedCurrentPhone = '010-5555-6666';
    const context = await identity.getParticipationIdentityContext(base, reviewer);
    assert.strictEqual(context.selectedIdentity.phone, selectedFields.phone);
    assert.strictEqual(context.savedIdentities[0].phone, selectedFields.phone);
    const proof = identity.issueExtractionProof({ imageHash:'0a'.repeat(32), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    assert.strictEqual(matched.status, 'MATCH');
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:matched.approvalToken }, reviewer);
    selectedCurrentPhone = selectedFields.phone;
  });

  await test('자동 MATCH 승인토큰은 선택 명의와 최종 제출필드에 결속된다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'a'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    assert.strictEqual(matched.status, 'MATCH');
    assert.ok(matched.approvalToken);
    await identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:matched.approvalToken }, reviewer);
    await assert.rejects(
      identity.verifyApprovalForSubmission({ ...base, ...selectedFields, phone:'010-7777-6666', identityApprovalToken:matched.approvalToken }, reviewer),
      (err) => err.code === 'PARTICIPANT_PHONE_INVALID'
    );
    await assert.rejects(
      identity.verifyApprovalForSubmission({ ...base, ...selectedFields, address:'다른 주소', identityApprovalToken:matched.approvalToken }, reviewer),
      (err) => err.code === 'IDENTITY_APPROVAL_STALE'
    );
  });

  await test('다른 배송지는 직접 확인 후 해당 배송지에 결속된 승인으로 제출된다', async () => {
    const fields = { ...selectedFields, address:'서울 강남구 테헤란로 10 101동 1508호' };
    const proof = identity.issueExtractionProof({ imageHash:'7'.repeat(64), extracted:fields, ok:true });
    const reviewed = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:fields }, reviewer);
    assert.strictEqual(reviewed.status, 'REVIEW');
    assert.strictEqual(reviewed.approvalToken, '');
    assert.strictEqual(reviewed.resolved.address, fields.address);
    await assert.rejects(identity.manualConfirm({ ...base, mode:'review', reviewToken:reviewed.reviewToken, formFields:fields }, reviewer),
      (err) => err.code === 'MANUAL_CONFIRM_REQUIRED');
    const manual = await identity.manualConfirm({ ...base, mode:'review', manualConfirmed:true, reviewToken:reviewed.reviewToken, formFields:fields }, reviewer);
    await identity.verifyApprovalForSubmission({ ...base, ...fields, identityApprovalToken:manual.approvalToken }, reviewer);
    assert.ok(JSON.parse(audits.at(-1)[8]).includes('delivery_address_changed'));
    await assert.rejects(identity.verifyApprovalForSubmission({ ...base, ...selectedFields, identityApprovalToken:manual.approvalToken }, reviewer),
      (err) => err.code === 'IDENTITY_APPROVAL_STALE');
    assert.strictEqual(selectedAddress, selectedFields.address, '회원정보 주소는 주문 배송지로 덮어쓰지 않는다');
  });

  await test('MATCH 뒤 실제 배송지로 수정한 경우도 재확인 후 제출된다', async () => {
    const proof = identity.issueExtractionProof({ imageHash:'0'.repeat(64), extracted:selectedFields, ok:true });
    const matched = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:selectedFields }, reviewer);
    const fields = { ...selectedFields, address:'부산 해운대구 새길 30 301동 1508호' };
    const manual = await identity.manualConfirm({ ...base, mode:'form_edit', manualConfirmed:true,
      priorApprovalToken:matched.approvalToken, extractToken:proof.extractToken, extracted:selectedFields, formFields:fields }, reviewer);
    await identity.verifyApprovalForSubmission({ ...base, ...fields, identityApprovalToken:manual.approvalToken }, reviewer);
    assert.ok(JSON.parse(audits.at(-1)[8]).includes('delivery_address_changed'));
    for (const changed of [{ recipient:'박영희' }, { phone:'010-9999-8888' }]) {
      await assert.rejects(identity.manualConfirm({ ...base, mode:'form_edit', manualConfirmed:true,
        priorApprovalToken:matched.approvalToken, extractToken:proof.extractToken, extracted:selectedFields,
        formFields:{ ...fields, ...changed } }, reviewer), (err) => err.code === 'IDENTITY_MISMATCH');
    }
  });

  await test('가림 이름·연락처로 다른 배송지를 최종 승인할 수 없다', async () => {
    const fields = { recipient:'김*수', phone:'010-****-5678', address:'서울 강남구 테헤란로 10 101동 1508호' };
    const proof = identity.issueExtractionProof({ imageHash:'a1'.repeat(32), extracted:fields, ok:true });
    const reviewed = await identity.matchCapture({ ...base, extractToken:proof.extractToken, extracted:fields }, reviewer);
    assert.strictEqual(reviewed.status, 'REVIEW');
    await assert.rejects(identity.manualConfirm({ ...base, mode:'review', manualConfirmed:true,
      reviewToken:reviewed.reviewToken, formFields:fields }, reviewer), (err) => err.code === 'IDENTITY_FIELDS_REQUIRED');
    const complete = { ...fields, recipient:selectedFields.recipient, phone:selectedFields.phone };
    const manual = await identity.manualConfirm({ ...base, mode:'review', manualConfirmed:true,
      reviewToken:reviewed.reviewToken, formFields:complete }, reviewer);
    await identity.verifyApprovalForSubmission({ ...base, ...complete, identityApprovalToken:manual.approvalToken }, reviewer);
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
