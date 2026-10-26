/**
 * paybackLedgerFeed.service.js — 인트라넷 재무(페이백 장부)가 가져가는 지급 기록 (읽기 전용 · 결정 290)
 *
 * 인트라넷이 `X-Intake-Key` 로 끌어간다(order.routes `/payback-ledger/*`). 리뷰웹은 아무것도 쓰지 않는다.
 *
 * ★ 내보내는 것 = **지급이 끝난 건(payment_batch_items.status='paid')의 금액·시각·작업 키**뿐.
 *   리뷰어 이름·phone8·은행·계좌·예금주는 싣지 않는다 — 인트라넷 재무에는 필요 없고,
 *   개인정보가 새던 입구를 되살리지 않는다는 규율(결정 186 92번)과 같은 이유다.
 * ★ 금액은 회차에 박제된 값 그대로(결정 108 스냅샷) — 여기서 다시 계산하지 않는다.
 *   단, 관리자가 금액 조정을 승인한 건은 승인 기록의 실제 이체금액(EFFECTIVE_ITEMS_SQL).
 * ★ 작업 → 계약 연결은 회차와 따로 싣는다(summary.tabs). 연결은 지급 뒤에 생기거나 바뀔 수 있어서
 *   회차 지문(fingerprint)에 섞으면 인트라넷이 바뀐 연결을 다시 가져오지 못한다.
 *   판정 순서 = 탭 ↔ 계약 링크(trackb_settlement_links) > 그 탭의 작업오더(명시 링크 > 직접 연결)의 계약.
 */
'use strict';

const pool = require('../db/pool');

const MAX_BATCHES_PER_CALL = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* 지급 건의 「실제로 나간 금액」 — 관리자가 금액 조정을 승인한 건(payment_amount_mismatch_reconciliations, migration 150)은
   회차 박제값을 덮어쓰지 않고 승인 기록에 실제 이체금액·상품값·리뷰비를 따로 남긴다. 그 건은 승인 기록 값을 쓴다(Codex PR #1691).
   회차 합계·지문·건 목록이 모두 이 한 정의를 읽는다(사본 0). */
const EFFECTIVE_ITEMS_SQL = `
  SELECT i.id, i.batch_id, i.sheet_id, i.tab_name, i.row_index, i.campaign_id, i.status, i.paid_at,
         CASE WHEN r.batch_item_id IS NULL THEN i.product_price ELSE ROUND(r.workboard_product_amount)::int END AS product_price,
         CASE WHEN r.batch_item_id IS NULL THEN i.review_fee    ELSE ROUND(r.review_fee)::int END              AS review_fee,
         CASE WHEN r.batch_item_id IS NULL THEN i.amount        ELSE ROUND(r.actual_amount)::int END           AS amount,
         (r.batch_item_id IS NOT NULL) AS adjusted,
         i.amount AS snapshot_amount
    FROM payment_batch_items i
    LEFT JOIN payment_amount_mismatch_reconciliations r ON r.batch_item_id = i.id`;

const _num = v => (v == null ? 0 : Number(v));
const _iso = v => (v ? new Date(v).toISOString() : null);

/** 회차별 합계와 지문 — 인트라넷은 지문이 바뀐 회차의 건만 다시 가져간다. */
async function batchSummaries(db = pool) {
  const { rows } = await db.query(
    `SELECT b.id, b.seq, b.bank, b.status, b.created_at, b.applied_at,
            COUNT(i.id) FILTER (WHERE i.status = 'paid')::int                    AS paid_count,
            COALESCE(SUM(i.product_price) FILTER (WHERE i.status = 'paid'), 0)    AS product_sum,
            COALESCE(SUM(i.review_fee)    FILTER (WHERE i.status = 'paid'), 0)    AS fee_sum,
            COALESCE(SUM(i.amount)        FILTER (WHERE i.status = 'paid'), 0)    AS amount_sum,
            COUNT(i.id) FILTER (WHERE i.status = 'pending')::int                 AS pending_count,
            COALESCE(SUM(i.amount)        FILTER (WHERE i.status = 'pending'), 0) AS pending_amount,
            MIN(i.paid_at) FILTER (WHERE i.status = 'paid')                       AS first_paid_at,
            MAX(i.paid_at) FILTER (WHERE i.status = 'paid')                       AS last_paid_at,
            md5(COALESCE(string_agg(
                  i.id::text || ':' || i.product_price || ':' || i.review_fee || ':' || i.amount || ':' || COALESCE(i.paid_at::text, ''),
                  ',' ORDER BY i.id) FILTER (WHERE i.status = 'paid'), '')) AS fingerprint
       FROM payment_batches b
       LEFT JOIN (${EFFECTIVE_ITEMS_SQL}) i ON i.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at, b.id`);
  return rows.map(r => ({
    id: r.id,
    seq: _num(r.seq),
    bank: r.bank,
    status: r.status,
    created_at: _iso(r.created_at),
    applied_at: _iso(r.applied_at),
    paid_count: _num(r.paid_count),
    product_sum: _num(r.product_sum),
    fee_sum: _num(r.fee_sum),
    amount_sum: _num(r.amount_sum),
    pending_count: _num(r.pending_count),
    pending_amount: _num(r.pending_amount),
    first_paid_at: _iso(r.first_paid_at),
    last_paid_at: _iso(r.last_paid_at),
    fingerprint: r.fingerprint,
  }));
}

/** 지급 건이 있는 작업(탭)마다 계약·작업오더·업체 연결. */
async function tabLinks(db = pool) {
  const { rows } = await db.query(
    `WITH t AS (SELECT DISTINCT sheet_id, tab_name FROM payment_batch_items WHERE status = 'paid')
     SELECT t.sheet_id, t.tab_name,
            COALESCE(NULLIF(tc.display_name, ''), t.tab_name) AS tab_label,
            sl.sales_id AS link_sales_id, sl.contract_number AS link_contract_number,
            wo.id AS work_order_id, wo.title AS work_title,
            wo.sales_id AS wo_sales_id, wo.contract_number AS wo_contract_number,
            wo.source_review_order_id, wo.intranet_advertiser_id, wo.intranet_advertiser_name
       FROM t
       LEFT JOIN LATERAL (
            SELECT c.display_name FROM tab_configs c
             WHERE c.sheet_id = t.sheet_id AND c.tab_name = t.tab_name LIMIT 1) tc ON TRUE
       LEFT JOIN LATERAL (
            SELECT s.sales_id, s.contract_number FROM trackb_settlement_links s
             WHERE s.sheet_id = t.sheet_id AND s.tab_name = t.tab_name AND s.deleted_at IS NULL
             ORDER BY s.created_at DESC LIMIT 1) sl ON TRUE
       LEFT JOIN LATERAL (
            /* 지운 작업오더도 마지막 수단으로 본다 — 돈은 이미 나갔고, 작업이 지워졌다고 계약이 사라지지는 않는다. */
            /* 탭 ↔ 작업오더 = 명시 Track B 링크(trackb_work_order_links) 우선 → 직접 연결(linked_tab_*) 폴백.
               작업 조건 카드(trackB 탭 목록)와 같은 우선순위다(Codex PR #1691). */
            SELECT w.id, w.title, w.sales_id, w.contract_number, w.source_review_order_id,
                   w.intranet_advertiser_id, w.intranet_advertiser_name
              FROM work_orders w
              LEFT JOIN trackb_work_order_links l
                ON l.work_order_id = w.id AND l.sheet_id = t.sheet_id AND l.tab_name = t.tab_name AND l.deleted_at IS NULL
             WHERE (w.linked_tab_sheet_id = t.sheet_id AND w.linked_tab_name = t.tab_name) OR l.id IS NOT NULL
             ORDER BY (l.id IS NOT NULL) DESC, (w.deleted_at IS NULL) DESC, (COALESCE(w.sales_id, '') <> '') DESC, w.created_at DESC
             LIMIT 1) wo ON TRUE
      ORDER BY t.sheet_id, t.tab_name`);
  return rows.map(r => {
    const linkSales = String(r.link_sales_id || '').trim();
    const woSales = String(r.wo_sales_id || '').trim();
    const salesId = linkSales || woSales || null;
    return {
      sheet_id: r.sheet_id,
      tab_name: r.tab_name,
      tab_label: r.tab_label || r.tab_name,
      sales_id: salesId,
      contract_number: (linkSales ? r.link_contract_number : r.wo_contract_number) || '',
      link_source: linkSales ? 'settlement_link' : (woSales ? 'work_order' : null),
      work_order_id: r.work_order_id || null,
      work_title: r.work_title || '',
      source_review_order_id: r.source_review_order_id || '',
      intranet_advertiser_id: r.intranet_advertiser_id || '',
      advertiser_name: r.intranet_advertiser_name || '',
    };
  });
}

/** 회차 몇 개의 지급 건. 잘못된 id 는 조용히 버리지 않고 오류로 돌려준다(가져가는 쪽이 빠진 회차를 알아야 한다). */
async function batchItems(batchIds, db = pool) {
  const ids = Array.from(new Set((batchIds || []).map(s => String(s || '').trim()).filter(Boolean)));
  if (!ids.length) return { ok: false, error: 'batch_ids 가 비었습니다.' };
  if (ids.length > MAX_BATCHES_PER_CALL) return { ok: false, error: `한 번에 회차 ${MAX_BATCHES_PER_CALL}개까지입니다.` };
  const bad = ids.filter(id => !UUID_RE.test(id));
  if (bad.length) return { ok: false, error: '회차 id 형식이 아닙니다: ' + bad.slice(0, 3).join(', ') };
  const { rows } = await db.query(
    `SELECT i.id, i.batch_id, i.sheet_id, i.tab_name, i.row_index, i.campaign_id,
            i.product_price, i.review_fee, i.amount, i.paid_at, i.adjusted, i.snapshot_amount
       FROM (${EFFECTIVE_ITEMS_SQL}) i
      WHERE i.batch_id = ANY($1::uuid[]) AND i.status = 'paid'
      ORDER BY i.batch_id, i.id`, [ids]);
  return {
    ok: true,
    items: rows.map(r => ({
      id: r.id,
      batch_id: r.batch_id,
      sheet_id: r.sheet_id,
      tab_name: r.tab_name,
      row_index: _num(r.row_index),
      campaign_id: r.campaign_id || null,
      product_price: _num(r.product_price),
      review_fee: _num(r.review_fee),
      amount: _num(r.amount),
      paid_at: _iso(r.paid_at),
      // 금액 조정 승인 건 — amount 는 실제 이체금액, snapshot_amount 는 회차에 처음 담긴 금액
      adjusted: r.adjusted === true,
      snapshot_amount: _num(r.snapshot_amount),
    })),
  };
}

module.exports = { batchSummaries, tabLinks, batchItems, MAX_BATCHES_PER_CALL };
