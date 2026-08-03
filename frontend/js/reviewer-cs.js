/* ═══════════════════════════════════════════════════════════
   리뷰어 C/S 문의창구 — 리뷰어 측 UI (index.html 전용)
   - 문의 시작 = 리뷰 내역 카드 → 참여상품 정보 팝업의 [1:1 문의하기] (index.html)
   - 1:1문의 탭 = 이미 문의한 목록(내 문의함, index.html의 #sectionCsInbox) — 팝업 없음
   - 이 파일은 대화창 + 미확인 뱃지 + 관리자 답장 실시간(SSE) 담당
   의존: api.js(gasGet/gasPost, API_BASE_URL), localStorage "iad_reviewer_user"
   ═══════════════════════════════════════════════════════════ */
(function () {
  const USER_KEY = "iad_reviewer_user";
  let _open = null;        // { campaignKey, campaignLabel, campaignSource, threadId }
  let _sse = null;
  let _unread = false;

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg, err) {
    if (typeof showToast === "function") { try { showToast(msg, err); return; } catch (_) {} }
    alert(msg);
  }
  function timeFmt(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (_) { return ""; }
  }

  // ── 진입점은 index.html 하단 탭바의 "1:1문의" 버튼(#tabBtnCs)이 담당.
  //    여기서는 미확인 표시 점(#rcsTabDot)과 SSE 연결만 관리한다.
  function ensureConnected() {
    const user = getUser();
    if (user && user.name && !_sse) connectSSE();
  }
  // 하단 탭바 "1:1문의" 뱃지에 총 미확인 수(숫자) 표기
  function setTabBadge(count) {
    _unread = count > 0;
    const dot = document.getElementById("rcsTabDot");
    if (!dot) return;
    if (count > 0) { dot.textContent = count > 99 ? "99+" : String(count); dot.style.display = "inline-block"; }
    else { dot.textContent = ""; dot.style.display = "none"; }
  }
  // 서버에서 총 미확인 수를 조회해 탭 뱃지 갱신
  async function refreshUnread() {
    const user = getUser();
    if (!user || !user.phone8) { setTabBadge(0); return; }
    try {
      const d = await gasGet({ action: "csReviewerUnread", phone8: user.phone8 });
      if (d && d.ok !== false) setTabBadge(d.totalUnread || 0);
    } catch (_) {}
  }

  // ── 공통 오버레이 ──
  function overlay() {
    let ov = document.getElementById("rcsOverlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "rcsOverlay";
      ov.style.cssText = "position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:9500;display:flex;align-items:flex-end;justify-content:center";
      ov.addEventListener("click", e => { if (e.target === ov) closeAll(); });
      document.body.appendChild(ov);
    }
    ov.style.display = "flex";
    return ov;
  }
  function closeAll() {
    _open = null;
    const ov = document.getElementById("rcsOverlay");
    if (ov) ov.style.display = "none";
  }

  const SHEET = "background:#fff;width:560px;max-width:100vw;height:84vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 -6px 30px rgba(0,0,0,.2)";

  // 문의 목록(내 문의함)은 index.html의 1:1문의 탭이 인라인으로 그린다.
  //   여기서 팝업 목록을 다시 만들면 진입 경로가 둘이 되어 어긋나므로 만들지 않는다.
  function openInbox() {
    if (typeof switchTab === "function") { try { switchTab("cs"); return; } catch (_) {} }
    toast("리뷰 내역에서 문의할 작업을 선택해 주세요");
  }
  // 대화창 닫기(뒤로) → 내 문의함 목록 갱신
  function backToInbox() {
    closeAll();
    if (typeof window.loadCsInbox === "function") { try { window.loadCsInbox(); } catch (_) {} }
  }

  // ── 대화창 ──
  async function openChat(campaignKey, campaignLabel, campaignSource) {
    const user = getUser();
    if (!user || !user.phone8) { toast("로그인이 필요합니다"); return; }
    _open = { campaignKey: campaignKey || "", campaignLabel: campaignLabel || "문의", campaignSource: campaignSource || "general", threadId: null };
    const headerSub = "관리자에게 문의를 남겨주세요";
    _pending = [];                                   // 방을 바꾸면 이전 첨부는 버린다
    const ov = overlay();
    ov.innerHTML = `<div style="${SHEET}">
      <div style="padding:12px 14px;border-bottom:1px solid #eef2f7;display:flex;align-items:center;gap:8px">
        <button onclick="ReviewerCS.back()" style="width:30px;height:30px;border:none;background:#F3F4F6;border-radius:8px;color:#6B7280;cursor:pointer"><i class="fas fa-arrow-left"></i></button>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:.92rem;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(_open.campaignLabel)}</div>
          <div style="font-size:.72rem;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${headerSub}</div>
        </div>
        <button onclick="ReviewerCS.close()" style="width:30px;height:30px;border:none;background:#F3F4F6;border-radius:8px;color:#6B7280;cursor:pointer"><i class="fas fa-times"></i></button>
      </div>
      <div id="rcsThread" style="flex:1;overflow-y:auto;padding:14px;background:#f9fafb;display:flex;flex-direction:column;gap:8px">
        <div style="text-align:center;color:#9CA3AF;font-size:.82rem"><i class="fas fa-circle-notch fa-spin"></i></div>
      </div>
      <div id="rcsAttachBar" style="display:none;padding:8px 12px 0;gap:6px;flex-wrap:wrap"></div>
      <div style="padding:10px 12px;border-top:1px solid #eef2f7;display:flex;gap:7px;align-items:flex-end">
        <input type="file" id="rcsFile" accept="image/*" multiple style="display:none" onchange="ReviewerCS.pickFiles(this)">
        <button onclick="document.getElementById('rcsFile').click()" title="사진 첨부"
          style="width:44px;height:44px;border:1px solid #e5e7eb;background:#fff;color:#6B7280;border-radius:12px;font-size:1.05rem;cursor:pointer;flex-shrink:0"><i class="fas fa-image"></i></button>
        <textarea id="rcsInput" rows="1" placeholder="메시지를 입력하세요..." style="flex:1;resize:none;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;font-size:.88rem;font-family:inherit;outline:none;max-height:100px"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();ReviewerCS.send();}"></textarea>
        <button id="rcsSendBtn" onclick="ReviewerCS.send()" style="width:44px;height:44px;border:none;background:#3182f6;color:#fff;border-radius:12px;font-size:1rem;cursor:pointer;flex-shrink:0"><i class="fas fa-paper-plane"></i></button>
      </div>
    </div>`;
    await reloadChat();
  }

  async function reloadChat() {
    if (!_open) return;
    const user = getUser();
    try {
      const data = await gasGet({ action: "csReviewerMessages", phone8: user.phone8, campaignKey: _open.campaignKey });
      if (!data || data.ok === false) throw new Error((data && data.error) || "불러오기 실패");
      _open.threadId = data.threadId || _open.threadId;
      renderMessages(data.messages || []);
      // 이 방을 열람하면 서버에서 해당 방 미확인이 리셋됨 → 탭 총 뱃지 갱신
      refreshUnread();
    } catch (err) {
      const box = document.getElementById("rcsThread");
      if (box) box.innerHTML = `<div style="text-align:center;color:#EF4444;font-size:.82rem">오류: ${esc(err.message)}</div>`;
    }
  }

  function renderMessages(messages) {
    const box = document.getElementById("rcsThread");
    if (!box) return;
    if (!messages.length) {
      box.innerHTML = '<div style="text-align:center;color:#9CA3AF;font-size:.82rem;margin-top:24px"><i class="fas fa-comment-dots" style="font-size:1.6rem;display:block;margin-bottom:8px;opacity:.4"></i>첫 메시지를 남겨보세요.</div>';
      return;
    }
    box.innerHTML = messages.map(m => {
      const mine = m.senderRole === 'reviewer';
      // 리뷰이미지 교체요청 = 카드(관리자 화면과 **같은 렌더러**, 여기선 읽기 전용).
      //   리뷰어가 자기 요청의 진행 상태를 채팅 안에서 그대로 확인한다.
      if (m.msgType === 'review_edit' && window.CsReviewEditCard) {
        return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'}">
          <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${mine ? '나' : esc(m.senderName || '관리자')}</div>
          ${window.CsReviewEditCard.html(m.meta || {}, { admin: false })}
          <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${timeFmt(m.createdAt)}</div>
        </div>`;
      }
      const imgs = Array.isArray(m.imageUrls) ? m.imageUrls : [];
      const imgHtml = imgs.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;max-width:80%;margin-top:${m.content ? '4px' : '0'}">` +
        imgs.map(u => `<img src="${esc(u)}" alt="첨부 사진" onclick="ReviewerCS.viewImage('${esc(u)}')"
          style="width:130px;height:130px;object-fit:cover;border-radius:12px;border:1px solid #E5E7EB;cursor:zoom-in;background:#fff">`).join('') +
        `</div>` : '';
      const textHtml = m.content ? `<div style="max-width:80%;background:${mine ? '#3182f6' : '#fff'};color:${mine ? '#fff' : '#111827'};border:1px solid ${mine ? '#3182f6' : '#e5e7eb'};padding:9px 12px;border-radius:14px;font-size:.86rem;line-height:1.5;white-space:pre-wrap;word-break:break-word">${esc(m.content)}</div>` : '';
      return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'}">
        <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${mine ? '나' : esc(m.senderName || '관리자')}</div>
        ${textHtml}${imgHtml}
        <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${timeFmt(m.createdAt)}</div>
      </div>`;
    }).join("");
    box.scrollTop = box.scrollHeight;
  }

  // ── 사진 첨부 ──
  let _pending = [];          // [{name, dataUrl, url}] — url은 업로드 완료 후 채워짐

  function renderAttachBar() {
    const bar = document.getElementById("rcsAttachBar");
    if (!bar) return;
    if (!_pending.length) { bar.style.display = "none"; bar.innerHTML = ""; return; }
    bar.style.display = "flex";
    bar.innerHTML = _pending.map((p, i) => `
      <div style="position:relative;width:62px;height:62px;border-radius:10px;overflow:hidden;border:1px solid #E5E7EB;background:#F3F4F6">
        <img src="${esc(p.dataUrl)}" style="width:100%;height:100%;object-fit:cover;${p.url ? '' : 'opacity:.5'}">
        ${p.url ? '' : '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#3182f6"><i class="fas fa-circle-notch fa-spin"></i></div>'}
        <button onclick="ReviewerCS.removeAttach(${i})" style="position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(17,24,39,.65);color:#fff;font-size:.6rem;cursor:pointer;line-height:1">✕</button>
      </div>`).join("");
  }

  function removeAttach(i) { _pending.splice(i, 1); renderAttachBar(); }

  async function pickFiles(input) {
    const user = getUser();
    if (!user || !user.phone8) { toast("로그인이 필요합니다"); return; }
    const files = [...(input.files || [])];
    input.value = "";                                  // 같은 파일 다시 고를 수 있게
    for (const f of files) {
      if (_pending.length >= 5) { toast("사진은 최대 5장까지 첨부할 수 있어요"); break; }
      if (!/^image\//.test(f.type)) { toast("사진 파일만 첨부할 수 있어요"); continue; }
      if (f.size > 8 * 1024 * 1024) { toast("8MB 이하 사진만 첨부할 수 있어요"); continue; }
      const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      const item = { name: f.name, dataUrl, url: "" };
      _pending.push(item);
      renderAttachBar();
      try {
        const d = await gasPost({ action: "csReviewerUpload", phone8: user.phone8, fileName: f.name,
                                  mimeType: f.type, imageBase64: dataUrl }, 120000);
        if (!d || d.ok === false || !d.url) throw new Error((d && d.error) || "업로드 실패");
        item.url = d.url;
      } catch (e) {
        toast("사진 업로드 실패: " + e.message, true);
        const idx = _pending.indexOf(item);
        if (idx > -1) _pending.splice(idx, 1);
      }
      renderAttachBar();
    }
  }

  // 첨부 사진 크게 보기
  function viewImage(url) {
    let v = document.getElementById("rcsImgView");
    if (!v) {
      v = document.createElement("div");
      v.id = "rcsImgView";
      v.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9800;display:flex;align-items:center;justify-content:center;padding:16px";
      v.onclick = () => { v.style.display = "none"; };
      document.body.appendChild(v);
    }
    v.innerHTML = `<img src="${esc(url)}" style="max-width:100%;max-height:100%;border-radius:10px">`;
    v.style.display = "flex";
  }

  async function send() {
    if (!_open) return;
    const user = getUser();
    const ta = document.getElementById("rcsInput");
    if (!ta) return;
    const content = ta.value.trim();
    // 업로드가 끝난 첨부만 전송 대상(업로드 중이면 잠시 대기 안내)
    if (_pending.some(p => !p.url)) { toast("사진 업로드가 끝나면 전송할 수 있어요"); return; }
    const imageUrls = _pending.map(p => p.url).filter(Boolean);
    if (!content && imageUrls.length === 0) return;
    ta.value = ""; ta.style.height = "auto";
    const sentAttach = _pending.slice();
    _pending = []; renderAttachBar();
    try {
      const data = await gasPost({
        action: "csReviewerSend", phone8: user.phone8, name: user.name,
        campaignKey: _open.campaignKey, campaignLabel: _open.campaignLabel,
        campaignSource: _open.campaignSource, content, imageUrls,
      });
      if (!data || data.ok === false) throw new Error((data && data.error) || "전송 실패");
      _open.threadId = data.threadId || _open.threadId;
      await reloadChat();
      if (typeof window.loadCsInbox === "function") { try { window.loadCsInbox(); } catch (_) {} }
    } catch (err) {
      toast("전송 오류: " + err.message, true);
      ta.value = content;
      _pending = sentAttach; renderAttachBar();   // 실패 시 첨부 복구
    }
  }

  // ── SSE (관리자 답장 실시간) ──
  function connectSSE() {
    const user = getUser();
    if (!user || !user.phone8) return;
    if (_sse) { try { _sse.close(); } catch (_) {} _sse = null; }
    try {
      _sse = new EventSource(API_BASE_URL + "/api/reviewer/cs/events?phone8=" + encodeURIComponent(user.phone8));
      _sse.addEventListener("cs_message", function (event) {
        let data = {}; try { data = JSON.parse(event.data); } catch (_) {}
        // 총 미확인 수 뱃지 갱신(카톡식 숫자)
        refreshUnread();
        if (_open && _open.threadId && data.threadId === _open.threadId) {
          // 지금 보고 있는 방 → 새 메시지 즉시 표시(열람 처리됨)
          reloadChat();
        } else if (typeof window.loadCsInbox === "function") {
          // 내 문의함(1:1문의 탭)이 열려 있으면 방별 미확인 숫자 갱신
          try { window.loadCsInbox(); } catch (_) {}
          toast("관리자 답변이 도착했습니다");
        } else {
          toast("관리자 답변이 도착했습니다");
        }
      });
    } catch (_) {}
  }

  // ── 초기화 ──
  function init() {
    ensureConnected();
    refreshUnread();
    // 로그인/로그아웃 후 상태 변화 대응(가벼운 폴링) — SSE 연결 보장
    setInterval(ensureConnected, 3000);
    // SSE 누락 대비 안전망: 주기적 총 미확인 수 갱신
    setInterval(refreshUnread, 20000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ReviewerCS = { open: openInbox, openChat, send, back: backToInbox, close: closeAll,
                        pickFiles, removeAttach, viewImage, refreshUnread };
})();
