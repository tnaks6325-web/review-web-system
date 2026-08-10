/**
 * optionUrlChannels.js — **"이 채널에 옵션별 주소가 있는가" 판정의 단일 출처**.
 *
 * 배경(사용자 확정 2026-08-10, PRD frontend/docs/prd-option-landing-url.html 보충 ㉮):
 *   쿠팡은 옵션마다 고유 주소가 생기지만 **네이버(스마트스토어)는 옵션이 여러 개여도
 *   상품 주소가 하나**다. 그래서 네이버 작업에서는 옵션별 유입 링크 칸을 **비활성**하고
 *   "이 채널은 옵션별 주소가 없어 상품 URL 하나로 안내합니다"라고 화면이 말한다.
 *
 * ★★ 채널 목록 사본을 만들지 않는다 — 표는 `utils/cashReceiptChannels.js` 4종 하나뿐이고
 *   여기에는 **플래그 한 칸**만 얹는다(현영 안내 이미지가 2슬롯에 머물러 조용히 비어 나갔던
 *   실측 사고가 정확히 "채널 목록 사본" 때문이었다).
 *
 * ★★ **채널을 모르면 비활성하지 않는다(fail-open)** — 추정으로 입력을 잠그면 쿠팡 작업의
 *   옵션 링크를 못 넣게 된다. 옵션 링크 미입력은 어차피 **경고 전용**(D2 확정)이라
 *   빈 칸이 발행을 막지도 않는다.
 */

const { cashReceiptChannelKey, cashReceiptChannelLabel } = require('./cashReceiptChannels');

/**
 * 채널 key → 옵션별 주소 지원 여부.
 * ★ 목록에 없는 key 는 **지원함(true)** 으로 본다(fail-open) — 새 채널이 생겼을 때
 *   조용히 칸이 잠기는 쪽보다 열려 있는 쪽이 안전하다.
 * ★ 값을 바꿀 때는 "그 채널에서 옵션마다 다른 URL을 실제로 만들 수 있는가"만 본다.
 */
const OPTION_URL_SUPPORT = {
  coupang: true,
  naver: false,       // 스마트스토어 = 옵션이 달라도 상품 주소 하나(사용자 확정 2026-08-10)
  oliveyoung: true,
  kakao: true,
};

/**
 * 공고/작업오더의 채널 문자열(버튼값 또는 직접입력) → 옵션별 URL 지원 여부.
 * @param {string} channel  '쿠팡' · '네이버' · 커스텀 문자열 · 빈 값
 * @returns {boolean} 지원 여부. **채널 미상은 true**(fail-open).
 */
function supportsOptionUrl(channel) {
  const key = cashReceiptChannelKey(channel);
  if (!key) return true;                                   // 모르면 잠그지 않는다
  return OPTION_URL_SUPPORT[key] !== false;
}

/**
 * 비활성 사유 문구 — 화면(리뷰웹 표 · 인트라넷 옵션 행)이 같은 문장을 쓰게 한다.
 * @returns {string|null} 지원하면 null(= 안내할 것이 없음).
 */
function optionUrlUnsupportedNote(channel) {
  if (supportsOptionUrl(channel)) return null;
  const key = cashReceiptChannelKey(channel);
  return `${cashReceiptChannelLabel(key)}는 옵션별 주소가 없어 상품 URL 하나로 안내합니다.`;
}

module.exports = {
  OPTION_URL_SUPPORT,
  supportsOptionUrl,
  optionUrlUnsupportedNote,
};
