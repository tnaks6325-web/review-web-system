/* ══════════════════════════════════════════
   app.js v4 [인라인]
══════════════════════════════════════════ */

/* ══════════════════════════════════════════
   ★ 시스템 변경 공지사항 (배포 시 자동 표시)
   — 새로운 배포 시 이 배열 맨 위에 추가하세요
   — 최신 공지가 위에, 오래된 공지가 아래로 누적 관리됩니다
   — 오류 발생 시 어떤 버전으로 되돌릴 수 있을지 힌트 역할
══════════════════════════════════════════ */
const SYSTEM_NOTICES = [
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
    title: "완료감지 아카이브 재표시 방지 + 숨김탭 토글",
    changes: [
      { type: "fix", text: "아카이브 후에도 완료감지에 계속 표시되던 문제 해결 (트리아이나 등)" },
      { type: "feat", text: "완료감지 목록에서 각 탭마다 숨김/숨김해제 버튼 제공" },
      { type: "fix", text: "스마트빌드가 아카이브된 차수의 행을 재삽입하지 않도록 개선" },
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
  const typeColors = { feat: "#059669", fix: "#DC2626", perf: "#D97706", warn: "#9333EA" };

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
      ? `<span style="display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:10px;background:#EEF2FF;color:#4338CA;border:1px solid #C7D2FE;margin-left:4px;vertical-align:middle">${escHtml(item.round)}</span>`
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

/* ── GAS URL 설정 모달 (비밀번호 인증 → 서버 검증) ── */

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
async function verifyGasUrlPw() {
  const pw    = document.getElementById("gasUrlPwInput").value;
  const errEl = document.getElementById("gasUrlPwError");
  hide(errEl);
  if (!pw) {
    errEl.textContent = "비밀번호를 입력하세요.";
    show(errEl);
    return;
  }
  // 서버에서 비밀번호 검증 (하드코딩 제거)
  try {
    const res = await gasPost({ action: 'adminLoginV2', name: getAdminName() || '설정', pw });
    if (!res.success) {
      errEl.textContent = "비밀번호가 틀렸습니다.";
      show(errEl);
      document.getElementById("gasUrlPwInput").value = "";
      document.getElementById("gasUrlPwInput").focus();
      return;
    }
  } catch (e) {
    errEl.textContent = "서버 연결 실패: " + e.message;
    show(errEl);
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

/** 서버에 앱 URL 저장 (백그라운드, 비동기) */
async function _saveAppUrlToGas(url) {
  try {
    const res = await gasPost({ action: 'saveAppUrl', url });
    if (res && res.ok) console.log("[API] URL 저장 완료");
    else console.warn("[API] URL 저장 실패:", res?.error);
  } catch (e) {
    console.warn("[API] URL 저장 오류 (무시):", e.message);
  }
}

/* ── 관리자 로그인 모달 열기 ── */
function openAdminLogin() {
  if (isAdminLoggedIn()) { enterAdminScreen(); return; }
  if (!APP_CONFIG.GAS_WEB_APP_URL) {
    openGasUrlModal();
    showToast("먼저 GAS URL을 설정해주세요.", "warning");
    return;
  }
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

  showScreen("screenAdmin");

  // ★ 컨텍스트 툴바 초기화
  _updateContextToolbar('dashboard');

  loadAdminDashboard();

  // ★ 공지사항 자동 표시 (배포 변경 이력)
  checkAndShowNotice();

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
}
function exitAdmin() {
  clearAdminSession();
  if (typeof disconnectSSE === 'function') disconnectSSE();
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
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:#EEF2FF;color:var(--p)">
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
    btnStaff.style.color        = !isAdmin ? '#059669' : 'var(--t3)';
    btnStaff.style.borderBottom = !isAdmin ? '2px solid #059669' : '2px solid transparent';
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
          <i class="fas fa-user-tie" style="color:#059669;margin-right:4px;font-size:.75rem"></i>${escHtml(u.name)}
          ${u.active !== false ? '' : '<span style="font-size:.68rem;background:#F3F4F6;color:var(--t3);padding:1px 5px;border-radius:5px;margin-left:4px">비활성</span>'}
        </span>
        <button onclick="toggleStaffActive('${escHtml(u.name)}', ${u.active === false})"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;
                 background:${u.active !== false ? '#FEE2E2' : '#D1FAE5'};color:${u.active !== false ? '#DC2626' : '#065F46'}">
          ${u.active !== false ? '<i class="fas fa-ban"></i> 비활성화' : '<i class="fas fa-check"></i> 활성화'}
        </button>
        <button onclick="openEditStaffPw('${escHtml(u.name)}')"
          style="font-size:.7rem;padding:3px 8px;border:none;border-radius:5px;cursor:pointer;font-weight:600;background:#ECFDF5;color:#059669">
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
  if (tabName === "recruit")   { loadRecruitList(); loadRecruitTabOptions(); }
  if (tabName === "payment")   initPaymentPanel();
  if (tabName === "dashboard") { try { loadTabDashboard(); } catch(_){} try { loadSystemMonitor(); } catch(_){} try { loadStatsOverview(); } catch(_){} }
  if (tabName === "archive")   { try { loadArchiveList(); } catch(_){} try { _loadArchiveHistory(); } catch(_){} }
  if (tabName === "settings")  { try { loadUnrecognizedTabs(); } catch(_){} try { loadKeywordList(); } catch(_){} }
  // ★ 컨텍스트 툴바 업데이트
  _updateContextToolbar(tabName);
}

/* ══════════════════════════════════════════════════════════════
   ★ 컨텍스트 툴바 (탭별 버튼)
   ══════════════════════════════════════════════════════════════ */
// 탭별 버튼 정의
const _CTX_TOOLBAR_DEFS = {
  dashboard: [
    { id:'ctx-filter',      label:'필터',     icon:'fa-filter',      style:'',           onclick:"document.getElementById('dashFilterBtn')?.click()", title:'캠페인 필터'},
    { id:'ctx-add',         label:'업체추가',  icon:'fa-plus',        style:'green',      onclick:"openAddCampaign()", title:'캠페인 추가'},
    { sep: true },
    { id:'ctx-refresh',     label:'새로고침',  icon:'fa-sync-alt',    style:'',           onclick:"_refreshDashboardAll()", title:'대시보드 새로고침'},
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
  '':       'background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.85)',
  'green':  'background:rgba(16,185,129,.2);border-color:rgba(16,185,129,.5);color:#6EE7B7',
  'red':    'background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.45);color:#FCA5A5',
  'yellow': 'background:rgba(251,191,36,.18);border-color:rgba(251,191,36,.5);color:#FCD34D',
  'orange': 'background:rgba(249,115,22,.15);border-color:rgba(249,115,22,.45);color:#FDBA74',
  'colvis': 'background:rgba(99,102,241,.18);border-color:rgba(99,102,241,.5);color:#A5B4FC',
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
        btn.style.filter = 'brightness(1.4)';
        btn.style.boxShadow = '0 0 0 2px rgba(255,255,255,.25)';
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
    btn.style.filter = 'brightness(1.4)';
    btn.style.boxShadow = '0 0 0 2px rgba(255,255,255,.3)';
  } else {
    btn.style.filter = '';
    btn.style.boxShadow = '';
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
    const consent = r.consent ? '<span style="color:#059669;font-weight:700">동의</span>' : '<span style="color:#9CA3AF">-</span>';
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
          <tr style="background:#F5F3FF;border-bottom:2px solid #DDD6FE">
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:center;white-space:nowrap">#</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:left;white-space:nowrap">이름</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:left;white-space:nowrap">전화번호</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:left;white-space:nowrap">등록일시</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:center;white-space:nowrap">동의</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:left;white-space:nowrap">비고</th>
            <th style="padding:10px 12px;font-size:.75rem;color:#5B21B6;font-weight:700;text-align:center;white-space:nowrap">관리</th>
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

/* ── 제출 현황 대시보드 ── */
async function loadAdminDashboard() {
  // ★ v11.5: 캠페인 탭 관리 UI로 통합 — 대시보드 메인은 loadTabDashboard()가 담당
  try { await loadTabDashboard(); } catch(_){}
  
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

    const rate = grand.total > 0 ? Math.round(grand.submitted / grand.total * 100) : 0;
    document.getElementById("sumTotal").textContent   = grand.total.toLocaleString();
    document.getElementById("sumDone").textContent    = grand.submitted.toLocaleString();
    document.getElementById("sumPending").textContent = grand.pending.toLocaleString();
    document.getElementById("sumRate").textContent    = rate + "%";
    show("dashboardSummary");

    // Phase 14: 인식 실패 탭 배지 업데이트
    _updateUnrecogBadge();

    // ★ Phase 12: 아카이브 대상 배지 업데이트 (대시보드에서 알림)
    _updateArchiveBadge();

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
        const tRate     = t.total > 0 ? Math.round(t.submitted / t.total * 100) : 0;
        const tabKey    = (t.sheetId || "") + "||" + (t.tab || "");
        const isClosedTab = _closedSet.has(tabKey);
        const isTabDone = (t.total > 0 && t.pending === 0);
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
          + (!t.displayName && !isClosedTab ? " no-product-warn" : ""));
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
            const rdStartDateRaw2 = rd.startDate || t.startDate || "";
            const _rdManualSD2 = _getManualStartDate(rdTabKey2) || _getManualStartDate(tabKey + "||" + (rd.round || "").replace(/.*/, ""));
            const _rdEffectiveSD2 = _rdManualSD2 || rdStartDateRaw2;
            const _rdOvDays2 = (!rdDone && !isRoundClosed) ? _calcOverdueDays(_rdEffectiveSD2) : null;
            const rdIsOverdue2 = _rdOvDays2 !== null && _rdOvDays2 >= 25;
            _setupRow(rdRow, rdTabKey2, (rdDone ? " tab-done" : "") + (isRoundClosed ? " is-closed-row" : "") + (rdIsOverdue2 ? " urgent-overdue" : ""));
            rdRow.dataset.sortDate = _rdEffectiveSD2 || "9999";
            rdRow.dataset.sortTaekhap = t.taekhap ? "1" : "0";
            rdRow.dataset.sortEnddate = 9999;
            const rdRate = rd.total > 0 ? Math.round(rd.submitted / rd.total * 100) : 0;
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
          const tRate2     = t.total2 > 0 ? Math.round(t.submitted2 / t.total2 * 100) : 0;
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
      const tRate      = t.total > 0 ? Math.round(t.submitted / t.total * 100) : 0;
      const tabKey     = (t.sheetId||"")+"||"+(t.tab||"");
      const isClosedTab = _closedSet.has(tabKey);
      const isTabDone  = (t.total > 0 && t.pending === 0);
      const _mainManualSD = _getManualStartDate(tabKey);
      const _mainEffectiveSD = _mainManualSD || t.startDate || "";
      const _ovDays = (!isTabDone && !isClosedTab) ? _calcOverdueDays(_mainEffectiveSD) : null;
      const isOverdue = _ovDays !== null && _ovDays >= 25;
      const row        = document.createElement("div");
      row.className    = "dash-tab-row " + campStripe + (_isFirstOfCamp2?" camp-first-row":"") + (isTabDone?" tab-done":"")+(isClosedTab?" is-closed-row":"")+(isOverdue?" urgent-overdue":"")
        +(!t.displayName && !isClosedTab?" no-product-warn":"");
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
        depositName: t.depositName||"", transferBank: t.transferBank||"",
        _isClosed: isClosedTab };
      const tcAttr = escHtml(JSON.stringify(tcData));
      const _cachedED2 = localStorage.getItem("rapp_enddate_" + tabKey) || t.endDate || "";
      const endDateHtml2 = _buildEndDateHtml(tabKey, _cachedED2, isTabDone, isClosedTab);

      if (t.roundList && t.roundList.length >= 1) {
        t.roundList.forEach(rd => {
          const rdRow = document.createElement("div");
          const rdDone = (rd.total > 0 && rd.pending === 0);
          const rdTabKey = tabKey + "||" + (rd.round || "");
          // ★ 차수별 마감 판정
          const isRoundClosed = isClosedTab || _closedRoundSet.has(rdTabKey);
          const rdStartDateRaw = rd.startDate || t.startDate || "";
          const _rdManualSD = _getManualStartDate(rdTabKey);
          const _rdEffectiveSD = _rdManualSD || rdStartDateRaw;
          const _rdOvDays = (!rdDone && !isRoundClosed) ? _calcOverdueDays(_rdEffectiveSD) : null;
          const rdIsOverdue = _rdOvDays !== null && _rdOvDays >= 25;
          rdRow.className = "dash-tab-row " + campStripe + (rdDone?" tab-done":"")+(isRoundClosed?" is-closed-row":"")+(rdIsOverdue?" urgent-overdue":"");
          rdRow.dataset.tabkey = rdTabKey;
          rdRow.dataset.campname = campName.toLowerCase();
          rdRow.dataset.sortCampaign = campName.toLowerCase();
          if (allDone) rdRow.classList.add("camp-all-done");
          if (hasClosed) rdRow.classList.add("camp-has-closed");
          const rdRate = rd.total > 0 ? Math.round(rd.submitted / rd.total * 100) : 0;
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
  const incomeTypeClass = t.incomeType === '소득신고' ? 'style="background:#EDE9FE;color:#5B21B6;border-color:#A78BFA"'
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
    ? `<a class="dash-folder-link" style="color:#7C3AED;background:#F5F3FF;border-color:#DDD6FE" href="${escHtml(t.captureFolderUrl)}" target="_blank" onclick="event.stopPropagation()"><i class="fas fa-camera"></i> 캡처폴더</a>`
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
      <i class="fas ${def.icon}" style="width:13px;color:#6366F1;font-size:.72rem"></i>
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
    { colIdx: 0,  inner: '<i class="fas fa-archive"      style="font-size:.6rem;color:#7C3AED"></i>',  style: 'justify-content:center', title: '마감 선택',    cbClass: 'closed-cb-wrap' },
    { colIdx: 1,  inner: '<i class="fas fa-building" style="font-size:.55rem;color:#059669"></i> 캠페인', style: '' },  // ★ v11.0: 엑셀형 플랫 UI
    { colIdx: 2,  inner: '<i class="fas fa-tag" style="font-size:.55rem"></i> 탭명',              style: '' },
    { colIdx: 3,  inner: '<i class="fas fa-box" style="font-size:.55rem"></i> 상품명',            style: '' },
    { colIdx: 4,  inner: '<i class="fas fa-camera" style="font-size:.55rem;color:#7C3AED"></i> 캡처폴더', style: 'justify-content:center', title: '주문캡처 저장 폴더' },
    { colIdx: 5,  inner: '<i class="fas fa-folder" style="font-size:.55rem;color:#F59E0B"></i> 리뷰폴더',  style: 'justify-content:center', title: '리뷰 저장 폴더'    },
    { colIdx: 6,  inner: '<i class="fas fa-layer-group" style="font-size:.55rem;color:#4338CA"></i> 차수',  style: 'justify-content:center', title: '진행 차수'         },
    { colIdx: 7,  inner: '<i class="fas fa-calendar-day" style="font-size:.55rem"></i> 시작일',   style: '' },
    { colIdx: 8,  inner: '<i class="fas fa-clock" style="font-size:.55rem"></i> 주문시간대',      style: '' },
    { colIdx: 9,  inner: '<i class="fas fa-star" style="font-size:.55rem"></i> 리뷰타입',         style: '' },
    { colIdx: 10, inner: '<i class="fas fa-link" style="font-size:.55rem;color:#7C3AED"></i>',    style: 'justify-content:center', title: '구매양식 제출링크 생성' },
    { colIdx: 11, inner: '<i class="fas fa-user" style="font-size:.55rem"></i> 담당',             style: 'justify-content:center' },
    { colIdx: 12, inner: '<i class="fas fa-chart-bar" style="font-size:.55rem"></i> 진행률',      style: '' },
    { colIdx: 13, inner: '<i class="fas fa-check-double" style="font-size:.55rem"></i> 리뷰',     style: 'justify-content:flex-end' },
    { colIdx: 14, inner: '<i class="fas fa-won-sign" style="font-size:.55rem"></i> 입금',         style: 'justify-content:center' },
    { colIdx: 15, inner: '<i class="fas fa-receipt" style="font-size:.55rem;color:#7C3AED"></i> 진행방식', style: 'justify-content:center', title: '진행방식 (현금/사업자현영/소득신고)' },
    { colIdx: 16, inner: '<i class="fas fa-signature" style="font-size:.55rem;color:#1D4ED8"></i> 입금명',  style: 'justify-content:center', title: '입금자명'  },
    { colIdx: 17, inner: '<i class="fas fa-university" style="font-size:.55rem;color:#92400E"></i> 이체은행', style: 'justify-content:center', title: '이체 은행' },
    { colIdx: 18, inner: '<i class="fas fa-truck" style="font-size:.55rem"></i> 택대',            style: 'justify-content:center' },
    { colIdx: 19, inner: '<i class="fas fa-sticky-note" style="font-size:.55rem;color:#F59E0B"></i> 비고', style: '' },
    { colIdx: 20, inner: '<i class="fas fa-info-circle" style="font-size:.55rem;color:#6366F1"></i> 부가정보', style: 'justify-content:center', title: '대량건·배송타입·마감D-Day 등 부가 정보' },
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

      // ★ 차수 마감 시 아카이브 이동 확인 알람 표시
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

// ★ 차수 마감 후 아카이브 확인 알람
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
        <div style="font-size:.82rem;font-weight:600;color:#92400E;margin-bottom:4px">마감 차수 아카이브 안내</div>
        <div style="font-size:.75rem;color:#78350F;margin-bottom:10px">
          <strong>${summary}</strong> 차수가 마감되었습니다.<br>
          아카이브로 이동하시겠습니까? (다음 빌드 시 자동 제외됩니다)
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="_archiveClosedRoundsNow()" style="padding:5px 12px;background:#8B5CF6;color:#fff;border:none;border-radius:6px;font-size:.73rem;font-weight:600;cursor:pointer">
            <i class="fas fa-archive" style="margin-right:3px"></i>아카이브 이동
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
    showToast(`${tabs.length}건 차수 아카이브 처리 중...`, 'info');
    const res = await fetch(API_BASE_URL + '/api/archive/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
      body: JSON.stringify({ tabs, reason: 'round_closed_manual' }),
    }).then(r => r.json());

    if (res.ok) {
      showToast(`✅ 아카이브 완료: ${res.archivedTabs || tabs.length}건, ${res.archivedRows || 0}행 이동`, 'success');
      await loadTabDashboard(); // 새로고침
    } else {
      showToast(res.error || '아카이브 실패', 'error');
    }
  } catch (err) {
    showToast('아카이브 요청 실패: ' + err.message, 'error');
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
        body: JSON.stringify({ s: sheetId, g: gid, t: tabName, d: displayName })
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

    const savedUrl = (() => { try { return JSON.parse(localStorage.getItem("reviewAppConfig")||"{}").GAS_WEB_APP_URL||""; } catch(_){return "";} })();
    const gasUrl   = BOOTSTRAP_GAS_URL || savedUrl || "";

    if (!gasUrl) {
      if (loadingEl) loadingEl.style.display = "none";
      alert("GAS URL이 설정되지 않아 링크를 복원할 수 없습니다.");
      return false;
    }

    _jsonpGet(gasUrl + "?action=resolveShort&code=" + encodeURIComponent(shortCode), 10000)
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

/** 이미지 파일 처리: 미리보기 표시 → base64 변환 → GAS 호출 */
function _processImgFile(file) {
  // 10MB 제한
  if (file.size > 10 * 1024 * 1024) {
    showToast("이미지 크기는 10MB 이하여야 합니다.", true);
    return;
  }

  // 미리보기 표시
  const reader = new FileReader();
  reader.onload = async function(ev) {
    const dataUrl = ev.target.result; // data:image/jpeg;base64,XXXX

    // 미리보기 UI
    document.getElementById("ofImgThumb").src = dataUrl;
    document.getElementById("ofImgPreview").style.display = "flex";
    document.getElementById("ofImgZone").style.display = "none";
    document.getElementById("ofAiResult").classList.remove("show");
    document.getElementById("ofAiError").style.display = "none";
    // 파일명 표시
    const lbl = document.getElementById("ofImgLabel");
    if (lbl) lbl.textContent = file.name + "  ·  AI 분석 중…";

    // base64 부분만 추출 (data:xxx;base64, 제거)
    const base64 = dataUrl.split(",")[1];
    const mimeType = file.type || "image/jpeg";

    // GAS 호출
    await _callExtractOrderImage(base64, mimeType);
  };
  reader.readAsDataURL(file);
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
    // ★ [Node.js 이관] gasPost()를 통해 API 서버로 전송
    let json;
    try {
      json = await gasPost({
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
    btn.style.background = "#10B981";
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
      hint.style.color = "#10B981";
    } else {
      hint.textContent = "숫자 13자리 자동 형식화 (000000-0000000)";
      hint.style.color = "#9CA3AF";
    }
    // 테두리 색 복원
    input.style.borderColor = digits.length === 13 ? "#10B981" : "#A78BFA";
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

          // ★ [Node.js 이관] gasPost()를 통해 API 서버로 전송 — 2회 재시도
          let upJson = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              upJson = await gasPost(uploadPayload);
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
    incomeType:   _tcCurrent._pendingIncomeType   ?? ""    // ★ v9.14: 진행방식 (undefined → 기존값 보존, "" → 빈값으로 저장)
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
        incomeType:        payload.incomeType   || ""     // ★ v9.14: 진행방식
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
      <i class="fas fa-plus"></i> 업체 추가
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

  // gasErrorBanner 앞에 삽입 (없으면 debugBaseResult 앞)
  const anchor = document.getElementById("gasErrorBanner") || document.getElementById("debugBaseResult");
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
  bar.style.background = "linear-gradient(90deg,#10B981,#059669)";
  setTimeout(() => {
    hide(wrap);
    // 바 색상 원복
    bar.style.background = "linear-gradient(90deg,var(--p),#7C3AED)";
  }, 2500);
}

async function debugBaseSheet() {
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
            `<br><small style="color:#D97706;margin-left:2px">→ [지금 동기화] 버튼을 눌러야 대시보드에 반영됩니다.</small>`;
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
      html += `&nbsp;&nbsp;1. 동기화 전 상태 → <b>[지금 동기화]</b> 클릭 후 재확인<br>`;
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
  const resEl = document.getElementById("debugTabConfigResult");
  show(resEl);
  resEl.innerHTML = "⏳ 세부목록 현황 조회 중...";
  try {
    const data = await gasGet({ action: "debugTabConfig" }, 15000);
    const dl = data.detailSheet || {};

    // ── 헤더 분석 ──
    let headerHtml = "";
    if (dl.exists && dl.data && dl.data.length > 0) {
      const headers = dl.data[0].map(c => String(c || "").trim());
      const expectedCols = ["sheet_url","tab_name","manager","time_range","taekhap","review_type",
        "payment_type","display_name","updated_at","folder_url","is_bulk",
        "capture_folder_url","is_closed","delivery_type","round","nc_mode","deposit_name",
        "transfer_bank","income_type"];
      const missing = expectedCols.filter(c => !headers.includes(c));
      const extra   = headers.filter(c => c && !expectedCols.includes(c));

      headerHtml = `<br><b>📋 헤더 컬럼 (${headers.filter(h=>h).length}개):</b><br>`;
      headerHtml += headers.map((h, i) => {
        if (!h) return "";
        const ok = expectedCols.includes(h);
        return `<span style="color:${ok?'#059669':'#7C3AED'};font-family:monospace">[${i}]${h}</span>`;
      }).filter(Boolean).join(" ");

      if (missing.length > 0) {
        headerHtml += `<br><b style="color:#EF4444">⚠ 누락 컬럼 (${missing.length}개):</b> `;
        headerHtml += missing.map(c => `<code style="color:#DC2626">${c}</code>`).join(", ");
      }
      if (extra.length > 0) {
        headerHtml += `<br><b style="color:#F59E0B">📌 추가 컬럼:</b> ${extra.join(", ")}`;
      }

      // ── 데이터 샘플 ──
      if (dl.data.length > 1) {
        headerHtml += `<br><br><b>📄 데이터 샘플 (최대 5행):</b>`;
        dl.data.slice(1, 6).forEach((row, i) => {
          const tabNameIdx = headers.indexOf("tab_name");
          const mgrIdx     = headers.indexOf("manager");
          const timeIdx    = headers.indexOf("time_range");
                    const closedIdx  = headers.indexOf("is_closed");
          const urlIdx     = headers.indexOf("sheet_url");
          const tabName    = tabNameIdx >= 0 ? String(row[tabNameIdx] || "-") : "-";
          const mgr        = mgrIdx >= 0     ? String(row[mgrIdx]     || "-") : "-";
          const time       = timeIdx >= 0    ? String(row[timeIdx]    || "-") : "-";
          const fd         = fdIdx >= 0      ? String(row[fdIdx]      || "-") : "-";
          const closed     = closedIdx >= 0  ? String(row[closedIdx]  || "-") : "-";
          const urlShort   = urlIdx >= 0 && row[urlIdx]
            ? String(row[urlIdx]).replace(/https?:\/\/docs\.google\.com\/spreadsheets\/d\//, "").substring(0, 20) + "..."
            : "-";
          headerHtml += `<br><span style="font-family:monospace;font-size:.72rem">행${i+2}: [${tabName}] 담당:${mgr} 시간:${time} 완료:${fd} 마감:${closed} sid:${urlShort}</span>`;
        });
      }
    }

    const statusColor = dl.exists ? "#059669" : "#EF4444";
    const statusText  = dl.exists ? "✅ 존재함" : "❌ 없음";

    resEl.innerHTML =
      `<b>세부목록 탭(${data.DETAIL_SHEET_NAME || "세부목록"}):</b> <span style="color:${statusColor}">${statusText}</span><br>` +
      `📊 행 수: <b>${dl.lastRow || 0}</b>행 (헤더 포함)<br>` +
      `🆔 DB(tab_configs) 기반 관리 중` +
      headerHtml +
      (!dl.exists ? `<br><br><b style="color:#EF4444">⚠ 세부목록 탭이 없습니다.<br>→ [저장 동작 테스트] 버튼으로 탭 자동 생성을 시도하세요.</b>` : "") +
      (dl.exists && dl.lastRow <= 1 ? `<br><br><i style="color:#6B7280">ℹ 헤더만 있고 데이터가 없습니다. 탭 설정을 저장하면 데이터가 생성됩니다.</i>` : "");

  } catch(e) {
    resEl.innerHTML = `<b style="color:#EF4444">❌ 오류: ${escHtml(e.message)}</b><br><small>(GAS 최신 버전 재배포 확인)</small>`;
  }
}

async function testTabConfigSave() {
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
  resultEl.innerHTML = '<span style="color:#6366F1"><i class="fas fa-circle-notch fa-spin"></i> 진단 중...</span>';

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
          ? `<span style="color:#059669;background:#D1FAE5;padding:1px 5px;border-radius:3px;font-size:.65rem">${r.action}</span>`
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
    if (progressBar)  { progressBar.style.width = "100%"; progressBar.style.background = "linear-gradient(90deg,#10b981,#059669)"; }
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
      if (progressBar) { progressBar.style.width = "15%"; progressBar.style.background = "linear-gradient(90deg,#0ea5e9,#7C3AED)"; }
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
            if (progressBar)  { progressBar.style.width = "100%"; progressBar.style.background = "linear-gradient(90deg,#10b981,#059669)"; }
            if (progressPct)  progressPct.textContent = "100%";
            if (progressLabel) progressLabel.textContent = "갱신 완료 ✓";
            setTimeout(() => { if (progressWrap) { progressWrap.style.display = "none"; progressWrap.classList.add("hidden"); } }, 2500);

            showToast(`✅ 갱신 완료 (${cnt.toLocaleString()}건, ${elapsedSec}초)`, "success");
            badge.className = "index-badge index-badge-ok";
            badge.textContent = "정상";
            await loadIndexStatus();
            if (elapsedRow && elapsedEl) { elapsedEl.textContent = elapsedSec + "초 (비동기)"; elapsedRow.style.display = ""; }
            if (resultRow && resultEl) { resultEl.innerHTML = `<span style="color:#10B981;font-weight:700">✅ 갱신 완료</span>`; resultRow.style.display = ""; }
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
        hintEl.style.color = "#059669";
      }
      showToast(`✅ 인덱스 최신 상태 — 변경된 탭이 없어 갱신을 건너뜁니다. (${(data.count||0).toLocaleString()}건)`, "success");
      badge.className = "index-badge index-badge-ok"; badge.textContent = "최신";
      await loadIndexStatus();
      if (elapsedRow && elapsedEl) { elapsedEl.textContent = elapsedSec + "초 (스킵)"; elapsedRow.style.display = ""; }
      if (resultRow && resultEl) { resultEl.innerHTML = `<span style="color:#059669;font-weight:700">✅ 최신 상태 (갱신 불필요)</span>`; resultRow.style.display = ""; }
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
        : `<span style="color:#10B981;font-weight:700">✅ 전체 갱신 완료</span>`;
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
          const newRate = Math.round(newDone / total * 100);
          bar.style.width = newRate + '%';
          bar.className = 'dash-tab-bar ' + (newRate === 100 ? 'bar-full' : newRate >= 50 ? 'bar-half' : 'bar-low');
        }
      }

      // 정렬용 데이터 속성 갱신
      row.dataset.sortNums = newDone;
      if (total > 0) row.dataset.sortBar = Math.round(newDone / total * 100);

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
  const newRate    = newTotal > 0 ? Math.round(newDone / newTotal * 100) : 0;

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
    const newRate      = newTotal > 0 ? Math.round(newSubmitted / newTotal * 100) : 0;
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

/* ── 업체(캠페인) 추가 (2단계: 미리보기 → 등록) ── */
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
    const highlighted = q ? item.label.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'), '<b style="color:#7C3AED">$1</b>') : item.label;
    return `<div class="cs-ac-item" style="padding:9px 14px;cursor:pointer;border-bottom:1px solid #F3F4F6;font-size:.9rem;transition:background .15s" onmousedown="_selectCsExisting(${idx}, '${item.sheetId.replace(/'/g,"\\'")}')"
      onmouseenter="this.style.background='#F5F3FF'" onmouseleave="this.style.background=''">${highlighted}</div>`;
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
          ? `🔗 <a href="${escHtml(data.tabUrl || data.sheetUrl)}" target="_blank" style="color:#059669;font-weight:700">해당 탭 바로가기 →</a>`
          : `🔗 <a href="${escHtml(data.sheetUrl)}" target="_blank" style="color:#059669;font-weight:700">구글시트 바로가기 →</a>`);
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

/* ── 계정설정 모달 열릴 때 저장된 템플릿 ID 자동 표시 ── */
const _origOpenGasUrlModal = window.openGasUrlModal;
window.openGasUrlModal = function() {
  if (_origOpenGasUrlModal) _origOpenGasUrlModal.apply(this, arguments);
  // Step2가 표시된 후에 값 주입 (약간 딜레이)
  setTimeout(() => {
    const tmplId = _getTemplateSheetId();
    const inp    = document.getElementById("templateSheetUrlInput");
    const tEl    = document.getElementById("templateSheetTitle");
    if (inp && tmplId) {
      inp.value = "https://docs.google.com/spreadsheets/d/" + tmplId + "/edit";
      if (tEl) tEl.textContent = "저장된 ID: " + tmplId;
    }
  }, 400);
};

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

// ★ [Node.js 이관] api.js로 대체됨 — 기존 GAS 함수 비활성화
// // async function gasGet(params, timeoutMs) {
//   const url = APP_CONFIG.GAS_WEB_APP_URL;
//   if (!url) throw new Error("GAS URL 없음");
//   const qs      = new URLSearchParams(params).toString();
//   const fullUrl = `${url}?${qs}`;
//   const json = await _jsonpGet(fullUrl, timeoutMs || 60000);
//   if (json && json.error) throw new Error(json.error);
//   return json;
// }
// async function gasPost(body, timeoutMs, opts) {
//   const url = APP_CONFIG.GAS_WEB_APP_URL;
//   if (!url) throw new Error("GAS URL 없음");
// 
//   // ★ 파일 데이터가 있거나 forcePost:true 이면 실제 fetch POST 사용
//   // (오래 걸리는 작업은 JSONP 대신 POST로 타임아웃 없이 처리)
//   const hasFiles  = body.files || body.fileBase64 || body.fileData;
//   const forcePost = opts && opts.forcePost;
//   if (hasFiles || forcePost) {
//     const ctrl = new AbortController();
//     const tid  = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
//     try {
//       const resp = await fetch(url, {
//         method:  "POST",
//         headers: { "Content-Type": "text/plain" },
//         body:    JSON.stringify(body),
//         signal:  ctrl.signal
//       });
//       if (!resp.ok) throw new Error("HTTP " + resp.status);
//       const json = await resp.json();
//       if (json && json.error) throw new Error(json.error);
//       return json;
//     } catch (e) {
//       if (e.name === "AbortError") throw new Error("요청 시간 초과");
//       throw e;
//     } finally {
//       if (tid) clearTimeout(tid);
//     }
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
//   const json = await _jsonpGet(fullUrl, timeoutMs || 30000);
//   if (json && json.error) throw new Error(json.error);
//   return json;
// }

/* ── 유틸 ── */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
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
function showToast(msg, type="info") {
  const c = document.getElementById("toastContainer");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  const icons = { error:"fa-circle-xmark", success:"fa-circle-check", warning:"fa-triangle-exclamation", info:"fa-circle-info" };
  t.innerHTML = `<i class="fas ${icons[type]||"fa-circle-info"}"></i>${escHtml(msg)}`;
  c.appendChild(t);
  setTimeout(() => { t.style.transition="opacity .3s"; t.style.opacity="0"; setTimeout(()=>t.remove(),300); }, 3500);
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
      const rdRaw  = r.reviewDoneRaw !== undefined ? r.reviewDoneRaw : (r.row ? r.row[r.submitCol] : '—');
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
   ★ Phase 12: 아카이브 시스템 (탭 단위, 반자동)
   ══════════════════════════════════════════════════════════════ */

// ── 아카이브 목록 로드 (검색/기간필터 지원) ──
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
      wrap.innerHTML = '<div style="text-align:center;padding:32px;color:var(--t3)"><i class="fas fa-inbox" style="font-size:2rem;margin-bottom:8px;display:block"></i>아카이브된 데이터가 없습니다</div>';
      _loadArchiveHistory();
      return;
    }

    // 캠페인별 목록 렌더링
    let html = '';
    campaigns.forEach(camp => {
      const totalRate = camp.totalRows > 0 ? Math.round(camp.totalSubmitted / camp.totalRows * 100) : 0;
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
              <th style="padding:6px 8px;text-align:right;color:#6B7280;width:110px">아카이브일</th>
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
                            t.archiveReason === 'name_completed' ? '#6366F1' : '#10B981';
        const dateStr = t.archivedAt ? new Date(t.archivedAt).toLocaleDateString('ko-KR') : '-';
        const roundsStr = t.rounds ? escHtml(t.rounds) : '<span style="color:#D1D5DB">-</span>';
        html += `<tr style="border-top:1px solid #F3F4F6">
          <td style="padding:5px 10px">${escHtml(t.tabName)}</td>
          <td style="padding:5px 8px;font-size:.73rem;color:#4B5563">${roundsStr}</td>
          <td style="padding:5px 8px;text-align:right">${(t.rowCount||0).toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:right">${(t.submittedCount||0).toLocaleString()}</td>
          <td style="padding:5px 8px;text-align:center"><span style="background:${reasonColor}15;color:${reasonColor};padding:2px 6px;border-radius:4px;font-size:.7rem">${reasonLabel}</span></td>
          <td style="padding:5px 8px;text-align:right;color:#9CA3AF">${dateStr}</td>
          <td style="padding:5px 8px;text-align:center"><button onclick="restoreArchivedTab('${camp.sheetId}','${escHtml(t.tabName).replace(/'/g,"\\'")}')"
            style="font-size:.7rem;padding:3px 8px;border:1px solid #3B82F6;color:#3B82F6;background:#EFF6FF;border-radius:5px;cursor:pointer;white-space:nowrap"
            title="이 탭을 대시보드로 복원합니다"><i class="fas fa-undo"></i> 복원</button></td>
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

// ── 아카이브 탭 복원 ──
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

// ── 아카이브 이력 로드 ──
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
      const color = h.action === 'archive' ? '#8B5CF6' : '#3B82F6';
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
      detectWrap.innerHTML = '<div style="padding:12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;color:#16A34A"><i class="fas fa-check-circle"></i> 아카이브 대상이 없습니다. 모든 인덱스가 진행중입니다.</div>';
      return;
    }

    // 감지 결과 렌더링 + 전체선택/개별선택 체크박스
    let html = `<div style="background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="font-weight:700;color:#7C3AED;font-size:.9rem"><i class="fas fa-magic"></i> 감지 결과: ${data.totalTabs}개 탭 (${data.totalCampaigns}개 캠페인)</span>
        <button onclick="_archiveExecuteSelected()" style="margin-left:auto;background:#8B5CF6;color:#fff;border:none;padding:5px 14px;border-radius:6px;font-size:.78rem;cursor:pointer">
          <i class="fas fa-archive"></i> 선택 항목 아카이브
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
                            t.reason === 'fully_completed' ? '#059669' :
                            t.reason === 'auto_complete' ? '#059669' :
                            t.reason === 'round_closed' ? '#7C3AED' :
                            t.reason === 'name_completed' ? '#6366F1' : '#10B981';
        const indexBadge = t.inIndex === false
          ? '<span style="background:#FEF3C7;color:#D97706;padding:1px 4px;border-radius:3px;font-size:.65rem;margin-left:2px">인덱스외</span>'
          : '';
        const roundBadge = t.round
          ? `<span style="background:#EDE9FE;color:#7C3AED;padding:1px 5px;border-radius:3px;font-size:.65rem;margin-left:2px">${escHtml(t.round)}</span>`
          : '';
        const paidInfo = (t.paidCount !== undefined && t.rowCount)
          ? (t.paidCount >= t.rowCount
            ? `<span style="font-size:.68rem;color:#059669;font-weight:600;background:#ECFDF5;padding:1px 5px;border-radius:3px">입금${t.paidCount}/${t.rowCount} ✓</span>`
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
            ? `<button onclick="event.stopPropagation();_unhideTabBtn('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)" title="숨김 해제" style="background:#ECFDF5;border:1px solid #A7F3D0;padding:1px 5px;border-radius:4px;font-size:.66rem;cursor:pointer;color:#059669;margin-left:3px;white-space:nowrap"><i class="fas fa-eye"></i> 표시</button>`
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

// ── 선택 항목 아카이브 실행 ──
async function _archiveExecuteSelected() {
  const checkboxes = document.querySelectorAll('.archive-detect-cb:checked');
  if (checkboxes.length === 0) {
    alert('아카이브할 항목을 선택해주세요.');
    return;
  }

  const tabs = [];
  checkboxes.forEach(cb => {
    const item = { sheetId: cb.dataset.sheet, tabName: cb.dataset.tab };
    if (cb.dataset.round) item.round = cb.dataset.round;
    tabs.push(item);
  });

  if (!confirm(`${tabs.length}개 탭을 아카이브합니다.\n\n아카이브하면 대시보드에서 제외되고 인덱스 빌드에서 스킵됩니다.\n\n계속하시겠습니까?`)) {
    return;
  }

  const detectWrap = document.getElementById('archiveDetectWrap');
  if (detectWrap) {
    detectWrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2)"><i class="fas fa-circle-notch fa-spin"></i> 아카이브 실행 중...</div>';
  }

  try {
    const data = await gasGet({ action: 'archiveTabs', tabs: tabs, reason: 'auto_detect' });

    if (data.error) {
      alert('아카이브 실패: ' + data.error);
      if (detectWrap) detectWrap.style.display = 'none';
      return;
    }

    const msg = `아카이브 완료!\n\n• ${data.archivedTabs || 0}개 탭 처리\n• ${(data.archivedRows || 0).toLocaleString()}개 행 이동`;
    alert(msg);

    if (detectWrap) detectWrap.style.display = 'none';

    // 아카이브 목록 새로고침
    loadArchiveList();
    // 대시보드 자동 새로고침 (아카이브된 탭 즉시 제거)
    if (typeof loadAdminDashboard === 'function') loadAdminDashboard();
  } catch (err) {
    alert('아카이브 실패: ' + err.message);
    if (detectWrap) detectWrap.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ Phase 12: 아카이브 대상 배지 업데이트 (대시보드에서 호출)
   ══════════════════════════════════════════════════════════════ */

// ── 아카이브 대상 배지 + 대시보드 알림 배너 ──
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
        banner.style.cssText = 'background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:10px 16px;margin-bottom:12px;display:flex;align-items:center;gap:10px;cursor:pointer;transition:all .2s';
        banner.onmouseenter = () => { banner.style.background = '#EDE9FE'; };
        banner.onmouseleave = () => { banner.style.background = '#F5F3FF'; };
        banner.onclick = () => { dashboardArchiveDetect(); };
        const wrap = document.getElementById('dashboardWrap');
        if (wrap && wrap.firstChild) {
          wrap.insertBefore(banner, wrap.firstChild);
        }
      }
      banner.innerHTML = `
        <i class="fas fa-archive" style="color:#8B5CF6;font-size:1.1rem"></i>
        <div style="flex:1">
          <div style="font-weight:600;font-size:.84rem;color:#7C3AED">아카이브 대상 ${totalDetected}건 감지됨</div>
          <div style="font-size:.72rem;color:#6B7280;margin-top:2px">리뷰+입금 완료된 차수가 있습니다. 클릭하여 아카이브 처리하세요.</div>
        </div>
        <i class="fas fa-chevron-right" style="color:#8B5CF6;font-size:.8rem"></i>
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
   ★ 대시보드 내 완료감지 + 아카이브 결정 UI
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
      detectWrap.innerHTML = '<div style="padding:12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;color:#16A34A"><i class="fas fa-check-circle"></i> 아카이브 대상이 없습니다. 모든 인덱스가 진행중입니다.</div>';
      return;
    }

    // 감지 결과 렌더링 + 전체선택/개별선택 체크박스
    let html = `<div style="background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <span style="font-weight:700;color:#7C3AED;font-size:.9rem"><i class="fas fa-magic"></i> 감지 결과: ${data.totalTabs}개 탭 (${data.totalCampaigns}개 캠페인)</span>
        <button onclick="_dashArchiveExecute()" style="margin-left:auto;background:#8B5CF6;color:#fff;border:none;padding:6px 16px;border-radius:6px;font-size:.8rem;cursor:pointer;font-weight:600">
          <i class="fas fa-archive"></i> 선택 항목 아카이브
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
        <span style="font-size:.7rem;color:#9CA3AF">체크 해제 = 아카이브하지 않음 (나중에 처리)</span>
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
                            t.reason === 'fully_completed' ? '#059669' :
                            t.reason === 'auto_complete' ? '#059669' :
                            t.reason === 'round_closed' ? '#7C3AED' :
                            t.reason === 'name_completed' ? '#6366F1' : '#10B981';
        const roundBadge = t.round
          ? `<span style="background:#EDE9FE;color:#7C3AED;padding:1px 5px;border-radius:3px;font-size:.65rem;margin-left:2px">${escHtml(t.round)}</span>`
          : '';
        const indexBadge = t.inIndex === false
          ? '<span style="background:#FEF3C7;color:#D97706;padding:1px 4px;border-radius:3px;font-size:.65rem;margin-left:2px">인덱스외</span>'
          : '';
        const paidInfo = (t.paidCount !== undefined && t.rowCount)
          ? (t.paidCount >= t.rowCount
            ? `<span style="font-size:.68rem;color:#059669;font-weight:600;background:#ECFDF5;padding:1px 5px;border-radius:3px;margin-left:6px">입금${t.paidCount}/${t.rowCount} ✓</span>`
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
            ? `<button onclick="event.stopPropagation();_unhideTabBtn('${escHtml(camp.sheetId)}','${escHtml(t.tabGid)}',this)" title="숨김 해제" style="background:#ECFDF5;border:1px solid #A7F3D0;padding:1px 5px;border-radius:4px;font-size:.66rem;cursor:pointer;color:#059669;margin-left:3px;white-space:nowrap"><i class="fas fa-eye"></i> 표시</button>`
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

// ── 대시보드 아카이브: 전체 선택/해제 ──
function _dashArchiveToggleAll(checked) {
  document.querySelectorAll('.dash-archive-cb').forEach(cb => { cb.checked = checked; });
}

// ── 대시보드 아카이브: 입금 미완료 항목 체크 해제 ──
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

// ── 대시보드 아카이브: 나중에 (닫기) ──
function _dashArchiveSkip() {
  const wrap = document.getElementById('dashArchiveDetectWrap');
  if (wrap) wrap.style.display = 'none';
}

// ── 대시보드 아카이브: 선택 항목 실행 ──
async function _dashArchiveExecute() {
  const checkboxes = document.querySelectorAll('.dash-archive-cb:checked');
  if (checkboxes.length === 0) {
    alert('아카이브할 항목을 선택해주세요.');
    return;
  }

  const tabs = [];
  checkboxes.forEach(cb => {
    const item = { sheetId: cb.dataset.sheet, tabName: cb.dataset.tab };
    if (cb.dataset.round) item.round = cb.dataset.round;
    tabs.push(item);
  });

  const totalUnchecked = document.querySelectorAll('.dash-archive-cb:not(:checked)').length;
  let confirmMsg = `${tabs.length}개 항목을 아카이브합니다.`;
  if (totalUnchecked > 0) {
    confirmMsg += `\n\n(${totalUnchecked}개 항목은 선택 해제되어 아카이브하지 않습니다)`;
  }
  confirmMsg += '\n\n아카이브하면 대시보드에서 제외되고 인덱스 빌드에서 스킵됩니다.\n계속하시겠습니까?';

  if (!confirm(confirmMsg)) return;

  const detectWrap = document.getElementById('dashArchiveDetectWrap');
  if (detectWrap) {
    detectWrap.innerHTML = '<div style="text-align:center;padding:16px;color:var(--t2)"><i class="fas fa-circle-notch fa-spin"></i> 아카이브 실행 중...</div>';
  }

  try {
    const data = await gasPost({ action: 'archiveTabs', tabs: tabs, reason: 'dashboard_detect' });

    if (data.error) {
      alert('아카이브 실패: ' + data.error);
      if (detectWrap) detectWrap.style.display = 'none';
      return;
    }

    const msg = `아카이브 완료!\n\n• ${data.archivedTabs || 0}개 탭 처리\n• ${(data.archivedRows || 0).toLocaleString()}개 행 이동`;
    alert(msg);

    if (detectWrap) detectWrap.style.display = 'none';

    // 배지 업데이트 + 대시보드 새로고침
    _updateArchiveBadge();
    if (typeof loadTabDashboard === 'function') loadTabDashboard();
  } catch (err) {
    alert('아카이브 실패: ' + err.message);
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
      wrap.innerHTML = '<div style="text-align:center;padding:20px;color:var(--t3)"><i class="fas fa-check-circle" style="color:#10B981"></i> 인식 실패 탭이 없습니다.</div>';
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
      'no_data': '#8B5CF6',
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
      'resolved': '#10B981',
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
          ${t.sample_rows ? `<details style="display:inline"><summary style="font-size:.7rem;color:#8B5CF6;cursor:pointer;display:inline">샘플 데이터 보기</summary><div style="max-height:200px;overflow:auto;margin-top:6px;font-size:.68rem;background:#F9FAFB;border-radius:6px;padding:8px"><table style="border-collapse:collapse;width:100%">${_buildUnrecogSampleTable(t.sample_rows)}</table></div></details>` : ''}
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
      'name': '#10B981',
      'submit': '#F59E0B',
      'system_tab': '#EF4444',
      'product': '#8B5CF6',
      'url': '#EC4899',
      'phone': '#6366F1',
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
            <button onclick="toggleKeywordAction('${kw.id}', ${!kw.active})" style="background:none;border:none;cursor:pointer;padding:0;font-size:.7rem;color:${kw.active ? '#F59E0B' : '#10B981'}" title="${kw.active ? '비활성화' : '활성화'}">
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
  // closedRounds에 포함된 차수(아카이브 완료)는 제외
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
        expanded.push(Object.assign({}, t, {
          _roundLabel: rd.round,
          _roundTotal: rd.total,
          _roundSubmitted: rd.submitted,
          _roundPaid: rd.paid || 0,
          _isRoundRow: true,
        }));
      });
    } else {
      expanded.push(t);
    }
  });

  return expanded.filter(t => {
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
  // 아카이브 탭의 완료감지 패널이 열려있으면 새로고침
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

    // ── KPI ──
    const s = res.stats || {};
    const kpiEl = document.getElementById("tabDashKPI");
    if (kpiEl) {
      const rate = s.totalRows > 0 ? Math.round(s.totalSubmitted / s.totalRows * 100) : 0;
      kpiEl.innerHTML = [
        _kpiCard("전체 탭", s.total, "#1D4ED8", "fa-list"),
        _kpiCard("활성", s.active, "#059669", "fa-play-circle"),
        _kpiCard("마감", s.closed, "#DC2626", "fa-stop-circle"),
        _kpiCard("인덱스", s.indexed, "#7C3AED", "fa-database"),
        _kpiCard("미지정", s.noManager, "#9CA3AF", "fa-user-slash"),
        _kpiCard("총 인원", (s.totalRows||0).toLocaleString(), "#0891B2", "fa-users"),
        _kpiCard("제출률", `${rate}%`, rate>=80?"#059669":rate>=50?"#D97706":"#DC2626", "fa-chart-pie"),
      ].join("");
    }

    // ── 동기화 시각 ──
    const syncEl = document.getElementById("tabDashSyncInfo");
    if (syncEl) {
      const t = res.lastSync ? new Date(res.lastSync).toLocaleString("ko-KR") : "없음";
      syncEl.innerHTML = `<i class="fas fa-database" style="margin-right:4px"></i>데이터 원본: <b>DB(tab_configs)</b> &middot; <span style="color:#059669">인덱스 빌드: 매 정시 자동 실행</span>`
        + ` &middot; <button onclick="shareAllSheetsPermission()" style="background:none;border:none;color:#7C3AED;cursor:pointer;font-size:.72rem;font-weight:600;text-decoration:underline;padding:0"><i class="fas fa-shield-alt" style="margin-right:2px"></i>시트 쓰기권한 일괄부여</button>`;
    }

    // ── 담당자 필터 ──
    _populateFilter("tabDashManagerFilter", "전체 담당자", res.managers);
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
function _populateFilterObj(elId, defaultLabel, map) {
  const el = document.getElementById(elId);
  if (!el || !map) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${defaultLabel}</option>`;
  Object.keys(map).sort().forEach(k => { el.innerHTML += `<option value="${escHtml(k)}">${escHtml(k)} (${map[k].tabs})</option>`; });
  el.value = cur;
}

// ═══════════════════════════════════════════════════════════
// 시트 쓰기 권한 일괄 부여
// ═══════════════════════════════════════════════════════════
async function shareAllSheetsPermission() {
  if (!confirm("대시보드에 등록된 모든 캠페인 시트에\n서비스 계정 편집자 권한을 일괄 부여합니다.\n\n진행하시겠습니까?")) return;

  showToast("⏳ 시트 권한 일괄 부여 중... (시트 수에 따라 1~2분 소요)", "info");

  try {
    const res = await gasPost({ action: "shareAllSheets" });
    if (!res || !res.ok) {
      showToast("❌ 권한 부여 실패: " + (res?.error || "알 수 없는 오류"), "error");
      return;
    }

    // 결과 모달 표시
    const details = res.details || [];
    const shared = details.filter(d => d.status === "shared");
    const already = details.filter(d => d.status === "already");
    const errors = details.filter(d => d.status === "error");

    let html = `<div style="padding:16px">
      <h3 style="margin:0 0 12px;font-size:1rem"><i class="fas fa-shield-alt" style="color:#7C3AED;margin-right:6px"></i>시트 권한 부여 결과</h3>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
        <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:#059669">${res.success || 0}</div>
          <div style="font-size:.72rem;color:#166534">새로 부여</div>
        </div>
        <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:#2563EB">${res.already || 0}</div>
          <div style="font-size:.72rem;color:#1E40AF">이미 부여됨</div>
        </div>
        <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:1.3rem;font-weight:700;color:#DC2626">${res.failed || 0}</div>
          <div style="font-size:.72rem;color:#991B1B">실패</div>
        </div>
      </div>
      <div style="font-size:.75rem;color:var(--t3);margin-bottom:8px">서비스 계정: <b>${escHtml(res.serviceAccount || "")}</b></div>`;

    if (errors.length > 0) {
      html += `<details style="margin-top:8px"><summary style="font-size:.78rem;color:#DC2626;cursor:pointer;font-weight:600">❌ 실패 목록 (${errors.length}건)</summary>
        <div style="max-height:200px;overflow-y:auto;margin-top:6px;font-size:.72rem;background:#FEF2F2;padding:8px;border-radius:6px">`;
      errors.forEach(e => {
        html += `<div style="margin-bottom:4px;padding:3px 0;border-bottom:1px solid #FECACA">
          <span style="color:#991B1B">${escHtml(e.sheetId?.substring(0, 12) || "")}...</span>
          <span style="color:#DC2626;margin-left:4px">${escHtml(e.error || "")}</span>
        </div>`;
      });
      html += `</div></details>`;
    }

    if (shared.length > 0) {
      html += `<details style="margin-top:6px"><summary style="font-size:.78rem;color:#059669;cursor:pointer;font-weight:600">✅ 새로 부여 목록 (${shared.length}건)</summary>
        <div style="max-height:200px;overflow-y:auto;margin-top:6px;font-size:.72rem;background:#F0FDF4;padding:8px;border-radius:6px">`;
      shared.forEach(s => {
        html += `<div style="margin-bottom:2px">${escHtml(s.sheetId?.substring(0, 20) || "")}...</div>`;
      });
      html += `</div></details>`;
    }

    html += `</div>`;

    // 간단한 모달 표시
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center";
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    const modal = document.createElement("div");
    modal.style.cssText = "background:#fff;border-radius:12px;max-width:420px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)";
    modal.innerHTML = html + `<div style="padding:0 16px 16px;text-align:right"><button onclick="this.closest('[style*=fixed]').remove()" style="padding:8px 20px;background:#7C3AED;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer">확인</button></div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    showToast(`✅ 권한 부여 완료: 신규 ${res.success || 0}건, 기존 ${res.already || 0}건, 실패 ${res.failed || 0}건`, "success");
  } catch (err) {
    showToast("❌ 권한 부여 오류: " + err.message, "error");
  }
}

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
async function _saveTabField(t, fieldMap) {
  try {
    const payload = { action:"setTabConfig", sheetId: t.sheet_id, tabName: t.tab_name, ...fieldMap };
    const res = await gasPost(payload);
    if (res.error) { showToast(res.error, "error"); return false; }
    // 로컬 데이터 즉시 반영
    for (const [apiKey, val] of Object.entries(fieldMap)) {
      const dbKey = { displayName:"display_name", manager:"manager", reviewType:"review_type",
        paymentType:"payment_type", timeRange:"time_range", depositName:"deposit_name",
        incomeType:"income_type", transferBank:"transfer_bank", folderUrl:"folder_url",
        captureFolderUrl:"capture_folder_url" }[apiKey] || apiKey;
      t[dbKey] = val;
    }
    showToast("저장 완료", "success");
    return true;
  } catch(e) { showToast("저장 실패: "+e.message, "error"); return false; }
}

/** 텍스트 간편입력 → blur/enter 시 저장 */
function _inlineTextEdit(t, dbKey, apiKey, placeholder) {
  const val = escHtml(t[dbKey] || "");
  const id = `ie_${dbKey}_${t.sheet_id}_${t.tab_name}`.replace(/[^a-zA-Z0-9_]/g,"_");
  return `<input id="${id}" type="text" value="${val}" placeholder="${placeholder}"
    style="width:100%;min-width:60px;max-width:140px;padding:2px 5px;border:1px solid #E5E7EB;border-radius:4px;font-size:.73rem;background:#FAFAFA;outline:none"
    onfocus="this.style.borderColor='#3B82F6';this.style.background='#fff'"
    onblur="this.style.borderColor='#E5E7EB';this.style.background='#FAFAFA';_onInlineTextSave(this,'${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}','${apiKey}')"
    onkeydown="if(event.key==='Enter'){this.blur()}"
    data-orig="${val}">`;
}
async function _onInlineTextSave(el, sheetId, tabName, apiKey) {
  const newVal = el.value.trim();
  if (newVal === (el.dataset.orig||"")) return;
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  const ok = await _saveTabField(t, { [apiKey]: newVal });
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
        <button onclick="_saveLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}')" style="background:none;border:none;cursor:pointer;color:#059669;font-size:.72rem" title="저장"><i class="fas fa-check"></i></button>
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
        <button onclick="_saveLinkInput('${id}','${sid}','${tn}','${apiKey}','${dbKey}')" style="background:none;border:none;cursor:pointer;color:#059669;font-size:.72rem" title="저장"><i class="fas fa-check"></i></button>
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
function _inlineSelect(t, dbKey, apiKey, options, colorMap) {
  const cur = t[dbKey] || "";
  const display = cur || "—";
  const clr = (colorMap && colorMap[cur]) || "#6B7280";
  const bg = (colorMap && colorMap[cur+"_bg"]) || "#F3F4F6";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  return `<span onclick="_showSelectPopup(event,'${sid}','${tn}','${apiKey}','${dbKey}',${JSON.stringify(options).replace(/"/g,'&quot;')})" style="cursor:pointer;background:${bg};color:${clr};padding:2px 7px;border-radius:6px;font-size:.7rem;font-weight:500;white-space:nowrap">${escHtml(display)} <i class="fas fa-caret-down" style="font-size:.6rem;opacity:.5"></i></span>`;
}
async function _showSelectPopup(e, sheetId, tabName, apiKey, dbKey, options) {
  e.stopPropagation();
  // 토글: 같은 셀에서 열린 팝업이면 닫기만
  const popupKey = `${sheetId}||${tabName}||${dbKey}`;
  const existing = document.querySelector(".td-inline-popup");
  if (existing && existing._popupKey === popupKey) { _removePopupWithTrack(existing); return; }
  if (_popupJustClosed(popupKey)) return;
  document.querySelectorAll(".td-inline-popup").forEach(el => el.remove());
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
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
      await _saveTabField(t, { [apiKey]: opt });
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
function _inlineTimeRange(t) {
  const cur = t.time_range || "";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  if (!cur) {
    return `<span onclick="_showTimeRangePopup(event,'${sid}','${tn}')" style="cursor:pointer;color:#D1D5DB;font-size:.72rem">— <i class="fas fa-clock" style="font-size:.6rem"></i></span>`;
  }
  const display = cur === "자유" ? "자유" : cur;
  const bg = cur === "자유" ? "#F0FDF4" : "#EFF6FF";
  const clr = cur === "자유" ? "#059669" : "#1D4ED8";
  return `<span onclick="_showTimeRangePopup(event,'${sid}','${tn}')" style="cursor:pointer;background:${bg};color:${clr};padding:2px 7px;border-radius:6px;font-size:.7rem;font-weight:500;white-space:nowrap">${escHtml(display)} <i class="fas fa-caret-down" style="font-size:.6rem;opacity:.5"></i></span>`;
}

function _showTimeRangePopup(e, sheetId, tabName) {
  e.stopPropagation();
  const popupKey = `${sheetId}||${tabName}||timeRange`;
  const existing = document.querySelector(".td-inline-popup");
  if (existing && existing._popupKey === popupKey) { _removePopupWithTrack(existing); return; }
  if (_popupJustClosed(popupKey)) return;
  document.querySelectorAll(".td-inline-popup").forEach(el => el.remove());
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;

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
    <button id="trApplyBtn" onclick="_trApply('${sheetId}','${tabName}')" style="margin-top:10px;width:100%;padding:7px;background:#3B82F6;color:#fff;border:none;border-radius:6px;font-size:.78rem;font-weight:600;cursor:pointer">✓ 적용</button>
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
async function _trApply(sheetId, tabName) {
  const popup = document.querySelector(".td-inline-popup");
  if (!popup) return;
  const t = (_tabDashData?.tabs||[]).find(x => x.sheet_id===sheetId && x.tab_name===tabName);
  if (!t) return;
  let val = "";
  if (popup._trMode === "자유") val = "자유";
  else if (popup._trMode === "타임지정") {
    const s = popup._trStart, e = popup._trEnd;
    val = `${String(s.h).padStart(2,"0")}:${String(s.m).padStart(2,"0")} ~ ${String(e.h).padStart(2,"0")}:${String(e.m).padStart(2,"0")}`;
  }
  popup.remove();
  await _saveTabField(t, { timeRange: val });
  renderTabDashTable();
}

/** 소득유형: 선택 + 이체은행 강제 팝업 */
function _inlineIncomeType(t) {
  const cur = t.income_type || "";
  const bank = t.transfer_bank || "";
  const sid = escHtml(t.sheet_id), tn = escHtml(t.tab_name);
  let display = cur || "—";
  if (cur && bank) display += ` (${bank})`;
  const clrMap = {"현금":"#059669","사업자현영":"#B45309","소득신고":"#7C3AED"};
  const bgMap = {"현금":"#D1FAE5","사업자현영":"#FEF3C7","소득신고":"#EDE9FE"};
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

  let html = `<div style="font-size:.8rem;font-weight:600;margin-bottom:8px"><i class="fas fa-receipt" style="color:#7C3AED;margin-right:4px"></i> 소득유형 선택</div>`;
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
    const tcJson = JSON.stringify({sheetId:t.sheet_id,sheetUrl:t.sheet_url||"",tabName:t.tab_name,displayName:t.display_name||t.tab_name,round:t.round||"",ncMode:!!t.nc_mode,incomeType:t.income_type||"",tabGid:t.tab_gid||""}).replace(/"/g,'&quot;');
    return `<button data-tc="${tcJson}" onclick="event.stopPropagation();copyShortLink(this)" style="background:none;border:none;cursor:pointer;color:#7C3AED;font-size:.82rem" title="구매양식 제출링크 복사"><i class="fas fa-link"></i></button>`;
  }
  if (k === "_status") {
    const st = t.is_closed ? "closed" : "active";
    if (st === "closed") return '<span style="background:#FEE2E2;color:#DC2626;padding:2px 6px;border-radius:8px;font-size:.68rem;font-weight:600">마감</span>';
    return '<span style="background:#D1FAE5;color:#059669;padding:2px 6px;border-radius:8px;font-size:.68rem;font-weight:600">활성</span>';
  }
  if (k === "_progress") {
    // ★ 차수별 행이면 해당 차수의 인원/제출 표시
    const rc = t._isRoundRow ? (t._roundTotal || 0) : (t.row_count || 0);
    const sc = t._isRoundRow ? (t._roundSubmitted || 0) : (t.submitted_count || 0);
    if (rc === 0) return '<span style="color:#D1D5DB">—</span>';
    const pct = Math.round(sc / rc * 100);
    const clr = pct >= 80 ? "#059669" : pct >= 50 ? "#D97706" : "#DC2626";
    return `<span style="font-weight:600">${sc}/${rc}</span> <span style="color:${clr};font-size:.68rem">(${pct}%)</span>`;
  }
  if (k === "_paid") {
    // ★ 입금 현황: paid_count / row_count
    const rc = t._isRoundRow ? (t._roundTotal || 0) : (t.row_count || 0);
    const pc = t._isRoundRow ? (t._roundPaid || 0) : (t.paid_count || 0);
    if (rc === 0) return '<span style="color:#D1D5DB">—</span>';
    if (pc === 0 && rc > 0) return `<span style="font-weight:600">${pc}/${rc}</span>`;
    const pct = Math.round(pc / rc * 100);
    const clr = pct >= 100 ? "#059669" : pct >= 50 ? "#D97706" : "#DC2626";
    const icon = pct >= 100 ? ' <i class="fas fa-check" style="font-size:.6rem"></i>' : '';
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
  if (k === "display_name") return _inlineTextEdit(t, "display_name", "displayName", "상품명 입력");
  if (k === "deposit_name") return _inlineTextEdit(t, "deposit_name", "depositName", "입금자명");
  // 링크 입력
  if (k === "folder_url") return _inlineLinkEdit(t, "folder_url", "folderUrl", "fa-folder", "#059669");
  if (k === "capture_folder_url") return _inlineLinkEdit(t, "capture_folder_url", "captureFolderUrl", "fa-camera", "#1D4ED8");
  if (k === "sheet_url") {
    const url = t.sheet_url;
    const hasGid = t.tab_gid;
    const finalUrl = url ? (hasGid ? url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : url) : '';
    const linkIcon = finalUrl
      ? `<a href="${escHtml(finalUrl)}" target="_blank" style="color:#7C3AED" title="${escHtml(finalUrl)}"><i class="fas fa-external-link-alt"></i></a>`
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
  });
  if (k === "review_type") return _inlineSelect(t, "review_type", "reviewType", ["실배송","빈박스","구매확정","믹스"], {
    "실배송":"#059669","실배송_bg":"#D1FAE5","빈박스":"#7C3AED","빈박스_bg":"#EDE9FE","구매확정":"#1D4ED8","구매확정_bg":"#DBEAFE","믹스":"#D97706","믹스_bg":"#FEF3C7"
  });
  if (k === "payment_type") return _inlineSelect(t, "payment_type", "paymentType", ["현금","현영","소득"], {
    "현금":"#059669","현금_bg":"#D1FAE5","현영":"#1D4ED8","현영_bg":"#DBEAFE","소득":"#7C3AED","소득_bg":"#EDE9FE"
  });
  // 주문시간대
  if (k === "time_range") return _inlineTimeRange(t);
  // 소득유형 + 이체은행 통합
  if (k === "income_type") return _inlineIncomeType(t);
  // 불리언
  if (k === "is_bulk" || k === "nc_mode") {
    return t[k] ? '<i class="fas fa-check-circle" style="color:#059669"></i>' : '<span style="color:#D1D5DB">—</span>';
  }
  if (k === "updated_at") {
    return t.updated_at ? new Date(t.updated_at).toLocaleDateString("ko-KR", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
  }
  // ★ 차수 컬럼: _roundLabel이 있으면 우선 표시
  if (k === "round") {
    const rv = t._roundLabel || t.round || "";
    if (rv) return `<span style="background:#EEF2FF;color:#4338CA;padding:2px 7px;border-radius:8px;font-size:.68rem;font-weight:600">${escHtml(rv)}</span>`;
    return '<span style="color:#D1D5DB">—</span>';
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

function _renderFullTableView(wrap, filtered) {
  const visibleCols = _TAB_DASH_COLS.filter(c => c.show);
  const thStyle = "padding:7px 5px;font-weight:600;white-space:nowrap;border-bottom:2px solid #D1D5DB;font-size:.72rem;position:sticky;top:0;background:#F3F4F6;z-index:1";

  // 아카이브 액션바
  const checkedCount = _tabDashChecked.size;
  let html = `<div id="tabDashArchiveBar" style="display:${checkedCount>0?'flex':'none'};align-items:center;gap:10px;padding:8px 12px;margin-bottom:6px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;flex-wrap:wrap">
    <span style="font-size:.78rem;font-weight:600;color:#92400E"><i class="fas fa-check-square" style="margin-right:4px"></i>${checkedCount}건 선택됨</span>
    <button onclick="_archiveCheckedTabs()" style="padding:4px 12px;background:#DC2626;color:#fff;border:none;border-radius:6px;font-size:.72rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:4px"><i class="fas fa-archive"></i> 아카이브로 보내기</button>
    <button onclick="_clearTabDashChecked()" style="padding:4px 10px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.72rem;cursor:pointer">선택 해제</button>
  </div>`;

  html += `<table style="width:100%;border-collapse:collapse;font-size:.75rem">
    <thead><tr>`;
  // 전체선택 체크박스
  const allChecked = filtered.length > 0 && filtered.every(t => _tabDashChecked.has(`${t.sheet_id}||${t.tab_name}`));
  html += `<th style="${thStyle};text-align:center;width:30px"><input type="checkbox" ${allChecked?'checked':''} onchange="_toggleAllTabDashCheck(this.checked)" style="width:14px;height:14px;cursor:pointer" title="전체 선택/해제"></th>`;
  visibleCols.forEach(c => { html += `<th style="${thStyle};text-align:${c.align}${c.width?';width:'+c.width:''}">${c.label}</th>`; });
  html += `<th style="${thStyle};text-align:center">상세</th></tr></thead><tbody>`;

  filtered.forEach((t, idx) => {
    const st = t.is_closed ? "closed" : "active";
    const key = `${t.sheet_id}||${t.tab_name}`;
    const isChecked = _tabDashChecked.has(key);
    const bg = isChecked ? "#FEF9C3" : (st === "closed" ? "#FEF2F2" : "#fff");
    const hoverBg = isChecked ? "#FEF08A" : "#EFF6FF";
    html += `<tr style="background:${bg};border-bottom:1px solid #F3F4F6" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${bg}'">`;
    // 체크박스 열
    html += `<td style="padding:5px;text-align:center;width:30px"><input type="checkbox" ${isChecked?'checked':''} onchange="_toggleTabDashCheck('${escHtml(t.sheet_id)}','${escHtml(t.tab_name)}',this.checked)" style="width:14px;height:14px;cursor:pointer"></td>`;
    visibleCols.forEach(c => {
      const mw = c.width ? c.width : c.key==='campaign_name'?'140px':c.key==='tab_name'?'180px':'120px';
      html += `<td style="padding:5px;text-align:${c.align};max-width:${mw};${c.width?'width:'+c.width+';':''};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(String(t[c.key]||''))}">${_cellVal(t, c)}</td>`;
    });
    html += `<td style="padding:5px;text-align:center"><button onclick="openTabDashDetail(${idx})" style="background:none;border:none;color:#1D4ED8;cursor:pointer;font-size:.78rem"><i class="fas fa-expand-alt"></i></button></td>`;
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
  bar.style.display = n > 0 ? 'flex' : 'none';
  const span = bar.querySelector('span');
  if (span) span.innerHTML = `<i class="fas fa-check-square" style="margin-right:4px"></i>${n}건 선택됨`;
}

// ── 아카이브 실행 ──
async function _archiveCheckedTabs() {
  if (_tabDashChecked.size === 0) { showToast('아카이브할 탭을 선택하세요.', 'info'); return; }

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

  // 차수가 없는 탭은 기존 방식(탭 전체 아카이브)
  const tabs = selectedTabs.map(t => ({ sheetId: t.sheetId, tabName: t.tabName }));
  const names = selectedTabs.map(t => t.displayName);

  const confirmed = confirm(`선택한 ${tabs.length}건을 아카이브로 보내시겠습니까?\n\n` +
    `아카이브된 탭은:\n` +
    `• 스마트빌드 갱신에서 스킵\n` +
    `• 인덱스 스캔에서 스킵\n` +
    `• DB 동기화에서 스킵\n` +
    `• 탭명/URL 동기화에서 스킵\n\n` +
    names.slice(0, 10).join('\n') + (names.length > 10 ? `\n... 외 ${names.length - 10}건` : ''));
  if (!confirmed) return;

  await _executeArchive(tabs, 'manual_dashboard');
}

// ── 차수 선택 아카이브 모달 ──
function _showArchiveRoundModal(selectedTabs) {
  // 기존 모달 제거
  let modal = document.getElementById('archiveRoundModal');
  if (modal) modal.remove();

  let html = `<div id="archiveRoundModal" style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)">
    <div style="background:#fff;border-radius:14px;padding:24px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <h3 style="margin:0 0 6px;font-size:1rem;color:#1F2937"><i class="fas fa-archive" style="color:#8B5CF6;margin-right:6px"></i>아카이브 차수 선택</h3>
      <p style="margin:0 0 16px;font-size:.78rem;color:#6B7280">아카이브할 차수를 선택하세요. 선택하지 않은 차수는 대시보드에 유지됩니다.</p>`;

  selectedTabs.forEach((tab, tabIdx) => {
    html += `<div style="margin-bottom:14px;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden">
      <div style="background:#F9FAFB;padding:8px 12px;font-size:.82rem;font-weight:600;color:#374151">
        <i class="fas fa-table" style="color:#7C3AED;margin-right:4px"></i>${escHtml(tab.displayName)}
      </div>`;

    if (tab.roundList.length > 1) {
      html += `<div style="padding:8px 12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        <label style="font-size:.72rem;color:#6B7280;margin-right:4px">
          <input type="checkbox" class="archive-round-all" data-tab-idx="${tabIdx}" onchange="_toggleArchiveRoundAll(this,${tabIdx})" style="margin-right:3px">전체
        </label>`;
      tab.roundList.forEach((r, rIdx) => {
        const pct = r.total > 0 ? Math.round(r.submitted / r.total * 100) : 0;
        const pctColor = pct >= 100 ? '#059669' : pct >= 50 ? '#D97706' : '#6B7280';
        html += `<label style="font-size:.75rem;display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border:1px solid #D1D5DB;border-radius:6px;cursor:pointer;background:#FAFAFA">
          <input type="checkbox" class="archive-round-cb" data-tab-idx="${tabIdx}" data-round="${escHtml(r.round)}" value="${escHtml(r.round)}" style="width:13px;height:13px">
          <span>${escHtml(r.round)}</span>
          <span style="color:${pctColor};font-size:.68rem">(${r.submitted}/${r.total})</span>
        </label>`;
      });
      html += `</div>`;
    } else {
      // 차수가 1개 이하인 탭은 전체 아카이브
      html += `<div style="padding:8px 12px;font-size:.75rem;color:#9CA3AF">
        <label><input type="checkbox" class="archive-round-cb" data-tab-idx="${tabIdx}" data-round="__ALL__" value="__ALL__" checked style="margin-right:4px">탭 전체 아카이브</label>
      </div>`;
    }
    html += `</div>`;
  });

  html += `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
      <button onclick="document.getElementById('archiveRoundModal').remove()" style="padding:7px 16px;border:1px solid #D1D5DB;background:#fff;border-radius:8px;font-size:.8rem;cursor:pointer;color:#374151">취소</button>
      <button onclick="_executeArchiveFromModal()" style="padding:7px 16px;background:#8B5CF6;color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer"><i class="fas fa-archive" style="margin-right:4px"></i>확인</button>
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

    // "__ALL__" 이면 탭 전체 아카이브
    const rounds = Array.from(cbs).map(cb => cb.value);
    if (rounds.includes('__ALL__')) {
      tabs.push({ sheetId: tab.sheetId, tabName: tab.tabName });
    } else {
      // 모든 차수가 선택된 경우도 탭 전체 아카이브로 처리
      if (tab.roundList.length > 0 && rounds.length === tab.roundList.length) {
        tabs.push({ sheetId: tab.sheetId, tabName: tab.tabName });
      } else {
        // 차수별 개별 아카이브
        rounds.forEach(round => {
          tabs.push({ sheetId: tab.sheetId, tabName: tab.tabName, round });
        });
      }
    }
  });

  if (tabs.length === 0) {
    showToast('아카이브할 차수를 선택하세요.', 'info');
    return;
  }

  // 모달 닫기
  document.getElementById('archiveRoundModal')?.remove();

  await _executeArchive(tabs, 'manual_dashboard');
}

async function _executeArchive(tabs, reason) {
  try {
    showToast(`${tabs.length}건 아카이브 처리 중...`, 'info');
    const res = await fetch(API_BASE_URL + '/api/archive/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
      body: JSON.stringify({ tabs, reason }),
    }).then(r => r.json());

    if (res.ok) {
      showToast(`아카이브 완료: ${res.archivedTabs}탭, ${res.archivedRows}행`, 'success');
      _tabDashChecked.clear();
      await loadTabDashboard(); // 새로고침
    } else {
      showToast(res.error || '아카이브 실패', 'error');
    }
  } catch (err) {
    showToast('아카이브 요청 실패: ' + err.message, 'error');
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
          style="padding:8px 14px;background:#EEF2FF;color:#4338CA;border:1px solid #C7D2FE;border-radius:8px;font-size:.75rem;font-weight:600;cursor:pointer">
          <i class="fas fa-magic"></i> 자동감지
        </button>
        <div style="display:flex;gap:8px">
          <button onclick="document.getElementById('fixSheetUrlModal').remove()" 
            style="padding:8px 16px;background:#F3F4F6;color:#374151;border:none;border-radius:8px;font-size:.75rem;cursor:pointer">취소</button>
          <button onclick="_fixSheetUrlSave('${escHtml(sheetId)}','${escHtml(tabName)}')" 
            style="padding:8px 16px;background:#7C3AED;color:#fff;border:none;border-radius:8px;font-size:.75rem;font-weight:600;cursor:pointer">
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
  const stClr = st === "closed" ? "#DC2626" : "#059669";
  const rc = t.row_count || 0, sc = t.submitted_count || 0;
  const pct = rc > 0 ? Math.round(sc / rc * 100) : 0;

  // 21컬럼 전체를 그룹별로 표시
  const groups = [
    { title:"기본 정보", icon:"fa-id-card", color:"#1D4ED8", items:[
      ["캠페인", t.campaign_name],
      ["탭명", t.tab_name],
      ["표시명(상품)", t.display_name],
      ["담당자", t.manager],
      ["상태", `<span style="color:${stClr};font-weight:600">${stLabel}</span>`],
    ]},
    { title:"운영 설정", icon:"fa-cogs", color:"#7C3AED", items:[
      ["리뷰유형", t.review_type],
      ["주문시간대", t.time_range],
      ["차수", t.round],

      ["대량건", t.is_bulk ? "예" : "아니오"],
      ["배송유형", t.delivery_type],
      ["NC모드", t.nc_mode ? "활성" : "비활성"],
    ]},
    { title:"입금 정보", icon:"fa-money-bill-wave", color:"#059669", items:[
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
      ["리뷰폴더", t.folder_url ? `<a href="${escHtml(t.folder_url)}" target="_blank" style="color:#059669;word-break:break-all">${escHtml(t.folder_url)}</a>` : "—"],
      ["캡처폴더", t.capture_folder_url ? `<a href="${escHtml(t.capture_folder_url)}" target="_blank" style="color:#1D4ED8;word-break:break-all">${escHtml(t.capture_folder_url)}</a>` : "—"],
      ["시트 URL", t.sheet_url ? `<a href="${escHtml(t.tab_gid ? t.sheet_url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : t.sheet_url)}" target="_blank" style="color:#7C3AED;word-break:break-all">${escHtml(t.tab_gid ? t.sheet_url.replace(/[#?].*$/, '') + '#gid=' + t.tab_gid : t.sheet_url)}</a>` : "—"],
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
  if (document.getElementById("resetArchive")?.checked) { targets.push("archive"); labels.push("아카이브"); }
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
    if (action.includes('add')) return '#059669';
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
        <h3><i class="fas fa-cloud-download-alt" style="color:#059669"></i>
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
    if (s === 'renamed') return '#059669';
    if (s === 'url_fixed') return '#0369A1';
    if (s === 'gid_filled') return '#0891B2';
    if (s === 'dry_run' || s === 'dry_run_url' || s === 'dry_run_gid') return '#7C3AED';
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
    tableRows = `<tr><td colspan="3" style="padding:20px;text-align:center;font-size:.82rem;color:#059669"><i class="fas fa-check-circle" style="margin-right:6px"></i>${dryRun ? '변경할 항목이 없습니다 — 모든 탭명이 시트와 일치합니다.' : '동기화 완료 — 모든 변경이 적용되었습니다.'}</td></tr>`;
  } else {
    tableRows = resultItems.map(r => {
    const badge = `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:.68rem;font-weight:600;color:#fff;background:${statusColor(r.status)}">${statusLabel(r.status)}</span>`;
    let detail = '';
    if (r.newName && r.newName !== r.oldName) {
      detail += `<span style="color:#DC2626;text-decoration:line-through">${escHtml(r.oldName)}</span> → <b style="color:#059669">${escHtml(r.newName)}</b>`;
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
      detail += `<br><span style="font-size:.63rem;color:#6366F1"><i class="fas fa-lightbulb"></i> ${escHtml(r.hint)}</span>`;
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
        <h3 style="margin:0;font-size:.95rem;color:#1E293B"><i class="fas fa-exchange-alt" style="color:#7C3AED;margin-right:6px"></i>${title}</h3>
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
        <button onclick="syncTabNames(false);this.closest('.modal-overlay').remove()" style="padding:7px 20px;background:#059669;color:#fff;border:none;border-radius:6px;font-size:.82rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px"><i class="fas fa-check-circle"></i> 2단계: 적용</button>` : ''}
        <button onclick="this.closest('.modal-overlay').remove()" style="padding:6px 16px;background:#6B7280;color:#fff;border:none;border-radius:6px;font-size:.8rem;font-weight:600;cursor:pointer">닫기</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ── 마감탭 정리 (아카이브 이동) ──
async function cleanClosedTabs() {
  const btn = document.getElementById("btnCleanClosed");
  if (!confirm("마감(is_closed=TRUE) 상태의 탭을 아카이브로 이동합니다.\n\n이동 후 해당 탭은 대시보드에서 사라지고,\n아카이브 탭에서 조회할 수 있습니다.\n계속하시겠습니까?")) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 정리중...'; }
  try {
    const res = await gasPost({ action: "cleanClosedTabs" });
    if (res.error) { showToast(res.error, "error"); return; }
    if (res.closedTabs === 0) {
      showToast("정리할 마감탭이 없습니다.", "info");
    } else {
      showToast(`마감탭 정리: ${res.closedTabs}개 탭, ${res.archivedRows || 0}행 아카이브 이동 (${res.elapsed})`, "success");
    }
    loadTabDashboard();
  } catch (err) {
    showToast("정리 오류: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-broom"></i> 마감탭 정리'; }
  }
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
          <h3 style="margin:0;font-size:1rem;font-weight:700;color:#111"><i class="fas fa-broom" style="color:#7C3AED"></i> 중복 파일 정리 미리보기</h3>
          <a href="${escHtml(data.folderUrl || '')}" target="_blank" style="font-size:.72rem;color:#059669;text-decoration:none;font-weight:600;padding:4px 10px;background:#F0FDF4;border-radius:6px;border:1px solid #BBF7D0;display:${data.folderUrl ? 'inline-flex' : 'none'};align-items:center;gap:4px" title="리뷰폴더 열기"><i class="fas fa-external-link-alt"></i> 폴더 열기</a>
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
