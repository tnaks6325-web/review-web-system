'use strict';

// v2 가변 작업표 열의 원본 판정은 이 파일 한 곳에 둔다. 화면 문자열이나
// 기존 시트 헤더를 역으로 읽지 않는다. 그래야 preview·시트·sheetless가 같은
// 값을 만들고, 원본이 불완전한 경우 임의의 열/행을 만드는 사고를 막을 수 있다.
const { normalizeReviewType, reviewTypeLabel, isFreeChoiceReviewType } = require('../utils/reviewType');
const { normalizeReviewTypeMix } = require('../utils/reviewTypeMix');

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isTrue(value) {
  return value === true || /^(true|t|y|yes|1|예)$/i.test(String(value == null ? '' : value).trim());
}

function isCourierProxy(wo = {}) {
  const delivery = String(wo.delivery_type == null ? '' : wo.delivery_type).trim();
  const byDelivery = delivery === '택배발송대행';
  const byFlag = isTrue(wo.courier_proxy);
  if (byDelivery !== byFlag) return { enabled: false, blocker: 'delivery_source_inconsistent' };
  return { enabled: byDelivery, blocker: null };
}

function roundSpec(wo = {}) {
  const round = asPositiveInt(wo.work_round == null || wo.work_round === '' ? 1 : wo.work_round);
  const series = String(wo.work_series_id == null ? '' : wo.work_series_id).trim();
  if (!round || (round > 1 && !series)) return { label: '', blocker: 'invalid_work_round' };
  return { label: round > 1 ? `${round}차` : '', blocker: null };
}

function parseMix(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { return { mix: null, error: true }; }
  }
  const state = normalizeReviewTypeMix(raw);
  return state.error ? { mix: null, error: true } : { mix: state.mix || [], error: false };
}

function labelsFromMix(raw, expectedCount) {
  const parsed = parseMix(raw);
  if (parsed.error || !Array.isArray(parsed.mix) || parsed.mix.length < 2) return null;
  const labels = [];
  for (const item of parsed.mix) {
    const label = reviewTypeLabel(item.type);
    const count = asPositiveInt(item.quantity);
    if (!label || !count) return null;
    for (let i = 0; i < count; i++) labels.push(label);
  }
  return labels.length === expectedCount ? labels : null;
}

/**
 * @param {{total:number, selections:Array, rowSelections:Array, reviewType:any, reviewTypeMix:any}}
 * @returns {{labels:string[], blocker:string|null}}
 */
function reviewOptionAssignments({ total, selections = [], rowSelections = [], reviewType, reviewTypeMix } = {}) {
  const n = asPositiveInt(total);
  const type = normalizeReviewType(reviewType);
  // `자율리뷰`는 행별 유형을 지정하지 않는 정상 값이다. v2 표에는 리뷰옵션 열을
  // 유지하되 값을 비워 두며, 모르는/깨진 리뷰타입까지 허용하지 않도록 정확한 표기만 예외 처리한다.
  if (n && !type && isFreeChoiceReviewType(reviewType)) {
    return { labels: new Array(n).fill(''), blocker: null };
  }
  if (!n || !type) return { labels: new Array(n).fill(''), blocker: 'invalid_review_type' };
  if (type !== 'mixed') {
    const label = reviewTypeLabel(type);
    return label ? { labels: new Array(n).fill(label), blocker: null }
      : { labels: new Array(n).fill(''), blocker: 'invalid_review_type' };
  }

  const keys = (rowSelections || []).map(row => String(row?.selectionKey || '')).filter(Boolean);
  const unique = [...new Set(keys)];
  const labelsByKey = new Map();
  if (unique.length > 1) {
    for (const key of unique) {
      const count = keys.filter(x => x === key).length;
      const selection = (selections || []).find(x => x && x.selectionKey === key);
      const labels = labelsFromMix(selection?.review_type_mix, count);
      if (!labels) return { labels: new Array(n).fill(''), blocker: 'review_mix_assignment_missing' };
      labelsByKey.set(key, labels);
    }
  } else {
    const sole = unique.length === 1 ? (selections || []).find(x => x && x.selectionKey === unique[0]) : null;
    const labels = labelsFromMix(sole?.review_type_mix, n) || labelsFromMix(reviewTypeMix, n);
    if (!labels) return { labels: new Array(n).fill(''), blocker: 'review_mix_sum_mismatch' };
    labelsByKey.set(unique[0] || '__all__', labels);
  }

  const offsets = new Map();
  const labels = (rowSelections || []).map(row => {
    const key = String(row?.selectionKey || '') || '__all__';
    const source = labelsByKey.get(key) || [];
    const index = offsets.get(key) || 0;
    offsets.set(key, index + 1);
    return source[index] || '';
  });
  if (labels.length !== n || labels.some(v => !v)) return { labels: new Array(n).fill(''), blocker: 'review_mix_assignment_missing' };
  return { labels, blocker: null };
}

module.exports = {
  asPositiveInt,
  isCourierProxy,
  roundSpec,
  reviewOptionAssignments,
};
