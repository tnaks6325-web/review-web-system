/* ══════════════════════════════════════════════════════════════
   C/S 대화 안의 "리뷰이미지 교체요청" 카드 (공유 렌더러)

   같은 카드를 세 곳이 그린다 —
     · 관리자 C/S 대화창(cs-inquiry.js) : 기존↔변경 이미지 + [승인]/[반려]
     · 리뷰웹시스템[3버전] 전용 탭(workdesk.html): 같은 카드 + 같은 버튼
     · 리뷰어 채팅(reviewer-cs.js)       : 같은 카드, 읽기 전용(상태 배지만)
   사본을 만들면 "관리자 화면엔 사유가 보이는데 리뷰어 화면엔 안 보인다" 같은
   드리프트가 난다(모집공고 모달·작업오더 상세와 같은 규율).

   ★ 이미지는 meta 의 **파일ID**로 그린다 — cs_messages.image_urls 에 넣지 않는다.
     image_urls 는 `/api/order/guide-image/<id>` 만 허용하는 sanitize 를 통과해야 하는데,
     리뷰 이미지는 `/api/drive/image/<id>` 프록시라 허용목록을 넓혀야 한다.
     ID만 저장하고 URL은 **프론트가 신뢰 베이스로 재구성**하면 그 가드를 건드릴 필요가 없다.
   ★ 파일ID는 쓰기 전에 형식 검증한다(`[-\w]{20,}`) — meta 는 서버가 쓰지만
     화면에 <img src>로 나가므로 자유 문자열을 그대로 흘리지 않는다.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ★★ API 베이스는 **bare 식별자**로 읽는다 — api.js 의 `const API_BASE_URL` 은 최상위 const 라
     window 의 프로퍼티가 **아니다**(전역 렉시컬 스코프에만 바인딩). `window.API_BASE_URL` 로 읽으면
     항상 undefined → 상대경로가 되어 프론트(Pages)에서 API(Railway) 이미지를 못 불러온다.
     ⚠ file:// 로 여는 테스트는 상대경로도 스텁에 걸려 **이 버그를 가린다**(실측으로 당했다).
     레포 관용구 = campaign-cards.js 의 _apiBase(). */
  function _base() {
    return (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) ? API_BASE_URL : '';
  }
  /** Drive 파일ID → 우리 프록시 URL. 형식이 아니면 빈 문자열(렌더 생략). */
  function imgUrl(fileId) {
    var id = String(fileId || '');
    return /^[-\w]{20,}$/.test(id) ? _base() + '/api/drive/image/' + encodeURIComponent(id) : '';
  }

  /** onclick 안에 넣어도 안전한 파일ID(문자셋 밖은 전부 제거). */
  function _idAttr(v) { return String(v == null ? '' : v).replace(/[^-\w]/g, ''); }

  var STATUS = {
    pending:   { label: '처리 대기', bg: '#FEF3C7', fg: '#92400E' },
    approved:  { label: '승인됨',    bg: '#D1FAE5', fg: '#065F46' },
    rejected:  { label: '반려됨',    bg: '#FEE2E2', fg: '#991B1B' },
    cancelled: { label: '취소됨',    bg: '#F3F4F6', fg: '#6B7280' },
  };

  /**
   * @param {string} fileId    이 칸에 그릴 Drive 파일ID
   * @param {string} caption   '기존' | '변경 요청'
   * @param {string} tone      테두리·라벨 색
   * @param {object} pair      { oldFileId, newFileId, focus } — 클릭 시 **둘 다** 크게 보기
   */
  function _thumb(fileId, caption, tone, pair) {
    var u = imgUrl(fileId);
    var box = 'width:132px;flex:0 0 132px';
    if (!u) {
      return '<div style="' + box + '"><div style="height:132px;border-radius:10px;border:1px dashed #D1D5DB;'
        + 'display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:.7rem;background:#FAFAFA">이미지 없음</div>'
        + '<div style="font-size:.66rem;color:' + tone + ';font-weight:700;text-align:center;margin-top:4px">' + _esc(caption) + '</div></div>';
    }
    /* ★ 클릭 = **한 장이 아니라 기존↔변경 둘 다** 크게 본다.
       교체요청 처리는 "무엇이 어떻게 바뀌었나"를 대조하는 일이라, 클릭한 쪽만 띄우면
       관리자가 오버레이를 닫았다 다시 여는 왕복을 매번 해야 한다. */
    /* ★ onclick 은 HTML 속성 → 엔티티가 **디코드된 뒤** JS 로 파싱된다. `_esc` 만 믿고
       따옴표를 &quot; 로 바꿔 넣으면 그대로 `"` 로 되살아나 문자열을 탈출한다.
       그래서 ID 는 파일ID 문자셋([-\w])만 남기고 전부 버린다(imgUrl 검증과 같은 기준). */
    var p = pair || {};
    var call = 'CsReviewEditCard.zoomPair(&quot;' + _idAttr(p.oldFileId) + '&quot;,&quot;'
      + _idAttr(p.newFileId) + '&quot;,&quot;' + (p.focus === 'new' ? 'new' : 'old') + '&quot;)';
    return '<div style="' + box + '">'
      + '<img src="' + _esc(u) + '" alt="' + _esc(caption) + '" loading="lazy"'
      + ' onclick="' + call + '"'
      + ' style="width:132px;height:132px;object-fit:cover;border-radius:10px;border:1.5px solid ' + tone + ';cursor:zoom-in;background:#fff;display:block">'
      + '<div style="font-size:.66rem;color:' + tone + ';font-weight:700;text-align:center;margin-top:4px">' + _esc(caption) + '</div></div>';
  }

  /**
   * @param {object} meta  cs_messages.meta (requestId·status·oldFileId·newFileId·reason·adminNote·rowIndex…)
   * @param {object} opts  { admin:boolean, canAct:boolean, onApprove:string, onReject:string }
   *        onApprove/onReject = onclick 에 들어갈 **함수 호출 문자열**(호스트마다 다름).
   */
  function html(meta, opts) {
    meta = meta || {}; opts = opts || {};
    var st = STATUS[meta.status] || STATUS.pending;
    var isAdmin = !!opts.admin;
    var rid = _esc(meta.requestId || '');

    var head = '<div style="display:flex;align-items:center;gap:7px;margin-bottom:9px;flex-wrap:wrap">'
      + '<span style="font-size:.78rem;font-weight:800;color:#1E3A8A">🖼 리뷰이미지 교체요청</span>'
      + '<span style="font-size:.64rem;font-weight:700;padding:2px 8px;border-radius:6px;background:' + st.bg + ';color:' + st.fg + '">' + _esc(st.label) + '</span>'
      + (meta.rowIndex ? '<span style="font-size:.66rem;color:#94A3B8">시트 ' + _esc(meta.rowIndex) + '행</span>' : '')
      + (meta.slotKey && meta.slotKey !== 'review' ? '<span style="font-size:.66rem;color:#94A3B8">' + _esc(meta.slotKey) + '</span>' : '')
      + '</div>';

    var pair = { oldFileId: meta.oldFileId, newFileId: meta.newFileId };
    var imgs = '<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">'
      + _thumb(meta.oldFileId, '기존', '#9CA3AF', { oldFileId: pair.oldFileId, newFileId: pair.newFileId, focus: 'old' })
      + '<div style="align-self:center;color:#94A3B8;font-size:1.1rem;font-weight:700">→</div>'
      + _thumb(meta.newFileId, '변경 요청', '#3182f6', { oldFileId: pair.oldFileId, newFileId: pair.newFileId, focus: 'new' })
      + '</div>';

    var reason = meta.reason
      ? '<div style="margin-top:9px;font-size:.75rem;color:#374151;line-height:1.5"><b style="color:#6B7280">사유</b> '
        + _esc(meta.reason) + '</div>' : '';
    var note = meta.adminNote
      ? '<div style="margin-top:5px;font-size:.75rem;color:#991B1B;line-height:1.5"><b style="color:#6B7280">처리 메모</b> '
        + _esc(meta.adminNote) + '</div>' : '';

    // 버튼은 **관리자이면서 처리 권한이 있고, 아직 대기 중일 때만**.
    //   (권한 최종 판정은 서버 — 여기서는 막다른 버튼을 안 보여주는 것이 목적)
    var acts = '';
    if (isAdmin && opts.canAct !== false && meta.status === 'pending' && rid) {
      acts = '<div style="display:flex;gap:6px;margin-top:11px;flex-wrap:wrap;align-items:center">'
        + '<button onclick="' + _esc(opts.onApprove || '') + '" style="padding:6px 14px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer">✔ 승인</button>'
        + '<button onclick="' + _esc(opts.onReject || '') + '" style="padding:6px 14px;background:#fff;color:#B91C1C;border:1.5px solid #FCA5A5;border-radius:8px;font-size:.76rem;font-weight:700;cursor:pointer">반려</button>'
        + '<span style="font-size:.66rem;color:#9CA3AF">승인하면 리뷰어 채팅에 자동으로 안내가 갑니다</span>'
        + '</div>';
    }

    return '<div class="cs-recard" data-request-id="' + rid + '"'
      + ' style="background:#fff;border:1.5px solid #DBEAFE;border-radius:12px;padding:11px 13px;max-width:420px">'
      + head + imgs + reason + note + acts + '</div>';
  }

  /** 이미지 크게 보기 — 호스트에 라이트박스가 있으면 그것을, 없으면 자체 오버레이. */
  function zoom(url) {
    if (typeof window.woImageModal === 'function') return window.woImageModal(url);
    var ov = document.getElementById('csReCardZoom');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'csReCardZoom';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);display:flex;'
        + 'align-items:center;justify-content:center;padding:24px;cursor:zoom-out';
      ov.addEventListener('click', function () { ov.style.display = 'none'; });
      document.body.appendChild(ov);
    }
    ov.innerHTML = '<img src="' + _esc(url) + '" style="max-width:92vw;max-height:88vh;border-radius:10px">';
    ov.style.display = 'flex';
  }

  /**
   * 기존 ↔ 변경 요청을 **한 화면에 나란히** 크게 보기.
   * ★ 호스트 라이트박스(woImageModal)로 위임하지 않는다 — 그건 URL 한 장짜리라
   *   위임하는 순간 "클릭한 것만 보인다"로 되돌아간다(zoom() 은 단일 이미지용으로 남겨둔다).
   * @param {string} oldId  기존 파일ID
   * @param {string} newId  변경 요청 파일ID
   * @param {string} focus  'old'|'new' — 클릭한 쪽(테두리로 표시만, 둘 다 보여준다)
   */
  function zoomPair(oldId, newId, focus) {
    var uOld = imgUrl(oldId), uNew = imgUrl(newId);
    // 한 쪽만 있으면 대조할 것이 없다 → 기존 단일 보기로.
    if (!uOld && !uNew) return;
    if (!uOld || !uNew) return zoom(uOld || uNew);

    /* ★ 단일 보기(zoom)와 **다른 오버레이**를 쓴다 — 그쪽 리스너는 "아무 데나 누르면 닫힘"이라
       공유하면 확대된 이미지를 누르는 순간 닫혀 대조가 안 된다(먼저 만든 쪽 리스너가 남는다). */
    var ov = document.getElementById('csReCardZoomPair');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'csReCardZoomPair';
      ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.86);display:flex;'
        + 'align-items:center;justify-content:center;padding:24px;cursor:zoom-out';
      // 배경(오버레이 자신·여백)을 눌렀을 때만 닫는다 — 이미지 클릭으로 닫히면 대조 중 오조작이 잦다.
      ov.addEventListener('click', function (e) {
        if (e.target === ov || (e.target && e.target.dataset && e.target.dataset.ovclose === '1')) ov.style.display = 'none';
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && ov.style.display !== 'none') ov.style.display = 'none';
      });
      document.body.appendChild(ov);
    }
    /* ★ 두 장은 **같은 순간에** 나타나야 한다.
       클릭한 쪽(보통 '변경 요청')은 카드 썸네일로 이미 캐시돼 즉시 뜨는데 '기존'은 그 자리에서
       처음 받으므로, 그냥 두면 한 장이 먼저 뜨고 다른 한 장이 뒤늦게 끼어들며 레이아웃이 흔들린다
       (대조하려고 연 화면인데 비교 시작 시점이 어긋난다) → **둘 다 그릴 준비가 될 때까지 감췄다가
       한꺼번에 보여준다**. 감춘 동안은 "불러오는 중"을 띄워 멈춘 것처럼 보이지 않게 한다. */
    var side = function (u, label, tone, on) {
      return '<div data-ovclose="1" style="flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:8px">'
        + '<div style="font-size:.82rem;font-weight:800;color:' + tone + '">' + _esc(label)
        + (on ? ' <span style="font-size:.7rem;font-weight:700;color:#E5E7EB">· 클릭한 이미지</span>' : '') + '</div>'
        + '<img data-pair="1" src="' + _esc(u) + '" style="max-width:100%;max-height:78vh;object-fit:contain;border-radius:10px;'
        + 'border:' + (on ? '3px solid ' + tone : '1px solid rgba(255,255,255,.25)') + ';background:#fff;'
        + 'opacity:0;transition:opacity .15s ease">'
        + '</div>';
    };
    var isNew = focus === 'new';
    ov.innerHTML = '<div data-ovclose="1" style="width:100%;max-width:1200px;display:flex;flex-direction:column;gap:10px;cursor:default">'
      + '<div data-ovclose="1" style="display:flex;align-items:center;justify-content:flex-end;gap:10px">'
      + '<span id="csReCardZoomWait" style="color:#E5E7EB;font-size:.78rem;font-weight:700">이미지 불러오는 중…</span>'
      + '<button onclick="document.getElementById(\'csReCardZoomPair\').style.display=\'none\'"'
      + ' style="padding:5px 13px;border-radius:8px;border:1px solid rgba(255,255,255,.35);background:transparent;'
      + 'color:#fff;font-size:.78rem;font-weight:700;cursor:pointer">닫기 ✕</button></div>'
      + '<div data-ovclose="1" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">'
      + side(uOld, '기존', '#D1D5DB', !isNew)
      + side(uNew, '변경 요청', '#93C5FD', isNew)
      + '</div></div>';
    ov.style.display = 'flex';
    _revealTogether(ov);
  }

  /** 한 장이 **그릴 준비**를 마쳤는지. load 만으로는 부족해 decode() 까지 기다린다(디코딩 지연 = 늦게 뜸). */
  function _painted(img) {
    return new Promise(function (resolve) {
      var done = false, fin = function () { if (!done) { done = true; resolve(); } };
      var dec = function () { if (img.decode) img.decode().then(fin, fin); else fin(); };
      if (img.complete) return img.naturalWidth > 0 ? dec() : fin();   // 캐시 히트/이미 실패
      img.addEventListener('load', dec);
      img.addEventListener('error', fin);   // ★ 실패해도 진행 — 한 장이 깨졌다고 나머지까지 영영 안 뜨면 안 된다
    });
  }
  /** 오버레이 안의 두 장을 **동시에** 드러낸다. 느린 쪽이 오래 걸려도 최대 대기 후엔 보여준다(fail-open). */
  var _PAIR_WAIT_MS = 4000;
  function _revealTogether(ov) {
    var imgs = [].slice.call(ov.querySelectorAll('img[data-pair]'));
    if (!imgs.length) return;
    var shown = false;
    var show = function () {
      if (shown) return; shown = true;
      imgs.forEach(function (im) { im.style.opacity = '1'; });
      var w = ov.querySelector('#csReCardZoomWait'); if (w) w.style.display = 'none';
    };
    Promise.all(imgs.map(_painted)).then(show, show);
    setTimeout(show, _PAIR_WAIT_MS);   // 네트워크가 막혀도 화면이 검은 채로 남지 않게
  }

  /**
   * 검수 결과 카드(msg_type='inspect_result') — "어떤 작업의 어떤 사진인지"를 채팅에서 바로 보여준다.
   * ★ 교체요청 카드와 **같은 썸네일·확대 경로**를 쓴다(사본 금지 — 클릭 동작이 갈리지 않게).
   * ★ meta 에는 관리자 실명·시트 제목이 담기지 않는다(서버가 담지 않는다) — 여기서는 그리기만 한다.
   * ★ 줄 번호는 쓰지 않는다 — 참여 순번(①②③)·상품·제출시각으로 가리킨다.
   * @param {object} meta  { kind, fileId, matchFileId, work, product, ordinal, submittedAt, matchProduct, matchOrdinal, matchAt, to }
   */
  function inspectHtml(meta) {
    var m = meta || {};
    var isDup = String(m.kind || '') === 'duplicate' && m.matchFileId;
    var isMoved = String(m.kind || '') === 'moved';
    var when = function (v) {
      if (!v) return '';
      var d = new Date(v);
      if (isNaN(d)) return '';
      var h = d.getHours();
      return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + (h < 12 ? '오전 ' : '오후 ') + ((h % 12) || 12) + ':' + ('0' + d.getMinutes()).slice(-2);
    };
    var sub = function (ord, product, at) {
      var a = [];
      if (when(at)) a.push(when(at) + ' 제출');
      var b = (ord ? ord + '. ' : '') + (product || '');
      if (b.trim()) a.push(b.trim());
      return a.join('<br>');
    };
    var pair = { oldFileId: m.matchFileId || m.fileId, newFileId: m.fileId, focus: 'new' };
    var cap = isDup ? '✕ 반려된 사진' : isMoved ? '↪ 옮긴 사진' : '✕ 반려된 사진';
    var body = isDup
      ? '<div style="display:flex;gap:10px;flex-wrap:wrap">'
        + '<div>' + _thumb(m.fileId, cap, '#B91C1C', pair)
        + '<div style="font-size:.64rem;color:#6B7280;text-align:center;margin-top:2px;line-height:1.4">' + sub(m.ordinal, m.product, m.submittedAt) + '</div></div>'
        + '<div>' + _thumb(m.matchFileId, '✓ 이미 제출된 사진', '#15803D', { oldFileId: pair.oldFileId, newFileId: pair.newFileId, focus: 'old' })
        + '<div style="font-size:.64rem;color:#6B7280;text-align:center;margin-top:2px;line-height:1.4">' + sub(m.matchOrdinal, m.matchProduct, m.matchAt) + '</div></div>'
        + '</div>'
      : '<div style="display:flex;gap:10px">'
        + '<div>' + _thumb(m.fileId, cap, isMoved ? '#B45309' : '#B91C1C', pair)
        + '<div style="font-size:.64rem;color:#6B7280;text-align:center;margin-top:2px;line-height:1.4">'
        + sub(m.ordinal, m.product, m.submittedAt) + (isMoved && m.to ? '<br>→ ' + _esc(m.to) + ' 칸' : '') + '</div></div>'
        + '</div>';
    return '<div style="border:1px solid #E5E7EB;border-radius:10px;padding:10px;background:#FBFCFE;margin-top:8px">'
      + '<div style="font-size:.68rem;font-weight:800;color:#6B7280;margin-bottom:7px">'
      + (isDup ? '어떤 사진이 중복이었는지' : isMoved ? '옮긴 사진' : '반려된 사진') + '</div>'
      + body
      + (m.work ? '<div style="font-size:.68rem;color:#3182f6;font-weight:700;margin-top:8px">📋 ' + _esc(m.work) + '</div>' : '')
      + '</div>';
  }

  window.CsReviewEditCard = { html: html, inspectHtml: inspectHtml, zoom: zoom, zoomPair: zoomPair, imgUrl: imgUrl, STATUS: STATUS };
})();
