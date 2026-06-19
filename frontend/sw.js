/* ══════════════════════════════════════════════════════════════
   sw.js — 최소 서비스워커 (안전망 전용)
   설계 원칙: 이 사이트는 main 머지 = 즉시 배포(_headers no-cache) 모델이다.
   따라서 SW는 "성능 캐시"를 하지 않는다. 역할은 다음 3가지로 한정한다.
     1) PWA 설치 가능(installable) 요건 충족
     2) 오프라인 안전망(offline.html)
     3) 아이콘 캐시(immutable)
   navigation/JS/CSS/API는 항상 네트워크 우선 → 코드 신선도 보장.
   ══════════════════════════════════════════════════════════════ */
const VERSION = 'iarev-pwa-v1';
const CACHE = `${VERSION}`;
const PRECACHE = ['/offline.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 개별 요청 실패가 install 전체를 깨지 않도록 관대하게 처리
      .then((cache) => Promise.allSettled(PRECACHE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isIcon(url) {
  return url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 업로드 등 비-GET은 건드리지 않음

  const url = new URL(req.url);

  // 1) 아이콘/매니페스트 → cache-first (변경 빈도 낮음, immutable)
  if (url.origin === self.location.origin && isIcon(url)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // 2) 페이지 이동(navigation) → network-first, 실패 시 오프라인 폴백
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((hit) => hit || caches.match('/offline.html')))
    );
    return;
  }

  // 3) 그 외(JS/CSS/API 등) → network-only, 오프라인일 때만 캐시 폴백
  //    (캐시에 적극적으로 넣지 않음 → 항상 최신 코드/응답 보장)
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
