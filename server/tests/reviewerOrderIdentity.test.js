const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'reviewer-order-identity-test-secret-32-bytes';

const {
  issueReviewerSession,
  verifyReviewerSession,
} = require('../src/services/reviewerSession.service');
const {
  maskedCompatible,
  maskedNameOcrNearMiss,
  plainNameOcrCorrectionCandidate,
  hashImageBase64,
  issueExtractionProof,
  verifyExtractionProof,
  evaluateSelectedIdentity,
  getSecureProfile,
} = require('../src/services/reviewerOrderIdentity.service');
const pool = require('../src/db/pool');

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

  await test('보안 프로필은 본계정과 타계정 계좌 3종 세트를 명의별로 반환한다', async () => {
    const originalQuery = pool.query;
    pool.query = async (sql) => {
      if (/FROM reviewers WHERE id/.test(sql)) {
        return { rows: [{
          id:'11111111-1111-4111-8111-111111111111', name:'김수만', phone:'010-1111-2222', phone8:'11112222',
          address:'서울', bank_name:'KEB하나', bank_account:'123456789', account_holder:'김수만', shopping_id:'self-id',
          sub_accounts:[{ name:'김부계', phone:'010-3333-4444', address:'부산', shoppingId:'sub-id',
            bankName:'국민은행', bankAccount:'987654321', accountHolder:'김부계' }],
        }] };
      }
      if (/FROM reviewer_identities/.test(sql)) return { rows: [] };
      throw new Error('unexpected query: ' + sql);
    };
    try {
      const result = await getSecureProfile('11111111-1111-4111-8111-111111111111');
      assert.deepStrictEqual(
        result.profile.identities.map((item) => [item.bankName, item.bankAccount, item.accountHolder]),
        [['KEB하나', '123456789', '김수만'], ['국민은행', '987654321', '김부계']]
      );
    } finally {
      pool.query = originalQuery;
    }
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

  // 실사고 2026-09-24: 같은 사람이 번호만 달리해 두 번 등록(참여 칸은 주소 없음) → 다른 칸이 "다른 명의"로 잡혀 차단.
  await test('같은 이름의 중복 명의는 다른 명의로 보지 않고 재확인으로 둔다', async () => {
    const a1 = { identityKey:'sub:a1', type:'sub', name:'김수만', phone:'010-1111-2222', address:'' };
    const a2 = { identityKey:'sub:a2', type:'sub', name:'김수만', phone:'010-3333-4444', address:'서울 강남구 테헤란로 10 101동 502호' };
    const b  = { identityKey:'sub:b',  type:'sub', name:'이영희', phone:'010-1111-2222', address:'부산 해운대구 센텀로 5 1203호' };
    const r = await evaluateSelectedIdentity({ recipient:'김수만', phone:'010-3333-4444', address:a2.address },
      a1, [a1, a2, b], { useGemini:false, allowPlainNameCorrection:true });
    assert.notStrictEqual(r.status, 'MISMATCH', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('duplicate_name_identity'));
    assert.ok(!r.reasonCodes.includes('other_owner_identity_matches'));
    // 이름이 다른 명의(이영희)의 캡처는 여전히 차단
    const r2 = await evaluateSelectedIdentity({ recipient:'이영희', phone:b.phone, address:b.address },
      a1, [a1, a2, b], { useGemini:false, allowPlainNameCorrection:true });
    assert.strictEqual(r2.status, 'MISMATCH', JSON.stringify(r2));
  });

  await test('가림 이름의 노출 글자 1개 OCR 오류만 근접오류로 제한한다', async () => {
    assert.ok(maskedNameOcrNearMiss('최*회', '최영희'));
    assert.ok(maskedNameOcrNearMiss('김*순', '김민수'));
    assert.ok(!maskedNameOcrNearMiss('박*희', '김민수'));
    assert.ok(!maskedNameOcrNearMiss('김*수', '김민수'));
    assert.ok(!maskedNameOcrNearMiss('김**순', '김민수'));
  });

  // ★ 사용자 확정 2026-09-24(결정 1가): 한 글자(바뀜·빠짐·더해짐)까지만 재확인, 통째로 다르면 차단.
  await test('전체 이름 OCR 불일치는 한 글자 차이까지만 재확인 후보로 둔다', async () => {
    assert.ok(plainNameOcrCorrectionCandidate('업혜연', '임혜연'));
    assert.ok(plainNameOcrCorrectionCandidate('김슈만', '김수만'));
    assert.ok(plainNameOcrCorrectionCandidate('임혜', '임혜연'));
    assert.ok(plainNameOcrCorrectionCandidate('임혜연이', '임혜연'));
    assert.ok(!plainNameOcrCorrectionCandidate('박다른이름', '임혜연'));
    assert.ok(!plainNameOcrCorrectionCandidate('박철수', '김수만'));
    assert.ok(!plainNameOcrCorrectionCandidate('김철만', '김수혁'));
    assert.ok(!plainNameOcrCorrectionCandidate('임혜연', '임혜연'));
    assert.ok(!plainNameOcrCorrectionCandidate('임*연', '임혜연'));
  });

  await test('임혜연을 업혜연으로 읽어도 주소가 맞으면 저장 명의 재확인 대상이다', async () => {
    const lim = {
      identityKey:'self:lim', type:'self', name:'임혜연', phone:'010-3220-5501',
      address:'경기도 의왕시 안양판교로 100 101동 1301호', shoppingId:'lim-id',
    };
    const r = await evaluateSelectedIdentity({
      recipient:'업혜연', phone:'010-2220-5501', address:lim.address,
    }, lim, [lim], { useGemini:false, allowPlainNameCorrection:true });
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('plain_name_ocr_correction'));
  });

  await test('전체 이름 OCR 오탐은 주소 동·호수가 달라도 저장 명의 재확인 대상으로 둔다', async () => {
    const lim = {
      identityKey:'self:lim', type:'self', name:'임혜연', phone:'010-3220-5501',
      address:'경기도 의왕시 안양판교로 100 101동 1301호', shoppingId:'lim-id',
    };
    const r = await evaluateSelectedIdentity({
      recipient:'업혜연', phone:'010-2220-5501', address:'경기도 의왕시 안양판교로 100 102동 1301호',
    }, lim, [lim], { useGemini:false, allowPlainNameCorrection:true });
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('plain_name_ocr_correction'));
  });

  await test('가림 이름 OCR 1글자 오류는 주소에 실제 동·호수 충돌이 없으면 재확인한다', async () => {
    const choi = {
      identityKey:'sub:choi', type:'sub', name:'최영희', phone:'010-8330-9894',
      address:'서울특별시 도봉구 방학로 10 101동 202호', shoppingId:'choi-id',
    };
    const r = await evaluateSelectedIdentity({
      recipient:'최*회', phone:'01083309894', address:'***',
    }, choi, [choi], { useGemini:false });
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('masked_name_ocr_correction'));
  });

  await test('쿠팡 연락처가 가려졌거나 배송 연락처가 달라도 저장정보 재확인 대상으로 둔다', async () => {
    const choi = {
      identityKey:'sub:choi', type:'sub', name:'최영희', phone:'010-8330-9894',
      address:'서울특별시 도봉구 방학로 10 101동 202호', shoppingId:'choi-id',
    };
    const r = await evaluateSelectedIdentity({
      recipient:'최*회', phone:'010-9999-0000', address:'***',
    }, choi, [choi], { useGemini:false });
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('masked_name_ocr_correction'));
  });

  await test('가림 이름 OCR 근접오류라도 실제 동이 다르면 계속 차단한다', async () => {
    const choi = {
      identityKey:'sub:choi', type:'sub', name:'최영희', phone:'010-8330-9894',
      address:'서울특별시 도봉구 방학로 10 101동 202호', shoppingId:'choi-id',
    };
    const r = await evaluateSelectedIdentity({
      recipient:'최*회', phone:'010-****-9894', address:'서울특별시 도봉구 방학로 ** 102동 ***호',
    }, choi, [choi], { useGemini:false });
    assert.strictEqual(r.status, 'MISMATCH', JSON.stringify(r));
    assert.ok(!r.reasonCodes.includes('masked_name_ocr_correction'));
  });

  await test('가림 이름 OCR 근접오류가 다른 저장 명의와 맞으면 계속 차단한다', async () => {
    const choi = {
      identityKey:'sub:choi', type:'sub', name:'최영희', phone:'010-8330-9894',
      address:'서울특별시 도봉구 방학로 10 101동 202호', shoppingId:'choi-id',
    };
    const competing = {
      identityKey:'sub:competing', type:'sub', name:'최영회', phone:'010-8330-9894',
      address:choi.address, shoppingId:'competing-id',
    };
    const r = await evaluateSelectedIdentity({
      recipient:'최*회', phone:'01083309894', address:choi.address,
    }, choi, [choi, competing], { useGemini:false });
    assert.strictEqual(r.status, 'MISMATCH', JSON.stringify(r));
    assert.strictEqual(r.competingIdentity.identityKey, competing.identityKey);
    assert.ok(!r.reasonCodes.includes('masked_name_ocr_correction'));
  });

  await test('완전 추출 주소는 프로필 주소 대신 주문 적용값으로 보존한다', async () => {
    const captureAddress = '서울 강남구 테헤란로 10 미래아파트 101동 1203호 공동현관 앞';
    const r = await evaluateSelectedIdentity({ recipient:'김민수', phone:'010-1234-5678', address:captureAddress }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MATCH');
    assert.strictEqual(r.resolved.address, captureAddress);
  });

  await test('같은 동·호수면 아파트명과 우편번호 표기 차이가 있어도 같은 주소로 본다', async () => {
    const r = await evaluateSelectedIdentity({
      recipient:selected.name, phone:'010-0000-9999',
      address:'(06236) 서울 강남구 테헤란로 10 101동 1203호',
    }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.selectedScore.parts.address.verdict, 'match', JSON.stringify(r));
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
  });

  await test('가림 처리된 이름·전화·주소는 선택 명의 저장정보로 완성한다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:'김*수', phone:'010-****-5678', address:'서울 강남구 테헤란로 ** 미래아파트 101동 1203호' }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
    assert.strictEqual(r.resolved.recipient, selected.name);
    assert.strictEqual(r.resolved.phone, selected.phone);
    assert.strictEqual(r.resolved.address, selected.address);
  });

  // ★ 사용자 확정 2026-09-24(결정 1가): 이름이 다른 저장 명의의 캡처는 재확인 없이 차단.
  await test('다른 이름의 저장 명의와 일치하는 캡처는 차단한다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:other.name, phone:other.phone, address:other.address }, selected, [selected, other], {
      useGemini:false, allowPlainNameCorrection:true,
    });
    assert.strictEqual(r.status, 'MISMATCH', JSON.stringify(r));
    assert.strictEqual(r.competingIdentity.identityKey, other.identityKey);
    assert.ok(!r.reasonCodes.includes('plain_name_ocr_correction'));
  });

  // 같은 이름의 중복 칸은 같은 사람이다 — 캡처가 참여 명의와 완전히 맞으면 수동확인 없이 통과(2026-09-24).
  await test('선택 명의가 충분히 맞으면 같은 이름의 중복 저장 명의가 있어도 통과한다', async () => {
    const duplicate = { ...selected, identityKey:'sub:duplicate' };
    const r = await evaluateSelectedIdentity(
      { recipient:selected.name, phone:selected.phone, address:selected.address },
      selected, [selected, duplicate], { useGemini:false }
    );
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('duplicate_name_identity'));
  });

  await test('이름과 연락처가 일치하고 동·호수만 다르면 직접 확인 대상으로 둔다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:'김민수', phone:'010-1234-5678', address:'서울 강남구 테헤란로 10 미래아파트 102동 999호' }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'REVIEW', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('delivery_address_changed'));
  });

  await test('다른 배송지에서 이름이 다르면 차단하고 연락처만 다르면 확인 후 허용한다', async () => {
    const wrongName = await evaluateSelectedIdentity(
      { recipient:'다른이름', phone:selected.phone, address:'부산 해운대구 새길 20 202동 1508호' },
      selected, [selected, other], { useGemini:false });
    assert.strictEqual(wrongName.status, 'MISMATCH');
    for (const phone of ['010-0000-0000', '']) {
      const r = await evaluateSelectedIdentity(
        { recipient:selected.name, phone, address:'부산 해운대구 새길 20 202동 1508호' },
        selected, [selected, other], { useGemini:false });
      assert.strictEqual(r.status, 'REVIEW');
      assert.ok(r.reasonCodes.includes('delivery_address_changed'));
    }
  });

  await test('가족과 연락처를 공유하거나 중복 명의가 있어도 이름·연락처 일치의 배송지 확인을 유지한다', async () => {
    const destination = '부산 해운대구 새길 20 202동 1508호';
    for (const name of ['가족이름', selected.name]) {
      const family = { ...selected, identityKey:'sub:family', name, address:destination };
      const r = await evaluateSelectedIdentity({ recipient:selected.name, phone:selected.phone, address:destination },
        selected, [selected, family], { useGemini:false });
      assert.strictEqual(r.status, 'REVIEW');
      assert.ok(r.reasonCodes.includes('delivery_address_changed'));
    }
  });

  await test('이름과 주소가 맞고 연락처만 다르면 실질 일치로 승인한다', async () => {
    const r = await evaluateSelectedIdentity(
      { recipient:'김민수', phone:'010-0000-9999', address:selected.address },
      selected, [selected, other], { useGemini:false }
    );
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
    assert.ok(r.reasonCodes.includes('delivery_contact_changed'));
  });

  await test('100% 문자열 일치가 아니어도 이름과 연락처가 일치하면 실질 매칭한다', async () => {
    const r = await evaluateSelectedIdentity({ recipient:'김 민수', phone:'01012345678', address:'서울 역삼동 123-4 101동 1203호' }, selected, [selected, other], { useGemini:false });
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r));
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error('✗ FAIL:', err.stack || err.message); process.exit(1); });
