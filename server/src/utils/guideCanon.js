/**
 * guideCanon — 선택지별 유입가이드를 "같은 글 + 같은 사진 + 같은 사진 자리" 로 비교하는 규칙(결정 263 · 결정 272 D4).
 *
 * 같은 가이드가 세 모양으로 저장된다:
 *   ㉮ 작업오더(인트라넷)        `guide: { text, images[] }` — 글 속 **사진 주소 한 줄 = 그 자리에 사진**(D4 「나」)
 *   ㉯ 서버 투영(`composeUnitGuide`) HTML(글 + 주소 줄 자리의 <img>) + images[]
 *   ㉰ 공고 창 저장(`_ugCompose`)  HTML(글 + 자리의 <img> + 끝에 <img>) + images[]  (같은 사진이 두 번)
 * 리뷰어 화면은 셋 다 "HTML 그대로 → 남은 목록 사진" 으로 그린다(campaign-workdetail: 겹치면 한 번).
 * 그래서 비교는 글자 모양이 아니라 **{글·사진이 놓인 차례, 사진 목록}** 으로 한다.
 *
 * ★ 사용자 확정(2026-10-22 D4 「나」): 사진 자리는 새 저장 칸 없이 **글 속 사진 주소 한 줄**로 둔다.
 *   - 맨 끝(뒤에 글이 없는) 사진은 자리 표시를 하지 않는다 = "글 + 사진 목록" 과 같다(옛 모양과 열쇠가 같다 — 운영 실측
 *     2026-10-20: 진행 중 선택지 가이드 21개 중 사진이 글 중간에 낀 것 0 → 이 규칙으로 바뀌는 기존 비교 결과 0).
 *   - 옛 화면이 주소 줄을 지우면 그 사진은 목록에만 남아 맨 끝으로 간다(사라지지 않는다 — 안전한 쪽).
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

/** 비교용 자리 표시 — 사람이 칠 일이 없는 괄호(어긋난 공고 정리 화면에도 이 모양으로 보인다). */
const MARK = n => `\u27e6사진 ${n}\u27e7`;

/**
 * 공고 저장 모양(HTML + 사진 목록) → 차례(글 조각 · 사진)와 사진 목록.
 * 사진 = HTML 속 사진(나온 자리) 뒤에 목록 사진(파일 id 로 겹침 제거 — 겹치면 앞의 자리가 이긴다).
 */
function _sequence(html, images) {
  const s = String(html == null ? '' : html);
  const seq = [], imgs = [], seen = new Set();
  const addImg = (u) => {
    const v = String(u || '').trim();
    const id = _imgId(v);
    if (!id || seen.has(id)) return;
    seen.add(id);
    imgs.push(v);
    seq.push({ img: imgs.length - 1 });
  };
  const addText = (chunk) => { const t = guideHtmlText(chunk); if (t) seq.push({ text: t }); };
  const re = /<img\b[^>]*>/gi;
  let last = 0, m;
  while ((m = re.exec(s))) {
    addText(s.slice(last, m.index));
    last = re.lastIndex;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (src) addImg(_decode(src[1]));
  }
  addText(s.slice(last));
  (Array.isArray(images) ? images : []).forEach(addImg);
  return { seq, imgs };
}

/**
 * 공고 저장 모양(HTML + 사진 목록) → {text, images, view}.
 *   text   = 오더에 싣는 글 — 뒤에 글이 이어지는 사진은 그 자리에 **사진 주소 한 줄**, 맨 끝 사진들은 목록에만
 *   images = 사진 목록(나온 차례)
 *   view   = 비교·표시용 글 — 주소 대신 「⟦사진 N⟧」(호스트가 달라도 같은 사진이면 같은 글)
 * ★ 장수는 자르지 않는다 — 5장째가 다르면 다른 가이드다. 저장 쪽 상한(4장)은 각 저장 경로가 지킨다.
 * ★ 글 속에 사진 주소를 직접 적어 둔 경우(인트라넷 옛 방식) HTML 투영이 그 자리에 <img> 를 넣으므로 여기서도 그 자리 사진으로 센다.
 */
function canonGuide(html, images) {
  const { seq, imgs } = _sequence(html, images);
  let lastText = -1;
  seq.forEach((x, i) => { if (x.text !== undefined) lastText = i; });
  const text = [], view = [];
  seq.forEach((x, i) => {
    if (x.text !== undefined) { text.push(x.text); view.push(x.text); return; }
    if (i > lastText) return;                       // 맨 끝 사진 = 목록에만(자리 표시 없음)
    text.push(imgs[x.img]);
    view.push(MARK(x.img + 1));
  });
  return { text: text.join('\n'), images: imgs, view: view.join('\n') };
}

/** 비교 열쇠 — 글(사진 자리 포함) + 사진 파일 id. 빈 가이드 = ''. */
function canonGuideKey(html, images) {
  const g = canonGuide(html, images);
  if (!g.view && !g.images.length) return '';
  return JSON.stringify([g.view, g.images.map(_imgId)]);
}

module.exports = { guideHtmlText, guideHtmlImages, canonGuide, canonGuideKey, imageKey: _imgId, GUIDE_IMG_MAX: MAX };
