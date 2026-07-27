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
async function loadRecruitList() {
  const wrap = document.getElementById("recruitListWrap");
  wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>`;
  try {
    const res  = await fetch(API_BASE_URL + "/api/campaign/admin/list", {
      headers: _getAuthHeaders()
    });
    const json = await res.json();
    const list = json.data || [];
    if (list.length === 0) {
      wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--t4);font-size:.85rem"><i class="fas fa-bullhorn" style="font-size:1.5rem;display:block;margin-bottom:10px;opacity:.3"></i>등록된 공고가 없습니다.<br><small>우측 상단 [공고 등록] 버튼을 눌러 첫 공고를 작성해보세요.</small></div>`;
      return;
    }
    wrap.innerHTML = "";
    list.forEach(c => {
      const card = _buildRecruitCard(c);
      wrap.appendChild(card);
    });
  } catch(e) {
    wrap.innerHTML = `<div style="padding:30px;text-align:center;color:var(--err)"><i class="fas fa-exclamation-circle"></i> 불러오기 실패: ${escHtml(e.message)}</div>`;
  }
}

/* 공고 카드 DOM 생성 */
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
  div.innerHTML = `
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
      </div>
      ${_recruitToggleHtml(c)}
    </div>
  `;
  return div;
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
    const res = await fetch(API_BASE_URL + "/api/campaign/admin/" + encodeURIComponent(id) + "/status", {
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
    }
  } else {
    info.style.display = "none";
  }
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
function onParticipationToggle(on) {
  const sec = document.getElementById("rf_part_section");
  if (sec) sec.style.display = on ? "" : "none";
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
  box.innerHTML = items.map(i =>
    `<div style="display:flex;align-items:center;gap:7px;font-size:.74rem;font-weight:700;border-radius:8px;padding:6px 10px;
       ${i.fail ? "color:#B91C1C;background:#FEF2F2;border:1px solid #FECACA" : "color:#065F46;background:#ECFDF5;border:1px solid #6EE7B7"}">
       ${i.fail ? "✗" : "✓"} ${i.label}</div>`).join("");
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
  row.style.cssText = "display:grid;grid-template-columns:1.5fr 1fr .8fr .8fr auto;gap:6px;align-items:center;margin-bottom:6px" + (status === "closed" ? ";opacity:.68" : "");
  const lastBtn = status === "closed"
    ? '<button type="button" class="btn-icon-sm rf-opt-reopen" title="옵션 재개(다시 모집)" style="color:#12b886"><i class="fas fa-rotate-left"></i></button>'
    : '<button type="button" class="btn-icon-sm rf-opt-del" title="옵션 삭제" style="color:#EF4444"><i class="fas fa-times"></i></button>';
  row.innerHTML =
    '<input class="rform-input rf-opt-name" placeholder="옵션명" style="font-size:.74rem;padding:7px 8px">' +
    '<input class="rform-input rf-opt-pay" type="number" min="0" placeholder="금액" style="font-size:.74rem;padding:7px 8px">' +
    '<input class="rform-input rf-opt-rt" type="number" min="0" placeholder="정원" style="font-size:.74rem;padding:7px 8px">' +
    '<input class="rform-input rf-opt-dl" type="number" min="0" placeholder="하루" style="font-size:.74rem;padding:7px 8px">' +
    lastBtn;
  const rt = d.recruitTotal ?? d.recruit_total, dl = d.dailyLimit ?? d.daily_limit, pay = d.payAmount ?? d.pay_amount;
  row.querySelector(".rf-opt-name").value = d.optKey ?? d.opt_key ?? "";
  row.querySelector(".rf-opt-pay").value  = pay ? pay : "";
  row.querySelector(".rf-opt-rt").value   = rt ? rt : "";     // 0/무제한은 빈칸으로
  row.querySelector(".rf-opt-dl").value   = dl ? dl : "";
  if (status === "closed") row.querySelector(".rf-opt-name").title = "마감된 옵션(참여자 보호로 유지) — 재개 버튼으로 다시 모집할 수 있어요";
  row.querySelectorAll("input").forEach(i => i.addEventListener("input", () => { _optSummary(); renderPartCheck(); }));
  const del = row.querySelector(".rf-opt-del");
  if (del) del.onclick = () => { row.remove(); _optSummary(); renderPartCheck(); };
  const reopen = row.querySelector(".rf-opt-reopen");
  if (reopen) reopen.onclick = () => {   // 마감 옵션 재개 → active + 삭제 버튼으로 교체(재개는 명시적 의도로만)
    row.dataset.status = "active"; row.style.opacity = "";
    reopen.outerHTML = '<button type="button" class="btn-icon-sm rf-opt-del" title="옵션 삭제" style="color:#EF4444"><i class="fas fa-times"></i></button>';
    row.querySelector(".rf-opt-del").onclick = () => { row.remove(); _optSummary(); renderPartCheck(); };
    row.querySelector(".rf-opt-name").title = "";
    _optSummary(); renderPartCheck();
  };
  wrap.appendChild(row);
  _optSummary();
}
function renderOptRows(options) {
  const wrap = document.getElementById("rf_opt_rows");
  if (!wrap) return;
  wrap.innerHTML = "";
  (options || []).forEach(o => addOptRow(o));
  _optSummary();
}
/** 옵션표 → 저장 payload 배열(빈 옵션명 제거, '|' 정규화, 마감상태 보존) */
function readOptRows() {
  const out = [];
  document.querySelectorAll("#rf_opt_rows .rf-opt-row").forEach(r => {
    const optKey = String(r.querySelector(".rf-opt-name").value || "").replace(/\|/g, "").trim();
    if (!optKey) return;
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
  const camRt = Number(document.getElementById("rf_recruit_total")?.value || 0);
  const camDl = Number(document.getElementById("rf_daily_limit")?.value || 0);
  const msgs = ["옵션 " + active.length + "종" + (closedN ? "(+마감 " + closedN + ")" : "") + " · 정원합 " + (anyUnlimited ? "무제한" : rtSum + "명") + (dlSum ? (" · 하루합 " + dlSum + "건") : "")];
  if (dup) msgs.push("⚠ 옵션명 중복(저장 불가)");
  if (!anyUnlimited && camRt && camRt !== rtSum) msgs.push("⚠ 총모집(" + camRt + ")≠정원합(" + rtSum + ")");
  if (allHaveDaily && dlSum && camDl && camDl !== dlSum) msgs.push("⚠ 하루한도(" + camDl + ")≠옵션 하루합(" + dlSum + ")");
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

  const modal    = document.getElementById("recruitModal");
  const titleEl  = document.getElementById("recruitModalTitle");

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
      document.getElementById("rf_title").value        = c.title || "";
      document.getElementById("rf_time_range").value   = c.time_range || "";
      document.getElementById("rf_review_fee").value   = c.review_fee || "";
      document.getElementById("rf_notes").value        = c.notes || "";
      document.getElementById("rf_chat_url").value     = c.chat_url || "";
      document.getElementById("rf_sort_order").value   = c.sort_order ?? 0;
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
        const wd = (typeof c.work_detail === "string") ? (() => { try { return JSON.parse(c.work_detail); } catch (_) { return {}; } })() : (c.work_detail || {});
        // 저장 시 escape+<br> 변환의 역변환(S3): <br>→개행, 엔티티 복원 → textarea에 평문으로
        const _fromHtml = s => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        setV("rf_wd_product", wd.productLines || "");
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
        renderOptRows(json.options || []);   // 🧩 옵션표 프리필(관리자 GET /:id가 반환하는 원본 옵션)
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
        renderOptRows(prefill.options || []);   // 🧩 작업오더 옵션 프리필(product_options_json → 옵션표)
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
        <button onclick="document.getElementById('campControlOvl').remove()" style="background:none;border:none;font-size:1.1rem;cursor:pointer;color:#9CA3AF"><i class="fas fa-times"></i></button>
      </div>
      <div id="ccBody" style="overflow-y:auto;padding:12px 18px"></div>
    </div>`;
    ovl.addEventListener("click", e => { if (e.target === ovl) ovl.remove(); });
    document.body.appendChild(ovl);
  }
  document.getElementById("ccTitle").textContent = "📡 관제 — " + (title || campId);
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

async function _loadCampControl(campId) {
  const body = document.getElementById("ccBody");
  const stats = document.getElementById("ccStats");
  try {
    const res = await fetch(API_BASE_URL + `/api/campaign/admin/${encodeURIComponent(campId)}/applications`, { headers: _getAuthHeaders() });
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
    if (stats) stats.textContent = `오늘 · 진행중 ${holds} / 제출 ${subs} / 만료 ${exps}`;
    // 🧩 옵션별 현황표(061 3단계) — 옵션 등록 캠페인만
    const optTableHtml = _campOptionTable(j.options || [], items, now, today, kstDay);
    if (!items.length) {
      body.innerHTML = optTableHtml + `<div style="padding:30px;text-align:center;color:#9CA3AF">참여 이력이 없습니다.</div>`;
      return;
    }
    const chip = (bg, fg, tx) => `<span style="font-size:.66rem;font-weight:800;background:${bg};color:${fg};border-radius:6px;padding:2px 8px;white-space:nowrap">${tx}</span>`;
    const fmtT = iso => iso ? new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    body.innerHTML = optTableHtml + items.sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at)).map(r => {
      const holdValid = r.status === "applied" && r.expires_at && Date.parse(r.expires_at) > now;
      let st;
      if (r.status === "submitted") st = chip("#D1FAE5", "#065F46", "✓ 제출확정");
      else if (holdValid) st = chip("#FEF3C7", "#92400E", "⏳ 진행중");
      else if (r.status === "cancelled") st = chip("#F3F4F6", "#6B7280", "취소");
      else st = chip("#FEE2E2", "#B91C1C", "만료");
      const late = r.late_order_id ? chip("#EDE9FE", "#5B21B6", "🛍 기구매 제출 있음") : "";
      // ★ 리뷰 #4: 수동확정은 만료·취소 건만(서버 의도 = 기구매 구제 경로).
      //   진행중(applied)은 확정 시 주문 링크가 영구 결번되므로 버튼 미노출(정상 제출 경로로 확정되게 둠).
      const canConfirm = (r.status === "expired" || r.status === "cancelled");
      const escT = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<div style="display:flex;align-items:center;gap:8px;padding:9px 4px;border-bottom:1px solid #F3F4F6;font-size:.8rem">
        <b style="min-width:64px">${escT(r.applicant_name)}</b>
        <span style="color:#9CA3AF;font-size:.7rem">***${String(r.phone8 || "").replace(/\D/g, "").slice(-4)}</span>
        ${st}${late}
        <span style="margin-left:auto;color:#9CA3AF;font-size:.68rem">신청 ${fmtT(r.applied_at)}${r.expires_at ? " · 마감 " + fmtT(r.expires_at) : ""}</span>
        ${canConfirm ? `<button onclick="campManualConfirm('${String(campId).replace(/[^a-z0-9_]/gi, "")}',${parseInt(r.id, 10)},${r.late_order_id ? 1 : 0})" style="font-size:.7rem;font-weight:800;background:#e8f1fe;color:#1b64da;border:1px solid #a6c8fb;border-radius:7px;padding:4px 10px;cursor:pointer;white-space:nowrap">수동확정</button>` : ""}
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
    const res = await fetch(API_BASE_URL + `/api/campaign/admin/${encodeURIComponent(campId)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ..._getAuthHeaders() },
      body: JSON.stringify({ applicationId: appId }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
    showToast(j.already ? "이미 확정된 신청입니다." : "수동 확정되었습니다.", "success");
    await _loadCampControl(campId);
  } catch (e) {
    showToast("수동확정 실패: " + e.message, "error");
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
    sort_order:     Number(document.getElementById("rf_sort_order").value) || 0,
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
      payload.daily_limit    = Number(document.getElementById("rf_daily_limit").value) || 0;
      payload.recruit_total  = Number(document.getElementById("rf_recruit_total").value) || 0;
      payload.hold_ttl_min   = Number(document.getElementById("rf_hold_ttl").value) || 15;
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
      res = await fetch(API_BASE_URL + `/api/campaign/admin/${_recruitEditId}`, {
        method: "PUT",
        headers: {"Content-Type":"application/json", ..._getAuthHeaders()},
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(API_BASE_URL + "/api/campaign/admin/create", {
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
    const res = await fetch(API_BASE_URL + `/api/campaign/admin/${id}`, {
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
  if (!card) return;

  const title       = document.getElementById("rf_title").value.trim() || "(제목 없음)";
  const channel     = document.getElementById("rf_channel").value.trim();
  const channelCustom = document.getElementById("rf_channel_custom").value.trim();
  const channelText = channel === "직접입력" ? (channelCustom || "직접입력") : channel;
  const manager     = document.getElementById("rf_manager").value.trim();
  const timeRange   = document.getElementById("rf_time_range").value.trim();
  const deliveryType = document.getElementById("rf_delivery_type").value;
  const reviewFee   = Number(document.getElementById("rf_review_fee").value) || 0;
  const notes       = document.getElementById("rf_notes").value.trim();
  const maxSlots    = Number(document.getElementById("rf_max_slots").value) || 0;
  const badges      = _recruitBadges;

  const managerEmoji = manager === "만두" ? "🥟" : manager === "망고" ? "🥭" : "";
  const feeText = reviewFee > 0 ? reviewFee.toLocaleString() + "원" : "";
  const slotsHtml = maxSlots > 0
    ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:.73rem;font-weight:600;color:#0ca678;background:#D1FAE5;padding:2px 9px;border-radius:12px"><i class="fas fa-users" style="font-size:.65rem"></i> 0/${maxSlots}명</span>`
    : "";

  const badgeColors = [
    {bg:'#D1FAE5',c:'#065F46'},{bg:'#DBEAFE',c:'#1E40AF'},{bg:'#FEF3C7',c:'#92400E'},
    {bg:'#e8f1fe',c:'#144a9e'},{bg:'#FCE7F3',c:'#831843'},{bg:'#ECFDF5',c:'#064E3B'}
  ];

  card.innerHTML = `
    <div style="background:linear-gradient(135deg,#0f2a5e 0%,#1b64da 100%);padding:12px 14px;border-radius:12px 12px 0 0;display:flex;align-items:flex-start;gap:8px">
      ${channelText ? `<span style="flex-shrink:0;background:#FDE68A;color:#78350F;padding:2px 8px;border-radius:5px;font-size:.65rem;font-weight:800;margin-top:1px">${escHtml(channelText)}</span>` : ""}
      <span style="font-size:.86rem;font-weight:700;color:#fff;line-height:1.4;flex:1">${escHtml(title)}</span>
      ${manager ? `<span style="font-size:.68rem;color:#A7F3D0;font-weight:600;flex-shrink:0;white-space:nowrap">${managerEmoji} ${escHtml(manager)}</span>` : ""}
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px">
      ${badges.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px">${badges.map((b,i)=>{
        const clr = badgeColors[i%6];
        return `<span style="display:inline-flex;padding:3px 10px;border-radius:16px;font-size:.72rem;font-weight:600;background:${clr.bg};color:${clr.c}">${escHtml(b)}</span>`;
      }).join("")}</div>` : ""}
      ${(timeRange||deliveryType||feeText||slotsHtml) ? `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        ${feeText ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:.78rem;font-weight:700;color:#3182f6"><i class="fas fa-won-sign" style="font-size:.65rem"></i> 리뷰비 ${feeText}</span>` : ""}
        ${deliveryType ? `<span style="font-size:.73rem;color:#6B7280;display:inline-flex;align-items:center;gap:4px"><i class="fas fa-truck" style="font-size:.6rem;color:#9CA3AF"></i>${escHtml(deliveryType)}</span>` : ""}
        ${timeRange ? `<span style="font-size:.73rem;color:#6B7280;display:inline-flex;align-items:center;gap:4px"><i class="fas fa-clock" style="font-size:.6rem;color:#9CA3AF"></i>${escHtml(timeRange)}</span>` : ""}
        ${slotsHtml}
      </div>` : ""}
      ${notes ? `<div>
        <div style="font-size:.65rem;font-weight:700;color:#9CA3AF;margin-bottom:3px;display:flex;align-items:center;gap:3px"><i class="fas fa-clipboard-list" style="font-size:.6rem"></i> 유의사항</div>
        <div style="font-size:.76rem;color:#374151;white-space:pre-line;line-height:1.6">${escHtml(notes)}</div>
      </div>` : ""}
      <div style="height:1px;background:#E5E7EB;margin:2px 0"></div>
      <button disabled style="display:block;width:100%;padding:12px;background:linear-gradient(135deg,#3182f6,#1b64da);color:#fff;border:none;border-radius:10px;font-size:.88rem;font-weight:800;text-align:center;opacity:.9;cursor:default">
        <i class="fas fa-hand-point-up"></i> 참여 신청하기
      </button>
    </div>
  `;
}

/* 입력 이벤트 리스너 (debounce) */
const _PREVIEW_INPUTS = ["rf_title","rf_channel_custom","rf_time_range","rf_review_fee","rf_notes","rf_max_slots"];
const _PREVIEW_SELECTS = ["rf_delivery_type","rf_status"];

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
