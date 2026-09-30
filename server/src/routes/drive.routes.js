const express = require('express');
const router = express.Router();
const { authMiddleware, adminOrMasterMiddleware } = require('../middleware/auth.middleware');
const driveService = require('../services/drive.service');
const { getSpreadsheetMeta } = require('../services/sheets.service');
const pool = require('../db/pool');
const { logger } = require('../utils/logger');
const captureRename = require('../services/captureFileRename.service');

// 공개 리포트에서 제외할 영수증 검수 증거. 리뷰 슬롯 파일을 AI가 영수증으로 오판했어도
// 담당자가 정상(ok)으로 확정했다면 format 흔적만으로 숨기지 않는다. 영수증 전용
// receiptValidation이 있으면 승인 상태와 무관하게 계속 제외한다.
const PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL = `(
  COALESCE(ri.checks, '{}'::jsonb) ? 'receiptValidation'
  OR (
    COALESCE(ri.checks->'format'->>'got', ri.checks->'format'->>'kind', '') = 'receipt'
    AND NOT (COALESCE(ri.status, '') = 'resolved' AND COALESCE(ri.resolution, '') = 'ok')
  )
)`;

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


// ═══════════════════════════════════════════════════════════
// POST /api/drive/save-capture — 캡처폴더 URL 저장
// ═══════════════════════════════════════════════════════════
router.post('/save-capture', authMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName } = req.body;
    // 공개 구매양식이 사용하던 이름(captureFolderUrl)과 관리자 API 이름(folderUrl)을 함께 받는다.
    const folderUrl = req.body.folderUrl || req.body.captureFolderUrl || '';
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

// (POST /relocate-orphan-reviews — 옛 대시보드 「리뷰 캡처 정리」 창 전용, 2026-09-29 제거 · 결정 186 72번)

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// POST /api/drive/capture-rename-recipient — 과거 리뷰 캡처 파일명 소급 정정(주문자 → 수취인)
//
// 배경: 타계정 참여 캡처가 Drive 에 전부 주문자(로그인 본계정) 이름으로 쌓여 어떤 타계정의
//   리뷰인지 구분할 수 없다(2026-09-22 신고 · 결정 009 후속). 앞으로의 저장은 서버 판정으로
//   고쳤고, 이미 올라간 파일은 이 창구가 **이름만** 바꾼다(꼬리 = 순번·제출시각·확장자 보존).
//
// ★★ 되돌리기 어려운 외부 저장 쓰기라 **미리보기 기본** — `dryRun:false` **와** `confirm:true`
//    가 둘 다 있어야 실행한다. 바꾸기 전 이름은 `review_submissions.renamed_from`(164)에 남고
//    `revert:true` 로 되돌린다.
// ★ adminOrMaster — 리뷰 캡처 정리(relocate)와 같은 급의 Drive 쓰기 도구다.
// ═══════════════════════════════════════════════════════════
router.post('/capture-rename-recipient', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const { sheetId, tabName, limit, dryRun, confirm, revert } = req.body || {};
    const by = (req.admin && req.admin.name) || 'admin';
    const args = { db: pool, sheetId: sheetId || null, tabName: tabName || null,
                   limit, dryRun: dryRun !== false, confirm: confirm === true, by };
    const out = revert === true
      ? await captureRename.revertRecipientRenames(args)
      : await captureRename.applyRecipientRenames(args);
    res.json({ ok: true, revert: revert === true, ...out });
  } catch (err) {
    // 마이그레이션 164 미적용은 원인을 말해 준다(조용한 500 금지).
    if (err && err.code === '42703') {
      return res.status(400).json({ ok: false, code: 'not_ready',
        error: '이 기능은 migration 164(review_submissions.renamed_from) 적용 후 사용할 수 있습니다.' });
    }
    next(err);
  }
});

// (POST /review-folder-backfill — 같은 창 전용, 결정 186 72번 제거)

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

// (POST /share-review-folder — 같은 창 전용, 결정 186 72번 제거)

// ═══════════════════════════════════════════════════════════
// 업체 보고용 공개 링크 (탭 단위)
//   - POST /report-link (관리자): 탭당 추측불가 코드 발급(재생성 시 동일 코드 재사용)
//   - GET  /report/:code (공개): 코드 → 탭의 리뷰 캡처 목록 반환(이미지 자체는
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

// GET /api/drive/report/:code — 공개: 코드 → 탭 리뷰 캡처 목록 (무인증)
//   명시적 review 원장 우선 → 비어 있으면 review_index 대표 리뷰만 사용.
//   폴더 재귀 스캔은 역할을 판별할 수 없어 현금영수증을 노출하므로 공개 경로에서 사용하지 않는다.
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
        `SELECT rs.file_id, rs.file_name, rs.reviewer_name, rs.uploaded_at
           FROM review_submissions rs
          WHERE rs.sheet_id = $1 AND rs.tab_name = $2
            AND rs.file_id IS NOT NULL AND rs.file_id <> ''
            AND COALESCE(rs.slot_key, 'review') = 'review'
            AND NOT EXISTS (
              SELECT 1 FROM review_inspections ri
               WHERE ri.file_id = rs.file_id
                 AND ${PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL}
            )
          ORDER BY reviewer_name NULLS LAST, uploaded_at ASC NULLS LAST`,
        [sheetId, tabName]
      );
      images = sub.rows.map(r => ({
        id: r.file_id,
        name: r.file_name || '',
        reviewer: (r.reviewer_name || driveService.extractReviewerNameFromFile(r.file_name) || '').trim(),
      }));
    } catch (_) {}

    // 2) 원장이 비어 있으면 명시적 대표 리뷰만 폴백
    if (images.length === 0) {
      try {
        const fallback = await pool.query(
          `SELECT r.review_file_id AS file_id, r.review_file_name AS file_name,
                  r.reviewer_name, r.review_file_at AS uploaded_at
             FROM review_index r
            WHERE r.sheet_id = $1 AND r.tab_name = $2
               AND r.review_file_id IS NOT NULL AND r.review_file_id <> ''
               AND NOT EXISTS (
                 SELECT 1 FROM review_submissions rs_role
                  WHERE rs_role.file_id = r.review_file_id
                    AND COALESCE(rs_role.slot_key, 'review') <> 'review'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM review_inspections ri
                 WHERE ri.file_id = r.review_file_id
                   AND ${PUBLIC_REPORT_RECEIPT_EVIDENCE_SQL}
              )
            ORDER BY r.reviewer_name NULLS LAST, r.review_file_at ASC NULLS LAST`,
          [sheetId, tabName]
        );
        images = fallback.rows.map(r => ({
          id: r.file_id,
          name: r.file_name || '',
          reviewer: (r.reviewer_name || driveService.extractReviewerNameFromFile(r.file_name) || '').trim(),
        }));
      } catch (e) {
        logger.warn(`[report] 대표 리뷰 폴백 실패 (${code}): ${e.message}`);
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

// ═══════════════════════════════════════════════════════════
// POST /api/drive/orphan-capture-cleanup — 고아 캡처 미리보기·정리 (세 종류 한 창구)
//
// A 'linked'(기본) 링크 끊김 — 원장은 살아 있는데 그 칸이 파일을 더는 안 가리킨다
//     크론(매일 04:40, `ORPHAN_CAPTURE_CLEAN`)이 하는 일과 **완전히 같은 함수**를 부른다.
//     사본을 두면 "자동 정리와 손으로 누른 정리가 다른 것을 지우는" 드리프트가 생긴다.
// C 'tombstoned'  작업 소멸 — 작업이 통째로 지워져 원장 자체가 없다(묘비 134 가 좌표를 남긴다)
// B 'folder'      원장 없음 — Drive 폴더에는 있는데 원장 어디에서도 안 가리킨다
//     ★★★ B 는 **사람이 고른 파일만**(`fileIds` 필수) 처리한다. "원장에 없다"에는
//        업로드는 됐는데 기록만 실패한 **정상 캡처**가 섞이므로 일괄 삭제 표면을 두지 않는다.
//     ★ 그래서 B·C 는 크론이 절대 부르지 않는다 — 사람이 눌러야만 움직인다.
//
// body: { kind? ('linked'|'tombstoned'|'folder', 기본 'linked'), dryRun? (기본 true),
//         fileIds?: string[], sheetId?/tabName? (folder 필수) }
//   ★ fileIds 를 줘도 서버가 후보를 다시 골라 **교집합**만 처리한다(화면 목록 불신).
//   ★ 삭제는 휴지통만(30일 복구창) — 영구삭제 API 를 쓰지 않는다.
//   ★ 모르는 kind 는 400 으로 거부한다 — 오타가 조용히 A 를 실행하면 안 된다.
// ═══════════════════════════════════════════════════════════
router.post('/orphan-capture-cleanup', authMiddleware, adminOrMasterMiddleware, async (req, res, next) => {
  try {
    const b = req.body || {};
    const by = (req.admin && req.admin.name) || 'admin';
    const dryRun = b.dryRun !== false;   // ★ 기본 미리보기 — 실행은 dryRun:false 를 명시해야만
    const fileIds = Array.isArray(b.fileIds) && b.fileIds.length ? b.fileIds : null;
    const svc = require('../services/orphanCaptureCleanup.service');

    /* kind — 어떤 종류의 고아를 다루는가. 미지정은 종전 동작(A) 그대로.
         'linked'(기본) A 링크 끊김   — 크론이 자동으로 도는 것과 같은 함수
         'tombstoned'   C 작업 소멸   — 묘비(134) 기준, 사람이 실행
         'folder'       B 원장 없음   — Drive 스캔, **고른 파일만** 실행 */
    const kind = String(b.kind || 'linked');
    if (kind === 'tombstoned') {
      return res.json(await svc.trashTombstonedCaptures({ dryRun, fileIds, by }));
    }
    if (kind === 'folder') {
      if (!b.sheetId || !b.tabName) {
        return res.status(400).json({ ok: false, error: 'folder 종류는 sheetId, tabName 이 필요합니다.' });
      }
      return res.json(await svc.trashFolderOrphans({
        sheetId: b.sheetId, tabName: b.tabName, fileIds, dryRun, by }));
    }
    if (kind !== 'linked') {
      return res.status(400).json({ ok: false, error: `알 수 없는 kind: ${kind}` });
    }
    return res.json(await svc.trashOrphanCaptures({ dryRun, fileIds, by }));
  } catch (err) { return next(err); }
});

module.exports = router;
