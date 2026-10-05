/**
 * image-shrink.js — 업로드 직전 이미지 축소 (리뷰어 경로 단일 출처)
 *
 * ★★ 왜 필요한가: 서버 본문 상한이 10MB(`express.json({limit:'10mb'})`)인데 base64 는 원본의
 *   약 1.33배라 **7.5MB 넘는 캡처는 413 으로 통째로 실패**한다. 요즘 폰 전체화면 캡처가 그 구간이다.
 *   실패해도 주문은 접수되므로 화면은 "제출 완료"로 보이고 **증빙만 조용히 빠진다** —
 *   그래서 관리자 수동제출 경로(`manual-order.js`)는 예전부터 1920px·JPEG 로 줄여 보냈다.
 *
 * ★ 원본을 무조건 줄이지 않는다 — 예산 안에 들어오면 그대로 보낸다(증빙 화질 보존).
 *   호출부가 "예산 초과일 때만" 부르는 구조이고, 이 모듈은 줄이는 일만 한다.
 * ★ 실패하면 빈 값을 돌려준다(throw 하지 않는다) — 축소 실패가 첨부·업로드를 막으면 안 된다.
 */
(function (global) {
  'use strict';

  /**
   * ★★ 축척 계산 **단일 출처** — `fromDataUrl`·`fromFile` 이 같은 규칙을 쓴다.
   * @param {boolean} longest  true = **긴 변** 기준(세로로 긴 캡처도 줄어든다)
   *                           false(기본) = 가로 폭 기준 — **기존 소비처 동작 그대로**.
   * ★ 세로로 긴 모바일 스크린샷(예 1080×2400)은 가로가 상한보다 작아 **폭 기준으로는
   *   한 번도 줄지 않는다**. 리뷰 캡처가 그 모양이라 업로드가 느렸다(2026-09-22 실측).
   * ★ 이미 상한 안이면 1(=줄이지 않는다) — 확대는 하지 않는다.
   */
  function _scale(w, h, maxPx, longest) {
    const side = longest ? Math.max(w || 0, h || 0) : (w || 0);
    if (!side || !maxPx || side <= maxPx) return 1;
    return maxPx / side;
  }

  /** dataURL → dataURL(JPEG). 실패 시 "" (호출부가 원본으로 폴백). */
  function fromDataUrl(dataUrl, maxPx, quality, opts) {
    const mx = maxPx || 1920;
    const q = typeof quality === 'number' ? quality : 0.8;
    const longest = !!(opts && opts.longest);
    return new Promise(function (resolve) {
      try {
        const img = new Image();
        img.onload = function () {
          try {
            let w = img.width || mx, h = img.height || mx;
            const sc = _scale(w, h, mx, longest);
            if (sc < 1) { w = Math.round(w * sc); h = Math.round(h * sc); }
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, w); cv.height = Math.max(1, h);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            resolve(cv.toDataURL('image/jpeg', q));
          } catch (_) { resolve(''); }
        };
        img.onerror = function () { resolve(''); };
        img.src = dataUrl;
      } catch (_) { resolve(''); }
    });
  }

  /** File → {base64, mime}. 실패 시 원본 그대로 읽어 돌려준다(null 은 파일 자체를 못 읽은 경우). */
  function fromFile(file, maxPx, quality, opts) {
    return new Promise(function (resolve) {
      const raw = function () {
        try {
          const rd = new FileReader();
          rd.onload = function () {
            const s = String(rd.result || '');
            resolve(s.indexOf(',') >= 0 ? { base64: s.split(',')[1] || '', mime: file.type || 'image/jpeg' } : null);
          };
          rd.onerror = function () { resolve(null); };
          rd.readAsDataURL(file);
        } catch (_) { resolve(null); }
      };
      try {
        // 이미 작은 JPEG 은 손대지 않는다(재인코딩은 화질만 깎는다).
        if (file.size <= 1024 * 1024 && file.type === 'image/jpeg') return raw();
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          const mx = maxPx || 1920;
          const q = typeof quality === 'number' ? quality : 0.8;
          const longest = !!(opts && opts.longest);
          try {
            let w = img.width, h = img.height;
            const sc = _scale(w, h, mx, longest);
            if (sc < 1) { w = Math.round(w * sc); h = Math.round(h * sc); }
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, w); cv.height = Math.max(1, h);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            const durl = cv.toDataURL('image/jpeg', q);
            const b64 = durl.split(',')[1] || '';
            if (b64) resolve({ base64: b64, mime: 'image/jpeg' }); else raw();
          } catch (_) { raw(); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); raw(); };
        img.src = url;
      } catch (_) { raw(); }
    });
  }

  /** 서버 본문 상한(10MB) 대비 base64 예산. 초과하면 줄인다. */
  const UPLOAD_BUDGET = 6000000;

  global.ImageShrink = { fromDataUrl: fromDataUrl, fromFile: fromFile, UPLOAD_BUDGET: UPLOAD_BUDGET, _scale: _scale };
})(window);
