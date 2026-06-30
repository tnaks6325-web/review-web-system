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

  // ════════════ P2b: DB컬럼매핑 우선 케이스 ════════════

  // ── 케이스5: DB매핑이 제출/입금 컬럼을 키워드와 다르게 강제(재앵커 통과) ──
  const v5 = [
    ['번호', '주문자', '수취인', '연락처', '완료', '리뷰제출', '입금'],
    ['1', '주문킴', '수취킴', '010-1234-5678', 'O', '', '완료'],
  ];
  const map5 = new Map([
    ['review_submit', { colIndex: 4, header: '완료' }],   // 키워드는 col5(리뷰제출)을 고르지만 DB가 col4 강제
    ['payment', { colIndex: 6, header: '입금' }],
  ]);
  const r5 = parseTabRows(v5, 's5', 't5', 'g5', 'C5', KW, map5);
  assert.equal(r5[0].submitCol, '완료', '★ DB review_submit→col4 override');
  assert.equal(r5[0].isSubmitted, true, 'col4 값 "O" → true');
  assert.equal(r5[0].submitCol2, '입금', 'DB payment→col6');
  assert.equal(r5[0].isSubmitted2, 'PAID', 'col6 "완료" → PAID');
  // 대조: dbColMap 없으면 키워드 = 리뷰제출(col5, 빈값) → false
  const r5b = parseTabRows(v5, 's5', 't5', 'g5', 'C5', KW);
  assert.equal(r5b[0].submitCol, '리뷰제출', '매핑 없으면 키워드(리뷰접두사)');
  assert.equal(r5b[0].isSubmitted, false, 'col5 빈값 → false');

  // ── 케이스6: 재앵커 불일치(저장헤더≠현재헤더) → 키워드 폴백 ──
  const v6 = [
    ['번호', '주문자', '수취인', '연락처', '완료', '리뷰제출'],
    ['1', '주문킴', '수취킴', '010-1234-5678', 'O', ''],
  ];
  const map6 = new Map([['review_submit', { colIndex: 4, header: '리뷰완료' }]]); // 현재 headers[4]='완료'≠'리뷰완료'
  const r6 = parseTabRows(v6, 's6', 't6', 'g6', 'C6', KW, map6);
  assert.equal(r6[0].submitCol, '리뷰제출', '★ 재앵커 불일치 → 키워드 폴백(col5)');

  // ── 케이스7: col_index 범위밖 → 키워드 폴백 ──
  const v7 = [
    ['번호', '주문자', '수취인', '연락처', '리뷰제출'],
    ['1', '주문킴', '수취킴', '010-1234-5678', 'O'],
  ];
  const map7 = new Map([['review_submit', { colIndex: 99, header: '리뷰제출' }]]); // 범위밖
  const r7 = parseTabRows(v7, 's7', 't7', 'g7', 'C7', KW, map7);
  assert.equal(r7[0].submitCol, '리뷰제출', '★ 범위밖 colIndex → 키워드 폴백');
  assert.equal(r7[0].isSubmitted, true);

  // ── 케이스8: DB recipient가 키워드 미검출 열을 지정(재앵커 통과) ──
  const v8 = [
    ['번호', '주문자', '받는사람', '연락처'],
    ['1', '주문킴', '수취킴', '01012345678'],
  ];
  const map8 = new Map([['recipient', { colIndex: 2, header: '받는사람' }]]);
  const r8 = parseTabRows(v8, 's8', 't8', 'g8', 'C8', KW, map8);
  assert.equal(r8[0].recipientName, '수취킴', '★ DB recipient→col2(키워드 미검출 "받는사람")');
  // 대조: 매핑 없으면 '받는사람'은 RECIPIENT_KEYWORDS 불일치 → null
  const r8b = parseTabRows(v8, 's8', 't8', 'g8', 'C8', KW);
  assert.equal(r8b[0].recipientName, null, '키워드만으론 "받는사람" 미검출 → null');

  // ── 케이스9: nameColIdx는 DB override 제외(PII 안전) — 매핑 있어도 키워드 이름열 유지 ──
  const v9 = [
    ['번호', '주문자', '수취인', '연락처', '리뷰제출'],
    ['1', '주문킴', '수취킴', '01012345678', 'O'],
  ];
  // recipient를 col1(주문자=nameColIdx)로 지정해도 name은 키워드(주문자)대로, recipientName만 영향
  const map9 = new Map([['recipient', { colIndex: 1, header: '주문자' }]]);
  const r9 = parseTabRows(v9, 's9', 't9', 'g9', 'C9', KW, map9);
  assert.equal(r9[0].name, '주문킴', '★ name은 키워드 전용(DB override 없음)');

  console.log('  케이스1~9 통과 (P2a 슈퍼셋 + P2b DB매핑 우선/재앵커/범위가드/PII가드)');
}

try { run(); console.log('columnResolver tests passed'); }
catch (e) { console.error(e); process.exit(1); }
