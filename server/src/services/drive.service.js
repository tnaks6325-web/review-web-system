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
 * 파일/폴더 이름 변경 (OAuth 우선 → SA 폴백)
 */
async function renameFile(fileId, newName) {
  const updateParams = {
    fileId,
    requestBody: { name: newName },
    fields: 'id, name',
    supportsAllDrives: true,
  };

  const oauth = _getOAuthDrive();
  if (oauth) {
    try {
      const res = await oauth.files.update(updateParams);
      logger.info(`[Drive] 이름 변경: ${fileId} → "${newName}" (OAuth)`);
      return res.data;
    } catch (oauthErr) {
      logger.warn(`[Drive] OAuth 이름 변경 실패 (SA 재시도): ${oauthErr.message}`);
    }
  }

  const sa = _getReadDrive();
  if (sa) {
    const res = await sa.files.update(updateParams);
    logger.info(`[Drive] 이름 변경: ${fileId} → "${newName}" (SA)`);
    return res.data;
  }

  throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');
}

/**
 * 파일/폴더 이동 (부모 변경) (OAuth 우선 → SA 폴백)
 */
async function moveFile(fileId, newParentId, oldParentId) {
  const updateParams = {
    fileId,
    addParents: newParentId,
    removeParents: oldParentId,
    fields: 'id, parents',
    supportsAllDrives: true,
  };

  const oauth = _getOAuthDrive();
  if (oauth) {
    try {
      const res = await oauth.files.update(updateParams);
      logger.info(`[Drive] 파일 이동: ${fileId} → parent ${newParentId} (OAuth)`);
      return res.data;
    } catch (oauthErr) {
      logger.warn(`[Drive] OAuth 파일 이동 실패 (SA 재시도): ${oauthErr.message}`);
    }
  }

  const sa = _getReadDrive();
  if (sa) {
    const res = await sa.files.update(updateParams);
    logger.info(`[Drive] 파일 이동: ${fileId} → parent ${newParentId} (SA)`);
    return res.data;
  }

  throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');
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
 * 폴더 생성 (OAuth 우선 → 실패 시 SA 폴백)
 */
async function createFolder(name, parentFolderId) {
  const createParams = {
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  };

  // OAuth 먼저 시도
  const oauth = _getOAuthDrive();
  if (oauth) {
    try {
      const res = await oauth.files.create(createParams);
      logger.info(`[Drive] 폴더 생성 완료: "${name}" → ${res.data.id} (OAuth)`);
      return res.data;
    } catch (oauthErr) {
      logger.warn(`[Drive] OAuth 폴더 생성 실패 (SA 재시도): ${oauthErr.message}`);
    }
  }

  // SA 폴백
  const sa = _getReadDrive();
  if (sa) {
    const res = await sa.files.create(createParams);
    logger.info(`[Drive] 폴더 생성 완료: "${name}" → ${res.data.id} (SA)`);
    return res.data;
  }

  throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');
}

/**
 * Base64 이미지를 Google Drive 폴더에 업로드 (OAuth 우선 → SA 폴백)
 * @param {string} base64Data - Base64 인코딩된 이미지 데이터 (data URL prefix 포함 가능)
 * @param {string} fileName - 업로드할 파일명
 * @param {string} mimeType - MIME 타입 (예: image/jpeg)
 * @param {string} parentFolderId - 업로드 대상 폴더 ID
 * @returns {{ id, name, webViewLink, webContentLink }}
 */
async function uploadFileBase64(base64Data, fileName, mimeType, parentFolderId, opts = {}) {
  // data URL prefix 제거
  const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  function _makeStream() {
    const s = new Readable();
    s.push(buffer);
    s.push(null);
    return s;
  }

  const makeParams = (stream) => ({
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
  });

  let data = null;
  let usedClient = 'SA';

  // OAuth 먼저 시도
  const oauth = _getOAuthDrive();
  if (oauth) {
    try {
      const res = await oauth.files.create(makeParams(_makeStream()));
      data = res.data;
      usedClient = 'OAuth';
    } catch (oauthErr) {
      logger.warn(`[Drive] OAuth 업로드 실패 (SA 재시도): ${oauthErr.message}`);
    }
  }

  // SA 폴백
  if (!data) {
    const sa = _getReadDrive();
    if (!sa) {
      throw new Error(
        'Drive 업로드 클라이언트가 없습니다. ' +
        'DRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN 또는 서비스 계정을 설정하세요.'
      );
    }
    const res = await sa.files.create(makeParams(_makeStream()));
    data = res.data;
    usedClient = 'SA';
  }

  logger.info(`[Drive] 업로드 성공: ${data.id} (${usedClient})`);

  // 파일을 "링크가 있는 모든 사용자" 읽기 가능으로 설정
  // opts.shareAnyone === false 면 공개하지 않음(비공개 유지 — 예: 유입가이드 이미지는 서버 프록시로만 노출)
  if (opts.shareAnyone !== false) {
    try {
      const d = usedClient === 'OAuth' ? oauth : _getReadDrive();
      if (d) {
        await d.permissions.create({
          fileId: data.id,
          requestBody: { role: 'reader', type: 'anyone' },
          supportsAllDrives: true,
        });
      }
    } catch (permErr) {
      logger.warn(`[Drive] 권한 설정 실패 (무시): ${permErr.message}`);
    }
  }

  // ── 소유권 이전: Service Account → 실제 사용자 계정 ──
  // Service Account는 스토리지 할당량이 없으므로 파일 소유권을 이전해야 함
  const ownerEmail = process.env.DRIVE_OWNER_EMAIL || 'tnaks6325@gmail.com';
  if (usedClient === 'SA') {
    try {
      const sa = _getReadDrive();
      if (sa) {
        await sa.permissions.create({
          fileId: data.id,
          transferOwnership: true,
          requestBody: { role: 'owner', type: 'user', emailAddress: ownerEmail },
          supportsAllDrives: true,
        });
        logger.info(`[Drive] 소유권 이전 완료: ${data.id} → ${ownerEmail}`);
      }
    } catch (ownerErr) {
      logger.warn(`[Drive] 소유권 이전 실패 (무시): ${ownerErr.message}`);
    }
  }

  return data;
}

/**
 * 파일 복사 (Google Drive files.copy) — 원본 유지, 새 폴더에 사본 생성
 * OAuth 우선 → 실패 시 SA 폴백
 * @param {string} fileId - 복사할 원본 파일 ID
 * @param {string} newParentId - 사본을 넣을 대상 폴더 ID
 * @param {string} [newName] - 사본 파일명 (없으면 원본 이름 유지)
 * @returns {{ id, name, webViewLink }}
 */
async function copyFile(fileId, newParentId, newName) {
  const requestBody = { parents: [newParentId] };
  if (newName) requestBody.name = newName;

  const copyParams = {
    fileId,
    requestBody,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  };

  // OAuth 먼저 시도
  const oauth = _getOAuthDrive();
  if (oauth) {
    try {
      const res = await oauth.files.copy(copyParams);
      logger.info(`[Drive] 파일 복사: ${fileId} → ${newParentId}/${res.data.name} (OAuth)`);
      return res.data;
    } catch (oauthErr) {
      logger.warn(`[Drive] OAuth 파일 복사 실패 (SA 재시도): ${oauthErr.message}`);
    }
  }

  // SA 폴백
  const sa = _getReadDrive();
  if (sa) {
    const res = await sa.files.copy(copyParams);
    logger.info(`[Drive] 파일 복사: ${fileId} → ${newParentId}/${res.data.name} (SA)`);
    return res.data;
  }

  throw new Error('Google Drive API가 설정되지 않았습니다. (OAuth 또는 SA 필요)');
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

// ═══════════════════════════════════════════════════════════
// 중복 파일 감지/정리 (md5Checksum 기반)
// ═══════════════════════════════════════════════════════════

/**
 * 폴더 내 모든 파일의 md5Checksum 포함 메타데이터 조회
 * 페이징 처리로 1000건 이상도 지원
 * @param {string} folderId - Google Drive 폴더 ID
 * @returns {Array<{id, name, md5Checksum, createdTime, mimeType}>}
 */
async function listFolderFilesWithHash(folderId) {
  const q = `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const allFiles = [];
  let pageToken = null;

  const d = _getReadDrive();
  if (!d) throw new Error('Google Drive API가 설정되지 않았습니다.');

  do {
    const params = {
      q,
      fields: 'nextPageToken, files(id, name, md5Checksum, createdTime, mimeType, size)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'createdTime asc',
    };

    const res = await d.files.list(params);
    allFiles.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/**
 * 중복 파일 감지 (md5Checksum 기반)
 * - 동일 해시 그룹에서 가장 오래된 파일 1개만 유지, 나머지는 중복으로 표시
 * @param {string} folderId - Google Drive 폴더 ID
 * @returns {{ duplicates: Array<{keep: object, remove: Array<object>}>, totalFiles: number, duplicateGroups: number }}
 */
async function detectDuplicates(folderId) {
  const files = await listFolderFilesWithHash(folderId);
  
  // md5Checksum 기준 그룹핑
  const hashGroups = new Map();
  for (const file of files) {
    if (!file.md5Checksum) continue; // Google Docs 등 해시 없는 파일 제외
    if (!hashGroups.has(file.md5Checksum)) {
      hashGroups.set(file.md5Checksum, []);
    }
    hashGroups.get(file.md5Checksum).push(file);
  }

  // 중복 그룹만 필터 (2개 이상)
  const duplicates = [];
  for (const [hash, group] of hashGroups) {
    if (group.length < 2) continue;
    // createdTime ASC 정렬 (가장 오래된 것 유지)
    group.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
    duplicates.push({
      md5: hash,
      keep: group[0],           // 유지할 파일 (가장 오래된 것)
      remove: group.slice(1),   // 삭제 대상
    });
  }

  return {
    totalFiles: files.length,
    duplicateGroups: duplicates.length,
    duplicateFileCount: duplicates.reduce((sum, g) => sum + g.remove.length, 0),
    duplicates,
  };
}

/**
 * 중복 파일 일괄 휴지통 이동
 * @param {Array<{id: string, name: string}>} filesToTrash - 삭제 대상 파일 목록
 * @returns {{ success: number, failed: number, errors: Array }}
 */
async function trashFiles(filesToTrash) {
  const d = _getUploadDrive();
  if (!d) throw new Error('Google Drive API가 설정되지 않았습니다.');

  let success = 0;
  let failed = 0;
  const errors = [];

  for (const file of filesToTrash) {
    try {
      await d.files.update({
        fileId: file.id,
        requestBody: { trashed: true },
        supportsAllDrives: true,
      });
      success++;
      logger.info(`[Drive-Dedupe] 휴지통 이동: "${file.name}" (${file.id})`);
    } catch (err) {
      failed++;
      errors.push({ fileId: file.id, name: file.name, error: err.message });
      logger.warn(`[Drive-Dedupe] 삭제 실패: "${file.name}" (${file.id}) - ${err.message}`);
    }
  }

  return { success, failed, errors };
}

/**
 * 재귀적 폴더 파일 목록 조회 (서브폴더 포함)
 * - 루트 폴더 + 모든 하위 폴더의 파일을 평탄화하여 반환
 * @param {string} folderId - Google Drive 폴더 ID
 * @returns {Array<{id, name, md5Checksum, createdTime, mimeType, size, parentFolder}>}
 */
async function listFolderFilesRecursive(folderId) {
  const d = _getReadDrive();
  if (!d) throw new Error('Google Drive API가 설정되지 않았습니다.');

  const allFiles = [];

  async function _traverse(parentId, parentPath) {
    // 파일 + 폴더 모두 조회
    const q = `'${parentId}' in parents and trashed = false`;
    let pageToken = null;

    do {
      const params = {
        q,
        fields: 'nextPageToken, files(id, name, md5Checksum, createdTime, mimeType, size)',
        pageSize: 1000,
        pageToken: pageToken || undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: 'createdTime asc',
      };

      const res = await d.files.list(params);
      const files = res.data.files || [];

      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          // 서브폴더 재귀 탐색
          await _traverse(file.id, parentPath ? `${parentPath}/${file.name}` : file.name);
        } else {
          allFiles.push({ ...file, parentFolder: parentPath || '(root)' });
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  await _traverse(folderId, '');
  return allFiles;
}

/**
 * 파일명에서 리뷰어 이름 추출
 * 패턴: {이름}_{순번}_{타임스탬프}.{확장자}
 *   예: 김수만_1_20260504_143022.jpg → "김수만"
 *       김수만_2.jpg → "김수만"
 *       김수만.jpg → "김수만"
 * @param {string} fileName
 * @returns {string|null}
 */
function extractReviewerNameFromFile(fileName) {
  if (!fileName) return null;
  // 확장자 제거
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
  // 패턴1: 이름_순번_타임스탬프
  const m1 = nameWithoutExt.match(/^(.+?)_\d+_\d{8}_\d{6}$/);
  if (m1) return m1[1].trim();
  // 패턴2: 이름_순번
  const m2 = nameWithoutExt.match(/^(.+?)_\d+$/);
  if (m2) return m2[1].trim();
  // 패턴3: 이름만
  return nameWithoutExt.trim();
}

// ═══════════════════════════════════════════════════════════
// 폴더 후보 검색 (gid/탭명 → Drive 폴더 찾기 & 재연결 지원)
// ═══════════════════════════════════════════════════════════

/**
 * 탭명으로부터 Drive 검색어 후보를 생성
 * 예) "6/1(쿠팡)엘라비에_기미쿠션 골드박스 90건"
 *   → ["6/1(쿠팡)엘라비에_기미쿠션 골드박스 90건", "엘라비에_기미쿠션 골드박스", "기미쿠션 골드박스"]
 * 건수(90↔100)가 바뀌어도 매칭되도록 후미 "N건/N차"와 선두 "날짜(채널)"를 떼어낸 변형을 함께 반환
 */
function deriveFolderSearchTerms(tabName) {
  const name = String(tabName || '').trim();
  const terms = [];
  const add = (t) => { const v = (t || '').trim(); if (v && v.length >= 2 && !terms.includes(v)) terms.push(v); };

  add(name);
  // 선두 날짜+채널 제거: "6/1(쿠팡)" / "6 / 1 (쿠팡)"
  let core = name.replace(/^\s*\d{1,2}\s*\/\s*\d{1,2}\s*(\([^)]*\))?\s*/, '');
  // 후미 건수/차수 제거: " 90건", " 2차"
  core = core.replace(/\s*\d+\s*건\s*$/, '').replace(/\s*\d+\s*차\s*$/, '').trim();
  add(core);
  // 첫 언더스코어 이후(상품 핵심부) — "엘라비에_기미쿠션 골드박스" → "기미쿠션 골드박스"
  const base = core || name;
  if (base.includes('_')) {
    add(base.split('_').slice(1).join('_').replace(/\s*\d+\s*건\s*$/, '').trim());
  }
  return terms;
}

/**
 * 폴더명 부분일치 전역 검색 — SA + OAuth 결과를 병합 (소유자가 달라도 누락 방지)
 * @returns {Promise<Array<{id,name,webViewLink,parents,owner,createdTime}>>}
 */
async function searchFolders(nameContains, opts = {}) {
  const limit = opts.limit || 30;
  const safe = String(nameContains || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").trim();
  if (!safe) return [];
  const params = {
    q: `name contains '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, webViewLink, parents, owners(emailAddress), createdTime)',
    pageSize: Math.min(limit, 100),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    orderBy: 'createdTime desc',
  };

  const byId = new Map();
  const sa = _getReadDrive();
  const oauth = _getOAuthDrive();
  for (const [client, label] of [[sa, 'SA'], [oauth, 'OAuth']]) {
    if (!client) continue;
    if (label === 'OAuth' && client === sa) continue;
    try {
      const res = await client.files.list(params);
      for (const f of (res.data.files || [])) {
        if (byId.has(f.id)) continue;
        byId.set(f.id, {
          id: f.id,
          name: f.name,
          webViewLink: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`,
          parents: f.parents || [],
          owner: (f.owners && f.owners[0] && f.owners[0].emailAddress) || '',
          createdTime: f.createdTime || '',
        });
      }
    } catch (e) {
      logger.warn(`[Drive] ${label} searchFolders 실패: ${e.message}`);
    }
  }
  return [...byId.values()];
}

/**
 * 폴더 하위 항목을 SA+OAuth 병합 조회 (소유자가 다른 폴더도 누락 없이)
 */
async function _listChildrenMerged(folderId) {
  const params = {
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };
  const byId = new Map();
  const sa = _getReadDrive();
  const oauth = _getOAuthDrive();
  for (const [client, label] of [[sa, 'SA'], [oauth, 'OAuth']]) {
    if (!client) continue;
    if (label === 'OAuth' && client === sa) continue;
    try {
      const res = await client.files.list(params);
      for (const f of (res.data.files || [])) if (!byId.has(f.id)) byId.set(f.id, f);
    } catch (e) {
      logger.warn(`[Drive] ${label} _listChildrenMerged 실패: ${e.message}`);
    }
  }
  return [...byId.values()];
}

/**
 * 폴더 내부 진단: 파일수, 리뷰형식 파일수, 하위폴더 목록
 * 리뷰 업로드 파일명 패턴: {이름}_{순번}[_{yyyyMMdd_HHmmss}].{ext}
 */
async function inspectFolder(folderId) {
  const children = await _listChildrenMerged(folderId);
  const FOLDER = 'application/vnd.google-apps.folder';
  const files = children.filter(c => c.mimeType !== FOLDER);
  const subfolders = children.filter(c => c.mimeType === FOLDER).map(s => ({ id: s.id, name: s.name }));
  const reviewLikeCount = files.filter(f => /_\d+(?:_\d{8}_\d{6})?\.[a-zA-Z0-9]+$/.test(f.name || '')).length;
  return { fileCount: files.length, reviewLikeCount, subfolders };
}

/**
 * 폴더 메타(이름) 조회 — 부모 폴더명 표시용 (SA → OAuth 폴백)
 */
async function getFolderMeta(folderId) {
  if (!folderId) return null;
  const sa = _getReadDrive();
  const oauth = _getOAuthDrive();
  for (const client of [sa, oauth]) {
    if (!client) continue;
    try {
      const res = await client.files.get({ fileId: folderId, fields: 'id, name', supportsAllDrives: true });
      if (res.data) return { id: res.data.id, name: res.data.name };
    } catch (_) {}
  }
  return null;
}

/**
 * Drive 파일 내용을 서버에서 다운로드 (비공개 파일 프록시 스트리밍용)
 * @param {string} fileId
 * @returns {{ buffer: Buffer, mimeType: string, name: string }}
 */
async function downloadFile(fileId) {
  const clients = [_getOAuthDrive(), _getReadDrive()].filter(Boolean);
  if (clients.length === 0) throw new Error('Drive 읽기 클라이언트가 없습니다.');
  let lastErr = null;
  for (const d of clients) {
    try {
      const meta = await d.files.get({ fileId, fields: 'mimeType, name', supportsAllDrives: true });
      const res = await d.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
      );
      return {
        buffer: Buffer.from(res.data),
        mimeType: (meta.data && meta.data.mimeType) || 'application/octet-stream',
        name: (meta.data && meta.data.name) || fileId,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Drive 다운로드 실패');
}

module.exports = {
  listFolderContents,
  downloadFile,
  createFolder,
  renameFile,
  moveFile,
  copyFile,
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
  // 폴더 후보 검색 (찾기 & 재연결)
  deriveFolderSearchTerms,
  searchFolders,
  inspectFolder,
  getFolderMeta,
  // 중복 파일 정리
  listFolderFilesWithHash,
  listFolderFilesRecursive,
  detectDuplicates,
  trashFiles,
  extractReviewerNameFromFile,
};
