/**
 * reviewSampleChannels.js — 리뷰 판별 **예시이미지** 슬롯의 단일 출처.
 *
 * 채널별 리뷰 화면은 생김새가 전혀 달라(쿠팡만 주황 별점, 나머지는 전부 빨강),
 * 문장 설명만으로는 AI가 헷갈린다. "이런 화면이 정상 리뷰"의 실물을 함께 보여주면
 * 판별 정확도가 올라간다(few-shot).
 *
 * ★ 같은 채널이라도 PC/모바일 레이아웃이 전혀 다르므로 **화면 유형마다** 등록한다.
 * ★ `kakao_feed` 는 별점이 없는 화면이라 특히 중요 — 이 예시가 없으면 정상 카카오 리뷰가
 *   `other` 로 오판된다(그래서 카카오는 채널 전체가 1차 잠금 제외다).
 * ★ key 는 `app_settings` 키(`review_inspect_sample_<key>`)이자 DOM id 접미사와 1:1 —
 *   **한 번 정한 key 는 바꾸지 말 것**(이미 등록된 이미지가 고아가 된다).
 */

const REVIEW_SAMPLES = [
  { key: 'coupang_pc', channel: 'coupang',    label: '쿠팡 · PC',            emoji: '🛒' },
  { key: 'coupang_mo', channel: 'coupang',    label: '쿠팡 · 모바일',        emoji: '🛒' },
  { key: 'naver_pc',   channel: 'naver',      label: '네이버 · PC',          emoji: '🟢' },
  { key: 'naver_mo',   channel: 'naver',      label: '네이버 · 모바일',      emoji: '🟢' },
  { key: 'kakao_pc',   channel: 'kakao',      label: '카카오메이커스 · PC',   emoji: '💛' },
  { key: 'kakao_mo',   channel: 'kakao',      label: '카카오메이커스 · 모바일', emoji: '💛' },
  { key: 'kakao_feed', channel: 'kakao',      label: '카카오메이커스 · 피드형(별점 없음)', emoji: '💛' },
  { key: 'oy_pc',      channel: 'oliveyoung', label: '올리브영 · PC',         emoji: '🫒' },
  { key: 'oy_mo',      channel: 'oliveyoung', label: '올리브영 · 모바일',     emoji: '🫒' },
];

function sampleSettingKey(k) { return `review_inspect_sample_${k}`; }
const REVIEW_SAMPLE_KEYS = REVIEW_SAMPLES.map(s => sampleSettingKey(s.key));

function isReviewSampleKey(k) { return REVIEW_SAMPLES.some(s => s.key === k); }

/** 그 채널의 예시 슬롯들. 채널을 모르면 빈 배열(= 예시 미동봉). */
function samplesForChannel(channel) {
  if (!channel) return [];
  return REVIEW_SAMPLES.filter(s => s.channel === channel);
}

module.exports = {
  REVIEW_SAMPLES, REVIEW_SAMPLE_KEYS,
  sampleSettingKey, isReviewSampleKey, samplesForChannel,
};
