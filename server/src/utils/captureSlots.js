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
 *   - 모집공고가 현금영수증을 요구하면 탭 설정과 무관하게 선택 영수증 슬롯을 보탠다.
 *   - 그 외에는 tab_configs.capture_slots 명시 설정을 그대로 쓴다.
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
function effectiveCaptureSlots(captureSlots, incomeType, reviewType, campaignCashReceiptRequired = false) {
  if (Array.isArray(captureSlots) && captureSlots.length > 0) {
    const valid = captureSlots.filter(s => s && s.key);
    if (valid.length) {
      // 탭 설정 writer는 두 번째 칸을 slot2로 저장하고 required를 생략한다. 라벨이
      // 현금영수증인 슬롯까지 필수로 두면 리뷰 제출 후 3단계로 갈 수 없으므로 역할 기준으로 선택화한다.
      const normalized = valid.map(s => (s.key === 'receipt' || _CR_LABEL_RE.test(String(s.label || '')))
        ? { ...s, required: false } : s);
      /* 모집공고의 직접 설정은 신규 공고의 진실원본이다. 탭에 옛 명시 슬롯이 남아 있어도
         공고가 현금영수증을 요구하면 선택 슬롯을 보탠다. 라벨로 이미 있는 수동 slot2는 보존한다. */
      if (campaignCashReceiptRequired === true
          && !normalized.some(s => s.key === 'receipt' || _CR_LABEL_RE.test(String(s.label || '')))) {
        return [...normalized, RECEIPT_SLOT];
      }
      return normalized;
    }
  }
  const confirm = reviewType === 'confirm';
  if (campaignCashReceiptRequired === true || isCashReceiptIncome(incomeType)) {
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
function requiredSlotKeys(captureSlots, incomeType, reviewType, campaignCashReceiptRequired = false) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType, reviewType, campaignCashReceiptRequired);
  if (!eff) return ['review'];
  const req = eff.filter(s => s.required !== false).map(s => s.key);
  return req.length ? req : eff.map(s => s.key);
}

/**
 * 이 탭의 **현금영수증 캡처 슬롯**을 찾아 돌려준다(없으면 null) — 현영 폴더 바로가기의 단일 규칙.
 *   반환 = { slot, incomeSaysCashReceipt } — 버튼 활성(홈·업체관리·작업보드)과 서버 폴더 해석이
 *   **같은 함수**를 써야 "눌리는데 서버가 거부" / "대상인데 버튼이 안 눌림" 두 방향 오류가 안 생긴다.
 *
 * ★★ **key 로 찾지 말 것 — 라벨로도 찾는다**(코드리뷰가 잡은 실측 회귀):
 *   관리자가 직접 만든 슬롯은 기존 데이터에 `slot2`,`slot3`… 같은 key로 남아 있다.
 *   현재 writer는 이 key를 보존하지만 `receipt`로 자동 바꾸지는 않는다. 그래서 key만 보면
 *   관리자가 `[리뷰, 현금영수증]`으로 직접 설정한 현영 탭이 "대상 아님"이 되어
 *   버튼이 죽는다(업로드는 그 슬롯 라벨로 `[리뷰]/현금영수증` 폴더를 실제로 만들어 둔 상태).
 *   자동 파생 슬롯은 key `receipt`, 수동 설정은 라벨로 — 둘 다 인정한다.
 *
 * ★ **폴더 이름은 이 슬롯의 label** 이다(업로드가 그 라벨로 서브폴더를 만든다). `slotLabel(...,'receipt')`
 *   로 찾으면 수동 슬롯 탭에서 문자열 `receipt` 라는 폴더를 뒤지게 된다(찾을 수 없는 이름).
 */
const _CR_LABEL_RE = /현금영수증|현영|지출증빙/;

/**
 * 관리자가 슬롯을 재정렬·삽입해도 기존 제출 원장이 가리키는 key를 보존한다.
 * 라벨 일치를 먼저 전체 할당한 뒤 신규 슬롯에만 사용하지 않은 key를 부여한다.
 * 요청에 기존 key가 포함된 경우에는 라벨 변경에도 그 key를 유지한다.
 */
function assignStableCaptureSlotKeys(rawSlots, previousSlots) {
  const incoming = (Array.isArray(rawSlots) ? rawSlots : [])
    .map(s => ({
      requestedKey: typeof s === 'object' && s ? String(s.key || '').trim() : '',
      label: String((typeof s === 'string' ? s : (s && s.label)) || '').trim(),
    }))
    .filter(s => s.label);
  const previous = (Array.isArray(previousSlots) ? previousSlots : [])
    .filter(s => s && String(s.key || '').trim() && String(s.label || '').trim())
    .map(s => ({ key: String(s.key).trim(), label: String(s.label).trim() }));
  const previousKeys = new Set(previous.map(s => s.key));
  const used = new Set();
  const assigned = new Array(incoming.length).fill('');

  incoming.forEach((slot, index) => {
    if (slot.requestedKey && previousKeys.has(slot.requestedKey) && !used.has(slot.requestedKey)) {
      assigned[index] = slot.requestedKey;
      used.add(slot.requestedKey);
    }
  });
  incoming.forEach((slot, index) => {
    if (assigned[index]) return;
    const hit = previous.find(old => old.label === slot.label && !used.has(old.key));
    if (hit) {
      assigned[index] = hit.key;
      used.add(hit.key);
    }
  });

  const reserved = new Set([...previousKeys, ...used]);
  const nextKey = (preferReview) => {
    if (preferReview && !reserved.has('review')) {
      reserved.add('review');
      return 'review';
    }
    let n = 2;
    while (reserved.has(`slot${n}`)) n += 1;
    const key = `slot${n}`;
    reserved.add(key);
    return key;
  };
  incoming.forEach((slot, index) => {
    if (!assigned[index]) assigned[index] = nextKey(previous.length === 0 && index === 0);
  });

  return incoming.map((slot, index) => ({ key: assigned[index], label: slot.label }));
}

function cashReceiptSlotInfo(captureSlots, incomeType, campaignCashReceiptRequired = false, reviewType = null) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType, reviewType, campaignCashReceiptRequired);
  const slot = Array.isArray(eff)
    ? (eff.find(s => s && (s.key === 'receipt' || _CR_LABEL_RE.test(String(s.label || '')))) || null)
    : null;
  return { slot, incomeSaysCashReceipt: isCashReceiptIncome(incomeType) };
}
/** 현금영수증 슬롯 보유 여부(버튼 활성 판정) — 규칙은 cashReceiptSlotInfo 한 곳. */
function hasCashReceiptSlot(captureSlots, incomeType, campaignCashReceiptRequired = false, reviewType = null) {
  return !!cashReceiptSlotInfo(captureSlots, incomeType, campaignCashReceiptRequired, reviewType).slot;
}

/** 저장 key가 slot2여도 라벨이 현금영수증이면 영수증 역할로 판정한다. */
function isCashReceiptSlot(captureSlots, incomeType, key, reviewType = null, campaignCashReceiptRequired = false) {
  const info = cashReceiptSlotInfo(captureSlots, incomeType, campaignCashReceiptRequired, reviewType);
  return !!(info.slot && info.slot.key === key);
}
/**
 * 진행방식은 현영인데 슬롯에서 현금영수증 칸을 못 찾은 경우의 안내 문구(오설정 신호).
 * ★ 이 문구가 있어야 "대상 아님"으로 뭉개지 않는다 — 관리자가 **무엇을 고쳐야 하는지** 알 수 있다.
 *   화면(버튼 툴팁)과 서버(클릭 시 응답)가 같은 문장을 쓰도록 여기 한 곳에 둔다.
 */
const CR_MISCONFIG_NOTE = '진행방식은 현영인데 캡처 슬롯 설정에 현금영수증 칸이 없습니다 — 탭 설정을 확인해 주세요.';
/** 오설정 안내가 필요한가(현영인데 슬롯 없음) — 없으면 null(정상: 대상이거나 애초에 비대상). */
function cashReceiptNote(captureSlots, incomeType, campaignCashReceiptRequired = false, reviewType = null) {
  const r = cashReceiptSlotInfo(captureSlots, incomeType, campaignCashReceiptRequired, reviewType);
  return (!r.slot && r.incomeSaysCashReceipt) ? CR_MISCONFIG_NOTE : null;
}

/** 슬롯 key → 표시 라벨(업로드 서브폴더명·안내문 공용). 모르는 key는 key 그대로. */
function slotLabel(captureSlots, incomeType, key, reviewType, campaignCashReceiptRequired = false) {
  const eff = effectiveCaptureSlots(captureSlots, incomeType, reviewType, campaignCashReceiptRequired) || [REVIEW_SLOT];
  const hit = eff.find(s => s.key === key);
  return (hit && hit.label) || key;
}

module.exports = {
  REVIEW_SLOT, RECEIPT_SLOT, CONFIRM_SLOT,
  isCashReceiptIncome, effectiveCaptureSlots, requiredSlotKeys, slotLabel,
  hasCashReceiptSlot, cashReceiptSlotInfo, isCashReceiptSlot, cashReceiptNote, CR_MISCONFIG_NOTE,
  assignStableCaptureSlotKeys,
};
