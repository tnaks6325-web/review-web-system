/**
 * 작업표 행이 현재 활성 작업보드 연결을 상속하도록 보정한다.
 *
 * 모집정원/날짜계획에서 새 준비 행을 만든 뒤 작업보드 연결값을 넣지 않으면,
 * 화면에는 빈자리가 있어도 작업보드 큐는 그 자리를 다른 대상으로 보고 사용하지 못한다.
 * 이 서비스는 tab_configs가 가리키는 활성 작업보드 한 곳만 근거로 삼고, 아직 어느
 * 작업보드에도 연결되지 않은 같은 탭의 행만 보정한다. 다른 작업보드 값은 절대 덮지 않는다.
 */
'use strict';

async function bindUnassignedRowsToActiveWorkboard(client, {
  sheetId, tabName, expectedWorkboardId = null,
} = {}) {
  if (!client || typeof client.query !== 'function' || !sheetId || !tabName) {
    return { workboardId: null, bound: 0 };
  }

  const result = await client.query(
    `WITH target AS (
       SELECT tc.workboard_id
         FROM tab_configs tc
         JOIN workboards w ON w.id = tc.workboard_id AND w.state = 'active'
        WHERE tc.sheet_id = $1 AND tc.tab_name = $2
          AND ($3::uuid IS NULL OR tc.workboard_id = $3::uuid)
        LIMIT 1
     ), bound AS (
       UPDATE campaign_participants cp
          SET workboard_id = target.workboard_id
         FROM target
        WHERE cp.sheet_id = $1 AND cp.tab_name = $2
          AND cp.deleted_at IS NULL AND cp.active = TRUE AND cp.workboard_id IS NULL
       RETURNING cp.id
     )
     SELECT (SELECT workboard_id FROM target) AS workboard_id,
            (SELECT COUNT(*)::int FROM bound) AS bound`,
    [sheetId, tabName, expectedWorkboardId]
  );
  const row = (result && Array.isArray(result.rows) && result.rows[0]) || {};
  return {
    workboardId: row.workboard_id || null,
    bound: Number(row.bound) || 0,
  };
}

module.exports = { bindUnassignedRowsToActiveWorkboard };
