/**
 * retiredBulkTools.test.js — 결정 186(코드 다이어트)에서 제거한 "한 번에 운영 자료를 바꾸는" 옛 도구가
 * 되살아나지 않는지 본다. 모두 게이트가 authMiddleware(로그인 여부) 뿐이었다.
 *   62번  POST /api/tab/reset-all             — review_index·index_master·tab_configs·campaigns 등 전체 DELETE
 *   60번  POST /api/drive/migrate-names        — 모든 탭 폴더를 [리뷰]·[구매캡처]로 일괄 개명
 *   60번  POST /api/drive/reset-folder-urls    — 재탐색 없이 폴더 URL 비움
 *   74번  POST /api/admin/db-rebuild           — 운영 4표 전체 DELETE 후 구글시트에서 재등록(무시트 작업 복구 불가)
 *   272번 POST /api/drive/orphan-capture-cleanup · capture-rename-recipient · report-link (2026-10-22 · 결정 272)
 *         — 고아 캡처 휴지통 이동 · 리뷰 사진 파일명 일괄 변경(실행하면 1,291장이 남의 이름이 된다) · 공개 링크 발급.
 *   270번 옛 관리자 대시보드 전용 입구(2026-10-22 · 결정 270) — 계정 관리·⬛ 마감/보관·주문 원장 편집·탭 일괄 설정 등.
 *         admin.html 은 결정 267 로 이미 없다. 되살리면 같은 화면 없는 쓰기 입구가 다시 열린다.
 *   273번 시트 시절 큐 복구·스마트빌드 수동 도구(2026-10-22 · 결정 273 · 결정 186 82·88번) — 구글시트 반영 큐를 사람이
 *         다시 돌리거나(yellow-rows-delete 는 시트 행을 실제로 지운다) 색인을 시트에서 다시 읽던 입구. 시트 작업이 끝나 호출자 0.
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
assert.ok(has(diag, '/client-error') && has(diag, '/reverse-sync-list'), 'diag 잔류 입구가 사라졌다');
assert.ok(has(index, '/'), '/api/search·/api/index 검색 입구가 사라졌다');
assert.ok(has(shortlink, '/resolve'), '단축링크 되찾기(/api/short/resolve)가 사라졌다');
// Track B 가 이름으로 부르는 핸들러는 경로를 지워도 남아 있어야 한다(지우면 trackB 가 기동 시 throw).
for (const [r, names] of [[admin, ['noticesUnread', 'noticesAll', 'errorLogsList', 'myNicknameGet']], [tab, ['tabConfigSave', 'providerInfo']],
  [diag, ['reviewUpload', 'reviewTypeCleanup', 'managerCleanup', 'deliveryTypeCleanup']], [order, ['orderAdminAccept', 'orderAdminEdit', 'orderAdminUpdate']],
  [reviewEdit, ['reviewEditList', 'reviewEditApprove', 'reviewEditReject']]]) {
  for (const n of names) assert.strictEqual(typeof r.handlers[n], 'function', `270번: Track B 위임 핸들러 ${n} 이 없다`);
}
// ── 결정 272: Drive 남은 도구 3종(호출자 0) — 입구·서비스 파일·크론 배선 부재, 이미 보낸 보고 링크 열람은 남긴다 ──
for (const p of ['/orphan-capture-cleanup', '/capture-rename-recipient', '/report-link']) {
  assert.ok(!has(drive, p), `272번: /api/drive${p} 입구가 되살아났다`);
}
for (const f of ['orphanCaptureCleanup.service.js', 'captureFileRename.service.js']) {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src/services', f)), `272번: ${f} 가 되살아났다`);
}
assert.ok(!/orphanCaptureCleanup|trashOrphanCaptures|captureFileRename/.test(
  fs.readFileSync(path.join(__dirname, '..', 'src/jobs/cron.js'), 'utf8')), '272번: 크론이 고아 정리·파일명 정정을 다시 부른다');
assert.ok(has(drive, '/report/:code'), '업체에 이미 보낸 보고 링크 열람(GET /api/drive/report/:code)이 사라졌다');
assert.ok(has(drive, '/image/:id'), '보고 페이지·작업보드 이미지 프록시(GET /api/drive/image/:id)가 사라졌다');
assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'frontend/report.html')), '보고 페이지(report.html)가 사라졌다');
// ── 결정 273: 시트 시절 큐 복구·스마트빌드 수동 도구 — 입구·스케줄러 파일·크론 배선 부재 ──
for (const p of ['/sync-queue', '/sync-queue/retry', '/sync-queue/purge', '/sync-queue/delete', '/order-mirror-status', '/order-reconcile',
  '/order-flush-tab', '/order-flush-one', '/order-relink', '/order-orphan-cleanup', '/order-batch-state', '/order-batch-drain',
  '/queue-drain', '/order-written-sample', '/yellow-rows-export', '/yellow-rows-delete', '/build-history', '/metrics/reset', '/campaign-list']) {
  assert.ok(!has(diag, p), `273번: /api/diag${p} 입구가 되살아났다`);
}
for (const p of ['/release-lock', '/smart-build/status', '/smart-build/run', '/smart-build/start', '/smart-build/pause', '/smart-build/resume',
  '/smart-build/stop', '/campaign-delete/:sheetId']) {
  assert.ok(!has(admin, p), `273번: /api/admin${p} 입구가 되살아났다`);
}
for (const p of ['/build', '/build-sheet']) assert.ok(!has(index, p), `273번: /api/index${p}(=/api/search${p}) 입구가 되살아났다`);
for (const f of ['services/smartBuild.service.js', 'jobs/orderBatchScheduler.js']) {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', f)), `273번: ${f} 가 되살아났다`);
}
{
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'src/jobs/cron.js'), 'utf8');
  const bootSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(!/buildIndexSmart|checkDirtySheets|mirrorAllSheets|reconcileStuckOrders|runReverseSyncAutoCycle|kickOrderBatch|orderBatchScheduler/.test(cronSrc),
    '273번: 크론이 시트 색인 빌드·RAW 미러·시트 리컨실·역동기화 자동·배치 드레인을 다시 부른다');
  assert.ok(!/require\([^)]*smartBuild\.service|buildIndexSmart\(|'submitcol_fix_20260804_rebuilt'/.test(bootSrc), '273번: 부팅이 스마트빌드·1회성 전체 재빌드를 다시 돌린다');
}
// 273 에서 남긴 것 — 무시트 작업에도 쓰이는 DB 전용 수동 도구(지우면 복구 수단이 사라진다)
for (const p of ['/sheetless-worktable-recover', '/order-mirror-repair', '/order-stuck-export', '/row-claims', '/reverse-sync-apply']) {
  assert.ok(has(diag, p), `273번에서 남긴 /api/diag${p} 가 사라졌다`);
}
console.log('✅ retiredBulkTools: 제거된 일괄 도구·옛 대시보드 입구·Drive 남은 도구·시트 시절 큐/빌드 도구 부재 확인');
process.exit(0);
