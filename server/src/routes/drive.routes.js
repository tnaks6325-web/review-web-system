const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const driveService = require('../services/drive.service');
const { getSpreadsheetMeta } = require('../services/sheets.service');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');

/**
 * 헬퍼: Google Drive URL에서 폴더 ID 추출
 */
function extractFolderId(url) {
  if (!url) return null;
  const m = (url || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * 헬퍼: AI_REVIEW_FOLDER_ID 환경변수 조회
 * AI_REVIEW_FOLDER_ID → DRIVE_ROOT_FOLDER_ID 순서 폴백
 */
function getRootFolderId() {
  return process.env.AI_REVIEW_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || null;
}

/**
 * 헬퍼: 탭의 시트 제목(캠페인명=업체명) 조회
 * tab_configs.campaign_name → Google Sheets API 폴백
 */
async function getSheetTitle(sheetId, fallbackName) {
  // 1. tab_configs.campaign_name에서 조회
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT campaign_name FROM tab_configs WHERE sheet_id = $1 AND campaign_name IS NOT NULL AND campaign_name <> '' LIMIT 1`,
      [sheetId]
    );
    if (rows[0]?.campaign_name) return rows[0].campaign_name;
  } catch (_) {}

  // 2. campaigns 테이블에서 조회
  try {
    const { rows } = await pool.query(
      `SELECT campaign_name FROM campaigns WHERE sheet_id = $1 LIMIT 1`,
      [sheetId]
    );
    if (rows[0]?.campaign_name) return rows[0].campaign_name;
  } catch (_) {}

  // 3. Google Sheets API로 시트 제목 조회
  try {
    const meta = await getSpreadsheetMeta(sheetId);
    if (meta._spreadsheetTitle) return meta._spreadsheetTitle;
  } catch (_) {}

  return fallbackName || sheetId;
}

// ═══════════════════════════════════════════════════════════
// POST /api/drive/init-root — AI_REVIEW_FOLDER 루트 폴더 초기화
// 새 루트 폴더를 생성하고 AI_REVIEW_FOLDER_ID를 반환
// ═══════════════════════════════════════════════════════════
router.post('/init-root', authMiddleware, async (req, res, next) => {
  try {
    const { parentFolderId } = req.body;
    // 이미 설정되어 있으면 그대로 사용
    const existingRootId = getRootFolderId();
    if (existingRootId) {
      return res.json({
        ok: true,
        rootFolderId: existingRootId,
        message: '루트 폴더가 이미 설정되어 있습니다.',
        alreadyExists: true,
      });
    }

    // 새 루트 폴더 생성
    const targetParent = parentFolderId || 'root'; // My Drive root
    const folder = await driveService.createFolder('AI_REVIEW_FOLDER', targetParent);

    res.json({
      ok: true,
      rootFolderId: folder.id,
      folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
      message: `AI_REVIEW_FOLDER 생성 완료. Railway 환경변수에 AI_REVIEW_FOLDER_ID=${folder.id} 를 추가하세요.`,
      alreadyExists: false,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/sync-capture — 캡처폴더 동기화 (새 3단계 구조)
// 구조: AI_REVIEW_FOLDER → {시트제목} → {탭명} → [구매캡처]
// ═══════════════════════════════════════════════════════════
router.post('/sync-capture', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, capture_folder_url
       FROM tab_configs
       WHERE (is_closed = FALSE OR is_closed IS NULL)`
    );

    let synced = 0, created = 0, errors = 0;
    const details = [];

    // sheet_id별로 그룹핑하여 시트 제목 조회 횟수 최소화
    const sheetTitleCache = {};

    for (const tab of tabs) {
      try {
        if (tab.capture_folder_url && !force) {
          synced++;
          continue;
        }

        // 시트 제목 조회 (캐시)
        if (!sheetTitleCache[tab.sheet_id]) {
          sheetTitleCache[tab.sheet_id] = await getSheetTitle(tab.sheet_id, tab.campaign_name);
        }
        const sheetTitle = sheetTitleCache[tab.sheet_id];

        // 3단계 폴더 생성: 시트제목 → 탭명 → [구매캡처]
        const result = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tab.tab_name);

        // tab_configs에 URL 저장
        await pool.query(
          'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [result.url, tab.sheet_id, tab.tab_name]
        );

        if (!tab.capture_folder_url) created++;
        synced++;
        details.push({ tabName: tab.tab_name, path: result.path.join(' → '), url: result.url });
      } catch (err) {
        logger.error(`[syncCapture] 오류 (${tab.tab_name}): ${err.message}`);
        errors++;
      }
    }

    res.json({ ok: true, synced, created, errors, total: tabs.length, details });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/sync-review — 리뷰폴더 동기화 (새 3단계 구조)
// 구조: AI_REVIEW_FOLDER → {시트제목} → {탭명} → [리뷰]
// ═══════════════════════════════════════════════════════════
router.post('/sync-review', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url
       FROM tab_configs
       WHERE (is_closed = FALSE OR is_closed IS NULL)`
    );

    let synced = 0, created = 0, errors = 0;
    const details = [];

    const sheetTitleCache = {};

    for (const tab of tabs) {
      try {
        if (tab.folder_url && !force) { synced++; continue; }

        if (!sheetTitleCache[tab.sheet_id]) {
          sheetTitleCache[tab.sheet_id] = await getSheetTitle(tab.sheet_id, tab.campaign_name);
        }
        const sheetTitle = sheetTitleCache[tab.sheet_id];

        // 3단계 폴더 생성: 시트제목 → 탭명 → [리뷰]
        const result = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tab.tab_name);

        await pool.query(
          'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [result.url, tab.sheet_id, tab.tab_name]
        );

        if (!tab.folder_url) created++;
        synced++;
        details.push({ tabName: tab.tab_name, path: result.path.join(' → '), url: result.url });
      } catch (err) {
        logger.error(`[syncReview] 오류 (${tab.tab_name}): ${err.message}`);
        errors++;
      }
    }

    res.json({ ok: true, synced, created, errors, total: tabs.length, details });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/sync-all — 전체 폴더 동기화
// ═══════════════════════════════════════════════════════════
router.post('/sync-all', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const startTime = Date.now();

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url, capture_folder_url
       FROM tab_configs
       WHERE (is_closed = FALSE OR is_closed IS NULL)`
    );

    const sheetTitleCache = {};
    const capture = { synced: 0, created: 0, errors: 0 };
    const review = { synced: 0, created: 0, errors: 0 };

    for (const tab of tabs) {
      // 시트 제목 캐시
      if (!sheetTitleCache[tab.sheet_id]) {
        sheetTitleCache[tab.sheet_id] = await getSheetTitle(tab.sheet_id, tab.campaign_name);
      }
      const sheetTitle = sheetTitleCache[tab.sheet_id];

      // 캡처폴더
      try {
        if (tab.capture_folder_url && !force) {
          capture.synced++;
        } else {
          const result = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tab.tab_name);
          await pool.query(
            'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [result.url, tab.sheet_id, tab.tab_name]
          );
          if (!tab.capture_folder_url) capture.created++;
          capture.synced++;
        }
      } catch (err) {
        logger.error(`[syncAll/capture] 오류 (${tab.tab_name}): ${err.message}`);
        capture.errors++;
      }

      // 리뷰폴더
      try {
        if (tab.folder_url && !force) {
          review.synced++;
        } else {
          const result = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tab.tab_name);
          await pool.query(
            'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [result.url, tab.sheet_id, tab.tab_name]
          );
          if (!tab.folder_url) review.created++;
          review.synced++;
        }
      } catch (err) {
        logger.error(`[syncAll/review] 오류 (${tab.tab_name}): ${err.message}`);
        review.errors++;
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    res.json({
      ok: true,
      capture: { updated: capture.created, skipped: capture.synced - capture.created, errors: capture.errors },
      review: { updated: review.created, skipped: review.synced - review.created, errors: review.errors },
      elapsed,
      total: tabs.length,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/batch-create — 폴더 일괄 생성 (새 구조)
// ═══════════════════════════════════════════════════════════
router.post('/batch-create', authMiddleware, async (req, res, next) => {
  try {
    const { target } = req.body; // 'capture', 'review', 'both'
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url, capture_folder_url
       FROM tab_configs
       WHERE (is_closed = FALSE OR is_closed IS NULL)`
    );

    const startTime = Date.now();
    const captureStats = { created: 0, exists: 0, skipped: 0 };
    const reviewStats  = { created: 0, exists: 0, skipped: 0 };
    const errorList = [];

    const sheetTitleCache = {};

    for (const tab of tabs) {
      try {
        if (!sheetTitleCache[tab.sheet_id]) {
          sheetTitleCache[tab.sheet_id] = await getSheetTitle(tab.sheet_id, tab.campaign_name);
        }
        const sheetTitle = sheetTitleCache[tab.sheet_id];

        // 캡처폴더
        if (!target || target === 'both' || target === 'capture') {
          if (tab.capture_folder_url) {
            captureStats.exists++;
          } else {
            const result = await driveService.ensureCaptureFolderPath(rootFolderId, sheetTitle, tab.tab_name);
            await pool.query(
              'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
              [result.url, tab.sheet_id, tab.tab_name]
            );
            captureStats.created++;
          }
        }

        // 리뷰폴더
        if (!target || target === 'both' || target === 'review') {
          if (tab.folder_url) {
            reviewStats.exists++;
          } else {
            const result = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tab.tab_name);
            await pool.query(
              'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
              [result.url, tab.sheet_id, tab.tab_name]
            );
            reviewStats.created++;
          }
        }
      } catch (err) {
        logger.error(`[batchCreate] 오류 (${tab.tab_name}): ${err.message}`);
        errorList.push(`${tab.tab_name}: ${err.message}`);
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    res.json({ ok: true, capture: captureStats, review: reviewStats, errors: errorList, elapsed, total: tabs.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/reset-folder-urls — 폴더 URL 재설정
// ═══════════════════════════════════════════════════════════
router.post('/reset-folder-urls', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, target } = req.body;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    const updates = {};
    if (!target || target === 'both' || target === 'capture') updates.capture_folder_url = '';
    if (!target || target === 'both' || target === 'review') updates.folder_url = '';

    const entries = Object.entries(updates);
    const setClause = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const values = entries.map(([, v]) => v);

    await pool.query(
      `UPDATE tab_configs SET ${setClause}, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName, ...values]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/migrate-names — 폴더명 마이그레이션 (새 구조 적용)
// ═══════════════════════════════════════════════════════════
router.post('/migrate-names', authMiddleware, async (req, res, next) => {
  try {
    const { target, dryRun } = req.body;
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query('SELECT * FROM tab_configs');
    let renamed = 0, errors = 0;
    const actions = [];

    for (const tab of tabs) {
      try {
        // 리뷰폴더
        if ((!target || target === 'both' || target === 'review') && tab.folder_url) {
          const folderId = extractFolderId(tab.folder_url);
          if (folderId) {
            const newName = `[리뷰]`;
            if (!dryRun) {
              await driveService.renameFile(folderId, newName);
            }
            actions.push({ type: 'review', tabName: tab.tab_name, newName });
            renamed++;
          }
        }
        // 캡처폴더
        if ((!target || target === 'both' || target === 'capture') && tab.capture_folder_url) {
          const folderId = extractFolderId(tab.capture_folder_url);
          if (folderId) {
            const newName = `[구매캡처]`;
            if (!dryRun) {
              await driveService.renameFile(folderId, newName);
            }
            actions.push({ type: 'capture', tabName: tab.tab_name, newName });
            renamed++;
          }
        }
      } catch (err) {
        errors++;
      }
    }

    res.json({ ok: true, renamed, errors, dryRun: !!dryRun, actions });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/migrate-to-new-structure — 기존 파일을 새 폴더 구조로 복사 이관
//
// ★ 복사(Copy) 방식: 기존 폴더의 파일을 그대로 유지하고, 새 구조에 사본을 생성
//    → 기존 시스템에서 참조하는 링크/파일이 유실되지 않음
//    → 스토리지는 2배 사용되지만 안전한 이관
//
// 기존: DRIVE_ROOT / [캡처] 캠페인명 / 파일 (원본 유지)
// 새:   AI_REVIEW / 시트제목 / 탭명 / [구매캡처] / 파일 (사본)
//
// 기존: DRIVE_ROOT / [리뷰] 캠페인명 / 파일 (원본 유지)
// 새:   AI_REVIEW / 시트제목 / 탭명 / [리뷰] / 파일 (사본)
// ═══════════════════════════════════════════════════════════
router.post('/migrate-to-new-structure', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun } = req.body;
    const isDryRun = dryRun === true || dryRun === 'true';
    const newRootId = getRootFolderId();

    if (!newRootId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url, capture_folder_url
       FROM tab_configs
       WHERE (folder_url IS NOT NULL AND folder_url <> '')
          OR (capture_folder_url IS NOT NULL AND capture_folder_url <> '')`
    );

    const startTime = Date.now();
    const migrated = [], skipped = [], errorList = [];
    const sheetTitleCache = {};

    for (const tab of tabs) {
      try {
        if (!sheetTitleCache[tab.sheet_id]) {
          sheetTitleCache[tab.sheet_id] = await getSheetTitle(tab.sheet_id, tab.campaign_name);
        }
        const sheetTitle = sheetTitleCache[tab.sheet_id];

        // ── 캡처폴더 이관 (복사) ──
        if (tab.capture_folder_url) {
          const oldFolderId = extractFolderId(tab.capture_folder_url);
          if (oldFolderId) {
            const newCapture = await driveService.ensureCaptureFolderPath(newRootId, sheetTitle, tab.tab_name);

            if (!isDryRun) {
              try {
                const files = await driveService.listFolderContents(oldFolderId);
                let copied = 0;
                for (const file of files) {
                  // 폴더는 재귀 복사 불가 → 건너뜀 (서브폴더는 별도 처리 필요)
                  if (file.mimeType === 'application/vnd.google-apps.folder') {
                    skipped.push({ type: 'capture', tabName: tab.tab_name, fileName: file.name, reason: '서브폴더 — 수동 이관 필요' });
                    continue;
                  }
                  await driveService.copyFile(file.id, newCapture.id);
                  copied++;
                }
                // tab_configs의 capture_folder_url을 새 경로로 업데이트
                await pool.query(
                  'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
                  [newCapture.url, tab.sheet_id, tab.tab_name]
                );
                migrated.push({
                  type: 'capture', tabName: tab.tab_name,
                  fileCount: copied, totalFiles: files.length,
                  newPath: newCapture.path.join(' → '),
                  oldUrl: tab.capture_folder_url,
                  newUrl: newCapture.url,
                });
              } catch (copyErr) {
                errorList.push({ type: 'capture', tabName: tab.tab_name, error: copyErr.message });
              }
            } else {
              // dryRun: 파일 개수만 조회
              try {
                const files = await driveService.listFolderContents(oldFolderId);
                migrated.push({
                  type: 'capture', tabName: tab.tab_name, dryRun: true,
                  fileCount: files.length,
                  newPath: newCapture.path.join(' → '),
                  oldUrl: tab.capture_folder_url,
                });
              } catch (_) {
                migrated.push({ type: 'capture', tabName: tab.tab_name, dryRun: true, fileCount: '조회실패', newPath: newCapture.path.join(' → ') });
              }
            }
          }
        }

        // ── 리뷰폴더 이관 (복사) ──
        if (tab.folder_url) {
          const oldFolderId = extractFolderId(tab.folder_url);
          if (oldFolderId) {
            const newReview = await driveService.ensureReviewFolderPath(newRootId, sheetTitle, tab.tab_name);

            if (!isDryRun) {
              try {
                const files = await driveService.listFolderContents(oldFolderId);
                let copied = 0;
                for (const file of files) {
                  if (file.mimeType === 'application/vnd.google-apps.folder') {
                    skipped.push({ type: 'review', tabName: tab.tab_name, fileName: file.name, reason: '서브폴더 — 수동 이관 필요' });
                    continue;
                  }
                  await driveService.copyFile(file.id, newReview.id);
                  copied++;
                }
                await pool.query(
                  'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
                  [newReview.url, tab.sheet_id, tab.tab_name]
                );
                migrated.push({
                  type: 'review', tabName: tab.tab_name,
                  fileCount: copied, totalFiles: files.length,
                  newPath: newReview.path.join(' → '),
                  oldUrl: tab.folder_url,
                  newUrl: newReview.url,
                });
              } catch (copyErr) {
                errorList.push({ type: 'review', tabName: tab.tab_name, error: copyErr.message });
              }
            } else {
              try {
                const files = await driveService.listFolderContents(oldFolderId);
                migrated.push({
                  type: 'review', tabName: tab.tab_name, dryRun: true,
                  fileCount: files.length,
                  newPath: newReview.path.join(' → '),
                  oldUrl: tab.folder_url,
                });
              } catch (_) {
                migrated.push({ type: 'review', tabName: tab.tab_name, dryRun: true, fileCount: '조회실패', newPath: newReview.path.join(' → ') });
              }
            }
          }
        }
      } catch (err) {
        logger.error(`[migrate] 오류 (${tab.tab_name}): ${err.message}`);
        errorList.push({ tabName: tab.tab_name, error: err.message });
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    res.json({
      ok: true,
      method: 'copy',
      note: '기존 폴더/파일은 그대로 유지됩니다. 새 구조에 사본이 생성됩니다.',
      migrated, skipped, errors: errorList,
      dryRun: isDryRun, elapsed, totalTabs: tabs.length,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/organize-capture — 캡처폴더 재배치 (레거시 호환)
// ═══════════════════════════════════════════════════════════
router.post('/organize-capture', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun } = req.body;
    const isDryRun = dryRun === true || dryRun === 'true';
    const rootFolderId = getRootFolderId();
    if (!rootFolderId) return res.json({ error: 'AI_REVIEW_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, capture_folder_url
       FROM tab_configs
       WHERE capture_folder_url IS NOT NULL AND capture_folder_url <> ''`
    );

    const moved = [], skippedList = [], errorList = [];
    const startTime = Date.now();

    let rootChildren = [];
    try {
      rootChildren = await driveService.listFolderContents(rootFolderId, 'application/vnd.google-apps.folder');
    } catch (listErr) {
      logger.warn(`[organizeCapture] 루트 폴더 목록 조회 실패: ${listErr.message}`);
    }
    const rootChildIds = new Set(rootChildren.map(f => f.id));

    for (const tab of tabs) {
      try {
        const folderId = extractFolderId(tab.capture_folder_url);
        if (!folderId) { skippedList.push({ folder: tab.tab_name, reason: 'URL 파싱 실패' }); continue; }

        if (rootChildIds.has(folderId)) {
          skippedList.push({ folder: tab.tab_name, reason: '이미 루트 폴더 내' });
          continue;
        }

        if (!isDryRun) {
          await driveService.moveFile(folderId, rootFolderId, null);
        }
        moved.push({ folder: tab.tab_name, folderId, campFolder: tab.campaign_name || tab.tab_name });
      } catch (err) {
        logger.error(`[organizeCapture] 오류 (${tab.tab_name}): ${err.message}`);
        errorList.push({ folder: tab.tab_name, message: err.message });
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    res.json({ ok: true, moved, created: [], skipped: skippedList, errors: errorList, dryRun: isDryRun, elapsed });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/save-capture — 캡처폴더 URL 저장
// ═══════════════════════════════════════════════════════════
router.post('/save-capture', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, folderUrl } = req.body;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    await pool.query(
      'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
      [folderUrl || '', sheetId, tabName]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/update-urls — 폴더 URL 강제 수정
// ═══════════════════════════════════════════════════════════
router.post('/update-urls', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, urls } = req.body;
    if (!sheetId || !tabName) return res.json({ error: 'sheetId, tabName 필요' });

    const updates = {};
    if (urls?.folderUrl !== undefined) updates.folder_url = urls.folderUrl;
    if (urls?.captureFolderUrl !== undefined) updates.capture_folder_url = urls.captureFolderUrl;

    const entries = Object.entries(updates);
    if (entries.length === 0) return res.json({ error: '업데이트할 URL이 없습니다.' });

    const setClause = entries.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const values = entries.map(([, v]) => v);

    await pool.query(
      `UPDATE tab_configs SET ${setClause}, updated_at = NOW() WHERE sheet_id = $1 AND tab_name = $2`,
      [sheetId, tabName, ...values]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/find-candidates — 탭(gid)으로 Drive 폴더 후보 검색
//   캡처/리뷰 폴더가 "사라진" 경우 탭명으로 실제 폴더를 찾아 재연결을 돕는다.
//   - 자동 폴더(시트제목/탭명/[구매캡처]·[리뷰])와 수동 브랜드 폴더를 모두 후보로 반환
//   - 각 후보의 파일수·리뷰형식 파일수·상위폴더·소유자 + 추천(guess) 제공
//   - 현재 연결과 비교해 위치 불일치(drift) 경고
// ═══════════════════════════════════════════════════════════
router.post('/find-candidates', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, query } = req.body;
    if (!tabName) return res.json({ ok: false, error: 'tabName 필요' });

    // 현재 연결 상태 (컨텍스트)
    let current = { folderUrl: '', captureFolderUrl: '' };
    if (sheetId) {
      const { rows } = await pool.query(
        'SELECT folder_url, capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      if (rows[0]) current = { folderUrl: rows[0].folder_url || '', captureFolderUrl: rows[0].capture_folder_url || '' };
    }

    // 검색어: 직접 지정 우선, 없으면 탭명에서 자동 추출
    const terms = (query && String(query).trim())
      ? [String(query).trim()]
      : driveService.deriveFolderSearchTerms(tabName);

    // 검색 & 병합
    const byId = new Map();
    for (const term of terms) {
      const found = await driveService.searchFolders(term, { limit: 30 });
      for (const f of found) if (!byId.has(f.id)) byId.set(f.id, f);
    }
    const folders = [...byId.values()].slice(0, 15); // 심층조회 상한

    const nameCache = new Map();
    const parentName = async (id) => {
      if (!id) return '';
      if (nameCache.has(id)) return nameCache.get(id);
      const meta = await driveService.getFolderMeta(id);
      const n = meta ? meta.name : '';
      nameCache.set(id, n);
      return n;
    };

    const candidates = [];
    const seen = new Set();
    const pushCand = (c) => { if (!seen.has(c.id)) { seen.add(c.id); candidates.push(c); } };

    for (const f of folders) {
      const insp = await driveService.inspectFolder(f.id);
      const pName = await parentName((f.parents || [])[0]);

      // 하위 [구매캡처]/[리뷰] 폴더를 직접 후보로 노출
      for (const sub of insp.subfolders) {
        if (sub.name === '[구매캡처]' || sub.name === '[리뷰]') {
          const sInsp = await driveService.inspectFolder(sub.id);
          pushCand({
            id: sub.id, name: sub.name,
            url: `https://drive.google.com/drive/folders/${sub.id}`,
            parentName: f.name, owner: f.owner, createdTime: f.createdTime,
            fileCount: sInsp.fileCount, reviewLikeCount: sInsp.reviewLikeCount,
            subfolders: [], guess: sub.name === '[구매캡처]' ? 'capture' : 'review',
          });
        }
      }

      // 매칭된 폴더 자체
      let guess = 'unknown';
      if (f.name === '[구매캡처]') guess = 'capture';
      else if (f.name === '[리뷰]') guess = 'review';
      else if (insp.subfolders.some(s => s.name === '[구매캡처]' || s.name === '[리뷰]')) guess = 'container';
      else if (insp.reviewLikeCount > 0) guess = 'review';
      else if (insp.fileCount > 0) guess = 'capture';
      pushCand({
        id: f.id, name: f.name,
        url: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`,
        parentName: pName, owner: f.owner, createdTime: f.createdTime,
        fileCount: insp.fileCount, reviewLikeCount: insp.reviewLikeCount,
        subfolders: insp.subfolders.map(s => s.name), guess,
      });
    }

    // 위치 불일치(drift) 경고
    const warnings = [];
    const curReviewId = extractFolderId(current.folderUrl);
    if (curReviewId) {
      const curInsp = await driveService.inspectFolder(curReviewId);
      const hasReviewElsewhere = candidates.some(c => c.id !== curReviewId && c.reviewLikeCount > 0);
      if (curInsp.fileCount === 0 && hasReviewElsewhere) {
        warnings.push('현재 연결된 리뷰폴더가 비어 있고, 리뷰 이미지가 다른 폴더에 있습니다. 위치 불일치(drift)로 보입니다.');
      }
    } else {
      warnings.push('현재 리뷰폴더(folder_url)가 연결되어 있지 않습니다.');
    }
    if (!current.captureFolderUrl) warnings.push('현재 캡처폴더(capture_folder_url)가 연결되어 있지 않습니다.');

    // 정렬: 추천(capture/review) 우선, 파일 많은 순
    const order = { capture: 0, review: 0, container: 1, unknown: 2 };
    candidates.sort((a, b) => ((order[a.guess] ?? 3) - (order[b.guess] ?? 3)) || (b.fileCount - a.fileCount));

    res.json({ ok: true, sheetId: sheetId || '', tabName, searchTerms: terms, current, warnings, candidates });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/drive/diag — 폴더 현황 진단
// ═══════════════════════════════════════════════════════════
router.get('/diag', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             campaign_name AS "campaignName",
             folder_url AS "folderUrl", capture_folder_url AS "captureFolderUrl",
             is_closed AS "isClosed"
      FROM tab_configs
      ORDER BY tab_name
    `);
    const noFolder = rows.filter(r => !r.folderUrl);
    const noCapture = rows.filter(r => !r.captureFolderUrl);

    // 실제 OAuth 계정/쿼터 — "용량이 어느 계정에 귀속되는지" 확인용
    let accountDiagnostics = null;
    try {
      accountDiagnostics = await driveService.getAccountDiagnostics();
    } catch (e) {
      accountDiagnostics = { error: e.message };
    }

    res.json({
      ok: true,
      total: rows.length,
      noFolderUrl: noFolder.length,
      noCaptureFolderUrl: noCapture.length,
      rootFolderId: getRootFolderId() || '미설정',
      oauthStatus: driveService.getOAuthStatus(),
      accountDiagnostics,
      details: rows,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/drive/list-folder — 폴더 내용 조회 (복구용 임시 엔드포인트)
// ═══════════════════════════════════════════════════════════
router.get('/list-folder', authMiddleware, async (req, res, next) => {
  try {
    const { folderId, type } = req.query;
    const targetId = folderId || getRootFolderId();
    if (!targetId) return res.json({ error: 'folderId 또는 AI_REVIEW_FOLDER_ID 미설정' });

    const mimeType = type === 'folder' ? 'application/vnd.google-apps.folder' : null;
    const files = await driveService.listFolderContents(targetId, mimeType);
    res.json({ ok: true, folderId: targetId, count: files.length, files });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/check-duplicates — 리뷰폴더 중복 파일 검사
// body: { folderUrls: [ "https://drive.google.com/drive/folders/xxx", ... ] }
// ═══════════════════════════════════════════════════════════
router.post('/check-duplicates', authMiddleware, async (req, res, next) => {
  try {
    const { folderUrls } = req.body;
    if (!folderUrls || !Array.isArray(folderUrls) || folderUrls.length === 0) {
      return res.json({ error: '검사할 폴더 URL이 없습니다.' });
    }

    const results = [];
    let totalDuplicateFiles = 0;

    for (const url of folderUrls) {
      const folderId = extractFolderId(url);
      if (!folderId) {
        results.push({ url, error: '폴더 ID 추출 실패' });
        continue;
      }

      try {
        const dupResult = await driveService.detectDuplicates(folderId);
        totalDuplicateFiles += dupResult.duplicateFileCount;
        results.push({
          url,
          folderId,
          totalFiles: dupResult.totalFiles,
          duplicateGroups: dupResult.duplicateGroups,
          duplicateFileCount: dupResult.duplicateFileCount,
          duplicates: dupResult.duplicates.map(g => ({
            md5: g.md5,
            keep: { id: g.keep.id, name: g.keep.name, size: g.keep.size, createdTime: g.keep.createdTime },
            remove: g.remove.map(f => ({ id: f.id, name: f.name, size: f.size, createdTime: f.createdTime })),
          })),
        });
      } catch (err) {
        logger.error(`[checkDuplicates] 폴더 검사 실패 (${folderId}): ${err.message}`);
        results.push({ url, folderId, error: err.message });
      }
    }

    res.json({ ok: true, results, totalDuplicateFiles });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/remove-duplicates — 중복 파일 제거 (휴지통 이동)
// body: { fileIds: ["fileId1", "fileId2", ...] }
// ═══════════════════════════════════════════════════════════
router.post('/remove-duplicates', authMiddleware, async (req, res, next) => {
  try {
    const { fileIds } = req.body;
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.json({ error: '삭제할 파일 ID가 없습니다.' });
    }

    const filesToTrash = fileIds.map(id => ({ id, name: id }));
    const result = await driveService.trashFiles(filesToTrash);

    res.json({
      ok: true,
      success: result.success,
      failed: result.failed,
      errors: result.errors,
      message: `${result.success}개 중복 파일이 휴지통으로 이동되었습니다.`,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/check-submission-status — 리뷰폴더 마감검사 (강화)
//
// 탭별 독립 검사:
//   (a) 중복제출: 동일 수취인명 파일이 2개 이상
//   (b) 미제출자: 탭에 수취인명 있으나 폴더에 파일 없음
//   (c) 고아파일: 폴더에 파일 있으나 탭에 수취인명 없음
//
// body: { tabs: [ { sheetId, tabName, folderUrl } ] }
// ═══════════════════════════════════════════════════════════
router.post('/check-submission-status', authMiddleware, async (req, res, next) => {
  try {
    const { tabs } = req.body;
    if (!tabs || !Array.isArray(tabs) || tabs.length === 0) {
      return res.json({ error: '검사할 탭 정보가 없습니다.' });
    }

    const results = [];

    for (const tab of tabs) {
      const { sheetId, tabName, folderUrl } = tab;
      if (!sheetId || !tabName || !folderUrl) {
        results.push({ sheetId, tabName, error: '필수 정보 누락 (sheetId, tabName, folderUrl)' });
        continue;
      }

      const folderId = extractFolderId(folderUrl);
      if (!folderId) {
        results.push({ sheetId, tabName, error: '폴더 ID 추출 실패' });
        continue;
      }

      try {
        // ── 1. DB에서 해당 탭의 수취인명 목록 조회 ──
        const { rows: dbRows } = await pool.query(
          `SELECT reviewer_name, recipient_name, row_index, is_submitted
           FROM review_index
           WHERE sheet_id = $1 AND tab_name = $2`,
          [sheetId, tabName]
        );

        // 수취인명 Set (recipient_name 우선, 없으면 reviewer_name fallback)
        const recipientSet = new Map(); // name → { rowIndex, isSubmitted }
        for (const row of dbRows) {
          const name = (row.recipient_name || row.reviewer_name || '').trim();
          if (!name) continue;
          // 동일 이름이 여러 행에 있을 수 있으므로 배열로 저장
          if (!recipientSet.has(name)) {
            recipientSet.set(name, []);
          }
          recipientSet.set(name, [...recipientSet.get(name), {
            rowIndex: row.row_index,
            isSubmitted: row.is_submitted
          }]);
        }

        // ── 2. Drive에서 폴더 내 모든 파일 재귀적 조회 ──
        const files = await driveService.listFolderFilesRecursive(folderId);

        // 파일명에서 수취인명 추출 → 그룹핑
        const filesByName = new Map(); // name → [ { file info } ]
        for (const file of files) {
          const extractedName = driveService.extractReviewerNameFromFile(file.name);
          if (!extractedName) continue;
          if (!filesByName.has(extractedName)) {
            filesByName.set(extractedName, []);
          }
          filesByName.get(extractedName).push({
            id: file.id,
            name: file.name,
            size: file.size,
            createdTime: file.createdTime,
            parentFolder: file.parentFolder,
          });
        }

        // ── 3. 네 가지 검사 수행 ──

        // (a) 파일 중복 (md5 해시 동일 — 물리적 동일 파일)
        const hashGroups = new Map();
        for (const file of files) {
          if (!file.md5Checksum) continue;
          if (!hashGroups.has(file.md5Checksum)) hashGroups.set(file.md5Checksum, []);
          hashGroups.get(file.md5Checksum).push({
            id: file.id,
            name: file.name,
            size: file.size,
            createdTime: file.createdTime,
            parentFolder: file.parentFolder,
          });
        }
        const fileDuplicates = [];
        for (const [hash, group] of hashGroups) {
          if (group.length < 2) continue;
          group.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
          fileDuplicates.push({
            md5: hash,
            keep: group[0],
            remove: group.slice(1),
          });
        }

        // (b) 중복제출: 동일 수취인명 파일이 2세트 이상 (동일인의 복수 이미지는 1세트)
        // 세트 판정: 같은 이름_같은 타임스탬프를 1세트로 봄
        const duplicateSubmissions = [];
        for (const [name, fileList] of filesByName) {
          // 타임스탬프별 그룹핑: 이름_순번_YYYYMMDD_HHMMSS → YYYYMMDD_HHMMSS 추출
          const tsGroups = new Map();
          for (const f of fileList) {
            // 파일명에서 타임스탬프 추출: {이름}_{순번}_{YYYYMMDD}_{HHMMSS}.ext
            const m = f.name.match(/_(\d{8}_\d{6})\.\w+$/);
            const ts = m ? m[1] : 'unknown_' + f.createdTime;
            if (!tsGroups.has(ts)) tsGroups.set(ts, []);
            tsGroups.get(ts).push(f);
          }
          // 2세트 이상이면 중복제출
          if (tsGroups.size >= 2) {
            duplicateSubmissions.push({
              name,
              submissionCount: tsGroups.size,
              totalFiles: fileList.length,
              submissions: [...tsGroups.entries()].map(([ts, fls]) => ({
                timestamp: ts,
                files: fls,
              })),
            });
          }
        }

        // (c) 미제출자: DB에 수취인명 있으나 폴더에 파일 없음
        const missingSubmissions = [];
        for (const [name, rows] of recipientSet) {
          if (!filesByName.has(name)) {
            missingSubmissions.push({
              name,
              rowCount: rows.length,
              rows: rows.map(r => ({ rowIndex: r.rowIndex, isSubmitted: r.isSubmitted })),
            });
          }
        }

        // (d) 고아파일: 폴더에 파일 있으나 DB에 수취인명 없음
        const orphanFiles = [];
        for (const [name, fileList] of filesByName) {
          if (!recipientSet.has(name)) {
            orphanFiles.push({
              name,
              files: fileList,
            });
          }
        }

        results.push({
          sheetId,
          tabName,
          totalRecipients: recipientSet.size,
          totalFiles: files.length,
          totalFileNames: filesByName.size,
          fileDuplicates,
          duplicateSubmissions,
          missingSubmissions,
          orphanFiles,
          summary: {
            fileDuplicateCount: fileDuplicates.length,
            fileDuplicateFileCount: fileDuplicates.reduce((s, g) => s + g.remove.length, 0),
            duplicateCount: duplicateSubmissions.length,
            missingCount: missingSubmissions.length,
            orphanCount: orphanFiles.length,
          },
        });

        logger.info(`[check-submission-status] tab=${tabName}: recipients=${recipientSet.size}, files=${files.length}, dup=${duplicateSubmissions.length}, missing=${missingSubmissions.length}, orphan=${orphanFiles.length}`);
      } catch (tabErr) {
        logger.error(`[check-submission-status] tab=${tabName} 오류: ${tabErr.message}`);
        results.push({ sheetId, tabName, error: tabErr.message });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 구글드라이브 용량 귀속 점검·이전 (구매캡처/리뷰 폴더)
//
// 용량은 "파일 소유자" 계정에 귀속된다. 업로드는 OAuth(tnaks6325) 소유로
// 생성되도록 구현돼 있으나, (a) 토큰이 다른 계정이거나 (b) 과거 GAS가
// 만든 파일이 관리자 소유로 남아 있으면 관리자 용량이 차감된다.
// 아래 엔드포인트로 (1) 현재 귀속 계정 확인 (2) 소유자별 용량 집계
// (3) tnaks6325로 소유권 이전을 수행한다.
// ═══════════════════════════════════════════════════════════

/**
 * 헬퍼: 감사/이전 대상 폴더 ID 수집
 * - body.folderUrls 가 있으면 그것을, 없으면 tab_configs의 캡처+리뷰 폴더를 사용
 */
async function collectAuditFolderIds(body = {}) {
  const ids = [];
  if (Array.isArray(body.folderUrls) && body.folderUrls.length) {
    for (const u of body.folderUrls) {
      const id = extractFolderId(u);
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  }
  const includeClosed = body.includeClosed === true;
  const where = includeClosed ? '' : 'WHERE (is_closed = FALSE OR is_closed IS NULL)';
  const { rows } = await pool.query(`SELECT folder_url, capture_folder_url FROM tab_configs ${where}`);
  for (const r of rows) {
    const cap = extractFolderId(r.capture_folder_url);
    const rev = extractFolderId(r.folder_url);
    if (cap) ids.push(cap);
    if (rev) ids.push(rev);
  }
  return [...new Set(ids)];
}

// ───────────────────────────────────────────────────────────
// GET /api/drive/account-info — 현재 Drive OAuth 계정/쿼터 진단
//   "구매캡처/리뷰 업로드 용량이 어느 구글계정에 귀속되는지" 를 즉시 확인
//   (테스트 업로드 없이 about.get 만 호출 — 가벼움)
// ───────────────────────────────────────────────────────────
router.get('/account-info', authMiddleware, async (req, res, next) => {
  try {
    const info = await driveService.getAccountDiagnostics();
    res.json({ ok: true, ...info });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────────────────
// POST /api/drive/ownership-audit — 폴더 내 파일을 소유자별로 집계 (읽기전용)
//   body: { folderUrls?: [], includeClosed?: bool }
//   - folderUrls 미지정 시 tab_configs의 모든 캡처+리뷰 폴더를 재귀 스캔
//   - 응답: 소유자별 파일수/용량 → 관리자(박세희/박은비) 용량을 수치로 확인
// ───────────────────────────────────────────────────────────
router.post('/ownership-audit', authMiddleware, async (req, res, next) => {
  try {
    const folderIds = await collectAuditFolderIds(req.body || {});
    if (folderIds.length === 0) return res.json({ ok: false, error: '감사할 폴더가 없습니다.' });

    const startTime = Date.now();
    const result = await driveService.auditOwnership(folderIds);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    res.json({ ok: true, scannedFolders: folderIds.length, elapsed, ...result });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────────────────
// POST /api/drive/transfer-ownership — 비-tnaks 소유 파일을 tnaks6325로 이전
//   body: {
//     folderUrls?: [], includeClosed?: bool,
//     dryRun?: bool (기본 true — 계획만, 실제 변경 없음),
//     fromOwners?: ["관리자이메일", ...] (지정 시 해당 소유자 파일만),
//     sourceRefreshToken?: "관리자 계정 refresh token" (실제 이전에 필요할 수 있음),
//     targetOwnerEmail?: "tnaks6325@gmail.com" (기본 DRIVE_OWNER_EMAIL)
//   }
//
//   ⚠️ 소유권 이전은 "현재 소유자" 자격으로만 가능 (구글 제약).
//      관리자 소유 파일은 sourceRefreshToken(관리자 토큰) 없이는 403 실패하며
//      failures 에 기록된다(비파괴 — 데이터 삭제/복사 없음, 소유권만 변경).
// ───────────────────────────────────────────────────────────
router.post('/transfer-ownership', authMiddleware, async (req, res, next) => {
  try {
    const body = req.body || {};
    const folderIds = await collectAuditFolderIds(body);
    if (folderIds.length === 0) return res.json({ ok: false, error: '대상 폴더가 없습니다.' });

    const startTime = Date.now();
    const result = await driveService.transferOwnershipInFolders(folderIds, {
      targetOwnerEmail: body.targetOwnerEmail,
      dryRun: body.dryRun !== false,
      fromOwners: body.fromOwners,
      sourceRefreshToken: body.sourceRefreshToken,
    });
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    res.json({ ok: true, scannedFolders: folderIds.length, elapsed, ...result });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/relocate-orphan-reviews — 루트(또는 엉뚱한 위치)에 흩어진
//   리뷰 캡처를 해당 탭의 [리뷰] 폴더로 모아 이동(move)한다.
//
// 배경: 과거 일부 캠페인의 리뷰 업로드가 [리뷰] 폴더 ID를 확보하지 못한 채
//   실행되어, 파일이 "내 드라이브 최상위(루트)"에 흩어졌다. ([리뷰]는 0개)
//   이 엔드포인트는 OCR 전문검색(fullText=브랜드 키워드)으로 해당 캠페인의
//   리뷰형식 파일을 찾아 [리뷰] 폴더로 addParents/removeParents 이동한다.
//
// body: {
//   sheetId?, tabName?,            // tab_configs.folder_url 자동 조회용
//   reviewFolderUrl?,             // 대상 [리뷰] 폴더(미지정 시 tab_configs.folder_url)
//   brandKeywords: string|string[], // ★필수 — fullText 필터 (예: ["서일농원","명인 콩물"])
//   sinceDate?, untilDate?,       // createdTime 범위 (ISO, 예: 2026-06-01T00:00:00Z)
//   requireRoster?: bool,         // review_index 명단과 파일명 이름 일치 강제
//   excludeFolderUrls?: string[], // 절대 건드리지 않을 폴더(예: [구매캡처])
//   dryRun?: bool                 // 기본 true — 계획만, 실제 이동 없음
// }
//
// 안전장치:
//   - 리뷰형식 파일명(`{이름}_{순번}_{YYYYMMDD}_{HHMMSS}.ext`)만 대상 → 구매캡처(`{이름}.jpg`) 제외
//   - 대상 [리뷰] 폴더 / 제외 폴더 / 구매캡처 폴더에 이미 있는 파일은 건너뜀
//   - brandKeywords 필수 → 다른 캠페인 파일 오이동 방지
//   - dryRun 기본값 true
// ═══════════════════════════════════════════════════════════
router.post('/relocate-orphan-reviews', authMiddleware, async (req, res, next) => {
  try {
    const {
      sheetId, tabName, reviewFolderUrl,
      brandKeywords, sinceDate, untilDate,
      requireRoster, excludeFolderUrls, dryRun,
    } = req.body || {};

    const isDryRun = dryRun !== false; // 기본 true

    // ── 1) 대상 [리뷰] 폴더 확보 ──
    //   reviewFolderUrl(직접 지정) 우선, 없으면 tab_configs.folder_url.
    //   capture_folder_url은 sheetId/tabName이 있으면 항상 조회해 제외 폴더로 사용.
    let targetUrl = reviewFolderUrl || '';
    let captureUrl = '';
    if (sheetId && tabName) {
      const { rows } = await pool.query(
        'SELECT folder_url, capture_folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      if (!targetUrl) targetUrl = rows[0]?.folder_url || '';
      captureUrl = rows[0]?.capture_folder_url || '';
    }
    const targetId = extractFolderId(targetUrl);
    if (!targetId) {
      return res.json({ ok: false, error: '대상 [리뷰] 폴더를 확인할 수 없습니다. reviewFolderUrl 또는 tab_configs.folder_url 가 필요합니다.' });
    }

    // ── 2) 브랜드 키워드 (필수) ──
    const kws = (Array.isArray(brandKeywords) ? brandKeywords : [brandKeywords])
      .map(s => String(s || '').trim()).filter(Boolean);
    if (kws.length === 0) {
      return res.json({ ok: false, error: 'brandKeywords가 필요합니다. (예: ["서일농원","명인 콩물"])' });
    }

    // ── 3) 제외 폴더 집합 (대상/구매캡처/사용자지정) ──
    const excludeIds = new Set([targetId]);
    const capId = extractFolderId(captureUrl);
    if (capId) excludeIds.add(capId);
    for (const u of (excludeFolderUrls || [])) {
      const id = extractFolderId(u);
      if (id) excludeIds.add(id);
    }

    // ── 4) 인덱스 행(review_index) 로드 — 명단 필터 + 결정적 링크(B 백필) ──
    //   sheetId/tabName이 있으면 해당 탭 인덱스 행을 불러와
    //   (a) requireRoster 시 명단 필터, (b) 파일명 이름 ↔ 행 매칭으로 링크 백필.
    let indexRows = [];
    let roster = null;
    const doLink = !!(sheetId && tabName);
    if (doLink) {
      const { rows } = await pool.query(
        `SELECT id, row_index, reviewer_name, recipient_name, review_file_id
           FROM review_index WHERE sheet_id = $1 AND tab_name = $2`,
        [sheetId, tabName]
      );
      indexRows = rows;
    }
    if (requireRoster && indexRows.length) {
      roster = new Set();
      for (const r of indexRows) {
        const a = (r.recipient_name || '').trim(); if (a) roster.add(a);
        const b = (r.reviewer_name || '').trim(); if (b) roster.add(b);
      }
    }
    // 이름 → 인덱스 행(들) 매핑 (reviewer_name/recipient_name 모두 키)
    const rowsByName = new Map();
    const addRow = (nm, r) => {
      const k = (nm || '').trim(); if (!k) return;
      if (!rowsByName.has(k)) rowsByName.set(k, []);
      const arr = rowsByName.get(k); if (!arr.includes(r)) arr.push(r);
    };
    for (const r of indexRows) { addRow(r.reviewer_name, r); addRow(r.recipient_name, r); }

    // ── 5) 후보 검색 (fullText=브랜드 키워드) ──
    const byId = new Map();
    const searchStats = []; // 진단: 키워드별 SA/OAuth 검색 반환 수
    for (const kw of kws) {
      const safe = kw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      let q = `mimeType contains 'image/' and trashed = false and fullText contains '${safe}'`;
      if (sinceDate) q += ` and createdTime >= '${sinceDate}'`;
      if (untilDate) q += ` and createdTime <= '${untilDate}'`;
      const st = {};
      const files = await driveService.searchFiles(q, { limit: 1000, stats: st });
      searchStats.push({ kw, sa: st.sa, oauth: st.oauth, saError: st.saError, oauthError: st.oauthError });
      for (const f of files) if (!byId.has(f.id)) byId.set(f.id, f);
    }
    const searchFound = byId.size; // 검색이 반환한 전체(중복 제거) 이미지 수

    // ── 6) 분류: 이동대상(toMove) / 대상폴더내(linkOnly) / 제외 ──
    //   리뷰형식 파일명만: {이름}_{순번}_{YYYYMMDD}_{HHMMSS}.ext
    const reviewPattern = /_\d+_\d{8}_\d{6}\.[A-Za-z0-9]+$/;
    let reviewFormatCount = 0;
    const toMove = [];
    const linkOnly = []; // 이미 [리뷰] 폴더에 있음 → 이동 불필요, 링크만
    const skipped = [];
    for (const f of byId.values()) {
      if (!reviewPattern.test(f.name)) continue; // 구매캡처/기타 → 제외
      reviewFormatCount++;
      const parents = f.parents || [];
      if (roster) {
        const nm = driveService.extractReviewerNameFromFile(f.name);
        if (!nm || !roster.has(nm)) { skipped.push({ id: f.id, name: f.name, reason: '명단 불일치' }); continue; }
      }
      if (parents.includes(targetId)) { linkOnly.push(f); continue; }
      if (parents.some(p => excludeIds.has(p))) { skipped.push({ id: f.id, name: f.name, reason: '구매캡처/제외 폴더 내' }); continue; }
      toMove.push(f);
    }

    // ── 7) 이동 실행 (dryRun이면 계획만) ──
    const moved = [];
    const failed = [];
    if (!isDryRun) {
      for (const f of toMove) {
        try {
          const oldParents = (f.parents || []).join(',') || undefined;
          await driveService.moveFile(f.id, targetId, oldParents);
          moved.push({ id: f.id, name: f.name });
        } catch (e) {
          logger.error(`[relocate-orphan-reviews] 이동 실패 (${f.name}): ${e.message}`);
          failed.push({ id: f.id, name: f.name, error: e.message });
        }
      }
    }

    // ── 8) 결정적 링크 백필(B/A-1) + 제출 원장 적재(A-2) ──
    //   대상: 이동분 + 이미 [리뷰] 폴더에 있던 분. 모호하면 링크하지 않고 리포트하되
    //   파일 자체는 review_submissions 원장에 전수 기록(A-2).
    const linkResult = { linked: 0, ambiguous: 0, unmatched: 0, already: 0, recorded: 0, samples: { ambiguous: [], unmatched: [] } };
    if (doLink) {
      for (const f of [...toMove, ...linkOnly]) {
        const nm = (driveService.extractReviewerNameFromFile(f.name) || '').trim();
        const matchRows = rowsByName.get(nm) || [];
        const fileUrl = `https://drive.google.com/file/d/${f.id}/view`;
        let assocRow = null; // A-2 연결 인덱스 행 (확정 가능할 때만)

        if (matchRows.length === 0) {
          linkResult.unmatched++;
          if (linkResult.samples.unmatched.length < 30) linkResult.samples.unmatched.push(f.name);
        } else {
          const unlinked = matchRows.filter(r => !r.review_file_id);
          if (unlinked.length === 1) {
            // A-1: 결정적 매칭 1건 → review_index 링크
            assocRow = unlinked[0];
            if (!isDryRun) {
              try {
                await pool.query(
                  `UPDATE review_index
                      SET review_file_id = $1, review_file_url = $2, review_file_name = $3,
                          review_file_count = GREATEST(COALESCE(review_file_count, 0), 1),
                          review_file_at = COALESCE($4::timestamptz, NOW())
                    WHERE id = $5`,
                  [f.id, fileUrl, f.name, f.createdTime || null, assocRow.id]
                );
              } catch (e) {
                logger.warn(`[relocate-orphan-reviews] 링크 저장 실패 (${f.name}): ${e.message}`);
              }
            }
            assocRow.review_file_id = f.id; // 메모리 표시 → 같은 이름 추가 파일은 already
            linkResult.linked++;
          } else if (unlinked.length === 0) {
            linkResult.already++;
            if (matchRows.length === 1) assocRow = matchRows[0]; // 원장 연결은 가능
          } else {
            linkResult.ambiguous++;
            if (linkResult.samples.ambiguous.length < 30) linkResult.samples.ambiguous.push(f.name);
          }
        }

        // A-2: 제출 원장 적재 (전 후보 파일, file_id 업서트)
        if (!isDryRun) {
          try {
            await pool.query(
              `INSERT INTO review_submissions
                 (sheet_id, tab_name, tab_gid, row_index, reviewer_name, review_index_id,
                  file_id, file_url, file_name, source, uploaded_at)
               VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,'backfill',$9::timestamptz)
               ON CONFLICT (file_id) DO UPDATE
                 SET file_url = EXCLUDED.file_url, file_name = EXCLUDED.file_name,
                     row_index = COALESCE(EXCLUDED.row_index, review_submissions.row_index),
                     review_index_id = COALESCE(EXCLUDED.review_index_id, review_submissions.review_index_id),
                     reviewer_name = EXCLUDED.reviewer_name`,
              [sheetId, tabName, assocRow ? assocRow.row_index : null, nm || null,
               assocRow ? assocRow.id : null, f.id, fileUrl, f.name, f.createdTime || null]
            );
            linkResult.recorded++;
          } catch (e) {
            logger.warn(`[relocate-orphan-reviews] 제출원장 기록 실패 (${f.name}): ${e.message}`);
          }
        }
      }
    }

    res.json({
      ok: true,
      dryRun: isDryRun,
      targetFolderId: targetId,
      targetFolderUrl: `https://drive.google.com/drive/folders/${targetId}`,
      keywords: kws,
      indexRowCount: indexRows.length, // 탭의 작업건수(인덱스 행 수) — 과대매칭 판정 기준
      candidateCount: toMove.length,
      candidates: toMove.map(f => ({
        id: f.id, name: f.name,
        currentParents: f.parents || [],
        createdTime: f.createdTime, owner: f.owner,
      })),
      movedCount: moved.length,
      moved,
      failedCount: failed.length,
      failed,
      alreadyInTarget: linkOnly.length,
      link: linkResult, // 인덱스 결정적 링크 결과 (B)
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 100),
      // 진단: 서버 검색이 실제로 몇 건을 반환했는지 (0이면 계정/스코프/가시성 문제)
      diag: { searchFound, reviewFormatCount, searchStats },
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/drive/review-submissions — 탭별 리뷰 제출 원장 조회 (A-2)
//   query: { sheetId, tabName, limit? }
//   응답: 파일 단위 제출 목록 + 인덱스 연결 요약
// ═══════════════════════════════════════════════════════════
router.get('/review-submissions', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.query;
    if (!sheetId || !tabName) return res.json({ ok: false, error: 'sheetId, tabName 필요' });
    const lim = Math.min(parseInt(req.query.limit || '1000', 10) || 1000, 5000);

    const { rows } = await pool.query(
      `SELECT id, row_index, reviewer_name, review_index_id,
              file_id, file_url, file_name, source, uploaded_at, created_at
         FROM review_submissions
        WHERE sheet_id = $1 AND tab_name = $2
        ORDER BY uploaded_at DESC NULLS LAST, created_at DESC
        LIMIT $3`,
      [sheetId, tabName, lim]
    );
    const linkedToIndex = rows.filter(r => r.review_index_id).length;
    res.json({
      ok: true,
      total: rows.length,
      linkedToIndex,
      unlinked: rows.length - linkedToIndex,
      submissions: rows,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/move-folder-contents — 원본 폴더의 모든 파일을 대상 폴더로 이동
//   레거시/잘못된 위치(예: 관리자 소유 폴더)에 남은 파일을 [리뷰] 폴더로 비우기.
//   파일명 패턴 무관 전체 이동(서브폴더는 제외·리포트). dryRun 기본 true.
//   body: { fromFolderUrl, toFolderUrl, dryRun }
// ═══════════════════════════════════════════════════════════
router.post('/move-folder-contents', authMiddleware, async (req, res, next) => {
  try {
    const { fromFolderUrl, toFolderUrl, dryRun } = req.body || {};
    const fromId = extractFolderId(fromFolderUrl);
    const toId = extractFolderId(toFolderUrl);
    if (!fromId || !toId) return res.json({ ok: false, error: 'fromFolderUrl, toFolderUrl (둘 다 폴더 링크) 가 필요합니다.' });
    if (fromId === toId) return res.json({ ok: false, error: '원본과 대상 폴더가 같습니다.' });
    const isDryRun = dryRun !== false;

    // SA+OAuth 병합 조회 (원본이 tnaks6325에만 공유된 폴더여도 누락 없이)
    const items = await driveService.searchFiles(`'${fromId}' in parents and trashed = false`, { limit: 1000 });
    const folders = items.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

    const moved = [], failed = [];
    if (!isDryRun) {
      for (const f of files) {
        try {
          await driveService.moveFile(f.id, toId, fromId);
          moved.push({ id: f.id, name: f.name });
        } catch (e) {
          logger.error(`[move-folder-contents] 이동 실패 (${f.name}): ${e.message}`);
          failed.push({ id: f.id, name: f.name, error: e.message });
        }
      }
    }

    res.json({
      ok: true, dryRun: isDryRun, fromId, toId,
      total: files.length,
      files: files.map(f => ({ id: f.id, name: f.name })),
      subfolders: folders.map(f => f.name),
      movedCount: moved.length, moved,
      failedCount: failed.length, failed,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/folder-audit — 활성 탭(프론트 제공) 리뷰폴더 현황 점검
//   body: { tabs:[{sheetId,tabName,displayName,folderUrl}], excludeName, sinceDate }
//   - 활성 탭은 대시보드(_tabDashData)에서 받아 한정(마감 탭 제외)
//   - excludeName 포함 탭 제외(예: '리뷰폼')
//   - 각 폴더 파일수 + "가장 이른 이미지 날짜" → sinceDate(예 26-03-01) 이전 파일 유무 판정
//     (이미지가 모두 sinceDate 이후 = 26.3+ 캠페인 → 이관/정리 대상)
// ═══════════════════════════════════════════════════════════
router.post('/folder-audit', authMiddleware, async (req, res, next) => {
  try {
    const { tabs, excludeName, sinceDate } = req.body || {};
    if (!Array.isArray(tabs)) return res.json({ ok: false, error: 'tabs 배열이 필요합니다.' });
    const excl = (excludeName || '').trim();
    const sinceTs = sinceDate ? new Date(sinceDate).getTime() : null;

    // 폴더 파일수 + 가장 이른 이미지 생성일 (옵션 서브폴더까지 2단계)
    const scanFolder = async (folderId) => {
      let count = 0, earliest = null;
      const walk = async (fid, depth) => {
        const items = await driveService.searchFiles(`'${fid}' in parents and trashed = false`, { limit: 1000 });
        for (const f of items) {
          if (f.mimeType === 'application/vnd.google-apps.folder') { if (depth > 1) await walk(f.id, depth - 1); continue; }
          count++;
          if (f.mimeType && f.mimeType.indexOf('image/') === 0 && f.createdTime) {
            const ts = new Date(f.createdTime).getTime();
            if (earliest === null || ts < earliest) earliest = ts;
          }
        }
      };
      await walk(folderId, 2);
      return { count, earliest };
    };

    // 소유자 이메일 → 라벨(이관 범위 판정용). 알려진 관리자/서비스계정만 구분, 나머지는 '기타'
    const ownerLabel = (email) => {
      const e = (email || '').toLowerCase();
      if (!e) return 'unknown';
      if (e === 'tnaks6325@gmail.com') return 'tnaks6325';
      if (e === 'paksehui94@gmail.com') return '박세희';
      if (e === 'ebbbb97@gmail.com') return '박은비';
      if (e.indexOf('iam.gserviceaccount.com') >= 0) return 'service-account';
      return '기타';
    };

    let connected = 0, nonEmpty = 0, empty = 0, noFolder = 0, excluded = 0, preMarch = 0, errors = 0;
    const ownerTally = {}; // 연결된 폴더의 소유자 집계
    const details = [];
    for (const t of tabs) {
      const name = t.tabName || t.displayName || '';
      if (excl && name.indexOf(excl) >= 0) { excluded++; continue; } // 리뷰폼 등 제외
      const folderId = extractFolderId(t.folderUrl);
      if (!folderId) { noFolder++; details.push({ tab: name, status: 'no-folder' }); continue; }
      connected++;
      // 폴더 소유자 조회(이관 범위 판정) — 실패해도 스캔은 진행
      let owner = '', ownerLbl = 'unknown';
      try {
        const meta = await driveService.getFolderMeta(folderId);
        owner = (meta && meta.owner) || '';
        ownerLbl = ownerLabel(owner);
      } catch (_) {}
      ownerTally[ownerLbl] = (ownerTally[ownerLbl] || 0) + 1;
      try {
        const { count, earliest } = await scanFolder(folderId);
        const earliestIso = earliest ? new Date(earliest).toISOString().slice(0, 10) : null;
        const hasPre = (sinceTs !== null && earliest !== null && earliest < sinceTs);
        if (count > 0) {
          nonEmpty++;
          if (hasPre) preMarch++;
          details.push({ tab: name, status: 'has-files', count, earliest: earliestIso, preMarch: hasPre, owner, ownerLabel: ownerLbl });
        } else {
          empty++;
          details.push({ tab: name, status: 'empty', count: 0, owner, ownerLabel: ownerLbl });
        }
      } catch (e) {
        errors++; details.push({ tab: name, status: 'error', error: e.message, owner, ownerLabel: ownerLbl });
      }
    }

    res.json({
      ok: true,
      totalTabs: tabs.length,
      excluded,                 // 리뷰폼 등 제외된 탭 수
      connected,                // ① 리뷰폴더 연결된 탭 수
      nonEmpty,                 // ② 파일 있는(정상) 폴더 수
      preMarch,                 //   그중 26.3 이전 파일이 있어 대상에서 빠지는 수
      empty,                    // ③ 비어있는 폴더 수
      noFolder,                 // 폴더 미연결(비-리뷰폼) 수
      errors,
      ownerTally,               // 연결된 폴더의 소유자별 수 (이관 범위 판정)
      sinceDate: sinceDate || null,
      details,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/share-review-folder — 탭의 [리뷰] 폴더를 '링크공유(anyone reader)'로
//   만들어 업체 보고용 폴더 링크를 반환한다.
//
// 목적: 직원이 리뷰 이미지를 자기 드라이브에 복제(→ 직원 용량 차감)하지 않고도,
//   tnaks 소유 원본 [리뷰] 폴더 링크를 그대로 업체에 전달해 보고할 수 있게 한다.
//   (복제 0 · 직원 용량 0 · 업체는 로그인 없이 열람·다운로드)
//
// body: { sheetId?, tabName?, folderUrl? }
//   - folderUrl 우선 → 없으면 tab_configs.folder_url → 그래도 없으면 [리뷰] 폴더를
//     생성·연결한 뒤 공유(미연결 탭이어도 유효한 링크 확보, 빈 폴더 가능).
// 비파괴: 파일 이동/복제 없음. 폴더에 읽기 권한만 부여(드라이브에서 언제든 해제 가능).
// ═══════════════════════════════════════════════════════════
router.post('/share-review-folder', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, folderUrl } = req.body || {};

    // ── 1) 대상 [리뷰] 폴더 확보 ──
    let url = (folderUrl || '').trim();
    if (!url && sheetId && tabName) {
      const { rows } = await pool.query(
        'SELECT folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
        [sheetId, tabName]
      );
      url = rows[0]?.folder_url || '';
    }
    let folderId = extractFolderId(url);

    // 미연결 탭이면 [리뷰] 폴더를 생성·연결 (빈 폴더라도 유효한 링크 확보)
    let created = false;
    if (!folderId) {
      if (!sheetId || !tabName) {
        return res.json({ ok: false, error: '폴더를 찾을 수 없습니다. folderUrl 또는 sheetId+tabName이 필요합니다.' });
      }
      const rootFolderId = getRootFolderId();
      if (!rootFolderId) return res.json({ ok: false, error: 'AI_REVIEW_FOLDER_ID 미설정' });
      const sheetTitle = await getSheetTitle(sheetId, tabName);
      const result = await driveService.ensureReviewFolderPath(rootFolderId, sheetTitle, tabName);
      folderId = result.id;
      url = result.url;
      created = true;
      await pool.query(
        'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
        [url, sheetId, tabName]
      );
    }

    // ── 2) 링크공유(anyone reader) 설정 (idempotent) ──
    const share = await driveService.setFolderAnyoneReader(folderId);

    // ── 3) 폴더 내 파일 수(참고용 — 실패해도 무시) ──
    let fileCount = null;
    try {
      const items = await driveService.listFolderContents(folderId);
      fileCount = items.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').length;
    } catch (_) {}

    res.json({
      ok: true,
      folderId,
      folderUrl: url || `https://drive.google.com/drive/folders/${folderId}`,
      alreadyShared: share.alreadyShared,
      created,
      fileCount,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// 업체 보고용 공개 링크 (탭 단위)
//   - POST /report-link (관리자): 탭당 추측불가 코드 발급(재생성 시 동일 코드 재사용)
//   - GET  /report/:code (공개): 코드 → 탭의 리뷰 이미지 목록 반환(이미지 자체는
//     기존 /api/drive/image/:id 프록시로 표시 → 폴더 공개공유 불필요, 원본 복제 0)
// ═══════════════════════════════════════════════════════════
const _REPORT_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // 혼동문자 제외
function _genReportCode(len = 10) {
  let c = '';
  for (let i = 0; i < len; i++) c += _REPORT_CODE_CHARS.charAt(Math.floor(Math.random() * _REPORT_CODE_CHARS.length));
  return c;
}
function _frontendBase() {
  return (process.env.FRONTEND_URL || 'https://review-web-system.pages.dev').replace(/\/+$/, '');
}

// 탭당 보고 코드 확보 (없으면 생성, 있으면 재사용 — 동일 링크 유지)
async function _ensureReportCode(sheetId, tabName, displayName, createdBy) {
  const found = await pool.query(
    'SELECT code FROM review_report_links WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
    [sheetId, tabName]
  );
  if (found.rows[0]) {
    if (displayName) {
      await pool.query('UPDATE review_report_links SET display_name = $1 WHERE code = $2', [displayName, found.rows[0].code]);
    }
    return found.rows[0].code;
  }
  for (let i = 0; i < 12; i++) {
    const c = _genReportCode();
    try {
      await pool.query(
        'INSERT INTO review_report_links (code, sheet_id, tab_name, display_name, created_by) VALUES ($1, $2, $3, $4, $5)',
        [c, sheetId, tabName, displayName || null, createdBy || null]
      );
      return c;
    } catch (e) {
      if (e.code === '23505') {
        // 탭 유니크 충돌(동시 생성) → 기존 코드 재선택 / 코드 충돌이면 재시도
        const r = await pool.query('SELECT code FROM review_report_links WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1', [sheetId, tabName]);
        if (r.rows[0]) return r.rows[0].code;
        continue;
      }
      throw e;
    }
  }
  throw new Error('보고 코드 생성 실패');
}

// POST /api/drive/report-link — 탭의 업체 보고용 공개 링크 발급(관리자)
//   body: { sheetId, tabName, displayName? }
router.post('/report-link', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, displayName } = req.body || {};
    if (!sheetId || !tabName) return res.json({ ok: false, error: 'sheetId, tabName이 필요합니다.' });
    const createdBy = (req.user && (req.user.username || req.user.email || req.user.id)) || null;
    const code = await _ensureReportCode(sheetId, tabName, (displayName || '').trim() || null, createdBy);
    res.json({
      ok: true,
      code,
      reportUrl: `${_frontendBase()}/report.html?r=${code}`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/drive/report/:code — 공개: 코드 → 탭 리뷰 이미지 목록 (무인증)
//   review_submissions 원장 우선 → 비어 있으면 [리뷰] 폴더 라이브 스캔 폴백.
router.get('/report/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!/^[a-z2-9]{6,16}$/.test(code)) return res.status(404).json({ ok: false, error: '유효하지 않은 링크입니다.' });

    const { rows } = await pool.query(
      'SELECT sheet_id, tab_name, display_name FROM review_report_links WHERE code = $1 LIMIT 1',
      [code]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: '유효하지 않은 링크입니다.' });
    const { sheet_id: sheetId, tab_name: tabName, display_name: displayName } = rows[0];

    // 1) 제출 원장 우선
    let images = [];
    try {
      const sub = await pool.query(
        `SELECT file_id, file_name, reviewer_name, uploaded_at
           FROM review_submissions
          WHERE sheet_id = $1 AND tab_name = $2 AND file_id IS NOT NULL AND file_id <> ''
          ORDER BY reviewer_name NULLS LAST, uploaded_at ASC NULLS LAST`,
        [sheetId, tabName]
      );
      images = sub.rows.map(r => ({
        id: r.file_id,
        name: r.file_name || '',
        reviewer: (r.reviewer_name || driveService.extractReviewerNameFromFile(r.file_name) || '').trim(),
      }));
    } catch (_) {}

    // 2) 원장이 비어 있으면 [리뷰] 폴더 라이브 스캔 폴백
    if (images.length === 0) {
      try {
        const { rows: tcfg } = await pool.query(
          'SELECT folder_url FROM tab_configs WHERE sheet_id = $1 AND tab_name = $2 LIMIT 1',
          [sheetId, tabName]
        );
        const folderId = extractFolderId(tcfg[0]?.folder_url);
        if (folderId) {
          const files = await driveService.listFolderFilesRecursive(folderId);
          images = files
            .filter(f => (f.mimeType || '').indexOf('image/') === 0 || /\.(jpe?g|png|gif|webp)$/i.test(f.name || ''))
            .map(f => ({ id: f.id, name: f.name || '', reviewer: (driveService.extractReviewerNameFromFile(f.name) || '').trim() }));
        }
      } catch (e) {
        logger.warn(`[report] 폴더 스캔 폴백 실패 (${code}): ${e.message}`);
      }
    }

    res.json({
      ok: true,
      title: (displayName || tabName || '리뷰 보고'),
      count: images.length,
      images,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/drive/image/:id — Drive 이미지 스트리밍 프록시 (모달 인라인 미리보기)
//   <img src>가 헤더 인증을 못 보내므로 무인증. id는 추측 불가한 Drive fileId(20+).
//   서버 OAuth(소유자 계정)로 받아 스트리밍 → 비공개/링크공유 섞여도 표시.
//   실패 시 Drive thumbnail로 302 폴백.
// ═══════════════════════════════════════════════════════════
router.get('/image/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[-\w]{20,}$/.test(id)) return res.status(400).send('bad id');
  try {
    const f = await driveService.downloadFile(id);
    res.set('Content-Type', f.mimeType || 'application/octet-stream');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'private, max-age=600');
    return res.send(f.buffer);
  } catch (err) {
    logger.warn(`[drive] image 프록시 실패(${id}): ${err.message} → thumbnail 폴백`);
    return res.redirect(302, `https://drive.google.com/thumbnail?id=${id}&sz=w1600`);
  }
});

module.exports = router;