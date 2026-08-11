/* ══════════════════════════════════════════════════════════════
   C/S 문의창구 (공유 모듈)

   원래 admin.html 인라인 마크업 + index-app.js 안에만 있던 화면 코드를 **모듈로 뺐다**.
   리뷰웹시스템[3버전]에서도 같은 문의창구를 써야 하는데, 사본을 만들면 답장·메모·상태변경 중
   하나만 고쳐도 두 화면이 갈라진다(모집공고 모달·작업오더 상세와 같은 규율).

   ★ 함수명·본문은 한 글자도 바꾸지 않았다 — 생성 HTML 안의 onclick 문자열
     (csSendReply·csSaveMemo·csToggleStatus·csViewImage·csOpenConversation·
     csPickFiles·csRemoveAttach·csHandlePaste…)과
     index-payment.js 의 SSE 훅(window.csOnSSE), 회귀가드가 이름으로 묶여 있다.
   ★ 호스트 전역(escHtml·showToast)이 없는 화면(리뷰웹시스템[3버전])을 위해 폴백을 둔다.
   ★ 서버 경로는 **api.js 의 `window.CS_API_BASE` 재기준**으로 갈아끼운다 —
     리뷰웹시스템[3버전]은 `/api/trackb/cs/*`(인트라넷 SSO 토큰이 도달 가능한 유일한 경로).

   사용: <div id="csInquiryMount"></div> + <script src="js/cs-inquiry.js"></script>
   ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* escHtml — 호스트(index-app.js)의 것을 쓰되 **호출 시점에** 찾는다.
     ★ 로드 시점에 캡처하면 안 된다: 이 모듈은 index-app.js **앞에** 로드되므로
       그때는 window.escHtml 이 아직 없어 늘 폴백이 잡힌다. 폴백이 원본과 한 글자라도
       다르면(예: null 처리, 작은따옴표 이스케이프) 관리자 화면 출력이 조용히 달라진다.
     ★ 폴백은 index-app.js 의 escHtml 과 **동일 구현**(String(s) · & < > " 만). */
  function _escFallback(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escHtml(s) {
    var h = (typeof window !== "undefined") && window.escHtml;
    return (typeof h === "function" && h !== escHtml) ? h(s) : _escFallback(s);
  }
  var showToast = function (msg, isErr) {
    if (typeof window.showToast === "function") return window.showToast(msg, isErr);
    if (typeof window._toast === "function") return window._toast(msg);
    console.log("[cs]", msg);
  };

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
  // ★ 캠페인별 그룹핑 — 캠페인(작업) 아래에 문의를 보낸 리뷰어들이 나열된다.
  //   (기존 리뷰어별 그룹핑 대체: 같은 작업의 문의를 한자리에서 처리)
  // ★ campaignKey 자체에 "||"가 들어있어 문자열 합성 키는 쓸 수 없다 → 값에 라벨을 함께 보관
  const groups = new Map();
  list.forEach(r => {
    const key = r.campaignKey || "";
    if (!groups.has(key)) groups.set(key, { label: r.campaignLabel || "문의", rows: [] });
    groups.get(key).rows.push(r);
  });
  let html = "";
  for (const [campKey, grp] of groups) {
    const campLabel = grp.label;
    const rooms = grp.rows;
    const unread = rooms.reduce((s, r) => s + (r.adminUnread || 0), 0);
    const isGeneral = !campKey;
    html += `<div style="padding:10px 13px;background:${isGeneral ? '#F7F5FF' : '#f1f6ff'};border-bottom:1px solid ${isGeneral ? '#E3DDFF' : '#e3ecfa'}">
      <div style="display:flex;align-items:center;gap:7px">
        <i class="fas ${isGeneral ? 'fa-comment-dots' : 'fa-bullhorn'}" style="color:${isGeneral ? '#7C3AED' : '#3182f6'};font-size:.78rem;flex-shrink:0"></i>
        <span style="font-weight:800;color:${isGeneral ? '#5B21B6' : '#1E3A8A'};font-size:.82rem;line-height:1.4;flex:1;min-width:0">${escHtml(campLabel)}</span>
        ${unread > 0 ? `<span style="background:#EF4444;color:#fff;font-size:.64rem;font-weight:800;padding:1px 7px;border-radius:9px;flex-shrink:0">미확인 ${unread}</span>` : ''}
      </div>
      <div style="font-size:.68rem;color:#64748B;margin-top:3px">문의 리뷰어 ${rooms.length}명</div>
    </div>`;
    rooms.forEach(r => {
      const nameSafe = (r.reviewerName || "").replace(/'/g, "\\'");
      const phoneSafe = (r.reviewerPhone8 || "").replace(/'/g, "\\'");
      const initial = escHtml((r.reviewerName || "?").trim().charAt(0) || "?");
      const closedChip = r.status === 'closed'
        ? '<span style="background:#F3F4F6;color:#6B7280;font-size:.64rem;padding:1px 6px;border-radius:7px;flex-shrink:0">종료</span>' : '';
      html += `<div class="cs-room-row" data-tid="${r.id}" onclick="csOpenConversation('${r.id}','${nameSafe}','${phoneSafe}')"
        style="padding:9px 13px 9px 20px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:9px">
        <div style="width:26px;height:26px;border-radius:50%;background:#E2E8F0;color:#64748B;display:flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:700;flex-shrink:0">${initial}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:5px">
            <span style="font-weight:700;color:var(--t1,#0F172A);font-size:.8rem">${escHtml(r.reviewerName || '-')}</span>
            <span style="color:#94a3b8;font-size:.68rem;font-family:monospace">${escHtml(r.reviewerPhone8 || '')}</span>
            ${closedChip}
            ${r.adminMemo ? '<i class="fas fa-lock" title="관리자 메모 있음" style="color:#D97706;font-size:.6rem"></i>' : ''}
          </div>
          <div style="color:var(--t3,#94A3B8);font-size:.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.lastMessagePreview || '')}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="color:#B6BECB;font-size:.66rem">${_csTimeAgo(r.lastMessageAt)}</div>
          ${r.adminUnread > 0 ? `<span style="display:inline-block;margin-top:2px;background:#EF4444;color:#fff;font-size:.64rem;font-weight:800;padding:1px 6px;border-radius:9px">${r.adminUnread}</span>` : ''}
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
      <i class="fas fa-comments" style="color:var(--p,#3182F6)"></i>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:.9rem;color:var(--t1,#0F172A)">${escHtml(reviewerName)} <span style="color:#94a3b8;font-weight:400;font-size:.76rem;font-family:monospace">${escHtml(reviewerPhone8)}</span></div>
        <div id="csConvCampaign" style="font-size:.74rem;color:var(--t3,#94A3B8)">불러오는 중...</div>
      </div>
      <button id="csConvStatusBtn" onclick="csToggleStatus()" style="padding:5px 10px;background:#F3F4F6;color:#374151;border:none;border-radius:8px;font-size:.74rem;font-weight:600;cursor:pointer">—</button>
    </div>
    <!-- ★ 미리 보는 정보: 이 캠페인에서 그 리뷰어의 주문정보 + 참여이력 -->
    <div id="csCtxWrap" style="display:flex;gap:10px;padding:11px 15px;background:#fbfcfe;border-bottom:1px solid #eef2f7">
      <div style="flex:1;color:#9CA3AF;font-size:.78rem"><i class="fas fa-circle-notch fa-spin"></i> 주문정보 불러오는 중...</div>
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
    <div id="csAttachBar" style="display:none;padding:8px 12px 0;gap:6px;flex-wrap:wrap"></div>
    <div id="csReplyDropZone" style="padding:10px 12px;border-top:1px solid #eef2f7;display:flex;gap:8px;align-items:flex-end;position:relative">
      <input type="file" id="csAttachFile" accept="image/*" multiple style="display:none" onchange="csPickFiles(this)">
      <button onclick="document.getElementById('csAttachFile').click()" title="사진 첨부"
        style="width:40px;height:40px;border:1px solid #e5e7eb;background:#fff;color:#6B7280;border-radius:10px;font-size:1rem;cursor:pointer;flex-shrink:0"><i class="fas fa-image"></i></button>
      <textarea id="csReplyText" rows="2" placeholder="답장 입력... (Shift+Enter 줄바꿈, 사진 붙여넣기·드래그 가능)" style="flex:1;resize:none;border:1px solid #e5e7eb;border-radius:10px;padding:9px;font-size:.82rem;font-family:inherit;outline:none"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();csSendReply('${threadId}');}"
        onpaste="csHandlePaste(event)"></textarea>
      <button onclick="csSendReply('${threadId}')" style="padding:10px 16px;background:#3182f6;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:.82rem;cursor:pointer;white-space:nowrap"><i class="fas fa-paper-plane"></i></button>
      <div id="csDropOverlay" style="display:none;position:absolute;inset:0;background:rgba(49,130,246,.08);border:2px dashed #3182f6;border-radius:10px;align-items:center;justify-content:center;color:#1B64DA;font-size:.82rem;font-weight:700;pointer-events:none">
        <i class="fas fa-image" style="margin-right:6px"></i> 여기에 이미지를 놓으세요
      </div>
    </div>`;
  _csPending = [];   // 방을 바꾸면 이전 첨부는 버린다
  csRenderAttachBar();
  _csBindDropZone();
  await csReloadConversation(threadId);
  csLoadOrderContext(threadId);
}

/* ── 관리자 답장 사진 첨부: 파일선택 · Ctrl+V 붙여넣기 · 드래그앤드롭 공통 처리 ──
   업로드 인프라는 리뷰어측(csReviewerUpload)과 동일한 guide-image Drive+프록시 재사용. */
let _csPending = [];   // [{name, dataUrl, url}] — url은 업로드 완료 후 채워짐

function csRenderAttachBar() {
  const bar = document.getElementById("csAttachBar");
  if (!bar) return;
  if (!_csPending.length) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = _csPending.map((p, i) => `
    <div style="position:relative;width:58px;height:58px;border-radius:9px;overflow:hidden;border:1px solid #E5E7EB;background:#F3F4F6">
      <img src="${escHtml(p.dataUrl)}" style="width:100%;height:100%;object-fit:cover;${p.url ? '' : 'opacity:.5'}">
      ${p.url ? '' : '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#3182f6"><i class="fas fa-circle-notch fa-spin"></i></div>'}
      <button onclick="csRemoveAttach(${i})" style="position:absolute;top:2px;right:2px;width:17px;height:17px;border:none;border-radius:50%;background:rgba(17,24,39,.65);color:#fff;font-size:.58rem;cursor:pointer;line-height:1">✕</button>
    </div>`).join("");
}

function csRemoveAttach(i) { _csPending.splice(i, 1); csRenderAttachBar(); }

async function _csUploadFile(f) {
  if (_csPending.length >= 5) { showToast("사진은 최대 5장까지 첨부할 수 있어요"); return; }
  if (!/^image\//.test(f.type)) { showToast("사진 파일만 첨부할 수 있어요"); return; }
  if (f.size > 8 * 1024 * 1024) { showToast("8MB 이하 사진만 첨부할 수 있어요"); return; }
  const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  const item = { name: f.name || `paste_${Date.now()}.png`, dataUrl, url: "" };
  _csPending.push(item);
  csRenderAttachBar();
  try {
    const d = await gasPost({ action: "csAdminUpload", fileName: item.name, mimeType: f.type || "image/png", imageBase64: dataUrl }, 120000);
    if (!d || d.ok === false || !d.url) throw new Error((d && d.error) || "업로드 실패");
    item.url = d.url;
  } catch (e) {
    showToast("사진 업로드 실패: " + e.message, true);
    const idx = _csPending.indexOf(item);
    if (idx > -1) _csPending.splice(idx, 1);
  }
  csRenderAttachBar();
}

async function csPickFiles(input) {
  const files = [...(input.files || [])];
  input.value = "";   // 같은 파일 다시 고를 수 있게
  for (const f of files) await _csUploadFile(f);
}

/** Ctrl+V로 클립보드 이미지 붙여넣기(캡처 도구·복사한 이미지 모두 지원) */
async function csHandlePaste(event) {
  const items = [...((event.clipboardData && event.clipboardData.items) || [])];
  const imgItems = items.filter(it => it.kind === 'file' && /^image\//.test(it.type));
  if (!imgItems.length) return;   // 텍스트 붙여넣기는 기본 동작 유지
  event.preventDefault();
  for (const it of imgItems) {
    const f = it.getAsFile();
    if (f) await _csUploadFile(f);
  }
}

/** 답장 입력창 주변에 이미지를 드래그해서 놓으면 첨부(입력창 자체의 드롭도 동일 처리) */
function _csBindDropZone() {
  const zone = document.getElementById("csReplyDropZone");
  const overlay = document.getElementById("csDropOverlay");
  if (!zone) return;
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  zone.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (overlay) overlay.style.display = 'flex';
  });
  zone.addEventListener('dragleave', (e) => {
    if (e.target === zone && overlay) overlay.style.display = 'none';
  });
  zone.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (overlay) overlay.style.display = 'none';
    const files = [...(e.dataTransfer.files || [])];
    for (const f of files) await _csUploadFile(f);
  });
}

/* ── 미리 보는 정보(주문정보·참여이력) ── */
async function csLoadOrderContext(threadId) {
  const wrap = document.getElementById("csCtxWrap");
  if (!wrap) return;
  try {
    const d = await gasGet({ action: "csAdminOrderContext", threadId });
    if (!d || d.ok === false) throw new Error((d && d.error) || "불러오기 실패");
    if (_csActiveThreadId !== threadId) return;   // 그새 다른 방으로 이동
    wrap.innerHTML = _csCtxHtml(d);
  } catch (err) {
    if (_csActiveThreadId !== threadId) return;
    wrap.innerHTML = `<div style="flex:1;color:#9CA3AF;font-size:.76rem">주문정보를 불러오지 못했습니다 (${escHtml(err.message)})</div>`;
  }
}

function _csCtxHtml(d) {
  const o = d.order, s = d.sheet, h = d.history || {};
  const kv = (k, v) => `<div style="color:#94A3B8">${k}</div><div style="color:#334155;font-weight:600;word-break:break-all">${escHtml(v || '-')}</div>`;
  const chip = (t, c) => {
    const col = { g:['#D1FAE5','#065F46'], y:['#FEF3C7','#92400E'], r:['#FEE2E2','#991B1B'], b:['#E0EDFF','#1D4ED8'] }[c] || ['#F3F4F6','#6B7280'];
    return `<span style="font-size:.66rem;font-weight:700;padding:2px 7px;border-radius:6px;background:${col[0]};color:${col[1]}">${escHtml(t)}</span>`;
  };
  // 주문정보 카드
  let orderCard;
  if (!o && !s) {
    orderCard = `<div style="flex:1;min-width:0;background:#fff;border:1px solid #E7EBF2;border-radius:10px;padding:10px 12px">
      <div style="font-size:.72rem;font-weight:800;color:#1E3A8A;margin-bottom:5px">🧾 이 캠페인의 주문정보</div>
      <div style="font-size:.76rem;color:#9CA3AF">이 캠페인에서 제출된 구매양식이 없습니다.<br>(일반 문의이거나 아직 주문 전)</div>
    </div>`;
  } else {
    const chips = [];
    if (o) chips.push(o.mirrorStatus === 'written' ? chip('시트반영 완료','g')
                     : o.mirrorStatus === 'stuck_manual' ? chip('수동입력 필요','r')
                     : chip('시트반영 대기','y'));
    if (s) { chips.push(s.isSubmitted ? chip('리뷰 제출','b') : chip('리뷰 미제출','y'));
             chips.push(s.isPaid ? chip('입금 완료','g') : chip('입금 대기','y')); }
    if (o && o.captureFileId) chips.push(chip('캡처 첨부','g'));
    const rowTxt = (o && o.sheetRow) ? `시트 ${o.sheetRow}행` : (s && s.rowIndex ? `시트 ${s.rowIndex}행` : '');
    orderCard = `<div style="flex:1;min-width:0;background:#fff;border:1px solid #E7EBF2;border-radius:10px;padding:10px 12px">
      <div style="font-size:.72rem;font-weight:800;color:#1E3A8A;margin-bottom:7px">🧾 이 캠페인의 주문정보 ${rowTxt ? `<span style="font-weight:400;color:#94A3B8">· ${escHtml(rowTxt)}</span>` : ''}</div>
      <div style="display:grid;grid-template-columns:66px 1fr;gap:3px 8px;font-size:.74rem">
        ${o ? kv('주문번호', o.orderNum) : ''}
        ${o ? kv('주문자', o.orderer) : ''}
        ${o ? kv('수취인', o.recipient) : ''}
        ${o ? kv('연락처', o.phone) : ''}
        ${o ? kv('배송주소', o.address) : ''}
        ${(o && o.option) ? kv('옵션', o.option) : ''}
        ${(s && s.payAmount) ? kv('결제금액', s.payAmount) : ''}
        ${o ? kv('구매일자', o.dateStr) : ''}
        ${(s && s.productName) ? kv('상품명', s.productName) : ''}
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">${chips.join('')}</div>
    </div>`;
  }
  // 참여이력 카드
  const histCard = `<div style="width:250px;flex-shrink:0;background:#fff;border:1px solid #E7EBF2;border-radius:10px;padding:10px 12px">
    <div style="font-size:.72rem;font-weight:800;color:#1E3A8A;margin-bottom:7px">📋 참여 이력 <span style="font-weight:400;color:#94A3B8">· 총 ${h.total || 0}건</span></div>
    <div style="display:grid;grid-template-columns:70px 1fr;gap:3px 8px;font-size:.74rem">
      ${kv('이 캠페인', (h.campaignJoins || 0) + '회 참여' + ((s && s.round) ? ` (${s.round})` : ''))}
      ${kv('누적 제출', `${h.submitted || 0}건 / ${h.total || 0}건`)}
      ${kv('입금 완료', `${h.paid || 0}건`)}
      ${kv('최근 문의', `${h.inquiryThreads || 0}건 (${h.inquiryCampaigns || 0}개 캠페인)`)}
    </div>
  </div>`;
  return orderCard + histCard;
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
    const imgs = Array.isArray(m.imageUrls) ? m.imageUrls : [];
    const imgHtml = imgs.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;max-width:78%;margin-top:${m.content ? '4px' : '0'}">` +
      imgs.map(u => `<img src="${escHtml(u)}" alt="첨부 사진" onclick="csViewImage('${escHtml(u)}')"
        style="width:120px;height:120px;object-fit:cover;border-radius:10px;border:1px solid #e5e7eb;cursor:zoom-in;background:#fff">`).join('') + `</div>` : '';
    // 검수 결과(반려·이동) — 리뷰어에게 나간 문구와 사진을 관리자도 같은 모양으로 본다.
    if (m.msgType === 'inspect_result' && window.CsReviewEditCard && window.CsReviewEditCard.inspectHtml) {
      const ts1 = m.createdAt ? new Date(m.createdAt).toLocaleString("ko-KR", { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : "";
      return `<div style="display:flex;flex-direction:column;align-items:flex-end">
        <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${escHtml(m.senderName || '관리자')}</div>
        <div style="max-width:86%;background:#EFF6FF;border-radius:14px 4px 14px 14px;padding:10px 12px;font-size:.85rem;line-height:1.55;white-space:pre-wrap">${escHtml(m.content || '')}
          ${window.CsReviewEditCard.inspectHtml(m.meta || {})}</div>
        <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${ts1}</div>
      </div>`;
    }
    // 리뷰이미지 교체요청은 **카드**로 — 기존↔변경 이미지와 승인/반려를 대화 안에서 바로.
    //   렌더러는 리뷰어 화면·전용 탭과 공용(js/cs-review-edit-card.js) — 사본 금지.
    if (m.msgType === 'review_edit' && window.CsReviewEditCard) {
      const meta = m.meta || {};
      const rid = String(meta.requestId || '').replace(/\\/g, '').replace(/'/g, '');
      const card = window.CsReviewEditCard.html(meta, {
        admin: true, canAct: csCanActOnReviewEdit(),
        onApprove: `csApproveReviewEdit('${rid}')`,
        onReject: `csRejectReviewEdit('${rid}')`,
      });
      const ts0 = m.createdAt ? new Date(m.createdAt).toLocaleString("ko-KR", { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : "";
      return `<div style="display:flex;flex-direction:column;align-items:flex-start">
        <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${escHtml(m.senderName || '리뷰어')}</div>
        ${card}
        <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${ts0}</div>
      </div>`;
    }
    const textHtml = m.content ? `<div style="max-width:78%;background:${isAdmin ? '#3182f6' : '#fff'};color:${isAdmin ? '#fff' : '#111827'};border:1px solid ${isAdmin ? '#3182f6' : '#e5e7eb'};padding:8px 11px;border-radius:12px;font-size:.83rem;line-height:1.45;white-space:pre-wrap;word-break:break-word">${escHtml(m.content)}</div>` : '';
    return `<div style="display:flex;flex-direction:column;align-items:${isAdmin ? 'flex-end' : 'flex-start'}">
      <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${escHtml(m.senderName || (isAdmin ? '관리자' : '리뷰어'))}</div>
      ${textHtml}${imgHtml}
      <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${ts}</div>
    </div>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

/* 첨부 사진 크게 보기 */
function csViewImage(url) {
  let v = document.getElementById("csImgView");
  if (!v) {
    v = document.createElement("div");
    v.id = "csImgView";
    v.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:10800;display:flex;align-items:center;justify-content:center;padding:20px";
    v.onclick = () => { v.style.display = "none"; };
    document.body.appendChild(v);
  }
  v.innerHTML = `<img src="${escHtml(url)}" style="max-width:100%;max-height:100%;border-radius:10px">`;
  v.style.display = "flex";
}

async function csSendReply(threadId) {
  const ta = document.getElementById("csReplyText");
  if (!ta) return;
  const content = ta.value.trim();
  // 업로드가 끝난 첨부만 전송 대상(업로드 중이면 잠시 대기 안내) — 리뷰어측과 동일 규칙
  if (_csPending.some(p => !p.url)) { showToast("사진 업로드가 끝나면 전송할 수 있어요"); return; }
  const imageUrls = _csPending.map(p => p.url).filter(Boolean);
  if (!content && imageUrls.length === 0) return;
  ta.value = "";
  const sentAttach = _csPending.slice();
  _csPending = []; csRenderAttachBar();
  try {
    const data = await gasPost({ action: "csAdminReply", threadId, content, imageUrls });
    if (!data || data.ok === false) throw new Error((data && data.error) || "전송 실패");
    await csReloadConversation(threadId);
    loadCsRooms();
  } catch (err) {
    showToast("전송 오류: " + err.message, true);
    ta.value = content;
    _csPending = sentAttach; csRenderAttachBar();   // 실패 시 첨부 복구
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
  if (pane) pane.innerHTML = '<div style="margin:auto;text-align:center;color:var(--t3,#94A3B8);padding:40px"><i class="fas fa-comments" style="font-size:2rem;display:block;margin-bottom:10px;opacity:.4"></i>왼쪽에서 문의방을 선택하세요</div>';
}

function csUpdateBadge(count) {
  const b = document.getElementById("csInquiryBadge");
  if (b) {
    if (count > 0) { b.textContent = count; b.style.display = "inline-block"; }
    else b.style.display = "none";
  }
  /* 호스트 훅 — 이 모듈의 미확인 수를 자기 UI(리뷰웹시스템[3버전] nav 뱃지)에도 반영하게 한다.
     ★ 밖에서 window.csUpdateBadge 를 감싸는 방식은 **동작하지 않는다**: 모듈 내부 호출
       (loadCsRooms·csRefreshBadge)은 렉시컬 스코프의 이 함수를 직접 부르므로 래퍼를
       거치지 않는다(코드리뷰 지적 · 실측). 그래서 훅을 안에서 부른다.
     ★ #csInquiryBadge 가 없어도(=리뷰웹시스템[3버전]) 훅은 호출된다 — 위 early return 을 없앤 이유.
     ★ 훅 미설정(관리자 대시보드)이면 아무 일도 안 한다 = 기존 동작 불변. */
  try {
    if (typeof window.CS_ON_BADGE === "function") window.CS_ON_BADGE(Number(count) || 0);
  } catch (_) {}
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

/* ── 리뷰이미지 교체요청 — 대화창·전용 탭에서 바로 처리 ──────────
   ★ 경로는 C/S 와 같은 방식으로 재기준한다(window.REVIEW_EDIT_API_BASE):
     관리자 대시보드 = /api/review-edit, 리뷰웹시스템[3버전] = /api/trackb/review-edit
     (인트라넷 SSO 토큰은 /api/review-edit/* 에 도달 자체가 불가능하다).
   ★ 처리 후 **서버 값으로 다시 읽는다** — 프론트에서 낙관적으로 그리면 서버가 거부했을 때
     화면만 승인된 것처럼 남는다. */
function _reApiBase() { return (typeof window !== 'undefined' && window.REVIEW_EDIT_API_BASE) || '/api/review-edit'; }
/** 버튼 노출 여부 — 호스트가 알려준다(미설정이면 노출) */
function csCanActOnReviewEdit() {
  return (typeof window.CS_REVIEW_EDIT_CAN_ACT === 'function') ? !!window.CS_REVIEW_EDIT_CAN_ACT() : true;
}
async function _reCall(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('admin_token')) || '';
  if (tok) headers.Authorization = 'Bearer ' + tok;
  const base = (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '';
  const res = await fetch(base + _reApiBase() + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json().catch(() => ({ ok: false, error: '응답을 읽지 못했습니다.' }));
}
async function csApproveReviewEdit(requestId, opts) {
  if (!requestId) return;
  opts = opts || {};
  if (!opts.skipConfirm && !confirm('이 교체요청을 승인할까요?\n\n· 리뷰 이미지가 새 파일로 교체됩니다(기존 파일은 보관 폴더로).\n· 리뷰어 채팅에 승인 안내가 자동으로 전송됩니다.')) return false;
  const r = await _reCall('/approve', { id: requestId });
  if (r && r.ok) {
    showToast('승인했습니다. 리뷰어에게 안내가 전송되었습니다.');
    if (!opts.skipReload) csReloadAfterReviewEdit();
    return true;
  }
  showToast('승인 실패: ' + ((r && r.error) || '알 수 없는 오류'), true);
  return false;
}
async function csRejectReviewEdit(requestId, opts) {
  if (!requestId) return;
  opts = opts || {};
  // 사유는 필수 — 그대로 리뷰어에게 전송되므로 비우면 "왜 반려됐는지" 알 수 없다(서버도 거부).
  const note = Object.prototype.hasOwnProperty.call(opts, 'note')
    ? opts.note
    : prompt('반려 사유를 입력하세요.\n(리뷰어 채팅에 그대로 전송됩니다)');
  if (note === null) return false;
  if (!String(note).trim()) { showToast('반려 사유를 입력해 주세요.', true); return; }
  const r = await _reCall('/reject', { id: requestId, note: String(note).trim() });
  if (r && r.ok) {
    showToast('반려했습니다. 사유가 리뷰어에게 전송되었습니다.');
    if (!opts.skipReload) csReloadAfterReviewEdit();
    return true;
  }
  showToast('반려 실패: ' + ((r && r.error) || '알 수 없는 오류'), true);
  return false;
}
function csReloadAfterReviewEdit() {
  try { if (_csActiveThreadId) csReloadConversation(_csActiveThreadId); } catch (_) {}
  // ★ 문의방 목록은 **C/S 화면이 실제로 떠 있을 때만** 다시 읽는다.
  //   전용 탭(AE)에서 처리한 경우 AE 는 /cs/threads(adminOrMaster)에 403 이고,
  //   async 함수의 rejection 은 sync try 로 안 잡혀 콘솔에 unhandled rejection 이 남는다.
  try {
    if (document.getElementById('csRoomListWrap')) {
      const p = loadCsRooms();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_) {}
  try { if (typeof window.CS_REVIEW_EDIT_ON_RESOLVED === 'function') window.CS_REVIEW_EDIT_ON_RESOLVED(); } catch (_) {}
}

  /* ── 마운트 ────────────────────────────────────────────────
     마크업도 모듈이 들고 있다 — admin.html 에 남겨두면 리뷰웹시스템[3버전]에 같은 화면을
     띄우려고 사본을 만들게 된다. id 는 그대로라 기존 JS 가 전부 그대로 동작한다.

     ★ #csConvPane 은 max-width:860px — 넓은 화면(QHD 이상)에서 대화창이 끝없이
       늘어나 말풍선 사이 여백만 벌어지던 것을 막는다. 목록(#csRoomListWrap, 360px
       고정)은 그대로 두고 대화창만 상한을 받으므로, 남는 폭은 부모 flex row(gap:12px)
       안에서 오른쪽으로 자연히 흘러간다 — 별도 스페이서 요소가 필요 없다(flex:1 이
       max-width 에서 멈추고, 형제가 없어 남는 공간을 아무도 못 가져간다). */
  var HTML = "      <div id=\"tab-cs-inquiry\" class=\"admin-tab-pane\" style=\"padding:16px\">\n        <div class=\"admin-section-header\" style=\"margin-bottom:12px\">\n          <span style=\"font-size:.95rem;font-weight:700;color:var(--t1,#0F172A)\"><i class=\"fas fa-comments\" style=\"color:var(--p,#3182F6);margin-right:6px\"></i>\ub9ac\ubdf0\uc5b4 C/S \ubb38\uc758</span>\n          <div style=\"display:flex;gap:6px;margin-left:auto;align-items:center\">\n            <input id=\"csSearchInput\" type=\"text\" placeholder=\"\ub9ac\ubdf0\uc5b4/\ucea0\ud398\uc778 \uac80\uc0c9...\"\n              style=\"padding:6px 10px;border:1.5px solid var(--border,#E2E8F0);border-radius:8px;font-size:.82rem;outline:none;width:150px\"\n              oninput=\"csFilterRooms(this.value)\">\n            <select id=\"csStatusFilter\" onchange=\"loadCsRooms()\"\n              style=\"padding:6px 10px;border:1.5px solid var(--border,#E2E8F0);border-radius:8px;font-size:.82rem;outline:none\">\n              <option value=\"all\">\uc804\uccb4</option>\n              <option value=\"open\" selected>\uc9c4\ud589\uc911</option>\n              <option value=\"closed\">\uc885\ub8cc</option>\n            </select>\n            <button onclick=\"loadCsRooms()\" style=\"padding:6px 12px;background:var(--p,#3182F6);color:#fff;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px\">\n              <i class=\"fas fa-sync-alt\"></i> \uc0c8\ub85c\uace0\uce68\n            </button>\n          </div>\n        </div>\n        <style>\n          .cs-room-row{ cursor:pointer; transition:background .12s; }\n          .cs-room-row:hover{ background:#f9fafb; }\n          .cs-room-active{ background:#eef5ff !important; box-shadow:inset 3px 0 0 #3182f6; }\n        </style>\n        <!-- \uc88c\uce21: \ucc44\ud305\ubc29 \ubaa9\ub85d / \uc6b0\uce21: \ub300\ud654\ucc3d (\uc778\ub77c\uc778 \ubd84\ud560) -->\n        <div style=\"display:flex;gap:12px;align-items:stretch;height:calc(100vh - 250px);min-height:480px\">\n          <div id=\"csRoomListWrap\" style=\"width:360px;flex-shrink:0;overflow-y:auto;background:var(--card,#FFFFFF);border-radius:var(--r,14px);border:1px solid var(--border,#E2E8F0);box-shadow:var(--sh,0 1px 4px rgba(15,23,42,.07))\">\n            <div style=\"padding:30px;text-align:center;color:var(--t3,#94A3B8)\">\n              <i class=\"fas fa-circle-notch fa-spin\"></i> \ubd88\ub7ec\uc624\ub294 \uc911...\n            </div>\n          </div>\n          <div id=\"csConvPane\" style=\"flex:1;min-width:0;max-width:860px;display:flex;flex-direction:column;background:var(--card,#FFFFFF);border-radius:var(--r,14px);border:1px solid var(--border,#E2E8F0);box-shadow:var(--sh,0 1px 4px rgba(15,23,42,.07));overflow:hidden\">\n            <div style=\"margin:auto;text-align:center;color:var(--t3,#94A3B8);padding:40px\">\n              <i class=\"fas fa-comments\" style=\"font-size:2rem;display:block;margin-bottom:10px;opacity:.4\"></i>\n              \uc67c\ucabd\uc5d0\uc11c \ubb38\uc758\ubc29\uc744 \uc120\ud0dd\ud558\uc138\uc694\n            </div>\n          </div>\n        </div>\n      </div><!-- /tab-cs-inquiry -->";

  function mount(hostId) {
    var host = document.getElementById(hostId || "csInquiryMount");
    if (!host) return false;
    if (!document.getElementById("tab-cs-inquiry")) host.innerHTML = HTML;   // 멱등
    return true;
  }

  /* 전역 공개 — 생성 HTML 의 onclick 문자열과 index-payment.js 의 SSE 훅이 이름으로 쓴다.
     (모듈 안에만 두면 버튼이 전부 "함수 없음"으로 조용히 죽는다) */
  var EXPORTS = {
    loadCsRooms: loadCsRooms, csFilterRooms: csFilterRooms,
    csOpenConversation: csOpenConversation, csLoadOrderContext: csLoadOrderContext,
    csReloadConversation: csReloadConversation, csViewImage: csViewImage,
    // 열려 있는 방을 다시 그린다 — 닉네임을 바꾸면 이미 보낸 답장의 표시 이름까지 바뀌므로
    // 설정 화면(admin-settings.js)이 저장 직후 부른다. _csActiveThreadId 는 모듈 스코프라
    // 바깥에서 읽을 수 없어 **훅으로 노출**한다(전역 사본을 두면 두 값이 갈라진다).
    csReloadActiveConversation: function () { if (_csActiveThreadId) csReloadConversation(_csActiveThreadId); },
    csSendReply: csSendReply, csSaveMemo: csSaveMemo, csToggleStatus: csToggleStatus,
    csCloseConversation: csCloseConversation, csUpdateBadge: csUpdateBadge,
    csRefreshBadge: csRefreshBadge, csOnSSE: csOnSSE,
    csApproveReviewEdit: csApproveReviewEdit, csRejectReviewEdit: csRejectReviewEdit,
    csCanActOnReviewEdit: csCanActOnReviewEdit, csReloadAfterReviewEdit: csReloadAfterReviewEdit,
    // 사진 첨부(파일선택·Ctrl+V·드래그앤드롭) — 생성 HTML의 onclick/onchange/onpaste 문자열이 이름으로 찾는다
    csPickFiles: csPickFiles, csRemoveAttach: csRemoveAttach, csHandlePaste: csHandlePaste,
  };
  for (var k in EXPORTS) if (Object.prototype.hasOwnProperty.call(EXPORTS, k)) window[k] = EXPORTS[k];
  window.CsInquiry = { mount: mount, html: HTML };

  if (!mount()) document.addEventListener("DOMContentLoaded", function () { mount(); });
})();
