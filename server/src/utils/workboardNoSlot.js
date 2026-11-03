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
const { openSlotRowSql } = require('./worktableOpenSlot');

const NO_SLOT_QUEUE_ERROR = '작업보드 반영 보류: no_open_slot — 작업표에 빈 줄이 없음(매시 재시도 제외 · 줄이 생기면 다시 넣음 · 결정 324)';
const LEGACY_NO_SLOT_QUEUE_ERROR = '작업보드 반영 실패: no_open_slot';
const NO_SLOT_QUEUE_ERRORS = Object.freeze([NO_SLOT_QUEUE_ERROR, LEGACY_NO_SLOT_QUEUE_ERROR]);

/**
 * 「그 작업표에 빈 줄이 하나라도 있나」 — 되살릴지 정하는 **사전 확인**일 뿐이다.
 * 실제로 어느 줄에 넣을지(옵션·상품·날짜 순)는 언제나 `sheetlessOrder.writeOrderToWorktable`(_pickOpenSlot)이 정한다.
 * ★ 한 줄 판정은 writer 와 **같은 함수**(`utils/worktableOpenSlot.openSlotRowSql`)다 — 사본 금지(Codex P2 2026-11-03).
 *   대상 작업보드 = 큐 실행부와 같은 「그 작업의 활성 작업보드」(tab_configs.workboard_id · workboards.state='active').
 *   다른 작업보드에 붙은 빈 줄은 세지 않는다(writer 가 workboard_id 로 거른다) · 작업보드가 빈 줄은 센다(writer 가 고르기 전에 붙인다).
 *   활성 작업보드가 없으면 거짓(fail-closed — 큐 실행부가 그 작업을 반영하지 않는다).
 * sheetExpr·tabExpr = 시트ID·작업명 SQL 표현식(예: `q.payload->>'sheetId'` 또는 `$1`).
 */
function openSlotExistsSql(sheetExpr, tabExpr) {
  return `EXISTS (
    SELECT 1 FROM tab_configs slot_tc
      JOIN workboards slot_w ON slot_w.id = slot_tc.workboard_id AND slot_w.state = 'active'
      JOIN campaign_participants cp
        ON ${openSlotRowSql('cp', { sheet: 'slot_tc.sheet_id', tab: 'slot_tc.tab_name', workboard: 'slot_tc.workboard_id', unboundJoinsTarget: true })}
     WHERE slot_tc.sheet_id = ${sheetExpr} AND slot_tc.tab_name = ${tabExpr})`;
}

module.exports = { NO_SLOT_QUEUE_ERROR, LEGACY_NO_SLOT_QUEUE_ERROR, NO_SLOT_QUEUE_ERRORS, openSlotExistsSql };
