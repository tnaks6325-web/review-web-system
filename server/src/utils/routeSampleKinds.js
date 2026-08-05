/**
 * routeSampleKinds.js — 자동 분류(파일 라우팅) 판별 예시이미지 슬롯 단일 출처.
 *
 * 구매캡처(주문내역)와 구매확정 완료 화면은 생김새가 비슷해 AI가 혼동하기 쉬운
 * 가장 약한 고리다(와이어프레임 ⑦절). 그래서 **두 장을 모두 등록해야** 구매캡처
 * 자동 이동이 켜진다(utils/captureRoute.js needsRouteSamples 게이트).
 *
 * ★ key 는 gemini classify 캐시 지문(sampleSig)에 들어가므로 리뷰 예시(coupang_pc…)·
 *   현금영수증 예시(receipt_*)와 절대 겹치면 안 된다 — `route_` 접두 고정.
 * ★ settingKey = app_settings 키. 소비처: reviewInspect.loadRouteSamples(판정 동봉) ·
 *   routeSampleSettings/saveRouteSample(설정 화면) — 전부 이 표를 본다(사본 금지).
 */
const ROUTE_SAMPLE_KINDS = [
  { key: 'order_capture',    kind: 'order_capture',    label: '구매캡처(주문내역) 화면', emoji: '🛒',
    settingKey: 'route_sample_order_capture' },
  { key: 'purchase_confirm', kind: 'purchase_confirm', label: '구매확정 완료 화면',      emoji: '✅',
    settingKey: 'route_sample_purchase_confirm' },
];
const ROUTE_SAMPLE_SETTING_KEYS = ROUTE_SAMPLE_KINDS.map(s => s.settingKey);

function isRouteSampleKey(k) { return ROUTE_SAMPLE_KINDS.some(s => s.key === k); }
function routeSampleSettingKey(k) {
  const hit = ROUTE_SAMPLE_KINDS.find(s => s.key === k);
  return hit ? hit.settingKey : null;
}

module.exports = { ROUTE_SAMPLE_KINDS, ROUTE_SAMPLE_SETTING_KEYS, isRouteSampleKey, routeSampleSettingKey };
