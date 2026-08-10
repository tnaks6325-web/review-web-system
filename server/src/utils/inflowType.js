/**
 * inflowType.js — **유입방식(링크유입 / 가이드유입) 판정의 단일 출처**.
 *
 * 배경(PRD frontend/docs/prd-option-landing-url.html · D1 확정 2026-08-10):
 *   종전에는 공고에 유입방식 칸이 없어 **연결 작업오더를 역조회**(`_lookupInflowType`)해야만
 *   알 수 있었고, 작업오더 없이 수동 생성한 공고는 **영영 불명**이었다. 불명이면
 *   "옵션 링크 필수"도 "가이드유입이면 비활성"도 걸리지 않는다 → 공고에 칸을 신설한다
 *   (`recruit_campaigns.inflow_type`, migration 101).
 *
 * ★★ 판정 순서 = **공고 값 → 작업오더 역조회 → 빈 값(불명)**.
 *   공고 값이 있으면 그것이 최종이다(사람이 화면에서 고른 값 > 오더 파생값).
 *
 * ★★ **불명을 추측하지 않는다** — 빈 값을 'link'/'guide' 로 접으면
 *   ① 가이드유입 공고에 [상품 페이지 열기] 버튼이 살아나 유입가이드가 통째로 무의미해지거나
 *   ② 링크유입 공고의 옵션 링크 칸이 조용히 잠긴다. 소비처가 "불명 = 아무 것도 하지 않음"을
 *   그대로 다룰 수 있어야 한다.
 *
 * ★ 리뷰어 화면(`campaign-workdetail.js`)의 **"불명 + 가이드 내용 있음 = 가이드유입"** 폴백은
 *   여기로 옮기지 않는다 — 그건 *렌더 재료(가이드 본문)* 가 있어야 성립하는 화면 판정이고,
 *   서버는 그 본문을 판정 재료로 쓰지 않는다(무회귀).
 */

const INFLOW_TYPES = ['link', 'guide'];

/**
 * 자유 문자열 → 표준 값.
 * 인트라넷은 `'link'`/`'guide'` 코드로 보내지만(`reviewOrderInflowTypeCode`),
 * 과거 데이터·수기 입력에 한국어가 섞일 수 있어 함께 받는다.
 * @returns {string} 'link' | 'guide' | '' (모르면 빈 값 — 추측 금지)
 */
function normalizeInflowType(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'link' || low === 'guide') return low;
  if (/링크/.test(s)) return 'link';
  if (/가이드/.test(s)) return 'guide';
  return '';
}

/**
 * 저장용 정규화 — **`''` 를 `''` 로 남긴다**(099 `workKindForStore` 와 같은 규율).
 * "안 보냈다"와 "가이드로 정했다"가 같아지면 CASE 센티널 편집(null=유지 / ''=해제)이 무너진다.
 */
function inflowTypeForStore(v) {
  if (v == null) return null;                 // 미전송 = 변경 없음(호출부가 CASE 로 처리)
  const s = String(v).trim();
  if (!s) return '';                          // 명시적 해제
  return normalizeInflowType(s);              // 모르는 값은 '' = 해제로 수렴(쓰레기 저장 금지)
}

/**
 * 공고 값 → 작업오더 값 순으로 판정.
 * @param {object} ctx
 * @param {string} [ctx.campaignInflowType]  recruit_campaigns.inflow_type
 * @param {string} [ctx.orderInflowType]     연결 작업오더의 work_orders.inflow_type(역조회 결과)
 * @returns {string} 'link' | 'guide' | '' (불명)
 */
function resolveInflowType(ctx) {
  const c = ctx || {};
  const own = normalizeInflowType(c.campaignInflowType);
  if (own) return own;
  return normalizeInflowType(c.orderInflowType);
}

/** 화면 라벨(관리자 버튼군·안내 문구 공용). 불명은 '미지정'. */
function inflowTypeLabel(v) {
  const t = normalizeInflowType(v);
  if (t === 'link') return '링크유입';
  if (t === 'guide') return '유입가이드';
  return '미지정';
}

module.exports = {
  INFLOW_TYPES,
  normalizeInflowType,
  inflowTypeForStore,
  resolveInflowType,
  inflowTypeLabel,
};
