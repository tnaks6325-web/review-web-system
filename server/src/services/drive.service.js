const { google } = require('googleapis');
const { drive } = require('./sheets.service');
const { Readable } = require('stream');
const { logger } = require('../utils/logger');

/**
 * Google Drive API 래퍼
 * GAS DriveApp 대체 — Node.js googleapis Drive API v3
 *
 * 인증 방식:
 *   - Service Account (drive)   : 폴더 조회, 리스팅 등 읽기 전용 작업
 *   - OAuth Refresh Token (oauthDrive) : 파일 업로드, 폴더 생성 (사용자 스토리지 사용)
 *
 * 필요 환경변수 (OAuth 업로드용):
 *   DRIVE_OAUTH_CLIENT_ID
 *   DRIVE_OAUTH_CLIENT_SECRET
 *   DRIVE_OAUTH_REFRESH_TOKEN
 */

// ── OAuth Drive 클라이언트 초기화 ──
let oauthDrive = null;

function _getOAuthDrive() {
  if (oauthDrive) return oauthDrive;

  const clientId     = process.env.DRIVE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DRIVE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.DRIVE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    logger.warn('[Drive] OAuth 환경변수 미설정 — DRIVE_OAUTH_CLIENT_ID, DRIVE_OAUTH_CLIENT_SECRET, DRIVE_OAUTH_REFRESH_TOKEN 필요');
    return null;
  }

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    oauthDrive = google.drive({ version: 'v3', auth: oauth2Client });
    logger.info('[Drive] OAuth Drive 클라이언트 초기화 완료');
    return oauthDrive;
  } catch (err) {
    logger.error(`[Drive] OAuth 초기화 실패: ${err.message}`);
    return null;
  }
}

/**
 * 업로드용 Drive 클라이언트 반환 (OAuth 우선 → SA 폴백)
 */
function _getUploadDrive() {
  return _getOAuthDrive() || drive;
}

/**
 * 읽기전용 Drive 클라이언트 (Service Account)
 */
function _getReadDrive() {
  return drive;
}

// ═══════════════════════════════════════════════════════════
// 읽기 전용 함수 (Service Account 사용)
// ═══════════════════════════════════════════════════════════

/**
 * 폴더 내 파일/폴더 목록 조회 (SA 우선 → OAuth 폴백)
 */
async function listFolderContents(folderId, mimeType = null) {
  let q = `'${folderId}' in parents and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;

  const params = {
    q,
    fields: 'files(id, name, mimeType, webViewLink, createdTime)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  // SA로 먼저 시도
  const sa = _getReadDrive();
  if (sa) {
    try {
      const res = await sa.files.list(params);
      return res.data.files || [];
    } catch (saErr) {
      logger.warn(`[Drive] SA listFolder 실패 (OAuth 재시도): ${saErr.message}`);
    }
  }

  // OAuth로 재시도
  const oauth = _getOAuthDrive();
  if (oauth) {
    const res = await oauth.files.list(params);
    return res.data.files || [];
  }

  throw new Error('Google Drive API가 설정되지 않았습니다.');
}

/**
 * 파일/폴더 이름 변경 (OAuth 우선 — 쓰기 작업)
 */
async function renameFile(fileId, newName) {
  const d = _getUploadDrive();
  if (!d) throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');
  const res = await d.files.update({
    fileId,
    requestBody: { name: newName },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  logger.info(`[Drive] 이름 변경: ${fileId} → "${newName}" (${oauthDrive ? 'OAuth' : 'SA'})`);
  return res.data;
}

/**
 * 파일/폴더 이동 (부모 변경) (OAuth 우선 — 쓰기 작업)
 */
async function moveFile(fileId, newParentId, oldParentId) {
  const d = _getUploadDrive();
  if (!d) throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');
  const res = await d.files.update({
    fileId,
    addParents: newParentId,
    removeParents: oldParentId,
    fields: 'id, parents',
    supportsAllDrives: true,
  });
  logger.info(`[Drive] 파일 이동: ${fileId} → parent ${newParentId} (${oauthDrive ? 'OAuth' : 'SA'})`);
  return res.data;
}

/**
 * 폴더 이름으로 검색 (특정 부모 폴더 내)
 * SA로 검색 시도 → 실패 시 OAuth로 재시도
 */
async function findFolderByName(name, parentFolderId) {
  const q = `name = '${name}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = {
    q,
    fields: 'files(id, name, webViewLink)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  // SA로 먼저 시도
  const sa = _getReadDrive();
  if (sa) {
    try {
      const res = await sa.files.list(params);
      const found = (res.data.files || [])[0] || null;
      if (found) return found;
    } catch (saErr) {
      logger.warn(`[Drive] SA 폴더 검색 실패 (OAuth 재시도): ${saErr.message}`);
    }
  }

  // OAuth로 재시도 (SA가 못 찾는 경우 — OAuth가 생성한 폴더)
  const oauth = _getOAuthDrive();
  if (oauth && oauth !== sa) {
    try {
      const res = await oauth.files.list(params);
      return (res.data.files || [])[0] || null;
    } catch (oauthErr) {
      logger.warn(`[Drive] OAuth 폴더 검색도 실패: ${oauthErr.message}`);
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// 쓰기 함수 (OAuth 우선 사용 — 사용자 스토리지 쿼터 활용)
// ═══════════════════════════════════════════════════════════

/**
 * 폴더 생성 (OAuth 우선)
 */
async function createFolder(name, parentFolderId) {
  const d = _getUploadDrive();
  if (!d) throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');

  const res = await d.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  logger.info(`[Drive] 폴더 생성 완료: "${name}" → ${res.data.id} (${oauthDrive ? 'OAuth' : 'SA'})`);
  return res.data;
}

/**
 * Base64 이미지를 Google Drive 폴더에 업로드 (OAuth 전용)
 * @param {string} base64Data - Base64 인코딩된 이미지 데이터 (data URL prefix 포함 가능)
 * @param {string} fileName - 업로드할 파일명
 * @param {string} mimeType - MIME 타입 (예: image/jpeg)
 * @param {string} parentFolderId - 업로드 대상 폴더 ID
 * @returns {{ id, name, webViewLink, webContentLink }}
 */
async function uploadFileBase64(base64Data, fileName, mimeType, parentFolderId) {
  const d = _getUploadDrive();
  if (!d) {
    throw new Error(
      'Drive 업로드 클라이언트가 없습니다. ' +
      'DRIVE_OAUTH_CLIENT_ID, DRIVE_OAUTH_CLIENT_SECRET, DRIVE_OAUTH_REFRESH_TOKEN 환경변수를 설정하세요.'
    );
  }

  // data URL prefix 제거
  const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const createParams = {
    requestBody: {
      name: fileName,
      parents: [parentFolderId],
    },
    media: {
      mimeType: mimeType || 'image/jpeg',
      body: stream,
    },
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  };

  logger.info(`[Drive] 업로드 시작: ${fileName} → ${parentFolderId} (${oauthDrive ? 'OAuth' : 'SA'})`);
  const res = await d.files.create(createParams);
  const data = res.data;
  logger.info(`[Drive] 업로드 성공: ${data.id} (${oauthDrive ? 'OAuth' : 'SA'})`);

  // 파일을 "링크가 있는 모든 사용자" 읽기 가능으로 설정
  try {
    await d.permissions.create({
      fileId: data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true,
    });
  } catch (permErr) {
    // 권한 설정 실패 시 무시 (업로드 자체는 성공)
    logger.warn(`[Drive] 권한 설정 실패 (무시): ${permErr.message}`);
  }

  return data;
}

/**
 * 캡처폴더 하위의 차수별 서브폴더 찾기/생성
 * 경로: DRIVE_ROOT / [캡처] 캠페인명 / 차수명(또는 탭명) /
 */
async function getOrCreateSubFolder(parentFolderId, subFolderName) {
  // 기존 서브폴더 검색
  const existing = await findFolderByName(subFolderName, parentFolderId);
  if (existing) return existing;

  // 없으면 생성 (OAuth 사용)
  return await createFolder(subFolderName, parentFolderId);
}

// ═══════════════════════════════════════════════════════════
// 통합 폴더 구조 헬퍼 함수 (AI_REVIEW_FOLDER 기반)
//
// 새 폴더 구조:
//   AI_REVIEW_FOLDER (루트)
//   └── {시트제목} (캠페인=업체)
//       └── {탭명} (작업)
//           ├── [구매캡처]
//           └── [리뷰]
//               └── {옵션폴더} (선택)
// ═══════════════════════════════════════════════════════════

/**
 * 폴더 경로를 순서대로 탐색/생성하여 최종 폴더 ID를 반환
 * @param {string} rootFolderId - 루트 폴더 ID (AI_REVIEW_FOLDER_ID)
 * @param {string[]} folderNames - 생성할 폴더 경로 배열 (예: ['시트명', '탭명', '[구매캡처]'])
 * @returns {{ id, name, webViewLink, path: string[] }}
 */
async function ensureFolderPath(rootFolderId, folderNames) {
  let currentParentId = rootFolderId;
  const resolvedPath = [];

  for (const name of folderNames) {
    if (!name) continue;
    let folder = await findFolderByName(name, currentParentId);
    if (!folder) {
      folder = await createFolder(name, currentParentId);
      logger.info(`[Drive] 폴더 생성: "${name}" in ${currentParentId}`);
    }
    currentParentId = folder.id;
    resolvedPath.push(name);
  }

  return {
    id: currentParentId,
    path: resolvedPath,
    url: `https://drive.google.com/drive/folders/${currentParentId}`,
  };
}

/**
 * 캡처 폴더 경로 확보 (3단계: 시트제목 → 탭명 → [구매캡처])
 * @param {string} rootFolderId - AI_REVIEW_FOLDER_ID
 * @param {string} sheetTitle - 구글 시트 제목 (캠페인/업체명)
 * @param {string} tabName - 탭 이름
 * @returns {{ id, url, path }}
 */
async function ensureCaptureFolderPath(rootFolderId, sheetTitle, tabName) {
  return ensureFolderPath(rootFolderId, [sheetTitle, tabName, '[구매캡처]']);
}

/**
 * 리뷰 폴더 경로 확보 (3~4단계: 시트제목 → 탭명 → [리뷰] → [옵션])
 * @param {string} rootFolderId - AI_REVIEW_FOLDER_ID
 * @param {string} sheetTitle - 구글 시트 제목 (캠페인/업체명)
 * @param {string} tabName - 탭 이름
 * @param {string} [optionFolderName] - 옵션 서브폴더 (선택)
 * @returns {{ id, url, path }}
 */
async function ensureReviewFolderPath(rootFolderId, sheetTitle, tabName, optionFolderName) {
  const pathParts = [sheetTitle, tabName, '[리뷰]'];
  if (optionFolderName) pathParts.push(optionFolderName);
  return ensureFolderPath(rootFolderId, pathParts);
}

/**
 * 동일 이름 파일이 존재하면 휴지통으로 이동 후 true 반환
 * @param {string} parentFolderId - 대상 폴더 ID
 * @param {string} fileName - 파일명
 * @returns {boolean} - 중복이 있어서 삭제했으면 true
 */
async function trashDuplicateFile(parentFolderId, fileName) {
  const escapedName = fileName.replace(/'/g, "\\'");
  const q = `name = '${escapedName}' and '${parentFolderId}' in parents and trashed = false`;
  const params = {
    q,
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  const d = _getUploadDrive();
  if (!d) return false;

  // SA → OAuth 순서로 검색
  let files = [];
  const sa = _getReadDrive();
  if (sa) {
    try {
      const res = await sa.files.list(params);
      files = res.data.files || [];
    } catch (_) {}
  }
  if (files.length === 0) {
    const oauth = _getOAuthDrive();
    if (oauth && oauth !== sa) {
      try {
        const res = await oauth.files.list(params);
        files = res.data.files || [];
      } catch (_) {}
    }
  }

  // 발견된 중복 파일들 휴지통 이동
  for (const file of files) {
    try {
      await d.files.update({
        fileId: file.id,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      });
      logger.info(`[Drive] 중복 파일 휴지통 이동: "${file.name}" (${file.id})`);
    } catch (trashErr) {
      logger.warn(`[Drive] 중복 파일 삭제 실패 (${file.id}): ${trashErr.message}`);
    }
  }

  return files.length > 0;
}

/**
 * 리뷰 파일명 생성 규칙: {reviewerName}_{index}_{yyyyMMdd_HHmmss}.{ext}
 * @param {string} reviewerName - 리뷰어 이름
 * @param {number} index - 파일 순번 (1부터)
 * @param {string} mimeType - MIME 타입
 * @returns {string}
 */
function generateReviewFileName(reviewerName, index, mimeType) {
  // mimeType → 확장자 매핑
  const extMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const ext = extMap[mimeType] || 'jpg';

  // KST 타임스탬프
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const ts = kst.toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\d{8})(\d{6}).*/, '$1_$2');

  // 이름에서 특수문자 제거
  const safeName = (reviewerName || '익명').replace(/[\/\\:*?"<>|]/g, '_');

  return `${safeName}_${index}_${ts}.${ext}`;
}

/**
 * Google Drive URL에서 폴더 ID 추출
 */
function extractFolderIdFromUrl(url) {
  if (!url) return null;
  const m = (url || '').match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : null;
}

/**
 * OAuth Drive 상태 진단
 */
function getOAuthStatus() {
  const hasClientId     = !!process.env.DRIVE_OAUTH_CLIENT_ID;
  const hasClientSecret = !!process.env.DRIVE_OAUTH_CLIENT_SECRET;
  const hasRefreshToken = !!process.env.DRIVE_OAUTH_REFRESH_TOKEN;
  const oauthReady      = hasClientId && hasClientSecret && hasRefreshToken;

  return {
    oauthConfigured: oauthReady,
    oauthClientInitialized: !!oauthDrive,
    serviceAccountConfigured: !!drive,
    envVars: {
      DRIVE_OAUTH_CLIENT_ID: hasClientId ? '✅ set' : '❌ missing',
      DRIVE_OAUTH_CLIENT_SECRET: hasClientSecret ? '✅ set' : '❌ missing',
      DRIVE_OAUTH_REFRESH_TOKEN: hasRefreshToken ? '✅ set' : '❌ missing',
    },
  };
}

module.exports = {
  listFolderContents,
  createFolder,
  renameFile,
  moveFile,
  findFolderByName,
  uploadFileBase64,
  getOrCreateSubFolder,
  getOAuthStatus,
  // 새 통합 폴더 구조 함수
  ensureFolderPath,
  ensureCaptureFolderPath,
  ensureReviewFolderPath,
  trashDuplicateFile,
  generateReviewFileName,
  extractFolderIdFromUrl,
};
