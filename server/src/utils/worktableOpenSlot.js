'use strict';
/**
 * ★★ 작업표 「빈 줄」 한 줄의 판정 — 단일 출처 (결정 324 보강 · Codex P2 2026-11-03)
 *
 * 쓰는 곳(사본 금지 — 여기만 고친다):
 *   - 실제 줄 고르기 `sheetlessOrder._pickOpenSlot` 후보 · v2 「상품 · 옵션」 후보 · 옵션 이름 바꿔 쓰기 후보
 *   - 결정 324 사전 확인 `workboardNoSlot.openSlotExistsSql`([다시 넣기] 거부 · 매시 되살리기)
 * 종전에는 사전 확인이 이 조건을 따로 들고 있으면서 작업보드(workboard_id)를 보지 않아, **다른 작업보드의 빈 줄**을
 * 빈 줄로 세었다 → 성공할 수 없는 다시 넣기를 받아 주고 매시 복구가 같은 실패를 되풀이했다.
 *
 * @param {string} a  campaign_participants 별칭(예: 'cp')
 * @param {object} o
 * @param {string} o.sheet · o.tab   시트ID·작업명 SQL 표현식
 * @param {string} o.workboard       대상 작업보드 SQL 표현식(NULL 이면 작업보드를 가리지 않는다 — writer 종전 의미)
 * @param {boolean} [o.unboundJoinsTarget]  작업보드가 비어 있는 줄을 대상 작업보드의 줄로 본다 —
 *   writer 는 고르기 전에 `workboardSlotAffinity.bindUnassignedRowsToActiveWorkboard` 로 그런 줄을 대상 작업보드에 붙이므로,
 *   **고르기 전에** 판정하는 사전 확인만 켠다(다른 작업보드에 붙은 줄은 어느 쪽이든 제외).
 */
function openSlotRowSql(a, { sheet, tab, workboard, unboundJoinsTarget = false }) {
  const rowWb = unboundJoinsTarget ? `COALESCE(${a}.workboard_id, ${workboard}::uuid)` : `${a}.workboard_id`;
  return `${a}.sheet_id = ${sheet} AND ${a}.tab_name = ${tab} AND ${a}.deleted_at IS NULL AND ${a}.active = TRUE
          AND (${workboard}::uuid IS NULL OR ${rowWb} = ${workboard}::uuid)
          AND ${a}.order_submission_id IS NULL
          AND NULLIF(btrim(COALESCE(${a}.reviewer_name, '')), '') IS NULL
          AND NULLIF(btrim(COALESCE(${a}.recipient_name, '')), '') IS NULL
          AND NULLIF(btrim(COALESCE(${a}.phone8, '')), '') IS NULL`;
}

module.exports = { openSlotRowSql };
