function _money(value) { return Number(String(value == null ? '' : value).replace(/[^0-9]/g, '')) || 0; }
function _number(value) { return Number(value) || 0; }

function calculateOrderDeleteImpact(before, row) {
  const current = {
    total: _number(before.total), submitted: _number(before.submitted), paid: _number(before.paid), paymentAmount: _number(before.paymentAmount),
  };
  const after = {
    total: Math.max(0, current.total - 1),
    submitted: Math.max(0, current.submitted - (row.submitted ? 1 : 0)),
    paid: Math.max(0, current.paid - (row.paid ? 1 : 0)),
    paymentAmount: Math.max(0, current.paymentAmount - _money(row.price)),
  };
  return { before: current, after, delta: Object.fromEntries(Object.keys(current).map(k => [k, after[k] - current[k]])) };
}

function _assertArgs({ sheetId, tabName, rowId }) {
  if (!sheetId || !tabName || !rowId) throw new Error('sheetId, tabName, rowId 필수');
}

async function _activeTotals(client, sheetId, tabName) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE cp.is_submitted)::int AS submitted,
            COUNT(*) FILTER (WHERE cp.is_paid)::int AS paid,
            COALESCE(SUM(NULLIF(regexp_replace(COALESCE(os.price,''),'[^0-9]','','g'),'')::numeric),0)::bigint AS "paymentAmount"
       FROM campaign_participants cp
       LEFT JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
      WHERE cp.sheet_id=$1 AND cp.tab_name=$2 AND cp.deleted_at IS NULL AND cp.active=TRUE`,
    [sheetId, tabName]);
  return rows[0] || { total: 0, submitted: 0, paid: 0, paymentAmount: 0 };
}

async function previewWorkdeskOrderDelete({ sheetId, tabName, rowId, pool } = {}) {
  _assertArgs({ sheetId, tabName, rowId });
  const db = pool || require('../db/pool');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT cp.id, cp.seq, cp.reviewer_name AS name, cp.is_submitted AS submitted, cp.is_paid AS paid,
              cp.order_submission_id AS "orderSubmissionId", os.price
         FROM campaign_participants cp
         JOIN order_submissions os ON os.id=cp.order_submission_id AND os.deleted_at IS NULL
        WHERE cp.id=$1 AND cp.sheet_id=$2 AND cp.tab_name=$3 AND cp.deleted_at IS NULL AND cp.active=TRUE
        FOR SHARE`, [rowId, sheetId, tabName]);
    if (!rows.length) { await client.query('ROLLBACK'); return { ok: false, error: 'row_not_found_or_not_order' }; }
    const before = await _activeTotals(client, sheetId, tabName);
    await client.query('COMMIT');
    const row = rows[0];
    return { ok: true, row: { id: row.id, seq: row.seq, name: row.name || '', price: _money(row.price) }, ...calculateOrderDeleteImpact(before, row) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally { client.release(); }
}

async function deleteWorkdeskOrderRow({ sheetId, tabName, rowId, by = 'admin', pool } = {}) {
  _assertArgs({ sheetId, tabName, rowId });
  const db = pool || require('../db/pool');
  const { rows } = await db.query(
    `SELECT order_submission_id AS "orderSubmissionId"
       FROM campaign_participants
      WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL AND active=TRUE AND order_submission_id IS NOT NULL`,
    [rowId, sheetId, tabName]);
  if (!rows.length) return { ok: false, error: 'row_not_found_or_not_order' };
  const orderSubmissionId = rows[0].orderSubmissionId;
  const { cancelOrderSubmission } = require('./orderCancellation.service');
  try {
    const out = await cancelOrderSubmission({
      orderSubmissionId,
      canceledBy: by,
      beforeCancelCommit: async (client) => {
        // 주문 ID까지 다시 대조해, 이름이 같은 다른 행을 지우는 일이 없게 한다.
        const removed = await client.query(
          `UPDATE campaign_participants
              SET deleted_at=NOW(), active=FALSE, updated_at=NOW(), updated_by=$4
            WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND order_submission_id=$5::uuid
              AND deleted_at IS NULL AND active=TRUE`,
          [rowId, sheetId, tabName, String(by || 'admin').slice(0, 100), orderSubmissionId]);
        if (removed.rowCount !== 1) {
          const err = new Error('선택한 행이 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
          err.code = 'row_changed';
          throw err;
        }
      },
    });
    return { ...out, rowId, orderSubmissionId };
  } catch (err) {
    if (err && err.code === 'row_changed') return { ok: false, code: err.code, error: err.message };
    throw err;
  }
}

module.exports = { calculateOrderDeleteImpact, previewWorkdeskOrderDelete, deleteWorkdeskOrderRow };
