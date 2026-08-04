/**
 * cashReceiptChannels.js — 현금영수증 발행방법 이미지의 **채널 단일 출처**.
 *
 * 배경: 채널 목록이 ① 저장 라우트 화이트리스트(`POST /api/tab/cash-receipt-guide`)
 *   ② work-detail 의 이미지 선택(`_cashReceiptInfo`) ③ 관리자 설정탭 슬롯 —
 *   세 곳에 흩어져 있었다. 그래서 `WO_CHANNEL_HOSTS` 에 올리브영·카카오메이커스를
 *   추가했는데도 현영 안내 이미지는 **네이버·쿠팡 2슬롯에 머물러**, 그 두 채널의
 *   현영 탭은 사업자번호만 나오고 발행방법 이미지가 조용히 비어 나갔다.
 *   → 채널을 늘릴 때 한 곳만 고치면 세 경로가 함께 따라오도록 여기로 모은다.
 *
 * ★ `key` 는 `app_settings` 키(`cash_receipt_guide_<key>`)이자 프론트 슬롯 id 접미사와
 *   1:1 이다. **한 번 정한 key 는 바꾸지 말 것** — 이미 등록된 이미지가 고아가 된다.
 */

/**
 * ★ 순서 = 판정 우선순위. 커스텀 채널명("쿠팡/네이버 병행")처럼 둘 이상이 섞이면
 *   앞에 있는 것이 이긴다. 기존 동작(쿠팡 우선)을 보존하려고 coupang 을 맨 앞에 둔다.
 *
 * ★ match 를 넓히지 말 것 — 발행방법은 채널마다 실제 화면이 다르므로
 *   **틀린 안내를 보여주는 것이 안 보여주는 것보다 나쁘다.**
 *   그래서 카카오는 `메이커스` 를 요구한다(카카오톡스토어·선물하기는 진행 방식이 달라
 *   같은 안내를 쓸 수 없다 → 미매칭 = 이미지 없이 문구만, WO_CHANNEL_HOSTS 와 같은 규율).
 */
const CASH_RECEIPT_CHANNELS = [
  { key: 'coupang',    label: '쿠팡',           icon: '🛒', match: /쿠팡/ },
  { key: 'naver',      label: '네이버',          icon: '🟢', match: /네이버/ },
  { key: 'oliveyoung', label: '올리브영',        icon: '🫒', match: /올리브영|올영/ },
  { key: 'kakao',      label: '카카오메이커스',   icon: '💛', match: /메이커스/ },
];

/** app_settings 키 이름 규칙 — 저장·조회가 같은 함수를 쓰게 한다(오타로 갈리는 것 방지). */
function cashReceiptSettingKey(channelKey) {
  return `cash_receipt_guide_${channelKey}`;
}

/** 조회용 키 전체(사업자번호는 호출부에서 합친다). */
const CASH_RECEIPT_SETTING_KEYS = CASH_RECEIPT_CHANNELS.map(c => cashReceiptSettingKey(c.key));

/**
 * ★★ 현금영수증 **판별 예시이미지**(AI 기준) — 위 발행방법 이미지와 **다른 슬롯**이다.
 *   - 발행방법(`cash_receipt_guide_*`) = **리뷰어에게 보여주는 안내**(결제 전 "이렇게 발행하세요").
 *   - 예시(`cash_receipt_sample_*`)   = **AI가 "이게 그 채널의 현금영수증"으로 삼는 기준**
 *     (`captureVerify` 의 receipt 슬롯 판정에 few-shot 으로 동봉 — 리뷰어에게 나가지 않는다).
 *   두 값을 한 칸에 합치면 "리뷰어 안내를 바꿨더니 AI 판정이 흔들리는" 결합이 생긴다.
 *
 * ★ 채널 표는 위 하나뿐이므로 채널을 늘리면 발행방법·예시 슬롯이 **함께** 따라온다.
 */
function cashReceiptSampleSettingKey(channelKey) {
  return `cash_receipt_sample_${channelKey}`;
}
const CASH_RECEIPT_SAMPLE_SETTING_KEYS = CASH_RECEIPT_CHANNELS.map(c => cashReceiptSampleSettingKey(c.key));

/** 저장 라우트 화이트리스트 — 목록에 없는 채널 키는 거부(임의 app_settings 키 생성 차단). */
function isCashReceiptChannelKey(k) {
  return CASH_RECEIPT_CHANNELS.some(c => c.key === k);
}

/**
 * 공고의 채널 문자열(버튼값 또는 직접입력 커스텀) → 채널 key.
 * @returns {string|null} 못 찾으면 null = **이미지 없이 문구만 안내**(fail-soft).
 */
function cashReceiptChannelKey(channel) {
  const ch = String(channel == null ? '' : channel);
  if (!ch.trim()) return null;
  const hit = CASH_RECEIPT_CHANNELS.find(c => c.match.test(ch));
  return hit ? hit.key : null;
}

/** 관리자 화면·로그용 한글 라벨. 모르는 key 는 key 그대로(빈 문자열보다 추적이 쉽다). */
function cashReceiptChannelLabel(channelKey) {
  const hit = CASH_RECEIPT_CHANNELS.find(c => c.key === channelKey);
  return hit ? hit.label : String(channelKey || '');
}

module.exports = {
  CASH_RECEIPT_CHANNELS,
  CASH_RECEIPT_SETTING_KEYS,
  CASH_RECEIPT_SAMPLE_SETTING_KEYS,
  cashReceiptSettingKey,
  cashReceiptSampleSettingKey,
  isCashReceiptChannelKey,
  cashReceiptChannelKey,
  cashReceiptChannelLabel,
};
