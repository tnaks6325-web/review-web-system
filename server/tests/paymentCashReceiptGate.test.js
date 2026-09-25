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
  { sheetId: 'S', tabName: 'campaign', rowNum: '008' },
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
    if (/provenance AS/.test(sql)) {
      assert.deepStrictEqual(params[2], [1, 2, 3, 4, 5, 6, 7, 8], '공고 현영 설정은 rowNum을 포함한 지급 행 좌표로 조회해야 한다');
      return { rows: [
        { sheet_id: 'S', tab_name: 'regular', row_index: 1, cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'cash', row_index: 2, cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'cash', row_index: 3, cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'manual', row_index: 4, cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'manual', row_index: 5, cash_receipt_required: null },
        { sheet_id: 'S', tab_name: 'campaign', row_index: 6, cash_receipt_required: true },
        { sheet_id: 'S', tab_name: 'misconfigured', row_index: 7, cash_receipt_required: false },
        { sheet_id: 'S', tab_name: 'campaign', row_index: 8, cash_receipt_required: true },
      ] };
    }
    if (/FROM review_submissions rs/.test(sql)) {
      assert.deepStrictEqual(params[2], [2, 3, 4, 5, 6, 8], 'rowNum을 정규화한 영수증 대상 행만 원장 대조해야 한다');
      assert.deepStrictEqual(params[3], ['receipt', 'receipt', 'slot2', 'slot2', 'receipt', 'receipt'], '수동 슬롯 key도 보존해야 한다');
      assert.strictEqual(params.length, 4, '입금 게이트는 과거 영수증 분류 확신도를 호환 증거로 받지 않아야 한다');
      assert.match(sql, /ri\.checks->'receiptValidation'->>'verdict' = 'pass'/,
        '신규 영수증은 전용 판정 통과 기록이 있어야 한다');
      assert.match(sql, /ri\.status = 'resolved' AND ri\.resolution = 'ok'[\s\S]*ri\.checks[\s\S]*receiptValidation/,
        '내부 정상 승인은 영수증 전용 검증 키가 있는 건만 허용해야 한다');
      assert.match(sql, /rs\.slot_key = r\.receipt_key OR \([\s\S]*EXISTS \([\s\S]*role_ri\.checks[\s\S]*receiptValidation/,
        '슬롯 key가 바뀐 과거 제출도 영수증 전용 검증 증거로 역할을 보존해야 한다');
      assert.match(sql, /COALESCE\(rs\.slot_key, 'review'\) NOT IN \('review', 'order_capture', 'confirm', 'trashed'\)/,
        '리뷰·구매캡처로 명시 이동된 파일은 과거 영수증 증거가 남아도 지급 대상이 아니어야 한다');
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
    '일반 작업 또는 실제 영수증 제출 행만 입금대상이어야 하고 미제출 legacy rowNum은 제외해야 한다');

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
  assert.match(receiptGate, /rowIndex: Number\(row\?\.rowIndex \?\? row\?\.rowNum\)[\s\S]*rowKey\(row\.sheetId, row\.tabName, Number\(row\?\.rowIndex \?\? row\?\.rowNum\)\)/,
    '구형 rowNum과 숫자 문자열은 입금 검증 전 같은 rowIndex로 정규화해야 한다');
  assert.match(receiptGate, /if \(lock\)[\s\S]*FOR UPDATE OF rs[\s\S]*FROM review_inspections[\s\S]*FOR UPDATE/,
    '영수증 제출·검수 행 잠금 없이 검증 후 반려·교체가 끼어들 수 있다');
  assert.match(receiptGate, /if \(lock\)[\s\S]*JOIN tab_configs tc[\s\S]*FOR UPDATE OF tc[\s\S]*JOIN order_submissions os[\s\S]*FOR UPDATE OF os[\s\S]*JOIN campaign_participants cp[\s\S]*FOR UPDATE OF cp[\s\S]*FROM campaign_applications ca[\s\S]*FOR UPDATE OF ca[\s\S]*FROM recruit_campaigns rc[\s\S]*exact_campaigns[\s\S]*FOR UPDATE OF rc/,
    '지급 검증 중 탭 설정과 행 출처 원장·현재/과거 공고 설정을 같은 transaction에서 잠가야 한다');
  assert.match(paymentRoute, /BEGIN ISOLATION LEVEL SERIALIZABLE[\s\S]*filterReceiptEligiblePaymentRows\(client, items, \{ lock: true \}\)/,
    '직접 입금 처리는 설정 신규 삽입·연결 변경 phantom도 충돌로 중단해야 한다');
  const createBatch = paymentService.match(/async function createBatch[\s\S]*?\n}/)?.[0] || '';
  assert.match(createBatch, /listPaymentTargets\(\)/,
    '회차 생성 직전에 서버 입금대상을 다시 계산하지 않는다');
  assert.match(trackBRoute, /BEGIN ISOLATION LEVEL SERIALIZABLE[\s\S]*getBatch\(req\.params\.id, \{ db: client, lock: true \}\)[\s\S]*downloadCount \|\| 0\) === 0[\s\S]*checkBatchReceiptEligibility\(out, \{ db: client, lock: true \}\)[\s\S]*cash_receipt_not_verified[\s\S]*buildWorkbook[\s\S]*markDownloaded\(out\.batch\.id, _by\(req\), \{ db: client \}\)[\s\S]*COMMIT/,
    '최초 이체파일 다운로드 직전에 현금영수증 현재 상태를 다시 검증해야 한다');
  assert.match(searchService, /cashReceiptSubmissionStates\(pool, source\)[\s\S]*state && state\.submitted[\s\S]*submittedSlots = \[\.\.\.\(item\.submittedSlots \|\| \[\]\), receipt\.key\][\s\S]*item\.submittedSlots = \(item\.submittedSlots \|\| \[\]\)\.filter/,
    '검증된 과거 key는 현재 영수증 슬롯으로 복원하고, 거절·보류된 파일은 재제출 슬롯을 다시 열어야 한다');
  assert.match(searchService, /cashReceiptRequirementsForRows\([\s\S]*rowIndex: r\.rowIndex[\s\S]*cashReceiptSubmissionRowKey\(row\.sheetId, row\.tabName, row\.rowIndex\)/,
    '재공고 탭의 리뷰어 슬롯도 행 출처 공고의 현영 설정을 따라야 한다');

  const inspectService = fs.readFileSync(path.join(__dirname, '../src/services/reviewInspect.service.js'), 'utf8');
  const fileRouteService = fs.readFileSync(path.join(__dirname, '../src/services/fileRoute.service.js'), 'utf8');
  const uploadRoute = fs.readFileSync(path.join(__dirname, '../src/routes/diag.routes.js'), 'utf8');
  const driveRoute = fs.readFileSync(path.join(__dirname, '../src/routes/drive.routes.js'), 'utf8');
  const reviewEditRoute = fs.readFileSync(path.join(__dirname, '../src/routes/reviewEdit.routes.js'), 'utf8');
  assert.match(inspectService, /const businessNoMatched =[\s\S]*receiptVerdict\?\.status === 'ok' && businessNoMatched[\s\S]*businessNoMatched: true[\s\S]*business_number_unverified/,
    '사업자번호를 읽어 회사 번호와 대조한 영수증만 지급 검수 통과여야 한다');
  assert.match(inspectService, /checks\.receiptValidation = receiptVerdict\?\.status === 'ok' && businessNoMatched[\s\S]*verdict: 'pass'[\s\S]*verdict: 'fail'[\s\S]*verdict: 'warn'/,
    '영수증 판정 통과/불일치/판정불가가 검수 원장에 분리 기록돼야 한다');
  assert.match(inspectService, /\(!ENABLED && requestedSlotRole !== 'receipt'\)/,
    '일반 리뷰검수를 꺼도 현금영수증 지급 판정 원장은 기록해야 한다');
  assert.match(inspectService, /const receiptOnly = !ENABLED[\s\S]*_receiptSweepTargets\(cap\)[\s\S]*receiptOnly \|\| t\.receipt_evidence === true \|\| isCashReceiptSlot/,
    '일반 리뷰검수가 꺼져도 영수증 pending·미검수 건은 재시도해야 한다');
  assert.match(inspectService, /for \(const t of targets\) \{[\s\S]{0,500}const slotRole =[\s\S]{0,500}try \{[\s\S]*slotRole === 'receipt'/,
    '다운로드 전에 역할을 계산해 실패 catch도 영수증 pending 증거를 남겨야 한다');
  assert.match(inspectService, /_receiptSweepTargets[\s\S]*receiptValidation[\s\S]*slot_key IN \('receipt', 'cash_receipt'\)[\s\S]*현금영수증\|현영\|지출증빙/,
    '자동 receipt 키와 수동 slot2 라벨 영수증을 모두 재시도 대상으로 잡아야 한다');
  assert.match(inspectService, /const slotRole = receiptOnly \|\| t\.receipt_evidence === true \|\| isCashReceiptSlot\([\s\S]*t\.capture_slots, t\.income_type, t\.slot_key[\s\S]*slotRole,/,
    '수동 slot2 현금영수증도 재검수 때 receipt 역할을 유지해야 한다');
  /* ★ 순서로 묶지 않는다 — 2차 검수가 공용 함수로 추출되면서 `captureVerdict:` 가
     Map 선언보다 **앞**에 오게 됐다(검사 의미는 불변: 세 조각이 모두 있어야 한다). */
  for (const [re_, why] of [
    [/const captureVerdictsByFileId = new Map\(\)/, '업로드 판정을 파일ID 로 보관한다'],
    [/captureVerdictsByFileId\.set\(uploaded\.id, verdict\)/, '업로드 직후 그 판정을 넣는다'],
    [/captureVerdict: _finalSlotRole === _slotRole \? \(captureVerdictsByFileId\.get\(r\.fileId\) \|\| null\) : null/,
     '★ 같은 최종 슬롯일 때만 영수증 검수 증거로 재사용한다'],
  ]) assert.match(uploadRoute, re_, why);
  assert.match(reviewEditRoute, /INSERT INTO review_inspections[\s\S]*approved_file_replacement[\s\S]*isCashReceiptSlot\([\s\S]*inspect\.inspectSubmission\([\s\S]*slotRole: 'receipt'/,
    '관리자가 승인한 영수증 교체본은 pending 원장을 만든 뒤 즉시 receipt 재검수해야 한다');
  assert.match(reviewEditRoute, /isCashReceiptSlot\(cfg\.capture_slots, cfg\.income_type, slot, rt, cr === true\)[\s\S]{0,500}resolveTargetFolder\(\{[\s\S]{0,200}target: 'receipt'[\s\S]{0,300}if \(!targetFolderId\) throw new Error/,
    '영수증 교체본은 공개 리뷰 폴더로 폴백하지 않고 비공개 영수증 경로만 사용해야 한다');
  assert.match(reviewEditRoute, /const targetFolderId = \(await _resolveFolders\([\s\S]{0,180}r0\.slot_key \|\| 'review'[\s\S]{0,100}\)\.targetFolderId/,
    '승인 시 요청에 저장된 과거 폴더가 아니라 현재 슬롯 역할로 대상 폴더를 다시 계산해야 한다');
  assert.match(driveRoute, /PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL = `[\s\S]*receiptValidation[\s\S]*ri\.status[\s\S]*'resolved'[\s\S]*ri\.resolution[\s\S]*'ok'/,
    '직원이 정상 승인한 리뷰 슬롯의 AI 영수증 오판은 공개 리포트에서 복구해야 한다');
  assert.strictEqual((driveRoute.match(/\$\{PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL\}/g) || []).length, 2,
    '제출 원장과 review_index 폴백 공개 리포트가 같은 승인 예외를 써야 한다');
  assert.match(trackBRoute, /target === 'receipt'[\s\S]*reinspectReceiptFile\(\{ fileId \}\)[\s\S]*else \{[\s\S]*resolveInspection/,
    '수동 현영 이동은 일반 정상 종결 대신 영수증 전용 재검수를 거쳐야 한다');
  assert.match(inspectService, /async function reinspectReceiptFile[\s\S]*status = 'pending'[\s\S]*resolution = NULL[\s\S]*slotRole: 'receipt'/,
    '수동 현영 재검수는 기존 정상 승인을 먼저 무효화하고 실패 시 pending을 남겨야 한다');
  assert.match(fileRouteService, /WITH moved AS \([\s\S]*UPDATE review_submissions[\s\S]*INSERT INTO review_inspections[\s\S]*resolution = NULL/,
    '수동 현영 슬롯 이동과 기존 정상 승인 무효화 사이에 입금 요청이 끼어들 수 없어야 한다');
  assert.match(fileRouteService, /if \(!receipt\)[\s\S]*WITH moved AS \([\s\S]*UPDATE review_submissions[\s\S]*checks = COALESCE\(i\.checks, '\{\}'::jsonb\) - 'receiptValidation'[\s\S]*resolution = NULL/,
    '영수증을 리뷰·구매캡처로 옮기는 순간 지급 승인 증거를 원자적으로 제거해야 한다');
  assert.match(fileRouteService, /backTarget === 'receipt'[\s\S]*else \{[\s\S]*WITH restored AS \([\s\S]*checks = COALESCE\(i\.checks, '\{\}'::jsonb\) - 'receiptValidation'/,
    '자동 이동을 리뷰 칸으로 되돌릴 때도 영수증 승인 증거를 제거해야 한다');
  assert.match(fileRouteService, /target === 'receipt'[\s\S]{0,700}ensureReceiptFolderPath\(rootFolderId, sheetId, tabName, receiptLabel\)/,
    '현금영수증은 업체에 노출되는 리뷰·구매캡처 트리 밖의 내부 전용 경로에 보관해야 한다');
  assert.match(driveRoute.replace(/\r/g, ''), /router\.get\('\/report\/:code'[\s\S]*FROM review_index r[\s\S]*FROM review_submissions rs_role[\s\S]*COALESCE\(rs_role\.slot_key, 'review'\) <> 'review'/,
    '공개 리포트 대표파일 폴백도 비리뷰 슬롯에 연결된 파일을 제외해야 한다');
  assert.match(uploadRoute, /if \(_isReceiptUpload\)[\s\S]{0,700}target: 'receipt'[\s\S]{0,700}공개 리뷰 폴더 업로드 차단/,
    '비공개 영수증 폴더를 확보하지 못하면 업로드를 차단해야 한다');
  assert.match(inspectService, /receipt_evidence[\s\S]*t\.receipt_evidence === true \|\| isCashReceiptSlot/,
    '재검수는 예전 슬롯 key가 사라져도 receiptValidation 역할 증거를 보존해야 한다');

  process.env.REVIEW_INSPECT = '1';
  const drivePath = require.resolve('../src/services/drive.service');
  require.cache[drivePath] = {
    id: drivePath, filename: drivePath, loaded: true,
    exports: { downloadFile: async () => { throw new Error('virtual drive outage'); } },
  };
  const inspect = require('../src/services/reviewInspect.service');
  let pendingWrite = null;
  inspect.__setPoolForTest({
    query: async (sql, params) => {
      if (/company_business_no/.test(sql)) return { rows: [{ value: '123-45-67890' }] };
      if (/FROM review_submissions WHERE file_id/.test(sql)) return { rows: [{
        file_id: params[0], file_hash: null, sheet_id: 'S', tab_name: 'cash', row_index: 9,
        reviewer_name: '가상리뷰어', slot_key: 'receipt',
      }] };
      if (/INSERT INTO review_inspections/.test(sql)) {
        if (/resolution = NULL/.test(sql)) pendingWrite = { sql, params };
        return { rows: [], rowCount: 1 };
      }
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
  const pending = await inspect.reinspectReceiptFile({ fileId: 'manual-route-receipt' });
  assert.strictEqual(pending.pending, true, 'Drive 재검수 실패는 입금 가능 상태가 아니라 재시도 대기여야 한다');
  assert.ok(pendingWrite && /status = 'pending'/.test(pendingWrite.sql) && /resolution = NULL/.test(pendingWrite.sql),
    '파일 다운로드보다 먼저 기존 정상 승인을 지우고 pending 원장을 저장해야 한다');
  inspect.__setPoolForTest(null);

  console.log('payment cash receipt gate: 28 passed');
})().catch(err => { console.error(err); process.exit(1); });
