'use strict';
/**
 * captureFolder.service.js — 작업(탭)의 Drive [구매캡처] 폴더를 찾는 **단일 출처**.
 *
 * 소비처 2곳이 같은 함수를 쓴다(사본 금지 — 갈리면 리뷰어 업로드와 직원 교체가 다른 폴더에 쌓인다):
 *   ① 리뷰어 구매캡처 업로드 `POST /api/image/image-upload`(diag.routes)
 *   ② 작업보드 [🛒 구매캡처 교체] `POST /api/trackb/workdesk/purchase-capture/replace`
 *
 * 순서 = ① tab_configs.capture_folder_url(이미 연결된 폴더) → ② 없으면 자동 생성
 *   (시트제목 → 탭명 → [구매캡처]) 후 tab_configs 에 저장 → ③ round 가 있으면 차수 서브폴더.
 * ★ 모듈 참조는 **호출 시점에** 한다(`pool.query`·`driveService.*`·`sheets.getSpreadsheetMeta`) —
 *   테스트가 모듈 속성을 갈아끼우는 방식으로 스텁하므로 구조분해로 캡처하면 안 된다.
 */
const pool = require('../db/pool');
const driveService = require('./drive.service');
const sheets = require('./sheets.service');
const { logger } = require('../utils/logger');

async function resolveCaptureFolder({ sheetId, tabName, round, rootFolderId }) {
  let targetFolderId = null;
  let captureFolderUrl = null;

  // STEP 1: 작업의 tab_configs.capture_folder_url
  if (sheetId && tabName) {
    const { rows } = await pool.query(
      'SELECT capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
      [sheetId, tabName]
    );
    if (rows[0]?.capture_folder_url) {
      targetFolderId = driveService.extractFolderIdFromUrl(rows[0].capture_folder_url);
      if (targetFolderId) {
        captureFolderUrl = rows[0].capture_folder_url;
        logger.info(`[capture-folder] DB capture_folder_url 사용: ${targetFolderId}`);
      }
    }
  }

  // STEP 2: 자동 생성 (3단계 구조: 시트제목 → 탭명 → [구매캡처])
  if (!targetFolderId) {
    let sheetTitle = tabName || '기타';
    if (sheetId) {
      try {
        const { rows: campRows } = await pool.query(
          `SELECT DISTINCT campaign_name FROM tab_configs WHERE sheet_id = $1 AND campaign_name IS NOT NULL AND campaign_name <> '' LIMIT 1`,
          [sheetId]
        );
        if (campRows[0]?.campaign_name) {
          sheetTitle = campRows[0].campaign_name;
        } else {
          const meta = await sheets.getSpreadsheetMeta(sheetId);
          if (meta._spreadsheetTitle) sheetTitle = meta._spreadsheetTitle;
        }
      } catch (_) {}
    }
    const tabFolderName = tabName || '기타';
    logger.info(`[capture-folder] 폴더 자동 생성: ${sheetTitle} → ${tabFolderName} → [구매캡처]`);
    const result = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tabFolderName);
    targetFolderId = result.id;
    captureFolderUrl = result.url;
    logger.info(`[capture-folder] 캡처폴더 확보: ${targetFolderId} (${result.path.join(' → ')})`);
    if (sheetId && tabName) {
      await pool.query(
        'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
        [captureFolderUrl, sheetId, tabName]
      );
    }
  }

  // STEP 3: 차수별 서브폴더
  if (round) {
    const sub = await driveService.getOrCreateSubFolder(targetFolderId, String(round));
    targetFolderId = sub.id;
  }
  return { folderId: targetFolderId, folderUrl: captureFolderUrl };
}

module.exports = { resolveCaptureFolder };
