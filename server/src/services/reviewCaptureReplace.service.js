'use strict';
/**
 * reviewCaptureReplace.service.js — 작업보드 [🖼 리뷰캡처 교체] (사용자 확정 2026-10-01)
 *
 * 직원이 그 줄의 리뷰캡처 한 장을 새 사진으로 갈아끼운다.
 * 사용자 확정: ① 옛 사진은 **드라이브 휴지통**(30일 복구) ② 여러 장이면 **바꿀 한 장을 골라** 교체
 *   ③ 리뷰어에게 **알리지 않는다** ④ 내부 직원 전원(AE 포함) — 광고주 차단은 라우트가 한다.
 *
 * ★★ DB 포인터 교체는 리뷰어 교체요청 승인(`reviewEdit.routes` /approve)과 **같은 3문장**이다:
 *   review_submissions(제출일 uploaded_at 보존) · review_inspections(새 파일 pending = 다음 스윕이 재검수)
 *   · review_index(대표 이미지가 옛 파일일 때만). 회귀가드가 두 곳의 문장 일치를 고정한다.
 * ★★ 폴더 판정도 승인과 같은 함수(`reviewEdit.routes._resolveFolders`) — 사본 금지.
 * ★ 리뷰어의 **대기 중 교체요청**이 그 줄에 있으면 거부(`pending_edit_request`) — 직원이 먼저 바꾸면
 *   나중 승인이 이미 없는 옛 파일을 찾아 조용히 아무것도 못 바꾼다.
 * ★ 그 사이 바뀜 차단: 고른 옛 파일이 확정 순간에도 그 줄에 있어야 바꾼다(아니면 새 파일 휴지통).
 * ★ 옛 사진은 다른 곳이 가리키면 지우지 않는다(확인 실패도 지우지 않는다 — fail-closed).
 * ★ 옛 사진의 미확인 검수 카드는 닫는다(휴지통 사진이 리뷰검수에 깨진 카드로 남지 않게).
 */
const pool = require('../db/pool');
const driveService = require('./drive.service');
const { logger } = require('../utils/logger');

let _testPool = null;
function _db() { return _testPool || pool; }
function __setPoolForTest(db) { _testPool = db || null; }

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FILE_ID_RE = /^[-\w]{10,}$/;

async function _rowFiles(db, { sheetId, tabName, rowId }) {
  const { rows: pr } = await db.query(
    `SELECT id, seq, reviewer_name, recipient_name
       FROM campaign_participants
      WHERE id=$1 AND sheet_id=$2 AND tab_name=$3 AND deleted_at IS NULL`,
    [rowId, sheetId, tabName]);
  if (!pr.length) return { ok: false, error: 'row_not_found' };
  const p = pr[0];
  if (p.seq == null) return { ok: false, error: 'no_review' };
  const { rows: subs } = await db.query(
    `SELECT file_id, COALESCE(uploaded_at, created_at) AS at
       FROM review_submissions
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND file_id IS NOT NULL
        AND COALESCE(slot_key, 'review') = 'review'
      ORDER BY COALESCE(uploaded_at, created_at) NULLS LAST`,
    [sheetId, tabName, p.seq]);
  const files = subs.map(r => ({ fileId: r.file_id, at: r.at || null }));
  // 원장(032) 이전 과거 행은 대표 이미지(031)만 있다 — 그것도 바꿀 수 있게 목록에 넣는다.
  const { rows: idx } = await db.query(
    `SELECT review_file_id, review_file_at FROM review_index
      WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3 AND review_file_id IS NOT NULL`,
    [sheetId, tabName, p.seq]).catch(() => ({ rows: [] }));
  for (const r of idx) {
    if (!files.some(f => f.fileId === r.review_file_id)) files.push({ fileId: r.review_file_id, at: r.review_file_at || null });
  }
  return { ok: true, participant: p, files };
}

async function _pendingRequest(db, { sheetId, tabName, rowIndex }) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM review_edit_requests
        WHERE sheet_id=$1 AND tab_name=$2 AND row_index=$3
          AND COALESCE(slot_key,'review')='review' AND status='pending' LIMIT 1`,
      [sheetId, tabName, rowIndex]);
    return rows.length > 0;
  } catch (e) {
    if (e && e.code === '42P01') return false;   // 교체요청 표가 없는 환경 = 대기 요청 없음
    throw e;
  }
}

/** 팝오버를 열 때 — 그 줄의 리뷰캡처 목록. 쓰기 0. */
async function previewReviewReplace({ sheetId, tabName, rowId }) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  const db = _db();
  const r = await _rowFiles(db, { sheetId, tabName, rowId });
  if (!r.ok) return { ok: false, error: r.error };
  const pending = await _pendingRequest(db, { sheetId, tabName, rowIndex: r.participant.seq });
  return {
    ok: true,
    name: r.participant.recipient_name || r.participant.reviewer_name || '',
    files: r.files,
    pendingEditRequest: pending,
  };
}

function _decode(imageBase64) {
  const s = String(imageBase64 || '').replace(/^data:[^,]*,/, '');
  if (!s || !/^[A-Za-z0-9+/=\s]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  return buf.length ? { b64: s, bytes: buf.length } : null;
}

async function _oldFileStillUsed(db, fileId) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM review_submissions WHERE file_id=$1
       UNION ALL SELECT 1 FROM review_index WHERE review_file_id=$1
       UNION ALL SELECT 1 FROM order_submissions WHERE capture_file_id=$1 AND deleted_at IS NULL
       LIMIT 1`, [fileId]);
    return rows.length > 0;
  } catch (_) { return true; }
}

async function replaceReviewCapture({ sheetId, tabName, rowId, oldFileId, imageBase64, mimeType, by = 'admin' } = {}) {
  if (!sheetId || !tabName || !rowId) return { ok: false, error: 'bad_request' };
  if (!FILE_ID_RE.test(String(oldFileId || ''))) return { ok: false, error: 'bad_request' };
  const mime = String(mimeType || 'image/jpeg').toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/.test(mime)) return { ok: false, error: 'not_image' };
  const img = _decode(imageBase64);
  if (!img) return { ok: false, error: 'not_image' };
  if (img.bytes > MAX_IMAGE_BYTES) return { ok: false, error: 'too_large' };

  const db = _db();
  const r = await _rowFiles(db, { sheetId, tabName, rowId });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.participant;
  if (!r.files.some(f => f.fileId === oldFileId)) return { ok: false, error: 'capture_changed' };
  if (await _pendingRequest(db, { sheetId, tabName, rowIndex: p.seq })) return { ok: false, error: 'pending_edit_request' };

  const { targetFolderId } = await require('../routes/reviewEdit.routes')._resolveFolders(sheetId, tabName, 'review');
  let owner = '';
  try {
    owner = await require('./captureOwnerName.service').recipientNameForRow({ db, sheetId, tabName, rowIndex: p.seq }) || '';
  } catch (_) { owner = ''; }
  const finalName = driveService.generateReviewFileName(owner || p.recipient_name || p.reviewer_name || '익명', 1, mime);
  const uploaded = await driveService.uploadFileBase64(img.b64, finalName, mime, targetFolderId);
  const finalUrl = uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`;

  const client = typeof db.connect === 'function' ? await db.connect() : db;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`review_file:${sheetId}|${tabName}|${p.seq}`]);
    const { rows: still } = await client.query(
      `SELECT 1 FROM review_submissions WHERE file_id=$1 AND sheet_id=$2 AND tab_name=$3 AND row_index=$4
       UNION ALL
       SELECT 1 FROM review_index WHERE review_file_id=$1 AND sheet_id=$2 AND tab_name=$3 AND row_index=$4
       LIMIT 1`, [oldFileId, sheetId, tabName, p.seq]);
    if (!still.length) {
      await client.query('ROLLBACK');
    } else {
      // ↓ 리뷰어 교체요청 승인(/approve)과 같은 3문장(회귀가드가 일치를 고정).
      await client.query(
        `UPDATE review_submissions
            SET file_id = $1, file_url = $2, file_name = $3, file_hash = NULL
          WHERE file_id = $4 AND sheet_id = $5 AND tab_name = $6 AND row_index = $7`,
        [uploaded.id, finalUrl, finalName, oldFileId, sheetId, tabName, p.seq]);
      await client.query(
        `INSERT INTO review_inspections
           (file_id, sheet_id, tab_name, row_index, reviewer_name, slot_key, status, checks, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,NOW())
         ON CONFLICT (file_id) DO NOTHING`,
        [uploaded.id, sheetId, tabName, p.seq, p.reviewer_name || null, 'review',
          JSON.stringify({ replacement: { verdict: 'skip', reason: 'staff_file_replacement' } })]);
      await client.query(
        `UPDATE review_index
            SET review_file_id = $1, review_file_url = $2, review_file_name = $3
          WHERE sheet_id = $4 AND tab_name = $5 AND row_index = $6 AND review_file_id = $7`,
        [uploaded.id, finalUrl, finalName, sheetId, tabName, p.seq, oldFileId]);
      await client.query(
        `UPDATE review_inspections SET status='resolved', resolved_at=NOW(), resolved_by=$2, updated_at=NOW()
          WHERE file_id=$1 AND status IN ('pending','suspect','fail','unverifiable')`,
        [oldFileId, `replaced:${String(by).slice(0, 80)}`]);
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
    try { await driveService.trashFiles([{ id: uploaded.id, name: uploaded.name }]); } catch (_) { /* noop */ }
    return { ok: false, error: 'capture_changed' };
  }

  let oldTrashed = false, oldKept = '';
  if (await _oldFileStillUsed(db, oldFileId)) oldKept = 'in_use';
  else {
    try {
      const t = await driveService.trashFiles([{ id: oldFileId, name: '' }]);
      oldTrashed = !!(t && t.success);
      if (!oldTrashed) oldKept = 'trash_failed';
    } catch (e) { oldKept = 'trash_failed'; logger.warn(`[review-capture-replace] 옛 사진 휴지통 이동 실패: ${e.message}`); }
  }
  try {
    await require('./reviewerEventLog.service').logReviewerEvent({
      sheetId, tabName, reviewerName: p.reviewer_name || '',
      eventType: 'review_capture_replaced', severity: 'info', resolved: true,
      message: `리뷰캡처를 새 사진으로 교체했습니다 (${String(by).slice(0, 40)})`,
      context: { rowIndex: p.seq, oldFileId, newFileId: uploaded.id, by: String(by).slice(0, 100), oldTrashed },
    });
  } catch (e) { logger.warn(`[review-capture-replace] 작업 로그 기록 실패(무시): ${e.message}`); }
  return { ok: true, fileId: uploaded.id, oldFileId, oldTrashed, oldKept };
}

module.exports = { previewReviewReplace, replaceReviewCapture, MAX_IMAGE_BYTES, __setPoolForTest };
