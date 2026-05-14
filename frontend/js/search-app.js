/* ══════════════════════════════════════════
   app.js v4 [인라인]
══════════════════════════════════════════ */

/* ── 숨김/표시 헬퍼 ── */
function hide(idOrEl) {
  const el = typeof idOrEl === "string" ? document.getElementById(idOrEl) : idOrEl;
  if (!el) return;
  el.classList.add("hidden");
  el.style.display = "none";
}
function show(idOrEl, displayType) {
  const el = typeof idOrEl === "string" ? document.getElementById(idOrEl) : idOrEl;
  if (!el) return;
  el.classList.remove("hidden");
  el.style.display = displayType || "";
}

/* ── 전역 상태 ── */
// ★ 다건 리뷰 제출 상태
// selectedRows: item 배열 (1건이면 길이 1)
// filesByIdx:   { [idx]: File[] }  — 슬롯별 파일 목록
// memoByIdx:    { [idx]: string }  — 슬롯별 메모 (기존 단건 memoTxt와 별도)
const S = { selectedRow: null, selectedRows: [], filesByIdx: {}, memoByIdx: {}, files: [], step: 1 };
const ADMIN_SESSION_KEY  = "rapp_admin_exp";
const ADMIN_SESSION_MS   = 8 * 60 * 60 * 1000;
const REVIEWER_AUTH_KEY  = "rapp_reviewer_auth";  // ★ 리뷰어 로그인 세션 키
const REVIEWER_AUTH_MS   = 12 * 60 * 60 * 1000;  // ★ 12시간 유지

/* ══════════════════════════════════════════════════════
   ★ 리뷰어 회원 인증 상태 관리
   ══════════════════════════════════════════════════════ */

// 현재 인증 상태: { name, verified(bool), registeredMember(bool), expAt }
let _authState = null;

/** 세션 복원 */
function _loadAuthSession() {
  try {
    const raw = localStorage.getItem(REVIEWER_AUTH_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || Date.now() > obj.expAt) {
      localStorage.removeItem(REVIEWER_AUTH_KEY);
      return null;
    }
    return obj;
  } catch(_) { return null; }
}

/** 세션 저장 (phone8 포함 → 동명이인 구분) */
function _saveAuthSession(name, verified, registeredMember, phone8) {
  const obj = {
    name,
    verified,
    registeredMember,
    phone8: (phone8 || "").replace(/[^0-9]/g, ""), // 뒤 8자리 숫자만
    expAt: Date.now() + REVIEWER_AUTH_MS
  };
  localStorage.setItem(REVIEWER_AUTH_KEY, JSON.stringify(obj));
  _authState = obj;
}

/* ══════════════════════════════════════════════════════════════
   ★ 관리자 바이패스 모드
   ────────────────────────────────────────────────────────────
   - index.html 관리자 로그인 세션(sessionStorage)이 유효하면
     리뷰어 등록/로그인 없이 이름 검색만으로 조회 가능
   - phone8 필터 없이 이름 매칭 전체 결과 반환
   ══════════════════════════════════════════════════════════════ */

const ADMIN_BYPASS_KEY  = "rapp_admin_exp";   // index.html 과 동일한 키
const ADMIN_BYPASS_NAME = "rapp_admin_name";

/** 현재 세션에 유효한 관리자 로그인이 있는지 확인 */
function _isAdminSession() {
  try {
    const exp = Number(sessionStorage.getItem(ADMIN_BYPASS_KEY) || 0);
    return exp > Date.now();
  } catch(_) { return false; }
}

/** 관리자 이름 가져오기 */
function _getAdminSessionName() {
  try {
    return sessionStorage.getItem(ADMIN_BYPASS_NAME) || "관리자";
  } catch(_) { return "관리자"; }
}

/** 페이지 초기화 시 관리자 세션 감지 → 바이패스 화면 표시 */
function _checkAdminBypass() {
  if (!_isAdminSession()) return false;

  // 관리자 세션 유효 → authScreen 대신 adminBypassScreen 표시
  const authScreen    = document.getElementById("authScreen");
  const bypassScreen  = document.getElementById("adminBypassScreen");
  const bypassNameEl  = document.getElementById("adminBypassName");

  if (authScreen)   authScreen.style.display   = "none";
  if (bypassScreen) bypassScreen.style.display  = "";
  if (bypassNameEl) bypassNameEl.textContent    = _getAdminSessionName();

  return true;
}

/** 관리자 이름 검색 (phone8 필터 없이 전체 매칭) */
async function _doAdminSearch() {
  if (!_isAdminSession()) {
    // 세션 만료 → 일반 로그인 화면으로 전환
    const bypassScreen = document.getElementById("adminBypassScreen");
    const authScreen   = document.getElementById("authScreen");
    if (bypassScreen) bypassScreen.style.display = "none";
    if (authScreen)   authScreen.style.display   = "";
    showToast("관리자 세션이 만료됐습니다. 다시 로그인하세요.", "warning");
    return;
  }

  const q = (document.getElementById("adminSearchInput").value || "").trim();
  if (!q || q.length < 2) {
    showToast("이름을 2글자 이상 입력하세요.", "warning");
    document.getElementById("adminSearchInput").focus();
    return;
  }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("GAS URL이 설정되지 않았습니다.", "error");
    return;
  }

  const btn = document.getElementById("btnAdminSearch");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';

  // loggedInArea 표시 (결과 영역)
  const loggedInArea = document.getElementById("loggedInArea");
  if (loggedInArea) loggedInArea.style.display = "";

  // nameInput(레거시)에 이름 세팅 → doSearch() 가 읽어감
  const nameEl = document.getElementById("nameInput");
  if (nameEl) nameEl.value = q;

  // phone8 없이 검색 (관리자는 동명이인 구분 없이 전체 조회)
  hide("resultsSection");
  hide("noResultView");

  const qKey   = "__admin__" + q.toLowerCase();
  const cached = _getCachedSearch(qKey);
  if (cached) {
    cached.length === 0 ? _showNoResult(false) : renderResults(cached);
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-search"></i> 조회';
    return;
  }

  startProgress();
  try {
    // phone8 파라미터 없이 호출 → 동명이인 전체 결과
    const data    = await gasGet({ action: "searchAll", query: q });
    stopProgress();
    const results = data.results || [];
    _setCachedSearch(qKey, results);
    results.length === 0 ? _showNoResult(false) : renderResults(results);
  } catch(err) {
    stopProgress();
    showToast("검색 오류: " + (err.message || "").substring(0, 80), "error");
  } finally {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-search"></i> 조회';
  }
}

/** 로그아웃 */
function _logout() {
  localStorage.removeItem(REVIEWER_AUTH_KEY);
  _authState = null;

  // ── 결과 영역 숨기기 ──
  hide("resultsSection");
  hide("noResultView");
  _clearSearchCache();

  // ── 로그인 완료 영역 숨기고 인증 화면 복원 ──
  const loggedInArea = document.getElementById("loggedInArea");
  const authScreen   = document.getElementById("authScreen");
  if (loggedInArea) loggedInArea.style.display = "none";
  if (authScreen)   authScreen.style.display   = "";

  // 로그인 탭으로 초기화
  _switchAuthTab("login");

  // 입력값 초기화
  const ni = document.getElementById("nameInput");
  if (ni) ni.value = "";
  const lp = document.getElementById("loginPhoneInput");
  if (lp) lp.value = "";

  // 레거시 DOM 안전 처리
  const phoneWrap = document.getElementById("phoneAuthWrap");
  if (phoneWrap) phoneWrap.style.display = "none";
  const phoneErr  = document.getElementById("phoneAuthErr");
  if (phoneErr)  phoneErr.classList.remove("show");
  const card = document.getElementById("searchCard");
  if (card) card.style.display = "none";
  const inviteCard = document.getElementById("regInviteCard");
  if (inviteCard) inviteCard.style.display = "";
}

/** 페이지 로드 시 세션 복원 → 자동 로그인 */
async function _restoreReviewerSession() {
  const session = _loadAuthSession();
  if (!session) return; // 세션 없음 → authScreen 표시 유지

  _authState = session;

  // nameInput(레거시)에 이름 채우기
  const nameEl = document.getElementById("nameInput");
  if (nameEl) nameEl.value = session.name;

  _applyLoginUI(session.name);

  // 바로 결과 조회
  try {
    await doSearch();
  } catch(e) {
    console.warn("[restoreSession] 자동 검색 실패:", e.message);
  }
}

/** 로그인 상태 UI 적용 */
function _applyLoginUI(name) {
  // ── 인증 화면 숨기고 로그인 완료 영역 표시 ──
  const authScreen   = document.getElementById("authScreen");
  const loggedInArea = document.getElementById("loggedInArea");
  if (authScreen)   authScreen.style.display   = "none";
  if (loggedInArea) loggedInArea.style.display  = "";

  // 이름 표시
  const nameEl = document.getElementById("loginStateName");
  if (nameEl) nameEl.textContent = name;

  // 레거시 DOM 호환
  const bar = document.getElementById("loginStateBar");
  if (bar) bar.style.display = "flex";
  const card = document.getElementById("searchCard");
  if (card) card.style.display = "none";
  const inviteCard = document.getElementById("regInviteCard");
  if (inviteCard) inviteCard.style.display = "none";
}

/* ── STEP1: 이름 입력 변경 감지 (레거시 호환) ── */
function _onNameInput() { /* authScreen 기반 실시간 유효성 검사 없음 */ }

/* ── 레거시 no-op (authScreen 기반으로 대체됨) ── */
async function _onNameNext()       { /* 미사용: _doLogin() 으로 대체 */ }
async function _onPhoneAuthSubmit(){ /* 미사용: _doLogin() 으로 대체 */ }

/* ── 미등록 차단 블록에서 등록 모달 열기 ── */
function _openRegisterFromBlock() {
  const nrWrap = document.getElementById("notRegisteredWrap");
  if (nrWrap) nrWrap.style.display = "none";
  openRegisterModal();
}

/* ══════════════════════════════════════════════════════════════
   ★★★ 통합 로그인/등록 화면 JS (authScreen 기반) ★★★
   ────────────────────────────────────────────────────────────
   - _switchAuthTab(tab)  : 로그인 ↔ 등록 탭 전환
   - _doLogin()           : 이름 + 전화번호 뒤 8자리로 로그인
   - _doRegister()        : 이름 + 전화번호로 신규 등록 → 자동 로그인
   - _clearLoginErr()     : 로그인 오류 메시지 지우기
   - _clearRegErr()       : 등록 오류 메시지 지우기
   ══════════════════════════════════════════════════════════════ */

/** 로그인 / 등록 탭 전환 */
function _switchAuthTab(tab) {
  const loginPanel    = document.getElementById("loginPanel");
  const registerPanel = document.getElementById("registerPanel");
  const tabLogin      = document.getElementById("tabBtnLogin");
  const tabReg        = document.getElementById("tabBtnRegister");
  if (!loginPanel || !registerPanel) return;

  if (tab === "login") {
    loginPanel.style.display    = "";
    registerPanel.style.display = "none";
    tabLogin.classList.add("active");
    tabReg.classList.remove("active");
    setTimeout(() => {
      const lp = document.getElementById("loginPhoneInput");
      if (lp) lp.focus();
    }, 100);
  } else {
    loginPanel.style.display    = "none";
    registerPanel.style.display = "";
    tabLogin.classList.remove("active");
    tabReg.classList.add("active");
    document.getElementById("regNameInline").focus();
  }
  // 오류 메시지 초기화
  _clearLoginErr();
  _clearRegErr();
}

/** 로그인 오류 숨기기 */
function _clearLoginErr() {
  const el = document.getElementById("loginErr");
  if (el) el.style.display = "none";
  _hideLoginBlocked();
}

/** 등록 오류 숨기기 */
function _clearRegErr() {
  const el = document.getElementById("regErrInline");
  if (el) el.style.display = "none";
}

/** 로그인 오류 표시 */
function _showLoginErr(msg) {
  const el    = document.getElementById("loginErr");
  const msgEl = document.getElementById("loginErrMsg");
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.style.display  = "flex";
}

/** 등록 오류 표시 */
function _showRegErr(msg) {
  const el    = document.getElementById("regErrInline");
  const msgEl = document.getElementById("regErrInlineMsg");
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.style.display  = "flex";
}

/* ── 로그인: phone8 입력 → 이름 조회 → 확인 → 로그인 ── */

// 조회된 이름을 임시 저장
let _lookedUpName = null;

/** phone8 입력 후 "이름 조회하기" 버튼 클릭 핸들러 */
async function _doLookupPhone() {
  const phone8 = (document.getElementById("loginPhoneInput").value || "").replace(/[^0-9]/g, "");
  if (phone8.length !== 8) {
    _showLoginErr("전화번호 뒤 8자리를 정확히 입력하세요.");
    document.getElementById("loginPhoneInput").focus();
    return;
  }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    _showLoginErr("GAS URL이 설정되지 않았습니다.");
    return;
  }

  const btn = document.getElementById("btnLoginLookup");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 조회 중...';
  _clearLoginErr();
  _hideLoginBlocked();

  try {
    const data = await gasGet({ action: "lookupPhone", phone8 });

    if (!data.ok) {
      _showLoginErr("등록된 전화번호가 없습니다. 등록 탭에서 먼저 등록해주세요.");
      setTimeout(() => _switchAuthTab("register"), 900);
      return;
    }

    // 상태 정지 체크
    if (data.status === "정지" || data.status === "탈퇴") {
      _showLoginBlocked(
        data.status === "탈퇴"
          ? "탈퇴된 계정입니다. 재가입이 필요한 경우 관리자에게 문의해주세요."
          : "이 계정은 현재 이용이 제한되었습니다. 관리자에게 문의해주세요."
      );
      return;
    }

    // 이름 표시
    _lookedUpName = data.name;
    document.getElementById("phoneLookupName").textContent = data.name;
    document.getElementById("phoneLookupResult").classList.add("show");
    // 레거시 nameInput 채우기
    const ni = document.getElementById("nameInput");
    if (ni) ni.value = data.name;

  } catch (e) {
    _showLoginErr("오류: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-search"></i> 이름 조회하기';
  }
}

/** "맞아요, 로그인" 버튼 클릭 핸들러 */
async function _doLoginWithLookup() {
  if (!_lookedUpName) return;
  const phone8 = (document.getElementById("loginPhoneInput").value || "").replace(/[^0-9]/g, "");
  const name   = _lookedUpName;

  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    _showLoginErr("GAS URL이 설정되지 않았습니다.");
    return;
  }

  const confirmBtn = document.querySelector(".plb-confirm");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 로그인 중...';
  }

  try {
    const data = await gasGet({ action: "verifyReviewer", name, phone8 });

    if (data.status === "정지" || data.status === "탈퇴") {
      _showLoginBlocked(
        data.status === "탈퇴"
          ? "탈퇴된 계정입니다. 재가입이 필요한 경우 관리자에게 문의해주세요."
          : "이 계정은 현재 이용이 제한되었습니다. 관리자에게 문의해주세요."
      );
      document.getElementById("phoneLookupResult").classList.remove("show");
      return;
    }

    if (!data.ok) {
      _showLoginErr(data.error || "인증에 실패했습니다. 다시 시도해주세요.");
      _resetLoginLookup();
      return;
    }

    // 성공
    _saveAuthSession(name, true, true, data.phone8 || phone8);
    _applyLoginUI(name);
    const ni = document.getElementById("nameInput");
    if (ni) ni.value = name;

    // ★ Phase 5: 구매양식 대기 중이면 폼으로 복귀
    if (window._pendingOrderForm) {
      window._pendingOrderForm = false;
      window._slotAuth = { name, phone8: data.phone8 || phone8 };
      initOrderFormMode();
      return;
    }

    await doSearch();

  } catch (e) {
    _showLoginErr("오류: " + e.message);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fas fa-check-circle"></i> 맞아요, 로그인';
    }
  }
}

/** 기존 _doLogin() 호환 래퍼 (세션 복원 등 내부 호출용) */
async function _doLogin() {
  const name   = (document.getElementById("nameInput").value || "").trim();
  const phone8 = (document.getElementById("loginPhoneInput").value || "").replace(/[^0-9]/g, "");
  if (!name || !phone8 || phone8.length !== 8) {
    // 이름 없으면 phone8 단독 조회 시도
    if (phone8.length === 8) return _doLookupPhone();
    _showLoginErr("전화번호 뒤 8자리를 입력하세요.");
    return;
  }
  // 이름이 있으면 바로 검증
  if (!APP_CONFIG.GAS_WEB_APP_URL) { _showLoginErr("GAS URL이 설정되지 않았습니다."); return; }
  try {
    const data = await gasGet({ action: "verifyReviewer", name, phone8 });
    if (data.status === "정지" || data.status === "탈퇴") {
      _showLoginBlocked("이 계정은 이용이 제한되었습니다."); return;
    }
    if (!data.ok) {
      _showLoginErr(data.error || "인증에 실패했습니다. 다시 시도해주세요."); return;
    }
    _saveAuthSession(name, true, true, data.phone8 || phone8);
    _applyLoginUI(name);

    // ★ Phase 5: 구매양식 대기 중이면 폼으로 복귀
    if (window._pendingOrderForm) {
      window._pendingOrderForm = false;
      window._slotAuth = { name, phone8: data.phone8 || phone8 };
      initOrderFormMode();
      return;
    }

    await doSearch();
  } catch(e) { _showLoginErr("오류: " + e.message); }
}

/** 조회 결과 패널 초기화 */
function _resetLoginLookup() {
  _lookedUpName = null;
  document.getElementById("phoneLookupResult").classList.remove("show");
  _hideLoginBlocked();
}

/** 정지 안내 표시 */
function _showLoginBlocked(msg) {
  const el = document.getElementById("loginBlockedNotice");
  const msgEl = document.getElementById("loginBlockedMsg");
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.classList.add("show");
}
function _hideLoginBlocked() {
  const el = document.getElementById("loginBlockedNotice");
  if (el) el.classList.remove("show");
}

/* ── 등록: 이름 + 전화번호 4자리×2 ── */
/* ── 등록 확인 모달 제어 ── */
let _pendingRegData = null; // 확인 대기 중인 등록 데이터

function _showRegConfirm(name, phone) {
  // 정보 채우기
  document.getElementById("rcName").textContent  = name;
  document.getElementById("rcPhone").textContent = phone;
  // 모달 표시
  document.getElementById("regConfirmOverlay").classList.add("show");
  // 포커스 트랩
  setTimeout(() => {
    const btn = document.getElementById("rcBtnConfirm");
    if (btn) btn.focus();
  }, 100);
}

function _hideRegConfirm() {
  document.getElementById("regConfirmOverlay").classList.remove("show");
}

// "맞아요, 등록 진행" 클릭 → 실제 서버 전송
async function _confirmRegister() {
  if (!_pendingRegData) return;
  _hideRegConfirm();
  const { name, phone, p1, p2 } = _pendingRegData;
  _pendingRegData = null;
  await _submitRegister(name, phone, p1, p2);
}

// "아니요, 처음부터 다시 입력" 클릭 → 폼 초기화 후 모달 닫기
function _cancelRegister() {
  _pendingRegData = null;
  _hideRegConfirm();
  // 폼 초기화
  document.getElementById("regNameInline").value    = "";
  document.getElementById("regPhone1Inline").value  = "";
  document.getElementById("regPhone2Inline").value  = "";
  document.getElementById("regConsentInline").checked = false;
  _clearRegErr();
  // 이름 입력 필드에 포커스
  setTimeout(() => document.getElementById("regNameInline").focus(), 150);
}

// ESC 키로 모달 닫기 (→ 다시 입력과 동일)
// 오버레이 배경 클릭 → 다시 입력
// ※ DOMContentLoaded 이후 바인딩 (하단 초기화 블록에서 호출)
function _bindRegConfirmEvents() {
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && document.getElementById("regConfirmOverlay").classList.contains("show")) {
      _cancelRegister();
    }
  });
  const overlay = document.getElementById("regConfirmOverlay");
  if (overlay) {
    overlay.addEventListener("click", function(e) {
      if (e.target === this) _cancelRegister();
    });
  }
}

async function _doRegister() {
  const name   = (document.getElementById("regNameInline").value || "").trim();
  const p1     = (document.getElementById("regPhone1Inline").value || "").replace(/[^0-9]/g, "");
  const p2     = (document.getElementById("regPhone2Inline").value || "").replace(/[^0-9]/g, "");
  const agree  = document.getElementById("regConsentInline").checked;

  if (!name || name.length < 2) {
    _showRegErr("이름을 2글자 이상 입력하세요.");
    document.getElementById("regNameInline").focus();
    return;
  }
  if (p1.length !== 4 || p2.length !== 4) {
    _showRegErr("전화번호를 정확히 입력하세요. (각 4자리)");
    document.getElementById(p1.length < 4 ? "regPhone1Inline" : "regPhone2Inline").focus();
    return;
  }
  if (!agree) {
    _showRegErr("개인정보 수집·이용에 동의해주세요.");
    return;
  }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    _showRegErr("GAS URL이 설정되지 않았습니다.");
    return;
  }

  // ── 검증 통과 → 확인 모달 표시 ──
  const phone = "010" + p1 + p2;
  const phoneFmt = "010-" + p1 + "-" + p2;
  _pendingRegData = { name, phone, p1, p2 };
  _showRegConfirm(name, phoneFmt);
}

// 실제 서버 전송 (확인 버튼 클릭 후 호출)
async function _submitRegister(name, phone, p1, p2) {
  const btn = document.getElementById("btnRegisterInline");
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 등록 중...';
  _clearRegErr();

  try {
    let data;
    try {
      data = await gasPost({ action: "registerReviewer", name, phone, consent: "true" });
    } catch (_) {
      data = await gasGet({ action: "registerReviewer", name, phone, consent: "true" });
    }

    if (data && data.ok) {
      const regPhone8 = (p1 + p2).slice(-8);
      showToast("등록 완료! 자동 로그인합니다.", "success");
      _saveAuthSession(name, true, true, regPhone8);
      _applyLoginUI(name);

      // ★ v9.14: authScreen 등록 시 소득정보 입력 시 백그라운드 저장
      const regIncomeNameInl = (document.getElementById("regIncomeNameInline")?.value || "").trim();
      const regJuminInl = (document.getElementById("regJuminNoInline")?.value || "").replace(/[^0-9]/g, "");
      if (regIncomeNameInl || regJuminInl) {
        const incP = { action:"saveIncomeInfo", phone8:regPhone8, incomeName:regIncomeNameInl, jumin:regJuminInl };
        gasPost(incP).catch(() => gasGet(incP))
          .then(r => { if(r?.ok) console.log("[등록] 소득정보(authScreen) 저장 완료"); })
          .catch(e => console.warn("[등록] 소득정보 저장 실패:", e.message));
      }

      const ni = document.getElementById("nameInput");
      if (ni) ni.value = name;

      await doSearch();
    } else if (data && data.isDuplicate) {
      // 중복 전화번호 → 로그인 탭으로 자동 전환 + 전화번호 pre-fill
      _showRegErr("이미 등록된 전화번호입니다. 로그인 탭에서 조회해주세요.");
      setTimeout(() => {
        _switchAuthTab("login");
        // 전화번호 8자리 pre-fill
        const loginPhoneEl = document.getElementById("loginPhoneInput");
        if (loginPhoneEl) {
          loginPhoneEl.value = p1 + p2;
          // 자동으로 이름 조회 시작
          setTimeout(() => _doLookupPhone(), 300);
        }
      }, 900);
    } else {
      _showRegErr((data && data.message) || "등록 중 오류가 발생했습니다.");
    }
  } catch (e) {
    _showRegErr("오류: " + e.message);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-user-plus"></i> 리뷰어 등록하기';
  }
}

/* ── GAS 워밍업 핑 ──────────────────────────────────────────
   페이지 로드 직후 GAS 인스턴스를 미리 깨워 콜드스타트 제거.
   fire-and-forget: 응답을 기다리지 않고 병렬 실행.
   action=indexStatus → doGet에 등록된 부작용 없는 경량 액션 사용.
   ──────────────────────────────────────────────────────────── */
function _warmUpGas() {
  // ★ [Node.js 이관] GAS 워밍업 대신 API 서버 헬스체크로 대체
  if (typeof API_BASE_URL === 'undefined' || !API_BASE_URL) return;
  fetch(API_BASE_URL + '/health', { method: 'GET', mode: 'cors' })
    .catch(() => {}); // 실패해도 무시
}

/* ── 초기화 ── */
document.addEventListener("DOMContentLoaded", () => {
  _warmUpGas(); // ★ 콜드스타트 방지: 가장 먼저 실행
  _bindRegConfirmEvents(); // 등록 확인 모달 이벤트 바인딩
  hideLoading();
  bindEnter();
  bindDragDrop();
  // ★ mode=form / s= 파라미터 감지 → 구매양식 전용 화면 진입
  if (initOrderFormMode()) return; // 구매양식 모드이면 이후 일반 초기화 스킵
  // 일반 모드: 검색 화면 활성화
  showScreen("screenSearch");
  // ★ GAS URL 자동 부트스트랩
  // BOOTSTRAP_GAS_URL이 없으면 localStorage → GAS PropertiesService 순서로 조회
  bootstrapGasUrl();

  // ★ Phase 1-2: 공지 배너 로드 (비동기, 실패 무시)
  _loadNoticeBanner();

  // ★ 관리자 세션 감지 → 바이패스 모드 (먼저 체크)
  const isAdminMode = _checkAdminBypass();

  // ★ 리뷰어 로그인 세션 복원 (관리자 모드가 아닐 때만)
  if (!isAdminMode) _restoreReviewerSession();

  // ── 창 크기 변경 시 sticky 위치 재보정 ──
  window.addEventListener("resize", () => _fixStickyPositions());
});

/**
 * GAS URL 자동 로드 순서:
 * 1. BOOTSTRAP_GAS_URL 하드코딩값 → 있으면 즉시 사용
 * 2. localStorage 저장값 → 있으면 그 URL로 GAS getAppUrl 호출해서 최신값 확인
 * 3. 둘 다 없으면 gasNotSet 배너 표시
 */
async function bootstrapGasUrl() {
  // ★ [Node.js 이관] GAS URL 부트스트랩 → API_BASE_URL 헬스체크로 대체
  if (APP_CONFIG.GAS_WEB_APP_URL) {
    hide("gasNotSet");
    // 백그라운드로 API 서버 상태 확인 (GAS getAppUrl 대신)
    try {
      const res = await fetch((typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : APP_CONFIG.GAS_WEB_APP_URL) + '/health');
      if (res.ok) {
        const json = await res.json();
        console.log("[bootstrap] API 서버 상태:", json.ok ? "정상" : "오류");
      }
    } catch (_) { /* 서버 연결 실패는 무시 */ }
    return;
  }
  // 2) URL이 전혀 없는 경우 → gasNotSet 배너 표시
  show("gasNotSet");
}

function bindEnter() {
  const el = document.getElementById("nameInput");
  if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
}

/* ── 스크린 전환 ── */
// 화면별 타이틀 정의
const SCREEN_TITLES = {
  screenSearch:       "참여한 캠페인 조회",
  screenSubmit:       "리뷰제출",
  screenOrderForm:    "구매양식"
};
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.style.display = "none";
  });
  const target = document.getElementById(id);
  if (!target) return;
  target.classList.add("active");
  target.style.display = "flex";
  window.scrollTo({ top: 0, behavior: "instant" });

  // ── 화면별 타이틀 동적 변경 ──
  // ★ 구매양식 단축링크 진입 시(_pendingOrderForm) screenSearch 타이틀 덮어쓰기 방지
  if (id === "screenSearch" && window._pendingOrderForm) return;
  const title = SCREEN_TITLES[id];
  if (title) {
    document.title = title;
    // 각 화면 헤더 h1 업데이트
    const el = {
      screenSearch:    document.getElementById("searchTitle"),
      screenSubmit:    document.getElementById("submitTitle"),
      screenOrderForm: document.getElementById("orderFormTitle"),
    }[id];
    if (el) el.textContent = title;
  }
}

function backToSearch() {
  S.selectedRow  = null;
  S.selectedRows = [];
  S.files        = [];
  S.filesByIdx   = {};
  S.memoByIdx    = {};
  renderPreviews();
  const memoEl = document.getElementById("memoTxt");
  if (memoEl) memoEl.value = "";
  // 다건 슬롯 제거
  const slotsWrap = document.getElementById("mrSlotsWrap");
  if (slotsWrap) slotsWrap.remove();
  const singleDrop = document.getElementById("dropZone");
  const singleMemo = document.querySelector(".memo-wrap");
  if (singleDrop) singleDrop.style.display = "";
  if (singleMemo) singleMemo.style.display = "";
  const pw = document.getElementById("mrProgressWrap");
  if (pw) pw.classList.remove("show");
  showScreen("screenSearch");
}

/* ── 검색 결과 클라이언트 캐시 ───────────────────────────────
   동일 검색어의 재요청을 GAS 호출 없이 즉시 반환.
   TTL: 5분 (페이지 이탈 시 자연 소멸).
   캐시 무효화: 리뷰 제출 성공 시 해당 검색어 캐시 삭제.
   ─────────────────────────────────────────────────────────── */
const _SEARCH_CACHE     = new Map(); // key: 검색어(소문자trim), value: { results, ts }
const _SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5분

/** 캐시 저장 */
function _setCachedSearch(q, results) {
  _SEARCH_CACHE.set(q, { results, ts: Date.now() });
}
/** 캐시 조회 — 유효하면 results 배열 반환, 만료/없으면 null */
function _getCachedSearch(q) {
  const hit = _SEARCH_CACHE.get(q);
  if (!hit) return null;
  if (Date.now() - hit.ts > _SEARCH_CACHE_TTL) { _SEARCH_CACHE.delete(q); return null; }
  return hit.results;
}
/** 캐시 전체 초기화 (리뷰 제출 등 데이터 변경 시 호출) */
function _clearSearchCache() {
  _SEARCH_CACHE.clear();
}

/* ── 검색 ── */
async function doSearch() {
  const q     = document.getElementById("nameInput").value.trim();
  const phone8 = (_authState && _authState.phone8) ? _authState.phone8 : "";

  // ★ phone8이 있으면 이름 없이도 검색 가능 (인애드명 ≠ 수취인명 케이스)
  // 예) '황보미'로 등록했지만 수취인이 '강민석'인 경우 → phone8만으로 조회
  if (!phone8 && (!q || q.length < 2)) {
    showToast("이름을 2글자 이상 입력하세요.", "warning"); return;
  }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("GAS URL을 먼저 설정해주세요.", "error"); return;
  }
  hide("resultsSection");
  hide("noResultView");
  hide("gasNotSet");

  // ★ Phase 1-2: 블랙리스트 체크 (이름이 있는 경우에만)
  const blBanner = document.getElementById("blacklistBanner");
  if (blBanner) blBanner.style.display = "none";
  if (q.length >= 2) {
    try {
      const blData = await gasGet({ action:"blacklist", action2:"check", name: q });
      if (blData && blData.isBlacklisted) {
        const reasonEl = document.getElementById("blacklistBannerReason");
        let reasonTxt = "관리자에게 문의하세요.";
        if (blData.reason) reasonTxt = "사유: " + blData.reason;
        if (blData.date)   reasonTxt += " (" + blData.date + ")";
        if (reasonEl) reasonEl.textContent = reasonTxt;
        if (blBanner) blBanner.style.display = "block";
        return; // 블랙리스트면 검색 차단
      }
    } catch(_) { /* 블랙리스트 체크 실패해도 검색은 계속 */ }
  }

  // ★ 캐시 HIT: phone8도 함께 일치 확인
  const qKey   = (q || "__phone__").toLowerCase() + (phone8 ? "|"+phone8 : "");
  const cached = _getCachedSearch(qKey);
  if (cached) {
    if (cached.length === 0) { _showNoResult(false); } else { renderResults(cached); }
    return;
  }

  startProgress();
  try {
    // ★ phone8을 함께 전달 → 동명이인 구분 + 인애드명≠수취인명 fallback
    const searchParams = { action: "searchAll", query: q };
    if (phone8) searchParams.phone8 = phone8;
    const data    = await gasGet(searchParams);
    stopProgress();
    const results    = data.results || [];
    const wasExpired = !!data.wasExpired; // ★ 인덱스 만료 후 재빌드 여부

    // ★ wasExpired 시 캐시 저장 안 함 (재빌드 직후라 재검색 유도)
    if (!wasExpired) _setCachedSearch(qKey, results);

    if (results.length === 0) {
      _showNoResult(wasExpired); // ★ 상황별 안내 분기
    } else {
      renderResults(results);
    }
  } catch (err) {
    stopProgress();
    const emsg = err.message || "";
    if (emsg === "요청 시간 초과" || emsg.includes("timeout") || emsg.includes("Timeout")) {
      // ★ 타임아웃 → 서버 응답 지연 (동기화 중일 수 있음) → 짧은 자동 재시도
      _showTimeoutRetry();
      showToast("⏱ 서버 응답이 느립니다. 자동으로 다시 검색합니다.", "warning", 4000);
    } else if (emsg.includes("fetch") || emsg.includes("Failed to fetch") || emsg.includes("NetworkError")) {
      showToast("❌ 네트워크 오류 — GAS URL을 확인하거나 잠시 후 재시도하세요.", "error");
    } else {
      showToast("❌ 검색 오류: " + emsg.substring(0, 100), "error");
    }
    if (!APP_CONFIG.GAS_WEB_APP_URL) show("gasNotSet");
  }
}

/* ── 인덱스 만료 안내 & 자동 재시도 ── */
let _autoRetryTimer = null;
let _autoRetryCount = 0;

/** ★ 타임아웃 시 전용 재시도 UI (인덱스 갱신 안내가 아닌 짧은 재시도) */
function _showTimeoutRetry() {
  const msgEl  = document.getElementById("noResultMsg");
  const subEl  = document.getElementById("noResultSub");
  const notice = document.getElementById("indexRebuildNotice");
  const retry  = document.getElementById("autoRetryNotice");

  cancelAutoRetry();

  if (msgEl) msgEl.textContent  = "서버 응답 대기 중...";
  if (subEl) subEl.textContent  = "서버가 잠시 바쁩니다. 곧 자동으로 다시 검색합니다.";
  if (notice) notice.style.display = "none"; // 인덱스 갱신 안내는 숨김
  if (retry)  retry.style.display  = "";
  show("noResultView");
  _startAutoRetry(5); // 5초 후 자동 재시도 (기존 20초→5초로 단축)
}

function _showNoResult(wasExpired) {
  // 기본 메시지 초기화
  const msgEl  = document.getElementById("noResultMsg");
  const subEl  = document.getElementById("noResultSub");
  const notice = document.getElementById("indexRebuildNotice");
  const retry  = document.getElementById("autoRetryNotice");

  // 이전 타이머 취소
  cancelAutoRetry();

  if (wasExpired) {
    // 인덱스 재빌드 후 결과 없음 → 안내 + 자동 재시도
    if (msgEl) msgEl.textContent  = "인덱스를 새로 갱신했습니다";
    if (subEl) subEl.textContent  = "인덱스를 새로 만들었습니다. 잠시 후 자동으로 재검색됩니다.";
    if (notice) notice.style.display = "";
    if (retry)  retry.style.display  = "";
    _startAutoRetry(20); // 20초 카운트다운 후 자동 재시도
    showToast("🔄 동기화 완료. 20초 후 자동으로 다시 검색합니다.", "warning", 5000);
  } else {
    // 정상 인덱스, 진짜 결과 없음
    if (msgEl) msgEl.textContent  = "아직 참여 내역이 없습니다";
    if (subEl) subEl.textContent  = "신규 캠페인이 배정되면 이곳에 표시됩니다";
    if (notice) notice.style.display = "none";
    if (retry)  retry.style.display  = "none";
  }
  show("noResultView");
}

function _startAutoRetry(sec) {
  _autoRetryCount = sec;
  const cdEl = document.getElementById("autoRetryCountdown");
  if (cdEl) cdEl.textContent = sec;

  _autoRetryTimer = setInterval(() => {
    _autoRetryCount--;
    if (cdEl) cdEl.textContent = _autoRetryCount;
    if (_autoRetryCount <= 0) {
      cancelAutoRetry();
      doSearch(); // 자동 재시도
    }
  }, 1000);
}

function cancelAutoRetry() {
  if (_autoRetryTimer) {
    clearInterval(_autoRetryTimer);
    _autoRetryTimer = null;
  }
  const retry = document.getElementById("autoRetryNotice");
  if (retry) retry.style.display = "none";
}

/* ── 진행 애니메이션 ── */
let _progressTimer = null;
function startProgress() {
  const wrap = document.getElementById("searchProgress");
  const bar  = document.getElementById("progressBar");
  const txt  = document.getElementById("progressText");
  show(wrap, "block");
  bar.style.width = "0%";
  let pct = 0;
  _progressTimer = setInterval(() => {
    pct = pct < 70 ? pct + 5 : pct < 90 ? pct + 1 : pct;
    bar.style.width = pct + "%";
    const msgs = ["인덱스 검색 중...", "결과 취합 중...", "거의 다 됐어요...", "잠시만요..."];
    txt.textContent = msgs[Math.floor(pct / 25)] || "검색 중...";
  }, 150);
}
function stopProgress() {
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
  const bar  = document.getElementById("progressBar");
  const wrap = document.getElementById("searchProgress");
  if (bar) bar.style.width = "100%";
  setTimeout(() => hide(wrap), 400);
}

/* ── 결과 렌더링 ── */

/**
 * item.row 에서 상품명·옵션 값을 추출해 표시용 문자열 반환
 * - "상품" 포함 헤더 → 상품명
 * - "옵션" / "option" 포함 헤더 → 옵션1, 옵션2, ... (순서대로)
 * 반환: { product: "젤리스틱", options: ["100포"] }  (없으면 빈문자/빈배열)
 */
function extractProductOption(row) {
  if (!row || typeof row !== "object") return { product: "", options: [] };
  const entries = Object.entries(row);
  let product = "";
  const options = [];
  // 상품 헤더: "상품" 포함 (단, "상품명"은 tcDisplayName과 중복이므로 표시 포함)
  for (const [k, v] of entries) {
    const kl = k.trim().toLowerCase();
    if (!kl || kl.startsWith("_")) continue;
    if (!product && kl.includes("상품")) {
      const val = String(v || "").trim();
      if (val) product = val;
    }
  }
  // 옵션 헤더: "옵션" 또는 "option" 포함 헤더를 원래 key 순서대로 수집
  for (const [k, v] of entries) {
    const kl = k.trim().toLowerCase();
    if (!kl || kl.startsWith("_")) continue;
    if (kl.includes("옵션") || kl.includes("option")) {
      const val = String(v || "").trim();
      if (val) options.push({ header: k.trim(), value: val });
    }
  }
  return { product, options };
}

function renderResults(results) {
  const section = document.getElementById("resultsSection");
  const list    = document.getElementById("resultsList");
  const pending = results.filter(item => !item.isSubmitted);

  document.getElementById("resultsCount").textContent = `${pending.length}건`;
  list.innerHTML = "";

  if (pending.length === 0) {
    _showNoResult(false);
    hide(section);
    return;
  }

  // ★ 다건 그룹핑: 【같은 이름 + 같은 인덱스(sheetId+tabName)】 기준으로만 묶기
  //   → 서로 다른 캠페인(탭)에 같은 이름이 있어도 절대 합치지 않음
  const groups = new Map(); // key: "displayName|sheetId|tabName" → items[]
  pending.forEach(item => {
    const name    = (item.displayName || "이름 없음").trim();
    const sid     = (item.sheetId     || "").trim();
    const tab     = (item.tabName     || "").trim();
    const key     = name + "\x00" + sid + "\x00" + tab; // null구분자로 key 구성
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  groups.forEach((items, groupKey) => {
    const name     = groupKey.split("\x00")[0]; // displayName 부분만 추출
    const isSingle = items.length === 1;

    if (isSingle) {
      // ── 단건: [날짜] [표시명/탭명] 옵션:옵션명 형식 ──
      const item = items[0];
      const roundBadge = item.round
        ? `<span style="display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:10px;background:#EEF2FF;color:#4338CA;border:1px solid #C7D2FE;margin-left:4px;vertical-align:middle">${escHtml(item.round)}</span>`
        : "";

      // ★ 참여작업명: [날짜] [표시명(없으면 탭명)] [옵션:옵션명]
      const taskDate = item.startDate || "";
      const taskName = item.tcDisplayName || item.tabName || item.campaignName || "";
      const optionName = item.productName || "";
      const taskParts = [];
      if (taskDate) taskParts.push(taskDate);
      if (taskName) taskParts.push(taskName);
      if (optionName) taskParts.push(`옵션:${optionName}`);
      const taskLabel = taskParts.join(" ");

      const productHtml = taskLabel
        ? `<div class="result-name result-product-name">${escHtml(name)}${roundBadge}</div>
           <div class="result-product-label">${escHtml(taskLabel)}</div>`
        : `<div class="result-name result-product-name">${escHtml(name)}${roundBadge}</div>
           <div class="result-product-label result-product-empty">참여 작업 정보 없음</div>`;
      const card = document.createElement("div");
      card.className = "result-card";
      card.innerHTML = `
        <div class="result-avatar"></div>
        <div class="result-body">${productHtml}</div>
        <div class="result-right">
          <span class="status-badge status-pending">미제출</span>
          <i class="fas fa-chevron-right result-chevron"></i>
        </div>`;
      card.addEventListener("click", () => openSubmitMulti(items));
      list.appendChild(card);

    } else {
      // ── 다건: 그룹 카드 (같은 인덱스 내 다건 참여만 묶임) ──
      const groupCard = document.createElement("div");
      groupCard.className = "result-group-card";

      // ★ 그룹 헤더: [표시명/탭명]
      const campLabel = items[0].tcDisplayName || items[0].tabName || items[0].campaignName || "";

      // 각 항목 라인: [날짜] [표시명/탭명] 옵션:옵션명
      const itemLines = items.map((item) => {
        const taskDate = item.startDate || "";
        const taskName = item.tcDisplayName || item.tabName || item.campaignName || "";
        const optionName = item.productName || "";
        const roundTxt = item.round ? ` · ${item.round}` : "";
        const taskParts = [];
        if (taskDate) taskParts.push(taskDate);
        if (taskName) taskParts.push(taskName);
        if (optionName) taskParts.push(`옵션:${optionName}`);
        const taskLabel = taskParts.join(" ") || "작업 정보 없음";
        return `<div class="result-group-item">
          <i class="fas fa-box" style="color:var(--p);font-size:.72rem;flex-shrink:0"></i>
          <span class="result-group-item-label">${escHtml(taskLabel)}${escHtml(roundTxt)}</span>
          <span class="result-group-item-badge">미제출</span>
        </div>`;
      }).join("");

      groupCard.innerHTML = `
        <div class="result-group-header">
          <i class="fas fa-user-circle" style="font-size:1.4rem;color:var(--p);flex-shrink:0"></i>
          <div style="flex:1;min-width:0">
            <div class="result-group-name">${escHtml(name)}</div>
            ${campLabel ? `<div style="font-size:.68rem;color:var(--t3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(campLabel)}</div>` : ""}
          </div>
          <span class="result-group-badge"><i class="fas fa-layer-group"></i> ${items.length}건 동시제출</span>
          <i class="fas fa-chevron-right" style="color:var(--t3);font-size:.8rem;flex-shrink:0"></i>
        </div>
        <div class="result-group-items">${itemLines}</div>`;
      groupCard.addEventListener("click", () => openSubmitMulti(items));
      list.appendChild(groupCard);
    }
  });

  show(section);
}

/* ── 리뷰 제출 화면 (다건 통합) ── */
/**
 * items: Item 배열 (1건이면 [item], 다건이면 [item1, item2, ...])
 * 공통 진입점 — openSubmit(item) 대신 항상 이 함수 사용
 */
function openSubmitMulti(items) {
  S.selectedRows = items;
  S.selectedRow  = items[0];          // 하위 호환
  S.filesByIdx   = {};
  S.memoByIdx    = {};
  S.files        = [];
  S.step         = 1;

  // 헤더 타이틀 — [날짜] [표시명/탭명] 옵션:옵션명
  const firstForTitle = items[0];
  const subtitleParts = [];
  if (firstForTitle.startDate) subtitleParts.push(firstForTitle.startDate);
  const subtitleName = firstForTitle.tcDisplayName || firstForTitle.tabName || firstForTitle.campaignName || "";
  if (subtitleName) subtitleParts.push(subtitleName);
  if (firstForTitle.productName) subtitleParts.push(`옵션:${firstForTitle.productName}`);
  document.getElementById("submitTitle").textContent    = "리뷰 이미지 제출";
  document.getElementById("submitSubtitle").textContent = subtitleParts.join(" ") || "";

  // 상품 URL (첫 번째 항목 기준)
  const firstItem = items[0];
  const link = document.getElementById("productLink");
  if (firstItem.productUrl) {
    link.href = firstItem.productUrl;
    show(link, "inline-flex");
    const strip = document.getElementById("productStrip");
    if (strip) {
      const thumbWrap = strip.querySelector(".thumb-wrap");
      const labelEl   = strip.querySelector(".product-label");
      const nameEl    = document.getElementById("productName");
      if (thumbWrap) thumbWrap.style.display = "none";
      if (labelEl)   labelEl.style.display   = "none";
      if (nameEl)    nameEl.style.display     = "none";
      strip.style.display = "";
    }
  } else {
    hide(link);
    const strip = document.getElementById("productStrip");
    if (strip) strip.style.display = "none";
  }

  // STEP1: 다건 정보 확인 그리드 렌더
  _renderMultiInfoGrid(items);

  // STEP2: 다건 이미지 슬롯 렌더
  _renderMultiImageSlots(items);

  // 이미 제출 경고 (1건이라도 있으면 표시)
  const anyDone = items.some(it => it.isSubmitted);
  const doneBox  = document.getElementById("alreadyDoneBox");
  const btnStep2 = document.getElementById("btnToStep2");
  doneBox.classList.toggle("hidden", !anyDone);
  doneBox.style.display = anyDone ? "" : "none";
  btnStep2.disabled = items.every(it => it.isSubmitted);

  // STEP1 버튼 텍스트: 다건이면 "N건 모두 맞습니다"
  btnStep2.innerHTML = items.length > 1
    ? `<i class="fas fa-check"></i> ${items.length}건 모두 맞습니다`
    : `<i class="fas fa-check"></i> 맞습니다`;

  goStep(1);
  showScreen("screenSubmit");
}

/** STEP1: 다건 정보 확인 그리드 (각 항목별 섹션 구분) */
function _renderMultiInfoGrid(items) {
  const grid = document.getElementById("infoGrid");
  grid.innerHTML = "";

  if (items.length === 1) {
    // 단건: 기존 방식
    renderInfoGrid(items[0].row, items[0].tcDisplayName || "");
    return;
  }

  items.forEach((item, idx) => {
    // 섹션 헤더
    const productLabel = item.tcDisplayName || item.productName || "상품명 없음";
    const { options } = extractProductOption(item.row || {});
    const optTxt = options.length > 0 ? ` (${options.map(o=>o.value).filter(Boolean).join("/")})` : "";

    const secHeader = document.createElement("div");
    secHeader.className = "mr-info-section";
    secHeader.innerHTML = `<div class="mr-info-section-header">
      <div class="mr-info-section-num">${idx+1}</div>
      <div class="mr-info-section-title">${escHtml(productLabel)}${escHtml(optTxt)}</div>
    </div>`;
    // 내부에 infoGrid div 추가
    const innerGrid = document.createElement("div");
    innerGrid.className = "info-grid";
    innerGrid.style.border = "none";
    innerGrid.style.borderRadius = "0";
    secHeader.appendChild(innerGrid);
    grid.appendChild(secHeader);

    // 기존 renderInfoGrid 로직을 inner에 적용
    _renderInfoGridInto(innerGrid, item.row, item.tcDisplayName || "");
  });
}

/** 기존 renderInfoGrid 로직을 특정 el에 주입 (재사용) */
function _renderInfoGridInto(gridEl, row, tabDisplayName) {
  gridEl.innerHTML = "";
  // ── 임시로 infoGrid를 교체해서 renderInfoGrid를 재활용 ──
  const orig = document.getElementById("infoGrid");
  const origParent = orig.parentNode;
  // gridEl을 실제 DOM infoGrid 위치에 임시로 넣어서 renderInfoGrid 재사용
  orig.id = "__infoGrid_bak";
  gridEl.id = "infoGrid";
  renderInfoGrid(row, tabDisplayName);
  gridEl.id = "";
  orig.id = "infoGrid";
}

/** STEP2: 다건 이미지 슬롯 동적 생성 */
function _renderMultiImageSlots(items) {
  const step2Pane = document.getElementById("step2");
  const paneCard  = step2Pane.querySelector(".pane-card");

  // 기존 슬롯 영역 초기화
  let slotsWrap = document.getElementById("mrSlotsWrap");
  if (slotsWrap) slotsWrap.remove();
  // 기존 단건 dropZone / memoWrap 가시성 제어
  const singleDrop  = document.getElementById("dropZone");
  const singleMemo  = document.querySelector(".memo-wrap");
  const progressWrap = document.getElementById("mrProgressWrap");

  if (items.length === 1) {
    // 단건: 기존 UI 그대로
    if (singleDrop) singleDrop.style.display = "";
    if (singleMemo) singleMemo.style.display = "";
    if (progressWrap) progressWrap.classList.remove("show");
    return;
  }

  // 다건: 기존 단건 UI 숨기고 다건 슬롯 생성
  if (singleDrop) singleDrop.style.display = "none";
  if (singleMemo) singleMemo.style.display = "none";

  slotsWrap = document.createElement("div");
  slotsWrap.id = "mrSlotsWrap";
  slotsWrap.style.marginBottom = "14px";

  items.forEach((item, idx) => {
    const productLabel = item.tcDisplayName || item.productName || "상품명 없음";
    const { options } = extractProductOption(item.row || {});
    const optTxt = options.length > 0 ? ` (${options.map(o=>o.value).filter(Boolean).join("/")})` : "";

    const slot = document.createElement("div");
    slot.className = "mr-slot";
    slot.id = `mrSlot_${idx}`;
    slot.innerHTML = `
      <div class="mr-slot-header">
        <div class="mr-slot-num">${idx+1}</div>
        <div class="mr-slot-title">${escHtml(productLabel)}${escHtml(optTxt)}</div>
        <span class="mr-slot-status wait" id="mrSlotStatus_${idx}">대기</span>
      </div>
      <div class="mr-slot-dropzone" id="mrDz_${idx}"
           ondragover="event.preventDefault();this.classList.add('drag-over')"
           ondragleave="this.classList.remove('drag-over')"
           ondrop="_mrOnDrop(event,${idx})">
        <input type="file" accept="image/*" multiple id="mrFile_${idx}"
               onchange="_mrOnFilesSelected(this,${idx})">
        <div class="mr-slot-dz-hint" id="mrDzHint_${idx}">
          <i class="fas fa-cloud-upload-alt"></i>
          <span>클릭 또는 드래그 · JPG/PNG/WebP</span>
        </div>
        <div class="mr-slot-preview hidden" id="mrPreview_${idx}"></div>
      </div>
      <textarea class="mr-slot-memo" id="mrMemo_${idx}" rows="1"
                placeholder="메모 (선택사항)" style="margin-top:8px"></textarea>`;
    slotsWrap.appendChild(slot);
  });

  // step-nav 앞에 삽입
  const stepNav = paneCard.querySelector(".step-nav");
  paneCard.insertBefore(slotsWrap, stepNav);
}

/* ─── 다건 슬롯 파일 핸들러 ─── */
function _mrOnFilesSelected(input, idx) {
  const files = Array.from(input.files || []);
  _mrAddFiles(idx, files);
  input.value = "";
}
function _mrOnDrop(e, idx) {
  e.preventDefault();
  const dz = document.getElementById("mrDz_" + idx);
  if (dz) dz.classList.remove("drag-over");
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
  _mrAddFiles(idx, files);
}

/**
 * ★ 개선: 다건 슬롯도 즉시 Base64 변환 저장
 */
async function _mrAddFiles(idx, newFiles) {
  if (!S.filesByIdx[idx]) S.filesByIdx[idx] = [];
  const MAX = 10 * 1024 * 1024;
  for (const f of newFiles) {
    if (f.size > MAX) { showToast(`${f.name}: 10MB 초과`, "warning"); continue; }
    try {
      const b64 = await fileToBase64(f);
      // ★ 이미지 압축 시 JPEG로 변환되므로 type 업데이트
      const actualType = (f.type.startsWith('image/') && f.size > 1024 * 1024) ? 'image/jpeg' : f.type;
      S.filesByIdx[idx].push({ file: f, b64, size: f.size, type: actualType, name: f.name });
    } catch(e) {
      showToast(`${f.name}: 이미지 읽기 실패 (다시 선택해주세요)`, "error");
    }
  }
  _mrRenderPreview(idx);
}
function _mrRemoveFile(idx, fileIdx) {
  if (S.filesByIdx[idx]) S.filesByIdx[idx].splice(fileIdx, 1);
  _mrRenderPreview(idx);
}
function _mrRenderPreview(idx) {
  const files = S.filesByIdx[idx] || [];
  const hint    = document.getElementById("mrDzHint_" + idx);
  const preview = document.getElementById("mrPreview_" + idx);
  const status  = document.getElementById("mrSlotStatus_" + idx);
  if (!preview) return;
  if (files.length === 0) {
    preview.innerHTML = "";
    preview.classList.add("hidden");
    if (hint) hint.style.display = "";
    if (status) { status.textContent = "대기"; status.className = "mr-slot-status wait"; }
    return;
  }
  if (hint) hint.style.display = "none";
  preview.classList.remove("hidden");
  // ★ b64 데이터URL로 미리보기 (File 참조 불필요)
  preview.innerHTML = files.map((fo, fi) => {
    return `<div class="mr-slot-thumb">
      <img src="data:${fo.type};base64,${fo.b64}" alt="">
      <button class="mr-remove" onclick="_mrRemoveFile(${idx},${fi})" title="삭제">
        <i class="fas fa-times"></i>
      </button>
    </div>`;
  }).join("");
  if (status) { status.textContent = `${files.length}장`; status.className = "mr-slot-status ok"; }
}

/* ── 기존 단건 openSubmit → openSubmitMulti 래퍼 ── */
function openSubmit(item) {
  openSubmitMulti([item]);
}

/* _openSubmitLegacy 제거됨 — openSubmit은 openSubmitMulti([item]) 래퍼로 대체 */

/* ── STEP 이동 ── */
function goStep(n) {
  [1, 2].forEach(i => {
    document.getElementById(`step${i}`).classList.toggle("active", i === n);
    const sl = document.getElementById(`sl${i}`);
    sl.classList.remove("active", "done");
    if (i < n)        sl.classList.add("done");
    else if (i === n) sl.classList.add("active");
  });
  document.getElementById("stepFill").style.width = n === 1 ? "25%" : "100%";
  S.step = n;
  // STEP2 진입 시 제출 버튼 텍스트 업데이트
  if (n === 2) {
    const cnt = S.selectedRows && S.selectedRows.length > 1 ? S.selectedRows.length : 0;
    const btn = document.getElementById("btnSubmit");
    if (btn) btn.innerHTML = cnt > 1
      ? `<i class="fas fa-paper-plane"></i> ${cnt}건 모두 제출하기`
      : '<i class="fas fa-paper-plane"></i> 제출하기';
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── 정보 그리드 ── */
function renderInfoGrid(row, tabDisplayName) {
  const grid = document.getElementById("infoGrid");
  grid.innerHTML = "";

  // ── 전화번호 마스킹: 010-1234-5678 → 010-****-5678
  function maskPhone(val) {
    const s = String(val).trim();
    const m1 = s.match(/^(\d{2,3})[-.\s]?(\d{3,4})[-.\s]?(\d{4})$/);
    if (m1) return m1[1] + "-****-" + m1[3];
    const m2 = s.match(/^(\d{3})(\d{4})(\d{4})$/);
    if (m2) return m2[1] + "-****-" + m2[3];
    return s;
  }

  // ── row 키 정규화 맵 (소문자 trim)
  const rowLower = {};
  Object.entries(row).forEach(([k, v]) => { rowLower[k.trim().toLowerCase()] = v; });
  const rowLowerKeys = Object.keys(rowLower);

  /**
   * keys 배열에서 값 찾기
   * 1단계: 정확 일치
   * 2단계: 소문자 정확 일치
   * 3단계: 부분 포함 일치 (예: "쿠팡id", "네이버ID")
   */
  function findVal(keys) {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    for (const k of keys) {
      const v = rowLower[k.trim().toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    }
    for (const k of keys) {
      const kLow = k.trim().toLowerCase();
      for (const rk of rowLowerKeys) {
        if (rk.includes(kLow)) {
          const v = rowLower[rk];
          if (v !== undefined && v !== null && String(v).trim() !== "") return v;
        }
      }
    }
    return undefined;
  }

  /**
   * 결제금액: 헤더에 "결제" 또는 "금액" 이 포함된 키를 찾아 반환
   * (정확 일치 우선 → 부분 포함 순)
   */
  function findPaymentVal() {
    const keywords = ["결제", "금액"];
    // 내부 skip 키 제외
    const skipKeys = new Set(["_rowIndex","_sheetId","_gid","_submitCol","_tabName","_campaignName"]);
    for (const rk of rowLowerKeys) {
      if (skipKeys.has(rk)) continue;
      for (const kw of keywords) {
        if (rk.includes(kw)) {
          const v = rowLower[rk];
          if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
        }
      }
    }
    return undefined;
  }

  // ── 헬퍼: 일반 단일 행 생성
  function makeRow(label, value, extraClass) {
    const el = document.createElement("div");
    el.className = "ig-row" + (extraClass ? " " + extraClass : "");
    el.innerHTML = `<div class="ig-label">${escHtml(label)}</div><div class="ig-value"><span>${escHtml(String(value))}</span></div>`;
    return el;
  }

  // ── 헬퍼: 한 행에 2칸 표시 (페어 행)
  function makePairRow(labelA, valA, labelB, valB, maskFnA, maskFnB) {
    const dispA = valA ? (maskFnA ? maskFnA(valA) : String(valA)) : null;
    const dispB = valB ? (maskFnB ? maskFnB(valB) : String(valB)) : null;
    if (!dispA && !dispB) return null;

    const el = document.createElement("div");
    el.className = "ig-row-pair";

    // 왼쪽 칸
    const cellA = document.createElement("div");
    cellA.className = "ig-pair-cell";
    if (dispA) {
      cellA.innerHTML = `<div class="ig-label">${escHtml(labelA)}</div><div class="ig-value"><span>${escHtml(dispA)}</span></div>`;
    } else {
      cellA.innerHTML = `<div class="ig-label">${escHtml(labelA)}</div><div class="ig-value" style="color:var(--t3);font-size:.8rem"><span>-</span></div>`;
    }

    // 오른쪽 칸
    const cellB = document.createElement("div");
    cellB.className = "ig-pair-cell";
    if (dispB) {
      cellB.innerHTML = `<div class="ig-label">${escHtml(labelB)}</div><div class="ig-value"><span>${escHtml(dispB)}</span></div>`;
    } else {
      cellB.innerHTML = `<div class="ig-label">${escHtml(labelB)}</div><div class="ig-value" style="color:var(--t3);font-size:.8rem"><span>-</span></div>`;
    }

    el.appendChild(cellA);
    el.appendChild(cellB);
    return el;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 표시 순서:
  //  1. 상품명 (세부목록 displayName)
  //  1-1. 상품 컬럼값 (시트 "상품" 헤더) — displayName과 다를 때
  //  1-2. 옵션 (시트 "옵션"/"옵션1"/"옵션2"... 헤더) — 있을 때만
  //  2. 결제금액
  //  3. 주문자 / 수취인
  //  4. 아이디 / 전화번호
  //  5. 예금주
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  let hasAny = false;

  // 1. 상품명 (세부목록 displayName)
  if (tabDisplayName && tabDisplayName.trim()) {
    grid.appendChild(makeRow("상품명", tabDisplayName.trim(), "ig-row-product"));
    hasAny = true;
  }

  // 1-1. 시트 상품 컬럼 (헤더에 "상품" 포함)
  const { product: sheetProduct, options: sheetOptions } = extractProductOption(row);
  if (sheetProduct) {
    // displayName과 같으면 중복 표시 생략
    if (sheetProduct !== tabDisplayName.trim()) {
      grid.appendChild(makeRow("상품", sheetProduct, "ig-row-product"));
      hasAny = true;
    }
  }

  // 1-2. 옵션 (있을 때만, 헤더명과 값을 함께 표시)
  if (sheetOptions.length > 0) {
    sheetOptions.forEach(opt => {
      grid.appendChild(makeRow(opt.header, opt.value, "ig-row-option"));
    });
    hasAny = true;
  }

  // 2. 결제금액
  const paymentVal = findPaymentVal();
  if (paymentVal) {
    grid.appendChild(makeRow("결제금액", paymentVal, "ig-row-price"));
    hasAny = true;
  }

  // 3. 주문자 / 수취인 (페어)
  const ordererVal   = findVal(APP_CONFIG.COL_ALIASES.orderer);
  const recipientVal = findVal(APP_CONFIG.COL_ALIASES.recipient);
  if (ordererVal || recipientVal) {
    const pairRow = makePairRow("주문자", ordererVal, "수취인", recipientVal);
    if (pairRow) { grid.appendChild(pairRow); hasAny = true; }
  }

  // 4. 아이디 / 전화번호 (페어)
  const userIdVal = findVal(APP_CONFIG.COL_ALIASES.userId);
  const phoneVal  = findVal(APP_CONFIG.COL_ALIASES.phone);
  if (userIdVal || phoneVal) {
    const pairRow = makePairRow("아이디", userIdVal, "전화번호", phoneVal, null, maskPhone);
    if (pairRow) { grid.appendChild(pairRow); hasAny = true; }
  }

  // 5. 예금주
  const depositorVal = findVal(APP_CONFIG.COL_ALIASES.depositor);
  if (depositorVal) {
    grid.appendChild(makeRow("예금주", depositorVal));
    hasAny = true;
  }

  // 데이터가 전혀 없으면 폴백: row의 모든 비어있지 않은 필드 표시
  if (!hasAny) {
    const skip = new Set(["_rowIndex","_sheetId","_gid","_submitCol","_tabName","_campaignName"]);
    Object.entries(row).forEach(([k, v]) => {
      if (skip.has(k) || !v || !String(v).trim()) return;
      grid.appendChild(makeRow(k, String(v)));
    });
  }
}

/* ── 파일 업로드 ── */
function bindDragDrop() {
  const zone = document.getElementById("dropZone");
  if (!zone) return;
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("drag-over");
    addFiles(Array.from(e.dataTransfer.files).filter(f => APP_CONFIG.ALLOWED_MIME.includes(f.type)));
  });
}
function onFilesSelected(e) { addFiles(Array.from(e.target.files)); e.target.value = ""; }

/**
 * ★ 개선: 파일 선택 즉시 Base64 변환 후 { file, b64, size, type, name } 객체로 저장
 *   → submitReview() 시점에 File 참조가 만료되는 Android WebView 문제 방지
 */
async function addFiles(files) {
  for (const f of files) {
    if (!APP_CONFIG.ALLOWED_MIME.includes(f.type)) { showToast(`${f.name}: 지원하지 않는 형식`, "error"); continue; }
    if (f.size > APP_CONFIG.MAX_FILE_SIZE)          { showToast(`${f.name}: 10MB 초과`, "error");        continue; }
    try {
      const b64 = await fileToBase64(f);
      // ★ 이미지 압축 시 JPEG로 변환되므로 type을 image/jpeg로 설정
      const actualType = (f.type.startsWith('image/') && f.size > 1024 * 1024) ? 'image/jpeg' : f.type;
      S.files.push({ file: f, b64, size: f.size, type: actualType, name: f.name });
    } catch(e) {
      showToast(`${f.name}: 이미지 읽기 실패 (다시 선택해주세요)`, "error");
    }
  }
  renderPreviews();
}
function removeFile(i) { S.files.splice(i, 1); renderPreviews(); }
function renderPreviews() {
  const ph   = document.getElementById("dzPlaceholder");
  const prev = document.getElementById("dzPreview");
  if (!ph || !prev) return;
  if (S.files.length === 0) { ph.style.display = ""; hide(prev); prev.innerHTML = ""; return; }
  ph.style.display = "none"; show(prev); prev.innerHTML = "";
  S.files.forEach((fo, i) => {
    const item = document.createElement("div"); item.className = "prev-item";
    const img  = document.createElement("img");
    // ★ b64 데이터URL로 미리보기 (File 참조 불필요)
    img.src = `data:${fo.type};base64,${fo.b64}`;
    const del = document.createElement("button"); del.className = "prev-del";
    del.innerHTML = '<i class="fas fa-times"></i>';
    del.onclick = e => { e.stopPropagation(); removeFile(i); };
    item.append(img, del); prev.appendChild(item);
  });
  const add = document.createElement("div"); add.className = "prev-add";
  add.innerHTML = '<i class="fas fa-plus"></i><span>추가</span>';
  add.onclick = e => { e.stopPropagation(); document.getElementById("imgInput").click(); };
  prev.appendChild(add);
}

/* ── 리뷰 제출 ── */
async function submitReview() {
  const items = S.selectedRows && S.selectedRows.length > 0 ? S.selectedRows : (S.selectedRow ? [S.selectedRow] : []);
  if (!items.length) { showToast("주문 정보를 다시 확인해주세요.", "error"); return; }
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 설정해주세요.", "error"); return; }

  const isMulti = items.length > 1;

  // ── 파일 유효성 검사 ──
  if (isMulti) {
    // 다건: 각 슬롯별로 1장 이상
    const emptySlots = items.map((_, idx) => (S.filesByIdx[idx] || []).length === 0 ? idx + 1 : null).filter(n => n !== null);
    if (emptySlots.length === items.length) {
      showToast("각 리뷰마다 이미지를 1장 이상 첨부해주세요.", "warning"); return;
    }
    if (emptySlots.length > 0) {
      showToast(`${emptySlots.length}개 항목에 이미지가 없습니다. (${emptySlots.join(", ")}번)`, "warning"); return;
    }
  } else {
    if (S.files.length === 0) { showToast("이미지를 1장 이상 첨부해주세요.", "warning"); return; }
  }

  const btn = document.getElementById("btnSubmit");
  btn.disabled = true;
  const progressWrap = document.getElementById("mrProgressWrap");
  const progressFill = document.getElementById("mrProgressFill");
  const progressLabel = document.getElementById("mrProgressLabel");
  if (isMulti && progressWrap) progressWrap.classList.add("show");

  const MAX_TOTAL_MB = 15;
  let successCount = 0;
  const errors = [];

  try {
    for (let idx = 0; idx < items.length; idx++) {
      const item  = items[idx];
      const files = isMulti ? (S.filesByIdx[idx] || []) : S.files;
      const memo  = isMulti
        ? (document.getElementById("mrMemo_" + idx)?.value.trim() || "")
        : document.getElementById("memoTxt").value.trim();

      if (isMulti) {
        const pct = Math.round((idx / items.length) * 100);
        if (progressFill)  progressFill.style.width  = pct + "%";
        if (progressLabel) progressLabel.textContent  = `${idx + 1} / ${items.length} 제출 중...`;
        btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${idx+1}/${items.length} 제출 중...`;
      } else {
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 제출 중...';
      }

      try {
        // ★ 파일 크기 검사 (이미 b64로 저장된 객체 기준)
        const totalBytes = files.reduce((s, fo) => s + (fo.size || 0), 0);
        if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) {
          throw new Error(`이미지 총 용량이 ${MAX_TOTAL_MB}MB를 초과합니다.`);
        }

        // ★ 이미 선택 시점에 Base64 변환 완료 → 별도 변환 불필요
        const fileData = files.map(fo => fo.b64);
        if (fileData.some(b => !b)) {
          throw new Error("이미지 데이터가 없습니다. 이미지를 다시 선택해주세요.");
        }

        showLoading(isMulti ? `(${idx+1}/${items.length}) 업로드 중...` : "업로드 중... (잠시 기다려주세요)");

        const reviewerName = item.displayName || "이름없음";
        const { options: rowOpts } = extractProductOption(item.row || {});
        const optionFolderName = rowOpts.map(o => o.value).filter(Boolean).join(" ").trim();

        // ── Step 1: 이미지를 구글 드라이브에 업로드 ──
        // ★ 모바일 네트워크에서 Base64 이미지 업로드는 시간이 오래 걸림 → 타임아웃 180초
        const uploadResult = await gasPostUpload({
          action:           "uploadReviewImage",
          sheetId:          item.sheetId,
          tabName:          item.tabName,
          gid:              item.gid,
          rowIndex:         item.rowIndex,
          reviewerName,
          submitCol:        item.submitCol,
          campaignName:     item.campaignName,
          optionFolderName,
          memo,
          files: fileData.map((b64, fi) => ({
            name:     reviewerName + "_" + (fi + 1),
            mimeType: files[fi].type || "image/jpeg",
            data:     b64,
          }))
        }, 180000);

        if (!uploadResult || (!uploadResult.ok && !uploadResult.success)) {
          throw new Error(uploadResult?.error || "이미지 업로드 실패");
        }

        // ── Step 2: 시트에 제출 시점 기록 ──
        const now = new Date();
        const submitTimeValue = `${now.getMonth()+1}/${now.getDate()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

        const result = await gasPost({
          action:           "submitReview",
          sheetId:          item.sheetId,
          tabName:          item.tabName,
          gid:              item.gid,
          rowIndex:         item.rowIndex,
          reviewerName,
          submitCol:        item.submitCol,
          value:            submitTimeValue,
          campaignName:     item.campaignName,
        }, 30000);

        hideLoading();
        if (result && (result.success || result.ok)) {
          successCount++;
          // 슬롯 상태 표시
          if (isMulti) {
            const slotStatus = document.getElementById("mrSlotStatus_" + idx);
            if (slotStatus) { slotStatus.textContent = "✓ 완료"; slotStatus.className = "mr-slot-status ok"; }
          }
        } else {
          const errMsg = result?.error || (result == null ? "서버 응답 없음" : "알 수 없는 오류");
          throw new Error(errMsg);
        }
      } catch (itemErr) {
        hideLoading();
        const msg = (itemErr.message && itemErr.message !== "undefined") ? itemErr.message : "제출 실패";
        errors.push(`${idx+1}번 오류: ${msg}`);
        console.error(`[submitReview] ${idx+1}번 실패:`, itemErr);
        if (isMulti) {
          const slotStatus = document.getElementById("mrSlotStatus_" + idx);
          if (slotStatus) { slotStatus.textContent = "✗ 실패"; slotStatus.className = "mr-slot-status wait"; }
        }
      }
    } // end for loop

    // 진행 바 완료
    if (isMulti && progressFill)  progressFill.style.width  = "100%";
    if (isMulti && progressLabel) progressLabel.textContent  = `완료: ${successCount}/${items.length}건`;

    if (successCount > 0) {
      _clearSearchCache();
      const reviewerName = items[0].displayName || "이름없음";
      const successMsg = isMulti
        ? `<strong>${escHtml(reviewerName)}</strong>님의 리뷰 <b>${successCount}건</b>이 제출되었습니다 😊`
          + (errors.length > 0 ? `<br><span style="color:#DC2626;font-size:.82rem">${errors.length}건 실패 (콘솔 확인)</span>` : "")
        : `<strong>${escHtml(reviewerName)}</strong>님의 리뷰가 제출되었습니다 😊`;
      document.getElementById("successMessage").innerHTML = successMsg;
      show("successModal", "flex");
    } else {
      showToast("모든 제출에 실패했습니다: " + errors.join(" / "), "error");
    }

  } catch (err) {
    hideLoading();
    const displayMsg = (err.message && err.message !== "undefined" && err.message !== "null")
      ? err.message
      : "제출에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.";
    showToast("제출 실패: " + displayMsg, "error");
    console.error("[submitReview] 전체 오류:", err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = isMulti
      ? `<i class="fas fa-paper-plane"></i> ${items.length}건 제출하기`
      : '<i class="fas fa-paper-plane"></i> 제출하기';
    if (isMulti && progressWrap) setTimeout(() => progressWrap.classList.remove("show"), 2000);
  }
}

function resetApp() {
  hide("successModal");
  S.files = []; S.selectedRow = null; S.selectedRows = []; S.filesByIdx = {}; S.memoByIdx = {};
  const nameEl = document.getElementById("nameInput");
  const memoEl = document.getElementById("memoTxt");
  if (nameEl) nameEl.value = "";
  if (memoEl) memoEl.value = "";
  hide("resultsSection");
  hide("noResultView");
  renderPreviews();
  // 다건 슬롯 제거
  const slotsWrap = document.getElementById("mrSlotsWrap");
  if (slotsWrap) slotsWrap.remove();
  const singleDrop = document.getElementById("dropZone");
  const singleMemo = document.querySelector(".memo-wrap");
  if (singleDrop) singleDrop.style.display = "";
  if (singleMemo) singleMemo.style.display = "";
  const pw = document.getElementById("mrProgressWrap");
  if (pw) pw.classList.remove("show");
  showScreen("screenSearch");
}

/* ── 관리자 세션 (search.html에서는 미사용 — stub 유지) ── */
function isAdminLoggedIn() { return false; }
function setAdminSession() {}
function clearAdminSession() {}
function getAdminSessionRemaining() { return null; }

/* ── GAS URL 설정 모달 (비밀번호 인증) ── */
const GAS_URL_PW = "rhakdnjdy1!"; // 설정 접근 비밀번호

function openGasUrlModal() {
  // 항상 STEP1(비밀번호)부터 시작
  show("gasUrlStep1");
  hide("gasUrlStep2");
  const pwEl = document.getElementById("gasUrlPwInput");
  pwEl.value = "";
  hide("gasUrlPwError");
  hide("gasUrlError");
  show("gasUrlModal", "flex");
  setTimeout(() => pwEl.focus(), 100);
}
function closeGasUrlModal() {
  hide("gasUrlModal");
}
function verifyGasUrlPw() {
  const pw    = document.getElementById("gasUrlPwInput").value;
  const errEl = document.getElementById("gasUrlPwError");
  hide(errEl);
  if (!pw) {
    errEl.textContent = "비밀번호를 입력하세요.";
    show(errEl);
    return;
  }
  if (pw !== GAS_URL_PW) {
    errEl.textContent = "비밀번호가 틀렸습니다.";
    show(errEl);
    document.getElementById("gasUrlPwInput").value = "";
    document.getElementById("gasUrlPwInput").focus();
    return;
  }
  // 비밀번호 확인 성공 → STEP2로 전환
  hide("gasUrlStep1");
  const urlInput = document.getElementById("gasUrlInput");
  urlInput.value = APP_CONFIG.GAS_WEB_APP_URL || "";
  hide("gasUrlError");
  show("gasUrlStep2");
  _renderGasUrlHistory(); // ← 이력 목록 갱신
  setTimeout(() => urlInput.focus(), 100);
}
function saveGasUrl() {
  const url   = document.getElementById("gasUrlInput").value.trim();
  const errEl = document.getElementById("gasUrlError");
  hide(errEl);
  if (!url) {
    errEl.textContent = "URL을 입력해주세요.";
    show(errEl);
    return;
  }
  if (!url.includes("script.google.com/macros/s/")) {
    errEl.textContent = "올바른 GAS 배포 URL 형식이 아닙니다. (/macros/s/.../exec)";
    show(errEl);
    return;
  }
  // ── 변경 이력 기록 ──
  _addGasUrlHistory(url);
  saveConfig({ GAS_WEB_APP_URL: url });
  APP_CONFIG.GAS_WEB_APP_URL = url;
  // ★ GAS PropertiesService에도 저장 → 다른 접속자에게 자동 반영
  _saveAppUrlToGas(url);
  closeGasUrlModal();
  hide("gasNotSet");
  showToast("GAS URL이 저장되었습니다. 다른 접속자에게도 자동 반영됩니다.", "success");
}

/* ── GAS URL 변경 이력 관리 ── */
const GAS_URL_HISTORY_KEY = "rapp_url_history";
const GAS_URL_HISTORY_MAX = 10; // 최대 보관 건수

/** 이력 배열 반환 (최신순) */
function _loadGasUrlHistory() {
  try {
    const raw = localStorage.getItem(GAS_URL_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

/** URL 저장 시 이력에 추가 */
function _addGasUrlHistory(url) {
  const list = _loadGasUrlHistory();
  // 버전 번호: 현재 이력 중 같은 URL의 최대 버전 + 1, 없으면 전체 최대 버전 + 1
  const allVersions = list.map(h => h.version || 0);
  const nextVersion = (allVersions.length ? Math.max(...allVersions) : 0) + 1;

  // 동일 URL이 최신 항목이면 중복 추가 안 함
  if (list.length && list[0].url === url) return;

  const entry = {
    version:   nextVersion,
    url:       url,
    savedAt:   Date.now()  // ms timestamp
  };
  list.unshift(entry); // 최신을 앞에
  if (list.length > GAS_URL_HISTORY_MAX) list.splice(GAS_URL_HISTORY_MAX);
  try { localStorage.setItem(GAS_URL_HISTORY_KEY, JSON.stringify(list)); } catch (_) {}
}

/** 이력 전체 삭제 */
function clearGasUrlHistory() {
  if (!confirm("변경 이력을 모두 삭제하시겠습니까?")) return;
  try { localStorage.removeItem(GAS_URL_HISTORY_KEY); } catch (_) {}
  _renderGasUrlHistory();
}

/** 이력 목록을 모달에 렌더링 */
function _renderGasUrlHistory() {
  const wrap = document.getElementById("gasUrlHistoryWrap");
  const list = document.getElementById("gasUrlHistoryList");
  if (!wrap || !list) return;
  const history = _loadGasUrlHistory();
  if (!history.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "block";
  list.innerHTML = history.map((h, i) => {
    const dt  = new Date(h.savedAt);
    const pad = n => String(n).padStart(2, "0");
    const dateStr = `${dt.getFullYear()}.${pad(dt.getMonth()+1)}.${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    // URL 중간 생략 (앞 30자 + … + 끝 20자)
    const short = h.url.length > 54
      ? h.url.slice(0, 32) + "…" + h.url.slice(-20)
      : h.url;
    const isCurrent = (APP_CONFIG.GAS_WEB_APP_URL === h.url);
    return `
      <div class="gas-url-history-item${isCurrent ? ' gas-url-history-current' : ''}"
           onclick="_selectGasUrlHistory('${i}')" title="${h.url}">
        <div style="display:flex;align-items:center;gap:6px;min-width:0">
          <span class="gas-url-ver-badge">v${h.version}</span>
          <span class="gas-url-history-url">${short}</span>
          ${isCurrent ? '<span class="gas-url-cur-tag">현재</span>' : ''}
        </div>
        <span class="gas-url-history-date">${dateStr}</span>
      </div>`;
  }).join('');
}

/** 이력 항목 클릭 → 입력칸에 자동 입력 */
function _selectGasUrlHistory(idx) {
  const history = _loadGasUrlHistory();
  const entry   = history[Number(idx)];
  if (!entry) return;
  const input = document.getElementById("gasUrlInput");
  if (input) {
    input.value = entry.url;
    input.focus();
    // 선택 피드백
    document.querySelectorAll(".gas-url-history-item").forEach((el, i) => {
      el.classList.toggle("gas-url-history-selected", i === Number(idx));
    });
  }
}

/** GAS PropertiesService에 URL 저장 (백그라운드, 비동기) */
async function _saveAppUrlToGas(url) {
  try {
    const pw = GAS_URL_PW; // 설정 비밀번호 (기존 상수 그대로 사용)
    const res = await fetch(`${url}?action=saveAppUrl&url=${encodeURIComponent(url)}&pw=${encodeURIComponent(pw)}`, { redirect: "follow" });
    if (res.ok) {
      const json = await res.json();
      if (json.ok) console.log("[GAS] URL PropertiesService 저장 완료");
      else console.warn("[GAS] URL 저장 실패:", json.error);
    }
  } catch (e) {
    console.warn("[GAS] URL 저장 오류 (무시):", e.message);
  }
}

/* ── 관리자 접근 차단 (search.html에서는 모든 경로 비활성) ── */
function openAdminLogin() {}
function closeAdminLogin() {}
async function submitAdminLogin() {}
function enterAdminScreen() {}
function exitAdmin() {}

/* ── 관리자 탭 전환 ── */
function switchAdminTab(tabName) {
  document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".admin-tab-pane").forEach(p => p.classList.remove("active"));
  const btn  = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  const pane = document.getElementById(`tab-${tabName}`);
  if (btn)  btn.classList.add("active");
  if (pane) pane.classList.add("active");
}

/* ── 제출 현황 대시보드 ── */
async function loadAdminDashboard() {
  if (!isAdminLoggedIn()) { showToast("세션이 만료되었습니다. 다시 로그인하세요.", "warning"); exitAdmin(); return; }
  // ── section-header sticky 위치를 데이터 로드 전 즉시 보정 ──
  _fixStickyPositions();
  const wrap = document.getElementById("dashboardWrap");
  wrap.innerHTML = '<div class="admin-loading"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';
  hide("dashboardSummary");

  try {
    const data  = await gasGet({ action: "dashboard" });
    if (data.error) {
      wrap.innerHTML = `<div class="admin-error"><i class="fas fa-exclamation-circle"></i> ${escHtml(data.error)}</div>`;
      return;
    }

    const stats = data.stats || [];
    const grand = data.grand || { total: 0, submitted: 0, pending: 0 };

    _closedSet    = new Set();
    stats.forEach(c => {
      (c.tabs || []).forEach(t => {
        if (t.isClosed) {
          const key = (t.sheetId || "") + "||" + (t.tab || "");
          _closedSet.add(key);
        }
      });
    });
    // ★ 마감탭 Set (인덱스에서 제외된 항목도 포함)
    (data.closedTabs || []).forEach(t => {
      const key = (t.sheetId || "") + "||" + (t.tab || "");
      _closedSet.add(key);
    });

    if (data.indexBuiltAt) {
      document.getElementById("dashboardIndexInfo").textContent = "인덱스 기준: " + data.indexBuiltAt;
    }

    // ★ 자동 빌드 카운트다운 + 빌드 진행 중 배너
    if (typeof _startCronCountdown === 'function') _startCronCountdown(data.cron, data.buildLock);

    const rate = grand.total > 0 ? Math.round(grand.submitted / grand.total * 100) : 0;
    document.getElementById("sumTotal").textContent   = grand.total.toLocaleString();
    document.getElementById("sumDone").textContent    = grand.submitted.toLocaleString();
    document.getElementById("sumPending").textContent = grand.pending.toLocaleString();
    document.getElementById("sumRate").textContent    = rate + "%";
    show("dashboardSummary");

    if (!stats.length) {
      wrap.innerHTML = '<div class="admin-empty"><i class="fas fa-inbox"></i><p>데이터가 없습니다</p></div>';
      return;
    }

    wrap.innerHTML = "";

    // ── 컬럼 헤더: wrap 직속 (scrollOuter 밖) → sticky 정상 동작 ──
    const colHeader = document.createElement("div");
    colHeader.id = "dashColHeader";
    colHeader.className = "dash-col-header";
    _buildColHeader(colHeader);
    wrap.appendChild(colHeader);

    // ── 가로 스크롤 래퍼 (캠페인 블록만 포함) ──
    const scrollOuter1 = document.createElement("div");
    scrollOuter1.id = "dashboardScrollOuter";
    const scrollInner1 = document.createElement("div");
    scrollInner1.id = "dashboardScrollInner";
    scrollOuter1.appendChild(scrollInner1);
    wrap.appendChild(scrollOuter1);

    stats.forEach((c, ci) => {
      const cRate    = c.total > 0 ? Math.round(c.submitted / c.total * 100) : 0;
      const tableId  = `dct-${ci}`;
      const block    = document.createElement("div");
      // 마감업체 조건: 모든 탭이 완료(pending===0) 또는 마감(isClosed)인 경우
      const isCampDone = c.closedOnly === true || (c.tabs.length > 0 && c.tabs.every(t => {
        const key = (t.sheetId||"")+"||"+(t.tab||"");
        return _closedSet.has(key) || (t.total > 0 && t.pending === 0);
      }));
      // 마감 탭 포함 여부
      const hasClosed = c.closedOnly === true || c.tabs.some(t => _closedSet.has((t.sheetId||"")+"||"+(t.tab||"")));
      block.className  = "dash-campaign-block" + (isCampDone ? " camp-all-done" : "") + (hasClosed ? " camp-has-closed" : "");

      const campSheetId = (c.tabs[0] && c.tabs[0].sheetId) ? c.tabs[0].sheetId : "";
      const header = document.createElement("div");
      header.className = "dash-campaign-header";
      header.innerHTML = `
        <div class="dash-campaign-left">
          <i class="fas fa-chevron-down dash-toggle-icon"></i>
          ${campSheetId ? `<button class="btn-camp-refresh" data-sheetid="${escHtml(campSheetId)}" data-campname="${escHtml(c.campaign)}" onclick="event.stopPropagation();refreshCampaignIndex(this)" title="이 캠페인만 동기화"><i class="fas fa-sync-alt"></i> 갱신</button>` : ""}
          <span class="dash-campaign-name">${escHtml(c.campaign)}</span>
        </div>
        <span class="dash-campaign-total">${c.submitted}/${c.total} (${cRate}%)</span>`;
      header.addEventListener("click", () => toggleDashTab(tableId, header));

      const table = document.createElement("div");
      table.id        = tableId;
      table.className = "dash-tab-table collapsed";

      c.tabs.forEach(t => {
        const tRate     = t.total > 0 ? Math.round(t.submitted / t.total * 100) : 0;
        const tabKey    = (t.sheetId || "") + "||" + (t.tab || "");
        const isClosedTab = _closedSet.has(tabKey);
        const isTabDone = (t.total > 0 && t.pending === 0);
        const row       = document.createElement("div");
        row.className   = "dash-tab-row"
          + (isTabDone   ? " tab-done" : "")
          + (isClosedTab ? " is-closed-row" : "");
        row.dataset.tabkey = tabKey;

        const _tabSheetUrl = _buildTabUrl(t.sheetUrl, t.sheetId, t.tabGid);
        const tabNameHtml = _tabSheetUrl
          ? `<a class="dash-tab-link" href="${escHtml(_tabSheetUrl)}" target="_blank" title="${escHtml(_tabSheetUrl)}">${escHtml(t.tab)} <i class="fas fa-external-link-alt dash-tab-ext"></i></a>`
          : `<span>${escHtml(t.tab)}</span>`;

        // 시작일 배지
        const startDateHtml = t.startDate
          ? `<span class="tab-start-date"><i class="fas fa-calendar-day"></i> ${escHtml(t.startDate)}</span>`
          : "";
        const tuip    = t.tuip    || 0;
        const chuihap = t.chuihap || 0;

        // 상태 오버레이 HTML 생성 헬퍼
        const total = t.total || 0;
        // 상태 셀: 마감 > 완료 > 투입중/취합중(동시가능) > 없음
        let stateHtml = "";
        if (isClosedTab) {
          stateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
        } else if (isTabDone) {
          stateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
        } else if (tuip > 0 || chuihap > 0) {
          const leftHtml  = tuip    > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${tuip}/${total}</span>`       : `<span class="bar-lbl-left"></span>`;
          const rightHtml = chuihap > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${chuihap}/${total}</span>` : `<span class="bar-lbl-right"></span>`;
          stateHtml = leftHtml + rightHtml;
        }

        // 탭설정 데이터 (data-tc 속성으로 전달 → onclick 이스케이프 문제 방지)
        const tcData = { sheetId: t.sheetId, sheetUrl: t.sheetUrl || "", tabName: t.tab,
          manager: t.manager||"", timeRange: t.timeRange||"",
          taekhap: t.taekhap||false, reviewType: t.reviewType||"",
          paymentType: t.paymentType||"", displayName: t.displayName||"",
          isBulk: t.isBulk||false };
        const tcAttr = escHtml(JSON.stringify(tcData));

        // ★ 차수 렌더링:
        //   - roundList 1개 이상 → 각 차수마다 독립 행 (탭명 동일, 차수 배지만 다름)
        //   - roundList 없음     → 단독 행 1개 ("단독" 배지)
        if (t.roundList && t.roundList.length >= 1) {
          t.roundList.forEach(rd => {
            const rdRow = document.createElement("div");
            const rdDone = (rd.total > 0 && rd.pending === 0);
            rdRow.className = "dash-tab-row" + (rdDone ? " tab-done" : "") + (isClosedTab ? " is-closed-row" : "");
            rdRow.dataset.tabkey = tabKey;
            const rdRate = rd.total > 0 ? Math.round(rd.submitted / rd.total * 100) : 0;
            // 차수별 시작일: rd.startDate 우선, 없으면 탭 전체 startDate
            const rdStartDate = rd.startDate || t.startDate || "";
            const rdStartDateHtml = rdStartDate
              ? `<span class="tab-start-date"><i class="fas fa-calendar-day"></i> ${escHtml(rdStartDate)}</span>`
              : "";
            let rdStateHtml = "";
            if (isClosedTab) {
              rdStateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
            } else if (rdDone) {
              rdStateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
            } else if ((rd.tuip||0) > 0 || (rd.chuihap||0) > 0) {
              const rdTotal = rd.total || 0;
              const rdLeftHtml  = (rd.tuip||0)    > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${rd.tuip}/${rdTotal}</span>`          : `<span class="bar-lbl-left"></span>`;
              const rdRightHtml = (rd.chuihap||0) > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${rd.chuihap}/${rdTotal}</span>` : `<span class="bar-lbl-right"></span>`;
              rdStateHtml = rdLeftHtml + rdRightHtml;
            }
            const tRd = Object.assign({}, t, { submitted: rd.submitted, total: rd.total, pending: rd.pending, noRecipient: t.noRecipient, tuip: rd.tuip||0, chuihap: rd.chuihap||0 });
            rdRow.dataset.state = _rowState(isClosedTab, rdDone, rd.tuip||0, rd.chuihap||0);
            rdRow.innerHTML = _buildTabRowHtml(tRd, tabKey, isClosedTab, tabNameHtml, rdStartDateHtml, rdRate, rdStateHtml, tcAttr, rd.round);
            table.appendChild(rdRow);
          });
        } else {
          row.dataset.state = _rowState(isClosedTab, isTabDone, tuip, chuihap);
          row.innerHTML = _buildTabRowHtml(t, tabKey, isClosedTab, tabNameHtml, startDateHtml, tRate, stateHtml, tcAttr, null);
          table.appendChild(row);
        }

        if (t.hasMonthly) {
          const tRate2     = t.total2 > 0 ? Math.round(t.submitted2 / t.total2 * 100) : 0;
          const isTab2Done = t.total2 > 0 && t.pending2 === 0;
          const row2       = document.createElement("div");
          row2.className   = "dash-tab-row dash-tab-row-monthly" + (isTab2Done ? " tab-done" : "");
          row2.innerHTML   = `
            <div class="closed-cb-wrap"></div>
            <div class="dash-tab-name dash-tab-name-monthly"><i class="fas fa-calendar-alt"></i> 한달리뷰</div>
            <div></div>
            <div></div>
            <div></div>
            <div class="dash-tab-date-col"></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div class="dash-tab-bar-col">
              ${(t.noRecipient || t.total2 === 0)
                ? `<span class="bar-no-recipient" title="시트에 수취인 컬럼이 없거나 데이터가 없어 진행률을 계산할 수 없습니다"><i class="fas fa-exclamation-triangle"></i>수취인헤더없음</span>`
                : (() => {
                    const barClass2 = tRate2 === 100 ? 'bar-full' : tRate2 >= 50 ? 'bar-half' : 'bar-low';
                    const stateHtml2 = isTab2Done ? `<span class="bar-lbl-center">✓ 완료</span>` : '';
                    const lblClass2  = isTab2Done ? 'bar-label-done' : 'bar-label-dark';
                    return `${stateHtml2 ? `<span class="bar-label ${lblClass2} bar-label-center">${stateHtml2}</span>` : ''}
                            <div class="dash-tab-bar-wrap"><div class="dash-tab-bar ${barClass2}" style="width:${tRate2}%"></div></div>`;
                  })()
              }
            </div>
            <div class="dash-tab-nums">
              ${(t.noRecipient || t.total2 === 0)
                ? `<span style="color:#D1D5DB;font-size:.65rem">—</span>`
                : `<span class="dash-done">${t.submitted2}</span><span class="dash-sep">/</span><span class="dash-total">${t.total2}</span>`
              }
            </div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>`;
          table.appendChild(row2);
        }
      });

      block.appendChild(header);
      block.appendChild(table);
      scrollInner1.appendChild(block);
    });

    if (hideDoneMode) wrap.classList.add("hide-done-mode");
    else              wrap.classList.remove("hide-done-mode");
    if (hideClosedCampMode) wrap.classList.add("hide-closed-camp-mode");
    else                    wrap.classList.remove("hide-closed-camp-mode");
    if (hideClosedTabMode)  wrap.classList.add("hide-closed-tab-mode");
    else                    wrap.classList.remove("hide-closed-tab-mode");

    // 마감 모드가 켜져 있었다면 유지
    if (_closedMode)    wrap.classList.add("closed-mode");

    // 필터가 활성화된 경우 재적용
    if (activeFilters.size > 0) applyDashFilter();

    _fixStickyPositions();
    _bindScrollSync();
    _closeColResizePopup();
    _syncTabnameWidth(); // 렌더 완료 후 컨테이너 너비 확정 → tabname 재계산
    loadColWidths();    // ★ 렌더 후 저장된 컬럼 너비 재적용 (DOM 재빌드 시 인라인 스타일 유지)
    _lastDashData = data;

  } catch (err) {
    wrap.innerHTML = `<div class="admin-error"><i class="fas fa-exclamation-circle"></i> ${escHtml(err.message)}</div>`;
  }
}

/**
 * ★ v11.2: 탭 URL 구성 헬퍼
 * sheetUrl(또는 sheetId)에 tabGid를 항상 반영하여 정확한 탭 URL을 반환한다.
 */
function _buildTabUrl(sheetUrl, sheetId, tabGid) {
  let baseUrl = sheetUrl
    ? sheetUrl.split('#')[0].split('?')[0]
    : (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '');
  if (!baseUrl) return '';
  if (tabGid) {
    baseUrl += `#gid=${tabGid}`;
  }
  return baseUrl;
}

// 대시보드 렌더링 (외부에서 data를 직접 넘겨 재렌더링 가능)
function renderDashboard(data) {
  const wrap  = document.getElementById("dashboardWrap");
  const stats = data.stats || [];
  const grand = data.grand || { total: 0, submitted: 0, pending: 0 };
  const rate  = grand.total > 0 ? Math.round(grand.submitted / grand.total * 100) : 0;
  document.getElementById("sumTotal").textContent   = grand.total.toLocaleString();
  document.getElementById("sumDone").textContent    = grand.submitted.toLocaleString();
  document.getElementById("sumPending").textContent = grand.pending.toLocaleString();
  document.getElementById("sumRate").textContent    = rate + "%";
  show("dashboardSummary");
  if (!stats.length) {
    wrap.innerHTML = '<div class="admin-empty"><i class="fas fa-inbox"></i><p>데이터가 없습니다</p></div>';
    return;
  }
  // 기존 렌더링 로직 재사용: loadAdminDashboard의 render 부분을 그대로 실행
  // stats를 직접 주입해 재렌더링
  wrap.innerHTML = "";

  // ── 컬럼 헤더: wrap 직속 (scrollOuter 밖) → sticky 정상 동작 ──
  const colHdr = document.createElement("div");
  colHdr.id = "dashColHeader";
  colHdr.className = "dash-col-header";
  _buildColHeader(colHdr);
  wrap.appendChild(colHdr);

  // ── 가로 스크롤 래퍼 (캠페인 블록만 포함) ──
  const scrollOuter2 = document.createElement("div");
  scrollOuter2.id = "dashboardScrollOuter";
  const scrollInner2 = document.createElement("div");
  scrollInner2.id = "dashboardScrollInner";
  scrollOuter2.appendChild(scrollInner2);
  wrap.appendChild(scrollOuter2);

  stats.forEach((c, ci) => {
    const cRate    = c.total > 0 ? Math.round(c.submitted / c.total * 100) : 0;
    const tableId  = `dct-r-${ci}`;
    const block    = document.createElement("div");
    // 완료 업체 재계산
    const allDone      = c.closedOnly === true || c.tabs.every(t => {
      const key = (t.sheetId||"")+"||"+(t.tab||"");
      return _closedSet.has(key) || (t.total > 0 && t.pending === 0);
    });
    const hasClosed = c.closedOnly === true || c.tabs.some(t => _closedSet.has((t.sheetId||"")+"||"+(t.tab||"")));
    block.className = "dash-campaign-block" + (allDone ? " camp-all-done" : "") + (hasClosed ? " camp-has-closed" : "");
    const campSheetId2 = (c.tabs[0] && c.tabs[0].sheetId) ? c.tabs[0].sheetId : "";
    const header = document.createElement("div");
    header.className = "dash-campaign-header";
    header.innerHTML = `
      <div class="dash-campaign-left">
        <i class="fas fa-chevron-down dash-toggle-icon"></i>
        ${campSheetId2 ? `<button class="btn-camp-refresh" data-sheetid="${escHtml(campSheetId2)}" data-campname="${escHtml(c.campaign)}" onclick="event.stopPropagation();refreshCampaignIndex(this)" title="이 캠페인만 동기화"><i class="fas fa-sync-alt"></i> 갱신</button>` : ""}
        <span class="dash-campaign-name">${escHtml(c.campaign)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span class="dash-campaign-total">${c.submitted}/${c.total} (${cRate}%)</span>
      </div>`;
    header.addEventListener("click", () => toggleDashTab(tableId, header));
    const table = document.createElement("div");
    table.id        = tableId;
    table.className = "dash-tab-table collapsed";
    c.tabs.forEach(t => {
      const tRate      = t.total > 0 ? Math.round(t.submitted / t.total * 100) : 0;
      const tabKey     = (t.sheetId||"")+"||"+(t.tab||"");
      const isClosedTab = _closedSet.has(tabKey);
      const isTabDone  = (t.total > 0 && t.pending === 0);
      const row        = document.createElement("div");
      row.className    = "dash-tab-row"+(isTabDone?" tab-done":"")+(isClosedTab?" is-closed-row":"");
      row.dataset.tabkey = tabKey;
      const _tabSheetUrl2 = _buildTabUrl(t.sheetUrl, t.sheetId, t.tabGid);
      const tabNameHtml = _tabSheetUrl2
        ? `<a class="dash-tab-link" href="${escHtml(_tabSheetUrl2)}" target="_blank" title="${escHtml(_tabSheetUrl2)}">${escHtml(t.tab)} <i class="fas fa-external-link-alt dash-tab-ext"></i></a>`
        : `<span>${escHtml(t.tab)}</span>`;
      const startDateHtml = t.startDate
        ? `<span class="tab-start-date"><i class="fas fa-calendar-day"></i> ${escHtml(t.startDate)}</span>` : "";
      const tuip = t.tuip||0, chuihap = t.chuihap||0;
      let stateHtml = "";
      if (isClosedTab)  stateHtml = `<span class="dash-pending-badge badge-done" style="background:#EEF2FF;color:#3730A3;border-color:#C7D2FE">⬛ 마감</span>`;
      else if (isTabDone) stateHtml = `<span class="dash-pending-badge badge-done">✓ 완료</span>`;
      else if (tuip>0) stateHtml = `<span class="work-badge badge-tuip"><i class="fas fa-user-plus"></i> 투입중 ${tuip}</span>`;
      else if (chuihap>0) stateHtml = `<span class="work-badge badge-chuihap"><i class="fas fa-layer-group"></i> 취합중 ${chuihap}</span>`;
      const tcData = { sheetId:t.sheetId, sheetUrl:t.sheetUrl||"", tabName:t.tab,
        manager:t.manager||"", timeRange:t.timeRange||"", taekhap:t.taekhap||false,
        reviewType:t.reviewType||"", paymentType:t.paymentType||"", displayName:t.displayName||"",
        isBulk:t.isBulk||false };
      const tcAttr = escHtml(JSON.stringify(tcData));

      // ★ 차수별 독립 행 렌더링
      if (t.roundList && t.roundList.length >= 1) {
        t.roundList.forEach(rd => {
          const rdRow = document.createElement("div");
          const rdDone = (rd.total > 0 && rd.pending === 0);
          rdRow.className = "dash-tab-row"+(rdDone?" tab-done":"")+(isClosedTab?" is-closed-row":"");
          rdRow.dataset.tabkey = tabKey;
          const rdRate = rd.total > 0 ? Math.round(rd.submitted / rd.total * 100) : 0;
          const rdStartDate = rd.startDate || t.startDate || "";
          const rdStartDateHtml = rdStartDate
            ? `<span class="tab-start-date"><i class="fas fa-calendar-day"></i> ${escHtml(rdStartDate)}</span>`
            : "";
          let rdStateHtml = "";
          if (isClosedTab)      rdStateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
          else if (rdDone)      rdStateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
          else if ((rd.tuip||0) > 0 || (rd.chuihap||0) > 0) {
            const rdTotal2 = rd.total || 0;
            const rdLeft  = (rd.tuip||0)    > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${rd.tuip}/${rdTotal2}</span>`          : `<span class="bar-lbl-left"></span>`;
            const rdRight = (rd.chuihap||0) > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${rd.chuihap}/${rdTotal2}</span>` : `<span class="bar-lbl-right"></span>`;
            rdStateHtml = rdLeft + rdRight;
          }
          const tRd = Object.assign({}, t, { submitted: rd.submitted, total: rd.total, pending: rd.pending, tuip: rd.tuip||0, chuihap: rd.chuihap||0 });
          rdRow.dataset.state = _rowState(isClosedTab, rdDone, rd.tuip||0, rd.chuihap||0);
          rdRow.innerHTML = _buildTabRowHtml(tRd, tabKey, isClosedTab, tabNameHtml, rdStartDateHtml, rdRate, rdStateHtml, tcAttr, rd.round);
          table.appendChild(rdRow);
        });
      } else {
        row.dataset.state = _rowState(isClosedTab, isTabDone, tuip, chuihap);
        row.innerHTML = _buildTabRowHtml(t, tabKey, isClosedTab, tabNameHtml, startDateHtml, tRate, stateHtml, tcAttr, null);
        table.appendChild(row);
      }
    });
    block.appendChild(header);
    block.appendChild(table);
    scrollInner2.appendChild(block);
  });
  if (hideDoneMode) wrap.classList.add("hide-done-mode");
  else wrap.classList.remove("hide-done-mode");
  if (hideClosedCampMode) wrap.classList.add("hide-closed-camp-mode");
  else                    wrap.classList.remove("hide-closed-camp-mode");
  if (hideClosedTabMode)  wrap.classList.add("hide-closed-tab-mode");
  else                    wrap.classList.remove("hide-closed-tab-mode");
  if (_closedMode)        wrap.classList.add("closed-mode");
  if (activeFilters.size > 0) applyDashFilter();
  _fixStickyPositions();
  _bindScrollSync();
  _closeColResizePopup();
  _syncTabnameWidth(); // 렌더 완료 후 tabname 재계산
  loadColWidths();    // ★ 렌더 후 저장된 컬럼 너비 재적용
}

// ═══════════════════════════════════════════════════════
// 탭 행 HTML 빌더 (loadAdminDashboard + renderDashboard 공용)
// 열 순서: 체크박스 | 탭명 | 시작일 | 상품명 | 주문시간대 | 리뷰타입 | 담당자 | 진행률 | 리뷰 | 상태 | 입금방식 | 택대 | +정보
// ═══════════════════════════════════════════════════════
// ★ roundLabel: 차수 배지 HTML (호출 시 전달 — "단독" 또는 "1차" 등)
function _buildTabRowHtml(t, tabKey, isClosedTab, tabNameHtml, startDateHtml, tRate, stateHtml, tcAttr, roundLabel) {
  // 각 열 셀 값 (없으면 회색 dash)
  const empty = `<span style="color:#D1D5DB;font-size:.65rem">—</span>`;

  // ── qe(빠른입력) 셀 래퍼 생성 헬퍼 ──
  function qeWrap(field, hasValue, inner, extraStyle) {
    const base = `overflow:hidden;min-width:0;padding:0 3px;display:flex;align-items:center;${extraStyle||''}`;
    if (hasValue) {
      return `<div class="qe-cell-filled" style="${base}" title="${field} 수정은 [+정보] 버튼을 이용해주세요">${inner}</div>`;
    }
    return `<div class="qe-cell" style="${base}" data-field="${field}" data-tabkey="${escHtml(tabKey)}" data-tc="${tcAttr}" onclick="quickEditCell(event,this)" title="클릭하여 ${field} 입력">${inner}</div>`;
  }

  // 상품명 열
  const nameCell = t.displayName
    ? `<span class="dash-cell-name" title="${escHtml(t.displayName)}">${escHtml(t.displayName)}</span>`
    : empty;

  // 주문시간대 열
  const timeCell = t.timeRange
    ? `<span class="dash-cell-time">${escHtml(t.timeRange)}</span>`
    : empty;

  // 리뷰타입 열
  const reviewClass = {
    '실배송': 'tc-review-실배송',
    '빈박스': 'tc-review-빈박스',
    '구매확정': 'tc-review-구매확정',
    '믹스': 'tc-review-믹스'
  }[t.reviewType] || '';
  const reviewCell = t.reviewType
    ? `<span class="tc-badge ${reviewClass}" style="font-size:.65rem">${escHtml(t.reviewType)}</span>`
    : empty;

  // 담당자 열
  const managerClass = t.manager === '만두' ? 'tc-mandu' : t.manager === '망고' ? 'tc-mango' : '';
  const managerCell = t.manager
    ? `<span class="tc-badge ${managerClass}" style="font-size:.65rem">${escHtml(t.manager)}</span>`
    : empty;

  // 입금방식 열
  const paymentClass = t.paymentType === '인애드' ? 'tc-payment-인애드' : t.paymentType === '업체' ? 'tc-payment-업체' : '';
  const paymentCell = t.paymentType
    ? `<span class="tc-badge ${paymentClass}" style="font-size:.64rem">${escHtml(t.paymentType)}</span>`
    : empty;

  // 택대 열
  const taekhapCell = t.taekhap
    ? `<span class="tc-badge tc-taekhap-on" style="font-size:.63rem">✔ 택대</span>`
    : empty;

  // 캡처폴더 열
  const captureFolderCell = t.captureFolderUrl
    ? `<a class="dash-folder-link" style="color:#7C3AED;background:#F5F3FF;border-color:#DDD6FE" href="${escHtml(t.captureFolderUrl)}" target="_blank" onclick="event.stopPropagation()"><i class="fas fa-camera"></i> 캡처폴더</a>`
    : `<span style="color:#D1D5DB;font-size:.6rem">—</span>`;

  // 리뷰폴더 열 (대량건 뱃지 포함)
  const bulkBadge = t.isBulk
    ? `<span class="tc-badge tc-bulk-badge" style="font-size:.6rem;margin-right:3px">대량건</span>`
    : "";
  const folderCell = t.folderUrl
    ? `${bulkBadge}<a class="dash-folder-link" href="${escHtml(t.folderUrl)}" target="_blank" onclick="event.stopPropagation()"><i class="fas fa-folder-open"></i> 리뷰폴더</a>`
    : bulkBadge || `<span style="color:#D1D5DB;font-size:.6rem">—</span>`;

  // 차수 열: 호출 시 전달된 roundLabel 사용 (없으면 "단독")
  const roundBadgeHtml = roundLabel
    ? `<span class="dash-round-col-badge badge-nth">${escHtml(roundLabel)}</span>`
    : `<span class="dash-round-col-badge badge-solo">단독</span>`;
  const roundColHtml = `<div style="display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 2px">${roundBadgeHtml}</div>`;

  // 비고 열 (localStorage 기반)
  const memoVal = _getTabMemo(tabKey);
  const memoInner = memoVal
    ? `<span class="dash-cell-memo" title="${escHtml(memoVal)}">${escHtml(memoVal)}</span>`
    : empty;

  return `
    <div class="closed-cb-wrap">
      <input type="checkbox" class="closed-cb" data-tabkey="${escHtml(tabKey)}" ${isClosedTab ? "checked" : ""} onclick="event.stopPropagation()">
    </div>
    <div class="dash-tab-name">${tabNameHtml}</div>
    <div style="display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;padding:0 2px">${captureFolderCell}</div>
    <div style="display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;padding:0 2px">${folderCell}</div>
    ${roundColHtml}
    <div class="dash-tab-date-col">${startDateHtml}</div>
    ${qeWrap('상품명', !!t.displayName, nameCell)}
    ${t.timeRange
      ? `<div class="qe-cell" style="overflow:hidden;min-width:0;padding:0 3px;display:flex;align-items:center" data-field="주문시간대" data-tabkey="${escHtml(tabKey)}" data-tc="${tcAttr}" onclick="quickEditCell(event,this)" title="클릭하여 주문시간대 수정">${timeCell}</div>`
      : qeWrap('주문시간대', false, timeCell)}
    ${qeWrap('리뷰타입', !!t.reviewType, reviewCell)}
    <div style="display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 2px">
      <button class="form-link-btn" data-tc="${tcAttr}" onclick="event.stopPropagation();openFormLink(this)" title="구매양식 링크 열기"><i class="fas fa-external-link-alt"></i></button>
    </div>
    ${qeWrap('담당자', !!t.manager, managerCell, 'justify-content:center')}
    <div class="dash-tab-bar-col">
      ${(t.noRecipient || t.total === 0)
        ? `<span class="bar-no-recipient" title="시트에 수취인 컬럼이 없거나 데이터가 없어 진행률을 계산할 수 없습니다"><i class="fas fa-exclamation-triangle"></i>수취인헤더없음</span>`
        : (() => {
            const isCenterState = stateHtml.includes('bar-lbl-center');
            const centerCls = isCenterState ? ' bar-label-center' : '';
            const total = t.total || 0;
            const tuip    = t.tuip    || 0;
            const chuihap = t.chuihap || 0;
            const tuipRate    = (tuip    > 0 && total > 0) ? Math.min(100, Math.round(tuip    / total * 100)) : 0;
            const chuihapRate = (chuihap > 0 && total > 0) ? Math.min(100, Math.round(chuihap / total * 100)) : 0;
            const hasDual = tuipRate > 0 && chuihapRate > 0;
            const hasTuipOnly    = tuipRate > 0 && chuihapRate === 0;
            const hasChuihapOnly = chuihapRate > 0 && tuipRate === 0;
            // 텍스트 색상: 투입중=노랑계, 취합중=보라계, 완료=초록계
            let lblClass;
            if (isCenterState) {
              lblClass = tRate === 100 ? 'bar-label-done' : 'bar-label-dark';
            } else if (hasDual || hasChuihapOnly) {
              lblClass = 'bar-label-light'; // 보라색 계열
            } else if (hasTuipOnly) {
              lblClass = 'bar-label-dark';  // 노란색 계열
            } else {
              lblClass = tRate >= 50 ? 'bar-label-light' : 'bar-label-dark';
            }
            // 레이어 구성
            let layers = '';
            if (hasDual) {
              layers = `<div class="bar-layer-tuip" style="width:${tuipRate}%"></div>
                        <div class="bar-layer-chuihap" style="width:${chuihapRate}%"></div>`;
            } else if (hasTuipOnly) {
              layers = `<div class="bar-layer-tuip" style="width:${tuipRate}%"></div>`;
            } else if (hasChuihapOnly) {
              layers = `<div class="bar-layer-chuihap" style="width:${chuihapRate}%"></div>`;
            } else {
              const barClass = tRate === 100 ? 'bar-full' : tRate >= 50 ? 'bar-half' : 'bar-low';
              layers = `<div class="dash-tab-bar ${barClass}" style="width:${tRate}%"></div>`;
            }
            // 게이지 바 (좁게) + 텍스트 레이블 (바 밖, 위쪽에 배치)
            return `${stateHtml ? `<span class="bar-label ${lblClass}${centerCls}">${stateHtml}</span>` : ''}
                    <div class="dash-tab-bar-wrap">${layers}</div>`;
          })()
      }
    </div>
    <div class="dash-tab-nums">
      ${(t.noRecipient || t.total === 0)
        ? `<span style="color:#D1D5DB;font-size:.65rem">—</span>`
        : `<span class="dash-done">${t.submitted}</span><span class="dash-sep">/</span><span class="dash-total">${t.total}</span>`
      }
    </div>

    ${qeWrap('입금방식', !!t.paymentType, paymentCell, 'justify-content:center')}
    ${qeWrap('택대', t.taekhap === true, taekhapCell, 'justify-content:center')}
    <div class="qe-cell" style="overflow:hidden;min-width:0;padding:0 3px;display:flex;align-items:center" data-field="비고" data-tabkey="${escHtml(tabKey)}" data-tc="${tcAttr}" onclick="quickEditCell(event,this)" title="${memoVal ? '비고 수정' : '비고 입력'}">${memoInner}</div>
    <div style="display:flex;align-items:center;justify-content:center">
      <button class="tc-info-btn tc-clickable" data-tc="${tcAttr}" title="일괄 정보 입력·수정">+정보</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════
// 컬럼 리사이즈 시스템
// ═══════════════════════════════════════════════════════

/** 컬럼 정의 (index 0=마감CB, 1=탭명, ... 18=⚙)
 *  closedcb: 기본 0px, 모드 진입 시 JS에서 28px로 전환
 */
const DASH_COL_DEFS = [
  { key: 'closedcb', varName: '--dc-closedcb', label: '마감',       minPx: 20,  default: 0,  isCb: true       },
  { key: 'tabname',  varName: '--dc-tabname',  label: '탭명',       minPx: 60,  default: 120                 },
  { key: 'capture',  varName: '--dc-capture',  label: '캡처폴더',   minPx: 40,  default: 70                  },
  { key: 'folder',   varName: '--dc-folder',   label: '리뷰폴더',   minPx: 40,  default: 70                  },
  { key: 'round',    varName: '--dc-round',    label: '차수',       minPx: 28,  default: 70                  },
  { key: 'date',     varName: '--dc-date',     label: '시작일',     minPx: 40,  default: 70                  },
  { key: 'product',  varName: '--dc-product',  label: '상품명',     minPx: 60,  default: 70                  },
  { key: 'time',     varName: '--dc-time',     label: '주문시간대', minPx: 50,  default: 70                  },
  { key: 'review',   varName: '--dc-review',   label: '리뷰타입',   minPx: 40,  default: 70                  },
  { key: 'formlink', varName: '--dc-formlink', label: '폼링크',     minPx: 28,  default: 70                  },
  { key: 'manager',  varName: '--dc-manager',  label: '담당',       minPx: 28,  default: 70                  },
  { key: 'bar',      varName: '--dc-bar',      label: '진행률',     minPx: 80,  default: 70                  },
  { key: 'nums',     varName: '--dc-nums',     label: '리뷰',       minPx: 40,  default: 70                  },
  { key: 'payment',  varName: '--dc-payment',  label: '입금',       minPx: 28,  default: 70                  },
  { key: 'taekhap',  varName: '--dc-taekhap',  label: '택대',       minPx: 28,  default: 70                  },
  { key: 'memo',     varName: '--dc-memo',     label: '비고',       minPx: 40,  default: 70                  },
  { key: 'info',     varName: '--dc-info',     label: '⚙',         minPx: 28,  default: 70                  },
];
const COL_WIDTH_LS_KEY = 'dashColWidths_v1';

/** 컨테이너 안쪽 너비 반환 - dashboardScrollOuter 기준 (스크롤 컨테이너) */
function _getContainerWidth() {
  const outer = document.getElementById('dashboardScrollOuter');
  if (outer) {
    const w = outer.getBoundingClientRect().width;
    if (w > 0) return w;
  }
  const pane = document.querySelector('.admin-tab-pane.active');
  if (pane) {
    const w = pane.getBoundingClientRect().width;
    if (w > 0) return w - 32;
  }
  const body = document.querySelector('.admin-body');
  if (body) {
    const w = body.getBoundingClientRect().width;
    if (w > 0) return w - 48;
  }
  return window.innerWidth - 80;
}

/** localStorage에서 저장된 너비 로드 후 CSS 변수 적용 (CB 컬럼 제외 - 모드 토글이 관리) */
function loadColWidths() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(COL_WIDTH_LS_KEY) || '{}'); } catch(_) {}
  const root = document.documentElement;
  let applied = 0;
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb) return; // CB 컬럼은 모드 토글이 관리
    const w = saved[col.key];
    if (w && Number.isFinite(w) && w >= col.minPx) {
      root.style.setProperty(col.varName, w + 'px');
      applied++;
    }
  });
  // 저장값이 없는 경우(최초 접속 등)에도 기본값은 CSS :root에 이미 정의되어 있으므로 무방
  return applied; // 디버그용
}

/** 현재 실제 적용 너비를 localStorage에 저장 (CB 컬럼 제외) */
function saveColWidths() {
  const data = {};
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb) return; // CB 컬럼은 저장 안 함
    // _getColWidth: inline style 우선, 없으면 computed style 폴백
    const w = _getColWidth(col);
    if (w && Number.isFinite(w) && w > 0) data[col.key] = w;
  });
  try { localStorage.setItem(COL_WIDTH_LS_KEY, JSON.stringify(data)); } catch(_) {}
}

/** (호환성 stub) */
function _updateDashMinWidth() {}
/** (호환성 stub - tabname 자동조정 방식 폐기) */
function _syncTabnameWidth() {}

/** 컬럼 너비를 기본값으로 초기화 (CB 컬럼 제외) */
function resetColWidths() {
  const root = document.documentElement;
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb) return; // CB 컬럼은 모드 토글이 관리
    root.style.removeProperty(col.varName);
  });
  try { localStorage.removeItem(COL_WIDTH_LS_KEY); } catch(_) {}
  _closeColResizePopup();
  showToast('컬럼 너비가 기본값으로 초기화되었습니다.');
}

/**
 * 컬럼 헤더 요소 빌드
 * DASH_COL_DEFS 인덱스: 0=closedcb, 1=tabname, 2=capture, ... 18=info
 * 데이터 행 child 인덱스도 동일 (0=closed-cb-wrap, 1=탭명, ...)
 */
function _buildColHeader(container) {
  // colIdx = DASH_COL_DEFS 인덱스와 1:1 대응
  const CELLS = [
    // isCb 컬럼: 평소 0px(숨김) → 모드 진입 시 28px
    { colIdx: 0,  inner: '<i class="fas fa-archive"      style="font-size:.6rem;color:#7C3AED"></i>',  style: 'justify-content:center', title: '마감 선택',    cbClass: 'closed-cb-wrap' },
    { colIdx: 1,  inner: '<i class="fas fa-tag" style="font-size:.55rem"></i> 탭명',              style: '' },
    { colIdx: 2,  inner: '<i class="fas fa-camera" style="font-size:.55rem;color:#7C3AED"></i> 캡처폴더', style: 'justify-content:center', title: '주문캡처 저장 폴더' },
    { colIdx: 3,  inner: '<i class="fas fa-folder" style="font-size:.55rem;color:#F59E0B"></i> 리뷰폴더',  style: 'justify-content:center', title: '리뷰 저장 폴더'    },
    { colIdx: 4,  inner: '<i class="fas fa-layer-group" style="font-size:.55rem;color:#4338CA"></i> 차수',  style: 'justify-content:center', title: '진행 차수'         },
    { colIdx: 5,  inner: '<i class="fas fa-calendar-day" style="font-size:.55rem"></i> 시작일',   style: '' },
    { colIdx: 6,  inner: '<i class="fas fa-box" style="font-size:.55rem"></i> 상품명',            style: '' },
    { colIdx: 7,  inner: '<i class="fas fa-clock" style="font-size:.55rem"></i> 주문시간대',      style: '' },
    { colIdx: 8,  inner: '<i class="fas fa-star" style="font-size:.55rem"></i> 리뷰타입',         style: '' },
    { colIdx: 9, inner: '<i class="fas fa-link" style="font-size:.55rem;color:#7C3AED"></i>',    style: 'justify-content:center', title: '구매양식 제출링크 생성' },
    { colIdx: 10, inner: '<i class="fas fa-user" style="font-size:.55rem"></i> 담당',             style: 'justify-content:center' },
    { colIdx: 11, inner: '<i class="fas fa-chart-bar" style="font-size:.55rem"></i> 진행률',      style: '' },
    { colIdx: 12, inner: '<i class="fas fa-check-double" style="font-size:.55rem"></i> 리뷰',     style: 'justify-content:flex-end' },
    { colIdx: 13, inner: '<i class="fas fa-won-sign" style="font-size:.55rem"></i> 입금',         style: 'justify-content:center' },
    { colIdx: 14, inner: '<i class="fas fa-truck" style="font-size:.55rem"></i> 택대',            style: 'justify-content:center' },
    { colIdx: 15, inner: '<i class="fas fa-sticky-note" style="font-size:.55rem;color:#F59E0B"></i> 비고', style: '' },
    { colIdx: 16, inner: '<i class="fas fa-cog" style="font-size:.55rem"></i>', style: 'justify-content:center', noResize: true },  // ⚙ 마지막
  ];

  container.innerHTML = '';

  CELLS.forEach(c => {
    const colDef = DASH_COL_DEFS[c.colIdx];
    const div = document.createElement('div');

    // CB 컬럼: 평소엔 숨겨진 래퍼 역할 + 드래그 조절 지원
    if (colDef && colDef.isCb) {
      div.className = 'dash-col-header-cell ' + (c.cbClass || '');
    } else {
      div.className = 'dash-col-header-cell';
    }

    if (c.style) div.setAttribute('style', c.style);
    if (c.title) div.title = c.title;
    div.innerHTML = c.inner;

    // ⚙(마지막) 제외 → 드래그 핸들 추가
    if (!c.noResize && colDef) {
      div.dataset.colKey = colDef.key;
      div.dataset.colIdx = c.colIdx;

      // 드래그 핸들 div (헤더 셀 우측 경계)
      const handle = document.createElement('div');
      handle.className = 'col-drag-handle';
      handle.title =
                     colDef.key === 'closedcb' ? '마감 체크박스 너비 조절' : '';
      handle.addEventListener('mousedown', _onColDragStart);
      handle.dataset.colKey = colDef.key;
      handle.dataset.colIdx = c.colIdx;
      div.appendChild(handle);
    }

    container.appendChild(div);
  });
}

/* ══════════════════════════════════════════════
   엑셀 스타일 컬럼 드래그 리사이즈 시스템
   ══════════════════════════════════════════════ */

/** 현재 컬럼 너비(px) 반환 - JS style 직접 설정값 우선, 없으면 CSS :root 기본값 */
function _getColWidth(colDef) {
  const inlineVal = document.documentElement.style.getPropertyValue(colDef.varName).trim();
  if (inlineVal && inlineVal.endsWith('px')) return parseInt(inlineVal);
  const cssVal = getComputedStyle(document.documentElement).getPropertyValue(colDef.varName).trim();
  if (cssVal && cssVal.endsWith('px')) return parseInt(cssVal);
  return colDef.default || 70;
}

// 드래그 상태 변수
let _dragColDef   = null;  // 현재 드래그 중인 컬럼 정의
let _dragStartX   = 0;     // 드래그 시작 X (pageX)
let _dragStartW   = 0;     // 드래그 시작 시점의 컬럼 너비
let _dragHandle   = null;  // 드래그 핸들 요소

const _tooltip = document.getElementById('colDragTooltip');
const _dragLine = document.getElementById('colDragLine');

/** 드래그 시작 */
function _onColDragStart(e) {
  if (e.button !== 0) return; // 좌클릭만
  e.preventDefault();
  e.stopPropagation();

  const key = e.currentTarget.dataset.colKey;
  const colDef = DASH_COL_DEFS.find(d => d.key === key);
  if (!colDef) return;

  // CB 컬럼이 0px(비활성)이면 드래그 불가
  if (colDef.isCb && _getColWidth(colDef) === 0) {
    showToast('마감 모드 진입 후 너비를 조절할 수 있습니다.');
    return;
  }

  _dragColDef  = colDef;
  _dragStartX  = e.pageX;
  _dragStartW  = _getColWidth(colDef);
  _dragHandle  = e.currentTarget;

  // 핸들 강조
  _dragHandle.classList.add('dragging');
  // 헤더 셀 강조
  const headerCell = _dragHandle.closest('.dash-col-header-cell');
  if (headerCell) headerCell.classList.add('col-drag-active');

  // 드래그 중 커서 고정
  document.body.classList.add('col-resizing');

  // 수직 가이드라인 표시
  if (_dragLine) {
    _dragLine.style.left  = e.clientX + 'px';
    _dragLine.style.display = 'block';
  }

  // 툴팁 표시
  if (_tooltip) {
    _tooltip.textContent = _dragStartW + 'px';
    _tooltip.style.left  = e.clientX + 'px';
    _tooltip.style.top   = e.clientY + 'px';
    _tooltip.style.display = 'block';
  }

  document.addEventListener('mousemove', _onColDragMove);
  document.addEventListener('mouseup',   _onColDragEnd);
}

/** 드래그 이동 */
function _onColDragMove(e) {
  if (!_dragColDef) return;

  const delta  = e.pageX - _dragStartX;
  let newW     = Math.max(_dragColDef.minPx, _dragStartW + delta);

  // 수직 가이드라인 이동
  if (_dragLine) _dragLine.style.left = e.clientX + 'px';

  // 툴팁 업데이트
  if (_tooltip) {
    _tooltip.textContent = newW + 'px';
    _tooltip.style.left  = e.clientX + 'px';
    _tooltip.style.top   = e.clientY + 'px';
  }

  // 실시간 CSS 변수 업데이트
  document.documentElement.style.setProperty(_dragColDef.varName, newW + 'px');
}

/** 드래그 종료 */
function _onColDragEnd(e) {
  if (!_dragColDef) return;

  const delta  = e.pageX - _dragStartX;
  let newW     = Math.max(_dragColDef.minPx, _dragStartW + delta);

  // 최종 너비 적용 & 저장
  document.documentElement.style.setProperty(_dragColDef.varName, newW + 'px');
  saveColWidths();

  // 정리
  if (_dragHandle) _dragHandle.classList.remove('dragging');
  document.querySelectorAll('.dash-col-header-cell.col-drag-active')
    .forEach(c => c.classList.remove('col-drag-active'));

  document.body.classList.remove('col-resizing');
  if (_dragLine)   _dragLine.style.display   = 'none';
  if (_tooltip)    _tooltip.style.display    = 'none';

  _dragColDef = null;
  _dragHandle = null;

  document.removeEventListener('mousemove', _onColDragMove);
  document.removeEventListener('mouseup',   _onColDragEnd);
}

/** (호환성 stub - 이전 팝업 방식 제거 후 빈 함수 유지) */
function _closeColResizePopup() {}

// 페이지 로드 시 저장된 너비 즉시 적용 (레이아웃 완료 후 tabname 너비 계산)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { loadColWidths(); });
} else {
  // 이미 파싱 완료 상태면 requestAnimationFrame으로 1프레임 뒤 실행 (레이아웃 반영)
  requestAnimationFrame(() => { loadColWidths(); });
}
// (창 크기 변경 시 특별한 재계산 불필요 - 각 컬럼이 독립 고정px로 관리됨)

/** (overflow:visible 전환으로 불필요 - 호환성 stub) */
function _syncColHeaderScroll() {}

/** (overflow:visible 전환으로 불필요 - 호환성 stub) */
function _bindScrollSync() {}

// ═══════════════════════════════════════════════════════
function toggleDashTab(tableId, header) {
  const table = document.getElementById(tableId);
  const icon  = header ? header.querySelector(".dash-toggle-icon") : null;
  if (!table) return;
  const isCollapsed = table.classList.contains("collapsed");
  table.classList.toggle("collapsed", !isCollapsed);
  if (icon) icon.classList.toggle("rotated", isCollapsed);
}

let hideDoneMode = false;
function toggleHideDone() {
  hideDoneMode = !hideDoneMode;
  const btn  = document.getElementById("btnHideDone");
  const wrap = document.getElementById("dashboardWrap");
  if (hideDoneMode) {
    btn.innerHTML = '<i class="fas fa-eye"></i> 완료건 표시';
    btn.classList.add("active");
    wrap.classList.add("hide-done-mode");
  } else {
    btn.innerHTML = '<i class="fas fa-eye-slash"></i> 완료건 숨김';
    btn.classList.remove("active");
    wrap.classList.remove("hide-done-mode");
  }
}

// ── 마감업체 숨김: 모든 탭이 완료인 캠페인 전체 숨김 ──
let hideClosedCampMode = false;
function toggleHideClosedCamp() {
  hideClosedCampMode = !hideClosedCampMode;
  const btn  = document.getElementById("btnHideClosedCamp");
  const wrap = document.getElementById("dashboardWrap");
  if (hideClosedCampMode) {
    btn.innerHTML = '<i class="fas fa-building"></i> 마감업체 표시';
    btn.classList.add("active");
    wrap.classList.add("hide-closed-camp-mode");
  } else {
    btn.innerHTML = '<i class="fas fa-building"></i> 마감업체 숨김';
    btn.classList.remove("active");
    wrap.classList.remove("hide-closed-camp-mode");
  }
}

let hideClosedTabMode = false;
function toggleHideClosedTab() {
  hideClosedTabMode = !hideClosedTabMode;
  const btn  = document.getElementById("btnHideClosedTab");
  const wrap = document.getElementById("dashboardWrap");
  if (hideClosedTabMode) {
    btn.innerHTML = '<i class="fas fa-archive"></i> 마감탭 표시';
    btn.classList.add("active");
    wrap.classList.add("hide-closed-tab-mode");
  } else {
    btn.innerHTML = '<i class="fas fa-archive"></i> 마감탭 숨김';
    btn.classList.remove("active");
    wrap.classList.remove("hide-closed-tab-mode");
  }
}



// ═══════════════════════════════════════════════════════════
// ★ 마감 처리 — 베이스시트 is_closed 컬럼 기반
//   마감된 탭은 동기화 시 완전히 제외 (검색 불가)
//   마감된 탭은 인덱스에서 행 자체를 제외함
// ═══════════════════════════════════════════════════════════

// 마감된 tabKey Set — dashboard API 응답의 isClosed 값으로 채워짐
let _closedSet = new Set();

// 마감 모드 ON/OFF
let _closedMode = false;
function toggleClosedMode() {
  _closedMode = !_closedMode;
  const btn     = document.getElementById("btnClosed");
  const execBtn = document.getElementById("btnClosedExec");
  const wrap    = document.getElementById("dashboardWrap");
  if (_closedMode) {
    btn.classList.add("active");
    btn.innerHTML = '<i class="fas fa-archive"></i> 마감 <span style="font-size:.68rem;opacity:.8">(선택 중)</span>';
    execBtn.style.display = "flex";
    wrap.classList.add("closed-mode");
    document.documentElement.style.setProperty('--dc-closedcb', '28px');
  } else {
    btn.classList.remove("active");
    btn.innerHTML = '<i class="fas fa-archive"></i> 마감';
    execBtn.style.display = "none";
    wrap.classList.remove("closed-mode");
    document.documentElement.style.setProperty('--dc-closedcb', '0px');
  }
  _syncTabnameWidth(); // 체크박스 열(28px) 추가/제거에 따라 tabname 재계산
}

// [실행] 버튼 → 변경 내역 확인 후 팝업
function execClosed() {
  const cbs = document.querySelectorAll("#dashboardWrap .closed-cb");
  if (!cbs.length) { showToast("표시된 탭이 없습니다.", true); return; }

  let toClose = [], toOpen = [];
  cbs.forEach(cb => {
    const key = cb.dataset.tabkey || "";
    const tabName = (key.split("||")[1] || "").trim();
    if (cb.checked  && !_closedSet.has(key)) toClose.push({ key, tabName });
    if (!cb.checked &&  _closedSet.has(key)) toOpen.push({ key, tabName });
  });

  if (!toClose.length && !toOpen.length) {
    showToast("변경된 항목이 없습니다."); return;
  }

  // 목록 렌더링
  const listEl = document.getElementById("closedConfirmList");
  listEl.innerHTML = "";
  toClose.forEach(({ tabName }) => {
    const el = document.createElement("div");
    el.className = "closed-confirm-list-item";
    el.innerHTML = `<i class="fas fa-archive" style="color:#4F46E5;font-size:.75rem"></i> ${tabName} → <b>마감</b>`;
    listEl.appendChild(el);
  });
  toOpen.forEach(({ tabName }) => {
    const el = document.createElement("div");
    el.className = "closed-confirm-list-item remove-item";
    el.innerHTML = `<i class="fas fa-undo" style="font-size:.75rem"></i> ${tabName} → <b>마감 해제</b>`;
    listEl.appendChild(el);
  });

  const parts = [];
  if (toClose.length) parts.push(`<b>${toClose.length}건</b> 마감`);
  if (toOpen.length)  parts.push(`<b>${toOpen.length}건</b> 해제`);
  document.getElementById("closedConfirmMsg").innerHTML =
    `선택한 인덱스를 마감 처리합니다.<br>` +
    `대상: ${parts.join(" / ")}<br>` +
    `<span style="color:#EF4444;font-size:.8rem">⚠️ 마감된 인덱스는 동기화 후 검색에서 제외됩니다.</span>`;

  document.getElementById("closedConfirmOverlay").classList.add("open");
}

// 팝업 취소
function cancelClosed() {
  document.getElementById("closedConfirmOverlay").classList.remove("open");
}

// 팝업 확인 → GAS 베이스시트에 저장
async function confirmClosed() {
  document.getElementById("closedConfirmOverlay").classList.remove("open");

  const cbs = document.querySelectorAll("#dashboardWrap .closed-cb");
  const items = [];
  cbs.forEach(cb => {
    const key = cb.dataset.tabkey || "";
    if (!key) return;
    const [sheetId, tabName] = key.split("||");
    const wasClosed  = _closedSet.has(key);
    const isChecked  = cb.checked;
    if (isChecked === wasClosed) return;
    items.push({ sheetId: sheetId || "", tabName: tabName || "", isClosed: isChecked });
  });

  if (!items.length) { _exitClosedMode(); return; }

  // 낙관적 업데이트
  items.forEach(({ sheetId, tabName, isClosed }) => {
    const key = (sheetId || "") + "||" + (tabName || "");
    if (isClosed) _closedSet.add(key);
    else          _closedSet.delete(key);
  });

  _exitClosedMode();
  _reRenderDashboard();

  try {
    const json = await gasPost({ action: "setClosed", items });
    if (!json.ok) {
      showToast("⚠️ 서버 저장 실패: " + (json.error || "알 수 없는 오류"), true);
      loadAdminDashboard();
    } else {
      const closeCount  = items.filter(i => i.isClosed).length;
      const openCount   = items.filter(i => !i.isClosed).length;
      let msg = "";
      if (closeCount) msg += `${closeCount}건 마감 완료. `;
      if (openCount)  msg += `${openCount}건 마감 해제. `;
      msg += "인덱스 재갱신 후 적용됩니다.";
      showToast("✅ " + msg);
    }
  } catch (err) {
    showToast("⚠️ 서버 연결 오류: " + err.message + " (새로고침 권장)", true);
    loadAdminDashboard();
  }
}

function _exitClosedMode() {
  _closedMode = false;
  const btn     = document.getElementById("btnClosed");
  const execBtn = document.getElementById("btnClosedExec");
  const wrap    = document.getElementById("dashboardWrap");
  btn.classList.remove("active");
  btn.innerHTML = '<i class="fas fa-archive"></i> 마감';
  execBtn.style.display = "none";
  wrap.classList.remove("closed-mode");
  document.documentElement.style.setProperty('--dc-closedcb', '0px');
}

// ── 비고(메모) 관리 ──
const _TAB_MEMO_KEY = "rapp_tab_memo";     // { tabKey: memoString, ... }

function _loadMemoStore() {
  try {
    const raw = localStorage.getItem(_TAB_MEMO_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}
function _getTabMemo(tabKey) {
  return _loadMemoStore()[tabKey] || "";
}
function _setTabMemo(tabKey, memo) {
  const store = _loadMemoStore();
  if (memo) store[tabKey] = memo;
  else delete store[tabKey];
  try { localStorage.setItem(_TAB_MEMO_KEY, JSON.stringify(store)); } catch (_) {}
}

// 대시보드 재렌더링 (마지막 로드 데이터 재사용 — API 재호출 없이 즉시)
let _lastDashData = null;
function _reRenderDashboard() {
  if (_lastDashData) {
    renderDashboard(_lastDashData);
  } else {
    loadAdminDashboard();
  }
}

// 컬럼 헤더 sticky top 위치 보정
// sticky 요소들의 실제 '점유 높이'를 offsetHeight 기준으로 합산
function _fixColHeaderTop() {
  requestAnimationFrame(() => {
    const colHdr = document.getElementById("dashColHeader");
    if (!colHdr) return;

    const appHdr     = document.querySelector("#screenAdmin .app-header");
    const sectionHdr = document.querySelector("#tabDashboard .admin-section-header");
    // offsetHeight = 렌더된 실제 픽셀 높이 (스크롤 위치 무관)
    const appH     = appHdr     ? appHdr.offsetHeight     : 0;
    const sectionH = sectionHdr ? sectionHdr.offsetHeight : 0;
    colHdr.style.top = (appH + sectionH) + "px";
  });
}

// ── 관리자 화면 sticky 위치 전체 보정 ──
// app-header 높이를 측정해 section-header · col-header 순으로 top 값을 확정
function _fixStickyPositions() {
  requestAnimationFrame(() => {
    const appHdr     = document.querySelector("#screenAdmin .app-header");
    const sectionHdr = document.querySelector("#tabDashboard .admin-section-header");
    const colHdr     = document.getElementById("dashColHeader");

    const appH = appHdr ? appHdr.offsetHeight : 72;

    // ① section-header → app-header 바로 아래
    if (sectionHdr) sectionHdr.style.top = appH + "px";

    // ② col-header → app-header + section-header 바로 아래
    if (colHdr) {
      const sectionH = sectionHdr ? sectionHdr.offsetHeight : 46;
      colHdr.style.top = (appH + sectionH) + "px";
    }
  });
}


let allExpanded = false;

// ═══════════════════════════════════════════════════════
// ★ 빠른 인라인 편집 (빈 셀 클릭 시)
// ═══════════════════════════════════════════════════════
let _qePopup = null; // 현재 열려있는 팝업

function _closeQePopup() {
  if (_qePopup) { _qePopup.remove(); _qePopup = null; }
}

// 팝업 외부 클릭 시 닫기
document.addEventListener("click", function(e) {
  if (_qePopup && !_qePopup.contains(e.target)) _closeQePopup();
}, true);

// ═══════════════════════════════════════════════════════
// 구매양식 폼링크 생성 & 제출 (mode=form)
// ═══════════════════════════════════════════════════════

/**
 * 대시보드 행의 [🔗] 버튼 클릭 시 호출
 * tcAttr(JSON 문자열)에서 sheetId, gid, tabName, displayName 추출 → URL 생성 → 클립보드 복사
 */
/**
 * 대시보드 행의 [↗] 버튼 클릭 시 호출
 * data-tc 속성에서 인덱스 정보 읽기 → 구매양식 URL 생성 → 새 탭으로 열기 + 링크 복사
 */
function openFormLink(btnEl) {
  // data-tc 속성에서 tcData 파싱
  let tc = {};
  try {
    const raw = btnEl.getAttribute("data-tc") || "";
    const decoded = raw
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g,  '&')
      .replace(/&#39;/g,  "'")
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>');
    tc = JSON.parse(decoded);
  } catch (e) {
    showToast("링크 생성 실패: tcData 파싱 오류", "error");
    return;
  }

  const sheetId     = tc.sheetId     || "";
  const sheetUrl    = tc.sheetUrl    || "";
  const tabName     = tc.tabName     || "";
  const displayName = tc.displayName || "";

  if (!sheetId || !tabName) {
    showToast("링크 생성 실패: sheetId 또는 tabName이 없습니다.", "error");
    return;
  }

  // gid: sheetUrl에서 추출
  const gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "";

  // gasUrl은 URL에 포함하지 않음 → 링크를 짧고 깔끔하게 유지
  // 리뷰어 접속 시 BOOTSTRAP_GAS_URL(하드코딩) 또는 localStorage에서 자동 확보
  const base   = location.origin + location.pathname;
  const params = new URLSearchParams({
    mode: "form",
    sheetId,
    gid,
    tabName,
    displayName
  });
  const link = base + "?" + params.toString();

  // ① 새 탭으로 바로 열기
  window.open(link, "_blank");

  // ② 클립보드에도 복사 (성공 시 버튼 피드백)
  const markCopied = () => {
    btnEl.classList.add("copied");
    btnEl.innerHTML = '<i class="fas fa-check"></i>';
    setTimeout(() => {
      btnEl.classList.remove("copied");
      btnEl.innerHTML = '<i class="fas fa-external-link-alt"></i>';
    }, 2500);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => {
      markCopied();
      showToast("🔗 새 탭으로 열었습니다. 링크도 클립보드에 복사됐습니다!", "success");
    }).catch(() => {
      showToast("🔗 새 탭으로 열었습니다.", "success");
    });
  } else {
    try {
      const ta = document.createElement("textarea");
      ta.value = link;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      markCopied();
      showToast("🔗 새 탭으로 열었습니다. 링크도 클립보드에 복사됐습니다!", "success");
    } catch (_) {
      showToast("🔗 새 탭으로 열었습니다.", "success");
    }
  }
}

/**
 * 페이지 로드 시 URL 파라미터에 mode=form 이 있으면
 * 구매양식 전용 화면을 표시하고 true 반환 (일반 초기화 스킵)
 */
function initOrderFormMode() {
  const params = new URLSearchParams(location.search);

  // ★ 단축 URL 처리: ?r=CODE → 서버 API resolveShort → 파라미터 복원 후 폼 진입
  const shortCode = params.get("r") || "";
  if (shortCode) {
    // 즉시 모든 화면 숨기고 로딩 표시
    document.querySelectorAll(".screen").forEach(s => { s.classList.remove("active"); s.style.display = "none"; });
    const loadingEl = document.getElementById("loadingOverlay");
    const loadingTxt = document.getElementById("loadingText");
    if (loadingEl) { if (loadingTxt) loadingTxt.textContent = "링크 확인 중..."; loadingEl.style.display = "flex"; }

    // ★ 서버 API 우선 → GAS JSONP 폴백
    const apiBase = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : null;

    const resolveViaApi = async () => {
      if (apiBase) {
        const resp = await fetch(apiBase + '/api/short/resolve?code=' + encodeURIComponent(shortCode));
        return await resp.json();
      }
      // GAS 폴백 (JSONP)
      const savedUrl = (() => { try { return JSON.parse(localStorage.getItem("reviewAppConfig") || "{}").GAS_WEB_APP_URL || ""; } catch(_){ return ""; } })();
      const gasUrl = BOOTSTRAP_GAS_URL || savedUrl || "";
      if (!gasUrl) throw new Error("API URL이 설정되지 않았습니다.");
      return await _jsonpGet(gasUrl + "?action=resolveShort&code=" + encodeURIComponent(shortCode), 10000);
    };

    resolveViaApi()
      .then(data => {
        if (loadingEl) loadingEl.style.display = "none";
        if (!data || !data.success) {
          alert("유효하지 않거나 만료된 링크입니다.\n(" + (data && data.error ? data.error : "알 수 없는 오류") + ")");
          return;
        }
        // 옵션 유무 상관없이 → 복원된 파라미터로 URL 교체 후 폼 진입
        const newParams = new URLSearchParams({ s: data.s || "", g: data.g || "", t: data.t || "", d: data.d || "", rd: data.rd || "" });
        [...newParams.keys()].forEach(k => { if (!newParams.get(k)) newParams.delete(k); });
        const newUrl = location.pathname + "?" + newParams.toString();
        history.replaceState(null, "", newUrl);
        // 재귀 호출 (복원된 파라미터로 폼 진입)
        initOrderFormMode();
      })
      .catch(err => {
        if (loadingEl) loadingEl.style.display = "none";
        alert("링크 복원 중 오류가 발생했습니다: " + err.message);
      });
    return true; // 비동기 처리 중 — 일반 초기화 스킵
  }

  // ★ 단축키(s/g/t/d/rd) 또는 구버전 긴키(sheetId/gid/tabName/displayName) 모두 지원
  const sheetId     = params.get("s")  || params.get("sheetId")     || "";
  const gid         = params.get("g")  || params.get("gid")         || "";
  const tabName     = params.get("t")  || params.get("tabName")     || "";
  const displayName = params.get("d")  || params.get("displayName") || "";
  const round       = params.get("rd") || params.get("round")       || "";
  // ★ 네이버+쿠팡 동시작업 모드 플래그 (&nc=1)
  const ncMode      = params.get("nc") === "1";
  // ★ v9.14: 진행방식 파라미터 (&ic=현금|사업자현영|소득신고)
  const incomeType  = decodeURIComponent(params.get("ic") || "");

  // 진입 조건: 단축키(s) 또는 mode=form 파라미터가 있을 때
  const isFormMode = !!sheetId || params.get("mode") === "form";
  if (!isFormMode) return false;

  // ★ 즉시 모든 화면 숨김 — screenSearch가 잠깐 보이는 현상 방지
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.style.display = "none";
  });

  // GAS URL 확보 순서:
  // 1) URL 파라미터 gasUrl (구버전 링크 하위 호환용)
  // 2) BOOTSTRAP_GAS_URL (하드코딩 — 가장 신뢰할 수 있는 값)
  // 3) localStorage 저장값
  const gasUrlParam = params.get("gasUrl") || "";
  const savedUrl    = (() => { try { return JSON.parse(localStorage.getItem("reviewAppConfig") || "{}").GAS_WEB_APP_URL || ""; } catch(_){ return ""; } })();
  const resolvedGasUrl = gasUrlParam || BOOTSTRAP_GAS_URL || savedUrl || "";
  if (resolvedGasUrl) APP_CONFIG.GAS_WEB_APP_URL = resolvedGasUrl;

  // 전역에 폼 컨텍스트 저장 (sheetUrl, round, ncMode 포함)
  const _sheetUrl = sheetId ? "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit" : "";
  window._orderFormCtx = { sheetId, gid, tabName, displayName, round, sheetUrl: _sheetUrl, ncMode, incomeType };
  window._ncMode = ncMode; // 전역 플래그
  window._incomeType = incomeType; // ★ v9.14: 진행방식 전역 플래그

  // ★★★ Phase 5: 구매양식 제출 시 리뷰어 로그인 강제 ★★★
  const authSession = _loadAuthSession();
  if (!authSession || !authSession.name) {
    // 로그인 안 된 상태 → 로그인 화면 표시 후 완료 시 폼으로 복귀
    window._pendingOrderForm = true; // 로그인 완료 후 폼 진입 플래그

    // ★ 구매양식 단축링크 진입 시 헤더 텍스트를 캠페인 정보로 교체 (showScreen 전에 설정)
    const _formLabel = displayName || tabName || "";
    const _searchTitleEl = document.getElementById("searchTitle");
    const _searchDescEl  = document.getElementById("searchHeaderDesc");
    if (_searchTitleEl) _searchTitleEl.textContent = _formLabel || "구매양식 제출";
    if (_searchDescEl)  _searchDescEl.textContent  = "로그인 한뒤에 구매양식폼을 입력/제출하세요";
    document.title = _formLabel ? `${_formLabel} — 구매양식` : "구매양식 제출";

    showScreen("screenSearch"); // 로그인 UI가 있는 검색 화면 (★ _pendingOrderForm=true이므로 타이틀 덮어쓰기 안됨)

    _switchAuthTab("login");
    showToast("구매양식 제출을 위해 먼저 로그인해주세요.", "info");
    return true; // 일반 초기화 스킵
  }
  // 로그인 완료 상태 → 슬롯 매칭 정보 전역 저장
  window._slotAuth = { name: authSession.name, phone8: authSession.phone8 || "" };

  // 헤더 제목 설정: "상품명의 구매양식 제출"
  const titleEl    = document.getElementById("orderFormTitle");
  const subtitleEl = document.getElementById("orderFormSubtitle");
  const productEl  = document.getElementById("orderFormProductName");

  const titleText = displayName
    ? `${displayName}의 구매양식 제출`
    : "구매양식 제출";
  if (titleEl)    titleEl.textContent    = titleText;
  if (subtitleEl) subtitleEl.textContent = tabName || "";
  if (productEl)  productEl.textContent  = displayName || "상품명 정보 없음";

  // 페이지 title도 변경
  document.title = titleText;

  // 구매양식 화면 표시 — title/h1은 이미 위에서 설정했으므로 showScreen의 title 덮어쓰기 방지
  showScreen("screenOrderForm");
  // showScreen이 title을 "구매양식"으로 덮어쓰므로 다시 올바른 title로 복원
  document.title = titleText;
  if (titleEl) titleEl.textContent = titleText;

  // ── 다건 카드 초기화: 기존 카드 제거 후 첫 번째 카드 생성 ──
  _orderCardIds = [];
  _cardAiState  = {};
  _cardSeq      = 0;
  const wrapEl = document.getElementById("ofOrderCardsWrap");
  if (wrapEl) wrapEl.innerHTML = "";

  if (ncMode) {
    // ── 네이버+쿠팡 모드: 카드 2장 고정 ──
    _initNcMode();
    // 추가/삭제 버튼 숨김
    const addBtnEl = document.getElementById("btnAddOrderCard");
    if (addBtnEl) addBtnEl.style.display = "none";
  } else {
    addOrderCard(); // 첫 번째 카드 추가
    _updateCardCountBadge();
    // 추가 버튼 표시
    const addBtnEl2 = document.getElementById("btnAddOrderCard");
    if (addBtnEl2) addBtnEl2.style.display = "";
  }

  // ★ 주문자·아이디 입력란을 즉시 활성화 (GAS 응답 대기 중에도 직접 입력 가능하도록)
  _setOrdererDisabled(false);
  const _uidInput = document.getElementById("of_userId");
  if (_uidInput) _uidInput.disabled = false;

  // ── 인애드명단 자동완성 목록 비동기 로드 (화면 표시와 병렬)
  _loadInaedList(sheetId, gid, tabName);

  // ★ v9.14: 소득신고 섹션 초기화 (비동기, 병렬 로드)
  if (incomeType === "소득신고") {
    _loadReviewerProfileForForm().catch(e => {
      console.warn("[income section init]", e.message);
      _initIncomeSection(incomeType, null);
    });
  }

  return true;
}


/** textContent 대신 innerHTML에 쓸 안전 문자열 반환 */
function _safeText(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/**
 * 사전 선택된 옵션을 옵션피커에 자동 반영
 */
function _applyPreSelectedOption(optKey) {
  const tabs = document.querySelectorAll("#of_option_tabs .of-opt-tab");
  if (tabs.length > 0) {
    let matched = false;
    tabs.forEach(btn => {
      if (btn.dataset.optkey === optKey) {
        // click() 대신 직접 상태만 변경 (무한루프 방지)
        btn.classList.add("selected");
        matched = true;
      } else {
        btn.classList.remove("selected");
      }
    });
    if (!matched) {
      tabs[0] && tabs[0].classList.add("selected");
    }
    // _selectedOptKey 재설정 + 주문자 활성화
    _selectedOptKey = optKey;
    _setOrdererDisabled(false);
    // 주문자 입력칸 포커스
    const input = document.getElementById("of_orderer");
    if (input) setTimeout(() => input.focus(), 100);
  } else {
    // 피커 없음 → 직접 설정
    _selectedOptKey = optKey;
    _setOrdererDisabled(false);
  }
}

// 전역 자동완성 데이터
let _inaedNames      = [];   // GAS에서 받아온 전체 목록 [{ name, date, options, rowIndex }]
let _acActiveIdx     = -1;   // 키보드 선택 인덱스
let _acBlurTimer     = null; // blur 딜레이 타이머
let _optionHeaders   = [];   // 옵션 헤더명 목록 (최대 3개)
let _memoHeader      = "";   // 비고 헤더명
let _orderNumHeader  = "";   // 주문번호 헤더명 (없으면 "")
let _selectedOptKey  = null; // 선택된 옵션 키 (null = 옵션 없음 or 미선택)

/** GAS에서 인애드명단 목록 로드 */
async function _loadInaedList(sheetId, gid, tabName) {
  try {
    if (!APP_CONFIG.GAS_WEB_APP_URL) return;
    const data = await gasGet({ action: "getInaedList", sheetId, gid, tabName });
    if (data && Array.isArray(data.names)) {
      _inaedNames     = data.names;                     // [{ name, date, options, rowIndex }]
      _optionHeaders  = data.optionHeaders  || [];      // ["옵션1","옵션2",...]
      _memoHeader     = data.memoHeader     || "";      // "비고(닉네임)" 등
      _orderNumHeader = data.orderNumHeader || "";      // "주문번호" 등
      // ★ preSelectedOptKey가 있으면 유지, 없을 때만 초기화
      if (!window._preSelectedOptKey) _selectedOptKey = null;
      console.log("[자동완성] 인애드명단 로드 완료:", _inaedNames.length, "명",
        "| 옵션헤더:", _optionHeaders, "| 비고:", _memoHeader, "| 주문번호:", _orderNumHeader);
      // 비고/주문번호 입력란 동적 표시 + 옵션 피커 렌더링
      _renderDynamicFields();
    } else {
      // 데이터 없어도 입력란은 항상 활성화 유지
      _setOrdererDisabled(false);
    }
  } catch (err) {
    console.warn("[자동완성] 인애드명단 로드 실패:", err.message);
    // ★ GAS 호출 실패해도 입력란은 반드시 활성화 (로드 실패가 입력 차단으로 이어지지 않도록)
    _setOrdererDisabled(false);
  }
}

/** 비고·주문번호 입력란을 동적으로 표시/숨김 */
function _renderDynamicFields() {
  // 비고 입력란: 항상 표시 (카드별 ID로 변경됨, 시트에 비고 헤더 있으면 라벨명 반영)
  // 1번 카드의 memo 라벨 업데이트
  const firstCardMemoLabel = document.getElementById("ofc0_memo_label");
  if (firstCardMemoLabel && _memoHeader) firstCardMemoLabel.textContent = _memoHeader;

  // 옵션 피커 렌더링
  _renderOptionPicker();
}

/** ── 옵션 먼저 선택 UI ──
 *  _inaedNames 중 options[] 값이 존재하는 고유 옵션 목록을 추출하여
 *  옵션 버튼으로 표시한다. 옵션이 1개 이하이면 피커를 숨긴다.
 */
function _renderOptionPicker() {
  const pickerWrap = document.getElementById("of_option_picker_wrap");
  const tabsEl     = document.getElementById("of_option_tabs");
  if (!pickerWrap || !tabsEl) return;

  // 각 항목의 options[0] (첫 번째 옵션 컬럼 값)으로 고유 옵션 키 추출
  // 옵션 헤더가 없거나 options 배열이 모두 빈 경우 피커 숨김
  const hasOptions = _optionHeaders.length > 0 &&
    _inaedNames.some(item => (item.options || []).some(v => v && v.trim()));

  if (!hasOptions) {
    pickerWrap.style.display = "none";
    // preSelected가 없을 때만 초기화
    if (!window._preSelectedOptKey) _selectedOptKey = null;
    _setOrdererDisabled(false);
    return;
  }

  // 옵션 컬럼별로 고유 값 수집
  // key  : "블랙|유선|체리축" (파이프 구분 — 매칭용)
  // label: "블랙 | 유선 | 체리축" (표시용)
  // cols : [{header,value},...] (배지 표시용)
  const optMap = new Map(); // key -> { label, cols, count }
  _inaedNames.forEach(item => {
    const opts = item.options || [];
    const entries = _optionHeaders.length > 0
      ? opts.map((v, i) => ({ header: _optionHeaders[i] || ("옵션"+(i+1)), value: (v||"").trim() })).filter(e => e.value)
      : opts.map((v,i) => ({ header: "옵션"+(i+1), value: (v||"").trim() })).filter(e => e.value);
    const key = entries.map(e => e.value).join("|");
    if (!key) return;
    if (!optMap.has(key)) {
      const label = entries.map(e => e.value).join(" | ");
      optMap.set(key, { label, cols: entries, count: 0 });
    }
    optMap.get(key).count++;
  });

  // 옵션이 1가지뿐이면 자동 선택하고 피커 숨김
  if (optMap.size <= 1) {
    pickerWrap.style.display = "none";
    if (optMap.size === 1) {
      _selectedOptKey = [...optMap.keys()][0];
    } else if (!window._preSelectedOptKey) {
      _selectedOptKey = null;
    }
    _setOrdererDisabled(false);
    return;
  }

  // 옵션이 2가지 이상 → 피커 표시 (createElement 방식으로 안전하게 렌더링)
  pickerWrap.style.display = "";
  // _selectedOptKey 초기화: preSelected 없으면 null (첫 렌더 후 첫 번째 버튼 자동선택)
  if (!window._preSelectedOptKey) {
    _selectedOptKey = null;
    // 주문자는 활성화 유지 (이전 화면 없으므로 막을 필요 없음)
    _setOrdererDisabled(false);
  }

  tabsEl.innerHTML = "";  // 기존 버튼 초기화
  let idx = 1;
  optMap.forEach(({ label, cols, count }, key) => {
    const btn = document.createElement("button");
    btn.className = "of-opt-tab";
    btn.type = "button";
    btn.dataset.optkey = key;

    // 번호
    const numSpan = document.createElement("span");
    numSpan.className = "of-opt-tab-num";
    numSpan.textContent = idx;
    btn.appendChild(numSpan);

    // 옵션명 (배지 or 텍스트)
    const nameSpan = document.createElement("span");
    nameSpan.className = "of-opt-tab-name";
    nameSpan.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:2px";
    if (cols.length > 1) {
      cols.forEach(e => {
        const badge = document.createElement("span");
        badge.className = "opt-sel-badge";
        badge.style.cssText = "margin:1px 2px";
        badge.innerHTML =
          '<span class="opt-sel-badge-hd">' + _safeText(e.header) + '</span>' +
          '<span class="opt-sel-badge-val">' + _safeText(e.value)  + '</span>';
        nameSpan.appendChild(badge);
      });
    } else {
      const txt = document.createElement("span");
      txt.style.cssText = "font-size:.85rem;font-weight:600;color:#1F2937";
      txt.textContent = label;
      nameSpan.appendChild(txt);
    }
    btn.appendChild(nameSpan);

    // 인원수
    const cntSpan = document.createElement("span");
    cntSpan.className = "of-opt-tab-count";
    cntSpan.textContent = count + "명";
    btn.appendChild(cntSpan);

    // 클릭 이벤트 — 클로저로 key 캡처
    btn.addEventListener("click", (function(k){ return function(){ selectOptionKey(k); }; })(key));

    tabsEl.appendChild(btn);
    idx++;
  });

  // 선택할 키 결정: preSelected가 있으면 그 키, 없으면 첫 번째 옵션 자동 선택
  const allBtns = tabsEl.querySelectorAll(".of-opt-tab");
  const targetKey = window._preSelectedOptKey || (allBtns.length > 0 ? allBtns[0].dataset.optkey : null);
  if (targetKey) {
    let matched = false;
    allBtns.forEach(btn => {
      if (btn.dataset.optkey === targetKey) { btn.classList.add("selected"); matched = true; }
      else btn.classList.remove("selected");
    });
    if (!matched && allBtns.length > 0) allBtns[0].classList.add("selected");
    _selectedOptKey = targetKey;
    window._preSelectedOptKey = targetKey;
    _setOrdererDisabled(false);
  }
}

/** 옵션 선택 처리 (구매양식 내 피커 버튼 클릭) */
function selectOptionKey(key) {
  _selectedOptKey = key;
  window._preSelectedOptKey = key; // 동기화

  // 버튼 UI 업데이트
  const tabs = document.querySelectorAll("#of_option_tabs .of-opt-tab");
  tabs.forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.optkey === key);
  });

  // 주문자 입력 활성화
  _setOrdererDisabled(false);

  // 주문자 input 초기화 및 포커스
  const input = document.getElementById("of_orderer");
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 50);
  }
  // 옵션 표시 영역 초기화
  const optWrap = document.getElementById("of_options_wrap");
  if (optWrap) optWrap.style.display = "none";

  // 드롭다운 바로 열기
  const candidates = _filterInaed("");
  _renderAcList(candidates, "");
}

/** 주문자 입력란 비활성/활성 토글 */
function _setOrdererDisabled(disabled) {
  const wrap = document.querySelector(".of-autocomplete-wrap");
  const input = document.getElementById("of_orderer");
  if (wrap) wrap.classList.toggle("of-orderer-disabled", disabled);
  if (input) {
    input.disabled = disabled;
    input.placeholder = disabled ? "위에서 옵션을 먼저 선택해주세요" : "자신외 선택금지, 없으면 직접입력";
  }
}

/** 옵션 배열 → 파이프 키 변환 ("블랙|유선|체리축") */
function _optionsToKey(options) {
  return (options || []).map(v => (v || "").trim()).filter(Boolean).join("|");
}

/** 입력값에 맞는 후보 필터링 (옵션 선택 시 해당 옵션 항목만) */
function _filterInaed(query) {
  let pool = _inaedNames;

  // 선택된 옵션 키가 있으면 해당 옵션 항목만 필터 (파이프 키 기준)
  if (_selectedOptKey !== null) {
    pool = _inaedNames.filter(item => _optionsToKey(item.options) === _selectedOptKey);
  }

  if (!query) return pool.slice(0, 30);
  const q = query.toLowerCase();
  return pool.filter(item => {
    const n = typeof item === "string" ? item : (item.name || "");
    return n.toLowerCase().includes(q);
  }).slice(0, 30);
}

/** 이름 안에서 검색어 부분을 <b> 태그로 강조 */
function _highlightMatch(text, query) {
  if (!query) return escHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return escHtml(text);
  return escHtml(text.slice(0, idx))
    + `<span class="of-ac-highlight">${escHtml(text.slice(idx, idx + query.length))}</span>`
    + escHtml(text.slice(idx + query.length));
}

/** 드롭다운 렌더링 */
function _renderAcList(items, query) {
  const listEl = document.getElementById("of_orderer_list");
  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = `<div class="of-ac-empty">일치하는 이름이 없습니다</div>`;
  } else {
    listEl.innerHTML = items.map((item, i) => {
      // item 은 { name, date, options } 또는 구버전 문자열 호환
      const name = typeof item === "string" ? item : (item.name || "");
      const date = typeof item === "string" ? "" : (item.date || "");
      const opts = typeof item === "string" ? [] : (item.options || []);
      const nameHtml = _highlightMatch(name, query);
      const dateHtml = date
        ? `<span class="ac-date">${escHtml(date)}</span>`
        : "";
      // 옵션이 없거나 이미 옵션 선택 완료 시 배지 숨김
      const optKey = _optionsToKey(opts);
      // 드롭다운 배지: 옵션 미선택 시 표시 (다중옵션이면 배지 열별로 분리)
      const optBadge = (_selectedOptKey === null && optKey)
        ? `<span class="ac-opt-badge" title="${escHtml(optKey)}">${escHtml(optKey)}</span>`
        : "";
      return `<div class="of-ac-item" data-idx="${i}" data-name="${escHtml(name)}" onmousedown="selectAcItem('${escHtml(name)}')">`
        + dateHtml
        + `<i class="fas fa-user ac-icon"></i>`
        + `<span>${nameHtml}</span>`
        + optBadge
        + `</div>`;
    }).join("");
  }
  _acActiveIdx = -1;
  listEl.classList.add("open");
}

/** 드롭다운 닫기 */
function _closeAcList() {
  const listEl = document.getElementById("of_orderer_list");
  if (listEl) listEl.classList.remove("open");
  _acActiveIdx = -1;
}

/** 자동완성 항목 선택 */
function selectAcItem(name) {
  const input = document.getElementById("of_orderer");
  if (input) {
    input.value = name;
    input.dispatchEvent(new Event("input"));
  }
  _closeAcList();

  // ── 선택된 이름에 매핑되는 옵션 표시 (파이프 키 기준)
  let pool = _inaedNames;
  if (_selectedOptKey !== null) {
    pool = _inaedNames.filter(item => _optionsToKey(item.options) === _selectedOptKey);
  }
  const matched = pool.find(item => {
    const n = typeof item === "string" ? item : (item.name || "");
    return n === name;
  });
  _showSelectedOptions(matched ? (matched.options || []) : []);

  // 다음 필드(아이디)로 포커스 이동
  const next = document.getElementById("of_userId");
  if (next) next.focus();
}

/** oninput 핸들러 */
function onOrdererInput(el) {
  const q = el.value.trim();
  const candidates = _filterInaed(q);
  if (_inaedNames.length === 0) {
    // 아직 목록 로딩 전이면 드롭다운 숨김
    _closeAcList();
    return;
  }
  _renderAcList(candidates, q);
}

/** onfocus 핸들러 */
function onOrdererFocus() {
  if (_acBlurTimer) { clearTimeout(_acBlurTimer); _acBlurTimer = null; }
  const q = (document.getElementById("of_orderer")?.value || "").trim();
  const candidates = _filterInaed(q);
  if (candidates.length > 0 || q) _renderAcList(candidates, q);
}

/** onblur 핸들러 — 클릭 이벤트보다 늦게 닫히도록 딜레이 */
function onOrdererBlur() {
  _acBlurTimer = setTimeout(() => { _closeAcList(); }, 200);
}

/** onkeydown 핸들러 (화살표 키 / Enter / Escape) */
function onOrdererKeydown(e) {
  const listEl = document.getElementById("of_orderer_list");
  if (!listEl || !listEl.classList.contains("open")) return;
  const items = listEl.querySelectorAll(".of-ac-item");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    _acActiveIdx = Math.min(_acActiveIdx + 1, items.length - 1);
    _updateAcActive(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _acActiveIdx = Math.max(_acActiveIdx - 1, 0);
    _updateAcActive(items);
  } else if (e.key === "Enter") {
    if (_acActiveIdx >= 0 && items[_acActiveIdx]) {
      e.preventDefault();
      selectAcItem(items[_acActiveIdx].dataset.name);
    }
  } else if (e.key === "Escape") {
    _closeAcList();
  }
}

function _updateAcActive(items) {
  items.forEach((el, i) => el.classList.toggle("active", i === _acActiveIdx));
  if (_acActiveIdx >= 0) items[_acActiveIdx].scrollIntoView({ block: "nearest" });
}

/* ══════════════════════════════════════════════════════════
   은행 자동완성 로직
══════════════════════════════════════════════════════════ */

const BANK_LIST = [
  "국민","기업","신한","우리","KEB하나","농협",
  "케이뱅크","카카오뱅크","토스뱅크","새마을금고",
  "SC제일","우체국","신협","수협","대구아이엠뱅크",
  "부산","광주","전북","경남","저축은행","한국씨티","산업"
];

let _bankActiveIdx = -1;
let _bankBlurTimer = null;

function _closeBankList() {
  const el = document.getElementById("of_bank_list");
  if (el) { el.innerHTML = ""; el.classList.remove("open"); }
  _bankActiveIdx = -1;
}

function _renderBankList(items) {
  const listEl = document.getElementById("of_bank_list");
  if (!listEl) return;
  if (!items.length) { _closeBankList(); return; }
  const q = (document.getElementById("of_bank")?.value || "").trim();
  listEl.innerHTML = items.map((name, i) =>
    `<div class="of-ac-item" role="option" data-name="${escHtml(name)}"
      onmousedown="selectBankItem('${escHtml(name)}')">${_highlightMatch(name, q)}</div>`
  ).join("");
  listEl.classList.add("open");
  _bankActiveIdx = -1;
}

function onBankInput(input) {
  clearTimeout(_bankBlurTimer);
  const q = input.value.trim();
  if (!q) { _renderBankList(BANK_LIST); return; }
  const filtered = BANK_LIST.filter(b => b.includes(q));
  _renderBankList(filtered);
}

function onBankFocus() {
  clearTimeout(_bankBlurTimer);
  const q = (document.getElementById("of_bank")?.value || "").trim();
  const filtered = q ? BANK_LIST.filter(b => b.includes(q)) : BANK_LIST;
  _renderBankList(filtered);
}

function onBankBlur() {
  _bankBlurTimer = setTimeout(() => { _closeBankList(); }, 200);
}

function onBankKeydown(e) {
  const listEl = document.getElementById("of_bank_list");
  if (!listEl || !listEl.classList.contains("open")) return;
  const items = listEl.querySelectorAll(".of-ac-item");
  if (!items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    _bankActiveIdx = Math.min(_bankActiveIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle("active", i === _bankActiveIdx));
    if (_bankActiveIdx >= 0) items[_bankActiveIdx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    _bankActiveIdx = Math.max(_bankActiveIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle("active", i === _bankActiveIdx));
    if (_bankActiveIdx >= 0) items[_bankActiveIdx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    if (_bankActiveIdx >= 0 && items[_bankActiveIdx]) {
      e.preventDefault();
      selectBankItem(items[_bankActiveIdx].dataset.name);
    }
  } else if (e.key === "Escape") {
    _closeBankList();
  }
}

function selectBankItem(name) {
  const input = document.getElementById("of_bank");
  if (input) { input.value = name; input.focus(); }
  _closeBankList();
}



/* ══════════════════════════════════════════════════════
   네이버+쿠팡 동시작업 모드 (nc=1)
   ══════════════════════════════════════════════════════ */

/** nc 모드 초기화: 네이버(1번) + 쿠팡(2번) 카드 2장 고정 생성 */
function _initNcMode() {
  window._ncVerifyPassed = false;
  window._ncAddrToastShown = false;

  // 1번 카드: 네이버 (일반 카드와 동일하나 라벨 변경)
  const cid0 = _newCardId();
  _orderCardIds.push(cid0);
  _cardAiState[cid0] = { abortCtrl:null, countdownId:null, lastBase64:"", lastMime:"", extracted:null };
  const wrap = document.getElementById("ofOrderCardsWrap");
  const t0 = document.createElement("div");
  t0.innerHTML = _buildOrderCardHtml(cid0, 0, "naver");
  wrap.appendChild(t0.firstElementChild);

  // 2번 카드: 쿠팡 전용
  const cid1 = _newCardId();
  _orderCardIds.push(cid1);
  _cardAiState[cid1] = { abortCtrl:null, countdownId:null, lastBase64:"", lastMime:"", extracted:null };
  const t1 = document.createElement("div");
  t1.innerHTML = _buildCoupangCardHtml(cid1);
  wrap.appendChild(t1.firstElementChild);

  // 제목에 (네이버+쿠팡) 표기
  const titleEl = document.getElementById("orderFormTitle");
  if (titleEl) { const base = titleEl.textContent.replace(/\s*\(다건\)$/,""); titleEl.textContent = base + " (네이버+쿠팡)"; }
  document.title = document.title.replace(/\s*\(다건\)$/,"") + " (네이버+쿠팡)";

  // 쿠팡 카드가 뷰포트에 들어올 때 1회 토스트 표시 (IntersectionObserver)
  setTimeout(() => {
    const coupangCard = document.getElementById(cid1);
    if (coupangCard && 'IntersectionObserver' in window && !window._ncAddrToastShown) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !window._ncAddrToastShown) {
            window._ncAddrToastShown = true;
            showToast("📦 쿠팡 주문 시 네이버와 동일한 배송주소를 사용해주세요!", "warning", 5000);
            obs.disconnect();
          }
        });
      }, { threshold: 0.3 });
      obs.observe(coupangCard);
    }
  }, 500);
}

/** 쿠팡 전용 카드 HTML 생성 */
function _buildCoupangCardHtml(cid) {
  return `
  <div class="of-order-card card-coupang nc-card-coupang" id="${cid}">
    <div class="ofc-header">
      <span class="ofc-badge badge-coupang">
        <i class="fas fa-shopping-cart" style="font-size:.68rem"></i>
        <span class="ofc-badge-num">📦 쿠팡 주문</span>
      </span>
    </div>

    <!-- 배송지 통일 안내 (쿠팡 카드 상단 고정) -->
    <div class="nc-addr-notice">
      <i class="fas fa-map-marker-alt" style="margin-right:5px;color:#EF4444"></i>
      <b>배송지 통일 필수!</b> 쿠팡 주문 시 <u>네이버와 동일한 배송주소</u>로 주문해 주세요.
    </div>

    <!-- AI 캡처 추출 섹션 -->
    <div class="ofc-ai-section">
      <div class="ofc-ai-section-title">📸 쿠팡 주문 캡처 자동추출 <span style="font-weight:400;color:#A5B4FC;font-size:.65rem">(업로드 시 동일인 자동 검증)</span></div>
      <div class="of-img-zone" id="${cid}_imgZone"
           ondragover="event.preventDefault();this.classList.add('drag-over')"
           ondragleave="this.classList.remove('drag-over')"
           ondrop="onCardImgDrop(event,'${cid}')">
        <input type="file" accept="image/*" id="${cid}_imgInput" onchange="onCardImgSelected(this,'${cid}')">
        <span class="oiz-icon">📷</span>
        <div class="oiz-title" style="font-size:.82rem">쿠팡 주문캡처 업로드 (AI 자동추출 + 동일인 검증)</div>
        <div class="oiz-sub">클릭하거나 드래그 · JPG/PNG/WEBP</div>
      </div>
      <div class="of-img-preview" id="${cid}_imgPreview" style="display:none;align-items:center;gap:10px;margin-bottom:8px">
        <div style="position:relative;flex-shrink:0">
          <img id="${cid}_imgThumb" src="" alt="쿠팡캡처" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1.5px solid #FEE2E2">
          <button class="oip-remove" onclick="removeCardImg('${cid}')" title="이미지 제거"><i class="fas fa-times"></i></button>
        </div>
        <span id="${cid}_imgLabel" style="font-size:.75rem;color:#6B7280">이미지 첨부됨</span>
      </div>
      <div class="ofc-ai-loading" id="${cid}_aiLoading">
        <i class="fas fa-circle-notch fa-spin" style="flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span>AI가 쿠팡 주문 정보를 분석하고 있습니다…</span>
            <span id="${cid}_aiCountdown" style="font-size:.9rem;font-weight:800;color:#7C3AED;flex-shrink:0;min-width:18px;text-align:right"></span>
          </div>
          <div style="margin-top:5px;background:#DDD6FE;border-radius:99px;height:3px;overflow:hidden">
            <div id="${cid}_aiBar" style="height:100%;background:#7C3AED;width:100%;transition:width 1s linear;border-radius:99px"></div>
          </div>
        </div>
      </div>
      <div class="ofc-ai-result" id="${cid}_aiResult">
        <div class="of-ai-result-title"><i class="fas fa-magic"></i> AI 추출 결과 — 확인 후 적용하세요</div>
        <div class="of-ai-field"><span class="aif-label">주문번호</span><span class="aif-val" id="${cid}_aiOrder">-</span></div>
        <div class="of-ai-field"><span class="aif-label">수취인</span><span class="aif-val" id="${cid}_aiRecipient">-</span></div>
        <div class="of-ai-field"><span class="aif-label">전화번호</span><span class="aif-val" id="${cid}_aiPhone">-</span></div>
        <div class="of-ai-field"><span class="aif-label">주소</span><span class="aif-val" id="${cid}_aiAddress">-</span></div>
        <div class="of-ai-field"><span class="aif-label">결제금액</span><span class="aif-val" id="${cid}_aiPrice">-</span></div>
        <!-- ★ 별표 경고 배너 (쿠팡 캡처 등 *가 탐지될 때 표시) -->
        <div id="${cid}_asteriskWarn" style="display:none;margin:8px 0 6px;padding:9px 11px;background:#FEF2F2;border:1.5px solid #FCA5A5;border-radius:8px;font-size:.76rem;color:#991B1B;line-height:1.6">
          <i class="fas fa-exclamation-triangle" style="margin-right:5px;color:#EF4444"></i>
          <b>수취인·전화번호·주소에 별표(*)가 포함되어 있습니다.</b><br>
          쿠팡 주문 캡처본은 개인정보가 *로 가려집니다. 정보를 직접 입력해주세요.
        </div>
        <button class="of-ai-apply-btn" id="${cid}_aiApplyBtn" onclick="applyCardAiResult('${cid}')">
          <i class="fas fa-check-circle"></i> 위 정보를 입력칸에 적용하기
        </button>
      </div>
      <div class="ofc-ai-error" id="${cid}_aiError">
        <div style="display:flex;align-items:flex-start;gap:5px;margin-bottom:5px">
          <i class="fas fa-exclamation-circle" style="margin-top:1px;flex-shrink:0;color:#DC2626"></i>
          <span id="${cid}_aiErrorMsg"></span>
        </div>
        <button id="${cid}_aiRetryBtn" onclick="_retryCardAi('${cid}')" style="display:none;padding:4px 12px;background:#DC2626;color:#fff;border:none;border-radius:6px;font-size:.74rem;font-weight:700;cursor:pointer;width:100%">
          <i class="fas fa-redo" style="margin-right:3px"></i>다시 분석하기
        </button>
      </div>
    </div>

    <!-- 동일인 검증 결과 (AI 검증 후 표시) -->
    <div id="${cid}_ncVerify" class="nc-verify-box" style="display:none"></div>

    <!-- 쿠팡 전용 입력 필드 (3개만) -->
    <div style="font-size:.68rem;font-weight:700;color:var(--t3);margin-bottom:10px;letter-spacing:.04em">✏️ 쿠팡 주문 정보를 입력해주세요 <span style="color:#EF4444">(3개 필드)</span></div>

    <!-- 쿠팡 주문번호 -->
    <div class="of-field">
      <label class="of-label of-label-required" for="${cid}_orderNumber">쿠팡 주문번호</label>
      <input id="${cid}_orderNumber" class="of-input" type="text" placeholder="캡처 분석 후 자동기입" oninput="_ofClearError('${cid}_orderNumber')">
    </div>
    <div class="of-error-msg" id="${cid}_orderNumber_err"><i class="fas fa-exclamation-circle"></i> 쿠팡 주문번호는 필수 입력 항목입니다.</div>

    <!-- 쿠팡 아이디 -->
    <div class="of-field">
      <label class="of-label of-label-required" for="${cid}_userId">쿠팡 아이디</label>
      <input id="${cid}_userId" class="of-input" type="text" placeholder="쿠팡 로그인 아이디" oninput="_ofClearError('${cid}_userId')">
    </div>
    <div class="of-error-msg" id="${cid}_userId_err"><i class="fas fa-exclamation-circle"></i> 쿠팡 아이디는 필수 입력 항목입니다.</div>

    <!-- 쿠팡 결제금액 -->
    <div class="of-field">
      <label class="of-label of-label-required" for="${cid}_price">쿠팡 결제금액</label>
      <input id="${cid}_price" class="of-input" type="text" placeholder="쿠팡 결제금액 (예: 47,000)"
        oninput="formatPriceInput(this);this.classList.remove('ai-filled');this.dataset.userEdited='1';_ofClearError('${cid}_price')" inputmode="numeric">
    </div>
    <div class="of-error-msg" id="${cid}_price_err"><i class="fas fa-exclamation-circle"></i> 쿠팡 결제금액은 필수 입력 항목입니다.</div>

    <!-- 동일인 검증 실패 시 수동 확인 체크박스 -->
    <div id="${cid}_manualCheck" class="nc-manual-check" style="display:none">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
        <input type="checkbox" id="${cid}_manualChk" onchange="_onManualCheckChange('${cid}')" style="margin-top:2px;flex-shrink:0">
        <span style="font-size:.82rem;line-height:1.5">
          <b>🔍 수동 확인 완료:</b> 네이버와 쿠팡 배송지가 동일함을 직접 확인했습니다.<br>
          <span style="color:#6B7280;font-size:.76rem">(체크 후 제출 가능)</span>
        </span>
      </label>
    </div>

    <div style="font-size:.7rem;color:var(--t3);padding:6px 8px;background:var(--bg);border-radius:6px;border:1px solid var(--border);margin-top:8px">
      <i class="fas fa-info-circle" style="color:#6B7280;margin-right:3px"></i>날짜·주문자·은행·예금주는 네이버 정보를 기준으로 자동 입력됩니다.
    </div>
  </div>`;
}

/** 네이버 카드의 입력값 기준점 반환 (검증에 사용) */
function _getNaverFields() {
  const cid0 = _orderCardIds[0];
  if (!cid0) return {};
  const gv = id => (document.getElementById(id)?.value || "").trim();
  return {
    recipient: gv(cid0 + "_recipient"),
    phone:     gv(cid0 + "_phone"),
    address:   gv(cid0 + "_address")
  };
}

/** 쿠팡 캡처 업로드 시 AI 검증 결과 처리 */
async function _ncVerifyIdentity(cid, extracted) {
  const naver = _getNaverFields();
  const verifyEl = document.getElementById(cid + "_ncVerify");
  const manualEl = document.getElementById(cid + "_manualCheck");
  if (!verifyEl) return;

  // 네이버 정보가 없으면 검증 불가
  if (!naver.recipient && !naver.phone && !naver.address) {
    verifyEl.className = "nc-verify-box nc-verify-warn";
    verifyEl.style.display = "";
    verifyEl.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <b>검증 불가:</b> 네이버 카드에 수취인·연락처·주소를 먼저 입력해주세요.`;
    return;
  }

  // 간단한 프론트엔드 비교 먼저 시도 (수취인·전화번호)
  const coupang = extracted;
  let matchCount = 0;
  let matchInfo = [];

  const normalize = s => (s||"").replace(/[\s\-()]/g,"").toLowerCase();

  if (naver.recipient && coupang.recipient && normalize(naver.recipient) === normalize(coupang.recipient)) {
    matchCount++; matchInfo.push("수취인 일치");
  }
  if (naver.phone && coupang.phone && normalize(naver.phone) === normalize(coupang.phone)) {
    matchCount++; matchInfo.push("전화번호 일치");
  }

  // 주소: 부분 일치 검사 (동/호수 핵심 부분)
  if (naver.address && coupang.address) {
    const na = normalize(naver.address);
    const ca = normalize(coupang.address);
    // 30자 이상이면 첫 30자로 비교 (도로명주소 vs 지번주소 차이 허용)
    const naShort = na.slice(0,30), caShort = ca.slice(0,30);
    if (na === ca || naShort === caShort || na.includes(ca.slice(0,20)) || ca.includes(na.slice(0,20))) {
      matchCount++; matchInfo.push("주소 부분일치");
    }
  }

  if (matchCount >= 2) {
    // 검증 통과
    verifyEl.className = "nc-verify-box nc-verify-ok";
    verifyEl.style.display = "";
    verifyEl.innerHTML = `<i class="fas fa-check-circle"></i> <b>동일인 확인 완료</b> (${matchInfo.join(", ")})`;
    if (manualEl) manualEl.style.display = "none";
    window._ncVerifyPassed = true;
  } else if (matchCount === 1) {
    // AI (GAS Gemini) 비교 요청
    verifyEl.className = "nc-verify-box nc-verify-checking";
    verifyEl.style.display = "";
    verifyEl.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> AI로 주소를 비교하는 중…`;
    await _ncGeminiVerify(cid, naver, coupang);
  } else {
    // 불일치 → 수동 확인 모드
    verifyEl.className = "nc-verify-box nc-verify-fail";
    verifyEl.style.display = "";
    verifyEl.innerHTML = `<i class="fas fa-times-circle"></i> <b>배송지 불일치 감지</b><br><span style="font-size:.78rem">네이버와 쿠팡의 수취인·전화번호가 다릅니다. 아래 체크박스를 확인 후 제출하세요.</span>`;
    if (manualEl) manualEl.style.display = "";
    window._ncVerifyPassed = false;
  }
}

/** GAS Gemini로 주소 비교 */
async function _ncGeminiVerify(cid, naver, coupang) {
  const verifyEl = document.getElementById(cid + "_ncVerify");
  const manualEl = document.getElementById(cid + "_manualCheck");
  const gasUrl = APP_CONFIG.GAS_WEB_APP_URL;
  if (!gasUrl) {
    _ncShowManualCheck(cid, "GAS URL 없음 — 수동 확인 필요"); return;
  }
  try {
    const payload = {
      action: "verifyAddressMatch",
      naverRecipient: naver.recipient, naverPhone: naver.phone, naverAddress: naver.address,
      coupangRecipient: coupang.recipient, coupangPhone: coupang.phone, coupangAddress: coupang.address
    };
    let res = null;
    try { res = await gasPost(payload); } catch(e){ try { res = await gasGet(payload); } catch(e2){} }
    if (res?.ok && res.isSamePerson === true) {
      if (verifyEl) { verifyEl.className="nc-verify-box nc-verify-ok"; verifyEl.innerHTML=`<i class="fas fa-check-circle"></i> <b>AI 주소 비교: 동일인 확인</b> — ${escHtml(res.reason||"")}`; }
      if (manualEl) manualEl.style.display="none";
      window._ncVerifyPassed = true;
    } else if (res?.ok && res.isSamePerson === false) {
      if (verifyEl) { verifyEl.className="nc-verify-box nc-verify-fail"; verifyEl.innerHTML=`<i class="fas fa-times-circle"></i> <b>AI 주소 비교: 불일치</b> — ${escHtml(res.reason||"")}<br><span style="font-size:.78rem">아래 체크박스를 확인 후 제출하세요.</span>`; }
      if (manualEl) manualEl.style.display="";
      window._ncVerifyPassed = false;
    } else {
      // AI 비교 실패 → 수동 확인
      _ncShowManualCheck(cid, "AI 주소 비교 실패 — 수동 확인 필요");
    }
  } catch(err) {
    _ncShowManualCheck(cid, "AI 비교 오류: " + err.message);
  }
}

function _ncShowManualCheck(cid, reason) {
  const verifyEl = document.getElementById(cid + "_ncVerify");
  const manualEl = document.getElementById(cid + "_manualCheck");
  if (verifyEl) { verifyEl.className="nc-verify-box nc-verify-warn"; verifyEl.style.display=""; verifyEl.innerHTML=`<i class="fas fa-exclamation-triangle"></i> ${escHtml(reason)}`; }
  if (manualEl) manualEl.style.display="";
  window._ncVerifyPassed = false;
}

function _onManualCheckChange(cid) {
  const chk = document.getElementById(cid + "_manualChk");
  if (chk?.checked) { window._ncVerifyPassed = true; }
  else { window._ncVerifyPassed = false; }
}

/* ══════════════════════════════════════════════════════
   다건(多件) 구매양식 — 주문카드 관리 시스템
   ══════════════════════════════════════════════════════ */

const MAX_ORDER_CARDS = 5;
// 카드별 AI 상태 저장: { abortCtrl, countdownId, lastBase64, lastMime, extracted }
let _cardAiState = {};
// 현재 카드 목록 (DOM 순서 동기화)
let _orderCardIds = []; // e.g. ["oc_0","oc_1",...]

/** ── 카드 고유 ID 생성 ── */
let _cardSeq = 0;
function _newCardId() { return "oc_" + (_cardSeq++); }

/** ── 카운트 배지 업데이트 ── */
function _updateCardCountBadge() {
  const cnt = _orderCardIds.length;
  const badge = document.getElementById("addCardCountBadge");
  if (badge) badge.textContent = cnt + " / " + MAX_ORDER_CARDS;
  const addBtn = document.getElementById("btnAddOrderCard");
  if (addBtn) addBtn.disabled = (cnt >= MAX_ORDER_CARDS);
  // 다건 표시: 카드 2개 이상이면 제목에 (다건) 표기
  const titleEl = document.getElementById("orderFormTitle");
  if (titleEl) {
    const base = titleEl.textContent.replace(/\s*\(다건\)$/, "");
    titleEl.textContent = cnt > 1 ? base + " (다건)" : base;
  }
}

/** ── 선택된 주문자의 옵션 표시 (읽기 전용) ── */
function _showSelectedOptions(optionValues) {
  const wrap = document.getElementById("of_options_wrap");
  if (!wrap) return;
  const hasOption = _optionHeaders.length > 0 && optionValues.some(v => v && v.trim());
  if (!hasOption) { wrap.style.display = "none"; return; }
  const rows = _optionHeaders.map((header, i) => {
    const val = (optionValues[i] || "").trim();
    if (!header) return "";
    return `<div class="of-option-row">
      <span class="of-option-label">${escHtml(header)}</span>
      <span class="of-option-val">${val ? escHtml(val) : '<span style="color:#9CA3AF">없음</span>'}</span>
    </div>`;
  }).join("");
  document.getElementById("of_options_body").innerHTML = rows;
  wrap.style.display = "";
}

/** ── 주문카드 HTML 생성 (type: undefined=일반, "naver"=네이버+쿠팡 모드의 1번 카드) ── */
function _buildOrderCardHtml(cid, idx, type) {
  const isFirst = (idx === 0);
  const isNaverCard = (type === "naver");
  const badgeClass = isFirst ? (isNaverCard ? "ofc-badge badge-naver" : "ofc-badge") : "ofc-badge badge-extra";
  const cardClass  = isFirst ? (isNaverCard ? "of-order-card card-first card-naver" : "of-order-card card-first") : "of-order-card card-extra";
  const label      = isNaverCard ? "🛒 네이버쇼핑 주문" : (isFirst ? "1번째 주문" : (idx + 1) + "번째 주문");

  // 공유 체크박스는 카드 하단에 직접 삽입

  // 잠김 필드 클래스 (2번째~는 기본 잠금)
  const lockClass = isFirst ? "" : "ofc-same-fields-locked";

  return `
  <div class="${cardClass}" id="${cid}">
    <div class="ofc-header">
      <span class="${badgeClass}">
        <i class="fas fa-shopping-bag" style="font-size:.68rem"></i>
        <span class="ofc-badge-num">${label}</span>
      </span>
      ${isFirst ? "" : `<button class="ofc-remove-btn" onclick="removeOrderCard('${cid}')"><i class="fas fa-times"></i> 삭제</button>`}
    </div>

    <!-- AI 캡처 추출 섹션 -->
    <div class="ofc-ai-section">
      <div class="ofc-ai-section-title">📸 주문 캡처 자동추출 <span style="font-weight:400;color:#A5B4FC;font-size:.65rem">(선택)</span></div>
      <div class="of-img-zone" id="${cid}_imgZone"
           ondragover="event.preventDefault();this.classList.add('drag-over')"
           ondragleave="this.classList.remove('drag-over')"
           ondrop="onCardImgDrop(event,'${cid}')">
        <input type="file" accept="image/*" id="${cid}_imgInput" onchange="onCardImgSelected(this,'${cid}')">
        <span class="oiz-icon">📷</span>
        <div class="oiz-title" style="font-size:.82rem">주문캡처본 업로드 (AI 자동추출)</div>
        <div class="oiz-sub">클릭하거나 드래그 · JPG/PNG/WEBP</div>
      </div>
      <div class="of-img-preview" id="${cid}_imgPreview" style="display:none;align-items:center;gap:10px;margin-bottom:8px">
        <div style="position:relative;flex-shrink:0">
          <img id="${cid}_imgThumb" src="" alt="주문캡처" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1.5px solid #DDD6FE">
          <button class="oip-remove" onclick="removeCardImg('${cid}')" title="이미지 제거"><i class="fas fa-times"></i></button>
        </div>
        <span id="${cid}_imgLabel" style="font-size:.75rem;color:#6B7280">이미지 첨부됨</span>
      </div>
      <div class="ofc-ai-loading" id="${cid}_aiLoading">
        <i class="fas fa-circle-notch fa-spin" style="flex-shrink:0"></i>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span>AI가 주문 정보를 분석하고 있습니다…</span>
            <span id="${cid}_aiCountdown" style="font-size:.9rem;font-weight:800;color:#7C3AED;flex-shrink:0;min-width:18px;text-align:right"></span>
          </div>
          <div style="margin-top:5px;background:#DDD6FE;border-radius:99px;height:3px;overflow:hidden">
            <div id="${cid}_aiBar" style="height:100%;background:#7C3AED;width:100%;transition:width 1s linear;border-radius:99px"></div>
          </div>
        </div>
      </div>
      <div class="ofc-ai-result" id="${cid}_aiResult">
        <div class="of-ai-result-title"><i class="fas fa-magic"></i> AI 추출 결과 — 확인 후 적용하세요</div>
        <div class="of-ai-field"><span class="aif-label">주문번호</span><span class="aif-val" id="${cid}_aiOrder">-</span></div>
        <div class="of-ai-field"><span class="aif-label">수취인</span><span class="aif-val" id="${cid}_aiRecipient">-</span></div>
        <div class="of-ai-field"><span class="aif-label">전화번호</span><span class="aif-val" id="${cid}_aiPhone">-</span></div>
        <div class="of-ai-field"><span class="aif-label">주소</span><span class="aif-val" id="${cid}_aiAddress">-</span></div>
        <div class="of-ai-field"><span class="aif-label">결제금액</span><span class="aif-val" id="${cid}_aiPrice">-</span></div>
        <!-- ★ 별표 경고 배너 (쿠팡 캡처 등 *가 탐지될 때 표시) -->
        <div id="${cid}_asteriskWarn" style="display:none;margin:8px 0 6px;padding:9px 11px;background:#FEF2F2;border:1.5px solid #FCA5A5;border-radius:8px;font-size:.76rem;color:#991B1B;line-height:1.6">
          <i class="fas fa-exclamation-triangle" style="margin-right:5px;color:#EF4444"></i>
          <b>수취인·전화번호·주소에 별표(*)가 포함되어 있습니다.</b><br>
          쿠팡 주문 캡처본은 개인정보가 *로 가려집니다. 정보를 직접 입력해주세요.
        </div>
        <button class="of-ai-apply-btn" id="${cid}_aiApplyBtn" onclick="applyCardAiResult('${cid}')">
          <i class="fas fa-check-circle"></i> 위 정보를 입력칸에 적용하기
        </button>
      </div>
      <div class="ofc-ai-error" id="${cid}_aiError">
        <div style="display:flex;align-items:flex-start;gap:5px;margin-bottom:5px">
          <i class="fas fa-exclamation-circle" style="margin-top:1px;flex-shrink:0;color:#DC2626"></i>
          <span id="${cid}_aiErrorMsg"></span>
        </div>
        <button id="${cid}_aiRetryBtn" onclick="_retryCardAi('${cid}')" style="display:none;padding:4px 12px;background:#DC2626;color:#fff;border:none;border-radius:6px;font-size:.74rem;font-weight:700;cursor:pointer;width:100%">
          <i class="fas fa-redo" style="margin-right:3px"></i>다시 분석하기
        </button>
      </div>
    </div>

    <!-- 입력 폼 -->
    <div style="font-size:.68rem;font-weight:700;color:var(--t3);margin-bottom:10px;letter-spacing:.04em">✏️ 아래 정보를 입력해주세요</div>

    <!-- 옵션 선택 (1번 카드에만 표시됨, JS로 동적 처리) -->
    ${isFirst ? `
    <div id="of_option_picker_wrap" style="display:none" class="of-option-picker">
      <div class="of-option-picker-title"><i class="fas fa-list-ul"></i> 본인의 옵션을 선택해주세요</div>
      <div id="of_option_tabs" class="of-option-tabs"></div>
    </div>` : ""}

    <!-- 주문번호 -->
    <div class="of-field">
      <label class="of-label">주문번호</label>
      <input id="${cid}_orderNumber" class="of-input" type="text" placeholder="캡처 분석 후 자동기입">
    </div>

    <!-- 주문자 (공유 가능) -->
    <div id="${cid}_ordererWrap" class="${lockClass}">
      ${isFirst ? `
      <div class="of-field">
        <label class="of-label of-label-required" for="of_orderer">주문자</label>
        <div class="of-autocomplete-wrap">
          <input id="of_orderer" class="of-input" type="text" placeholder="자신외 선택금지, 없으면 직접입력" autocomplete="off"
            oninput="onOrdererInput(this);_ofClearError('of_orderer')" onkeydown="onOrdererKeydown(event)" onfocus="onOrdererFocus()" onblur="onOrdererBlur()">
          <div id="of_orderer_list" class="of-autocomplete-list" role="listbox"></div>
        </div>
      </div>
      <div class="of-error-msg" id="of_orderer_err"><i class="fas fa-exclamation-circle"></i> 주문자는 필수 입력 항목입니다.</div>
      <div id="of_options_wrap" style="display:none;margin-bottom:12px;padding:10px 14px;background:#F5F3FF;border:1.5px solid #DDD6FE;border-radius:10px">
        <div style="font-size:.68rem;font-weight:700;color:#7C3AED;margin-bottom:8px;letter-spacing:.03em"><i class="fas fa-box-open" style="margin-right:4px"></i>주문 옵션 내역 (변경 불가)</div>
        <div id="of_options_body"></div>
      </div>` : `
      <div class="of-field">
        <label class="of-label of-label-required" for="${cid}_orderer">주문자</label>
        <input id="${cid}_orderer" class="of-input" type="text" placeholder="주문자 이름">
      </div>`}
    </div>

    <!-- 아이디 (필수, 각 건마다 별도) -->
    <div class="of-field">
      <label class="of-label of-label-required" for="${cid}_userId">아이디</label>
      <input id="${cid}_userId" class="of-input" type="text" placeholder="쇼핑몰 아이디" oninput="_ofClearError('${cid}_userId')">
    </div>
    <div class="of-error-msg" id="${cid}_userId_err"><i class="fas fa-exclamation-circle"></i> 아이디는 필수 입력 항목입니다.</div>

    <!-- 수취인 -->
    <div class="of-field">
      <label class="of-label">수취인</label>
      <input id="${cid}_recipient" class="of-input" type="text" placeholder="수취인 이름">
    </div>
    <!-- 연락처 -->
    <div class="of-field">
      <label class="of-label">연락처</label>
      <input id="${cid}_phone" class="of-input" type="tel" placeholder="010-0000-0000" oninput="formatPhoneInput(this)" maxlength="13">
    </div>
    <!-- 배송주소 -->
    <div class="of-field">
      <label class="of-label">배송주소</label>
      <input id="${cid}_address" class="of-input" type="text" placeholder="배송받을 주소">
    </div>

    <!-- 은행/계좌/예금주 (공유 가능) -->
    <div id="${cid}_bankWrap" class="${lockClass}">
      ${isFirst ? `
      <div class="of-field">
        <label class="of-label">은행</label>
        <div class="of-autocomplete-wrap">
          <input id="of_bank" class="of-input" type="text" placeholder="은행명 (클릭시 선택도 가능)" autocomplete="off"
            oninput="onBankInput(this)" onkeydown="onBankKeydown(event)" onfocus="onBankFocus()" onblur="onBankBlur()">
          <div id="of_bank_list" class="of-autocomplete-list" role="listbox"></div>
        </div>
      </div>
      <div class="of-field">
        <label class="of-label">계좌</label>
        <input id="of_account" class="of-input" type="text" placeholder="계좌번호">
      </div>
      <div class="of-field">
        <label class="of-label">예금주</label>
        <input id="of_depositor" class="of-input" type="text" placeholder="예금주 이름">
      </div>` : `
      <div class="of-field">
        <label class="of-label">은행</label>
        <input id="${cid}_bank" class="of-input" type="text" placeholder="은행명" readonly style="background:#F9FAFB;color:var(--t3)">
      </div>
      <div class="of-field">
        <label class="of-label">계좌</label>
        <input id="${cid}_account" class="of-input" type="text" placeholder="계좌번호" readonly style="background:#F9FAFB;color:var(--t3)">
      </div>
      <div class="of-field">
        <label class="of-label">예금주</label>
        <input id="${cid}_depositor" class="of-input" type="text" placeholder="예금주" readonly style="background:#F9FAFB;color:var(--t3)">
      </div>`}
    </div>

    <!-- 결제금액 -->
    <div class="of-field">
      <label class="of-label">결제금액</label>
      <input id="${cid}_price" class="of-input" type="text" placeholder="결제한 금액 (예: 47,000)"
        oninput="formatPriceInput(this);this.classList.remove('ai-filled');this.dataset.userEdited='1';" inputmode="numeric">
    </div>

    <!-- 비고 (모든 카드에 표시) -->
    <div class="of-field" id="${cid}_memo_wrap">
      <label class="of-label" id="${cid}_memo_label">비고</label>
      <input id="${cid}_memo" class="of-input" type="text" placeholder="포스팅URL 또는 기타메모 입력">
    </div>

    <div style="font-size:.7rem;color:var(--t3);padding:6px 8px;background:var(--bg);border-radius:6px;border:1px solid var(--border)">
      <i class="fas fa-info-circle" style="color:#6B7280;margin-right:3px"></i>날짜는 제출 시점 기준으로 자동 입력됩니다.
    </div>

    ${!isFirst ? `
    <!-- 공유 체크 (하단 배치) -->
    <label class="ofc-same-row" id="${cid}_sameChkRow" for="${cid}_sameChk">
      <input type="checkbox" id="${cid}_sameChk" checked onchange="toggleSameInfo('${cid}')">
      <i class="fas fa-copy" style="font-size:.8rem"></i>
      주문자 / 은행 / 계좌 / 예금주를 1번째 주문과 동일하게 사용
    </label>` : ""}

    <!-- ★ v9.14: 소득신고 입력 (소득신고 모드일 때만 표시) -->
    <div id="${cid}_incomeBlock" style="display:none;margin-top:10px;padding:12px 14px;background:#F5F3FF;border:1.5px solid #A78BFA;border-radius:10px">
      <div style="font-size:.73rem;font-weight:700;color:#5B21B6;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
        <span><i class="fas fa-id-card" style="margin-right:4px"></i>소득신고 정보</span>
        ${!isFirst ? `<label style="font-size:.68rem;font-weight:600;color:#6D28D9;display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" id="${cid}_incomeSameChk" checked onchange="_toggleIncomeSame('${cid}')">
          1번 주문과 동일
        </label>` : ""}
      </div>
      ${isFirst ? `
      <!-- 1번 카드: 명의자 선택 버튼 -->
      <div id="${cid}_incomePersonBtns" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px"></div>` : ""}
      <div id="${cid}_incomeInputs" style="display:${isFirst ? "" : "none"};flex-direction:column;gap:6px">
        <div>
          <label style="font-size:.7rem;font-weight:700;color:#5B21B6;display:block;margin-bottom:2px">소득신고명의 <span style="color:#EF4444">*</span></label>
          <input id="${cid}_incomeName" type="text" placeholder="소득신고 명의자 이름"
            style="width:100%;padding:7px 10px;border:1.5px solid #A78BFA;border-radius:7px;font-size:.82rem;outline:none;font-family:inherit;box-sizing:border-box"
            onfocus="this.style.borderColor='#7C3AED'" onblur="this.style.borderColor='#A78BFA'">
        </div>
        <div>
          <label style="font-size:.7rem;font-weight:700;color:#5B21B6;display:block;margin-bottom:2px">주민등록번호 <span style="color:#EF4444">*</span> <span style="font-weight:400;color:#9CA3AF">13자리</span></label>
          <input id="${cid}_residentNo" type="text" placeholder="000000-0000000" maxlength="14"
            style="width:100%;padding:7px 10px;border:1.5px solid #A78BFA;border-radius:7px;font-size:.82rem;outline:none;font-family:inherit;box-sizing:border-box;letter-spacing:1px"
            onfocus="this.style.borderColor='#7C3AED'" onblur="this.style.borderColor='#A78BFA'"
            oninput="_formatCardResidentNo(this)">
          <div id="${cid}_residentNoHint" style="font-size:.66rem;color:#9CA3AF;margin-top:2px">숫자 13자리 자동 형식화</div>
        </div>
      </div>
    </div>
  </div>`;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ v9.14: 소득신고 섹션 관련 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 등록 모달용 주민등록번호 형식화 */
function _formatRegJuminNo(input) {
  let v = input.value.replace(/[^0-9]/g, "").slice(0, 13);
  if (v.length > 6) v = v.slice(0, 6) + "-" + v.slice(6);
  input.value = v;
}

/** 주민등록번호 자동 형식화 (000000-0000000) */
function _formatResidentNo(input) {
  let v = input.value.replace(/[^0-9]/g, "").slice(0, 13);
  if (v.length > 6) v = v.slice(0, 6) + "-" + v.slice(6);
  input.value = v;
  // 유효성 힌트
  const hint = document.getElementById("ofResidentNoHint");
  const digits = v.replace(/[^0-9]/g, "");
  if (hint) {
    if (digits.length === 13) {
      hint.textContent = "✅ 형식 올바름";
      hint.style.color = "#059669";
    } else if (digits.length > 0) {
      hint.textContent = `${digits.length}/13자리 입력됨`;
      hint.style.color = "#9CA3AF";
    } else {
      hint.textContent = "숫자 13자리 자동 형식화 (000000-0000000)";
      hint.style.color = "#9CA3AF";
    }
  }
}

/** 카드별 주민등록번호 자동 형식화 + 힌트 */
function _formatCardResidentNo(input) {
  let v = input.value.replace(/[^0-9]/g, "").slice(0, 13);
  if (v.length > 6) v = v.slice(0, 6) + "-" + v.slice(6);
  input.value = v;
  // cid 추출 (id 형식: {cid}_residentNo)
  const hintId = input.id.replace("_residentNo", "_residentNoHint");
  const hint = document.getElementById(hintId);
  const digits = v.replace(/[^0-9]/g, "");
  if (hint) {
    if (digits.length === 13) {
      hint.textContent = "✅ 형식 올바름";
      hint.style.color = "#059669";
    } else if (digits.length > 0) {
      hint.textContent = `${digits.length}/13자리 입력됨`;
      hint.style.color = "#9CA3AF";
    } else {
      hint.textContent = "숫자 13자리 자동 형식화";
      hint.style.color = "#9CA3AF";
    }
  }
}

/**
 * 카드의 "1번 주문과 동일" 체크박스 토글
 * - 체크: 입력란 숨기고 1번 카드 값 복사
 * - 해제: 입력란 표시 (독립 입력 가능)
 */
function _toggleIncomeSame(cid) {
  const chk = document.getElementById(cid + "_incomeSameChk");
  const inputsEl = document.getElementById(cid + "_incomeInputs");
  if (!chk || !inputsEl) return;

  if (chk.checked) {
    // 1번 카드 값 복사
    inputsEl.style.display = "none";
    _copyIncomeFromFirstCard(cid);
  } else {
    inputsEl.style.display = "flex";
  }
}

/** 1번 카드에서 소득정보 복사 */
function _copyIncomeFromFirstCard(targetCid) {
  const firstCid = _orderCardIds[0];
  if (!firstCid || firstCid === targetCid) return;
  const firstName  = (document.getElementById(firstCid + "_incomeName")?.value  || "");
  const firstJumin = (document.getElementById(firstCid + "_residentNo")?.value || "");
  const nameEl  = document.getElementById(targetCid + "_incomeName");
  const juminEl = document.getElementById(targetCid + "_residentNo");
  if (nameEl)  nameEl.value  = firstName;
  if (juminEl) juminEl.value = firstJumin;
}

/**
 * 소득신고 모드일 때 모든 카드의 incomeBlock을 표시하고 초기화
 * _initIncomeSection 대신 카드 단위로 처리
 */
function _initAllCardIncomeBlocks(incomeType, profileData) {
  if (incomeType !== "소득신고") return;

  _orderCardIds.forEach((cid, idx) => {
    const block = document.getElementById(cid + "_incomeBlock");
    if (!block) return;
    block.style.display = "";

    if (idx === 0) {
      // 1번 카드: 명의자 선택 버튼 생성
      _buildIncomePersonBtns(cid, profileData);
      // 기존 프로필 값 자동 채우기
      if (profileData) {
        const nameEl  = document.getElementById(cid + "_incomeName");
        const juminEl = document.getElementById(cid + "_residentNo");
        if (nameEl)  nameEl.value  = profileData.incomeName || "";
        if (juminEl) {
          let rn = (profileData.jumin || profileData.residentNo || "").replace(/[^0-9]/g, "");
          if (rn.length > 6) rn = rn.slice(0,6) + "-" + rn.slice(6);
          juminEl.value = rn;
          _formatCardResidentNo(juminEl);
        }
      }
    } else {
      // 2번째+ 카드: "1번과 동일" 기본 체크 → 값 복사
      const chk = document.getElementById(cid + "_incomeSameChk");
      const inputsEl = document.getElementById(cid + "_incomeInputs");
      if (chk && chk.checked && inputsEl) {
        inputsEl.style.display = "none";
        _copyIncomeFromFirstCard(cid);
      }
    }
  });
}

/** 카드의 명의자 선택 버튼 생성 (1번 카드 전용) */
function _buildIncomePersonBtns(cid, profileData) {
  const btnsWrap = document.getElementById(cid + "_incomePersonBtns");
  if (!btnsWrap) return;
  btnsWrap.innerHTML = "";

  const selfName = profileData?.name || "";
  const selfBtn = document.createElement("button");
  selfBtn.type = "button";
  selfBtn.textContent = "본인" + (selfName ? ` (${selfName})` : "");
  selfBtn.style.cssText = "padding:5px 10px;border:1.5px solid #A78BFA;border-radius:16px;background:#EDE9FE;color:#5B21B6;font-size:.72rem;font-weight:700;cursor:pointer";
  selfBtn.onclick = () => _selectCardIncomePerson(cid, selfBtn, profileData, -1);
  btnsWrap.appendChild(selfBtn);

  const subs = profileData?.subAccounts || [];
  subs.forEach((sub, idx) => {
    const subBtn = document.createElement("button");
    subBtn.type = "button";
    subBtn.textContent = sub.name + (sub.phone ? ` (${sub.phone.slice(-4)})` : "");
    subBtn.style.cssText = "padding:5px 10px;border:1.5px solid #D1D5DB;border-radius:16px;background:#fff;color:#374151;font-size:.72rem;font-weight:600;cursor:pointer";
    subBtn.onclick = () => _selectCardIncomePerson(cid, subBtn, profileData, idx);
    btnsWrap.appendChild(subBtn);
  });

  if (profileData) _selectCardIncomePerson(cid, selfBtn, profileData, -1);
}

/** 카드에서 명의자 선택 시 입력란 자동 채우기 */
function _selectCardIncomePerson(cid, selectedBtn, profileData, personIdx) {
  const btnsWrap = document.getElementById(cid + "_incomePersonBtns");
  if (btnsWrap) {
    btnsWrap.querySelectorAll("button").forEach(b => {
      b.style.background   = "#fff";
      b.style.borderColor  = "#D1D5DB";
      b.style.color        = "#374151";
    });
    if (selectedBtn) {
      selectedBtn.style.background  = "#EDE9FE";
      selectedBtn.style.borderColor = "#7C3AED";
      selectedBtn.style.color       = "#5B21B6";
    }
  }

  let incomeName = "";
  let residentNo = "";

  if (personIdx === -1) {
    incomeName = profileData?.incomeName || "";
    residentNo = profileData?.jumin || profileData?.residentNo || "";
  } else {
    const sub = (profileData?.subAccounts || [])[personIdx];
    if (sub) {
      incomeName = sub.incomeName || "";
      residentNo = sub.jumin || sub.residentNo || "";
    }
  }

  const nameEl  = document.getElementById(cid + "_incomeName");
  const juminEl = document.getElementById(cid + "_residentNo");
  if (nameEl)  nameEl.value = incomeName;
  if (juminEl) {
    let rn = residentNo.replace(/[^0-9]/g, "");
    if (rn.length > 6) rn = rn.slice(0,6) + "-" + rn.slice(6);
    juminEl.value = rn;
    _formatCardResidentNo(juminEl);
  }

  // 2번째+ 카드에도 동일 값 자동 복사 (동일 체크된 카드만)
  _orderCardIds.slice(1).forEach(subCid => {
    const subChk = document.getElementById(subCid + "_incomeSameChk");
    if (subChk?.checked) _copyIncomeFromFirstCard(subCid);
  });
}

/** 카드별 소득입력 유효성 검사 → { ok, incomeName, residentNo } */
function _validateCardIncomeInput(cid) {
  const incomeType = window._incomeType || "";
  if (incomeType !== "소득신고") return { ok: true, incomeName: "", residentNo: "" };

  const incomeName = (document.getElementById(cid + "_incomeName")?.value || "").trim();
  const residentNo = (document.getElementById(cid + "_residentNo")?.value || "").replace(/[^0-9]/g, "");

  if (!incomeName) {
    const el = document.getElementById(cid + "_incomeName");
    if (el) { el.style.borderColor = "#EF4444"; el.focus(); }
    showToast(`${cid === _orderCardIds[0] ? "1번" : ((_orderCardIds.indexOf(cid)+1)+"번")}주문: 소득신고명의를 입력해주세요.`, "warning");
    return { ok: false };
  }
  if (residentNo.length !== 13) {
    const el = document.getElementById(cid + "_residentNo");
    if (el) { el.style.borderColor = "#EF4444"; el.focus(); }
    showToast(`${cid === _orderCardIds[0] ? "1번" : ((_orderCardIds.indexOf(cid)+1)+"번")}주문: 주민등록번호 13자리를 정확히 입력해주세요.`, "warning");
    return { ok: false };
  }
  return { ok: true, incomeName, residentNo };
}

/** 소득신고 모드: 카드 추가 시 incomeBlock 표시 + "동일" 복사 */
function _onCardAddedIncome(cid, idx) {
  if (window._incomeType !== "소득신고") return;
  const block = document.getElementById(cid + "_incomeBlock");
  if (!block) return;
  block.style.display = "";

  if (idx > 0) {
    const chk = document.getElementById(cid + "_incomeSameChk");
    const inputsEl = document.getElementById(cid + "_incomeInputs");
    if (chk?.checked && inputsEl) {
      inputsEl.style.display = "none";
      _copyIncomeFromFirstCard(cid);
    }
  }
}

/** 소득신고 섹션 표시/숨김 + 명의자 버튼 생성
 *  ★ v9.14 갱신: 공통 섹션(ofIncomeSection) 숨기고 카드별 incomeBlock으로 위임
 */
function _initIncomeSection(incomeType, profileData) {
  // 공통 섹션은 더 이상 사용하지 않음 (카드별 incomeBlock으로 교체)
  const section = document.getElementById("ofIncomeSection");
  if (section) section.style.display = "none";

  if (incomeType !== "소득신고") return;

  // 카드별 초기화
  _initAllCardIncomeBlocks(incomeType, profileData);
}

/** 소득신고 명의자 선택 시 입력란 자동 채우기 */
function _selectIncomePerson(selectedBtn, profileData, personIdx) {
  // 버튼 선택 상태 업데이트
  const btnsWrap = document.getElementById("ofIncomePersonBtns");
  if (btnsWrap) {
    btnsWrap.querySelectorAll("button").forEach(b => {
      b.style.background = "#fff";
      b.style.borderColor = "#D1D5DB";
      b.style.color = "#374151";
    });
    if (selectedBtn) {
      selectedBtn.style.background = "#EDE9FE";
      selectedBtn.style.borderColor = "#7C3AED";
      selectedBtn.style.color = "#5B21B6";
    }
  }

  const incomeNameEl  = document.getElementById("ofIncomeName");
  const residentNoEl  = document.getElementById("ofResidentNo");

  let incomeName = "";
  let residentNo = "";

  if (personIdx === -1) {
    // 본인
    incomeName = profileData?.incomeName || "";
    residentNo = profileData?.jumin || profileData?.residentNo || "";
    window._selectedIncomePersonIdx = -1;
  } else {
    // 타계정
    const sub = (profileData?.subAccounts || [])[personIdx];
    if (sub) {
      incomeName = sub.incomeName || "";
      residentNo = sub.jumin || sub.residentNo || "";
    }
    window._selectedIncomePersonIdx = personIdx;
  }

  if (incomeNameEl)  incomeNameEl.value = incomeName;
  if (residentNoEl) {
    // 저장된 주민번호는 마스킹하지 않고 그대로 표시 (입력 수정 가능)
    let rn = residentNo.replace(/[^0-9]/g, "");
    if (rn.length > 6) rn = rn.slice(0,6) + "-" + rn.slice(6);
    residentNoEl.value = rn;
    _formatResidentNo(residentNoEl);
  }
}

/** 소득신고 입력값 유효성 검사 → { ok, incomeName, residentNo } */
function _validateIncomeInput() {
  const incomeType = window._incomeType || "";
  if (incomeType !== "소득신고") return { ok: true, incomeName: "", residentNo: "" };

  const incomeName = (document.getElementById("ofIncomeName")?.value || "").trim();
  const residentNo = (document.getElementById("ofResidentNo")?.value || "").replace(/[^0-9]/g, "");

  if (!incomeName) {
    _ofShowError("ofIncomeName");
    showToast("소득신고명의를 입력해주세요.", "warning");
    document.getElementById("ofIncomeName")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return { ok: false };
  }
  if (residentNo.length !== 13) {
    _ofShowError("ofResidentNo");
    showToast("주민등록번호 13자리를 정확히 입력해주세요.", "warning");
    document.getElementById("ofResidentNo")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return { ok: false };
  }
  return { ok: true, incomeName, residentNo };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ v9.14: 리뷰어 프로필 / 타계정 관리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 현재 인증된 리뷰어의 프로필 로드 → 소득신고 섹션 초기화 */
async function _loadReviewerProfileForForm() {
  const incomeType = window._incomeType || "";
  if (incomeType !== "소득신고") return;

  const authRaw = localStorage.getItem("rapp_reviewer_auth");
  if (!authRaw) return;
  let auth;
  try { auth = JSON.parse(authRaw); } catch(_) { return; }
  if (!auth || Date.now() > (auth.exp || 0)) return;

  const name   = auth.name   || "";
  const phone8 = auth.phone8 || "";
  if (!name || !phone8) return;

  try {
    const res = await gasGet({ action: "getReviewerProfile", name, phone8 });
    if (res?.ok && res.found) {
      window._reviewerProfile = res;
      _initIncomeSection(incomeType, res);
    } else {
      // 프로필 없어도 섹션은 표시 (직접 입력)
      _initIncomeSection(incomeType, null);
    }
  } catch(e) {
    console.warn("[loadReviewerProfile]", e.message);
    _initIncomeSection(incomeType, null);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ v9.14: 리뷰어 프로필 모달 관련 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 타계정 주민번호 형식화 */
function _formatSubAccJumin(input) {
  let v = input.value.replace(/[^0-9]/g, "").slice(0, 13);
  if (v.length > 6) v = v.slice(0, 6) + "-" + v.slice(6);
  input.value = v;
}

/** 리뷰어 프로필 모달 열기 */
async function openReviewerProfileModal() {
  const modal = document.getElementById("reviewerProfileModal");
  if (!modal) return;

  // 인증 세션 확인
  const authRaw = localStorage.getItem("rapp_reviewer_auth");
  if (!authRaw) { showToast("로그인 후 이용하세요.", "warning"); return; }
  let auth;
  try { auth = JSON.parse(authRaw); } catch(_) { return; }
  if (!auth || Date.now() > (auth.exp || 0)) { showToast("세션이 만료되었습니다. 다시 로그인해주세요.", "warning"); return; }

  const name   = auth.name   || "";
  const phone8 = auth.phone8 || "";

  modal.style.display = "flex";

  // 로딩 표시
  document.getElementById("rpmSelfName").textContent  = "로딩 중...";
  document.getElementById("rpmSubList").innerHTML = '<div style="text-align:center;padding:16px;color:var(--t3);font-size:.8rem"><i class="fas fa-spinner fa-spin"></i> 로딩 중...</div>';

  try {
    const res = await gasGet({ action: "getReviewerProfile", name, phone8 });
    if (res?.ok && res.found) {
      window._reviewerProfile = res;
      _renderReviewerProfileModal(res);
    } else {
      document.getElementById("rpmSelfName").textContent = name || "미등록";
      document.getElementById("rpmSelfPhone").textContent = "정보를 불러올 수 없습니다.";
      document.getElementById("rpmSubList").innerHTML = '<div style="text-align:center;padding:16px;color:var(--t3);font-size:.8rem">등록 정보를 찾을 수 없습니다.</div>';
    }
  } catch(e) {
    document.getElementById("rpmSelfName").textContent = "로드 실패: " + e.message;
  }
}

/** 프로필 모달 데이터 렌더링 */
function _renderReviewerProfileModal(profile) {
  const name       = profile.name || "";
  const phone      = profile.phone || "";
  const incomeName = profile.incomeName || "";
  const jumin      = profile.jumin || profile.residentNo || "";
  const subs       = profile.subAccounts || [];

  document.getElementById("rpmSelfName").textContent       = name || "-";
  document.getElementById("rpmSelfPhone").textContent      = phone || "-";
  document.getElementById("rpmSelfIncomeName").textContent = incomeName || "미등록";
  // 주민번호 마스킹 표시: 앞6자리-뒤1자리만 표시
  const juminDigits = jumin.replace(/[^0-9]/g, "");
  document.getElementById("rpmSelfJumin").textContent      = juminDigits.length === 13
    ? juminDigits.slice(0,6) + "-" + juminDigits.slice(6,7) + "••••••"
    : (juminDigits ? "등록됨" : "미등록");

  // 타계정 목록 렌더링
  const subList = document.getElementById("rpmSubList");
  document.getElementById("rpmSubCount").textContent = subs.length + "/10";

  if (subs.length === 0) {
    subList.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t3);font-size:.8rem">타계정이 없습니다.<br><span style="font-size:.72rem">우측 상단 "타계정 추가" 버튼으로 추가하세요.</span></div>';
    return;
  }

  subList.innerHTML = subs.map((sub, idx) => {
    const subJuminDigits = (sub.jumin || sub.residentNo || "").replace(/[^0-9]/g, "");
    const juminDisplay = subJuminDigits.length === 13
      ? subJuminDigits.slice(0,6) + "-" + subJuminDigits.slice(6,7) + "••••••"
      : (subJuminDigits ? "등록됨" : "-");
    return `
    <div style="background:#fff;border:1.5px solid #E5E7EB;border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:.82rem;font-weight:700;color:var(--t1);margin-bottom:2px">[${idx+1}] ${escHtml(sub.name)} <span style="font-weight:400;color:var(--t3);font-size:.72rem">${escHtml(sub.phone||'')}</span></div>
        <div style="font-size:.72rem;color:var(--t3)">소득명의: <span style="color:var(--t2)">${escHtml(sub.incomeName||'-')}</span> &nbsp;|&nbsp; 주민번호: <span style="color:var(--t2)">${juminDisplay}</span></div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button onclick="editSubAccount(${idx})" style="padding:3px 8px;background:#EFF6FF;color:#2563EB;border:1.5px solid #93C5FD;border-radius:6px;font-size:.68rem;font-weight:700;cursor:pointer">수정</button>
        <button onclick="deleteSubAccount(${idx})" style="padding:3px 8px;background:#FEF2F2;color:#DC2626;border:1.5px solid #FECACA;border-radius:6px;font-size:.68rem;font-weight:700;cursor:pointer">삭제</button>
      </div>
    </div>`;
  }).join("");

  // 최대 10개 도달 시 추가 버튼 비활성화
  const addBtn = document.getElementById("btnAddSubAccount");
  if (addBtn) addBtn.disabled = subs.length >= 10;
}

/** 타계정 추가 폼 열기 */
function openAddSubAccountForm() {
  document.getElementById("subAccountFormTitle").textContent = "타계정 추가";
  document.getElementById("subAccountEditIdx").value = "-1";
  document.getElementById("subAccName").value = "";
  document.getElementById("subAccPhone").value = "";
  document.getElementById("subAccIncomeName").value = "";
  document.getElementById("subAccJumin").value = "";
  document.getElementById("subAccountForm").style.display = "";
}

/** 타계정 수정 폼 열기 */
function editSubAccount(idx) {
  const profile = window._reviewerProfile;
  const subs = profile?.subAccounts || [];
  if (idx < 0 || idx >= subs.length) return;
  const sub = subs[idx];

  document.getElementById("subAccountFormTitle").textContent = "타계정 수정 [" + (idx+1) + "]";
  document.getElementById("subAccountEditIdx").value = String(idx);
  document.getElementById("subAccName").value = sub.name || "";
  document.getElementById("subAccPhone").value = (sub.phone || "").replace(/[^0-9]/g, "");
  document.getElementById("subAccIncomeName").value = sub.incomeName || "";
  // 주민번호 복원 (편집 가능하도록 원본 숫자 표시)
  const jd = (sub.jumin || sub.residentNo || "").replace(/[^0-9]/g, "");
  let jv = jd;
  if (jv.length > 6) jv = jv.slice(0,6) + "-" + jv.slice(6);
  document.getElementById("subAccJumin").value = jv;
  document.getElementById("subAccountForm").style.display = "";
}

/** 타계정 추가/수정 취소 */
function cancelSubAccountForm() {
  document.getElementById("subAccountForm").style.display = "none";
}

/** 타계정 저장 (추가 or 수정) */
async function saveSubAccount() {
  const name      = (document.getElementById("subAccName")?.value || "").trim();
  const phone     = (document.getElementById("subAccPhone")?.value || "").replace(/[^0-9]/g, "");
  const incomeName = (document.getElementById("subAccIncomeName")?.value || "").trim();
  const juminDigits = (document.getElementById("subAccJumin")?.value || "").replace(/[^0-9]/g, "");
  const editIdx   = parseInt(document.getElementById("subAccountEditIdx")?.value || "-1", 10);

  if (!name) { showToast("이름을 입력해주세요.", "warning"); return; }
  if (phone.length !== 11) { showToast("전화번호는 11자리 숫자여야 합니다.", "warning"); return; }
  if (juminDigits && juminDigits.length !== 13) { showToast("주민번호는 13자리 숫자여야 합니다.", "warning"); return; }

  // 인증 세션
  const authRaw = localStorage.getItem("rapp_reviewer_auth");
  let auth;
  try { auth = JSON.parse(authRaw || "{}"); } catch(_) { auth = {}; }
  const myName   = auth.name   || "";
  const myPhone8 = auth.phone8 || "";
  if (!myName || !myPhone8) { showToast("세션이 만료되었습니다.", "warning"); return; }

  // 현재 프로필 복사 후 수정
  const profile  = window._reviewerProfile;
  const subs     = JSON.parse(JSON.stringify(profile?.subAccounts || []));

  const newSub = {
    name,
    phone: phone.slice(0,3) + "-" + phone.slice(3,7) + "-" + phone.slice(7),
    incomeName,
    jumin: juminDigits
  };

  if (editIdx >= 0 && editIdx < subs.length) {
    subs[editIdx] = newSub; // 수정
  } else {
    if (subs.length >= 10) { showToast("타계정은 최대 10개까지 등록 가능합니다.", "warning"); return; }
    subs.push(newSub); // 추가
  }

  const btn = document.getElementById("btnSaveSubAccount");
  if (btn) { btn.disabled = true; btn.textContent = "저장 중..."; }

  try {
    const res = await gasPost({
      action: "saveSubAccounts",
      name: myName,
      phone8: myPhone8,
      subAccounts: JSON.stringify(subs)
    });
    if (res?.ok) {
      showToast(editIdx >= 0 ? "타계정이 수정되었습니다." : "타계정이 추가되었습니다.");
      // 프로필 갱신
      if (!window._reviewerProfile) window._reviewerProfile = {};
      window._reviewerProfile.subAccounts = subs;
      _renderReviewerProfileModal(window._reviewerProfile);
      cancelSubAccountForm();
    } else {
      showToast("❌ " + (res?.error || "저장에 실패했습니다."), "error");
    }
  } catch(e) {
    showToast("❌ 오류: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "저장"; }
  }
}

/** 타계정 삭제 */
async function deleteSubAccount(idx) {
  if (!confirm((idx+1) + "번 타계정을 삭제하시겠습니까?")) return;

  const authRaw = localStorage.getItem("rapp_reviewer_auth");
  let auth;
  try { auth = JSON.parse(authRaw || "{}"); } catch(_) { auth = {}; }
  const myName   = auth.name   || "";
  const myPhone8 = auth.phone8 || "";
  if (!myName || !myPhone8) { showToast("세션이 만료되었습니다.", "warning"); return; }

  const profile = window._reviewerProfile;
  const subs    = JSON.parse(JSON.stringify(profile?.subAccounts || []));
  if (idx < 0 || idx >= subs.length) return;
  subs.splice(idx, 1);

  try {
    const res = await gasPost({
      action: "saveSubAccounts",
      name: myName,
      phone8: myPhone8,
      subAccounts: JSON.stringify(subs)
    });
    if (res?.ok) {
      showToast("타계정이 삭제되었습니다.");
      if (window._reviewerProfile) window._reviewerProfile.subAccounts = subs;
      _renderReviewerProfileModal(window._reviewerProfile);
    } else {
      showToast("❌ " + (res?.error || "삭제 실패"), "error");
    }
  } catch(e) {
    showToast("❌ 오류: " + e.message, "error");
  }
}

/** 리뷰어 프로필 모달 닫기 */
function closeReviewerProfileModal() {
  const modal = document.getElementById("reviewerProfileModal");
  if (modal) modal.style.display = "none";
  cancelSubAccountForm();
}

/** ── 주문카드 추가 ── */
function addOrderCard() {
  if (_orderCardIds.length >= MAX_ORDER_CARDS) {
    showToast("최대 " + MAX_ORDER_CARDS + "건까지만 추가할 수 있습니다.", "warning");
    return;
  }
  const cid = _newCardId();
  const idx = _orderCardIds.length;
  _orderCardIds.push(cid);
  _cardAiState[cid] = { abortCtrl: null, countdownId: null, lastBase64: "", lastMime: "", extracted: null };

  const wrap = document.getElementById("ofOrderCardsWrap");
  const tmp = document.createElement("div");
  tmp.innerHTML = _buildOrderCardHtml(cid, idx);
  const cardEl = tmp.firstElementChild;
  wrap.appendChild(cardEl);

  // 2번째~: 체크박스 동기화 초기값 설정
  if (idx > 0) { _syncSharedInfoToCard(cid); }

  // ★ v9.14: 소득신고 모드면 카드 incomeBlock 표시
  _onCardAddedIncome(cid, idx);

  _updateCardCountBadge();
  // 스크롤
  setTimeout(() => cardEl.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
}

/** ── 주문카드 삭제 ── */
function removeOrderCard(cid) {
  if (_orderCardIds.length <= 1) return; // 첫 번째는 삭제 불가
  // AI 진행중이면 중단
  const st = _cardAiState[cid];
  if (st) { if (st.abortCtrl) st.abortCtrl.abort(); if (st.countdownId) clearInterval(st.countdownId); }
  delete _cardAiState[cid];
  _orderCardIds = _orderCardIds.filter(id => id !== cid);

  const el = document.getElementById(cid);
  if (el) el.remove();
  _updateCardCountBadge();
}

/** ── 공유 토글 (주문자/은행/예금주 동일 사용) ── */
function toggleSameInfo(cid) {
  const chk = document.getElementById(cid + "_sameChk");
  if (!chk) return;
  if (chk.checked) {
    _syncSharedInfoToCard(cid);
    _lockSharedFields(cid, true);
  } else {
    _lockSharedFields(cid, false);
  }
}

/** ── 1번 카드 값을 N번 카드에 복사 + 초록 AI 추출 색상 적용 ── */
function _syncSharedInfoToCard(cid) {
  const firstCid = _orderCardIds[0];
  if (!firstCid) return;
  // 주문자
  const firstOrderer = document.getElementById("of_orderer")?.value || "";
  const targetOrderer = document.getElementById(cid + "_orderer");
  if (targetOrderer) { targetOrderer.value = firstOrderer; _markCopied(targetOrderer, !!firstOrderer); }
  // 은행
  const firstBank = document.getElementById("of_bank")?.value || "";
  const targetBank = document.getElementById(cid + "_bank");
  if (targetBank) { targetBank.value = firstBank; _markCopied(targetBank, !!firstBank); }
  // 계좌
  const firstAccount = document.getElementById("of_account")?.value || "";
  const targetAccount = document.getElementById(cid + "_account");
  if (targetAccount) { targetAccount.value = firstAccount; _markCopied(targetAccount, !!firstAccount); }
  // 예금주
  const firstDepositor = document.getElementById("of_depositor")?.value || "";
  const targetDepositor = document.getElementById(cid + "_depositor");
  if (targetDepositor) { targetDepositor.value = firstDepositor; _markCopied(targetDepositor, !!firstDepositor); }
}

/** ── 복사된 필드에 초록 반영 표시 (혼동으로 말하여 ai-filled 공유) ── */
function _markCopied(el, haVal) {
  if (!el) return;
  if (haVal) { el.classList.add("ai-filled"); }
  else { el.classList.remove("ai-filled"); }
}

/** ── 공유 필드 잠금/해제 ── */
function _lockSharedFields(cid, lock) {
  ["ordererWrap","bankWrap"].forEach(suffix => {
    const el = document.getElementById(cid + "_" + suffix);
    if (!el) return;
    if (lock) {
      el.classList.add("ofc-same-fields-locked");
      // readonly + 초록 반영 표시
      [cid+"_orderer",cid+"_bank",cid+"_account",cid+"_depositor"].forEach(fid => {
        const f = document.getElementById(fid);
        if (f) {
          f.setAttribute("readonly","");
          f.style.background="";
          f.style.color="";
          // 값이 있으면 초록(ai-filled) 표시
          if (f.value) f.classList.add("ai-filled");
        }
      });
    } else {
      el.classList.remove("ofc-same-fields-locked");
      [cid+"_orderer",cid+"_bank",cid+"_account",cid+"_depositor"].forEach(fid => {
        const f = document.getElementById(fid);
        if (f) {
          f.removeAttribute("readonly");
          f.style.background="";
          f.style.color="";
          f.classList.remove("ai-filled", "ai-locked");
          f.readOnly = false;
        }
      });
    }
  });
}

/** ── 제출 직전 2번째~ 카드 공유 값 최종 동기화 ── */
function _syncAllSharedBeforeSubmit() {
  _orderCardIds.forEach((cid, idx) => {
    if (idx === 0) return;
    const chk = document.getElementById(cid + "_sameChk");
    if (chk && chk.checked) _syncSharedInfoToCard(cid);
  });
}

/* ══════════════════════════════════
   카드별 AI 이미지 처리
   ══════════════════════════════════ */

function onCardImgSelected(input, cid) {
  if (!input.files || !input.files[0]) return;
  _processCardImgFile(input.files[0], cid);
}

function onCardImgDrop(e, cid) {
  e.preventDefault();
  const zone = document.getElementById(cid + "_imgZone");
  if (zone) zone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith("image/")) { showToast("이미지 파일만 업로드 가능합니다.", true); return; }
  _processCardImgFile(file, cid);
}

function removeCardImg(cid) {
  const st = _cardAiState[cid];
  if (st) { if (st.abortCtrl) { st.abortCtrl.abort(); st.abortCtrl = null; } if (st.countdownId) { clearInterval(st.countdownId); st.countdownId = null; } st.lastBase64=""; st.lastMime=""; st.extracted=null; }
  const inp  = document.getElementById(cid + "_imgInput");  if (inp) inp.value = "";
  const prev = document.getElementById(cid + "_imgPreview"); if (prev) { prev.style.display="none"; document.getElementById(cid+"_imgThumb").src=""; }
  const zone = document.getElementById(cid + "_imgZone");   if (zone) zone.style.display = "";
  document.getElementById(cid+"_aiLoading").classList.remove("show");
  document.getElementById(cid+"_aiResult").classList.remove("show");
  document.getElementById(cid+"_aiError").style.display = "none";
  // ★ ai-locked 필드 잠금 해제 헬퍼
  function _unlockAiField(fid) {
    const f = document.getElementById(fid);
    if (!f) return;
    f.classList.remove("ai-filled", "ai-locked");
    f.readOnly = false;
    f.removeAttribute("tabindex");
    f.style.paddingRight = "";
    // 자물쇠 배지 제거
    const badge = f.parentElement?.querySelector(".ai-lock-badge");
    if (badge) badge.remove();
    if (f.parentElement) f.parentElement.style.position = "";
  }
  [cid+"_recipient", cid+"_phone", cid+"_address",
   cid+"_orderNumber", cid+"_price"].forEach(_unlockAiField);
  // oninput 핸들러 복원 (price)
  const priceEl = document.getElementById(cid+"_price");
  if (priceEl) priceEl.setAttribute("oninput", `formatPriceInput(this);this.classList.remove('ai-filled');this.dataset.userEdited='1';_ofClearError('${cid}_price')`);
}

function _processCardImgFile(file, cid) {
  if (file.size > 10 * 1024 * 1024) { showToast("이미지 크기는 10MB 이하여야 합니다.", true); return; }
  const reader = new FileReader();
  reader.onload = async function(ev) {
    const dataUrl = ev.target.result;
    document.getElementById(cid+"_imgThumb").src = dataUrl;
    document.getElementById(cid+"_imgPreview").style.display = "flex";
    document.getElementById(cid+"_imgZone").style.display = "none";
    document.getElementById(cid+"_aiResult").classList.remove("show");
    document.getElementById(cid+"_aiError").style.display = "none";
    const lbl = document.getElementById(cid+"_imgLabel"); if (lbl) lbl.textContent = file.name + " · AI 분석 중…";
    const base64 = dataUrl.split(",")[1];
    const mimeType = file.type || "image/jpeg";
    await _callCardExtractAi(cid, base64, mimeType);
  };
  reader.readAsDataURL(file);
}

function _retryCardAi(cid) {
  const st = _cardAiState[cid]; if (!st || !st.lastBase64) return;
  document.getElementById(cid+"_aiError").style.display = "none";
  document.getElementById(cid+"_aiResult").classList.remove("show");
  const lbl = document.getElementById(cid+"_imgLabel"); if (lbl) lbl.textContent = "AI 분석 중…";
  _callCardExtractAi(cid, st.lastBase64, st.lastMime);
}

async function _callCardExtractAi(cid, base64, mimeType) {
  const st = _cardAiState[cid]; if (!st) return;
  const gasUrl = APP_CONFIG.GAS_WEB_APP_URL;
  if (!gasUrl) { _showCardAiError(cid, "GAS 웹앱 URL이 설정되지 않았습니다.", false); return; }
  st.lastBase64 = base64; st.lastMime = mimeType;

  // 로딩 UI 시작
  document.getElementById(cid+"_aiLoading").classList.add("show");
  document.getElementById(cid+"_aiError").style.display = "none";

  // 카운트다운
  if (st.countdownId) clearInterval(st.countdownId);
  let remaining = 15;
  const countEl = document.getElementById(cid+"_aiCountdown");
  const barEl   = document.getElementById(cid+"_aiBar");
  const tick = () => {
    if (countEl) { countEl.textContent = remaining; countEl.style.color = remaining<=3?"#DC2626":"#7C3AED"; }
    if (barEl)   barEl.style.width = (remaining/15*100)+"%";
    remaining--;
  };
  tick();
  st.countdownId = setInterval(tick, 1000);

  // Abort
  if (st.abortCtrl) st.abortCtrl.abort();
  st.abortCtrl = new AbortController();
  const tid = setTimeout(() => { st.abortCtrl.abort(); st.abortCtrl = null; }, 15000);

  try {
    const payload = { action: "extractOrderImage", imageBase64: base64, mimeType };
    let json;
    try {
      // ★ [Node.js 이관] gasPostUpload()를 통해 API 서버로 전송 (업로드 진행률 표시)
      json = await gasPostUpload(payload);
      clearTimeout(tid);
    } catch(fe) {
      clearTimeout(tid);
      _stopCardCountdown(cid);
      document.getElementById(cid+"_aiLoading").classList.remove("show");
      _showCardAiError(cid, fe.name==="AbortError" ? "⏱ 15초 안에 응답이 없었습니다." : "이미지 전송 실패: "+fe.message, true);
      return;
    }
    _stopCardCountdown(cid);
    document.getElementById(cid+"_aiLoading").classList.remove("show");
    const lblDone = document.getElementById(cid+"_imgLabel"); if (lblDone) lblDone.textContent = "분석 완료 ✓";
    if (!json || json.error) { _showCardAiError(cid, json?.error||"알 수 없는 오류", true); return; }

    st.extracted = { orderNumber: json.orderNumber||"", recipient: json.recipient||"", phone: json.phone||"", address: json.address||"", price: json.price||"" };
    _showCardAiResult(cid, st.extracted);

    // 주문번호 자동 입력
    if (st.extracted.orderNumber) {
      const orderEl = document.getElementById(cid+"_orderNumber");
      if (orderEl && !orderEl.value) { orderEl.value = st.extracted.orderNumber; orderEl.classList.add("ai-filled"); }
    }

    // ★ nc 모드에서 2번 카드(쿠팡) 업로드 시 동일인 검증 자동 실행
    if (window._ncMode && _orderCardIds.indexOf(cid) === 1) {
      _ncVerifyIdentity(cid, st.extracted);
    }
  } catch(err) {
    _stopCardCountdown(cid);
    document.getElementById(cid+"_aiLoading").classList.remove("show");
    _showCardAiError(cid, err.message, true);
  }
}

function _stopCardCountdown(cid) {
  const st = _cardAiState[cid]; if (!st) return;
  if (st.countdownId) { clearInterval(st.countdownId); st.countdownId = null; }
  const countEl = document.getElementById(cid+"_aiCountdown");
  const barEl   = document.getElementById(cid+"_aiBar");
  if (countEl) { countEl.textContent=""; countEl.style.color="#7C3AED"; }
  if (barEl)   barEl.style.width = "100%";
}

function _showCardAiResult(cid, data) {
  const setV = (id, val) => { const el=document.getElementById(id); if(!el)return; el.textContent=val||"추출 실패"; val?el.classList.remove("empty"):el.classList.add("empty"); };
  setV(cid+"_aiOrder",     data.orderNumber);
  setV(cid+"_aiRecipient", data.recipient);
  setV(cid+"_aiPhone",     data.phone);
  setV(cid+"_aiAddress",   data.address);
  const prEl = document.getElementById(cid+"_aiPrice");
  if (prEl) { if(data.price){ prEl.textContent=Number(data.price).toLocaleString("ko-KR")+"원"; prEl.classList.remove("empty"); } else { prEl.textContent="추출 실패"; prEl.classList.add("empty"); } }
  document.getElementById(cid+"_aiResult").classList.add("show");
  document.getElementById(cid+"_aiError").style.display = "none";

  // ★ 별표(*) 탐지: 수취인/전화번호/주소에 * 포함 시 경고 + 적용 버튼 비활성화
  const hasAsterisk = [data.recipient, data.phone, data.address].some(v => v && v.includes("*"));
  const asteriskWarnEl = document.getElementById(cid+"_asteriskWarn");
  if (asteriskWarnEl) asteriskWarnEl.style.display = hasAsterisk ? "block" : "none";

  const hasAny = data.orderNumber||data.recipient||data.phone||data.address;
  const applyBtn = document.getElementById(cid+"_aiApplyBtn");
  if (applyBtn) {
    applyBtn.disabled = !hasAny || hasAsterisk;
    if (hasAsterisk) {
      applyBtn.innerHTML = '<i class="fas fa-ban"></i> 별표(*) 포함 — 직접 입력 필요';
      applyBtn.style.background = "#9CA3AF";
    } else {
      applyBtn.innerHTML = '<i class="fas fa-check-circle"></i> 위 정보를 입력칸에 적용하기';
      applyBtn.style.background = "";
    }
  }
}

function _showCardAiError(cid, msg, showRetry) {
  const errEl = document.getElementById(cid+"_aiError"); if(!errEl) return;
  errEl.style.display = "block";
  const msgEl = document.getElementById(cid+"_aiErrorMsg"); if(msgEl) msgEl.textContent = msg;
  const retryBtn = document.getElementById(cid+"_aiRetryBtn");
  if(retryBtn) retryBtn.style.display = (showRetry && _cardAiState[cid]?.lastBase64) ? "block" : "none";
  const lbl = document.getElementById(cid+"_imgLabel"); if(lbl&&lbl.textContent.includes("분석 중")) lbl.textContent="분석 실패 ✗";
}

/**
 * ★ AI 추출 결과 적용 + 수정 잠금
 *   적용된 필드: readonly + ai-locked 클래스 + 자물쇠 배지 삽입
 *   → 사용자가 값을 직접 수정할 수 없음
 */
function applyCardAiResult(cid) {
  const st = _cardAiState[cid]; if (!st || !st.extracted) return;
  const d = st.extracted;

  // ★ 별표(*) 재검증: 수취인/전화번호/주소에 * 있으면 적용 차단
  const hasAsterisk = [d.recipient, d.phone, d.address].some(v => v && v.includes("*"));
  if (hasAsterisk) {
    showToast("⚠️ 수취인·전화번호·주소에 별표(*)가 포함되어 있어 적용할 수 없습니다.\n쿠팡 주문 캡처는 개인정보가 *로 가려지므로 직접 입력해주세요.", "error");
    return;
  }

  // ★ 잠금 적용 헬퍼: 값 채우기 + readonly + ai-locked + 자물쇠 배지
  const lockF = (id, val) => {
    if (!val) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    el.classList.add("ai-filled", "ai-locked");
    el.readOnly = true;
    el.setAttribute("tabindex", "-1");
    // oninput 핸들러 제거 (혹시라도 발화 방지)
    el.oninput = null;
    el.setAttribute("oninput", "");
    // 부모 래퍼에 배지 삽입 (중복 방지)
    const parent = el.parentElement;
    if (parent && !parent.querySelector(".ai-lock-badge")) {
      // 부모가 relative가 아니면 래퍼로 감싸기
      if (!parent.classList.contains("ai-lock-wrap")) {
        el.classList.add("ai-lock-input-padded"); // 오른쪽 여백 확보
        el.style.paddingRight = "80px";
      }
      const badge = document.createElement("span");
      badge.className = "ai-lock-badge";
      badge.innerHTML = '<i class="fas fa-lock"></i> AI 적용됨';
      // el의 position:relative 컨테이너에 넣기
      parent.style.position = "relative";
      parent.appendChild(badge);
    }
  };

  lockF(cid+"_recipient", d.recipient);
  lockF(cid+"_phone",     d.phone);
  lockF(cid+"_orderNumber", d.orderNumber);

  // ★ 주소는 AI 자동채우기만 하고 수정 가능 (잠금 없음)
  if (d.address) {
    const addrEl = document.getElementById(cid+"_address");
    if (addrEl) {
      addrEl.value = d.address;
      addrEl.classList.add("ai-filled");
      addrEl.classList.remove("ai-locked");
      // 배지: 자물쇠 아닌 연필 아이콘으로 수정 가능 표시
      const addrParent = addrEl.parentElement;
      if (addrParent && !addrParent.querySelector(".ai-lock-badge")) {
        addrEl.style.paddingRight = "80px";
        const badge = document.createElement("span");
        badge.className = "ai-lock-badge";
        badge.style.cssText = "background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7";
        badge.innerHTML = '<i class="fas fa-pencil-alt"></i> AI 자동입력';
        addrParent.style.position = "relative";
        addrParent.appendChild(badge);
      }
    }
  }

  if (d.price) {
    const el = document.getElementById(cid+"_price");
    if (el) {
      const dg = d.price.replace(/[^0-9]/g,"");
      if (dg) {
        el.value = Number(dg).toLocaleString("ko-KR");
        el.classList.add("ai-filled", "ai-locked");
        el.readOnly = true;
        el.setAttribute("tabindex", "-1");
        el.oninput = null;
        el.setAttribute("oninput", "");
        const parent = el.parentElement;
        if (parent && !parent.querySelector(".ai-lock-badge")) {
          el.style.paddingRight = "80px";
          const badge = document.createElement("span");
          badge.className = "ai-lock-badge";
          badge.innerHTML = '<i class="fas fa-lock"></i> AI 적용됨';
          parent.style.position = "relative";
          parent.appendChild(badge);
        }
      }
    }
  }

  showToast("✅ AI 추출 정보가 적용되었습니다. 주소는 직접 수정할 수 있습니다." + (d.orderNumber ? " (주문번호: "+d.orderNumber+")" : ""), "success");

  const btn = document.getElementById(cid+"_aiApplyBtn");
  if (btn) { btn.innerHTML='<i class="fas fa-lock"></i> 적용 완료 (잠금)'; btn.disabled=true; btn.style.background="#10B981"; }

  // 적용 후 AI 추출 결과 카드 숨김
  const resultBox = document.getElementById(cid+"_aiResult");
  if (resultBox) resultBox.classList.remove("show");
}

/* ─ 하위호환: 기존 단일 카드 함수명 유지 (구 코드 참조 대비) ─ */
function onImgSelected(input) { /* 신버전에서는 onCardImgSelected 사용 */ }
function onImgDrop(e) { /* 신버전에서는 onCardImgDrop 사용 */ }
function removeImg() { const cid = _orderCardIds[0]; if(cid) removeCardImg(cid); }
function applyAiResult() { const cid = _orderCardIds[0]; if(cid) applyCardAiResult(cid); }

// ── 연락처 실시간 포맷: 숫자만 추출 후 000-0000-0000 형식 적용
function formatPhoneInput(el) {
  // 숫자만 추출
  const digits = el.value.replace(/\D/g, "").slice(0, 11);
  let formatted = digits;
  if (digits.length <= 3) {
    formatted = digits;
  } else if (digits.length <= 7) {
    formatted = digits.slice(0, 3) + "-" + digits.slice(3);
  } else {
    // 010-xxxx-xxxx (11자리) 또는 02-xxx-xxxx (10자리) 처리
    if (digits.startsWith("02")) {
      // 서울 지역번호 02: 02-XXXX-XXXX
      if (digits.length <= 9) {
        formatted = digits.slice(0, 2) + "-" + digits.slice(2, 5) + "-" + digits.slice(5);
      } else {
        formatted = digits.slice(0, 2) + "-" + digits.slice(2, 6) + "-" + digits.slice(6);
      }
    } else {
      // 010, 011, 016, 017, 018, 019, 031~ 등 3자리 국번
      if (digits.length <= 10) {
        formatted = digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6);
      } else {
        formatted = digits.slice(0, 3) + "-" + digits.slice(3, 7) + "-" + digits.slice(7);
      }
    }
  }
  // 커서 위치 보정을 위해 값만 교체
  el.value = formatted;
}

// ── 결제금액 실시간 쉼표 포맷: 숫자만 추출 후 1,000 단위 쉼표
function formatPriceInput(el) {
  const digits = el.value.replace(/[^\d]/g, "");
  if (!digits) { el.value = ""; return; }
  el.value = Number(digits).toLocaleString("ko-KR");
}

/**
 * [제출] 버튼 클릭 시 호출
 * 입력값 수집 → GAS submitOrderForm 호출 → 완료 화면 표시
 */
/** 필수 입력 오류 표시 헬퍼 */
function _ofShowError(inputId) {
  const el = document.getElementById(inputId);
  if (el) el.classList.add("of-input--error");
  const msg = document.getElementById(inputId + "_err");
  if (msg) msg.classList.add("visible");
}
/** 필수 입력 오류 해제 헬퍼 (입력 중 실시간 클리어) */
function _ofClearError(inputId) {
  const el = document.getElementById(inputId);
  if (el && el.value.trim()) {
    el.classList.remove("of-input--error");
    const msg = document.getElementById(inputId + "_err");
    if (msg) msg.classList.remove("visible");
  }
}

/* ══════════════════════════════════════════════════════
   다건 일괄 제출 (submitOrderForm)
   ══════════════════════════════════════════════════════ */
async function submitOrderForm() {
  if (window._submitOrderFormInProgress) { console.warn("[submitOrderForm] 진행 중 — 무시"); return; }
  window._submitOrderFormInProgress = true;
  const btn = document.getElementById("btnOrderFormSubmit");
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 처리 중...'; }

  function _resetBtn(label) {
    window._submitOrderFormInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = label || '<i class="fas fa-paper-plane"></i> 제출';
      // 재제출 모드가 아니면 스타일 초기화
      if (!label) {
        btn.style.background = "";
        btn.style.color = "";
      }
    }
  }

  const ctx = window._orderFormCtx || {};
  // ★ [방법A] gid가 있으면 tabName 없이도 제출 가능 (탭명 변경 대응)
  if (!ctx.sheetId || (!ctx.tabName && !ctx.gid)) { showToast("잘못된 링크입니다. (sheetId/tabName 또는 gid 필요)", "error"); _resetBtn(); return; }

  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    const sv = (() => { try { return JSON.parse(localStorage.getItem("reviewAppConfig")||"{}").GAS_WEB_APP_URL||""; } catch(_){return "";} })();
    if (sv) APP_CONFIG.GAS_WEB_APP_URL = sv;
  }
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("서버 연결 정보가 없습니다.", "error"); _resetBtn(); return; }

  // 날짜 생성
  const now = new Date();
  const days = ["일","월","화","수","목","금","토"];
  const dateStr = `${now.getMonth()+1} / ${now.getDate()} (${days[now.getDay()]})`;

  // ── 제출 전 공유값 최종 동기화 ──
  _syncAllSharedBeforeSubmit();

  // ── 옵션 검사 (1번 카드 기준) ──
  const pickerWrap = document.getElementById("of_option_picker_wrap");
  if (pickerWrap && pickerWrap.style.display !== "none" && _selectedOptKey === null) {
    showToast("먼저 본인의 옵션을 선택해주세요.", "warning");
    pickerWrap.scrollIntoView({ behavior: "smooth", block: "center" });
    _resetBtn(); return;
  }

  // ── 각 카드 입력값 수집 및 유효성 검사 ──
  const gv = id => (document.getElementById(id)?.value || "").trim();

  // 1번 카드 공통 값 (주문자/은행/예금주 원본)
  const firstCid  = _orderCardIds[0];
  const firstOrderer   = gv("of_orderer");
  const firstBank      = gv("of_bank");
  const firstAccount   = gv("of_account");
  const firstDepositor = gv("of_depositor");

  let hasError = false;

  // 주문자 필수
  if (!firstOrderer) { _ofShowError("of_orderer"); hasError = true; }

  // 각 카드 아이디 필수
  _orderCardIds.forEach(cid => {
    const uid = gv(cid + "_userId");
    if (!uid) { _ofShowError(cid + "_userId"); hasError = true; }
  });

  // ★ nc 모드: 쿠팡 결제금액 필수 + 동일인 검증 확인
  if (window._ncMode && _orderCardIds.length >= 2) {
    const coupangCid = _orderCardIds[1];
    const cpPrice = gv(coupangCid + "_price");
    if (!cpPrice) {
      _ofShowError(coupangCid + "_price");
      hasError = true;
    }
    const cpOrderNum = gv(coupangCid + "_orderNumber");
    if (!cpOrderNum) {
      _ofShowError(coupangCid + "_orderNumber");
      hasError = true;
    }
    // 동일인 검증 미통과 확인
    if (!window._ncVerifyPassed) {
      const manualEl = document.getElementById(coupangCid + "_manualCheck");
      const manualChk = document.getElementById(coupangCid + "_manualChk");
      if (!manualChk?.checked) {
        // 검증 박스가 표시되어 있는지 확인
        const verifyEl = document.getElementById(coupangCid + "_ncVerify");
        if (verifyEl && verifyEl.style.display !== "none") {
          showToast("⚠️ 쿠팡 캡처를 업로드하거나 수동 확인 체크박스를 선택해주세요.", "warning");
          verifyEl.scrollIntoView({ behavior: "smooth", block: "center" });
          _resetBtn(); return;
        }
      }
    }
  }

  if (hasError) {
    const firstErr = document.querySelector(".of-input--error");
    if (firstErr) firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("필수 항목을 입력해주세요.", "warning");
    _resetBtn(); return;
  }

  // ★ v9.14: 소득신고 유효성 검사 (카드별)
  if (window._incomeType === "소득신고") {
    for (let i = 0; i < _orderCardIds.length; i++) {
      const r = _validateCardIncomeInput(_orderCardIds[i]);
      if (!r.ok) { _resetBtn(); return; }
    }
  }
  const _incomeValid = _validateIncomeInput(); // 기존 공통 섹션 체크 (ofIncomeSection용 레거시)

  // 각 카드 페이로드 수집
  const orders = _orderCardIds.map((cid, idx) => {
    const isFirst = idx === 0;
    const isCoupangCard = window._ncMode && idx === 1; // nc 모드에서 2번 카드는 쿠팡
    const chk = !isFirst && !isCoupangCard && document.getElementById(cid+"_sameChk");
    const useSame = !isFirst && !isCoupangCard && chk?.checked;

    // 쿠팡 카드는 네이버 카드의 주문자/은행/예금주 재사용
    const orderer   = isCoupangCard ? firstOrderer   : (isFirst ? firstOrderer   : (useSame ? firstOrderer   : gv(cid+"_orderer")));
    const bank      = isCoupangCard ? firstBank      : (isFirst ? firstBank      : (useSame ? firstBank      : gv(cid+"_bank")));
    const account   = isCoupangCard ? firstAccount   : (isFirst ? firstAccount   : (useSame ? firstAccount   : gv(cid+"_account")));
    const depositor = isCoupangCard ? firstDepositor : (isFirst ? firstDepositor : (useSame ? firstDepositor : gv(cid+"_depositor")));

    const priceRaw = document.getElementById(cid+"_price")?.value || "";
    const price    = priceRaw.replace(/[^0-9]/g, "");

    // 쿠팡 카드: recipient/phone/address는 네이버 카드에서 가져옴 (배송지 통일)
    const naverCid = _orderCardIds[0];
    const recipient = isCoupangCard ? gv(naverCid+"_recipient") : gv(cid+"_recipient");
    const phone     = isCoupangCard ? gv(naverCid+"_phone")     : gv(cid+"_phone");
    const address   = isCoupangCard ? gv(naverCid+"_address")   : gv(cid+"_address");

    // ★ v9.14: 카드별 소득신고 정보 수집
    // - 1번 카드: 직접 입력값 사용
    // - 2번째+ 카드: "동일" 체크 시 1번 카드 값 복사, 해제 시 독립 입력값 사용
    let cardIncomeName = "";
    let cardResidentNo = "";
    if (window._incomeType === "소득신고") {
      const incBlock = document.getElementById(cid + "_incomeBlock");
      if (incBlock && incBlock.style.display !== "none") {
        // "동일" 체크 상태면 1번 카드 값 사용
        const incomeSameChk = document.getElementById(cid + "_incomeSameChk");
        if (!isFirst && incomeSameChk?.checked) {
          const firstCid = _orderCardIds[0];
          cardIncomeName = (document.getElementById(firstCid + "_incomeName")?.value || "").trim();
          cardResidentNo = (document.getElementById(firstCid + "_residentNo")?.value || "").replace(/[^0-9]/g, "");
        } else {
          cardIncomeName = (document.getElementById(cid + "_incomeName")?.value || "").trim();
          cardResidentNo = (document.getElementById(cid + "_residentNo")?.value || "").replace(/[^0-9]/g, "");
        }
        // 주민번호 형식화: 000000-0000000
        if (cardResidentNo.length === 13) {
          cardResidentNo = cardResidentNo.slice(0,6) + "-" + cardResidentNo.slice(6);
        }
      }
    }

    return {
      orderer,
      recipient,
      userId:         gv(cid+"_userId"),
      phone,
      address,
      bank, account, depositor, price,
      orderNum:       gv(cid+"_orderNumber"),
      memo:           gv(cid+"_memo"),
      selectedOptKey: isFirst ? (_selectedOptKey || "") : "",
      imgThumbSrc:    document.getElementById(cid+"_imgThumb")?.src || "",
      mimeType:       (() => { const s=document.getElementById(cid+"_imgThumb")?.src||""; return s.startsWith("data:")?s.split(";")[0].split(":")[1]:""; })(),
      isCoupang:      isCoupangCard,  // GAS에서 쿠팡 컬럼 구분용
      ncMode:         !!window._ncMode,
      // ★ v9.14: 카드별 소득신고 정보
      incomeName:     cardIncomeName,
      residentNo:     cardResidentNo
    };
  });

  // ── 중복 검사 제거 (v2.16.7): 시트 기록 시점에서 서버가 자동 필터링 ──
  window._dupIgnored = false;
  window._dupPayload = null;

  if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 제출 중... (0/${orders.length})`;

  // ★★★ Phase 5: 슬롯 매칭 API 호출 (제출 전) — 15초 타임아웃 ★★★
  let slotInfo = null;
  const slotAuth = window._slotAuth || {};
  if (slotAuth.name && ctx.sheetId && ctx.tabName) {
    try {
      const slotPayload = {
        action: "findSlot",
        sheetId: ctx.sheetId,
        gid: ctx.gid || "",
        tabName: ctx.tabName,
        loginName: slotAuth.name,
        phone8: slotAuth.phone8 || "",
        profileName: orders[0]?.orderer || slotAuth.name
      };
      const slotRes = await gasPost(slotPayload, 15000);
      if (slotRes?.ok && slotRes.mode === 'slot' && slotRes.rowNumber) {
        slotInfo = slotRes;
        console.log("[슬롯매칭] 성공:", slotRes.matchType, "→ 행", slotRes.rowNumber, "인애드명:", slotRes.inadName);
      } else {
        console.log("[슬롯매칭] append 모드:", slotRes?.reason || "no slot");
      }
    } catch(slotErr) {
      console.warn("[슬롯매칭] API 오류 (append 모드로 진행):", slotErr.message);
    }
  }

  // ── 각 주문 순차 제출 ──
  let successCount = 0;
  let firstCaptureFolderUrl = "";

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (btn) btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 제출 중... (${i+1}/${orders.length})`;

    // ★ Phase 5: 다건 제출 시 2번째+ 주문도 슬롯 매칭 (이전 제출로 캐시 무효화됨)
    let currentSlotInfo = (i === 0) ? slotInfo : null;
    if (i > 0 && slotAuth.name && ctx.sheetId && ctx.tabName) {
      try {
        const slotPayload2 = {
          action: "findSlot",
          sheetId: ctx.sheetId,
          gid: ctx.gid || "",
          tabName: ctx.tabName,
          loginName: slotAuth.name,
          phone8: slotAuth.phone8 || "",
          profileName: o.orderer || slotAuth.name
        };
        const slotRes2 = await gasPost(slotPayload2, 15000);
        if (slotRes2?.ok && slotRes2.mode === 'slot' && slotRes2.rowNumber) {
          currentSlotInfo = slotRes2;
          console.log(`[슬롯매칭 ${i+1}] 성공:`, slotRes2.matchType, "→ 행", slotRes2.rowNumber);
        }
      } catch(slotErr2) { console.warn(`[슬롯매칭 ${i+1}] 오류:`, slotErr2.message); }
    }

    const payload = {
      action: "submitOrderForm",
      sheetId: ctx.sheetId, gid: ctx.gid||"", tabName: ctx.tabName,
      orderer: o.orderer, recipient: o.recipient, userId: o.userId,
      phone: o.phone, address: o.address,
      bank: o.bank, account: o.account, depositor: o.depositor,
      price: o.price, orderNum: o.orderNum, memo: o.memo,
      selectedOptKey: o.selectedOptKey, dateStr,
      isCoupang: o.isCoupang ? "true" : "false",
      ncMode: o.ncMode ? "true" : "false",
      // ★ v9.14: 카드별 소득신고 정보 (소득신고 진행방식인 경우에만 값 존재)
      incomeName: o.incomeName || "",
      jumin:      o.residentNo  || "",
      // ★ Phase 5: 슬롯 매칭 정보 (각 주문마다 개별 슬롯 매칭)
      slotRowNumber: currentSlotInfo ? currentSlotInfo.rowNumber : "",
      slotInadName: currentSlotInfo ? currentSlotInfo.inadName : "",
      loginPhone8: slotAuth.phone8 || "",
      loginName: slotAuth.name || ""
    };

    try {
      let res;
      try { res = await gasPost(payload, 30000); } catch(e1) {
        console.warn(`[제출 ${i+1}] gasPost 실패:`, e1.message);
        // ★ [Node.js 이관] gasPost 재시도 (1회, 30초 타임아웃)
        try {
          res = await gasPost(payload, 30000);
        } catch(e2) { throw new Error("서버 연결 실패"); }
      }
      if (!res) throw new Error("서버 응답이 없습니다.");
      if (!res.ok) throw new Error(res.error||"제출 실패");

      successCount++;

      // ★ 이미지 업로드는 완전 비동기 (사용자 대기 없음)
      if (o.imgThumbSrc && o.imgThumbSrc.startsWith("data:")) {
        const _imgCtx = { base64: o.imgThumbSrc.split(",")[1], mime: o.mimeType || "image/jpeg", recipient: o.recipient, orderer: o.orderer };
        // 비동기 처리 — await 없이 실행 (제출 성공 여부와 무관)
        (async () => {
          try {
            const ext = _imgCtx.mime==="image/png"?"png":_imgCtx.mime==="image/webp"?"webp":"jpg";
            const namePart = [_imgCtx.recipient||_imgCtx.orderer, _imgCtx.orderer!==_imgCtx.recipient?_imgCtx.orderer:""].filter(Boolean).join("_")||"주문캡처";
            const upPayload = { action:"uploadOrderImage", imageBase64:_imgCtx.base64, mimeType:_imgCtx.mime, fileName:namePart+"."+ext, displayName:ctx.displayName||"", tabName:ctx.tabName, round:ctx.round||"", sheetId:ctx.sheetId||"" };
            const upJson = await gasPostUpload(upPayload, 180000);
            if (upJson?.ok && upJson.captureFolderUrl && !firstCaptureFolderUrl) {
              firstCaptureFolderUrl = upJson.captureFolderUrl;
            }
          } catch(upErr) { console.warn(`[이미지 업로드 ${i+1}] 백그라운드 오류:`, upErr.message); }
        })();
      }
    } catch(err) {
      showCenterAlert(`❌ ${i+1}번째 주문 제출 실패: ${err.message}`);
      console.error(`[제출 ${i+1}] 오류:`, err);
    }
  }

  // ★ v9.14: 소득신고 정보 저장 (1번 카드 명의 기준으로 인애드명단에 영구 저장, 백그라운드)
  if (successCount > 0 && window._incomeType === "소득신고") {
    try {
      const firstOrder = orders[0];
      const saveIncomeName = firstOrder?.incomeName || "";
      const saveJumin      = firstOrder?.residentNo  || "";
      if (saveIncomeName && saveJumin) {
        const authRawInc = localStorage.getItem("rapp_reviewer_auth");
        let authInc;
        try { authInc = JSON.parse(authRawInc || "{}"); } catch(_) { authInc = {}; }
        const myPhone8Inc = authInc.phone8 || "";
        if (myPhone8Inc) {
          const incPayload = {
            action:     "saveIncomeInfo",
            phone8:     myPhone8Inc,
            incomeName: saveIncomeName,
            jumin:      saveJumin.replace(/[^0-9]/g, "") // 숫자만 전송
          };
          gasPost(incPayload)
            .then(r => { if(r?.ok) console.log("[saveIncomeInfo] 저장 완료:", saveIncomeName); })
            .catch(e => console.warn("[saveIncomeInfo] 저장 실패:", e.message));
        }
      }
    } catch(incErr) { console.warn("[saveIncomeInfo] 오류:", incErr.message); }
  }

  // 캡처폴더 URL 저장 (첫 번째 성공건)
  if (firstCaptureFolderUrl) {
    try {
      const sfP = { action:"saveCaptureFolder", sheetId:ctx.sheetId||"", sheetUrl:ctx.sheetUrl||"", tabName:ctx.tabName, captureFolderUrl:firstCaptureFolderUrl };
      // ★ [Node.js 이관] gasPost()를 통해 API 서버로 전송
      const sfJ = await gasPost(sfP);
      if (sfJ?.ok) console.log("[캡처폴더] 저장 완료");
    } catch(sfErr) { console.warn("[캡처폴더] 저장 실패:", sfErr.message); }
  }

  window._submitOrderFormInProgress = false;

  if (successCount === 0) {
    // ★ 전체 실패 시: 재제출 안내 + 버튼 변경 + 스크롤
    _resetBtn('<i class="fas fa-redo"></i> 재제출');
    // 제출 버튼을 눈에 띄게 강조 + 스크롤
    const subBtn = document.getElementById("btnOrderFormSubmit");
    if (subBtn) {
      subBtn.style.background = "#DC2626";
      subBtn.style.color = "#fff";
      subBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return;
  }

  // 성공 후 플래그 초기화
  window._forceResubmit = false;

  // ── 완료 화면 표시 ──
  const wrapEl   = document.getElementById("ofOrderCardsWrap");
  const addBtnEl = document.getElementById("btnAddOrderCard");
  const guideEl  = document.getElementById("ofFinalGuide");
  const doneEl   = document.getElementById("orderFormDone");
  const subBtn   = document.getElementById("btnOrderFormSubmit");
  if (wrapEl)   wrapEl.style.display   = "none";
  if (addBtnEl) addBtnEl.style.display = "none";
  if (guideEl)  guideEl.style.display  = "none";
  if (subBtn)   subBtn.style.display   = "none";
  const doneMsgEl = document.getElementById("orderFormDoneMsg");
  if (doneMsgEl) {
    const total = orders.length;
    doneMsgEl.innerHTML = total > 1
      ? `총 <b>${total}건</b> 중 <b>${successCount}건</b>이 성공적으로 제출되었습니다.<br>창을 닫아도 됩니다.`
      : `구매양식이 성공적으로 제출되었습니다.<br>창을 닫아도 됩니다.`;
  }
  if (doneEl) doneEl.style.display = "";
}

/** ★ 제출 완료/실패 후 → 구매양식 입력 화면으로 복귀 */
function resetOrderFormForReentry() {
  // 완료 화면 숨기기
  const doneEl   = document.getElementById("orderFormDone");
  if (doneEl) doneEl.style.display = "none";

  // 입력 UI 다시 표시
  const wrapEl   = document.getElementById("ofOrderCardsWrap");
  const addBtnEl = document.getElementById("btnAddOrderCard");
  const guideEl  = document.getElementById("ofFinalGuide");
  const subBtn   = document.getElementById("btnOrderFormSubmit");
  if (wrapEl)   wrapEl.style.display   = "";
  if (addBtnEl) addBtnEl.style.display = "";
  if (guideEl)  guideEl.style.display  = "";
  if (subBtn)   { subBtn.style.display = ""; subBtn.disabled = false; subBtn.innerHTML = '<i class="fas fa-paper-plane"></i> 제출'; }

  // 재제출 플래그 초기화
  window._submitOrderFormInProgress = false;
}

async function quickEditCell(e, cell) {
  e.stopPropagation();
  _closeQePopup();

  const field   = cell.dataset.field;   // '상품명' | '주문시간대' | '리뷰타입' | '담당자' | '입금방식' | '택대'
  const tcData  = JSON.parse(cell.dataset.tc.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"));

  // ── 팝업 DOM 생성 ──
  const popup = document.createElement("div");
  popup.className = "qe-popup";
  _qePopup = popup;

  // 아이콘 맵
  const iconMap = { '상품명':'fa-box', '주문시간대':'fa-clock', '리뷰타입':'fa-star', '담당자':'fa-user', '입금방식':'fa-won-sign', '택대':'fa-truck' };
  popup.innerHTML = `<div class="qe-popup-title"><i class="fas ${iconMap[field]||'fa-pen'}" style="font-size:.65rem;color:var(--p)"></i>${field} 입력</div>`;

  let getValue; // 팝업 확인 시 선택값을 반환하는 함수

  if (field === '상품명') {
    popup.innerHTML += `<input type="text" id="qeInput" placeholder="예: OO브랜드 후기작업 3월" maxlength="60">`;
    getValue = () => document.getElementById("qeInput").value.trim();

  } else if (field === '주문시간대') {
    // ── [+정보]와 동일한 모드버튼 + 48슬롯 그리드 UI ──
    // 기존 값 파싱
    const _existingTime = (tcData.timeRange || '').trim();
    let _qeTimeMode, _qeTimeStart, _qeTimeEnd;
    if (!_existingTime || _existingTime === '') {
      _qeTimeMode = ''; _qeTimeStart = null; _qeTimeEnd = null;
    } else if (_existingTime === '자유') {
      _qeTimeMode = '자유'; _qeTimeStart = null; _qeTimeEnd = null;
    } else {
      _qeTimeMode = 'timed';
      const parts = _existingTime.split('~').map(s => s.trim());
      _qeTimeStart = parts[0] || null;
      _qeTimeEnd   = (parts[1] && parts[1] !== '') ? parts[1] : null;
    }

    popup.innerHTML += `
      <div class="tc-option-row" id="qeTimeModeRow" style="margin-bottom:4px">
        <button class="tc-opt qe-tm" data-val="">미지정</button>
        <button class="tc-opt qe-tm" data-val="자유">자유</button>
        <button class="tc-opt qe-tm" data-val="timed">타임지정</button>
      </div>
      <div id="qeTimePicker" class="tc-time-picker tc-time-picker-disabled" style="margin-bottom:6px">
        <div class="tc-time-picker-hint" id="qeTimeHint">타임지정을 선택하면 활성화됩니다</div>
        <div class="tc-time-grid" id="qeTimeGrid"></div>
        <button class="tc-time-clear" type="button" id="qeTimeClear">시간 초기화</button>
      </div>`;

    // 그리드 셀 생성
    const qeGrid = popup.querySelector("#qeTimeGrid");
    TC_TIME_SLOTS.forEach(slot => {
      const btn = document.createElement("button");
      btn.className   = "tc-time-cell";
      btn.textContent = slot;
      btn.type        = "button";
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        if (!_qeTimeStart) {
          _qeTimeStart = slot; _qeTimeEnd = null;
        } else if (!_qeTimeEnd) {
          if (slot === _qeTimeStart)      { _qeTimeStart = null; }
          else if (slot < _qeTimeStart)   { _qeTimeEnd = _qeTimeStart; _qeTimeStart = slot; }
          else                             { _qeTimeEnd = slot; }
        } else {
          _qeTimeStart = slot; _qeTimeEnd = null;
        }
        _syncQeTimePicker();
      });
      qeGrid.appendChild(btn);
    });

    // 초기화 버튼
    popup.querySelector("#qeTimeClear").addEventListener("click", ev => {
      ev.stopPropagation();
      _qeTimeStart = null; _qeTimeEnd = null;
      _syncQeTimePicker();
    });

    // 모드 버튼 클릭
    popup.querySelectorAll(".qe-tm").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        _qeTimeMode = btn.dataset.val;
        if (_qeTimeMode !== "timed") { _qeTimeStart = null; _qeTimeEnd = null; }
        _syncQeTimePicker();
      });
    });

    // 동기화 함수 (클로저)
    function _syncQeTimePicker() {
      const picker = popup.querySelector("#qeTimePicker");
      const hint   = popup.querySelector("#qeTimeHint");
      popup.querySelectorAll(".qe-tm").forEach(b => b.classList.toggle("sel", b.dataset.val === _qeTimeMode));
      const isTimed = (_qeTimeMode === "timed");
      picker.classList.toggle("tc-time-picker-disabled", !isTimed);
      picker.querySelectorAll(".tc-time-cell").forEach(c => {
        const v = c.textContent;
        c.classList.remove("tc-sel-start","tc-sel-end","tc-in-range");
        if (!isTimed) return;
        if (v === _qeTimeStart) c.classList.add("tc-sel-start");
        if (v === _qeTimeEnd)   c.classList.add("tc-sel-end");
        if (_qeTimeStart && _qeTimeEnd && v > _qeTimeStart && v < _qeTimeEnd)
          c.classList.add("tc-in-range");
      });
      if (!isTimed) {
        hint.textContent = _qeTimeMode === "자유" ? "시간 제한 없음" : "타임지정을 선택하면 활성화됩니다";
      } else if (!_qeTimeStart) {
        hint.textContent = "① 시작 시간을 클릭하세요";
      } else if (!_qeTimeEnd) {
        hint.textContent = "✔ " + _qeTimeStart + "~  ← 종료시간(선택사항)";
      } else {
        hint.textContent = "✔ " + _qeTimeStart + " ~ " + _qeTimeEnd;
      }
    }
    _syncQeTimePicker();
    // 팝업 제목에 '수정' 표시 (기존 값 있을 때)
    if (_existingTime) {
      popup.querySelector('.qe-popup-title').innerHTML =
        `<i class="fas fa-clock" style="font-size:.65rem;color:var(--p)"></i>주문시간대 수정`;
    }

    // 팝업 너비를 넉넉하게 확보 (그리드 6열 표시용)
    popup.style.minWidth = "280px";

    getValue = () => {
      if (_qeTimeMode === "")      return "";
      if (_qeTimeMode === "자유")   return "자유";
      if (_qeTimeStart && _qeTimeEnd) return _qeTimeStart + " ~ " + _qeTimeEnd;
      if (_qeTimeStart)               return _qeTimeStart + " ~";
      return "";
    };

  } else if (field === '리뷰타입') {
    const opts = ['실배송','빈박스','구매확정','믹스'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.toggle("sel", !btn.classList.contains("sel") || true);
        btn.classList.add("sel");
      });
    });

  } else if (field === '담당자') {
    const opts = ['만두','망고'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
      });
    });

  } else if (field === '입금방식') {
    const opts = ['인애드','업체'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
      });
    });

  } else if (field === '택대') {
    popup.innerHTML += `<div class="qe-opt-row"><button class="qe-opt" data-val="true">✔ 택대 ON</button><button class="qe-opt sel" data-val="false" style="display:none"></button></div>`;
    // 택대는 단일 ON 버튼 (OFF는 +정보에서)
    getValue = () => "true";
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => { ev.stopPropagation(); btn.classList.add("sel"); });
    });

  } else if (field === '비고') {
    // 비고 – localStorage 전용 (GAS 저장 없음), 기존 값 미리 채워짐
    const existingMemo = _getTabMemo(cell.dataset.tabkey || '');
    popup.innerHTML += `<textarea id="qeMemoInput" rows="3" placeholder="자유롭게 메모하세요..." maxlength="200" style="width:100%;border:1.5px solid var(--bd);border-radius:7px;padding:7px 9px;font-size:.8rem;outline:none;box-sizing:border-box;resize:vertical;font-family:inherit;line-height:1.4">${escHtml(existingMemo)}</textarea><p style="font-size:.62rem;color:var(--t3);margin:2px 0 5px">이 기기에만 저장됩니다 (최대 200자)</p>`;
    getValue = () => document.getElementById("qeMemoInput").value.trim();
    popup.style.minWidth = "240px";
    // 기존 값 있으면 제목에 '수정' 표시
    if (existingMemo) {
      popup.querySelector('.qe-popup-title').innerHTML =
        `<i class="fas fa-sticky-note" style="font-size:.65rem;color:var(--p)"></i>비고 수정`;
    }
  }

  // 적용 버튼
  const applyBtn = document.createElement("button");
  applyBtn.className = "qe-apply";
  applyBtn.textContent = "✔ 적용";
  popup.appendChild(applyBtn);

  // ── 팝업 위치 계산 (셀 아래, 화면 밖으로 나가지 않도록) ──
  document.body.appendChild(popup);
  const cr   = cell.getBoundingClientRect();
  const pw   = popup.offsetWidth;
  const ph   = popup.offsetHeight;
  let left   = cr.left;
  let top    = cr.bottom + 4;
  if (left + pw > window.innerWidth - 8)  left = window.innerWidth - pw - 8;
  if (top  + ph > window.innerHeight - 8) top  = cr.top - ph - 4;
  popup.style.left = Math.max(4, left) + "px";
  popup.style.top  = Math.max(4, top)  + "px";

  // input 포커스
  const inp = popup.querySelector("input[type=text]");
  if (inp) setTimeout(() => inp.focus(), 30);

  // ── 적용 클릭 → GAS 저장 (비고는 localStorage 전용) ──
  applyBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const val = getValue ? getValue() : '';
    if (!val && field !== '택대' && field !== '주문시간대' && field !== '비고') { showToast("값을 입력하거나 선택해주세요.", true); return; }

    _closeQePopup();

    // ── 비고: localStorage만 저장 후 행 DOM 즉시 갱신 ──
    if (field === '비고') {
      const tabKey = cell.dataset.tabkey || '';
      _setTabMemo(tabKey, val);
      // 해당 셀 내용 직접 교체
      const memoInner = val
        ? `<span class="dash-cell-memo" title="${escHtml(val)}">${escHtml(val)}</span>`
        : `<span style="color:#D1D5DB;font-size:.65rem">—</span>`;
      cell.innerHTML = memoInner;
      cell.title = val ? '비고 수정' : '비고 입력';
      showToast(val ? "비고가 저장되었습니다." : "비고가 삭제되었습니다.");
      return; // GAS 전송 없이 종료
    }

    // 기존 tcData에서 해당 필드만 교체
    const fieldKey = { '상품명':'displayName', '주문시간대':'timeRange', '리뷰타입':'reviewType', '담당자':'manager', '입금방식':'paymentType', '택대':'taekhap' }[field];
    const newTcData = { ...tcData };
    if (field === '택대') newTcData.taekhap = true;
    else newTcData[fieldKey] = val;

    const resolvedSheetId  = newTcData.sheetId || "";
    const rawSheetUrl      = newTcData.sheetUrl || (resolvedSheetId ? "https://docs.google.com/spreadsheets/d/"+resolvedSheetId+"/edit" : "");
    const resolvedSheetUrl = rawSheetUrl.split("#")[0];

    const payload = {
      action:      "setTabConfig",
      sheetId:     resolvedSheetId,
      sheetUrl:    resolvedSheetUrl,
      tabName:     newTcData.tabName     || "",
      manager:     newTcData.manager     || "",
      timeRange:   newTcData.timeRange   || "",
      taekhap:     newTcData.taekhap     ? "true" : "false",
      reviewType:  newTcData.reviewType  || "",
      paymentType: newTcData.paymentType || "",
      displayName: newTcData.displayName || ""
    };

    console.log("[QE] 저장 payload:", JSON.stringify(payload));
    try {
      let json;
      try { json = await gasPost(payload); }
      catch { json = await gasGet(payload); }
      if (json.ok) {
        showToast(`✅ ${field} 저장 완료`);
        loadAdminDashboard();
      } else {
        showToast("❌ 저장 실패: " + (json.error || ""), true);
      }
    } catch (err) {
      showToast("❌ 오류: " + err.message, true);
    }
  });
}

function toggleAllCampaigns() {
  const wrap   = document.getElementById("dashboardWrap");
  if (!wrap) return;

  const tables  = wrap.querySelectorAll(".dash-tab-table");
  const headers = wrap.querySelectorAll(".dash-campaign-header");
  const btn     = document.getElementById("btnExpandAll");
  if (!tables.length) return;

  // 현재 상태: 하나라도 펼쳐져 있으면 → 전체 접기, 모두 접혀 있으면 → 전체 펼치기
  const anyOpen = Array.from(tables).some(t => !t.classList.contains("collapsed"));
  allExpanded   = !anyOpen;

  tables.forEach((table, i) => {
    const header = headers[i];
    const icon   = header ? header.querySelector(".dash-toggle-icon") : null;
    if (allExpanded) {
      table.classList.remove("collapsed");
      if (icon) icon.classList.add("rotated");
    } else {
      table.classList.add("collapsed");
      if (icon) icon.classList.remove("rotated");
    }
  });

  if (allExpanded) {
    btn.innerHTML = '<i class="fas fa-compress-alt"></i> 전체 접기';
    btn.classList.add("active");
  } else {
    btn.innerHTML = '<i class="fas fa-expand-alt"></i> 전체 펼치기';
    btn.classList.remove("active");
  }
}

/* ── 대시보드 필터 드롭다운 ─────────────────────────────────
   activeFilters: Set (비어있으면 전체 표시)
   필터 종류: tuip / chuihap / monthly
   복수 선택 OR 조건
─────────────────────────────────────────────────────────── */
const activeFilters = new Set();

function toggleFilterDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById("dashFilterDropdown");
  dd.classList.toggle("open");
}

// 드롭다운 외부 클릭 시 닫기
document.addEventListener("click", function(e) {
  const wrap = document.getElementById("dashFilterWrap");
  if (wrap && !wrap.contains(e.target)) {
    const dd = document.getElementById("dashFilterDropdown");
    if (dd) dd.classList.remove("open");
  }
});

function onFilterChange(checkbox) {
  const f = checkbox.value;
  const item = checkbox.closest(".dash-filter-item");
  if (checkbox.checked) {
    activeFilters.add(f);
    if (item) item.classList.add("checked");
  } else {
    activeFilters.delete(f);
    if (item) item.classList.remove("checked");
  }
  updateFilterBtn();
  applyDashFilter();
}

function updateFilterBtn() {
  const btn = document.getElementById("dashFilterBtn");
  if (!btn) return;
  const count = activeFilters.size;
  if (count > 0) {
    btn.classList.add("has-filter");
    btn.innerHTML = `<i class="fas fa-filter"></i> 필터 <span class="filter-badge">${count}</span>`;
  } else {
    btn.classList.remove("has-filter");
    btn.innerHTML = `<i class="fas fa-filter"></i> 필터`;
  }
}

/* ══════════════════════════════════════════════════════════
   캠페인별 인덱스 부분 갱신
══════════════════════════════════════════════════════════ */
async function refreshCampaignIndex(btn) {
  const sheetId  = btn.dataset.sheetid  || "";
  const campName = btn.dataset.campname || "선택한 캠페인";
  if (!sheetId) { showToast("sheetId가 없습니다.", "error"); return; }

  // 확인 메시지
  const ok = confirm(`"${campName}" 캠페인만 인덱스를 갱신합니다.\n\n선택한 캠페인만 동기화됩니다.\n계속하시겠습니까?`);
  if (!ok) return;

  // 버튼 로딩 상태
  btn.classList.add("loading");
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 갱신 중...';

  try {
    const res = await gasGet({ action: "buildIndexByCampaign", sheetId });

    if (res.error) {
      showToast("갱신 실패: " + res.error, "error");
    } else {
      showToast(`✅ ${res.message || campName + " 갱신 완료"}`, "success");
      // 대시보드 새로고침 (갱신된 데이터 반영)
      await loadAdminDashboard();
    }
  } catch(err) {
    showToast("갱신 오류: " + err.message, "error");
  } finally {
    // 버튼 복원 (loadAdminDashboard가 DOM 재빌드하므로 사실상 새 버튼으로 교체됨)
    if (btn && btn.isConnected) {
      btn.classList.remove("loading");
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> 갱신';
    }
  }
}

// 행 상태값 결정 헬퍼 (data-state 속성에 저장 → 필터가 읽음)
// 반환값: "closed" | "forcedone" | "done" | "tuip" | "chuihap" | "tuip chuihap" | ""
function _rowState(isClosedTab, isDone, tuip, chuihap) {
  if (isClosedTab)  return "closed";
  if (isDone)       return "done";
  const parts = [];
  if (tuip    > 0) parts.push("tuip");
  if (chuihap > 0) parts.push("chuihap");
  return parts.join(" ");
}

function applyDashFilter() {
  const wrap = document.getElementById("dashboardWrap");
  if (!wrap) return;

  const blocks = wrap.querySelectorAll(".dash-campaign-block");
  const noFilter = activeFilters.size === 0;

  blocks.forEach(block => {
    const rows = block.querySelectorAll(".dash-tab-row");
    let visibleCount = 0;

    rows.forEach(row => {
      if (noFilter) {
        row.style.display = "";
        visibleCount++;
        return;
      }

      let show = false;
      const rowState = (row.dataset.state || "").split(" ");
      if (!show && activeFilters.has("tuip"))       { if (rowState.includes("tuip"))                                              show = true; }
      if (!show && activeFilters.has("chuihap"))    { if (rowState.includes("chuihap"))                                           show = true; }
      if (!show && activeFilters.has("monthly"))    { if (row.classList.contains("dash-tab-row-monthly"))                         show = true; }
      if (!show && activeFilters.has("taekhap"))    { if (row.querySelector(".tc-taekhap-on"))                                    show = true; }
      if (!show && activeFilters.has("done"))       { if (row.classList.contains("tab-done")) show = true; }
      if (!show && activeFilters.has("closed"))     { if (row.classList.contains("is-closed-row"))                                show = true; }
      // 리뷰타입 필터
      for (const f of activeFilters) {
        if (f.startsWith("review:")) {
          const rv = f.slice(7);
          if (row.querySelector(`.tc-review-${rv}`)) { show = true; break; }
        }
      }
      // 담당자 필터
      for (const f of activeFilters) {
        if (f.startsWith("manager:")) {
          const mg = f.slice(8); // "만두" or "망고"
          const cls = mg === "만두" ? ".tc-mandu" : ".tc-mango";
          if (row.querySelector(cls)) { show = true; break; }
        }
      }

      row.style.display = show ? "" : "none";
      if (show) visibleCount++;
    });

    block.style.display = visibleCount === 0 ? "none" : "";
    if (!noFilter && visibleCount > 0) {
      const table = block.querySelector(".dash-tab-table");
      const icon  = block.querySelector(".dash-toggle-icon");
      if (table) table.classList.remove("collapsed");
      if (icon)  icon.classList.add("rotated");
    }
  });
}

/* ══════════════════════════════════════════════════════════
   탭설정 팝오버 & 저장 로직
══════════════════════════════════════════════════════════ */
let _tcCurrent = null; // 현재 편집 중인 탭 데이터

function openTcPopover(e, tcData) {
  e.stopPropagation();
  _tcCurrent = tcData;
  // ★ 디버그: 팝오버 열릴 때 tcData 확인 (브라우저 콘솔에서 확인)
  console.log("[TC] openTcPopover tcData:", JSON.stringify(tcData));
  const pop = document.getElementById("tcPopover");

  // 제목
  document.getElementById("tcPopTitle").textContent = tcData.tabName || "설정";

  // 담당자 옵션 선택 반영
  document.querySelectorAll("#tcOptManager .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.manager || ""));
  });
  // 리뷰타입 옵션 선택 반영
  document.querySelectorAll("#tcOptReview .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.reviewType || ""));
  });
  // 입금방식 옵션 선택 반영
  document.querySelectorAll("#tcOptPayment .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.paymentType || ""));
  });
  // 상품명
  document.getElementById("tcDisplayInput").value = tcData.displayName || "";
  // 시간대 → 피커 초기화
  initTcTimePicker(tcData.timeRange || "");
  // 택대
  document.getElementById("tcTaekhapCheck").checked = !!tcData.taekhap;
  // 대량건
  document.getElementById("tcBulkCheck").checked = !!tcData.isBulk;

  // 위치 계산 (클릭 위치 기준)
  const x = e.clientX, y = e.clientY;
  pop.style.left = Math.min(x, window.innerWidth - 260) + "px";
  pop.style.top  = Math.min(y + 6, window.innerHeight - 440) + "px";
  pop.classList.add("open");
}

// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// ★ 주문시간대 커스텀 범위 피커 v2
//
//  모드 버튼: 미지정 / 자유 / 타임지정
//  - 미지정  → 그리드 비활성화, 저장값: ""
//  - 자유    → 그리드 비활성화, 저장값: "자유"
//  - 타임지정 → 그리드 활성화
//              1클릭 = 시작시간  → 저장값: "15:00 ~"
//              2클릭 = 종료시간  → 저장값: "15:00 ~ 16:30"
//              (같은 칸 재클릭 시 종료 선택 취소)
// ══════════════════════════════════════════════════════
const TC_TIME_SLOTS = (() => {
  const slots = [];
  for (let h = 0; h <= 23; h++) {
    for (const m of [0, 30]) {
      slots.push(String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0"));
    }
  }
  return slots; // 48개 (자유 버튼은 모드 버튼으로 분리)
})();

let _tcTimeMode  = "";   // "" | "자유" | "timed"
let _tcTimeStart = null; // "HH:MM" 또는 null
let _tcTimeEnd   = null; // "HH:MM" 또는 null

/** 팝오버 열릴 때 기존 값으로 초기화 */
function initTcTimePicker(val) {
  _tcTimeStart = null;
  _tcTimeEnd   = null;

  if (!val || val === "") {
    _tcTimeMode = "";
  } else if (val === "자유") {
    _tcTimeMode = "자유";
  } else {
    // "HH:MM ~ HH:MM" 또는 "HH:MM ~" 또는 "HH:MM~HH:MM" 등 파싱
    _tcTimeMode = "timed";
    const clean = val.replace(/\s/g, "");          // 공백 제거
    const parts = clean.split("~");
    if (parts[0] && parts[0].includes(":")) _tcTimeStart = parts[0];
    if (parts[1] && parts[1].includes(":")) _tcTimeEnd   = parts[1];
  }

  // 그리드 셀 생성 (최초 1회 or 비어있을 때)
  const grid = document.getElementById("tcTimeGrid");
  if (!grid.children.length) {
    TC_TIME_SLOTS.forEach(slot => {
      const btn = document.createElement("button");
      btn.className   = "tc-time-cell";
      btn.textContent = slot;
      btn.type        = "button";
      btn.onclick     = () => onTcTimeClick(slot);
      grid.appendChild(btn);
    });
  }

  _syncTcTimePicker();
}

/** 모드 버튼 클릭: "" | "자유" | "timed" */
function setTcTimeMode(mode) {
  _tcTimeMode = mode;
  if (mode !== "timed") {
    // 타임지정 아닐 때 시간 선택 초기화
    _tcTimeStart = null;
    _tcTimeEnd   = null;
  }
  _syncTcTimePicker();
}

/** 그리드 셀 클릭 (타임지정 모드에서만 호출됨) */
function onTcTimeClick(slot) {
  if (!_tcTimeStart) {
    // 첫 클릭 → 시작 설정
    _tcTimeStart = slot;
    _tcTimeEnd   = null;
  } else if (!_tcTimeEnd) {
    if (slot === _tcTimeStart) {
      // 시작과 같은 칸 재클릭 → 시작 취소
      _tcTimeStart = null;
    } else if (slot < _tcTimeStart) {
      // 시작보다 이른 시간 → swap
      _tcTimeEnd   = _tcTimeStart;
      _tcTimeStart = slot;
    } else {
      // 두 번째 클릭 → 종료 설정
      _tcTimeEnd = slot;
    }
  } else {
    // 이미 시작+종료 모두 있음 → 처음부터 다시
    _tcTimeStart = slot;
    _tcTimeEnd   = null;
  }
  _syncTcTimePicker();
}

/** 그리드 초기화 버튼 */
function clearTcTimeGrid() {
  _tcTimeStart = null;
  _tcTimeEnd   = null;
  _syncTcTimePicker();
}

/** hidden input·UI 일괄 동기화 */
function _syncTcTimePicker() {
  const picker  = document.getElementById("tcTimePicker");
  const hint    = document.getElementById("tcTimeHint");
  const display = document.getElementById("tcTimeDisplay");
  const input   = document.getElementById("tcTimeInput");

  // ── 모드 버튼 sel 표시 ──────────────────────────────
  document.querySelectorAll("#tcOptTimeMode .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === _tcTimeMode);
  });

  // ── 그리드 활성·비활성 ──────────────────────────────
  const isTimed = (_tcTimeMode === "timed");
  picker.classList.toggle("tc-time-picker-disabled", !isTimed);

  // ── 셀 강조 표시 ────────────────────────────────────
  const cells = picker.querySelectorAll(".tc-time-cell");
  cells.forEach(btn => {
    const v = btn.textContent;
    btn.classList.remove("tc-sel-start","tc-sel-end","tc-in-range");
    if (!isTimed) return;
    if (v === _tcTimeStart && !_tcTimeEnd) btn.classList.add("tc-sel-start");
    else if (v === _tcTimeStart)           btn.classList.add("tc-sel-start");
    else if (v === _tcTimeEnd)             btn.classList.add("tc-sel-end");
    else if (_tcTimeStart && _tcTimeEnd && v > _tcTimeStart && v < _tcTimeEnd)
      btn.classList.add("tc-in-range");
  });

  // ── 힌트 텍스트 ─────────────────────────────────────
  if (!isTimed) {
    hint.textContent = _tcTimeMode === "자유"
      ? "시간 제한 없음"
      : "타임지정을 선택하면 활성화됩니다";
  } else if (!_tcTimeStart) {
    hint.textContent = "① 시작 시간을 클릭하세요";
  } else if (!_tcTimeEnd) {
    hint.textContent = "✔ " + _tcTimeStart + "~  ← 종료시간(선택사항)";
  } else {
    hint.textContent = "✔ " + _tcTimeStart + " ~ " + _tcTimeEnd;
  }

  // ── 저장값 및 상단 표시 ─────────────────────────────
  let saveVal = "";
  let dispStr = "";
  if (_tcTimeMode === "") {
    saveVal = "";
    dispStr = "";
  } else if (_tcTimeMode === "자유") {
    saveVal = "자유";
    dispStr = "자유";
  } else {
    // timed
    if (_tcTimeStart && _tcTimeEnd) {
      saveVal = _tcTimeStart + " ~ " + _tcTimeEnd;
      dispStr = saveVal;
    } else if (_tcTimeStart) {
      saveVal = _tcTimeStart + " ~";  // 시작만 선택된 상태
      dispStr = saveVal;
    } else {
      saveVal = "";
      dispStr = "";
    }
  }
  input.value         = saveVal;
  display.textContent = dispStr;
}

function closeTcPopover() {
  document.getElementById("tcPopover").classList.remove("open");
  _tcCurrent = null;
}
// 팝오버 UI만 닫고 _tcCurrent는 유지 (confirmTcSave 내부용)
function _closeTcPopoverUiOnly() {
  document.getElementById("tcPopover").classList.remove("open");
}

// 팝오버 외부 클릭 시 닫기
document.addEventListener("click", function(e) {
  const pop = document.getElementById("tcPopover");
  if (pop && pop.classList.contains("open") && !pop.contains(e.target)) {
    closeTcPopover();
  }
});

// ★ tc-clickable 셀 클릭 → data-tc 파싱 → 팝오버 오픈 (onclick 속성 방식 대체)
document.addEventListener("click", function(e) {
  const cell = e.target.closest(".tc-clickable");
  if (!cell) return;
  const raw = cell.getAttribute("data-tc");
  if (!raw) return;
  let tcData;
  try { tcData = JSON.parse(raw); } catch(_) { return; }
  openTcPopover(e, tcData);
});

// 옵션 버튼 클릭 (단일 선택 토글)
document.addEventListener("click", function(e) {
  const opt = e.target.closest("#tcOptManager .tc-opt, #tcOptReview .tc-opt, #tcOptPayment .tc-opt");
  if (!opt) return;
  const group = opt.closest(".tc-option-row");
  group.querySelectorAll(".tc-opt").forEach(b => b.classList.remove("sel"));
  opt.classList.add("sel");
});

// 저장 버튼 → 경고 팝업 띄우기
function requestTcSave() {
  if (!_tcCurrent) return;
  // 현재 입력값 snapshot
  _tcCurrent._pendingManager     = (document.querySelector("#tcOptManager .tc-opt.sel")  || {}).dataset?.val ?? "";
  _tcCurrent._pendingReviewType  = (document.querySelector("#tcOptReview .tc-opt.sel")   || {}).dataset?.val ?? "";
  _tcCurrent._pendingPaymentType = (document.querySelector("#tcOptPayment .tc-opt.sel")  || {}).dataset?.val ?? "";
  _tcCurrent._pendingDisplayName = document.getElementById("tcDisplayInput").value.trim();
  _tcCurrent._pendingTimeRange   = document.getElementById("tcTimeInput").value.trim();
  _tcCurrent._pendingTaekhap     = document.getElementById("tcTaekhapCheck").checked;
  _tcCurrent._pendingIsBulk      = document.getElementById("tcBulkCheck").checked;

  document.getElementById("tcConfirmMsg").innerHTML =
    `<b>${escHtml(_tcCurrent.tabName)}</b> 탭의 설정을 변경하시겠습니까?<br>저장하면 베이스시트에 즉시 반영됩니다.`;
  document.getElementById("tcConfirmOverlay").classList.add("open");
}

function closeTcConfirm() {
  document.getElementById("tcConfirmOverlay").classList.remove("open");
}

async function confirmTcSave() {
  closeTcConfirm();
  _closeTcPopoverUiOnly(); // _tcCurrent는 유지한 채 팝오버 UI만 닫음
  if (!_tcCurrent) return;

  // ① GAS URL 설정 여부 확인
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("❌ GAS 웹앱 URL이 설정되지 않았습니다. 설정 화면에서 URL을 먼저 입력해주세요.", true);
    _tcCurrent = null;
    openGasUrlModal();
    return;
  }

  // ② sheetId: 탭 데이터의 sheetId 사용 (DB가 원본)
  const resolvedSheetId = _tcCurrent.sheetId || "";
  if (!resolvedSheetId) {
    showToast("❌ sheetId를 특정할 수 없습니다. 인덱스를 먼저 갱신해주세요.", true);
    _tcCurrent = null;
    return;
  }

  // ③ 저장할 파라미터 구성
  // sheetUrl: 세부목록 탭에 URL로 저장하기 위해 함께 전송
  // #gid= 이후 앵커 제거 → URL 매칭 일관성 확보
  const rawSheetUrl = _tcCurrent.sheetUrl
    || (resolvedSheetId ? "https://docs.google.com/spreadsheets/d/" + resolvedSheetId + "/edit" : "");
  const resolvedSheetUrl = rawSheetUrl.split("#")[0]; // #gid=xxx 제거
  const payload = {
    action:      "setTabConfig",
    sheetId:     resolvedSheetId,
    sheetUrl:    resolvedSheetUrl,
    tabName:     _tcCurrent.tabName             || "",
    manager:     _tcCurrent._pendingManager     || "",
    timeRange:   _tcCurrent._pendingTimeRange   || "",
    taekhap:     _tcCurrent._pendingTaekhap ? "true" : "false",
    reviewType:  _tcCurrent._pendingReviewType  || "",
    paymentType: _tcCurrent._pendingPaymentType || "",
    displayName: _tcCurrent._pendingDisplayName || "",
    isBulk:      _tcCurrent._pendingIsBulk ? "true" : "false"
  };

  // ④ 디버그 로그 (F12 콘솔에서 확인)
  console.log("[TC] 저장 payload:", JSON.stringify(payload));

  try {
    // ★ POST 방식으로 전송 (한글·특수문자 안전, displayName 등 누락 방지)
    // POST 실패 시 GET으로 폴백 (CORS 환경 대응)
    let json;
    try {
      json = await gasPost(payload);
    } catch (postErr) {
      console.warn("[TC] POST 실패, GET으로 폴백:", postErr.message);
      json = await gasGet(payload);
    }
    console.log("[TC] 응답:", json);

    if (json.ok) {
      console.log("[TC] 저장 완료. tabName:", json.tabName, "updated:", json.updated, "row:", json.row);
      showToast("✅ 설정이 저장되었습니다." + (json.updated ? " (업데이트)" : " (신규)"));
      loadAdminDashboard();
    } else {
      console.error("[TC] 저장 실패 응답:", json);
      showToast("❌ 저장 실패: " + (json.error || JSON.stringify(json)), true);
    }
  } catch (err) {
    console.error("[TC] 요청 오류:", err);
    showToast("❌ 오류: " + err.message + " (F12 콘솔 확인)", true);
  }
  _tcCurrent = null;
}

/** 간단한 토스트 메시지 */
function showToast(msg, isErr) {
  let t = document.getElementById("_toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "_toast";
    Object.assign(t.style, {
      position:"fixed", bottom:"24px", left:"50%", transform:"translateX(-50%)",
      background: isErr ? "#EF4444" : "#10B981",
      color:"#fff", padding:"8px 20px", borderRadius:"20px",
      fontSize:".82rem", fontWeight:"600", zIndex:"9999",
      boxShadow:"0 4px 14px rgba(0,0,0,.2)", transition:"opacity .3s"
    });
    document.body.appendChild(t);
  }
  t.style.background = isErr ? "#EF4444" : "#10B981";
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = "0"; }, 2500);
}

/* ── GAS 설정 모달 ── */
/* ── 동기화 모달 ── */
function openIndexModal() {
  show("indexModal", "flex");
  if (APP_CONFIG.GAS_WEB_APP_URL) loadIndexStatus();
}
function closeIndexModal() {
  hide("indexModal");
  // 인덱스 관련 UI 초기화
  const elapsedRow = document.getElementById("indexElapsedRow");
  const resultRow  = document.getElementById("indexResultRow");
  if (elapsedRow) elapsedRow.style.display = "none";
  if (resultRow)  resultRow.style.display  = "none";
  const gasErrBanner = document.getElementById("gasErrorBanner");
  if (gasErrBanner) gasErrBanner.style.display = "none";
}

/* ── 각종 진단 모달 ── */
function openDiagModal() {
  show("diagModal", "flex");
}
function closeDiagModal() {
  hide("diagModal");
  // 진단 UI 초기화
  const inp = document.getElementById("debugSheetIdInput");
  if (inp) inp.value = "";
  const choiceWrap = document.getElementById("debugSheetChoiceWrap");
  if (choiceWrap) choiceWrap.style.display = "none";
  const singleRes = document.getElementById("debugSingleResult");
  if (singleRes) { singleRes.innerHTML = ""; singleRes.className = "hidden"; singleRes.style.display = "none"; }
  const baseRes = document.getElementById("debugBaseResult");
  if (baseRes) { baseRes.innerHTML = ""; baseRes.className = "hidden"; }
  const tabRes = document.getElementById("debugTabConfigResult");
  if (tabRes) { tabRes.textContent = ""; tabRes.className = "hidden"; }
  const jsonpRes = document.getElementById("jsonpTestResult");
  if (jsonpRes) jsonpRes.style.display = "none";
}
// 진단 모달 내 파일존재확인 (모달 열기)
function openCheckFilesModalFromDiag() {
  closeDiagModal();
  openCheckFilesModal();
}

/* ── 하위 호환: 구 함수명 alias ── */
function openAdminSetting() { openIndexModal(); }
function closeAdminSetting() { closeIndexModal(); }
function saveAdminSetting() { closeIndexModal(); }


/* ── 인덱스 상태 / 갱신 ── */
async function loadIndexStatus() {
  const badge   = document.getElementById("indexStatusBadge");
  const builtAt = document.getElementById("indexBuiltAt");
  const count   = document.getElementById("indexCount");
  badge.className = "index-badge index-badge-unknown";
  badge.textContent = "조회 중...";
  builtAt.textContent = "-";
  count.textContent   = "-";
  // 코드 버전 행 초기화
  const codeVerRow  = document.getElementById("codeVersionRow");
  const codeVerText = document.getElementById("codeVersionText");
  if (codeVerRow) codeVerRow.style.display = "none";
  // 소요시간/결과 행은 buildIndex 완료 시에만 표시 → 단순 조회 시 숨김 유지
  try {
    const data = await gasGet({ action: "indexStatus" });
    // ★ GAS 코드 버전 표시 (재배포할 때마다 갱신됨)
    if (data.codeVersion && codeVerRow && codeVerText) {
      codeVerText.textContent = data.codeVersion;
      codeVerRow.style.display = "";
    }
    if (!data.exists) {
      badge.className = "index-badge index-badge-none";
      badge.textContent = "없음";
      builtAt.textContent = "인덱스가 없습니다. 갱신 버튼을 눌러주세요.";
    } else if (data.expired) {
      badge.className = "index-badge index-badge-expired";
      badge.textContent = "만료됨";
      builtAt.textContent = data.builtAtStr || "-";
      count.textContent   = (data.count || 0).toLocaleString() + "건";
    } else {
      badge.className = "index-badge index-badge-ok";
      badge.textContent = "정상";
      builtAt.textContent = data.builtAtStr || "-";
      count.textContent   = (data.count || 0).toLocaleString() + "건";
    }
  } catch (err) {
    badge.className = "index-badge index-badge-error";
    badge.textContent = "오류";
    const emsg = err.message || "";
    if (emsg.includes("fetch") || emsg.includes("Failed to fetch") || emsg.includes("NetworkError")) {
      builtAt.textContent = "❌ GAS 응답 없음 — URL 확인 또는 GAS 재배포 필요";
    } else if (emsg === "GAS URL 없음") {
      builtAt.textContent = "GAS URL을 먼저 저장하세요.";
    } else {
      builtAt.textContent = "❌ " + emsg.substring(0, 60);
    }
  }
}

/* ── 동기화 진행 표시 ── */
let _buildTimer = null;
// v6: Sheets API 배치 처리 기준 예상시간 (기존 120초 → 60초로 단축)
// 실제 캠페인 수에 따라 동적 조정
let BUILD_EXPECTED_SEC = 60;

function startBuildProgress(campaignCount) {
  // 캠페인 수에 따라 예상시간 동적 설정
  // Sheets API batchGet 사용 시: 탭 목록 ~5초 + 헤더스캔 ~(N*0.5)초 + 데이터 ~(N*0.8)초
  if (campaignCount && campaignCount > 0) {
    BUILD_EXPECTED_SEC = Math.min(270, Math.max(30, Math.round(5 + campaignCount * 1.2)));
  } else {
    BUILD_EXPECTED_SEC = 60;
  }

  const wrap    = document.getElementById("buildProgressWrap");
  const bar     = document.getElementById("buildProgressBar");
  const label   = document.getElementById("buildProgressLabel");
  const pct     = document.getElementById("buildProgressPct");
  const eta     = document.getElementById("buildProgressEta");
  const elapsed = document.getElementById("buildProgressTime");
  show(wrap);
  bar.style.width = "0%";
  let sec = 0;

  // v6 단계별 메시지 (Sheets API 배치 처리 흐름 반영)
  const stages = [
    { pct: 0,  msg: "베이스시트 캠페인 목록 읽는 중..." },
    { pct: 15, msg: "탭 메타정보 조회 중 (Sheets API)..." },
    { pct: 35, msg: "헤더 배치 스캔 중..." },
    { pct: 55, msg: "데이터 배치 읽기 중..." },
    { pct: 75, msg: "인덱스 행 파싱 중..." },
    { pct: 88, msg: "캐시 저장 중..." },
    { pct: 94, msg: "거의 완료됐어요..." },
  ];

  _buildTimer = setInterval(() => {
    sec++;
    // 로그 스케일 진행 (최대 95%)
    const progress = Math.min(95, Math.round(
      (1 - Math.exp(-sec / (BUILD_EXPECTED_SEC * 0.55))) * 100
    ));
    bar.style.width = progress + "%";
    pct.textContent = progress + "%";
    elapsed.textContent = sec + "초 경과";

    // 단계 메시지
    let curMsg = stages[0].msg;
    for (const s of stages) { if (progress >= s.pct) curMsg = s.msg; }
    label.textContent = curMsg;

    // 잔여 시간
    const remaining = Math.max(0, Math.round(
      BUILD_EXPECTED_SEC * (1 - progress / 100) * 1.15
    ));
    if (progress < 92) {
      eta.textContent = "예상 잔여: 약 " + (remaining >= 60
        ? Math.ceil(remaining / 60) + "분 " + (remaining % 60) + "초"
        : remaining + "초");
    } else {
      eta.textContent = "마무리 중...";
    }
  }, 1000);
}

function stopBuildProgress() {
  if (_buildTimer) { clearInterval(_buildTimer); _buildTimer = null; }
  const wrap  = document.getElementById("buildProgressWrap");
  const bar   = document.getElementById("buildProgressBar");
  const pct   = document.getElementById("buildProgressPct");
  const eta   = document.getElementById("buildProgressEta");
  const label = document.getElementById("buildProgressLabel");
  bar.style.width   = "100%";
  pct.textContent   = "100%";
  eta.textContent   = "완료!";
  label.textContent = "갱신 완료 ✓";
  bar.style.background = "linear-gradient(90deg,#10B981,#059669)";
  setTimeout(() => {
    hide(wrap);
    // 바 색상 원복
    bar.style.background = "linear-gradient(90deg,var(--p),#7C3AED)";
  }, 2500);
}

async function debugBaseSheet() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }
  const btn = document.getElementById("btnDebugBase");
  const resEl = document.getElementById("debugBaseResult");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 진단 중...';
  show(resEl);
  resEl.textContent = "베이스시트 파싱 중...";
  try {
    const data = await gasGet({ action: "debugBaseSheet" }, 15000);
    if (data.ok) {
      const camps = (data.campaigns || []).map(c => `• ${c.name} (${c.id.substring(0,12)}...)`).join("\n");
      resEl.innerHTML =
        `<b>✅ 파싱 성공</b><br>` +
        `시트명: ${data.sheetName || "-"}<br>` +
        `총 행수: ${data.lastRow}, 열수: ${data.lastCol}<br>` +
        `<b>캠페인 수: ${data.campaignCount}개</b><br><br>` +
        `<b>[캠페인 목록 (최대 10개)]</b><br>` +
        (camps ? camps.replace(/\n/g,"<br>") : "없음") +
        (data.sampleRows && data.sampleRows.length ?
          `<br><br><b>[첫 ${data.sampleRows.length}행 원본]</b><br>` +
          data.sampleRows.map(r => `행${r.row}: ${JSON.stringify(r.cells)}`).join("<br>")
          : "");
      if (data.campaignCount === 0) {
        resEl.innerHTML += `<br><br><b style="color:#EF4444">⚠ 캠페인 URL을 찾지 못했습니다.<br>베이스시트 A열에 spreadsheets URL이 있는지 확인하세요.</b>`;
      }
    } else {
      resEl.innerHTML = `<b style="color:#EF4444">❌ 오류: ${data.error}</b><br><small>${data.stack||""}</small>`;
    }
  } catch(e) {
    resEl.textContent = "오류: " + e.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-bug"></i> 베이스시트 파싱 진단';
  }
}

async function debugBuildStep(step) {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }
  const resEl = document.getElementById("debugBaseResult");
  show(resEl);
  resEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Step ${step} 진단 중...`;
  try {
    const data = await gasGet({ action: "debugBuildStep", step: String(step) }, 30000);
    const logHtml = (data.log || []).map(l => {
      if (l.includes("실패") || l.includes("오류") || l.includes("error")) return `<span style="color:#EF4444">${l}</span>`;
      if (l.includes("성공") || l.includes("정상") || l.includes("완료")) return `<span style="color:#10B981">${l}</span>`;
      return `<span style="color:#374151">${l}</span>`;
    }).join("<br>");

    let extra = "";
    if (data.campaigns)  extra += `<br><b>캠페인:</b> ${data.campaigns.map(c=>`${c.name}`).join(", ")}`;
    if (data.tabs)       extra += `<br><b>탭목록:</b> ${data.tabs.join(", ")} <i style="color:#6B7280">(방법: ${data.tabMethod})</i>`;
    if (data.headerMethod) extra += `<br><b>헤더 읽기:</b> ${data.headerMethod}`;
    if (data.preview)    extra += `<br><b>헤더 미리보기:</b><br>${data.preview.slice(0,3).map(r=>JSON.stringify(r)).join("<br>")}`;
    if (data.elapsed)    extra += `<br><b>소요: ${data.elapsed}</b>`;

    if (data.ok) {
      resEl.innerHTML = `<b style="color:#10B981">✅ Step ${step} 정상</b><br>${logHtml}${extra}`;
    } else {
      resEl.innerHTML =
        `<b style="color:#EF4444">❌ Step ${step} 실패</b><br>` +
        `<b>오류: ${data.error || ""}</b><br>` +
        logHtml + extra +
        (data.stack ? `<br><small style="color:#9CA3AF">${data.stack.replace(/\n/g,"<br>")}</small>` : "");
    }
  } catch(e) {
    resEl.innerHTML = `<b style="color:#EF4444">❌ 네트워크 오류: ${e.message}</b>`;
  }
}

/** ─── 특정 시트 개별 진단: 입력값 변경 시 gid 여부 판단 ─── */
function onDebugSheetInput() {
  const raw = (document.getElementById("debugSheetIdInput").value || "").trim();
  const choiceWrap = document.getElementById("debugSheetChoiceWrap");
  // gid 포함 여부 확인
  const hasGid = /[?#&]gid=\d+/.test(raw) || /\/edit.*#gid=\d+/.test(raw);
  if (hasGid && raw.includes("/spreadsheets/d/")) {
    choiceWrap.style.display = "block";
  } else {
    choiceWrap.style.display = "none";
  }
}

/** 진단 버튼 클릭 시 처리 */
function onDebugSheetDiagClick() {
  const raw = (document.getElementById("debugSheetIdInput").value || "").trim();
  if (!raw) { showToast("sheetId 또는 URL을 입력하세요.", "warning"); return; }
  const hasGid = /[?#&]gid=\d+/.test(raw) || /\/edit.*#gid=\d+/.test(raw);
  if (hasGid && raw.includes("/spreadsheets/d/")) {
    // gid 포함: 선택지 표시만 (이미 onDebugSheetInput에서 열렸을 수 있으나 확실히 표시)
    document.getElementById("debugSheetChoiceWrap").style.display = "block";
    // 결과 영역 초기화
    const resEl = document.getElementById("debugSingleResult");
    resEl.className = "hidden";
    resEl.style.display = "none";
    showToast("진단 방식을 선택해주세요.", "info");
  } else {
    // gid 없음: 바로 전체진단 실행
    debugSingleSheet("full");
  }
}

/** ─── 특정 시트 개별 진단 (mode: 'tab' | 'full') ─── */
async function debugSingleSheet(mode) {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }

  const raw   = (document.getElementById("debugSheetIdInput").value || "").trim();
  const resEl = document.getElementById("debugSingleResult");
  if (!raw) { showToast("sheetId 또는 URL을 입력하세요.", "warning"); return; }

  // sheetId 및 gid 추출
  const mId  = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  const sheetId = mId ? mId[1] : raw;
  const mGid = raw.match(/[?#&]gid=(\d+)/);
  const gid  = mGid ? mGid[1] : null;

  // mode 결정: gid 있고 'tab' 모드면 단일탭 진단, 나머지는 전체진단
  const diagMode = (mode === "tab" && gid) ? "tab" : "full";
  const diagGid  = diagMode === "tab" ? gid : null;

  // 선택지 영역 숨기기
  document.getElementById("debugSheetChoiceWrap").style.display = "none";

  show(resEl);
  resEl.style.display = "";
  const modeLabel = diagMode === "tab" ? `gid:${diagGid} (단일탭)` : "전체진단";
  resEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <b>${sheetId.substring(0,16)}…</b> 진단 중 <span style="color:#7C3AED">[${modeLabel}]</span>...`;

  try {
    const params = { action: "debugSingleSheet", sheetId };
    if (diagGid) params.gid = diagGid;
    const data = await gasGet(params, 40000);

    // 결과 렌더링 헬퍼
    const ok    = s => `<span style="color:#10B981;font-weight:700">${s}</span>`;
    const err   = s => `<span style="color:#EF4444;font-weight:700">${s}</span>`;
    const warn  = s => `<span style="color:#D97706;font-weight:700">${s}</span>`;
    const gray  = s => `<span style="color:#6B7280">${s}</span>`;

    const totalTabs = (data.allTabs || []).length;
    const validCount = (data.validTabs || []).length;

    let html = `<b>🔍 진단 대상:</b> ${gray(sheetId)}`;
    if (diagMode === "tab") html += ` ${gray(`(gid:${diagGid} 탭만)`)}`;
    html += `<br><br>`;

    // ① 베이스시트 등록 여부
    html += `<b>① 베이스시트 등록</b>: `;
    if (data.registered === true)  html += ok("✅ 등록됨");
    else if (data.registered === false) html += err("❌ 미등록 → [+업체추가]로 먼저 등록하세요");
    else html += warn("⚠ 확인 불가");
    html += `<br>`;

    // ② 시트 접근 권한
    html += `<b>② 시트 접근 권한</b>: `;
    if (data.accessible === true)       html += ok("✅ 접근 가능");
    else if (data.accessible === false) html += err(`❌ 접근 불가 → ${escHtml(data.accessError || "공유 권한 확인 필요")}`);
    else html += warn("⚠ 확인 불가");
    html += `<br>`;

    // ③ 시트 제목
    if (data.sheetTitle) {
      html += `<b>③ 스프레드시트 제목</b>: ${escHtml(data.sheetTitle)}<br>`;
    }

    // ④ 탭 목록 — 헤더에 "총 N개 중 인덱스 반영 탭 M개" 표시
    if (diagMode === "tab") {
      // 단일탭 진단: 해당 탭 1개만 표시
      html += `<b>④ 탭 목록 (단일탭 진단)</b>: `;
      if (data.allTabs && data.allTabs.length) {
        const tab = data.allTabs[0];
        const isValid = data.validTabs && data.validTabs.includes(tab);
        html += `탭명: ${escHtml(tab)} — ${isValid ? ok("인덱스 반영") : err("스킵됨")}<br>`;
      } else {
        html += warn("해당 탭을 찾을 수 없음") + "<br>";
      }
    } else {
      // 전체진단: 총 N개 중 M개
      html += `<b>④ 탭 목록 (전체)</b>: `;
      if (totalTabs > 0) {
        html += `총 ${totalTabs}개 중 인덱스 반영 탭 ${ok(String(validCount) + "개")}<br>`;
        html += data.allTabs.map(tab => {
          const isValid = data.validTabs && data.validTabs.includes(tab);
          return `  ${isValid ? ok("●") : gray("○")} ${escHtml(tab)}${isValid ? "" : gray(" (스킵됨)")}`;
        }).join("<br>") + "<br>";
      } else {
        html += warn("탭 없음 또는 읽기 실패") + "<br>";
      }
    }

    // ⑤ 스킵 원인 (간소화) — 단일탭 모드는 해당 탭 1개만 표시
    if (data.skipReasons && Object.keys(data.skipReasons).length) {
      // 단일탭 모드: GAS가 전체 탭 스캔 결과를 반환해도 해당 탭만 표시
      let skipEntries = Object.entries(data.skipReasons);
      if (diagMode === "tab" && data.allTabs && data.allTabs.length) {
        const targetTab = data.allTabs[0]; // 단일탭의 탭명
        skipEntries = skipEntries.filter(([tab]) => tab === targetTab);
      }
      if (skipEntries.length > 0) {
        html += `<b>⑤ 스킵 원인</b>:<br>`;
        skipEntries.forEach(([tab, reason]) => {
          const simpleReason = _simplifySkipReason(reason);
          html += `  ${err("✗")} ${escHtml(tab)} → ${warn(simpleReason)}<br>`;
        });
      }
    }

    // ⑥ 헤더 샘플 (첫 번째 유효 탭)
    if (data.headerSample) {
      const sampleTabLabel = data.headerSampleTab ? ` (${escHtml(data.headerSampleTab)})` : "";
      html += `<b>⑥ 헤더 샘플${sampleTabLabel}</b>:<br>`;
      html += gray(JSON.stringify(data.headerSample).substring(0, 200)) + "<br>";
    }

    // 오류 로그
    if (data.errors && data.errors.length) {
      html += `<br><b>⚠ 오류 로그</b>:<br>`;
      data.errors.forEach(e => { html += `  ${err("→")} ${escHtml(e)}<br>`; });
    }

    // 최종 판정
    html += `<br><b>🏁 최종 판정</b>: `;
    if (data.verdict === "ok") {
      // 단일탭 모드: 인덱스 실제 포함 여부 추가 표시
      if (diagMode === "tab") {
        if (data.isInIndex === true) {
          html += ok("✅ 정상 + 현재 인덱스에도 포함됨 (대시보드에 바로 표시)");
        } else if (data.isInIndex === false) {
          html += warn("⚠ 헤더 정상 (스킵 없음) — 그러나 현재 인덱스에 미포함") +
            `<br><small style="color:#D97706;margin-left:2px">→ [인덱스 지금 갱신] 버튼을 눌러야 대시보드에 반영됩니다.</small>`;
        } else {
          html += ok("✅ 정상 — 동기화 시 포함됩니다");
        }
      } else {
        html += ok("✅ 정상 — 동기화 시 포함됩니다");
      }
    }
    else if (data.verdict === "tab_not_found") html += err(`❌ gid:${diagGid} 탭을 찾을 수 없음 — URL의 gid 값을 확인하세요`);
    else if (data.verdict === "no_tab" || data.verdict === "no_valid_tab") html += err("❌ 유효 탭 없음 — 탭명 패턴 또는 헤더 확인 필요");
    else if (data.verdict === "no_access") html += err("❌ 접근 불가 — 시트 공유 설정 확인");
    else if (data.verdict === "not_registered") html += err("❌ 미등록 — [+업체추가] 필요");
    else if (data.verdict)                 html += warn(escHtml(data.verdict));
    else if (data.error)                   html += err(escHtml(data.error));

    // 단일탭 모드에서 인덱스 미포함인 경우 원인 힌트 추가
    if (diagMode === "tab" && data.isInIndex === false && data.verdict === "ok") {
      const tabName = data.allTabs && data.allTabs[0] ? data.allTabs[0] : "";
      html += `<br><br><b>💡 대시보드 미표시 원인 후보:</b><br>`;
      html += `&nbsp;&nbsp;1. 동기화 전 상태 → <b>[인덱스 지금 갱신]</b> 클릭 후 재확인<br>`;
      html += `&nbsp;&nbsp;2. 갱신 시 해당 탭이 스킵됐을 가능성 → 갱신 후 재진단<br>`;
      html += `&nbsp;&nbsp;3. 세부목록에 해당 탭 미등록 → ⚙ 탭설정 후 저장<br>`;
      if (tabName) html += `&nbsp;&nbsp;4. 탭명 특수문자/공백 문제: <i>"${escHtml(tabName)}"</i><br>`;
    }

    resEl.innerHTML = html;

  } catch(e) {
    resEl.innerHTML = `<b style="color:#EF4444">❌ 네트워크/GAS 오류: ${escHtml(e.message)}</b><br><small>GAS 백엔드에 debugSingleSheet 액션이 구현되어 있어야 합니다.</small>`;
  }
}

/** 스킵 원인 문자열 간소화 헬퍼 */
function _simplifySkipReason(reason) {
  if (!reason) return "알 수 없음";
  const r = String(reason);
  // 헤더 키워드 없음 패턴
  if (r.includes("DATA_TAB_KEYWORDS") || r.includes("헤더 키워드") || r.includes("header keyword") || r.includes("번호") || r.includes("주문자")) {
    return "헤더 키워드 없음 (번호/주문자/수취인/수취인명/성함 중 없음)";
  }
  // 검색 컬럼 없음
  if (r.includes("SEARCH_COL") || r.includes("검색 컬럼") || r.includes("name column")) {
    return "이름 컬럼 없음 (수취인/주문자/성함 등 없음)";
  }
  // 숨김 탭
  if (r.includes("hidden") || r.includes("숨김")) {
    return "숨겨진 탭";
  }
  // 시스템 탭
  if (r.includes("INDEX_TAB") || r.includes("인덱스") || r.includes("세부목록") || r.includes("탭설정")) {
    return "시스템 탭 (제외 대상)";
  }
  // 빈 탭
  if (r.includes("empty") || r.includes("비어") || r.includes("데이터 없")) {
    return "데이터 없음 (빈 탭)";
  }
  // 기타: 100자 이상이면 잘라냄
  return r.length > 80 ? r.substring(0, 80) + "…" : r;
}

/** ─── 세부목록(탭설정) 진단 함수들 ─── */
async function debugTabConfig() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }
  const resEl = document.getElementById("debugTabConfigResult");
  show(resEl);
  resEl.textContent = "⏳ 세부목록 현황 조회 중...";
  try {
    const data = await gasGet({ action: "debugTabConfig" }, 15000);
    const dl = data.detailSheet || {};
    const lines = [
      `📋 세부목록 탭 존재: ${dl.exists ? "✅ 있음" : "❌ 없음"}`,
      `📊 현재 행 수: ${dl.lastRow || 0}행`,
      `🆔 DB(tab_configs) 기반 관리 중`,
      `📌 탭 이름: "${data.DETAIL_SHEET_NAME || "세부목록"}"`,
    ];
    if (dl.exists && dl.data && dl.data.length > 0) {
      lines.push("", "📄 저장된 데이터 (최대 10행):");
      dl.data.slice(0, 10).forEach((row, i) => {
        if (i === 0) {
          lines.push(`  헤더: ${row.map(c => String(c).substring(0,20)).join(" | ")}`);
        } else {
          const url  = String(row[0] || "").substring(0, 30);
          const tab  = String(row[1] || "-");
          const mgr  = String(row[2] || "-");
          const time = String(row[3] || "-");
          const tk   = String(row[4] || "-");
          const rv   = String(row[5] || "-");
          lines.push(`  ${i}행: [${tab}] 담당:${mgr} 시간:${time} 택대:${tk} 리뷰:${rv}`);
        }
      });
    } else if (!dl.exists) {
      lines.push("", "⚠️ 세부목록 탭이 없습니다.", "→ 저장 테스트 버튼을 눌러 탭 자동 생성을 확인하세요.");
    } else {
      lines.push("", "ℹ️ 아직 저장된 데이터가 없습니다.");
    }
    resEl.textContent = lines.join("\n");
  } catch(e) {
    resEl.textContent = "❌ 오류: " + e.message + "\n\n(GAS가 최신 버전으로 재배포되었는지 확인하세요)";
  }
}

async function testTabConfigSave() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }
  const resEl = document.getElementById("debugTabConfigResult");
  show(resEl);
  resEl.textContent = "⏳ 테스트 저장 중... (베이스시트 세부목록에 테스트 행 추가)";
  try {
    const data = await gasGet({ action: "testTabConfig" }, 15000);
    if (data.ok) {
      resEl.textContent =
        `✅ 저장 테스트 성공!\n` +
        `tabName: ${data.tabName || "테스트탭"}\n` +
        `행 위치: ${data.row}행\n` +
        `신규/업데이트: ${data.updated ? "업데이트" : "신규 추가"}\n\n` +
        `→ 베이스시트의 "세부목록" 탭을 확인하세요.`;
      showToast("✅ 테스트 저장 성공! 세부목록 탭을 확인하세요.");
    } else {
      resEl.textContent = `❌ 저장 실패: ${data.error || JSON.stringify(data)}\n\n(GAS 재배포 필요 여부 확인)`;
    }
  } catch(e) {
    resEl.textContent =
      `❌ 네트워크/GAS 오류: ${e.message}\n\n` +
      `가능한 원인:\n` +
      `1. GAS가 구버전으로 배포됨 → 새 버전으로 재배포 필요\n` +
      `2. GAS URL이 잘못됨 → 설정에서 URL 확인\n` +
      `3. 스프레드시트 권한 없음 → 시트 접근 권한 확인`;
  }
}

// ── 구매캡쳐/리뷰저장 폴더 일괄 동기화 ────────────────────────
async function syncAllFolders() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }
  const btn = document.getElementById("btnSyncAllFolders");
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 동기화 중...';

  try {
    const data = await gasGet({ action: "syncAllFolders" }, 120000);
    if (data.error) {
      showToast("❌ 폴더 동기화 실패: " + data.error, "error");
    } else {
      const lines = [];
      if (data.capture) lines.push(`📂 캡쳐폴더 ${data.capture.updated}건 업데이트, ${data.capture.skipped}건 유지`);
      if (data.review)  lines.push(`📁 리뷰폴더 ${data.review.updated}건 업데이트, ${data.review.skipped}건 유지${data.review.notFound > 0 ? `, ${data.review.notFound}건 미매칭` : ""}`);
      showToast("✅ 일괄 동기화 완료 (" + data.elapsed + "초)\n" + lines.join(" / "), "success");
      try { await loadAdminDashboard(); } catch(_) {}
    }
  } catch (err) {
    showToast("❌ 폴더 동기화 오류: " + (err.message || ""), "error");
  } finally {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-folder-sync"></i> 구매캡쳐/리뷰저장 폴더 일괄동기화';
  }
}

/** ★ 동기화 완료 후 대시보드 자동 새로고침 */
function _autoRefreshDashboardAfterBuild() {
  // 관리자 화면이 열려 있고, 대시보드 탭이 보이는 상태일 때만 자동 동기화
  const screenAdmin = document.getElementById("screenAdmin");
  if (!screenAdmin || !screenAdmin.classList.contains("active")) return;
  const dashWrap = document.getElementById("dashboardWrap");
  if (!dashWrap) return;
  // 약간의 딜레이 후 새로고침 (GAS 캐시 반영 대기)
  setTimeout(() => {
    showToast("🔄 대시보드 자동 새로고침 중...", "info");
    loadAdminDashboard();
  }, 800);
}

/* ── 업체(캠페인) 추가 ── */
function openAddCampaign() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("❌ GAS 웹앱 URL이 설정되지 않았습니다.", true); return;
  }
  document.getElementById("addCampUrl").value = "";
  document.getElementById("addCampPreview").textContent = "";
  document.getElementById("addCampError").textContent = "";
  document.getElementById("addCampPreviewBtn").disabled = true;
  document.getElementById("addCampPreviewBtn").style.display = "";
  document.getElementById("addCampSubmitBtn").style.display = "none";
  document.getElementById("addCampPreviewArea").style.display = "none";
  document.getElementById("addCampUrl").classList.remove("has-val");
  document.getElementById("addCampOverlay").classList.add("open");
  setTimeout(() => document.getElementById("addCampUrl").focus(), 80);
}
function closeAddCampaign() {
  document.getElementById("addCampOverlay").classList.remove("open");
}

/** URL 입력 시 실시간 정제 미리보기 */
function onAddCampInput() {
  const raw = document.getElementById("addCampUrl").value.trim();
  const errEl = document.getElementById("addCampError");
  const preEl = document.getElementById("addCampPreview");
  const btn   = document.getElementById("addCampPreviewBtn");
  const inp   = document.getElementById("addCampUrl");
  errEl.textContent = "";
  // URL 변경 시 미리보기 초기화
  document.getElementById("addCampPreviewArea").style.display = "none";
  document.getElementById("addCampSubmitBtn").style.display = "none";
  btn.style.display = "";
  if (!raw) {
    preEl.textContent = ""; btn.disabled = true; inp.classList.remove("has-val"); return;
  }
  // sheetId 추출 정규식
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!m) {
    preEl.textContent = "";
    errEl.textContent = "구글 스프레드시트 URL 형식이 아닙니다.";
    btn.disabled = true; inp.classList.remove("has-val"); return;
  }
  const cleanUrl = "https://docs.google.com/spreadsheets/d/" + m[1] + "/edit";
  preEl.textContent = "→ " + cleanUrl;
  btn.disabled = false;
  inp.classList.add("has-val");
}

/** 1단계: 미리보기 — 시트 제목 + 탭 목록 확인 */
async function previewAddCampaign() {
  const raw = document.getElementById("addCampUrl").value.trim();
  const errEl = document.getElementById("addCampError");
  const btn   = document.getElementById("addCampPreviewBtn");
  if (!raw) return;
  errEl.textContent = "";
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 조회중...';
  try {
    const data = await gasGet({ action: "previewCampaign", url: raw });
    if (!data.ok) {
      if (data.serviceAccount) {
        const sa = data.serviceAccount;
        const sheetUrl = raw.trim();
        errEl.innerHTML = `
          <div style="color:#dc2626;font-size:12px;line-height:1.6;margin-bottom:6px;">
            시트 접근 권한이 없습니다.<br>아래 서비스 계정을 추가하려는 시트에<br><b>액세스 권한을 편집자로 추가</b> 후 다시 시도해주세요.
          </div>
          <div style="display:flex;align-items:center;gap:6px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:6px 10px;margin-bottom:8px;">
            <code style="font-size:11px;color:#334155;flex:1;word-break:break-all;user-select:all;">${sa}</code>
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="navigator.clipboard.writeText('${sa}').then(()=>{this.innerHTML='<i class=\\'fas fa-check\\'></i> 복사됨';this.style.background='#10b981';setTimeout(()=>{this.innerHTML='<i class=\\'fas fa-copy\\'></i> 서비스계정 복사';this.style.background='#6366f1'},1500)})"
              style="flex:1;padding:6px 10px;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">
              <i class="fas fa-copy"></i> 서비스계정 복사
            </button>
            <button onclick="window.open('${sheetUrl}','_blank')"
              style="flex:1;padding:6px 10px;background:#0ea5e9;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">
              <i class="fas fa-external-link-alt"></i> 시트 이동
            </button>
          </div>`;
      } else {
        errEl.textContent = data.error || "시트 조회 실패";
      }
      return;
    }
    // 시트 제목
    document.getElementById("addCampSheetTitle").textContent = data.spreadsheetTitle;
    // 이미 등록 여부
    const badge = document.getElementById("addCampAlreadyBadge");
    if (data.alreadyRegistered) {
      badge.style.display = "block";
      badge.textContent = "⚠ 이미 등록된 캠페인입니다 (" + data.existingName + "). 다시 등록하면 업데이트됩니다.";
    } else {
      badge.style.display = "none";
    }
    // 탭 목록
    document.getElementById("addCampTabCount").textContent = data.tabCount;
    const listEl = document.getElementById("addCampTabList");
    listEl.innerHTML = "";
    for (const tab of data.tabs) {
      const el = document.createElement("div");
      el.style.cssText = "padding:4px 8px; background:#fff; border:1px solid #e2e8f0; border-radius:4px; font-size:12px; color:#334155;";
      el.textContent = tab.name;
      listEl.appendChild(el);
    }
    if (data.tabs.length === 0) {
      listEl.innerHTML = '<div style="color:#94a3b8; font-size:12px;">탭이 없습니다 (시스템 탭 제외)</div>';
    }
    // 미리보기 영역 표시, 확인 버튼 숨기고 등록 버튼 표시
    document.getElementById("addCampPreviewArea").style.display = "block";
    btn.style.display = "none";
    document.getElementById("addCampSubmitBtn").style.display = "";
    document.getElementById("addCampSubmitBtn").disabled = false;
  } catch (err) {
    errEl.textContent = err.message || "조회 실패";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-search"></i> 확인';
  }
}

/** 2단계: 등록 실행 */
async function submitAddCampaign() {
  const raw = document.getElementById("addCampUrl").value.trim();
  const errEl = document.getElementById("addCampError");
  const btn   = document.getElementById("addCampSubmitBtn");
  if (!raw) return;
  errEl.textContent = "";
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 중...';
  try {
    const data = await gasGet({ action: "addCampaign", url: raw });
    closeAddCampaign();
    showToast(`✅ 등록 완료: ${data.campaignName} (${data.url})`);
    // 등록 후 동기화 안내 토스트
    setTimeout(() => showToast("💡 동기화 버튼을 눌러 대시보드에 반영하세요.", false), 2200);
  } catch (err) {
    errEl.textContent = err.message || "등록 실패";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plus"></i> 등록';
  }
}
// ESC 키로 모달 닫기
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") {
    if (document.getElementById("addCampOverlay").classList.contains("open"))
      closeAddCampaign();
  }
});

/* ── 열쇠 드롭다운 메뉴 ── */
function toggleKeyMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('keyDropdown');
  const isHidden = dd.style.display === 'none' || !dd.style.display;
  dd.style.display = isHidden ? 'block' : 'none';
}
function closeKeyMenu() {
  const dd = document.getElementById('keyDropdown');
  if (dd) dd.style.display = 'none';
}
// 외부 클릭 시 드롭다운 닫기
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('keyMenuWrap');
  if (wrap && !wrap.contains(e.target)) closeKeyMenu();
});

/* ── 비밀번호 변경 ── */
function openChangePw() {
  document.getElementById("cpCurrentPw").value = "";
  document.getElementById("cpNewPw").value     = "";
  document.getElementById("cpNewPw2").value    = "";
  hide("changePwError");
  show("changePwModal", "flex");
}
function closeChangePw() { hide("changePwModal"); }
async function submitChangePw() {
  const currentPw = document.getElementById("cpCurrentPw").value;
  const newPw     = document.getElementById("cpNewPw").value;
  const newPw2    = document.getElementById("cpNewPw2").value;
  const errEl     = document.getElementById("changePwError");
  hide(errEl);
  if (!currentPw || !newPw || !newPw2) { errEl.textContent = "모든 항목을 입력하세요."; show(errEl); return; }
  if (newPw !== newPw2)                { errEl.textContent = "새 비밀번호가 일치하지 않습니다."; show(errEl); return; }
  if (newPw.length < 4)               { errEl.textContent = "새 비밀번호는 4자 이상이어야 합니다."; show(errEl); return; }
  showLoading("변경 중...");
  try {
    const data = await gasPost({ action: "adminChangePw", currentPw, newPw });
    hideLoading();
    if (data.success) {
      closeChangePw();
      showToast("비밀번호가 변경되었습니다.", "success");
    } else {
      errEl.textContent = data.error || "오류가 발생했습니다.";
      show(errEl);
    }
  } catch (err) {
    hideLoading();
    showToast("오류: " + err.message, "error");
  }
}

function togglePwVisible(inputId, btn) {
  const input = document.getElementById(inputId);
  const icon  = btn.querySelector("i");
  if (input.type === "password") {
    input.type     = "text";
    icon.className = "fas fa-eye-slash";
  } else {
    input.type     = "password";
    icon.className = "fas fa-eye";
  }
}

/* ── GAS 통신 ──
/**
 * ★ GAS JSONP 테스트 함수
 * indexStatus를 JSONP로 호출해 현재 배포된 GAS가 callback 파라미터를 처리하는지 확인
 */
async function testGasJsonp() {
  const btn    = document.getElementById("btnTestJsonp");
  const resEl  = document.getElementById("jsonpTestResult");
  const url    = APP_CONFIG.GAS_WEB_APP_URL;
  if (!url) { showToast("GAS URL을 먼저 저장해주세요.", "warning"); return; }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 테스트 중...';
  resEl.style.display = "block";
  resEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> JSONP 테스트 중...';

  try {
    const t0   = Date.now();
    const data = await _jsonpGet(`${url}?action=indexStatus`, 10000);
    const ms   = Date.now() - t0;
    if (data && (data.exists !== undefined || data.count !== undefined)) {
      const verBadge = data.codeVersion
        ? `<br><span style="color:#7C3AED;font-weight:600">📌 Code.gs 버전: ${escHtml(data.codeVersion)}</span>`
        : "";
      resEl.innerHTML =
        `<span style="color:#059669;font-weight:700">✅ JSONP 지원 확인됨</span> (${ms}ms)<br>` +
        `GAS 버전이 정상입니다. 동기화을 진행할 수 있습니다.${verBadge}<br>` +
        `<small style="color:#6B7280">응답: count=${data.count||0}, exists=${data.exists}</small>`;
      // 코드 버전 행 갱신
      const cvRow  = document.getElementById("codeVersionRow");
      const cvText = document.getElementById("codeVersionText");
      if (data.codeVersion && cvRow && cvText) { cvText.textContent = data.codeVersion; cvRow.style.display = ""; }
      // 오류 배너 숨김
      const b = document.getElementById("gasErrorBanner");
      if (b) b.style.display = "none";
    } else if (data && data.error) {
      resEl.innerHTML =
        `<span style="color:#D97706;font-weight:700">⚠ JSONP는 됐지만 GAS 오류:</span> ${escHtml(data.error)}`;
    } else {
      resEl.innerHTML =
        `<span style="color:#D97706;font-weight:700">⚠ 응답 형식 이상:</span> ${JSON.stringify(data).substring(0,100)}`;
    }
  } catch (e) {
    const m = e.message || "";
    if (m.includes("스크립트 로드 실패") || m.includes("Script load failed")) {
      resEl.innerHTML =
        `<span style="color:#DC2626;font-weight:700">❌ JSONP 미지원</span><br>` +
        `현재 배포된 GAS가 <b>구버전</b>입니다.<br>` +
        `<b>Code.gs를 최신 버전으로 재배포</b>하면 해결됩니다.<br>` +
        `<small style="color:#6B7280">▶ 배포 → 기존 배포 관리 → 수정(연필) → 새 버전 → 배포</small>`;
      document.getElementById("gasErrorBanner").style.display = "block";
    } else if (m.includes("시간 초과")) {
      resEl.innerHTML = `<span style="color:#D97706;font-weight:700">⚠ 시간 초과</span> — GAS가 응답하지 않습니다.`;
    } else {
      resEl.innerHTML = `<span style="color:#DC2626;font-weight:700">❌ 오류:</span> ${escHtml(m)}`;
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plug"></i> GAS 연결 테스트 (JSONP 지원 여부)';
  }
}

/*
 * GAS 웹앱은 긴 요청 시 302 리다이렉트 발생 → CORS 헤더 유실 문제
 * 해결: <script> 태그 JSONP 방식으로 완전 우회 (preflight 없음, CORS 무관)
 */
let _jsonpSeq = 0;
function _jsonpGet(fullUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cbName = "__gasCb" + (++_jsonpSeq) + "_" + Date.now();
    const script  = document.createElement("script");
    let   settled = false;
    const tid = setTimeout(() => {
      if (settled) return;
      settled = true;
      script.remove();
      delete window[cbName];
      reject(new Error("요청 시간 초과"));
    }, timeoutMs || 60000);

    window[cbName] = function(data) {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      script.remove();
      delete window[cbName];
      resolve(data);
    };

    // GAS에 callback 파라미터 추가
    const sep = fullUrl.includes("?") ? "&" : "?";
    script.src = fullUrl + sep + "callback=" + cbName;
    script.onerror = function() {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      script.remove();
      delete window[cbName];
      reject(new Error("스크립트 로드 실패 (GAS URL 확인)"));
    };
    document.head.appendChild(script);
  });
}

// ★ [Node.js 이관] api.js로 대체됨
// // async function gasGet(params, timeoutMs) {
//   const url = APP_CONFIG.GAS_WEB_APP_URL;
//   if (!url) throw new Error("GAS URL 없음");
//   const qs      = new URLSearchParams(params).toString();
//   const fullUrl = `${url}?${qs}`;
//   const json = await _jsonpGet(fullUrl, timeoutMs || 60000);
//   if (json && json.error) throw new Error(json.error);
//   return json;
// }
// async function gasPost(body) {
//   const url = APP_CONFIG.GAS_WEB_APP_URL;
//   if (!url) throw new Error("GAS URL 없음");
// 
//   // ★ 파일 데이터가 있거나, submitOrderForm 같이 데이터가 긴 action은 실제 fetch POST 사용
//   const hasFiles = body.files || body.fileBase64 || body.fileData;
//   const forcePost = hasFiles || ["submitOrderForm","checkDuplicateOrder","extractOrderImage","uploadOrderImage"].includes(body.action);
// 
//   if (forcePost) {
//     // ── 1차 시도: fetch POST (redirect:follow 로 GAS 302 리디렉션 자동 처리) ──
//     let lastFetchErr = null;
//     for (let attempt = 1; attempt <= 2; attempt++) {
//       try {
//         const resp = await fetch(url, {
//           method:   "POST",
//           headers:  { "Content-Type": "text/plain;charset=UTF-8" },
//           body:     JSON.stringify(body),
//           redirect: "follow"   // ★ GAS 302 리디렉션 자동 추적
//         });
//         if (!resp.ok) throw new Error("HTTP " + resp.status);
//         // GAS가 가끔 text/html을 반환하는 경우 대비 — JSON 파싱 방어
//         const text = await resp.text();
//         let json;
//         try { json = JSON.parse(text); }
//         catch (_) { throw new Error("서버 응답을 파싱할 수 없습니다 (HTML 반환 의심)"); }
//         if (json && json.error) throw new Error(json.error);
//         return json;
//       } catch (e) {
//         lastFetchErr = e;
//         if (attempt < 2) {
//           console.warn("[gasPost] fetch POST 1차 실패, 1.5초 후 재시도:", e.message);
//           await new Promise(r => setTimeout(r, 1500));
//         }
//       }
//     }
//     // fetch POST 2회 모두 실패 시 명확한 에러 throw
//     throw new Error(
//       (lastFetchErr?.message && lastFetchErr.message !== "Failed to fetch")
//         ? lastFetchErr.message
//         : "서버 연결에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요."
//     );
//   }
// 
//   // ★ 단순 action 요청: JSONP(GET)로 CORS 우회
//   const params = { ...body, _method: "POST" };
//   const qs = new URLSearchParams(
//     Object.fromEntries(
//       Object.entries(params).map(([k,v]) =>
//         [k, typeof v === "object" ? JSON.stringify(v) : String(v)]
//       )
//     )
//   ).toString();
//   const fullUrl = `${url}?${qs}`;
//   const json = await _jsonpGet(fullUrl, 30000);
//   if (json && json.error) throw new Error(json.error);
//   return json;
// }

/* ── 유틸 ── */

/**
 * ★ 이미지 압축/리사이즈 (모바일 최적화)
 * - 최대 1920px으로 리사이즈
 * - JPEG 품질 0.75로 압축
 * - 원본 1MB 이하면 압축 스킵 (이미 작은 파일)
 */
function compressImage(file, maxWidth = 1920, quality = 0.75) {
  return new Promise((resolve, reject) => {
    // 1MB 이하이고 JPEG이면 압축 불필요
    if (file.size <= 1024 * 1024 && file.type === 'image/jpeg') {
      return fileToBase64Raw(file).then(resolve).catch(reject);
    }

    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;

      // 리사이즈 필요 여부 확인
      if (width > maxWidth) {
        height = Math.round(height * (maxWidth / width));
        width = maxWidth;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // JPEG로 압축 (품질 0.75)
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const b64 = dataUrl.split(',')[1];
      if (!b64) {
        reject(new Error('이미지 압축 실패'));
        return;
      }

      // 압축된 크기 계산
      const compressedSize = Math.round(b64.length * 0.75); // base64 → binary 크기 추정
      console.log(`[compress] ${file.name}: ${(file.size/1024).toFixed(0)}KB → ${(compressedSize/1024).toFixed(0)}KB (${width}x${height})`);

      resolve(b64);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      // 이미지 로드 실패 시 원본 Base64로 폴백
      fileToBase64Raw(file).then(resolve).catch(reject);
    };

    img.src = url;
  });
}

/** 원본 Base64 변환 (압축 없이) */
function fileToBase64Raw(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result;
      if (!result || !result.includes(",")) {
        rej(new Error("파일 읽기 결과가 비어있습니다"));
        return;
      }
      res(result.split(",")[1]);
    };
    r.onerror = (ev) => rej(new Error("파일 읽기 오류: " + (ev?.target?.error?.message || "알 수 없는 오류")));
    r.onabort = () => rej(new Error("파일 읽기가 중단되었습니다"));
    r.readAsDataURL(file);
  });
}

/** ★ fileToBase64 — 이미지는 자동 압축, 그 외는 원본 변환 */
function fileToBase64(file) {
  if (file.type && file.type.startsWith('image/')) {
    return compressImage(file);
  }
  return fileToBase64Raw(file);
}
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function showLoading(text="처리 중...") {
  const el = document.getElementById("loadingOverlay");
  const t  = document.getElementById("loadingText");
  if (t) t.textContent = text;
  el.classList.remove("fade-out"); el.style.display = "flex";
}
function hideLoading() {
  const el = document.getElementById("loadingOverlay");
  el.classList.add("fade-out");
  setTimeout(() => { el.style.display = "none"; el.classList.remove("fade-out"); }, 280);
}

// ══════════════════════════════════════════════════════════
// ★ 파일 존재 확인 모달
// ══════════════════════════════════════════════════════════
function openCheckFilesModal() {
  const modal = document.getElementById("checkFilesModal");
  if (!modal) return;
  // 초기화
  document.getElementById("checkFilesPwInput").value = "";
  const res = document.getElementById("checkFilesResult");
  res.style.display = "none";
  res.innerHTML = "";
  modal.classList.add("open");
  setTimeout(() => document.getElementById("checkFilesPwInput").focus(), 80);
}

function closeCheckFilesModal() {
  const modal = document.getElementById("checkFilesModal");
  if (modal) modal.classList.remove("open");
}

// ESC 키로 모달 닫기
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeCheckFilesModal();
});

// 모달 바깥 클릭 시 닫기
document.getElementById("checkFilesModal")?.addEventListener("click", function(e) {
  if (e.target === this) closeCheckFilesModal();
});

async function runCheckReviewFiles() {
  const pwInput = document.getElementById("checkFilesPwInput");
  const pw = (pwInput?.value || "").trim();
  if (!pw) { showToast("비밀번호를 입력하세요.", "error"); pwInput?.focus(); return; }

  const resEl = document.getElementById("checkFilesResult");
  resEl.style.display = "";
  resEl.innerHTML = `<div class="cfr-summary running">
    <i class="fas fa-spinner fa-spin"></i> 전체 시트 순회 중… 수십 초 소요될 수 있습니다.
  </div>`;

  // 실행 버튼 비활성화
  const runBtn = resEl.closest(".check-files-box")?.querySelector("button[onclick='runCheckReviewFiles()']");
  if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 실행 중…'; }

  try {
    let res;
    try {
      res = await gasPost({ action: "checkReviewFiles", pw });
    } catch (_) {
      res = await gasGet({ action: "checkReviewFiles", pw });
    }

    if (res.error) {
      resEl.innerHTML = `<div class="cfr-item error">
        <i class="fas fa-times-circle"></i> ${escHtml(res.error)}
      </div>`;
      return;
    }

    const { restored = 0, results = [], errors = [] } = res;
    let html = "";

    // 요약
    if (restored === 0 && errors.length === 0) {
      html += `<div class="cfr-summary ok">
        <i class="fas fa-check-circle"></i> 삭제된 파일 없음 — 모든 리뷰 파일이 정상입니다.
      </div>`;
    } else if (restored > 0) {
      html += `<div class="cfr-summary warn">
        <i class="fas fa-undo-alt"></i> ${restored}건 복원됨 — 대시보드를 새로고침하면 반영됩니다.
      </div>`;
    }

    // 복원 항목
    results.forEach(item => {
      html += `<div class="cfr-item restored">
        <b>${escHtml(item.name)}</b>
        <span style="color:#059669;margin-left:6px">${escHtml(item.tabName)}</span>
        <span style="font-size:.75rem;color:#6B7280;margin-left:4px">행${item.rowIndex}</span><br>
        <span style="font-size:.75rem">${escHtml(item.reason)}</span>
      </div>`;
    });

    // 오류 항목
    errors.forEach(err => {
      html += `<div class="cfr-item error">
        <i class="fas fa-exclamation-triangle"></i> ${escHtml(String(err))}
      </div>`;
    });

    if (!html) {
      html = `<div class="cfr-item empty">결과 없음</div>`;
    }

    resEl.innerHTML = html;

    // 복원이 있으면 비밀번호 입력란 비우기
    if (restored > 0) {
      pwInput.value = "";
      showToast(restored + "건 복원 완료. 대시보드를 새로고침하세요.", "success");
    }

  } catch (err) {
    resEl.innerHTML = `<div class="cfr-item error">
      <i class="fas fa-times-circle"></i> 통신 오류: ${escHtml(err.message || String(err))}
    </div>`;
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = '<i class="fas fa-search"></i> 확인 실행';
    }
  }
}
function showToast(msg, type="info", duration=3500) {
  const c = document.getElementById("toastContainer");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const icons = { error:"fa-circle-xmark", success:"fa-circle-check", warning:"fa-triangle-exclamation", info:"fa-circle-info" };
  t.innerHTML = `<i class="fas ${icons[type]||"fa-circle-info"}"></i>${escHtml(msg)}`;
  c.appendChild(t);
  setTimeout(() => { t.style.transition="opacity .3s"; t.style.opacity="0"; setTimeout(()=>t.remove(),300); }, duration);
}

/** ★ 화면 중앙 팝업 알림 (에러/안내용) — 토스트 대신 화면 정중앙에 표시 */
function showCenterAlert(msg, duration=4000) {
  // 기존 팝업 제거
  const old = document.getElementById("_centerAlertOverlay");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "_centerAlertOverlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);padding:20px;animation:fadeIn .2s";
  overlay.innerHTML = `<div style="background:#fff;border-radius:14px;padding:24px 28px;max-width:320px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.18)">
    <div style="font-size:.95rem;font-weight:600;color:#DC2626;line-height:1.5;word-break:keep-all">${msg}</div>
    <button onclick="this.closest('#_centerAlertOverlay').remove()" style="margin-top:18px;padding:10px 32px;border:none;border-radius:8px;background:#DC2626;color:#fff;font-size:.9rem;font-weight:600;cursor:pointer">확인</button>
  </div>`;
  document.body.appendChild(overlay);

  // 자동 닫기
  if (duration > 0) {
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, duration);
  }
}

/* ══════════════════════════════════════════════
   검색 진단 모달 (searchAll GAS 응답 직접 조회)
   ══════════════════════════════════════════════ */
function openSearchDebugModal() {
  document.getElementById('searchDebugModal').style.display = 'flex';
  document.getElementById('debugNameInput').focus();
}
function closeSearchDebugModal() {
  document.getElementById('searchDebugModal').style.display = 'none';
}

async function runSearchDebug() {
  const q = document.getElementById('debugNameInput').value.trim();
  if (!q || q.length < 2) { showToast('이름을 2글자 이상 입력하세요.', 'warning'); return; }

  // UI 초기화
  const elResult  = document.getElementById('debugResult');
  const elLoading = document.getElementById('debugLoading');
  const elEmpty   = document.getElementById('debugEmpty');
  const elError   = document.getElementById('debugError');
  elResult.style.display  = 'none';
  elLoading.style.display = 'block';
  elEmpty.style.display   = 'none';
  elError.style.display   = 'none';

  try {
    // GAS searchAll 원본 응답 (isSubmitted 포함 전체 행)
    const data = await gasGet({ action: 'searchAllDebug', query: q });
    elLoading.style.display = 'none';

    // GAS가 searchAllDebug를 지원하지 않으면 일반 searchAll 사용
    const rawResults = data.results || data.allResults || [];

    if (!rawResults.length) {
      elEmpty.style.display = 'block';
      return;
    }

    // 통계
    const total     = rawResults.length;
    const submitted = rawResults.filter(r => r.isSubmitted).length;
    const pending   = total - submitted;
    document.getElementById('debugSummary').innerHTML =
      `전체 <b>${total}건</b> | ` +
      `<span style="color:#DC2626">isSubmitted=true: <b>${submitted}건</b></span> | ` +
      `<span style="color:#059669">isSubmitted=false(검색 노출): <b>${pending}건</b></span>`;

    // 테이블 렌더
    const tbody = document.getElementById('debugTableBody');
    tbody.innerHTML = '';
    rawResults.forEach((r, i) => {
      const isS    = r.isSubmitted;
      const rdRaw  = r.submitVal !== undefined ? r.submitVal : (r.reviewDoneRaw !== undefined ? r.reviewDoneRaw : (r.row ? r.row[r.submitCol] : '—'));
      const submitColDisp = r.submitCol || '(없음)';
      const depDisp  = r.depositor || '';
      const accDisp  = r.account   || '';
      const bankDisp = r.bank      || '';
      // 원인 힌트
      let causeHint = '';
      if (isS) {
        if (r.submitCol && r.submitCol !== '(없음)') causeHint = `리뷰컬럼(${r.submitCol})="${rdRaw}"`;
        else if (depDisp && accDisp && bankDisp) causeHint = `리뷰컬럼없음→예금주+계좌+은행 모두채움`;
        else causeHint = `제출값="${rdRaw}"`;
      }
      const tr = document.createElement('tr');
      tr.style.background = isS ? '#FEF2F2' : '#F0FDF4';
      tr.innerHTML = `
        <td style="padding:5px 8px;border:1px solid #E5E7EB;color:#6B7280">${i+1}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-weight:600">${escHtml(r.displayName||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-size:.7rem;color:#4B5563">${escHtml((r.campaignName||'')+(r.tabName?(' / '+r.tabName):''))}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-size:.7rem">${escHtml(r.productName||r.tcDisplayName||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;font-weight:700;color:${isS?'#DC2626':'#059669'}">${isS?'✅ true':'⬜ false'}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-family:monospace;font-size:.7rem;color:${isS?'#DC2626':'#4B5563'}">${escHtml(causeHint||String(rdRaw??''))}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-family:monospace;font-size:.65rem;color:#9CA3AF">${escHtml(r.sheetId||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;color:#6B7280">${escHtml(String(r.row?._rowIndex??r.rowIndex??''))}</td>`;
      tbody.appendChild(tr);
    });

    elResult.style.display = 'block';

  } catch(err) {
    elLoading.style.display = 'none';
    // searchAllDebug 미지원 시 일반 searchAll로 재시도
    if (err.message && (err.message.includes('알 수 없는') || err.message.includes('지원') || err.message.includes('action'))) {
      await _runSearchDebugFallback(q);
    } else {
      elError.style.display = 'block';
      elError.textContent   = '오류: ' + err.message;
    }
  }
}

/** searchAllDebug 미지원 시 일반 searchAll(isSubmitted 포함 전체)로 폴백 */
async function _runSearchDebugFallback(q) {
  const elLoading = document.getElementById('debugLoading');
  const elEmpty   = document.getElementById('debugEmpty');
  const elError   = document.getElementById('debugError');
  const elResult  = document.getElementById('debugResult');
  elLoading.style.display = 'block';

  try {
    // 일반 searchAll은 모든 결과를 반환하는지 확인
    const data = await gasGet({ action: 'searchAll', query: q });
    elLoading.style.display = 'none';

    const rawResults = data.results || [];
    if (!rawResults.length) {
      elEmpty.style.display = 'block';
      return;
    }

    const total     = rawResults.length;
    const submitted = rawResults.filter(r => r.isSubmitted).length;
    const pending   = total - submitted;
    document.getElementById('debugSummary').innerHTML =
      `<span style="color:#B45309">⚠ GAS가 searchAllDebug 미지원 → searchAll 응답 표시 (isSubmitted=true인 행이 반환 목록에 포함되지 않을 수 있음)</span><br>` +
      `반환된 전체 <b>${total}건</b> | ` +
      `<span style="color:#DC2626">isSubmitted=true: <b>${submitted}건</b></span> | ` +
      `<span style="color:#059669">isSubmitted=false(검색 노출): <b>${pending}건</b></span>`;

    const tbody = document.getElementById('debugTableBody');
    tbody.innerHTML = '';
    rawResults.forEach((r, i) => {
      const isS = r.isSubmitted;
      const rdRaw = r.reviewDoneRaw !== undefined ? r.reviewDoneRaw : '(GAS 미전달)';
      const tr = document.createElement('tr');
      tr.style.background = isS ? '#FEF2F2' : '#F0FDF4';
      tr.innerHTML = `
        <td style="padding:5px 8px;border:1px solid #E5E7EB;color:#6B7280">${i+1}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-weight:600">${escHtml(r.displayName||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-size:.7rem;color:#4B5563">${escHtml((r.campaignName||'')+(r.tabName?(' / '+r.tabName):''))}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-size:.7rem">${escHtml(r.productName||r.tcDisplayName||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;font-weight:700;color:${isS?'#DC2626':'#059669'}">${isS?'✅ true':'⬜ false'}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-family:monospace;font-size:.72rem;color:#92400E">${escHtml(String(rdRaw??''))}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-family:monospace;font-size:.65rem;color:#9CA3AF">${escHtml(r.sheetId||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;color:#6B7280">${escHtml(String(r.row?._rowIndex??r.rowIndex??''))}</td>`;
      tbody.appendChild(tr);
    });
    elResult.style.display = 'block';

  } catch(err2) {
    elLoading.style.display = 'none';
    elError.style.display = 'block';
    elError.innerHTML = `<b>GAS 오류:</b> ${escHtml(err2.message)}<br><br>` +
      `<b>확인 방법:</b><br>` +
      `1. GAS 스크립트 편집기에서 <code>doGet</code> 함수의 <code>searchAll</code> action을 찾으세요<br>` +
      `2. <code>isSubmitted</code> 판단 로직이 어떤 컬럼을 읽는지 확인하세요<br>` +
      `3. 스프레드시트에서 리뷰제출여부 컬럼의 실제 값을 확인하세요<br>` +
      `4. <code>SUBMITTED_VALUES</code> 배열에 해당 값이 포함되는지 확인하세요`;
  }
}

// 모달 외부 클릭 시 닫기
document.getElementById('searchDebugModal')?.addEventListener('click', function(e) {
  if (e.target === this) closeSearchDebugModal();
});
document.getElementById('dashRawModal')?.addEventListener('click', function(e) {
  if (e.target === this) closeDashRawModal();
});

/* ══════════════════════════════════════════════
   집계 진단 모달 (dashboard GAS 응답 원본 조회)
   ══════════════════════════════════════════════ */
let _dashRawData = null; // 마지막 조회 결과 캐시

function openDashRawModal() {
  document.getElementById('dashRawModal').style.display = 'flex';
  // 이미 캐시된 데이터가 있으면 바로 표시, 없으면 새로 조회
  if (_dashRawData) {
    _renderDashRawTable(_dashRawData);
  } else {
    reloadDashRaw();
  }
}
function closeDashRawModal() {
  document.getElementById('dashRawModal').style.display = 'none';
}

async function reloadDashRaw() {
  const elLoading = document.getElementById('dashRawLoading');
  const elContent = document.getElementById('dashRawContent');
  const elError   = document.getElementById('dashRawError');
  elLoading.style.display = 'block';
  elContent.style.display = 'none';
  elError.style.display   = 'none';
  document.getElementById('dashRawFilter').value = '';

  try {
    const data = await gasGet({ action: 'dashboard' });
    _dashRawData = data;
    elLoading.style.display = 'none';
    _renderDashRawTable(data);
  } catch(err) {
    elLoading.style.display = 'none';
    elError.style.display   = 'block';
    elError.textContent = 'GAS 오류: ' + err.message;
  }
}

function _renderDashRawTable(data) {
  const elContent = document.getElementById('dashRawContent');
  const elMeta    = document.getElementById('dashRawMeta');
  const tbody     = document.getElementById('dashRawBody');

  const stats = data.stats || [];
  const grand = data.grand || {};

  // 메타 요약
  elMeta.innerHTML =
    `조회 시각: <b>${new Date().toLocaleTimeString()}</b> &nbsp;|&nbsp; ` +
    `총 캠페인: <b>${stats.length}</b> &nbsp;|&nbsp; ` +
    `grand.total: <b>${grand.total ?? '—'}</b> &nbsp;|&nbsp; ` +
    `grand.submitted: <b>${grand.submitted ?? '—'}</b> &nbsp;|&nbsp; ` +
    `grand.pending: <b>${grand.pending ?? '—'}</b>` +
    (data.indexBuiltAt ? ` &nbsp;|&nbsp; 인덱스: <b>${escHtml(data.indexBuiltAt)}</b>` : '');

  tbody.innerHTML = '';
  stats.forEach(c => {
    (c.tabs || []).forEach(t => {
      const rate = t.total > 0 ? Math.round(t.submitted / t.total * 100) : 0;
      // 차수 요약
      let roundSummary = '—';
      if (t.roundList && t.roundList.length) {
        roundSummary = t.roundList.map(rd =>
          `<span style="white-space:nowrap">${escHtml(rd.round||'?')}: ${rd.submitted}/${rd.total}</span>`
        ).join(' &nbsp; ');
      }
      // 이상 여부 강조 (total>0인데 submitted=0 이면 주황)
      const isAnomal = t.total > 0 && t.submitted === 0;
      // total=0 이면 회색
      const isEmpty  = t.total === 0;

      const tr = document.createElement('tr');
      tr.dataset.campaign = (c.campaign || '').toLowerCase();
      tr.dataset.tab      = (t.tab || '').toLowerCase();
      tr.style.background = isAnomal ? '#FFFBEB' : isEmpty ? '#F9FAFB' : '';

      tr.innerHTML = `
        <td style="padding:5px 8px;border:1px solid #E5E7EB;color:#374151;white-space:nowrap">${escHtml(c.campaign||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-weight:600;white-space:nowrap">${escHtml(t.tab||'')}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;font-weight:700;color:${isEmpty?'#9CA3AF':'#1F2937'}">${t.total ?? '—'}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;font-weight:700;color:${t.submitted>0?'#059669':isAnomal?'#D97706':'#9CA3AF'}">${t.submitted ?? '—'}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;color:${t.pending>0?'#DC2626':'#6B7280'}">${t.pending ?? '—'}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center">
          ${isEmpty
            ? `<span style="color:#9CA3AF;font-size:.68rem">수취인없음</span>`
            : `<span style="color:${rate===100?'#059669':rate>=50?'#7C3AED':'#D97706'};font-weight:700">${rate}%</span>`
          }
        </td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;text-align:center;font-size:.7rem">
          ${isAnomal
            ? `<span style="color:#D97706;font-weight:700">⚠ 제출0</span>`
            : isEmpty
              ? `<span style="color:#9CA3AF">빈탭</span>`
              : `<span style="color:#059669">정상</span>`
          }
        </td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-size:.7rem;color:#4B5563">${roundSummary}</td>
        <td style="padding:5px 8px;border:1px solid #E5E7EB;font-family:monospace;font-size:.62rem;color:#9CA3AF;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.sheetId||'')}">${escHtml(t.sheetId||'—')}</td>`;
      tbody.appendChild(tr);
    });
  });

  elContent.style.display = 'block';
}

function filterDashRawTable() {
  const q = document.getElementById('dashRawFilter').value.toLowerCase().trim();
  document.querySelectorAll('#dashRawBody tr').forEach(tr => {
    const match = !q || tr.dataset.campaign.includes(q) || tr.dataset.tab.includes(q);
    tr.style.display = match ? '' : 'none';
  });
}
