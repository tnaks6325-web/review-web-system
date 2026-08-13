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
   * 첨부 이미지 배열(work_detail.reviewGuideImages / specialNotesImages) → <img> HTML.
   *
   * ★ 유입가이드는 HTML 안에 <img>를 갖지만 리뷰가이드·특이사항은 **평문** 필드라
   *   사진을 배열로 따로 받는다(평문 칸을 HTML로 승격하면 기존 저장분의 '<옵션>' 같은
   *   꺾쇠 글자가 태그로 오인돼 삭제된다 — 서버 sanitizeGuideHtml.js 주석 참조).
   * ★ 호스트는 신뢰 베이스로 재구성 — 배열에 담긴 주소의 임의 호스트를 그대로 쓰지 않는다
   *   (extractGuideImages 와 같은 규율). 우리 프록시 형식이 아니면 그리지 않는다.
   * @returns {{html:string, tokens:string[]}} tokens = 중복 판정용 파일ID
   */
  function imageListHtml(list, apiBase, alt) {
    var base = apiBase != null ? apiBase : (typeof window.API_BASE_URL !== 'undefined' ? window.API_BASE_URL : '');
    if (!list || !list.length) return { html: '', tokens: [] };
    var html = '', tokens = [], used = {};
    for (var i = 0; i < list.length; i++) {
      var m = String(list[i] || '').match(/\/api\/order\/guide-image\/([-\w]{20,})$/);
      if (!m || used[m[1]]) continue;
      used[m[1]] = 1;
      tokens.push(m[1]);
      html += '<img src="' + escAttr(base + '/api/order/guide-image/' + m[1]) + '" alt="' + escAttr(alt || '첨부 이미지') + '">';
    }
    return { html: html, tokens: tokens };
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

    // 🧾 현금영수증 발행 안내 — 연결 탭 진행방식이 '현영'인 공고만(d.cashReceipt는 서버가 판정).
    //   결제 단계를 지나면 발행을 되돌리기 어려우므로 상품 카드 바로 아래(구매 전 시점)에 둔다.
    //   색상은 리터럴 고정(호스트 CSS 변수 미의존) — 다른 카드들과 같은 규율.
    var cr = d.cashReceipt;
    if (cr && cr.required) {
      html += '<div class="cwd-box" style="border-color:#F59E0B;background:#FFFBF2">'
        + '<div class="cwd-tt" style="color:#B45309">🧾 현금영수증 발행 안내 (필수)</div>'
        + '<div class="cwd-body" style="font-size:.82rem">결제 단계에서 <b>지출증빙 현금영수증</b>을 선택하고'
        + (cr.businessNo ? ' 사업자번호 <b>' + escAttr(cr.businessNo) + '</b>를 입력하세요.' : ' 안내된 사업자번호를 입력하세요.')
        + '</div>'
        + (cr.guideImageUrl ? '<img src="' + escAttr(cr.guideImageUrl) + '" alt="현금영수증 발행방법" style="margin-top:8px">' : '')
        + '<div style="font-size:.72rem;color:#B45309;font-weight:700;margin-top:8px">'
        + '⚠ 결제 화면을 지나기 전에 꼭 발행을 신청해 주세요 — 결제가 끝난 뒤에는 적용하기 어려워요.</div>'
        /* ★ D안(사용자 확정 2026-08-05): 발행확정(일련번호 부여)은 배송완료·구매확정 후 0~3일 —
           그래서 발행 내역 캡처는 구매양식 제출의 필수 항목이 아니고, 확정된 뒤에 따로 제출한다. */
        + '<div style="font-size:.72rem;color:#92400E;margin-top:4px">'
        + '📌 발행 내역 캡처는 발행이 확정된 뒤(배송완료·구매확정 후 0~3일) 제출하면 돼요 — 구매양식 제출 때 필수가 아니에요.</div>'
        + '</div>';
    }

    // 리뷰가이드·특이사항 첨부 이미지(그 카드 안에 그린다 — 유입가이드 밑에 나오면
    // 리뷰어가 "구매 경로 안내"로 읽는다). 토큰은 아래 유입가이드 추출의 중복 판정에 넘긴다.
    var revPack = imageListHtml(wd.reviewGuideImages, o.apiBase, '리뷰 가이드 이미지');
    var notePack = imageListHtml(wd.specialNotesImages, o.apiBase, '특이사항 이미지');

    // 유입가이드
    var guideHtml = wd.inflowGuideHtml || '';
    // ★ seen 에 두 배열의 토큰을 함께 넘겨 같은 사진이 유입가이드 카드에 이중 노출되지 않게 한다
    //   (레거시 경로: 리뷰가이드 '평문'에 섞여 온 주소는 종전대로 유입가이드 카드에 붙는다 — 무회귀)
    var extraImgs = extractGuideImages(
      wd.reviewGuide || '',
      guideHtml + revPack.tokens.join(' ') + notePack.tokens.join(' '),
      o.apiBase);
    var hasGuide = !!(guideHtml || extraImgs);   // 치환 전에 판정(아래에서 안내문으로 바뀜)
    if (!hasGuide) {
      guideHtml = '<span class="cwd-muted">등록된 유입가이드가 없어요.</span>';
    }
    /**
     * 상품 페이지 열기 = **링크유입일 때만**.
     * ★ 가이드유입 공고에 이 버튼을 주면 리뷰어가 상품 페이지로 바로 들어가 버려,
     *   검색어·경유 경로를 지정한 유입가이드 첨부자료가 통째로 무의미해진다(유입 실패).
     *   그래서 유입방식이 불명일 때는 **유입가이드 내용이 있으면 가이드유입으로 간주**해 버튼을 숨긴다
     *   (작업오더 연결이 없는 수동 공고가 여기 해당 — 종전엔 불명이면 무조건 노출이었다).
     */
    var isLinkInflow = d.inflowType === 'link' || (!d.inflowType && !hasGuide);
    html += '<div class="cwd-box"><div class="cwd-tt">🧭 유입가이드</div>'
      + '<div class="cwd-body">' + guideHtml + extraImgs + '</div>';
    // 옵션 공고는 리뷰어가 참여 시 고른 옵션의 링크로 이동한다.
    // 옵션 링크가 비어 있는 기존 공고는 공고 공통 링크를 그대로 사용한다.
    var landingUrl = (so && so.optionUrl) || d.landingUrl;
    if (o.showLanding !== false && landingUrl && isLinkInflow) {
      html += '<button type="button" class="cwd-btn" data-cwd-landing="' + escAttr(landingUrl) + '">🔗 상품 페이지 열기 (새 탭)</button>';
    }
    html += '</div>';

    // 리뷰 가이드 ([리뷰등록 가이드] 섹션만) + 첨부 이미지
    // ★ 사진만 있고 글이 비어도 카드를 낸다 — 안 그리면 관리자가 넣은 사진이 통째로 사라진다.
    //   글의 섹션 규칙(pickReviewOnly)은 그대로 — 사진은 섹션과 무관하게 이 카드에 나온다.
    var reviewOnly = pickReviewOnly(wd.reviewGuide);
    if (reviewOnly || revPack.html) {
      html += '<div class="cwd-box"><div class="cwd-tt">📝 리뷰 가이드</div>'
        + '<div class="cwd-body">' + escAttr(reviewOnly) + revPack.html + '</div></div>';
    }

    // 특이사항 + 첨부 이미지
    if (wd.specialNotes || notePack.html) {
      html += '<div class="cwd-box"><div class="cwd-tt">📌 특이사항</div>'
        + '<div class="cwd-body">' + escAttr(wd.specialNotes || '') + notePack.html + '</div></div>';
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
    extractGuideImages: extractGuideImages, imageListHtml: imageListHtml,
    escAttr: escAttr, driveId: driveId,
  };
})();
