/**
 * thumbFetch.js — 썸네일 이미지 URL 수집(서버측 fetch) 헬퍼
 *
 * 배경: 쿠팡 상품 HTML은 Akamai 봇차단으로 데이터센터발 서버 요청이 즉시 403(UA 스푸핑·
 * stealth 프록시 무효 — 실측)이라 서버 스크래핑이 불가하지만, 이미지 CDN(coupangcdn.com)은
 * 차단이 없다(실측). 관리자가 브라우저에서 "이미지 주소 복사"한 CDN URL을 서버가 받아
 * Drive(guide-image)로 재저장하는 경로의 fetch 부분. 핫링크가 아니라 재저장이므로
 * 쿠팡 CDN 변경·리퍼러 정책에도 안전.
 *
 * 안전장치(SSRF 차단): https 전용 · 호스트 허용목록(기본 coupangcdn.com,
 * env THUMB_URL_HOST_ALLOW csv로 확장) · 리다이렉트 거부(허용목록 우회 차단)
 * · content-type image/* · 5MB 상한 · 10s 타임아웃
 */

const THUMB_URL_MAX_BYTES = 5 * 1024 * 1024; // 프론트 직접 업로드와 동일 상한
const THUMB_URL_TIMEOUT_MS = 10000;

function _allowedHosts() {
  return (process.env.THUMB_URL_HOST_ALLOW || 'coupangcdn.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// https + 허용 호스트(정확일치 또는 그 서브도메인)만 통과
function thumbUrlAllowed(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return _allowedHosts().some((h) => host === h || host.endsWith('.' + h));
}

// → { base64, mimeType }  (실패는 사용자 표시 가능한 한국어 메시지로 throw)
async function fetchThumbFromUrl(url) {
  const target = String(url || '').trim();
  if (!thumbUrlAllowed(target)) {
    throw new Error('허용되지 않은 이미지 URL입니다. 쿠팡 이미지 주소(coupangcdn.com)만 지원합니다.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), THUMB_URL_TIMEOUT_MS);
  try {
    const resp = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
      signal: ctrl.signal,
      redirect: 'manual',
    });
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error('리다이렉트하는 URL은 지원하지 않습니다. 최종 이미지 주소를 붙여넣으세요.');
    }
    if (!resp.ok) throw new Error(`이미지를 가져오지 못했습니다 (HTTP ${resp.status})`);
    const ctype = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ctype.startsWith('image/')) throw new Error(`이미지가 아닙니다 (${ctype || 'content-type 없음'})`);
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > THUMB_URL_MAX_BYTES) throw new Error('이미지는 5MB 이하만 가능합니다.');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('빈 이미지 응답입니다.');
    if (buf.length > THUMB_URL_MAX_BYTES) throw new Error('이미지는 5MB 이하만 가능합니다.'); // content-length 부재·거짓 대비
    return { base64: buf.toString('base64'), mimeType: ctype };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('이미지 요청이 시간을 초과했습니다(10초).');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { thumbUrlAllowed, fetchThumbFromUrl, THUMB_URL_MAX_BYTES };
