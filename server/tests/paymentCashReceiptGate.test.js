'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@127.0.0.1:1/none';
const { filterReceiptEligiblePaymentRows } = require('../src/services/paymentReceiptGate.service');

const rows = [
  { sheetId: 'S', tabName: 'regular', rowIndex: 1 },
  { sheetId: 'S', tabName: 'cash', rowIndex: 2 },
  { sheetId: 'S', tabName: 'cash', rowIndex: 3 },
  { sheetId: 'S', tabName: 'manual', rowIndex: 4 },
  { sheetId: 'S', tabName: 'manual', rowIndex: 5 },
  { sheetId: 'S', tabName: 'campaign', rowIndex: 6 },
  { sheetId: 'S', tabName: 'misconfigured', rowIndex: 7 },
];

const db = {
  async query(sql, params) {
    if (/tc\.capture_slots AS "captureSlots"/.test(sql)) {
      assert.strictEqual(params[0].length, 5, '탭 쌍은 중복 제거해야 한다');
      return { rows: [
        { sheetId: 'S', tabName: 'regular', captureSlots: null, incomeType: '기타' },
        { sheetId: 'S', tabName: 'cash', captureSlots: null, incomeType: '사업자현영' },
        { sheetId: 'S', tabName: 'manual', captureSlots: [
          { key: 'review', label: '리뷰' }, { key: 'slot2', label: '현금영수증' },
        ], incomeType: '기타' },
        { sheetId: 'S', tabName: 'campaign', captureSlots: null, incomeType: '기타' },
        { sheetId: 'S', tabName: 'misconfigured', captureSlots: [
          { key: 'review', label: '리뷰' },
        ], incomeType: '현영' },
      ] };
    }
    if (/picked\.cash_receipt_required/.test(sql)) {
      return { rows: [
        { sheet_id: 'S', tab_name: 'regular', cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'cash', cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'manual', cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'campaign', cash_receipt_required: true },
        { sheet_id: 'S', tab_name: 'misconfigured', cash_receipt_required: false },
      ] };
    }
    if (/FROM review_submissions rs/.test(sql)) {
      assert.deepStrictEqual(params[2], [2, 3, 4, 5, 6], '영수증 대상 행만 원장 대조해야 한다');
      assert.deepStrictEqual(params[3], ['receipt', 'receipt', 'slot2', 'slot2', 'receipt'], '수동 슬롯 key도 보존해야 한다');
      return { rows: [
        { sheetId: 'S', tabName: 'cash', rowIndex: 3 },
        { sheetId: 'S', tabName: 'manual', rowIndex: 4 },
        { sheetId: 'S', tabName: 'campaign', rowIndex: 6 },
      ] };
    }
    throw new Error('unexpected query: ' + sql);
  },
};

(async () => {
  const eligible = await filterReceiptEligiblePaymentRows(db, rows);
  assert.deepStrictEqual(eligible.map(r => r.rowIndex), [1, 3, 4, 6],
    '일반 작업 또는 실제 영수증 제출 행만 입금대상이어야 한다');

  const broken = { query: async sql => {
    if (/tc\.capture_slots/.test(sql)) return { rows: [] };
    throw new Error('cash receipt context unavailable');
  } };
  await assert.rejects(
    () => filterReceiptEligiblePaymentRows(broken, [{ sheetId: 'S', tabName: 'T', rowIndex: 1 }]),
    /context unavailable/,
    '현금영수증 판정 조회 실패 시 입금대상을 추측하면 안 된다'
  );

  const paymentService = fs.readFileSync(path.join(__dirname, '../src/services/payment.service.js'), 'utf8');
  const paymentRoute = fs.readFileSync(path.join(__dirname, '../src/routes/payment.routes.js'), 'utf8');
  assert.match(paymentService, /filterReceiptEligiblePaymentRows\(pool, candidateRows\)/,
    '입금관리 목록이 현금영수증 공용 게이트를 거치지 않는다');
  assert.match(paymentRoute, /filterReceiptEligiblePaymentRows\(pool, rows\)/,
    '기존 입금목록 API가 현금영수증 공용 게이트를 거치지 않는다');
  const createBatch = paymentService.match(/async function createBatch[\s\S]*?\n}/)?.[0] || '';
  assert.match(createBatch, /listPaymentTargets\(\)/,
    '회차 생성 직전에 서버 입금대상을 다시 계산하지 않는다');

  console.log('payment cash receipt gate: 10 passed');
})().catch(err => { console.error(err); process.exit(1); });
