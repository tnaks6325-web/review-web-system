/* ══════════════════════════════════════════════════════════
   은행 코드 매핑 (한국 주요 은행)
══════════════════════════════════════════════════════════ */
const BANK_CODE_MAP = {
  "KEB하나":  "081", "하나":      "081", "하나은행":  "081",
  "케이뱅크": "089", "K뱅크":     "089", "KBank":    "089",
  "카카오뱅크":"090", "카카오":    "090",
  "토스뱅크": "092", "토스":      "092",
  "국민":     "004", "KB국민":    "004", "국민은행":  "004",
  "기업":     "003", "IBK기업":   "003", "기업은행":  "003",
  "신한":     "088", "신한은행":  "088",
  "우리":     "020", "우리은행":  "020",
  "농협":     "011", "NH농협":    "011", "농협은행":  "011",
  "SC제일":   "023", "SC":       "023",
  "우체국":   "071",
  "신협":     "048",
  "수협":     "007",
  "대구":     "031", "아이엠뱅크":"031", "iM뱅크":   "031",
  "부산":     "032", "BNK부산":   "032",
  "광주":     "034",
  "전북":     "037",
  "경남":     "039", "BNK경남":   "039",
  "새마을금고":"045",
  "저축은행":  "050",
  "한국씨티":  "027", "씨티":     "027",
  "산업":     "002", "산업은행":  "002",
  "외환":     "005",
  "제주":     "035",
};

function getBankCode(bankName) {
  if (!bankName) return "";
  const bn = bankName.trim();
  if (BANK_CODE_MAP[bn]) return BANK_CODE_MAP[bn];
  // 부분 매칭
  for (const [k, v] of Object.entries(BANK_CODE_MAP)) {
    if (bn.includes(k) || k.includes(bn)) return v;
  }
  return "";
}

/* ══════════════════════════════════════════════════════════
   상태 변수
══════════════════════════════════════════════════════════ */
let _payBank        = "하나은행";   // 선택된 이체 은행
let _payTargets     = [];          // 조회된 입금 대상 전체
let _payFiltered    = [];          // 현재 표시 중인 행 (캠페인 필터 적용)
let _payMissingTabs = [];          // 입금명 없는 탭 목록
let _payPanelInited = false;       // 패널 초기화 여부

/* 패널 초기화 (탭 전환 시 1회 실행) */
function initPaymentPanel() {
  if (!isAdminLoggedIn()) { showToast("세션이 만료되었습니다.", "warning"); return; }
  if (!_payPanelInited) {
    _payPanelInited = true;
    // 대시보드 데이터로 캠페인 목록 초기화
    _populatePayCampaignFilter();
  }
  // 빈 상태 초기 표시
  const emptyEl = document.getElementById("payEmptyState");
  if (emptyEl) { emptyEl.style.display = "block"; }
  const msgEl = document.getElementById("payEmptyMsg");
  if (msgEl) msgEl.textContent = "대상 조회 버튼을 클릭하세요.";
}

/* 캠페인 필터 드롭다운 채우기 */
function _populatePayCampaignFilter() {
  const sel = document.getElementById("payFilterCampaign");
  if (!sel) return;
  sel.innerHTML = '<option value="">전체 캠페인</option>';
  if (!_lastDashData || !_lastDashData.stats) return;
  _lastDashData.stats.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.sheetId || c.campaign || c.c || "";
    opt.textContent = c.campaign || c.c || c.sheetId || "미분류";
    sel.appendChild(opt);
  });
}

/* 이체 은행 선택 */
function selectPayBank(bank) {
  _payBank = bank;
  document.getElementById("payBankHana").classList.toggle("active", bank === "하나은행");
  document.getElementById("payBankK").classList.toggle("active", bank === "케이뱅크");
}

/* 입금 대상 조회 */
async function loadPaymentTargets() {
  if (!isAdminLoggedIn()) { showToast("세션이 만료되었습니다.", "warning"); return; }
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS 웹앱 URL을 먼저 설정해주세요.", "warning"); return; }

  const btn = document.getElementById("payLoadBtn");
  const prevHtml = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 조회 중...'; }

  const emptyEl = document.getElementById("payEmptyState");
  const previewWrap = document.getElementById("payPreviewWrap");
  const actionBar   = document.getElementById("payActionBar");
  const warningEl   = document.getElementById("payDepositNameWarning");
  if (previewWrap) previewWrap.style.display = "none";
  if (actionBar)   actionBar.style.display   = "none";
  if (warningEl)   warningEl.style.display   = "none";
  if (emptyEl)     emptyEl.style.display     = "block";
  const msgEl = document.getElementById("payEmptyMsg");
  if (msgEl) msgEl.textContent = "조회 중...";

  try {
    const filterSel = document.getElementById("payFilterCampaign");
    const filterSheetId = filterSel ? filterSel.value : "";
    const payload = { action: "getPaymentTargets" };
    if (filterSheetId) payload.sheetIds = [filterSheetId];

    let json;
    try { json = await gasPost(payload); } catch(e) { json = await gasGet(payload); }

    if (json.error) throw new Error(json.error);

    _payTargets  = json.targets || [];
    _payFiltered = _payTargets;

    if (!_payFiltered.length) {
      if (msgEl) msgEl.textContent = "입금 대상이 없습니다. (리뷰 완료 + 입금 미완료)";
      return;
    }

    // 입금명 없는 탭 탐색
    const missingMap = {};
    _payFiltered.forEach(r => {
      if (!r.depositName) {
        const k = r.sheetId + "||" + r.tabName;
        if (!missingMap[k]) missingMap[k] = { sheetId: r.sheetId, tabName: r.tabName, campaignName: r.campaignName };
      }
    });
    _payMissingTabs = Object.values(missingMap);

    if (_payMissingTabs.length > 0) {
      const warningText = document.getElementById("payDepositNameWarningText");
      if (warningText) warningText.textContent = `입금명이 설정되지 않은 탭이 ${_payMissingTabs.length}개 있습니다. 이체파일 생성 전에 입금명을 설정해주세요.`;
      if (warningEl) warningEl.style.display = "block";
    }

    _renderPayPreview(_payFiltered);
    if (emptyEl) emptyEl.style.display = "none";

  } catch(err) {
    console.error("[payment] 조회 오류:", err);
    showToast("❌ 조회 실패: " + err.message, "error");
    if (msgEl) msgEl.textContent = "조회 실패: " + err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = prevHtml; }
  }
}

/* 미리보기 테이블 렌더링 */
function _renderPayPreview(targets) {
  const previewWrap = document.getElementById("payPreviewWrap");
  const actionBar   = document.getElementById("payActionBar");
  const tbody       = document.getElementById("payPreviewBody");
  const countEl     = document.getElementById("payPreviewCount");
  if (!tbody) return;

  if (countEl) countEl.textContent = targets.length + "건";
  tbody.innerHTML = "";

  targets.forEach((r, i) => {
    const tr = document.createElement("tr");
    const bankCode = getBankCode(r.bank);
    const bankDisplay = r.bank + (bankCode ? ` (${bankCode})` : "");
    const amountFmt = r.amount ? Number(r.amount.replace(/[^0-9.]/g,'')).toLocaleString() + "원" : "—";
    const missingDepName = !r.depositName;
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="pay-row-check" data-idx="${i}" checked></td>
      <td class="col-bank" title="${escHtml(r.bank)}">${escHtml(r.bank)}<br><span style="font-size:.62rem;color:#9CA3AF">${bankCode || '?'}</span></td>
      <td class="col-account" title="${escHtml(r.account)}">${escHtml(r.account)}</td>
      <td>${escHtml(r.holder)}</td>
      <td class="col-amount">${amountFmt}</td>
      <td>${missingDepName ? '<span style="color:#EF4444;font-size:.68rem">⚠ 미설정</span>' : escHtml(r.depositName)}</td>
      <td class="col-tab" title="${escHtml(r.tabName)}">${escHtml(r.tabName)}</td>
      <td title="${escHtml(r.campaignName)}">${escHtml(r.campaignName)}</td>
    `;
    tbody.appendChild(tr);
  });

  // 전체 선택 체크박스 상태 동기화
  const allCheck = document.getElementById("paySelectAll");
  if (allCheck) allCheck.checked = true;

  // 선택 카운트 업데이트
  _updatePaySelCount();

  // 체크박스 change 이벤트
  tbody.querySelectorAll(".pay-row-check").forEach(cb => {
    cb.addEventListener("change", _updatePaySelCount);
  });

  if (previewWrap) previewWrap.style.display = "block";
  if (actionBar)   actionBar.style.display   = "flex";
}

/* 전체 선택/해제 */
function togglePaySelectAll(masterCb) {
  document.querySelectorAll(".pay-row-check").forEach(cb => { cb.checked = masterCb.checked; });
  _updatePaySelCount();
}

/* 선택 카운트 업데이트 */
function _updatePaySelCount() {
  const checked = document.querySelectorAll(".pay-row-check:checked").length;
  const countEl = document.getElementById("paySelCount");
  if (countEl) countEl.textContent = checked + "건 선택";
  const dlBtn   = document.getElementById("payDlBtn");
  const doneBtn = document.getElementById("payDoneBtn");
  if (dlBtn)   dlBtn.disabled   = checked === 0;
  if (doneBtn) doneBtn.disabled = checked === 0;
}

/* 선택된 행 가져오기 */
function _getSelectedTargets() {
  const result = [];
  document.querySelectorAll(".pay-row-check:checked").forEach(cb => {
    const idx = parseInt(cb.dataset.idx);
    if (!isNaN(idx) && _payFiltered[idx]) result.push(_payFiltered[idx]);
  });
  return result;
}

/* ══════════════════════════════════════════════════════════
   엑셀 다운로드
══════════════════════════════════════════════════════════ */
function downloadPaymentExcel() {
  const selected = _getSelectedTargets();
  if (!selected.length) { showToast("선택된 항목이 없습니다.", "warning"); return; }

  // 입금명 없는 항목 체크
  const missingDepositName = selected.filter(r => !r.depositName);
  if (missingDepositName.length > 0) {
    showToast(`⚠️ 입금명이 없는 항목 ${missingDepositName.length}건이 포함되어 있습니다. 먼저 입금명을 설정해주세요.`, "warning");
    openDepositNameModal();
    return;
  }

  const wb = typeof XLSX !== "undefined" ? XLSX.utils.book_new() : null;
  if (!wb) { showToast("엑셀 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해주세요.", "error"); return; }

  // 탭별로 분리 (같은 탭 = 같은 이체 설정)
  if (_payBank === "하나은행") {
    _downloadHana(wb, selected);
  } else {
    _downloadKbank(wb, selected);
  }

  const today = _getTodayStr().replace(/\./g, "");
  const filename = `이체파일_${_payBank}_${today}.xlsx`;
  XLSX.writeFile(wb, filename);
  showToast(`✅ ${filename} 다운로드 완료 (${selected.length}건)`, "success");
}

/* 하나은행 이체 파일 */
function _downloadHana(wb, rows) {
  // 컬럼 순서: 입금은행코드 / 계좌번호 / 이체금액 / 예상예금주 / 보내는분통장표시(공란) / 받는분통장표시내용 / CMS/모집인코드(공란)
  const header = ["입금은행코드", "계좌번호", "이체금액", "예상예금주", "보내는분통장표시", "받는분통장표시내용", "CMS/모집인코드"];
  const data = rows.map(r => [
    getBankCode(r.bank) || "",
    "'" + (r.account || ""),   // 앞 0 보존: 문자열로 강제
    r.amount ? Number(r.amount.replace(/[^0-9]/g,'')) : "",
    r.holder  || "",
    "",                        // 보내는분통장표시: 공란
    r.depositName || "",       // 받는분통장표시내용
    ""                         // CMS/모집인코드: 공란
  ]);
  const wsData = [header, ...data];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  // 계좌번호 열(B) 서식 — 텍스트
  _setColFormat(ws, wsData.length, 1, "@");
  XLSX.utils.book_append_sheet(wb, ws, "하나은행");
}

/* 케이뱅크 이체 파일 */
function _downloadKbank(wb, rows) {
  // 컬럼 순서: 입금은행코드 / 계좌번호 / 이체금액 / 받는분통장표시내용 / 예상예금주
  const header = ["입금은행코드", "계좌번호", "이체금액", "받는분통장표시내용", "예상예금주"];
  const data = rows.map(r => [
    getBankCode(r.bank) || "",
    "'" + (r.account || ""),   // 앞 0 보존
    r.amount ? Number(r.amount.replace(/[^0-9]/g,'')) : "",
    r.depositName || "",       // 받는분통장표시내용
    r.holder  || ""
  ]);
  const wsData = [header, ...data];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  _setColFormat(ws, wsData.length, 1, "@");
  XLSX.utils.book_append_sheet(wb, ws, "케이뱅크");
}

/* 특정 열에 서식 적용 (계좌번호 텍스트) */
function _setColFormat(ws, rowCount, colIdx, fmt) {
  for (let r = 1; r < rowCount; r++) {
    const cellAddr = XLSX.utils.encode_cell({ r, c: colIdx });
    if (ws[cellAddr]) {
      ws[cellAddr].t = "s"; // 텍스트
      if (!ws[cellAddr].s) ws[cellAddr].s = {};
      ws[cellAddr].s.numFmt = fmt;
    }
  }
}

/* 오늘 날짜 "YY.MM.DD" */
function _getTodayStr() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}.${mm}.${dd}`;
}

/* ══════════════════════════════════════════════════════════
   이체 완료 처리
══════════════════════════════════════════════════════════ */
function openPaymentConfirm() {
  const selected = _getSelectedTargets();
  if (!selected.length) { showToast("선택된 항목이 없습니다.", "warning"); return; }

  // 탭 단위로 그룹화해서 요약 표시
  const tabSet = {};
  selected.forEach(r => {
    const k = r.campaignName + " / " + r.tabName;
    tabSet[k] = (tabSet[k] || 0) + 1;
  });
  const tabSummary = Object.entries(tabSet).map(([k,cnt]) => `${k} (${cnt}건)`).join(", ");
  const msgEl = document.getElementById("paymentConfirmMsg");
  if (msgEl) msgEl.innerHTML = `선택한 <strong>${selected.length}건</strong>을 이체 완료 처리하시겠습니까?<br>
    <small style="color:var(--t3)">${tabSummary}</small><br>
    각 시트의 입금 컬럼에 <strong>${_getTodayStr()}</strong>이 기록됩니다.`;

  const pwEl = document.getElementById("payConfirmPw");
  if (pwEl) pwEl.value = "";
  document.getElementById("paymentConfirmOverlay").classList.add("open");
}

function closePaymentConfirm() {
  document.getElementById("paymentConfirmOverlay").classList.remove("open");
}

async function confirmPaymentDone() {
  const pw = (document.getElementById("payConfirmPw")?.value || "").trim();
  if (!pw) { showToast("관리자 비밀번호를 입력해주세요.", "warning"); return; }

  const selected = _getSelectedTargets();
  if (!selected.length) { closePaymentConfirm(); return; }

  const dateStr = _getTodayStr();
  const rows = selected.map(r => ({
    sheetId:      r.sheetId,
    gid:          r.gid || "",
    tabName:      r.tabName,
    rowNum:       r.rowNum,
    depositColKey: r.depositColKey || ""
  }));

  closePaymentConfirm();

  const btn = document.getElementById("payDoneBtn");
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 처리 중...'; }

  try {
    const payload = { action: "markPaymentDone", rows, dateStr, adminPw: pw };
    let json;
    try { json = await gasPost(payload); } catch(e) { json = await gasGet(payload); }

    if (json.error) throw new Error(json.error);

    const { successCount = 0, errors = [] } = json;
    let msg = `✅ ${successCount}건 이체 완료 처리되었습니다.`;
    if (errors.length) msg += ` (${errors.length}건 오류)`;
    showToast(msg);

    // 처리된 행을 목록에서 제거 (체크된 행 제거)
    const checkedIdxSet = new Set();
    document.querySelectorAll(".pay-row-check:checked").forEach(cb => checkedIdxSet.add(parseInt(cb.dataset.idx)));
    _payFiltered = _payFiltered.filter((_, i) => !checkedIdxSet.has(i));
    _payTargets  = _payTargets.filter(r => !selected.includes(r));
    _renderPayPreview(_payFiltered);

    if (errors.length) {
      console.warn("[payment] 이체완료 오류:", errors);
    }
  } catch(err) {
    console.error("[payment] 이체완료 오류:", err);
    showToast("❌ 처리 실패: " + err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-circle"></i> 이체 완료 처리'; }
  }
}

/* ══════════════════════════════════════════════════════════
   입금명 일괄 입력 팝업
══════════════════════════════════════════════════════════ */
function openDepositNameModal() {
  if (!_payMissingTabs || _payMissingTabs.length === 0) {
    showToast("입금명 미설정 탭이 없습니다.", "success");
    return;
  }
  const body = document.getElementById("depositNameModalBody");
  if (!body) return;
  body.innerHTML = "";
  _payMissingTabs.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "deposit-name-row";
    row.innerHTML = `
      <label title="${escHtml(t.tabName)}">${escHtml(t.tabName)}</label>
      <input class="deposit-name-input" id="depositInput_${i}" data-sheet-id="${escHtml(t.sheetId)}" data-tab-name="${escHtml(t.tabName)}" type="text" placeholder="입금명 입력">
    `;
    body.appendChild(row);
  });
  document.getElementById("depositNameModalOverlay").classList.add("open");
}

function closeDepositNameModal() {
  document.getElementById("depositNameModalOverlay").classList.remove("open");
}

async function saveDepositNames() {
  if (!APP_CONFIG.GAS_WEB_APP_URL) { showToast("GAS 웹앱 URL을 먼저 설정해주세요.", "warning"); return; }

  const inputs = document.querySelectorAll(".deposit-name-input");
  let hasError = false;
  inputs.forEach(inp => {
    if (!inp.value.trim()) {
      inp.classList.add("warn");
      hasError = true;
    } else {
      inp.classList.remove("warn");
    }
  });
  if (hasError) { showToast("⚠️ 모든 입금명을 입력해주세요.", "warning"); return; }

  // 각 탭에 대해 setTabConfig 호출
  const savePromises = Array.from(inputs).map(async inp => {
    const sheetId     = inp.dataset.sheetId   || "";
    const tabName     = inp.dataset.tabName   || "";
    const depositName = inp.value.trim();
    if (!sheetId || !tabName || !depositName) return null;

    const payload = {
      action:      "setTabConfig",
      sheetId:     sheetId,
      sheetUrl:    "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit",
      tabName:     tabName,
      depositName: depositName
      // 나머지 필드는 GAS에서 기존값 보존
    };
    try {
      let json;
      try { json = await gasPost(payload); } catch(e) { json = await gasGet(payload); }
      return { tabName, ok: !!json.ok };
    } catch(e) {
      return { tabName, ok: false };
    }
  });

  const results = await Promise.all(savePromises.filter(Boolean));
  const failed  = results.filter(r => !r.ok);

  closeDepositNameModal();

  if (failed.length === 0) {
    showToast("✅ 입금명이 저장되었습니다. 다시 조회합니다.");
    // _payTargets의 해당 탭 depositName 업데이트 후 재렌더링
    Array.from(inputs).forEach(inp => {
      const sheetId     = inp.dataset.sheetId;
      const tabName     = inp.dataset.tabName;
      const depositName = inp.value.trim();
      _payTargets.forEach(r => {
        if (r.sheetId === sheetId && r.tabName === tabName) r.depositName = depositName;
      });
      _payFiltered.forEach(r => {
        if (r.sheetId === sheetId && r.tabName === tabName) r.depositName = depositName;
      });
    });
    _payMissingTabs = [];
    const warningEl = document.getElementById("payDepositNameWarning");
    if (warningEl) warningEl.style.display = "none";
    _renderPayPreview(_payFiltered);
  } else {
    showToast(`⚠️ ${failed.length}건 저장 실패: ` + failed.map(f => f.tabName).join(", "), "warning");
    // 성공한 것들은 업데이트
    Array.from(inputs).forEach(inp => {
      const sheetId     = inp.dataset.sheetId;
      const tabName     = inp.dataset.tabName;
      const depositName = inp.value.trim();
      const res = results.find(r => r.tabName === tabName);
      if (res && res.ok) {
        _payTargets.forEach(r => { if (r.sheetId === sheetId && r.tabName === tabName) r.depositName = depositName; });
        _payFiltered.forEach(r => { if (r.sheetId === sheetId && r.tabName === tabName) r.depositName = depositName; });
        _payMissingTabs = _payMissingTabs.filter(t => !(t.sheetId === sheetId && t.tabName === tabName));
      }
    });
    if (_payMissingTabs.length === 0) {
      const warningEl = document.getElementById("payDepositNameWarning");
      if (warningEl) warningEl.style.display = "none";
    }
    _renderPayPreview(_payFiltered);
  }
}

// ═══════════════════════════════════════════════════════════
// Phase 5: 시스템 모니터링 (Sync Queue + Build History)
// ═══════════════════════════════════════════════════════════

async function loadSystemMonitor() {
  loadSyncQueueStats();
  loadBuildHistory();
  loadApiMetrics();
}

async function loadSyncQueueStats() {
  const el = document.getElementById("syncQueueStats");
  const actionsEl = document.getElementById("syncQueueActions");
  if (!el) return;

  try {
    const data = await gasGet({ action: "syncQueueStats" });
    if (!data || data.error) {
      el.innerHTML = `<span style="color:var(--t3)">큐 데이터 없음</span>`;
      return;
    }

    const s = data.stats || {};
    const hasFailed = (s.failed || 0) > 0;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
        <div style="background:#F0FDF4;border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:#16A34A">${s.done || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">완료</div>
        </div>
        <div style="background:#FEF3C7;border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:#D97706">${s.pending || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">대기중</div>
        </div>
        <div style="background:#EDE9FE;border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:#7C3AED">${s.processing || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">처리중</div>
        </div>
        <div style="background:${hasFailed ? '#FEE2E2' : '#F3F4F6'};border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:${hasFailed ? '#DC2626' : '#9CA3AF'}">${s.failed || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">실패</div>
        </div>
      </div>
      ${data.recentFailed && data.recentFailed.length > 0 ? `
        <div style="margin-top:10px;font-size:.75rem">
          <div style="font-weight:600;color:#DC2626;margin-bottom:4px">최근 실패 항목:</div>
          ${data.recentFailed.map(f => `
            <div style="background:#FEF2F2;padding:4px 8px;border-radius:4px;margin-bottom:3px;display:flex;justify-content:space-between;align-items:center">
              <span><b>#${f.id}</b> ${f.type} — ${(f.error_msg || '').substring(0, 50)}</span>
              <button onclick="retrySyncItem(${f.id})" style="font-size:.68rem;background:#3B82F6;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer">재시도</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;

    if (actionsEl) {
      actionsEl.classList.toggle("hidden", !hasFailed && (s.pending || 0) === 0);
    }
  } catch (err) {
    el.innerHTML = `<span style="color:#EF4444">로드 실패: ${err.message}</span>`;
  }
}

async function loadBuildHistory() {
  const el = document.getElementById("buildHistoryPanel");
  if (!el) return;

  try {
    const data = await gasGet({ action: "buildHistory", limit: 10 });
    if (!data || !data.history || data.history.length === 0) {
      el.innerHTML = `<span style="color:var(--t3)">빌드 히스토리 없음</span>`;
      return;
    }

    const rows = data.history;
    el.innerHTML = `
      <div style="max-height:250px;overflow-y:auto">
        <table style="width:100%;font-size:.75rem;border-collapse:collapse">
          <thead>
            <tr style="background:#F8FAFC;position:sticky;top:0">
              <th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border)">시각</th>
              <th style="padding:4px 6px;text-align:right;border-bottom:1px solid var(--border)">소요</th>
              <th style="padding:4px 6px;text-align:right;border-bottom:1px solid var(--border)">갱신</th>
              <th style="padding:4px 6px;text-align:right;border-bottom:1px solid var(--border)">스킵</th>
              <th style="padding:4px 6px;text-align:right;border-bottom:1px solid var(--border)">에러</th>
              <th style="padding:4px 6px;text-align:center;border-bottom:1px solid var(--border)">트리거</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const dt = new Date(r.started_at);
              const timeStr = dt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
              const elapsedSec = r.elapsed_ms ? (r.elapsed_ms / 1000).toFixed(1) + 's' : '-';
              const errColor = r.errors > 0 ? '#DC2626' : '#6B7280';
              const triggerBadge = r.trigger_by === 'manual_full' ? '🔄전체'
                : r.trigger_by === 'manual' ? '👆수동'
                : r.trigger_by === 'cron' ? '⏰자동'
                : r.trigger_by || '-';
              return `<tr style="border-bottom:1px solid #F1F5F9">
                <td style="padding:3px 6px">${timeStr}</td>
                <td style="padding:3px 6px;text-align:right;font-weight:600">${elapsedSec}</td>
                <td style="padding:3px 6px;text-align:right;color:#16A34A">${r.rebuilt || 0}</td>
                <td style="padding:3px 6px;text-align:right;color:#6B7280">${r.skipped || 0}</td>
                <td style="padding:3px 6px;text-align:right;color:${errColor}">${r.errors || 0}</td>
                <td style="padding:3px 6px;text-align:center;font-size:.7rem">${triggerBadge}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<span style="color:#EF4444">로드 실패: ${err.message}</span>`;
  }
}

async function retrySyncItem(id) {
  try {
    await gasPost({ action: "syncQueueRetry", id: String(id) });
    showToast("재시도 등록 완료", "success");
    setTimeout(() => loadSyncQueueStats(), 1000);
  } catch (err) {
    showToast("재시도 실패: " + err.message, "error");
  }
}

async function retrySyncAll() {
  if (!confirm("모든 실패 항목을 재시도합니까?")) return;
  try {
    await gasPost({ action: "syncQueueRetry", id: "all" });
    showToast("전체 재시도 등록 완료", "success");
    setTimeout(() => loadSyncQueueStats(), 1000);
  } catch (err) {
    showToast("재시도 실패: " + err.message, "error");
  }
}

async function purgeSyncQueue() {
  if (!confirm("완료된 큐 항목을 정리합니까? (24시간 이상 경과)")) return;
  try {
    await gasPost({ action: "syncQueuePurge", hours: 24 });
    showToast("정리 완료", "success");
    setTimeout(() => loadSyncQueueStats(), 1000);
  } catch (err) {
    showToast("정리 실패: " + err.message, "error");
  }
}

// ═══════════════════════════════════════════════════════════
// Phase 6: API 메트릭 대시보드 (서버 /api/diag/metrics)
// ═══════════════════════════════════════════════════════════

async function loadApiMetrics() {
  const summaryEl = document.getElementById("apiMetricsSummary");
  const detailEl  = document.getElementById("apiMetricsDetail");
  if (!summaryEl) return;

  try {
    // 직접 fetch (인증 필요 엔드포인트)
    const token = sessionStorage.getItem('admin_token');
    const res = await fetch(API_BASE_URL + '/api/diag/metrics', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    const m = await res.json();

    if (!m || !m.ok) {
      summaryEl.innerHTML = `<span style="color:var(--t3)">메트릭 데이터 없음</span>`;
      if (detailEl) detailEl.innerHTML = '';
      return;
    }

    // ── 요약 패널 ──
    const uptimeH = Math.floor((m.uptime || 0) / 3600);
    const uptimeM = Math.floor(((m.uptime || 0) % 3600) / 60);
    const sentryBadge = m.sentry === 'active'
      ? '<span style="background:#10B981;color:#fff;font-size:.65rem;padding:1px 6px;border-radius:4px">Sentry ON</span>'
      : '<span style="background:#9CA3AF;color:#fff;font-size:.65rem;padding:1px 6px;border-radius:4px">Sentry OFF</span>';

    const errRate = m.errorRate || '0%';
    const errColor = parseFloat(errRate) > 5 ? '#DC2626' : parseFloat(errRate) > 1 ? '#D97706' : '#16A34A';

    summaryEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;margin-bottom:12px">
        <div style="background:#F0FDF4;border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:#16A34A">${m.totalRequests || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">총 요청</div>
        </div>
        <div style="background:#FEF3C7;border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:#D97706">${m.rpm || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">RPM (분당)</div>
        </div>
        <div style="background:${parseFloat(errRate) > 1 ? '#FEE2E2' : '#F3F4F6'};border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:${errColor}">${errRate}</div>
          <div style="font-size:.7rem;color:#6B7280">에러율</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:.75rem;color:var(--t3)">
        <span>Uptime: ${uptimeH}h ${uptimeM}m</span>
        <span>5xx: ${m.totalErrors || 0} · 4xx: ${m.clientErrors || 0}</span>
        ${sentryBadge}
      </div>
      ${m.statusCodes ? `
        <div style="margin-top:8px;font-size:.7rem;color:var(--t3)">
          상태코드: ${Object.entries(m.statusCodes).sort((a,b) => b[1]-a[1]).map(([code, cnt]) => {
            const c = code >= 500 ? '#DC2626' : code >= 400 ? '#D97706' : '#16A34A';
            return `<span style="color:${c}">${code}</span>:<b>${cnt}</b>`;
          }).join(' · ')}
        </div>
      ` : ''}
    `;

    // ── 상세 패널: 느린 라우트 + 최근 에러 ──
    if (!detailEl) return;
    let detailHtml = '';

    // 느린 라우트
    if (m.slowRoutes && m.slowRoutes.length > 0) {
      detailHtml += `
        <div style="font-weight:600;font-size:.78rem;margin-bottom:6px;color:var(--t1)">🐌 느린 라우트 Top 5</div>
        <div style="max-height:130px;overflow-y:auto;margin-bottom:10px">
          ${m.slowRoutes.slice(0, 5).map(r => {
            const avgColor = r.avgMs > 2000 ? '#DC2626' : r.avgMs > 800 ? '#D97706' : '#16A34A';
            return `<div style="display:flex;justify-content:space-between;font-size:.72rem;padding:3px 0;border-bottom:1px solid #F1F5F9">
              <span style="color:var(--t2);max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.route}">${r.route}</span>
              <span>avg <b style="color:${avgColor}">${r.avgMs}ms</b> · max ${r.maxMs}ms · <span style="color:#6B7280">${r.count}회</span></span>
            </div>`;
          }).join('')}
        </div>
      `;
    }

    // 최근 에러
    if (m.recentErrors && m.recentErrors.length > 0) {
      detailHtml += `
        <div style="font-weight:600;font-size:.78rem;margin-bottom:6px;color:#DC2626">⚠️ 최근 에러 (${m.recentErrors.length}건)</div>
        <div style="max-height:130px;overflow-y:auto">
          ${m.recentErrors.slice(0, 5).map(e => {
            const t = new Date(e.ts).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit" });
            return `<div style="background:#FEF2F2;padding:4px 8px;border-radius:4px;margin-bottom:3px;font-size:.72rem">
              <div style="display:flex;justify-content:space-between">
                <b>${e.method} ${e.path}</b>
                <span style="color:#6B7280">${t}</span>
              </div>
              <div style="color:#DC2626;margin-top:2px">${(e.message || '').substring(0, 80)}</div>
            </div>`;
          }).join('')}
        </div>
      `;
    }

    if (!detailHtml) {
      detailHtml = '<span style="color:var(--t3)">느린 라우트 및 에러 없음 ✅</span>';
    }

    // 리셋 버튼
    detailHtml += `
      <div style="margin-top:10px;text-align:right">
        <button onclick="resetApiMetrics()" style="font-size:.7rem;background:#6B7280;color:#fff;border:none;padding:3px 10px;border-radius:4px;cursor:pointer">
          <i class="fas fa-redo"></i> 메트릭 초기화
        </button>
      </div>
    `;

    detailEl.innerHTML = detailHtml;
  } catch (err) {
    summaryEl.innerHTML = `<span style="color:#EF4444">메트릭 로드 실패: ${err.message}</span>`;
    if (detailEl) detailEl.innerHTML = '';
  }
}

async function resetApiMetrics() {
  if (!confirm("API 메트릭을 초기화합니까?")) return;
  try {
    const token = sessionStorage.getItem('admin_token');
    await fetch(API_BASE_URL + '/api/diag/metrics/reset', {
      method: 'POST',
      headers: token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : {},
    });
    showToast("메트릭 초기화 완료", "success");
    setTimeout(() => loadApiMetrics(), 500);
  } catch (err) {
    showToast("초기화 실패: " + err.message, "error");
  }
}
