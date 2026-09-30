'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');

let testPool = null;
function _db() { return testPool || pool; }
function __setPoolForTest(db) { testPool = db || null; }

function _hash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function _ttlHours() {
  const n = parseInt(process.env.PURCHASE_CAPTURE_SESSION_HOURS || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 168 ? n : 24;
}

/**
 * 이미 저장된 주문에 캡처 업로드용 일회성 세션을 발급한다.
 * 같은 주문에 여러 브라우저가 열려도 세션은 독립적이며, 최종 연결은 주문 단위 락으로 한 번만 확정한다.
 */
async function issueForOrder({ orderSubmissionId, captureSheetId = '', captureTabName = '', source = 'order_submit' }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(orderSubmissionId || ''))) {
    const err = new Error('유효한 주문 ID가 필요합니다.'); err.code = 'invalid_order_id'; throw err;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = _hash(token);
  const { rows } = await _db().query(
    `INSERT INTO purchase_submission_sessions
       (order_submission_id, token_hash, capture_sheet_id, capture_tab_name, source, expires_at)
     SELECT os.id, $2, $3, $4, $5, NOW() + ($6 || ' hours')::interval
       FROM order_submissions os
      WHERE os.id = $1 AND os.deleted_at IS NULL
     RETURNING id, order_submission_id AS "orderSubmissionId", expires_at AS "expiresAt"`,
    [orderSubmissionId, tokenHash, String(captureSheetId || ''), String(captureTabName || ''),
      String(source || 'order_submit').slice(0, 40), String(_ttlHours())]
  );
  if (!rows.length) { const err = new Error('주문을 찾을 수 없습니다.'); err.code = 'order_not_found'; throw err; }
  return { id: rows[0].id, token, orderSubmissionId: rows[0].orderSubmissionId, expiresAt: rows[0].expiresAt };
}

async function inspectForUpload({ sessionId, sessionToken, orderSubmissionId }) {
  if (!sessionId || !sessionToken || !orderSubmissionId) {
    return { ok: false, code: 'capture_session_required' };
  }
  const { rows } = await _db().query(
    `SELECT ps.id, ps.status, ps.capture_sheet_id AS "captureSheetId",
            ps.capture_tab_name AS "captureTabName", ps.capture_file_id AS "sessionFileId",
            os.id AS "orderSubmissionId", os.capture_file_id AS "orderFileId"
       FROM purchase_submission_sessions ps
       JOIN order_submissions os ON os.id = ps.order_submission_id
      WHERE ps.id = $1 AND ps.order_submission_id = $2
        AND ps.token_hash = $3 AND ps.expires_at > NOW()
        AND os.deleted_at IS NULL
      LIMIT 1`,
    [sessionId, orderSubmissionId, _hash(sessionToken)]
  );
  if (!rows.length) return { ok: false, code: 'capture_session_invalid' };
  const row = rows[0];
  return {
    ok: true,
    sessionId: row.id,
    orderSubmissionId: row.orderSubmissionId,
    captureSheetId: row.captureSheetId || '',
    captureTabName: row.captureTabName || '',
    alreadyCompleted: !!(row.orderFileId || row.sessionFileId),
    captureFileId: row.orderFileId || row.sessionFileId || '',
  };
}

async function markUploading({ sessionId, orderSubmissionId }) {
  const out = await _db().query(
    `UPDATE purchase_submission_sessions
        SET status='uploading', attempt_count=attempt_count+1, failure_code=NULL,
            expires_at=GREATEST(expires_at, NOW()+INTERVAL '15 minutes'), updated_at=NOW()
      WHERE id=$1 AND order_submission_id=$2 AND expires_at > NOW()
        AND (status <> 'uploading' OR updated_at < NOW()-INTERVAL '5 minutes')
      RETURNING id`,
    [sessionId, orderSubmissionId]
  );
  return !!(out && out.rows && out.rows.length);
}

/** Drive 성공 뒤 DB 연결을 주문 단위로 직렬화한다. 먼저 완료된 캡처가 있으면 덮지 않는다. */
async function completeCapture({ sessionId, sessionToken, orderSubmissionId, captureFileId }) {
  const db = _db();
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`purchase_capture:${orderSubmissionId}`]);
    const { rows } = await client.query(
      `SELECT ps.id, os.capture_file_id AS "orderFileId"
         FROM purchase_submission_sessions ps
         JOIN order_submissions os ON os.id=ps.order_submission_id
        WHERE ps.id=$1 AND ps.order_submission_id=$2 AND ps.token_hash=$3
          AND ps.expires_at > NOW() AND os.deleted_at IS NULL
        FOR UPDATE OF ps, os`,
      [sessionId, orderSubmissionId, _hash(sessionToken)]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return { ok: false, code: 'capture_session_invalid' }; }
    if (rows[0].orderFileId && String(rows[0].orderFileId) !== String(captureFileId)) {
      await client.query('ROLLBACK');
      return { ok: true, alreadyCompleted: true, captureFileId: rows[0].orderFileId };
    }
    await client.query(
      `UPDATE order_submissions
          SET capture_file_id=$2, capture_uploaded_at=COALESCE(capture_uploaded_at,NOW()), updated_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL`,
      [orderSubmissionId, captureFileId]
    );
    await client.query(
      `UPDATE purchase_submission_sessions
          SET status='completed', capture_file_id=$2, failure_code=NULL,
              completed_at=COALESCE(completed_at,NOW()), updated_at=NOW()
        WHERE id=$1`,
      [sessionId, captureFileId]
    );
    await client.query('COMMIT');
    return { ok: true, captureFileId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw err;
  } finally {
    if (client !== db && typeof client.release === 'function') client.release();
  }
}

async function markFailed({ sessionId, orderSubmissionId, code }) {
  try {
    await _db().query(
      `UPDATE purchase_submission_sessions
          SET status='failed', failure_code=$3, updated_at=NOW()
        WHERE id=$1 AND order_submission_id=$2 AND status <> 'completed'`,
      [sessionId, orderSubmissionId, String(code || 'upload_failed').slice(0, 80)]
    );
  } catch (_) { /* 원 실패를 덮지 않는다 */ }
}

module.exports = { issueForOrder, inspectForUpload, markUploading, completeCapture, markFailed, __setPoolForTest, _hash };
