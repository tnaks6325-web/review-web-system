'use strict';

const assert = require('assert');
const pool = require('../src/db/pool');
const drive = require('../src/services/drive.service');
const sessions = require('../src/services/purchaseSubmissionSession.service');

const originalPoolQuery = pool.query;
const originalDrive = {};
const originalSessions = {};
for (const k of ['extractFolderIdFromUrl', 'trashDuplicateFile', 'uploadFileBase64', 'trashFiles']) originalDrive[k] = drive[k];
for (const k of ['inspectForUpload', 'markUploading', 'completeCapture', 'markFailed']) originalSessions[k] = sessions[k];

let poolCalls = [], driveCalls = [], failedMarks = [];
pool.query = async (sql, params) => {
  poolCalls.push({ sql: String(sql), params });
  if (/SELECT capture_folder_url FROM tab_configs/.test(sql)) {
    return { rows: [{ capture_folder_url: 'https://drive.google.com/drive/folders/FOLDER' }] };
  }
  return { rows: [], rowCount: 1 };
};
drive.extractFolderIdFromUrl = () => 'FOLDER';
drive.trashDuplicateFile = async (folder, name) => { driveCalls.push(['trash', folder, name]); };
drive.uploadFileBase64 = async (base64, name, mime, folder) => {
  driveCalls.push(['upload', folder, name, mime, base64]);
  return { id: 'FILE-1', name, webViewLink: 'view' };
};
drive.trashFiles = async files => { driveCalls.push(['trashFiles', files.map(x => x.id)]); return { success: files.length, failed: 0 }; };
sessions.markUploading = async x => { driveCalls.push(['markUploading', x.sessionId]); return true; };
sessions.markFailed = async x => { failedMarks.push(x); };

process.env.AI_REVIEW_FOLDER_ID = 'ROOT';
const router = require('../src/routes/diag.routes');
const layer = router.stack.find(x => x.route && x.route.path === '/image-upload');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

function response() {
  return {
    code: 200, body: null,
    status(n) { this.code = n; return this; },
    json(x) { this.body = x; return x; },
  };
}
function request(extra = {}) {
  return {
    path: '/image-upload', method: 'POST',
    body: {
      imageBase64: 'AAA', mimeType: 'image/jpeg', fileName: '홍길동.jpg',
      sheetId: 'client-evil', tabName: 'client-evil',
      orderSubmissionId: '11111111-1111-4111-8111-111111111111',
      captureSessionId: '22222222-2222-4222-8222-222222222222', captureSessionToken: 'token',
      ...extra,
    },
  };
}
async function invoke(req) {
  const res = response(); let nextErr = null;
  await handler(req, res, e => { nextErr = e; });
  if (nextErr) throw nextErr;
  return res;
}
let passed = 0;
async function t(name, fn) { poolCalls = []; driveCalls = []; failedMarks = []; await fn(); passed++; console.log('  ✓ ' + name); }

(async () => {
  console.log('\n[A] 세션 게이트 — Drive 호출 전');
  await t('세션이 없거나 위조되면 403이고 Drive 쓰기 0건', async () => {
    sessions.inspectForUpload = async () => ({ ok: false, code: 'capture_session_invalid' });
    const r = await invoke(request({ captureSessionToken: 'bad' }));
    assert.equal(r.code, 403); assert.equal(r.body.code, 'capture_session_invalid'); assert.equal(driveCalls.length, 0);
  });
  await t('이미 완료된 세션 재시도는 기존 fileId를 돌려주고 Drive 쓰기 0건', async () => {
    sessions.inspectForUpload = async () => ({ ok: true, alreadyCompleted: true, captureFileId: 'FILE-OLD' });
    const r = await invoke(request());
    assert.equal(r.body.ok, true); assert.equal(r.body.fileId, 'FILE-OLD'); assert.equal(driveCalls.length, 0);
  });

  console.log('\n[B] 정상 업로드와 클라이언트 좌표 위조');
  await t('세션에 고정된 작업 좌표로만 폴더를 찾고 주문ID로 완료한다', async () => {
    sessions.inspectForUpload = async () => ({
      ok: true, captureSheetId: 'server-sheet', captureTabName: 'server-tab', alreadyCompleted: false,
    });
    let completed = null;
    sessions.completeCapture = async x => { completed = x; return { ok: true, captureFileId: x.captureFileId }; };
    const r = await invoke(request());
    assert.equal(r.body.ok, true);
    const folderQuery = poolCalls.find(x => /SELECT capture_folder_url/.test(x.sql));
    assert.deepEqual(folderQuery.params, ['server-sheet', 'server-tab']);
    assert.equal(completed.orderSubmissionId, request().body.orderSubmissionId);
    assert.ok(driveCalls.find(x => x[0] === 'upload')[2].includes('__11111111_22222222.jpg'));
  });

  await t('같은 세션의 동시 업로드는 lease를 못 잡은 요청을 Drive 전에 409로 돌린다', async () => {
    sessions.inspectForUpload = async () => ({ ok: true, captureSheetId: 's', captureTabName: 't' });
    sessions.markUploading = async () => false;
    const r = await invoke(request());
    assert.equal(r.code, 409); assert.equal(r.body.code, 'capture_upload_in_progress');
    assert.equal(driveCalls.filter(x => x[0] === 'upload').length, 0);
    sessions.markUploading = async x => { driveCalls.push(['markUploading', x.sessionId]); return true; };
  });

  console.log('\n[C] 실패·재시도');
  await t('Drive 실패는 주문 성공을 되돌리지 않고 세션을 failed로 표시한다', async () => {
    sessions.inspectForUpload = async () => ({ ok: true, captureSheetId: 's', captureTabName: 't' });
    drive.uploadFileBase64 = async () => { throw Object.assign(new Error('drive down'), { code: 'drive_down' }); };
    const r = await invoke(request());
    assert.equal(r.body.ok, false); assert.ok(failedMarks.some(x => x.code === 'drive_down'));
    drive.uploadFileBase64 = originalDrive.uploadFileBase64;
    drive.uploadFileBase64 = async (base64, name, mime, folder) => {
      driveCalls.push(['upload', folder, name, mime, base64]); return { id: 'FILE-1', name };
    };
  });
  await t('Drive 성공 뒤 DB 연결 실패는 503+retryable로 응답하고 실패 상태를 남긴다', async () => {
    sessions.inspectForUpload = async () => ({ ok: true, captureSheetId: 's', captureTabName: 't' });
    sessions.completeCapture = async () => { throw Object.assign(new Error('db down'), { code: 'db_down' }); };
    const r = await invoke(request());
    assert.equal(r.code, 503); assert.equal(r.body.code, 'capture_link_failed'); assert.equal(r.body.retryable, true);
    assert.ok(failedMarks.some(x => x.code === 'db_down'));
  });
  await t('네트워크 재시도 파일명은 주문ID 기반으로 동일해 중복 파일을 늘리지 않는다', async () => {
    sessions.inspectForUpload = async () => ({ ok: true, captureSheetId: 's', captureTabName: 't' });
    sessions.completeCapture = async x => ({ ok: true, captureFileId: x.captureFileId });
    await invoke(request()); await invoke(request());
    const names = driveCalls.filter(x => x[0] === 'upload').map(x => x[2]);
    assert.equal(names.length, 2); assert.equal(names[0], names[1]);
  });
  await t('다른 세션이 먼저 완료했으면 이번에 업로드한 패배 파일만 휴지통 처리한다', async () => {
    sessions.inspectForUpload = async () => ({ ok: true, captureSheetId: 's', captureTabName: 't' });
    sessions.completeCapture = async () => ({ ok: true, alreadyCompleted: true, captureFileId: 'FILE-FIRST' });
    const r = await invoke(request());
    assert.ok(driveCalls.some(x => x[0] === 'trashFiles' && x[1][0] === 'FILE-1'));
    assert.equal(r.body.fileId, 'FILE-FIRST');
    assert.equal(r.body.alreadyCompleted, true);
  });

  console.log(`\n✅ purchaseCaptureRouteVirtual: ${passed}개 통과`);
})().catch(err => { console.error('\n❌ ' + err.stack); process.exitCode = 1; }).finally(() => {
  pool.query = originalPoolQuery;
  for (const [k, v] of Object.entries(originalDrive)) drive[k] = v;
  for (const [k, v] of Object.entries(originalSessions)) sessions[k] = v;
  delete process.env.AI_REVIEW_FOLDER_ID;
  setTimeout(() => process.exit(process.exitCode || 0), 20);
});
