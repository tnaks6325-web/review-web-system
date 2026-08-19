/**
 * 공고 관리 API 베이스 — 화면마다 도달 가능한 경로가 다르다.
 *   · 관리자 대시보드 : /api/campaign/admin      (adminOrMaster)
 *   · 리뷰웹시스템[3버전]     : /api/trackb/campaigns    (내부인 열람 + 편집명단 게이트, 같은 핸들러에 위임)
 * ★ 두 네임스페이스는 **경로 모양이 동일**해서 베이스 문자열만 갈아끼우면 된다 —
 *   이 파일을 포크하지 않고 두 화면이 같은 발행·수정 로직을 쓰는 유일한 방법.
 */
function _campApi(path) {
  const configured = (typeof window !== 'undefined' && window.CAMPAIGN_ADMIN_API) || '';
  const onWorkdesk = typeof location !== 'undefined' && /^\/workdesk(?:\/|$)/.test(location.pathname || '');
  const base = configured || (onWorkdesk ? '/api/trackb/campaigns' : '/api/campaign/admin');
  return API_BASE_URL + base + (path || '');
}

/**
 * 작업오더에서 만든 공고의 역방향 링크를 저장한다.
 * 인트라넷 SSO로 열린 workdesk는 /api/trackb/* 만 접근 가능하므로,
 * 공고 API가 Track B를 쓰는 경우 같은 네임스페이스의 위임 경로를 사용한다.
 */
async function _linkPrefilledWorkOrder(orderId, campaignId) {
  const configured = (typeof window !== 'undefined' && window.CAMPAIGN_ADMIN_API) || '';
  const pathName = typeof location !== 'undefined' ? (location.pathname || '') : '';
  const onWorkdesk = /^\/workdesk(?:\.html)?(?:\/|$)/.test(pathName);
  const useTrackB = onWorkdesk || configured.indexOf('/api/trackb/') >= 0;
  const path = useTrackB ? '/api/trackb/work-orders/update' : '/api/order/admin/update';
  const res = await fetch(API_BASE_URL + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ..._getAuthHeaders() },
    body: JSON.stringify({ id: orderId, linked_campaign_id: campaignId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `작업오더 연결 실패 (HTTP ${res.status})`);
  }
  return body;
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
  /* ★ 목록 컨테이너가 없는 화면에서 열린 모달(리뷰웹시스템[3버전] 홈 작업목록 → [공고])이
     저장 후 이 함수를 부르면 여기서 TypeError 가 나고, saveRecruit 의 catch 가 그것을
     **"저장 오류"로 표시**한다 — 실제로는 저장에 성공했는데도. 그릴 곳이 없으면 조용히 넘긴다
     (그 화면의 갱신은 CAMP_ON_SAVED 훅이 담당). */
  if (!wrap) return;
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
// workdesk.html is an inline runtime and can be evaluated before this file in a
// different script scope. Publish the shared loader explicitly so its refresh
// path never relies on an implicit global function binding.
window.loadRecruitList = loadRecruitList;

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

/**
 * 인기 ON/OFF 저장 직후의 화면 동기화.
 *
 * 목록 전체를 다시 요청하면 카드가 사라졌다 다시 그려져 토글 직후 화면이
 * "새로고침"되는 것처럼 보인다. 서버 저장이 성공한 뒤에는 현재 목록 캐시의
 * 해당 공고만 바꿔 공용 카드 렌더러로 즉시 다시 그린다. 다음 일반 목록 조회는
 * 서버값을 다시 기준으로 삼으므로 클라이언트 캐시가 장기 출처가 되지 않는다.
 */
function updateRecruitPopularity(campId, on) {
  const id = String(campId);
  const found = _recruitLastList.find(c => String(c.id) === id);
  if (!found) return false;
  found.is_popular = on === true;
  _renderRecruitCards(_recruitLastList);
  return true;
}
window.updateRecruitPopularity = updateRecruitPopularity;

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
  div.style.position = "relative";
  // 인기상품만 남긴다. 별표 우선노출은 제거됐고, 인기 설정만 선행참여 게이트를 건다.
  const popOn = c.is_popular === true;
  const flagBtns = `
    <div style="position:absolute;top:10px;left:12px;display:flex;z-index:2">
      ${c.participation_mode ? `<button type="button" title="${popOn ? "인기 해제" : "인기 설정 — 리뷰어에게 [인기!] 배지가 붙고, 일반 모집 1건 제출완료당 인기 1건 참여(1:1) 조건이 걸립니다"}"
        onclick="event.stopPropagation();toggleCampFlag('${escHtml(c.id)}','popular',${popOn ? "false" : "true"})"
        style="border:1px solid ${popOn ? "#FCA5A5" : "#E5E7EB"};cursor:pointer;background:${popOn ? "#FEE2E2" : "#F9FAFB"};color:${popOn ? "#B91C1C" : "#9CA3AF"};border-radius:8px;padding:4px 9px;font-size:.72rem;font-weight:800">🔥 ${popOn ? "ON" : "OFF"}</button>` : ""}
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

/* 인기상품 ON/OFF — 저장 성공 후 해당 카드만 즉시 반영한다. */
async function toggleCampFlag(campId, kind, on) {
  try {
    const body = { popular: on };
    const res = await fetch(_campApi(`/${encodeURIComponent(campId)}/flags`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
    updateRecruitPopularity(campId, on);
    showToast(on ? "🔥 인기 설정 — 리뷰어에게 [인기!] 배지가 표시되고, 일반 모집 1건 제출완료당 인기 1건 참여(1:1) 조건이 적용됩니다" : "인기 설정을 해제했습니다",
      "success");
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
  // 미리보기는 화면 코드가 자주 갱신되므로, 카드에서 새 창을 열 때는 현재 시뮬레이션 번들을
  // 확실히 받도록 버전 표식을 붙인다. 토큰은 기존처럼 fragment로만 전달한다.
  const url = "campaign.html?id=" + encodeURIComponent(campId) + "&preview=1&previewBuild=sim-20260814#tok=" + encodeURIComponent(token);
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
/* ★ 탭 목록 경로는 호스트가 재기준한다(`CAMPAIGN_ADMIN_API` 와 같은 장치).
   관리자 대시보드는 `/api/tab/dashboard`(admin_token) 그대로, 리뷰웹시스템[3버전]은
   `/api/trackb/tabs` — 인트라넷 SSO 토큰(via:'intranet')은 `/api/trackb/*` 밖으로
   나갈 수 없어 그 경로가 **양쪽에서 닿는 유일한 목록**이다. 전역 미설정이면 동작 불변. */
function _recruitTabsApi() {
  return (typeof window !== "undefined" && window.RECRUIT_TABS_API) || "/api/tab/dashboard";
}
let _rfTabsErr = null;   // 탭 목록 로드 실패 사유(성공 = null) — "0건"과 "못 불러옴"을 구분해 말하려고 남긴다
async function loadRecruitTabOptions() {
  try {
    /* ── API에서 직접 탭 목록을 가져옴 (DOM 의존 제거) ── */
    const token = sessionStorage.getItem("admin_token") || "";
    const res = await fetch(API_BASE_URL + _recruitTabsApi(), {
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
      // spreadsheetTitle = /api/trackb/tabs(리뷰웹시스템[3버전]) 의 시트 제목 필드 — 없으면 종전 폴백 그대로
      const sheetName = r.campaignName || r.campaign_name || r.tcCampaignName || r.spreadsheetTitle || sid.slice(-6);
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

    _rfTabsErr = null;
    _populateCampaignSelect();
  } catch(e) {
    console.warn("[recruit] 탭 옵션 로드 실패:", e);
    _rfTabsErr = (e && e.message) || "불러오기 실패";
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
    // DOM 폴백이 실제로 건졌으면 실패로 취급하지 않는다(관리자 대시보드 경로)
    if (_recruitTabList.length) _rfTabsErr = null;
    _populateCampaignSelect();
  }
  try { _rfRefreshLinkedTabNote(); } catch (_) {}   // 목록 상태가 바뀌면 안내도 다시 판단
}

/* 1단계: 캠페인(시트) 선택 드롭다운 구성 */
function _populateCampaignSelect(currentSheetId) {
  setTimeout(() => { if (window.RecruitModal?.refreshLinkedReferences) window.RecruitModal.refreshLinkedReferences(); }, 0);
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
  setTimeout(() => { if (window.RecruitModal?.refreshLinkedReferences) window.RecruitModal.refreshLinkedReferences(); }, 0);
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
  try { _rfRefreshLinkedTabNote(); } catch (_) {}   // 시트를 바꾸면 탭이 비므로 안내를 다시 판단
}

/* 탭 선택 시 → 연결 정보 표시 */
function onLinkedTabChange(sel) {
  if (window.RecruitModal?.refreshLinkedReferences) window.RecruitModal.refreshLinkedReferences();
  if (typeof renderPartCheck === "function") renderPartCheck(); // 참여형 자동점검 즉시 갱신(N6)
  // 탭을 고르면 안내가 사라지고, 지우면 다시 뜬다(사람이 고른 값이 최우선)
  if (sel && sel.value) _rfLinkedMiss = null;
  try { _rfRefreshLinkedTabNote(); } catch (_) {}
  const info = document.getElementById("rf_linked_tab_info");
  const txt  = document.getElementById("rf_linked_tab_text");
  if (sel.value) {
    const t = _recruitTabList.find(x => x.key === sel.value);
    if (t) {
      // 연결 정보는 저장·검증에는 필요하지만 모집공고 편집 화면에는 노출하지 않는다.
      txt.textContent = "";
      info.style.display = "none";
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
/**
 * ★ 086: 이체은행 버튼 선택 복원. 값이 없거나 알 수 없으면 [자동](빈 값) 버튼을 고른다.
 *   _rfPickBtn 을 재사용하지 않는 이유 = 그쪽은 hidden id 를 channel/manager 로만 매핑하고
 *   '직접입력' 폴백이 붙어 있어, 은행처럼 값이 고정된 그룹에 쓰면 엉뚱한 분기를 탄다.
 */
/**
 * ★ 086: [자동]일 때 무슨 근거로 어느 은행이 되는지 화면에 보여준다.
 *   판정 규칙은 서버(payment.service.bankFromGoodsCostType)와 같아야 하므로 문자열도 같이 맞춘다.
 *   근거를 못 찾으면 기본 안내로 되돌린다(빈 값 = "모른다"를 숨기지 않는다).
 */
function _rfTransferHint(goodsCostType) {
  const el = document.getElementById("rf_transfer_bank_hint");
  if (!el) return;
  const base = "현금이체 → 하나은행 · 수수료(세금계산서) → 케이뱅크";
  const v = String(goodsCostType || "").trim();
  if (!v) { el.textContent = base; el.style.color = "#8B94A1"; return; }
  const bank = /현금/.test(v) ? "하나은행" : (/계산서|세금|수수료/.test(v) ? "케이뱅크" : "");
  if (!bank) { el.textContent = `작업오더 물건비 "${v}" — 은행을 정할 수 없어요. 직접 골라주세요`; el.style.color = "#B3382E"; return; }
  // 한글 조사 — 받침 있으면 '으로', 없으면 '로'("케이뱅크으로"가 되던 것)
  const last = bank.charCodeAt(bank.length - 1);
  const josa = (last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 !== 0) ? "으로" : "로";
  el.textContent = `작업오더 물건비 "${v}" → ${bank}${josa} 자동 분류돼요`;
  el.style.color = "#127A5E";
}

function _rfPickTransferBank(val) {
  const box = document.getElementById("rf_transfer_bank_btns");
  if (!box) return false;
  const v = (val === "kbank" || val === "hana") ? val : "";
  const btn = box.querySelector(`.rchan-btn[data-val="${v}"]`);
  if (!btn) return false;
  selectRfBtn("transfer_bank", btn);
  return true;
}

function _rfPickBtn(group, val) {
  // ★ hidden id 는 늘 `rf_<group>` — 그룹이 늘 때마다 삼항을 덧대면 새 그룹이 조용히 빠진다
  //   (channel/manager 만 알던 옛 삼항을 일반화. 087 리뷰타입이 세 번째 그룹).
  const hidden = document.getElementById("rf_" + group);
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

/* ═══════════════════════════════════════════════════════════════
   🔗 연결 탭 — "왜 비었는가" 안내 + 공고 제목 ↔ 탭명 유사도 추천
   ───────────────────────────────────────────────────────────────
   ★ 배경: 프리필은 그 탭이 **탭 목록에 있을 때만** 연결하고 없으면 일부러 빈칸으로
     둔다(잘못된 탭에 리뷰어 주문이 기록되는 것이 빈칸보다 나쁘다). 그런데 화면은
     그 사실을 말하지 않아 "작업오더에 시트가 있는데 왜 비어 있지?"가 됐다.
   ★ 추천은 **제안까지만, 확정은 사람이**(자동 선택 금지 — 계약 매칭·작업표 학습과 같은 규율).
     비슷한 게 없으면 **아무것도 추천하지 않는다**(빈 추천 > 틀린 추천).
   ★ 유사도는 프론트에서 계산한다 — 탭 목록·공고 제목이 모두 화면에 이미 있어
     서버 왕복이 필요 없다. 서버 `utils/contractMatch.js` 는 계약(업체·브랜드·금액)을
     재료로 쓰는 **다른 판정**이라 재사용 대상이 아니다(사본이 아니라 별개 규칙).
   ═══════════════════════════════════════════════════════════════ */
let _rfLinkedMiss = null;     // {source:'order'|'campaign', tabName, orderId?} — 못 찾은 탭
let _rfSugCache   = [];       // 추천 목록(onclick 은 인덱스만 넘긴다 — 탭명은 시트발 외부 문자열)
let _rfSugTimer   = null;
const _RF_SUG_MIN   = 0.45;   // 이 아래면 추천하지 않는다
const _RF_SUG_LIMIT = 3;

/** 매칭용 정규화 — 대괄호/괄호 안, 날짜(7/28·26.7.28), 용량·수량(150ml·300g·1개)은 잡음이라 뺀다 */
function _rfMatchNorm(s) {
  return String(s || "").toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\d{1,4}\s*[/.]\s*\d{1,2}(\s*[/.]\s*\d{1,4})?/g, " ")
    .replace(/\d+\s*(ml|l|g|kg|개|매|세트|포|정|장|박스|차)/g, " ")
    .replace(/[^0-9a-z가-힣]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
function _rfBigrams(s) {
  const t = String(s || "").replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
/** 0~1 점수. ★ 겹침계수(overlap)를 쓴다 — 탭명은 짧고 제목은 길어 Dice 는 늘 낮게 나온다. */
function _rfTabScore(titleNorm, tabNorm) {
  if (!titleNorm || !tabNorm) return 0;
  if (tabNorm.replace(/\s+/g, "").length < 3) return 0;   // 너무 짧은 탭명은 오탐만 만든다
  const A = _rfBigrams(tabNorm), B = _rfBigrams(titleNorm);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(g => { if (B.has(g)) inter++; });
  const overlap = inter / Math.min(A.size, B.size);
  const toks = tabNorm.split(" ").filter(t => t.length >= 2);
  const flat = titleNorm.replace(/\s+/g, "");
  const cover = toks.length ? toks.filter(t => flat.indexOf(t) > -1).length / toks.length : 0;
  return Math.max(overlap, cover);
}
/** 제목과 비슷한 탭 상위 N개(임계값 미만 제외, 동점은 목록 순서 유지) */
function _rfSuggestTabs(title, limit) {
  const tn = _rfMatchNorm(title);
  if (!tn) return [];
  return _recruitTabList
    .map((t, i) => ({ t, i, score: _rfTabScore(tn, _rfMatchNorm(t.tabName)) }))
    .filter(x => x.score >= _RF_SUG_MIN)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, limit || _RF_SUG_LIMIT)
    .map(x => ({ key: x.t.key, sheetId: x.t.sheetId, tabName: x.t.tabName,
                 sheetName: x.t.sheetName, score: x.score }));
}

/** 안내 박스 갱신 — 탭이 선택돼 있으면 숨긴다. ★ 이 함수는 노트 div 만 건드린다(입력칸 무접촉). */
function _rfRefreshLinkedTabNote() {
  const box = document.getElementById("rf_linked_tab_note");
  if (!box) return;
  const sel = document.getElementById("rf_linked_tab");
  if (sel && sel.value) { box.style.display = "none"; box.innerHTML = ""; _rfSugCache = []; return; }

  const title = (document.getElementById("rf_title")?.value || "").trim();
  _rfSugCache = _rfSuggestTabs(title, _RF_SUG_LIMIT);
  const miss = _rfLinkedMiss;
  const noTabs = !_recruitTabList.length;
  if (!miss && !noTabs && !_rfSugCache.length) { box.style.display = "none"; box.innerHTML = ""; return; }

  let html = "";
  /* ★★ 목록이 통째로 비면 "비슷한 탭이 없다"가 아니라 **고를 수가 없는 상태**다 —
     시트명부터 고르라고 하면 따를 수 없는 지시가 된다(실측 신고).
     못 불러온 것과 진짜 0건을 구분해 말하고, 다시 시도할 길을 준다. */
  if (noTabs) {
    html += _rfTabsErr
      ? `⚠ 시트·탭 목록을 <b>불러오지 못했어요</b> — 네트워크·권한 문제일 수 있어요.`
      : `⚠ 고를 수 있는 <b>작업 탭이 없어요</b> — 작업오더를 접수하면 목록에 나타납니다(접수 후 5분쯤).`;
    if (miss) html += `<br>이 공고에 저장된 탭: <span class="rf-ltwant">${escHtml(miss.tabName || "(이름 없음)")}</span>`;
    html += `<div class="rf-ltrow"><button type="button" class="rf-ltwo" onclick="rfReloadTabs(this)">↻ 다시 불러오기</button>`;
    if (miss && miss.orderId && typeof window.RECRUIT_OPEN_WORK_ORDER === "function") {
      html += `<button type="button" class="rf-ltwo" onclick="rfOpenLinkedWorkOrder()">작업오더 열기 →</button>`;
    }
    html += `</div>`;
    box.className = "rf-ltnote";
    box.innerHTML = html;
    box.style.display = "";
    return;
  }
  if (miss) {
    const where = miss.source === "order" ? "작업오더의" : "이 공고에 저장된";
    const why = miss.source === "order"
      ? "작업오더를 <b>아직 접수하지 않았거나</b>, 접수 직후라 아직 목록에 올라오지 않았을 수 있어요(접수 후 5분쯤)."
      : "탭 이름이 바뀌었거나 목록에서 빠졌을 수 있어요.";
    html += `⚠ ${where} 시트 탭 <span class="rf-ltwant">${escHtml(miss.tabName || "(이름 없음)")}</span> 을(를) 탭 목록에서 찾지 못했어요.<br>${why}`;
    if (miss.orderId && typeof window.RECRUIT_OPEN_WORK_ORDER === "function") {
      html += `<div class="rf-ltrow"><button type="button" class="rf-ltwo" onclick="rfOpenLinkedWorkOrder()">작업오더 열기 →</button></div>`;
    }
  } else {
    html += `공고 제목과 비슷한 탭을 찾았어요 — 맞는 탭을 골라주세요.`;
  }

  if (_rfSugCache.length) {
    html += `<div class="rf-ltrow"><span class="rf-ltcap">제목과 비슷한 탭</span>`;
    _rfSugCache.forEach((s, i) => {
      html += `<button type="button" class="rf-ltsug" onclick="rfPickSuggestedTab(${i})" title="${escHtml(s.sheetName + " > " + s.tabName)}">` +
              `<span class="nm">${escHtml(s.tabName)}</span>` +
              `<span class="pc">${Math.round(s.score * 100)}%</span>` +
              `<span class="sh">${escHtml(s.sheetName || "")}</span></button>`;
    });
    html += `</div>`;
  } else if (miss) {
    html += `<div class="rf-ltrow"><span class="rf-ltcap">제목과 비슷한 탭도 찾지 못했어요 — 위 ① 시트명부터 직접 골라주세요.</span></div>`;
  }
  box.className = "rf-ltnote" + (miss ? "" : " plain");
  box.innerHTML = html;
  box.style.display = "";
}

/** 추천 칩 클릭 — ★ 인덱스만 받는다(탭명을 onclick 문자열에 넣지 않는다) */
function rfPickSuggestedTab(i) {
  const s = _rfSugCache[i];
  if (!s) return;
  if (_restoreLinkedTab(s.sheetId, s.tabName)) _rfLinkedMiss = null;   // 사람이 골랐으면 사유 안내는 끝
  _rfRefreshLinkedTabNote();
}
/** [↻ 다시 불러오기] — 탭 목록을 다시 받고, 성공하면 저장돼 있던 탭을 자동으로 되살린다 */
async function rfReloadTabs(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "불러오는 중…"; }
  try { await loadRecruitTabOptions(); } catch (_) {}
  const m = _rfLinkedMiss;
  if (m && m.sheetId && m.tabName && _restoreLinkedTab(m.sheetId, m.tabName)) _rfLinkedMiss = null;
  _rfRefreshLinkedTabNote();   // 여전히 비면 사유가 그대로 남는다(조용히 성공한 척하지 않는다)
}
/** [작업오더 열기] — 호스트가 훅을 등록한 화면에서만 버튼이 뜬다 */
function rfOpenLinkedWorkOrder() {
  const id = _rfLinkedMiss && _rfLinkedMiss.orderId;
  if (id && typeof window.RECRUIT_OPEN_WORK_ORDER === "function") window.RECRUIT_OPEN_WORK_ORDER(id);
}
/** 제목을 고치면 추천을 다시 계산한다 — ★ 노트 div 만 갱신(입력칸 재렌더 금지 = IME 보호) */
function _rfBindTitleSuggest() {
  const el = document.getElementById("rf_title");
  if (!el || el.dataset.ltBound === "1") return;
  el.dataset.ltBound = "1";
  el.addEventListener("input", () => {
    clearTimeout(_rfSugTimer);
    _rfSugTimer = setTimeout(_rfRefreshLinkedTabNote, 220);
  });
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
  /* ★ 못 찾았으면 **왜 비었는지**를 화면이 말하게 한다(조용한 빈칸 금지).
     기록만 하고 선택은 여전히 안 한다 — 잘못된 탭 연결이 빈칸보다 나쁘다는 규칙은 그대로. */
  const _miss = (name) => {
    _rfLinkedMiss = { source: "order", tabName: name || prefill.linked_tab_name || "",
                      sheetId: sid || prefill.linked_sheet_id || "", orderId: _woPrefillOrderId || null };
    return false;
  };
  if (!sid) return prefill.work_sheet_url || prefill.linked_tab_name ? _miss("") : false;
  const gid = String(prefill.linked_tab_gid || gidFromUrl || "");
  const byGid = gid && _recruitTabList.find(t => t.sheetId === sid && String(t.tabGid || "") === gid);
  const tabName = (byGid && byGid.tabName) || prefill.linked_tab_name || "";
  if (!tabName) return _miss("");
  // 목록에 없는 탭(아카이브·미등록)이면 선택하지 않는다 — 잘못된 탭이 걸리는 것보다 낫다
  if (!_recruitTabList.some(t => t.sheetId === sid && t.tabName === tabName)) return _miss(tabName);
  if (!_restoreLinkedTab(sid, tabName)) return _miss(tabName);
  _rfLinkedMiss = null;
  return true;
}

/* 수정 모달 열 때: 저장된 연결 탭 복원 */
/** @returns {boolean} 실제로 선택됐는지 — 목록에 없는 시트/탭이면 select 가 조용히 빈 값으로 남는다 */
function _restoreLinkedTab(linkedSheetId, linkedTabName) {
  if (!linkedSheetId || !linkedTabName) return false;
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
    return tabSel.value === key;
  }
  return false;
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
let _rfActiveTimePickerField = "rf_window_start";
// 자유시간대로 잠시 전환해도 이 모달에서 이미 불러온/입력한 시간창은 보존한다.
// 저장값은 자유시간대가 우선이므로, 다시 시간 지정으로 바꿀 때만 이 값을 복원한다.
let _rfLastScheduledPurchaseWindow = { start: "", end: "" };

function _rfPadTime(value) {
  return String(value).padStart(2, "0");
}

function _rfTimeParts(fieldId) {
  const value = document.getElementById(fieldId || _rfActiveTimePickerField)?.value || "13:00";
  const [hour = "13", minute = "00"] = value.split(":");
  return { hour, minute };
}

function _isRecruitAutoOrder() {
  const toggle = document.getElementById("rf_free_time_toggle");
  if (toggle) return toggle.classList.contains("on");
  return /자유|자율/.test(document.getElementById("rf_time_range")?.value || "");
}

function rfSyncPurchaseTimeValue() {
  const start = document.getElementById("rf_window_start")?.value || "";
  const end = document.getElementById("rf_window_end")?.value || "";
  const free = _isRecruitAutoOrder();
  const range = document.getElementById("rf_time_range");
  const startButton = document.getElementById("rf_window_start_button");
  const endButton = document.getElementById("rf_window_end_button");
  const state = document.getElementById("rf_free_time_state");
  if (range) range.value = free ? "자유시간대" : (start && end ? `${start} ~ ${end}` : "");
  if (startButton) startButton.textContent = start || "시작";
  if (endButton) endButton.textContent = end || "종료";
  if (state) state.textContent = free ? "자유시간대" : "시간 지정";
  if (typeof renderPartCheck === "function") renderPartCheck();
  if (typeof _onPreviewInput === "function") _onPreviewInput();
}

function rfRenderTimePicker() {
  const hourGrid = document.getElementById("rf_time_picker_hours");
  const minuteGrid = document.getElementById("rf_time_picker_minutes");
  const title = document.getElementById("rf_time_picker_title");
  if (!hourGrid || !minuteGrid) return;
  const { hour, minute } = _rfTimeParts();
  if (title) title.textContent = _rfActiveTimePickerField === "rf_window_start" ? "구매 시작 시간" : "구매 종료 시간";
  hourGrid.innerHTML = Array.from({ length: 24 }, (_, value) => {
    const time = _rfPadTime(value);
    return `<button type="button" data-time-hour="${time}" class="${time === hour ? "on" : ""}" onclick="rfSetTimePickerPart('hour','${time}')">${time}</button>`;
  }).join("");
  minuteGrid.innerHTML = Array.from({ length: 6 }, (_, value) => {
    const time = _rfPadTime(value * 10);
    return `<button type="button" data-time-minute="${time}" class="${time === minute ? "on" : ""}" onclick="rfSetTimePickerPart('minute','${time}')">${time}</button>`;
  }).join("");
}

function rfOpenTimePicker(fieldId) {
  if (_isRecruitAutoOrder()) return;
  _rfActiveTimePickerField = fieldId;
  document.getElementById("rf_time_picker")?.removeAttribute("hidden");
  [["rf_window_start", "rf_window_start_button"], ["rf_window_end", "rf_window_end_button"]].forEach(([, buttonId]) => {
    document.getElementById(buttonId)?.setAttribute("aria-expanded", String(buttonId === `${fieldId}_button`));
  });
  rfRenderTimePicker();
}

function rfCloseTimePicker() {
  document.getElementById("rf_time_picker")?.setAttribute("hidden", "");
  ["rf_window_start_button", "rf_window_end_button"].forEach(id => document.getElementById(id)?.setAttribute("aria-expanded", "false"));
}

function rfSetTimePickerPart(part, value) {
  const field = document.getElementById(_rfActiveTimePickerField);
  if (!field || _isRecruitAutoOrder()) return;
  const current = _rfTimeParts();
  // 분은 패널에서만 고르고 10분 단위 버튼만 제공한다. 기존 공고의 과거 값은 보존하되,
  // 새 선택은 반드시 이 규칙을 통과한다.
  field.value = part === "hour" ? `${value}:${current.minute}` : `${current.hour}:${value}`;
  rfRenderTimePicker();
  rfSyncPurchaseTimeValue();
}

function rfSetFreeTime(isFreeTime) {
  const toggle = document.getElementById("rf_free_time_toggle");
  const range = document.getElementById("rf_time_range_control");
  if (!toggle || !range) return;
  toggle.classList.toggle("on", isFreeTime);
  toggle.setAttribute("aria-pressed", String(isFreeTime));
  range.classList.toggle("is-disabled", isFreeTime);
  ["rf_window_start_button", "rf_window_end_button"].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = isFreeTime;
  });
  if (isFreeTime) {
    const start = document.getElementById("rf_window_start")?.value || "";
    const end = document.getElementById("rf_window_end")?.value || "";
    if (start || end) _rfLastScheduledPurchaseWindow = { start, end };
    ["rf_window_start", "rf_window_end"].forEach(id => {
      const field = document.getElementById(id);
      if (field) field.value = "";
    });
    rfCloseTimePicker();
  } else {
    const startField = document.getElementById("rf_window_start");
    const endField = document.getElementById("rf_window_end");
    if (startField && !startField.value) startField.value = _rfLastScheduledPurchaseWindow.start || "";
    if (endField && !endField.value) endField.value = _rfLastScheduledPurchaseWindow.end || "";
  }
  rfSyncPurchaseTimeValue();
}

function rfApplyPurchaseTime({ timeRange = "", start = "", end = "" } = {}) {
  const text = String(timeRange || "").trim();
  const parsed = _parsePurchaseTime(text);
  const startValue = String(start || "").slice(0, 5) || parsed?.start || "";
  const endValue = String(end || "").slice(0, 5) || parsed?.end || "";
  if (/자유|자율/.test(text) || (!startValue && !endValue && !text)) {
    rfSetFreeTime(true);
    return;
  }
  const startField = document.getElementById("rf_window_start");
  const endField = document.getElementById("rf_window_end");
  if (startField) startField.value = startValue;
  if (endField) endField.value = endValue;
  _rfLastScheduledPurchaseWindow = { start: startValue, end: endValue };
  rfSetFreeTime(false);
  rfSyncPurchaseTimeValue();
}

function rfBindPurchaseTimePicker() {
  const modal = document.getElementById("recruitModal");
  if (!modal || modal.dataset.rfTimePickerBound === "1") return;
  modal.dataset.rfTimePickerBound = "1";
  modal.addEventListener("click", event => {
    const picker = document.getElementById("rf_time_picker");
    if (!picker || picker.hasAttribute("hidden")) return;
    if (picker.contains(event.target) || event.target.closest?.("[data-rf-time-trigger]")) return;
    rfCloseTimePicker();
  });
}

function onRecruitTimeRangeInput() {
  rfApplyPurchaseTime({ timeRange: document.getElementById("rf_time_range")?.value || "" });
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
  /* v2(레일 배치 모달): 참여형 전용 카드·블록은 data-part-only 로 일괄 토글 —
     rf_part_section/rf_work_section 두 계약은 위에 그대로 두고(회귀가드), 나머지를 이걸로 덮는다.
     레거시(일반) 공고를 열면 전용 카드가 숨고 안내(rf_legacy_note)가 대신 뜬다. */
  document.querySelectorAll("#recruitModal [data-part-only]").forEach(el => { el.style.display = on ? "" : "none"; });
  const _legacyNote = document.getElementById("rf_legacy_note");
  if (_legacyNote) _legacyNote.style.display = on ? "none" : "";
  // 컴팩트 편집기는 입력 DOM을 이동하지 않는다. 상태 동기화만 수행한다.
  if (window.RecruitModal && RecruitModal.refreshStaticControls) RecruitModal.refreshStaticControls();
  if (window.RecruitModal && RecruitModal.refreshRail) RecruitModal.refreshRail();   // 레일 목차 동기화
  _syncRecruitPaneGate(on);
  if (on) {
    // 작업오더의 "2시~4시" 같은 진행시간 텍스트를 시각으로 프리필한다.
    // rfApplyPurchaseTime은 기존 hidden 필드와 카드 미리보기를 함께 동기화한다.
    const ws = document.getElementById("rf_window_start");
    const we = document.getElementById("rf_window_end");
    if (ws && we && !ws.value && !we.value) {
      rfApplyPurchaseTime({ timeRange: document.getElementById("rf_time_range")?.value || "" });
    } else {
      rfSyncPurchaseTimeValue();
    }
    renderPartCheck();
  }
}

/** 👥 타계정 참여(063) 토글 — 하위 설정(하루한도·타계정 제한시간) 표시. 끄면 기본 [불가] 그대로. */
/* ═══════════════════════════════════════════════════════════════════════
   🧪 테스트 공고 만들기 — 대량구매(타계정 다건 일괄 제출) 검증용 프리셋
   ─────────────────────────────────────────────────────────────────────
   기존 발행 모달을 그대로 열고 값만 미리 채운다(신규 엔드포인트·신규 모달 0).
   저장은 평소와 같은 [저장] 버튼 → 같은 검증·같은 라우트를 탄다.

   ★ 왜 이 값들인가
     - 상태 active + 리뷰어 숨김 : 리뷰어 목록엔 안 뜨지만 참여·제출은 진짜로 된다.
       (status 를 draft 로 두면 상태엔진이 closed 로 판정해 참여 자체가 막혀 테스트가 불가)
     - 타계정 허용 + 하루한도 5 : 한 사람이 여러 명의로 같은 날 참여해야 일괄 제출이 켜진다.
     - 자리 유효시간 30분 : 테스트 도중 만료로 막히지 않게(운영 기본값은 15/10분).
     - 구매 시간대 비움 = 자율주문(종일 오픈).
   ★ 연결 탭만 사람이 고른다 — 어느 시트에 테스트 행을 쓸지는 시스템이 정할 수 없다.
   ═══════════════════════════════════════════════════════════════════════ */
async function openTestCampaignModal() {
  await openRecruitModal(null);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  const chk = (id, on, after) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = !!on;
    if (typeof after === "function") { try { after(!!on); } catch (_) { /* noop */ } }
  };

  set("rf_title", "🧪 [테스트] 대량구매 일괄제출 검증");
  set("rf_status", "active");            // ★ 참여가 실제로 되어야 테스트가 된다
  set("rf_review_fee", 1000);
  set("rf_time_range", "");              // 자율주문(종일 오픈)
  set("rf_window_start", "");
  set("rf_window_end", "");
  set("rf_hold_ttl", 30);                // 테스트 중 만료로 끊기지 않게

  chk("rf_participation", true, onParticipationToggle);   // 참여형이라야 홀드·일괄제출 경로를 탄다
  chk("rf_multi_account", true, onMultiAccountToggle);    // 타계정 허용 = 일괄 제출의 전제
  set("rf_multi_daily", 5);              // 하루에 여러 명의로 참여 가능해야 배치가 켜진다
  set("rf_sub_ttl", 30);
  chk("rf_reviewer_hidden", true);       // ★ 리뷰어 목록 미노출

  // 진행상품 표가 정원의 진실원본 — 한 줄 넣어 총모집/일건수를 파생시킨다
  try {
    renderOptRows([]);
    addOptRow({ productName: "테스트 상품", optKey: "", payAmount: 10000, recruitTotal: 100, dailyLimit: 20 });
    if (typeof _syncPreviewFromOptRows === "function") _syncPreviewFromOptRows();
  } catch (_) { /* 표가 없는 축약 화면이면 건너뛴다 */ }

  try { renderPartCheck(); } catch (_) { /* noop */ }
  if (typeof showToast === "function") {
    showToast("🧪 테스트 공고 값을 채웠어요. 연결 탭만 고른 뒤 저장하세요.", "info");
  }
}
if (typeof window !== "undefined") window.openTestCampaignModal = openTestCampaignModal;

/* ⏸ 098 이월 반영 세그먼트(자동/보류) — 보류를 고르는 순간 무슨 일이 생기는지 문장으로 미리
   말한다(조용한 전환 금지 — 시안 확정). 값은 hidden rf_carry_mode 하나가 진실(저장이 그걸 읽는다). */
function rfCarrySet(mode, opts) {
  const m = mode === "hold" ? "hold" : "auto";
  const hid = document.getElementById("rf_carry_mode");
  if (hid) hid.value = m;
  const a = document.getElementById("rf_carry_auto");
  const h = document.getElementById("rf_carry_hold");
  if (a && h) {
    a.classList.toggle("active", m === "auto");
    h.classList.toggle("active", m === "hold");
    a.style.background = ""; a.style.color = "";
    h.style.background = ""; h.style.color = "";
  }
  const note = document.getElementById("rf_carry_hold_note");
  // 프리필·초기화(silent)에서는 고지문을 접어 둔다 — 사람이 보류를 "직접 고른" 순간에만 펼친다
  if (note) note.style.display = (m === "hold" && !(opts && opts.silent)) ? "" : "none";
}
window.rfCarrySet = rfCarrySet;

function onMultiAccountToggle(on) {
  const sec = document.getElementById("rf_multi_section");
  if (sec) sec.style.display = on ? "" : "none";
  renderPartCheck();
}

function rfSetInflowType(type, button) {
  const value = type === "guide" ? "guide" : "link";
  const hidden = document.getElementById("rf_inflow_type_value");
  if (hidden) hidden.value = value;
  const root = document.getElementById("rf_inflow_type_ui");
  root?.querySelectorAll("button").forEach((el) => el.classList.toggle("active", el === button || el.dataset.inflow === value));
  syncRecruitProductMainUrl();
}
window.rfSetInflowType = rfSetInflowType;

function rfToggleCashReceipt() {
  const input = document.getElementById("rf_cash_receipt_required");
  rfSetCashReceipt(!input?.checked);
}
function rfSetCashReceipt(on) {
  const input = document.getElementById("rf_cash_receipt_required");
  if (input) input.checked = !!on;
  const toggle = document.getElementById("rf_cashrcpt_toggle");
  const state = document.getElementById("rf_cash_receipt_state");
  const note = document.getElementById("rf_cash_receipt_note");
  toggle?.classList.toggle("on", !!on); toggle?.setAttribute("aria-pressed", String(!!on));
  if (state) state.textContent = on ? "발행 필요" : "발행 안 함";
  if (note) note.textContent = on ? "카드와 구매 안내에 자동 표기" : "참여자에게 미노출";
  syncRecruitAutomaticBadges();
}
window.rfToggleCashReceipt = rfToggleCashReceipt;
window.rfSetCashReceipt = rfSetCashReceipt;

function rfToggleFeeSchedule() {
  const input = document.getElementById("rf_fee_sched_on");
  onFeeScheduleToggle(!input?.checked);
}
window.rfToggleFeeSchedule = rfToggleFeeSchedule;

function rfSetWeekendPolicy(skip, button) {
  const input = document.getElementById("rf_skip_weekends");
  if (input) input.checked = !!skip;
  const root = document.getElementById("rf_skip_weekends_toggle");
  root?.querySelectorAll("button").forEach((el) => el.classList.toggle("active", el === button || (skip ? el.dataset.weekend === "exclude" : el.dataset.weekend === "include")));
}
window.rfSetWeekendPolicy = rfSetWeekendPolicy;

function rfSetMultiAccount(on, button) {
  const input = document.getElementById("rf_multi_account");
  if (input) input.checked = !!on;
  const root = document.getElementById("rf_multi_account_toggle");
  root?.querySelectorAll("button").forEach((el) => el.classList.toggle("active", el === button || (on ? el.dataset.multi === "on" : el.dataset.multi === "off")));
  onMultiAccountToggle(!!on);
}
window.rfSetMultiAccount = rfSetMultiAccount;

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

/** 유입가이드 HTML → 미리보기 평문 (원본은 _wdInflowRawHtml에 보존, 여긴 관리자 확인용)
 *  ★ 사진은 오른쪽 썸네일 스트립이 보여주므로 본문에 [이미지] 자리표시자·"※ 이미지 N장" 꼬리표를
 *    남기지 않는다(그 글자가 그대로 편집 대상이 되어 저장본에 섞이던 자리). */
function _htmlToPlainPreview(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n")
    .replace(new RegExp("<" + "img" + "[^>]*>", "gi"), "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/* ═══════════════════════════════════════════════════════════════════════
   🖼 작업내용 첨부 이미지 (유입가이드 · 리뷰가이드 · 특이사항)
   시안 = frontend/docs/design-workdetail-images.html (사용자 확정 2026-08-07)
   ─────────────────────────────────────────────────────────────────────
   ★ 세 칸이 **이 위젯 한 벌**을 쓴다 — 칸마다 사본을 두면 한쪽만 장수·용량 제한이
     풀리거나 한쪽만 붙여넣기가 안 되는 드리프트가 난다(1:1문의 첨부와 같은 규율).
   ★ 넣는 길 3가지(파일선택 · Ctrl+V · 드래그앤드롭)가 전부 `_igUpload` 한 함수로 수렴.
   ★ 저장 형태는 칸마다 다르다 —
       유입가이드 = inflowGuideHtml **안의 <img>**(기존 저장분 호환)
       리뷰가이드·특이사항 = **새 배열**(reviewGuideImages / specialNotesImages)
     평문 칸을 HTML로 승격하지 않는다(기존 저장분의 '<옵션>' 같은 꺾쇠가 태그로 오인돼 삭제된다).
   ★ 확대 팝업은 **body 직속**, onclick 에는 **인덱스만**(주소 문자열 보간 금지).
   ═══════════════════════════════════════════════════════════════════════ */
const _IG_MAX = 4;                 // 칸당 장수(사용자 확정) — 서버도 다시 센다
const _IG_MAX_MB = 5;              // 장당 용량(썸네일 업로드와 같은 값)
const _IG_FIELDS = { inflow: "유입가이드", review: "리뷰가이드", notes: "특이사항" };
const _IG_TA = { inflow: "rf_wd_inflow", review: "rf_wd_review", notes: "rf_wd_notes" };
// 우리 서버의 guide-image 프록시 주소만 — 서버 sanitizeGuideImages 와 같은 규칙
const _IG_URL_RE = /^https?:\/\/[^\s"'<>]+\/api\/order\/guide-image\/[-\w]{20,}$/;

/** 칸별 이미지 목록. item = {url, tok, src, state:'ok'|'up'|'bad', name} */
window._igState = { inflow: [], review: [], notes: [] };

const _igTok = u => { const m = String(u || "").match(/\/api\/order\/guide-image\/([-\w]{20,})$/); return m ? m[1] : ""; };
const _igOk = f => (window._igState[f] || []).filter(x => x.state === "ok");
const _igUrls = f => _igOk(f).map(x => x.url);
const _igBusy = () => Object.keys(_IG_FIELDS).some(f => (window._igState[f] || []).some(x => x.state === "up"));
const _igImgTags = f => _igOk(f).map(x => `<img src="${escHtml(x.url)}">`).join("");

/** 서버에서 받은 배열 → 위젯 상태(우리 프록시 주소만·중복 제거). ★ 상한 초과분은 자르지 않는다
 *  (조용히 자르면 관리자가 모르는 사이 사진이 사라진다 — 무엇을 뺄지는 사람이 고른다). */
function _igSetList(field, urls) {
  const seen = new Set(), out = [];
  (Array.isArray(urls) ? urls : []).forEach(u => {
    const s = String(u || "").trim();
    if (!_IG_URL_RE.test(s)) return;
    const tok = _igTok(s);
    if (!tok || seen.has(tok)) return;
    seen.add(tok);
    out.push({ url: s, tok, src: s, state: "ok", name: "" });
  });
  window._igState[field] = out;
}

/** 유입가이드 HTML → { textHtml(사진 뺀 나머지), urls(등장 순서) } */
function _igSplitInflow(html) {
  const urls = [];
  const textHtml = String(html || "").replace(new RegExp("<" + "img" + "\\b[^>]*>", "gi"), (tag) => {
    const m = tag.match(/src\s*=\s*["']([^"']+)["']/i);
    if (m && _IG_URL_RE.test(m[1].trim())) urls.push(m[1].trim());
    return "";
  });
  return { textHtml, urls };
}

/** 유입가이드 저장값 조립 — 글을 안 고쳤고 사진 구성도 그대로면 **원본 그대로**(바이트 동일) */
function _igComposeInflow() {
  const ta = document.getElementById("rf_wd_inflow");
  const useRaw = !!(ta && ta.dataset.rawHtml === "1" && window._wdInflowRawHtml);
  const toks = _igOk("inflow").map(x => x.tok).join(",");
  if (useRaw && toks === String(window._wdInflowOrigTokens || "")) return window._wdInflowRawHtml;
  const escT = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let text;
  if (useRaw) {
    text = String(window._wdInflowTextHtml || "");
  } else {
    // 미리보기 아티팩트(옛 저장분에 굳어 있을 수 있는 [이미지]·꼬리표)를 걷어낸 평문
    const plain = String(ta ? ta.value : "")
      .replace(/\n*※ 이미지 \d+장 포함[^\n]*$/m, "").replace(/\[이미지\]/g, "")
      .replace(/\n{3,}/g, "\n\n").trim();
    text = escT(plain).replace(/\n/g, "<br>");
  }
  return text + _igImgTags("inflow");
}

/** 원본 유입가이드 HTML을 위젯에 싣는다(편집 프리필·작업오더 프리필 공통) */
function _igLoadInflowHtml(rawHtml) {
  const { textHtml, urls } = _igSplitInflow(rawHtml);
  _igSetList("inflow", urls);
  window._wdInflowTextHtml = textHtml;
  window._wdInflowOrigTokens = _igOk("inflow").map(x => x.tok).join(",");
  return textHtml;
}

/** 세 칸 초기화(모달 열 때)
 *  ★ 배선도 여기서 한 번 더 시도한다(멱등) — 리뷰웹시스템[3버전]은 모달을 **뷰를 열 때** 마운트하므로
 *    스크립트 로드 시점 배선만 두면 그 화면에서는 스트립이 통째로 죽는다. */
function _igResetAll() {
  window._igState = { inflow: [], review: [], notes: [] };
  window._wdInflowTextHtml = "";
  window._wdInflowOrigTokens = "";
  Object.keys(_IG_FIELDS).forEach(_igBind);
  _igRenderAll();
}
function _igRenderAll() { Object.keys(_IG_FIELDS).forEach(_igRender); }

let _igMsgTimer = {};
function _igSay(field, msg, kind) {
  const el = document.getElementById("rf_igm_" + field);
  if (!el) return;
  el.textContent = msg || "";
  el.className = "ig-msg " + (kind || "");
  clearTimeout(_igMsgTimer[field]);
  // 성공 안내는 잠시 뒤 지운다(경고·오류는 남긴다 — 사람이 조치해야 하는 상태다)
  if (kind === "ok") _igMsgTimer[field] = setTimeout(() => { if (el.textContent === msg) _igSay(field, ""); }, 2500);
}

function _igRender(field) {
  const strip = document.getElementById("rf_ig_" + field);
  if (!strip) return;
  const list = window._igState[field] || [];
  let h = "";
  if (!list.length) {
    h = `<button type="button" class="ig-empty" data-igadd="1">
           <span class="t1">＋ 사진 넣기</span><span class="t2">끌어다 놓기 · Ctrl+V<br>클릭</span></button>`;
  } else {
    list.forEach((im, i) => {
      const cls = "ig-thumb" + (im.state === "up" ? " up" : im.state === "bad" ? " bad" : "");
      // ★ onclick 없음(위임) · 넘기는 값은 인덱스뿐 — 주소·파일명을 속성에 보간하지 않는다
      h += `<button type="button" class="${cls}" data-igi="${i}" draggable="false" title="클릭하면 크게 보기">
              <img src="${escHtml(im.src || im.url)}" alt="">
              <span class="ig-g" data-iggrip="1" title="끌어서 순서 바꾸기">⠿</span>
              <span class="ig-n">${i + 1}</span>
              <span class="ig-x" data-igdel="${i}" title="이 사진 빼기">✕</span>
            </button>`;
    });
    if (list.length < _IG_MAX) {
      h += `<button type="button" class="ig-add" data-igadd="1" title="사진 추가">
              <span class="plus">＋</span><span>추가</span></button>`;
    }
  }
  strip.innerHTML = h;
  strip.classList.toggle("err", list.some(x => x.state === "bad"));
  if (list.length > _IG_MAX) {
    _igSay(field, `${_IG_MAX}장을 넘겼어요 — ${list.length - _IG_MAX}장을 빼주세요. (자동으로 지우지 않습니다)`, "warn");
  }
}

/** ★ 넣는 길 3가지가 전부 지나는 단 하나의 함수 */
async function _igUpload(field, file) {
  const list = window._igState[field] || (window._igState[field] = []);
  if (list.length >= _IG_MAX) { _igSay(field, `사진은 칸마다 최대 ${_IG_MAX}장까지 넣을 수 있어요 — 먼저 빼주세요.`, "warn"); return; }
  if (!/^image\//.test(file.type || "")) { _igSay(field, "사진 파일만 넣을 수 있어요.", "bad"); return; }
  if (file.size > _IG_MAX_MB * 1024 * 1024) { _igSay(field, `${_IG_MAX_MB}MB 이하 사진만 넣을 수 있어요.`, "bad"); return; }

  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file);
  });
  const item = { url: "", tok: "", src: dataUrl, state: "up", name: file.name || "paste.png" };
  list.push(item);
  _igRender(field);
  _igSay(field, "사진을 올리는 중… 끝나면 저장할 수 있어요.", "warn");
  try {
    const resp = await fetch(API_BASE_URL + "/api/order/guide-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ imageBase64: dataUrl.split(",")[1], mimeType: file.type || "image/png",
                             fileName: `wd_${field}_${Date.now()}` }),
    });
    const j = await resp.json();
    if (!resp.ok || !j.ok || !j.url || !_IG_URL_RE.test(String(j.url))) throw new Error(j.error || "업로드 실패");
    item.url = String(j.url); item.tok = _igTok(item.url); item.state = "ok";
    _igSay(field, _igBusy() ? "사진을 올리는 중…" : "사진이 추가되었습니다.", _igBusy() ? "warn" : "ok");
  } catch (e) {
    item.state = "bad";
    _igSay(field, "사진을 올리지 못했어요 (" + e.message + ") — ✕로 빼고 다시 넣어주세요.", "bad");
  }
  _igRender(field);
  _onPreviewInput();
}

function igPickFiles(field, input) {
  const files = [...(input.files || [])];
  input.value = "";                                    // 같은 파일을 다시 고를 수 있게
  (async () => { for (const f of files) await _igUpload(field, f); })();
}

/* ── 확대 팝업 — body 직속 · 그 칸의 사진 안에서만 이동 · 끝에서 순환하지 않는다 ── */
let _igLbList = [], _igLbIdx = 0, _igLbField = "";
function _igLightboxEl() {
  let el = document.getElementById("igLightbox");
  if (el) return el;
  el = document.createElement("div");
  el.id = "igLightbox";
  el.tabIndex = -1;                                     // ★ 열 때 여기로 포커스를 옮긴다(방향키 확보)
  el.innerHTML =
    `<div class="iglb-wrap">
       <img id="igLbImg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="">
       <button type="button" class="iglb-close" title="닫기 (Esc)">✕</button>
     </div>
     <div class="iglb-bar">
       <button type="button" class="iglb-btn" data-iglb="-1" title="이전 (←)">‹</button>
       <span id="igLbCnt">1 / 1</span>
       <button type="button" class="iglb-btn" data-iglb="1" title="다음 (→)">›</button>
     </div>
     <div class="iglb-fld" id="igLbFld"></div>
     <div class="iglb-tip">← → 이동 · Esc 닫기 · 바깥을 눌러도 닫혀요</div>`;
  document.body.appendChild(el);                        // ★ body 직속(모달 스크롤 컨테이너 밖)
  el.addEventListener("click", (e) => {
    const step = e.target.closest("[data-iglb]");
    if (step) { _igLbStep(Number(step.getAttribute("data-iglb"))); return; }
    if (e.target === el || e.target.closest(".iglb-close")) _igLbClose();
  });
  return el;
}
let _igLbOpener = null;   // 닫을 때 포커스를 돌려줄 곳(원래 있던 자리)
function _igLbOpen(field, i) {
  _igLbList = _igOk(field);
  if (!_igLbList.length) return;
  _igLbField = field;
  _igLbIdx = Math.max(0, Math.min(i, _igLbList.length - 1));
  const el = _igLightboxEl();
  el.classList.add("on");
  /* ★★ 포커스를 팝업으로 가져온다 — 글을 쓰다가 썸네일을 누른 경우 포커스가 textarea 에
     남아 **방향키가 무시**됐다(실측: 텍스트칸 포커스 상태로 열면 ← → 가 안 먹음).
     닫을 때는 원래 자리로 돌려준다(작성 흐름이 끊기지 않게). */
  _igLbOpener = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
  _igLbPaint();
}
function _igLbPaint() {
  const it = _igLbList[_igLbIdx]; if (!it) return;
  const el = _igLightboxEl();
  el.querySelector("#igLbImg").src = it.url || it.src;
  el.querySelector("#igLbCnt").textContent = `${_igLbIdx + 1} / ${_igLbList.length}`;
  el.querySelector("#igLbFld").textContent = _IG_FIELDS[_igLbField] || "";
  el.querySelectorAll("[data-iglb]").forEach(b => {
    b.disabled = Number(b.getAttribute("data-iglb")) < 0 ? _igLbIdx === 0 : _igLbIdx === _igLbList.length - 1;
  });
}
function _igLbStep(d) {
  const n = _igLbIdx + d;
  if (n < 0 || n >= _igLbList.length) return;          // 끝에서 순환하지 않는다
  _igLbIdx = n; _igLbPaint();
}
function _igLbClose() {
  const el = document.getElementById("igLightbox");
  if (el) { el.classList.remove("on"); const im = el.querySelector("#igLbImg"); if (im) im.removeAttribute("src"); }
  // 포커스를 원래 자리로(없어졌으면 그냥 둔다 — 엉뚱한 곳으로 옮기지 않는다)
  if (_igLbOpener && document.contains(_igLbOpener)) { try { _igLbOpener.focus({ preventScroll: true }); } catch (_) {} }
  _igLbOpener = null;
}

/* ── 배선: 스트립 클릭·붙여넣기·드래그 · 키 리스너는 최상위 1회 ── */
let _igDrag = { field: "", i: -1 };
function _igBind(field) {
  const strip = document.getElementById("rf_ig_" + field);
  const ta = document.getElementById(_IG_TA[field]);
  if (!strip || strip.dataset.igBound === "1") return;
  strip.dataset.igBound = "1";

  strip.addEventListener("click", (e) => {
    const del = e.target.closest("[data-igdel]");
    if (del) {
      e.stopPropagation();
      const i = Number(del.getAttribute("data-igdel"));
      if (confirm(`이 사진을 ${_IG_FIELDS[field]}에서 뺄까요?`)) {
        (window._igState[field] || []).splice(i, 1);
        _igRender(field); _igSay(field, "사진을 뺐습니다.", "ok"); _onPreviewInput();
      }
      return;
    }
    if (e.target.closest("[data-igadd]")) { document.getElementById("rf_igf_" + field)?.click(); return; }
    const th = e.target.closest("[data-igi]");
    if (!th) return;
    const i = Number(th.getAttribute("data-igi"));
    const im = (window._igState[field] || [])[i];
    if (!im) return;
    if (im.state === "bad") { _igSay(field, "이 사진은 업로드에 실패했어요 — ✕로 빼고 다시 넣어주세요.", "bad"); return; }
    if (im.state === "up") { _igSay(field, "아직 올리는 중이에요.", "warn"); return; }
    _igLbOpen(field, _igOk(field).indexOf(im));
  });

  // Ctrl+V — 이미지일 때만 가로챈다(텍스트 붙여넣기는 기본 동작 유지)
  const onPaste = (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])]
      .filter(it => it.kind === "file" && /^image\//.test(it.type));
    if (!items.length) return;
    e.preventDefault();
    (async () => { for (const it of items) { const f = it.getAsFile(); if (f) await _igUpload(field, f); } })();
  };
  strip.addEventListener("paste", onPaste);
  if (ta) ta.addEventListener("paste", onPaste);

  // 바깥에서 온 파일 드래그 = 업로드 / 안에서 끄는 것 = 순서 변경 (dataTransfer 종류로 구분)
  const isFileDrag = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files");
  strip.addEventListener("dragover", (e) => {
    if (isFileDrag(e)) { e.preventDefault(); strip.classList.add("drag"); return; }
    if (_igDrag.field === field) { e.preventDefault(); _igMarkDrop(strip, e); }
  });
  strip.addEventListener("dragleave", (e) => { if (e.target === strip) { strip.classList.remove("drag"); _igClearMarks(strip); } });
  strip.addEventListener("drop", (e) => {
    if (isFileDrag(e)) {
      e.preventDefault(); strip.classList.remove("drag");
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      (async () => { for (const f of files) await _igUpload(field, f); })();
      return;
    }
    if (_igDrag.field !== field) return;
    e.preventDefault();
    const t = _igDropTarget(e);
    _igClearMarks(strip);
    if (!t) return;
    const list = window._igState[field] || [];
    let to = t.i + (t.after ? 1 : 0);
    const from = _igDrag.i;
    if (to > from) to--;
    if (to === from || from < 0) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    _igRender(field); _igSay(field, "순서를 바꿨습니다 — 리뷰어에게 이 순서로 보입니다.", "ok"); _onPreviewInput();
  });

  // ⠿ 손잡이를 누른 동안에만 draggable(입력 텍스트 선택·클릭 확대와 무충돌)
  strip.addEventListener("mousedown", (e) => {
    const th = e.target.closest("[data-igi]");
    if (th) th.setAttribute("draggable", e.target.closest("[data-iggrip]") ? "true" : "false");
  });
  strip.addEventListener("dragstart", (e) => {
    const th = e.target.closest("[data-igi]");
    if (!th || th.getAttribute("draggable") !== "true") { e.preventDefault(); return; }
    _igDrag = { field, i: Number(th.getAttribute("data-igi")) };
    th.classList.add("dragging");
    // 'Files'가 아닌 커스텀 종류만 담는다 → 업로드 경로가 이 드래그에 반응하지 않는다
    try { e.dataTransfer.setData("application/x-ig-reorder", String(_igDrag.i)); } catch (_) {}
    e.dataTransfer.effectAllowed = "move";
  });
  strip.addEventListener("dragend", () => { _igDrag = { field: "", i: -1 }; _igClearMarks(strip); _igRender(field); });
}
function _igDropTarget(e) {
  const th = e.target.closest ? e.target.closest("[data-igi]") : null;
  if (!th) return null;
  const r = th.getBoundingClientRect();
  // 오른쪽 절반에 놓으면 그 뒤 — 항상 앞이면 끝자리로 옮길 수가 없다
  return { i: Number(th.getAttribute("data-igi")), after: (e.clientX - r.left) > r.width / 2 };
}
function _igMarkDrop(strip, e) {
  _igClearMarks(strip);
  const t = _igDropTarget(e); if (!t) return;
  const th = strip.querySelector(`[data-igi="${t.i}"]`);
  if (th) th.classList.add(t.after ? "dropR" : "dropL");
}
function _igClearMarks(strip) {
  strip.querySelectorAll("[data-igi]").forEach(n => n.classList.remove("dropL", "dropR", "dragging"));
}

/* 키 리스너는 최상위 1회 — 팝업을 열 때마다 걸면 겹쳐 쌓여 한 번 눌러 여러 장 건너뛴다 */
if (typeof window !== "undefined" && !window._igKeyBound) {
  window._igKeyBound = true;
  document.addEventListener("keydown", (e) => {
    const el = document.getElementById("igLightbox");
    if (!el || !el.classList.contains("on")) return;
    /* ★★ 팝업이 열려 있는 동안에는 **포커스가 어디에 있든** ← → Esc 를 받는다.
       종전엔 input/textarea 포커스면 무시했는데, 글을 쓰다가 썸네일을 누르면 포커스가
       그대로 남아 **방향키가 안 먹었다**(실측 재현). 화면 전체를 덮은 팝업이 열린 상태에서
       타이핑 중일 수는 없다 — 그리드 방향키(입력 중 미가로채기) 규율과는 상황이 다르다.
       브라우저 단축키(Ctrl/Alt/Cmd 조합)는 그대로 흘려보낸다. */
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Escape") { _igLbClose(); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { _igLbStep(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { _igLbStep(1); e.preventDefault(); }
  });
  window.igPickFiles = igPickFiles;
  Object.keys(_IG_FIELDS).forEach(_igBind);
}

function _syncSourceWorkOrderLinkUi() {
  const sourceMode = !!_woPrefillOrderId;
  const sheetRow = document.getElementById("rf_sheet_link_row");
  const sourceInfo = document.getElementById("rf_work_order_link_info");
  const headingNote = document.getElementById("rf_link_heading_note");
  if (sheetRow) sheetRow.style.display = sourceMode ? "none" : "";
  if (headingNote) headingNote.textContent = sourceMode
    ? "작업오더 작업표에 자동 연결됩니다"
    : "시트·탭이 없으면 공고가 동작하지 않습니다";
  if (sourceInfo) {
    sourceInfo.style.display = "none";
    sourceInfo.textContent = "";
  }
}

/** 게시 전 자동 점검 — 서버 활성화 게이트와 동일 3항목(빠지면 active 저장이 서버에서 거부됨) */
function participationCheckErrors() {
  const errs = [];
  const tabKey = document.getElementById("rf_linked_tab")?.value || "";
  const tabMeta = _recruitTabList.find(x => x.key === tabKey);
  // 시트 미연결 공고는 허용한다. 다만 연결을 선택했다면 탭 gid까지 완성되어야
  // 리네임·시트쓰기 대상이 엇갈리지 않는다.
  if (tabKey && !(tabMeta && tabMeta.tabGid)) errs.push("선택한 시트 탭의 gid를 확인해주세요");
  const manager = document.getElementById("rf_manager")?.value.trim() || "";
  const channel = document.getElementById("rf_channel")?.value.trim() || "";
  const startDate = document.getElementById("rf_start_date")?.value || "";
  if (!manager) errs.push("담당자를 선택해주세요");
  if (!channel) errs.push("구매채널을 선택해주세요");
  if (!startDate) errs.push("모집 시작일을 입력해주세요");
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
  const tabKey = document.getElementById("rf_linked_tab")?.value || "";
  const _ws = document.getElementById("rf_window_start")?.value || "";
  const _we = document.getElementById("rf_window_end")?.value || "";
  const items = [
    {
      label: tabKey ? "시트 탭 연결됨 (gid)" : "시트 탭 미연결 — 나중에 추가 가능",
      fail: errs.some(e => e.includes("gid")),
    },
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

   ★★ 작업 종류 2모드(2026-08-07 우레온 건): 'none' = 옵션 없는 작업(옵션명 칸 없음) /
      'opt' = 옵션 있는 작업(상품 그룹 + 옵션 행). **모드가 옵션 유무의 단일 출처**라
      `readOptRows`·`_readProdRows` 둘 다 모드를 보고 판단한다 — 숨은 칸에 값이 남아 있어도
      옵션으로 새어 나가지 않는다(옵션 없는 작업에서 상품명 조각이 옵션이 되던 사고의 구조적 차단).
   ═══════════════════════════════════════ */
/** 현재 진행상품 입력 모드 — 'none'(옵션 없는 작업) | 'opt'(옵션 있는 작업) */
function _prodMode() {
  const el = document.getElementById("rf_prod_mode");
  return (el && el.value === "opt") ? "opt" : "none";
}
/** 모드 표시만 갱신(값 변환·재렌더 없음) */
function _applyProdModeUi(m) {
  const el = document.getElementById("rf_prod_mode"); if (el) el.value = m;
  const wrap = document.getElementById("rf_opt_wrap");
  if (wrap) { wrap.classList.toggle("rf-pm-opt", m === "opt"); wrap.classList.toggle("rf-pm-none", m !== "opt"); }
  document.querySelectorAll("#rf_prod_mode_sw .rf-pm-btn").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  // 버튼은 두 모드 모두 "상품 추가" — none 이면 상품 한 줄, opt 이면 상품 그룹(옵션은 그룹 안에서 추가)
  const add = document.getElementById("rf_opt_addbtn");
  if (add) add.innerHTML = '<i class="fas fa-plus"></i> 상품 추가';
}
/** 옵션 유무 선택 바로 아래 한 줄 안내. 진행상품 수가 아직 없으면 기본 1건으로 안내한다. */
function _renderProdModeHelp() {
  const el = document.getElementById("rf_prod_mode_help");
  if (!el) return;
  const mode = _prodMode();
  const productCount = Math.max(1, _readProdRows().filter(r => r.productName || r.payAmount).length);
  el.dataset.mode = mode;
  el.textContent = mode === "opt"
    ? "옵션을 추가하면 리뷰어가 참여 시 옵션을 직접 선택합니다(2개 이상일 때 선택창 노출)."
    : "옵션 없이 진행하는 작업 " + productCount + "건 — 리뷰어는 옵션 선택 없이 바로 참여합니다.";
}
/** 자동 판정 사유 문구(조용한 자동 선택 금지 — 왜 이 모드인지 화면이 말한다) */
function _setProdModeNote(txt) {
  const n = document.getElementById("rf_prod_mode_note");
  if (n) n.textContent = txt || "";
}
/**
 * 모드 전환(사람이 누름) — 값은 이월하고, 옵션을 없애는 방향일 때만 확인창.
 * ★ 조용히 값이 사라지지 않게: 살아있는 옵션이 있으면 몇 종이 정리되는지 먼저 말한다.
 */
function setProdMode(mode, opts) {
  const m = (mode === "opt") ? "opt" : "none";
  if (_prodMode() === m) return;
  const rows = _readProdRowsRaw();
  if (m === "none" && !(opts && opts.silent)) {
    const live = rows.filter(r => r.optKey && !r.closed);
    if (live.length && !confirm(
      "옵션 " + live.length + "종을 정리하고 '옵션 없는 작업'으로 바꿉니다.\n" +
      "이미 참여한 리뷰어가 있는 옵션은 기록 보호를 위해 마감 상태로 남습니다.\n\n계속할까요?")) return;
  }
  _applyProdModeUi(m);
  _setProdModeNote("");
  _renderProdModeHelp();
  _renderProdTable(_convertProdRows(rows, m));
}
/** 모드 전환 시 값 이월 — none↔opt 어느 쪽으로도 입력한 값이 사라지지 않게 */
function _convertProdRows(rows, m) {
  const list = rows || [];
  if (!list.length) return [];
  if (m === "opt") return list;                     // 옵션명 칸이 드러나며 그대로 이어 쓴다
  // opt → none: 상품 단위로 접는다(금액=첫 옵션, 인원·건수=합계, 하나라도 0이면 0=무제한)
  const out = [];
  list.forEach(r => {
    const key = r.productName || "";
    const g = out.length && out[out.length - 1].productName === key ? out[out.length - 1] : null;
    if (!g) { out.push({ productName: key, optKey: "", payAmount: r.payAmount, recruitTotal: r.recruitTotal, dailyLimit: r.dailyLimit, status: "active" }); return; }
    g.recruitTotal = (g.recruitTotal > 0 && r.recruitTotal > 0) ? g.recruitTotal + r.recruitTotal : 0;
    g.dailyLimit   = (g.dailyLimit   > 0 && r.dailyLimit   > 0) ? g.dailyLimit   + r.dailyLimit   : 0;
    if (!g.payAmount) g.payAmount = r.payAmount;
  });
  return out;
}
/**
 * 표 전체 렌더 — 모드에 맞는 모양으로 다시 그린다.
 * ★ 행 DOM(.rf-opt-row + 다섯 입력칸)은 두 모드 공통 — 'opt' 모드는 상품 그룹으로 감싸기만 한다.
 */
function _renderProdTable(rows) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  wrap.innerHTML = "";
  const list = rows || [];
  if (_prodMode() === "opt") {
    const groups = [];
    list.forEach(r => {
      const key = r.productName || "";
      const g = groups.length && groups[groups.length - 1].name === key ? groups[groups.length - 1] : null;
      if (g) g.rows.push(r); else groups.push({ name: key, rows: [r] });
    });
    if (!groups.length) groups.push({ name: "", rows: [{}] });
    groups.forEach(g => wrap.appendChild(_buildProdGroup(g)));
  } else {
    (list.length ? list : []).forEach(r => wrap.appendChild(_buildOptRowEl(r)));
  }
  _markDupProductNames();
  _optSummary();
  _syncPreviewFromOptRows();
  _syncGroupTotals();
  _syncQuotaLockUi();
}
/** 상품 그룹(옵션 있는 작업) — 머리(상품명·총인원 자동합계) + 옵션 행 + [＋ 옵션 추가] */
function _buildProdGroup(g) {
  const box = document.createElement("div");
  box.className = "rf-gp";
  const head = document.createElement("div");
  head.className = "rf-gp-head";
  head.innerHTML =
    '<input class="rform-input rf-gp-name" placeholder="상품명">' +
    '<span class="rf-gp-total" title="옵션인원 합계(자동)">–</span>' +
    '<button type="button" class="btn-icon-sm rf-gp-del" title="이 상품(옵션 전체) 삭제" style="color:#EF4444"><i class="fas fa-times"></i></button>';
  const nameEl = head.querySelector(".rf-gp-name");
  nameEl.value = g.name || "";
  // 그룹 상품명 → 그 그룹의 모든 옵션 행 상품명(숨은 칸)에 반영 — 저장 원문·정원 파생이 따라온다
  nameEl.addEventListener("input", () => {
    box.querySelectorAll(".rf-opt-row .rf-opt-prod").forEach(i => { i.value = nameEl.value; });
    _optSummary(); renderPartCheck(); _syncPreviewFromOptRows();
  });
  head.querySelector(".rf-gp-del").onclick = () => {
    box.remove(); _optSummary(); renderPartCheck(); _syncPreviewFromOptRows(); _syncGroupTotals();
  };
  box.appendChild(head);
  const body = document.createElement("div");
  body.className = "rf-gp-body";
  (g.rows.length ? g.rows : [{}]).forEach(r => body.appendChild(_buildOptRowEl(Object.assign({}, r, { productName: g.name || "" }))));
  box.appendChild(body);
  const add = document.createElement("button");
  add.type = "button"; add.className = "rf-gp-add"; add.textContent = "＋ 옵션 추가";
  add.onclick = () => {
    body.appendChild(_buildOptRowEl({ productName: nameEl.value }));
    _optSummary(); renderPartCheck(); _syncPreviewFromOptRows(); _syncGroupTotals();
  };
  box.appendChild(add);
  return box;
}
/** 상품 그룹 머리의 총인원(옵션인원 합계) 갱신 — 하나라도 0(무제한)이면 '무제한' */
function _syncGroupTotals() {
  document.querySelectorAll("#rf_opt_rows .rf-gp").forEach(box => {
    const el = box.querySelector(".rf-gp-total"); if (!el) return;
    const live = Array.from(box.querySelectorAll(".rf-opt-row")).filter(r => r.dataset.status !== "closed");
    const vals = live.map(r => Math.max(0, parseInt(r.querySelector(".rf-opt-rt").value, 10) || 0));
    el.textContent = !vals.length ? "–" : (vals.every(v => v > 0) ? vals.reduce((a, b) => a + b, 0) + "명" : "무제한");
  });
}

/** [＋ 상품 추가] — 옵션 없는 작업이면 상품 한 줄, 옵션 있는 작업이면 상품 그룹 하나를 더한다 */
function addOptRow(data) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  if (_prodMode() === "opt") {
    wrap.appendChild(_buildProdGroup({ name: (data && (data.productName ?? data.product_name)) || "", rows: [data || {}] }));
  } else {
    wrap.appendChild(_buildOptRowEl(data));
  }
  _markDupProductNames();
  _optSummary();
  _syncPreviewFromOptRows();
  _syncGroupTotals();
}

/** ★★ 정원(총인원·일건수) 잠금 — **수정 모드 + 옵션 없는 작업**에서만 켠다.
 *  왜: 이 표의 총인원·일건수는 **캠페인 정원(recruit_total·daily_limit)의 파생 입력**인데,
 *  옵션 없는 작업은 원장(campaign_options)이 비어 있어 표를 **작업내용 상품 원문에서 다시
 *  파싱해** 만든다. 상품 원문이 두 줄 이상이면 파싱 결과에 인원이 없어 0(무제한)으로 떨어지고,
 *  그대로 저장하면 **총 200건이 무제한으로, 일건수가 엉뚱한 값으로 리셋**된다(실측 재현).
 *  정원의 진실원본은 [📅 모집인원 조절](차수·날짜별 계획)이므로, 수정 화면에서는 **읽기 전용**으로
 *  보여주기만 하고 저장에도 싣지 않는다(미전송 = 서버 COALESCE 유지).
 *  ★ 옵션 있는 작업은 옵션 원장이 서버에서 그대로 오므로 파생이 정확 — 종전대로 편집 가능.
 *  ★ 신규 발행은 여기가 초도 정원을 정하는 유일한 창구라 잠그지 않는다. */
let _rfQuotaUnlock = false;   // 사람이 명시적으로 연 경우만 true (모달을 열 때마다 리셋)

function _rfQuotaApplicable() { return !!_recruitEditId && _prodMode() !== "opt"; }
function _rfQuotaLocked() { return _rfQuotaApplicable() && !_rfQuotaUnlock; }

/** 잠금/해제 안내 줄 — "왜 못 고치는가 · 어디서 고치는가 · 열면 무엇이 덮이는가"를 말한다.
 *  ★ 잠그기만 하면 **기본 일건수를 고칠 창구가 사라진다**([📅 인원]은 날짜별 조절·차수 담당) —
 *    그래서 [🔓 직접 수정] 탈출구를 두되, 열면 저장 시 덮일 값을 실시간으로 보여준다(조용한 리셋 금지). */
function _syncQuotaLockUi() {
  const box = document.getElementById("rf_quota_lock");
  if (!box) return;
  if (!_rfQuotaApplicable()) { box.hidden = true; box.textContent = ""; box.classList.remove("open"); return; }
  const num = (v) => Number(v || 0);
  const rt = num(document.getElementById("rf_recruit_total")?.value);
  const dl = num(document.getElementById("rf_daily_limit")?.value);
  const fmt = (v, zero) => (v > 0 ? v.toLocaleString() + "명" : zero);
  box.hidden = false;
  box.classList.toggle("open", !!_rfQuotaUnlock);
  box.innerHTML = _rfQuotaUnlock
    ? '<b>🔓 총인원 · 일건수를 직접 수정 중</b>' +
      '<span>저장하면 <b>총 ' + fmt(rt, "무제한") + ' · 일건수 ' + fmt(dl, "무제한") + '</b> 상태로 덮어씁니다.</span>' +
      '<span>표의 상품 줄에 인원이 비어 있으면 합계가 <b>무제한(0)</b> 이 됩니다 — 위 숫자를 확인하세요. ' +
      '<button type="button" class="rf-qbtn" onclick="rfQuotaLock()">🔒 다시 잠그기</button></span>'
    : '<b>🔒 총인원 · 일건수는 여기서 바꾸지 않습니다</b>' +
      '<span>지금 값 — 총 ' + fmt(rt, "무제한") + ' · 기본 일건수 ' + fmt(dl, "미설정") + '</span>' +
      '<span>변경은 공고 카드의 <b>[📅 인원]</b>(모집인원 조절)에서 — 총량은 차수 추가, 그날 인원은 날짜별 조절로. ' +
      '저장해도 이 값들은 바뀌지 않습니다. ' +
      '<button type="button" class="rf-qbtn" onclick="rfQuotaUnlock()">🔓 직접 수정</button></span>';
}

/** 표를 지금 값 그대로 다시 그린다(잠금 상태만 바뀐다) */
function _rfRerenderProdRows() {
  const rows = _readProdRowsRaw().map(r => Object.assign({}, r, { status: r.closed ? "closed" : "active" }));
  _renderProdTable(rows);
}
function rfQuotaUnlock() {
  if (!confirm("총인원 · 일건수를 직접 수정할까요?\n\n저장하면 표에서 계산된 값으로 원장이 덮어써집니다.\n(정상 경로는 공고 카드의 [📅 인원] — 차수 추가 · 날짜별 조절입니다)")) return;
  _rfQuotaUnlock = true;
  _rfRerenderProdRows();
}
function rfQuotaLock() { _rfQuotaUnlock = false; _rfRerenderProdRows(); }
window.rfQuotaUnlock = rfQuotaUnlock;
window.rfQuotaLock = rfQuotaLock;

/** 행 하나 생성(두 모드 공통 DOM) — 붙이는 곳은 호출부가 정한다 */
function _buildOptRowEl(data) {
  const d = data || {};
  const status = (d.status === "closed") ? "closed" : "active";   // ★ 마감 상태 보존(리뷰 #1 — 저장 라운드트립에서 재활성화 방지)
  const row = document.createElement("div");
  row.className = "rf-opt-row";
  row.dataset.status = status;
  row.dataset.reviewTypeMix = JSON.stringify(Array.isArray(d.reviewTypeMix ?? d.review_type_mix) ? (d.reviewTypeMix ?? d.review_type_mix) : []);
  if (status === "closed") row.style.opacity = ".68";
  const lastBtn = status === "closed"
    ? '<button type="button" class="btn-icon-sm rf-opt-reopen" title="옵션 재개(다시 모집)" style="color:#12b886"><i class="fas fa-rotate-left"></i></button>'
    : '<button type="button" class="btn-icon-sm rf-opt-del" title="이 옵션 삭제" style="color:#EF4444"><i class="fas fa-times"></i></button>';
  row.innerHTML =
    '<input class="rform-input rf-opt-url" type="url" inputmode="url" maxlength="2048" placeholder="옵션 URL">' +
    '<input class="rform-input rf-opt-prod" placeholder="상품명">' +
    '<input class="rform-input rf-opt-name" placeholder="옵션명(없으면 비움)">' +
    '<input class="rform-input rf-opt-pay" type="number" min="0" placeholder="금액">' +
    '<input class="rform-input rf-opt-rt" type="number" min="0" placeholder="총">' +
    '<input class="rform-input rf-opt-dl" type="number" min="0" placeholder="일">' +
    lastBtn;
  const rt = d.recruitTotal ?? d.recruit_total, dl = d.dailyLimit ?? d.daily_limit, pay = d.payAmount ?? d.pay_amount;
  // 상품명은 옵션 테이블에 없던 값 — 넘겨받지 않았으면 바로 위 행에서 따라온다(반복 입력 제거)
  row.querySelector(".rf-opt-prod").value = d.productName ?? d.product_name ?? _lastOptProductName();
  row.querySelector(".rf-opt-url").value = d.optionUrl ?? d.option_url ?? d.url ?? "";
  row.querySelector(".rf-opt-name").value = d.optKey ?? d.opt_key ?? "";
  row.querySelector(".rf-opt-pay").value  = pay ? pay : "";
  row.querySelector(".rf-opt-rt").value   = rt ? rt : "";     // 0/무제한은 빈칸으로
  row.querySelector(".rf-opt-dl").value   = dl ? dl : "";
  /* ★ 정원 잠금(수정 + 옵션 없는 작업) — 표시만 하고 편집·저장 대상에서 뺀다 */
  if (_rfQuotaLocked()) {
    [".rf-opt-rt", ".rf-opt-dl"].forEach(sel => {
      const el = row.querySelector(sel);
      if (!el) return;
      el.readOnly = true;
      el.tabIndex = -1;
      el.classList.add("rf-locked");
      el.title = "총인원·일건수는 [📅 인원](모집인원 조절)에서 바꿉니다";
    });
  }
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
  // 옵션인원이 바뀌면 상품 그룹 머리의 총인원(자동합계)도 따라온다
  const rtEl = row.querySelector(".rf-opt-rt");
  if (rtEl) rtEl.addEventListener("input", _syncGroupTotals);
  return row;
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

/**
 * 표 프리필 — 모드를 **먼저 자동 판정**한 뒤 그 모드로 그린다.
 * ★ 판정은 "살아있는 옵션이 있는가" 하나 — 서버 apply 게이트(`liveOptions`)와 같은 기준이라
 *   "화면은 옵션 공고인데 참여는 옵션을 안 받는"(또는 그 반대) 불일치가 생기지 않는다.
 * ★ 자동은 제안까지 — 사람이 스위치로 언제든 바꾼다.
 */
function renderOptRows(options, opts) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  const list = options || [];
  const live = list.filter(o => (o.optKey || o.opt_key) && (o.status || "active") !== "closed");
  const forced = opts && opts.mode;
  const m = forced || (live.length ? "opt" : "none");
  _applyProdModeUi(m);
  // 사유는 값이 있을 때만 — 빈 표(신규 공고)에 "자동 선택됨"이라 하면 정하지 않은 것을 정했다고 말하는 셈이다
  _setProdModeNote((forced || !list.length) ? "" : (live.length
    ? "옵션 " + live.length + "종이 확인되어 자동 선택됨"
    : "옵션 정보가 없어 자동 선택됨"));
  _renderProdTable(list.map(o => ({
    productName: o.productName ?? o.product_name ?? "",
    optionUrl:   o.optionUrl ?? o.option_url ?? o.url ?? "",
    optKey:      o.optKey ?? o.opt_key ?? "",
    payAmount:   o.payAmount ?? o.pay_amount ?? 0,
    recruitTotal: o.recruitTotal ?? o.recruit_total ?? 0,
    dailyLimit:  o.dailyLimit ?? o.daily_limit ?? 0,
    reviewTypeMix: o.reviewTypeMix ?? o.review_type_mix ?? [],
    status:      o.status === "closed" ? "closed" : "active",
  })));
}

/**
 * 편집 프리필 — 옵션 원장에는 **상품명이 없다**(campaign_options는 옵션 단위).
 * 그래서 작업내용 원문(productLines)을 분해해 옵션명으로 상품명을 되찾아 표를 채운다.
 * 옵션이 없는 단일상품 공고는 원문만으로 행을 만든다(표가 비어 보이지 않게).
 */
function renderOptRowsWithProduct(options, productLines, campaign) {
  const parsed = parseProductLinesToRows(productLines);
  const byOpt = new Map();
  parsed.forEach(r => { if (r.optKey) byOpt.set(r.optKey, r); });
  const opts = options || [];
  if (!opts.length) {
    // ★★ 옵션 원장이 비어 있으면 이 공고는 **확정적으로** 옵션 없는 공고다 —
    //   원문 분해(parseProductLinesToRows)가 상품명 속 하이픈·빗금을 옵션으로 쪼갰더라도
    //   그 추측을 옵션으로 승격시키지 않고 상품명으로 되붙인다(우레온 사고 경로 차단).
    const fallback = campaign || {};
    /* ★ 총인원·일건수는 캠페인 원장 값이다(상품 줄 수와 무관) — 종전엔 원문이 두 줄 이상이면
       0 으로 떨어져 화면이 '무제한'을 보여주고, 저장하면 그대로 리셋됐다. 첫 행에만 싣는다. */
    renderOptRows(parsed.map((r, i) => ({
      productName: [r.productName, r.optKey].filter(Boolean).join(" "),
      optKey: "", payAmount: r.payAmount,
      recruitTotal: i === 0 ? (fallback.recruit_total ?? 0) : 0,
      dailyLimit: i === 0 ? (fallback.daily_limit ?? 0) : 0,
    })), { mode: "none" });
    return;
  }
  const firstProd = parsed.length ? parsed[0].productName : "";
  renderOptRows(opts.map(o => {
    const key = o.optKey || o.opt_key || "";
    const hit = byOpt.get(key);
    return { ...o, productName: (hit && hit.productName) || firstProd || "" };
  }));
}

/** 옵션표 → 저장 payload 배열(빈 옵션명 제거, '|' 정규화, 마감상태 보존)
 *  ★★ 모드가 옵션 유무의 단일 출처 — '옵션 없는 작업'이면 숨은 칸에 값이 남아 있어도 **무조건 빈 배열**.
 *     (서버는 빈 배열을 "옵션 정리"로 받아 참여자 없는 옵션은 삭제·있는 옵션은 마감 보존한다) */
function _rfHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048) return "";
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : "";
  } catch (_) {
    return "";
  }
}

function readOptRows() {
  const out = [];
  if (_prodMode() !== "opt") return out;
  document.querySelectorAll("#rf_opt_rows .rf-opt-row").forEach(r => {
    const optionUrl = String(r.querySelector(".rf-opt-url")?.value || "").trim();
    const optKey = String(r.querySelector(".rf-opt-name").value || "").replace(/\|/g, "").trim();
    if (!optKey) return;                       // 옵션명 없는 행 = 단일상품 — 옵션 원장에는 넣지 않는다
    out.push({
      optKey,
      optionUrl,
      payAmount:     Math.max(0, parseInt(r.querySelector(".rf-opt-pay").value, 10) || 0),
      recruitTotal:  Math.max(0, parseInt(r.querySelector(".rf-opt-rt").value, 10) || 0),
      dailyLimit:    Math.max(0, parseInt(r.querySelector(".rf-opt-dl").value, 10) || 0),
      reviewTypeMix: typeof _readOptionReviewMix === "function" ? _readOptionReviewMix(r) : [],
      status:        r.dataset.status === "closed" ? "closed" : "active",   // ★ 마감상태 보존(리뷰 #1)
    });
  });
  return out;
}

/** 표의 모든 행(옵션명 없는 단일상품 포함) — 작업내용 원문·정원 합계 산출용
 *  ★ '옵션 없는 작업' 모드에서는 optKey 를 읽지 않는다 — 숨은 칸의 잔여값이
 *    작업내용 원문(`rf_wd_product`)에 "상품명 - 옵션명"으로 새어 나가는 것을 막는다. */
function _readProdRows() {
  const noOpt = _prodMode() !== "opt";
  return _readProdRowsRaw().map(r => (noOpt ? Object.assign({}, r, { optKey: "" }) : r));
}
/** DOM 그대로 읽기(모드 무시) — 모드 전환 시 값 이월용. 저장·파생은 반드시 `_readProdRows` 를 쓴다. */
function _readProdRowsRaw() {
  const out = [];
  document.querySelectorAll("#rf_opt_rows .rf-opt-row").forEach(r => {
    const productName = String(r.querySelector(".rf-opt-prod").value || "").trim();
    const optionUrl   = String(r.querySelector(".rf-opt-url")?.value || "").trim();
    const optKey      = String(r.querySelector(".rf-opt-name").value || "").replace(/\|/g, "").trim();
    const payAmount   = Math.max(0, parseInt(r.querySelector(".rf-opt-pay").value, 10) || 0);
    const recruitTotal = Math.max(0, parseInt(r.querySelector(".rf-opt-rt").value, 10) || 0);
    const dailyLimit   = Math.max(0, parseInt(r.querySelector(".rf-opt-dl").value, 10) || 0);
    if (!productName && !optKey && !payAmount) return;   // 완전 빈 행 제외
    out.push({ productName, optionUrl, optKey, payAmount, recruitTotal, dailyLimit,
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
  /* ★★ 잠금 상태에서는 캠페인 정원을 표에서 다시 만들지 않는다 —
     옵션 없는 작업의 표는 상품 원문 파싱본이라 인원이 0으로 떨어질 수 있고,
     그 0 이 그대로 저장되면 총량이 '무제한'으로 리셋된다(이번 사고). */
  if (!_rfQuotaLocked()) {
    if (rt) rt.value = live.length && live.every(r => r.recruitTotal > 0) ? live.reduce((a, r) => a + r.recruitTotal, 0) : 0;
    if (dl) dl.value = live.length && live.every(r => r.dailyLimit > 0)   ? live.reduce((a, r) => a + r.dailyLimit, 0)   : 0;
  }
  if (typeof syncRecruitReviewTypeMix === "function") syncRecruitReviewTypeMix();
  syncRecruitProductMainUrl();
  _markDupProductNames();
  _optSummary();     // 프로그램으로 표를 바꿔도(작업오더 자동 적용 등) 요약이 따라오게
  _syncGroupTotals();
  _syncQuotaLockUi();   // 해제 상태에서 "저장하면 덮일 값"이 입력과 함께 따라오게
  if (typeof _renderPreview === "function") _renderPreview();
}

/** 상품메인 URL은 관리자가 편집하며 공고의 landing URL로 함께 저장한다. */
function syncRecruitProductMainUrl() {
  const input = document.getElementById("rf_product_url");
  const landing = document.getElementById("rf_landing_url");
  if (!input || !landing) return;
  landing.value = String(input.value || "").trim();
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

/** 작업오더 상품정보를 표에 적용 — 옵션 배열(구조 신호)이 있으면 그대로, 없으면 텍스트를 분해.
 *  ★★ 옵션 배열이 없으면 그 오더는 **옵션 없는 작업**이다(구조 신호가 곧 사실) —
 *    텍스트 분해가 상품명 속 하이픈·빗금을 옵션처럼 쪼개도 옵션으로 승격시키지 않는다.
 *    (2026-08-07 우레온 건: 상품명 조각이 옵션명이 되어 공고가 잠겼다) */
function applyProductRowsFromOrder(prefill) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  const p = prefill || {};
  const sourceMode = p.productMode === "opt" ? "opt" : "";
  const sourceOptions = (Array.isArray(p.options) ? p.options : []).map(o => ({
      productName: o.productName || p.product_name || "",
      optionUrl: o.optionUrl || o.option_url || o.url || "",
      optKey: o.optKey || o.opt_key || "",
      payAmount: o.payAmount || o.pay_amount || 0,
      recruitTotal: o.recruitTotal || 0, dailyLimit: o.dailyLimit || 0,
    }));
  // 옵션 없는 단일 상품은 표가 모집공고의 정원 단일 출처다. 인트라넷이
  // 총인원·일건수를 상품 행이 아니라 오더 상단에 보낸 경우, 0인 행을 그대로
  // 그리면 `_syncPreviewFromOptRows()`가 방금 채운 총인원/일건수를 다시 0으로 덮는다.
  if (sourceOptions.length === 1) {
    sourceOptions[0].recruitTotal ||= Number(p.recruit_total) || 0;
    sourceOptions[0].dailyLimit ||= Number(p.daily_limit) || 0;
  }
  if (sourceMode) {
    renderOptRows(sourceOptions, { mode: sourceMode });
    _setProdModeNote("작업오더의 옵션 정보로 자동 선택됨");
    return;
  }
  if (sourceOptions.length) {
    renderOptRows(sourceOptions, { mode: "opt" });
    _setProdModeNote("작업오더의 옵션 정보로 자동 선택됨");
    return;
  }
  if (!p.wd_product) return;
  const rows = parseProductLinesToRows(p.wd_product, p.product_name);
  if (!rows.length) return;
  // 구조화 옵션이 없는 인트라넷 오더는 여기서 평문 상품행으로 내려온다.
  // 단일 상품일 때 총인원·일건수는 오더 상단 값이므로 그 행에 옮겨야
  // `_syncPreviewFromOptRows()`가 합계를 0(무제한)으로 재계산하지 않는다.
  if (rows.length === 1) {
    rows[0].recruitTotal ||= Number(p.recruit_total) || 0;
    rows[0].dailyLimit ||= Number(p.daily_limit) || 0;
  }
  renderOptRows(rows.map(r => ({
    productName: [r.productName, r.optKey].filter(Boolean).join(" "),   // 쪼개진 조각은 상품명으로 되붙인다
    optKey: "", payAmount: r.payAmount, recruitTotal: r.recruitTotal, dailyLimit: r.dailyLimit,
  })), { mode: "none" });
  _setProdModeNote("작업오더에 옵션이 없어 자동 선택됨");
}

/** 옵션표 요약·자동점검(정원합/하루합/중복). 반환: { dup, count } — 저장 시 중복 하드블록용 */
/** 옵션표 요약·자동점검(정원합/하루합/중복). 반환: { dup, count } — 저장 시 중복 하드블록용 */
function _optSummary() {
  _renderProdModeHelp();
  const el = document.getElementById("rf_opt_summary");
  const opts = readOptRows();
  const names = opts.map(o => o.optKey.toLowerCase());
  const dup = names.some((n, i) => names.indexOf(n) !== i);
  if (!el) return { dup, count: opts.length };
  if (!opts.length) {
    el.textContent = _prodMode() === "opt" ? "옵션을 추가하세요." : "상품을 추가하세요.";
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
   📅 기간별 리뷰비(082) — 구간표

   같은 캠페인이라도 7월 참여자는 1,000원, 8월 참여자는 1,500원처럼 날짜별로 금액이 다를 때 쓴다.
   ★ 구간 0개 = 기능 끔 = 위 '리뷰비' 한 값으로 **종전과 100% 동일** 동작(opt-in).
   ★ 종료일은 받지 않는다 — 시작일만 받으면 "다음 구간 시작 전날까지"가 자동이라
     빈틈(그날 금액 없음)·겹침(어느 쪽인지 모름)이 구조적으로 불가능하다.
   ★ 이미 참여한 건은 서버가 참여 시점 금액을 새겨 두므로(review_fee_snapshot)
     여기서 구간을 고쳐도 과거 참여자의 리뷰 내역·누적 합계는 바뀌지 않는다.
═══════════════════════════════════════ */
function _feeToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);   // KST
  return d.toISOString().slice(0, 10);
}

/** 미리보기 카드용 "오늘 적용 리뷰비". 구간이 없거나 스위치가 꺼져 있으면 입력값 그대로. */
function _feePreviewToday(fallback) {
  try {
    if (!document.getElementById("rf_fee_rows")) return fallback;
    if (!document.getElementById("rf_fee_sched_on")?.checked) return fallback;
    const today = _feeToday();
    let cur = null;
    readFeeRows().forEach(r => { if (r.effectiveFrom <= today) cur = r; });
    return cur ? cur.reviewFee : fallback;
  } catch (_) { return fallback; }
}

function addFeeRow(data) {
  const wrap = document.getElementById("rf_fee_rows");
  if (!wrap) return;
  const d = data || {};
  const div = document.createElement("div");
  div.className = "rf-fee-row";
  div.innerHTML =
    '<input type="date" class="rform-input rf-fee-from" value="' + (d.effectiveFrom || d.effective_from || "") + '" oninput="renderFeeSchedule()">' +
    '<input type="number" min="0" step="100" class="rform-input rf-fee-amt" placeholder="예) 1000" value="' +
      (d.reviewFee != null ? d.reviewFee : (d.review_fee != null ? d.review_fee : "")) + '" oninput="renderFeeSchedule()">' +
    '<input type="text" class="rform-input rf-fee-memo" maxlength="200" placeholder="예) 8월 단가 인상" value="' +
      String(d.memo || "").replace(/"/g, "&quot;") + '">' +
    '<button type="button" class="rf-fee-del" title="구간 삭제" onclick="this.parentNode.remove();renderFeeSchedule()">×</button>';
  wrap.appendChild(div);
  renderFeeSchedule();
}

/** 구간 목록 렌더(프리필·초기화 공용). 구간이 있으면 스위치를 자동으로 켠다. */
function renderFeeRows(list) {
  const wrap = document.getElementById("rf_fee_rows");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = Array.isArray(list) ? list : [];
  rows.forEach(r => addFeeRow(r));
  const sw = document.getElementById("rf_fee_sched_on");
  if (sw) { sw.checked = rows.length > 0; onFeeScheduleToggle(sw.checked); }
  renderFeeSchedule();
}

function onFeeScheduleToggle(on) {
  const input = document.getElementById("rf_fee_sched_on");
  if (input) input.checked = !!on;
  const toggle = document.getElementById("rf_fee_sched_toggle");
  const state = document.getElementById("feeScheduleState");
  toggle?.classList.toggle("on", !!on); toggle?.setAttribute("aria-pressed", String(!!on));
  if (state) state.textContent = on ? "사용" : "사용 안 함";
  const sec = document.getElementById("rf_fee_sched_section");
  if (sec) sec.style.display = on ? "" : "none";
  // 켤 때 비어 있으면 첫 줄을 오늘 날짜·현재 리뷰비로 깔아준다(빈 표를 마주하지 않게)
  if (on) {
    const wrap = document.getElementById("rf_fee_rows");
    if (wrap && !wrap.children.length) {
      addFeeRow({ effectiveFrom: _feeToday(), reviewFee: document.getElementById("rf_review_fee")?.value || "" });
    }
  }
  renderFeeSchedule();
}

/** 표 → 저장 payload 배열. 날짜·금액이 비면 그 줄은 제외(부분 입력 중 저장 방해 금지). */
function readFeeRows() {
  const out = [];
  document.querySelectorAll("#rf_fee_rows .rf-fee-row").forEach(r => {
    const from = String(r.querySelector(".rf-fee-from").value || "").trim();
    const amtRaw = r.querySelector(".rf-fee-amt").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || amtRaw === "") return;
    out.push({
      effectiveFrom: from,
      reviewFee: Math.max(0, parseInt(amtRaw, 10) || 0),
      memo: String(r.querySelector(".rf-fee-memo").value || "").trim(),
    });
  });
  return out.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/** 요약 + 자동점검(경고 위주 — 하드블록은 '같은 날짜 중복' 하나뿐: 어느 금액인지 정할 수 없다) */
function renderFeeSchedule() {
  const wrap = document.getElementById("rf_fee_rows");
  if (!wrap) return { dup: false, count: 0 };
  const on = !!document.getElementById("rf_fee_sched_on")?.checked;
  const rows = readFeeRows();
  const today = _feeToday();

  // 오늘 적용 구간 표시(시작일 ≤ 오늘 중 가장 늦은 것) — 서버 판정과 같은 규칙
  let curFrom = null;
  rows.forEach(r => { if (r.effectiveFrom <= today) curFrom = r.effectiveFrom; });
  document.querySelectorAll("#rf_fee_rows .rf-fee-row").forEach(el => {
    const v = el.querySelector(".rf-fee-from").value;
    el.classList.toggle("rf-fee-now", !!curFrom && v === curFrom);
  });

  const froms = rows.map(r => r.effectiveFrom);
  const dup = froms.some((f, i) => froms.indexOf(f) !== i);
  const cur = curFrom ? rows.filter(r => r.effectiveFrom === curFrom).pop() : null;

  const sum = document.getElementById("rf_fee_summary");
  if (sum) {
    sum.innerHTML = !on || !rows.length ? ""
      : ("구간 " + rows.length + "개 · 오늘 적용 <b style='color:#0ca678'>" +
         (cur ? Number(cur.reviewFee).toLocaleString() + "원" : "기본 리뷰비") + "</b>");
  }

  const chk = [];
  if (on) {
    if (dup) chk.push(["err", "같은 시작일이 두 번 있어요 — 어느 금액인지 정할 수 없습니다(저장 불가)"]);
    if (!rows.length) chk.push(["warn", "구간이 없어 위 <b>리뷰비</b> 한 값이 그대로 쓰입니다(현재 동작과 동일)"]);
    const startEl = document.getElementById("rf_start_date");
    const campStart = startEl && startEl.value;
    if (rows.length && campStart && rows[0].effectiveFrom > campStart) {
      chk.push(["warn", "첫 구간(" + rows[0].effectiveFrom + ")이 공고 시작일(" + campStart +
        ")보다 늦어요 — 그 사이 참여 건에는 기본 리뷰비가 적용됩니다"]);
    }
    if (rows.length && !dup) {
      chk.push(["ok", "참여한 날짜의 금액이 그 리뷰어에게 <b>영구 고정</b>됩니다 — 나중에 금액을 올려도 과거 참여자 화면은 안 바뀝니다"]);
    }
  }
  const box = document.getElementById("rf_fee_check");
  if (box) {
    box.innerHTML = chk.map(c =>
      '<div class="rf-fee-chk ' + c[0] + '">' + (c[0] === "ok" ? "✅" : c[0] === "warn" ? "⚠️" : "⛔") +
      "<span>" + c[1] + "</span></div>").join("");
  }
  return { dup, count: rows.length };
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
  window._recruitEditLoadedOpts = null;  // 저장 후 "바뀐 항목" 대조용 옵션표 원본(로드 실패 시 null=대조 안 함)
  window._recruitEditLoadedFees = null;
  _rfLastScheduledPurchaseWindow = { start: "", end: "" };
  _rfQuotaUnlock = false;   // ★ 지난 공고에서 연 잠금이 다음 공고로 새지 않게
  if (typeof recruitSaveBlockClear === "function") recruitSaveBlockClear();  // 지난번 차단 사유 잔류 방지
  _rfLinkedMiss = null; _rfSugCache = [];   // 지난 공고의 "탭 못 찾음" 사유가 새 모달에 남지 않게(로드보다 먼저)
  /* 저장 성공 시 버튼을 '✓ 저장됨'(비활성)으로 두고 모달을 닫으므로, 다시 열 때 되돌린다 */
  { const _sb = document.getElementById("recruitSaveBtn");
    if (_sb) { _sb.disabled = false; _sb.classList.remove("busy", "done"); _sb.innerHTML = '<i class="fas fa-save"></i> 저장'; } }

  /* ★★ 연결 탭 드롭다운은 `_recruitTabList` 에 의존한다 — 호스트가 채워 주지 않는 진입점이
     있으면 **시트 선택 자체가 불가능**하다(실측: 리뷰웹시스템[3버전] 모집공고 카드 [✏️ 수정]은
     campaign-cards.js 가 openRecruitModal 을 직접 불러 목록이 통째로 비어 있었다 →
     gid 연결이 구조적으로 불가능했고, 자동점검만 "gid 가 필요해요"라고 했다).
     진입점마다 호스트를 고치면 **새 진입점이 생길 때 또 빠진다** → 모달이 자기 의존을 보장한다.
     이미 채워져 있으면 재요청하지 않으므로 기존 경로의 동작·요청 수는 그대로. */
  if (!_recruitTabList.length) { try { await loadRecruitTabOptions(); } catch (_) {} }

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
  if (window.RecruitModal?.syncStatusButtons) window.RecruitModal.syncStatusButtons();
  // 상품정보 가져오기 초기화
  ["rf_product_url","rf_thumbnail","rf_thumb_url","rf_product_name","rf_price"].forEach(i => { const el = document.getElementById(i); if (el) el.value = ""; });
  const _pp = document.getElementById("rf_product_preview"); if (_pp) _pp.style.display = "none";
  document.getElementById("rf_channel_custom").style.display = "none";
  document.querySelectorAll(".rchan-btn").forEach(b => b.classList.remove("active"));
  _refreshBadgeWrap();
  document.getElementById("rf_linked_tab_info").style.display = "none";
  /* 🔗 연결 탭 안내·추천 초기화 — 지난번 공고의 사유가 새 모달에 남지 않게 */
  _rfLinkedMiss = null; _rfSugCache = [];
  { const _n = document.getElementById("rf_linked_tab_note"); if (_n) { _n.style.display = "none"; _n.innerHTML = ""; } }
  _populateCampaignSelect();   /* 1단계 캠페인 드롭다운 초기화 */
  _syncSourceWorkOrderLinkUi();

  /* ⚡ 참여형(M2) 필드 초기화 */
  ["rf_start_date","rf_window_start","rf_window_end","rf_daily_limit","rf_recruit_total","rf_landing_url",
   "rf_wd_product","rf_wd_inflow","rf_wd_review","rf_wd_notes"].forEach(i => {
    const el = document.getElementById(i); if (el) el.value = "";
  });
  const _skipWeekendsEl = document.getElementById("rf_skip_weekends");
  if (_skipWeekendsEl) _skipWeekendsEl.checked = false;
  const _cashReceiptRequiredEl = document.getElementById("rf_cash_receipt_required"); if (_cashReceiptRequiredEl) _cashReceiptRequiredEl.checked = false;
  // 혼합 리뷰 프리필은 동적으로 생성되는 입력칸의 진실원본이다. 새 모달을 열 때 이전 공고의
  // 수량이 섞이지 않도록 함께 초기화한다.
  window._rfGlobalReviewTypeMix = [];
  document.querySelectorAll('#rf_review_mix [data-mix-type]').forEach((el) => { el.value = '0'; });
  syncRecruitReviewTypeMix();
  const _ttlEl = document.getElementById("rf_hold_ttl"); if (_ttlEl) _ttlEl.value = "15";
  const _bufEl = document.getElementById("rf_close_buffer"); if (_bufEl) _bufEl.value = "10";
  /* ⏸ 098 이월 반영 초기화 — 신규 공고 기본 [자동](현행) */
  if (typeof rfCarrySet === "function" && document.getElementById("rf_carry_mode")) rfCarrySet("auto", { silent: true });
  /* 👥 타계정 참여(063) 초기화 — 신규 공고 기본 [불가] */
  const _maEl = document.getElementById("rf_multi_account");
  if (_maEl) { _maEl.checked = false; onMultiAccountToggle(false); }
  const _mdEl = document.getElementById("rf_multi_daily"); if (_mdEl) _mdEl.value = "1";
  const _stEl = document.getElementById("rf_sub_ttl"); if (_stEl) _stEl.value = "10";
  /* ★ v2: 참여형이 기본 — 신규 공고는 항상 켜져 열린다(스위치 UI 제거·hidden 체크박스 유지).
     레거시(일반) 공고를 편집할 땐 아래 프리필의 else 분기가 다시 끈다. */
  const _partEl = document.getElementById("rf_participation");
  if (_partEl) { _partEl.checked = true; onParticipationToggle(true); }
  rfBindPurchaseTimePicker();
  rfApplyPurchaseTime();
  if (typeof renderOptRows === "function") renderOptRows([]);   // 🧩 옵션표 초기화(061)
  if (typeof renderFeeRows === "function") renderFeeRows([]);   // 📅 기간별 리뷰비 초기화(082) — 신규 공고는 항상 꺼짐
  window._wdInflowRawHtml = null;
  const _ivTa = document.getElementById("rf_wd_inflow"); if (_ivTa) _ivTa.dataset.rawHtml = "";
  _igResetAll();                 // 🖼 작업내용 첨부 이미지 3칸 초기화
  ["inflow", "review", "notes"].forEach(f => _igSay(f, ""));
  _syncCampThumbUrlPreview();
  const _tfi = document.getElementById("rf_thumb_file"); if (_tfi) _tfi.value = "";
  /* 💸 086 이체 설정 초기화 — 신규 공고 기본 [자동](작업오더 물건비 판정을 계속 따라간다) */
  _rfPickTransferBank("");
  { const _tm = document.getElementById("rf_transfer_memo"); if (_tm) _tm.value = ""; }
  _rfTransferHint(prefill && prefill.goods_cost_type);

  if (id) {
    titleEl.innerHTML = `<i class="fas fa-pen"></i> 모집공고 수정`;
    /* 기존 데이터 로드 */
    try {
      /* ★ 경로는 호스트가 재기준한다(_campApi) — 관리자 대시보드는 종전 그대로 무인증 공개
         `/api/campaign/:id`(admin JWT 면 전체 행), 리뷰웹시스템[3버전]은 `/api/trackb/campaigns/:id`.
         인트라넷 SSO 토큰은 원본 경로에서 **무시**되어 공개 화이트리스트 뷰가 오므로
         수정 모달이 조용히 빈 칸으로 열린다 — 같은 핸들러를 Track B 로 태워야 전체 행이 온다. */
      const _detailUrl = _campApi(`/${encodeURIComponent(id)}`);
      const res  = await fetch(_detailUrl, {
        headers: _getAuthHeaders()
      });
      const json = await res.json();
      const c = json.data || json;
      // 수정 모달에는 전체 편집 응답만 허용한다. 공개용 축약 응답으로 저장하면 기존 값이 빈값으로 덮인다.
      if (!Object.prototype.hasOwnProperty.call(c, "work_detail")) {
        throw new Error("편집용 전체 공고 정보를 받지 못했습니다. 저장할 수 없습니다.");
      }
      window._recruitEditLoaded = c;   // ★ 064: sort_order 등 "UI 없는 서버 ||0 강제 필드"의 로드값 보존용
      window._recruitEditLoadedOpts = json.options || [];   // 저장 후 "바뀐 항목" 대조용(옵션표 원본)
      window._recruitEditLoadedFees = json.feeSchedules || [];
      document.getElementById("rf_title").value        = c.title || "";
      document.getElementById("rf_time_range").value   = c.time_range || "";
      document.getElementById("rf_review_fee").value   = c.review_fee || "";
      // 📅 082: 리뷰비 구간 프리필 — 구간이 있으면 스위치가 자동으로 켜진다(없으면 종전 화면 그대로)
      if (typeof renderFeeRows === "function") renderFeeRows(json.feeSchedules || []);
      // The compact editor intentionally does not render the legacy public-note
      // textarea.  Treat it as an optional compatibility field so an older
      // campaign cannot abort loading before its product and guide values are
      // restored into the visible compact fields.
      { const notesEl = document.getElementById("rf_notes"); if (notesEl) notesEl.value = c.notes || ""; }
      document.getElementById("rf_chat_url").value     = c.chat_url || "";
      // ★ 064: 노출 순서 UI 제거 — 요소가 남아있는 구버전 화면만 프리필(null-safe)
      { const _so = document.getElementById("rf_sort_order"); if (_so) _so.value = c.sort_order ?? 0; }
      document.getElementById("rf_max_slots").value    = c.max_slots ?? 0;
      document.getElementById("rf_status").value       = c.status || "draft";
      if (window.RecruitModal?.syncStatusButtons) window.RecruitModal.syncStatusButtons();
      document.getElementById("rf_delivery_type").value = c.delivery_type || "";
      const _cashReceiptRequiredEl = document.getElementById("rf_cash_receipt_required"); if (_cashReceiptRequiredEl) _cashReceiptRequiredEl.checked = c.cash_receipt_required === true;

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
      syncRecruitAutomaticBadges();
      _refreshBadgeWrap();

      /* 연결 탭 복원 */
      /* ★ 저장된 탭이 목록에 없으면(리네임·아카이브·미등록) select 가 조용히 비어 자동점검만
         "gid 가 필요해요"라고 한다 → 사유를 남겨 안내 박스가 설명하게 한다. */
      if (c.linked_tab_name && !_restoreLinkedTab(c.linked_sheet_id, c.linked_tab_name)) {
        _rfLinkedMiss = { source: "campaign", tabName: c.linked_tab_name,
                          sheetId: c.linked_sheet_id || "", orderId: null };
      }

      /* ⚡ 참여형(M2) 필드 복원 */
      {
        const pe = document.getElementById("rf_participation");
        const preserveLegacyCampaign = c.participation_mode === false;
        if (pe) {
          pe.checked = !preserveLegacyCampaign;
          // 기존 공고도 새 편집 UI에서 값을 확인·수정할 수 있게 하되,
          // 저장 시 참여형 여부는 아래의 보존 규칙으로 그대로 둔다.
          onParticipationToggle(true);
        }
        const setV = (i, v) => { const el = document.getElementById(i); if (el && v != null && v !== "") el.value = v; };
        setV("rf_start_date", (c.start_date || "").slice(0, 10));
        const _skipWeekendsEl = document.getElementById("rf_skip_weekends");
        if (_skipWeekendsEl) _skipWeekendsEl.checked = c.skip_weekends === true;
        setV("rf_window_start", (c.window_start || "").slice(0, 5));
        setV("rf_window_end", (c.window_end || "").slice(0, 5));
        rfApplyPurchaseTime({
          timeRange: c.time_range || "",
          start: (c.window_start || "").slice(0, 5),
          end: (c.window_end || "").slice(0, 5)
        });
        setV("rf_daily_limit", c.daily_limit || "");
        setV("rf_recruit_total", c.recruit_total ?? "");
        setV("rf_landing_url", c.landing_url || "");
        setV("rf_product_url", c.landing_url || "");
        setV("rf_hold_ttl", c.hold_ttl_min ?? 15);
        setV("rf_close_buffer", c.close_buffer_min ?? 10);
        /* ⏸ 098 이월 반영 방식 복원 */
        if (typeof rfCarrySet === "function") rfCarrySet(c.carry_mode === "hold" ? "hold" : "auto", { silent: true });
        /* 👥 타계정 참여(063) 복원 */
        {
          const _ma = document.getElementById("rf_multi_account");
          if (_ma) { _ma.checked = c.multi_account_mode === true; onMultiAccountToggle(_ma.checked); }
          const _md = document.getElementById("rf_multi_daily"); if (_md) _md.value = c.multi_daily_limit ?? 0;
          const _st = document.getElementById("rf_sub_ttl"); if (_st) _st.value = c.sub_hold_ttl_min ?? 10;
        }
        /* 🧪 085 리뷰어 미노출 복원 */
        {
          const _rh = document.getElementById("rf_reviewer_hidden");
          if (_rh) _rh.checked = c.reviewer_hidden === true;
        }
        /* ✅ 087 리뷰타입 복원 — 저장값(표준 key)이 없으면 [미지정]이 선택된다 */
        const savedReviewMix = Array.isArray(c.review_type_mix) ? c.review_type_mix : (() => {
          try { return JSON.parse(c.review_type_mix || '[]'); } catch (_) { return []; }
        })();
        // 혼합 입력칸은 [혼합]을 선택할 때 동적으로 만들어진다. 먼저 진실원본을 채운 뒤
        // 버튼을 선택해야 저장된 구성(또는 작업오더 프리필)이 렌더링 첫 화면부터 보인다.
        _setRecruitGlobalReviewTypeMix(savedReviewMix);
        _rfPickBtn("review_type", _rfReviewTypeKey(c.review_type || ""));
        /* 💸 086 이체 설정 복원 — 저장값 없으면 [자동] 버튼이 선택된다 */
        _rfPickTransferBank(c.transfer_bank || "");
        setV("rf_transfer_memo", c.transfer_memo || "");
        const wd = (typeof c.work_detail === "string") ? (() => { try { return JSON.parse(c.work_detail); } catch (_) { return {}; } })() : (c.work_detail || {});
        const _inflowInput = document.getElementById("rf_inflow_type_value");
        if (_inflowInput) _inflowInput.value = wd.inflowType === "guide" ? "guide" : "link";
        // 저장 시 escape+<br> 변환의 역변환(S3): <br>→개행, 엔티티 복원 → textarea에 평문으로
        const _fromHtml = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        setV("rf_wd_product", wd.productLines || "");
        setV("rf_deadline", c.deadline ? String(c.deadline).slice(0, 10) : "");   // 종료일(deadline)
        window._rfSheetEndDate = c.endDate || "";      // 시트 파생 마감일 — 다르면 경고(시트 우선)
        onRecruitDatesChange();
        // ★ M3 리뷰 #1: 저장본이 리치 HTML(<br> 외 태그 — 프리필 raw로 발행된 이미지 포함 가이드)이면
        //   편집모드도 raw 모드로 복원 — 아니면 "다른 필드만 고쳐 저장"해도 escape 경로가 태그를 문자로 게시(라운드트립 파괴)
        {
          const _rawInflow = String(wd.inflowGuideHtml || "");
          const _inflowTa2 = document.getElementById("rf_wd_inflow");
          // 🖼 사진은 본문에서 떼어 오른쪽 썸네일로 — 남는 글만 textarea 로 들어간다
          const _inflowText = _igLoadInflowHtml(_rawInflow);
          if (_inflowTa2 && /<(?!br\s*\/?>)[a-z][^>]*>/i.test(_inflowText)) {
            window._wdInflowRawHtml = _rawInflow;
            _inflowTa2.value = _htmlToPlainPreview(_inflowText);
            _inflowTa2.dataset.rawHtml = "1";
            _inflowTa2.addEventListener("input", () => { _inflowTa2.dataset.rawHtml = ""; }, { once: true });
          } else {
            // 서식 없는 글 = 평문 편집(사진은 배열로 이미 분리돼 있어 그대로 보존된다)
            window._wdInflowRawHtml = _rawInflow;
            setV("rf_wd_inflow", _fromHtml(_inflowText));
          }
        }
        setV("rf_wd_review", wd.reviewGuide || "");
        setV("rf_wd_notes", wd.specialNotes || "");
        _igSetList("review", wd.reviewGuideImages);     // 🖼 리뷰가이드·특이사항 첨부(배열)
        _igSetList("notes", wd.specialNotesImages);
        _igRenderAll();
        setV("rf_thumbnail", c.thumbnail_url || "");
        setV("rf_thumb_url", c.thumbnail_url || "");
        _syncCampThumbUrlPreview();
        renderOptRowsWithProduct(json.options || [], wd.productLines, c);   // 🧩 옵션표 + 상품명 복원
        renderPartCheck();
      }
    } catch(e) {
      // ★ B1: 로드 실패 상태에서 저장하면 참여형 필드가 미복원 기본값으로 덮일 수 있음 → 저장 시 참여형 필드 미전송 플래그
      window._recruitEditLoadFailed = true;
      showToast("공고 데이터 로드 실패: " + e.message, "error");
    }
  } else {
    titleEl.innerHTML = `<i class="fas fa-bullhorn"></i> 모집공고 등록`;
    /* ★ 작업오더 프리필 — 원장에 기록된 값은 공고 폼에도 표시하고 관리자가 최종 확인한다. */
    if (prefill) {
      if (prefill.title)        document.getElementById("rf_title").value = prefill.title;
      if (prefill.time_range)   document.getElementById("rf_time_range").value = prefill.time_range;
      if (prefill.max_slots)    document.getElementById("rf_max_slots").value = prefill.max_slots;
      if (prefill.review_fee != null && prefill.review_fee !== "") document.getElementById("rf_review_fee").value = prefill.review_fee;
      if (prefill.chat_url)     document.getElementById("rf_chat_url").value = prefill.chat_url;
      if (prefill.notes) {
        const notesEl = document.getElementById("rf_notes");
        if (notesEl) notesEl.value = prefill.notes;
      }
      if (prefill.delivery_type) document.getElementById("rf_delivery_type").value = prefill.delivery_type;
      if (prefill.product_url)  document.getElementById("rf_product_url").value = prefill.product_url;
      const prefillInflowType = document.getElementById("rf_inflow_type_value");
      if (prefillInflowType) prefillInflowType.value = prefill.inflowType === "guide" ? "guide" : "link";

      /* ★ 065: 구매채널(상품 URL 호스트 판정) · 담당자(작업담당 매핑) 자동 선택.
         값이 없으면(판정 불가·랜덤) 아무것도 건드리지 않아 기존처럼 빈 상태로 남는다. */
      if (prefill.channel) _rfPickBtn("channel", prefill.channel);
      if (prefill.manager) _rfPickBtn("manager", prefill.manager);
      /* ★ 087: 작업오더의 리뷰타입(한국어·혼합 문자열) → 표준 key 버튼.
         판정 불가값(실배송·빈박스 = 배송유형)은 ''로 떨어져 [미지정]이 된다 — 틀린 값보다 빈 값. */
      const prefillReviewMix = Array.isArray(prefill.review_type_mix) ? prefill.review_type_mix : (() => {
        try { return JSON.parse(prefill.review_type_mix || '[]'); } catch (_) { return []; }
      })();
      // 작업오더 혼합 수량도 동적 입력칸보다 먼저 보관해, [혼합] 선택 시 그대로 렌더한다.
      _setRecruitGlobalReviewTypeMix(prefillReviewMix);
      if (prefill.review_type) _rfPickBtn("review_type", _rfReviewTypeKey(prefill.review_type));

      /* ★ 065: 연결 탭 자동 선택 — 접수 시 확정된 탭(work_sheet_url 은 제출 필수).
         탭 리네임 대비로 gid 우선 재매칭 후 이름 폴백. 미접수 오더는 값이 없어 그대로 수동. */
      _prefillLinkedTab(prefill);

      /* ★ 상품정보 기본값 = 작업오더 입력값(상품명·결제금액) — 자동수집(fetchProductInfo) 성공 항목만 이후 덮어씀 */
      if (prefill.product_name || prefill.price) {
        const nEl = document.getElementById("rf_product_name"), pEl = document.getElementById("rf_price");
        if (nEl && prefill.product_name) nEl.value = prefill.product_name;
        if (pEl && prefill.price)        pEl.value = prefill.price;
      }
      /* ★ 상품확인용 URL이 있으면 자동수집 1회 시도 — 성공 항목만 덮어쓰고, 실패하면 위 기본값 유지 */
      if (prefill.product_url) setTimeout(() => { try { fetchProductInfo({ auto: true }); } catch (_) {} }, 0);

      /* ★ M3: 참여형 자동 프리필 — 작업오더 세부내용 → 발행 폼 스냅샷 (관리자는 확인·수정만) */
      if (prefill.participation && document.getElementById("rf_participation")) {
        const pe = document.getElementById("rf_participation");
        pe.checked = true; onParticipationToggle(true);
        const setV = (i, v) => { const el = document.getElementById(i); if (el && v != null && v !== "") el.value = v; };
        setV("rf_start_date", prefill.start_date);
        const _skipWeekendsEl = document.getElementById("rf_skip_weekends");
        if (_skipWeekendsEl) _skipWeekendsEl.checked = prefill.skip_weekends === true;
        setV("rf_daily_limit", prefill.daily_limit);
        setV("rf_recruit_total", prefill.recruit_total);
        rfApplyPurchaseTime({ timeRange: prefill.purchase_time || prefill.time_range || "" });
        setV("rf_landing_url", prefill.landing_url);
        setV("rf_wd_product", prefill.wd_product);
        setV("rf_wd_review", prefill.wd_review);
        setV("rf_wd_notes", prefill.wd_notes);
        // 작업오더의 guide_images는 리뷰가이드·특이사항 본문에 HTML로 섞지 않는다.
        // textarea는 글만, 이미지는 해당 칸의 썸네일 스트립으로 분리한다.
        _igSetList("review", prefill.wd_review_images);
        _igSetList("notes", prefill.wd_notes_images);
        const ta = document.getElementById("rf_wd_inflow");
        if (prefill.wd_inflow_html && ta) {
          /* 유입가이드 원본 HTML(서식) 보존: textarea엔 미리보기 텍스트만, 저장 시 미수정이면 원본 그대로
             (textarea 경유 escape가 서식을 파괴하는 것 방지 — 수정하는 순간 평문 모드로 전환).
             🖼 사진은 본문에서 떼어 오른쪽 썸네일로 옮기므로 글을 고쳐도 유지된다. */
          window._wdInflowRawHtml = prefill.wd_inflow_html;
          ta.value = _htmlToPlainPreview(_igLoadInflowHtml(prefill.wd_inflow_html));
          ta.dataset.rawHtml = "1";
          ta.addEventListener("input", () => { ta.dataset.rawHtml = ""; }, { once: true });
          _igRenderAll();
        } else if (prefill.wd_inflow_text) {
          setV("rf_wd_inflow", prefill.wd_inflow_text);
        }
        _igRenderAll();
        /* 🧩 작업오더 상품정보 → 진행상품 표: 옵션 배열이 있으면 그대로, 없으면 텍스트를 줄 단위로 분해 */
        applyProductRowsFromOrder(prefill);
        setV("rf_deadline", prefill.end_date || prefill.deadline);
        onRecruitDatesChange();
        renderPartCheck();
      }
    }
  }

  /* 읽기/쓰기 입력은 숨겨도, 승인 시안의 조작부는 항상 같은 현재 상태를 표시한다. */
  rfSetCashReceipt(!!document.getElementById("rf_cash_receipt_required")?.checked);
  onFeeScheduleToggle(!!document.getElementById("rf_fee_sched_on")?.checked);
  rfSetWeekendPolicy(!!document.getElementById("rf_skip_weekends")?.checked);
  rfSetMultiAccount(!!document.getElementById("rf_multi_account")?.checked);
  rfSetInflowType(document.getElementById("rf_inflow_type_value")?.value || "link");
  syncRecruitProductMainUrl();
  modal.classList.remove("hidden");
  modal.style.display = "";
  // 배경 작업 화면은 고정하고, 모집공고 모달의 중앙 편집 영역만 스크롤한다.
  // 닫을 때 클래스를 제거해 다른 화면의 스크롤 동작에는 영향을 남기지 않는다.
  document.body.classList.add("rf-recruit-modal-open");

  /* 미리보기 항상 자동 렌더링 */
  _previewOpen = true;
  _renderPreview();
  _attachPreviewListeners();

  /* 🧹 4칸 정리 도우미(개선 ③·④) — 신규 프리필·기발행 스냅샷 모두 열리는 순간 같은 감지가 돈다 */
  try { renderRecruitFieldCleanup(); } catch (_) { /* 감지 실패가 모달을 막으면 안 된다 */ }

  /* 🔗 연결 탭이 비어 있으면 사유 + 제목 유사도 추천을 띄운다(선택돼 있으면 아무것도 안 뜬다) */
  try { _rfBindTitleSuggest(); _rfRefreshLinkedTabNote(); } catch (_) { /* 안내 실패가 모달을 막으면 안 된다 */ }
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
      // ★ 리뷰 #10: 자동추출이 빈 값으로 직접 업로드 썸네일을 덮지 않게
      if (r.thumbnail) {
        document.getElementById("rf_thumbnail").value = r.thumbnail;
        const _thumbUrl = document.getElementById("rf_thumb_url");
        if (_thumbUrl) _thumbUrl.value = r.thumbnail;
        _syncCampThumbUrlPreview();
      }
      // ★ 성공 항목만 덮어씀 — 누락 항목은 작업오더 기본값 등 기존 값 유지
      if (r.name)  nEl.value = r.name;
      if (r.price) pEl.value = r.price;
      // 공고 제목이 비어 있으면 상품명으로 채움
      const t = document.getElementById("rf_title");
      if (t && !t.value.trim() && r.name) { t.value = r.name; _renderPreview && _renderPreview(); }
      showToast((r.mall || "") + " 상품정보를 가져왔습니다.");
    } else {
      // 기존 값(작업오더 기본값)이 있으면 값을 유지하고 안내합니다.
      const hasBase = !!((nEl && nEl.value) || (pEl && pEl.value));
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
  document.body.classList.remove("rf-recruit-modal-open");
  _recruitEditId = null;
  _woPrefillOrderId = null;
}

/* ═══════════════════════════════════════
   채널/담당자 버튼 선택 (공통)
═══════════════════════════════════════ */
function selectRfBtn(group, btn) {
  /* 같은 그룹 버튼만 비활성화 */
  const container = btn.closest('#rf_channel_btns, #rf_manager_btns, #rf_transfer_bank_btns, #rf_review_type_btns');
  if (container) {
    container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
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
    syncRecruitAutomaticBadges();
  } else if (group === 'manager') {
    document.getElementById('rf_manager').value = val;
  } else if (group === 'transfer_bank') {
    /* ★ 086: 빈 값 = 자동(작업오더 물건비 판정). 서버에서 ''는 NULL 로 되돌아간다. */
    const el = document.getElementById('rf_transfer_bank');
    if (el) el.value = val || '';
  } else if (group === 'review_type') {
    /* ★ 087: 빈 값 = 미지정. 서버에서 ''는 NULL(해제)로 해석된다(CASE 센티널). */
    const el = document.getElementById('rf_review_type');
    if (el) el.value = val || '';
    syncRecruitReviewTypeMix();
    syncRecruitAutomaticBadges();
  }
}

const RF_REVIEW_MIX_TYPES = ['photo', 'text', 'confirm', 'star'];

/** 동적으로 렌더되는 혼합 입력칸의 프리필 원본. 유효 키·양수 수량만 보관한다. */
function _setRecruitGlobalReviewTypeMix(mix) {
  const byType = new Map();
  (Array.isArray(mix) ? mix : []).forEach((entry) => {
    const type = String(entry?.type || '');
    const quantity = Math.max(0, Math.floor(Number(entry?.quantity) || 0));
    if (RF_REVIEW_MIX_TYPES.includes(type) && quantity > 0) byType.set(type, quantity);
  });
  window._rfGlobalReviewTypeMix = RF_REVIEW_MIX_TYPES
    .filter((type) => byType.has(type))
    .map((type) => ({ type, quantity: byType.get(type) }));
}

function _reviewMixRows() {
  return Array.from(document.querySelectorAll('#rf_opt_rows .rf-opt-row'))
    .filter((row) => row.dataset.status !== 'closed' && String(row.querySelector('.rf-opt-name')?.value || '').trim());
}

function _readOptionReviewMix(row) {
  try {
    const parsed = JSON.parse(row?.dataset.reviewTypeMix || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function _writeOptionReviewMix(row, mix) {
  if (row) row.dataset.reviewTypeMix = JSON.stringify(RF_REVIEW_MIX_TYPES.map((type) => {
    const hit = (mix || []).find((entry) => entry?.type === type);
    return { type, quantity: Math.max(0, Math.floor(Number(hit?.quantity) || 0)) };
  }).filter((entry) => entry.quantity > 0));
}

function getRecruitOptionReviewTypeMix() {
  return _reviewMixRows().map((row) => ({
    optKey: String(row.querySelector('.rf-opt-name')?.value || '').trim(),
    recruitTotal: Math.max(0, Number(row.querySelector('.rf-opt-rt')?.value) || 0),
    reviewTypeMix: _readOptionReviewMix(row),
  }));
}

function _isOptionReviewMix() {
  return _prodMode() === 'opt' && _reviewMixRows().length > 0;
}

function _mixQuantity(mix, type) {
  const hit = (mix || []).find((entry) => entry?.type === type);
  return Math.max(0, Math.floor(Number(hit?.quantity) || 0));
}

function _reviewMixTotalLabel(sum, expected, optionMode) {
  return optionMode
    ? `합계 ${sum}명 / 옵션인원 ${expected}명`
    : `합계 ${sum}명 / 총모집인원 ${expected}명`;
}

function renderRecruitOptionReviewMix() {
  const root = document.getElementById('rf_review_mix_rows');
  if (!root) return;
  const optionMode = _isOptionReviewMix();
  const rows = optionMode ? _reviewMixRows() : [];
  const signature = optionMode
    ? rows.map((row, index) => `${index}:${row.querySelector('.rf-opt-name')?.value || ''}:${row.querySelector('.rf-opt-rt')?.value || 0}`).join('|')
    : 'global';
  if (root.dataset.signature === signature) {
    root.querySelectorAll('[data-rf-review-mix-card]').forEach((box) => {
      const sum = Array.from(box.querySelectorAll('[data-mix-type]')).reduce((total, input) => total + (Number(input.value) || 0), 0);
      const expected = Number(box.dataset.expected) || 0;
      const total = box.querySelector('.mixed-review-total');
      if (total) {
        total.textContent = _reviewMixTotalLabel(sum, expected, optionMode);
        total.classList.toggle('is-invalid', sum !== expected);
      }
    });
    return;
  }
  root.dataset.signature = signature;
  root.innerHTML = '';

  const cards = optionMode ? rows.map((row, index) => ({
    row,
    index,
    label: String(row.querySelector('.rf-opt-name')?.value || '').trim() || '옵션명 입력 필요',
    expected: Math.max(0, Number(row.querySelector('.rf-opt-rt')?.value) || 0),
    mix: _readOptionReviewMix(row),
  })) : [{
    row: null,
    index: -1,
    label: '전체 모집',
    expected: Math.max(0, Number(document.getElementById('rf_recruit_total')?.value) || 0),
    mix: window._rfGlobalReviewTypeMix || [],
  }];

  cards.forEach((card) => {
    const box = document.createElement('div');
    box.className = 'mixed-review-card';
    box.dataset.rfReviewMixCard = String(card.index);
    box.dataset.expected = String(card.expected);
    const head = document.createElement('div');
    head.className = 'mixed-review-heading';
    const title = document.createElement('strong');
    title.textContent = card.label;
    const total = document.createElement('span');
    total.className = 'mixed-review-total';
    head.append(title, total);
    const grid = document.createElement('div');
    grid.className = 'mixed-review-grid';
    RF_REVIEW_MIX_TYPES.forEach((type) => {
      const label = document.createElement('label');
      const typeLabel = document.createElement('span');
      typeLabel.className = 'mixed-review-type-label';
      typeLabel.textContent = ({ photo: '포토', text: '텍스트', confirm: '구매확정', star: '별점' })[type];
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.inputMode = 'numeric'; input.value = String(_mixQuantity(card.mix, type));
      input.dataset.mixType = type;
      input.addEventListener('focus', () => {
        if (input.value === '0') input.value = '';
      });
      input.addEventListener('input', () => {
        const next = RF_REVIEW_MIX_TYPES.map((key) => ({ type: key, quantity: Number(grid.querySelector(`[data-mix-type="${key}"]`)?.value) || 0 }));
        if (card.row) _writeOptionReviewMix(card.row, next);
        else window._rfGlobalReviewTypeMix = next.filter((entry) => entry.quantity > 0);
        syncRecruitReviewTypeMix();
      });
      label.append(typeLabel, input);
      grid.appendChild(label);
    });
    box.append(head, grid);
    root.appendChild(box);
    const sum = card.mix.reduce((totalValue, entry) => totalValue + (Number(entry.quantity) || 0), 0);
    total.textContent = _reviewMixTotalLabel(sum, card.expected, optionMode);
    total.classList.toggle('is-invalid', sum !== card.expected);
  });
}

function getRecruitReviewTypeMix() {
  if (_isOptionReviewMix()) {
    const sums = new Map();
    getRecruitOptionReviewTypeMix().forEach((option) => option.reviewTypeMix.forEach((entry) => {
      sums.set(entry.type, (sums.get(entry.type) || 0) + entry.quantity);
    }));
    return [...sums.entries()].map(([type, quantity]) => ({ type, quantity })).filter((entry) => entry.quantity > 0);
  }
  return RF_REVIEW_MIX_TYPES.map((type) => {
    const el = document.querySelector(`#rf_review_mix [data-mix-type="${type}"]`);
    return { type, quantity: Math.max(0, Math.floor(Number(el?.value) || 0)) };
  }).filter(({ quantity }) => quantity > 0);
}

/** 혼합을 선택한 경우에만 조합 행을 보인다. 선택별 설명문 대신 현재 조합을 직접 보여준다. */
function syncRecruitReviewTypeMix() {
  const root = document.getElementById('rf_review_mix');
  const composer = document.getElementById('rf_mixed_review_composer');
  const reviewType = document.getElementById('rf_review_type')?.value || '';
  if (!root) return [];
  const visible = reviewType === 'mixed';
  root.style.display = visible ? '' : 'none';
  if (composer) { composer.hidden = !visible; composer.classList.toggle('is-visible', visible); }
  if (visible) renderRecruitOptionReviewMix();
  const mix = getRecruitReviewTypeMix();
  const sum = mix.reduce((total, row) => total + row.quantity, 0);
  const expected = Math.max(0, Number(document.getElementById('rf_recruit_total')?.value) || 0);
  const totalEl = document.getElementById('rf_review_mix_total');
  if (totalEl && !_isOptionReviewMix()) {
    totalEl.textContent = `합계 ${sum}명 · 총인원 ${expected}명`;
    totalEl.style.color = reviewType === 'mixed' && sum !== expected ? 'var(--danger,#EF4444)' : 'var(--t3,#64748B)';
  }
  syncRecruitAutomaticBadges();
  return mix;
}

function validateRecruitReviewTypeMix() {
  const reviewType = document.getElementById('rf_review_type')?.value || '';
  if (reviewType !== 'mixed') return '';
  const mix = syncRecruitReviewTypeMix();
  if (_isOptionReviewMix()) {
    const options = getRecruitOptionReviewTypeMix();
    for (const option of options) {
      const sum = option.reviewTypeMix.reduce((total, row) => total + row.quantity, 0);
      if (option.reviewTypeMix.length < 2) return `옵션 ${option.optKey}에 두 가지 이상 리뷰방식을 입력해주세요.`;
      if (option.recruitTotal <= 0 || sum !== option.recruitTotal) return `옵션 ${option.optKey}의 리뷰 조합 합계를 옵션인원 ${option.recruitTotal}명과 일치시켜주세요.`;
    }
    return '';
  }
  const expected = Math.max(0, Number(document.getElementById('rf_recruit_total')?.value) || 0);
  const sum = mix.reduce((total, row) => total + row.quantity, 0);
  if (mix.length < 2) return '혼합 리뷰는 두 가지 이상 유형의 수량을 입력해주세요.';
  if (expected <= 0) return '혼합 리뷰는 총인원을 먼저 설정해주세요.';
  if (sum !== expected) return `리뷰 조합 합계(${sum}명)를 총인원(${expected}명)과 일치시켜주세요.`;
  return '';
}

/* 작업오더가 넘겨준 한국어 리뷰타입 → 표준 key.
   ★ 판정의 진짜 단일 출처는 서버 `utils/reviewType.js` 이고 저장 시 서버가 다시 정규화한다.
     여기 있는 건 **프리필로 어느 버튼을 누를지** 고르기 위한 최소 표다 —
     회귀가드가 이 라벨 목록이 서버 REVIEW_TYPES 와 같은지 고정한다(workManager 사본 규율). */
const RF_REVIEW_TYPE_LABELS = [
  ['photo', '포토'], ['text', '텍스트'], ['confirm', '구매확정'], ['star', '별점'], ['mixed', '혼합'],
];
function _rfReviewTypeKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (RF_REVIEW_TYPE_LABELS.some(([k]) => k === s)) return s;   // 이미 key
  if (/혼합|믹스/.test(s)) return 'mixed';                       // ★ 혼합 먼저(문자열에 '포토'가 함께 들어 있다)
  if (/구매\s*확정/.test(s)) return 'confirm';
  if (/포토|사진/.test(s)) return 'photo';
  if (/별점|평점/.test(s)) return 'star';
  if (/텍스트/.test(s)) return 'text';
  return '';                                                     // 실배송·빈박스 = 배송유형이지 리뷰타입이 아니다
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
    if (val && !_isRecruitAutomaticBadge(val) && !_isRetiredRecruitBadge(val) && !_recruitBadges.includes(val)) {
      _recruitBadges.push(val);
      _refreshBadgeWrap();
    }
    inp.value = "";
  }
}

/* 추천 배지 클릭 → 바로 추가 (중복 방지) */
function addPresetBadge(val) {
  if (!val || _isRecruitAutomaticBadge(val) || _isRetiredRecruitBadge(val) || _recruitBadges.includes(val)) return;
  _recruitBadges.push(val);
  _refreshBadgeWrap();
}

const AUTOMATIC_RECRUIT_BADGES = ['현영건', '로켓와우', '사진 5장+', '구매확정'];
const RETIRED_RECRUIT_BADGES = ['와우 필수', '포토리뷰'];
function _isRecruitAutomaticBadge(val) { return AUTOMATIC_RECRUIT_BADGES.includes(val); }
function _isRetiredRecruitBadge(val) { return RETIRED_RECRUIT_BADGES.includes(val); }

/* 배지는 입력값이 아니라 업무 규칙의 파생 결과다.
   - 현영건: 현금영수증 발행
   - 로켓와우: 쿠팡 채널
   - 사진 5장+: 포토가 포함된 리뷰 조합
   - 구매확정: 구매확정이 포함된 리뷰 조합
   예전에 수동으로 붙인 값과 폐기한 배지는 저장 시 함께 정리한다. */
function syncRecruitAutomaticBadges() {
  const required = !!document.getElementById("rf_cash_receipt_required")?.checked;
  const channel = document.getElementById('rf_channel')?.value || '';
  const reviewType = document.getElementById('rf_review_type')?.value || '';
  const next = _recruitBadges.filter((badge) => !_isRecruitAutomaticBadge(badge) && !_isRetiredRecruitBadge(badge));
  if (required) next.push('현영건');
  if (channel === '쿠팡') next.push('로켓와우');
  if (reviewType === 'photo') next.push('사진 5장+');
  if (reviewType === 'confirm') next.push('구매확정');
  const changed = next.length !== _recruitBadges.length || next.some((b, i) => b !== _recruitBadges[i]);
  _recruitBadges = next;
  if (changed) _refreshBadgeWrap();
}

function removeBadge(idx) {
  if (_isRecruitAutomaticBadge(_recruitBadges[idx])) return;
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
    chip.className = "rbadge-chip" + (_isRecruitAutomaticBadge(b) ? " automatic" : "");
    chip.innerHTML = _isRecruitAutomaticBadge(b)
      ? `${escHtml(b)}<small style="margin-left:4px;color:var(--t3,#64748B)">자동</small>`
      : `${escHtml(b)}<button type="button" onclick="removeBadge(${i})" title="삭제"><i class="fas fa-times"></i></button>`;
    wrap.insertBefore(chip, inp);
  });
}

/* ═══════════════════════════════════════
   ⚡ M3: 썸네일 직접 업로드 (유입가이드 이미지 인프라 재사용 — Drive+무인증 프록시)
═══════════════════════════════════════ */
/* URL을 붙여넣는 순간 저장될 값과 미리보기를 함께 갱신한다. 이전에는 [가져오기]를
   눌러 서버에 다시 저장하기 전까지 아무 변화가 없어, 유효한 쿠팡 CDN 주소도 확인할 수 없었다. */
function _syncCampThumbUrlPreview() {
  const input = document.getElementById("rf_thumb_url");
  const saved = document.getElementById("rf_thumbnail");
  const wrap = document.getElementById("rf_thumb_preview_wrap");
  const image = document.getElementById("rf_thumb_preview");
  const state = document.getElementById("rf_thumb_preview_state");
  if (!input || !saved || !wrap || !image) return;

  const url = input.value.trim();
  if (!url) {
    wrap.hidden = true;
    wrap.classList.remove("is-error");
    image.removeAttribute("src");
    return;
  }
  if (!/^https:\/\//i.test(url)) {
    wrap.hidden = false;
    wrap.classList.add("is-error");
    if (state) state.textContent = "https URL만 가능";
    image.removeAttribute("src");
    return;
  }

  // 직접 입력 URL도 확정 저장 시 카드가 같은 이미지를 쓰도록 저장 필드에 동기화한다.
  saved.value = url;
  wrap.hidden = false;
  wrap.classList.remove("is-error");
  if (state) state.textContent = "불러오는 중…";
  image.onload = function () {
    wrap.classList.remove("is-error");
    if (state) state.innerHTML = "미리<br>보기";
  };
  image.onerror = function () {
    wrap.classList.add("is-error");
    if (state) state.textContent = "이미지 확인 실패";
  };
  image.src = url;
  _onPreviewInput();
}

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
    const pvWrap = document.getElementById("rf_thumb_preview_wrap");
    if (pv) { pv.src = j.url; }
    if (pvWrap) { pvWrap.hidden = false; pvWrap.classList.remove("is-error"); }
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
    const pvWrap = document.getElementById("rf_thumb_preview_wrap");
    if (pv) { pv.src = j.url; }
    if (pvWrap) { pvWrap.hidden = false; pvWrap.classList.remove("is-error"); }
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
      // ★ 기준이 시스템표(기본)일 때 — 시트에 날짜가 있어도 정원·마감은 시스템 값이 정한다
      system_basis: "이 시스템은 <b>모집 인원 기준이 시스템표</b>입니다 — 시트에 진행 날짜가 있어도 그날 정원·마감일은 <b>일 모집인원 · 날짜별 조절 · 총모집(차수)</b>이 정합니다(아래 날짜는 시트 현황 참고용).",
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
    } else if (s.reason === "system_basis") {
      // ★ 이건 이상 상황이 아니라 **정상 기준**이다 — 경고(노란 박스)로 몰지 않는다
      parts.push(`<b>모집 기준</b> 시스템표 · ${why}`
        + (s.distinctDates ? `<div style="color:#6B7280;font-size:.7rem">시트 날짜: ${esc(md(s.firstDate))} ~ ${esc(md(s.lastDate))} · ${s.distinctDates}종 / ${s.totalDated}행</div>` : ""));
    } else if (why) {
      parts.push(`<b>시트 일정</b> <span style="color:#B45309;font-weight:800">미적용</span> — ${why}`
        + (s.distinctDates ? `<div style="color:#6B7280;font-size:.7rem">인식된 날짜: ${s.dates.map(d => esc(md(d.date)) + "(" + d.rows + "행)").join(" · ")}</div>` : ""));
    }
  }
  if (!parts.length) return "";
  // ★ `system_basis`(모집 기준이 시스템표)는 정상 상태라 경고 색으로 칠하지 않는다 —
  //   전 공고가 상시 노란 박스가 되면 진짜 불일치 신호가 묻힌다(늑대소년 방지).
  const warn = (Number(si.diff) || 0) !== 0 || (s && !s.applied && s.reason !== "system_basis");
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

/* ═══════════════════════════════════════════════════════════════
   저장 후 안내 카드의 "바뀐 항목" 목록 재료
   ───────────────────────────────────────────────────────────────
   ★ 표시 보조일 뿐 **저장 여부를 가르지 않는다** — 여기서 무엇이 나오든
     저장은 그대로 진행된다(빈 목록이어도 카드는 뜬다).
   ★ 확실히 비교되는 필드만 센다. 모르는 필드는 목록에서 뺀다 —
     틀린 목록은 빈 목록보다 나쁘다(그래서 목록이 비면 카드가 항목을
     그리지 않고 중립 문구를 쓴다. "바뀐 내용 없음"이라고 단정하지 않는다).
   ★ 비교 대상은 **저장 직전 payload ↔ 모달을 열 때 서버에서 받은 값**.
     payload 에 없는 키(축약 화면이 미전송한 필드)는 애초에 비교하지 않는다.
═══════════════════════════════════════════════════════════════ */
const _RF_DIFF_FIELDS = [
  ["title",             "공고 제목"],
  ["manager",           "담당자"],
  ["channel",           "구매채널"],
  ["channel_custom",    "구매채널"],
  ["time_range",        "구매시간대"],
  ["delivery_type",     "배송유형"],
  ["review_fee",        "리뷰비"],
  ["notes",             "유의사항"],
  ["chat_url",          "카톡 팀채팅방"],
  ["linked_tab_name",   "연결 탭"],
  ["linked_sheet_id",   "연결 탭"],
  ["max_slots",         "모집인원"],
  ["status",            "상태"],
  ["deadline",          "종료일"],
  ["review_type",       "리뷰타입"],
  ["start_date",        "시작일"],
  ["window_start",      "구매시간"],
  ["window_end",        "구매시간"],
  ["daily_limit",       "하루 진행 인원"],
  ["recruit_total",     "총 모집인원"],
  ["hold_ttl_min",      "자리 유효시간"],
  ["close_buffer_min",  "마감 버퍼"],
  ["multi_account_mode","타계정 참여"],
  ["multi_daily_limit", "타계정 하루한도"],
  ["sub_hold_ttl_min",  "타계정 자리 유효시간"],
  ["reviewer_hidden",   "리뷰어에게 숨김"],
  ["transfer_bank",     "이체은행"],
  ["transfer_memo",     "통장표시"],
  ["landing_url",       "상품 URL"],
  ["thumbnail_url",     "썸네일"],
  ["badges",            "배지"],
];
const _RF_DIFF_WORKDETAIL = [
  ["productLines",    "상품 정보"],
  ["inflowGuideHtml", "유입가이드"],
  ["reviewGuide",     "리뷰가이드"],
  ["specialNotes",    "특이사항"],
];

/** 값 정규화 — 서버가 준 형식(타임스탬프·'10:00:00'·숫자 문자열)과 폼 값의 표기 차이를 흡수 */
function _rfNormVal(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number")  return String(v);
  if (Array.isArray(v))       return v.map(_rfNormVal).join("|");
  if (typeof v === "object")  { try { return JSON.stringify(v); } catch(_) { return ""; } }
  let s = String(v).trim();
  const dm = s.match(/^(\d{4}-\d{2}-\d{2})[T ]/);   if (dm) return dm[1];   // 타임스탬프 → 날짜
  const tm = s.match(/^(\d{2}:\d{2}):\d{2}$/);      if (tm) return tm[1];   // '10:00:00' → '10:00'
  if (/^-?\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");                    // numeric '1000.00' → '1000'
  return s;
}
/** ★ 빈 값과 0 은 같은 상태로 본다(실측 오탐) — 서버가 NULL 로 준 숫자 칸을 폼이 0 으로
 *  채워 되보내므로, 그대로 비교하면 **아무것도 안 고쳐도** "모집인원 바뀜"이 뜬다.
 *  0 ↔ 비움은 서버가 어차피 같은 값(0)으로 저장하므로 표시하지 않아도 거짓이 아니다. */
function _rfSame(a, b) {
  const x = _rfNormVal(a), y = _rfNormVal(b);
  if (x === y) return true;
  const blankish = v => v === "" || v === "0";
  return blankish(x) && blankish(y);
}
/** 옵션표/구간표는 서버(snake_case)와 폼(camelCase) 키가 달라 양쪽을 다 읽는다 */
function _rfNormOptRows(list) {
  return (Array.isArray(list) ? list : []).map(o => [
    String(o.optKey ?? o.opt_key ?? "").trim(),
    String(o.optionUrl ?? o.option_url ?? "").trim(),
    _rfNormVal(o.payAmount    ?? o.pay_amount    ?? 0),
    _rfNormVal(o.recruitTotal ?? o.recruit_total ?? 0),
    _rfNormVal(o.dailyLimit   ?? o.daily_limit   ?? 0),
  ].join("~")).sort().join("|");
}
function _rfNormFeeRows(list) {
  return (Array.isArray(list) ? list : []).map(r => [
    _rfNormVal(r.effectiveFrom ?? r.effective_from ?? ""),
    _rfNormVal(r.reviewFee     ?? r.review_fee     ?? 0),
  ].join("~")).sort().join("|");
}

/** 저장 직전 payload ↔ 로드값 대조 → 바뀐 항목 라벨(중복 제거, 화면 순서 유지) */
function _rfChangedLabels(payload) {
  const loaded = window._recruitEditLoaded;
  if (!loaded || window._recruitEditLoadFailed) return [];   // 모르면 목록을 만들지 않는다
  const out = [];
  const push = l => { if (l && out.indexOf(l) === -1) out.push(l); };

  _RF_DIFF_FIELDS.forEach(([k, label]) => {
    if (!(k in payload)) return;                              // 미전송 필드는 비교 대상 아님
    if (!_rfSame(payload[k], loaded[k])) push(label);
  });

  if (payload.work_detail && typeof payload.work_detail === "object") {
    const wd = loaded.work_detail || {};
    _RF_DIFF_WORKDETAIL.forEach(([k, label]) => {
      if (!_rfSame(payload.work_detail[k], wd[k])) push(label);
    });
  }
  if (Array.isArray(payload.options) && Array.isArray(window._recruitEditLoadedOpts)) {
    if (_rfNormOptRows(payload.options) !== _rfNormOptRows(window._recruitEditLoadedOpts)) push("진행상품·옵션");
  }
  if (Array.isArray(payload.fee_schedules) && Array.isArray(window._recruitEditLoadedFees)) {
    if (_rfNormFeeRows(payload.fee_schedules) !== _rfNormFeeRows(window._recruitEditLoadedFees)) push("기간별 리뷰비");
  }
  return out;
}

/** 저장 차단·실패 안내 — 모달 안쪽(토스트 금지: 덮개 아래로 깔려 안 보인다) */
/** 연결 탭을 "사람이 비웠는가" — 복원 실패·목록 미로드는 판단 불가로 보고 미전송(=기존 연결 유지).
 *  ★ 이 구분이 없으면 탭 리네임·아카이브·목록 조회 실패 때 저장 한 번에 시트 연결이 사라진다. */
function _rfExplicitUnlink() {
  if (!_recruitEditId) return true;                       // 신규 공고는 "연결 안 함"이 곧 의도
  const sel = document.getElementById("rf_linked_tab");
  if (!sel || sel.options.length <= 1 || !_recruitTabList.length) return false;   // 목록을 못 받았다
  if (_rfLinkedMiss && _rfLinkedMiss.source === "campaign") return false;         // 저장된 탭을 못 찾았다
  return true;
}

function _rfSaveBlocked(msg, opts) {
  // ★ 붙일 자리를 못 찾으면(레이아웃 변형) 조용히 삼키지 않는다 — 토스트로라도 사유를 말한다.
  const shown = (typeof recruitSaveBlock === "function")
    ? recruitSaveBlock(msg, (opts && opts.go) || undefined) : false;
  if (!shown) showToast(msg, "error");   // 구버전 모듈·렌더 실패 폴백
}
/** [점검 항목 보기 ↑] — 자동 점검 블록으로 스크롤 + 깜빡임 */
function _rfGoToCheck() {
  const body = document.querySelector("#recruitModal .modal-body");
  const target = document.getElementById("rf_part_check") || document.getElementById("rf_status");
  if (!target) return;
  try { target.scrollIntoView({ block: "center", behavior: "smooth" }); }
  catch (_) { if (body) body.scrollTop = body.scrollHeight; }
  target.classList.remove("rf-chk-blink");
  void target.offsetWidth;
  target.classList.add("rf-chk-blink");
  setTimeout(() => target.classList.remove("rf-chk-blink"), 2400);
}

/* ═══════════════════════════════════════
   공고 저장 (등록 / 수정)
═══════════════════════════════════════ */
async function saveRecruitPostImpl() {
  if (_recruitEditId && window._recruitEditLoadFailed) {
    _rfSaveBlocked("기존 공고 정보를 완전히 불러오지 못해 저장을 차단했습니다. 새로고침 후 다시 시도해주세요.");
    return;
  }
  if (typeof recruitSaveBlockClear === "function") recruitSaveBlockClear();   // 지난 사유 지우고 시작
  syncRecruitAutomaticBadges();
  const title    = document.getElementById("rf_title").value.trim();
  const channel  = document.getElementById("rf_channel").value.trim();
  const manager  = document.getElementById("rf_manager").value.trim();
  const chatUrl  = document.getElementById("rf_chat_url").value.trim();
  if (!title)   { _rfSaveBlocked("공고 제목을 입력해주세요."); document.getElementById("rf_title").focus(); return; }
  if (!channel) { _rfSaveBlocked("구매채널을 선택해주세요."); return; }

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
    cash_receipt_required: !!document.getElementById("rf_cash_receipt_required")?.checked,
    review_fee:     Number(document.getElementById("rf_review_fee").value) || 0,
    badges:         _recruitBadges,
    // ★ 유의사항(notes)은 **입력칸이 있는 화면에서만** 전송한다(옵션표·리뷰타입과 같은 원칙).
    //   지금 편집기에는 이 칸이 없는데 종전처럼 ''를 보내면 서버 COALESCE 가 '지움'으로 받아
    //   **저장할 때마다 유의사항이 조용히 삭제**된다 → 아래 조건부 전송으로 대체(미전송=유지).
    chat_url:       chatUrl,
    linked_sheet_id: sid,
    linked_tab_name: tab,
    linked_tab_gid:  (tabMeta && tabMeta.tabGid) || "",
    // 빈 연결은 "값 누락"이 아니라, 관리자가 명시적으로 시트 없이 저장한다는 뜻이다.
    // ★★ 단, "사람이 비운 것"과 "화면이 복원하지 못한 것"을 반드시 구분한다 —
    //    탭 목록 로드 실패·리네임·아카이브로 select 가 비었을 때 'unlinked' 를 보내면
    //    저장 한 번에 **시트 탭 연결(gid)이 조용히 끊긴다**. 모르면 미전송(=서버 COALESCE 유지).
    linked_tab_mode: tabKey ? "linked" : (_rfExplicitUnlink() ? "unlinked" : "keep"),
    max_slots:      Number(document.getElementById("rf_max_slots").value) || 0,
    status:         document.getElementById("rf_status").value,
    // 종료일 — 시트 일정과 다르면 화면에 경고가 뜨고 실제 모집은 시트를 따른다(참고값으로 보관)
    deadline:       document.getElementById("rf_deadline")?.value || null,
    // 노출 순서 UI는 제거됐다. 기존 데이터 호환을 위해 값만 보존해 전송한다.
    sort_order:     Number(document.getElementById("rf_sort_order")?.value ?? (window._recruitEditLoaded?.sort_order ?? 0)) || 0,
    // 작업오더 프리필로 만든 신규 공고면 정방향 링크(source_work_order_id) 즉시 기록 —
    // work-detail 유입방식 역조회의 보조키(주: linked_campaign_id). 편집 시엔 미전송=COALESCE 유지.
    source_work_order_id: (!_recruitEditId && _woPrefillOrderId) ? _woPrefillOrderId : undefined,
  };

  /* 유의사항 — 입력칸이 있는 화면에서만 전송(없으면 미전송 = 서버가 기존 값 유지) */
  {
    const _notesEl = document.getElementById("rf_notes");
    if (_notesEl) payload.notes = String(_notesEl.value || "").trim();
  }

  /* ✅ 087 리뷰타입 — ★ 버튼군 UI 가 있는 화면에서만 전송.
     미전송이면 서버 CASE 센티널이 기존값을 유지한다(옵션표·이체설정과 같은 원칙) —
     리뷰타입 칸이 없는 축약 화면에서 저장했다고 설정이 조용히 풀리면 안 된다.
     ''(미지정) 전송은 "해제"로 해석되는데, 그건 사람이 [미지정]을 누른 경우뿐이다. */
  if (document.getElementById("rf_review_type_btns")) {
    payload.review_type = document.getElementById("rf_review_type")?.value || "";
    payload.review_type_mix = getRecruitReviewTypeMix();
  }

  /* ⚡ 참여형(M2): 설정·작업내용 스냅샷 포함 + 게시 전 자동 점검(서버 게이트와 동일 3항목)
     ★ B1 가드: rf_participation 요소가 "존재하는 화면"에서만 전송 —
       참여형 UI가 없는 페이지(admin-siand.html 등)나 편집 로드 실패 시엔 미전송(undefined)
       → 서버 COALESCE가 기존값 유지 = 참여형 공고의 레거시 강등 사고 차단. */
  const partEl = document.getElementById("rf_participation");
  if (partEl && !(window._recruitEditLoadFailed && _recruitEditId)) {
    const isPart = !!partEl.checked;
    const preserveLegacyCampaign = Boolean(_recruitEditId && window._recruitEditLoaded?.participation_mode === false);
    if (!preserveLegacyCampaign) payload.participation_mode = isPart;
    if (isPart || preserveLegacyCampaign) {
      if (isPart && payload.status === "active") {
        const errs = participationCheckErrors();
        if (errs.length) {
          renderPartCheck();
          _rfSaveBlocked("게시할 수 없습니다 — " + errs[0], { go: _rfGoToCheck });
          return;
        }
      }
      /* ★ 062: ""=서버에서 비움(자율주문 전환·시작일 제거), 값=설정 — null(유지)은 미전송 화면(admin-siand)만 */
      payload.start_date     = document.getElementById("rf_start_date")?.value || "";
      payload.skip_weekends  = !!document.getElementById("rf_skip_weekends")?.checked;
      payload.window_start   = document.getElementById("rf_window_start").value || "";
      payload.window_end     = document.getElementById("rf_window_end").value || "";
      _syncPreviewFromOptRows();   // 표가 진실원본 — 저장 직전 파생값(상품 원문·정원) 최신화
      /* ★★ 정원 잠금이면 총인원·일건수를 **아예 보내지 않는다**(미전송 = 서버 COALESCE 유지).
         화면 잠금만으로는 부족하다 — 낡은 화면·파생 계산이 다시 0 을 만들어도 원장이 안 흔들린다.
         변경 창구는 [📅 인원](차수·날짜별 조절) 하나. */
      if (!_rfQuotaLocked()) {
        payload.daily_limit    = Number(document.getElementById("rf_daily_limit").value) || 0;
        payload.recruit_total  = Number(document.getElementById("rf_recruit_total").value) || 0;
      }
      const reviewMixError = validateRecruitReviewTypeMix();
      if (reviewMixError) { _rfSaveBlocked(reviewMixError); return; }
      payload.hold_ttl_min   = Number(document.getElementById("rf_hold_ttl").value) || 15;
      /* ⏸ 098 이월 반영 방식 — ★ 세그먼트 UI 있는 페이지에서만 전송(미전송=서버 COALESCE 유지) */
      if (document.getElementById("rf_carry_mode")) {
        payload.carry_mode = document.getElementById("rf_carry_mode").value === "hold" ? "hold" : "auto";
      }
      /* 👥 타계정 참여(063) — ★ 토글 UI 있는 페이지에서만 전송(없으면 미전송=서버 COALESCE 기존값 유지,
         옵션표·work_detail과 동일 원칙: 축약 화면 저장이 설정을 조용히 끄지 않게) */
      if (document.getElementById("rf_multi_account")) {
        payload.multi_account_mode = !!document.getElementById("rf_multi_account").checked;
        payload.multi_daily_limit  = Math.max(0, parseInt(document.getElementById("rf_multi_daily")?.value, 10) || 0);
        payload.sub_hold_ttl_min   = Math.max(1, parseInt(document.getElementById("rf_sub_ttl")?.value, 10) || 10);
      }
      /* 🧪 085 리뷰어 미노출 — ★ 토글 UI 있는 페이지에서만 전송(미전송=서버 COALESCE 기존값 유지) */
      if (document.getElementById("rf_reviewer_hidden")) {
        payload.reviewer_hidden = !!document.getElementById("rf_reviewer_hidden").checked;
      }
      /* 💸 086 이체 설정 — ★ 같은 원칙(UI 있는 화면에서만 전송).
         빈 문자열은 서버에서 '자동으로 되돌리기'로 해석된다(CASE 센티널). */
      if (document.getElementById("rf_transfer_bank_btns")) {
        payload.transfer_bank = document.getElementById("rf_transfer_bank")?.value || "";
        payload.transfer_memo = (document.getElementById("rf_transfer_memo")?.value || "").trim();
      }
      const _cbRaw = document.getElementById("rf_close_buffer").value;
      payload.close_buffer_min = _cbRaw === "" ? 10 : Math.max(0, parseInt(_cbRaw, 10) || 0);
      payload.landing_url    = document.getElementById("rf_landing_url").value.trim();
      payload.thumbnail_url  = document.getElementById("rf_thumbnail")?.value || "";
      /* 🖼 업로드가 끝나기 전에 저장하면 그 사진이 조용히 빠진다 — 끝날 때까지 막는다 */
      // ★ 모달이 떠 있는 동안의 차단 사유는 토스트로 내보내지 않는다 —
      //   리뷰웹시스템[3버전]의 토스트(z-index 60)는 이 모달(5000+blur) 아래로 깔려 안 보인다.
      if (_igBusy()) { _rfSaveBlocked("사진 업로드가 끝나면 저장할 수 있어요."); return; }
      // 평문 입력 → HTML 저장: escape 후 개행만 <br> (S3 — sanitize가 '<옵션>' 같은 텍스트를 태그로 오인해 삭제하는 것 방지)
      // ★ M3: 작업오더 프리필/리치 저장본은 미수정 시 원본 그대로 전송(서식 보존 — 서버가 sanitize)
      // ★ 사진은 위젯(_igState)이 진실원본 — 글을 고쳐도 유지되고, 조립은 _igComposeInflow 한 곳.
      const _inflowTa = document.getElementById("rf_wd_inflow");
      const _useRawInflow = _inflowTa && _inflowTa.dataset.rawHtml === "1" && window._wdInflowRawHtml;
      // 원본이 리치 서식(줄바꿈 외 태그)이었는데 평문 모드로 전환됐다면 "서식이 사라진다"만 경고한다.
      // (종전 문구는 "이미지가 빠진다"였는데, 이제 사진은 보존되므로 사실이 아니다.)
      if (!_useRawInflow && /<(?!br\s*\/?>|img\b)[a-z][^>]*>/i.test(String(window._wdInflowTextHtml || ""))) {
        const _n = _igOk("inflow").length;
        if (!confirm(`유입가이드 글을 고치셨어요 — ${_n ? `사진 ${_n}장은 그대로 유지되고 ` : ""}글자만 다시 게시됩니다.\n원본에 있던 줄 서식·링크는 사라지고 사진은 글 아래로 모입니다. 계속할까요?`)) return;
      }
      payload.work_detail = {
        productLines:    document.getElementById("rf_wd_product").value.trim(),
        // 작업오더가 연결되지 않은 직접 등록 공고도 링크/가이드 유입을 정확히 재현할 수 있게 저장한다.
        inflowType:      document.getElementById("rf_inflow_type_value")?.value === "guide" ? "guide" : "link",
        inflowGuideHtml: _igComposeInflow(),
        reviewGuide:     document.getElementById("rf_wd_review").value.trim(),
        specialNotes:    document.getElementById("rf_wd_notes").value.trim(),
        /* 🖼 리뷰가이드·특이사항 첨부(평문 칸이라 배열로 따로) — 위젯 상태를 그대로 전송한다.
           스트립이 없는 화면에서도 프리필로 실린 값이 그대로 되돌아가 사진이 지워지지 않는다.
           (work_detail 은 통째 교체 저장이라 "미전송=유지"가 성립하지 않는다.) */
        reviewGuideImages: _igUrls("review"),
        specialNotesImages: _igUrls("notes"),
      };
      // 🧩 상품 옵션(061): 옵션표 전체를 교체 배열로 전송(빈 배열=옵션 없음). 중복 옵션명은 하드블록(서버 유니크).
      //   ★ 옵션표 UI가 있는 페이지에서만 전송 — 옵션표 없는 페이지(admin-siand 등)는 미전송(undefined)→
      //     서버가 기존 옵션 유지(옵션 소실 방지, work_detail 가드와 동일 원칙). (이 지점은 저장 버튼 비활성화 전)
      if (document.getElementById("rf_opt_rows")) {
        const _optChk = (typeof _optSummary === "function") ? _optSummary() : { dup: false };
        if (_optChk.dup) { renderPartCheck(); _rfSaveBlocked("옵션명이 중복됐어요 — 옵션명을 다르게 하거나 삭제해주세요.", { go: _rfGoToCheck }); return; }
        payload.options = readOptRows();
        /* ★ 옵션 URL 은 **값이 있는데 형식이 틀린 경우에만** 막는다.
           칸이 생기기 전(2026-08 편집기 개편 이전)에 만든 공고는 이 값이 전부 비어 있어,
           '필수'로 두면 **기존 공고의 수정 저장이 전부 차단**된다(빈 값 = 미입력이지 오류가 아니다). */
        const invalidOptionUrl = payload.options.find(option =>
          String(option.optionUrl || "").trim() && !_rfHttpUrl(option.optionUrl));
        if (invalidOptionUrl) { renderPartCheck(); _rfSaveBlocked("옵션 URL은 http:// 또는 https:// 주소로 입력해주세요.", { go: _rfGoToCheck }); return; }
      }
    }
  }

  /* 📅 기간별 리뷰비(082) — ★ 구간표 UI가 있는 페이지에서만 전송(없으면 미전송=서버가 기존 구간 유지).
     옵션표·work_detail과 같은 원칙: 축약 화면의 저장이 설정을 조용히 지우지 않게 한다.
     스위치를 끄면 빈 배열을 보내 구간을 제거한다(= 기본 리뷰비 한 값으로 복귀). */
  if (document.getElementById("rf_fee_rows")) {
    const _feeChk = renderFeeSchedule();
    if (_feeChk.dup) { _rfSaveBlocked("리뷰비 구간의 시작일이 중복됐어요 — 날짜를 다르게 하거나 삭제해주세요."); return; }
    payload.fee_schedules = document.getElementById("rf_fee_sched_on")?.checked ? readFeeRows() : [];
  }

  /* 저장 직전에 "무엇이 바뀌었나"를 계산해 둔다 — 모달을 닫은 뒤엔 폼 값을 읽을 수 없다 */
  const _changed = _recruitEditId ? _rfChangedLabels(payload) : [];

  const btn = document.getElementById("recruitSaveBtn");
  btn.disabled = true;
  btn.classList.add("busy");
  btn.innerHTML = '<span class="rf-spin"></span> 저장 중…';
  let _ok = false;   // 성공하면 버튼을 원복하지 않는다(✓ 저장됨 → 모달 닫힘으로 이어진다)

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
      try {
        await _linkPrefilledWorkOrder(_woPrefillOrderId, newCampId);
      } catch (error) {
        console.warn('[recruit] work-order campaign link failed:', error);
        showToast("공고는 등록됐으나 작업오더 연결에 실패했습니다. 인박스에서 다시 연결해주세요.", "error");
      }
      try { if (typeof loadWorkOrders === "function") loadWorkOrders(); } catch(_) {}
    }
    _woPrefillOrderId = null;
    /* ★ 095(코드리뷰 M2): 차수 원장이 있는 공고는 총모집 전송값을 서버가 무시한다(차수 합계가
       진실원본). 조용히 무시하면 "총모집을 고쳤는데 안 바뀐다"가 버그로 오해되므로 고지한다 —
       토스트가 아니라 가운데 안내(campSaveFeedback)의 목록 첫 줄로(#604 토스트 예산 규율). */
    if (saved && saved.recruitTotalLocked === true) {
      _changed.unshift("⚠ 총모집은 차수 원장이 관리해 변경되지 않음 — [📅 인원]의 차수 추가/제거로");
    }

    /* ★ 버튼 ✓ → 모달 닫힘 → 화면 가운데 안내(시안 C 확정) 로 시선이 이어진다.
       안내 렌더러는 recruit-modal.js 한 벌 — 없으면(구버전 모듈) 종전 토스트로 폴백. */
    _ok = true;
    const _wasEdit = !!_recruitEditId;
    btn.disabled = true;
    btn.classList.remove("busy");
    btn.classList.add("done");
    btn.innerHTML = "✓ 저장됨";
    await new Promise(r => setTimeout(r, 400));
    closeRecruitModal();
    if (typeof campSaveFeedback === "function") {
      campSaveFeedback({ title: payload.title, changes: _changed, mode: _wasEdit ? "edit" : "create" });
    } else {
      showToast(_wasEdit ? "공고가 수정되었습니다." : "공고가 등록되었습니다.", "success");
    }
    loadRecruitList();
    /* ★ 목록 밖에서 열린 모달(홈 작업목록 팝업)이 자기 화면을 갱신할 수 있게 알린다.
       훅 미설정 = 관리자 대시보드 동작 불변(레포의 CS_ON_BADGE 와 같은 방식). */
    try { if (typeof window.CAMP_ON_SAVED === "function") window.CAMP_ON_SAVED(); } catch(_) {}
  } catch(e) {
    /* ★ 실패는 자동으로 사라지지 않는다 — 모달을 열어 둔 채 사유를 남긴다.
       (토스트로 내보내면 모달 덮개 아래로 깔려 "아무 반응 없음"이 된다) */
    _rfSaveBlocked("저장하지 못했습니다 — " + (e && e.message ? e.message : "잠시 후 다시 시도해주세요"));
  } finally {
    if (!_ok) {
      btn.disabled = false;
      btn.classList.remove("busy", "done");
      btn.innerHTML = '<i class="fas fa-save"></i> 저장';
    }
  }
}

// The shared recruit modal invokes this action from inline controls in both
// admin.html and workdesk.html.  Expose it explicitly so the action remains
// callable even when the host page's script scope is isolated.
async function saveRecruitPost() {
  try {
    if (typeof recruitSaveBlockClear === "function") recruitSaveBlockClear();
    return await saveRecruitPostImpl();
  } catch (e) {
    const reason = e && e.message ? e.message : '알 수 없는 저장 전 오류';
    _rfSaveBlocked(`저장 전 처리 중 오류가 발생했습니다: ${reason}`);
    console.error('[recruit] save preflight failed', e);
  }
}
window.saveRecruitPost = saveRecruitPost;

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
/** 홈·목록 카드 미리보기 — 실제 카드(campaign-cards.js cardHtml)가 읽는 필드만 모은다.
 *  모형 카드를 새로 그리지 않고 **같은 렌더러**를 쓴다(리뷰어 화면과 어긋나지 않게).
 *  클릭은 컨테이너 pointer-events:none 로 막아 미리보기 안의 버튼(⭐·수정 등)이 동작하지 않는다. */
function _buildCardPreviewData() {
  const v = id => (document.getElementById(id)?.value || "").trim();
  const status = v("rf_status") || "active";
  return {
    id: _recruitEditId || "preview",
    title: v("rf_title"),
    channel: v("rf_channel"),
    channel_custom: v("rf_channel_custom"),
    delivery_type: v("rf_delivery_type"),
    cashReceiptRequired: !!document.getElementById("rf_cash_receipt_required")?.checked,
    // ★ 082: 구간을 켰으면 카드 미리보기도 **오늘 적용 금액**을 보여준다(서버 목록 응답과 같은 규칙)
    review_fee: _feePreviewToday(Number(v("rf_review_fee")) || 0),
    time_range: v("rf_time_range"),
    badges: _recruitBadges.slice(),
    thumbnail_url: v("rf_thumbnail"),
    participation_mode: true,
    status,
    state: status === "closed" ? "closed" : "open",
  };
}
function _renderCardPreview() {
  const el = document.getElementById("rf_preview_listcard");
  if (!el || !window.CampCards) return;
  el.innerHTML = CampCards.cardHtml(_buildCardPreviewData(), { admin: false });
}

function _renderPreview() {
  _renderCardPreview();   // 목록 카드는 CampWorkDetail 유무와 무관하게 항상 최신 반영
  const card = document.getElementById("rf_preview_card");
  if (!card || !window.CampWorkDetail) return;

  /* ★ 리뷰어가 참여 후 실제로 보는 화면을 그대로 그린다 — campaign.html과 같은 공용 렌더러
     (js/campaign-workdetail.js)를 쓰므로 미리보기와 실제 화면이 어긋날 수 없다.
     따로 만든 모형 카드는 실물과 계속 달라져서 제거했다. */
  const _v = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ""; };

  // 유입가이드: 저장할 값과 **같은 조립 함수**를 쓴다 — 미리보기와 실제 저장본이 갈라질 수 없다.
  const inflowHtml = _igComposeInflow();

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
      reviewGuideImages: _igUrls("review"),     // 🖼 첨부는 그 카드 안에(리뷰어 화면과 같은 렌더러)
      specialNotesImages: _igUrls("notes"),
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
/* "참여 후 작업내용 화면"은 작업내용 필드가 바뀔 때, "홈·목록 카드"는 카드에 실제
   노출되는 필드(제목·채널·배송유형·리뷰비·구매시간대·상태)가 바뀔 때 다시 그린다.
   안내배지(_refreshBadgeWrap)·채널/담당자 버튼(selectRfBtn)·썸네일(upload/fetch)은
   이미 각자 _onPreviewInput()을 호출하도록 아래에서 감싼다. */
const _PREVIEW_INPUTS = ["rf_wd_product","rf_wd_inflow","rf_wd_review","rf_wd_notes","rf_landing_url","rf_hold_ttl",
  "rf_title","rf_channel_custom","rf_review_fee","rf_time_range"];
const _PREVIEW_SELECTS = ["rf_delivery_type","rf_status"];
const _PREVIEW_CHECKS = ["rf_cash_receipt_required"];

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
  _PREVIEW_CHECKS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", _onPreviewInput);
  });
  const thumbUrl = document.getElementById("rf_thumb_url");
  if (thumbUrl) thumbUrl.addEventListener("input", _syncCampThumbUrlPreview);
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
  _PREVIEW_CHECKS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.removeEventListener("change", _onPreviewInput);
  });
  const thumbUrl = document.getElementById("rf_thumb_url");
  if (thumbUrl) thumbUrl.removeEventListener("input", _syncCampThumbUrlPreview);
}

/* ═══════════════════════════════════════════════════════════════════════
   🧹 4칸 정리 도우미 (4칸 정리 개선 ③·④ — docs/모집공고_4칸정리_개선_와이어프레임.html)
   ─────────────────────────────────────────────────────────────────────
   감지는 자동·경고 전용(게시는 절대 막지 않는다), 정리는 항상 **전/후 미리보기 → 사람 [적용]**
   (조용한 자동수정 금지 — 슬래시양식 보정 배지와 같은 규율).
   ★ 판정 = "정리 함수를 돌려보고 달라지는가" — 정리 규칙의 단일 출처는
     work-order-detail.js(_woStripReviewMeta/_woPickSections)이고, 관리자 카드 배지
     (campaign-cards.js needsFieldCleanup)도 같은 함수를 쓴다(감지≠정리 드리프트 금지).
   ★ 유입가이드가 원본 HTML 모드(dataset.rawHtml='1' — 이미지 포함 보존)면 값 수정을
     제안하지 않는다 — textarea 를 고치는 순간 원본 서식·이미지가 빠진다(안내만).
   ═══════════════════════════════════════════════════════════════════════ */
const _CLEAN_MIX_RE = /(주소|연락처|폰번호|전화번호|입금|계좌|송금)/;
const _cleanEsc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function _cleanNormText(v) {
  return String(v || "").replace(/\n{3,}/g, "\n\n").trim();
}
function _cleanReviewValue(v) {
  if (typeof _woStripReviewMeta !== "function" || typeof _woPickSections !== "function") return _cleanNormText(v);
  return _woStripReviewMeta(_woPickSections(String(v || ""), ["리뷰등록 가이드", "리뷰가이드", "리뷰 가이드"]));
}
/** 유의사항 원문 덤프 지문 — 카드 배지(_campNeedsFieldCleanup)와 같은 규칙 */
function _cleanNotesDirty(v) {
  const t = String(v || "");
  return /\[(유입방식|유입가이드|링크유입|리뷰등록 가이드|리뷰가이드)\]/.test(t)
    || /(?:쿠팡\s*)?상품번호\s*[:：]/.test(t) || /▶\s*옵션\s*[:：]\s*결제금액\s*◀/.test(t);
}
/** 유입가이드에서 진입 방법이 아닌 안내 조각(주소·연락처류) 추출 — 줄/'/' 구분 단위 */
function _cleanInflowSplit(v) {
  const keep = [], move = [];
  String(v || "").split(/\r?\n/).forEach(line => {
    if (!_CLEAN_MIX_RE.test(line)) { keep.push(line); return; }
    const parts = line.split("/");
    if (parts.length > 1) {
      const k = parts.filter(p => !_CLEAN_MIX_RE.test(p));
      const m = parts.filter(p => _CLEAN_MIX_RE.test(p));
      if (k.length) keep.push(k.map(s => s.trim()).join(" / "));
      move.push(...m.map(s => s.trim()).filter(Boolean));
    } else {
      move.push(line.trim());
    }
  });
  return { keep: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), move: move.filter(Boolean) };
}

function renderRecruitFieldCleanup() {
  const $ = id => document.getElementById(id);
  const warnHtml = (msg, btnLabel, kind) =>
    `<div class="rf-clean-warn">⚠ ${msg}` +
    (btnLabel ? ` <button type="button" class="rchan-btn" onclick="rfCleanPreview('${kind}')">${btnLabel}</button>` : "") +
    `</div><div id="rf_clean_pv_${kind}"></div>`;

  // ① 리뷰가이드 — 정리해 보고 달라지면 오염(신규 프리필은 이미 깨끗해 no-op)
  const rv = $("rf_wd_review"), cR = $("rf_clean_review");
  if (rv && cR) {
    const cur = _cleanNormText(rv.value);
    cR.innerHTML = (cur && _cleanReviewValue(rv.value) !== cur)
      ? warnHtml("유입 메타·상품번호 줄이 섞여 있어요(리뷰어 화면 이중 표기)", "🧹 리뷰가이드만 남기기", "review")
      : "";
  }
  // ② 유의사항 — 공고 카드(참여 전 공개)에 내부 원문 지문
  const nt = $("rf_notes"), cN = $("rf_clean_notes");
  if (nt && cN) {
    cN.innerHTML = _cleanNotesDirty(nt.value)
      ? warnHtml("공고 카드에 <b>모두에게 공개</b>되는 칸이에요 — 내부 원문(섹션 라벨·상품번호)이 감지됐어요", "🧹 비우기", "notes")
      : "";
  }
  // ③ 유입가이드 — 진입 방법 외 안내 조각(원본 HTML 모드는 값 수정 제안 없음)
  const infl = $("rf_wd_inflow"), cI = $("rf_clean_inflow");
  if (infl && cI) {
    const rawMode = infl.dataset.rawHtml === "1";
    const { move } = _cleanInflowSplit(infl.value);
    if (!move.length) cI.innerHTML = "";
    else if (rawMode) cI.innerHTML = `<div class="rf-clean-warn">⚠ 주소·연락처류 안내가 섞인 것 같아요 — 원본 서식(이미지 포함) 공고라 자동 이동은 못 해요. 특이사항으로 옮기려면 직접 수정해주세요</div>`;
    else cI.innerHTML = warnHtml("진입 방법 외의 안내문이 섞인 것 같아요 — 참여자 주의사항이면 특이사항으로", "↘ 특이사항으로 이동", "inflow");
  }
}

/** 🧹 미리보기 — 무엇이 지워지고/옮겨지고 무엇이 남는지 보여준 뒤에만 [적용]이 가능하다 */
function rfCleanPreview(kind) {
  const pv = document.getElementById("rf_clean_pv_" + kind);
  if (!pv) return;
  const btns = `<div class="rf-cpv-btns"><button type="button" class="rchan-btn" onclick="document.getElementById('rf_clean_pv_${kind}').innerHTML=''">취소</button>` +
    `<button type="button" class="rchan-btn" style="background:var(--p,#3182F6);border-color:var(--p,#3182F6);color:#fff" onclick="rfCleanApply('${kind}')">적용</button></div>`;
  if (kind === "review") {
    const cur = _cleanNormText(document.getElementById("rf_wd_review").value);
    const cleaned = _cleanReviewValue(cur);
    const keptSet = new Set(cleaned.split("\n").map(s => s.trim()));
    const body = cur.split("\n").map(l =>
      (l.trim() && !keptSet.has(l.trim())) ? `<span class="cut">${_cleanEsc(l)}</span>` : `<span class="keep">${_cleanEsc(l)}</span>`
    ).join("\n");
    pv.innerHTML = `<div class="rf-clean-pv"><div class="rf-cpv-t">🧹 정리 미리보기 — 빨간 줄이 지워집니다. 확인 후 [적용]</div><pre>${body}</pre>${btns}</div>`;
  } else if (kind === "notes") {
    const cur = document.getElementById("rf_notes").value;
    pv.innerHTML = `<div class="rf-clean-pv"><div class="rf-cpv-t">🧹 비우기 미리보기 — 아래 내용이 전부 지워집니다(공개용 안내는 직접 작성)</div><pre><span class="cut">${_cleanEsc(cur)}</span></pre>${btns}</div>`;
  } else if (kind === "inflow") {
    const { keep, move } = _cleanInflowSplit(document.getElementById("rf_wd_inflow").value);
    pv.innerHTML = `<div class="rf-clean-pv"><div class="rf-cpv-t">↘ 이동 미리보기 — 확인 후 [적용]</div>` +
      `<div>유입가이드에 남는 내용</div><pre><span class="keep">${_cleanEsc(keep || "(비어 있음)")}</span></pre>` +
      `<div>특이사항으로 옮겨질 내용</div><pre><span class="cut">${_cleanEsc(move.join("\n"))}</span></pre>${btns}</div>`;
  }
}

function rfCleanApply(kind) {
  if (kind === "review") {
    const el = document.getElementById("rf_wd_review");
    el.value = _cleanReviewValue(el.value);
  } else if (kind === "notes") {
    document.getElementById("rf_notes").value = "";
  } else if (kind === "inflow") {
    const infl = document.getElementById("rf_wd_inflow");
    const nt = document.getElementById("rf_wd_notes");
    const { keep, move } = _cleanInflowSplit(infl.value);
    infl.value = keep;
    if (nt && move.length) nt.value = (nt.value ? nt.value.replace(/\s+$/, "") + "\n" : "") + move.join("\n");
  }
  renderRecruitFieldCleanup();   // 경고 재판정(정리됐으면 사라진다)
  _onPreviewInput();             // 우측 미리보기도 새 값으로
}
if (typeof window !== "undefined") {
  window.rfCleanPreview = rfCleanPreview;
  window.rfCleanApply = rfCleanApply;
}

/* 입력 중에도 감지 갱신(디바운스) — 모달 마운트가 스크립트보다 먼저라 로드 시점 바인딩 가능 */
let _cleanDebounce = null;
["rf_wd_review", "rf_wd_inflow", "rf_notes"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", () => {
    clearTimeout(_cleanDebounce);
    _cleanDebounce = setTimeout(() => { try { renderRecruitFieldCleanup(); } catch (_) {} }, 250);
  });
});

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
