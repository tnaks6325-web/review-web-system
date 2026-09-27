/**
 * worktableCreate.service.js — 작업표 계획 → 시트 모양 값 변환(planToSheetValues)
 *
 * 종전 M2b-1 「시트 탭 만들기」(createWorktable)·「시트 탭 삭제」(deleteWorktableTab)는
 * 2026-09-28 제거됐다(결정 186 10번 — 화면 버튼은 2026-08-10 탈시트 때 제거, 9월 호출 0).
 * 남은 소비처 = 무시트 접수(`sheetlessAccept`)가 작업표 줄을 만들 때 쓰는 이 변환 하나다.
 * ★ 열 역할 판정은 `plan.columns[i].role` 단일 출처 — 여기서 키워드 규칙을 다시 만들지 않는다.
 */
'use strict';

/**
 * 계획을 시트 행 배열로 변환.
 * ★ 열 이름이 곧 어느 칸에 쓸지를 정한다 — `plan.columns[i].role` 로 판정하므로
 *   여기서 키워드 규칙을 다시 만들지 않는다(분류는 매퍼 파생 단일 출처).
 * ★ 시스템이 값을 넣는 칸은 번호·구매일자·상품옵션·리뷰옵션·배송정보와 V2 상품·단계형 옵션이다.
 *   상품옵션과 리뷰옵션은 서로 다른 역할의 칸에만 기록한다.
 */
function planToSheetValues(plan) {
  const { isReviewOptionHeader } = require('../utils/reviewType');
  const header = plan.columns.map(c => c.name);
  const idxSeq = plan.columns.findIndex(c => c.role === 'seq');
  const idxDate = plan.columns.findIndex(c => c.role === 'dateStr');
  const idxOpt = plan.columns.findIndex(c => c.role === 'option' && !isReviewOptionHeader(c.name));
  const idxRt = plan.columns.findIndex(c => isReviewOptionHeader(c.name));
  const { DELIVERY_KIND_HEADER, RECALL_HEADERS } = require('../utils/worktablePlan');
  const idxDv = plan.columns.findIndex(c => c.name === DELIVERY_KIND_HEADER);
  const idxRc = plan.columns.findIndex(c => c.name === RECALL_HEADERS[0]);
  const idxRp = plan.columns.findIndex(c => c.name === RECALL_HEADERS[1]);
  const idxProduct = plan.columns.findIndex(c => c.role === 'product');
  const idxOption1 = plan.columns.findIndex(c => c.role === 'option_1');
  const idxOption2 = plan.columns.findIndex(c => c.role === 'option_2');
  const idxRound = plan.columns.findIndex(c => c.role === 'round');
  const idxReviewOption = plan.columns.findIndex(c => c.role === 'review_option_instruction');
  const body = plan.rows.map(r => {
    const row = new Array(header.length).fill('');
    if (idxSeq >= 0) row[idxSeq] = String(r.seq);
    if (idxDate >= 0 && r.dateLabel) row[idxDate] = r.dateLabel;   // `M / D (요일)` — 063 시트 일정 인식이 읽는 형식
    if (idxOpt >= 0 && r.optionKey) row[idxOpt] = r.optionKey;
    if (idxRt >= 0 && r.reviewOption) row[idxRt] = r.reviewOption; // `포토리뷰`·`텍스트`… — 검수 ① 행 우선이 되읽는다
    if (idxDv >= 0 && r.deliveryKind) row[idxDv] = r.deliveryKind;   // `실배송`·`빈박스` — 혼합 오더의 행별 물류 구분
    if (idxRc >= 0 && r.recallCourier) row[idxRc] = r.recallCourier;
    if (idxRp >= 0 && r.recallProduct) row[idxRp] = r.recallProduct;
    if (idxProduct >= 0 && r.selection?.productName) row[idxProduct] = r.selection.productName;
    if (idxOption1 >= 0 && r.selection?.option1Value) row[idxOption1] = r.selection.option1Value;
    if (idxOption2 >= 0 && r.selection?.option2Value) row[idxOption2] = r.selection.option2Value;
    if (idxRound >= 0 && r.roundLabel) row[idxRound] = r.roundLabel;
    if (idxReviewOption >= 0 && r.reviewOptionLabel) row[idxReviewOption] = r.reviewOptionLabel;
    return row;
  });
  return { header, body, filled: {
    seq: idxSeq >= 0, date: idxDate >= 0, option: idxOpt >= 0,
    product: idxProduct >= 0, option1: idxOption1 >= 0, option2: idxOption2 >= 0,
    round: idxRound >= 0, reviewOption: idxReviewOption >= 0,
    deliveryKind: idxDv >= 0, recall: idxRc >= 0 || idxRp >= 0,
  } };
}

module.exports = { planToSheetValues };
