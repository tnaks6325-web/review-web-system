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

async function hasLinkedWorkboardRow(db, { sheetId, tabName, orderSubmissionId, workboardId }) {
  const linked = await db.query(
    `SELECT 1 FROM campaign_participants
      WHERE sheet_id = $1 AND tab_name = $2
        AND order_submission_id = $3::uuid AND deleted_at IS NULL
        AND workboard_id = $4::uuid
      LIMIT 1`,
    [sheetId, tabName, orderSubmissionId, workboardId]
  );
  return linked.rowCount === 1;
}

async function restoreFailedForMissingLink(db, orderSubmissionId) {
  await db.query(
    `UPDATE order_submissions
        SET mirror_status = 'failed', sheet_row = NULL,
            sheet_error = 'workboard row verification failed', updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
    [orderSubmissionId]
  );
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
  // 이전 워커가 행 기록 뒤, 이 검증 전에 중단될 수 있다. written 상태만으로 큐를 done 처리하면
  // 그 창에서 사라진 행을 영구 누락시키므로 재시도도 반드시 실제 링크를 확인한다.
  if (order.mirror_status === 'written') {
    if (await hasLinkedWorkboardRow(db, { sheetId, tabName, orderSubmissionId, workboardId: target.workboardId })) {
      return { ok: true, noop: 'already_written' };
    }
    await restoreFailedForMissingLink(db, orderSubmissionId);
    throw new Error('작업보드 반영 실패: 이미 완료된 주문의 작업표 행을 확인하지 못했습니다.');
  }
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
  if (out.reason === 'duplicate_row') {
    await markOrderWritten(orderSubmissionId, out.seq || null);
    return { ok: true, ...out, workboardId: target.workboardId };
  }
  // writeOrderToWorktable의 반환값만 믿지 않는다. 큐를 done 처리하기 직전에도 실제 행 링크를
  // 확인한다. 이중 검증으로 INSERT ... DO NOTHING·슬롯 경합이 성공으로 누락되는 것을 막는다.
  const seq = Number(out.seq);
  if (out.written !== true || !Number.isInteger(seq) || seq < 1) {
    throw new Error('작업보드 반영 실패: 기록 완료 행 번호를 확인하지 못했습니다.');
  }
  if (!(await hasLinkedWorkboardRow(db, { sheetId, tabName, orderSubmissionId, workboardId: target.workboardId }))) {
    // write 함수가 먼저 written을 남긴 뒤 행이 사라지는 희귀 경합도 실패로 되돌려 큐 재시도를
    // 가능하게 한다. 성공 상태로 큐를 소진하지 않는다.
    await restoreFailedForMissingLink(db, orderSubmissionId);
    throw new Error('작업보드 반영 실패: 주문과 연결된 작업표 행을 확인하지 못했습니다.');
  }
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
