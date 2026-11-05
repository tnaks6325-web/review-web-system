'use strict';

const { campaignAtPurchaseOrderSql } = require('./directPurchaseParticipation.service');

/** 관리자 참여 관리 전용 표시. 판정을 다시 하지 않고 공유 FIFO의 실제 짝만 일괄 조회한다.
 * 구매 기록의 선택값이며 캡처 판독/실제 배송 상품과 동일하다고 보증하지 않는다.
 * 상세 조회 실패는 각 상세에만 error — 목록/기존 목적 배지는 호출부가 그대로 유지한다.
 */
async function loadPopularPurposeDetails(db, matches, normalIds, { onError } = {}) {
  const pairs = matches && matches.matchedPairs;
  const selected = [...new Set((normalIds || []).map(String))].filter(id => pairs instanceof Map && pairs.has(id));
  const details = new Map();
  if (!selected.length) return details;
  const ids = [...new Set(selected.flatMap(id => [id, String(pairs.get(id))]))];
  try {
    const { rows } = await db.query(`
      WITH keys AS (
        SELECT event_id,
               CASE WHEN event_id ~ '^[0-9]+$' THEN event_id::bigint END AS app_id,
               CASE WHEN event_id ~ '^os:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    THEN substring(event_id FROM 4)::uuid END AS order_id
          FROM unnest($1::text[]) AS k(event_id)
      ), events AS (
        SELECT k.event_id, ca.campaign_id, ca.option_key, ca.purchase_qty AS application_qty,
               os.id AS order_id, os.sheet_id, os.tab_name, os.tab_gid,
               os.selected_product, os.selected_opt_key, os.purchase_qty, os.submitted_at,
               rc.linked_sheet_id, rc.linked_tab_name, rc.linked_tab_gid
          FROM keys k
          JOIN campaign_applications ca ON ca.id = k.app_id
          JOIN recruit_campaigns rc ON rc.id = ca.campaign_id
          LEFT JOIN order_submissions os ON os.id = ca.order_submission_id AND os.deleted_at IS NULL
        UNION ALL
        SELECT k.event_id, rc.id, NULL::text, NULL::integer,
               os.id, os.sheet_id, os.tab_name, os.tab_gid,
               os.selected_product, os.selected_opt_key, os.purchase_qty, os.submitted_at,
               rc.linked_sheet_id, rc.linked_tab_name, rc.linked_tab_gid
          FROM keys k
          JOIN order_submissions os ON os.id = k.order_id AND os.deleted_at IS NULL
          JOIN LATERAL (
            SELECT rc.* FROM recruit_campaigns rc
             WHERE rc.participation_mode IS TRUE
               AND rc.linked_sheet_id = os.sheet_id AND rc.linked_tab_name = os.tab_name
             ORDER BY ${campaignAtPurchaseOrderSql('os.submitted_at')} LIMIT 1
          ) rc ON TRUE
      )
      SELECT e.event_id,
             COALESCE(NULLIF(pe.value_text, ''), NULLIF(e.selected_product, ''),
                      NULLIF(cp.row_json->>'상품', ''), NULLIF(cp.product_name, ''), NULLIF(opt.product_name, '')) AS product,
             COALESCE(NULLIF(e.selected_opt_key, ''), NULLIF(e.option_key, '')) AS option,
             COALESCE(e.purchase_qty, e.application_qty) AS quantity, e.submitted_at
        FROM events e
        LEFT JOIN LATERAL (
          SELECT p.product_name, p.row_json, p.sheet_id, p.tab_name FROM campaign_participants p
           WHERE p.order_submission_id = e.order_id AND p.deleted_at IS NULL AND p.active
             AND p.sheet_id = e.linked_sheet_id
             AND (p.tab_name = e.linked_tab_name OR
                  (NULLIF(e.linked_tab_gid, '') IS NOT NULL AND NULLIF(p.tab_gid, '') = NULLIF(e.linked_tab_gid, '')))
           ORDER BY p.seq LIMIT 1
        ) cp ON TRUE
        -- 기존 바로 구매 목록과 같은 정정 기준. 다른 작업표/다른 주문의 수정은 섞지 않는다.
        LEFT JOIN LATERAL (
          SELECT pe0.value_text FROM participant_edits pe0
           WHERE pe0.sheet_id = cp.sheet_id AND pe0.tab_name = cp.tab_name
             AND pe0.anchor_type = 'order' AND pe0.anchor_value = e.order_id::text
             AND pe0.field = 'col:상품' AND pe0.reverted_at IS NULL
           ORDER BY pe0.created_at DESC, pe0.id DESC LIMIT 1
        ) pe ON TRUE
        LEFT JOIN LATERAL (
          SELECT o.product_name FROM campaign_options o
           WHERE o.campaign_id = e.campaign_id
             AND o.opt_key = COALESCE(NULLIF(e.selected_opt_key, ''), e.option_key)
           LIMIT 1
        ) opt ON TRUE`, [ids]);
    const byId = new Map(rows.map(row => [String(row.event_id), row]));
    for (const id of selected) {
      const purchase = byId.get(id);
      const popular = byId.get(String(pairs.get(id)));
      if (!purchase || !popular) { details.set(id, { status: 'error' }); continue; }
      const qty = Number(purchase.quantity);
      details.set(id, {
        status: 'ok',
        purchase: {
          product: String(purchase.product || ''), option: String(purchase.option || ''),
          quantity: Number.isInteger(qty) && qty > 0 ? qty : null,
          submittedAt: purchase.submitted_at || null,
        },
        popularProduct: String(popular.product || ''),
        popularOption: String(popular.option || ''),
      });
    }
  } catch (err) {
    for (const id of selected) details.set(id, { status: 'error' });
    if (onError) onError(err);
  }
  return details;
}

module.exports = { loadPopularPurposeDetails };
