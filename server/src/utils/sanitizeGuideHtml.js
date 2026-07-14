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

/** work_detail JSONB 스냅샷 전체를 응답 직전에 정화(HTML 필드만) */
function sanitizeWorkDetail(wd) {
  if (!wd || typeof wd !== 'object') return null;
  return {
    ...wd,
    inflowGuideHtml: sanitizeGuideHtml(wd.inflowGuideHtml),
  };
}

module.exports = { sanitizeGuideHtml, sanitizeWorkDetail, GUIDE_SANITIZE_OPTS };
