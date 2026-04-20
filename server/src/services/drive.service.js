const { drive } = require('./sheets.service');
const { Readable } = require('stream');

/**
 * Google Drive API 래퍼
 * GAS DriveApp 대체 — Node.js googleapis Drive API v3
 */

/**
 * 폴더 내 파일/폴더 목록 조회
 */
async function listFolderContents(folderId, mimeType = null) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  let q = `'${folderId}' in parents and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, webViewLink, createdTime)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

/**
 * 폴더 생성
 */
async function createFolder(name, parentFolderId) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

/**
 * 파일/폴더 이름 변경
 */
async function renameFile(fileId, newName) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: 'id, name',
  });
  return res.data;
}

/**
 * 파일/폴더 이동 (부모 변경)
 */
async function moveFile(fileId, newParentId, oldParentId) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  const res = await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: oldParentId,
    fields: 'id, parents',
  });
  return res.data;
}

/**
 * 폴더 이름으로 검색 (특정 부모 폴더 내)
 */
async function findFolderByName(name, parentFolderId) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');
  const q = `name = '${name}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, webViewLink)',
    pageSize: 1,
  });
  return (res.data.files || [])[0] || null;
}

/**
 * Base64 이미지를 Google Drive 폴더에 업로드
 * @param {string} base64Data - Base64 인코딩된 이미지 데이터 (data URL prefix 포함 가능)
 * @param {string} fileName - 업로드할 파일명
 * @param {string} mimeType - MIME 타입 (예: image/jpeg)
 * @param {string} parentFolderId - 업로드 대상 폴더 ID
 * @returns {{ id, name, webViewLink, webContentLink }}
 */
async function uploadFileBase64(base64Data, fileName, mimeType, parentFolderId) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');

  // data URL prefix 제거
  const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentFolderId],
    },
    media: {
      mimeType: mimeType || 'image/jpeg',
      body: stream,
    },
    fields: 'id, name, webViewLink, webContentLink',
  });

  // 파일을 "링크가 있는 모든 사용자" 읽기 가능으로 설정
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return res.data;
}

/**
 * 캡처폴더 하위의 차수별 서브폴더 찾기/생성
 * 경로: DRIVE_ROOT / [캡처] 캠페인명 / 차수명(또는 탭명) /
 */
async function getOrCreateSubFolder(parentFolderId, subFolderName) {
  if (!drive) throw new Error('Google Drive API가 설정되지 않았습니다.');

  // 기존 서브폴더 검색
  const existing = await findFolderByName(subFolderName, parentFolderId);
  if (existing) return existing;

  // 없으면 생성
  return await createFolder(subFolderName, parentFolderId);
}

module.exports = {
  listFolderContents,
  createFolder,
  renameFile,
  moveFile,
  findFolderByName,
  uploadFileBase64,
  getOrCreateSubFolder,
};
