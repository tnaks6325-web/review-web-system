/**
 * orderEditSheetless.test.js — 주문 편집(order-edit)의 무시트 반영 회귀가드 (2026-08-21)
 *
 * 결함(실측): 무시트 탭에서 order-edit 가 order_update 를 큐에 넣으면 큐 실행부의 무시트
 * 백스톱이 그 항목을 "작업표 기록 경로가 담당"이라며 done 으로 삼켰는데, **update 를 담당하는
 * 경로가 없어** 편집이 원장(DB)에만 남고 작업표 row_json·장부(검색·리뷰어 화면)에는 영영
 * 반영되지 않았다(조용한 소실 — 구매일자 교정이 화면에 안 나타나던 실사고).
 *
 * ⚠ 2026-08-21 이관: 이 처리는 라우트에서 **`orderLedger.applyOrderEdit` 단일 출처**로 옮겼다
 *   (작업보드 셀 편집의 원장 되쓰기가 같은 함수를 쓴다 — 두 창구가 갈리면 안 된다).
 *   그래서 ①~③ 은 서비스 본문에서, ④(응답 고지)는 라우트에서 고정한다. 검사 의미는 불변.
 *
 * 고정하는 것:
 *   ① 무시트 판정은 sheetlessScope.isSheetless 단일 출처
 *   ② 무시트 + sheet_row 있으면 writeOrderToWorktable(기존 연결 행 재기록) — manualOrder ④와 같은 실행부
 *   ③ 실패·비무시트는 종전 enqueue 폴백(동작 조용히 악화 금지) — 성공 시에만 큐 생략
 *   ④ 응답이 sheetlessApplied 로 사실을 말한다(조용한 누락 금지)
 *
 * 실행: node tests/orderEditSheetless.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'orderLedger.service.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'diag.routes.js'), 'utf8');

// ★ 함수 본문으로 잘라서 본다(파일 전체 검사는 다른 곳의 유사 문자열이 대신 통과시킨다).
//   ★ 고정 길이로 자르지 않는다 — 함수가 자라면 가드가 조용히 빨개진다(paymentBatch 교훈).
const start = svcSrc.indexOf('async function applyOrderEdit(');
assert.ok(start >= 0, 'applyOrderEdit 존재');
const end = svcSrc.indexOf('\nfunction computeRowWriteSig(', start);
const body = svcSrc.slice(start, end > start ? end : undefined);

// ① 무시트 판정 단일 출처
assert.ok(/require\('\.\.\/utils\/sheetlessScope'\)\.isSheetless\(db, os\.sheet_id, os\.tab_name\)/.test(body),
  '무시트 판정 = sheetlessScope.isSheetless 단일 출처');
// ② 조건이 살아 있고(변이: if(false…) 차단) 기존 연결 행(sheet_row)을 지목해 재기록
assert.ok(body.includes('if (isSl && os.sheet_row) {'),
  '무시트 + sheet_row 조건 분기(정확 문자열 — 조건 무력화 변이 차단)');
assert.ok(/require\('\.\/sheetlessOrder\.service'\)\.writeOrderToWorktable\(\{/.test(body),
  '실행부 = writeOrderToWorktable 한 벌(사본 0)');
assert.ok(/sheetRow: os\.sheet_row/.test(body),
  '기존 연결 행을 지목해 병합(빈 슬롯을 새로 먹지 않는다)');
assert.ok(body.includes('orderData: _osRowToOrderData(full[0])'),
  '재기록 값 = 최신 DB 원장(_osRowToOrderData) — 화면이 보낸 값 불신');
// ③ 성공 시에만 큐 생략, 실패·비무시트는 종전 enqueue 그대로
assert.ok(body.includes('if (!sheetlessApplied || !sheetlessApplied.ok) {'),
  '기록 실패·비무시트 = 종전 enqueue 폴백');
assert.ok(/enqueue\('order_update', \{ orderSubmissionId, editSeq, edits: clean \}\)/.test(body),
  '종전 enqueue 페이로드 불변');
// 예외는 fail-soft 로 폴백(500 금지 — 편집 자체는 이미 DB 확정)
assert.ok(/catch \(e\) \{ sheetlessApplied = \{ ok: false, reason: 'exception', message: e\.message \}; \}/.test(body),
  '작업표 기록 예외 = 폴백(편집 확정을 죽이지 않는다)');

// ④ 라우트 응답 고지 — 라우트가 서비스 결과를 그대로 실어 보낸다
const rStart = routeSrc.indexOf("router.post('/order-edit'");
assert.ok(rStart >= 0, 'order-edit 라우트 존재');
const rEnd = routeSrc.indexOf('router.post(', rStart + 10);
const rBody = routeSrc.slice(rStart, rEnd > rStart ? rEnd : undefined);
assert.ok(/applyOrderEdit\(/.test(rBody), '라우트가 공용 서비스를 호출한다(사본 금지)');
assert.ok(/sheetlessApplied: out\.sheetlessApplied \|\| null/.test(rBody),
  '응답이 sheetlessApplied 로 사실을 말한다');

// 편집 필드 화이트리스트에 date_str 존재(구매일자 교정 경로의 전제) — 값으로 확인(문자열 사본 금지)
const { ORDER_LEDGER_EDIT_FIELDS } = require('../src/services/orderLedger.service');
assert.ok(ORDER_LEDGER_EDIT_FIELDS.includes('date_str'), 'date_str 편집 허용 필드');

console.log('✅ orderEditSheetless: 전부 통과');
