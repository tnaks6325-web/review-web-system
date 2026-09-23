'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildV2StatusBindings, validateV2StatusBindings, isV2ReviewSubmitted, isV2PaymentSubmitted } = require('../src/services/statusColumnBinding.service');
const { parseTabRows } = require('../src/services/columnResolver');
const { recordDeposits } = require('../src/services/paymentApply.service');

const kw = {
  NAME_KEYWORDS: ['주문자', '이름'], SUBMIT_KEYWORDS: ['리뷰', '제출'],
  DATA_TAB_KEYWORDS: ['주문자', '번호'], SUBMITTED_VALUES: ['O', '제출'],
};

test('v2 상태열은 정확한 헤더·위치만 바인딩한다', () => {
  const headers = ['번호', '주문자', '리뷰옵션', '리뷰', '입금일'];
  const bindings = buildV2StatusBindings(headers);
  assert.deepEqual(bindings.review_submit, { header: '리뷰', colIndex: 3 });
  assert.throws(() => validateV2StatusBindings(['번호', '주문자', '리뷰', '리뷰옵션', '입금일'], bindings),
    /변경되어 처리를 중단/);
});

test('v2는 리뷰옵션·임의 입금 텍스트를 상태로 인정하지 않는다', () => {
  const values = [
    ['번호', '주문자', '리뷰옵션', '리뷰', '입금일'],
    ['1', '서규리', '포토', '', '입금완료'],
    ['2', '홍길동', '텍스트', '제출', '8/27 13:45'],
  ];
  const rows = parseTabRows(values, 's', 't', '1', 'c', kw, null, null, buildV2StatusBindings(values[0]));
  assert.equal(rows[0].isSubmitted, false);
  assert.equal(rows[0].isSubmitted2, 'NONE');
  assert.equal(rows[1].isSubmitted, true);
  assert.equal(rows[1].isSubmitted2, 'PAID');
  assert.equal(isV2ReviewSubmitted('포토'), false);
  assert.equal(isV2PaymentSubmitted('입금완료'), false);
});

test('v2는 리뷰 제출 전 입금 원장 기록도 막는다', async () => {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (/FROM tab_configs tc/.test(sql)) return { rows: [{ schema_version: 2, is_submitted: false }] };
    throw new Error('입금 update가 호출되면 안 됩니다.');
  }};
  await assert.rejects(
    recordDeposits(client, [{ sheetId: 's', tabName: 't', rowIndex: 2 }]),
    error => error.code === 'payment_before_review'
  );
  assert.equal(queries.length, 1);
});
