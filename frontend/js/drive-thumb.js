/* ══════════════════════════════════════════════════════════════
   Drive 이미지 썸네일 — 구글 CDN 직결 (공유 모듈)

   실측(2026-08-24): 우리 프록시 `/api/drive/image/<id>` 는 파일 1장당 **1.7~1.8초**이고
   (31KB·631KB 가 비슷 = Drive 지연 + 전송량이 지배) 같은 이미지의
   `drive.google.com/thumbnail?sz=w<px>` 는 **0.4초 안팎**에 바이트도 3~7배 작다
   (197KB 원본 → w600 27KB). 그래서 **원본 화질이 필요 없는 자리**만 CDN 으로 돌린다.

   ★★ 원본이 필요한 자리는 프록시 그대로(완화 금지) — 크게 보기·라이트박스·대조·이미지 저장·AI 판정.
   ★★ URL 규칙은 **여기 한 곳**. 소비처는 자기가 이미 만든 프록시 URL 을 `full` 로 넘긴다
      (프록시 URL 규칙 사본 0). 사본을 두면 한쪽만 크기·검증이 달라진다.
   ★ CDN 이 안 되는 파일(비공개 공유)은 `onerror` 로 **프록시에 1회 폴백** — 실패해도
     오늘과 같은 그림이 나온다(막다른 길 0). 폴백은 한 번만(무한 루프 금지).
   ★ 이 스크립트를 못 불러온 페이지에서도 소비처는 `window.DriveThumb` 유무를 보고
     **원본 프록시로 접는다** — 그쪽도 사본이 아니라 이미 들고 있는 값이다.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** 파일ID → CDN 썸네일 URL. 형식이 아니면 빈 문자열(호출부가 원본으로 접는다). */
  function url(id, px) {
    var s = String(id || '');
    if (!/^[-\w]{20,}$/.test(s)) return '';
    var w = Math.max(100, Math.min(1600, Number(px) || 400));
    return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(s) + '&sz=w' + w;
  }

  /** <img> 속성 한 벌 — src(CDN) + data-full(원본 프록시) + onerror 폴백 */
  function attrs(id, px, full) {
    var t = url(id, px);
    if (!t) return ' src="' + esc(full || '') + '"';          // 형식 불량 = 종전 동작
    return ' src="' + esc(t) + '" data-full="' + esc(full || '') + '" onerror="DriveThumb.fall(this)"';
  }

  function fall(img) {
    if (!img || img.dataset.tf) return;                        // ★ 한 번만
    img.dataset.tf = '1';
    var u = img.getAttribute('data-full') || '';
    if (u) img.src = u; else img.removeAttribute('src');       // 원본도 없으면 깨진 아이콘 대신 빈 칸
  }

  window.DriveThumb = { url: url, attrs: attrs, fall: fall };
})();
