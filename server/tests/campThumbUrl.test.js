/**
 * campThumbUrl.test.js — 쿠팡 썸네일 이미지주소 수집 회귀가드
 * (쿠팡 HTML은 봇차단 403·이미지 CDN은 미차단 → 관리자가 복사한 CDN URL만 서버가 받아 Drive 재저장)
 * 실행: node tests/campThumbUrl.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { thumbUrlAllowed, fetchThumbFromUrl, THUMB_URL_MAX_BYTES } = require('../src/utils/thumbFetch');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; console.log('  ✓ ' + name); }

function stubResp({ status = 200, ctype = 'image/jpeg', clen, body = Buffer.from('imgdata') } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(k) {
      k = String(k).toLowerCase();
      if (k === 'content-type') return ctype;
      if (k === 'content-length') return clen != null ? String(clen) : null;
      return null;
    } },
    arrayBuffer: async () => Uint8Array.from(body).buffer,
  };
}

(async () => {
  // ── 1. 호스트 허용목록 (SSRF 차단) ──
  ok('허용: thumbnail*.coupangcdn.com', thumbUrlAllowed('https://thumbnail6.coupangcdn.com/thumbnails/remote/492x492ex/image/a.jpg'));
  ok('허용: image*.coupangcdn.com', thumbUrlAllowed('https://image10.coupangcdn.com/image/retail/images/a.png'));
  ok('허용: apex coupangcdn.com', thumbUrlAllowed('https://coupangcdn.com/a.jpg'));
  ok('차단: http(비 https)', !thumbUrlAllowed('http://thumbnail6.coupangcdn.com/a.jpg'));
  ok('차단: 임의 호스트', !thumbUrlAllowed('https://evil.com/a.jpg'));
  ok('차단: 서픽스 위장(coupangcdn.com.evil.com)', !thumbUrlAllowed('https://coupangcdn.com.evil.com/a.jpg'));
  ok('차단: 접두 위장(fakecoupangcdn.com)', !thumbUrlAllowed('https://fakecoupangcdn.com/a.jpg'));
  ok('차단: localhost·내부 IP', !thumbUrlAllowed('https://localhost/a.jpg') && !thumbUrlAllowed('https://192.168.0.1/a.jpg'));
  ok('차단: userinfo 포함 URL', !thumbUrlAllowed('https://user@coupangcdn.com/a.jpg'));
  ok('차단: 비URL·빈값', !thumbUrlAllowed('') && !thumbUrlAllowed('notaurl') && !thumbUrlAllowed(null));

  process.env.THUMB_URL_HOST_ALLOW = 'coupangcdn.com, example-cdn.net';
  ok('env 확장: THUMB_URL_HOST_ALLOW csv (기본 호스트는 목록에 다시 넣어야 유지)',
    thumbUrlAllowed('https://img.example-cdn.net/a.jpg') && thumbUrlAllowed('https://thumbnail6.coupangcdn.com/a.jpg'));
  delete process.env.THUMB_URL_HOST_ALLOW;

  // ── 2. fetch 가드 (fetch 스텁 — 실네트워크 미사용) ──
  const realFetch = global.fetch;
  try {
    let fetchCalls = 0;
    global.fetch = async () => { fetchCalls++; return stubResp(); };
    const got = await fetchThumbFromUrl('https://thumbnail6.coupangcdn.com/a.jpg');
    ok('정상: base64+mimeType 반환', got.base64 === Buffer.from('imgdata').toString('base64') && got.mimeType === 'image/jpeg');

    await assert.rejects(() => fetchThumbFromUrl('https://evil.com/a.jpg'), /허용되지 않은/);
    ok('비허용 URL은 fetch 자체를 안 함(사전 검증)', fetchCalls === 1);

    global.fetch = async () => stubResp({ status: 302 });
    await assert.rejects(() => fetchThumbFromUrl('https://thumbnail6.coupangcdn.com/a.jpg'), /리다이렉트/);
    ok('리다이렉트 거부(허용목록 우회 차단)', true);

    global.fetch = async () => stubResp({ ctype: 'text/html' });
    await assert.rejects(() => fetchThumbFromUrl('https://thumbnail6.coupangcdn.com/a.jpg'), /이미지가 아닙니다/);
    ok('비이미지 content-type 거부', true);

    global.fetch = async () => stubResp({ clen: THUMB_URL_MAX_BYTES + 1 });
    await assert.rejects(() => fetchThumbFromUrl('https://thumbnail6.coupangcdn.com/a.jpg'), /5MB/);
    ok('content-length 5MB 초과 거부', true);

    global.fetch = async () => stubResp({ body: Buffer.alloc(THUMB_URL_MAX_BYTES + 1) });
    await assert.rejects(() => fetchThumbFromUrl('https://thumbnail6.coupangcdn.com/a.jpg'), /5MB/);
    ok('실바디 5MB 초과 거부(content-length 부재·거짓 대비)', true);

    global.fetch = async () => stubResp({ status: 404 });
    await assert.rejects(() => fetchThumbFromUrl('https://thumbnail6.coupangcdn.com/a.jpg'), /HTTP 404/);
    ok('HTTP 오류 표면화', true);
  } finally {
    global.fetch = realFetch;
  }

  // ── 3. 배선 (소스 grep) ──
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const readF = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', p), 'utf8');
  const ord = read('src/routes/order.routes.js');
  const prod = read('src/routes/product.routes.js');
  const recjs = readF('js/index-recruit.js');
  const adm = readF('admin.html');

  ok('배선: guide-image imageUrl 분기가 thumbFetch 사용', /fetchThumbFromUrl/.test(ord) && /b\.imageUrl/.test(ord));
  ok('배선: base64가 오면 URL 분기 미진입(기존 계약 불변)', /\(!b\.imageBase64 \|\| !String\(b\.imageBase64\)\.trim\(\)\) && b\.imageUrl/.test(ord));
  ok('프론트: rf_thumb_url 입력 + 가져오기 버튼(admin.html)', /rf_thumb_url/.test(adm) && /fetchCampThumbFromUrl/.test(adm));
  ok('프론트: fetchCampThumbFromUrl → guide-image imageUrl 재사용(신규 API 없음)', /function fetchCampThumbFromUrl/.test(recjs) && /imageUrl: url/.test(recjs) && /\/api\/order\/guide-image/.test(recjs));
  ok('안내: 쿠팡 403 힌트가 이미지 주소 경로로 안내', /이미지 주소 복사/.test(prod));

  console.log(`\n✅ campThumbUrl: ${passed}개 통과`);
})().catch((e) => { console.error('❌ 실패:', e.message); process.exit(1); });
