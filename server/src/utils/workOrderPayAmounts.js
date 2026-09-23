'use strict';
/**
 * workOrderPayAmounts.js — 작업오더에서 **1건당 결제금액**을 읽는 규칙(단일 출처)
 *
 * ★★★ `work_orders.pay_amount` 는 **합계**다(인트라넷 `totals.cost` = 소계의 합).
 *   그 값을 1건당 자리에 넣으면 60건 작업에 9,324만원이 찍힌 사고(2026-08-21)가 재현된다.
 *   1건당 금액은 **오직 `product_options_json`** 에만 있다.
 *
 * 인트라넷 계약(`reviewOrderOptionsPayload`):
 *   [{ name, url, product_mode, base:{pay,count,daily}, options:[{option_1,label,pay,count,daily}] }]
 *
 * ★★ 값 선택 규칙은 발행 프리필 `_woOptionRows`(frontend/js/work-order-detail.js)와 **같아야 한다** —
 *   그쪽이 공고를 만들 때 쓴 금액과 여기서 갱신하는 금액이 갈리면 "발행할 때와 고칠 때가 다른 금액"이 된다.
 *   회귀가드가 두 규칙의 일치를 고정한다(서버·프론트 경계라 사본이지만 대조된다).
 *     · 옵션 있는 상품 → 선택지 키 = `label`, 금액 = `op.pay || base.pay`
 *     · 옵션 없는 상품 → 선택지 키 = `''`(공고에 옵션 행이 없다), 금액 = `base.pay`
 *     · "옵션 없음"류 라벨은 옵션명이 아니라 서술 → 옵션 없는 상품으로 접는다
 */

/** `_woOptionRows` 와 같은 판정 — 옵션명이 아니라 "옵션이 없다"는 서술 */
const NONE_LABEL_RE = /^(옵션\s*없음|없음|단일(상품)?|해당\s*없음)$/;

const _clean = s => String(s == null ? '' : s).replace(/\|/g, '').trim();
const _pay = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * 작업오더 상품 구성에서 선택지별 1건당 금액을 뽑는다.
 * @param {string|Array|null} productOptionsJson
 * @returns {{units: Array<{optKey:string, productName:string, payAmount:number}>, single: number|null, distinct: number[]}}
 *   · `units`  — 선택지 단위(공고 옵션과 `optKey` 로 짝짓는다)
 *   · `single` — 금액이 **한 종류뿐**일 때 그 값(여러 종류면 null — 글자 치환은 그때만 안전하다)
 *   · `distinct` — 나온 금액 종류(오름차순, 화면이 사유를 말할 때 쓴다)
 */
function payAmountsFromWorkOrder(productOptionsJson) {
  let arr = productOptionsJson;
  if (typeof arr === 'string') {
    const t = arr.trim();
    if (!t) return { units: [], single: null, distinct: [] };
    try { arr = JSON.parse(t); } catch (_) { return { units: [], single: null, distinct: [] }; }
  }
  if (!Array.isArray(arr)) return { units: [], single: null, distinct: [] };

  const units = [];
  for (const prod of arr) {
    if (!prod || typeof prod !== 'object') continue;
    const productName = _clean(prod.name);
    const basePay = _pay(prod.base && prod.base.pay);
    const opts = Array.isArray(prod.options) ? prod.options : [];
    if (opts.length) {
      for (const op of opts) {
        if (!op || typeof op !== 'object') continue;
        const label = _clean(op.label);
        const isNone = !label || NONE_LABEL_RE.test(label);
        units.push({
          optKey: isNone ? '' : label,
          productName,
          payAmount: _pay(op.pay) || basePay,
          // ★ 가산 필드 — 유입가이드 전파가 **같은 선택 단위**(같은 optKey)를 보게 한다.
          //   금액 판정은 이 값을 읽지 않는다(추출 규칙 무변경).
          src: op,
        });
      }
    } else if (productName) {
      units.push({ optKey: '', productName, payAmount: basePay, src: prod });
    }
  }

  const distinct = [...new Set(units.map(u => u.payAmount).filter(v => v > 0))].sort((a, b) => a - b);
  return { units, single: distinct.length === 1 ? distinct[0] : null, distinct };
}

module.exports = { payAmountsFromWorkOrder, NONE_LABEL_RE };
