'use strict';

// 상품·옵션 원본은 인트라넷에서 구조화한 값이 진실원본이다. label은 기존
// 단일 옵션 소비처를 위한 파생 호환값일 뿐, 이 서비스가 label을 역분해하지 않는다.
class ProductOptionsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductOptionsError';
    this.code = 'invalid_product_options';
  }
}

function text(value, label, { required = false, max = 160 } = {}) {
  const result = String(value == null ? '' : value).trim();
  if ((required && !result) || result.length > max) {
    throw new ProductOptionsError(`${label} 값이 올바르지 않습니다.`);
  }
  return result;
}

function parse(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { throw new ProductOptionsError('상품·옵션 원본은 JSON 배열이어야 합니다.'); }
  }
  throw new ProductOptionsError('상품·옵션 원본은 JSON 배열이어야 합니다.');
}

function hasStructuredOption(list) {
  return Array.isArray(list) && list.some(product => product?.option_schema_version === 2
    || (Array.isArray(product?.options)
      && product.options.some(option => option && (option.option_1 !== undefined || option.option_2 !== undefined))));
}

function derivedLabel(option1, option2) {
  return option2 ? `${option1} + ${option2}` : option1;
}

function selectionKey(productName, option1, option2) {
  return [productName, option1, option2].filter(Boolean).join(' · ');
}

function parseSelectionKey(value) {
  const parts = String(value == null ? '' : value).split(' · ').map(v => v.trim()).filter(Boolean);
  return parts.length >= 2 && parts.length <= 3
    ? { productName: parts[0], option1Value: parts[1] || '', option2Value: parts[2] || '' }
    : null;
}

/**
 * Parses and validates only the staged-option source. Legacy label-only arrays
 * remain byte-for-byte untouched, so old workboard v1 records are never
 * silently converted. requireStructured is used when v2 becomes writable.
 */
function normalizeProductOptionsJson(raw, { requireStructured = false } = {}) {
  const list = parse(raw);
  if (list === null) {
    if (requireStructured) throw new ProductOptionsError('v2 작업에는 상품·옵션 원본이 필요합니다.');
    return { json: '', value: null, structured: false };
  }
  if (!Array.isArray(list)) throw new ProductOptionsError('상품·옵션 원본은 JSON 배열이어야 합니다.');
  if (list.length > 100) throw new ProductOptionsError('상품은 최대 100개까지 입력할 수 있습니다.');
  const structured = hasStructuredOption(list);
  if (!structured) {
    if (requireStructured) throw new ProductOptionsError('v2 작업의 옵션은 1차 옵션 원본이 필요합니다.');
    return { json: typeof raw === 'string' ? raw : JSON.stringify(list), value: list, structured: false };
  }

  const seen = new Set();
  const normalized = list.map((product, productIndex) => {
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      throw new ProductOptionsError(`상품 ${productIndex + 1} 형식이 올바르지 않습니다.`);
    }
    const productName = text(product.name, `상품 ${productIndex + 1}명`, { required: true, max: 200 });
    const mode = text(product.product_mode, `상품 ${productIndex + 1} 옵션유형`, { required: true, max: 10 });
    if (mode !== 'opt' && mode !== 'none') throw new ProductOptionsError(`상품 ${productIndex + 1} 옵션유형은 opt 또는 none이어야 합니다.`);
    const options = Array.isArray(product.options) ? product.options : null;
    if (!options) throw new ProductOptionsError(`상품 ${productIndex + 1} 옵션 목록이 올바르지 않습니다.`);
    if (options.length > 200) throw new ProductOptionsError(`상품 ${productIndex + 1} 옵션은 최대 200개까지 입력할 수 있습니다.`);
    if (mode === 'opt' && !options.length) throw new ProductOptionsError(`상품 ${productIndex + 1}에는 1개 이상의 옵션이 필요합니다.`);
    if (mode === 'none' && options.length) throw new ProductOptionsError(`옵션 없음 상품에는 옵션을 넣을 수 없습니다.`);

    const resultOptions = options.map((option, optionIndex) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) {
        throw new ProductOptionsError(`상품 ${productIndex + 1} 옵션 ${optionIndex + 1} 형식이 올바르지 않습니다.`);
      }
      if (!option.option_1 || typeof option.option_1 !== 'object' || Array.isArray(option.option_1)) {
        throw new ProductOptionsError(`상품 ${productIndex + 1} 옵션 ${optionIndex + 1}의 1차 옵션이 필요합니다.`);
      }
      if (option.option_3 !== undefined) {
        throw new ProductOptionsError('옵션은 최대 2단계까지만 지원합니다.');
      }
      const option1 = {
        name: text(option.option_1.name, '1차 옵션명', { required: true, max: 100 }),
        value: text(option.option_1.value, '1차 옵션값', { required: true, max: 200 }),
      };
      let option2;
      if (option.option_2 !== undefined) {
        if (!option.option_2 || typeof option.option_2 !== 'object' || Array.isArray(option.option_2)) {
          throw new ProductOptionsError('2차 옵션 형식이 올바르지 않습니다.');
        }
        option2 = {
          name: text(option.option_2.name, '2차 옵션명', { required: true, max: 100 }),
          value: text(option.option_2.value, '2차 옵션값', { required: true, max: 200 }),
        };
      }
      const key = selectionKey(productName, option1.value, option2?.value || '');
      if (seen.has(key)) throw new ProductOptionsError(`중복된 상품·옵션 조합입니다: ${key}`);
      seen.add(key);
      return {
        ...option,
        option_1: option1,
        ...(option2 ? { option_2: option2 } : {}),
        label: derivedLabel(option1.value, option2?.value || ''),
      };
    });
    return { ...product, name: productName, product_mode: mode, options: resultOptions };
  });
  return { json: JSON.stringify(normalized), value: normalized, structured: true };
}

module.exports = {
  ProductOptionsError,
  normalizeProductOptionsJson,
  selectionKey,
  parseSelectionKey,
  derivedLabel,
};
