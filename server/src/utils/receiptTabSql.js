'use strict';
/**
 * receiptTabSql.js — 「이 탭이 영수증리뷰(영수증 묶음) 탭인가」 SQL 조각의 단일 출처 (결정 420 판정 · 결정 432 사용자 확정 2026-11-28 에서 조각으로 뺌).
 *
 * 판정 = 영수증 묶음(receipt_pool)이 있거나, 탭 종류(tab_configs.work_kind)가 receipt 다
 *   (묶음 저장이 실패한 영수증 탭도 리뷰 탭처럼 다뤄지지 않게 — receiptPool.service 머리말). `bookingTabSql` 과 같은 모양.
 * 쓰는 곳: receiptPool.isReceiptPoolTab(자동 정리 격리) · reviewClockStart.KIND_ROW_SQL.receipt(리뷰 알림톡 방식 — 마감 전날 한 번) ·
 *          reviewer.routes 리뷰어 홈 「리뷰 미제출 · N일 경과」 경고 후보에서 영수증 줄 빼기(결정 425 를 영수증에도 — 리뷰 기한이
 *          10일보다 길면 마감 전에 「N일 경과」가 뜨므로 예약처럼 「내일/오늘 마감」 안내만 남긴다).
 * ★ 쓰는 곳들이 같은 글자를 따로 들고 있으면 한쪽만 고쳐져 「영수증 탭」 판정이 갈린다 — 여기 하나만 고친다.
 *
 * @param {string} sheetExpr  시트 id SQL 식(예: '$1' 또는 'ri.sheet_id')
 * @param {string} tabExpr    탭 이름 SQL 식(예: '$2' 또는 'ri.tab_name')
 * @returns {string} 불린 SQL 식
 */
function receiptTabSql(sheetExpr, tabExpr) {
  return `(EXISTS (SELECT 1 FROM receipt_pool WHERE sheet_id = ${sheetExpr} AND tab_name = ${tabExpr})
                                     OR EXISTS (SELECT 1 FROM tab_configs WHERE sheet_id = ${sheetExpr} AND tab_name = ${tabExpr} AND work_kind = 'receipt'))`;
}

module.exports = { receiptTabSql };
