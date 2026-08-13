/**
 * 모집공고의 혼합 리뷰 구성 계약.
 * UI는 편의를 제공할 뿐, 이 모듈이 API·배치 작업에서 공통으로 지키는 진실원본이다.
 */
const REVIEW_TYPE_MIX_KEYS = new Set(['photo', 'text', 'confirm', 'star']);

function normalizeReviewTypeMix(raw) {
  if (raw === undefined || raw === null) return { provided: false, mix: null, error: null };
  if (!Array.isArray(raw)) return { provided: true, mix: null, error: '리뷰 조합 형식이 올바르지 않습니다.' };
  const sums = new Map();
  for (const row of raw) {
    const type = String(row?.type || '').trim();
    const quantity = Number(row?.quantity);
    if (!REVIEW_TYPE_MIX_KEYS.has(type) || !Number.isInteger(quantity) || quantity < 0) {
      return { provided: true, mix: null, error: '리뷰 조합의 유형 또는 수량이 올바르지 않습니다.' };
    }
    sums.set(type, (sums.get(type) || 0) + quantity);
  }
  const mix = [...sums.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([type, quantity]) => ({ type, quantity }));
  return { provided: true, mix, error: null };
}

function validateReviewTypeMix(reviewType, mixState, recruitTotal, { requireWhenMixed = false } = {}) {
  if (!mixState?.provided) {
    return reviewType === 'mixed' && requireWhenMixed
      ? '혼합 리뷰의 유형별 수량을 입력해주세요.'
      : null;
  }
  if (mixState.error) return mixState.error;
  if (reviewType !== 'mixed') return null;
  if (!mixState.mix || mixState.mix.length < 2) return '혼합 리뷰는 두 가지 이상 유형의 수량을 입력해주세요.';
  const total = Number(recruitTotal) || 0;
  const sum = mixState.mix.reduce((acc, row) => acc + row.quantity, 0);
  if (total <= 0) return '혼합 리뷰는 총인원을 먼저 설정해주세요.';
  if (sum !== total) return `리뷰 조합 합계(${sum}명)를 총인원(${total}명)과 일치시켜주세요.`;
  return null;
}

/** 옵션 있는 공고는 전체 합계 외에도 옵션별 정원과 리뷰 조합을 각각 맞춘다. */
function validateOptionReviewTypeMix(reviewType, options) {
  if (reviewType !== 'mixed' || !Array.isArray(options) || options.length === 0) return null;
  for (const option of options) {
    if (option?.status === 'closed') continue;
    if (option?.reviewMixError) {
      return `옵션 "${String(option?.optKey ?? option?.opt_key ?? '').trim() || '이름 없음'}": ${option.reviewMixError}`;
    }
    const state = normalizeReviewTypeMix(option?.reviewTypeMix ?? option?.review_type_mix);
    const error = validateReviewTypeMix('mixed', state, option?.recruitTotal ?? option?.recruit_total, {
      requireWhenMixed: true,
    });
    if (error) return `옵션 "${String(option?.optKey ?? option?.opt_key ?? '').trim() || '이름 없음'}": ${error}`;
  }
  return null;
}

module.exports = { REVIEW_TYPE_MIX_KEYS, normalizeReviewTypeMix, validateReviewTypeMix, validateOptionReviewTypeMix };
