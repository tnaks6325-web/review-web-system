/**
 * retiredBulkTools.test.js — 결정 186(코드 다이어트)에서 제거한 "한 번에 운영 자료를 바꾸는" 옛 도구가
 * 되살아나지 않는지 본다. 모두 게이트가 authMiddleware(로그인 여부) 뿐이었다.
 *   62번  POST /api/tab/reset-all             — review_index·index_master·tab_configs·campaigns 등 전체 DELETE
 *   60번  POST /api/drive/migrate-names        — 모든 탭 폴더를 [리뷰]·[구매캡처]로 일괄 개명
 *   60번  POST /api/drive/reset-folder-urls    — 재탐색 없이 폴더 URL 비움
 *   74번  POST /api/admin/db-rebuild           — 운영 4표 전체 DELETE 후 구글시트에서 재등록(무시트 작업 복구 불가)
 *   270번 옛 관리자 대시보드 전용 입구(2026-10-22 · 결정 270) — 계정 관리·⬛ 마감/보관·주문 원장 편집·탭 일괄 설정 등.
 *         admin.html 은 결정 267 로 이미 없다. 되살리면 같은 화면 없는 쓰기 입구가 다시 열린다.
 * 실행: node tests/retiredBulkTools.test.js
 */
const assert = require('assert');
const tab = require('../src/routes/tabconfig.routes');
const drive = require('../src/routes/drive.routes');
const admin = require('../src/routes/admin.routes');
const has = (r, p) => r.stack.some(l => l.route && l.route.path === p);

assert.ok(!has(tab, '/reset-all'), '62번: 운영 자료 전체 초기화 입구가 되살아났다');
assert.ok(!has(drive, '/migrate-names'), '60번: 폴더 일괄 개명 입구가 되살아났다');
assert.ok(!has(drive, '/reset-folder-urls'), '60번: 폴더 URL 초기화 입구가 되살아났다');
assert.ok(!has(drive, '/migrate-to-new-structure'), '60번: 폴더 통째 복사 이관 입구가 되살아났다');
assert.ok(!has(admin, '/db-rebuild'), '74번: DB 재구축(전체 삭제 후 시트 재등록) 입구가 되살아났다');

// ── 결정 270: 옛 관리자 대시보드 전용 입구(라우터 스택 실검사 · diag 라우터는 /api/diag·viewer·image·blacklist 4곳에 마운트) ──
const fs = require('fs');
const path = require('path');
const diag = require('../src/routes/diag.routes');
const order = require('../src/routes/order.routes');
const reviewer = require('../src/routes/reviewer.routes');
const reviewEdit = require('../src/routes/reviewEdit.routes');
const index = require('../src/routes/index.routes');
const shortlink = require('../src/routes/shortlink.routes');
const gone = {
  admin: [admin, ['/users', '/staff-users', '/change-pw', '/change-master-pw', '/dashboard', '/keywords', '/keywords/:id',
    '/unrecognized', '/unrecognized/ignore', '/unrecognized/resolve', '/my-workboard-preferences',
    '/notices', '/notices/all', '/notices/:id', '/notices/unread', '/notices/read',
    '/error-logs', '/error-logs/detail', '/error-logs/analyze', '/error-logs/status', '/error-logs/resolve']],
  tab: [tab, ['/config', '/closed', '/reopen-slots', '/end-date', '/options', '/col-prefs', '/option-headers', '/option-columns',
    '/option-data', '/refresh-option-cache', '/dashboard']],
  diag: [diag, ['/events', '/stats/campaigns', '/stats/reviewers', '/stats/payments', '/stats/overview', '/metrics', '/pending-rows',
    '/unpaid-rows', '/app-url', '/preview-tab', '/add-tab', '/delete-campaign', '/order-ledger', '/order-edit', '/order-cancel',
    '/order-manual-add', '/review-type-cleanup', '/manager-cleanup', '/delivery-type-cleanup']],
  order: [order, ['/admin/list', '/admin/new-count', '/admin/send-memo', '/admin/delete', '/admin/accept', '/admin/status', '/admin/edit']],
  reviewer: [reviewer, ['/list', '/delete']],
  reviewEdit: [reviewEdit, ['/list', '/approve', '/reject']],
  drive: [drive, ['/save-capture', '/update-urls', '/remove-duplicates', '/check-submission-status']],
  index: [index, ['/status', '/dirty']],
  shortlink: [shortlink, ['/create']],
};
for (const [k, [r, paths]] of Object.entries(gone)) {
  for (const p of paths) assert.ok(!has(r, p), `270번: ${k} ${p} 옛 대시보드 입구가 되살아났다`);
}
assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src/routes/archive.routes.js')), '270번: /api/archive/* 라우터 파일이 되살아났다');
assert.ok(!/archive\.routes/.test(fs.readFileSync(path.join(__dirname, '..', 'src/app.js'), 'utf8')), '270번: /api/archive 마운트가 되살아났다');
// 같은 묶음에서 **남겨야 하는** 것 — 리뷰어·작업보드가 지금 부른다(지우면 실사용 경로가 끊긴다).
assert.ok(has(diag, '/review-upload'), '리뷰어 리뷰 캡처 업로드(/api/image/review-upload)가 사라졌다');
assert.ok(has(diag, '/metrics/reset') && has(diag, '/client-error') && has(diag, '/reverse-sync-list'), 'diag 잔류 입구가 사라졌다');
assert.ok(has(index, '/') && has(index, '/build') && has(index, '/build-sheet'), '/api/search·/api/index 잔류 입구가 사라졌다');
assert.ok(has(shortlink, '/resolve'), '단축링크 되찾기(/api/short/resolve)가 사라졌다');
// Track B 가 이름으로 부르는 핸들러는 경로를 지워도 남아 있어야 한다(지우면 trackB 가 기동 시 throw).
for (const [r, names] of [[admin, ['noticesUnread', 'noticesAll', 'errorLogsList', 'myNicknameGet']], [tab, ['tabConfigSave', 'providerInfo']],
  [diag, ['reviewUpload', 'reviewTypeCleanup', 'managerCleanup', 'deliveryTypeCleanup']], [order, ['orderAdminAccept', 'orderAdminEdit', 'orderAdminUpdate']],
  [reviewEdit, ['reviewEditList', 'reviewEditApprove', 'reviewEditReject']]]) {
  for (const n of names) assert.strictEqual(typeof r.handlers[n], 'function', `270번: Track B 위임 핸들러 ${n} 이 없다`);
}
console.log('✅ retiredBulkTools: 제거된 일괄 도구·옛 대시보드 입구 부재 확인');
process.exit(0);
