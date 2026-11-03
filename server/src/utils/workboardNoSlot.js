'use strict';
/**
 * ★★ 결정 324 — 작업표 빈 줄이 없어 작업보드 반영(workboard_apply)이 막힌 주문의 단일 출처.
 *
 * - 큐 실행부(workboardQueueApply)가 `writeOrderToWorktable` 의 `no_open_slot` 을 이 문장으로 던진다.
 * - 매시 복구(syncQueue.retryAllFailed)는 이 문장의 failed 행을 **되살리지 않는다**(끝없는 실패 중단) —
 *   단, 그 작업표에 빈 줄이 다시 생겼으면 되살린다(직원이 줄을 늘리면 다시 넣는 길).
 * - 홈 「오늘 확인할 것」(workboardSlotOpsCheck)이 이 문장의 failed 행으로 확인 항목을 띄운다.
 * - 행은 지우지 않는다(결정 271·274 — 큐 행은 기록).
 *
 * 문장이 두 개인 이유: 이 결정 전 코드가 남긴 문장(`작업보드 반영 실패: no_open_slot`)도 같은 뜻이다
 *   (운영 2026-11-03 실측 1건 — 비타민C 10/26). 새 문장은 사람이 큐 표만 보고도 「보류」임을 알게 한다.
 */
const NO_SLOT_QUEUE_ERROR = '작업보드 반영 보류: no_open_slot — 작업표에 빈 줄이 없음(매시 재시도 제외 · 줄이 생기면 다시 넣음 · 결정 324)';
const LEGACY_NO_SLOT_QUEUE_ERROR = '작업보드 반영 실패: no_open_slot';
const NO_SLOT_QUEUE_ERRORS = Object.freeze([NO_SLOT_QUEUE_ERROR, LEGACY_NO_SLOT_QUEUE_ERROR]);

/**
 * 「그 작업표에 빈 줄이 하나라도 있나」 — 되살릴지 정하는 **사전 확인**일 뿐이다.
 * 실제로 어느 줄에 넣을지(옵션·상품·날짜 순)는 언제나 `sheetlessOrder.writeOrderToWorktable`(_pickOpenSlot)이 정한다.
 * 조건은 그 함수의 빈 줄 기본 조건(살아 있음 · 주문 없음 · 이름·수취인·연락처 빈 칸)과 같다.
 * sheetExpr·tabExpr = 시트ID·작업명 SQL 표현식(예: `q.payload->>'sheetId'` 또는 `$1`).
 */
function openSlotExistsSql(sheetExpr, tabExpr) {
  return `EXISTS (
    SELECT 1 FROM campaign_participants cp
     WHERE cp.sheet_id = ${sheetExpr} AND cp.tab_name = ${tabExpr}
       AND cp.deleted_at IS NULL AND cp.active = TRUE
       AND cp.order_submission_id IS NULL
       AND NULLIF(btrim(COALESCE(cp.reviewer_name, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(cp.recipient_name, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(cp.phone8, '')), '') IS NULL)`;
}

module.exports = { NO_SLOT_QUEUE_ERROR, LEGACY_NO_SLOT_QUEUE_ERROR, NO_SLOT_QUEUE_ERRORS, openSlotExistsSql };
