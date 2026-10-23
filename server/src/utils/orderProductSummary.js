/**
 * orderProductSummary — 작업오더 `product_option`(인트라넷이 상품 구성에서 만드는 **요약 문장**)을 리뷰웹에서 다시 만든다
 * (결정 275 · 양방향 5단계).
 *
 * 공고 창에서 결제금액을 고치면 상품 구성(`product_options_json`)의 금액 칸이 바뀐다. 요약 문장은 인트라넷 화면이
 * 저장할 때 만드는 파생값이라 리뷰웹이 대신 만들어야 "결제금액 ○원 / 소계" 가 옛 금액으로 남지 않는다.
 *
 * ★★ 인트라넷 `reviewOrderProductSummary`(public/static/js/review-orders.js) 이식 — 규칙을 새로 만들지 않는다.
 * ★★ 이식 차이로 문장이 틀어지지 않게, 호출부는 **옛 상품 구성으로 다시 만든 문장이 저장된 옛 문장과 글자까지 같을 때만**
 *    새 문장을 쓴다(`regenerateSummary`). 다르면 옛 문장을 그대로 두고 기록만 남긴다(틀린 문장보다 옛 문장).
 * ★ 구매수량 단계(qty_tiers)를 쓰는 상품이 있으면 이식하지 않는다(그쪽 문장은 단계 줄이 따로 있다) → null.
 * ★ 순수 모듈 — DB 없음.
 */
'use strict';

const _money = (v) => Number(v || 0).toLocaleString('ko-KR');
const _s = (v) => String(v == null ? '' : v).trim();

function _parse(raw) {
  if (Array.isArray(raw)) return raw;
  const s = _s(raw);
  if (!s) return null;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

function _hasTiers(p) {
  const t = p && p.qty_tiers;
  if (t == null) return false;
  if (Array.isArray(t)) return t.length > 0;
  if (typeof t === 'object') return Object.keys(t).length > 0;
  return _s(t) !== '';
}

/** 인트라넷 `reviewOrderFormatOption` — 저장 때 label 이 바로 그 값이다. 없으면 같은 규칙으로 만든다. */
function _optionLabel(op) {
  const lab = _s(op && op.label);
  if (lab) return lab;
  const v1 = _s(op && op.option_1 && op.option_1.value) || '옵션1';
  const v2 = _s(op && op.option_2 && op.option_2.value);
  return (op && op.option_2) || v2 ? `${v1} + ${v2 || '옵션2'}` : v1;
}

/**
 * 상품 구성 → 요약 문장. 단계 상품이 있거나 읽을 수 없으면 null.
 * @param {string|Array} productOptionsJson
 * @returns {string|null}
 */
function productSummaryText(productOptionsJson) {
  const products = _parse(productOptionsJson);
  if (!products) return null;
  if (products.some(_hasTiers)) return null;
  if (!products.length) return '';
  const lines = ['[상품/옵션/금액]'];
  let recruit = 0, cost = 0;
  products.forEach((p, i) => {
    const prod = p && typeof p === 'object' ? p : {};
    const url = _s(prod.url);
    lines.push(`${i + 1}. ${_s(prod.name) || '상품명 미입력'}${url ? ` (${url})` : ''}`);
    const opts = Array.isArray(prod.options) ? prod.options : [];
    if (opts.length) {
      for (const op of opts) {
        const pay = Number(op && op.pay) || 0, count = Number(op && op.count) || 0;
        lines.push(`- ${_optionLabel(op)} / 결제금액 ${_money(pay)}원 / ${_money(count)}명 / 소계 ${_money(pay * count)}원`);
        recruit += count; cost += pay * count;
      }
    } else {
      const base = prod.base && typeof prod.base === 'object' ? prod.base : {};
      const pay = Number(base.pay) || 0, count = Number(base.count) || 0;
      lines.push(`- 결제금액 ${_money(pay)}원 / ${_money(count)}명 / 소계 ${_money(pay * count)}원`);
      recruit += count; cost += pay * count;
    }
  });
  lines.push(`[합계] 최종모집인원 ${_money(recruit)}명 / 총 상품구입비 ${_money(cost)}원`);
  return lines.join('\n');
}

/**
 * 새 상품 구성의 요약 문장 — 옛 구성으로 다시 만든 문장이 저장된 옛 문장과 같을 때만.
 * @returns {{ text: string|null, reason?: string }} text=null 이면 옛 문장을 그대로 둔다(reason = 사유)
 */
function regenerateSummary({ prevJson, prevText, nextJson }) {
  const before = productSummaryText(prevJson);
  if (before == null) return { text: null, reason: 'not_portable' };
  if (before !== String(prevText == null ? '' : prevText)) return { text: null, reason: 'prev_mismatch' };
  const after = productSummaryText(nextJson);
  if (after == null) return { text: null, reason: 'not_portable' };
  return { text: after };
}

module.exports = { productSummaryText, regenerateSummary };
