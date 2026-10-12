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
 *   · 이름·낱말은 "안에 들어 있으면" 걸린다. 단 숫자만·한글 두 글자 이하·영문 세 글자 이하인 **약한 이름**(`킹`·`L`·`100`)은
 *     캡처 쪽에 **그 낱말이 따로** 있어야 걸린다(`킹사이즈`·`polo`·`KS-100` 속 글자로 걸리지 않게).
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

/** "약한 이름" — 다른 말 속 글자로 걸리기 쉽다(`polo` 의 `l`, `KS-100` 의 `100`, `킹사이즈` 의 `킹`).
 *  숫자만 · 한글이 든 두 글자 이하 · 영문/숫자 세 글자 이하. (한글은 한 글자가 정보가 많아 `퀸더블` 은 강한 이름) */
const _weak = (n) => !n || /^\d+$/.test(n) || (/[가-힣]/.test(n) ? n.length <= 2 : n.length <= 3);

/**
 * 그 글자가 **언급하는** 선택지 키 집합.
 * @param {string} text  캡처에서 읽은 상품명+옵션, 또는 작업표 칸 값
 * @param {Array} options 공고 선택지(살아 있는 것·마감된 것 모두 — 마감 상품도 "산 상품"일 수 있다)
 * @param {{shortText?:string}} [opt]
 *   shortText = **약한 이름**을 대조할 글자(낱말이 정확히 같아야 걸린다). 캡처는 옵션 글자만 넘긴다 —
 *   상품명 속 모델번호(`KS-100`)가 사이즈 `100` 으로 걸리지 않게. 생략하면 text 전체.
 * @returns {Set<string>}
 */
function mentionedOptions(text, options, { shortText } = {}) {
  const opts = _prep(options);
  const T = _norm(text);
  if (!T || opts.length < 2) return new Set();
  const allTokens = new Set(_tokens(text));
  // 약한 이름을 대조할 낱말 — shortText(캡처 옵션 글자). 옵션 글자가 비었으면(AI 가 상품명에 다 넣음 — 실측 다수)
  //   상품명 낱말도 쓰되 **숫자만인 낱말은 빼고**(`KS-100` 의 `100` 이 사이즈 `100` 으로 걸리지 않게).
  const shortTokens = new Set(_tokens(shortText === undefined ? text : shortText));
  if (shortText !== undefined && !String(shortText || '').trim()) for (const t of allTokens) if (!/^\d+$/.test(t)) shortTokens.add(t);
  // ★ 하나의 대조 규칙 — 약한 이름은 낱말 일치만, 나머지는 포함. (코드리뷰 Blocker: ①② 에 이 보호가 빠져 있었다)
  const hit = (n) => (_weak(n) ? shortTokens.has(n) : T.includes(n));
  // 짧은 글자가 이름 **안에** 있는 방향(작업표 칸 값 `4. 킹(분리난방)` → 긴 공고 이름) — 글자 자체가 약하면 쓰지 않는다.
  const inside = (n) => !_weak(T) && n.includes(T);
  // ★ 근거는 두 단계 — **강한 근거**(이름·알맹이 통째·구별 낱말 전부)가 하나라도 있으면 그것만 본다.
  //   낱말 하나·모델번호(약한 근거)는 강한 근거가 없을 때만. (운영 캡처 실측: `갈옥 순살 듀오세트` 가
  //   다른 선택지의 낱말 `순살듀오` 에도 걸려 둘로 갈렸다 — 통째로 맞은 쪽을 믿는다.)
  const strong = new Set(), weakEv = new Map();   // weakEv: 키 → 걸린 낱말들
  const strongStr = [];                              // 강한 근거로 맞은 글자(아래 겹침 판정용)
  const addStrong = (key, n) => { strong.add(key); strongStr.push(n); };

  // ① 통째 비교.
  for (const o of opts) {
    const k = _norm(o.key);
    if (k && (hit(k) || inside(k))) addStrong(o.key, k);
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
    if (keys.length === 1 && (hit(p) || inside(p))) addStrong(keys[0], p);
  }
  // ③ 알맹이 — 모든 선택지에 똑같이 붙은 앞·뒤 글자(안내 꼬리 `배송메세지00<<넣어서구매`)와 앞 번호를 뗀 나머지.
  //   꼬리가 띄어쓰기 없이 붙어 있으면(`퀸더블배송메세지00`) 낱말로는 못 가르기 때문이다.
  const cores = _cores(opts.map(o => _norm(o.key)));
  opts.forEach((o, i) => { if (cores[i] && hit(cores[i])) addStrong(o.key, cores[i]); });
  // ④ 구별 낱말 **전부** — 모든 선택지에 있는 낱말·금액 낱말(`178`·`200원`·`3천원`)을 뺀 그 선택지의 낱말이 전부 보이면.
  //   (실측: `12.이지 플로우 밴딩 팬츠 딥네이비 - 결제금액 175,200원(…)` ↔ 캡처 `이지 플로우 밴딩 팬츠 딥네이비`)
  const _money = (t) => /^\d+$/.test(t) || /\d+원$/.test(t) || /천원|만원/.test(t);
  const tokSets = opts.map(o => new Set([..._tokens(o.key), ..._tokens(o.product)].filter(_usableToken)));
  const df = new Map();
  for (const st of tokSets) for (const t of st) df.set(t, (df.get(t) || 0) + 1);
  opts.forEach((o, i) => {
    const desc = [...tokSets[i]].filter(t => df.get(t) < opts.length && !_money(t));
    // 여러 낱말이 함께 맞아야 하므로 약한 낱말(`이지`·`웜`)도 상품명 쪽 **낱말 일치**로 센다.
    const hitAll = (n) => (_weak(n) ? (/^\d+$/.test(n) ? shortTokens.has(n) : allTokens.has(n)) : T.includes(n));
    if (desc.length >= 2 && desc.every(hitAll)) addStrong(o.key, desc.join(''));
  });
  // ⑤ 그 선택지에만 있는 낱말 하나(약한 근거).
  opts.forEach((o, i) => {
    for (const t of tokSets[i]) {
      if (df.get(t) === 1 && hit(t)) { if (!weakEv.has(o.key)) weakEv.set(o.key, []); weakEv.get(o.key).push(t); }
    }
  });
  // ⑥ 모델번호(약한 근거) — 영문+숫자 낱말의 "숫자부터" 부분(`HA-HD1590` → `1590`, `HIA-1450HM` → `1450hm`).
  //   가게는 같은 모델을 다르게 적는다(실측: 캡처 `HAD1590` ↔ 공고 `HA-HD1590`). 숫자 세 자리 이상만,
  //   캡처 쪽에서 앞뒤가 숫자가 아닐 때만(`99000` 속 `9900` 차단). 그 선택지에만 있는 번호만.
  const codesOf = (o) => {
    const out = new Set();
    for (const t of [..._tokens(o.key), ..._tokens(o.product)]) {
      if (!/[a-z]/.test(t) || !/\d/.test(t)) continue;
      const mm = /(\d{3,}[a-z]{0,3})$/.exec(t.replace(/[가-힣]/g, ''));
      if (mm) out.add(mm[1]);
    }
    return out;
  };
  const codeSets = opts.map(codesOf);
  const cdf = new Map();
  for (const st of codeSets) for (const c of st) cdf.set(c, (cdf.get(c) || 0) + 1);
  const A = String(text || '').toLowerCase().replace(/[^0-9a-z]+/g, ' ');
  opts.forEach((o, i) => {
    for (const c of codeSets[i]) {
      if (cdf.get(c) !== 1) continue;
      if (new RegExp('(^|[^0-9])' + c + '($|[^0-9a-z])').test(A.replace(/\s+/g, ' ')) ||
          new RegExp('(^|[^0-9])' + c + '($|[^0-9a-z])').test(A.replace(/\s+/g, ''))) { if (!weakEv.has(o.key)) weakEv.set(o.key, []); weakEv.get(o.key).push(c); }
    }
  });
  if (!strong.size) return new Set(weakEv.keys());
  // 강한 근거가 있으면 그것을 믿되, **다른** 선택지의 약한 근거가 강한 근거 글자 속 일부가 아니면(따로 보이면) 둘 다 —
  //   장바구니에 두 상품이 함께 보이는 캡처를 한쪽으로 단정하지 않는다(완화 금지: 둘 이상이면 모른다).
  const out = new Set(strong);
  for (const [key, toks] of weakEv) {
    if (out.has(key)) continue;
    if (toks.some(t => !strongStr.some(st => st.includes(t)))) out.add(key);
  }
  return out;
}

/** 글자가 가리키는 선택지 **하나**(확신할 때만). 모르거나 둘 이상이면 ''. */
function matchOption(text, options, opt) {
  const m = mentionedOptions(text, options, opt);
  return m.size === 1 ? [...m][0] : '';
}

/**
 * ① 주문 제출 확인 — 캡처가 **다른 상품 하나만** 가리킬 때만 그 키를 돌려준다.
 *   캡처에 고른 상품도 함께 보이면(장바구니 여러 상품 등) 묻지 않는다('').
 */
function capturedOtherOption(captureText, options, chosenKey, opt) {
  const m = mentionedOptions(captureText, options, opt);
  if (m.size !== 1) return '';
  const only = [...m][0];
  return only && only !== String(chosenKey || '') ? only : '';
}

module.exports = { mentionedOptions, matchOption, capturedOtherOption, _norm };
