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

   ── 결정 353 — 사진 빠른 길(우리 사이트 `/img/<t|m>/<id>?e=&s=`, Cloudflare R2 + 서울 엣지 캐시) ──
   ★ 서명 주소가 있으면 그것을 먼저 쓰고, 없으면 종전(구글 썸네일) 그대로. 서명은 서버만 만든다:
     ① 로그인 화면 = 이 모듈이 `POST /api/img/sign` 으로 한 번에 받아 온다(직원 토큰이 있을 때만)
     ② 무인증 화면 = 그 화면의 응답이 실어 준 주소를 `DriveThumb.seed([...])` 로 넣는다.
   ★ 실패 사다리(한 칸씩, 되돌아가지 않는다 — 무한 루프 금지):
       빠른 길(data-dt="e") → 구글 썸네일(data-dt="g") → 원본 프록시(data-tf) → 빈 칸
     빠른 길이 한 번 실패한 사진은 이 페이지에서 다시 빠른 길을 쓰지 않는다.
   ★ 서명이 늦게 와도 기다리지 않는다 — 구글 썸네일로 그려 두고, 서명이 오면 **아직 다 안 뜬** 사진만 갈아 끼운다.
   ★ kind: 요청 크기 400 이하 = t(가로 400) · 그보다 크면 m(가로 1600). 원본은 이 길로 오지 않는다.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var EDGE_RE = /^\/img\/([tm])\/([-\w]{20,})\?e=(\d+)&s=[-\w]{43}$/;
  var SIGN_CHUNK = 200;
  var STORE = 'dt_edge_v1';
  var STORE_MAX = 3000;

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

  // ── 빠른 길 서명 보관 ── kind:id → { u: '/img/…', e: 만료(초) }
  var edge = {};
  var dead = {};          // kind:id → 1  (이 페이지에서 빠른 길 실패·서명 거절 — 다시 묻지 않는다)
  var asked = {};         // kind:id → 1  (서명 요청 중/끝)
  var queue = { t: {}, m: {} };
  var timer = null;
  var off = false;        // 서버가 빠른 길을 꺼 두었거나(열쇠 없음) 서명 입구가 실패 → 이 페이지에서 그만 묻는다

  function kindOf(px) { return (Number(px) || 400) > 400 ? 'm' : 't'; }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  function store() { try { return window.sessionStorage || null; } catch (_) { return null; } }
  try {
    var ss = store();
    var saved = JSON.parse((ss && ss.getItem(STORE)) || '{}');
    for (var sk in saved) if (saved[sk] && saved[sk].e > nowSec() + 300 && EDGE_RE.test(saved[sk].u)) edge[sk] = saved[sk];
  } catch (_) { /* 보관소가 없거나 깨졌으면 비운 채로 */ }
  function persist() {
    try {
      var ss = store(); if (!ss) return;
      var keys = Object.keys(edge);
      if (keys.length > STORE_MAX) keys = keys.slice(keys.length - STORE_MAX);
      var o = {}; for (var i = 0; i < keys.length; i++) o[keys[i]] = edge[keys[i]];
      ss.setItem(STORE, JSON.stringify(o));
    } catch (_) {}
  }

  /** 서명 주소 한 개를 받아 둔다(형식이 아니거나 곧 만료면 무시). @returns 받아들였나 */
  function put(u) {
    var m = EDGE_RE.exec(String(u || ''));
    if (!m) return false;
    var e = Number(m[3]);
    if (e <= nowSec() + 60) return false;
    edge[m[1] + ':' + m[2]] = { u: m[0], e: e };
    return true;
  }
  function edgeUrl(id, k) {
    var key = k + ':' + id, c = edge[key];
    if (!c || dead[key]) return '';
    if (c.e <= nowSec() + 60) { delete edge[key]; return ''; }
    return c.u;
  }

  /** 무인증 화면 — 응답이 실어 준 서명 주소들(문자열 배열)을 넣는다. 이미 그려진 사진도 갈아 끼운다. */
  function seed(list) {
    var n = 0;
    (list || []).forEach(function (u) { if (put(u)) n++; });
    if (n) { persist(); swapIn(); }
    return n;
  }

  function apiBase() {
    /* 작업보드는 자기 API_BASE(PR 테섭 규칙이 api.js 와 다르다), 나머지는 api.js 의 API_BASE_URL. */
    try { if (typeof API_BASE !== 'undefined' && API_BASE) return API_BASE; } catch (_) {}
    try { if (typeof API_BASE_URL !== 'undefined' && API_BASE_URL) return API_BASE_URL; } catch (_) {}
    return '';
  }
  function staffToken() {
    try { var ss = store(); return (ss && ss.getItem('admin_token')) || ''; } catch (_) { return ''; }
  }

  function want(id, k) {
    var key = k + ':' + id;
    if (off || asked[key] || dead[key]) return;
    if (!staffToken() || typeof fetch !== 'function') return;     // 무인증 화면은 seed 로만
    queue[k][id] = 1;
    if (!timer) timer = setTimeout(flush, 0);                      // 한 화면 그리기분을 한 번에
  }

  function flush() {
    timer = null;
    if (off) return;
    var tok = staffToken(), base = apiBase();
    if (!tok) return;
    ['t', 'm'].forEach(function (k) {
      var ids = Object.keys(queue[k]);
      queue[k] = {};
      for (var i = 0; i < ids.length; i += SIGN_CHUNK) sign(k, ids.slice(i, i + SIGN_CHUNK), tok, base);
    });
  }

  function sign(k, ids, tok, base) {
    ids.forEach(function (id) { asked[k + ':' + id] = 1; });
    fetch(base + '/api/img/sign', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: k, ids: ids })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.ok || j.enabled === false) { off = true; return; }
      var urls = j.urls || {};
      ids.forEach(function (id) { if (!urls[id] || !put(urls[id])) dead[k + ':' + id] = 1; });
      persist();
      swapIn();
    }).catch(function () { off = true; });                         // 실패 = 종전 그대로(구글 썸네일)
  }

  /** 이미 그려진 사진 중 **아직 다 안 뜬 것**만 빠른 길로 갈아 끼운다.
      구글이 벌써 실패해 느린 원본으로 가던 사진(data-tf)도 포함 — 빠른 길이 또 실패하면 원본으로 되돌린다. */
  function swapIn() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var list = document.querySelectorAll('img[data-dt="g"][data-dt-id]');
    for (var i = 0; i < list.length; i++) {
      var img = list[i];
      if (img.complete && img.naturalWidth > 0) continue;
      var u = edgeUrl(img.getAttribute('data-dt-id'), img.getAttribute('data-dt-k') || 't');
      if (!u) continue;
      img.setAttribute('data-dt', 'e');
      img.src = u;
    }
  }

  /** <img> 속성 한 벌 — src(빠른 길 또는 CDN) + data-full(원본 프록시) + onerror 폴백 */
  function attrs(id, px, full) {
    var t = url(id, px);
    if (!t) return ' src="' + esc(full || '') + '"';          // 형식 불량 = 종전 동작
    var s = String(id), k = kindOf(px), e = edgeUrl(s, k);
    if (!e) want(s, k);
    return ' src="' + esc(e || t) + '" data-full="' + esc(full || '') + '" onerror="DriveThumb.fall(this)"'
      + ' data-dt="' + (e ? 'e' : 'g') + '" data-dt-id="' + esc(s) + '" data-dt-k="' + k + '" data-g="' + esc(t) + '"';
  }

  function fall(img) {
    if (!img) return;
    if (img.getAttribute && img.getAttribute('data-dt') === 'e') {   // 빠른 길 실패
      var id = img.getAttribute('data-dt-id'), k = img.getAttribute('data-dt-k') || 't';
      if (id) dead[k + ':' + id] = 1;                          // 이 페이지에서 다시 빠른 길로 가지 않는다
      img.setAttribute('data-dt', 'x');
      if (img.dataset.tf) {                                    // 구글이 이미 실패해 원본으로 가던 중에 갈아 낀 것 → 원본으로 되돌린다
        var f0 = img.getAttribute('data-full') || '';
        if (f0) img.src = f0; else img.removeAttribute('src');
        return;
      }
      var g = img.getAttribute('data-g') || '';
      if (g) { img.setAttribute('data-dt', 'g'); img.src = g; return; }   // → 구글 썸네일(1회)
    }
    if (img.dataset.tf) return;                                // ★ 한 번만
    img.dataset.tf = '1';
    var u = img.getAttribute('data-full') || '';
    if (u) img.src = u; else img.removeAttribute('src');       // 원본도 없으면 깨진 아이콘 대신 빈 칸
  }

  window.DriveThumb = { url: url, attrs: attrs, fall: fall, seed: seed, edgeUrl: edgeUrl, kindOf: kindOf };
})();
