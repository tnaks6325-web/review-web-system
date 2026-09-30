/**
 * intranetMemo.service.js — 인트라넷 "보낸 오더" 카드 처리메모 push (공용 실행부)
 *
 * ★★ 사본 금지 — 처리메모 전송(`/admin/send-memo`) · 관리자 수정 알림(`/admin/edit`) ·
 *   작업 삭제 알림(`workTabDelete`)이 **같은 함수**를 쓴다. 사본을 두면 한쪽만 타임아웃·헤더가
 *   달라지고, 인트라넷 수신부는 payload 모양 하나만 안다.
 *
 * 인트라넷은 이 payload 를 `review_order_memos` 로 받아 "보낸 오더" 카드의 주황 처리메모
 * 블록에 표시한다(수신부 무변경).
 *
 * ★ fail-soft — 절대 throw 하지 않는다(호출측 저장·삭제는 이미 끝났거나 별개다).
 * 필요 env: INTRANET_MEMO_WEBHOOK_URL · INTRANET_WEBHOOK_KEY
 */
'use strict';

const { logger } = require('../utils/logger');

async function pushIntranetMemo(o, memo, sentBy, sentAt) {
  let delivered = false, deliverError = null;
  const hook = process.env.INTRANET_MEMO_WEBHOOK_URL;
  if (!hook) return { delivered: false, deliverError: 'webhook 미설정' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Key': process.env.INTRANET_WEBHOOK_KEY || '' },
      body: JSON.stringify({
        order_id: o.id, title: o.title, requester_name: o.created_by, status: o.status,
        memo, sent_by: sentBy, sent_at: sentAt,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    delivered = resp.ok;
    if (!resp.ok) deliverError = 'HTTP ' + resp.status;
  } catch (e) {
    deliverError = e.message;
    logger.warn(`[intranetMemo] webhook 실패: ${e.message}`);
  }
  return { delivered, deliverError };
}

/**
 * memo_log 누적(최근 100건) — 실패해도 호출측을 죽이지 않는다.
 * @param {object} db  pool 또는 client
 */
async function appendMemoLog(db, orderId, entry) {
  try {
    const { rows } = await db.query(`SELECT memo_log FROM work_orders WHERE id = $1`, [orderId]);
    let log = [];
    try { const p = JSON.parse((rows[0] || {}).memo_log || '[]'); if (Array.isArray(p)) log = p; } catch (_) {}
    log.push(entry);
    if (log.length > 100) log = log.slice(-100);
    await db.query(`UPDATE work_orders SET memo_log = $2 WHERE id = $1`, [orderId, JSON.stringify(log)]);
    return true;
  } catch (e) {
    logger.warn(`[intranetMemo] memo_log 기록 실패: ${e.message}`);
    return false;
  }
}

module.exports = { pushIntranetMemo, appendMemoLog };
