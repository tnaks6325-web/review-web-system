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
      /* 참여형 카드 — 항상 2열(리뷰어 페이지 폭 안에 2개). 리뷰어 앱은 max-width로 폭이
         고정(index 440px·recruit 560px)이라 뷰포트 media로 열수를 늘리면(넓은 데스크톱에서
         공고 페이지를 볼 때) 고정폭 안에 3~4열이 욱여넣어져 카드가 짜부라진다 → 열수 고정.
         ★ 부모가 이미 grid(.rc-list.rc-view-card)여도 한 칸에 갇히지 않게 전체폭 점유(grid-column:1/-1). */
      .pcards-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:12px;grid-column:1/-1;width:100%}
      .pcard{position:relative;background:#fff;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;
        box-shadow:0 2px 10px rgba(21,40,80,.06);cursor:pointer;display:flex;flex-direction:column}
      .pcard.is-closed{opacity:.6;filter:grayscale(1)}
      .pcard.is-dim .pt-img,.pcard.is-dim .pt-ph{filter:grayscale(.35)}
      /* 썸네일: 정사각 전체 노출(잘림 없음) */
      .pcard .pthumb{position:relative;width:100%;aspect-ratio:1/1;background:#F1F4FA;overflow:hidden}
      .pcard .pt-img{width:100%;height:100%;object-fit:contain;display:block}
      .pcard .pt-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:1.9rem}
      /* 우측 상단: 채널·배송 배지 */
      .pcard .pt-badges{position:absolute;top:8px;right:8px;z-index:6;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;max-width:82%}
      .pcard .pt-badge{font-size:.6rem;font-weight:800;border-radius:6px;padding:2px 6px;box-shadow:0 1px 3px rgba(0,0,0,.16);white-space:nowrap}
      .pcard .pt-badge.ch{background:rgba(255,255,255,.95);color:#1550b8}
      .pcard .pt-badge.dl{background:rgba(21,27,38,.76);color:#fff}
      /* 좌측 상단: 관리자수정 버튼 + 상태 리본 */
      .pcard .pt-topleft{position:absolute;top:8px;left:8px;z-index:6;display:flex;flex-direction:column;gap:4px;align-items:flex-start}
      .pcard .pt-ribbon{font-size:.6rem;font-weight:900;border-radius:6px;padding:2px 7px;color:#fff}
      .pcard .pt-ribbon.done{background:#F59E0B}
      .pcard .pt-ribbon.closedr{background:#94A3B8}
      /* 관리자 수정 버튼: 썸네일 좌하단(상단 배지·리본과 겹치지 않게) */
      .pcard .peditchip{position:absolute;bottom:8px;left:8px;z-index:7;font-size:.6rem;font-weight:900;background:#1B64DA;color:#fff;border:none;border-radius:6px;padding:3px 8px;cursor:pointer;box-shadow:0 1px 5px rgba(0,0,0,.3)}
      .pcard .peditchip:hover{background:#1550b8}
      /* 오버레이: 오픈전(회색) / 모집중 시간창(구매마감 카운트다운, 라이브) */
      .pcard .pt-ovl{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:6px;text-align:center}
      .pcard .pt-ovl.pre{background:rgba(24,30,45,.62);backdrop-filter:grayscale(1)}
      .pcard .pt-ovl.now{background:linear-gradient(180deg,rgba(10,16,30,.26),rgba(10,16,30,.64))}
      .pcard .pt-ovl .ol{font-size:.6rem;font-weight:700;color:rgba(255,255,255,.86);letter-spacing:.04em}
      .pcard .pt-ovl .lab{font-size:.62rem;font-weight:800;color:rgba(255,255,255,.92)}
      .pcard .pt-ovl .ot{font-size:1.15rem;font-weight:900;color:#fff;font-variant-numeric:tabular-nums;letter-spacing:.02em;text-shadow:0 1px 8px rgba(0,0,0,.4)}
      .pcard .pt-ovl .live-pill{display:inline-flex;align-items:center;gap:4px;font-size:.56rem;font-weight:800;color:#fff;background:#12b886;border-radius:99px;padding:2px 8px;margin-bottom:1px}
      .pcard .pt-ovl .live-pill .dot{width:5px;height:5px;border-radius:50%;background:#fff;animation:pcBlink 1.1s ease-in-out infinite}
      @keyframes pcBlink{0%,100%{opacity:1}50%{opacity:.25}}
      @media(prefers-reduced-motion:reduce){.pcard .pt-ovl .live-pill .dot{animation:none}}
      .pcard .pbody{padding:9px 10px 10px;display:flex;flex-direction:column;gap:6px;flex:1}
      .pcard .ptitle{font-size:.82rem;font-weight:800;color:#111827;margin:0;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .pcard .pmeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.68rem;color:#6B7280;font-weight:600}
      /* 바로참여 배지 = 시간 표기 오른쪽 */
      .pcard .pt-live{font-size:.58rem;font-weight:800;color:#0B7A5B;background:#DDF5EC;border:1px solid rgba(18,184,134,.3);border-radius:5px;padding:1px 6px}
      .pcard .pt-fee{color:#111827;font-weight:700}
      /* 참여 인원 = 게이지(시안 A) */
      .pcard .pgauge{display:flex;flex-direction:column;gap:4px;margin-top:1px}
      .pcard .pg-row{display:flex;justify-content:space-between;align-items:baseline;font-size:.66rem}
      .pcard .pg-lb{color:#6B7280;font-weight:700}
      .pcard .pg-vl{font-weight:800;font-variant-numeric:tabular-nums;color:#111827}
      .pcard .pg-vl b{color:#1b64da;font-size:.86rem}
      .pcard .pgauge.full .pg-vl b{color:#B45309}
      .pcard .pg-track{height:6px;border-radius:99px;background:#EEF1F7;border:1px solid #E5E7EB;overflow:hidden}
      .pcard .pg-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,#3182f6,#1b64da)}
      .pcard .pgauge.full .pg-fill{background:linear-gradient(90deg,#F59E0B,#D97706)}
      .pcard .pbtn{display:block;text-align:center;border:none;width:100%;background:linear-gradient(135deg,#3182f6,#1b64da);color:#fff;
        font-size:.76rem;font-weight:800;border-radius:9px;padding:9px;margin-top:auto;font-family:inherit;cursor:pointer}
      .pcard .pbtn.off{background:#EEF1F7;color:#94A3B8;cursor:default}
      .pcard .pnote{font-size:.6rem;color:#9CA3AF;text-align:center}
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

  /** 참여형 카드 1장 HTML. c = /api/campaign/list 의 참여형 행.
   *  모바일 2열 그리드용 컴팩트 카드 — 썸네일 정사각 전체노출·우상단 채널/배송 배지·
   *  바로참여는 시간 오른쪽·참여인원 게이지(A)·상태별 오버레이/푸터.
   *  모집중(시간창 안)은 썸네일 중앙 "오늘 구매마감까지" 카운트다운(cutoffAt), 오픈전은 "오픈까지"(opensAt). */
  function cardHtml(c) {
    const channel = c.channel === '직접입력' ? (c.channel_custom || '') : (c.channel || '');
    const fee = c.review_fee ? Number(c.review_fee).toLocaleString() + '원' : '';
    const isClosed = c.state === 'closed' || c.status === 'closed';
    const isPre = c.state === 'preopen';
    const isDaily = c.state === 'daily_done';
    const quota = Number(c.dailyQuota) || 0;
    const today = Number(c.todayCount) || 0;
    const isFull = quota > 0 && today >= quota;
    const pct = quota > 0 ? Math.max(3, Math.min(100, Math.round((today / quota) * 100))) : 0;

    const thumbInner = c.thumbnail_url
      ? `<img class="pt-img" src="${_esc(c.thumbnail_url)}" alt="" loading="lazy">`
      : `<div class="pt-ph">🛍️</div>`;
    const badges = (channel || c.delivery_type)
      ? `<div class="pt-badges">${channel ? `<span class="pt-badge ch">${_esc(channel)}</span>` : ''}${c.delivery_type ? `<span class="pt-badge dl">${_esc(c.delivery_type)}</span>` : ''}</div>`
      : '';
    const ribbon = isDaily ? `<span class="pt-ribbon done">금일 모집완료</span>`
                 : isClosed ? `<span class="pt-ribbon closedr">모집 종료</span>` : '';
    const editChip = _adminTok()
      ? `<button type="button" class="peditchip" onclick="event.stopPropagation();event.preventDefault();CampCards.openAdminEdit('${_esc(c.id)}')">✏️ 관리자 수정</button>`
      : '';
    const topleft = ribbon ? `<div class="pt-topleft">${ribbon}</div>` : '';

    // 오버레이: 오픈 전(회색·오픈까지) / 모집 중 시간창(라이브·오늘 구매마감까지)
    let overlay = '';
    if (isPre) {
      overlay = `<div class="pt-ovl pre"><span class="ol">오픈까지</span><span class="ot" data-camp-countdown="${_esc(c.opensAt || '')}">--:--:--</span><span class="ol">${c.opensAt ? '매일 ' + _fmtHM(c.opensAt) + ' 오픈' : ''}</span></div>`;
    } else if (c.state === 'open' && c.cutoffAt) {
      overlay = `<div class="pt-ovl now"><span class="live-pill"><span class="dot"></span>지금 구매 가능</span><span class="lab">오늘 구매마감까지</span><span class="ot" data-camp-countdown="${_esc(c.cutoffAt)}">--:--:--</span></div>`;
    }

    const timeTxt = (c.opensAt && c.closesAt) ? _fmtHM(c.opensAt) + '~' + _fmtHM(c.closesAt)
                  : (c.time_range ? c.time_range : (c.participation_mode && !c.opensAt ? '자율주문' : ''));
    const timeIcon = (c.opensAt && c.closesAt) ? '🕑' : '⏱';

    const gauge = (!isPre && !isClosed && quota > 0)
      ? `<div class="pgauge${isFull ? ' full' : ''}"><div class="pg-row"><span class="pg-lb">${isDaily ? '오늘 모집' : '모집 현황'}</span><span class="pg-vl"><b>${today}</b> / ${quota}명${isDaily ? ' 완료' : ''}</span></div><div class="pg-track"><div class="pg-fill" style="width:${pct}%"></div></div></div>`
      : '';

    let footer = '';
    if (c.state === 'open') footer = `<button type="button" class="pbtn go">참여하기</button>`;
    else if (c.state === 'cutoff') footer = `<button type="button" class="pbtn off">오늘 참여 마감</button><div class="pnote">진행 중인 분은 ${_fmtHM(c.closesAt)}까지 제출</div>`;
    else if (isDaily) footer = `<button type="button" class="pbtn off">오늘은 마감</button><div class="pnote">${c.opensAt ? '내일 ' + _fmtHM(c.opensAt) + ' 오픈' : '내일 다시 오픈'}</div>`;
    else if (c.state === 'soft_full') footer = `<button type="button" class="pbtn off">잔여 대기 중</button>`;

    return `
      <article class="pcard${isClosed ? ' is-closed' : ''}${isDaily ? ' is-dim' : ''}" data-camp-id="${_esc(c.id)}"
           onclick="location.href='campaign.html?id=${encodeURIComponent(c.id)}'">
        <div class="pthumb">${thumbInner}${overlay}${badges}${topleft}${editChip}</div>
        <div class="pbody">
          <h3 class="ptitle">${_esc(c.title || '(제목 없음)')}</h3>
          <div class="pmeta">${timeTxt ? `<span>${timeIcon} ${_esc(timeTxt)}</span>` : ''}<span class="pt-live">바로참여</span>${fee ? `<span class="pt-fee">💰 ${_esc(fee)}</span>` : ''}</div>
          ${gauge}
          ${footer}
        </div>
      </article>`;
  }

  /** 여러 카드를 2열 그리드로 감싼 HTML(호출부에서 partHtml 대신 사용 가능) */
  function gridHtml(list) {
    const parts = (list || []).filter(c => c.participation_mode);
    if (!parts.length) return '';
    return '<div class="pcards-grid">' + parts.map(cardHtml).join('') + '</div>';
  }

  /** 목록 렌더: 참여형만 골라 2열 그리드로 그려넣음. 반환 = 그린 카드 수 */
  function renderInto(el, list, serverNowIso, onNeedRefresh) {
    _injectStyles();
    if (serverNowIso) setServerNow(serverNowIso);
    _onNeedRefresh = onNeedRefresh || null;
    const parts = (list || []).filter(c => c.participation_mode);
    if (!el) return 0;
    el.innerHTML = parts.length ? '<div class="pcards-grid">' + parts.map(cardHtml).join('') + '</div>' : '';
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
          <div><label class="cae-lb">리뷰비(원)</label><input id="cae_fee" class="cae-in" type="number" min="0" step="100"></div>
          <div><label class="cae-lb">시간 표기(텍스트)</label><input id="cae_time_range" class="cae-in" type="text" placeholder="예: 14~16시 · 자율주문"></div>
        </div>
        <div id="cae_window_row">
          <div class="cae-g2">
            <div><label class="cae-lb">구매시간 시작</label><input id="cae_ws" class="cae-in" type="time"></div>
            <div><label class="cae-lb">구매시간 종료</label><input id="cae_we" class="cae-in" type="time"></div>
          </div>
          <div class="cae-note">비워 두면 기존 설정 유지</div>
        </div>
        <div id="cae_window_auto" class="cae-note" style="display:none;color:#0ca678;font-weight:700">⏱ 자율주문(시간 표기에 "자유/자율" 포함) — 구매시간 지정이 필요 없습니다.</div>
        <div class="cae-g2">
          <div><label class="cae-lb">하루 진행 인원</label><input id="cae_daily" class="cae-in" type="number" min="0"></div>
          <div><label class="cae-lb">총 모집(0=무제한)</label><input id="cae_total" class="cae-in" type="number" min="0"></div>
        </div>
        <label class="cae-lb">랜딩(상품) URL</label>
        <div style="display:flex;gap:6px">
          <input id="cae_landing" class="cae-in" type="text" style="flex:1;min-width:0" placeholder="https://">
          <button type="button" id="caeProdFetch" class="cae-btn gho" style="white-space:nowrap" title="이 URL에서 상품명·가격·썸네일 자동 가져오기 (쿠팡은 봇차단으로 자동 불가)">가져오기</button>
          <button type="button" id="caeLandingOpen" class="cae-btn gho" style="white-space:nowrap" title="상품 페이지를 새 탭에서 열기 — 이미지 우클릭 → 이미지 주소 복사 후 아래 썸네일에 붙여넣기">바로가기 ↗</button>
        </div>
        <div class="cae-note">[가져오기]: 상품명·썸네일 자동 채움(쿠팡 외 몰). 쿠팡은 봇차단이라 썸네일은 페이지 열어 이미지주소 붙여넣기·수동입력.</div>
        <label class="cae-lb">썸네일 URL <span style="font-weight:400;color:#9CA3AF">(비우면 제거)</span></label>
        <input id="cae_thumb" class="cae-in" type="text" placeholder="상품 이미지 주소(coupangcdn 등) 붙여넣기">
        <div id="cae_thumb_prevwrap" style="display:none;margin-top:8px;text-align:center;background:#F3F4F6;border-radius:10px;padding:12px">
          <img id="cae_thumb_prev" alt="썸네일 미리보기" style="max-width:100%;max-height:200px;border-radius:8px;border:1px solid #E5E7EB;object-fit:contain">
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <span class="cae-lb" style="margin:0;white-space:nowrap">또는 파일 업로드</span>
          <input id="cae_thumb_file" type="file" accept="image/*" style="font-size:.7rem;flex:1;min-width:0">
        </div>
        <div class="cae-note">채널·모집내용·작업내용 등 전체 항목 수정은 관리자 대시보드 → 캠페인 탭에서</div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button type="button" id="caeSave" class="cae-btn pri">저장</button>
          <button type="button" id="caeClose" class="cae-btn gho">닫기</button>
        </div>
      </div>`;
    // ★ 바깥 클릭으로는 닫히지 않음 — [닫기] 버튼으로만 닫는다(실수 닫힘 방지, 요구사항)
    ovl.querySelector('#caeClose').addEventListener('click', () => ovl.remove());
    ovl.querySelector('#caeSave').addEventListener('click', _caeSave);
    ovl.querySelector('#caeLandingOpen').addEventListener('click', () => {
      const u = _caeV('cae_landing').trim();
      if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
      else _toast('열 수 있는 상품 URL이 없습니다.', true);
    });
    ovl.querySelector('#cae_thumb_file').addEventListener('change', _caeThumbFromFile);
    ovl.querySelector('#cae_thumb').addEventListener('input', _caeSyncPreview);
    ovl.querySelector('#cae_time_range').addEventListener('input', _caeToggleWindow);
    ovl.querySelector('#caeProdFetch').addEventListener('click', _caeFetchProduct);
    document.body.appendChild(ovl);
    return ovl;
  }

  function _caeV(id) { const el = document.getElementById(id); return el ? el.value : ''; }
  function _caeSyncPreview() {
    const url = _caeV('cae_thumb').trim();
    const img = document.getElementById('cae_thumb_prev');
    const wrap = document.getElementById('cae_thumb_prevwrap');
    if (!img) return;
    if (url) { img.src = url; if (wrap) wrap.style.display = ''; }
    else if (wrap) { wrap.style.display = 'none'; }
  }
  // 시간 표기에 "자유/자율"이 포함되면 구매시간 시작/종료 입력 숨김(자율주문)
  function _caeIsAutoOrder() { return /자유|자율/.test(_caeV('cae_time_range')); }
  function _caeToggleWindow() {
    const auto = _caeIsAutoOrder();
    const row = document.getElementById('cae_window_row');
    const note = document.getElementById('cae_window_auto');
    if (row) row.style.display = auto ? 'none' : '';
    if (note) note.style.display = auto ? '' : 'none';
  }

  // 랜딩(상품) URL에서 상품명·가격·썸네일 자동 수집(쿠팡 외 몰). 쿠팡은 봇차단이라 hint 안내.
  //   상품명 → 공고 제목, 썸네일 → 썸네일 URL 자동 채움. 가격은 저장 항목이 없어 참고용(토스트).
  async function _caeFetchProduct() {
    const url = _caeV('cae_landing').trim();
    if (!url) { _toast('랜딩(상품) URL을 입력하세요.', true); return; }
    if (!/^https?:\/\//i.test(url)) { _toast('http(s):// 로 시작하는 URL을 입력하세요.', true); return; }
    _toast('상품 정보 가져오는 중...');
    try {
      const r = await fetch(_apiBase() + '/api/product/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _adminTok() },
        body: JSON.stringify({ url }),
      });
      if (r.status === 401 || r.status === 403) { _toast('권한이 없거나 로그인이 만료되었습니다.', true); return; }
      const j = await r.json();
      const has = j && (j.name || j.price || j.thumbnail);
      if (j && j.ok && has) {
        if (j.name) document.getElementById('cae_title').value = j.name;
        if (j.thumbnail) { document.getElementById('cae_thumb').value = j.thumbnail; _caeSyncPreview(); }
        _toast('상품정보를 가져왔습니다' + (j.price ? ' (가격 ' + j.price + ' · 참고용)' : '') + '. [저장]으로 반영하세요.');
      } else {
        _toast((j && j.hint) || '상품 정보를 가져오지 못했습니다. 수동 입력하세요.', true);
      }
    } catch (e) { _toast('가져오기 실패: ' + e.message, true); }
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
    _caeSyncPreview();
    _caeToggleWindow();
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
    const auto = _caeIsAutoOrder();  // 시간 표기에 자유/자율 → 자율주문(구매시간 비움)
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
      // 자율주문이면 구매시간 명시적 비움(clear), 아니면 입력값(빈값=서버가 현재값 유지)
      auto_order: auto,
      window_start: auto ? null : (_caeV('cae_ws') || null),
      window_end: auto ? null : (_caeV('cae_we') || null),
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
      // ★ 저장해도 팝업은 유지 — [닫기] 버튼으로만 닫는다(요구사항). 목록만 갱신.
      _toast('저장되었습니다 — 관리자 대시보드와 동기화 완료. [닫기]로 닫으세요.');
      if (typeof _onNeedRefresh === 'function') { try { _onNeedRefresh(); } catch (_) { /* noop */ } }
    } catch (e) {
      _toast(e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = '저장';
    }
  }

  window.CampCards = { renderInto, cardHtml, gridHtml, setServerNow, startTicker, _fmtCountdown, _fmtHM, serverNow: _now, _onCardClick, openAdminEdit };
})();
