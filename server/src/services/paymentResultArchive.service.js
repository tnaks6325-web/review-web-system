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

/** KST 기준 'YYYY-MM'(묶음 열쇠) · 'YYYYMMDD_HHmm' · 'YYYYMMDD' · 보관 폴더 경로 ['2026년','10월'] */
function _kst(d) {
  const t = new Date(new Date(d || Date.now()).getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
  const ymd = `${y}${p(m)}${p(t.getUTCDate())}`;
  return { ym: `${y}-${p(m)}`, ymd, stamp: `${ymd}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}`, path: monthPath(y, m) };
}
/* 폴더 이름 규칙(사용자 확정 2026-11-02) — 연도 폴더 아래 월 폴더 하나: `2026년/10월`.
   직원 드라이브의 「26년 10월」(망고)·「26년10월」(만두)·「26.4월」 같은 제각각 이름을 이 하나로 합친다. */
function monthPath(y, m) { return [`${y}년`, `${Number(m)}월`]; }

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
     VALUES ($1, $2, $3, CASE WHEN $3 = 'failed' THEN 1 ELSE 0 END, $4, $5, $6, $7, $8, CASE WHEN $3 = 'done' THEN NOW() END, NOW())
     ON CONFLICT (file_sha256) DO UPDATE SET
       upload_id = EXCLUDED.upload_id, status = EXCLUDED.status,
       -- attempts = 올리기 실패 횟수만(공개 폴더로 막힌 확인은 세지 않는다 — 공유를 고친 뒤 재시도 예산이 남게, Codex P2)
       attempts = payment_result_drive_archive.attempts + CASE WHEN EXCLUDED.status = 'failed' THEN 1 ELSE 0 END,
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
    const { ym, path: mPath } = _kst(c.uploadedAt);
    let folder = null;
    try {
      folder = folderCache.get(ym);
      if (!folder) {
        folder = await _dv().ensureFolderPath(root.rootId, [...root.prefix, ...mPath]);
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
        folder.id, { shareAnyone: false, backupSource: 'payment_result' });
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
       -- 보관 = 리뷰웹 결과 파일(내용) 중 보관 장부에 done 이 있는 것 — 들여오기로 먼저 올린 파일을 나중에 리뷰웹에 놓아도 보관으로 센다(Codex P2)
       (SELECT COUNT(DISTINCT u.file_sha256)::int FROM payment_result_uploads u
          JOIN payment_result_drive_archive d ON d.file_sha256 = u.file_sha256 AND d.status = 'done'
         WHERE u.file_blob IS NOT NULL AND u.file_sha256 IS NOT NULL) AS done,
       COUNT(*) FILTER (WHERE a.status = 'done' AND NOT EXISTS (
         SELECT 1 FROM payment_result_uploads u2 WHERE u2.file_sha256 = a.file_sha256))::int AS legacy,
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
    legacy: Number(s && s.legacy) || 0,   // 리뷰웹 밖에서 들여온 지난 결과 파일(importLegacyFile)
    folderUrl: s && s.root ? `https://drive.google.com/drive/folders/${s.root}` : null,
    lastError: (s && s.last_error) || '',
  };
}

/* ── 지난 결과 파일 들여오기(사용자 확정 2026-11-02) ──
   리뷰웹 이전·밖에서 직원 드라이브에 쌓아 둔 케이뱅크·하나은행 결과 파일을 같은 보관 폴더·같은 이름 규칙으로 올린다.
   ★ 보관 사본일 뿐 — 입금·회차·작업보드는 건드리지 않는다(파일을 해석하는 건 은행 결과 파일인지와 이체 날짜를 알기 위해서뿐).
   ★ 같은 내용(sha256)은 한 번만: 이미 보관했거나 리뷰웹에 있는 파일(그건 cron 이 올린다)은 건너뛴다.
   ★ 은행 결과 파일이 아니면 올리지 않는다(소득 대장 등 성격이 다른 자료가 섞이지 않게). 공개 폴더면 올리지 않는다. */
class ArchiveError extends Error { constructor(code, message) { super(message); this.code = code; } }
const LEGACY_MAX_BYTES = 12 * 1024 * 1024;

/** 들여올 파일의 은행·이체 날짜 — 파일 안 첫 이체일시, 없으면 파일 이름의 YYYYMMDD. */
function legacyFacts(buf, fileName) {
  const { loadSheetAoa } = require('../utils/spreadsheetLoad');
  const { parseResultAoa } = require('../utils/paymentResultParse');
  const loaded = loadSheetAoa(buf, fileName || '');
  const parsed = loaded.ok && parseResultAoa(loaded.aoa);
  if (!parsed || !parsed.ok) return { ok: false, error: (parsed && parsed.error) || loaded.error || '은행 이체결과 파일이 아닙니다.' };
  const first = (parsed.rows.find(r => r.transferredAtIso) || {}).transferredAtIso;
  let at = first ? Date.parse(first) : NaN;
  if (!Number.isFinite(at)) {
    const m = String(fileName || '').split('/').pop().match(/(20\d{2})(\d{2})(\d{2})/);
    if (m) at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00+09:00`);
  }
  if (!Number.isFinite(at)) return { ok: false, error: '이체 날짜를 알 수 없습니다(파일 안 이체일시·파일 이름 날짜 모두 없음).' };
  return { ok: true, bank: parsed.bank, at, rows: parsed.rows.length };
}

async function importLegacyFile({ fileName, base64 } = {}) {
  if (!enabled()) throw new ArchiveError('disabled', '드라이브 보관이 꺼져 있습니다.');
  const root = _root();
  if (!root) throw new ArchiveError('no_folder', '보관 폴더 설정이 없습니다.');
  const orig = String(fileName || '').split('/').pop();
  if (!orig || typeof base64 !== 'string' || !base64) throw new ArchiveError('bad_request', '파일 이름과 내용을 보내 주세요.');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new ArchiveError('bad_request', '빈 파일입니다.');
  if (buf.length > LEGACY_MAX_BYTES) throw new ArchiveError('too_large', '파일이 너무 큽니다(12MB 초과).');
  const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
  const facts = legacyFacts(buf, fileName);
  if (!facts.ok) throw new ArchiveError('not_result', facts.error);
  const client = await _db().connect();
  try {
    await client.query('BEGIN');
    // ★ cron 보관(withJobLock 'payment_result_drive_archive')과 같은 열쇠를 기다려 잡는다 — 들여오기끼리·cron 과
    //   동시에 같은 연도/월 폴더를 두 번 만들지 않게(ensureFolderPath 는 찾고 없으면 만든다 · Codex P2). cron 은 이 동안 양보한다.
    const [k1, k2] = require('../utils/jobLock')._lockKeys('payment_result_drive_archive');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
    const { rows: [had] } = await client.query(
      `SELECT status, drive_name FROM payment_result_drive_archive WHERE file_sha256 = $1`, [sha]);
    if (had && had.status === 'done') { await client.query('ROLLBACK'); return { ok: true, result: 'duplicate', name: had.drive_name }; }
    const { rows: [inRw] } = await client.query(
      `SELECT 1 FROM payment_result_uploads
        WHERE file_blob IS NOT NULL AND COALESCE(file_sha256, encode(sha256(file_blob), 'hex')) = $1 LIMIT 1`, [sha]);
    if (inRw) { await client.query('ROLLBACK'); return { ok: true, result: 'in_reviewweb' }; }
    const k = _kst(facts.at);
    const folder = await _dv().ensureFolderPath(root.rootId, [...root.prefix, ...k.path]);
    const privacy = await _folderPrivacy(folder.id);
    if (privacy !== 'private') {
      throw new ArchiveError(privacy === 'public' ? 'blocked' : 'privacy_unknown', privacy === 'public'
        ? '보관 폴더가 링크 공개 상태라 올리지 않았습니다 — 드라이브에서 폴더 공유를 「제한됨」으로 바꿔 주세요'
        : '보관 폴더 공유 상태를 확인하지 못해 올리지 않았습니다');
    }
    const safe = orig.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || '이체결과.xls';
    const name = `${k.ymd}_${BANK_LABEL[facts.bank] || facts.bank}_${safe}`.slice(0, 200);
    const up = await _dv().uploadFileBase64(base64, name, _mime(orig), folder.id, { shareAnyone: false, backupSource: 'payment_result' });
    const top = root.prefix.length ? await _dv().findFolderPath(root.rootId, root.prefix).catch(() => null) : { id: root.rootId };
    await client.query(
      `INSERT INTO payment_result_drive_archive
         (file_sha256, upload_id, status, attempts, drive_file_id, drive_folder_id, root_folder_id, drive_name, last_error, archived_at, updated_at)
       VALUES ($1, NULL, 'done', 0, $2, $3, $4, $5, '', NOW(), NOW())
       ON CONFLICT (file_sha256) DO UPDATE SET status = 'done', drive_file_id = EXCLUDED.drive_file_id,
         drive_folder_id = EXCLUDED.drive_folder_id, root_folder_id = COALESCE(EXCLUDED.root_folder_id, payment_result_drive_archive.root_folder_id),
         drive_name = EXCLUDED.drive_name, last_error = '', archived_at = NOW(), updated_at = NOW()`,
      [sha, (up && up.id) || null, folder.id, (top && top.id) || null, name]);
    await client.query('COMMIT');
    return { ok: true, result: 'uploaded', name, folder: k.path.join('/'), bank: facts.bank };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 이미 끝남 */ }
    throw e;
  } finally { client.release(); }
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

module.exports = { archivePending, status, kickSoon, driveName, enabled, monthPath, legacyFacts, importLegacyFile, ArchiveError,
  PRIVATE_PREFIX, __setPoolForTest, __setDriveForTest };
