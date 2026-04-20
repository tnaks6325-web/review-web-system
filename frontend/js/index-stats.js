/* ── 진행률 통계 패널 ── */
async function openStatsPanel(sheetId, tabName, displayName) {
  const overlay = document.getElementById("statsPanelOverlay");
  const titleEl = document.getElementById("statsPanelTabName");
  const content = document.getElementById("statsPanelContent");
  titleEl.textContent = displayName || tabName || "진행률";
  content.innerHTML = `<div style="text-align:center;padding:30px;color:var(--t3)"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>`;
  overlay.classList.add("open");
  try {
    const data = await gasPost({ action:"getCampaignStats", sheetId, tabName });
    _renderStatsPanel(data, displayName || tabName);
  } catch(e) {
    content.innerHTML = `<div style="color:#DC2626;text-align:center;padding:20px"><i class="fas fa-exclamation-circle"></i> ${escHtml(e.message)}</div>`;
  }
}

function closeStatsPanel() {
  document.getElementById("statsPanelOverlay").classList.remove("open");
}

function _renderStatsPanel(d, label) {
  const content = document.getElementById("statsPanelContent");
  const rate    = d.rate || 0;
  const barColor = rate === 100 ? "full" : "";

  // 미완료 이름 칩
  const pendingChips = (d.pendingNames || []).length > 0
    ? d.pendingNames.map(n => `<span class="stats-name-chip pending-chip">${escHtml(n)}</span>`).join("")
    : `<span class="stats-empty-msg">없음 🎉</span>`;

  // 완료 이름 칩 (최대 30명까지 표시)
  const doneNames = (d.submittedNames || []);
  const doneChips = doneNames.length > 0
    ? doneNames.slice(0,30).map(n => `<span class="stats-name-chip done-chip">${escHtml(n)}</span>`).join("")
      + (doneNames.length > 30 ? `<span style="font-size:.7rem;color:var(--t3)">외 ${doneNames.length-30}명</span>` : "")
    : `<span class="stats-empty-msg">아직 없음</span>`;

  content.innerHTML = `
    <div class="stats-tab-name"><i class="fas fa-table" style="color:var(--p);margin-right:5px"></i>${escHtml(label)}</div>
    <div class="stats-summary-grid">
      <div class="stats-card total">
        <div class="stats-card-val">${d.total||0}</div>
        <div class="stats-card-lbl">전체</div>
      </div>
      <div class="stats-card done">
        <div class="stats-card-val">${d.submitted||0}</div>
        <div class="stats-card-lbl">완료</div>
      </div>
      <div class="stats-card pending">
        <div class="stats-card-val">${d.pending||0}</div>
        <div class="stats-card-lbl">미완료</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <span style="font-size:.78rem;font-weight:700;color:var(--t2)">진행률</span>
      <span style="font-size:.9rem;font-weight:800;color:${rate===100?'var(--ok)':'var(--p)'}">${rate}%</span>
    </div>
    <div class="stats-bar-wrap">
      <div class="stats-bar-fill ${barColor}" style="width:${rate}%"></div>
    </div>
    ${(d.tuip||0)>0||((d.chuihap||0)>0) ? `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      ${(d.tuip||0)>0 ? `<span class="work-badge badge-tuip"><i class="fas fa-user-plus"></i> 투입중 ${d.tuip}</span>` : ''}
      ${(d.chuihap||0)>0 ? `<span class="work-badge badge-chuihap"><i class="fas fa-layer-group"></i> 취합중 ${d.chuihap}</span>` : ''}
    </div>` : ''}
    <div class="stats-section-title"><i class="fas fa-clock" style="color:#F59E0B"></i> 미완료 리뷰어 (${(d.pendingNames||[]).length}명)</div>
    <div class="stats-name-list">${pendingChips}</div>
    <div class="stats-section-title" style="margin-top:4px"><i class="fas fa-check-circle" style="color:var(--ok)"></i> 완료 리뷰어 (${doneNames.length}명)</div>
    <div class="stats-name-list">${doneChips}</div>
  `;
}

/* ── 블랙리스트 관리 패널 ── */
function openBlPanel() {
  document.getElementById("blPanelOverlay").classList.add("open");
  loadBlacklist();
}

function closeBlPanel() {
  document.getElementById("blPanelOverlay").classList.remove("open");
}

async function loadBlacklist() {
  const listEl = document.getElementById("blList");
  const cntEl  = document.getElementById("blCountBadge");
  listEl.innerHTML = `<div class="bl-empty"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>`;
  try {
    const data = await gasPost({ action:"blacklist", action2:"list" });
    const list = data.list || [];
    cntEl.textContent = list.length;
    if (list.length === 0) {
      listEl.innerHTML = `<div class="bl-empty"><i class="fas fa-smile"></i><br>등록된 블랙리스트가 없습니다.</div>`;
      return;
    }
    listEl.innerHTML = list.map(item => `
      <div class="bl-item">
        <div class="bl-item-info">
          <div class="bl-item-name"><i class="fas fa-ban" style="font-size:.72rem"></i> ${escHtml(item.name)}</div>
          <div class="bl-item-meta">등록일: ${escHtml(item.date)} · 등록자: ${escHtml(item.addedBy||'관리자')}${item.phone ? ` · ${escHtml(item.phone)}` : ''}</div>
          ${item.reason ? `<div class="bl-item-reason">사유: ${escHtml(item.reason)}</div>` : ''}
        </div>
        <button class="btn-bl-remove" onclick="removeBlacklist(${item.rowNum},'${escHtml(item.name)}')">해제</button>
      </div>`).join("");
  } catch(e) {
    listEl.innerHTML = `<div class="bl-empty" style="color:#DC2626"><i class="fas fa-exclamation-circle"></i> ${escHtml(e.message)}</div>`;
  }
}

async function addBlacklist() {
  const name   = document.getElementById("blInputName").value.trim();
  const phone  = document.getElementById("blInputPhone").value.trim();
  const reason = document.getElementById("blInputReason").value.trim();
  if (!name) { showToast("이름을 입력하세요.", "error"); document.getElementById("blInputName").focus(); return; }
  const btn = document.getElementById("btnBlAdd");
  btn.disabled = true;
  try {
    const data = await gasPost({ action:"blacklist", action2:"add", name, phone, reason, addedBy:"관리자" });
    if (data.alreadyExists) { showToast(data.message, "warning"); return; }
    showToast(data.message || "블랙리스트에 등록했습니다.", "success");
    document.getElementById("blInputName").value   = "";
    document.getElementById("blInputPhone").value  = "";
    document.getElementById("blInputReason").value = "";
    loadBlacklist();
  } catch(e) {
    showToast("등록 실패: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function removeBlacklist(rowNum, name) {
  if (!confirm(`"${name}" 를 블랙리스트에서 해제하시겠습니까?`)) return;
  try {
    const data = await gasPost({ action:"blacklist", action2:"remove", rowNum });
    showToast(data.message || "블랙리스트 해제 완료", "success");
    loadBlacklist();
  } catch(e) {
    showToast("해제 실패: " + e.message, "error");
  }
}

/* ── 공지 배너 설정 ── */
function openNoticePanel() {
  // 현재 저장된 공지 불러오기
  try {
    const saved = localStorage.getItem("rapp_notice");
    if (saved) {
      const obj = JSON.parse(saved);
      const typeEl   = document.getElementById("noticeType");
      const textEl   = document.getElementById("noticeText");
      const expireEl = document.getElementById("noticeExpire");
      if (typeEl   && obj.type)  typeEl.value   = obj.type;
      if (textEl   && obj.text)  textEl.value   = obj.text;
    }
  } catch(_) {}
  document.getElementById("noticePanelStatus").textContent = "";
  document.getElementById("noticePanelOverlay").classList.add("open");
}

function closeNoticePanel() {
  document.getElementById("noticePanelOverlay").classList.remove("open");
}

function saveNotice() {
  const type    = document.getElementById("noticeType").value;
  const text    = document.getElementById("noticeText").value.trim();
  const days    = parseInt(document.getElementById("noticeExpire").value);
  const statusEl = document.getElementById("noticePanelStatus");
  if (!text) { statusEl.textContent = "⚠️ 공지 내용을 입력하세요."; statusEl.style.color="#DC2626"; return; }
  const expires = days > 0 ? Date.now() + days * 86400000 : null;
  const obj = { text, type, active: true, expires, savedAt: Date.now() };
  localStorage.setItem("rapp_notice", JSON.stringify(obj));
  statusEl.textContent = "✅ 공지가 저장되었습니다. (리뷰어 화면에 즉시 반영)";
  statusEl.style.color = "var(--ok)";
  showToast("공지 배너가 설정되었습니다.", "success");
}

function clearNotice() {
  localStorage.removeItem("rapp_notice");
  document.getElementById("noticeText").value = "";
  const statusEl = document.getElementById("noticePanelStatus");
  statusEl.textContent = "🗑️ 공지가 삭제되었습니다.";
  statusEl.style.color = "var(--t3)";
  showToast("공지 배너가 삭제되었습니다.", "success");
}
