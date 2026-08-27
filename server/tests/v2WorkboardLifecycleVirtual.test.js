'use strict';

// 신규 V2 작업의 시스템 간 가상 전 사이클 검증.
// 외부 API, 실제 리뷰어 계정, 운영 DB를 사용하지 않고 인트라넷 전송 계약부터
// 작업표 생성, 리뷰 상태, 입금 원장까지의 안전 불변식을 같은 시나리오로 확인한다.

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReviewOrderSourceContract } = require('../src/services/reviewOrderSourceContract.service');
const { buildWorktablePlan } = require('../src/utils/worktablePlan');
const { planToSheetValues } = require('../src/services/worktableCreate.service');
const { buildV2StatusBindings } = require('../src/services/statusColumnBinding.service');
const { parseTabRows } = require('../src/services/columnResolver');
const { recordDeposits } = require('../src/services/paymentApply.service');

const keywords = {
  NAME_KEYWORDS: ['주문자', '수취인', '이름'],
  SUBMIT_KEYWORDS: ['리뷰', '제출'],
  DATA_TAB_KEYWORDS: ['주문자', '수취인', '번호'],
  SUBMITTED_VALUES: ['O', '제출'],
};

const template = {
  core: ['번호', '구매일자', '수취인', '연락처', '주소', '주문번호', '비고'],
  channels: {},
  workTypes: [],
};

test('V2 신규 작업: 전송 → 작업표 → 리뷰 제출 → 입금 처리 가상 전 사이클', async () => {
  // 1. 인트라넷 발신 계약: 재시도 식별자, 작업 계열·차수가 모두 있어야 V2로 수신된다.
  const source = normalizeReviewOrderSourceContract({
    source_review_order_id: 'review-order-virtual-1', source_revision: 1,
    workboard_schema_version: 2, work_series_id: 'series-virtual-1', work_round: 2,
    idempotency_key: 'review-order-virtual-1:r1',
    intranet_advertiser_id: 'advertiser-1', intranet_advertiser_name: '가상 광고주',
  });
  assert.equal(source.workboardSchemaVersion, 2);
  assert.equal(source.workRound, 2);

  // 2. 리뷰웹 작업표 생성: 상품·2단계 옵션·택배발송대행·포토리뷰가 각 전용 열로 생성된다.
  const workOrder = {
    workboard_schema_version: source.workboardSchemaVersion,
    work_series_id: source.workSeriesId, work_round: source.workRound,
    recruit_count: 1, daily_count: 1, start_date: '2026-08-27',
    review_type: 'photo', review_type_mix: [], delivery_type: '택배발송대행', courier_proxy: true,
    product_options_json: JSON.stringify([{
      name: '티셔츠', product_mode: 'opt',
      options: [{ option_1: { name: '컬러', value: '화이트' }, option_2: { name: '사이즈', value: '105' }, count: 1 }],
    }]),
  };
  const plan = buildWorktablePlan({ workOrder, template });
  assert.equal(plan.canCreate, true);
  const values = planToSheetValues(plan);
  const headers = values.header;
  assert.deepEqual(headers, [
    '차수', '번호', '구매일자', '상품', '1차옵션', '2차옵션', '리뷰옵션',
    '수취인', '연락처', '주소', '주문번호', '리뷰', '입금일', '비고', '송장번호',
  ]);
  assert.equal(values.body[0][headers.indexOf('차수')], '2차');
  assert.equal(values.body[0][headers.indexOf('상품')], '티셔츠');
  assert.equal(values.body[0][headers.indexOf('1차옵션')], '화이트');
  assert.equal(values.body[0][headers.indexOf('2차옵션')], '105');
  assert.equal(values.body[0][headers.indexOf('리뷰옵션')], '포토');

  // 배정 뒤 주문자가 채운 주문정보를 재현한다. V2 표의 상태열은 이 값과 독립이다.
  const orderedRow = [...values.body[0]];
  orderedRow[headers.indexOf('수취인')] = '가상 리뷰어';
  orderedRow[headers.indexOf('연락처')] = '010-0000-0000';

  // 3. 최초 리뷰어 화면 판정: 리뷰옵션의 포토는 절대로 리뷰 제출이 아니다.
  const bindings = buildV2StatusBindings(headers);
  const initial = parseTabRows([headers, orderedRow], 'sheet-v', '가상탭', '1', 'campaign-v', keywords, null, null, bindings)[0];
  assert.equal(initial.isSubmitted, false);
  assert.equal(initial.isSubmitted2, 'NONE');

  // 4. 실제 제출 이벤트가 바인딩된 '리뷰' 열에만 기록되면 그때에만 완료로 바뀐다.
  const submittedRow = [...orderedRow];
  submittedRow[bindings.review_submit.colIndex] = '제출';
  const submitted = parseTabRows([headers, submittedRow], 'sheet-v', '가상탭', '1', 'campaign-v', keywords, null, null, bindings)[0];
  assert.equal(submitted.isSubmitted, true);
  assert.equal(submitted.isSubmitted2, 'NONE');

  // 5. 제출 확인 뒤에만 입금 원장 기록을 허용한다. 이 메모리 DB는 호출 순서와 SQL 부작용만 재현한다.
  const writes = [];
  const client = { query: async (sql) => {
    writes.push(sql);
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{ schema_version: 2, is_submitted: true }] };
    if (/UPDATE review_index/.test(sql)) return { rowCount: 1, rows: [] };
    if (/INSERT INTO payment_records/.test(sql)) return { rowCount: 1, rows: [] };
    throw new Error('예상하지 못한 DB 호출');
  }};
  assert.equal(await recordDeposits(client, [{
    sheetId: 'sheet-v', tabName: '가상탭', rowIndex: 2, reviewerName: '가상 리뷰어', amount: 18000,
  }]), 1);
  assert.equal(writes.length, 3);

  // 6. 작업표의 '입금일'에는 지정 형식의 실제 시각만 기록되며, 화면은 PAID로 읽는다.
  const paidRow = [...submittedRow];
  paidRow[bindings.payment_status.colIndex] = '8/27 16:40';
  const paid = parseTabRows([headers, paidRow], 'sheet-v', '가상탭', '1', 'campaign-v', keywords, null, null, bindings)[0];
  assert.equal(paid.isSubmitted, true);
  assert.equal(paid.isSubmitted2, 'PAID');
});
