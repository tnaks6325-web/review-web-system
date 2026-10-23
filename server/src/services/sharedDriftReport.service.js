// ═══════════════════════════════════════════════════════════════════════════
// 양방향 동기화 대조 보고서 — 작업오더 ↔ 모집공고의 공유 칸이 지금 같은가 (결정 275 · 읽기 전용)
//
// ★★ 쓰기 0건 — SELECT 만 한다. 호출부(스크립트)는 읽기 전용 트랜잭션에서 돌린다.
// ★★ 마감(보관)된 공고는 연결 대상이 아니다(사용자 확정 2026-10-20 「마감된건 빼」) —
//    비교하지 않고 `excluded_archived` 로만 센다. 보관 해제되면 다음 보고서에서 다시 대상이 된다.
// ★ 판정: 공유 칸 중 `diff`(둘 다 값이 있는데 다름)가 하나라도 있으면 `diff`, 아니면 `same`.
//   `fill`(오더는 비었고 공고만 값이 있음 — 썸네일 자동수집 등)은 충돌이 아니라 연결 때 채울 값이다.
// ★ 인트라넷 리뷰오더 ↔ 작업오더 쪽 대조는 인트라넷 원본이 필요해 여기서 하지 않는다
//   (2026-10-20 1회 대조는 운영 읽기 조회로 했다 — docs/decisions/263).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const { compareOrderCampaign } = require('../utils/orderToCampaignProjection');

const REPORT_SQL = `
  SELECT w.*,
         row_to_json(c.*) AS _campaign,
         (SELECT COALESCE(json_agg(o.* ORDER BY o.sort_order, o.id), '[]'::json)
            FROM campaign_options o WHERE o.campaign_id = c.id) AS _options
    FROM work_orders w
    LEFT JOIN recruit_campaigns c ON c.id = w.linked_campaign_id
   WHERE w.deleted_at IS NULL
     AND COALESCE(w.source_review_order_id, '') <> ''
   ORDER BY w.created_at`;

/**
 * @param {{ query: Function }} db  pool 또는 client
 * @returns {Promise<{ generatedAt: string, counts: object, fieldCounts: object, rows: object[] }>}
 */
async function buildSharedDriftReport(db) {
  const { rows } = await db.query(REPORT_SQL);
  const out = [];
  const counts = { same: 0, diff: 0, excluded_archived: 0, no_campaign: 0 };
  const fieldCounts = {};
  for (const r of rows) {
    const camp = r._campaign;
    const base = { workOrderId: r.id, sourceReviewOrderId: r.source_review_order_id, title: r.title, campaignId: camp ? camp.id : null };
    if (!camp) { counts.no_campaign++; out.push({ ...base, state: 'no_campaign', diffs: [], fills: [] }); continue; }
    if (camp.archived_at) { counts.excluded_archived++; out.push({ ...base, state: 'excluded_archived', diffs: [], fills: [] }); continue; }
    const cmp = compareOrderCampaign(r, camp, r._options || []);
    const diffs = cmp.filter(d => d.kind === 'diff');
    const fills = cmp.filter(d => d.kind === 'fill');
    const state = diffs.length ? 'diff' : 'same';
    counts[state]++;
    for (const d of diffs) {
      const k = d.field.startsWith('option:') ? 'option.' + (d.field.match(/\.(\w+)$/) || [, '(줄 있음/없음)'])[1] : d.field;
      fieldCounts[k] = (fieldCounts[k] || 0) + 1;
    }
    out.push({ ...base, state, diffs, fills });
  }
  return { generatedAt: new Date().toISOString(), counts, fieldCounts, rows: out };
}

module.exports = { buildSharedDriftReport, REPORT_SQL };
