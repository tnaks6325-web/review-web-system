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
    res.json({
      ok: true,
      total: rows.length,
      noFolderUrl: noFolder.length,
      noCaptureFolderUrl: noCapture.length,
      rootFolderId: getRootFolderId() || '미설정',
      oauthStatus: driveService.getOAuthStatus(),
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

        // ── 3. 세 가지 검사 수행 ──
        // (a) 중복제출: 동일 수취인명 파일이 2세트 이상 (동일인의 복수 이미지는 1세트)
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

        // (b) 미제출자: DB에 수취인명 있으나 폴더에 파일 없음
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

        // (c) 고아파일: 폴더에 파일 있으나 DB에 수취인명 없음
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
          duplicateSubmissions,
          missingSubmissions,
          orphanFiles,
          summary: {
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

module.exports = router;