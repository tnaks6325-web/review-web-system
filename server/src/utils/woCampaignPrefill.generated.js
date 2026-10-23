/* eslint-disable */
'use strict';   // 원본이 즉시실행 함수 안 "use strict" 라 같은 모드로 돈다
// ★★★ 자동 생성 파일 — 손으로 고치지 말 것.
// 원본: frontend/js/work-order-detail.js 의 _woCampaignPrefill 과 의존 선언(글자 그대로).
// 다시 만들기: node scripts/gen-wo-campaign-prefill.js · 가드: tests/woCampaignPrefillGenerated.test.js

function _driveId(url) {
  const s = String(url);
  const m = s.match(/\/file\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/\/d\/([-\w]{20,})/);
  return m ? m[1] : null;
}

const _WO_MACHINE_SECTION_LABELS = ["유입방식", "유입가이드", "유입가이드 첨부 이미지", "링크유입", "리뷰등록 가이드", "리뷰가이드", "리뷰 가이드",
  "특이사항", "배송유형", "물건비", "리뷰유형", "구매 시간대", "일일 진행건수", "합계", "담당AE", "상품/옵션/금액", "상품/옵션/건수",
  "옵션별 건수", "시트참조", "빈박스 택배대행"];

function _woPickSections(raw, keepLabels) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) return "";
  if (!/\[[^\]]+\]/.test(text)) return text.trim();
  const norm = s => s.replace(/\s/g, "");
  const keep = keepLabels.map(norm);
  const machine = _WO_MACHINE_SECTION_LABELS.map(norm);
  const lines = text.split(/\r?\n/);
  const out = [];
  let take = true, buf = [];   // 첫 머리말 앞 글 = 사람이 쓴 내용(남긴다)
  const flush = () => { const c = buf.join("\n").trim(); if (take && c) out.push(c); buf = []; };
  for (const ln of lines) {
    const m = ln.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      flush();
      const label = norm(m[1]);
      if (keep.some(k => label.includes(k))) { take = true; buf = m[2] ? [m[2]] : []; }
      else if (machine.includes(label)) { take = false; buf = []; }
      else { take = true; buf = [ln.trim()]; }   // 사람이 쓴 제목 — 머리말 줄째 남긴다
    } else {
      buf.push(ln);
    }
  }
  flush();
  return out.join("\n\n").trim();
}

function _woCleanGuide(raw) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw).split(/\r?\n/)
    .filter(ln => !/^\s*\[유입가이드\s*첨부\s*이미지\]\s*$/.test(ln))
    .filter(ln => !/^\s*\d+\.\s.*\(.*저장됨\)\s*$/.test(ln))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

function _woProductLines(o) {
  const lines = [];
  // 1) 구조화 JSON 우선
  let arr = null;
  try { const p = JSON.parse(o.product_options_json || "[]"); if (Array.isArray(p) && p.length) arr = p; } catch (_) {}
  if (arr) {
    for (const prod of arr) {
      const name = (prod.name || "").trim();
      const opts = Array.isArray(prod.options) ? prod.options : [];
      if (opts.length) {
        for (const op of opts) {
          const lab = (op.label || "").trim();
          const pay = Number(op.pay) || 0;
          lines.push(`${name}${lab ? " " + lab : ""}${pay ? " - 결제금액 " + pay.toLocaleString() + "원" : ""}`.trim());
        }
      } else {
        const pay = Number(prod.base && prod.base.pay) || 0;
        lines.push(`${name}${pay ? " - 결제금액 " + pay.toLocaleString() + "원" : ""}`.trim());
      }
    }
  } else {
    // 2) product_option 텍스트 파싱: "1. 상품명" + "- [옵션] / 결제금액 N원"
    const cleaned = _woCleanProductOption(o.product_option, o.product_url);
    if (!cleaned) return "";
    let curName = "", curHadOpt = false;
    const flushNameOnly = () => { if (curName && !curHadOpt) lines.push(curName); };
    for (const raw of cleaned.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t) continue;
      const mName = t.match(/^\d+\.\s*(.+)$/);            // "1. 멀티비타민"
      if (mName) { flushNameOnly(); curName = mName[1].trim(); curHadOpt = false; continue; }
      const opt = t.replace(/^[-•]\s*/, "");              // "옵션 없음 / 결제금액 26,900원"
      const payM = opt.match(/결제금액\s*([\d,]+)\s*원/);
      const pay = payM ? payM[1] : "";
      // ★★ 옵션 **없는** 상품의 줄은 인트라넷이 "- 결제금액 22,000원 / 5명 / 소계 …" 로 만든다 —
      //   첫 '/'-조각이 곧 금액 표현이라 그대로 라벨로 쓰면
      //   "상품명 결제금액 22,000원 - 결제금액 22,000원" 오염 문장이 나오고(2026-08-07 우레온 실측),
      //   그 문장이 발행 표로 넘어가 **상품명 조각이 옵션명으로 승격**되는 사고의 재료가 된다.
      //   → 금액·건수 표현을 걷어낸 뒤 남는 글자가 있을 때만 옵션명으로 인정한다.
      let optLabel = opt.split("/")[0]
        .replace(/결제금액\s*[\d,]+\s*원?/g, "")
        .replace(/소계\s*[\d,]+\s*원?/g, "")
        .replace(/^[\s\-–·|]+|[\s\-–·|]+$/g, "")
        .trim();
      if (/^옵션\s*없음$/.test(optLabel)) optLabel = "";   // "옵션 없음" 생략
      if (/^[\d,]+\s*[명건원]?$/.test(optLabel)) optLabel = "";  // 숫자만 남은 조각(건수·금액 잔여) = 옵션명 아님
      lines.push(`${curName}${optLabel ? " " + optLabel : ""}${pay ? " - 결제금액 " + pay + "원" : ""}`.trim());
      curHadOpt = true;
    }
    flushNameOnly();
  }
  const clean = lines.filter(Boolean);
  if (!clean.length) return "";
  // 링크유입이면 상품 순서대로 유입링크를 같은 줄에 붙임
  let withUrl = clean;
  if (o.inflow_type === "link") {
    const urls = _woGuideUrls(o.inflow_guide);
    withUrl = clean.map((l, i) => urls[i] ? `${l} ${urls[i]}` : l);
  }
  if (withUrl.length === 1) return withUrl[0];               // 1개 → 인라인
  return withUrl.map((l, i) => `${i + 1}.${l}`).join("\n");  // 2개+ → 번호+줄바꿈
}

const WO_MANAGER_MAP = { '박세희': '만두', '박은비': '망고' };

function _woManagerNick(raw) {
  const v = _woNormName(raw);
  if (!v) return "";
  for (const [name, nick] of Object.entries(WO_MANAGER_MAP)) if (v.includes(name)) return nick;
  for (const nick of Object.values(WO_MANAGER_MAP)) if (v.includes(nick)) return nick;
  return "";
}

function _woIsBlogKind(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return false;                       // 빈 값 = 리뷰(기존 동작)
  return v === 'blog' || /블로그|blog/i.test(v);
}

function _woCleanProductOption(raw, productUrl) {
  if (!raw || !String(raw).trim()) return "";
  const pu = (productUrl || "").trim();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [];
  for (let ln of String(raw).split(/\r?\n/)) {
    const t = ln.trim();
    if (/^\[?\s*합계/.test(t)) continue;            // [합계]/합계 라인 제거
    if (/^소계\s*[:：]/.test(t)) continue;           // 독립 '소계:' 라인 제거(키트 형식)
    if (/^\[\s*상품/.test(t)) continue;              // [상품/옵션/건수] 헤더 제거(상위 라벨과 중복)
    if (/^[─—\-]{3,}$/.test(t)) continue;            // 구분선 제거
    ln = ln.replace(/\(\s*https?:\/\/[^)]*\)/g, "");  // (http URL) 제거
    if (pu) ln = ln.replace(new RegExp("\\(\\s*" + esc(pu) + "\\s*\\)", "g"), ""); // (상품URL) 제거
    ln = ln.replace(/\s*https?:\/\/\S+/g, "");        // 바레 URL 제거
    // 건수(N명/N건)·소계·라인합계 제거 — 옵션명+결제금액만 남김 (모집인원/총구입비는 아래 필드와 중복)
    ln = ln.replace(/\s*\/\s*소계\s*[\d,]+\s*원/g, "")
           .replace(/\s*\/\s*\d[\d,]*\s*[명건]/g, "")
           .replace(/\s*[×x]\s*\d[\d,]*\s*[명건]/g, "")
           .replace(/\s*=\s*[\d,]+\s*원/g, "")
           .replace(/\s*\/\s*$/, "");
    ln = ln.replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, "");
    out.push(ln);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function _woGuideUrls(raw) {
  const urls = [];
  const re = /https?:\/\/[^\s<]+/g;
  let m;
  while ((m = re.exec(String(raw == null ? "" : raw)))) urls.push(m[0]);
  return urls;
}

function _woNormName(v) { return String(v || "").replace(/\s+/g, "").replace(/[()（）[\]]/g, ""); }

const _WO_DELIVERY_RULES = [
  { base: '택배발송대행', re: /^택배\s*발송\s*대행$/ },
  { base: '직접배송(가구 등)', re: /^직접\s*배송$/ },
  { base: '실배송',       re: /^실\s*배송$/ },
  { base: '빈박스',       re: /^빈\s*(?:택배|박스)$/ },   // 옛 표기 `빈택배` 도 읽어서 접는다
  { base: '회수',         re: /^회수\s*건?$/ },           // 옛 표기 `회수건`
  { base: '혼합',         re: /^(?:혼합|믹스|mix(?:ed)?)$/i },
];

function _woDeliveryBase(v) {
  var s = String(v == null ? '' : v).trim();
  var cut = s.indexOf('(');
  var head = (cut >= 0 ? s.slice(0, cut) : s).trim();
  if (!head) return '';
  for (var i = 0; i < _WO_DELIVERY_RULES.length; i++)
    if (_WO_DELIVERY_RULES[i].re.test(head)) return _WO_DELIVERY_RULES[i].base;
  return '';
}

const WO_CHANNEL_HOSTS = [
  { re: /(^|\.)coupang\.com$|coupangcdn\.com$/i, val: '쿠팡' },
  { re: /(^|\.)naver\.com$|(^|\.)naver\.me$/i,   val: '네이버' },
  { re: /(^|\.)oliveyoung\.co\.kr$/i,            val: '올리브영' },
  /* ★ 카카오는 `makers.kakao.com` 만 잡는다 — `kakao.com` 전체를 잡으면
     톡스토어·선물하기 등 진행 방식이 다른 서비스까지 '카카오메이커스'로 오판한다. */
  { re: /(^|\.)makers\.kakao\.com$/i,            val: '카카오메이커스' },
];

function _woChannelFromUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname; } catch (_) { return ''; }
  const hit = WO_CHANNEL_HOSTS.find(h => h.re.test(host));
  return hit ? hit.val : '';
}

function _woChannel(o) {
  return String(o && o.purchase_channel || '').trim()
      || _woChannelFromUrl(o.product_url)
      || _woChannelFromUrl((typeof _woGuideUrls === "function" ? _woGuideUrls(o.inflow_guide)[0] : "") || "");
}

function _woProductMode(o) {
  try {
    const products = JSON.parse(o.product_options_json || "[]");
    if (!Array.isArray(products) || !products.length) return "";
    const modes = products.map(p => String((p && p.product_mode) || ""));
    if (modes.some(m => m === "opt")) return "opt";
    if (modes.some(m => m === "none")) {
      if (products.length > 1) return "opt";
      // 단일상품 가이드도 상품별 가이드 편집·저장 영역의 대상이다.
      // `_woOptionRows`가 product 단위 행으로 만들고, opt 모드만 그 행을 campaign_options에 저장한다.
      const guide = _woUnitGuide(_woProductUnitSrc(products[0]));
      return (guide.html || guide.images.length) ? "opt" : "none";
    }
    return "";
  } catch (_) {
    return "";
  }
}

const _WO_UNIT_GUIDE_IMG_MAX = 4;

function _woProductUnitSrc(prod) {
  const p = prod || {};
  const base = p.base;
  if (base && typeof base === "object" && (base.guide || base.inflow_guide || base.guide_images)) return base;
  return p;
}

function _woUnitGuide(src) {
  const s = src || {};
  // ★ 계약(PRD §04-1)은 `guide: { text, images }` 객체다. 문자열로 온 경우(옛 초안·수기 편집)도
  //   그대로 글로 읽는다 — `String({})` 이 "[object Object]" 로 새는 것만은 막는다.
  const g = s.guide;
  const gObj = (g && typeof g === "object" && !Array.isArray(g)) ? g : null;
  const raw = String((gObj ? gObj.text : g) ?? s.inflow_guide ?? s.inflowGuide ?? "");
  let html = "";
  if (raw.trim()) {
    html = /<[a-z][^>]*>/i.test(raw)
      ? raw
      // ★ 첨부가 섞인 평문은 공통 유입가이드와 **같은 함수**로 변환한다(사진이 <img> 로 살아난다).
      //   그 함수는 **사진이 하나도 없으면 빈 문자열**을 돌려주므로(설계상 이미지 승격 전용),
      //   글자만 있는 가이드는 여기서 escape 해 보존한다 — 안 그러면 안내문이 통째로 사라진다.
      : ((typeof _woPlainGuideToHtml === "function" ? _woPlainGuideToHtml(raw) : "")
        || raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;").replace(/\n/g, "<br>"));
  }
  const list = (gObj && gObj.images) ?? s.guide_images ?? s.guideImages ?? s.inflow_guide_images ?? [];
  const images = [];
  (Array.isArray(list) ? list : []).forEach(u => {
    const v = String(u || "").trim();
    if (!/^https:\/\/\S*\/api\/order\/guide-image\/[-\w]{20,}$/.test(v)) return;
    if (images.indexOf(v) < 0 && images.length < _WO_UNIT_GUIDE_IMG_MAX) images.push(v);
  });
  return { html, images };
}

function _woOptionRows(o) {
  let arr = null;
  try { const p = JSON.parse(o.product_options_json || "[]"); if (Array.isArray(p) && p.length) arr = p; } catch (_) {}
  if (!arr) return [];
  /** 작업오더 옵션에 실린 혼합 리뷰 수량을 모집공고 옵션행 형식으로 안전하게 보존한다. */
  const optionReviewTypeMix = option => {
    let raw = option && (option.review_type_mix ?? option.reviewTypeMix);
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (_) { raw = []; }
    }
    if (!Array.isArray(raw)) return [];
    const allowed = { photo: true, text: true, confirm: true, star: true };
    const seen = new Set();
    return raw.reduce((mix, entry) => {
      const type = String(entry && entry.type || "").trim();
      const quantity = Math.max(0, Math.floor(Number(entry && entry.quantity) || 0));
      if (!allowed[type] || !quantity || seen.has(type)) return mix;
      seen.add(type);
      mix.push({ type, quantity });
      return mix;
    }, []);
  };
  // 옵션 없는 상품도 리뷰어가 고르는 선택지 하나다. 인트라넷의 상품별 혼합 조합은
  // base.review_type_mix 에 실리므로, 옵션 행과 같은 정화 규칙으로 모집공고 행에 보존한다.
  const productReviewTypeMix = prod => optionReviewTypeMix(prod && (prod.base || prod));
  const clean = s => String(s || "").replace(/\|/g, "").trim();
  const rows = [];
  for (const prod of arr) {
    const name = clean(prod.name);
    const opts = Array.isArray(prod.options) ? prod.options : [];
    // ★ 134 — 상품마다 자기 메인 URL 을 갖는다(복합 작업은 상품이 둘 이상이라
    //   공고 공통 랜딩 하나로는 "그 선택지의 상품 페이지"가 되지 않는다).
    const prodUrl = clean(prod.url || prod.product_url || "");
    const basePay = Number(prod.base && prod.base.pay) || 0;
    // ★ 인트라넷은 일건수를 `daily` 로 보낸다(reviewOrderOptionsPayload) — 그 키를 안 읽으면
  //   오더가 정한 하루 진행 인원이 항상 0 으로 떨어져 발행 자동점검이 계속 빨간 상태가 된다.
  const baseDaily = Math.max(0, Number(prod.base && (prod.base.daily_limit ?? prod.base.dailyLimit ?? prod.base.daily)) || 0);
    if (opts.length) {
      for (const op of opts) {
        const lab = clean(op.label);
        // "옵션 없음"류는 옵션명이 아니라 '옵션이 없다'는 서술 — 옵션 없는 상품 행으로 떨군다.
        const isNone = !lab || /^(옵션\s*없음|없음|단일(상품)?|해당\s*없음)$/.test(lab);
        // ★ 134 — 옵션에 붙은 유입가이드는 그 옵션이 곧 선택지이므로 그대로 따라간다.
        //   "옵션 없음"류로 떨어진 줄은 그 상품 자체가 선택지라 상품(base) 가이드를 쓴다.
        const ug = _woUnitGuide(isNone ? _woProductUnitSrc(prod) : op);
        rows.push({
          productName: name,
          // 옵션 없음으로 접힌 줄은 **상품 단위**(그 상품 자체가 선택지 하나)
          unitKind: isNone ? "product" : "option",
          inflowGuideHtml: ug.html,
          inflowGuideImages: ug.images,
          // ★ 옵션명에 상품명을 붙이지 않는다 — opt_key 는 시트 옵션열에 그대로 기입되므로
          //   상품명이 섞이면 리뷰형태(텍스트/포토리뷰) 칸이 상품명으로 덮이는 사고가 난다.
          optKey: isNone ? "" : lab,
          // 옵션 링크가 비면 그 상품의 메인 URL 로 접는다(공고 공통 랜딩으로 떨어지면 남의 상품이 열린다)
          optionUrl: clean(op.url || op.option_url || "") || prodUrl,
          // ★ 결정 277 — 그 줄이 속한 상품의 메인 주소(공고 창 상품 카드의 "상품 메인 URL" · 옵션 주소와 따로 저장)
          productUrl: prodUrl,
          payAmount: Number(op.pay) || basePay,
          // 옵션별 정원·일건수까지 오더 입력값을 그대로 모집공고 표에 적용한다.
          recruitTotal: Math.max(0, Number(op.count) || 0),
          dailyLimit: Math.max(0, Number(op.daily_limit ?? op.dailyLimit ?? op.daily) || 0),
          // "옵션 없음"은 옵션 행이 아니라 상품 자체 선택지다. 이 형태도 인트라넷이
          // base.review_type_mix 에 보낸 상품별 조합을 써야 발행 검증에서 재입력이 생기지 않는다.
          reviewTypeMix: isNone ? productReviewTypeMix(prod) : optionReviewTypeMix(op),
        });
      }
    } else if (name) {
      // ★ 옵션이 없는 상품 — 상품명을 옵션명으로 승격시키지 않는다(상품명 칸으로만 간다).
      //   ★★ 134: 그 상품 자체가 리뷰어의 선택지 하나다(unitKind='product') — 자기 링크·가이드를 갖는다.
      const ug = _woUnitGuide(_woProductUnitSrc(prod));
      rows.push({
        productName: name, optKey: "", unitKind: "product",
        payAmount: basePay, optionUrl: prodUrl, productUrl: prodUrl,
        // ★ 옵션 줄이 `op.count` 를 그대로 쓰듯, 옵션 없는 상품도 오더가 정한 인원(base.count)을 따른다.
        //   0 으로 두면 그 선택지만 "무제한"이 되어 복합 작업의 정원 합계가 통째로 무너진다(테섭 실측).
        recruitTotal: Math.max(0, Number(prod.base && prod.base.count) || 0), dailyLimit: baseDaily,
        inflowGuideHtml: ug.html, inflowGuideImages: ug.images,
        reviewTypeMix: productReviewTypeMix(prod),
      });
    }
  }
  // 서로 다른 상품에 같은 옵션명이 있을 때만 상품명을 붙여 구분(옵션명은 공고 안에서 유일해야 한다).
  const dup = new Map();
  rows.forEach(r => { if (r.optKey) dup.set(r.optKey, (dup.get(r.optKey) || 0) + 1); });
  rows.forEach(r => {
    if (r.optKey && dup.get(r.optKey) > 1 && r.productName) r.optKey = clean(r.productName + " " + r.optKey);
  });
  // 새 인트라넷 오더는 product_mode=opt 로 1개 옵션도 명시한다. 옛 오더는 종전처럼
  // 옵션이 2개 이상일 때만 옵션 작업으로 추론한다.
  //  → 종전대로 빈 배열을 돌려 텍스트 분해 경로(parseProductLinesToRows)로 넘긴다(동작 불변).
  // 이 함수는 작업오더 화면·단독 회귀 테스트에서도 실행된다. 별도 보조함수에 의존하지 않고
  // 같은 JSON에서 명시 모드를 읽어, 기존 오더의 2개 이상 추론 규칙과 함께 유지한다.
  // ★★ 134 — 상품마다 모드가 다를 수 있으므로 **어느 상품이든** 명시가 있으면 그 구조를 그대로 믿는다.
  //   (첫 상품만 보던 종전 판정은 "상품A=옵션 있음 / 상품B=옵션 없음" 복합 작업에서
  //    상품B 만 있는 순서로 오면 구조를 통째로 버렸다.)
  const explicitMode = arr.some(p => p && String(p.product_mode || ""));
  return explicitMode || rows.filter(r => r.optKey).length >= 2 ? rows : [];
}

function _woPlainGuideToHtml(raw) {
  const cleaned = (typeof _woCleanGuide === "function") ? _woCleanGuide(raw) : String(raw || "");
  if (!cleaned.trim()) return "";
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts = cleaned.split(/(https?:\/\/[^\s<]+)/g);
  let html = "", hasImg = false;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const url = parts[i];
      const isProxy = /\/api\/order\/guide-image\/[-\w]{20,}/.test(url);
      const id = (typeof _driveId === "function") ? _driveId(url) : "";
      if (isProxy) { html += `<img src="${esc(url)}" alt="유입가이드 이미지">`; hasImg = true; }
      else if (id) { html += `<img src="https://drive.google.com/thumbnail?id=${id}&sz=w1600" alt="유입가이드 이미지">`; hasImg = true; }
      else html += `<a href="${esc(url)}">${esc(url)}</a>`;
    } else {
      html += esc(parts[i]).replace(/\n/g, "<br>");
    }
  }
  return hasImg ? html : "";
}

function _woReviewImgHtml(raw, existingHtml) {
  const urls = (typeof _woGuideUrls === "function") ? _woGuideUrls(raw) : [];
  const seen = String(existingHtml || "");
  let out = ""; const used = {};
  for (const u of urls) {
    let src = "", tok = "";
    const pm = String(u).match(/\/api\/order\/guide-image\/([-\w]{20,})/);
    // 호스트는 신뢰 베이스(API_BASE_URL)로 재구성 — 매칭 URL의 임의 호스트를 그대로 쓰지 않음(Drive 분기와 동일)
    if (pm) { tok = pm[1]; src = (typeof API_BASE_URL !== "undefined" ? API_BASE_URL : "") + "/api/order/guide-image/" + tok; }
    else { const id = (typeof _driveId === "function") ? _driveId(u) : null; if (id) { src = "https://drive.google.com/thumbnail?id=" + id + "&sz=w1600"; tok = id; } }
    if (!src || !tok) continue;
    // 파일ID 토큰 기준 중복 제거(교차 오리진 프록시 URL 이중노출 방지)
    if (used[tok] || seen.indexOf(tok) >= 0) continue;
    used[tok] = 1;
    const esc = String(src).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    out += `<img src="${esc}" alt="유입가이드 이미지">`;
  }
  return out;
}

function _woGuideImages(o, section) {
  try {
    const v = o && o.guide_images;
    if (!v) return [];
    const parsed = Array.isArray(v) || (v && typeof v === "object") ? v : JSON.parse(String(v));
    const arr = Array.isArray(parsed) ? (section && section !== "inflow" ? [] : parsed) : (parsed && parsed[section || "inflow"]);
    return Array.isArray(arr) ? arr.filter(u => typeof u === "string" && u.trim()) : [];
  } catch (_) { return []; }
}

function _woBuildInflowHtml(o) {
  if (o.inflow_type === "link") return "";
  let base = "";
  if (o.inflow_guide) {
    base = /<[a-z][^>]*>/i.test(o.inflow_guide) ? o.inflow_guide
         : (typeof _woPlainGuideToHtml === "function" ? _woPlainGuideToHtml(o.inflow_guide) : "");
  }
  const structImgs = _woReviewImgHtml(_woGuideImages(o, "inflow").join("\n"), base);
  const imgs = structImgs + _woReviewImgHtml(o.review_guide, base + structImgs);
  if (!imgs) return base;   // 승격할 이미지 없음 → base 그대로(빈 문자열이면 평문 경로)
  // 이미지는 있는데 base가 비면(평문 inflow_guide·이미지 없음) 그 텍스트를 escape해 함께 보존
  if (!base && o.inflow_guide && !/<[a-z][^>]*>/i.test(o.inflow_guide)) {
    const cleaned = (typeof _woCleanGuide === "function") ? _woCleanGuide(o.inflow_guide) : String(o.inflow_guide || "");
    if (cleaned) base = cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }
  return base + imgs;
}

function _woStripReviewMeta(raw) {
  if (!raw || !String(raw).trim()) return "";
  return String(raw).split(/\r?\n/)
    .filter(ln => !/^\s*\[(유입방식|유입가이드|링크유입)\]/.test(ln))                          // 유입 라벨 줄(전문 폴백 케이스)
    .filter(ln => !/^\s*\[[^\]]*첨부\s*이미지\]\s*$/.test(ln))                                 // [유입가이드 첨부 이미지]
    .filter(ln => !/^\s*\d+\.\s.*\((?:[^)]*(?:저장됨|업로드))[^)]*\)\s*$/.test(ln))            // 1. 파일명.png (29KB, Drive 저장됨)
    .filter(ln => !/^\s*https?:\/\/\S*(?:guide-image\/|drive\.google\.com)\S*\s*$/i.test(ln))  // 첨부 저장 주소 단독 줄
    .filter(ln => !/^\s*(?:쿠팡\s*)?상품번호\s*[:：]/.test(ln))                                // 쿠팡상품번호: …
    .filter(ln => !/^\s*▶\s*옵션\s*[:：]\s*결제금액\s*◀/.test(ln))                            // ▶옵션:결제금액◀…
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function _woFirstProductInfo(o) {
  // 1) 구조화 JSON 우선
  try {
    const p = JSON.parse(o.product_options_json || "[]");
    if (Array.isArray(p) && p.length) {
      const prod = p[0] || {};
      const name = (prod.name || "").trim();
      const opts = Array.isArray(prod.options) ? prod.options : [];
      const pay = opts.length ? (Number(opts[0] && opts[0].pay) || 0) : (Number(prod.base && prod.base.pay) || 0);
      if (name || pay) return { name, price: pay ? pay.toLocaleString("ko-KR") + "원" : "" };
    }
  } catch (_) {}
  // 2) product_option 텍스트 폴백: "1. 상품명" 줄 + 첫 "결제금액 N원"
  const cleaned = (typeof _woCleanProductOption === "function")
    ? (_woCleanProductOption(o.product_option, o.product_url) || "")
    : String(o.product_option || "");
  const nm = cleaned.match(/^\s*\d+\.\s*(.+)$/m);
  const name = (nm ? nm[1] : (cleaned.split(/\r?\n/).map(s => s.trim()).find(s => s && !/^[-•]/.test(s)) || "")).trim();
  const pm = cleaned.match(/결제금액\s*([\d,]+)\s*원/);
  return { name, price: pm ? pm[1] + "원" : "" };
}

function _woCampaignPrefill(o) {
  o = o || {};
  const _pi = (typeof _woFirstProductInfo === "function") ? _woFirstProductInfo(o) : { name: "", price: "" };
  // 유입가이드 HTML(본문 + review_guide에 섞여온 첨부 이미지 승격) — 아래 wd_inflow_html/text 분기에 공용
  const _wdInflowHtml = (typeof _woBuildInflowHtml === "function") ? _woBuildInflowHtml(o) : "";
  const prefill = {
    // ★ 공고 제목 = 상품명 우선(리뷰어 노출용 — 업체명·건수·배송유형 미노출), 없으면 오더 제목 폴백. 관리자 자유 수정 가능.
    title:         _pi.name || o.title || "",
    time_range:    o.purchase_time || "",
    review_fee:    Number(o.review_fee ?? o.reviewFee ?? 0) || 0,
    max_slots:     o.recruit_count || 0,
    chat_url:      o.chat_room_url || "",
    delivery_type: _woDeliveryBase(o.delivery_type),
    // ★ 135: 회수·혼합 부속정보는 **기본형과 함께** 넘긴다 — 발행 폼이 그 값을 채우고
    //   사람이 확인한 뒤 저장하면 공고 원장에도 남는다(작업표 부속 열 보장의 재료).
    delivery_type_mix: o.delivery_type_mix || null,
    recall_courier: o.recall_courier || "",
    recall_product: o.recall_product || "",
    // ★ 087: 리뷰타입 — 인트라넷 발주 폼의 값이 그대로 온다(`포토` · `구매확정` ·
    //   `혼합(포토 10건, 텍스트 20건, …)`). 표준 key 변환은 발행 폼이 하고 저장 시 서버가 다시 정규화한다.
    //   ★ 여기서 미리 변환하지 않는 이유 = 이 모듈은 상세 표시도 겸해 **원문**을 그대로 보여줘야 한다.
    //   ★ 099: 블로그체험단에는 리뷰타입이 없다(별도 축) — 프리필하지 않는다.
    //     여기서 값을 흘리면 발행 폼이 블로그 공고에 리뷰타입을 저장해 캡처 검수가 개입한다.
    review_type:   _woIsBlogKind(o.work_kind) ? "" : (o.review_type || ""),
    review_type_mix: _woIsBlogKind(o.work_kind) ? [] : (o.review_type_mix || []),
    // ★ 099: 체험단 종류 — 발행 폼이 그대로 저장한다(빈 값 = 리뷰 = 기존 동작).
    work_kind:     String(o.work_kind || "").trim(),
    product_url:   o.product_url || "",
    // 모집공고 썸네일(163) — 리뷰오더에서 고른 사진(우리 프록시 URL). 비면 종전처럼 상품정보 자동수집이 채운다.
    thumbnail_url: o.thumbnail_url || "",
    // ★ 상품정보 기본값 = 작업오더 입력 상품명·결제금액 (자동수집 성공 시 그 값으로 덮어씀)
    product_name:  _pi.name || "",
    price:         _pi.price || "",
    // ★ 유의사항(notes)은 프리필하지 않는다(4칸 정리 개선 ① — docs/design-campaign-field-cleanup.html 원인 1).
    //   공고 카드에 **참여 전 모두에게 공개**되는 칸인데 종전엔 "유입방식: ○○" + review_guide 원문 전체를
    //   붙여 넣어 상품번호·옵션:결제금액·내부 섹션 라벨까지 노출됐다(실측: 장수돌침대 공고).
    //   유입방식은 inflowType(구조 필드)이 이미 담당 — 공개용 안내는 관리자가 직접 쓴다.
    notes:         "",
    // ★ 086: 이체은행은 **값을 강제하지 않고 [자동]으로 둔다** — 서버가 이 오더의 물건비
    //   수취방식에서 파생하므로, 값을 박아두면 나중에 오더가 정정돼도 안 따라간다.
    //   여기서는 화면 안내 문구에 판정 근거만 보여준다.
    goods_cost_type: o.goods_cost_type || "",
    // ★ M3: 참여형 자동 프리필 — 작업오더 세부내용을 발행 폼 스냅샷으로 복사
    participation:  true,
    // ★ 062: 작업오더 시작일 → 발행폼 시작일 프리필(시작일 전 게시 시 "오픈 예정" 카운트다운)
    start_date:     (o.start_date || "").slice(0, 10),
    // 주말 제외는 작업오더가 원본이다. 모집공고에는 동일한 값을 보여 주되, 실제 주말 신청 차단은 서버가 강제한다.
    skip_weekends:  o.skip_weekends === true,
    daily_limit:    o.daily_count || (String(o.daily_count_text || "").match(/\d+/) || [])[0] || "",  // 인트라넷 text형("일 10건") 폴백
    recruit_total:  o.recruit_count || 0,
    purchase_time:  o.purchase_time || "",
    // The intake value must reach the new-campaign inflow selector unchanged.
    // Older orders without a value retain the historical link-inflow default.
    inflowType:     o.inflow_type === "guide" ? "guide" : "link",
    wd_product:     (typeof _woProductLines === "function" ? (_woProductLines(o) || "") : "") || (o.product_option || ""),
    // ★ 리뷰 #2: inflow_guide는 HTML(에디터)·평문(인트라넷/레거시) 두 형태 실존 —
    //   태그가 실제로 있을 때만 raw HTML 경로(이미지 보존), 평문은 escape 경로(개행·'<옵션>' 안전)
    //   ★ 평문이라도 첨부 이미지 URL(guide-image/Drive)이 있으면 <img>로 변환해 raw 경로로 —
    //     + review_guide의 [유입가이드 첨부 이미지]에 섞여온 이미지도 유입가이드로 승격(_woBuildInflowHtml)
    wd_inflow_html: _wdInflowHtml,
    wd_inflow_text: o.inflow_type === "link"
      ? "링크유입 — 아래 [상품 페이지 열기] 버튼으로 진입해 구매를 진행하세요."
      : ((!_wdInflowHtml && o.inflow_guide && !/<[a-z][^>]*>/i.test(o.inflow_guide)) ? o.inflow_guide : ""),
    // ★ 리뷰가이드는 [리뷰등록 가이드] 섹션만 스냅샷 + 메타 줄 스트립(4칸 정리 개선 ②) —
    //   [라벨]이 하나도 없어 전문 폴백될 때도 첨부 파일명·저장 URL·상품번호·▶옵션:결제금액◀ 줄은
    //   걷어낸다(구조 필드가 이미 보여주는 값 — 리뷰어 화면 이중 표기의 원인 2·4).
    // 본문 textarea에는 글만 넣는다. 첨부 이미지는 아래 배열로 분리해 발행폼의
    // 사진 스트립에서 렌더한다. 여기서 <img>를 이어 붙이면 textarea에 태그가
    // 문자로 보이고, 저장 시 리뷰어 작업내용까지 태그 문자열로 남는다.
    wd_review:      _woStripReviewMeta(typeof _woPickSections === "function"
                      ? _woPickSections(o.review_guide, ["리뷰등록 가이드", "리뷰가이드", "리뷰 가이드"])
                      : (o.review_guide || "")),
    wd_review_images: _woGuideImages(o, "review"),
    wd_notes:       o.special_notes || "",
    wd_notes_images: _woGuideImages(o, "notes"),
    // ★ 상품 페이지 열기 버튼용 랜딩 — 링크유입일 때만(비링크는 product_url 폴백 제거 = 유입가이드형에 버튼 안 뜸)
    landing_url:    o.inflow_type === "link"
                      ? (((typeof _woGuideUrls === "function" ? _woGuideUrls(o.inflow_guide)[0] : "") || "") || o.product_url || "")
                      : "",
    // 🧩 상품 옵션 프리필: 새 인트라넷의 명시 모드를 우선하고, 옛 오더는 기존 추론을 유지한다.
    options:        (typeof _woOptionRows === "function") ? _woOptionRows(o) : [],
    productMode:    (typeof _woProductMode === "function") ? _woProductMode(o) : "",
    // ★ 065: 구매채널 = 상품 URL 호스트 판정 / 담당자 = 작업담당 매핑(랜덤이면 빈 값=직접결정)
    channel:        _woChannel(o),
    manager:        _woManagerNick(o.work_manager),
    // ★ 접수 시 확정된 연결 탭 — work_sheet_url 은 제출 필수라 접수된 오더는 항상 값이 있다.
    //   탭이 리네임됐을 수 있으므로 gid 도 함께 넘겨 프론트가 gid 우선으로 재매칭한다.
    linked_sheet_id: o.linked_tab_sheet_id || "",
    linked_tab_name: o.linked_tab_name || "",
    linked_tab_gid:  o.linked_tab_gid || "",
    // ★ 미접수 오더 폴백 — 접수 전이라 linked_tab_*가 비어도 URL의 시트ID·gid로 찾아본다
    //   (같은 탭이 앞선 오더로 이미 등록돼 있으면 여기서 잡힌다)
    work_sheet_url:  o.work_sheet_url || "",
  };
  return prefill;
}

module.exports = { _driveId, _woPickSections, _woCleanGuide, _woProductLines, _woManagerNick, _woIsBlogKind, _woCleanProductOption, _woGuideUrls, _woNormName, _woDeliveryBase, _woChannelFromUrl, _woChannel, _woProductMode, _woProductUnitSrc, _woUnitGuide, _woOptionRows, _woPlainGuideToHtml, _woReviewImgHtml, _woGuideImages, _woBuildInflowHtml, _woStripReviewMeta, _woFirstProductInfo, _woCampaignPrefill };
