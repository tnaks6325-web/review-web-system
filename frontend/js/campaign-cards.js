/* ═══════════════════════════════════════════════════════════
   campaign-cards.js — 참여형 캠페인 공용 카드 모듈 (M2)
   소비처: index.html(리뷰어 홈)·recruit.html(공유용 목록)
   서버가 내려주는 state(preopen/open/cutoff/daily_done/soft_full/closed)와
   serverNow/opensAt/closesAt/cutoffAt로 렌더 — 시계는 서버시간 오프셋 보정(기기 시계 불신).
   카드 탭 → campaign.html?id=… (참여·작업내용·제출은 전용 상세 페이지에서만)
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  let _serverOffsetMs = 0;          // serverNow - Date.now()
  let _tickTimer = null;
  let _onNeedRefresh = null;        // 카운트다운 0 도달 시 목록 재조회 콜백

  function _now() { return Date.now() + _serverOffsetMs; }

  function setServerNow(serverNowIso) {
    const t = Date.parse(serverNowIso || '');
    if (Number.isFinite(t)) _serverOffsetMs = t - Date.now();
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function _fmtHM(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function _fmtCountdown(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return hh + ' : ' + mm + ' : ' + ss;
  }

  function _injectStyles() {
    if (document.getElementById('campCardsCss')) return;
    const st = document.createElement('style');
    st.id = 'campCardsCss';
    st.textContent = `
      .pcard{position:relative;background:#fff;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;
        box-shadow:0 2px 10px rgba(21,40,80,.06);margin-bottom:12px;cursor:pointer}
      .pcard .pthumb{height:96px;background:#EEF1F7 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:1.4rem}
      .pcard .pbody{padding:10px 12px;display:flex;flex-direction:column;gap:6px}
      .pcard .prow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .pcard .pchip{font-size:.62rem;font-weight:800;background:#FEF3C7;color:#92400E;border-radius:5px;padding:2px 7px;flex-shrink:0}
      .pcard .plive{font-size:.6rem;font-weight:900;background:#12b886;color:#fff;border-radius:5px;padding:2px 7px;flex-shrink:0}
      .pcard .ptitle{font-size:.86rem;font-weight:800;color:#111827;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pcard .pmeta{display:flex;gap:10px;flex-wrap:wrap;font-size:.7rem;color:#6B7280}
      .pcard .pcounter{display:inline-flex;align-items:center;gap:5px;font-size:.74rem;font-weight:800;color:#0ca678;background:#D1FAE5;border-radius:12px;padding:2px 10px}
      .pcard .pcounter.full{color:#B45309;background:#FEF3C7}
      .pcard .pbtn{display:block;text-align:center;background:linear-gradient(135deg,#3182f6,#1b64da);color:#fff;
        font-size:.8rem;font-weight:800;border-radius:9px;padding:10px;margin-top:2px}
      .pcard .pbtn.off{background:#EEF1F7;color:#94A3B8}
      .pcard .pnote{font-size:.64rem;color:#9CA3AF;text-align:center}
      .pcard .poverlay{position:absolute;inset:0;background:rgba(38,44,58,.66);backdrop-filter:grayscale(1);
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;z-index:2}
      .pcard .poverlay .ol{font-size:.66rem;font-weight:700;color:rgba(255,255,255,.85);letter-spacing:.08em}
      .pcard .poverlay .ot{font-size:1.35rem;font-weight:900;color:#fff;letter-spacing:.05em;font-variant-numeric:tabular-nums}
      .pcard .pribbon{position:absolute;top:10px;right:10px;z-index:3;font-size:.62rem;font-weight:900;border-radius:6px;padding:3px 8px;color:#fff}
      .pcard .pribbon.done{background:#F59E0B}.pcard .pribbon.closedr{background:#94A3B8}
      .pcard .peditchip{position:absolute;top:10px;left:10px;z-index:4;font-size:.6rem;font-weight:900;background:rgba(17,24,39,.78);color:#fff;border-radius:6px;padding:3px 8px}
      .cae-ovl{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px}
      .cae-box{box-sizing:border-box;background:#fff;border-radius:16px;max-width:480px;width:100%;max-height:88vh;overflow-y:auto;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
      .cae-box *{box-sizing:border-box}
      .cae-box h3{font-size:.95rem;font-weight:800;color:#111827;margin:0 0 10px;display:flex;align-items:center;gap:8px}
      .cae-lb{display:block;font-size:.7rem;font-weight:800;color:#4B5563;margin:9px 0 3px}
      .cae-in{width:100%;box-sizing:border-box;border:1.5px solid #E5E7EB;border-radius:8px;padding:8px 10px;font-size:.82rem;background:#fff;color:#111827}
      .cae-g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .cae-btn{border:none;cursor:pointer;border-radius:9px;font-weight:800;font-size:.8rem;padding:10px 14px}
      .cae-btn.pri{background:linear-gradient(135deg,#3182f6,#1b64da);color:#fff;flex:1}
      .cae-btn.gho{background:#EEF1F7;color:#4B5563}
      .cae-note{font-size:.64rem;color:#9CA3AF;margin-top:3px}
      .cae-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:100001;background:#111827;color:#fff;
        font-size:.8rem;font-weight:700;border-radius:10px;padding:10px 16px;max-width:86vw;box-shadow:0 4px 16px rgba(0,0,0,.3)}
      .cae-toast.err{background:#DC2626}
    `;
    document.head.appendChild(st);
  }

  /** 상태별 하단 버튼/배지 HTML */
  function _footer(c) {
    switch (c.state) {
      case 'open':
        return `<span class="pbtn">참여하기</span>
                ${c.cutoffAt ? `<div class="pnote">오늘 ${_fmtHM(c.cutoffAt)}까지 참여 가능</div>` : ''}`;
      case 'cutoff':
        return `<span class="pbtn off">오늘 참여 마감</span>
                <div class="pnote">진행 중인 분은 ${_fmtHM(c.closesAt)}까지 제출</div>`;
      case 'daily_done':
        // 자율주문(시간창 없음)은 opensAt이 없음 → 시각 없이 "내일 다시 오픈"
        return `<span class="pbtn off">오늘은 마감되었어요</span>
                <div class="pnote">${c.opensAt ? `내일 ${_fmtHM(c.opensAt)} 다시 오픈` : '내일 다시 오픈'}</div>`;
      case 'soft_full':
        return `<span class="pbtn off">잔여 대기 중</span>
                <div class="pnote">자리가 나면 다시 열려요</div>`;
      default:
        return '';
    }
  }

  /** 참여형 카드 1장 HTML. c = /api/campaign/list 의 참여형 행 */
  function cardHtml(c) {
    const channel = c.channel === '직접입력' ? (c.channel_custom || '') : (c.channel || '');
    const fee = c.review_fee ? Number(c.review_fee).toLocaleString() + '원' : '';
    const isClosed = c.state === 'closed' || c.status === 'closed';
    const isPre = c.state === 'preopen';
    const counter = (c.dailyQuota > 0)
      ? `<span class="pcounter${c.todayCount >= c.dailyQuota ? ' full' : ''}">🔥 ${c.todayCount}/${c.dailyQuota} 참여중</span>`
      : '';
    const thumb = c.thumbnail_url
      ? `<div class="pthumb" style="background-image:url('${_esc(c.thumbnail_url)}')"></div>`
      : `<div class="pthumb">🛍️</div>`;

    let ribbon = '';
    if (c.state === 'daily_done') ribbon = `<span class="pribbon done">금일 모집완료</span>`;
    if (isClosed) ribbon = `<span class="pribbon closedr">모집 종료</span>`;

    // preopen: 회색 필터 + 굵은 흰 글씨 실시간 카운트다운(요구사항 원문)
    const overlay = isPre
      ? `<div class="poverlay">
           <div class="ol">오픈까지</div>
           <div class="ot" data-camp-countdown="${_esc(c.opensAt || '')}">--:--:--</div>
           <div class="ol">매일 ${_fmtHM(c.opensAt)} 오픈</div>
         </div>`
      : '';

    return `
      <div class="pcard" data-camp-id="${_esc(c.id)}" style="${isClosed ? 'opacity:.55;filter:grayscale(1);' : ''}"
           onclick="CampCards._onCardClick(event, '${_esc(c.id)}')">
        ${_adminTok() ? '<span class="peditchip">✏️ 관리자 수정</span>' : ''}
        ${ribbon}${overlay}
        ${thumb}
        <div class="pbody">
          <div class="prow">
            ${channel ? `<span class="pchip">${_esc(channel)}</span>` : ''}
            <span class="plive">바로참여</span>
            <span class="ptitle">${_esc(c.title || '(제목 없음)')}</span>
          </div>
          <div class="pmeta">
            ${c.delivery_type ? `<span>🚚 ${_esc(c.delivery_type)}</span>` : ''}
            ${(c.opensAt && c.closesAt) ? `<span>🕑 ${_fmtHM(c.opensAt)}~${_fmtHM(c.closesAt)}</span>` : (c.time_range ? `<span>🕑 ${_esc(c.time_range)}</span>` : '')}
            ${fee ? `<span>💰 리뷰비 ${fee}</span>` : ''}
          </div>
          ${(!isClosed && !isPre) ? `<div class="prow">${counter}</div>` : ''}
          ${!isClosed ? _footer(c) : ''}
        </div>
      </div>`;
  }

  /** 목록 렌더: 참여형만 골라 컨테이너에 그려넣음. 반환 = 그린 카드 수 */
  function renderInto(el, list, serverNowIso, onNeedRefresh) {
    _injectStyles();
    if (serverNowIso) setServerNow(serverNowIso);
    _onNeedRefresh = onNeedRefresh || null;
    const parts = (list || []).filter(c => c.participation_mode);
    if (!el) return 0;
    el.innerHTML = parts.map(cardHtml).join('');
    _ensureTicker();
    return parts.length;
  }

  /** 1초 틱: 모든 [data-camp-countdown] 갱신. 0 도달 시 onNeedRefresh 1회 호출(상태 전환 재조회) */
  function _ensureTicker() {
    if (_tickTimer) return;
    _tickTimer = setInterval(() => {
      const els = document.querySelectorAll('[data-camp-countdown]');
      if (!els.length) { clearInterval(_tickTimer); _tickTimer = null; return; }
      let hitZero = false;
      els.forEach(e => {
        const target = Date.parse(e.getAttribute('data-camp-countdown') || '');
        if (!Number.isFinite(target)) { e.textContent = '--:--:--'; return; }
        const remain = target - _now();
        e.textContent = _fmtCountdown(remain);
        if (remain <= 0 && !e._campZeroFired) { e._campZeroFired = true; hitZero = true; }
      });
      if (hitZero && typeof _onNeedRefresh === 'function') {
        // 서버 목록 5초 캐시 동안 preopen이 유지되면 재렌더→플래그 소실→재조회가 반복될 수 있어 5초 스로틀(N1)
        const nowMs = Date.now();
        if (!_ensureTicker._lastZeroRefresh || nowMs - _ensureTicker._lastZeroRefresh > 5000) {
          _ensureTicker._lastZeroRefresh = nowMs;
          try { _onNeedRefresh(); } catch (_) { /* noop */ }
        }
      }
    }, 1000);
  }

  /** 문자열 렌더 경로용: 카드 HTML을 직접 innerHTML 했을 때 카운트다운 틱 시작 */
  function startTicker(onNeedRefresh) {
    _injectStyles();
    if (onNeedRefresh) _onNeedRefresh = onNeedRefresh;
    _ensureTicker();
  }

  /* ═══ 관리자 인라인 수정 (index.html·recruit.html 공용) ═══
     admin_token(세션/로컬)이 있으면 카드 클릭 = 수정 모달(리뷰어 화면은 모달 내 [👁] 링크),
     없으면 기존처럼 campaign.html 이동. 저장은 기존 PUT /api/campaign/admin/:id
     (COALESCE 병합 — 모달에 없는 필드는 미전송=유지)라 관리자 대시보드와 같은 원장
     (recruit_campaigns)에 즉시 동기화. 서버 무변경.
     ★ review_fee/max_slots/sort_order는 서버가 미전송을 0으로 강제(`|| 0`)하므로
       로드값을 그대로 항상 전송해 0-덮어쓰기를 방지한다. */

  function _adminTok() {
    try {
      // 관리자 페이지 토큰(admin_token) 또는 리뷰어 앱 공고수정 스코프 토큰(마스터 허용명단 발급)
      return sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token')
        || sessionStorage.getItem('rapp_camp_edit_token') || '';
    } catch (_) { return ''; }
  }
  function _apiBase() {
    return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '';
  }
  function _toast(msg, isErr) {
    _injectStyles();
    const t = document.createElement('div');
    t.className = 'cae-toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  function _onCardClick(ev, id) {
    if (_adminTok()) {
      ev.preventDefault(); ev.stopPropagation();
      openAdminEdit(id);
      return;
    }
    location.href = 'campaign.html?id=' + encodeURIComponent(id);
  }

  let _caeLoaded = null; // { id, max_slots, sort_order } — 0-덮어쓰기 방지용 원본 보존

  function _caeEl() {
    _injectStyles();
    let ovl = document.getElementById('caeOvl');
    if (ovl) return ovl;
    ovl = document.createElement('div');
    ovl.id = 'caeOvl';
    ovl.className = 'cae-ovl';
    ovl.innerHTML = `
      <div class="cae-box">
        <h3>✏️ 공고 수정 <span style="flex:1"></span>
          <a id="caeViewLink" href="#" target="_blank" style="font-size:.7rem;font-weight:800;color:#1b64da;text-decoration:none">👁 리뷰어 화면</a></h3>
        <label class="cae-lb">공고 제목</label>
        <input id="cae_title" class="cae-in" type="text">
        <div class="cae-g2">
          <div><label class="cae-lb">상태</label>
            <select id="cae_status" class="cae-in">
              <option value="draft">임시저장</option>
              <option value="active">모집중</option>
              <option value="closed">마감</option>
            </select></div>
          <div><label class="cae-lb">배송 형태</label>
            <select id="cae_delivery" class="cae-in">
              <option value="">선택 안 함</option>
              <option value="빈택배">빈택배</option>
              <option value="실배송">실배송</option>
              <option value="회수건">회수건</option>
            </select></div>
        </div>
        <div class="cae-g2">
          <div><label class="cae-lb">리뷰비(원)</label><input id="cae_fee" class="cae-in" type="number" min="0"></div>
          <div><label class="cae-lb">시간 표기(텍스트)</label><input id="cae_time_range" class="cae-in" type="text" placeholder="예: 14~16시"></div>
        </div>
        <div class="cae-g2">
          <div><label class="cae-lb">구매시간 시작</label><input id="cae_ws" class="cae-in" type="time"></div>
          <div><label class="cae-lb">구매시간 종료</label><input id="cae_we" class="cae-in" type="time"></div>
        </div>
        <div class="cae-note">비워 두면 기존 설정 유지 — 시간창 비우기(자율주문 전환)는 대시보드에서</div>
        <div class="cae-g2">
          <div><label class="cae-lb">하루 진행 인원</label><input id="cae_daily" class="cae-in" type="number" min="0"></div>
          <div><label class="cae-lb">총 모집(0=무제한)</label><input id="cae_total" class="cae-in" type="number" min="0"></div>
        </div>
        <label class="cae-lb">랜딩(상품) URL</label>
        <input id="cae_landing" class="cae-in" type="text" placeholder="https://">
        <label class="cae-lb">썸네일 URL <span style="font-weight:400;color:#9CA3AF">(비우면 제거)</span></label>
        <input id="cae_thumb" class="cae-in" type="text" placeholder="저장된 썸네일 주소">
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
          <input id="cae_thumb_url" class="cae-in" type="url" style="flex:1;min-width:0" placeholder="쿠팡 이미지 주소 붙여넣기 (우클릭 → 이미지 주소 복사)">
          <button type="button" id="caeThumbFetch" class="cae-btn gho" style="white-space:nowrap">가져오기</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
          <input id="cae_thumb_file" type="file" accept="image/*" style="font-size:.7rem;flex:1;min-width:0">
          <img id="cae_thumb_prev" alt="" style="height:40px;border-radius:8px;border:1px solid #E5E7EB;display:none">
        </div>
        <div class="cae-note">채널·모집내용·작업내용 등 전체 항목 수정은 관리자 대시보드 → 캠페인 탭에서</div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button type="button" id="caeSave" class="cae-btn pri">저장</button>
          <button type="button" id="caeClose" class="cae-btn gho">닫기</button>
        </div>
      </div>`;
    ovl.addEventListener('click', (e) => { if (e.target === ovl) ovl.remove(); });
    ovl.querySelector('#caeClose').addEventListener('click', () => ovl.remove());
    ovl.querySelector('#caeSave').addEventListener('click', _caeSave);
    ovl.querySelector('#caeThumbFetch').addEventListener('click', _caeThumbFromUrl);
    ovl.querySelector('#cae_thumb_file').addEventListener('change', _caeThumbFromFile);
    ovl.querySelector('#cae_thumb').addEventListener('input', _caeSyncPreview);
    document.body.appendChild(ovl);
    return ovl;
  }

  function _caeV(id) { const el = document.getElementById(id); return el ? el.value : ''; }
  function _caeSyncPreview() {
    const url = _caeV('cae_thumb').trim();
    const img = document.getElementById('cae_thumb_prev');
    if (!img) return;
    if (url) { img.src = url; img.style.display = ''; } else { img.style.display = 'none'; }
  }

  async function openAdminEdit(id) {
    const tok = _adminTok();
    if (!tok) return;
    let data = null;
    try {
      const r = await fetch(_apiBase() + '/api/campaign/' + encodeURIComponent(id), {
        headers: { 'Authorization': 'Bearer ' + tok },
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || '조회 실패');
      data = j.data;
    } catch (e) {
      _toast('공고 조회 실패: ' + e.message, true);
      return;
    }
    // 공개 화이트리스트 응답(sort_order 없음) = 토큰 만료/무효 — 부분 프리필로 저장하면 오염되므로 차단
    if (!data || data.sort_order === undefined) {
      _toast('관리자 로그인이 만료되었습니다. /admin에서 다시 로그인해 주세요.', true);
      return;
    }
    _caeLoaded = { id: data.id, max_slots: data.max_slots || 0, sort_order: data.sort_order || 0 };
    const ovl = _caeEl();
    ovl.querySelector('#caeViewLink').href = 'campaign.html?id=' + encodeURIComponent(data.id);
    document.getElementById('cae_title').value = data.title || '';
    document.getElementById('cae_status').value = ['draft', 'active', 'closed'].includes(data.status) ? data.status : 'draft';
    document.getElementById('cae_delivery').value = data.delivery_type || '';
    document.getElementById('cae_fee').value = data.review_fee != null ? data.review_fee : '';
    document.getElementById('cae_time_range').value = data.time_range || '';
    document.getElementById('cae_ws').value = (data.window_start || '').slice(0, 5);
    document.getElementById('cae_we').value = (data.window_end || '').slice(0, 5);
    document.getElementById('cae_daily').value = data.daily_limit != null ? data.daily_limit : '';
    document.getElementById('cae_total').value = data.recruit_total != null ? data.recruit_total : '';
    document.getElementById('cae_landing').value = data.landing_url || '';
    document.getElementById('cae_thumb').value = data.thumbnail_url || '';
    document.getElementById('cae_thumb_url').value = '';
    _caeSyncPreview();
  }

  // 쿠팡 CDN 이미지주소 → 서버 재저장(기존 guide-image imageUrl 분기 재사용, 허용목록·5MB는 서버 강제)
  async function _caeThumbFromUrl() {
    const url = _caeV('cae_thumb_url').trim();
    if (!url) { _toast('이미지 주소를 붙여넣으세요. (쿠팡 이미지 우클릭 → 이미지 주소 복사)', true); return; }
    if (!/^https:\/\//i.test(url)) { _toast('https:// 로 시작하는 이미지 주소만 지원합니다.', true); return; }
    _toast('이미지 가져오는 중...');
    try {
      const r = await fetch(_apiBase() + '/api/order/guide-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _adminTok() },
        body: JSON.stringify({ imageUrl: url, fileName: 'campthumb_' + Date.now() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok || !j.url) throw new Error(j.error || '수집 실패');
      document.getElementById('cae_thumb').value = j.url;
      document.getElementById('cae_thumb_url').value = '';
      _caeSyncPreview();
      _toast('썸네일이 등록되었습니다. [저장]을 눌러 반영하세요.');
    } catch (e) { _toast('썸네일 수집 실패: ' + e.message, true); }
  }

  async function _caeThumbFromFile(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { _toast('이미지는 5MB 이하로 올려주세요.', true); input.value = ''; return; }
    _toast('썸네일 업로드 중...');
    try {
      const b64 = await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(String(rd.result).split(',')[1]);
        rd.onerror = rej;
        rd.readAsDataURL(file);
      });
      const r = await fetch(_apiBase() + '/api/order/guide-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _adminTok() },
        body: JSON.stringify({ imageBase64: b64, mimeType: file.type || 'image/jpeg', fileName: 'campthumb_' + Date.now() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok || !j.url) throw new Error(j.error || '업로드 실패');
      document.getElementById('cae_thumb').value = j.url;
      _caeSyncPreview();
      _toast('썸네일이 업로드되었습니다. [저장]을 눌러 반영하세요.');
    } catch (e) { _toast('썸네일 업로드 실패: ' + e.message, true); }
    finally { input.value = ''; }
  }

  async function _caeSave() {
    if (!_caeLoaded) return;
    const title = _caeV('cae_title').trim();
    if (!title) { _toast('공고 제목을 입력해주세요.', true); return; }
    const payload = {
      title,
      status: _caeV('cae_status'),
      delivery_type: _caeV('cae_delivery'),
      review_fee: Number(_caeV('cae_fee')) || 0,
      time_range: _caeV('cae_time_range').trim(),
      max_slots: _caeLoaded.max_slots,     // 서버 `|| 0` 강제 필드 — 로드값 그대로 재전송(0-덮어쓰기 방지)
      sort_order: _caeLoaded.sort_order,
      thumbnail_url: _caeV('cae_thumb').trim(),
      landing_url: _caeV('cae_landing').trim(),
      window_start: _caeV('cae_ws') || null,   // 빈값=null → 서버 COALESCE 유지(대시보드 폼과 동일 시맨틱)
      window_end: _caeV('cae_we') || null,
      daily_limit: _caeV('cae_daily') === '' ? null : Number(_caeV('cae_daily')) || 0,
      recruit_total: _caeV('cae_total') === '' ? null : Number(_caeV('cae_total')) || 0,
    };
    const btn = document.getElementById('caeSave');
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const r = await fetch(_apiBase() + '/api/campaign/admin/' + encodeURIComponent(_caeLoaded.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _adminTok() },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (r.status === 401 || r.status === 403) throw new Error('관리자 로그인이 만료되었거나 권한이 없습니다. /admin에서 다시 로그인해 주세요.');
      if (!r.ok || !j.ok) throw new Error(j.error || '저장 실패');
      const ovl = document.getElementById('caeOvl');
      if (ovl) ovl.remove();
      _toast('저장되었습니다 — 관리자 대시보드와 동기화 완료');
      if (typeof _onNeedRefresh === 'function') { try { _onNeedRefresh(); } catch (_) { /* noop */ } }
    } catch (e) {
      _toast(e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = '저장';
    }
  }

  window.CampCards = { renderInto, cardHtml, setServerNow, startTicker, _fmtCountdown, _fmtHM, serverNow: _now, _onCardClick, openAdminEdit };
})();
