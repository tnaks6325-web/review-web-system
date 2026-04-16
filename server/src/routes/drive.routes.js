const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth.middleware');
const driveService = require('../services/drive.service');
const pool = require('../db/pool');

// POST /api/drive/sync-capture — 캡처폴더 동기화 (GAS: syncCaptureFolders)
router.post('/sync-capture', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    // TODO: 캡처폴더 동기화 로직 구현
    res.json({ ok: true, message: '캡처폴더 동기화 완료 (구현 예정)', force: !!force });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/sync-review — 리뷰폴더 동기화 (GAS: syncReviewFolders)
router.post('/sync-review', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    res.json({ ok: true, message: '리뷰폴더 동기화 완료 (구현 예정)', force: !!force });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/sync-all — 전체 폴더 동기화 (GAS: syncAllFolders)
router.post('/sync-all', authMiddleware, async (req, res, next) => {
  try {
    const { force } = req.body;
    res.json({ ok: true, message: '전체 폴더 동기화 완료 (구현 예정)', force: !!force });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/batch-create — 폴더 일괄 생성 (GAS: batchCreateFolders)
router.post('/batch-create', authMiddleware, async (req, res, next) => {
  try {
    const { target } = req.body;
    res.json({ ok: true, message: '폴더 일괄 생성 완료 (구현 예정)', target });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/reset-folder-urls — 폴더 URL 재설정 (GAS: resetTabFolderUrls)
router.post('/reset-folder-urls', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, target } = req.body;
    res.json({ ok: true, message: '폴더 URL 재설정 완료 (구현 예정)' });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/migrate-names — 폴더명 마이그레이션 (GAS: migrateFolderNames)
router.post('/migrate-names', authMiddleware, async (req, res, next) => {
  try {
    const { target, dryRun } = req.body;
    res.json({ ok: true, message: '폴더명 마이그레이션 완료 (구현 예정)', dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/organize-capture — 캡처폴더 재배치 (GAS: organizeCaptureFolders)
router.post('/organize-capture', authMiddleware, async (req, res, next) => {
  try {
    res.json({ ok: true, message: '캡처폴더 재배치 완료 (구현 예정)' });
  } catch (err) {
    next(err);
  }
});

// POST /api/drive/save-capture — 캡처폴더 URL 저장 (GAS: saveCaptureFolder)
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

// POST /api/drive/update-urls — 폴더 URL 강제 수정 (GAS: updateFolderUrls)
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

// GET /api/drive/diag — 캡처폴더 현황 진단 (GAS: diagCaptureFolders)
router.get('/diag', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT sheet_id AS "sheetId", tab_name AS "tabName",
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
      details: rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
