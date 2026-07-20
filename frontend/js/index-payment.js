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
    const amountNum = Number(String(r.amount || "").replace(/[^0-9.]/g, ''));
    const amountFmt = amountNum ? amountNum.toLocaleString() + "원" : "—";
    const tabLabel = r.displayName || r.tabName || "";
    const acctMissing = !r.account;
    const acctCell = acctMissing
      ? '<span style="color:#EF4444;font-size:.68rem">⚠ 미등록</span>'
      : escHtml(r.account);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="pay-row-check" data-idx="${i}" checked></td>
      <td>${escHtml(r.paymentType || "")}</td>
      <td>${escHtml(r.transferBank || "")}</td>
      <td class="col-tab" title="${escHtml(tabLabel)}">${escHtml(tabLabel)}</td>
      <td title="${escHtml(r.productName || "")}">${escHtml(r.productName || "")}</td>
      <td>${escHtml(r.reviewerName || "")}</td>
      <td>${escHtml(r.bank || "")}</td>
      <td class="col-account${acctMissing ? ' pay-cell-missing' : ''}" title="${escHtml(r.account || "")}">${acctCell}</td>
      <td>${escHtml(r.holder || "")}</td>
      <td class="col-amount">${amountFmt}</td>
      <td>${escHtml(r.incomeName || "")}</td>
      <td>${escHtml(_fmtJumin(r.residentNum))}</td>
    `;
    tbody.appendChild(tr);
  });

  // 정리 요약 갱신 (총건수 / 이체은행별 건수·금액 / 총금액)
  _buildPaymentSummary(targets);

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

/* 주민등록번호 표기 (전체 표시, 13자리면 하이픈) */
function _fmtJumin(s) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  if (d.length === 13) return d.slice(0, 6) + "-" + d.slice(6);
  return s || "";
}

/* 정리 요약: 총건수 / 이체은행별 건수·금액 / 총금액 */
function _buildPaymentSummary(targets) {
  const el = document.getElementById("paySummary");
  if (!el) return;
  if (!targets || !targets.length) { el.style.display = "none"; el.innerHTML = ""; return; }

  const byBank = {};
  let totalAmt = 0;
  targets.forEach(r => {
    const bank = (r.transferBank || "").trim() || "미지정";
    const amt = Number(String(r.amount || "").replace(/[^0-9]/g, '')) || 0;
    if (!byBank[bank]) byBank[bank] = { count: 0, amount: 0 };
    byBank[bank].count++;
    byBank[bank].amount += amt;
    totalAmt += amt;
  });

  const chips = Object.entries(byBank).map(([b, v]) =>
    `<span class="pay-sum-chip"><b>${escHtml(b)}</b> ${v.count}건 · ${v.amount.toLocaleString()}원</span>`
  ).join("");

  el.innerHTML = `
    <div class="pay-sum-total">
      <i class="fas fa-calculator" style="margin-right:5px;color:#065F46"></i>
      총 <b>${targets.length}</b>건 · 총금액 <b>${totalAmt.toLocaleString()}</b>원
    </div>
    <div class="pay-sum-banks">${chips}</div>
  `;
  el.style.display = "block";
}

/* 전체내역(11컬럼) 엑셀 다운로드 — 화면에 표시된 정리 정보 그대로 */
function downloadPaymentOverviewExcel() {
  const selected = _getSelectedTargets();
  const rows = selected.length ? selected : _payFiltered;
  if (!rows.length) { showToast("내보낼 항목이 없습니다.", "warning"); return; }

  const wb = typeof XLSX !== "undefined" ? XLSX.utils.book_new() : null;
  if (!wb) { showToast("엑셀 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해주세요.", "error"); return; }

  const header = ["결제방식", "이체은행", "탭명", "상품명", "입금자명", "은행", "계좌번호", "예금주", "결제금액", "소득명의", "주민등록번호"];
  const data = rows.map(r => [
    r.paymentType || "",
    r.transferBank || "",
    r.displayName || r.tabName || "",
    r.productName || "",
    r.reviewerName || "",
    r.bank || "",
    "'" + (r.account || ""),                                   // 계좌번호 앞 0 보존
    r.holder || "",
    r.amount ? Number(String(r.amount).replace(/[^0-9]/g, '')) : "",
    r.incomeName || "",
    "'" + _fmtJumin(r.residentNum),                            // 주민번호 텍스트 보존
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  _setColFormat(ws, data.length + 1, 6, "@");   // 계좌번호 열
  _setColFormat(ws, data.length + 1, 10, "@");  // 주민등록번호 열
  XLSX.utils.book_append_sheet(wb, ws, "입금처리내역");

  const today = _getTodayStr().replace(/\./g, "");
  const filename = `입금처리내역_${today}.xlsx`;
  XLSX.writeFile(wb, filename);
  showToast(`✅ ${filename} 다운로드 완료 (${rows.length}건)`, "success");
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
    각 시트의 입금 컬럼에 <strong>이체완료 날짜·시각</strong>이 기록됩니다.`;

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
  const items = selected.map(r => ({
    sheetId:       r.sheetId,
    gid:           r.gid || "",
    tabName:       r.tabName,
    rowIndex:      r.rowIndex,
    reviewerName:  r.reviewerName || "",
    amount:        r.amount || "",
    depositColKey: r.depositColKey || ""
  }));

  closePaymentConfirm();

  const btn = document.getElementById("payDoneBtn");
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 처리 중...'; }

  try {
    const payload = { action: "markPaymentDone", items, dateStr, adminPw: pw };
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
  loadOrderMirrorStatus();
  loadReviewEditRequests();
  loadBuildHistory();
  loadApiMetrics();
  loadSmartBuildStatus();
}

// 수동입력 필요(stuck_manual) 탭 목록 — 현황 렌더 시 기록(전체 CSV 버튼용).
let _stuckManualTabs = [];

// 구매주문 시트반영 현황(막힌 주문 가시성 + 복구)
async function loadOrderMirrorStatus() {
  const el = document.getElementById("orderMirrorPanel");
  const actionsEl = document.getElementById("orderMirrorActions");
  if (!el) return;
  try {
    const data = await gasGet({ action: "orderMirrorStatus" });
    if (!data || data.error) { el.innerHTML = `<span style="color:var(--t3)">데이터 없음</span>`; return; }
    const cmap = {};
    (data.counts || []).forEach(c => { cmap[c.mirrorStatus] = c.count; });
    const written = cmap.written || 0;
    const queued = cmap.queued || 0;
    const pending = cmap.pending || 0;
    const pendingNoRow = cmap.pending_no_row || 0;
    const failed = cmap.failed || 0;
    const stuckManual = cmap.stuck_manual || 0;   // 자동복구 포기 → 사람이 수동입력해야 하는 유일한 터치포인트
    const stuckTotal = queued + pending + pendingNoRow + failed;
    const badge = (label, n, color, bg) => `<div style="background:${bg};border-radius:8px;padding:8px"><div style="font-size:1.2rem;font-weight:700;color:${color}">${n}</div><div style="font-size:.7rem;color:#6B7280">${label}</div></div>`;
    // ★ 능동 알림: stuck_manual(수동입력 필요)은 자동복구 대상에서 제외되므로 안 보면 '조용한 누락'이 됨 → 최상단 경고 배너.
    const manualBanner = stuckManual > 0 ? `
      <div style="background:#FEF2F2;border:1.5px solid #DC2626;border-radius:8px;padding:10px 12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="color:#B91C1C;font-weight:700">🚨 수동입력 필요 ${stuckManual}건 <span style="font-weight:400;color:#7F1D1D">— 자동복구가 자리를 못 잡은 주문. 아래 탭에서 CSV 받아 시트에 수동입력하세요.</span></span>
        <button onclick="downloadAllStuckManualCsv()" style="font-size:.7rem;background:#DC2626;color:#fff;border:none;padding:4px 10px;border-radius:5px;cursor:pointer;flex-shrink:0">전체 CSV</button>
      </div>` : '';
    _stuckManualTabs = (data.byTab || []).filter(t => (t.needManual || 0) > 0).map(t => ({ sheetId: t.sheetId, tabName: t.tabName }));
    el.innerHTML = `
      ${manualBanner}
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;text-align:center">
        ${badge('반영완료', written, '#16A34A', '#F0FDF4')}
        ${badge('대기중', pending + queued, '#D97706', '#FEF3C7')}
        ${badge('행없음', pendingNoRow, pendingNoRow ? '#DC2626' : '#9CA3AF', pendingNoRow ? '#FEE2E2' : '#F3F4F6')}
        ${badge('실패', failed, failed ? '#DC2626' : '#9CA3AF', failed ? '#FEE2E2' : '#F3F4F6')}
        ${badge('수동필요', stuckManual, stuckManual ? '#B91C1C' : '#9CA3AF', stuckManual ? '#FEE2E2' : '#F3F4F6')}
        ${badge('막힘합계', stuckTotal, stuckTotal ? '#B91C1C' : '#9CA3AF', stuckTotal ? '#FEF2F2' : '#F3F4F6')}
      </div>
      ${(data.byTab && data.byTab.length) ? `
        <div style="margin-top:10px;font-size:.74rem;max-height:200px;overflow-y:auto">
          <div style="font-weight:600;color:#374151;margin-bottom:4px">막힌 탭:</div>
          ${data.byTab.map(t => {
            const meta = t.hasRawMeta ? '' : ` <span style="color:#DC2626;font-weight:600">⚠ RAW미러 필요</span>`;
            const link = t.sheetId ? `<a href="https://docs.google.com/spreadsheets/d/${t.sheetId}" target="_blank" style="color:#2563EB">${(t.sheetId || '').substring(0,8)}…</a>` : '';
            const nm = (t.needManual || 0) > 0 ? ` <span style="color:#B91C1C;font-weight:700;background:#FEE2E2;border-radius:4px;padding:0 5px">🚨수동 ${t.needManual}</span>` : '';
            // needManual(stuck_manual)은 reconcile 대상 아님 → CSV로 수동입력. 그 외 막힘은 복구 버튼.
            const csvBtn = (t.needManual || 0) > 0
              ? `<button onclick="downloadStuckManualCsv('${t.sheetId}', '${encodeURIComponent(t.tabName || '')}')" style="font-size:.66rem;background:#DC2626;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer;flex-shrink:0">수동CSV</button>` : '';
            const fixBtn = (t.stuck - (t.needManual || 0)) > 0
              ? `<button onclick="runOrderReconcile('${t.sheetId}')" style="font-size:.66rem;background:#16A34A;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer;flex-shrink:0">복구</button>` : '';
            return `<div style="background:#F8FAFC;padding:5px 8px;border-radius:6px;margin-bottom:3px;display:flex;justify-content:space-between;gap:6px;align-items:center">
              <span><b>${t.stuck}</b>건 · ${t.tabName || ''} ${link}${nm}${meta}</span>
              <span style="display:flex;gap:4px;flex-shrink:0">${fixBtn}${csvBtn}</span>
            </div>`;
          }).join('')}
        </div>` : '<div style="margin-top:8px;color:#16A34A;font-size:.75rem">✅ 막힌 주문 없음</div>'}
    `;
    if (actionsEl) actionsEl.classList.toggle("hidden", stuckTotal === 0);
  } catch (err) {
    el.innerHTML = `<span style="color:#EF4444">로드 실패: ${err.message}</span>`;
  }
}

// ── 리뷰 이미지 수정요청 (리뷰어 → 관리자 승인 → [리뷰] 폴더 파일 교체) ──
function _escReviewEdit(s){ const d = document.createElement('div'); d.textContent = (s == null ? '' : String(s)); return d.innerHTML; }

// 현재 렌더된 수정요청(id→row) — 비교보기 모달에서 old/new 파일ID·메타 조회용
let _reviewEditReqs = {};
let _reEditCmpId = null;

async function loadReviewEditRequests() {
  const el = document.getElementById("reviewEditPanel");
  const badge = document.getElementById("reviewEditBadge");
  if (!el) return;
  try {
    const data = await gasGet({ action: "reviewEditList", status: "pending" });
    if (!data || data.ok === false) { el.innerHTML = `<span style="color:var(--t3)">데이터 없음</span>`; return; }
    const reqs = data.requests || [];
    const n = data.pendingCount != null ? data.pendingCount : reqs.length;
    if (badge) { badge.textContent = n; badge.classList.toggle("hidden", !n); }
    if (reqs.length === 0) {
      el.innerHTML = '<div style="color:#16A34A;font-size:.8rem"><i class="fas fa-check-circle"></i> 대기 중인 수정요청 없음</div>';
      return;
    }
    _reviewEditReqs = {};
    // 썸네일은 Google 썸네일 CDN을 1차(빠름), 서버 프록시를 폴백으로. 클릭 시 비교보기 모달.
    const IMG = (id) => `${API_BASE_URL}/api/drive/image/${encodeURIComponent(id)}`;
    const THUMB = (id) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w400`;
    const imgCell = (id, label, color, border, reqId) => id
      ? `<div style="text-align:center"><div style="font-size:.64rem;color:${color};font-weight:700">${label}</div><img src="${THUMB(id)}" loading="lazy" onerror="this.onerror=null;this.src='${IMG(id)}'" style="width:104px;height:104px;object-fit:cover;border-radius:8px;border:${border};cursor:zoom-in" onclick="openReviewEditCompare('${reqId}')" title="비교보기"></div>`
      : '';
    el.innerHTML = reqs.map(r => {
      _reviewEditReqs[r.id] = r;
      const reason = r.reason ? `<div style="font-size:.72rem;color:#5B6472;margin-top:6px;background:#F8FAFC;border-radius:6px;padding:5px 8px">사유: ${_escReviewEdit(r.reason)}</div>` : '';
      return `<div data-reqid="${r.id}" style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start;margin-bottom:8px">
          <div style="min-width:0">
            <div style="font-weight:700;font-size:.8rem;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escReviewEdit(r.campaign_label || r.tab_name || '')}</div>
            <div style="font-size:.7rem;color:var(--t3)">${_escReviewEdit(r.reviewer_name || '리뷰어')} · 행 ${r.row_index || '-'} · ${_escReviewEdit(r.slot_key || 'review')}</div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0">
            <button onclick="openReviewEditCompare('${r.id}')" style="font-size:.72rem;background:#EAF1FF;color:#2f6df0;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;font-weight:700">🔍 비교</button>
            <button onclick="approveReviewEdit('${r.id}')" style="font-size:.72rem;background:#16A34A;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-weight:700">승인</button>
            <button onclick="rejectReviewEdit('${r.id}')" style="font-size:.72rem;background:#EF4444;color:#fff;border:none;padding:5px 10px;border-radius:6px;cursor:pointer">반려</button>
          </div>
        </div>
        <div style="display:flex;gap:12px;align-items:center;justify-content:center">
          ${imgCell(r.old_file_id, '현재', '#98A0AC', '1px solid #E5E7EB', r.id)}
          <i class="fas fa-arrow-right" style="color:#3182f6"></i>
          ${imgCell(r.new_file_id, '교체', '#16A34A', '2px solid #3182f6', r.id)}
        </div>
        ${reason}
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<span style="color:#EF4444">로드 실패: ${err.message}</span>`;
  }
}

// 낙관적 즉시 반영: 카드 제거 + 배지 감소(응답을 기다리지 않고 목록에서 사라지게)
function _reviewEditRemoveCard(id) {
  const el = document.getElementById("reviewEditPanel");
  const badge = document.getElementById("reviewEditBadge");
  if (!el) return;
  const card = el.querySelector('[data-reqid="' + id + '"]');
  if (card) card.remove();
  if (badge) {
    const n = Math.max(0, (parseInt(badge.textContent, 10) || 1) - 1);
    badge.textContent = n;
    badge.classList.toggle("hidden", !n);
  }
  if (!el.querySelector('[data-reqid]')) {
    el.innerHTML = '<div style="color:#16A34A;font-size:.8rem"><i class="fas fa-check-circle"></i> 대기 중인 수정요청 없음</div>';
  }
}

async function approveReviewEdit(id) {
  if (!confirm('이 수정요청을 승인합니까?\n\n[리뷰] 폴더의 파일이 리뷰어가 올린 새 이미지로 교체되고,\n기존 파일은 [리뷰교체보관] 폴더로 이동됩니다(휴지통 아님·보관).')) return;
  _reviewEditRemoveCard(id);   // 즉시 목록에서 제거(새로고침 불필요)
  try {
    const r = await gasPost({ action: "reviewEditApprove", id: id });
    if (!r || r.ok === false) throw new Error((r && r.error) || '승인 실패');
    showToast('승인 완료 — 리뷰 파일이 교체되었습니다', 'success');
  } catch (e) {
    showToast('승인 실패: ' + (e.message || '') + ' — 목록을 새로고침합니다', 'error');
    loadReviewEditRequests();   // 실패 시 서버 상태로 복원
  }
}

async function rejectReviewEdit(id) {
  const note = prompt('반려 사유를 입력하세요 (리뷰어에게 표시됩니다):', '');
  if (note === null) return;
  _reviewEditRemoveCard(id);   // 즉시 목록에서 제거(새로고침 불필요)
  try {
    const r = await gasPost({ action: "reviewEditReject", id: id, note: note });
    if (!r || r.ok === false) throw new Error((r && r.error) || '반려 실패');
    showToast('반려 처리되었습니다', 'success');
  } catch (e) {
    showToast('반려 실패: ' + (e.message || '') + ' — 목록을 새로고침합니다', 'error');
    loadReviewEditRequests();   // 실패 시 서버 상태로 복원
  }
}

// ── 비교보기 모달(현재 ↔ 교체 좌우 나란히 확대) ──
function _reviewEditEnsureCompareModal() {
  if (document.getElementById('reCmpOvl')) return;
  const st = document.createElement('style');
  st.textContent =
    '.re-cmp-ovl{position:fixed;inset:0;background:rgba(20,26,38,.62);z-index:5000;display:none;align-items:center;justify-content:center;padding:20px}' +
    '.re-cmp-ovl.on{display:flex}' +
    '.re-cmp-panel{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35);width:100%;max-width:920px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}' +
    '.re-cmp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid #E9ECF2}' +
    '.re-cmp-h1{font-size:.92rem;font-weight:800;color:#191F28}.re-cmp-h2{font-size:.72rem;color:#98A0AC;margin-top:1px}' +
    '.re-cmp-x{width:30px;height:30px;border-radius:8px;border:1px solid #E9ECF2;background:#fff;color:#98A0AC;font-size:1.2rem;line-height:1;cursor:pointer;flex-shrink:0}' +
    '.re-cmp-body{display:flex;gap:10px;align-items:stretch;justify-content:center;padding:16px;overflow:auto;flex-wrap:wrap}' +
    '.re-cmp-col{flex:1 1 340px;min-width:280px;display:flex;flex-direction:column}' +
    '.re-cmp-cap{text-align:center;font-size:.72rem;font-weight:800;margin-bottom:7px}' +
    '.re-cmp-cap.now{color:#98A0AC}.re-cmp-cap.new{color:#16A34A}' +
    '.re-cmp-frame{flex:1;background:#F4F6FA;border:1px solid #E9ECF2;border-radius:10px;padding:10px;display:flex;align-items:flex-start;justify-content:center;min-height:200px}' +
    '.re-cmp-frame.new{border-color:#3182f6}' +
    '.re-cmp-frame img{max-width:100%;max-height:64vh;object-fit:contain;border-radius:6px;cursor:zoom-in;background:#fff}' +
    '.re-cmp-arrow{align-self:center;color:#3182f6;font-size:1.3rem;flex:0 0 auto}' +
    '.re-cmp-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;border-top:1px solid #E9ECF2;background:#FAFBFD;flex-wrap:wrap}' +
    '.re-cmp-hint{font-size:.72rem;color:#98A0AC}' +
    '.re-cmp-actions{display:flex;gap:8px}' +
    '.re-cmp-btn{border:none;border-radius:8px;font-weight:800;font-size:.8rem;padding:9px 18px;cursor:pointer;color:#fff}' +
    '.re-cmp-btn.ok{background:#16A34A}.re-cmp-btn.no{background:#EF4444}' +
    '@media(max-width:640px){.re-cmp-arrow{display:none}}';
  document.head.appendChild(st);

  const ovl = document.createElement('div');
  ovl.id = 'reCmpOvl';
  ovl.className = 're-cmp-ovl';
  ovl.innerHTML =
    '<div class="re-cmp-panel">' +
      '<div class="re-cmp-head"><div><div class="re-cmp-h1" id="reCmpTitle"></div><div class="re-cmp-h2" id="reCmpSub"></div></div>' +
      '<button class="re-cmp-x" onclick="closeReviewEditCompare()" title="닫기">&times;</button></div>' +
      '<div class="re-cmp-body">' +
        '<div class="re-cmp-col"><div class="re-cmp-cap now">현재</div><div class="re-cmp-frame"><a id="reCmpOldLink" target="_blank" rel="noopener"><img id="reCmpOld" alt="현재 이미지"></a></div></div>' +
        '<div class="re-cmp-arrow"><i class="fas fa-arrow-right"></i></div>' +
        '<div class="re-cmp-col"><div class="re-cmp-cap new">교체</div><div class="re-cmp-frame new"><a id="reCmpNewLink" target="_blank" rel="noopener"><img id="reCmpNew" alt="교체 이미지"></a></div></div>' +
      '</div>' +
      '<div class="re-cmp-foot"><span class="re-cmp-hint">이미지 클릭 시 원본 새창에서 열림</span>' +
      '<div class="re-cmp-actions"><button class="re-cmp-btn no" onclick="_reviewEditCompareReject()">반려</button><button class="re-cmp-btn ok" onclick="_reviewEditCompareApprove()">승인</button></div></div>' +
    '</div>';
  ovl.addEventListener('click', (e) => { if (e.target === ovl) closeReviewEditCompare(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReviewEditCompare(); });
  document.body.appendChild(ovl);
}

function openReviewEditCompare(id) {
  const r = _reviewEditReqs[id];
  if (!r) return;
  _reEditCmpId = id;
  _reviewEditEnsureCompareModal();
  const P = (fid) => fid ? `${API_BASE_URL}/api/drive/image/${encodeURIComponent(fid)}` : '';
  const T = (fid) => fid ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(fid)}&sz=w1600` : '';
  document.getElementById('reCmpTitle').textContent = r.campaign_label || r.tab_name || '';
  document.getElementById('reCmpSub').textContent =
    (r.reviewer_name || '리뷰어') + ' · 행 ' + (r.row_index || '-') + ' · ' + (r.slot_key || 'review');
  const oldImg = document.getElementById('reCmpOld');
  const newImg = document.getElementById('reCmpNew');
  oldImg.onerror = function () { this.onerror = null; this.src = P(r.old_file_id); };
  newImg.onerror = function () { this.onerror = null; this.src = P(r.new_file_id); };
  oldImg.src = T(r.old_file_id);
  newImg.src = T(r.new_file_id);
  document.getElementById('reCmpOldLink').href = P(r.old_file_id) || '#';
  document.getElementById('reCmpNewLink').href = P(r.new_file_id) || '#';
  document.getElementById('reCmpOvl').classList.add('on');
  document.body.style.overflow = 'hidden';
}

function closeReviewEditCompare() {
  const o = document.getElementById('reCmpOvl');
  if (o) o.classList.remove('on');
  document.body.style.overflow = '';
}

function _reviewEditCompareApprove() {
  const id = _reEditCmpId;
  if (id) approveReviewEdit(id);   // 자체 confirm → 확인 시 목록 카드 즉시 제거 + API
  closeReviewEditCompare();
}
function _reviewEditCompareReject() {
  const id = _reEditCmpId;
  if (id) rejectReviewEdit(id);    // 자체 사유 prompt → 목록 카드 즉시 제거 + API
  closeReviewEditCompare();
}

async function runOrderReconcile(sheetId) {
  if (!confirm("막힌 주문을 시트에 복구합니까?\n(시트 하단에 노란 배경으로 기록 → 수동입력분과 구분)")) return;
  try {
    const params = { action: "orderReconcile", limit: 200 };
    if (sheetId) params.sheetId = sheetId;
    const r = await gasPost(params);
    showToast(`복구 등록: 재시도 ${r.requeued || 0} · 메타대기 ${r.skippedNoMeta || 0} · 미해결 ${r.stillStuck || 0}`, "success");
    setTimeout(() => loadOrderMirrorStatus(), 1500);
  } catch (err) {
    showToast("복구 실패: " + err.message, "error");
  }
}

// 백로그 가속 드레인(선택적·온디맨드) — 대기 중 시트반영을 백그라운드로 빠르게 처리(쿼터 한도 내)
async function runQueueDrain() {
  if (!confirm("대기 중인 시트 반영을 백그라운드로 빠르게 처리합니다(쿼터 한도 내, 최대 ~1분).\n라이브 이벤트 중에는 사용을 자제하세요. 진행할까요?")) return;
  try {
    const r = await gasPost({ action: "queueDrain", maxMillis: 60000, batchSize: 20 });
    if (r && r.running) { showToast("이미 가속 드레인이 진행 중입니다.", "info"); return; }
    showToast("가속 드레인 시작(백그라운드) — 잠시 후 현황이 갱신됩니다.", "success");
    // 진행되는 동안 몇 차례 현황 자동 갱신
    [4000, 12000, 25000, 45000].forEach((ms) => setTimeout(() => {
      loadOrderMirrorStatus();
      if (typeof loadSyncQueueStats === "function") loadSyncQueueStats();
    }, ms));
  } catch (err) {
    showToast("가속 드레인 실패: " + err.message, "error");
  }
}

// 노란배경(복구·수동추가) 행이 있는 탭 목록 CSV 다운로드 — 수동 확인 후 삭제용.
//   format='csv'(탭 단위 요약) | 'detail.csv'(행 단위 상세). 인증 헤더 필요 → fetch+blob.
async function downloadYellowRowsCsv(fmt) {
  const format = fmt || "csv";
  try {
    const token = sessionStorage.getItem("admin_token");
    const base = (typeof API_BASE_URL !== "undefined" && API_BASE_URL) ? API_BASE_URL : "";
    const url = base + "/api/diag/yellow-rows-export?format=" + encodeURIComponent(format);
    const res = await fetch(url, { headers: token ? { "Authorization": "Bearer " + token } : {} });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (blob.size < 40) { showToast("노란 복구행 기록이 없습니다.", "info"); return; }
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    const day = new Date().toISOString().slice(0, 10);
    a.download = (format === "detail.csv" ? "노란행_상세_" : "노란행_탭목록_") + day + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
  } catch (err) {
    showToast("CSV 다운로드 실패: " + (err && err.message ? err.message : err), "error");
  }
}

// 수동입력 필요(stuck_manual) 주문을 탭 단위 CSV로 다운로드 — order-stuck-export(미반영분, 상태 라벨 포함).
//   자동복구가 포기한 주문을 사람이 시트에 붙여넣기 위한 목록. 인증 헤더 fetch→blob.
async function downloadStuckManualCsv(sheetId, tabNameEnc) {
  const sid = sheetId || '';
  const tab = tabNameEnc ? decodeURIComponent(tabNameEnc) : '';
  if (!sid || !tab) { showToast("탭 정보가 없어 CSV를 받을 수 없습니다.", "error"); return; }
  try {
    const token = sessionStorage.getItem("admin_token");
    const base = (typeof API_BASE_URL !== "undefined" && API_BASE_URL) ? API_BASE_URL : "";
    const url = base + "/api/diag/order-stuck-export?format=csv"
      + "&sheetId=" + encodeURIComponent(sid) + "&tabName=" + encodeURIComponent(tab);
    const res = await fetch(url, { headers: token ? { "Authorization": "Bearer " + token } : {} });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (blob.size < 40) { showToast("해당 탭에 미반영 주문이 없습니다.", "info"); return; }
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    const day = new Date().toISOString().slice(0, 10);
    a.download = "수동입력_" + tab.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) + "_" + day + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
  } catch (err) {
    showToast("CSV 다운로드 실패: " + (err && err.message ? err.message : err), "error");
  }
}

// 수동입력 필요 탭 '전체'를 탭별 CSV로 순차 다운로드(order-stuck-export가 탭 단위 필수라 반복 호출).
async function downloadAllStuckManualCsv() {
  const tabs = _stuckManualTabs || [];
  if (!tabs.length) { showToast("수동입력 필요 주문이 없습니다.", "info"); return; }
  if (tabs.length > 1 && !confirm(`수동입력 필요 탭 ${tabs.length}개의 CSV를 각각 받습니다. 진행할까요?`)) return;
  for (const t of tabs) {
    await downloadStuckManualCsv(t.sheetId, encodeURIComponent(t.tabName || ''));
    await new Promise(r => setTimeout(r, 400)); // 브라우저 다중 다운로드 안정화
  }
}

// ── 적체 노란행(복구) 일괄 삭제 ── 되돌릴 수 없음. 탭별로 서버가 현재 색 재확인 + DB 일치 시에만 삭제.
let _yellowDelBackup = [];
function _escH(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function runYellowRowsDelete(doDelete) {
  const inp = document.getElementById("yellowDelBefore");
  const beforeDateKst = (inp && inp.value) ? inp.value : "2026-06-30";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDateKst)) { showToast("기준일을 YYYY-MM-DD로 입력하세요.", "error"); return; }
  if (doDelete) {
    if (!confirm(`[되돌릴 수 없음] ${beforeDateKst} 0시(KST) 이전 제출된 '적체(복구) 노란행'을 모든 탭에서 실제로 삭제합니다.\n\n· 시트의 현재 노란색을 재확인하고, DB 기록과 일치하는 탭만 삭제합니다(불일치 탭은 자동 건너뜀).\n· 삭제된 행 내용은 백업 CSV로 받을 수 있습니다.\n\n진행할까요?`)) return;
    if (!confirm("정말 삭제를 실행합니다. 한 번 더 확인합니다. 계속할까요?")) return;
  }
  const token = sessionStorage.getItem("admin_token");
  const base = (typeof API_BASE_URL !== "undefined" && API_BASE_URL) ? API_BASE_URL : "";
  const hdr = token ? { "Authorization": "Bearer " + token } : {};
  const resultEl = document.getElementById("yellowDelResult");
  const setMsg = (h) => { if (resultEl) resultEl.innerHTML = h; };
  setMsg('<i class="fas fa-spinner fa-spin"></i> 대상 탭 목록 불러오는 중…');

  let items = [];
  try {
    const r = await fetch(base + "/api/diag/yellow-rows-export?format=json&source=reconcile", { headers: hdr });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    items = (j && j.items) || [];
  } catch (e) { setMsg('<span style="color:#DC2626">탭 목록 로드 실패: ' + _escH(e.message || e) + "</span>"); return; }
  if (!items.length) { setMsg("복구(적체) 노란행이 있는 탭이 없습니다."); return; }

  const callTab = async (it) => {
    // busy(reconcile/queue 진행중)면 잠시 후 최대 2회 재시도
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(base + "/api/diag/yellow-rows-delete", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, hdr),
        body: JSON.stringify({ sheetId: it.sheetId, gid: it.gid, tabName: it.tabName, beforeDateKst, source: "reconcile", confirm: doDelete }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { j._http = r.status; return j; }
      if (j.skipped === "busy" && attempt < 2) { await new Promise(rs => setTimeout(rs, 1800)); continue; }
      return j;
    }
  };

  _yellowDelBackup = [];
  let totalDeleted = 0, totalSkippedRows = 0, totalExtra = 0, doneTabs = 0;
  const busyTabs = [], errorTabs = [], claimFailTabs = [], skipRowTabs = [];
  for (const it of items) {
    doneTabs++;
    setMsg(`<i class="fas fa-spinner fa-spin"></i> ${doDelete ? "삭제" : "미리보기"} ${doneTabs}/${items.length} — ${_escH(it.tabName || "")} (누적 ${totalDeleted})`);
    try {
      const j = await callTab(it);
      if (!j || j.ok === false || j._http) { errorTabs.push({ tab: it.tabName, msg: (j && j.error) || ("HTTP " + (j && j._http)) }); continue; }
      if (j.skipped === "busy") { busyTabs.push({ tab: j.tab || it.tabName, url: it.sheetTabUrl }); continue; }
      totalDeleted += doDelete ? (j.deleted || 0) : (j.wouldDelete || 0);
      totalSkippedRows += (j.skippedCount || 0);
      totalExtra += (j.extraYellow || 0);
      if (j.skippedCount) skipRowTabs.push({ tab: j.tab || it.tabName, url: it.sheetTabUrl, n: j.skippedCount });
      if (j.claimCleanupFailed) claimFailTabs.push({ tab: j.tab || it.tabName, url: it.sheetTabUrl });
      if (doDelete && j.backup && j.backup.length) {
        for (const bk of j.backup) _yellowDelBackup.push({ tab: j.tab || it.tabName, url: it.sheetTabUrl, row: bk.row, values: bk.values });
      }
    } catch (e) { errorTabs.push({ tab: it.tabName, msg: e.message || String(e) }); }
  }

  let html = `<div style="font-weight:600;color:${doDelete ? "#DC2626" : "#374151"}">${doDelete ? "삭제 완료" : "미리보기"} — 총 ${doDelete ? "삭제" : "예정"} ${totalDeleted}행 · 탭 ${items.length}개${totalSkippedRows ? ` · 건너뛴 행 ${totalSkippedRows}` : ""}${totalExtra ? ` · 기타노란행 ${totalExtra}` : ""}</div>`;
  if (claimFailTabs.length) {
    html += `<div style="margin-top:6px;color:#B91C1C;font-weight:700">⛔ DB 정리 실패 ${claimFailTabs.length}탭 — 시트는 삭제됐으나 DB가 불일치합니다. 해당 탭은 재실행하지 마시고 알려주세요:<ul style="margin:4px 0 0 16px">` +
      claimFailTabs.map(m => `<li>${_escH(m.tab)} ${m.url ? `<a href="${m.url}" target="_blank" style="color:#2563EB">열기</a>` : ""}</li>`).join("") + "</ul></div>";
  }
  if (busyTabs.length) {
    html += `<div style="margin-top:6px;color:#B45309"><b>⏳ 진행중 충돌로 건너뜀 ${busyTabs.length}탭</b> — 잠시 후 다시 실행하세요: ` +
      busyTabs.map(m => _escH(m.tab)).join(", ") + "</div>";
  }
  if (skipRowTabs.length) {
    html += `<div style="margin-top:6px;color:#6B7280"><b>일부 행 건너뜀</b>(노란색 아님/내용불일치 — 행 밀림 가능, 수동 확인): ` +
      skipRowTabs.map(m => `${_escH(m.tab)}(${m.n})${m.url ? ` <a href="${m.url}" target="_blank" style="color:#2563EB">열기</a>` : ""}`).join(", ") + "</div>";
  }
  if (errorTabs.length) {
    html += `<div style="margin-top:6px;color:#DC2626"><b>오류 ${errorTabs.length}탭</b>: ` + errorTabs.map(e => _escH(e.tab) + "(" + _escH(e.msg) + ")").join(", ") + "</div>";
  }
  if (doDelete && _yellowDelBackup.length) {
    html += `<div style="margin-top:6px"><button onclick="downloadYellowDelBackup()" style="font-size:.72rem;background:#0ca678;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer"><i class="fas fa-download"></i> 삭제분 백업 CSV (${_yellowDelBackup.length}행)</button> <span style="color:#B45309">※ 삭제 직후 반드시 백업을 받아두세요</span></div>`;
  }
  setMsg(html);
  showToast(`${doDelete ? "삭제" : "미리보기"} 완료 — ${totalDeleted}행${busyTabs.length ? `, 충돌 ${busyTabs.length}탭` : ""}${claimFailTabs.length ? `, ⛔DB불일치 ${claimFailTabs.length}` : ""}`, claimFailTabs.length ? "error" : (doDelete ? "success" : "info"));
  if (doDelete) setTimeout(() => loadOrderMirrorStatus(), 1500);
}

function downloadYellowDelBackup() {
  if (!_yellowDelBackup.length) return;
  const esc2 = (v) => { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const maxCols = _yellowDelBackup.reduce((m, b) => Math.max(m, (b.values || []).length), 0);
  const head = ["탭명", "시트탭URL", "시트행"];
  for (let i = 0; i < maxCols; i++) head.push("C" + (i + 1));
  const lines = [head.map(esc2).join(",")];
  for (const b of _yellowDelBackup) {
    const row = [b.tab, b.url || "", b.row].concat((b.values || []).map(v => v));
    lines.push(row.map(esc2).join(","));
  }
  const csv = "﻿" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const dlUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = dlUrl; a.download = "삭제분_백업_" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
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
        <div style="background:#e8f1fe;border-radius:8px;padding:8px">
          <div style="font-size:1.2rem;font-weight:700;color:#3182f6">${s.processing || 0}</div>
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
          ${data.recentFailed.map(f => {
            const pl = _parseSyncPayload(f.payload);
            const sheetLink = pl.sheetId ? `<a href="https://docs.google.com/spreadsheets/d/${pl.sheetId}" target="_blank" style="color:#2563EB;text-decoration:underline" title="${pl.sheetId}">${pl.sheetId.substring(0,8)}…</a>` : '';
            const tabInfo = pl.tabName ? `<span style="color:#4B5563;font-weight:600">탭: ${pl.tabName}</span>` : '';
            const targetInfo = (sheetLink || tabInfo) ? `<div style="margin-top:2px;font-size:.68rem;color:#374151">${sheetLink}${sheetLink && tabInfo ? ' / ' : ''}${tabInfo}${pl.rowIndex ? ' / 행:' + pl.rowIndex : ''}</div>` : '';
            return `
            <div style="background:#FEF2F2;padding:6px 8px;border-radius:6px;margin-bottom:4px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span><b>#${f.id}</b> ${f.type} — ${(f.error_msg || '').substring(0, 50)}<br><span style="color:#991B1B;font-size:.68rem">${_translateSyncError(f.error_msg)}</span></span>
                <div style="display:flex;gap:4px;flex-shrink:0;margin-left:6px">
                  <button onclick="retrySyncItem(${f.id})" style="font-size:.68rem;background:#3B82F6;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer">재시도</button>
                  <button onclick="deleteSyncItem(${f.id})" style="font-size:.68rem;background:#DC2626;color:#fff;border:none;padding:2px 8px;border-radius:4px;cursor:pointer" title="이 항목을 큐에서 삭제">삭제</button>
                </div>
              </div>
              ${targetInfo}
            </div>`;
          }).join('')}
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

async function deleteSyncItem(id) {
  if (!confirm(`#${id} 항목을 큐에서 삭제합니까?\n(더 이상 재시도하지 않습니다)`)) return;
  try {
    await gasPost({ action: "syncQueueDelete", id: String(id) });
    showToast("항목 삭제 완료", "success");
    setTimeout(() => loadSyncQueueStats(), 500);
  } catch (err) {
    showToast("삭제 실패: " + err.message, "error");
  }
}

async function deleteAllSyncFailed() {
  if (!confirm("모든 실패 항목을 삭제합니까?\n(복구할 수 없습니다)")) return;
  try {
    await gasPost({ action: "syncQueueDelete", id: "all" });
    showToast("전체 삭제 완료", "success");
    setTimeout(() => loadSyncQueueStats(), 500);
  } catch (err) {
    showToast("삭제 실패: " + err.message, "error");
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
      ? '<span style="background:#12b886;color:#fff;font-size:.65rem;padding:1px 6px;border-radius:4px">Sentry ON</span>'
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

    // 라우트 한글 레이블 매핑
    function _routeKoreanLabel(route) {
      const map = {
        'GET /dirty': '더티체크',
        'POST /image-upload': '이미지 업로드',
        'POST /review-upload': '리뷰 업로드',
        'GET /get-inaed-list': '인애드명단 조회',
        'GET /dashboard': '대시보드',
        'POST /order': '구매양식 제출',
        'POST /find-slot': '슬롯 매칭',
        'GET /config': '탭 설정 조회',
        'POST /config': '탭 설정 저장',
        'POST /sync-tab-names': '탭명 동기화',
        'POST /check-duplicate': '중복 검사',
        'GET /campaign-list': '캠페인 목록',
        'GET /campaign-stats': '캠페인 통계',
        'POST /add-campaign': '캠페인 등록',
        'GET /preview-campaign': '캠페인 미리보기',
        'POST /smart-build': '스마트빌드',
        'GET /index-scan': '인덱스 스캔',
        'POST /review-submit': '리뷰 제출',
        'GET /slot-status': '슬롯 상태',
        'GET /search': '검색',
        'POST /register': '리뷰어 등록',
        'GET /stats': '통계',
        'GET /archive': '마감',
        'POST /share-sheet': '시트 공유',
        'GET /diag-tabs': '탭 진단',
        'POST /fix-campaign-tab-swap': '캠페인명 교정',
        'POST /fix-campaign-names': '캠페인명 수정',
        'GET /metrics': '메트릭 조회',
        'POST /payment': '입금 처리',
        'GET /memo': '메모 조회',
        'POST /memo': '메모 저장',
      };
      // 정확 매칭 시도
      if (map[route]) return map[route];
      // METHOD + 경로 마지막 부분 매칭
      for (const [key, label] of Object.entries(map)) {
        const keyPath = key.split(' ')[1];
        if (route.includes(keyPath)) return label;
      }
      return '';
    }

    // 느린 라우트
    if (m.slowRoutes && m.slowRoutes.length > 0) {
      detailHtml += `
        <div style="font-weight:600;font-size:.78rem;margin-bottom:6px;color:var(--t1)">🐌 느린 라우트 Top 5</div>
        <div style="max-height:130px;overflow-y:auto;margin-bottom:10px">
          ${m.slowRoutes.slice(0, 5).map(r => {
            const avgColor = r.avgMs > 2000 ? '#DC2626' : r.avgMs > 800 ? '#D97706' : '#16A34A';
            const routeKo = _routeKoreanLabel(r.route);
            const routeDisplay = routeKo ? `${r.route} <span style="color:#6B7280;font-size:.65rem">${routeKo}</span>` : r.route;
            const avgSec = (r.avgMs / 1000).toFixed(1) + '초';
            const maxSec = (r.maxMs / 1000).toFixed(1) + '초';
            return `<div style="display:flex;justify-content:space-between;font-size:.72rem;padding:3px 0;border-bottom:1px solid #F1F5F9">
              <span style="color:var(--t2);max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.route}">${routeDisplay}</span>
              <span>avg <b style="color:${avgColor}">${avgSec}</b> · max ${maxSec} · <span style="color:#6B7280">${r.count}회</span></span>
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

// ═══════════════════════════════════════════════════════════
// Phase 8: SSE 실시간 알림 수신
// ═══════════════════════════════════════════════════════════

let _sseSource = null;
let _sseNotifs = [];
const _SSE_MAX_NOTIFS = 50;
let _sseUnread = 0;

const _SSE_ICONS = {
  review_submit: { icon: 'fa-check-circle', color: '#16A34A', label: '리뷰 제출' },
  order_submit:  { icon: 'fa-shopping-cart', color: '#2563EB', label: '구매양식' },
  order_update:  { icon: 'fa-pen-to-square', color: '#EA580C', label: '작업오더 수정' },
  image_extract: { icon: 'fa-magic', color: '#3182f6', label: 'AI 분석' },
  image_upload:  { icon: 'fa-cloud-upload-alt', color: '#06B6D4', label: '업로드' },
  index_build:   { icon: 'fa-database', color: '#F59E0B', label: '인덱스' },
  system:        { icon: 'fa-info-circle', color: '#6B7280', label: '시스템' },
  dirty_detected:{ icon: 'fa-bolt', color: '#D97706', label: '변경 감지' },
  work_order_new:{ icon: 'fa-clipboard-list', color: '#1b64da', label: '새 작업오더' },
  cs_new_inquiry:{ icon: 'fa-comments', color: '#7C3AED', label: 'C/S 문의' },
  cs_message:    { icon: 'fa-comment-dots', color: '#7C3AED', label: 'C/S 메시지' },
  review_edit_request: { icon: 'fa-images', color: '#3182f6', label: '리뷰 수정요청' },
  connected:     { icon: 'fa-plug', color: '#12b886', label: '연결됨' },
};

function connectSSE() {
  const token = sessionStorage.getItem('admin_token');
  if (!token) {
    _updateSSEStatus('disconnected', '로그인 필요');
    return;
  }
  if (_sseSource) {
    _sseSource.close();
    _sseSource = null;
  }

  _updateSSEStatus('connecting', '연결 중...');

  // SSE는 URL에 token을 쿼리 파라미터로 전달 (EventSource는 커스텀 헤더 불가)
  // 서버 측에서 쿼리 파라미터도 인증 처리 필요 → 별도 처리
  // 대안: fetch + ReadableStream 사용
  try {
    _sseSource = new EventSource(API_BASE_URL + '/api/diag/events?token=' + encodeURIComponent(token));

    _sseSource.onopen = function() {
      _updateSSEStatus('connected', '연결됨');
    };

    _sseSource.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        _addNotification(data);
      } catch (_) {}
    };

    // 이벤트별 핸들러
    ['review_submit', 'order_submit', 'order_update', 'work_order_new', 'image_extract', 'image_upload', 'index_build', 'system', 'dirty_detected', 'smart_build_done', 'dirty_auto_built', 'db_rebuild_progress', 'db_rebuild_done', 'cs_new_inquiry', 'cs_message', 'review_edit_request'].forEach(function(evtType) {
      _sseSource.addEventListener(evtType, function(event) {
        try {
          const data = JSON.parse(event.data);
          // ★ C/S 문의 이벤트: 새 문의만 알림센터에 표시, 갱신은 전용 핸들러가 처리
          if (evtType === 'cs_new_inquiry' || evtType === 'cs_message') {
            if (evtType === 'cs_new_inquiry') _addNotification(data);
            if (typeof csOnSSE === 'function') { try { csOnSSE(evtType, data); } catch(_){} }
            return;
          }
          _addNotification(data);
          // ★ 인트라넷에서 작업오더 인박스 원본이 수정됨 → 목록/간편보기 즉시 갱신
          if (evtType === 'order_update') {
            if (typeof loadWorkOrders === 'function') { try { loadWorkOrders(); } catch(_) {} }
            if (typeof loadDashWorkOrders === 'function') { try { loadDashWorkOrders(); } catch(_) {} }
          }
          // ★ 신규/재제출 작업오더 도착 → 우측하단 미확인 카드 + OS 알림 (index-app.js) + 목록 갱신
          if (evtType === 'work_order_new') {
            if (typeof _onWorkOrderNewSSE === 'function') { try { _onWorkOrderNewSSE(data); } catch(_) {} }
            if (typeof loadWorkOrders === 'function') { try { loadWorkOrders(); } catch(_) {} }
            if (typeof loadDashWorkOrders === 'function') { try { loadDashWorkOrders(); } catch(_) {} }
          }
          // ★ 리뷰 이미지 수정요청 발생/처리 → 관리자 위젯 즉시 갱신
          if (evtType === 'review_edit_request' && typeof loadReviewEditRequests === 'function') {
            try { loadReviewEditRequests(); } catch(_) {}
          }
          // ★ Phase 4: dirty_detected 수신 시 대시보드 dirty 배지 갱신
          if (evtType === 'dirty_detected' && typeof _renderDirtyBadges === 'function') {
            _renderDirtyBadges(data.dirtySheets || []);
          }
          // ★ 스마트빌드 완료 시 상태 패널 갱신 + 사이드바 버튼 복원
          if (evtType === 'smart_build_done') {
            if (typeof loadSmartBuildStatus === 'function') loadSmartBuildStatus();
            var _sbBtn = document.getElementById("btnSmartBuildIndex");
            if (_sbBtn && _sbBtn.disabled) _restoreSmartBuildBtn(_sbBtn, null);
            // 대시보드 캠페인 탭 관리 자동 새로고침
            if (typeof loadTabDashboard === 'function') setTimeout(loadTabDashboard, 500);
          }
          // ★ DB 재구축 진행/완료
          if (evtType === 'db_rebuild_progress') {
            showToast("DB 재구축 Step " + (data.step || "?") + ": " + (data.message || ""), "info", 4000);
          }
          if (evtType === 'db_rebuild_done') {
            showToast(data.message || "DB 재구축 완료", "success", 8000);
            var _badge = document.getElementById("smartBuildStatusBadge");
            if (_badge) { _badge.textContent = "완료"; _badge.style.background = "#D1FAE5"; _badge.style.color = "#065F46"; }
            if (typeof loadSmartBuildStatus === 'function') loadSmartBuildStatus();
            if (typeof loadTabDashboard === 'function') setTimeout(loadTabDashboard, 1000);
          }
        } catch (_) {}
      });
    });

    _sseSource.onerror = function() {
      _updateSSEStatus('error', '연결 끊김');
      // 자동 재연결은 EventSource가 처리
    };
  } catch (err) {
    _updateSSEStatus('error', '연결 실패');
  }
}

function disconnectSSE() {
  if (_sseSource) {
    _sseSource.close();
    _sseSource = null;
  }
  _updateSSEStatus('disconnected', '수동 해제');
}

function toggleSSE() {
  if (_sseSource && _sseSource.readyState !== 2) {
    disconnectSSE();
  } else {
    connectSSE();
  }
}

function _updateSSEStatus(state, text) {
  var el = document.getElementById('sseStatus');
  var btn = document.getElementById('sseToggleBtn');
  if (!el) return;

  var colors = { connected: '#12b886', connecting: '#F59E0B', disconnected: '#9CA3AF', error: '#EF4444' };
  el.innerHTML = '<span style="color:' + (colors[state] || '#9CA3AF') + '">● ' + text + '</span>';

  if (btn) {
    btn.innerHTML = (state === 'connected')
      ? '<i class="fas fa-plug"></i> 해제'
      : '<i class="fas fa-plug"></i> 연결';
  }
}

function _addNotification(data) {
  var type = data.type || 'system';
  if (type === 'connected') return; // 연결 확인 메시지 무시

  var cfg = _SSE_ICONS[type] || _SSE_ICONS.system;
  var now = new Date();
  var timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  _sseNotifs.unshift({
    type: type,
    message: data.message || type,
    time: timeStr,
    ts: now.getTime(),
    icon: cfg.icon,
    color: cfg.color,
    label: cfg.label,
    data: data,
  });
  if (_sseNotifs.length > _SSE_MAX_NOTIFS) _sseNotifs.length = _SSE_MAX_NOTIFS;

  _sseUnread++;
  _renderNotifications();

  // ★ Phase 3: 대시보드 부분 갱신 이벤트 발행
  if (type === 'review_submit' || type === 'order_submit' || type === 'index_build') {
    try {
      window.dispatchEvent(new CustomEvent('sse-dashboard-update', { detail: data }));
    } catch (_) {}
  }

  // 토스트 알림 (화면에 보이지 않을 때)
  if (typeof showToast === 'function') {
    showToast(cfg.label + ': ' + (data.message || '').substring(0, 60), 'info');
  }
}

function _renderNotifications() {
  var feed = document.getElementById('sseNotifFeed');
  var badge = document.getElementById('sseBadge');
  if (!feed) return;

  if (_sseNotifs.length === 0) {
    feed.innerHTML = '<div style="text-align:center;color:var(--t3);font-size:.78rem;padding:16px"><i class="fas fa-bell-slash" style="margin-right:4px"></i>알림 없음</div>';
    if (badge) { badge.style.display = 'none'; }
    return;
  }

  if (badge && _sseUnread > 0) {
    badge.textContent = _sseUnread > 99 ? '99+' : _sseUnread;
    badge.style.display = 'inline';
  }

  feed.innerHTML = _sseNotifs.map(function(n) {
    return '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-bottom:1px solid #F1F5F9;font-size:.78rem">'
      + '<i class="fas ' + n.icon + '" style="color:' + n.color + ';margin-top:2px;flex-shrink:0"></i>'
      + '<div style="flex:1;min-width:0">'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
          + '<span style="font-weight:600;color:' + n.color + '">' + n.label + '</span>'
          + '<span style="color:#9CA3AF;font-size:.68rem;flex-shrink:0">' + n.time + '</span>'
        + '</div>'
        + '<div style="color:var(--t2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (n.message || '').substring(0, 80) + '</div>'
      + '</div>'
    + '</div>';
  }).join('');
}

function clearNotifications() {
  _sseNotifs = [];
  _sseUnread = 0;
  _renderNotifications();
}

// ═══════════════════════════════════════════════════════════
// Phase 9: 통계/리포트 대시보드 (Chart.js)
// ═══════════════════════════════════════════════════════════

var _chartInstances = {};

function _destroyChart(id) {
  if (_chartInstances[id]) {
    _chartInstances[id].destroy();
    delete _chartInstances[id];
  }
}

function _createChart(canvasId, config) {
  _destroyChart(canvasId);
  var ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  _chartInstances[canvasId] = new Chart(ctx, config);
  return _chartInstances[canvasId];
}

function _fmtNum(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('ko-KR');
}

function _fmtWon(n) {
  if (!n || n === 0) return '₩0';
  if (n >= 10000) return '₩' + (n / 10000).toFixed(1) + '만';
  return '₩' + _fmtNum(n);
}

async function loadStatsOverview() {
  var token = sessionStorage.getItem('admin_token');
  if (!token) return;
  var headers = { 'Authorization': 'Bearer ' + token };

  // 요약 카드 로딩
  var ids = ['statTotalReviews', 'statSubmitRate', 'statCampaigns', 'statPayments'];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:.9rem;color:#9CA3AF"></i>';
  });

  try {
    // 병렬로 API 3개 호출
    var results = await Promise.all([
      fetch(API_BASE_URL + '/api/diag/stats/overview', { headers: headers }).then(function(r) { return r.json(); }),
      fetch(API_BASE_URL + '/api/diag/stats/campaigns', { headers: headers }).then(function(r) { return r.json(); }),
      fetch(API_BASE_URL + '/api/diag/stats/reviewers?limit=10', { headers: headers }).then(function(r) { return r.json(); }),
      fetch(API_BASE_URL + '/api/diag/stats/payments', { headers: headers }).then(function(r) { return r.json(); }),
    ]);

    var overviewData = results[0];
    var campaignData = results[1];
    var reviewerData = results[2];
    var paymentData  = results[3];

    // ── 요약 카드 업데이트 ──
    if (overviewData.ok) {
      var ov = overviewData.overview;
      _setText('statTotalReviews', _fmtNum(ov.totalReviews));
      _setText('statSubmitRate', ov.submitRate + '%');
      _setText('statCampaigns', _fmtNum(ov.campaigns));
      _setText('statPayments', _fmtWon(ov.paymentTotal));
    }

    // ── 일별 활동량 차트 ──
    if (overviewData.ok && overviewData.dailyActivity) {
      var da = overviewData.dailyActivity;
      var labels = da.map(function(d) { return d.date.substring(5); }); // MM-DD
      _createChart('chartDailyActivity', {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: '리뷰 제출',
              data: da.map(function(d) { return d.reviews; }),
              borderColor: '#16A34A',
              backgroundColor: 'rgba(22,163,74,0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
              pointHoverRadius: 5,
            },
            {
              label: '구매양식',
              data: da.map(function(d) { return d.orders; }),
              borderColor: '#2563EB',
              backgroundColor: 'rgba(37,99,235,0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
              pointHoverRadius: 5,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } },
          scales: {
            y: { beginAtZero: true, ticks: { font: { size: 10 } } },
            x: { ticks: { font: { size: 10 } } }
          }
        }
      });
    }

    // ── 캠페인 제출률 차트 (TOP 10) ──
    if (campaignData.ok && campaignData.campaigns) {
      var top10 = campaignData.campaigns.slice(0, 10);
      var cLabels = top10.map(function(c) {
        var name = c.displayName || c.tabName || '';
        return name.length > 10 ? name.substring(0, 10) + '…' : name;
      });
      _createChart('chartCampaignRate', {
        type: 'bar',
        data: {
          labels: cLabels,
          datasets: [
            {
              label: '제출률 (%)',
              data: top10.map(function(c) { return parseFloat(c.submitRate); }),
              backgroundColor: top10.map(function(c) {
                var r = parseFloat(c.submitRate);
                if (r >= 80) return 'rgba(22,163,74,0.7)';
                if (r >= 50) return 'rgba(245,158,11,0.7)';
                return 'rgba(239,68,68,0.7)';
              }),
              borderRadius: 4,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, max: 100, ticks: { font: { size: 10 }, callback: function(v) { return v + '%'; } } },
            x: { ticks: { font: { size: 9 }, maxRotation: 45 } }
          }
        }
      });

      // 상세 테이블
      _renderCampaignTable(campaignData.campaigns, campaignData.totals);
    }

    // ── 리뷰어 활동량 차트 (TOP 10) ──
    if (reviewerData.ok && reviewerData.reviewers) {
      var revs = reviewerData.reviewers;
      _createChart('chartReviewerActivity', {
        type: 'bar',
        data: {
          labels: revs.map(function(r) { return r.name; }),
          datasets: [
            {
              label: '제출',
              data: revs.map(function(r) { return r.submittedCount; }),
              backgroundColor: 'rgba(22,163,74,0.7)',
              borderRadius: 3,
            },
            {
              label: '미제출',
              data: revs.map(function(r) { return r.pendingCount; }),
              backgroundColor: 'rgba(239,68,68,0.5)',
              borderRadius: 3,
            },
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } },
          scales: {
            x: { beginAtZero: true, stacked: true, ticks: { font: { size: 10 } } },
            y: { stacked: true, ticks: { font: { size: 10 } } }
          }
        }
      });
    }

    // ── 입금 추이 차트 ──
    if (paymentData.ok && paymentData.daily) {
      var pd = paymentData.daily;
      _createChart('chartPaymentTrend', {
        type: 'bar',
        data: {
          labels: pd.map(function(d) { return d.date.substring(5); }),
          datasets: [
            {
              label: '입금 건수',
              data: pd.map(function(d) { return parseInt(d.count); }),
              backgroundColor: 'rgba(234,88,12,0.6)',
              borderRadius: 3,
              yAxisID: 'y',
            },
            {
              label: '금액 (원)',
              data: pd.map(function(d) { return parseFloat(d.totalAmount); }),
              type: 'line',
              borderColor: '#3182f6',
              backgroundColor: 'rgba(49,130,246,0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 2,
              yAxisID: 'y1',
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } },
          scales: {
            y:  { beginAtZero: true, position: 'left', ticks: { font: { size: 10 } } },
            y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, callback: function(v) { return _fmtWon(v); } } },
            x:  { ticks: { font: { size: 9 }, maxRotation: 45 } }
          }
        }
      });
    }

  } catch (err) {
    console.error('[Stats] 통계 로드 실패:', err);
    ids.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '<span style="color:#EF4444;font-size:.75rem">오류</span>';
    });
  }
}

function _setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function _renderCampaignTable(campaigns, totals) {
  var el = document.getElementById('statsCampaignTable');
  if (!el) return;

  var html = '<table style="width:100%;border-collapse:collapse">';
  html += '<thead><tr style="background:#F8FAFC;border-bottom:2px solid var(--border)">';
  html += '<th style="padding:6px 8px;text-align:left;font-weight:600">캠페인/탭</th>';
  html += '<th style="padding:6px 8px;text-align:right;font-weight:600">전체</th>';
  html += '<th style="padding:6px 8px;text-align:right;font-weight:600">제출</th>';
  html += '<th style="padding:6px 8px;text-align:right;font-weight:600">미제출</th>';
  html += '<th style="padding:6px 8px;text-align:right;font-weight:600">제출률</th>';
  html += '<th style="padding:6px 8px;text-align:left;font-weight:600">담당자</th>';
  html += '<th style="padding:6px 8px;text-align:center;font-weight:600">상태</th>';
  html += '</tr></thead><tbody>';

  campaigns.forEach(function(c, i) {
    var rate = parseFloat(c.submitRate);
    var rateColor = rate >= 80 ? '#16A34A' : (rate >= 50 ? '#F59E0B' : '#EF4444');
    var statusBadge = c.isClosed ? '<span style="background:#EF4444;color:#fff;padding:1px 6px;border-radius:9px;font-size:.65rem">마감</span>'
                    : '<span style="background:#16A34A;color:#fff;padding:1px 6px;border-radius:9px;font-size:.65rem">진행</span>';
    var bg = i % 2 === 0 ? '' : 'background:#F8FAFC';

    html += '<tr style="border-bottom:1px solid #F1F5F9;' + bg + '">';
    html += '<td style="padding:5px 8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (c.displayName || c.tabName) + '">' + (c.displayName || c.tabName) + '</td>';
    html += '<td style="padding:5px 8px;text-align:right">' + _fmtNum(c.totalCount) + '</td>';
    html += '<td style="padding:5px 8px;text-align:right;color:#16A34A;font-weight:600">' + _fmtNum(c.submittedCount) + '</td>';
    html += '<td style="padding:5px 8px;text-align:right;color:#EF4444">' + _fmtNum(c.pendingCount) + '</td>';
    html += '<td style="padding:5px 8px;text-align:right;font-weight:700;color:' + rateColor + '">' + rate + '%</td>';
    html += '<td style="padding:5px 8px">' + (c.manager || '-') + '</td>';
    html += '<td style="padding:5px 8px;text-align:center">' + statusBadge + '</td>';
    html += '</tr>';
  });

  // 합계
  if (totals) {
    var tRate = parseFloat(totals.submitRate);
    var tColor = tRate >= 80 ? '#16A34A' : (tRate >= 50 ? '#F59E0B' : '#EF4444');
    html += '<tr style="border-top:2px solid var(--border);font-weight:700;background:#F0F9FF">';
    html += '<td style="padding:6px 8px">합계 (' + campaigns.length + '개 탭)</td>';
    html += '<td style="padding:6px 8px;text-align:right">' + _fmtNum(totals.total) + '</td>';
    html += '<td style="padding:6px 8px;text-align:right;color:#16A34A">' + _fmtNum(totals.submitted) + '</td>';
    html += '<td style="padding:6px 8px;text-align:right;color:#EF4444">' + _fmtNum(totals.pending) + '</td>';
    html += '<td style="padding:6px 8px;text-align:right;color:' + tColor + '">' + tRate + '%</td>';
    html += '<td style="padding:6px 8px">-</td>';
    html += '<td style="padding:6px 8px;text-align:center">-</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// Phase 10 마감 관련 함수 → index-app.js로 이전됨 (Phase 12)

// ═══════════════════════════════════════════════════════════
// ★ 스마트 빌드 상태 모니터링 UI
// ═══════════════════════════════════════════════════════════

async function loadSmartBuildStatus() {
  const el = document.getElementById("smartBuildStatusPanel");
  const badge = document.getElementById("smartBuildStatusBadge");
  const schedBtn = document.getElementById("btnSmartBuildScheduler");
  if (!el) return;

  try {
    const data = await gasGet({ action: "smartBuildStatus" });
    if (!data || data.error) {
      el.innerHTML = `<span style="color:var(--t3)">스마트 빌드 데이터 없음</span>`;
      return;
    }

    // 스케줄러 상태 배지
    if (badge) {
      if (data.running) {
        badge.textContent = "실행 중";
        badge.style.background = "#FEF3C7";
        badge.style.color = "#92400E";
      } else if (data.schedulerActive) {
        badge.textContent = "활성";
        badge.style.background = "#D1FAE5";
        badge.style.color = "#065F46";
      } else {
        badge.textContent = "비활성";
        badge.style.background = "#FEE2E2";
        badge.style.color = "#991B1B";
      }
    }

    // 스케줄러 버튼
    if (schedBtn) {
      if (data.schedulerActive) {
        schedBtn.innerHTML = '<i class="fas fa-clock"></i> 스케줄러: ON';
        schedBtn.style.background = "#0ca678";
      } else {
        schedBtn.innerHTML = '<i class="fas fa-clock"></i> 스케줄러: OFF';
        schedBtn.style.background = "#6B7280";
      }
    }

    // 통계 카드
    const lastRun = data.lastRun;
    const interval = data.intervalMs ? (data.intervalMs / 60000).toFixed(0) + "분" : "-";

    // 다음 실행까지 남은 시간 계산
    let nextRunText = "-";
    if (data.schedulerActive && lastRun && lastRun.timestamp) {
      const lastTs = new Date(lastRun.timestamp).getTime();
      const nextTs = lastTs + (data.intervalMs || 300000);
      const remaining = nextTs - Date.now();
      if (remaining > 0) {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        nextRunText = `${mins}분 ${secs}초 후`;
      } else {
        nextRunText = "곧 실행";
      }
    }

    let html = `
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;text-align:center;margin-bottom:12px">
        <div style="background:#EFF6FF;border-radius:8px;padding:8px">
          <div style="font-size:1.1rem;font-weight:700;color:#1D4ED8">${data.runCount || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">총 실행</div>
        </div>
        <div style="background:#F0FDF4;border-radius:8px;padding:8px">
          <div style="font-size:1.1rem;font-weight:700;color:#16A34A">${data.cachedSheets || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">캐시 시트</div>
        </div>
        <div style="background:#f5f9ff;border-radius:8px;padding:8px">
          <div style="font-size:1.1rem;font-weight:700;color:#3182f6">${data.cachedChecksums || 0}</div>
          <div style="font-size:.7rem;color:#6B7280">캐시 체크섬</div>
        </div>
        <div style="background:#FFF7ED;border-radius:8px;padding:8px">
          <div style="font-size:1.1rem;font-weight:700;color:#EA580C">${interval}</div>
          <div style="font-size:.7rem;color:#6B7280">주기</div>
        </div>
        <div style="background:#ECFDF5;border-radius:8px;padding:8px">
          <div style="font-size:1.1rem;font-weight:700;color:#0ca678">${nextRunText}</div>
          <div style="font-size:.7rem;color:#6B7280">다음 실행</div>
        </div>
        <div style="background:#F8FAFC;border-radius:8px;padding:8px">
          <div style="font-size:.9rem;font-weight:600;color:var(--t2)">${data.startedAt ? new Date(data.startedAt).toLocaleString("ko-KR", {timeZone:"Asia/Seoul", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit"}) : "-"}</div>
          <div style="font-size:.7rem;color:#6B7280">시작 시각</div>
        </div>
      </div>
    `;

    // 최근 실행 결과
    if (lastRun) {
      const elapsed = lastRun.elapsed ? (lastRun.elapsed / 1000).toFixed(1) + "s" : "-";
      const ts = lastRun.timestamp ? new Date(lastRun.timestamp).toLocaleString("ko-KR", {timeZone:"Asia/Seoul", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit"}) : "-";
      const errColor = (lastRun.errors || 0) > 0 ? "#DC2626" : "#9CA3AF";

      html += `
        <div style="background:#F8FAFC;border-radius:8px;padding:10px;border:1px solid var(--border)">
          <div style="font-weight:600;font-size:.78rem;color:var(--t1);margin-bottom:8px">
            <i class="fas fa-clock" style="color:#3182f6;margin-right:4px"></i>최근 실행 결과
            <span style="font-size:.7rem;color:var(--t3);margin-left:8px">${ts}</span>
            <span style="font-size:.7rem;color:var(--t3);margin-left:4px">(${elapsed})</span>
            ${lastRun.isFirstRun ? '<span style="font-size:.65rem;background:#DBEAFE;color:#1E40AF;padding:1px 6px;border-radius:4px;margin-left:6px">초기 실행</span>' : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;text-align:center;font-size:.78rem">
            <div>
              <div style="font-weight:700;color:#1D4ED8">${lastRun.sheetsChecked || 0}</div>
              <div style="font-size:.65rem;color:#6B7280">시트 확인</div>
            </div>
            <div>
              <div style="font-weight:700;color:#F59E0B">${lastRun.sheetsChanged || 0}</div>
              <div style="font-size:.65rem;color:#6B7280">변경 시트</div>
            </div>
            <div>
              <div style="font-weight:700;color:#3182f6">${lastRun.tabsScanned || 0}</div>
              <div style="font-size:.65rem;color:#6B7280">탭 스캔</div>
            </div>
            <div>
              <div style="font-weight:700;color:#16A34A">${lastRun.tabsUpdated || 0}</div>
              <div style="font-size:.65rem;color:#6B7280">탭 갱신</div>
            </div>
            <div>
              <div style="font-weight:700;color:${errColor}">${lastRun.errors || 0}</div>
              <div style="font-size:.65rem;color:#6B7280">오류</div>
            </div>
          </div>
          ${lastRun.errorDetails && lastRun.errorDetails.length > 0 ? `
            <div style="margin-top:8px;font-size:.72rem">
              <div style="font-weight:600;color:#DC2626;margin-bottom:4px"><i class="fas fa-exclamation-triangle"></i> 오류 상세:</div>
              ${(function() {
                // sheetId 중복 제거하여 삭제 버튼을 한번만 표시
                var seenSheets = {};
                return lastRun.errorDetails.slice(0, 5).map(function(e) {
                  var phaseLabel = {drive:'드라이브',sheet:'시트',tab:'탭',global:'전체'}[e.phase] || e.phase || '-';
                  var desc = e.desc || _translateErrorClient(e.error);
                  var canDelete = e.sheetId && (e.phase === 'drive' || e.phase === 'sheet') &&
                    (/file not found|does not have permission|not found/i.test(e.error));
                  var deleteBtn = '';
                  if (canDelete && !seenSheets[e.sheetId]) {
                    seenSheets[e.sheetId] = true;
                    deleteBtn = '<button onclick="deleteErrorSheet(\'' + e.sheetId + '\')" ' +
                      'style="margin-top:4px;padding:3px 10px;font-size:.68rem;background:#DC2626;color:#fff;border:none;border-radius:4px;cursor:pointer" ' +
                      'title="이 시트의 캠페인·탭·인덱스 데이터를 DB에서 모두 삭제합니다">' +
                      '<i class="fas fa-trash-alt"></i> 이 시트 DB에서 삭제' +
                      '</button>';
                  }
                  return '<div style="background:#FEF2F2;padding:4px 8px;border-radius:4px;margin-bottom:3px;line-height:1.5">' +
                    '<div><b style="color:#B91C1C">' + phaseLabel + '</b>: <span style="color:#6B7280">' + (e.error || '').substring(0, 100) + '</span></div>' +
                    '<div style="color:#DC2626;font-weight:600;margin-top:1px">→ ' + desc + '</div>' +
                    deleteBtn +
                    '</div>';
                }).join('');
              })()}
            </div>
          ` : ''}
        </div>
      `;
    } else {
      html += `<div style="text-align:center;color:var(--t3);padding:12px;font-size:.78rem"><i class="fas fa-info-circle"></i> 아직 실행된 적이 없습니다. 서버 시작 30초 후 첫 실행됩니다.</div>`;
    }

    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = `<span style="color:#EF4444"><i class="fas fa-exclamation-circle"></i> 로드 실패: ${err.message}</span>`;
  }
}

// ★ 오류 시트 DB 삭제 (시스템 모니터링 → 오류 상세 → 삭제 버튼)
async function deleteErrorSheet(sheetId) {
  if (!sheetId) return;
  const fullId = await _resolveFullSheetId(sheetId);
  if (!fullId) {
    showToast("시트 ID를 찾을 수 없습니다: " + sheetId, "error");
    return;
  }

  if (!confirm(
    "이 시트의 모든 데이터를 DB에서 삭제하시겠습니까?\n\n" +
    "시트 ID: " + fullId.substring(0, 30) + "...\n\n" +
    "삭제 대상:\n" +
    "  • campaigns (캠페인 등록)\n" +
    "  • tab_configs (탭 설정)\n" +
    "  • index_master (인덱스)\n" +
    "  • review_index (리뷰 인덱스)\n\n" +
    "⚠ 이 작업은 되돌릴 수 없습니다."
  )) return;

  try {
    const headers = { ..._getAuthHeaders() };
    const res = await fetch(API_BASE_URL + '/api/admin/campaign-delete/' + encodeURIComponent(fullId), {
      method: 'POST',
      headers,
    });
    const data = await res.json();

    if (data.ok) {
      showToast(
        "시트 삭제 완료: " + data.message +
        "\n(campaigns: " + data.deleted.campaigns +
        ", tabs: " + data.deleted.tab_configs +
        ", index: " + data.deleted.index_master +
        ", reviews: " + data.deleted.review_index + ")",
        "success", 6000
      );
      // 모니터링 패널 새로고침
      setTimeout(loadSmartBuildStatus, 1000);
    } else {
      showToast("삭제 실패: " + (data.error || "알 수 없는 오류"), "error");
    }
  } catch (err) {
    showToast("삭제 요청 오류: " + err.message, "error");
  }
}

// ★ sheetId 축약 → 전체 ID 복원 (campaigns 목록에서 매칭)
async function _resolveFullSheetId(shortId) {
  try {
    const data = await gasGet({ action: 'campaignList' });
    const campaigns = Array.isArray(data) ? data : (data.campaigns || data.data || []);
    for (const c of campaigns) {
      const sid = c.sheetId || c.sheet_id || '';
      if (sid.startsWith(shortId)) return sid;
    }
  } catch (_) {}
  return null;
}

// ★ 대시보드 패널에서의 스마트빌드 수동 실행 (confirm 포함)
async function triggerSmartBuild() {
  if (!confirm("스마트 빌드를 수동으로 실행하시겠습니까?\n(Drive API로 변경 감지 → 변경 시트만 Sheets API로 갱신)")) return;

  const badge = document.getElementById("smartBuildStatusBadge");
  if (badge) {
    badge.textContent = "실행 중...";
    badge.style.background = "#FEF3C7";
    badge.style.color = "#92400E";
  }

  try {
    const res = await gasPost({ action: "smartBuildRun" });
    if (res.ok) {
      showToast("스마트 빌드 시작됨 — 완료 시 알림됩니다", "info");
      setTimeout(loadSmartBuildStatus, 5000);
      setTimeout(loadSmartBuildStatus, 30000);
    } else {
      showToast(res.error || "스마트 빌드 실행 실패", "error");
      loadSmartBuildStatus();
    }
  } catch (err) {
    showToast("스마트 빌드 오류: " + err.message, "error");
    loadSmartBuildStatus();
  }
}

// ★ 사이드바 버튼에서의 스마트빌드 실행 (confirm 없이 바로 실행 + 사이드바 진행 표시)
async function triggerSmartBuildFromSidebar() {
  const btn = document.getElementById("btnSmartBuildIndex");
  const sidebarBadge = document.getElementById("smartBuildSidebarBadge");

  // 버튼 비활성화 + 진행 표시
  if (btn) {
    btn.disabled = true;
    btn._origHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 스마트빌드 실행 중...';
    btn.style.opacity = "0.8";
  }

  const startTime = Date.now();
  let _timer = setInterval(function() {
    var sec = Math.floor((Date.now() - startTime) / 1000);
    if (btn) btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> 스마트빌드 실행 중... ' + sec + '초';
  }, 1000);

  try {
    const res = await gasPost({ action: "smartBuildRun" });
    if (res.ok) {
      showToast("스마트 빌드 시작됨 — 완료 시 알림됩니다", "info");
      // 진행 상태를 SSE로 받으므로, 5초/30초 후 상태 갱신
      setTimeout(function() {
        if (typeof loadSmartBuildStatus === 'function') loadSmartBuildStatus();
      }, 5000);
      setTimeout(function() {
        _restoreSmartBuildBtn(btn, _timer);
        if (typeof loadSmartBuildStatus === 'function') loadSmartBuildStatus();
        if (typeof loadTabDashboard === 'function') loadTabDashboard();
      }, 30000);
    } else {
      showToast(res.error || "스마트 빌드 실행 실패", "error");
      _restoreSmartBuildBtn(btn, _timer);
    }
  } catch (err) {
    showToast("스마트 빌드 오류: " + err.message, "error");
    _restoreSmartBuildBtn(btn, _timer);
  }

  // SSE 이벤트(smart_build_done)로 복원할 수도 있지만, 타임아웃 기반 복원도 보장
  if (typeof loadSmartBuildStatus === 'function') {
    setTimeout(loadSmartBuildStatus, 3000);
  }
}

function _restoreSmartBuildBtn(btn, timer) {
  if (timer) clearInterval(timer);
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = btn._origHTML || '<i class="fas fa-bolt"></i> 스마트빌드 갱신';
    btn.style.opacity = "";
  }
}

async function toggleSmartBuildScheduler() {
  // 현재 상태 확인
  try {
    const status = await gasGet({ action: "smartBuildStatus" });
    const isActive = status && status.schedulerActive;
    const action = isActive ? "smartBuildStop" : "smartBuildStart";
    const label = isActive ? "정지" : "시작";

    if (!confirm(`스마트 빌드 스케줄러를 ${label}하시겠습니까?`)) return;

    const res = await gasPost({ action: action });
    if (res.ok) {
      showToast(`스마트 빌드 스케줄러 ${label}됨`, "success");
    } else {
      showToast(res.error || `스케줄러 ${label} 실패`, "error");
    }
    loadSmartBuildStatus();
  } catch (err) {
    showToast("스케줄러 토글 오류: " + err.message, "error");
    loadSmartBuildStatus();
  }
}

// ═══════════════════════════════════════════════════════════
// ★ DB 전체 재구축 (초기화 → 탭목록 재등록 → 스마트빌드)
// ═══════════════════════════════════════════════════════════

async function triggerDbRebuild() {
  // 2단계 확인
  if (!confirm(
    "⚠️ DB 전체 재구축을 실행하시겠습니까?\n\n" +
    "다음 테이블이 초기화(0행)됩니다:\n" +
    "  • campaigns\n" +
    "  • tab_configs\n" +
    "  • index_master\n" +
    "  • review_index\n" +
    "  • build_history\n\n" +
    "이후 탭목록 시트에서 재등록하고 스마트빌드를 실행합니다."
  )) return;

  var confirmCode = prompt(
    "최종 확인: 'REBUILD_DB'를 입력하세요.\n(취소하려면 아무것도 입력하지 마세요)"
  );
  if (confirmCode !== "REBUILD_DB") {
    showToast("DB 재구축이 취소되었습니다.", "info");
    return;
  }

  // UI 상태 변경
  var badge = document.getElementById("smartBuildStatusBadge");
  if (badge) {
    badge.textContent = "재구축 중...";
    badge.style.background = "#FEF3C7";
    badge.style.color = "#92400E";
  }

  try {
    showToast("DB 재구축을 시작합니다...", "info");

    var res = await gasPost({ action: "dbRebuild", confirm: "REBUILD_DB" });
    if (res.ok) {
      // 단계별 결과 표시
      var detail = "DB 재구축 진행 중:\n";
      if (res.steps) {
        res.steps.forEach(function(s) {
          if (s.action === "TRUNCATE") {
            var delInfo = Object.entries(s.deleted || {}).map(function(kv) {
              return kv[0] + "=" + kv[1] + "행 삭제";
            }).join(", ");
            detail += "① 초기화: " + delInfo + "\n";
          } else if (s.action === "INDEX_SCAN") {
            detail += "③a 시트DB 스캔: " + (s.sheets || 0) + "시트, " + (s.tabs || 0) + "탭\n";
          } else if (s.action === "SYNC_TAB_LIST") {
            detail += "③b DB 등록: " + (s.message || "완료") + "\n";
          }
        });
      }
      detail += "④ 스마트빌드 실행 중 (백그라운드)...\n완료 시 SSE 알림됩니다.";
      showToast(detail, "success", 10000);

      // 상태 갱신
      setTimeout(loadSmartBuildStatus, 2000);
    } else {
      showToast(res.error || "DB 재구축 실패", "error");
      if (badge) {
        badge.textContent = "오류";
        badge.style.background = "#FEE2E2";
        badge.style.color = "#991B1B";
      }
    }
  } catch (err) {
    showToast("DB 재구축 오류: " + err.message, "error");
    if (badge) {
      badge.textContent = "오류";
      badge.style.background = "#FEE2E2";
      badge.style.color = "#991B1B";
    }
  }
}

/** Sync Queue payload에서 시트/탭 정보 추출 */
function _parseSyncPayload(payload) {
  if (!payload) return {};
  try {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return {
      sheetId: p.sheetId || '',
      tabName: p.tabName || '',
      rowIndex: p.rowIndex || ''
    };
  } catch (e) { return {}; }
}

/** Sync Queue 에러 메시지를 한글로 해석 */
function _translateSyncError(msg) {
  if (!msg) return '';
  const m = msg.toLowerCase();
  if (m.includes('requested entity was not found')) return '→ 시트 또는 탭이 삭제/이름변경되어 찾을 수 없음';
  if (m.includes('not found')) return '→ 대상을 찾을 수 없음 (삭제 또는 이름 변경됨)';
  if (m.includes('permission')) return '→ 시트 접근 권한 없음 (공유 설정 확인 필요)';
  if (m.includes('quota') || m.includes('rate limit')) return '→ Google API 할당량 초과 (잠시 후 재시도)';
  if (m.includes('timeout') || m.includes('timed out')) return '→ 요청 시간 초과 (네트워크 또는 서버 지연)';
  if (m.includes('헤더를 가져올 수 없음') || m.includes('헤더')) return '→ 시트에서 헤더 행을 찾을 수 없음';
  if (m.includes('payload 누락')) return '→ 필수 데이터 누락 (sheetId/tabName)';
  if (m.includes('unable to parse range')) return '→ 시트 범위 오류 (탭 이름에 특수문자 포함 가능)';
  if (m.includes('socket hang up') || m.includes('econnreset')) return '→ 네트워크 연결 끊김 (재시도 권장)';
  if (m.includes('invalid_grant') || m.includes('token')) return '→ 인증 토큰 만료 (서버 재시작 필요)';
  if (m.includes('the caller does not have permission')) return '→ 서비스 계정에 시트 접근 권한 없음';
  if (m.includes('sheet') && m.includes('not found')) return '→ 해당 시트를 찾을 수 없음';
  if (m.includes('동시 제출 감지')) return '→ 같은 행에 동시 제출 발생 (자동 재시도됨)';
  return '→ 오류 발생 (재시도 또는 관리자 확인 필요)';
}
