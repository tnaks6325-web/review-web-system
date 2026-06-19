/* ══════════════════════════════════════════════════════════════
   pwa.js — 리뷰어 페이지 공용 모듈
   (1) 서비스워커 등록 (설치 가능 PWA)
   (2) 인앱브라우저(카카오톡 등) → 기본 브라우저 탈출
   index.html / search.html / recruit.html 에서 </body> 직전 include.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── 1) 서비스워커 등록 ─────────────────────────────── */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* noop */ });
    });
  }

  /* ── 2) 인앱브라우저 탈출 ───────────────────────────── */
  var ua = navigator.userAgent || '';

  // 이미 설치된 PWA(스탠드얼론)로 실행 중이면 탈출 불필요
  var isStandalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
  if (isStandalone) return;

  var isAndroid = /Android/i.test(ua);
  var isKakao = /KAKAOTALK/i.test(ua);
  // 카카오 외 주요 인앱 WebView (자동 탈출 스킴이 없어 안내 배너로 처리)
  var isOtherInApp =
    /Instagram/i.test(ua) ||
    /FBAN|FBAV|FB_IAB/i.test(ua) ||      // 페이스북
    /\bLine\//i.test(ua) ||              // 라인
    /NAVER\(inapp|NAVER/i.test(ua) ||    // 네이버 앱
    /DaumApps|DaumDevice/i.test(ua) ||   // 다음
    /\bBAND\//i.test(ua);                // 밴드

  /* (a) 카카오톡: 기본 브라우저로 자동 전환 (현재 URL 그대로 → ?r=CODE 보존) */
  if (isKakao) {
    var GUARD = 'iarev_kakao_escaped';
    try {
      if (!sessionStorage.getItem(GUARD)) {
        sessionStorage.setItem(GUARD, '1'); // 왕복 루프 방지: 세션당 1회만
        location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
      }
    } catch (_) {
      location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
    }
    return; // 배너까지 띄우지 않음
  }

  /* (b) 기타 인앱: 안내 배너 표시 */
  if (!isOtherInApp) return;

  function showBanner() {
    if (document.getElementById('iarev-inapp-banner')) return;

    var css = document.createElement('style');
    css.textContent =
      '#iarev-inapp-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
      'background:#191F28;color:#fff;padding:16px 18px calc(16px + env(safe-area-inset-bottom));' +
      'box-shadow:0 -4px 24px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif;}' +
      '#iarev-inapp-banner .t{font-size:.95rem;font-weight:700;margin-bottom:4px;}' +
      '#iarev-inapp-banner .d{font-size:.82rem;color:#C2C8D2;line-height:1.5;margin-bottom:12px;}' +
      '#iarev-inapp-banner .row{display:flex;gap:8px;}' +
      '#iarev-inapp-banner button{flex:1;padding:12px;border:none;border-radius:11px;font-size:.92rem;font-weight:800;cursor:pointer;}' +
      '#iarev-inapp-banner .open{background:#3182f6;color:#fff;}' +
      '#iarev-inapp-banner .copy{background:#363C46;color:#fff;}' +
      '#iarev-inapp-banner .x{position:absolute;top:8px;right:10px;background:none;border:none;color:#8A92A0;font-size:20px;width:auto;padding:4px 8px;flex:none;}';
    document.head.appendChild(css);

    var box = document.createElement('div');
    box.id = 'iarev-inapp-banner';
    box.innerHTML =
      '<button class="x" aria-label="닫기">&times;</button>' +
      '<div class="t">기본 브라우저에서 열어주세요</div>' +
      '<div class="d">원활한 이용을 위해 Chrome·Safari 등 기본 브라우저로 여는 것을 권장합니다.' +
      ' 우측 상단 메뉴(⋮ 또는 ···)에서 “다른 브라우저로 열기”를 선택하거나, 링크를 복사해 붙여넣으세요.</div>' +
      '<div class="row">' +
      (isAndroid ? '<button class="open">브라우저로 열기</button>' : '') +
      '<button class="copy">링크 복사</button>' +
      '</div>';
    document.body.appendChild(box);

    box.querySelector('.x').addEventListener('click', function () { box.remove(); });

    var copyBtn = box.querySelector('.copy');
    copyBtn.addEventListener('click', function () {
      var url = location.href;
      var done = function () {
        copyBtn.textContent = '복사됨 ✓';
        setTimeout(function () { copyBtn.textContent = '링크 복사'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
      function fallbackCopy() {
        try {
          var ta = document.createElement('textarea');
          ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.focus(); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta); done();
        } catch (_) { /* noop */ }
      }
    });

    var openBtn = box.querySelector('.open');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        // 안드로이드: Chrome intent 로 외부 전환 시도
        var u = location.href.replace(/^https?:\/\//, '');
        location.href = 'intent://' + u +
          '#Intent;scheme=https;package=com.android.chrome;end';
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showBanner);
  } else {
    showBanner();
  }
})();
