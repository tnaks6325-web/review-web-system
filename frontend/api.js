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
  'buildIndex':             { method: 'POST', path: '/api/index/build' },
  'buildIndexSmart':        { method: 'POST', path: '/api/index/build' },
  'buildIndexAsync':        { method: 'POST', path: '/api/index/build' },
  'buildIndexWithChecksum': { method: 'POST', path: '/api/index/build' },
  'indexStatus':            { method: 'GET',  path: '/api/index/status' },
  'getIndexMasterStatus':   { method: 'GET',  path: '/api/index/status' },

  // 탭 설정 (Section 6)
  'setTabConfig':     { method: 'POST', path: '/api/tab/config' },
  'getTabConfig':     { method: 'GET',  path: '/api/tab/config' },
  'listDetailSheet':  { method: 'GET',  path: '/api/tab/config' },
  'setForceDone':     { method: 'POST', path: '/api/tab/force-done' },
  'setClosed':        { method: 'POST', path: '/api/tab/closed' },
  'getTabOptions':    { method: 'GET',  path: '/api/tab/options' },
  'getTabEndDate':    { method: 'GET',  path: '/api/tab/end-date' },
  'getCampaignStats': { method: 'GET',  path: '/api/diag/campaign-stats' },

  // 리뷰어 관리 (Section 7)
  'registerReviewer':   { method: 'POST', path: '/api/reviewer/register' },
  'verifyReviewer':     { method: 'GET',  path: '/api/reviewer/verify' },
  'lookupPhone':        { method: 'GET',  path: '/api/reviewer/lookup' },
  'getReviewerList':    { method: 'GET',  path: '/api/reviewer/list' },
  'deleteReviewer':     { method: 'POST', path: '/api/reviewer/delete' },
  'getReviewerProfile': { method: 'POST', path: '/api/reviewer/profile' },
  'saveSubAccounts':    { method: 'POST', path: '/api/reviewer/profile' },
  'saveIncomeInfo':     { method: 'POST', path: '/api/reviewer/profile' },
  'getInaedList':       { method: 'GET',  path: '/api/diag/inaed-list' },

  // 관리자 인증 (Section 8)
  'adminLogin':         { method: 'POST', path: '/api/admin/login' },
  'adminLoginV2':       { method: 'POST', path: '/api/admin/login' },
  'adminChangePw':      { method: 'POST', path: '/api/admin/change-pw' },
  'changeMasterPw':     { method: 'POST', path: '/api/admin/change-master-pw' },
  'addAdminUser':       { method: 'POST', path: '/api/admin/users' },
  'editAdminUser':      { method: 'POST', path: '/api/admin/users' },
  'deleteAdminUser':    { method: 'POST', path: '/api/admin/users' },
  'listAdminUsers':     { method: 'POST', path: '/api/admin/users' },
  'dashboard':          { method: 'GET',  path: '/api/admin/dashboard' },
  'releaseBuildLock':   { method: 'POST', path: '/api/admin/release-lock' },
  
  // 영업담당자 (Staff)
  'staffLogin':         { method: 'POST', path: '/api/admin/staff-login' },
  'addStaffUser':       { method: 'POST', path: '/api/admin/staff-users' },
  'editStaffUser':      { method: 'POST', path: '/api/admin/staff-users' },
  'deleteStaffUser':    { method: 'POST', path: '/api/admin/staff-users' },
  'listStaffUsers':     { method: 'POST', path: '/api/admin/staff-users' },

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

  // 진단/기타
  'debugTabConfig':     { method: 'GET',  path: '/api/diag/debug-tab' },
  'debugSheet':         { method: 'GET',  path: '/api/diag/debug-sheet' },
  'debugBaseSheet':     { method: 'GET',  path: '/api/diag/debug-base' },
  'debugDetailSheet':   { method: 'GET',  path: '/api/diag/debug-tab' },
  'campaignList':       { method: 'GET',  path: '/api/diag/campaign-list' },
  'addCampaign':        { method: 'POST', path: '/api/diag/add-campaign' },
  'createBaseSheet':    { method: 'POST', path: '/api/diag/new-sheet' },

  // 뷰어
  'getViewerData':  { method: 'GET', path: '/api/viewer/viewer-data' },

  // 블랙리스트
  'blacklist':      { method: 'POST', path: '/api/blacklist' },

  // 이미지 (Gemini AI + Drive)
  'extractOrderImage':   { method: 'POST', path: '/api/image/image-extract' },
  'uploadOrderImage':    { method: 'POST', path: '/api/image/image-upload' },
  'verifyAddressMatch':  { method: 'POST', path: '/api/image/verify-address' },

  // 기타 GAS 전용 (호환성)
  'getAppUrl':      { method: 'GET',  path: '/api/diag/app-url' },
  'saveAppUrl':     { method: 'POST', path: '/api/diag/app-url' },
  'convertToNcHeaders': { method: 'POST', path: '/api/diag/convert-nc-headers' },
  'createCampaignSheet': { method: 'POST', path: '/api/diag/create-campaign-sheet' },

  // Phase 2-5: Sync Queue + Build History
  'syncQueueStats':     { method: 'GET',  path: '/api/diag/sync-queue' },
  'syncQueueRetry':     { method: 'POST', path: '/api/diag/sync-queue/retry' },
  'syncQueuePurge':     { method: 'POST', path: '/api/diag/sync-queue/purge' },
  'buildHistory':       { method: 'GET',  path: '/api/diag/build-history' },
};

// ═══════════════════════════════════════════════════════════
// JWT 토큰 관리
// ═══════════════════════════════════════════════════════════
function _getAuthHeaders() {
  const token = sessionStorage.getItem('admin_token');
  return token ? { 'Authorization': 'Bearer ' + token } : {};
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

  if (actualMethod === 'POST') {
    // ★ POST 매핑된 action은 body로 전송 (buildIndex, buildIndexSmart 등)
    url = API_BASE_URL + route.path;
    fetchOpts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
      body: JSON.stringify(queryParams),
    };
  } else {
    // GET 매핑은 쿼리스트링으로
    const qs = new URLSearchParams();
    Object.entries(queryParams).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    });
    url = API_BASE_URL + route.path + (qs.toString() ? '?' + qs.toString() : '');
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
async function gasPost(body) {
  const action = body.action || '';
  const route = _ACTION_MAP[action];

  if (!route) {
    console.warn('[gasPost] 매핑 없는 action:', action);
    return { error: '알 수 없는 action: ' + action };
  }

  // action 필드 제거 (서버에서는 라우트로 구분)
  const { action: _, ...payload } = body;

  const url = API_BASE_URL + route.path;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

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
      return { error: '요청 시간이 초과되었습니다.' };
    }
    console.error('[gasPost] 오류:', action, err.message);
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

// console에서 확인용
console.log('[api.js] 리뷰웹시스템 API 모듈 로드됨 — 서버:', API_BASE_URL);
