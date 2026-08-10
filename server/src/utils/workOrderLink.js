// ═══════════════════════════════════════════════════════════════════════════
// "그 탭에 연결된 작업오더" 조회 SQL — 단일 출처
//
// ★★ 우선순위를 **ORDER BY 로 명시**한다. 두 조건을 OR 로만 묶으면 Track B 링크가 있어도
//    `created_at` 이 더 최근인 `work_orders.linked_tab_*` 폴백 오더가 이긴다(실측으로 잡힌 버그 —
//    엉뚱한 오더의 상품명·총원으로 판정하게 된다). 0 = Track B 링크(명시 지정) / 1 = 폴백.
//
// ★ `work_orders` 는 **읽기만** — Track A 승인 흐름이 `linked_tab_*` 를 보고 분기하므로
//   이 경로에서 그 칸을 건드리지 않는다.
// ★ 파라미터는 항상 [sheetId, tabName] 두 개($1,$2)로 고정한다.
// ═══════════════════════════════════════════════════════════════════════════

/** 컬럼 목록은 SQL 에 그대로 박히므로 형식을 검사한다(자유 문자열 금지). */
const COL_RE = /^[a-z][a-z0-9_]*$/;

/**
 * @param {string[]} columns  work_orders 에서 읽을 칸 이름들(별칭 없이)
 * @returns {string} SELECT … LIMIT 1 (params: [sheetId, tabName])
 */
function workOrderForTabSql(columns) {
  const cols = (Array.isArray(columns) ? columns : []).filter(c => COL_RE.test(String(c || '')));
  if (!cols.length) throw new Error('workOrderForTabSql: 읽을 칸이 없다');
  const linkExists = `EXISTS (SELECT 1 FROM trackb_work_order_links l
                               WHERE l.work_order_id = w.id AND l.deleted_at IS NULL
                                 AND l.sheet_id = $1 AND l.tab_name = $2)`;
  return `SELECT ${cols.map(c => `w.${c}`).join(', ')},
                 CASE WHEN ${linkExists} THEN 0 ELSE 1 END AS link_rank
            FROM work_orders w
           WHERE w.deleted_at IS NULL
             AND ( ${linkExists}
                   OR (w.linked_tab_sheet_id = $1 AND w.linked_tab_name = $2) )
           ORDER BY link_rank, w.created_at DESC
           LIMIT 1`;
}

module.exports = { workOrderForTabSql };
