/**
 * guideCanon — 선택지별 유입가이드를 "같은 글 + 같은 사진" 으로 비교하는 규칙(결정 263 · 양방향 6단계).
 *
 * 같은 가이드가 세 모양으로 저장된다:
 *   ㉮ 작업오더(인트라넷)        `guide: { text, images[] }`
 *   ㉯ 서버 투영(`composeUnitGuide`) HTML(글만 — 사진은 목록) + images[]
 *   ㉰ 공고 창 저장(`_ugCompose`)  HTML(글 + 끝에 <img>) + images[]  (같은 사진이 두 번)
 * 리뷰어 화면은 셋 다 "글 → 사진" 으로 똑같이 그린다(campaign-workdetail: HTML 뒤에 목록 사진, 겹치면 한 번).
 * 그래서 비교는 글자 모양이 아니라 **{글, 사진 목록}** 으로 한다 — 모양 차이를 "다름" 으로 세면 연결 판정·창 보호가 헛돈다.
 *
 * ★ 사용자 확정(2026-10-20 「1번」): 6단계는 지금 두 편집 화면의 모양(글 칸 + 사진은 글 아래 · 최대 4장)으로 맞춘다.
 *   사진 자리를 고르는 형식(D4 블록 문서)은 마지막 공고 창 전면 개편 때. 운영 실측: 진행 중 선택지 가이드 21개 중
 *   서식(굵게·링크) 0 · 사진이 글 중간에 낀 것 0 · 사진 2장 이상 0.
 * ★ 사진은 파일 id 로 비교한다(http/https·호스트가 달라도 같은 파일이면 같다). 순서는 의미가 있어 그대로.
 * ★ 순수 모듈 — DB 없음.
 */
'use strict';

const IMG_ID_RE = /\/api\/order\/guide-image\/([-\w]{20,})(?=$|[?#])/;
const DRIVE_ID_RE = /(?:drive\.google\.com\/(?:thumbnail\?id=|file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)|googleusercontent\.com\/d\/)([-\w]{20,})/;
const MAX = 4;

function _decode(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

/** 가이드 HTML → 글(사진·태그 제거 · 줄바꿈 유지 · 앞뒤 공백 정리). */
function guideHtmlText(html) {
  const s = String(html == null ? '' : html);
  if (!s.trim()) return '';
  const text = s
    .replace(/<img\b[^>]*>/gi, '')
    // 링크는 글자만 남기면 주소가 사라진다 — 주소가 글자와 다르면 "글자 (주소)" 로(리뷰어가 누르는 곳이 달라지면 다른 가이드다 · 검토 2026-10-20)
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m0, href, inner) => {
      const t = inner.replace(/<[^>]+>/g, '');
      return _decode(t).trim() === _decode(href).trim() ? t : `${t} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return _decode(text).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML 안 <img> 주소들(나온 순서) — 우리 프록시뿐 아니라 드라이브 썸네일·다른 주소도(리뷰어에게 보이는 사진이면 다 센다). */
function guideHtmlImages(html) {
  const out = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html == null ? '' : html)))) { const u = _decode(m[1]).trim(); if (u) out.push(u); }
  return out;
}

/** 사진 비교 열쇠 — 우리 프록시는 파일 id, 드라이브는 d:파일 id, 그 밖은 주소 그대로(x:). */
function _imgId(u) {
  const s = String(u || '').trim();
  let m = IMG_ID_RE.exec(s); if (m) return m[1];
  m = DRIVE_ID_RE.exec(s); if (m) return 'd:' + m[1];
  return s ? 'x:' + s : '';
}

/**
 * 공고 저장 모양(HTML + 사진 목록) → {text, images}. 사진 = HTML 속 사진 뒤에 목록 사진(파일 id 로 겹침 제거).
 * ★ 장수는 자르지 않는다 — 5장째가 다르면 다른 가이드다. 저장 쪽 상한(4장)은 각 저장 경로가 지킨다.
 * ★ 글 속에 사진 주소를 직접 적어 둔 경우(인트라넷 옛 방식) HTML 투영이 그 자리에 <img> 를 넣으므로 여기서도 사진으로 센다.
 */
function canonGuide(html, images) {
  const urls = [...guideHtmlImages(html), ...(Array.isArray(images) ? images : [])];
  const seen = new Set();
  const imgs = [];
  for (const u of urls) {
    const id = _imgId(u);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    imgs.push(String(u).trim());
  }
  return { text: guideHtmlText(html), images: imgs };
}

/** 비교 열쇠 — 글 + 사진 파일 id. 빈 가이드 = ''. */
function canonGuideKey(html, images) {
  const g = canonGuide(html, images);
  if (!g.text && !g.images.length) return '';
  return JSON.stringify([g.text, g.images.map(_imgId)]);
}

module.exports = { guideHtmlText, guideHtmlImages, canonGuide, canonGuideKey, imageKey: _imgId, GUIDE_IMG_MAX: MAX };
