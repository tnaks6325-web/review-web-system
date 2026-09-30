/**
 * campaignProductLines.js — 모집공고 진행상품 표에서 **1건당 상품 결제금액**을 읽는 규칙(단일 출처)
 *
 * 저장 위치: `recruit_campaigns.work_detail.productLines`(작업내용 상품 원문, 텍스트).
 * 그 텍스트를 **만드는 쪽**은 발행·수정 폼의 `_syncPreviewFromOptRows`
 * (frontend/js/index-recruit.js) 하나이고 형식이 고정돼 있다:
 *
 *     상품명 - 옵션명 - 결제금액 52,200원
 *     상품명 - 결제금액 52,200원
 *     결제금액 52,200원
 *
 * ★★ 여기는 **읽는 쪽 단일 출처**다 — 소비처가 늘어도 정규식을 각자 적지 않는다.
 *    회귀가드(`tests/workboardTopC.test.js`)가 **쓰는 쪽 형식 ≡ 여기 정규식**을 대조한다.
 *    그 형식이 바뀌면 그 자리에서 빨개진다.
 *
 * ★ 작업오더 상품정보를 읽는 `_woFirstProductInfo`(frontend/js/work-order-detail.js)와
 *   정규식이 닮았지만 **다른 텍스트의 다른 소유자**다(저쪽 = 인트라넷이 만든 발주 요약,
 *   이쪽 = 우리 발행 폼이 만든 공고 원문). 한쪽 형식이 바뀌어도 다른 쪽이 따라가지 않는다.
 *
 * ★ 상품 줄이 여러 개면 **첫 줄 금액**(작업 조건 카드가 작업오더에서 읽을 때와 같은 규칙).
 * ★ 못 읽으면 **null — 지어내지 않는다**(총액÷건수 같은 역산 금지).
 */

/** `결제금액 52,200원` — 천 단위 구분과 사이 공백을 허용한다. */
const PRODUCT_LINE_PAY_RE = /결제금액\s*([\d,]+)\s*원/;

/**
 * 공고 상품 원문에서 첫 번째 1건당 결제금액을 읽는다.
 * @param {string|null|undefined} text `work_detail.productLines`
 * @returns {number|null} 양수 금액, 못 읽으면 null
 */
function firstPayAmountFromProductLines(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  const m = s.match(PRODUCT_LINE_PAY_RE);
  if (!m) return null;
  const v = Number(String(m[1]).replace(/[^0-9]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

module.exports = { firstPayAmountFromProductLines, PRODUCT_LINE_PAY_RE };
