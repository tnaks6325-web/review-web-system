/**
 * columnResolver 골든 테스트 (P2a) — 두 빌더 공용 파싱이 슈퍼셋 출력을 정확히 내는지.
 *   특히 smartBuild가 새로 얻는 필드(recipientName/isSubmitted2/submitCol2)를 검증.
 * 실행: node tests/columnResolver.test.js
 */
const assert = require('assert');
const { parseTabRows } = require('../src/services/columnResolver');

const KW = {
  NAME_KEYWORDS: ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'],
  SUBMIT_KEYWORDS: ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'],
  DATA_TAB_KEYWORDS: ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'],
  SUBMITTED_VALUES: ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'],
};

function run() {
  // ── 케이스1: 주문자형(주문자=name, 별도 수취인열) + 입금열 + 상품 ──
  const v1 = [
    ['번호', '주문자', '수취인', '연락처', '리뷰제출', '입금', '상품명'],
    ['1', '홍길동주문', '김수취', '010-1234-5678', 'O', '완료', '샴푸'],
    ['2', '', '', '', '', '', ''], // 이름 없음 → 필터
  ];
  const r1 = parseTabRows(v1, 's1', 'tabA', 'gidA', '캠페인A', KW);
  assert.equal(r1.length, 1, '이름 없는 행은 제외');
  const a = r1[0];
  assert.equal(a.name, '홍길동주문');
  assert.equal(a.recipientName, '김수취', '★ recipientName(수취인열) — smartBuild가 새로 얻는 필드');
  assert.equal(a.isSubmitted, true, '제출값 O → true');
  assert.equal(a.isSubmitted2, 'PAID', '★ 입금 완료 → PAID');
  assert.equal(a.submitCol, '리뷰제출');
  assert.equal(a.submitCol2, '입금', '★ 입금열 헤더명');
  assert.equal(a.productName, '샴푸');
  assert.equal(a.phone8, '12345678');
  assert.equal(a.rowIndex, 2, 'headerRow(0)+1+0+1');
  assert.equal(a.campaignName, '캠페인A');

  // ── 케이스2: 수취인형(수취인=name, 주문자 별도→recipientColIdx) + 입금 미제출 ──
  const v2 = [
    ['번호', '수취인', '주문자', '전화번호', '리뷰', '입금'],
    ['1', '박수취', '이주문', '01099998888', '', ''],
  ];
  const r2 = parseTabRows(v2, 's2', 'tabB', 'gidB', null, KW);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].name, '박수취');
  assert.equal(r2[0].recipientName, '이주문', '수취인형: 주문자열이 recipientColIdx로');
  assert.equal(r2[0].isSubmitted, false, '리뷰 빈값 → false');
  assert.equal(r2[0].isSubmitted2, 'NONE', '입금 빈값 → NONE');
  assert.equal(r2[0].phone8, '99998888');
  assert.equal(r2[0].campaignName, 'tabB', 'campaignTitle 없으면 tabName 폴백');

  // ── 케이스3: 깊은 헤더(메타 행 선행) + 입금열 없음(isSubmitted2 null) ──
  const v3 = [
    ['캠페인명', '테스트'],
    ['구매시간대', '자유'],
    ['번호', '이름', '연락처', '제출완료'],
    ['1', '최이름', '010-1111-2222', '제출'],
  ];
  const r3 = parseTabRows(v3, 's3', 'tabC', 'gidC', '캠C', KW);
  assert.equal(r3.length, 1);
  assert.equal(r3[0].name, '최이름');
  assert.equal(r3[0].recipientName, null, '수취인열 없음 → null');
  assert.equal(r3[0].isSubmitted2, null, '입금열 없음 → null');
  assert.equal(r3[0].isSubmitted, true, '제출완료 열 값 "제출" → true');
  assert.equal(r3[0].rowIndex, 4, '깊은 헤더(row idx 2)+1+0+1');

  // ── 케이스4: 헤더 미검출(데이터탭 키워드 부족) → [] ──
  const v4 = [['컬럼A', '컬럼B'], ['x', 'y']];
  assert.deepEqual(parseTabRows(v4, 's4', 'tabD', 'gidD', 'D', KW), [], '헤더 미검출 → 빈 배열');

  console.log('  케이스1~4 통과 (recipientName/isSubmitted2/submitCol2 포함 슈퍼셋 검증)');
}

try { run(); console.log('columnResolver tests passed'); }
catch (e) { console.error(e); process.exit(1); }
