/**
 * reverseSyncSig 단위 테스트 — 시트→DB 역동기화 provenance 서명(computeRowWriteSig) 회귀 가드.
 *   R1 루프차단의 핵심: "DB가 시트에 쓴 값"의 서명이 안정·결정적이어야 detect가 자기 흔적을 변경으로 오인 안 함.
 * 실행: node tests/reverseSyncSig.test.js
 */
const assert = require('assert');
const { computeRowWriteSig } = require('../src/services/orderLedger.service');

const headers = ['번호', '주문자', '수취인', '연락처', '주소', '금액', '비고', '인애드'];

function run() {
  const od = { orderer: '홍길동', recipient: '김철수', phone: '010-1234-5678', address: '서울 강남', price: '10000', memo: '(테스트)' };

  // 결정적·안정: 같은 입력 → 같은 서명
  const s1 = computeRowWriteSig(headers, od);
  const s2 = computeRowWriteSig(headers, od);
  assert.equal(s1, s2, '같은 입력 → 동일 서명');
  assert.ok(s1.includes('orderer=') && s1.includes('phone=') && s1.includes('address='), '매핑 필드 포함');
  console.log('  안정·결정 통과');

  // 필드 변경 → 서명 변경
  const s3 = computeRowWriteSig(headers, { ...od, address: '서울 서초' });
  assert.notEqual(s1, s3, '주소 변경 → 서명 변경');
  console.log('  변경 감지 통과');

  // 관리자 전용칸(번호/인애드)은 서명에서 제외(매핑 null) — 변경해도 영향 없음
  // (orderData엔 그 필드가 없으므로 동일 입력으로 동일 서명 확인)
  assert.equal(computeRowWriteSig(headers, od), s1, '관리자칸 무관 안정');

  // 옵션·dedup영향칸 selected_opt_key는 역동기 대상서 제외(G4) → 서명에 미포함
  const s4 = computeRowWriteSig(headers, { ...od, selectedOptKey: 'A|B' });
  assert.equal(s1, s4, 'selected_opt_key는 서명에 미포함(G4)');
  console.log('  G4 옵션 제외 통과');

  // 빈 입력 안전
  assert.equal(typeof computeRowWriteSig(headers, {}), 'string', '빈 orderData → 문자열');
  assert.equal(typeof computeRowWriteSig([], od), 'string', '빈 headers → 문자열');
  console.log('  빈 입력 방어 통과');
}

run();
console.log('reverseSyncSig tests passed');
