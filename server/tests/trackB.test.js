/**
 * Track B 순수 로직 회귀가드 — identityKey(정렬무관 내용키) + classifyParity(3버킷 분류).
 * DB 불필요(순수 함수). 실행: node tests/trackB.test.js
 */
const assert = require('assert');
const { identityKey, classifyParity } = require('../src/services/trackB.service');

function run() {
  // ── identityKey: 주문번호 6자리↑ → num: (정렬·행이동에 불변) ──
  assert.equal(identityKey({ orderNum: '17101366468607', phone8: '82217191' }), 'num:17101366468607',
    '1: 주문번호 강하면 num: 키');
  assert.equal(identityKey({ orderNum: '123', recipient: '박은비', phone8: '010-8221-7191', dateStr: '6/25', optKey: 'Black|L' }),
    'rcp:박은비|82217191|6/25|Black|L', '2: 약한 주문번호 → 내용키(수취인+phone8+날짜+옵션)');
  assert.equal(identityKey({ phone8: '82217191' }), 'phone8:82217191', '3: 신원 약하면 phone8 폴백');
  assert.equal(identityKey({}), '', '4: 근거 전무면 빈 키');
  // 정렬 무관 불변: 같은 주문번호는 행 위치와 무관하게 같은 키
  assert.equal(identityKey({ orderNum: '17101366468607' }), identityKey({ orderNum: '17101366468607', phone8: 'x' }),
    '5: num 키는 phone 유무와 무관하게 동일(정렬 불변)');
  console.log('  1. identityKey — num/rcp/phone8 폴백 + 정렬 불변 ✓');

  // ── classifyParity: phone8로 짝짓기, 3버킷 ──
  // 완전 일치
  let A = [{ phone8:'11111111', submitted:true, paid:false, round:'1' }];
  let B = [{ phone8:'11111111', submitted:true, paid:false, round:'1', source:'import' }];
  let r = classifyParity(A, B);
  assert.equal(r.buckets.match, 1, '6: 상태 동일 → match');
  assert.equal(r.buckets.real, 0);
  assert.equal(r.pass, true, '6: 진짜 불일치 0 → pass');
  console.log('  2. 완전 일치 → match, pass ✓');

  // A 중복(같은 phone8 2행) + B 1행 = BD-3 benign dedup
  A = [{ phone8:'22222222', submitted:true, paid:true, round:'' }, { phone8:'22222222', submitted:true, paid:true, round:'' }];
  B = [{ phone8:'22222222', submitted:true, paid:true, round:'', source:'import' }];
  r = classifyParity(A, B);
  assert.ok(r.buckets.benign >= 1 && r.buckets.real === 0, '7: A 중복 → B dedup = benign(BD-3), real 0');
  console.log('  3. A 중복 → benign dedup(BD-3) ✓');

  // B-only manual = benign, B-only import = real
  A = [];
  B = [{ phone8:'33333333', submitted:false, paid:false, round:'', source:'manual' }];
  r = classifyParity(A, B);
  assert.equal(r.buckets.real, 0, '8: B-only manual → benign(real 0)');
  B = [{ phone8:'44444444', submitted:false, paid:false, round:'', source:'import' }];
  r = classifyParity(A, B);
  assert.equal(r.buckets.real, 1, '8: B-only import(A에 없음) → real');
  assert.equal(r.pass, false);
  console.log('  4. B-only: manual=benign / import=real ✓');

  // A-only(B 누락) = real
  A = [{ phone8:'55555555', submitted:true, paid:false, round:'', source:'import' }];
  B = [];
  r = classifyParity(A, B);
  assert.equal(r.buckets.real, 1, '9: A-only(그림자 누락) → real');
  console.log('  5. A-only → real ✓');

  // 상태 불일치(짝은 됐으나 제출/입금 다름) = real
  A = [{ phone8:'66666666', submitted:true, paid:false, round:'1' }];
  B = [{ phone8:'66666666', submitted:false, paid:false, round:'1', source:'import' }];
  r = classifyParity(A, B);
  assert.equal(r.buckets.real, 1, '10: 제출상태 다름 → real(state_diff)');
  assert.equal(r.realSample[0].kind, 'state_diff');
  console.log('  6. 상태 불일치 → real(state_diff) ✓');

  // 짝짓기는 phone8(행번호 아님) — 순서 뒤섞여도 정확
  A = [{ phone8:'77777777', submitted:true, paid:false, round:'' }, { phone8:'88888888', submitted:false, paid:false, round:'' }];
  B = [{ phone8:'88888888', submitted:false, paid:false, round:'', source:'import' }, { phone8:'77777777', submitted:true, paid:false, round:'', source:'import' }];
  r = classifyParity(A, B);
  assert.equal(r.buckets.match, 2, '11: 순서 뒤섞여도 phone8 짝짓기로 전부 일치(정렬 무관)');
  assert.equal(r.pass, true);
  console.log('  7. phone8 짝짓기 — 순서 무관 정확(정렬 면역) ✓');

  console.log('✅ trackB 테스트 전체 통과');
}

run();
