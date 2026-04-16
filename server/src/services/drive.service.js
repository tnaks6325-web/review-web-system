const { drive } = require('./sheets.service');

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

module.exports = {
  listFolderContents,
  createFolder,
  renameFile,
  moveFile,
  findFolderByName,
};
