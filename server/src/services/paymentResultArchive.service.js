/**
 * paymentResultArchive.service — 이체결과 파일을 구글 드라이브 내부 폴더에 쌓는다(결정 316).
 *
 * ★ 보관 사본일 뿐이다 — 반영·입금 기록은 종전대로 `paymentResult.autoApplyResultFile` 하나(결정 309).
 *   원본은 이미 `payment_result_uploads.file_blob`(109)에 있으므로 여기서 실패해도 잃는 것이 없다.
 *   그래서 결과 파일을 놓는 요청 안에서 올리지 않는다 — cron(10분)과 놓은 직후 한 번(kickSoon)이 뒤에서 올린다.
 * ★ 같은 파일을 여러 번 놓으면 업로드 표에는 줄이 여럿 생긴다 → 드라이브에는 **sha256 하나에 한 번**.
 * ★★ 결과 파일에는 리뷰어 이름·계좌 전체가 있다 — 공개 링크를 만들지 않고(shareAnyone:false),
 *   올릴 폴더에 '링크가 있는 누구나'·도메인 권한이 걸려 있으면 **올리지 않는다**(blocked, 권한을 모르면 실패 처리).
 *   업체에 공개되는 [리뷰]·[구매캡처] 트리와 섞이지 않게 `[내부전용-대량이체결과]` 아래에 둔다(현금영수증과 같은 방식).
 * ★ `payment.service.js` 에 넣지 않는다 — 그 파일은 Drive 호출 금지 가드가 있다(tests/paymentBatch.test.js).
 */
'use strict';
const { logger } = require('../utils/logger');

let _pool = null;
function _db() { if (!_pool) _pool = require('../db/pool'); return _pool; }
function __setPoolForTest(p) { _pool = p || null; }
let _drive = null;
function _dv() { if (!_drive) _drive = require('./drive.service'); return _drive; }
function __setDriveForTest(d) { _drive = d || null; }

const PRIVATE_PREFIX = '[내부전용-대량이체결과]';
const BATCH_PER_RUN = 10;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MIN = 30;
const BANK_LABEL = { kbank: '케이뱅크', hana: '하나은행' };
const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
};

function enabled() { return process.env.PAYMENT_RESULT_DRIVE !== '0'; }

/** 보관 루트 — 전용 폴더 지정(PAYMENT_RESULT_FOLDER_ID)이 있으면 그 폴더, 없으면 리뷰웹 드라이브 루트 아래 내부전용 폴더. */
function _root() {
  const own = process.env.PAYMENT_RESULT_FOLDER_ID || '';
  if (own) return { rootId: own, prefix: [] };
  const base = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || '';
  return base ? { rootId: base, prefix: [PRIVATE_PREFIX] } : null;
}

/** KST 기준 'YYYY-MM' · 'YYYYMMDD_HHmm' */
function _kst(d) {
  const t = new Date(new Date(d || Date.now()).getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const ym = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}`;
  return { ym, stamp: `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}` };
}

/** 드라이브 파일명 — `20261102_1430_#89_케이뱅크_<원래 이름>` (원래 이름이 없으면 '이체결과.xlsx') */
function driveName({ uploadedAt, seq, bank, fileName }) {
  const { stamp } = _kst(uploadedAt);
  const orig = String(fileName || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || '이체결과.xlsx';
  const seqPart = seq != null && seq !== '' ? `#${seq}_` : '';
  return `${stamp}_${seqPart}${BANK_LABEL[bank] || bank || '은행'}_${orig}`.slice(0, 200);
}
function _mime(fileName) {
  const ext = (String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  return MIME[ext] || 'application/octet-stream';
}

/** 아직 드라이브에 없는 파일(sha 기준) — 반영된 줄을 대표로(회차 번호가 맞는 줄), 오래된 순. */
async function _candidates(limit) {
  const { rows } = await _db().query(
    `SELECT * FROM (
       SELECT DISTINCT ON (u.file_sha256)
              u.id, u.file_sha256 AS sha, u.file_name AS "fileName", u.uploaded_at AS "uploadedAt",
              u.bank, b.seq
         FROM payment_result_uploads u
         LEFT JOIN payment_batches b ON b.id = u.batch_id
         LEFT JOIN payment_result_drive_archive a ON a.file_sha256 = u.file_sha256
        WHERE u.file_blob IS NOT NULL AND u.file_sha256 IS NOT NULL
          AND (a.file_sha256 IS NULL
               OR (a.updated_at < NOW() - make_interval(mins => $3)
                   AND (a.status = 'blocked' OR (a.status = 'failed' AND a.attempts < $2))))
        ORDER BY u.file_sha256, u.applied DESC, u.uploaded_at ASC
     ) c ORDER BY c."uploadedAt" ASC LIMIT $1`,
    [limit, MAX_ATTEMPTS, RETRY_AFTER_MIN]);
  return rows;
}

async function _mark(sha, uploadId, fields) {
  await _db().query(
    `INSERT INTO payment_result_drive_archive
       (file_sha256, upload_id, status, attempts, drive_file_id, drive_folder_id, root_folder_id, drive_name, last_error, archived_at, updated_at)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, CASE WHEN $3 = 'done' THEN NOW() END, NOW())
     ON CONFLICT (file_sha256) DO UPDATE SET
       upload_id = EXCLUDED.upload_id, status = EXCLUDED.status,
       attempts = payment_result_drive_archive.attempts + 1,
       drive_file_id = COALESCE(EXCLUDED.drive_file_id, payment_result_drive_archive.drive_file_id),
       drive_folder_id = COALESCE(EXCLUDED.drive_folder_id, payment_result_drive_archive.drive_folder_id),
       root_folder_id = COALESCE(EXCLUDED.root_folder_id, payment_result_drive_archive.root_folder_id),
       drive_name = EXCLUDED.drive_name, last_error = EXCLUDED.last_error,
       archived_at = COALESCE(EXCLUDED.archived_at, payment_result_drive_archive.archived_at),
       updated_at = NOW()
     WHERE payment_result_drive_archive.status <> 'done'`,
    [sha, uploadId || null, fields.status, fields.driveFileId || null, fields.folderId || null,
      fields.rootFolderId || null, fields.name || '', String(fields.error || '').slice(0, 500)]);
}

/** 이 폴더가 공개(anyone·domain)면 'public', 확인 못 하면 'unknown', 아니면 'private'. */
async function _folderPrivacy(folderId) {
  const types = await _dv().listPermissionTypes(folderId);
  if (!Array.isArray(types)) return 'unknown';
  return types.some(t => t === 'anyone' || t === 'domain') ? 'public' : 'private';
}

/**
 * 아직 안 올린 결과 파일을 최대 limit 개 올린다. 실패는 그 파일만 'failed'(30분 뒤 다시, 5번까지).
 * 폴더가 공개 상태면 그 파일을 'blocked' 로 남기고 이번 회차를 멈춘다(사람이 폴더 공유를 고쳐야 한다).
 */
async function archivePending({ limit = BATCH_PER_RUN } = {}) {
  if (!enabled()) return { ran: false, reason: 'disabled' };
  const root = _root();
  if (!root) return { ran: false, reason: 'no_folder' };
  const list = await _candidates(limit);
  const out = { ran: true, done: 0, failed: 0, blocked: 0, total: list.length };
  const folderCache = new Map();
  for (const c of list) {
    const name = driveName(c);
    const { ym } = _kst(c.uploadedAt);
    let folder = null;
    try {
      folder = folderCache.get(ym);
      if (!folder) {
        folder = await _dv().ensureFolderPath(root.rootId, [...root.prefix, ym]);
        folder.privacy = await _folderPrivacy(folder.id);
        folderCache.set(ym, folder);
      }
      if (folder.privacy !== 'private') {
        const why = folder.privacy === 'public'
          ? '보관 폴더가 링크 공개 상태라 올리지 않았습니다 — 드라이브에서 폴더 공유를 「제한됨」으로 바꿔 주세요'
          : '보관 폴더 공유 상태를 확인하지 못해 올리지 않았습니다';
        await _mark(c.sha, c.id, { status: folder.privacy === 'public' ? 'blocked' : 'failed', name, folderId: folder.id, error: why });
        out[folder.privacy === 'public' ? 'blocked' : 'failed']++;
        logger.warn(`[ResultArchive] ${why} (folder=${folder.id})`);
        break;
      }
      const { rows: [blob] } = await _db().query(
        'SELECT file_blob FROM payment_result_uploads WHERE id = $1', [c.id]);
      if (!blob || !blob.file_blob) throw new Error('원본 파일이 없습니다');
      const up = await _dv().uploadFileBase64(Buffer.from(blob.file_blob).toString('base64'), name, _mime(c.fileName),
        folder.id, { shareAnyone: false });
      await _mark(c.sha, c.id, { status: 'done', driveFileId: up && up.id, folderId: folder.id,
        rootFolderId: null, name });
      out.done++;
    } catch (e) {
      out.failed++;
      logger.warn(`[ResultArchive] 올리기 실패(반영은 그대로) ${name}: ${e.message}`);
      try { await _mark(c.sha, c.id, { status: 'failed', name, folderId: folder && folder.id, error: e.message }); }
      catch (e2) { logger.warn(`[ResultArchive] 실패 기록도 못 남김: ${e2.message}`); }
    }
  }
  // 보관함 링크용 — 루트(내부전용 폴더) 위치를 한 번 기록해 둔다(만들지 않고 찾기만)
  if (out.done) {
    try {
      const top = root.prefix.length ? await _dv().findFolderPath(root.rootId, root.prefix) : { id: root.rootId };
      if (top && top.id) {
        await _db().query(
          `UPDATE payment_result_drive_archive SET root_folder_id = $1
            WHERE status = 'done' AND root_folder_id IS DISTINCT FROM $1`, [top.id]);
      }
    } catch (e) { logger.warn(`[ResultArchive] 보관함 위치 기록 실패(무시): ${e.message}`); }
  }
  return out;
}

/** 입금관리 표시용 — 보관 몇 개 · 기다리는 것 · 막힘 · 보관함 링크. 조회 실패는 null(화면은 그 줄만 숨긴다). */
async function status() {
  if (!enabled()) return { enabled: false };
  const { rows: [s] } = await _db().query(
    `SELECT
       (SELECT COUNT(DISTINCT u.file_sha256)::int FROM payment_result_uploads u
         WHERE u.file_blob IS NOT NULL AND u.file_sha256 IS NOT NULL) AS files,
       COUNT(*) FILTER (WHERE a.status = 'done')::int AS done,
       COUNT(*) FILTER (WHERE a.status = 'blocked')::int AS blocked,
       COUNT(*) FILTER (WHERE a.status = 'failed' AND a.attempts >= $1)::int AS gave_up,
       (SELECT root_folder_id FROM payment_result_drive_archive
         WHERE status = 'done' AND root_folder_id IS NOT NULL ORDER BY archived_at DESC LIMIT 1) AS root,
       (SELECT last_error FROM payment_result_drive_archive
         WHERE status <> 'done' AND last_error <> '' ORDER BY updated_at DESC LIMIT 1) AS last_error
     FROM payment_result_drive_archive a`, [MAX_ATTEMPTS]);
  const files = Number(s && s.files) || 0, done = Number(s && s.done) || 0;
  return {
    enabled: !!_root(),
    files, done, waiting: Math.max(0, files - done),
    blocked: Number(s && s.blocked) || 0, gaveUp: Number(s && s.gave_up) || 0,
    folderUrl: s && s.root ? `https://drive.google.com/drive/folders/${s.root}` : null,
    lastError: (s && s.last_error) || '',
  };
}

/* 결과 파일을 놓은 직후 한 번 — 응답을 기다리게 하지 않는다(10초 뒤, 같은 잠금으로 cron 과 겹치지 않음). */
let _kickTimer = null;
function kickSoon() {
  if (!enabled() || _kickTimer) return;
  _kickTimer = setTimeout(async () => {
    _kickTimer = null;
    try {
      const { withJobLock } = require('../utils/jobLock');
      await withJobLock('payment_result_drive_archive', () => archivePending());
    } catch (e) { logger.warn(`[ResultArchive] 바로 올리기 실패(cron 이 다시 함): ${e.message}`); }
  }, 10 * 1000);
  if (_kickTimer.unref) _kickTimer.unref();
}

module.exports = { archivePending, status, kickSoon, driveName, enabled, PRIVATE_PREFIX, __setPoolForTest, __setDriveForTest };
