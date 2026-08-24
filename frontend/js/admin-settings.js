/* ══════════════════════════════════════════════════════════════
   관리자 설정 패널 (공유 모듈) — 내 닉네임 · 회사 사업자번호(제공정보) · 리뷰어 소식·공지

   원래 admin.html 인라인 마크업 + index-app.js 안에만 있던 설정 화면을 **모듈로 뺐다**.
   리뷰웹시스템[3버전](Track B)이 기존 관리자 대시보드를 대체하려면 이 설정들도 작업보드에서 해야 하는데,
   사본을 만들면 문구·필드·저장 로직 중 하나만 고쳐도 두 화면이 갈라진다
   (cs-inquiry.js · recruit-modal.js · work-order-detail.js 와 같은 규율).

   ★ 함수명·마크업은 한 글자도 바꾸지 않았다 — 생성 HTML 안의 onclick 문자열
     (saveMyNickname·saveCompanyBusinessNo·uploadCashReceiptGuide·clearCashReceiptGuide·
      loadReviewerNoticesAdmin·saveReviewerNotice·editReviewerNotice·toggleReviewerNotice…)과
     index-app.js 의 탭 전환 훅, 회귀가드가 이름으로 묶여 있다.
   ★ 호스트 전역(escHtml·showToast·API_BASE_URL)이 없는 화면(리뷰웹시스템[3버전])을 위해 폴백을 둔다.
   ★ 호스트 테마(css/index.css 의 --t1·--p·.admin-section-header)가 없는 화면에서는
     마운트 시 1회 감지해 `as-standalone` 클래스로 같은 값을 주입한다 —
     그래서 **admin.html 의 마크업·렌더 결과는 한 바이트도 바뀌지 않는다**
     (recruit-modal.js 가 var() 폴백 없이 리뷰웹시스템[3버전]에서 무너졌던 실측 사고의 재발 방지).
   ★ 서버 경로는 `window.ADMIN_SETTINGS_API` 재기준(campaign-cards 의 CAMPAIGN_ADMIN_API 와 같은 장치) —
     리뷰웹시스템[3버전]은 `/api/trackb/settings/*`(인트라넷 SSO 토큰이 도달 가능한 유일한 경로).

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
     window.ADMIN_SETTINGS_API 가 설정된 화면(리뷰웹시스템[3버전])에서만 그 베이스 + 접미사로 간다. */
  var EP_DEFAULT = {
    nickname:     "/api/admin/my-nickname",          // GET · POST
    providerInfo: "/api/tab/provider-info",          // GET
    businessNo:   "/api/tab/company-business-no",    // POST
    cashGuide:    "/api/tab/cash-receipt-guide",     // POST
    guideImage:   "/api/order/guide-image",          // POST (업로드 인프라 재사용)
    noticesAll:   "/api/reviewer/notices/all",       // GET
    noticeSave:   "/api/reviewer/notices/save",      // POST
    noticeDelete: "/api/reviewer/notices/delete",    // POST
    homeBanner: "/api/reviewer/home-banner/all",
    homeBannerSave: "/api/reviewer/home-banner/save",
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
    homeBanner: "/home-banner",
    homeBannerSave: "/home-banner/save",
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
    return _postAt(_ep(key), body);
  }
  /* 경로를 직접 지정하는 POST — 호스트별 재기준이 필요 없는(양쪽에서 그대로 닿는) 경로용.
     작업표 표준열(WT_EP)·리뷰타입 정리(RTC_EP)가 쓴다. */
  async function _postAt(path, body) {
    var r = await fetch(_apiBase() + path, {
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
    _setNavBadge('nickname', d.nickname ? d.nickname : '미설정', d.nickname ? '' : 'warn');
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
  /* 목록형 슬롯의 상태칩·버튼도 함께 — ★ 없으면 조용히 건너뛴다(구조가 달라도 안 죽는다). */
  const st = document.getElementById('crGuideStat' + cap);
  if (st) { st.textContent = url ? '등록됨' : '없음'; st.className = 'as-stat ' + (url ? 'on' : 'off'); }
  const btn = document.getElementById('crGuideBtn' + cap);
  if (btn) btn.textContent = url ? '바꾸기' : '＋ 등록';
  const del = document.getElementById('crGuideDel' + cap);
  if (del) del.style.display = url ? '' : 'none';
  const sub = document.getElementById('crGuideSub' + cap);
  if (sub) {
    sub.innerHTML = url
      ? '현영 공고의 작업내용에서 <b>리뷰어에게</b> 이 이미지가 보입니다'
      : '등록된 이미지가 없습니다 — 문구 안내만 나갑니다';
  }
}

function _businessHtml() {
  /* ★ 슬롯은 목록형 한 줄(시안 B) — 썸네일 52 + 이름/부가설명 + 상태칩 + 버튼.
     타일 격자보다 세로 스캔이 빨라 채널이 늘어도 화면이 번잡해지지 않는다.
     ★ id(crGuideImg/None/File<Cap>)·onchange 는 한 글자도 바꾸지 않는다 —
       로더(_setCashReceiptGuideDisplay)와 회귀가드가 이름으로 묶여 있다.
     ★ 날것의 <input type=file> 은 숨기고 <label for> 버튼으로 누른다(값·이벤트 경로는 동일). */
  const slots = CR_GUIDE_CHANNELS.map(c => `
              <div class="as-slot">
                <div class="as-slotth">
                  <img id="crGuideImg${c.cap}" alt="" style="display:none">
                  <span id="crGuideNone${c.cap}" class="as-slotnone">없음</span>
                </div>
                <div class="as-slotbody">
                  <div class="as-slotnm">${c.emoji} ${c.label}</div>
                  <div class="as-slotsub" id="crGuideSub${c.cap}">등록된 이미지가 없습니다 — 문구 안내만 나갑니다</div>
                </div>
                <span class="as-stat off" id="crGuideStat${c.cap}">없음</span>
                <input type="file" id="crGuideFile${c.cap}" accept="image/*" class="as-file" onchange="uploadCashReceiptGuide('${c.key}', this)">
                <label class="as-btn" id="crGuideBtn${c.cap}" for="crGuideFile${c.cap}">＋ 등록</label>
                <button class="as-btn del" id="crGuideDel${c.cap}" style="display:none" onclick="clearCashReceiptGuide('${c.key}')">제거</button>
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
        <div class="as-sub">
          <div class="as-subt">🧾 현금영수증 발행방법 이미지 <span>— 현영 탭 공고의 작업내용에서 리뷰어에게 채널에 맞는 이미지가 보입니다</span></div>
          <!-- ★ 채널 목록은 서버 utils/cashReceiptChannels.js 가 단일 출처 —
               슬롯을 늘릴 땐 그쪽 표에 먼저 추가한다(회귀가드가 일치를 고정). -->
          <div class="as-slots">${slots}
          </div>
          <div class="as-foot">등록하지 않은 채널은 <b>문구 안내만</b> 나갑니다(이미지 없이도 공고는 정상 노출).</div>
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
      let filled = 0;
      for (const c of CR_GUIDE_CHANNELS) {
        const url = g[c.key] || '';
        if (url) filled++;
        _setCashReceiptGuideDisplay(c.key, url);
      }
      _setNavBadge('business', filled + ' / ' + CR_GUIDE_CHANNELS.length, filled ? '' : 'warn');
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
   ★ AI 판별 예시이미지 (현금영수증 · 리뷰) — 자동검수의 "기준 실물"
   ──────────────────────────────────────────────────────────────
   위 **발행방법 이미지**와 헷갈리기 쉬운데 용도가 정반대다:
     · 발행방법(위)  = 리뷰어에게 보여주는 안내 — 결제 전 "이렇게 발행하세요"
     · 예시(여기)    = AI가 판정에 쓰는 기준 — 리뷰어에게 **보이지 않는다**
   현금영수증 예시는 제출 캡처의 영수증 슬롯 검수(captureVerify)에, 리뷰 예시는
   리뷰 화면·채널 판별(1차 필터·2차 검수)에 few-shot 으로 동봉된다.

   ★ 슬롯 목록을 여기에 적어두지 않는다 — **서버 응답 그대로 그린다**.
     채널 표(utils/cashReceiptChannels.js · utils/reviewSampleChannels.js)의 사본을
     프론트에 두면 채널을 늘렸을 때 한 칸이 조용히 빠진다(실측: 현영 안내가 2슬롯에 머물렀다).
   ★ 서버 경로는 재기준(ADMIN_SETTINGS_API)을 쓰지 않는다 — `/api/trackb/review-inspect/samples`
     는 관리자 대시보드(admin_token)와 리뷰웹시스템[3버전](인트라넷 SSO) **양쪽에서 닿는 경로**다
     (작업표 표준 열 패널과 같은 판단). 리뷰웹시스템[3버전] 리뷰검수 탭의 [🖼 판별 예시] 모달과
     **같은 저장소**라 어느 쪽에서 올려도 결과가 같다.
   ══════════════════════════════════════════════════════════════ */
var SMP_EP = '/api/trackb/review-inspect/samples';

async function _smpFetch(body) {
  var opt = body ? { method: 'POST', headers: _headers(), body: JSON.stringify(body) } : { headers: _headers() };
  var r = await fetch(_apiBase() + SMP_EP, opt);
  var j = await r.json().catch(function () { return null; });
  if (!j) throw new Error('HTTP ' + r.status);
  if (j.ok === false) throw new Error(j.error || '요청 실패');
  return j;
}

function _aisamplesHtml() {
  return `
        <!-- AI 판별 예시이미지 (현금영수증 · 리뷰) -->
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">
            <i class="fas fa-robot" style="color:#2563A8;margin-right:6px"></i>AI 판별 예시이미지 (자동검수 기준)
          </span>
          <button onclick="loadAiSamples()" style="padding:4px 10px;background:#F3F4F6;color:#374151;border:none;border-radius:7px;font-size:.72rem;font-weight:600;cursor:pointer"><i class="fas fa-sync-alt"></i> 새로고침</button>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:8px 0 12px;line-height:1.6">
          리뷰어가 올린 캡처를 AI가 판정할 때 <b>"정상은 이렇게 생겼다"의 기준</b>으로 함께 보는 실물 예시입니다.
          <b style="color:#B91C1C">리뷰어 화면에는 나가지 않습니다</b>(위 발행방법 이미지와 다릅니다).
          등록하지 않아도 검수는 동작하며, 채널 판별 정확도만 낮아집니다.
        </p>
        <div class="as-sub">
          <div class="as-subt">🧾 현금영수증 판별 예시 <span>— 현영 탭의 <b>영수증 캡처 슬롯</b> 검수에 쓰입니다(채널당 1장)</span></div>
          <div id="asSmpReceipt" class="as-slots"><div class="as-smpload">불러오는 중…</div></div>
        </div>
        <div class="as-sub">
          <div class="as-subt">🖼 리뷰 판별 예시 <span>— 리뷰 화면·채널 판별(첨부 즉시 필터 · 제출 후 검수)에 쓰입니다</span></div>
          <div id="asSmpReview" class="as-slots"><div class="as-smpload">불러오는 중…</div></div>
        </div>
        <div class="as-sub">
          <div class="as-subt">🛒 자동 분류(오제출 이동) 판별 예시 <span>— 구매캡처·구매확정 화면의 구분 기준. <b style="color:#B91C1C">두 장을 모두 등록해야</b> 구매캡처 자동 이동이 켜집니다</span></div>
          <div id="asSmpRoute" class="as-slots"><div class="as-smpload">불러오는 중…</div></div>
        </div>
        <div class="as-sub">
          <div class="as-subt">🎯 오제출 자동분류 정확도 <span>— 리뷰검수에서 사람이 수동 분류한 결과(정답)와 AI의 관측 판단을 대조합니다. 일치율이 충분히 오르면 자동 이동(auto) 전환을 검토하세요</span></div>
          <div id="asRtStats" style="font-size:.78rem;color:#6B7280;margin-top:6px;line-height:1.6">불러오는 중…</div>
        </div>
        <div class="as-sub">
          <div class="as-subt">🧹 오제출 소급 정리 <span>— 과거 제출분에서 잘못 들어간 캡처(리뷰 칸의 영수증 등)를 찾아 올바른 폴더로 이동합니다. <b>미리보기 → 실행</b> 2단계(자동으로 옮기지 않습니다)</span></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0 0">
            <select id="asRtTab" style="flex:1;min-width:220px;max-width:420px;padding:7px 9px;border:1px solid #D1D5DB;border-radius:7px;font-size:.78rem;outline:none">
              <option value="">탭 목록 불러오는 중…</option>
            </select>
            <button onclick="previewRouteSweep()" style="padding:7px 14px;background:#F3F4F6;color:#374151;border:none;border-radius:7px;font-size:.76rem;font-weight:700;cursor:pointer">🔍 미리보기</button>
            <button id="asRtRunBtn" onclick="runRouteSweep()" style="display:none;padding:7px 14px;background:#B91C1C;color:#fff;border:none;border-radius:7px;font-size:.76rem;font-weight:700;cursor:pointer">▶ 이동 실행</button>
          </div>
          <div id="asRtResult" style="font-size:.76rem;color:#6B7280;margin-top:8px;line-height:1.6"></div>
        </div>`;
}

/** 슬롯 1줄. kind = 'receipt' | 'review' (저장 창구가 갈리는 유일한 값)
    ★ 발행방법 슬롯과 **같은 목록형**(as-slot) — 두 곳이 다른 모양이면 "같은 일인데 화면이 다르다"가 된다.
    ★ id(asSmpFile_*)·onchange 는 불변. 파일 입력은 숨기고 label 로 누른다. */
var AS_SMP_CAP = 5;   // 표시용 — 상한의 진실원본은 서버(SAMPLE_SLOT_CAP)
/** 슬롯 값 — 신백엔드 imageUrls 배열, 구백엔드 imageUrl 단일(하위호환). */
function _smpUrls(s) { return (s && s.imageUrls) || (s && s.imageUrl ? [s.imageUrl] : []); }

function _smpCardHtml(kind, s) {
  var id = kind + '_' + s.key;
  var urls = _smpUrls(s);
  var full = urls.length >= AS_SMP_CAP;
  /* ★ 누적: 슬롯 하나 = 여러 장. 장별 ✕(개별 삭제)이고 [＋ 추가]는 지우지 않고 쌓는다.
     ★ 썸네일 클릭 = 크게 보기(_smpZoom) — 40px 썸네일로는 "무엇을 기준으로 등록했는지"를
       확인할 수 없어 등록만 하고 검증이 안 되던 문제(실사용 신고). onclick 은 인덱스만 넘긴다. */
  var thumbs = urls.length
    ? urls.map(function (u, i) {
        return '<span class="as-smpth">' +
          '<img src="' + escHtml(u) + '" alt="" loading="lazy" title="클릭하면 크게 봅니다" ' +
            'onclick="_smpZoom(\'' + escHtml(kind) + '\',\'' + escHtml(s.key) + '\',' + i + ')">' +
          '<button title="이 장만 제거" onclick="clearAiSample(\'' + escHtml(kind) + '\',\'' + escHtml(s.key) + '\',' + i + ')" ' +
            'class="as-smpx">✕</button>' +
          '</span>';
      }).join('')
    : '<span class="as-slotnone">없음</span>';
  return '<div class="as-slot">' +
    '<div class="as-slotth" style="width:auto;min-width:44px;display:flex;align-items:center">' + thumbs + '</div>' +
    /* ★ 부가설명 줄은 두지 않는다 — 슬롯이 13개라 같은 문장이 13번 반복되면
         그 자체가 소음이 된다(상태칩이 이미 등록/없음을 말한다). */
    '<div class="as-slotbody">' +
      '<div class="as-slotnm">' + escHtml((s.emoji || '') + ' ' + (s.label || s.key)) + '</div>' +
    '</div>' +
    '<span class="as-stat ' + (urls.length ? 'on' : 'off') + '">' + (urls.length ? urls.length + ' / ' + AS_SMP_CAP : '없음') + '</span>' +
    '<input type="file" accept="image/*" class="as-file" id="asSmpFile_' + escHtml(id) + '" ' +
      'onchange="uploadAiSample(\'' + escHtml(kind) + '\',\'' + escHtml(s.key) + '\', this)">' +
    (full
      ? '<span class="as-btn" style="opacity:.45;cursor:default" title="슬롯당 최대 ' + AS_SMP_CAP + '장 — 덜 닮은 장을 지우고 추가하세요">가득참</span>'
      : '<label class="as-btn" for="asSmpFile_' + escHtml(id) + '">＋ 추가</label>') +
    '</div>';
}

/* ── 크게 보기(라이트박스) ───────────────────────────────────────────
 * ★ 등록해 둔 예시가 "정말 그 화면인지" 확인할 수 있어야 한다 — 40px 썸네일로는 불가능했다.
 * ★ 슬롯 목록은 서버 응답이 유일 출처(_smpLast) — 프론트가 URL 사본을 따로 들지 않는다.
 * ★ body 직속 마운트(패널은 스크롤 컨테이너 안이라 오버레이가 화면 흐름에 섞인다).
 * ★ 색·크기는 리터럴 고정(호스트 테마 없는 리뷰웹시스템[3버전]에서도 같은 모양). */
var _smpLast = null;      // 마지막으로 받은 samples 응답(슬롯 → 이미지 목록)
var _smpZoomCtx = null;   // {urls, idx, label}

function _smpSlotOf(kind, key) {
  if (!_smpLast) return null;
  var list = kind === 'receipt' ? (_smpLast.receiptSamples || [])
    : kind === 'route' ? (_smpLast.routeSamples || []) : (_smpLast.samples || []);
  for (var i = 0; i < list.length; i++) if (String(list[i].key) === String(key)) return list[i];
  return null;
}

function _smpZoom(kind, key, idx) {
  var s = _smpSlotOf(kind, key);
  if (!s) { showToast('목록을 다시 불러온 뒤 열어주세요.', true); return; }
  var urls = _smpUrls(s);
  if (!urls.length) return;
  _smpZoomCtx = { urls: urls, idx: Math.max(0, Math.min(urls.length - 1, Number(idx) || 0)),
                  label: (s.emoji || '') + ' ' + (s.label || s.key), kind: kind, key: key };
  _smpZoomRender();
}

function _smpZoomRender() {
  var c = _smpZoomCtx;
  if (!c) return;
  var el = document.getElementById('asSmpZoom');
  if (!el) {
    el = document.createElement('div');
    el.id = 'asSmpZoom';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) { if (e.target === el) _smpZoomClose(); });
  }
  var multi = c.urls.length > 1;
  el.className = 'as-zoom';
  el.innerHTML =
    '<div class="as-zoombox">' +
      '<div class="as-zoomh">' +
        '<b>' + escHtml(c.label) + '</b>' +
        '<span class="as-zoomn">' + (c.idx + 1) + ' / ' + c.urls.length + '장</span>' +
        '<span style="flex:1"></span>' +
        (multi ? '<button class="as-btn" onclick="_smpZoomStep(-1)" title="이전 (←)"' + (c.idx <= 0 ? ' disabled' : '') + '>‹</button>' +
                 '<button class="as-btn" onclick="_smpZoomStep(1)" title="다음 (→)"' + (c.idx >= c.urls.length - 1 ? ' disabled' : '') + '>›</button>' : '') +
        '<button class="as-btn" onclick="_smpZoomClose()">닫기</button>' +
      '</div>' +
      '<div class="as-zoomimg"><img src="' + escHtml(c.urls[c.idx]) + '" alt=""></div>' +
      '<div class="as-zoomft">이 이미지는 <b>AI 판정의 기준</b>으로만 쓰이며 리뷰어 화면에는 나가지 않습니다.' +
        '<button class="as-btn del" style="margin-left:auto" onclick="_smpZoomDel()">이 장 제거</button></div>' +
    '</div>';
}

function _smpZoomStep(d) {
  var c = _smpZoomCtx;
  if (!c) return;
  var n = c.idx + d;
  if (n < 0 || n >= c.urls.length) return;   // ★ 끝에서 순환하지 않는다(어디까지 봤는지 잃지 않게)
  c.idx = n;
  _smpZoomRender();
}
function _smpZoomClose() {
  var el = document.getElementById('asSmpZoom');
  if (el) el.remove();
  _smpZoomCtx = null;
}
async function _smpZoomDel() {
  var c = _smpZoomCtx;
  if (!c) return;
  var kind = c.kind, key = c.key, idx = c.idx;
  _smpZoomClose();
  await clearAiSample(kind, key, idx);
}
/* ★ 리스너는 최상위에 한 번만 — 열 때마다 걸면 겹쳐 쌓여 한 번에 여러 장 건너뛴다.
   ★ 입력 중(input/textarea)에는 가로채지 않는다(다른 설정 칸 조작 보존). */
document.addEventListener('keydown', function (e) {
  if (!_smpZoomCtx) return;
  var t = e.target || {};
  var tag = String(t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'Escape') { _smpZoomClose(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { _smpZoomStep(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { _smpZoomStep(1); e.preventDefault(); }
});

/** 목차 배지 — 등록된 예시 / 전체 슬롯. 슬롯 목록은 서버 응답이 유일 출처라 여기서도 세기만 한다. */
function _smpBadge(j) {
  var all = (j.receiptSamples || []).concat(j.samples || []).concat(j.routeSamples || []);
  var filled = all.filter(function (s) { return _smpUrls(s).length > 0; }).length;
  _setNavBadge('aisamples', filled + ' / ' + all.length, filled ? '' : 'warn');
}

function _smpRender(elId, kind, list) {
  var el = document.getElementById(elId);
  if (!el) return;
  if (!list || !list.length) { el.innerHTML = '<div class="as-smpload">등록 가능한 슬롯이 없습니다.</div>'; return; }
  el.innerHTML = list.map(function (s) { return _smpCardHtml(kind, s); }).join('');
}

/** 등록 현황 불러오기 — **이미 서버에 올려둔 예시가 그대로 채워진다**(리뷰웹시스템[3버전]에서 올린 것 포함). */
async function loadAiSamples() {
  var rc = document.getElementById('asSmpReceipt');
  if (!rc) return;
  try {
    var j = await _smpFetch(null);
    _smpLast = j;   // ★ 크게 보기의 URL 출처 = 서버 응답 그대로(프론트 사본 금지)
    _smpRender('asSmpReceipt', 'receipt', j.receiptSamples || []);
    _smpRender('asSmpReview', 'review', j.samples || []);
    // 자동 분류 예시 — 구백엔드(routeSamples 미반환)면 안내만(배포 스큐 허위 표시 방지)
    if (Array.isArray(j.routeSamples)) _smpRender('asSmpRoute', 'route', j.routeSamples);
    else {
      var rt = document.getElementById('asSmpRoute');
      if (rt) rt.innerHTML = '<div class="as-smpload">서버가 아직 자동 분류 예시를 지원하지 않습니다(배포 대기).</div>';
    }
    _smpBadge(j);
    _rtLoadTabs();   // 소급 정리 탭 목록(지연·fail-soft)
    _rtLoadStats();  // 자동분류 정확도(지연·fail-soft — 구백엔드면 안내만)
  } catch (e) {
    var msg = '<div class="as-smpload">불러오지 못했습니다: ' + escHtml(e.message) + '</div>';
    rc.innerHTML = msg;
    var rv = document.getElementById('asSmpReview');
    if (rv) rv.innerHTML = msg;
  }
}

/** 예시 업로드 — guide-image Drive+프록시 인프라 재사용(발행방법 이미지와 같은 경로). */
/* ══ 리뷰어 안내문구(검수 결과) ═════════════════════════════════════
 * 유형별로 리뷰어에게 나갈 문장을 직접 쓴다. ★ 유형 목록·기본 문구는 **서버가 준 표**를 그대로
 * 그린다(프론트 사본 금지 — 설정과 실제 전송이 갈리면 "고쳤는데 그대로"가 된다).
 * ★ 빈칸 저장 = 그 유형만 기본 문구로 되돌리기(빈 메시지가 리뷰어에게 나가지 않는다).
 */
var IMSG_EP = '/api/trackb/settings/inspect-messages';
var _imsgKinds = [];

function _inspectmsgHtml() {
  return `
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">
            <i class="fas fa-comment-dots" style="color:#2563A8;margin-right:6px"></i>리뷰어 안내문구 (검수 결과)
          </span>
          <button onclick="loadInspectMessages()" style="padding:4px 10px;background:#F3F4F6;color:#374151;border:none;border-radius:7px;font-size:.72rem;font-weight:600;cursor:pointer"><i class="fas fa-sync-alt"></i> 새로고침</button>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:8px 0 12px;line-height:1.6">
          리뷰검수에서 <b>[✕ 불량] · [🗑 중복파일 제거] · [이동]</b>을 눌렀을 때 리뷰어의 <b>1:1 문의</b>로 나가는 문장입니다.
          처리 팝업에 이 문장이 미리 채워지고, <b>보내기 전에 그때그때 고칠 수도</b> 있습니다.
          <b style="color:#B91C1C">전송 여부는 항상 관리자가 선택</b>합니다.
        </p>
        <div style="font-size:.75rem;color:var(--t3);background:#F8FAFC;border:1px solid #E5E7EB;border-radius:9px;padding:9px 12px;margin-bottom:12px;line-height:1.6">
          쓸 수 있는 치환어 — <code>{reason}</code> 판정 근거 문장 · <code>{work}</code> 작업명 · <code>{to}</code> 옮긴 칸 이름<br>
          <span style="color:#9CA3AF">비워두고 저장하면 그 유형만 기본 문구로 돌아갑니다.</span>
        </div>
        <div class="as-imsg-grid" id="asImsgList"><div class="as-smpload">불러오는 중…</div></div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
          <button onclick="saveInspectMessages()" style="padding:8px 16px;background:#2563A8;color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:700;cursor:pointer">저장</button>
          <span id="asImsgMsg" style="font-size:.76rem;color:#6B7280"></span>
        </div>`;
}

async function loadInspectMessages() {
  var box = document.getElementById('asImsgList');
  if (!box) return;
  try {
    var r = await fetch(_apiBase() + IMSG_EP, { headers: _headers() });
    var j = await r.json().catch(function () { return null; });
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    _imsgKinds = j.kinds || [];
    var maxLen = Number(j.maxLen) || 1000;
    box.innerHTML = '<div class="as-imsg-colhead" aria-hidden="true"><span>항목명</span><span>안내문구 입력</span></div>'
      + _imsgKinds.map(function (k) {
      var v = (j.messages || {})[k.key] || '';
      return '<div class="as-imsg-row">'
        + '<div class="as-imsg-meta">'
          + '<div class="as-imsg-label">' + escHtml(k.label) + '</div>'
          + '<div class="as-imsg-desc">' + escHtml(k.desc || '') + '</div>'
          + '<button class="as-imsg-reset" onclick="_imsgReset(\'' + escHtml(k.key) + '\')">기본 문구로</button>'
        + '</div>'
        + '<div class="as-imsg-field">'
          + '<textarea class="as-imsg-input" id="asImsg_' + escHtml(k.key) + '" rows="3" maxlength="' + maxLen + '" aria-label="' + escHtml(k.label) + ' 안내문구"></textarea>'
          + '<div class="as-imsg-help">비워두고 저장하면 기본 문구로 돌아갑니다.</div>'
        + '</div>'
        + '</div>';
      }).join('');
    // ★ 값은 value 로 넣는다(HTML 보간 금지 — 저장된 문장에 무엇이 있든 안전하게)
    _imsgKinds.forEach(function (k) {
      var t = document.getElementById('asImsg_' + k.key);
      if (t) t.value = (j.messages || {})[k.key] || '';
    });
    _setNavBadge('inspectmsg', _imsgKinds.length + '종', '');
  } catch (e) {
    box.innerHTML = '<div class="as-smpload">불러오지 못했습니다: ' + escHtml(e.message) + '</div>';
  }
}

function _imsgReset(key) {
  var k = _imsgKinds.find(function (x) { return x.key === key; });
  var t = document.getElementById('asImsg_' + key);
  if (k && t) t.value = k.def || '';
}

async function saveInspectMessages() {
  var msg = document.getElementById('asImsgMsg');
  var payload = {};
  _imsgKinds.forEach(function (k) {
    var t = document.getElementById('asImsg_' + k.key);
    payload[k.key] = t ? String(t.value || '').trim() : '';
  });
  try {
    var r = await fetch(_apiBase() + IMSG_EP, {
      method: 'POST', headers: _headers(), body: JSON.stringify({ messages: payload }),
    });
    var j = await r.json().catch(function () { return null; });
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    // 저장 결과(빈칸은 기본 문구로 되돌아간 값)를 화면에 반영 — "저장했는데 화면은 빈칸" 방지
    _imsgKinds.forEach(function (k) {
      var t = document.getElementById('asImsg_' + k.key);
      if (t) t.value = (j.messages || {})[k.key] || '';
    });
    if (msg) { msg.textContent = '✅ 저장했습니다.'; setTimeout(function () { msg.textContent = ''; }, 2500); }
    showToast('✅ 안내문구를 저장했습니다.');
  } catch (e) {
    if (msg) msg.textContent = '❌ 저장 실패: ' + e.message;
    showToast('❌ 저장 실패: ' + e.message, true);
  }
}

/** 자동분류 정확도 — 사람 수동 분류(정답) vs AI 관측 계획 대조(읽기 전용, 저장 없음).
 *  ★ fail-soft: 통계가 죽어도 예시 등록 화면은 살아야 한다. 구백엔드(404) = 배포 대기 안내. */
async function _rtLoadStats() {
  var el = document.getElementById('asRtStats');
  if (!el) return;
  try {
    var r = await fetch(_apiBase() + '/api/trackb/review-inspect/route-stats', { headers: _headers() });
    var j = await r.json().catch(function () { return null; });
    if (!j || j.ok !== true) { el.textContent = '아직 통계를 지원하지 않습니다(배포 대기).'; return; }
    if (!j.total) {
      el.innerHTML = '최근 ' + j.days + '일간 수동 분류 기록이 없습니다 — 리뷰검수의 [🧾 현금영수증으로 이동]·[🛒 구매캡처로 이동]으로 분류하면 여기 정확도가 쌓입니다.';
      return;
    }
    var pct = Math.round((j.match / j.total) * 100);
    el.innerHTML =
      '최근 ' + j.days + '일 · 수동 분류 <b>' + j.total + '건</b> 기준 — ' +
      '<b style="color:' + (pct >= 95 ? '#15803D' : '#B45309') + '">AI 판단 일치 ' + j.match + '건 (' + pct + '%)</b>' +
      ' · AI 미탐 ' + j.miss + '건 · AI 상이 <b style="color:#B91C1C">' + j.differ + '건</b><br>' +
      (pct >= 95
        ? '일치율이 95% 이상입니다 — Railway 에서 <code>AUTO_FILE_ROUTE=auto</code> 전환을 검토할 수 있습니다(전환은 사람이 결정).'
        : '미탐·상이 건의 실물을 위 판별 예시에 추가하면 일치율이 올라갑니다(수동 분류 완료 팝업의 등록 제안 이용).');
  } catch (e) {
    el.textContent = '통계를 불러오지 못했습니다: ' + e.message;
  }
}

async function uploadAiSample(kind, key, input) {
  var file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('이미지는 5MB 이하로 올려주세요.', true); input.value = ''; return; }
  showToast('예시이미지 업로드 중...');
  try {
    var b64 = await new Promise(function (res, rej) {
      var rd = new FileReader();
      rd.onload = function () { res(String(rd.result).split(',')[1]); };
      rd.onerror = rej;
      rd.readAsDataURL(file);
    });
    var uj = await _post('guideImage', {
      imageBase64: b64, mimeType: file.type || 'image/jpeg',
      fileName: 'aisample_' + kind + '_' + key + '_' + Date.now(),
    });
    if (!uj.ok || !uj.url) throw new Error(uj.error || '업로드 실패');
    // ★ kind 로 저장 창구를 가른다 — receipt 는 channel, route 는 kind+key, review 는 슬롯 key.
    //   mode:'add' = 누적(기존 예시를 지우지 않는다) — 상한 초과는 서버가 사유와 함께 거부.
    await _smpFetch(kind === 'receipt'
      ? { kind: 'receipt', channel: key, imageUrl: uj.url, mode: 'add' }
      : kind === 'route'
        ? { kind: 'route', key: key, imageUrl: uj.url, mode: 'add' }
        : { key: key, imageUrl: uj.url, mode: 'add' });
    showToast('✅ 예시이미지가 추가되었습니다.');
    loadAiSamples();
  } catch (e) {
    showToast('❌ 등록 실패: ' + e.message, true);
  } finally { input.value = ''; }
}

async function clearAiSample(kind, key, idx) {
  if (!confirm('이 예시이미지 한 장을 제거할까요?\nAI 판정은 계속 동작하며, 그 슬롯의 판별 정확도만 낮아질 수 있습니다.')) return;
  try {
    // ★ 개별 삭제(mode:'remove'+index) — 슬롯 전체가 아니라 고른 한 장만 지운다.
    await _smpFetch(kind === 'receipt'
      ? { kind: 'receipt', channel: key, mode: 'remove', index: idx }
      : kind === 'route'
        ? { kind: 'route', key: key, mode: 'remove', index: idx }
        : { key: key, mode: 'remove', index: idx });
    showToast('제거했습니다.');
    loadAiSamples();
  } catch (e) {
    showToast('❌ 제거 실패: ' + e.message, true);
  }
}

/* ── 오제출 소급 정리 (자동 분류 스윕 · 미리보기 → 실행 2단계) ─────────────
   서버 판정·이동은 /api/trackb/file-route/sweep 하나(dryRun 기본 true).
   ★ 탭 선택은 캐시 배열 인덱스만 전달(onclick 문자열에 시트발 문자열 보간 금지). */
var _rtTabs = null;
var _rtLastPreview = null;   // { sheetId, tabName, plans } — 실행은 미리보기와 같은 탭만

async function _rtLoadTabs() {
  var sel = document.getElementById('asRtTab');
  if (!sel || _rtTabs) { if (sel && _rtTabs) _rtRenderTabs(); return; }
  try {
    var r = await fetch(_apiBase() + '/api/trackb/tabs?limit=800', { headers: _headers() });
    var j = await r.json();
    if (!j || j.ok === false || !Array.isArray(j.tabs)) throw new Error((j && j.error) || 'HTTP ' + r.status);
    _rtTabs = j.tabs;
    _rtRenderTabs();
  } catch (e) {
    sel.innerHTML = '<option value="">탭 목록을 불러오지 못했습니다</option>';
  }
}
function _rtRenderTabs() {
  var sel = document.getElementById('asRtTab');
  if (!sel) return;
  var opts = ['<option value="">— 정리할 작업(탭) 선택 —</option>'];
  for (var i = 0; i < _rtTabs.length; i++) {
    var t = _rtTabs[i];
    opts.push('<option value="' + i + '">' + escHtml((t.spreadsheetTitle || t.sheetId || '') + ' › ' + (t.tabName || '')) + '</option>');
  }
  sel.innerHTML = opts.join('');
}
function _rtPicked() {
  var sel = document.getElementById('asRtTab');
  var i = sel ? parseInt(sel.value, 10) : NaN;
  return (_rtTabs && !isNaN(i) && _rtTabs[i]) ? _rtTabs[i] : null;
}
async function previewRouteSweep() {
  var t = _rtPicked();
  var out = document.getElementById('asRtResult');
  var runBtn = document.getElementById('asRtRunBtn');
  if (runBtn) runBtn.style.display = 'none';
  _rtLastPreview = null;
  if (!t) { showToast('정리할 작업(탭)을 먼저 선택해주세요.', true); return; }
  if (out) out.textContent = '검사 중… (파일을 내려받아 AI로 판정합니다 — 최대 1~2분)';
  try {
    var r = await fetch(_apiBase() + '/api/trackb/file-route/sweep', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ sheetId: t.sheetId, tabName: t.tabName, dryRun: true, limit: 40 }),
    });
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    var plans = j.plans || [];
    if (!plans.length) {
      if (out) out.innerHTML = '검사 ' + j.scanned + '건 — 옮길 파일이 없습니다.'
        + (!j.hasRouteSamples ? ' <span style="color:#B45309">(구매캡처·구매확정 예시 2장이 등록되지 않아 구매캡처 이동은 검사에서 제외됐습니다)</span>' : '');
      return;
    }
    _rtLastPreview = { sheetId: t.sheetId, tabName: t.tabName, plans: plans };
    var rows = plans.map(function (p) {
      return '<div style="padding:4px 0;border-bottom:1px solid #F3F4F6">'
        + (p.rowIndex != null ? p.rowIndex + '행 · ' : '') + escHtml(p.reviewerName || '') + ' — '
        + '<b>' + escHtml(p.fromSlot) + ' → ' + escHtml(p.toSlot) + '</b>'
        + ' (AI ' + Math.round((p.confidence || 0) * 100) + '%)'
        + (p.duplicate ? ' <span style="color:#B91C1C;font-weight:700">중복 — 휴지통 대상</span>' : '')
        + '</div>';
    }).join('');
    if (out) out.innerHTML = '검사 ' + j.scanned + '건 중 <b>' + plans.length + '건</b>이 이동 대상입니다:' + rows
      + '<div style="color:#B45309;margin-top:6px">아직 아무것도 옮기지 않았습니다 — [▶ 이동 실행]을 눌러야 적용됩니다.</div>';
    if (runBtn) runBtn.style.display = '';
  } catch (e) {
    if (out) out.innerHTML = '<span style="color:#B91C1C">검사 실패: ' + escHtml(e.message) + '</span>';
  }
}
async function runRouteSweep() {
  var t = _rtPicked();
  var out = document.getElementById('asRtResult');
  if (!t || !_rtLastPreview || _rtLastPreview.sheetId !== t.sheetId || _rtLastPreview.tabName !== t.tabName) {
    showToast('먼저 [🔍 미리보기]로 대상을 확인해주세요.', true); return;
  }
  if (!confirm('미리보기에서 확인한 ' + _rtLastPreview.plans.length + '건을 실제로 이동할까요?\n\n· 파일이 올바른 폴더로 이동합니다(원장 슬롯도 함께 정정).\n· 중복 표시 건은 휴지통으로 갑니다(30일 내 복구 가능).\n· 각 건은 로그에 남고, 이동 건은 [원위치] 버튼으로 되돌릴 수 있습니다.')) return;
  if (out) out.textContent = '이동 중…';
  try {
    var r = await fetch(_apiBase() + '/api/trackb/file-route/sweep', {
      method: 'POST', headers: _headers(),
      body: JSON.stringify({ sheetId: t.sheetId, tabName: t.tabName, dryRun: false, limit: 40 }),
    });
    var j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    if (out) out.innerHTML = '✅ 완료 — 이동 <b>' + (j.moved || 0) + '</b>건 · 휴지통 <b>' + (j.trashed || 0) + '</b>건'
      + (j.failed ? ' · <span style="color:#B91C1C">실패 ' + j.failed + '건</span>' : '')
      + '<br>결과는 리뷰웹시스템[3버전] 「로그」 탭에서 건별로 확인·되돌리기 할 수 있습니다.';
    var runBtn = document.getElementById('asRtRunBtn');
    if (runBtn) runBtn.style.display = 'none';
    _rtLastPreview = null;
  } catch (e) {
    if (out) out.innerHTML = '<span style="color:#B91C1C">실행 실패: ' + escHtml(e.message) + '</span>';
  }
}

/* ══════════════════════════════════════════════════════════════
   ★ 리뷰어 소식·공지 관리 (관리자) — 리뷰어 홈 상단 노출
   ══════════════════════════════════════════════════════════════ */
let _rvNotices = [];

function _homeBannerHtml() {
  return '<div class="as-noticebox" style="min-width:0;border:1px solid #E5E7EB;border-radius:12px;background:#fff;padding:16px 18px">' +
    '<div class="admin-section-header"><span style="font-size:.95rem;font-weight:700;color:var(--t1)">리뷰홈 배너광고</span></div>' +
    '<p style="font-size:.78rem;color:var(--t3);margin:0 0 12px;line-height:1.6">리뷰어 홈의 공지와 모집공고 사이에 노출됩니다. <b>권장 이미지 크기: 1080 × 240px (4.5:1)</b></p>' +
    '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap"><div style="width:216px;height:48px;border:1px dashed #CBD5E1;border-radius:8px;overflow:hidden;background:#F8FAFC;display:grid;place-items:center"><img id="rvHomeBannerPreview" alt="배너 미리보기" style="display:none;width:100%;height:100%;object-fit:cover"><span id="rvHomeBannerEmpty" style="font-size:.7rem;color:#94A3B8">이미지 없음</span></div><div style="flex:1;min-width:220px"><label class="as-btn" for="rvHomeBannerFile">이미지 첨부</label><input class="as-file" id="rvHomeBannerFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange="uploadReviewerHomeBanner(this)"><div style="font-size:.7rem;color:#94A3B8;margin-top:6px">PNG, JPG, WebP, GIF · 최대 5MB</div><input id="rvHomeBannerUrl" type="url" maxlength="2048" placeholder="https:// 클릭 시 새 창으로 열 URL" style="margin-top:10px;width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #D1D5DB;border-radius:7px;font:inherit;font-size:.78rem"><label style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:var(--t2);margin-top:10px"><input id="rvHomeBannerActive" type="checkbox"> 배너 노출</label><button class="as-btn" style="margin-top:10px;background:#2563EB;color:#fff;border-color:#2563EB" onclick="saveReviewerHomeBanner()">저장</button></div></div></div>';
}
function _setHomeBannerPreview(url) { var img=document.getElementById('rvHomeBannerPreview'), empty=document.getElementById('rvHomeBannerEmpty'); if(!img||!empty)return; img.src=url||''; img.style.display=url?'':'none'; empty.style.display=url?'none':''; }
async function loadReviewerHomeBanner() { if(!document.getElementById('rvHomeBannerUrl'))return; try { var j=await _get('homeBanner'),b=(j&&j.banner)||{}; document.getElementById('rvHomeBannerUrl').value=b.clickUrl||''; document.getElementById('rvHomeBannerActive').checked=!!b.active; window._rvHomeBannerImageUrl=b.imageUrl||''; _setHomeBannerPreview(b.imageUrl||''); } catch(e){showToast('배너 설정을 불러오지 못했습니다: '+e.message,true);} }
async function uploadReviewerHomeBanner(input) { var file=input&&input.files&&input.files[0]; if(!file)return; if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type)||file.size>5*1024*1024){showToast('PNG, JPG, WebP, GIF 파일만 최대 5MB까지 올릴 수 있습니다.',true);input.value='';return;} var data=await new Promise(function(resolve,reject){var r=new FileReader();r.onload=function(){resolve(r.result);};r.onerror=reject;r.readAsDataURL(file);}); try {var j=await _post('guideImage',{imageBase64:data,mimeType:file.type,fileName:'reviewer_home_banner_'+Date.now()+'_'+file.name});if(!j||!j.ok||!j.url)throw new Error((j&&j.error)||'업로드 실패');window._rvHomeBannerImageUrl=j.url;_setHomeBannerPreview(j.url);showToast('배너 이미지를 올렸습니다. 저장하면 반영됩니다.');}catch(e){showToast('이미지 업로드 실패: '+e.message,true);} }
async function saveReviewerHomeBanner() { try {var j=await _post('homeBannerSave',{active:document.getElementById('rvHomeBannerActive').checked,imageUrl:window._rvHomeBannerImageUrl||'',clickUrl:(document.getElementById('rvHomeBannerUrl').value||'').trim()});if(!j||!j.ok)throw new Error((j&&j.error)||'저장 실패');window._rvHomeBannerImageUrl=j.banner.imageUrl;_setHomeBannerPreview(j.banner.imageUrl);showToast('리뷰홈 배너광고를 저장했습니다.');}catch(e){showToast('배너 저장 실패: '+e.message,true);} }

function _noticeHtml() {
  return `
        <!-- 리뷰어 소식·공지 관리 (리뷰어 홈 상단 노출) -->
        <div class="as-noticebox" style="min-width:0;border:1px solid #E5E7EB;border-radius:12px;background:#fff;padding:16px 18px">
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
    _setNavBadge('notice', String(_rvNotices.length) + '건', _rvNotices.length ? '' : 'warn');
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

/* ══════════════════════════════════════════════════════════════
   ★ 작업표 표준 열 (M1) — 통계 리포트 + 우리 표준 코어 열 확정
   ──────────────────────────────────────────────────────────────
   리포트는 "우리 시트들이 실제로 어떤 열을 쓰는가"를 보여줄 뿐이고,
   **무엇을 쓸지 정하는 것은 사람**이다. 여기서 확정한 열이 작업표 생성(M2)의 기본값이 된다.

   ★ 저장하는 것은 역할이 아니라 **열 이름**이다 — 작업표에 만들 열의 이름이 곧 시스템 판정을
     결정한다(예 '연락처'로 만들어야 구매양식 제출이 그 칸에 전화번호를 쓴다).
   ★ 서버 경로는 재기준(ADMIN_SETTINGS_API)을 쓰지 않는다 — `/api/trackb/worktable/*` 는
     관리자 대시보드(admin_token)와 리뷰웹시스템[3버전](인트라넷 SSO) **양쪽에서 그대로 닿는 유일한 경로**라
     호스트별로 다를 이유가 없다(다르게 두면 두 화면이 서로 다른 설정을 보게 된다).
   ══════════════════════════════════════════════════════════════ */
var WT_EP = { stats: '/api/trackb/worktable/header-stats', template: '/api/trackb/worktable/template' };
/* 공통 기본값 프리셋(사용자 확정 14열) — [공통을 기본 N열로] 버튼이 채운다.
   ★ 자동 적용하지 않는다: 저장된 설정이 없을 때 조용히 이 값이 쓰이면 "정하지 않았는데 정해진"
     상태가 된다(학습은 제안까지·확정은 사람이 — 이 화면의 원칙).
   ★★ `주문자` 는 일부러 없다(사용자 확정 2026-08-24) — 리뷰웹시스템[3버전]에서는 **참여자 칸이
     그 자리를 대체**한다(`sheetlessOrder` 가 `loginName || orderer || recipient` 로 채운다).
     주문자 원문은 주문 원장(`order_submissions.orderer`)에 그대로 남는다. 되살리지 말 것. */
var WT_PRESET_CORE = ['번호', '구매일자', '수취인', 'ID', '연락처', '주소',
  '은행', '계좌번호', '예금주', '결제금액', '주문번호', '리뷰', '입금', '비고'];   // ★ 리뷰제출 칸의 표준 이름 = '리뷰'(사용자 확정 2026-08-21)
var _wtTpl = null;      // { core:[names], channels:{key:[names]}, columns:[...], ... }
var _wtStats = null;    // 헤더 학습 리포트(펼칠 때 1회 로드)

async function _wtFetch(url, body) {
  var opt = body ? { method: 'POST', headers: _headers(), body: JSON.stringify(body) } : { headers: _headers() };
  var r = await fetch(_apiBase() + url, opt);
  var j = await r.json().catch(function () { return null; });
  if (!j) throw new Error('HTTP ' + r.status);
  if (j.ok === false) throw new Error(j.error || '요청 실패');
  return j;
}

/* 행 키 → DOM id 조각. 작업유형 키는 `wt:t1` 이라 그대로 id 에 넣으면 CSS 선택자에서 콜론이
   의사클래스로 읽힌다 → `wt-t1` 로 바꾼다(값 자체는 서버 발급 `[a-z][a-z0-9_]*` 라 안전). */
function _wtDomKey(key) { return String(key).replace(':', '-'); }

/** 채널 목록 = 기본 4채널 + 직접 추가 채널. ★ 기본 4채널 표(CR_GUIDE_CHANNELS)는 그대로 재사용. */
function _wtChannels() {
  var custom = ((_wtTpl && _wtTpl.customChannels) || []).map(function (c) {
    return { key: c.key, label: c.label, emoji: '🏷', custom: true };
  });
  return CR_GUIDE_CHANNELS.map(function (c) {
    return { key: c.key, label: c.label, emoji: c.emoji, custom: false };
  }).concat(custom);
}
/** 작업유형 목록(저장된 것 그대로). */
function _wtTypes() { return (_wtTpl && _wtTpl.workTypes) || []; }
/** 자동 선택 조건 목록 — ★ 서버가 내려 준 것을 그대로 쓴다(프론트 사본 금지). */
function _wtTriggers() { return (_wtTpl && _wtTpl.triggers) || []; }
function _wtTriggerLabel(k) {
  var t = _wtTriggers().filter(function (x) { return x.key === (k || 'auto'); })[0];
  return t ? t.label : '기본';
}

/* ══════════════════════════════════════════════════════════════
   ★★ 시안 B — 채널·유형은 **알약 줄 한 줄**, 열 담기는 **미리보기 오른쪽 끝** 하나 (사용자 확정)
   ──────────────────────────────────────────────────────────────
   종전엔 채널마다 행이 하나씩 있어 ① 알약과 행에 같은 채널이 두 번 나오고
   ② 열을 담는 칸이 행 개수만큼 흩어져 있었다. 이제
     · 채널/유형   = 알약 줄(오른쪽 끝에 [⚙ 관리] · [＋ 추가])
     · 열 담기      = 미리보기 오른쪽 끝 [＋ 열 추가] → 팝오버(입력 + 지금 쓰는 열 후보)
     · 순서·빼기    = 미리보기 칸 클릭 → 툴바 (종전 그대로)
   ★ 삭제·이름변경은 평소 화면에 두지 않는다 — [⚙ 관리] 안에서만(오클릭 방지).
   ══════════════════════════════════════════════════════════════ */
function _wtPillRowsHtml() {
  return '<div class="as-wtpills" id="wtPills"></div>';
}
function _worktableHtml() {
  /* 열 구성(시안 B) — 🌐 공통 요약 줄 + 채널/작업유형 **알약 줄** + 작업표 미리보기.
     담기·순서·빼기는 전부 미리보기 한 곳에서 한다(창구 단일화). */
  var rows =
    '<div class="as-wtchgroup common"><div class="as-wtchrow">' +
      '<span class="as-wtchlabel">🌐 공통 <i>모든 채널</i></span>' +
      '<span class="as-wtchips" id="wtChips_core"></span>' +
    '</div></div>' +
    _wtPillRowsHtml() +
    /* ★ 알약 줄 아래 = 작업표 미리보기(_wtRenderPreview 가 채운다) — 담기·조절이 여기서 끝난다. */
    '<div class="as-wtpv" id="wtPreview"></div>';
  return `
        <!-- 작업표 표준 열 -->
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">
            <i class="fas fa-table" style="color:#0EA5E9;margin-right:6px"></i>작업표 표준 열
          </span>
          <span id="wtSavedAt" style="font-size:.72rem;color:var(--t3)"></span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:8px 0 12px;line-height:1.6">
          작업표를 만들 때 들어갈 열을 정합니다. <b>작업표의 열 = 공통 + 그 채널 + 켠 작업유형</b>이라
          채널·유형마다 같은 열을 반복해 넣을 필요가 없습니다.
          아래 <b>헤더 학습 리포트</b>는 우리 시트들이 실제로 쓰는 열 통계이니, 정할 때 근거로 보세요.
        </p>

        <div style="font-size:.82rem;font-weight:700;margin-bottom:4px">열 구성</div>
        <p style="font-size:.75rem;color:var(--t3);margin:0 0 8px;line-height:1.6">
          채널·작업유형 알약을 눌러 <b>그 조합의 완성 양식</b>을 보고, 미리보기 오른쪽 끝
          <b>[＋ 열 추가]</b>로 담습니다. 칸을 누르면 순서·빼기 — <b>담기·조절이 모두 미리보기 한 곳</b>에서 끝납니다.
        </p>
        <div class="as-wtchbox">${rows}</div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0 8px">
          <button onclick="wtLoadPreset()" style="padding:7px 13px;background:#fff;color:#374151;border:1.5px solid #D1D5DB;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer">
            <i class="fas fa-rotate-left"></i> 공통을 기본 ${WT_PRESET_CORE.length}열로
          </button>
          <button onclick="wtLoadSuggested()" style="padding:7px 13px;background:#EFF6FF;color:#1D4ED8;border:1.5px solid #BFDBFE;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer">
            <i class="fas fa-wand-magic-sparkles"></i> 통계에서 불러오기
          </button>
          <span style="font-size:.73rem;color:var(--t3)">둘 다 <b>공통 열</b>만 통째로 바꿉니다(채널·유형 열은 그대로).</span>
        </div>

        <div style="margin-top:14px">
          <div style="font-size:.82rem;font-weight:700;margin-bottom:4px">템플릿 시트 <span style="font-weight:500;color:var(--t3)">— 선택</span></div>
          <p style="font-size:.75rem;color:var(--t3);margin:0 0 6px;line-height:1.6">
            작업표를 만들 때 <b>서식·상단 공지문을 가져올 원본 시트</b>입니다. 비워 두면 서식 없이 열·행만 만듭니다.
            시트 주소를 그대로 붙여넣어도 됩니다.
          </p>
          <input type="text" id="wtTplSheet" placeholder="https://docs.google.com/spreadsheets/d/... (비워 두면 서식 없음)"
            style="width:100%;max-width:620px;padding:7px 10px;border:1.5px solid #D1D5DB;border-radius:8px;font-size:.82rem;outline:none">
        </div>

        <div style="font-size:.8rem;font-weight:700;margin:14px 0 5px">공통 열 상세 <span style="font-weight:500;color:var(--t3)">— 시스템 인식과 구매양식 제출값 매칭 (순서·빼기는 위 미리보기에서)</span></div>
        <div id="wtColList" class="as-wtlist"><div class="as-wtempty">불러오는 중…</div></div>

        <div style="display:flex;gap:8px;align-items:center;margin-top:14px">
          <button onclick="wtSaveTemplate()"
            style="padding:8px 18px;background:var(--p);color:#fff;border:none;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer">
            <i class="fas fa-save"></i> 저장
          </button>
          <span id="wtSaveHint" style="font-size:.74rem;color:var(--t3)"></span>
        </div>

        <div style="margin-top:20px;border-top:1px dashed #E5E7EB;padding-top:14px">
          <button onclick="wtToggleReport()" id="wtReportBtn"
            style="padding:7px 14px;background:#fff;color:#374151;border:1.5px solid #D1D5DB;border-radius:8px;font-size:.82rem;font-weight:600;cursor:pointer">
            <i class="fas fa-chart-simple"></i> 헤더 학습 리포트 펼치기
          </button>
          <div id="wtReport" style="display:none;margin-top:12px"></div>
        </div>`;
}

/* ── 코어 열 목록 렌더 ── */
/* ── 열 구성 한 줄 미리보기 = 공통 열 조절 창구 ──────────────
   "이름 블록"만 보면 작업표가 실제로 어떤 표가 되는지 안 그려진다 → 공통 행 바로 아래에
   **표 머리 축소판**을 한 줄로 깐다(칸 = 열 하나, 순서 = 실제 생성 순서).
   ★★ 공통 열의 순서·빼기는 **여기서만** 조절한다(사용자 확정 — 종전엔 공통 행 칩·상세 목록·
     미리보기 세 곳이 같은 배열을 그렸고 그중 둘이 편집까지 돼 창구가 갈렸다).
     칸을 누르면 선택 → 아래 툴바(◀ ▶ ✕)로 조절. 편집 자체는 기존 단일 경로
     wtChMove/wtChDel('core')로 위임한다(경로 사본 금지).
   ★ 한 줄에 전부 들어오게 한다: 칸은 min-width:0 압축 + 넘치는 이름은 말줄임 +
     title 에 전체 이름(가로 스크롤·줄바꿈 없음 = 한눈에). 툴바는 줄 아래 별도 행.
   ★ 데이터 출처는 _wtTpl.columns 하나 — 아래 '공통 열 상세'와 **같은 배열**을 본다
     (사본을 만들면 미리보기와 목록이 서로 다른 순서를 보여준다).
   ★ 칸 클릭은 **인덱스만** 넘긴다(onclick 문자열에 열 이름 금지 — 따옴표 탈출 차단).
   ★ 채널 열은 채널마다 달라 특정 채널을 고를 수 없다 → 끝에 점선 '＋채널' 칸으로 "여기에
     그 채널 열이 덧붙는다"만 알린다(틀린 채널을 그리느니 자리만 표시). */
var _wtPvSel = null;    // 미리보기에서 선택된 칸 인덱스(합성 목록 기준, null=선택 없음)
var _wtPvChan = '';     // 미리보기에 얹은 채널('' = 공통만)
var _wtPvTypes = [];    // 미리보기에 켠 작업유형 키들

/* ══════════════════════════════════════════════════════════════
   ★★ 합성 규칙 = 서버 `worktablePlan.buildColumns` 와 **같은 순서**여야 한다
   ──────────────────────────────────────────────────────────────
   순서 = [공통 앞머리 자동 열] + [앞쪽 유형] + [나머지 공통] + [채널] + [뒤쪽 유형],
   이미 담긴 이름(대소문자 무시)은 건너뛴다. 화면이 즉시(저장 전에도) 그려야 해서 여기서
   계산하지만, **회귀가드가 서버 buildColumns 와 결과 순서를 대조**해 드리프트를 막는다.
   ★ 저장 전 새로 담은 열은 아직 분류(tier)가 없어 자동 열 앞머리 판정만 잠깐 달라질 수 있다
     — 저장하면 서버 분류가 내려와 일치한다(그 외 순서 규칙은 동일).
   ══════════════════════════════════════════════════════════════ */
function _wtMergeCols(chanKey, typeKeys) {
  var colsByName = {};
  ((_wtTpl && _wtTpl.columns) || []).forEach(function (c) { colsByName[c.name.toLowerCase()] = c; });
  Object.keys((_wtTpl && _wtTpl.channelColumns) || {}).forEach(function (k) {
    (_wtTpl.channelColumns[k] || []).forEach(function (c) { if (!colsByName[c.name.toLowerCase()]) colsByName[c.name.toLowerCase()] = c; });
  });
  Object.keys((_wtTpl && _wtTpl.workTypeColumns) || {}).forEach(function (k) {
    (_wtTpl.workTypeColumns[k] || []).forEach(function (c) { if (!colsByName[c.name.toLowerCase()]) colsByName[c.name.toLowerCase()] = c; });
  });

  var core = (_wtTpl && _wtTpl.core) || [];
  var coreCols = (_wtTpl && _wtTpl.columns) || [];
  var chan = chanKey ? _wtListFor(chanKey) : [];
  var wanted = {};
  (typeKeys || []).forEach(function (k) { wanted[k] = 1; });
  var front = [], back = [];
  _wtTypes().forEach(function (t) {
    if (!wanted[t.key]) return;
    (t.columns || []).forEach(function (n) {
      (t.position === 'front' ? front : back).push({ name: n, list: 'wt:' + t.key });
    });
  });

  // 공통의 앞머리 자동 열(번호·구매일자) 개수 — 앞쪽 유형은 그 뒤에 온다.
  var autoPrefix = 0;
  while (autoPrefix < coreCols.length && coreCols[autoPrefix] && coreCols[autoPrefix].tier === 'auto') autoPrefix++;

  var seen = {}, out = [];
  var push = function (name, list, origin) {
    var k = String(name).toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    var meta = colsByName[k] || { name: name, role: null, label: null, tier: null };
    out.push({ name: name, role: meta.role, label: meta.label, tier: meta.tier,
      duplicateRole: !!meta.duplicateRole, pending: !!meta.pending, list: list, origin: origin,
      idx: _wtListFor(list).indexOf(name) });
  };
  core.slice(0, autoPrefix).forEach(function (n) { push(n, 'core', 'common'); });
  front.forEach(function (c) { push(c.name, c.list, 'worktype'); });
  core.slice(autoPrefix).forEach(function (n) { push(n, 'core', 'common'); });
  chan.forEach(function (n) { push(n, chanKey, 'channel'); });
  back.forEach(function (c) { push(c.name, c.list, 'worktype'); });
  return out;
}

/* ── 채널·작업유형 알약 줄 (시안 B) ────────────────────────────
   ★ 한 줄에 그 종류를 다루는 모든 것이 있다: 고르기(알약) · 관리(⚙) · 추가(＋).
   ★ 삭제·이름변경은 알약에 붙이지 않는다 — [⚙ 관리] 안에서만(오클릭 방지, 사용자 확정 B). */
function _wtRenderPills() {
  var box = document.getElementById('wtPills');
  if (!box) return;
  var chan = '<div class="as-wtpillrow"><span class="pl">채널</span>' +
    '<button class="as-wtpvp' + (_wtPvChan ? '' : ' on') + '" onclick="wtPvChan(\'\')">기본(공통만)</button>' +
    _wtChannels().map(function (c) {
      return '<button class="as-wtpvp' + (_wtPvChan === c.key ? ' on' : '') + '" onclick="wtPvChan(\'' + c.key + '\')">' +
        c.emoji + ' ' + escHtml(c.label) + '</button>';
    }).join('') +
    '<span class="sp"></span>' +
    '<button class="as-wtpvp gear" onclick="wtOpenChanMgr()" title="직접 추가한 채널 이름 변경·삭제">⚙ 채널 관리</button>' +
    '<button class="as-wtpvp addp" onclick="wtAddChannel()">＋ 작업채널 추가</button>' +
    '</div>';
  var types = _wtTypes();
  var tp = '<div class="as-wtpillrow"><span class="pl">작업유형</span>' +
    (types.length
      ? types.map(function (t) {
          return '<button class="as-wtpvp t' + (_wtPvTypes.indexOf(t.key) >= 0 ? ' on' : '') +
            '" onclick="wtPvType(\'' + t.key + '\')" title="' +
            escHtml((t.desc || '') + (t.desc ? ' · ' : '') + '자동 선택: ' + _wtTriggerLabel(t.autoTrigger)) + '">' +
            escHtml(t.label) + '</button>';
        }).join('')
      : '<span class="as-wtchnone">아직 없습니다 — 상품옵션·택배발송대행처럼 그 작업일 때만 붙는 열 묶음을 만듭니다</span>') +
    '<span class="sp"></span>' +
    (types.length ? '<button class="as-wtpvp gear" onclick="wtOpenTypeMgr()" title="작업유형 고치기·삭제">⚙ 유형 관리</button>' : '') +
    '<button class="as-wtpvp addp" onclick="wtOpenTypeModal()">＋ 작업유형 추가</button>' +
    '</div>';
  box.innerHTML = chan + tp + '<div id="wtMgrPop"></div>';
}

function _wtRenderPreview() {
  var box = document.getElementById('wtPreview');
  if (!box) return;
  // 지워진 채널·유형을 보고 있었으면 기본으로 되돌린다(없는 것을 그리지 않는다).
  if (_wtPvChan && !_wtChannels().some(function (c) { return c.key === _wtPvChan; })) _wtPvChan = '';
  _wtPvTypes = _wtPvTypes.filter(function (k) { return _wtTypes().some(function (t) { return t.key === k; }); });

  _wtRenderPills();
  var cols = _wtMergeCols(_wtPvChan, _wtPvTypes);
  if (_wtPvSel != null && (_wtPvSel < 0 || _wtPvSel >= cols.length)) _wtPvSel = null;
  /* ★ [＋ 열 추가] 는 **열이 하나도 없을 때도** 있어야 한다 — 없으면 처음 담을 방법이 사라진다
     (종전엔 행마다 입력칸이 있었지만 시안 B 는 여기가 유일한 창구다). */
  var addCell = '<span class="as-wtpvc addcell" onclick="wtAddOpen()" title="지금 보고 있는 구성에 열을 담습니다">＋ 열 추가</span>';
  if (!cols.length) {
    _wtPvSel = null;
    box.innerHTML =
      '<div class="as-wtpvh">작업표 미리보기 <span>— 아직 담긴 열이 없습니다</span></div>' +
      '<div class="as-wtpvrow">' + addCell + '</div>' +
      '<div class="as-wtpvempty">오른쪽 <b>[＋ 열 추가]</b> 로 담거나, 아래 <b>[공통을 기본 열로]</b> 를 눌러 시작하세요.</div>' +
      '<div id="wtAddPop"></div>';
    _wtRenderAddPop();
    return;
  }
  var ORIGIN = { common: '공통 열', channel: '채널 열', worktype: '작업유형 열' };
  var cells = cols.map(function (c, i) {
    var tier = String(c.tier || '') || (c.role ? 'core' : '');
    var tip = c.name + ' · ' + ORIGIN[c.origin] +
      (c.role ? ' · 시스템 인식: ' + (c.label || c.role) : ' · 제출이 값을 쓰지 않는 열');
    return '<span class="as-wtpvc' + (tier ? ' ' + tier : '') + ' o-' + c.origin + (c.duplicateRole ? ' dup' : '') +
      (i === _wtPvSel ? ' sel' : '') + '" onclick="wtPvSel(' + i + ')" title="' +
      escHtml(String(i + 1) + '. ' + tip + ' · 클릭하면 순서·빼기 조절') + '">' + escHtml(c.name) + '</span>';
  }).join('');
  var tool = '';
  if (_wtPvSel != null) {
    var s = cols[_wtPvSel];
    // ★ 이동은 **같은 묶음 안에서만** — 공통 열을 채널 자리로 옮길 수는 없다(묶음이 곧 소속).
    var sib = cols.map(function (c, i) { return c.list === s.list ? i : -1; }).filter(function (i) { return i >= 0; });
    var first = sib[0] === _wtPvSel, last = sib[sib.length - 1] === _wtPvSel;
    tool = '<div class="as-wtpvtool">' +
      '<b>' + (_wtPvSel + 1) + '. ' + escHtml(s.name) + '</b>' +
      '<span class="m">' + ORIGIN[s.origin] + ' · ' +
        (s.role ? '시스템 인식: ' + escHtml(s.label || s.role) : '제출이 값을 쓰지 않는 열') + '</span>' +
      '<button onclick="wtPvMove(-1)" title="왼쪽으로"' + (first ? ' disabled' : '') + '>◀ 왼쪽</button>' +
      '<button onclick="wtPvMove(1)" title="오른쪽으로"' + (last ? ' disabled' : '') + '>오른쪽 ▶</button>' +
      '<button class="x" onclick="wtPvDel()" title="이 묶음에서 빼기">✕ 빼기</button>' +
      '<button class="c" onclick="wtPvSel(-1)" title="선택 해제">닫기</button>' +
      '</div>';
  }
  var chanName = _wtPvChan ? (_wtChannels().filter(function (c) { return c.key === _wtPvChan; })[0] || {}).label : '';
  var sum = '공통 ' + ((_wtTpl && _wtTpl.core) || []).length + '열' +
    (chanName ? ' + ' + escHtml(chanName) : '') +
    (_wtPvTypes.length ? ' + 유형 ' + _wtPvTypes.length + '종' : '') +
    ' = 모두 ' + cols.length + '열';
  box.innerHTML =
    '<div class="as-wtpvh">작업표 미리보기 <span>— ' + sum + ' · 칸 순서가 실제 생성 순서 · 칸을 누르면 순서·빼기 조절</span></div>' +
    '<div class="as-wtpvrow">' + cells + addCell + '</div>' + tool +
    '<div id="wtAddPop"></div>';
  _wtRenderAddPop();
}
/** 미리보기 칸 선택 토글(-1 또는 같은 칸 재클릭 = 해제). 조절은 아래 wtPvMove/wtPvDel. */
function wtPvSel(i) {
  _wtPvSel = (i == null || i < 0 || i === _wtPvSel) ? null : i;
  _wtRenderPreview();
}
/** 채널 알약 — 그 채널 열이 합쳐진 완성 양식을 보여준다(같은 알약 재클릭 = 기본으로). */
function wtPvChan(key) {
  _wtPvChan = (_wtPvChan === key) ? '' : String(key || '');
  _wtPvSel = null;
  _wtRenderPreview();
}
/** 작업유형 알약 — 다중 토글(켠 유형의 열이 합쳐진다). */
function wtPvType(key) {
  var i = _wtPvTypes.indexOf(key);
  if (i >= 0) _wtPvTypes.splice(i, 1); else _wtPvTypes.push(key);
  _wtPvSel = null;
  _wtRenderPreview();
}
/** 선택 열 이동 — 기존 단일 편집 경로(wtChMove)로 위임, 선택은 이동한 열을 따라간다.
    ★ 합성 목록의 인덱스가 아니라 **그 묶음 안의 인덱스**로 옮긴다(묶음이 곧 저장 배열). */
function wtPvMove(dir) {
  if (_wtPvSel == null || !_wtTpl) return;
  var cols = _wtMergeCols(_wtPvChan, _wtPvTypes);
  var s = cols[_wtPvSel];
  if (!s) return;
  var arr = _wtListFor(s.list);
  var j = s.idx + dir;
  if (s.idx < 0 || j < 0 || j >= arr.length) return;
  wtChMove(s.list, s.idx, dir);
  // 옮긴 뒤 그 열이 있는 자리를 다시 찾아 선택을 따라가게 한다(합성 위치는 묶음마다 달라진다).
  var after = _wtMergeCols(_wtPvChan, _wtPvTypes);
  for (var i = 0; i < after.length; i++) if (after[i].name === s.name) { _wtPvSel = i; break; }
  _wtRenderPreview();
}
/** 선택 열 빼기 — 기존 단일 편집 경로(wtChDel)로 위임. */
function wtPvDel() {
  if (_wtPvSel == null) return;
  var cols = _wtMergeCols(_wtPvChan, _wtPvTypes);
  var s = cols[_wtPvSel];
  _wtPvSel = null;
  if (!s || s.idx < 0) { _wtRenderPreview(); return; }
  wtChDel(s.list, s.idx);
}

/* ══════════════════════════════════════════════════════════════
   ★ 열 담기 — 미리보기 오른쪽 끝 [＋ 열 추가] → 팝오버 (시안 B · 사용자 확정)
   ──────────────────────────────────────────────────────────────
   입력창과 "지금 쓰는 열" 후보가 **한 창에 함께** 나온다(▼를 눌러야 목록이 있는 걸 몰라도 됨).
   ★ 담을 곳은 **지금 보고 있는 구성**에서 고른다 — 알약이 켜진 것들만 후보로 보여 주고,
     하나뿐이면 그것으로, 여럿이면 사람이 고른다(조용히 추측하지 않는다).
   ══════════════════════════════════════════════════════════════ */
var _wtAddOpen = false;    // 팝오버 열림
var _wtAddTo = 'core';     // 담을 곳(list key: 'core' | 채널키 | 'wt:<유형키>')

/** 지금 담을 수 있는 곳들 — 공통은 항상, 켠 채널·유형이 있으면 함께. */
function _wtAddTargets() {
  var out = [{ key: 'core', label: '🌐 공통', sub: '모든 작업표' }];
  if (_wtPvChan) {
    var c = _wtChannels().filter(function (x) { return x.key === _wtPvChan; })[0];
    if (c) out.push({ key: c.key, label: c.emoji + ' ' + c.label, sub: '이 채널일 때만' });
  }
  _wtPvTypes.forEach(function (k) {
    var t = _wtTypes().filter(function (x) { return x.key === k; })[0];
    if (t) out.push({ key: 'wt:' + t.key, label: '🎛 ' + t.label, sub: '이 유형일 때만' });
  });
  return out;
}
function wtAddOpen() {
  var t = _wtAddTargets();
  // 켠 것이 하나면 그곳, 여럿이면 가장 구체적인 것(마지막)을 기본 선택 — 바꿀 수 있게 칩으로 보여 준다.
  if (!t.some(function (x) { return x.key === _wtAddTo; })) _wtAddTo = t.length > 1 ? t[t.length - 1].key : 'core';
  _wtAddOpen = true;
  _wtRenderAddPop(true);
}
function wtAddClose() { _wtAddOpen = false; _wtRenderAddPop(); }
function wtAddTarget(key) { _wtAddTo = String(key); _wtRenderAddPop(); }

async function _wtRenderAddPop(focus) {
  var box = document.getElementById('wtAddPop');
  if (!box) return;
  if (!_wtAddOpen) { box.innerHTML = ''; return; }
  var targets = _wtAddTargets();
  var cur = targets.filter(function (x) { return x.key === _wtAddTo; })[0] || targets[0];
  box.innerHTML =
    '<div class="as-wtpop">' +
      '<div class="as-wtpoph">담을 곳 <b>' + escHtml(cur.label) + '</b> <span>' + escHtml(cur.sub) + '</span>' +
        '<button class="as-wtpopx" onclick="wtAddClose()">닫기</button></div>' +
      (targets.length > 1
        ? '<div class="as-wtpoptg">' + targets.map(function (t) {
            return '<button class="as-wtpvp' + (t.key === _wtAddTo ? ' on' : '') + '" onclick="wtAddTarget(\'' + t.key + '\')">' +
              escHtml(t.label) + '</button>';
          }).join('') + '</div>'
        : '') +
      '<div class="as-wtpopin">' +
        '<input type="text" id="wtAddInput" maxlength="40" placeholder="열 이름을 적거나 아래에서 고르세요" ' +
          'oninput="_wtAddFilter()" onkeydown="if(event.key===\'Enter\'){event.preventDefault();wtAddSubmit();}' +
          'if(event.key===\'Escape\'){wtAddClose();}">' +
        '<button class="as-wtpopadd" onclick="wtAddSubmit()">담기</button>' +
      '</div>' +
      '<div id="wtAddCands" class="as-wtpicklist"><div class="as-wtpicknone">불러오는 중…</div></div>' +
      '<div class="as-wtpopfoot">우리 시트에서 지금 쓰는 이름입니다. 숫자 = 그 이름을 쓰는 탭 수 · 이미 담긴 이름은 ✓</div>' +
    '</div>';
  if (focus) { var el = document.getElementById('wtAddInput'); if (el) el.focus(); }
  try {
    await _wtEnsureStats();
    _wtBuildCandidates();
    _wtRenderCands();
  } catch (e) {
    var c = document.getElementById('wtAddCands');
    if (c) c.innerHTML = '<div class="as-wtpicknone">후보 목록을 불러오지 못했습니다: ' + escHtml(e.message) + ' — 이름을 직접 적어 담으세요.</div>';
  }
}
function _wtAddFilter() { _wtRenderCands(); }
/** 후보 칩 — ★ 클릭은 **인덱스**로 넘긴다(onclick 문자열에 시트에서 온 이름을 넣지 않는다). */
function _wtRenderCands() {
  var box = document.getElementById('wtAddCands');
  if (!box || !_wtCand) return;
  var inp = document.getElementById('wtAddInput');
  var q = inp ? String(inp.value || '').trim().toLowerCase() : '';
  var have = {};
  (_wtListFor(_wtAddTo) || []).forEach(function (n) { have[String(n).toLowerCase()] = 1; });
  var hits = [];
  _wtCand.forEach(function (c, i) { if (!q || c.name.toLowerCase().indexOf(q) >= 0) hits.push({ c: c, i: i }); });
  var shown = hits.slice(0, 40);
  if (!shown.length) {
    box.innerHTML = '<div class="as-wtpicknone">일치하는 열이 없습니다. 새 이름이면 [담기]로 그대로 추가하세요.</div>';
    return;
  }
  box.innerHTML = shown.map(function (h) {
    var dup = !!have[h.c.name.toLowerCase()];
    return '<button class="as-wtpickchip' + (dup ? ' dup' : '') + '"' + (dup ? ' disabled' : '') +
      ' onclick="wtAddPick(' + h.i + ')"' +
      ' title="' + escHtml(h.c.label ? '시스템 인식: ' + h.c.label : '시스템이 값을 쓰지 않는 열') + '">' +
      (dup ? '<i class="as-wtpickok">✓</i>' : '') +
      escHtml(h.c.name) + '<i class="as-wtpickn">' + h.c.count + '</i></button>';
  }).join('');
}
/** 후보 클릭 = 바로 담기(창은 열린 채 — 연속으로 여러 개 담기 좋게). */
function wtAddPick(idx) {
  if (!_wtCand || !_wtCand[idx]) return;
  wtChAdd(_wtAddTo, _wtCand[idx].name);
  _wtRenderCands();
}
function wtAddSubmit() {
  var inp = document.getElementById('wtAddInput');
  var name = inp ? String(inp.value || '').trim() : '';
  if (!name) return;
  wtChAdd(_wtAddTo, name);
  if (inp) { inp.value = ''; inp.focus(); }
  _wtRenderCands();
}

/* ══════════════════════════════════════════════════════════════
   ★ [⚙ 관리] — 삭제·이름변경은 여기 안에서만 (시안 B · 오클릭 방지)
   ══════════════════════════════════════════════════════════════ */
function _wtMgrClose() { var b = document.getElementById('wtMgrPop'); if (b) b.innerHTML = ''; }
function wtOpenChanMgr() {
  var box = document.getElementById('wtMgrPop');
  if (!box) return;
  if (box.dataset.kind === 'chan' && box.innerHTML) { box.dataset.kind = ''; return _wtMgrClose(); }
  box.dataset.kind = 'chan';
  var rows = _wtChannels().map(function (c) {
    var n = (_wtListFor(c.key) || []).length;
    return '<div class="as-wtmgrrow' + (c.custom ? '' : ' fixed') + '">' +
      '<span class="nm">' + c.emoji + ' ' + escHtml(c.label) + '</span>' +
      '<span class="cnt">' + (n ? n + '열' : '열 없음') + '</span>' +
      (c.custom
        ? '<button onclick="wtRenameChannel(\'' + c.key + '\')">이름 변경</button>' +
          '<button class="del" onclick="wtDelChannel(\'' + c.key + '\')">삭제</button>'
        : '<span class="fx">기본 채널 · 지울 수 없음</span>') +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="as-wtpop mgr"><div class="as-wtpoph">채널 관리 <span>직접 추가한 채널만 고치거나 지울 수 있습니다</span>' +
    '<button class="as-wtpopx" onclick="wtOpenChanMgr()">닫기</button></div>' + rows + '</div>';
}
function wtOpenTypeMgr() {
  var box = document.getElementById('wtMgrPop');
  if (!box) return;
  if (box.dataset.kind === 'type' && box.innerHTML) { box.dataset.kind = ''; return _wtMgrClose(); }
  box.dataset.kind = 'type';
  var rows = _wtTypes().map(function (t) {
    var n = (t.columns || []).length;
    return '<div class="as-wtmgrrow">' +
      '<span class="nm">🎛 ' + escHtml(t.label) + (t.desc ? ' <i>' + escHtml(t.desc) + '</i>' : '') + '</span>' +
      '<span class="cnt">' + (n ? n + '열 · ' + (t.position === 'front' ? '앞쪽' : '뒤쪽') : '열 없음') + '</span>' +
      '<span class="cnt">자동: ' + escHtml(_wtTriggerLabel(t.autoTrigger)) + '</span>' +
      '<button onclick="wtOpenTypeModal(\'' + t.key + '\')">고치기</button>' +
      '<button class="del" onclick="wtDelType(\'' + t.key + '\')">삭제</button>' +
      '</div>';
  }).join('');
  box.innerHTML = '<div class="as-wtpop mgr"><div class="as-wtpoph">작업유형 관리 <span>이름·설명·자리·자동 선택 조건을 고칩니다</span>' +
    '<button class="as-wtpopx" onclick="wtOpenTypeMgr()">닫기</button></div>' + (rows || '<div class="as-wtpicknone">아직 없습니다.</div>') + '</div>';
}

/* ── 작업채널 추가·이름변경·삭제 ─────────────────────────────
   ★ 키는 **서버가 발급**한다(저장 시) — 화면은 임시 키만 붙이고 저장 응답의 키로 교체된다.
     임시 키를 그대로 두면 저장 전후로 키가 달라져 그 행에 담은 열이 고아가 된다. */
function wtAddChannel() {
  if (!_wtTpl) return;
  var name = (prompt('추가할 작업채널 이름을 입력하세요 (예: 지마켓)') || '').trim();
  if (!name) return;
  if (_wtChannels().some(function (c) { return c.label.toLowerCase() === name.toLowerCase(); })) {
    showToast('이미 있는 채널입니다', true); return;
  }
  if (!_wtTpl.customChannels) _wtTpl.customChannels = [];
  _wtTpl.customChannels.push({ key: 'new' + (_wtTpl.customChannels.length + 1), label: name });
  _wtDirty(true); _wtRenderPreview();
  showToast('"' + name + '" 채널을 추가했습니다 — 알약에서 고르고 열을 담으세요');
}
function wtRenameChannel(key) {
  if (!_wtTpl) return;
  var c = (_wtTpl.customChannels || []).filter(function (x) { return x.key === key; })[0];
  if (!c) return;   // ★ 기본 4채널은 이름도 바꾸지 않는다(다른 기능과 짝을 이루는 표기)
  var name = (prompt('채널 이름을 바꿉니다', c.label) || '').trim();
  if (!name || name === c.label) return;
  if (_wtChannels().some(function (x) { return x.key !== key && x.label.toLowerCase() === name.toLowerCase(); })) {
    showToast('이미 있는 채널 이름입니다', true); return;
  }
  c.label = name;
  _wtDirty(true); _wtRenderPreview(); wtOpenChanMgr(); wtOpenChanMgr();
}
function wtDelChannel(key) {
  if (!_wtTpl) return;
  var c = _wtChannels().filter(function (x) { return x.key === key; })[0];
  if (!c || !c.custom) return;   // ★ 기본 4채널은 삭제 불가(다른 기능과 짝을 이룬다)
  var n = (_wtListFor(key) || []).length;
  if (!confirm('"' + c.label + '" 채널' + (n ? '과 그 열 ' + n + '개 구성' : '') + '을 삭제할까요?\n이미 만들어진 시트에는 영향이 없습니다(설정만 지워집니다).')) return;
  _wtTpl.customChannels = (_wtTpl.customChannels || []).filter(function (x) { return x.key !== key; });
  if (_wtTpl.channels) delete _wtTpl.channels[key];
  if (_wtPvChan === key) _wtPvChan = '';
  _wtDirty(true); _wtRenderPreview(); _wtMgrClose();
}

/* ══════════════════════════════════════════════════════════════
   ★ 작업유형 만들기·고치기 모달 (시안 B · 사용자 확정)
   ──────────────────────────────────────────────────────────────
   브라우저 기본 입력창(prompt) 대신 이름·설명·자리·**자동 선택 조건**·열을 한 화면에서 정한다.
   ★ 자동 선택 조건 목록은 **서버가 내려 준 것**(`_wtTpl.triggers`)을 그대로 그린다 —
     판정은 서버 `worktablePlan.evalWorkTypeTrigger` 가 하므로 화면에 규칙 사본을 두지 않는다.
   ══════════════════════════════════════════════════════════════ */
var _wtTypeEdit = null;   // { key|null, label, desc, position, autoTrigger, columns[] }

function wtOpenTypeModal(key) {
  if (!_wtTpl) return;
  var t = key ? _wtTypes().filter(function (x) { return x.key === key; })[0] : null;
  _wtTypeEdit = t
    ? { key: t.key, label: t.label, desc: t.desc || '', position: t.position || 'back',
        autoTrigger: t.autoTrigger || 'auto', columns: (t.columns || []).slice() }
    : { key: null, label: '', desc: '', position: 'back', autoTrigger: 'auto', columns: [] };
  _wtMgrClose();
  _wtRenderTypeModal();
}
function wtCloseTypeModal() {
  _wtTypeEdit = null;
  var el = document.getElementById('wtTypeModal');
  if (el) el.remove();
}
function _wtTypeMount() {
  var el = document.getElementById('wtTypeModal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'wtTypeModal';
  el.className = 'as-wtmodalwrap';
  // ★ body 직속 — 설정 패널(스크롤 컨테이너) 안에 두면 오버레이가 화면 흐름에 섞인다(레포 실측 교훈).
  el.onclick = function (e) { if (e.target === el) wtCloseTypeModal(); };
  document.body.appendChild(el);
  return el;
}
function _wtRenderTypeModal() {
  var e = _wtTypeEdit;
  if (!e) return;
  var el = _wtTypeMount();
  /* ★★ 조건 목록은 서버가 내려 준다(규칙 사본 금지). 그런데 **못 받았을 때 그냥 그리면
     옵션 0개짜리 빈 드롭다운**이 되어 화면이 고장난 것처럼 보인다(백엔드 배포가 프론트보다
     늦으면 바로 이 상태 — 실제로 밟았다). → 조용히 비우지 말고 **말하고, 되살릴 길을 준다**:
     지금 값은 그대로 지키고(저장해도 조건이 날아가지 않는다) 셀렉트는 잠근 뒤 [다시 불러오기]. */
  var trigs = _wtTriggers();
  var trigMissing = !trigs.length;
  var trigOpts = trigMissing
    ? '<option value="' + escHtml(e.autoTrigger || 'auto') + '" selected>' +
        escHtml(_wtTriggerLabel(e.autoTrigger) || '지금 설정된 조건') + '</option>'
    : trigs.map(function (t) {
        return '<option value="' + escHtml(t.key) + '"' + (e.autoTrigger === t.key ? ' selected' : '') + '>' + escHtml(t.label) + '</option>';
      }).join('');
  var trigWarn = trigMissing
    ? '<span class="as-wtmodalwarn">조건 목록을 불러오지 못했습니다 — 서버가 아직 준비되지 않았을 수 있습니다(배포 직후). ' +
        '지금 설정은 그대로 유지되며, 나머지 항목은 정상 저장됩니다. ' +
        '<button type="button" onclick="wtReloadTriggers()">다시 불러오기</button></span>'
    : '';
  var cols = e.columns.length
    ? e.columns.map(function (n, i) {
        return '<span class="as-wtchip">' + escHtml(n) +
          '<button onclick="wtTypeColDel(' + i + ')" title="빼기">✕</button></span>';
      }).join('')
    : '<span class="as-wtchnone">아직 없습니다 — 아래에서 담으세요</span>';
  el.innerHTML =
    '<div class="as-wtmodal">' +
      '<div class="mh">🎛 ' + (e.key ? '작업유형 고치기' : '새 작업유형 만들기') +
        '<span style="flex:1"></span><button class="x" onclick="wtCloseTypeModal()">✕</button></div>' +
      '<div class="mb">' +
        '<div class="as-wtmodalnote">채널과 별개로 <b>그 작업일 때만 붙는 열 묶음</b>입니다. ' +
          '예) 옵션이 여러 개인 작업 → <b>옵션</b> 열, 택배를 대신 보내는 작업 → <b>택배송장번호</b> 열.</div>' +
        '<div class="fld"><label>유형 이름</label>' +
          '<input id="wtTypeName" maxlength="24" value="' + escHtml(e.label) + '" placeholder="예: 택배발송대행" oninput="_wtTypeSync()"></div>' +
        '<div class="fld"><label>언제 쓰나요? <i>(선택 — 고를 때 도움말로 보입니다)</i></label>' +
          '<input id="wtTypeDesc" maxlength="80" value="' + escHtml(e.desc) + '" placeholder="예: 실배송을 대행 발송하는 작업" oninput="_wtTypeSync()"></div>' +
        '<div class="fld"><label>열이 붙는 자리</label>' +
          '<div class="as-wtseg">' +
            '<button class="' + (e.position === 'front' ? 'on' : '') + '" onclick="wtTypePos(\'front\')">앞쪽 <i>구매일자 뒤</i></button>' +
            '<button class="' + (e.position === 'front' ? '' : 'on') + '" onclick="wtTypePos(\'back\')">뒤쪽 <i>맨 끝</i></button>' +
          '</div>' +
          '<span class="hint">옵션·리뷰형태처럼 작업지시는 앞쪽, 송장번호처럼 기록용은 뒤쪽이 보기 좋습니다</span></div>' +
        '<div class="fld"><label>자동 선택 조건 <i>— 작업오더가 이 조건이면 체크가 미리 켜집니다</i></label>' +
          '<select id="wtTypeTrig" onchange="_wtTypeSync()"' + (trigMissing ? ' disabled' : '') + '>' + trigOpts + '</select>' +
          trigWarn +
          '<span class="hint">예) 작업오더에 <b>쿠팡 + 상품옵션 2가지</b>면 채널은 쿠팡, 이 유형은 “상품옵션이 2가지 이상일 때”로 자동 선택됩니다. ' +
            '<b>확정은 작업표를 만드는 담당자</b>가 합니다.</span></div>' +
        '<div class="fld"><label>이 유형에 담을 열</label>' +
          '<div class="as-wtchsum" style="margin-bottom:6px">' + cols + '</div>' +
          '<div class="as-wtpopin">' +
            '<input id="wtTypeCol" maxlength="40" placeholder="열 이름" ' +
              'onkeydown="if(event.key===\'Enter\'){event.preventDefault();wtTypeColAdd();}">' +
            '<button class="as-wtpopadd" onclick="wtTypeColAdd()">＋ 담기</button>' +
          '</div></div>' +
      '</div>' +
      '<div class="mf"><button class="pri" onclick="wtTypeSave()">' + (e.key ? '저장' : '만들기') + '</button>' +
        '<button onclick="wtCloseTypeModal()">취소</button>' +
        '<span style="flex:1"></span><span class="hint">만든 뒤 아래 [저장]을 눌러야 보관됩니다</span></div>' +
    '</div>';
  var f = document.getElementById('wtTypeName');
  if (f && !e.label) f.focus();
}
/** 조건 목록만 다시 받아 온다 — ★ 모달의 편집 중 값(`_wtTypeEdit`)은 건드리지 않는다.
    ★ 저장하지 않은 다른 변경이 있으면 먼저 알린다(설정을 다시 받으면 그 변경이 사라진다). */
async function wtReloadTriggers() {
  var hint = document.getElementById('wtSaveHint');
  var dirty = !!(hint && hint.textContent);
  if (dirty && !confirm('설정을 다시 불러옵니다.\n저장하지 않은 다른 변경(열 담기 등)은 사라집니다.\n계속할까요?')) return;
  try {
    await loadWorktableTemplate();
    _wtRenderTypeModal();
    showToast(_wtTriggers().length ? '조건 목록을 불러왔습니다' : '아직 불러오지 못했습니다 — 잠시 후 다시 시도해 주세요', !_wtTriggers().length);
  } catch (err) { showToast('불러오기 실패: ' + err.message, true); }
}

/** 입력값을 편집 중 객체에 담는다(다시 그릴 때 값이 날아가지 않게 — 한 벌로 읽는다). */
function _wtTypeSync() {
  if (!_wtTypeEdit) return;
  var g = function (id) { return document.getElementById(id); };
  if (g('wtTypeName')) _wtTypeEdit.label = String(g('wtTypeName').value || '').trim();
  if (g('wtTypeDesc')) _wtTypeEdit.desc = String(g('wtTypeDesc').value || '').trim();
  // ★ 목록을 못 받아 잠긴 상태에서는 읽지 않는다 — 읽으면 지금 설정이 그대로 다시 쓰이긴 하나,
  //   의도치 않게 값을 건드리는 경로를 아예 만들지 않는다.
  if (g('wtTypeTrig') && !g('wtTypeTrig').disabled) _wtTypeEdit.autoTrigger = g('wtTypeTrig').value;
}
function wtTypePos(p) { if (!_wtTypeEdit) return; _wtTypeSync(); _wtTypeEdit.position = (p === 'front' ? 'front' : 'back'); _wtRenderTypeModal(); }
function wtTypeColAdd() {
  if (!_wtTypeEdit) return;
  _wtTypeSync();
  var inp = document.getElementById('wtTypeCol');
  var name = inp ? String(inp.value || '').trim() : '';
  if (!name) return;
  if (_wtTypeEdit.columns.some(function (n) { return n.toLowerCase() === name.toLowerCase(); })) { showToast('이미 담은 열입니다', true); return; }
  // ★ 공통에 있는 열은 유형에 또 담지 못한다(작업표에 같은 열 2번 생성 차단 — 담기 경로 공통 규칙).
  if (((_wtTpl && _wtTpl.core) || []).some(function (n) { return n.toLowerCase() === name.toLowerCase(); })) {
    showToast('"' + name + '" 은(는) 이미 공통 열입니다 — 모든 작업표에 들어갑니다', true); return;
  }
  _wtTypeEdit.columns.push(name);
  _wtRenderTypeModal();
}
function wtTypeColDel(i) { if (!_wtTypeEdit) return; _wtTypeSync(); _wtTypeEdit.columns.splice(i, 1); _wtRenderTypeModal(); }
function wtTypeSave() {
  if (!_wtTpl || !_wtTypeEdit) return;
  _wtTypeSync();
  var e = _wtTypeEdit;
  if (!e.label) { showToast('유형 이름을 적어 주세요', true); return; }
  if (_wtTypes().some(function (t) { return t.key !== e.key && t.label.toLowerCase() === e.label.toLowerCase(); })) {
    showToast('이미 있는 작업유형 이름입니다', true); return;
  }
  if (!_wtTpl.workTypes) _wtTpl.workTypes = [];
  if (e.key) {
    var t = _wtTypes().filter(function (x) { return x.key === e.key; })[0];
    if (t) { t.label = e.label; t.desc = e.desc; t.position = e.position; t.autoTrigger = e.autoTrigger; t.columns = e.columns.slice(); }
  } else {
    // 화면 임시 키 — 저장하면 서버가 정식 키(`t1`…)를 발급해 되돌려준다.
    _wtTpl.workTypes.push({ key: 'new' + (_wtTpl.workTypes.length + 1), label: e.label, desc: e.desc,
      position: e.position, autoTrigger: e.autoTrigger, columns: e.columns.slice() });
  }
  wtCloseTypeModal();
  _wtDirty(true); _wtRenderPreview();
  showToast('"' + e.label + '" 유형을 ' + (e.key ? '고쳤습니다' : '만들었습니다') + ' — 아래 [저장]을 눌러 보관하세요');
}
function wtDelType(key) {
  if (!_wtTpl) return;
  var t = _wtTypes().filter(function (x) { return x.key === key; })[0];
  if (!t) return;
  var n = (t.columns || []).length;
  if (!confirm('"' + t.label + '" 작업유형' + (n ? '과 그 열 ' + n + '개 구성' : '') + '을 삭제할까요?\n이미 만들어진 시트에는 영향이 없습니다(설정만 지워집니다).')) return;
  _wtTpl.workTypes = _wtTypes().filter(function (x) { return x.key !== key; });
  _wtPvTypes = _wtPvTypes.filter(function (k) { return k !== key; });
  _wtDirty(true); _wtRenderPreview(); _wtMgrClose();
}

function _wtRenderCols() {
  /* 목차 배지는 여기서 갱신한다 — 로더에만 두면 열을 더하거나 뺀 뒤 숫자가 옛값에 머문다. */
  if (_wtTpl && _wtTpl.core) _setNavBadge('worktable', _wtTpl.core.length + '열', _wtTpl.core.length ? '' : 'warn');
  _wtRenderPreview();
  var box = document.getElementById('wtColList');
  if (!box) return;
  var cols = (_wtTpl && _wtTpl.columns) || [];
  if (!cols.length) {
    box.innerHTML = '<div class="as-wtempty">아직 정한 열이 없습니다. 위에서 <b>통계에서 불러오기</b>를 누르면 우리 시트들이 실제로 쓰는 열로 채워집니다.</div>';
    return;
  }
  /* ★ 읽기 전용 설명표 — 순서·빼기 버튼을 두지 않는다(조절 창구는 위 '작업표 미리보기' 하나,
     사용자 확정). 여기의 역할은 "이 열에 시스템이 무엇을 어떻게 넣는가"를 행마다 설명하는 것. */
  box.innerHTML = cols.map(function (c, i) {
    var note = c.role
      ? '<span class="as-wtrole">시스템 인식: ' + escHtml(c.label) + '</span>'
      : (c.pending
          ? '<span class="as-wtrole pending">저장하면 시스템 인식이 판정됩니다</span>'
          : '<span class="as-wtrole none">제출이 값을 쓰지 않는 열</span>');
    var warn = c.duplicateRole
      ? '<span class="as-wtwarn">⚠ 같은 역할의 열이 둘 이상 — 제출이 두 칸에 같은 값을 씁니다</span>' : '';
    /* 구매양식 제출값 매칭 — 문장은 서버 단일 출처(ROLE_META.fill)를 그대로 표시한다.
       역할 없는 열은 매칭 자체가 없다는 사실을 말한다(조용히 비워 두지 않는다). */
    var fillTxt = c.fill
      ? c.fill
      : (c.pending
          ? '저장하면 이 열이 구매양식의 어느 제출 항목과 매칭되는지 판정해 여기에 표시합니다'
          : '구매양식 제출 항목과 매칭되지 않습니다 — 상태 표시·관리자 기입용 칸이면 정상입니다');
    /* ★ 설명은 배지 오른쪽 같은 줄(사용자 확정 — 두 줄이면 행이 두꺼워져 훑기 어렵다).
       넘치는 문장은 말줄임하고 title 에 전체를 남긴다(미리보기 칸과 같은 규칙). */
    return '<div class="as-wtrow">' +
      '<span class="as-wtno">' + (i + 1) + '</span>' +
      '<span class="as-wtname">' + escHtml(c.name) + '</span>' +
      note + warn +
      '<span class="as-wtfill" title="' + escHtml(fillTxt) + '">' + escHtml(fillTxt) + '</span>' +
      '</div>';
  }).join('');
}

/* 편집은 이름 배열(_wtTpl.core)에 하고, 표시는 서버가 준 분류(columns)를 쓴다.
   ★ 저장 전 임시 편집분은 역할을 모르므로 role:null 로 두되 "저장하면 판정됩니다"로 안내한다
     — 프론트에 분류 규칙 사본을 두지 않기 위해서다(매퍼 파생 단일 출처 유지). */
function _wtSyncColumns() {
  var byName = {};
  ((_wtTpl && _wtTpl.columns) || []).forEach(function (c) { byName[c.name.toLowerCase()] = c; });
  _wtTpl.columns = (_wtTpl.core || []).map(function (n) {
    // pending = 아직 서버 판정 전(방금 담은 열) — "매칭 없음"과 구분해 안내한다.
    return byName[n.toLowerCase()] || { name: n, role: null, label: null, tier: null, fill: null, duplicateRole: false, pending: true };
  });
  _wtRenderCols();      // 내부에서 미리보기까지 다시 그린다(두 뷰, 한 벌의 데이터)
  _wtRenderChans();     // 🌐 공통 줄의 개수 요약
  _wtDirty(true);
}
function _wtDirty(on) {
  var h = document.getElementById('wtSaveHint');
  if (h) h.innerHTML = on ? '<b style="color:#B45309">저장하지 않은 변경이 있습니다</b>' : '';
}

/* 공통 열 추가 — 입력칸은 이제 '열 구성'의 공통 행에 있다(창구 하나).
   ★ 이름은 남긴다: 회귀가드·다른 호출부가 이 이름으로 묶여 있다. */
function wtAddCol(name) { return wtChAdd('core', name); }
function wtDelCol(i) { return wtChDel('core', i); }
function wtMoveCol(i, dir) { return wtChMove('core', i, dir); }

/* ── 채널별 추가 열 — 블록 편집 ──
   편집은 _wtTpl.channels[key] 배열에 직접 하고 저장 때 그대로 보낸다(쉼표 파싱 없음 —
   열 이름에 쉼표가 들어가도 안전하고, 화면에 보이는 블록이 곧 저장되는 값이다). */
function _wtListFor(key) {
  if (!_wtTpl) return [];
  if (key === 'core') return (_wtTpl.core || (_wtTpl.core = []));
  // 작업유형 행 — 키는 `wt:<유형키>`. 저장 배열은 그 유형의 columns 다.
  if (String(key).indexOf('wt:') === 0) {
    var t = _wtTypes().filter(function (x) { return x.key === String(key).slice(3); })[0];
    if (!t) return [];
    return (t.columns || (t.columns = []));
  }
  if (!_wtTpl.channels) _wtTpl.channels = {};
  return (_wtTpl.channels[key] || (_wtTpl.channels[key] = []));
}
/** 편집 뒤 갱신 — 공통은 상세 목록(역할·경고)까지 다시 그린다. */
function _wtAfterEdit(key) {
  if (key === 'core') _wtSyncColumns();   // 내부에서 요약 + 미리보기 + dirty 까지 수행
  else { _wtRenderChans(); _wtRenderPreview(); _wtDirty(true); }
}
function _wtAllRowKeys() {
  return ['core']
    .concat(_wtChannels().map(function (c) { return c.key; }))
    .concat(_wtTypes().map(function (t) { return 'wt:' + t.key; }));
}

/* 🌐 공통 줄 요약 — 지금 몇 열인지 알려 주는 자리(조절·담기는 미리보기에서). */
function _wtRenderChans() {
  if (!_wtTpl) return;
  var box = document.getElementById('wtChips_core');
  if (!box) return;
  var arr = _wtListFor('core');
  box.innerHTML = arr.length
    ? '<span class="as-wtchnone">공통 ' + arr.length + '열 — 담기·순서·빼기는 아래 <b>작업표 미리보기</b>에서</span>'
    : '<span class="as-wtchnone">공통 열이 없습니다 — 아래 <b>[＋ 열 추가]</b> 또는 [공통을 기본 열로]</span>';
}

/** 열 담기 단일 경로 — `name` 은 팝오버·모달이 넘긴다(행마다 있던 입력칸은 없어졌다). */
function wtChAdd(key, name) {
  if (!_wtTpl) return;
  name = String(name == null ? '' : name).trim();
  if (!name) return;
  var arr = _wtListFor(key);
  if (arr.some(function (n) { return n.toLowerCase() === name.toLowerCase(); })) { showToast('이미 있는 열입니다', true); return; }
  // ★ 공통에 이미 있는 열을 채널·유형에 또 넣으면 작업표에 같은 열이 두 번 생긴다.
  if (key !== 'core' && (_wtTpl.core || []).some(function (n) { return n.toLowerCase() === name.toLowerCase(); })) {
    showToast('"' + name + '" 은(는) 이미 공통 열입니다 — 모든 작업표에 들어갑니다', true); return;
  }
  arr.push(name);
  _wtAfterEdit(key);
}
function wtChDel(key, i) {
  if (!_wtTpl) return;
  var arr = _wtListFor(key);
  if (!arr[i]) return;
  arr.splice(i, 1);
  _wtAfterEdit(key);
}
function wtChMove(key, i, dir) {
  if (!_wtTpl) return;
  var arr = _wtListFor(key);
  var j = i + dir;
  if (j < 0 || j >= arr.length) return;
  var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  _wtAfterEdit(key);
}

/** 공통을 사용자 확정 기본 열로 되돌린다(채널 행은 건드리지 않는다). ★ `주문자` 는 제외 — 참여자 칸이 대체한다. */
function wtLoadPreset() {
  if (!_wtTpl) return;
  if ((_wtTpl.core || []).length && !confirm('공통 열을 기본 ' + WT_PRESET_CORE.length + '개로 바꿉니다. 채널별 열은 그대로 둡니다. 계속할까요?')) return;
  _wtTpl.core = WT_PRESET_CORE.slice();
  _wtSyncColumns();
  showToast('공통 열을 기본 ' + WT_PRESET_CORE.length + '개로 채웠습니다 — 확인 후 저장하세요');
}

/* ══════════════════════════════════════════════════════════════
   ★ "지금 쓰는 열에서 고르기" — 후보는 헤더 학습 리포트의 열들(사용자 확정)
   ──────────────────────────────────────────────────────────────
   손으로 타이핑하면 같은 뜻의 열이 조금씩 다른 이름으로 늘어난다('연락처'/'전화번호'/'핸드폰').
   실제로 우리 시트들이 쓰는 이름을 그대로 고르게 해서 표기를 모은다.
   ★ 자유 입력은 그대로 남긴다 — 새 열은 여전히 만들 수 있어야 한다(고르기는 보조 수단).
   ══════════════════════════════════════════════════════════════ */
var _wtCand = null;   // 후보 목록 캐시(사용 탭 수 내림차순) — 인덱스로 참조해 onclick 문자열 이스케이프를 피한다

async function _wtEnsureStats() {
  if (!_wtStats) { var j = await _wtFetch(WT_EP.stats); _wtStats = j.data || {}; }
  return _wtStats;
}

/** 리포트의 열들을 후보 한 벌로 모은다(역할 열 변형 + 미분류 열, 이름 기준 중복 제거). */
function _wtBuildCandidates() {
  var map = {};
  var put = function (name, count, meta) {
    if (!name) return;
    var k = String(name).toLowerCase();
    if (!map[k] || count > map[k].count) map[k] = { name: String(name), count: count || 0, role: meta.role, label: meta.label, freq: meta.freq };
  };
  ((_wtStats || {}).roles || []).forEach(function (r) {
    (r.headerVariants || []).forEach(function (v) {
      put(v.name, v.count, { role: r.role, label: r.label, freq: r.frequency });
    });
  });
  ((_wtStats || {}).unmapped || []).forEach(function (u) {
    put(u.name, u.tabCount, { role: null, label: null, freq: u.frequency });
  });
  _wtCand = Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  return _wtCand;
}

/* ★ 후보 목록·담기 창구는 미리보기 팝오버 하나(_wtRenderAddPop/wtAddPick/wtAddSubmit) —
   행마다 있던 [▼] 패널은 제거했다(창구가 여럿이면 어디에 담았는지 알 수 없다, 시안 B 확정). */

/** 통계에서 불러오기 — 서버가 고른 "역할별 가장 흔한 실제 헤더 이름"으로 채운다. */
async function wtLoadSuggested() {
  try {
    await _wtEnsureStats();
    var s = (_wtStats && _wtStats.suggestedCore) || [];
    if (!s.length) { showToast('통계에서 코어 열을 찾지 못했습니다 (분석된 탭이 없을 수 있습니다)', true); return; }
    if ((_wtTpl.core || []).length && !confirm('지금 목록을 통계 기반 ' + s.length + '개 열로 바꿉니다. 계속할까요?')) return;
    _wtTpl.core = s.slice();
    _wtSyncColumns();
    showToast(s.length + '개 열을 불러왔습니다 — 확인 후 저장하세요');
  } catch (e) { showToast('불러오기 실패: ' + e.message, true); }
}

async function loadWorktableTemplate() {
  if (!document.getElementById('wtColList')) return;
  try {
    var j = await _wtFetch(WT_EP.template);
    _wtTpl = j.data || { core: [], channels: {}, columns: [] };
    if (!_wtTpl.core) _wtTpl.core = [];
    if (!_wtTpl.channels) _wtTpl.channels = {};
    if (!_wtTpl.customChannels) _wtTpl.customChannels = [];
    if (!_wtTpl.workTypes) _wtTpl.workTypes = [];
    _wtRenderChans();  // 🌐 공통 줄 요약
    _wtRenderCols();   // 내부에서 알약 줄·미리보기까지 갱신
    var tpl = document.getElementById('wtTplSheet');
    if (tpl) tpl.value = _wtTpl.templateSheetId || '';
    var at = document.getElementById('wtSavedAt');
    if (at) {
      at.textContent = _wtTpl.updatedAt
        ? '최근 저장: ' + String(_wtTpl.updatedAt).slice(0, 10) + (_wtTpl.updatedBy ? ' · ' + _wtTpl.updatedBy : '')
        : '아직 저장된 표준 열이 없습니다';
    }
    _wtDirty(false);
  } catch (e) {
    var box = document.getElementById('wtColList');
    if (box) box.innerHTML = '<div class="as-wtempty">표준 열을 불러오지 못했습니다: ' + escHtml(e.message) + '</div>';
  }
}

async function wtSaveTemplate() {
  if (!_wtTpl) return;
  // ★ 화면이 곧 저장값 — 배열 그대로 보낸다(쉼표 파싱 없음).
  //   채널은 기본 4채널 + 직접 추가 채널 모두(_wtChannels 단일 출처).
  var channels = {};
  _wtChannels().forEach(function (c) {
    channels[c.key] = ((_wtTpl.channels || {})[c.key] || []).slice();
  });
  try {
    var tplEl = document.getElementById('wtTplSheet');
    var j = await _wtFetch(WT_EP.template, {
      core: _wtTpl.core, channels: channels,
      customChannels: (_wtTpl.customChannels || []).map(function (c) { return { key: c.key, label: c.label }; }),
      workTypes: _wtTypes().map(function (t) {
        // ★ autoTrigger 를 빠뜨리면 모달에서 고른 자동 선택 조건이 서버까지 안 간다
        //   — 저장은 되는데 자동 반영만 조용히 'auto' 로 되돌아간다(브라우저 검증으로 잡은 실측 버그).
        return { key: t.key, label: t.label, desc: t.desc || '', position: t.position,
          autoTrigger: t.autoTrigger || 'auto', columns: (t.columns || []).slice() };
      }),
      templateSheetId: tplEl ? tplEl.value : (_wtTpl.templateSheetId || ''),
    });
    _wtTpl = j.data;
    // ★ 서버가 정식 키를 발급할 수 있으므로(임시 `new1` → `c1`) 알약 줄까지 다시 그린다.
    _wtRenderChans();
    _wtRenderCols();
    var tpl = document.getElementById('wtTplSheet');
    if (tpl) tpl.value = _wtTpl.templateSheetId || '';
    var at = document.getElementById('wtSavedAt');
    if (at) at.textContent = '최근 저장: ' + String(_wtTpl.updatedAt || '').slice(0, 10) + (_wtTpl.updatedBy ? ' · ' + _wtTpl.updatedBy : '');
    _wtDirty(false);
    showToast('작업표 표준 열을 저장했습니다 (' + (_wtTpl.core || []).length + '개)');
  } catch (e) { showToast('저장 실패: ' + e.message, true); }
}

/* ── 헤더 학습 리포트(펼칠 때 1회 로드 — 설정 화면을 열 때마다 무거운 집계를 돌리지 않는다) ── */
async function wtToggleReport() {
  var box = document.getElementById('wtReport');
  var btn = document.getElementById('wtReportBtn');
  if (!box) return;
  var open = box.style.display !== 'none';
  box.style.display = open ? 'none' : '';
  if (btn) btn.innerHTML = open
    ? '<i class="fas fa-chart-simple"></i> 헤더 학습 리포트 펼치기'
    : '<i class="fas fa-chart-simple"></i> 헤더 학습 리포트 접기';
  if (open) return;
  if (_wtStats) return _wtRenderReport(_wtStats);
  box.innerHTML = '<div class="as-wtempty">불러오는 중…</div>';
  try {
    await _wtEnsureStats();
    _wtRenderReport(_wtStats);
  } catch (e) {
    box.innerHTML = '<div class="as-wtempty">리포트를 불러오지 못했습니다: ' + escHtml(e.message) + '</div>';
  }
}

function _wtRenderReport(d) {
  var box = document.getElementById('wtReport');
  if (!box) return;
  var LAYER = { core: '고정', auto: '자동', channel: '채널', work: '작업별', status: '상태' };
  var FREQ = { fixed: '거의 전부', common: '흔함', rare: '일부만' };
  var pct = function (x) { return Math.round((x || 0) * 100) + '%'; };
  var ch = d.channels || {};
  var card = function (r) {
    return '<div class="as-wtcard">' +
      '<div class="as-wth"><span class="as-wtn">' + escHtml(r.label || r.role) + '</span>' +
      '<span class="as-wtlayer ' + escHtml(r.layer || 'work') + '">' + escHtml(LAYER[r.layer] || r.layer || '') + '</span>' +
      '<span class="as-wtfreq ' + escHtml(r.frequency || 'rare') + '">' + escHtml(FREQ[r.frequency] || '') + '</span>' +
      '<span class="as-wtr">' + r.tabCount + '개 탭 · ' + pct(r.ratio) + '</span></div>' +
      '<div class="as-wtbar"><i style="width:' + Math.min(100, Math.round((r.ratio || 0) * 100)) + '%"></i></div>' +
      '<div class="as-wtv">' + ((r.headerVariants || []).map(function (v) { return escHtml(v.name) + ' (' + v.count + ')'; }).join(' · ') || '—') + '</div>' +
      '</div>';
  };
  var core = (d.roles || []).filter(function (r) { return r.frequency === 'fixed'; });
  var rest = (d.roles || []).filter(function (r) { return r.frequency !== 'fixed'; });
  var conflicts = d.statusConflicts || [];

  box.innerHTML =
    '<div class="as-wtnote">분석한 탭 <b>' + d.tabsAnalyzed + '</b>개' +
      (d.tabsWithoutHeaders ? ' · 헤더 미감지 ' + d.tabsWithoutHeaders + '개(미러 대기)' : '') +
      ' &nbsp;·&nbsp; 채널 추정: 쿠팡 ' + (ch.coupang || 0) + ' · 네이버 ' + (ch.naver || 0) +
      ' · 동시진행 ' + (ch.both || 0) + ' · 미상 ' + (ch.unknown || 0) +
      '<br>비율 = 그 열을 가진 탭의 비율. <b>' + pct(d.thresholds && d.thresholds.core) + '</b> 이상이면 "거의 전부"(코어 후보)입니다.</div>' +
    (conflicts.length
      ? '<div class="as-wtsec">⚠ 확인 필요 — 상태 칸에 제출이 겹쳐 쓸 수 있는 열</div>' +
        '<div class="as-wtnote">아래 열은 그 탭에서 <b>리뷰제출·입금 상태 칸</b>인데 구매양식 제출도 같은 열에 값을 씁니다. ' +
        '제출이 상태 표시를 덮어쓸 수 있으니 <b>헤더 이름을 바꾸는 편이 안전</b>합니다.</div>' +
        '<div class="as-wtgrid">' + conflicts.map(function (c) {
          return '<div class="as-wtcard warn"><div class="as-wth"><span class="as-wtn">' + escHtml(c.header) + '</span>' +
            '<span class="as-wtlayer status">' + escHtml(c.roleLabel) + '</span>' +
            '<span class="as-wtfreq common">제출도 씀: ' + escHtml(c.mapperLabel) + '</span>' +
            '<span class="as-wtr">' + c.tabCount + '개 탭</span></div></div>';
        }).join('') + '</div>'
      : '') +
    '<div class="as-wtsec">코어 후보 — 거의 모든 작업에 있는 열</div>' +
    (core.length ? '<div class="as-wtgrid">' + core.map(card).join('') + '</div>' : '<div class="as-wtempty">아직 집계된 열이 없습니다.</div>') +
    '<div class="as-wtsec">작업별·채널별 열 — 있을 때만 붙는 열</div>' +
    (rest.length ? '<div class="as-wtgrid">' + rest.map(card).join('') + '</div>' : '<div class="as-wtempty">해당 없음</div>') +
    '<div class="as-wtsec">미분류 헤더 — 시스템이 역할을 모르는 열</div>' +
    '<div class="as-wtnote">관리자가 미리 적어 두는 작업지시·업체 요청 칸이 여기 모입니다.</div>' +
    ((d.unmapped || []).length
      ? '<div class="as-wtgrid">' + (d.unmapped || []).map(function (u) {
          return '<div class="as-wtcard"><div class="as-wth"><span class="as-wtn">' + escHtml(u.name) + '</span>' +
            '<span class="as-wtfreq ' + escHtml(u.frequency || 'rare') + '">' + escHtml(FREQ[u.frequency] || '') + '</span>' +
            '<span class="as-wtr">' + u.tabCount + '개 탭 · ' + pct(u.ratio) + '</span></div>' +
            '<div class="as-wtbar"><i style="width:' + Math.min(100, Math.round((u.ratio || 0) * 100)) + '%"></i></div></div>';
        }).join('') + '</div>'
      : '<div class="as-wtempty">미분류 헤더가 없습니다.</div>');
}

  /* ── 마운트 ──────────────────────────────────────────────────
     ★ 호스트 테마가 없으면(리뷰웹시스템[3버전]) `as-standalone` 으로 같은 토큰을 주입한다.
       admin.html 은 테마가 있어 클래스가 붙지 않으므로 **렌더 결과가 그대로**다. */
/* ══════════════════════════════════════════════════════════════
   ★ 087 리뷰타입 정리 — 탭 설정 '리뷰타입' 칸에 남은 옛 값을 제자리로 되돌린다.

   · 실배송 / 빈박스 → 배송유형(delivery_type)으로 이관하고 리뷰타입 칸은 비운다
   · 믹스 → 혼합 (같은 뜻, 표기만 통일)

   ★★ 화면을 두는 이유 = **미리보기를 사람이 보고 결정**해야 하기 때문이다.
      기존 행을 건드리는 유일한 작업이라 자동 마이그레이션으로 돌리지 않았다.
   ★★ 배송유형 이관은 서버에서 blank-only — 접수가 채운 값을 덮지 않는다.
   ★ 안 돌려도 안전하다: 목록 밖 값은 판정(utils/reviewType)에서 null 로 떨어져
      "오늘 동작 그대로"가 되고 화면에는 옛 값이 그대로 표시된다.
   ══════════════════════════════════════════════════════════════ */
/* ★ 서버 경로는 재기준(ADMIN_SETTINGS_API)을 쓰지 않는다 — `/api/trackb/settings/*` 는
   관리자 대시보드(admin_token)와 리뷰웹시스템[3버전](인트라넷 SSO) **양쪽에서 그대로 닿는다**
   (authMiddleware 는 admin 토큰을 받고, via:'intranet' 격리는 인트라넷 토큰을 trackb 로 **한정**할 뿐이다).
   호스트마다 다른 경로로 보내면 두 화면이 서로 다른 결과를 본다 — 작업표 표준열과 같은 판단. */
var RTC_EP = '/api/trackb/settings/review-type-cleanup';

function _reviewTypeHtml() {
  return `
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">✅ 리뷰타입 정리</span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:0 0 12px;line-height:1.6">
          탭 설정의 <b>리뷰타입</b> 선택지가 <b>포토·텍스트·구매확정·별점·혼합</b>으로 통일됐습니다.
          예전 목록에만 있던 값이 남아 있으면 제자리로 되돌립니다 —
          <b>실배송·빈박스는 배송유형</b>으로 옮기고, <b>믹스는 혼합</b>으로 바꿉니다.<br>
          <b>지금 그대로 두어도 안전합니다.</b> 목록에 없는 값은 판정에서 빠질 뿐 화면에는 그대로 보입니다.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="as-btn" id="rtcPreviewBtn" onclick="reviewTypeCleanupRun(true)">🔍 미리보기</button>
          <button class="as-btn" id="rtcApplyBtn" style="display:none" onclick="reviewTypeCleanupRun(false)">적용하기</button>
        </div>
        <div id="rtcResult" style="font-size:.8rem;color:var(--t2);line-height:1.7"></div>`;
}

/** 미리보기·적용 공용. ★ dryRun=false 는 미리보기를 본 뒤에만 눌릴 수 있다(버튼이 그전엔 숨김). */
async function reviewTypeCleanupRun(dryRun) {
  var out = document.getElementById('rtcResult');
  var applyBtn = document.getElementById('rtcApplyBtn');
  if (!out) return;
  if (!dryRun && !confirm('탭 설정의 옛 리뷰타입 값을 정리합니다.\n\n· 실배송/빈박스 → 배송유형으로 이관(배송유형이 비어 있을 때만)\n· 믹스 → 혼합\n\n진행할까요?')) return;
  out.innerHTML = '<span style="color:var(--t3)">확인 중…</span>';
  try {
    var j = await _postAt(RTC_EP, { dryRun: !!dryRun });
    if (!j || j.ok === false) throw new Error((j && j.error) || '실패');
    var rows = (j.preview || []).map(function (r) {
      var to = (r.review_type === '믹스') ? '혼합으로 표기 변경'
             : ('배송유형으로 이관 — 그중 ' + r.delivery_empty + '건은 배송유형이 비어 있어 값이 옮겨집니다');
      return '<li><b>' + r.review_type + '</b> ' + r.cnt + '건 → ' + to + '</li>';
    }).join('');
    if (!j.total) {
      out.innerHTML = '<span style="color:var(--t2)">정리할 옛 값이 없습니다. 이미 전부 새 목록입니다.</span>';
      if (applyBtn) applyBtn.style.display = 'none';
      return;
    }
    if (j.dryRun) {
      out.innerHTML = '<div style="margin-bottom:6px">대상 <b>' + j.total + '건</b></div><ul style="margin:0;padding-left:18px">' + rows + '</ul>'
        + '<div style="margin-top:10px;color:var(--t3)">숫자를 확인한 뒤 [적용하기]를 누르세요.</div>';
      if (applyBtn) applyBtn.style.display = '';
    } else {
      out.innerHTML = '<div style="color:#0F7B4F;font-weight:700">정리 완료 — 배송유형 이관 ' + j.moved + '건 · 믹스→혼합 ' + j.renamed + '건</div>';
      if (applyBtn) applyBtn.style.display = 'none';
      _setNavBadge('reviewtype', '완료');
    }
  } catch (e) {
    out.innerHTML = '<span style="color:#B42318">실패: ' + escHtml(e.message) + '</span>';
  }
}

/** ★ 펼칠 때 자동으로 돌리지 않는다 — 설정 화면을 열 때마다 전 탭을 훑을 이유가 없다. */
function loadReviewTypeCleanup() { _setNavBadge('reviewtype', '점검'); }

/* ══════════════════════════════════════════════════════════════
   🚚 배송유형 표기 정리 (★ 135 후속) — 옛 어휘를 표준 5종으로 접는다.

   · 빈택배 → 빈박스 · 회수건 → 회수 (판정은 서버 `utils/deliveryType` 단일 출처)

   ★★ 왜 남아 있나: 화면마다 어휘가 갈려 있었다 — 현행 모집공고 모달은 5종인데,
      인라인 공고수정 모달과 구형 관리자 화면이 `빈택배`·`회수건` 을 저장했다.
      그렇게 저장된 값은 현행 모달 select 에 option 이 없어 **다시 열면 빈 값으로 보이고,**
      아무것도 안 건드리고 저장만 눌러도 **조용히 지워질 수 있다**.
   ★★ 접히는 값만 바꾼다 — 모르는 값(`기타배송(박스)`)은 손대지 않는다.
   ★★ 부속정보가 붙은 문장(`회수(회수택배사: …)`)은 **대상이 아니다** — 원문이 곧 정보다.
   ★ 미리보기를 사람이 보고 결정한다(기존 행을 건드리는 작업 — 담당자 정리와 같은 규율).
   ★ 지금 그대로 두어도 화면·판정은 정상이다(읽을 때 접어서 판정한다). 이 정리는 저장값을
     맞춰 위의 '조용히 지워질 수 있다'를 없애는 것이다.
   ══════════════════════════════════════════════════════════════ */
var DTC_EP = '/api/trackb/settings/delivery-type-cleanup';

function _deliveryCleanupHtml() {
  return `
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">🚚 배송유형 표기 정리</span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:0 0 12px;line-height:1.6">
          배송유형은 <b>실배송 · 빈박스 · 택배발송대행 · 회수 · 혼합</b> 다섯 가지로 운영합니다.
          예전 화면에서 저장된 작업은 <b>빈택배 · 회수건</b> 같은 옛 표기가 남아 있습니다.
          여기서 표준 표기로 바꿉니다.<br>
          <b>지금 그대로 두어도 화면은 정상입니다.</b> 시스템이 읽을 때 알아서 접어서 판단합니다 —
          다만 그 공고를 모집공고 창에서 열면 배송유형이 <b>빈 칸으로 보이고</b>,
          그대로 저장하면 배송유형이 <b>지워질 수 있습니다</b>.<br>
          <b>모르는 값과 회수택배사가 적힌 값은 건드리지 않습니다.</b>
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="as-btn" id="dtcPreviewBtn" onclick="deliveryCleanupRun(true)">🔍 미리보기</button>
          <button class="as-btn" id="dtcApplyBtn" style="display:none" onclick="deliveryCleanupRun(false)">적용하기</button>
        </div>
        <div id="dtcResult" style="font-size:.8rem;color:var(--t2);line-height:1.7"></div>`;
}

var _DTC_TABLE_NM = { tab_configs: '작업 탭', recruit_campaigns: '모집공고', work_orders: '작업오더' };

/** 미리보기·적용 공용. ★ dryRun=false 는 미리보기를 본 뒤에만 눌릴 수 있다(버튼이 그전엔 숨김). */
async function deliveryCleanupRun(dryRun) {
  var out = document.getElementById('dtcResult');
  var applyBtn = document.getElementById('dtcApplyBtn');
  if (!out) return;
  if (!dryRun && !confirm('배송유형 칸의 옛 표기를 표준으로 바꿉니다.\n\n· 빈택배 → 빈박스\n· 회수건 → 회수\n\n작업 내용·정산은 바뀌지 않고 배송유형 표기만 통일됩니다.\n진행할까요?')) return;
  out.innerHTML = '<span style="color:var(--t3)">확인 중…</span>';
  try {
    var j = await _postAt(DTC_EP, { dryRun: !!dryRun });
    if (!j || j.ok === false) throw new Error((j && j.error) || '실패');
    var rows = (j.preview || []).map(function (r) {
      var where = _DTC_TABLE_NM[r.table] || r.table;
      return '<li><b>' + escHtml(r.from) + '</b> → <b>' + escHtml(r.to) + '</b> · ' + where + ' ' + r.cnt + '건</li>';
    }).join('');
    if (!j.total) {
      out.innerHTML = '<span style="color:var(--t2)">정리할 옛 표기가 없습니다. 이미 전부 표준 표기입니다.</span>';
      if (applyBtn) applyBtn.style.display = 'none';
      _setNavBadge('deliverycleanup', '정상');
      return;
    }
    if (j.dryRun) {
      out.innerHTML = '<div style="margin-bottom:6px">대상 <b>' + j.total + '건</b></div><ul style="margin:0;padding-left:18px">' + rows + '</ul>'
        + '<div style="margin-top:10px;color:var(--t3)">숫자를 확인한 뒤 [적용하기]를 누르세요.</div>';
      if (applyBtn) applyBtn.style.display = '';
      _setNavBadge('deliverycleanup', j.total + '건', 'warn');
    } else {
      out.innerHTML = '<div style="color:#0F7B4F;font-weight:700">정리 완료 — ' + j.updated + '건</div>'
        + '<ul style="margin:6px 0 0;padding-left:18px">' + rows + '</ul>';
      if (applyBtn) applyBtn.style.display = 'none';
      _setNavBadge('deliverycleanup', '완료');
    }
  } catch (e) {
    out.innerHTML = '<span style="color:#B42318">실패: ' + escHtml(e.message) + '</span>';
  }
}

/* ══════════════════════════════════════════════════════════════
   👥 담당자 표기 정리 (★ 065 후속) — 담당자 칸에 남은 **실명**을 닉네임으로 접는다.

   · 박세희 → 만두 · 박은비 → 망고 (판정은 서버 `utils/workManager` 단일 출처)

   ★★ 왜 남아 있나: 065 **이전** 접수가 담당AE 실명을 그대로 넣었고, 접수 업서트는
      blank-only 라 재접수로도 안 고쳐진다 → 홈 작업목록 담당자 칩이 만두/망고/박세희/박은비
      넷으로 갈리고, 실명 행은 색 배지·🥟🥭·카카오 ID 매핑에서 **조용히** 빠진다.
   ★★ 매핑되는 값만 바꾼다 — 모르는 이름(자유입력 담당자)은 손대지 않는다.
   ★ 미리보기를 사람이 보고 결정한다(기존 행을 건드리는 작업 — 리뷰타입 정리와 같은 규율).
   ★ 앞으로 저장되는 값은 서버가 저장 직전에 접으므로(tabconfig 저장 경로) 재발하지 않는다.
   ══════════════════════════════════════════════════════════════ */
/* ★ 경로는 재기준(ADMIN_SETTINGS_API)하지 않는다 — RTC_EP 와 같은 판단(양쪽 호스트에서 그대로 닿는다). */
var MGC_EP = '/api/trackb/settings/manager-cleanup';

function _managerCleanupHtml() {
  return `
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">👥 담당자 표기 정리</span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:0 0 12px;line-height:1.6">
          담당자는 <b>만두 · 망고</b> 두 표기로만 운영합니다(<b>만두 = 박세희 · 망고 = 박은비</b>).
          예전에 접수된 작업은 담당자 칸에 <b>실명</b>이 그대로 들어가 있어,
          홈 작업목록의 담당자 칩이 <b>만두 / 망고 / 박세희 / 박은비</b> 넷으로 갈립니다.
          여기서 실명을 닉네임으로 바꿉니다.<br>
          <b>지금 그대로 두어도 안전합니다.</b> 칩만 갈려 보일 뿐 작업 내용은 바뀌지 않습니다 —
          다만 실명으로 남은 작업은 담당자 색 배지·🥟🥭 표시·카카오 아이디 안내에서 빠집니다.<br>
          <b>모르는 이름은 건드리지 않습니다.</b> 앞으로 저장하는 값은 자동으로 닉네임이 됩니다.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="as-btn" id="mgcPreviewBtn" onclick="managerCleanupRun(true)">🔍 미리보기</button>
          <button class="as-btn" id="mgcApplyBtn" style="display:none" onclick="managerCleanupRun(false)">적용하기</button>
        </div>
        <div id="mgcResult" style="font-size:.8rem;color:var(--t2);line-height:1.7"></div>`;
}

var _MGC_TABLE_NM = { tab_configs: '작업 탭', recruit_campaigns: '모집공고' };

/** 미리보기·적용 공용. ★ dryRun=false 는 미리보기를 본 뒤에만 눌릴 수 있다(버튼이 그전엔 숨김). */
async function managerCleanupRun(dryRun) {
  var out = document.getElementById('mgcResult');
  var applyBtn = document.getElementById('mgcApplyBtn');
  if (!out) return;
  if (!dryRun && !confirm('담당자 칸의 실명을 닉네임으로 바꿉니다.\n\n· 박세희 → 만두\n· 박은비 → 망고\n\n작업 내용·정산은 바뀌지 않고 담당자 표기만 통일됩니다.\n진행할까요?')) return;
  out.innerHTML = '<span style="color:var(--t3)">확인 중…</span>';
  try {
    var j = await _postAt(MGC_EP, { dryRun: !!dryRun });
    if (!j || j.ok === false) throw new Error((j && j.error) || '실패');
    var rows = (j.preview || []).map(function (r) {
      var where = _MGC_TABLE_NM[r.table] || r.table;
      return '<li><b>' + escHtml(r.from) + '</b> → <b>' + escHtml(r.to) + '</b> · ' + where + ' ' + r.cnt + '건</li>';
    }).join('');
    if (!j.total) {
      out.innerHTML = '<span style="color:var(--t2)">정리할 실명 표기가 없습니다. 이미 전부 닉네임입니다.</span>';
      if (applyBtn) applyBtn.style.display = 'none';
      _setNavBadge('managercleanup', '정상');
      return;
    }
    if (j.dryRun) {
      out.innerHTML = '<div style="margin-bottom:6px">대상 <b>' + j.total + '건</b></div><ul style="margin:0;padding-left:18px">' + rows + '</ul>'
        + '<div style="margin-top:10px;color:var(--t3)">숫자를 확인한 뒤 [적용하기]를 누르세요.</div>';
      if (applyBtn) applyBtn.style.display = '';
      _setNavBadge('managercleanup', j.total + '건', 'warn');
    } else {
      out.innerHTML = '<div style="color:#0F7B4F;font-weight:700">정리 완료 — ' + j.updated + '건</div>'
        + '<ul style="margin:6px 0 0;padding-left:18px">' + rows + '</ul>';
      if (applyBtn) applyBtn.style.display = 'none';
      _setNavBadge('managercleanup', '완료');
    }
  } catch (e) {
    out.innerHTML = '<span style="color:#B42318">실패: ' + escHtml(e.message) + '</span>';
  }
}

/** ★ 펼칠 때 자동으로 돌리지 않는다 — 설정 화면을 열 때마다 전 탭을 훑을 이유가 없다. */
function loadManagerCleanup() { _setNavBadge('managercleanup', '점검'); }

/* ══════════════════════════════════════════════════════════════
   📎 구매 캡처 연결 복구 — Drive 엔 있는데 링크만 빈 주문을 이어 붙인다
   ★ 경로는 재기준하지 않는다(RTC_EP 와 같은 판단 — 양쪽 호스트에서 그대로 닿는다).
   ══════════════════════════════════════════════════════════════ */
var CLB_EP = '/api/trackb/capture-link/backfill';

function _captureLinkHtml() {
  return `
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">📎 구매 캡처 연결 복구</span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:0 0 12px;line-height:1.6">
          리뷰어는 캡처를 올렸는데 <b>주문과의 연결만 끊긴</b> 건을 찾아 이어 붙입니다.
          그 탭의 <b>[구매캡처] 폴더</b>를 실제로 훑어 <b>파일명의 수취인명이 그 행의 수취인명과 같은</b> 파일을 찾습니다.<br>
          ★ <b>파일이 아예 없는 건은 여기서 복구할 수 없습니다</b> — 그건 리뷰어가 다시 올려야 하고,
          리뷰어 홈의 <b>보완 첨부 카드</b>가 그 창구입니다.<br>
          ★ 파일을 만들거나 옮기거나 지우지 않습니다. 바뀌는 것은 주문의 <b>캡처 연결 두 칸</b>뿐입니다.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <label style="font-size:.78rem;color:var(--t2)">최근
            <input id="clbDays" type="number" min="1" max="3650" value="30" style="width:74px;padding:5px 7px;border:1px solid var(--border,#e5e8eb);border-radius:6px;font-size:.78rem;font-family:inherit"> 일
          </label>
          <label style="font-size:.78rem;color:var(--t2);display:flex;align-items:center;gap:5px">
            <input id="clbAllowLow" type="checkbox"> 수취인명 없는 건도 이름만 보고 포함
          </label>
          <span style="font-size:.72rem;color:var(--t3)">(기본: <b>수취인명이 같으면</b> 제출 시각과 무관하게 연결 — 후보가 둘 이상이거나 한 파일을 두 주문이 노리면 건너뜁니다)</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="as-btn" id="clbPreviewBtn" onclick="captureLinkRun(true)">🔍 미리보기</button>
          <button class="as-btn" id="clbApplyBtn" style="display:none" onclick="captureLinkRun(false)">연결하기</button>
        </div>
        <div id="clbResult" style="font-size:.8rem;color:var(--t2);line-height:1.7"></div>`;
}

/** 판정 보류 사유 — 폴더 미연결과 Drive 조회 실패는 **다른 문제**다(고칠 곳이 다르다).
    ★ "모른다"를 "없다"로 말하면 담당자가 원인을 엉뚱한 데서 찾는다. */
function _clbUnknownWhy(j) {
  var rs = j.unknownReasons || {};
  var noFolder = rs.no_capture_folder || 0;
  var total = 0;
  for (var k in rs) if (Object.prototype.hasOwnProperty.call(rs, k)) total += rs[k] || 0;
  var other = total - noFolder;
  if (noFolder && !other) return '캡처 폴더가 연결돼 있지 않습니다';
  if (!noFolder && other) return 'Drive 를 훑지 못했습니다(잠시 후 다시 시도)';
  if (total) return '폴더 미연결 ' + noFolder + '건 · Drive 조회 실패 ' + other + '건';
  return '사유를 확인하지 못했습니다';
}

/** 미리보기·실행 공용. ★ 실행은 미리보기를 본 뒤에만 눌릴 수 있다(그전엔 버튼 숨김) + confirm 경유. */
async function captureLinkRun(dryRun) {
  var out = document.getElementById('clbResult');
  var applyBtn = document.getElementById('clbApplyBtn');
  if (!out) return;
  var days = Math.min(Math.max(parseInt((document.getElementById('clbDays') || {}).value, 10) || 30, 1), 3650);
  var allowLow = !!(document.getElementById('clbAllowLow') || {}).checked;
  /* ★ 가장 위험한 선택(시각이 먼 파일까지 포함)은 확인창이 그 사실을 말한다 — 늘 같은 문장이면
     사람이 무엇을 켠 채 누르는지 모른다. */
  if (!dryRun && !confirm('찾은 캡처를 주문에 연결합니다.\n\n· 파일을 만들거나 옮기거나 지우지 않습니다\n· 이미 연결된 주문은 건드리지 않습니다\n· 기록되는 시각은 그 파일이 올라간 실제 시각입니다'
      + (allowLow ? '\n\n⚠ [시각이 먼 파일까지 포함]이 켜져 있습니다 — 과거 회차 캡처가 붙을 수 있습니다.' : '')
      + '\n\n진행할까요?')) return;
  out.innerHTML = '<span style="color:var(--t3)">' + (dryRun ? '폴더를 훑는 중… (탭이 많으면 시간이 걸립니다)' : '연결하는 중…') + '</span>';
  var prevBtn = document.getElementById('clbPreviewBtn');
  if (applyBtn) applyBtn.disabled = true;
  if (prevBtn) prevBtn.disabled = true;      // ★ 연타 금지 — 클릭 한 번이 최대 60탭 재귀 Drive 조회다
  try {
    var j = await _postAt(CLB_EP, { days: days, allowLow: allowLow, limit: 2000, maxTabs: 60,
                                    dryRun: !!dryRun, confirm: !dryRun });
    if (!j || j.ok === false) throw new Error((j && j.error) || '실패');
    var sum = j.verdicts || {};   // ★ 분류 수는 서버가 센다(응답에 items 를 싣지 않는다 = PII 최소화)
    var head = '<div style="margin-bottom:6px">미링크 주문 <b>' + (j.scanned || 0) + '건</b> 확인'
      + ' · 작업 ' + (j.tabs || 0) + '개' + (j.tabsSkipped ? ' <span style="color:#B42318">(작업 ' + j.tabsSkipped + '개는 이번 범위 밖 — 기간을 나눠 다시 돌리세요)</span>' : '') + '</div>';
    var rows = '<ul style="margin:0;padding-left:18px">'
      + '<li><b>' + (j.planned || 0) + '건</b> 연결 가능 — Drive 에 그 사람 캡처가 있습니다</li>'
      + '<li>' + (sum.notAttached || 0) + '건 파일 없음 — <b>리뷰어에게 다시 요청해야 합니다</b></li>'
      + ((sum.unknown || 0) ? '<li>' + sum.unknown + '건 판정 보류 — ' + _clbUnknownWhy(j) + '</li>' : '')
      + (j.skipped ? '<li>' + j.skipped + '건 보류 — 후보가 여럿이거나 시각이 멀어 <b>자동으로 붙이지 않았습니다</b></li>' : '')
      + '</ul>';
    if (j.dryRun) {
      var sample = (j.plannedItems || []).slice(0, 8).map(function (x) {
        return '<li>' + escHtml(x.tabName || '') + ' · ' + escHtml(x.recipient || x.orderer || '') + ' → ' + escHtml(x.file || '') + '</li>';
      }).join('');
      out.innerHTML = head + rows
        + (sample ? '<div style="margin-top:10px;color:var(--t3)">연결 예정(앞 8건)</div><ul style="margin:0;padding-left:18px;font-size:.76rem">' + sample + '</ul>' : '')
        + '<div style="margin-top:10px;color:var(--t3)">숫자를 확인한 뒤 [연결하기]를 누르세요.</div>';
      if (applyBtn) applyBtn.style.display = (j.planned > 0) ? '' : 'none';
    } else {
      out.innerHTML = head
        + '<div style="color:#0F7B4F;font-weight:700;margin-top:6px">연결 완료 — ' + (j.linked || 0) + '건</div>'
        + ((j.conflicts || j.raced) ? '<div style="color:var(--t3)">그 사이 다른 주문이 쓰고 있던 파일 ' + (j.conflicts || 0) + '건 · 이미 연결된 주문 ' + (j.raced || 0) + '건은 건드리지 않았습니다</div>' : '')
        + '<div style="margin-top:6px;color:var(--t3)">' + (sum.notAttached || 0) + '건은 파일이 없어 리뷰어 재요청 대상입니다.</div>';
      if (applyBtn) applyBtn.style.display = 'none';
      _setNavBadge('capturelink', (j.linked || 0) + '건 연결');
    }
  } catch (e) {
    out.innerHTML = '<span style="color:#B42318">실패: ' + escHtml(e.message) + '</span>';
  } finally {
    if (applyBtn) applyBtn.disabled = false;
    if (prevBtn) prevBtn.disabled = false;
  }
}

/** ★ 펼칠 때 자동으로 돌리지 않는다 — Drive 를 훑는 작업이라 사람이 누를 때만 돈다. */
function loadCaptureLinkBackfill() { _setNavBadge('capturelink', '점검'); }

/* ══════════════════════════════════════════════════════════════
   ★ 블랙리스트 관리기준 (091 · 사용자 확정 Q4 — 판정 일수 별도 설정)
   공고별 참여 리뷰어 관리(🚫) 화면의 "이전 리뷰" 판정에 쓰는 기준 일수 두 개.
   ★ 판정 자체는 서버(utils/reviewerGate)가 하고 여기는 일수만 저장한다 —
     차단 여부는 관리자가 건별로 정하며(자동 차단 없음), 이 기준은 표시·판단 보조다.
   ★ 경로는 재기준하지 않는다(RTC_EP 와 같은 판단 — 양쪽 호스트에서 그대로 닿는다). */
var RGC_EP = '/api/trackb/settings/reviewer-gate-criteria';

function _gateCriteriaHtml() {
  return `
        <div class="admin-section-header">
          <span style="font-size:.95rem;font-weight:700;color:var(--t1)">🚫 블랙리스트 관리기준</span>
        </div>
        <p style="font-size:.78rem;color:var(--t3);margin:0 0 12px;line-height:1.6">
          <b>등록리뷰어DB</b>와 모집공고 <b>[🚫 리뷰어]</b>(참여 리뷰어 관리) 화면의 "이전 리뷰" 판정 기준입니다.
          두 값 모두 <b>아직 리뷰를 안 낸 건</b>을 구매 후 경과일수로 나눕니다(기한경과 14일↑ → 30일을 넘으면 리뷰미작성으로 승격).<br>
          기준을 바꿔도 <b>자동으로 차단되지 않습니다</b> — 차단은 항상 관리자가 건별로 정합니다.
        </p>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
          <label style="font-size:.74rem;color:var(--t2)">리뷰미작성 판정 일수 (기본 30)<br>
            <input type="number" id="rgcNowrite" min="1" max="365" style="width:110px;padding:7px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;font-size:.8rem">
            <span style="font-size:.68rem;color:var(--t3)">일 — 구매 후 이 일수가 지나도록 리뷰 미제출이면 <b>리뷰미작성</b>(1건↑ = 블랙리스트 후보)</span>
          </label>
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
          <label style="font-size:.74rem;color:var(--t2)">기한경과 판정 일수 (기본 14)<br>
            <input type="number" id="rgcOverdue" min="1" max="365" style="width:110px;padding:7px 10px;border:1px solid var(--border,#d1d5db);border-radius:8px;font-size:.8rem">
            <span style="font-size:.68rem;color:var(--t3)">일 — 구매 후 이 일수가 지나도록 리뷰 미제출이면 <b>기한경과</b>(리뷰미작성 일수를 넘으면 미작성으로 승격)</span>
          </label>
        </div>
        <button class="as-btn" onclick="saveGateCriteria()">저장</button>
        <span id="rgcMsg" style="font-size:.74rem;margin-left:8px"></span>`;
}

async function loadGateCriteria() {
  try {
    var r = await fetch(_apiBase() + RGC_EP, { headers: _headers() });
    var j = await r.json().catch(function () { return null; });
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    var c = j.criteria || {};
    var n = document.getElementById('rgcNowrite'); if (n) n.value = c.nowriteDays || 30;
    var o = document.getElementById('rgcOverdue'); if (o) o.value = c.overdueDays || 14;
    _setNavBadge('gatecriteria', '기한 ' + (c.overdueDays || 14) + '일 / 미작성 ' + (c.nowriteDays || 30) + '일');
  } catch (e) {
    _setNavBadge('gatecriteria', '?', 'warn');   // 조회 실패를 기본값처럼 꾸미지 않는다
  }
}

async function saveGateCriteria() {
  var msg = document.getElementById('rgcMsg');
  try {
    var j = await _postAt(RGC_EP, {
      nowriteDays: (document.getElementById('rgcNowrite') || {}).value,
      overdueDays: (document.getElementById('rgcOverdue') || {}).value,
    });
    if (!j || !j.ok) throw new Error((j && j.error) || '저장 실패');
    if (msg) { msg.textContent = '저장했습니다'; msg.style.color = '#0F7B4F'; }
    loadGateCriteria();
  } catch (e) {
    if (msg) { msg.textContent = '실패: ' + (e.message || e); msg.style.color = '#B42318'; }
  }
}

  var PANELS = { nickname: _nicknameHtml, business: _businessHtml, aisamples: _aisamplesHtml, inspectmsg: _inspectmsgHtml, worktable: _worktableHtml, reviewtype: _reviewTypeHtml, managercleanup: _managerCleanupHtml, deliverycleanup: _deliveryCleanupHtml, capturelink: _captureLinkHtml, gatecriteria: _gateCriteriaHtml, homebanner: _homeBannerHtml, notice: _noticeHtml };
  var LOADERS = { nickname: loadMyNickname, business: loadCompanyBusinessNo, aisamples: loadAiSamples, inspectmsg: loadInspectMessages, worktable: loadWorktableTemplate, reviewtype: loadReviewTypeCleanup, managercleanup: loadManagerCleanup, capturelink: loadCaptureLinkBackfill, gatecriteria: loadGateCriteria, homebanner: loadReviewerHomeBanner, notice: loadReviewerNoticesAdmin };
  /* 목차 라벨·아이콘 — 시안 B(design-admin-settings-wireframe.html ?v=B).
     ★ 키는 PANELS 와 같은 이름을 쓴다(둘이 갈리면 목차에 빈 칸이 생긴다). */
  var PANEL_NAV = {
    homebanner: { ic: '🖼️', nm: '리뷰홈 배너광고' },
    nickname:  { ic: '👤', nm: '내 닉네임' },
    business:  { ic: '🏢', nm: '제공정보' },
    aisamples: { ic: '🤖', nm: 'AI 판별 예시' },
    inspectmsg: { ic: '💬', nm: '리뷰어 안내문구' },
    worktable: { ic: '📋', nm: '작업표 표준 열' },
    reviewtype: { ic: '✅', nm: '리뷰타입 정리' },
    managercleanup: { ic: '👥', nm: '담당자 표기 정리' },
    deliverycleanup: { ic: '🚚', nm: '배송유형 표기 정리' },
    capturelink: { ic: '📎', nm: '구매 캡처 연결 복구' },
    gatecriteria: { ic: '🚫', nm: '블랙리스트 관리기준' },
    notice:    { ic: '📣', nm: '리뷰어 공지' },
  };
  var _navKeys = [];        // 이번 마운트에 그린 목차 키(순서 그대로)

  /** 목차 배지 — 로더가 "지금 몇 개 채워졌나"를 넣는다. 없으면 조용히 무시(부분 마운트·조회 실패). */
  function _setNavBadge(key, text, tone) {
    var b = document.getElementById('asBadge_' + key);
    if (!b) return;
    b.textContent = text;
    b.className = 'as-bbadge' + (tone === 'warn' ? ' warn' : '');
  }

  /** 목차 전환 — 화면에는 고른 묶음 하나만.
      ★ 패널은 전부 DOM 에 두고 보이기만 토글한다: 로더들이 id 로 값을 쓰므로
        안 그린 패널이 있으면 그 값이 조용히 비어 버린다(admin.html 은 탭 전환 때 한 번만 부른다). */
  function asSelectPanel(key) {
    if (!PANELS[key]) return;
    _navKeys.forEach(function (k) {
      var sec = document.getElementById('asSec_' + k);
      var nav = document.getElementById('asNav_' + k);
      if (sec) sec.className = 'as-bsec' + (k === key ? ' on' : '');
      if (nav) nav.className = 'as-bitem' + (k === key ? ' on' : '');
    });
    try { sessionStorage.setItem('as_panel', key); } catch (_) {}
  }

  function _injectStyles() {
    if (document.getElementById('adminSettingsStyles')) return;
    var st = document.createElement('style');
    st.id = 'adminSettingsStyles';
    st.textContent =
      '.as-standalone{--t1:#0F172A;--t2:#475569;--t3:#94A3B8;--t4:#9CA3AF;--p:#3182f6;--border:#E5E7EB;color:var(--t1)}' +
      '.as-standalone .admin-section-header{display:flex;align-items:center;justify-content:space-between;margin:0 0 4px;padding-bottom:8px;border-bottom:1px solid var(--border)}' +
      /* ══ 시안 B — 좌측 목차 + 한 번에 한 묶음 (frontend/docs/design-admin-settings-wireframe.html ?v=B) ══
         ★ 색은 전부 리터럴 — 호스트 테마(--t1·--p)는 리뷰웹시스템[3버전]에 없어 무효값이 된다.
         ★ 관리자 대시보드도 같은 모듈이라 함께 바뀐다(사본을 만들지 않는다는 규율의 대가이자 목적). */
      '.as-b{display:grid;grid-template-columns:236px minmax(0,1fr);gap:18px;align-items:start}' +
      '.as-bnav{position:sticky;top:0;background:#fff;border:1px solid #E5E7EB;border-radius:13px;padding:8px;' +
        'box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 26px rgba(16,24,40,.05)}' +
      '.as-bnavt{font-size:.66rem;font-weight:800;letter-spacing:.08em;color:#9CA3AF;padding:7px 10px 5px}' +
      '.as-bitem{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;border:none;background:none;' +
        'border-radius:9px;font:inherit;font-size:.82rem;font-weight:700;color:#667085;cursor:pointer;text-align:left}' +
      '.as-bitem:hover{background:#F5F7FA}' +
      '.as-bitem.on{background:#EFF6FF;color:#1D4ED8}' +
      '.as-bitem .ic{width:20px;text-align:center;font-size:.95rem;flex:none}' +
      '.as-bitem .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.as-bbadge{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'font-size:.66rem;font-weight:750;color:#6B7280;background:#F3F4F6;border:1px solid #E5E7EB;border-radius:999px;padding:1px 7px}' +
      '.as-bbadge.warn{background:#FFFBEB;border-color:#FDE68A;color:#B45309}' +
      '.as-bitem.on .as-bbadge{background:#fff;border-color:#BFDBFE;color:#1D4ED8}' +
      '.as-bnavfoot{font-size:.7rem;color:#9CA3AF;line-height:1.55;padding:9px 10px 3px;border-top:1px solid #F1F3F6;margin-top:7px}' +
      '.as-bnavfoot b{color:#6B7280}' +
      '.as-bmain{min-width:0;background:#fff;border:1px solid #E5E7EB;border-radius:13px;padding:16px 20px;' +
        'box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 26px rgba(16,24,40,.05)}' +
      '.as-bsec{display:none}.as-bsec.on{display:block}' +
      /* ★ 패널 머리 정규화 — admin.html 의 .admin-section-header 는 **sticky + 좌우 -16px 풀블리드 +
         페이지색 반투명 배경**이다(탭 전체를 가로지르는 머리띠로 설계됐다). 흰 패널 안에 그대로 두면
         회색 띠가 패널을 뚫고 나가고 스크롤 시 화면 위에 붙는다 → B 안에서는 평범한 제목 줄로 돌린다.
         두 호스트가 같은 모양이 되도록 as-standalone 규칙보다 뒤에 둔다(같은 특이성 = 나중이 이김). */
      '.as-b .admin-section-header{position:static;margin:0 0 10px;padding:0 0 10px;background:transparent;' +
        'backdrop-filter:none;-webkit-backdrop-filter:none;border-bottom:1px solid #EEF0F4}' +
      /* 공지 패널은 자기 테두리를 갖고 있다(대시보드 카드로도 쓰이므로) — B 안에서는 패널이 곧 카드라 벗긴다 */
      '.as-b .as-noticebox{border:none!important;background:transparent!important;padding:0!important;border-radius:0!important}' +
      /* 패널 안의 하위 묶음 = 구분선 + 소제목(인셋 박스를 겹치지 않는다 — 한 번에 한 묶음이라 필요 없다) */
      '.as-sub{margin-top:16px;padding-top:14px;border-top:1px solid #EEF0F4}' +
      '.as-subt{font-size:.8rem;font-weight:750;color:#111827;margin-bottom:9px}' +
      '.as-subt span{font-weight:400;color:#9CA3AF;font-size:.72rem}' +
      '.as-subt span b{color:#6B7280}' +
      '.as-foot{font-size:.72rem;color:#9CA3AF;margin-top:9px}.as-foot b{color:#6B7280}' +
      /* 이미지 슬롯 = 목록형 한 줄(발행방법·AI 예시 공용 — 두 곳이 같은 모양) */
      '.as-slots{display:flex;flex-direction:column;gap:6px}' +
      '.as-slot{display:flex;align-items:center;gap:11px;border:1px solid #E5E7EB;border-radius:10px;padding:8px 11px;background:#fff}' +
      '.as-slotth{width:52px;height:52px;flex:none;border-radius:8px;border:1px solid #E5E7EB;background:#FBFCFE;' +
        'display:grid;place-items:center;overflow:hidden}' +
      '.as-slotth img{max-width:100%;max-height:100%;object-fit:contain}' +
      '.as-slotnone{font-size:.64rem;color:#9CA3AF}' +
      '.as-slotbody{flex:1;min-width:0}' +
      '.as-slotnm{font-size:.82rem;font-weight:750;color:#111827}' +
      '.as-slotsub{font-size:.71rem;color:#9CA3AF;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.as-slotsub b{color:#6B7280}' +
      '.as-stat{flex:none;font-size:.68rem;font-weight:750;border-radius:999px;padding:2px 9px;border:1px solid transparent;white-space:nowrap}' +
      '.as-stat.on{background:#E5F3EE;color:#127A5E;border-color:#C6E8D3}' +
      '.as-stat.off{background:#F3F4F6;color:#9CA3AF;border-color:#E5E7EB}' +
      /* 날것의 파일 입력은 감추고 label 로 누른다 — id·onchange 경로는 그대로다(회귀가드가 id 를 본다) */
      '.as-file{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);border:0}' +
      '.as-btn{flex:none;display:inline-flex;align-items:center;font:inherit;font-size:.72rem;font-weight:700;line-height:1.2;' +
        'padding:6px 11px;border-radius:8px;border:1px solid #D1D5DB;background:#fff;color:#374151;cursor:pointer;white-space:nowrap}' +
      '.as-btn:hover{background:#F9FAFB}' +
      '.as-btn.del{color:#B42318;border-color:#F7C9C9;background:#FFF5F5}' +
      '@media (max-width:1000px){' +
        '.as-b{grid-template-columns:1fr}' +
        '.as-bnav{position:static;display:flex;flex-wrap:wrap;gap:4px}' +
        '.as-bnavt,.as-bnavfoot{display:none}' +
        '.as-bitem{width:auto}.as-bitem .nm{flex:0 1 auto}}' +
      '@media (max-width:640px){.as-slot{flex-wrap:wrap}.as-slotbody{flex:1 1 100%;order:3}}' +
      /* 리뷰어 안내문구 — 유형과 입력란을 같은 행에 둬 문구의 대상을 즉시 확인한다.
         서버가 준 kinds/messages 를 그대로 그리므로 저장·전송 문구의 단일 출처는 유지된다. */
      '.as-imsg-grid{width:100%;max-width:100%;box-sizing:border-box;border:1px solid #DCE3EC;border-radius:9px;overflow:hidden;background:#fff}' +
      '.as-imsg-colhead{display:grid;grid-template-columns:minmax(190px,31%) minmax(0,1fr);background:#F6F8FB;border-bottom:1px solid #DCE3EC;color:#667085;font-size:.72rem;font-weight:750}' +
      '.as-imsg-colhead span{padding:9px 12px}.as-imsg-colhead span+span{border-left:1px solid #DCE3EC}' +
      '.as-imsg-row{display:grid;grid-template-columns:minmax(190px,31%) minmax(0,1fr);min-width:0;border-bottom:1px solid #E8EDF3}' +
      '.as-imsg-row:last-child{border-bottom:none}' +
      '.as-imsg-meta{padding:9px 12px;background:#FAFBFD;min-width:0}' +
      '.as-imsg-label{font-size:.82rem;font-weight:750;color:#1F2937;line-height:1.4}' +
      '.as-imsg-desc{font-size:.71rem;color:#8491A0;line-height:1.5;margin-top:4px}' +
      '.as-imsg-reset{margin-top:6px;padding:0;border:none;background:transparent;color:#526E88;font:inherit;font-size:.7rem;font-weight:650;text-decoration:underline;text-underline-offset:3px;cursor:pointer}' +
      '.as-imsg-reset:hover{color:#2563A8}.as-imsg-reset:focus-visible{outline:2px solid #2563A8;outline-offset:3px;border-radius:2px}' +
      '.as-imsg-field{min-width:0;padding:8px 12px;border-left:1px solid #DCE3EC}' +
      '.as-imsg-input{display:block;width:100%;min-height:66px;padding:6px 10px;border:1px solid #C9D5E1;border-radius:7px;background:#fff;color:#1F2937;font:inherit;font-size:.78rem;line-height:1.55;resize:vertical;outline:none;box-sizing:border-box}' +
      '.as-imsg-input:focus{border-color:#2563A8;box-shadow:0 0 0 3px rgba(37,99,168,.13)}' +
      '.as-imsg-help{margin-top:5px;color:#94A3B8;font-size:.68rem;line-height:1.4}' +
      '@media (max-width:640px){.as-imsg-colhead{display:none}.as-imsg-row{grid-template-columns:1fr}.as-imsg-meta{padding:8px 12px 6px}.as-imsg-field{padding:0 12px 8px;border-left:none}.as-imsg-input{min-height:76px}}' +
      /* AI 판별 예시이미지 — ★ 색·크기 리터럴 고정(호스트 테마 없이도 같은 모양) */
      '.as-smpload{font-size:.78rem;color:#9CA3AF;padding:10px 2px}' +
      /* 등록 예시 썸네일 — 클릭하면 크게 본다(40px 로는 내용 확인이 불가능했다) */
      '.as-smpth{position:relative;display:inline-block;margin-right:7px}' +
      '.as-smpth img{width:54px;height:70px;object-fit:cover;border-radius:6px;border:1px solid #E5E7EB;display:block;cursor:zoom-in}' +
      '.as-smpth img:hover{border-color:#2563A8;box-shadow:0 0 0 2px rgba(37,99,168,.15)}' +
      '.as-smpx{position:absolute;top:-6px;right:-3px;width:16px;height:16px;border-radius:999px;background:#EF4444;' +
        'color:#fff;border:none;font-size:9px;cursor:pointer;line-height:1;padding:0}' +
      /* 크게 보기 오버레이 — body 직속, 리터럴 색 */
      '.as-zoom{position:fixed;inset:0;z-index:10050;background:rgba(15,23,42,.62);display:flex;' +
        'align-items:center;justify-content:center;padding:24px}' +
      '.as-zoombox{background:#fff;border-radius:14px;max-width:880px;width:100%;max-height:92vh;' +
        'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(15,23,42,.35)}' +
      '.as-zoomh{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid #E5E7EB;font-size:.86rem}' +
      '.as-zoomn{font-size:.72rem;color:#6B7280;font-weight:700}' +
      '.as-zoomimg{flex:1;min-height:0;overflow:auto;background:#F3F4F6;display:grid;place-items:center;padding:12px}' +
      '.as-zoomimg img{max-width:100%;max-height:74vh;border-radius:8px;border:1px solid #E5E7EB;background:#fff}' +
      '.as-zoomft{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid #E5E7EB;' +
        'font-size:.72rem;color:#6B7280}' +
      '.as-zoomft b{color:#B91C1C}' +
      /* 작업표 표준 열 — ★ 색은 리터럴 고정(호스트 테마 변수에 의존하지 않는다).
         admin.html·리뷰웹시스템[3버전] 어디에 얹혀도 같은 모양으로 뜬다(recruit-modal.js 실측 사고의 교훈). */
      '.as-wtlist{display:flex;flex-direction:column;gap:6px}' +
      '.as-wtempty{color:#9CA3AF;font-size:.8rem;padding:14px 10px;text-align:center;border:1px dashed #E5E7EB;border-radius:8px}' +
      '.as-wtrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid #E5E7EB;border-radius:8px;padding:7px 10px;background:#fff}' +
      '.as-wtno{font-size:.72rem;color:#9CA3AF;min-width:18px;font-variant-numeric:tabular-nums}' +
      '.as-wtname{font-size:.85rem;font-weight:650;color:#111827;min-width:90px}' +
      '.as-wtrole{font-size:.72rem;color:#1D4ED8;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:5px;padding:2px 7px}' +
      '.as-wtrole.none{color:#6B7280;background:#F3F4F6;border-color:#E5E7EB}' +
      '.as-wtrole.pending{color:#B45309;background:#FFFBEB;border-color:#FDE68A}' +
      '.as-wtwarn{font-size:.72rem;color:#B45309;background:#FEF3C7;border:1px solid #FDE68A;border-radius:5px;padding:2px 7px}' +
      /* 제출 매칭 설명 — 배지 오른쪽 같은 줄(행 높이 한 줄 유지), 넘치면 말줄임 + title 전체 문장.
         ★ flex:1 1 0 + min-width:0 이라 설명이 아무리 길어도 행을 두 줄로 밀지 않는다. */
      '.as-wtfill{flex:1 1 0;min-width:0;font-size:.71rem;color:#6B7280;line-height:1.5;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      /* 좁은 화면은 어차피 행이 접히므로 설명을 아랫줄 전폭으로(잘려서 안 보이는 것보다 낫다) */
      '@media (max-width:640px){.as-wtfill{flex-basis:100%;white-space:normal;padding-left:26px}}' +
      '.as-wtsec{font-size:.75rem;font-weight:750;letter-spacing:.03em;color:#6B7280;margin:16px 0 8px}' +
      '.as-wtnote{font-size:.74rem;color:#9CA3AF;line-height:1.6;margin-bottom:8px}' +
      '.as-wtnote b{color:#4B5563}' +
      '.as-wtgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}' +
      '.as-wtcard{border:1px solid #E5E7EB;border-radius:9px;padding:9px 11px;background:#fff}' +
      '.as-wtcard.warn{border-color:#FDE68A;background:#FFFBEB}' +
      '.as-wth{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}' +
      '.as-wtn{font-weight:700;font-size:.82rem;color:#111827}' +
      '.as-wtr{margin-left:auto;font-size:.72rem;color:#6B7280;font-variant-numeric:tabular-nums}' +
      '.as-wtv{margin-top:5px;font-size:.71rem;color:#9CA3AF;line-height:1.6;word-break:break-all}' +
      '.as-wtlayer{font-size:.65rem;font-weight:700;padding:1px 6px;border-radius:4px;border:1px solid transparent}' +
      '.as-wtlayer.core{background:#E9F0F9;border-color:#B7CFE9;color:#2563A8}' +
      '.as-wtlayer.auto{background:#E5F3EE;border-color:#A6D6C6;color:#127A5E}' +
      '.as-wtlayer.channel{background:#FBF2E1;border-color:#E7D2A3;color:#9A6414}' +
      '.as-wtlayer.work{background:#F3E9F9;border-color:#D8BCE9;color:#7A3FA8}' +
      '.as-wtlayer.status{background:#EEF0F3;border-color:#D5DAE1;color:#59626F}' +
      '.as-wtfreq{font-size:.65rem;font-weight:650;padding:1px 6px;border-radius:4px}' +
      '.as-wtfreq.fixed{background:#E5F3EE;color:#127A5E}' +
      '.as-wtfreq.common{background:#FBF2E1;color:#9A6414}' +
      '.as-wtfreq.rare{background:#FAE9E7;color:#B3382E}' +
      '.as-wtbar{height:4px;border-radius:2px;background:#E5E7EB;margin-top:6px;overflow:hidden}' +
      '.as-wtbar i{display:block;height:100%;background:#2563A8}' +
      /* 채널별 추가 열 — 채널 한 줄 = 라벨 + 블록들 + 추가 입력 */
      '.as-wtchbox{display:flex;flex-direction:column;gap:7px}' +
      '.as-wtchrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid #E5E7EB;border-radius:9px;padding:8px 12px;background:#fff}' +
      '.as-wtchlabel{flex:none;width:110px;font-size:.8rem;font-weight:700;color:#111827}' +
      '.as-wtchips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:200px}' +
      '.as-wtchnone{font-size:.74rem;color:#9CA3AF}' +
      '.as-wtchip{display:inline-flex;align-items:center;gap:3px;border:1px solid #BFDBFE;background:#EFF6FF;border-radius:7px;padding:3px 6px}' +
      '.as-wtchip b{font-size:.79rem;font-weight:650;color:#1D4ED8;padding:0 3px}' +
      '.as-wtchip button{width:20px;height:20px;border:none;background:transparent;border-radius:5px;cursor:pointer;font-size:.62rem;color:#60A5FA;line-height:1;padding:0}' +
      '.as-wtchip button:hover:not(:disabled){background:#DBEAFE;color:#1D4ED8}' +
      '.as-wtchip button:disabled{opacity:.25;cursor:default}' +
      '.as-wtchip button.x{color:#F87171;font-size:.68rem}' +
      '.as-wtchip button.x:hover{background:#FEE2E2;color:#B91C1C}' +
      /* 담긴 열 요약(읽기 전용) — 조절은 미리보기에서 한다 */
      '.as-wtchsum{display:flex;gap:5px;flex-wrap:wrap;align-items:center}' +
      '.as-wtchsum .as-wtchip{font-size:.76rem;font-weight:650;color:#1D4ED8;padding:2px 8px}' +
      '@media (max-width:640px){.as-wtchlabel{width:100%}}' +
      /* 지금 쓰는 열에서 고르기 — 후보 패널 */
      '.as-wtchgroup{display:flex;flex-direction:column;gap:5px}' +
      /* 열 구성 한 줄 미리보기 — 공통 행 바로 아래(표 머리 축소판) */
      '.as-wtpv{margin:-1px 0 3px;padding:8px 11px 9px;border:1px solid #E5E7EB;border-radius:9px;background:#FCFDFE}' +
      /* 채널·작업유형 알약 줄(시안 B) — 고르기 + [⚙ 관리] + [＋ 추가] 가 한 줄에 */
      '.as-wtpills{display:flex;flex-direction:column;gap:7px;margin-bottom:7px}' +
      '.as-wtpillrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid #E5E7EB;' +
        'border-radius:9px;padding:8px 12px;background:#fff}' +
      '.as-wtpillrow .pl{font-size:.68rem;font-weight:750;color:#9CA3AF;margin-right:3px;flex:none}' +
      '.as-wtpillrow .sp{flex:1;min-width:8px}' +
      '.as-wtpvp.gear{border-color:#D1D5DB;background:#fff;color:#6B7280}' +
      '.as-wtpvp.addp{border-style:dashed;border-color:#BFDBFE;background:#F8FBFF;color:#1D4ED8}' +
      '.as-wtpvp.addp:hover{background:#EFF6FF}' +
      /* [＋ 열 추가] 팝오버 · [⚙ 관리] 팝오버 */
      '.as-wtpop{border:1.5px solid #BFDBFE;background:#fff;border-radius:10px;padding:10px 12px;margin-top:8px;' +
        'box-shadow:0 6px 20px rgba(20,23,29,.08);max-width:520px}' +
      '.as-wtpop.mgr{max-width:560px;border-color:#D1D5DB}' +
      '.as-wtpoph{font-size:.73rem;color:#6B7280;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}' +
      '.as-wtpoph b{color:#1D4ED8;font-size:.78rem}' +
      '.as-wtpoph span{color:#9CA3AF}' +
      '.as-wtpopx{margin-left:auto;border:1px solid #D1D5DB;background:#fff;color:#6B7280;border-radius:6px;' +
        'font-size:.7rem;padding:2px 9px;cursor:pointer}' +
      '.as-wtpoptg{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}' +
      '.as-wtpopin{display:flex;gap:6px;align-items:center;margin-bottom:8px}' +
      '.as-wtpopin input{flex:1;min-width:120px;padding:6px 10px;border:1.5px solid #D1D5DB;border-radius:8px;' +
        'font-size:.8rem;outline:none;background:#fff;color:#111827}' +
      '.as-wtpopadd{flex:none;border:1.5px solid #2563EB;background:#2563EB;color:#fff;border-radius:8px;' +
        'font-size:.78rem;font-weight:700;padding:6px 14px;cursor:pointer}' +
      '.as-wtpopfoot{font-size:.68rem;color:#9CA3AF;margin-top:7px}' +
      '.as-wtmgrrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid #E5E7EB;border-radius:8px;' +
        'padding:6px 10px;margin-bottom:5px;font-size:.8rem}' +
      '.as-wtmgrrow.fixed{opacity:.6}' +
      '.as-wtmgrrow .nm{font-weight:700;flex:1;min-width:110px}' +
      '.as-wtmgrrow .nm i{font-style:normal;font-weight:400;font-size:.72rem;color:#9CA3AF}' +
      '.as-wtmgrrow .cnt{font-size:.71rem;color:#9CA3AF}' +
      '.as-wtmgrrow .fx{font-size:.71rem;color:#9CA3AF}' +
      '.as-wtmgrrow button{border:1.5px solid #D1D5DB;background:#fff;color:#374151;border-radius:7px;' +
        'font-size:.72rem;font-weight:650;padding:3px 10px;cursor:pointer}' +
      '.as-wtmgrrow button.del{border-color:#FECACA;background:#FEF2F2;color:#B91C1C}' +
      /* 작업유형 만들기·고치기 모달 — ★ body 직속 마운트(스크롤 컨테이너 안에 두면 흐름에 섞인다) */
      '.as-wtmodalwrap{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9200;display:flex;' +
        'align-items:flex-start;justify-content:center;padding:44px 16px;overflow:auto}' +
      '.as-wtmodal{background:#fff;border-radius:14px;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,.3);' +
        'overflow:hidden;color:#111827}' +
      '.as-wtmodal .mh{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid #E5E7EB;' +
        'font-size:.9rem;font-weight:750}' +
      '.as-wtmodal .mh .x{border:none;background:transparent;color:#9CA3AF;font-size:.9rem;cursor:pointer}' +
      '.as-wtmodal .mb{padding:14px 16px;display:flex;flex-direction:column;gap:11px}' +
      '.as-wtmodal .mf{padding:12px 16px;border-top:1px solid #E5E7EB;display:flex;gap:8px;align-items:center}' +
      '.as-wtmodal .mf button{border:1.5px solid #D1D5DB;background:#fff;color:#374151;border-radius:8px;' +
        'font-size:.8rem;font-weight:700;padding:6px 15px;cursor:pointer}' +
      '.as-wtmodal .mf button.pri{border-color:#2563EB;background:#2563EB;color:#fff}' +
      '.as-wtmodalnote{font-size:.75rem;color:#6B7280;background:#F9FAFB;border:1px solid #E5E7EB;' +
        'border-radius:8px;padding:8px 11px;line-height:1.6}' +
      '.as-wtmodal .fld{display:flex;flex-direction:column;gap:4px}' +
      '.as-wtmodal .fld label{font-size:.73rem;font-weight:700;color:#6B7280}' +
      '.as-wtmodal .fld label i{font-style:normal;font-weight:400;color:#9CA3AF}' +
      '.as-wtmodal .fld input,.as-wtmodal .fld select{padding:7px 10px;border:1.5px solid #D1D5DB;border-radius:8px;' +
        'font-size:.82rem;outline:none;background:#fff;color:#111827}' +
      '.as-wtmodal .hint{font-size:.7rem;color:#9CA3AF;line-height:1.6}' +
      '.as-wtmodalwarn{display:block;font-size:.72rem;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;' +
        'border-radius:7px;padding:6px 9px;margin-top:5px;line-height:1.6}' +
      '.as-wtmodalwarn button{margin-left:6px;border:1px solid #FDE68A;background:#fff;color:#92400E;' +
        'border-radius:6px;font-size:.7rem;font-weight:700;padding:2px 9px;cursor:pointer}' +
      '.as-wtmodal .hint b{color:#4B5563}' +
      '.as-wtseg{display:inline-flex;border:1.5px solid #D1D5DB;border-radius:8px;overflow:hidden;align-self:flex-start}' +
      '.as-wtseg button{border:none;border-right:1px solid #E5E7EB;background:#fff;color:#6B7280;' +
        'font-size:.76rem;font-weight:700;padding:5px 13px;cursor:pointer}' +
      '.as-wtseg button:last-child{border-right:none}' +
      '.as-wtseg button.on{background:#F3E9F9;color:#7A3FA8}' +
      '.as-wtseg button i{font-style:normal;font-weight:400;font-size:.66rem;opacity:.75}' +
      '.as-wtchsum .as-wtchip button{width:18px;height:18px;border:none;background:transparent;color:#F87171;' +
        'font-size:.62rem;cursor:pointer;padding:0;margin-left:2px}' +
      '.as-wtpvp{border:1.5px solid #D1D5DB;background:#fff;color:#6B7280;border-radius:999px;' +
        'font-size:.71rem;font-weight:700;padding:3px 11px;cursor:pointer;line-height:1.4}' +
      '.as-wtpvp:hover{background:#F9FAFB}' +
      '.as-wtpvp.on{border-color:#2563EB;background:#EFF6FF;color:#1D4ED8}' +
      '.as-wtpvp.t.on{border-color:#A855F7;background:#F3E9F9;color:#7A3FA8}' +
      '.as-wtpvh{font-size:.71rem;font-weight:750;color:#4B5563;margin-bottom:6px}' +
      '.as-wtpvh span{font-weight:400;color:#9CA3AF}' +
      '.as-wtpvempty{font-size:.73rem;color:#9CA3AF}' +
      /* ★ 한 줄 고정: 칸은 균등 압축(flex:1 1 0 + min-width:0), 넘치는 이름만 말줄임.
           줄바꿈·가로 스크롤을 쓰면 "한눈에"가 깨진다(제목이 잘려도 title 에 전체가 남는다). */
      '.as-wtpvrow{display:flex;align-items:stretch;border:1px solid #DCE3EC;border-radius:7px;overflow:hidden;background:#fff}' +
      /* ★ flex:0 1 auto — 칸을 **내용 너비**로 두고 넘칠 때만 줄인다. `1 1 0`(균등)으로 두면
           열이 15개만 돼도 짧은 이름까지 같이 좁아져 "구매...·계좌...·결제..."로 전부 잘린다(실측). */
      '.as-wtpvc{flex:0 1 auto;min-width:0;padding:5px 7px;font-size:.68rem;font-weight:650;color:#374151;text-align:center;cursor:pointer;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-right:1px solid #EDF0F4;background:#F8FAFC}' +
      '.as-wtpvc:last-child{border-right:none}' +
      /* 선택 칸 — 조절 대상 표시(outline 은 안쪽으로 그려 한 줄 높이 불변) */
      '.as-wtpvc.sel{outline:2px solid #2563EB;outline-offset:-2px}' +
      '.as-wtpvc.core{background:#E9F0F9;color:#2563A8}' +
      '.as-wtpvc.auto{background:#E5F3EE;color:#127A5E}' +
      '.as-wtpvc.channel{background:#FBF2E1;color:#9A6414}' +
      '.as-wtpvc.work{background:#F3E9F9;color:#7A3FA8}' +
      '.as-wtpvc.status{background:#EEF0F3;color:#59626F}' +
      '.as-wtpvc.dup{box-shadow:inset 0 -2px 0 #F59E0B}' +
      /* 어느 묶음에서 온 칸인지 — 아래 테두리 색으로 구분(채널=황색·유형=보라) */
      '.as-wtpvc.o-channel{border-bottom:2px solid #E7D2A3}' +
      '.as-wtpvc.o-worktype{border-bottom:2px solid #D8BCE9}' +
      '.as-wtpvc.add{flex:0 0 auto;padding:5px 8px;background:#fff;color:#9CA3AF;font-weight:600;border-left:1px dashed #CBD5E1;cursor:default}' +
      /* 선택 열 조절 툴바 — 미리보기 줄 아래 별도 행(줄 자체는 계속 한 줄 유지) */
      '.as-wtpvtool{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px;padding:6px 9px;' +
        'border:1px solid #DBEAFE;background:#F5F9FF;border-radius:7px;font-size:.74rem}' +
      '.as-wtpvtool b{color:#1D4ED8;font-size:.76rem}' +
      '.as-wtpvtool .m{color:#6B7280}' +
      '.as-wtpvtool button{border:1px solid #BFDBFE;background:#fff;color:#1D4ED8;border-radius:6px;font-size:.71rem;font-weight:650;padding:3px 9px;cursor:pointer;line-height:1.3}' +
      '.as-wtpvtool button:hover:not(:disabled){background:#DBEAFE}' +
      '.as-wtpvtool button:disabled{opacity:.35;cursor:default}' +
      '.as-wtpvtool button.x{color:#B91C1C;border-color:#FECACA}' +
      '.as-wtpvtool button.x:hover{background:#FEE2E2}' +
      '.as-wtpvtool button.c{margin-left:auto;color:#6B7280;border-color:#D1D5DB}' +
      /* 공통 행 — 채널 행보다 한 단계 강조(모든 채널에 들어가는 열이라 성격이 다르다) */
      '.as-wtchgroup.common .as-wtchrow{border-color:#BFDBFE;background:#F8FBFF}' +
      '.as-wtchgroup.common .as-wtchlabel{color:#1D4ED8}' +
      '.as-wtchlabel i{font-style:normal;font-weight:500;font-size:.7rem;color:#9CA3AF;display:block}' +
      '.as-wtpick{border:1px solid #BFDBFE;background:#F8FBFF;border-radius:9px;padding:9px 11px;margin:2px 0 4px}' +
      '.as-wtpickhead{font-size:.73rem;color:#6B7280;line-height:1.6;margin-bottom:7px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}' +
      '.as-wtpickhead b{color:#1D4ED8}' +
      '.as-wtpickx{margin-left:auto;border:1px solid #D1D5DB;background:#fff;color:#6B7280;border-radius:6px;font-size:.7rem;padding:2px 8px;cursor:pointer}' +
      '.as-wtpicknone{font-size:.74rem;color:#9CA3AF;padding:4px 2px}' +
      '.as-wtpicklist{display:flex;flex-wrap:wrap;gap:5px;max-height:190px;overflow-y:auto}' +
      '.as-wtpickchip{display:inline-flex;align-items:center;gap:4px;border:1px solid #D1D5DB;background:#fff;color:#111827;' +
        'border-radius:7px;padding:4px 8px;font-size:.78rem;cursor:pointer;line-height:1.2}' +
      '.as-wtpickchip:hover:not(:disabled){border-color:#60A5FA;background:#EFF6FF;color:#1D4ED8}' +
      '.as-wtpickchip.dup{opacity:.5;cursor:default;background:#F3F4F6}' +
      '.as-wtpickn{font-style:normal;font-size:.68rem;color:#9CA3AF;background:#F3F4F6;border-radius:4px;padding:1px 4px}' +
      '.as-wtpickok{font-style:normal;color:#127A5E;font-size:.72rem}';
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

    if (list.length < 2) {
      /* 패널 1개(대시보드의 리뷰어 공지 카드·AE 의 닉네임)는 목차가 의미 없다 — 종전 그대로 그린다. */
      _navKeys = [];
      el.innerHTML = list.map(function (k) { return PANELS[k](); }).join('');
    } else {
      /* 시안 B — 좌측 목차 + 한 번에 한 묶음.
         ★ 패널은 전부 그려 두고 보이기만 토글한다(asSelectPanel 주석 참조).
         ★ 초기 선택은 지난번에 보던 묶음(없으면 첫 항목) — 저장하러 다시 들어오는 화면이라
           매번 첫 항목으로 되돌아가면 같은 클릭을 반복하게 된다. */
      _navKeys = list.slice();
      var init = list[0];
      try { var last = sessionStorage.getItem('as_panel'); if (last && list.indexOf(last) >= 0) init = last; } catch (_) {}
      var nav = list.map(function (k) {
        var m = PANEL_NAV[k] || { ic: '•', nm: k };
        return '<button type="button" class="as-bitem' + (k === init ? ' on' : '') + '" id="asNav_' + k + '"' +
          ' onclick="asSelectPanel(\'' + k + '\')">' +
          '<span class="ic">' + m.ic + '</span><span class="nm">' + escHtml(m.nm) + '</span>' +
          '<span class="as-bbadge" id="asBadge_' + k + '">–</span></button>';
      }).join('');
      var secs = list.map(function (k) {
        return '<section class="as-bsec' + (k === init ? ' on' : '') + '" id="asSec_' + k + '">' + PANELS[k]() + '</section>';
      }).join('');
      el.innerHTML =
        '<div class="as-b">' +
          '<nav class="as-bnav"><div class="as-bnavt">설정 항목</div>' + nav +
            '<div class="as-bnavfoot">숫자는 <b>등록 현황</b>입니다 — 비어 있는 설정이 목차에서 바로 보입니다.</div>' +
          '</nav>' +
          '<div class="as-bmain">' + secs + '</div>' +
        '</div>';
    }
    if (o.autoload !== false) list.forEach(function (k) { try { LOADERS[k](); } catch (_) {} });
    return true;
  }

  window.AdminSettings = { mount: mount, panels: Object.keys(PANELS) };

  /* 전역 노출 — 생성 HTML 의 onclick 문자열과 index-app.js 의 탭 전환 훅이 이 이름들을 부른다.
     ★ index-app.js 에는 같은 이름의 선언이 남아 있으면 안 된다(뒤에 로드되어 이걸 덮는다). */
  window.asSelectPanel = asSelectPanel;   /* 목차 버튼 onclick */
  window.loadMyNickname = loadMyNickname;
  window.saveMyNickname = saveMyNickname;
  window.loadCompanyBusinessNo = loadCompanyBusinessNo;
  window.saveCompanyBusinessNo = saveCompanyBusinessNo;
  window.uploadCashReceiptGuide = uploadCashReceiptGuide;
  window.clearCashReceiptGuide = clearCashReceiptGuide;
  window.CR_GUIDE_CHANNELS = CR_GUIDE_CHANNELS;
  window.loadAiSamples = loadAiSamples;
  window.loadInspectMessages = loadInspectMessages;
  window.saveInspectMessages = saveInspectMessages;
  window._imsgReset = _imsgReset;
  window.uploadAiSample = uploadAiSample;
  window.clearAiSample = clearAiSample;
  /* ★ onclick 에서 부르는 함수는 window 노출 필수 — 빠지면 클릭이 조용히 ReferenceError */
  window._smpZoom = _smpZoom;
  window._smpZoomStep = _smpZoomStep;
  window._smpZoomClose = _smpZoomClose;
  window._smpZoomDel = _smpZoomDel;
  window.previewRouteSweep = previewRouteSweep;   // 오제출 소급 정리(미리보기)
  window.runRouteSweep = runRouteSweep;           // 오제출 소급 정리(실행)
  window.loadReviewTypeCleanup = loadReviewTypeCleanup;
  window.reviewTypeCleanupRun = reviewTypeCleanupRun;
  window.loadManagerCleanup = loadManagerCleanup;
  window.managerCleanupRun = managerCleanupRun;
  window.deliveryCleanupRun = deliveryCleanupRun;
  window.captureLinkRun = captureLinkRun;   // 📎 구매 캡처 연결 복구(onclick 에서 부른다)
  window.saveGateCriteria = saveGateCriteria;       /* 블랙리스트 관리기준(091) 저장 버튼 onclick */
  window.loadGateCriteria = loadGateCriteria;
  window.loadWorktableTemplate = loadWorktableTemplate;
  window.wtAddCol = wtAddCol;
  window.wtDelCol = wtDelCol;
  window.wtMoveCol = wtMoveCol;
  window.wtPvSel = wtPvSel;
  window.wtPvMove = wtPvMove;
  window.wtPvDel = wtPvDel;
  window.wtPvChan = wtPvChan;
  window.wtPvType = wtPvType;
  window.wtAddChannel = wtAddChannel;
  window.wtDelChannel = wtDelChannel;
  window.wtOpenTypeModal = wtOpenTypeModal;
  window.wtCloseTypeModal = wtCloseTypeModal;
  window.wtTypePos = wtTypePos;
  window.wtTypeColAdd = wtTypeColAdd;
  window.wtTypeColDel = wtTypeColDel;
  window.wtTypeSave = wtTypeSave;
  window.wtReloadTriggers = wtReloadTriggers;
  window._wtTypeSync = _wtTypeSync;
  window.wtOpenChanMgr = wtOpenChanMgr;
  window.wtOpenTypeMgr = wtOpenTypeMgr;
  window.wtRenameChannel = wtRenameChannel;
  window.wtAddOpen = wtAddOpen;
  window.wtAddClose = wtAddClose;
  window.wtAddTarget = wtAddTarget;
  window.wtAddSubmit = wtAddSubmit;
  window.wtAddPick = wtAddPick;
  window._wtAddFilter = _wtAddFilter;
  window.wtDelType = wtDelType;
  window.wtChAdd = wtChAdd;
  window.wtChDel = wtChDel;
  window.wtChMove = wtChMove;
  window.wtLoadPreset = wtLoadPreset;
  window.wtLoadSuggested = wtLoadSuggested;
  window.wtSaveTemplate = wtSaveTemplate;
  window.wtToggleReport = wtToggleReport;
  window.loadReviewerNoticesAdmin = loadReviewerNoticesAdmin;
  window.loadReviewerHomeBanner = loadReviewerHomeBanner;
  window.uploadReviewerHomeBanner = uploadReviewerHomeBanner;
  window.saveReviewerHomeBanner = saveReviewerHomeBanner;
  window.saveReviewerNotice = saveReviewerNotice;
  window.toggleReviewerNoticeForm = toggleReviewerNoticeForm;
  window.editReviewerNotice = editReviewerNotice;
  window.cancelReviewerNoticeEdit = cancelReviewerNoticeEdit;
  window.toggleReviewerNotice = toggleReviewerNotice;
  window.deleteReviewerNotice = deleteReviewerNotice;
})();
