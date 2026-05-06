const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const {
  detectDuplicates,
  trashFiles,
  extractReviewerNameFromFile,
  extractFolderIdFromUrl,
} = require('../services/drive.service');
const { readSheet, writeSheet, batchUpdateSheet } = require('../services/sheets.service');

// ═══════════════════════════════════════════════════════════
// 중복 파일 정리 API
// 2단계: 미리보기(preview) → 확인 후 실행(execute)
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/dedupe/preview
 * 미리보기: 중복 파일 감지 결과 반환 (삭제하지 않음)
 * Body: { sheetId, tabName }
 */
router.post('/preview', async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body;
    if (!sheetId || !tabName) {
      return res.status(400).json({ error: 'sheetId, tabName 필수' });
    }

    // 1. tab_configs에서 folder_url 조회
    const tcResult = await pool.query(
      `SELECT folder_url, tab_gid, campaign_name, display_name
       FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName]
    );
    if (tcResult.rows.length === 0) {
      return res.status(404).json({ error: '탭 설정을 찾을 수 없습니다.' });
    }

    const tc = tcResult.rows[0];
    const folderId = extractFolderIdFromUrl(tc.folder_url);
    if (!folderId) {
      return res.status(400).json({ error: '리뷰 폴더 URL이 설정되지 않았습니다.' });
    }

    // 2. 중복 감지
    const result = await detectDuplicates(folderId);

    // 3. 삭제 대상에서 리뷰어명 추출
    const duplicateDetails = result.duplicates.map(group => {
      const removeDetails = group.remove.map(file => ({
        fileId: file.id,
        fileName: file.name,
        reviewerName: extractReviewerNameFromFile(file.name),
        createdTime: file.createdTime,
      }));
      return {
        md5: group.md5,
        keepFile: {
          fileId: group.keep.id,
          fileName: group.keep.name,
          reviewerName: extractReviewerNameFromFile(group.keep.name),
          createdTime: group.keep.createdTime,
        },
        removeFiles: removeDetails,
        fileCount: removeDetails.length + 1,
      };
    });

    // 4. 영향받는 리뷰어 목록 (시트에 "중복" 마킹될 사람들)
    const affectedReviewers = [];
    for (const group of duplicateDetails) {
      for (const file of group.removeFiles) {
        if (file.reviewerName) {
          affectedReviewers.push({
            reviewerName: file.reviewerName,
            fileName: file.fileName,
            fileId: file.fileId,
          });
        }
      }
    }

    res.json({
      ok: true,
      tabName,
      displayName: tc.display_name || tc.campaign_name || tabName,
      folderId,
      totalFiles: result.totalFiles,
      duplicateGroups: result.duplicateGroups,
      duplicateFileCount: result.duplicateFileCount,
      duplicateDetails,
      affectedReviewers,
    });

  } catch (err) {
    logger.error(`[Dedupe/preview] 에러: ${err.message}`);
    next(err);
  }
});

/**
 * POST /api/dedupe/execute
 * 실행: 중복 파일 휴지통 이동 + 시트 "중복" 마킹
 * Body: { sheetId, tabName, filesToRemove: [{fileId, fileName, reviewerName}] }
 */
router.post('/execute', async (req, res, next) => {
  try {
    const { sheetId, tabName, filesToRemove } = req.body;
    if (!sheetId || !tabName || !filesToRemove || filesToRemove.length === 0) {
      return res.status(400).json({ error: 'sheetId, tabName, filesToRemove 필수' });
    }

    // 1. tab_configs에서 gid 조회
    const tcResult = await pool.query(
      `SELECT tab_gid FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName]
    );
    const gid = tcResult.rows[0]?.tab_gid || null;
    const sheetOpts = gid ? { gid } : {};

    // 2. 파일 휴지통 이동
    const trashResult = await trashFiles(filesToRemove);

    // 3. 시트에서 해당 리뷰어의 제출 열에 "중복" 마킹
    //    - 시트 헤더 읽기 → 제출 열 인덱스 찾기
    //    - 해당 리뷰어의 row_index 조회 → 셀 좌표 계산
    let sheetMarked = 0;
    let sheetErrors = [];

    // 삭제 성공한 파일의 리뷰어명 수집
    const successFileIds = new Set(
      filesToRemove.filter((_, i) => i < trashResult.success).map(f => f.fileId)
    );
    // 실제로 삭제 성공한 리뷰어명만 마킹
    const reviewersToMark = filesToRemove
      .filter(f => successFileIds.has(f.fileId) || trashResult.failed === 0)
      .map(f => f.reviewerName)
      .filter(Boolean);

    if (reviewersToMark.length > 0) {
      try {
        // review_index에서 해당 리뷰어의 row_index + submit_col 조회
        const riResult = await pool.query(
          `SELECT reviewer_name, row_index, submit_col
           FROM review_index
           WHERE sheet_id = $1 AND tab_name = $2
             AND REPLACE(reviewer_name, ' ', '') = ANY($3::text[])`,
          [sheetId, tabName, reviewersToMark.map(n => n.replace(/\s/g, ''))]
        );

        if (riResult.rows.length > 0) {
          // 헤더 읽기 (첫 번째 행)
          const sheetData = await readSheet(sheetId, `'${tabName}'!1:1`, sheetOpts);
          const headers = (sheetData && sheetData[0]) || [];

          // 제출 열 인덱스 찾기
          const submitCol = riResult.rows[0]?.submit_col;
          const colIdx = submitCol ? headers.findIndex(h => h === submitCol) : -1;

          if (colIdx >= 0) {
            // 열 문자 변환
            const colLetter = _getColLetter(colIdx);

            // batchUpdateSheet로 한번에 "중복" 기록
            const updates = [];
            const markedReviewers = new Set();

            for (const row of riResult.rows) {
              const cleanName = (row.reviewer_name || '').replace(/\s/g, '');
              if (reviewersToMark.includes(cleanName) && !markedReviewers.has(`${cleanName}_${row.row_index}`)) {
                updates.push({
                  range: `'${tabName}'!${colLetter}${row.row_index}`,
                  values: [['중복']],
                });
                markedReviewers.add(`${cleanName}_${row.row_index}`);
              }
            }

            if (updates.length > 0) {
              await batchUpdateSheet(sheetId, updates, 'RAW', sheetOpts);
              sheetMarked = updates.length;
              logger.info(`[Dedupe/execute] 시트 "중복" 마킹 ${sheetMarked}건 (sheet=${sheetId}, tab=${tabName})`);

              // DB도 업데이트 (is_submitted = true로 → 검색 결과에서 제외)
              for (const row of riResult.rows) {
                const cleanName = (row.reviewer_name || '').replace(/\s/g, '');
                if (reviewersToMark.includes(cleanName)) {
                  await pool.query(
                    `UPDATE review_index SET is_submitted = TRUE, built_at = NOW()
                     WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3`,
                    [sheetId, tabName, row.row_index]
                  );
                }
              }
            }
          } else {
            sheetErrors.push('제출 열(submit_col)을 헤더에서 찾을 수 없습니다.');
          }
        }
      } catch (sheetErr) {
        sheetErrors.push(sheetErr.message);
        logger.warn(`[Dedupe/execute] 시트 마킹 실패: ${sheetErr.message}`);
      }
    }

    res.json({
      ok: true,
      trashResult: {
        success: trashResult.success,
        failed: trashResult.failed,
        errors: trashResult.errors,
      },
      sheetMarked,
      sheetErrors,
      summary: `중복 파일 ${trashResult.success}건 휴지통 이동, 시트 ${sheetMarked}건 "중복" 마킹 완료`,
    });

  } catch (err) {
    logger.error(`[Dedupe/execute] 에러: ${err.message}`);
    next(err);
  }
});

// ── 유틸: 열 인덱스 → 열 문자 (0=A, 1=B, ..., 25=Z, 26=AA) ──
function _getColLetter(idx) {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

module.exports = router;
