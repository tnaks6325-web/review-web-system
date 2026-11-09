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

   ── 결정 354 — 사진 빠른 길(우리 사이트 `/img/<t|m>/<id>?e=&s=`, Cloudflare R2 + 서울 엣지 캐시) ──
   ★ 서명 주소가 있으면 그것을 먼저 쓰고, 없으면 종전(구글 썸네일) 그대로. 서명은 서버만 만든다:
     ① 로그인 화면 = 이 모듈이 `POST /api/trackb/img/sign` 으로 한 번에 받아 온다(직원 토큰이 있을 때만)
     ② 무인증 화면 = 그 화면의 응답이 실어 준 주소를 `DriveThumb.seed([...])` 로 넣는다.
   ★ 실패 사다리(한 칸씩, 되돌아가지 않는다 — 무한 루프 금지):
       빠른 길(data-dt="e") → 구글 썸네일(data-dt="g") → 원본 프록시(data-tf) → 빈 칸
     빠른 길이 한 번 실패한 사진은 이 페이지에서 다시 빠른 길을 쓰지 않는다.
   ★ 서명이 늦게 와도 기다리지 않는다 — 구글 썸네일로 그려 두고, 서명이 오면 **아직 다 안 뜬** 사진만 갈아 끼운다.
   ★ kind: 요청 크기 400 이하 = t(가로 400) · 그보다 크면 m(가로 1600).

   ── 원본 빠른 길(o, 2026-11-09 사용자 확정 「모든 사진 미리 만들기」) ──
   ★ o = 드라이브 원본 바이트 그대로(변환 0). 결정 008 「원본 유지」 자리(크게 보기·대조·라이트박스·저장)는
     `full(id, 원본프록시)` / `fullAttrs(id, 원본프록시)` 만 쓴다 — **t·m(변환본)은 이 두 함수에서 절대 나오지 않는다.**
     o 서명이 없으면 종전 원본 프록시 그대로(글자 하나 다르지 않은 src), o 가 실패하면 원본 프록시로 1회(fullFall).
   ★ o 서명은 목록 사진(t/m) 서명 요청에 덤(extra:['o'])으로 함께 받는다(요청 수 그대로). 옛 서버가 덤을 모르면
     그 번호의 o 는 묻지 않는다(옛 서버는 kind o 를 400 으로 거절 — 그 400 이 빠른 길 전체를 끄지 않게).
   ★ 미리 불러두기(prefetch): 목록 사진 위에 마우스를 올리면(또는 손가락이 닿으면) 그 사진의 o 를 미리 받아 둔다 —
     동시 2장 · 대기 4장(오래된 것부터 버림) · 한 페이지 120장 · 같은 사진 1회.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var EDGE_RE = /^\/img\/([tmo])\/([-\w]{20,})\?e=(\d+)&s=[-\w]{43}$/;
  var ID_RE = /^[-\w]{20,}$/;
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
  var queue = { t: {}, m: {}, o: {} };
  var oldServer = false;  // 서버가 덤(more)을 모른다 → o 를 따로 묻지 않는다(옛 서버는 kind o 를 400 으로 거절)
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
    if (k === 'o' && oldServer) return;
    if (!staffToken() || typeof fetch !== 'function') return;     // 무인증 화면은 seed 로만
    queue[k][id] = 1;
    if (!timer) timer = setTimeout(flush, 0);                      // 한 화면 그리기분을 한 번에
  }

  function flush() {
    timer = null;
    if (off) return;
    var tok = staffToken(), base = apiBase();
    if (!tok) return;
    var oq = queue.o; queue.o = {};
    ['t', 'm'].forEach(function (k) {
      var ids = Object.keys(queue[k]);
      queue[k] = {};
      // 원본(o)도 바라는 번호가 섞인 묶음이면 o 를 덤으로(요청 수 그대로). 가이드 사진만의 묶음은 종전 본문 그대로.
      var withO = ids.some(function (id) { return oq[id]; });
      if (withO) ids.forEach(function (id) { delete oq[id]; });
      for (var i = 0; i < ids.length; i += SIGN_CHUNK) sign(k, ids.slice(i, i + SIGN_CHUNK), tok, base, withO);
    });
    var rest = Object.keys(oq);                                    // 작은 사진은 이미 있고 원본 서명만 없는 번호
    for (var j = 0; j < rest.length; j += SIGN_CHUNK) sign('o', rest.slice(j, j + SIGN_CHUNK), tok, base, false);
  }

  function sign(k, ids, tok, base, withO) {
    ids.forEach(function (id) { asked[k + ':' + id] = 1; if (withO) asked['o:' + id] = 1; });
    var body = { kind: k, ids: ids };
    if (withO) body.extra = ['o'];
    fetch(base + '/api/trackb/img/sign', {   // ★ Track B 경로 — 인트라넷 SSO 토큰은 /api/trackb/* 밖이 403(결정 354 보강)
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok && r.status === 400 && k === 'o') return { __oRefused: true };   // 옛 서버 = o 만 포기(빠른 길 전체는 그대로)
      return r.ok ? r.json() : null;
    }).then(function (j) {
      if (j && j.__oRefused) { oldServer = true; ids.forEach(function (id) { dead['o:' + id] = 1; }); return; }
      if (!j || !j.ok || j.enabled === false) { off = true; return; }
      var urls = j.urls || {};
      ids.forEach(function (id) { if (!urls[id] || !put(urls[id])) dead[k + ':' + id] = 1; });
      if (withO) {
        var mo = j.more && j.more.o;
        if (!mo) oldServer = true;                                  // 덤을 모르는 서버 — o 는 종전 원본 프록시
        ids.forEach(function (id) { if (!mo || !mo[id] || !put(mo[id])) dead['o:' + id] = 1; });
      }
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
    if (!edgeUrl(s, 'o')) want(s, 'o');                        // 크게 보기 원본(o) — 같은 묶음의 덤으로 함께 온다
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

  /* ── 결정 354 남은 화면 — 가이드·공고 사진(우리 가이드 사진 통로 · 구글 큰 썸네일) ──
     ★ 저장된 주소는 그대로 두고 **그릴 때만** 갈아 끼운다(가이드 HTML·사진 배열·썸네일 주소는 인트라넷에도 주소째 저장).
     ★ 서명은 그 화면의 응답이 실어 준 것(seed) 또는 직원 화면의 일괄 서명(want) — 무인증 서명 입구 없음.
     ★ 사다리(한 방향): 빠른 길(data-dt="e") → 종전 주소(data-g) → 화면 자기 onerror(있으면) → 멈춤.
     ★ 서명이 없고 직원 토큰도 없으면 **종전과 글자 하나 다르지 않은** src 한 개만 낸다(화면 모양·동작 불변). */
  var GUIDE_RES = [
    /\/api\/order\/guide-image\/([-\w]{20,})(?:[?#]|$)/,
    /^https:\/\/drive\.google\.com\/thumbnail\?id=([-\w]{20,})(?:&|$)/
  ];
  function guideId(src) {
    var s = String(src || '');
    for (var i = 0; i < GUIDE_RES.length; i++) { var m = GUIDE_RES[i].exec(s); if (m) return m[1]; }
    return '';
  }
  function canSign() { return !off && !!staffToken() && typeof fetch === 'function'; }
  function guideOnErr(onErr) { return onErr ? 'if(!DriveThumb.guideFall(this)){' + onErr + '}' : 'DriveThumb.guideFall(this)'; }

  /** <img> 속성 — src(빠른 길 또는 종전 주소) + 사다리 표지. onErr = 화면이 원래 쓰던 onerror 코드(종전 주소마저 실패할 때). */
  function guideAttrs(src, px, onErr) {
    var s = String(src || ''), id = guideId(s), k = kindOf(px);
    var plain = ' src="' + esc(s) + '"' + (onErr ? ' onerror="' + esc(onErr) + '"' : '');
    if (!id) return plain;
    var e = edgeUrl(id, k);
    if (!e) {
      if (dead[k + ':' + id] || !canSign()) return plain;
      want(id, k);
    }
    return ' src="' + esc(e || s) + '" data-dt="' + (e ? 'e' : 'g') + '" data-dt-id="' + esc(id) + '" data-dt-k="' + k + '"'
      + ' data-g="' + esc(s) + '" onerror="' + esc(guideOnErr(onErr)) + '"';
  }

  /** 가이드 사진의 빠른 길 실패 → 종전 주소로(1회). @returns 처리했나(false = 화면 자기 폴백 몫) */
  function guideFall(img) {
    if (!img || !img.getAttribute || img.getAttribute('data-dt') !== 'e') return false;
    var id = img.getAttribute('data-dt-id'), k = img.getAttribute('data-dt-k') || 'm';
    if (id) dead[k + ':' + id] = 1;                           // 이 페이지에서 다시 빠른 길로 가지 않는다
    img.setAttribute('data-dt', 'x');
    var g = img.getAttribute('data-g') || '';
    if (!g) return false;
    img.src = g;
    return true;
  }

  /** 아직 문서에 붙지 않은 조각(template.content 등) 안의 가이드 사진 <img> 를 갈아 끼운다. @returns 빠른 길로 바꾼 수 */
  function upgrade(root, px) {
    if (!root || !root.querySelectorAll) return 0;
    var list = root.querySelectorAll('img'), n = 0, k = kindOf(px || 1600);
    for (var i = 0; i < list.length; i++) {
      var img = list[i];
      if (img.getAttribute('data-dt')) continue;               // 이미 사다리에 오른 사진(작은 사진 등)
      var s = img.getAttribute('src') || '', id = guideId(s);
      if (!id) continue;
      var e = edgeUrl(id, k);
      if (!e && (dead[k + ':' + id] || !canSign())) continue;   // 서명 없음 = 손대지 않는다(종전 그대로)
      if (!e) want(id, k);
      img.setAttribute('data-dt', e ? 'e' : 'g');
      img.setAttribute('data-dt-id', id);
      img.setAttribute('data-dt-k', k);
      img.setAttribute('data-g', s);
      img.setAttribute('onerror', guideOnErr(img.getAttribute('onerror') || ''));
      if (e) { img.setAttribute('src', e); n++; }
    }
    return n;
  }

  /* ── 원본 유지 자리(결정 008) — o(원본 바이트 그대로) 또는 종전 원본 프록시. ★ t·m 은 여기서 나오지 않는다. ── */
  /** 원본 주소 한 개 — o 서명이 있으면 그것, 없으면 받은 원본 프록시 그대로(그리고 다음을 위해 o 서명을 묻는다). */
  function full(id, proxy) {
    var s = String(id || '');
    if (!ID_RE.test(s)) return proxy || '';
    var e = edgeUrl(s, 'o');
    if (!e) want(s, 'o');
    return e || proxy || '';
  }
  /** 원본 <img> 속성 — o 가 있으면 o + 실패 시 원본 프록시 1회(fullFall), 없으면 종전과 같은 src 한 개. */
  function fullAttrs(id, proxy) {
    var s = String(id || ''), p = proxy || '';
    var e = ID_RE.test(s) ? edgeUrl(s, 'o') : '';
    if (!e) { if (ID_RE.test(s)) want(s, 'o'); return ' src="' + esc(p) + '"'; }
    return ' src="' + esc(e) + '" data-dt="o" data-dt-id="' + esc(s) + '" data-full="' + esc(p) + '" onerror="DriveThumb.fullFall(this)"';
  }
  /** o 실패 → 원본 프록시로 한 번. @returns 처리했나 */
  function fullFall(img) {
    if (!img || !img.getAttribute || img.getAttribute('data-dt') !== 'o') return false;
    var id = img.getAttribute('data-dt-id');
    if (id) dead['o:' + id] = 1;                               // 이 페이지에서 다시 o 로 가지 않는다
    img.setAttribute('data-dt', 'x');
    var f = img.getAttribute('data-full') || '';
    if (f) img.src = f; else img.removeAttribute('src');
    return true;
  }

  // ── o 미리 불러두기 — 크게 보기를 누르기 전에(마우스를 올린 사진만) 원본을 브라우저 캐시에 받아 둔다 ──
  var PRE_MAX = 2, PRE_WAIT = 4, PRE_TOTAL = 120;
  var preBusy = 0, preWait = [], preDone = {}, preCount = 0;
  function prePump() {
    while (preBusy < PRE_MAX && preWait.length) {
      var job = preWait.pop();                                 // 가장 최근에 가리킨 사진부터
      preBusy++;
      try {
        var im = new Image();
        im.onload = im.onerror = function () { preBusy--; prePump(); };
        im.src = job.u;
      } catch (_) { preBusy--; }
    }
  }
  /** @returns 미리 받기를 걸었나 */
  function prefetch(id) {
    var s = String(id || '');
    if (typeof Image !== 'function' || !ID_RE.test(s) || preDone[s] || preCount >= PRE_TOTAL) return false;
    var u = edgeUrl(s, 'o');
    if (!u) return false;
    preDone[s] = 1; preCount++;
    preWait.push({ id: s, u: u });
    if (preWait.length > PRE_WAIT) { var drop = preWait.shift(); delete preDone[drop.id]; preCount--; }   // 오래된 것 버림(다시 가리키면 다시)
    prePump();
    return true;
  }
  function onPoint(ev) {
    var t = ev && ev.target;
    var img = t && t.closest ? t.closest('img[data-dt-id]') : null;
    if (!img) return;
    var k = img.getAttribute('data-dt-k');
    if (k === 't' || k === 'm') prefetch(img.getAttribute('data-dt-id'));
  }
  try {
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('mouseover', onPoint, { passive: true });
      document.addEventListener('touchstart', onPoint, { passive: true });
    }
  } catch (_) {}

  window.DriveThumb = { url: url, attrs: attrs, fall: fall, seed: seed, edgeUrl: edgeUrl, kindOf: kindOf,
    guideId: guideId, guideAttrs: guideAttrs, guideFall: guideFall, upgrade: upgrade,
    full: full, fullAttrs: fullAttrs, fullFall: fullFall, prefetch: prefetch };
})();
