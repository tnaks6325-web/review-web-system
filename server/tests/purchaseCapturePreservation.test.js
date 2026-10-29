'use strict';
// Actual upload handler; Drive/DB are isolated memory doubles only.
const assert = require('assert/strict');
const pool = require('../src/db/pool');
const drive = require('../src/services/drive.service');
const sessions = require('../src/services/purchaseSubmissionSession.service');
const folders = require('../src/services/captureFolder.service');
const sse = require('../src/utils/sse');
const originals = { query: pool.query, folder: folders.resolveCaptureFolder, root: process.env.AI_REVIEW_FOLDER_ID };
originals.emitImageUpload = sse.emitImageUpload;
const driveNames = ['trashDuplicateFile', 'uploadFileBase64', 'trashFiles'];
const sessionNames = ['inspectForUpload', 'markUploading', 'completeCapture', 'markFailed'];
const savedDrive = Object.fromEntries(driveNames.map(k => [k, drive[k]]));
const savedSessions = Object.fromEntries(sessionNames.map(k => [k, sessions[k]]));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function response() { return { code: 200, body: null, status(n) { this.code = n; return this; }, json(x) { this.body = x; return x; } }; }
const ORDER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
function request() { return { path: '/image-upload', method: 'POST', body: { imageBase64: 'dGVzdA==', mimeType: 'image/jpeg', fileName: 'local-test.jpg', orderSubmissionId: ORDER, captureSessionId: SESSION, captureSessionToken: 'local-token' } }; }
async function run() {
  process.env.AI_REVIEW_FOLDER_ID = 'LOCAL-ROOT';
  folders.resolveCaptureFolder = async () => ({ folderId: 'LOCAL-FOLDER', folderUrl: 'https://example.invalid/local-folder' });
  pool.query = async () => { throw new Error('Unexpected DB access; this test must remain local'); };
  const notifications = [];
  sse.emitImageUpload = payload => { notifications.push(payload); };
  const router = require('../src/routes/diag.routes');
  const layer = router.stack.find(x => x.route?.path === '/image-upload');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  async function invoke() { const res = response(); await handler(request(), res, e => { throw e; }); return res; }

  const files = new Map(); let fileCount = 0, winner = '', claims = 0, deletedByName = 0;
  const secondClaimed = deferred(), firstCompleted = deferred();
  sessions.inspectForUpload = async () => ({ ok: true, captureSheetId: 'local-sheet', captureTabName: 'local-tab', alreadyCompleted: false });
  sessions.markUploading = async () => {
    claims++;
    if (claims === 2) {
      // The 5-minute stale lease was reclaimed, but its HTTP/SQL response is delayed.
      secondClaimed.resolve(); await firstCompleted.promise;
    }
    return { attemptCount: claims };
  };
  sessions.markFailed = async () => {};
  sessions.completeCapture = async ({ captureFileId }) => {
    if (winner) return { ok: true, alreadyCompleted: true, captureFileId: winner };
    winner = captureFileId; firstCompleted.resolve(); return { ok: true, captureFileId };
  };
  drive.trashDuplicateFile = async (folderId, name) => {
    for (const f of files.values()) if (f.folderId === folderId && f.name === name && !f.trashed) { f.trashed = true; deletedByName++; }
  };
  drive.uploadFileBase64 = async (_base64, name, _mime, folderId) => {
    const id = 'LOCAL-FILE-' + (++fileCount), f = { id, name, folderId, trashed: false };
    files.set(id, f);
    if (fileCount === 1) await secondClaimed.promise;
    return { id, name, webViewLink: 'https://example.invalid/view/' + id, webContentLink: 'https://example.invalid/content/' + id };
  };
  drive.trashFiles = async targets => { for (const t of targets) { assert.ok(files.has(t.id)); files.get(t.id).trashed = true; } return { success: targets.length, failed: 0 }; };
  const replies = await Promise.all([invoke(), invoke()]);
  assert.ok(replies.every(x => x.body?.ok), 'Both completed requests return a usable winner');
  assert.ok(replies.every(x => x.body.fileId === winner), 'Responses use the committed winner');
  assert.equal(files.get(winner)?.trashed, false, 'A delayed reclaimed request must not trash the committed purchase photo');
  assert.equal(deletedByName, 0, 'Upload must never delete an existing photo by matching its name');
  assert.equal([...files.values()].filter(x => !x.trashed).length, 1, 'Only this request\'s confirmed loser may be trashed');
  const loserReply = replies.find(x => x.body.alreadyCompleted).body;
  assert.equal(loserReply.fileName, undefined, 'Winner ID cannot be mixed with loser filename');
  assert.equal(loserReply.webViewLink, undefined, 'Loser URL must not be returned after its file was trashed');
  assert.equal(loserReply.webContentLink, undefined);
  assert.equal(loserReply.captureIndex, 1);
  assert.equal(notifications.length, 1, 'Only the committed winning upload emits a notification');
  console.log('PASS delayed stale-lease request preserves the committed photo; network/production writes: 0');
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => {
  pool.query = originals.query; folders.resolveCaptureFolder = originals.folder;
  sse.emitImageUpload = originals.emitImageUpload;
  for (const [k, v] of Object.entries(savedDrive)) drive[k] = v;
  for (const [k, v] of Object.entries(savedSessions)) sessions[k] = v;
  if (originals.root === undefined) delete process.env.AI_REVIEW_FOLDER_ID; else process.env.AI_REVIEW_FOLDER_ID = originals.root;
  setTimeout(() => process.exit(process.exitCode || 0), 20);
});
