'use strict';

/**
 * 리뷰검수 확정 중복 자동처리.
 *
 * 후보는 SHA-256 일치만으로 만들지 않는다. 제거본과 보존본이 각각 실제 제출 완료 행에
 * 매핑되어 있고, 보존본이 현재 Drive에 남아 있는지 실행 직전에 다시 확인한다.
 * 같은 리뷰어의 다른 작업, 같은 행 재첨부, 미완료 업로드는 자동처리하지 않는다.
 */
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const VERSION = 'duplicate-auto-v1';
const CONFIRM = 'AUTO_DEDUP_V1';
const PREVIEW_LIMIT = 500;
const EXECUTE_LIMIT = 50;

let _pool;
let _drive;
let _fileRoute;
function _db() { return _pool || require('../db/pool'); }
function _driveSvc() { return _drive || require('./drive.service'); }
function _fileRouteSvc() { return _fileRoute || require('./fileRoute.service'); }

function __setDepsForTest({ pool, drive, fileRoute } = {}) {
  _pool = pool || null;
  _drive = drive || null;
  _fileRoute = fileRoute || null;
}

function _pairKey(pair) {
  return `${String(pair.fileId || '')}\u0000${String(pair.matchFileId || '')}`;
}

function _snapshotToken(pairs) {
  return crypto.createHash('sha256')
    .update([...new Set((pairs || []).map(_pairKey).filter(k => !k.startsWith('\u0000')))].sort().join('\n'))
    .digest('hex');
}

function _cleanPairs(pairs) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const fileId = String(p && p.fileId || '');
    const matchFileId = String(p && p.matchFileId || '');
    const key = `${fileId}\u0000${matchFileId}`;
    if (!fileId || !matchFileId || fileId === matchFileId || seen.has(key)) continue;
    seen.add(key);
    out.push({ fileId, matchFileId });
  }
  return out;
}

const _completedSql = (a) => `
  (${a}.completed_at IS NOT NULL OR ${a}.upload_batch_id IS NULL)
  AND (
    EXISTS (
      SELECT 1 FROM review_index ri_${a}
       WHERE ri_${a}.sheet_id = ${a}.sheet_id AND ri_${a}.tab_name = ${a}.tab_name
         AND ri_${a}.row_index = ${a}.row_index AND ri_${a}.is_submitted = TRUE
    ) OR EXISTS (
      SELECT 1 FROM campaign_participants cp_${a}
       WHERE cp_${a}.sheet_id = ${a}.sheet_id AND cp_${a}.tab_name = ${a}.tab_name
         AND cp_${a}.seq = ${a}.row_index AND cp_${a}.deleted_at IS NULL
         AND cp_${a}.is_submitted = TRUE
    )
  )`;

// 신규 묶음은 실제 제출 완료 시각, 묶음 도입 전 레거시는 업로드 시각을 쓴다.
// 레거시 completed_at은 마이그레이션 실행 시각으로 백필되어 선후 판정 근거로 쓸 수 없다.
const _completionOrderSql = (a) =>
  `CASE WHEN ${a}.upload_batch_id IS NULL THEN ${a}.uploaded_at ELSE ${a}.completed_at END`;

function _candidateQuery({ exact = false, scoped = false, lock = false } = {}) {
  return `SELECT i.file_id,
                 s.file_name, s.sheet_id, s.tab_name, s.row_index, s.reviewer_name,
                 s.file_hash, s.uploaded_at, ${_completionOrderSql('s')} AS completion_order_at,
                 k.file_id AS match_file_id, k.file_name AS match_file_name,
                 k.sheet_id AS match_sheet_id, k.tab_name AS match_tab_name,
                 k.row_index AS match_row_index, k.reviewer_name AS match_reviewer_name,
                 k.uploaded_at AS match_uploaded_at,
                 ${_completionOrderSql('k')} AS match_completion_order_at${lock ? '' : ', COUNT(*) OVER() AS total_count'}
            FROM review_inspections i
            JOIN review_submissions s ON s.file_id = i.file_id
            JOIN review_submissions k
              ON k.file_id = i.checks->'duplicate'->>'matchFileId'
           WHERE i.status IN ('suspect','fail')
             AND i.checks->'duplicate'->>'verdict' = 'fail'
             AND s.file_id <> k.file_id
             AND COALESCE(s.slot_key, 'review') = 'review'
             AND COALESCE(k.slot_key, 'review') = 'review'
             AND s.file_hash IS NOT NULL AND s.file_hash = k.file_hash
             AND ${_completionOrderSql('s')} IS NOT NULL
             AND ${_completionOrderSql('k')} IS NOT NULL
             AND ${_completionOrderSql('s')} > ${_completionOrderSql('k')}
             AND NOT (s.sheet_id = k.sheet_id AND s.tab_name = k.tab_name
                      AND COALESCE(s.row_index, -1) = COALESCE(k.row_index, -1))
             AND (
               (s.sheet_id = k.sheet_id AND s.tab_name = k.tab_name)
               OR (
                 REPLACE(COALESCE(s.reviewer_name, ''), ' ', '') <> ''
                 AND REPLACE(COALESCE(k.reviewer_name, ''), ' ', '') <> ''
                 AND REPLACE(s.reviewer_name, ' ', '') <> REPLACE(k.reviewer_name, ' ', '')
               )
             )
             AND ${_completedSql('s')}
             AND ${_completedSql('k')}
             ${exact ? 'AND s.file_id = $1 AND k.file_id = $2' : ''}
             ${scoped ? 'AND s.sheet_id = $1 AND s.tab_name = $2' : ''}
           ORDER BY ${_completionOrderSql('s')} ASC, s.file_id ASC
           ${lock ? 'LIMIT 1 FOR UPDATE OF s, k' : `LIMIT $${scoped ? 3 : 1}`}`;
}

async function listConfirmedDuplicates({ sheetId, tabName, limit = PREVIEW_LIMIT } = {}) {
  if (!!sheetId !== !!tabName) return { ok: false, error: 'sheetId와 tabName은 함께 지정해야 합니다.' };
  const cap = Math.max(1, Math.min(Number(limit) || PREVIEW_LIMIT, PREVIEW_LIMIT));
  const scoped = !!sheetId;
  const params = scoped ? [sheetId, tabName, cap] : [cap];
  const { rows } = await _db().query(_candidateQuery({ scoped }), params);
  const candidates = (rows || []).map(r => ({
    fileId: r.file_id,
    matchFileId: r.match_file_id,
    sheetId: r.sheet_id,
    tabName: r.tab_name,
    rowIndex: r.row_index,
    reviewerName: r.reviewer_name || '',
    matchTabName: r.match_tab_name,
    matchRowIndex: r.match_row_index,
    matchReviewerName: r.match_reviewer_name || '',
    uploadedAt: r.uploaded_at,
    matchUploadedAt: r.match_uploaded_at,
    completionOrderAt: r.completion_order_at,
    matchCompletionOrderAt: r.match_completion_order_at,
  }));
  const total = rows[0] ? Number(rows[0].total_count) || candidates.length : 0;
  const pairs = candidates.map(c => ({ fileId: c.fileId, matchFileId: c.matchFileId }));
  return {
    ok: true,
    version: VERSION,
    total,
    candidates,
    pairs,
    snapshotToken: _snapshotToken(pairs),
    truncated: total > candidates.length,
    executeLimit: EXECUTE_LIMIT,
  };
}

async function _withTx(fn) {
  const pool = _db();
  if (typeof pool.connect !== 'function') return fn(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

async function _removeOne({ fileId, matchFileId, sheetId, tabName, by } = {}) {
  let event = null;
  let trashedFile = null;
  let result;
  try {
    result = await _withTx(async client => {
      const { rows } = await client.query(_candidateQuery({ exact: true, lock: true }), [fileId, matchFileId]);
      const row = rows[0];
      if (!row) return { ok: false, reason: 'state_changed' };
      if (sheetId && (row.sheet_id !== sheetId || row.tab_name !== tabName)) {
        return { ok: false, reason: 'state_changed' };
      }

      let keepMeta;
      let removeMeta;
      try {
        keepMeta = await _driveSvc().getFileParents(matchFileId);
        removeMeta = await _driveSvc().getFileParents(fileId);
      } catch (e) {
        return { ok: false, reason: 'drive_check_failed', error: String(e.message || e).slice(0, 160) };
      }
      if (!keepMeta || keepMeta.id !== matchFileId || keepMeta.trashed) {
        return { ok: false, reason: 'preserved_file_missing' };
      }
      if (!removeMeta || removeMeta.id !== fileId || removeMeta.trashed) {
        return { ok: false, reason: 'remove_file_missing' };
      }

      const trashed = await _driveSvc().trashFiles([{ id: fileId, name: row.file_name || fileId }]);
      if (!trashed || Number(trashed.success) !== 1 || Number(trashed.failed) !== 0) {
        throw new Error('Drive 휴지통 이동이 완료되지 않았습니다.');
      }
      trashedFile = { id: fileId, name: row.file_name || fileId };

      const upd = await client.query(
        `UPDATE review_submissions
            SET routed_from_slot = COALESCE(routed_from_slot, slot_key), slot_key = 'trashed',
                routed_at = NOW(), routed_by = $2
          WHERE file_id = $1 AND COALESCE(slot_key, 'review') = 'review'`,
        [fileId, `dedup-auto:${VERSION}:${String(by || 'admin').slice(0, 60)}`]
      );
      if (Number(upd.rowCount) !== 1) throw new Error('제거 대상 원장 상태가 실행 중 변경되었습니다.');

      const primary = await _fileRouteSvc().recomputePrimary({
        sheetId: row.sheet_id, tabName: row.tab_name, rowIndex: row.row_index, db: client,
      });
      if (!primary || !primary.ok) throw new Error(primary && primary.error || '대표 이미지 재계산에 실패했습니다.');

      await client.query(
        `UPDATE review_inspections
            SET status = 'resolved', resolution = 'bad', resolved_at = NOW(), resolved_by = $2, updated_at = NOW()
          WHERE file_id = $1 AND status IN ('suspect','fail')`,
        [fileId, `AUTO:${VERSION}:${String(by || 'admin').slice(0, 60)}`]
      );
      event = row;
      return { ok: true, fileId, matchFileId };
    });
  } catch (e) {
    // Drive와 DB는 한 트랜잭션으로 묶을 수 없다. Drive 이동 뒤 DB가 실패하면 즉시 복구해
    // 원장에는 review인데 실제 파일만 휴지통인 반쪽 상태를 남기지 않는다.
    if (trashedFile) {
      try {
        const restored = await _driveSvc().restoreFiles([trashedFile]);
        if (!restored || Number(restored.success) !== 1 || Number(restored.failed) !== 0) {
          logger.error(`[reviewDuplicateAuto] DB 실패 뒤 Drive 복구 미완료(${fileId})`);
        }
      } catch (restoreErr) {
        logger.error(`[reviewDuplicateAuto] DB 실패 뒤 Drive 복구 실패(${fileId}): ${restoreErr.message}`);
      }
    }
    throw e;
  }

  if (result.ok && event) {
    try {
      await _fileRouteSvc().logRouteEvent({
        eventType: 'capture_dup_rejected', severity: 'warn', resolved: true,
        sheetId: event.sheet_id, tabName: event.tab_name, reviewerName: event.reviewer_name,
        message: `${event.reviewer_name || '리뷰어'}님의 ${event.row_index != null ? event.row_index + '행 ' : ''}` +
          `리뷰 캡처(확정 중복)를 자동으로 휴지통 이동했습니다(완료 상태·보존본 재검증 · 30일 복구 가능).`,
        context: { fileId, matchFileId, from: 'review', automatic: true, version: VERSION },
      });
    } catch (e) {
      logger.warn(`[reviewDuplicateAuto] 감사 로그 기록 실패(${fileId}): ${e.message}`);
    }
  }
  return result;
}

async function autoResolveConfirmedDuplicates({ sheetId, tabName, by, dryRun = true, confirm,
  snapshotToken, pairs } = {}) {
  if (dryRun) {
    const preview = await listConfirmedDuplicates({ sheetId, tabName });
    return { ...preview, dryRun: true };
  }

  if (!!sheetId !== !!tabName) return { ok: false, error: 'sheetId와 tabName은 함께 지정해야 합니다.' };

  const confirmedPairs = _cleanPairs(pairs);
  if (!confirmedPairs.length || _snapshotToken(confirmedPairs) !== String(snapshotToken || '')) {
    return { ok: false, error: '확인한 확정 중복 스냅샷이 없거나 일치하지 않습니다.' };
  }
  if (confirm !== CONFIRM) return { ok: false, error: '확정 중복 자동처리 확인값이 필요합니다.' };

  let processed = 0;
  let skipped = 0;
  const reasons = {};
  const errors = [];
  const batch = confirmedPairs.slice(0, EXECUTE_LIMIT);
  for (const pair of batch) {
    try {
      const out = await _removeOne({ ...pair, sheetId, tabName, by });
      if (out && out.ok) processed++;
      else {
        skipped++;
        const reason = out && out.reason || 'state_changed';
        reasons[reason] = (reasons[reason] || 0) + 1;
        if (out && out.error) errors.push({ fileId: pair.fileId, reason, error: out.error });
      }
    } catch (e) {
      skipped++;
      reasons.action_failed = (reasons.action_failed || 0) + 1;
      errors.push({ fileId: pair.fileId, reason: 'action_failed', error: String(e.message || e).slice(0, 160) });
      logger.warn(`[reviewDuplicateAuto] 자동처리 건너뜀(${pair.fileId}): ${e.message}`);
    }
  }
  return {
    ok: true, dryRun: false, version: VERSION,
    requested: confirmedPairs.length, attempted: batch.length, processed, skipped,
    reasons, errors: errors.slice(0, 20), hasMore: confirmedPairs.length > batch.length,
  };
}

module.exports = {
  VERSION, CONFIRM, PREVIEW_LIMIT, EXECUTE_LIMIT,
  listConfirmedDuplicates, autoResolveConfirmedDuplicates,
  __setDepsForTest,
  _snapshotToken,
};
