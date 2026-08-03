/**
 * 공고 관리 API 베이스 — 화면마다 도달 가능한 경로가 다르다.
 *   · 관리자 대시보드 : /api/campaign/admin      (adminOrMaster)
 *   · 통합 작업대     : /api/trackb/campaigns    (내부인 열람 + 편집명단 게이트, 같은 핸들러에 위임)
 * ★ 두 네임스페이스는 **경로 모양이 동일**해서 베이스 문자열만 갈아끼우면 된다 —
 *   이 파일을 포크하지 않고 두 화면이 같은 발행·수정 로직을 쓰는 유일한 방법.
 */
function _campApi(path) {
  const base = (typeof window !== 'undefined' && window.CAMPAIGN_ADMIN_API) || '/api/campaign/admin';
  return API_BASE_URL + base + (path || '');
}

/* ═══════════════════════════════════════
   모집공고 관리 — 전역 상태
═══════════════════════════════════════ */
let _recruitEditId   = null;   // 수정 중인 공고 ID (null = 신규)
let _woPrefillOrderId = null;  // 작업오더에서 프리필로 열렸을 때 그 오더 id (저장 후 역연결용)
let _recruitBadges   = [];     // 현재 편집 중인 배지 목록
let _recruitTabList  = [];     // 인덱스 탭 목록 캐시 [{sheetId, tabName, displayName}]

/* ─── 탭 진입 시 자동 로드 — switchAdminTab 원본에 통합됨 ─── */

/* ═══════════════════════════════════════
   공고 목록 로드
═══════════════════════════════════════ */
/* 삭제 모드 상태 — 켰을 때만 카드를 고를 수 있다(평상시 카드에는 삭제 수단이 없음) */
window._recruitDelMode = false;
window._recruitDelPicked = window._recruitDelPicked || new Set();
let _recruitLastList = [];

async function loadRecruitList() {
  const wrap = document.getElementById("recruitListWrap");
  wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>`;
  try {
    const res  = await fetch(_campApi("/list"), {
      headers: _getAuthHeaders()
    });
    const json = await res.json();
    const list = json.data || [];
    _recruitLastList = list;
    if (json.serverNow && window.CampCards) CampCards.setServerNow(json.serverNow);
    if (list.length === 0) {
      wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--t4);font-size:.85rem"><i class="fas fa-bullhorn" style="font-size:1.5rem;display:block;margin-bottom:10px;opacity:.3"></i>등록된 공고가 없습니다.<br><small>우측 상단 [공고 등록] 버튼을 눌러 첫 공고를 작성해보세요.</small></div>`;
      return;
    }
    _renderRecruitCards(list);
  } catch(e) {
    wrap.innerHTML = `<div style="padding:30px;text-align:center;color:var(--err)"><i class="fas fa-exclamation-circle"></i> 불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

/* ═══════════════════════════════════════
   공고 카드 렌더 — 리뷰어 홈과 **같은 모듈**(campaign-cards.js)로 그린다.
   따로 만들면 두 화면이 계속 어긋나므로 단일 출처로 묶었다.
   관리자에게만 ⭐·게이지 분해(확정/진행중)·스펙 줄·액션 바가 더해진다.
═══════════════════════════════════════ */
function _renderRecruitCards(list) {
  const wrap = document.getElementById("recruitListWrap");
  if (!wrap) return;
  if (!window.CampCards) {   // 모듈 미로드 시 빈 화면 대신 안내(무음 실패 방지)
    wrap.innerHTML = `<div style="padding:30px;text-align:center;color:var(--err)">카드 모듈을 불러오지 못했습니다. 새로고침해 주세요.</div>`;
    return;
  }
  const del = window._recruitDelMode;
  window._recruitCardTitles = window._recruitCardTitles || {};
  const html = list.map(c => {
    window._recruitCardTitles[c.id] = c.title || "";
    return CampCards.cardHtml(c, { admin: true, delMode: del, picked: window._recruitDelPicked.has(String(c.id)) });
  }).join("");
  wrap.innerHTML = `<div class="pcards-grid pc-admin">${html}</div>`;
  CampCards.initChipMarquee(wrap);        // 칩이 넘치는 줄만 좌우로 흐르게
  // 카운트다운(구매마감·오픈까지) 0 도달 시 목록 재조회 — 단 삭제 모드 중엔 보류(선택 유실 방지)
  CampCards.startTicker(() => { if (!window._recruitDelMode) loadRecruitList(); });
  _syncDelBar();
}

/* 삭제 모드 토글 — 카드에서 삭제를 뺀 대신, 켰을 때만 선택·삭제할 수 있다 */
function toggleRecruitDelMode() {
  window._recruitDelMode = !window._recruitDelMode;
  window._recruitDelPicked.clear();
  _renderRecruitCards(_recruitLastList);
}
function toggleRecruitDelPick(id) {
  const k = String(id);
  if (window._recruitDelPicked.has(k)) window._recruitDelPicked.delete(k);
  else window._recruitDelPicked.add(k);
  _renderRecruitCards(_recruitLastList);
}
/** 헤더의 삭제 모드 버튼·선택 개수 표시를 현재 상태에 맞춘다 */
function _syncDelBar() {
  const btn = document.getElementById("recruitDelModeBtn");
  const bar = document.getElementById("recruitDelBar");
  const cnt = window._recruitDelPicked.size;
  if (btn) {
    btn.textContent = window._recruitDelMode ? "✕ 삭제 모드 끄기" : "🗑 삭제 모드";
    btn.classList.toggle("on", window._recruitDelMode);
  }
  if (bar) {
    bar.style.display = window._recruitDelMode ? "" : "none";
    const lb = document.getElementById("recruitDelCount");
    const go = document.getElementById("recruitDelGo");
    if (lb) lb.textContent = cnt ? `${cnt}개 선택됨` : "삭제할 공고를 선택하세요";
    if (go) { go.disabled = cnt === 0; go.textContent = cnt ? `🗑 선택한 ${cnt}개 삭제` : "🗑 삭제"; }
  }
}
/** 선택한 공고 일괄 삭제 — 한 건이라도 실패하면 결과를 알리고 목록을 다시 읽는다 */
async function deleteRecruitPicked() {
  const ids = [...window._recruitDelPicked];
  if (!ids.length) return;
  const names = ids.map(id => window._recruitCardTitles[id] || id).slice(0, 5).join("\n· ");
  if (!confirm(`아래 ${ids.length}개 공고를 삭제합니다. 되돌릴 수 없습니다.\n\n· ${names}${ids.length > 5 ? `\n… 외 ${ids.length - 5}개` : ""}`)) return;
  let ok = 0; const fail = [];
  for (const id of ids) {
    try {
      const r = await fetch(_campApi(`/${encodeURIComponent(id)}`), {
        method: "DELETE", headers: _getAuthHeaders(),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok !== false) ok++; else fail.push(window._recruitCardTitles[id] || id);
    } catch (_) { fail.push(window._recruitCardTitles[id] || id); }
  }
  window._recruitDelPicked.clear();
  window._recruitDelMode = false;
  showToast(fail.length ? `${ok}개 삭제 · ${fail.length}개 실패` : `${ok}개 공고를 삭제했습니다.`, fail.length ? "error" : "success");
  loadRecruitList();
}

/* 공고 카드 DOM 생성 (레거시 — 신규 렌더는 _renderRecruitCards) */
function _buildRecruitCard(c) {
  const statusLabel = {draft:"임시저장", active:"모집중", closed:"마감"}[c.status] || c.status;
  const channel = c.channel === "직접입력" ? (c.channel_custom || "직접입력") : (c.channel || "");
  const badges  = Array.isArray(c.badges) ? c.badges : (c.badges ? JSON.parse(c.badges) : []);
  const fee     = c.review_fee ? Number(c.review_fee).toLocaleString() + "원" : "";
  const linkedInfo = c.linked_tab_name
    ? `<span><i class="fas fa-link"></i> ${escHtml(c.linked_tab_name)}</span>`
    : `<span style="color:var(--t4)"><i class="fas fa-unlink"></i> 탭 미연결</span>`;

  const managerEmoji = c.manager === "만두" ? "🥟" : c.manager === "망고" ? "🥭" : "";
  const slotsInfo = c.max_slots > 0
    ? `<span><i class="fas fa-users"></i> ${c.current_slots || 0}/${c.max_slots}명</span>`
    : "";

  window._recruitCardTitles = window._recruitCardTitles || {};
  window._recruitCardTitles[c.id] = c.title || "";
  const div = document.createElement("div");
  div.className = `recruit-card status-${c.status || "draft"}`;
  div.style.position = "relative";   // ★ 064: 우측상단 토글(별표·인기) 배치 기준
  // ★ 064: 카드 우측상단 토글 — ⭐ 별표(우선노출: 먼저 별표한 순서대로 최상단) + 🔥 인기(리뷰어 [인기!] 배지 + 일반모집 선행참여 조건, 참여형만)
  const pinOn = !!c.pinned_at, popOn = c.is_popular === true;
  const flagBtns = `
    <div style="position:absolute;top:10px;right:12px;display:flex;gap:6px;z-index:2">
      ${c.participation_mode ? `<button type="button" title="${popOn ? "인기 해제" : "인기 설정 — 리뷰어에게 [인기!] 배지가 붙고, 일반 모집 1건 제출완료당 인기 1건 참여(1:1) 조건이 걸립니다"}"
        onclick="event.stopPropagation();toggleCampFlag('${escHtml(c.id)}','popular',${popOn ? "false" : "true"})"
        style="border:1px solid ${popOn ? "#FCA5A5" : "#E5E7EB"};cursor:pointer;background:${popOn ? "#FEE2E2" : "#F9FAFB"};color:${popOn ? "#B91C1C" : "#9CA3AF"};border-radius:8px;padding:4px 9px;font-size:.72rem;font-weight:800">🔥${popOn ? " 인기" : ""}</button>` : ""}
      <button type="button" title="${pinOn ? "별표 해제(우선노출 해제)" : "별표 — 목록 최상단 고정(여러 개면 먼저 별표한 순서대로)"}"
        onclick="event.stopPropagation();toggleCampFlag('${escHtml(c.id)}','pinned',${pinOn ? "false" : "true"})"
        style="border:1px solid ${pinOn ? "#FCD34D" : "#E5E7EB"};cursor:pointer;background:${pinOn ? "#FEF3C7" : "#F9FAFB"};color:${pinOn ? "#B45309" : "#9CA3AF"};border-radius:8px;padding:4px 9px;font-size:.86rem;line-height:1">${pinOn ? "⭐" : "☆"}</button>
    </div>`;
  div.innerHTML = flagBtns + `
    <div class="recruit-card-header">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span class="recruit-status-badge ${c.status || "draft"}">${statusLabel}</span>
        ${c.participation_mode ? `<span style="padding:2px 9px;background:#D1FAE5;color:#065F46;border-radius:6px;font-size:.68rem;font-weight:800">⚡ 참여형</span>` : ""}
        ${channel ? `<span style="padding:2px 9px;background:#FEF3C7;color:#92400E;border-radius:6px;font-size:.68rem;font-weight:700">${escHtml(channel)}</span>` : ""}
        ${c.manager ? `<span style="padding:2px 8px;background:#F0FDF4;color:#166534;border-radius:6px;font-size:.68rem;font-weight:600">${managerEmoji} ${escHtml(c.manager)}</span>` : ""}
      </div>
      <span class="recruit-card-title">${escHtml(c.title || "(제목 없음)")}</span>
    </div>
    <div class="recruit-card-meta">
      ${c.time_range   ? `<span><i class="fas fa-clock"></i> ${escHtml(c.time_range)}</span>` : ""}
      ${c.delivery_type ? `<span><i class="fas fa-truck"></i> ${escHtml(c.delivery_type)}</span>` : ""}
      ${fee            ? `<span><i class="fas fa-won-sign"></i> 리뷰비 ${fee}</span>` : ""}
      ${slotsInfo}
      ${linkedInfo}
    </div>
    ${badges.length ? `<div class="recruit-card-badges">${badges.map(b=>`<span class="recruit-card-badge">${escHtml(b)}</span>`).join("")}</div>` : ""}
    ${c.notes ? `<div style="font-size:.72rem;color:var(--t3);white-space:pre-line;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">${escHtml(c.notes)}</div>` : ""}
    <div class="recruit-card-actions">
      <div class="recruit-actions-left">
        <button class="recruit-btn recruit-btn-edit" onclick="openRecruitModal('${escHtml(c.id)}')"><i class="fas fa-pen"></i> 수정</button>
        <button class="recruit-btn recruit-btn-del"  onclick="deleteRecruitPost('${escHtml(c.id)}', \`${escHtml(c.title||'')}\`)"><i class="fas fa-trash"></i> 삭제</button>
        ${c.participation_mode ? `<button class="recruit-btn" style="background:#EDE9FE;color:#5B21B6" onclick="openCampControlById('${escHtml(c.id)}')"><i class="fas fa-satellite-dish"></i> 관제</button>` : ""}
        ${c.participation_mode ? `<button class="recruit-btn" style="background:#E0F2FE;color:#075985" onclick="openReviewerPreview('${escHtml(c.id)}')" title="리뷰어가 실제 보는 참여 화면을 확인합니다 (마감된 공고도 가능 · 실제 참여로 기록되지 않음)"><i class="fas fa-eye"></i> 리뷰어 화면</button>` : ""}
      </div>
      ${_recruitToggleHtml(c)}
    </div>
  `;
  return div;
}

/* ★ 064: 카드 우측상단 토글(별표·인기) — 즉시 저장 후 목록 재정렬.
   별표 순서 = 먼저 별표한 공고가 위(서버 pinned_at ASC · 재별표해도 원래 자리 유지). */
async function toggleCampFlag(campId, kind, on) {
  try {
    const body = kind === "pinned" ? { pinned: on } : { popular: on };
    const res = await fetch(_campApi(`/${encodeURIComponent(campId)}/flags`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
    showToast(kind === "pinned"
      ? (on ? "⭐ 별표 — 목록 최상단에 고정됩니다 (여러 개면 먼저 별표한 순서대로)" : "별표를 해제했습니다")
      : (on ? "🔥 인기 설정 — 리뷰어에게 [인기!] 배지가 표시되고, 일반 모집 1건 제출완료당 인기 1건 참여(1:1) 조건이 적용됩니다" : "인기 설정을 해제했습니다"),
      "success");
    await loadRecruitList();   // 서버 정렬(별표 우선) 즉시 반영
  } catch (e) {
    showToast("설정 실패: " + e.message, "error");
  }
}

/* ═══════════════════════════════════════
   리뷰어 화면 미리보기 (관리자 전용 · 읽기 전용)
   · 마감된 공고를 포함해 리뷰어가 실제 보는 참여 화면(참여 전/작업가이드/제출완료)을 확인
   · 실제 참여(홀드)·주문을 만들지 않는다 — campaign.html?preview=1 이 서버의 관리자 전용
     preview 엔드포인트만 호출하고, 구매양식 iframe은 제출이 차단된다.
   · 새 탭은 sessionStorage를 공유하지 않으므로 관리자 토큰을 #tok= 프래그먼트로 넘긴다
     (프래그먼트는 서버 로그·Referer에 실리지 않고, 도착 즉시 주소창에서 제거된다).
═══════════════════════════════════════ */
function openReviewerPreview(campId) {
  const token = sessionStorage.getItem("admin_token") || "";
  if (!token) { showToast("관리자 로그인이 필요합니다.", "error"); return; }
  const url = "campaign.html?id=" + encodeURIComponent(campId) + "&preview=1#tok=" + encodeURIComponent(token);
  // ★ noopener 미사용 의도: 새 탭이 sessionStorage를 이어받아야 토큰 폴백이 동작한다(프래그먼트가 떨어지는
  //   인앱 브라우저 대비). 팝업 차단 시 무반응이 되지 않도록 반환값을 확인해 안내한다.
  const w = window.open(url, "_blank");
  if (!w) showToast("팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용해주세요.", "error");
}

/* 게시/중단 토글 (임시저장↔모집중). 마감(closed) 카드는 토글 미표시 */
function _recruitToggleHtml(c) {
  const status = c.status || "draft";
  if (status === "closed") return "";
  const on = status === "active";
  return `
    <label class="recruit-toggle" title="${on ? "공고 게시중 — 끄면 임시저장(중단)" : "임시저장 — 켜면 공고 게시"}">
      <span class="recruit-toggle-label ${on ? "on" : "off"}">${on ? "게시중" : "중단"}</span>
      <input type="checkbox" ${on ? "checked" : ""} onchange="toggleRecruitPublish('${escHtml(c.id)}', this.checked, this)">
      <span class="recruit-toggle-slider"></span>
    </label>`;
}

/* 공고 게시/중단 토글 핸들러 — 켜면 active(모집중), 끄면 draft(임시저장) */
async function toggleRecruitPublish(id, checked, inputEl) {
  const newStatus = checked ? "active" : "draft";
  if (inputEl) inputEl.disabled = true;
  try {
    const res = await fetch(_campApi("/" + encodeURIComponent(id) + "/status"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ status: newStatus })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ("HTTP " + res.status));
    }
    showToast(checked ? "공고를 게시했습니다." : "공고 게시를 중단했습니다.", "success");
    loadRecruitList();
  } catch (e) {
    showToast("상태 변경 실패: " + e.message, "error");
    if (inputEl) { inputEl.checked = !checked; inputEl.disabled = false; }
  }
}

/* ═══════════════════════════════════════
   인덱스 탭 옵션 로드 (2단계 드롭다운)
   1단계: 캠페인(시트) 선택
   2단계: 해당 캠페인의 탭 목록 표시
═══════════════════════════════════════ */
async function loadRecruitTabOptions() {
  try {
    /* ── API에서 직접 탭 목록을 가져옴 (DOM 의존 제거) ── */
    const token = sessionStorage.getItem("admin_token") || "";
    const res = await fetch(API_BASE_URL + "/api/tab/dashboard", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!res.ok) throw new Error("dashboard API " + res.status);
    const json = await res.json();
    const rows = json.tabs || json.data || [];

    const seen = new Set();
    _recruitTabList = [];
    rows.forEach(r => {
      const sid = r.sheetId || r.sheet_id || "";
      const tab = r.tabName || r.tab_name || "";
      const key = sid + "||" + tab;
      if (!sid || !tab || seen.has(key)) return;
      seen.add(key);
      const sheetName = r.campaignName || r.campaign_name || r.tcCampaignName || sid.slice(-6);
      const display   = r.displayName  || r.display_name  || tab;
      const tabGid    = r.tabGid || r.tab_gid || "";
      _recruitTabList.push({ sheetId: sid, sheetName, tabName: tab, displayName: display, key, tabGid });
    });

    /* fallback: DOM에서 보완 (대시보드가 이미 렌더링됐으면 추가분 반영) */
    document.querySelectorAll("[data-tabkey]").forEach(el => {
      const key = el.dataset.tabkey || "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      const [sid, tab] = key.split("||");
      const campBlock = el.closest(".dash-campaign-block");
      let sheetName = "";
      if (campBlock) {
        const refreshBtn = campBlock.querySelector(".btn-camp-refresh[data-campname]");
        if (refreshBtn) sheetName = refreshBtn.dataset.campname || "";
        if (!sheetName) {
          const nameEl = campBlock.querySelector(".dash-campaign-name");
          if (nameEl) sheetName = nameEl.textContent.trim();
        }
      }
      if (!sheetName) sheetName = sid ? sid.slice(-6) : "(알 수 없음)";
      const nameEl = el.querySelector(".dash-tab-link, a, span");
      const display = nameEl ? nameEl.textContent.trim() : tab;
      _recruitTabList.push({ sheetId: sid, sheetName, tabName: tab, displayName: display, key });
    });

    _populateCampaignSelect();
  } catch(e) {
    console.warn("[recruit] 탭 옵션 로드 실패:", e);
    /* API 실패 시 DOM fallback */
    const rows = document.querySelectorAll("[data-tabkey]");
    const seen = new Set();
    _recruitTabList = [];
    rows.forEach(r => {
      const key = r.dataset.tabkey || "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      const [sid, tab] = key.split("||");
      const campBlock = r.closest(".dash-campaign-block");
      let sheetName = "";
      if (campBlock) {
        const refreshBtn = campBlock.querySelector(".btn-camp-refresh[data-campname]");
        if (refreshBtn) sheetName = refreshBtn.dataset.campname || "";
        if (!sheetName) {
          const nameEl = campBlock.querySelector(".dash-campaign-name");
          if (nameEl) sheetName = nameEl.textContent.trim();
        }
      }
      if (!sheetName) sheetName = sid ? sid.slice(-6) : "(알 수 없음)";
      const nameEl = r.querySelector(".dash-tab-link, a, span");
      const display = nameEl ? nameEl.textContent.trim() : tab;
      _recruitTabList.push({ sheetId: sid, sheetName, tabName: tab, displayName: display, key });
    });
    _populateCampaignSelect();
  }
}

/* 1단계: 캠페인(시트) 선택 드롭다운 구성 */
function _populateCampaignSelect(currentSheetId) {
  const sel = document.getElementById("rf_linked_campaign");
  if (!sel) return;
  /* 중복 없는 sheetId 목록 */
  const campaigns = [];
  const seen = new Set();
  _recruitTabList.forEach(t => {
    if (!seen.has(t.sheetId)) {
      seen.add(t.sheetId);
      campaigns.push({ sheetId: t.sheetId, sheetName: t.sheetName });
    }
  });
  sel.innerHTML = `<option value="">① 캠페인 선택</option>`;
  campaigns.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.sheetId;
    opt.textContent = c.sheetName || c.sheetId.slice(-6);
    if (currentSheetId && currentSheetId === c.sheetId) opt.selected = true;
    sel.appendChild(opt);
  });
  /* 탭 드롭다운 초기화 */
  const tabSel = document.getElementById("rf_linked_tab");
  if (tabSel) {
    tabSel.innerHTML = `<option value="">② 탭 선택 (캠페인 먼저 선택)</option>`;
    tabSel.disabled = true;
  }
}

/* 캠페인 선택 시 → 해당 시트의 탭 목록 표시 */
function onLinkedCampaignChange(camSel) {
  const sid = camSel.value;
  const tabSel = document.getElementById("rf_linked_tab");
  const info   = document.getElementById("rf_linked_tab_info");
  if (info) info.style.display = "none";
  if (!tabSel) return;

  if (!sid) {
    tabSel.innerHTML = `<option value="">② 탭 선택 (캠페인 먼저 선택)</option>`;
    tabSel.disabled = true;
    return;
  }
  /* 해당 sheetId의 탭만 필터링 */
  const tabs = _recruitTabList.filter(t => t.sheetId === sid);
  tabSel.innerHTML = `<option value="">탭 선택</option>`;
  tabs.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.key;
    opt.textContent = t.tabName + (t.displayName && t.displayName !== t.tabName ? ` (${t.displayName})` : "");
    tabSel.appendChild(opt);
  });
  tabSel.disabled = tabs.length === 0;
  if (tabs.length === 0) {
    tabSel.innerHTML = `<option value="">해당 캠페인에 탭 없음</option>`;
  }
}

/* 탭 선택 시 → 연결 정보 표시 */
function onLinkedTabChange(sel) {
  if (typeof renderPartCheck === "function") renderPartCheck(); // 참여형 자동점검 즉시 갱신(N6)
  const info = document.getElementById("rf_linked_tab_info");
  const txt  = document.getElementById("rf_linked_tab_text");
  if (sel.value) {
    const t = _recruitTabList.find(x => x.key === sel.value);
    if (t) {
      txt.textContent = t.sheetName + " > " + t.tabName + " 탭으로 이동";
      info.style.display = "block";
      window._rfLinkedTabName = t.tabName;      // 현영 판정·시트 일정 조회 키
    }
  } else {
    info.style.display = "none";
    window._rfLinkedTabName = "";
  }
  refreshRecruitCashReceipt();   // 탭이 바뀌면 현금영수증 발행 여부 재판정(읽기 전용 표시)
  refreshOptColumnAudit();       // 탭이 바뀌면 옵션 칸 실태 재조회(자동점검 경고용)
}

/* ═══════════════════════════════════════
   🔎 연결 탭 옵션 칸 실태 — 게시 전 자동점검 재료 (경고 전용, 차단 아님)

   시트의 '옵션' 칸은 ㉮ 상품옵션(리뷰어 선택값 기입) / ㉯ 작업옵션=리뷰형태('텍스트'·'포토리뷰'
   작업지시)의 두 종류인데, 공고 옵션명이 ㉯ 칸 값과 어긋난 채 게시되면 제출 때 사고가 났다.
   ★ 서버는 RAW 미러만 읽는다(시트 재읽기 0) · 실패는 조용히 생략(발행을 막지 않는다).
   ═══════════════════════════════════════ */
let _rfOptAudit = null;          // { ok, reason, columns:[{name, designated, values, distinctCount}] }
let _rfOptAuditKey = "";         // 중복 조회 방지(같은 탭 재조회 안 함)

async function refreshOptColumnAudit() {
  const sheetId = document.getElementById("rf_linked_campaign")?.value || "";
  const tabKey  = document.getElementById("rf_linked_tab")?.value || "";
  const tabMeta = _recruitTabList.find(x => x.key === tabKey);
  const gid     = (tabMeta && tabMeta.tabGid) ? String(tabMeta.tabGid) : "";
  const tabName = (tabMeta && tabMeta.tabName) || "";
  const key = sheetId + "||" + gid;
  if (!sheetId || !gid) { _rfOptAudit = null; _rfOptAuditKey = ""; renderPartCheck(); return; }
  if (key === _rfOptAuditKey) return;                 // 같은 탭 — 이미 받아둠
  _rfOptAuditKey = key;
  _rfOptAudit = null;
  try {
    const token = sessionStorage.getItem("admin_token") || "";
    const qs = `?sheetId=${encodeURIComponent(sheetId)}&gid=${encodeURIComponent(gid)}&tabName=${encodeURIComponent(tabName)}`;
    const res = await fetch(API_BASE_URL + "/api/tab/option-column-audit" + qs, {
      headers: { Authorization: "Bearer " + token },
    });
    const d = await res.json();
    // 탭을 그 사이 또 바꿨으면 늦게 온 응답은 버린다(경합 가드)
    if (_rfOptAuditKey !== key) return;
    _rfOptAudit = (d && d.ok) ? d : null;
  } catch (_) {
    _rfOptAudit = null;                                // fail-soft — 점검 항목만 생략
  }
  renderPartCheck();
}

/** 옵션표 옵션명 ↔ 연결 탭 옵션 칸 대조 → 자동점검 항목(0~2개). 경고만, 게시 차단 없음. */
function _optColumnCheckItems() {
  const a = _rfOptAudit;
  if (!a || !Array.isArray(a.columns) || !a.columns.length) return [];
  const optKeys = (typeof readOptRows === "function" ? readOptRows() : [])
    .filter(o => o.status !== "closed").map(o => o.optKey);
  if (!optKeys.length) return [];                      // 옵션 없는 단일상품 공고 — 대조할 것이 없다
  const items = [];

  // ㉮ 상품옵션으로 지정된 칸이 있으면 값 대조 — 불일치는 시트 기입·행매칭이 어긋난다는 신호
  const product = a.columns.filter(c => c.designated);
  for (const col of product) {
    const have = new Set((col.values || []).map(v => String(v).trim()));
    const miss = optKeys.filter(k => !have.has(k));
    if (miss.length) {
      items.push({
        warn: true,
        label: "옵션명 " + miss.length + "개가 시트 「" + escHtml(col.name) + "」 칸 값과 다릅니다 — "
             + escHtml(miss.slice(0, 3).join(", ")) + (miss.length > 3 ? " 외" : ""),
      });
    }
  }

  // ㉯ 미지정 칸 = 작업지시(리뷰형태)로 본다. 값이 이미 채워져 있으면 시스템은 그 칸을 건드리지 않는다.
  const work = a.columns.filter(c => !c.designated && (c.filledRows || 0) > 0);
  if (work.length && !product.length) {
    items.push({
      warn: false,
      label: "시트 「" + escHtml(work.map(c => c.name).join(", ")) + "」 칸은 작업지시(예: "
           + escHtml((work[0].values || []).slice(0, 2).join(", ") || "텍스트")
           + ")로 보입니다 — 공고 옵션명은 이 칸에 기입되지 않고 기존 값이 보존됩니다",
    });
  }
  return items;
}

/* 채널·담당자 버튼을 값으로 선택 — selectRfBtn(사용자 클릭)과 같은 결과를 만든다.
   버튼이 없는 값(예: 올리브영이 없는 구버전 화면)은 '직접입력'으로 흡수해 값을 잃지 않는다. */
function _rfPickBtn(group, val) {
  const hidden = document.getElementById(group === "channel" ? "rf_channel" : "rf_manager");
  const btn = document.querySelector(`#rf_${group}_btns .rchan-btn[data-val="${val}"]`);
  if (btn) { selectRfBtn(group, btn); return true; }
  if (group !== "channel" || !hidden) return false;
  const custom = document.querySelector(`#rf_channel_btns .rchan-btn[data-val="직접입력"]`);
  if (!custom) return false;
  selectRfBtn("channel", custom);
  const ci = document.getElementById("rf_channel_custom");
  if (ci) ci.value = val;
  return true;
}

/* 작업오더가 넘겨준 연결 탭을 드롭다운에서 고른다.
   ★ gid 우선 — 탭 이름은 운영 중 바뀌지만 gid 는 그대로다(이름만 보면 리네임된 탭을 못 찾는다). */
function _prefillLinkedTab(prefill) {
  // 접수 전 오더는 linked_tab_*가 비어 있다 → 작업시트탭URL에서 시트ID·gid를 뽑아 대신 쓴다.
  //   (그 탭이 앞선 오더로 이미 등록돼 있으면 여기서 잡히고, 아니면 아래 목록 검사에서 걸러진다)
  let sid = prefill.linked_sheet_id || "";
  let gidFromUrl = "";
  if (!sid && prefill.work_sheet_url) {
    const sm = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(prefill.work_sheet_url);
    const gm = /[#?&]gid=(\d+)/.exec(prefill.work_sheet_url);
    if (sm && gm) { sid = sm[1]; gidFromUrl = gm[1]; }
  }
  if (!sid) return false;
  const gid = String(prefill.linked_tab_gid || gidFromUrl || "");
  const byGid = gid && _recruitTabList.find(t => t.sheetId === sid && String(t.tabGid || "") === gid);
  const tabName = (byGid && byGid.tabName) || prefill.linked_tab_name || "";
  if (!tabName) return false;
  // 목록에 없는 탭(아카이브·미등록)이면 선택하지 않는다 — 잘못된 탭이 걸리는 것보다 낫다
  if (!_recruitTabList.some(t => t.sheetId === sid && t.tabName === tabName)) return false;
  _restoreLinkedTab(sid, tabName);
  return true;
}

/* 수정 모달 열 때: 저장된 연결 탭 복원 */
function _restoreLinkedTab(linkedSheetId, linkedTabName) {
  if (!linkedSheetId || !linkedTabName) return;
  _populateCampaignSelect(linkedSheetId);
  const camSel = document.getElementById("rf_linked_campaign");
  if (camSel) {
    camSel.value = linkedSheetId;
    onLinkedCampaignChange(camSel);
  }
  const key = linkedSheetId + "||" + linkedTabName;
  const tabSel = document.getElementById("rf_linked_tab");
  if (tabSel) {
    tabSel.value = key;
    onLinkedTabChange(tabSel);
  }
}

/* ═══════════════════════════════════════
   ⚡ 참여형 캠페인 (M2) — 토글·자동점검·시간대 파서
═══════════════════════════════════════ */
/* ═══════════════════════════════════════
   종료일 · 현금영수증 (v4)
═══════════════════════════════════════ */
const _RF_DOW = ["일", "월", "화", "수", "목", "금", "토"];
function _rfDow(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return "";
  return "(" + _RF_DOW[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] + ")";
}

/**
 * 시작일·종료일 옆 요일 표기 + 종료일 경고.
 * ★ 사용자 확정 ③: 시트 일정과 다르면 **경고만 띄우고 시트를 따른다**(입력값은 참고).
 *   시트 마감일은 서버가 구매일자 컬럼에서 파생하므로(063), 여기서는 마지막으로 조회한
 *   값(window._rfSheetEndDate)과 비교만 한다 — 없으면 경고 없음(조용한 무동작).
 */
function onRecruitDatesChange() {
  const sd = document.getElementById("rf_start_date");
  const dl = document.getElementById("rf_deadline");
  const sDay = document.getElementById("rf_start_day");
  const dDay = document.getElementById("rf_deadline_day");
  if (sDay && sd) sDay.textContent = _rfDow(sd.value);
  if (dDay && dl) dDay.textContent = _rfDow(dl.value);
  const warn = document.getElementById("rf_deadline_warn");
  if (!warn || !dl) return;
  const sheetEnd = window._rfSheetEndDate || "";
  if (dl.value && sheetEnd && dl.value !== sheetEnd) {
    warn.style.display = "";
    warn.style.color = "#B45309";
    warn.innerHTML = "⚠ 시트 일정은 <b>" + escHtml(sheetEnd) + " " + _rfDow(sheetEnd) +
      "</b>까지입니다 — 실제 모집은 <b>시트를 따릅니다</b>(입력한 종료일은 참고용).";
  } else {
    warn.style.display = "none";
  }
}

/**
 * 연결 탭의 진행방식으로 현금영수증 발행 여부 표시(읽기 전용).
 * 진실원본은 tab_configs.income_type 하나 — 공고에서 바꾸지 않는다(이중 관리 방지).
 */
async function refreshRecruitCashReceipt() {
  const box = document.getElementById("rf_cashrcpt_ro");
  if (!box) return;
  const sheetId = document.getElementById("rf_linked_campaign")?.value || "";
  const tabName = window._rfLinkedTabName || "";
  if (!sheetId || !tabName) {
    box.style.color = "var(--t3)";
    box.textContent = "탭을 연결하면 진행방식에서 판정합니다";
    return;
  }
  try {
    const d = await gasGet({ action: "getProviderInfo", sheetId, tabName });
    const income = (d && d.incomeType) || "";
    if (income.includes("현영")) {
      box.style.color = "#0B7A5B";
      box.innerHTML = "<b>발행 필요</b> — 진행방식 “" + escHtml(income) + "”" +
        (d.companyBusinessNo ? " · 사업자번호 " + escHtml(d.companyBusinessNo) : "");
    } else {
      box.style.color = "var(--t3)";
      box.textContent = income ? ("발행 없음 — 진행방식 “" + income + "”") : "발행 없음";
    }
  } catch (_) {
    box.style.color = "var(--t3)";
    box.textContent = "진행방식을 불러오지 못했습니다";
  }
}

/* 상품 페이지를 새 탭에서 — 리뷰어 앱 모달의 [바로가기 ↗]와 동일 */
function openRecruitProductUrl() {
  const u = (document.getElementById("rf_product_url")?.value || "").trim();
  if (/^https?:\/\//i.test(u)) window.open(u, "_blank", "noopener");
  else showToast("열 수 있는 상품 URL이 없습니다.", "error");
}

/** 시간 표기에 "자유/자율"이 있으면 자율주문 — 구매시간을 비우고 안내한다.
 *  리뷰어 앱 모달(_caeIsAutoOrder/_caeToggleWindow)과 같은 규율. 관리자가 매번 손으로
 *  비우던 것을 자동화하되, **값을 지우는 건 사용자가 자율로 적었을 때만**이라 오작동 여지가 없다. */
function _isRecruitAutoOrder() {
  return /자유|자율/.test(document.getElementById("rf_time_range")?.value || "");
}
function onRecruitTimeRangeInput() {
  const auto = _isRecruitAutoOrder();
  const note = document.getElementById("rf_autoorder_note");
  if (note) note.style.display = auto ? "" : "none";
  if (auto) {
    ["rf_window_start", "rf_window_end"].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.value) el.value = "";
    });
    if (typeof renderPartCheck === "function") renderPartCheck();
  }
}

/* ═══════════════════════════════════════
   공고 수정 모달 — 탭 전환
   미리보기가 오른쪽에 고정돼 있어, 어느 탭에서 고치든 결과가 바로 보인다.
═══════════════════════════════════════ */
function switchRecruitPane(name) {
  document.querySelectorAll("#recruitModal .rf-tab").forEach(t => {
    t.classList.toggle("on", t.dataset.pane === name);
  });
  document.querySelectorAll("#recruitModal .rf-pane").forEach(p => {
    p.classList.toggle("on", p.dataset.pane === name);
  });
  // 탭을 바꾸면 왼쪽 스크롤은 맨 위로(이전 탭의 스크롤 위치가 남으면 빈 화면처럼 보인다)
  const body = document.querySelector("#recruitModal .modal-body");
  if (body) body.scrollTop = 0;
}

/** 참여형이 꺼져 있으면 모집조건·작업내용 탭은 의미가 없다 — 비활성 + 열려 있으면 기본 탭으로 */
function _syncRecruitPaneGate(on) {
  let moved = false;
  document.querySelectorAll("#recruitModal .rf-tab").forEach(t => {
    if (t.dataset.pane !== "part" && t.dataset.pane !== "work") return;
    t.disabled = !on;
    t.title = on ? "" : "참여형 캠페인을 켜면 사용할 수 있습니다";
    if (!on && t.classList.contains("on")) moved = true;
  });
  if (moved) switchRecruitPane("basic");
}

function onParticipationToggle(on) {
  const sec = document.getElementById("rf_part_section");
  if (sec) sec.style.display = on ? "" : "none";
  // 옵션·작업내용은 탭 분리를 위해 참여형 섹션 밖 형제로 뒀다 — 같이 토글해야 한다
  const work = document.getElementById("rf_work_section");
  if (work) work.style.display = on ? "" : "none";
  _syncRecruitPaneGate(on);
  if (on) {
    // 작업오더의 "2시~4시" 같은 진행시간 텍스트를 시각으로 프리필(비어있을 때만 — 관리자는 확인·수정)
    const ws = document.getElementById("rf_window_start");
    const we = document.getElementById("rf_window_end");
    if (ws && we && !ws.value && !we.value) {
      const parsed = _parsePurchaseTime(document.getElementById("rf_time_range")?.value || "");
      if (parsed) { ws.value = parsed.start; we.value = parsed.end; }
    }
    renderPartCheck();
  }
}

/** 👥 타계정 참여(063) 토글 — 하위 설정(하루한도·타계정 제한시간) 표시. 끄면 기본 [불가] 그대로. */
function onMultiAccountToggle(on) {
  const sec = document.getElementById("rf_multi_section");
  if (sec) sec.style.display = on ? "" : "none";
  renderPartCheck();
}

/** "2시~4시" / "14:00~16:00" / "17시 오픈 이후~19시까지" → {start:'14:00', end:'16:00'} (실패 시 null)
 *  구매시간대 특성상 1~8시는 오후로 해석(+12). 프리필용 — 최종 확정은 관리자 확인. */
function _parsePurchaseTime(text) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*시?[^\d~\-]*[~\-][^\d]*(\d{1,2})(?::(\d{2}))?\s*시?/.exec(String(text || ""));
  if (!m) return null;
  let h1 = parseInt(m[1], 10), m1 = parseInt(m[2] || "0", 10);
  let h2 = parseInt(m[3], 10), m2 = parseInt(m[4] || "0", 10);
  if (h1 >= 1 && h1 <= 8) h1 += 12;
  if (h2 >= 1 && h2 <= 8) h2 += 12;
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59 || (h2 * 60 + m2) <= (h1 * 60 + m1)) return null;
  const pad = n => String(n).padStart(2, "0");
  return { start: `${pad(h1)}:${pad(m1)}`, end: `${pad(h2 === 24 ? 24 : h2)}:${pad(m2)}` };
}

/** 유입가이드 HTML → 미리보기 평문 (원본은 _wdInflowRawHtml에 보존, 여긴 관리자 확인용) */
function _htmlToPlainPreview(html) {
  const imgCount = (String(html).match(/<img/gi) || []).length;
  const txt = String(html)
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<img[^>]*>/gi, "[이미지]")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
  return txt + (imgCount ? `\n\n※ 이미지 ${imgCount}장 포함 — 수정하지 않으면 원본 서식(이미지 포함) 그대로 게시됩니다.` : "");
}

/** 게시 전 자동 점검 — 서버 활성화 게이트와 동일 3항목(빠지면 active 저장이 서버에서 거부됨) */
function participationCheckErrors() {
  const errs = [];
  const tabKey = document.getElementById("rf_linked_tab")?.value || "";
  const tabMeta = _recruitTabList.find(x => x.key === tabKey);
  if (!tabKey || !(tabMeta && tabMeta.tabGid)) errs.push("시트 탭 연결(gid 포함)이 필요해요");
  const ws = document.getElementById("rf_window_start")?.value || "";
  const we = document.getElementById("rf_window_end")?.value || "";
  // 자율주문(종일 오픈) = 양쪽 모두 비움 허용. 한쪽만 입력/역전은 오류(서버 게이트와 동일 규칙)
  if ((ws || we) && (!ws || !we || we <= ws)) errs.push("구매시간은 시작<종료로 입력하거나, 자율주문이면 양쪽 모두 비워주세요");
  const dl = Number(document.getElementById("rf_daily_limit")?.value || 0);
  if (!(dl >= 1)) errs.push("하루 진행 인원(1 이상)을 입력해주세요");
  return errs;
}
function renderPartCheck() {
  const box = document.getElementById("rf_part_check");
  if (!box) return;
  const errs = participationCheckErrors();
  const _ws = document.getElementById("rf_window_start")?.value || "";
  const _we = document.getElementById("rf_window_end")?.value || "";
  const items = [
    { label: "시트 탭 연결됨 (gid)", fail: errs.some(e => e.includes("탭 연결")) },
    { label: (!_ws && !_we) ? "구매시간 미설정 = 자율주문(종일 오픈)" : "구매시간 입력됨 (시작 < 종료)",
      fail: errs.some(e => e.includes("구매시간")) },
    { label: "하루 진행 인원 입력됨", fail: errs.some(e => e.includes("하루 진행")) },
  ];
  // 👥 타계정 참여(063): 게이트가 아니라 "지금 이 설정으로 게시된다"는 확인 항목(항상 통과 = 초록)
  {
    const _ma = document.getElementById("rf_multi_account");
    if (_ma) {
      const _md = Number(document.getElementById("rf_multi_daily")?.value || 0);
      // ★ 0=무제한은 정책상 허용(PRD §09-5)이지만 "한 사람이 자리를 싹쓸이"할 수 있어 경고로 표시(비차단).
      items.push({
        label: _ma.checked
          ? (_md > 0
              ? ("타계정 참여: 가능 (명의당 1건 · 하루 " + _md + "건)")
              : "타계정 참여: 가능 — 하루한도 무제한(한 사람이 여러 자리를 가져갈 수 있어요)")
          : "타계정 참여: 불가 (로그인 계정 1건만)",
        fail: false,
        warn: _ma.checked && !(_md > 0),
      });
    }
  }
  // 🔎 연결 탭 옵션 칸 대조(경고 전용 — 게시는 막지 않는다)
  try { (_optColumnCheckItems() || []).forEach(i => items.push(i)); } catch (_) { /* fail-soft */ }
  // ★ 3색: 실패(빨강, 게시 차단) / 경고(호박, 게시는 가능하나 운영 주의) / 통과(초록)
  box.innerHTML = items.map(i =>
    `<div style="display:flex;align-items:center;gap:7px;font-size:.74rem;font-weight:700;border-radius:8px;padding:6px 10px;
       ${i.fail ? "color:#B91C1C;background:#FEF2F2;border:1px solid #FECACA"
        : (i.warn ? "color:#92400E;background:#FFFBEB;border:1px solid #FCD34D"
                  : "color:#065F46;background:#ECFDF5;border:1px solid #6EE7B7")}">
       ${i.fail ? "✗" : (i.warn ? "⚠" : "✓")} ${i.label}</div>`).join("");
}

/* ═══════════════════════════════════════
   🧩 상품 옵션표 (061 3단계) — 옵션별 금액·정원·하루건수
   ═══════════════════════════════════════ */
function addOptRow(data) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  const d = data || {};
  const status = (d.status === "closed") ? "closed" : "active";   // ★ 마감 상태 보존(리뷰 #1 — 저장 라운드트립에서 재활성화 방지)
  const row = document.createElement("div");
  row.className = "rf-opt-row";
  row.dataset.status = status;
  if (status === "closed") row.style.opacity = ".68";
  const lastBtn = status === "closed"
    ? '<button type="button" class="btn-icon-sm rf-opt-reopen" title="옵션 재개(다시 모집)" style="color:#12b886"><i class="fas fa-rotate-left"></i></button>'
    : '<button type="button" class="btn-icon-sm rf-opt-del" title="이 옵션 삭제" style="color:#EF4444"><i class="fas fa-times"></i></button>';
  row.innerHTML =
    '<input class="rform-input rf-opt-prod" placeholder="상품명">' +
    '<input class="rform-input rf-opt-name" placeholder="옵션명(없으면 비움)">' +
    '<input class="rform-input rf-opt-pay" type="number" min="0" placeholder="금액">' +
    '<input class="rform-input rf-opt-rt" type="number" min="0" placeholder="총">' +
    '<input class="rform-input rf-opt-dl" type="number" min="0" placeholder="일">' +
    lastBtn;
  const rt = d.recruitTotal ?? d.recruit_total, dl = d.dailyLimit ?? d.daily_limit, pay = d.payAmount ?? d.pay_amount;
  // 상품명은 옵션 테이블에 없던 값 — 넘겨받지 않았으면 바로 위 행에서 따라온다(반복 입력 제거)
  row.querySelector(".rf-opt-prod").value = d.productName ?? d.product_name ?? _lastOptProductName();
  row.querySelector(".rf-opt-name").value = d.optKey ?? d.opt_key ?? "";
  row.querySelector(".rf-opt-pay").value  = pay ? pay : "";
  row.querySelector(".rf-opt-rt").value   = rt ? rt : "";     // 0/무제한은 빈칸으로
  row.querySelector(".rf-opt-dl").value   = dl ? dl : "";
  if (status === "closed") row.querySelector(".rf-opt-name").title = "마감된 옵션(참여자 보호로 유지) — 재개 버튼으로 다시 모집할 수 있어요";
  row.querySelectorAll("input").forEach(i => i.addEventListener("input", () => { _optSummary(); renderPartCheck(); _syncPreviewFromOptRows(); }));
  const del = row.querySelector(".rf-opt-del");
  if (del) del.onclick = () => { row.remove(); _optSummary(); renderPartCheck(); _syncPreviewFromOptRows(); };
  const reopen = row.querySelector(".rf-opt-reopen");
  if (reopen) reopen.onclick = () => {   // 마감 옵션 재개 → active + 삭제 버튼으로 교체(재개는 명시적 의도로만)
    row.dataset.status = "active"; row.style.opacity = "";
    reopen.outerHTML = '<button type="button" class="btn-icon-sm rf-opt-del" title="이 옵션 삭제" style="color:#EF4444"><i class="fas fa-times"></i></button>';
    row.querySelector(".rf-opt-del").onclick = () => { row.remove(); _optSummary(); renderPartCheck(); _syncPreviewFromOptRows(); };
    row.querySelector(".rf-opt-name").title = "";
    _optSummary(); renderPartCheck(); _syncPreviewFromOptRows();
  };
  wrap.appendChild(row);
  _markDupProductNames();
  _optSummary();
  _syncPreviewFromOptRows();
}

/** 마지막 행의 상품명 — 옵션을 추가할 때 자동으로 따라오게(같은 상품의 다른 옵션이 대부분) */
function _lastOptProductName() {
  const rows = document.querySelectorAll("#rf_opt_rows .rf-opt-row .rf-opt-prod");
  return rows.length ? (rows[rows.length - 1].value || "") : "";
}
/** 위 행과 같은 상품명은 흐리게 — 자동으로 따라온 값임을 알리되 수정은 자유 */
function _markDupProductNames() {
  let prev = null;
  document.querySelectorAll("#rf_opt_rows .rf-opt-row .rf-opt-prod").forEach(el => {
    el.classList.toggle("rf-dup", prev !== null && el.value === prev);
    prev = el.value;
  });
}

function renderOptRows(options) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  wrap.innerHTML = "";
  (options || []).forEach(o => addOptRow(o));
  _optSummary();
  _syncPreviewFromOptRows();
}

/**
 * 편집 프리필 — 옵션 원장에는 **상품명이 없다**(campaign_options는 옵션 단위).
 * 그래서 작업내용 원문(productLines)을 분해해 옵션명으로 상품명을 되찾아 표를 채운다.
 * 옵션이 없는 단일상품 공고는 원문만으로 행을 만든다(표가 비어 보이지 않게).
 */
function renderOptRowsWithProduct(options, productLines) {
  const parsed = parseProductLinesToRows(productLines);
  const byOpt = new Map();
  parsed.forEach(r => { if (r.optKey) byOpt.set(r.optKey, r); });
  const opts = options || [];
  if (!opts.length) { renderOptRows(parsed.length ? parsed : []); return; }
  const firstProd = parsed.length ? parsed[0].productName : "";
  renderOptRows(opts.map(o => {
    const key = o.optKey || o.opt_key || "";
    const hit = byOpt.get(key);
    return { ...o, productName: (hit && hit.productName) || firstProd || "" };
  }));
}

/** 옵션표 → 저장 payload 배열(빈 옵션명 제거, '|' 정규화, 마감상태 보존) */
function readOptRows() {
  const out = [];
  document.querySelectorAll("#rf_opt_rows .rf-opt-row").forEach(r => {
    const optKey = String(r.querySelector(".rf-opt-name").value || "").replace(/\|/g, "").trim();
    if (!optKey) return;                       // 옵션명 없는 행 = 단일상품 — 옵션 원장에는 넣지 않는다
    out.push({
      optKey,
      payAmount:     Math.max(0, parseInt(r.querySelector(".rf-opt-pay").value, 10) || 0),
      recruitTotal:  Math.max(0, parseInt(r.querySelector(".rf-opt-rt").value, 10) || 0),
      dailyLimit:    Math.max(0, parseInt(r.querySelector(".rf-opt-dl").value, 10) || 0),
      status:        r.dataset.status === "closed" ? "closed" : "active",   // ★ 마감상태 보존(리뷰 #1)
    });
  });
  return out;
}

/** 표의 모든 행(옵션명 없는 단일상품 포함) — 작업내용 원문·정원 합계 산출용 */
function _readProdRows() {
  const out = [];
  document.querySelectorAll("#rf_opt_rows .rf-opt-row").forEach(r => {
    const productName = String(r.querySelector(".rf-opt-prod").value || "").trim();
    const optKey      = String(r.querySelector(".rf-opt-name").value || "").replace(/\|/g, "").trim();
    const payAmount   = Math.max(0, parseInt(r.querySelector(".rf-opt-pay").value, 10) || 0);
    const recruitTotal = Math.max(0, parseInt(r.querySelector(".rf-opt-rt").value, 10) || 0);
    const dailyLimit   = Math.max(0, parseInt(r.querySelector(".rf-opt-dl").value, 10) || 0);
    if (!productName && !optKey && !payAmount) return;   // 완전 빈 행 제외
    out.push({ productName, optKey, payAmount, recruitTotal, dailyLimit,
               closed: r.dataset.status === "closed" });
  });
  return out;
}

/**
 * 표 → ① 작업내용 상품 원문(rf_wd_product) ② 캠페인 정원(rf_daily_limit·rf_recruit_total) 동기화.
 * 표가 진실원본이고 저 세 값은 파생이다 — 표를 고치면 리뷰어 화면·정원이 함께 따라온다.
 * 마감 옵션은 합계에서 제외(모집 가능한 자리만 센다).
 */
function _syncPreviewFromOptRows() {
  const rows = _readProdRows();
  const wd = document.getElementById("rf_wd_product");
  if (wd) {
    wd.value = rows.map(r => {
      const head = [r.productName, r.optKey].filter(Boolean).join(" - ");
      return r.payAmount ? (head ? head + " - 결제금액 " + r.payAmount.toLocaleString() + "원"
                                 : "결제금액 " + r.payAmount.toLocaleString() + "원") : head;
    }).filter(Boolean).join("\n");
  }
  const live = rows.filter(r => !r.closed);
  const rt = document.getElementById("rf_recruit_total");
  const dl = document.getElementById("rf_daily_limit");
  // 하나라도 0(무제한)이면 합계도 0(무제한) — 부분합이 상한처럼 보이면 조기 마감 사고가 난다
  if (rt) rt.value = live.length && live.every(r => r.recruitTotal > 0) ? live.reduce((a, r) => a + r.recruitTotal, 0) : 0;
  if (dl) dl.value = live.length && live.every(r => r.dailyLimit > 0)   ? live.reduce((a, r) => a + r.dailyLimit, 0)   : 0;
  _markDupProductNames();
  _optSummary();     // 프로그램으로 표를 바꿔도(작업오더 자동 적용 등) 요약이 따라오게
  if (typeof _renderPreview === "function") _renderPreview();
}

/**
 * 작업오더 상품정보 텍스트 → 표 행으로 자동 분해(사용자 확정 ②).
 * 실측 형식: "멀티싱글 - 결제금액 28,900원" / "상품명 / 옵션 / 26,900원" / "옵션명 28900"
 * 분해가 애매한 줄은 상품명 칸에 통째로 넣는다(값 유실 없이 관리자가 표에서 정리).
 */
function parseProductLinesToRows(text, fallbackProductName) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  let lastProd = String(fallbackProductName || "").trim();
  for (const line of lines) {
    // 금액: "결제금액 28,900원" 우선, 없으면 줄 끝의 4자리 이상 숫자
    let pay = 0;
    const mPay = line.match(/결제금액\s*([\d,]+)\s*원?/);
    if (mPay) pay = parseInt(mPay[1].replace(/,/g, ""), 10) || 0;
    else {
      const mTail = line.match(/([\d,]{4,})\s*원/) || line.match(/([\d,]{4,})\s*$/);
      if (mTail) pay = parseInt(mTail[1].replace(/,/g, ""), 10) || 0;
    }
    // 금액 표현을 걷어낸 나머지를 구분자로 분해
    const rest = line
      .replace(/결제금액\s*[\d,]+\s*원?/g, "")
      .replace(/[\d,]{4,}\s*원/g, "")
      .replace(/[\s\-·/|]+$/, "")
      .trim();
    const parts = rest.split(/\s*[-–/|·]\s*/).map(p => p.trim()).filter(Boolean);
    let productName = "", optKey = "";
    if (parts.length >= 2) { productName = parts[0]; optKey = parts.slice(1).join(" "); }
    else if (parts.length === 1) {
      // 한 덩어리 — 앞 줄에 상품명이 있으면 이건 옵션명일 가능성이 높다
      if (lastProd) { productName = lastProd; optKey = parts[0]; }
      else { productName = parts[0]; }
    }
    // "옵션 없음" 류는 옵션명이 아니라 '옵션이 없다'는 서술 — 실제 옵션으로 저장되면
    // 리뷰어에게 선택지가 하나 뜨고 시트 옵션열에도 그 문구가 기입된다.
    if (/^(옵션\s*없음|없음|단일(상품)?|해당\s*없음|-|\.)$/.test(optKey)) optKey = "";
    // ★ 옵션명 자리에 상품명이 그대로(또는 접두로) 들어온 줄 — 이건 옵션이 아니라 상품명이다.
    //   opt_key 는 시트 옵션열에 그대로 기입되므로, 상품명이 섞이면 미리 적어둔 리뷰형태
    //   (텍스트/포토리뷰)가 상품명으로 덮인다.
    if (optKey && productName) {
      if (optKey === productName) optKey = "";
      else if (optKey.startsWith(productName)) {
        optKey = optKey.slice(productName.length).replace(/^[\s\-–/|·]+/, "").trim();
      }
    }
    if (!productName && !optKey && !pay) continue;
    if (productName) lastProd = productName;
    rows.push({ productName: productName || lastProd, optKey, payAmount: pay });
  }
  return rows;
}

/** 작업오더 상품정보를 표에 적용 — 옵션 배열이 있으면 그대로, 없으면 텍스트를 분해 */
function applyProductRowsFromOrder(prefill) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  const p = prefill || {};
  let rows = [];
  if (Array.isArray(p.options) && p.options.length) {
    rows = p.options.map(o => ({
      productName: o.productName || p.product_name || "",
      optKey: o.optKey || o.opt_key || "",
      payAmount: o.payAmount || o.pay_amount || 0,
      recruitTotal: o.recruitTotal || 0, dailyLimit: o.dailyLimit || 0,
    }));
  } else if (p.wd_product) {
    rows = parseProductLinesToRows(p.wd_product, p.product_name);
  }
  if (!rows.length) return;
  wrap.innerHTML = "";
  rows.forEach(r => addOptRow(r));
  _optSummary();
  _syncPreviewFromOptRows();
}

/** 옵션표 요약·자동점검(정원합/하루합/중복). 반환: { dup, count } — 저장 시 중복 하드블록용 */
/** 옵션표 요약·자동점검(정원합/하루합/중복). 반환: { dup, count } — 저장 시 중복 하드블록용 */
function _optSummary() {
  const el = document.getElementById("rf_opt_summary");
  const opts = readOptRows();
  const names = opts.map(o => o.optKey.toLowerCase());
  const dup = names.some((n, i) => names.indexOf(n) !== i);
  if (!el) return { dup, count: opts.length };
  if (!opts.length) {
    el.textContent = "옵션을 추가하면 리뷰어가 참여 시 옵션을 직접 선택합니다(2개 이상일 때 선택창 노출). 옵션 없는 단일상품이면 비워두세요.";
    el.style.color = "var(--t3)";
    return { dup, count: 0 };
  }
  const active = opts.filter(o => o.status !== "closed");
  const closedN = opts.length - active.length;
  const anyUnlimited = active.some(o => o.recruitTotal === 0);
  const rtSum = anyUnlimited ? 0 : active.reduce((a, o) => a + o.recruitTotal, 0);
  const allHaveDaily = active.length > 0 && active.every(o => o.dailyLimit > 0);  // 전부 하루한도 있을 때만 합계 비교(공유풀이라 부분캡은 합≠캠페인이 정상)
  const dlSum = active.reduce((a, o) => a + o.dailyLimit, 0);
  // ★ 캠페인 정원(rf_recruit_total·rf_daily_limit)은 이제 표에서 파생되는 값이라
  //   "총모집≠정원합" 같은 불일치 경고는 성립하지 않는다(항상 일치) → 합계만 알린다.
  const msgs = ["옵션 " + active.length + "종" + (closedN ? "(+마감 " + closedN + ")" : "") + " · 정원합 " + (anyUnlimited ? "무제한" : rtSum + "명") + (allHaveDaily && dlSum ? (" · 하루합 " + dlSum + "건") : "")];
  if (dup) msgs.push("⚠ 옵션명 중복(저장 불가)");
  el.innerHTML = msgs.join(" · ");
  el.style.color = (msgs.length > 1) ? "#B45309" : "var(--t3)";
  return { dup, count: opts.length };
}

/* ═══════════════════════════════════════
   모달 열기/닫기
═══════════════════════════════════════ */
async function openRecruitModal(id, prefill, woOrderId) {
  _recruitEditId = id || null;
  _woPrefillOrderId = (!id && woOrderId) ? woOrderId : null;
  _recruitBadges = [];
  window._recruitEditLoadFailed = false;
  window._recruitEditLoaded = null;   // ★ 064: 이전 편집의 로드값(sort_order 등)이 새 공고에 새는 것 방지

  const modal    = document.getElementById("recruitModal");
  const titleEl  = document.getElementById("recruitModalTitle");

  switchRecruitPane("basic");   // 열 때는 항상 첫 탭 — 지난번 탭이 남으면 어디를 보는지 헷갈린다

  /* 폼 초기화 */
  ["rf_title","rf_channel","rf_channel_custom","rf_time_range",
   "rf_review_fee","rf_notes","rf_chat_url","rf_sort_order","rf_max_slots"].forEach(i => {
    const el = document.getElementById(i);
    if (el) el.value = (i === "rf_sort_order" || i === "rf_max_slots") ? "0" : "";
  });
  document.getElementById("rf_delivery_type").value = "";
  document.getElementById("rf_status").value = "draft";
  // 상품정보 가져오기 초기화
  ["rf_product_url","rf_thumbnail","rf_product_name","rf_price"].forEach(i => { const el = document.getElementById(i); if (el) el.value = ""; });
  const _pp = document.getElementById("rf_product_preview"); if (_pp) _pp.style.display = "none";
  document.getElementById("rf_channel_custom").style.display = "none";
  document.querySelectorAll(".rchan-btn").forEach(b => b.classList.remove("active"));
  _refreshBadgeWrap();
  document.getElementById("rf_linked_tab_info").style.display = "none";
  _populateCampaignSelect();   /* 1단계 캠페인 드롭다운 초기화 */

  /* ⚡ 참여형(M2) 필드 초기화 */
  ["rf_start_date","rf_window_start","rf_window_end","rf_daily_limit","rf_recruit_total","rf_landing_url",
   "rf_wd_product","rf_wd_inflow","rf_wd_review","rf_wd_notes"].forEach(i => {
    const el = document.getElementById(i); if (el) el.value = "";
  });
  const _ttlEl = document.getElementById("rf_hold_ttl"); if (_ttlEl) _ttlEl.value = "15";
  const _bufEl = document.getElementById("rf_close_buffer"); if (_bufEl) _bufEl.value = "10";
  /* 👥 타계정 참여(063) 초기화 — 신규 공고 기본 [불가] */
  const _maEl = document.getElementById("rf_multi_account");
  if (_maEl) { _maEl.checked = false; onMultiAccountToggle(false); }
  const _mdEl = document.getElementById("rf_multi_daily"); if (_mdEl) _mdEl.value = "1";
  const _stEl = document.getElementById("rf_sub_ttl"); if (_stEl) _stEl.value = "10";
  const _partEl = document.getElementById("rf_participation");
  if (_partEl) { _partEl.checked = false; onParticipationToggle(false); }
  if (typeof renderOptRows === "function") renderOptRows([]);   // 🧩 옵션표 초기화(061)
  window._wdInflowRawHtml = null;
  const _ivTa = document.getElementById("rf_wd_inflow"); if (_ivTa) _ivTa.dataset.rawHtml = "";
  const _tpv = document.getElementById("rf_thumb_preview"); if (_tpv) _tpv.style.display = "none";
  const _tfi = document.getElementById("rf_thumb_file"); if (_tfi) _tfi.value = "";

  if (id) {
    titleEl.innerHTML = `<i class="fas fa-pen"></i> 모집공고 수정`;
    /* 기존 데이터 로드 */
    try {
      const res  = await fetch(API_BASE_URL + `/api/campaign/${id}`, {
        headers: _getAuthHeaders()
      });
      const json = await res.json();
      const c = json.data || json;
      window._recruitEditLoaded = c;   // ★ 064: sort_order 등 "UI 없는 서버 ||0 강제 필드"의 로드값 보존용
      document.getElementById("rf_title").value        = c.title || "";
      document.getElementById("rf_time_range").value   = c.time_range || "";
      document.getElementById("rf_review_fee").value   = c.review_fee || "";
      document.getElementById("rf_notes").value        = c.notes || "";
      document.getElementById("rf_chat_url").value     = c.chat_url || "";
      // ★ 064: 노출 순서 UI 제거 — 요소가 남아있는 구버전 화면만 프리필(null-safe)
      { const _so = document.getElementById("rf_sort_order"); if (_so) _so.value = c.sort_order ?? 0; }
      document.getElementById("rf_max_slots").value    = c.max_slots ?? 0;
      document.getElementById("rf_status").value       = c.status || "draft";
      document.getElementById("rf_delivery_type").value = c.delivery_type || "";

      /* 담당자 */
      const mgrVal = c.manager || "";
      if (mgrVal) {
        document.getElementById("rf_manager").value = mgrVal;
        const mgrBtn = document.querySelector(`#rf_manager_btns .rchan-btn[data-val="${mgrVal}"]`);
        if (mgrBtn) mgrBtn.classList.add("active");
      }

      /* 채널 */
      const chanVal = c.channel || "";
      const chanBtn = document.querySelector(`#rf_channel_btns .rchan-btn[data-val="${chanVal}"]`);
      if (chanBtn) {
        chanBtn.classList.add("active");
        document.getElementById("rf_channel").value = chanVal;
        if (chanVal === "직접입력") {
          document.getElementById("rf_channel_custom").style.display = "";
          document.getElementById("rf_channel_custom").value = c.channel_custom || "";
        }
      }

      /* 배지 */
      const rawBadges = c.badges;
      _recruitBadges = Array.isArray(rawBadges) ? [...rawBadges]
                     : (typeof rawBadges === "string" && rawBadges ? JSON.parse(rawBadges) : []);
      _refreshBadgeWrap();

      /* 연결 탭 복원 */
      _restoreLinkedTab(c.linked_sheet_id, c.linked_tab_name);

      /* ⚡ 참여형(M2) 필드 복원 */
      if (c.participation_mode) {
        const pe = document.getElementById("rf_participation");
        if (pe) { pe.checked = true; onParticipationToggle(true); }
        const setV = (i, v) => { const el = document.getElementById(i); if (el && v != null && v !== "") el.value = v; };
        setV("rf_start_date", (c.start_date || "").slice(0, 10));
        setV("rf_window_start", (c.window_start || "").slice(0, 5));
        setV("rf_window_end", (c.window_end || "").slice(0, 5));
        setV("rf_daily_limit", c.daily_limit || "");
        setV("rf_recruit_total", c.recruit_total ?? "");
        setV("rf_landing_url", c.landing_url || "");
        setV("rf_hold_ttl", c.hold_ttl_min ?? 15);
        setV("rf_close_buffer", c.close_buffer_min ?? 10);
        /* 👥 타계정 참여(063) 복원 */
        {
          const _ma = document.getElementById("rf_multi_account");
          if (_ma) { _ma.checked = c.multi_account_mode === true; onMultiAccountToggle(_ma.checked); }
          const _md = document.getElementById("rf_multi_daily"); if (_md) _md.value = c.multi_daily_limit ?? 0;
          const _st = document.getElementById("rf_sub_ttl"); if (_st) _st.value = c.sub_hold_ttl_min ?? 10;
        }
        const wd = (typeof c.work_detail === "string") ? (() => { try { return JSON.parse(c.work_detail); } catch (_) { return {}; } })() : (c.work_detail || {});
        // 저장 시 escape+<br> 변환의 역변환(S3): <br>→개행, 엔티티 복원 → textarea에 평문으로
        const _fromHtml = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        setV("rf_wd_product", wd.productLines || "");
        setV("rf_deadline", c.deadline ? String(c.deadline).slice(0, 10) : "");   // 종료일(deadline)
        window._rfSheetEndDate = c.endDate || "";      // 시트 파생 마감일 — 다르면 경고(시트 우선)
        onRecruitDatesChange();
        refreshRecruitCashReceipt();
        // ★ M3 리뷰 #1: 저장본이 리치 HTML(<br> 외 태그 — 프리필 raw로 발행된 이미지 포함 가이드)이면
        //   편집모드도 raw 모드로 복원 — 아니면 "다른 필드만 고쳐 저장"해도 escape 경로가 태그를 문자로 게시(라운드트립 파괴)
        {
          const _rawInflow = String(wd.inflowGuideHtml || "");
          const _inflowTa2 = document.getElementById("rf_wd_inflow");
          if (_inflowTa2 && /<(?!br\s*\/?>)[a-z][^>]*>/i.test(_rawInflow)) {
            window._wdInflowRawHtml = _rawInflow;
            _inflowTa2.value = _htmlToPlainPreview(_rawInflow);
            _inflowTa2.dataset.rawHtml = "1";
            _inflowTa2.addEventListener("input", () => { _inflowTa2.dataset.rawHtml = ""; }, { once: true });
          } else {
            setV("rf_wd_inflow", _fromHtml(_rawInflow));
          }
        }
        setV("rf_wd_review", wd.reviewGuide || "");
        setV("rf_wd_notes", wd.specialNotes || "");
        setV("rf_thumbnail", c.thumbnail_url || "");
        if (c.thumbnail_url) {
          const pv = document.getElementById("rf_thumb_preview");
          if (pv) { pv.src = c.thumbnail_url; pv.style.display = ""; }
        }
        renderOptRowsWithProduct(json.options || [], wd.productLines);   // 🧩 옵션표 + 상품명 복원
        renderPartCheck();
      }
    } catch(e) {
      // ★ B1: 로드 실패 상태에서 저장하면 참여형 필드가 미복원 기본값으로 덮일 수 있음 → 저장 시 참여형 필드 미전송 플래그
      window._recruitEditLoadFailed = true;
      showToast("공고 데이터 로드 실패: " + e.message, "error");
    }
  } else {
    titleEl.innerHTML = `<i class="fas fa-bullhorn"></i> 모집공고 등록`;
    /* ★ 작업오더 프리필 — 매핑 가능한 필드만 채움 (channel/manager/리뷰비는 관리자가 직접) */
    if (prefill) {
      if (prefill.title)        document.getElementById("rf_title").value = prefill.title;
      if (prefill.time_range)   document.getElementById("rf_time_range").value = prefill.time_range;
      if (prefill.max_slots)    document.getElementById("rf_max_slots").value = prefill.max_slots;
      if (prefill.chat_url)     document.getElementById("rf_chat_url").value = prefill.chat_url;
      if (prefill.notes)        document.getElementById("rf_notes").value = prefill.notes;
      if (prefill.delivery_type) document.getElementById("rf_delivery_type").value = prefill.delivery_type;
      if (prefill.product_url)  document.getElementById("rf_product_url").value = prefill.product_url;

      /* ★ 065: 구매채널(상품 URL 호스트 판정) · 담당자(작업담당 매핑) 자동 선택.
         값이 없으면(판정 불가·랜덤) 아무것도 건드리지 않아 기존처럼 빈 상태로 남는다. */
      if (prefill.channel) _rfPickBtn("channel", prefill.channel);
      if (prefill.manager) _rfPickBtn("manager", prefill.manager);

      /* ★ 065: 연결 탭 자동 선택 — 접수 시 확정된 탭(work_sheet_url 은 제출 필수).
         탭 리네임 대비로 gid 우선 재매칭 후 이름 폴백. 미접수 오더는 값이 없어 그대로 수동. */
      _prefillLinkedTab(prefill);

      /* ★ 상품정보 기본값 = 작업오더 입력값(상품명·결제금액) — 자동수집(fetchProductInfo) 성공 항목만 이후 덮어씀 */
      if (prefill.product_name || prefill.price) {
        const nEl = document.getElementById("rf_product_name"), pEl = document.getElementById("rf_price");
        if (nEl && prefill.product_name) nEl.value = prefill.product_name;
        if (pEl && prefill.price)        pEl.value = prefill.price;
        const ppn = document.getElementById("rf_pp_name"), ppp = document.getElementById("rf_pp_price");
        if (ppn) ppn.textContent = prefill.product_name || "(상품명 없음)";
        if (ppp) ppp.textContent = prefill.price || "(가격 미확인)";
        const img = document.getElementById("rf_pp_img");
        if (img) { img.removeAttribute("src"); img.style.display = "none"; }
        const pp = document.getElementById("rf_product_preview");
        if (pp) pp.style.display = "flex";
      }
      /* ★ 상품확인용 URL이 있으면 자동수집 1회 시도 — 성공 항목만 덮어쓰고, 실패하면 위 기본값 유지 */
      if (prefill.product_url) setTimeout(() => { try { fetchProductInfo({ auto: true }); } catch (_) {} }, 0);

      /* ★ M3: 참여형 자동 프리필 — 작업오더 세부내용 → 발행 폼 스냅샷 (관리자는 확인·수정만) */
      if (prefill.participation && document.getElementById("rf_participation")) {
        const pe = document.getElementById("rf_participation");
        pe.checked = true; onParticipationToggle(true);
        const setV = (i, v) => { const el = document.getElementById(i); if (el && v != null && v !== "") el.value = v; };
        setV("rf_start_date", prefill.start_date);
        setV("rf_daily_limit", prefill.daily_limit);
        setV("rf_recruit_total", prefill.recruit_total);
        const t = _parsePurchaseTime(prefill.purchase_time || prefill.time_range || "");
        if (t) { setV("rf_window_start", t.start); setV("rf_window_end", t.end); }
        setV("rf_landing_url", prefill.landing_url);
        setV("rf_wd_product", prefill.wd_product);
        setV("rf_wd_review", prefill.wd_review);
        setV("rf_wd_notes", prefill.wd_notes);
        const ta = document.getElementById("rf_wd_inflow");
        if (prefill.wd_inflow_html && ta) {
          /* 유입가이드 원본 HTML(이미지 포함) 보존: textarea엔 미리보기 텍스트만, 저장 시 미수정이면 원본 그대로
             (textarea 경유 escape가 이미지·서식을 파괴하는 것 방지 — 수정하는 순간 평문 모드로 전환) */
          window._wdInflowRawHtml = prefill.wd_inflow_html;
          ta.value = _htmlToPlainPreview(prefill.wd_inflow_html);
          ta.dataset.rawHtml = "1";
          ta.addEventListener("input", () => { ta.dataset.rawHtml = ""; }, { once: true });
        } else if (prefill.wd_inflow_text) {
          setV("rf_wd_inflow", prefill.wd_inflow_text);
        }
        /* 🧩 작업오더 상품정보 → 진행상품 표: 옵션 배열이 있으면 그대로, 없으면 텍스트를 줄 단위로 분해 */
        applyProductRowsFromOrder(prefill);
        setV("rf_deadline", prefill.end_date || prefill.deadline);
        onRecruitDatesChange();
        renderPartCheck();
      }
    }
  }

  modal.classList.remove("hidden");
  modal.style.display = "";

  /* 미리보기 항상 자동 렌더링 */
  _previewOpen = true;
  _renderPreview();
  _attachPreviewListeners();
}

// 상품확인용 URL에서 썸네일/상품명/가격 가져오기 (OG/JSON-LD)
// opts.auto=true — 작업오더 프리필 직후 자동 1회 시도(조용한 실패 문구). 성공 "항목만" 덮어쓰고
// 실패·누락 항목은 기존 값(작업오더 기본값·직접 업로드 썸네일 등)을 유지한다.
async function fetchProductInfo(opts) {
  const auto = !!(opts && opts.auto);
  const url = (document.getElementById("rf_product_url").value || "").trim();
  if (!url) { if (!auto) showToast("상품 URL을 입력하세요.", true); return; }
  if (!/^https?:\/\//i.test(url)) { if (!auto) showToast("http(s):// 로 시작하는 URL을 입력하세요.", true); return; }
  showToast("상품 정보 가져오는 중...");
  try {
    const r = await gasPost({ action: "productPreview", url });
    const has = r && (r.thumbnail || r.name || r.price);
    const nEl = document.getElementById("rf_product_name");
    const pEl = document.getElementById("rf_price");
    if (has) {
      const img = document.getElementById("rf_pp_img");
      if (r.thumbnail) { img.src = r.thumbnail; img.style.display = ""; }
      else if (!img.getAttribute("src")) { img.style.display = "none"; }
      // ★ 리뷰 #10: 자동추출이 빈 값으로 직접 업로드 썸네일을 덮지 않게 + 미리보기 동기화
      if (r.thumbnail) {
        document.getElementById("rf_thumbnail").value = r.thumbnail;
        const _pv = document.getElementById("rf_thumb_preview");
        if (_pv) { _pv.src = r.thumbnail; _pv.style.display = ""; }
      }
      // ★ 성공 항목만 덮어씀 — 누락 항목은 작업오더 기본값 등 기존 값 유지
      if (r.name)  nEl.value = r.name;
      if (r.price) pEl.value = r.price;
      document.getElementById("rf_pp_name").textContent = nEl.value || "(상품명 없음)";
      document.getElementById("rf_pp_price").textContent = pEl.value || "(가격 미확인)";
      document.getElementById("rf_product_preview").style.display = "flex";
      // 공고 제목이 비어 있으면 상품명으로 채움
      const t = document.getElementById("rf_title");
      if (t && !t.value.trim() && r.name) { t.value = r.name; _renderPreview && _renderPreview(); }
      showToast((r.mall || "") + " 상품정보를 가져왔습니다.");
    } else {
      // 기존 값(작업오더 기본값)이 있으면 미리보기를 유지하고 안내만 — 없을 때만 기존처럼 숨김+수동입력 안내
      const hasBase = !!((nEl && nEl.value) || (pEl && pEl.value));
      if (!hasBase) document.getElementById("rf_product_preview").style.display = "none";
      showToast(hasBase
        ? "상품정보 자동수집 실패 — 작업오더에 입력된 상품명/가격을 유지합니다."
        : ((r && r.hint) || "상품 정보를 가져오지 못했습니다. 수동 입력하세요."), true);
    }
  } catch (e) {
    const nEl = document.getElementById("rf_product_name");
    const pEl = document.getElementById("rf_price");
    const hasBase = !!((nEl && nEl.value) || (pEl && pEl.value));
    showToast(hasBase ? "상품정보 자동수집 실패 — 작업오더에 입력된 상품명/가격을 유지합니다." : ("오류: " + e.message), true);
  }
}

function closeRecruitModal() {
  const modal = document.getElementById("recruitModal");
  modal.classList.add("hidden");
  modal.style.display = "none";
  _recruitEditId = null;
  _woPrefillOrderId = null;
}

/* ═══════════════════════════════════════
   채널/담당자 버튼 선택 (공통)
═══════════════════════════════════════ */
function selectRfBtn(group, btn) {
  /* 같은 그룹 버튼만 비활성화 */
  const container = btn.closest('#rf_channel_btns, #rf_manager_btns');
  if (container) {
    container.querySelectorAll('.rchan-btn').forEach(b => b.classList.remove('active'));
  } else {
    /* fallback: data-group 속성으로 구분 */
    document.querySelectorAll(`.rchan-btn[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
  }
  btn.classList.add('active');
  const val = btn.dataset.val;

  if (group === 'channel') {
    document.getElementById('rf_channel').value = val;
    const customInput = document.getElementById('rf_channel_custom');
    customInput.style.display = val === '직접입력' ? '' : 'none';
    if (val !== '직접입력') customInput.value = '';
  } else if (group === 'manager') {
    document.getElementById('rf_manager').value = val;
  }
}

function selectChannel(btn) { selectRfBtn('channel', btn); }  /* 하위 호환 */

/* ═══════════════════════════════════════
   배지 입력
═══════════════════════════════════════ */
function handleBadgeInput(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const inp = document.getElementById("rf_badge_input");
    const val = inp.value.trim();
    if (val && !_recruitBadges.includes(val)) {
      _recruitBadges.push(val);
      _refreshBadgeWrap();
    }
    inp.value = "";
  }
}

/* 추천 배지 클릭 → 바로 추가 (중복 방지) */
function addPresetBadge(val) {
  if (!val || _recruitBadges.includes(val)) return;
  _recruitBadges.push(val);
  _refreshBadgeWrap();
}

function removeBadge(idx) {
  _recruitBadges.splice(idx, 1);
  _refreshBadgeWrap();
}

function _refreshBadgeWrap() {
  const wrap = document.getElementById("rf_badges_wrap");
  const inp  = document.getElementById("rf_badge_input");
  /* 기존 칩만 제거 */
  wrap.querySelectorAll(".rbadge-chip").forEach(el => el.remove());
  _recruitBadges.forEach((b, i) => {
    const chip = document.createElement("span");
    chip.className = "rbadge-chip";
    chip.innerHTML = `${escHtml(b)}<button type="button" onclick="removeBadge(${i})" title="삭제"><i class="fas fa-times"></i></button>`;
    wrap.insertBefore(chip, inp);
  });
}

/* ═══════════════════════════════════════
   ⚡ M3: 썸네일 직접 업로드 (유입가이드 이미지 인프라 재사용 — Drive+무인증 프록시)
═══════════════════════════════════════ */
async function uploadCampThumb(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast("이미지는 5MB 이하로 올려주세요.", "error"); input.value = ""; return; }
  showToast("썸네일 업로드 중...");
  try {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const resp = await fetch(API_BASE_URL + "/api/order/guide-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ imageBase64: b64, mimeType: file.type || "image/jpeg", fileName: "campthumb_" + Date.now() }),
    });
    const j = await resp.json();
    if (!resp.ok || !j.ok || !j.url) throw new Error(j.error || "업로드 실패");
    // 절대 프록시 URL — 프론트(pages.dev)와 API(railway) 오리진이 달라 절대 URL이어야 카드에 뜬다
    document.getElementById("rf_thumbnail").value = j.url;
    const pv = document.getElementById("rf_thumb_preview");
    if (pv) { pv.src = j.url; pv.style.display = ""; }
    showToast("썸네일이 업로드되었습니다.", "success");
    _onPreviewInput();
  } catch (e) {
    showToast("썸네일 업로드 실패: " + e.message, "error");
  } finally {
    input.value = "";
  }
}

/* 쿠팡 봇차단 우회: 쿠팡 상품 HTML은 서버 fetch가 403이지만 이미지 CDN(coupangcdn.com)은 미차단.
   관리자가 브라우저에서 "이미지 주소 복사"한 CDN URL을 서버(guide-image imageUrl 분기)가 받아
   Drive 재저장 → 절대 프록시 URL. 허용 호스트 검증은 서버(utils/thumbFetch)가 강제. */
async function fetchCampThumbFromUrl() {
  const inp = document.getElementById("rf_thumb_url");
  const url = ((inp && inp.value) || "").trim();
  if (!url) { showToast("이미지 주소를 붙여넣으세요. (쿠팡 상품 이미지 우클릭 → 이미지 주소 복사)", "error"); return; }
  if (!/^https:\/\//i.test(url)) { showToast("https:// 로 시작하는 이미지 주소만 지원합니다.", "error"); return; }
  showToast("이미지 가져오는 중...");
  try {
    const resp = await fetch(API_BASE_URL + "/api/order/guide-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ imageUrl: url, fileName: "campthumb_" + Date.now() }),
    });
    const j = await resp.json();
    if (!resp.ok || !j.ok || !j.url) throw new Error(j.error || "이미지 수집 실패");
    // 절대 프록시 URL — 프론트(pages.dev)와 API(railway) 오리진이 달라 절대 URL이어야 카드에 뜬다
    document.getElementById("rf_thumbnail").value = j.url;
    const pv = document.getElementById("rf_thumb_preview");
    if (pv) { pv.src = j.url; pv.style.display = ""; }
    inp.value = "";
    showToast("썸네일이 등록되었습니다.", "success");
    _onPreviewInput();
  } catch (e) {
    showToast("썸네일 수집 실패: " + e.message, "error");
  }
}

/* ═══════════════════════════════════════
   ⚡ M3: 관제 패널 — 공고별 신청현황(오늘 홀드/제출/만료) + 수동확정
═══════════════════════════════════════ */
/* 리뷰 #5: 제목을 onclick 템플릿 리터럴로 넘기지 않는다(백틱·\${ 주입 벡터) — id로만 열고 제목은 캐시 조회 */
window._recruitCardTitles = window._recruitCardTitles || {};
function openCampControlById(campId) {
  return openCampControl(campId, window._recruitCardTitles[campId] || campId);
}
async function openCampControl(campId, title) {
  let ovl = document.getElementById("campControlOvl");
  if (!ovl) {
    ovl = document.createElement("div");
    ovl.id = "campControlOvl";
    ovl.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px";
    ovl.innerHTML = `<div style="background:#fff;border-radius:16px;max-width:680px;width:100%;max-height:86vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #E5E7EB">
        <b style="flex:1;font-size:.95rem" id="ccTitle"></b>
        <span id="ccStats" style="font-size:.74rem;color:#4B5563;font-weight:700"></span>
        <button id="ccMoBtn" title="카톡으로 모집한 외부 리뷰어의 구매양식을 대신 제출합니다" style="font-size:.72rem;font-weight:800;background:#E6FAF6;color:#0F766E;border:1px solid #9EE6D8;border-radius:8px;padding:5px 10px;cursor:pointer;white-space:nowrap">🧾 외부제출</button>
        <button onclick="document.getElementById('campControlOvl').remove()" style="background:none;border:none;font-size:1.1rem;cursor:pointer;color:#9CA3AF"><i class="fas fa-times"></i></button>
      </div>
      <div id="ccBody" style="overflow-y:auto;padding:12px 18px"></div>
    </div>`;
    ovl.addEventListener("click", e => { if (e.target === ovl) ovl.remove(); });
    document.body.appendChild(ovl);
  }
  document.getElementById("ccTitle").textContent = "📡 관제 — " + (title || campId);
  // 🧾 외부모집 수동제출 — 오버레이는 1회만 만들고 재사용하므로 공고가 바뀔 때마다 핸들러를 다시 건다
  // 연결 탭 문맥 해석은 campaign-cards.js 한 곳에만 둔다(사본을 두면 화면마다 다른 탭에 쓴다).
  // 그 모듈이 없는 화면(admin-siand)에서는 **버튼을 숨긴다** — 눌러도 안 되는 버튼보다 없는 게 낫다.
  const _moBtn = document.getElementById("ccMoBtn");
  if (_moBtn) {
    const _moReady = !!(window.CampCards && CampCards.openManualOrder && window.ManualOrder);
    _moBtn.style.display = _moReady ? "" : "none";
    _moBtn.onclick = () => CampCards.openManualOrder(campId);
  }
  document.getElementById("ccBody").innerHTML = `<div style="padding:30px;text-align:center;color:#9CA3AF"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>`;
  await _loadCampControl(campId);
}

/** 🧩 관제 옵션별 현황표(061 3단계): 옵션 뷰(정원·상태) + 신청행 기반 오늘 집계.
 *  옵션 미등록 캠페인은 빈 문자열(표 미노출). */
function _campOptionTable(options, rows, now, today, kstDay) {
  if (!options || !options.length) return "";
  const agg = {};
  (rows || []).forEach(r => {
    const k = r.option_key; if (!k) return;
    agg[k] = agg[k] || { todayHold: 0, todaySub: 0, cumSub: 0 };
    const isToday = r.applied_at && kstDay(Date.parse(r.applied_at)) === today;
    const holdValid = r.status === "applied" && r.expires_at && Date.parse(r.expires_at) > now;
    if (r.status === "submitted") agg[k].cumSub++;
    if (isToday && holdValid) agg[k].todayHold++;
    if (r.status === "submitted" && r.submitted_at && kstDay(Date.parse(r.submitted_at)) === today) agg[k].todaySub++;
  });
  const escT = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const stTxt = { open: ["진행중", "#065F46", "#D1FAE5"], soldout: ["마감", "#B91C1C", "#FEE2E2"], today_done: ["오늘마감", "#92400E", "#FEF3C7"], closed: ["마감", "#6B7280", "#F3F4F6"] };
  const th = t => `<th style="text-align:${t.a || "left"};font-weight:800;color:#6B7280;padding:5px 8px;border-bottom:1px solid #E5E7EB;white-space:nowrap">${t.l}</th>`;
  const td = (v, a) => `<td style="text-align:${a || "left"};padding:5px 8px;border-bottom:1px solid #F3F4F6;white-space:nowrap">${v}</td>`;
  const body = options.map(o => {
    const a = agg[o.optKey] || { todayHold: 0, todaySub: 0, cumSub: 0 };
    const s = stTxt[o.status] || stTxt.open;
    const rt = o.recruitTotal ? o.recruitTotal + "명" : "무제한";
    const pay = o.payAmount ? Number(o.payAmount).toLocaleString() + "원" : "-";
    return `<tr>${td("<b>" + escT(o.optKey) + "</b>")}${td(pay, "right")}${td(String(a.todayHold), "center")}${td(String(a.todaySub), "center")}${td(String(a.cumSub), "center")}${td(rt, "center")}${td(`<span style="font-size:.62rem;font-weight:800;background:${s[2]};color:${s[1]};border-radius:6px;padding:2px 7px">${s[0]}</span>`, "center")}</tr>`;
  }).join("");
  return `<div style="margin:2px 0 12px">
    <div style="font-size:.74rem;font-weight:800;color:#5B21B6;margin-bottom:5px">🧩 옵션별 현황</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.72rem">
      <thead><tr>${th({ l: "옵션" })}${th({ l: "금액", a: "right" })}${th({ l: "오늘 진행중", a: "center" })}${th({ l: "오늘 제출", a: "center" })}${th({ l: "누적 확정", a: "center" })}${th({ l: "정원", a: "center" })}${th({ l: "상태", a: "center" })}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
}

/** 👥 소유자별 묶음표(063 3단계): 타계정 건이 있는 소유자만 노출(본계정 단독 참여자는 기존 목록으로 충분).
 *  묶음 키 = owner_phone8(서버 파생). 이름은 그 소유자의 본계정 행(phone8===owner_phone8)에서 취하고,
 *  없으면(타계정만 참여) 뒤4자리로 표기. 옵션표와 동일한 표 문법. */
function _campOwnerTable(rows, now) {
  const groups = {};
  (rows || []).forEach(r => {
    const owner = String(r.owner_phone8 || "");
    if (!owner) return;                       // 레거시 행(귀속 없음) — 묶음 대상 아님
    const g = groups[owner] || (groups[owner] = { owner, selfName: "", total: 0, sub: 0, hold: 0, submitted: 0 });
    const isSub = String(r.phone8) !== owner;
    if (!isSub && r.applicant_name) g.selfName = r.applicant_name;
    g.total++;
    if (isSub) g.sub++;
    if (r.status === "applied" && r.expires_at && Date.parse(r.expires_at) > now) g.hold++;
    if (r.status === "submitted") g.submitted++;
  });
  const list = Object.values(groups).filter(g => g.sub > 0).sort((a, b) => b.total - a.total);
  if (!list.length) return "";
  const escT = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const th = t => `<th style="text-align:${t.a || "left"};font-weight:800;color:#6B7280;padding:5px 8px;border-bottom:1px solid #E5E7EB;white-space:nowrap">${t.l}</th>`;
  const td = (v, a) => `<td style="text-align:${a || "left"};padding:5px 8px;border-bottom:1px solid #F3F4F6;white-space:nowrap">${v}</td>`;
  const body = list.map(g => {
    const who = g.selfName ? escT(g.selfName) : "(타계정만)";
    return `<tr>${td(`<b>${who}</b> <span style="color:#9CA3AF;font-size:.66rem">***${g.owner.slice(-4)}</span>`)}${td(String(g.total), "center")}${td(String(g.sub), "center")}${td(String(g.hold), "center")}${td(String(g.submitted), "center")}</tr>`;
  }).join("");
  return `<div style="margin:2px 0 12px">
    <div style="font-size:.74rem;font-weight:800;color:#7C3AED;margin-bottom:5px">👥 타계정 묶음 (본계정 기준)</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.72rem">
      <thead><tr>${th({ l: "본계정" })}${th({ l: "총 건수", a: "center" })}${th({ l: "타계정 건", a: "center" })}${th({ l: "진행중", a: "center" })}${th({ l: "제출확정", a: "center" })}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
}

/** 확정으로 안 잡힌 시트 행 목록 — "몇 행의 누구"인지 바로 짚어준다.
 *  ★ 캠페인 정원은 '위치'가 아니라 '숫자'(총원 − 확정)로 계산된다. 이 목록은 그 차이가
 *    시트의 어느 줄에서 비롯됐는지 찾아주는 것이지, 시스템이 그 줄을 비었다고 보는 게 아니다. */
function _campUnmatchedRows(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = list.slice(0, 30).map(u =>
    `<span style="display:inline-block;background:#fff;border:1px solid #FDE68A;border-radius:6px;padding:2px 7px;margin:2px 3px 0 0;font-size:.7rem">`
    + `<b>${u.row != null ? u.row + "행" : "행?"}</b> ${esc(u.name) || "(이름 없음)"}`
    + (u.noPhone ? ` <span style="color:#B45309">연락처 없음</span>` : ` <span style="color:#9CA3AF">***${esc(u.phone4)}</span>`)
    + `</span>`).join("");
  return `<div style="margin-top:5px">`
    + `<div style="font-size:.7rem;color:#92400E;font-weight:800;margin-bottom:2px">확정으로 안 잡힌 시트 행</div>`
    + items
    + `<div style="color:#9CA3AF;font-size:.66rem;margin-top:3px">연락처(끝 8자리)로 대조합니다. 연락처가 비어 있는 행은 대조가 불가능해 항상 여기에 나옵니다.</div>`
    + `</div>`;
}

/** 📋 시트 대조 카드(관제) — 연결 탭의 로스터 행 수 vs 확정 수, 그리고 시트 일정 적용 여부·사유.
 *  ★ 관측 전용이다. 여기 표시된 값이 캠페인 상태를 바꾸지 않는다(자동 종료 없음). */
function _campSheetInfo(si) {
  if (!si) return "";
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const box = (bg, bd, html) => `<div style="margin:2px 0 12px;background:${bg};border:1px solid ${bd};border-radius:10px;padding:10px 12px;font-size:.74rem;line-height:1.65">${html}</div>`;
  const md = d => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d || ""); return m ? `${+m[1]}/${+m[2]}` : (d || ""); };

  const parts = [];
  // ① 로스터 대조 — 차이가 있으면 그 수만큼 "시트엔 있는데 확정이 아닌 자리"다
  if (si.rosterRows > 0) {
    const diff = Number(si.diff) || 0;
    parts.push(`<b>시트 로스터</b> ${si.rosterRows}행 · <b>확정</b> ${si.confirmed}건`
      + (diff > 0
        ? ` → <span style="color:#B45309;font-weight:800">차이 ${diff}건</span>`
          + `<div style="color:#6B7280;font-size:.7rem">시트에는 자리가 있는데 확정으로 안 잡힌 건입니다. 만료·취소 목록에서 기구매(🛍) 건을 찾아 [수동확정]하거나, 직원이 직접 입력한 행인지 확인하세요.</div>`
          + _campUnmatchedRows(si.unmatched)
        : diff < 0
          ? ` → <span style="color:#B45309;font-weight:800">확정이 ${-diff}건 더 많음</span>`
            + `<div style="color:#6B7280;font-size:.7rem">시트 반영이 아직 안 됐거나(큐 대기) 로스터 행이 지워졌을 수 있습니다.</div>`
          : ` <span style="color:#065F46;font-weight:800">✓ 일치</span>`));
  }
  // ② 시트 일정 적용 여부 — 미적용이면 왜인지(하루 완결·미러 미도달 등)
  const s = si.schedule;
  if (s) {
    const why = {
      applied: null,
      single_date: `시트 날짜가 <b>${esc(md(s.firstDate))} 하루</b>뿐이라 <b>시트 일정이 적용되지 않습니다</b>(날짜 2종 이상일 때만 인식). 마감은 발행폼의 총 모집인원으로 판정됩니다.`,
      no_parsable_date: "날짜 컬럼의 값을 해석하지 못해 시트 일정이 적용되지 않습니다.",
      low_parse_ratio: "날짜 컬럼에 해석 불가한 값이 많아 시트 일정이 적용되지 않습니다.",
      no_date_column: "연결 탭에서 날짜 컬럼(구매일자·시작일 등)을 찾지 못했습니다.",
      no_mirror: "이 탭이 아직 미러링되지 않았습니다(최대 5분). 잠시 후 다시 확인하세요.",
      no_tab: "연결된 탭 정보가 없습니다.",
      error: "시트 일정 조회 중 오류가 발생했습니다.",
    }[s.reason];
    if (s.applied) {
      parts.push(`<b>시트 일정</b> 적용 중 · ${esc(md(s.firstDate))} ~ ${esc(md(s.lastDate))} · 날짜 ${s.distinctDates}종 / ${s.totalDated}행`);
    } else if (why) {
      parts.push(`<b>시트 일정</b> <span style="color:#B45309;font-weight:800">미적용</span> — ${why}`
        + (s.distinctDates ? `<div style="color:#6B7280;font-size:.7rem">인식된 날짜: ${s.dates.map(d => esc(md(d.date)) + "(" + d.rows + "행)").join(" · ")}</div>` : ""));
    }
  }
  if (!parts.length) return "";
  const warn = (Number(si.diff) || 0) !== 0 || (s && !s.applied);
  return box(warn ? "#FFFBEB" : "#F0FDF4", warn ? "#FDE68A" : "#BBF7D0",
    `<div style="font-weight:800;color:${warn ? "#92400E" : "#065F46"};margin-bottom:4px">📋 시트 대조 — ${esc(si.tabName)}</div>` + parts.join('<div style="height:6px"></div>'));
}

async function _loadCampControl(campId) {
  const body = document.getElementById("ccBody");
  const stats = document.getElementById("ccStats");
  try {
    const res = await fetch(_campApi(`/${encodeURIComponent(campId)}/applications`), { headers: _getAuthHeaders() });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
    const rows = j.data || [];
    // 오늘(KST) 집계 — 유효홀드는 시각 기준(만료시각 경과분은 만료로 분류)
    const now = Date.now();
    const kstDay = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const today = kstDay(now);
    let holds = 0, subs = 0, exps = 0;
    const items = rows.filter(r => ["applied", "submitted", "expired", "cancelled"].includes(r.status));
    items.forEach(r => {
      const isToday = r.applied_at && kstDay(Date.parse(r.applied_at)) === today;
      const holdValid = r.status === "applied" && r.expires_at && Date.parse(r.expires_at) > now;
      if (!isToday) return;
      if (holdValid) holds++;
      else if (r.status === "submitted") subs++;
      else if (r.status === "expired" || (r.status === "applied" && !holdValid)) exps++;
    });
    // 👥 타계정(063): 명의 phone8 ≠ 소유자 phone8 = 타계정 건. 오늘 타계정 건수도 함께 표기.
    const _isSubRow = r => !!(r.owner_phone8 && String(r.owner_phone8) !== String(r.phone8));
    const todaySubCnt = items.filter(r => r.applied_at && kstDay(Date.parse(r.applied_at)) === today && _isSubRow(r)).length;
    if (stats) stats.textContent = `오늘 · 진행중 ${holds} / 제출 ${subs} / 만료 ${exps}` + (todaySubCnt ? ` / 타계정 ${todaySubCnt}` : "");
    // 🧩 옵션별 현황표(061 3단계) — 옵션 등록 캠페인만
    const optTableHtml = _campOptionTable(j.options || [], items, now, today, kstDay);
    // 👥 타계정 묶음(063): 소유자별 건수 — "한 리뷰어가 실제 몇 건 진행 중인가"를 즉시 파악(사재기 관측)
    const ownerTableHtml = _campOwnerTable(items, now);
    // 📋 시트 대조 — "시트엔 100행인데 확정 99" / "하루 완결이라 시트 일정 미적용"을 여기서 확인
    const sheetHtml = _campSheetInfo(j.sheetInfo);
    if (!items.length) {
      body.innerHTML = sheetHtml + optTableHtml + `<div style="padding:30px;text-align:center;color:#9CA3AF">참여 이력이 없습니다.</div>`;
      return;
    }
    const chip = (bg, fg, tx) => `<span style="font-size:.66rem;font-weight:800;background:${bg};color:${fg};border-radius:6px;padding:2px 8px;white-space:nowrap">${tx}</span>`;
    const fmtT = iso => iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    body.innerHTML = sheetHtml + optTableHtml + ownerTableHtml + items.sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at)).map(r => {
      const holdValid = r.status === "applied" && r.expires_at && Date.parse(r.expires_at) > now;
      const dismissed = !!r.dismissed_at;   // 취소확정(미참여) — 종료 마커
      let st;
      if (r.status === "submitted") st = chip("#D1FAE5", "#065F46", "✓ 제출확정");
      else if (holdValid) st = chip("#FEF3C7", "#92400E", "⏳ 진행중");
      else if (dismissed) st = chip("#E5E7EB", "#4B5563", "🚫 취소확정");
      else if (r.status === "cancelled") st = chip("#F3F4F6", "#6B7280", "취소");
      else st = chip("#FEE2E2", "#B91C1C", "구매시간만료");
      const late = r.late_order_id ? chip("#EDE9FE", "#5B21B6", "🛍 기구매 제출 있음") : "";
      // 👥 063: 명의 구분 — 타계정 건은 소유자(본계정) 뒤4자리를 함께 표기(묶음 추적)
      const acct = _isSubRow(r) ? chip("#F1EAFE", "#7C3AED", "타 · 본계정 ***" + String(r.owner_phone8).slice(-4)) : "";
      // ★ 리뷰 #4: 확정 버튼은 만료·취소 건만(서버 의도 = 기구매 구제 경로).
      //   진행중(applied)은 확정 시 주문 링크가 영구 결번되므로 버튼 미노출(정상 제출 경로로 확정되게 둠).
      //   취소확정(dismissed)된 건은 종료 처리라 버튼을 다시 띄우지 않는다("다시 알림 안 뜸").
      const canConfirm = (r.status === "expired" || r.status === "cancelled") && !dismissed;
      const escT = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const cid = String(campId).replace(/[^a-z0-9_]/gi, "");
      const aid = parseInt(r.id, 10);
      // 제출확정(구매완) = 실제 구매 확인 → 자리 확정 / 취소확정(미참여) = 종료 처리(이후 숨김)
      const actions = canConfirm ? `<span style="display:inline-flex;gap:6px;flex-shrink:0">
          <button onclick="campManualConfirm('${cid}',${aid},${r.late_order_id ? 1 : 0})" title="구매 완료 확인 → 자리 확정(카운터·모집 잔여 즉시 반영)" style="font-size:.7rem;font-weight:800;background:#e8f1fe;color:#1b64da;border:1px solid #a6c8fb;border-radius:7px;padding:4px 9px;cursor:pointer;white-space:nowrap">✅ 제출확정<span style="font-weight:600;opacity:.72"> ·구매완</span></button>
          <button onclick="campDismiss('${cid}',${aid})" title="미참여로 취소 확정 → 이후 관제·알림에서 숨김" style="font-size:.7rem;font-weight:800;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;border-radius:7px;padding:4px 9px;cursor:pointer;white-space:nowrap">🚫 취소확정<span style="font-weight:600;opacity:.72"> ·미참여</span></button>
        </span>` : "";
      return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:9px 4px;border-bottom:1px solid #F3F4F6;font-size:.8rem">
        <b style="min-width:64px">${escT(r.applicant_name)}</b>
        <span style="color:#9CA3AF;font-size:.7rem">***${String(r.phone8 || "").replace(/\D/g, "").slice(-4)}</span>
        ${st}${late}${acct}
        <span style="margin-left:auto;color:#9CA3AF;font-size:.68rem">신청 ${fmtT(r.applied_at)}${r.expires_at ? " · 마감 " + fmtT(r.expires_at) : ""}</span>
        ${actions}
      </div>`;
    }).join("");
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;text-align:center;color:#DC2626">불러오기 실패: ${String(e.message).replace(/</g, "&lt;")}</div>`;
  }
}

async function campManualConfirm(campId, appId, hasLate) {
  const msg = hasLate
    ? "이 신청을 수동 확정할까요?\n(만료 후 도착한 구매 제출이 있어요 — 카운터에 즉시 반영됩니다)"
    : "⚠️ 연결된 구매 제출이 없는 신청이에요.\n실제 구매를 먼저 확인하셨나요? 확정하면 카운터·모집 잔여가 즉시 소진됩니다.";
  if (!confirm(msg)) return;
  try {
    const res = await fetch(_campApi(`/${encodeURIComponent(campId)}/confirm`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ applicationId: appId }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
    showToast(j.already ? "이미 확정된 신청입니다." : "제출확정되었습니다.", "success");
    await _loadCampControl(campId);
  } catch (e) {
    showToast("제출확정 실패: " + e.message, "error");
  }
}

// 취소확정(미참여) — 만료·취소 건을 종료 처리. 이후 관제 버튼·지각 배지·만료 집계에서 숨겨진다.
async function campDismiss(campId, appId) {
  if (!confirm("이 참여를 '미참여'로 취소 확정할까요?\n확정하면 이후 관제·알림에서 숨겨집니다. (실제로 구매한 건이면 대신 [제출확정]을 누르세요.)")) return;
  try {
    const res = await fetch(_campApi(`/${encodeURIComponent(campId)}/dismiss`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ applicationId: appId }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
    showToast(j.already ? "이미 취소확정된 신청입니다." : "취소 확정되었습니다.", "success");
    await _loadCampControl(campId);
  } catch (e) {
    showToast("취소확정 실패: " + e.message, "error");
  }
}

/* ═══════════════════════════════════════
   공고 저장 (등록 / 수정)
═══════════════════════════════════════ */
async function saveRecruitPost() {
  const title    = document.getElementById("rf_title").value.trim();
  const channel  = document.getElementById("rf_channel").value.trim();
  const manager  = document.getElementById("rf_manager").value.trim();
  const chatUrl  = document.getElementById("rf_chat_url").value.trim();
  if (!title)   { showToast("공고 제목을 입력해주세요.", "error"); return; }
  if (!channel) { showToast("구매채널을 선택해주세요.", "error"); return; }

  const tabKey      = document.getElementById("rf_linked_tab").value || "";
  const [sid, tab]  = tabKey ? tabKey.split("||") : ["", ""];
  const tabMeta     = _recruitTabList.find(x => x.key === tabKey);

  const payload = {
    title,
    manager,
    channel,
    channel_custom: document.getElementById("rf_channel_custom").value.trim(),
    time_range:     document.getElementById("rf_time_range").value.trim(),
    delivery_type:  document.getElementById("rf_delivery_type").value,
    review_fee:     Number(document.getElementById("rf_review_fee").value) || 0,
    badges:         _recruitBadges,
    notes:          document.getElementById("rf_notes").value.trim(),
    chat_url:       chatUrl,
    linked_sheet_id: sid,
    linked_tab_name: tab,
    linked_tab_gid:  (tabMeta && tabMeta.tabGid) || "",
    max_slots:      Number(document.getElementById("rf_max_slots").value) || 0,
    status:         document.getElementById("rf_status").value,
    // 종료일 — 시트 일정과 다르면 화면에 경고가 뜨고 실제 모집은 시트를 따른다(참고값으로 보관)
    deadline:       document.getElementById("rf_deadline")?.value || null,
    // ★ 064: 노출 순서 UI 제거 — 정렬은 별표(pinned_at)가 담당. 서버가 미전송을 0으로 강제하므로
    //   기존값 보존을 위해 편집 모드에선 로드값을 재전송(신규는 0).
    sort_order:     Number(document.getElementById("rf_sort_order")?.value ?? (window._recruitEditLoaded?.sort_order ?? 0)) || 0,
    // 작업오더 프리필로 만든 신규 공고면 정방향 링크(source_work_order_id) 즉시 기록 —
    // work-detail 유입방식 역조회의 보조키(주: linked_campaign_id). 편집 시엔 미전송=COALESCE 유지.
    source_work_order_id: (!_recruitEditId && _woPrefillOrderId) ? _woPrefillOrderId : undefined,
  };

  /* ⚡ 참여형(M2): 설정·작업내용 스냅샷 포함 + 게시 전 자동 점검(서버 게이트와 동일 3항목)
     ★ B1 가드: rf_participation 요소가 "존재하는 화면"에서만 전송 —
       참여형 UI가 없는 페이지(admin-siand.html 등)나 편집 로드 실패 시엔 미전송(undefined)
       → 서버 COALESCE가 기존값 유지 = 참여형 공고의 레거시 강등 사고 차단. */
  const partEl = document.getElementById("rf_participation");
  if (partEl && !(window._recruitEditLoadFailed && _recruitEditId)) {
    const isPart = !!partEl.checked;
    payload.participation_mode = isPart;
    if (isPart) {
      if (payload.status === "active") {
        const errs = participationCheckErrors();
        if (errs.length) { showToast("참여형 게시 불가: " + errs[0], "error"); renderPartCheck(); return; }
      }
      /* ★ 062: ""=서버에서 비움(자율주문 전환·시작일 제거), 값=설정 — null(유지)은 미전송 화면(admin-siand)만 */
      payload.start_date     = document.getElementById("rf_start_date")?.value || "";
      payload.window_start   = document.getElementById("rf_window_start").value || "";
      payload.window_end     = document.getElementById("rf_window_end").value || "";
      _syncPreviewFromOptRows();   // 표가 진실원본 — 저장 직전 파생값(상품 원문·정원) 최신화
      payload.daily_limit    = Number(document.getElementById("rf_daily_limit").value) || 0;
      payload.recruit_total  = Number(document.getElementById("rf_recruit_total").value) || 0;
      payload.hold_ttl_min   = Number(document.getElementById("rf_hold_ttl").value) || 15;
      /* 👥 타계정 참여(063) — ★ 토글 UI 있는 페이지에서만 전송(없으면 미전송=서버 COALESCE 기존값 유지,
         옵션표·work_detail과 동일 원칙: 축약 화면 저장이 설정을 조용히 끄지 않게) */
      if (document.getElementById("rf_multi_account")) {
        payload.multi_account_mode = !!document.getElementById("rf_multi_account").checked;
        payload.multi_daily_limit  = Math.max(0, parseInt(document.getElementById("rf_multi_daily")?.value, 10) || 0);
        payload.sub_hold_ttl_min   = Math.max(1, parseInt(document.getElementById("rf_sub_ttl")?.value, 10) || 10);
      }
      const _cbRaw = document.getElementById("rf_close_buffer").value;
      payload.close_buffer_min = _cbRaw === "" ? 10 : Math.max(0, parseInt(_cbRaw, 10) || 0);
      payload.landing_url    = document.getElementById("rf_landing_url").value.trim();
      payload.thumbnail_url  = document.getElementById("rf_thumbnail")?.value || "";
      // 평문 입력 → HTML 저장: escape 후 개행만 <br> (S3 — sanitize가 '<옵션>' 같은 텍스트를 태그로 오인해 삭제하는 것 방지)
      // ★ M3: 작업오더 프리필/리치 저장본은 미수정 시 원본 그대로 전송(이미지 보존 — 서버가 sanitize)
      const _escT = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const _inflowTa = document.getElementById("rf_wd_inflow");
      const _useRawInflow = _inflowTa && _inflowTa.dataset.rawHtml === "1" && window._wdInflowRawHtml;
      // ★ M3 리뷰 #3: escape 모드로 전환된 경우 미리보기 아티팩트("※ 이미지 …", [이미지]) 정리 + 이미지 소실 경고
      let _inflowPlain = _inflowTa.value.replace(/\n*※ 이미지 \d+장 포함[^\n]*$/m, "").trim();
      if (!_useRawInflow && window._wdInflowRawHtml && /<img/i.test(window._wdInflowRawHtml)) {
        if (!confirm("유입가이드를 수정하셨어요 — 원본에 있던 이미지가 빠진 평문으로 게시됩니다. 계속할까요?")) return;
        _inflowPlain = _inflowPlain.replace(/\[이미지\]/g, "").replace(/\n{3,}/g, "\n\n").trim();
      }
      payload.work_detail = {
        productLines:    document.getElementById("rf_wd_product").value.trim(),
        inflowGuideHtml: _useRawInflow ? window._wdInflowRawHtml
                                       : _escT(_inflowPlain).replace(/\n/g, "<br>"),
        reviewGuide:     document.getElementById("rf_wd_review").value.trim(),
        specialNotes:    document.getElementById("rf_wd_notes").value.trim(),
      };
      // 🧩 상품 옵션(061): 옵션표 전체를 교체 배열로 전송(빈 배열=옵션 없음). 중복 옵션명은 하드블록(서버 유니크).
      //   ★ 옵션표 UI가 있는 페이지에서만 전송 — 옵션표 없는 페이지(admin-siand 등)는 미전송(undefined)→
      //     서버가 기존 옵션 유지(옵션 소실 방지, work_detail 가드와 동일 원칙). (이 지점은 저장 버튼 비활성화 전)
      if (document.getElementById("rf_opt_rows")) {
        const _optChk = (typeof _optSummary === "function") ? _optSummary() : { dup: false };
        if (_optChk.dup) { showToast("옵션명이 중복됐어요. 옵션명을 다르게 하거나 삭제해주세요.", "error"); renderPartCheck(); return; }
        payload.options = readOptRows();
      }
    }
  }

  const btn = document.getElementById("recruitSaveBtn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 저장 중...';

  try {
    let res;
    if (_recruitEditId) {
      res = await fetch(_campApi(`/${_recruitEditId}`), {
        method: "PUT",
        headers: {"Content-Type":"application/json", ..._getAuthHeaders()},
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(_campApi("/create"), {
        method: "POST",
        headers: {"Content-Type":"application/json", ..._getAuthHeaders()},
        body: JSON.stringify(payload)
      });
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "저장 실패 (HTTP " + res.status + ")");
    }
    const saved = await res.json().catch(() => ({}));
    const newCampId = saved && saved.data && saved.data.id;
    /* ★ 작업오더에서 프리필로 만든 신규 공고면 → 그 오더에 linked_campaign_id 역연결 */
    if (!_recruitEditId && _woPrefillOrderId && newCampId) {
      // gasGet 은 실패 시 throw 하지 않고 {error} 를 반환하므로 결과를 명시적으로 검사
      try {
        const linkRes = await gasGet({ action: "orderAdminUpdate", id: _woPrefillOrderId, linked_campaign_id: newCampId });
        if (linkRes && linkRes.error) {
          showToast("공고는 등록됐으나 작업오더 연결에 실패했습니다. 인박스에서 다시 연결해주세요.", "error");
        }
      } catch(_) {
        showToast("공고는 등록됐으나 작업오더 연결 중 오류가 발생했습니다.", "error");
      }
      try { if (typeof loadWorkOrders === "function") loadWorkOrders(); } catch(_) {}
    }
    _woPrefillOrderId = null;
    showToast(_recruitEditId ? "공고가 수정되었습니다." : "공고가 등록되었습니다.", "success");
    closeRecruitModal();
    loadRecruitList();
  } catch(e) {
    showToast("저장 오류: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> 저장';
  }
}

/* ═══════════════════════════════════════
   공고 삭제
═══════════════════════════════════════ */
async function deleteRecruitPost(id, title) {
  if (!confirm(`"${title}" 공고를 삭제할까요?`)) return;
  try {
    const res = await fetch(_campApi(`/${id}`), {
      method: "DELETE",
      headers: _getAuthHeaders()
    });
    if (!res.ok) throw new Error("삭제 실패");
    showToast("공고가 삭제되었습니다.", "success");
    loadRecruitList();
  } catch(e) {
    showToast("삭제 실패: " + e.message, "error");
  }
}

/* ═══════════════════════════════════════
   공통 설정 모달
═══════════════════════════════════════ */
async function openRecruitSettingsModal() {
  const modal = document.getElementById("recruitSettingsModal");
  /* 기존 설정 로드 */
  try {
    const res  = await fetch("tables/app_settings?limit=30");
    const json = await res.json();
    const rows = json.data || [];
    const get  = key => (rows.find(r => r.key === key) || {}).value || "";
    document.getElementById("rs_page_title").value       = get("recruit_page_title");
    document.getElementById("rs_kakao_mandu").value      = get("kakao_id_mandu");
    document.getElementById("rs_kakao_mango").value      = get("kakao_id_mango");
    document.getElementById("rs_payment_schedule").value = get("payment_schedule");
  } catch(e) {
    console.warn("[settings] 로드 실패", e);
  }
  modal.classList.remove("hidden");
  modal.style.display = "";
}

function closeRecruitSettings() {
  const modal = document.getElementById("recruitSettingsModal");
  modal.classList.add("hidden");
  modal.style.display = "none";
}

async function saveRecruitSettings() {
  const updates = [
    { key: "recruit_page_title", value: document.getElementById("rs_page_title").value.trim() },
    { key: "kakao_id_mandu",     value: document.getElementById("rs_kakao_mandu").value.trim() },
    { key: "kakao_id_mango",     value: document.getElementById("rs_kakao_mango").value.trim() },
    { key: "payment_schedule",   value: document.getElementById("rs_payment_schedule").value.trim() }
  ];
  try {
    /* 기존 레코드 조회 후 PATCH, 없으면 POST */
    const res  = await fetch("tables/app_settings?limit=30");
    const json = await res.json();
    const rows = json.data || [];

    for (const u of updates) {
      const exist = rows.find(r => r.key === u.key);
      if (exist) {
        await fetch(`tables/app_settings/${exist.id}`, {
          method: "PATCH",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ value: u.value })
        });
      } else {
        await fetch("tables/app_settings", {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify(u)
        });
      }
    }
    showToast("설정이 저장되었습니다.", "success");
    closeRecruitSettings();
  } catch(e) {
    showToast("설정 저장 실패: " + e.message, "error");
  }
}

/* ═══════════════════════════════════════
   실시간 미리보기 기능
═══════════════════════════════════════ */
let _previewOpen = true;
let _previewDebounce = null;

function toggleRecruitPreview() {
  /* 미리보기 항상 열림 — 호환성을 위해 빈 함수 유지 */
}

/* 폼 값으로 미리보기 카드 렌더 */
function _renderPreview() {
  const card = document.getElementById("rf_preview_card");
  if (!card || !window.CampWorkDetail) return;

  /* ★ 리뷰어가 참여 후 실제로 보는 화면을 그대로 그린다 — campaign.html과 같은 공용 렌더러
     (js/campaign-workdetail.js)를 쓰므로 미리보기와 실제 화면이 어긋날 수 없다.
     따로 만든 모형 카드는 실물과 계속 달라져서 제거했다. */
  const _v = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ""; };

  // 유입가이드: 원본 HTML(이미지 포함)을 보존 중이면 그것을, 아니면 textarea 평문을 escape해서.
  const inflowTa = document.getElementById("rf_wd_inflow");
  const useRaw = inflowTa && inflowTa.dataset.rawHtml === "1" && window._wdInflowRawHtml;
  const inflowHtml = useRaw
    ? window._wdInflowRawHtml
    : escHtml(_v("rf_wd_inflow")).replace(/\n/g, "<br>");

  // 시간 표기가 있으면 홀드 타이머 대신 실제 TTL을 보여준다(참여 후 화면의 상단 바)
  const ttlEl = document.getElementById("rf_prev_ttl");
  if (ttlEl) {
    const ttl = Number(_v("rf_hold_ttl")) || 15;
    ttlEl.textContent = String(ttl).padStart(2, "0") + ":00";
  }

  CampWorkDetail.renderInto(card, {
    workDetail: {
      productLines:    _v("rf_wd_product"),
      inflowGuideHtml: inflowHtml,
      reviewGuide:     _v("rf_wd_review"),
      specialNotes:    _v("rf_wd_notes"),
    },
    landingUrl: _v("rf_landing_url"),
    inflowType: "",                 // 불명 = 랜딩 버튼 노출(실제 화면과 동일한 기본값)
  }, { showOption: false, apiBase: (typeof API_BASE_URL !== "undefined" ? API_BASE_URL : "") });

  /* 전체 흐름(참여 전 → 작업가이드 → 제출완료)은 실제 리뷰어 페이지를 새 탭으로 —
     campaign.html?preview=1 경로 유지. 편집 중 + 참여형일 때만 노출. */
  const _pvBtn = document.getElementById("rf_preview_full");
  if (_pvBtn) {
    const _part = document.getElementById("rf_participation");
    _pvBtn.style.display = (_recruitEditId && _part && _part.checked) ? "" : "none";
    _pvBtn.onclick = () => openReviewerPreview(_recruitEditId);
  }
}

/* 입력 이벤트 리스너 (debounce) */
/* 미리보기는 "참여 후 작업내용 화면"이므로 작업내용 필드가 바뀔 때 다시 그린다
   (제목·리뷰비 등 카드용 필드는 이 화면에 안 나오므로 대상에서 제외). */
const _PREVIEW_INPUTS = ["rf_wd_product","rf_wd_inflow","rf_wd_review","rf_wd_notes","rf_landing_url","rf_hold_ttl"];
const _PREVIEW_SELECTS = [];

function _onPreviewInput() {
  if (!_previewOpen) return;
  clearTimeout(_previewDebounce);
  _previewDebounce = setTimeout(_renderPreview, 120);
}

function _attachPreviewListeners() {
  _PREVIEW_INPUTS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", _onPreviewInput);
  });
  _PREVIEW_SELECTS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", _onPreviewInput);
  });
}

function _detachPreviewListeners() {
  _PREVIEW_INPUTS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.removeEventListener("input", _onPreviewInput);
  });
  _PREVIEW_SELECTS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.removeEventListener("change", _onPreviewInput);
  });
}

/* 배지/채널/담당자 변경 시에도 미리보기 갱신 */
const _origSelectRfBtn = selectRfBtn;
selectRfBtn = function(group, btn) {
  _origSelectRfBtn(group, btn);
  _onPreviewInput();
};

const _origRefreshBadgeWrap = _refreshBadgeWrap;
_refreshBadgeWrap = function() {
  _origRefreshBadgeWrap();
  _onPreviewInput();
};
