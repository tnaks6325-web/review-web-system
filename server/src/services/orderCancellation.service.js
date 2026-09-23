const pool = require('../db/pool');
const { withJobLock } = require('../utils/jobLock');
const { logger } = require('../utils/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 주문 취소의 단일 진입점. callback은 같은 DB 트랜잭션 안에서 선택한 Track B 행을 없앨 때만 쓴다.
async function cancelOrderSubmission({ orderSubmissionId, canceledBy = 'admin', beforeCancelCommit } = {}) {
  if (!UUID_RE.test(String(orderSubmissionId || ''))) return { ok: false, code: 'invalid_order_id', error: '유효하지 않은 주문 식별자입니다.' };
  const by = String(canceledBy || 'admin').slice(0, 100);
  const out = await withJobLock(`order_ledger:${orderSubmissionId}`, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE order_submissions SET deleted_at=NOW(), canceled_by=$2, updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL
          RETURNING sheet_row, mirror_status`, [orderSubmissionId, by]);
      if (!rows.length) { await client.query('ROLLBACK'); return { alreadyCanceled: true }; }
      const order = rows[0];

      // 선택한 참여행 제거는 주문 취소와 같은 트랜잭션에 둔다. 실패하면 주문 취소도 롤백한다.
      if (typeof beforeCancelCommit === 'function') await beforeCancelCommit(client);

      await client.query(
        `DELETE FROM sync_queue WHERE status='pending'
           AND type IN ('order_append','order_update','order_cancel')
           AND (payload->>'orderSubmissionId')=$1`, [String(orderSubmissionId)]);
      const { rows: held } = await client.query(
        `UPDATE campaign_applications
            SET status='cancelled', submitted_at=NULL, order_submission_id=NULL
          WHERE order_submission_id=$1::uuid AND status='submitted'
          RETURNING id, campaign_id`, [orderSubmissionId]);
      await client.query(
        `UPDATE campaign_applications SET late_order_id=NULL
          WHERE late_order_id=$1::uuid AND status <> 'submitted'`, [orderSubmissionId]);

      const cleared = !!(order.sheet_row && order.mirror_status === 'written');
      if (cleared) {
        // 취소 원장·선택 행 삭제·시트 클리어 큐를 같은 트랜잭션으로 확정한다.
        // 커밋 뒤 enqueue가 실패해 삭제만 되고 시트 값이 남는 단절을 만들지 않는다.
        await client.query(
          `INSERT INTO sync_queue (type, payload, status, max_retry)
           VALUES ('order_cancel', $1, 'pending', 3)`,
          [JSON.stringify({ orderSubmissionId })]);
      } else {
        await client.query(`DELETE FROM sheet_row_claims WHERE order_id=$1::uuid`, [orderSubmissionId]);
        await client.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
      }
      await client.query('COMMIT');
      return { cleared, campaignSeatReleased: held[0] && held[0].campaign_id || null };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw err;
    } finally { client.release(); }
  });
  if (out && out.skipped) return { ok: false, code: 'concurrent_cancel', error: '다른 편집 또는 취소가 진행 중입니다. 다시 시도해 주세요.' };
  if (out && out.alreadyCanceled) return { ok: true, alreadyCanceled: true, cleared: false };
  if (out && out.cleared) {
    require('../jobs/queuePump').kickQueuePump();
  }
  require('../utils/sse').emitOrderLedger({ action: 'canceled', orderSubmissionId });
  if (out && out.campaignSeatReleased) logger.info(`[order-cancel] 캠페인 확정 반환: camp=${out.campaignSeatReleased}`);
  return { ok: true, cleared: !!(out && out.cleared), campaignSeatReleased: out && out.campaignSeatReleased || null };
}

module.exports = { cancelOrderSubmission };
