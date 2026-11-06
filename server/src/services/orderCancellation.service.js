'use strict';
const { _lockKeys } = require('../utils/jobLock');
const { logger } = require('../utils/logger');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidOrder = () => ({ ok: false, code: 'invalid_order_id', error: '유효하지 않은 주문 식별자입니다.' });
const concurrentCancel = () => ({ ok: false, code: 'concurrent_cancel', error: '다른 편집 또는 취소가 진행 중입니다. 다시 시도해 주세요.' });
function scopeRequired() {
  return Object.assign(new Error('동시진행 선행 잠금이 필요합니다. 호출 트랜잭션의 첫 잠금 전에 범위를 준비해 주세요.'), { code: 'dual_lifecycle_scope_required' });
}

// Never acquire a lifecycle lock here: callers may already hold lower-level locks.
// lockedScope must be the actual server-discovered scope, locked by the caller BEFORE those locks.
async function _assertCancellationScope(client, orderSubmissionId, lockedScope, lifecycleTargets = []) {
  const lifecycle = require('./dualChannelLifecycle.service');
  if (!lockedScope) {
    const scope = await lifecycle.discoverDualScope(client, [{ orderSubmissionId }, ...lifecycleTargets]);
    if (scope.campaignIds.length) throw scopeRequired();
    return;
  }
  await lifecycle.assertDualProvenanceUnchanged(client, lockedScope); // includes private WeakSet validation
  const required = [{ orderSubmissionId }, ...lifecycleTargets];
  if (!required.every(t => lockedScope.targets.some(s =>
    Object.keys(t).every(k => String(s[k] ?? '') === String(t[k] ?? ''))))) throw scopeRequired();
}

async function _cancelOrderSubmissionBody(client, { orderSubmissionId, canceledBy = 'admin', beforeCancelCommit, beforeCancelMutation }) {
  const by = String(canceledBy || 'admin').slice(0, 100);
  // Used only by server callers to revalidate selected row/order affinity after all upper locks.
  // Preserve the existing order -> participant row-lock order even for ordinary work.
  if (typeof beforeCancelMutation === 'function') {
    await client.query('SELECT id FROM order_submissions WHERE id=$1::uuid FOR UPDATE', [orderSubmissionId]);
    await beforeCancelMutation(client);
  }
  const { rows } = await client.query(
    `UPDATE order_submissions SET deleted_at=NOW(), canceled_by=$2, updated_at=NOW()
      WHERE id=$1 AND deleted_at IS NULL
      RETURNING sheet_row, mirror_status, sheet_id, tab_name, tab_gid, gid`, [orderSubmissionId, by]);
  if (!rows.length) return { ok: true, alreadyCanceled: true, cleared: false };
  const order = rows[0];
  // Existing callback and cancellation always share the caller's transaction.
  if (typeof beforeCancelCommit === 'function') await beforeCancelCommit(client);
  await client.query(`UPDATE review_reminder_states SET review_status='cancelled', updated_at=NOW()
    WHERE order_submission_id=$1`, [orderSubmissionId]);
  // 결정 271/274: 시트 시절 잔여 큐 행은 기록으로 보존한다. 새 시트 큐는 넣지 않는다.
  const { rows: held } = await client.query(
    `UPDATE campaign_applications
        SET status='cancelled', submitted_at=NULL, order_submission_id=NULL
      WHERE order_submission_id=$1::uuid AND status='submitted'
      RETURNING id, campaign_id`, [orderSubmissionId]);
  await client.query(`UPDATE campaign_applications SET late_order_id=NULL
    WHERE late_order_id=$1::uuid AND status <> 'submitted'`, [orderSubmissionId]);
  // The immutable purchase_bundle_application_id UNIQUE key remains on the canceled parent.
  const written = !!(order.sheet_row && order.mirror_status === 'written');
  if (written) {
    await client.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
  } else {
    await client.query(`DELETE FROM sheet_row_claims WHERE order_id=$1::uuid`, [orderSubmissionId]);
    await client.query(`UPDATE order_submissions SET mirror_status='canceled' WHERE id=$1`, [orderSubmissionId]);
  }
  return { ok: true, cleared: false, campaignSeatReleased: held[0] && held[0].campaign_id || null };
}

/** InTx owns no BEGIN/COMMIT/ROLLBACK/release or SSE. Caller commits, then publishes once.
 * Same advisory keys as the legacy session job lock; xact lifetime fences the whole caller Tx.
 * Caller contract: lifecycle -> order job lock -> row/resource locks. Never call after a lower lock.
 */
async function cancelOrderSubmissionInTx(client, args = {}, { lockedScope, lifecycleTargets = [] } = {}) {
  if (!UUID_RE.test(String(args.orderSubmissionId || ''))) return invalidOrder();
  await _assertCancellationScope(client, args.orderSubmissionId, lockedScope, lifecycleTargets);
  const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1, $2) AS ok', _lockKeys(`order_ledger:${args.orderSubmissionId}`));
  if (!rows[0] || rows[0].ok !== true) return concurrentCancel();
  return _cancelOrderSubmissionBody(client, args);
}

function publishOrderCancellationAfterCommit(orderSubmissionId, out) {
  if (!out || !out.ok || out.alreadyCanceled) return;
  require('../utils/sse').emitOrderLedger({ action: 'canceled', orderSubmissionId });
  if (out.campaignSeatReleased) logger.info(`[order-cancel] 캠페인 확정 반환: camp=${out.campaignSeatReleased}`);
}

// Standalone wrapper: lifecycle first, legacy session job lock second, mutation on the SAME client.
async function cancelOrderSubmission({ orderSubmissionId, canceledBy = 'admin', beforeCancelCommit,
  beforeCancelMutation, pool, lifecycleTargets = [] } = {}) {
  if (!UUID_RE.test(String(orderSubmissionId || ''))) return invalidOrder();
  const db = pool || require('../db/pool');
  const lifecycle = require('./dualChannelLifecycle.service');
  // Missing order was historically an idempotent no-op, not a scope-retry error.
  const { rows: exists } = await db.query('SELECT id FROM order_submissions WHERE id=$1::uuid', [orderSubmissionId]);
  if (!exists.length) return { ok: true, alreadyCanceled: true, cleared: false };
  const scope = await lifecycle.discoverDualScope(db, [{ orderSubmissionId }, ...lifecycleTargets]);
  const client = await db.connect();
  const keys = _lockKeys(`order_ledger:${orderSubmissionId}`);
  let jobLocked = false, destroyError, out;
  try {
    await client.query('BEGIN');
    await lifecycle.lockDualScopeInTx(client, scope);
    await lifecycle.assertDualProvenanceUnchanged(client, scope);
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', keys);
    jobLocked = !!(rows[0] && rows[0].ok === true);
    if (!jobLocked) {
      await client.query('ROLLBACK');
      return concurrentCancel();
    }
    out = await _cancelOrderSubmissionBody(client, { orderSubmissionId, canceledBy, beforeCancelCommit, beforeCancelMutation });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally {
    if (jobLocked) {
      try { await client.query('SELECT pg_advisory_unlock($1, $2)', keys); }
      catch (err) {
        destroyError = err;
        logger.warn(`[order-cancel] job lock unlock 실패 → 연결 폐기: ${err.message}`);
      }
    }
    client.release(destroyError);
  }
  publishOrderCancellationAfterCommit(orderSubmissionId, out);
  return out;
}

module.exports = { cancelOrderSubmission, cancelOrderSubmissionInTx, publishOrderCancellationAfterCommit };
