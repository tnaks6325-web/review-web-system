/* ══════════════════════════════════════════════════════════════
   C/S 대화 안의 "리뷰이미지 교체요청" 카드 (공유 렌더러)

   같은 카드를 세 곳이 그린다 —
     · 관리자 C/S 대화창(cs-inquiry.js) : 기존↔변경 이미지 + [승인]/[반려]
     · 통합 작업대 전용 탭(workdesk.html): 같은 카드 + 같은 버튼
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

  var STATUS = {
    pending:   { label: '처리 대기', bg: '#FEF3C7', fg: '#92400E' },
    approved:  { label: '승인됨',    bg: '#D1FAE5', fg: '#065F46' },
    rejected:  { label: '반려됨',    bg: '#FEE2E2', fg: '#991B1B' },
    cancelled: { label: '취소됨',    bg: '#F3F4F6', fg: '#6B7280' },
  };

  function _thumb(fileId, caption, tone) {
    var u = imgUrl(fileId);
    var box = 'width:132px;flex:0 0 132px';
    if (!u) {
      return '<div style="' + box + '"><div style="height:132px;border-radius:10px;border:1px dashed #D1D5DB;'
        + 'display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:.7rem;background:#FAFAFA">이미지 없음</div>'
        + '<div style="font-size:.66rem;color:' + tone + ';font-weight:700;text-align:center;margin-top:4px">' + _esc(caption) + '</div></div>';
    }
    return '<div style="' + box + '">'
      + '<img src="' + _esc(u) + '" alt="' + _esc(caption) + '" loading="lazy"'
      + ' onclick="CsReviewEditCard.zoom(this.src)"'
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

    var imgs = '<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">'
      + _thumb(meta.oldFileId, '기존', '#9CA3AF')
      + '<div style="align-self:center;color:#94A3B8;font-size:1.1rem;font-weight:700">→</div>'
      + _thumb(meta.newFileId, '변경 요청', '#3182f6')
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

  window.CsReviewEditCard = { html: html, zoom: zoom, imgUrl: imgUrl, STATUS: STATUS };
})();
