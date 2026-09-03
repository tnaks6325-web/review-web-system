'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildV2StatusBindings, validateV2StatusBindings, isV2ReviewSubmitted, isV2PaymentSubmitted, loadV2StatusBindings } = require('../src/services/statusColumnBinding.service');
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

test('v2 상태열은 정확한 단일 헤더가 이동한 경우에만 좌표를 자동 재동기화한다', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/^SELECT role/.test(sql.trim())) {
      return { rows: [
        { role: 'review_submit', header_text: '리뷰', col_index: 2 },
        { role: 'payment_status', header_text: '입금일', col_index: 3 },
      ] };
    }
    return { rows: [] };
  }};
  const bindings = await loadV2StatusBindings(db, {
    sheetId: 's', tabGid: '1', headers: ['번호', '주문자', '신규열', '리뷰', '입금일'],
  });
  assert.deepEqual(bindings, {
    review_submit: { header: '리뷰', colIndex: 3 },
    payment_status: { header: '입금일', colIndex: 4 },
  });
  assert.ok(calls.some(c => /SET col_index = col_index \+ 1000000/.test(c.sql)));
  assert.equal(calls.filter(c => /ON CONFLICT \(sheet_id, tab_gid, role\) DO UPDATE/.test(c.sql)).length, 2);
});

test('v2 상태열 dry-run 검증은 바인딩을 수정하지 않는다', async () => {
  const calls = [];
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [
      { role: 'review_submit', header_text: '리뷰', col_index: 2 },
      { role: 'payment_status', header_text: '입금일', col_index: 3 },
    ] };
  }};
  await assert.rejects(
    loadV2StatusBindings(db, {
      sheetId: 's', tabGid: '1', headers: ['번호', '주문자', '신규열', '리뷰', '입금일'], allowRebind: false,
    }),
    error => error.code === 'v2_status_binding_drift'
  );
  assert.equal(calls.length, 1);
});

test('v2 상태열 자동 재동기화는 중복 상태 헤더를 허용하지 않는다', async () => {
  const db = { query: async () => ({ rows: [
    { role: 'review_submit', header_text: '리뷰', col_index: 1 },
    { role: 'payment_status', header_text: '입금일', col_index: 2 },
  ] }) };
  await assert.rejects(
    loadV2StatusBindings(db, { sheetId: 's', tabGid: '1', headers: ['리뷰', '리뷰', '입금일'] }),
    error => error.code === 'v2_status_binding_missing'
  );
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
