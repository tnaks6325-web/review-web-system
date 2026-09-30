'use strict';
/**
 * rowOrderMatch.js — "이 작업표 줄의 주문은 무엇인가" 단일 출처 (2026-09-30 운영 실측).
 *
 * ★★ 왜 필요한가: 주문 원장의 `sheet_row` 는 구글시트 시절 줄 번호라, 줄이 재배치된 작업에서는
 *   **다른 사람의 주문**을 가리킨다(마감 작업 1곳에서 구매캡처 있는 57줄 중 36줄). 줄의 주문 링크
 *   (`campaign_participants.order_submission_id`)도 오염 사례가 있다. 그래서 어느 한 값만 믿지 않고,
 *   후보를 모은 뒤 **이 줄 사람의 주문으로 확인된 것**만 쓴다.
 * 소비처 2곳이 같은 함수를 쓴다(사본 금지 — 갈리면 "미리보기는 A 사진인데 교체는 B 주문을 바꾼다"):
 *   ① 제출물 미리보기 구매캡처(`trackB.reviewImagesForTab`)
 *   ② 작업보드 구매캡처 교체(`purchaseCaptureReplace.resolveRowOrder`)
 */
const { MIN_ORDER_NUM_DIGITS } = require('./tableOrderNum');

const digits = v => String(v == null ? '' : v).replace(/\D/g, '');
const normName = v => String(v == null ? '' : v).replace(/\s+/g, '').replace(/\(.*?\)/g, '');

/** row: {table_order_num, phone8, reviewer_name, recipient_name} · order: {order_num, phone, recipient, orderer}
 *  순서: 표 주문번호 ↔ 원장 주문번호(둘 다 6자리 이상이면 이것만으로 판정) → 연락처 뒤 8자리 → 이름.
 *  근거가 없으면 false(모르는 주문을 이 사람 것으로 치지 않는다). */
function orderMatchesRow(row, order) {
  const rowNum = digits(row && row.table_order_num);
  const oNum = digits(order && order.order_num);
  if (rowNum.length >= MIN_ORDER_NUM_DIGITS && oNum.length >= MIN_ORDER_NUM_DIGITS) {
    return rowNum === oNum || rowNum.includes(oNum);
  }
  const rp = digits(row && row.phone8).slice(-8), op = digits(order && order.phone).slice(-8);
  if (rp.length === 8 && op.length === 8) return rp === op;
  const rowNames = [row && row.reviewer_name, row && row.recipient_name].map(normName).filter(Boolean);
  const oNames = [order && order.recipient, order && order.orderer].map(normName).filter(Boolean);
  return rowNames.some(n => oNames.includes(n));
}

/** 후보 주문 중 이 줄의 주문 하나를 고른다.
 *  @returns {{order, error}} error = 'no_order' | 'order_mismatch' | 'ambiguous_order' */
function pickRowOrder(row, candidates) {
  const seen = new Set();
  const cands = (candidates || []).filter(c => c && !seen.has(String(c.id)) && seen.add(String(c.id)));
  if (!cands.length) return { order: null, error: 'no_order' };
  const mine = cands.filter(c => orderMatchesRow(row, c));
  if (!mine.length) return { order: null, error: 'order_mismatch' };
  if (mine.length === 1) return { order: mine[0], error: null };
  const link = row && row.order_submission_id;
  const byLink = link ? mine.find(c => String(c.id) === String(link)) : null;
  return byLink ? { order: byLink, error: null } : { order: null, error: 'ambiguous_order' };
}

/** 줄 목록 × 주문 목록을 한 번에 짝짓는다(미리보기용). 후보 = 줄 번호 ∪ 주문 링크 ∪ 표 주문번호.
 *  @returns Map<seq(string), order> — 확인된 줄만 들어간다. */
function matchRowsToOrders(rows, orders) {
  const bySheetRow = new Map(), byId = new Map(), byNum = new Map();
  const add = (m, k, o) => { if (k == null || k === '') return; const key = String(k); if (!m.has(key)) m.set(key, []); m.get(key).push(o); };
  for (const o of orders || []) {
    add(bySheetRow, o.sheet_row, o);
    byId.set(String(o.id), o);
    const n = digits(o.order_num); if (n.length >= MIN_ORDER_NUM_DIGITS) add(byNum, n, o);
  }
  const out = new Map();
  for (const r of rows || []) {
    if (r == null || r.seq == null) continue;
    const cands = [...(bySheetRow.get(String(r.seq)) || [])];
    if (r.order_submission_id && byId.has(String(r.order_submission_id))) cands.push(byId.get(String(r.order_submission_id)));
    const tn = digits(r.table_order_num);
    if (tn.length >= MIN_ORDER_NUM_DIGITS) cands.push(...(byNum.get(tn) || []));
    const { order } = pickRowOrder(r, cands);
    if (order) out.set(String(r.seq), order);
  }
  return out;
}

module.exports = { orderMatchesRow, pickRowOrder, matchRowsToOrders };
