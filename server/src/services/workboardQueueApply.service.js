/**
 * 무시트 구매양식의 새 반영 경로: sync_queue(workboard_apply) → 작업보드 DB.
 *
 * legacy 모드에서는 절대 실행하지 않는다. pilot/enabled 모드에서도 workboard_id가
 * 연결된 작업만 허용해, 아직 이관하지 않은 무시트 작업의 기존 즉시 반영 경로를 보존한다.
 */
'use strict';

const pool = require('../db/pool');
const { _osRowToOrderData, markOrderWritten } = require('./orderLedger.service');

let _pool = null;
function getPool() { return _pool || pool; }
function __setPoolForTest(next) { _pool = next || null; }

function deferred(message) {
  const error = new Error(message);
  error.__defer = true;
  return error;
}

async function resolveQueuedWorkboardTarget({ sheetId, tabName } = {}) {
  if (!sheetId || !tabName) return { enabled: false, reason: 'bad_target' };
  const control = await require('./workboardConsolidation.service').getControl();
  if (control.mode === 'legacy') return { enabled: false, reason: 'legacy' };
  const { rows } = await getPool().query(
    `SELECT tc.workboard_id AS "workboardId", COALESCE(tc.sheetless, FALSE) AS sheetless,
            t.rollout_state AS "rolloutState"
       FROM tab_configs tc
       JOIN workboard_consolidation_targets t
         ON t.sheet_id = tc.sheet_id AND t.tab_name = tc.tab_name AND t.workboard_id = tc.workboard_id
       JOIN workboards w ON w.id = tc.workboard_id AND w.state = 'active'
      WHERE tc.sheet_id = $1 AND tc.tab_name = $2
        AND (($3 = 'pilot' AND t.rollout_state = 'pilot')
          OR ($3 = 'enabled' AND t.rollout_state = 'enabled'))
      LIMIT 1`, [sheetId, tabName, control.mode]
  );
  const tab = rows[0];
  if (!tab) return { enabled: false, reason: 'not_approved_for_mode' };
  if (!tab.sheetless) return { enabled: false, reason: 'not_sheetless' };
  if (!tab.workboardId) return { enabled: false, reason: 'not_mapped' };
  return { enabled: true, workboardId: tab.workboardId, mode: control.mode };
}

async function applyQueuedWorkboardOrder({ sheetId, tabName, tabGid = '', orderSubmissionId, loginPhone8 = '', loginName = '' } = {}) {
  if (!sheetId || !tabName || !orderSubmissionId) throw new Error('payload 누락: sheetId, tabName, orderSubmissionId');
  const target = await resolveQueuedWorkboardTarget({ sheetId, tabName });
  if (!target.enabled) throw deferred(`workboard_apply 보류: ${target.reason}`);

  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, deleted_at, mirror_status, sheet_id, tab_name, tab_gid, gid,
            orderer, recipient, user_id, phone, address, bank, account, depositor,
            price, order_num, memo, date_str, selected_opt_key, selected_product, blog_url,
            workboard_id
       FROM order_submissions WHERE id = $1`, [orderSubmissionId]
  );
  const order = rows[0];
  if (!order || order.deleted_at || order.mirror_status === 'canceled') return { ok: true, noop: 'deleted_or_canceled' };
  if (order.mirror_status === 'written') return { ok: true, noop: 'already_written' };
  if (order.sheet_id !== sheetId || order.tab_name !== tabName) throw new Error('주문과 큐 대상 작업이 일치하지 않습니다.');
  if (order.workboard_id && String(order.workboard_id) !== String(target.workboardId)) {
    throw new Error('주문이 다른 작업보드에 연결돼 있어 반영을 중단했습니다.');
  }

  await db.query(
    `UPDATE order_submissions SET workboard_id = $2, sheet_error = NULL, updated_at = NOW()
      WHERE id = $1 AND workboard_id IS NULL`, [orderSubmissionId, target.workboardId]
  );
  const out = await require('./sheetlessOrder.service').writeOrderToWorktable({
    sheetId, tabName, tabGid: tabGid || order.tab_gid || order.gid || '',
    workboardId: target.workboardId,
    orderData: _osRowToOrderData(order), orderSubmissionId, loginPhone8, loginName,
  });
  if (!out || !out.ok) throw new Error(`작업보드 반영 실패: ${(out && (out.message || out.reason)) || 'unknown'}`);
  // 동일 주문이 이미 반영된 경우도 큐는 수렴 완료다. 새 슬롯을 만들지 않았다는 사실을 남긴다.
  if (out.reason === 'duplicate_row') await markOrderWritten(orderSubmissionId, out.seq || null);
  return { ok: true, ...out, workboardId: target.workboardId };
}

// 전환을 되돌리는 순간 남아 있던 주문을 종전 무시트 경로로 안전하게 마무리한다.
async function applyLegacyRecoveryOrder({ sheetId, tabName, tabGid = '', orderSubmissionId, loginPhone8 = '', loginName = '' } = {}) {
  if (!sheetId || !tabName || !orderSubmissionId) throw new Error('payload 누락: sheetId, tabName, orderSubmissionId');
  const control = await require('./workboardConsolidation.service').getControl();
  if (control.mode !== 'legacy') throw deferred('legacy 복구는 legacy 모드에서만 실행됩니다.');
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, deleted_at, mirror_status, sheet_id, tab_name, tab_gid, gid,
            orderer, recipient, user_id, phone, address, bank, account, depositor,
            price, order_num, memo, date_str, selected_opt_key, selected_product, blog_url
       FROM order_submissions WHERE id = $1`, [orderSubmissionId]
  );
  const order = rows[0];
  if (!order || order.deleted_at || order.mirror_status === 'canceled') return { ok: true, noop: 'deleted_or_canceled' };
  if (order.mirror_status === 'written') return { ok: true, noop: 'already_written' };
  if (order.sheet_id !== sheetId || order.tab_name !== tabName) throw new Error('주문과 복구 대상 작업이 일치하지 않습니다.');
  const out = await require('./sheetlessOrder.service').writeOrderToWorktable({
    sheetId, tabName, tabGid: tabGid || order.tab_gid || order.gid || '',
    orderData: _osRowToOrderData(order), orderSubmissionId, loginPhone8, loginName, recovered: true,
  });
  if (!out || !out.ok) throw new Error(`되돌림 주문 복구 실패: ${(out && (out.message || out.reason)) || 'unknown'}`);
  if (out.reason === 'duplicate_row') await markOrderWritten(orderSubmissionId, out.seq || null);
  return { ok: true, ...out, recoveredFromRollback: true };
}

module.exports = { resolveQueuedWorkboardTarget, applyQueuedWorkboardOrder, applyLegacyRecoveryOrder, __setPoolForTest };
