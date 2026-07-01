/* ══════════════════════════════════════════
   app.js v4.1 [인라인] — default sort: progress desc
══════════════════════════════════════════ */

/** ★ 백분율 계산 헬퍼: 100%는 분자===분모일 때만 표시 (반올림으로 인한 거짓 100% 방지) */
function _pct(done, total) {
  if (total <= 0) return 0;
  if (done >= total) return 100;
  const raw = Math.round(done / total * 100);
  return raw >= 100 ? 99 : raw;
}

/* ══════════════════════════════════════════
   ★ 시스템 변경 공지사항 (배포 시 자동 표시)
   — 새로운 배포 시 이 배열 맨 위에 추가하세요
   — 최신 공지가 위에, 오래된 공지가 아래로 누적 관리됩니다
   — 오류 발생 시 어떤 버전으로 되돌릴 수 있을지 힌트 역할
══════════════════════════════════════════ */
const SYSTEM_NOTICES = [
  {
    version: "2026-07-01-dbfirst",
    date: "2026-07-01",
    title: "신기능 — 캠페인탭 참여자 명단을 시스템에서 직접 관리 (테스트 단계)",
    changes: [
      { type: "feat", text: "시트 참여자 명단을 시스템으로 가져와 화면에서 보기·추가/수정/삭제·리뷰제출/입금 체크 (최고관리자 전용)" },
      { type: "feat", text: "직원 안내서(유저플로우) 제공 — 공지 팝업의 '직원 안내서 보기' 또는 db-first-guide.html" },
      { type: "warn", text: "안전 테스트 단계: 모든 동작이 테스트 저장공간에만 반영 → 리뷰어·구글시트·주문에 영향 없음" },
    ]
  },
  {
    version: "2026-05-06-4",
    date: "2026-05-06",
    title: "모바일 리뷰 제출 시간초과 오류 해결",
    changes: [
      { type: "fix", text: "모바일에서 리뷰 이미지 제출 시 무한로딩 → 시간초과 오류 해결" },
      { type: "perf", text: "이미지 자동 압축 적용 (1MB 초과 시 최대 1920px, JPEG 75% 압축 → 용량 80%↓)" },
      { type: "perf", text: "업로드 타임아웃 60초 → 180초로 확대 (모바일 네트워크 대응)" },
      { type: "fix", text: "서버측 요청 처리 시간 제한 180초로 설정 (대용량 이미지 대응)" },
    ]
  },
  {
    version: "2026-05-06-3",
    date: "2026-05-06",
    title: "완료감지 마감 재표시 방지 + 숨김탭 토글",
    changes: [
      { type: "fix", text: "마감 후에도 완료감지에 계속 표시되던 문제 해결 (트리아이나 등)" },
      { type: "feat", text: "완료감지 목록에서 각 탭마다 숨김/숨김해제 버튼 제공" },
      { type: "fix", text: "스마트빌드가 마감된 차수의 행을 재삽입하지 않도록 개선" },
      { type: "feat", text: "공지사항을 누적 관리 방식으로 변경 (전체 이력 확인 가능)" },
    ]
  },
  {
    version: "2026-05-06-2",
    date: "2026-05-06",
    title: "GID 기반 탭 조회 적용",
    changes: [
      { type: "feat", text: "탭 이름이 변경되어도 구매양식/리뷰 제출 시 에러 없이 정상 동작 (GID 기반 조회)" },
      { type: "feat", text: "탭을 찾지 못할 때 사용 가능한 탭 목록을 에러 메시지에 포함" },
      { type: "fix", text: "구매양식 재제출 시 '그래도 제출' 클릭으로 서버 중복 검사 우회 가능" },
    ]
  },
  {
    version: "2026-05-06-1",
    date: "2026-05-06",
    title: "성능 개선 + 재제출 기능",
    changes: [
      { type: "perf", text: "GET /dirty 응답시간 125초 → ~25초 (병렬 처리)" },
      { type: "perf", text: "POST /order 응답시간 9초 → ~1.5초 (batchUpdate 일괄 쓰기)" },
      { type: "feat", text: "구매양식 제출 실패 시 재제출 버튼 + 이전 화면 복귀 버튼 추가" },
      { type: "feat", text: "1시간 내 중복 제출 시에도 '재제출' 가능하도록 개선" },
    ]
  }
];

function _renderNoticeHtml(notice, isNew) {
  const typeIcons = { feat: "🆕", fix: "🔧", perf: "⚡", warn: "⚠️" };
  const typeLabels = { feat: "추가", fix: "수정", perf: "성능", warn: "주의" };
  const typeColors = { feat: "#0ca678", fix: "#DC2626", perf: "#D97706", warn: "#3182f6" };

  const newBadge = isNew ? '<span style="background:#EF4444;color:#fff;font-size:.6rem;padding:1px 5px;border-radius:3px;margin-left:6px;font-weight:600">NEW</span>' : '';
  let html = `<div style="font-size:.82rem;font-weight:600;color:#1E40AF;margin-bottom:6px">
    📋 ${notice.title}${newBadge}
    <span style="font-size:.65rem;color:#9CA3AF;font-weight:400;margin-left:8px">${notice.date} (v${notice.version})</span>
  </div>`;
  html += `<ul style="margin:0;padding-left:18px;list-style:none">`;
  for (const c of notice.changes) {
    const icon = typeIcons[c.type] || "•";
    const label = typeLabels[c.type] || "";
    const color = typeColors[c.type] || "#374151";
    html += `<li style="margin-bottom:4px">${icon} <span style="font-size:.7rem;font-weight:600;color:${color};background:${color}15;padding:1px 6px;border-radius:4px;margin-right:4px">${label}</span>${c.text}</li>`;
  }
  html += `</ul>`;
  return html;
}

function checkAndShowNotice() {
  if (!SYSTEM_NOTICES || SYSTEM_NOTICES.length === 0) return;
  const latest = SYSTEM_NOTICES[0];
  const dismissedVersion = localStorage.getItem("notice_dismissed_version");
  const hasNew = dismissedVersion !== latest.version;

  const section = document.getElementById("noticeSection");
  const content = document.getElementById("noticeContent");
  if (!section || !content) return;

  // 항상 섹션을 표시 (접힌 형태 또는 펼친 형태)
  section.style.display = "block";

  if (hasNew) {
    // 새 공지가 있으면 → 자동으로 펼쳐서 표시
    _renderNoticeList(content, dismissedVersion, false);
    section.dataset.collapsed = "false";
    content.style.display = "block";
    // 버튼 영역 업데이트
    _updateNoticeButtons(hasNew, false);
  } else {
    // 이미 확인완료 → 접힌 상태로 표시 (토글 가능)
    section.dataset.collapsed = "true";
    content.style.display = "none";
    _updateNoticeButtons(false, true);
  }
}

// ★ 신기능 안내 강제 팝업 (캠페인탭 참여자 명단 / DB-first) — 확인 전까지 로그인 시마다 표시.
const DBFIRST_GUIDE_VERSION = "v1";
function _showDbFirstGuidePopup() {
  try {
    if (localStorage.getItem("dbfirst_guide_seen") === DBFIRST_GUIDE_VERSION) return; // 다시 안 보기 처리됨
    if (typeof show === "function") show("dbFirstGuideModal", "flex");
    else { const m = document.getElementById("dbFirstGuideModal"); if (m) { m.classList.remove("hidden"); m.style.display = "flex"; } }
  } catch (_) {}
}
function closeDbFirstGuide(markSeen) {
  try { if (markSeen) localStorage.setItem("dbfirst_guide_seen", DBFIRST_GUIDE_VERSION); } catch (_) {}
  if (typeof hide === "function") hide("dbFirstGuideModal");
  else { const m = document.getElementById("dbFirstGuideModal"); if (m) { m.classList.add("hidden"); m.style.display = "none"; } }
}
function openDbFirstGuide() {
  window.open("db-first-guide.html", "_blank");
}

function _renderNoticeList(content, dismissedVersion, collapsed) {
  // 모든 공지를 누적 표시 (최신이 위)
  let html = '';
  const dismissedIdx = SYSTEM_NOTICES.findIndex(n => n.version === dismissedVersion);
  
  SYSTEM_NOTICES.forEach((notice, idx) => {
    const isNew = dismissedIdx === -1 ? true : idx < dismissedIdx;
    if (idx > 0) {
      html += `<div style="border-top:1px solid #BFDBFE;margin:10px 0 8px;padding-top:8px"></div>`;
    }
    html += _renderNoticeHtml(notice, isNew);
  });

  content.innerHTML = html;
}

function _updateNoticeButtons(hasNew, collapsed) {
  const btnArea = document.getElementById("noticeBtnArea");
  if (!btnArea) return;

  if (hasNew) {
    btnArea.innerHTML = `
      <button onclick="dismissNotice(false)" style="font-size:.7rem;color:#6B7280;background:none;border:1px solid #D1D5DB;border-radius:6px;padding:3px 10px;cursor:pointer" title="접기">
        <i class="fas fa-chevron-up"></i> 접기
      </button>
      <button onclick="dismissNotice(true)" style="font-size:.7rem;color:#fff;background:#3B82F6;border:none;border-radius:6px;padding:3px 10px;cursor:pointer" title="이 버전까지 확인 완료 처리">
        <i class="fas fa-check"></i> 확인완료
      </button>
    `;
  } else if (collapsed) {
    btnArea.innerHTML = `
      <button onclick="_toggleNoticeList()" style="font-size:.7rem;color:#3B82F6;background:none;border:1px solid #BFDBFE;border-radius:6px;padding:3px 10px;cursor:pointer" title="변경 이력 펼치기">
        <i class="fas fa-chevron-down"></i> 이력 보기
      </button>
    `;
  } else {
    btnArea.innerHTML = `
      <button onclick="_toggleNoticeList()" style="font-size:.7rem;color:#6B7280;background:none;border:1px solid #D1D5DB;border-radius:6px;padding:3px 10px;cursor:pointer" title="접기">
        <i class="fas fa-chevron-up"></i> 접기
      </button>
    `;
  }
}

function _toggleNoticeList() {
  const section = document.getElementById("noticeSection");
  const content = document.getElementById("noticeContent");
  if (!section || !content) return;

  const isCollapsed = section.dataset.collapsed === "true";
  if (isCollapsed) {
    // 펼치기
    const dismissedVersion = localStorage.getItem("notice_dismissed_version");
    _renderNoticeList(content, dismissedVersion, false);
    content.style.display = "block";
    content.style.maxHeight = "400px";
    content.style.overflowY = "auto";
    section.dataset.collapsed = "false";
    _updateNoticeButtons(false, false);
  } else {
    // 접기
    content.style.display = "none";
    section.dataset.collapsed = "true";
    _updateNoticeButtons(false, true);
  }
}

function dismissNotice(permanent) {
  const section = document.getElementById("noticeSection");
  const content = document.getElementById("noticeContent");
  if (!section || !content) return;

  if (permanent && SYSTEM_NOTICES.length > 0) {
    localStorage.setItem("notice_dismissed_version", SYSTEM_NOTICES[0].version);
  }
  // 접힌 상태로 전환
  content.style.display = "none";
  section.dataset.collapsed = "true";
  _updateNoticeButtons(false, true);
}

/* ── 에러 메시지 한글 번역 (프론트엔드 fallback) ── */
function _translateErrorClient(msg) {
  if (!msg) return '알 수 없는 오류';
  if (/file not found/i.test(msg))                      return '파일을 찾을 수 없습니다 (삭제되었거나 ID가 잘못됨)';
  if (/does not have permission/i.test(msg))             return '접근 권한이 없습니다 (서비스 계정에 공유 필요)';
  if (/quota exceeded/i.test(msg))                       return 'API 할당량 초과 (잠시 후 자동 재시도)';
  if (/rate limit/i.test(msg))                           return 'API 요청 속도 제한 초과';
  if (/unable to parse range/i.test(msg))                return '시트 범위를 파싱할 수 없습니다 (탭 이름 오류)';
  if (/requested entity was not found/i.test(msg))       return '요청한 항목을 찾을 수 없습니다';
  if (/spreadsheet.*not found/i.test(msg))               return '스프레드시트를 찾을 수 없습니다';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg))      return '네트워크 연결 오류 (일시적 장애)';
  if (/socket hang up/i.test(msg))                       return '네트워크 연결이 끊어졌습니다';
  if (/503|service unavailable/i.test(msg))              return 'Google API 서비스 일시 중단';
  if (/500|internal server error/i.test(msg))            return 'Google API 내부 서버 오류';
  if (/메타데이터 조회 실패/i.test(msg))                   return msg;
  return msg;
}

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
const S = { selectedRow: null, files: [], step: 1 };
const ADMIN_SESSION_KEY = "rapp_admin_exp";
const ADMIN_SESSION_MS  = 8 * 60 * 60 * 1000;

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
  hideLoading();
  // ★ GAS URL 자동 부트스트랩
  bootstrapGasUrl();

  // ── 창 크기 변경 시 sticky 위치 재보정 ──
  window.addEventListener("resize", () => _fixStickyPositions());

  // ★ 관리자 페이지 직접 접속: 세션 있으면 바로 대시보드, 없으면 진입 선택 화면
  if (isAdminLoggedIn()) {
    enterAdminScreen();
  } else {
    // screenGate 표시 (이미 active 상태, 추가 작업 불필요)
    // openAdminLogin()은 관리자 카드 클릭 시에만 호출
  }
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
  screenGate:      "리뷰웹시스템",
  screenAdmin:     "관리자"
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
  const title = SCREEN_TITLES[id];
  if (title) {
    document.title = title;
  }
}

function backToSearch() {
  location.href = 'search.html';
}

/* ── 검색 ── */
async function doSearch() {
  const q = document.getElementById("nameInput").value.trim();
  if (!q || q.length < 2) { showToast("이름을 2글자 이상 입력하세요.", "warning"); return; }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("GAS URL을 먼저 설정해주세요.", "error"); return;
  }
  hide("resultsSection");
  hide("noResultView");
  hide("gasNotSet");
  startProgress();
  try {
    const data    = await gasGet({ action: "searchAll", query: q });
    stopProgress();
    const results = data.results || [];
    if (results.length === 0) {
      show("noResultView");
    } else {
      renderResults(results);
    }
  } catch (err) {
    stopProgress();
    const emsg = err.message || "";
    if (emsg === "요청 시간 초과") {
      showToast("⏱ 검색 시간 초과 — 잠시 후 다시 시도해주세요.", "warning");
    } else if (emsg.includes("fetch") || emsg.includes("Failed to fetch") || emsg.includes("NetworkError")) {
      showToast("❌ 네트워크 오류 — GAS URL을 확인하거나 잠시 후 재시도하세요.", "error");
    } else {
      showToast("❌ 검색 오류: " + emsg.substring(0, 100), "error");
    }
    if (!APP_CONFIG.GAS_WEB_APP_URL) show("gasNotSet");
  }
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
    show("noResultView");
    hide(section);
    return;
  }

  pending.forEach(item => {
    const name = item.displayName || "이름 없음";
    // 상품명: 세부목록 displayName 우선, 없으면 안내문구
    const productLabel = item.tcDisplayName || "";
    // ★ v8.2: 차수 배지
    const roundBadge = item.round
      ? `<span style="display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:10px;background:#e8f1fe;color:#1b64da;border:1px solid #cce0fb;margin-left:4px;vertical-align:middle">${escHtml(item.round)}</span>`
      : "";

    // ★ 상품/옵션 추출 (시트 row 기반)
    const { product, options } = extractProductOption(item.row || {});

    // 옵션 배지 HTML 생성
    let optionHtml = "";
    if (options.length > 0) {
      const badges = options.map(o =>
        `<span class="result-option-badge">${escHtml(o.value)}</span>`
      ).join("");
      optionHtml = `<div class="result-option-row">${badges}</div>`;
    }

    // 상품 라인: tcDisplayName 우선, 없으면 시트 상품 컬럼값, 없으면 안내문구
    const displayProduct = productLabel || product;
    const productHtml = displayProduct
      ? `<div class="result-name result-product-name">${escHtml(name)}${roundBadge}</div>
         <div class="result-product-label">${escHtml(displayProduct)}</div>
         ${optionHtml}`
      : `<div class="result-name result-product-name">${escHtml(name)}${roundBadge}</div>
         <div class="result-product-label result-product-empty">상품명이 입력되지 않았습니다.</div>
         ${optionHtml}`;

    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <div class="result-avatar"></div>
      <div class="result-body">${productHtml}</div>
      <div class="result-right">
        <span class="status-badge status-pending">미제출</span>
        <i class="fas fa-chevron-right result-chevron"></i>
      </div>`;
    card.addEventListener("click", () => openSubmit(item));
    list.appendChild(card);
  });

  show(section);
}

/* ── 리뷰 제출 화면 ── */
function openSubmit(item) {
  S.selectedRow = item;
  S.files = [];
  S.step  = 1;

  // 제출 화면 타이틀: 상품명(세부목록) > productName(시트) > "구매양식 제출" 순 fallback
  const workLabel = item.tcDisplayName || item.productName || "";
  document.getElementById("submitTitle").textContent    = workLabel || "리뷰제출";
  document.getElementById("submitSubtitle").textContent = workLabel ? "" : (item.campaignName || "");
  // ★ 보안: 헤더 타이틀에 캠페인명/탭명/상품명 노출 차단
  // submitTitle → 항상 "구매양식 제출" 고정
  // submitSubtitle → 항상 빈칸
  document.getElementById("submitTitle").textContent    = "구매양식 제출";
  document.getElementById("submitSubtitle").textContent = "";

  const link = document.getElementById("productLink");
  if (item.productUrl) {
    link.href = item.productUrl;
    show(link, "inline-flex");
    // 상품 URL 있을 때만 스트립 노출 (링크만, 이름은 숨김)
    const strip = document.getElementById("productStrip");
    if (strip) {
      // 썸네일·이름 숨기고 링크만 표시
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
    // 상품 URL 없으면 스트립 전체 숨김
    const strip = document.getElementById("productStrip");
    if (strip) strip.style.display = "none";
  }

  renderInfoGrid(item.row, item.tcDisplayName || "");

  const doneBox  = document.getElementById("alreadyDoneBox");
  const btnStep2 = document.getElementById("btnToStep2");
  doneBox.classList.toggle("hidden", !item.isSubmitted);
  doneBox.style.display = item.isSubmitted ? "" : "none";
  btnStep2.disabled = item.isSubmitted;

  goStep(1);
  showScreen("screenSubmit");
}

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
function addFiles(files) {
  const valid = files.filter(f => {
    if (!APP_CONFIG.ALLOWED_MIME.includes(f.type)) { showToast(`${f.name}: 지원하지 않는 형식`, "error"); return false; }
    if (f.size > APP_CONFIG.MAX_FILE_SIZE)          { showToast(`${f.name}: 10MB 초과`, "error");        return false; }
    return true;
  });
  S.files.push(...valid);
  renderPreviews();
}
function removeFile(i) { S.files.splice(i, 1); renderPreviews(); }
function renderPreviews() {
  const ph   = document.getElementById("dzPlaceholder");
  const prev = document.getElementById("dzPreview");
  if (!ph || !prev) return;
  if (S.files.length === 0) { ph.style.display = ""; hide(prev); prev.innerHTML = ""; return; }
  ph.style.display = "none"; show(prev); prev.innerHTML = "";
  S.files.forEach((f, i) => {
    const item = document.createElement("div"); item.className = "prev-item";
    const img  = document.createElement("img");
    img.src = URL.createObjectURL(f); img.onload = () => URL.revokeObjectURL(img.src);
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
  if (S.files.length === 0)  { showToast("이미지를 1장 이상 첨부해주세요.", "warning"); return; }
  if (!S.selectedRow)        { showToast("주문 정보를 다시 확인해주세요.", "error");    return; }
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 설정해주세요.", "error");    return; }

  const btn = document.getElementById("btnSubmit");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 제출 중...';

  try {
    showLoading("이미지 변환 중...");
    const fileData = await Promise.all(S.files.map(f => fileToBase64(f)));

    showLoading("업로드 중...");
    const item         = S.selectedRow;
    const reviewerName = item.displayName || "이름없음";
    const memo         = document.getElementById("memoTxt").value.trim();

    const result = await gasPost({
      action:       "submitReview",
      sheetId:      item.sheetId,
      gid:          item.gid,
      rowIndex:     item.row._rowIndex,
      reviewerName,
      submitCol:    item.submitCol,
      campaignName: item.campaignName,
      memo,
      files: fileData.map((b64, i) => ({
        name:     reviewerName + "_" + (i + 1),
        mimeType: S.files[i].type,
        data:     b64,
      }))
    });

    hideLoading();
    if (result.success) {
      document.getElementById("successMessage").innerHTML =
        `<strong>${escHtml(reviewerName)}</strong>님의 리뷰가 제출되었습니다 😊`;
      show("successModal", "flex");
    } else {
      throw new Error(result.error || "알 수 없는 오류");
    }
  } catch (err) {
    hideLoading();
    showToast("제출 실패: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> 제출하기';
  }
}

function resetApp() {
  hide("successModal");
  S.files = []; S.selectedRow = null;
  location.href = 'search.html';
}

/* ── 관리자 로그인 / 세션 ── */
const ADMIN_SESSION_NAME_KEY = "rapp_admin_name";
const ADMIN_SESSION_ROLE_KEY = "rapp_admin_role";

function isAdminLoggedIn() {
  const exp = Number(sessionStorage.getItem(ADMIN_SESSION_KEY) || 0);
  return exp > Date.now();
}
function setAdminSession(name, role) {
  sessionStorage.setItem(ADMIN_SESSION_KEY,      String(Date.now() + ADMIN_SESSION_MS));
  sessionStorage.setItem(ADMIN_SESSION_NAME_KEY, name || "관리자");
  sessionStorage.setItem(ADMIN_SESSION_ROLE_KEY, role || "admin");
}
function clearAdminSession() {
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  sessionStorage.removeItem(ADMIN_SESSION_NAME_KEY);
  sessionStorage.removeItem(ADMIN_SESSION_ROLE_KEY);
  sessionStorage.removeItem("rapp_master_pw_cache");
}
function getAdminName() {
  return sessionStorage.getItem(ADMIN_SESSION_NAME_KEY) || "관리자";
}
function getAdminRole() {
  return sessionStorage.getItem(ADMIN_SESSION_ROLE_KEY) || "admin";
}
function isMaster() {
  return getAdminRole() === "master";
}
function getAdminSessionRemaining() {
  const exp  = Number(sessionStorage.getItem(ADMIN_SESSION_KEY) || 0);
  const diff = exp - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
}

/* ── 업무포털 새창 열기 (로그인 세션 이어주기) ──
   portal.html은 새 탭이라 sessionStorage(admin_token)를 공유하지 않으므로,
   동일 출처 localStorage로 토큰/이름/역할을 잠시 넘겨준다(포털이 읽는 즉시 삭제).
   admin·portal 모두 /api/admin/login 토큰을 쓰므로 같은 JWT로 자동 로그인된다. */
function openWorkPortal() {
  const token = sessionStorage.getItem("admin_token") || "";
  if (!token || !isAdminLoggedIn()) {
    showToast("관리자 로그인이 필요합니다.", "warning");
    return;
  }
  try {
    localStorage.setItem("portal_sso", JSON.stringify({
      token,
      name: getAdminName(),
      role: getAdminRole(),
      ts: Date.now()
    }));
  } catch (e) { /* localStorage 불가 시에도 포털 자체 로그인으로 폴백 */ }
  window.open("portal.html", "_blank");
}

/* ── 구글시트 RAW 미러 페이지 열기 (자동 로그인 핸드오프) ── */
function openRawMirror() {
  const token = sessionStorage.getItem("admin_token") || "";
  if (!token || !isAdminLoggedIn()) {
    showToast("관리자 로그인이 필요합니다.", "warning");
    return;
  }
  try {
    localStorage.setItem("raw_sso", JSON.stringify({
      token,
      name: getAdminName(),
      role: getAdminRole(),
      ts: Date.now()
    }));
  } catch (e) { /* localStorage 불가 시에도 페이지 자체 처리로 폴백 */ }
  window.open("raw-mirror.html", "_blank");
}

/* ── 시트 API 쿼터 모니터(45/분 실시간 사용량·출처·잔량) — 자동 로그인 핸드오프 ── */
function openThrottleMonitor() {
  const token = sessionStorage.getItem("admin_token") || "";
  if (!token || !isAdminLoggedIn()) { showToast("관리자 로그인이 필요합니다.", "warning"); return; }
  try {
    localStorage.setItem("raw_sso", JSON.stringify({ token, name: getAdminName(), role: getAdminRole(), ts: Date.now() }));
  } catch (e) { /* 폴백: 페이지에서 로그인 */ }
  window.open("throttle-monitor.html", "_blank");
}

/* ── 관리자 로그인 모달 열기 ── */
function openAdminLogin() {
  if (isAdminLoggedIn()) { enterAdminScreen(); return; }
  document.getElementById("adminNameInput").value = "";
  document.getElementById("adminPwInput").value = "";
  hide("adminLoginError");
  show("adminLoginModal", "flex");
  setTimeout(() => document.getElementById("adminNameInput").focus(), 100);
}
function closeAdminLogin() { hide("adminLoginModal"); }

async function submitAdminLogin() {
  const name = document.getElementById("adminNameInput").value.trim();
  const pw   = document.getElementById("adminPwInput").value;
  if (!name) { showToast("이름을 입력하세요.", "warning"); return; }
  if (!pw)   { showToast("비밀번호를 입력하세요.", "warning"); return; }
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 설정해주세요.", "error"); return; }

  const errEl = document.getElementById("adminLoginError");
  hide(errEl);
  showLoading("확인 중...");
  try {
    let data;
    try {
      // ★ 신버전 GAS: adminLoginV2 (이름+비번, 다중 관리자)
      data = await gasPost({ action: "adminLoginV2", name, pw });
      // 구버전 GAS는 "알 수 없는 action" 오류를 반환 → 폴백
      if (data && data.error && data.error.includes("알 수 없는")) throw new Error("FALLBACK");
    } catch (innerErr) {
      if (innerErr.message !== "FALLBACK" && !innerErr.message.includes("알 수 없는")) throw innerErr;
      // ★ 구버전 GAS 폴백: 단일 비밀번호 방식 (adminLogin GET)
      const fallback = await gasGet({ action: "adminLogin", pw });
      if (!fallback.success) {
        data = { success: false, error: "비밀번호가 올바르지 않습니다." };
      } else {
        // 구버전에서는 이름 검증 없이 비번만 확인 → 마스터 이름("김수만")이면 마스터, 아니면 admin
        data = { success: true, name, role: name === "김수만" ? "master" : "admin" };
      }
    }
    hideLoading();
    if (data.success) {
      setAdminSession(data.name || name, data.role || "admin"); // 이름·역할 저장
      // 마스터인 경우 비밀번호 캐시 저장 (계정 관리 모달에서 사용)
      if ((data.role || "admin") === "master") sessionStorage.setItem("rapp_master_pw_cache", pw);
      closeAdminLogin();
      enterAdminScreen();
    } else {
      errEl.textContent = data.error || "이름 또는 비밀번호가 올바르지 않습니다.";
      show(errEl);
      document.getElementById("adminPwInput").value = "";
      document.getElementById("adminPwInput").focus();
    }
  } catch (err) {
    hideLoading();
    showToast("오류: " + err.message, "error");
  }
}

function enterAdminScreen() {
  const rem  = getAdminSessionRemaining();
  const name = getAdminName();
  const role = getAdminRole();
  // 헤더 이름 표시 (마스터는 👑 배지)
  const headerNameEl = document.getElementById("adminHeaderName");
  if (headerNameEl) {
    headerNameEl.innerHTML = role === "master"
      ? `<span style="color:#F59E0B">&#9813;</span> ${name} <span style="font-size:.65rem;background:#FEF3C7;color:#92400E;border-radius:6px;padding:1px 5px;font-weight:700;vertical-align:middle">마스터</span>`
      : `${name}`;
  }
  document.getElementById("adminSessionInfo").textContent = rem || "세션 유지 중";
  // 마스터 전용 계정 관리 버튼 표시 제어
  const keyMenuAccounts = document.getElementById("keyMenuAccounts");
  if (keyMenuAccounts) keyMenuAccounts.style.display = role === "master" ? "" : "none";
  const keyMenuNotices = document.getElementById("keyMenuNotices");
  if (keyMenuNotices) keyMenuNotices.style.display = role === "master" ? "" : "none";

  showScreen("screenAdmin");

  // ★ 컨텍스트 툴바 초기화
  _updateContextToolbar('dashboard');

  loadAdminDashboard();

  // ★ 공지사항 자동 표시 (배포 변경 이력)
  checkAndShowNotice();

  // ★ 관리자 공지 팝업 (DB 기반, 마스터가 작성한 공지)
  setTimeout(_checkAdminNoticePopup, 400);

  // ★ 신기능 안내 강제 팝업 (캠페인탭 참여자 명단) — 확인 전까지 표시
  setTimeout(_showDbFirstGuidePopup, 700);

  // ── Phase 5/6: 시스템 모니터링 + API 메트릭 자동 로드 ──
  if (typeof loadSystemMonitor === 'function') {
    setTimeout(loadSystemMonitor, 600);
  }

  // ── Phase 9: 통계 대시보드 자동 로드 ──
  if (typeof loadStatsOverview === 'function') {
    setTimeout(loadStatsOverview, 800);
  }

  // ── Phase 8: SSE 실시간 알림 자동 연결 ──
  if (typeof connectSSE === 'function') {
    setTimeout(connectSSE, 500);
  }

  // ── 신규 작업 오더 배지/알림 폴링 시작 ──
  if (typeof startWorkOrderBadgePoll === 'function') startWorkOrderBadgePoll();
}
function exitAdmin() {
  clearAdminSession();
  if (typeof disconnectSSE === 'function') disconnectSSE();
  if (typeof stopWorkOrderBadgePoll === 'function') stopWorkOrderBadgePoll();
  showScreen("screenGate");
}

/* ════════════════════════════════════════════════════
   관리자 계정 관리 (마스터 전용)
════════════════════════════════════════════════════ */
function openAccountMgmt() {
  if (!isMaster()) { showToast("마스터 권한이 필요합니다.", "error"); return; }
  show("accountMgmtModal", "flex");
  switchAcctTab("admin");  // 항상 관리자 탭으로 초기화
  loadAdminList();
}
function closeAccountMgmt() { hide("accountMgmtModal"); }

async function loadAdminList() {
  const wrap = document.getElementById("adminListWrap");
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:12px;text-align:center;color:var(--t3);font-size:.8rem"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';
  try {
    const masterPw = _getMasterPwFromSession();
    const data = await gasPost({ action: "listAdminUsers", masterPw });
    if (!data.success) { wrap.innerHTML = `<div style="padding:12px;color:#EF4444;font-size:.8rem">${data.error || "오류"}</div>`; return; }
    const users = data.users || [];
    if (!users.length) { wrap.innerHTML = '<div style="padding:12px;text-align:center;color:var(--t3);font-size:.8rem">등록된 관리자가 없습니다.</div>'; return; }
    wrap.innerHTML = users.map((u, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #F3F4F6;background:${u.active ? '#fff' : '#F9FAFB'}">
        <span style="flex:1;font-size:.83rem;font-weight:600;color:${u.active ? 'var(--t1)' : 'var(--t3)'}">
          ${escHtml(u.name)}
          ${u.active ? '' : '<span style="font-size:.68rem;background:#F3F4F6;color:var(--t3);padding:1px 5px;border-radius:5px;margin-left:4px">비활성</span>'}
        </span>
        <button onclick="toggleAdminActive('${escHtml(u.name)}', ${!u.active})"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;
                 background:${u.active ? '#FEE2E2' : '#D1FAE5'};color:${u.active ? '#DC2626' : '#065F46'}">
          ${u.active ? '<i class="fas fa-ban"></i> 비활성화' : '<i class="fas fa-check"></i> 활성화'}
        </button>
        <button onclick="openEditAdminPw('${escHtml(u.name)}')"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:#e8f1fe;color:var(--p)">
          <i class="fas fa-key"></i> 비번변경
        </button>
        <button onclick="deleteAdminUser('${escHtml(u.name)}')"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:#FEE2E2;color:#DC2626">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `).join("");
  } catch (e) {
    wrap.innerHTML = `<div style="padding:12px;color:#EF4444;font-size:.8rem">오류: ${e.message}</div>`;
  }
}

async function addAdminUser() {
  const name   = (document.getElementById("newAdminName").value || "").trim();
  const pw     = (document.getElementById("newAdminPw").value  || "").trim();
  const errEl  = document.getElementById("addAdminError");
  hide(errEl);
  if (!name) { errEl.textContent = "이름을 입력하세요."; show(errEl); return; }
  if (!pw || pw.length < 4) { errEl.textContent = "비밀번호는 4자 이상이어야 합니다."; show(errEl); return; }
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "addAdminUser", masterPw, name, pw });
    if (!data.success) { errEl.textContent = data.error || "추가 실패"; show(errEl); return; }
    document.getElementById("newAdminName").value = "";
    document.getElementById("newAdminPw").value   = "";
    showToast(`${name} 관리자가 추가되었습니다.`, "success");
    loadAdminList();
  } catch (e) { errEl.textContent = e.message; show(errEl); }
}

async function deleteAdminUser(name) {
  if (!confirm(`'${name}' 계정을 삭제하시겠습니까?`)) return;
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "deleteAdminUser", masterPw, name });
    if (!data.success) { showToast(data.error || "삭제 실패", "error"); return; }
    showToast(`${name} 계정이 삭제되었습니다.`, "success");
    loadAdminList();
  } catch (e) { showToast(e.message, "error"); }
}

async function toggleAdminActive(name, active) {
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "editAdminUser", masterPw, name, active });
    if (!data.success) { showToast(data.error || "변경 실패", "error"); return; }
    showToast(`${name} 계정이 ${active ? "활성화" : "비활성화"}되었습니다.`, "success");
    loadAdminList();
  } catch (e) { showToast(e.message, "error"); }
}

function openEditAdminPw(name) {
  const newPw = prompt(`'${name}' 계정의 새 비밀번호를 입력하세요 (4자 이상):`);
  if (newPw === null) return;
  if (!newPw || newPw.length < 4) { showToast("비밀번호는 4자 이상이어야 합니다.", "warning"); return; }
  _doEditAdminPw(name, newPw);
}

async function _doEditAdminPw(name, newPw) {
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "editAdminUser", masterPw, name, newPw });
    if (!data.success) { showToast(data.error || "변경 실패", "error"); return; }
    showToast(`${name} 비밀번호가 변경되었습니다.`, "success");
  } catch (e) { showToast(e.message, "error"); }
}

async function changeMasterPw() {
  const currentPw = (document.getElementById("masterCurrentPw").value || "").trim();
  const newPw     = (document.getElementById("masterNewPw").value     || "").trim();
  const errEl     = document.getElementById("masterPwError");
  hide(errEl);
  if (!currentPw) { errEl.textContent = "현재 비밀번호를 입력하세요."; show(errEl); return; }
  if (!newPw || newPw.length < 4) { errEl.textContent = "새 비밀번호는 4자 이상이어야 합니다."; show(errEl); return; }
  try {
    const data = await gasPost({ action: "changeMasterPw", masterPw: currentPw, newPw });
    if (!data.success) { errEl.textContent = data.error || "변경 실패"; show(errEl); return; }
    // 세션의 마스터 비번 캐시 업데이트
    sessionStorage.setItem("rapp_master_pw_cache", newPw);
    document.getElementById("masterCurrentPw").value = "";
    document.getElementById("masterNewPw").value     = "";
    showToast("마스터 비밀번호가 변경되었습니다.", "success");
  } catch (e) { errEl.textContent = e.message; show(errEl); }
}

/** 세션에서 마스터 비밀번호 캐시를 가져오는 헬퍼 (모달 인증용) */
function _getMasterPwFromSession() {
  // 마스터 비밀번호를 세션에 캐싱 (처음 한 번만 입력)
  let cached = sessionStorage.getItem("rapp_master_pw_cache");
  if (!cached) {
    cached = prompt("마스터 비밀번호를 입력하세요:");
    if (!cached) throw new Error("비밀번호 입력이 취소되었습니다.");
    sessionStorage.setItem("rapp_master_pw_cache", cached);
  }
  return cached;
}


/* ── 계정 관리 모달 탭 전환 (관리자 / 영업담당자) ── */
function switchAcctTab(tab) {
  const isAdmin = tab === 'admin';
  // 탭 버튼 스타일
  const btnAdmin = document.getElementById('acctTabAdmin');
  const btnStaff = document.getElementById('acctTabStaff');
  if (btnAdmin) {
    btnAdmin.style.color        = isAdmin ? 'var(--p)' : 'var(--t3)';
    btnAdmin.style.borderBottom = isAdmin ? '2px solid var(--p)' : '2px solid transparent';
  }
  if (btnStaff) {
    btnStaff.style.color        = !isAdmin ? '#0ca678' : 'var(--t3)';
    btnStaff.style.borderBottom = !isAdmin ? '2px solid #0ca678' : '2px solid transparent';
  }
  // 패널 표시/숨김
  const panelAdmin = document.getElementById('acctPanelAdmin');
  const panelStaff = document.getElementById('acctPanelStaff');
  if (panelAdmin) panelAdmin.style.display = isAdmin  ? '' : 'none';
  if (panelStaff) panelStaff.style.display = !isAdmin ? '' : 'none';
  // 탭 전환 시 목록 자동 로드
  if (!isAdmin) loadStaffList();
}

/* ════════════════════════════════════════════════════
   영업담당자 계정 관리 (마스터 전용)
════════════════════════════════════════════════════ */
async function loadStaffList() {
  const wrap = document.getElementById("staffListWrap");
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:12px;text-align:center;color:var(--t3);font-size:.8rem"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';
  try {
    const masterPw = _getMasterPwFromSession();
    const data = await gasPost({ action: "listStaffUsers", masterPw });
    if (!data.success) {
      wrap.innerHTML = `<div style="padding:12px;color:#EF4444;font-size:.8rem">${data.error || "오류"}</div>`;
      return;
    }
    const users = data.users || [];
    if (!users.length) {
      wrap.innerHTML = '<div style="padding:12px;text-align:center;color:var(--t3);font-size:.8rem">등록된 영업담당자가 없습니다.</div>';
      return;
    }
    wrap.innerHTML = users.map(u => `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #F3F4F6;background:${u.active !== false ? '#fff' : '#F9FAFB'}">
        <span style="flex:1;font-size:.83rem;font-weight:600;color:${u.active !== false ? 'var(--t1)' : 'var(--t3)'}">
          <i class="fas fa-user-tie" style="color:#0ca678;margin-right:4px;font-size:.75rem"></i>${escHtml(u.name)}
          ${u.active !== false ? '' : '<span style="font-size:.68rem;background:#F3F4F6;color:var(--t3);padding:1px 5px;border-radius:5px;margin-left:4px">비활성</span>'}
        </span>
        <button onclick="toggleStaffActive('${escHtml(u.name)}', ${u.active === false})"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;
                 background:${u.active !== false ? '#FEE2E2' : '#D1FAE5'};color:${u.active !== false ? '#DC2626' : '#065F46'}">
          ${u.active !== false ? '<i class="fas fa-ban"></i> 비활성화' : '<i class="fas fa-check"></i> 활성화'}
        </button>
        <button onclick="openEditStaffPw('${escHtml(u.name)}')"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:#ECFDF5;color:#0ca678">
          <i class="fas fa-key"></i> 비번변경
        </button>
        <button onclick="deleteStaffUser('${escHtml(u.name)}')"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:#FEE2E2;color:#DC2626">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `).join("");
  } catch (e) {
    wrap.innerHTML = `<div style="padding:12px;color:#EF4444;font-size:.8rem">오류: ${e.message}</div>`;
  }
}

async function addStaffUser() {
  const name  = (document.getElementById("newStaffName").value || "").trim();
  const pw    = (document.getElementById("newStaffPw").value   || "").trim();
  const errEl = document.getElementById("addStaffError");
  hide(errEl);
  if (!name) { errEl.textContent = "이름을 입력하세요."; show(errEl); return; }
  if (!pw || pw.length < 4) { errEl.textContent = "비밀번호는 4자 이상이어야 합니다."; show(errEl); return; }
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "addStaffUser", masterPw, name, pw });
    if (!data.success) { errEl.textContent = data.error || "추가 실패"; show(errEl); return; }
    document.getElementById("newStaffName").value = "";
    document.getElementById("newStaffPw").value   = "";
    showToast(`${name} 영업담당자가 추가되었습니다.`, "success");
    loadStaffList();
  } catch (e) { errEl.textContent = e.message; show(errEl); }
}

async function deleteStaffUser(name) {
  if (!confirm(`'${name}' 영업담당자 계정을 삭제하시겠습니까?`)) return;
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "deleteStaffUser", masterPw, name });
    if (!data.success) { showToast(data.error || "삭제 실패", "error"); return; }
    showToast(`${name} 계정이 삭제되었습니다.`, "success");
    loadStaffList();
  } catch (e) { showToast(e.message, "error"); }
}

async function toggleStaffActive(name, active) {
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "editStaffUser", masterPw, name, active });
    if (!data.success) { showToast(data.error || "변경 실패", "error"); return; }
    showToast(`${name} 계정이 ${active ? "활성화" : "비활성화"}되었습니다.`, "success");
    loadStaffList();
  } catch (e) { showToast(e.message, "error"); }
}

function openEditStaffPw(name) {
  const newPw = prompt(`'${name}' 영업담당자의 새 비밀번호를 입력하세요 (4자 이상):`);
  if (newPw === null) return;
  if (!newPw || newPw.length < 4) { showToast("비밀번호는 4자 이상이어야 합니다.", "warning"); return; }
  _doEditStaffPw(name, newPw);
}

async function _doEditStaffPw(name, newPw) {
  const masterPw = _getMasterPwFromSession();
  try {
    const data = await gasPost({ action: "editStaffUser", masterPw, name, newPw });
    if (!data.success) { showToast(data.error || "변경 실패", "error"); return; }
    showToast(`${name} 비밀번호가 변경되었습니다.`, "success");
  } catch (e) { showToast(e.message, "error"); }
}

/* ── 관리자 탭 전환 ── */
function switchAdminTab(tabName) {
  document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".admin-tab-pane").forEach(p => p.classList.remove("active"));
  const btn  = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  const pane = document.getElementById(`tab-${tabName}`);
  if (btn)  btn.classList.add("active");
  if (pane) pane.classList.add("active");
  // 탭별 자동 로드
  if (tabName === "reviewers") loadReviewerList();
  if (tabName === "cs-inquiry") { try { loadCsRooms(); } catch(_){} }
  if (tabName === "recruit")   { loadRecruitList(); loadRecruitTabOptions(); }
  if (tabName === "work-orders") { try { loadWorkOrders(); } catch(_){} }
  if (tabName === "payment")   initPaymentPanel();
  if (tabName === "dashboard") { try { loadTabDashboard(); } catch(_){} try { loadSystemMonitor(); } catch(_){} try { loadStatsOverview(); } catch(_){} try { loadDashWorkOrders(); } catch(_){} }
  if (tabName === "archive")   { try { loadArchiveList(); } catch(_){} try { _loadArchiveHistory(); } catch(_){} }
  if (tabName === "settings")  { try { loadUnrecognizedTabs(); } catch(_){} try { loadKeywordList(); } catch(_){} try { loadCompanyBusinessNo(); } catch(_){} }
  if (tabName === "errorlogs") { try { loadErrorLogs(); } catch(_){} }
  if (tabName === "order-ledger") { try { loadOrderLedger(); } catch(_){} }
  // ★ 컨텍스트 툴바 업데이트
  _updateContextToolbar(tabName);
}

/* ══════════════════════════════════════════════════════════════
   ★ 작업 오더(work_orders) 인박스 — 관리자
   ══════════════════════════════════════════════════════════════ */
const WO_LABELS = {
  submitted:'제출됨', reviewing:'접수됨', await_chatroom:'카톡방생성대기',
  published:'모집공고발행', done:'완료', rejected:'반려', revision:'보완요청',
};
const WO_COLORS = {
  submitted:['#e8f1fe','#1b64da'], reviewing:['#DBEAFE','#1E40AF'],
  await_chatroom:['#FEF3C7','#92400E'], published:['#e8f1fe','#1b64da'],
  done:['#D1FAE5','#065F46'], rejected:['#FEE2E2','#991B1B'], revision:['#FFEDD5','#9A3412'],
};
let _woCache = [];   // 인박스 목록 캐시 (카드 버튼 핸들러에서 조회)
let _woBadgeTimer = null;     // 신규 오더 배지/알림 폴러
let _woLastNewCount = null;   // 직전 신규(제출됨) 오더 수
const _WO_BADGE_POLL_MS = 2 * 60 * 1000; // 2분
const WO_TRANSITIONS = {
  submitted:      ['reviewing', 'rejected', 'revision'],
  reviewing:      ['await_chatroom', 'rejected', 'revision'],
  await_chatroom: ['published', 'reviewing', 'rejected'],
  published:      ['done'],
  done:           [],
  rejected:       ['reviewing'],
  revision:       ['reviewing'],
};

async function loadWorkOrders() {
  const wrap = document.getElementById("woListWrap");
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;color:#9CA3AF;padding:30px;font-size:.85rem">불러오는 중...</div>';
  const status = (document.getElementById("woStatusFilter") || {}).value || "";
  try {
    const r = await gasGet(status ? { action:"orderAdminList", status } : { action:"orderAdminList" });
    const list = (r && r.ok && r.data) ? r.data : [];
    // 배지는 필터와 무관한 전체 제출됨 수(new-count)로 통일 — _refreshWorkOrderBadge 가 단일 소스
    try { _refreshWorkOrderBadge(false); } catch(_) {}
    _woCache = list;
    if (list.length === 0) {
      wrap.innerHTML = '<div style="text-align:center;color:#9CA3AF;padding:30px;font-size:.85rem">오더가 없습니다.</div>';
      return;
    }
    wrap.innerHTML = list.map(_renderWorkOrderCard).join("");
  } catch(e) {
    wrap.innerHTML = '<div style="text-align:center;color:#DC2626;padding:30px;font-size:.85rem">불러오기 실패: ' + escHtml(e.message) + '</div>';
  }
}

// ── 대시보드: 작업오더 간편보기 (최신 4건, 카드별 펼쳐보기) ──
let _dashWoCache = [];
async function loadDashWorkOrders() {
  const wrap = document.getElementById("dashWoList");
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;color:#9CA3AF;padding:16px;font-size:.82rem">불러오는 중...</div>';
  try {
    const r = await gasGet({ action: "orderAdminList" });
    const list = ((r && r.ok && r.data) ? r.data : []).slice(0, 4);
    _dashWoCache = list;
    wrap.style.maxHeight = "134px";
    if (!list.length) { wrap.innerHTML = '<div style="text-align:center;color:#9CA3AF;padding:16px;font-size:.82rem">작업오더가 없습니다.</div>'; return; }
    wrap.innerHTML = list.map(_renderDashOrderCard).join("");
  } catch (e) {
    wrap.innerHTML = '<div style="text-align:center;color:#DC2626;padding:16px;font-size:.82rem">불러오기 실패: ' + escHtml(e.message) + '</div>';
  }
}

function _renderDashOrderCard(o) {
  const st = o.status || "submitted";
  const [bg, fg] = WO_COLORS[st] || ["#F3F4F6", "#374151"];
  const date = (o.created_at || "").replace("T", " ").substring(0, 16);
  return `<div style="border:1px solid #E5E7EB;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#fff">
    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
      <button onclick="woDashToggleDetail('${o.id}',this)" style="font-size:.7rem;font-weight:700;background:#e8f1fe;color:#1b64da;border:1px solid #cce0fb;border-radius:6px;padding:2px 8px;cursor:pointer;white-space:nowrap"><i class="fas fa-chevron-down"></i> 펼쳐보기</button>
      <span style="font-size:.66rem;font-weight:700;padding:2px 8px;border-radius:20px;background:${bg};color:${fg}">${WO_LABELS[st] || st}</span>
      <b style="font-size:.85rem;color:#111827">${escHtml(o.title || "")}</b>
      <span style="font-size:.7rem;color:#9CA3AF;margin-left:auto"><i class="fas fa-user"></i> ${escHtml(o.created_by || "-")} · ${date}</span>
    </div>
    <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px 12px;font-size:.74rem;color:#374151">
      ${o.recruit_count ? `<span><b style="color:#6B7280">모집</b> ${Number(o.recruit_count).toLocaleString()}명</span>` : ""}
      ${o.delivery_type ? `<span><b style="color:#6B7280">배송</b> ${escHtml(o.delivery_type)}</span>` : ""}
      ${o.pay_amount ? `<span><b style="color:#6B7280">구입비</b> ${Number(o.pay_amount).toLocaleString()}원</span>` : ""}
      ${o.start_date ? `<span><b style="color:#6B7280">시작</b> ${escHtml(String(o.start_date).substring(0, 10))}</span>` : ""}
    </div>
    <div id="dashDetail_${o.id}" style="display:none;margin-top:8px;border-top:1px dashed #E5E7EB;padding-top:8px">
      ${_woDetailHtml(o)}
    </div>
  </div>`;
}

// 간편보기 카드 펼치기/접기 + 블록 높이 자동 조정
function woDashToggleDetail(id, btn) {
  const d = document.getElementById("dashDetail_" + id);
  if (!d) return;
  const open = d.style.display === "none";
  d.style.display = open ? "block" : "none";
  btn.innerHTML = open ? '<i class="fas fa-chevron-up"></i> 간략히보기' : '<i class="fas fa-chevron-down"></i> 펼쳐보기';
  const list = document.getElementById("dashWoList");
  if (list) {
    const anyOpen = [...list.querySelectorAll('[id^="dashDetail_"]')].some(e => e.style.display !== "none");
    list.style.maxHeight = anyOpen ? "none" : "134px";
  }
}

function _woField(label, val, isLink) {
  if (!val && val !== 0) return "";
  // http(s) 스킴만 링크화 (javascript: 등 차단), 그 외엔 평문
  const safeLink = isLink && /^https?:\/\//i.test(String(val).trim());
  const v = safeLink
    ? `<a href="${escHtml(val)}" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">${escHtml(val)}</a>`
    : escHtml(String(val));
  // 항목명 폭 고정 + 자간 양끝맞춤(text-align-last:justify)으로 콜론/값 정렬
  return `<div style="display:flex;align-items:baseline;font-size:.78rem;color:#374151;margin:3px 0;line-height:1.55">
    <span style="flex:0 0 102px;color:#6B7280;font-weight:600;text-align:justify;text-align-last:justify">${label}</span>
    <span style="flex:0 0 12px;text-align:center;color:#9CA3AF">:</span>
    <span style="flex:1 1 auto;min-width:0;word-break:break-all">${v}</span>
  </div>`;
}

// 텍스트 escape 후 http(s) URL만 링크화 (javascript: 등 차단)
function _woLinkify(text) {
  return escHtml(String(text == null ? "" : text))
    .replace(/(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">$1</a>');
}

// 상품·옵션 요약에서 아래 개별 필드와 중복되는 값 제거:
//  - [합계]/합계 라인(모집인원·총구입비), 구분선
//  - 상품 URL(= 상품확인용URL 필드와 중복) 및 바레 URL
function _woCleanProductOption(raw, productUrl) {
  if (!raw || !String(raw).trim()) return "";
  const pu = (productUrl || "").trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  for (let ln of String(raw).split(/\r?\n/)) {
    const t = ln.trim();
    if (/^\[?\s*합계/.test(t)) continue;            // [합계]/합계 라인 제거
    if (/^소계\s*[:：]/.test(t)) continue;           // 독립 '소계:' 라인 제거(키트 형식)
    if (/^\[\s*상품/.test(t)) continue;              // [상품/옵션/건수] 헤더 제거(상위 라벨과 중복)
    if (/^[─—\-]{3,}$/.test(t)) continue;            // 구분선 제거
    ln = ln.replace(/\(\s*https?:\/\/[^)]*\)/g, "");  // (http URL) 제거
    if (pu) ln = ln.replace(new RegExp("\\(\\s*" + esc(pu) + "\\s*\\)", "g"), ""); // (상품URL) 제거
    ln = ln.replace(/\s*https?:\/\/\S+/g, "");        // 바레 URL 제거
    // 건수(N명/N건)·소계·라인합계 제거 — 옵션명+결제금액만 남김 (모집인원/총구입비는 아래 필드와 중복)
    ln = ln.replace(/\s*\/\s*소계\s*[\d,]+\s*원/g, "")
           .replace(/\s*\/\s*\d[\d,]*\s*[명건]/g, "")
           .replace(/\s*[×x]\s*\d[\d,]*\s*[명건]/g, "")
           .replace(/\s*=\s*[\d,]+\s*원/g, "")
           .replace(/\s*\/\s*$/, "");
    ln = ln.replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, "");
    out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 항목명 정렬 + 여러 줄 값 (상품·옵션처럼 멀티라인 값을 같은 목록에 통합)
function _woMultiField(label, val) {
  if (!val || !String(val).trim()) return "";
  return `<div style="display:flex;align-items:flex-start;font-size:.78rem;color:#374151;margin:3px 0;line-height:1.55">
    <span style="flex:0 0 102px;color:#6B7280;font-weight:600;text-align:justify;text-align-last:justify">${label}</span>
    <span style="flex:0 0 12px;text-align:center;color:#9CA3AF">:</span>
    <span style="flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word">${_woLinkify(val)}</span>
  </div>`;
}

// Drive URL에서 fileId 추출 (/file/d/ID, ?id=ID, /d/ID)
function _driveId(url) {
  const s = String(url);
  const m = s.match(/\/file\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/\/d\/([-\w]{20,})/);
  return m ? m[1] : null;
}

// 이미지 라이트박스(화면 내 팝업) — 화면맞춤으로 열고 [원본크기보기] 토글 제공
function woImageModal(url) {
  let ov = document.getElementById("woImgModal");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "woImgModal";
    ov.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.82);display:none;align-items:center;justify-content:center;padding:24px;cursor:zoom-out;overflow:auto";
    ov.innerHTML =
      '<button id="woImgOrig" style="position:fixed;top:14px;right:60px;z-index:2;background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)">원본크기보기</button>'
      + '<span id="woImgClose" style="position:fixed;top:9px;right:18px;z-index:2;color:#fff;font-size:32px;line-height:1;cursor:pointer">&times;</span>'
      + '<img id="woImgModalImg" style="border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5);display:block;margin:auto">'
      + '<div id="woImgModalErr" style="display:none;color:#fff;font-size:14px;text-align:center;max-width:90vw;word-break:break-all"></div>';
    document.body.appendChild(ov);
    const im = ov.querySelector("#woImgModalImg");
    const er = ov.querySelector("#woImgModalErr");
    const btn = ov.querySelector("#woImgOrig");
    const fit = () => {
      im.style.maxWidth = "92vw"; im.style.maxHeight = "88vh"; im.style.width = "auto"; im.style.height = "auto"; im.style.cursor = "zoom-in";
      ov.style.alignItems = "center"; ov.style.justifyContent = "center"; ov.scrollTop = 0;
      btn.textContent = "원본크기보기"; ov._orig = false;
    };
    const orig = () => {
      im.style.maxWidth = "none"; im.style.maxHeight = "none"; im.style.cursor = "zoom-out";
      ov.style.alignItems = "flex-start"; ov.style.justifyContent = "flex-start";
      btn.textContent = "화면맞춤"; ov._orig = true;
    };
    ov._fit = fit; ov._toggle = () => { ov._orig ? fit() : orig(); };
    ov.addEventListener("click", () => { ov.style.display = "none"; });
    btn.addEventListener("click", e => { e.stopPropagation(); ov._toggle(); });
    ov.querySelector("#woImgClose").addEventListener("click", e => { e.stopPropagation(); ov.style.display = "none"; });
    im.addEventListener("click", e => { e.stopPropagation(); ov._toggle(); });
    er.addEventListener("click", e => e.stopPropagation());
    im.addEventListener("error", () => {
      im.style.display = "none"; btn.style.display = "none";
      const u = ov._lastUrl || im.src;
      const dbg = u + (u.indexOf("?") >= 0 ? "&" : "?") + "debug=1";
      er.innerHTML = "이미지를 불러올 수 없습니다.<br><span style='font-size:12px;opacity:.7'>" + u + "</span><br>"
        + "<a href='" + dbg + "' target='_blank' rel='noopener' style='color:#93c5fd'>🔧 진단 정보 보기</a>";
      er.style.display = "block";
    });
    im.addEventListener("load", () => { im.style.display = "block"; btn.style.display = "block"; er.style.display = "none"; });
    document.addEventListener("keydown", e => { if (e.key === "Escape") ov.style.display = "none"; });
  }
  ov._lastUrl = url;
  ov.querySelector("#woImgModalErr").style.display = "none";
  const im = ov.querySelector("#woImgModalImg");
  ov._fit();                       // 항상 화면맞춤으로 시작
  im.style.display = "block";
  im.src = url;
  ov.style.display = "flex";
}
// 이미지 로드 실패 시 → 팝업으로 여는 링크로 대체
function _woImgError(img) {
  const a = document.createElement("a");
  a.href = "#"; a.textContent = "📎 첨부 이미지 보기";
  a.style.cssText = "color:#1b64da;cursor:pointer";
  const u = img.dataset.openurl || img.src;
  a.addEventListener("click", e => { e.preventDefault(); woImageModal(u); });
  img.replaceWith(a);
}
// 팝업으로 열리는 이미지 태그 (카드 내 미리보기 크기 제한)
function _woImgTag(src, openUrl) {
  return `<img src="${escHtml(src)}" data-openurl="${escHtml(openUrl || src)}" style="max-width:min(100%,360px);max-height:240px;width:auto;height:auto;border-radius:8px;margin:4px 0;cursor:zoom-in;border:1px solid #E5E7EB" loading="lazy" title="클릭하면 크게 보기" onclick="woImageModal(this.dataset.openurl||this.src)" onerror="_woImgError(this)">`;
}

// 평문 → 안전 HTML: 줄바꿈 보존, URL 링크화, Drive 파일 URL은 이미지로 자동 임베드
function _woTextToHtml(text) {
  const parts = String(text == null ? "" : text).split(/(https?:\/\/[^\s<]+)/g);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const url = parts[i];
      const isProxy = /\/api\/order\/guide-image\/[-\w]{20,}/.test(url);
      const id = _driveId(url);
      if (isProxy) {
        html += _woImgTag(url, url);
      } else if (id) {
        html += _woImgTag(`https://drive.google.com/thumbnail?id=${id}&sz=w1600`, url);
      } else {
        html += `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">${escHtml(url)}</a>`;
      }
    } else {
      html += escHtml(parts[i]).replace(/\n/g, "<br>");
    }
  }
  return html;
}

// 유입가이드 본문 안전 렌더 — 평문(Drive URL 자동 임베드) / HTML(<img>) 양쪽 처리
function _woGuideHtml(raw) {
  if (!raw) return "";
  // HTML 태그가 없으면 평문으로 보고 Drive URL을 이미지로 임베드
  if (!/<[a-z][\s\S]*?>/i.test(raw)) return _woTextToHtml(raw);
  const tmp = document.createElement("div");
  tmp.innerHTML = raw;
  tmp.querySelectorAll("script,style,iframe,object,embed,link").forEach(n => n.remove());
  tmp.querySelectorAll("*").forEach(el => {
    [...el.attributes].forEach(a => {
      const n = a.name.toLowerCase();
      if (n.startsWith("on")) el.removeAttribute(a.name);
      if ((n === "href" || n === "src") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    });
  });
  tmp.querySelectorAll("img").forEach(img => {
    img.style.maxWidth = "min(100%,360px)";
    img.style.maxHeight = "240px";
    img.style.width = "auto";
    img.style.height = "auto";
    img.style.borderRadius = "8px";
    img.style.margin = "4px 0";
    img.style.border = "1px solid #E5E7EB";
    img.style.cursor = "zoom-in";
    img.loading = "lazy";
    img.title = "클릭하면 크게 보기";
    // 새 탭 대신 팝업으로 열기 (부모 <a> 링크는 무력화)
    img.setAttribute("onclick", "woImageModal(this.src);return false;");
    const a = img.closest("a");
    if (a) { a.removeAttribute("target"); a.setAttribute("href", "javascript:void(0)"); }
  });
  return tmp.innerHTML;
}

const _INFLOW_LABEL = { guide: "유입가이드", link: "링크유입" };

// 처리메모 누적 로그 렌더 (전송됨/미전송 + 전송시점, 최신순)
function _woMemoLogInner(o) {
  let log = [];
  try { const p = JSON.parse(o.memo_log || "[]"); if (Array.isArray(p)) log = p; } catch (_) {}
  if (!log.length) {
    return o.admin_memo
      ? `<b style="color:#6B7280;font-size:.74rem">처리메모</b><div style="margin-top:3px;font-size:.76rem;color:#374151">${escHtml(o.admin_memo)}</div>`
      : "";
  }
  const rows = log.slice().reverse().map(e => {
    const t = String(e.at || "").replace("T", " ").substring(0, 16);
    const ok = !!e.delivered;
    const badge = ok
      ? '<span style="flex:none;font-size:.66rem;font-weight:700;color:#065F46;background:#D1FAE5;border-radius:5px;padding:1px 6px">전송됨</span>'
      : '<span style="flex:none;font-size:.66rem;font-weight:700;color:#92400E;background:#FEF3C7;border-radius:5px;padding:1px 6px" title="' + escHtml(e.error || "") + '">미전송</span>';
    return `<div style="display:flex;gap:8px;align-items:flex-start;justify-content:space-between;padding:5px 0;border-top:1px solid #F3F4F6">
      <div style="display:flex;gap:6px;align-items:flex-start;min-width:0">${badge}<span style="word-break:break-word;color:#374151">${escHtml(e.memo || "")}${e.by ? ` <span style="color:#9CA3AF">· ${escHtml(e.by)}</span>` : ""}</span></div>
      <div style="flex:none;color:#9CA3AF;white-space:nowrap;font-size:.72rem">${t}</div>
    </div>`;
  }).join("");
  return `<b style="color:#6B7280;font-size:.74rem">처리메모 로그 (${log.length})</b><div style="margin-top:2px;font-size:.76rem">${rows}</div>`;
}

// 인트라넷이 review_guide/special_notes에 [헤더] 섹션으로 모든 항목을 중복 포함시켜 보내므로,
// 개별 필드로 이미 표시되는 섹션은 버리고 지정한 라벨의 섹션 내용만 추출한다.
// 섹션 헤더가 전혀 없으면(우리 키트/스태프의 평문) 원문 그대로 반환.
function _woPickSections(raw, keepLabels) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) return "";
  if (!/\[[^\]]+\]/.test(text)) return text.trim();
  const norm = s => s.replace(/\s/g, "");
  const keep = keepLabels.map(norm);
  const lines = text.split(/\r?\n/);
  const out = [];
  let take = false, buf = [];
  const flush = () => { const c = buf.join("\n").trim(); if (take && c) out.push(c); buf = []; };
  for (const ln of lines) {
    const m = ln.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      flush();
      take = keep.some(k => norm(m[1]).includes(k));
      buf = m[2] ? [m[2]] : [];
    } else {
      buf.push(ln);
    }
  }
  flush();
  return out.join("\n\n").trim();
}

// ── 카톡 ▶형식 렌더 (팀채팅방 게시 가독성) ──
function _woLinkHtml(url) {
  const u = (url == null) ? "" : String(url).trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u)
    ? `<a href="${escHtml(u)}" target="_blank" rel="noopener noreferrer" style="color:#1b64da;word-break:break-all">${escHtml(u)}</a>`
    : escHtml(u);
}
// 한 줄 항목:  ▶ 라벨 : 값
function _woKv(label, val) {
  if (val == null || val === "") return "";
  return `<div style="font-size:.8rem;color:#1F2937;margin:2px 0;line-height:1.65;word-break:break-word"><span style="color:#3182f6;font-weight:700">▶</span> <b>${escHtml(label)}</b> : ${escHtml(String(val))}</div>`;
}
// 멀티라인 섹션:  ▶ 라벨 ◀  (다음 줄에 내용)
// 멀티라인/단일라인 자동: 1줄이면 '▶ 라벨 : 값', 2줄+면 '▶ 라벨 :' 후 줄바꿈
function _woSection(label, rawText, renderFn) {
  const txt = (rawText == null ? "" : String(rawText)).replace(/\s+$/, "");
  if (!txt.trim()) return "";
  const multi = /\n/.test(txt.trim());
  const inner = renderFn(txt);
  const lab = `<span style="color:#3182f6;font-weight:700">▶</span> <b>${escHtml(label)}</b> :`;
  if (!multi) {
    return `<div style="font-size:.8rem;color:#1F2937;margin:2px 0;line-height:1.65;word-break:break-word">${lab} ${inner}</div>`;
  }
  return `<div style="margin-top:4px"><div style="font-size:.8rem;color:#1F2937;line-height:1.6">${lab}</div><div style="font-size:.79rem;color:#374151;margin-top:1px;line-height:1.6;word-break:break-word">${inner}</div></div>`;
}

// 유입가이드 본문 정리: "[유입가이드 첨부 이미지]" 헤더, "1. xxx.png (..저장됨)" 파일정보 라인 제거
function _woCleanGuide(raw) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw).split(/\r?\n/)
    .filter(ln => !/^\s*\[유입가이드\s*첨부\s*이미지\]\s*$/.test(ln))
    .filter(ln => !/^\s*\d+\.\s.*\(.*저장됨\)\s*$/.test(ln))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

// 상품·옵션을 "상품명 - 결제금액" (옵션 있으면 옵션별) 한 줄로 압축
//  1개 상품·옵션 → 인라인,  2개 이상 → 번호 매겨 줄바꿈
function _woProductLines(o) {
  const lines = [];
  // 1) 구조화 JSON 우선
  let arr = null;
  try { const p = JSON.parse(o.product_options_json || "[]"); if (Array.isArray(p) && p.length) arr = p; } catch (_) {}
  if (arr) {
    for (const prod of arr) {
      const name = (prod.name || "").trim();
      const opts = Array.isArray(prod.options) ? prod.options : [];
      if (opts.length) {
        for (const op of opts) {
          const lab = (op.label || "").trim();
          const pay = Number(op.pay) || 0;
          lines.push(`${name}${lab ? " " + lab : ""}${pay ? " - 결제금액 " + pay.toLocaleString() + "원" : ""}`.trim());
        }
      } else {
        const pay = Number(prod.base && prod.base.pay) || 0;
        lines.push(`${name}${pay ? " - 결제금액 " + pay.toLocaleString() + "원" : ""}`.trim());
      }
    }
  } else {
    // 2) product_option 텍스트 파싱: "1. 상품명" + "- [옵션] / 결제금액 N원"
    const cleaned = _woCleanProductOption(o.product_option, o.product_url);
    if (!cleaned) return "";
    let curName = "", curHadOpt = false;
    const flushNameOnly = () => { if (curName && !curHadOpt) lines.push(curName); };
    for (const raw of cleaned.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) continue;
      const mName = t.match(/^\d+\.\s*(.+)$/);            // "1. 멀티비타민"
      if (mName) { flushNameOnly(); curName = mName[1].trim(); curHadOpt = false; continue; }
      const opt = t.replace(/^[-•]\s*/, "");              // "옵션 없음 / 결제금액 26,900원"
      const payM = opt.match(/결제금액\s*([\d,]+)\s*원/);
      const pay = payM ? payM[1] : "";
      let optLabel = opt.split("/")[0].trim();
      if (/^옵션\s*없음$/.test(optLabel)) optLabel = "";   // "옵션 없음" 생략
      lines.push(`${curName}${optLabel ? " " + optLabel : ""}${pay ? " - 결제금액 " + pay + "원" : ""}`.trim());
      curHadOpt = true;
    }
    flushNameOnly();
  }
  const clean = lines.filter(Boolean);
  if (!clean.length) return "";
  // 링크유입이면 상품 순서대로 유입링크를 같은 줄에 붙임
  let withUrl = clean;
  if (o.inflow_type === "link") {
    const urls = _woGuideUrls(o.inflow_guide);
    withUrl = clean.map((l, i) => urls[i] ? `${l} ${urls[i]}` : l);
  }
  if (withUrl.length === 1) return withUrl[0];               // 1개 → 인라인
  return withUrl.map((l, i) => `${i + 1}.${l}`).join("\n");  // 2개+ → 번호+줄바꿈
}

// inflow_guide 등에서 http(s) URL을 순서대로 추출
function _woGuideUrls(raw) {
  const urls = [];
  const re = /https?:\/\/[^\s<]+/g;
  let m;
  while ((m = re.exec(String(raw == null ? "" : raw)))) urls.push(m[0]);
  return urls;
}

// 작업오더 상세 본문 (카드/간편보기 공용) — 카톡 ▶형식
function _woDetailHtml(o) {
  const prodText = _woProductLines(o);
  const guide = _woCleanGuide(o.inflow_guide);
  const rg = _woPickSections(o.review_guide, ["리뷰등록 가이드", "리뷰가이드", "리뷰 가이드"]);
  const sn = _woPickSections(o.special_notes, ["특이사항"]);
  const txtR = t => _woLinkify(t).replace(/\n/g, "<br>");   // 텍스트(줄바꿈 보존)
  const urlR = t => _woLinkHtml(t);                          // 단일 URL
  const guideR = t => _woGuideHtml(t);                       // 가이드(이미지 임베드)
  return [
    _woKv("담당AE", o.created_by),
    _woSection("상품·옵션", prodText, txtR),
    _woKv("모집인원", o.recruit_count ? Number(o.recruit_count).toLocaleString() + "명" : ""),
    _woKv("일일진행건수", o.daily_count_text || o.daily_count),
    _woKv("구매시간대", o.purchase_time),
    _woKv("유입방식", _INFLOW_LABEL[o.inflow_type] || o.inflow_keyword || ""),
    _woKv("배송유형", o.delivery_type),
    _woKv("택배대행", o.courier_proxy ? "예" : ""),
    _woKv("리뷰유형", o.review_type),
    _woKv("물건비", o.goods_cost_type),
    _woSection("상품확인용URL", o.product_url, urlR),
    _woSection("작업시트탭URL", o.work_sheet_url, urlR),
    rg ? _woSection("리뷰가이드", rg, txtR) : "",
    sn ? _woSection("특이사항", sn, txtR) : "",
    o.inflow_type === "link"
      ? _woKv("유입방법", "링크유입")
      : (guide ? _woSection("유입가이드", guide, guideR) : ""),
  ].join("");
}

function _renderWorkOrderCard(o) {
  const st = o.status || "submitted";
  const [bg, fg] = WO_COLORS[st] || ["#F3F4F6","#374151"];
  const date = (o.created_at || "").replace("T"," ").substring(0,16);
  const nexts = WO_TRANSITIONS[st] || [];
  const btns = nexts.map(ns => {
    const [nbg, nfg] = WO_COLORS[ns] || ["#e8f1fe","#1b64da"];
    return `<button onclick="woTransition('${o.id}','${ns}')"
      style="font-size:.74rem;font-weight:700;background:${nbg};color:${nfg};border:1px solid ${nfg}33;border-radius:7px;padding:5px 10px;cursor:pointer">→ ${WO_LABELS[ns]}</button>`;
  }).join("");

  const memo = o.admin_memo
    ? `<div style="margin-top:4px;font-size:.74rem;color:#991B1B"><b>메모:</b> ${escHtml(o.admin_memo)}</div>` : "";
  const woChatReg = !!(o.chat_room_url && String(o.chat_room_url).trim());

  return `<div style="border:1.5px solid #E5E7EB;border-radius:12px;padding:14px 16px;margin-bottom:12px;background:#fff">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button onclick="woToggleDetail('${o.id}',this)" style="font-size:.72rem;font-weight:700;background:#e8f1fe;color:#1b64da;border:1px solid #cce0fb;border-radius:7px;padding:3px 9px;cursor:pointer;white-space:nowrap"><i class="fas fa-chevron-down"></i> 펼쳐보기</button>
      <span style="font-size:.7rem;font-weight:700;padding:2px 9px;border-radius:20px;background:${bg};color:${fg}">${WO_LABELS[st]||st}</span>
      <b style="font-size:.92rem;color:#111827">${escHtml(o.title||"")}</b>
      <span style="font-size:.72rem;color:#9CA3AF;margin-left:auto"><i class="fas fa-user"></i> ${escHtml(o.created_by||"-")} · ${date}</span>
    </div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:.78rem;color:#374151">
      ${o.recruit_count ? `<span><b style="color:#6B7280">모집</b> ${Number(o.recruit_count).toLocaleString()}명</span>`:""}
      ${o.delivery_type ? `<span><b style="color:#6B7280">배송</b> ${escHtml(o.delivery_type)}${o.courier_proxy?"·택배대행":""}</span>`:""}
      ${o.pay_amount ? `<span><b style="color:#6B7280">구입비</b> ${Number(o.pay_amount).toLocaleString()}원</span>`:""}
      ${o.start_date ? `<span><b style="color:#6B7280">시작</b> ${escHtml(String(o.start_date).substring(0,10))}</span>`:""}
    </div>
    <div id="woDetail_${o.id}" style="display:none">
      <div style="margin-top:10px">${_woDetailHtml(o)}</div>
      <div id="woMemoLog_${o.id}" style="margin-top:6px">${_woMemoLogInner(o)}</div>
    </div>
    <div style="margin-top:10px;border-top:1px dashed #E5E7EB;padding-top:10px">
      <!-- 카톡 팀채팅방URL 등록 -->
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input id="woChat_${o.id}" type="text" value="${escHtml(o.chat_room_url||"")}" placeholder="카톡 팀채팅방URL (발행 시 필수)" ${woChatReg ? "readonly" : ""}
          style="width:300px;max-width:100%;padding:8px 10px;border:1.5px solid ${woChatReg?'#6EE7B7':'#E5E7EB'};border-radius:7px;font-size:.78rem;${woChatReg?'background:#ECFDF5;color:#065F46;font-weight:600':''}">
        <button id="woChatBtn_${o.id}" data-reg="${woChatReg?1:0}" onclick="woToggleChat('${o.id}')"
          style="flex:none;font-size:.74rem;font-weight:700;border-radius:7px;padding:7px 13px;cursor:pointer;white-space:nowrap;border:1px solid ${woChatReg?'#FCD34D':'#3182f6'};background:${woChatReg?'#FEF9C3':'#3182f6'};color:${woChatReg?'#92400E':'#fff'}">${woChatReg?'링크수정':'등록'}</button>
      </div>
      <!-- 처리 메모 → 인트라넷 전송 -->
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <input id="woMemo_${o.id}" type="text" value="${escHtml(o.admin_memo||"")}" placeholder="처리 메모 / 보완 사유 (인트라넷으로 전송)"
          style="width:300px;max-width:100%;padding:8px 10px;border:1.5px solid #E5E7EB;border-radius:7px;font-size:.78rem">
        <button onclick="woSendMemo('${o.id}')" style="flex:none;font-size:.74rem;font-weight:700;border-radius:7px;padding:7px 13px;cursor:pointer;white-space:nowrap;border:1px solid #cce0fb;background:#e8f1fe;color:#1b64da"><i class="fas fa-paper-plane"></i> 전송</button>
      </div>
      <!-- 액션 -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${['reviewing','await_chatroom','published','done'].includes(st)
          ? `<button disabled style="font-size:.8rem;font-weight:700;border-radius:8px;padding:8px 16px;cursor:default;border:1px solid #6EE7B7;background:#ECFDF5;color:#065F46"><i class="fas fa-check-circle"></i> 접수됨</button>`
          : `<button id="woAcceptBtn_${o.id}" onclick="woAccept('${o.id}')" style="font-size:.8rem;font-weight:700;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid #93C5FD;background:#DBEAFE;color:#1E40AF"><i class="fas fa-inbox"></i> 접수하기</button>`}
        ${o.linked_campaign_id
          ? `<button onclick="woViewCampaign('${escHtml(o.linked_campaign_id)}')" style="font-size:.8rem;font-weight:700;background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7;border-radius:8px;padding:8px 16px;cursor:pointer"><i class="fas fa-link"></i> 연결된 공고 보기</button>`
          : `<button onclick="woCreateCampaignGuarded('${o.id}')" style="font-size:.8rem;font-weight:700;background:#e8f1fe;color:#1b64da;border:1px solid #a6c8fb;border-radius:8px;padding:8px 16px;cursor:pointer"><i class="fas fa-bullhorn"></i> 모집공고생성</button>`}
        <button onclick="woDelete('${o.id}')" title="작업오더 삭제 (인트라넷에서도 삭제됨)" style="font-size:.8rem;font-weight:700;background:#FEF2F2;color:#B91C1C;border:1px solid #FECACA;border-radius:8px;padding:8px 16px;cursor:pointer;margin-left:auto"><i class="fas fa-trash-alt"></i> 삭제</button>
      </div>
    </div>
  </div>`;
}

// 작업오더 카드 상세 펼치기/접기
function woToggleDetail(id, btn) {
  const d = document.getElementById("woDetail_" + id);
  if (!d) return;
  const open = d.style.display === "none";
  d.style.display = open ? "block" : "none";
  btn.innerHTML = open
    ? '<i class="fas fa-chevron-up"></i> 간략히보기'
    : '<i class="fas fa-chevron-down"></i> 펼쳐보기';
}

// 간단 안내 팝업
function woNotice(msg) {
  let m = document.getElementById("woNoticeModal");
  if (!m) {
    m = document.createElement("div");
    m.id = "woNoticeModal";
    m.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:20px";
    m.classList.add("toss-overlay");
    m.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:340px;width:100%;padding:22px 20px;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.25)">'
      + '<div id="woNoticeMsg" style="font-size:.92rem;color:#111827;line-height:1.55;margin-bottom:16px;white-space:pre-wrap"></div>'
      + '<button id="woNoticeOk" style="background:#3182f6;color:#fff;border:none;border-radius:9px;padding:9px 24px;font-weight:700;font-size:.88rem;cursor:pointer">확인</button></div>';
    document.body.appendChild(m);
    m.addEventListener("click", e => { if (e.target === m) m.style.display = "none"; });
    m.querySelector("#woNoticeOk").addEventListener("click", () => { m.style.display = "none"; });
    document.addEventListener("keydown", e => { if (e.key === "Escape") m.style.display = "none"; });
  }
  m.querySelector("#woNoticeMsg").textContent = msg;
  m.style.display = "flex";
}

// 카톡 팀채팅방URL 등록 / 링크수정 토글
async function woToggleChat(id) {
  const inp = document.getElementById("woChat_" + id);
  const btn = document.getElementById("woChatBtn_" + id);
  if (!inp || !btn) return;
  const setEdit = () => {
    inp.readOnly = false; inp.style.background = ""; inp.style.color = ""; inp.style.fontWeight = ""; inp.style.borderColor = "#E5E7EB";
    btn.dataset.reg = "0"; btn.textContent = "등록";
    btn.style.border = "1px solid #3182f6"; btn.style.background = "#3182f6"; btn.style.color = "#fff";
    inp.focus();
  };
  const setReg = () => {
    inp.readOnly = true; inp.style.background = "#ECFDF5"; inp.style.color = "#065F46"; inp.style.fontWeight = "600"; inp.style.borderColor = "#6EE7B7";
    btn.dataset.reg = "1"; btn.textContent = "링크수정";
    btn.style.border = "1px solid #FCD34D"; btn.style.background = "#FEF9C3"; btn.style.color = "#92400E";
  };
  if (btn.dataset.reg === "1") { setEdit(); return; }   // 링크수정 → 편집
  const url = (inp.value || "").trim();
  if (!url) { showToast("카톡 팀채팅방URL을 입력하세요.", true); inp.focus(); return; }
  try {
    const r = await gasGet({ action: "orderAdminUpdate", id, chat_room_url: url });
    if (r && r.ok) {
      setReg();
      const o = (_woCache || []).find(x => x.id === id); if (o) o.chat_room_url = url;
      showToast("카톡 URL이 등록되었습니다.");
    } else showToast((r && r.error) || "등록 실패", true);
  } catch (e) { showToast("오류: " + e.message, true); }
}

// 처리 메모 → 인트라넷 전송 (webhook push)
async function woSendMemo(id) {
  const memo = ((document.getElementById("woMemo_" + id) || {}).value || "").trim();
  if (!memo) { showToast("전송할 메모를 입력하세요.", "error"); return; }
  try {
    const r = await gasGet({ action: "orderSendMemo", id, memo });
    if (r && r.ok) {
      // 캐시 갱신 + 로그 즉시 반영 + 입력칸 비우기
      const idx = (_woCache || []).findIndex(x => x.id === id);
      if (idx >= 0 && r.data) _woCache[idx] = r.data;
      const box = document.getElementById("woMemoLog_" + id);
      if (box && r.data) box.innerHTML = _woMemoLogInner(r.data);
      const inp = document.getElementById("woMemo_" + id); if (inp) inp.value = "";
      if (r.delivered) showToast("인트라넷으로 전송되었습니다.");
      else showToast("저장됨 · 인트라넷 미전송(" + (r.deliverError || "webhook 미설정") + ")", true);
    } else showToast((r && r.error) || "전송 실패", true);
  } catch (e) { showToast("오류: " + e.message, true); }
}

// 접수하기 (제출됨 → 접수됨)
// ★ 업무 연계: 작업시트탭URL(gid 필수)이 가리키는 "그 탭"을 캠페인 탭 관리에 등록하고,
//   작업오더 기본정보(담당자·시간대·리뷰유형·배송·택배대행)를 탭 메타에 자동 입력 → 상태 '접수됨' 전이.
//   동일 탭 재접수(2차 등)는 별도 탭을 만들지 않고 기존 한 줄을 유지(차수는 시트 차수컬럼 집계가 담당).
//   서버 단일 엔드포인트(orderAdminAccept)가 등록+메타매핑+인덱스빌드+상태전이를 원자적으로 처리.
async function woAccept(id) {
  const o = (_woCache || []).find(x => x.id === id);
  const url = ((o && o.work_sheet_url) || "").trim();

  // 1) 빠른 클라이언트 사전검증 (서버도 동일하게 재검증) — 즉시 안내 UX 유지
  if (!url) {
    woNotice("작업시트탭URL이 없습니다.\nAE에게 gid가 포함된 탭 주소를 요청한 뒤 다시 접수해주세요.");
    return;
  }
  if (!/[#?&]gid=\d+/.test(url)) {
    woNotice("작업시트탭URL에 gid가 없습니다.\n특정 탭 주소(…/edit#gid=숫자)로 등록되어야 캠페인 탭 관리에 자동 반영됩니다.\n\n현재 URL:\n" + url);
    return;
  }

  const btn = document.getElementById("woAcceptBtn_" + id);
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 접수 처리중...'; }
  try {
    // 2) 접수 단일 처리 (탭 등록 + 작업오더 기본정보 메타 매핑 + 인덱스 빌드 + 상태 reviewing)
    const r = await gasGet({ action: "orderAdminAccept", id }, 60000);
    if (!(r && r.ok)) {
      showToast((r && r.error) || "접수 실패", true);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-inbox"></i> 접수하기'; }
      return;
    }

    // 3) 결과 안내 (신규 등록 vs 기존 탭 연결 = 차수 추가)
    const tabName = r.tabName || "";
    if (r.alreadyRegistered) {
      showToast(`✅ 접수 완료 — 기존 탭에 연결됨: ${tabName} (차수 구분은 시트 기준 자동)`);
    } else {
      showToast(`✅ 접수 완료 — 캠페인 탭 관리에 추가됨: ${tabName}`);
    }
    if (r.indexBuilt === false) {
      showToast("탭은 등록됐지만 인덱스 빌드는 실패했습니다. 잠시 후 자동 갱신됩니다.", true);
    }

    // 4) 인박스 + 캠페인 탭 관리 대시보드 동시 갱신 (업무 연계성)
    loadWorkOrders();
    try { if (typeof loadTabDashboard === "function") loadTabDashboard(); } catch (_) {}
  } catch (e) {
    showToast("오류: " + e.message, true);
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-inbox"></i> 접수하기'; }
  }
}

// 작업오더 삭제 (리뷰웹 인박스 → 인트라넷에서도 삭제)
async function woDelete(id) {
  const o = (_woCache || []).find(x => x.id === id);
  const title = (o && o.title) || id;
  if (!confirm(`작업오더 "${title}" 을(를) 삭제할까요?\n\n인트라넷의 '보낸 오더'에서도 함께 삭제됩니다. (되돌릴 수 없음)`)) return;
  try {
    const r = await gasGet({ action: "orderAdminDelete", id });
    if (r && r.ok) {
      if (r.intranetDeleted) showToast("삭제되었습니다. (인트라넷에도 반영됨)");
      else showToast("삭제됨 · 인트라넷 미전파(" + (r.deliverError || "webhook 미설정") + ")", true);
      loadWorkOrders();
      try { _refreshWorkOrderBadge(false); } catch (_) {}
    } else {
      showToast((r && r.error) || "삭제 실패", true);
    }
  } catch (e) { showToast("오류: " + e.message, true); }
}

// 모집공고생성 — 카톡 URL 등록 확인 후 진행
function woCreateCampaignGuarded(id) {
  const inp = document.getElementById("woChat_" + id);
  const o = (_woCache || []).find(x => x.id === id);
  const url = (((inp && inp.value) || (o && o.chat_room_url) || "")).trim();
  if (!url) { woNotice("카카오톡 팀채팅방 URL를 등록하고 재시도 해주세요."); return; }
  woCreateCampaign(id);
}

// 카톡URL/메모만 저장 (상태 전이 없이)
async function woSaveFields(id) {
  const chat = (document.getElementById("woChat_"+id)||{}).value || "";
  const memo = (document.getElementById("woMemo_"+id)||{}).value || "";
  try {
    const r = await gasGet({ action:"orderAdminUpdate", id, chat_room_url: chat, admin_memo: memo });
    if (r && r.ok) showToast("저장되었습니다.", "success");
    else showToast((r && r.error) || "저장 실패", "error");
  } catch(e) { showToast("오류: " + e.message, "error"); }
}

// 상태 전이 (카톡URL/메모를 함께 반영)
async function woTransition(id, toStatus) {
  const chat = (document.getElementById("woChat_"+id)||{}).value || "";
  const memo = (document.getElementById("woMemo_"+id)||{}).value || "";
  if (toStatus === "published" && !chat.trim()) {
    showToast("카톡 팀채팅방URL을 입력해야 모집공고발행이 가능합니다.", "error");
    document.getElementById("woChat_"+id)?.focus();
    return;
  }
  if ((toStatus === "rejected" || toStatus === "revision") && !memo.trim()) {
    if (!confirm((toStatus==="rejected"?"반려":"보완요청") + " 사유(메모) 없이 진행할까요?")) return;
  }
  try {
    const r = await gasGet({ action:"orderAdminStatus", id, status: toStatus, chat_room_url: chat, admin_memo: memo });
    if (r && r.ok) { showToast(WO_LABELS[toStatus] + "(으)로 변경되었습니다.", "success"); loadWorkOrders(); }
    else showToast((r && r.error) || "상태 변경 실패", "error");
  } catch(e) { showToast("오류: " + e.message, "error"); }
}

// 작업오더 → 모집공고 등록폼 프리필로 열기 (저장 시 자동 역연결)
// work_order 값과 recruit 폼 옵션이 다른 항목은 일치할 때만 채움 (의미 다른 review_fee/채널/담당자는 비움)
const WO_DELIVERY_MAP = { '실배송':'실배송', '빈박스':'빈택배' };
async function woCreateCampaign(id) {
  const o = (_woCache || []).find(x => x.id === id);
  if (!o) { showToast("오더 정보를 찾을 수 없습니다. 새로고침 후 다시 시도하세요.", "error"); return; }
  if (typeof openRecruitModal !== "function") { showToast("모집공고 모듈을 불러오지 못했습니다.", "error"); return; }
  const prefill = {
    title:         o.title || "",
    time_range:    o.purchase_time || "",
    max_slots:     o.recruit_count || 0,
    chat_url:      o.chat_room_url || "",
    delivery_type: WO_DELIVERY_MAP[o.delivery_type] || "",
    product_url:   o.product_url || "",
    notes:         [_INFLOW_LABEL[o.inflow_type] ? ("유입방식: " + _INFLOW_LABEL[o.inflow_type]) : (o.inflow_keyword ? ("유입키워드: " + o.inflow_keyword) : ""), o.review_guide || ""].filter(Boolean).join("\n"),
  };
  switchAdminTab("recruit");
  // recruit 탭의 연결 탭 옵션 로드를 보장한 뒤 모달 오픈 (setTimeout race 제거)
  try { if (typeof loadRecruitTabOptions === "function") await loadRecruitTabOptions(); } catch(_) {}
  try { await openRecruitModal(null, prefill, id); } catch(e) { showToast("모달 열기 실패: " + e.message, "error"); }
}

// 이미 연결된 공고를 수정 모드로 열기
async function woViewCampaign(campId) {
  if (typeof openRecruitModal !== "function") { showToast("모집공고 모듈을 불러오지 못했습니다.", "error"); return; }
  switchAdminTab("recruit");
  // _restoreLinkedTab 이 _recruitTabList 에 의존하므로 옵션 로드를 await
  try { if (typeof loadRecruitTabOptions === "function") await loadRecruitTabOptions(); } catch(_) {}
  try { await openRecruitModal(campId); } catch(e) { showToast("모달 열기 실패: " + e.message, "error"); }
}

// ── 신규 작업 오더 알림 (탭 배지 + 증가 시 토스트/푸시) ──
async function _refreshWorkOrderBadge(notify) {
  if (!isAdminLoggedIn()) return;
  try {
    const r = await gasGet({ action: "orderNewCount" });
    if (!r || r.error || typeof r.count !== "number") return;
    const badge = document.getElementById("workOrderBadge");
    if (badge) { badge.textContent = r.count; badge.style.display = r.count > 0 ? "" : "none"; }
    if (notify && _woLastNewCount !== null && r.count > _woLastNewCount) {
      const inc = r.count - _woLastNewCount;
      if (typeof _sendPushNotif === "function") _sendPushNotif("새 작업 오더", `신규 작업 오더 ${inc}건이 인박스에 도착했습니다.`, "wo-new");
      _showNewOrderPopup(inc);   // ★ 신규요청 팝업
    }
    _woLastNewCount = r.count;
  } catch(_) {}
}

// 신규 작업 오더 도착 팝업 (최신 제출됨 오더 미리보기 + 바로가기)
async function _showNewOrderPopup(count) {
  let items = [];
  try {
    const r = await gasGet({ action: "orderAdminList", status: "submitted" });
    if (r && r.ok && Array.isArray(r.data)) items = r.data.slice(0, 5);
  } catch(_) {}
  const old = document.getElementById("woNewOrderPopup");
  if (old) old.remove();
  const rows = items.map(o => `
    <div style="padding:9px 11px;border:1px solid #E5E7EB;border-radius:9px;margin-bottom:7px;background:#F9FAFB">
      <div style="font-size:.86rem;font-weight:700;color:#111827">${escHtml(o.title || "(제목없음)")}</div>
      <div style="font-size:.72rem;color:#6B7280;margin-top:2px"><i class="fas fa-user"></i> ${escHtml(o.created_by || "-")}
        ${o.purchase_time ? " · " + escHtml(o.purchase_time) : ""}${o.recruit_count ? " · 모집 " + escHtml(String(o.recruit_count)) + "명" : ""}</div>
    </div>`).join("");
  const el = document.createElement("div");
  el.id = "woNewOrderPopup";
  el.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px";
  el.classList.add("toss-overlay");
  el.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:460px;width:100%;padding:22px;box-shadow:0 12px 40px rgba(0,0,0,.25);animation:woPopIn .18s ease">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <span style="font-size:1.4rem">📥</span>
        <span style="font-size:1.05rem;font-weight:800;color:#1b64da">새 작업 오더 ${count}건 도착</span>
      </div>
      <div style="max-height:46vh;overflow-y:auto">${rows || '<div style="color:#9CA3AF;font-size:.85rem">미리보기를 불러오지 못했습니다.</div>'}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick="document.getElementById('woNewOrderPopup').remove()"
          style="padding:9px 16px;border:1.5px solid #D1D5DB;background:#fff;color:#374151;border-radius:9px;font-weight:600;font-size:.85rem;cursor:pointer">닫기</button>
        <button onclick="document.getElementById('woNewOrderPopup').remove();switchAdminTab('work-orders')"
          style="padding:9px 16px;border:none;background:#3182f6;color:#fff;border-radius:9px;font-weight:700;font-size:.85rem;cursor:pointer"><i class="fas fa-clipboard-list"></i> 작업오더 보기</button>
      </div>
    </div>`;
  el.addEventListener("click", e => { if (e.target === el) el.remove(); });
  if (!document.getElementById("woPopInKeyframes")) {
    const st = document.createElement("style");
    st.id = "woPopInKeyframes";
    st.textContent = "@keyframes woPopIn{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}";
    document.head.appendChild(st);
  }
  document.body.appendChild(el);
}
function startWorkOrderBadgePoll() {
  if (_woBadgeTimer) return;
  // 브라우저 푸시 권한 best-effort 요청 (실패해도 토스트는 동작)
  if (typeof _requestNotifPermission === "function") { try { _requestNotifPermission(); } catch(_) {} }
  _refreshWorkOrderBadge(false);   // 즉시 1회 시드 (알림 없음)
  _woBadgeTimer = setInterval(() => _refreshWorkOrderBadge(true), _WO_BADGE_POLL_MS);
}
function stopWorkOrderBadgePoll() {
  if (_woBadgeTimer) { clearInterval(_woBadgeTimer); _woBadgeTimer = null; }
  _woLastNewCount = null;
}

/* ══════════════════════════════════════════════════════════════
   ★ 컨텍스트 툴바 (탭별 버튼)
   ══════════════════════════════════════════════════════════════ */
// 탭별 버튼 정의
const _CTX_TOOLBAR_DEFS = {
  dashboard: [
    { id:'ctx-add',         label:'작업시트추가',  icon:'fa-plus',        style:'green',      onclick:"openAddCampaign()", title:'작업시트 추가'},
    { sep: true },
    { id:'ctx-refresh',     label:'새로고침',  icon:'fa-sync-alt',    style:'',           onclick:"location.reload()", title:'페이지 새로고침 (최신 버전 로드)'},
    { id:'ctx-poll',        label:'완료알림',  icon:'fa-bell',        style:'orange',     onclick:"toggleDashPolling(); _updateContextToolbar('dashboard')", title:'탭 완료 알림 폴링', elId:'pollToggleBtn'},
  ],
  reviewers: [
    { id:'ctx-rev-refresh', label:'새로고침',  icon:'fa-sync-alt',    style:'',           onclick:"loadReviewerList()", title:'리뷰어 목록 새로고침'},
    { id:'ctx-blacklist',   label:'블랙리스트',icon:'fa-ban',         style:'red',        onclick:"openBlPanel()", title:'블랙리스트 관리'},
  ],
  recruit: [
    { id:'ctx-rec-add',     label:'공고추가',  icon:'fa-plus',        style:'green',      onclick:"openRecruitModal(null)", title:'공고 추가'},
    { id:'ctx-rec-notice',  label:'공지설정',  icon:'fa-bullhorn',    style:'yellow',     onclick:"openNoticePanel()", title:'공지 배너 설정'},
    { id:'ctx-rec-preview', label:'미리보기',  icon:'fa-eye',         style:'',           onclick:"window.open('recruit.html','_blank')", title:'모집 페이지 미리보기'},
  ],
  payment: [
    { id:'ctx-pay-refresh', label:'새로고침',  icon:'fa-sync-alt',    style:'',           onclick:"initPaymentPanel()", title:'입금 목록 새로고침'},
  ],
};

const _CTX_STYLE_MAP = {
  '':       'background:#F2F4F6;border-color:#E5E8EB;color:#333D4B',
  'green':  'background:#E6F8F1;border-color:#A6E6CF;color:#0CA678',
  'red':    'background:#FEECEC;border-color:#FAC5C5;color:#E03131',
  'yellow': 'background:#FFF6DE;border-color:#FBDD96;color:#B7791F',
  'orange': 'background:#FFF0E6;border-color:#FFCFAD;color:#E8590C',
  'colvis': 'background:#E8F1FE;border-color:#CCE0FB;color:#1B64DA',
};

function _updateContextToolbar(tabName) {
  const toolbar = document.getElementById("adminContextToolbar");
  if (!toolbar) return;
  const defs = _CTX_TOOLBAR_DEFS[tabName] || [];
  toolbar.innerHTML = '';

  defs.forEach(d => {
    if (d.sep) {
      const sep = document.createElement('span');
      sep.className = 'ctx-sep';
      toolbar.appendChild(sep);
      return;
    }

    const btn = document.createElement('button');
    const styleStr = _CTX_STYLE_MAP[d.style] || _CTX_STYLE_MAP[''];
    btn.id = 'ctx-hdr-' + (d.id || '');
    btn.title = d.title || '';
    btn.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid;border-radius:8px;font-size:.72rem;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;${styleStr}`;
    btn.innerHTML = `<i class="fas ${d.icon}" style="font-size:.7rem"></i>${d.label}`;
    btn.setAttribute('onclick', d.onclick);

    // 원본 버튼의 active 상태 동기화
    if (d.elId) {
      const orig = document.getElementById(d.elId);
      if (orig && orig.classList.contains('active')) {
        btn.style.boxShadow = '0 0 0 2px #3182f6';
        btn.style.borderColor = '#3182f6';
      }
    }

    toolbar.appendChild(btn);
  });
}

// 툴바 버튼 active 상태 동기화 헬퍼
function _syncCtxBtnActive(ctxId, isActive) {
  const btn = document.getElementById(ctxId);
  if (!btn) return;
  if (isActive) {
    btn.style.boxShadow = '0 0 0 2px #3182f6';
    btn.style.borderColor = '#3182f6';
  } else {
    btn.style.boxShadow = '';
    btn.style.borderColor = '';
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ 리뷰어 관리 탭
   ══════════════════════════════════════════════════════════════ */
let _allReviewers = []; // 전체 데이터 캐시

async function loadReviewerList() {
  if (!isAdminLoggedIn()) { showToast("세션이 만료되었습니다.", "warning"); return; }
  const wrap = document.getElementById("reviewerListWrap");
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:30px;text-align:center;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';

  try {
    const data = await gasGet({ action: "getReviewerList" });
    if (!data || data.error) throw new Error(data?.error || "응답 오류");

    _allReviewers = data.reviewers || [];
    _renderReviewerList(_allReviewers);

    // 요약 배지
    const summaryBar  = document.getElementById("reviewerSummaryBar");
    const totalBadge  = document.getElementById("reviewerTotalBadge");
    const recentBadge = document.getElementById("reviewerRecentBadge");
    if (summaryBar) summaryBar.style.display = "flex";
    if (totalBadge) totalBadge.textContent = `전체 ${_allReviewers.length}명`;
    const now = Date.now();
    const recent7 = _allReviewers.filter(r => {
      if (!r.registeredAt) return false;
      const d = new Date(r.registeredAt);
      return (now - d.getTime()) < 7 * 24 * 3600 * 1000;
    }).length;
    if (recentBadge) recentBadge.textContent = `최근 7일 신규 ${recent7}명`;

  } catch(e) {
    wrap.innerHTML = `<div style="padding:20px;text-align:center;color:#DC2626"><i class="fas fa-exclamation-circle"></i> ${escHtml(e.message)}</div>`;
  }
}

function _renderReviewerList(list) {
  const wrap = document.getElementById("reviewerListWrap");
  if (!wrap) return;

  if (!list || list.length === 0) {
    wrap.innerHTML = '<div style="padding:30px;text-align:center;color:var(--t3)"><i class="fas fa-users-slash" style="font-size:1.5rem;margin-bottom:8px;display:block"></i>등록된 리뷰어가 없습니다.</div>';
    return;
  }

  const rows = list.map((r, i) => {
    const name    = escHtml(r.name || "-");
    const phone   = escHtml(r.phone || "-");
    const regAt   = escHtml(r.registeredAt || "-");
    const consent = r.consent ? '<span style="color:#0ca678;font-weight:700">동의</span>' : '<span style="color:#9CA3AF">-</span>';
    const incomeName = escHtml(r.incomeType || "");
    const residentNum = r.residentNum ? (() => {
      const jd = (r.residentNum || "").replace(/[^0-9]/g, "");
      if (jd.length === 13) return jd.slice(0,6) + "-" + jd.slice(6,7) + "••••••";
      return "등록됨";
    })() : "";
    // 타계정 정보 파싱
    let subAccountsHtml = '<span style="opacity:.4;font-size:.72rem">없음</span>';
    try {
      const subs = typeof r.subAccounts === 'string' ? JSON.parse(r.subAccounts || '[]') : (r.subAccounts || []);
      if (Array.isArray(subs) && subs.length > 0) {
        subAccountsHtml = subs.map(s => {
          const sName = escHtml(s.name || '?');
          const sPhone = (s.phone || '').replace(/[^0-9]/g,'');
          const sPhoneFmt = sPhone.length === 11 ? sPhone.slice(0,3)+'-'+sPhone.slice(3,7)+'-'+sPhone.slice(7) : sPhone;
          return `<div style="margin-bottom:2px"><span style="font-weight:600">${sName}</span> <span style="color:var(--t3);font-family:monospace;font-size:.72rem">${escHtml(sPhoneFmt)}</span></div>`;
        }).join('');
      }
    } catch(_){}
    const memo    = escHtml(r.memo || "");
    const rowBg   = i % 2 === 0 ? "#fff" : "#F9FAFB";
    const nameSafe  = (r.name  || "").replace(/'/g, "\\'");
    const phoneSafe = (r.phone || "").replace(/'/g, "\\'");
    return `<tr style="background:${rowBg};border-bottom:1px solid #F3F4F6">
      <td style="padding:9px 12px;font-size:.82rem;color:var(--t3);text-align:center">${i+1}</td>
      <td style="padding:9px 12px;font-size:.88rem;font-weight:600;color:var(--t1)">${name}</td>
      <td style="padding:9px 12px;font-size:.85rem;color:var(--t2);font-family:monospace">${phone}</td>
      <td style="padding:9px 12px;font-size:.78rem;color:var(--t3)">${regAt}</td>
      <td style="padding:9px 12px;font-size:.8rem;text-align:center">${consent}</td>
      <td style="padding:9px 12px;font-size:.78rem;color:${incomeName ? 'var(--t2)' : '#DC2626'}">${incomeName || '<span style="opacity:.5">미등록</span>'}</td>
      <td style="padding:9px 12px;font-size:.78rem;color:${residentNum ? 'var(--t2)' : '#DC2626'};font-family:monospace">${residentNum || '<span style="opacity:.5">미등록</span>'}</td>
      <td style="padding:9px 8px;font-size:.75rem;color:var(--t2);min-width:120px">${subAccountsHtml}</td>
      <td style="padding:9px 12px;font-size:.78rem;color:var(--t3)">${memo}</td>
      <td style="padding:9px 12px;text-align:center">
        <button onclick="_deleteReviewer('${nameSafe}','${phoneSafe}')"
          style="padding:3px 10px;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer">
          <i class="fas fa-trash-alt"></i> 삭제
        </button>
      </td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#f2f7ff;border-bottom:2px solid #cce0fb">
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:center;white-space:nowrap">#</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">이름</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">전화번호</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">등록일시</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:center;white-space:nowrap">동의</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">소득명의</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">주민번호</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">타계정</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:left;white-space:nowrap">비고</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#1b64da;font-weight:700;text-align:center;white-space:nowrap">관리</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function _filterReviewerList(keyword) {
  if (!keyword) { _renderReviewerList(_allReviewers); return; }
  const kw = keyword.trim().toLowerCase();
  const filtered = _allReviewers.filter(r =>
    (r.name  || "").toLowerCase().includes(kw) ||
    (r.phone || "").replace(/-/g,"").includes(kw)
  );
  _renderReviewerList(filtered);
  const totalBadge = document.getElementById("reviewerTotalBadge");
  if (totalBadge) totalBadge.textContent = `검색결과 ${filtered.length}명 / 전체 ${_allReviewers.length}명`;
}

async function _deleteReviewer(name, phone) {
  if (!confirm(`'${name}' (${phone}) 님을 삭제하시겠습니까?\n삭제 후 해당 리뷰어는 로그인할 수 없습니다.`)) return;
  try {
    let data;
    try {
      data = await gasPost({ action: "deleteReviewer", name, phone });
    } catch(_) {
      data = await gasGet({ action: "deleteReviewer", name, phone });
    }
    if (data && data.error) throw new Error(data.error);
    showToast(`${name}님이 삭제되었습니다.`, "success");
    loadReviewerList();
  } catch(e) {
    showToast("삭제 오류: " + e.message, "error");
  }
}

/* ── 제출+입금 모두 100% 완료 탭 감지 → 팝업 알림 ── */
function _checkAllCompleteTabs(stats) {
  const sessionKey = "rapp_allcomplete_alert_shown";
  if (sessionStorage.getItem(sessionKey)) return;

  const completeTabs = [];
  (stats || []).forEach(c => {
    (c.tabs || []).forEach(t => {
      const tabKey = (t.sheetId || "") + "||" + (t.tab || "");
      const isClosed = _closedSet.has(tabKey);
      if (isClosed) return;
      const isTabDone = (t.total > 0 && t.pending === 0);
      const isPaidDone = (t.paidCount !== undefined && t.rowCount > 0 && t.paidCount >= t.rowCount);
      if (isTabDone && isPaidDone) {
        completeTabs.push({ campaign: c.campaign, tab: t.tab });
      }
    });
  });

  if (completeTabs.length > 0) {
    sessionStorage.setItem(sessionKey, "1");
    setTimeout(() => _showAllCompleteModal(completeTabs), 500);
  }
}

/* ── 제출+입금 100% 완료 탭 팝업 (탭관리 대시보드용) ── */
function _checkAllCompleteTabsFromTabDash(tabs) {
  const sessionKey = "rapp_allcomplete_alert_shown";
  if (sessionStorage.getItem(sessionKey)) return;

  const completeTabs = [];
  (tabs || []).forEach(t => {
    if (t.is_closed) return;
    const rc = t.row_count || 0;
    const sc = t.submitted_count || 0;
    const pc = t.paid_count || 0;
    if (rc > 0 && sc >= rc && pc >= rc) {
      completeTabs.push({ campaign: t.campaign_name, tab: t.tab_name });
    }
  });

  if (completeTabs.length > 0) {
    sessionStorage.setItem(sessionKey, "1");
    setTimeout(() => _showAllCompleteModal(completeTabs), 500);
  }
}

function _showAllCompleteModal(completeTabs) {
  let modal = document.getElementById('allCompleteAlertModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'allCompleteAlertModal';

  const listHtml = completeTabs.map(x =>
    `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#FFF7ED;border-radius:6px;margin-bottom:4px">
      <i class="fas fa-check-circle" style="color:#0ca678;font-size:.8rem"></i>
      <span style="font-size:.78rem;color:#1F2937"><b>${escHtml(x.campaign)}</b> / ${escHtml(x.tab)}</span>
    </div>`
  ).join('');

  modal.innerHTML = `
    <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s" onclick="if(event.target===this)this.remove()">
      <div style="background:#fff;border-radius:16px;padding:28px 24px;width:92%;max-width:480px;max-height:80vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,.25);border-top:4px solid #EC4899">
        <div style="text-align:center;margin-bottom:16px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#FDF2F8,#FCE7F3);display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
            <i class="fas fa-flag-checkered" style="font-size:1.5rem;color:#EC4899"></i>
          </div>
          <h3 style="margin:0;font-size:1.05rem;color:#1F2937;font-weight:700">리뷰 & 입금 완료 알림</h3>
        </div>
        <div style="background:#FFF0F5;border:1px solid #FBCFE8;border-radius:10px;padding:14px 16px;margin-bottom:16px">
          <p style="margin:0 0 4px;font-size:.82rem;color:#9D174D;font-weight:600;line-height:1.5">
            리뷰와 입금이 모두 완료된 탭이 존재합니다.
          </p>
          <p style="margin:0;font-size:.75rem;color:#6B7280;line-height:1.5">
            마감자료를 확인하시어 전달하신 후<br>탭을 체크하여 <b>마감</b>으로 넘겨주세요.
          </p>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:.72rem;color:#6B7280;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">
            <i class="fas fa-list-check" style="margin-right:4px"></i>완료 탭 목록 (${completeTabs.length}건)
          </div>
          <div style="max-height:200px;overflow-y:auto;padding-right:4px">
            ${listHtml}
          </div>
        </div>
        <div style="text-align:center">
          <button onclick="document.getElementById('allCompleteAlertModal').remove()" style="padding:10px 32px;background:linear-gradient(135deg,#EC4899,#DB2777);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(236,72,153,.3);transition:transform .1s" onmousedown="this.style.transform='scale(.96)'" onmouseup="this.style.transform='scale(1)'">
            <i class="fas fa-check" style="margin-right:6px"></i>확인
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

/* ── 미제출자 명단 팝업 ── */
async function _showPendingReviewersPopup(sheetId, tabName, rc, sc, round) {
  const pending = rc - sc;
  // 모달 생성
  const modalId = 'pendingReviewersModal';
  let modal = document.getElementById(modalId);
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = modalId;
  modal.innerHTML = `
    <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s" onclick="if(event.target===this)this.remove()">
      <div style="background:#fff;border-radius:16px;padding:28px 24px;width:92%;max-width:480px;max-height:80vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,.25);border-top:4px solid #F59E0B">
        <div style="text-align:center;margin-bottom:16px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#FEF3C7,#FDE68A);display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
            <i class="fas fa-user-clock" style="font-size:1.5rem;color:#D97706"></i>
          </div>
          <h3 style="margin:0;font-size:1.05rem;color:#1F2937;font-weight:700">리뷰 미제출자 명단</h3>
        </div>
        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:14px 16px;margin-bottom:16px">
          <p style="margin:0 0 4px;font-size:.82rem;color:#92400E;font-weight:600;line-height:1.5">
            ${escHtml(tabName)}${round ? ' <span style="background:#3182f6;color:#fff;padding:1px 7px;border-radius:4px;font-size:.7rem;margin-left:6px">' + escHtml(round) + '</span>' : ''}
          </p>
          <p style="margin:0;font-size:.75rem;color:#6B7280;line-height:1.5">
            제출 현황: <b>${sc}/${rc}</b> (미제출 ${pending}명)
          </p>
        </div>
        <div id="pendingReviewersList" style="margin-bottom:16px">
          <div style="text-align:center;padding:20px;color:#9CA3AF">
            <i class="fas fa-spinner fa-spin"></i> 미제출자 조회 중...
          </div>
        </div>
        <div style="text-align:center">
          <button onclick="document.getElementById('${modalId}').remove()" style="padding:10px 32px;background:linear-gradient(135deg,#F59E0B,#D97706);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(245,158,11,.3)">
            <i class="fas fa-check" style="margin-right:6px"></i>확인
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // API 호출
  try {
    const params = { action: 'getPendingRows', sheetId, tabName };
    if (round) params.round = round;
    const resp = await gasGet(params);
    const listEl = document.getElementById('pendingReviewersList');
    if (!resp || !resp.ok) {
      listEl.innerHTML = `<div style="text-align:center;padding:12px;color:#DC2626;font-size:.8rem"><i class="fas fa-exclamation-circle"></i> 조회 실패: ${escHtml((resp && resp.error) || '서버 오류')}</div>`;
      return;
    }
    const rows = resp.pendingRows || [];
    if (rows.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;padding:12px;color:#0ca678;font-size:.8rem"><i class="fas fa-check-circle"></i> 미제출자가 없습니다. (DB 동기화 지연일 수 있음)</div>`;
      return;
    }
    const listHtml = rows.map((r, i) => `
      <div style="display:flex;align-items:center;padding:10px 12px;background:${i%2===0?'#FFF':'#FEFCE8'};border-radius:8px;margin-bottom:4px;border:1px solid #FEF3C7">
        <div style="width:28px;height:28px;border-radius:50%;background:#FDE68A;display:flex;align-items:center;justify-content:center;margin-right:10px;flex-shrink:0">
          <span style="font-size:.7rem;font-weight:700;color:#92400E">${r.row_index}</span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.82rem;font-weight:600;color:#1F2937">${escHtml(r.reviewer_name || '(이름없음)')}</div>
          <div style="font-size:.68rem;color:#6B7280">${r.row_index}행 · ${escHtml(r.submit_col || '제출컬럼')} 미입력</div>
        </div>
        <div style="flex-shrink:0">
          <span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:6px;font-size:.65rem;font-weight:600">미제출</span>
        </div>
      </div>
    `).join('');
    listEl.innerHTML = `
      <div style="font-size:.72rem;color:#6B7280;font-weight:600;margin-bottom:6px;letter-spacing:.5px">
        <i class="fas fa-user-xmark" style="margin-right:4px"></i>미제출자 목록 (${rows.length}명)
      </div>
      <div style="max-height:240px;overflow-y:auto;padding-right:4px">${listHtml}</div>`;
  } catch (e) {
    const listEl = document.getElementById('pendingReviewersList');
    if (listEl) listEl.innerHTML = `<div style="text-align:center;padding:12px;color:#DC2626;font-size:.8rem"><i class="fas fa-exclamation-circle"></i> ${escHtml(e.message || '네트워크 오류')}</div>`;
  }
}

/* ── 미입금자 명단 팝업 ── */
function _goToSheetForPayment(sheetId, tabName) {
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t || !t.sheet_url) { showToast('시트링크가 등록되지 않았습니다.', 'error'); return; }
  const url = t.tab_gid ? t.sheet_url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : t.sheet_url;
  window.open(url, '_blank');
}
async function _showUnpaidReviewersPopup(sheetId, tabName, rc, pc, round) {
  const unpaid = rc - pc;
  const modalId = 'unpaidReviewersModal';
  let modal = document.getElementById(modalId);
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = modalId;
  const roundInfo = round ? ` (${escHtml(round)})` : '';
  modal.innerHTML = `
    <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s" onclick="if(event.target===this)this.remove()">
      <div style="background:#fff;border-radius:16px;padding:28px 24px;width:92%;max-width:480px;max-height:80vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,.25);border-top:4px solid #3B82F6">
        <div style="text-align:center;margin-bottom:16px">
          <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#DBEAFE,#BFDBFE);display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
            <i class="fas fa-money-bill-wave" style="font-size:1.5rem;color:#1D4ED8"></i>
          </div>
          <h3 style="margin:0;font-size:1.05rem;color:#1F2937;font-weight:700">미입금자 명단</h3>
        </div>
        <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:10px;padding:14px 16px;margin-bottom:16px">
          <p style="margin:0 0 4px;font-size:.82rem;color:#1E40AF;font-weight:600;line-height:1.5">
            ${escHtml(tabName)}${roundInfo}
          </p>
          <p style="margin:0;font-size:.75rem;color:#6B7280;line-height:1.5">
            입금 현황: <b>${pc}/${rc}</b> (미입금 ${unpaid}명)
          </p>
        </div>
        <div id="unpaidReviewersList" style="margin-bottom:16px">
          <div style="text-align:center;padding:20px;color:#9CA3AF">
            <i class="fas fa-spinner fa-spin"></i> 미입금자 조회 중...
          </div>
        </div>
        <div style="text-align:center;display:flex;gap:10px;justify-content:center">
          <button onclick="document.getElementById('${modalId}').remove()" style="padding:10px 32px;background:linear-gradient(135deg,#3B82F6,#1D4ED8);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(59,130,246,.3)">
            <i class="fas fa-check" style="margin-right:6px"></i>확인
          </button>
          <button onclick="_goToSheetForPayment('${escHtml(sheetId)}','${escHtml(tabName)}')" style="padding:10px 20px;background:linear-gradient(135deg,#0ca678,#047857);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(5,150,105,.3)">
            <i class="fas fa-external-link-alt" style="margin-right:6px"></i>입금처리 하러가기
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // API 호출
  try {
    const params = { action: 'getUnpaidRows', sheetId, tabName };
    if (round) params.round = round;
    const resp = await gasGet(params);
    const listEl = document.getElementById('unpaidReviewersList');
    if (!resp || !resp.ok) {
      listEl.innerHTML = `<div style="text-align:center;padding:12px;color:#DC2626;font-size:.8rem"><i class="fas fa-exclamation-circle"></i> 조회 실패: ${escHtml((resp && resp.error) || '서버 오류')}</div>`;
      return;
    }
    const rows = resp.unpaidRows || [];
    if (rows.length === 0) {
      listEl.innerHTML = `<div style="text-align:center;padding:12px;color:#0ca678;font-size:.8rem"><i class="fas fa-check-circle"></i> 미입금자가 없습니다. (DB 동기화 지연일 수 있음)</div>`;
      return;
    }
    const listHtml = rows.map((r, i) => `
      <div style="display:flex;align-items:center;padding:10px 12px;background:${i%2===0?'#FFF':'#EFF6FF'};border-radius:8px;margin-bottom:4px;border:1px solid #DBEAFE">
        <div style="width:28px;height:28px;border-radius:50%;background:#BFDBFE;display:flex;align-items:center;justify-content:center;margin-right:10px;flex-shrink:0">
          <span style="font-size:.7rem;font-weight:700;color:#1E40AF">${r.row_index}</span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.82rem;font-weight:600;color:#1F2937">${escHtml(r.reviewer_name || '(이름없음)')}</div>
          <div style="font-size:.68rem;color:#6B7280">${r.row_index}행${r.round ? ' · ' + escHtml(r.round) : ''}</div>
        </div>
        <div style="flex-shrink:0">
          <span style="background:#DBEAFE;color:#1E40AF;padding:2px 8px;border-radius:6px;font-size:.65rem;font-weight:600">미입금</span>
        </div>
      </div>
    `).join('');
    listEl.innerHTML = `
      <div style="font-size:.72rem;color:#6B7280;font-weight:600;margin-bottom:6px;letter-spacing:.5px">
        <i class="fas fa-money-bill-wave" style="margin-right:4px"></i>미입금자 목록 (${rows.length}명)
      </div>
      <div style="max-height:240px;overflow-y:auto;padding-right:4px">${listHtml}</div>`;
  } catch (e) {
    const listEl = document.getElementById('unpaidReviewersList');
    if (listEl) listEl.innerHTML = `<div style="text-align:center;padding:12px;color:#DC2626;font-size:.8rem"><i class="fas fa-exclamation-circle"></i> ${escHtml(e.message || '네트워크 오류')}</div>`;
  }
}

/* ── 제출 현황 대시보드 ── */
async function loadAdminDashboard() {
  // ★ v11.5: 캠페인 탭 관리 UI로 통합 — 대시보드 메인은 loadTabDashboard()가 담당
  try { await loadTabDashboard(); } catch(_){}
  try { loadDashWorkOrders(); } catch(_){}

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

    // ★ 디버그: roundList 수신 현황 로깅
    let _dbgRoundTabs = 0;
    stats.forEach(c => (c.tabs||[]).forEach(t => {
      if (t.roundList && t.roundList.length > 0) {
        _dbgRoundTabs++;
        console.log(`[DEBUG-ROUND] ${c.campaign}/${t.tab}: roundList=${JSON.stringify(t.roundList.map(r=>r.round))}, closedRounds="${t.closedRounds||''}"`);}
    }));
    console.log(`[DEBUG-ROUND] 총 ${stats.length}개 캠페인, roundList 보유 탭: ${_dbgRoundTabs}개`);

    _closedSet    = new Set();
    _closedRoundSet = new Set(); // ★ 차수 단위 마감 Set
    stats.forEach(c => {
      (c.tabs || []).forEach(t => {
        if (t.isClosed) {
          const key = (t.sheetId || "") + "||" + (t.tab || "");
          _closedSet.add(key);
        }
        // ★ 차수별 마감: closedRounds "1차,2차" → Set에 "sheetId||tabName||1차" 추가
        if (t.closedRounds) {
          const rounds = t.closedRounds.split(',').map(s => s.trim()).filter(Boolean);
          rounds.forEach(rd => {
            _closedRoundSet.add((t.sheetId || "") + "||" + (t.tab || "") + "||" + rd);
          });
        }
      });
    });
    // ★ 마감탭 Set (인덱스에서 제외된 항목도 포함)
    (data.closedTabs || []).forEach(t => {
      const key = (t.sheetId || "") + "||" + (t.tab || "");
      _closedSet.add(key);
    });

    if (data.indexBuiltAt) {
      document.getElementById("dashboardIndexInfo").textContent = "동기화 기준: " + data.indexBuiltAt;
    }

    // ★ 자동 빌드 카운트다운 + 빌드 진행 중 배너
    _startCronCountdown(data.cron, data.buildLock);

    // ★ Phase 4: 비동기 dirty check (대시보드 로딩 차단 없음)
    _asyncDirtyCheck();

    // ★ Phase 5: 라이브 모드 토글 초기화
    _initLiveMode();

    const rate = _pct(grand.submitted, grand.total);
    document.getElementById("sumTotal").textContent   = grand.total.toLocaleString();
    document.getElementById("sumDone").textContent    = grand.submitted.toLocaleString();
    document.getElementById("sumPending").textContent = grand.pending.toLocaleString();
    document.getElementById("sumRate").textContent    = rate + "%";
    show("dashboardSummary");

    // Phase 14: 인식 실패 탭 배지 업데이트
    _updateUnrecogBadge();

    // 이상로그 미해결 배지 업데이트
    try { _updateErrorLogBadge(); } catch (_) {}

    // ★ Phase 12: 마감 대상 배지 업데이트 (대시보드에서 알림)
    _updateArchiveBadge();

    // ★ Phase 15: 제출+입금 모두 100% 완료 탭 감지 → 팝업 알림
    _checkAllCompleteTabs(stats);

    if (!stats.length) {
      wrap.innerHTML = '<div class="admin-empty"><i class="fas fa-inbox"></i><p>데이터가 없습니다</p></div>';
      return;
    }

    wrap.innerHTML = "";
    wrap.classList.add('has-dev-label');

    // 대시보드 래퍼 라벨 추가
    const wrapLabel = document.createElement('span');
    wrapLabel.className = 'dev-label';
    wrapLabel.textContent = '대시보드 래퍼 / Dashboard Wrapper';
    wrap.appendChild(wrapLabel);

    // ── 컬럼 헤더: wrap 직속 (scrollOuter 밖) → sticky 정상 동작 ──
    const colHeader = document.createElement("div");
    colHeader.id = "dashColHeader";
    colHeader.className = "dash-col-header has-dev-label";
    _buildColHeader(colHeader);
    
    // 컬럼 헤더 라벨 추가
    const headerLabel = document.createElement('span');
    headerLabel.className = 'dev-label';
    headerLabel.textContent = '컬럼 헤더 / Column Header';
    colHeader.appendChild(headerLabel);
    
    wrap.appendChild(colHeader);

    // ── ★ v11.0: 엑셀형 플랫 테이블 (캠페인 블록 제거, 모든 탭을 한 줄씩) ──
    const scrollOuter1 = document.createElement("div");
    scrollOuter1.id = "dashboardScrollOuter";
    const flatTable = document.createElement("div");
    flatTable.id = "dashboardScrollInner";
    flatTable.className = "dash-flat-table";
    scrollOuter1.appendChild(flatTable);
    wrap.appendChild(scrollOuter1);

    let _prevCampaign = null;
    let _campColorIdx = 0;
    let _isFirstRowOfCamp = false;

    stats.forEach((c, ci) => {
      const campName = c.campaign || "";
      const campSheetId = (c.tabs[0] && c.tabs[0].sheetId) ? c.tabs[0].sheetId : "";
      // 캠페인 전환 시 컬러 인덱스 증가
      if (campName !== _prevCampaign) {
        _campColorIdx++;
        _prevCampaign = campName;
        _isFirstRowOfCamp = true;
      }
      const campStripe = _campColorIdx % 2 === 0 ? "camp-stripe-even" : "camp-stripe-odd";

      // 마감업체 판정 (기존 로직 유지)
      const isCampDone = c.closedOnly === true || (c.tabs.length > 0 && c.tabs.every(t => {
        const key = (t.sheetId||"")+"||"+(t.tab||"");
        return _closedSet.has(key) || (t.total > 0 && t.pending === 0);
      }));
      const hasClosed = c.closedOnly === true || c.tabs.some(t => _closedSet.has((t.sheetId||"")+"||"+(t.tab||"")));

      c.tabs.forEach(t => {
        const tRate     = _pct(t.submitted, t.total);
        const tabKey    = (t.sheetId || "") + "||" + (t.tab || "");
        const isClosedTab = _closedSet.has(tabKey);
        const isTabDone = (t.total > 0 && t.pending === 0);
        const isPaidDone2 = (t.paidCount !== undefined && t.rowCount > 0 && t.paidCount >= t.rowCount);
        const isAllComplete2 = isTabDone && isPaidDone2 && !isClosedTab;
        const _ovDays2 = (!isTabDone && !isClosedTab) ? _calcOverdueDays(t.startDate) : null;
        const isOverdue2 = _ovDays2 !== null && _ovDays2 >= 25;

        // ── 공통 행 속성 세팅 헬퍼 ──
        function _setupRow(el, tk, extra) {
          el.className = "dash-tab-row " + campStripe
            + (_isFirstRowOfCamp ? " camp-first-row" : "")
            + (isTabDone ? " tab-done" : "")
            + (isClosedTab ? " is-closed-row" : "")
            + (extra || "");
          _isFirstRowOfCamp = false; // 첫 행 마킹 후 리셋
          el.dataset.tabkey = tk;
          el.dataset.campname = campName.toLowerCase();
          el.dataset.campSheetId = campSheetId;
          el.dataset.sortCampaign = campName.toLowerCase();
          el.dataset.sortTabname  = (t.tab || "").toLowerCase();
          el.dataset.sortProduct  = (t.displayName || "").toLowerCase();
          el.dataset.sortTime     = (t.timeRange || "").toLowerCase();
          el.dataset.sortReview   = (t.reviewType || "").toLowerCase();
          el.dataset.sortManager  = (t.manager || "").toLowerCase();
          el.dataset.sortPayment  = (t.paymentType || "").toLowerCase();
          el.dataset.sortIncome   = (t.incomeType || "").toLowerCase();
          el.dataset.sortDepositname = (t.depositName || "").toLowerCase();
          el.dataset.sortBank     = (t.transferBank || "").toLowerCase();
          el.dataset.sortTaekhap  = t.taekhap ? "1" : "0";
          if (isCampDone)  el.classList.add("camp-all-done");
          if (hasClosed)   el.classList.add("camp-has-closed");
          el.setAttribute('oncontextmenu', `_openAdminContextMenu(event,'${escHtml(tk)}')`);
        }

        const row = document.createElement("div");
        _setupRow(row, tabKey,
          (isOverdue2 ? " urgent-overdue" : "")
          + (!t.displayName && !isClosedTab ? " no-product-warn" : "")
          + (isAllComplete2 ? " all-complete-row" : ""));
        row.dataset.sortBar = tRate;
        row.dataset.sortNums = (t.submitted || 0);

        const _overdueBadge2 = isOverdue2
          ? `<span class="badge-overdue"><i class="fas fa-fire" style="font-size:.55rem"></i> D+${_ovDays2}</span>`
          : "";
        const _tabSheetUrl2 = _buildTabUrl(t.sheetUrl, t.sheetId, t.tabGid);
        const tabNameHtml = _tabSheetUrl2
          ? `<a class="dash-tab-link" href="${escHtml(_tabSheetUrl2)}" target="_blank" title="${escHtml(_tabSheetUrl2)}">${escHtml(t.tab)} <i class="fas fa-external-link-alt dash-tab-ext"></i></a>${_overdueBadge2}`
          : `<span>${escHtml(t.tab)}</span>${_overdueBadge2}`;

        const _manualSD = _getManualStartDate(tabKey);
        const _effectiveSD = _manualSD || t.startDate || "";
        row.dataset.sortDate = _effectiveSD || "9999";
        const startDateHtml = _effectiveSD
          ? `<span class="tab-start-date${_manualSD ? ' manual-date' : ''}" data-tabkey="${escHtml(tabKey)}" data-rawsd="${escHtml(t.startDate||'')}" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="클릭하여 시작일 수정${_manualSD ? ' (수동 수정됨)' : ''}"><i class="fas fa-calendar-day"></i> ${escHtml(_effectiveSD)}</span>`
          : `<span class="tab-date-empty" data-tabkey="${escHtml(tabKey)}" data-rawsd="" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="시작일 클릭하여 입력"><i class="fas fa-calendar-plus"></i> 날짜</span>`;

        const _cachedEndDate = localStorage.getItem("rapp_enddate_" + tabKey) || t.endDate || "";
        const endDateHtml = _buildEndDateHtml(tabKey, _cachedEndDate, isTabDone, isClosedTab);
        row.dataset.sortEnddate = (() => {
          const dv = _calcDdayFromEndDate(_cachedEndDate);
          return dv !== null ? dv : 9999;
        })();

        const tuip = t.tuip || 0, chuihap = t.chuihap || 0;
        const total = t.total || 0;
        let stateHtml = "";
        if (isClosedTab) {
          stateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
        } else if (isTabDone) {
          stateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
        } else if (tuip > 0 || chuihap > 0) {
          const leftHtml  = tuip    > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${tuip}/${total}</span>` : `<span class="bar-lbl-left"></span>`;
          const rightHtml = chuihap > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${chuihap}/${total}</span>` : `<span class="bar-lbl-right"></span>`;
          stateHtml = leftHtml + rightHtml;
        }

        const tcData = { sheetId: t.sheetId, sheetUrl: t.sheetUrl || "", tabName: t.tab,
          manager: t.manager||"", timeRange: t.timeRange||"",
          taekhap: t.taekhap||false, reviewType: t.reviewType||"",
          paymentType: t.paymentType||"", displayName: t.displayName||"",
          deliveryType: t.deliveryType||"", folderUrl: t.folderUrl||"",
          captureFolderUrl: t.captureFolderUrl||"",
          isBulk: t.isBulk||false,
          tcRound: t.tcRound || t.round || "",
          incomeType: t.incomeType||"",
          providerMemo: t.providerMemo || t.provider_memo || "",
          depositName: t.depositName||"", transferBank: t.transferBank||"",
          _isClosed: isClosedTab };
        const tcAttr = escHtml(JSON.stringify(tcData));

        if (t.roundList && t.roundList.length >= 1) {
          t.roundList.forEach(rd => {
            const rdRow = document.createElement("div");
            const rdDone = (rd.total > 0 && rd.pending === 0);
            const rdTabKey2 = tabKey + "||" + (rd.round || "");
            // ★ 차수별 마감 판정: 탭 전체 마감 OR 해당 차수가 closedRoundSet에 있음
            const isRoundClosed = isClosedTab || _closedRoundSet.has(rdTabKey2);
            const rdPaidDone2 = (rd.paidCount !== undefined && rd.total > 0 && rd.paidCount >= rd.total);
            const rdAllComplete2 = rdDone && rdPaidDone2 && !isRoundClosed;
            const rdStartDateRaw2 = rd.startDate || t.startDate || "";
            const _rdManualSD2 = _getManualStartDate(rdTabKey2) || _getManualStartDate(tabKey + "||" + (rd.round || "").replace(/.*/, ""));
            const _rdEffectiveSD2 = _rdManualSD2 || rdStartDateRaw2;
            const _rdOvDays2 = (!rdDone && !isRoundClosed) ? _calcOverdueDays(_rdEffectiveSD2) : null;
            const rdIsOverdue2 = _rdOvDays2 !== null && _rdOvDays2 >= 25;
            _setupRow(rdRow, rdTabKey2, (rdDone ? " tab-done" : "") + (isRoundClosed ? " is-closed-row" : "") + (rdIsOverdue2 ? " urgent-overdue" : "") + (rdAllComplete2 ? " all-complete-row" : ""));
            rdRow.dataset.sortDate = _rdEffectiveSD2 || "9999";
            rdRow.dataset.sortTaekhap = t.taekhap ? "1" : "0";
            rdRow.dataset.sortEnddate = 9999;
            const rdRate = _pct(rd.submitted, rd.total);
            rdRow.dataset.sortBar  = rdRate;
            rdRow.dataset.sortNums = (rd.submitted || 0);
            const rdStartDateHtml = _rdEffectiveSD2
              ? `<span class="tab-start-date${_rdManualSD2 ? ' manual-date' : ''}" data-tabkey="${escHtml(rdTabKey2)}" data-rawsd="${escHtml(rdStartDateRaw2)}" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="클릭하여 시작일 수정"><i class="fas fa-calendar-day"></i> ${escHtml(_rdEffectiveSD2)}</span>`
              : `<span class="tab-date-empty" data-tabkey="${escHtml(rdTabKey2)}" data-rawsd="" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="시작일 입력"><i class="fas fa-calendar-plus"></i> 날짜</span>`;
            const _rdOverdueBadge2 = rdIsOverdue2
              ? `<span class="badge-overdue"><i class="fas fa-fire" style="font-size:.55rem"></i> D+${_rdOvDays2}</span>` : "";
            const _rdTabSheetUrl2 = _buildTabUrl(t.sheetUrl, t.sheetId, t.tabGid);
            const rdTabNameHtml2 = _rdTabSheetUrl2
              ? `<a class="dash-tab-link" href="${escHtml(_rdTabSheetUrl2)}" target="_blank" title="${escHtml(_rdTabSheetUrl2)}">${escHtml(t.tab)} <i class="fas fa-external-link-alt dash-tab-ext"></i></a>${_rdOverdueBadge2}`
              : `<span>${escHtml(t.tab)}</span>${_rdOverdueBadge2}`;
            let rdStateHtml = "";
            if (isRoundClosed)    rdStateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
            else if (rdDone)      rdStateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
            else if ((rd.tuip||0) > 0 || (rd.chuihap||0) > 0) {
              const rdTotal = rd.total || 0;
              const rdLeftHtml  = (rd.tuip||0) > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${rd.tuip}/${rdTotal}</span>` : `<span class="bar-lbl-left"></span>`;
              const rdRightHtml = (rd.chuihap||0) > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${rd.chuihap}/${rdTotal}</span>` : `<span class="bar-lbl-right"></span>`;
              rdStateHtml = rdLeftHtml + rdRightHtml;
            }
            const tRd = Object.assign({}, t, { submitted: rd.submitted, total: rd.total, pending: rd.pending, noRecipient: t.noRecipient, tuip: rd.tuip||0, chuihap: rd.chuihap||0 });
            const rdTcData2 = Object.assign({}, JSON.parse(tcAttr.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')), { tcRound: rd.round || "" });
            const rdTcAttr2 = escHtml(JSON.stringify(rdTcData2));
            rdRow.dataset.state = _rowState(isRoundClosed, rdDone, rd.tuip||0, rd.chuihap||0);
            rdRow.innerHTML = _buildTabRowHtml(tRd, rdTabKey2, false, isRoundClosed, rdTabNameHtml2, rdStartDateHtml, rdRate, rdStateHtml, rdTcAttr2, rd.round, null, campName);
            flatTable.appendChild(rdRow);
          });
        } else {
          row.dataset.state = _rowState(isClosedTab, isTabDone, tuip, chuihap);
          row.innerHTML = _buildTabRowHtml(t, tabKey, false, isClosedTab, tabNameHtml, startDateHtml, tRate, stateHtml, tcAttr, null, endDateHtml, campName);
          flatTable.appendChild(row);
        }

        // 한달리뷰 행
        if (t.hasMonthly) {
          const tRate2     = _pct(t.submitted2, t.total2);
          const isTab2Done = t.total2 > 0 && t.pending2 === 0;
          const row2       = document.createElement("div");
          row2.className   = "dash-tab-row dash-tab-row-monthly " + campStripe + (isTab2Done ? " tab-done" : "");
          row2.innerHTML   = `
            <div class="closed-cb-wrap"></div>
            <div class="dash-tab-campaign"></div>
            <div class="dash-tab-name dash-tab-name-monthly"><i class="fas fa-calendar-alt"></i> 한달리뷰</div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div class="dash-tab-date-col"></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div class="dash-tab-bar-col">
              ${(t.noRecipient || t.total2 === 0)
                ? `<span class="bar-no-recipient"><i class="fas fa-exclamation-triangle"></i>수취인헤더없음</span>`
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
            <div></div>
            <div></div>
            <div></div>
            <div></div>`;
          flatTable.appendChild(row2);
        }
      });
    });

    if (hideClosedCampMode) wrap.classList.add("hide-closed-camp-mode");
    else                    wrap.classList.remove("hide-closed-camp-mode");
    if (hideClosedTabMode)  wrap.classList.add("hide-closed-tab-mode");
    else                    wrap.classList.remove("hide-closed-tab-mode");
    // ★ v9.13: 마감업체 숨김 버튼 텍스트/스타일 초기 동기화
    const _btnHCC = document.getElementById("btnHideClosedCamp");
    if (_btnHCC) {
      if (hideClosedCampMode) {
        _btnHCC.innerHTML = '<i class="fas fa-building"></i> 마감업체 표시';
        _btnHCC.classList.add("active");
      } else {
        _btnHCC.innerHTML = '<i class="fas fa-building"></i> 마감업체 숨김';
        _btnHCC.classList.remove("active");
      }
    }

    // 마감 모드가 켜져 있었다면 유지
    if (_closedMode)    wrap.classList.add("closed-mode");

    // 필터가 활성화된 경우 재적용
    if (activeFilters.size > 0) applyDashFilter();

    _fixStickyPositions();
    _bindScrollSync();
    _closeColResizePopup();
    loadColWidths();    // ★ 렌더 후 저장된 컬럼 너비 재적용 (DOM 재빌드 시 인라인 스타일 유지)
    _loadHiddenCols();  // ★ 열 숨김 상태 복원
    _resetSort();       // ★ 정렬 초기화
    _bindMemoPreviewTooltips(); // ★ 메모 툴팁 바인딩
    clearDashSearch();  // ★ 새로고침 시 검색 초기화
    setTimeout(_attachDashResizeObserver, 50); // ★ 렌더 완료 후 반응형 컬럼 너비 감지 연결
    _lastDashData = data;
    // ★ v9.9: 폴링 스냅샷 갱신 (폴링 활성화 여부 무관)
    if (typeof _buildTabSnap === "function" && data.stats) {
      _dashPollTabSnap = _buildTabSnap(data.stats);
    }

    // ★ v10.0 P1-D: 대시보드 로드 완료 후 dirty 배지 자동 동기화
    // openIndexModal 에서만 호출되던 것을 여기서도 호출 → 대시보드 상시 표시
    if (APP_CONFIG.GAS_WEB_APP_URL) {
      _updateSmartDirtyBadge();
    }

  } catch (err) {
    wrap.innerHTML = `<div class="admin-error"><i class="fas fa-exclamation-circle"></i> ${escHtml(err.message)}</div>`;
  }
}

// 대시보드 렌더링 (외부에서 data를 직접 넘겨 재렌더링 가능)
function renderDashboard(data) {
  const wrap  = document.getElementById("dashboardWrap");
  const stats = data.stats || [];
  const grand = data.grand || { total: 0, submitted: 0, pending: 0 };
  const rate  = _pct(grand.submitted, grand.total);
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

  // ── ★ v11.0: 엑셀형 플랫 테이블 ──
  const scrollOuter2 = document.createElement("div");
  scrollOuter2.id = "dashboardScrollOuter";
  const flatTable2 = document.createElement("div");
  flatTable2.id = "dashboardScrollInner";
  flatTable2.className = "dash-flat-table";
  scrollOuter2.appendChild(flatTable2);
  wrap.appendChild(scrollOuter2);

  let _prevCamp2 = null;
  let _campIdx2 = 0;
  let _isFirstOfCamp2 = false;

  stats.forEach((c, ci) => {
    const campName = c.campaign || "";
    if (campName !== _prevCamp2) { _campIdx2++; _prevCamp2 = campName; _isFirstOfCamp2 = true; }
    const campStripe = _campIdx2 % 2 === 0 ? "camp-stripe-even" : "camp-stripe-odd";
    const allDone = c.closedOnly === true || c.tabs.every(t => {
      const key = (t.sheetId||"")+"||"+(t.tab||"");
      return _closedSet.has(key) || (t.total > 0 && t.pending === 0);
    });
    const hasClosed = c.closedOnly === true || c.tabs.some(t => _closedSet.has((t.sheetId||"")+"||"+(t.tab||"")));

    c.tabs.forEach(t => {
      const tRate      = _pct(t.submitted, t.total);
      const tabKey     = (t.sheetId||"")+"||"+(t.tab||"");
      const isClosedTab = _closedSet.has(tabKey);
      const isTabDone  = (t.total > 0 && t.pending === 0);
      const isPaidDone = (t.paidCount !== undefined && t.rowCount > 0 && t.paidCount >= t.rowCount);
      const isAllComplete = isTabDone && isPaidDone && !isClosedTab;  // ★ 제출+입금 모두 100%
      const _mainManualSD = _getManualStartDate(tabKey);
      const _mainEffectiveSD = _mainManualSD || t.startDate || "";
      const _ovDays = (!isTabDone && !isClosedTab) ? _calcOverdueDays(_mainEffectiveSD) : null;
      const isOverdue = _ovDays !== null && _ovDays >= 25;
      const row        = document.createElement("div");
      row.className    = "dash-tab-row " + campStripe + (_isFirstOfCamp2?" camp-first-row":"") + (isTabDone?" tab-done":"")+(isClosedTab?" is-closed-row":"")+(isOverdue?" urgent-overdue":"")
        +(!t.displayName && !isClosedTab?" no-product-warn":"")+(isAllComplete?" all-complete-row":"");
      _isFirstOfCamp2 = false;
      row.dataset.tabkey = tabKey;
      row.dataset.campname = campName.toLowerCase();
      row.dataset.sortCampaign = campName.toLowerCase();
      if (allDone)   row.classList.add("camp-all-done");
      if (hasClosed) row.classList.add("camp-has-closed");
      row.setAttribute('oncontextmenu', `_openAdminContextMenu(event,'${escHtml(tabKey)}')`);
      const _overdueBadge = isOverdue
        ? `<span class="badge-overdue"><i class="fas fa-fire" style="font-size:.55rem"></i> D+${_ovDays}</span>`
        : "";
      const _tabSheetUrl = _buildTabUrl(t.sheetUrl, t.sheetId, t.tabGid);
      const tabNameHtml = _tabSheetUrl
        ? `<a class="dash-tab-link" href="${escHtml(_tabSheetUrl)}" target="_blank" title="${escHtml(_tabSheetUrl)}">${escHtml(t.tab)} <i class="fas fa-external-link-alt dash-tab-ext"></i></a>${_overdueBadge}`
        : `<span>${escHtml(t.tab)}</span>${_overdueBadge}`;
      const _manualSD2 = _getManualStartDate(tabKey);
      const _effectiveSD2 = _manualSD2 || t.startDate || "";
      const startDateHtml = _effectiveSD2
        ? `<span class="tab-start-date${_manualSD2 ? ' manual-date' : ''}" data-tabkey="${escHtml(tabKey)}" data-rawsd="${escHtml(t.startDate||'')}" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="클릭하여 시작일 수정${_manualSD2 ? ' (수동 수정됨)' : ''}"><i class="fas fa-calendar-day"></i> ${escHtml(_effectiveSD2)}</span>`
        : `<span class="tab-date-empty" data-tabkey="${escHtml(tabKey)}" data-rawsd="" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="시작일 클릭하여 입력"><i class="fas fa-calendar-plus"></i> 날짜</span>`;
      const tuip = t.tuip||0, chuihap = t.chuihap||0;
      const total = t.total || 0;
      let stateHtml = "";
      if (isClosedTab)  stateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
      else if (isTabDone) stateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
      else if (tuip > 0 || chuihap > 0) {
        const leftHtml  = tuip > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${tuip}/${total}</span>` : `<span class="bar-lbl-left"></span>`;
        const rightHtml = chuihap > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${chuihap}/${total}</span>` : `<span class="bar-lbl-right"></span>`;
        stateHtml = leftHtml + rightHtml;
      }
      const tcData = { sheetId:t.sheetId, sheetUrl:t.sheetUrl||"", tabName:t.tab,
        manager:t.manager||"", timeRange:t.timeRange||"", taekhap:t.taekhap||false,
        reviewType:t.reviewType||"", paymentType:t.paymentType||"", displayName:t.displayName||"",
        deliveryType:t.deliveryType||"", folderUrl:t.folderUrl||"",
        captureFolderUrl:t.captureFolderUrl||"",
        isBulk:t.isBulk||false,
        tcRound: t.tcRound || t.round || "",
        incomeType: t.incomeType||"",
        providerMemo: t.providerMemo || t.provider_memo || "",
        depositName: t.depositName||"", transferBank: t.transferBank||"",
        _isClosed: isClosedTab };
      const tcAttr = escHtml(JSON.stringify(tcData));
      const _cachedED2 = localStorage.getItem("rapp_enddate_" + tabKey) || t.endDate || "";
      const endDateHtml2 = _buildEndDateHtml(tabKey, _cachedED2, isTabDone, isClosedTab);

      if (t.roundList && t.roundList.length >= 1) {
        t.roundList.forEach(rd => {
          const rdRow = document.createElement("div");
          const rdDone = (rd.total > 0 && rd.pending === 0);
          const rdPaidDone = (rd.paidCount !== undefined && rd.total > 0 && rd.paidCount >= rd.total);
          const rdTabKey = tabKey + "||" + (rd.round || "");
          // ★ 차수별 마감 판정
          const isRoundClosed = isClosedTab || _closedRoundSet.has(rdTabKey);
          const rdAllComplete = rdDone && rdPaidDone && !isRoundClosed;  // ★ 차수 제출+입금 모두 100%
          const rdStartDateRaw = rd.startDate || t.startDate || "";
          const _rdManualSD = _getManualStartDate(rdTabKey);
          const _rdEffectiveSD = _rdManualSD || rdStartDateRaw;
          const _rdOvDays = (!rdDone && !isRoundClosed) ? _calcOverdueDays(_rdEffectiveSD) : null;
          const rdIsOverdue = _rdOvDays !== null && _rdOvDays >= 25;
          rdRow.className = "dash-tab-row " + campStripe + (rdDone?" tab-done":"")+(isRoundClosed?" is-closed-row":"")+(rdIsOverdue?" urgent-overdue":"")+(rdAllComplete?" all-complete-row":"");
          rdRow.dataset.tabkey = rdTabKey;
          rdRow.dataset.campname = campName.toLowerCase();
          rdRow.dataset.sortCampaign = campName.toLowerCase();
          if (allDone) rdRow.classList.add("camp-all-done");
          if (hasClosed) rdRow.classList.add("camp-has-closed");
          const rdRate = _pct(rd.submitted, rd.total);
          const rdStartDateHtml = _rdEffectiveSD
            ? `<span class="tab-start-date${_rdManualSD ? ' manual-date' : ''}" data-tabkey="${escHtml(rdTabKey)}" data-rawsd="${escHtml(rdStartDateRaw)}" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="클릭하여 시작일 수정"><i class="fas fa-calendar-day"></i> ${escHtml(_rdEffectiveSD)}</span>`
            : `<span class="tab-date-empty" data-tabkey="${escHtml(rdTabKey)}" data-rawsd="" onclick="event.stopPropagation();openStartDatePopup(event,this)" title="시작일 입력"><i class="fas fa-calendar-plus"></i> 날짜</span>`;
          const _rdOverdueBadge = rdIsOverdue
            ? `<span class="badge-overdue"><i class="fas fa-fire" style="font-size:.55rem"></i> D+${_rdOvDays}</span>` : "";
          const _rdTabSheetUrl = _buildTabUrl(t.sheetUrl, t.sheetId, t.tabGid);
          const rdTabNameHtml = _rdTabSheetUrl
            ? `<a class="dash-tab-link" href="${escHtml(_rdTabSheetUrl)}" target="_blank" title="${escHtml(_rdTabSheetUrl)}">${escHtml(t.tab)} <i class="fas fa-external-link-alt dash-tab-ext"></i></a>${_rdOverdueBadge}`
            : `<span>${escHtml(t.tab)}</span>${_rdOverdueBadge}`;
          let rdStateHtml = "";
          if (isRoundClosed) rdStateHtml = `<span class="bar-lbl-center">⬛ 마감</span>`;
          else if (rdDone) rdStateHtml = `<span class="bar-lbl-center">✓ 완료</span>`;
          else if ((rd.tuip||0) > 0 || (rd.chuihap||0) > 0) {
            const rdTotal2 = rd.total || 0;
            const rdLeft  = (rd.tuip||0) > 0 ? `<span class="bar-lbl-left"><i class="fas fa-user-plus"></i> 투입중 ${rd.tuip}/${rdTotal2}</span>` : `<span class="bar-lbl-left"></span>`;
            const rdRight = (rd.chuihap||0) > 0 ? `<span class="bar-lbl-right"><i class="fas fa-layer-group"></i> 취합중 ${rd.chuihap}/${rdTotal2}</span>` : `<span class="bar-lbl-right"></span>`;
            rdStateHtml = rdLeft + rdRight;
          }
          const tRd = Object.assign({}, t, { submitted: rd.submitted, total: rd.total, pending: rd.pending, tuip: rd.tuip||0, chuihap: rd.chuihap||0 });
          const rdTcData = Object.assign({}, JSON.parse(tcAttr.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')), { tcRound: rd.round || "" });
          const rdTcAttr = escHtml(JSON.stringify(rdTcData));
          rdRow.dataset.state = _rowState(isRoundClosed, rdDone, rd.tuip||0, rd.chuihap||0);
          rdRow.innerHTML = _buildTabRowHtml(tRd, rdTabKey, false, isRoundClosed, rdTabNameHtml, rdStartDateHtml, rdRate, rdStateHtml, rdTcAttr, rd.round, null, campName);
          flatTable2.appendChild(rdRow);
        });
      } else {
        row.dataset.state = _rowState(isClosedTab, isTabDone, tuip, chuihap);
        row.innerHTML = _buildTabRowHtml(t, tabKey, false, isClosedTab, tabNameHtml, startDateHtml, tRate, stateHtml, tcAttr, null, endDateHtml2, campName);
        flatTable2.appendChild(row);
      }
    });
  });
  if (hideClosedCampMode) wrap.classList.add("hide-closed-camp-mode");
  else                    wrap.classList.remove("hide-closed-camp-mode");
  if (hideClosedTabMode)  wrap.classList.add("hide-closed-tab-mode");
  else                    wrap.classList.remove("hide-closed-tab-mode");
  if (_closedMode)        wrap.classList.add("closed-mode");
  if (activeFilters.size > 0) applyDashFilter();
  _fixStickyPositions();
  _bindScrollSync();
  _syncHorizontalScroll(); // ★ 가로 스크롤 동기화
  _closeColResizePopup();
  loadColWidths();    // ★ 렌더 후 저장된 컬럼 너비 재적용
  _loadHiddenCols();  // ★ 열 숨김 상태 복원
  _resetSort();       // ★ 정렬 초기화
  _bindMemoPreviewTooltips(); // ★ 메모 툴팁 바인딩
  clearDashSearch();  // ★ 렌더 시 검색 초기화
  setTimeout(_attachDashResizeObserver, 50); // ★ 렌더 완료 후 반응형 컬럼 너비 감지 연결
  // ★ v10.0 P1-D: 재렌더 후 dirty 배지도 갱신
  if (APP_CONFIG.GAS_WEB_APP_URL) {
    _updateSmartDirtyBadge();
  }
}

// ═══════════════════════════════════════════════════════
// 탭 행 HTML 빌더 (loadAdminDashboard + renderDashboard 공용)
// 열 순서: 체크박스 | 탭명 | 시작일 | 상품명 | 주문시간대 | 리뷰타입 | 담당자 | 진행률 | 리뷰 | 상태 | 입금방식 | 택대 | +정보
// ═══════════════════════════════════════════════════════
// ★ roundLabel: 차수 배지 HTML (호출 시 전달 — "단독" 또는 "1차" 등)
// ── 긴급 경과일 계산 ──────────────────────────────────────────
/**
 * "YY.MM.DD" 또는 "YYYY.MM.DD" 형식 startDate → 오늘 기준 경과일 반환
 * 파싱 실패 시 null 반환
 */
function _parseStartDate(sd) {
  if (!sd) return null;
  const s = String(sd).trim();
  // 종료일 연도는 2026년으로 강제
  const FIXED_YEAR = 2026;

  // YY.MM.DD(요일) — 예: "25.03.12(목)"
  let m = s.match(/^(\d{2})\.(\d{1,2})\.(\d{1,2})\([월화수목금토일]\)$/);
  if (m) {
    return new Date(FIXED_YEAR, parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }

  // YY.MM.DD 또는 YYYY.MM.DD
  m = s.match(/^(\d{2,4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[2], 10) - 1; // 0-indexed
  const day   = parseInt(m[3], 10);
  return new Date(FIXED_YEAR, month, day);
}
/**
 * ★ v11.2: 탭 URL 구성 헬퍼
 * sheetUrl(또는 sheetId)에 tabGid를 항상 반영하여 정확한 탭 URL을 반환한다.
 * ⚠️ Google Sheets /edit 모드는 서버 세션에서 마지막 본 탭을 강제 복원함
 *    → ?gid= / #gid= / &range=A1 모두 우회 불가 (Google 서버 측 동작)
 *    → 링크에는 gid를 포함하되, 클릭 시 탭 이름 클립보드 복사로 UX 보완
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

/**
 * ★ 숨김 탭 표시(unhide) 처리 — Google Sheets API 호출
 */
async function _unhideTab(sheetId, tabGid, el) {
  if (!confirm('이 탭의 숨김을 해제하시겠습니까?\n(Google Sheets에서 탭이 다시 표시됩니다)')) return;
  try {
    el.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    const data = await gasPost({ action: 'unhideTab', sheetId, tabGid });
    if (data.error) throw new Error(data.error);
    // 성공 → 아이콘을 정상 링크로 교체
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${tabGid}`;
    el.outerHTML = `<a href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${url}" style="color:#4285F4;font-size:.72rem;margin-left:2px;text-decoration:none"><i class="fas fa-external-link-alt"></i></a>`;
    // 숨김탭 배지 제거
    const parent = el.closest ? el.closest('label') || el.parentElement : el.parentElement;
    if (parent) {
      const badge = parent.querySelector('span');
      parent.querySelectorAll('span').forEach(s => { if (s.textContent === '숨김탭') s.remove(); });
    }
    if (typeof showToast === 'function') showToast('탭 숨김 해제 완료 — 링크 클릭 가능', 'success');
  } catch (err) {
    el.innerHTML = '<i class="fas fa-eye-slash"></i>';
    if (typeof showToast === 'function') showToast('숨김 해제 실패: ' + err.message, 'error');
  }
}

// ── 탭 숨김 처리 (hide) ──
async function _hideTab(sheetId, tabGid, el) {
  if (!confirm('이 탭을 숨김 처리하시겠습니까?\n(Google Sheets에서 탭이 숨겨집니다)')) return;
  try {
    el.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    const data = await gasPost({ action: 'hideTab', sheetId, tabGid });
    if (data.error) throw new Error(data.error);
    // 성공 → 숨김해제 버튼으로 교체
    el.outerHTML = `<button onclick="event.stopPropagation();_unhideTabBtn('${sheetId}','${tabGid}',this)" title="숨김 해제" style="background:#F3F4F6;border:1px solid #D1D5DB;padding:1px 5px;border-radius:4px;font-size:.68rem;cursor:pointer;color:#6B7280;margin-left:3px"><i class="fas fa-eye"></i> 표시</button>`;
    if (typeof showToast === 'function') showToast('탭 숨김 처리 완료', 'success');
  } catch (err) {
    el.innerHTML = '<i class="fas fa-eye"></i> 숨김';
    if (typeof showToast === 'function') showToast('숨김 처리 실패: ' + err.message, 'error');
  }
}

// ── 숨김해제 버튼 (완료감지 목록 내 인라인) ──
async function _unhideTabBtn(sheetId, tabGid, el) {
  if (!confirm('이 탭의 숨김을 해제하시겠습니까?\n(Google Sheets에서 탭이 다시 표시됩니다)')) return;
  try {
    el.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    const data = await gasPost({ action: 'unhideTab', sheetId, tabGid });
    if (data.error) throw new Error(data.error);
    // 성공 → 숨김 버튼으로 교체
    el.outerHTML = `<button onclick="event.stopPropagation();_hideTab('${sheetId}','${tabGid}',this)" title="탭 숨김" style="background:#FEF2F2;border:1px solid #FECACA;padding:1px 5px;border-radius:4px;font-size:.68rem;cursor:pointer;color:#DC2626;margin-left:3px"><i class="fas fa-eye-slash"></i> 숨김</button>`;
    if (typeof showToast === 'function') showToast('탭 숨김 해제 완료', 'success');
  } catch (err) {
    el.innerHTML = '<i class="fas fa-eye"></i> 표시';
    if (typeof showToast === 'function') showToast('숨김 해제 실패: ' + err.message, 'error');
  }
}

function _calcOverdueDays(sd) {
  const d = _parseStartDate(sd);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - d) / 86400000);
  return diff >= 0 ? diff : null;
}

/* ── v9.9: 종료 예정일 D-Day 배지 HTML 생성 ── */
function _calcDdayFromEndDate(ed) {
  // ed: "YY.MM.DD" 형식
  const d = _parseStartDate(ed);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.floor((d - today) / 86400000); // 양수=미래, 0=오늘, 음수=과거
}

function _buildEndDateHtml(tabKey, endDate, isTabDone, isClosedTab) {
  const tcData_ed = escHtml(JSON.stringify({ tabKey }));
  const refreshBtn = `<button class="btn-enddate-refresh" onclick="event.stopPropagation();refreshTabEndDate(this,'${escHtml(tabKey)}')" title="구매일자 마지막값으로 종료일 갱신" style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:.65rem;padding:1px 3px;margin-left:2px"><i class="fas fa-sync-alt"></i></button>`;

  if (!endDate) {
    return `<span style="color:#D1D5DB;font-size:.6rem">—</span>${refreshBtn}`;
  }

  const dday = _calcDdayFromEndDate(endDate);
  if (dday === null) return `<span style="color:#D1D5DB;font-size:.6rem">${escHtml(endDate)}</span>${refreshBtn}`;

  let badge = "";
  if (isTabDone || isClosedTab) {
    badge = `<span class="dday-badge dday-done" title="종료일: ${escHtml(endDate)}">완료</span>`;
  } else if (dday < 0) {
    // 이미 지남 → 🔥 긴급
    badge = `<span class="dday-badge dday-over" title="종료일: ${escHtml(endDate)}"><i class="fas fa-fire" style="font-size:.6rem"></i> 마감 ${Math.abs(dday)}일경과</span>`;
  } else if (dday <= 3) {
    // D-Day ~ D-3
    badge = `<span class="dday-badge dday-near" title="종료일: ${escHtml(endDate)}">${dday === 0 ? '마감 당일' : '마감 ' + dday + '일전'}</span>`;
  } else {
    badge = `<span class="dday-badge dday-normal" title="종료일: ${escHtml(endDate)}">마감 ${dday}일전</span>`;
  }
  return `<span style="display:flex;align-items:center;gap:2px">${badge}${refreshBtn}</span>`;
}

/* ── v9.9: 메모 공유 패널 ── */
let _memoCurrentTab = null; // { sheetId, tabName, displayName }

async function openMemoPanel(sheetId, tabName, displayName) {
  _memoCurrentTab = { sheetId, tabName, displayName };
  const overlay = document.getElementById("memoOverlay");
  const titleEl = document.getElementById("memoModalTitle");
  if (titleEl) titleEl.textContent = (displayName || tabName) + " 메모";
  overlay.classList.add("open");
  await _loadMemoMessages();
}

function closeMemoPanel() {
  document.getElementById("memoOverlay").classList.remove("open");
  _memoCurrentTab = null;
}

async function _loadMemoMessages() {
  const chatArea = document.getElementById("memoChatArea");
  if (!chatArea || !_memoCurrentTab) return;
  chatArea.innerHTML = '<div class="memo-empty"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';
  try {
    const data = await gasGet({ action: "getMemo", sheetId: _memoCurrentTab.sheetId, tabName: _memoCurrentTab.tabName });
    const msgs = (data && data.messages) ? data.messages : [];
    if (msgs.length === 0) {
      chatArea.innerHTML = '<div class="memo-empty">아직 메모가 없습니다.<br>첫 메모를 남겨보세요!</div>';
      return;
    }
    chatArea.innerHTML = msgs.map(m => {
      const roleClass  = m.role === "admin" ? "admin" : "staff";
      const roleLabel  = m.role === "admin" ? "👔 관리자" : "💼 AE";
      const timeStr    = m.ts ? new Date(m.ts).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "";
      return `<div class="memo-bubble ${roleClass}">
        <div>${escHtml(m.text)}</div>
        <div class="memo-bubble-meta">${roleLabel} ${escHtml(m.name)} · ${timeStr}</div>
      </div>`;
    }).join("");
    chatArea.scrollTop = chatArea.scrollHeight;
  } catch(e) {
    chatArea.innerHTML = `<div class="memo-empty" style="color:#EF4444">불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

async function sendMemoMsg() {
  if (!_memoCurrentTab) return;
  const textEl = document.getElementById("memoInputText");
  const text   = (textEl ? textEl.value : "").trim();
  if (!text) { showToast("메모 내용을 입력하세요.", "warning"); return; }

  // 관리자 세션에서 이름 가져오기
  const _sess = (() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(_) { return null; }
  })();
  if (!_sess || !_sess.name) { showToast("로그인이 필요합니다.", "error"); return; }

  const sendBtn = document.querySelector(".memo-send-btn");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>'; }
  try {
    await gasGet({ action: "saveMemo",
      sheetId: _memoCurrentTab.sheetId, tabName: _memoCurrentTab.tabName,
      role: "admin", name: _sess.name, text });
    if (textEl) textEl.value = "";
    await _loadMemoMessages();
    // ★ 메모 미리보기 캐시 무효화
    const tabKey = _memoCurrentTab.sheetId + "||" + _memoCurrentTab.tabName;
    _invalidateMemoCache(tabKey);
    document.querySelectorAll(`.btn-tab-memo`).forEach(btn => {
      if (btn.closest("[data-tabkey='" + tabKey + "']") || btn.onclick?.toString().includes(escHtml(tabKey))) {
        btn.classList.add("has-memo");
      }
    });
  } catch(e) {
    showToast("메모 저장 실패: " + e.message, "error");
  } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>'; }
  }
}
async function refreshTabEndDate(btnEl, tabKey) {
  const parts = tabKey.split("||");
  if (parts.length < 2) return;
  const sheetId = parts[0], tabName = parts[1];
  const origHtml = btnEl.innerHTML;
  btnEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
  btnEl.disabled = true;
  try {
    const data = await gasGet({ action: "getTabEndDate", sheetId, tabName });
    if (data && data.endDate !== undefined) {
      if (data.endDate) {
        localStorage.setItem("rapp_enddate_" + tabKey, data.endDate);
        showToast(`📅 종료 예정일 갱신: ${data.endDate}`, "success");
      } else {
        showToast("구매일자 열을 찾을 수 없습니다.", "warning");
      }
      // 해당 행 re-render는 다음 대시보드 갱신 시 적용 (즉시 DOM 업데이트)
      const endDateCell = btnEl.closest(".dash-enddate-col");
      if (endDateCell) {
        const isTabDone  = btnEl.closest(".tab-done")  !== null;
        const isClosedTab = btnEl.closest(".is-closed-row") !== null;
        endDateCell.innerHTML = _buildEndDateHtml(tabKey, data.endDate, isTabDone, isClosedTab);
      }
    }
  } catch(e) {
    showToast("종료일 조회 실패: " + e.message, "error");
  } finally {
    btnEl.innerHTML = origHtml;
    btnEl.disabled = false;
  }
}
// ─────────────────────────────────────────────────────────────
function _buildTabRowHtml(t, tabKey, isSubRow, isClosedTab, tabNameHtml, startDateHtml, tRate, stateHtml, tcAttr, roundLabel, endDateHtml, campaignName) {
  // 각 열 셀 값 (없으면 회색 dash)
  const empty = `<span style="color:#D1D5DB;font-size:.65rem">—</span>`;

  // ── qe(빠른입력) 셀 래퍼 생성 헬퍼 ──
  function qeWrap(field, hasValue, inner, extraStyle) {
    const base = `overflow:hidden;min-width:0;padding:0 3px;display:flex;align-items:center;${extraStyle||''}`;
    const label = hasValue ? `클릭하여 ${field} 수정` : `클릭하여 ${field} 입력`;
    // 값 유무에 관계없이 항상 클릭 가능
    return `<div class="qe-cell" style="${base}" data-field="${field}" data-tabkey="${escHtml(tabKey)}" data-tc="${tcAttr}" onclick="quickEditCell(event,this)" title="${label}">${inner}</div>`;
  }

  // 상품명 열 (배송유형 배지 포함)
  // ★ 상품명 없는 탭: 마감 제외 시 경고 배지 표시
  const _hasNoProduct = !t.displayName && !isClosedTab;
  // 배송타입 배지는 부가정보 열로 이동 (상품명 열에서 제거)
  const noProductBadge = _hasNoProduct
    ? `<span class="badge-no-product" title="⚙ 탭설정에서 상품명을 입력해주세요"><i class="fas fa-exclamation-triangle" style="font-size:.55rem"></i> 상품명없음</span>`
    : "";
  const nameCell = (t.displayName || _hasNoProduct)
    ? `<span style="display:flex;align-items:center;gap:3px;flex-wrap:wrap">${t.displayName ? `<span class="dash-cell-name" title="${escHtml(t.displayName)}">${escHtml(t.displayName)}</span>` : ""}${noProductBadge}</span>`
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

  // ★ v9.14: 진행방식 셀 (현금/사업자현영/소득신고)
  const incomeTypeClass = t.incomeType === '소득신고' ? 'style="background:#e8f1fe;color:#1b64da;border-color:#6fa6f5"'
    : t.incomeType === '사업자현영' ? 'style="background:#FEF3C7;color:#92400E;border-color:#FCD34D"'
    : t.incomeType === '현금' ? 'style="background:#D1FAE5;color:#065F46;border-color:#6EE7B7"' : '';
  const incomeTypeCell = t.incomeType
    ? `<span class="tc-badge" ${incomeTypeClass} style="font-size:.62rem">[${escHtml(t.incomeType)}]</span>`
    : empty;

  // ★ v9.14: 입금명 셀
  const depositNameCell = t.depositName
    ? `<span class="tc-badge" style="background:#DBEAFE;color:#1E40AF;border-color:#93C5FD;font-size:.62rem">[${escHtml(t.depositName)}]</span>`
    : empty;

  // ★ v9.14: 이체은행 셀
  const bankClass = t.transferBank === '케이뱅크' ? 'style="background:#FED7AA;color:#9A3412;border-color:#FDBA74"'
    : t.transferBank === '하나은행' ? 'style="background:#D1FAE5;color:#065F46;border-color:#6EE7B7"' : '';
  const bankCell = t.transferBank
    ? `<span class="tc-badge" ${bankClass} style="font-size:.62rem">[${escHtml(t.transferBank)}]</span>`
    : empty;

  // 택대 열
  const taekhapCell = t.taekhap
    ? `<span class="tc-badge tc-taekhap-on" style="font-size:.63rem">✔ 택대</span>`
    : empty;

  // 캡처폴더 열
  const captureFolderCell = t.captureFolderUrl
    ? `<a class="dash-folder-link" style="color:#3182f6;background:#f2f7ff;border-color:#cce0fb" href="${escHtml(t.captureFolderUrl)}" target="_blank" onclick="event.stopPropagation()"><i class="fas fa-camera"></i> 캡처폴더</a>`
    : `<span style="color:#D1D5DB;font-size:.6rem">—</span>`;

  // 리뷰폴더 열 (대량건 배지 제거 → 부가정보 열로 이동)
  const folderCell = t.folderUrl
    ? `<a class="dash-folder-link" href="${escHtml(t.folderUrl)}" target="_blank" onclick="event.stopPropagation()"><i class="fas fa-folder-open"></i> 리뷰폴더</a>`
    : `<span style="color:#D1D5DB;font-size:.6rem">—</span>`;

  // 차수 열: 호출 시 전달된 roundLabel 사용 (없으면 "단독")
  const roundBadgeHtml = roundLabel
    ? `<span class="dash-round-col-badge badge-nth">${escHtml(roundLabel)}</span>`
    : `<span class="dash-round-col-badge badge-solo">단독</span>`;
  const roundColHtml = `<div style="display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 2px">${roundBadgeHtml}</div>`;

  // 비고 열 (localStorage 기반 + 공유 메모 버튼)
  const memoVal = _getTabMemo(tabKey);
  const memoInner = memoVal
    ? `<span class="dash-cell-memo" title="${escHtml(memoVal)}">${escHtml(memoVal)}</span>`
    : empty;

  // ★ 부가정보 열: [대량건] → [배송타입] → [D-Day] 순서로 배지 합산
  const bulkBadge   = t.isBulk
    ? `<span class="tc-badge tc-bulk-badge" style="font-size:.6rem">대량건</span>`
    : "";
  const deliveryBadge = t.deliveryType
    ? `<span class="tc-badge tc-delivery-badge" style="font-size:.6rem">${escHtml(t.deliveryType)}</span>`
    : "";
  // endDateHtml은 이미 <span>으로 감싸진 배지+버튼 HTML이므로 그대로 사용
  const ddayContent = endDateHtml || "";
  // 배지들은 inline으로 배치, D-Day는 이미 flex span으로 감싸져있음
  const badgePart = [bulkBadge, deliveryBadge].filter(Boolean).join("");
  const endDateCell = (badgePart || ddayContent)
    ? `<span style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:3px">${badgePart}${ddayContent}</span>`
    : `<span style="color:#D1D5DB;font-size:.6rem">—</span>`;

  // ★ v11.0: 캠페인명 셀 (엑셀형 플랫 UI) + 🔄 갱신 버튼
  const _campName = campaignName || "";
  const _rebuildBtn = t.sheetId
    ? `<button class="btn-rebuild-sheet" data-sheetid="${escHtml(t.sheetId)}" data-camp="${escHtml(_campName)}" onclick="event.stopPropagation();rebuildSheetIndex(this)" title="이 캠페인 인덱스 갱신"><i class="fas fa-sync-alt"></i></button>`
    : '';
  const campaignCell = _campName
    ? `<span class="dash-cell-campaign" title="${escHtml(_campName)}">${_rebuildBtn}${escHtml(_campName)}</span>`
    : empty;

  return `
    <div class="closed-cb-wrap">
      <input type="checkbox" class="closed-cb" data-tabkey="${escHtml(tabKey)}" ${isClosedTab ? "checked" : ""} onclick="event.stopPropagation()">
    </div>
    <div class="dash-tab-campaign">${campaignCell}</div>
    <div class="dash-tab-name">${tabNameHtml}</div>
    ${qeWrap('상품명', !!t.displayName, nameCell)}
    <div style="display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;padding:0 2px">${captureFolderCell}</div>
    <div style="display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;padding:0 2px">${folderCell}</div>
    ${roundColHtml}
    <div class="dash-tab-date-col">${startDateHtml}</div>
    ${t.timeRange
      ? `<div class="qe-cell" style="overflow:hidden;min-width:0;padding:0 3px;display:flex;align-items:center" data-field="주문시간대" data-tabkey="${escHtml(tabKey)}" data-tc="${tcAttr}" onclick="quickEditCell(event,this)" title="클릭하여 주문시간대 수정">${timeCell}</div>`
      : qeWrap('주문시간대', false, timeCell)}
    ${qeWrap('리뷰타입', !!t.reviewType, reviewCell)}
    <div class="form-link-wrap">
      <button class="short-link-btn" data-tc="${tcAttr}" onclick="event.stopPropagation();copyShortLink(this)" title="단축 URL 복사 📋"><i class="fas fa-link"></i></button>
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
            const tuipRate    = _pct(tuip, total);
            const chuihapRate = _pct(chuihap, total);
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
        : (() => {
            const _pending = (t.total||0) - (t.submitted||0);
            if (_pending > 0 && _pending < 10 && t.sheetId && (t.tab || t.tabName)) {
              const _sid = escHtml(t.sheetId);
              const _tn = escHtml(t.tab || t.tabName);
              return `<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px" onclick="event.stopPropagation();_showPendingReviewersPopup('${_sid}','${_tn}',${t.total},${t.submitted})" title="클릭하여 미제출자 ${_pending}명 확인"><span class="dash-done">${t.submitted}</span><span class="dash-sep">/</span><span class="dash-total">${t.total}</span></span>`;
            }
            return `<span class="dash-done">${t.submitted}</span><span class="dash-sep">/</span><span class="dash-total">${t.total}</span>`;
          })()
      }
    </div>

    ${qeWrap('입금방식', !!t.paymentType, paymentCell, 'justify-content:center')}
    ${qeWrap('진행방식', !!t.incomeType, incomeTypeCell, 'justify-content:center')}
    ${qeWrap('입금명', !!t.depositName, depositNameCell, 'justify-content:center')}
    ${qeWrap('이체은행', !!t.transferBank, bankCell, 'justify-content:center')}
    ${qeWrap('택대', t.taekhap === true, taekhapCell, 'justify-content:center')}
    <div class="qe-cell" style="overflow:hidden;min-width:0;padding:0 3px;display:flex;align-items:center" data-field="비고" data-tabkey="${escHtml(tabKey)}" data-tc="${tcAttr}" onclick="quickEditCell(event,this)" title="${memoVal ? '비고 수정' : '비고 입력'}">${memoInner}</div>
    <div class="dash-enddate-col" style="display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:0;padding:0 2px">${endDateCell}</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:3px;flex-wrap:nowrap;overflow:hidden;min-width:0;padding:0 2px">
      <button class="tc-info-btn tc-clickable" data-tc="${tcAttr}" title="일괄 정보 입력·수정" style="flex-shrink:0">+정보</button>
      <button class="btn-tab-stats" onclick="event.stopPropagation();openStatsPanel('${escHtml(t.sheetId||'')}','${escHtml(t.tab||'')}','${escHtml(t.displayName||t.tab||'')}')" title="진행률 상세 보기" style="flex-shrink:0;padding:2px 5px"><i class="fas fa-chart-bar"></i></button>
      <button class="btn-tab-memo" onclick="event.stopPropagation();openMemoPanel('${escHtml(t.sheetId||'')}','${escHtml(t.tab||'')}','${escHtml(t.displayName||t.tab||'')}')" title="메모 보기/입력" style="flex-shrink:0;padding:2px 5px"><i class="fas fa-comment-dots"></i></button>
    </div>`;
}

// ═══════════════════════════════════════════════════════
// 컬럼 리사이즈 시스템
// ═══════════════════════════════════════════════════════

/** 컬럼 정의 (index 0=마감CB, 1=탭명, ... 19=⚙)
 *  closedcb: 기본 0px, 모드 진입 시 JS에서 28px로 전환
 */
const DASH_COL_DEFS = [
  { key: 'closedcb',    varName: '--dc-closedcb',    label: '마감',       minPx: 20,  default: 0,   isCb: true },
  { key: 'campaign',    varName: '--dc-campaign',    label: '캠페인',     minPx: 60,  default: 120               },  // ★ v11.0
  { key: 'tabname',     varName: '--dc-tabname',     label: '탭명',       minPx: 60,  default: 200               },
  { key: 'product',     varName: '--dc-product',     label: '상품명',     minPx: 60,  default: 160               },
  { key: 'capture',     varName: '--dc-capture',     label: '캡처폴더',   minPx: 35,  default: 54                },
  { key: 'folder',      varName: '--dc-folder',      label: '리뷰폴더',   minPx: 35,  default: 54                },
  { key: 'round',       varName: '--dc-round',       label: '차수',       minPx: 28,  default: 36                },
  { key: 'date',        varName: '--dc-date',        label: '시작일',     minPx: 40,  default: 60                },
  { key: 'time',        varName: '--dc-time',        label: '주문시간대', minPx: 50,  default: 80                },
  { key: 'review',      varName: '--dc-review',      label: '리뷰타입',   minPx: 35,  default: 50                },
  { key: 'formlink',    varName: '--dc-formlink',    label: '폼링크',     minPx: 28,  default: 32                },
  { key: 'manager',     varName: '--dc-manager',     label: '담당',       minPx: 28,  default: 48                },
  { key: 'bar',         varName: '--dc-bar',         label: '진행률',     minPx: 120, default: 200               },
  { key: 'nums',        varName: '--dc-nums',        label: '리뷰',       minPx: 40,  default: 58                },
  { key: 'payment',     varName: '--dc-payment',     label: '입금',       minPx: 28,  default: 42                },
  { key: 'income',      varName: '--dc-income',      label: '진행방식',   minPx: 60,  default: 80                },
  { key: 'depositname', varName: '--dc-depositname', label: '입금명',     minPx: 80,  default: 120               },
  { key: 'bank',        varName: '--dc-bank',        label: '이체은행',   minPx: 60,  default: 80                },
  { key: 'taekhap',     varName: '--dc-taekhap',     label: '택대',       minPx: 28,  default: 40                },
  { key: 'memo',        varName: '--dc-memo',        label: '비고',       minPx: 40,  default: 140               },
  { key: 'enddate',     varName: '--dc-enddate',     label: '부가정보',   minPx: 70,  default: 90                },
  { key: 'info',        varName: '--dc-info',        label: '⚙',         minPx: 82,  default: 90, noScale: true  },
];
const COL_WIDTH_LS_KEY = 'dashColWidths_v11'; // ★ v11.1: 새 컬럼 레이아웃

/** 컨테이너 content 너비 반환 (padding/border 제외, 실제 사용 가능한 너비) */
function _getContainerWidth() {
  // ★ v10.5: dashboardScrollOuter의 실제 clientWidth를 가장 먼저 사용
  // dashboardScrollOuter는 width:100%, overflow:hidden이므로
  // 부모(admin-tab-pane) 크기를 정확히 따름
  const outer = document.getElementById('dashboardScrollOuter');
  if (outer && outer.clientWidth > 0) {
    return outer.clientWidth; // padding 없으므로 그대로 사용
  }
  // 폴백 1: admin-tab-pane 기준 (padding 16px 제외)
  const pane = document.querySelector('#tab-dashboard.admin-tab-pane, .admin-tab-pane.active');
  if (pane && pane.clientWidth > 0) {
    const style = getComputedStyle(pane);
    const pl = parseFloat(style.paddingLeft)  || 0;
    const pr = parseFloat(style.paddingRight) || 0;
    return pane.clientWidth - pl - pr;
  }
  // 폴백 2: admin-body 기준 (padding 24px×2 제외, tab-pane padding 16px×2 추가 제외)
  const adminBody = document.querySelector('.admin-body');
  if (adminBody) {
    const style = getComputedStyle(adminBody);
    const pl = parseFloat(style.paddingLeft)  || 0;
    const pr = parseFloat(style.paddingRight) || 0;
    const bodyW = adminBody.getBoundingClientRect().width;
    if (bodyW > 0) return bodyW - pl - pr - 32; // tab-pane padding 16×2
  }
  // 폴백 3: window 너비 - 여백
  return window.innerWidth - 80;
}

/** localStorage에서 저장된 너비 로드 후 CSS 변수 적용 (CB 컬럼 제외 - 모드 토글이 관리) */
function loadColWidths() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(COL_WIDTH_LS_KEY) || '{}'); } catch(_) {}
  const root = document.documentElement;
  let applied = 0;
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb || col.noScale) return; // CB·noScale 컬럼은 제외
    const w = saved[col.key];
    if (w && Number.isFinite(w) && w >= col.minPx) {
      root.style.setProperty(col.varName, w + 'px');
      applied++;
    }
  });
  // 저장값 적용 후 반응형 너비 재계산 (뷰포트 좁은 경우 대비)
  _lastAppliedW = 0; // 강제 재계산
  _syncTabnameWidth();
  return applied; // 디버그용
}

/** 현재 실제 적용 너비를 localStorage에 저장 (CB 컬럼 제외) */
function saveColWidths() {
  const data = {};
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb || col.noScale) return; // CB·noScale 컬럼은 저장 안 함
    // _getColWidth: inline style 우선, 없으면 computed style 폴백
    const w = _getColWidth(col);
    if (w && Number.isFinite(w) && w > 0) data[col.key] = w;
  });
  try { localStorage.setItem(COL_WIDTH_LS_KEY, JSON.stringify(data)); } catch(_) {}
}

/** (호환성 stub) */
function _updateDashMinWidth() {}

/* ══════════════════════════════════════════════════════════
   ★ 반응형 컬럼 너비 축소 시스템 (v10.4)
   - 컨테이너 너비가 기준(BASE_W)보다 좁아질 때 비율에 맞게 축소
   - "유연" 컬럼(tabname, product, memo, depositname)을 우선 축소
   - 나머지 컬럼은 minPx 이하로 축소 안 함
   - ResizeObserver로 컨테이너 너비 변화 감지
   ══════════════════════════════════════════════════════════ */

// 마지막으로 반응형 계산을 적용한 컨테이너 너비 (중복 재계산 방지)
let _lastAppliedW = 0;

/**
 * 컨테이너 너비에 맞춰 컬럼 너비를 단계적으로 축소/숨김
 *
 * 전략:
 *  1단계 (availW < 기본): flex 컬럼 비율 축소
 *  2단계 (여전히 부족): 부가정보 컬럼 순서로 0px 숨김
 *  3단계 (극소 화면): 필수 컬럼만 남기고 나머지 숨김
 *
 * @param {number} availW - 사용 가능한 컨테이너 너비(px)
 */
function _syncTabnameWidth(availW) {
  if (availW == null) availW = _getContainerWidth();
  if (!availW || availW < 100) return;
  if (Math.abs(availW - _lastAppliedW) < 1) return;
  _lastAppliedW = availW;

  const root = document.documentElement;
  const savedWidths = (() => {
    try { return JSON.parse(localStorage.getItem(COL_WIDTH_LS_KEY) || '{}'); } catch(_) { return {}; }
  })();
  const pad = 28; // 좌우 padding 합계

  // 사용자가 수동으로 숨긴 열 (col-hidden 시스템)
  // _colsHiddenActive 상태일 때 _selectedHideCols 사용
  const manualHidden = (typeof _colsHiddenActive !== 'undefined' && _colsHiddenActive && typeof _selectedHideCols !== 'undefined')
    ? _selectedHideCols
    : new Set();

  // 각 컬럼의 "원하는 기준 너비" (사용자 저장값 우선, 없으면 default)
  // 수동 숨김 열은 0으로 처리
  const baseW = {};
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb) { baseW[col.key] = 0; return; }
    if (manualHidden.has(col.key)) { baseW[col.key] = 0; return; }
    const saved = savedWidths[col.key];
    baseW[col.key] = (saved && Number.isFinite(saved) && saved >= col.minPx) ? saved : (col.default || 0);
  });

  // CB 컬럼 현재 너비 (마감 모드)
  const cbW = DASH_COL_DEFS.filter(c => c.isCb).reduce((sum, c) => {
    const v = parseInt(getComputedStyle(root).getPropertyValue(c.varName)) || 0;
    return sum + v;
  }, 0);

  // 기준 전체 너비 (저장값 반영, noScale 컬럼은 1fr이므로 제외, 수동숨김 열 제외)
  const totalBase = DASH_COL_DEFS.reduce((s, c) => s + (c.isCb || c.noScale || manualHidden.has(c.key) ? 0 : (baseW[c.key] || 0)), 0) + cbW + pad;

  if (availW >= totalBase) {
    // ── 충분히 넓음: 기준 너비 그대로 복원 ──
    DASH_COL_DEFS.forEach(col => {
      if (col.isCb || col.noScale) return; // noScale(info)은 CSS 1fr 유지
      root.style.setProperty(col.varName, baseW[col.key] + 'px');
    });
    return;
  }

  // ── 축소 필요 ──
  // 단계적 숨김 순서: 덜 중요한 컬럼부터
  // (숨김 = 0px, 복원 = 기준값)
  const HIDE_ORDER = [
    'memo',        // 비고 (185px): 첫 번째로 숨김
    'capture',     // 캡처폴더 (65px)
    'folder',      // 리뷰폴더 (65px)
    'taekhap',     // 택대 (45px)
    'round',       // 차수 (40px)
    'bank',        // 이체은행 (100px)
    'depositname', // 입금명 (140px)
    'income',      // 진행방식 (90px)
    'review',      // 리뷰타입 (50px)
    'formlink',    // 폼링크 (35px)
    'enddate',     // 부가정보 (110px)
  ];

  // 유연 축소 대상: 숨기지 않은 상태에서 비율 조정
  const FLEX_KEYS = ['campaign', 'tabname', 'product'];

  // 현재 숨길 컬럼 결정
  const hiddenSet = new Set();
  let remaining = availW - cbW - pad;

  // 숨기지 않은 컬럼들의 고정 너비 합산 함수
  const calcTotal = () => {
    return DASH_COL_DEFS.reduce((s, c) => {
      if (c.isCb || c.noScale || hiddenSet.has(c.key) || manualHidden.has(c.key)) return s;
      if (FLEX_KEYS.includes(c.key)) return s + (c.minPx || 60);
      return s + (baseW[c.key] || 0);
    }, 0);
  };

  // 순서대로 숨겨가며 예산 확보
  for (const key of HIDE_ORDER) {
    const needed = calcTotal();
    if (needed <= remaining) break; // 충분히 작아졌으면 중단
    hiddenSet.add(key);
  }

  // flex 컬럼에 남은 예산 배분
  const fixedSum = DASH_COL_DEFS.reduce((s, c) => {
    if (c.isCb || c.noScale || hiddenSet.has(c.key) || FLEX_KEYS.includes(c.key)) return s;
    return s + (baseW[c.key] || 0);
  }, 0);
  const flexBudget = Math.max(0, remaining - fixedSum);
  const flexBaseSum = FLEX_KEYS.reduce((s, k) => {
    if (hiddenSet.has(k)) return s;
    const col = DASH_COL_DEFS.find(c => c.key === k);
    return s + (col ? (baseW[k] || 0) : 0);
  }, 0);
  const flexRatio = flexBaseSum > 0 ? Math.min(1, flexBudget / flexBaseSum) : 1;

  // ── 비상: 모든 숨김 후에도 고정 컬럼 합이 remaining 초과 시 고정 컬럼도 비율 축소
  const allVisibleFixed = fixedSum;
  const allVisibleFlex  = FLEX_KEYS.reduce((s, k) => {
    if (hiddenSet.has(k)) return s;
    const col = DASH_COL_DEFS.find(c => c.key === k);
    return s + (col ? (col.minPx || 60) : 0);
  }, 0);
  const totalVisible = allVisibleFixed + allVisibleFlex;
  // 전체 비율 (remaining이 너무 좁으면 모든 컬럼을 비율 축소)
  const emergencyRatio = totalVisible > 0 && remaining < totalVisible
    ? Math.max(0.3, remaining / totalVisible) // 최소 30%까지만 축소
    : 1;

  // 최종 너비 적용
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb) return;
    if (col.noScale) return; // ★ info 등 1fr 처리 컬럼은 JS px 설정 제외
    if (manualHidden.has(col.key)) return; // 수동 숨김 열은 CSS !important가 처리
    let w;
    if (hiddenSet.has(col.key)) {
      w = 0;
    } else if (FLEX_KEYS.includes(col.key)) {
      const base = Math.max(col.minPx || 60, Math.round((baseW[col.key] || 0) * flexRatio));
      w = emergencyRatio < 1 ? Math.max(30, Math.round(base * emergencyRatio)) : base;
    } else {
      w = emergencyRatio < 1
        ? Math.max(col.minPx || 0, Math.round((baseW[col.key] || 0) * emergencyRatio))
        : (baseW[col.key] || 0);
    }
    root.style.setProperty(col.varName, w + 'px');
  });
}

/* ── ResizeObserver: 브라우저 가로 너비 변화 감지 ── */
let _dashResizeObs = null;
let _dashResizeTimer = null; // 디바운싱용 타이머

/** 디바운싱된 반응형 컬럼 너비 재계산 */
function _debouncedSyncCols() {
  if (_dashResizeTimer) clearTimeout(_dashResizeTimer);
  _dashResizeTimer = setTimeout(() => {
    _lastAppliedW = 0; // 강제 재계산
    _syncTabnameWidth(_getContainerWidth());
  }, 50); // 50ms 디바운싱 (resize 이벤트 폭발 방지 + DOM 크기 확정 대기)
}

function _attachDashResizeObserver() {
  if (_dashResizeObs) { _dashResizeObs.disconnect(); _dashResizeObs = null; }

  // ★ v10.5: document.documentElement(html 태그)를 observe
  // → window 크기 변화에 직접 반응, admin-body max-width 제한 우회
  const target = document.documentElement;

  if (typeof ResizeObserver !== 'undefined') {
    _dashResizeObs = new ResizeObserver((entries) => {
      // entries[0].contentRect.width = html 요소의 content 너비 = viewport width
      _debouncedSyncCols();
    });
    _dashResizeObs.observe(target);
  }

  // window resize 이벤트도 병행 등록 (ResizeObserver 미지원 브라우저 대비)
  if (!window._dashResizeListenerAttached) {
    window._dashResizeListenerAttached = true;
    window.addEventListener('resize', _debouncedSyncCols, { passive: true });
  }

  // 즉시 1회 실행
  _lastAppliedW = 0;
  _syncTabnameWidth(_getContainerWidth());
}

/** 컬럼 너비를 기본값으로 초기화 (CB 컬럼 제외) */
function resetColWidths() {
  const root = document.documentElement;
  DASH_COL_DEFS.forEach(col => {
    if (col.isCb) return; // CB 컬럼은 모드 토글이 관리
    root.style.removeProperty(col.varName);
  });
  try { localStorage.removeItem(COL_WIDTH_LS_KEY); } catch(_) {}
  _closeColResizePopup();
  _lastAppliedW = 0; // 강제 재계산
  _syncTabnameWidth(); // 초기화 후 반응형 재계산
  showToast('컬럼 너비가 기본값으로 초기화되었습니다.');
}

/* ══════════════════════════════════════════════════════════
   ★ 기능 1: 열 표시/숨김 토글
   ══════════════════════════════════════════════════════════ */
const COL_VIS_LS_KEY        = 'dashColHidden_v1';
const COL_VIS_SELECTED_KEY  = 'dashColSelected_v1'; // ★ 새: 숨김 대상 선택 저장
// 숨길 수 있는 열 정의 (closedcb, tabname, info 제외)
const COL_VIS_DEFS = [
  { key: 'product',  label: '상품명',     icon: 'fa-box'          },
  { key: 'capture',  label: '캡처폴더',   icon: 'fa-camera'       },
  { key: 'folder',   label: '리뷰폴더',   icon: 'fa-folder'       },
  { key: 'round',    label: '차수',       icon: 'fa-layer-group'  },
  { key: 'date',     label: '시작일',     icon: 'fa-calendar-day' },
  { key: 'time',     label: '주문시간대', icon: 'fa-clock'        },
  { key: 'review',   label: '리뷰타입',   icon: 'fa-star'         },
  { key: 'formlink', label: '폼링크',     icon: 'fa-link'         },
  { key: 'manager',  label: '담당',       icon: 'fa-user'         },
  { key: 'bar',      label: '진행률',     icon: 'fa-chart-bar'    },
  { key: 'nums',     label: '리뷰수',     icon: 'fa-check-double' },
  { key: 'payment',     label: '입금',     icon: 'fa-won-sign'     },
  { key: 'income',     label: '진행방식', icon: 'fa-coins'        },  // ★ v9.14
  { key: 'depositname',label: '입금명',   icon: 'fa-id-card'      },
  { key: 'bank',       label: '이체은행', icon: 'fa-landmark'     },
  { key: 'taekhap',    label: '택대',     icon: 'fa-truck'        },
  { key: 'memo',     label: '비고',       icon: 'fa-sticky-note'  },
  { key: 'enddate',  label: 'D-Day',      icon: 'fa-calendar-check' },
];

// ★ 숨김 대상으로 선택된 열 집합 (체크박스로 선택)
let _selectedHideCols = new Set();
// ★ 현재 열들이 실제로 숨겨진 상태인지 여부
let _colsHiddenActive = false;

/** localStorage에서 선택 열 + 토글 상태 로드 */
function _loadHiddenCols() {
  try {
    // 선택 열 목록 복원
    const rawSel = localStorage.getItem(COL_VIS_SELECTED_KEY);
    _selectedHideCols = rawSel ? new Set(JSON.parse(rawSel)) : new Set();
    // 이전 숨김 활성 상태 복원
    const rawHid = localStorage.getItem(COL_VIS_LS_KEY);
    _colsHiddenActive = rawHid === 'true';
  } catch(_) { _selectedHideCols = new Set(); _colsHiddenActive = false; }
  _applyHiddenCols();
}

/** 현재 토글 상태에 따라 body 클래스 적용 */
function _applyHiddenCols() {
  const body = document.body;
  // 기존 col-hidden 클래스 전부 제거
  const toRemove = [...body.classList].filter(c => c.startsWith('col-hidden-'));
  toRemove.forEach(c => body.classList.remove(c));
  // 숨김 활성 상태일 때만 선택된 열에 col-hidden 클래스 추가
  if (_colsHiddenActive) {
    _selectedHideCols.forEach(key => body.classList.add('col-hidden-' + key));
  }
  // 툴바 버튼 상태 업데이트
  const btn = document.getElementById('btnColVis');
  if (btn) {
    btn.classList.toggle('has-selected', _selectedHideCols.size > 0);
    btn.classList.toggle('is-cols-hidden', _colsHiddenActive);
    // 버튼 텍스트/아이콘 업데이트
    const iconEl = btn.querySelector('i');
    if (_colsHiddenActive) {
      if (iconEl) iconEl.className = 'fas fa-eye-slash';
      btn.childNodes[btn.childNodes.length - 1].textContent = ' 열 숨김 중';
    } else {
      if (iconEl) iconEl.className = 'fas fa-columns';
      btn.childNodes[btn.childNodes.length - 1].textContent = ' 열 설정';
    }
  }
  // 드롭다운이 열려있으면 토글 버튼 상태도 갱신
  _refreshDropdownToggleBtn();
}

/** 선택 열 목록 저장 */
function _saveSelectedCols() {
  try { localStorage.setItem(COL_VIS_SELECTED_KEY, JSON.stringify([..._selectedHideCols])); } catch(_) {}
}

/** 숨김 활성 상태 저장 */
function _saveHiddenCols() {
  try { localStorage.setItem(COL_VIS_LS_KEY, String(_colsHiddenActive)); } catch(_) {}
}

/** 드롭다운 내 토글 버튼 상태만 갱신 */
function _refreshDropdownToggleBtn() {
  const toggleBtn = document.getElementById('colVisToggleBtn');
  const statusBar = document.getElementById('colVisStatusBar');
  if (!toggleBtn) return;
  if (_colsHiddenActive) {
    toggleBtn.className = 'col-vis-toggle-btn is-hidden-mode';
    toggleBtn.innerHTML = '<i class="fas fa-eye"></i> 열 표시하기';
    if (statusBar) {
      statusBar.className = 'col-vis-toggle-status is-hidden';
      statusBar.innerHTML = '<i class="fas fa-eye-slash" style="font-size:.7rem"></i> ' + _selectedHideCols.size + '개 열 숨김 중';
    }
  } else {
    toggleBtn.className = 'col-vis-toggle-btn';
    toggleBtn.innerHTML = '<i class="fas fa-eye-slash"></i> 선택 열 숨기기';
    if (statusBar) {
      statusBar.className = 'col-vis-toggle-status';
      const cnt = _selectedHideCols.size;
      statusBar.innerHTML = cnt > 0
        ? '<i class="fas fa-check-square" style="font-size:.7rem"></i> ' + cnt + '개 열 선택됨'
        : '<i class="fas fa-info-circle" style="font-size:.7rem"></i> 숨길 열을 선택하세요';
    }
  }
  // 토글 버튼 비활성화 (선택 열 없을 때)
  toggleBtn.disabled = _selectedHideCols.size === 0;
  if (_selectedHideCols.size === 0) {
    toggleBtn.style.opacity = '0.4';
    toggleBtn.style.cursor  = 'not-allowed';
  } else {
    toggleBtn.style.opacity = '1';
    toggleBtn.style.cursor  = 'pointer';
  }
}

/** 열 설정 드롭다운 열기/닫기 */
function toggleColVisDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('colVisDropdown');
  if (!dd) return;
  const isOpen = dd.style.display !== 'none';
  if (isOpen) { dd.style.display = 'none'; return; }
  _buildColVisDropdown();
  dd.style.display = 'block';
}

/** 드롭다운 내용 빌드 */
function _buildColVisDropdown() {
  const dd = document.getElementById('colVisDropdown');
  if (!dd) return;

  const cnt = _selectedHideCols.size;
  const statusText = _colsHiddenActive
    ? '<i class="fas fa-eye-slash" style="font-size:.7rem"></i> ' + cnt + '개 열 숨김 중'
    : (cnt > 0
        ? '<i class="fas fa-check-square" style="font-size:.7rem"></i> ' + cnt + '개 열 선택됨'
        : '<i class="fas fa-info-circle" style="font-size:.7rem"></i> 숨길 열을 선택하세요');
  const statusClass = _colsHiddenActive ? 'col-vis-toggle-status is-hidden' : 'col-vis-toggle-status';

  let html = `<div class="col-vis-header">열 설정</div>`;
  html += `<div id="colVisStatusBar" class="${statusClass}">${statusText}</div>`;

  // 열 목록 체크박스 (숨김 대상 선택용)
  COL_VIS_DEFS.forEach(def => {
    const checked  = _selectedHideCols.has(def.key) ? 'checked' : '';
    const selClass = _selectedHideCols.has(def.key) ? 'col-vis-item is-selected' : 'col-vis-item';
    html += `<label class="${selClass}" id="colVisItem_${def.key}">
      <input type="checkbox" ${checked} onchange="onColVisSelect('${def.key}', this.checked)">
      <i class="fas ${def.icon}" style="width:13px;color:#3182f6;font-size:.72rem"></i>
      ${def.label}
    </label>`;
  });

  // 하단 버튼 영역
  const toggleClass  = _colsHiddenActive ? 'col-vis-toggle-btn is-hidden-mode' : 'col-vis-toggle-btn';
  const toggleLabel  = _colsHiddenActive
    ? '<i class="fas fa-eye"></i> 열 표시하기'
    : '<i class="fas fa-eye-slash"></i> 선택 열 숨기기';
  const toggleDisabled = cnt === 0 ? 'disabled style="opacity:.4;cursor:not-allowed"' : '';

  html += `
  <hr class="col-vis-sep">
  <div class="col-vis-footer">
    <button id="colVisToggleBtn" class="${toggleClass}" onclick="doColVisToggle()" ${toggleDisabled}>
      ${toggleLabel}
    </button>
    <button class="col-vis-save" onclick="saveColVisSel()">
      <i class="fas fa-save" style="font-size:.72rem"></i> 선택 저장
    </button>
    <button class="col-vis-reset" onclick="resetColVisSel()">
      <i class="fas fa-undo" style="font-size:.68rem"></i> 선택 초기화
    </button>
  </div>`;

  dd.innerHTML = html;
}

/** 체크박스 변경 → 숨김 대상 선택/해제 */
function onColVisSelect(key, checked) {
  if (checked) { _selectedHideCols.add(key); }
  else         { _selectedHideCols.delete(key); }
  // 아이템 강조 갱신
  const item = document.getElementById('colVisItem_' + key);
  if (item) item.className = checked ? 'col-vis-item is-selected' : 'col-vis-item';
  // 드롭다운 토글 버튼 상태 즉시 갱신
  _refreshDropdownToggleBtn();
  // 숨김 활성 중이면 즉시 적용
  if (_colsHiddenActive) { _applyHiddenCols(); }
}

/** 선택 저장 버튼 */
function saveColVisSel() {
  _saveSelectedCols();
  const cnt = _selectedHideCols.size;
  showToast(cnt > 0 ? cnt + '개 열 선택이 저장되었습니다.' : '선택이 초기화되었습니다.');
}

/** 열 숨기기/표시 토글 (메인 동작) */
function doColVisToggle() {
  if (_selectedHideCols.size === 0) {
    showToast('먼저 숨길 열을 선택해주세요.', 'warning');
    return;
  }
  _colsHiddenActive = !_colsHiddenActive;
  _applyHiddenCols();
  _saveHiddenCols();
  const msg = _colsHiddenActive
    ? _selectedHideCols.size + '개 열이 숨겨졌습니다.'
    : '열이 모두 표시됩니다.';
  showToast(msg);
}

/** 선택 초기화 */
function resetColVisSel() {
  _selectedHideCols.clear();
  _colsHiddenActive = false;
  _applyHiddenCols();
  _saveSelectedCols();
  _saveHiddenCols();
  // 드롭다운 재빌드
  _buildColVisDropdown();
  showToast('열 선택이 초기화되었습니다.');
}

// 구버전 함수명 호환 (혹시 다른 곳에서 호출 시)
function onColVisChange(key, visible) { onColVisSelect(key, visible); }
function resetColVis() { resetColVisSel(); }

// 드롭다운 외부 클릭 닫기 등록
document.addEventListener('click', function(e) {
  const dd = document.getElementById('colVisDropdown');
  if (dd && dd.style.display !== 'none') {
    const wrap = document.getElementById('colVisWrap');
    if (wrap && !wrap.contains(e.target)) dd.style.display = 'none';
  }
});

/* ══════════════════════════════════════════════════════════
   ★ 기능 2: 열 클릭 정렬
   ══════════════════════════════════════════════════════════ */
let _sortKey  = null;  // 현재 정렬 기준 열
let _sortDir  = 'asc'; // 'asc' | 'desc'

/** 헤더 클릭 → 정렬 실행 */
function _onColHeaderClick(e) {
  // 드래그 핸들 클릭은 무시
  if (e.target.classList.contains('col-drag-handle') ||
      e.target.closest('.col-drag-handle')) return;

  const cell = e.currentTarget;
  const key  = cell.dataset.sortKey;
  if (!key) return;

  if (_sortKey === key) {
    // 같은 열 재클릭: 방향 토글
    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _sortKey = key;
    _sortDir = 'asc';
  }

  // 헤더 아이콘 업데이트
  _updateSortHeaderIcons();
  // 모든 캠페인 블록 내 행 정렬
  _sortAllDashRows();
}

/** 헤더 셀 아이콘 업데이트 */
function _updateSortHeaderIcons() {
  document.querySelectorAll('.dash-col-header-cell[data-sort-key]').forEach(cell => {
    const key = cell.dataset.sortKey;
    cell.classList.remove('sort-asc', 'sort-desc');
    const icon = cell.querySelector('.col-sort-icon');
    if (icon) icon.innerHTML = '⇅';
    if (key === _sortKey) {
      cell.classList.add(_sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      if (icon) icon.innerHTML = _sortDir === 'asc' ? '▲' : '▼';
    }
  });
}

/** 정렬 키에 따른 행 값 추출 (숫자/문자 자동 판별) */
function _getSortVal(row, key) {
  const attr = 'sort' + key.charAt(0).toUpperCase() + key.slice(1);
  const val = row.dataset[attr];
  if (val === undefined || val === null) return _sortDir === 'asc' ? '🿿' : '';
  // 숫자 열
  if (['bar','nums','enddate'].includes(key)) return parseFloat(val) || 0;
  return val;
}

/** 모든 행 정렬 (v11.0: 플랫 테이블) */
function _sortAllDashRows() {
  const wrap = document.getElementById('dashboardWrap');
  if (!wrap) return;
  // ★ v11.0: 플랫 테이블 컨테이너 사용
  const table = wrap.querySelector('.dash-flat-table') || wrap.querySelector('#dashboardScrollInner');
  if (!table) return;
  const rows = [...table.querySelectorAll('.dash-tab-row:not(.dash-tab-row-monthly)')];
  if (rows.length < 2) return;
  rows.sort((a, b) => {
    const av = _getSortVal(a, _sortKey);
    const bv = _getSortVal(b, _sortKey);
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv;
    } else {
      cmp = String(av).localeCompare(String(bv), 'ko');
    }
    return _sortDir === 'asc' ? cmp : -cmp;
  });
  const monthlyRows = [...table.querySelectorAll('.dash-tab-row-monthly')];
  rows.forEach(r => table.appendChild(r));
  monthlyRows.forEach(r => table.appendChild(r));
}

/** 정렬 초기화 (새로고침 시 호출) */
function _resetSort() {
  _sortKey = null;
  _sortDir = 'asc';
  document.querySelectorAll('.dash-col-header-cell[data-sort-key]').forEach(cell => {
    cell.classList.remove('sort-asc', 'sort-desc');
    const icon = cell.querySelector('.col-sort-icon');
    if (icon) icon.innerHTML = '⇅';
  });
}

/* ══════════════════════════════════════════════════════════
   ★ 기능 3: 메모 미리보기 툴팁
   ══════════════════════════════════════════════════════════ */
// 탭키별 메모 최근 내용 캐시 { tabKey: "최근메모텍스트" }
const _memoPreviewCache = {};
let _memoTooltipTimer = null;

/** 메모 버튼에 hover 이벤트 등록 (대시보드 렌더 후 호출) */
function _bindMemoPreviewTooltips() {
  const wrap = document.getElementById('dashboardWrap');
  if (!wrap) return;

  // 위임 방식으로 등록 (행이 동적으로 추가되어도 동작)
  wrap.addEventListener('mouseenter', _onMemoMouseEnter, true);
  wrap.addEventListener('mouseleave', _onMemoMouseLeave, true);
}

function _onMemoMouseEnter(e) {
  const btn = e.target.closest('.btn-tab-memo.has-memo');
  if (!btn) return;

  // onclick 속성에서 tabKey 추출 (sheetId + tabName)
  const onclickStr = btn.getAttribute('onclick') || '';
  const m = onclickStr.match(/openMemoPanel\('([^']+)'\s*,\s*'([^']+)'/);
  if (!m) return;
  const sheetId = m[1];
  const tabName = m[2];
  const tabKey  = sheetId + '||' + tabName;

  clearTimeout(_memoTooltipTimer);
  _memoTooltipTimer = setTimeout(async () => {
    const tooltip = document.getElementById('memoPreviewTooltip');
    if (!tooltip) return;

    // 캐시 없으면 GAS 호출
    if (!_memoPreviewCache[tabKey]) {
      tooltip.textContent = '📝 로딩 중...';
      _showMemoTooltipAt(tooltip, btn);
      try {
        const data = await gasGet({ action: 'getMemo', sheetId, tabName });
        const msgs = (data && data.messages) ? data.messages : [];
        if (msgs.length === 0) {
          _memoPreviewCache[tabKey] = '(메모 없음)';
        } else {
          const last = msgs[msgs.length - 1];
          const role = last.role === 'admin' ? '관리자' : 'AE';
          const text = (last.text || '').slice(0, 60) + ((last.text||'').length > 60 ? '…' : '');
          _memoPreviewCache[tabKey] = `💬 ${role}: ${text}`;
        }
      } catch(_) {
        _memoPreviewCache[tabKey] = '(불러오기 실패)';
      }
    }

    // 툴팁이 아직 표시 중이면 내용 업데이트
    if (tooltip.style.display !== 'none') {
      tooltip.textContent = _memoPreviewCache[tabKey] || '';
      _showMemoTooltipAt(tooltip, btn);
    }
  }, 400); // 400ms 딜레이
}

function _onMemoMouseLeave(e) {
  const btn = e.target.closest('.btn-tab-memo');
  if (!btn) return;
  clearTimeout(_memoTooltipTimer);
  const tooltip = document.getElementById('memoPreviewTooltip');
  if (tooltip) tooltip.style.display = 'none';
}

function _showMemoTooltipAt(tooltip, anchor) {
  const rect = anchor.getBoundingClientRect();
  tooltip.style.display = 'block';
  tooltip.style.left = (rect.left + window.scrollX) + 'px';
  tooltip.style.top  = (rect.top  + window.scrollY - tooltip.offsetHeight - 10) + 'px';
  // 화면 오른쪽 초과 방지
  const tw = tooltip.offsetWidth;
  const overRight = rect.left + tw - window.innerWidth + 12;
  if (overRight > 0) {
    tooltip.style.left = (rect.left + window.scrollX - overRight) + 'px';
  }
}

// 메모 캐시 무효화 (메모 전송 후 호출)
function _invalidateMemoCache(tabKey) {
  delete _memoPreviewCache[tabKey];
}

/**
 * 컬럼 헤더 요소 빌드
 * DASH_COL_DEFS 인덱스: 0=closedcb, 1=tabname, 2=product, ... 16=memo, 17=enddate, 18=info(⚙)
 * 데이터 행 child 인덱스도 동일 (0=closed-cb-wrap, 1=탭명, ...)
 */
function _buildColHeader(container) {
  // colIdx = DASH_COL_DEFS 인덱스와 1:1 대응
  const CELLS = [
    // isCb 컬럼: 평소 0px(숨김) → 모드 진입 시 28px
    { colIdx: 0,  inner: '<i class="fas fa-archive"      style="font-size:.6rem;color:#3182f6"></i>',  style: 'justify-content:center', title: '마감 선택',    cbClass: 'closed-cb-wrap' },
    { colIdx: 1,  inner: '<i class="fas fa-building" style="font-size:.55rem;color:#0ca678"></i> 캠페인', style: '' },  // ★ v11.0: 엑셀형 플랫 UI
    { colIdx: 2,  inner: '<i class="fas fa-tag" style="font-size:.55rem"></i> 탭명',              style: '' },
    { colIdx: 3,  inner: '<i class="fas fa-box" style="font-size:.55rem"></i> 상품명',            style: '' },
    { colIdx: 4,  inner: '<i class="fas fa-camera" style="font-size:.55rem;color:#3182f6"></i> 캡처폴더', style: 'justify-content:center', title: '주문캡처 저장 폴더' },
    { colIdx: 5,  inner: '<i class="fas fa-folder" style="font-size:.55rem;color:#F59E0B"></i> 리뷰폴더',  style: 'justify-content:center', title: '리뷰 저장 폴더'    },
    { colIdx: 6,  inner: '<i class="fas fa-layer-group" style="font-size:.55rem;color:#1b64da"></i> 차수',  style: 'justify-content:center', title: '진행 차수'         },
    { colIdx: 7,  inner: '<i class="fas fa-calendar-day" style="font-size:.55rem"></i> 시작일',   style: '' },
    { colIdx: 8,  inner: '<i class="fas fa-clock" style="font-size:.55rem"></i> 주문시간대',      style: '' },
    { colIdx: 9,  inner: '<i class="fas fa-star" style="font-size:.55rem"></i> 리뷰타입',         style: '' },
    { colIdx: 10, inner: '<i class="fas fa-link" style="font-size:.55rem;color:#3182f6"></i>',    style: 'justify-content:center', title: '구매양식 제출링크 생성' },
    { colIdx: 11, inner: '<i class="fas fa-user" style="font-size:.55rem"></i> 담당',             style: 'justify-content:center' },
    { colIdx: 12, inner: '<i class="fas fa-chart-bar" style="font-size:.55rem"></i> 진행률',      style: '' },
    { colIdx: 13, inner: '<i class="fas fa-check-double" style="font-size:.55rem"></i> 리뷰',     style: 'justify-content:flex-end' },
    { colIdx: 14, inner: '<i class="fas fa-won-sign" style="font-size:.55rem"></i> 입금',         style: 'justify-content:center' },
    { colIdx: 15, inner: '<i class="fas fa-receipt" style="font-size:.55rem;color:#3182f6"></i> 진행방식', style: 'justify-content:center', title: '진행방식 (현금/사업자현영/소득신고)' },
    { colIdx: 16, inner: '<i class="fas fa-signature" style="font-size:.55rem;color:#1D4ED8"></i> 입금명',  style: 'justify-content:center', title: '입금자명'  },
    { colIdx: 17, inner: '<i class="fas fa-university" style="font-size:.55rem;color:#92400E"></i> 이체은행', style: 'justify-content:center', title: '이체 은행' },
    { colIdx: 18, inner: '<i class="fas fa-truck" style="font-size:.55rem"></i> 택대',            style: 'justify-content:center' },
    { colIdx: 19, inner: '<i class="fas fa-sticky-note" style="font-size:.55rem;color:#F59E0B"></i> 비고', style: '' },
    { colIdx: 20, inner: '<i class="fas fa-info-circle" style="font-size:.55rem;color:#3182f6"></i> 부가정보', style: 'justify-content:center', title: '대량건·배송타입·마감D-Day 등 부가 정보' },
    { colIdx: 21, inner: '<i class="fas fa-cog" style="font-size:.55rem"></i>', style: 'justify-content:center' },  // ⚙ 마지막
  ];

  container.innerHTML = '';

  // 정렬 가능한 열 키 목록
  const SORTABLE_KEYS = new Set(['campaign','tabname','product','date','time','review','manager','bar','nums','payment','taekhap','enddate']);

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

    // 정렬 아이콘 추가 (정렬 가능한 열만)
    if (colDef && SORTABLE_KEYS.has(colDef.key)) {
      const sortIcon = document.createElement('span');
      sortIcon.className = 'col-sort-icon';
      sortIcon.innerHTML = '⇅';
      div.appendChild(sortIcon);
      div.dataset.sortKey = colDef.key;
      div.addEventListener('click', _onColHeaderClick);
    }

    // D-Day·⚙ 컬럼도 드래그 리사이즈 지원 (noResize 플래그 없음)
    if (!c.noResize && !colDef?.noResize && colDef) {
      div.dataset.colKey = colDef.key;
      div.dataset.colIdx = c.colIdx;

      // 드래그 핸들 div (헤더 셀 우측 경계)
      const handle = document.createElement('div');
      handle.className = 'col-drag-handle';
      handle.title =                      colDef.key === 'closedcb' ? '마감 체크박스 너비 조절' : '';
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

/**
 * 드래그 중 현재 컬럼의 최대 허용 너비 계산
 * = 컨테이너 너비 - padding - CB너비 - (다른 모든 표시 컬럼 합계) - ⚙최소너비
 * → ⚙(info) 컬럼이 항상 minPx 이상을 유지하도록 보장
 */
function _calcDragMaxW(draggingColDef) {
  const availW = _getContainerWidth();
  const pad = 28;
  const root = document.documentElement;

  // ⚙(info) 컬럼의 최소너비
  const infoDef = DASH_COL_DEFS.find(c => c.noScale);
  const infoMin = infoDef ? (infoDef.minPx || 90) : 90;

  // CB 컬럼 너비 합
  const cbW = DASH_COL_DEFS.filter(c => c.isCb).reduce((s, c) => {
    return s + (parseInt(root.style.getPropertyValue(c.varName)) ||
                parseInt(getComputedStyle(root).getPropertyValue(c.varName)) || 0);
  }, 0);

  // 드래그 중인 컬럼 제외, noScale·isCb 제외한 나머지 컬럼 너비 합
  const othersW = DASH_COL_DEFS.reduce((s, c) => {
    if (c.isCb || c.noScale) return s;          // CB·⚙ 제외
    if (c.key === draggingColDef.key) return s; // 드래그 컬럼 제외
    return s + _getColWidth(c);
  }, 0);

  // 드래그 컬럼의 최대 너비 = 전체 - 패딩 - CB - 다른컬럼 - ⚙최소
  return Math.max(draggingColDef.minPx, availW - pad - cbW - othersW - infoMin);
}

/** 드래그 시작 */
let _dragMaxW = Infinity; // 드래그 중 상한 너비

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
  _dragMaxW    = _calcDragMaxW(colDef); // ★ 상한 너비 계산 (⚙ 보호)

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
  // ★ 하한(minPx) + 상한(_dragMaxW) 양방향 클램프
  let newW = Math.min(_dragMaxW, Math.max(_dragColDef.minPx, _dragStartW + delta));

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
  // ★ 종료 시에도 동일하게 상한 적용
  let newW = Math.min(_dragMaxW, Math.max(_dragColDef.minPx, _dragStartW + delta));

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
  _dragMaxW   = Infinity; // 상한 초기화

  document.removeEventListener('mousemove', _onColDragMove);
  document.removeEventListener('mouseup',   _onColDragEnd);

  // 드래그 후 반응형 재계산 (사용자가 직접 늘린 경우 뷰포트 대비 재조정)
  _lastAppliedW = 0;
  _syncTabnameWidth();
}

/** (호환성 stub - 이전 팝업 방식 제거 후 빈 함수 유지) */
function _closeColResizePopup() {}

// 페이지 로드 시 저장된 너비 즉시 적용 + window resize 리스너 등록
// (ResizeObserver는 대시보드 렌더 후 _attachDashResizeObserver에서 등록)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    loadColWidths(); _loadHiddenCols();
  });
} else {
  requestAnimationFrame(() => {
    loadColWidths(); _loadHiddenCols();
  });
}

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

// ── 마감업체 숨김: 모든 탭이 완료인 캠페인 전체 숨김 ──
// ★ v9.13 fix: 기본값 true (마감 캠페인 기본 숨김), localStorage에 상태 저장
let hideClosedCampMode = localStorage.getItem("rapp_hide_closed_camp") !== "0"; // 기본 true
function toggleHideClosedCamp() {
  hideClosedCampMode = !hideClosedCampMode;
  localStorage.setItem("rapp_hide_closed_camp", hideClosedCampMode ? "1" : "0");
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
let _closedRoundSet = new Set(); // ★ 차수 단위 마감 Set: "sheetId||tabName||round"

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
  _lastAppliedW = 0; // 강제 재계산
  _syncTabnameWidth(); // 체크박스 열(28px) 추가/제거에 따라 컬럼 너비 재계산
}

// [실행] 버튼 → 변경 내역 확인 후 팝업
// ★ 차수별 마감 지원: tabKey가 "sheetId||tabName||round" 형태이면 차수 단위 마감
function execClosed() {
  const cbs = document.querySelectorAll("#dashboardWrap .closed-cb");
  if (!cbs.length) { showToast("표시된 탭이 없습니다.", true); return; }

  let toClose = [], toOpen = [];
  cbs.forEach(cb => {
    const key = cb.dataset.tabkey || "";
    const parts = key.split("||");
    const tabName = (parts[1] || "").trim();
    const round = (parts[2] || "").trim();
    const displayLabel = round ? `${tabName} [${round}]` : tabName;

    // ★ 차수가 있으면 _closedRoundSet으로 비교, 없으면 _closedSet으로 비교
    if (round) {
      if (cb.checked  && !_closedRoundSet.has(key)) toClose.push({ key, tabName: displayLabel, round });
      if (!cb.checked &&  _closedRoundSet.has(key)) toOpen.push({ key, tabName: displayLabel, round });
    } else {
      if (cb.checked  && !_closedSet.has(key)) toClose.push({ key, tabName: displayLabel });
      if (!cb.checked &&  _closedSet.has(key)) toOpen.push({ key, tabName: displayLabel });
    }
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
    el.innerHTML = `<i class="fas fa-archive" style="color:#1b64da;font-size:.75rem"></i> ${tabName} → <b>마감</b>`;
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

// 팝업 확인 → 서버에 저장 (★ 차수 단위 마감 지원)
async function confirmClosed() {
  document.getElementById("closedConfirmOverlay").classList.remove("open");

  const cbs = document.querySelectorAll("#dashboardWrap .closed-cb");
  const items = [];
  cbs.forEach(cb => {
    const key = cb.dataset.tabkey || "";
    if (!key) return;
    const parts = key.split("||");
    const sheetId = parts[0] || "";
    const tabName = parts[1] || "";
    const round   = parts[2] || "";  // ★ 차수 (있으면 차수 단위 마감)

    if (round) {
      // 차수 단위: _closedRoundSet으로 비교
      const wasClosed = _closedRoundSet.has(key);
      const isChecked = cb.checked;
      if (isChecked === wasClosed) return;
      items.push({ sheetId, tabName, round, isClosed: isChecked });
    } else {
      // 탭 전체: _closedSet으로 비교
      const tabKey2 = sheetId + "||" + tabName;
      const wasClosed = _closedSet.has(tabKey2);
      const isChecked = cb.checked;
      if (isChecked === wasClosed) return;
      items.push({ sheetId, tabName, isClosed: isChecked });
    }
  });

  if (!items.length) { _exitClosedMode(); return; }

  // 낙관적 업데이트
  items.forEach(({ sheetId, tabName, round, isClosed }) => {
    if (round) {
      const roundKey = (sheetId || "") + "||" + (tabName || "") + "||" + round;
      if (isClosed) _closedRoundSet.add(roundKey);
      else          _closedRoundSet.delete(roundKey);
    } else {
      const key = (sheetId || "") + "||" + (tabName || "");
      if (isClosed) _closedSet.add(key);
      else          _closedSet.delete(key);
    }
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
      msg += "동기화 후 적용됩니다.";
      showToast("✅ " + msg);

      // ★ 차수 마감 시 마감 이동 확인 알람 표시
      const closedRoundItems = items.filter(i => i.isClosed && i.round);
      if (closedRoundItems.length > 0) {
        _showArchiveRoundConfirm(closedRoundItems);
      }
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

// ★ 차수 마감 후 마감 확인 알람
function _showArchiveRoundConfirm(closedRoundItems) {
  // 기존 알람 제거
  document.getElementById('archiveRoundConfirmBanner')?.remove();

  const roundLabels = closedRoundItems.map(i => `${i.tabName} / ${i.round}`);
  const summary = closedRoundItems.length <= 3
    ? roundLabels.join(', ')
    : `${roundLabels.slice(0, 2).join(', ')} 외 ${closedRoundItems.length - 2}건`;

  const banner = document.createElement('div');
  banner.id = 'archiveRoundConfirmBanner';
  banner.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9998;background:#FEF3C7;border:1px solid #F59E0B;border-radius:12px;padding:14px 18px;max-width:420px;box-shadow:0 8px 24px rgba(0,0,0,.15);animation:slideInR .3s ease';
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px">
      <i class="fas fa-exclamation-triangle" style="color:#D97706;font-size:1.1rem;margin-top:2px"></i>
      <div style="flex:1">
        <div style="font-size:.82rem;font-weight:600;color:#92400E;margin-bottom:4px">마감 차수 처리 안내</div>
        <div style="font-size:.75rem;color:#78350F;margin-bottom:10px">
          <strong>${summary}</strong> 차수가 마감되었습니다.<br>
          마감으로 이동하시겠습니까? (다음 빌드 시 자동 제외됩니다)
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="_archiveClosedRoundsNow()" style="padding:5px 12px;background:#4593fc;color:#fff;border:none;border-radius:6px;font-size:.73rem;font-weight:600;cursor:pointer">
            <i class="fas fa-archive" style="margin-right:3px"></i>마감 이동
          </button>
          <button onclick="_dismissArchiveConfirm()" style="padding:5px 12px;background:#fff;color:#6B7280;border:1px solid #D1D5DB;border-radius:6px;font-size:.73rem;cursor:pointer">
            나중에
          </button>
        </div>
      </div>
      <button onclick="_dismissArchiveConfirm()" style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:1rem;padding:0;line-height:1">&times;</button>
    </div>
  `;
  document.body.appendChild(banner);

  // 글로벌에 차수 정보 저장
  window._pendingArchiveRoundItems = closedRoundItems;

  // 30초 후 자동 닫기
  window._archiveConfirmTimer = setTimeout(() => {
    _dismissArchiveConfirm();
  }, 30000);
}

function _dismissArchiveConfirm() {
  clearTimeout(window._archiveConfirmTimer);
  const banner = document.getElementById('archiveRoundConfirmBanner');
  if (banner) {
    banner.style.opacity = '0';
    banner.style.transform = 'translateX(20px)';
    banner.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => banner.remove(), 200);
  }
  window._pendingArchiveRoundItems = null;
}

async function _archiveClosedRoundsNow() {
  const items = window._pendingArchiveRoundItems || [];
  _dismissArchiveConfirm();

  if (items.length === 0) return;

  const tabs = items.map(i => ({ sheetId: i.sheetId, tabName: i.tabName, round: i.round }));

  try {
    showToast(`${tabs.length}건 차수 마감 처리 중...`, 'info');
    const res = await fetch(API_BASE_URL + '/api/archive/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
      body: JSON.stringify({ tabs, reason: 'round_closed_manual' }),
    }).then(r => r.json());

    if (res.ok) {
      showToast(`✅ 마감 완료: ${res.archivedTabs || tabs.length}건, ${res.archivedRows || 0}행 이동`, 'success');
      await loadTabDashboard(); // 새로고침
    } else {
      showToast(res.error || '마감 실패', 'error');
    }
  } catch (err) {
    showToast('마감 요청 실패: ' + err.message, 'error');
  }
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

/**
 * ★ GAS 저장 성공 후 _lastDashData의 해당 탭 필드만 교체 → 로딩 없이 즉시 재렌더
 * @param {string} sheetId   - 탭의 sheetId
 * @param {string} tabName   - 탭명
 * @param {object} patch     - { displayName, manager, timeRange, taekhap, reviewType, paymentType, ... }
 */
function _patchTabAndRerender(sheetId, tabName, patch) {
  if (!_lastDashData || !_lastDashData.stats) {
    // 캐시 없으면 전체 새로고침 (예외 상황)
    loadAdminDashboard();
    return;
  }
  // stats 배열 → campaigns → tabs 탐색해서 해당 탭 업데이트
  _lastDashData.stats.forEach(c => {
    (c.tabs || []).forEach(t => {
      if (t.sheetId === sheetId && t.tab === tabName) {
        Object.assign(t, patch);
      }
    });
  });
  renderDashboard(_lastDashData);
}

// ═══════════════════════════════════════════════════════
// ★ 시작일 수동 수정 — localStorage 기반
//   키: rapp_manual_startdate  /  값: { tabKey: "YY.MM.DD" }
//   동기화/새로고침 후에도 유지 (원본 인덱스 덮어쓰지 않음)
// ═══════════════════════════════════════════════════════
const _MANUAL_SD_KEY = "rapp_manual_startdate";

function _loadManualSDStore() {
  try { return JSON.parse(localStorage.getItem(_MANUAL_SD_KEY) || "{}"); } catch(_){ return {}; }
}
function _getManualStartDate(tabKey) {
  return _loadManualSDStore()[tabKey] || null;
}
function _setManualStartDate(tabKey, val) {
  const store = _loadManualSDStore();
  if (val) store[tabKey] = val;
  else delete store[tabKey];
  try { localStorage.setItem(_MANUAL_SD_KEY, JSON.stringify(store)); } catch(_) {}
}

// ── 시작일 편집 팝업 ──────────────────────────────────
let _sdpTabKey = null;   // 현재 편집 중인 tabKey
let _sdpRawSD  = null;   // 인덱스 원본 startDate

function openStartDatePopup(event, el) {
  event.stopPropagation();
  _sdpTabKey = el.dataset.tabkey || null;
  _sdpRawSD  = el.dataset.rawsd  || "";
  if (!_sdpTabKey) return;

  // 현재 표시값 (수동값 우선)
  const manualVal = _getManualStartDate(_sdpTabKey);
  const currentVal = manualVal || _sdpRawSD || "";

  // 년도 select: 현재연도 -3 ~ +3
  const nowYear = new Date().getFullYear();
  const yearSel = document.getElementById("sdpYear");
  const monSel  = document.getElementById("sdpMonth");
  const daySel  = document.getElementById("sdpDay");

  // 파싱: YY.MM.DD(요일) 또는 YY.MM.DD 또는 YYYY.MM.DD
  let initY = nowYear % 100, initM = 1, initD = 1;
  // 요일 포함 패턴 먼저 시도
  let m = currentVal.match(/^(\d{2})\.(\d{1,2})\.(\d{1,2})\([월화수목금토일]\)$/);
  if (!m) m = currentVal.match(/^(\d{2,4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/);
  if (m) {
    initY = parseInt(m[1], 10);
    if (initY >= 100) initY = initY % 100; // 4자리면 2자리로
    initM = parseInt(m[2], 10);
    initD = parseInt(m[3], 10);
  }

  // 년도 옵션: 20 ~ 99 (2020~2099)
  yearSel.innerHTML = "";
  for (let y = 20; y <= 35; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = "20" + String(y).padStart(2,"0") + "년";
    if (y === initY) opt.selected = true;
    yearSel.appendChild(opt);
  }

  // 월 옵션
  monSel.innerHTML = "";
  for (let mo = 1; mo <= 12; mo++) {
    const opt = document.createElement("option");
    opt.value = mo;
    opt.textContent = mo + "월";
    if (mo === initM) opt.selected = true;
    monSel.appendChild(opt);
  }

  // 일 옵션
  _rebuildDayOptions(initY + 2000, initM, initD);

  // 월 변경 시 일 옵션 재구성
  monSel.onchange = () => {
    const curD = parseInt(daySel.value, 10);
    _rebuildDayOptions(parseInt(yearSel.value, 10) + 2000, parseInt(monSel.value, 10), curD);
  };
  yearSel.onchange = () => {
    const curD = parseInt(daySel.value, 10);
    _rebuildDayOptions(parseInt(yearSel.value, 10) + 2000, parseInt(monSel.value, 10), curD);
  };

  // 팝업 위치: 클릭 요소 기준 아래쪽
  const popup = document.getElementById("startDatePopup");
  popup.classList.add("visible");
  const rect = el.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  // 화면 벗어나면 보정
  const pw = 230;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + 180 > window.innerHeight - 8) top = rect.top - 180;
  popup.style.top  = top  + "px";
  popup.style.left = left + "px";

  // 외부 클릭 시 닫기
  setTimeout(() => { document.addEventListener("click", _sdpOutsideClick, true); }, 10);
}

function _rebuildDayOptions(fullYear, month, selectDay) {
  const daySel = document.getElementById("sdpDay");
  const maxDay = new Date(fullYear, month, 0).getDate();
  daySel.innerHTML = "";
  for (let d = 1; d <= maxDay; d++) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d + "일";
    if (d === selectDay) opt.selected = true;
    daySel.appendChild(opt);
  }
}

function applyStartDate() {
  if (!_sdpTabKey) return;
  const y  = String(parseInt(document.getElementById("sdpYear").value, 10)).padStart(2,"0");
  const mo = String(parseInt(document.getElementById("sdpMonth").value, 10)).padStart(2,"0");
  const d  = String(parseInt(document.getElementById("sdpDay").value, 10)).padStart(2,"0");
  const newVal = `${y}.${mo}.${d}`; // YY.MM.DD 형식
  _setManualStartDate(_sdpTabKey, newVal);
  closeStartDatePopup();
  _reRenderDashboard();
  showToast(`✅ 시작일 수정: ${newVal} (수동 설정, 갱신 후에도 유지됨)`);
}

function resetStartDate() {
  if (!_sdpTabKey) return;
  _setManualStartDate(_sdpTabKey, null); // 수동값 삭제 → 원본 인덱스값 복원
  closeStartDatePopup();
  _reRenderDashboard();
  showToast("↩️ 시작일 초기화 — 원본값으로 복원됨");
}

function closeStartDatePopup() {
  document.getElementById("startDatePopup").classList.remove("visible");
  document.removeEventListener("click", _sdpOutsideClick, true);
  _sdpTabKey = null;
}

function _sdpOutsideClick(e) {
  const popup = document.getElementById("startDatePopup");
  if (popup && !popup.contains(e.target)) {
    closeStartDatePopup();
  }
}

// 컬럼 헤더 sticky top 위치 보정
// sticky 요소들의 실제 '점유 높이'를 offsetHeight 기준으로 합산
function _fixColHeaderTop() {
  requestAnimationFrame(() => {
    const colHdr = document.getElementById("dashColHeader");
    if (!colHdr) return;

    const appHdr     = document.querySelector("#screenAdmin .app-header");
    const sectionHdr = document.querySelector("#tab-dashboard .admin-section-header");
    // offsetHeight = 렌더된 실제 픽셀 높이 (스크롤 위치 무관)
    const appH     = appHdr     ? appHdr.offsetHeight     : 0;
    const sectionH = sectionHdr ? sectionHdr.offsetHeight : 0;
    colHdr.style.top = (appH + sectionH) + "px";
  });
}

// ── 관리자 화면 sticky 위치 전체 보정 ──
// app-header 높이를 측정해 section-header · col-header 순으로 top 값을 확정
// _uiLayoutTopLocked = true 이면 사용자가 수동 지정한 top 값이 있으므로 덮어쓰지 않음
window._uiLayoutTopLocked = false;

function _fixStickyPositions() {
  // 사용자가 UI 편집 모드에서 top 값을 직접 저장한 경우 자동 재계산 스킵
  if (window._uiLayoutTopLocked) return;

  requestAnimationFrame(() => {
    const sectionHdr = document.querySelector("#tab-dashboard .admin-section-header");
    const searchBar  = document.getElementById("dashSearchBar");
    const colHdr     = document.getElementById("dashColHeader");

    // ① 섹션 헤더 → 0px
    if (sectionHdr) sectionHdr.style.top = "0px";

    // ② 검색창 → 0px
    if (searchBar) searchBar.style.top = "0px";

    // ③ 컬럼 헤더 → 0px
    if (colHdr) colHdr.style.top = "0px";
  });
}

// ═══════════════════════════════════════════════════════
// ★ 가로 스크롤 동기화: 헤더와 테이블 스크롤 연동
// ═══════════════════════════════════════════════════════
function _syncHorizontalScroll() {
  const colHdr = document.getElementById("dashColHeader");
  const scrollOuter = document.getElementById("dashboardScrollOuter");
  
  if (!colHdr || !scrollOuter) return;

  // 테이블 스크롤 → 헤더 스크롤
  scrollOuter.addEventListener('scroll', function() {
    colHdr.scrollLeft = this.scrollLeft;
  });

  // 헤더 스크롤 → 테이블 스크롤
  colHdr.addEventListener('scroll', function() {
    scrollOuter.scrollLeft = this.scrollLeft;
  });
}


// ═══════════════════════════════════════════════════════
// ★ 빠른 인라인 편집 (빈 셀 클릭 시)
// ═══════════════════════════════════════════════════════
let _qePopup = null; // 현재 열려있는 팝업
let _qePopupCell = null; // 현재 팝업을 연 셀 (토글 판단용)

function _closeQePopup() {
  if (_qePopup) { _qePopup.remove(); _qePopup = null; }
  _qePopupCell = null;
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
  const round       = tc.tcRound     || tc.round || ""; // ★ 차수 (차수별 행에서 tcRound로 주입됨)
  const ncMode      = !!tc.ncMode;  // ★ 네이버+쿠팡 모드 플래그

  if (!sheetId || !tabName) {
    showToast("링크 생성 실패: sheetId 또는 tabName이 없습니다.", "error");
    return;
  }

  // gid: sheetUrl에서 추출
  const gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "";

  // gasUrl은 URL에 포함하지 않음 → 링크를 짧고 깔끔하게 유지
  // 리뷰어 접속 시 BOOTSTRAP_GAS_URL(하드코딩) 또는 localStorage에서 자동 확보
  // ★ base: 항상 search.html 고정 (관리자/리뷰어 페이지 분리)
  const base   = location.origin + location.pathname.replace(/[^/]*$/, "") + "search.html";
  const params = new URLSearchParams({
    s: sheetId,    // sheetId 단축
    g: gid,        // gid 단축
    t: tabName,    // tabName 단축
    d: displayName, // displayName 단축
    rd: round       // ★ 차수 (search.html에서 폴더 라우팅에 사용)
  });
  // nc 모드 플래그 추가
  if (ncMode) params.set("nc", "1");
  // 빈 값 제거 (URL 최소화)
  [...params.keys()].forEach(k => { if (k !== "nc" && !params.get(k)) params.delete(k); });
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
 * ★ 단축 URL 생성 후 클립보드 복사
 * - GAS createShort 호출 → 6자리 코드 획득
 * - API서버/r/CODE 형태로 복사 (카카오톡 OG 미리보기 지원)
 * - GAS 미배포(구버전) 시 기존 긴 URL 복사로 폴백
 */
async function copyShortLink(btnEl) {
  // tcData 파싱
  let tc = {};
  try {
    const raw = btnEl.getAttribute("data-tc") || "";
    tc = JSON.parse(raw.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
  } catch (e) {
    showToast("링크 생성 실패: 데이터 파싱 오류", "error");
    return;
  }

  const sheetId     = tc.sheetId     || "";
  const sheetUrl    = tc.sheetUrl    || "";
  const tabName     = tc.tabName     || "";
  const displayName = tc.displayName || "";
  const tcRound     = tc.tcRound     || tc.round || ""; // ★ 차수
  if (!sheetId || !tabName) {
    showToast("링크 생성 실패: sheetId 또는 tabName이 없습니다.", "error");
    return;
  }

  const gidMatch = sheetUrl.match(/[?&]gid=(\d+)/);
  const gid = tc.tabGid || (gidMatch ? gidMatch[1] : "");  // ★ tabGid 우선
  const incomeType = tc.incomeType || "";  // ★ v9.14

  // 긴 URL (폴백용) — round + incomeType 포함
  const base = location.origin + location.pathname.replace(/[^/]*$/, "") + "search.html";
  const longParams = new URLSearchParams({ s: sheetId, g: gid, t: tabName, d: displayName, rd: tcRound, ic: incomeType });
  [...longParams.keys()].forEach(k => { if (!longParams.get(k)) longParams.delete(k); });
  const longUrl = base + "?" + longParams.toString();

  // 로딩 상태 표시
  const origHtml = btnEl.innerHTML;
  btnEl.classList.add("loading");
  btnEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
  btnEl.disabled = true;

  let shortUrl = null;
  try {
    // ★ 서버 API 우선 사용 → GAS 폴백
    const apiBase = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : null;
    if (apiBase) {
      const resp = await fetch(apiBase + '/api/short/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(_getAuthHeaders ? _getAuthHeaders() : {}) },
        body: JSON.stringify({ s: sheetId, g: gid, t: tabName, d: displayName, rd: tcRound })
      });
      const data = await resp.json();
      if (data && data.success && data.code) {
        // ★ 카카오톡 OG 미리보기 지원: 서버의 /r/:code 경로 사용
        shortUrl = apiBase + "/r/" + data.code;
      }
    } else if (APP_CONFIG.GAS_WEB_APP_URL) {
      // GAS 폴백
      const data = await gasGet({ action: "createShort", s: sheetId, g: gid, t: tabName, d: displayName, ic: incomeType });
      if (data && data.success && data.code) {
        // ★ 카카오톡 OG 미리보기 지원: 서버의 /r/:code 경로 사용
        shortUrl = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL ? API_BASE_URL : base) + "/r/" + data.code;
      }
    }
  } catch (e) {
    console.warn("[shortLink] 단축URL 생성 오류, 긴 URL로 폴백:", e.message);
  }

  btnEl.classList.remove("loading");
  btnEl.disabled = false;

  const urlToCopy = shortUrl || longUrl;
  const isShort   = !!shortUrl;

  // 복사 성공 피드백
  const markCopied = (ok) => {
    btnEl.classList.add(ok ? "copied" : "error");
    btnEl.innerHTML = ok ? '<i class="fas fa-check"></i>' : '<i class="fas fa-times"></i>';
    setTimeout(() => {
      btnEl.classList.remove("copied", "error");
      btnEl.innerHTML = origHtml;
    }, 2500);
  };

  const copyText = async (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  try {
    await copyText(urlToCopy);
    markCopied(true);
    if (isShort) {
      showToast(`📋 단축 URL 복사 완료! (/r/${shortUrl.split("/r/")[1]})`, "success");
    } else {
      showToast("📋 링크 복사 완료! (단축 URL 생성 실패 — 원본 URL)", "success");
    }
  } catch (e) {
    markCopied(false);
    showToast("❌ 클립보드 복사 실패: " + e.message, "error");
  }
}

/* ── 광고주 뷰 URL 복사 (sheetId 단위 고정 URL + 단축URL) ── */
/* 캠페인 헤더 광고주 URL 복사 (sheetId 직접 전달) */
async function copyCampViewerLink(btnEl) {
  const sheetId = btnEl.getAttribute("data-sheetid") || "";
  if (!sheetId) {
    showToast("광고주 URL 생성 실패: sheetId가 없습니다.", "error");
    return;
  }

  const base    = location.origin + location.pathname.replace(/[^/]*$/, "") + "viewer.html";
  const longUrl = base + "?s=" + encodeURIComponent(sheetId);

  const origHtml = btnEl.innerHTML;
  btnEl.classList.add("loading");
  btnEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
  btnEl.disabled  = true;

  let finalUrl = longUrl;
  try {
    if (APP_CONFIG.GAS_WEB_APP_URL) {
      const data = await gasGet({
        action: "createShort",
        s: sheetId, g: "", t: "__viewer__", d: ""
      });
      if (data && data.success && data.code) {
        finalUrl = base + "?code=" + data.code;
      }
    }
  } catch(e) {
    console.warn("[campViewerLink] 단축URL 실패, 긴URL로 폴백:", e.message);
  }

  btnEl.classList.remove("loading");
  btnEl.disabled = false;

  const _markCopied = (ok) => {
    btnEl.classList.add(ok ? "copied" : "error");
    btnEl.innerHTML = ok
      ? '<i class="fas fa-check"></i> 복사됨'
      : '<i class="fas fa-times"></i> 실패';
    setTimeout(() => {
      btnEl.classList.remove("copied", "error");
      btnEl.innerHTML = origHtml;
    }, 2500);
  };

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(finalUrl);
    } else {
      const ta = document.createElement("textarea");
      ta.value = finalUrl;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    _markCopied(true);
    showToast("👁 광고주 URL 복사 완료!", "success");
  } catch(e) {
    _markCopied(false);
    showToast("복사 실패: " + e.message, "error");
  }
}

async function copyViewerLink(btnEl) {
  let tc = {};
  try {
    const raw = btnEl.getAttribute("data-tc") || "";
    tc = JSON.parse(raw.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
  } catch(e) {
    showToast("광고주 URL 생성 실패: 데이터 파싱 오류", "error");
    return;
  }

  const sheetId = tc.sheetId || "";
  if (!sheetId) {
    showToast("광고주 URL 생성 실패: sheetId가 없습니다.", "error");
    return;
  }

  // viewer.html 기본 URL (sheetId만 사용)
  const base    = location.origin + location.pathname.replace(/[^/]*$/, "") + "viewer.html";
  const longUrl = base + "?s=" + encodeURIComponent(sheetId);

  const origHtml = btnEl.innerHTML;
  btnEl.classList.add("loading");
  btnEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
  btnEl.disabled  = true;

  // 단축 URL 생성 (viewer 타입 — tabName을 "__viewer__"로 구분)
  let finalUrl = longUrl;
  try {
    if (APP_CONFIG.GAS_WEB_APP_URL) {
      const data = await gasGet({
        action: "createShort",
        s: sheetId, g: "", t: "__viewer__", d: ""
      });
      if (data && data.success && data.code) {
        finalUrl = base + "?code=" + data.code;
      }
    }
  } catch(e) {
    console.warn("[viewerLink] 단축URL 실패, 긴URL로 폴백:", e.message);
  }

  btnEl.classList.remove("loading");
  btnEl.disabled = false;

  // 복사
  const _markCopied = (ok) => {
    btnEl.classList.add(ok ? "copied" : "error");
    btnEl.innerHTML = ok ? '<i class="fas fa-check"></i>' : '<i class="fas fa-times"></i>';
    setTimeout(() => {
      btnEl.classList.remove("copied","error");
      btnEl.innerHTML = origHtml;
    }, 2500);
  };

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(finalUrl);
    } else {
      const ta = document.createElement("textarea");
      ta.value = finalUrl;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    _markCopied(true);
    showToast("👁 광고주 URL 복사 완료!", "success");
  } catch(e) {
    _markCopied(false);
    showToast("❌ 복사 실패: " + e.message, "error");
  }
}

/**
 * 구매양식 전용 화면을 표시하고 true 반환 (일반 초기화 스킵)
 */
function initOrderFormMode() {
  const params      = new URLSearchParams(location.search);
  if (params.get("mode") !== "form" && !params.get("r") && !params.get("s") && !params.get("sheetId")) return false;

  // ★ [방법B] 단축 URL 처리: ?r=CODE → GAS resolveShort → 파라미터 복원 후 폼 진입
  const shortCode = params.get("r") || "";
  if (shortCode) {
    document.querySelectorAll(".screen").forEach(s => { s.classList.remove("active"); s.style.display = "none"; });
    const loadingEl = document.getElementById("loadingOverlay");
    const loadingTxt = document.getElementById("loadingText");
    if (loadingEl) { if (loadingTxt) loadingTxt.textContent = "링크 확인 중..."; loadingEl.style.display = "flex"; }

    gasGet({ action: "resolveShort", code: shortCode }, 10000)
      .then(data => {
        if (loadingEl) loadingEl.style.display = "none";
        if (!data || !data.success) {
          alert("유효하지 않거나 만료된 링크입니다.\n(" + (data && data.error ? data.error : "알 수 없는 오류") + ")");
          return;
        }
        const newParams = new URLSearchParams({ mode: "form", s: data.s||"", g: data.g||"", t: data.t||"", d: data.d||"", rd: data.rd||"" });
        [...newParams.keys()].forEach(k => { if (!newParams.get(k)) newParams.delete(k); });
        const newUrl = location.pathname + "?" + newParams.toString();
        history.replaceState(null, "", newUrl);
        initOrderFormMode(); // 재귀 호출
      })
      .catch(err => {
        if (loadingEl) loadingEl.style.display = "none";
        alert("링크 복원 중 오류가 발생했습니다: " + err.message);
      });
    return true;
  }

  const sheetId     = params.get("s") || params.get("sheetId")     || "";
  const gid         = params.get("g") || params.get("gid")         || "";
  const tabName     = params.get("t") || params.get("tabName")     || "";
  const displayName = params.get("d") || params.get("displayName") || "";
  const incomeType  = params.get("income") || params.get("incomeType") || "";

  // GAS URL 확보 순서:
  // 1) URL 파라미터 gasUrl (구버전 링크 하위 호환용)
  // 2) BOOTSTRAP_GAS_URL (하드코딩 — 가장 신뢰할 수 있는 값)
  // 3) localStorage 저장값
  const gasUrlParam = params.get("gasUrl") || "";
  const savedUrl    = (() => { try { return JSON.parse(localStorage.getItem("reviewAppConfig") || "{}").GAS_WEB_APP_URL || ""; } catch(_){ return ""; } })();
  const resolvedGasUrl = gasUrlParam || BOOTSTRAP_GAS_URL || savedUrl || "";
  if (resolvedGasUrl) APP_CONFIG.GAS_WEB_APP_URL = resolvedGasUrl;

  // 전역에 폼 컨텍스트 저장 (sheetUrl 포함)
  const _sheetUrl = sheetId ? "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit" : "";
  window._orderFormCtx = { sheetId, gid, tabName, displayName, sheetUrl: _sheetUrl };

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

  // 구매양식 화면만 표시 — showScreen과 동일한 방식으로 active 클래스 사용
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.style.display = "none";
  });
  const formScreen = document.getElementById("screenOrderForm");
  if (formScreen) {
    formScreen.classList.add("active");
    formScreen.style.display = "flex";
  }
  window.scrollTo({ top: 0, behavior: "instant" });

  // ★ 소득신고 섹션: URL 파라미터 income=소득신고 일 때만 표시
  window._incomeType = incomeType;
  const incomeSec = document.getElementById("ofIncomeSection");
  if (incomeSec) incomeSec.style.display = (incomeType === "소득신고") ? "" : "none";

  // ── 인애드명단 자동완성 목록 비동기 로드 (화면 표시와 병렬)
  _loadInaedList(sheetId, gid, tabName);

  return true;
}

/* ══════════════════════════════════════════════════════════
   인애드명단 자동완성 로직
══════════════════════════════════════════════════════════ */

// 전역 자동완성 데이터
let _inaedNames      = [];   // GAS에서 받아온 전체 목록 [{ name, date, options, rowIndex }]
let _acActiveIdx     = -1;   // 키보드 선택 인덱스
let _acBlurTimer     = null; // blur 딜레이 타이머
let _optionHeaders   = [];   // 옵션 헤더명 목록 (최대 3개)
let _memoHeader      = "";   // 비고 헤더명
let _orderNumHeader  = "";   // 주문번호 헤더명 (없으면 "")

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
      console.log("[자동완성] 인애드명단 로드 완료:", _inaedNames.length, "명",
        "| 옵션헤더:", _optionHeaders, "| 비고:", _memoHeader, "| 주문번호:", _orderNumHeader);
      // 비고/주문번호 입력란 동적 표시
      _renderDynamicFields();
    }
  } catch (err) {
    console.warn("[자동완성] 인애드명단 로드 실패:", err.message);
  }
}

/** 비고·주문번호 입력란을 동적으로 표시/숨김 */
function _renderDynamicFields() {
  // 주문번호 입력란: 항상 표시 (AI 캡처 분석 후 자동기입 기준)
  const orderNumWrap = document.getElementById("of_orderNum_wrap");
  if (orderNumWrap) orderNumWrap.style.display = "";

  // 비고 입력란: 항상 표시 (시트에 비고/특이사항 헤더가 있으면 해당 헤더명 반영)
  const memoWrap = document.getElementById("of_memo_wrap");
  const memoLabel = document.getElementById("of_memo_label");
  if (memoWrap) memoWrap.style.display = "";
  if (memoLabel && _memoHeader) memoLabel.textContent = _memoHeader;
}

/** 입력값에 맞는 후보 필터링 */
function _filterInaed(query) {
  // _inaedNames 는 [{ name, date }] 배열
  if (!query) return _inaedNames.slice(0, 30); // 빈 쿼리 → 전체 표시 (최대 30)
  const q = query.toLowerCase();
  return _inaedNames.filter(item => {
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
      // item 은 { name, date } 또는 구버전 문자열 호환
      const name = typeof item === "string" ? item : (item.name || "");
      const date = typeof item === "string" ? "" : (item.date || "");
      const nameHtml = _highlightMatch(name, query);
      const dateHtml = date
        ? `<span class="ac-date">${escHtml(date)}</span>`
        : "";
      return `<div class="of-ac-item" data-idx="${i}" data-name="${escHtml(name)}" onmousedown="selectAcItem('${escHtml(name)}')">`
        + dateHtml
        + `<i class="fas fa-user ac-icon"></i>`
        + `<span>${nameHtml}</span>`
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

  // ── 선택된 이름에 매핑되는 옵션 표시 ──
  const matched = _inaedNames.find(item => {
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



let _aiExtracted = null; // 마지막 추출 결과 저장

/** 파일 인풋 변경 */
function onImgSelected(input) {
  if (!input.files || !input.files[0]) return;
  _processImgFile(input.files[0]);
}

/** 드래그&드롭 */
function onImgDrop(e) {
  e.preventDefault();
  document.getElementById("ofImgZone").classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith("image/")) {
    showToast("이미지 파일만 업로드 가능합니다.", true);
    return;
  }
  _processImgFile(file);
}

/** 이미지 제거 */
function removeImg() {
  _resetImgUI();
}

/** UI 초기화 */
function _resetImgUI() {
  // 파일 인풋 초기화
  const inp = document.getElementById("ofImgInput");
  if (inp) inp.value = "";
  // 미리보기 숨김
  const prev = document.getElementById("ofImgPreview");
  if (prev) { prev.style.display = "none"; document.getElementById("ofImgThumb").src = ""; }
  // 업로드 존 다시 보이기
  const zone = document.getElementById("ofImgZone");
  if (zone) zone.style.display = "";
  // 결과/로딩/오류 숨김
  document.getElementById("ofAiLoading").classList.remove("show");
  document.getElementById("ofAiResult").classList.remove("show");
  document.getElementById("ofAiError").style.display = "none";
  // ★ 별표 경고 숨김
  const asteriskWarn = document.getElementById("ofAiAsteriskWarn");
  if (asteriskWarn) asteriskWarn.style.display = "none";
  _aiExtracted = null;
  // ai-filled 클래스 제거
  ["of_recipient","of_phone","of_address"].forEach(id => {
    document.getElementById(id)?.classList.remove("ai-filled");
  });
}

/** 이미지 파일 처리: 미리보기 표시 → ★압축 → base64 변환 → GAS 호출 */
async function _processImgFile(file) {
  // 10MB 제한
  if (file.size > 10 * 1024 * 1024) {
    showToast("이미지 크기는 10MB 이하여야 합니다.", true);
    return;
  }

  // 미리보기 표시 (원본으로)
  const reader = new FileReader();
  reader.onload = function(ev) {
    document.getElementById("ofImgThumb").src = ev.target.result;
    document.getElementById("ofImgPreview").style.display = "flex";
    document.getElementById("ofImgZone").style.display = "none";
    document.getElementById("ofAiResult").classList.remove("show");
    document.getElementById("ofAiError").style.display = "none";
  };
  reader.readAsDataURL(file);

  // ★ 이미지 압축 후 AI 분석 호출
  const lbl = document.getElementById("ofImgLabel");
  if (lbl) lbl.textContent = file.name + "  ·  압축 중…";

  try {
    const base64 = await compressImageIdx(file, 1920, 0.8);
    const mimeType = "image/jpeg"; // 압축 후 항상 JPEG
    if (lbl) lbl.textContent = file.name + "  ·  AI 분석 중…";
    await _callExtractOrderImage(base64, mimeType);
  } catch (compErr) {
    console.warn("[압축 실패] fallback to raw:", compErr.message);
    // 압축 실패 시 원본으로 폴백
    try {
      const rawB64 = await fileToBase64Raw(file);
      if (lbl) lbl.textContent = file.name + "  ·  AI 분석 중…";
      await _callExtractOrderImage(rawB64, file.type || "image/jpeg");
    } catch (rawErr) {
      if (lbl) lbl.textContent = file.name;
      _showAiError("이미지 읽기 실패: " + rawErr.message);
    }
  }
}

/** GAS extractOrderImage POST 호출 */
async function _callExtractOrderImage(base64, mimeType) {
  const gasUrl = APP_CONFIG.GAS_WEB_APP_URL;
  if (!gasUrl) {
    _showAiError("GAS 웹앱 URL이 설정되지 않았습니다.");
    return;
  }

  // 로딩 표시
  document.getElementById("ofAiLoading").classList.add("show");
  document.getElementById("ofAiError").style.display = "none";

  try {
    // ★ [Node.js 이관] gasPostUpload()를 통해 API 서버로 전송 (업로드 진행률 표시)
    let json;
    try {
      json = await gasPostUpload({
        action:      "extractOrderImage",
        imageBase64: base64,
        mimeType:    mimeType
      });
      console.log("[AI추출] 응답:", JSON.stringify(json).slice(0, 200));
    } catch(postErr) {
      console.warn("[AI추출] POST 실패:", postErr.message);
      _showAiError("이미지 전송 실패: " + postErr.message);
      document.getElementById("ofAiLoading").classList.remove("show");
      return;
    }

    document.getElementById("ofAiLoading").classList.remove("show");
    // 라벨 업데이트
    const lblDone = document.getElementById("ofImgLabel");
    if (lblDone) lblDone.textContent = "분석 완료 ✓";

    if (!json || json.error) {
      _showAiError(json?.error || "알 수 없는 오류가 발생했습니다.");
      return;
    }

    // 추출 결과 저장 및 표시
    _aiExtracted = {
      orderNumber: json.orderNumber || "",
      recipient:   json.recipient   || "",
      phone:       json.phone       || "",
      address:     json.address     || "",
      price:       json.price       || ""
    };
    _showAiResult(_aiExtracted);

  } catch(err) {
    document.getElementById("ofAiLoading").classList.remove("show");
    _showAiError(err.message);
  }
}

/** 추출 결과 카드 표시 */
/** 선택된 주문자의 옵션 표시 (읽기 전용) */
function _showSelectedOptions(optionValues) {
  const wrap = document.getElementById("of_options_wrap");
  if (!wrap) return;
  // 유효한 옵션 헤더가 없거나, 모든 옵션값이 비어 있으면 숨김
  const hasOption = _optionHeaders.length > 0
    && optionValues.some(v => v && v.trim());
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

function _showAiResult(data) {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (val) {
      el.textContent = val;
      el.classList.remove("empty");
    } else {
      el.textContent = "추출 실패";
      el.classList.add("empty");
    }
  };
  setVal("aiValOrder",     data.orderNumber);
  setVal("aiValRecipient", data.recipient);
  setVal("aiValPhone",     data.phone);
  setVal("aiValAddress",   data.address);
  // 결제금액: 숫자면 콤마 포맷으로 표시
  const priceEl = document.getElementById("aiValPrice");
  if (priceEl) {
    if (data.price) {
      const fmt = Number(data.price).toLocaleString("ko-KR");
      priceEl.textContent = fmt + "원";
      priceEl.classList.remove("empty");
    } else {
      priceEl.textContent = "추출 실패";
      priceEl.classList.add("empty");
    }
  }

  // ★ 별표(*) 탐지: 수취인/전화번호/주소에 * 포함 시 경고 표시 + 적용 버튼 비활성화
  const hasAsterisk = [data.recipient, data.phone, data.address].some(v => v && v.includes("*"));
  const asteriskWarn = document.getElementById("ofAiAsteriskWarn");
  if (asteriskWarn) asteriskWarn.style.display = hasAsterisk ? "block" : "none";

  document.getElementById("ofAiResult").classList.add("show");
  document.getElementById("ofAiError").style.display = "none";

  // 하나라도 추출됐으면 버튼 활성화 (단, 별표 있으면 비활성화)
  const hasAny = data.orderNumber || data.recipient || data.phone || data.address;
  const applyBtn = document.getElementById("ofAiApplyBtn");
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

/** 오류 메시지 표시 */
function _showAiError(msg) {
  document.getElementById("ofAiLoading").classList.remove("show");
  document.getElementById("ofAiError").style.display = "block";
  document.getElementById("ofAiErrorMsg").textContent = msg;
}

/** 추출 결과를 입력칸에 적용 */
function applyAiResult() {
  if (!_aiExtracted) return;

  // ★ 별표(*) 재검증: 수취인/전화번호/주소에 * 있으면 적용 차단
  const hasAsterisk = [_aiExtracted.recipient, _aiExtracted.phone, _aiExtracted.address]
    .some(v => v && v.includes("*"));
  if (hasAsterisk) {
    showToast("⚠️ 수취인·전화번호·주소에 별표(*)가 포함되어 있어 적용할 수 없습니다. 쿠팡 캡처는 개인정보가 *로 가려지므로 직접 입력해주세요.", "error");
    return;
  }

  // 수취인 — 값이 있을 때만 채움
  if (_aiExtracted.recipient) {
    const el = document.getElementById("of_recipient");
    if (el) { el.value = _aiExtracted.recipient; el.classList.add("ai-filled"); }
  }
  // 전화번호
  if (_aiExtracted.phone) {
    const el = document.getElementById("of_phone");
    if (el) { el.value = _aiExtracted.phone; el.classList.add("ai-filled"); }
  }
  // 주소
  if (_aiExtracted.address) {
    const el = document.getElementById("of_address");
    if (el) { el.value = _aiExtracted.address; el.classList.add("ai-filled"); }
  }
  // 결제금액
  if (_aiExtracted.price) {
    const el = document.getElementById("of_price");
    if (el) {
      // 숫자만 남긴 후 포맷
      const digits = _aiExtracted.price.replace(/[^0-9]/g, "");
      if (digits) {
        el.value = Number(digits).toLocaleString("ko-KR");
        el.classList.add("ai-filled");
      }
    }
  }
  // 주문번호 — of_orderNumber 입력란이 있으면 채움 (시트에 주문번호 헤더 있을 때만 표시됨)
  if (_aiExtracted.orderNumber) {
    const el = document.getElementById("of_orderNumber");
    if (el) { el.value = _aiExtracted.orderNumber; el.classList.add("ai-filled"); }
    showToast("✅ 정보가 입력칸에 적용되었습니다. 주문번호: " + _aiExtracted.orderNumber);
  } else {
    showToast("✅ 정보가 입력칸에 적용되었습니다. 내용을 확인해주세요.");
  }

  // 버튼 상태 변경
  const btn = document.getElementById("ofAiApplyBtn");
  if (btn) {
    btn.innerHTML = '<i class="fas fa-check"></i> 적용 완료';
    btn.disabled = true;
    btn.style.background = "#12b886";
  }

  // 주문자 칸이 비어있으면 포커스
  const orderer = document.getElementById("of_orderer");
  if (orderer && !orderer.value) orderer.focus();
}

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

/** 주민등록번호 자동 포맷: 6자리 입력 후 '-' 삽입 */
function _formatResidentNo(input) {
  let v = input.value.replace(/[^0-9]/g, "").slice(0, 13);
  if (v.length > 6) v = v.slice(0, 6) + "-" + v.slice(6);
  input.value = v;
  const hint = document.getElementById("ofResidentNoHint");
  if (hint) {
    const digits = v.replace(/[^0-9]/g, "");
    if (digits.length === 13) {
      hint.textContent = "✅ 13자리 입력 완료";
      hint.style.color = "#12b886";
    } else {
      hint.textContent = "숫자 13자리 자동 형식화 (000000-0000000)";
      hint.style.color = "#9CA3AF";
    }
    // 테두리 색 복원
    input.style.borderColor = digits.length === 13 ? "#12b886" : "#6fa6f5";
  }
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

async function submitOrderForm() {
  // ★★★ 연속클릭 방지: 함수 진입 즉시 전역 플래그 + 버튼 비활성화 ★★★
  // async 함수 특성상 첫 await 이전에 동기적으로 실행되므로 가장 확실한 위치
  if (window._submitOrderFormInProgress) {
    console.warn("[submitOrderForm] 이미 제출 진행 중 — 중복 클릭 무시");
    return;
  }
  window._submitOrderFormInProgress = true;
  const btn = document.getElementById("btnOrderFormSubmit");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 처리 중...';
  }

  // 내부에서 early return 할 때마다 플래그·버튼을 복원하는 헬퍼
  function _resetBtn(label) {
    window._submitOrderFormInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = label || '<i class="fas fa-paper-plane"></i> 제출';
    }
  }

  const ctx = window._orderFormCtx || {};
  // ★ [방법A] gid가 있으면 tabName 없이도 제출 가능 (탭명 변경 대응)
  if (!ctx.sheetId || (!ctx.tabName && !ctx.gid)) {
    showToast("잘못된 링크입니다. (sheetId/tabName 또는 gid 필요)", "error");
    _resetBtn(); return;
  }

  // GAS URL 최종 확보 (BOOTSTRAP → localStorage 폴백)
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    const savedUrl = (() => { try { return JSON.parse(localStorage.getItem("reviewAppConfig") || "{}").GAS_WEB_APP_URL || ""; } catch(_){ return ""; } })();
    if (savedUrl) APP_CONFIG.GAS_WEB_APP_URL = savedUrl;
  }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("서버 연결 정보가 없습니다. 관리자에게 문의해주세요.", "error");
    _resetBtn(); return;
  }

  // 입력값 수집
  const getValue = id => (document.getElementById(id)?.value || "").trim();
  const orderer   = getValue("of_orderer");
  const recipient = getValue("of_recipient");
  const userId    = getValue("of_userId");
  // 연락처: 표시용 포맷(010-1234-5678) 그대로 전송
  const phone     = getValue("of_phone");
  const address   = getValue("of_address");
  const bank      = getValue("of_bank");
  const account   = getValue("of_account");
  const depositor = getValue("of_depositor");
  // 결제금액: 쉼표 제거 후 순수 숫자만 전송 (예: "47,000" → "47000")
  const price     = getValue("of_price").replace(/,/g, "");
  // ★ 주문번호 (시트에 헤더 있을 때만 값 있음, 없으면 빈 문자열)
  const orderNum  = getValue("of_orderNumber");
  // ★ 비고 (시트에 헤더 있을 때만 표시됨, 빈 문자열로 제출 가능)
  const memo      = getValue("of_memo");

  // ── 필수 항목 유효성 검사 ──────────────────────────────────
  let hasError = false;
  if (!orderer) {
    _ofShowError("of_orderer");
    hasError = true;
  }
  if (!userId) {
    _ofShowError("of_userId");
    hasError = true;
  }
  if (hasError) {
    // 첫 번째 오류 필드로 스크롤
    const firstErr = document.querySelector(".of-input--error");
    if (firstErr) firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("필수 항목을 입력해주세요.", "warning");
    _resetBtn(); return;
  }

  // 날짜: 제출 시점 자동 생성 (MM / D (요일))
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const days  = ["일","월","화","수","목","금","토"];
  const dow   = days[now.getDay()];
  const dateStr = `${month} / ${day} (${dow})`;

  // ★ 소득신고 유효성 검사 및 수집
  let incomeName = "";
  let residentNo = "";
  const incomeSection = document.getElementById("ofIncomeSection");
  if (incomeSection && incomeSection.style.display !== "none") {
    incomeName = getValue("ofIncomeName");
    const residentRaw = getValue("ofResidentNo").replace(/[^0-9]/g, "");
    if (!incomeName) {
      const el = document.getElementById("ofIncomeName");
      if (el) { el.style.borderColor = "#EF4444"; el.focus(); }
      showToast("소득신고 명의를 입력해주세요.", "warning");
      _resetBtn(); return;
    }
    if (residentRaw.length !== 13) {
      const el = document.getElementById("ofResidentNo");
      if (el) { el.style.borderColor = "#EF4444"; el.focus(); }
      showToast("주민등록번호 13자리를 정확히 입력해주세요.", "warning");
      _resetBtn(); return;
    }
    residentNo = residentRaw.slice(0, 6) + "-" + residentRaw.slice(6);
  }

  const payload = {
    action:     "submitOrderForm",
    sheetId:    ctx.sheetId,
    gid:        ctx.gid    || "",
    tabName:    ctx.tabName,
    orderer, recipient, userId, phone, address,
    bank, account, depositor, price,
    orderNum, memo,
    dateStr,
    incomeName, residentNo
  };

  // 버튼은 이미 함수 상단에서 비활성화됨 — 텍스트만 "제출 중..."으로 업데이트
  if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 제출 중...';

  try {
    // ── 1단계: 양식 데이터 시트에 기입 ──
    let res;
    let stage1Err = null;
    try {
      res = await gasPost(payload);
    } catch (e1) {
      stage1Err = e1;
      console.warn("[submitOrderForm] gasPost 실패, gasGet으로 재시도:", e1.message);
      try {
        res = await gasGet(payload);
      } catch (e2) {
        const netMsg = (e2.message && e2.message !== "undefined")
          ? e2.message : "서버 연결에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.";
        throw new Error(netMsg);
      }
    }
    if (!res) throw new Error("서버 응답이 없습니다. 잠시 후 다시 시도해주세요.");
    if (res && res.ok) {

      // ── 2단계: 이미지가 있으면 드라이브에 업로드 (백그라운드, 실패해도 제출 완료) ──
      const imgThumb = document.getElementById("ofImgThumb");
      if (imgThumb && imgThumb.src && imgThumb.src.startsWith("data:")) {
        try {
          const dataUrl  = imgThumb.src;
          const mimeType = dataUrl.split(";")[0].split(":")[1] || "image/jpeg";
          const base64   = dataUrl.split(",")[1];
          const ext      = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
          // 파일명: 수취인이름_주문자이름.확장자 (수취인 없으면 주문자만)
          const namePart = [recipient || orderer, orderer !== recipient ? orderer : ""]
            .filter(Boolean).join("_") || "주문캡처";
          const fileName = namePart + "." + ext;

          const uploadPayload = {
            action:      "uploadOrderImage",
            imageBase64: base64,
            mimeType:    mimeType,
            fileName:    fileName,
            displayName: ctx.displayName || "",  // 상품명 → 캠페인폴더명
            tabName:     ctx.tabName,            // 탭명 → 인덱스폴더명 기준
            round:       ctx.round       || "",  // 차수 → 폴더명에 삽입
            sheetId:     ctx.sheetId     || ""   // ★ 탭명 변경 대응: ID로 세부목록 조회
          };

          // ★ [Node.js 이관] gasPostUpload()를 통해 API 서버로 전송 — 진행률 표시 + 2회 재시도
          let upJson = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              upJson = await gasPostUpload(uploadPayload, 120000);
              break;
            } catch (fetchErr) {
              if (attempt < 2) {
                console.warn("[이미지 업로드] " + attempt + "차 실패, 1.5초 후 재시도:", fetchErr.message);
                await new Promise(r => setTimeout(r, 1500));
              } else {
                throw fetchErr;
              }
            }
          }
          if (upJson && upJson.ok) {
            console.log("[이미지 업로드] 완료:", upJson.fileUrl);
            // ── 캡처 폴더 URL을 세부목록에 저장 (대시보드 바로가기 버튼용) ──
            if (upJson.captureFolderUrl) {
              try {
                // ★ [Node.js 이관] gasPost()를 통해 API 서버로 전송
                const sfJson = await gasPost({
                  action:           "saveCaptureFolder",
                  sheetId:          ctx.sheetId  || "",
                  sheetUrl:         ctx.sheetUrl || "",
                  tabName:          ctx.tabName,
                  captureFolderUrl: upJson.captureFolderUrl
                });
                if (sfJson && sfJson.ok) {
                  console.log("[캡처폴더 저장] 완료:", upJson.captureFolderUrl);
                } else {
                  console.warn("[캡처폴더 저장] 실패:", sfJson?.error);
                }
              } catch(sfErr) {
                console.warn("[캡처폴더 저장] 실패 (무시):", sfErr.message);
              }
            }
          } else {
            console.warn("[이미지 업로드] 실패:", upJson?.error);
          }
        } catch (upErr) {
          console.warn("[이미지 업로드] 오류 (제출은 완료됨):", upErr.message);
        }
      }

      // ── 3단계: 완료 화면 표시 ──
      window._submitOrderFormInProgress = false; // ★ 플래그 해제 (완료 시 버튼은 숨기므로 복원 불필요)
      const card = document.getElementById("orderFormCard");
      const doneEl = document.getElementById("orderFormDone");
      const submitBtn = document.getElementById("btnOrderFormSubmit");
      if (card)      card.style.display      = "none";
      if (submitBtn) submitBtn.style.display = "none";
      if (doneEl)    doneEl.style.display    = "";
      // 안내 문구도 숨김
      const guideEl = document.querySelector("#screenOrderForm main > div:nth-child(3)");
      if (guideEl) guideEl.style.display = "none";
    } else {
      const msg = (res?.error && res.error !== "undefined") ? res.error : "제출에 실패했습니다. 다시 시도해주세요.";
      showToast("❌ " + msg, "error");
      _resetBtn(); // ★ 실패 시 버튼 복원 + 플래그 해제
    }
  } catch (err) {
    const displayMsg = (err.message && err.message !== "undefined" && err.message !== "null")
      ? err.message : "제출에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.";
    showToast("❌ " + displayMsg, "error");
    console.error("[submitOrderForm] 오류:", err);
    _resetBtn(); // ★ 오류 시 버튼 복원 + 플래그 해제
  }
}

async function quickEditCell(e, cell) {
  e.stopPropagation();

  // ★ 토글: 이미 열려있는 팝업의 셀을 다시 클릭하면 닫기만 하고 종료
  if (_qePopup && _qePopupCell === cell) {
    _closeQePopup();
    return;
  }
  _closeQePopup();

  const field   = cell.dataset.field;   // '상품명' | '주문시간대' | '리뷰타입' | '담당자' | '입금방식' | '택대'
  const tcData  = JSON.parse(cell.dataset.tc.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"));

  // ── 팝업 DOM 생성 ──
  const popup = document.createElement("div");
  popup.className = "qe-popup";
  _qePopup = popup;
  _qePopupCell = cell; // ★ 토글 판단용: 현재 팝업을 연 셀 저장

  // 아이콘 맵
  const iconMap = { '상품명':'fa-box', '주문시간대':'fa-clock', '리뷰타입':'fa-star', '담당자':'fa-user', '입금방식':'fa-won-sign', '택대':'fa-truck', '비고':'fa-sticky-note',
    '진행방식':'fa-receipt', '입금명':'fa-signature', '이체은행':'fa-university' };  // ★ v9.14
  // 기존값 유무 판단 (각 필드별 tcData 접근)
  const _fieldValMap = { '상품명': tcData.displayName, '주문시간대': tcData.timeRange, '리뷰타입': tcData.reviewType, '담당자': tcData.manager, '입금방식': tcData.paymentType, '택대': tcData.taekhap,
    '진행방식': tcData.incomeType, '입금명': tcData.depositName, '이체은행': tcData.transferBank };  // ★ v9.14
  const _hasExistingVal = field === '비고' ? false : !!(String(_fieldValMap[field] || '').trim());
  const _titleAction = _hasExistingVal ? '수정' : '입력';
  popup.innerHTML = `<div class="qe-popup-title"><i class="fas ${iconMap[field]||'fa-pen'}" style="font-size:.65rem;color:var(--p)"></i>${field} ${_titleAction}</div>`;

  let getValue; // 팝업 확인 시 선택값을 반환하는 함수

  if (field === '상품명') {
    const _existingName = (tcData.displayName || '').trim();
    popup.innerHTML += `<input type="text" id="qeInput" placeholder="예: OO브랜드 후기작업 3월" maxlength="60" value="${escHtml(_existingName)}">`;
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
    const _existingReview = (tcData.reviewType || '').trim();
    const opts = ['실배송','빈박스','구매확정','믹스'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    // 기존값 pre-select
    if (_existingReview) {
      popup.querySelectorAll(".qe-opt").forEach(b => { if (b.dataset.val === _existingReview) b.classList.add("sel"); });
    }
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.toggle("sel", !btn.classList.contains("sel") || true);
        btn.classList.add("sel");
      });
    });

  } else if (field === '담당자') {
    const _existingManager = (tcData.manager || '').trim();
    const opts = ['만두','망고'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    // 기존값 pre-select
    if (_existingManager) {
      popup.querySelectorAll(".qe-opt").forEach(b => { if (b.dataset.val === _existingManager) b.classList.add("sel"); });
    }
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
      });
    });

  } else if (field === '입금방식') {
    const _existingPayment = (tcData.paymentType || '').trim();
    const opts = ['인애드','업체'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    // 기존값 pre-select
    if (_existingPayment) {
      popup.querySelectorAll(".qe-opt").forEach(b => { if (b.dataset.val === _existingPayment) b.classList.add("sel"); });
    }
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
      });
    });

  } else if (field === '진행방식') {  // ★ v9.14
    const _existingIncome = (tcData.incomeType || '').trim();
    const opts = ['현금','사업자현영','소득신고'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : ''; };
    if (_existingIncome) {
      popup.querySelectorAll(".qe-opt").forEach(b => { if (b.dataset.val === _existingIncome) b.classList.add("sel"); });
    }
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
      });
    });

  } else if (field === '택대') {
    const _existingTaekhap = tcData.taekhap === true || tcData.taekhap === 'true';
    popup.innerHTML += `<div class="qe-opt-row">
      <button class="qe-opt${_existingTaekhap ? '' : ' sel'}" data-val="true">✔ 택대 ON</button>
      <button class="qe-opt${_existingTaekhap ? ' sel' : ''}" data-val="false">✖ 택대 OFF</button>
    </div>`;
    getValue = () => { const s = popup.querySelector(".qe-opt.sel"); return s ? s.dataset.val : 'true'; };
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
      });
    });

  } else if (field === '입금명') {  // ★ v9.14
    const _existingDepositName = (tcData.depositName || '').trim();
    popup.innerHTML += `<input type="text" id="qeInput" placeholder="예: 홍길동" maxlength="30" value="${escHtml(_existingDepositName)}">`;
    getValue = () => document.getElementById("qeInput").value.trim();

  } else if (field === '이체은행') {  // ★ v9.14
    const _existingBank = (tcData.transferBank || '').trim();
    const opts = ['케이뱅크','하나은행','국민은행','신한은행','우리은행','농협','카카오뱅크'];
    popup.innerHTML += `<div class="qe-opt-row">${opts.map(o=>`<button class="qe-opt" data-val="${o}">${o}</button>`).join('')}</div>`;
    // 직접입력 옵션
    popup.innerHTML += `<input type="text" id="qeInput" placeholder="직접 입력..." maxlength="20" value="" style="margin-top:5px;width:100%;border:1.5px solid var(--bd);border-radius:7px;padding:5px 8px;font-size:.8rem;outline:none;box-sizing:border-box;font-family:inherit">`;
    getValue = () => {
      const sel = popup.querySelector(".qe-opt.sel");
      const txt = (document.getElementById("qeInput")?.value || '').trim();
      return txt || (sel ? sel.dataset.val : '');
    };
    // 기존값 pre-select
    if (_existingBank) {
      const matched = popup.querySelector(`.qe-opt[data-val="${_existingBank}"]`);
      if (matched) matched.classList.add('sel');
      else document.getElementById('qeInput').value = _existingBank;
    }
    popup.querySelectorAll(".qe-opt").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        popup.querySelectorAll(".qe-opt").forEach(b => b.classList.remove("sel"));
        btn.classList.add("sel");
        const inp = document.getElementById("qeInput");
        if (inp) inp.value = '';  // 버튼 선택 시 직접입력 초기화
      });
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
    if (!val && field !== '택대' && field !== '주문시간대' && field !== '비고' && field !== '입금명' && field !== '이체은행') { showToast("값을 입력하거나 선택해주세요.", true); return; }

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
    const fieldKey = { '상품명':'displayName', '주문시간대':'timeRange', '리뷰타입':'reviewType', '담당자':'manager', '입금방식':'paymentType', '진행방식':'incomeType', '택대':'taekhap', '입금명':'depositName', '이체은행':'transferBank' }[field];  // ★ v9.14
    const newTcData = { ...tcData };
    if (field === '택대') newTcData.taekhap = (val === 'true' || val === true);
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
      displayName: newTcData.displayName || "",
      incomeType:  newTcData.incomeType  || "",   // ★ v9.14
      depositName: newTcData.depositName || "",   // ★ v9.14
      transferBank: newTcData.transferBank || ""  // ★ v9.14
    };

    console.log("[QE] 저장 payload:", JSON.stringify(payload));
    try {
      let json;
      try { json = await gasPost(payload); }
      catch { json = await gasGet(payload); }
      if (json.ok) {
        showToast(`✅ ${field} 저장 완료`);
        // ★ 전체 새로고침 대신 해당 탭 데이터만 패치 → 로딩 없이 즉시 반영
        _patchTabAndRerender(payload.sheetId, payload.tabName, {
          displayName: payload.displayName,
          manager:     payload.manager,
          timeRange:   payload.timeRange,
          taekhap:     payload.taekhap === "true",
          reviewType:  payload.reviewType,
          paymentType: payload.paymentType,
          incomeType:  payload.incomeType,  // ★ v9.14
          depositName: payload.depositName,  // ★ v9.14
          transferBank: payload.transferBank // ★ v9.14
        });
      } else {
        showToast("❌ 저장 실패: " + (json.error || ""), true);
      }
    } catch (err) {
      showToast("❌ 오류: " + err.message, true);
    }
  });
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
  const ok = confirm(`"${campName}" 캠페인만 동기화합니다.\n\n선택한 캠페인만 동기화됩니다.\n계속하시겠습니까?`);
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
      btn.innerHTML = '<i class="fas fa-sync-alt"></i> 동기화';
    }
  }
}

/* ══════════════════════════════════════════════════════════
   🔄 대시보드 행 — 캠페인 인덱스 갱신 (캠페인명 왼쪽 버튼)
══════════════════════════════════════════════════════════ */
async function rebuildSheetIndex(btn) {
  if (!btn) return;
  const sheetId  = btn.dataset.sheetid || "";
  const campName = btn.dataset.camp    || "캠페인";
  if (!sheetId) { showToast("sheetId가 없습니다.", "error"); return; }

  // 이미 로딩 중이면 무시
  if (btn.classList.contains("spinning")) return;

  // 스피너 표시
  btn.classList.add("spinning");
  const origHtml = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i>';
  showToast(`🔄 "${campName}" 갱신 중...`, "info");

  try {
    const res = await gasGet({ action: "buildIndexByCampaign", sheetId });
    if (res.error) {
      showToast("갱신 실패: " + res.error, "error");
    } else {
      const rebuilt = res.rebuilt || 0;
      const skipped = res.skipped || 0;
      showToast(`✅ "${campName}" 갱신 완료 (${rebuilt}탭 갱신, ${skipped}탭 스킵)`, "success");
      // 대시보드 새로고침
      await loadAdminDashboard();
    }
  } catch (err) {
    showToast("갱신 오류: " + err.message, "error");
  } finally {
    if (btn && btn.isConnected) {
      btn.classList.remove("spinning");
      btn.innerHTML = origHtml;
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

/* ══════════════════════════════════════════════════════════
   ★ 대시보드 빠른 검색
══════════════════════════════════════════════════════════ */
let _dashSearchQuery = ''; // 현재 검색어
let _dashSearchTimer = null; // 디바운스 타이머

/**
 * 검색어 입력 핸들러 (실시간 — 150ms 디바운스)
 */
function onDashSearch(val) {
  _dashSearchQuery = val.trim();

  // ✕ 버튼 & 입력창 상태
  const clearBtn = document.getElementById('dashSearchClear');
  const input    = document.getElementById('dashSearchInput');
  if (clearBtn) clearBtn.classList.toggle('visible', _dashSearchQuery.length > 0);
  if (input)    input.classList.toggle('has-query', _dashSearchQuery.length > 0);

  // 디바운스: 150ms 후 실제 필터 실행
  clearTimeout(_dashSearchTimer);
  _dashSearchTimer = setTimeout(() => {
    applyDashFilter();
  }, 150);
}

/**
 * 검색어 초기화 (✕ 버튼 / ESC 키)
 */
function clearDashSearch() {
  _dashSearchQuery = '';
  const input    = document.getElementById('dashSearchInput');
  const clearBtn = document.getElementById('dashSearchClear');
  const countEl  = document.getElementById('dashSearchCount');
  if (input)    { input.value = ''; input.classList.remove('has-query'); input.focus(); }
  if (clearBtn) clearBtn.classList.remove('visible');
  if (countEl)  { countEl.textContent = ''; countEl.classList.remove('visible', 'no-result'); }
  applyDashFilter();
}

/**
 * 행이 검색어와 매칭되는지 판단
 * 검색 대상: 탭명(data-sort-tabname) + 상품명(data-sort-product) +
 *            담당자(data-sort-manager) + 리뷰타입(data-sort-review) +
 *            진행방식(data-sort-income) + 입금명(data-sort-depositname) + 이체은행(data-sort-bank) +
 *            캠페인명(블록 헤더)
 */
function _rowMatchesSearch(row, query, campName) {
  if (!query) return true;
  const q = query.toLowerCase();
  // 캠페인명
  if (campName && campName.includes(q)) return true;
  // data 속성 (렌더 시 이미 소문자로 저장)
  const fields = [
    row.dataset.sortTabname  || '',
    row.dataset.sortProduct  || '',
    row.dataset.sortManager  || '',
    row.dataset.sortReview   || '',
    row.dataset.sortIncome   || '',      // ★ v9.17: 진행방식
    row.dataset.sortDepositname || '',   // ★ v9.17: 입금명
    row.dataset.sortBank     || '',      // ★ v9.17: 이체은행
  ];
  return fields.some(f => f.includes(q));
}

function applyDashFilter() {
  const wrap = document.getElementById("dashboardWrap");
  if (!wrap) return;

  const noFilter = activeFilters.size === 0;
  const query    = _dashSearchQuery.toLowerCase();
  const hasQuery = query.length > 0;

  let totalMatchCount = 0;

  // ★ v11.0: 플랫 테이블 — 모든 행을 직접 순회
  const rows = wrap.querySelectorAll(".dash-tab-row");
  rows.forEach(row => {
    const campName = row.dataset.campname || '';

    // ① 체크박스 필터 판단
    let passFilter = noFilter;
    if (!noFilter) {
      const rowState = (row.dataset.state || "").split(" ");
      if (!passFilter && activeFilters.has("tuip"))    { if (rowState.includes("tuip"))  passFilter = true; }
      if (!passFilter && activeFilters.has("chuihap")) { if (rowState.includes("chuihap")) passFilter = true; }
      if (!passFilter && activeFilters.has("monthly")) { if (row.classList.contains("dash-tab-row-monthly")) passFilter = true; }
      if (!passFilter && activeFilters.has("taekhap")) { if (row.querySelector(".tc-taekhap-on")) passFilter = true; }
      if (!passFilter && activeFilters.has("done"))    { if (row.classList.contains("tab-done")) passFilter = true; }
      if (!passFilter && activeFilters.has("closed"))  { if (row.classList.contains("is-closed-row")) passFilter = true; }
      for (const f of activeFilters) {
        if (f.startsWith("review:")) {
          if (row.querySelector(`.tc-review-${f.slice(7)}`)) { passFilter = true; break; }
        }
      }
      for (const f of activeFilters) {
        if (f.startsWith("manager:")) {
          const cls = f.slice(8) === "만두" ? ".tc-mandu" : ".tc-mango";
          if (row.querySelector(cls)) { passFilter = true; break; }
        }
      }
    }

    // ② 검색어 필터 판단 (AND 조건)
    const passSearch = !hasQuery || _rowMatchesSearch(row, query, campName);

    const show = passFilter && passSearch;
    row.style.display = show ? "" : "none";
    if (show) totalMatchCount++;
  });

  // ③ 결과 카운트 업데이트
  const countEl = document.getElementById('dashSearchCount');
  if (countEl) {
    if (hasQuery) {
      countEl.classList.add('visible');
      if (totalMatchCount === 0) {
        countEl.textContent  = '결과 없음';
        countEl.classList.add('no-result');
      } else {
        countEl.textContent  = `${totalMatchCount}개 매칭`;
        countEl.classList.remove('no-result');
      }
    } else {
      countEl.classList.remove('visible', 'no-result');
      countEl.textContent = '';
    }
  }
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
  // ★ 상품명 공란이면 즉시 빨간 강조 표시
  _checkTcDisplayRequired(tcData.displayName || "");
  // 진행차수 옵션 선택 반영
  document.querySelectorAll("#tcOptRound .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.tcRound || tcData.round || ""));
  });
  // 배송유형 옵션 선택 반영
  document.querySelectorAll("#tcOptDelivery .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.deliveryType || ""));
  });
  // 시간대 → 피커 초기화
  initTcTimePicker(tcData.timeRange || "");
  // 택대
  document.getElementById("tcTaekhapCheck").checked = !!tcData.taekhap;
  // 대량건
  document.getElementById("tcBulkCheck").checked = !!tcData.isBulk;
  // 리뷰 폴더 URL
  document.getElementById("tcFolderUrlInput").value = tcData.folderUrl || "";
  // 캡처 폴더 URL
  document.getElementById("tcCaptureFolderUrlInput").value = tcData.captureFolderUrl || "";
  // 네이버+쿠팡 모드
  document.getElementById("tcNcModeCheck").checked = !!tcData.ncMode;
  // 제공정보 메모
  const _tcPmInput = document.getElementById("tcProviderMemoInput");
  if (_tcPmInput) _tcPmInput.value = tcData.providerMemo || "";
  // 입금명
  document.getElementById("tcDepositNameInput").value = tcData.depositName || "";
  _checkTcDepositRequired(tcData.depositName || "");
  // 이체은행
  document.querySelectorAll("#tcOptTransferBank .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.transferBank || ""));
  });
  // ★ v9.14: 진행방식 옵션 선택 반영
  document.querySelectorAll("#tcOptIncomeType .tc-opt").forEach(btn => {
    btn.classList.toggle("sel", btn.dataset.val === (tcData.incomeType || ""));
  });
  
  // ★ v9.14: 진행방식 = 소득신고 → 이체은행 자동 설정 = 케이뱅크
  if (tcData.incomeType === "소득신고") {
    document.querySelectorAll("#tcOptTransferBank .tc-opt").forEach(btn => {
      btn.classList.toggle("sel", btn.dataset.val === "케이뱅크");
    });
  }

  // ★ 다중 캡처 슬롯 에디터 렌더 (서버에서 현재 설정 조회 → 디커플)
  _renderCaptureSlotsEditor(tcData);

  // 위치 계산 — 뷰포트 경계 감지하여 자동 조정
  pop.classList.add("open"); // 먼저 열어서 실제 크기 측정
  const pw = pop.offsetWidth  || 304;
  const ph = pop.offsetHeight || 480;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = e.clientX;
  const cy = e.clientY;
  const margin = 8; // 화면 가장자리 여백
  // 좌우: 커서 오른쪽에 공간 없으면 왼쪽으로
  let left = cx + margin;
  if (left + pw > vw - margin) left = cx - pw - margin;
  if (left < margin) left = margin;
  // 상하: 커서 아래에 공간 없으면 위쪽으로
  let top = cy + margin;
  if (top + ph > vh - margin) top = cy - ph - margin;
  if (top < margin) top = margin;
  pop.style.left = left + "px";
  pop.style.top  = top  + "px";
}

// ★ 상품명 필수 검증 헬퍼 함수들
/** 상품명 공란 여부에 따라 입력란 강조/해제 */
function _checkTcDisplayRequired(val) {
  const input   = document.getElementById("tcDisplayInput");
  const warnMsg = document.getElementById("tcDisplayRequiredMsg");
  if (!input) return;
  const isEmpty = !val || !val.trim();
  input.classList.toggle("required-warn", isEmpty);
  if (warnMsg) warnMsg.classList.toggle("show", isEmpty);
}

/** 입금명 입력 시 실시간 강조 해제 */
function _onTcDepositInput(input) {
  const warnMsg = document.getElementById("tcDepositRequiredMsg");
  const isEmpty = !input.value.trim();
  input.classList.toggle("required-warn", isEmpty);
  if (warnMsg) warnMsg.classList.toggle("show", isEmpty);
}

/** 입금명 공란 여부에 따라 입력란 강조/해제 */
function _checkTcDepositRequired(val) {
  const input   = document.getElementById("tcDepositNameInput");
  const warnMsg = document.getElementById("tcDepositRequiredMsg");
  if (!input) return;
  const isEmpty = !val || !val.trim();
  input.classList.toggle("required-warn", isEmpty);
  if (warnMsg) warnMsg.classList.toggle("show", isEmpty);
}


/** 상품명 입력 시 실시간 강조 해제 */
function _onTcDisplayInput(input) {
  const warnMsg = document.getElementById("tcDisplayRequiredMsg");
  const isEmpty = !input.value.trim();
  input.classList.toggle("required-warn", isEmpty);
  if (warnMsg) warnMsg.classList.toggle("show", isEmpty);
}


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

/* ── 다중 캡처 슬롯 에디터 (탭 설정 팝오버 내) ── */
// 서버에서 현재 capture_slots를 조회해 라벨 입력 행을 렌더한다.
async function _renderCaptureSlotsEditor(tcData) {
  const list = document.getElementById("tcCaptureSlotsList");
  if (!list) return;
  list.innerHTML = '<div style="font-size:.66rem;color:#9CA3AF">불러오는 중...</div>';

  let slots = Array.isArray(tcData.captureSlots) ? tcData.captureSlots : null;
  if (!slots) {
    try {
      const json = await gasGet({ action: "getTabConfig", sheetId: tcData.sheetId, tabName: tcData.tabName });
      const cfgs = json?.configs || [];
      const cfg = cfgs.find(c => c.tab_name === tcData.tabName && c.sheet_id === tcData.sheetId) || cfgs[0];
      slots = Array.isArray(cfg?.capture_slots) ? cfg.capture_slots : [];
    } catch (_) { slots = []; }
  }

  // 팝오버가 그새 다른 탭으로 바뀌었으면 렌더 취소
  if (!_tcCurrent || _tcCurrent.tabName !== tcData.tabName) return;

  list.innerHTML = "";
  if (!slots || slots.length === 0) {
    _csAddSlotRow("리뷰");   // 첫 슬롯 시드 (기존 리뷰 제출과 호환)
  } else {
    slots.forEach(s => _csAddSlotRow((s && s.label) || ""));
  }
}

function _csAddSlotRow(label) {
  const list = document.getElementById("tcCaptureSlotsList");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "tc-cs-row";
  row.style.cssText = "display:flex;gap:6px;margin-bottom:5px;align-items:center";
  row.innerHTML =
    '<span class="tc-cs-num" style="font-size:.66rem;color:#92400E;width:14px;text-align:center;flex-shrink:0"></span>' +
    '<input type="text" class="tc-cs-label" placeholder="예: 리뷰 / 현금영수증" style="flex:1;min-width:0;padding:5px 8px;border:1px solid #FCD34D;border-radius:6px;font-size:.74rem;outline:none">' +
    '<button type="button" class="tc-cs-del" style="border:none;background:#FEE2E2;color:#B91C1C;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:.7rem;flex-shrink:0">삭제</button>';
  const input = row.querySelector(".tc-cs-label");
  input.value = label || "";
  row.querySelector(".tc-cs-del").addEventListener("click", () => { row.remove(); _csRenumberSlots(); });
  list.appendChild(row);
  _csRenumberSlots();
}

function _csRenumberSlots() {
  const list = document.getElementById("tcCaptureSlotsList");
  if (!list) return;
  Array.from(list.querySelectorAll(".tc-cs-row .tc-cs-num")).forEach((el, i) => { el.textContent = (i + 1); });
}

async function saveCaptureSlots() {
  if (!_tcCurrent) return;
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("API 서버 URL이 설정되지 않았습니다.", true); return; }
  const sheetId = _tcCurrent.sheetId || "";
  const tabName = _tcCurrent.tabName || "";
  if (!sheetId || !tabName) { showToast("sheetId/tabName을 특정할 수 없습니다.", true); return; }

  const labels = Array.from(document.querySelectorAll("#tcCaptureSlotsList .tc-cs-label"))
    .map(i => i.value.trim()).filter(Boolean);

  // 라벨 중복 방지
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) { showToast(`슬롯 라벨이 중복됩니다: "${dup}"`, "error"); return; }

  try {
    const json = await gasPost({ action: "setTabConfig", sheetId, tabName, captureSlots: labels });
    if (json && json.ok) {
      const n = (json.captureSlots || []).length;
      if (n > 1) {
        showToast(`다중 캡처 슬롯 저장됨 (${n}종) · 이미 완료된 기존 건을 받으려면 아래 '기존 완료행 보완 재오픈'을 누르세요`, "warning");
      } else {
        showToast("캡처 슬롯: 단일 기본(리뷰 1장)으로 저장됨", "success");
      }
    } else {
      showToast("캡처 슬롯 저장 실패: " + (json?.error || "알 수 없는 오류"), "error");
    }
  } catch (e) {
    showToast("캡처 슬롯 저장 오류: " + (e.message || ""), "error");
  }
}

// 기존 완료행 보완 재오픈 (저장된 슬롯 기준 — 먼저 dryRun으로 대상 수 확인 후 확정)
async function reopenIncompleteSlots() {
  if (!_tcCurrent) return;
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("API 서버 URL이 설정되지 않았습니다.", "error"); return; }
  const sheetId = _tcCurrent.sheetId || "";
  const tabName = _tcCurrent.tabName || "";
  if (!sheetId || !tabName) { showToast("sheetId/tabName을 특정할 수 없습니다.", "error"); return; }

  try {
    // 1) dryRun — 대상 건수 확인
    const dry = await gasPost({ action: "reopenSlots", sheetId, tabName, dryRun: true });
    if (!dry || !dry.ok) { showToast("재오픈 대상 조회 실패: " + (dry?.error || dry?.note || ""), "error"); return; }
    const cnt = dry.candidates || 0;
    if (cnt === 0) {
      showToast(dry.note || "재오픈할 완료행이 없습니다.", "info");
      return;
    }
    if (!confirm(`"${tabName}" 탭에서 누락 슬롯이 있는 완료행 ${cnt}건을 재오픈합니다.\n\n해당 행은 미제출 상태로 돌아가 리뷰어 검색에 다시 노출되고, 제출완료 카운트가 ${cnt} 차감됩니다.\n계속할까요?`)) return;

    // 2) 실제 재오픈
    const res = await gasPost({ action: "reopenSlots", sheetId, tabName });
    if (res && res.ok) {
      showToast(`↺ ${res.reopened || 0}건 재오픈됨 — 리뷰어가 보완 제출할 수 있습니다.`, "success");
    } else {
      showToast("재오픈 실패: " + (res?.error || "알 수 없는 오류"), "error");
    }
  } catch (e) {
    showToast("재오픈 오류: " + (e.message || ""), "error");
  }
}

/* ── 네이버+쿠팡 모드 헤더 변환 ── */
async function convertToNcHeaders() {
  if (!_tcCurrent) return;
  const btn = document.getElementById("btnConvertNcHeaders");
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL이 설정되지 않았습니다.", "error"); return; }

  const sheetId = _tcCurrent.sheetId || "";
  const tabName = _tcCurrent.tabName || "";
  if (!sheetId || !tabName) { showToast("sheetId 또는 tabName이 없습니다.", "error"); return; }

  if (!confirm(`"${tabName}" 탭의 시트 헤더를 네이버+쿠팡 모드로 변환하시겠습니까?\n\n기존 주문번호·아이디·결제금액 컬럼 데이터가 삭제됩니다.`)) return;

  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 변환 중...'; }

  try {
    const payload = { action: "convertToNcHeaders", sheetId, tabName };
    let res = null;
    try { res = await gasPost(payload); } catch(e){ try { res = await gasGet(payload); } catch(e2){} }

    if (res?.ok) {
      if (res.alreadyConverted) {
        showToast("ℹ️ 이미 네이버+쿠팡 모드로 변환된 탭입니다.", "info");
      } else {
        showToast("✅ 헤더 변환 완료! 네이버+쿠팡 모드가 적용되었습니다.", "success");
      }
    } else {
      showToast("❌ 변환 실패: " + (res?.error || "알 수 없는 오류"), "error");
    }
  } catch(err) {
    showToast("❌ 오류: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-exchange-alt"></i> 이 탭 시트 헤더 → 네이버+쿠팡 모드 변환'; }
  }
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
  const opt = e.target.closest("#tcOptManager .tc-opt, #tcOptReview .tc-opt, #tcOptPayment .tc-opt, #tcOptDelivery .tc-opt, #tcOptRound .tc-opt, #tcOptTransferBank .tc-opt, #tcOptIncomeType .tc-opt");
  if (!opt) return;
  const group = opt.closest(".tc-option-row");
  group.querySelectorAll(".tc-opt").forEach(b => b.classList.remove("sel"));
  opt.classList.add("sel");
  
  // ★ v9.14: 진행방식 = 소득신고 → 이체은행 자동 설정 = 케이뱅크
  if (opt.closest("#tcOptIncomeType") && opt.dataset.val === "소득신고") {
    const bankGroup = document.querySelector("#tcOptTransferBank");
    if (bankGroup) {
      bankGroup.querySelectorAll(".tc-opt").forEach(b => b.classList.remove("sel"));
      const kbankBtn = Array.from(bankGroup.querySelectorAll(".tc-opt")).find(b => b.dataset.val === "케이뱅크");
      if (kbankBtn) kbankBtn.classList.add("sel");
    }
  }
});

// 저장 버튼 → 경고 팝업 띄우기
function requestTcSave() {
  if (!_tcCurrent) return;
  // 현재 입력값 snapshot
  _tcCurrent._pendingManager      = (document.querySelector("#tcOptManager .tc-opt.sel")   || {}).dataset?.val ?? "";

  _tcCurrent._pendingReviewType   = (document.querySelector("#tcOptReview .tc-opt.sel")    || {}).dataset?.val ?? "";
  _tcCurrent._pendingPaymentType  = (document.querySelector("#tcOptPayment .tc-opt.sel")   || {}).dataset?.val ?? "";
  _tcCurrent._pendingDeliveryType = (document.querySelector("#tcOptDelivery .tc-opt.sel")  || {}).dataset?.val ?? "";
  _tcCurrent._pendingDisplayName  = document.getElementById("tcDisplayInput").value.trim();
  _tcCurrent._pendingRound        = (document.querySelector("#tcOptRound .tc-opt.sel") || {}).dataset?.val ?? "";
  _tcCurrent._pendingTimeRange    = document.getElementById("tcTimeInput").value.trim();
  _tcCurrent._pendingTaekhap      = document.getElementById("tcTaekhapCheck").checked;
  _tcCurrent._pendingIsBulk       = document.getElementById("tcBulkCheck").checked;
  _tcCurrent._pendingFolderUrl    = document.getElementById("tcFolderUrlInput").value.trim();
  _tcCurrent._pendingCaptureUrl   = document.getElementById("tcCaptureFolderUrlInput").value.trim();
  _tcCurrent._pendingNcMode       = document.getElementById("tcNcModeCheck").checked;
  _tcCurrent._pendingDepositName  = document.getElementById("tcDepositNameInput").value.trim();
  _tcCurrent._pendingTransferBank = (document.querySelector("#tcOptTransferBank .tc-opt.sel") || {}).dataset?.val ?? "";
  _tcCurrent._pendingIncomeType   = (document.querySelector("#tcOptIncomeType .tc-opt.sel")   || {}).dataset?.val ?? "";  // ★ v9.14
  _tcCurrent._pendingProviderMemo = (document.getElementById("tcProviderMemoInput")?.value ?? "").replace(/\s+$/g, "");  // 제공정보 메모 (끝 공백만 제거)

  // ★ 상품명 필수 검증 (마감 탭은 예외)
  const _isClosedOrDone = !!_tcCurrent._isClosed;
  if (!_tcCurrent._pendingDisplayName && !_isClosedOrDone) {
    // 입력란 강조 + 스크롤
    _checkTcDisplayRequired("");
    const input = document.getElementById("tcDisplayInput");
    if (input) { input.focus(); input.scrollIntoView({ behavior: "smooth", block: "center" }); }
    showToast("⚠️ 상품명은 필수 항목입니다. 입력 후 저장해주세요.", "warning");
    return; // 저장 중단
  }


  // ★ nc 모드가 새로 켜지는 경우 → 전용 확인 팝업 표시
  const prevNcMode = !!_tcCurrent.ncMode;
  if (_tcCurrent._pendingNcMode && !prevNcMode) {
    document.getElementById("tcNcConfirmOverlay").classList.add("open");
    return; // 일반 confirm 팝업은 띄우지 않음
  }

  const _prevDisp  = _tcCurrent.displayName || "";
  const _newDisp   = _tcCurrent._pendingDisplayName || "";
  const _prevRound = _tcCurrent.tcRound || _tcCurrent.round || "";
  const _newRound  = _tcCurrent._pendingRound ?? "";
  const _dispChanged  = _newDisp  && _prevDisp  && _newDisp  !== _prevDisp;
  const _roundChanged = _newRound !== _prevRound;
  const _folderWarn   = (_dispChanged || _roundChanged) && (_tcCurrent.captureFolderUrl || _tcCurrent.folderUrl)
    ? `<br><span style="color:#D97706;font-size:.82em">📁 상품명/차수 변경 감지 → 캡처/리뷰 폴더명이 자동으로 rename됩니다.</span>`
    : "";
  document.getElementById("tcConfirmMsg").innerHTML =
    `<b>${escHtml(_tcCurrent.tabName)}</b> 탭의 설정을 변경하시겠습니까?<br>저장하면 베이스시트에 즉시 반영됩니다.${_folderWarn}`;
  document.getElementById("tcConfirmOverlay").classList.add("open");
}

function closeTcNcConfirm() {
  document.getElementById("tcNcConfirmOverlay").classList.remove("open");
}

// nc 모드 확인 팝업 → [확인] 클릭
function confirmTcNcSave() {
  closeTcNcConfirm();
  // 일반 저장 로직 진행 (confirmTcSave와 동일)
  confirmTcSave();
}

function closeTcConfirm() {
  document.getElementById("tcConfirmOverlay").classList.remove("open");
}

async function confirmTcSave() {
  closeTcConfirm();
  _closeTcPopoverUiOnly(); // _tcCurrent는 유지한 채 팝오버 UI만 닫음
  if (!_tcCurrent) return;

  // ① API 서버 URL 설정 여부 확인
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    showToast("❌ API 서버 URL이 설정되지 않았습니다.", true);
    _tcCurrent = null;
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
    action:       "setTabConfig",
    sheetId:      resolvedSheetId,
    sheetUrl:     resolvedSheetUrl,
    tabName:      _tcCurrent.tabName              || "",
    manager:      _tcCurrent._pendingManager      || "",
    timeRange:    _tcCurrent._pendingTimeRange    || "",
    taekhap:      _tcCurrent._pendingTaekhap ? "true" : "false",
    reviewType:   _tcCurrent._pendingReviewType   || "",
    paymentType:  _tcCurrent._pendingPaymentType  || "",
    displayName:  _tcCurrent._pendingDisplayName  || "",
    deliveryType: _tcCurrent._pendingDeliveryType || "",
    isBulk:       _tcCurrent._pendingIsBulk ? "true" : "false",
    round:        _tcCurrent._pendingRound,        // 차수 (undefined면 GAS에서 기존값 보존)
    folderUrl:    _tcCurrent._pendingFolderUrl,   // undefined면 GAS에서 기존값 보존
    ncMode:       _tcCurrent._pendingNcMode ? "true" : "false",
    depositName:  _tcCurrent._pendingDepositName  ?? "",
    transferBank: _tcCurrent._pendingTransferBank ?? "",
    incomeType:   _tcCurrent._pendingIncomeType   ?? "",   // ★ v9.14: 진행방식 (undefined → 기존값 보존, "" → 빈값으로 저장)
    providerMemo: _tcCurrent._pendingProviderMemo ?? ""    // 제공정보 메모 (구매양식 제출화면 표시)
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

      // ★ 캡처폴더 URL이 변경된 경우 updateFolderUrls로 별도 저장
      const prevCaptureUrl = _tcCurrent.captureFolderUrl || "";
      const newCaptureUrl  = _tcCurrent._pendingCaptureUrl;
      if (newCaptureUrl !== undefined && newCaptureUrl !== prevCaptureUrl) {
        try {
          const folderPayload = {
            action:           "updateFolderUrls",
            sheetId:          resolvedSheetId,
            tabName:          _tcCurrent.tabName || "",
            captureFolderUrl: newCaptureUrl
          };
          const folderJson = await gasPost(folderPayload);
          if (folderJson && folderJson.ok) {
            console.log("[TC] 캡처폴더 URL 수정 완료:", newCaptureUrl);
          } else {
            console.warn("[TC] 캡처폴더 URL 수정 실패:", folderJson?.error);
          }
        } catch (fe) {
          console.warn("[TC] 캡처폴더 URL 수정 오류:", fe.message);
        }
      }

      // 폴더 rename 결과 토스트
      const _fr = json.folderRename;
      let _toastMsg = "✅ 설정이 저장되었습니다." + (json.updated ? " (업데이트)" : " (신규)");
      if (_fr && (_fr.renamedCapture || _fr.renamedReview)) {
        const _rParts = [];
        if (_fr.renamedCapture) _rParts.push("캡처");
        if (_fr.renamedReview)  _rParts.push("리뷰");
        _toastMsg += ` 📁 ${_rParts.join("/")}폴더 rename 완료`;
      } else if (_fr && _fr.errors && _fr.errors.length > 0) {
        _toastMsg += " ⚠️ 폴더 rename 중 오류 발생 (콘솔 확인)";
        console.warn("[TC] 폴더 rename 오류:", _fr.errors);
      }
      showToast(_toastMsg);
      // ★ 전체 새로고침 대신 해당 탭 데이터만 패치 → 로딩 없이 즉시 반영
      _patchTabAndRerender(payload.sheetId, payload.tabName, {
        displayName:       payload.displayName,
        manager:           payload.manager,
        timeRange:         payload.timeRange,
        taekhap:           payload.taekhap === "true",
        reviewType:        payload.reviewType,
        paymentType:       payload.paymentType,
        deliveryType:      payload.deliveryType,
        isBulk:            payload.isBulk === "true",
        tcRound:           payload.round,
        folderUrl:         payload.folderUrl !== undefined ? payload.folderUrl : (_tcCurrent.folderUrl || ""),
        captureFolderUrl:  (newCaptureUrl !== undefined && newCaptureUrl !== prevCaptureUrl)
                             ? newCaptureUrl
                             : prevCaptureUrl,
        depositName:       payload.depositName  || "",
        transferBank:      payload.transferBank || "",
        incomeType:        payload.incomeType   || "",    // ★ v9.14: 진행방식
        providerMemo:      payload.providerMemo || ""     // 제공정보 메모
      });
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
      background: isErr ? "#EF4444" : "#12b886",
      color:"#fff", padding:"8px 20px", borderRadius:"20px",
      fontSize:".82rem", fontWeight:"600", zIndex:"9999",
      boxShadow:"0 4px 14px rgba(0,0,0,.2)", transition:"opacity .3s"
    });
    document.body.appendChild(t);
  }
  t.style.background = isErr ? "#EF4444" : "#12b886";
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.style.opacity = "0"; }, 2500);
}

/* ── GAS 설정 모달 ── */
/* ── 동기화 모달 ── */
function openIndexModal() {
  show("indexModal", "flex");
  if (APP_CONFIG.GAS_WEB_APP_URL) {
    loadIndexStatus();
    _updateSmartDirtyBadge();
  }
  _updateSyncStatusPanel();
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

/* ══════════════════════════════════════════════════════════════
   ★ 우클릭 컨텍스트 메뉴 (대시보드 캠페인 행에서 사용)
   ══════════════════════════════════════════════════════════════ */
let _ctxTargetTabKey = null;
let _ctxTargetCampIdx = null;

function _openAdminContextMenu(e, tabKey, campIdx) {
  e.preventDefault();
  _ctxTargetTabKey  = tabKey  || null;
  _ctxTargetCampIdx = campIdx || null;

  const menu = document.getElementById("adminContextMenu");
  if (!menu) return;

  const isTabRow = !!tabKey;
  menu.innerHTML = `
    ${isTabRow ? `<div class="ctx-menu-title">⚡ 빠른 작업</div>` : ''}
    ${isTabRow ? `
      <button class="ctx-menu-item indigo" onclick="_ctxCloseCamp()">
        <i class="fas fa-archive"></i> 마감 처리
      </button>
      <hr class="ctx-menu-sep">
    ` : ''}
    <div class="ctx-menu-title">🔧 관리</div>
    <button class="ctx-menu-item" onclick="openAddCampaign(); closeAdminContextMenu()">
      <i class="fas fa-plus"></i> 작업시트 추가
    </button>
    <button class="ctx-menu-item" onclick="openBlPanel(); closeAdminContextMenu()">
      <i class="fas fa-ban"></i> 블랙리스트 관리
    </button>
    <button class="ctx-menu-item" onclick="openNoticePanel(); closeAdminContextMenu()">
      <i class="fas fa-bullhorn"></i> 공지 설정
    </button>
    <hr class="ctx-menu-sep">
    <div class="ctx-menu-title">📊 대시보드</div>
    <button class="ctx-menu-item" onclick="loadAdminDashboard(); closeAdminContextMenu()">
      <i class="fas fa-sync-alt"></i> 새로고침
    </button>
  `;

  menu.classList.add("open");

  // 화면 경계 처리
  const mw = 210, mh = 280;
  let x = e.clientX + 4, y = e.clientY + 4;
  if (x + mw > window.innerWidth)  x = e.clientX - mw;
  if (y + mh > window.innerHeight) y = e.clientY - mh;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  // 외부 클릭 시 닫기
  setTimeout(() => {
    document.addEventListener("click", closeAdminContextMenu, { once: true });
    document.addEventListener("contextmenu", closeAdminContextMenu, { once: true });
  }, 0);
}

function closeAdminContextMenu() {
  const menu = document.getElementById("adminContextMenu");
  if (menu) menu.classList.remove("open");
  _ctxTargetTabKey  = null;
  _ctxTargetCampIdx = null;
}



// 컨텍스트 메뉴에서 마감
function _ctxCloseCamp() {
  closeAdminContextMenu();
  if (!_ctxTargetTabKey) return;
  if (!_closedMode) toggleClosedMode();
  const cb = document.querySelector(`.closed-cb[data-tabkey="${_ctxTargetTabKey}"]`);
  if (cb) { cb.checked = true; }
  showToast(`'${_ctxTargetTabKey}' 마감 선택됨. [실행] 버튼으로 확정하세요.`, "info");
}


/* ── 하위 호환: 구 함수명 alias ── */
function openAdminSetting() { openIndexModal(); }
function closeAdminSetting() { closeIndexModal(); }
function saveAdminSetting() { closeIndexModal(); }


/* ── 인덱스 상태 / 갱신 ── */

/**
 * ★ v9.12: dirty 탭 수를 조회하여 "스마트빌드 갱신" 버튼 배지 업데이트
 * dirty 탭이 있으면 변경된 캠페인 수를 배지로 표시
 */
async function _updateSmartDirtyBadge() {
  try {
    // indexStatus 응답에 dirtyCount 정보가 있으면 활용 (없으면 표시 안 함)
    const data = await gasGet({ action: "indexStatus" }, 6000);
    const badge   = document.getElementById("smartDirtyBadge");
    const hintEl  = document.getElementById("smartModeHint");
    const hintTxt = document.getElementById("smartModeHintText");
    if (!badge) return;
    const dirtyCnt = data.dirtyCount || 0;
    if (dirtyCnt > 0) {
      // ★ v10.0: 배지 스타일 강화 — 흰 반투명 → 빨간 배지로 더 눈에 띄게
      badge.textContent = dirtyCnt + "개 변경";
      badge.style.cssText = "display:inline;background:#DC2626;color:#fff;padding:1px 7px;border-radius:10px;font-size:.7rem;font-weight:700;margin-left:5px;";
      if (hintEl && hintTxt) {
        hintTxt.textContent = `🔴 변경된 캠페인 ${dirtyCnt}개 — 스마트빌드 갱신 클릭 시 해당 캠페인만 재갱신합니다.`;
        hintEl.style.display = "";
        hintEl.style.color = "#DC2626";
      }
    } else {
      badge.style.display = "none";
      if (hintEl && hintTxt) {
        hintTxt.textContent = "변경된 탭 없음 — 클릭 시 전체 갱신 주기 도래 여부에 따라 자동 판단합니다.";
        hintEl.style.display = "";
        hintEl.style.color = "#6b7280";
      }
    }
    // ★ v10.2 P2-C: 고아 행 경고 (orphanCount > 0)
    _handleOrphanRowsWarning(data.orphanCount || 0, data.orphanRows || []);
  } catch (_) {}
}

// ★ v10.2 P2-C: 고아 행 경고 배너 처리
let _lastOrphanCount = 0;
function _handleOrphanRowsWarning(orphanCount, orphanRows) {
  _lastOrphanCount = orphanCount;
  // 기존 배너 제거
  const existBanner = document.getElementById("orphanRowsBanner");
  if (existBanner) existBanner.remove();
  if (orphanCount <= 0) return;

  // 경고 배너 생성
  const banner = document.createElement("div");
  banner.id = "orphanRowsBanner";
  banner.style.cssText = "background:#FFF7ED;border:1px solid #FB923C;border-radius:8px;padding:12px 16px;"
    + "margin:8px 0;font-size:.85rem;color:#9A3412;line-height:1.6;";

  const sampleHtml = (orphanRows && orphanRows.length > 0)
    ? orphanRows.slice(0, 5).map(o =>
        `<span style="font-family:monospace;font-size:.78rem">• ${escHtml(o.tabName || o.sheetId)} (행 ${o.rowNum})</span>`
      ).join("<br>")
    : "";

  banner.innerHTML = `<b><i class="fas fa-broom" style="color:#F97316"></i> 미사용 세부목록 행 ${orphanCount}개 감지</b>`
    + (sampleHtml ? `<br><div style="margin:6px 0 4px;padding:6px 8px;background:#FED7AA;border-radius:4px;font-size:.78rem">${sampleHtml}</div>` : "")
    + `<br><button onclick="cleanOrphanRows()" style="margin-top:4px;padding:4px 14px;background:#EA580C;color:#fff;`
    + `border:none;border-radius:6px;font-size:.8rem;cursor:pointer;font-weight:700">`
    + `<i class="fas fa-trash-alt"></i> 미사용 설정 정리</button>`
    + `<button onclick="document.getElementById('orphanRowsBanner').remove()" style="margin-left:8px;padding:4px 10px;`
    + `background:transparent;color:#9A3412;border:1px solid #FB923C;border-radius:6px;font-size:.8rem;cursor:pointer">`
    + `무시</button>`;

  // gasErrorBanner 앞에 삽입
  const anchor = document.getElementById("gasErrorBanner") || document.getElementById("indexSettingContent");
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(banner, anchor);
  }
}

/**
 * ★ v10.2 P2-C: 고아 세부목록 행 일괄 삭제
 */
async function cleanOrphanRows() {
  if (!confirm(`미사용 세부목록 행 ${_lastOrphanCount}개를 삭제합니다.\n삭제된 행은 복구할 수 없습니다. 계속하시겠습니까?`)) return;
  try {
    showToast("⏳ 미사용 설정 정리 중...", false);
    const data = await gasGet({ action: "cleanOrphanDetailRows" }, 30000);
    if (data.ok) {
      showToast(`✅ ${data.deleted}개 미사용 행 삭제 완료`, "success");
      const banner = document.getElementById("orphanRowsBanner");
      if (banner) banner.remove();
      _lastOrphanCount = 0;
    } else {
      showToast("❌ 정리 오류: " + (data.error || "알 수 없는 오류"), "error");
    }
  } catch (e) {
    showToast("❌ 요청 실패: " + e.message, "error");
  }
}

async function loadIndexStatus() {
  const builtAt = document.getElementById("indexBuiltAt");
  const count   = document.getElementById("indexCount");
  const badge   = document.getElementById("indexStatusBadge");
  if (!badge) return;
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
    // ★ v10.2 P2-C: 고아 행 경고 처리
    _handleOrphanRowsWarning(data.orphanCount || 0, data.orphanRows || []);
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
  bar.style.background = "linear-gradient(90deg,#12b886,#0ca678)";
  setTimeout(() => {
    hide(wrap);
    // 바 색상 원복
    bar.style.background = "linear-gradient(90deg,var(--p),#3182f6)";
  }, 2500);
}


// ── 탭 파싱 진단 ────────────────────────────────────────────────
async function runSheetDiag() {
  const urlInput = document.getElementById("diagSheetUrl");
  const resultEl = document.getElementById("diagResult");
  const rawUrl   = (urlInput?.value || "").trim();
  if (!rawUrl) { showToast("시트 URL을 입력해주세요.", "warning"); return; }

  // URL에서 sheetId, gid 추출
  const sheetIdMatch = rawUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch     = rawUrl.match(/[#&?]gid=(\d+)/);
  if (!sheetIdMatch) { showToast("올바른 스프레드시트 URL이 아닙니다.", "error"); return; }

  const sheetId = sheetIdMatch[1];
  const gid     = gidMatch ? gidMatch[1] : "";

  resultEl.style.display = "block";
  resultEl.innerHTML = '<span style="color:#3182f6"><i class="fas fa-circle-notch fa-spin"></i> 진단 중...</span>';

  try {
    const data = await gasGet({ action: "debugSheet", sheetId, gid }, 30000);

    if (data.error) {
      resultEl.innerHTML = `<div style="color:#EF4444;padding:6px;background:#FEF2F2;border-radius:6px">❌ ${escHtml(data.error)}</div>`;
      return;
    }

    const willParse = data.willParse;
    const bg        = willParse ? "#F0FDF4" : "#FFF7ED";
    const border    = willParse ? "#BBF7D0" : "#FED7AA";
    const icon      = willParse ? "✅" : "⚠️";
    const statusMsg = willParse
      ? "정상 파싱 가능 — 동기화 시 조회됩니다"
      : "파싱 불가 — 헤더 키워드가 인식되지 않아 인덱스에서 제외됩니다";

    const headerPreview  = (data.detectedHeaders || []).filter(h => h).join(", ") || "(헤더 탐지 실패)";
    const nameColsPreview = (data.nameColsFound  || []).map(x => `${x.header}(${x.keyword})`).join(", ") || "(없음)";
    const previewHtml    = (data.previewRows || []).map(r =>
      `<div style="color:${r.isDataRow ? "#166534" : "#6B7280"}">행${r.rowNum}${r.isDataRow ? " ★헤더" : ""}: ${escHtml(r.cells.substring(0,80))}</div>`
    ).join("");

    resultEl.innerHTML = `
      <div style="padding:8px;background:${bg};border:1px solid ${border};border-radius:6px;line-height:1.6">
        <div style="font-weight:700;font-size:.78rem">${icon} ${data.sheetName} — ${statusMsg}</div>
        <div style="margin-top:4px;font-size:.71rem;color:#374151">
          <b>헤더 행:</b> ${data.detectedHeaderRow > 0 ? data.detectedHeaderRow + "행" : "미탐지"}<br>
          <b>인식된 헤더:</b> ${escHtml(headerPreview)}<br>
          <b>이름 컬럼:</b> ${escHtml(nameColsPreview)}<br>
          <b>전체 행수:</b> ${data.totalRows}행 / <b>전체 열수:</b> ${data.totalCols}열
        </div>
        ${!willParse ? `
        <div style="margin-top:6px;font-size:.71rem;color:#92400E;border-top:1px solid ${border};padding-top:5px">
          <b>탐지 키워드:</b> ${escHtml((data.DATA_TAB_KEYWORDS||[]).join(", "))}<br>
          <b>이름 키워드:</b> ${escHtml((data.SEARCH_COLS||[]).join(", "))}<br>
          → 위 키워드가 헤더에 없으면 GAS 담당자에게 헤더 확인 요청이 필요합니다.
        </div>` : ""}
        <details style="margin-top:4px">
          <summary style="font-size:.7rem;color:#6B7280;cursor:pointer">상위 행 미리보기</summary>
          <div style="font-size:.68rem;color:#4B5563;margin-top:2px">${previewHtml}</div>
        </details>
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<div style="color:#EF4444">❌ 오류: ${escHtml(err.message)}</div>`;
  }
}

// ── 폴더 일괄 생성/배치 ──────────────────────────────────────
// target: "capture" | "review" | "both"

// ── 캡처폴더 현황 진단 ────────────────────────────────────────
// 드라이브 실제 폴더명 vs 세부목록 tab_name/display_name 매핑 결과 표시
async function diagCaptureFolders() {
  const btn   = document.getElementById("btnDiagCapture");
  const resEl = document.getElementById("diagCaptureResult");
  if (btn) btn.disabled = true;
  resEl.style.display = "block";
  resEl.innerHTML = `<span style="color:#6B7280"><i class="fas fa-spinner fa-spin"></i> 폴더 현황 조회 중...</span>`;

  try {
    const data = await gasGet({ action: "diagCaptureFolders" });
    if (!data || data.error) {
      resEl.innerHTML = `<span style="color:#EF4444">&cross; 오류: ${escHtml(data?.error || "응답 없음")}</span>`;
      return;
    }

    const details = data.details || [];
    const total   = data.total || details.length;
    const noFolder  = data.noFolderUrl  || 0;
    const noCapture = data.noCaptureFolderUrl || 0;
    const oauth     = data.oauthStatus || "unknown";

    // 활성/마감 분류
    const active = details.filter(d => !d.isClosed);
    const activeNoCapture = active.filter(d => !d.captureFolderUrl);
    const activeNoFolder  = active.filter(d => !d.folderUrl);

    let html = `<div style="padding:6px 8px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:6px;margin-bottom:6px;font-size:.72rem">
      <b style="color:#1D4ED8"><i class="fas fa-chart-pie"></i> 진단 결과</b>
      &nbsp;&middot;&nbsp; 전체 탭 <b>${total}개</b>
      &nbsp;&middot;&nbsp; 활성 탭 <b>${active.length}개</b>
      &nbsp;&middot;&nbsp; OAuth <b style="color:${oauth==='ok'?'#166534':'#B45309'}">${oauth}</b>
    </div>`;

    // 요약 카드
    html += `<div style="display:flex;gap:6px;margin-bottom:6px;font-size:.70rem">
      <div style="flex:1;padding:5px 8px;background:${activeNoCapture.length?'#FFF7ED':'#F0FDF4'};border:1px solid ${activeNoCapture.length?'#FED7AA':'#BBF7D0'};border-radius:6px">
        <b>캡처폴더 미설정</b><br>활성 탭 중 <b style="color:${activeNoCapture.length?'#B45309':'#166534'}">${activeNoCapture.length}개</b>
      </div>
      <div style="flex:1;padding:5px 8px;background:${activeNoFolder.length?'#FFF7ED':'#F0FDF4'};border:1px solid ${activeNoFolder.length?'#FED7AA':'#BBF7D0'};border-radius:6px">
        <b>리뷰폴더 미설정</b><br>활성 탭 중 <b style="color:${activeNoFolder.length?'#B45309':'#166534'}">${activeNoFolder.length}개</b>
      </div>
    </div>`;

    // 미설정 탭 목록 (활성 중)
    if (activeNoCapture.length > 0 || activeNoFolder.length > 0) {
      const missingTabs = active.filter(d => !d.captureFolderUrl || !d.folderUrl);
      html += `<details style="margin-bottom:6px"><summary style="font-size:.70rem;color:#92400E;cursor:pointer;font-weight:600">
        <i class="fas fa-exclamation-triangle"></i> 미설정 탭 ${missingTabs.length}개 (클릭해서 보기)
      </summary>
      <table style="width:100%;border-collapse:collapse;font-size:.67rem;margin-top:3px">
        <tr style="background:#F3F4F6">
          <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:left">탭명</th>
          <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:left">캠페인</th>
          <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:center">캡처</th>
          <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:center">리뷰</th>
        </tr>
        ${missingTabs.map(d => `<tr>
          <td style="padding:2px 5px;border:1px solid #E5E7EB;font-family:monospace">${escHtml(d.tabName)}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB">${escHtml(d.campaignName||"-")}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB;text-align:center">${d.captureFolderUrl?"&check;":"<span style='color:#EF4444'>&cross;</span>"}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB;text-align:center">${d.folderUrl?"&check;":"<span style='color:#EF4444'>&cross;</span>"}</td>
        </tr>`).join("")}
      </table></details>`;
    }

    // 전체 탭 목록
    html += `<details><summary style="font-size:.70rem;color:#6B7280;cursor:pointer;font-weight:600">
      <i class="fas fa-list"></i> 전체 탭 목록 (${total}개)
    </summary>
    <table style="width:100%;border-collapse:collapse;font-size:.66rem;margin-top:3px">
      <tr style="background:#F3F4F6">
        <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:left">탭명</th>
        <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:left">캠페인</th>
        <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:center">캡처</th>
        <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:center">리뷰</th>
        <th style="padding:3px 5px;border:1px solid #E5E7EB;text-align:center">상태</th>
      </tr>
      ${details.map(d => {
        const st = d.isClosed ? "마감" : "활성";
        const stColor = d.isClosed ? "#6B7280" : "#166534";
        return `<tr style="background:${d.isClosed?'#F9FAFB':'#fff'}">
          <td style="padding:2px 5px;border:1px solid #E5E7EB;font-family:monospace">${escHtml(d.tabName)}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB">${escHtml(d.campaignName||"-")}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB;text-align:center">${d.captureFolderUrl?"&check;":"&mdash;"}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB;text-align:center">${d.folderUrl?"&check;":"&mdash;"}</td>
          <td style="padding:2px 5px;border:1px solid #E5E7EB;text-align:center;color:${stColor}">${st}</td>
        </tr>`;
      }).join("")}
    </table></details>`;

    resEl.innerHTML = html;

  } catch (err) {
    resEl.innerHTML = `<span style="color:#EF4444">&cross; 예외: ${escHtml(err.message)}</span>`;
    console.error("[diagCaptureFolders] 오류:", err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── 캡처폴더 구조 재편성 (단층 → 캠페인폴더 하위) ─────────────
// dryRun=true → 미리보기 / dryRun=false → 실제 이동
async function organizeCaptureFolders(dryRun) {
  const btnDry = document.getElementById("btnOrganizeDry");
  const btnRun = document.getElementById("btnOrganizeRun");
  const resEl  = document.getElementById("organizeResult");

  if (btnDry) btnDry.disabled = true;
  if (btnRun) btnRun.disabled = true;
  resEl.style.display = "block";
  resEl.innerHTML = `<span style="color:#6B7280"><i class="fas fa-spinner fa-spin"></i> ${dryRun ? "미리보기 분석 중..." : "폴더 재편성 실행 중..."}</span>`;

  try {
    const payload = { action: "organizeCaptureFolders", dryRun: dryRun ? "true" : "false" };
    const timeout = dryRun ? 60000 : 300000;
    const data = dryRun
      ? await gasGet({ action: "organizeCaptureFolders", dryRun: "true" })
      : await gasPost(payload, timeout, { forcePost: true });

    if (!data || data.error) {
      resEl.innerHTML = `<span style="color:#EF4444">❌ 오류: ${escHtml(data?.error || "응답 없음")}</span>`;
      return;
    }

    const movedCount   = (data.moved   || []).length;
    const createdCount = (data.created || []).length;
    const skippedCount = (data.skipped || []).length;
    const errorCount   = (data.errors  || []).length;
    const isDry        = data.dryRun;

    // ── 결과 헤더 ──
    let html = `<div style="padding:6px 8px;background:${isDry ? "#FFFBEB" : "#F0FDF4"};border:1px solid ${isDry ? "#FDE68A" : "#86EFAC"};border-radius:6px;margin-bottom:4px">
      <b style="color:${isDry ? "#92400E" : "#166534"}">${isDry ? "🔍 미리보기 결과" : "✅ 재편성 완료"}</b>
      &nbsp;·&nbsp; 이동 <b>${movedCount}건</b>
      &nbsp;·&nbsp; 신규 캠페인폴더 <b>${createdCount}건</b>
      &nbsp;·&nbsp; 스킵 <b>${skippedCount}건</b>
      ${errorCount > 0 ? `&nbsp;·&nbsp; <span style="color:#EF4444">오류 ${errorCount}건</span>` : ""}
      &nbsp;·&nbsp; <span style="color:#6B7280">${data.elapsed}초</span>
    </div>`;

    // ── 이동 목록 ──
    if (movedCount > 0) {
      html += `<div style="font-weight:700;color:#166534;margin:4px 0 2px">
        📂 이동${isDry ? "(예정)" : "완료"} — 결과 경로: 📁캠페인폴더 / 📁인덱스폴더(원본명 그대로) / 🖼️캡처이미지
      </div>`;
      (data.moved || []).forEach(m => {
        html += `<div style="padding:3px 6px;border-bottom:1px solid #E5E7EB;font-size:.68rem;display:flex;align-items:center;gap:3px">
          <span style="color:#6B7280;font-size:.63rem">이전:</span>
          <span style="color:#9CA3AF;font-family:monospace">📁${escHtml(m.folder)}</span>
          <span style="color:#9CA3AF;font-size:.65rem"> ▶ </span>
          <span style="color:#6B7280;font-size:.63rem">이후:</span>
          <span style="font-family:monospace">
            📁<b style="color:#166534">${escHtml(m.campFolder)}</b>
            <span style="color:#9CA3AF">/</span>
            📁<span style="color:#1F2937">${escHtml(m.folder)}</span>
            <span style="color:#9CA3AF;font-size:.62rem"> / 🖼️이미지</span>
          </span>
        </div>`;
      });
    }

    // ── 신규 생성 캠페인폴더 ──
    if (createdCount > 0) {
      html += `<div style="font-weight:700;color:#0369A1;margin:4px 0 2px">🆕 생성된 캠페인폴더${isDry ? "(예정)" : ""}:</div>`;
      (data.created || []).forEach(c => {
        html += `<div style="padding:2px 4px;color:#0369A1">📁 ${escHtml(c.campFolder)}</div>`;
      });
    }

    // ── 스킵 목록 ──
    if (skippedCount > 0) {
      html += `<details style="margin-top:4px"><summary style="font-size:.7rem;color:#6B7280;cursor:pointer">스킵 ${skippedCount}건 (클릭해서 보기)</summary>`;
      (data.skipped || []).forEach(s => {
        html += `<div style="padding:2px 4px;font-size:.68rem;color:#6B7280;border-bottom:1px solid #F3F4F6">
          <span style="color:#374151">${escHtml(s.folder)}</span> — ${escHtml(s.reason)}
        </div>`;
      });
      html += `</details>`;
    }

    // ── 오류 ──
    if (errorCount > 0) {
      html += `<div style="font-weight:700;color:#EF4444;margin:4px 0 2px">❌ 오류:</div>`;
      (data.errors || []).forEach(er => {
        html += `<div style="padding:2px 4px;color:#EF4444;font-size:.68rem">${escHtml(er.folder)}: ${escHtml(er.message)}</div>`;
      });
    }

    // ── 실행 후 안내 ──
    if (!isDry && movedCount > 0) {
      html += `<div style="margin-top:6px;padding:5px 8px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:6px;font-size:.69rem;color:#1D4ED8">
        <i class="fas fa-info-circle"></i>
        이동 완료! <b>폴더 URL 동기화</b> 버튼을 눌러 세부목록 URL을 갱신하세요.
      </div>`;
    }

    resEl.innerHTML = html;

    if (!isDry && movedCount > 0) {
      showToast(`✅ 캡처폴더 재편성 완료 — ${movedCount}건 이동, 캠페인폴더 ${createdCount}건 생성`, "success");
    }

  } catch (err) {
    resEl.innerHTML = `<span style="color:#EF4444">❌ 예외: ${escHtml(err.message)}</span>`;
    console.error("[organizeCaptureFolders] 오류:", err);
  } finally {
    if (btnDry) btnDry.disabled = false;
    if (btnRun) btnRun.disabled = false;
  }
}

// ── 구버전 폴더명 → 신규형식 일괄 마이그레이션 ────────────────
async function migrateFolderNames(dryRun) {

  const resultEl = document.getElementById("migrateResult");

  // 실제 변환은 확인 팝업
  if (!dryRun) {
    const ok = confirm(
      "⚠️ 구버전 폴더명 실제 변환\n\n" +
      "Drive 폴더명이 {탭명} → {탭명}_{캠페인명} 형식으로 변경됩니다.\n" +
      "파일이 신규 폴더에 이미 존재하면 파일이동 후 구버전 폴더는 휴지통으로 이동합니다.\n\n" +
      "폴더 ID는 그대로이므로 기존 북마크/링크는 계속 동작합니다.\n\n계속하시겠습니까?"
    );
    if (!ok) return;
  }

  const dryBtn = document.getElementById("btnMigrateDry");
  const runBtn = document.getElementById("btnMigrateRun");
  if (dryBtn) dryBtn.disabled = true;
  if (runBtn) runBtn.disabled = true;
  if (dryBtn) dryBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> ' + (dryRun ? "분석 중..." : "변환 중...");

  if (resultEl) { resultEl.style.display = "none"; resultEl.innerHTML = ""; }

  try {
    // 미리보기: JSONP GET (빠름) / 실제 변환: fetch POST 강제 (Drive 작업이 길어도 안전)
    const data = dryRun
      ? await gasPost({ action: "migrateFolderNames", target: "both", dryRun: "true"  }, 60000)
      : await gasPost({ action: "migrateFolderNames", target: "both", dryRun: "false" }, 300000, { forcePost: true });

    if (data && data.ok) {
      const s = data.summary || {};
      const renamed = data.renamed || [];
      const skipped = data.skipped || [];
      const errors  = data.errors  || [];

      // 변환 예정/완료 목록 테이블 생성
      let rows = "";
      renamed.forEach(r => {
        const badge = r.action === "이름변경"
          ? `<span style="color:#0ca678;background:#D1FAE5;padding:1px 5px;border-radius:3px;font-size:.65rem">${r.action}</span>`
          : `<span style="color:#D97706;background:#FEF3C7;padding:1px 5px;border-radius:3px;font-size:.65rem">${r.action}</span>`;
        rows += `<tr style="border-bottom:1px solid #F3F4F6">
          <td style="padding:3px 5px">${escHtml(r.type)}</td>
          <td style="padding:3px 5px;color:#6B7280">${escHtml(r.old)}</td>
          <td style="padding:3px 5px">→</td>
          <td style="padding:3px 5px;color:#1D4ED8;font-weight:600">${escHtml(r.newName)}</td>
          <td style="padding:3px 5px">${badge}</td>
        </tr>`;
      });

      // 오류 행
      errors.forEach(e => {
        rows += `<tr style="background:#FEF2F2;border-bottom:1px solid #FECACA">
          <td style="padding:3px 5px;color:#EF4444">${escHtml(e.type)}</td>
          <td colspan="3" style="padding:3px 5px;color:#EF4444">${escHtml(e.tab)}: ${escHtml(e.message)}</td>
          <td></td>
        </tr>`;
      });

      const headerColor = dryRun ? "#FFFBEB" : "#F0FDF4";
      const headerBorder = dryRun ? "#FDE68A" : "#BBF7D0";
      const titleIcon = dryRun ? "🔍" : "✅";

      let html = `<div style="padding:6px 8px;background:${headerColor};border:1px solid ${headerBorder};border-radius:6px;line-height:1.6">`;
      html += `<b>${titleIcon} ${dryRun ? "[미리보기]" : "[완료]"} 폴더명 변환</b> (${data.elapsed}초)<br>`;
      html += `캡처폴더 <b>${s.capture ? s.capture.renamed : 0}</b>건, 리뷰폴더 <b>${s.review ? s.review.renamed : 0}</b>건 변환 / 스킵 <b>${s.skipped || 0}</b>건`;
      if (s.errors) html += ` / <span style="color:#EF4444">오류 ${s.errors}건</span>`;
      html += `</div>`;

      if (rows) {
        html += `<div style="margin-top:4px;overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:.69rem">
            <thead><tr style="background:#F9FAFB;font-weight:700">
              <th style="padding:3px 5px;text-align:left">구분</th>
              <th style="padding:3px 5px;text-align:left">기존 경로</th>
              <th></th>
              <th style="padding:3px 5px;text-align:left">신규 폴더명</th>
              <th style="padding:3px 5px;text-align:left">처리</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      } else {
        html += `<div style="color:#6B7280;font-size:.71rem;margin-top:3px">변환 대상 폴더 없음 (이미 모두 신규형식)</div>`;
      }

      if (resultEl) { resultEl.style.display = "block"; resultEl.innerHTML = html; }
      showToast((dryRun ? "🔍 미리보기 완료" : "✅ 변환 완료") + " — " + renamed.length + "건", dryRun ? "" : "success");

    } else {
      const errMsg = data?.error || "알 수 없는 오류";
      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerHTML = `<div style="padding:6px 8px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;color:#EF4444">❌ 실패: ${escHtml(errMsg)}</div>`;
      }
      showToast("❌ 실패: " + errMsg, "error");
    }
  } catch (err) {
    const errMsg = err.message || "";
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.innerHTML = `<div style="padding:6px 8px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;color:#EF4444">❌ 오류: ${escHtml(errMsg)}</div>`;
    }
    showToast("❌ 오류: " + errMsg, "error");
    console.error("[migrateFolderNames] 오류:", err);
  } finally {
    if (dryBtn) { dryBtn.disabled = false; dryBtn.innerHTML = '<i class="fas fa-search"></i> 미리보기'; }
    if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '<i class="fas fa-play"></i> 실제 변환'; }
  }
}

async function batchCreateFolders(target) {

  const labelMap = { capture: "캡처폴더", review: "리뷰폴더", both: "캡처+리뷰폴더" };
  const label    = labelMap[target] || target;

  const ok = confirm(
    `📂 ${label} 일괄 생성/배치\n\n` +
    `세부목록의 미완료 탭에 대해 드라이브 폴더를 생성하고 세부목록 URL을 업데이트합니다.\n` +
    `이미 폴더가 있는 경우 그대로 유지됩니다.\n\n계속하시겠습니까?`
  );
  if (!ok) return;

  // 버튼 비활성화
  const btns = ["btnBatchCapture", "btnBatchReview", "btnBatchBoth"].map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  const targetBtn = document.getElementById(target === "capture" ? "btnBatchCapture" : target === "review" ? "btnBatchReview" : "btnBatchBoth");
  if (targetBtn) targetBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 생성 중...';

  const resultEl = document.getElementById("batchFolderResult");
  if (resultEl) { resultEl.style.display = "none"; resultEl.innerHTML = ""; }

  try {
    const data = await gasPost({ action: "batchCreateFolders", target }, 120000);

    if (data && data.ok) {
      const c = data.capture || {};
      const r = data.review  || {};
      const errNote = data.errors && data.errors.length
        ? `<div style="color:#EF4444;margin-top:3px">⚠️ 오류 ${data.errors.length}건: ${escHtml(data.errors.slice(0,3).join(" / "))}</div>`
        : "";

      let html = `<div style="padding:6px 8px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:6px;line-height:1.6">`;
      html += `<b>✅ ${label} 일괄 생성/배치 완료</b> (${data.elapsed}초)<br>`;
      if (target === "both" || target === "capture")
        html += `📂 캡처폴더: 신규 <b>${c.created}</b>개 생성 / 기존 <b>${c.exists}</b>개 배치 / 완료·마감 <b>${c.skipped}</b>건 스킵<br>`;
      if (target === "both" || target === "review")
        html += `📁 리뷰폴더: 신규 <b>${r.created}</b>개 생성 / 기존 <b>${r.exists}</b>개 배치 / 완료·마감 <b>${r.skipped}</b>건 스킵`;
      html += errNote + `</div>`;

      if (resultEl) { resultEl.style.display = "block"; resultEl.innerHTML = html; }
      showToast("✅ " + label + " 일괄 생성/배치 완료 (" + data.elapsed + "초)", "success");
      try { await loadAdminDashboard(); } catch(_) {}
    } else {
      const errMsg = data?.error || "알 수 없는 오류";
      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerHTML = `<div style="padding:6px 8px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;color:#EF4444">❌ 실패: ${escHtml(errMsg)}</div>`;
      }
      showToast("❌ 생성/배치 실패: " + errMsg, "error");
    }
  } catch (err) {
    const errMsg = err.message || "";
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.innerHTML = `<div style="padding:6px 8px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;color:#EF4444">❌ 오류: ${escHtml(errMsg)}</div>`;
    }
    showToast("❌ 오류: " + errMsg, "error");
    console.error("[batchCreateFolders] 오류:", err);
  } finally {
    btns.forEach(b => { b.disabled = false; });
    const iconMap = { capture: '<i class="fas fa-camera"></i> 캡처폴더', review: '<i class="fas fa-folder-open"></i> 리뷰폴더', both: '<i class="fas fa-layer-group"></i> 전체' };
    btns.forEach(b => {
      const t = b.id === "btnBatchCapture" ? "capture" : b.id === "btnBatchReview" ? "review" : "both";
      if (iconMap[t]) b.innerHTML = iconMap[t];
    });
  }
}

// ── 구매캡쳐/리뷰저장 폴더 일괄 동기화 ────────────────────────
async function syncAllFolders() {

  const forceChk = document.getElementById("chkForceSync");
  const force    = forceChk && forceChk.checked;

  // 강제 재설정이면 한 번 더 확인
  if (force) {
    const ok = confirm("⚠️ 강제 재설정 모드\n\n기존에 저장된 폴더 URL을 모두 지우고 드라이브에서 다시 탐색합니다.\n\n계속하시겠습니까?");
    if (!ok) return;
  }

  const btn = document.getElementById("btnSyncAllFolders");
  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> ' + (force ? "재설정 중..." : "동기화 중...");

  try {
    const data = await gasGet({ action: "syncAllFolders", force: force ? "true" : "false" }, 120000);
    if (data.error) {
      showToast("❌ 폴더 동기화 실패: " + data.error, "error");
    } else {
      const lines = [];
      if (data.capture) lines.push(`📂 캡쳐폴더 ${data.capture.updated}건 업데이트, ${data.capture.skipped}건 유지`);
      if (data.review)  lines.push(`📁 리뷰폴더 ${data.review.updated}건 업데이트, ${data.review.skipped}건 유지${data.review.notFound > 0 ? `, ${data.review.notFound}건 미매칭` : ""}`);
      const modeLabel = force ? "[강제재설정] " : "";
      showToast("✅ " + modeLabel + "동기화 완료 (" + data.elapsed + "초)\n" + lines.join(" / "), "success");
      if (forceChk) forceChk.checked = false; // 완료 후 체크박스 해제
      try { await loadAdminDashboard(); } catch(_) {}
    }
  } catch (err) {
    showToast("❌ 폴더 동기화 오류: " + (err.message || ""), "error");
  } finally {
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-folder-sync"></i> 구매캡쳐/리뷰저장 폴더 일괄동기화';
  }
}

// ── 탭 단위 폴더 재설정 ────────────────────────────────────────
// target: "capture" | "review" | "both"
async function resetTabFolder(target) {
  if (!_tcCurrent) { showToast("탭 정보를 확인할 수 없습니다.", "error"); return; }

  const targetLabel = { capture: "캡처폴더", review: "리뷰폴더", both: "캡처+리뷰폴더" }[target] || target;
  const ok = confirm(`⚠️ ${_tcCurrent.tabName || "이 탭"}\n\n${targetLabel}의 URL을 초기화하고 드라이브에서 다시 탐색합니다.\n드라이브에 폴더가 없으면 빈값으로 유지됩니다.\n\n계속하시겠습니까?`);
  if (!ok) return;

  // 버튼 피드백 (세 버튼 모두 비활성화)
  const resetBtns = document.querySelectorAll("#tcPopover button[onclick^=\"resetTabFolder\"]");
  resetBtns.forEach(b => { b.disabled = true; });
  const targetBtn = document.querySelector(`#tcPopover button[onclick="resetTabFolder('${target}')"]`);
  if (targetBtn) targetBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 탐색 중...';

  try {
    const data = await gasPost({
      action:   "resetTabFolderUrls",
      sheetId:  _tcCurrent.sheetId || "",
      tabName:  _tcCurrent.tabName || "",
      target:   target
    });

    if (data && data.ok) {
      // ★ 결과값으로 입력란 즉시 업데이트
      if ((target === "both" || target === "capture") && data.captureUrl && data.captureUrl !== "(미발견)") {
        document.getElementById("tcCaptureFolderUrlInput").value = data.captureUrl;
        _tcCurrent.captureFolderUrl = data.captureUrl;
      }
      if ((target === "both" || target === "review") && data.folderUrl && data.folderUrl !== "(미발견)") {
        document.getElementById("tcFolderUrlInput").value = data.folderUrl;
        _tcCurrent.folderUrl = data.folderUrl;
      }

      const captureMsg = (target === "both" || target === "capture")
        ? `\n📂 캡처: ${data.captureUrl}` : "";
      const reviewMsg  = (target === "both" || target === "review")
        ? `\n📁 리뷰: ${data.folderUrl}`  : "";
      showToast("✅ " + targetLabel + " 재설정 완료" + captureMsg + reviewMsg, "success");

      // 대시보드 탭 데이터도 즉시 반영
      _patchTabAndRerender(_tcCurrent.sheetId, _tcCurrent.tabName, {
        folderUrl:        (target === "both" || target === "review")  ? (data.folderUrl  !== "(미발견)" ? data.folderUrl  : _tcCurrent.folderUrl)        : _tcCurrent.folderUrl,
        captureFolderUrl: (target === "both" || target === "capture") ? (data.captureUrl !== "(미발견)" ? data.captureUrl : _tcCurrent.captureFolderUrl) : _tcCurrent.captureFolderUrl
      });
    } else {
      showToast("❌ 재설정 실패: " + (data?.error || "서버 오류"), "error");
    }
  } catch (err) {
    showToast("❌ 재설정 오류: " + (err.message || ""), "error");
    console.error("[resetTabFolder] 오류:", err);
  } finally {
    resetBtns.forEach(b => { b.disabled = false; });
    // 버튼 텍스트 원복
    const labels = { capture: '<i class="fas fa-camera"></i> 캡처폴더 재설정', review: '<i class="fas fa-folder-open"></i> 리뷰폴더 재설정', both: '<i class="fas fa-sync-alt"></i> 전체 재설정' }; // 라벨 유지
    resetBtns.forEach(b => {
      const t = b.getAttribute("onclick")?.match(/resetTabFolder\('(.+?)'\)/)?.[1];
      if (t && labels[t]) b.innerHTML = labels[t];
    });
  }
}

// ★ v9.12: 스마트 동기화 (증분 우선)
// dirty 탭 있으면 해당 캠페인만 빠르게 갱신, 없으면 전체 갱신
async function buildIndexSmart(forceFullRebuild) {
  const btnSmart = document.getElementById("btnBuildIndexSmart");
  const btnFull  = document.getElementById("btnBuildIndex"); // may not exist (removed)
  const badge    = document.getElementById("indexStatusBadge");

  if (btnSmart) btnSmart.disabled = true;
  if (btnFull) btnFull.disabled = true;
  if (btnSmart) btnSmart.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 갱신 중...';
  badge.className    = "index-badge index-badge-unknown";
  badge.textContent  = "갱신 중...";

  const elapsedRow = document.getElementById("indexElapsedRow");
  const resultRow  = document.getElementById("indexResultRow");
  const elapsedEl  = document.getElementById("indexElapsed");
  const resultEl   = document.getElementById("indexResult");
  if (elapsedRow) elapsedRow.style.display = "none";
  if (resultRow)  resultRow.style.display  = "none";
  const hintEl = document.getElementById("smartModeHint");
  const hintTextEl = document.getElementById("smartModeHintText");
  if (hintEl) hintEl.style.display = "none";

  const _buildStart = Date.now();

  // ★ 진행 표시 (증분은 짧게)
  const progressWrap = document.getElementById("buildProgressWrap");
  const progressBar  = document.getElementById("buildProgressBar");
  const progressLabel = document.getElementById("buildProgressLabel");
  const progressTime  = document.getElementById("buildProgressTime");
  const progressPct   = document.getElementById("buildProgressPct");
  if (progressWrap) { progressWrap.style.display = ""; progressWrap.classList.remove("hidden"); }
  if (progressBar)  { progressBar.style.width = "5%"; progressBar.style.background = "linear-gradient(90deg,#0ea5e9,#2563eb)"; }
  if (progressLabel) progressLabel.textContent = "스마트 갱신 중...";

  let _progressTimerSmart = null;
  const _startSmartProgress = () => {
    let sec = 0;
    _progressTimerSmart = setInterval(() => {
      sec++;
      const pct = Math.min(90, Math.round((1 - Math.exp(-sec / 15)) * 100));
      if (progressBar)  progressBar.style.width = pct + "%";
      if (progressTime) progressTime.textContent = sec + "초 경과";
      if (progressPct)  progressPct.textContent  = pct + "%";
    }, 1000);
  };
  const _stopSmartProgress = () => {
    if (_progressTimerSmart) clearInterval(_progressTimerSmart);
    if (progressBar)  { progressBar.style.width = "100%"; progressBar.style.background = "linear-gradient(90deg,#12b886,#0ca678)"; }
    if (progressPct)  progressPct.textContent = "100%";
    setTimeout(() => { if (progressWrap) { progressWrap.style.display = "none"; progressWrap.classList.add("hidden"); } }, 1800);
  };
  let _smartPollingMode = false; // ★ v9.19: polling 모드 플래그 (finally 버튼 복원 차단)
  _startSmartProgress();

  try {
    // ★ v9.13: 병렬 fetchAll 적용으로 속도 개선 → 타임아웃 60초로 증가
    // (dirty 캠페인 수 × ~10s 순차 → 병렬 ~10s + 파싱 ~5s ≈ 15~25s)
    // ★ v9.19: 60초→90초 (dirty 캠페인이 많을 때 여유 확보)
    const data = await gasGet({ action: "buildIndexSmart", forceFullRebuild: !!forceFullRebuild }, 90 * 1000);

    if (data.locked) {
      // ★ v9.17: 잠금 감지 시 스마트 처리 (좀비 기준 3분으로 단축)
      // elapsedSec 숫자 필드 우선, 없으면 에러 문자열에서 파싱
      const lockElapsed = typeof data.elapsedSec === "number"
        ? data.elapsedSec
        : (() => { const m = (data.error || "").match(/(\d+)초 전 시작/); return m ? parseInt(m[1], 10) : null; })();

      // ★ v9.20: ZOMBIE_SEC = TTL(7분=420초)
      // GAS BUILD_LOCK_TTL_MS = 7분 → 7분 지나면 acquireBuildLock이 자동 만료 처리
      // 3분 기준은 TTL(8분) 내라 handleReleaseBuildLock이 "진행 중" 거부했음
      const ZOMBIE_SEC = 420; // 7분 (= BUILD_LOCK_TTL_MS)

      if (lockElapsed !== null && lockElapsed >= ZOMBIE_SEC) {
        // ① 좀비 잠금 (7분 이상, TTL 만료) → 자동 해제 후 재시도
        _stopSmartProgress();
        badge.textContent = "잠금 해제 중...";
        showToast(`🔓 이전 갱신이 ${lockElapsed}초 전에 멈췄습니다. 자동으로 잠금 해제 후 재시도합니다.`, "info");
        try { await gasGet({ action: "releaseBuildLock" }, 10000); } catch(_) {}
        await new Promise(r => setTimeout(r, 1000));
        btnSmart.disabled = false;
        btnSmart.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>';
        if (btnFull) btnFull.disabled = false;
        setTimeout(() => buildIndexSmart(), 300);
        return;
      } else {
        // ② 진행 중 잠금 (3분 미만) → buildIndex polling 흐름으로 전환
        // GAS가 실제로 실행 중이면 완료 시 builtAt이 바뀌어 감지됨
        // GAS가 죽었으면 잠금이 풀리고 자동 재시도
        _stopSmartProgress();
        showToast(
          lockElapsed !== null
            ? `⏳ 이전 갱신이 진행 중입니다 (${lockElapsed}초 경과). 완료를 자동 감지합니다.`
            : `⏳ 다른 갱신이 진행 중입니다. 완료를 자동 감지합니다.`,
          "info"
        );
        badge.textContent = "완료 대기 중...";
        _smartPollingMode = true;
        // 2초 후 스마트 갱신 재시도
        setTimeout(() => buildIndexSmart(), 2000);
        return;
      }
    }
    if (!data.success && !data.ok) {
      throw new Error(data.error || "알 수 없는 오류");
    }

    // ★ [Node.js 이관] 비동기 빌드 응답 → polling 모드로 전환
    // 서버가 빌드를 백그라운드에서 처리하고 즉시 응답하므로,
    // 프론트엔드는 /api/index/status를 폴링하여 완료를 감지
    if (data.mode === "async") {
      // ★ 프로그레스바를 "진행 중"으로 유지 (100%로 점프하지 않음)
      // _stopSmartProgress() 호출하지 않음 — 타이머는 중지하되 바는 유지
      if (_progressTimerSmart) clearInterval(_progressTimerSmart);
      if (progressBar) { progressBar.style.width = "15%"; progressBar.style.background = "linear-gradient(90deg,#0ea5e9,#3182f6)"; }
      if (progressLabel) progressLabel.textContent = "백그라운드 갱신 중...";
      if (progressPct)  progressPct.textContent = "15%";

      if (hintEl && hintTextEl) {
        hintTextEl.textContent = "🔄 서버에서 갱신 중... 완료 시 자동 업데이트됩니다.";
        hintEl.style.display = "";
        hintEl.style.color = "#2563eb";
      }
      showToast("🔄 갱신이 시작되었습니다. 완료 시 자동으로 업데이트됩니다.", "info");
      badge.textContent = "갱신중(백그라운드)";
      badge.className = "index-badge index-badge-unknown";

      // builtAt 스냅샷 가져오기
      let prevBA = null;
      try { const s = await gasGet({ action: "indexStatus" }, 5000); prevBA = s.meta ? s.meta.builtAt : (s.builtAt || null); } catch(_) {}

      // polling 시작 (5초마다, 최대 10분) — 프로그레스바 실시간 업데이트
      let pCount = 0;
      const maxP = 120; // 10분
      const EXPECTED_SEC = 60; // 예상 소요 시간 (초)
      const pTimer = setInterval(async () => {
        pCount++;
        const elapsedSec = pCount * 5;
        // 프로그레스바 — 지수 함수로 서서히 증가 (최대 90%)
        const asyncPct = Math.min(90, Math.round(15 + 75 * (1 - Math.exp(-elapsedSec / EXPECTED_SEC))));
        if (progressBar)  progressBar.style.width = asyncPct + "%";
        if (progressPct)  progressPct.textContent = asyncPct + "%";
        if (progressTime) progressTime.textContent = elapsedSec + "초 경과";
        if (progressLabel) progressLabel.textContent = "백그라운드 갱신 중...";

        try {
          const s2 = await gasGet({ action: "indexStatus" }, 8000);
          const newBA = s2.meta ? s2.meta.builtAt : (s2.builtAt || null);
          const cnt = s2.meta ? s2.meta.count : (s2.count || 0);

          // builtAt이 변경되면 빌드 완료
          if (newBA && newBA !== prevBA) {
            clearInterval(pTimer);
            // ★ 완료 시에만 100%로 점프 + 초록색
            if (progressBar)  { progressBar.style.width = "100%"; progressBar.style.background = "linear-gradient(90deg,#12b886,#0ca678)"; }
            if (progressPct)  progressPct.textContent = "100%";
            if (progressLabel) progressLabel.textContent = "갱신 완료 ✓";
            setTimeout(() => { if (progressWrap) { progressWrap.style.display = "none"; progressWrap.classList.add("hidden"); } }, 2500);

            showToast(`✅ 갱신 완료 (${cnt.toLocaleString()}건, ${elapsedSec}초)`, "success");
            badge.className = "index-badge index-badge-ok";
            badge.textContent = "정상";
            await loadIndexStatus();
            if (elapsedRow && elapsedEl) { elapsedEl.textContent = elapsedSec + "초 (비동기)"; elapsedRow.style.display = ""; }
            if (resultRow && resultEl) { resultEl.innerHTML = `<span style="color:#12b886;font-weight:700">✅ 갱신 완료</span>`; resultRow.style.display = ""; }
            // 버튼 복원
            btnSmart.disabled = false;
            btnSmart.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>';
            if (btnFull) btnFull.disabled = false;
            _autoRefreshDashboardAfterBuild();
            _updateSmartDirtyBadge();
            return;
          }
          // 진행 중 메시지 업데이트
          if (hintEl && hintTextEl) {
            hintTextEl.textContent = `🔄 서버에서 갱신 중... (${elapsedSec}초 경과)`;
          }
        } catch(_) {}
        if (pCount >= maxP) {
          clearInterval(pTimer);
          _stopSmartProgress();
          showToast("⏱ 갱신 대기 시간 초과 — 잠시 후 다시 확인하세요.", "warning");
          badge.className = "index-badge index-badge-expired"; badge.textContent = "확인 필요";
          btnSmart.disabled = false;
          btnSmart.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>';
          if (btnFull) btnFull.disabled = false;
        }
      }, 5000);
      _smartPollingMode = true; // polling 모드이므로 finally에서 버튼 복원 안 함
      return;
    }

    // ★ 전체 갱신 필요 신호 → forceFullRebuild=true로 스마트갱신 재호출
    if (data.needFullRebuild) {
      _stopSmartProgress();
      const reason = data.reason || "전체 갱신 필요";
      if (hintEl && hintTextEl) {
        hintTextEl.textContent = `🔄 전체 갱신 중... (${reason})`;
        hintEl.style.display = "";
        hintEl.style.color = "#6b7280";
      }
      showToast(`🔄 ${reason} — 전체 갱신을 시작합니다.`, "info");
      _smartPollingMode = true;
      // forceFullRebuild 플래그로 스마트갱신 재호출
      setTimeout(() => buildIndexSmart(true), 300);
      return;
    }

    // ★ skip 모드: 인덱스 최신 상태
    if (data.mode === "skip") {
      _stopSmartProgress();
      const elapsedSec = Math.round((Date.now() - _buildStart) / 1000);
      if (hintEl && hintTextEl) {
        hintTextEl.textContent = `✅ 인덱스가 최신 상태입니다 (변경된 탭 없음, ${elapsedSec}초)`;
        hintEl.style.display = "";
        hintEl.style.color = "#0ca678";
      }
      showToast(`✅ 인덱스 최신 상태 — 변경된 탭이 없어 갱신을 건너뜁니다. (${(data.count||0).toLocaleString()}건)`, "success");
      badge.className = "index-badge index-badge-ok"; badge.textContent = "최신";
      await loadIndexStatus();
      if (elapsedRow && elapsedEl) { elapsedEl.textContent = elapsedSec + "초 (스킵)"; elapsedRow.style.display = ""; }
      if (resultRow && resultEl) { resultEl.innerHTML = `<span style="color:#0ca678;font-weight:700">✅ 최신 상태 (갱신 불필요)</span>`; resultRow.style.display = ""; }
      return;
    }

    _stopSmartProgress();
    const elapsedSec = Math.round((Date.now() - _buildStart) / 1000);

    // 모드별 안내
    const isIncremental = data.mode === "incremental";
    const modeLabel = isIncremental
      ? `⚡ 증분 갱신 (${data.updatedCampaigns || 0}개 캠페인 / ${elapsedSec}초)`
      : `🔄 전체 갱신 (이유: ${data.reason || "주기 도래"} / ${elapsedSec}초)`;

    if (hintEl && hintTextEl) {
      hintTextEl.textContent = modeLabel;
      hintEl.style.display = "";
      hintEl.style.color = isIncremental ? "#2563eb" : "#6b7280";
    }

    const warnInfo = data.warning ? ` ⚠ 일부 경고` : "";
    const skipInfo = data.skipped > 0
      ? ` · 완료탭 ${data.skipped}개 스킵(${(data.reused||0).toLocaleString()}행 재사용)` : "";

    if (isIncremental) {
      showToast(
        `⚡ 증분 갱신 완료 (${data.updatedCampaigns||0}개 캠페인 / 전체 ${(data.count||0).toLocaleString()}건 / ${elapsedSec}초)${warnInfo}`,
        data.warning ? "warning" : "success"
      );
    } else {
      showToast(
        `✅ 전체 갱신 완료 (${(data.count||0).toLocaleString()}건${skipInfo} / ${elapsedSec}초)${warnInfo}`,
        data.warning ? "warning" : "success"
      );
    }

    await loadIndexStatus();
    const countEl = document.getElementById("indexCount");
    if (countEl) countEl.textContent = (data.count||0).toLocaleString() + "건";
    if (elapsedRow && elapsedEl) { elapsedEl.textContent = elapsedSec + "초 (" + (isIncremental ? "증분" : "전체") + ")"; elapsedRow.style.display = ""; }
    if (resultRow && resultEl) {
      resultEl.innerHTML = isIncremental
        ? `<span style="color:#2563EB;font-weight:700">⚡ 증분 갱신 완료 (${data.updatedCampaigns||0}개 캠페인)</span>`
        : `<span style="color:#12b886;font-weight:700">✅ 전체 갱신 완료</span>`;
      resultRow.style.display = "";
    }
    // ★ v10.0: dirty 배지 — 단순 숨김 대신 실제 최신 dirtyCount 반영
    _updateSmartDirtyBadge();

    _autoRefreshDashboardAfterBuild();

  } catch (err) {
    _stopSmartProgress();
    const msg = err.message || "";
    if (resultRow && resultEl) { resultEl.innerHTML = `<span style="color:#DC2626;font-weight:700">❌ 갱신 실패</span>`; resultRow.style.display = ""; }
    if (msg === "요청 시간 초과") {
      // 타임아웃 = 증분이 예상보다 오래 걸림(60초 초과) → polling 전환
      // ★ v9.13: 병렬 fetchAll 적용 후에도 타임아웃 시 백그라운드 polling 유지
      showToast("⏱ 스마트빌드 갱신 진행 중 (백그라운드)... 완료 시 자동 감지합니다.", "info");
      badge.textContent = "갱신중(백그라운드)";
      // prevBuiltAt 스냅샷 필요
      let prevBA = null;
      try { const s = await gasGet({ action: "indexStatus" }, 5000); prevBA = s.builtAt || null; } catch(_) {}
      // polling 시작 (buildIndex의 _startPolling 대신 간단한 polling)
      let pCount = 0;
      const maxP = 120; // 10분
      let pAutoRetried = false; // ★ v9.19: 자동 재시도 플래그
      const pTimer = setInterval(async () => {
        pCount++;
        try {
          const s2 = await gasGet({ action: "indexStatus" }, 8000);
          const newBA   = s2.builtAt || null;
          const isLocked2 = s2.buildLock ? s2.buildLock.locked : false;
          const lockElapsed2 = (s2.buildLock && typeof s2.buildLock.elapsedSec === "number")
            ? s2.buildLock.elapsedSec : null;

          // ① builtAt 변경 → 완료
          if (newBA && newBA !== prevBA) {
            clearInterval(pTimer);
            showToast(`✅ 갱신 완료 (${(s2.count||0).toLocaleString()}건)`, "success");
            await loadIndexStatus();
            _autoRefreshDashboardAfterBuild();
            const btnSmF = document.getElementById("btnBuildIndexSmart");
            if (btnSmF) { btnSmF.disabled = false; btnSmF.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>'; }
            const btnFuF = document.getElementById("btnBuildIndex");
            if (btnFuF) btnFuF.disabled = false;
            // ★ v10.0: 버튼 복원 후 dirty 배지 즉시 재갱신
            _updateSmartDirtyBadge();
            return;
          }
          // ② 좀비 잠금 감지 (3분 이상) — ★ v9.19 추가
          // ★ v9.20: 420초(TTL) 이상이면 TTL 만료 좀비 잠금
          if (isLocked2 && lockElapsed2 !== null && lockElapsed2 >= 420 && !pAutoRetried) {
            clearInterval(pTimer);
            pAutoRetried = true;
            showToast(`🔓 잠금 ${lockElapsed2}초 경과(TTL 만료) — 자동 해제 후 스마트빌드 갱신 재시도`, "info");
            try { await gasGet({ action: "releaseBuildLock" }, 8000); } catch(_) {}
            await new Promise(r => setTimeout(r, 800));
            const btnSmR = document.getElementById("btnBuildIndexSmart");
            if (btnSmR) { btnSmR.disabled = false; btnSmR.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>'; }
            const btnFuR = document.getElementById("btnBuildIndex");
            if (btnFuR) btnFuR.disabled = false;
            setTimeout(() => buildIndexSmart(), 300);
            return;
          }
          // ③ 잠금 없고 builtAt 미변경 + 40초 경과 → 조기 완료 감지 시도
          if (!isLocked2 && pCount >= 8 && !pAutoRetried) {
            clearInterval(pTimer);
            pAutoRetried = true;
            showToast("🔄 스마트빌드 갱신 재시도 중...", "info");
            const btnSmR2 = document.getElementById("btnBuildIndexSmart");
            if (btnSmR2) { btnSmR2.disabled = false; btnSmR2.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>'; }
            const btnFuR2 = document.getElementById("btnBuildIndex");
            if (btnFuR2) btnFuR2.disabled = false;
            try { await gasGet({ action: "releaseBuildLock" }, 5000); } catch(_) {}
            setTimeout(() => buildIndexSmart(), 500);
            return;
          }
        } catch(_) {}
        if (pCount >= maxP) {
          clearInterval(pTimer);
          showToast("⏱ 대기 시간 초과 — 잠금 강제 해제 후 재시도하세요.", "warning");
          const btnSmE = document.getElementById("btnBuildIndexSmart");
          if (btnSmE) { btnSmE.disabled = false; btnSmE.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>'; }
          const btnFuE = document.getElementById("btnBuildIndex");
          if (btnFuE) btnFuE.disabled = false;
        }
      }, 5000);
      _smartPollingMode = true; // ★ v9.19: polling 진입 — finally 버튼 복원 차단
      return; // finally 버튼 복원 하지 않음 (polling이 담당)
    } else {
      showToast("❌ 스마트 갱신 실패: " + msg.substring(0, 120), "error");
    }
    badge.className = "index-badge index-badge-error"; badge.textContent = "오류";
  } finally {
    // ★ v9.19: polling 모드이면 버튼 복원 안 함 (polling이 완료 후 복원)
    if (!_smartPollingMode) {
      if (btnSmart) { btnSmart.disabled = false; btnSmart.innerHTML = '<i class="fas fa-bolt"></i> 스마트빌드 갱신 <span id="smartDirtyBadge" style="display:none;background:rgba(255,255,255,0.25);padding:1px 6px;border-radius:10px;font-size:.7rem;margin-left:3px"></span>'; }
      if (btnFull) btnFull.disabled = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// ★ 자동 빌드 카운트다운 + 빌드 진행 중 배너
// ═══════════════════════════════════════════════════════════
let _cronCountdownTimer = null;

function _startCronCountdown(cron, buildLock) {
  // 기존 타이머 정리
  if (_cronCountdownTimer) { clearInterval(_cronCountdownTimer); _cronCountdownTimer = null; }

  const badge = document.getElementById("cronCountdownBadge");
  const banner = document.getElementById("buildInProgressBanner");
  const bannerElapsed = document.getElementById("buildInProgressElapsed");
  if (!badge || !banner) return;

  // ── 빌드 진행 중 배너 ──
  if (buildLock && buildLock.locked) {
    banner.style.display = "";
    const elapsed = buildLock.elapsedSec || 0;
    bannerElapsed.textContent = `(${elapsed}초 경과)`;
    badge.style.display = "none";

    // 1초마다 경과 시간 업데이트
    let sec = elapsed;
    _cronCountdownTimer = setInterval(() => {
      sec++;
      bannerElapsed.textContent = `(${sec}초 경과)`;
      // 7분(420초) 초과 시 자동 해제 가능성 표시
      if (sec > 420) {
        banner.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 빌드 응답 대기 중... <span id="buildInProgressElapsed">(' + sec + '초)</span>';
      }
    }, 1000);
    return;
  }
  banner.style.display = "none";

  // ── CRON 카운트다운 ──
  if (!cron) { badge.style.display = "none"; return; }

  const autoSec = cron.auto?.nextRunInSec;
  const fullSec = cron.full?.nextRunInSec;

  if (!autoSec && !fullSec) {
    // 영업시간 외 (일요일 또는 19시 이후)
    badge.style.display = "";
    badge.className = "cron-countdown-badge cron-off";
    badge.innerHTML = '<i class="fas fa-moon"></i> 자동동기화 대기 (영업시간 외)';
    if (fullSec) {
      // 전체 갱신만 있는 경우
      let remain = fullSec;
      _updateCountdownText(badge, 'full', remain);
      _cronCountdownTimer = setInterval(() => {
        remain--;
        if (remain <= 0) {
          clearInterval(_cronCountdownTimer);
          _cronCountdownTimer = null;
          badge.className = "cron-countdown-badge cron-full";
          badge.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> 전체 갱신 시작...';
          // 3초 후 대시보드 새로고침
          setTimeout(() => loadAdminDashboard(), 3000);
          return;
        }
        _updateCountdownText(badge, 'full', remain);
      }, 1000);
    }
    return;
  }

  // 가장 빠른 빌드까지 카운트다운
  const isFullFirst = fullSec && (!autoSec || fullSec <= autoSec);
  let remain = isFullFirst ? fullSec : autoSec;
  const type = isFullFirst ? 'full' : 'auto';

  badge.style.display = "";
  _updateCountdownText(badge, type, remain);

  _cronCountdownTimer = setInterval(() => {
    remain--;
    if (remain <= 0) {
      clearInterval(_cronCountdownTimer);
      _cronCountdownTimer = null;
      const label = type === 'full' ? '전체 갱신' : '자동 동기화';
      badge.className = "cron-countdown-badge " + (type === 'full' ? 'cron-full' : 'cron-auto');
      badge.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> ${label} 시작...`;
      // 빌드 시작 후 5초 대기 → 대시보드 새로고침 (빌드 중 배너 표시)
      setTimeout(() => loadAdminDashboard(), 5000);
      return;
    }
    _updateCountdownText(badge, type, remain);
  }, 1000);
}

function _updateCountdownText(badge, type, remainSec) {
  const h = Math.floor(remainSec / 3600);
  const m = Math.floor((remainSec % 3600) / 60);
  const s = remainSec % 60;

  let timeStr;
  if (h > 0) {
    timeStr = `${h}시간 ${String(m).padStart(2, '0')}분`;
  } else if (m > 0) {
    timeStr = `${m}분 ${String(s).padStart(2, '0')}초`;
  } else {
    timeStr = `${s}초`;
  }

  if (type === 'full') {
    badge.className = "cron-countdown-badge cron-full";
    badge.innerHTML = `<i class="fas fa-redo"></i> 전체 갱신 <span class="cron-time">${timeStr}</span>`;
  } else {
    badge.className = "cron-countdown-badge cron-auto";
    badge.innerHTML = `<i class="fas fa-bolt"></i> 자동 동기화 <span class="cron-time">${timeStr}</span>`;
  }

  // 1분 미만일 때 강조
  if (remainSec < 60) {
    badge.style.fontWeight = '800';
    if (remainSec < 10) {
      badge.style.animation = 'buildPulse 1s ease-in-out infinite';
    }
  } else {
    badge.style.fontWeight = '';
    badge.style.animation = '';
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

// ═══════════════════════════════════════════════════════════
// ★ Phase 4: Dirty Tab 변경감지 — 구글시트 변경 시 배지 표시
// ═══════════════════════════════════════════════════════════

let _lastDirtySheets = [];

/** 대시보드 로드 후 비동기로 dirty check 호출 */
async function _asyncDirtyCheck() {
  try {
    const token = sessionStorage.getItem('admin_token');
    if (!token) return;
    const resp = await fetch(API_BASE_URL + '/api/index/dirty', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.ok) {
      _lastDirtySheets = data.dirtySheets || [];
      _renderDirtyBadges(_lastDirtySheets);
    }
  } catch (_) { /* 실패 시 무시 — dirty 배지 없이 기존대로 동작 */ }
}

/** dirty 시트에 해당하는 캠페인 블록에 배지 표시 */
function _renderDirtyBadges(dirtySheets) {
  // 기존 dirty 배지 모두 제거
  document.querySelectorAll('.dirty-badge').forEach(function(el) { el.remove(); });

  if (!dirtySheets || dirtySheets.length === 0) return;

  const dirtyIds = new Set(dirtySheets.map(function(s) { return s.sheetId; }));

  // 캠페인 블록의 갱신 버튼에서 sheetId 매칭
  document.querySelectorAll('.btn-camp-refresh[data-sheetid]').forEach(function(btn) {
    const sid = btn.getAttribute('data-sheetid');
    if (!dirtyIds.has(sid)) return;

    const header = btn.closest('.dash-campaign-header');
    if (!header) return;

    // 이미 dirty 배지가 있으면 스킵
    if (header.querySelector('.dirty-badge')) return;

    const badge = document.createElement('span');
    badge.className = 'dirty-badge';
    badge.title = '구글시트에서 변경 감지됨 — 클릭하여 이 시트만 동기화';
    badge.innerHTML = '<i class="fas fa-bolt"></i> 새 변경';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#FEF3C7;color:#D97706;border:1px solid #FDE68A;border-radius:4px;padding:1px 7px;font-size:.65rem;font-weight:700;cursor:pointer;margin-left:6px;animation:buildPulse 2s ease-in-out infinite';
    badge.onclick = function(e) {
      e.stopPropagation();
      _buildDirtySheet(sid, badge);
    };

    // 캠페인 제목 옆에 삽입
    const titleSpan = header.querySelector('.dash-campaign-name') || header.querySelector('span');
    if (titleSpan) {
      titleSpan.parentNode.insertBefore(badge, titleSpan.nextSibling);
    } else {
      header.appendChild(badge);
    }
  });
}

/** dirty 시트 클릭 → 해당 시트만 빌드 */
async function _buildDirtySheet(sheetId, badgeEl) {
  if (badgeEl) {
    badgeEl.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> 동기화 중...';
    badgeEl.style.background = '#DBEAFE';
    badgeEl.style.color = '#2563EB';
    badgeEl.style.borderColor = '#93C5FD';
    badgeEl.style.animation = 'none';
    badgeEl.onclick = null;
  }

  try {
    const token = sessionStorage.getItem('admin_token');
    const resp = await fetch(API_BASE_URL + '/api/index/build-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ sheetId }),
    });
    const data = await resp.json();
    if (data.ok) {
      if (typeof showToast === 'function') showToast('⚡ 시트 동기화 시작됨 — 완료 시 자동 새로고침', 'success');
      // 빌드 완료 후 SSE index_build 이벤트로 자동 새로고침됨
      // 안전장치: 15초 후에도 SSE가 안 오면 수동 새로고침
      setTimeout(function() {
        if (badgeEl && badgeEl.parentNode) {
          badgeEl.remove();
          loadAdminDashboard();
        }
      }, 15000);
    } else {
      if (typeof showToast === 'function') showToast(data.error || '동기화 실패', 'error');
      if (badgeEl) badgeEl.remove();
    }
  } catch (err) {
    if (typeof showToast === 'function') showToast('동기화 요청 실패: ' + err.message, 'error');
    if (badgeEl) badgeEl.remove();
  }
}

// ═══════════════════════════════════════════════════════════
// ★ Phase 5: 라이브 모드 — 30초마다 대시보드 자동 새로고침
// SSE 실시간 업데이트와 병행하여 데이터 정합성 보장
// ═══════════════════════════════════════════════════════════

let _liveMode = false;
let _liveInterval = null;
const _LIVE_INTERVAL_MS = 30000; // 30초

/** 대시보드 로드 시 라이브 모드 토글 표시 및 이전 상태 복원 */
function _initLiveMode() {
  const wrap = document.getElementById('liveModeToggleWrap');
  const cb   = document.getElementById('liveModeCheckbox');
  if (!wrap || !cb) return;

  wrap.style.display = 'inline-flex';

  // 이전 세션 상태 복원
  const saved = sessionStorage.getItem('live_mode');
  if (saved === 'on') {
    cb.checked = true;
    _startLiveMode();
  }
}

/** 라이브 모드 토글 핸들러 */
function toggleLiveMode(on) {
  if (on) {
    _startLiveMode();
    sessionStorage.setItem('live_mode', 'on');
    if (typeof showToast === 'function') showToast('LIVE 모드 ON — 30초마다 자동 새로고침', 'success');
  } else {
    _stopLiveMode();
    sessionStorage.setItem('live_mode', 'off');
    if (typeof showToast === 'function') showToast('LIVE 모드 OFF', 'info');
  }
}

function _startLiveMode() {
  _liveMode = true;
  _stopLiveMode(); // 기존 인터벌 정리

  const label = document.getElementById('liveModeLabel');
  if (label) label.classList.add('live-active');

  _liveInterval = setInterval(function() {
    // 관리자 화면이 열려 있고 대시보드 탭이 보이는 경우만
    const adminPanel = document.getElementById('adminPanel');
    const dashTab    = document.getElementById('tab-dashboard');
    if (!adminPanel || adminPanel.style.display === 'none') return;
    if (!dashTab || !dashTab.classList.contains('active')) return;

    // 빌드 진행 중이면 스킵
    const banner = document.getElementById('buildInProgressBanner');
    if (banner && banner.style.display !== 'none') return;

    loadAdminDashboard();
  }, _LIVE_INTERVAL_MS);
}

function _stopLiveMode() {
  _liveMode = false;
  if (_liveInterval) {
    clearInterval(_liveInterval);
    _liveInterval = null;
  }
  const label = document.getElementById('liveModeLabel');
  if (label) label.classList.remove('live-active');
}

/** 동기화 모달의 통합 상태 패널 업데이트 */
function _updateSyncStatusPanel() {
  // SSE 연결 상태
  const sseIcon = document.getElementById('syncSSEIcon');
  const sseText = document.getElementById('syncSSEText');
  if (sseIcon && sseText) {
    const connected = typeof _sseSource !== 'undefined' && _sseSource && _sseSource.readyState === 1;
    sseIcon.className = 'sync-status-icon ' + (connected ? 'sync-ok' : 'sync-off');
    sseText.textContent = connected ? 'SSE 연결됨' : 'SSE 미연결';
  }

  // 라이브 모드 상태
  const liveIcon = document.getElementById('syncLiveIcon');
  const liveText = document.getElementById('syncLiveText');
  if (liveIcon && liveText) {
    liveIcon.className = 'sync-status-icon ' + (_liveMode ? 'sync-ok' : 'sync-off');
    liveText.textContent = _liveMode ? 'LIVE ON (30초)' : 'LIVE OFF';
  }

  // Dirty 시트 수
  const dirtyIcon = document.getElementById('syncDirtyIcon');
  const dirtyText = document.getElementById('syncDirtyText');
  if (dirtyIcon && dirtyText) {
    const cnt = (typeof _lastDirtySheets !== 'undefined') ? _lastDirtySheets.length : 0;
    dirtyIcon.className = 'sync-status-icon ' + (cnt > 0 ? 'sync-warn' : 'sync-ok');
    dirtyText.textContent = cnt > 0 ? '변경 ' + cnt + '건 감지' : '변경 없음';
  }

  // 다음 동기화 시각 (카운트다운 배지에서 읽기)
  const nextIcon = document.getElementById('syncNextIcon');
  const nextText = document.getElementById('syncNextText');
  if (nextIcon && nextText) {
    const cronBadge = document.getElementById('cronCountdownBadge');
    if (cronBadge && cronBadge.style.display !== 'none') {
      const timeSpan = cronBadge.querySelector('.cron-time');
      nextText.textContent = '다음 동기화 ' + (timeSpan ? timeSpan.textContent : '-');
      nextIcon.className = 'sync-status-icon sync-ok';
    } else {
      nextText.textContent = '다음 동기화 —';
      nextIcon.className = 'sync-status-icon sync-off';
    }
  }
}

// ═══════════════════════════════════════════════════════════
// ★ Phase 3: SSE 기반 대시보드 부분 갱신
// review_submit / order_submit 이벤트 수신 시 전체 새로고침 없이
// 해당 탭의 숫자만 실시간 업데이트
// ═══════════════════════════════════════════════════════════

/**
 * SSE 이벤트로 대시보드 탭 카운터를 부분 갱신
 * @param {object} data - SSE 이벤트 데이터 { type, sheetId, tabName, ... }
 */
function _sseDashboardPartialUpdate(data) {
  if (!data || !data.sheetId || !data.tabName) return;

  const screenAdmin = document.getElementById("screenAdmin");
  if (!screenAdmin || !screenAdmin.classList.contains("active")) return;

  const tabKey = data.sheetId + "||" + data.tabName;
  const rows = document.querySelectorAll(`.dash-tab-row[data-tabkey="${CSS.escape(tabKey)}"]`);
  if (rows.length === 0) return;

  if (data.type === 'review_submit') {
    // 제출 +1: dash-done 숫자 증가, 진행률 바 갱신
    rows.forEach(function(row) {
      const numsEl = row.querySelector('.dash-tab-nums');
      if (!numsEl) return;
      const doneEl  = numsEl.querySelector('.dash-done');
      const totalEl = numsEl.querySelector('.dash-total');
      if (!doneEl || !totalEl) return;

      const newDone  = parseInt(doneEl.textContent) + 1;
      const total    = parseInt(totalEl.textContent);
      doneEl.textContent = newDone;

      // 진행률 바 업데이트
      const barWrap = row.querySelector('.dash-tab-bar-wrap');
      if (barWrap) {
        const bar = barWrap.querySelector('.dash-tab-bar');
        if (bar && total > 0) {
          const newRate = _pct(newDone, total);
          bar.style.width = newRate + '%';
          bar.className = 'dash-tab-bar ' + (newRate === 100 ? 'bar-full' : newRate >= 50 ? 'bar-half' : 'bar-low');
        }
      }

      // 정렬용 데이터 속성 갱신
      row.dataset.sortNums = newDone;
      if (total > 0) row.dataset.sortBar = _pct(newDone, total);

      // 플래시 효과
      doneEl.style.transition = 'color 0.3s';
      doneEl.style.color = '#16A34A';
      doneEl.style.fontWeight = '800';
      setTimeout(function() { doneEl.style.color = ''; doneEl.style.fontWeight = ''; }, 2000);
    });

    // 전체 합계 업데이트
    _sseUpdateGrandTotals(1, 0);

    // 캠페인 헤더 합계 업데이트
    _sseUpdateCampaignTotal(tabKey, 1, 0);

  } else if (data.type === 'order_submit') {
    // 구매양식 = 새 행 +1: total 증가
    rows.forEach(function(row) {
      const numsEl = row.querySelector('.dash-tab-nums');
      if (!numsEl) return;
      const totalEl = numsEl.querySelector('.dash-total');
      if (!totalEl) return;

      const newTotal = parseInt(totalEl.textContent) + 1;
      totalEl.textContent = newTotal;

      // 플래시 효과
      totalEl.style.transition = 'color 0.3s';
      totalEl.style.color = '#2563EB';
      totalEl.style.fontWeight = '800';
      setTimeout(function() { totalEl.style.color = ''; totalEl.style.fontWeight = ''; }, 2000);
    });

    // 전체 합계: total +1, pending +1
    _sseUpdateGrandTotals(0, 1);
    _sseUpdateCampaignTotal(tabKey, 0, 1);
  }
}

/** 전체 합계 (sumTotal, sumDone, sumPending) 업데이트 */
function _sseUpdateGrandTotals(submitDelta, totalDelta) {
  const elTotal   = document.getElementById("sumTotal");
  const elDone    = document.getElementById("sumDone");
  const elPending = document.getElementById("sumPending");
  const elRate    = document.getElementById("sumRate");
  if (!elTotal || !elDone || !elPending) return;

  const oldTotal = parseInt(elTotal.textContent.replace(/,/g, '')) || 0;
  const oldDone  = parseInt(elDone.textContent.replace(/,/g, ''))  || 0;

  const newTotal = oldTotal + totalDelta;
  const newDone  = oldDone + submitDelta;
  const newPending = Math.max(0, newTotal - newDone);
  const newRate    = _pct(newDone, newTotal);

  elTotal.textContent   = newTotal.toLocaleString();
  elDone.textContent    = newDone.toLocaleString();
  elPending.textContent = newPending.toLocaleString();
  if (elRate) elRate.textContent = newRate + "%";
}

/** 캠페인 헤더의 submitted/total 합계 업데이트 */
function _sseUpdateCampaignTotal(tabKey, submitDelta, totalDelta) {
  const sheetId = tabKey.split("||")[0];
  if (!sheetId) return;

  // 캠페인 블록은 내부 탭의 sheetId로 찾음 — data-sheetid 속성 활용
  const campRefreshBtns = document.querySelectorAll(`.btn-camp-refresh[data-sheetid="${CSS.escape(sheetId)}"]`);
  campRefreshBtns.forEach(function(btn) {
    const header = btn.closest('.dash-campaign-header');
    if (!header) return;
    const totalSpan = header.querySelector('.dash-campaign-total');
    if (!totalSpan) return;

    // "150/300 (50%)" 형태 파싱
    const match = totalSpan.textContent.match(/(\d+)\/(\d+)\s*\((\d+)%\)/);
    if (!match) return;
    const newSubmitted = parseInt(match[1]) + submitDelta;
    const newTotal     = parseInt(match[2]) + totalDelta;
    const newRate      = _pct(newSubmitted, newTotal);
    totalSpan.textContent = `${newSubmitted}/${newTotal} (${newRate}%)`;
  });
}

// ═══════════════════════════════════════════════════════════
// SSE 이벤트 리스너 등록 (기존 알림 시스템과 병행)
// index-payment.js의 _addNotification과 별도로 대시보드 DOM 직접 갱신
// ═══════════════════════════════════════════════════════════
(function _initSSEDashboardListener() {
  // SSE 이벤트는 index-payment.js에서 EventSource로 수신됨
  // 여기서는 커스텀 이벤트를 통해 대시보드 갱신을 연결
  // index-payment.js의 _addNotification에서 window 이벤트를 발행하도록 연동
  window.addEventListener('sse-dashboard-update', function(e) {
    if (e.detail) {
      if (e.detail.type === 'index_build') {
        // 인덱스 빌드 완료 → 전체 새로고침 (데이터 대폭 변경 가능)
        _autoRefreshDashboardAfterBuild();
      } else {
        _sseDashboardPartialUpdate(e.detail);
      }
    }
  });
})();

/** ★ 빌드 잠금 강제 해제 (타임아웃 후 재갱신 가능하도록) */
async function _forceReleaseBuildLock() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS URL을 먼저 설정해주세요.", "warning"); return; }
  const pw = prompt("관리자 비밀번호를 입력하세요:");
  if (!pw) return;
  try {
    let json;
    try { json = await gasPost({ action: "releaseBuildLock", adminPw: pw }); }
    catch(e) { json = await gasGet({ action: "releaseBuildLock", pw }); }
    if (json.error) throw new Error(json.error);
    showToast("🔓 빌드 잠금이 해제되었습니다. 이제 동기화을 다시 시도하세요.", "success");
    // 버튼 복원
    const btn = document.getElementById("buildIndexBtn");
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> 지금 동기화'; }
    const builtAtEl = document.getElementById("indexBuiltAt");
    if (builtAtEl) builtAtEl.textContent = "잠금 해제됨 — 다시 갱신하세요";
  } catch(err) {
    showToast("❌ 잠금 해제 실패: " + err.message, "error");
  }
}

/* ── 작업시트 추가 (2단계: 미리보기 → 등록) ── */
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
  // gid 감지
  const gidMatch = raw.match(/[#&]gid=(\d+)/);
  const hasGid = !!gidMatch;
  const cleanUrl = "https://docs.google.com/spreadsheets/d/" + m[1] + "/edit" + (hasGid ? "#gid=" + gidMatch[1] : "");
  preEl.innerHTML = hasGid
    ? `→ ${cleanUrl} <span style="background:#DBEAFE;color:#1D4ED8;padding:2px 6px;border-radius:4px;font-size:.68rem;font-weight:600;margin-left:6px">탭 즉시 등록 모드</span>`
    : "→ " + cleanUrl;
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-search"></i> 확인';
  inp.classList.add("has-val");
  // gid 모드 플래그 저장
  inp.dataset.hasGid = hasGid ? "1" : "0";
}

/** 1단계: 미리보기 — 시트 제목 + 탭 목록 확인 (또는 gid모드 탭 미리보기) */
async function previewAddCampaign() {
  const raw = document.getElementById("addCampUrl").value.trim();
  const errEl = document.getElementById("addCampError");
  const btn   = document.getElementById("addCampPreviewBtn");
  const inp   = document.getElementById("addCampUrl");
  if (!raw) return;
  errEl.textContent = "";

  // ★ gid 모드: 미리보기 (캠페인명 + 전체 탭 목록 + 등록/신규 구분)
  if (inp.dataset.hasGid === "1") {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 조회 중...';
    try {
      const data = await gasGet({ action: "previewTab", url: raw });
      if (!data.ok) {
        if (data.serviceAccount) {
          const sa = data.serviceAccount;
          errEl.innerHTML = `
            <div style="color:#dc2626;font-size:12px;line-height:1.6;margin-bottom:6px;">
              시트 접근 권한이 없습니다.<br>아래 서비스 계정을 편집자로 추가 후 다시 시도해주세요.
            </div>
            <div style="display:flex;align-items:center;gap:6px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:6px 10px;margin-bottom:8px;">
              <code style="font-size:11px;color:#334155;flex:1;word-break:break-all;user-select:all;">${sa}</code>
            </div>
            <button onclick="navigator.clipboard.writeText('${sa}').then(()=>{this.innerHTML='<i class=\\'fas fa-check\\'></i> 복사됨';this.style.background='#12b886';setTimeout(()=>{this.innerHTML='<i class=\\'fas fa-copy\\'></i> 서비스계정 복사';this.style.background='#3182f6'},1500)})"
              style="padding:6px 12px;background:#3182f6;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">
              <i class="fas fa-copy"></i> 서비스계정 복사
            </button>`;
        } else {
          errEl.textContent = data.error || "조회 실패";
        }
        return;
      }
      // 미리보기 표시
      const previewArea = document.getElementById("addCampPreviewArea");
      const alreadyBadge = document.getElementById("addCampAlreadyBadge");
      document.getElementById("addCampSheetTitle").textContent = data.campaignName;

      // ★ 신규 탭 존재 여부에 따라 배지 표시
      const closedCount = data.closedTabCount || 0;
      if (data.newTabCount === 0) {
        alreadyBadge.style.display = "block";
        alreadyBadge.innerHTML = `<div style="color:#0369A1;font-size:.78rem;line-height:1.6">
          <i class="fas fa-info-circle" style="margin-right:4px"></i>
          신규 탭 없음. 등록: ${data.existingTabCount}개${closedCount ? ` / 마감: ${closedCount}개` : ''} / 전체: ${data.totalTabCount}개
        </div>`;
      } else {
        alreadyBadge.style.display = "block";
        alreadyBadge.innerHTML = `<div style="color:#065F46;font-size:.78rem;line-height:1.6;background:#D1FAE5;padding:6px 10px;border-radius:6px;border:1px solid #6EE7B7">
          <i class="fas fa-plus-circle" style="margin-right:4px"></i>
          <b>신규 ${data.newTabCount}개</b> 탭 발견! 등록: ${data.existingTabCount}개${closedCount ? ` / 마감: ${closedCount}개` : ''} / 전체: ${data.totalTabCount}개
        </div>`;
      }

      // ★ 탭 목록 표시 (신규 + 기존 + 마감 구분)
      const listEl = document.getElementById("addCampTabList");
      document.getElementById("addCampTabCount").textContent = data.totalTabCount;
      let listHtml = '';

      // 차수 렌더링 헬퍼
      function renderRounds(rounds) {
        if (!rounds || rounds.length === 0) return '';
        let html = '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px">';
        for (const r of rounds) {
          let bg, color, border;
          if (r.status === 'archived') { bg = '#FEF3C7'; color = '#92400E'; border = '#FDE68A'; }
          else if (r.status === 'closed') { bg = '#FEE2E2'; color = '#991B1B'; border = '#FECACA'; }
          else { bg = '#ECFDF5'; color = '#065F46'; border = '#A7F3D0'; }
          const label = r.status === 'archived' ? '아카이브' : r.status === 'closed' ? '마감' : `${r.submitted}/${r.total}`;
          html += `<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:${bg};color:${color};border:1px solid ${border};white-space:nowrap" title="${r.round}: ${r.submitted}/${r.total}">${r.round} <span style="opacity:.7">${label}</span></span>`;
        }
        html += '</div>';
        return html;
      }

      // 신규 탭 먼저 (초록색)
      if (data.newTabs && data.newTabs.length > 0) {
        listHtml += `<div style="font-size:10px;font-weight:700;color:#065F46;margin:4px 0 2px;padding:2px 6px;background:#ECFDF5;border-radius:4px;display:inline-block">🆕 신규 (${data.newTabs.length}개) — 등록 대상</div>`;
        for (const tab of data.newTabs) {
          const idxInfo = tab.indexData ? `${tab.indexData.submittedCount}/${tab.indexData.rowCount}` : '미빌드';
          listHtml += `<div style="padding:6px 10px;background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:6px;font-size:12px;color:#166534;margin-bottom:3px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span><i class="fas fa-plus-circle" style="margin-right:4px;color:#22C55E"></i><b>${escHtml(tab.name)}</b></span>
              <span style="font-size:10px;color:#6B7280;background:#fff;padding:1px 6px;border-radius:3px">${idxInfo}</span>
            </div>
            ${renderRounds(tab.rounds)}
          </div>`;
        }
      }

      // 기존 등록된 탭 (회색)
      if (data.existingTabs && data.existingTabs.length > 0) {
        listHtml += `<div style="font-size:10px;font-weight:700;color:#6B7280;margin:8px 0 2px;padding:2px 6px;background:#F3F4F6;border-radius:4px;display:inline-block">✅ 기존 등록 (${data.existingTabs.length}개)</div>`;
        for (const tab of data.existingTabs) {
          const idxInfo = tab.indexData ? `${tab.indexData.submittedCount}/${tab.indexData.rowCount}` : '미빌드';
          listHtml += `<div style="padding:5px 10px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:6px;font-size:11px;color:#6B7280;margin-bottom:2px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span><i class="fas fa-check-circle" style="margin-right:4px;color:#9CA3AF"></i>${escHtml(tab.name)}</span>
              <span style="font-size:10px;color:#9CA3AF">${idxInfo}</span>
            </div>
            ${renderRounds(tab.rounds)}
          </div>`;
        }
      }

      // ★ 마감된 탭 (노란색 — 등록 제외)
      if (data.closedTabs && data.closedTabs.length > 0) {
        listHtml += `<div style="font-size:10px;font-weight:700;color:#92400E;margin:8px 0 2px;padding:2px 6px;background:#FEF3C7;border-radius:4px;display:inline-block">🔒 마감 (${data.closedTabs.length}개) — 등록 제외</div>`;
        for (const tab of data.closedTabs) {
          listHtml += `<div style="padding:5px 10px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;font-size:11px;color:#92400E;margin-bottom:2px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span><i class="fas fa-lock" style="margin-right:4px;color:#D97706"></i>${escHtml(tab.name)}</span>
              <span style="font-size:10px;color:#B45309;background:#FEF3C7;padding:1px 6px;border-radius:3px">${tab.status === 'archived' ? '아카이브' : '마감'}</span>
            </div>
            ${renderRounds(tab.rounds)}
          </div>`;
        }
      }

      listEl.innerHTML = listHtml;

      previewArea.style.display = "block";
      btn.style.display = "none";
      // 즉시 등록 버튼 표시
      const submitBtn = document.getElementById("addCampSubmitBtn");
      submitBtn.style.display = "";
      submitBtn.disabled = false;
      if (data.newTabCount > 0) {
        submitBtn.innerHTML = `<i class="fas fa-bolt"></i> 즉시 등록 (신규 ${data.newTabCount}개)`;
      } else {
        submitBtn.innerHTML = '<i class="fas fa-sync-alt"></i> 인덱스 갱신';
      }
      submitBtn.onclick = function() { submitAddTab(); };
    } catch (err) {
      errEl.textContent = err.message || "조회 실패";
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-search"></i> 확인';
    }
    return;
  }

  // ★ 기존 로직: 시트 전체 미리보기
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
            <button onclick="navigator.clipboard.writeText('${sa}').then(()=>{this.innerHTML='<i class=\\'fas fa-check\\'></i> 복사됨';this.style.background='#12b886';setTimeout(()=>{this.innerHTML='<i class=\\'fas fa-copy\\'></i> 서비스계정 복사';this.style.background='#3182f6'},1500)})"
              style="flex:1;padding:6px 10px;background:#3182f6;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px;">
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
      badge.innerHTML = `<div style="color:#DC2626;font-size:.78rem;line-height:1.6">
        <i class="fas fa-ban" style="margin-right:4px"></i>
        <b>등록 불가</b> — 이미 등록된 캠페인입니다 (${escHtml(data.existingName)}).<br>
        기존에 등록된 업체는 <b>스마트빌드 갱신 시 새 탭이 자동으로 인식</b>됩니다.<br>
        별도로 다시 등록할 필요가 없습니다.
      </div>`;
      // 등록 버튼 숨기기 (등록 차단)
      document.getElementById("addCampPreviewArea").style.display = "block";
      btn.style.display = "none";
      document.getElementById("addCampSubmitBtn").style.display = "none";
      return;
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

/** 2단계(탭 모드): 즉시 등록 + 인덱스 빌드 실행 (신규 탭만 추가) */
async function submitAddTab() {
  const raw = document.getElementById("addCampUrl").value.trim();
  const errEl = document.getElementById("addCampError");
  const btn   = document.getElementById("addCampSubmitBtn");
  if (!raw) return;
  errEl.textContent = "";
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 등록 + 빌드 중...';
  try {
    const data = await gasGet({ action: "addTab", url: raw }, 60000);
    if (!data.ok) {
      errEl.innerHTML = `<div style="color:#DC2626;font-size:.78rem;line-height:1.6;padding:8px 12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px">
        <i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>
        ${escHtml(data.error || '등록 실패')}
      </div>`;
      return;
    }
    closeAddCampaign();
    // 결과 토스트 메시지
    if (data.addedTabCount > 0) {
      const tabNames = data.addedTabs ? data.addedTabs.join(', ') : data.tabName;
      showToast(`✅ 신규 탭 ${data.addedTabCount}개 등록 완료: ${data.campaignName} / [${tabNames}]`);
    } else if (data.message) {
      showToast(`ℹ️ ${data.message}`);
    } else {
      showToast(`✅ 등록 완료: ${data.campaignName}`);
    }
    // 대시보드 새로고침
    setTimeout(() => { if (typeof loadTabDashboard === 'function') loadTabDashboard(); }, 500);
  } catch (err) {
    errEl.textContent = err.message || "등록 실패";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-bolt"></i> 즉시 등록';
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
    // ★ 미리보기에서 감지한 시트 제목을 campaignName으로 전달
    const sheetTitle = (document.getElementById("addCampSheetTitle")?.textContent || "").trim();
    const data = await gasGet({ action: "addCampaign", url: raw, campaignName: sheetTitle });
    // ★ 중복 등록 차단: 이미 등록된 캠페인이면 에러 표시
    if (data.error || data.duplicate) {
      errEl.innerHTML = `<div style="color:#DC2626;font-size:.78rem;line-height:1.6;padding:8px 12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px">
        <i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>
        ${escHtml(data.error || '등록 실패').replace(/\n/g, '<br>')}
      </div>`;
      return;
    }
    closeAddCampaign();
    showToast(`✅ 등록 완료: ${data.campaignName} (${data.url})`);
    // ★ 시트 권한 자동 부여 결과 토스트
    if (data.shareResult) {
      if (data.shareResult.ok !== false) {
        setTimeout(() => showToast(
          data.shareResult.alreadyShared
            ? "🔑 시트 쓰기권한: 이미 부여됨"
            : `🔑 시트 쓰기권한 자동 부여 완료 (${data.shareResult.method || 'SA'})`,
          "success"), 800);
      } else {
        setTimeout(() => showToast(
          `⚠️ 시트 쓰기권한 자동 부여 실패 — 수동으로 부여해주세요.`, "error"), 800);
      }
    }
    // ★ v10.2 P2-B: 세부목록 기본 행 자동 삽입 결과 안내
    if (data.autoInsertedTabs > 0) {
      setTimeout(() => showToast(
        `📋 세부목록에 ${data.autoInsertedTabs}개 탭 기본 행이 자동으로 추가됐습니다. 담당자/시간대를 설정해주세요.`,
        "success"), 1800);
    } else {
      // 등록 후 동기화 안내 토스트
      setTimeout(() => showToast("💡 동기화 버튼을 눌러 대시보드에 반영하세요.", false), 2800);
    }
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
    if (document.getElementById("createSheetOverlay").classList.contains("open"))
      closeCreateSheetModal();
  }
});

/* ════════════════════════════════════════════════════════════
   ★ v9.10: 캠페인 시트 생성 모달
   ════════════════════════════════════════════════════════════ */

/** localStorage 키 */
const _TMPL_SHEET_KEY = "rapp_template_sheet_id";

/** 저장된 템플릿 sheetId 가져오기 */
function _getTemplateSheetId() {
  return localStorage.getItem(_TMPL_SHEET_KEY) || "";
}

/** URL → sheetId 추출 헬퍼 */
function _extractSheetIdFromUrl(url) {
  const m = (url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : "";
}

/* ── 계정설정 모달: 템플릿 URL 입력 처리 ── */
function onTemplateUrlInput() {
  const val = (document.getElementById("templateSheetUrlInput").value || "").trim();
  const titleEl = document.getElementById("templateSheetTitle");
  const errEl   = document.getElementById("templateSheetError");
  errEl.textContent = "";
  if (!val) { titleEl.textContent = ""; return; }
  const sid = _extractSheetIdFromUrl(val);
  if (!sid) {
    titleEl.textContent = "";
    errEl.textContent = "구글 스프레드시트 URL 형식이 아닙니다.";
    return;
  }
  titleEl.textContent = "ID: " + sid;
}

async function saveTemplateSheetUrl() {
  const val   = (document.getElementById("templateSheetUrlInput").value || "").trim();
  const errEl = document.getElementById("templateSheetError");
  const tEl   = document.getElementById("templateSheetTitle");
  errEl.textContent = "";
  if (!val) { errEl.textContent = "URL을 입력하세요."; return; }
  const sid = _extractSheetIdFromUrl(val);
  if (!sid) { errEl.textContent = "유효한 구글 스프레드시트 URL이 아닙니다."; return; }

  tEl.textContent = "확인 중...";
  try {
    const data = await gasGet({ action: "getTemplateSheetTitle", sheetId: sid });
    if (data && data.ok) {
      localStorage.setItem(_TMPL_SHEET_KEY, sid);
      tEl.textContent = "✅ 저장 완료: " + (data.title || sid);
      showToast("✅ 템플릿 시트 저장: " + (data.title || sid), false, 3000);
    } else {
      tEl.textContent = "";
      errEl.textContent = (data && data.error) ? data.error : "시트를 확인할 수 없습니다.";
    }
  } catch(e) {
    tEl.textContent = "";
    errEl.textContent = "오류: " + e.message;
  }
}

/* ── 시트 생성 모달 열기/닫기 ── */
async function openCreateSheetModal() {
  const overlay = document.getElementById("createSheetOverlay");
  const warnEl  = document.getElementById("csTemplateWarn");
  const tmplId  = _getTemplateSheetId();

  // 초기화
  document.getElementById("csFileTitle").value = "";
  document.getElementById("csCampName").value  = "";
  document.getElementById("csExistingInput").value = "";
  document.getElementById("csExistingSelect").value = "";
  _closeCsExistingList();
  const _initTabSel = document.getElementById("csTmplTabSelect");
  _initTabSel.innerHTML = '<option value="">-- 위에서 캠페인을 먼저 선택하세요 --</option>';
  _initTabSel.disabled  = true;
  document.getElementById("csTmplTabHint").textContent = "캠페인 선택 후 템플릿 탭 목록이 자동으로 표시됩니다.";
  document.getElementById("csResult").style.display = "none";
  document.getElementById("csResult").className = "cs-result";
  document.getElementById("csBtnOk").disabled  = true;
  document.querySelectorAll('input[name="csMode"]')[0].checked = true;
  onCsModeChange();

  // 템플릿 미설정 경고
  warnEl.style.display = tmplId ? "none" : "flex";

  // 기존 캠페인 목록 채우기
  await _fillCsExistingSelect();

  overlay.classList.add("open");
  setTimeout(() => document.getElementById("csFileTitle").focus(), 80);
}

function closeCreateSheetModal() {
  document.getElementById("createSheetOverlay").classList.remove("open");
}

/** 등록 방식 라디오 변경 */
function onCsModeChange() {
  const mode = document.querySelector('input[name="csMode"]:checked').value;
  document.getElementById("csCampNameWrap").style.display  = mode === "new"      ? "" : "none";
  document.getElementById("csExistingWrap").style.display  = mode === "existing" ? "" : "none";
  document.getElementById("csTmplTabWrap").style.display   = mode === "existing" ? "" : "none";
  // existing 모드 전환 시 탭 드롭다운 초기화
  if (mode === "existing") {
    const sel = document.getElementById("csTmplTabSelect");
    sel.innerHTML = '<option value="">-- 위에서 캠페인을 먼저 선택하세요 --</option>';
    sel.disabled = true;
    document.getElementById("csTmplTabHint").textContent = "캠페인 선택 후 템플릿 탭 목록이 자동으로 표시됩니다.";
  }
  onCsInput();
}

/** 기존 캠페인 선택 변경 시 템플릿 탭 목록 로드 */
function onCsExistingChange() {
  onCsInput();
  const existSId = document.getElementById("csExistingSelect").value;
  if (existSId) _loadCsTmplTabs(existSId);
  else {
    const sel = document.getElementById("csTmplTabSelect");
    sel.innerHTML = '<option value="">-- 위에서 캠페인을 먼저 선택하세요 --</option>';
    sel.disabled = true;
    document.getElementById("csTmplTabHint").textContent = "캠페인 선택 후 템플릿 탭 목록이 자동으로 표시됩니다.";
    onCsInput();
  }
}

/** 템플릿 탭 목록 로드 (templateSheetId 사용, 없으면 existingSheetId 폴백) */
async function _loadCsTmplTabs(existingSheetIdFallback) {
  const tmplId  = _getTemplateSheetId() || existingSheetIdFallback || "";
  const sel     = document.getElementById("csTmplTabSelect");
  const hintEl  = document.getElementById("csTmplTabHint");

  if (!tmplId) {
    sel.innerHTML = '<option value="">템플릿 시트를 먼저 등록해주세요</option>';
    sel.disabled = true;
    if (hintEl) hintEl.textContent = "계정설정에서 템플릿 시트 URL을 등록하면 자동으로 탭 목록이 로드됩니다.";
    return;
  }

  sel.innerHTML = '<option value="">탭 목록 불러오는 중...</option>';
  sel.disabled  = true;
  if (hintEl) hintEl.textContent = "템플릿 탭 목록을 가져오는 중...";

  try {
    const data = await gasGet({ action: "getTemplateSheetTabs", sheetId: tmplId }, 15000);
    if (data && data.tabs && data.tabs.length) {
      sel.innerHTML = '<option value="">-- 탭을 선택하세요 --</option>';
      data.tabs.forEach(tabName => {
        const opt = document.createElement("option");
        opt.value = tabName;
        opt.textContent = tabName;
        sel.appendChild(opt);
      });
      if (hintEl) hintEl.textContent = `총 ${data.tabs.length}개 탭 | 복사할 탭을 선택하세요.`;
    } else {
      sel.innerHTML = '<option value="">탭을 찾을 수 없습니다</option>';
      if (hintEl) hintEl.textContent = "탭이 없습니다.";
    }
  } catch(e) {
    sel.innerHTML = '<option value="">탭 목록 로드 실패 (재시도 가능)</option>';
    if (hintEl) hintEl.textContent = "오류: " + (e.message || "탭 목록을 불러올 수 없습니다.");
  } finally {
    sel.disabled = false;
    onCsInput();
  }
}

/** 입력 유효성 → 버튼 활성화 */
function onCsInput() {
  const title   = (document.getElementById("csFileTitle").value || "").trim();
  const mode    = document.querySelector('input[name="csMode"]:checked').value;
  const camp    = (document.getElementById("csCampName").value || "").trim();
  const selCamp = document.getElementById("csExistingSelect").value;
  const selTab  = document.getElementById("csTmplTabSelect").value;
  const ok = title &&
             (mode === "new"      ? !!camp :
              mode === "existing" ? (!!selCamp && !!selTab) : false);
  document.getElementById("csBtnOk").disabled = !ok;
}

/** 기존 캠페인 자동완성 데이터 배열 */
let _csExistingItems = []; // [{sheetId, label, campName}]

/** 기존 캠페인 목록 데이터 채우기 (_lastDashData 활용) */
async function _fillCsExistingSelect() {
  _csExistingItems = [];
  const stats = (_lastDashData && _lastDashData.stats) ? _lastDashData.stats : [];
  let source = stats;
  if (!source.length) {
    try {
      const data = await gasGet({ action: "dashboard" }, 20000);
      source = data.stats || [];
    } catch(_) { return; }
  }
  const seen = new Set();
  source.forEach(c => {
    (c.tabs || []).forEach(t => {
      if (!t.sheetId || seen.has(t.sheetId)) return;
      seen.add(t.sheetId);
      _csExistingItems.push({
        sheetId: t.sheetId,
        label: c.campaign || t.sheetId,
        campName: c.campaign || ""
      });
    });
  });
}

/** 자동완성 필터링 및 드롭다운 렌더 */
function _filterCsExisting(query) {
  const listEl = document.getElementById("csExistingList");
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? _csExistingItems.filter(item => item.label.toLowerCase().includes(q))
    : _csExistingItems;
  if (!filtered.length) {
    listEl.innerHTML = '<div style="padding:10px 14px;color:#9CA3AF;font-size:.85rem">일치하는 캠페인 없음</div>';
    listEl.style.display = "block";
    return;
  }
  listEl.innerHTML = filtered.map((item, idx) => {
    const highlighted = q ? item.label.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'), '<b style="color:#3182f6">$1</b>') : item.label;
    return `<div class="cs-ac-item" style="padding:9px 14px;cursor:pointer;border-bottom:1px solid #F3F4F6;font-size:.9rem;transition:background .15s" onmousedown="_selectCsExisting(${idx}, '${item.sheetId.replace(/'/g,"\\'")}')"
      onmouseenter="this.style.background='#f2f7ff'" onmouseleave="this.style.background=''">${highlighted}</div>`;
  }).join("");
  listEl.style.display = "block";
}

/** 자동완성 항목 선택 */
function _selectCsExisting(idx, sheetId) {
  const item = _csExistingItems.find(i => i.sheetId === sheetId);
  if (!item) return;
  document.getElementById("csExistingInput").value = item.label;
  document.getElementById("csExistingSelect").value = item.sheetId;
  _closeCsExistingList();
  onCsExistingChange();
}

/** 자동완성 드롭다운 닫기 */
function _closeCsExistingList() {
  document.getElementById("csExistingList").style.display = "none";
}

/** 시트 생성 실행 */
async function submitCreateSheet() {
  const tmplId   = _getTemplateSheetId();
  const fileTitle = (document.getElementById("csFileTitle").value || "").trim();
  const mode      = document.querySelector('input[name="csMode"]:checked').value;
  const campName  = (document.getElementById("csCampName").value || "").trim();
  const selEl     = document.getElementById("csExistingSelect");
  const existSId  = selEl.value;
  const resultEl  = document.getElementById("csResult");
  const btn       = document.getElementById("csBtnOk");

  resultEl.style.display = "none";

  if (!tmplId) {
    resultEl.className = "cs-result error";
    resultEl.innerHTML = "⚠️ 템플릿 시트가 설정되지 않았습니다.<br>계정설정에서 먼저 등록해 주세요.";
    resultEl.style.display = "block";
    return;
  }
  if (!fileTitle) { showToast("파일명을 입력해 주세요.", true); return; }

  btn.disabled  = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 생성 중...';

  try {
    const tmplTabName = (document.getElementById("csTmplTabSelect").value || "").trim();
    const params = {
      action:           "createCampaignSheet",
      templateSheetId:  tmplId,
      fileTitle:        fileTitle,
      registerMode:     mode,
      campaignName:     campName,
      existingSheetId:  existSId,
      templateTabName:  tmplTabName
    };
    const data = await gasGet(params, 60000); // 복사 최대 60초

    if (data && data.ok) {
      resultEl.className = "cs-result success";
      const isExisting = data.mode === "existing";
      resultEl.innerHTML =
        `✅ <b>시트 생성 완료!</b><br>` +
        (isExisting
          ? `📑 추가된 탭: <b>${escHtml(data.newTabName || fileTitle)}</b><br>`
          : `📄 파일명: <b>${escHtml(data.fileTitle)}</b><br>`) +
        `🏷 캠페인: <b>${escHtml(data.campaignName)}</b><br>` +
        (isExisting
          ? `🔗 <a href="${escHtml(data.tabUrl || data.sheetUrl)}" target="_blank" style="color:#0ca678;font-weight:700">해당 탭 바로가기 →</a>`
          : `🔗 <a href="${escHtml(data.sheetUrl)}" target="_blank" style="color:#0ca678;font-weight:700">구글시트 바로가기 →</a>`);
      resultEl.style.display = "block";
      btn.innerHTML = '<i class="fas fa-check"></i> 완료';
      showToast("✅ 시트 생성 완료! 동기화 후 대시보드에 반영됩니다.", false, 5000);
      // ★ 시트 권한 자동 부여 결과 토스트
      if (data.shareResult) {
        if (data.shareResult.ok !== false) {
          setTimeout(() => showToast(
            data.shareResult.alreadyShared
              ? "🔑 시트 쓰기권한: 이미 부여됨"
              : `🔑 시트 쓰기권한 자동 부여 완료 (${data.shareResult.method || 'SA'})`,
            "success", 4000), 1200);
        } else {
          setTimeout(() => showToast(
            `⚠️ 시트 쓰기권한 자동 부여 실패 — 수동으로 부여해주세요.`, "error", 5000), 1200);
        }
      }
      setTimeout(() => showToast("💡 [지금 동기화] 버튼을 눌러 대시보드에 반영하세요.", false, 5000), 3000);
    } else {
      throw new Error((data && data.error) ? data.error : "알 수 없는 오류");
    }
  } catch(e) {
    resultEl.className = "cs-result error";
    resultEl.innerHTML = "❌ 오류: " + escHtml(e.message || "생성 실패");
    resultEl.style.display = "block";
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-plus"></i> 시트 생성';
  }
}

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

/* ── 유틸 ── */

/** ★ 이미지 압축 — 업로드 전 클라이언트 측 리사이즈/JPEG 변환 */
function compressImageIdx(file, maxWidth, quality) {
  maxWidth = maxWidth || 1920;
  quality  = quality  || 0.75;
  return new Promise(function(resolve, reject) {
    // 1MB 이하 JPEG는 압축 불필요
    if (file.size <= 1024 * 1024 && file.type === 'image/jpeg') {
      return fileToBase64Raw(file).then(resolve).catch(reject);
    }
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function() {
      URL.revokeObjectURL(url);
      var w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * (maxWidth / w)); w = maxWidth; }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var dataUrl = canvas.toDataURL('image/jpeg', quality);
      var b64 = dataUrl.split(',')[1];
      if (!b64) { reject(new Error('이미지 압축 실패')); return; }
      var compSz = Math.round(b64.length * 0.75);
      console.log('[compress] ' + file.name + ': ' + (file.size/1024).toFixed(0) + 'KB → ' + (compSz/1024).toFixed(0) + 'KB (' + w + 'x' + h + ')');
      resolve(b64);
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      fileToBase64Raw(file).then(resolve).catch(reject);
    };
    img.src = url;
  });
}

/** 원본 Base64 변환 (압축 없이) */
function fileToBase64Raw(file) {
  return new Promise(function(res, rej) {
    var r = new FileReader();
    r.onload  = function() {
      var result = r.result;
      if (!result || !result.includes(',')) { rej(new Error('파일 읽기 결과가 비어있습니다')); return; }
      res(result.split(',')[1]);
    };
    r.onerror = function(ev) { rej(new Error('파일 읽기 오류')); };
    r.readAsDataURL(file);
  });
}

/** ★ fileToBase64 — 이미지는 자동 압축, 그 외는 원본 변환 */
function fileToBase64(file) {
  if (file.type && file.type.startsWith('image/')) {
    return compressImageIdx(file);
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

function showToast(msg, type="info") {
  const c = document.getElementById("toastContainer");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const icons = { error:"fa-circle-xmark", success:"fa-circle-check", warning:"fa-triangle-exclamation", info:"fa-circle-info" };
  t.innerHTML = `<i class="fas ${icons[type]||"fa-circle-info"}"></i>${escHtml(msg)}`;
  c.appendChild(t);
  setTimeout(() => { t.style.transition="opacity .3s"; t.style.opacity="0"; setTimeout(()=>t.remove(),300); }, 3500);
}

/* ══════════════════════════════════════════════════════════
   ★ v9.9: 대시보드 완료 탭 감지 자동 폴링 + Push Notification
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   · 5분마다 GAS dashboard를 조회해 이전 상태와 비교
   · 탭 완료 조건: pending===0 && total>0
   · 알림: 토스트 팝업 + 브라우저 Push Notification
   ══════════════════════════════════════════════════════════ */
const _DASH_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5분
let   _dashPollTimer   = null;
let   _dashPollTabSnap = {}; // { "sheetId||tabName": { done: bool, total: int } }

/** 탭 완료 여부 판정 (대시보드 표시 기준과 동일) */
function _isTabComplete(t) {
  return t.isClosed || (t.pending === 0 && t.total > 0);
}

/** 현재 stats에서 스냅샷 생성 */
function _buildTabSnap(stats) {
  const snap = {};
  (stats || []).forEach(c => {
    (c.tabs || []).forEach(t => {
      const key = (t.sheetId || "") + "||" + (t.tab || "");
      snap[key] = { done: _isTabComplete(t), total: t.total || 0, campaign: c.campaign || "", tab: t.tab || "" };
    });
  });
  return snap;
}

/** Push Notification 권한 요청 */
async function _requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const perm = await Notification.requestPermission();
  return perm === "granted";
}

/** 브라우저 Push Notification 표시 */
function _sendPushNotif(title, body, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      icon: "https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/svgs/solid/check-circle.svg",
      tag: tag || "dash-complete",
      requireInteraction: false,
      silent: false
    });
    setTimeout(() => n.close(), 8000);
  } catch(e) { /* 알림 실패 무시 */ }
}

/** 폴링 1회 실행 — 완료된 탭 감지 후 알림 */
async function _pollDashboardOnce() {
  if (!isAdminLoggedIn()) return;
  try {
    const data  = await gasGet({ action: "dashboard" }, 25000);
    if (!data || data.error || !data.stats) return;

    const newSnap = _buildTabSnap(data.stats);
    const newlyDone = [];

    Object.entries(newSnap).forEach(([key, cur]) => {
      const prev = _dashPollTabSnap[key];
      if (!prev) return; // 첫 로드 시에는 비교 대상 없음
      // 이전에는 완료 아니었는데 지금 완료된 경우
      if (!prev.done && cur.done && cur.total > 0) {
        newlyDone.push({ key, campaign: cur.campaign, tab: cur.tab });
      }
    });

    // 스냅샷 갱신 (처음 실행 시 기준값만 저장)
    _dashPollTabSnap = newSnap;

    if (!newlyDone.length) return;

    // 알림 발송
    newlyDone.forEach(({ campaign, tab }) => {
      const msg = `✅ [${campaign}] ${tab} 탭이 완료되었습니다!`;
      showToast(msg, "success", 6000);
      _sendPushNotif("리뷰 운영 완료 알림", `[${campaign}] ${tab} 탭 완료!`, "tab-done-" + tab);
    });

    // 대시보드 데이터 업데이트 (배경 갱신)
    _lastDashData = data;

    // 탭 타이틀 업데이트
    const cnt = newlyDone.length;
    const orig = document.title.replace(/^\(🔔\s*\d+건\s*완료\)\s*/, "");
    document.title = `(🔔 ${cnt}건 완료) ${orig}`;
    setTimeout(() => { document.title = orig; }, 30000);

  } catch(e) { /* 폴링 오류 무시 */ }
}

/** 대시보드 폴링 시작 */
async function startDashPolling() {
  if (_dashPollTimer) return; // 이미 실행 중
  // Push 권한 요청 (최초 1회)
  await _requestNotifPermission();
  // 즉시 스냅샷 초기화 (알림 없이)
  if (_lastDashData && _lastDashData.stats) {
    _dashPollTabSnap = _buildTabSnap(_lastDashData.stats);
  }
  _dashPollTimer = setInterval(_pollDashboardOnce, _DASH_POLL_INTERVAL_MS);
  showToast("🔔 탭 완료 자동 알림이 활성화되었습니다. (5분 간격)", "info", 4000);
  console.log("[Poll] 대시보드 완료 감지 폴링 시작 (5분 간격)");
}

/** 대시보드 폴링 중지 */
function stopDashPolling() {
  if (_dashPollTimer) {
    clearInterval(_dashPollTimer);
    _dashPollTimer = null;
    showToast("🔕 자동 알림이 비활성화되었습니다.", "info", 3000);
  }
}

/** 폴링 토글 버튼 처리 */
function toggleDashPolling() {
  if (_dashPollTimer) {
    stopDashPolling();
    const btn = document.getElementById("pollToggleBtn");
    if (btn) { btn.innerHTML = '<i class="fas fa-bell"></i> 완료알림 켜기'; btn.classList.remove("active"); }
  } else {
    startDashPolling();
    const btn = document.getElementById("pollToggleBtn");
    if (btn) { btn.innerHTML = '<i class="fas fa-bell-slash"></i> 완료알림 끄기'; btn.classList.add("active"); }
  }
}

// 관리자 대시보드 로드 완료 후 스냅샷은 loadAdminDashboard 내부에서 직접 갱신됨

/* ══════════════════════════════════════════════════════════════
   ★ Phase 12: 마감 시스템 (탭 단위, 반자동)
   ══════════════════════════════════════════════════════════════ */

// ── 마감 목록 로드 (검색/기간필터 지원) ──
async function loadArchiveList() {
  const wrap = document.getElementById('archiveListWrap');
  if (!wrap) return;
  wrap.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...';

  try {
    const q = (document.getElementById('archiveSearchInput')?.value || '').trim();
    const from = document.getElementById('archiveDateFrom')?.value || '';
    const to = document.getElementById('archiveDateTo')?.value || '';

    const params = {};
    if (q) params.q = q;
    if (from) params.from = from;
    if (to) params.to = to;

    const data = await gasGet({ action: 'archiveList', ...params });

    if (data.error) {
      wrap.innerHTML = '<span style="color:#EF4444"><i class="fas fa-exclamation-circle"></i> ' + escHtml(data.error) + '</span>';
      return;
    }

    const campaigns = data.campaigns || [];

    // 요약 카드 업데이트
    const el = id => document.getElementById(id);
    if (el('archiveCampCount')) el('archiveCampCount').textContent = data.totalCampaigns || 0;
    if (el('archiveTabCount'))  el('archiveTabCount').textContent = data.totalTabs || 0;
    if (el('archiveRowCount'))  el('archiveRowCount').textContent = (data.totalRows || 0).toLocaleString();

    if (campaigns.length === 0) {
      wrap.innerHTML = '<div style="text-align:center;padding:32px;color:var(--t3)"><i class="fas fa-inbox" style="font-size:2rem;margin-bottom:8px;display:block"></i>마감된 데이터가 없습니다</div>';
      _loadArchiveHistory();
      return;
    }

    // 캠페인별 목록 렌더링
    let html = '';
    campaigns.forEach(camp => {
      const totalRate = _pct(camp.totalSubmitted, camp.totalRows);
      html += `<div style="margin-bottom:12px;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden">
        <div style="background:#F9FAFB;padding:10px 14px;display:flex;align-items:center;gap:8px;cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
          <i class="fas fa-chevron-right" style="font-size:.7rem;color:#9CA3AF;transition:transform .2s"></i>
          <span style="font-weight:600;color:var(--t1);font-size:.85rem">${escHtml(camp.campaignName)}</span>
          <span style="margin-left:auto;font-size:.75rem;color:#6B7280">${camp.tabs.length}탭 · ${camp.totalRows.toLocaleString()}행 · ${totalRate}%</span>
        </div>
        <div style="display:none">
          <table style="width:100%;font-size:.78rem;border-collapse:collapse">
            <thead><tr style="background:#F3F4F6">
              <th style="padding:6px 10px;text-align:left;color:#6B7280">탭명</th>
              <th style="padding:6px 8px;text-align:left;color:#6B7280;width:120px">차수</th>
              <th style="padding:6px 8px;text-align:right;color:#6B7280;width:60px">행</th>
              <th style="padding:6px 8px;text-align:right;color:#6B7280;width:60px">제출</th>
              <th style="padding:6px 8px;text-align:center;color:#6B7280;width:70px">사유</th>
              <th style="padding:6px 8px;text-align:right;color:#6B7280;width:110px">마감일</th>
              <th style="padding:6px 8px;text-align:center;color:#6B7280;width:60px">복원</th>
            </tr></thead><tbody>`;
      camp.tabs.forEach(t => {
        const reasonLabel = t.archiveReason === 'closed' ? '마감' :
                            t.archiveReason === 'force_done' ? '(구)강제완료' :
                            t.archiveReason === 'completed' ? '100%완료' :
                            t.archiveReason === 'name_completed' ? '(완)탭명' :
                            t.archiveReason === 'auto_detect' ? '자동감지' : (t.archiveReason || '-');
        const reasonColor = t.archiveReason === 'closed' ? '#EF4444' :
                            t.archiveReason === 'force_done' ? '#F59E0B' :
                            t.archiveReason === 'name_completed' ? '#3182f6' : '#12b886';
        const dateStr = t.archivedAt ? new Date(t.archivedAt).toLocaleDateString('ko-KR') : '-';
        const roundsStr = t.rounds ? escHtml(t.rounds) : '<span style="color:#D1D5DB">-</span>';
        // ★ roundOnly 항목은 차수 단위 복원, 일반은 탭 전체 복원
        const restoreBtn = t.roundOnly
          ? `<button onclick="restoreArchivedRound('${camp.sheetId}','${escHtml(t.tabName).replace(/'/g,"\\'")}','${escHtml(t.rounds).replace(/'/g,"\\'")}')"
              style="font-size:.7rem;padding:3px 8px;border:1px solid #4593fc;color:#4593fc;background:#f2f7ff;border-radius:5px;cursor:pointer;white-space:nowrap"
              title="이 차수를 대시보드로 복원합니다"><i class="fas fa-undo"></i> ${t.rounds}차 복원</button>`
          : `<button onclick="restoreArchivedTab('${camp.sheetId}','${escHtml(t.tabName).replace(/'/g,"\\'")}')"
              style="font-size:.7rem;padding:3px 8px;border:1px solid #3B82F6;color:#3B82F6;background:#EFF6FF;border-radius:5px;cursor:pointer;white-space:nowrap"
              title="이 탭을 대시보드로 복원합니다"><i class="fas fa-undo"></i> 복원</button>`;
        html += `<tr style="border-top:1px solid #F3F4F6">
          <td style="padding:5px 10px">${escHtml(t.tabName)}</td>
          <td style="padding:5px 8px;font-size:.73rem;color:#4B5563">${roundsStr}</td>
          <td style="padding:5px 8px;text-align:right">${(t.rowCount||0).toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right">${(t.submittedCount||0).toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:center"><span style="background:${reasonColor}15;color:${reasonColor};padding:2px 6px;border-radius:4px;font-size:.7rem">${reasonLabel}</span></td>
          <td style="padding:5px 8px;text-align:right;color:#9CA3AF">${dateStr}</td>
          <td style="padding:5px 8px;text-align:center">${restoreBtn}</td>
        </tr>`;
      });
      html += '</tbody></table></div></div>';
    });

    wrap.innerHTML = html;
    _loadArchiveHistory();
  } catch (err) {
    wrap.innerHTML = '<span style="color:#EF4444">로드 실패: ' + escHtml(err.message) + '</span>';
  }
}

// ── 마감 탭 복원 ──
async function restoreArchivedTab(sheetId, tabName) {
  if (!confirm(`"${tabName}" 탭을 대시보드로 복원하시겠습니까?\n\n복원하면 다시 스마트갱신 대상이 되며 대시보드에 표시됩니다.`)) return;

  try {
    showToast('<i class="fas fa-spinner fa-spin"></i> 복원 중...', 'info');
    const data = await gasPost({ action: 'archiveRestore', tabs: [{ sheetId, tabName }] });
    if (data.error) {
      showToast('<i class="fas fa-exclamation-circle"></i> 복원 실패: ' + escHtml(data.error), 'error');
      return;
    }
    const restored = data.results?.filter(r => r.status === 'restored') || [];
    if (restored.length > 0) {
      showToast(`<i class="fas fa-check-circle"></i> "${escHtml(tabName)}" 복원 완료 (${data.restoredRows || 0}행)`, 'success');
      loadArchiveList(); // 목록 새로고침
    } else {
      const reason = data.results?.[0]?.reason || '알 수 없는 오류';
      showToast('<i class="fas fa-exclamation-triangle"></i> 복원 실패: ' + escHtml(reason), 'error');
    }
  } catch (err) {
    showToast('<i class="fas fa-times-circle"></i> 복원 오류: ' + escHtml(err.message), 'error');
  }
}

// ── 차수 단위 복원 ──
async function restoreArchivedRound(sheetId, tabName, round) {
  if (!confirm(`"${tabName}" 의 ${round}차를 복원하시겠습니까?\n\n복원하면 해당 차수가 대시보드에 다시 표시됩니다.`)) return;

  try {
    showToast('<i class="fas fa-spinner fa-spin"></i> 차수 복원 중...', 'info');
    const data = await gasPost({ action: 'archiveRestoreRound', sheetId, tabName, round });
    if (data.error) {
      showToast('<i class="fas fa-exclamation-circle"></i> 복원 실패: ' + escHtml(data.error), 'error');
      return;
    }
    if (data.restored) {
      showToast(`<i class="fas fa-check-circle"></i> "${escHtml(tabName)}" ${round}차 복원 완료 (${data.reviewCount || 0}행)`, 'success');
      loadArchiveList(); // 목록 새로고침
    } else {
      showToast('<i class="fas fa-exclamation-triangle"></i> 복원 실패', 'error');
    }
  } catch (err) {
    showToast('<i class="fas fa-times-circle"></i> 복원 오류: ' + escHtml(err.message), 'error');
  }
}

// ── 마감 이력 로드 ──
async function _loadArchiveHistory() {
  const wrap = document.getElementById('archiveHistoryWrap');
  if (!wrap) return;

  try {
    const data = await gasGet({ action: 'archiveHistory', limit: 20 });
    if (!data.history || data.history.length === 0) {
      wrap.innerHTML = '<span style="color:var(--t3)">이력 없음</span>';
      return;
    }

    let html = '<div style="display:flex;flex-direction:column;gap:6px">';
    data.history.forEach(h => {
      const icon = h.action === 'archive' ? 'fa-box' : 'fa-undo';
      const color = h.action === 'archive' ? '#4593fc' : '#3B82F6';
      const dateStr = h.performedAt ? new Date(h.performedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #F3F4F6">
        <i class="fas ${icon}" style="color:${color};width:16px;text-align:center"></i>
        <span style="flex:1;font-size:.78rem">${escHtml(h.note || h.campaignName || '')}</span>
        <span style="font-size:.72rem;color:#9CA3AF;white-space:nowrap">${h.performedBy || ''} · ${dateStr}</span>
      </div>`;
    });
    html += '</div>';
    wrap.innerHTML = html;
  } catch (_) {
    wrap.innerHTML = '<span style="color:var(--t3)">이력 로드 실패</span>';
  }
}

// ── 완료건 자동감지 (반자동: 감지 → 확인 → 실행) ──
async function archiveAutoDetect() {
  const detectWrap = document.getElementById('archiveDetectWrap');
  if (!detectWrap) return;

  detectWrap.style.display = 'block';
  detectWrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2)"><i class="fas fa-circle-notch fa-spin"></i> 완료건 감지 중...</div>';

  try {
    const data = await gasGet({ action: 'archiveDetect' });

    if (data.error) {
      detectWrap.innerHTML = '<div style="padding:12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#DC2626"><i class="fas fa-exclamation-circle"></i> ' + escHtml(data.error) + '</div>';
      return;
    }

    if (!data.campaigns || data.totalTabs === 0) {
      detectWrap.innerHTML = '<div style="padding:12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;color:#16A34A"><i class="fas fa-check-circle"></i> 마감 대상이 없습니다. 모든 인덱스가 진행중입니다.</div>';
      return;
    }

    // 감지 결과 렌더링 + 전체선택/개별선택 체크박스
    let html = `<div style="background:#f2f7ff;border:1px solid #cce0fb;border-radius:10px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="font-weight:700;color:#3182f6;font-size:.9rem"><i class="fas fa-magic"></i> 감지 결과: ${data.totalTabs}개 탭 (${data.totalCampaigns}개 캠페인)</span>
        <button onclick="_archiveExecuteSelected()" style="margin-left:auto;background:#4593fc;color:#fff;border:none;padding:5px 14px;border-radius:6px;font-size:.78rem;cursor:pointer">
          <i class="fas fa-archive"></i> 선택 항목 마감
        </button>
        <button onclick="document.getElementById('archiveDetectWrap').style.display='none'" style="background:#E5E7EB;border:none;padding:5px 12px;border-radius:6px;font-size:.78rem;cursor:pointer">
          닫기
        </button>
      </div>
      <div style="margin-bottom:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <label style="cursor:pointer;font-size:.78rem;color:#6B7280">
          <input type="checkbox" id="archiveSelectAll" onchange="_archiveToggleAll(this.checked)" checked> 전체 선택
        </label>
        <button onclick="_archiveUncheckUnpaid()" style="background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;padding:3px 10px;border-radius:5px;font-size:.72rem;cursor:pointer">
          <i class="fas fa-times-circle"></i> 입금 미완료 체크해제
        </button>
      </div>`;

    data.campaigns.forEach(camp => {
      html += `<div style="margin-bottom:8px;background:#fff;border-radius:8px;padding:8px 12px;border:1px solid #E5E7EB">
        <div style="font-weight:600;font-size:.82rem;color:var(--t1);margin-bottom:4px">${escHtml(camp.campaignName)}</div>`;
      camp.tabs.forEach(t => {
        const reasonLabel = t.reason === 'closed' ? '마감' :
                            t.reason === 'force_done' ? '(구)강제완료' :
                            t.reason === 'fully_completed' ? '리뷰+입금완료' :
                            t.reason === 'auto_complete' ? '자동감지(리뷰+입금)' :
                            t.reason === 'completed' ? '리뷰완료' :
                            t.reason === 'round_closed' ? '차수마감' :
                            t.reason === 'name_completed' ? '(완)탭명' : t.reason;
        const reasonColor = t.reason === 'closed' ? '#EF4444' :
                            t.reason === 'force_done' ? '#F59E0B' :
                            t.reason === 'fully_completed' ? '#0ca678' :
                            t.reason === 'auto_complete' ? '#0ca678' :
                            t.reason === 'round_closed' ? '#3182f6' :
                            t.reason === 'name_completed' ? '#3182f6' : '#12b886';
        const indexBadge = t.inIndex === false
          ? '<span style="background:#FEF3C7;color:#D97706;padding:1px 4px;border-radius:3px;font-size:.65rem;margin-left:2px">인덱스외</span>'
          : '';
        const roundBadge = t.round
          ? `<span style="background:#e8f1fe;color:#3182f6;padding:1px 5px;border-radius:3px;font-size:.65rem;margin-left:2px">${escHtml(t.round)}</span>`
          : '';
        const paidInfo = (t.paidCount !== undefined && t.rowCount)
          ? (t.paidCount >= t.rowCount
            ? `<span style="font-size:.68rem;color:#0ca678;font-weight:600;background:#ECFDF5;padding:1px 5px;border-radius:3px">입금${t.paidCount}/${t.rowCount} ✓</span>`
            : `<span style="font-size:.68rem;color:#DC2626;font-weight:500;background:#FEF2F2;padding:1px 5px;border-radius:3px">입금${t.paidCount}/${t.rowCount}</span>`)
          : '';
        const sheetUrl = _buildTabUrl(`https://docs.google.com/spreadsheets/d/${camp.sheetId}/edit`, camp.sheetId, t.tabGid);
        const sheetLink = t.deleted
          ? `<span title="탭 삭제됨" style="color:#9CA3AF;font-size:.72rem;margin-left:2px"><i class="fas fa-unlink"></i></span>`
          : t.hidden
          ? `<span title="숨김 탭 (클릭하여 표시)" style="color:#9CA3AF;font-size:.72rem;margin-left:2px;cursor:pointer" onclick="event.stopPropagation();_unhideTab('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)"><i class="fas fa-eye-slash"></i></span>`
          : (sheetUrl ? `<a href="${escHtml(sheetUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${t.liveTabName ? '현재: '+escHtml(t.liveTabName) : escHtml(sheetUrl)}" style="color:#4285F4;font-size:.72rem;margin-left:2px;text-decoration:none"><i class="fas fa-external-link-alt"></i></a>` : '');
        const renamedBadge = t.liveTabName
          ? `<span style="background:#DBEAFE;color:#1D4ED8;padding:1px 4px;border-radius:3px;font-size:.62rem;margin-left:2px" title="현재: ${escHtml(t.liveTabName)}">이름변경</span>`
          : '';
        const deletedBadge = t.deleted
          ? `<span style="background:#FEE2E2;color:#DC2626;padding:1px 4px;border-radius:3px;font-size:.62rem;margin-left:2px">삭제됨</span>`
          : '';
        const hiddenBadge = t.hidden
          ? `<span style="background:#F3F4F6;color:#6B7280;padding:1px 4px;border-radius:3px;font-size:.62rem;margin-left:2px">숨김탭</span>`
          : '';
        // ★ 숨김/숨김해제 토글 버튼 (tabGid가 있고 삭제되지 않은 탭만)
        const hideToggleBtn = (!t.deleted && t.tabGid)
          ? (t.hidden
            ? `<button onclick="event.stopPropagation();_unhideTabBtn('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)" title="숨김 해제" style="background:#ECFDF5;border:1px solid #A7F3D0;padding:1px 5px;border-radius:4px;font-size:.66rem;cursor:pointer;color:#0ca678;margin-left:3px;white-space:nowrap"><i class="fas fa-eye"></i> 표시</button>`
            : `<button onclick="event.stopPropagation();_hideTab('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)" title="탭 숨김" style="background:#FEF2F2;border:1px solid #FECACA;padding:1px 5px;border-radius:4px;font-size:.66rem;cursor:pointer;color:#DC2626;margin-left:3px;white-space:nowrap"><i class="fas fa-eye-slash"></i> 숨김</button>`)
          : '';
        const paidComplete = (t.paidCount !== undefined && t.rowCount && t.paidCount >= t.rowCount) ? 'true' : 'false';
        html += `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:.78rem;cursor:pointer">
          <input type="checkbox" class="archive-detect-cb" data-sheet="${escHtml(camp.sheetId)}" data-tab="${escHtml(t.tabName)}" data-round="${escHtml(t.round||'')}" data-in-index="${t.inIndex !== false}" data-paid-complete="${paidComplete}" checked>
          <span style="flex:1">${escHtml(t.tabName)}${sheetLink}${renamedBadge}${deletedBadge}${hiddenBadge}${roundBadge}${indexBadge}</span>
          ${hideToggleBtn}
          ${paidInfo}
          <span style="font-size:.72rem;color:#9CA3AF">${(t.rowCount||0).toLocaleString()}행</span>
          <span style="background:${reasonColor}15;color:${reasonColor};padding:1px 6px;border-radius:4px;font-size:.68rem">${reasonLabel}</span>
        </label>`;
      });
      html += '</div>';
    });

    html += '</div>';
    detectWrap.innerHTML = html;
  } catch (err) {
    detectWrap.innerHTML = '<div style="padding:12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#DC2626">감지 실패: ' + escHtml(err.message) + '</div>';
  }
}

// ── 전체 선택/해제 토글 ──
function _archiveToggleAll(checked) {
  document.querySelectorAll('.archive-detect-cb').forEach(cb => { cb.checked = checked; });
}

// ── 입금 미완료 항목 체크 해제 ──
function _archiveUncheckUnpaid() {
  let count = 0;
  document.querySelectorAll('.archive-detect-cb').forEach(cb => {
    if (cb.dataset.paidComplete !== 'true') {
      cb.checked = false;
      count++;
    }
  });
  if (typeof showToast === 'function') showToast(`입금 미완료 ${count}건 체크 해제됨`, 'info');
}

// ── 선택 항목 마감 실행 ──
async function _archiveExecuteSelected() {
  const checkboxes = document.querySelectorAll('.archive-detect-cb:checked');
  if (checkboxes.length === 0) {
    alert('마감할 항목을 선택해주세요.');
    return;
  }

  const tabs = [];
  checkboxes.forEach(cb => {
    const item = { sheetId: cb.dataset.sheet, tabName: cb.dataset.tab };
    if (cb.dataset.round) item.round = cb.dataset.round;
    tabs.push(item);
  });

  if (!confirm(`${tabs.length}개 탭을 마감합니다.\n\n마감하면 대시보드에서 제외되고 인덱스 빌드에서 스킵됩니다.\n\n계속하시겠습니까?`)) {
    return;
  }

  const detectWrap = document.getElementById('archiveDetectWrap');
  if (detectWrap) {
    detectWrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2)"><i class="fas fa-circle-notch fa-spin"></i> 마감 실행 중...</div>';
  }

  try {
    const data = await gasGet({ action: 'archiveTabs', tabs: tabs, reason: 'auto_detect' });

    if (data.error) {
      alert('마감 실패: ' + data.error);
      if (detectWrap) detectWrap.style.display = 'none';
      return;
    }

    const msg = `마감 완료!\n\n• ${data.archivedTabs || 0}개 탭 처리\n• ${(data.archivedRows || 0).toLocaleString()}개 행 이동`;
    alert(msg);

    if (detectWrap) detectWrap.style.display = 'none';

    // 마감 목록 새로고침
    loadArchiveList();
    // 대시보드 자동 새로고침 (마감된 탭 즉시 제거)
    if (typeof loadAdminDashboard === 'function') loadAdminDashboard();
  } catch (err) {
    alert('마감 실패: ' + err.message);
    if (detectWrap) detectWrap.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ Phase 12: 마감 대상 배지 업데이트 (대시보드에서 호출)
   ══════════════════════════════════════════════════════════════ */

// ── 마감 대상 배지 + 대시보드 알림 배너 ──
async function _updateArchiveBadge() {
  try {
    const data = await gasGet({ action: 'archiveDetect' });
    const badge = document.getElementById('archiveBadge');

    // 전체 탭 수 계산 (campaigns 안의 tabs 합계)
    let totalDetected = 0;
    if (data.campaigns && Array.isArray(data.campaigns)) {
      data.campaigns.forEach(c => { totalDetected += (c.tabs || []).length; });
    }

    // ★ 대시보드 완료감지 버튼 배지 업데이트
    const detectBadge = document.getElementById('archiveDetectBadge');
    if (detectBadge) {
      if (totalDetected > 0) {
        detectBadge.textContent = totalDetected;
        detectBadge.style.display = 'inline';
      } else {
        detectBadge.style.display = 'none';
      }
    }

    if (badge) {
      if (totalDetected > 0) {
        badge.textContent = totalDetected;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }

    if (totalDetected > 0) {
      // 대시보드에 알림 배너 표시 (이미 있으면 업데이트)
      let banner = document.getElementById('archiveAlertBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'archiveAlertBanner';
        banner.style.cssText = 'background:#f2f7ff;border:1px solid #cce0fb;border-radius:10px;padding:10px 16px;margin-bottom:12px;display:flex;align-items:center;gap:10px;cursor:pointer;transition:all .2s';
        banner.onmouseenter = () => { banner.style.background = '#e8f1fe'; };
        banner.onmouseleave = () => { banner.style.background = '#f2f7ff'; };
        banner.onclick = () => { dashboardArchiveDetect(); };
        const wrap = document.getElementById('dashboardWrap');
        if (wrap && wrap.firstChild) {
          wrap.insertBefore(banner, wrap.firstChild);
        }
      }
      banner.innerHTML = `
        <i class="fas fa-archive" style="color:#4593fc;font-size:1.1rem"></i>
        <div style="flex:1">
          <div style="font-weight:600;font-size:.84rem;color:#3182f6">마감 대상 ${totalDetected}건 감지됨</div>
          <div style="font-size:.72rem;color:#6B7280;margin-top:2px">리뷰+입금 완료된 차수가 있습니다. 클릭하여 마감 처리하세요.</div>
        </div>
        <i class="fas fa-chevron-right" style="color:#4593fc;font-size:.8rem"></i>
      `;
    } else {
      if (badge) badge.style.display = 'none';
      const banner = document.getElementById('archiveAlertBanner');
      if (banner) banner.remove();
    }
  } catch (err) {
    console.warn('[archiveBadge] 감지 실패:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ 대시보드 내 완료감지 + 마감 결정 UI
   ══════════════════════════════════════════════════════════════ */
async function dashboardArchiveDetect() {
  const detectWrap = document.getElementById('dashArchiveDetectWrap');
  if (!detectWrap) return;

  detectWrap.style.display = 'block';
  detectWrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2)"><i class="fas fa-circle-notch fa-spin"></i> 완료건 감지 중...</div>';
  detectWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const data = await gasGet({ action: 'archiveDetect' });

    if (data.error) {
      detectWrap.innerHTML = '<div style="padding:12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#DC2626"><i class="fas fa-exclamation-circle"></i> ' + escHtml(data.error) + '</div>';
      return;
    }

    if (!data.campaigns || data.totalTabs === 0) {
      detectWrap.innerHTML = '<div style="padding:12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;color:#16A34A"><i class="fas fa-check-circle"></i> 마감 대상이 없습니다. 모든 인덱스가 진행중입니다.</div>';
      return;
    }

    // 감지 결과 렌더링 + 전체선택/개별선택 체크박스
    let html = `<div style="background:#f2f7ff;border:1px solid #cce0fb;border-radius:10px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <span style="font-weight:700;color:#3182f6;font-size:.9rem"><i class="fas fa-magic"></i> 감지 결과: ${data.totalTabs}개 탭 (${data.totalCampaigns}개 캠페인)</span>
        <button onclick="_dashArchiveExecute()" style="margin-left:auto;background:#4593fc;color:#fff;border:none;padding:6px 16px;border-radius:6px;font-size:.8rem;cursor:pointer;font-weight:600">
          <i class="fas fa-archive"></i> 선택 항목 마감
        </button>
        <button onclick="_dashArchiveSkip()" style="background:#F59E0B;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:.8rem;cursor:pointer">
          <i class="fas fa-forward"></i> 나중에
        </button>
        <button onclick="document.getElementById('dashArchiveDetectWrap').style.display='none'" style="background:#E5E7EB;border:none;padding:6px 12px;border-radius:6px;font-size:.8rem;cursor:pointer">
          닫기
        </button>
      </div>
      <div style="margin-bottom:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <label style="cursor:pointer;font-size:.78rem;color:#6B7280">
          <input type="checkbox" id="dashArchiveSelectAll" onchange="_dashArchiveToggleAll(this.checked)" checked> 전체 선택
        </label>
        <button onclick="_dashArchiveUncheckUnpaid()" style="background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;padding:3px 10px;border-radius:5px;font-size:.72rem;cursor:pointer">
          <i class="fas fa-times-circle"></i> 입금 미완료 체크해제
        </button>
        <span style="font-size:.7rem;color:#9CA3AF">체크 해제 = 마감하지 않음 (나중에 처리)</span>
      </div>`;

    data.campaigns.forEach(camp => {
      html += `<div style="margin-bottom:8px;background:#fff;border-radius:8px;padding:10px 12px;border:1px solid #E5E7EB">
        <div style="font-weight:600;font-size:.82rem;color:var(--t1);margin-bottom:6px"><i class="fas fa-folder" style="color:#6B7280;margin-right:4px"></i>${escHtml(camp.campaignName)}</div>`;
      camp.tabs.forEach(t => {
        const reasonLabel = t.reason === 'closed' ? '마감' :
                            t.reason === 'force_done' ? '(구)강제완료' :
                            t.reason === 'fully_completed' ? '리뷰+입금완료' :
                            t.reason === 'auto_complete' ? '자동감지(리뷰+입금)' :
                            t.reason === 'completed' ? '리뷰완료' :
                            t.reason === 'round_closed' ? '차수마감' :
                            t.reason === 'name_completed' ? '(완)탭명' : t.reason;
        const reasonColor = t.reason === 'closed' ? '#EF4444' :
                            t.reason === 'force_done' ? '#F59E0B' :
                            t.reason === 'fully_completed' ? '#0ca678' :
                            t.reason === 'auto_complete' ? '#0ca678' :
                            t.reason === 'round_closed' ? '#3182f6' :
                            t.reason === 'name_completed' ? '#3182f6' : '#12b886';
        const roundBadge = t.round
          ? `<span style="background:#e8f1fe;color:#3182f6;padding:1px 5px;border-radius:3px;font-size:.65rem;margin-left:2px">${escHtml(t.round)}</span>`
          : '';
        const indexBadge = t.inIndex === false
          ? '<span style="background:#FEF3C7;color:#D97706;padding:1px 4px;border-radius:3px;font-size:.65rem;margin-left:2px">인덱스외</span>'
          : '';
        const paidInfo = (t.paidCount !== undefined && t.rowCount)
          ? (t.paidCount >= t.rowCount
            ? `<span style="font-size:.68rem;color:#0ca678;font-weight:600;background:#ECFDF5;padding:1px 5px;border-radius:3px;margin-left:6px">입금${t.paidCount}/${t.rowCount} ✓</span>`
            : `<span style="font-size:.68rem;color:#DC2626;font-weight:500;background:#FEF2F2;padding:1px 5px;border-radius:3px;margin-left:6px">입금${t.paidCount}/${t.rowCount}</span>`)
          : '';
        const sheetUrl2 = _buildTabUrl(`https://docs.google.com/spreadsheets/d/${camp.sheetId}/edit`, camp.sheetId, t.tabGid);
        const sheetLink2 = t.deleted
          ? `<span title="탭 삭제됨" style="color:#9CA3AF;font-size:.72rem;margin-left:2px"><i class="fas fa-unlink"></i></span>`
          : t.hidden
          ? `<span title="숨김 탭 (클릭하여 표시)" style="color:#9CA3AF;font-size:.72rem;margin-left:2px;cursor:pointer" onclick="event.stopPropagation();_unhideTab('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)"><i class="fas fa-eye-slash"></i></span>`
          : (sheetUrl2 ? `<a href="${escHtml(sheetUrl2)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${t.liveTabName ? '현재: '+escHtml(t.liveTabName) : escHtml(sheetUrl2)}" style="color:#4285F4;font-size:.72rem;margin-left:2px;text-decoration:none"><i class="fas fa-external-link-alt"></i></a>` : '');
        const renamedBadge2 = t.liveTabName
          ? `<span style="background:#DBEAFE;color:#1D4ED8;padding:1px 4px;border-radius:3px;font-size:.62rem;margin-left:2px" title="현재: ${escHtml(t.liveTabName)}">이름변경</span>`
          : '';
        const deletedBadge2 = t.deleted
          ? `<span style="background:#FEE2E2;color:#DC2626;padding:1px 4px;border-radius:3px;font-size:.62rem;margin-left:2px">삭제됨</span>`
          : '';
        const hiddenBadge2 = t.hidden
          ? `<span style="background:#F3F4F6;color:#6B7280;padding:1px 4px;border-radius:3px;font-size:.62rem;margin-left:2px">숨김탭</span>`
          : '';
        // ★ 숨김/숨김해제 토글 버튼 (대시보드 완료감지)
        const hideToggleBtn2 = (!t.deleted && t.tabGid)
          ? (t.hidden
            ? `<button onclick="event.stopPropagation();_unhideTabBtn('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)" title="숨김 해제" style="background:#ECFDF5;border:1px solid #A7F3D0;padding:1px 5px;border-radius:4px;font-size:.66rem;cursor:pointer;color:#0ca678;margin-left:3px;white-space:nowrap"><i class="fas fa-eye"></i> 표시</button>`
            : `<button onclick="event.stopPropagation();_hideTab('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)" title="탭 숨김" style="background:#FEF2F2;border:1px solid #FECACA;padding:1px 5px;border-radius:4px;font-size:.66rem;cursor:pointer;color:#DC2626;margin-left:3px;white-space:nowrap"><i class="fas fa-eye-slash"></i> 숨김</button>`)
          : '';
        const paidComplete2 = (t.paidCount !== undefined && t.rowCount && t.paidCount >= t.rowCount) ? 'true' : 'false';
        html += `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.78rem;cursor:pointer;border-bottom:1px solid #F3F4F6">
          <input type="checkbox" class="dash-archive-cb" data-sheet="${escHtml(camp.sheetId)}" data-tab="${escHtml(t.tabName)}" data-round="${escHtml(t.round||'')}" data-paid-complete="${paidComplete2}" checked>
          <span style="flex:1;display:flex;align-items:center;gap:4px">${escHtml(t.tabName)}${sheetLink2}${renamedBadge2}${deletedBadge2}${hiddenBadge2}${roundBadge}${indexBadge}</span>
          ${hideToggleBtn2}
          ${paidInfo}
          <span style="font-size:.72rem;color:#9CA3AF">${(t.rowCount||0).toLocaleString()}행</span>
          <span style="background:${reasonColor}15;color:${reasonColor};padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:500">${reasonLabel}</span>
        </label>`;
      });
      html += '</div>';
    });

    html += '</div>';
    detectWrap.innerHTML = html;
  } catch (err) {
    detectWrap.innerHTML = '<div style="padding:12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;color:#DC2626">감지 실패: ' + escHtml(err.message) + '</div>';
  }
}

// ── 대시보드 마감: 전체 선택/해제 ──
function _dashArchiveToggleAll(checked) {
  document.querySelectorAll('.dash-archive-cb').forEach(cb => { cb.checked = checked; });
}

// ── 대시보드 마감: 입금 미완료 항목 체크 해제 ──
function _dashArchiveUncheckUnpaid() {
  let count = 0;
  document.querySelectorAll('.dash-archive-cb').forEach(cb => {
    if (cb.dataset.paidComplete !== 'true') {
      cb.checked = false;
      count++;
    }
  });
  if (typeof showToast === 'function') showToast(`입금 미완료 ${count}건 체크 해제됨`, 'info');
}

// ── 대시보드 마감: 나중에 (닫기) ──
function _dashArchiveSkip() {
  const wrap = document.getElementById('dashArchiveDetectWrap');
  if (wrap) wrap.style.display = 'none';
}

// ── 대시보드 마감: 선택 항목 실행 ──
async function _dashArchiveExecute() {
  const checkboxes = document.querySelectorAll('.dash-archive-cb:checked');
  if (checkboxes.length === 0) {
    alert('마감할 항목을 선택해주세요.');
    return;
  }

  const tabs = [];
  checkboxes.forEach(cb => {
    const item = { sheetId: cb.dataset.sheet, tabName: cb.dataset.tab };
    if (cb.dataset.round) item.round = cb.dataset.round;
    tabs.push(item);
  });

  const totalUnchecked = document.querySelectorAll('.dash-archive-cb:not(:checked)').length;
  let confirmMsg = `${tabs.length}개 항목을 마감합니다.`;
  if (totalUnchecked > 0) {
    confirmMsg += `\n\n(${totalUnchecked}개 항목은 선택 해제되어 마감하지 않습니다)`;
  }
  confirmMsg += '\n\n마감하면 대시보드에서 제외되고 인덱스 빌드에서 스킵됩니다.\n계속하시겠습니까?';

  if (!confirm(confirmMsg)) return;

  const detectWrap = document.getElementById('dashArchiveDetectWrap');
  if (detectWrap) {
    detectWrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2)"><i class="fas fa-circle-notch fa-spin"></i> 마감 실행 중...</div>';
  }

  try {
    const data = await gasPost({ action: 'archiveTabs', tabs: tabs, reason: 'dashboard_detect' });

    if (data.error) {
      alert('마감 실패: ' + data.error);
      if (detectWrap) detectWrap.style.display = 'none';
      return;
    }

    const msg = `마감 완료!\n\n• ${data.archivedTabs || 0}개 탭 처리\n• ${(data.archivedRows || 0).toLocaleString()}개 행 이동`;
    alert(msg);

    if (detectWrap) detectWrap.style.display = 'none';

    // 배지 업데이트 + 대시보드 새로고침
    _updateArchiveBadge();
    if (typeof loadTabDashboard === 'function') loadTabDashboard();
  } catch (err) {
    alert('마감 실패: ' + err.message);
    if (detectWrap) detectWrap.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ Phase 14: 키워드 DB 관리 + 인식 실패 탭 진단 UI
   ══════════════════════════════════════════════════════════════ */

// ── 인식 실패 탭 배지 업데이트 (대시보드에서 호출) ──
async function _updateUnrecogBadge() {
  try {
    const data = await gasGet({ action: 'getUnrecognized', status: 'pending' });
    const badge = document.getElementById('unrecogBadge');
    if (!badge) return;
    const count = data.pendingCount || 0;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  } catch (_) {}
}

// ── 인식 실패 탭 목록 로드 ──
/** 회사 공통 사업자번호 불러오기 (설정 탭) */
async function loadCompanyBusinessNo() {
  const input = document.getElementById('companyBusinessNoInput');
  if (!input) return;
  try {
    const data = await gasGet({ action: 'getProviderInfo' });
    if (data && data.ok) input.value = data.companyBusinessNo || '';
  } catch (e) {
    console.warn('[companyBusinessNo] load 실패:', e.message);
  }
}

/** 회사 공통 사업자번호 저장 (설정 탭) */
async function saveCompanyBusinessNo() {
  const input = document.getElementById('companyBusinessNoInput');
  if (!input) return;
  const businessNo = (input.value || '').trim();
  try {
    const data = await gasPost({ action: 'setCompanyBusinessNo', businessNo });
    if (data && data.ok) {
      showToast('✅ 회사 사업자번호가 저장되었습니다.');
    } else {
      showToast('❌ 저장 실패: ' + (data?.error || '알 수 없는 오류'), true);
    }
  } catch (e) {
    showToast('❌ 저장 오류: ' + e.message, true);
  }
}

async function loadUnrecognizedTabs() {
  const wrap = document.getElementById('unrecogListWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:12px;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';

  const status = document.getElementById('unrecogStatusFilter')?.value || '';
  try {
    const data = await gasGet({ action: 'getUnrecognized', status });
    if (data.error) {
      wrap.innerHTML = `<div style="padding:12px;color:#EF4444"><i class="fas fa-exclamation-circle"></i> ${escHtml(data.error)}</div>`;
      return;
    }

    const tabs = data.tabs || [];
    const btnIgnore = document.getElementById('btnIgnoreSelected');

    if (tabs.length === 0) {
      wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--t3)"><i class="fas fa-check-circle" style="color:#12b886"></i> 인식 실패 탭이 없습니다.</div>';
      if (btnIgnore) btnIgnore.style.display = 'none';
      return;
    }

    const hasPending = tabs.some(t => t.status === 'pending');
    if (btnIgnore) btnIgnore.style.display = hasPending ? 'inline-block' : 'none';
    const selectAllWrap = document.getElementById('unrecogSelectAllWrap');
    if (selectAllWrap) selectAllWrap.style.display = hasPending ? 'flex' : 'none';
    const selectAllChk = document.getElementById('unrecogSelectAll');
    if (selectAllChk) selectAllChk.checked = false;

    const reasonLabels = {
      'no_header': '헤더 미발견',
      'no_name_col': '이름 컬럼 없음',
      'no_data': '데이터 미입력',
      'empty': '빈 시트',
      'few_rows': '행 부족',
      'unknown': '알 수 없음',
    };
    const reasonColors = {
      'no_header': '#F59E0B',
      'no_name_col': '#EF4444',
      'no_data': '#4593fc',
      'empty': '#6B7280',
      'few_rows': '#6B7280',
      'unknown': '#6B7280',
    };
    const statusLabels = {
      'pending': '대기',
      'ignored': '무시됨',
      'resolved': '해결됨',
    };
    const statusColors = {
      'pending': '#F59E0B',
      'ignored': '#6B7280',
      'resolved': '#12b886',
    };

    let html = `<div style="font-size:.75rem;color:var(--t3);margin-bottom:8px">총 ${tabs.length}건</div>`;
    tabs.forEach(t => {
      const rl = reasonLabels[t.reason] || t.reason;
      const rc = reasonColors[t.reason] || '#6B7280';
      const sl = statusLabels[t.status] || t.status;
      const sc = statusColors[t.status] || '#6B7280';
      const dateStr = t.detected_at ? new Date(t.detected_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';

      html += `<div style="border:1px solid #E5E7EB;border-radius:8px;padding:8px 12px;margin-bottom:6px;background:#fff" data-unrecog-id="${t.id}">
        <div style="display:flex;align-items:center;gap:6px">
          ${t.status === 'pending' ? `<input type="checkbox" class="unrecog-check" value="${t.id}" style="width:15px;height:15px;flex-shrink:0">` : ''}
          <span style="font-weight:600;color:var(--t1);font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%">${escHtml(t.tab_name)}</span>
          <span style="font-size:.68rem;background:${rc}22;color:${rc};padding:1px 6px;border-radius:5px;font-weight:600;flex-shrink:0">${rl}</span>
          <span style="font-size:.68rem;background:${sc}22;color:${sc};padding:1px 6px;border-radius:5px;font-weight:600;flex-shrink:0">${sl}</span>
          <span style="font-size:.72rem;color:var(--t3);margin-left:auto;flex-shrink:0">${dateStr}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:3px;padding-left:${t.status === 'pending' ? '23px' : '0'}">
          <span style="font-size:.72rem;color:var(--t3)"><i class="fas fa-file-alt" style="margin-right:3px"></i>${escHtml(t.campaign_name || '미분류')}</span>
          ${t.sheet_id ? `<a href="https://docs.google.com/spreadsheets/d/${t.sheet_id}/edit${t.tab_gid ? '#gid=' + t.tab_gid : ''}" target="_blank" rel="noopener" style="font-size:.7rem;color:#3B82F6;text-decoration:none;flex-shrink:0" title="구글시트에서 열기"><i class="fas fa-external-link-alt"></i> 시트</a>` : ''}
          ${t.sample_rows ? `<details style="display:inline"><summary style="font-size:.7rem;color:#4593fc;cursor:pointer;display:inline">샘플 데이터 보기</summary><div style="max-height:200px;overflow:auto;margin-top:6px;font-size:.68rem;background:#F9FAFB;border-radius:6px;padding:8px"><table style="border-collapse:collapse;width:100%">${_buildUnrecogSampleTable(t.sample_rows)}</table></div></details>` : ''}
        </div>
      </div>`;
    });

    wrap.innerHTML = html;

    // 배지 업데이트
    _updateUnrecogBadge();
  } catch (err) {
    wrap.innerHTML = `<div style="padding:12px;color:#EF4444"><i class="fas fa-exclamation-circle"></i> ${escHtml(err.message)}</div>`;
  }
}

/* ══════════════════════════════════════════════════════════════
   오류디버깅(Error Debugging) — error_logs (마이그레이션 026/028)
   수집 → 오류검증 → 다중에이전트 분석 → 결정자 → 이행요청 → 수정 → 재검증
   ══════════════════════════════════════════════════════════════ */
const ERRLOG_CAT_LABELS = {
  timeout: '로딩시간 초과', quota: '호출한도 초과', network: '네트워크', auth: '인증',
  permission: '권한', validation: '입력검증', db: 'DB', external_api: '외부 API',
  not_found: '대상 없음', unknown: '알 수 없음',
};
const ERRLOG_CAT_COLORS = {
  timeout: '#F59E0B', quota: '#EF4444', network: '#3B82F6', auth: '#4593fc',
  permission: '#4593fc', validation: '#6B7280', db: '#DC2626', external_api: '#0EA5E9',
  not_found: '#6B7280', unknown: '#6B7280',
};
const ERRLOG_SEV_LABELS = { warn: '경고', error: '에러', critical: '치명' };
const ERRLOG_SEV_COLORS = { warn: '#F59E0B', error: '#EF4444', critical: '#7F1D1D' };

// 오류 상태(문서 5장)
const ERRLOG_STATUS_LABELS = { new: '신규', investigating: '확인중', resolved: '해결', ignored: '무시' };
const ERRLOG_STATUS_COLORS = { new: '#EF4444', investigating: '#F59E0B', resolved: '#10B981', ignored: '#6B7280' };
// 오류검증 판정값(문서 8장)
const ERRLOG_VERIFY_LABELS = {
  not_checked: '검증 미확정', likely_reproducible: '재현 가능성 높음', reproduced: '재현됨',
  not_reproduced_static: '정적 미재현', likely_resolved_by_other_change: '타 변경으로 해결 후보', blocked: '자동재현 차단',
};
// 결정자 판정값(문서 9.6장)
const ERRLOG_DECIDER_LABELS = {
  implement: '바로 수정 가능', implement_after_preflight: '사전 확인 후 수정', needs_more_context: '추가 정보 필요', ignore: '수정 불필요',
};
// 상태 설명(우측 패널 상태 변경 드롭다운 보조 문구)
const ERRLOG_STATUS_DESC = {
  new: '새로 수집되어 아직 처리 전인 오류입니다.',
  investigating: '확인 또는 수정이 진행 중인 오류입니다.',
  resolved: '해결 완료된 오류입니다.',
  ignored: '처리하지 않기로 한 오류입니다.',
};
// 다중 에이전트 진행도 스테퍼(문서 9장 6역할)
const ERR_AGENTS = [
  { icon: 'fa-vial',          name: '오류검증', desc: '수정 필요성 점검' },
  { icon: 'fa-bug',           name: '레드팀',   desc: '오류 상황 제시' },
  { icon: 'fa-shield-alt',    name: '블루팀',   desc: '방어 코드 제시' },
  { icon: 'fa-balance-scale', name: '감독관',   desc: '최적안 검토' },
  { icon: 'fa-hand-paper',    name: '예방가드', desc: '새 오류 예방 점검' },
  { icon: 'fa-gavel',         name: '결정자',   desc: '구현 판단' },
];
let _errDetailCache = null;   // 현재 우측 패널에 로드된 { log, analysis, transfer_blockers, transfer_allowed }
let _errSelectedId = null;    // 목록에서 선택된 오류 id (카드 하이라이트용)
let _errAnimTimer = null;     // 분석중 진행도 애니메이션 타이머

function _errLogRelTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function _setErrorLogBadge(count) {
  const badge = document.getElementById('errorLogBadge');
  if (!badge) return;
  if (count > 0) { badge.textContent = count > 99 ? '99+' : count; badge.style.display = 'inline'; }
  else { badge.style.display = 'none'; }
}

async function _updateErrorLogBadge() {
  try {
    const data = await gasGet({ action: 'getErrorLogs', status: 'open', limit: 1 });
    _setErrorLogBadge((data && data.summary && data.summary.openCount) || 0);
  } catch (_) {}
}

// ── 이상로그 목록 로드 ──
async function loadErrorLogs() {
  const wrap = document.getElementById('errorLogListWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:12px;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';

  // 상태 필터(신규/확인중/해결/무시/전체). 구버전 DOM(errLogResolvedFilter)도 폴백 지원.
  const status = document.getElementById('errLogStatusFilter')?.value
    || document.getElementById('errLogResolvedFilter')?.value || 'open';
  const category = document.getElementById('errLogCategoryFilter')?.value || '';
  const source = document.getElementById('errLogSourceFilter')?.value || '';
  try {
    const data = await gasGet({ action: 'getErrorLogs', status, category, source });
    if (data.error) {
      wrap.innerHTML = `<div style="padding:12px;color:#EF4444"><i class="fas fa-exclamation-circle"></i> ${escHtml(data.error)}</div>`;
      return;
    }

    const logs = data.logs || [];
    const sum = data.summary || {};
    _setErrorLogBadge(sum.openCount || 0);
    const sumEl = document.getElementById('errLogSummary');
    if (sumEl) {
      const bs = sum.byStatus || {};
      sumEl.textContent = `미해결 ${sum.openCount || 0}건 (신규 ${bs.new || 0} · 확인중 ${bs.investigating || 0})`;
    }

    if (logs.length === 0) {
      wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--t3)"><i class="fas fa-check-circle" style="color:#10B981"></i> 표시할 오류가 없습니다.</div>';
      return;
    }

    let html = `<div style="font-size:.75rem;color:var(--t3);margin-bottom:8px">총 ${data.total}건</div>`;
    logs.forEach(l => {
      const cl = ERRLOG_CAT_LABELS[l.category] || l.category;
      const cc = ERRLOG_CAT_COLORS[l.category] || '#6B7280';
      const sl = ERRLOG_SEV_LABELS[l.severity] || l.severity;
      const sc = ERRLOG_SEV_COLORS[l.severity] || '#6B7280';
      const st = l.status || (l.resolved ? 'resolved' : 'new');
      const stl = ERRLOG_STATUS_LABELS[st] || st;
      const stc = ERRLOG_STATUS_COLORS[st] || '#6B7280';
      const occ = l.occurrence_count > 1 ? `<span style="font-size:.7rem;background:#FEE2E2;color:#B91C1C;padding:1px 6px;border-radius:5px;font-weight:700;flex-shrink:0">×${l.occurrence_count}</span>` : '';
      const rel = _errLogRelTime(l.last_seen_at);
      const analyzed = l.has_analysis
        ? `<span style="font-size:.66rem;background:#EDE9FE;color:#6D28D9;padding:1px 6px;border-radius:5px;font-weight:600;flex-shrink:0"><i class="fas fa-robot"></i> 분석됨${l.decider_verdict ? ' · ' + (ERRLOG_DECIDER_LABELS[l.decider_verdict] || l.decider_verdict) : ''}</span>`
        : '';
      const closed = (st === 'resolved' || st === 'ignored');

      const sel = (_errSelectedId === l.id);
      html += `<div id="errcard-${l.id}" onclick="openErrDetail(${l.id})" style="border:1px solid ${sel ? '#6D28D9' : '#E5E7EB'};border-radius:8px;padding:10px 12px;margin-bottom:6px;background:#fff;cursor:pointer;box-shadow:${sel ? '0 0 0 2px #6D28D9' : 'none'}${closed ? ';opacity:.65' : ''}">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:.68rem;background:${stc};color:#fff;padding:1px 7px;border-radius:5px;font-weight:700;flex-shrink:0">${stl}</span>
          <span style="font-size:.68rem;background:${sc}22;color:${sc};padding:1px 6px;border-radius:5px;font-weight:700;flex-shrink:0">${sl}</span>
          <span style="font-size:.68rem;background:${cc}22;color:${cc};padding:1px 6px;border-radius:5px;font-weight:600;flex-shrink:0">${cl}</span>
          ${occ}${analyzed}
          <span style="font-size:.72rem;color:var(--t3);margin-left:auto;flex-shrink:0">${rel}</span>
        </div>
        <div style="font-size:.9rem;font-weight:600;color:var(--t1);margin-top:6px;line-height:1.45">${escHtml(l.message_ko)}</div>
        <div style="margin-top:8px;font-size:.72rem;color:#1D4ED8"><i class="fas fa-search-plus"></i> 상세 · 오류검증 및 분석</div>
      </div>`;
    });

    wrap.innerHTML = html;
  } catch (err) {
    wrap.innerHTML = `<div style="padding:12px;color:#EF4444"><i class="fas fa-exclamation-circle"></i> ${escHtml(err.message)}</div>`;
  }
}

// ── 구버전 호환: 빠른 해결 처리 ──
async function resolveErrorLog(id) {
  if (!confirm('이 오류를 해결 처리할까요?\n(같은 유형이 다시 발생하면 새 항목으로 기록됩니다)')) return;
  try {
    const data = await gasPost({ action: 'errorLogStatus', id, status: 'resolved' });
    if (data.error) { alert(data.error); return; }
    loadErrorLogs();
  } catch (err) {
    alert('해결 처리 실패: ' + err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// 오류 상세 — 우측 패널(모달 아님) · 검증/분석/이행요청/상태관리
// 인트라넷 오류디버깅 UI 참고: 좌측 목록 + 우측 상세 패널, 분석중 진행도 실시간 표시
// ══════════════════════════════════════════════════════════════
function _errPanelPlaceholder() {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:240px;color:var(--t3);text-align:center;padding:24px">
    <i class="fas fa-clipboard-list" style="font-size:1.8rem;margin-bottom:10px;color:#CBD5E1"></i>
    <div style="font-size:.82rem">왼쪽 목록에서 오류를 선택하면<br>여기에 <b>상세 · 디버깅</b>이 표시됩니다.</div>
  </div>`;
}
function closeErrDetail() {
  _stopErrAnim();
  _errDetailCache = null; _errSelectedId = null;
  _highlightErrCard(null);
  const body = document.getElementById('errDetailBody');
  if (body) body.innerHTML = _errPanelPlaceholder();
}

// 목록 카드 선택 하이라이트
function _highlightErrCard(id) {
  document.querySelectorAll('[id^="errcard-"]').forEach(el => {
    const on = el.id === 'errcard-' + id;
    el.style.boxShadow = on ? '0 0 0 2px #6D28D9' : 'none';
    el.style.borderColor = on ? '#6D28D9' : '#E5E7EB';
  });
}

async function openErrDetail(id) {
  _stopErrAnim();
  const body = document.getElementById('errDetailBody');
  if (!body) return;
  _errSelectedId = id;
  _highlightErrCard(id);
  body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';
  try {
    const data = await gasGet({ action: 'errorLogDetail', id });
    if (data.error) { body.innerHTML = `<div style="padding:12px;color:#EF4444">${escHtml(data.error)}</div>`; return; }
    _errDetailCache = data;
    _renderErrDetail();
  } catch (err) {
    body.innerHTML = `<div style="padding:12px;color:#EF4444">${escHtml(err.message)}</div>`;
  }
}

function _errChip(text, bg, fg, solid) {
  return `<span style="font-size:.68rem;background:${solid ? bg : bg + '22'};color:${solid ? '#fff' : fg};padding:2px 8px;border-radius:6px;font-weight:700">${escHtml(text)}</span>`;
}
function _errRow(k, v) {
  if (v == null || v === '') return '';
  return `<div style="display:flex;gap:8px;padding:3px 0"><div style="min-width:84px;color:var(--t3);flex-shrink:0">${escHtml(k)}</div><div style="color:var(--t1);word-break:break-all">${escHtml(String(v))}</div></div>`;
}
// 색상 헤더가 붙은 에이전트 섹션 카드
function _errSection(icon, title, color, rows, extra) {
  const inner = Object.entries(rows || {}).filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `<div style="padding:2px 0;font-size:.76rem"><b style="color:var(--t2)">${escHtml(k)}</b> · <span style="color:var(--t1)">${escHtml(String(v))}</span></div>`).join('');
  if (!inner && !extra) return '';
  return `<div style="border:1px solid #EEF0F3;border-radius:10px;padding:10px 12px;margin-top:8px;background:#fff">
    <div style="font-weight:700;color:${color};margin-bottom:5px;font-size:.8rem"><i class="fas ${icon}"></i> ${escHtml(title)}</div>
    ${inner}${extra || ''}</div>`;
}
function _errList(title, arr, color) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const items = arr.map(x => `<li style="margin:2px 0">${escHtml(String(x))}</li>`).join('');
  return `<div style="margin-top:6px"><b style="color:${color || 'var(--t2)'};font-size:.74rem">${escHtml(title)}</b><ul style="margin:2px 0 0;padding-left:18px;color:var(--t1);font-size:.76rem">${items}</ul></div>`;
}

// ── 에이전트 진행도 스테퍼 ──
// mode: 'done'(전부 완료) | 'analyzing'(active 단계 진행중) | 'pending'(분석 전)
// 진행도 애니메이션용 스타일(1회 주입): 가로바 줄무늬 모션 + 활성 원 펄스
function _ensureErrStyles() {
  if (document.getElementById('errDbgStyles')) return;
  const s = document.createElement('style');
  s.id = 'errDbgStyles';
  s.textContent =
    '@keyframes errBarStripes{from{background-position:0 0}to{background-position:34px 0}}' +
    '.errbar-fill{background-color:#7C3AED;background-image:linear-gradient(135deg,rgba(255,255,255,.35) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.35) 50%,rgba(255,255,255,.35) 75%,transparent 75%,transparent);background-size:34px 34px;animation:errBarStripes .7s linear infinite;transition:width .55s ease}' +
    '@keyframes errPulse{0%,100%{box-shadow:0 0 0 3px #FDE68A}50%{box-shadow:0 0 0 6px #FCD34D}}' +
    '.errcircle-active{animation:errPulse 1s ease-in-out infinite}';
  document.head.appendChild(s);
}

// 6단계 원형(스테퍼) — 부분 갱신에도 재사용 (카드 래퍼 없이 원형 row 만 반환)
function _errStepperCircles(mode, activeStep) {
  return ERR_AGENTS.map((ag, i) => {
    const n = i + 1;
    let state;
    if (mode === 'done' || (mode === 'analyzing' && n < activeStep)) state = 'done';
    else if (mode === 'analyzing' && n === activeStep) state = 'active';
    else state = 'pending';
    const bg = state === 'done' ? '#10B981' : state === 'active' ? '#F59E0B' : '#E5E7EB';
    const fg = state === 'pending' ? '#9CA3AF' : '#fff';
    const ic = state === 'done' ? '<i class="fas fa-check"></i>'
      : state === 'active' ? '<i class="fas fa-circle-notch fa-spin"></i>'
      : `<i class="fas ${ag.icon}"></i>`;
    const stTxt = state === 'done' ? '완료' : state === 'active' ? '분석중' : '대기';
    const stCol = state === 'done' ? '#059669' : state === 'active' ? '#D97706' : 'var(--t3)';
    return `<div style="flex:1;text-align:center;min-width:0">
      <div class="${state === 'active' ? 'errcircle-active' : ''}" style="width:30px;height:30px;border-radius:50%;background:${bg};color:${fg};display:inline-flex;align-items:center;justify-content:center;font-size:.72rem">${ic}</div>
      <div style="font-size:.62rem;font-weight:700;color:var(--t1);margin-top:3px">${ag.name}</div>
      <div style="font-size:.58rem;color:${stCol};font-weight:600">${stTxt}</div>
      <div style="font-size:.54rem;color:var(--t3);line-height:1.2">${ag.desc}</div>
    </div>`;
  }).join('<div style="align-self:flex-start;margin-top:11px;color:#D1D5DB;flex:0 0 auto"><i class="fas fa-chevron-right" style="font-size:.55rem"></i></div>');
}

function _errAgentStepper(mode, activeStep) {
  const total = ERR_AGENTS.length;
  const headBadge = mode === 'done'
    ? '<span style="font-size:.66rem;color:#fff;background:#10B981;padding:2px 8px;border-radius:6px;font-weight:700">분석 완료</span>'
    : mode === 'analyzing'
      ? '<span style="font-size:.66rem;color:#fff;background:#F59E0B;padding:2px 8px;border-radius:6px;font-weight:700"><i class="fas fa-circle-notch fa-spin"></i> 분석 중</span>'
      : '<span style="font-size:.66rem;color:#6B7280;background:#F3F4F6;padding:2px 8px;border-radius:6px;font-weight:700">분석 전</span>';
  const doneN = mode === 'done' ? total : (mode === 'analyzing' ? Math.min(activeStep, total) : 0);

  return `<div style="border:1px solid #EEF0F3;border-radius:12px;padding:12px;background:#FBFCFE;margin-top:10px">
    <div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">
      <b style="font-size:.82rem;color:var(--t1)"><i class="fas fa-diagram-project"></i> 에이전트 진행도</b>
      ${headBadge}
      <span style="margin-left:auto;font-size:.7rem;color:var(--t3)">${doneN}/${total} 단계</span>
    </div>
    <div style="display:flex;align-items:flex-start;gap:1px">${_errStepperCircles(mode, activeStep)}</div>
  </div>`;
}

// 상태 변경 드롭다운 + 설명
function _errStatusSelect(id, st) {
  const opts = ['new', 'investigating', 'resolved', 'ignored']
    .map(s => `<option value="${s}" ${s === st ? 'selected' : ''}>${ERRLOG_STATUS_LABELS[s]}</option>`).join('');
  return `<div style="margin-top:10px">
    <div style="font-size:.72rem;color:var(--t3);margin-bottom:3px">상태 변경</div>
    <select onchange="changeErrStatus(${id}, this.value)" style="width:100%;padding:6px 9px;border:1px solid #D1D5DB;border-radius:8px;font-size:.82rem">${opts}</select>
    <div style="font-size:.7rem;color:var(--t3);margin-top:4px">${escHtml(ERRLOG_STATUS_DESC[st] || '')}</div>
  </div>`;
}

// 패널 상단(공통): 칩 + 요약 + 액션버튼 + 상태드롭다운
function _errDetailHead(l, st, opts) {
  opts = opts || {};
  const blockers = (_errDetailCache && _errDetailCache.transfer_blockers) || [];
  const allowed = !!(_errDetailCache && _errDetailCache.transfer_allowed);
  const btn = (label, onclick, color, disabled, title) =>
    `<button onclick="${onclick}" ${disabled ? 'disabled' : ''} title="${escHtml(title || '')}"
      style="font-size:.74rem;border:none;border-radius:7px;padding:6px 11px;cursor:${disabled ? 'not-allowed' : 'pointer'};font-weight:600;color:#fff;background:${disabled ? '#9CA3AF' : color}">${label}</button>`;
  const head = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">
    ${_errChip(ERRLOG_STATUS_LABELS[st] || st, ERRLOG_STATUS_COLORS[st] || '#6B7280', '#fff', true)}
    ${_errChip(ERRLOG_SEV_LABELS[l.severity] || l.severity, ERRLOG_SEV_COLORS[l.severity] || '#6B7280', ERRLOG_SEV_COLORS[l.severity] || '#6B7280')}
    ${_errChip(ERRLOG_CAT_LABELS[l.category] || l.category, ERRLOG_CAT_COLORS[l.category] || '#6B7280', ERRLOG_CAT_COLORS[l.category] || '#6B7280')}
    ${l.occurrence_count > 1 ? _errChip('×' + l.occurrence_count, '#B91C1C', '#B91C1C') : ''}
    <span style="margin-left:auto;font-size:.7rem;color:var(--t3)">#${l.id}</span>
  </div>`;
  const summary = `<div style="font-size:.92rem;font-weight:700;color:var(--t1);line-height:1.5;margin-bottom:10px">${escHtml(l.message_ko)}</div>`;
  const analyzeBtn = opts.analyzing
    ? `<button disabled style="font-size:.74rem;border:none;border-radius:7px;padding:6px 11px;font-weight:600;color:#fff;background:#9CA3AF;cursor:wait"><i class="fas fa-circle-notch fa-spin"></i> 분석 중...</button>`
    : btn('<i class="fas fa-robot"></i> 오류검증 및 분석', `analyzeError(${l.id})`, '#6D28D9', false, '비파괴 검증 + 다중 에이전트 분석(실제 수정 안 함)');
  const actions = `<div style="display:flex;gap:6px;flex-wrap:wrap">
    ${btn('<i class="fas fa-copy"></i> 오류내용 복사', `copyErrorContent(${l.id})`, '#2563EB', false, '공유용 진단 정보 복사(상태 변경 없음)')}
    ${btn('<i class="fas fa-paper-plane"></i> 이행 요청 복사', `copyTransferRequest(${l.id})`, '#0EA5E9', !allowed, allowed ? '실제 수정 요청문 복사' : '게이트 미통과: ' + (blockers || []).join(' / '))}
    ${analyzeBtn}
  </div>`;
  return head + summary + actions + _errStatusSelect(l.id, st);
}

// 패널 하단(공통): 메타 정보 + 메시지 + API/화면 + Stack
function _errMetaBlock(l) {
  const ctx = l.context || {};
  const user = ctx.userId || ctx.userName || ctx.user || (l.resolved_by) || '-';
  return `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #EEF0F3;font-size:.78rem">
    ${_errRow('사용자', user)}
    ${_errRow('수집원', l.source)}
    ${_errRow('범주', ERRLOG_CAT_LABELS[l.category] || l.category)}
    ${_errRow('발생 횟수', l.occurrence_count)}
    ${_errRow('첫 발생', (l.first_seen_at || '').replace('T', ' ').slice(0, 19))}
    ${_errRow('마지막 발생', (l.last_seen_at || '').replace('T', ' ').slice(0, 19))}
    ${_errRow('오류 코드', l.error_code)}
    <div style="margin-top:6px"><div style="font-size:.72rem;color:var(--t3);margin-bottom:3px">메시지</div>
      <div style="background:#111827;color:#F9FAFB;border-radius:8px;padding:8px 10px;font-size:.72rem;word-break:break-all;white-space:pre-wrap">${escHtml(l.message_raw || '-')}</div></div>
    ${_errRow('API / 화면', [ctx.method, ctx.path].filter(Boolean).join(' ') || (l.flow_ko + (l.step_ko ? ' · ' + l.step_ko : '')))}
    ${l.stack ? `<div style="margin-top:6px"><div style="font-size:.72rem;color:var(--t3);margin-bottom:3px">Stack</div>
      <div style="background:#F9FAFB;border:1px solid #EEF0F3;border-radius:8px;padding:8px 10px;font-size:.68rem;color:var(--t2);word-break:break-all;white-space:pre-wrap;max-height:200px;overflow:auto">${escHtml(l.stack)}</div></div>` : ''}
  </div>`;
}

// AI 분석 결과 블록(에이전트 6역할 + 게이트)
function _errAnalysisBlock(l, a, blockers, allowed) {
  const v = a.verify || {}, rt = a.red_team || {}, bt = a.blue_team || {}, sv = a.supervisor || {}, pg = a.prevention_guard || {};
  const cause = rt.conditions || v.evidence || '';
  const fixDir = sv.narrowest_fix || bt.exception_handling || '';
  const impact = rt.user_impact || rt.data_risk || '';
  const when = (a.generated_at || '').replace('T', ' ').slice(0, 19);
  const srcBadge = a.generated_by === 'fallback'
    ? '<span style="font-size:.66rem;color:#92400E;background:#FEF3C7;padding:1px 7px;border-radius:5px;font-weight:700">규칙기반</span>'
    : '<span style="font-size:.66rem;color:#5B21B6;background:#EDE9FE;padding:1px 7px;border-radius:5px;font-weight:700">AI</span>';

  // 오류검증·수정 필요성 판단
  const verifyVerdict = v.verdict || l.verify_verdict;
  const reproBlocked = verifyVerdict === 'blocked';
  const safety = a.safety || {};
  const verifyBadge = reproBlocked
    ? '<span style="font-size:.66rem;color:#92400E;background:#FEF3C7;padding:1px 7px;border-radius:5px;font-weight:700">자동 재현 차단</span>' : '';
  const verifyExtra = (reproBlocked && Array.isArray(safety.reasons) && safety.reasons.length)
    ? _errList('자동 재현 차단', safety.reasons, '#B91C1C') : '';

  const gate = (blockers && blockers.length)
    ? `<div style="margin-top:8px;border:1px solid #FCD34D;background:#FFFBEB;border-radius:8px;padding:8px 10px;font-size:.74rem;color:#92400E">
        <b><i class="fas fa-lock"></i> 이행 요청 복사 차단 사유</b>
        <ul style="margin:4px 0 0;padding-left:18px">${blockers.map(b => `<li>${escHtml(b)}</li>`).join('')}</ul></div>`
    : `<div style="margin-top:8px;font-size:.74rem;color:#047857"><i class="fas fa-unlock"></i> 이행 요청 복사 가능 (모든 게이트 통과)</div>`;

  return `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #EEF0F3">
    <div style="display:flex;align-items:center;gap:7px">
      <b style="font-size:.84rem;color:var(--t1)"><i class="fas fa-robot" style="color:#6D28D9"></i> AI 분석</b>
      ${srcBadge}${when ? `<span style="margin-left:auto;font-size:.68rem;color:var(--t3)">${when}</span>` : ''}
    </div>
    ${a.summary_ko ? `<div style="margin-top:7px;font-size:.84rem;font-weight:600;color:var(--t1);line-height:1.5">${escHtml(a.summary_ko)}</div>` : ''}
    <div style="margin-top:7px;font-size:.78rem">
      ${cause ? `<div style="padding:3px 0"><b style="color:#B91C1C">발생 원인</b> · <span style="color:var(--t1)">${escHtml(cause)}</span></div>` : ''}
      ${fixDir ? `<div style="padding:3px 0"><b style="color:#1D4ED8">수정 방향</b> · <span style="color:var(--t1)">${escHtml(fixDir)}</span></div>` : ''}
      ${impact ? `<div style="padding:3px 0"><b style="color:#92400E">영향</b> · <span style="color:var(--t1)">${escHtml(impact)}</span></div>` : ''}
    </div>

    ${_errAgentStepper('done')}

    ${_errSection('fa-stethoscope', '오류검증 · 수정 필요성 판단', '#0E7490', {
      '검증 판정': ERRLOG_VERIFY_LABELS[verifyVerdict] || verifyVerdict,
      '검증 근거': v.evidence, '다음 처리': v.next_action, '잔여 위험': a.residual_risk,
    }, verifyBadge ? `<div style="margin:4px 0">${verifyBadge}</div>${verifyExtra}` : verifyExtra)}

    ${_errSection('fa-flag', '레드팀 · 오류 상황 제시', '#DC2626', {
      '발생 조건': rt.conditions, '사용자 피해': rt.user_impact, '데이터/상태 위험': rt.data_risk, '재발 조건': rt.recurrence,
    })}

    ${_errSection('fa-shield-halved', '블루팀 · 방어 코드 제시', '#2563EB', {
      '입력검증': bt.input_validation, '예외처리': bt.exception_handling, '상태전이 방어': bt.state_guard,
      '중복실행 방지': bt.idempotency, '외부 API 실패': bt.external_api, '회귀 테스트': bt.regression_tests,
    })}

    ${_errSection('fa-scale-balanced', '감독관 · 최적안 검토', '#7C3AED', {
      '원인분석 과한지': sv.overreach, '수정 범위': sv.scope, '증상 vs 원인': sv.symptom_vs_cause,
      '정상흐름 영향': sv.side_effects, '가장 좁은 해결책': sv.narrowest_fix,
    })}

    ${_errSection('fa-hand', '예방가드 · 새 오류 사전 차단', '#B45309', {
      '안전 구현 가능': pg.safe_to_implement === false ? '불가 또는 확인 필요' : '가능',
      '영향 화면': pg.affected_screens, '영향 API': pg.affected_apis, '데이터 흐름': pg.data_flows,
      '외부 연동 영향': pg.external_impact, '새 위험': pg.new_risks,
    }, _errList('구현 전 차단 조건', pg.blockers, '#B91C1C') + _errList('필수 검증', pg.must_verify, '#047857'))}

    ${_errSection('fa-gavel', '결정자 · 구현 판단', '#047857', {
      '판정': ERRLOG_DECIDER_LABELS[(a.decider || {}).verdict] || (a.decider || {}).verdict,
      '근거': (a.decider || {}).reason,
    }, _errList('사전 확인 항목', a.preflight, '#92400E') + (a.go_no_go ? `<div style="margin-top:4px;font-size:.76rem"><b style="color:var(--t2)">진행/중단 기준</b> · ${escHtml(a.go_no_go)}</div>` : ''))}

    ${_errSection('fa-clipboard-check', '전달 사항', '#374151', {
      '수정 범위': a.fix_scope, '테스트 계획': a.test_plan, '잔여 위험': a.residual_risk,
    })}

    ${gate}
  </div>`;
}

function _renderErrDetail() {
  const body = document.getElementById('errDetailBody');
  if (!body || !_errDetailCache) return;
  const { log: l, analysis: a, transfer_blockers: blockers, transfer_allowed: allowed } = _errDetailCache;
  const st = l.status || (l.resolved ? 'resolved' : 'new');

  let mid;
  if (a) {
    mid = _errAnalysisBlock(l, a, blockers, allowed);
  } else {
    mid = _errAgentStepper('pending')
      + `<div style="margin-top:10px;font-size:.78rem;color:var(--t3);text-align:center;padding:10px;background:#F9FAFB;border-radius:8px"><i class="fas fa-robot"></i> 아직 분석 전입니다. <b>"오류검증 및 분석"</b>을 실행하면 위 6단계가 진행됩니다.<br>(비파괴 — 실제 수정/재현 안 함)</div>`;
  }

  body.innerHTML = _errDetailHead(l, st, {}) + mid + _errMetaBlock(l);
}

// ── 분석중 진행도 애니메이션 (실시간 표시) ──
// 백엔드는 단발 호출이라 단계별 실제 진행을 주지 않으므로, 클라이언트가 6단계를
// 순차 점등(낙관적 진행)하고 응답 도착 시 실제 결과로 교체한다.
function _stopErrAnim() { if (_errAnimTimer) { clearTimeout(_errAnimTimer); _errAnimTimer = null; } }

// 분석중 패널을 "한 번만" 렌더(가로 진행바 + 스테퍼). 이후엔 부분 갱신만 해서 깜빡임을 없앤다.
function _renderAnalyzingPanel(id) {
  const body = document.getElementById('errDetailBody');
  if (!body || !_errDetailCache || _errDetailCache.log.id !== id) return;
  _ensureErrStyles();
  const l = _errDetailCache.log;
  const st = l.status || (l.resolved ? 'resolved' : 'new');
  const total = ERR_AGENTS.length;
  body.innerHTML = _errDetailHead(l, st, { analyzing: true })
    + `<div style="margin-top:10px;border:1px solid #EEF0F3;border-radius:12px;padding:12px;background:#FBFCFE">
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">
          <b style="font-size:.82rem;color:var(--t1)"><i class="fas fa-diagram-project"></i> 에이전트 진행도</b>
          <span style="font-size:.66rem;color:#fff;background:#F59E0B;padding:2px 8px;border-radius:6px;font-weight:700"><i class="fas fa-circle-notch fa-spin"></i> 분석 중</span>
          <span id="errProgStep" style="margin-left:auto;font-size:.7rem;color:var(--t3)">0/${total} 단계</span>
        </div>
        <!-- ★ 가로 진행 바 (줄무늬가 계속 흘러 동작중임을 명확히 표시) -->
        <div style="background:#EDE9FE;border-radius:999px;height:14px;overflow:hidden">
          <div id="errProgFill" class="errbar-fill" style="width:4%;height:100%;border-radius:999px"></div>
        </div>
        <div id="errProgLabel" style="font-size:.74rem;color:#6D28D9;margin-top:6px;font-weight:600"><i class="fas fa-circle-notch fa-spin"></i> 분석 준비 중...</div>
        <div id="errStepperRow" style="display:flex;align-items:flex-start;gap:1px;margin-top:11px">${_errStepperCircles('analyzing', 1)}</div>
        <div style="font-size:.7rem;color:var(--t3);margin-top:8px">비파괴 검증 + 다중 에이전트 분석 중 (실제 코드/운영을 변경하지 않습니다)</div>
      </div>`
    + _errMetaBlock(l);
  _updateErrAnim(1);
}

// 진행바 너비 / 라벨 / 스테퍼 원형만 제자리 갱신 (패널 전체를 다시 그리지 않음 → 깜빡임 없음)
function _updateErrAnim(step) {
  const total = ERR_AGENTS.length;
  const ag = ERR_AGENTS[Math.min(step, total) - 1] || ERR_AGENTS[0];
  const pct = Math.min(94, Math.round((step / total) * 100)); // 완료(100%)는 결과 도착 시에만
  const fill = document.getElementById('errProgFill');
  if (fill) fill.style.width = pct + '%';
  const lbl = document.getElementById('errProgLabel');
  if (lbl) lbl.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> 분석 중 · <b>${ag.name}</b> — ${ag.desc} (${Math.min(step, total)}/${total})`;
  const stp = document.getElementById('errProgStep');
  if (stp) stp.textContent = `${Math.min(step, total)}/${total} 단계`;
  const row = document.getElementById('errStepperRow');
  if (row) row.innerHTML = _errStepperCircles('analyzing', step);
}

function _startErrAnim(id) {
  _stopErrAnim();
  _renderAnalyzingPanel(id);   // 1회 렌더
  let step = 1;
  const tick = () => {
    step++;
    _updateErrAnim(Math.min(step, ERR_AGENTS.length)); // 부분 갱신만
    // 마지막 단계는 응답 도착까지 유지(줄무늬 바가 계속 흐름)
    if (step < ERR_AGENTS.length) _errAnimTimer = setTimeout(tick, 1100 + Math.random() * 700);
  };
  _errAnimTimer = setTimeout(tick, 900);
}

// ── 오류검증 및 분석 (비파괴) ──
async function analyzeError(id) {
  if (!_errDetailCache || _errDetailCache.log.id !== id) { await openErrDetail(id); }
  _startErrAnim(id);
  try {
    const data = await gasPost({ action: 'errorLogAnalyze', id }, 45000);
    _stopErrAnim();
    if (data.error) { alert('분석 실패: ' + data.error); await openErrDetail(id); return; }
    await openErrDetail(id); // 최신 분석 결과로 패널 갱신(스테퍼 6/6 완료)
    loadErrorLogs();
  } catch (err) {
    _stopErrAnim();
    await openErrDetail(id);
    alert('분석 실패: ' + err.message);
  }
}

// ── 상태 변경 ──
async function changeErrStatus(id, status) {
  try {
    const data = await gasPost({ action: 'errorLogStatus', id, status });
    if (data.error) { alert(data.error); return; }
    await openErrDetail(id);
    loadErrorLogs();
  } catch (err) {
    alert('상태 변경 실패: ' + err.message);
  }
}

// ── 클립보드 복사 헬퍼 ──
async function _errCopy(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    return true;
  } catch (_) { return false; }
}

// ── 오류내용 복사(문서 11장) — 공유용 진단 정보, 상태 변경 없음 ──
async function copyErrorContent(id) {
  const c = _errDetailCache; if (!c || c.log.id !== id) return;
  const l = c.log, a = c.analysis, ctx = l.context || {};
  const A = (o, k) => (o && o[k]) ? o[k] : '';
  const lines = [
    `[오류내용 #${l.id}]`,
    `상태: ${ERRLOG_STATUS_LABELS[l.status] || l.status}`,
    `수집원: ${l.source} / 범주: ${ERRLOG_CAT_LABELS[l.category] || l.category} / 심각도: ${ERRLOG_SEV_LABELS[l.severity] || l.severity}`,
    `발생 횟수: ${l.occurrence_count}`,
    `첫 발생: ${l.first_seen_at} / 마지막 발생: ${l.last_seen_at}`,
    `요약: ${l.message_ko}`,
    `원문: ${l.message_raw || '-'}${l.error_code ? ' (코드: ' + l.error_code + ')' : ''}`,
    `화면/API: ${l.flow_ko}${l.step_ko ? ' · ' + l.step_ko : ''} | HTTP ${[ctx.method, ctx.path, ctx.statusCode].filter(Boolean).join(' ') || '-'}`,
    `stack: ${l.stack || '-'}`,
  ];
  if (a) {
    lines.push('', '[AI 다중 에이전트 분석]', `요약: ${a.summary_ko || '-'}`);
    lines.push(`오류검증: ${ERRLOG_VERIFY_LABELS[A(a.verify, 'verdict')] || A(a.verify, 'verdict')} — ${A(a.verify, 'evidence')}`);
    lines.push(`레드팀: 조건=${A(a.red_team, 'conditions')} / 피해=${A(a.red_team, 'user_impact')} / 위험=${A(a.red_team, 'data_risk')} / 재발=${A(a.red_team, 'recurrence')}`);
    lines.push(`블루팀: 입력검증=${A(a.blue_team, 'input_validation')} / 예외=${A(a.blue_team, 'exception_handling')} / 상태방어=${A(a.blue_team, 'state_guard')} / 중복방지=${A(a.blue_team, 'idempotency')} / 외부API=${A(a.blue_team, 'external_api')} / 회귀=${A(a.blue_team, 'regression_tests')}`);
    lines.push(`감독관: 범위=${A(a.supervisor, 'scope')} / 증상vs원인=${A(a.supervisor, 'symptom_vs_cause')} / 가장좁은해결=${A(a.supervisor, 'narrowest_fix')}`);
    const pg = a.prevention_guard || {};
    lines.push(`예방가드: 안전구현=${pg.safe_to_implement === false ? '불가' : '가능'} / 차단조건=[${(pg.blockers || []).join('; ')}] / 필수검증=[${(pg.must_verify || []).join('; ')}]`);
    lines.push(`결정자: ${ERRLOG_DECIDER_LABELS[A(a.decider, 'verdict')] || A(a.decider, 'verdict')} — ${A(a.decider, 'reason')}`);
  }
  const ok = await _errCopy(lines.join('\n'));
  alert(ok ? '오류내용을 복사했습니다.' : '복사 실패 — 수동으로 선택해 주세요.');
}

// ── 이행 요청 복사(문서 10장) — 게이트 통과 시에만 ──
async function copyTransferRequest(id) {
  const c = _errDetailCache; if (!c || c.log.id !== id) return;
  if (!c.transfer_allowed) {
    alert('이행 요청 복사가 차단되었습니다.\n\n사유:\n- ' + (c.transfer_blockers || []).join('\n- ') + '\n\n먼저 "오류검증 및 분석"을 실행하고 게이트를 통과시키세요.');
    return;
  }
  const l = c.log, a = c.analysis || {}, ctx = l.context || {}, pg = a.prevention_guard || {};
  const lines = [
    `[이행 요청 — 오류 #${l.id}]`,
    `오류 범주: ${ERRLOG_CAT_LABELS[l.category] || l.category}`,
    `한글 요약: ${l.message_ko}`,
    `오류 원문: ${l.message_raw || '-'}${l.error_code ? ' (코드: ' + l.error_code + ')' : ''}`,
    `발생 화면/API: ${l.flow_ko}${l.step_ko ? ' · ' + l.step_ko : ''} | HTTP ${[ctx.method, ctx.path, ctx.statusCode].filter(Boolean).join(' ') || '-'}`,
    `발생 위치: ${ctx.screen || ctx.page || l.stack || '-'}`,
    `오류검증 결과: ${ERRLOG_VERIFY_LABELS[(a.verify || {}).verdict] || (a.verify || {}).verdict}`,
    `결정자 판정: ${ERRLOG_DECIDER_LABELS[(a.decider || {}).verdict] || (a.decider || {}).verdict} — ${(a.decider || {}).reason || ''}`,
    `사전 확인 항목: ${(a.preflight || []).length ? '\n  - ' + a.preflight.join('\n  - ') : '없음(바로 수정 가능)'}`,
    `진행/중단 기준: ${a.go_no_go || '없음'}`,
    `수정 범위: ${a.fix_scope || '-'}`,
    `테스트 계획: ${a.test_plan || '-'}`,
    `예방가드 결과: 영향화면=${pg.affected_screens || '-'} / 영향API=${pg.affected_apis || '-'} / 외부영향=${pg.external_impact || '-'} / 새위험=${pg.new_risks || '-'}`,
    `필수 검증: ${(pg.must_verify || []).length ? '\n  - ' + pg.must_verify.join('\n  - ') : '-'}`,
    `잔여 위험: ${a.residual_risk || '-'}`,
    '',
    '[실제 수정 시 요구사항]',
    '- 원인(증상 아님)을 수정하고 수정 범위를 위 항목으로 좁게 유지할 것',
    '- 운영 데이터/외부 연동/결제·주문·계정 상태를 변경하지 말 것',
    '- 수정 후 재검증: 동일 signature 재수집 여부 + 성공/실패 케이스 + 로그에 secret/개인정보 노출 여부 확인',
  ];
  const ok = await _errCopy(lines.join('\n'));
  if (ok) {
    if (confirm('이행 요청을 복사했습니다.\n이 오류 상태를 "확인중(investigating)"으로 변경할까요?')) {
      changeErrStatus(id, 'investigating');
    }
  } else {
    alert('복사 실패 — 수동으로 선택해 주세요.');
  }
}

function _buildUnrecogSampleTable(sampleRows) {
  if (!sampleRows || !Array.isArray(sampleRows)) return '<tr><td>데이터 없음</td></tr>';
  let parsed = sampleRows;
  if (typeof sampleRows === 'string') {
    try { parsed = JSON.parse(sampleRows); } catch (_) { return '<tr><td>파싱 오류</td></tr>'; }
  }
  return parsed.map((row, i) => {
    const cells = (Array.isArray(row) ? row : []).map(c => `<td style="border:1px solid #E5E7EB;padding:2px 4px;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis">${escHtml(String(c || ''))}</td>`).join('');
    return `<tr><td style="border:1px solid #E5E7EB;padding:2px 4px;color:var(--t3);font-weight:600">${i + 1}</td>${cells}</tr>`;
  }).join('');
}

// ── 선택된 인식 실패 탭 무시 처리 ──
async function ignoreSelectedUnrecognized() {
  const checks = document.querySelectorAll('.unrecog-check:checked');
  if (checks.length === 0) {
    showToast('무시할 탭을 선택하세요.', 'warning');
    return;
  }
  const ids = Array.from(checks).map(c => c.value);
  if (!confirm(`${ids.length}개 탭을 무시 처리하시겠습니까?\n(가이드라인 등 비인덱스 탭)`)) return;

  try {
    const data = await gasPost({ action: 'ignoreUnrecognized', ids });
    if (data.error) {
      showToast('실패: ' + data.error, 'error');
      return;
    }
    showToast(`${data.updated || 0}개 탭 무시 처리 완료`, 'success');
    loadUnrecognizedTabs();
  } catch (err) {
    showToast('오류: ' + err.message, 'error');
  }
}

// ── 전체선택 토글 ──
function toggleAllUnrecogChecks(checked) {
  document.querySelectorAll('.unrecog-check').forEach(c => { c.checked = checked; });
}

// ── 키워드 목록 로드 ──
async function loadKeywordList() {
  const wrap = document.getElementById('keywordListWrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:12px;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';

  try {
    const data = await gasGet({ action: 'getKeywords' });
    if (data.error) {
      wrap.innerHTML = `<div style="padding:12px;color:#EF4444"><i class="fas fa-exclamation-circle"></i> ${escHtml(data.error)}</div>`;
      return;
    }

    const grouped = data.grouped || {};
    const categoryLabels = {
      'data_tab': '헤더행 감지',
      'name': '이름 컬럼',
      'submit': '제출 컬럼',
      'system_tab': '시스템 탭',
      'product': '상품명',
      'url': '상품URL',
      'phone': '연락처',
      'start_date': '시작일',
      'end_date': '종료일',
      'round': '회차',
    };
    const categoryColors = {
      'data_tab': '#3B82F6',
      'name': '#12b886',
      'submit': '#F59E0B',
      'system_tab': '#EF4444',
      'product': '#4593fc',
      'url': '#EC4899',
      'phone': '#3182f6',
      'start_date': '#14B8A6',
      'end_date': '#F97316',
      'round': '#06B6D4',
    };

    const categories = Object.keys(categoryLabels);
    let html = '';

    categories.forEach(cat => {
      const kws = grouped[cat] || [];
      const label = categoryLabels[cat] || cat;
      const color = categoryColors[cat] || '#6B7280';

      html += `<div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-weight:700;font-size:.82rem;color:${color}"><i class="fas fa-tag" style="margin-right:4px"></i>${label}</span>
          <span style="font-size:.7rem;color:var(--t3)">(${cat})</span>
          <span style="font-size:.7rem;background:${color}22;color:${color};padding:1px 6px;border-radius:6px">${kws.length}개</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">`;

      if (kws.length === 0) {
        html += `<span style="font-size:.75rem;color:var(--t3)">키워드 없음</span>`;
      } else {
        kws.forEach(kw => {
          const opacity = kw.active ? '1' : '0.4';
          html += `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:16px;font-size:.75rem;font-weight:500;background:${color}15;color:${color};border:1px solid ${color}40;opacity:${opacity}" data-kw-id="${kw.id}">
            ${escHtml(kw.keyword)}
            <button onclick="toggleKeywordAction('${kw.id}', ${!kw.active})" style="background:none;border:none;cursor:pointer;padding:0;font-size:.7rem;color:${kw.active ? '#F59E0B' : '#12b886'}" title="${kw.active ? '비활성화' : '활성화'}">
              <i class="fas ${kw.active ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
            </button>
            <button onclick="deleteKeywordAction('${kw.id}','${escHtml(kw.keyword)}')" style="background:none;border:none;cursor:pointer;padding:0;font-size:.7rem;color:#EF4444" title="삭제">
              <i class="fas fa-times"></i>
            </button>
          </span>`;
        });
      }

      html += `</div></div>`;
    });

    wrap.innerHTML = html || '<div style="text-align:center;padding:20px;color:var(--t3)">키워드 데이터가 없습니다.</div>';
  } catch (err) {
    wrap.innerHTML = `<div style="padding:12px;color:#EF4444"><i class="fas fa-exclamation-circle"></i> ${escHtml(err.message)}</div>`;
  }
}

// ── 키워드 추가 ──
async function addKeywordAction() {
  const category = document.getElementById('kwCategorySelect')?.value;
  const keyword = document.getElementById('kwNewKeyword')?.value?.trim();
  if (!category || !keyword) {
    showToast('카테고리와 키워드를 입력하세요.', 'warning');
    return;
  }

  try {
    const data = await gasPost({ action: 'addKeyword', category, keyword });
    if (data.error) {
      showToast('실패: ' + data.error, 'error');
      return;
    }
    showToast(`키워드 "${keyword}" 추가 완료`, 'success');
    document.getElementById('kwNewKeyword').value = '';
    loadKeywordList();
  } catch (err) {
    showToast('오류: ' + err.message, 'error');
  }
}

// ── 키워드 활성/비활성 토글 ──
async function toggleKeywordAction(id, active) {
  try {
    const url = API_BASE_URL + '/api/admin/keywords/' + id;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(_getAuthHeaders ? _getAuthHeaders() : {}) },
      body: JSON.stringify({ active }),
    });
    const data = await res.json();
    if (data.error) {
      showToast('실패: ' + data.error, 'error');
      return;
    }
    showToast(active ? '키워드 활성화' : '키워드 비활성화', 'success');
    loadKeywordList();
  } catch (err) {
    showToast('오류: ' + err.message, 'error');
  }
}

// ── 키워드 삭제 ──
async function deleteKeywordAction(id, keyword) {
  if (!confirm(`"${keyword}" 키워드를 삭제하시겠습니까?`)) return;

  try {
    const url = API_BASE_URL + '/api/admin/keywords/' + id;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { ...(_getAuthHeaders ? _getAuthHeaders() : {}) },
    });
    const data = await res.json();
    if (data.error) {
      showToast('실패: ' + data.error, 'error');
      return;
    }
    showToast(`"${keyword}" 키워드 삭제 완료`, 'success');
    loadKeywordList();
  } catch (err) {
    showToast('오류: ' + err.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ Phase 7: 캠페인 탭 관리 대시보드 (21컬럼 전체 통합 뷰)
   ── A: 시트→DB 동기화  B: 마감탭 인덱스 정리  C: CRON 자동화
   ══════════════════════════════════════════════════════════════ */
let _tabDashData = null;
let _tabDashView = "table";      // テーブル固定 (v11.8.3: カード削除)

// ── 정렬 상태: { key: 'campaign_name'|'_progress', dir: 'asc'|'desc' } or null ──
let _tabDashSort = { key: '_progress', dir: 'desc' };

/** 정렬 토글: 같은 컬럼 클릭 → asc→desc→해제, 다른 컬럼 클릭 → asc부터 */
function _toggleTabDashSort(key) {
  if (!_tabDashSort || _tabDashSort.key !== key) {
    _tabDashSort = { key, dir: 'asc' };
  } else if (_tabDashSort.dir === 'asc') {
    _tabDashSort.dir = 'desc';
  } else {
    _tabDashSort = null; // 해제
  }
  renderTabDashTable();
}

// ── 21컬럼 정의: key, 한국어 라벨, 카테고리, 기본표시여부 ──
const _TAB_DASH_COLS = [
  { key:"_form_link",       label:"양식",      cat:"link",  show:true,  align:"center", width:"50px" },
  { key:"_status",          label:"상태",      cat:"core",  show:true,  align:"center" },
  { key:"campaign_name",    label:"캠페인",    cat:"core",  show:true,  align:"left" },
  { key:"tab_name",         label:"탭명",      cat:"core",  show:true,  align:"left" },
  { key:"display_name",     label:"표시명(상품)", cat:"meta", show:true,  align:"left" },
  { key:"manager",          label:"담당자",    cat:"core",  show:true,  align:"center" },
  { key:"review_type",      label:"리뷰유형",  cat:"meta",  show:true,  align:"center" },
  { key:"payment_type",     label:"결제방식",  cat:"pay",   show:true,  align:"center" },
  { key:"time_range",       label:"주문시간대", cat:"meta",  show:true,  align:"center" },
  { key:"round",            label:"차수",      cat:"meta",  show:true,  align:"center" },
  { key:"_progress",        label:"인원/제출",  cat:"index", show:true,  align:"right" },
  { key:"_paid",             label:"입금",      cat:"index", show:true,  align:"right" },

  { key:"is_bulk",          label:"대량건",    cat:"meta",  show:false, align:"center" },
  { key:"delivery_type",    label:"배송유형",  cat:"meta",  show:false, align:"center" },
  { key:"nc_mode",          label:"NC모드",    cat:"meta",  show:false, align:"center" },
  { key:"deposit_name",     label:"입금자명",  cat:"pay",   show:false, align:"center" },
  { key:"transfer_bank",    label:"이체은행",  cat:"pay",   show:false, align:"center" },
  { key:"income_type",      label:"소득유형",  cat:"pay",   show:false, align:"center" },
  { key:"folder_url",       label:"리뷰폴더",  cat:"link",  show:true,  align:"center" },
  { key:"capture_folder_url",label:"캡처폴더", cat:"link",  show:false, align:"center" },
  { key:"sheet_url",        label:"시트링크",  cat:"link",  show:false, align:"center" },
  { key:"updated_at",       label:"갱신일",    cat:"sys",   show:true,  align:"left" },
  { key:"_option",          label:"옵션",      cat:"meta",  show:true,  align:"center", width:"40px" },
];

// ★ 서버 기반 컬럼 표시/순서 설정 — 모든 관리자에게 동일하게 적용
// v2: localStorage 캐시 완전 제거 — 서버 설정이 유일한 진실의 원천
let _colPrefsLoaded = false;

// ★ 기존 localStorage 캐시 강제 정리 (다른 사용자 브라우저에 남아있는 이전 설정 제거)
try { localStorage.removeItem("tabDash_colPrefs"); } catch(_){}

// 서버에서 컬럼 설정 로드 (loadTabDashboard에서 호출)
// ★ 서버 값이 항상 최종 적용됨 — localStorage는 사용하지 않음
async function _loadColPrefsFromServer() {
  try {
    const data = await gasGet({ action: 'getColPrefs' });
    if (data.ok && data.prefs) {
      _applyColPrefs(data.prefs);
      _colPrefsLoaded = true;
      return true; // 서버 설정 적용됨
    }
    // ★ 서버에 설정이 없으면 현재 기본 설정을 서버에 자동 저장 (초기 세팅)
    if (data.ok && !data.prefs) {
      console.info('[colPrefs] 서버에 설정 없음 → 현재 기본값을 서버에 저장');
      await _saveColPrefs();
      _colPrefsLoaded = true;
      return true;
    }
  } catch(e) { console.warn('[colPrefs] 서버 로드 실패, 기본값 사용:', e.message); }
  return false;
}

function _applyColPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return;
  const isNew = Object.values(prefs).some(v => typeof v === 'object' && v !== null);
  if (isNew) {
    _TAB_DASH_COLS.forEach(c => {
      if (prefs[c.key]) { c.show = prefs[c.key].show; c._order = prefs[c.key].order; }
    });
    _TAB_DASH_COLS.sort((a, b) => (a._order ?? 999) - (b._order ?? 999));
    _TAB_DASH_COLS.forEach(c => delete c._order);
  } else {
    _TAB_DASH_COLS.forEach(c => { if (prefs[c.key] !== undefined) c.show = prefs[c.key]; });
  }
}

async function _saveColPrefs() {
  const prefs = {};
  _TAB_DASH_COLS.forEach((c, i) => prefs[c.key] = { show: c.show, order: i });
  // 서버에만 저장 (전역 공유 — 모든 관리자에게 동일 적용)
  try {
    await gasPost({ action: 'saveColPrefs', prefs });
    showToast('컬럼 설정이 저장되었습니다 (모든 관리자에게 적용)', 'success');
  } catch(e) { 
    console.warn('[colPrefs] 서버 저장 실패:', e.message);
    showToast('컬럼 설정 저장 실패: ' + e.message, 'error');
  }
}

// [v11.8.3] 카드뷰 제거 — 테이블뷰 고정
function setTabDashView(mode) {
  _tabDashView = "table";
  const colToggle = document.getElementById("tabDashColToggle");
  if (colToggle) colToggle.style.display = "block";
  renderTabDashTable();
}

// ── 필터링 공통 로직 ──
function _filterTabDashData() {
  if (!_tabDashData) return [];
  const tabs = _tabDashData.tabs || [];
  const statusF = document.getElementById("tabDashStatusFilter")?.value || "";
  const mgrF = document.getElementById("tabDashManagerFilter")?.value || "";
  const campF = document.getElementById("tabDashCampaignFilter")?.value || "";
  const rtF = document.getElementById("tabDashReviewTypeFilter")?.value || "";
  const searchQ = (document.getElementById("tabDashSearch")?.value || "").trim().toLowerCase();

  // ★ 차수별 행 확장: roundList가 있는 탭은 차수별로 분리
  // closedRounds에 포함된 차수(마감 완료)는 제외
  const expanded = [];
  tabs.forEach(t => {
    const closedRoundsSet = new Set();
    if (t.closed_rounds) {
      t.closed_rounds.split(',').map(s => s.trim()).filter(Boolean).forEach(r => closedRoundsSet.add(r));
    }
    if (t.roundList && t.roundList.length > 0) {
      // 차수별로 행 생성 (마감된 차수는 제외)
      t.roundList.forEach(rd => {
        if (closedRoundsSet.has(rd.round)) return; // 마감 차수 스킵
        // ★ display_name_map에서 차수별 표시명 오버라이드
        const dnMap = t.display_name_map || {};
        const roundDisplayName = dnMap[rd.round];
        // ★ round_meta에서 차수별 부가정보(담당자, 리뷰유형, 결제방식, 주문시간대) 오버라이드
        const rmMap = t.round_meta || {};
        const rmData = rmMap[rd.round] || {};
        expanded.push(Object.assign({}, t, {
          _roundLabel: rd.round,
          _roundTotal: rd.total,
          _roundSubmitted: rd.submitted,
          _roundPaid: rd.paid || 0,
          _isRoundRow: true,
          display_name: roundDisplayName !== undefined ? roundDisplayName : (t.display_name || ""),
          manager: rmData.manager !== undefined ? rmData.manager : (t.manager || ""),
          review_type: rmData.review_type !== undefined ? rmData.review_type : (t.review_type || ""),
          payment_type: rmData.payment_type !== undefined ? rmData.payment_type : (t.payment_type || ""),
          time_range: rmData.time_range !== undefined ? rmData.time_range : (t.time_range || ""),
        }));
      });
    } else {
      expanded.push(t);
    }
  });

  let result = expanded.filter(t => {
    if (statusF === "active" && t.is_closed) return false;
    if (statusF === "closed" && !t.is_closed) return false;
    if (mgrF && (t.manager || "(미지정)") !== mgrF) return false;
    if (campF && (t.campaign_name || "(미지정)") !== campF) return false;
    if (rtF && (t.review_type || "(미지정)") !== rtF) return false;
    if (searchQ) {
      const h = `${t.tab_name} ${t.display_name||""} ${t.campaign_name||""} ${t.manager||""} ${t.review_type||""} ${t.deposit_name||""} ${t._roundLabel||""}`.toLowerCase();
      if (!h.includes(searchQ)) return false;
    }
    return true;
  });

  // ── 정렬 적용 ──
  if (_tabDashSort) {
    const { key, dir } = _tabDashSort;
    const mul = dir === 'asc' ? 1 : -1;

    result.sort((a, b) => {
      if (key === 'campaign_name') {
        // ㄱㄴㄷ순 (한국어 로케일 정렬)
        const va = (a.campaign_name || '').trim();
        const vb = (b.campaign_name || '').trim();
        if (!va && !vb) return 0;
        if (!va) return 1;  // 빈값은 항상 뒤로
        if (!vb) return -1;
        return mul * va.localeCompare(vb, 'ko');
      }
      if (key === '_progress') {
        // 진행률(submitted/row_count) 기준
        const rcA = a._isRoundRow ? (a._roundTotal || 0) : (a.row_count || 0);
        const scA = a._isRoundRow ? (a._roundSubmitted || 0) : (a.submitted_count || 0);
        const rcB = b._isRoundRow ? (b._roundTotal || 0) : (b.row_count || 0);
        const scB = b._isRoundRow ? (b._roundSubmitted || 0) : (b.submitted_count || 0);
        const pctA = rcA > 0 ? scA / rcA : -1;  // 데이터 없으면 -1로 뒤로
        const pctB = rcB > 0 ? scB / rcB : -1;
        return mul * (pctA - pctB);
      }
      return 0;
    });
  }

  return result;
}

// ── 대시보드 전체 새로고침 (새로고침 버튼 클릭 시) ──
async function _refreshDashboardAll() {
  // 대시보드 메인 데이터 + 완료감지 목록 + 배지 동시 새로고침
  await loadTabDashboard();
  // 대시보드 내 완료감지 패널이 열려있으면 새로고침
  const dashDetectWrap = document.getElementById('dashArchiveDetectWrap');
  if (dashDetectWrap && dashDetectWrap.style.display !== 'none' && dashDetectWrap.innerHTML.trim() !== '') {
    dashboardArchiveDetect();
  }
  // 마감 탭의 완료감지 패널이 열려있으면 새로고침
  const detectWrap = document.getElementById('archiveDetectWrap');
  if (detectWrap && detectWrap.style.display !== 'none' && detectWrap.innerHTML.trim() !== '') {
    archiveAutoDetect();
  }
  // 완료감지 배지 업데이트
  if (typeof _updateArchiveBadge === 'function') _updateArchiveBadge();
}

// ── 메인 로드 ──
async function loadTabDashboard() {
  const wrap = document.getElementById("tabDashTableWrap");
  if (wrap) wrap.innerHTML = '<div style="padding:12px;color:var(--t3)"><i class="fas fa-spinner fa-spin"></i> 로딩중...</div>';

  try {
    // ★ 서버 컬럼 설정 + 대시보드 데이터 병렬 로드
    const [colChanged, res] = await Promise.all([
      _loadColPrefsFromServer(),
      gasGet({ action: "getTabDashboard" }),
    ]);
    if (res.error) { showToast(res.error, "error"); return; }
    _tabDashData = res;

    // ★ 제출+입금 모두 100% 완료 탭 팝업 알림
    _checkAllCompleteTabsFromTabDash(res.tabs || []);

    // ── KPI ──
    const s = res.stats || {};
    const kpiEl = document.getElementById("tabDashKPI");
    if (kpiEl) {
      const rate = _pct(s.totalSubmitted, s.totalRows);
      const payRate = _pct(s.totalPaid, s.totalSubmitted);
      const noFolder = s.noFolder || 0;
      kpiEl.innerHTML = [
        _kpiCard("전체 탭", s.total, "#1D4ED8", "fa-list"),
        _kpiCard("활성", s.active, "#0ca678", "fa-play-circle"),
        _kpiCard("인덱스", s.indexed, "#3182f6", "fa-database"),
        _kpiCard("미지정", s.noManager, "#9CA3AF", "fa-user-slash"),
        _kpiCard("폴더 미설정", noFolder, noFolder>0?"#D97706":"#0ca678", "fa-folder-open"),
        _kpiCard("제출률", `${rate}%`, rate>=80?"#0ca678":rate>=50?"#D97706":"#DC2626", "fa-chart-pie"),
        _kpiCard("입금률", `${payRate}%`, payRate>=80?"#0ca678":payRate>=50?"#D97706":"#DC2626", "fa-coins"),
      ].join("");
    }

    // ── 동기화 시각 ──
    const syncEl = document.getElementById("tabDashSyncInfo");
    if (syncEl) {
      const t = res.lastSync ? new Date(res.lastSync).toLocaleString("ko-KR") : "없음";
      syncEl.innerHTML = `<i class="fas fa-database" style="margin-right:4px"></i>데이터 원본: <b>DB(tab_configs)</b> &middot; <span style="color:#0ca678">인덱스 빌드: 매 정시 자동 실행</span>`
        + ` &middot; <span style="color:#0ca678"><i class="fas fa-shield-alt" style="margin-right:2px"></i>시트 쓰기권한: 빌드 시 자동 부여</span>`;
    }

    // ── 담당자 필터 ──
    _populateFilter("tabDashManagerFilter", "전체 담당자", res.managers);
    _renderTabDashManagerTabs();
    // ── 캠페인 필터 ──
    _populateFilterObj("tabDashCampaignFilter", "전체 캠페인", res.campaigns);
    // ── 리뷰유형 필터 ──
    const rtMap = {};
    (res.tabs||[]).forEach(t => { const rt = t.review_type || "(미지정)"; rtMap[rt] = (rtMap[rt]||0)+1; });
    _populateFilter("tabDashReviewTypeFilter", "전체 리뷰유형", rtMap);

    // ── 컬럼 체크박스 ──
    _buildColToggleUI();

    renderTabDashTable();
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div style="padding:12px;color:#DC2626">${err.message}</div>`;
  }
}

function _populateFilter(elId, defaultLabel, map) {
  const el = document.getElementById(elId);
  if (!el || !map) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${defaultLabel}</option>`;
  Object.keys(map).sort().forEach(k => { el.innerHTML += `<option value="${escHtml(k)}">${escHtml(k)} (${map[k]})</option>`; });
  el.value = cur;
}
// 담당자 필터를 좌우 탭 버튼으로 렌더 ([전체보기][만두][망고]...)
function _renderTabDashManagerTabs() {
  const cont = document.getElementById("tabDashManagerTabs");
  const sel = document.getElementById("tabDashManagerFilter");
  if (!cont || !sel) return;
  const cur = sel.value || "";
  const opts = [...sel.options].map(o => ({ value: o.value, label: o.value === "" ? "전체보기" : o.textContent }));
  cont.innerHTML = opts.map(o => {
    const active = (o.value === cur);
    return `<button onclick="_selectTabDashManager('${escHtml(o.value).replace(/'/g, "\\'")}')" style="font-size:.75rem;font-weight:700;border-radius:7px;padding:5px 13px;cursor:pointer;white-space:nowrap;border:1px solid ${active ? '#3182f6' : '#D1D5DB'};background:${active ? '#3182f6' : '#fff'};color:${active ? '#fff' : '#374151'}">${escHtml(o.label)}</button>`;
  }).join("");
}
function _selectTabDashManager(val) {
  const sel = document.getElementById("tabDashManagerFilter");
  if (sel) sel.value = val;
  _renderTabDashManagerTabs();
  renderTabDashTable();
}

function _populateFilterObj(elId, defaultLabel, map) {
  const el = document.getElementById(elId);
  if (!el || !map) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${defaultLabel}</option>`;
  Object.keys(map).sort().forEach(k => { el.innerHTML += `<option value="${escHtml(k)}">${escHtml(k)} (${map[k].tabs})</option>`; });
  el.value = cur;
}

// ═══════════════════════════════════════════════════════════
// (제거됨) "시트 쓰기권한 일괄부여" 수동 기능
//   → 인덱스 빌드 시 자동 부여로 대체됨
//     (server/src/services/smartBuild.service.js _ensureSheetsShared)
// ═══════════════════════════════════════════════════════════

function _kpiCard(label, value, color, icon) {
  return `<div style="background:#fff;border-radius:8px;padding:8px 12px;border-left:3px solid ${color};box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="display:flex;align-items:center;gap:6px"><i class="fas ${icon}" style="color:${color};font-size:.8rem"></i><span style="font-size:1.15rem;font-weight:700;color:${color}">${value}</span></div>
    <div style="font-size:.68rem;color:var(--t3);margin-top:2px">${label}</div>
  </div>`;
}

// ── 컬럼 토글 + 드래그 순서 변경 UI ──
let _colDragIdx = null;
function _buildColToggleUI() {
  const wrap = document.getElementById("tabDashColCheckboxes");
  if (!wrap) return;
  const cats = { core:"기본", meta:"메타", pay:"입금", link:"링크", index:"인덱스", sys:"시스템" };
  let html = "";
  _TAB_DASH_COLS.forEach((c, i) => {
    html += `<div draggable="true" data-col-idx="${i}" ondragstart="_colDragStart(event,${i})" ondragover="_colDragOver(event)" ondrop="_colDrop(event,${i})" ondragend="_colDragEnd(event)" style="display:inline-flex;align-items:center;gap:3px;cursor:grab;white-space:nowrap;padding:3px 6px;border-radius:6px;border:1px solid transparent;background:${c.show?'#EFF6FF':'#F9FAFB'};transition:all .15s;user-select:none" onmouseover="this.style.borderColor='#93C5FD'" onmouseout="this.style.borderColor='transparent'">
      <i class="fas fa-grip-vertical" style="color:#CBD5E1;font-size:.65rem;cursor:grab"></i>
      <input type="checkbox" ${c.show?"checked":""} onchange="_toggleDashCol('${c.key}',this.checked)" style="width:13px;height:13px;cursor:pointer">
      <span style="color:${c.show?'var(--t1)':'var(--t3)'}">${c.label}</span>
      <span style="font-size:.58rem;color:#9CA3AF">${cats[c.cat]||""}</span>
    </div>`;
  });
  wrap.innerHTML = html;
}
function _colDragStart(e, idx) {
  _colDragIdx = idx;
  e.dataTransfer.effectAllowed = "move";
  e.target.style.opacity = "0.5";
}
function _colDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
function _colDragEnd(e) { e.target.style.opacity = "1"; _colDragIdx = null; }
function _colDrop(e, dropIdx) {
  e.preventDefault();
  if (_colDragIdx === null || _colDragIdx === dropIdx) return;
  const moved = _TAB_DASH_COLS.splice(_colDragIdx, 1)[0];
  _TAB_DASH_COLS.splice(dropIdx, 0, moved);
  _colDragIdx = null;
  _saveColPrefs();
  _buildColToggleUI();
  renderTabDashTable();
}

function _toggleDashCol(key, checked) {
  const col = _TAB_DASH_COLS.find(c => c.key === key);
  if (col) { col.show = checked; _saveColPrefs(); renderTabDashTable(); _buildColToggleUI(); }
}

// ── 셀값 렌더 헬퍼 (v11.8.4: 인라인 편집 지원) ──

/** 팝업 닫힘 추적 (토글 시 즉시 재열림 방지) */
const _popupClosedMap = new Map();
function _removePopupWithTrack(popup) {
  const key = popup._popupKey;
  if (key) _popupClosedMap.set(key, Date.now());
  popup.remove();
}
function _popupJustClosed(popupKey) {
  const t = _popupClosedMap.get(popupKey);
  if (!t) return false;
  if (Date.now() - t < 200) return true;
  _popupClosedMap.delete(popupKey);
  return false;
}

/** 인라인 저장 공통 */
async function _saveTabField(t, fieldMap, round) {
  try {
    const payload = { action:"setTabConfig", sheetId: t.sheet_id, tabName: t.tab_name, ...fieldMap };
    // ★ 차수별: round가 있으면 서버에 round 전달 → JSONB(display_name_map / round_meta) 업데이트
    if (round) payload.round = round;
    const res = await gasPost(payload);
    if (res.error) { showToast(res.error, "error"); return false; }
    // 로컬 데이터 즉시 반영
    const origTab = (_tabDashData?.tabs||[]).find(x => x.sheet_id===t.sheet_id && x.tab_name===t.tab_name);
    if (round) {
      // ★ 차수별 로컬 업데이트
      if (fieldMap.displayName !== undefined) {
        // display_name_map 로컬 업데이트
        if (origTab) {
          if (!origTab.display_name_map) origTab.display_name_map = {};
          origTab.display_name_map[round] = fieldMap.displayName;
        }
        t.display_name = fieldMap.displayName;
      }
      // ★ round_meta 필드들 (manager, reviewType, paymentType, timeRange) 로컬 업데이트
      const ROUND_META_API_KEYS = { manager: 'manager', reviewType: 'review_type', paymentType: 'payment_type', timeRange: 'time_range' };
      for (const [apiKey, dbKey] of Object.entries(ROUND_META_API_KEYS)) {
        if (fieldMap[apiKey] !== undefined && origTab) {
          if (!origTab.round_meta) origTab.round_meta = {};
          if (!origTab.round_meta[round]) origTab.round_meta[round] = {};
          origTab.round_meta[round][dbKey] = fieldMap[apiKey];
          t[dbKey] = fieldMap[apiKey];
        }
      }
    } else {
      for (const [apiKey, val] of Object.entries(fieldMap)) {
        const dbKey = { displayName:"display_name", manager:"manager", reviewType:"review_type",
          paymentType:"payment_type", timeRange:"time_range", depositName:"deposit_name",
          incomeType:"income_type", transferBank:"transfer_bank", folderUrl:"folder_url",
          captureFolderUrl:"capture_folder_url" }[apiKey] || apiKey;
        t[dbKey] = val;
        if (origTab) origTab[dbKey] = val;
      }
    }
    showToast("저장 완료", "success");
    return true;
  } catch(e) { showToast("저장 실패: "+e.message, "error"); return false; }
}

/** 텍스트 간편입력 → blur/enter 시 저장 */
function _inlineTextEdit(t, dbKey, apiKey, placeholder, round) {
  const val = escHtml(t[dbKey] || "");
  // ★ round가 있으면 ID에 포함하여 차수별로 고유 input 생성
  const idBase = round ? `ie_${dbKey}_${t.sheet_id}_${t.tab_name}_${round}` : `ie_${dbKey}_${t.sheet_id}_${t.tab_name}`;
  const id = idBase.replace(/[^a-zA-Z0-9_]/g,"_");
  const roundParam = round ? `,'${escHtml(round)}'` : ``;
  return `<input id="${id}" type="text" value="${val}" placeholder="${placeholder}"
    style="width:100%;min-width:60px;max-width:140px;padding:2px 5px;border:1px solid #E5E7EB;border-radius:4px;font-size:.73rem;background:#FAFAFA;outline:none"
    onfocus="this.style.borderColor='#3B82F6';this.style.background='#fff'"
    onblur="this.style.borderColor='#E5E7EB';this.style.background='#FAFAFA';_onInlineTextSave(this,'${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}','${apiKey}'${roundParam})"
    onkeydown="if(event.key==='Enter'){this.blur()}"
    data-orig="${val}">`;
}
async function _onInlineTextSave(el, sheetId, tabName, apiKey, round) {
  const newVal = el.value.trim();
  if (newVal === (el.dataset.orig||"")) return;
  // ★ round가 있으면 확장된 행에서 매칭, 없으면 원본 탭에서 매칭
  let t;
  if (round) {
    // 확장된 필터 데이터에서 찾기 (같은 sheet_id + tab_name이면 어느 행이든 OK)
    t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
    // 확장 행용 임시 객체 구성
    if (t) t = Object.assign({}, t, { _roundLabel: round, _isRoundRow: true });
  } else {
    t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  }
  if (!t) return;
  const ok = await _saveTabField(t, { [apiKey]: newVal }, round || null);
  if (ok) { el.dataset.orig = newVal; }
  else { el.value = el.dataset.orig||""; }
}

/** 링크 간편입력: 아이콘 클릭 → 인라인 input 전환 */
function _inlineLinkEdit(t, dbKey, apiKey, icon, color) {
  const url = t[dbKey] || "";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  const id = `il_${dbKey}_${sid}_${tn}`.replace(/[^a-zA-Z0-9_]/g,"_");
  if (url) {
    return `<span id="${id}_wrap" style="display:inline-flex;align-items:center;gap:3px">
      <a href="${escHtml(url)}" target="_blank" style="color:${color}" title="${escHtml(url)}"><i class="fas ${icon}"></i></a>
      <button onclick="_toggleLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}')" style="background:none;border:none;cursor:pointer;color:#9CA3AF;font-size:.65rem" title="링크 수정"><i class="fas fa-pen"></i></button>
    </span>
    <div id="${id}_edit" style="display:none">
      <div style="display:flex;align-items:center;gap:2px">
        <input id="${id}_inp" type="text" value="${escHtml(url)}" placeholder="URL 입력"
          style="width:100%;min-width:80px;max-width:160px;padding:2px 5px;border:1px solid #3B82F6;border-radius:4px;font-size:.68rem;background:#fff;outline:none"
          onkeydown="if(event.key==='Enter')_saveLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}');if(event.key==='Escape')_cancelLinkInput('${id}')"
          data-orig="${escHtml(url)}">
        <button onclick="_saveLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}')" style="background:none;border:none;cursor:pointer;color:#0ca678;font-size:.72rem" title="저장"><i class="fas fa-check"></i></button>
        <button onclick="_cancelLinkInput('${id}')" style="background:none;border:none;cursor:pointer;color:#DC2626;font-size:.72rem" title="취소"><i class="fas fa-times"></i></button>
      </div>
    </div>`;
  }
  return `<span id="${id}_wrap">
      <button onclick="_toggleLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}')" style="background:none;border:none;cursor:pointer;color:#D1D5DB;font-size:.75rem" title="링크 입력"><i class="fas ${icon}"></i> <i class="fas fa-plus" style="font-size:.55rem"></i></button>
    </span>
    <div id="${id}_edit" style="display:none">
      <div style="display:flex;align-items:center;gap:2px">
        <input id="${id}_inp" type="text" value="" placeholder="URL 입력"
          style="width:100%;min-width:80px;max-width:160px;padding:2px 5px;border:1px solid #3B82F6;border-radius:4px;font-size:.68rem;background:#fff;outline:none"
          onkeydown="if(event.key==='Enter')_saveLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}');if(event.key==='Escape')_cancelLinkInput('${id}')"
          data-orig="">
        <button onclick="_saveLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}')" style="background:none;border:none;cursor:pointer;color:#0ca678;font-size:.72rem" title="저장"><i class="fas fa-check"></i></button>
        <button onclick="_cancelLinkInput('${id}')" style="background:none;border:none;cursor:pointer;color:#DC2626;font-size:.72rem" title="취소"><i class="fas fa-times"></i></button>
      </div>
    </div>`;
}
function _toggleLinkInput(id) {
  const wrap = document.getElementById(id+"_wrap");
  const edit = document.getElementById(id+"_edit");
  if (!wrap || !edit) return;
  wrap.style.display = "none";
  edit.style.display = "block";
  const inp = document.getElementById(id+"_inp");
  if (inp) { inp.focus(); inp.select(); }
}
function _cancelLinkInput(id) {
  const wrap = document.getElementById(id+"_wrap");
  const edit = document.getElementById(id+"_edit");
  const inp = document.getElementById(id+"_inp");
  if (wrap) wrap.style.display = "inline-flex";
  if (edit) edit.style.display = "none";
  if (inp) inp.value = inp.dataset.orig || "";
}
async function _saveLinkInput(id, sheetId, tabName, apiKey, dbKey) {
  const inp = document.getElementById(id+"_inp");
  if (!inp) return;
  const newVal = inp.value.trim();
  if (newVal === (inp.dataset.orig||"")) { _cancelLinkInput(id); return; }
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  const ok = await _saveTabField(t, { [apiKey]: newVal });
  if (ok) renderTabDashTable();
  else { inp.value = inp.dataset.orig||""; _cancelLinkInput(id); }
}

/** 택일 팝업: 버튼 클릭 → 드롭다운 */
function _inlineSelect(t, dbKey, apiKey, options, colorMap, round) {
  const cur = t[dbKey] || "";
  const display = cur || "—";
  const clr = (colorMap && colorMap[cur]) || "#6B7280";
  const bg = (colorMap && colorMap[cur+"_bg"]) || "#F3F4F6";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  const roundParam = round ? `,'${escHtml(round)}'` : '';
  return `<span onclick="_showSelectPopup(event,'${sid}','${tn}','${apiKey}','${dbKey}',${JSON.stringify(options).replace(/"/g,'&quot;')}${roundParam})" style="cursor:pointer;background:${bg};color:${clr};padding:2px 7px;border-radius:6px;font-size:.7rem;font-weight:500;white-space:nowrap">${escHtml(display)} <i class="fas fa-caret-down" style="font-size:.6rem;opacity:.5"></i></span>`;
}
async function _showSelectPopup(e, sheetId, tabName, apiKey, dbKey, options, round) {
  e.stopPropagation();
  // 토글: 같은 셀에서 열린 팝업이면 닫기만
  const popupKey = round ? `${sheetId}||${tabName}||${dbKey}||${round}` : `${sheetId}||${tabName}||${dbKey}`;
  const existing = document.querySelector(".td-inline-popup");
  if (existing && existing._popupKey === popupKey) { _removePopupWithTrack(existing); return; }
  if (_popupJustClosed(popupKey)) return;
  document.querySelectorAll(".td-inline-popup").forEach(el => el.remove());
  // ★ round가 있으면 확장 행용 임시 객체 구성
  let t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  if (round) {
    const rmMap = t.round_meta || {};
    const rmData = rmMap[round] || {};
    t = Object.assign({}, t, { _roundLabel: round, _isRoundRow: true,
      manager: rmData.manager !== undefined ? rmData.manager : (t.manager || ""),
      review_type: rmData.review_type !== undefined ? rmData.review_type : (t.review_type || ""),
      payment_type: rmData.payment_type !== undefined ? rmData.payment_type : (t.payment_type || ""),
      time_range: rmData.time_range !== undefined ? rmData.time_range : (t.time_range || ""),
    });
  }
  const popup = document.createElement("div");
  popup.className = "td-inline-popup";
  popup.style.cssText = "position:fixed;z-index:10000;background:#fff;border:1px solid #D1D5DB;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:4px;min-width:90px;font-size:.75rem";
  const rect = e.target.closest("span").getBoundingClientRect();
  popup.style.left = rect.left + "px";
  popup.style.top = (rect.bottom + 4) + "px";
  options.forEach(opt => {
    const btn = document.createElement("div");
    btn.textContent = opt;
    btn.style.cssText = "padding:6px 12px;cursor:pointer;border-radius:4px;white-space:nowrap";
    btn.onmouseover = () => btn.style.background = "#EFF6FF";
    btn.onmouseout = () => btn.style.background = "transparent";
    if (opt === (t[dbKey]||"")) btn.style.fontWeight = "700";
    btn.onclick = async () => {
      popup.remove();
      await _saveTabField(t, { [apiKey]: opt }, round || null);
      renderTabDashTable();
    };
    popup.appendChild(btn);
  });
  popup._popupKey = popupKey;
  document.body.appendChild(popup);
  // 바깥 클릭 시 닫기
  setTimeout(() => {
    const closer = (ev) => { if (!popup.contains(ev.target)) { _removePopupWithTrack(popup); document.removeEventListener("mousedown", closer); } };
    document.addEventListener("mousedown", closer);
  }, 0);
}

/** 주문시간대: 자유/타임지정 + 30분 단위 범례 */
function _inlineTimeRange(t, round) {
  const cur = t.time_range || "";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  const roundParam = round ? `,'${escHtml(round)}'` : '';
  if (!cur) {
    return `<span onclick="_showTimeRangePopup(event,'${sid}','${tn}'${roundParam})" style="cursor:pointer;color:#D1D5DB;font-size:.72rem">— <i class="fas fa-clock" style="font-size:.6rem"></i></span>`;
  }
  const display = cur === "자유" ? "자유" : cur;
  const bg = cur === "자유" ? "#F0FDF4" : "#EFF6FF";
  const clr = cur === "자유" ? "#0ca678" : "#1D4ED8";
  return `<span onclick="_showTimeRangePopup(event,'${sid}','${tn}'${roundParam})" style="cursor:pointer;background:${bg};color:${clr};padding:2px 7px;border-radius:6px;font-size:.7rem;font-weight:500;white-space:nowrap">${escHtml(display)} <i class="fas fa-caret-down" style="font-size:.6rem;opacity:.5"></i></span>`;
}

function _showTimeRangePopup(e, sheetId, tabName, round) {
  e.stopPropagation();
  const popupKey = round ? `${sheetId}||${tabName}||timeRange||${round}` : `${sheetId}||${tabName}||timeRange`;
  const existing = document.querySelector(".td-inline-popup");
  if (existing && existing._popupKey === popupKey) { _removePopupWithTrack(existing); return; }
  if (_popupJustClosed(popupKey)) return;
  document.querySelectorAll(".td-inline-popup").forEach(el => el.remove());
  // ★ round가 있으면 확장 행용 임시 객체 구성
  let t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  if (round) {
    const rmMap = t.round_meta || {};
    const rmData = rmMap[round] || {};
    t = Object.assign({}, t, { _roundLabel: round, _isRoundRow: true,
      time_range: rmData.time_range !== undefined ? rmData.time_range : (t.time_range || ""),
    });
  }

  const popup = document.createElement("div");
  popup.className = "td-inline-popup";
  popup.style.cssText = "position:fixed;z-index:10000;background:#fff;border:1px solid #D1D5DB;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:14px;min-width:280px;font-size:.75rem";
  const rect = e.target.closest("span,td").getBoundingClientRect();
  popup.style.left = Math.min(rect.left, window.innerWidth - 310) + "px";
  popup.style.top = (rect.bottom + 4) + "px";

  // 현재값 파싱
  const cur = t.time_range || "";
  let mode = "미지정", startH = 11, startM = 30, endH = 14, endM = 30;
  if (cur === "자유") { mode = "자유"; }
  else if (cur) {
    mode = "타임지정";
    const m = cur.match(/(\d{1,2}):(\d{2})\s*[~\-]\s*(\d{1,2}):(\d{2})/);
    if (m) { startH = +m[1]; startM = +m[2]; endH = +m[3]; endM = +m[4]; }
  }

  // 30분 슬롯 생성 (03:00 ~ 17:30)
  const slots = [];
  for (let h = 3; h <= 17; h++) { slots.push({h, m:0}); slots.push({h, m:30}); }

  function buildGrid(label, selH, selM, prefix) {
    let html = `<div style="margin-top:8px"><div style="font-size:.68rem;color:#6B7280;margin-bottom:4px">${label}</div>`;
    html += `<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:3px">`;
    slots.forEach(s => {
      const str = String(s.h).padStart(2,"0") + ":" + String(s.m).padStart(2,"0");
      const sel = s.h === selH && s.m === selM;
      html += `<button data-prefix="${prefix}" data-h="${s.h}" data-m="${s.m}" onclick="_trSlotClick(this,'${prefix}')" style="padding:4px 2px;border:1px solid ${sel?'#3B82F6':'#E5E7EB'};border-radius:4px;background:${sel?'#3B82F6':'#fff'};color:${sel?'#fff':'#374151'};font-size:.68rem;cursor:pointer;font-weight:${sel?'600':'400'}">${str}</button>`;
    });
    html += `</div></div>`;
    return html;
  }

  popup.innerHTML = `
    <div style="font-size:.8rem;font-weight:600;margin-bottom:8px"><i class="fas fa-clock" style="color:#3B82F6;margin-right:4px"></i> 주문시간대 수정</div>
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <button onclick="_trSetMode(this,'미지정')" class="tr-mode-btn" style="padding:4px 10px;border:1px solid ${mode==='미지정'?'#3B82F6':'#D1D5DB'};border-radius:6px;background:${mode==='미지정'?'#EFF6FF':'#fff'};color:${mode==='미지정'?'#1D4ED8':'#6B7280'};font-size:.72rem;cursor:pointer;font-weight:${mode==='미지정'?'600':'400'}">미지정</button>
      <button onclick="_trSetMode(this,'자유')" class="tr-mode-btn" style="padding:4px 10px;border:1px solid ${mode==='자유'?'#3B82F6':'#D1D5DB'};border-radius:6px;background:${mode==='자유'?'#EFF6FF':'#fff'};color:${mode==='자유'?'#1D4ED8':'#6B7280'};font-size:.72rem;cursor:pointer;font-weight:${mode==='자유'?'600':'400'}">자유</button>
      <button onclick="_trSetMode(this,'타임지정')" class="tr-mode-btn" style="padding:4px 10px;border:1px solid ${mode==='타임지정'?'#3B82F6':'#D1D5DB'};border-radius:6px;background:${mode==='타임지정'?'#EFF6FF':'#fff'};color:${mode==='타임지정'?'#1D4ED8':'#6B7280'};font-size:.72rem;cursor:pointer;font-weight:${mode==='타임지정'?'600':'400'}">타임지정</button>
    </div>
    <div id="trTimeGrid" style="display:${mode==='타임지정'?'block':'none'}">
      <div style="font-size:.72rem;color:#1D4ED8;font-weight:600;margin-bottom:2px">✓ ${String(startH).padStart(2,"0")}:${String(startM).padStart(2,"0")} ~ ${String(endH).padStart(2,"0")}:${String(endM).padStart(2,"0")}</div>
      ${buildGrid("시작 시각", startH, startM, "start")}
      ${buildGrid("종료 시각", endH, endM, "end")}
      <div style="text-align:right;margin-top:4px"><button onclick="_trReset()" style="background:none;border:none;color:#9CA3AF;font-size:.68rem;cursor:pointer">시간 초기화</button></div>
    </div>
    <button id="trApplyBtn" onclick="_trApply('${sheetId}','${tabName}'${round ? `,'${escHtml(round)}'` : ''})" style="margin-top:10px;width:100%;padding:7px;background:#3B82F6;color:#fff;border:none;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer">✓ 적용</button>
  `;
  popup._trMode = mode;
  popup._trStart = { h: startH, m: startM };
  popup._trEnd = { h: endH, m: endM };
  popup._popupKey = popupKey;
  document.body.appendChild(popup);
  setTimeout(() => {
    const closer = (ev) => { if (!popup.contains(ev.target)) { _removePopupWithTrack(popup); document.removeEventListener("mousedown", closer); } };
    document.addEventListener("mousedown", closer);
  }, 0);
}
function _trSetMode(btn, mode) {
  const popup = btn.closest(".td-inline-popup");
  popup._trMode = mode;
  popup.querySelectorAll(".tr-mode-btn").forEach(b => {
    const isActive = b.textContent.trim() === mode;
    b.style.borderColor = isActive ? "#3B82F6" : "#D1D5DB";
    b.style.background = isActive ? "#EFF6FF" : "#fff";
    b.style.color = isActive ? "#1D4ED8" : "#6B7280";
    b.style.fontWeight = isActive ? "600" : "400";
  });
  const grid = popup.querySelector("#trTimeGrid");
  if (grid) grid.style.display = mode === "타임지정" ? "block" : "none";
}
function _trSlotClick(btn, prefix) {
  const popup = btn.closest(".td-inline-popup");
  const h = +btn.dataset.h, m = +btn.dataset.m;
  if (prefix === "start") popup._trStart = { h, m };
  else popup._trEnd = { h, m };
  // 선택 표시 갱신
  btn.closest("div[style*='grid']").querySelectorAll("button").forEach(b => {
    const bh = +b.dataset.h, bm = +b.dataset.m;
    const sel = bh === h && bm === m;
    b.style.borderColor = sel ? "#3B82F6" : "#E5E7EB";
    b.style.background = sel ? "#3B82F6" : "#fff";
    b.style.color = sel ? "#fff" : "#374151";
    b.style.fontWeight = sel ? "600" : "400";
  });
  // 요약 갱신
  const s = popup._trStart, e = popup._trEnd;
  const sumEl = popup.querySelector("#trTimeGrid > div:first-child");
  if (sumEl) sumEl.textContent = `✓ ${String(s.h).padStart(2,"0")}:${String(s.m).padStart(2,"0")} ~ ${String(e.h).padStart(2,"0")}:${String(e.m).padStart(2,"0")}`;
}
function _trReset() {
  const popup = document.querySelector(".td-inline-popup");
  if (popup) { popup._trStart = {h:11,m:30}; popup._trEnd = {h:14,m:30}; _trSetMode(popup.querySelector(".tr-mode-btn:nth-child(3)"), "타임지정"); }
}
async function _trApply(sheetId, tabName, round) {
  const popup = document.querySelector(".td-inline-popup");
  if (!popup) return;
  let t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  if (round) {
    t = Object.assign({}, t, { _roundLabel: round, _isRoundRow: true });
  }
  let val = "";
  if (popup._trMode === "자유") val = "자유";
  else if (popup._trMode === "타임지정") {
    const s = popup._trStart, e = popup._trEnd;
    val = `${String(s.h).padStart(2,"0")}:${String(s.m).padStart(2,"0")} ~ ${String(e.h).padStart(2,"0")}:${String(e.m).padStart(2,"0")}`;
  }
  popup.remove();
  await _saveTabField(t, { timeRange: val }, round || null);
  renderTabDashTable();
}

/** 소득유형: 선택 + 이체은행 강제 팝업 */
function _inlineIncomeType(t) {
  const cur = t.income_type || "";
  const bank = t.transfer_bank || "";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  let display = cur || "—";
  if (cur && bank) display += ` (${bank})`;
  const clrMap = {"현금":"#0ca678","사업자현영":"#B45309","소득신고":"#3182f6"};
  const bgMap = {"현금":"#D1FAE5","사업자현영":"#FEF3C7","소득신고":"#e8f1fe"};
  const clr = clrMap[cur] || "#6B7280";
  const bg = bgMap[cur] || "#F3F4F6";
  return `<span onclick="_showIncomePopup(event,'${sid}','${tn}')" style="cursor:pointer;background:${bg};color:${clr};padding:2px 7px;border-radius:6px;font-size:.7rem;font-weight:500;white-space:nowrap">${escHtml(display)} <i class="fas fa-caret-down" style="font-size:.6rem;opacity:.5"></i></span>`;
}

function _showIncomePopup(e, sheetId, tabName) {
  e.stopPropagation();
  const popupKey = `${sheetId}||${tabName}||incomeType`;
  const existing = document.querySelector(".td-inline-popup");
  if (existing && existing._popupKey === popupKey) { _removePopupWithTrack(existing); return; }
  if (_popupJustClosed(popupKey)) return;
  document.querySelectorAll(".td-inline-popup").forEach(el => el.remove());
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;

  const popup = document.createElement("div");
  popup.className = "td-inline-popup";
  popup.style.cssText = "position:fixed;z-index:10000;background:#fff;border:1px solid #D1D5DB;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.15);padding:14px;min-width:200px;font-size:.75rem";
  const rect = e.target.closest("span,td").getBoundingClientRect();
  popup.style.left = Math.min(rect.left, window.innerWidth - 230) + "px";
  popup.style.top = (rect.bottom + 4) + "px";

  const options = ["현금", "사업자현영", "소득신고"];
  const cur = t.income_type || "";
  const curBank = t.transfer_bank || "";

  let html = `<div style="font-size:.8rem;font-weight:600;margin-bottom:8px"><i class="fas fa-receipt" style="color:#3182f6;margin-right:4px"></i> 소득유형 선택</div>`;
  options.forEach(opt => {
    const sel = opt === cur;
    html += `<div onclick="_incomeSelect(this,'${escHtml(sheetId)}','${escHtml(tabName)}','${opt}')" style="padding:7px 12px;cursor:pointer;border-radius:6px;margin-bottom:3px;background:${sel?'#EFF6FF':'#fff'};border:1px solid ${sel?'#3B82F6':'transparent'};font-weight:${sel?'600':'400'}" onmouseover="if(!this.style.borderColor.includes('3B82'))this.style.background='#F9FAFB'" onmouseout="if(!this.style.borderColor.includes('3B82'))this.style.background='#fff'">${opt}</div>`;
  });
  popup.innerHTML = html;
  popup._popupKey = popupKey;
  document.body.appendChild(popup);
  setTimeout(() => {
    const closer = (ev) => { if (!popup.contains(ev.target)) { _removePopupWithTrack(popup); document.removeEventListener("mousedown", closer); } };
    document.addEventListener("mousedown", closer);
  }, 0);
}

async function _incomeSelect(el, sheetId, tabName, incomeType) {
  const popup = el.closest(".td-inline-popup");
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;

  if (incomeType === "소득신고") {
    // 소득신고 → 이체은행 자동 케이뱅크
    if (popup) popup.remove();
    await _saveTabField(t, { incomeType: "소득신고", transferBank: "케이뱅크" });
    renderTabDashTable();
  } else {
    // 현금 / 사업자현영 → 이체은행 강제 선택 팝업 (닫을 수 없음)
    if (popup) popup.remove();
    _showForceBankPopup(sheetId, tabName, incomeType);
  }
}

function _showForceBankPopup(sheetId, tabName, incomeType) {
  // 기존 팝업 제거
  document.querySelectorAll(".td-force-bank-overlay").forEach(el => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "td-force-bank-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;justify-content:center;align-items:center";
  overlay.classList.add("toss-overlay");
  // 바깥 클릭 차단 (닫히지 않음)

  const box = document.createElement("div");
  box.style.cssText = "background:#fff;border-radius:14px;padding:28px 24px;min-width:280px;max-width:340px;box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center";
  box.innerHTML = `
    <div style="font-size:1.3rem;margin-bottom:6px">🏦</div>
    <div style="font-size:.9rem;font-weight:700;color:#1E293B;margin-bottom:4px">이체은행을 선택하세요</div>
    <div style="font-size:.75rem;color:#6B7280;margin-bottom:16px">소득유형: <b>${escHtml(incomeType)}</b></div>
    <div style="display:flex;gap:10px;justify-content:center">
      <button onclick="_forceBankSelect('${escHtml(sheetId)}','${escHtml(tabName)}','${escHtml(incomeType)}','하나은행')" style="flex:1;padding:12px;background:#DBEAFE;color:#1E40AF;border:2px solid #93C5FD;border-radius:10px;font-size:.85rem;font-weight:700;cursor:pointer;transition:all .15s" onmouseover="this.style.background='#BFDBFE'" onmouseout="this.style.background='#DBEAFE'">하나은행</button>
      <button onclick="_forceBankSelect('${escHtml(sheetId)}','${escHtml(tabName)}','${escHtml(incomeType)}','케이뱅크')" style="flex:1;padding:12px;background:#FEF3C7;color:#92400E;border:2px solid #FCD34D;border-radius:10px;font-size:.85rem;font-weight:700;cursor:pointer;transition:all .15s" onmouseover="this.style.background='#FDE68A'" onmouseout="this.style.background='#FEF3C7'">케이뱅크</button>
    </div>
    <div style="font-size:.65rem;color:#DC2626;margin-top:12px;font-weight:500"><i class="fas fa-exclamation-triangle"></i> 은행을 선택해야 창이 닫힙니다</div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function _forceBankSelect(sheetId, tabName, incomeType, bank) {
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  document.querySelectorAll(".td-force-bank-overlay").forEach(el => el.remove());
  await _saveTabField(t, { incomeType, transferBank: bank });
  renderTabDashTable();
}

function _cellVal(t, col) {
  const k = col.key;
  if (k === "_form_link") {
    const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
    const dn = escHtml(t.display_name || t.tab_name);
    const gid = t.tab_gid || "";
    const rd = escHtml(t.round || "");
    const nc = t.nc_mode ? "1" : "";
    const ic = escHtml(t.income_type || "");
    const su = escHtml(t.sheet_url || "");
    const tcJson = JSON.stringify({sheetId:t.sheet_id,sheetUrl:t.sheet_url||"",tabName:t.tab_name,displayName:t.display_name||t.tab_name,round:t.round||"",ncMode:!!t.nc_mode,incomeType:t.income_type||"",providerMemo:t.provider_memo||"",tabGid:t.tab_gid||""}).replace(/"/g,'&quot;');
    return `<button data-tc="${tcJson}" onclick="event.stopPropagation();copyShortLink(this)" style="background:none;border:none;cursor:pointer;color:#3182f6;font-size:.82rem" title="구매양식 제출링크 복사"><i class="fas fa-link"></i></button>`;
  }
  if (k === "_status") {
    const st = t.is_closed ? "closed" : "active";
    if (st === "closed") return '<span style="background:#FEE2E2;color:#DC2626;padding:2px 6px;border-radius:8px;font-size:.68rem;font-weight:600">마감</span>';
    return '<span style="background:#D1FAE5;color:#0ca678;padding:2px 6px;border-radius:8px;font-size:.68rem;font-weight:600">활성</span>';
  }
  if (k === "_progress") {
    // ★ 차수별 행이면 해당 차수의 인원/제출 표시
    const rc = t._isRoundRow ? (t._roundTotal || 0) : (t.row_count || 0);
    const sc = t._isRoundRow ? (t._roundSubmitted || 0) : (t.submitted_count || 0);
    if (rc === 0) return '<span style="color:#D1D5DB">—</span>';
    const pct = _pct(sc, rc);
    const clr = pct >= 80 ? "#0ca678" : pct >= 50 ? "#D97706" : "#DC2626";
    const pending = rc - sc;
    // 미제출 10명 미만 & 1명 이상이면 클릭 가능
    if (pending > 0 && pending < 10 && t.sheet_id && t.tab_name) {
      const sid = escHtml(t.sheet_id);
      const tn = escHtml(t.tab_name);
      const rd = t._isRoundRow ? escHtml(t._roundLabel || '') : '';
      return `<span style="font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px" onclick="event.stopPropagation();_showPendingReviewersPopup('${sid}','${tn}',${rc},${sc},'${rd}')" title="클릭하여 미제출자 ${pending}명 확인">${sc}/${rc}</span> <span style="color:${clr};font-size:.68rem">(${pct}%)</span>`;
    }
    return `<span style="font-weight:600">${sc}/${rc}</span> <span style="color:${clr};font-size:.68rem">(${pct}%)</span>`;
  }
  if (k === "_paid") {
    // ★ 입금 현황: paid_count / row_count
    const rc = t._isRoundRow ? (t._roundTotal || 0) : (t.row_count || 0);
    const pc = t._isRoundRow ? (t._roundPaid || 0) : (t.paid_count || 0);
    if (rc === 0) return '<span style="color:#D1D5DB">—</span>';
    if (pc === 0 && rc > 0) return `<span style="font-weight:600">${pc}/${rc}</span>`;
    const pct = _pct(pc, rc);
    const clr = pct >= 100 ? "#0ca678" : pct >= 50 ? "#D97706" : "#DC2626";
    const icon = pct >= 100 ? ' <i class="fas fa-check" style="font-size:.6rem"></i>' : '';
    const unpaid = rc - pc;
    // 미입금 10명 미만 & 1명 이상이면 클릭 가능
    if (unpaid > 0 && unpaid < 10 && t.sheet_id && t.tab_name) {
      const sid = escHtml(t.sheet_id);
      const tn = escHtml(t.tab_name);
      const rd = t._isRoundRow ? escHtml(t._roundLabel || '') : '';
      const rdParam = rd ? `,'${rd}'` : '';
      return `<span style="font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px" onclick="event.stopPropagation();_showUnpaidReviewersPopup('${sid}','${tn}',${rc},${pc}${rdParam})" title="클릭하여 미입금자 ${unpaid}명 확인">${pc}/${rc}</span> <span style="color:${clr};font-size:.68rem">(${pct}%)${icon}</span>`;
    }
    return `<span style="font-weight:600">${pc}/${rc}</span> <span style="color:${clr};font-size:.68rem">(${pct}%)${icon}</span>`;
  }
  // 캠페인명 + 🔄 갱신 버튼
  if (k === "campaign_name") {
    const cn = t.campaign_name || "";
    const sid = escHtml(t.sheet_id || "");
    const rebuildBtn = sid
      ? `<button class="btn-rebuild-sheet" data-sheetid="${sid}" data-camp="${escHtml(cn)}" onclick="event.stopPropagation();rebuildSheetIndex(this)" title="이 캠페인 인덱스 갱신"><i class="fas fa-sync-alt"></i></button>`
      : "";
    return cn ? `<span style="display:flex;align-items:center;gap:3px">${rebuildBtn}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(cn)}</span></span>` : '<span style="color:#D1D5DB">—</span>';
  }
  // 텍스트 간편입력
  // ★ 차수 행이면 round 파라미터를 전달하여 차수별 독립 표시명 저장
  if (k === "display_name") return _inlineTextEdit(t, "display_name", "displayName", "상품명 입력", t._isRoundRow ? t._roundLabel : null);
  if (k === "deposit_name") return _inlineTextEdit(t, "deposit_name", "depositName", "입금자명");
  // 링크 입력
  if (k === "folder_url") return _inlineLinkEdit(t, "folder_url", "folderUrl", "fa-folder", "#0ca678");
  if (k === "capture_folder_url") return _inlineLinkEdit(t, "capture_folder_url", "captureFolderUrl", "fa-camera", "#1D4ED8");
  if (k === "sheet_url") {
    const url = t.sheet_url;
    const hasGid = t.tab_gid;
    const finalUrl = url ? (hasGid ? url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : url) : '';
    const linkIcon = finalUrl
      ? `<a href="${escHtml(finalUrl)}" target="_blank" style="color:#3182f6" title="${escHtml(finalUrl)}"><i class="fas fa-external-link-alt"></i></a>`
      : '';
    // 시트링크에 gid가 없으면 ⚠️ 보정 버튼 표시
    // ★ tab_gid가 DB에 저장되어 있으면 ⚠️ 숨김 (수동보정 완료 상태)
    const needsFix = !hasGid;
    const fixBtn = needsFix
      ? `<button onclick="event.stopPropagation();_fixSheetUrl('${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}')" style="background:none;border:none;cursor:pointer;color:#D97706;font-size:.72rem;margin-left:2px" title="시트링크 수동보정 (gid 없음)"><i class="fas fa-exclamation-triangle"></i></button>`
      : '';
    if (!url && !fixBtn) return '<span style="color:#D1D5DB">—</span>';
    // ★ 시트링크 아이콘 더블클릭 시 수동보정 모달 재진입 가능
    const dblClickHandler = `ondblclick="event.stopPropagation();event.preventDefault();_fixSheetUrl('${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}')"`;
    return `<span style="display:inline-flex;align-items:center;gap:2px" ${dblClickHandler} title="더블클릭: 시트링크 수동보정">${linkIcon}${fixBtn}</span>`;
  }
  // 택일
  if (k === "manager") return _inlineSelect(t, "manager", "manager", ["만두","망고"], {
    "만두":"#1D4ED8","만두_bg":"#DBEAFE","망고":"#D97706","망고_bg":"#FEF3C7"
  }, t._isRoundRow ? t._roundLabel : null);
  if (k === "review_type") return _inlineSelect(t, "review_type", "reviewType", ["실배송","빈박스","구매확정","믹스"], {
    "실배송":"#0ca678","실배송_bg":"#D1FAE5","빈박스":"#3182f6","빈박스_bg":"#e8f1fe","구매확정":"#1D4ED8","구매확정_bg":"#DBEAFE","믹스":"#D97706","믹스_bg":"#FEF3C7"
  }, t._isRoundRow ? t._roundLabel : null);
  if (k === "payment_type") return _inlineSelect(t, "payment_type", "paymentType", ["현금","현영","소득"], {
    "현금":"#0ca678","현금_bg":"#D1FAE5","현영":"#1D4ED8","현영_bg":"#DBEAFE","소득":"#3182f6","소득_bg":"#e8f1fe"
  }, t._isRoundRow ? t._roundLabel : null);
  // 주문시간대
  if (k === "time_range") return _inlineTimeRange(t, t._isRoundRow ? t._roundLabel : null);
  // 소득유형 + 이체은행 통합
  if (k === "income_type") return _inlineIncomeType(t);
  // 불리언
  if (k === "is_bulk" || k === "nc_mode") {
    return t[k] ? '<i class="fas fa-check-circle" style="color:#0ca678"></i>' : '<span style="color:#D1D5DB">—</span>';
  }
  if (k === "updated_at") {
    return t.updated_at ? new Date(t.updated_at).toLocaleDateString("ko-KR", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
  }
  // ★ 차수 컬럼: _roundLabel이 있으면 우선 표시
  if (k === "round") {
    const rv = t._roundLabel || t.round || "";
    if (rv) return `<span style="background:#e8f1fe;color:#1b64da;padding:2px 7px;border-radius:8px;font-size:.68rem;font-weight:600">${escHtml(rv)}</span>`;
    return '<span style="color:#D1D5DB">—</span>';
  }
  // ★ 옵션 컬럼: 태그 아이콘 + 배지 (차수별 option_columns_map 우선)
  if (k === "_option") {
    const rd = t._roundLabel || t.round || '';
    const ocMap = t.option_columns_map || {};
    const roundCols = rd && ocMap[rd] ? ocMap[rd] : null;
    const fallbackCols = t.option_columns || [];
    const activeCols = roundCols || fallbackCols;
    const optCount = activeCols.length;
    const optColor = optCount > 0 ? '#3182f6' : '#CBD5E1';
    const optTitle = optCount > 0 ? `옵션 ${optCount}개 설정됨` : '옵션 찾기';
    const optBadge = optCount > 0 ? `<span style="position:absolute;top:-4px;right:-6px;background:#3182f6;color:#fff;font-size:.5rem;border-radius:50%;width:13px;height:13px;display:flex;align-items:center;justify-content:center;font-weight:700">${optCount}</span>` : '';
    return `<button onclick="event.stopPropagation();openOptionModal('${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}','${escHtml(t.tab_gid||'')}','${escHtml(rd)}')" style="background:none;border:none;color:${optColor};cursor:pointer;font-size:.78rem;position:relative" title="${optTitle}"><i class="fas fa-tags"></i>${optBadge}</button>`;
  }
  const v = t[k];
  return v != null && v !== "" ? escHtml(String(v)) : '<span style="color:#D1D5DB">—</span>';
}

// ── 렌더 (카드/테이블 분기) ──
function renderTabDashTable() {
  const wrap = document.getElementById("tabDashTableWrap");
  if (!wrap || !_tabDashData) return;

  const filtered = _filterTabDashData();
  const countEl = document.getElementById("tabDashCount");
  if (countEl) countEl.textContent = `${filtered.length}건 / ${(_tabDashData.tabs||[]).length}건`;

  if (filtered.length === 0) {
    wrap.innerHTML = '<div style="padding:16px;text-align:center;color:var(--t3)">조건에 맞는 탭이 없습니다.</div>';
    return;
  }

  _renderFullTableView(wrap, filtered);
}

// [v11.8.3] 카드뷰 삭제 — _renderCardView 제거

// ── 테이블뷰: 21컬럼 전체 + 체크박스 선택 ──
let _tabDashChecked = new Set(); // "sheetId||tabName" 형태
let _tabDashSimple = false;      // 간단히보기(true) / 펼쳐보기(false)
// 간단히보기 시 숨길 컬럼
const _TAB_DASH_SIMPLE_HIDE = new Set(["_status", "_option", "deposit_name", "capture_folder_url", "folder_url", "updated_at"]);

function _toggleTabDashSimple() {
  _tabDashSimple = !_tabDashSimple;
  const btn = document.getElementById("tabDashViewToggle");
  if (btn) btn.innerHTML = _tabDashSimple
    ? '<i class="fas fa-expand-alt"></i> 펼쳐보기'
    : '<i class="fas fa-compress-alt"></i> 간단히보기';
  renderTabDashTable();
}

function _renderFullTableView(wrap, filtered) {
  let visibleCols = _TAB_DASH_COLS.filter(c => c.show);
  if (_tabDashSimple) visibleCols = visibleCols.filter(c => !_TAB_DASH_SIMPLE_HIDE.has(c.key));
  const thStyle = "padding:7px 5px;font-weight:600;white-space:nowrap;border-bottom:2px solid #D1D5DB;font-size:.72rem;position:sticky;top:0;background:#F3F4F6;z-index:1";

  // 마감 액션바 — wrap 바깥에 sticky로 고정
  const checkedCount = _tabDashChecked.size;
  let stickyBar = document.getElementById("tabDashArchiveBar");
  if (!stickyBar) {
    stickyBar = document.createElement("div");
    stickyBar.id = "tabDashArchiveBar";
    wrap.parentNode.insertBefore(stickyBar, wrap);
  }
  if (checkedCount > 0) {
    stickyBar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:6px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;flex-wrap:wrap;position:sticky;top:0;z-index:20;box-shadow:0 2px 8px rgba(245,158,11,.15)";
    stickyBar.innerHTML = `
      <span style="font-size:.78rem;font-weight:600;color:#92400E"><i class="fas fa-check-square" style="margin-right:4px"></i>${checkedCount}건 선택됨</span>
      <button onclick="_archiveCheckedTabs()" style="padding:4px 12px;background:#DC2626;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px"><i class="fas fa-archive"></i> 마감으로 보내기</button>
      <button onclick="_checkSubmissionStatus()" style="padding:4px 12px;background:#0891B2;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px"><i class="fas fa-clipboard-check"></i> 마감자료 검수</button>
      <button onclick="_clearTabDashChecked()" style="padding:4px 10px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.72rem;cursor:pointer">선택 해제</button>`;
  } else {
    stickyBar.style.display = "none";
    stickyBar.innerHTML = "";
  }

  let html = "";

  html += `<table style="width:100%;border-collapse:collapse;font-size:.75rem">
    <thead><tr>`;
  // 전체선택 체크박스
  const allChecked = filtered.length > 0 && filtered.every(t => _tabDashChecked.has(`${t.sheet_id}||${t.tab_name}`));
  html += `<th style="${thStyle};text-align:center;width:30px"><input type="checkbox" ${allChecked?'checked':''} onchange="_toggleAllTabDashCheck(this.checked)" style="width:14px;height:14px;cursor:pointer" title="전체 선택/해제"></th>`;
  visibleCols.forEach(c => {
    const sortable = (c.key === 'campaign_name' || c.key === '_progress');
    let sortIcon = '';
    let sortCursor = '';
    if (sortable) {
      sortCursor = 'cursor:pointer;user-select:none;';
      if (_tabDashSort && _tabDashSort.key === c.key) {
        const arrow = _tabDashSort.dir === 'asc' ? 'fa-sort-up' : 'fa-sort-down';
        sortIcon = ` <i class="fas ${arrow}" style="color:#1D4ED8;font-size:.7rem"></i>`;
      } else {
        sortIcon = ' <i class="fas fa-sort" style="color:#CBD5E1;font-size:.65rem"></i>';
      }
    }
    const onclick = sortable ? ` onclick="_toggleTabDashSort('${c.key}')"` : '';
    html += `<th style="${thStyle};text-align:${c.align}${c.width?';width:'+c.width:''};${sortCursor}"${onclick}>${c.label}${sortIcon}</th>`;
  });
  html += (_tabDashSimple ? "" : `<th style="${thStyle};text-align:center">상세</th>`) + `</tr></thead><tbody>`;

  filtered.forEach((t, idx) => {
    const st = t.is_closed ? "closed" : "active";
    const key = `${t.sheet_id}||${t.tab_name}`;
    const isChecked = _tabDashChecked.has(key);
    // ★ 제출+입금 모두 100% 완료 판정
    const _rc = t._isRoundRow ? (t._roundTotal || 0) : (t.row_count || 0);
    const _sc = t._isRoundRow ? (t._roundSubmitted || 0) : (t.submitted_count || 0);
    const _pc = t._isRoundRow ? (t._roundPaid || 0) : (t.paid_count || 0);
    const _isAllComplete = !t.is_closed && _rc > 0 && _sc >= _rc && _pc >= _rc;
    const bg = isChecked ? "#FEF9C3" : _isAllComplete ? "#FFF0F5" : (st === "closed" ? "#FEF2F2" : "#fff");
    const hoverBg = isChecked ? "#FEF08A" : _isAllComplete ? "#FCE7F3" : "#EFF6FF";
    const leftBorder = _isAllComplete ? "border-left:4px solid #EC4899;" : "";
    html += `<tr style="background:${bg};${leftBorder}border-bottom:1px solid #F3F4F6" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${bg}'">`;
    // 체크박스 열
    html += `<td style="padding:5px;text-align:center;width:30px"><input type="checkbox" ${isChecked?'checked':''} onchange="_toggleTabDashCheck('${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}',this.checked)" style="width:14px;height:14px;cursor:pointer"></td>`;
    visibleCols.forEach(c => {
      const mw = c.width ? c.width : c.key==='campaign_name'?'140px':c.key==='tab_name'?'180px':'120px';
      html += `<td style="padding:5px;text-align:${c.align};max-width:${mw};${c.width?'width:'+c.width+';':''};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(String(t[c.key]||''))}">${_cellVal(t, c)}</td>`;
    });
    if (!_tabDashSimple) html += `<td style="padding:5px;text-align:center"><button onclick="openTabDashDetail(${idx})" style="background:none;border:none;color:#1D4ED8;cursor:pointer;font-size:.78rem"><i class="fas fa-expand-alt"></i></button></td>`;
    html += `</tr>`;
  });

  html += "</tbody></table>";
  wrap.innerHTML = html;
  wrap.style.maxHeight = "600px";
  wrap.style.overflowY = "auto";
}

// ── 체크박스 토글 ──
function _toggleTabDashCheck(sheetId, tabName, checked) {
  const key = `${sheetId}||${tabName}`;
  if (checked) _tabDashChecked.add(key); else _tabDashChecked.delete(key);
  _updateArchiveBar();
}

function _toggleAllTabDashCheck(checked) {
  const filtered = _filterTabDashData();
  filtered.forEach(t => {
    const key = `${t.sheet_id}||${t.tab_name}`;
    if (checked) _tabDashChecked.add(key); else _tabDashChecked.delete(key);
  });
  renderTabDashTable();
}

function _clearTabDashChecked() {
  _tabDashChecked.clear();
  renderTabDashTable();
}

function _updateArchiveBar() {
  const bar = document.getElementById('tabDashArchiveBar');
  if (!bar) { renderTabDashTable(); return; }
  const n = _tabDashChecked.size;
  if (n > 0) {
    bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:6px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;flex-wrap:wrap;position:sticky;top:0;z-index:20;box-shadow:0 2px 8px rgba(245,158,11,.15)";
    bar.innerHTML = `
      <span style="font-size:.78rem;font-weight:600;color:#92400E"><i class="fas fa-check-square" style="margin-right:4px"></i>${n}건 선택됨</span>
      <button onclick="_archiveCheckedTabs()" style="padding:4px 12px;background:#DC2626;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px"><i class="fas fa-archive"></i> 마감으로 보내기</button>
      <button onclick="_checkSubmissionStatus()" style="padding:4px 12px;background:#0891B2;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px"><i class="fas fa-clipboard-check"></i> 마감자료 검수</button>
      <button onclick="_clearTabDashChecked()" style="padding:4px 10px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.72rem;cursor:pointer">선택 해제</button>`;
  } else {
    bar.style.display = "none";
    bar.innerHTML = "";
  }
}

// ── 리뷰폴더 중복검사 ──
async function _checkDuplicateReviewFolders() {
  if (_tabDashChecked.size === 0) { showToast('중복검사할 탭을 선택하세요.', 'info'); return; }

  // 선택된 탭의 folder_url 수집
  const folderUrls = [];
  const tabInfo = [];
  _tabDashChecked.forEach(key => {
    const [sheetId, tabName] = key.split('||');
    const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id === sheetId && x.tab_name === tabName);
    if (t && t.folder_url) {
      folderUrls.push(t.folder_url);
      tabInfo.push({ campaign: t.campaign_name, tab: t.tab_name, url: t.folder_url });
    }
  });

  if (folderUrls.length === 0) {
    showToast('선택된 탭 중 리뷰폴더가 설정된 탭이 없습니다.', 'warning');
    return;
  }

  // 로딩 모달 표시
  _showDuplicateModal('loading', { tabInfo });

  try {
    const res = await gasPost({ action: 'checkDuplicates', folderUrls });
    if (res.error) {
      _showDuplicateModal('error', { message: res.error });
      return;
    }
    _showDuplicateModal('results', { results: res.results, totalDuplicateFiles: res.totalDuplicateFiles, tabInfo });
  } catch (err) {
    _showDuplicateModal('error', { message: err.message || '중복검사 중 오류 발생' });
  }
}

function _showDuplicateModal(state, data) {
  let modal = document.getElementById('duplicateCheckModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'duplicateCheckModal';
    document.body.appendChild(modal);
  }

  if (state === 'loading') {
    modal.innerHTML = `
      <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
        <div style="background:#fff;border-radius:12px;padding:24px;width:90%;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 16px;font-size:1rem;color:#1F2937"><i class="fas fa-spinner fa-spin" style="margin-right:8px;color:#3182f6"></i>리뷰폴더 중복검사 중...</h3>
          <div style="font-size:.8rem;color:#6B7280">
            <p>${(data.tabInfo||[]).length}개 폴더를 검사하고 있습니다. 잠시 기다려주세요...</p>
            <ul style="margin-top:8px;padding-left:16px">${(data.tabInfo||[]).map(t => `<li>${escHtml(t.campaign)} / ${escHtml(t.tab)}</li>`).join('')}</ul>
          </div>
        </div>
      </div>`;
    return;
  }

  if (state === 'error') {
    modal.innerHTML = `
      <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
        <div style="background:#fff;border-radius:12px;padding:24px;width:90%;max-width:500px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 12px;font-size:1rem;color:#DC2626"><i class="fas fa-exclamation-circle" style="margin-right:8px"></i>오류</h3>
          <p style="font-size:.82rem;color:#6B7280">${escHtml(data.message)}</p>
          <div style="text-align:right;margin-top:16px">
            <button onclick="document.getElementById('duplicateCheckModal').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem">닫기</button>
          </div>
        </div>
      </div>`;
    return;
  }

  if (state === 'results') {
    const { results, totalDuplicateFiles, tabInfo } = data;
    let html = `
      <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
        <div style="background:#fff;border-radius:12px;padding:24px;width:95%;max-width:750px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 16px;font-size:1rem;color:#1F2937"><i class="fas fa-copy" style="margin-right:8px;color:#3182f6"></i>리뷰폴더 중복검사 결과</h3>`;

    if (totalDuplicateFiles === 0) {
      html += `<div style="text-align:center;padding:24px;color:#0ca678;font-size:.88rem">
        <i class="fas fa-check-circle" style="font-size:2rem;margin-bottom:8px;display:block"></i>
        <b>중복 파일이 없습니다!</b><br><span style="font-size:.75rem;color:#6B7280">${tabInfo.length}개 폴더를 검사했습니다.</span>
      </div>`;
    } else {
      html += `<div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.78rem;color:#92400E">
        <i class="fas fa-exclamation-triangle" style="margin-right:6px"></i>
        <b>${totalDuplicateFiles}개 중복 파일</b>이 발견되었습니다. 아래 목록을 확인 후 [중복파일 제거] 버튼을 클릭하면 휴지통으로 이동됩니다.
      </div>`;

      // 폴더별 결과 표시
      const allRemoveIds = [];
      results.forEach((r, rIdx) => {
        if (r.error) {
          html += `<div style="margin-bottom:8px;padding:8px;background:#FEF2F2;border-radius:6px;font-size:.75rem;color:#DC2626">
            <b>${escHtml(tabInfo[rIdx]?.campaign || '')} / ${escHtml(tabInfo[rIdx]?.tab || '')}</b> — 오류: ${escHtml(r.error)}
          </div>`;
          return;
        }
        if (!r.duplicates || r.duplicates.length === 0) return;

        html += `<div style="margin-bottom:12px;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden">
          <div style="background:#F3F4F6;padding:8px 12px;font-size:.78rem;font-weight:600;color:#374151">
            <i class="fas fa-folder-open" style="margin-right:4px;color:#3182f6"></i>
            ${escHtml(tabInfo[rIdx]?.campaign || '')} / ${escHtml(tabInfo[rIdx]?.tab || '')}
            <span style="font-weight:400;color:#6B7280;margin-left:8px">전체 ${r.totalFiles}개 파일 중 ${r.duplicateFileCount}개 중복</span>
          </div>
          <div style="padding:8px 12px">`;

        r.duplicates.forEach(g => {
          html += `<div style="margin-bottom:6px;padding:6px;background:#FAFAFA;border-radius:4px;font-size:.72rem">
            <div style="color:#0ca678;margin-bottom:3px"><i class="fas fa-check" style="margin-right:4px"></i><b>유지:</b> ${escHtml(g.keep.name)} <span style="color:#9CA3AF">(${_formatFileSize(g.keep.size)}, ${_formatDate(g.keep.createdTime)})</span></div>`;
          g.remove.forEach(f => {
            allRemoveIds.push(f.id);
            html += `<div style="color:#DC2626;margin-left:14px"><i class="fas fa-trash-alt" style="margin-right:4px"></i><b>제거:</b> ${escHtml(f.name)} <span style="color:#9CA3AF">(${_formatFileSize(f.size)}, ${_formatDate(f.createdTime)})</span></div>`;
          });
          html += `</div>`;
        });
        html += `</div></div>`;
      });

      // 전역 data에 저장
      window._duplicateRemoveIds = allRemoveIds;
      html += `<div style="text-align:right;margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('duplicateCheckModal').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem">닫기</button>
        <button onclick="_executeDuplicateRemoval()" style="padding:6px 16px;background:#DC2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:600"><i class="fas fa-trash-alt" style="margin-right:4px"></i>중복파일 제거 (${allRemoveIds.length}개)</button>
      </div>`;
    }

    if (totalDuplicateFiles === 0) {
      html += `<div style="text-align:right;margin-top:16px">
        <button onclick="document.getElementById('duplicateCheckModal').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem">닫기</button>
      </div>`;
    }

    html += `</div></div>`;
    modal.innerHTML = html;
  }
}

async function _executeDuplicateRemoval() {
  const fileIds = window._duplicateRemoveIds;
  if (!fileIds || fileIds.length === 0) { showToast('제거할 파일이 없습니다.', 'info'); return; }

  if (!confirm(`${fileIds.length}개 중복 파일을 휴지통으로 이동하시겠습니까?\n\n(Google Drive 휴지통에서 30일 이내 복원 가능)`)) return;

  // 로딩 상태
  const modal = document.getElementById('duplicateCheckModal');
  if (modal) {
    const btn = modal.querySelector('button[onclick="_executeDuplicateRemoval()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 제거 중...'; }
  }

  try {
    const res = await gasPost({ action: 'removeDuplicates', fileIds });
    if (res.error) {
      showToast(res.error, 'error');
      return;
    }
    showToast(`✅ ${res.success}개 중복 파일이 휴지통으로 이동되었습니다.${res.failed > 0 ? ` (${res.failed}개 실패)` : ''}`, 'success');
    if (modal) modal.remove();
    window._duplicateRemoveIds = null;
  } catch (err) {
    showToast('중복 제거 중 오류: ' + (err.message || '알 수 없는 오류'), 'error');
  }
}

function _formatFileSize(bytes) {
  if (!bytes) return '0B';
  const n = parseInt(bytes, 10);
  if (n < 1024) return n + 'B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + 'KB';
  return (n/(1024*1024)).toFixed(1) + 'MB';
}

function _formatDate(isoStr) {
  if (!isoStr) return '';
  try { return new Date(isoStr).toLocaleDateString('ko-KR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
  catch(_) { return isoStr; }
}

// ── 제출현황 검사 (마감검사 강화) ──
async function _executeSubmissionDuplicateRemoval() {
  const fileIds = window._submissionRemoveIds;
  if (!fileIds || fileIds.length === 0) { showToast('제거할 파일이 없습니다.', 'info'); return; }

  if (!confirm(`${fileIds.length}개 중복 파일을 휴지통으로 이동하시겠습니까?\n\n(Google Drive 휴지통에서 30일 이내 복원 가능)`)) return;

  const modal = document.getElementById('submissionStatusModal');
  if (modal) {
    const btn = modal.querySelector('button[onclick="_executeSubmissionDuplicateRemoval()"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 제거 중...'; }
  }

  try {
    const res = await gasPost({ action: 'removeDuplicates', fileIds });
    if (res.error) { showToast(res.error, 'error'); return; }
    showToast(`${res.success}개 중복 파일이 휴지통으로 이동되었습니다.${res.failed > 0 ? ` (${res.failed}개 실패)` : ''}`, 'success');
    if (modal) modal.remove();
    window._submissionRemoveIds = null;
  } catch (err) {
    showToast('중복 제거 중 오류: ' + (err.message || '알 수 없는 오류'), 'error');
  }
}

async function _checkSubmissionStatus() {
  if (_tabDashChecked.size === 0) { showToast('검사할 탭을 선택하세요.', 'info'); return; }

  // 선택된 탭의 정보 수집
  const tabs = [];
  _tabDashChecked.forEach(key => {
    const [sheetId, tabName] = key.split('||');
    const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id === sheetId && x.tab_name === tabName);
    if (t && t.folder_url) {
      tabs.push({ sheetId, tabName, folderUrl: t.folder_url, campaign: t.campaign_name });
    }
  });

  if (tabs.length === 0) {
    showToast('선택된 탭 중 리뷰폴더가 설정된 탭이 없습니다.', 'warning');
    return;
  }

  // 로딩 모달 표시
  _showSubmissionStatusModal('loading', { tabs });

  try {
    const res = await gasPost({ action: 'checkSubmissionStatus', tabs: tabs.map(t => ({ sheetId: t.sheetId, tabName: t.tabName, folderUrl: t.folderUrl })) });
    if (res.error) {
      _showSubmissionStatusModal('error', { message: res.error });
      return;
    }
    _showSubmissionStatusModal('results', { results: res.results, tabs });
  } catch (err) {
    _showSubmissionStatusModal('error', { message: err.message || '제출현황 검사 중 오류 발생' });
  }
}

function _showSubmissionStatusModal(state, data) {
  let modal = document.getElementById('submissionStatusModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'submissionStatusModal';
    document.body.appendChild(modal);
  }

  if (state === 'loading') {
    modal.innerHTML = `
      <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
        <div style="background:#fff;border-radius:12px;padding:24px;width:90%;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 16px;font-size:1rem;color:#1F2937"><i class="fas fa-spinner fa-spin" style="margin-right:8px;color:#0891B2"></i>제출현황 검사 중...</h3>
          <div style="font-size:.8rem;color:#6B7280">
            <p>${(data.tabs||[]).length}개 탭을 검사하고 있습니다. 폴더 내 모든 파일을 확인합니다...</p>
            <ul style="margin-top:8px;padding-left:16px">${(data.tabs||[]).map(t => `<li>${escHtml(t.campaign||'')} / ${escHtml(t.tabName)}</li>`).join('')}</ul>
          </div>
        </div>
      </div>`;
    return;
  }

  if (state === 'error') {
    modal.innerHTML = `
      <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
        <div style="background:#fff;border-radius:12px;padding:24px;width:90%;max-width:500px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 12px;font-size:1rem;color:#DC2626"><i class="fas fa-exclamation-circle" style="margin-right:8px"></i>오류</h3>
          <p style="font-size:.82rem;color:#6B7280">${escHtml(data.message)}</p>
          <div style="text-align:right;margin-top:16px">
            <button onclick="document.getElementById('submissionStatusModal').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem">닫기</button>
          </div>
        </div>
      </div>`;
    return;
  }

  if (state === 'results') {
    const { results, tabs } = data;
    let html = `
      <div class="toss-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
        <div style="background:#fff;border-radius:12px;padding:24px;width:95%;max-width:800px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 16px;font-size:1rem;color:#1F2937"><i class="fas fa-clipboard-check" style="margin-right:8px;color:#0891B2"></i>마감자료 검수 결과</h3>`;

    let totalIssues = 0;
    const allRemoveIds = [];

    results.forEach((r, rIdx) => {
      const tabLabel = `${escHtml(tabs[rIdx]?.campaign||'')} / ${escHtml(r.tabName||tabs[rIdx]?.tabName||'')}`;

      if (r.error) {
        html += `<div style="margin-bottom:8px;padding:8px;background:#FEF2F2;border-radius:6px;font-size:.75rem;color:#DC2626">
          <b>${tabLabel}</b> — 오류: ${escHtml(r.error)}
        </div>`;
        return;
      }

      const { summary } = r;
      const issueCount = (summary.fileDuplicateCount||0) + summary.duplicateCount + summary.missingCount + summary.orphanCount;
      totalIssues += issueCount;

      html += `<div style="margin-bottom:12px;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden">
        <div style="background:#F3F4F6;padding:8px 12px;font-size:.78rem;font-weight:600;color:#374151;display:flex;align-items:center;justify-content:space-between">
          <span><i class="fas fa-folder-open" style="margin-right:4px;color:#0891B2"></i>${tabLabel}</span>
          <span style="font-weight:400;color:#6B7280;font-size:.72rem">수취인 ${r.totalRecipients}명 | 파일 ${r.totalFiles}개 | 제출자 ${r.totalFileNames}명</span>
        </div>`;

      if (issueCount === 0) {
        html += `<div style="padding:12px;text-align:center;color:#0ca678;font-size:.82rem">
          <i class="fas fa-check-circle" style="margin-right:4px"></i> 이상 없음
        </div>`;
      } else {
        html += `<div style="padding:8px 12px">`;

        // (a) 파일 중복 (md5)
        if (summary.fileDuplicateCount > 0) {
          html += `<div style="margin-bottom:8px">
            <div style="font-size:.75rem;font-weight:600;color:#DC2626;margin-bottom:4px"><i class="fas fa-copy" style="margin-right:4px"></i>파일 중복 (${summary.fileDuplicateCount}그룹, ${summary.fileDuplicateFileCount}개 제거 가능)</div>`;
          (r.fileDuplicates||[]).forEach(g => {
            html += `<div style="margin-left:12px;font-size:.72rem;color:#4B5563;padding:3px 0;border-bottom:1px solid #F3F4F6">
              <span style="color:#0ca678"><i class="fas fa-check" style="margin-right:2px"></i>유지:</span> ${escHtml(g.keep.name)} <span style="color:#9CA3AF">(${_formatFileSize(g.keep.size)})</span>`;
            g.remove.forEach(f => {
              allRemoveIds.push(f.id);
              html += `<br><span style="color:#DC2626;margin-left:14px"><i class="fas fa-trash-alt" style="margin-right:2px"></i>제거:</span> ${escHtml(f.name)} <span style="color:#9CA3AF">(${_formatFileSize(f.size)})</span>`;
            });
            html += `</div>`;
          });
          html += `</div>`;
        }

        // (b) 중복 제출
        if (summary.duplicateCount > 0) {
          html += `<div style="margin-bottom:8px">
            <div style="font-size:.75rem;font-weight:600;color:#F97316;margin-bottom:4px"><i class="fas fa-clone" style="margin-right:4px"></i>중복 제출 (${summary.duplicateCount}명)</div>`;
          r.duplicateSubmissions.forEach(d => {
            html += `<div style="margin-left:12px;font-size:.72rem;color:#4B5563;padding:3px 0;border-bottom:1px solid #F3F4F6">
              <b>${escHtml(d.name)}</b> — ${d.submissionCount}회 제출 (파일 ${d.totalFiles}개)
              <span style="color:#9CA3AF;margin-left:4px">${d.submissions.map(s => s.timestamp.replace('_',' ')).join(', ')}</span>
            </div>`;
          });
          html += `</div>`;
        }

        // (c) 미제출자
        if (summary.missingCount > 0) {
          html += `<div style="margin-bottom:8px">
            <div style="font-size:.75rem;font-weight:600;color:#F59E0B;margin-bottom:4px"><i class="fas fa-user-slash" style="margin-right:4px"></i>미제출자 (${summary.missingCount}명)</div>`;
          r.missingSubmissions.forEach(m => {
            html += `<div style="margin-left:12px;font-size:.72rem;color:#4B5563;padding:2px 0">
              <b>${escHtml(m.name)}</b> <span style="color:#9CA3AF">(${m.rowCount}건)</span>
            </div>`;
          });
          html += `</div>`;
        }

        // (d) 고아 파일
        if (summary.orphanCount > 0) {
          html += `<div style="margin-bottom:8px">
            <div style="font-size:.75rem;font-weight:600;color:#3182f6;margin-bottom:4px"><i class="fas fa-ghost" style="margin-right:4px"></i>고아 파일 (${summary.orphanCount}명)</div>`;
          r.orphanFiles.forEach(o => {
            html += `<div style="margin-left:12px;font-size:.72rem;color:#4B5563;padding:2px 0">
              <b>${escHtml(o.name)}</b> — ${o.files.length}개 파일
              <span style="color:#9CA3AF">${o.files.map(f => escHtml(f.name)).slice(0,3).join(', ')}${o.files.length > 3 ? '...' : ''}</span>
            </div>`;
          });
          html += `</div>`;
        }

        html += `</div>`;
      }
      html += `</div>`;
    });

    // 요약 배너
    if (totalIssues === 0) {
      html = html.replace('</h3>', '</h3><div style="background:#ECFDF5;border:1px solid #0ca678;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.82rem;color:#065F46;text-align:center"><i class="fas fa-check-circle" style="margin-right:6px"></i><b>모든 탭에서 이상이 발견되지 않았습니다.</b></div>');
    } else {
      html = html.replace('</h3>', `</h3><div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.78rem;color:#92400E"><i class="fas fa-exclamation-triangle" style="margin-right:6px"></i><b>${totalIssues}건의 이슈</b>가 발견되었습니다.</div>`);
    }

    // 하단 버튼: 중복 파일이 있으면 제거 버튼 표시
    window._submissionRemoveIds = allRemoveIds;
    html += `<div style="text-align:right;margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
      <button onclick="document.getElementById('submissionStatusModal').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem">닫기</button>`;
    if (allRemoveIds.length > 0) {
      html += `<button onclick="_executeSubmissionDuplicateRemoval()" style="padding:6px 16px;background:#DC2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:600"><i class="fas fa-trash-alt" style="margin-right:4px"></i>중복파일 제거 (${allRemoveIds.length}개)</button>`;
    }
    html += `</div></div></div>`;
    modal.innerHTML = html;
  }
}

// ── 마감 실행 ──
async function _archiveCheckedTabs() {
  if (_tabDashChecked.size === 0) { showToast('마감할 탭을 선택하세요.', 'info'); return; }

  // 선택된 탭 정보 수집 (roundList 포함)
  const selectedTabs = [];
  _tabDashChecked.forEach(key => {
    const [sheetId, tabName] = key.split('||');
    const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id === sheetId && x.tab_name === tabName);
    selectedTabs.push({
      sheetId, tabName,
      campaignName: t?.campaign_name || '',
      roundList: t?.roundList || [],
      displayName: t ? `${t.campaign_name}/${t.tab_name}` : tabName,
    });
  });

  // 차수가 있는 탭이 포함되어 있으면 차수 선택 모달 표시
  const hasRounds = selectedTabs.some(t => t.roundList.length > 1);
  if (hasRounds) {
    _showArchiveRoundModal(selectedTabs);
    return;
  }

  // 차수가 없는 탭은 기존 방식(탭 전체 마감)
  const tabs = selectedTabs.map(t => ({ sheetId: t.sheetId, tabName: t.tabName }));
  const names = selectedTabs.map(t => t.displayName);

  const confirmed = confirm(`선택한 ${tabs.length}건을 마감으로 보내시겠습니까?\n\n` +
    `마감된 탭은:\n` +
    `• 스마트빌드 갱신에서 스킵\n` +
    `• 인덱스 스캔에서 스킵\n` +
    `• DB 동기화에서 스킵\n` +
    `• 탭명/URL 동기화에서 스킵\n\n` +
    names.slice(0, 10).join('\n') + (names.length > 10 ? `\n... 외 ${names.length - 10}건` : ''));
  if (!confirmed) return;

  await _executeArchive(tabs, 'manual_dashboard');
}

// ── 차수 선택 마감 모달 ──
// ▼▼▼ [임시] 드라이브 소유권(용량) 이관 도구 — 전부 tnaks6325 이관 완료 후 이 블록 삭제 ▼▼▼
// 관련: admin.html #btnDriveOwnership 버튼 / api.js driveAccountInfo·driveOwnershipAudit·driveTransferOwnership
const DRIVE_OWN_TARGET = 'tnaks6325@gmail.com';

function openDriveOwnershipModal() {
  const old = document.getElementById('driveOwnModal');
  if (old) old.remove();
  const html = `
  <div id="driveOwnModal" class="toss-overlay" style="position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.5);padding:24px 12px;overflow-y:auto">
    <div style="background:#fff;border-radius:16px;max-width:720px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.35);overflow:hidden">
      <div style="background:linear-gradient(135deg,#FACC15,#F59E0B);padding:16px 22px;display:flex;align-items:center;justify-content:space-between">
        <h3 style="margin:0;font-size:1.05rem;font-weight:800;color:#7C2D12;display:flex;align-items:center;gap:8px">
          <i class="fas fa-hdd"></i> 드라이브 용량 이관 <span style="background:#7C2D12;color:#FDE68A;font-size:.62rem;padding:2px 7px;border-radius:7px">임시 도구</span>
        </h3>
        <button onclick="closeDriveOwnershipModal()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:#7C2D12"><i class="fas fa-times"></i></button>
      </div>
      <div style="padding:18px 22px;max-height:calc(90vh - 60px);overflow-y:auto">
        <!-- 도움말 / 진행방법 -->
        <div style="background:#FEFCE8;border:1px solid #FDE68A;border-radius:12px;padding:14px 16px;margin-bottom:16px">
          <div style="font-weight:800;color:#92400E;font-size:.85rem;margin-bottom:8px"><i class="fas fa-circle-info"></i> 진행방법 (도움말)</div>
          <p style="margin:0 0 10px;font-size:.76rem;color:#78350F;line-height:1.55">
            구글드라이브 용량은 <b>파일 소유자 계정</b>에 귀속됩니다. 구매캡처·리뷰 업로드가
            관리자(박세희·박은비) 계정 용량을 차지하는 문제를 점검·이관하는 임시 도구입니다.
            <b>아래 ①~④ 순서대로</b> 진행하세요.
          </p>
          <ol style="margin:0;padding-left:18px;font-size:.76rem;color:#78350F;line-height:1.7">
            <li><b>① 계정 확인</b> — 업로드 용량이 어느 구글계정에 잡히는지 확인.
                <span style="color:#B45309">tnaks6325가 아니면</span> Railway 환경변수
                <code style="background:#FEF3C7;padding:1px 4px;border-radius:4px">DRIVE_OAUTH_REFRESH_TOKEN</code>을
                tnaks6325 계정 토큰으로 교체하면 <b>이후 업로드는 영구 해결</b>됩니다.</li>
            <li><b>② 용량 점검</b> — 캡처·리뷰 폴더를 스캔해 <b>소유자별 파일수·용량</b>을 집계합니다.</li>
            <li><b>③ 이관 미리보기</b> — 실제 변경 없이(dry-run) 이관 대상 파일을 먼저 확인합니다.</li>
            <li><b>④ 이관 실행</b> — tnaks6325로 소유권 이관(데이터 삭제 없음, 되돌릴 수 있음).
                <span style="color:#B45309">단, 관리자 소유 파일은 관리자 본인 자격이 필요</span>해
                실패할 수 있으며, 그 경우 관리자가 직접 이관하거나 관리자 토큰이 필요합니다.</li>
          </ol>
          <p style="margin:10px 0 0;font-size:.72rem;color:#A16207">※ 이 버튼은 모든 소유권이 tnaks6325로 이관되면 삭제될 예정입니다.</p>
        </div>
        <!-- 액션 버튼 -->
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px">
          <button onclick="driveOwnAccountCheck()" style="padding:11px;background:#FEF9C3;border:1.5px solid #EAB308;border-radius:10px;font-size:.82rem;font-weight:700;color:#854D0E;cursor:pointer"><i class="fas fa-id-card"></i> ① 계정 확인</button>
          <button onclick="driveOwnAudit()" style="padding:11px;background:#FEF9C3;border:1.5px solid #EAB308;border-radius:10px;font-size:.82rem;font-weight:700;color:#854D0E;cursor:pointer"><i class="fas fa-chart-pie"></i> ② 용량 점검</button>
          <button onclick="driveOwnTransfer(false)" style="padding:11px;background:#FEF9C3;border:1.5px solid #EAB308;border-radius:10px;font-size:.82rem;font-weight:700;color:#854D0E;cursor:pointer"><i class="fas fa-eye"></i> ③ 이관 미리보기</button>
          <button onclick="driveOwnTransfer(true)" style="padding:11px;background:linear-gradient(135deg,#F59E0B,#D97706);border:1.5px solid #B45309;border-radius:10px;font-size:.82rem;font-weight:800;color:#fff;cursor:pointer"><i class="fas fa-right-left"></i> ④ 이관 실행</button>
        </div>
        <div id="driveOwnResult" style="min-height:60px;font-size:.78rem;color:#374151"></div>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function closeDriveOwnershipModal() {
  document.getElementById('driveOwnModal')?.remove();
}

function _driveOwnSetResult(html) {
  const el = document.getElementById('driveOwnResult');
  if (el) el.innerHTML = html;
}

function _driveOwnLoading(msg) {
  _driveOwnSetResult(`<div style="padding:14px;text-align:center;color:#92400E"><i class="fas fa-spinner fa-spin"></i> ${escHtml(msg || '처리 중...')}</div>`);
}

async function driveOwnAccountCheck() {
  _driveOwnLoading('현재 OAuth 계정/용량 조회 중...');
  const r = await gasGet({ action: 'driveAccountInfo' }, 30000);
  if (!r || r.ok === false || r.error) { _driveOwnSetResult(`<div style="color:#DC2626">조회 실패: ${escHtml((r && r.error) || '알수없음')}</div>`); return; }
  const o = r.oauth || {};
  const target = r.expectedOwnerEmail || DRIVE_OWN_TARGET;
  let body = '';
  if (!o.configured) {
    body = `<div style="color:#DC2626;font-weight:700">❌ OAuth 미설정 (DRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN)</div>`;
  } else if (o.error) {
    body = `<div style="color:#DC2626">❌ 계정 조회 실패: ${escHtml(o.error)}</div>`;
  } else {
    const match = o.matchesExpectedOwner;
    const badge = match === true
      ? `<span style="color:#059669;font-weight:800">✅ 일치 (정상)</span>`
      : `<span style="color:#DC2626;font-weight:800">❌ 불일치 — 이 계정에 용량이 잡힙니다</span>`;
    const q = o.quota || {};
    body = `
      <div style="line-height:1.8">
        <div>현재 업로드 계정: <b>${escHtml(o.email || '-')}</b> ${o.displayName ? `(${escHtml(o.displayName)})` : ''}</div>
        <div>기대 계정: <b>${escHtml(target)}</b></div>
        <div>일치 여부: ${badge}</div>
        ${q.limit != null ? `<div>저장용량: <b>${escHtml(q.usageHuman || '?')}</b> / ${escHtml(q.limitHuman || '?')}${q.usedPercent != null ? ` (${q.usedPercent}%)` : ''}</div>` : ''}
      </div>
      ${match === false ? `<div style="margin-top:10px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px;color:#991B1B;font-size:.74rem">
        ⚠️ Railway 환경변수 <code>DRIVE_OAUTH_REFRESH_TOKEN</code>을 <b>${escHtml(target)}</b> 계정 토큰으로 교체하면
        이후 업로드 용량은 정상 귀속됩니다. (기존 파일은 ②~④로 이관)
      </div>` : ''}`;
  }
  _driveOwnSetResult(body);
}

async function driveOwnAudit() {
  _driveOwnLoading('폴더 스캔 및 소유자별 용량 집계 중... (파일이 많으면 시간이 걸립니다)');
  const r = await gasPost({ action: 'driveOwnershipAudit' }, 180000);
  if (!r || r.ok === false || r.error) { _driveOwnSetResult(`<div style="color:#DC2626">집계 실패: ${escHtml((r && r.error) || '알수없음')}</div>`); return; }
  const owners = r.owners || [];
  let rows = owners.map(o => {
    const isTarget = (o.email || '').toLowerCase() === DRIVE_OWN_TARGET.toLowerCase();
    const color = isTarget ? '#059669' : '#DC2626';
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #F3F4F6;color:${color};font-weight:${isTarget ? 700 : 600}">${escHtml(o.email)}${o.displayName ? ` <span style="color:#9CA3AF;font-weight:400">(${escHtml(o.displayName)})</span>` : ''}${isTarget ? ' ✅' : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #F3F4F6;text-align:right">${o.fileCount}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #F3F4F6;text-align:right;font-weight:700">${escHtml(o.totalHuman || '-')}</td>
    </tr>`;
  }).join('');
  if (!rows) rows = `<tr><td colspan="3" style="padding:10px;color:#9CA3AF;text-align:center">파일이 없습니다.</td></tr>`;
  _driveOwnSetResult(`
    <div style="margin-bottom:6px">스캔 폴더 ${r.scannedFolders}개 · 총 ${r.totalFiles}개 파일 · 합계 <b>${escHtml(r.totalHuman || '-')}</b>${r.elapsed != null ? ` · ${r.elapsed}초` : ''}</div>
    <table style="width:100%;border-collapse:collapse;font-size:.76rem">
      <thead><tr style="background:#FEF9C3;color:#854D0E">
        <th style="padding:6px 8px;text-align:left">소유자</th><th style="padding:6px 8px;text-align:right">파일수</th><th style="padding:6px 8px;text-align:right">용량</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${(r.errors && r.errors.length) ? `<div style="margin-top:8px;color:#B45309;font-size:.72rem">⚠️ 스캔 실패 폴더 ${r.errors.length}개</div>` : ''}
    <div style="margin-top:8px;color:#6B7280;font-size:.72rem">빨간색 = tnaks6325가 아닌 계정(이관 대상) · 초록색 = 정상 귀속</div>
  `);
}

async function driveOwnTransfer(apply) {
  if (apply) {
    if (!confirm('비-tnaks6325 소유 파일의 소유권을 tnaks6325로 이관합니다.\n(데이터 삭제 없음 · 되돌릴 수 있음)\n\n진행할까요?')) return;
  }
  _driveOwnLoading(apply ? '소유권 이관 실행 중... (시간이 걸릴 수 있습니다)' : '이관 대상 미리보기 중...');
  const r = await gasPost({ action: 'driveTransferOwnership', dryRun: !apply }, 180000);
  if (!r || r.ok === false || r.error) { _driveOwnSetResult(`<div style="color:#DC2626">실패: ${escHtml((r && r.error) || '알수없음')}</div>`); return; }
  const s = r.summary || {};
  const head = apply
    ? `<div style="font-weight:700;color:#92400E">이관 실행 결과 ${r.elapsed != null ? `(${r.elapsed}초)` : ''}</div>
       <div style="line-height:1.8;margin-top:4px">스캔 ${s.scanned} · 이미 정상 ${s.alreadyOwned} · ✅ 이관성공 <b style="color:#059669">${s.transferred}</b> · ❌ 실패 <b style="color:#DC2626">${s.failed}</b></div>`
    : `<div style="font-weight:700;color:#92400E">이관 미리보기 (dry-run) ${r.elapsed != null ? `(${r.elapsed}초)` : ''}</div>
       <div style="line-height:1.8;margin-top:4px">스캔 ${s.scanned} · 이미 정상 ${s.alreadyOwned} · 이관대상 <b style="color:#B45309">${s.toTransfer}</b></div>`;
  let list = '';
  const acts = r.actions || [];
  if (!apply && acts.length) {
    list = `<div style="margin-top:8px;max-height:180px;overflow-y:auto;border:1px solid #F3F4F6;border-radius:8px">`
      + acts.slice(0, 50).map(a => `<div style="padding:4px 8px;border-bottom:1px solid #F9FAFB;font-size:.72rem"><span style="color:#6B7280">[${escHtml(a.currentOwner || '?')}]</span> ${escHtml(a.name || a.fileId)}</div>`).join('')
      + (acts.length > 50 ? `<div style="padding:4px 8px;color:#9CA3AF;font-size:.72rem">... 외 ${acts.length - 50}개</div>` : '')
      + `</div>`;
  }
  let fail = '';
  const fails = r.failures || [];
  if (fails.length) {
    fail = `<div style="margin-top:10px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px;color:#991B1B;font-size:.72rem">
      ⚠️ 실패/주의 ${fails.length}건 (상위 8):<br>`
      + fails.slice(0, 8).map(f => `· ${escHtml(f.name || f.folderId || '')} <span style="color:#B91C1C">(${escHtml(f.error || '')})</span>`).join('<br>')
      + `<div style="margin-top:6px;color:#7F1D1D">관리자 소유 파일은 관리자 본인 자격(토큰)이 있어야 이관됩니다. 관리자가 직접 이관하거나, Railway에서 관리자 토큰으로 CLI 실행이 필요합니다.</div>
      </div>`;
  }
  let next = '';
  if (!apply && s.toTransfer > 0) next = `<div style="margin-top:8px;color:#B45309;font-size:.74rem">→ 실제 이관하려면 <b>④ 이관 실행</b> 버튼을 누르세요.</div>`;
  _driveOwnSetResult(head + list + fail + next);
}
// ▲▲▲ [임시] 드라이브 소유권(용량) 이관 도구 끝 ▲▲▲

function _showArchiveRoundModal(selectedTabs) {
  // 기존 모달 제거
  let modal = document.getElementById('archiveRoundModal');
  if (modal) modal.remove();

  let html = `<div id="archiveRoundModal" class="toss-overlay" style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)">
    <div style="background:#fff;border-radius:14px;padding:24px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <h3 style="margin:0 0 6px;font-size:1rem;color:#1F2937"><i class="fas fa-archive" style="color:#4593fc;margin-right:6px"></i>마감 차수 선택</h3>
      <p style="margin:0 0 16px;font-size:.78rem;color:#6B7280">마감할 차수를 선택하세요. 선택하지 않은 차수는 대시보드에 유지됩니다.</p>`;

  selectedTabs.forEach((tab, tabIdx) => {
    html += `<div style="margin-bottom:14px;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden">
      <div style="background:#F9FAFB;padding:8px 12px;font-size:.82rem;font-weight:600;color:#374151">
        <i class="fas fa-table" style="color:#3182f6;margin-right:4px"></i>${escHtml(tab.displayName)}
      </div>`;

    if (tab.roundList.length > 1) {
      html += `<div style="padding:8px 12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <label style="font-size:.72rem;color:#6B7280;margin-right:4px">
          <input type="checkbox" class="archive-round-all" data-tab-idx="${tabIdx}" onchange="_toggleArchiveRoundAll(this,${tabIdx})" style="margin-right:3px">전체
        </label>`;
      tab.roundList.forEach((r, rIdx) => {
        const paid = r.paid || 0;
        const pct = _pct(paid, r.total);
        const pctColor = pct >= 100 ? '#0ca678' : pct >= 50 ? '#D97706' : '#6B7280';
        html += `<label style="font-size:.75rem;display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border:1px solid #D1D5DB;border-radius:6px;cursor:pointer;background:#FAFAFA">
          <input type="checkbox" class="archive-round-cb" data-tab-idx="${tabIdx}" data-round="${escHtml(r.round)}" value="${escHtml(r.round)}" style="width:13px;height:13px">
          <span>${escHtml(r.round)}</span>
          <span style="color:${pctColor};font-size:.68rem">(${paid}/${r.total})</span>
        </label>`;
      });
      html += `</div>`;
    } else {
      // 차수가 1개 이하인 탭은 전체 마감
      html += `<div style="padding:8px 12px;font-size:.75rem;color:#9CA3AF">
        <label><input type="checkbox" class="archive-round-cb" data-tab-idx="${tabIdx}" data-round="__ALL__" value="__ALL__" checked style="margin-right:4px">탭 전체 마감</label>
      </div>`;
    }
    html += `</div>`;
  });

  html += `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
      <button onclick="document.getElementById('archiveRoundModal').remove()" style="padding:7px 16px;border:1px solid #D1D5DB;background:#fff;border-radius:8px;font-size:.8rem;cursor:pointer;color:#374151">취소</button>
      <button onclick="_executeArchiveFromModal()" style="padding:7px 16px;background:#4593fc;color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer"><i class="fas fa-archive" style="margin-right:4px"></i>확인</button>
    </div>
    </div></div>`;

  document.body.insertAdjacentHTML('beforeend', html);

  // _selectedTabs를 글로벌에 임시 저장
  window._archiveModalTabs = selectedTabs;
}

function _toggleArchiveRoundAll(checkbox, tabIdx) {
  const cbs = document.querySelectorAll(`.archive-round-cb[data-tab-idx="${tabIdx}"]`);
  cbs.forEach(cb => { cb.checked = checkbox.checked; });
}

async function _executeArchiveFromModal() {
  const selectedTabs = window._archiveModalTabs || [];
  const tabs = [];

  selectedTabs.forEach((tab, tabIdx) => {
    const cbs = document.querySelectorAll(`.archive-round-cb[data-tab-idx="${tabIdx}"]:checked`);
    if (cbs.length === 0) return;

    // "__ALL__" 이면 탭 전체 마감
    const rounds = Array.from(cbs).map(cb => cb.value);
    if (rounds.includes('__ALL__')) {
      tabs.push({ sheetId: tab.sheetId, tabName: tab.tabName });
    } else {
      // 모든 차수가 선택된 경우도 탭 전체 마감으로 처리
      if (tab.roundList.length > 0 && rounds.length === tab.roundList.length) {
        tabs.push({ sheetId: tab.sheetId, tabName: tab.tabName });
      } else {
        // 차수별 개별 마감
        rounds.forEach(round => {
          tabs.push({ sheetId: tab.sheetId, tabName: tab.tabName, round });
        });
      }
    }
  });

  if (tabs.length === 0) {
    showToast('마감할 차수를 선택하세요.', 'info');
    return;
  }

  // 모달 닫기
  document.getElementById('archiveRoundModal')?.remove();

  await _executeArchive(tabs, 'manual_dashboard');
}

async function _executeArchive(tabs, reason) {
  try {
    showToast(`${tabs.length}건 마감 처리 중...`, 'info');
    const res = await fetch(API_BASE_URL + '/api/archive/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
      body: JSON.stringify({ tabs, reason }),
    }).then(r => r.json());

    if (res.ok) {
      showToast(`마감 완료: ${res.archivedTabs}탭, ${res.archivedRows}행`, 'success');
      _tabDashChecked.clear();
      await loadTabDashboard(); // 새로고침
    } else {
      showToast(res.error || '마감 실패', 'error');
    }
  } catch (err) {
    showToast('마감 요청 실패: ' + err.message, 'error');
  }
}

// ── 캠페인 삭제 (기능 제거됨) ──

// ── 시트링크 수동보정 ──
async function _fixSheetUrl(sheetId, tabName) {
  // 모달로 보정 옵션 제공
  const tab = (_tabDashData?.tabs||[]).find(t => t.sheet_id === sheetId && t.tab_name === tabName);
  const currentUrl = tab?.sheet_url || '';
  const currentGid = tab?.tab_gid || '';

  // 기존 모달 제거
  document.getElementById('fixSheetUrlModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'fixSheetUrlModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
  modal.classList.add('toss-overlay');
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:24px;width:480px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <h3 style="margin:0 0 16px;font-size:1rem;color:#1F2937"><i class="fas fa-wrench" style="color:#D97706;margin-right:6px"></i>시트링크 수동보정</h3>
      <div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:10px;margin-bottom:14px;font-size:.78rem;color:#92400E">
        <strong>${escHtml(tabName)}</strong><br>
        현재 URL에 gid가 없어 시트 탭으로 바로 이동할 수 없습니다.
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:.75rem;font-weight:600;color:#374151;display:block;margin-bottom:4px">현재 시트 URL</label>
        <input id="fixSheetUrlInput" type="text" value="${escHtml(currentUrl)}" 
          style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:.78rem;box-sizing:border-box" 
          placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=123456">
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:.75rem;font-weight:600;color:#374151;display:block;margin-bottom:4px">GID (탭 ID)</label>
        <input id="fixSheetGidInput" type="text" value="${escHtml(String(currentGid || ''))}" 
          style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:.78rem;box-sizing:border-box" 
          placeholder="예: 718097009">
        <div style="font-size:.68rem;color:#6B7280;margin-top:4px">
          💡 시트를 열고 URL에서 #gid= 뒤의 숫자를 복사하세요
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:space-between">
        <button onclick="_fixSheetUrlAutoDetect('${escHtml(sheetId)}','${escHtml(tabName)}')" 
          style="padding:8px 14px;background:#e8f1fe;color:#1b64da;border:1px solid #cce0fb;border-radius:8px;font-size:.75rem;font-weight:600;cursor:pointer">
          <i class="fas fa-magic"></i> 자동감지
        </button>
        <div style="display:flex;gap:8px">
          <button onclick="document.getElementById('fixSheetUrlModal').remove()" 
            style="padding:8px 16px;background:#F3F4F6;color:#374151;border:none;border-radius:8px;font-size:.75rem;cursor:pointer">취소</button>
          <button onclick="_fixSheetUrlSave('${escHtml(sheetId)}','${escHtml(tabName)}')" 
            style="padding:8px 16px;background:#3182f6;color:#fff;border:none;border-radius:8px;font-size:.75rem;font-weight:600;cursor:pointer">
            <i class="fas fa-save"></i> 저장</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// 시트링크 자동감지 — Google Sheets 메타에서 gid 가져오기
async function _fixSheetUrlAutoDetect(sheetId, tabName) {
  const btn = event.target.closest('button');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 감지중...';
  try {
    const token = localStorage.getItem('admin_token') || sessionStorage.getItem('admin_token');
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    const resp = await fetch(`/api/diag/preview-campaign?url=${encodeURIComponent(url)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '시트 메타 조회 실패');
    
    const tabs = data.tabs || [];
    const matched = tabs.find(t => t.name === tabName);
    if (matched && matched.gid) {
      document.getElementById('fixSheetGidInput').value = matched.gid;
      showToast(`GID 자동감지 완료: ${matched.gid}`, 'success');
    } else {
      // 부분 매칭 시도
      const partial = tabs.find(t => t.name.includes(tabName) || tabName.includes(t.name));
      if (partial && partial.gid) {
        document.getElementById('fixSheetGidInput').value = partial.gid;
        showToast(`GID 유사매칭: ${partial.name} → ${partial.gid}`, 'success');
      } else {
        showToast('탭 이름과 매칭되는 GID를 찾지 못했습니다. 수동으로 입력해주세요.', 'warn');
      }
    }
  } catch (err) {
    showToast(`자동감지 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic"></i> 자동감지';
  }
}

// 시트링크 보정 저장
async function _fixSheetUrlSave(sheetId, tabName) {
  const urlInput = document.getElementById('fixSheetUrlInput').value.trim();
  const gidInput = document.getElementById('fixSheetGidInput').value.trim();

  if (!gidInput && !urlInput.includes('#gid=')) {
    showToast('GID를 입력하거나 URL에 #gid=를 포함해주세요.', 'warn');
    return;
  }

  try {
    const token = localStorage.getItem('admin_token') || sessionStorage.getItem('admin_token');
    const body = { sheetId, tabName };
    if (gidInput) body.gid = gidInput;
    if (urlInput) body.sheetUrl = urlInput.includes('#gid=') ? urlInput : (gidInput ? `${urlInput.split('#')[0]}#gid=${gidInput}` : urlInput);

    const resp = await fetch(API_BASE_URL + '/api/tab/fix-sheet-urls', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || '저장 실패');

    showToast(`시트링크 보정 완료: ${tabName}`, 'success');
    document.getElementById('fixSheetUrlModal')?.remove();
    await loadTabDashboard();
  } catch (err) {
    showToast(`저장 실패: ${err.message}`, 'error');
  }
}

// ── 상세 모달 ──
function openTabDashDetail(idx) {
  const filtered = _filterTabDashData();
  const t = filtered[idx];
  if (!t) return;
  const modal = document.getElementById("tabDashDetailModal");
  if (!modal) return;

  const title = document.getElementById("tabDashDetailTitle");
  const body = document.getElementById("tabDashDetailBody");
  if (title) title.innerHTML = `<i class="fas fa-info-circle" style="color:#1D4ED8;margin-right:6px"></i>${escHtml(t.display_name || t.tab_name)}`;

  const st = t.is_closed ? "closed" : "active";
  const stLabel = st === "closed" ? "마감" : "활성";
  const stClr = st === "closed" ? "#DC2626" : "#0ca678";
  const rc = t.row_count || 0, sc = t.submitted_count || 0;
  const pct = _pct(sc, rc);

  // 21컬럼 전체를 그룹별로 표시
  const groups = [
    { title:"기본 정보", icon:"fa-id-card", color:"#1D4ED8", items:[
      ["캠페인", t.campaign_name],
      ["탭명", t.tab_name],
      ["표시명(상품)", t.display_name],
      ["담당자", t.manager],
      ["상태", `<span style="color:${stClr};font-weight:600">${stLabel}</span>`],
    ]},
    { title:"운영 설정", icon:"fa-cogs", color:"#3182f6", items:[
      ["리뷰유형", t.review_type],
      ["주문시간대", t.time_range],
      ["차수", t.round],

      ["대량건", t.is_bulk ? "예" : "아니오"],
      ["배송유형", t.delivery_type],
      ["NC모드", t.nc_mode ? "활성" : "비활성"],
    ]},
    { title:"입금 정보", icon:"fa-money-bill-wave", color:"#0ca678", items:[
      ["결제방식", t.payment_type],
      ["입금자명", t.deposit_name],
      ["이체은행", t.transfer_bank],
      ["소득유형", t.income_type],
    ]},
    { title:"인덱스 현황", icon:"fa-chart-bar", color:"#0891B2", items:[
      ["총 인원", rc > 0 ? rc.toLocaleString() + "명" : "—"],
      ["제출 완료", rc > 0 ? `${sc}명 / ${rc}명 (${pct}%)` : "—"],
      ["인덱스 상태", t.index_status || "—"],
      ["빌드 시각", t.index_built_at ? new Date(t.index_built_at).toLocaleString("ko-KR") : "—"],
    ]},
    { title:"링크", icon:"fa-link", color:"#D97706", items:[
      ["리뷰폴더", t.folder_url ? `<a href="${escHtml(t.folder_url)}" target="_blank" style="color:#0ca678;word-break:break-all">${escHtml(t.folder_url)}</a>` : "—"],
      ["캡처폴더", t.capture_folder_url ? `<a href="${escHtml(t.capture_folder_url)}" target="_blank" style="color:#1D4ED8;word-break:break-all">${escHtml(t.capture_folder_url)}</a>` : "—"],
      ["시트 URL", t.sheet_url ? `<a href="${escHtml(t.tab_gid ? t.sheet_url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : t.sheet_url)}" target="_blank" style="color:#3182f6;word-break:break-all">${escHtml(t.tab_gid ? t.sheet_url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : t.sheet_url)}</a>` : "—"],
    ]},
    { title:"시스템", icon:"fa-server", color:"#6B7280", items:[
      ["갱신일", t.updated_at ? new Date(t.updated_at).toLocaleString("ko-KR") : "—"],
      ["시트 ID", t.sheet_id],
      ["체크섬", t.checksum || "—"],
    ]},
  ];

  let html = "";
  groups.forEach(g => {
    html += `<div style="margin-bottom:14px">
      <div style="font-size:.82rem;font-weight:700;color:${g.color};margin-bottom:6px"><i class="fas ${g.icon}" style="margin-right:5px"></i>${g.title}</div>
      <div style="background:#F9FAFB;border-radius:8px;padding:8px 12px">`;
    g.items.forEach(([label, val]) => {
      const display = val != null && val !== "" && val !== undefined ? val : '<span style="color:#D1D5DB">—</span>';
      html += `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #F3F4F6">
        <span style="color:var(--t3);font-weight:500;min-width:90px">${label}</span>
        <span style="color:var(--t1);text-align:right;flex:1;margin-left:12px">${display}</span>
      </div>`;
    });
    html += `</div></div>`;
  });

  body.innerHTML = html;
  modal.style.display = "flex";
}

function closeTabDashDetail() {
  const modal = document.getElementById("tabDashDetailModal");
  if (modal) modal.style.display = "none";
}

// ── CSV 내보내기 ──
function exportTabDashCSV() {
  if (!_tabDashData || !_tabDashData.tabs) { showToast("먼저 데이터를 로드하세요.", "info"); return; }
  const filtered = _filterTabDashData();
  if (filtered.length === 0) { showToast("내보낼 데이터가 없습니다.", "info"); return; }

  const headers = ["상태","캠페인","탭명","표시명","담당자","리뷰유형","결제방식","주문시간대","차수",
    "총인원","제출완료","대량건","배송유형","NC모드","입금자명","이체은행","소득유형",
    "리뷰폴더","캡처폴더","시트URL","갱신일"];
  const rows = filtered.map(t => {
    const st = t.is_closed ? "마감" : "활성";
    return [st, t.campaign_name, t.tab_name, t.display_name, t.manager, t.review_type,
      t.payment_type, t.time_range, t.round, t.row_count||0, t.submitted_count||0,
      t.is_bulk?"예":"", t.delivery_type, t.nc_mode?"예":"",
      t.deposit_name, t.transfer_bank, t.income_type, t.folder_url, t.capture_folder_url,
      t.sheet_url, t.updated_at ? new Date(t.updated_at).toLocaleString("ko-KR") : ""];
  });

  const bom = "\uFEFF";
  const csv = bom + [headers, ...rows].map(r => r.map(v => `"${String(v||"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `탭설정현황_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  showToast(`${filtered.length}건 CSV 다운로드`, "success");
}

// ── [DEPRECATED] 시트 동기화 — 베이스시트 의존성 제거됨, DB가 원본 ──
async function syncTabFromSheet() {
  showToast("베이스시트 동기화 기능은 제거되었습니다. DB(tab_configs)가 원본이므로 웹 UI에서 직접 관리하세요.", "info");
}

// ── DB 선택적 초기화 ──
async function resetAllData() {
  // 체크박스에서 선택된 항목 수집
  const targets = [];
  const labels = [];
  if (document.getElementById("resetDashboard")?.checked) { targets.push("dashboard"); labels.push("대시보드"); }
  if (document.getElementById("resetArchive")?.checked) { targets.push("archive"); labels.push("마감"); }
  if (document.getElementById("resetUnrecognized")?.checked) { targets.push("unrecognized"); labels.push("인식실패탭"); }

  if (targets.length === 0) { showToast("초기화할 항목을 1개 이상 선택하세요.", "warning"); return; }

  const step1 = prompt(
    `⚠ 경고: 선택된 항목의 데이터가 삭제됩니다.\n\n` +
    `삭제 대상: ${labels.join(", ")}\n\n` +
    `계속하려면 'RESET' 을 입력하세요:`
  );
  if (step1 !== "RESET") { showToast("초기화 취소됨", "info"); return; }

  const step2 = confirm(`[${labels.join(", ")}] 데이터를 삭제합니다.\n이 작업은 되돌릴 수 없습니다.`);
  if (!step2) { showToast("초기화 취소됨", "info"); return; }

  const btn = document.getElementById("btnResetAll");
  const _save = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 초기화 중...'; }

  try {
    const res = await gasPost({ action: "resetAllData", confirm: "RESET_ALL_DATA", targets }, 60000);
    if (res.error) { showToast("초기화 오류: " + res.error, "error"); return; }

    const d = res.deleted || {};
    const parts = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(", ");
    showToast(`✅ 초기화 완료 [${labels.join("+")}]: ${parts}`, "success");

    // 대시보드 새로고침
    if (typeof loadTabDashboard === "function") loadTabDashboard();
  } catch (err) {
    showToast("초기화 오류: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = _save; }
  }
}

// ═══════════════════════════════════════════════════════════
// [DEPRECATED v11.8.0] 통합 구조 동기화 — 2탭 통합으로 폐기
// → 인덱스 스캔(indexScan) + DB 동기화(indexScanSync)를 사용하세요
// ═══════════════════════════════════════════════════════════
async function fullMasterSync(dryRun) {
  showToast("[v11.8.0] 구조 동기화는 폐기되었습니다. '인덱스 스캔' + 'DB 동기화'를 사용하세요.", "warning");
}
    "• 파싱 결과를 DB에 즉시 반영 (추가/수정/삭제)\n" +
// [DEPRECATED v11.8.0] _showFullSyncPreview 제거됨
// [DEPRECATED v11.8.0] syncSettingsOnly 제거됨 — DB가 설정 원본
async function syncSettingsOnly() {
  showToast("[v11.8.0] 설정 동기화는 폐기되었습니다. DB가 설정 원본이므로 웹 UI에서 직접 설정하세요.", "warning");
}

// ═══════════════════════════════════════════════════════════
// ★ 인덱스 스캔 (시트DB → 각 시트 파싱 → 탭목록 기록)
// HTML: btnIndexScanDry / btnIndexScanRun → indexScan(dryRun)
// 백엔드: POST /api/tab/index-scan
// ═══════════════════════════════════════════════════════════
async function indexScan(dryRun) {
  const btnDry = document.getElementById("btnIndexScanDry");
  const btnRun = document.getElementById("btnIndexScanRun");
  const resultEl = document.getElementById("indexScanResult");
  const activeBtn = dryRun ? btnDry : btnRun;
  const actionLabel = dryRun ? "미리보기" : "실행";

  if (!dryRun && !confirm(
    "인덱스 스캔을 실행합니다.\n\n" +
    "• 시트DB에서 모든 시트 URL을 읽어옵니다\n" +
    "• 각 시트에 접속하여 탭이름, 탭URL을 파싱합니다\n" +
    "• 파싱 결과를 탭목록 시트에 기록합니다\n" +
    "• 기존 설정값(담당자, 택배 등)은 보존됩니다\n\n" +
    "계속하시겠습니까?"
  )) return;

  const _saveBtnHtml = activeBtn ? activeBtn.innerHTML : "";
  if (activeBtn) { activeBtn.disabled = true; activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${actionLabel}중...`; }
  if (btnDry && btnDry !== activeBtn) btnDry.disabled = true;
  if (btnRun && btnRun !== activeBtn) btnRun.disabled = true;

  showToast(`🔍 인덱스 스캔 ${actionLabel} 진행중... (약 60~120초 소요)`, "info");

  try {
    const res = await gasPost({ action: "indexScan", dryRun: !!dryRun }, 300000);
    if (res.error) { showToast(res.error, "error"); return; }

    if (dryRun) {
      // ── 미리보기 결과 ──
      const parts = [];
      parts.push(`${res.sheetsScanned || 0}개 시트 스캔`);
      parts.push(`총 ${res.totalTabs || 0}개 탭`);
      if (res.errors > 0) parts.push(`오류 ${res.errors}건`);
      showToast(`[미리보기] ${parts.join(", ")} (${res.elapsed || ''})`, res.errors > 0 ? "warning" : "info");

      // 미리보기 상세 표시
      if (res.preview && res.preview.length > 0 && resultEl) {
        _showIndexScanPreview(res, resultEl);
      }
    } else {
      // ── 실행 결과 ──
      const cacheLabel = res.usedCache ? " (캐시 적용 — 재스캔 생략)" : "";
      showToast(`✅ 인덱스 스캔 완료: ${res.totalTabs || 0}개 탭 기록${cacheLabel} (${res.elapsed || ''})`, "success");

      // 결과 표시
      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerHTML = `<div style="font-size:.72rem;color:#065F46;background:#D1FAE5;padding:6px 8px;border-radius:4px">
          ✅ ${res.totalTabs}개 탭 → 탭목록 시트에 기록 완료 (${res.elapsed})
          ${res.usedCache ? '<br><small style="color:#92400E">캐시 적용 — 재스캔 생략됨</small>' : ''}
        </div>`;
      }
    }
  } catch (err) {
    showToast("인덱스 스캔 오류: " + err.message, "error");
  } finally {
    if (activeBtn) { activeBtn.disabled = false; activeBtn.innerHTML = _saveBtnHtml; }
    if (btnDry && btnDry !== activeBtn) btnDry.disabled = false;
    if (btnRun && btnRun !== activeBtn) btnRun.disabled = false;
  }
}

function _showIndexScanPreview(res, resultEl) {
  if (!resultEl) return;
  // 캠페인별 그룹핑
  const groups = {};
  (res.preview || []).forEach(p => {
    const key = p.campaign || '(알 수 없음)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  let html = `<div style="margin-bottom:6px;font-size:.72rem;color:#374151">
    <b>📊 ${res.sheetsScanned}개 시트</b> · 총 ${res.totalTabs}탭
    ${res.errors > 0 ? ` · <span style="color:#DC2626">오류 ${res.errors}</span>` : ''}
    · 소요: ${res.elapsed || '?'}
  </div>`;

  for (const [campaign, tabs] of Object.entries(groups)) {
    html += `<div style="margin-top:4px;font-size:.7rem;font-weight:600;color:#15803D">📁 ${campaign} (${tabs.length})</div>`;
    for (const tab of tabs) {
      const tabUrlShort = tab.tabUrl ? tab.tabUrl.replace(/.*#/, '#') : '';
      html += `<div style="padding:1px 0 1px 12px;font-size:.68rem;color:#4B5563">
        ${tab.tabName} <span style="color:#9CA3AF;font-size:.6rem">${tabUrlShort}</span>
      </div>`;
    }
  }

  if (res.errorDetails && res.errorDetails.length > 0) {
    html += `<div style="margin-top:6px;padding:4px 6px;background:#FEF2F2;border-radius:4px;font-size:.66rem;color:#DC2626">
      ⚠ 오류 ${res.errors}건:
    </div>`;
    for (const err of res.errorDetails) {
      const desc = err.desc || (typeof _translateErrorClient === 'function' ? _translateErrorClient(err.error) : err.error);
      html += `<div style="padding:2px 0 2px 12px;font-size:.64rem;color:#B91C1C;line-height:1.5">
        ${err.sheetId || '?'} — ${err.error} (${err.errorCode || ''})
        <span style="color:#DC2626;font-weight:600">→ ${desc}</span>
      </div>`;
    }
  }

  html += `<div style="margin-top:6px;font-size:.66rem;color:#92400E;background:#FEF3C7;padding:4px 6px;border-radius:4px">
    ⚠ 미리보기 모드 — "실행"을 클릭해야 탭목록 시트에 기록됩니다.
  </div>`;

  resultEl.style.display = "block";
  resultEl.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
// ★ 인덱스 스캔 → DB 동기화 (탭목록 시트 → DB 직접 반영)
// HTML: btnIndexSyncDry / btnIndexSyncRun → indexScanSync(dryRun)
// 백엔드: POST /api/tab/index-scan-sync
// ═══════════════════════════════════════════════════════════
async function indexScanSync(dryRun) {
  const btnDry = document.getElementById("btnIndexSyncDry");
  const btnRun = document.getElementById("btnIndexSyncRun");
  const resultEl = document.getElementById("indexSyncResult");
  const activeBtn = dryRun ? btnDry : btnRun;
  const actionLabel = dryRun ? "미리보기" : "DB 반영";

  if (!dryRun && !confirm(
    "탭목록 시트 데이터를 DB에 직접 반영합니다.\n\n" +
    "• campaigns, tab_configs, index_master 테이블에 UPSERT\n" +
    "• 대시보드에 탭 목록이 즉시 표시됩니다\n" +
    "• 기존 설정값(담당자, 택배 등)은 보존됩니다\n\n" +
    "계속하시겠습니까?"
  )) return;

  const _saveBtnHtml = activeBtn ? activeBtn.innerHTML : "";
  if (activeBtn) { activeBtn.disabled = true; activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${actionLabel}중...`; }
  if (btnDry && btnDry !== activeBtn) btnDry.disabled = true;
  if (btnRun && btnRun !== activeBtn) btnRun.disabled = true;

  showToast(`🔄 DB ${actionLabel} 진행중...`, "info");

  try {
    const res = await gasPost({ action: "indexScanSync", dryRun: !!dryRun, fromCache: false }, 60000);
    if (res.error) { showToast(res.error, "error"); return; }

    if (dryRun) {
      // ── 미리보기 결과 ──
      const c = res.campaigns || {};
      const t = res.tabs || {};
      const ix = res.index || {};
      const parts = [];
      parts.push(`campaigns: 기존 ${c.existing || 0} / +${c.toAdd || 0}`);
      parts.push(`tabs: 기존 ${t.existing || 0} / +${t.toAdd || 0} / ~${t.toUpdate || 0}`);
      parts.push(`index: 기존 ${ix.existing || 0} / +${ix.toAdd || 0}`);
      showToast(`[미리보기] ${parts.join(", ")}`, "info");

      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerHTML = `<div style="font-size:.7rem;color:#374151">
          <div>📊 총 ${res.totalRows || 0}행 분석 (${res.elapsed || '?'})</div>
          <div style="margin-top:3px">• campaigns: 기존 ${c.existing || 0} / <b style="color:#15803D">+${c.toAdd || 0}</b></div>
          <div>• tab_configs: 기존 ${t.existing || 0} / <b style="color:#15803D">+${t.toAdd || 0}</b> / <b style="color:#D97706">~${t.toUpdate || 0}</b></div>
          <div>• index_master: 기존 ${ix.existing || 0} / <b style="color:#15803D">+${ix.toAdd || 0}</b></div>
          <div style="margin-top:4px;color:#92400E;font-size:.66rem">⚠ 미리보기 — "DB 반영"을 클릭해야 실제로 저장됩니다.</div>
        </div>`;
      }
    } else {
      // ── 실행 결과 ──
      showToast(`✅ DB 동기화 완료: ${res.message || ''}`, "success");

      if (resultEl) {
        resultEl.style.display = "block";
        resultEl.innerHTML = `<div style="font-size:.7rem;color:#065F46;background:#D1FAE5;padding:6px;border-radius:4px">
          ✅ ${res.message || 'DB 반영 완료'}
        </div>`;
      }

      // 대시보드 새로고침
      if (typeof loadAdminDashboard === "function") loadAdminDashboard();
    }
  } catch (err) {
    showToast("DB 동기화 오류: " + err.message, "error");
  } finally {
    if (activeBtn) { activeBtn.disabled = false; activeBtn.innerHTML = _saveBtnHtml; }
    if (btnDry && btnDry !== activeBtn) btnDry.disabled = false;
    if (btnRun && btnRun !== activeBtn) btnRun.disabled = false;
  }
}

async function scanMasterSheet(dryRun) {
  const btnDry = document.getElementById("btnScanMasterDry");
  const btnRun = document.getElementById("btnScanMasterRun");
  const activeBtn = dryRun ? btnDry : btnRun;
  const actionLabel = dryRun ? "스캔 미리보기" : "스캔 실행";

  if (!dryRun && !confirm(
    "마스터 시트 A열의 sheet_url에 직접 접속하여 시트 제목(campaign_name)과 탭 목록(tab_name)을 새로 파싱합니다.\n\n" +
    "• campaign_name: 각 시트의 실제 제목으로 채워집니다\n" +
    "• tab_name: 각 시트의 실제 탭 이름으로 채워집니다\n" +
    "• 기존 설정값(담당자, 택합 등)은 tab_name 기준으로 보존됩니다\n\n" +
    "계속하시겠습니까?"
  )) return;

  const _saveBtnHtml = activeBtn ? activeBtn.innerHTML : "";
  if (activeBtn) { activeBtn.disabled = true; activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${actionLabel}중...`; }
  if (btnDry && btnDry !== activeBtn) btnDry.disabled = true;
  if (btnRun && btnRun !== activeBtn) btnRun.disabled = true;

  showToast(`🔍 ${actionLabel} 진행중... (마스터 시트 URL에서 직접 파싱, 약 60~120초 소요)`, "info");

  try {
    const res = await gasPost({ action: "scanMasterSheet", dryRun: !!dryRun }, 300000);
    if (res.error) { showToast(res.error, "error"); return; }

    const parts = [];
    parts.push(`${res.sheetsScanned || 0}개 시트 스캔`);
    parts.push(`총 ${res.totalTabs || 0}개 탭`);
    if (res.newTabs > 0) parts.push(`신규 ${res.newTabs}개`);
    if (res.preservedTabs > 0) parts.push(`기존설정 보존 ${res.preservedTabs}개`);
    if (res.errors > 0) parts.push(`오류 ${res.errors}건`);

    const prefix = dryRun ? "[미리보기] " : "✅ ";
    showToast(`${prefix}${parts.join(", ")} (${res.elapsed})`, res.errors > 0 ? "warning" : "success");

    // 미리보기 결과 모달
    if (res.preview && res.preview.length > 0) {
      _showScanResult(res, dryRun);
    }
  } catch (err) {
    showToast("스캔 오류: " + err.message, "error");
  } finally {
    if (activeBtn) { activeBtn.disabled = false; activeBtn.innerHTML = _saveBtnHtml; }
    if (btnDry && btnDry !== activeBtn) btnDry.disabled = false;
    if (btnRun && btnRun !== activeBtn) btnRun.disabled = false;
  }
}

function _showScanResult(res, dryRun) {
  const old = document.getElementById("scanMasterResultModal");
  if (old) old.remove();

  // 캠페인별 그룹핑
  const groups = {};
  (res.preview || []).forEach(p => {
    const key = p.campaign || '(알 수 없음)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  let tableHtml = '';
  for (const [campaign, tabs] of Object.entries(groups)) {
    tableHtml += `<tr style="background:#F0FDF4"><td colspan="3" style="padding:6px 8px;font-size:.72rem;font-weight:700;color:#15803D">
      📁 ${campaign} (${tabs.length}개 탭)</td></tr>`;
    for (const tab of tabs) {
      const badge = tab.isNew
        ? '<span style="background:#DBEAFE;color:#1D4ED8;padding:1px 6px;border-radius:4px;font-size:.64rem">신규</span>'
        : '<span style="background:#F3F4F6;color:#6B7280;padding:1px 6px;border-radius:4px;font-size:.64rem">기존</span>';
      tableHtml += `<tr>
        <td style="padding:3px 8px 3px 24px;font-size:.7rem">${tab.tabName}</td>
        <td style="padding:3px 8px;font-size:.7rem">${badge}</td>
      </tr>`;
    }
  }

  const errHtml = (res.errorDetails || []).length > 0
    ? `<div style="margin-top:8px;padding:6px;background:#FEF2F2;border-radius:6px;font-size:.68rem;color:#DC2626">
        <b>오류:</b><br>${res.errorDetails.map(function(e) {
          var desc = e.desc || (typeof _translateErrorClient === 'function' ? _translateErrorClient(e.error) : e.error);
          return '<span style="color:#6B7280">' + (e.sheetId||'?') + ': ' + e.error + '</span><br><span style="color:#DC2626;font-weight:600">→ ' + desc + '</span>';
        }).join('<br>')}</div>` : '';

  const modal = document.createElement('div');
  modal.id = 'scanMasterResultModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:600px;max-height:80vh;overflow:auto">
      <div class="modal-header">
        <h3><i class="fas fa-search" style="color:#15803D"></i>
          시트 스캔 ${dryRun ? '미리보기' : '결과'}</h3>
        <button class="btn-icon-sm" onclick="document.getElementById('scanMasterResultModal').remove()">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:8px;font-size:.72rem;flex-wrap:wrap">
        <span>📊 ${res.sheetsScanned}개 시트 스캔</span>
        <span>📄 총 ${res.totalTabs}개 탭</span>
        <span>🆕 신규 ${res.newTabs}개</span>
        <span>♻ 설정보존 ${res.preservedTabs}개</span>
        ${res.errors > 0 ? `<span style="color:#DC2626">❌ 오류 ${res.errors}건</span>` : ''}
      </div>
      <table style="width:100%;border-collapse:collapse">${tableHtml}</table>
      ${errHtml}
      ${dryRun ? '<div style="margin-top:8px;padding:6px;background:#FEF3C7;border-radius:6px;font-size:.68rem;color:#92400E">⚠ 미리보기 모드 — "스캔 실행"을 클릭해야 마스터 시트에 실제로 기록됩니다.</div>' : ''}
    </div>`;
  document.body.appendChild(modal);
}

// ── 마스터 구글시트 → DB 동기화 ──
async function syncMasterSheet(dryRun) {
  const btnDry = document.getElementById("btnSyncMasterDry");
  const btnRun = document.getElementById("btnSyncMasterRun");
  const activeBtn = dryRun ? btnDry : btnRun;
  const actionLabel = dryRun ? "미리보기" : "동기화";

  if (!dryRun && !confirm(
    "마스터 구글시트 데이터를 DB에 동기화합니다.\n\n" +
    "• campaigns 테이블: 시트 목록 추가/삭제\n" +
    "• tab_configs 테이블: 탭 설정 추가/수정/삭제\n\n" +
    "⚠ 시트에 없는 DB 데이터는 삭제됩니다.\n계속하시겠습니까?"
  )) return;

  const _saveBtnHtml = activeBtn ? activeBtn.innerHTML : "";
  if (activeBtn) { activeBtn.disabled = true; activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${actionLabel}중...`; }
  if (btnDry && btnDry !== activeBtn) btnDry.disabled = true;
  if (btnRun && btnRun !== activeBtn) btnRun.disabled = true;

  showToast(`🔄 마스터 시트 ${actionLabel} 진행중...`, "info");

  try {
    const res = await gasPost({ action: "syncMasterSheet", dryRun: !!dryRun }, 180000);
    if (res.error) { showToast(res.error, "error"); return; }

    // 결과 요약 토스트
    const parts = [];
    const c = res.campaigns || {};
    const t = res.tabs || {};
    if (c.added > 0) parts.push(`캠페인 +${c.added}`);
    if (c.removed > 0) parts.push(`캠페인 -${c.removed}`);
    if (t.added > 0) parts.push(`탭 +${t.added}`);
    if (t.updated > 0) parts.push(`탭 ~${t.updated}`);
    if (t.removed > 0) parts.push(`탭 -${t.removed}`);
    if (parts.length === 0) parts.push("변경 없음 — DB와 시트가 일치합니다");

    const prefix = dryRun ? "[미리보기] " : "✅ ";
    const totalChanges = (c.added || 0) + (c.removed || 0) + (t.added || 0) + (t.updated || 0) + (t.removed || 0);
    showToast(`${prefix}${parts.join(", ")} (${res.elapsed})`, totalChanges > 0 ? (dryRun ? "info" : "success") : "success");

    // 상세 결과 모달 표시
    if (res.details && res.details.length > 0) {
      _showMasterSyncResult(res, dryRun);
    }

    // 실제 실행 후 대시보드 새로고침
    if (!dryRun && totalChanges > 0) {
      loadTabDashboard();
    }
  } catch (err) {
    showToast("마스터 시트 동기화 오류: " + err.message, "error");
  } finally {
    if (activeBtn) { activeBtn.disabled = false; activeBtn.innerHTML = _saveBtnHtml; }
    if (btnDry && btnDry !== activeBtn) btnDry.disabled = false;
    if (btnRun && btnRun !== activeBtn) btnRun.disabled = false;
  }
}

function _showMasterSyncResult(res, dryRun) {
  const old = document.getElementById("masterSyncResultModal");
  if (old) old.remove();

  const actionColor = (action) => {
    if (action.includes('add')) return '#0ca678';
    if (action.includes('update')) return '#0369A1';
    if (action.includes('remove')) return '#DC2626';
    return '#6B7280';
  };
  const actionLabel = (action) => {
    if (action.includes('dry_add')) return '추가 예정';
    if (action.includes('dry_update')) return '수정 예정';
    if (action.includes('dry_remove')) return '삭제 예정';
    if (action.includes('added')) return '추가됨';
    if (action.includes('updated')) return '수정됨';
    if (action.includes('removed')) return '삭제됨';
    return action;
  };

  const rows = (res.details || []).map(d => {
    const name = d.type === 'campaign' ? `📁 ${d.name}` : `📄 ${d.campaign || ''} / ${d.tabName}`;
    const changeDetail = d.changes
      ? d.changes.map(c => `${c.col}: ${c.from || '(빈값)'} → ${c.to || '(빈값)'}`).join('<br>')
      : '';
    return `<tr>
      <td style="padding:4px 8px;font-size:.72rem;white-space:nowrap">
        <span style="color:${actionColor(d.action)};font-weight:600">${actionLabel(d.action)}</span>
      </td>
      <td style="padding:4px 8px;font-size:.72rem">${name}</td>
      <td style="padding:4px 8px;font-size:.68rem;color:#6B7280">${changeDetail}</td>
    </tr>`;
  }).join('');

  const c = res.campaigns || {};
  const t = res.tabs || {};
  const summaryHtml = `
    <div style="display:flex;gap:12px;margin-bottom:8px;font-size:.72rem">
      <span>📊 시트 ${res.sheetRows || 0}행</span>
      <span>📁 캠페인: +${c.added || 0} / -${c.removed || 0} / =${c.unchanged || 0}</span>
      <span>📄 탭: +${t.added || 0} / ~${t.updated || 0} / -${t.removed || 0} / =${t.unchanged || 0}</span>
    </div>`;

  const modal = document.createElement('div');
  modal.id = 'masterSyncResultModal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:700px;max-height:80vh;overflow:auto">
      <div class="modal-header">
        <h3><i class="fas fa-cloud-download-alt" style="color:#0ca678"></i>
          마스터 시트 동기화 ${dryRun ? '미리보기' : '결과'}</h3>
        <button class="btn-icon-sm" onclick="document.getElementById('masterSyncResultModal').remove()">
          <i class="fas fa-times"></i>
        </button>
      </div>
      ${summaryHtml}
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#F9FAFB;border-bottom:1px solid #E5E7EB">
          <th style="padding:6px 8px;text-align:left;font-size:.7rem">상태</th>
          <th style="padding:6px 8px;text-align:left;font-size:.7rem">대상</th>
          <th style="padding:6px 8px;text-align:left;font-size:.7rem">변경 내용</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  document.body.appendChild(modal);
}

// ── 탭명·URL 동기화 (시트 실제 탭명 ↔ DB) ──
async function syncTabNames(dryRun) {
  // ★ 유지보수 도구 버튼(btnSyncTabNamesDry/Run) + 설정 탭 버튼(btnSyncTabNames) 모두 지원
  const btnDry = document.getElementById("btnSyncTabNamesDry");
  const btnRun = document.getElementById("btnSyncTabNamesRun");
  const btnSettings = document.getElementById("btnSyncTabNames");
  const activeBtn = dryRun ? (btnDry || btnSettings) : (btnRun || btnSettings);
  const actionLabel = dryRun ? "탐지" : "적용";

  // ★ 버튼 로딩 상태 + 즉시 피드백 토스트
  const _saveBtnHtml = activeBtn ? activeBtn.innerHTML : "";
  if (activeBtn) { activeBtn.disabled = true; activeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${actionLabel}중...`; }
  // 양쪽 버튼 모두 비활성화
  if (btnDry && btnDry !== activeBtn) btnDry.disabled = true;
  if (btnRun && btnRun !== activeBtn) btnRun.disabled = true;
  if (btnSettings && btnSettings !== activeBtn) btnSettings.disabled = true;

  // ★ 고정 프로그레스 배너 표시 (진행 상태를 명확히 전달)
  _showSyncProgressBanner(actionLabel);

  try {
    const res = await gasPost({ action: "syncTabNames", dryRun: !!dryRun }, 180000);
    _hideSyncProgressBanner();
    if (res.error) { showToast(res.error, "error"); return; }

    // 결과 요약 토스트
    const parts = [];
    if (res.renamed > 0) parts.push(`탭명 변경 ${res.renamed}건`);
    if (res.urlFixed > 0) parts.push(`URL 교정 ${res.urlFixed}건`);
    if (res.gidFilled > 0) parts.push(`GID 보충 ${res.gidFilled}건`);
    if (res.errors > 0) parts.push(`오류 ${res.errors}건`);
    if (parts.length === 0) parts.push("변경 없음 — 모든 탭명이 일치합니다");

    const prefix = dryRun ? "[1단계 탐지] " : "[2단계 적용] ";
    const sheetInfo = res.totalSheets ? `${res.totalSheets}개 시트, ` : "";
    showToast(`${prefix}${sheetInfo}${parts.join(", ")} (${res.elapsed})`, res.errors > 0 ? "warning" : "success");

    // ★ 미리보기(dryRun)에서는 항상 모달 표시 (변경 없어도 결과 확인 가능)
    // 실행 모드에서는 변경 있을 때만 표시
    if (dryRun || (res.results && res.results.length > 0)) {
      _showSyncTabNamesResult(res, dryRun);
    }

    // 실제 실행 후 대시보드 새로고침
    if (!dryRun && (res.renamed > 0 || res.urlFixed > 0 || res.gidFilled > 0)) {
      loadTabDashboard();
    }
  } catch (err) {
    _hideSyncProgressBanner();
    showToast("탭명 동기화 오류: " + err.message, "error");
  } finally {
    // ★ 모든 관련 버튼 복원
    if (activeBtn) { activeBtn.disabled = false; activeBtn.innerHTML = _saveBtnHtml; }
    if (btnDry && btnDry !== activeBtn) { btnDry.disabled = false; }
    if (btnRun && btnRun !== activeBtn) { btnRun.disabled = false; }
    if (btnSettings && btnSettings !== activeBtn) { btnSettings.disabled = false; btnSettings.innerHTML = '<i class="fas fa-exchange-alt"></i> 탭명 동기화'; }
  }
}

// ★ 탭명 동기화 진행 상태 고정 배너
let _syncProgressInterval = null;
function _showSyncProgressBanner(actionLabel) {
  _hideSyncProgressBanner(); // 기존 배너 제거
  const banner = document.createElement('div');
  banner.id = 'syncProgressBanner';
  banner.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;background:#1E40AF;color:#fff;border-radius:10px;padding:12px 24px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:12px;font-size:.82rem;min-width:320px;animation:slideInR .3s ease';
  const startTime = Date.now();
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex:1">
      <div class="sync-spinner" style="width:18px;height:18px;border:2.5px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite"></div>
      <div>
        <div style="font-weight:600">탭명 동기화 ${actionLabel} 진행중</div>
        <div style="font-size:.72rem;opacity:.8;margin-top:2px">
          전체 시트 확인 중... <span id="syncProgressTimer">0초</span> 경과
        </div>
      </div>
    </div>
    <div style="font-size:.68rem;opacity:.7;text-align:right">약 30~90초 소요</div>
  `;
  document.body.appendChild(banner);

  // 경과 시간 업데이트
  _syncProgressInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const timerEl = document.getElementById('syncProgressTimer');
    if (timerEl) timerEl.textContent = `${elapsed}초`;
  }, 1000);
}

function _hideSyncProgressBanner() {
  clearInterval(_syncProgressInterval);
  _syncProgressInterval = null;
  const banner = document.getElementById('syncProgressBanner');
  if (banner) {
    banner.style.opacity = '0';
    banner.style.transform = 'translateX(-50%) translateY(-10px)';
    banner.style.transition = 'opacity .3s, transform .3s';
    setTimeout(() => banner.remove(), 300);
  }
}

function _showSyncTabNamesResult(res, dryRun) {
  // 기존 결과 모달 제거
  const old = document.getElementById("syncTabNamesResultModal");
  if (old) old.remove();

  const statusColor = (s) => {
    if (s === 'renamed') return '#0ca678';
    if (s === 'url_fixed') return '#0369A1';
    if (s === 'gid_filled') return '#0891B2';
    if (s === 'dry_run' || s === 'dry_run_url' || s === 'dry_run_gid') return '#3182f6';
    if (s === 'error' || s === 'sheet_error') return '#DC2626';
    if (s === 'no_gid' || s === 'no_gid_missing') return '#D97706';
    return '#6B7280';
  };
  const statusLabel = (s) => {
    if (s === 'renamed') return '변경 완료';
    if (s === 'url_fixed') return 'URL 교정';
    if (s === 'gid_filled') return 'GID 보충';
    if (s === 'dry_run') return '변경 예정';
    if (s === 'dry_run_url') return 'URL 교정 예정';
    if (s === 'dry_run_gid') return 'GID 보충 예정';
    if (s === 'error' || s === 'sheet_error') return '오류';
    if (s === 'no_gid' || s === 'no_gid_missing') return 'GID 없음';
    return s;
  };

  const resultItems = res.results || [];
  let tableRows = '';
  if (resultItems.length === 0) {
    tableRows = `<tr><td colspan="3" style="padding:20px;text-align:center;font-size:.82rem;color:#0ca678"><i class="fas fa-check-circle" style="margin-right:6px"></i>${dryRun ? '변경할 항목이 없습니다 — 모든 탭명이 시트와 일치합니다.' : '동기화 완료 — 모든 변경이 적용되었습니다.'}</td></tr>`;
  } else {
    tableRows = resultItems.map(r => {
    const badge = `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:.68rem;font-weight:600;color:#fff;background:${statusColor(r.status)}">${statusLabel(r.status)}</span>`;
    let detail = '';
    if (r.newName && r.newName !== r.oldName) {
      detail += `<span style="color:#DC2626;text-decoration:line-through">${escHtml(r.oldName)}</span> → <b style="color:#0ca678">${escHtml(r.newName)}</b>`;
    } else {
      detail += escHtml(r.oldName || '');
    }
    if (r.urlFixed) {
      detail += `<br><span style="font-size:.65rem;color:#0369A1"><i class="fas fa-link"></i> URL 교정됨</span>`;
    }
    if (r.gidFilled) {
      detail += `<br><span style="font-size:.65rem;color:#0891B2"><i class="fas fa-fingerprint"></i> GID=${r.filledGid} 보충${r.status && r.status.includes('dry') ? ' 예정' : '됨'}</span>`;
    }
    if (r.error) {
      detail += `<br><span style="font-size:.65rem;color:#DC2626">${escHtml(r.error)}</span>`;
    }
    if (r.message) {
      detail += `<br><span style="font-size:.65rem;color:#D97706">${escHtml(r.message)}</span>`;
    }
    if (r.hint) {
      detail += `<br><span style="font-size:.63rem;color:#3182f6"><i class="fas fa-lightbulb"></i> ${escHtml(r.hint)}</span>`;
    }
    if (r.affectedTabs && r.affectedTabs.length > 0) {
      detail += `<br><span style="font-size:.63rem;color:#6B7280">영향 탭(${r.affectedTabCount}개): ${r.affectedTabs.map(t => escHtml(t)).join(', ')}${r.affectedTabCount > 5 ? '...' : ''}</span>`;
    }
    if (r.sheetTabs && r.sheetTabs.length > 0) {
      detail += `<br><span style="font-size:.63rem;color:#9CA3AF">시트 탭 목록: ${r.sheetTabs.map(t => escHtml(t)).join(', ')}</span>`;
    }
    return `<tr>
      <td style="padding:4px 6px;font-size:.72rem;border-bottom:1px solid #F3F4F6">${badge}</td>
      <td style="padding:4px 6px;font-size:.72rem;border-bottom:1px solid #F3F4F6">${escHtml(r.campaign || '')}</td>
      <td style="padding:4px 6px;font-size:.72rem;border-bottom:1px solid #F3F4F6">${detail}</td>
    </tr>`;
  }).join('');
  } // end if/else resultItems.length

  const title = dryRun ? "🔍 1단계: 탭명 동기화 미리보기 (탐지)" : "✅ 2단계: 탭명 동기화 완료 (적용)";
  const summary = `시트 ${res.totalSheets}개 · 탭 ${res.totalTabs}개 검사 → 변경 ${res.renamed}건, URL교정 ${res.urlFixed}건, GID보충 ${res.gidFilled || 0}건, 스킵 ${res.skipped}건, 오류 ${res.errors}건 (${res.elapsed})`;

  const modal = document.createElement('div');
  modal.id = 'syncTabNamesResultModal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.45);z-index:10000;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:600px;width:95%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 40px rgba(0,0,0,.15)">
      <div style="padding:12px 16px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;justify-content:space-between">
        <h3 style="margin:0;font-size:.95rem;color:#1E293B"><i class="fas fa-exchange-alt" style="color:#3182f6;margin-right:6px"></i>${title}</h3>
        <button onclick="this.closest('.modal-overlay').remove()" style="background:none;border:none;cursor:pointer;font-size:1rem;color:#6B7280;padding:4px"><i class="fas fa-times"></i></button>
      </div>
      <div style="padding:10px 16px;font-size:.73rem;color:#6B7280;background:#F8FAFC;border-bottom:1px solid #E5E7EB">${summary}</div>
      <div style="overflow-y:auto;flex:1;padding:0">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:#F9FAFB">
            <th style="padding:6px;font-size:.7rem;text-align:left;color:#6B7280;font-weight:600;border-bottom:1px solid #E5E7EB">상태</th>
            <th style="padding:6px;font-size:.7rem;text-align:left;color:#6B7280;font-weight:600;border-bottom:1px solid #E5E7EB">캠페인</th>
            <th style="padding:6px;font-size:.7rem;text-align:left;color:#6B7280;font-weight:600;border-bottom:1px solid #E5E7EB">탭명</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      <div style="padding:10px 16px;border-top:1px solid #E5E7EB;display:flex;gap:8px;justify-content:flex-end;align-items:center">
        ${dryRun ? `<span style="flex:1;font-size:.72rem;color:#6B7280">위 내용을 확인 후 [적용] 버튼을 클릭하세요</span>
        <button onclick="syncTabNames(false);this.closest('.modal-overlay').remove()" style="padding:7px 20px;background:#0ca678;color:#fff;border:none;border-radius:6px;font-size:.82rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px"><i class="fas fa-check-circle"></i> 2단계: 적용</button>` : ''}
        <button onclick="this.closest('.modal-overlay').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer">닫기</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ═══════════════════════════════════════════════════════════
// 중복 파일 정리 (Dedupe) — 미리보기 → 확인 → 실행
// ═══════════════════════════════════════════════════════════

/**
 * 미리보기 모달 열기
 */
async function openDedupePreview(btn) {
  const sheetId = btn.dataset.sheetid;
  const tabName = btn.dataset.tabname;
  if (!sheetId || !tabName) return showToast("탭 정보 누락", "error");

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    const token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token');
    const resp = await fetch(API_BASE_URL + '/api/dedupe/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? 'Bearer ' + token : '',
      },
      body: JSON.stringify({ sheetId, tabName }),
    });
    const data = await resp.json();

    if (!resp.ok || data.error) {
      showToast(data.error || '중복 검사 실패', 'error');
      return;
    }

    if (data.duplicateGroups === 0) {
      showToast(`중복 파일 없음 (총 ${data.totalFiles}개 파일 검사 완료)`, 'success');
      return;
    }

    // 미리보기 모달 렌더
    _renderDedupeModal(data, sheetId, tabName, btn.dataset.folderurl || '');
  } catch (err) {
    showToast('중복 검사 오류: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-broom"></i>';
  }
}

/**
 * 미리보기 모달 렌더링
 */
function _renderDedupeModal(data, sheetId, tabName, folderUrl) {
  // folderUrl이 data에 없으면 파라미터에서 가져옴
  if (!data.folderUrl && folderUrl) data.folderUrl = folderUrl;
  // 기존 모달 제거
  const existing = document.getElementById('dedupeModal');
  if (existing) existing.remove();

  const groupRows = data.duplicateDetails.map((group, i) => {
    const keepName = escHtml(group.keepFile.fileName);
    const removeRows = group.removeFiles.map(f =>
      `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
        <i class="fas fa-trash-alt" style="color:#EF4444;font-size:.7rem"></i>
        <span style="font-size:.75rem;color:#374151">${escHtml(f.fileName)}</span>
        <span style="font-size:.65rem;color:#9CA3AF">(${escHtml(f.reviewerName || '이름불명')})</span>
      </div>`
    ).join('');

    return `
      <div style="border:1px solid #E5E7EB;border-radius:8px;padding:10px;margin-bottom:8px;background:#FAFAFA">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="background:#DCFCE7;color:#166534;font-size:.65rem;font-weight:700;padding:2px 6px;border-radius:4px">유지</span>
          <span style="font-size:.75rem;font-weight:500">${keepName}</span>
          <span style="font-size:.65rem;color:#9CA3AF">(${escHtml(group.keepFile.reviewerName || '')})</span>
        </div>
        <div style="padding-left:12px;border-left:2px solid #FCA5A5">
          <div style="font-size:.65rem;color:#DC2626;font-weight:600;margin-bottom:2px">삭제 대상 (${group.removeFiles.length}건):</div>
          ${removeRows}
        </div>
      </div>`;
  }).join('');

  const affectedList = data.affectedReviewers.length > 0
    ? `<div style="margin-top:10px;padding:8px 12px;background:#FEF3C7;border-radius:6px;font-size:.72rem">
        <strong><i class="fas fa-pen"></i> 시트 "중복" 마킹 대상:</strong>
        ${[...new Set(data.affectedReviewers.map(a => a.reviewerName))].map(n => `<span style="background:#FDE68A;padding:1px 5px;border-radius:3px;margin:0 2px">${escHtml(n)}</span>`).join('')}
       </div>`
    : '';

  const modal = document.createElement('div');
  modal.id = 'dedupeModal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:560px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2)">
      <div style="padding:16px 20px;border-bottom:1px solid #E5E7EB;flex-shrink:0">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h3 style="margin:0;font-size:1rem;font-weight:700;color:#111"><i class="fas fa-broom" style="color:#3182f6"></i> 중복 파일 정리 미리보기</h3>
          <a href="${escHtml(data.folderUrl || '')}" target="_blank" style="font-size:.72rem;color:#0ca678;text-decoration:none;font-weight:600;padding:4px 10px;background:#F0FDF4;border-radius:6px;border:1px solid #BBF7D0;display:${data.folderUrl ? 'inline-flex' : 'none'};align-items:center;gap:4px" title="리뷰폴더 열기"><i class="fas fa-external-link-alt"></i> 폴더 열기</a>
        </div>
        <div style="font-size:.72rem;color:#6B7280;margin-top:4px">${escHtml(data.displayName || tabName)}</div>
      </div>
      <div style="padding:16px 20px;overflow-y:auto;flex:1">
        <div style="display:flex;gap:12px;margin-bottom:12px">
          <div style="flex:1;background:#F3F4F6;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:1.2rem;font-weight:700;color:#111">${data.totalFiles}</div>
            <div style="font-size:.65rem;color:#6B7280">전체 파일</div>
          </div>
          <div style="flex:1;background:#FEF2F2;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:1.2rem;font-weight:700;color:#DC2626">${data.duplicateFileCount}</div>
            <div style="font-size:.65rem;color:#6B7280">중복 파일</div>
          </div>
          <div style="flex:1;background:#F0FDF4;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:1.2rem;font-weight:700;color:#166534">${data.duplicateGroups}</div>
            <div style="font-size:.65rem;color:#6B7280">중복 그룹</div>
          </div>
        </div>
        ${groupRows}
        ${affectedList}
      </div>
      <div style="padding:12px 20px;border-top:1px solid #E5E7EB;display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
        <button onclick="this.closest('#dedupeModal').remove()" style="padding:8px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer">취소</button>
        <button id="btnDedupeExecute" onclick="executeDedupeFromModal()" style="padding:8px 16px;background:#DC2626;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer"><i class="fas fa-trash-alt"></i> ${data.duplicateFileCount}건 정리 실행</button>
      </div>
    </div>`;

  // 모달에 데이터 저장
  modal.dataset.sheetid = sheetId;
  modal.dataset.tabname = tabName;
  modal.dataset.files = JSON.stringify(
    data.duplicateDetails.flatMap(g => g.removeFiles.map(f => ({
      fileId: f.fileId,
      fileName: f.fileName,
      reviewerName: f.reviewerName,
    })))
  );

  document.body.appendChild(modal);
}

/**
 * 중복정리 실행 (모달에서 호출)
 */
async function executeDedupeFromModal() {
  const modal = document.getElementById('dedupeModal');
  if (!modal) return;

  const sheetId = modal.dataset.sheetid;
  const tabName = modal.dataset.tabname;
  const filesToRemove = JSON.parse(modal.dataset.files || '[]');

  if (filesToRemove.length === 0) {
    showToast('삭제할 파일이 없습니다.', 'info');
    modal.remove();
    return;
  }

  const btn = document.getElementById('btnDedupeExecute');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 처리중...'; }

  try {
    const token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token');
    const resp = await fetch(API_BASE_URL + '/api/dedupe/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? 'Bearer ' + token : '',
      },
      body: JSON.stringify({ sheetId, tabName, filesToRemove }),
    });
    const data = await resp.json();

    if (!resp.ok || data.error) {
      showToast(data.error || '실행 실패', 'error');
      return;
    }

    showToast(data.summary || `중복 정리 완료: ${data.trashResult.success}건 삭제`, 'success');
    modal.remove();

    // 대시보드 새로고침
    if (typeof loadTabDashboard === 'function') loadTabDashboard();
  } catch (err) {
    showToast('실행 오류: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash-alt"></i> 실행'; }
  }
}

// ═══════════════════════════════════════════════════════════
// 중복 파일 정리 — 탭 선택 모달 (상단 툴바 버튼에서 호출)
// ═══════════════════════════════════════════════════════════

/**
 * 상단 "중복정리" 버튼 클릭 → 리뷰폴더가 설정된 탭 목록 표시
 */
function openDedupeSelector() {
  // 기존 모달 제거
  const existing = document.getElementById('dedupeSelectorModal');
  if (existing) existing.remove();

  // _tabDashData 또는 _lastDashData에서 리뷰폴더가 설정된 탭 필터링
  let tabsWithFolder = [];

  // 1차: _tabDashData (탭 관리 대시보드 데이터 — 현재 화면)
  if (_tabDashData && _tabDashData.tabs) {
    _tabDashData.tabs.forEach(t => {
      if (t.folder_url) {
        tabsWithFolder.push({
          sheetId: t.sheet_id,
          tabName: t.tab_name,
          displayName: t.display_name || t.tab_name,
          campName: t.campaign_name || '',
          folderUrl: t.folder_url,
        });
      }
    });
  }

  // 2차 fallback: _lastDashData (캠페인 대시보드 데이터)
  if (tabsWithFolder.length === 0 && _lastDashData && _lastDashData.stats) {
    _lastDashData.stats.forEach(camp => {
      (camp.tabs || []).forEach(t => {
        if (t.folderUrl) {
          tabsWithFolder.push({
            sheetId: t.sheetId,
            tabName: t.tab,
            displayName: t.displayName || t.tab,
            campName: camp.campaign || '',
            folderUrl: t.folderUrl,
          });
        }
      });
    });
  }

  if (tabsWithFolder.length === 0) {
    showToast('리뷰폴더가 설정된 탭이 없습니다.', 'info');
    return;
  }

  // 탭 목록 렌더링
  const tabRows = tabsWithFolder.map((t, i) => `
    <div class="dedupe-sel-row" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;cursor:pointer;transition:background .15s;border:1px solid #E5E7EB;margin-bottom:6px"
         onmouseover="this.style.background='#FEF3C7'" onmouseout="this.style.background='#fff'"
         onclick="selectDedupeTab(${i})">
      <i class="fas fa-folder-open" style="color:#D97706;font-size:.9rem"></i>
      <div style="flex:1;min-width:0">
        <div style="font-size:.8rem;font-weight:600;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.displayName)}</div>
        <div style="font-size:.65rem;color:#6B7280;margin-top:1px">${escHtml(t.campName)}</div>
      </div>
      <i class="fas fa-chevron-right" style="color:#9CA3AF;font-size:.7rem"></i>
    </div>
  `).join('');

  const modal = document.createElement('div');
  modal.id = 'dedupeSelectorModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.classList.add('toss-overlay');
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:480px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2)">
      <div style="padding:16px 20px;border-bottom:1px solid #E5E7EB;flex-shrink:0">
        <h3 style="margin:0;font-size:1rem;font-weight:700;color:#111"><i class="fas fa-copy" style="color:#D97706"></i> 중복 파일 정리</h3>
        <div style="font-size:.72rem;color:#6B7280;margin-top:4px">정리할 리뷰폴더를 선택하세요 (${tabsWithFolder.length}개 탭)</div>
      </div>
      <div style="padding:14px 20px;overflow-y:auto;flex:1">
        ${tabRows}
      </div>
      <div style="padding:12px 20px;border-top:1px solid #E5E7EB;display:flex;justify-content:flex-end;flex-shrink:0">
        <button onclick="this.closest('#dedupeSelectorModal').remove()" style="padding:8px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer">닫기</button>
      </div>
    </div>`;

  // 탭 데이터를 모달에 저장
  modal._tabsWithFolder = tabsWithFolder;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

/* ═══════════════════════════════════════════════════════════
   폴더 찾기 & 재연결 — 사라진 캡처/리뷰 폴더를 탭명으로 검색하여 재연결
   ═══════════════════════════════════════════════════════════ */

/** 모달 열기 (presetSheetId/presetTabName 지정 시 해당 탭 자동 선택) */
function openFolderRelink(presetSheetId, presetTabName) {
  const existing = document.getElementById('folderRelinkModal');
  if (existing) existing.remove();

  let tabs = [];
  if (_tabDashData && _tabDashData.tabs) {
    tabs = _tabDashData.tabs.map(t => ({
      sheetId: t.sheet_id, tabName: t.tab_name,
      displayName: t.display_name || t.tab_name,
      campName: t.campaign_name || '',
      folderUrl: t.folder_url || '', captureUrl: t.capture_folder_url || '',
    }));
  }
  if (tabs.length === 0) { showToast('먼저 탭 대시보드를 로드하세요.', 'info'); return; }

  const options = tabs.map((t, i) =>
    `<option value="${i}">${escHtml(t.displayName)}${t.campName ? ' — ' + escHtml(t.campName) : ''}</option>`
  ).join('');

  const modal = document.createElement('div');
  modal.id = 'folderRelinkModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.classList.add('toss-overlay');
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:640px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2)">
      <div style="padding:16px 20px;border-bottom:1px solid #E5E7EB;flex-shrink:0">
        <h3 style="margin:0;font-size:1rem;font-weight:700;color:#111"><i class="fas fa-link" style="color:#7C3AED"></i> 폴더 찾기 &amp; 재연결</h3>
        <div style="font-size:.72rem;color:#6B7280;margin-top:4px">탭 선택 후 [폴더 찾기] → Drive에서 실제 폴더 후보 표시 → 맞는 폴더를 캡처/리뷰로 지정 → [재연결 저장].</div>
      </div>
      <div style="padding:14px 20px;overflow-y:auto;flex:1">
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px">
          <label style="flex:2;min-width:220px;font-size:.72rem;color:#374151">탭 선택
            <select id="frlTabSel" style="width:100%;margin-top:3px;padding:7px;border:1px solid #D1D5DB;border-radius:6px;font-size:.8rem">${options}</select>
          </label>
          <label style="flex:1;min-width:150px;font-size:.72rem;color:#374151">검색어(선택)
            <input id="frlQuery" type="text" placeholder="비우면 탭명에서 자동" style="width:100%;margin-top:3px;padding:7px;border:1px solid #D1D5DB;border-radius:6px;font-size:.8rem">
          </label>
          <button id="frlSearchBtn" onclick="findFolderCandidatesUI()" style="padding:8px 14px;background:#7C3AED;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer"><i class="fas fa-search"></i> 폴더 찾기</button>
        </div>
        <div id="frlPick" style="display:none;font-size:.75rem;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:8px;padding:10px;margin-bottom:10px"></div>
        <div id="frlResult" style="font-size:.75rem"></div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid #E5E7EB;display:flex;justify-content:space-between;gap:8px;flex-shrink:0">
        <button onclick="this.closest('#folderRelinkModal').remove()" style="padding:8px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer">닫기</button>
        <button id="frlSaveBtn" onclick="saveFolderRelink()" disabled style="padding:8px 16px;background:#0ca678;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:700;cursor:pointer;opacity:.5"><i class="fas fa-save"></i> 재연결 저장</button>
      </div>
    </div>`;
  modal._tabs = tabs;
  modal._pick = { captureUrl: '', captureName: '', reviewUrl: '', reviewName: '' };
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  if (presetSheetId && presetTabName) {
    const idx = tabs.findIndex(t => t.sheetId === presetSheetId && t.tabName === presetTabName);
    if (idx >= 0) document.getElementById('frlTabSel').value = String(idx);
  }
}

/** 선택한 탭으로 Drive 폴더 후보 검색 */
async function findFolderCandidatesUI() {
  const modal = document.getElementById('folderRelinkModal');
  if (!modal) return;
  const tab = modal._tabs[parseInt(document.getElementById('frlTabSel').value, 10)];
  if (!tab) return;
  const query = (document.getElementById('frlQuery').value || '').trim();
  const resultEl = document.getElementById('frlResult');
  resultEl.innerHTML = '<div style="padding:12px;color:#6B7280"><i class="fas fa-spinner fa-spin"></i> Drive에서 폴더 검색 중...</div>';

  let data;
  try {
    data = await gasPost({ action: 'findFolderCandidates', sheetId: tab.sheetId, tabName: tab.tabName, query }, 60000);
  } catch (e) { resultEl.innerHTML = `<div style="color:#DC2626">검색 실패: ${escHtml(e.message || '')}</div>`; return; }
  if (!data || data.error) { resultEl.innerHTML = `<div style="color:#DC2626">${escHtml((data && data.error) || '검색 실패')}</div>`; return; }

  modal._candidates = data.candidates || [];

  const warn = (data.warnings || []).map(w => `<div style="color:#B45309;font-size:.72rem"><i class="fas fa-triangle-exclamation"></i> ${escHtml(w)}</div>`).join('');
  const curC = data.current && data.current.captureFolderUrl ? `<a href="${data.current.captureFolderUrl}" target="_blank">현재 캡처</a>` : '<span style="color:#9CA3AF">캡처 미연결</span>';
  const curR = data.current && data.current.folderUrl ? `<a href="${data.current.folderUrl}" target="_blank">현재 리뷰</a>` : '<span style="color:#9CA3AF">리뷰 미연결</span>';
  const curLine = `현재 연결: ${curC} · ${curR}`;

  const badge = (g) => {
    if (g === 'capture') return '<span style="background:#DBEAFE;color:#1D4ED8;padding:1px 6px;border-radius:4px;font-size:.66rem;font-weight:700">캡처후보</span>';
    if (g === 'review') return '<span style="background:#DCFCE7;color:#166534;padding:1px 6px;border-radius:4px;font-size:.66rem;font-weight:700">리뷰후보</span>';
    if (g === 'container') return '<span style="background:#F3E8FF;color:#7C3AED;padding:1px 6px;border-radius:4px;font-size:.66rem;font-weight:700">상위폴더</span>';
    return '<span style="background:#F3F4F6;color:#6B7280;padding:1px 6px;border-radius:4px;font-size:.66rem">기타</span>';
  };

  if (modal._candidates.length === 0) {
    resultEl.innerHTML = `${warn ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:8px;margin-bottom:8px">${warn}</div>` : ''}<div style="padding:12px;color:#6B7280">검색 결과가 없습니다. 검색어를 바꿔 다시 시도하세요.<br><span style="color:#9CA3AF;font-size:.68rem">시도한 검색어: ${escHtml((data.searchTerms || []).join(' / '))}</span></div>`;
    return;
  }

  const rows = modal._candidates.map((c, i) => `
    <div style="border:1px solid #E5E7EB;border-radius:8px;padding:10px;margin-bottom:7px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
        ${badge(c.guess)}
        <span style="font-weight:600;color:#111;font-size:.78rem;word-break:break-all">${escHtml(c.name)}</span>
        <a href="${c.url}" target="_blank" style="margin-left:auto;color:#3182f6;font-size:.7rem;white-space:nowrap"><i class="fas fa-up-right-from-square"></i> 열기</a>
      </div>
      <div style="font-size:.68rem;color:#6B7280;margin-bottom:5px">
        상위: ${escHtml(c.parentName || '-')} · 파일 ${c.fileCount}개${c.reviewLikeCount ? ` (리뷰형식 ${c.reviewLikeCount})` : ''}${c.owner ? ' · ' + escHtml(c.owner) : ''}
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="pickFolderCandidate('capture',${i})" style="flex:1;padding:5px;background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE;border-radius:5px;font-size:.7rem;font-weight:600;cursor:pointer">📸 캡처로 지정</button>
        <button onclick="pickFolderCandidate('review',${i})" style="flex:1;padding:5px;background:#F0FDF4;color:#166534;border:1px solid #BBF7D0;border-radius:5px;font-size:.7rem;font-weight:600;cursor:pointer">📝 리뷰로 지정</button>
      </div>
    </div>`).join('');

  resultEl.innerHTML = `${warn
    ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:8px;margin-bottom:8px">${warn}<div style="font-size:.68rem;color:#92400E;margin-top:2px">${curLine}</div></div>`
    : `<div style="font-size:.7rem;color:#6B7280;margin-bottom:8px">${curLine}</div>`}${rows}`;
  _renderFolderPick();
}

/** 후보를 캡처/리뷰 대상으로 지정 */
function pickFolderCandidate(kind, idx) {
  const modal = document.getElementById('folderRelinkModal');
  if (!modal || !modal._candidates) return;
  const c = modal._candidates[idx];
  if (!c) return;
  const label = c.name + (c.parentName ? ' (' + c.parentName + ')' : '');
  if (kind === 'capture') { modal._pick.captureUrl = c.url; modal._pick.captureName = label; }
  else { modal._pick.reviewUrl = c.url; modal._pick.reviewName = label; }
  _renderFolderPick();
}

/** 지정 현황 + 저장버튼 상태 갱신 */
function _renderFolderPick() {
  const modal = document.getElementById('folderRelinkModal');
  if (!modal) return;
  const p = modal._pick;
  const box = document.getElementById('frlPick');
  const saveBtn = document.getElementById('frlSaveBtn');
  const hasAny = !!(p.captureUrl || p.reviewUrl);
  if (box) {
    box.style.display = hasAny ? 'block' : 'none';
    if (hasAny) {
      box.innerHTML =
        `<div style="font-weight:700;color:#6D28D9;margin-bottom:4px"><i class="fas fa-link"></i> 재연결 대상</div>` +
        `<div>📸 캡처폴더: ${p.captureUrl ? escHtml(p.captureName) : '<span style="color:#9CA3AF">미지정(변경 안 함)</span>'}</div>` +
        `<div>📝 리뷰폴더: ${p.reviewUrl ? escHtml(p.reviewName) : '<span style="color:#9CA3AF">미지정(변경 안 함)</span>'}</div>`;
    }
  }
  if (saveBtn) { saveBtn.disabled = !hasAny; saveBtn.style.opacity = hasAny ? '1' : '.5'; }
}

/** 지정한 폴더 URL을 tab_configs에 저장(재연결) */
async function saveFolderRelink() {
  const modal = document.getElementById('folderRelinkModal');
  if (!modal) return;
  const tab = modal._tabs[parseInt(document.getElementById('frlTabSel').value, 10)];
  const p = modal._pick;
  if (!tab || (!p.captureUrl && !p.reviewUrl)) { showToast('지정된 폴더가 없습니다.', 'info'); return; }

  const urls = {};
  if (p.captureUrl) urls.captureFolderUrl = p.captureUrl;
  if (p.reviewUrl) urls.folderUrl = p.reviewUrl;

  const saveBtn = document.getElementById('frlSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 저장 중...'; }

  let data;
  try {
    data = await gasPost({ action: 'updateFolderUrls', sheetId: tab.sheetId, tabName: tab.tabName, urls });
  } catch (e) {
    showToast('저장 실패: ' + (e.message || ''), 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> 재연결 저장'; }
    return;
  }
  if (!data || data.error) {
    showToast((data && data.error) || '저장 실패', 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> 재연결 저장'; }
    return;
  }

  showToast('폴더 링크가 재연결되었습니다.', 'info');
  modal.remove();
  try { loadTabDashboard(); } catch (_) {}
}

/**
 * 탭 선택 후 해당 탭의 중복 미리보기 실행
 */
async function selectDedupeTab(idx) {
  const modal = document.getElementById('dedupeSelectorModal');
  if (!modal || !modal._tabsWithFolder) return;

  const tab = modal._tabsWithFolder[idx];
  if (!tab) return;

  // 선택된 항목 로딩 표시
  const rows = modal.querySelectorAll('.dedupe-sel-row');
  if (rows[idx]) {
    rows[idx].style.background = '#FEF3C7';
    rows[idx].innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#D97706"></i><span style="font-size:.8rem;color:#6B7280">중복 검사 중...</span>`;
  }

  try {
    const token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token');
    const resp = await fetch(API_BASE_URL + '/api/dedupe/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? 'Bearer ' + token : '',
      },
      body: JSON.stringify({ sheetId: tab.sheetId, tabName: tab.tabName }),
    });
    const data = await resp.json();

    // 선택 모달 닫기
    modal.remove();

    if (!resp.ok || data.error) {
      showToast(data.error || '중복 검사 실패', 'error');
      return;
    }

    if (data.duplicateGroups === 0) {
      showToast(`중복 파일 없음 (총 ${data.totalFiles}개 파일 검사 완료)`, 'success');
      return;
    }

    // 미리보기 모달 표시
    _renderDedupeModal(data, tab.sheetId, tab.tabName, tab.folderUrl);
  } catch (err) {
    modal.remove();
    showToast('중복 검사 오류: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// ★ 옵션(Option) 기능 — 시트 헤더 분석 + 옵션 컬럼 선택 모달
// ═══════════════════════════════════════════════════════════

async function openOptionModal(sheetId, tabName, gid, round) {
  // 기존 모달 제거
  document.getElementById('optionModal')?.remove();

  const roundLabel = round ? ` [${round}]` : '';
  const modal = document.createElement('div');
  modal.id = 'optionModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999';
  modal.innerHTML = `<div style="background:#fff;border-radius:14px;width:520px;max-width:92vw;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2);padding:0">
    <div style="padding:18px 22px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:.95rem;font-weight:700;color:#1F2937"><i class="fas fa-tags" style="color:#3182f6;margin-right:8px"></i>옵션 컬럼 설정 — ${escHtml(tabName)}${roundLabel}</div>
      <button onclick="document.getElementById('optionModal')?.remove()" style="background:none;border:none;font-size:1.1rem;cursor:pointer;color:#6B7280">&times;</button>
    </div>
    <div id="optionModalBody" style="padding:18px 22px">
      <div style="text-align:center;padding:30px"><i class="fas fa-spinner fa-spin" style="color:#3182f6;font-size:1.5rem"></i><div style="margin-top:8px;font-size:.8rem;color:#6B7280">시트 헤더 분석 중...</div></div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  // ★ 바깥 클릭 시 모달 닫히지 않도록 — 이벤트 리스너 제거

  try {
    const params = { action:'getOptionHeaders', sheetId, tabName };
    if (gid) params.gid = gid;
    if (round) params.round = round;
    const data = await gasGet(params);
    if (data.error) { _optionModalError(data.error); return; }

    const body = document.getElementById('optionModalBody');
    if (!body) return;

    const candidates = data.optionCandidates || [];
    const saved = (data.savedOptionColumns || []).map(c => c.name);

    if (candidates.length === 0) {
      body.innerHTML = `<div style="text-align:center;padding:20px;color:#6B7280"><i class="fas fa-info-circle" style="margin-right:6px"></i>옵션으로 사용할 수 있는 헤더가 없습니다.<br><span style="font-size:.72rem">(모든 헤더가 시스템 컬럼으로 분류됨)</span></div>`;
      return;
    }

    let html = `<div style="font-size:.78rem;color:#6B7280;margin-bottom:12px"><i class="fas fa-info-circle" style="margin-right:4px"></i>헤더 행: ${data.headerRow}행 / 전체 ${data.totalHeaders}개 중 후보 ${candidates.length}개</div>`;
    html += `<div style="margin-bottom:14px">`;
    candidates.forEach((c, i) => {
      const checked = saved.includes(c.name) ? 'checked' : '';
      html += `<label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;margin-bottom:3px;transition:background .15s;border:1px solid ${checked?'#3182f6':'#E5E7EB'};background:${checked?'#f2f7ff':'#fff'}" 
        onmouseover="this.style.background='#f2f7ff'" onmouseout="this.style.background=this.querySelector('input').checked?'#f2f7ff':'#fff'">
        <input type="checkbox" name="optCol" value="${i}" data-name="${escHtml(c.name)}" data-colidx="${c.colIndex}" ${checked} style="width:16px;height:16px;accent-color:#3182f6;cursor:pointer"
          onchange="this.parentElement.style.border=this.checked?'1px solid #3182f6':'1px solid #E5E7EB';this.parentElement.style.background=this.checked?'#f2f7ff':'#fff';_onOptionCheckChange()">
        <span style="font-size:.82rem;font-weight:${checked?'600':'500'};color:#1F2937">${escHtml(c.name)}</span>
        <span style="font-size:.65rem;color:#9CA3AF;margin-left:auto">col ${c.colIndex+1}</span>
      </label>`;
    });
    html += `</div>`;

    // 시스템 헤더 접기
    const sysHeaders = data.systemHeaders || [];
    if (sysHeaders.length > 0) {
      html += `<details style="margin-bottom:14px"><summary style="font-size:.72rem;color:#9CA3AF;cursor:pointer;user-select:none"><i class="fas fa-eye-slash" style="margin-right:4px"></i>제외된 시스템 헤더 (${sysHeaders.length}개)</summary>
        <div style="padding:8px;background:#F9FAFB;border-radius:8px;margin-top:6px;font-size:.7rem;color:#6B7280;line-height:1.6">${sysHeaders.map(s=>escHtml(s.name)).join(', ')}</div>
      </details>`;
    }

    // 미리보기 영역
    html += `<div id="optionPreviewArea" style="display:none;margin-bottom:14px"></div>`;

    // ★ 버튼: 초기화(항상 표시) + 미리보기 + 닫기 / 저장 버튼은 미리보기 성공 후에만 나타남
    html += `<div id="optionModalBtnArea" style="display:flex;gap:8px;justify-content:flex-end;padding-top:10px;border-top:1px solid #E5E7EB">
      <button id="optionClearBtn" onclick="_clearOptionColumns('${escHtml(sheetId)}','${escHtml(tabName)}','${escHtml(round||'')}')" style="padding:8px 14px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;font-size:.8rem;cursor:pointer;color:#DC2626;font-weight:500;margin-right:auto" title="이 차수의 옵션 설정을 모두 제거합니다"><i class="fas fa-trash-alt" style="margin-right:4px"></i>옵션 초기화</button>
      <button id="optionPreviewBtn" onclick="_previewOptionData('${escHtml(sheetId)}','${escHtml(tabName)}','${escHtml(gid||'')}','${escHtml(round||'')}')" style="padding:8px 16px;background:#e8f1fe;border:1px solid #6fa6f5;border-radius:8px;font-size:.8rem;cursor:pointer;color:#1b64da;font-weight:500"><i class="fas fa-eye" style="margin-right:4px"></i>미리보기</button>
      <button onclick="document.getElementById('optionModal')?.remove()" style="padding:8px 16px;background:#F3F4F6;border:1px solid #D1D5DB;border-radius:8px;font-size:.8rem;cursor:pointer;color:#4B5563">닫기</button>
      <button id="optionSaveBtn" onclick="_saveOptionColumns('${escHtml(sheetId)}','${escHtml(tabName)}','${escHtml(round||'')}')" style="display:none;padding:8px 20px;background:#3182f6;color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer"><i class="fas fa-save" style="margin-right:4px"></i>저장</button>
    </div>`;

    body.innerHTML = html;
  } catch (err) {
    _optionModalError(err.message);
  }
}

// ★ 체크박스 변경 시 미리보기 초기화 + 저장 버튼 숨김 (다시 미리보기해야 저장 가능)
function _onOptionCheckChange() {
  const saveBtn = document.getElementById('optionSaveBtn');
  if (saveBtn) saveBtn.style.display = 'none';
  const area = document.getElementById('optionPreviewArea');
  if (area) { area.style.display = 'none'; area.innerHTML = ''; }
}

// ★ 옵션 초기화: 체크 0개로 저장 (해당 차수의 옵션 완전 제거)
async function _clearOptionColumns(sheetId, tabName, round) {
  if (!confirm(`이 ${round ? round+' ' : ''}옵션 설정을 모두 제거하시겠습니까?`)) return;
  try {
    const postBody = { action:'saveOptionColumns', sheetId, tabName, optionColumns: [] };
    if (round) postBody.round = round;
    const data = await gasPost(postBody);
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast(`옵션 초기화 완료${round ? ' ('+round+')' : ''}`, 'success');
    const origTab = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
    if (origTab) {
      if (round) {
        if (!origTab.option_columns_map) origTab.option_columns_map = {};
        origTab.option_columns_map[round] = [];
      } else {
        origTab.option_columns = [];
      }
    }
    renderTabDashTable();
    document.getElementById('optionModal')?.remove();
  } catch (err) {
    showToast('초기화 실패: ' + err.message, 'error');
  }
}

function _optionModalError(msg) {
  const body = document.getElementById('optionModalBody');
  if (body) body.innerHTML = `<div style="text-align:center;padding:20px;color:#DC2626"><i class="fas fa-exclamation-triangle" style="margin-right:6px"></i>${escHtml(msg)}</div>`;
}

async function _saveOptionColumns(sheetId, tabName, round) {
  const checks = document.querySelectorAll('#optionModal input[name="optCol"]:checked');
  const optionColumns = Array.from(checks).map(el => ({
    name: el.dataset.name,
    colIndex: parseInt(el.dataset.colidx)
  }));

  try {
    const postBody = { action:'saveOptionColumns', sheetId, tabName, optionColumns };
    if (round) postBody.round = round;
    const data = await gasPost(postBody);
    if (data.error) { showToast(data.error, 'error'); return; }
    showToast(`옵션 컬럼 ${optionColumns.length}개 저장 완료${round ? ' ('+round+')' : ''}`, 'success');
    // 로컬 데이터 업데이트 + 모달 닫기
    const origTab = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
    if (origTab) {
      if (round) {
        // ★ 차수별 저장: option_columns_map[round] 업데이트
        if (!origTab.option_columns_map) origTab.option_columns_map = {};
        origTab.option_columns_map[round] = optionColumns;
      } else {
        origTab.option_columns = optionColumns;
      }
    }
    renderTabDashTable();
    document.getElementById('optionModal')?.remove();
  } catch (err) {
    showToast('저장 실패: ' + err.message, 'error');
  }
}

// ── 옵션 데이터 미리보기 (관리자 모달 내) ──
// ★ 현재 체크된 체크박스 기준으로 서버에 columns 파라미터 전달 (DB 저장 없이 프리뷰)
async function _previewOptionData(sheetId, tabName, gid, round) {
  // 체크된 항목 수집
  const checks = document.querySelectorAll('#optionModal input[name="optCol"]:checked');
  if (checks.length === 0) {
    showToast('미리볼 옵션 컬럼을 1개 이상 선택하세요.', 'info');
    return;
  }
  const selectedCols = Array.from(checks).map(el => ({
    name: el.dataset.name,
    colIndex: parseInt(el.dataset.colidx)
  }));

  const area = document.getElementById('optionPreviewArea');
  if (!area) return;
  area.style.display = 'block';
  area.innerHTML = `<div style="text-align:center;padding:16px"><i class="fas fa-spinner fa-spin" style="color:#3182f6"></i> <span style="font-size:.78rem;color:#6B7280">옵션 데이터 로드 중...</span></div>`;

  try {
    const params = { action:'getOptionData', sheetId, tabName, columns: JSON.stringify(selectedCols) };
    if (gid) params.gid = gid;
    if (round) params.round = round;
    const data = await gasGet(params);
    if (data.error) { area.innerHTML = `<div style="color:#DC2626;font-size:.78rem;padding:10px"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>${escHtml(data.error)}</div>`; return; }

    const rows = data.rows || [];
    const cols = data.optionColumns || [];
    if (rows.length === 0) {
      area.innerHTML = `<div style="color:#6B7280;font-size:.78rem;padding:10px;text-align:center"><i class="fas fa-info-circle" style="margin-right:4px"></i>${data.message || '옵션 데이터가 없습니다.'}</div>`;
      return;
    }

    // 테이블 렌더링
    let h = `<div style="font-size:.75rem;font-weight:600;color:#1b64da;margin-bottom:6px"><i class="fas fa-table" style="margin-right:4px"></i>옵션 데이터 미리보기 (${rows.length}명)</div>`;
    h += `<div style="max-height:250px;overflow-y:auto;border:1px solid #E5E7EB;border-radius:8px">`;
    h += `<table style="width:100%;border-collapse:collapse;font-size:.72rem"><thead><tr>`;
    h += `<th style="padding:6px 8px;background:#f2f7ff;border-bottom:1px solid #E5E7EB;text-align:left;font-weight:600;color:#1b64da;position:sticky;top:0">이름</th>`;
    if (cols.length > 0) {
      cols.forEach(c => { h += `<th style="padding:6px 8px;background:#f2f7ff;border-bottom:1px solid #E5E7EB;text-align:left;font-weight:600;color:#1b64da;position:sticky;top:0">${escHtml(c)}</th>`; });
    }
    h += `</tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const bg = i % 2 === 0 ? '#fff' : '#FAFAFA';
      h += `<tr style="background:${bg}"><td style="padding:5px 8px;border-bottom:1px solid #F3F4F6;font-weight:500">${escHtml(r.reviewerName)}</td>`;
      cols.forEach(c => {
        const v = r.options?.[c] || '';
        h += `<td style="padding:5px 8px;border-bottom:1px solid #F3F4F6;color:${v?'#1F2937':'#D1D5DB'}">${v ? escHtml(v) : '—'}</td>`;
      });
      h += `</tr>`;
    });
    h += `</tbody></table></div>`;
    area.innerHTML = h;

    // ★ 미리보기 성공 → 저장 버튼 표시
    const saveBtn = document.getElementById('optionSaveBtn');
    if (saveBtn) saveBtn.style.display = '';
  } catch (err) {
    area.innerHTML = `<div style="color:#DC2626;font-size:.78rem;padding:10px"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>${escHtml(err.message)}</div>`;
  }
}

/* ════════════════════════════════════════════════════════════
   관리자 공지사항 시스템 (DB 기반)
   - 마스터가 공지 작성 → 대상 관리자 로그인 시 팝업
   - 표시 기간 설정 가능
════════════════════════════════════════════════════════════ */

// ── 로그인 시 미읽은 공지 팝업 ──
async function _checkAdminNoticePopup() {
  try {
    const data = await gasGet({ action: 'getUnreadNotices' });
    if (!data.success || !data.notices || data.notices.length === 0) return;
    _showAdminNoticePopup(data.notices);
  } catch (err) {
    console.warn('[공지팝업] 조회 실패:', err.message);
  }
}

function _showAdminNoticePopup(notices) {
  // 기존 팝업 제거
  const existing = document.getElementById('adminNoticePopup');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'adminNoticePopup';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.classList.add('toss-overlay');

  let noticeHtml = '';
  notices.forEach((n, idx) => {
    const date = new Date(n.created_at).toLocaleDateString('ko-KR');
    const expDate = new Date(n.expires_at).toLocaleDateString('ko-KR');
    noticeHtml += `
      <div style="background:#FFF;border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px;margin-bottom:${idx < notices.length-1 ? '10px' : '0'}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="background:#DBEAFE;color:#1D4ED8;font-size:.65rem;font-weight:700;padding:2px 7px;border-radius:4px">공지</span>
          <span style="font-weight:700;font-size:.85rem;color:#1F2937">${_escNotice(n.title)}</span>
        </div>
        <div style="font-size:.78rem;color:#374151;line-height:1.6;white-space:pre-wrap;margin-bottom:8px">${_escNotice(n.content)}</div>
        <div style="font-size:.65rem;color:#9CA3AF;display:flex;gap:10px">
          <span><i class="fas fa-user" style="margin-right:3px"></i>${_escNotice(n.created_by)}</span>
          <span><i class="fas fa-calendar" style="margin-right:3px"></i>${date}</span>
          <span><i class="fas fa-clock" style="margin-right:3px"></i>${expDate}까지</span>
        </div>
      </div>`;
  });

  const noticeIds = notices.map(n => n.id);
  // 전역에 임시 저장 (onclick에서 안전하게 참조)
  window._pendingNoticeIds = noticeIds;
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.2);max-width:480px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:16px 20px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;gap:8px;background:#F8FAFC">
        <i class="fas fa-bullhorn" style="color:#F59E0B;font-size:1rem"></i>
        <span style="font-weight:700;font-size:.9rem;color:#1F2937">관리자 공지사항</span>
        <span style="margin-left:auto;background:#FEF3C7;color:#92400E;font-size:.68rem;font-weight:600;padding:2px 8px;border-radius:10px">${notices.length}건</span>
      </div>
      <div style="padding:16px 20px;overflow-y:auto;flex:1">
        ${noticeHtml}
      </div>
      <div style="padding:12px 20px;border-top:1px solid #E5E7EB;display:flex;justify-content:flex-end;gap:8px;background:#F8FAFC">
        <button onclick="_dismissAdminNotices(window._pendingNoticeIds)" style="padding:6px 16px;background:#3B82F6;color:#fff;border:none;border-radius:8px;font-size:.78rem;font-weight:600;cursor:pointer">
          <i class="fas fa-check" style="margin-right:4px"></i>확인
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}

async function _dismissAdminNotices(noticeIds) {
  const popup = document.getElementById('adminNoticePopup');
  if (popup) popup.remove();
  // 각 공지를 읽음 처리
  for (const id of noticeIds) {
    try {
      await gasPost({ action: 'markNoticeRead', notice_id: id });
    } catch (e) { /* ignore */ }
  }
}

function _escNotice(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 마스터 전용: 공지사항 관리 모달 ──
async function openNoticeMgmt() {
  if (!isMaster()) { showToast('마스터 권한이 필요합니다.', 'error'); return; }
  let modal = document.getElementById('noticeMgmtModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'noticeMgmtModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.classList.add('toss-overlay');
    modal.innerHTML = `
      <div style="background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.15);max-width:600px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 20px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;background:#F8FAFC">
          <i class="fas fa-bullhorn" style="color:#F59E0B;margin-right:8px"></i>
          <span style="font-weight:700;font-size:.9rem">공지사항 관리</span>
          <button onclick="closeNoticeMgmt()" style="margin-left:auto;background:none;border:none;font-size:1.1rem;cursor:pointer;color:#6B7280">&times;</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1" id="noticeMgmtBody">
          <div style="text-align:center;color:#9CA3AF;padding:20px"><i class="fas fa-circle-notch fa-spin"></i> 로딩 중...</div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  } else {
    modal.style.display = 'flex';
  }
  await _loadNoticeMgmtList();
}
function closeNoticeMgmt() {
  const m = document.getElementById('noticeMgmtModal');
  if (m) m.style.display = 'none';
}

async function _loadNoticeMgmtList() {
  const body = document.getElementById('noticeMgmtBody');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center;color:#9CA3AF;padding:20px"><i class="fas fa-circle-notch fa-spin"></i> 로딩 중...</div>';
  try {
    const data = await gasGet({ action: 'getAllNotices' });
    if (!data.success) throw new Error(data.error || '조회 실패');
    const notices = data.notices || [];

    let html = `
      <button onclick="_openNoticeForm()" style="width:100%;padding:10px;background:#3B82F6;color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer;margin-bottom:14px">
        <i class="fas fa-plus" style="margin-right:4px"></i>새 공지 작성
      </button>`;

    if (notices.length === 0) {
      html += '<div style="text-align:center;color:#9CA3AF;padding:30px;font-size:.8rem">등록된 공지가 없습니다.</div>';
    } else {
      notices.forEach(n => {
        const created = new Date(n.created_at).toLocaleDateString('ko-KR');
        const expires = new Date(n.expires_at).toLocaleDateString('ko-KR');
        const isExpired = new Date(n.expires_at) < new Date();
        const statusBadge = isExpired
          ? '<span style="background:#FEE2E2;color:#DC2626;font-size:.6rem;padding:1px 5px;border-radius:4px;font-weight:600">만료</span>'
          : '<span style="background:#D1FAE5;color:#065F46;font-size:.6rem;padding:1px 5px;border-radius:4px;font-weight:600">활성</span>';
        const targets = n.target_names && n.target_names.length > 0 ? n.target_names.join(', ') : '전체';
        html += `
          <div style="border:1px solid #E5E7EB;border-radius:8px;padding:12px;margin-bottom:8px;${isExpired ? 'opacity:.6' : ''}">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              ${statusBadge}
              <span style="font-weight:600;font-size:.82rem">${_escNotice(n.title)}</span>
              <span style="margin-left:auto;font-size:.65rem;color:#9CA3AF">${n.display_days}일간</span>
            </div>
            <div style="font-size:.74rem;color:#4B5563;line-height:1.5;white-space:pre-wrap;margin-bottom:6px;max-height:60px;overflow:hidden">${_escNotice(n.content)}</div>
            <div style="display:flex;align-items:center;gap:8px;font-size:.65rem;color:#9CA3AF">
              <span>대상: ${_escNotice(targets)}</span>
              <span>${created} ~ ${expires}</span>
              <div style="margin-left:auto;display:flex;gap:4px">
                <button onclick="_editNotice(${n.id})" style="padding:2px 8px;background:#e8f1fe;color:#1b64da;border:none;border-radius:4px;font-size:.65rem;cursor:pointer">수정</button>
                <button onclick="_deleteNotice(${n.id})" style="padding:2px 8px;background:#FEE2E2;color:#DC2626;border:none;border-radius:4px;font-size:.65rem;cursor:pointer">삭제</button>
              </div>
            </div>
          </div>`;
      });
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div style="color:#DC2626;font-size:.8rem;padding:16px">오류: ${_escNotice(err.message)}</div>`;
  }
}

// 공지 작성/수정 폼
function _openNoticeForm(editData) {
  const body = document.getElementById('noticeMgmtBody');
  if (!body) return;
  const isEdit = !!editData;
  const title = editData ? editData.title : '';
  const content = editData ? editData.content : '';
  const days = editData ? editData.display_days : 7;
  const targets = editData && editData.target_names && editData.target_names.length > 0 ? editData.target_names.join(', ') : '';

  body.innerHTML = `
    <div style="margin-bottom:12px">
      <button onclick="_loadNoticeMgmtList()" style="background:none;border:none;color:#6B7280;font-size:.78rem;cursor:pointer"><i class="fas fa-arrow-left" style="margin-right:4px"></i>목록으로</button>
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:.72rem;font-weight:600;color:#374151;display:block;margin-bottom:3px">제목</label>
      <input id="noticeFormTitle" type="text" value="${_escNotice(title)}" placeholder="공지 제목" style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:.8rem;box-sizing:border-box">
    </div>
    <div style="margin-bottom:10px">
      <label style="font-size:.72rem;font-weight:600;color:#374151;display:block;margin-bottom:3px">내용</label>
      <textarea id="noticeFormContent" rows="5" placeholder="공지 내용을 입력하세요" style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:.8rem;resize:vertical;box-sizing:border-box">${_escNotice(content)}</textarea>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:10px">
      <div style="flex:1">
        <label style="font-size:.72rem;font-weight:600;color:#374151;display:block;margin-bottom:3px">표시 기간 (일)</label>
        <input id="noticeFormDays" type="number" min="1" max="365" value="${days}" style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:.8rem;box-sizing:border-box">
      </div>
      <div style="flex:2">
        <label style="font-size:.72rem;font-weight:600;color:#374151;display:block;margin-bottom:3px">대상 (비워두면 전체, 쉼표 구분)</label>
        <input id="noticeFormTargets" type="text" value="${_escNotice(targets)}" placeholder="예: 박은비, 박세희" style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:6px;font-size:.8rem;box-sizing:border-box">
      </div>
    </div>
    <button onclick="_submitNoticeForm(${isEdit ? editData.id : 'null'})" style="width:100%;padding:10px;background:#3B82F6;color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer">
      <i class="fas fa-${isEdit ? 'save' : 'paper-plane'}" style="margin-right:4px"></i>${isEdit ? '수정 저장' : '공지 등록'}
    </button>`;
}

async function _submitNoticeForm(editId) {
  const title = document.getElementById('noticeFormTitle').value.trim();
  const content = document.getElementById('noticeFormContent').value.trim();
  const display_days = parseInt(document.getElementById('noticeFormDays').value) || 7;
  const targetsRaw = document.getElementById('noticeFormTargets').value.trim();
  const target_names = targetsRaw ? targetsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (!title) { showToast('제목을 입력하세요.', 'warning'); return; }
  if (!content) { showToast('내용을 입력하세요.', 'warning'); return; }

  showLoading('저장 중...');
  try {
    if (editId) {
      // PUT (직접 fetch — action map에 :id 미지원)
      const token = sessionStorage.getItem('admin_token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch(API_BASE_URL + '/api/admin/notices/' + editId, {
        method: 'PUT', headers, body: JSON.stringify({ title, content, display_days, target_names })
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || '수정 실패');
    } else {
      const data = await gasPost({ action: 'createNotice', title, content, display_days, target_names });
      if (!data.success) throw new Error(data.error || '등록 실패');
    }
    hideLoading();
    showToast(editId ? '공지가 수정되었습니다.' : '공지가 등록되었습니다.', 'success');
    await _loadNoticeMgmtList();
  } catch (err) {
    hideLoading();
    showToast('오류: ' + err.message, 'error');
  }
}

async function _editNotice(id) {
  showLoading('불러오는 중...');
  try {
    const data = await gasGet({ action: 'getAllNotices' });
    hideLoading();
    if (!data.success) throw new Error(data.error);
    const notice = (data.notices || []).find(n => n.id === id);
    if (!notice) { showToast('공지를 찾을 수 없습니다.', 'error'); return; }
    _openNoticeForm(notice);
  } catch (err) {
    hideLoading();
    showToast('오류: ' + err.message, 'error');
  }
}

async function _deleteNotice(id) {
  if (!confirm('이 공지를 삭제하시겠습니까?')) return;
  showLoading('삭제 중...');
  try {
    const token = sessionStorage.getItem('admin_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(API_BASE_URL + '/api/admin/notices/' + id, {
      method: 'DELETE', headers
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || '삭제 실패');
    hideLoading();
    showToast('공지가 삭제되었습니다.', 'success');
    await _loadNoticeMgmtList();
  } catch (err) {
    hideLoading();
    showToast('오류: ' + err.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ C/S 문의창구 — 관리자
   리뷰어별 채팅방 목록 + 메신저형 대화방 + 관리자 전용 메모
   ══════════════════════════════════════════════════════════════ */
let _csRooms = [];               // 방 목록 캐시
let _csActiveThreadId = null;    // 현재 열린 대화방 threadId

async function loadCsRooms() {
  const wrap = document.getElementById("csRoomListWrap");
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:30px;text-align:center;color:#9CA3AF;font-size:.85rem"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>';
  const status = (document.getElementById("csStatusFilter") || {}).value || "all";
  const q = (document.getElementById("csSearchInput") || {}).value || "";
  try {
    const data = await gasGet({ action: "csAdminThreads", status, q });
    if (!data || data.ok === false) throw new Error((data && data.error) || "불러오기 실패");
    _csRooms = data.threads || [];
    _renderCsRooms(_csRooms);
    csUpdateBadge(data.totalUnread || 0);
  } catch (err) {
    wrap.innerHTML = `<div style="padding:30px;text-align:center;color:#EF4444;font-size:.85rem">오류: ${escHtml(err.message)}</div>`;
  }
}

function csFilterRooms(keyword) {
  const kw = (keyword || "").trim().toLowerCase();
  if (!kw) { _renderCsRooms(_csRooms); return; }
  const filtered = _csRooms.filter(r =>
    (r.reviewerName || "").toLowerCase().includes(kw) ||
    (r.reviewerPhone8 || "").includes(kw) ||
    (r.campaignLabel || "").toLowerCase().includes(kw)
  );
  _renderCsRooms(filtered);
}

function _csTimeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso); const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return m + "분 전";
  const h = Math.floor(m / 60); if (h < 24) return h + "시간 전";
  const day = Math.floor(h / 24); if (day < 7) return day + "일 전";
  return d.toLocaleDateString("ko-KR");
}

function _renderCsRooms(list) {
  const wrap = document.getElementById("csRoomListWrap");
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<div style="padding:40px;text-align:center;color:#9CA3AF;font-size:.85rem"><i class="fas fa-comment-slash" style="font-size:1.6rem;display:block;margin-bottom:8px;opacity:.5"></i>문의가 없습니다.</div>';
    return;
  }
  // 리뷰어별 그룹핑(이름+phone8 기준), 그룹 내 최근순
  const groups = new Map();
  list.forEach(r => {
    const key = (r.reviewerName || "?") + "|" + (r.reviewerPhone8 || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  let html = "";
  for (const [key, rooms] of groups) {
    const [name, phone8] = key.split("|");
    const unread = rooms.reduce((s, r) => s + (r.adminUnread || 0), 0);
    const memo = (rooms.find(r => r.adminMemo) || {}).adminMemo || "";
    html += `<div style="padding:10px 14px;background:#f7faff;border-bottom:1px solid #eef2f7">
      <div style="display:flex;align-items:center;gap:8px">
        <i class="fas fa-user-circle" style="color:#94a3b8"></i>
        <span style="font-weight:700;color:var(--t1);font-size:.86rem">${escHtml(name)}</span>
        <span style="color:#94a3b8;font-size:.74rem;font-family:monospace">${escHtml(phone8)}</span>
        ${unread > 0 ? `<span style="margin-left:auto;background:#EF4444;color:#fff;font-size:.66rem;font-weight:700;padding:1px 7px;border-radius:10px">미확인 ${unread}</span>` : ''}
      </div>
      ${memo ? `<div title="관리자 메모(리뷰어 비공개)" style="margin-top:5px;font-size:.72rem;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:3px 8px;display:flex;gap:5px;align-items:flex-start">
        <i class="fas fa-lock" style="font-size:.62rem;margin-top:3px;opacity:.7;flex-shrink:0"></i>
        <span style="white-space:pre-wrap;word-break:break-word">${escHtml(memo)}</span></div>` : ''}
    </div>`;
    rooms.forEach(r => {
      const nameSafe = (r.reviewerName || "").replace(/'/g, "\\'");
      const phoneSafe = (r.reviewerPhone8 || "").replace(/'/g, "\\'");
      const statusChip = r.status === 'closed'
        ? '<span style="background:#F3F4F6;color:#6B7280;font-size:.66rem;padding:1px 7px;border-radius:8px">종료</span>'
        : '<span style="background:#D1FAE5;color:#065F46;font-size:.66rem;padding:1px 7px;border-radius:8px">진행중</span>';
      html += `<div class="cs-room-row" data-tid="${r.id}" onclick="csOpenConversation('${r.id}','${nameSafe}','${phoneSafe}')"
        style="padding:11px 16px 11px 30px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
            <i class="fas fa-tag" style="color:#cbd5e1;font-size:.7rem"></i>
            <span style="font-weight:600;color:var(--t1);font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.campaignLabel || '문의')}</span>
            ${statusChip}
          </div>
          <div style="color:var(--t3);font-size:.76rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.lastMessagePreview || '')}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="color:#9CA3AF;font-size:.7rem">${_csTimeAgo(r.lastMessageAt)}</div>
          ${r.adminUnread > 0 ? `<span style="display:inline-block;margin-top:3px;background:#EF4444;color:#fff;font-size:.64rem;font-weight:700;padding:1px 6px;border-radius:9px">${r.adminUnread}</span>` : ''}
        </div>
      </div>`;
    });
  }
  wrap.innerHTML = html;
  // 현재 열린 대화방 강조 유지
  if (_csActiveThreadId) {
    const el = wrap.querySelector(`.cs-room-row[data-tid="${_csActiveThreadId}"]`);
    if (el) el.classList.add('cs-room-active');
  }
}

async function csOpenConversation(threadId, reviewerName, reviewerPhone8) {
  _csActiveThreadId = threadId;
  // 좌측 목록에서 선택 강조
  document.querySelectorAll('.cs-room-row').forEach(el => el.classList.remove('cs-room-active'));
  const selEl = document.querySelector(`.cs-room-row[data-tid="${threadId}"]`);
  if (selEl) selEl.classList.add('cs-room-active');

  const pane = document.getElementById("csConvPane");
  if (!pane) return;
  pane.innerHTML = `
    <div style="padding:13px 16px;border-bottom:1px solid #eef2f7;display:flex;align-items:center;gap:8px">
      <i class="fas fa-comments" style="color:var(--p)"></i>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.9rem;color:var(--t1)">${escHtml(reviewerName)} <span style="color:#94a3b8;font-weight:400;font-size:.76rem;font-family:monospace">${escHtml(reviewerPhone8)}</span></div>
        <div id="csConvCampaign" style="font-size:.74rem;color:var(--t3)">불러오는 중...</div>
      </div>
      <button id="csConvStatusBtn" onclick="csToggleStatus()" style="padding:5px 10px;background:#F3F4F6;color:#374151;border:none;border-radius:8px;font-size:.74rem;font-weight:600;cursor:pointer">—</button>
    </div>
    <div style="display:flex;flex:1;min-height:0">
      <div id="csConvThread" style="flex:1;overflow-y:auto;padding:14px;background:#f9fafb;display:flex;flex-direction:column;gap:8px">
        <div style="text-align:center;color:#9CA3AF;font-size:.82rem"><i class="fas fa-circle-notch fa-spin"></i></div>
      </div>
      <div style="width:210px;flex-shrink:0;border-left:1px solid #eef2f7;padding:12px;display:flex;flex-direction:column;background:#fffdf5">
        <div style="font-size:.74rem;font-weight:700;color:#92400E;margin-bottom:6px"><i class="fas fa-lock"></i> 관리자 메모<div style="font-weight:400;font-size:.66rem;color:#b45309">리뷰어 비공개·영구저장</div></div>
        <textarea id="csMemoText" placeholder="이 리뷰어에 대한 메모..." style="flex:1;min-height:140px;resize:none;border:1px solid #FDE68A;border-radius:8px;padding:8px;font-size:.78rem;font-family:inherit;outline:none;background:#fff"></textarea>
        <button onclick="csSaveMemo('${(reviewerPhone8||'').replace(/'/g,"\\'")}')" style="margin-top:8px;padding:6px;background:#F59E0B;color:#fff;border:none;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer">메모 저장</button>
      </div>
    </div>
    <div style="padding:10px 12px;border-top:1px solid #eef2f7;display:flex;gap:8px;align-items:flex-end">
      <textarea id="csReplyText" rows="2" placeholder="답장 입력... (Shift+Enter 줄바꿈)" style="flex:1;resize:none;border:1px solid #e5e7eb;border-radius:10px;padding:9px;font-size:.82rem;font-family:inherit;outline:none"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();csSendReply('${threadId}');}"></textarea>
      <button onclick="csSendReply('${threadId}')" style="padding:10px 16px;background:#3182f6;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:.82rem;cursor:pointer;white-space:nowrap"><i class="fas fa-paper-plane"></i></button>
    </div>`;
  await csReloadConversation(threadId);
}

async function csReloadConversation(threadId) {
  if (_csActiveThreadId !== threadId) return;
  try {
    const data = await gasGet({ action: "csAdminMessages", threadId });
    if (!data || data.ok === false) throw new Error((data && data.error) || "불러오기 실패");
    const t = data.thread || {};
    const camp = document.getElementById("csConvCampaign");
    if (camp) {
      const sheet = t.companyLabel ? ` <span style="color:#9CA3AF">· 시트: ${escHtml(t.companyLabel)}</span>` : '';
      camp.innerHTML = `<i class="fas fa-tag" style="font-size:.68rem"></i> ${escHtml(t.campaignLabel || '문의')}${sheet}`;
    }
    const memo = document.getElementById("csMemoText");
    if (memo && document.activeElement !== memo) memo.value = t.adminMemo || "";
    const sBtn = document.getElementById("csConvStatusBtn");
    if (sBtn) {
      if (t.status === 'closed') { sBtn.textContent = "재오픈"; sBtn.dataset.status = "closed"; }
      else { sBtn.textContent = "문의 종료"; sBtn.dataset.status = "open"; }
    }
    _csRenderMessages(data.messages || []);
    // 대시보드 뱃지 동기화(열람 시 미확인 리셋됨)
    csRefreshBadge();
  } catch (err) {
    const thread = document.getElementById("csConvThread");
    if (thread) thread.innerHTML = `<div style="text-align:center;color:#EF4444;font-size:.82rem">오류: ${escHtml(err.message)}</div>`;
  }
}

function _csRenderMessages(messages) {
  const box = document.getElementById("csConvThread");
  if (!box) return;
  if (!messages.length) {
    box.innerHTML = '<div style="text-align:center;color:#9CA3AF;font-size:.82rem;margin-top:20px">아직 메시지가 없습니다.</div>';
    return;
  }
  box.innerHTML = messages.map(m => {
    const isAdmin = m.senderRole === 'admin';
    const ts = m.createdAt ? new Date(m.createdAt).toLocaleString("ko-KR", { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : "";
    return `<div style="display:flex;flex-direction:column;align-items:${isAdmin ? 'flex-end' : 'flex-start'}">
      <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${escHtml(m.senderName || (isAdmin ? '관리자' : '리뷰어'))}</div>
      <div style="max-width:78%;background:${isAdmin ? '#3182f6' : '#fff'};color:${isAdmin ? '#fff' : '#111827'};border:1px solid ${isAdmin ? '#3182f6' : '#e5e7eb'};padding:8px 11px;border-radius:12px;font-size:.83rem;line-height:1.45;white-space:pre-wrap;word-break:break-word">${escHtml(m.content || '')}</div>
      <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${ts}</div>
    </div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

async function csSendReply(threadId) {
  const ta = document.getElementById("csReplyText");
  if (!ta) return;
  const content = ta.value.trim();
  if (!content) return;
  ta.value = "";
  try {
    const data = await gasPost({ action: "csAdminReply", threadId, content });
    if (!data || data.ok === false) throw new Error((data && data.error) || "전송 실패");
    await csReloadConversation(threadId);
    loadCsRooms();
  } catch (err) {
    showToast("전송 오류: " + err.message, true);
    ta.value = content;
  }
}

async function csSaveMemo(phone8) {
  const memo = (document.getElementById("csMemoText") || {}).value || "";
  try {
    const data = await gasPost({ action: "csAdminSaveMemo", phone8, memo });
    if (!data || data.ok === false) throw new Error((data && data.error) || "저장 실패");
    showToast("메모가 저장되었습니다.");
    loadCsRooms(); // 좌측 목록의 메모 표시 갱신
  } catch (err) {
    showToast("메모 저장 오류: " + err.message, true);
  }
}

async function csToggleStatus() {
  const btn = document.getElementById("csConvStatusBtn");
  if (!btn || !_csActiveThreadId) return;
  const next = btn.dataset.status === 'closed' ? 'open' : 'closed';
  try {
    const data = await gasPost({ action: "csAdminStatus", threadId: _csActiveThreadId, status: next });
    if (!data || data.ok === false) throw new Error((data && data.error) || "변경 실패");
    showToast(next === 'closed' ? "문의를 종료했습니다." : "문의를 다시 열었습니다.");
    await csReloadConversation(_csActiveThreadId);
    loadCsRooms();
  } catch (err) {
    showToast("상태 변경 오류: " + err.message, true);
  }
}

function csCloseConversation() {
  _csActiveThreadId = null;
  document.querySelectorAll('.cs-room-row').forEach(el => el.classList.remove('cs-room-active'));
  const pane = document.getElementById("csConvPane");
  if (pane) pane.innerHTML = '<div style="margin:auto;text-align:center;color:var(--t3);padding:40px"><i class="fas fa-comments" style="font-size:2rem;display:block;margin-bottom:10px;opacity:.4"></i>왼쪽에서 문의방을 선택하세요</div>';
}

function csUpdateBadge(count) {
  const b = document.getElementById("csInquiryBadge");
  if (!b) return;
  if (count > 0) { b.textContent = count; b.style.display = "inline-block"; }
  else b.style.display = "none";
}

async function csRefreshBadge() {
  try {
    const data = await gasGet({ action: "csAdminUnread" });
    if (data && data.ok !== false) csUpdateBadge(data.totalUnread || 0);
  } catch (_) {}
}

/** SSE 수신 핸들러 (index-payment.js에서 호출) */
function csOnSSE(evtType, data) {
  data = data || {};
  // 대시보드 뱃지 갱신
  csRefreshBadge();
  // C/S 탭이 활성화되어 있으면 목록 새로고침
  const pane = document.getElementById("tab-cs-inquiry");
  if (pane && pane.classList.contains("active")) { try { loadCsRooms(); } catch(_){} }
  // 열린 대화방이 해당 스레드면 재조회
  if (_csActiveThreadId && data.threadId === _csActiveThreadId) {
    try { csReloadConversation(_csActiveThreadId); } catch(_){}
  }
}
window.csOnSSE = csOnSSE;

// ═══════════════════════════════════════════════════════════
// 리뷰 캡처 정리 — 내 드라이브 루트 등에 흩어진 리뷰 캡처를
//   선택한 탭의 [리뷰] 폴더로 모아 이동 (미리보기 → 실제 이동)
//   POST /api/drive/relocate-orphan-reviews (relocateOrphanReviews)
// ═══════════════════════════════════════════════════════════
let _relocateTabs = [];
let _relocateSelIdx = -1; // 콤보박스에서 선택된 탭 인덱스
let _relocateScanStop = false; // 전체 탭 스캔 중지 플래그
let _relocateScanResults = {}; // 탭별 스캔 결과 (localStorage 임시저장)

function _relocateCollectTabs() {
  // folder_url이 비어 있어도(=리뷰폴더 미연결) 선택 가능하도록 모든 탭을 포함.
  // (리뷰 캡처가 루트로 샌 탭은 folder_url이 비어 있을 수 있으므로)
  const out = [];
  if (typeof _tabDashData !== 'undefined' && _tabDashData && _tabDashData.tabs) {
    _tabDashData.tabs.forEach(t => {
      out.push({ sheetId: t.sheet_id, tabName: t.tab_name, displayName: t.display_name || t.tab_name, campName: t.campaign_name || '', folderUrl: t.folder_url || '' });
    });
  }
  if (out.length === 0 && typeof _lastDashData !== 'undefined' && _lastDashData && _lastDashData.stats) {
    _lastDashData.stats.forEach(camp => (camp.tabs || []).forEach(t => {
      out.push({ sheetId: t.sheetId, tabName: t.tab, displayName: t.displayName || t.tab, campName: camp.campaign || '', folderUrl: t.folderUrl || '' });
    }));
  }
  return out;
}

// 플랫폼/채널/일반어 — 키워드에서 제외(이게 들어가면 다른 캠페인까지 과대매칭됨)
const _RELOCATE_STOPWORDS = new Set([
  '네이버','쿠팡','쿠팡파트너스','파트너스','메이커스','카카오','카카오메이커스','11번가','지마켓','g마켓',
  '옥션','위메프','티몬','자사몰','스마트스토어','스토어','인스타','인스타그램','블로그','카페','체험단',
  '바이럴','리뷰','리뷰체험단','세트','박스','골드박스','시트','업무시트','견적서','실','현영'
]);

// 탭명에서 OCR 검색에 쓸 브랜드/상품 키워드 후보 추출 (플랫폼/일반어 제외)
//   "5/28(쿠팡)서일농원_명인콩물두유 170건" → ["서일농원", "명인콩물두유"]
//   "6/11퓨비아표백제_네이버15건" → ["퓨비아표백제"]  (네이버 제외)
function _relocateDeriveKeywords(tabName) {
  const out = [];
  const push = v => {
    v = (v || '').trim().replace(/\d+건?$/, '').trim();
    if (v && v.length >= 2 && !/^\d+$/.test(v) && !_RELOCATE_STOPWORDS.has(v) && !out.includes(v)) out.push(v);
  };
  let core = String(tabName || '');
  // 선두 날짜/채널 제거: "6/11", "6.17", "0618", "0528" + optional "(쿠팡)"
  core = core.replace(/^\s*(\d{1,2}\s*[\/.]\s*\d{1,2}|\d{3,4})\s*(\([^)]*\))?\s*/, '');
  // 후미 건수/차수 제거
  core = core.replace(/\s*\d+\s*건\s*$/, '').replace(/\s*\d+\s*차\s*$/, '').trim();
  core.split(/[_,/\s]+/).forEach(seg => push(seg));
  return out;
}

// 탭명에서 "작업건수"(N건) 추출 — 과대매칭 판정 기준
function _relocateParseCount(tabName) {
  const m = String(tabName || '').match(/(\d+)\s*건/);
  return m ? parseInt(m[1], 10) : 0;
}

// 후보 파일명 클릭 → 모달 내에서 이미지 인라인 펼침/접기 (서버 프록시로 비공개 파일도 표시)
function _relocateToggleImg(headerEl, id) {
  const box = headerEl.parentElement;
  const wrap = box && box.querySelector('.rlc-img');
  const chev = headerEl.querySelector('.fa-chevron-right');
  if (!wrap) return;
  if (wrap.style.display === 'none' || !wrap.style.display) {
    if (!wrap.dataset.loaded) {
      const proxy = `${API_BASE_URL}/api/drive/image/${encodeURIComponent(id)}`;
      const thumb = `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600`;
      wrap.innerHTML = `<div style="padding:4px 0 8px"><img src="${proxy}" loading="lazy" style="max-width:100%;max-height:440px;border-radius:8px;border:1px solid #E5E7EB;display:block" onerror="this.onerror=null;this.src='${thumb}'"></div>`;
      wrap.dataset.loaded = '1';
    }
    wrap.style.display = 'block';
    if (chev) chev.style.transform = 'rotate(90deg)';
  } else {
    wrap.style.display = 'none';
    if (chev) chev.style.transform = '';
  }
}

// 활성 탭 리뷰폴더 현황 점검 — 대시보드 활성탭 한정 + '리뷰폼' 제외 + 26.3+ 판정
async function _relocateFolderAudit() {
  const resultEl = document.getElementById('rlcResult');
  if (!resultEl) return;
  if (!_relocateTabs || !_relocateTabs.length) _relocateTabs = _relocateCollectTabs();
  const all = (_relocateTabs || []).map(t => ({ sheetId: t.sheetId, tabName: t.tabName, displayName: t.displayName, folderUrl: t.folderUrl }));
  if (!all.length) {
    resultEl.innerHTML = `<div style="font-size:.78rem;color:#DC2626">활성 탭 목록을 불러오지 못했습니다. 캠페인 탭 관리 대시보드를 먼저 연 뒤 다시 시도하세요.</div>`;
    return;
  }
  // 긴 단일요청 대신 여러 탭씩 나눠 호출 + 진행률 (타임아웃/멈춤 방지)
  resultEl.innerHTML = `<div style="font-size:.8rem;color:#3730A3;font-weight:700"><i class="fas fa-spinner fa-spin"></i> <span id="rlcAuditProg">리뷰폴더 점검 0/${all.length}…</span></div>`;
  const agg = { totalTabs: all.length, excluded: 0, connected: 0, nonEmpty: 0, empty: 0, noFolder: 0, preMarch: 0, errors: 0, ownerTally: {}, details: [] };
  const CHUNK = 8;
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    try {
      const res = await gasPost({ action: 'folderAudit', tabs: chunk, excludeName: '리뷰폼', sinceDate: '2026-03-01T00:00:00Z' }, 120000);
      if (res && res.ok !== false) {
        agg.excluded += res.excluded || 0; agg.connected += res.connected || 0; agg.nonEmpty += res.nonEmpty || 0;
        agg.empty += res.empty || 0; agg.noFolder += res.noFolder || 0; agg.preMarch += res.preMarch || 0; agg.errors += res.errors || 0;
        if (res.ownerTally) for (const k in res.ownerTally) agg.ownerTally[k] = (agg.ownerTally[k] || 0) + res.ownerTally[k];
        if (Array.isArray(res.details)) agg.details.push(...res.details);
      } else {
        agg.errors += chunk.length;
      }
    } catch (e) {
      agg.errors += chunk.length;
    }
    const prog = document.getElementById('rlcAuditProg');
    if (prog) prog.textContent = `리뷰폴더 점검 ${Math.min(i + CHUNK, all.length)}/${all.length}…`;
  }
  _renderFolderAudit(resultEl, agg);
}

function _renderFolderAudit(resultEl, res) {
  const d = res.details || [];
  const empties = d.filter(x => x.status === 'empty');
  const nofolder = d.filter(x => x.status === 'no-folder');
  const haves = d.filter(x => x.status === 'has-files').sort((a, b) => b.count - a.count);
  const pre = haves.filter(x => x.preMarch);
  const target = haves.filter(x => !x.preMarch); // 26.3+ 정상 폴더
  // 소유자 라벨 → 배지 (tnaks 외 소유자는 이관 대상이므로 강조)
  const ownBadge = (lbl) => {
    if (!lbl || lbl === 'tnaks6325') return '';
    const color = (lbl === '박세희' || lbl === '박은비') ? '#DC2626' : (lbl === 'service-account' ? '#6B7280' : '#B45309');
    return ` <span style="font-size:.62rem;font-weight:700;color:${color};background:${color}1A;border-radius:4px;padding:0 4px">${escHtml(lbl)}</span>`;
  };
  const liH = arr => arr.map(x => `<li style="font-size:.7rem;color:#374151;word-break:break-all">${escHtml(x.tab)}${ownBadge(x.ownerLabel)}${x.count ? ` <span style="color:#9CA3AF">— ${x.count}건${x.earliest ? `, 최초 ${x.earliest}` : ''}</span>` : ''}</li>`).join('');
  const li = arr => arr.map(x => `<li style="font-size:.7rem;color:#374151;word-break:break-all">${escHtml(x.tab)}${ownBadge(x.ownerLabel)}</li>`).join('');
  // 소유자 집계 + 이관 대상(tnaks 외) 강조
  const ot = res.ownerTally || {};
  const otOrder = ['tnaks6325', '박세희', '박은비', 'service-account', '기타', 'unknown'];
  const otKeys = otOrder.filter(k => ot[k]).concat(Object.keys(ot).filter(k => otOrder.indexOf(k) < 0));
  const nonTnaks = Object.keys(ot).reduce((s, k) => s + (k === 'tnaks6325' ? 0 : (ot[k] || 0)), 0);
  const ownerChips = otKeys.map(k => {
    const isMine = k === 'tnaks6325';
    const c = isMine ? '#059669' : (k === '박세희' || k === '박은비') ? '#DC2626' : '#B45309';
    return `<span style="font-size:.68rem;font-weight:700;color:${c};background:${c}14;border-radius:6px;padding:2px 7px">${escHtml(k)} ${ot[k]}</span>`;
  }).join(' ');
  resultEl.innerHTML = `
    <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px">
      <div style="font-size:.82rem;font-weight:800;color:#0F172A;margin-bottom:6px">활성 탭 리뷰폴더 현황</div>
      <div style="font-size:.68rem;color:#9CA3AF;margin-bottom:8px">활성 ${res.totalTabs}개 중 '리뷰폼' ${res.excluded}개 제외 · 26.3+ 기준</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:.74rem">
        <div style="background:#EEF2FF;border-radius:6px;padding:8px"><b>① 리뷰폴더 연결</b><br><span style="font-size:.92rem;font-weight:800;color:#4338CA">${res.connected}개</span></div>
        <div style="background:#ECFDF5;border-radius:6px;padding:8px"><b>② 정상(파일 있음)</b><br><span style="font-size:.92rem;font-weight:800;color:#059669">${res.nonEmpty}개</span><br><span style="font-size:.64rem;color:#6B7280">26.3+ ${target.length} · 26.3이전 ${res.preMarch}</span></div>
        <div style="background:#FEF2F2;border-radius:6px;padding:8px"><b>③ 비어있음</b><br><span style="font-size:.92rem;font-weight:800;color:#DC2626">${res.empty}개</span></div>
        <div style="background:#FFFBEB;border-radius:6px;padding:8px"><b>폴더 미연결</b><br><span style="font-size:.92rem;font-weight:800;color:#B45309">${res.noFolder}개</span>${res.errors ? ` · 오류 ${res.errors}` : ''}</div>
      </div>
      ${ownerChips ? `<div style="margin-top:10px;background:#fff;border:1px solid #E2E8F0;border-radius:6px;padding:8px">
        <div style="font-size:.72rem;font-weight:700;color:#0F172A;margin-bottom:5px">연결 폴더 소유자 <span style="font-weight:400;color:#9CA3AF">(이관 범위 판정)</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">${ownerChips}</div>
        ${nonTnaks ? `<div style="font-size:.66rem;color:#DC2626;margin-top:6px">※ tnaks6325 외 소유 <b>${nonTnaks}개</b> = 소유권 이관 대상 (아래 목록에 빨간 배지 표시)</div>` : `<div style="font-size:.66rem;color:#059669;margin-top:6px">※ 모든 연결 폴더가 tnaks6325 소유 — 이관 불필요</div>`}
      </div>` : ''}
      ${empties.length ? `<div style="margin-top:10px"><div style="font-size:.74rem;font-weight:700;color:#DC2626">③ 비어있는 리뷰폴더 (${empties.length}) — 정리 필요</div><ul style="margin:4px 0 0;padding-left:18px;max-height:140px;overflow:auto">${li(empties)}</ul></div>` : ''}
      ${nofolder.length ? `<div style="margin-top:8px"><div style="font-size:.74rem;font-weight:700;color:#B45309">폴더 미연결 (${nofolder.length})</div><ul style="margin:4px 0 0;padding-left:18px;max-height:140px;overflow:auto">${li(nofolder)}</ul>
        <button id="rlcConnectBtn" onclick="_relocateConnectUnlinked()" style="margin-top:8px;width:100%;padding:8px;background:#B45309;color:#fff;border:none;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer"><i class="fas fa-link"></i> 미연결 탭 [리뷰] 폴더 생성·연결 (tnaks6325 소유)</button>
        <div style="font-size:.64rem;color:#9CA3AF;margin-top:3px">※ 비마감 탭 중 폴더가 없는 탭에 빈 [리뷰] 폴더를 만들어 연결합니다(이미 연결된 탭은 건너뜀). 흩어진 캡처가 있으면 생성 후 위 '리뷰 캡처 정리'로 모으세요.</div>
      </div>` : ''}
      ${pre.length ? `<details style="margin-top:8px"><summary style="font-size:.72rem;font-weight:700;color:#9CA3AF;cursor:pointer">26.3 이전 파일 포함(대상 제외) (${pre.length})</summary><ul style="margin:4px 0 0;padding-left:18px;max-height:160px;overflow:auto">${liH(pre)}</ul></details>` : ''}
      ${target.length ? `<details style="margin-top:8px" open><summary style="font-size:.74rem;font-weight:700;color:#059669;cursor:pointer">② 26.3+ 정상 폴더 (${target.length})</summary><ul style="margin:4px 0 0;padding-left:18px;max-height:220px;overflow:auto">${liH(target)}</ul></details>` : ''}
    </div>`;
}

// 미연결 활성 탭에 [리뷰] 폴더 생성·연결 (OAuth=tnaks6325 소유로 생성, 비파괴/idempotent)
//   sync-review: 비마감 탭 중 folder_url 없는 탭만 새 [리뷰] 폴더 생성 후 tab_configs 저장
async function _relocateConnectUnlinked() {
  if (!confirm('미연결 활성 탭에 빈 [리뷰] 폴더를 생성하고 연결합니다.\n· tnaks6325 소유로 생성 · 이미 연결된 탭은 건너뜀 · 파일 변경 없음\n\n진행할까요?')) return;
  const btnEl = document.getElementById('rlcConnectBtn');
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 생성·연결 중...'; }
  try {
    const res = await gasPost({ action: 'syncReviewFolders' }, 180000);
    if (!res || res.ok === false || res.error) {
      showToast('실패: ' + ((res && res.error) || '알수없음'), 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<i class="fas fa-link"></i> 미연결 탭 [리뷰] 폴더 생성·연결 (tnaks6325 소유)'; }
      return;
    }
    showToast(`[리뷰] 폴더 ${res.created || 0}개 신규 생성 · 연결 확인 ${res.synced || 0}${res.errors ? ` · 오류 ${res.errors}` : ''}`, 'success');
    _relocateFolderAudit(); // 현황 자동 재점검
  } catch (e) {
    showToast('오류: ' + e.message, 'error');
    if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = '<i class="fas fa-link"></i> 미연결 탭 [리뷰] 폴더 생성·연결 (tnaks6325 소유)'; }
  }
}

// 원본 폴더 비우기 — 원본 폴더의 모든 파일을 선택 탭의 [리뷰] 폴더로 이동
async function _relocateMoveFolder(apply) {
  const fromUrl = (document.getElementById('rlcMoveFrom').value || '').trim();
  const toUrl = (document.getElementById('rlcFolderUrl').value || '').trim();
  if (!fromUrl) { showToast('비울 원본 폴더 링크를 입력하세요.', 'error'); return; }
  if (!toUrl) { showToast('대상 [리뷰] 폴더 링크가 필요합니다 (탭을 선택하세요).', 'error'); return; }
  if (apply && !confirm('원본 폴더의 모든 파일을 [리뷰] 폴더로 이동합니다. 진행할까요?')) return;
  const resultEl = document.getElementById('rlcResult');
  resultEl.innerHTML = `<div style="font-size:.78rem;color:#6B7280"><i class="fas fa-spinner fa-spin"></i> ${apply ? '이동 중' : '조회 중'}...</div>`;
  try {
    const res = await gasPost({ action: 'moveFolderContents', fromFolderUrl: fromUrl, toFolderUrl: toUrl, dryRun: !apply });
    if (!res || res.ok === false) {
      resultEl.innerHTML = `<div style="font-size:.78rem;color:#DC2626">오류: ${escHtml((res && res.error) || '실패')}</div>`;
      return;
    }
    if (apply) {
      const failHtml = (res.failed || []).map(f => `<li style="font-size:.66rem;color:#DC2626;word-break:break-all">${escHtml(f.name)} — ${escHtml(f.error || '')}</li>`).join('');
      resultEl.innerHTML = `<div style="font-size:.84rem;color:#065F46;font-weight:700"><i class="fas fa-check-circle"></i> ${res.movedCount}건 이동 완료${res.failedCount ? ` · ${res.failedCount}건 실패` : ''}</div>
        ${res.failedCount ? `<ul style="margin:6px 0 0;padding-left:18px">${failHtml}</ul><div style="font-size:.66rem;color:#9CA3AF;margin-top:2px">실패 건은 보통 그 파일 소유자(예: 박세희) 권한이 필요합니다 — 소유자 측에서 옮기거나 사본 처리해야 합니다.</div>` : ''}`;
      showToast(`${res.movedCount}건 이동`, 'success');
      return;
    }
    const list = (res.files || []).slice(0, 50).map(c => `
      <div style="border-bottom:1px solid #E0F2FE">
        <div onclick="_relocateToggleImg(this,'${escHtml(c.id)}')" style="cursor:pointer;font-size:.7rem;color:#374151;font-family:monospace;word-break:break-all;padding:5px 2px;display:flex;align-items:flex-start;gap:6px" title="클릭하면 이미지 미리보기">
          <i class="fas fa-chevron-right" style="font-size:.6rem;color:#9CA3AF;margin-top:3px;transition:transform .15s"></i>
          <span style="flex:1">${escHtml(c.name)}</span>
        </div>
        <div class="rlc-img" style="display:none"></div>
      </div>`).join('');
    const sub = (res.subfolders || []).length ? `<div style="font-size:.66rem;color:#D97706;margin-top:4px">※ 서브폴더 ${res.subfolders.length}개는 이동 대상에서 제외됩니다.</div>` : '';
    resultEl.innerHTML = `
      <div style="background:#ECFEFF;border:1px solid #A5F3FC;border-radius:8px;padding:12px">
        <div style="font-size:.84rem;font-weight:700;color:#155E75">원본 폴더 파일: ${res.total}건 → [리뷰]로 이동 예정</div>
        ${sub}
        ${res.total
          ? `<div style="margin:8px 0 0">${list}</div>
             <div style="font-size:.64rem;color:#9CA3AF;margin-top:4px">※ 파일명을 누르면 이미지를 펼쳐 볼 수 있습니다.</div>
             <button onclick="_relocateMoveFolder(true)" style="margin-top:12px;width:100%;padding:9px;background:#0891B2;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer"><i class="fas fa-arrow-right-to-bracket"></i> ${res.total}건 전체 이동 실행</button>`
          : `<div style="font-size:.72rem;color:#6B7280;margin-top:6px">원본 폴더에 이동할 파일이 없습니다.</div>`}
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<div style="font-size:.78rem;color:#DC2626">오류: ${escHtml(err.message)}</div>`;
  }
}

function openReviewRelocate() {
  const existing = document.getElementById('reviewRelocateModal');
  if (existing) existing.remove();

  _relocateTabs = _relocateCollectTabs();
  _relocateSelIdx = -1;
  if (_relocateTabs.length === 0) {
    showToast('탭 목록을 불러오지 못했습니다. 탭 관리 대시보드를 먼저 여세요.', 'info');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'reviewRelocateModal';
  modal.classList.add('toss-overlay');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.2)">
      <div style="padding:16px 20px;border-bottom:1px solid #E5E7EB;flex-shrink:0">
        <h3 style="margin:0;font-size:1rem;font-weight:700;color:#111"><i class="fas fa-folder-tree" style="color:#7C3AED"></i> 리뷰 캡처 정리</h3>
        <div style="font-size:.72rem;color:#6B7280;margin-top:4px">내 드라이브 루트 등에 흩어진 리뷰 캡처를 선택한 탭의 <b>[리뷰]</b> 폴더로 이동합니다.</div>
      </div>
      <div style="padding:14px 20px;overflow-y:auto;flex:1">
        <label style="font-size:.74rem;font-weight:600;color:#374151">대상 탭 <span style="color:#9CA3AF;font-weight:400">(검색해서 선택)</span></label>
        <div style="position:relative;margin:4px 0 12px">
          <input id="rlcTabSearch" type="text" autocomplete="off" placeholder="탭·상품·캠페인 검색…"
            oninput="_relocateFilterTabs()" onfocus="_relocateFilterTabs()"
            onblur="setTimeout(function(){var l=document.getElementById('rlcTabList');if(l)l.style.display='none'},150)"
            style="width:100%;padding:7px 9px;border:1px solid #D1D5DB;border-radius:8px;font-size:.8rem">
          <div id="rlcTabList" style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:2px;background:#fff;border:1px solid #E5E7EB;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:240px;overflow-y:auto;z-index:5"></div>
          <div id="rlcTabSelected" style="font-size:.7rem;color:#6B7280;margin-top:4px"></div>
        </div>

        <label style="font-size:.74rem;font-weight:600;color:#374151">[리뷰] 폴더 링크 <span style="color:#9CA3AF;font-weight:400">(비어 있으면 대상 [리뷰] 폴더 링크를 붙여넣으세요)</span></label>
        <input id="rlcFolderUrl" type="text" placeholder="https://drive.google.com/drive/folders/..." style="width:100%;padding:7px 9px;border:1px solid #D1D5DB;border-radius:8px;font-size:.72rem;margin:4px 0 12px;font-family:monospace">

        <label style="font-size:.74rem;font-weight:600;color:#374151">브랜드/상품 키워드 <span style="color:#9CA3AF;font-weight:400">(쉼표 구분 — 캡처에 보이는 단어)</span></label>
        <input id="rlcKeywords" type="text" placeholder="예: 서일농원, 콩물" style="width:100%;padding:7px 9px;border:1px solid #D1D5DB;border-radius:8px;font-size:.8rem;margin:4px 0 12px">

        <label style="font-size:.74rem;font-weight:600;color:#374151">시작일 <span style="color:#9CA3AF;font-weight:400">(이 날짜 이후 업로드만 — 비우면 전체)</span></label>
        <input id="rlcSince" type="date" style="width:100%;padding:7px 9px;border:1px solid #D1D5DB;border-radius:8px;font-size:.8rem;margin:4px 0 4px">

        <details style="margin-top:10px;border:1px dashed #CBD5E1;border-radius:8px;padding:8px 10px">
          <summary style="cursor:pointer;font-size:.74rem;font-weight:700;color:#155E75">원본 폴더 비우기 (레거시/잘못된 폴더 → 위 [리뷰]로 전체 이동)</summary>
          <div style="margin-top:8px">
            <input id="rlcMoveFrom" type="text" placeholder="비울 원본 폴더 링크 (예: 박세희 소유 폴더)" style="width:100%;padding:7px 9px;border:1px solid #D1D5DB;border-radius:8px;font-size:.72rem;font-family:monospace">
            <div style="font-size:.64rem;color:#9CA3AF;margin:5px 0">위 <b>[리뷰] 폴더 링크</b>가 이동 대상입니다(탭 선택 필요). 파일명 무관 <b>전체 이동</b>, 서브폴더는 제외.</div>
            <button onclick="_relocateMoveFolder(false)" style="width:100%;padding:8px;background:#0891B2;color:#fff;border:none;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer"><i class="fas fa-folder-open"></i> 원본 폴더 미리보기</button>
          </div>
        </details>

        <div style="display:flex;gap:8px;margin-top:14px">
          <button onclick="_relocateRun(false)" style="flex:1;padding:9px;background:#7C3AED;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer"><i class="fas fa-search"></i> 선택 탭 미리보기</button>
          <button onclick="_relocateScanAll()" style="flex:1;padding:9px;background:#4338CA;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer"><i class="fas fa-layer-group"></i> 전체 탭 자동 스캔</button>
        </div>
        <button onclick="_relocateFolderAudit()" style="width:100%;margin-top:8px;padding:9px;background:#0F172A;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer"><i class="fas fa-clipboard-list"></i> 리뷰폴더 현황 점검 (활성 탭 전체)</button>
        <div style="font-size:.66rem;color:#9CA3AF;margin-top:6px">※ 전체 스캔은 모든 탭을 하나씩 조회해 탭별 대상 건수를 보여줍니다. 폴더 링크·키워드 칸은 무시하고 탭마다 자동 적용합니다.</div>

        <div style="margin-top:14px;border-top:1px dashed #E5E7EB;padding-top:14px">
          <div style="font-size:.82rem;font-weight:800;color:#0F172A"><i class="fas fa-paper-plane" style="color:#0891B2"></i> 업체 보고 링크 <span style="font-weight:600;color:#9CA3AF;font-size:.7rem">(직원 복제 불필요)</span></div>
          <div style="font-size:.68rem;color:#6B7280;margin:4px 0 8px">위에서 <b>탭을 선택</b>한 뒤 링크를 만들어 업체에 전달하세요. 업체는 <b>로그인 없이</b> 열람하고, 원본은 그대로(내 소유)라 <b>직원 드라이브에 복제되지 않습니다</b>.</div>
          <button onclick="_relocateMakeReportPageLink()" style="width:100%;padding:9px;background:#0891B2;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer"><i class="fas fa-link"></i> 선택 탭 보고 링크 만들기 (이미지 모아보기)</button>
          <div id="rlcReportResult" style="margin-top:10px"></div>
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:.7rem;color:#6B7280">또는 Drive 폴더 공유링크로 전달 (폴더 그대로)</summary>
            <div style="margin-top:6px">
              <button onclick="_relocateMakeReportLink()" style="width:100%;padding:8px;background:#fff;color:#0891B2;border:1px solid #0891B2;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer"><i class="fas fa-folder-open"></i> 선택 탭 [리뷰] 폴더 공유링크 만들기</button>
              <div id="rlcFolderShareResult" style="margin-top:8px"></div>
            </div>
          </details>
        </div>

        <div style="margin-top:8px;text-align:right">
          <button onclick="document.getElementById('reviewRelocateModal').remove()" style="padding:7px 16px;background:#F3F4F6;color:#374151;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer">닫기</button>
        </div>
        <div id="rlcResult" style="margin-top:14px"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const sb = document.getElementById('rlcTabSearch');
  if (sb) sb.focus();

  // 임시저장된 전체 스캔 결과가 있으면 자동 복원
  _relocateScanStop = false;
  _relocateScanResults = _relocateLoadScan().byTab || {};
  if (Object.keys(_relocateScanResults).length) _relocateRenderScan();
}

// 검색어로 탭 목록 필터링 → 자동완성 리스트 렌더
function _relocateFilterTabs() {
  const inp = document.getElementById('rlcTabSearch');
  const listEl = document.getElementById('rlcTabList');
  if (!inp || !listEl) return;
  const q = (inp.value || '').trim().toLowerCase();
  const matches = [];
  for (let i = 0; i < _relocateTabs.length && matches.length < 50; i++) {
    const t = _relocateTabs[i];
    const hay = `${t.displayName} ${t.campName} ${t.tabName}`.toLowerCase();
    if (!q || hay.includes(q)) matches.push(i);
  }
  if (matches.length === 0) {
    listEl.innerHTML = `<div style="padding:10px 12px;font-size:.74rem;color:#9CA3AF">검색 결과 없음</div>`;
    listEl.style.display = 'block';
    return;
  }
  listEl.innerHTML = matches.map(i => {
    const t = _relocateTabs[i];
    return `<div onmousedown="_relocateSelectTab(${i})" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #F3F4F6"
        onmouseover="this.style.background='#F5F3FF'" onmouseout="this.style.background='#fff'">
        <div style="font-size:.78rem;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.displayName)}</div>
        ${t.campName ? `<div style="font-size:.66rem;color:#9CA3AF">${escHtml(t.campName)}</div>` : ''}
      </div>`;
  }).join('');
  listEl.style.display = 'block';
}

// 자동완성 항목 선택 → 폴더링크·키워드 자동 채움
function _relocateSelectTab(i) {
  const t = _relocateTabs[i];
  if (!t) return;
  _relocateSelIdx = i;
  const sb = document.getElementById('rlcTabSearch');
  if (sb) sb.value = t.displayName;
  const listEl = document.getElementById('rlcTabList');
  if (listEl) listEl.style.display = 'none';
  const selEl = document.getElementById('rlcTabSelected');
  if (selEl) selEl.innerHTML = `선택됨: <b>${escHtml(t.displayName)}</b>${t.campName ? ' — ' + escHtml(t.campName) : ''}`;
  document.getElementById('rlcFolderUrl').value = t.folderUrl || '';
  document.getElementById('rlcKeywords').value = _relocateDeriveKeywords(t.tabName).join(', ');
  document.getElementById('rlcResult').innerHTML = '';
}

// [주] 공개 보고 페이지 링크 만들기 — 선택 탭의 추측불가 코드를 발급하고
//   report.html 공개 페이지 링크를 반환. 업체는 로그인 없이 이미지 모아보기로 열람.
//   이미지는 서버 프록시로 표시 → 폴더 공개공유 불필요, 원본 복제 0.
async function _relocateMakeReportPageLink() {
  const t = _relocateTabs[_relocateSelIdx];
  if (!t) { showToast('먼저 위에서 대상 탭을 선택하세요.', 'error'); return; }
  const out = document.getElementById('rlcReportResult');
  if (out) out.innerHTML = `<div style="font-size:.76rem;color:#0E7490"><i class="fas fa-spinner fa-spin"></i> 보고 링크 생성 중…</div>`;
  try {
    const res = await gasPost({ action: 'reviewReportLink', sheetId: t.sheetId, tabName: t.tabName, displayName: t.displayName }, 60000);
    if (!res || res.ok === false || res.error || !res.reportUrl) {
      if (out) out.innerHTML = `<div style="font-size:.76rem;color:#DC2626">오류: ${escHtml((res && res.error) || '실패')}</div>`;
      return;
    }
    const link = res.reportUrl;
    if (out) out.innerHTML = `
      <div style="background:#ECFEFF;border:1px solid #A5F3FC;border-radius:8px;padding:10px">
        <div style="font-size:.74rem;font-weight:700;color:#155E75;margin-bottom:6px"><i class="fas fa-check-circle"></i> 업체 보고 링크 준비됨 <span style="font-weight:500;color:#0E7490">(이미지 모아보기 페이지)</span></div>
        <div style="display:flex;gap:6px;align-items:stretch">
          <input id="rlcReportPageLink" type="text" readonly value="${escHtml(link)}" onclick="this.select()" style="flex:1;padding:7px 9px;border:1px solid #A5F3FC;border-radius:8px;font-size:.7rem;font-family:monospace;background:#fff">
          <button onclick="_relocateCopyLink('rlcReportPageLink')" style="padding:7px 12px;background:#0891B2;color:#fff;border:none;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer;white-space:nowrap"><i class="fas fa-copy"></i> 복사</button>
          <a href="${escHtml(link)}" target="_blank" rel="noopener" title="미리보기" style="padding:7px 11px;background:#fff;color:#0891B2;border:1px solid #0891B2;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer;white-space:nowrap;text-decoration:none;display:flex;align-items:center"><i class="fas fa-arrow-up-right-from-square"></i></a>
        </div>
        <div style="font-size:.64rem;color:#0E7490;margin-top:6px">이 링크를 업체에 전달하세요. 업체는 <b>로그인 없이</b> 리뷰 이미지를 모아볼 수 있고, 원본은 그대로라 <b>직원 드라이브 용량을 쓰지 않습니다</b>.</div>
        <div style="font-size:.6rem;color:#9CA3AF;margin-top:3px">※ 링크를 아는 사람은 열람할 수 있습니다(추측불가 코드). 리뷰어 이름이 함께 표시됩니다.</div>
      </div>`;
    showToast('업체 보고 링크 준비됨', 'success');
  } catch (e) {
    if (out) out.innerHTML = `<div style="font-size:.76rem;color:#DC2626">오류: ${escHtml(e.message)}</div>`;
  }
}

// [보조] Drive 폴더 공유링크 만들기 — 선택 탭의 [리뷰] 폴더를 '링크공유(anyone reader)'로
//   설정하고 폴더 링크를 반환(폴더 그대로 전달). 원본은 tnaks 소유 그대로 → 복제 불필요.
async function _relocateMakeReportLink() {
  const t = _relocateTabs[_relocateSelIdx];
  if (!t) { showToast('먼저 위에서 대상 탭을 선택하세요.', 'error'); return; }
  const folderUrl = (document.getElementById('rlcFolderUrl').value || '').trim();
  const out = document.getElementById('rlcFolderShareResult');
  if (out) out.innerHTML = `<div style="font-size:.76rem;color:#0E7490"><i class="fas fa-spinner fa-spin"></i> 폴더 공유링크 생성 중…</div>`;
  try {
    const res = await gasPost({ action: 'shareReviewFolder', sheetId: t.sheetId, tabName: t.tabName, folderUrl }, 60000);
    if (!res || res.ok === false || res.error) {
      if (out) out.innerHTML = `<div style="font-size:.76rem;color:#DC2626">오류: ${escHtml((res && res.error) || '실패')}</div>`;
      return;
    }
    const link = res.folderUrl;
    document.getElementById('rlcFolderUrl').value = link; // 폴더 링크 칸 동기화
    const cntTxt = (res.fileCount != null) ? `${res.fileCount}개 파일` : '파일 수 확인 안 됨';
    const note = res.created
      ? ' · 빈 [리뷰] 폴더를 새로 만들어 연결했습니다(아직 제출 0건)'
      : (res.alreadyShared ? ' · 이미 공유돼 있던 폴더' : '');
    if (out) out.innerHTML = `
      <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-radius:8px;padding:10px">
        <div style="font-size:.74rem;font-weight:700;color:#155E75;margin-bottom:6px"><i class="fas fa-check-circle"></i> Drive 폴더 공유링크 준비됨 <span style="font-weight:500;color:#0E7490">(${cntTxt})</span></div>
        <div style="display:flex;gap:6px;align-items:stretch">
          <input id="rlcFolderShareLink" type="text" readonly value="${escHtml(link)}" onclick="this.select()" style="flex:1;padding:7px 9px;border:1px solid #CBD5E1;border-radius:8px;font-size:.7rem;font-family:monospace;background:#fff">
          <button onclick="_relocateCopyLink('rlcFolderShareLink')" style="padding:7px 12px;background:#0891B2;color:#fff;border:none;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer;white-space:nowrap"><i class="fas fa-copy"></i> 복사</button>
          <a href="${escHtml(link)}" target="_blank" rel="noopener" title="새 창에서 열기" style="padding:7px 11px;background:#fff;color:#0891B2;border:1px solid #0891B2;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer;white-space:nowrap;text-decoration:none;display:flex;align-items:center"><i class="fas fa-arrow-up-right-from-square"></i></a>
        </div>
        <div style="font-size:.64rem;color:#0E7490;margin-top:6px">폴더를 그대로 전달합니다. 업체는 로그인 없이 열람·다운로드, 직원 복제 불필요.${note}</div>
        <div style="font-size:.6rem;color:#9CA3AF;margin-top:3px">※ 파일명에 리뷰어 이름이 보입니다. 공유 해제는 구글 드라이브에서 폴더 '공유 → 링크 보기 제한'으로 가능합니다.</div>
      </div>`;
    showToast(res.created ? '빈 [리뷰] 폴더 생성·공유링크 준비' : 'Drive 폴더 공유링크 준비됨', 'success');
  } catch (e) {
    if (out) out.innerHTML = `<div style="font-size:.76rem;color:#DC2626">오류: ${escHtml(e.message)}</div>`;
  }
}

// 보고 링크 클립보드 복사 (입력칸 id 지정)
function _relocateCopyLink(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const v = el.value || '';
  const done = () => showToast('보고 링크를 복사했습니다.', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(v).then(done).catch(() => { el.select(); document.execCommand('copy'); done(); });
  } else {
    el.select(); document.execCommand('copy'); done();
  }
}

async function _relocateRun(apply) {
  const t = _relocateTabs[_relocateSelIdx];
  if (!t) { showToast('대상 탭을 검색해서 선택하세요.', 'error'); return; }
  const reviewFolderUrl = (document.getElementById('rlcFolderUrl').value || '').trim();
  const brandKeywords = (document.getElementById('rlcKeywords').value || '').split(',').map(s => s.trim()).filter(Boolean);
  const sinceRaw = (document.getElementById('rlcSince').value || '').trim();
  const sinceDate = sinceRaw ? (sinceRaw + 'T00:00:00Z') : undefined;

  if (!reviewFolderUrl) { showToast('[리뷰] 폴더 링크가 필요합니다.', 'error'); return; }
  if (brandKeywords.length === 0) { showToast('브랜드/상품 키워드를 1개 이상 입력하세요.', 'error'); return; }
  if (apply && !confirm(`선택한 캡처들을 [리뷰] 폴더로 이동합니다. 진행할까요?`)) return;

  const resultEl = document.getElementById('rlcResult');
  resultEl.innerHTML = `<div style="font-size:.78rem;color:#6B7280"><i class="fas fa-spinner fa-spin"></i> ${apply ? '이동 중' : '검색 중'}...</div>`;

  try {
    const res = await gasPost({
      action: 'relocateOrphanReviews',
      sheetId: t.sheetId, tabName: t.tabName,
      reviewFolderUrl, brandKeywords, sinceDate,
      dryRun: !apply,
    });
    if (!res || res.ok === false) {
      resultEl.innerHTML = `<div style="font-size:.78rem;color:#DC2626">오류: ${escHtml((res && res.error) || '실패')}</div>`;
      return;
    }
    // 인덱스 결정적 링크(B) 요약 — 모든 결과에 공통 표기
    const lk = res.link || {};
    const linkLine = (lk.linked || lk.ambiguous || lk.unmatched || lk.already)
      ? `<div style="font-size:.72rem;color:#4338CA;margin-top:6px"><i class="fas fa-link"></i> 인덱스 링크: 연결 ${lk.linked || 0}${lk.already ? ` · 기존 ${lk.already}` : ''}${lk.ambiguous ? ` · 모호 ${lk.ambiguous}` : ''}${lk.unmatched ? ` · 명단없음 ${lk.unmatched}` : ''}</div>`
      : '';

    // 진단: 서버 검색이 실제로 몇 건을 반환했는지 (0이면 계정/스코프/가시성 문제)
    const dg = res.diag || {};
    const ss = (dg.searchStats || []).map(s => `${escHtml(s.kw)}[SA:${s.sa == null ? '-' : s.sa}/OAuth:${s.oauth == null ? '-' : s.oauth}${s.oauthError ? '⚠' : ''}]`).join(' ');
    const errMsg = (dg.searchStats || []).map(s => s.oauthError || s.saError).find(Boolean);
    const errLine = errMsg ? `<div style="font-size:.66rem;color:#DC2626;margin-top:3px;font-family:monospace;word-break:break-all">⚠ ${escHtml(String(errMsg).slice(0, 300))}</div>` : '';
    const diagLine = `<div style="font-size:.68rem;color:#9CA3AF;margin-top:6px;font-family:monospace">🔎 서버검색 ${dg.searchFound ?? '-'}건(리뷰형식 ${dg.reviewFormatCount ?? '-'}) ${ss}</div>${errLine}`;

    if (apply) {
      resultEl.innerHTML = `<div style="font-size:.84rem;color:#065F46;font-weight:700"><i class="fas fa-check-circle"></i> ${res.movedCount}건 이동 완료${res.failedCount ? ` · ${res.failedCount}건 실패` : ''}</div>
        ${linkLine}${diagLine}
        <div style="font-size:.72rem;color:#6B7280;margin-top:4px">[리뷰] 폴더를 새로고침해 확인하세요. (이미 폴더에 있던 파일은 건너뜀)</div>`;
      showToast(`${res.movedCount}건 이동${lk.linked ? ` · 인덱스 ${lk.linked}건 연결` : ''}`, 'success');
      return;
    }
    // 후보 목록 — 파일명 클릭 시 모달 내에서 이미지 인라인 펼침(아코디언)
    const showN = 50;
    const list = (res.candidates || []).slice(0, showN).map(c => `
      <div style="border-bottom:1px solid #ECECF5">
        <div onclick="_relocateToggleImg(this,'${escHtml(c.id)}')" style="cursor:pointer;font-size:.7rem;color:#374151;font-family:monospace;word-break:break-all;padding:5px 2px;display:flex;align-items:flex-start;gap:6px" title="클릭하면 이미지 미리보기">
          <i class="fas fa-chevron-right" style="font-size:.6rem;color:#9CA3AF;margin-top:3px;transition:transform .15s"></i>
          <span style="flex:1">${escHtml(c.name)}</span>
        </div>
        <div class="rlc-img" style="display:none"></div>
      </div>`).join('');
    const more = res.candidateCount > showN ? `<div style="font-size:.7rem;color:#9CA3AF;margin-top:4px">… 외 ${res.candidateCount - showN}건</div>` : '';
    const inTargetLine = res.alreadyInTarget ? `<div style="font-size:.7rem;color:#6B7280;margin-top:4px">이미 [리뷰] 폴더에 있는 ${res.alreadyInTarget}건도 인덱스 링크 대상에 포함됩니다.</div>` : '';
    resultEl.innerHTML = `
      <div style="background:#F5F3FF;border:1px solid #DDD6FE;border-radius:8px;padding:12px">
        <div style="font-size:.84rem;font-weight:700;color:#5B21B6">이동 대상: ${res.candidateCount}건</div>
        ${linkLine}${inTargetLine}${diagLine}
        ${(res.candidateCount || res.alreadyInTarget)
          ? `<div style="margin:8px 0 0">${list}</div>${more}
             <div style="font-size:.64rem;color:#9CA3AF;margin-top:4px">※ 파일명을 누르면 이 화면에서 바로 이미지를 펼쳐 볼 수 있습니다.</div>
             <button onclick="_relocateRun(true)" style="margin-top:12px;width:100%;padding:9px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:700;cursor:pointer"><i class="fas fa-arrow-right-to-bracket"></i> 실행 (이동 ${res.candidateCount}건 + 인덱스 링크)</button>`
          : `<div style="font-size:.72rem;color:#6B7280;margin-top:6px">대상이 없습니다. 키워드/시작일을 조정해 보세요. (OCR 색인이 안 된 캡처는 검색에 안 걸릴 수 있습니다.)</div>`}
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<div style="font-size:.78rem;color:#DC2626">오류: ${escHtml(err.message)}</div>`;
  }
}

// ── 전체 탭 스캔: 임시저장(localStorage) ──
function _relocateTabKey(t) { return (t.sheetId || '') + '||' + (t.tabName || ''); }
function _relocateLoadScan() {
  try { const o = JSON.parse(localStorage.getItem('rlcScanResults_v1') || '{}'); return (o && o.byTab) ? o : { ts: 0, byTab: {} }; }
  catch (_) { return { ts: 0, byTab: {} }; }
}
function _relocateSaveScan() {
  try { localStorage.setItem('rlcScanResults_v1', JSON.stringify({ ts: Date.now(), byTab: _relocateScanResults })); } catch (_) {}
}

// 결과 1건 → 상태/액션 셀 HTML
function _relocateScanRowInner(i, t, r) {
  if (!t.folderUrl) return { status: `<span style="color:#D97706">폴더 미설정</span>`, action: '' };
  if (!r) return { status: `<span style="color:#9CA3AF">대기</span>`, action: '' };
  if (r.status === 'scanning') return { status: `<i class="fas fa-spinner fa-spin"></i> 스캔중`, action: '' };
  if (r.status === 'error') return { status: `<span style="color:#DC2626" title="${escHtml(r.error || '')}">오류</span>`, action: '' };
  if (r.status === 'moved') return { status: `<span style="color:#065F46;font-weight:700">✅ ${r.movedCount}건 이동</span>${r.linked ? ` <span style="color:#4338CA">링크 ${r.linked}</span>` : ''}`, action: '' };
  const n = r.candidateCount || 0;
  if (n === 0) return { status: `<span style="color:#9CA3AF">대상 0</span>`, action: '' };
  if (r.over) return {
    status: `<span style="color:#DC2626;font-weight:700" title="작업건수(${r.expected || '?'})보다 대상이 많음 — 단일 탭 모드에서 정확한 키워드로 확인하세요">⚠ 과다 ${n}/${r.expected || '?'}</span>`,
    action: `<button onclick="_relocateSelectTab(${i});showToast('단일 탭 모드에서 정확한 키워드로 확인 후 이동하세요','info')" style="font-size:.68rem;background:#FEF3C7;color:#92400E;border:none;border-radius:6px;padding:4px 9px;cursor:pointer">검토</button>`,
  };
  return {
    status: `<b style="color:#5B21B6">대상 ${n}건</b>${r.expected ? `<span style="color:#9CA3AF">/${r.expected}</span>` : ''}${r.ambiguous ? ` <span style="color:#9CA3AF">모호 ${r.ambiguous}</span>` : ''}`,
    action: `<button id="rlcScanBtn_${i}" onclick="_relocateApplyTab(${i})" style="font-size:.72rem;background:#059669;color:#fff;border:none;border-radius:6px;padding:4px 11px;cursor:pointer">이동</button>`,
  };
}

function _relocateUpdateRow(i) {
  const t = _relocateTabs[i];
  const inner = _relocateScanRowInner(i, t, _relocateScanResults[_relocateTabKey(t)]);
  const s = document.getElementById('rlcScanStatus_' + i);
  const a = document.getElementById('rlcScanAction_' + i);
  if (s) s.innerHTML = inner.status;
  if (a) a.innerHTML = inner.action;
}

// 저장된(또는 현재) 결과로 전체 목록 렌더
function _relocateRenderScan() {
  const resultEl = document.getElementById('rlcResult');
  if (!resultEl) return;
  const rows = _relocateTabs.map((t, i) => {
    const inner = _relocateScanRowInner(i, t, _relocateScanResults[_relocateTabKey(t)]);
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #F3F4F6">
      <div style="flex:1;min-width:0">
        <div style="font-size:.74rem;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.displayName)}</div>
        ${t.campName ? `<div style="font-size:.62rem;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.campName)}</div>` : ''}
      </div>
      <div id="rlcScanStatus_${i}" style="font-size:.7rem;white-space:nowrap">${inner.status}</div>
      <div id="rlcScanAction_${i}" style="min-width:54px;text-align:right">${inner.action}</div>
    </div>`;
  }).join('');
  const saved = _relocateLoadScan();
  const tsTxt = saved.ts ? new Date(saved.ts).toLocaleString() : '';
  resultEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px">
      <div id="rlcScanProgress" style="font-size:.72rem;font-weight:700;color:#3730A3;min-width:0;overflow:hidden;text-overflow:ellipsis">${tsTxt ? '임시저장 ' + escHtml(tsTxt) : '스캔 준비됨'}</div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button onclick="_relocateScanAll()" style="font-size:.7rem;background:#4338CA;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer">다시 스캔</button>
        <button onclick="_relocateScanStop=true" style="font-size:.7rem;background:#FEE2E2;color:#991B1B;border:none;border-radius:6px;padding:4px 10px;cursor:pointer">중지</button>
      </div>
    </div>
    <div style="max-height:360px;overflow-y:auto;border:1px solid #E5E7EB;border-radius:8px">${rows}</div>`;
}

// 전체 탭 자동 스캔 — 모든 탭 순차 dryRun. requireRoster로 참여자 명단 제약 + 과대매칭 차단.
async function _relocateScanAll() {
  _relocateScanStop = false;
  const sinceRaw = (document.getElementById('rlcSince').value || '').trim();
  const sinceDate = sinceRaw ? (sinceRaw + 'T00:00:00Z') : undefined;
  _relocateRenderScan();
  const setProg = (txt) => { const p = document.getElementById('rlcScanProgress'); if (p) p.textContent = txt; };

  let scanned = 0, withTargets = 0;
  for (let i = 0; i < _relocateTabs.length; i++) {
    if (_relocateScanStop) { setProg(`중지됨 (${scanned}/${_relocateTabs.length})`); _relocateSaveScan(); return; }
    const t = _relocateTabs[i];
    const key = _relocateTabKey(t);
    if (_relocateScanResults[key] && _relocateScanResults[key].status === 'moved') { scanned++; continue; } // 이미 이동 → 건너뜀

    if (!t.folderUrl) { _relocateScanResults[key] = { displayName: t.displayName, status: 'nofolder' }; _relocateUpdateRow(i); scanned++; continue; }
    _relocateScanResults[key] = { displayName: t.displayName, status: 'scanning' }; _relocateUpdateRow(i);
    try {
      const res = await gasPost({
        action: 'relocateOrphanReviews',
        sheetId: t.sheetId, tabName: t.tabName,
        reviewFolderUrl: t.folderUrl,
        brandKeywords: _relocateDeriveKeywords(t.tabName),
        requireRoster: true, sinceDate, dryRun: true,
      });
      if (!res || res.ok === false) {
        _relocateScanResults[key] = { displayName: t.displayName, status: 'error', error: (res && res.error) || '' };
      } else {
        const n = res.candidateCount || 0;
        const expected = (res.indexRowCount && res.indexRowCount > 0) ? res.indexRowCount : _relocateParseCount(t.tabName);
        const over = expected > 0 ? (n > expected * 2 + 5) : (n > 50);
        if (n > 0) withTargets++;
        _relocateScanResults[key] = { displayName: t.displayName, status: 'ok', candidateCount: n, expected, over, ambiguous: (res.link && res.link.ambiguous) || 0 };
      }
    } catch (e) {
      _relocateScanResults[key] = { displayName: t.displayName, status: 'error', error: e.message };
    }
    _relocateUpdateRow(i);
    scanned++;
    setProg(`스캔 ${scanned}/${_relocateTabs.length} · 대상 있는 탭 ${withTargets}`);
    _relocateSaveScan();
  }
  setProg(`스캔 완료 ${scanned}/${_relocateTabs.length} · 대상 있는 탭 ${withTargets}`);
  _relocateSaveScan();
}

// 스캔 목록에서 한 탭만 실제 이동(apply) — 과대매칭(over)은 차단
async function _relocateApplyTab(i) {
  const t = _relocateTabs[i];
  if (!t || !t.folderUrl) return;
  const key = _relocateTabKey(t);
  const prev = _relocateScanResults[key];
  if (prev && prev.over) { showToast('과대매칭 의심 — 단일 탭 모드에서 정확한 키워드로 확인 후 이동하세요', 'error'); return; }
  const btn = document.getElementById('rlcScanBtn_' + i);
  if (btn) { btn.disabled = true; btn.textContent = '이동중'; }
  const sinceRaw = (document.getElementById('rlcSince').value || '').trim();
  const sinceDate = sinceRaw ? (sinceRaw + 'T00:00:00Z') : undefined;
  try {
    const res = await gasPost({
      action: 'relocateOrphanReviews',
      sheetId: t.sheetId, tabName: t.tabName,
      reviewFolderUrl: t.folderUrl,
      brandKeywords: _relocateDeriveKeywords(t.tabName),
      requireRoster: true, sinceDate, dryRun: false,
    });
    if (!res || res.ok === false) {
      _relocateScanResults[key] = Object.assign({}, prev, { status: 'error', error: (res && res.error) || '' });
      _relocateUpdateRow(i); _relocateSaveScan(); return;
    }
    const lk = res.link || {};
    _relocateScanResults[key] = { displayName: t.displayName, status: 'moved', movedCount: res.movedCount, linked: lk.linked || 0 };
    _relocateUpdateRow(i); _relocateSaveScan();
    showToast(`${t.displayName}: ${res.movedCount}건 이동`, 'success');
  } catch (e) {
    _relocateScanResults[key] = Object.assign({}, prev, { status: 'error', error: e.message });
    _relocateUpdateRow(i); _relocateSaveScan();
  }
}
