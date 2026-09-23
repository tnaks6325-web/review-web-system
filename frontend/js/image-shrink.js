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

  /** dataURL → dataURL(JPEG). 실패 시 "" (호출부가 원본으로 폴백). */
  function fromDataUrl(dataUrl, maxPx, quality) {
    const mx = maxPx || 1920;
    const q = typeof quality === 'number' ? quality : 0.8;
    return new Promise(function (resolve) {
      try {
        const img = new Image();
        img.onload = function () {
          try {
            let w = img.width || mx, h = img.height || mx;
            if (w > mx) { h = Math.round(h * (mx / w)); w = mx; }
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
  function fromFile(file, maxPx, quality) {
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
          try {
            let w = img.width, h = img.height;
            if (w > mx) { h = Math.round(h * (mx / w)); w = mx; }
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

  global.ImageShrink = { fromDataUrl: fromDataUrl, fromFile: fromFile, UPLOAD_BUDGET: UPLOAD_BUDGET };
})(window);
