/**
 * optionLanding.js — **"리뷰어에게 어떤 상품 주소를 열어줄 것인가" 판정의 단일 출처**.
 *
 * 배경(PRD frontend/docs/prd-option-landing-url.html v1.0):
 *   옵션이 3종인 링크유입 작업에서 화이트를 고른 리뷰어도 베이지를 고른 리뷰어도
 *   `recruit_campaigns.landing_url` **한 칸**으로 들어갔다. migration 101 이
 *   `campaign_options.landing_url` 을 만들었고, 그 값을 **누가 언제 쓰는가**를 여기서만 정한다.
 *
 * ★★ 판정 순서 = **고른 옵션의 URL → 공고 랜딩 URL(= 첫 상품 URL 파생) → 빈 값**.
 *   소비처가 셋(① work-detail 응답 ② 관리자 미리보기 `/admin/:id/preview` ③ 발행 모달 미리보기)
 *   이라 규칙을 화면마다 만들면 **"미리보기 ≠ 실제 화면"** 이 되살아난다(공용 렌더러로 없앤 문제).
 *
 * ★★ **참여 시점 스냅샷을 뜨지 않는다** — 리뷰비(082)와 다르다. 링크는 "그 건에 얼마를 줬나"가
 *   아니라 "지금 어디로 가야 하나"라서 **최신값이 맞다**(관리자가 주소를 고치면 즉시 반영).
 *
 * ★ **URL 위생은 여기 한 곳** — 저장(칸 검증)과 표시(버튼 렌더)가 같은 함수를 통과해야
 *   `javascript:` 류가 어느 한쪽으로 새지 않는다. 리뷰어 화면은 이미 `^https?://` 만 여는데,
 *   저장 시점에도 같은 검증을 걸어 오타를 조기에 드러낸다.
 *
 * 킬스위치 `CAMPAIGN_OPTION_LANDING=0` → 옵션 URL을 **읽지 않는다**(항상 공고 랜딩 URL) =
 *   코드 변경 없이 종전 동작 복귀(082·095 규율).
 */

const OPTION_LANDING_ENABLED = process.env.CAMPAIGN_OPTION_LANDING !== '0';

/**
 * 저장·표시 공용 URL 위생.
 * @returns {string} 통과하면 트림된 원문, 아니면 **빈 문자열**(조용히 다른 값으로 바꾸지 않는다).
 */
function sanitizeLandingUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/** 화면에 "왜 안 들어갔는지"를 말하기 위한 사유(조용히 버리지 않는다). */
function landingUrlError(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;                                  // 빈 값은 오류가 아니다(선택 입력)
  if (!/^https?:\/\//i.test(s)) return 'https:// 로 시작하는 주소만 저장됩니다.';
  return null;
}

/**
 * 리뷰어가 열 주소를 고른다.
 * @param {object} ctx
 * @param {string} [ctx.optionLandingUrl]  그 리뷰어가 고른 옵션의 campaign_options.landing_url
 * @param {string} [ctx.campaignLandingUrl] recruit_campaigns.landing_url(진행상품 표 첫 상품 URL 파생)
 * @returns {string} 열 주소(없으면 빈 문자열 = 버튼 미노출)
 */
function resolveLandingUrl(ctx) {
  const c = ctx || {};
  if (OPTION_LANDING_ENABLED) {
    const opt = sanitizeLandingUrl(c.optionLandingUrl);
    if (opt) return opt;
  }
  return sanitizeLandingUrl(c.campaignLandingUrl);
}

/**
 * 진행상품 표 → 공고 랜딩 URL 파생(D3·D5 확정).
 * ★ **첫 상품의 URL** 하나만 쓴다. 상품이 2개 이상이고 주소가 서로 다르면 호출부가 경고를 띄우되
 *   **막지는 않는다**(리뷰어에게는 어차피 하나만 열린다는 사실을 말해 주는 것이 목적).
 * @param {Array<{landingUrl?:string, url?:string}>} productRows
 * @returns {{url:string, multiDistinct:boolean}}
 */
function deriveCampaignLandingUrl(productRows) {
  const urls = (Array.isArray(productRows) ? productRows : [])
    .map(r => sanitizeLandingUrl(r && (r.landingUrl != null ? r.landingUrl : r.url)))
    .filter(Boolean);
  const distinct = new Set(urls);
  return { url: urls[0] || '', multiDistinct: distinct.size > 1 };
}

module.exports = {
  OPTION_LANDING_ENABLED,
  sanitizeLandingUrl,
  landingUrlError,
  resolveLandingUrl,
  deriveCampaignLandingUrl,
};
