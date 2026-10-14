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

/* ────────────────────────────────────────────────────────────────────────────
 * ★★ 인당 구매수량 단계(qty_tiers) — 상품 1개 안의 「N개 구매 × 몇 명 × 1인 결제금액」 (구매수량 ①단계, 2026-10-14)
 *
 *   모양(표준형): { mode: 'common'|'by_option', buy_method: 'qty'|'option',
 *                  rows: [{ option: <옵션 label>|null, qty: 1..99, people: 0.., amount: 0.. }] }
 *   - common    = 모든 옵션이 단계 정원을 함께 쓴다. 옵션 결제금액이 모두 같을 때만 허용(총액이 정확해지도록).
 *   - by_option = 옵션마다 단계 표를 따로 둔다(옵션 가격이 다를 때). option = 그 상품 옵션의 label 과 정확히 같아야 한다.
 *   - amount = 그 단계 1인 결제금액. **인트라넷 값이 원본** — 리뷰웹은 다시 계산하지 않는다(배송비·묶음가 반영값).
 *     ★ 칸 이름을 `pay` 로 짓지 않는다: `pay` 는 접수 뒤에도 고칠 수 있는 키(PRODUCT_OPTION_EDITABLE_KEYS)라
 *       단계 금액이 「잠금 밖 + 공고 전파 없음」 이 되어 값만 조용히 바뀐다. amount 는 접수 뒤 잠긴다.
 *   - 인원 합 = 그 범위의 모집인원(common: 상품 전체 · by_option: 옵션별)과 같아야 한다. 정원·마감은 계속 사람 수로 센다.
 *   ★★★ 키가 없거나 비었으면(null·빈 rows) **키를 지운다**(표준형). 인트라넷이 등급 없는 오더에 빈 값을 실어 보내도
 *       저장 바이트·잠금 비교 모양이 예전과 같아야 한다 — 다르면 접수된 오더가 무엇을 고치든 409 로 영영 잠긴다(결정 167).
 *   ★ 키가 있을 때만 검사한다 — 단계 없는 상품은 영향 0.
 * ──────────────────────────────────────────────────────────────────────────── */
const QTY_TIER_MODES = new Set(['common', 'by_option']);
const QTY_TIER_BUY_METHODS = new Set(['qty', 'option']);

function isEmptyQtyTiers(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  if (typeof raw === 'object' && !Array.isArray(raw) && (raw.rows === undefined || raw.rows === null
    || (Array.isArray(raw.rows) && raw.rows.length === 0))) return true;
  return false;
}

function tierInt(value, label, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ProductOptionsError(`${label} 값이 올바르지 않습니다.`);
  }
  return n;
}

const countOf = node => Math.max(0, Math.floor(Number(node?.count) || 0));
const payOf = node => Math.max(0, Math.floor(Number(node?.pay) || 0));

/** product = 이미 정규화된 상품(options 의 label 이 채워진 상태). 반환 undefined = 단계 없음(키 삭제). */
function normalizeQtyTiers(raw, product, productIndex) {
  if (isEmptyQtyTiers(raw)) return undefined;
  const where = `상품 ${productIndex + 1} 구매수량 단계`;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProductOptionsError(`${where} 형식이 올바르지 않습니다.`);
  const mode = String(raw.mode || '');
  if (!QTY_TIER_MODES.has(mode)) throw new ProductOptionsError(`${where} 방식은 common 또는 by_option 이어야 합니다.`);
  const buyMethod = raw.buy_method === undefined || raw.buy_method === null || raw.buy_method === '' ? 'qty' : String(raw.buy_method);
  if (!QTY_TIER_BUY_METHODS.has(buyMethod)) throw new ProductOptionsError(`${where} 구매 방법은 qty 또는 option 이어야 합니다.`);
  if (!Array.isArray(raw.rows)) throw new ProductOptionsError(`${where} 목록이 올바르지 않습니다.`);
  if (raw.rows.length > 60) throw new ProductOptionsError(`${where}는 최대 60줄까지 입력할 수 있습니다.`);

  const options = Array.isArray(product.options) ? product.options : [];
  const labels = new Map(options.map(o => [o.label, o]));
  if (mode === 'by_option' && product.product_mode !== 'opt') {
    throw new ProductOptionsError(`${where}: 옵션 없는 상품은 옵션별로 나눌 수 없습니다.`);
  }

  const rows = raw.rows.map((row, i) => {
    const at = `${where} ${i + 1}번째 줄`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ProductOptionsError(`${at} 형식이 올바르지 않습니다.`);
    const optionText = row.option === undefined || row.option === null ? '' : String(row.option).trim();
    let option = null;
    if (mode === 'by_option') {
      if (!labels.has(optionText)) throw new ProductOptionsError(`${at}: 옵션 「${optionText}」이(가) 이 상품에 없습니다.`);
      option = optionText;
    } else if (optionText) {
      throw new ProductOptionsError(`${at}: 모든 옵션 공통 방식에는 옵션을 적지 않습니다.`);
    }
    return {
      option,
      qty: tierInt(row.qty, `${at} 구매수량`, 1, 99),
      people: tierInt(row.people, `${at} 인원`, 0, 100000),
      amount: tierInt(row.amount, `${at} 1인 결제금액`, 0, 100000000),
    };
  });

  const scopeKey = r => (mode === 'by_option' ? r.option : '');
  const seen = new Set();
  rows.forEach(r => {
    const k = `${scopeKey(r)}\u0000${r.qty}`;
    if (seen.has(k)) throw new ProductOptionsError(`${where}: ${r.option ? `「${r.option}」의 ` : ''}${r.qty}개 단계가 두 번 들어가 있습니다.`);
    seen.add(k);
  });

  const sumPeople = list => list.reduce((a, r) => a + r.people, 0);
  if (mode === 'common') {
    if (product.product_mode === 'opt' && new Set(options.map(payOf)).size > 1) {
      throw new ProductOptionsError(`${where}: 옵션별 결제금액이 달라 옵션별로 나눠 입력해야 합니다.`);
    }
    const total = product.product_mode === 'opt' ? options.reduce((a, o) => a + countOf(o), 0) : countOf(product.base);
    const s = sumPeople(rows);
    if (s !== total) throw new ProductOptionsError(`${where}: 인원 합(${s}명)이 모집인원(${total}명)과 다릅니다.`);
  } else {
    options.forEach(o => {
      const s = sumPeople(rows.filter(r => r.option === o.label));
      const want = countOf(o);
      if (s !== want) throw new ProductOptionsError(`${where}: 「${o.label}」 인원 합(${s}명)이 모집인원(${want}명)과 다릅니다.`);
    });
  }
  return { mode, buy_method: buyMethod, rows };
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
    // 구버전(라벨만) 배열은 바이트 그대로 둔다 — 단, 구매수량 단계는 단계형(v2) 원본에서만 받는다(검증 없이 저장 금지).
    if (list.some(product => product && typeof product === 'object' && !isEmptyQtyTiers(product.qty_tiers))) {
      throw new ProductOptionsError('구매수량 단계는 단계형(v2) 상품 원본에서만 보낼 수 있습니다.');
    }
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
    const { qty_tiers: rawTiers, ...productRest } = product;
    const result = { ...productRest, name: productName, product_mode: mode, options: resultOptions };
    const tiers = normalizeQtyTiers(rawTiers, result, productIndex);
    return tiers ? { ...result, qty_tiers: tiers } : result;
  });
  return { json: JSON.stringify(normalized), value: normalized, structured: true };
}

/** 원문에 구매수량 단계가 실려 있나 — 정규화를 거치지 않는 옛 경로가 「검증 없이 저장」하지 않게 거르는 데 쓴다. */
function rawHasQtyTiers(raw) {
  let list;
  try { list = parse(raw); } catch (_) { return false; }
  return Array.isArray(list) && list.some(p => p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, 'qty_tiers'));
}

module.exports = {
  ProductOptionsError,
  normalizeProductOptionsJson,
  normalizeQtyTiers,
  rawHasQtyTiers,
  selectionKey,
  parseSelectionKey,
  derivedLabel,
};
