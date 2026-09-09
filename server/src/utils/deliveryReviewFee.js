'use strict';

/*
 * 혼합 배송 리뷰비 계약.
 *
 * 배송 조합은 `deliveryTypeMix`가, 이 파일은 그 조합의 각 유형에 지급할 리뷰비만
 * 맡는다. 수량을 이중 저장하지 않아 조합을 바꿨을 때 "수량 A / 리뷰비 수량 B"로
 * 갈라질 여지를 없앤다.
 */
const { DELIVERY_MIX_KEYS, DELIVERY_MIX_SHEET_LABELS } = require('./deliveryTypeMix');

function _fee(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 자유 입력 → `[{ type: 'real'|'empty', reviewFee: number }]`. */
function normalizeDeliveryReviewFeeMix(raw) {
  if (raw === undefined || raw === null) return { provided: false, mix: null, error: null };
  let value = raw;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return { provided: false, mix: null, error: null };
    try { value = JSON.parse(text); }
    catch (_) { return { provided: true, mix: null, error: '배송유형별 리뷰비 형식이 올바르지 않습니다.' }; }
  }
  if (!Array.isArray(value)) return { provided: true, mix: null, error: '배송유형별 리뷰비 형식이 올바르지 않습니다.' };

  const byType = new Map();
  for (const row of value) {
    const type = String(row && row.type || '').trim();
    const reviewFee = _fee(row && (row.reviewFee ?? row.review_fee ?? row.fee));
    if (!DELIVERY_MIX_KEYS.has(type) || reviewFee === null || byType.has(type)) {
      return { provided: true, mix: null, error: '실배송·빈박스 리뷰비는 각각 0원 이상의 정수로 입력해주세요.' };
    }
    byType.set(type, reviewFee);
  }
  return {
    provided: true,
    mix: [...DELIVERY_MIX_KEYS]
      .filter(type => byType.has(type))
      .map(type => ({ type, reviewFee: byType.get(type) })),
    error: null,
  };
}

function validateDeliveryReviewFeeMix(deliveryBase, state, { requireWhenMixed = false } = {}) {
  if (!state || !state.provided) {
    return deliveryBase === '혼합' && requireWhenMixed
      ? '혼합 배송은 실배송·빈박스의 리뷰비를 각각 입력해주세요.'
      : null;
  }
  if (state.error) return state.error;
  if (deliveryBase !== '혼합') return null;
  if (!state.mix || state.mix.length !== DELIVERY_MIX_KEYS.size) {
    return '혼합 배송은 실배송·빈박스의 리뷰비를 각각 입력해주세요.';
  }
  return null;
}

/** 작업표 `배송구분` 값에 맞는 금액. 매핑이 없거나 유형이 불명확하면 fallback을 쓴다. */
function resolveDeliveryReviewFee(mix, deliveryKind, fallback) {
  const state = normalizeDeliveryReviewFeeMix(mix);
  const label = String(deliveryKind || '').trim();
  const type = Object.entries(DELIVERY_MIX_SHEET_LABELS).find(([, v]) => v === label)?.[0] || null;
  const hit = !state.error && type && (state.mix || []).find(row => row.type === type);
  if (hit) return { fee: hit.reviewFee, source: 'delivery_mix', deliveryType: type };
  return { fee: Math.max(0, Number(fallback) || 0), source: 'fallback', deliveryType: type };
}

module.exports = {
  DELIVERY_MIX_KEYS,
  normalizeDeliveryReviewFeeMix,
  validateDeliveryReviewFeeMix,
  resolveDeliveryReviewFee,
};
