/**
 * captureSlots.js — 리뷰 제출 캡처 슬롯 판정의 **단일 출처**.
 *
 * 슬롯이 무엇인지는 세 곳이 동시에 알아야 한다:
 *   ① 검색 응답(리뷰어 화면이 그릴 슬롯 목록)  ② 제출 완료 판정(필요 슬롯 ⊆ 제출 슬롯)
 *   ③ 업로드 폴더 라벨(슬롯별 서브폴더)
 * 셋 중 하나만 달라도 "슬롯은 2개인데 1장 올리면 완료" 또는 그 반대가 되어 제출이 깨진다.
 * 그래서 파생 규칙을 여기 하나로 모으고 전 소비처가 이 함수만 쓴다.
 *
 * 규칙:
 *   - tab_configs.capture_slots 가 설정돼 있으면 **그대로**(관리자 명시 설정이 최우선).
 *   - 설정이 없고 진행방식(income_type)에 '현영'이 있으면 → 리뷰 + 현금영수증 2슬롯 자동.
 *     현영건은 지출증빙 발행 내역이 정산 근거라 캡처가 반드시 따로 필요하다.
 *   - 그 외 → 단일 암묵 'review' 슬롯(기존 동작 그대로).
 */

const REVIEW_SLOT = { key: 'review', label: '리뷰' };
const RECEIPT_SLOT = { key: 'receipt', label: '현금영수증' };

/** 진행방식이 현금영수증 발행 대상인지 — 현영 판정의 단일 규칙(다른 곳에서 재구현 금지) */
function isCashReceiptIncome(incomeType) {
  return String(incomeType || '').includes('현영');
}

/**
 * 이 탭에서 실제로 쓸 슬롯 목록.
 * @param {Array|null} captureSlots  tab_configs.capture_slots (JSONB)
 * @param {string}     incomeType    tab_configs.income_type
 * @returns {Array<{key:string,label:string}>|null}
 *   null = 단일 'review' 슬롯(기존 동작). 배열 = 슬롯 모드.
 *   ★ 프론트는 길이 2 이상일 때만 슬롯 UI를 그리므로 단일은 null로 돌려 기존 화면을 유지한다.
 */
function effectiveCaptureSlots(captureSlots, incomeType) {
  if (Array.isArray(captureSlots) && captureSlots.length > 0) {
    const valid = captureSlots.filter(s => s && s.key);
    if (valid.length) return valid;
  }
  if (isCashReceiptIncome(incomeType)) return [REVIEW_SLOT, RECEIPT_SLOT];
  return null;
}

/**
 * 제출 완료로 치기 위해 필요한 슬롯 key 목록.
 * effectiveCaptureSlots와 **같은 입력에서 같은 답**을 내야 한다(둘이 어긋나면 제출이 깨짐).
 */
function requiredSlotKeys(captureSlots, incomeType) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType);
  return eff ? eff.map(s => s.key) : ['review'];
}

/** 슬롯 key → 표시 라벨(업로드 서브폴더명·안내문 공용). 모르는 key는 key 그대로. */
function slotLabel(captureSlots, incomeType, key) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType) || [REVIEW_SLOT];
  const hit = eff.find(s => s.key === key);
  return (hit && hit.label) || key;
}

module.exports = {
  REVIEW_SLOT, RECEIPT_SLOT,
  isCashReceiptIncome, effectiveCaptureSlots, requiredSlotKeys, slotLabel,
};
