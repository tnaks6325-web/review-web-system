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
/* ★★ 현금영수증 슬롯은 **선택(required:false)** — 완료 판정에서 제외한다(사용자 확정 2026-08-05).
 *   현금영수증이 국세청에 전송되어 일련번호가 부여(발행확정)되는 시점은 배송완료·구매확정 후
 *   0~3일 뒤라서, 제출 시점에 캡처가 **물리적으로 존재할 수 없다**. 필수로 두면 정상 제출이
 *   전부 "부분 제출"로 잠긴다. 화면에는 슬롯을 계속 보여주되(발행확정 후 제출 가능 안내),
 *   리뷰 캡처만으로 완료 처리한다. 되돌리려면 이 플래그만 제거하면 된다. */
const RECEIPT_SLOT = { key: 'receipt', label: '현금영수증', required: false };
// ★ 087 2차: 구매확정 작업은 리뷰를 쓰지 않고 '구매확정 완료 화면'을 낸다.
const CONFIRM_SLOT = { key: 'confirm', label: '구매확정' };

/** 진행방식이 현금영수증 발행 대상인지 — 현영 판정의 단일 규칙(다른 곳에서 재구현 금지) */
function isCashReceiptIncome(incomeType) {
  return String(incomeType || '').includes('현영');
}

/**
 * 이 탭에서 실제로 쓸 슬롯 목록.
 * @param {Array|null} captureSlots  tab_configs.capture_slots (JSONB)
 * @param {string}     incomeType    tab_configs.income_type
 * @param {string|null} reviewType   utils/reviewType 표준 key (087 2차) — 'confirm' 이면 구매확정건
 * @returns {Array<{key:string,label:string}>|null}
 *   null = 단일 'review' 슬롯(기존 동작). 배열 = 슬롯 모드.
 *   ★ 프론트는 길이 2 이상일 때만 슬롯 UI를 그리므로 단일은 null로 돌려 기존 화면을 유지한다.
 *
 * ★★ 087 2차 — **구매확정 단독은 슬롯을 만들지 않는다**(완화 금지, 실측으로 잡은 함정):
 *   프론트(`search-app.js`)는 `captureSlots.length > 1` 일 때만 슬롯 UI 를 그리고,
 *   단일 첨부 경로는 slotKey 를 보내지 않아 서버에서 `'review'` 로 떨어진다.
 *   그래서 여기서 `[CONFIRM_SLOT]`(길이 1)을 돌려주면 `requiredSlotKeys` 는 `['confirm']` 을
 *   요구하는데 실제 제출은 `'review'` 로 들어와 **완료 판정이 영영 안 된다**(구매확정 제출 전멸).
 *   → 슬롯은 종전대로 두고, **기대 화면 종류만** 리뷰타입에서 파생한다
 *     (`captureVerify._expectedKind(slotKey, reviewType)`).
 *   현영과 겹칠 때만 슬롯이 2개가 되므로 그때는 리뷰 자리를 구매확정으로 치환한다.
 */
function effectiveCaptureSlots(captureSlots, incomeType, reviewType) {
  if (Array.isArray(captureSlots) && captureSlots.length > 0) {
    const valid = captureSlots.filter(s => s && s.key);
    if (valid.length) return valid;                       // 관리자 명시 설정이 최우선(종전 그대로)
  }
  const confirm = reviewType === 'confirm';
  if (isCashReceiptIncome(incomeType)) {
    // 구매확정 + 현영 = 2슬롯. 리뷰를 안 쓰는 작업이라 리뷰 자리를 구매확정으로 **치환**한다.
    return [confirm ? CONFIRM_SLOT : REVIEW_SLOT, RECEIPT_SLOT];
  }
  return null;                                            // 구매확정 단독 포함 — 기존 단일 화면 유지
}

/**
 * 제출 완료로 치기 위해 필요한 슬롯 key 목록.
 * effectiveCaptureSlots와 **같은 입력에서 같은 답**을 내야 한다(둘이 어긋나면 제출이 깨짐).
 *
 * ★ `required:false` 슬롯(현금영수증)은 제외 — 화면에는 뜨지만 완료를 막지 않는다.
 *   관리자 명시 capture_slots는 required 필드가 없으면 종전대로 전부 필수(무회귀),
 *   JSONB에 `"required": false`를 적으면 그 슬롯만 선택이 된다.
 * ★ 전부 선택으로 설정된 병적 케이스는 전체 필수로 폴백 — "아무 슬롯 없이 완료"를 막는다.
 */
function requiredSlotKeys(captureSlots, incomeType, reviewType) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType, reviewType);
  if (!eff) return ['review'];
  const req = eff.filter(s => s.required !== false).map(s => s.key);
  return req.length ? req : eff.map(s => s.key);
}

/**
 * 이 탭이 **현금영수증 캡처 슬롯을 갖는지** — 현영 폴더 바로가기(버튼 활성 ↔ 서버 폴더 해석)의 단일 규칙.
 *
 * ★★ income_type '현영' 뿐 아니라 **관리자가 명시한 capture_slots 의 receipt 슬롯도 인정**한다.
 *   화면(버튼)과 서버(폴더 해석)가 서로 다른 규칙을 쓰면 두 방향으로 다 틀린다 —
 *   "눌리는데 서버가 거부"(오해를 부르는 막다른 길) 또는 "대상인데 버튼이 안 눌림"(기능 소실).
 *   그래서 effectiveCaptureSlots 파생 결과를 그대로 본다(규칙 사본 0).
 */
function hasCashReceiptSlot(captureSlots, incomeType) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType, null);
  return Array.isArray(eff) && eff.some(s => s && s.key === 'receipt');
}

/** 슬롯 key → 표시 라벨(업로드 서브폴더명·안내문 공용). 모르는 key는 key 그대로. */
function slotLabel(captureSlots, incomeType, key, reviewType) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType, reviewType) || [REVIEW_SLOT];
  const hit = eff.find(s => s.key === key);
  return (hit && hit.label) || key;
}

module.exports = {
  REVIEW_SLOT, RECEIPT_SLOT, CONFIRM_SLOT,
  isCashReceiptIncome, effectiveCaptureSlots, requiredSlotKeys, slotLabel, hasCashReceiptSlot,
};
