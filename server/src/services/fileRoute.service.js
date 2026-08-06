/**
 * fileRoute.service.js — 제출 이미지 자동 분류·이동(파일 라우팅) 실행부.
 *
 * 판정 규칙은 utils/captureRoute.js(전이표·모드) 단일 출처 — 여기는 실행만 한다:
 *   대상 폴더 해석 → 중복 검사(SHA-256) → Drive 이동/휴지통 → 원장(slot_key·이동이력) 갱신
 *   → 대표 이미지 재계산 → 관리자 알림. 배선: diag.routes /review-upload(실시간) ·
 *   trackB.routes /file-route/sweep(소급 정리) · /reviewer-logs/route-revert(되돌리기).
 *
 * ★★ 반려·삭제의 유일한 근거 = findSlotDuplicate 의 SHA-256 정확 일치.
 *    AI 판정만으로 파일을 지우거나 제출을 거절하는 코드는 이 파일에 없다(완화 금지).
 * ★★ 삭제는 휴지통(trashFiles)만 — 영구삭제 API 를 쓰지 않는다(30일 복구창).
 * ★ 전부 fail-soft: 라우팅의 어떤 실패도 업로드·제출을 죽이지 않는다(호출부 try/catch 이중).
 */
const { logger } = require('../utils/logger');
const { routeDecision, routeMode, rejectEnabled, routeSlotLabel } = require('../utils/captureRoute');

let _pool;
function _db() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(p) { _pool = p || null; }

/* ── 중복 판정 (반려의 유일한 근거) ─────────────────────────────────────
 * "같은 행·같은 리뷰어의 **대상 슬롯**에 같은 SHA-256 지문의 **다른 파일**이 이미 있음"
 * = 한 파일을 두 칸에 넣은 것. ★ 2차 검수 findDuplicate(다른 사람·다른 자리 대조)와
 * 스코프가 정반대라 재사용하지 않는다 — 합치면 정상 재제출이 반려된다.
 * 판정 불가(해시·행 없음·쿼리 실패)는 전부 null = 중복 아님(fail-open).
 */
async function findSlotDuplicate({ sheetId, tabName, rowIndex, reviewerName, toSlot, fileHash, fileId } = {}) {
  if (!fileHash || rowIndex == null || rowIndex === '') return null;
  try {
    const { rows } = await _db().query(
      `SELECT file_id, file_name, uploaded_at FROM review_submissions
        WHERE file_hash = $1 AND slot_key = $2
          AND sheet_id = $3 AND tab_name = $4
          AND COALESCE(row_index, -1) = COALESCE($5::int, -1)
          AND COALESCE(reviewer_name, '') = COALESCE($6, '')
          AND file_id <> COALESCE($7, '')
        ORDER BY uploaded_at ASC NULLS LAST
        LIMIT 1`,
      [fileHash, toSlot, sheetId, tabName, rowIndex ?? null, reviewerName || '', fileId || null]
    );
    return rows[0] || null;
  } catch (e) {
    logger.warn(`[fileRoute] 중복 대조 실패(중복 아님 처리): ${e.message}`);
    return null;
  }
}

/* ── 폴더 해석 ─────────────────────────────────────────────────────── */

/** 시트 제목(캡처 폴더 자동 생성용) — review-upload 의 규칙과 동일(campaign_name → 시트 메타). */
async function _sheetTitleFor(sheetId, tabName) {
  try {
    const { rows } = await _db().query(
      `SELECT DISTINCT campaign_name FROM tab_configs
        WHERE sheet_id = $1 AND campaign_name IS NOT NULL AND campaign_name <> '' LIMIT 1`, [sheetId]);
    if (rows[0]?.campaign_name) return rows[0].campaign_name;
  } catch (_) {}
  try {
    const { getSpreadsheetMeta } = require('./sheets.service');
    const meta = await getSpreadsheetMeta(sheetId);
    if (meta && meta._spreadsheetTitle) return meta._spreadsheetTitle;
  } catch (_) {}
  return tabName;
}

/**
 * 이동 대상 폴더 ID.
 * @param {object} p { target: 'review'|'receipt'|'capture', sheetId, tabName,
 *                    reviewBaseFolderId(그 탭 [리뷰] 폴더 — review/receipt 대상에 필수),
 *                    receiptLabel(현금영수증 서브폴더명) }
 * @returns {string|null} 확보 실패 = null(이동하지 않음 — fail-closed)
 */
async function resolveTargetFolder({ target, sheetId, tabName, reviewBaseFolderId, receiptLabel } = {}) {
  const driveService = require('./drive.service');
  try {
    if (target === 'review') return reviewBaseFolderId || null;
    if (target === 'receipt') {
      if (!reviewBaseFolderId || !receiptLabel) return null;
      const f = await driveService.getOrCreateSubFolder(reviewBaseFolderId, receiptLabel);
      return f && f.id ? f.id : null;
    }
    if (target === 'capture') {
      // ① 연결된 캡처폴더 URL 우선
      try {
        const { rows } = await _db().query(
          'SELECT capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
          [sheetId, tabName]);
        const id = rows[0]?.capture_folder_url
          ? driveService.extractFolderIdFromUrl(rows[0].capture_folder_url) : null;
        if (id) return id;
      } catch (_) {}
      // ② 자동 생성(시트제목 → 탭명 → [구매캡처]) — image-upload 와 같은 idempotent 경로
      const rootFolderId = process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID;
      if (!rootFolderId) return null;
      const sheetTitle = await _sheetTitleFor(sheetId, tabName);
      const r = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tabName);
      if (r && r.url) {
        try {
          await _db().query(
            'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [r.url, sheetId, tabName]);
        } catch (_) {}
      }
      return r && r.id ? r.id : null;
    }
  } catch (e) {
    logger.warn(`[fileRoute] 대상 폴더 확보 실패(이동 안 함): ${e.message}`);
  }
  return null;
}

/* ── 원장·대표 이미지 정합 ─────────────────────────────────────────── */

/** 업로드 직후 라우팅된 파일의 이동 이력 기록(INSERT 는 이미 최종 슬롯으로 됐다는 전제).
 *  091 미적용이면 warn 만 남기고 넘어간다(핫패스 보호). */
async function markRouted({ fileId, fromSlot, by = 'auto:upload' } = {}) {
  try {
    await _db().query(
      `UPDATE review_submissions
          SET routed_from_slot = $2, routed_at = NOW(), routed_by = $3
        WHERE file_id = $1`, [fileId, fromSlot, by]);
  } catch (e) {
    logger.warn(`[fileRoute] 이동 이력 기록 실패(무시 — migration 091 확인): ${e.message}`);
  }
}

/**
 * 대표 리뷰 이미지(review_index.review_file_*, A-1) 재계산 — 라우팅으로 review 슬롯
 * 구성이 바뀐 행에서만 호출한다. 남은 review 슬롯 파일 중 최신을 대표로, 없으면 비움
 * (영수증이 대표 이미지로 남아 업체 뷰어에 나가는 것 방지). fail-soft.
 */
async function recomputePrimary({ sheetId, tabName, rowIndex } = {}) {
  if (!sheetId || !tabName || rowIndex == null) return;
  try {
    const { rows } = await _db().query(
      `SELECT file_id, file_url, file_name, uploaded_at FROM review_submissions
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3 AND slot_key = 'review'
        ORDER BY uploaded_at DESC NULLS LAST`,
      [sheetId, tabName, rowIndex]);
    if (rows.length) {
      const p = rows[0];
      await _db().query(
        `UPDATE review_index
            SET review_file_id = $1, review_file_url = $2, review_file_name = $3,
                review_file_count = $4, review_file_at = COALESCE($5, review_file_at)
          WHERE sheet_id = $6 AND tab_name = $7 AND row_index = $8`,
        [p.file_id, p.file_url, p.file_name, rows.length, p.uploaded_at, sheetId, tabName, rowIndex]);
    } else {
      await _db().query(
        `UPDATE review_index
            SET review_file_id = NULL, review_file_url = NULL, review_file_name = NULL,
                review_file_count = 0
          WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
        [sheetId, tabName, rowIndex]);
    }
  } catch (e) {
    logger.warn(`[fileRoute] 대표 이미지 재계산 실패(무시): ${e.message}`);
  }
}

/* ── 알림(전부 best-effort) ────────────────────────────────────────── */
async function logRouteEvent({ eventType, severity = 'warn', resolved = false,
                               sheetId, tabName, reviewerName, message, context } = {}) {
  try {
    const { logReviewerEvent } = require('./reviewerEventLog.service');
    await logReviewerEvent({ eventType, severity, resolved, sheetId, tabName, reviewerName, message, context });
  } catch (e) {
    logger.warn(`[fileRoute] 알림 기록 실패(무시): ${e.message}`);
  }
}

/* ── 되돌리기 ─────────────────────────────────────────────────────── */

/** 탭 설정 + 리뷰타입 + [리뷰] 폴더 ID + 현금영수증 서브폴더 라벨. */
async function _tabRouteCtx(sheetId, tabName) {
  const driveService = require('./drive.service');
  const { rows } = await _db().query(
    'SELECT folder_url, capture_slots, income_type FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
    [sheetId, tabName]);
  const cfg = rows[0] || {};
  let reviewType = null;
  try { reviewType = await require('./reviewTypeContext.service').reviewTypeForTab({ sheetId, tabName }); } catch (_) {}
  const reviewBaseFolderId = cfg.folder_url ? driveService.extractFolderIdFromUrl(cfg.folder_url) : null;
  let receiptLabel = null;
  try {
    receiptLabel = require('../utils/captureSlots').slotLabel(cfg.capture_slots, cfg.income_type, 'receipt', reviewType);
  } catch (_) {}
  return { cfg, reviewType, reviewBaseFolderId, receiptLabel: receiptLabel || '현금영수증' };
}

/**
 * 자동 이동 되돌리기 — 파일을 원래 슬롯 폴더로 옮기고 원장 slot_key 를 원복한다.
 * 근거는 routed_from_slot 이력뿐(이력 없는 파일은 되돌릴 수 없다 = 오호출 안전).
 */
async function revertRoute({ fileId, by = 'revert' } = {}) {
  if (!fileId) return { ok: false, error: 'fileId가 필요합니다.' };
  const driveService = require('./drive.service');
  const { rows } = await _db().query(
    `SELECT sheet_id, tab_name, row_index, reviewer_name, slot_key, routed_from_slot
       FROM review_submissions WHERE file_id = $1 LIMIT 1`, [fileId]);
  const sub = rows[0];
  if (!sub) return { ok: false, error: '원장에 없는 파일입니다.' };
  if (!sub.routed_from_slot) return { ok: false, error: '자동 이동 이력이 없는 파일입니다.' };

  const ctx = await _tabRouteCtx(sub.sheet_id, sub.tab_name);
  const backTarget = sub.routed_from_slot === 'receipt' ? 'receipt' : 'review';
  const toFolderId = await resolveTargetFolder({
    target: backTarget, sheetId: sub.sheet_id, tabName: sub.tab_name,
    reviewBaseFolderId: ctx.reviewBaseFolderId, receiptLabel: ctx.receiptLabel,
  });
  if (!toFolderId) return { ok: false, error: '원래 폴더를 찾지 못했습니다(탭의 [리뷰] 폴더 연결을 확인하세요).' };

  // 현재 부모를 실제로 조회해 이동(멱등 — 이미 대상에 있으면 이동 생략)
  const cur = await driveService.getFileParents(fileId);
  if (cur.trashed) return { ok: false, error: '파일이 휴지통에 있습니다. Drive에서 먼저 복구해주세요.' };
  const parent = (cur.parents || [])[0] || null;
  if (parent !== toFolderId) await driveService.moveFile(fileId, toFolderId, parent);

  await _db().query(
    `UPDATE review_submissions
        SET slot_key = routed_from_slot, routed_from_slot = NULL, routed_at = NULL, routed_by = NULL
      WHERE file_id = $1`, [fileId]);
  await recomputePrimary({ sheetId: sub.sheet_id, tabName: sub.tab_name, rowIndex: sub.row_index });
  // 이 파일로 열린 자동 이동 알림은 원인이 사라졌으니 함께 닫는다
  try {
    await _db().query(
      `UPDATE reviewer_event_logs SET resolved_at = NOW(), resolved_by = $2
        WHERE event_type = 'capture_routed' AND resolved_at IS NULL AND context->>'fileId' = $1`,
      [fileId, by]);
  } catch (_) {}
  await logRouteEvent({
    eventType: 'capture_route_reverted', severity: 'info', resolved: true,
    sheetId: sub.sheet_id, tabName: sub.tab_name, reviewerName: sub.reviewer_name,
    message: `자동 이동을 되돌렸습니다 — ${routeSlotLabel(sub.slot_key)} → ${routeSlotLabel(sub.routed_from_slot)} (${by})`,
    context: { fileId, from: sub.slot_key, to: sub.routed_from_slot, row: String(sub.row_index ?? '') },
  });
  return { ok: true, fileId, restoredSlot: sub.routed_from_slot };
}

/** 리뷰웹시스템[3버전] 로그의 capture_routed 알림 1건에서 되돌리기. */
async function revertRouteFromEvent({ id, by = 'revert' } = {}) {
  if (!id) return { ok: false, error: 'id가 필요합니다.' };
  const { rows } = await _db().query(
    `SELECT id, event_type, context FROM reviewer_event_logs WHERE id = $1 LIMIT 1`, [id]);
  const ev = rows[0];
  if (!ev || ev.event_type !== 'capture_routed') return { ok: false, error: '자동 이동 알림이 아닙니다.' };
  const fileId = ev.context && ev.context.fileId;
  if (!fileId) return { ok: false, error: '알림에 파일 정보가 없습니다.' };
  const out = await revertRoute({ fileId, by });
  if (out.ok) {
    try {
      await _db().query(
        `UPDATE reviewer_event_logs SET resolved_at = NOW(), resolved_by = $2
          WHERE id = $1 AND resolved_at IS NULL`, [id, by]);
    } catch (_) {}
  }
  return out;
}

/* ── 소급 정리 스윕 (과거 오제출 — 사용자 확정 "소급정리 필요") ──────────
 * 그 탭의 기존 제출 원장을 훑어 오제출을 찾아 [미리보기 → 실행] 2단계로 정리한다.
 * 건당 Drive 다운로드 1회 + AI 1콜(캐시 미스 가정)이라 limit 으로 상한(기본 20).
 * ★ 이미 라우팅된 파일(routed_from_slot NOT NULL)은 건너뜀 — 핑퐁 방지.
 * ★ 실행 시에도 이동/휴지통 규칙은 실시간 경로와 동일(전이표·해시 중복만).
 * ★ is_submitted 는 건드리지 않는다(문서화된 한계) — 이동으로 리뷰 캡처가 빈 행은
 *   알림(capture_routed)으로 남아 관리자가 리뷰어에게 재요청한다.
 */
async function sweepTab({ sheetId, tabName, dryRun = true, limit = 20, by = 'sweep' } = {}) {
  if (!sheetId || !tabName) return { ok: false, error: 'sheetId, tabName이 필요합니다.' };
  const cap = Math.max(1, Math.min(Number(limit) || 20, 60));
  const driveService = require('./drive.service');
  const { verifyCapture } = require('./captureVerify.service');
  const inspect = require('./reviewInspect.service');

  const ctx = await _tabRouteCtx(sheetId, tabName);
  if (!ctx.reviewBaseFolderId) {
    return { ok: false, error: '이 탭에 [리뷰] 폴더가 연결돼 있지 않아 정리할 수 없습니다.' };
  }
  let expectedChannel = null;
  try { expectedChannel = (await inspect.loadTabExpectations({ sheetId, tabName })).expectedChannel; } catch (_) {}
  const samplesBySlot = {
    review: await inspect.submissionSamples({ expectedChannel, slotKey: 'review' }).catch(() => []),
    receipt: await inspect.submissionSamples({ expectedChannel, slotKey: 'receipt' }).catch(() => []),
  };
  const routeKinds = new Set((await inspect.loadRouteSamples().catch(() => [])).map(s => s.kind));
  const hasRouteSamples = routeKinds.has('order_capture') && routeKinds.has('purchase_confirm');
  let hasReceiptSlot = false;
  try {
    const { effectiveCaptureSlots } = require('../utils/captureSlots');
    hasReceiptSlot = (effectiveCaptureSlots(ctx.cfg.capture_slots, ctx.cfg.income_type, ctx.reviewType) || [])
      .some(s => s.key === 'receipt');
  } catch (_) {}

  let subs;
  try {
    const r = await _db().query(
      `SELECT file_id, file_name, row_index, reviewer_name, slot_key, file_hash
         FROM review_submissions
        WHERE sheet_id = $1 AND tab_name = $2
          AND slot_key IN ('review', 'receipt')
          AND routed_from_slot IS NULL
        ORDER BY uploaded_at DESC
        LIMIT $3`, [sheetId, tabName, cap]);
    subs = r.rows;
  } catch (e) {
    return { ok: false, error: `원장 조회 실패(migration 091 적용 확인): ${e.message}`, code: 'not_ready' };
  }

  const plans = [];
  const errors = [];
  let scanned = 0;
  for (const s of subs) {
    scanned++;
    try {
      const f = await driveService.downloadFile(s.file_id);
      if (!f || !f.buffer) { continue; }
      const b64 = f.buffer.toString('base64');
      const verdict = await verifyCapture({
        base64: b64, mimeType: f.mimeType || 'image/jpeg', slotKey: s.slot_key,
        reviewType: ctx.reviewType, samples: samplesBySlot[s.slot_key] || [],
      });
      const rd = routeDecision({ slotKey: s.slot_key, verdict, hasReceiptSlot, hasRouteSamples, expectedChannel });
      if (rd.action !== 'route') continue;
      const dup = await findSlotDuplicate({
        sheetId, tabName, rowIndex: s.row_index, reviewerName: s.reviewer_name,
        toSlot: rd.toSlot, fileHash: s.file_hash || inspect.hashBase64(b64), fileId: s.file_id,
      });
      plans.push({
        fileId: s.file_id, fileName: s.file_name, rowIndex: s.row_index,
        reviewerName: s.reviewer_name, fromSlot: s.slot_key, toSlot: rd.toSlot, target: rd.target,
        got: verdict.got, confidence: verdict.confidence,
        duplicate: dup ? { matchFileId: dup.file_id } : null,
      });
    } catch (e) {
      errors.push({ fileId: s.file_id, error: e.message });
    }
  }

  if (dryRun) return { ok: true, dryRun: true, scanned, plans, errors, hasRouteSamples, hasReceiptSlot };

  // ── 실행 ──
  let moved = 0, trashed = 0, failed = 0;
  for (const p of plans) {
    try {
      if (p.duplicate) {
        // 대상 슬롯에 같은 지문의 정본이 이미 있음 → 이 파일은 중복 사본 = 휴지통
        await driveService.trashFiles([{ id: p.fileId, name: p.fileName || p.fileId }]);
        await _db().query(
          `UPDATE review_submissions
              SET routed_from_slot = slot_key, slot_key = 'trashed', routed_at = NOW(), routed_by = $2
            WHERE file_id = $1`, [p.fileId, 'dup:' + by]);
        trashed++;
        await logRouteEvent({
          eventType: 'capture_dup_rejected', severity: 'warn',
          sheetId, tabName, reviewerName: p.reviewerName,
          message: `${p.reviewerName || '리뷰어'}님의 ${p.rowIndex != null ? p.rowIndex + '행 ' : ''}` +
            `${routeSlotLabel(p.fromSlot)} 캡처가 ${routeSlotLabel(p.toSlot)} 칸의 기존 제출과 동일 파일(SHA-256 일치)이라 휴지통으로 옮겼습니다(소급 정리).`,
          context: { fileId: p.fileId, matchFileId: p.duplicate.matchFileId, from: p.fromSlot, to: p.toSlot, row: String(p.rowIndex ?? ''), sweep: true },
        });
      } else {
        const toFolderId = await resolveTargetFolder({
          target: p.target, sheetId, tabName,
          reviewBaseFolderId: ctx.reviewBaseFolderId, receiptLabel: ctx.receiptLabel,
        });
        if (!toFolderId) { failed++; errors.push({ fileId: p.fileId, error: '대상 폴더 확보 실패' }); continue; }
        const cur = await driveService.getFileParents(p.fileId);
        const parent = (cur.parents || [])[0] || null;
        if (parent !== toFolderId) await driveService.moveFile(p.fileId, toFolderId, parent);
        await _db().query(
          `UPDATE review_submissions
              SET routed_from_slot = slot_key, slot_key = $2, routed_at = NOW(), routed_by = $3
            WHERE file_id = $1 AND routed_from_slot IS NULL`, [p.fileId, p.toSlot, 'sweep:' + by]);
        moved++;
        await recomputePrimary({ sheetId, tabName, rowIndex: p.rowIndex });
        await logRouteEvent({
          eventType: 'capture_routed', severity: 'warn',
          sheetId, tabName, reviewerName: p.reviewerName,
          message: `${p.reviewerName || '리뷰어'}님의 ${p.rowIndex != null ? p.rowIndex + '행 ' : ''}` +
            `${routeSlotLabel(p.fromSlot)} 캡처가 ${routeSlotLabel(p.toSlot)}(AI 확신 ${Math.round((p.confidence || 0) * 100)}%)으로 판정되어 ${routeSlotLabel(p.toSlot)} 폴더로 이동했습니다(소급 정리).`,
          context: { fileId: p.fileId, from: p.fromSlot, to: p.toSlot, row: String(p.rowIndex ?? ''), sweep: true },
        });
      }
    } catch (e) {
      failed++;
      errors.push({ fileId: p.fileId, error: e.message });
    }
  }
  return { ok: true, dryRun: false, scanned, planned: plans.length, moved, trashed, failed, errors };
}

/* ── 수동 분류(이동) — 검수 화면에서 사람이 대상 칸을 직접 고른다 ──────────
 * 자동 이동과 **같은 실행부**(폴더 해석·이동·원장·대표 이미지·로그)를 타므로 결과 상태가
 * 동일하고, 기존 [↩ 원위치](revertRoute)로 똑같이 되돌릴 수 있다(이동 규칙 사본 0).
 * ★ 사람이 판단하므로 AI 확신도 게이트·예시 등록 게이트는 적용하지 않는다(그 게이트들은
 *   자동 이동의 오판 방어 장치다). AUTO_FILE_ROUTE 모드와도 무관하게 동작한다(off/dry
 *   여도 사람 이동은 가능해야 백로그를 치운다).
 * ★ 대상 칸에 같은 지문 파일이 이미 있으면 **휴지통이 아니라 거부** — 자동과 달리 사람이
 *   보고 정리한다(수동 경로에서의 파일 삭제는 두지 않는다).
 */
const MANUAL_ROUTE_TARGETS = { review: 'review', receipt: 'receipt', order_capture: 'capture' };

async function manualRoute({ fileId, target, by = '' } = {}) {
  if (!fileId) return { ok: false, error: 'fileId가 필요합니다.' };
  const t = String(target || '');
  if (!MANUAL_ROUTE_TARGETS[t]) return { ok: false, error: '알 수 없는 이동 대상입니다.' };
  const driveService = require('./drive.service');

  let sub;
  try {
    const { rows } = await _db().query(
      `SELECT file_id, file_name, sheet_id, tab_name, row_index, reviewer_name, slot_key, file_hash
         FROM review_submissions WHERE file_id = $1 LIMIT 1`, [fileId]);
    sub = rows[0];
  } catch (e) { return { ok: false, error: `원장 조회 실패: ${e.message}` }; }
  if (!sub) return { ok: false, error: '원장에 없는 파일이라 이동할 수 없습니다.' };
  if (sub.slot_key === t) return { ok: false, error: '이미 그 칸에 있는 파일입니다.' };

  const ctx = await _tabRouteCtx(sub.sheet_id, sub.tab_name);
  if ((t === 'review' || t === 'receipt') && !ctx.reviewBaseFolderId) {
    return { ok: false, error: '이 탭에 [리뷰] 폴더가 연결돼 있지 않아 이동할 수 없습니다.' };
  }
  const dup = await findSlotDuplicate({
    sheetId: sub.sheet_id, tabName: sub.tab_name, rowIndex: sub.row_index,
    reviewerName: sub.reviewer_name, toSlot: t, fileHash: sub.file_hash, fileId,
  });
  if (dup) return { ok: false, error: '대상 칸에 같은 파일이 이미 있습니다 — 이동 대신 기존 파일을 확인해 주세요.' };

  const toFolderId = await resolveTargetFolder({
    target: MANUAL_ROUTE_TARGETS[t], sheetId: sub.sheet_id, tabName: sub.tab_name,
    reviewBaseFolderId: ctx.reviewBaseFolderId, receiptLabel: ctx.receiptLabel,
  });
  if (!toFolderId) return { ok: false, error: '대상 폴더를 확보하지 못했습니다.' };

  try {
    const cur = await driveService.getFileParents(fileId);
    const parent = (cur.parents || [])[0] || null;
    if (parent !== toFolderId) await driveService.moveFile(fileId, toFolderId, parent);
  } catch (e) { return { ok: false, error: `Drive 이동 실패: ${e.message}` }; }

  // ★ routed_from_slot 은 COALESCE — 자동 이동 뒤 사람이 다시 옮겨도 **최초 출처**를 보존해
  //   되돌리기가 항상 원래 칸으로 간다.
  await _db().query(
    `UPDATE review_submissions
        SET routed_from_slot = COALESCE(routed_from_slot, slot_key), slot_key = $2,
            routed_at = NOW(), routed_by = $3
      WHERE file_id = $1`, [fileId, t, 'manual:' + (by || 'admin')]);
  await recomputePrimary({ sheetId: sub.sheet_id, tabName: sub.tab_name, rowIndex: sub.row_index });
  await logRouteEvent({
    eventType: 'capture_routed', severity: 'warn', resolved: true,   // 사람이 한 행동 — 알림으로 쌓지 않는다
    sheetId: sub.sheet_id, tabName: sub.tab_name, reviewerName: sub.reviewer_name,
    message: `${sub.reviewer_name || '리뷰어'}님의 ${sub.row_index != null ? sub.row_index + '행 ' : ''}` +
      `${routeSlotLabel(sub.slot_key)} 캡처를 ${by || '관리자'}님이 ${routeSlotLabel(t)} 폴더로 수동 분류했습니다.`,
    context: { fileId, from: sub.slot_key, to: t, row: String(sub.row_index ?? ''), manual: true },
  });
  return { ok: true, from: sub.slot_key, to: t, sheetId: sub.sheet_id, tabName: sub.tab_name, rowIndex: sub.row_index };
}

/**
 * 자동분류 정확도 관측 — 사람의 수동 분류(routed_by='manual:*')를 정답으로 놓고,
 * AI 관측 계획(capture_route_plan — dry 모드가 기록)과 대조한다.
 * match(AI도 같은 판단) / miss(AI는 못 잡음) / differ(AI가 다르게 판단).
 * ★ 읽기 전용·저장 없음 — auto 전환·임계값 조정의 판단 재료일 뿐 자동으로 아무것도 바꾸지 않는다.
 */
async function routeAccuracyStats({ days = 30 } = {}) {
  const d = Math.max(1, Math.min(Number(days) || 30, 90));
  try {
    const { rows } = await _db().query(
      `SELECT s.file_id, s.slot_key AS manual_to,
              (SELECT e.context->>'to' FROM reviewer_event_logs e
                WHERE e.event_type = 'capture_route_plan' AND e.context->>'fileId' = s.file_id
                ORDER BY e.created_at DESC LIMIT 1) AS plan_to
         FROM review_submissions s
        WHERE s.routed_by LIKE 'manual:%'
          AND s.routed_at > NOW() - ($1 || ' days')::interval`,
      [d]);
    let match = 0, miss = 0, differ = 0;
    for (const r of rows) {
      if (!r.plan_to) miss++;
      else if (r.plan_to === r.manual_to) match++;
      else differ++;
    }
    return { ok: true, days: d, total: rows.length, match, miss, differ };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  findSlotDuplicate, resolveTargetFolder, markRouted, recomputePrimary,
  logRouteEvent, revertRoute, revertRouteFromEvent, sweepTab,
  manualRoute, routeAccuracyStats,
  routeMode, rejectEnabled,
  __setPoolForTest,
};
