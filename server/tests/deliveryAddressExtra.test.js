'use strict';
/*
 * 본계정 추가 배송지 — 결정 226 (사용자 확정 2026-10-13 (나) · migration 186)
 *   같은 번호 타계정을 합치며 남긴 받는 사람·주소를 본계정 주소처럼 쓴다.
 *   A. 명의 확인(새 판정): 본인 번호 + 추가 배송지 = 등록 주소로 인정(다른 배송지 확인 단계 없음) · 남의 번호·타계정 참여는 그대로
 *   B. 제출 관문(옛 판정): 같은 기준으로 SELF
 *   C. 배선: 구매양식 응답·고르기 목록·주소 고르기 · 두 호출처가 목록을 싣는다 · 시작 점검
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'delivery-address-extra-test-secret-32b';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

(async () => {
  const { evaluateSelectedIdentity } = require('../src/services/reviewerOrderIdentity.service');
  const { resolveOrderIdentity } = require('../src/services/identity.service');
  const HOME = '서울 마포구 월드컵로 10 한빛아파트 101동 202호';
  const PARENTS = '전북 전주시 완산구 효자로 50 푸른빌라 3동 105호';
  const self = (extra) => ({ identityKey: 'self', type: 'self', name: '정본인', phone: '010-7171-2222', address: HOME,
    deliveryAddresses: extra ? [{ id: '1', recipient: '이가족', address: PARENTS }] : [] });
  const opt = { useGemini: false, ownerPhoneRule: true };

  console.log('A. 명의 확인');
  await test('본인 번호 + 추가 배송지 → 바로 통과(다른 배송지 확인 없음)', async () => {
    const r = await evaluateSelectedIdentity({ recipient: '이가족', phone: '010-7171-2222', address: PARENTS }, self(true), [self(true)], opt);
    assert.strictEqual(r.status, 'MATCH', JSON.stringify(r.reasonCodes));
    assert.ok(r.reasonCodes.includes('registered_delivery_address'));
    assert.ok(!r.reasonCodes.includes('delivery_address_changed'));
  });
  await test('추가 배송지가 없으면 종전대로 확인 단계(다른 배송지)', async () => {
    const r = await evaluateSelectedIdentity({ recipient: '이가족', phone: '010-7171-2222', address: PARENTS }, self(false), [self(false)], opt);
    assert.strictEqual(r.status, 'REVIEW');
    assert.ok(r.reasonCodes.includes('delivery_address_changed'));
  });
  await test('본인 이름 + 추가 배송지도 통과', async () => {
    const r = await evaluateSelectedIdentity({ recipient: '정본인', phone: '010-5555-6666', address: PARENTS }, self(true), [self(true)], opt);
    assert.strictEqual(r.parts ? r.parts.address.verdict : r.selectedScore.parts.address.verdict, 'match');
  });
  await test('남의 이름·남의 번호면 추가 배송지와 같아도 인정하지 않는다', async () => {
    const r = await evaluateSelectedIdentity({ recipient: '홍길동', phone: '010-9999-0000', address: PARENTS }, self(true), [self(true)], opt);
    assert.notStrictEqual(r.status, 'MATCH');
    assert.ok(!r.reasonCodes.includes('registered_delivery_address'));
  });
  await test('가린 본인 번호는 종전대로 확인 단계 — 주소는 추가 배송지로 맞춰 "다른 배송지"가 붙지 않는다', async () => {
    const r = await evaluateSelectedIdentity({ recipient: '이가족', phone: '010-****-2222', address: PARENTS }, self(true), [self(true)], opt);
    assert.strictEqual(r.status, 'REVIEW');
    assert.ok(r.reasonCodes.includes('owner_phone_recipient_masked'));
    assert.ok(!r.reasonCodes.includes('delivery_address_changed'));
  });
  await test('가린 주소가 추가 배송지와 맞으면 그 주소로 펼친다(집 주소로 덮지 않음)', async () => {
    const r = await evaluateSelectedIdentity({ recipient: '정본인', phone: '010-7171-2222', address: '전북 전주시 완산구 효자로 ** 푸른빌라 3동 105호' },
      self(true), [self(true)], opt);
    assert.strictEqual(r.selectedScore.parts.address.verdict, 'match');
    assert.strictEqual(r.resolved.address, PARENTS);
  });
  await test('가린 주소가 집 주소와 추가 배송지에 똑같이 맞으면 자동 승인하지 않는다(실제 주소를 고르게)', async () => {
    const near = { ...self(true), address: '전북 전주시 완산구 효자로 50 푸른빌라 3동 202호' };
    const r = await evaluateSelectedIdentity({ recipient: '정본인', phone: '010-7171-2222', address: '전북 전주시 완산구 효자로 50 푸른빌라 3동 ***호' },
      near, [near], opt);
    assert.strictEqual(r.status, 'REVIEW');
    assert.ok(r.reasonCodes.includes('masked_address_ambiguous'));
    assert.ok(/\*/.test(r.resolved.address), '어느 주소로도 펼치지 않는다');
  });
  await test('같은 주소를 두 받는 사람이 써도 가린 주소는 하나로 보고 펼친다', async () => {
    const two = { ...self(false), deliveryAddresses: [{ id: '1', recipient: '이가족', address: PARENTS }, { id: '2', recipient: '이둘째', address: PARENTS }] };
    const r = await evaluateSelectedIdentity({ recipient: '이가족', phone: '010-7171-2222', address: '전북 전주시 완산구 효자로 ** 푸른빌라 3동 105호' }, two, [two], opt);
    assert.ok(!r.reasonCodes.includes('masked_address_ambiguous'));
    assert.strictEqual(r.resolved.address, PARENTS);
  });
  await test('AI 주소 비교는 추가 배송지 수와 상관없이 최대 한 번(휴리스틱 먼저)', async () => {
    const roi = read('src/services/reviewerOrderIdentity.service.js');
    assert.ok(/addressHeuristic\(raw, extra\.address\)[\s\S]{0,400}if \(!hit && firstUncertain && options\.useGemini\)/.test(roi));
    const id = read('src/services/identity.service.js');
    assert.ok(/addressHeuristic\(addr, idAddr\)[\s\S]{0,300}if \(firstUncertain && opts\.useGemini\)/.test(id));
    assert.ok(!/MAX_EXTRA_ADDRESS_COMPARE|\.slice\(0, 20\)/.test(roi + id), '휴리스틱 비교는 자르지 않는다(AI 만 한 번)');
  });
  await test('추가 배송지는 승인 증명에 묶인다 · 없으면 종전과 같은 해시', async () => {
    const { profileHash } = require('../src/services/reviewerOrderIdentity.service')._test;
    const plain = { identityKey: 'self', name: '정본인', phone: '010-7171-2222', address: HOME };
    assert.strictEqual(profileHash({ ...plain, deliveryAddresses: [] }), profileHash(plain));
    assert.notStrictEqual(profileHash({ ...plain, deliveryAddresses: [{ recipient: '이가족', address: PARENTS }] }), profileHash(plain));
  });
  await test('타계정 참여에는 추가 배송지를 쓰지 않는다', async () => {
    const sub = { identityKey: 'sub:x', type: 'sub', name: '박다른', phone: '010-7373-4444', address: HOME,
      deliveryAddresses: [{ id: '1', recipient: '이가족', address: PARENTS }] };
    const r = await evaluateSelectedIdentity({ recipient: '박다른', phone: '010-7373-4444', address: PARENTS }, sub, [sub], opt);
    assert.ok(!r.reasonCodes.includes('registered_delivery_address'));
  });

  console.log('B. 제출 관문');
  const reviewer = (extra) => ({ id: 'r', name: '정본인', phone: '010-7171-2222', phone8: '71712222', address: HOME,
    bank_name: '국민', bank_account: '12345', account_holder: '정본인', sub_accounts: [],
    deliveryAddresses: extra ? [{ id: '1', recipient: '이가족', address: PARENTS }] : [] });
  const order = { recipient: '이가족', phone: '010-7171-2222', address: PARENTS, bank: '국민', account: '12345', depositor: '정본인',
    extractedRecipient: '이가족', extractedPhone: '010-7171-2222', extractedAddress: PARENTS };
  await test('본인 번호 + 추가 배송지 → SELF', async () => {
    const r = await resolveOrderIdentity(reviewer(true), order, { mode: 'submit' });
    assert.strictEqual(r.status, 'SELF', JSON.stringify(r));
  });
  await test('추가 배송지가 없으면 종전대로 확인 요청', async () => {
    const r = await resolveOrderIdentity(reviewer(false), order, { mode: 'submit' });
    assert.strictEqual(r.status, 'NEED_CONFIRM');
  });

  console.log('C. 배선');
  await test('구매양식 응답은 본계정 참여에만 추가 배송지를 싣는다', async () => {
    const s = read('src/services/reviewerOrderIdentity.service.js');
    assert.ok(/deliveryAddresses: context\.selected\.type === 'self'/.test(s));
    assert.ok(/identities\[0\]\.deliveryAddresses = await require\('\.\/reviewerIdentityFold\.service'\)\.loadDeliveryAddresses/.test(s));
  });
  await test('제출 관문·제출 전 대조 모두 추가 배송지를 싣는다', async () => {
    assert.ok(/_rv\.deliveryAddresses = await require\('\.\.\/services\/reviewerIdentityFold\.service'\)\.loadDeliveryAddresses\(pool, _rv\.id\)/.test(read('src/routes/submit.routes.js')));
    assert.ok(/reviewer\.deliveryAddresses = await require\('\.\.\/services\/reviewerIdentityFold\.service'\)\.loadDeliveryAddresses\(pool, reviewer\.id\)/.test(read('src/routes/reviewer.routes.js')));
    const id = read('src/services/identity.service.js');
    assert.strictEqual((id.match(/await _registeredAddressCheck\(reviewer, idAddr,/g) || []).length, 2);
  });
  await test('화면 — 「내 정보에서 선택」에 "추가 배송지"로 · 주소 고르기에 저장 주소로 · 타계정 참여에는 안 붙음', async () => {
    const f = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/search-app.js'), 'utf8');
    const scoped = f.slice(f.indexOf('function _scopedSavedOrderIdentities'), f.indexOf('function _scopedSavedOrderIdentities') + 1400);
    assert.ok(/selected\?\.type === "sub"[\s\S]*\} else if \(selected\) \{[\s\S]*deliveryAddresses/.test(scoped));
    assert.ok(/item\.type === "delivery" \? "추가 배송지"/.test(f));
    assert.ok(/if \(sel\.type !== "sub"\) \(Array\.isArray\(_activeIdentityContext\?\.deliveryAddresses\)/.test(f));
  });
  await test('조회 실패는 빈 목록(종전 동작) · 시작 점검에 186', async () => {
    const fold = require('../src/services/reviewerIdentityFold.service');
    const out = await fold.loadDeliveryAddresses({ query: async () => { const e = new Error('x'); e.code = '42P01'; throw e; } }, 'o');
    assert.deepStrictEqual(out, []);
    assert.ok(/\['reviewer_delivery_addresses', 'address_key'\]/.test(read('index.js')));
    // 정리는 x·X 가림 주소도 추가 배송지로 남기지 않는다(명의 확인 MASK_RE 와 같은 규칙)
    assert.ok(/const ADDR_MASK_RE = \/\[\*＊●○◯◉•·xX\]\/;/.test(read('src/services/reviewerIdentityFold.service.js')));
  });

  console.log(`\n✅ deliveryAddressExtra: ${passed}개 통과`);
  process.exit(0);
})().catch((err) => { console.error('❌', err && err.stack || err); process.exit(1); });
