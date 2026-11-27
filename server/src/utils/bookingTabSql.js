'use strict';
/**
 * bookingTabSql.js — 「이 탭이 네이버예약리뷰(자리표) 탭인가」 SQL 조각의 단일 출처 (결정 407 판정 · 결정 423 에서 조각으로 뺌).
 *
 * 판정 = 자리표(booking_slots)가 있거나, 탭 종류(tab_configs.work_kind)가 booking 이다
 *   (자리표 저장이 실패한 예약 탭도 리뷰 탭처럼 다뤄지지 않게 — bookingSlots.service 머리말).
 * 쓰는 곳: bookingSlots.isBookingTab(자리표 자동 정리 격리) · reviewClockStart(리뷰 날수 시작일 — 결정 423) ·
 *          reviewer.routes 리뷰어 홈 「리뷰 미제출 · N일 경과」 경고 후보에서 예약 줄 빼기(결정 425).
 * ★ 쓰는 곳들이 같은 글자를 따로 들고 있으면 한쪽만 고쳐져 「예약 탭」 판정이 갈린다 — 여기 하나만 고친다.
 *
 * @param {string} sheetExpr  시트 id SQL 식(예: '$1' 또는 'ri.sheet_id')
 * @param {string} tabExpr    탭 이름 SQL 식(예: '$2' 또는 'ri.tab_name')
 * @returns {string} 불린 SQL 식
 */
function bookingTabSql(sheetExpr, tabExpr) {
  return `(EXISTS (SELECT 1 FROM booking_slots WHERE sheet_id = ${sheetExpr} AND tab_name = ${tabExpr})
                                OR EXISTS (SELECT 1 FROM tab_configs WHERE sheet_id = ${sheetExpr} AND tab_name = ${tabExpr} AND work_kind = 'booking'))`;
}

module.exports = { bookingTabSql };
