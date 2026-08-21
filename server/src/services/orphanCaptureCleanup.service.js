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
 * ★★ 대상은 A종류(링크 끊김) 하나뿐이다 — 근거가 DB에 남아 있는 것만 본다.
 *   · B종류(원장에 아예 없는 파일)는 Drive 폴더를 읽어야 알 수 있다 = 범위 밖
 *     (사용자 확정: DB 기준만). 폴더 스캔은 "업로드는 됐는데 기록만 실패한
 *     정상 캡처"를 고아로 오판할 수 있어, 켤 때는 반드시 사람 확인을 거쳐야 한다.
 *   · C종류(작업 통째 삭제)는 `workTabDelete` 가 `review_submissions`·
 *     `order_submissions` 를 **실제 DELETE** 하므로 DB에 흔적이 0 = 탐지 불가.
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

module.exports = {
  findOrphanCaptures,
  trashOrphanCaptures,
  graceDays,
  runCap,
  __setPoolForTest,
  __setDriveForTest,
};
