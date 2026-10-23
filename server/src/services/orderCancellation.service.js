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
          RETURNING sheet_row, mirror_status, sheet_id, tab_name, tab_gid, gid`, [orderSubmissionId, by]);
      if (!rows.length) { await client.query('ROLLBACK'); return { alreadyCanceled: true }; }
      const order = rows[0];

      // 선택한 참여행 제거는 주문 취소와 같은 트랜잭션에 둔다. 실패하면 주문 취소도 롤백한다.
      if (typeof beforeCancelCommit === 'function') await beforeCancelCommit(client);

      await client.query(`UPDATE review_reminder_states SET review_status='cancelled', updated_at=NOW()
        WHERE order_submission_id=$1`, [orderSubmissionId]);

      // (종전: 이 주문의 pending order_append·order_update·order_cancel 큐 행 삭제 — 결정 274 로 그 타입은 실행부가 없어
      //  어떤 워커도 집지 않는다. 남은 행은 기록으로 둔다 — 지우지 않는다.)
      const { rows: held } = await client.query(
        `UPDATE campaign_applications
            SET status='cancelled', submitted_at=NULL, order_submission_id=NULL
          WHERE order_submission_id=$1::uuid AND status='submitted'
          RETURNING id, campaign_id`, [orderSubmissionId]);
      await client.query(
        `UPDATE campaign_applications SET late_order_id=NULL
          WHERE late_order_id=$1::uuid AND status <> 'submitted'`, [orderSubmissionId]);

      const written = !!(order.sheet_row && order.mirror_status === 'written');
      /* ★★ 결정 271 → 274 — 반영된(written) 주문의 취소는 **어느 탭이든** 큐를 거치지 않고
         시트 비우기가 성공했을 때 남던 상태 그대로(mirror_status='canceled', 점유 기록 sheet_row_claims 보존 — R13)를 바로 남긴다.
         271 은 무시트 좌표만 이렇게 했고 시트 기반 탭은 order_cancel 을 넣었다. 274 로 시트 쓰기 실행부를 지웠고
         남은 시트 탭은 작업보드가 원본이라(사용자 결정 2026-10-23) 같은 길로 합쳤다 — 판정(isSheetlessOrderCoord)도 필요 없다. */
      if (written) {
        await client.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
      } else {
        await client.query(`DELETE FROM sheet_row_claims WHERE order_id=$1::uuid`, [orderSubmissionId]);
        await client.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
      }
      await client.query('COMMIT');
      return { cleared: false, campaignSeatReleased: held[0] && held[0].campaign_id || null };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw err;
    } finally { client.release(); }
  });
  if (out && out.skipped) return { ok: false, code: 'concurrent_cancel', error: '다른 편집 또는 취소가 진행 중입니다. 다시 시도해 주세요.' };
  if (out && out.alreadyCanceled) return { ok: true, alreadyCanceled: true, cleared: false };
  require('../utils/sse').emitOrderLedger({ action: 'canceled', orderSubmissionId });
  if (out && out.campaignSeatReleased) logger.info(`[order-cancel] 캠페인 확정 반환: camp=${out.campaignSeatReleased}`);
  // cleared = "시트 주문값을 비우는 중"(큐) — 결정 274 이후 언제나 false(작업보드 문구가 "구매기록을 취소하고 제거"가 된다).
  return { ok: true, cleared: false, campaignSeatReleased: out && out.campaignSeatReleased || null };
}

module.exports = { cancelOrderSubmission };
