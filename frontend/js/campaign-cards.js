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
           onclick="location.href='campaign.html?id=${encodeURIComponent(c.id)}'">
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

  window.CampCards = { renderInto, cardHtml, setServerNow, startTicker, _fmtCountdown, _fmtHM, serverNow: _now };
})();
