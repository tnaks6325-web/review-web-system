/**
 * columnResolver 골든 테스트 (P2a) — 두 빌더 공용 파싱이 슈퍼셋 출력을 정확히 내는지.
 *   특히 smartBuild가 새로 얻는 필드(recipientName/isSubmitted2/submitCol2)를 검증.
 * 실행: node tests/columnResolver.test.js
 */
const assert = require('assert');
const { parseTabRows, findPaymentColumnIndex } = require('../src/services/columnResolver');

const KW = {
  NAME_KEYWORDS: ['수취인', '이름', '신청자', '참여자', '수취인명', '주문자', '성함', '예금주', '성명'],
  SUBMIT_KEYWORDS: ['리뷰완료', '제출', '완료', 'submit', '제출완료', '리뷰제출', '리뷰'],
  DATA_TAB_KEYWORDS: ['번호', '주문자', '수취인', '수취인명', '성함', '이름', '성명', '신청자', '연락처', '전화번호'],
  SUBMITTED_VALUES: ['TRUE', 'true', '1', '제출', 'O', 'o', '완료', 'Y', 'y'],
};

function run() {
  assert.equal(findPaymentColumnIndex(['번호', '입금자명', '입금일']), 2, '입금자명은 제외하고 입금일을 선택한다');
  assert.equal(findPaymentColumnIndex(['번호', '입금자명', '(입금 여부)']), 2, '공백·괄호가 있는 입금 여부도 선택한다');
  assert.equal(findPaymentColumnIndex(['번호', '입금자명', '입금 확인 날짜']), 2, '긴 입금 확인 헤더도 선택한다');

  // ── 케이스1: 주문자형(주문자=name, 별도 수취인열) + 입금열 + 상품 ──
  const v1 = [
    ['번호', '주문자', '수취인', '연락처', '리뷰제출', '입금', '상품명'],
    ['1', '홍길동주문', '김수취', '010-1234-5678', 'O', '완료', '샴푸'],
    ['2', '', '', '', '', '', ''], // 이름 없음 → 필터
  ];
  const r1 = parseTabRows(v1, 's1', 'tabA', 'gidA', '캠페인A', KW,
    new Map([['review_submit', { colIndex: 4, header: '리뷰제출' }]]));
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

  const paymentDateHeader = parseTabRows([
    ['번호', '주문자', '연락처', '리뷰제출', '입금일'],
    ['1', '테스터', '010-1111-2222', 'O', ''],
  ], 's-payment-date', 'payment-date', 'gid-payment-date', '입금일 테스트', KW,
    new Map([['review_submit', { colIndex: 3, header: '리뷰제출' }]]));
  assert.equal(paymentDateHeader[0].submitCol2, '입금일');
  assert.equal(paymentDateHeader[0].isSubmitted2, 'NONE');
  assert.equal(a.campaignName, '캠페인A');

  // ── 케이스2: 주문자 우선순위 — 수취인이 더 왼쪽이어도 주문자열을 이름으로(리뷰어=구매자). ──
  //   (구 동작: name=수취인. 신 동작: 주문자 우선 → name=주문자, 수취인은 recipientName.)
  const v2 = [
    ['번호', '수취인', '주문자', '전화번호', '리뷰', '입금'],
    ['1', '박수취', '이주문', '01099998888', '', ''],
  ];
  const r2 = parseTabRows(v2, 's2', 'tabB', 'gidB', null, KW,
    new Map([['review_submit', { colIndex: 4, header: '리뷰' }]]));
  assert.equal(r2.length, 1);
  assert.equal(r2[0].name, '이주문', '★ 주문자 우선: 수취인이 왼쪽이어도 주문자가 이름열');
  assert.equal(r2[0].recipientName, '박수취', '★ 주문자 우선 시 수취인은 recipientName로');
  assert.equal(r2[0].isSubmitted, false, '리뷰 빈값 → false');
  assert.equal(r2[0].isSubmitted2, 'NONE', '입금 빈값 → NONE');
  assert.equal(r2[0].phone8, '99998888');
  assert.equal(r2[0].campaignName, 'tabB', 'campaignTitle 없으면 tabName 폴백');

  // ── 케이스2b: 주문자제출(제출 문구 포함)도 '주문자' 포함매칭으로 이름열 우선 획득 ──
  const v2b = [
    ['번호', '인애드명단', '주문자제출', '수취인', '연락처', '리뷰제출'],
    ['1', '인애드A', '제출한이름', '받는이', '010-2222-3333', 'O'],
  ];
  const r2b = parseTabRows(v2b, 's2b', 'tabB2', 'g', null, KW,
    new Map([['review_submit', { colIndex: 5, header: '리뷰제출' }]]));
  assert.equal(r2b[0].name, '제출한이름', '★ 주문자제출 열이 이름열(주문자 포함매칭)');

  // ── 케이스2c: 주문자열이 없으면 나머지 NAME_KEYWORDS(수취인) 폴백 ──
  const v2c = [
    ['번호', '수취인', '연락처', '리뷰제출'],
    ['1', '수취만', '010-4444-5555', 'O'],
  ];
  const r2c = parseTabRows(v2c, 's2c', 'tabB3', 'g', null, KW,
    new Map([['review_submit', { colIndex: 3, header: '리뷰제출' }]]));
  assert.equal(r2c[0].name, '수취만', '★ 주문자 없으면 수취인 폴백');

  // ── 케이스3: 깊은 헤더(메타 행 선행) + 입금열 없음(isSubmitted2 null) ──
  const v3 = [
    ['캠페인명', '테스트'],
    ['구매시간대', '자유'],
    ['번호', '이름', '연락처', '제출완료'],
    ['1', '최이름', '010-1111-2222', '제출'],
  ];
  const r3 = parseTabRows(v3, 's3', 'tabC', 'gidC', '캠C', KW,
    new Map([['review_submit', { colIndex: 3, header: '제출완료' }]]));
  assert.equal(r3.length, 1);
  assert.equal(r3[0].name, '최이름');
  assert.equal(r3[0].recipientName, null, '수취인열 없음 → null');
  assert.equal(r3[0].isSubmitted2, null, '입금열 없음 → null');
  assert.equal(r3[0].isSubmitted, true, '제출완료 열 값 "제출" → true');
  assert.equal(r3[0].rowIndex, 4, '깊은 헤더(row idx 2)+1+0+1');

  // ── 케이스4: 헤더 미검출(데이터탭 키워드 부족) → [] ──
  const v4 = [['컬럼A', '컬럼B'], ['x', 'y']];
  assert.deepEqual(parseTabRows(v4, 's4', 'tabD', 'gidD', 'D', KW), [], '헤더 미검출 → 빈 배열');

  // ── 케이스4b(회귀가드, 8/3 박은비 탭 실측 사고): '리뷰가이드'(작업지시, 항상 값 있음)가
  //   '리뷰제출'(실제 완료열)보다 왼쪽이어도 완료열이 우선돼야 한다. SUBMIT_KEYWORDS에 섞인
  //   bare '리뷰'가 우선탐지 AND조건을 무력화해 '리뷰가이드'를 제출열로 오판정하던 버그.
  const v4b = [
    ['번호', '담당자', '구매일자', '리뷰가이드', '주문자제출', '수취인', '연락처', '리뷰제출', '입금'],
    ['1', '', '8 / 3 (월)', '텍스트', '박은비', '박은비', '010-8221-7191', '', ''],   // 미제출: 리뷰가이드만 값 있음
    ['2', '', '8 / 3 (월)', '텍스트', '조혜진', '조혜진', '010-2299-9096', 'O', ''],  // 제출완료: 리뷰제출='O'
  ];
  const r4b = parseTabRows(v4b, 's4b', 'tabD2', 'gidD2', 'D2', KW,
    new Map([['review_submit', { colIndex: 7, header: '리뷰제출' }]]));
  assert.equal(r4b[0].submitCol, '리뷰제출', "★ 제출열이 '리뷰가이드'가 아니라 '리뷰제출'로 잡혀야 함");
  assert.equal(r4b[0].isSubmitted, false, "★ 리뷰가이드만 값이 있고 리뷰제출은 공란 → 미제출");
  assert.equal(r4b[1].isSubmitted, true, "리뷰제출='O' → 제출완료");

  // ── 케이스4c(회귀가드, 8/4 면마스크 탭 실측 재발): 4b 수정이 만든 회귀 — 완료열 이름이
  //   접미사 없이 '리뷰' 단독뿐인 정상 시트에서, 4b가 1·2단계에서 bare '리뷰' 매칭을 뺀 탓에
  //   3단계(최후수단)로 넘어갔는데 그 단계엔 이름열 제외패턴이 없어 '주문자제출'(이름열,
  //   '제출' 포함)을 먼저 집어 전원 제출완료로 오판정했다. 3단계도 이름열 제외패턴을 타야 한다.
  const v4c = [
    ['번호', '담당자', '구매일자', '인애드명단', '주문번호', '주문자제출', '수취인', 'id', '연락처', '리뷰', '입금', '캡쳐본'],
    ['66', '망고', '8 / 4 (화)', '서규리', '2026080459290341', '서규리', '서규리', 'skr1919', '010-3808-4882', '', '', ''],   // 미제출: 리뷰 공란
    ['1', '망고', '7 / 29 (수)', '', '2026072966259711', '이보윤', '이보윤', 'ls444', '010-8982-2059', '7/30 12:02', '7/31', ''],  // 제출완료
  ];
  const r4c = parseTabRows(v4c, 's4c', 'tabD3', 'gidD3', 'D3', KW,
    new Map([['review_submit', { colIndex: 9, header: '리뷰' }]]));
  assert.equal(r4c[0].submitCol, '리뷰', "★ 제출열이 '주문자제출'이 아니라 '리뷰'로 잡혀야 함(bare 리뷰 열은 3단계에서 허용)");
  assert.equal(r4c[0].isSubmitted, false, "★ 리뷰 열이 공란이면 주문자제출에 이름이 있어도 미제출");
  assert.equal(r4c[1].isSubmitted, true, "리뷰 열에 값 있으면 제출완료");

  // ── 케이스4d(같은 계열 실측, 8/4 다른 캠페인 탭): 완료열이 '리뷰캡쳐본'(완료신호 단어 없이
  //   '리뷰'+임의 접미사)인 시트도 같은 방식으로 '주문자제출'에 밀리지 않고 정상 판정돼야 함.
  const v4d = [
    ['번호', '담당자', '구매일자', '인애드명단', '주문번호', '주문자제출', '수취인', 'id', '연락처', '주소', '은행', '계좌번호', '예금주', '결제금액', '리뷰캡쳐본', '입금', '포스팅URL'],
    ['1', '', '2026.4.23', '김지현', '2026042333403631', '김지현', '김지현', 'kjhu929', '010-8326-2237', '주소', '국민', '578601-01-301307', '김지현', '69900', 'TRUE', '5/7', 'url'],
    ['6', '', '2026.4.23', '곽혜련', '2026042331659801', '곽혜련', '곽혜련', 'khr1457', '010-6803-1457', '주소', '우리', '1002-053-875785', '곽혜련', '39900', '', '', ''],
  ];
  const r4d = parseTabRows(v4d, 's4d', 'tabD4', 'gidD4', 'D4', KW,
    new Map([['review_submit', { colIndex: 14, header: '리뷰캡쳐본' }]]));
  assert.equal(r4d[0].submitCol, '리뷰캡쳐본', "★ 제출열이 '주문자제출'이 아니라 '리뷰캡쳐본'으로 잡혀야 함");
  assert.equal(r4d[0].isSubmitted, true, "리뷰캡쳐본='TRUE' → 제출완료");
  assert.equal(r4d[1].isSubmitted, false, "리뷰캡쳐본 공란 → 미제출");

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
  // 대조: review_submit 매핑이 없으면 키워드 추측 없이 안전하게 미제출.
  const r5b = parseTabRows(v5, 's5', 't5', 'g5', 'C5', KW);
  assert.equal(r5b[0].submitCol, '', '매핑 없으면 제출열 미선택');
  assert.equal(r5b[0].isSubmitted, false, '매핑 없으면 항상 미제출');

  // ── 케이스6: 재앵커 불일치(저장헤더≠현재헤더) → 안전하게 미제출 ──
  const v6 = [
    ['번호', '주문자', '수취인', '연락처', '완료', '리뷰제출'],
    ['1', '주문킴', '수취킴', '010-1234-5678', 'O', ''],
  ];
  const map6 = new Map([['review_submit', { colIndex: 4, header: '리뷰완료' }]]); // 현재 headers[4]='완료'≠'리뷰완료'
  const r6 = parseTabRows(v6, 's6', 't6', 'g6', 'C6', KW, map6);
  assert.equal(r6[0].submitCol, '', '★ 재앵커 불일치 → 키워드 폴백 금지');

  // ── 케이스7: col_index 범위밖 → 안전하게 미제출 ──
  const v7 = [
    ['번호', '주문자', '수취인', '연락처', '리뷰제출'],
    ['1', '주문킴', '수취킴', '010-1234-5678', 'O'],
  ];
  const map7 = new Map([['review_submit', { colIndex: 99, header: '리뷰제출' }]]); // 범위밖
  const r7 = parseTabRows(v7, 's7', 't7', 'g7', 'C7', KW, map7);
  assert.equal(r7[0].submitCol, '', '★ 범위밖 colIndex → 키워드 폴백 금지');
  assert.equal(r7[0].isSubmitted, false);

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

  // ════════════ 1단계(컬럼 판정 DB화): meta provenance + drift ════════════

  // ── 케이스10: meta out-param — 필드별 src('db'|'keyword'|'none') + headerRowIdx 보고 ──
  const meta10 = {};
  const r10 = parseTabRows(v5, 's5', 't5', 'g5', 'C5', KW, map5, meta10);
  assert.equal(r10[0].submitCol, '완료', 'meta 전달해도 파싱 결과 불변');
  assert.equal(meta10.headerRowIdx, 0, 'headerRowIdx 보고');
  assert.equal(meta10.fields.review_submit.src, 'db', '★ DB매핑 사용 필드 = src db');
  assert.equal(meta10.fields.review_submit.col, 4);
  assert.equal(meta10.fields.payment.src, 'db');
  assert.equal(meta10.fields.name.src, 'keyword', 'name은 항상 키워드');
  assert.equal(meta10.fields.phone.src, 'keyword', '매핑 없는 필드 = 키워드');
  assert.equal(meta10.fields.round.src, 'none', '미검출 필드 = none');
  assert.equal(meta10.fields.round.col, -1);
  assert.deepEqual(meta10.drift, [], '거부된 매핑 없음 → drift 빈 배열');

  // ── 케이스11: drift 보고 — 재앵커 불일치(reanchor) / 범위밖(range) ──
  const meta11a = {};
  parseTabRows(v6, 's6', 't6', 'g6', 'C6', KW, map6, meta11a);
  assert.equal(meta11a.drift.length, 1, '재앵커 거부 1건');
  assert.deepEqual(meta11a.drift[0], {
    field: 'review_submit', reason: 'reanchor', storedCol: 4, storedHeader: '리뷰완료', currentHeader: '완료',
  }, '★ reanchor drift 상세');
  assert.equal(meta11a.fields.review_submit.src, 'none', '거부 후 제출열 미선택으로 보고');
  const meta11b = {};
  parseTabRows(v7, 's7', 't7', 'g7', 'C7', KW, map7, meta11b);
  assert.equal(meta11b.drift.length, 1, '범위밖 거부 1건');
  assert.equal(meta11b.drift[0].reason, 'range', '★ range drift');

  // ── 케이스12: 무변경 정리(theorem) — 키워드 감지 결과(meta)로 dbColMap을 구성해 재파싱하면
  //    전체 행 출력이 완전 동일(자동기록 매핑 ≡ 키워드 결과 = 숫자 무변경의 수학적 근거) ──
  const RECORDABLE = ['recipient', 'review_submit', 'product', 'phone', 'round', 'payment'];
  for (const vv of [v1, v2, v3, v5]) {
    const metaA = {};
    const base = parseTabRows(vv, 'sx', 'tx', 'gx', 'CX', KW, null, metaA);
    const rebuilt = new Map();
    for (const f of RECORDABLE) {
      const info = metaA.fields[f];
      if (info && info.src === 'keyword' && info.col >= 0) rebuilt.set(f, { colIndex: info.col, header: info.header });
    }
    const metaB = {};
    const replay = parseTabRows(vv, 'sx', 'tx', 'gx', 'CX', KW, rebuilt, metaB);
    assert.deepEqual(replay, base, '★ 기록된 매핑으로 재파싱 = 키워드 파싱과 완전 동일(무변경)');
    for (const [f] of rebuilt) {
      assert.equal(metaB.fields[f].src, 'db', `재파싱 시 ${f}는 db 소스로 보고`);
    }
    assert.deepEqual(metaB.drift, [], '재앵커 전부 통과 → drift 없음');
  }

  console.log('  케이스1~12(+4b/4c/4d 제출열 오탐 회귀가드) 통과 (P2a 슈퍼셋 + P2b DB매핑 우선/재앵커/범위가드/PII가드 + meta/drift/무변경정리)');
}

try { run(); console.log('columnResolver tests passed'); }
catch (e) { console.error(e); process.exit(1); }
