const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'reviewer-order-identity-test-secret-32-bytes';

const {
  issueReviewerSession,
  verifyReviewerSession,
} = require('../src/services/reviewerSession.service');
const {
  maskedCompatible,
  hashImageBase64,
  issueExtractionProof,
  verifyExtractionProof,
  evaluateSelectedIdentity,
} = require('../src/services/reviewerOrderIdentity.service');

let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log('  ✓ ' + name);
}

const selected = {
  identityKey: 'sub:selected', type: 'sub', name: '김민수', phone: '010-1234-5678',
  address: '서울 강남구 테헤란로 10 미래아파트 101동 1203호', shoppingId: 'kim-id',
};
const other = {
  identityKey: 'sub:other', type: 'sub', name: '박영희', phone: '010-9999-8888',
  address: '부산 해운대구 센텀로 20 202동 505호', shoppingId: 'park-id',
};

(async () => {
  await test('리뷰어 세션은 소유자 UUID와 로그인 명의를 서명한다', async () => {
    const token = issueReviewerSession({ ownerReviewerId:'11111111-1111-4111-8111-111111111111', loginName:'김민수', loginPhone8:'12345678', loginKind:'sub' });
    const p = verifyReviewerSession(token);
    assert.strictEqual(p.ownerReviewerId, '11111111-1111-4111-8111-111111111111');
    assert.strictEqual(p.loginKind, 'sub');
  });

  await test('추출 증명은 이미지 전체 SHA-256과 추출 필드를 결속한다', async () => {
    const imageHash = hashImageBase64(Buffer.from('whole-image').toString('base64'));
    assert.strictEqual(imageHash.length, 64);
    const extracted = { recipient:'김민수', phone:'010-1234-5678', address:'서울 주소' };
    const proof = issueExtractionProof({ imageHash, extracted, ok:true });
    assert.strictEqual(verifyExtractionProof(proof.extractToken, extracted).imageHash, imageHash);
    assert.throws(() => verifyExtractionProof(proof.extractToken, { ...extracted, recipient:'박영희' }), /변경/);
  });

  await test('쿠팡 별표와 원형 가림문자는 위치가 맞으면 저장 명의와 호환된다', async () => {
    assert.ok(maskedCompatible('김*수', '김민수', 'name'));
    assert.ok(maskedCompatible('김○수', '김민수', 'name'));
    assert.ok(maskedCompatible('010-****-5678', '010-1234-5678', 'phone'));
    assert.ok(!maskedCompatible('박*희', '김민수', 'name'));
  });

  await test('완전 추출 주소는 프로필 주소 대신 주문 적용값으로 보존한다', async () => {
    const captureAddress = '서울 강남구 테헤란로 10 미래아파트 101동 1203호 공동현관 앞';
    const r = await evaluateSelectedIdentity({ recipient:'김민수', phone:'010-1234-5678', address:captureAddress }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MATCH');
    assert.strictEqual(r.resolved.address, captureAddress);
  });

  await test('가림 처리된 이름·전화·주소는 선택 명의 저장정보로 완성한다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:'김*수', phone:'010-****-5678', address:'서울 강남구 테헤란로 ** 미래아파트 101동 1203호' }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
    assert.strictEqual(r.resolved.recipient, selected.name);
    assert.strictEqual(r.resolved.phone, selected.phone);
    assert.strictEqual(r.resolved.address, selected.address);
  });

  await test('선택 명의가 아닌 같은 소유자의 다른 명의 캡처는 하드 불일치다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:other.name, phone:other.phone, address:other.address }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MISMATCH', JSON.stringify(r));
    assert.strictEqual(r.competingIdentity.identityKey, other.identityKey);
  });

  await test('선택 명의도 충분히 맞고 중복 저장 명의도 맞으면 수동확인 대상으로 둔다', async () => {
    const duplicate = { ...selected, identityKey:'sub:duplicate' };
    const r = await evaluateSelectedIdentity(
      { recipient:selected.name, phone:selected.phone, address:selected.address },
      selected, [selected, duplicate], { useGemini:false }
    );
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('multiple_identity_candidates'));
  });

  await test('동·호수가 다르면 수동확인으로 우회할 수 없는 불일치다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:'김민수', phone:'010-1234-5678', address:'서울 강남구 테헤란로 10 미래아파트 102동 999호' }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MISMATCH', JSON.stringify(r));
  });

  await test('이름과 주소가 맞고 전화만 다르면 실질 일치의 수동확인 대상이다', async () => {
    const r = await evaluateSelectedIdentity(
      { recipient:'김민수', phone:'010-0000-9999', address:selected.address },
      selected, [selected, other], { useGemini:false }
    );
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('selected_identity_partial_conflict'));
  });

  await test('100% 문자열 일치가 아니어도 이름과 연락처가 일치하면 실질 매칭한다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:'김 민수', phone:'01012345678', address:'서울 역삼동 123-4 101동 1203호' }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error('✗ FAIL:', err.stack || err.message); process.exit(1); });
