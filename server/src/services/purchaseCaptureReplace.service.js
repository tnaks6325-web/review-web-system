'use strict';
/**
 * purchaseCaptureReplace.service.js — 작업보드 [🛒 구매캡처 교체] (사용자 확정 2026-09-30)
 *
 * 리뷰어가 처음 올린 구매캡처가 바뀌었을 때(주문 변경·다른 화면 첨부 등) 직원이 작업보드에서
 * 새 사진으로 갈아끼운다. 캡처가 아예 없는 주문에는 새로 올린다.
 *
 * ★★ 줄 → 주문 짝짓기는 제출물 미리보기(`trackB.reviewImagesForTab`)와 **같은 규칙**이다:
 *   `order_submissions.sheet_row = 작업표 seq` + (탭 좌표 주문 ∪ 연결 공고 `campaign:<id>` 좌표 주문).
 *   `campaign_participants.order_submission_id` 링크는 오염 사례가 있어 **단독 근거로 쓰지 않고**,
 *   후보가 여럿일 때 고르는 보조로만 쓴다. 그래도 하나로 못 좁히면 **거부**(남의 주문 캡처를 바꾸지 않는다).
 * ★★ 교체 직전 값 대조(`expectFileId`) — 팝오버를 연 뒤 리뷰어가 올렸거나 다른 직원이 바꿨으면
 *   업로드 전에 거부하고, 업로드 뒤 DB 확정 순간에도 한 번 더 본다(그 사이 바뀌면 새 파일은 휴지통).
 * ★ DB 확정은 리뷰어 업로드(`purchaseSubmissionSession.completeCapture`)와 **같은 advisory lock 키**로
 *   직렬화한다 — 두 경로가 같은 주문 캡처를 동시에 쓰지 않는다.
 * ★ 옛 사진은 **드라이브 휴지통**(30일 복구)으로 — 영구삭제 API 금지. 다른 주문·리뷰 원장이 같은
 *   파일을 가리키거나 확인이 실패하면 **지우지 않는다**(fail-closed).
 * ★ 쓰기 표면 = `order_submissions.capture_file_id·capture_uploaded_at·updated_at` + 작업 로그 1행.
 *   작업표·정원·입금·구글시트 무접촉.
 */
const pool = require('../db/pool');
const driveService = require('./drive.service');
const captureFolder = require('./captureFolder.service');
const { logger } = require('../utils/logger');

let _testPool = null;
function _db() { return _testPool || pool; }
function __setPoolForTest(db) { _testPool = db || null; }

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const LOCK_PREFIX = 'purchase_capture:';   // purchaseSubmissionSession.completeCapture 와 같은 키

const { tableOrderNumSql, MIN_ORDER_NUM_DIGITS } = require('../utils/tableOrderNum');
// ★★ 줄 → 주문 판정은 제출물 미리보기와 같은 함수(utils/rowOrderMatch 단일 출처).
const { orderMatchesRow, pickRowOrder } = require('../utils/rowOrderMatch');
const _digits = v => String(v == null ? '' : v).replace(/\D/g, '');

/** 그 작업표 줄의 주문(구매양식) 하나를 찾는다. 읽기 전용.
 *  후보 = (줄 번호 일치 ∪ 줄의 주문 링크 ∪ 표 주문번호 일치) — 탭 좌표 또는 연결 공고 좌표 주문만.
 *  그중 **이 줄 사람의 주문으로 확인된 것**만 남기고, 하나로 좁혀질 때만 쓴다. */
async function resolveRowOrder(db, { sheetId, tabName, rowId }) {
  const { rows: pr } = await db.query(
    `SELECT cp.id, cp.seq, cp.order_submission_id, cp.reviewer_name, cp.recipient_name, cp.phone8,
            ${tableOrderNumSql('cp')} AS table_order_num
       FROM campaign_participants cp
      WHERE cp.id=$1 AND cp.sheet_id=$2 AND cp.tab_name=$3 AND cp.deleted_at IS NULL`,
    [rowId, sheetId, tabName]);
  if (!pr.length) return { ok: false, error: 'row_not_found' };
  const p = pr[0];
  const { rows: tc } = await db.query(
    `SELECT COALESCE(tab_gid,'') AS gid FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`,
    [sheetId, tabName]);
  const gid = (tc[0] && tc[0].gid) || '';
  const tnum = _digits(p.table_order_num);
  const { rows: cands } = await db.query(
    `SELECT os.id, os.capture_file_id, os.recipient, os.orderer, os.phone, os.order_num
       FROM order_submissions os
      WHERE os.deleted_at IS NULL
        AND ((os.sheet_id = $1 AND os.tab_name = $2)
          OR EXISTS (SELECT 1 FROM recruit_campaigns rc
                      WHERE os.sheet_id = 'campaign:' || rc.id AND os.tab_name = 'campaign:' || rc.id
                        AND rc.linked_sheet_id = $1
                        AND (rc.linked_tab_name = $2 OR ($4 <> '' AND rc.linked_tab_gid = $4))))
        AND (os.sheet_row = $3
          OR ($5::uuid IS NOT NULL AND os.id = $5::uuid)
          OR ($6 <> '' AND regexp_replace(COALESCE(os.order_num,''), '\\D', '', 'g') = $6))
      ORDER BY os.submitted_at
      LIMIT 20`,
    [sheetId, tabName, p.seq, gid, p.order_submission_id || null, tnum.length >= MIN_ORDER_NUM_DIGITS ? tnum : '']);
  const picked = pickRowOrder(p, cands);
  if (!picked.order) return { ok: false, error: picked.error, participant: p };
  const order = picked.order;
  return { ok: true, participant: p, order };
}

/** 팝오버를 열 때 — 지금 붙어 있는 캡처와 이름. 쓰기 0. */
async function previewReplace({ sheetId, tabName, rowId }) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  const r = await resolveRowOrder(_db(), { sheetId, tabName, rowId });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    orderSubmissionId: r.order.id,
    currentFileId: r.order.capture_file_id || '',
    name: r.order.recipient || r.order.orderer || r.participant.reviewer_name || '',
  };
}

function _decode(imageBase64) {
  const s = String(imageBase64 || '').replace(/^data:[^,]*,/, '');
  if (!s || !/^[A-Za-z0-9+/=\s]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  return buf.length ? { b64: s, bytes: buf.length } : null;
}

/** 옛 파일을 다른 곳이 쓰고 있지 않은지 확인. 확인 실패 = 쓰는 것으로 간주(지우지 않는다). */
async function _oldFileStillUsed(db, fileId, orderId) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM order_submissions WHERE capture_file_id=$1 AND id<>$2 AND deleted_at IS NULL
       UNION ALL
       SELECT 1 FROM review_submissions WHERE file_id=$1
       LIMIT 1`, [fileId, orderId]);
    return rows.length > 0;
  } catch (_) { return true; }
}

async function replaceCapture({ sheetId, tabName, rowId, imageBase64, mimeType, expectFileId, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  const mime = String(mimeType || 'image/jpeg').toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/.test(mime)) return { ok: false, error: 'not_image' };
  const img = _decode(imageBase64);
  if (!img) return { ok: false, error: 'not_image' };
  if (img.bytes > MAX_IMAGE_BYTES) return { ok: false, error: 'too_large' };

  const db = _db();
  const r = await resolveRowOrder(db, { sheetId, tabName, rowId });
  if (!r.ok) return { ok: false, error: r.error };
  const orderId = r.order.id;
  const before = String(r.order.capture_file_id || '');
  if (String(expectFileId || '') !== before) return { ok: false, error: 'capture_changed' };

  const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) return { ok: false, error: 'drive_not_configured' };
  const folder = await captureFolder.resolveCaptureFolder({ sheetId, tabName, rootFolderId });

  const who = String(r.order.recipient || r.order.orderer || r.participant.reviewer_name || '주문캡처')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 40) || '주문캡처';
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
  const fileName = `${who}_교체__${String(orderId).slice(0, 8)}_${Date.now().toString(36)}.${ext}`;
  const uploaded = await driveService.uploadFileBase64(img.b64, fileName, mime, folder.folderId);

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [LOCK_PREFIX + orderId]);
    const { rows } = await client.query(
      `SELECT capture_file_id FROM order_submissions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [orderId]);
    if (!rows.length || String(rows[0].capture_file_id || '') !== before) {
      await client.query('ROLLBACK');
    } else {
      await client.query(
        `UPDATE order_submissions
            SET capture_file_id=$2, capture_uploaded_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND deleted_at IS NULL`, [orderId, uploaded.id]);
      await client.query('COMMIT');
      committed = true;
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    try { await driveService.trashFiles([{ id: uploaded.id, name: uploaded.name }]); } catch (_) { /* noop */ }
    throw e;
  } finally {
    if (client !== db && typeof client.release === 'function') client.release();
  }
  if (!committed) {
    // 그 사이 캡처가 바뀌었다 — 방금 올린 파일만 치우고 알린다(남의 변경을 덮지 않는다).
    try { await driveService.trashFiles([{ id: uploaded.id, name: uploaded.name }]); } catch (_) { /* noop */ }
    return { ok: false, error: 'capture_changed' };
  }

  // 커밋 뒤 후처리 — 실패해도 교체를 되돌리지 않는다.
  let oldTrashed = false, oldKept = '';
  if (before && before !== uploaded.id) {
    if (await _oldFileStillUsed(db, before, orderId)) oldKept = 'in_use';
    else {
      try {
        const t = await driveService.trashFiles([{ id: before, name: '' }]);
        oldTrashed = !!(t && t.success);
        if (!oldTrashed) oldKept = 'trash_failed';
      } catch (e) { oldKept = 'trash_failed'; logger.warn(`[capture-replace] 옛 캡처 휴지통 이동 실패: ${e.message}`); }
    }
  }
  try {
    await require('./reviewerEventLog.service').logReviewerEvent({
      sheetId, tabName,
      reviewerName: r.participant.reviewer_name || r.order.recipient || '',
      eventType: 'capture_replaced', severity: 'info', resolved: true,
      orderSubmissionId: orderId,
      message: before ? `구매캡처를 새 사진으로 교체했습니다 (${String(by).slice(0, 40)})`
                      : `구매캡처를 직원이 올렸습니다 (${String(by).slice(0, 40)})`,
      context: { rowIndex: r.participant.seq, oldFileId: before || null, newFileId: uploaded.id, by: String(by).slice(0, 100), oldTrashed },
    });
  } catch (e) { logger.warn(`[capture-replace] 작업 로그 기록 실패(무시): ${e.message}`); }

  return { ok: true, fileId: uploaded.id, oldFileId: before || null, replaced: !!before, oldTrashed, oldKept };
}

module.exports = { resolveRowOrder, orderMatchesRow, previewReplace, replaceCapture, MAX_IMAGE_BYTES, __setPoolForTest };
