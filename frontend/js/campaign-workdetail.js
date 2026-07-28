/**
 * campaign-workdetail.js — 리뷰어가 "참여 후" 보는 작업내용 카드의 단일 렌더러.
 *
 * ★ 존재 이유: 관리자 미리보기를 따로 만들면 실제 리뷰어 화면과 어긋난다(모형과 실물의 분리).
 *   그래서 실제 리뷰어 페이지(campaign.html)와 관리자 미리보기(모집공고 모달·공고수정 모달)가
 *   **이 파일 하나**를 공유한다 — 렌더 코드가 같으므로 미리보기 = 실제 화면이 구조적으로 보장된다.
 *
 * 렌더 대상 = 작업내용 4카드: 상품·옵션·결제금액 / 유입가이드(+상품 페이지 열기) / 리뷰 가이드 / 특이사항.
 * 홀드 타이머·구매양식 iframe·참여취소 같은 "흐름" 요소는 호출부(campaign.html)가 유지한다.
 *
 * 색상은 호스트 페이지의 CSS 변수에 의존하지 않고 리터럴로 고정 — admin.html처럼 변수 체계가
 * 다른 페이지에 얹혀도 리뷰어 화면과 같은 모습이 나온다.
 */
(function () {
  'use strict';

  var CSS = ''
    + '.cwd-box{background:#FFFFFF;border:1px solid #E5E7EB;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 2px 12px rgba(0,0,0,.05)}'
    + '.cwd-tt{font-size:.78rem;font-weight:800;color:#9CA3AF;margin-bottom:8px}'
    + '.cwd-body{font-size:.88rem;color:#111827;white-space:pre-wrap;word-break:break-word;line-height:1.65;font-family:\'Noto Sans KR\',sans-serif}'
    + '.cwd-body img{max-width:100%;border-radius:10px;margin:6px 0;display:block}'
    + '.cwd-muted{font-size:.76rem;color:#9CA3AF}'
    + '.cwd-btn{display:block;width:100%;text-align:center;border:none;cursor:pointer;background:#EEF1F7;color:#4B5563;'
    +   'font-size:.84rem;font-weight:800;border-radius:11px;padding:11px;font-family:inherit;margin-top:10px}'
    + '.cwd-opt{display:flex;align-items:center;gap:10px}'
    + '.cwd-opt .nm{font-size:.9rem;font-weight:800;color:#111827}'
    + '.cwd-opt .sub{font-size:.72rem;color:#4B5563;margin-top:2px}';

  function _injectCss() {
    if (document.getElementById('cwd-style')) return;
    var s = document.createElement('style');
    s.id = 'cwd-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function driveId(url) {
    var s = String(url);
    var m = s.match(/\/file\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/\/d\/([-\w]{20,})/);
    return m ? m[1] : null;
  }

  /** 상품 라인 정규화 — 같은 결제금액이 여러 줄에 반복되면 한 줄로 모은다(표시 직전 정규화, 원문 불변) */
  function fmtProduct(wd) {
    var base = String((wd && wd.productLines) || '').trim();
    var payAmt = (wd && wd.payAmount) ? Number(wd.payAmount) : 0;
    if (!base && !payAmt) return '(등록된 상품 정보가 없어요)';
    var amtRe = /결제금액\s*([\d,]+)\s*원/g;
    var amounts = {}, count = 0, m;
    while ((m = amtRe.exec(base))) {
      var key = m[1].replace(/,/g, '');
      if (!amounts[key]) { amounts[key] = 1; count++; }
    }
    if (count === 1) {
      var amt = Number(Object.keys(amounts)[0]);
      var stripped = base.split(/\n/)
        .map(function (ln) {
          return ln.replace(/\s*[-·/]?\s*결제금액\s*[\d,]+\s*원/g, '').replace(/[\s\-·/]+$/, '').trim();
        })
        .filter(Boolean).join('\n');
      return (stripped ? stripped + '\n' : '') + '결제금액 ' + amt.toLocaleString() + '원';
    }
    // 금액이 여럿(다옵션) 또는 라인 내 금액 없음 → payAmount만 별도 줄로
    if (payAmt && count === 0) return (base ? base + '\n' : '') + '결제금액 ' + payAmt.toLocaleString() + '원';
    return base || '(등록된 상품 정보가 없어요)';
  }

  /** 리뷰가이드: [리뷰등록 가이드] 계열 섹션만. [라벨] 마커가 없으면 평문 전체 그대로(무변화). */
  function pickReviewOnly(raw) {
    var text = String(raw == null ? '' : raw);
    if (!text.trim()) return '';
    if (!/\[[^\]]+\]/.test(text)) return text.trim();
    var norm = function (s) { return s.replace(/\s/g, ''); };
    var keep = ['리뷰등록가이드', '리뷰가이드'];   // index-app.js _woPickSections 와 동일 규율
    var out = [], take = false, buf = [];
    var flush = function () { var c = buf.join('\n').trim(); if (take && c) out.push(c); buf = []; };
    text.split(/\r?\n/).forEach(function (ln) {
      var mm = ln.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
      if (mm) {
        flush();
        take = keep.some(function (k) { return norm(mm[1]).indexOf(k) >= 0; });
        buf = mm[2] ? [mm[2]] : [];
      } else buf.push(ln);
    });
    flush();
    return out.join('\n').trim();
  }

  /**
   * 리뷰가이드 원문에 섞여 온 첨부 이미지(guide-image 프록시·Drive)만 <img>로.
   * 유입 HTML에 이미 있으면 스킵 — 중복 판정은 파일ID 토큰 기준이라 같은 이미지가
   * 호스트만 다른 프록시 URL(pages↔railway)이어도 이중노출되지 않는다.
   */
  function extractGuideImages(raw, existingHtml, apiBase) {
    var base = apiBase != null ? apiBase : (typeof window.API_BASE_URL !== 'undefined' ? window.API_BASE_URL : '');
    var seen = String(existingHtml || '');
    var re = /https?:\/\/[^\s<)"']+/g;
    var m, html = '', used = {};
    while ((m = re.exec(String(raw || '')))) {
      var u = m[0], src = '', tok = '';
      var pm = u.match(/\/api\/order\/guide-image\/([-\w]{20,})/);
      // 호스트는 신뢰 베이스로 재구성 — 매칭 URL의 임의 호스트를 그대로 쓰지 않는다(Drive 분기와 동일)
      if (pm) { tok = pm[1]; src = base + '/api/order/guide-image/' + tok; }
      else { var id = driveId(u); if (id) { src = 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600'; tok = id; } }
      if (!src || !tok) continue;
      if (used[tok] || seen.indexOf(tok) >= 0) continue;
      used[tok] = 1;
      html += '<img src="' + escAttr(src) + '" alt="유입가이드 이미지">';
    }
    return html;
  }

  /**
   * 작업내용 카드 HTML.
   * @param {object} d  { workDetail, landingUrl, inflowType, selectedOption }
   * @param {object} o  { showLanding:bool(기본 true), showOption:bool(기본 true), apiBase }
   */
  function cardsHtml(d, o) {
    d = d || {}; o = o || {};
    var wd = d.workDetail || {};
    var html = '';

    // 내가 참여한 옵션(옵션 등록 캠페인만)
    var so = d.selectedOption;
    if (o.showOption !== false && so && so.optKey) {
      var sub = so.payAmount ? ('결제금액 ' + Number(so.payAmount).toLocaleString() + '원') : '';
      html += '<div class="cwd-box" style="border-color:#3182f6">'
        + '<div class="cwd-tt" style="color:#1b64da">✅ 내가 참여한 옵션</div>'
        + '<div class="cwd-opt"><div><div class="nm">' + escAttr(so.optKey) + '</div>'
        + (sub ? '<div class="sub">' + escAttr(sub) + '</div>' : '') + '</div></div></div>';
    }

    // 상품 · 옵션 · 결제금액
    html += '<div class="cwd-box"><div class="cwd-tt">📦 상품 · 옵션 · 결제금액</div>'
      + '<div class="cwd-body">' + escAttr(fmtProduct(wd)) + '</div></div>';

    // 유입가이드 (+ 상품 페이지 열기 — 링크유입일 때만, 유입방식 불명이면 관리자 의도 존중해 노출)
    var guideHtml = wd.inflowGuideHtml || '';
    var extraImgs = extractGuideImages(wd.reviewGuide || '', guideHtml, o.apiBase);
    if (!guideHtml && !extraImgs) {
      guideHtml = '<span class="cwd-muted">유입가이드가 없어요 — 아래 상품 페이지로 이동해 구매를 진행하세요.</span>';
    }
    html += '<div class="cwd-box"><div class="cwd-tt">🧭 유입가이드</div>'
      + '<div class="cwd-body">' + guideHtml + extraImgs + '</div>';
    if (o.showLanding !== false && d.landingUrl && (d.inflowType === 'link' || !d.inflowType)) {
      html += '<button type="button" class="cwd-btn" data-cwd-landing="' + escAttr(d.landingUrl) + '">🔗 상품 페이지 열기 (새 탭)</button>';
    }
    html += '</div>';

    // 리뷰 가이드 ([리뷰등록 가이드] 섹션만)
    var reviewOnly = pickReviewOnly(wd.reviewGuide);
    if (reviewOnly) {
      html += '<div class="cwd-box"><div class="cwd-tt">📝 리뷰 가이드</div>'
        + '<div class="cwd-body">' + escAttr(reviewOnly) + '</div></div>';
    }

    // 특이사항
    if (wd.specialNotes) {
      html += '<div class="cwd-box"><div class="cwd-tt">📌 특이사항</div>'
        + '<div class="cwd-body">' + escAttr(wd.specialNotes) + '</div></div>';
    }
    return html;
  }

  /** 컨테이너에 렌더 + [상품 페이지 열기] 위임 처리(한 번만 바인딩) */
  function renderInto(el, d, o) {
    if (!el) return;
    _injectCss();
    el.innerHTML = cardsHtml(d, o);
    if (!el._cwdBound) {
      el._cwdBound = true;
      el.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-cwd-landing]');
        if (!b) return;
        var u = b.getAttribute('data-cwd-landing');
        if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
      });
    }
  }

  window.CampWorkDetail = {
    renderInto: renderInto, cardsHtml: cardsHtml,
    fmtProduct: fmtProduct, pickReviewOnly: pickReviewOnly,
    extractGuideImages: extractGuideImages, escAttr: escAttr, driveId: driveId,
  };
})();
