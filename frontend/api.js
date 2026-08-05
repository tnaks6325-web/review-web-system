/**
 * ═══════════════════════════════════════════════════════════
 * 리뷰웹시스템 — API 통신 모듈 (GAS → Node.js 이관용)
 * 
 * 이 파일은 기존 gasGet()/gasPost() 함수를 교체합니다.
 * 원본 함수 이름은 유지하되, 내부적으로 Node.js Express API를 호출합니다.
 * 
 * 사용법:
 *   1. 각 HTML 파일의 <script> 태그 앞에 이 파일을 삽입합니다:
 *      <script src="api.js"></script>
 *   2. 기존 gasGet({ action: "searchAll", query: "..." }) 호출은
 *      자동으로 GET /api/search?query=... 로 변환됩니다.
 *   3. 기존 gasPost({ action: "setTabConfig", ... }) 호출은
 *      자동으로 POST /api/tab/config 로 변환됩니다.
 * 
 * 핵심 원칙:
 *   - 함수 이름 변경 금지 (gasGet, gasPost 유지)
 *   - GAS 응답 키 변경 금지 (error, success, results, ok 유지)
 *   - tab_key 구분자 변경 금지 ("||" 유지)
 * ═══════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════
// API 기본 URL 설정
// 개발: http://localhost:3000
// 프로덕션: Railway URL (예: https://review-system.up.railway.app)
// ═══════════════════════════════════════════════════════════
const API_BASE_URL = (function() {
  // 프로덕션 URL이 설정되어 있으면 사용
  if (typeof window !== 'undefined' && window.REVIEW_API_URL) {
    return window.REVIEW_API_URL;
  }
  // 현재 페이지가 localhost이면 개발 서버
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'http://localhost:3000';
  }
  // ★ Railway 프로덕션 URL
  return 'https://sublime-magic-production-790b.up.railway.app';
})();

// ═══════════════════════════════════════════════════════════
// GAS action 문자열 → Node.js 엔드포인트 매핑
// ═══════════════════════════════════════════════════════════
const _ACTION_MAP = {
  // 검색/인덱스 (Section 5)
  'searchAll':              { method: 'GET',  path: '/api/search' },
  'searchAllDebug':         { method: 'GET',  path: '/api/search/debug' },
  'buildIndexSmart':        { method: 'POST', path: '/api/index/build' },
  'indexStatus':            { method: 'GET',  path: '/api/index/status' },
  'getIndexMasterStatus':   { method: 'GET',  path: '/api/index/status' },
  'buildIndexByCampaign':   { method: 'POST', path: '/api/index/build-sheet' },

  // 탭 설정 (Section 6)
  'setTabConfig':     { method: 'POST', path: '/api/tab/config' },
  'getTabConfig':     { method: 'GET',  path: '/api/tab/config' },
  'reopenSlots':      { method: 'POST', path: '/api/tab/reopen-slots' },
  'listDetailSheet':  { method: 'GET',  path: '/api/tab/config' },
  'setClosed':        { method: 'POST', path: '/api/tab/closed' },
  'getTabOptions':    { method: 'GET',  path: '/api/tab/options' },
  'getTabEndDate':    { method: 'GET',  path: '/api/tab/end-date' },
  'getCampaignStats': { method: 'GET',  path: '/api/diag/campaign-stats' },

  // 주문 원장(order ledger) PR-B — DB 주체 인라인 뷰어/편집/취소/수동추가
  'orderLedgerList':  { method: 'GET',  path: '/api/diag/order-ledger' },
  'orderEdit':        { method: 'POST', path: '/api/diag/order-edit' },
  'orderCancel':      { method: 'POST', path: '/api/diag/order-cancel' },
  'orderManualAdd':   { method: 'POST', path: '/api/diag/order-manual-add' },
  'syncTabFromSheet': { method: 'POST', path: '/api/tab/sync-from-sheet' },  // deprecated
  'syncTabNames':     { method: 'POST', path: '/api/tab/sync-tab-names' },
  // [DEPRECATED v11.8.0] 2탭 통합으로 폐기된 액션 — 서버에서 deprecated 응답 반환
  'syncMasterSheet':  { method: 'POST', path: '/api/tab/sync-master' },       // deprecated
  'scanMasterSheet':  { method: 'POST', path: '/api/tab/scan-master' },       // deprecated
  'fullMasterSync':   { method: 'POST', path: '/api/tab/full-sync' },         // deprecated
  'syncSettingsOnly': { method: 'POST', path: '/api/tab/sync-settings' },     // deprecated
  // 인덱스 스캔 + DB 동기화 (정상 경로)
  'indexScan':        { method: 'POST', path: '/api/tab/index-scan' },
  'indexScanSync':    { method: 'POST', path: '/api/tab/index-scan-sync' },
  'resetAllData':     { method: 'POST', path: '/api/tab/reset-all' },

  'getTabDashboard':  { method: 'GET',  path: '/api/tab/dashboard' },
  'getColPrefs':      { method: 'GET',  path: '/api/tab/col-prefs' },
  'saveColPrefs':     { method: 'POST', path: '/api/tab/col-prefs' },
  'backfillGid':      { method: 'POST', path: '/api/tab/backfill-gid' },
  'fixSheetUrls':     { method: 'POST', path: '/api/tab/fix-sheet-urls' },
  // 옵션(Option) 기능
  'getOptionHeaders': { method: 'GET',  path: '/api/tab/option-headers' },
  'saveOptionColumns':{ method: 'POST', path: '/api/tab/option-columns' },
  'getOptionData':    { method: 'GET',  path: '/api/tab/option-data' },
  'getReviewerOptions':{ method: 'GET', path: '/api/tab/reviewer-options' },
  'refreshOptionCache':{ method: 'POST', path: '/api/tab/refresh-option-cache' },
  'getProviderInfo':   { method: 'GET',  path: '/api/tab/provider-info' },
  'setCompanyBusinessNo':{ method: 'POST', path: '/api/tab/company-business-no' },

  // 리뷰어 관리 (Section 7)
  'registerReviewer':   { method: 'POST', path: '/api/reviewer/register' },
  'verifyReviewer':     { method: 'GET',  path: '/api/reviewer/verify' },
  'lookupPhone':        { method: 'GET',  path: '/api/reviewer/lookup' },
  'getReviewerList':    { method: 'GET',  path: '/api/reviewer/list' },
  'deleteReviewer':     { method: 'POST', path: '/api/reviewer/delete' },
  'getReviewerProfile': { method: 'POST', path: '/api/reviewer/profile', remap: 'get' },
  'saveSubAccounts':    { method: 'POST', path: '/api/reviewer/profile', remap: 'saveSubAccounts' },
  'saveIncomeInfo':     { method: 'POST', path: '/api/reviewer/profile', remap: 'saveIncomeInfo' },
  'saveBankInfo':       { method: 'POST', path: '/api/reviewer/profile', remap: 'saveBankInfo' },
  'saveAddress':        { method: 'POST', path: '/api/reviewer/profile', remap: 'saveAddress' },
  'identityPrecheck':   { method: 'POST', path: '/api/reviewer/identity-precheck' },

  // 리뷰어 소식·공지
  'reviewerNotices':      { method: 'GET',  path: '/api/reviewer/notices' },        // 공개
  'reviewerNoticesAll':   { method: 'GET',  path: '/api/reviewer/notices/all' },    // 관리자
  'reviewerNoticeSave':   { method: 'POST', path: '/api/reviewer/notices/save' },   // 관리자
  'reviewerNoticeDelete': { method: 'POST', path: '/api/reviewer/notices/delete' }, // 관리자
  'getInaedList':       { method: 'GET',  path: '/api/submit/get-inaed-list' },

  // 관리자 인증 (Section 8)
  'adminLogin':         { method: 'POST', path: '/api/admin/login' },
  'adminLoginV2':       { method: 'POST', path: '/api/admin/login' },
  'adminChangePw':      { method: 'POST', path: '/api/admin/change-pw' },
  'adminMyNickname':    { method: 'GET',  path: '/api/admin/my-nickname' },
  'adminSaveNickname':  { method: 'POST', path: '/api/admin/my-nickname' },
  'changeMasterPw':     { method: 'POST', path: '/api/admin/change-master-pw' },
  'addAdminUser':       { method: 'POST', path: '/api/admin/users', remap: 'add' },
  'editAdminUser':      { method: 'POST', path: '/api/admin/users', remap: 'edit' },
  'deleteAdminUser':    { method: 'POST', path: '/api/admin/users', remap: 'delete' },
  'listAdminUsers':     { method: 'POST', path: '/api/admin/users', remap: 'list' },
  'dashboard':          { method: 'GET',  path: '/api/admin/dashboard' },
  'releaseBuildLock':   { method: 'POST', path: '/api/admin/release-lock' },
  
  // 영업담당자 (Staff)
  'staffLogin':         { method: 'POST', path: '/api/admin/staff-login' },
  'addStaffUser':       { method: 'POST', path: '/api/admin/staff-users', remap: 'add' },
  'editStaffUser':      { method: 'POST', path: '/api/admin/staff-users', remap: 'edit' },
  'deleteStaffUser':    { method: 'POST', path: '/api/admin/staff-users', remap: 'delete' },
  'listStaffUsers':     { method: 'POST', path: '/api/admin/staff-users', remap: 'list' },

  // 관리자 공지사항
  'getNotices':         { method: 'GET',  path: '/api/admin/notices' },
  'getAllNotices':      { method: 'GET',  path: '/api/admin/notices/all' },
  'createNotice':       { method: 'POST', path: '/api/admin/notices' },
  'getUnreadNotices':   { method: 'GET',  path: '/api/admin/notices/unread' },
  'markNoticeRead':     { method: 'POST', path: '/api/admin/notices/read' },

  // Drive 폴더 (Section 9)
  'syncCaptureFolders':     { method: 'POST', path: '/api/drive/sync-capture' },
  'syncReviewFolders':      { method: 'POST', path: '/api/drive/sync-review' },
  'syncAllFolders':         { method: 'POST', path: '/api/drive/sync-all' },
  'batchCreateFolders':     { method: 'POST', path: '/api/drive/batch-create' },
  'resetTabFolderUrls':     { method: 'POST', path: '/api/drive/reset-folder-urls' },
  'migrateFolderNames':     { method: 'POST', path: '/api/drive/migrate-names' },
  'organizeCaptureFolders': { method: 'POST', path: '/api/drive/organize-capture' },
  'saveCaptureFolder':      { method: 'POST', path: '/api/drive/save-capture' },
  'updateFolderUrls':       { method: 'POST', path: '/api/drive/update-urls' },
  'findFolderCandidates':   { method: 'POST', path: '/api/drive/find-candidates' },
  'diagCaptureFolders':     { method: 'GET',  path: '/api/drive/diag' },

  // 단축URL / 메모 (Section 10)
  'createShort':  { method: 'POST', path: '/api/short/create' },
  'resolveShort': { method: 'GET',  path: '/api/short/resolve' },
  'getMemo':      { method: 'GET',  path: '/api/memo' },
  'saveMemo':     { method: 'POST', path: '/api/memo' },
  'deleteMemo':   { method: 'POST', path: '/api/memo' }, // DELETE는 브라우저 제약이 있으므로 POST

  // 입금처리 (Section 11)
  'getPaymentTargets': { method: 'GET',  path: '/api/payment/targets' },
  'markPaymentDone':   { method: 'POST', path: '/api/payment/mark-done' },

  // 제출 (Section 12)
  'submitReview':       { method: 'POST', path: '/api/submit/review' },
  'submitOrderForm':    { method: 'POST', path: '/api/submit/order' },
  'checkReviewFiles':   { method: 'POST', path: '/api/submit/check-files' },
  'checkDuplicateOrder':{ method: 'POST', path: '/api/submit/check-duplicate' },
  'findSlot':           { method: 'POST', path: '/api/submit/find-slot' },

  // 진단/기타
  'debugTabConfig':     { method: 'GET',  path: '/api/diag/debug-tab' },
  'debugSheet':         { method: 'GET',  path: '/api/diag/debug-sheet' },
  'debugBaseSheet':     { method: 'GET',  path: '/api/diag/debug-base' },
  'debugDetailSheet':   { method: 'GET',  path: '/api/diag/debug-tab' },
  'campaignList':       { method: 'GET',  path: '/api/diag/campaign-list' },
  'previewCampaign':    { method: 'GET',  path: '/api/diag/preview-campaign' },
  'addCampaign':        { method: 'POST', path: '/api/diag/add-campaign' },
  'deleteCampaign':     { method: 'DELETE', path: '/api/diag/delete-campaign' },
  'createBaseSheet':    { method: 'POST', path: '/api/diag/new-sheet' },

  // 뷰어
  'getViewerData':  { method: 'GET', path: '/api/viewer/viewer-data' },

  // 블랙리스트
  'blacklist':      { method: 'POST', path: '/api/blacklist' },

  // 리뷰어 비정상 로그 (한글 자연어, migration 062 — 중요알림 카드/리뷰웹시스템[3버전] 로그 창)
  'reviewerLogsList':   { method: 'GET',  path: '/api/trackb/reviewer-logs' },
  'reviewerLogResolve': { method: 'POST', path: '/api/trackb/reviewer-logs/resolve' },
  'reviewerLogCancelOrder': { method: 'POST', path: '/api/trackb/reviewer-logs/cancel-order' },

  // 시트 상단 강제 공지문 (C1:R1) — 신규 탭 자동 삽입 + 기존 탭 일괄 적용
  'sheetNoticeGet':      { method: 'GET',  path: '/api/diag/sheet-notice' },
  'sheetNoticeSet':      { method: 'POST', path: '/api/diag/sheet-notice' },
  'sheetNoticeBulk':     { method: 'POST', path: '/api/diag/sheet-notice-bulk' },
  'sheetNoticeBulkStat': { method: 'GET',  path: '/api/diag/sheet-notice-bulk' },

  // 이미지 (Gemini AI + Drive)
  'extractOrderImage':   { method: 'POST', path: '/api/image/image-extract' },
  'uploadOrderImage':    { method: 'POST', path: '/api/image/image-upload' },
  'verifyAddressMatch':  { method: 'POST', path: '/api/image/verify-address' },
  'uploadReviewImage':   { method: 'POST', path: '/api/image/review-upload' },

  // 리뷰 이미지 수정요청 (리뷰어 → 관리자 승인)
  'reviewEditMyFiles':    { method: 'GET',  path: '/api/review-edit/my-files' },
  'reviewEditRequest':    { method: 'POST', path: '/api/review-edit/request' },
  'reviewEditMyRequests': { method: 'GET',  path: '/api/review-edit/my-requests' },
  'reviewEditCancel':     { method: 'POST', path: '/api/review-edit/cancel' },
  'reviewEditList':       { method: 'GET',  path: '/api/review-edit/list' },
  'reviewEditApprove':    { method: 'POST', path: '/api/review-edit/approve' },
  'reviewEditReject':     { method: 'POST', path: '/api/review-edit/reject' },

  // Drive 폴더 관리
  'initRootFolder':      { method: 'POST', path: '/api/drive/init-root' },
  'syncCaptureFolders':  { method: 'POST', path: '/api/drive/sync-capture' },
  'syncReviewFolders':   { method: 'POST', path: '/api/drive/sync-review' },
  'syncAllFolders':      { method: 'POST', path: '/api/drive/sync-all' },
  'batchCreateFolders':  { method: 'POST', path: '/api/drive/batch-create' },
  'migrateToNewStructure': { method: 'POST', path: '/api/drive/migrate-to-new-structure' },
  'driveDiag':           { method: 'GET',  path: '/api/drive/diag' },
  'driveAccountInfo':    { method: 'GET',  path: '/api/drive/account-info' },
  'driveOwnershipAudit': { method: 'POST', path: '/api/drive/ownership-audit' },
  'driveTransferOwnership': { method: 'POST', path: '/api/drive/transfer-ownership' },
  'checkDuplicates':     { method: 'POST', path: '/api/drive/check-duplicates' },
  'removeDuplicates':    { method: 'POST', path: '/api/drive/remove-duplicates' },
  'checkSubmissionStatus': { method: 'POST', path: '/api/drive/check-submission-status' },
  'relocateOrphanReviews': { method: 'POST', path: '/api/drive/relocate-orphan-reviews' },
  'reviewFolderBackfill': { method: 'POST', path: '/api/drive/review-folder-backfill' },
  'reviewSubmissions':     { method: 'GET',  path: '/api/drive/review-submissions' },
  'moveFolderContents':    { method: 'POST', path: '/api/drive/move-folder-contents' },
  'folderAudit':           { method: 'POST', path: '/api/drive/folder-audit' },
  'shareReviewFolder':     { method: 'POST', path: '/api/drive/share-review-folder' },
  'reviewReportLink':      { method: 'POST', path: '/api/drive/report-link' },
  'getPendingRows':      { method: 'GET',  path: '/api/diag/pending-rows' },
  'getUnpaidRows':       { method: 'GET',  path: '/api/diag/unpaid-rows' },
  'addTab':              { method: 'POST', path: '/api/diag/add-tab' },
  'previewTab':          { method: 'GET',  path: '/api/diag/preview-tab' },

  // 기타 GAS 전용 (호환성)
  'getAppUrl':      { method: 'GET',  path: '/api/diag/app-url' },
  'saveAppUrl':     { method: 'POST', path: '/api/diag/app-url' },
  'convertToNcHeaders': { method: 'POST', path: '/api/diag/convert-nc-headers' },
  'createCampaignSheet': { method: 'POST', path: '/api/diag/create-campaign-sheet' },

  // Phase 2-5: Sync Queue + Build History
  'syncQueueStats':     { method: 'GET',  path: '/api/diag/sync-queue' },
  'syncQueueRetry':     { method: 'POST', path: '/api/diag/sync-queue/retry' },
  'syncQueuePurge':     { method: 'POST', path: '/api/diag/sync-queue/purge' },
  'syncQueueDelete':    { method: 'POST', path: '/api/diag/sync-queue/delete' },
  'orderMirrorStatus':  { method: 'GET',  path: '/api/diag/order-mirror-status' },
  'orderReconcile':     { method: 'POST', path: '/api/diag/order-reconcile' },
  'queueDrain':         { method: 'POST', path: '/api/diag/queue-drain' },
  'buildHistory':       { method: 'GET',  path: '/api/diag/build-history' },

  // Phase 12: 시트 권한 관리
  'shareSheet':         { method: 'POST', path: '/api/diag/share-sheet' },
  'shareAllSheets':     { method: 'POST', path: '/api/diag/share-all-sheets' },
  'sheetPermissions':   { method: 'GET',  path: '/api/diag/sheet-permissions' },

  // Phase 10: Archive (탭 단위 마감)
  'archiveDetect':      { method: 'GET',  path: '/api/archive/detect' },
  'archiveTabs':        { method: 'POST', path: '/api/archive/tabs' },
  'archiveList':        { method: 'GET',  path: '/api/archive/list' },
  'archiveHistory':     { method: 'GET',  path: '/api/archive/history' },
  'unhideTab':          { method: 'POST', path: '/api/archive/unhide-tab' },
  'hideTab':            { method: 'POST', path: '/api/archive/hide-tab' },
  'archiveRestore':     { method: 'POST', path: '/api/archive/restore' },
  'archiveRestoreRound': { method: 'POST', path: '/api/archive/restore-round' },

  // Phase 11: Campaign Name Fix
  'fixCampaignNames':   { method: 'POST', path: '/api/diag/fix-campaign-names' },
  'sheetTitles':        { method: 'GET',  path: '/api/diag/sheet-titles' },

  // Phase 13: Empty Index Cleanup
  'cleanupEmptyIndexes': { method: 'POST', path: '/api/diag/cleanup-empty-indexes' },

  // Phase 14: 키워드 관리 + 인식 실패 탭 진단
  'getKeywords':           { method: 'GET',    path: '/api/admin/keywords' },
  'addKeyword':            { method: 'POST',   path: '/api/admin/keywords' },
  'toggleKeyword':         { method: 'PUT',    path: '/api/admin/keywords' },    // /:id 는 호출 시 path 조합
  'deleteKeyword':         { method: 'DELETE', path: '/api/admin/keywords' },    // /:id
  'getUnrecognized':       { method: 'GET',    path: '/api/admin/unrecognized' },
  'ignoreUnrecognized':    { method: 'POST',   path: '/api/admin/unrecognized/ignore' },
  'resolveUnrecognized':   { method: 'POST',   path: '/api/admin/unrecognized/resolve' },

  // 오류디버깅(Error Debugging) — error_logs
  'getErrorLogs':          { method: 'GET',    path: '/api/admin/error-logs' },
  'errorLogDetail':        { method: 'GET',    path: '/api/admin/error-logs/detail' },
  'errorLogAnalyze':       { method: 'POST',   path: '/api/admin/error-logs/analyze' },
  'errorLogStatus':        { method: 'POST',   path: '/api/admin/error-logs/status' },
  'resolveErrorLog':       { method: 'POST',   path: '/api/admin/error-logs/resolve' }, // 구버전 호환

  // ★ 스마트 빌드 (Drive API + Sheets batchGet 기반)
  'smartBuildStatus':      { method: 'GET',  path: '/api/admin/smart-build/status' },
  'smartBuildRun':         { method: 'POST', path: '/api/admin/smart-build/run' },
  'smartBuildStart':       { method: 'POST', path: '/api/admin/smart-build/start' },
  'smartBuildStop':        { method: 'POST', path: '/api/admin/smart-build/stop' },

  // ★ DB 전체 재구축 (초기화 → 탭목록 재등록 → 스마트빌드)
  'dbRebuild':             { method: 'POST', path: '/api/admin/db-rebuild' },

  // ★ 모집공고(캠페인) 시스템
  'campaignList':          { method: 'GET',  path: '/api/campaign/list' },
  'campaignDetail':        { method: 'GET',  path: '/api/campaign' },  // /:id 동적
  'campaignApply':         { method: 'POST', path: '/api/campaign' },  // /:id/apply 동적
  'campaignAdminList':     { method: 'GET',  path: '/api/campaign/admin/list' },
  'campaignAdminCreate':   { method: 'POST', path: '/api/campaign/admin/create' },
  'campaignAdminUpdate':   { method: 'PUT',  path: '/api/campaign/admin' },   // /:id 동적
  'campaignAdminDelete':   { method: 'DELETE', path: '/api/campaign/admin' }, // /:id 동적
  'campaignAdminStatus':   { method: 'PUT',  path: '/api/campaign/admin' },   // /:id/status 동적
  'campaignApplications':  { method: 'GET',  path: '/api/campaign/admin' },   // /:id/applications 동적

  // ★ 작업 오더(work_orders) 시스템 — 동적 /:id 미지원이라 전부 평면경로 + body/query id
  'orderSubmit':           { method: 'POST', path: '/api/order/submit' },
  'orderGuideImage':       { method: 'POST', path: '/api/order/guide-image' },
  'orderMyList':           { method: 'GET',  path: '/api/order/my' },
  'orderMyUpdate':         { method: 'PUT',  path: '/api/order/my/update' },
  'orderAdminList':        { method: 'GET',  path: '/api/order/admin/list' },
  'orderNewCount':         { method: 'GET',  path: '/api/order/admin/new-count' },
  'orderAdminStatus':      { method: 'PUT',  path: '/api/order/admin/status' },
  'orderAdminAccept':      { method: 'POST', path: '/api/order/admin/accept' },
  'orderAdminUpdate':      { method: 'PUT',  path: '/api/order/admin/update' },
  'orderAdminEdit':        { method: 'PUT',  path: '/api/order/admin/edit' },
  'orderSendMemo':         { method: 'PUT',  path: '/api/order/admin/send-memo' },
  'orderAdminDelete':      { method: 'DELETE', path: '/api/order/admin/delete' },
  'productPreview':        { method: 'POST', path: '/api/product/preview' },

  // ★ C/S 문의창구 — 리뷰어 (토큰 없음, phone8 기반)
  'csReviewerCampaigns':   { method: 'GET',  path: '/api/reviewer/cs/campaigns' },
  'csReviewerThreads':     { method: 'GET',  path: '/api/reviewer/cs/threads' },
  'csReviewerUnread':      { method: 'GET',  path: '/api/reviewer/cs/unread' },
  'csReviewerMessages':    { method: 'GET',  path: '/api/reviewer/cs/messages' },
  'csReviewerSend':        { method: 'POST', path: '/api/reviewer/cs/message' },
  'csReviewerUpload':      { method: 'POST', path: '/api/reviewer/cs/upload' },

  // ★ C/S 문의창구 — 관리자 (JWT + admin/master)
  'csAdminThreads':        { method: 'GET',  path: '/api/cs/threads' },
  'csAdminUnread':         { method: 'GET',  path: '/api/cs/unread-count' },
  'csAdminMessages':       { method: 'GET',  path: '/api/cs/messages' },
  'csAdminOrderContext':   { method: 'GET',  path: '/api/cs/order-context' },
  'csAdminReply':          { method: 'POST', path: '/api/cs/reply' },
  'csAdminUpload':         { method: 'POST', path: '/api/cs/upload' },
  'csAdminStatus':         { method: 'POST', path: '/api/cs/status' },
  'csAdminSaveMemo':       { method: 'POST', path: '/api/cs/memo' },

  // ★ 구글시트 전체 RAW 미러링 (Section 14)
  'rawMirror':  { method: 'POST', path: '/api/raw/mirror' },
  'rawStatus':  { method: 'GET',  path: '/api/raw/status' },
  'rawTabs':    { method: 'GET',  path: '/api/raw/tabs' },
  'rawRows':    { method: 'GET',  path: '/api/raw/rows' },

  // ★ 명시적 컬럼 매핑 (Section 15)
  'mappingFields': { method: 'GET',  path: '/api/mapping/fields' },
  'mappingGet':    { method: 'GET',  path: '/api/mapping' },
  'mappingSave':   { method: 'POST', path: '/api/mapping' },
  'mappingCoverage': { method: 'GET', path: '/api/mapping/coverage' },
  'mappingDrift':    { method: 'GET', path: '/api/mapping/drift' },
};

// ═══════════════════════════════════════════════════════════
// JWT 토큰 관리
// ═══════════════════════════════════════════════════════════
function _getAuthHeaders() {
  const token = sessionStorage.getItem('admin_token');
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

/**
 * 라우트 경로 재기준 — 같은 화면 모듈을 다른 네임스페이스로 재사용하기 위한 최소 장치.
 *
 * 리뷰웹시스템[3버전](workdesk.html)는 인트라넷 SSO 토큰(`via:'intranet'`)을 쓰는데,
 * authMiddleware 가 그 토큰을 **`/api/trackb/*` 로만 격리**하므로 `/api/cs/*` 에는
 * 도달 자체가 불가능하다. 그래서 서버에 같은 모양의 프록시(`/api/trackb/cs/*`)를 두고
 * 프론트는 **베이스 문자열만** 갈아끼운다 — C/S 화면 코드는 한 벌 그대로다.
 *
 * ★ 전역을 설정한 페이지에서만 동작한다 — admin.html 은 설정하지 않으므로 동작 불변.
 */
function _resolveApiPath(p) {
  const base = (typeof window !== 'undefined') && window.CS_API_BASE;
  return (base && p.indexOf('/api/cs/') === 0) ? base + p.slice('/api/cs'.length) : p;
}

// ═══════════════════════════════════════════════════════════
// gasGet — GAS doGet 대체 (GET 요청)
// 기존 호출: gasGet({ action: "searchAll", query: "홍길동" })
// 변환 후:   GET /api/search?query=홍길동
// ═══════════════════════════════════════════════════════════
async function gasGet(params, timeout) {
  const action = params.action || '';
  const route = _ACTION_MAP[action];

  if (!route) {
    console.warn('[gasGet] 매핑 없는 action:', action);
    return { error: '알 수 없는 action: ' + action };
  }

  // action 필드 제거 후 나머지 파라미터 분리
  const { action: _, ...queryParams } = params;
  const actualMethod = route.method || 'GET';
  const timeoutMs = timeout || 30000;

  let url, fetchOpts;

  if (actualMethod === 'POST' || actualMethod === 'DELETE' || actualMethod === 'PUT' || actualMethod === 'PATCH') {
    // ★ POST/DELETE/PUT/PATCH 매핑된 action은 body로 전송
    // ★ remap이 있으면 백엔드가 기대하는 action 필드를 복원 (멀티-액션 라우트용)
    if (route.remap) queryParams.action = route.remap;
    url = API_BASE_URL + _resolveApiPath(route.path);
    fetchOpts = {
      method: actualMethod,
      headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
      body: JSON.stringify(queryParams),
    };
  } else {
    // GET 매핑은 쿼리스트링으로
    const qs = new URLSearchParams();
    Object.entries(queryParams).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    });
    url = API_BASE_URL + _resolveApiPath(route.path) + (qs.toString() ? '?' + qs.toString() : '');
    fetchOpts = {
      method: 'GET',
      headers: { ..._getAuthHeaders() },
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetchOpts.signal = controller.signal;

    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);

    const json = await res.json();
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: '요청 시간이 초과되었습니다.' };
    }
    console.error('[gasGet] 오류:', action, err.message);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// gasPost — GAS doPost 대체 (POST 요청)
// 기존 호출: gasPost({ action: "setTabConfig", sheetId: "...", tabName: "..." })
// 변환 후:   POST /api/tab/config { sheetId, tabName, ... }
// ═══════════════════════════════════════════════════════════
async function gasPost(body, timeout) {
  const action = body.action || '';
  const route = _ACTION_MAP[action];

  if (!route) {
    console.warn('[gasPost] 매핑 없는 action:', action);
    return { error: '알 수 없는 action: ' + action };
  }

  // action 필드 제거 (서버에서는 라우트로 구분)
  const { action: _, ...payload } = body;

  // ★ remap이 있으면 백엔드가 기대하는 action 필드를 복원 (멀티-액션 라우트용)
  if (route.remap) {
    payload.action = route.remap;
  }

  const url = API_BASE_URL + _resolveApiPath(route.path);
  const timeoutMs = timeout || 60000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ..._getAuthHeaders(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = await res.json();

    // ★ 로그인 성공 시 JWT 토큰 자동 저장
    if ((action === 'adminLoginV2' || action === 'adminLogin' || action === 'staffLogin') && json.success && json.token) {
      sessionStorage.setItem('admin_token', json.token);
    }

    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      const isUpload = action.toLowerCase().includes('upload') || action.toLowerCase().includes('image');
      const msg = isUpload
        ? '이미지 업로드 시간이 초과되었습니다. 네트워크 상태를 확인하고 이미지 수를 줄여 다시 시도해주세요.'
        : '요청 시간이 초과되었습니다.';
      return { error: msg };
    }
    console.error('[gasPost] 오류:', action, err.message);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// 업로드 진행률 UI + XHR 기반 업로드 (이미지 업로드 전용)
// ═══════════════════════════════════════════════════════════

/** 업로드 진행률 오버레이 (싱글톤) */
const _uploadProgress = {
  _el: null,
  _bar: null,
  _text: null,
  _pct: null,

  _ensure() {
    if (this._el) return;
    const overlay = document.createElement('div');
    overlay.id = '_apiUploadProgress';
    overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:99999;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:28px 32px;min-width:280px;max-width:340px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.2)">
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:14px" id="_upText">이미지 업로드 중...</div>
        <div style="background:#e2e8f0;border-radius:8px;height:10px;overflow:hidden;margin-bottom:8px">
          <div id="_upBar" style="height:100%;width:0%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:8px;transition:width .3s ease"></div>
        </div>
        <div id="_upPct" style="font-size:12px;color:#64748b">0%</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:8px">네트워크 상태에 따라 시간이 걸릴 수 있습니다</div>
      </div>`;
    document.body.appendChild(overlay);
    this._el = overlay;
    this._bar = overlay.querySelector('#_upBar');
    this._text = overlay.querySelector('#_upText');
    this._pct = overlay.querySelector('#_upPct');
  },

  show(label) {
    this._ensure();
    this._bar.style.width = '0%';
    this._pct.textContent = '0%';
    this._text.textContent = label || '이미지 업로드 중...';
    this._el.style.display = 'flex';
  },

  update(percent) {
    if (!this._el) return;
    const p = Math.min(100, Math.max(0, Math.round(percent)));
    this._bar.style.width = p + '%';
    this._pct.textContent = p + '%';
    if (p >= 100) this._text.textContent = '서버 처리 중...';
  },

  hide() {
    if (this._el) this._el.style.display = 'none';
  }
};

/** 간단한 토스트 (api.js 자체 내장 — showToast가 없는 페이지 대비) */
function _apiToast(msg, type, duration) {
  // 기존 showToast가 있으면 우선 사용
  if (typeof showToast === 'function') {
    try { showToast(msg, type === 'error' ? true : type, duration); return; } catch(_) {}
  }
  const t = document.createElement('div');
  const bg = type === 'error' ? '#dc2626' : type === 'warning' ? '#f59e0b' : '#10b981';
  t.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);background:${bg};color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:500;z-index:999999;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:90vw;text-align:center;line-height:1.4;transition:opacity .3s`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, duration || 4000);
}

/** XHR 기반 POST — 업로드 진행률 지원 */
function _xhrPost(url, jsonBody, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    // JWT 인증 헤더
    const token = sessionStorage.getItem('admin_token');
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.timeout = timeoutMs;

    // 업로드 진행률
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) onProgress(e.loaded / e.total * 100);
      };
    }

    xhr.onload = function() {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch(_) { resolve({ error: '서버 응답 파싱 실패 (HTTP ' + xhr.status + ')' }); }
    };
    xhr.onerror = function() { reject(new Error('네트워크 오류 — 인터넷 연결을 확인하세요.')); };
    xhr.ontimeout = function() { reject(new Error('timeout')); };
    xhr.onabort = function() { reject(new Error('aborted')); };

    xhr.send(JSON.stringify(jsonBody));
  });
}

/** 이미지 업로드 전용 gasPost — 진행률 표시 + 재시도 안내 */
async function gasPostUpload(body, timeout) {
  const action = body.action || '';
  const route = _ACTION_MAP[action];
  if (!route) return { error: '알 수 없는 action: ' + action };

  const { action: _, ...payload } = body;
  if (route.remap) payload.action = route.remap;

  const url = API_BASE_URL + route.path;
  const timeoutMs = timeout || 120000; // 업로드용 기본 2분

  // 진행률 오버레이 표시
  const actionLabels = {
    uploadOrderImage: '주문 캡처 업로드 중...',
    uploadReviewImage: '리뷰 이미지 업로드 중...',
    extractOrderImage: 'AI 이미지 분석 중...',
  };
  _uploadProgress.show(actionLabels[action] || '업로드 중...');

  try {
    const json = await _xhrPost(url, payload, timeoutMs, (pct) => {
      _uploadProgress.update(pct);
    });
    _uploadProgress.hide();
    return json;
  } catch (err) {
    _uploadProgress.hide();
    const isTimeout = err.message === 'timeout';
    const isAborted = err.message === 'aborted';
    const isNetwork = err.message.includes('네트워크');

    if (isTimeout) {
      _apiToast('⏱ 업로드 시간 초과 — 네트워크 상태를 확인하고 다시 시도해주세요.\n이미지 크기가 크면 자동 압축 후 재시도됩니다.', 'error', 6000);
      return { error: '업로드 시간이 초과되었습니다. 이미지 크기를 줄이거나 네트워크를 확인하세요.' };
    }
    if (isAborted || isNetwork) {
      _apiToast('📡 업로드가 중단되었습니다 — 네트워크 연결을 확인하고 다시 시도해주세요.', 'error', 6000);
      return { error: '업로드가 중단되었습니다. 네트워크 연결을 확인하세요.' };
    }
    _apiToast('❌ 업로드 실패: ' + err.message, 'error', 5000);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// 하위 호환성 유틸
// ═══════════════════════════════════════════════════════════

/** GAS URL이 사용되던 곳에서 API_BASE_URL로 대체 */
function getApiBaseUrl() {
  return API_BASE_URL;
}

/** 세션 정리 (로그아웃) */
function clearAdminSession() {
  sessionStorage.removeItem('admin_token');
  sessionStorage.removeItem('rapp_admin_session');
  sessionStorage.removeItem('rapp_staff_session');
}

// ═══════════════════════════════════════════════════════════
// Phase 6: 프론트엔드 에러 자동 캡처 & 서버 전송
// window.onerror, unhandledrejection → POST /api/diag/client-error
// ═══════════════════════════════════════════════════════════
(function _initErrorCapture() {
  const _errQueue = [];
  let _sending = false;
  const _MAX_QUEUE = 20;
  const _THROTTLE_MS = 2000;   // 최소 2초 간격 전송
  let _lastSentAt = 0;
  const _sentHashes = new Set(); // 중복 방지용

  function _hashErr(msg, src, line) {
    return `${msg}|${src}|${line}`;
  }

  function _enqueue(entry) {
    const h = _hashErr(entry.message, entry.source, entry.lineno);
    if (_sentHashes.has(h)) return;
    _sentHashes.add(h);
    if (_sentHashes.size > 100) _sentHashes.clear(); // 메모리 보호

    _errQueue.push(entry);
    if (_errQueue.length > _MAX_QUEUE) _errQueue.shift();
    _flush();
  }

  async function _flush() {
    if (_sending || !_errQueue.length) return;
    const now = Date.now();
    if (now - _lastSentAt < _THROTTLE_MS) {
      setTimeout(_flush, _THROTTLE_MS - (now - _lastSentAt));
      return;
    }
    _sending = true;
    _lastSentAt = now;

    const batch = _errQueue.splice(0, 5); // 최대 5개씩
    for (const entry of batch) {
      try {
        await fetch(API_BASE_URL + '/api/diag/client-error', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry),
        });
      } catch (_) { /* 전송 실패 무시 — 에러 리포팅이 앱을 방해하면 안 됨 */ }
    }
    _sending = false;
    if (_errQueue.length) setTimeout(_flush, _THROTTLE_MS);
  }

  // ── window.onerror: 동기 JS 에러 ──
  const _prevOnError = window.onerror;
  window.onerror = function(message, source, lineno, colno, error) {
    _enqueue({
      message: String(message).substring(0, 500),
      source: String(source || '').substring(0, 200),
      lineno: lineno || 0,
      colno: colno || 0,
      stack: (error && error.stack) ? error.stack.substring(0, 800) : '',
      page: location.pathname,
      userAgent: navigator.userAgent.substring(0, 150),
      ts: new Date().toISOString(),
    });
    if (_prevOnError) return _prevOnError.apply(this, arguments);
    return false; // 기본 콘솔 출력 유지
  };

  // ── unhandledrejection: Promise 에러 ──
  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason;
    _enqueue({
      message: '[UnhandledRejection] ' + String(reason && reason.message || reason).substring(0, 500),
      source: '',
      lineno: 0,
      colno: 0,
      stack: (reason && reason.stack) ? reason.stack.substring(0, 800) : '',
      page: location.pathname,
      userAgent: navigator.userAgent.substring(0, 150),
      ts: new Date().toISOString(),
    });
  });
})();

// console에서 확인용
console.log('[api.js] 리뷰웹시스템 API 모듈 로드됨 — 서버:', API_BASE_URL);
