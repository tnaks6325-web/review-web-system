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
      assert.strictEqual(params.length, 4, '입금 게이트는 과거 영수증 분류 확신도를 호환 증거로 받지 않아야 한다');
      assert.match(sql, /ri\.checks->'receiptValidation'->>'verdict' = 'pass'/,
        '신규 영수증은 전용 판정 통과 기록이 있어야 한다');
      assert.match(sql, /ri\.status = 'resolved' AND ri\.resolution = 'ok'/,
        'AI 판정 불가 건은 내부 정상 승인 경로가 있어야 한다');
      assert.doesNotMatch(sql, /ai_confidence|checks->'format'->>'kind' = 'receipt'/,
        '전용 검증 없는 과거 고신뢰 분류가 사업자번호 대조를 우회하면 안 된다');
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
  const trackBRoute = fs.readFileSync(path.join(__dirname, '../src/routes/trackB.routes.js'), 'utf8');
  const searchService = fs.readFileSync(path.join(__dirname, '../src/services/search.service.js'), 'utf8');
  assert.match(paymentService, /filterReceiptEligiblePaymentRows\(pool, pageRows\)/,
    '입금관리 목록이 현금영수증 공용 게이트를 거치지 않는다');
  const paymentList = paymentService.match(/async function listPaymentTargets[\s\S]*?\n}/)?.[0] || '';
  assert.match(paymentList, /while \(rows\.length < resultLimit\)[\s\S]*filterReceiptEligiblePaymentRows\(pool, pageRows\)[\s\S]*rows\.push/,
    '현금영수증 게이트를 페이지 LIMIT 뒤 한 번만 적용하면 뒤쪽 정상 지급 대상이 막힌다');
  assert.match(paymentList, /LIMIT \$\$\{limitParam\} OFFSET \$\$\{offsetParam\}/,
    '입금 후보는 지급 가능 2,000건을 채울 때까지 페이지 이동해야 한다');
  assert.match(paymentRoute, /filterReceiptEligiblePaymentRows\(pool, rows\)/,
    '기존 입금목록 API가 현금영수증 공용 게이트를 거치지 않는다');
  const markDone = paymentRoute.match(/router\.post\('\/mark-done'[\s\S]*?\n}\);/)?.[0] || '';
  assert.match(markDone, /BEGIN[\s\S]*filterReceiptEligiblePaymentRows\(client, items, \{ lock: true \}\)[\s\S]*CASH_RECEIPT_NOT_VERIFIED[\s\S]*recordDeposits\(client, receiptEligibleItems/,
    '입금 완료 API는 같은 transaction 안에서 현금영수증 근거를 잠그고 다시 검증해야 한다');
  const receiptGate = fs.readFileSync(path.join(__dirname, '../src/services/paymentReceiptGate.service.js'), 'utf8');
  assert.match(receiptGate, /if \(lock\)[\s\S]*FOR UPDATE OF rs[\s\S]*FROM review_inspections[\s\S]*FOR UPDATE/,
    '영수증 제출·검수 행 잠금 없이 검증 후 반려·교체가 끼어들 수 있다');
  const createBatch = paymentService.match(/async function createBatch[\s\S]*?\n}/)?.[0] || '';
  assert.match(createBatch, /listPaymentTargets\(\)/,
    '회차 생성 직전에 서버 입금대상을 다시 계산하지 않는다');
  assert.match(trackBRoute, /BEGIN[\s\S]*getBatch\(req\.params\.id, \{ db: client, lock: true \}\)[\s\S]*downloadCount \|\| 0\) === 0[\s\S]*checkBatchReceiptEligibility\(out, \{ db: client, lock: true \}\)[\s\S]*cash_receipt_not_verified[\s\S]*buildWorkbook[\s\S]*markDownloaded\(out\.batch\.id, _by\(req\), \{ db: client \}\)[\s\S]*COMMIT/,
    '최초 이체파일 다운로드 직전에 현금영수증 현재 상태를 다시 검증해야 한다');
  assert.match(searchService, /cashReceiptSubmissionStates\(pool, source\)[\s\S]*item\.submittedSlots = \(item\.submittedSlots \|\| \[\]\)\.filter/,
    '거절·보류된 영수증은 파일이 남아 있어도 리뷰어 재제출 슬롯을 다시 열어야 한다');

  const inspectService = fs.readFileSync(path.join(__dirname, '../src/services/reviewInspect.service.js'), 'utf8');
  const uploadRoute = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
  const reviewEditRoute = fs.readFileSync(path.join(__dirname, '../src/routes/reviewEdit.routes.js'), 'utf8');
  assert.match(inspectService, /const businessNoMatched =[\s\S]*receiptVerdict\?\.status === 'ok' && businessNoMatched[\s\S]*businessNoMatched: true[\s\S]*business_number_unverified/,
    '사업자번호를 읽어 회사 번호와 대조한 영수증만 지급 검수 통과여야 한다');
  assert.match(inspectService, /checks\.receiptValidation = receiptVerdict\?\.status === 'ok' && businessNoMatched[\s\S]*verdict: 'pass'[\s\S]*verdict: 'fail'[\s\S]*verdict: 'warn'/,
    '영수증 판정 통과/불일치/판정불가가 검수 원장에 분리 기록돼야 한다');
  assert.match(inspectService, /\(!ENABLED && requestedSlotRole !== 'receipt'\)/,
    '일반 리뷰검수를 꺼도 현금영수증 지급 판정 원장은 기록해야 한다');
  assert.match(inspectService, /const receiptOnly = !ENABLED[\s\S]*_receiptSweepTargets\(cap\)[\s\S]*receiptOnly \|\| isCashReceiptSlot/,
    '일반 리뷰검수가 꺼져도 영수증 pending·미검수 건은 재시도해야 한다');
  assert.match(inspectService, /for \(const t of targets\) \{[\s\S]{0,500}const slotRole =[\s\S]{0,500}try \{[\s\S]*slotRole === 'receipt'/,
    '다운로드 전에 역할을 계산해 실패 catch도 영수증 pending 증거를 남겨야 한다');
  assert.match(inspectService, /_receiptSweepTargets[\s\S]*receiptValidation[\s\S]*slot_key IN \('receipt', 'cash_receipt'\)[\s\S]*현금영수증\|현영\|지출증빙/,
    '자동 receipt 키와 수동 slot2 라벨 영수증을 모두 재시도 대상으로 잡아야 한다');
  assert.match(inspectService, /const slotRole = receiptOnly \|\| isCashReceiptSlot\([\s\S]*t\.capture_slots, t\.income_type, t\.slot_key[\s\S]*slotRole,/,
    '수동 slot2 현금영수증도 재검수 때 receipt 역할을 유지해야 한다');
  assert.match(uploadRoute, /const captureVerdictsByFileId = new Map\(\)[\s\S]*captureVerdictsByFileId\.set\(uploaded\.id, verdict\)[\s\S]*captureVerdict: _finalSlotRole === _slotRole \? \(captureVerdictsByFileId\.get\(r\.fileId\) \|\| null\) : null/,
    '업로드 판정은 같은 최종 슬롯일 때만 영수증 검수 증거로 재사용해야 한다');
  assert.match(reviewEditRoute, /INSERT INTO review_inspections[\s\S]*approved_file_replacement[\s\S]*isCashReceiptSlot\([\s\S]*inspect\.inspectSubmission\([\s\S]*slotRole: 'receipt'/,
    '관리자가 승인한 영수증 교체본은 pending 원장을 만든 뒤 즉시 receipt 재검수해야 한다');

  process.env.REVIEW_INSPECT = '1';
  const inspect = require('../src/services/reviewInspect.service');
  inspect.__setPoolForTest({
    query: async sql => {
      if (/company_business_no/.test(sql)) return { rows: [{ value: '123-45-67890' }] };
      if (/INSERT INTO review_inspections/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error('unexpected inspection query: ' + sql);
    },
  });
  const inspectReceipt = (status, businessNo = '1234567890') => inspect.inspectSubmission({
    fileId: `receipt-${status}-${businessNo || 'empty'}`, sheetId: 'S', tabName: 'cash', rowIndex: 9,
    slotKey: 'receipt', slotRole: 'receipt',
    captureVerdict: { status, expected: 'receipt', got: status === 'ok' ? 'receipt' : 'review', confidence: 0.96, businessNo },
  });
  assert.strictEqual((await inspectReceipt('ok')).status, 'pass', '영수증 판정 통과는 지급 검수 통과');
  assert.strictEqual((await inspectReceipt('ok', '')).status, 'suspect', '사업자번호를 못 읽은 영수증은 내부 확인 전 지급 보류');
  assert.strictEqual((await inspectReceipt('ok', '999-88-77777')).status, 'suspect', '회사 번호와 다른 영수증은 내부 확인 전 지급 보류');
  assert.strictEqual((await inspectReceipt('mismatch')).status, 'fail', '영수증 판정 불일치는 지급 검수 실패');
  assert.strictEqual((await inspectReceipt('skipped')).status, 'suspect', '판정 불가는 내부 확인 전 지급 보류');
  inspect.__setPoolForTest(null);

  console.log('payment cash receipt gate: 26 passed');
})().catch(err => { console.error(err); process.exit(1); });
