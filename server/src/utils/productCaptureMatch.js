/**
 * productCaptureMatch.js — 글자(주문 캡처에서 읽은 상품명·옵션, 또는 작업표 「상품」 칸 값)가
 * 공고의 **어느 상품(선택지)** 을 가리키는지 하나로 정한다 (결정 230 · 사용자 확정 2026-10-12).
 *
 * ★★ 왜 `sheetlessOrder.resolveProductLabel` 하나로 끝내지 않나:
 *   그 함수는 "선택지 이름이 글자 안에 통째로 들어 있거나 그 반대"만 본다. 그런데 공고 선택지 이름에는
 *   리뷰어 안내가 붙어 있다(`4. 킹(분리난방)배송메세지00<<넣어서구매`) — 캡처에는 이 꼬리가 없어서
 *   통째 비교로는 거의 못 맞춘다. 그래서 그 비교를 **먼저** 하고(같은 규칙 재사용), 못 맞추면
 *   "그 선택지에만 있는 낱말"(다른 선택지와 겹치지 않는 낱말)로 한 번 더 본다.
 *
 * ★★ 완화 금지 — **둘 이상이 걸리면 '' (모른다)**. 확신할 때만 하나를 돌려준다.
 *   여기서 틀린 상품을 돌려주면 리뷰어에게 엉뚱한 확인 질문이 뜨거나(①) 담당자가 고친 칸이
 *   다른 상품의 인원으로 옮겨진다(③). 모르면 아무 일도 안 일어나는 것이 안전한 쪽이다.
 * ★ 낱말 규칙:
 *   · 글자는 소문자 + 한글·영문·숫자만 남긴다(`HA-HD1590` → `hahd1590`).
 *   · 두 글자 이상 낱말은 "안에 들어 있으면" 걸린다. 한 글자 낱말(`킹`)은 캡처 쪽에도 **그 낱말이 따로**
 *     있어야 걸린다(`킹사이즈` 같은 다른 말 속 글자로 걸리지 않게).
 *   · 숫자만 있는 짧은 낱말(번호 `1.`·`2.`)은 버린다.
 *   · 여러 선택지에 함께 있는 낱말(`배송메세지00`·`누쓰쓰`)은 버린다 — 구분에 쓸모가 없다.
 *   · 모든 선택지에 똑같이 붙은 앞·뒤 글자도 떼고 남은 알맹이(`퀸더블`)로 본다.
 */
'use strict';

const _norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
const _tokens = (v) => String(v == null ? '' : v).toLowerCase().split(/[^0-9a-z가-힣]+/).filter(Boolean);
const _usableToken = (t) => !(/^\d+$/.test(t) && t.length <= 2);

/** 정규화된 이름들에서 공통 앞·뒤 글자와 앞 번호를 뗀 알맹이(같은 알맹이가 둘 이상이면 그 둘은 '' — 못 가른다). */
function _cores(names) {
  if (names.length < 2 || names.some(n => !n)) return names.map(() => '');
  let pre = names[0];
  for (const n of names) { let i = 0; while (i < pre.length && i < n.length && pre[i] === n[i]) i++; pre = pre.slice(0, i); }
  let suf = names[0];
  for (const n of names) { let i = 0; while (i < suf.length && i < n.length && suf[suf.length - 1 - i] === n[n.length - 1 - i]) i++; suf = suf.slice(suf.length - i); }
  const raw = names.map(n => n.slice(pre.length, Math.max(pre.length, n.length - suf.length)).replace(/^\d+/, ''));
  const cnt = new Map(); for (const c of raw) cnt.set(c, (cnt.get(c) || 0) + 1);
  return raw.map(c => (c && cnt.get(c) === 1 ? c : ''));
}

/** options: [{ optKey|opt_key, productName|product_name }] → [{ key, product }] */
function _prep(options) {
  return (options || [])
    .map(o => ({
      key: String((o && (o.optKey != null ? o.optKey : o.opt_key)) || ''),
      product: String((o && (o.productName != null ? o.productName : o.product_name)) || ''),
    }))
    .filter(o => o.key);
}

/**
 * 그 글자가 **언급하는** 선택지 키 집합.
 * @param {string} text  캡처에서 읽은 상품명+옵션, 또는 작업표 칸 값
 * @param {Array} options 공고 선택지(살아 있는 것·마감된 것 모두 — 마감 상품도 "산 상품"일 수 있다)
 * @returns {Set<string>}
 */
function mentionedOptions(text, options) {
  const opts = _prep(options);
  const T = _norm(text);
  const out = new Set();
  if (!T || opts.length < 2) return out;
  const textTokens = new Set(_tokens(text));

  // ① 통째 비교 — 선택지 이름이 글자 안에 있거나, 짧은 글자가 선택지 이름 안에 있거나(작업표 칸 값 `4. 킹(분리난방)`).
  for (const o of opts) {
    const k = _norm(o.key);
    if (k && (T.includes(k) || (T.length >= 2 && k.includes(T)))) out.add(o.key);
  }
  // ② 상품명 — 그 상품명을 가진 선택지가 **하나뿐**일 때만(상품 하나에 옵션 여럿이면 상품명으로는 못 가린다).
  const byProduct = new Map();
  for (const o of opts) {
    const p = _norm(o.product);
    if (!p) continue;
    if (!byProduct.has(p)) byProduct.set(p, []);
    byProduct.get(p).push(o.key);
  }
  for (const [p, keys] of byProduct) {
    if (keys.length === 1 && (T.includes(p) || (T.length >= 2 && p.includes(T)))) out.add(keys[0]);
  }
  // ③ 알맹이 — 모든 선택지에 똑같이 붙은 앞·뒤 글자(안내 꼬리 `배송메세지00<<넣어서구매`)와 앞 번호를 뗀 나머지.
  //   꼬리가 띄어쓰기 없이 붙어 있으면(`퀸더블배송메세지00`) 낱말로는 못 가르기 때문이다.
  const cores = _cores(opts.map(o => _norm(o.key)));
  opts.forEach((o, i) => {
    const c = cores[i];
    if (!c) return;
    if (c.length >= 2 ? T.includes(c) : textTokens.has(c)) out.add(o.key);
  });
  // ④ 그 선택지에만 있는 낱말.
  const tokSets = opts.map(o => new Set([..._tokens(o.key), ..._tokens(o.product)].filter(_usableToken)));
  const df = new Map();
  for (const s of tokSets) for (const t of s) df.set(t, (df.get(t) || 0) + 1);
  opts.forEach((o, i) => {
    for (const t of tokSets[i]) {
      if (df.get(t) !== 1) continue;
      const hit = t.length >= 2 ? T.includes(t) : textTokens.has(t);
      if (hit) { out.add(o.key); break; }
    }
  });
  return out;
}

/** 글자가 가리키는 선택지 **하나**(확신할 때만). 모르거나 둘 이상이면 ''. */
function matchOption(text, options) {
  const m = mentionedOptions(text, options);
  return m.size === 1 ? [...m][0] : '';
}

/**
 * ① 주문 제출 확인 — 캡처가 **다른 상품 하나만** 가리킬 때만 그 키를 돌려준다.
 *   캡처에 고른 상품도 함께 보이면(장바구니 여러 상품 등) 묻지 않는다('').
 */
function capturedOtherOption(captureText, options, chosenKey) {
  const m = mentionedOptions(captureText, options);
  if (m.size !== 1) return '';
  const only = [...m][0];
  return only && only !== String(chosenKey || '') ? only : '';
}

module.exports = { mentionedOptions, matchOption, capturedOtherOption, _norm };
