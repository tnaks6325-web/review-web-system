/* 작업보드 미니 C/S
   C/S 메뉴와 같은 csAdminThreads / csAdminMessages / csAdminReply API를 사용한다.
   작업별 campaignKey(시트ID||작업명)만 클라이언트에서 좁혀, 별도 대화방/메시지 저장소가 생기지 않게 한다. */
(function () {
  'use strict';

  let state = null;
  let mountRevision = 0;

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const host = () => state && document.getElementById(state.hostId);
  const isMountedAndVisible = () => {
    const root = host();
    return !!(root && root.isConnected && root.getClientRects().length);
  };
  const roomForWork = (room) => String(room && room.campaignKey || '') === state.campaignKey;
  const byId = (id) => (state.rooms || []).find(room => String(room.id) === String(id));
  const requestError = (data, fallback) => {
    if (!data || data.ok === false || data.error) return (data && data.error) || fallback;
    return '';
  };
  const time = (iso) => {
    const date = new Date(iso || '');
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const notify = (message, isError) => {
    if (typeof window.showToast === 'function') window.showToast(message, !!isError);
  };
  const pendingImages = () => state && Array.isArray(state.pendingImages) ? state.pendingImages : [];
  const isImageFile = (file) => !!(file && /^image\//.test(file.type || ''));
  const readFile = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });

  function renderAttachments() {
    const pending = pendingImages();
    if (!pending.length) return '';
    return `<div class="wdcsmini-attachments" aria-label="전송할 첨부 이미지">${pending.map((item, index) =>
      `<div class="wdcsmini-attachment">${item.dataUrl ? `<img src="${esc(item.dataUrl)}" alt="첨부 예정 이미지">` : ''}` +
      (item.url ? '' : '<span class="wdcsmini-uploading" aria-label="업로드 중">…</span>') +
      `<button type="button" data-remove-image="${index}" aria-label="첨부 이미지 삭제">×</button></div>`
    ).join('')}</div>`;
  }

  function render() {
    const root = host();
    if (!root) return;
    const rooms = state.rooms || [];
    const active = byId(state.activeThreadId);
    const list = state.loading
      ? '<div class="wdcsmini-empty">대화 목록을 불러오는 중…</div>'
      : rooms.length
        ? rooms.map(room => {
            const selected = String(room.id) === String(state.activeThreadId);
            const initial = esc(String(room.reviewerName || '?').trim().charAt(0) || '?');
            const unread = Number(room.adminUnread || 0);
            return `<button type="button" class="wdcsmini-room${selected ? ' on' : ''}" data-thread-id="${esc(room.id)}" title="${esc(room.reviewerName || '리뷰어')} 대화 열기">`+
              `<span class="wdcsmini-avatar">${initial}</span><span class="wdcsmini-roomcopy"><b>${esc(room.reviewerName || '리뷰어')}</b><small>${esc(room.lastMessagePreview || '메시지 없음')}</small></span>`+
              (unread > 0 ? `<em>${unread}</em>` : '') + '</button>';
          }).join('')
        : '<div class="wdcsmini-empty">이 작업의 C/S 대화가 없습니다.</div>';
    const messages = state.loadingThread
      ? '<div class="wdcsmini-thread-empty">대화를 불러오는 중…</div>'
      : !active
        ? '<div class="wdcsmini-thread-empty">왼쪽에서 대화방을 선택하세요.</div>'
        : (state.messages || []).length
          ? state.messages.map(message => {
              const mine = message.senderRole === 'admin';
              const images = Array.isArray(message.imageUrls) ? message.imageUrls : [];
              const bubble = message.content ? `<div class="wdcsmini-bubble">${esc(message.content)}</div>` : '';
              const imageList = images.length ? `<div class="wdcsmini-images">${images.map(url => `<img src="${esc(url)}" alt="첨부 이미지" data-image-url="${esc(url)}">`).join('')}</div>` : '';
              return `<div class="wdcsmini-message${mine ? ' mine' : ''}"><span class="wdcsmini-sender">${esc(message.senderName || (mine ? '관리자' : '리뷰어'))}</span>${bubble}${imageList}<time>${time(message.createdAt)}</time></div>`;
            }).join('')
          : '<div class="wdcsmini-thread-empty">아직 메시지가 없습니다.</div>';
    const status = state.thread && state.thread.status === 'closed' ? '종료' : '진행중';
    root.innerHTML = `<div class="wdcsmini" aria-label="이 작업의 C/S 대화">`+
      `<div class="wdcsmini-head tp3t tp3h topcardhd" onclick="_topToggle()" title="클릭하면 상단 네 블록이 함께 접히거나 펼쳐집니다">C/S 대화<span class="tp3hint">접기/펼치기</span><span class="tp3chev">∨</span><button type="button" data-open-cs>전체보기 ↗</button></div>`+
      `<div class="wdcsmini-body"><aside class="wdcsmini-list"><div class="wdcsmini-listhead">채팅 목록 <b>${rooms.length}</b></div>${list}</aside>`+
        `<section class="wdcsmini-conversation"><div class="wdcsmini-context"><b>${active ? esc(active.reviewerName || '리뷰어') : '대화 선택'}</b><span>${active ? status : esc(state.label)}</span></div>`+
          `<div class="wdcsmini-messages">${messages}</div>`+
          `<form class="wdcsmini-compose" data-compose>`+
            `<input type="file" data-image-file accept="image/*" multiple hidden>`+
            `${renderAttachments()}`+
            `<div class="wdcsmini-compose-row"><button type="button" class="wdcsmini-attach-button" data-pick-image title="사진 첨부" aria-label="사진 첨부"${active && !state.sending ? '' : ' disabled'}>▧</button>`+
            `<input type="text" maxlength="2000" placeholder="메시지를 입력하세요 · 이미지 붙여넣기/드래그 가능" aria-label="C/S 메시지"${active && !state.sending ? '' : ' disabled'}>`+
            `<button type="submit"${active && !state.sending ? '' : ' disabled'}>${state.sending ? '전송 중' : '전송'}</button></div>`+
            `<div class="wdcsmini-drop-overlay" aria-hidden="true">여기에 이미지를 놓으세요</div>`+
          `</form>`+
        `</section></div></div>`;
    root.querySelectorAll('[data-thread-id]').forEach(el => el.addEventListener('click', () => openRoom(el.dataset.threadId)));
    const full = root.querySelector('[data-open-cs]');
    if (full) full.addEventListener('click', event => { event.stopPropagation(); if (typeof window.switchView === 'function') window.switchView('cs'); });
    root.querySelectorAll('[data-image-url]').forEach(el => el.addEventListener('click', () => {
      if (typeof window.csViewImage === 'function') window.csViewImage(el.dataset.imageUrl);
    }));
    root.querySelectorAll('[data-remove-image]').forEach(el => el.addEventListener('click', () => {
      const index = Number(el.dataset.removeImage);
      if (!Number.isInteger(index)) return;
      state.pendingImages.splice(index, 1);
      render();
    }));
    const form = root.querySelector('[data-compose]');
    if (form) {
      const input = form.querySelector('input[type="text"]');
      const fileInput = form.querySelector('[data-image-file]');
      const pick = form.querySelector('[data-pick-image]');
      if (input) {
        input.value = state.draft || '';
        input.addEventListener('input', () => { state.draft = input.value; });
        input.addEventListener('paste', handlePaste);
      }
      if (pick && fileInput) pick.addEventListener('click', () => fileInput.click());
      if (fileInput) fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        fileInput.value = ''; // 같은 사진도 다시 선택할 수 있게
        void addFiles(files);
      });
      bindDropZone(form);
      form.addEventListener('submit', send);
    }
    const scroll = root.querySelector('.wdcsmini-messages');
    if (scroll && active && !state.loadingThread) scroll.scrollTop = scroll.scrollHeight;
  }

  async function loadMore(revision, generation, offset) {
    while (state && state.revision === revision && state.generation === generation) {
      const data = await gasGet({ action: 'csAdminThreads', status: 'all', q: '', limit: 100, offset });
      if (requestError(data, '불러오기 실패') || !state || state.revision !== revision || state.generation !== generation) return;
      const seen = new Set(state.rooms.map(room => String(room.id)));
      const more = (data.threads || []).filter(room => roomForWork(room));
      if (more.length) {
        more.forEach(room => {
          const index = state.rooms.findIndex(existing => String(existing.id) === String(room.id));
          if (index >= 0) state.rooms[index] = room;
          else if (!seen.has(String(room.id))) state.rooms.push(room);
        });
        render();
      }
      offset += (data.threads || []).length;
      if (!data.hasMore || !(data.threads || []).length) return;
    }
  }

  async function loadRooms() {
    if (!state) return;
    const revision = state.revision;
    const generation = ++state.generation;
    state.loading = true;
    render();
    try {
      const data = await gasGet({ action: 'csAdminThreads', status: 'all', q: '', limit: 100, offset: 0 });
      const error = requestError(data, '불러오기 실패');
      if (error) throw new Error(error);
      if (!state || state.revision !== revision || state.generation !== generation) return;
      const previousActive = byId(state.activeThreadId);
      state.rooms = (data.threads || []).filter(roomForWork);
      /* 현재 방이 2페이지 이후에 있을 수 있다. 첫 페이지를 읽자마자 선택을 지우면 SSE·답장 뒤
         대화가 닫히므로, 나머지 페이지를 찾는 동안에는 마지막 알려진 방을 임시로 유지한다. */
      if (state.activeThreadId && !byId(state.activeThreadId)) {
        if (data.hasMore && previousActive) state.rooms.push(previousActive);
        else { state.activeThreadId = null; state.thread = null; state.messages = []; }
      }
      state.loading = false;
      render();
      if (!state.activeThreadId && state.rooms.length) void openRoom(state.rooms[0].id);
      if (data.hasMore) void loadMore(revision, generation, 100);
    } catch (error) {
      if (!state || state.revision !== revision || state.generation !== generation) return;
      state.loading = false;
      const root = host();
      if (root) root.innerHTML = `<div class="wdcsmini wdcsmini-error">C/S 대화를 불러오지 못했습니다. ${esc(error.message)}</div>`;
    }
  }

  async function openRoom(threadId) {
    if (!state || !byId(threadId)) return;
    const activeState = state;
    if (String(activeState.activeThreadId || '') !== String(threadId)) {
      activeState.pendingImages = [];
      activeState.draft = '';
      activeState.sending = false;
    }
    activeState.activeThreadId = String(threadId);
    activeState.loadingThread = true;
    render();
    try {
      const data = await gasGet({ action: 'csAdminMessages', threadId });
      const error = requestError(data, '불러오기 실패');
      if (error) throw new Error(error);
      if (state !== activeState || String(state.activeThreadId) !== String(threadId)) return;
      state.thread = data.thread || byId(threadId);
      state.messages = data.messages || [];
      state.loadingThread = false;
      const room = byId(threadId); if (room) room.adminUnread = 0;
      render();
      if (typeof window.csRefreshBadge === 'function') window.csRefreshBadge();
    } catch (error) {
      if (state !== activeState || String(state.activeThreadId) !== String(threadId)) return;
      state.loadingThread = false;
      state.messages = [];
      render();
      if (typeof window.showToast === 'function') window.showToast('C/S 대화 불러오기 오류: ' + error.message, true);
    }
  }

  async function send(event) {
    event.preventDefault();
    if (!state || !state.activeThreadId) return;
    const input = event.currentTarget.querySelector('input[type="text"]');
    const content = String(input && input.value || '').trim();
    const pending = pendingImages();
    if (pending.some(item => !item.url)) { notify('사진 업로드가 끝나면 전송할 수 있어요'); return; }
    const imageUrls = pending.map(item => item.url).filter(Boolean);
    if (!content && !imageUrls.length) return;
    const activeThreadId = state.activeThreadId;
    const sentImages = pending.slice();
    state.draft = '';
    state.pendingImages = [];
    state.sending = true;
    render();
    try {
      const data = await gasPost({ action: 'csAdminReply', threadId: activeThreadId, content, imageUrls });
      const error = requestError(data, '전송 실패');
      if (error) throw new Error(error);
      if (!state || String(state.activeThreadId) !== String(activeThreadId)) return;
      state.sending = false;
      await openRoom(activeThreadId);
      void loadRooms();
      if (document.getElementById('csRoomListWrap') && typeof window.loadCsRooms === 'function') void window.loadCsRooms();
    } catch (error) {
      if (!state || String(state.activeThreadId) !== String(activeThreadId)) return;
      state.draft = content;
      state.pendingImages = sentImages;
      state.sending = false;
      render();
      const retryInput = host() && host().querySelector('.wdcsmini-compose input[type="text"]');
      if (retryInput) retryInput.focus();
      notify('C/S 답장 전송 오류: ' + error.message, true);
    }
  }

  function removeUpload(item) {
    if (!state) return;
    const index = pendingImages().indexOf(item);
    if (index >= 0) state.pendingImages.splice(index, 1);
  }

  function isCurrentComposer(expectedState, expectedThreadId) {
    return state === expectedState && String(state && state.activeThreadId || '') === String(expectedThreadId || '');
  }

  async function uploadImage(file, expectedState, expectedThreadId) {
    if (!state) return;
    const uploadState = expectedState || state;
    const uploadThreadId = expectedThreadId == null ? state.activeThreadId : expectedThreadId;
    if (!isCurrentComposer(uploadState, uploadThreadId)) return;
    if (pendingImages().length >= 5) { notify('사진은 최대 5장까지 첨부할 수 있어요'); return; }
    if (!isImageFile(file)) { notify('사진 파일만 첨부할 수 있어요'); return; }
    if (file.size > 8 * 1024 * 1024) { notify('8MB 이하 사진만 첨부할 수 있어요'); return; }
    /* 파일 읽기가 비동기여도 이 자리부터 슬롯을 차지한다. 동시에 여러 붙여넣기/드롭이
       들어와도 5장을 넘겨 서버에서 조용히 잘리는 일을 막는다. */
    const item = { name: file.name || `paste_${Date.now()}.png`, dataUrl: '', url: '' };
    pendingImages().push(item);
    render();
    try {
      item.dataUrl = await readFile(file);
      if (!isCurrentComposer(uploadState, uploadThreadId) || !pendingImages().includes(item)) { removeUpload(item); return; }
      const data = await gasPost({ action: 'csAdminUpload', fileName: item.name, mimeType: file.type || 'image/png', imageBase64: item.dataUrl }, 120000);
      const error = requestError(data, '업로드 실패');
      if (error || !data.url) throw new Error(error || '업로드 실패');
      if (!isCurrentComposer(uploadState, uploadThreadId) || !pendingImages().includes(item)) return;
      item.url = data.url;
    } catch (error) {
      if (state !== uploadState) return;
      removeUpload(item);
      notify('사진 업로드 실패: ' + error.message, true);
    }
    if (state === uploadState) render();
  }

  async function addFiles(files) {
    const chosen = Array.from(files || []);
    const uploadState = state;
    const uploadThreadId = state && state.activeThreadId;
    for (const file of chosen) {
      if (!isCurrentComposer(uploadState, uploadThreadId)) return;
      await uploadImage(file, uploadState, uploadThreadId);
    }
  }

  async function handlePaste(event) {
    const imageItems = Array.from((event.clipboardData && event.clipboardData.items) || [])
      .filter(item => item.kind === 'file' && /^image\//.test(item.type || ''));
    if (!imageItems.length) return;
    event.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) await uploadImage(file);
    }
  }

  function bindDropZone(form) {
    const overlay = form.querySelector('.wdcsmini-drop-overlay');
    const hasFiles = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files');
    form.addEventListener('dragover', event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (overlay) overlay.classList.add('on');
    });
    form.addEventListener('dragleave', event => {
      if (overlay && !form.contains(event.relatedTarget)) overlay.classList.remove('on');
    });
    form.addEventListener('drop', async event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (overlay) overlay.classList.remove('on');
      await addFiles(event.dataTransfer && event.dataTransfer.files);
    });
  }

  function mount(hostId, context) {
    const root = document.getElementById(hostId || 'workdeskCsMini');
    const sheetId = String(context && context.sheetId || '');
    const tabName = String(context && context.tabName || '');
    if (!root || !sheetId || !tabName) return false;
    state = { hostId: root.id, campaignKey: sheetId + '||' + tabName, label: String(context && context.label || tabName), rooms: [], activeThreadId: null, thread: null, messages: [], draft: '', pendingImages: [], sending: false, loading: true, loadingThread: false, generation: 0, revision: ++mountRevision };
    void loadRooms();
    return true;
  }

  window.addEventListener('cs:sse', (event) => {
    if (!state) return;
    /* 다른 화면으로 이동해 카드가 사라졌다면 메시지를 다시 읽지 않는다.
       csAdminMessages는 열람 처리까지 수행하므로 숨은 카드의 SSE 재조회가 미확인을 지우면 안 된다. */
    if (!isMountedAndVisible()) { state = null; return; }
    const data = event && event.detail && event.detail.data || {};
    if (data.threadId && String(data.threadId) === String(state.activeThreadId)) void openRoom(state.activeThreadId);
    void loadRooms();
  });
  window.WorkdeskCsMini = { mount, refresh: loadRooms };
})();
