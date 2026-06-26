/* ═══════════════════════════════════════════════════════════
   리뷰어 C/S 문의창구 — 리뷰어 측 UI (index.html 전용)
   - 로그인 시 "1:1 문의" 플로팅 버튼 노출
   - 참여 캠페인 선택 → 메신저형 대화창
   - 관리자 답장 실시간(SSE) 수신
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
  function setFabDot(on) {
    _unread = on;
    const dot = document.getElementById("rcsTabDot");
    if (dot) dot.style.display = on ? "block" : "none";
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

  // ── 캠페인 선택 ──
  async function openPicker() {
    const user = getUser();
    if (!user || !user.phone8) { toast("로그인이 필요합니다"); return; }
    setFabDot(false);
    const ov = overlay();
    ov.innerHTML = `<div style="${SHEET}">
      <div style="padding:14px 16px;border-bottom:1px solid #eef2f7;display:flex;align-items:center;gap:8px">
        <i class="fas fa-headset" style="color:#3182f6"></i>
        <span style="font-weight:800;font-size:1rem;color:#111827">1:1 문의하기</span>
        <button onclick="ReviewerCS.close()" style="margin-left:auto;width:30px;height:30px;border:none;background:#F3F4F6;border-radius:8px;color:#6B7280;cursor:pointer"><i class="fas fa-times"></i></button>
      </div>
      <div style="padding:10px 16px;font-size:.8rem;color:#6B7280;background:#f9fafb;border-bottom:1px solid #f3f4f6">진행하신 탭을 선택해 문의하세요</div>
      <div id="rcsPickerList" style="flex:1;overflow-y:auto;padding:8px 0">
        <div style="text-align:center;padding:30px;color:#9CA3AF"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중...</div>
      </div>
    </div>`;
    try {
      const data = await gasGet({ action: "csReviewerCampaigns", phone8: user.phone8 });
      if (!data || data.ok === false) throw new Error((data && data.error) || "불러오기 실패");
      const items = (data.campaigns || []).slice();
      if (data.general) items.push(data.general);
      renderPicker(items);
    } catch (err) {
      const el = document.getElementById("rcsPickerList");
      if (el) el.innerHTML = `<div style="text-align:center;padding:30px;color:#EF4444;font-size:.85rem">오류: ${esc(err.message)}</div>`;
    }
  }
  function renderPicker(items) {
    const el = document.getElementById("rcsPickerList");
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div style="text-align:center;padding:30px;color:#9CA3AF;font-size:.85rem">진행한 탭이 없습니다.<br>일반 문의로 남겨주세요.</div>'; return; }
    el.innerHTML = items.map(c => {
      const isGeneral = c.campaignSource === 'general';
      const labelSafe = (c.campaignLabel || '').replace(/'/g, "\\'");
      const unread = c.reviewerUnread > 0;
      // 부제는 상태만 (시트제목 등 업체정보는 리뷰어에게 노출하지 않음)
      const sub = (c.threadId ? '이전 문의 있음' : '새 문의') + (c.status === 'closed' ? ' · 종료됨' : '');
      return `<div onclick="ReviewerCS.openChat('${(c.campaignKey || '').replace(/'/g,"\\'")}','${labelSafe}','${c.campaignSource || 'general'}')"
        style="padding:13px 16px;border-bottom:1px solid #f3f4f6;cursor:pointer;display:flex;align-items:center;gap:10px" onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background='#fff'">
        <div style="width:38px;height:38px;border-radius:10px;background:${isGeneral ? '#EDE9FE' : '#E0EDFF'};color:${isGeneral ? '#7C3AED' : '#3182f6'};display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fas ${isGeneral ? 'fa-comment-dots' : 'fa-box-open'}"></i></div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.88rem;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.campaignLabel)}</div>
          <div style="font-size:.72rem;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>
        </div>
        ${unread ? '<span style="width:9px;height:9px;background:#EF4444;border-radius:50%;flex-shrink:0"></span>' : ''}
        <i class="fas fa-chevron-right" style="color:#cbd5e1;font-size:.8rem"></i>
      </div>`;
    }).join("");
  }

  // ── 대화창 ──
  async function openChat(campaignKey, campaignLabel, campaignSource) {
    const user = getUser();
    if (!user || !user.phone8) { toast("로그인이 필요합니다"); return; }
    _open = { campaignKey: campaignKey || "", campaignLabel: campaignLabel || "문의", campaignSource: campaignSource || "general", threadId: null };
    const headerSub = "관리자에게 문의를 남겨주세요";
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
      <div style="padding:10px 12px;border-top:1px solid #eef2f7;display:flex;gap:8px;align-items:flex-end">
        <textarea id="rcsInput" rows="1" placeholder="메시지를 입력하세요..." style="flex:1;resize:none;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;font-size:.88rem;font-family:inherit;outline:none;max-height:100px"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();ReviewerCS.send();}"></textarea>
        <button onclick="ReviewerCS.send()" style="width:44px;height:44px;border:none;background:#3182f6;color:#fff;border-radius:12px;font-size:1rem;cursor:pointer;flex-shrink:0"><i class="fas fa-paper-plane"></i></button>
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
      return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'}">
        <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${mine ? '나' : esc(m.senderName || '관리자')}</div>
        <div style="max-width:80%;background:${mine ? '#3182f6' : '#fff'};color:${mine ? '#fff' : '#111827'};border:1px solid ${mine ? '#3182f6' : '#e5e7eb'};padding:9px 12px;border-radius:14px;font-size:.86rem;line-height:1.5;white-space:pre-wrap;word-break:break-word">${esc(m.content)}</div>
        <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${timeFmt(m.createdAt)}</div>
      </div>`;
    }).join("");
    box.scrollTop = box.scrollHeight;
  }

  async function send() {
    if (!_open) return;
    const user = getUser();
    const ta = document.getElementById("rcsInput");
    if (!ta) return;
    const content = ta.value.trim();
    if (!content) return;
    ta.value = ""; ta.style.height = "auto";
    try {
      const data = await gasPost({
        action: "csReviewerSend", phone8: user.phone8, name: user.name,
        campaignKey: _open.campaignKey, campaignLabel: _open.campaignLabel,
        campaignSource: _open.campaignSource, content,
      });
      if (!data || data.ok === false) throw new Error((data && data.error) || "전송 실패");
      _open.threadId = data.threadId || _open.threadId;
      await reloadChat();
    } catch (err) {
      toast("전송 오류: " + err.message, true);
      ta.value = content;
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
        if (_open && _open.threadId && data.threadId === _open.threadId) {
          reloadChat();
        } else {
          setFabDot(true);
          toast("관리자 답변이 도착했습니다");
        }
      });
    } catch (_) {}
  }

  // ── 초기화 ──
  function init() {
    ensureConnected();
    // 로그인/로그아웃 후 상태 변화 대응(가벼운 폴링) — SSE 연결 보장
    setInterval(ensureConnected, 3000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ReviewerCS = { open: openPicker, openChat, send, back: openPicker, close: closeAll };
})();
