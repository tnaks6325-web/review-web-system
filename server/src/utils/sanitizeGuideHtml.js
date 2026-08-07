/**
 * sanitizeGuideHtml — 유입가이드/리뷰가이드 HTML 정화 (PRD §03-E)
 *
 * 관리자·AE 입력 HTML(work_orders.inflow_guide 등)이 처음으로 무인증 리뷰어 표면
 * (참여형 캠페인 work-detail)에 노출되므로, 검증된 라이브러리(sanitize-html)로
 * 태그·속성·스킴을 화이트리스트 정화한다. 정규식 수작업 sanitizer 금지.
 *
 * 적용 시점 이중화: ① 발행 시 스냅샷 복사 직후(M3, 저장) ② 응답 직전(방어적 재적용).
 */
const sanitizeHtml = require('sanitize-html');

const GUIDE_SANITIZE_OPTS = {
  allowedTags: ['p', 'br', 'img', 'a', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'div', 'span'],
  allowedAttributes: {
    a: ['href', 'rel', 'target'],
    img: ['src', 'alt', 'width', 'height'],
  },
  // https 절대 URL + 상대경로(/api/order/guide-image/… 프록시)만 통과. http/javascript/data 차단.
  allowedSchemes: ['https'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

function sanitizeGuideHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), GUIDE_SANITIZE_OPTS);
}

/* ══════════════════════════════════════════════════════════════════════
   작업내용 첨부 이미지 배열 (리뷰가이드·특이사항)
   ─────────────────────────────────────────────────────────────────────
   ★ 왜 배열인가: reviewGuide·specialNotes 는 **평문** 필드다(화면에서 escape).
     HTML 필드로 승격하면 기존 저장분의 '<옵션>' 같은 꺾쇠 글자가 태그로 오인돼
     통째로 삭제된다(이 레포가 이미 겪은 함정 — 그래서 "평문은 escape 후 <br>"로 굳혔다).
     그래서 텍스트 칸은 건드리지 않고 **사진만 배열로 옆에** 둔다.
   ★ work_detail 은 JSONB 통째 저장이라 검증 없이 넣으면 **임의 주소가 리뷰어 화면의
     <img src> 로 그대로 나간다** → 우리 프록시 주소만 통과시킨다(정확일치).
     규칙 모양은 리뷰어 1:1문의 첨부(reviewer.routes)·관리자 답장(cs.routes)과 동일.
   ★ 화면(칸당 4장)만 믿지 않고 서버가 다시 센다.
   ══════════════════════════════════════════════════════════════════════ */
const GUIDE_IMAGE_FIELDS = ['reviewGuideImages', 'specialNotesImages'];
const GUIDE_IMAGE_MAX = 4;
// 우리 서버의 guide-image 프록시 주소만. http? 허용은 위 두 소비처와 같은 규칙(스킴을 여기서만
// 좁히면 PUBLIC_API_URL 이 http 인 배포에서 첨부가 조용히 사라진다).
const GUIDE_IMAGE_URL_RE = /^https?:\/\/[^\s"'<>]+\/api\/order\/guide-image\/[-\w]{20,}$/;

/** 첨부 이미지 배열 정화 — 우리 프록시 주소만 · 파일ID 중복 제거 · 상한 4장. 배열이 아니면 []. */
function sanitizeGuideImages(v) {
  if (!Array.isArray(v)) return [];
  const out = [], seen = new Set();
  for (const raw of v) {
    if (out.length >= GUIDE_IMAGE_MAX) break;
    const s = String(raw == null ? '' : raw).trim();
    if (!GUIDE_IMAGE_URL_RE.test(s)) continue;
    // 중복 판정은 파일ID 토큰 기준 — 같은 사진이 호스트만 다른 주소(pages↔railway)로 두 번 오지 않게
    const tok = s.slice(s.lastIndexOf('/') + 1);
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(s);
  }
  return out;
}

/** work_detail JSONB 스냅샷 전체를 응답 직전에 정화(HTML 필드 + 첨부 이미지 배열) */
function sanitizeWorkDetail(wd) {
  if (!wd || typeof wd !== 'object') return null;
  const out = { ...wd, inflowGuideHtml: sanitizeGuideHtml(wd.inflowGuideHtml) };
  // ★ 필드가 아예 없으면 만들지 않는다 — 옛 스냅샷에 빈 배열을 새로 심지 않기 위해(무변경 보장)
  for (const f of GUIDE_IMAGE_FIELDS) {
    if (out[f] !== undefined) out[f] = sanitizeGuideImages(out[f]);
  }
  return out;
}

module.exports = {
  sanitizeGuideHtml, sanitizeWorkDetail, sanitizeGuideImages,
  GUIDE_SANITIZE_OPTS, GUIDE_IMAGE_FIELDS, GUIDE_IMAGE_MAX, GUIDE_IMAGE_URL_RE,
};
