/**
 * cashReceiptPrivate.test.js — 현금영수증 사진에 공개 링크를 만들지 않는다(결정 433) 회귀가드.
 *
 * 배경(2026-11-27): 현금영수증 칸 사진도 리뷰 캡처와 같은 업로드 호출을 타서 파일마다
 *   「링크가 있는 누구나 보기」가 걸렸다. 리뷰 칸에 잘못 올라온 영수증이 자동·수동으로
 *   영수증 폴더에 옮겨져도 그 공개 권한은 그대로 따라갔다. 교체요청은 링크 공개인 최상위
 *   [리뷰수정대기]·[리뷰교체보관] 을 지났다.
 *
 * 고정하는 불변식:
 *   A. removePublicLinks — 파일에 **직접** 걸린 anyone·domain 만 지운다(물려받은 것·사람 권한은 그대로) · 던지지 않는다.
 *   B. deferShare 업로드는 뒤처리가 끝나는 약속(afterUpload)을 **열거되지 않게** 붙인다(응답 JSON 에 안 실림) —
 *      그 약속이 풀릴 때는 공개 권한이 이미 걸려 있다(먼저 걷으면 늦게 온 권한이 남는다).
 *   C. 현금영수증 칸 업로드 = shareAnyone:false(공개 권한 호출 0).
 *   D. 영수증 폴더로 옮기는 세 길(자동 분류·직원 수동 이동·되돌리기)이 공개 권한을 걷는다 · 자동 분류는 뒤처리를 기다린 뒤.
 *   E. 교체요청: 영수증이면 스테이징을 영수증 폴더 안에 · 공개 링크 없이 올림 · 승인 뒤 걷기 · 구 파일은 영수증 폴더 안 [교체보관].
 *
 * 실행: node tests/cashReceiptPrivate.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (name) => { n++; console.log('  ✓ ' + name); };

delete process.env.DRIVE_OAUTH_CLIENT_ID;
delete process.env.DRIVE_OAUTH_CLIENT_SECRET;
delete process.env.DRIVE_OAUTH_REFRESH_TOKEN;

let CALLS = [];
let PERMS = [];
let LIST_FAIL = false;
let DELETE_FAIL = new Set();

const fakeDrive = {
  files: {
    list: async () => ({ data: { files: [] } }),
    create: async (params) => {
      CALLS.push(params.media ? 'file.create' : 'folder.create');
      return { data: { id: 'FILE1', name: params.requestBody.name, webViewLink: 'L' } };
    },
  },
  permissions: {
    create: async (params) => {
      await new Promise((r) => setTimeout(r, 15));
      CALLS.push(params.requestBody && params.requestBody.role === 'owner' ? 'owner.transfer' : 'share.public');
      return { data: {} };
    },
    list: async () => {
      CALLS.push('perm.list');
      if (LIST_FAIL) throw new Error('boom');
      return { data: { permissions: PERMS } };
    },
    delete: async ({ permissionId }) => {
      CALLS.push('perm.delete:' + permissionId);
      if (DELETE_FAIL.has(permissionId)) throw new Error('cannot delete');
      return { data: {} };
    },
  },
  about: { get: async () => ({ data: { user: { emailAddress: 'sa@x' } } }) },
};

const sheetsPath = require.resolve('../src/services/sheets.service');
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: { drive: fakeDrive, sheets: {}, throttledCall: async (f) => f(), driveThrottledCall: async (f) => f() },
};

const D = require('../src/services/drive.service');
const SRC = path.join(__dirname, '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

(async () => {
  console.log('\nA) removePublicLinks');
  CALLS = []; LIST_FAIL = false; DELETE_FAIL = new Set();
  PERMS = [
    { id: 'anyoneDirect', type: 'anyone' },
    { id: 'domainDirect', type: 'domain', permissionDetails: [{ inherited: false }] },
    { id: 'anyoneInh', type: 'anyone', permissionDetails: [{ inherited: true }] },
    { id: 'staff', type: 'user' },
  ];
  let r = await D.removePublicLinks('F');
  assert.deepStrictEqual(r, { removed: 2, failed: 0 });
  assert.ok(CALLS.includes('perm.delete:anyoneDirect') && CALLS.includes('perm.delete:domainDirect'));
  assert.ok(!CALLS.includes('perm.delete:anyoneInh'), '물려받은 권한은 파일에서 지울 수 없다 — 시도하지 않는다');
  assert.ok(!CALLS.includes('perm.delete:staff'), '사람 권한을 지웠다');
  ok('직접 걸린 anyone·domain 만 지운다(물려받은 것·사람 권한 그대로)');

  CALLS = []; DELETE_FAIL = new Set(['anyoneDirect']);
  r = await D.removePublicLinks('F');
  assert.deepStrictEqual(r, { removed: 1, failed: 1 });
  CALLS = []; LIST_FAIL = true;
  r = await D.removePublicLinks('F');
  assert.deepStrictEqual(r, { removed: 0, failed: 1 });
  LIST_FAIL = false; DELETE_FAIL = new Set();
  ok('조회·삭제 실패는 던지지 않고 failed 로 센다');

  console.log('\nB) 뒤처리 약속(afterUpload)');
  CALLS = [];
  const up = await D.uploadFileBase64('QUJD', 'a.jpg', 'image/jpeg', 'FOLDER9', { deferShare: true });
  assert.ok(up.afterUpload && typeof up.afterUpload.then === 'function', '뒤처리 약속이 없다');
  assert.ok(!Object.keys(up).includes('afterUpload') && !JSON.stringify(up).includes('afterUpload'),
    '약속이 응답 JSON 에 실린다');
  assert.ok(!CALLS.includes('share.public'), '응답 전에 공개 권한을 기다렸다(결정 171 회귀)');
  await up.afterUpload;
  assert.ok(CALLS.includes('share.public'), '약속이 풀렸는데 공개 권한이 아직 안 걸렸다 — 먼저 걷으면 늦게 온 권한이 남는다');
  ok('약속은 공개 권한이 걸린 뒤에 풀린다 · 응답 JSON 에는 안 실린다');

  CALLS = [];
  const up2 = await D.uploadFileBase64('QUJD', 'b.jpg', 'image/jpeg', 'FOLDER9', { deferShare: true, shareAnyone: false });
  await up2.afterUpload;
  assert.ok(!CALLS.includes('share.public'));
  ok('shareAnyone:false + 미루기 = 공개 권한 호출 0');

  console.log('\nC·D) 소비처 배선');
  const diag = read('routes/diag.routes.js');
  const m = /uploadFileBase64\(\s*\n\s*file\.data,[\s\S]{0,900}?\)\;/.exec(diag);
  assert.ok(m && /\{ deferShare: true, shareAnyone: !_isReceiptUpload \}/.test(m[0]),
    '현금영수증 칸 업로드가 공개 링크를 만든다');
  ok('현금영수증 칸 업로드 = 공개 링크 없음');

  assert.match(diag, /moveFile\(uploaded\.id, toFolderId, targetFolderId\);\s*if \(rd\.target === 'receipt'\) \{[\s\S]{0,600}await uploaded\.afterUpload;\s*const rm = await driveService\.removePublicLinks\(uploaded\.id\)/,
    '자동 분류로 영수증 폴더에 옮긴 파일의 공개 권한을 (뒤처리를 기다린 뒤) 걷지 않는다');
  ok('자동 분류 → 영수증 폴더: 뒤처리 기다린 뒤 공개 권한 걷기');

  const fr = read('services/fileRoute.service.js');
  assert.match(fr, /moveFile\(fileId, toFolderId, parent\);\s*\/\/[^\n]*\n\s*if \(backTarget === 'receipt'\) await _dropPublicLinks\(driveService, fileId\);/,
    '되돌리기로 영수증 폴더에 돌아간 파일의 공개 권한을 걷지 않는다');
  assert.match(fr, /Drive 이동 실패[\s\S]{0,200}if \(MANUAL_ROUTE_TARGETS\[t\] === 'receipt'\) await _dropPublicLinks\(driveService, fileId\);/,
    '직원 수동 이동으로 영수증 칸에 옮긴 파일의 공개 권한을 걷지 않는다');
  ok('직원 수동 이동·되돌리기 → 영수증 폴더: 공개 권한 걷기');

  console.log('\nE) 교체요청');
  const re = read('routes/reviewEdit.routes.js');
  assert.match(re, /const rootFolderIdForStaging = isReceipt \? targetFolderId : rootFolderId;/,
    '영수증 교체 사진이 링크 공개 최상위 [리뷰수정대기] 에 놓인다');
  assert.match(re, /stagingFolderId, isReceipt \? \{ shareAnyone: false \} : \{\}/, '영수증 교체 사진에 공개 링크를 만든다');
  assert.match(re, /if \(_isReceiptSlot\) \{[\s\S]{0,200}removePublicLinks\(r0\.new_file_id\)/, '승인 뒤 영수증 교체 사진의 공개 권한을 걷지 않는다');
  assert.match(re, /_archiveOldFileAfterReply\(committed, _isReceiptSlot \? targetFolderId : null\);/, '영수증 구 파일을 공개 최상위 보관함으로 보낸다');
  const h = re.slice(re.indexOf('function _archiveOldFileAfterReply('), re.indexOf('_handlers.reviewEditApprove = async'));
  assert.match(h, /if \(receiptFolderId\) \{[\s\S]*getOrCreateSubFolder\(receiptFolderId, '\[교체보관\]'\)[\s\S]*removePublicLinks\(committed\.old_file_id\)[\s\S]*return;\s*\}\s*const archiveId = await _resolveArchiveFolder\(\);/,
    '영수증 구 파일 보관 갈래가 공개 보관함보다 먼저 끝나지 않는다');
  ok('교체요청: 영수증 폴더 안 대기·보관 · 공개 링크 없음 · 승인 뒤 걷기');

  console.log(`\n${n}/${n} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
