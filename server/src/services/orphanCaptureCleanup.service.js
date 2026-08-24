/**
 * orphanCaptureCleanup.service.js — 고아 캡처 자동 정리 (A종류: 링크 끊김)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 왜 있나
 *   행 삭제·구매기록 취소(`orderCancellation.service`)와 작업 통째 삭제
 *   (`workTabDelete.service`)는 **Drive 파일을 한 번도 건드리지 않는다**(실측 확인:
 *   두 경로 모두 Drive 참조 0). 그래서 지울수록 "폴더엔 캡처가 있는데 화면엔
 *   리뷰 이미지 미등록"인 고아 파일이 계속 쌓이는데, 이를 치우는 자동 경로가
 *   **어디에도 없었다**(중복 정리 도구는 SHA-256 지문이 같은 사본만 잡는다).
 *
 * ★★ 판정 근거는 **file_id / review_index_id 뿐** — 위치키(row_index) 금지.
 *   `review_submissions.row_index` 는 위치키라 번호 정리·재배정·차수 변경으로
 *   수시로 깨진다. 그것을 고아 근거로 쓰면 **멀쩡한 캡처를 지운다**. 여기서
 *   위치키는 사람이 읽을 표시용으로만 싣고 판정에는 한 번도 쓰지 않는다.
 *
 * ★★ 세 종류를 다루되 **자동은 A 하나뿐이다**(2026-08-24 확장).
 *   · A 링크 끊김  — 근거가 DB에 남아 있다 → **크론 자동**(`trashOrphanCaptures`)
 *   · C 작업 소멸  — `workTabDelete` 가 지우기 직전에 남긴 **묘비**(migration 134)가 근거
 *                    → **사람이 실행**(`trashTombstonedCaptures`). 크론은 부르지 않는다.
 *   · B 원장 없음  — Drive 폴더를 읽어야 알 수 있다 → **사람이 파일을 골라야만** 실행
 *                    (`trashFolderOrphans`, `fileIds` 필수).
 *     ★★★ B 에는 "업로드는 됐는데 원장 기록만 실패한 **정상 캡처**"가 섞인다.
 *         일괄 삭제를 열어 두면 리뷰어가 낸 증빙이 통째로 날아간다(완화 금지).
 *
 * ★★ 삭제는 휴지통(`trashFiles`)만 — 영구삭제 API 금지(30일 복구창).
 *   `fileRoute.service.js` 의 규율을 그대로 따르고, 원장 표기도 같은 칸을 쓴다
 *   (`slot_key='trashed'` + `routed_from_slot`/`routed_at`/`routed_by`) — 사본을
 *   두면 "자동 정리분만 되돌리기가 안 되는" 드리프트가 생긴다.
 *
 * ★ fail-closed — 아래 제외 조건 중 하나라도 못 세면 그 파일은 후보에서 빠진다
 *   (모르면 건드리지 않는다). `sheetlessOrphanCleanup` 과 같은 규율.
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';

const { logger } = require('../utils/logger');

let _pool = null;
function _db() { return _pool || (_pool = require('../db/pool')); }
function __setPoolForTest(p) { _pool = p || null; }

let _drive = null;
function _driveService() { return _drive || (_drive = require('./drive.service')); }
function __setDriveForTest(d) { _drive = d || null; }

/** 유예 일수 — 업로드 직후의 파일은 기록 경로가 아직 진행 중일 수 있다. */
const DEFAULT_GRACE_DAYS = 7;
function graceDays() {
  const raw = parseInt(process.env.ORPHAN_CAPTURE_GRACE_DAYS || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 365) : DEFAULT_GRACE_DAYS;
}

/** 한 번에 처리할 상한 — 사고 시 폭발반경 제한. */
function runCap() {
  const raw = parseInt(process.env.ORPHAN_CAPTURE_CLEAN_CAP || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 1000) : 200;
}

/* ── 후보 조회 (읽기 전용 — 쓰기 쿼리 0) ─────────────────────────────────
 *
 * 고아 근거(둘 중 하나, OR):
 *   A-1 구매캡처: 이 파일을 붙들고 있던 주문이 **취소**됐다
 *        (`order_submissions.capture_file_id = rs.file_id AND deleted_at IS NOT NULL`)
 *   A-2 리뷰캡처: 결정적으로 매칭돼 있던 명단 행이 **사라졌다**
 *        (`rs.review_index_id` 가 가리키는 `review_index` 행이 없다)
 *      ★ `review_index_id` 는 032 주석대로 "결정적 매칭 시에만" 채워지므로
 *        NULL 인 행은 근거가 없다 = 후보 아님(추측으로 지우지 않는다).
 *
 * 제외(전부 AND NOT — 하나라도 걸리면 후보 아님):
 *   ㉮ 이미 휴지통 처리된 파일                       (`slot_key = 'trashed'`)
 *   ㉯ 유예 기간이 안 지난 파일                       (업로드 시각 기준)
 *   ㉰ **살아있는 주문**이 이 파일을 참조             ← 같은 파일이 다른 주문에 재사용될 수 있다
 *   ㉱ **살아있는 명단 행**이 이 파일을 대표로 참조   (`review_index.review_file_id`)
 *   ㉲ 리뷰검수 이력이 있다                           ← 사람이 이미 본 파일
 *   ㉳ 리뷰 수정요청에 걸려 있다(old/new 양쪽)        ← 진행 중인 분쟁 증거
 *   ㉴ 그 좌표에 **활성 작업표 줄**이 있다            ← 표시용 좌표가 아니라 "아직 쓰이는 작업"인지 확인
 */
function candidateSql({ oneFile = false } = {}) {
  return `
  SELECT rs.file_id      AS "fileId",
         rs.file_name    AS "fileName",
         rs.sheet_id     AS "sheetId",
         rs.tab_name     AS "tabName",
         rs.row_index    AS "rowIndex",
         rs.reviewer_name AS "reviewerName",
         rs.slot_key     AS "slotKey",
         COALESCE(rs.uploaded_at, rs.created_at) AS "uploadedAt",
         CASE WHEN EXISTS (SELECT 1 FROM order_submissions oc
                            WHERE oc.capture_file_id = rs.file_id
                              AND oc.deleted_at IS NOT NULL)
              THEN 'order_canceled' ELSE 'index_row_gone' END AS reason
    FROM review_submissions rs
   WHERE COALESCE(rs.slot_key, '') <> 'trashed'
     AND COALESCE(rs.uploaded_at, rs.created_at) < NOW() - ($1 || ' days')::interval
     AND (
           EXISTS (SELECT 1 FROM order_submissions oc
                    WHERE oc.capture_file_id = rs.file_id
                      AND oc.deleted_at IS NOT NULL)
        OR (rs.review_index_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM review_index ri WHERE ri.id = rs.review_index_id))
         )
     AND NOT EXISTS (SELECT 1 FROM order_submissions ol
                      WHERE ol.capture_file_id = rs.file_id AND ol.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM review_index rl
                      WHERE rl.review_file_id = rs.file_id)
     AND NOT EXISTS (SELECT 1 FROM review_inspections ins
                      WHERE ins.file_id = rs.file_id)
     AND NOT EXISTS (SELECT 1 FROM review_edit_requests er
                      WHERE er.old_file_id = rs.file_id OR er.new_file_id = rs.file_id)
     AND NOT EXISTS (SELECT 1 FROM campaign_participants cp
                      WHERE cp.sheet_id = rs.sheet_id AND cp.tab_name = rs.tab_name
                        AND cp.row_index = rs.row_index
                        AND cp.deleted_at IS NULL AND cp.active = TRUE)
     ${oneFile ? 'AND rs.file_id = $3' : ''}
   ORDER BY COALESCE(rs.uploaded_at, rs.created_at) ASC
   LIMIT $2`;
}

/**
 * 고아 캡처 후보 조회 — 쓰기 0.
 * @returns {Promise<{ok:boolean, total:number, graceDays:number, truncated:boolean, items:Array}>}
 */
async function findOrphanCaptures({ limit = null } = {}) {
  const g = graceDays();
  const lim = Math.min(Math.max(parseInt(limit, 10) || runCap(), 1), 1000);
  const { rows } = await _db().query(candidateSql(), [String(g), lim]);
  return {
    ok: true,
    total: rows.length,
    graceDays: g,
    truncated: rows.length >= lim,
    items: rows.map(r => ({
      fileId: r.fileId,
      fileName: r.fileName || r.fileId,
      sheetId: r.sheetId,
      tabName: r.tabName,
      // ★ 표시용 좌표 — 판정에는 쓰지 않는다(위치키 금지 규율).
      rowIndex: r.rowIndex == null ? null : Number(r.rowIndex),
      reviewerName: r.reviewerName || '',
      slotKey: r.slotKey || 'review',
      uploadedAt: r.uploadedAt,
      reason: r.reason,
    })),
  };
}

/* ── 실행 — 후보를 **서버가 다시 골라** 그 중에서만 휴지통으로 보낸다 ───────── */

/**
 * @param {object}   o
 * @param {boolean}  [o.dryRun=true]   기본 미리보기(Drive·DB 쓰기 0)
 * @param {string[]} [o.fileIds]       지정하면 그 파일만(후보와의 **교집합**) — 미지정 = 후보 전부
 * @param {string}   [o.by]            감사 표기
 */
async function trashOrphanCaptures({ dryRun = true, fileIds = null, by = 'cron' } = {}) {
  const found = await findOrphanCaptures({ limit: runCap() });
  let items = found.items;
  if (Array.isArray(fileIds) && fileIds.length) {
    const want = new Set(fileIds.map(String));
    // ★ 교집합 — 화면이 보낸 목록을 믿지 않는다. 후보 밖 파일은 절대 지우지 않는다.
    items = items.filter(it => want.has(it.fileId));
  }
  const base = { ok: true, graceDays: found.graceDays, total: items.length, items };
  if (dryRun) return { ...base, dryRun: true };
  if (!items.length) return { ...base, dryRun: false, trashed: 0, failed: 0 };

  const drive = _driveService();
  const stamp = String(by || 'cron').slice(0, 80);
  let trashed = 0, failed = 0, skippedRecheck = 0;
  const errors = [];

  for (const it of items) {
    /* ★★ TOCTOU — 조회 직후 그 파일이 다시 쓰이기 시작했을 수 있다(재링크·수정요청·검수).
       휴지통으로 보내기 **직전에** 같은 조건으로 그 한 건을 다시 확인한다. */
    const { rows: still } = await _db().query(
      candidateSql({ oneFile: true }), [String(found.graceDays), 1, it.fileId]);
    if (!still.length) { skippedRecheck++; continue; }

    let moved = false;
    try {
      const r = await drive.trashFiles([{ id: it.fileId, name: it.fileName }]);
      moved = !!(r && r.success > 0);
      if (!moved) errors.push({ fileId: it.fileId, error: (r && r.errors && r.errors[0] && r.errors[0].error) || 'trash_failed' });
    } catch (err) {
      errors.push({ fileId: it.fileId, error: err.message });
    }
    if (!moved) { failed++; continue; }

    /* 원장 표기 — 휴지통 이동이 성공한 뒤에만. 실패해도 파일은 이미 휴지통이므로
       다음 회차에 후보에서 빠지지 않는다(= 재시도로 수렴, 조용한 유실 없음). */
    try {
      await _db().query(
        `UPDATE review_submissions
            SET routed_from_slot = COALESCE(routed_from_slot, slot_key),
                slot_key = 'trashed', routed_at = NOW(), routed_by = $2
          WHERE file_id = $1`, [it.fileId, 'orphan:' + stamp]);
    } catch (err) {
      logger.warn(`[orphanCapture] 원장 표기 실패(파일은 휴지통 이동됨) ${it.fileId}: ${err.message}`);
    }
    trashed++;
  }

  return { ...base, dryRun: false, trashed, failed, skippedRecheck, errors };
}


/* ═══════════════════════════════════════════════════════════════════════
   C종류 — 작업이 통째로 삭제돼 원장이 사라진 캡처 (묘비 기준, migration 134)

   `workTabDelete` 가 지우기 **직전에** 남긴 좌표를 읽는다. 원장이 없으므로
   A종류의 판정(주문 취소·명단 행 소멸)은 애초에 성립하지 않는다 — 여기서는
   "그 작업이 사람 손으로 삭제됐다"는 사실 자체가 근거다.

   ★★ **자동으로 지우지 않는다**(사용자 확정 2026-08-21: B·C는 수동).
     크론은 A종류만 돌린다. 여기는 사람이 목록을 보고 실행하는 창구다.
   ★ 유예는 A와 같은 값을 쓴다 — 작업을 지운 직후 되돌리는 일이 있다.
   ═══════════════════════════════════════════════════════════════════════ */
const TOMB_SQL = `
  SELECT t.file_id AS "fileId", COALESCE(t.file_name, t.file_id) AS "fileName",
         t.sheet_id AS "sheetId", t.tab_name AS "tabName",
         t.reviewer_name AS "reviewerName", t.slot_key AS "slotKey",
         t.recorded_at AS "uploadedAt", 'work_deleted' AS reason
    FROM orphan_capture_tombstones t
   WHERE t.resolved_at IS NULL
     AND t.recorded_at < NOW() - ($1 || ' days')::interval
     /* ★ 그 사이 같은 파일이 다시 원장에 등록됐으면 대상이 아니다(작업 재생성·재업로드). */
     AND NOT EXISTS (SELECT 1 FROM review_submissions rs
                      WHERE rs.file_id = t.file_id AND COALESCE(rs.slot_key,'') <> 'trashed')
     AND NOT EXISTS (SELECT 1 FROM order_submissions os
                      WHERE os.capture_file_id = t.file_id AND os.deleted_at IS NULL)
   ORDER BY t.recorded_at ASC
   LIMIT $2`;

/** C종류 후보 조회 — 쓰기 0. */
async function findTombstonedCaptures({ limit = null } = {}) {
  const g = graceDays();
  const lim = Math.min(Math.max(parseInt(limit, 10) || runCap(), 1), 1000);
  const { rows } = await _db().query(TOMB_SQL, [String(g), lim]);
  return {
    ok: true, kind: 'tombstoned', total: rows.length, graceDays: g,
    truncated: rows.length >= lim,
    items: rows.map(r => ({
      fileId: r.fileId, fileName: r.fileName, sheetId: r.sheetId, tabName: r.tabName,
      reviewerName: r.reviewerName || '', slotKey: r.slotKey || 'review',
      uploadedAt: r.uploadedAt, reason: r.reason,
    })),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   B종류 — 폴더엔 있는데 원장 어디에도 없는 파일 (Drive 스캔, 작업 하나 단위)

   ★★★ **자동 금지 · 사람 확인 필수(완화 금지)**: 여기 잡히는 파일에는
     "업로드는 됐는데 원장 기록만 실패한 **정상 캡처**"가 섞인다. 그것을 지우면
     리뷰어가 낸 증빙이 사라진다. 그래서 이 경로는 크론이 절대 부르지 않고,
     실행도 **사람이 고른 파일만**(`fileIds` 필수) 처리한다.
   ★ 읽기 전용 스캔 — Drive 목록 조회 + DB 참조 확인뿐이다.
   ═══════════════════════════════════════════════════════════════════════ */

/** 이 작업의 [리뷰]·[구매캡처] 폴더에서 원장에 없는 파일을 찾는다(읽기 전용). */
async function scanFolderOrphans({ sheetId, tabName, limit = null } = {}) {
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName 필수' };
  const g = graceDays();
  const lim = Math.min(Math.max(parseInt(limit, 10) || runCap(), 1), 1000);
  const drive = _driveService();

  /* 폴더 해석은 기존 단일 출처를 그대로 쓴다(사본 금지) — 업로드가 파일을 넣는 바로 그 경로. */
  const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || '';
  if (!rootFolderId) return { ok: false, error: 'AI_REVIEW_FOLDER_ID 미설정 — 폴더를 찾을 수 없습니다.' };

  let sheetTitle = '';
  try {
    const { rows } = await _db().query(
      `SELECT COALESCE(NULLIF(campaign_name,''), sheet_id) AS title
         FROM tab_configs WHERE sheet_id=$1 AND tab_name=$2 LIMIT 1`, [sheetId, tabName]);
    sheetTitle = (rows[0] && rows[0].title) || '';
  } catch (_) { /* 아래에서 사유를 말한다 */ }
  if (!sheetTitle) return { ok: false, error: '등록되지 않은 작업입니다.' };

  const files = [];
  for (const kind of ['review', 'capture']) {
    try {
      const f = kind === 'review'
        ? await drive.ensureReviewFolderPath(rootFolderId, sheetTitle, tabName)
        : await drive.ensureCaptureFolderPath(rootFolderId, sheetTitle, tabName);
      if (!f || !f.id) continue;
      const listed = await drive.listFolderContents(f.id, 'image/');
      for (const x of (listed || [])) files.push({ id: x.id, name: x.name, kind, createdTime: x.createdTime });
    } catch (err) {
      /* ★ 한쪽 폴더 조회 실패가 전체를 죽이지 않는다 — 다만 조용히 넘기지 않는다. */
      logger.warn(`[orphanCapture] 폴더 조회 실패 ${tabName}/${kind}: ${err.message}`);
      return { ok: false, error: `폴더 조회 실패(${kind}): ${err.message}` };
    }
  }
  if (!files.length) return { ok: true, kind: 'folder', sheetId, tabName, total: 0, graceDays: g, items: [], scanned: 0 };

  /* 원장 참조 확인 — 한 번에 묻는다(파일당 왕복 금지). */
  const ids = files.map(f => f.id);
  const { rows: known } = await _db().query(
    `SELECT rs.file_id AS id FROM review_submissions rs WHERE rs.file_id = ANY($1::text[])
      UNION
     SELECT os.capture_file_id FROM order_submissions os WHERE os.capture_file_id = ANY($1::text[])
      UNION
     SELECT ri.review_file_id FROM review_index ri WHERE ri.review_file_id = ANY($1::text[])
      UNION
     SELECT t.file_id FROM orphan_capture_tombstones t WHERE t.file_id = ANY($1::text[])`, [ids]);
  const knownSet = new Set(known.map(r => r.id));

  const cutoff = Date.now() - g * 24 * 60 * 60 * 1000;
  const items = files
    .filter(f => !knownSet.has(f.id))
    .filter(f => { const t = Date.parse(f.createdTime || ''); return !Number.isFinite(t) || t < cutoff; })
    .slice(0, lim)
    .map(f => ({
      fileId: f.id, fileName: f.name || f.id, sheetId, tabName,
      reviewerName: '', slotKey: f.kind === 'review' ? 'review' : 'capture',
      uploadedAt: f.createdTime || null, reason: 'no_ledger',
    }));

  return {
    ok: true, kind: 'folder', sheetId, tabName, graceDays: g,
    scanned: files.length, total: items.length, items,
    note: '★ 원장 기록만 실패한 정상 캡처가 섞일 수 있습니다 — 반드시 파일을 열어 확인한 뒤 고르세요.',
  };
}

/** 휴지통 이동 공용 실행부 — A/B/C 가 같은 함수를 쓴다(삭제 메커니즘 사본 금지). */
async function _trashFiles(items, { by = 'admin', markLedger = true } = {}) {
  const drive = _driveService();
  const stamp = String(by || 'admin').slice(0, 80);
  let trashed = 0, failed = 0;
  const errors = [];
  for (const it of items) {
    let moved = false;
    try {
      const r = await drive.trashFiles([{ id: it.fileId, name: it.fileName }]);
      moved = !!(r && r.success > 0);
      if (!moved) errors.push({ fileId: it.fileId, error: (r && r.errors && r.errors[0] && r.errors[0].error) || 'trash_failed' });
    } catch (err) { errors.push({ fileId: it.fileId, error: err.message }); }
    if (!moved) { failed++; continue; }
    if (markLedger) {
      try {
        await _db().query(
          `UPDATE review_submissions
              SET routed_from_slot = COALESCE(routed_from_slot, slot_key),
                  slot_key = 'trashed', routed_at = NOW(), routed_by = $2
            WHERE file_id = $1`, [it.fileId, 'orphan:' + stamp]);
      } catch (err) {
        logger.warn(`[orphanCapture] 원장 표기 실패(파일은 휴지통 이동됨) ${it.fileId}: ${err.message}`);
      }
    }
    /* 묘비가 있으면 처리 표시 — 지우지 않고 시각을 찍는다(무엇을 언제 치웠는지 남긴다). */
    try {
      await _db().query(
        `UPDATE orphan_capture_tombstones SET resolved_at = NOW(), resolved_by = $2
          WHERE file_id = $1 AND resolved_at IS NULL`, [it.fileId, stamp]);
    } catch (_) { /* 묘비 표시 실패는 정리 결과를 바꾸지 않는다 */ }
    trashed++;
  }
  return { trashed, failed, errors };
}

/**
 * C종류 정리 — 사람이 실행한다(크론 금지). 후보는 **서버가 다시 고른다**.
 * @param {string[]} [o.fileIds] 지정하면 그 파일만(후보와의 교집합)
 */
async function trashTombstonedCaptures({ dryRun = true, fileIds = null, by = 'admin' } = {}) {
  const found = await findTombstonedCaptures({ limit: runCap() });
  let items = found.items;
  if (Array.isArray(fileIds) && fileIds.length) {
    const want = new Set(fileIds.map(String));
    items = items.filter(it => want.has(it.fileId));
  }
  const base = { ok: true, kind: 'tombstoned', graceDays: found.graceDays, total: items.length, items };
  if (dryRun) return { ...base, dryRun: true };
  if (!items.length) return { ...base, dryRun: false, trashed: 0, failed: 0 };
  const r = await _trashFiles(items, { by, markLedger: false });
  return { ...base, dryRun: false, ...r };
}

/**
 * B종류 정리 — ★★ **고른 파일만** 처리한다. `fileIds` 없이 부르면 아무것도 지우지 않는다.
 *   "전부 지우기"를 열어 두면 원장 기록만 실패한 정상 캡처가 통째로 날아간다.
 */
async function trashFolderOrphans({ sheetId, tabName, fileIds = null, dryRun = true, by = 'admin' } = {}) {
  const found = await scanFolderOrphans({ sheetId, tabName, limit: runCap() });
  if (!found.ok) return found;
  if (dryRun) return { ...found, dryRun: true };

  if (!Array.isArray(fileIds) || !fileIds.length) {
    return { ...found, dryRun: false, trashed: 0, failed: 0,
      error: 'fileIds 필수 — 폴더 고아는 사람이 고른 파일만 정리합니다(일괄 삭제 없음).' };
  }
  const want = new Set(fileIds.map(String));
  const items = found.items.filter(it => want.has(it.fileId));   // ★ 후보 교집합
  if (!items.length) return { ...found, dryRun: false, trashed: 0, failed: 0 };
  const r = await _trashFiles(items, { by, markLedger: false });
  return { ...found, dryRun: false, ...r };
}

module.exports = {
  findOrphanCaptures,
  trashOrphanCaptures,
  findTombstonedCaptures,
  trashTombstonedCaptures,
  scanFolderOrphans,
  trashFolderOrphans,
  graceDays,
  runCap,
  __setPoolForTest,
  __setDriveForTest,
};
