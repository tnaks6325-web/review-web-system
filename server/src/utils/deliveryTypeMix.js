/**
 * 배송 혼합 구성 계약 — `혼합(실배송 20건, 빈박스 80건)`.
 *
 * ★★ 리뷰 혼합(`utils/reviewTypeMix.js`)과 **같은 규칙·같은 모양**으로 둔다.
 *   두 혼합이 서로 다른 규칙을 가지면 "리뷰 조합은 합계를 맞추라는데 배송 조합은 안 맞춰도
 *   되는" 화면이 되어 담당자가 어느 쪽을 믿을지 알 수 없다.
 * ★ UI 는 편의를 제공할 뿐, 이 모듈이 API·배치 작업에서 공통으로 지키는 진실원본이다.
 */
const DELIVERY_MIX_KEYS = new Set(['real', 'empty']);

/** 배분 표기 — 작업표 `배송구분` 칸에 이 값이 적힌다. */
const DELIVERY_MIX_SHEET_LABELS = { real: '실배송', empty: '빈박스' };

/**
 * 자유 입력 → `[{type,quantity}]`.
 * ★ 문장 파싱 결과(`{real,empty}` — `utils/deliveryType.parseDeliveryType().mix`)도 받는다.
 *   그래야 구조화 필드가 없는 **과거 오더**가 같은 경로로 흘러간다(사본 금지).
 */
function normalizeDeliveryTypeMix(raw) {
  if (raw === undefined || raw === null) return { provided: false, mix: null, error: null };

  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return { provided: false, mix: null, error: null };
    try { v = JSON.parse(s); } catch (_) { return { provided: true, mix: null, error: '배송 조합 형식이 올바르지 않습니다.' }; }
  }
  // 문장 파싱 형태 {real,empty} → 배열로 접는다.
  if (v && !Array.isArray(v) && typeof v === 'object') {
    v = [...DELIVERY_MIX_KEYS].map((type) => ({ type, quantity: Number(v[type]) || 0 }));
  }
  if (!Array.isArray(v)) return { provided: true, mix: null, error: '배송 조합 형식이 올바르지 않습니다.' };

  const sums = new Map();
  for (const row of v) {
    const type = String(row?.type || '').trim();
    const quantity = Number(row?.quantity);
    if (!DELIVERY_MIX_KEYS.has(type) || !Number.isInteger(quantity) || quantity < 0) {
      return { provided: true, mix: null, error: '배송 조합의 유형 또는 수량이 올바르지 않습니다.' };
    }
    sums.set(type, (sums.get(type) || 0) + quantity);
  }
  const mix = [...sums.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([type, quantity]) => ({ type, quantity }));
  return { provided: true, mix, error: null };
}

/**
 * 합계 = 총 건수 검증(리뷰 혼합과 같은 규칙).
 * ★ 배송유형이 혼합이 아니면 검사하지 않는다 — 다른 유형의 저장을 막지 않는다.
 */
function validateDeliveryTypeMix(deliveryBase, mixState, recruitTotal, { requireWhenMixed = false } = {}) {
  if (!mixState?.provided) {
    return deliveryBase === '혼합' && requireWhenMixed
      ? '혼합 배송의 유형별 수량을 입력해주세요.'
      : null;
  }
  if (mixState.error) return mixState.error;
  if (deliveryBase !== '혼합') return null;
  if (!mixState.mix || mixState.mix.length < 2) return '혼합 배송은 실배송·빈박스 두 유형의 수량을 입력해주세요.';
  const total = Number(recruitTotal) || 0;
  const sum = mixState.mix.reduce((acc, row) => acc + row.quantity, 0);
  if (total <= 0) return '혼합 배송은 총 건수를 먼저 설정해주세요.';
  if (sum !== total) return `배송 조합 합계(${sum}건)를 총 건수(${total}건)와 일치시켜주세요.`;
  return null;
}

module.exports = {
  DELIVERY_MIX_KEYS, DELIVERY_MIX_SHEET_LABELS,
  normalizeDeliveryTypeMix, validateDeliveryTypeMix,
};
