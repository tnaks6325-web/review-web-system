/**
 * searchByName order_submissions 병합(A안) 회귀 테스트
 *   /api/search 제출대기 탭에 '구매양식 반영중' 주문을 즉시 노출하는 병합이:
 *   1) 강한 신원키(phone8) 분기에서만 동작하고 이름 단독 분기에서는 절대 병합 안 하며(보안)
 *   2) includeSubmitted 없으면 병합 안 하고
 *   3) 색인행 뒤에 append 되어 기존 results[0..n-1] 순서를 깨지 않고
 *   4) 이미 색인 반영된 행(seen: sheetId||tabName||sheet_row)은 dedup 되고
 *   5) failed/stuck_manual(확인필요)은 리뷰어에게 미노출(env REVIEW_ORDER_ATTENTION_VISIBLE=1로만 복귀), 그 외는 'processing'(반영중)이며
 *   6) 병합 아이템이 PII 최소(row:{}, isSubmitted:false, isOrderPending:true) 형태인지 고정.
 * 실행: node tests/orderMergeSearch.test.js
 */
const assert = require('assert');

// ── pool 모킹 (search.service 로드 전에 require 캐시 주입) ──
const poolPath = require.resolve('../src/db/pool');
const captured = { queries: [] };
let reviewRows = [];   // 본검색(FROM review_index, 메인) 결과
let seenRows = [];     // dedup seen-set(FROM review_index, row_index IS NOT NULL) 결과
let orderRows = [];    // 병합(FROM order_submissions) 결과

const fakePool = {
  query: async (sql, params) => {
    captured.queries.push({ sql, params });
    if (/FROM reviewers/.test(sql)) return { rows: [] };            // 타계정 없음 → phoneList=[p8]
    if (/set_limit/.test(sql)) return { rows: [] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: '0', built_at: null }] };
    if (/FROM review_submissions/.test(sql)) return { rows: [] };
    if (/FROM order_submissions/.test(sql)) return { rows: orderRows };
    // seen-set 쿼리(dedup): 병합 헬퍼의 review_index 조회는 'row_index IS NOT NULL' 로 구분
    if (/FROM review_index/.test(sql) && /row_index IS NOT NULL/.test(sql)) return { rows: seenRows };
    if (/FROM review_index/.test(sql)) return { rows: reviewRows };
    return { rows: [] };
  },
};
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };

const { searchByName } = require('../src/services/search.service');

function reviewRow(over = {}) {
  return {
    idxName: '홍길동', recipientName: '', campaignName: '캠', tcCampaignName: null,
    tabName: '탭', sheetId: 'S', gid: '1', rowIndex: 2,
    isSubmitted: false, productName: '', productUrl: '', startDate: '7/1', endDate: '',
    round: '', rowJson: '{"연락처":"010-1234-5678"}', submitCol: '리뷰제출', isSubmitted2: null,
    reviewFileAt: null, manager: null, timeRange: null, reviewType: null, taekhap: null,
    isClosed: false, deliveryType: null, isBulk: null, incomeType: null,
    displayName: null, ncMode: null, folderUrl: null, captureFolderUrl: null,
    captureSlots: null, archivedRounds: null, score: 1.0, ...over,
  };
}
function orderRow(over = {}) {
  return {
    id: 'os1', sheetId: 'S', tabName: '탭', gid: '1', sheetRow: 99,
    mirrorStatus: 'queued', recipientName: '수취인갑', displayNameTC: '탭표시명',
    campaignName: '캠', manager: null, reviewType: null, deliveryType: null,
    incomeType: null, isClosed: false, ...over,
  };
}

function orderQueryIssued() {
  return captured.queries.some(x => /FROM order_submissions/.test(x.sql));
}

async function run() {
  // ── 1) 이름+phone8 + includeSubmitted: 색인행 뒤에 order append, shape/stage 고정 ──
  captured.queries = []; reviewRows = [reviewRow()]; seenRows = []; orderRows = [orderRow()];
  const r1 = await searchByName('홍길동', '12345678', { includeSubmitted: true });
  assert.ok(orderQueryIssued(), '1: phone8 분기는 order 병합 쿼리 발행');
  assert.equal(r1.results.length, 2, '1: 색인행 1 + 주문행 1');
  assert.equal(r1.results[0].isOrderPending, undefined, '1: 색인행은 results[0] 유지(prepend 아님)');
  const m1 = r1.results[1];
  assert.equal(m1.isOrderPending, true, '1: 병합행 isOrderPending=true');
  assert.equal(m1.orderStage, 'processing', "1: queued → orderStage='processing'(반영중)");
  assert.equal(m1.isSubmitted, false, '1: 병합행은 제출대기(isSubmitted=false)');
  assert.deepEqual(m1.row, {}, '1: PII 최소 — row 비움');
  assert.equal(m1.displayName, '수취인갑', '1: displayName=수취인(색인행과 동일 축)');
  assert.equal(m1.rowIndex, null, '1: rowIndex=null(goToSubmit 대상 아님)');
  console.log('  1. phone8 분기 append + shape/stage ✓');

  // ── 2) dedup: 이미 색인 반영된 행(seen sheetRow 일치)은 병합 제외 ──
  captured.queries = []; reviewRows = [reviewRow()];
  seenRows = [{ sheetId: 'S', tabName: '탭', rowIndex: 99 }];   // order.sheetRow=99 와 일치
  orderRows = [orderRow({ sheetRow: 99 })];
  const r2 = await searchByName('홍길동', '12345678', { includeSubmitted: true });
  assert.ok(!r2.results.some(x => x.isOrderPending), '2: seen 히트 주문은 dedup(미노출)');
  console.log('  2. dedup(seen 히트) ✓');

  // ── 3) failed/stuck_manual(확인필요)은 리뷰어에게 아예 노출하지 않는다 (사용자 확정 2026-08-19) ──
  //   ★ 완화 금지: 리뷰어가 할 수 있는 조치가 없는 내부 상태라 카드가 뜨면 C/S 문의만 늘어난다.
  //   되돌리기는 코드가 아니라 env REVIEW_ORDER_ATTENTION_VISIBLE=1.
  captured.queries = []; reviewRows = []; seenRows = [];
  orderRows = [orderRow({ mirrorStatus: 'failed' }), orderRow({ id: 'os2', sheetRow: 100, mirrorStatus: 'stuck_manual' })];
  const r3 = await searchByName('홍길동', '12345678', { includeSubmitted: true });
  assert.equal(r3.results.filter(x => x.isOrderPending).length, 0, '3: 확인필요(failed/stuck_manual) 주문은 미노출');
  assert.ok(!r3.results.some(x => x.orderStage === 'attention'), "3: orderStage='attention' 항목 0건");
  // 3b) 정상 주문(반영중)은 그대로 노출 — 확인필요만 걸러내는지(과잉 필터 아님) 확인
  captured.queries = []; reviewRows = []; seenRows = [];
  orderRows = [orderRow({ mirrorStatus: 'failed' }), orderRow({ id: 'os3', sheetRow: 101, mirrorStatus: 'queued' })];
  const r3b = await searchByName('홍길동', '12345678', { includeSubmitted: true });
  const m3b = r3b.results.filter(x => x.isOrderPending);
  assert.equal(m3b.length, 1, '3b: 확인필요만 제외하고 반영중 주문은 유지');
  assert.equal(m3b[0].orderStage, 'processing', '3b: 남은 건은 processing');
  console.log('  3. 확인필요(attention) 미노출 + 반영중은 유지 ✓');

  // ── 4) 이름 단독 분기: includeSubmitted 있어도 절대 병합 안 함(보안) ──
  captured.queries = []; reviewRows = [reviewRow()]; seenRows = []; orderRows = [orderRow()];
  const r4 = await searchByName('홍길동', '', { includeSubmitted: true });
  assert.ok(!orderQueryIssued(), '4: 이름 단독은 order 병합 쿼리 미발행(교차노출 차단)');
  assert.ok(!r4.results.some(x => x.isOrderPending), '4: 이름 단독 결과에 병합행 없음');
  console.log('  4. 이름 단독 — 병합 차단 ✓');

  // ── 5) includeSubmitted 미지정: phone8 있어도 병합 안 함 ──
  captured.queries = []; reviewRows = [reviewRow()]; seenRows = []; orderRows = [orderRow()];
  const r5 = await searchByName('홍길동', '12345678');
  assert.ok(!orderQueryIssued(), '5: includeSubmitted 없으면 병합 미발행');
  assert.ok(!r5.results.some(x => x.isOrderPending), '5: 병합행 없음');
  console.log('  5. includeSubmitted 미지정 — 병합 안 함 ✓');

  // ── 6) phone8 단독 분기도 병합 동작 ──
  captured.queries = []; reviewRows = []; seenRows = []; orderRows = [orderRow()];
  const r6 = await searchByName('', '12345678', { includeSubmitted: true });
  assert.ok(orderQueryIssued(), '6: phone8 단독 분기도 order 병합');
  assert.equal(r6.results.filter(x => x.isOrderPending).length, 1, '6: 주문 1건 병합');
  console.log('  6. phone8 단독 분기 병합 ✓');

  // ── 7) written(시트 반영 완료) → orderStage='reflected'(반영완료) ──
  captured.queries = []; reviewRows = []; seenRows = [];
  orderRows = [orderRow({ mirrorStatus: 'written' })];
  const r7 = await searchByName('홍길동', '12345678', { includeSubmitted: true });
  const m7 = r7.results.find(x => x.isOrderPending);
  assert.ok(m7, '7: written 주문 병합됨');
  assert.equal(m7.orderStage, 'reflected', "7: written → orderStage='reflected'(반영완료)");
  console.log('  7. written → 반영완료(reflected) ✓');

  console.log('✅ orderMergeSearch 테스트 전체 통과');
}

run().catch(err => { console.error('❌ 테스트 실패:', err.message); process.exit(1); });
