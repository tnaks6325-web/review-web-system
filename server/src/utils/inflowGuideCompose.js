/**
 * inflowGuideCompose — 작업오더의 유입가이드(평문 + 첨부 주소) → 모집공고 저장 형태(HTML + 사진 목록)
 *
 * ★★ 이 규칙은 원래 **화면 쪽에만** 있었다(`frontend/js/work-order-detail.js` 의
 *    `_woCleanGuide` / `_woPlainGuideToHtml` / `_woUnitGuide`) — 발행 프리필이 쓰는 그 규칙이다.
 *    접수 뒤 인트라넷에서 유입방식·가이드를 고치면 **서버가 공고까지 바꿔야** 리뷰어 화면이
 *    따라오므로(공고 저장값이 작업오더 폴백을 이긴다) 서버에도 같은 규칙이 필요해졌다.
 *
 * ★★★ **사본이 둘이 되는 자리다 — 회귀가드가 두 구현을 같은 픽스처로 실행해 출력이
 *      한 글자도 다르지 않은지 대조한다**(`tests/inflowSourceEdit.test.js`).
 *      한쪽만 고치면 "발행할 땐 사진이 뜨는데 인트라넷에서 고치면 주소 글자만" 으로 갈린다
 *      (workManager 닉네임 사본·날짜 키워드 사본과 같은 규율).
 *
 * ★ 첨부는 **우리 프록시 주소(https)만** 인정한다 — 임의 호스트가 리뷰어 화면의 `<img src>` 로
 *   그대로 나가는 경로를 만들지 않는다(서버 정화가 최종 방어지만 여기서도 좁힌다).
 */

const UNIT_GUIDE_IMG_MAX = 4;

/** 우리 guide-image 프록시 절대 주소(https)만 — 화면 쪽 `_woUnitGuide` 와 같은 정규식. */
const PROXY_IMAGE_RE = /^https:\/\/\S*\/api\/order\/guide-image\/[-\w]{20,}$/;

/** 구글 드라이브 파일 id 추출 — 화면 쪽 `_driveId` 와 같은 규칙. */
function driveId(url) {
  const s = String(url);
  const m = s.match(/\/file\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/\/d\/([-\w]{20,})/);
  return m ? m[1] : null;
}

/** 유입가이드 본문 정리: 첨부 이미지 머리말 줄과 "1. xxx.png (…저장됨)" 파일정보 줄 제거. */
function cleanGuideText(raw) {
  if (!raw || !String(raw).trim()) return '';
  return String(raw).split(/\r?\n/)
    .filter(ln => !/^\s*\[유입가이드\s*첨부\s*이미지\]\s*$/.test(ln))
    .filter(ln => !/^\s*\d+\.\s.*\(.*저장됨\)\s*$/.test(ln))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 평문 유입가이드 → 리뷰어 노출용 HTML.
 * ★ 사진이 하나도 없으면 **빈 문자열**을 돌려준다(설계상 이미지 승격 전용) — 호출부가 그때
 *   글자만 escape 해 보존한다. 이 계약을 바꾸면 화면 쪽과 결과가 갈린다.
 */
function plainGuideToHtml(raw) {
  const cleaned = cleanGuideText(raw);
  if (!cleaned.trim()) return '';
  const parts = cleaned.split(/(https?:\/\/[^\s<]+)/g);
  let html = '';
  let hasImg = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const url = parts[i];
      const isProxy = /\/api\/order\/guide-image\/[-\w]{20,}/.test(url);
      const id = driveId(url);
      if (isProxy) { html += '<img src="' + esc(url) + '" alt="유입가이드 이미지">'; hasImg = true; }
      else if (id) { html += '<img src="https://drive.google.com/thumbnail?id=' + id + '&sz=w1600" alt="유입가이드 이미지">'; hasImg = true; }
      else html += '<a href="' + esc(url) + '">' + esc(url) + '</a>';
    } else {
      html += esc(parts[i]).replace(/\n/g, '<br>');
    }
  }
  return hasImg ? html : '';
}

/**
 * 선택지(옵션 · 옵션 없는 상품) 하나의 유입가이드를 공고 저장 형태로 정규화.
 * @returns {{html:string, images:string[]}} 값이 없으면 {html:'', images:[]} = 공통 가이드로 접힘
 */
function composeUnitGuide(src) {
  const s = src || {};
  const g = s.guide;
  const gObj = (g && typeof g === 'object' && !Array.isArray(g)) ? g : null;
  const raw = String((gObj ? gObj.text : g) ?? s.inflow_guide ?? s.inflowGuide ?? '');
  let html = '';
  if (raw.trim()) {
    html = /<[a-z][^>]*>/i.test(raw)
      ? raw
      : (plainGuideToHtml(raw)
        || raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/\n/g, '<br>'));
  }
  const list = (gObj && gObj.images) ?? s.guide_images ?? s.guideImages ?? s.inflow_guide_images ?? [];
  const images = [];
  (Array.isArray(list) ? list : []).forEach(u => {
    const v = String(u || '').trim();
    if (!PROXY_IMAGE_RE.test(v)) return;
    if (images.indexOf(v) < 0 && images.length < UNIT_GUIDE_IMG_MAX) images.push(v);
  });
  return { html, images };
}

/**
 * 옵션 없는 상품(= 그 상품 자체가 선택지 하나)의 가이드 원본 — 화면 쪽 `_woProductUnitSrc` 와 같다.
 * ★ `prod.base` 는 {pay,count,daily} 라 항상 존재하므로 `prod.base || prod` 로 읽으면
 *   **상품 단위 가이드가 통째로 유실**된다. 옛 초안이 base 에 실어 보낸 경우에만 base 를 본다.
 */
function productUnitSrc(prod) {
  const p = prod || {};
  const base = p.base;
  if (base && typeof base === 'object' && (base.guide || base.inflow_guide || base.guide_images)) return base;
  return p;
}

/**
 * 첨부 목록 정규화 — 배열이면 그대로, JSON 배열 문자열이면 파싱.
 * ★ 서버 전용 확장이다 — `work_orders.guide_images` 가 **TEXT(JSON 배열 문자열)** 이기 때문.
 *   화면 쪽 `_woUnitGuide` 는 항상 배열을 받으므로 이 분기가 없다(사본 대조는 배열 입력으로 한다).
 */
function toImageList(v) {
  if (Array.isArray(v)) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

/**
 * 공고 **공통** 유입가이드(`work_detail.inflowGuideHtml`) 조립.
 *
 * ★★ 발행 프리필의 `_woBuildInflowHtml`(화면)보다 **일부러 좁다** — 그쪽은 리뷰가이드 칸에
 *    섞여 온 사진까지 유입가이드로 끌어올리는 보정을 한다. 전파는 "인트라넷이 방금 고친
 *    유입가이드 칸"만 반영하면 되므로 그 보정을 하지 않는다(가져오는 범위가 좁은 = 안전한 쪽).
 *    회귀가드가 이 차이를 고정한다 — 넓히면 리뷰가이드 사진이 유입가이드로 새어 든다.
 * @returns {string} HTML(빈 가이드면 '')
 */
function composeCommonGuide(text, images) {
  const unit = composeUnitGuide({ guide: { text, images: toImageList(images) } });
  let html = unit.html;
  unit.images.forEach(u => {
    if (html.indexOf(u) >= 0) return;   // 글 안에서 이미 <img> 로 승격된 사진은 두 번 그리지 않는다
    html += '<img src="' + esc(u) + '" alt="유입가이드 이미지">';
  });
  return html;
}

module.exports = {
  UNIT_GUIDE_IMG_MAX, PROXY_IMAGE_RE,
  driveId, cleanGuideText, plainGuideToHtml, composeUnitGuide, composeCommonGuide, productUnitSrc, toImageList,
};
