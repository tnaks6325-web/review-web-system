/* ══════════════════════════════════════════════════════════════
   관리자 설정 패널 (공유 모듈) — 내 닉네임 · 회사 사업자번호(제공정보) · 리뷰어 소식·공지

   원래 admin.html 인라인 마크업 + index-app.js 안에만 있던 설정 화면을 **모듈로 뺐다**.
   통합 작업대(Track B)가 리뷰웹시스템을 대체하려면 이 설정들도 작업대에서 해야 하는데,
   사본을 만들면 문구·필드·저장 로직 중 하나만 고쳐도 두 화면이 갈라진다
   (cs-inquiry.js · recruit-modal.js · work-order-detail.js 와 같은 규율).

   ★ 함수명·마크업은 한 글자도 바꾸지 않았다 — 생성 HTML 안의 onclick 문자열
     (saveMyNickname·saveCompanyBusinessNo·uploadCashReceiptGuide·clearCashReceiptGuide·
      loadReviewerNoticesAdmin·saveReviewerNotice·editReviewerNotice·toggleReviewerNotice…)과
     index-app.js 의 탭 전환 훅, 회귀가드가 이름으로 묶여 있다.
   ★ 호스트 전역(escHtml·showToast·API_BASE_URL)이 없는 화면(통합 작업대)을 위해 폴백을 둔다.
   ★ 호스트 테마(css/index.css 의 --t1·--p·.admin-section-header)가 없는 화면에서는
     마운트 시 1회 감지해 `as-standalone` 클래스로 같은 값을 주입한다 —
     그래서 **admin.html 의 마크업·렌더 결과는 한 바이트도 바뀌지 않는다**
     (recruit-modal.js 가 var() 폴백 없이 통합 작업대에서 무너졌던 실측 사고의 재발 방지).
   ★ 서버 경로는 `window.ADMIN_SETTINGS_API` 재기준(campaign-cards 의 CAMPAIGN_ADMIN_API 와 같은 장치) —
     통합 작업대는 `/api/trackb/settings/*`(인트라넷 SSO 토큰이 도달 가능한 유일한 경로).

   사용: <div id="adminSettingsMount"></div>
         <script src="js/admin-settings.js"></script>
         AdminSettings.mount('adminSettingsMount', { panels:['nickname','business','notice'] })
   ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* escHtml — 호스트(index-app.js)의 것을 쓰되 **호출 시점에** 찾는다.
     ★ 로드 시점에 캡처하면 안 된다: 이 모듈은 index-app.js **앞에** 로드되므로
       그때는 window.escHtml 이 아직 없어 늘 폴백이 잡힌다. 폴백이 원본과 한 글자라도
       다르면 관리자 화면 출력이 조용히 달라진다(cs-inquiry.js 와 같은 규율).
     ★ 폴백은 index-app.js 의 escHtml 과 **동일 구현**(String(s) · & < > " 만). */
  function _escFallback(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escHtml(s) {
    var h = (typeof window !== "undefined") && window.escHtml;
    return (typeof h === "function" && h !== escHtml) ? h(s) : _escFallback(s);
  }
  function showToast(msg, isErr) {
    if (typeof window.showToast === "function") return window.showToast(msg, isErr);
    if (typeof window._toast === "function") return window._toast(String(msg || ""));
    if (typeof window.toast === "function") return window.toast(String(msg || ""));
    console.log("[admin-settings]", msg);
  }

  /* ── 서버 경로 ────────────────────────────────────────────────
     기본값 = 관리자 대시보드가 지금 쓰는 경로 그대로(동작 불변).
     window.ADMIN_SETTINGS_API 가 설정된 화면(통합 작업대)에서만 그 베이스 + 접미사로 간다. */
  var EP_DEFAULT = {
    nickname:     "/api/admin/my-nickname",          // GET · POST
    providerInfo: "/api/tab/provider-info",          // GET
    businessNo:   "/api/tab/company-business-no",    // POST
    cashGuide:    "/api/tab/cash-receipt-guide",     // POST
    guideImage:   "/api/order/guide-image",          // POST (업로드 인프라 재사용)
    noticesAll:   "/api/reviewer/notices/all",       // GET
    noticeSave:   "/api/reviewer/notices/save",      // POST
    noticeDelete: "/api/reviewer/notices/delete",    // POST
  };
  var EP_SUFFIX = {
    nickname:     "/my-nickname",
    providerInfo: "/provider-info",
    businessNo:   "/company-business-no",
    cashGuide:    "/cash-receipt-guide",
    guideImage:   "/guide-image",
    noticesAll:   "/notices",
    noticeSave:   "/notices/save",
    noticeDelete: "/notices/delete",
  };
  function _ep(key) {
    var base = window.ADMIN_SETTINGS_API;
    return base ? (base + EP_SUFFIX[key]) : EP_DEFAULT[key];
  }
  function _apiBase() {
    return (typeof API_BASE_URL !== "undefined" && API_BASE_URL) ? API_BASE_URL : "";
  }
  function _headers() {
    var token = sessionStorage.getItem("admin_token") || localStorage.getItem("admin_token");
    var h = { "Content-Type": "application/json" };
    if (token) h["Authorization"] = "Bearer " + token;
    return h;
  }
  async function _get(key) {
    var r = await fetch(_apiBase() + _ep(key), { headers: _headers() });
    var j = await r.json().catch(function () { return null; });
    if (!j) throw new Error("HTTP " + r.status);
    return j;
  }
  async function _post(key, body) {
    var r = await fetch(_apiBase() + _ep(key), {
      method: "POST", headers: _headers(), body: JSON.stringify(body || {}),
    });
    var j = await r.json().catch(function () { return null; });
    if (!j) throw new Error("HTTP " + r.status);
    return j;
  }

/* ══════════════════════════════════════════════════════════════
   ★ 내 닉네임 (1:1문의 표시 이름)
   리뷰어 대화창에 로그인 계정명(=실명)이 그대로 나가던 것을 막는다.
   미설정이면 리뷰어 화면엔 '관리자'로만 표시된다(서버가 강제 — 여기서 안 정해도 실명은 안 나감).
   ══════════════════════════════════════════════════════════════ */
function _nicknameHtml() {
  return `
        <!-- 내 닉네임 (1:1문의 표시 이름) -->
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">
            <i class="fas fa-user-tag" style="color:#7C3AED;margin-right:6px"></i>내 닉네임 (1:1문의 표시 이름)
          </span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:8px 0 12px;line-height:1.6">
          1:1문의 답장에서 <b>리뷰어에게 보이는 이름</b>입니다. 설정하지 않으면 <b>관리자</b>로만 표시되며,
          <b style="color:#B91C1C">로그인 계정명(실명)은 리뷰어에게 노출되지 않습니다.</b>
          바꾸면 이전에 보낸 답장의 이름도 함께 바뀝니다.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;max-width:520px">
          <span id="myNickLogin" style="font-size:.78rem;color:var(--t3);white-space:nowrap"></span>
          <input type="text" id="myNicknameInput" maxlength="20" placeholder="예: 만두"
            style="flex:1;min-width:140px;padding:8px 12px;border:1.5px solid #D1D5DB;border-radius:8px;font-size:.85rem;outline:none">
          <button onclick="saveMyNickname()"
            style="padding:8px 18px;background:var(--p);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer">
            <i class="fas fa-save"></i> 저장
          </button>
        </div>
        <div id="myNickHint" style="font-size:.74rem;color:var(--t3);margin-top:7px"></div>`;
}

async function loadMyNickname() {
  const input = document.getElementById('myNicknameInput');
  if (!input) return;
  const who = document.getElementById('myNickLogin');
  const hint = document.getElementById('myNickHint');
  try {
    const d = await _get('nickname');
    if (!d || d.ok === false) throw new Error((d && d.error) || '조회 실패');
    input.value = d.nickname || '';
    if (who) who.textContent = '내 계정: ' + (d.loginName || '-');
    if (hint) {
      hint.innerHTML = d.nickname
        ? `리뷰어에게는 <b style="color:#1B64DA">${escHtml(d.nickname)}</b> 이름으로 보입니다.`
        : `아직 닉네임이 없어 리뷰어에게는 <b>관리자</b>로만 보입니다.`;
    }
  } catch (e) {
    if (hint) hint.textContent = '닉네임을 불러오지 못했습니다: ' + e.message;
  }
}

async function saveMyNickname() {
  const input = document.getElementById('myNicknameInput');
  if (!input) return;
  const nickname = (input.value || '').trim();
  try {
    const d = await _post('nickname', { nickname });
    if (!d || d.ok === false) throw new Error((d && d.error) || '저장 실패');
    showToast(d.nickname ? `닉네임을 "${d.nickname}"(으)로 저장했습니다` : '닉네임을 해제했습니다 (리뷰어에게 "관리자"로 표시)');
    loadMyNickname();
    // 열려 있는 문의방이 있으면 바뀐 이름으로 다시 그린다(cs-inquiry.js 가 노출한 훅 —
    // 활성 threadId 는 그 모듈 스코프에 있어 여기서 직접 읽을 수 없다)
    try { if (typeof window.csReloadActiveConversation === 'function') window.csReloadActiveConversation(); } catch (_) {}
  } catch (e) {
    showToast('저장 실패: ' + e.message, true);
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ 회사 사업자번호 (제공정보) + 현금영수증 발행방법 이미지
   ══════════════════════════════════════════════════════════════ */

/* ── 현금영수증 발행방법 이미지 (채널별 회사 공통 1회) ──
   ★ 이 표는 서버 utils/cashReceiptChannels.js 의 사본이다 — key·label 이 어긋나면
     "등록은 되는데 리뷰어에겐 안 보이는" 조용한 사고가 난다.
     회귀가드(tests/cashReceiptGuide.test.js)가 두 목록의 일치를 고정한다.
   ★ cap = DOM id 접미사(crGuideImg<Cap>) — key 의 첫 글자만 대문자로.
   ★ 등록 슬롯 마크업도 **이 표에서 생성**한다 — 손으로 4칸을 적어 두면 채널을 늘릴 때
     한 칸을 빠뜨리고도 조용히 통과한다(실측: 올리브영·카카오메이커스가 그렇게 빠졌다). */
const CR_GUIDE_CHANNELS = [
  { key: 'coupang',    cap: 'Coupang',    label: '쿠팡',           emoji: '🛒' },
  { key: 'naver',      cap: 'Naver',      label: '네이버',         emoji: '🟢' },
  { key: 'oliveyoung', cap: 'Oliveyoung', label: '올리브영',       emoji: '🫒' },
  { key: 'kakao',      cap: 'Kakao',      label: '카카오메이커스', emoji: '💛' },
];
function _crGuideChannel(key) {
  return CR_GUIDE_CHANNELS.find(c => c.key === key) || { key, cap: '', label: key };
}
function _setCashReceiptGuideDisplay(channel, url) {
  const cap = _crGuideChannel(channel).cap;
  if (!cap) return;
  const img = document.getElementById('crGuideImg' + cap);
  const none = document.getElementById('crGuideNone' + cap);
  if (!img || !none) return;
  if (url) { img.src = url; img.style.display = ''; none.style.display = 'none'; }
  else { img.src = ''; img.style.display = 'none'; none.style.display = ''; }
}

function _businessHtml() {
  const slots = CR_GUIDE_CHANNELS.map(c => `
            <div style="flex:1;min-width:230px;max-width:330px;border:1px solid var(--border);border-radius:10px;padding:10px">
              <div style="font-size:.78rem;font-weight:700;margin-bottom:6px">${c.emoji} ${c.label}</div>
              <img id="crGuideImg${c.cap}" alt="" style="display:none;max-width:100%;max-height:160px;border-radius:8px;border:1px solid var(--border);object-fit:contain;margin-bottom:6px">
              <div id="crGuideNone${c.cap}" style="font-size:.72rem;color:var(--t4);margin-bottom:6px">등록된 이미지가 없습니다</div>
              <div style="display:flex;gap:6px;align-items:center">
                <input type="file" id="crGuideFile${c.cap}" accept="image/*" style="font-size:.7rem;flex:1;min-width:0" onchange="uploadCashReceiptGuide('${c.key}', this)">
                <button onclick="clearCashReceiptGuide('${c.key}')" style="padding:6px 10px;background:#FFF5F5;color:#B42318;border:1px solid #F7C9C9;border-radius:7px;font-size:.72rem;font-weight:700;cursor:pointer">제거</button>
              </div>
            </div>`).join('');
  return `
        <!-- 회사 공통 사업자번호 설정 -->
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">
            <i class="fas fa-building" style="color:#B45309;margin-right:6px"></i>회사 사업자번호 (제공정보)
          </span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:8px 0 12px">
          진행방식이 <b>사업자현영</b>인 탭의 구매양식 제출화면에 <b>지출증빙용 현금영수증 발행</b> 안내와 함께 표시됩니다. 회사 공통으로 1개만 설정합니다.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;max-width:480px">
          <input type="text" id="companyBusinessNoInput" placeholder="예: 311-87-02345"
            style="flex:1;min-width:180px;padding:8px 12px;border:1.5px solid #D1D5DB;border-radius:8px;font-size:.85rem;outline:none">
          <button onclick="saveCompanyBusinessNo()"
            style="padding:8px 18px;background:var(--p);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer">
            <i class="fas fa-save"></i> 저장
          </button>
        </div>

        <!-- 현금영수증 발행방법 이미지 (채널별 · 회사 공통 1회) -->
        <div style="margin-top:18px">
          <div style="font-size:.85rem;font-weight:700;color:var(--t1);margin-bottom:4px">
            🧾 현금영수증 발행방법 이미지 <span style="font-weight:400;color:var(--t3);font-size:.74rem">— 현영 탭 공고의 작업내용에서 리뷰어에게 채널에 맞는 이미지가 보입니다</span>
          </div>
          <!-- ★ 채널 목록은 서버 utils/cashReceiptChannels.js 가 단일 출처 —
               슬롯을 늘릴 땐 그쪽 표에 먼저 추가한다(회귀가드가 일치를 고정). -->
          <div style="display:flex;gap:14px;flex-wrap:wrap">${slots}
          </div>
        </div>`;
}

/** 회사 공통 사업자번호 + 현금영수증 발행방법 이미지 불러오기 (설정 탭) */
async function loadCompanyBusinessNo() {
  const input = document.getElementById('companyBusinessNoInput');
  if (!input) return;
  try {
    const data = await _get('providerInfo');
    if (data && data.ok) {
      input.value = data.companyBusinessNo || '';
      const g = data.cashReceiptGuides || {};
      for (const c of CR_GUIDE_CHANNELS) _setCashReceiptGuideDisplay(c.key, g[c.key] || '');
    }
  } catch (e) {
    console.warn('[companyBusinessNo] load 실패:', e.message);
  }
}

/** 채널별 발행방법 이미지 업로드 — guide-image Drive+프록시 인프라 재사용(썸네일 업로드와 동일 경로) */
async function uploadCashReceiptGuide(channel, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('이미지는 5MB 이하로 올려주세요.', true); input.value = ''; return; }
  showToast('발행방법 이미지 업로드 중...');
  try {
    const b64 = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(String(rd.result).split(',')[1]);
      rd.onerror = rej;
      rd.readAsDataURL(file);
    });
    const uj = await _post('guideImage', {
      imageBase64: b64, mimeType: file.type || 'image/jpeg', fileName: 'cashreceipt_' + channel + '_' + Date.now(),
    });
    if (!uj.ok || !uj.url) throw new Error(uj.error || '업로드 실패');
    const sj = await _post('cashGuide', { channel, imageUrl: uj.url });
    if (!sj.ok) throw new Error(sj.error || '저장 실패');
    _setCashReceiptGuideDisplay(channel, uj.url);
    showToast('✅ ' + _crGuideChannel(channel).label + ' 발행방법 이미지가 등록되었습니다.');
  } catch (e) {
    showToast('❌ 등록 실패: ' + e.message, true);
  } finally { input.value = ''; }
}

async function clearCashReceiptGuide(channel) {
  if (!confirm(_crGuideChannel(channel).label + ' 발행방법 이미지를 제거할까요?\n현영 공고의 리뷰어 안내에서 이미지가 사라집니다(문구 안내는 유지).')) return;
  try {
    const sj = await _post('cashGuide', { channel, imageUrl: '' });
    if (!sj.ok) throw new Error(sj.error || '저장 실패');
    _setCashReceiptGuideDisplay(channel, '');
    showToast('제거했습니다.');
  } catch (e) {
    showToast('❌ 제거 실패: ' + e.message, true);
  }
}

/** 회사 공통 사업자번호 저장 (설정 탭) */
async function saveCompanyBusinessNo() {
  const input = document.getElementById('companyBusinessNoInput');
  if (!input) return;
  const businessNo = (input.value || '').trim();
  try {
    const data = await _post('businessNo', { businessNo });
    if (data && data.ok) {
      showToast('✅ 회사 사업자번호가 저장되었습니다.');
    } else {
      showToast('❌ 저장 실패: ' + ((data && data.error) || '알 수 없는 오류'), true);
    }
  } catch (e) {
    showToast('❌ 저장 오류: ' + e.message, true);
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ 리뷰어 소식·공지 관리 (관리자) — 리뷰어 홈 상단 노출
   ══════════════════════════════════════════════════════════════ */
let _rvNotices = [];

function _noticeHtml() {
  return `
        <!-- 리뷰어 소식·공지 관리 (리뷰어 홈 상단 노출) -->
        <div style="min-width:0;border:1px solid #E5E7EB;border-radius:12px;background:#fff;padding:16px 18px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <span style="font-size:.88rem;font-weight:700;color:var(--t1)"><i class="fas fa-bullhorn" style="color:#7C3AED;margin-right:6px"></i>리뷰어 소식·공지 <span style="font-size:.65rem;font-weight:400;color:#6B7280">(리뷰어 홈 상단 노출)</span></span>
            <div style="display:flex;gap:6px">
              <button id="rvNoticeWriteBtn" onclick="toggleReviewerNoticeForm()" style="padding:4px 12px;background:#7C3AED;color:#fff;border:none;border-radius:7px;font-size:.72rem;font-weight:700;cursor:pointer"><i class="fas fa-pen"></i> 작성</button>
              <button onclick="loadReviewerNoticesAdmin()" style="padding:4px 10px;background:#F3F4F6;color:#374151;border:none;border-radius:7px;font-size:.72rem;font-weight:600;cursor:pointer"><i class="fas fa-sync-alt"></i> 새로고침</button>
            </div>
          </div>
          <div id="rvNoticeFormWrap" style="display:none;background:#FAFAFB;border:1px solid #EEF0F5;border-radius:10px;padding:12px;margin-bottom:12px">
            <input type="hidden" id="rvNoticeEditId" value="">
            <input id="rvNoticeTitle" type="text" placeholder="공지 제목" maxlength="100" style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:7px;font-size:.82rem;outline:none;box-sizing:border-box;margin-bottom:8px">
            <textarea id="rvNoticeBody" rows="3" placeholder="공지 내용 (리뷰어에게 보여집니다)" maxlength="2000" style="width:100%;padding:8px 10px;border:1px solid #D1D5DB;border-radius:7px;font-size:.82rem;font-family:inherit;outline:none;box-sizing:border-box;resize:vertical;margin-bottom:8px"></textarea>
            <div style="display:flex;align-items:center;gap:10px">
              <label style="display:flex;align-items:center;gap:5px;font-size:.76rem;color:var(--t2);cursor:pointer"><input type="checkbox" id="rvNoticePinned"> 상단 고정</label>
              <div style="margin-left:auto;display:flex;gap:6px">
                <button id="rvNoticeCancelBtn" onclick="cancelReviewerNoticeEdit()" style="display:none;padding:7px 14px;background:#fff;color:var(--t2);border:1px solid #D1D5DB;border-radius:7px;font-size:.78rem;font-weight:600;cursor:pointer">취소</button>
                <button id="rvNoticeSaveBtn" onclick="saveReviewerNotice()" style="padding:7px 16px;background:#7C3AED;color:#fff;border:none;border-radius:7px;font-size:.78rem;font-weight:700;cursor:pointer"><i class="fas fa-paper-plane"></i> 게시</button>
              </div>
            </div>
          </div>
          <div id="rvNoticeList" style="max-height:220px;overflow-y:auto"><div style="text-align:center;color:#9CA3AF;font-size:.8rem;padding:10px">불러오는 중...</div></div>
        </div>`;
}

async function loadReviewerNoticesAdmin() {
  const wrap = document.getElementById("rvNoticeList");
  if (!wrap) return;
  try {
    const data = await _get('noticesAll');
    if (!data || data.ok === false) throw new Error((data && data.error) || "불러오기 실패");
    _rvNotices = data.notices || [];
    _renderReviewerNoticesAdmin(_rvNotices);
  } catch (err) {
    wrap.innerHTML = `<div style="text-align:center;color:#EF4444;font-size:.8rem;padding:10px">오류: ${escHtml(err.message)}</div>`;
  }
}

function _renderReviewerNoticesAdmin(list) {
  const wrap = document.getElementById("rvNoticeList");
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<div style="text-align:center;color:#9CA3AF;font-size:.8rem;padding:10px">등록된 공지가 없습니다</div>';
    return;
  }
  wrap.innerHTML = list.map(n => {
    const d = n.createdAt ? new Date(n.createdAt).toLocaleDateString("ko-KR", { year:'2-digit', month:'2-digit', day:'2-digit' }) : "";
    const hidden = !n.active;
    return `<div style="border:1px solid ${hidden ? '#E5E7EB' : '#DDD6FE'};background:${hidden ? '#F9FAFB' : '#fff'};border-radius:9px;padding:10px 12px;margin-bottom:8px;opacity:${hidden ? '.6' : '1'}">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        ${n.pinned ? '<span style="font-size:.62rem;background:#FEF3C7;color:#92400E;font-weight:700;padding:1px 5px;border-radius:5px">📌 고정</span>' : ''}
        ${hidden ? '<span style="font-size:.62rem;background:#F3F4F6;color:#6B7280;font-weight:700;padding:1px 5px;border-radius:5px">숨김</span>' : '<span style="font-size:.62rem;background:#D1FAE5;color:#065F46;font-weight:700;padding:1px 5px;border-radius:5px">노출중</span>'}
        <span style="font-weight:700;color:var(--t1);font-size:.83rem;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(n.title || '(제목 없음)')}</span>
        <span style="font-size:.66rem;color:#9CA3AF;flex-shrink:0">${d}</span>
      </div>
      ${n.body ? `<div style="font-size:.76rem;color:var(--t2);line-height:1.5;white-space:pre-wrap;word-break:break-word;margin-bottom:6px">${escHtml(n.body)}</div>` : ''}
      <div style="display:flex;gap:5px;justify-content:flex-end">
        <button onclick="toggleReviewerNotice('${n.id}')" style="padding:3px 9px;background:#F3F4F6;color:#374151;border:none;border-radius:6px;font-size:.68rem;font-weight:600;cursor:pointer">${hidden ? '노출' : '숨김'}</button>
        <button onclick="editReviewerNotice('${n.id}')" style="padding:3px 9px;background:#EFF6FF;color:#2563EB;border:1px solid #BFDBFE;border-radius:6px;font-size:.68rem;font-weight:600;cursor:pointer">수정</button>
        <button onclick="deleteReviewerNotice('${n.id}')" style="padding:3px 9px;background:#FEF2F2;color:#DC2626;border:1px solid #FECACA;border-radius:6px;font-size:.68rem;font-weight:600;cursor:pointer">삭제</button>
      </div>
    </div>`;
  }).join("");
}

async function saveReviewerNotice() {
  const id = (document.getElementById("rvNoticeEditId") || {}).value || "";
  const title = (document.getElementById("rvNoticeTitle") || {}).value || "";
  const body = (document.getElementById("rvNoticeBody") || {}).value || "";
  const pinned = !!(document.getElementById("rvNoticePinned") || {}).checked;
  if (!title.trim() && !body.trim()) { showToast("제목 또는 내용을 입력하세요", true); return; }
  const btn = document.getElementById("rvNoticeSaveBtn");
  if (btn) { btn.disabled = true; }
  try {
    const payload = { title, body, pinned };
    if (id) payload.id = id;
    const data = await _post('noticeSave', payload);
    if (!data || data.ok === false) throw new Error((data && data.error) || "저장 실패");
    showToast(id ? "공지가 수정되었습니다" : "공지가 게시되었습니다");
    cancelReviewerNoticeEdit();
    loadReviewerNoticesAdmin();
  } catch (err) {
    showToast("저장 오류: " + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function toggleReviewerNoticeForm() {
  const wrap = document.getElementById("rvNoticeFormWrap");
  if (!wrap) return;
  const opening = wrap.style.display === "none";
  if (opening) {
    wrap.style.display = "";
    const t = document.getElementById("rvNoticeTitle");
    if (t) t.focus();
  } else {
    cancelReviewerNoticeEdit();
  }
}

function editReviewerNotice(id) {
  const n = _rvNotices.find(x => x.id === id);
  if (!n) return;
  const wrap = document.getElementById("rvNoticeFormWrap");
  if (wrap) wrap.style.display = "";
  document.getElementById("rvNoticeEditId").value = n.id;
  document.getElementById("rvNoticeTitle").value = n.title || "";
  document.getElementById("rvNoticeBody").value = n.body || "";
  document.getElementById("rvNoticePinned").checked = !!n.pinned;
  const c = document.getElementById("rvNoticeCancelBtn"); if (c) c.style.display = "";
  const s = document.getElementById("rvNoticeSaveBtn"); if (s) s.innerHTML = '<i class="fas fa-check"></i> 수정 저장';
  document.getElementById("rvNoticeTitle").scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelReviewerNoticeEdit() {
  const idEl = document.getElementById("rvNoticeEditId"); if (idEl) idEl.value = "";
  const t = document.getElementById("rvNoticeTitle"); if (t) t.value = "";
  const b = document.getElementById("rvNoticeBody"); if (b) b.value = "";
  const p = document.getElementById("rvNoticePinned"); if (p) p.checked = false;
  const c = document.getElementById("rvNoticeCancelBtn"); if (c) c.style.display = "none";
  const s = document.getElementById("rvNoticeSaveBtn"); if (s) s.innerHTML = '<i class="fas fa-paper-plane"></i> 게시';
  const wrap = document.getElementById("rvNoticeFormWrap"); if (wrap) wrap.style.display = "none";
}

async function toggleReviewerNotice(id) {
  const n = _rvNotices.find(x => x.id === id);
  if (!n) return;
  try {
    const data = await _post('noticeSave', { id: n.id, title: n.title, body: n.body, pinned: n.pinned, active: !n.active });
    if (!data || data.ok === false) throw new Error((data && data.error) || "변경 실패");
    showToast(!n.active ? "노출로 변경했습니다" : "숨김으로 변경했습니다");
    loadReviewerNoticesAdmin();
  } catch (err) {
    showToast("변경 오류: " + err.message, true);
  }
}

async function deleteReviewerNotice(id) {
  if (!confirm("이 공지를 삭제하시겠습니까?")) return;
  try {
    const data = await _post('noticeDelete', { id });
    if (!data || data.ok === false) throw new Error((data && data.error) || "삭제 실패");
    showToast("공지가 삭제되었습니다");
    loadReviewerNoticesAdmin();
  } catch (err) {
    showToast("삭제 오류: " + err.message, true);
  }
}

  /* ── 마운트 ──────────────────────────────────────────────────
     ★ 호스트 테마가 없으면(통합 작업대) `as-standalone` 으로 같은 토큰을 주입한다.
       admin.html 은 테마가 있어 클래스가 붙지 않으므로 **렌더 결과가 그대로**다. */
  var PANELS = { nickname: _nicknameHtml, business: _businessHtml, notice: _noticeHtml };
  var LOADERS = { nickname: loadMyNickname, business: loadCompanyBusinessNo, notice: loadReviewerNoticesAdmin };
  var SEP = '<hr style="margin:28px 0;border:none;border-top:1px solid #E5E7EB">';

  function _injectStyles() {
    if (document.getElementById('adminSettingsStyles')) return;
    var st = document.createElement('style');
    st.id = 'adminSettingsStyles';
    st.textContent =
      '.as-standalone{--t1:#0F172A;--t2:#475569;--t3:#94A3B8;--t4:#9CA3AF;--p:#3182f6;--border:#E5E7EB;color:var(--t1)}' +
      '.as-standalone .admin-section-header{display:flex;align-items:center;justify-content:space-between;margin:0 0 4px;padding-bottom:8px;border-bottom:1px solid var(--border)}';
    document.head.appendChild(st);
  }
  function _hostHasTheme() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--t1');
      return !!(v && v.trim());
    } catch (_) { return false; }
  }

  /**
   * @param {string} elId  마운트 지점 id
   * @param {{panels?:string[], autoload?:boolean}} [opts]
   *        panels  = 그릴 패널(기본 3종 전부). 서버 권한과 1:1로 맞춰 호출부가 정한다.
   *        autoload= 마운트 직후 값을 불러올지(기본 true). 관리자 대시보드는 탭 전환 시점에
   *                  따로 부르므로 false 로 넘겨 **로드 타이밍을 종전 그대로** 둔다.
   */
  function mount(elId, opts) {
    var el = document.getElementById(elId);
    if (!el) return false;
    var o = opts || {};
    var list = (o.panels && o.panels.length) ? o.panels : ['nickname', 'business', 'notice'];
    list = list.filter(function (k) { return !!PANELS[k]; });
    _injectStyles();
    if (!_hostHasTheme()) el.classList.add('as-standalone');
    el.innerHTML = list.map(function (k) { return PANELS[k](); }).join(SEP);
    if (o.autoload !== false) list.forEach(function (k) { try { LOADERS[k](); } catch (_) {} });
    return true;
  }

  window.AdminSettings = { mount: mount, panels: Object.keys(PANELS) };

  /* 전역 노출 — 생성 HTML 의 onclick 문자열과 index-app.js 의 탭 전환 훅이 이 이름들을 부른다.
     ★ index-app.js 에는 같은 이름의 선언이 남아 있으면 안 된다(뒤에 로드되어 이걸 덮는다). */
  window.loadMyNickname = loadMyNickname;
  window.saveMyNickname = saveMyNickname;
  window.loadCompanyBusinessNo = loadCompanyBusinessNo;
  window.saveCompanyBusinessNo = saveCompanyBusinessNo;
  window.uploadCashReceiptGuide = uploadCashReceiptGuide;
  window.clearCashReceiptGuide = clearCashReceiptGuide;
  window.CR_GUIDE_CHANNELS = CR_GUIDE_CHANNELS;
  window.loadReviewerNoticesAdmin = loadReviewerNoticesAdmin;
  window.saveReviewerNotice = saveReviewerNotice;
  window.toggleReviewerNoticeForm = toggleReviewerNoticeForm;
  window.editReviewerNotice = editReviewerNotice;
  window.cancelReviewerNoticeEdit = cancelReviewerNoticeEdit;
  window.toggleReviewerNotice = toggleReviewerNotice;
  window.deleteReviewerNotice = deleteReviewerNotice;
})();
