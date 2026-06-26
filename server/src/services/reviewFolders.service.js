// ═══════════════════════════════════════════════════════════
// reviewFolders.service.js
// 활성(비마감) 탭에 [리뷰]/[구매캡처] 폴더를 자동으로 생성·연결한다.
//
// 배경: 기존에는 "첫 이미지 제출 시" on-demand로만 폴더가 생성됐다
//   (diag.routes.js review-upload). 그래서 제출 0건 탭은 폴더가 없고
//   (미연결), 과거 OAuth 자격이 없던 시절엔 SA 폴백으로 폴더가
//   서비스계정 소유로 생성되는 일이 있었다.
//
// 이 모듈은 createFolder의 OAuth(tnaks6325) 우선 경로를 그대로 이용해
//   탭이 추가되는 즉시(스마트빌드 주기) tnaks 소유 폴더를 미리 만들어 둔다.
//   → 미연결/타 소유권 폴더가 생길 여지를 근본적으로 줄인다.
//
// 안전: 비파괴(파일 이동/삭제 없음) · idempotent(이미 연결된 탭은 건너뜀)
//   · best-effort(개별 실패는 errors로 집계만, 예외를 던지지 않음).
// ═══════════════════════════════════════════════════════════
const pool = require('../db/pool');
const driveService = require('./drive.service');
const { getSpreadsheetMeta } = require('./sheets.service');
const { logger } = require('../utils/logger');

function getRootFolderId() {
  return process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || null;
}

// 시트 제목(폴더 1단계) 해석: tab_configs → campaigns → Sheets API → fallback
async function _resolveSheetTitle(sheetId, fallback) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT campaign_name FROM tab_configs
        WHERE sheet_id = $1 AND campaign_name IS NOT NULL AND campaign_name <> '' LIMIT 1`,
      [sheetId]
    );
    if (rows[0] && rows[0].campaign_name) return rows[0].campaign_name;
  } catch (_) {}
  try {
    const { rows } = await pool.query(`SELECT campaign_name FROM campaigns WHERE sheet_id = $1 LIMIT 1`, [sheetId]);
    if (rows[0] && rows[0].campaign_name) return rows[0].campaign_name;
  } catch (_) {}
  try {
    const meta = await getSpreadsheetMeta(sheetId);
    if (meta && meta._spreadsheetTitle) return meta._spreadsheetTitle;
  } catch (_) {}
  return fallback || sheetId;
}

/**
 * 활성 탭 중 리뷰/캡처 폴더가 없는 탭에 폴더를 생성·연결한다.
 * @param {{ limit?: number, includeCapture?: boolean }} opts
 *   - limit: 한 번에 처리할 탭 수 상한(폭주 방지, 기본 30). 초과분은 다음 주기에.
 *   - includeCapture: [구매캡처] 폴더도 함께 보장(기본 true)
 * @returns {{ scanned, reviewCreated, captureCreated, skipped, errors, capped, details }}
 */
async function ensureReviewFoldersForActiveTabs(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 30;
  const includeCapture = opts.includeCapture !== false;
  const out = { scanned: 0, reviewCreated: 0, captureCreated: 0, skipped: 0, errors: 0, capped: false, details: [] };

  const rootFolderId = getRootFolderId();
  if (!rootFolderId) { out.error = 'AI_REVIEW_FOLDER_ID 미설정'; return out; }

  let rows;
  try {
    const r = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url, capture_folder_url
         FROM tab_configs
        WHERE (is_closed = FALSE OR is_closed IS NULL)
          AND ( (folder_url IS NULL OR folder_url = '')
             OR ($1::boolean AND (capture_folder_url IS NULL OR capture_folder_url = '')) )
        ORDER BY updated_at DESC NULLS LAST`,
      [includeCapture]
    );
    rows = r.rows;
  } catch (e) {
    out.error = e.message;
    return out;
  }

  out.scanned = rows.length;
  let processed = 0;
  for (const tab of rows) {
    if (processed >= limit) { out.capped = true; break; }
    // '리뷰폼' 탭은 리뷰 수집 대상이 아니므로 폴더 불필요(감사 기준과 일치)
    if ((tab.tab_name || '').indexOf('리뷰폼') >= 0) { out.skipped++; continue; }

    // 폴더 생성을 시도하는 탭(성공/실패 무관)은 cap 예산을 소비 — Drive 오류 시 폭주 방지
    processed++;

    let sheetTitle = null;
    try {
      sheetTitle = await _resolveSheetTitle(tab.sheet_id, tab.campaign_name || tab.tab_name);
    } catch (e) {
      out.errors++;
      out.details.push({ tab: tab.tab_name, error: `시트제목 해석 실패: ${e.message}` });
      continue;
    }

    // [리뷰] 폴더
    if (!tab.folder_url) {
      try {
        const res = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tab.tab_name);
        await pool.query(
          `UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3`,
          [res.url, tab.sheet_id, tab.tab_name]
        );
        out.reviewCreated++;
        out.details.push({ tab: tab.tab_name, type: 'review', url: res.url });
      } catch (e) {
        out.errors++;
        out.details.push({ tab: tab.tab_name, type: 'review', error: e.message });
        logger.warn(`[reviewFolders] 리뷰폴더 생성 실패 (${tab.tab_name}): ${e.message}`);
      }
    }

    // [구매캡처] 폴더
    if (includeCapture && !tab.capture_folder_url) {
      try {
        const res = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tab.tab_name);
        await pool.query(
          `UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3`,
          [res.url, tab.sheet_id, tab.tab_name]
        );
        out.captureCreated++;
        out.details.push({ tab: tab.tab_name, type: 'capture', url: res.url });
      } catch (e) {
        out.errors++;
        out.details.push({ tab: tab.tab_name, type: 'capture', error: e.message });
        logger.warn(`[reviewFolders] 캡처폴더 생성 실패 (${tab.tab_name}): ${e.message}`);
      }
    }
  }

  if (out.reviewCreated || out.captureCreated || out.errors) {
    logger.info(`[reviewFolders] 자동 연결: 리뷰 ${out.reviewCreated} · 캡처 ${out.captureCreated} · 건너뜀 ${out.skipped} · 오류 ${out.errors}${out.capped ? ` (cap ${limit}, 나머지 다음 주기)` : ''}`);
  }
  return out;
}

module.exports = { ensureReviewFoldersForActiveTabs, getRootFolderId };
