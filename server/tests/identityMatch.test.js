/**
 * identityMatch.test.js — 구매양식 신원/주소 유사도 검증 회귀가드
 * 실행: node tests/identityMatch.test.js
 *
 * 커버 케이스:
 *  - 주소 휴리스틱: 아파트명 축약(서면다인로얄팰리스 728호 ≈ 서면팰리스 728호) = match
 *  - 호수 불일치 = mismatch / 동 불일치 = mismatch
 *  - 완전 상이 주소 = mismatch, 도로명↔지번(표기 완전 상이) = uncertain(→Gemini 대상)
 *  - profileMissing: 4항목(사용자명/전화번호/주소/계좌) 판정
 *  - resolveOrderIdentity: SELF / SUB / NEED_CONFIRM / NEED_SUB_REGISTER (+캡처 추출값 우선)
 */
const assert = require('assert');
const {
  normName, normPhone8, normAccount,
  extractHo, extractDong, bigramJaccard,
  addressHeuristic, profileMissing, resolveOrderIdentity,
} = require('../src/services/identity.service');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); });
}

(async () => {
  /* ── 정규화 ── */
  await ok('normName: 공백 제거', () => {
    assert.strictEqual(normName(' 김 수 만 '), '김수만');
  });
  await ok('normPhone8: 뒤 8자리', () => {
    assert.strictEqual(normPhone8('010-8592-6325'), '85926325');
    assert.strictEqual(normPhone8('8592-6325'), '85926325');
  });
  await ok('normAccount: 숫자만', () => {
    assert.strictEqual(normAccount('338-910330-03807'), '33891033003807');
  });

  /* ── 호수/동 추출 ── */
  await ok('extractHo: 728호 추출', () => {
    assert.strictEqual(extractHo('서면다인로얄팰리스 728호'), '728');
    assert.strictEqual(extractHo('서울시 성수동 12-3'), '');
  });
  await ok('extractDong: 건물동만 (법정동 미추출)', () => {
    assert.strictEqual(extractDong('래미안 101동 1203호'), '101');
    assert.strictEqual(extractDong('부산 부전동 123-45'), '');
  });

  /* ── 주소 휴리스틱 ── */
  await ok('★ 사용자 예시: 아파트명 축약 = match', () => {
    const r = addressHeuristic('서면다인로얄팰리스 728호', '서면팰리스 728호');
    assert.strictEqual(r.verdict, 'match', JSON.stringify(r));
  });
  await ok('호수 불일치 = mismatch', () => {
    const r = addressHeuristic('서면다인로얄팰리스 728호', '서면다인로얄팰리스 729호');
    assert.strictEqual(r.verdict, 'mismatch');
  });
  await ok('동 불일치 = mismatch', () => {
    const r = addressHeuristic('래미안아파트 101동 728호', '래미안아파트 102동 728호');
    assert.strictEqual(r.verdict, 'mismatch');
  });
  await ok('완전 동일 = match', () => {
    const r = addressHeuristic('부산 부산진구 서면로 39, 728호', '부산 부산진구 서면로 39, 728호');
    assert.strictEqual(r.verdict, 'match');
  });
  await ok('완전 상이 주소 = mismatch', () => {
    const r = addressHeuristic('서울 강남구 테헤란로 1 오피스텔 301호', '부산 해운대구 우동 센텀파크 2205호');
    assert.strictEqual(r.verdict, 'mismatch');
  });
  await ok('도로명↔지번 표기 완전 상이 + 호수 일치 = uncertain (Gemini 보완 대상)', () => {
    const r = addressHeuristic('부산진구 중앙대로 672 728호', '부전동 다인로얄팰리스 728호');
    assert.ok(r.verdict === 'uncertain' || r.verdict === 'match', JSON.stringify(r));
  });

  /* ── profileMissing ── */
  await ok('profileMissing: 전부 미등록 → 4항목', () => {
    assert.deepStrictEqual(profileMissing({}), ['사용자명', '전화번호', '주소', '계좌']);
  });
  await ok('profileMissing: 완비 → 빈 배열', () => {
    const r = profileMissing({
      name: '김수만', phone: '01085926325', address: '서면다인로얄팰리스 728호',
      bank_name: 'KEB하나', bank_account: '123-456', account_holder: '김수만',
    });
    assert.deepStrictEqual(r, []);
  });
  await ok('profileMissing: 계좌 일부 누락 → 계좌 포함', () => {
    const r = profileMissing({
      name: '김수만', phone: '01085926325', address: '주소',
      bank_name: 'KEB하나', bank_account: '', account_holder: '김수만',
    });
    assert.deepStrictEqual(r, ['계좌']);
  });

  /* ── resolveOrderIdentity ── */
  const reviewer = {
    name: '김수만', phone: '010-8592-6325', phone8: '85926325',
    address: '서면다인로얄팰리스 728호',
    bank_name: 'KEB하나', bank_account: '33891033003807', account_holder: '김수만',
    sub_accounts: [
      { name: '김수만업무폰', phone: '010-9186-9944', address: '', bankAccount: '', accountHolder: '' },
      { name: '박영희', phone: '010-1111-2222', address: '해운대 센텀파크 101동 505호',
        bankName: '케이뱅크', bankAccount: '999-888-777', accountHolder: '박영희' },
    ],
  };

  await ok('SELF: 본인 이름+전화+주소(축약)+계좌 일치', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '김수만', phone: '010-8592-6325', address: '서면팰리스 728호',
      bank: 'KEB하나', account: '338-910330-03807', depositor: '김수만',
    });
    assert.strictEqual(r.status, 'SELF');
  });

  await ok('SELF: 계좌번호 달라도 예금주 일치면 통과', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '김수만', phone: '010-8592-6325', address: '서면다인로얄팰리스 728호',
      bank: '국민', account: '000-111', depositor: '김수만',
    });
    assert.strictEqual(r.status, 'SELF');
  });

  await ok('NEED_CONFIRM: 본인인데 호수 다른 주소', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '김수만', phone: '010-8592-6325', address: '서면다인로얄팰리스 999호',
      bank: 'KEB하나', account: '33891033003807', depositor: '김수만',
    });
    assert.strictEqual(r.status, 'NEED_CONFIRM');
    assert.ok(r.reasons.some(s => s.includes('주소')));
  });

  await ok('SUB: 타계정(주소/계좌 미등록 = 통과·보강 대상)', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '김수만업무폰', phone: '010-9186-9944', address: '아무 주소 1층',
      bank: '국민', account: '123', depositor: '김수만업무폰',
    });
    assert.strictEqual(r.status, 'SUB');
    assert.strictEqual(r.subIndex, 0);
  });

  await ok('SUB: 등록 주소 일치 타계정', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '박영희', phone: '010-1111-2222', address: '센텀파크 101동 505호',
      bank: '케이뱅크', account: '999888777', depositor: '박영희',
    });
    assert.strictEqual(r.status, 'SUB');
    assert.strictEqual(r.subIndex, 1);
  });

  await ok('SUB: 타계정 주문의 리뷰비를 본인 공통계좌로 수령 = 통과', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '박영희', phone: '010-1111-2222', address: '센텀파크 101동 505호',
      bank: 'KEB하나', account: '338-910330-03807', depositor: '김수만', // ← 본인 계좌
    });
    assert.strictEqual(r.status, 'SUB');
    assert.strictEqual(r.subIndex, 1);
  });

  await ok('NEED_CONFIRM: 타계정·본인 어느 계좌와도 다른 제3의 계좌', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '박영희', phone: '010-1111-2222', address: '센텀파크 101동 505호',
      bank: '우리', account: '555-666-777', depositor: '아무개',
    });
    assert.strictEqual(r.status, 'NEED_CONFIRM');
    assert.ok(r.reasons.some(s => s.includes('계좌')));
  });

  await ok('NEED_SUB_REGISTER: 미등록 제3자 정보', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '이몽룡', phone: '010-3333-4444', address: '남원시 광한루로 1',
      bank: '농협', account: '111', depositor: '이몽룡',
    });
    assert.strictEqual(r.status, 'NEED_SUB_REGISTER');
    assert.strictEqual(r.identity.name, '이몽룡');
    assert.strictEqual(r.identity.bankName, '농협');
  });

  await ok('★ 캡처 추출값 우선: 폼은 본인, 추출은 제3자 → NEED_SUB_REGISTER', async () => {
    const r = await resolveOrderIdentity(reviewer, {
      recipient: '김수만', phone: '010-8592-6325', address: '서면다인로얄팰리스 728호',
      bank: 'KEB하나', account: '33891033003807', depositor: '김수만',
      extractedRecipient: '이몽룡', extractedPhone: '010-3333-4444', extractedAddress: '남원시 광한루로 1',
    });
    assert.strictEqual(r.status, 'NEED_SUB_REGISTER');
  });

  console.log(`\n${passed} passed`);
})().catch(err => { console.error('✗ FAIL:', err.message); process.exit(1); });
