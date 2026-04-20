const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const driveService = require('../services/drive.service');
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

// ═══════════════════════════════════════════════════════════
// POST /api/drive/sync-capture — 캡처폴더 동기화 (GAS: syncCaptureFolders)
// ═══════════════════════════════════════════════════════════
router.post('/sync-capture', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) return res.json({ error: 'DRIVE_ROOT_FOLDER_ID 미설정' });

    // 활성 탭 목록 조회
    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, capture_folder_url
       FROM tab_configs
       WHERE (force_done = FALSE OR force_done IS NULL)
         AND (is_closed = FALSE OR is_closed IS NULL)`
    );

    let synced = 0, created = 0, errors = 0;

    for (const tab of tabs) {
      try {
        if (tab.capture_folder_url && !force) {
          synced++;
          continue;
        }

        // 캡처폴더 검색/생성
        const folderName = `[캡처] ${tab.campaign_name || tab.tab_name}`;
        let folder = null;

        try {
          folder = await driveService.findFolderByName(folderName, rootFolderId);
        } catch (_) { /* 폴더 미발견 */ }

        if (!folder) {
          folder = await driveService.createFolder(folderName, rootFolderId);
          created++;
        }

        // tab_configs에 URL 저장
        if (folder) {
          const folderUrl = `https://drive.google.com/drive/folders/${folder.id}`;
          await pool.query(
            'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [folderUrl, tab.sheet_id, tab.tab_name]
          );
        }
        synced++;
      } catch (err) {
        logger.error(`[syncCapture] 오류 (${tab.tab_name}): ${err.message}`);
        errors++;
      }
    }

    res.json({ ok: true, synced, created, errors, total: tabs.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/sync-review — 리뷰폴더 동기화 (GAS: syncReviewFolders)
// ═══════════════════════════════════════════════════════════
router.post('/sync-review', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) return res.json({ error: 'DRIVE_ROOT_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url
       FROM tab_configs
       WHERE (force_done = FALSE OR force_done IS NULL)
         AND (is_closed = FALSE OR is_closed IS NULL)`
    );

    let synced = 0, created = 0, errors = 0;

    for (const tab of tabs) {
      try {
        if (tab.folder_url && !force) { synced++; continue; }

        const folderName = `[리뷰] ${tab.campaign_name || tab.tab_name}`;
        let folder = await driveService.findFolderByName(folderName, rootFolderId).catch(() => null);

        if (!folder) {
          folder = await driveService.createFolder(folderName, rootFolderId);
          created++;
        }

        if (folder) {
          const folderUrl = `https://drive.google.com/drive/folders/${folder.id}`;
          await pool.query(
            'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
            [folderUrl, tab.sheet_id, tab.tab_name]
          );
        }
        synced++;
      } catch (err) {
        logger.error(`[syncReview] 오류 (${tab.tab_name}): ${err.message}`);
        errors++;
      }
    }

    res.json({ ok: true, synced, created, errors, total: tabs.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/sync-all — 전체 폴더 동기화 (GAS: syncAllFolders)
// ═══════════════════════════════════════════════════════════
router.post('/sync-all', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    const captureResult = await syncCaptureFoldersInternal(force);
    const reviewResult = await syncReviewFoldersInternal(force);
    res.json({
      ok: true,
      capture: captureResult,
      review: reviewResult,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/batch-create — 폴더 일괄 생성 (GAS: batchCreateFolders)
// ═══════════════════════════════════════════════════════════
router.post('/batch-create', authMiddleware, async (req, res, next) => {
  try {
    const { target } = req.body; // 'capture', 'review', 'both'
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) return res.json({ error: 'DRIVE_ROOT_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, folder_url, capture_folder_url
       FROM tab_configs
       WHERE (force_done = FALSE OR force_done IS NULL)
         AND (is_closed = FALSE OR is_closed IS NULL)`
    );

    let created = 0, errors = 0;

    for (const tab of tabs) {
      try {
        if ((!target || target === 'both' || target === 'capture') && !tab.capture_folder_url) {
          const folderName = `[캡처] ${tab.campaign_name || tab.tab_name}`;
          const folder = await driveService.createFolder(folderName, rootFolderId);
          if (folder) {
            await pool.query(
              'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
              [`https://drive.google.com/drive/folders/${folder.id}`, tab.sheet_id, tab.tab_name]
            );
            created++;
          }
        }
        if ((!target || target === 'both' || target === 'review') && !tab.folder_url) {
          const folderName = `[리뷰] ${tab.campaign_name || tab.tab_name}`;
          const folder = await driveService.createFolder(folderName, rootFolderId);
          if (folder) {
            await pool.query(
              'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
              [`https://drive.google.com/drive/folders/${folder.id}`, tab.sheet_id, tab.tab_name]
            );
            created++;
          }
        }
      } catch (err) {
        logger.error(`[batchCreate] 오류 (${tab.tab_name}): ${err.message}`);
        errors++;
      }
    }

    res.json({ ok: true, created, errors, total: tabs.length });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/reset-folder-urls — 폴더 URL 재설정 (GAS: resetTabFolderUrls)
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
// POST /api/drive/migrate-names — 폴더명 마이그레이션 (GAS: migrateFolderNames)
// ═══════════════════════════════════════════════════════════
router.post('/migrate-names', authMiddleware, async (req, res, next) => {
  try {
    const { target, dryRun } = req.body;
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) return res.json({ error: 'DRIVE_ROOT_FOLDER_ID 미설정' });

    const { rows: tabs } = await pool.query('SELECT * FROM tab_configs');
    let renamed = 0, errors = 0;
    const actions = [];

    for (const tab of tabs) {
      try {
        // 리뷰폴더
        if ((!target || target === 'both' || target === 'review') && tab.folder_url) {
          const folderId = extractFolderId(tab.folder_url);
          if (folderId) {
            const newName = `[리뷰] ${tab.campaign_name || tab.tab_name}`;
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
            const newName = `[캡처] ${tab.campaign_name || tab.tab_name}`;
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
// POST /api/drive/organize-capture — 캡처폴더 재배치 (GAS: organizeCaptureFolders)
// ═══════════════════════════════════════════════════════════
router.post('/organize-capture', authMiddleware, async (req, res, next) => {
  try {
    const { dryRun } = req.body;
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) return res.json({ error: 'DRIVE_ROOT_FOLDER_ID 미설정' });

    // DB에서 캡처폴더 URL이 있는 탭만 조회
    const { rows: tabs } = await pool.query(
      `SELECT sheet_id, tab_name, campaign_name, capture_folder_url
       FROM tab_configs
       WHERE capture_folder_url IS NOT NULL AND capture_folder_url <> ''`
    );

    let moved = 0, errors = 0, skipped = 0;
    const actions = [];

    // 루트 폴더 내 폴더 목록 조회 (1회)
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
        if (!folderId) { skipped++; continue; }

        if (rootChildIds.has(folderId)) {
          skipped++;
          continue; // 이미 루트 폴더 내에 있음
        }

        // 루트 폴더로 이동
        if (!dryRun) {
          await driveService.moveFile(folderId, rootFolderId, null);
        }
        actions.push({ tabName: tab.tab_name, folderId, action: 'moved_to_root' });
        moved++;
      } catch (err) {
        logger.error(`[organizeCapture] 오류 (${tab.tab_name}): ${err.message}`);
        errors++;
      }
    }

    res.json({ ok: true, moved, skipped, errors, dryRun: !!dryRun, actions });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/drive/save-capture — 캡처폴더 URL 저장 (GAS: saveCaptureFolder)
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
// POST /api/drive/update-urls — 폴더 URL 강제 수정 (GAS: updateFolderUrls)
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
// GET /api/drive/diag — 캡처폴더 현황 진단 (GAS: diagCaptureFolders)
// ═══════════════════════════════════════════════════════════
router.get('/diag', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
             campaign_name AS "campaignName",
             folder_url AS "folderUrl", capture_folder_url AS "captureFolderUrl",
             force_done AS "forceDone", is_closed AS "isClosed"
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
      oauthStatus: driveService.getOAuthStatus(),
      details: rows,
    });
  } catch (err) {
    next(err);
  }
});

// ── 내부 헬퍼 (sync-all 에서 재사용) — OAuth driveService 경유 ──
async function syncCaptureFoldersInternal(force) {
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) return { ok: false, error: 'DRIVE_ROOT_FOLDER_ID 미설정' };

  const { rows: tabs } = await pool.query(
    `SELECT sheet_id, tab_name, campaign_name, capture_folder_url
     FROM tab_configs
     WHERE (force_done = FALSE OR force_done IS NULL)
       AND (is_closed = FALSE OR is_closed IS NULL)`
  );

  let synced = 0, created = 0, errors = 0;

  for (const tab of tabs) {
    try {
      if (tab.capture_folder_url && !force) { synced++; continue; }

      const folderName = `[캡처] ${tab.campaign_name || tab.tab_name}`;
      let folder = await driveService.findFolderByName(folderName, rootFolderId).catch(() => null);

      if (!folder) {
        folder = await driveService.createFolder(folderName, rootFolderId);
        created++;
      }

      if (folder) {
        const folderUrl = `https://drive.google.com/drive/folders/${folder.id}`;
        await pool.query(
          'UPDATE tab_configs SET capture_folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [folderUrl, tab.sheet_id, tab.tab_name]
        );
      }
      synced++;
    } catch (err) {
      logger.error(`[syncCapture:internal] 오류 (${tab.tab_name}): ${err.message}`);
      errors++;
    }
  }

  return { ok: true, synced, created, errors, total: tabs.length };
}

async function syncReviewFoldersInternal(force) {
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!rootFolderId) return { ok: false, error: 'DRIVE_ROOT_FOLDER_ID 미설정' };

  const { rows: tabs } = await pool.query(
    `SELECT sheet_id, tab_name, campaign_name, folder_url
     FROM tab_configs
     WHERE (force_done = FALSE OR force_done IS NULL)
       AND (is_closed = FALSE OR is_closed IS NULL)`
  );

  let synced = 0, created = 0, errors = 0;

  for (const tab of tabs) {
    try {
      if (tab.folder_url && !force) { synced++; continue; }

      const folderName = `[리뷰] ${tab.campaign_name || tab.tab_name}`;
      let folder = await driveService.findFolderByName(folderName, rootFolderId).catch(() => null);

      if (!folder) {
        folder = await driveService.createFolder(folderName, rootFolderId);
        created++;
      }

      if (folder) {
        const folderUrl = `https://drive.google.com/drive/folders/${folder.id}`;
        await pool.query(
          'UPDATE tab_configs SET folder_url = $1, updated_at = NOW() WHERE sheet_id = $2 AND tab_name = $3',
          [folderUrl, tab.sheet_id, tab.tab_name]
        );
      }
      synced++;
    } catch (err) {
      logger.error(`[syncReview:internal] 오류 (${tab.tab_name}): ${err.message}`);
      errors++;
    }
  }

  return { ok: true, synced, created, errors, total: tabs.length };
}

module.exports = router;
