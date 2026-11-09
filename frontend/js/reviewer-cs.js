/* ═══════════════════════════════════════════════════════════
   리뷰어 C/S 문의창구 — 리뷰어 측 UI (index.html 전용)
   - 문의 시작 = 리뷰 내역 카드 → 참여상품 정보 팝업의 [1:1 문의하기] (index.html)
   - 1:1문의 탭 = 이미 문의한 목록(내 문의함, index.html의 #sectionCsInbox) — 팝업 없음
   - 이 파일은 대화창 + 미확인 뱃지 + 관리자 답장 실시간(SSE) 담당
   의존: api.js(gasGet/gasPost, API_BASE_URL), index.html getSavedUser()
   ═══════════════════════════════════════════════════════════ */
(function () {
  const USER_KEY = "iad_reviewer_user";
  const HOME_SESSION_KEY = "iad_reviewer_home_session";
  let _open = null;        // { campaignKey, campaignLabel, campaignSource, threadId }
  let _sse = null;
  let _ssePhone8 = "";
  let _unread = false;

  function getUser() {
    // 목록(index.html)과 대화창이 반드시 같은 리뷰어를 보아야 한다.
    // 관리자 바로가기는 현재 탭의 sessionStorage를 우선하므로, 이 모듈에서
    // localStorage를 다시 직접 읽으면 목록은 A, 대화는 B 계정을 조회할 수 있다.
    try {
      if (typeof window.getSavedUser === "function") return window.getSavedUser();
      return JSON.parse(sessionStorage.getItem(HOME_SESSION_KEY) || localStorage.getItem(USER_KEY));
    } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function toast(msg, err) {
    if (typeof showToast === "function") { try { showToast(msg, err); return; } catch (_) {} }
    alert(msg);
  }
  // ★ 결정 359 — 오류 문구는 api.js 단일 출처(apiFriendlyErrorMessage)로 쉬운 한국어로 바꾼다.
  //   옛 api.js 가 캐시에 남아 함수가 없으면 종전 문구 그대로(배포 순서가 갈려도 멈추지 않는다).
  function friendlyErr(e, fallback) {
    try { if (typeof apiFriendlyErrorMessage === "function") return apiFriendlyErrorMessage(e, fallback); } catch (_) {}
    return (e && (e.message || e.error)) || fallback || "잠시 후 다시 시도해 주세요.";
  }
  // 응답 판정 — 통신 실패({ok:false|error})·서버 오류(200+{error})를 모두 실패로 본다(결정 359 · 결정 028 과 같은 본문 판정).
  function failed(d) { return !d || d.ok === false || !!d.error; }
  function timeFmt(iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (_) { return ""; }
  }

  // ── 진입점은 index.html 하단 탭바의 "1:1문의" 버튼(#tabBtnCs)이 담당.
  //    여기서는 미확인 표시 점(#rcsTabDot)과 SSE 연결만 관리한다.
  function ensureConnected() {
    const user = getUser();
    const phone8 = user && user.name && user.phone8 ? String(user.phone8) : "";
    if (!phone8) {
      if (_sse) { try { _sse.close(); } catch (_) {} }
      _sse = null; _ssePhone8 = ""; setTabBadge(0);
      return;
    }
    if (!_sse || _ssePhone8 !== phone8) connectSSE();
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
  // 같은 계정의 조회가 진행 중이거나 방금(2초 안) 끝났으면 다시 보내지 않는다 — 홈을 열 때
  // 초기화와 세션 동기화가 거의 동시에 불러 같은 요청이 두 번 나가던 것을 하나로 합친다.
  let _unreadInflight = null, _unreadKey = "", _unreadAt = 0;
  async function refreshUnread(force) {
    const user = getUser();
    if (!user || !user.phone8) { setTabBadge(0); return; }
    const key = String(user.phone8);
    if (force !== true && key === _unreadKey && (_unreadInflight || Date.now() - _unreadAt < 2000)) return _unreadInflight || undefined;
    _unreadKey = key;
    _unreadInflight = (async () => {
      try {
        const d = await gasGet({ action: "csReviewerUnread", phone8: user.phone8 });
        const cur = getUser();
        // ★ 결정 359: 조회 실패면 배지를 0으로 지우지 않고 그대로 둔다(모르는 것을 "0건"으로 꾸미지 않는다).
        if (cur && String(cur.phone8) === key && !failed(d)) setTabBadge(d.totalUnread || 0);
      } catch (_) {}
      finally { _unreadAt = Date.now(); _unreadInflight = null; }
    })();
    return _unreadInflight;
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
  async function openChat(campaignKey, campaignLabel, campaignSource, threadId) {
    const user = getUser();
    if (!user || !user.phone8) { toast("로그인이 필요합니다"); return; }
    _open = { campaignKey: campaignKey || "", campaignLabel: campaignLabel || "문의", campaignSource: campaignSource || "general", threadId: threadId || null };
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
      // 목록에서 연 방은 threadId로 정확히 조회한다. campaignKey는 새 문의창과
      // 예전 호출부를 위한 폴백이다. 서버는 threadId와 phone8 소유권을 함께 확인한다.
      const data = await gasGet({ action: "csReviewerMessages", phone8: user.phone8,
        threadId: _open.threadId || undefined, campaignKey: _open.campaignKey });
      if (failed(data)) throw new Error((data && data.error) || "대화를 불러오지 못했어요.");
      if (!_open) return;
      _open.threadId = data.threadId || _open.threadId;
      renderMessages(data.messages || []);
      // 이 방을 열람하면 서버에서 해당 방 미확인이 리셋됨 → 탭 총 뱃지 갱신
      refreshUnread(true);
    } catch (err) {
      const box = document.getElementById("rcsThread");
      // ★ 결정 359: 실패를 빈 방(「첫 메시지를 남겨보세요」)으로 보이지 않는다 — 이유 + [다시 불러오기].
      if (box) box.innerHTML = `<div style="text-align:center;color:#EF4444;font-size:.82rem;line-height:1.6">대화를 불러오지 못했어요<br><span style="color:#9CA3AF;font-size:.76rem">${esc(friendlyErr(err, "잠시 후 다시 시도해 주세요."))}</span><br><button type="button" onclick="ReviewerCS.reload()" style="margin-top:8px;border:1px solid #e5e7eb;background:#fff;color:#374151;border-radius:10px;padding:6px 14px;font-size:.8rem;cursor:pointer">다시 불러오기</button></div>`;
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
      // 리뷰캡처 교체요청 = 카드(관리자 화면과 **같은 렌더러**, 여기선 읽기 전용).
      //   리뷰어가 자기 요청의 진행 상태를 채팅 안에서 그대로 확인한다.
      if (m.msgType === 'review_edit' && window.CsReviewEditCard) {
        return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'}">
          <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${mine ? '나' : esc(m.senderName || '관리자')}</div>
          ${window.CsReviewEditCard.html(m.meta || {}, { admin: false })}
          <div style="font-size:.62rem;color:#cbd5e1;margin-top:2px">${timeFmt(m.createdAt)}</div>
        </div>`;
      }
      // 검수 결과(반려·이동) = 문구 + 사진 카드. 관리자 화면과 **같은 렌더러**를 쓴다.
      if (m.msgType === 'inspect_result' && window.CsReviewEditCard && window.CsReviewEditCard.inspectHtml) {
        return `<div style="display:flex;flex-direction:column;align-items:flex-start;max-width:88%">
          <div style="font-size:.66rem;color:#9CA3AF;margin-bottom:2px">${esc(m.senderName || '관리자')}</div>
          <div style="background:#fff;border-radius:4px 14px 14px 14px;padding:10px 12px;font-size:.85rem;line-height:1.55;box-shadow:0 1px 2px rgba(27,35,52,.07);white-space:pre-wrap">${esc(m.content || '')}
            ${window.CsReviewEditCard.inspectHtml(m.meta || {})}</div>
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
        if (failed(d) || !d.url) throw new Error((d && d.error) || "업로드 실패");
        item.url = d.url;
      } catch (e) {
        toast("사진 업로드 실패: " + friendlyErr(e, "잠시 후 다시 시도해 주세요."), true);
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

  // ★ 결정 359: 보내기 성공이 확인된 뒤에만 입력칸·첨부를 비운다. 실패하면 쓴 글·사진을 그대로 두고 이유를 알린다.
  //   (종전: 보내기 전에 먼저 비우고 `ok === false` 만 실패로 봐서, 통신 실패 {error} 때 글이 아무 안내 없이 사라졌다)
  // ★ 결정 361: 쓴 글 하나마다 키(clientMsgId)를 만들어, 같은 글을 다시 보낼 때마다 같은 키를 싣는다.
  //   시간 초과·끊김으로 응답만 못 받았는데 실제로는 저장됐으면, 서버가 같은 키를 알아보고 새로 저장하지 않는다(두 번 남지 않음).
  //   키는 「계정·방·글·사진」이 같을 때만 다시 쓴다 — 글이나 사진을 고치면 새 키(고친 글이 조용히 버려지지 않게).
  //   성공이 확인되면 키를 버린다(그다음 같은 글을 또 보내는 건 새 메시지).
  let _sending = false;
  let _draftKey = null;       // { fp, key }
  function newMsgKey() {
    try { if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch (_) {}
    let hex = "";
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") {
        const a = new Uint8Array(16); crypto.getRandomValues(a);
        hex = Array.prototype.map.call(a, b => ("0" + b.toString(16)).slice(-2)).join("");
      }
    } catch (_) { hex = ""; }
    if (!hex) for (let i = 0; i < 4; i++) hex += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
    return "rcs-" + Date.now().toString(36) + "-" + hex;
  }
  function draftKeyFor(fp) {
    if (!_draftKey || _draftKey.fp !== fp) _draftKey = { fp, key: newMsgKey() };
    return _draftKey.key;
  }
  async function send() {
    if (!_open || _sending) return;
    const user = getUser();
    const ta = document.getElementById("rcsInput");
    if (!ta) return;
    const content = ta.value.trim();
    // 업로드가 끝난 첨부만 전송 대상(업로드 중이면 잠시 대기 안내)
    if (_pending.some(p => !p.url)) { toast("사진 업로드가 끝나면 전송할 수 있어요"); return; }
    const imageUrls = _pending.map(p => p.url).filter(Boolean);
    if (!content && imageUrls.length === 0) return;
    const room = _open;
    const sentAttach = _pending.slice();
    const fp = JSON.stringify([String(user && user.phone8 || ""), room.campaignKey || "", room.campaignSource || "", content, imageUrls]);
    const clientMsgId = draftKeyFor(fp);
    const btn = document.getElementById("rcsSendBtn");
    _sending = true;
    if (btn) btn.disabled = true;
    let data = null;
    try {
      data = await gasPost({
        action: "csReviewerSend", phone8: user.phone8, name: user.name,
        campaignKey: room.campaignKey, campaignLabel: room.campaignLabel,
        campaignSource: room.campaignSource, content, imageUrls, clientMsgId,
      });
    } catch (err) { data = { ok: false, error: (err && err.message) || "" }; }
    _sending = false;
    if (btn) btn.disabled = false;
    if (failed(data)) {
      // 같은 키인데 내용이 다르다고 서버가 거절하면(드묾) 키를 버린다 — 다음 [보내기]는 새 메시지로 간다(막다른 길 방지).
      if (data && data.code === "cs_client_msg_conflict" && _draftKey && _draftKey.key === clientMsgId) _draftKey = null;
      // 입력칸·첨부는 건드리지 않는다 — 그대로 다시 [보내기] 누르면 된다(같은 키라 두 번 저장되지 않는다).
      toast("전송하지 못했어요. " + friendlyErr(data, "잠시 후 다시 보내 주세요."), true);
      return;
    }
    if (_draftKey && _draftKey.key === clientMsgId) _draftKey = null;   // 성공 확인 → 이 글의 키는 끝
    room.threadId = data.threadId || room.threadId;
    if (_open !== room) return;                       // 그 사이 다른 방으로 옮겼다
    if (ta.value.trim() === content) { ta.value = ""; ta.style.height = "auto"; }
    _pending = _pending.filter(p => sentAttach.indexOf(p) < 0); renderAttachBar();
    await reloadChat();
    if (typeof window.loadCsInbox === "function") { try { window.loadCsInbox(); } catch (_) {} }
  }

  // ── SSE (관리자 답장 실시간) ──
  function connectSSE() {
    const user = getUser();
    if (!user || !user.phone8) return;
    if (_sse) { try { _sse.close(); } catch (_) {} _sse = null; }
    try {
      _ssePhone8 = String(user.phone8);
      _sse = new EventSource(API_BASE_URL + "/api/reviewer/cs/events?phone8=" + encodeURIComponent(user.phone8));
      _sse.addEventListener("cs_message", function (event) {
        let data = {}; try { data = JSON.parse(event.data); } catch (_) {}
        // 총 미확인 수 뱃지 갱신(카톡식 숫자)
        refreshUnread(true);
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
    } catch (_) { _sse = null; _ssePhone8 = ""; }
  }

  // 로그인·관리자 바로가기 계정이 바뀌면 폴링을 기다리지 않고 즉시 반영한다.
  function syncSession() {
    ensureConnected();
    refreshUnread();
  }

  // ── 초기화 ──
  function init() {
    ensureConnected();
    refreshUnread();
    // 로그인/로그아웃 후 상태 변화 대응(가벼운 폴링) — SSE 연결 보장
    setInterval(ensureConnected, 3000);
    // SSE 누락 대비 안전망: 주기적 총 미확인 수 갱신
    setInterval(() => refreshUnread(true), 20000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.ReviewerCS = { open: openInbox, openChat, send, back: backToInbox, close: closeAll,
                        pickFiles, removeAttach, viewImage, refreshUnread, syncSession, reload: reloadChat };
})();
