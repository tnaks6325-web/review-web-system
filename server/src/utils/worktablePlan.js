/**
 * worktablePlan.js — 작업표 생성 "계획" 산출 (M2a · 순수함수)
 *
 * 작업오더 + 표준 열 템플릿 → **무엇을 만들지**(열 구성 · 행 수 · 날짜 분배 · 옵션 배분)를 계산한다.
 * 여기서는 아무것도 만들지 않는다 — 미리보기가 이 결과를 그대로 그리고, 사람이 확인한 뒤에야 생성이 일어난다.
 *
 * ★★ 설계 원칙(되돌리지 말 것)
 *  ① **순수함수**(DB·시트·시각 접근 0) — 미리보기와 실제 생성이 **같은 함수**를 써야
 *     "미리보기 ≠ 실제 표" 가 구조적으로 불가능해진다(campaign-workdetail.js 공용 렌더러와 같은 규율).
 *  ② **열 이름이 곧 동작** — 열 분류는 `worktableTemplate.classifyHeaders`(매퍼 파생) 단일 출처.
 *     여기서 키워드 표를 다시 만들지 않는다.
 *  ③ **채널 목록은 `cashReceiptChannels` 한 벌** — 채널을 늘리면 여기도 자동으로 따라온다.
 *  ④ **막을 것과 알릴 것을 가른다**: `blockers` 는 생성 버튼을 잠그고, `warnings` 는 알리기만 한다.
 *     막는 것은 "그대로 만들면 반드시 잘못된 표가 되는" 경우뿐이다(오탐으로 정상 발행을 막지 않는다 —
 *     옵션 칸 자동점검이 하드블록을 쓰지 않는 것과 같은 판단).
 */
'use strict';

const { classifyHeaders } = require('./worktableTemplate');
const { CASH_RECEIPT_CHANNELS } = require('./cashReceiptChannels');
const { isSheetHeaderRow } = require('./sheetHeader');
// ★ 리뷰 종류(포토/텍스트/구매확정/별점) 표기·판정은 utils/reviewType 단일 출처 —
//   여기서 어휘 표를 다시 만들면 검수(resolveReviewType)와 시트 표기가 갈라진다.
const { REVIEW_TYPE_SHEET_LABELS, isReviewOptionHeader } = require('./reviewType');
const { normalizeReviewTypeMix } = require('./reviewTypeMix');
const { isBlogKind } = require('./workKind');
const { isPostDateHeader } = require('./memoColumn');
const { isTrackingHeader } = require('./trackingColumn');   // 택배송장 열 판정 단일 출처(사본 금지)
const { deliveryBaseType, parseDeliveryType } = require('./deliveryType');   // 배송유형 기본형 판정 단일 출처(사본 금지)
const { normalizeDeliveryTypeMix, DELIVERY_MIX_SHEET_LABELS } = require('./deliveryTypeMix');
const { selectionKey } = require('../services/productOptions.service');
const { isCourierProxy, roundSpec, reviewOptionAssignments } = require('../services/variableWorkboard.service');

const MAX_ROWS = 2000;          // prepareRosterSlots 상한과 같은 값(폭주 방지)
const MAX_DAYS = 400;           // 날짜 분배 무한루프 백스톱

/* ── 채널 판정 — 상품 URL 의 **호스트**만 본다 ────────────────────────────
   ★ 전체 URL 로 매칭하면 `coupang.com/...?src=naver_ad` 를 네이버로 오판하고
     `coupang.com.evil.kr` 에 속는다(프론트 `WO_CHANNEL_HOSTS` 와 같은 규율).
   ★ 카카오는 `makers.kakao.com` 만 — 톡스토어·선물하기는 진행 방식이 다르다.
   ★ 판정 실패는 'unknown' — 틀린 채널로 분류하지 않는다(채널 열이 안 붙을 뿐). */
const CHANNEL_HOST_RE = {
  coupang: /(^|\.)coupang\.com$|coupangcdn\.com$/i,
  naver: /(^|\.)naver\.com$|(^|\.)naver\.me$/i,
  oliveyoung: /(^|\.)oliveyoung\.co\.kr$/i,
  kakao: /(^|\.)makers\.kakao\.com$/i,
};

function channelFromUrl(url) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return 'unknown';
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname; } catch (_) { return 'unknown'; }
  for (const c of CASH_RECEIPT_CHANNELS) {
    const re = CHANNEL_HOST_RE[c.key];
    if (re && re.test(host)) return c.key;
  }
  return 'unknown';
}
/**
 * 채널 라벨 — 기본 4채널 + **템플릿에 직접 추가한 채널**까지 본다.
 * ★ 자동 판정(`channelFromUrl`)은 여전히 기본 4채널만 한다 — 커스텀 채널은 주소로 알아낼
 *   규칙이 없어 담당자가 직접 고른다(틀린 자동 추측보다 안전, 와이어프레임 C 확정).
 */
function channelLabel(key, template) {
  const c = CASH_RECEIPT_CHANNELS.find(x => x.key === key);
  if (c) return c.label;
  const custom = (((template || {}).customChannels) || []).find(x => x && x.key === key);
  return custom ? custom.label : '미상';
}

/* ── 날짜 ────────────────────────────────────────────────────────────────
   ★ Date 산술 대신 Y-M-D 문자열로 다룬다 — 서버 타임존이 무엇이든 결과가 같아야 한다
     (이 값이 시트 구매일자 칸에 그대로 들어가고, 063 시트 일정 인식이 그걸 읽어 모집 정원을 정한다). */
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function parseYmd(v) {
  /* ★★ DB의 DATE 컬럼은 node-pg 가 **Date 객체**로 돌려준다(`work_orders.start_date`).
     문자열로 가정하면 `String(date).slice(0,10)` 가 'Mon Aug 03' 이 되어 조용히 파싱 실패한다
     — 프로덕션 실데이터로 잡은 버그. 문자열 테스트만으로는 드러나지 않는다.
     ★ UTC 로 읽는다: pg 는 DATE 를 UTC 자정으로 주므로 로컬 기준으로 읽으면 서버 TZ 가 음수일 때 하루 밀린다. */
  if (v instanceof Date && !isNaN(v.getTime())) {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  }
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}
function ymdToUtc(o) { return Date.UTC(o.y, o.m - 1, o.d); }
function utcToYmd(t) { const dt = new Date(t); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
function ymdStr(o) { return `${o.y}-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`; }
function dowOf(o) { return new Date(ymdToUtc(o)).getUTCDay(); }
/** 시트 구매일자 표기 — 기존 시트들이 쓰는 `M / D (요일)` 형식 그대로. */
function sheetDateStr(o) { return `${o.m} / ${o.d} (${DOW[dowOf(o)]})`; }
function addDays(o, n) { return utcToYmd(ymdToUtc(o) + n * 86400000); }
function isWeekend(o) { const w = dowOf(o); return w === 0 || w === 6; }

/**
 * 날짜 분배 — 하루 `daily` 건씩, 주말 제외 옵션.
 * 시작일이 없으면 **날짜를 만들지 않는다**(빈 칸 = 담당자가 나중에 채움).
 */
function distributeDates({ total, daily, startDate, skipWeekends = true, holidays = [] } = {}) {
  const n = Math.max(0, parseInt(total, 10) || 0);
  const per = Math.max(0, parseInt(daily, 10) || 0);
  const start = parseYmd(startDate);
  if (!n || !per || !start) return { days: [], rowDates: new Array(n).fill(null) };

  const skip = new Set((holidays || []).map(h => String(h || '').trim()).filter(Boolean));
  const days = [];
  const rowDates = [];
  let cur = start, guard = 0;
  while (rowDates.length < n && guard++ < MAX_DAYS) {
    if ((skipWeekends && isWeekend(cur)) || skip.has(ymdStr(cur))) { cur = addDays(cur, 1); continue; }
    const take = Math.min(per, n - rowDates.length);
    days.push({ date: ymdStr(cur), label: sheetDateStr(cur), dow: DOW[dowOf(cur)], count: take });
    for (let i = 0; i < take; i++) rowDates.push({ date: ymdStr(cur), label: sheetDateStr(cur) });
    cur = addDays(cur, 1);
  }
  while (rowDates.length < n) rowDates.push(null);   // MAX_DAYS 백스톱에 걸린 나머지
  return { days, rowDates };
}

/* ── 옵션 ────────────────────────────────────────────────────────────────
   작업오더 `product_options_json` = [{ name, base:{pay}, options:[{label,pay,count,review_type_mix}] }]
   (프론트 `_woOptionRows`·reviewInspect 와 같은 형태). 옵션 라벨이 곧 시트 옵션 칸 기입값이다.
   ★ 옵션별 지정 수량(`count`)도 함께 추출한다 — 종전엔 라벨만 뽑아 인트라넷이 "A 100건 /
     B 200건"을 보내도 작업표가 균등(150/150)으로 갈라졌다(공고의 옵션별 정원과 어긋남).
     같은 라벨이 두 상품에 걸치면 수량은 **합산**한다. 수량 미상(0·없음)은 null. */
function optionKeysFromWorkOrder(wo) {
  const out = [];
  const byKey = new Map();   // lowercase label → out 항목
  const put = (v, count) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return;
    // ★ "옵션 없음/단일/해당없음" 류는 옵션명이 아니라 서술 — 시트 옵션 칸을 오염시킨다.
    if (/^(옵션\s*없음|없음|단일|해당\s*없음|무옵션|n\/?a)$/i.test(s)) return;
    const n = parseInt(count, 10);
    const c = Number.isInteger(n) && n > 0 ? n : null;
    const k = s.toLowerCase();
    const hit = byKey.get(k);
    if (hit) { if (c != null) hit.count = (hit.count || 0) + c; return; }
    const item = { key: s, count: c };
    byKey.set(k, item);
    out.push(item);
  };
  try {
    const arr = JSON.parse((wo && wo.product_options_json) || '[]');
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const opts = (p && Array.isArray(p.options)) ? p.options : [];
        if (opts.length) opts.forEach(o => put(o && (o.label != null ? o.label : o), o && o.count));
      }
    }
  } catch (_) { /* 깨진 JSON 은 옵션 없음으로 */ }
  return out;
}

// v2는 label이 아닌 상품·단계 값을 배정 단위로 삼는다. 이 함수는 원본을
// 역분해하지 않으며, 구조가 없으면 빈 배열을 돌려 작업표 생성을 막는 쪽을 택한다.
function stagedSelectionsFromWorkOrder(wo) {
  const out = [];
  const seen = new Set();
  try {
    const arr = JSON.parse((wo && wo.product_options_json) || '[]');
    if (!Array.isArray(arr)) return [];
    for (const product of arr) {
      const productName = String(product?.name || '').trim();
      const mode = String(product?.product_mode || '').trim();
      const options = Array.isArray(product?.options) ? product.options : [];
      if (!productName || (mode !== 'opt' && mode !== 'none')) return [];
      if (mode === 'none') {
        if (options.length) return [];
        const key = selectionKey(productName, '', '');
        if (!seen.has(key)) {
          seen.add(key);
          // 인트라넷의 옵션 없는 상품 조합은 `base.review_type_mix`에 저장된다.
          // 종전 최상위 필드는 유효한 조합이 있을 때만 우선한다. 전환기 오더의 빈 []/"[]"는
          // truthy 라도 base 조합을 가리면 안 된다(그러면 작업표 생성이 다시 막힌다).
          out.push({ productName, option1Name: '', option1Value: '', option2Name: '', option2Value: '', selectionKey: key, count: product?.base?.count, review_type_mix: firstUsableReviewTypeMix(product?.review_type_mix, product?.reviewTypeMix, product?.base?.review_type_mix) });
        }
        continue;
      }
      if (!options.length) return [];
      for (const option of options) {
        const option1Name = String(option?.option_1?.name || '').trim();
        const option1Value = String(option?.option_1?.value || '').trim();
        const option2Name = String(option?.option_2?.name || '').trim();
        const option2Value = String(option?.option_2?.value || '').trim();
        if (!option1Name || !option1Value || (!!option2Name !== !!option2Value)) return [];
        const key = selectionKey(productName, option1Value, option2Value);
        if (seen.has(key)) return [];
        seen.add(key);
        out.push({ productName, option1Name, option1Value, option2Name, option2Value, selectionKey: key, count: option?.count, review_type_mix: option?.review_type_mix || option?.reviewTypeMix || [] });
      }
    }
  } catch (_) { return []; }
  return out;
}

/**
 * ★★ 138 — 이 작업오더가 리뷰어에게 **상품을 고르게 하는가**(복합유형 작업 137).
 *   `optionKeysFromWorkOrder` 는 각 상품의 `options[]` 만 모으므로 **옵션 없는 상품은 한 개도 안 잡힌다** —
 *   2026-08-25 「업소용 간장」(상품 3개·옵션 0개)이 정확히 그래서 옵션 배분이 비었고, 그 결과
 *   "고른 값을 적을 칸"이 아무 데도 만들어지지 않았다.
 * ★ 여기서는 **상품 이름**만 센다(옵션 유무 무관) — 상품이 2개 이상이면 리뷰어가 고르는 축이 하나 늘고,
 *   그 선택을 적을 칸이 필요하다. 1개면 고를 여지가 없어 칸을 만들지 않는다(옵션 배분과 같은 문턱).
 * ★ 판정 불가·깨진 JSON 은 **빈 배열**(칸을 만들지 않는다 — 틀린 열을 만드느니 안 만든다).
 */
function productKeysFromWorkOrder(wo) {
  const out = [];
  const seen = new Set();
  try {
    const arr = JSON.parse((wo && wo.product_options_json) || '[]');
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const nm = String((p && (p.name != null ? p.name : p.product_name)) || '').trim();
        if (!nm) continue;
        const k = nm.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); out.push(nm);
      }
    }
  } catch (_) { /* 깨진 JSON 은 상품 없음으로 */ }
  return out;
}

/* ── 리뷰 종류(포토/텍스트/구매확정/별점) 배분 재료 ──────────────────────
   혼합 수량은 두 곳에 실려 온다(migration 107·인트라넷 구조 신호):
     · 오더 전체 : `work_orders.review_type_mix` = [{type:'photo',quantity:10}, …]
     · 옵션별    : `product_options_json` 각 옵션의 `review_type_mix`
   정규화는 `utils/reviewTypeMix.normalizeReviewTypeMix` 단일 출처(모르는 유형·0건 제거). */
function _mixOf(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = v.trim() ? JSON.parse(v) : []; } catch (_) { v = []; } }
  const st = normalizeReviewTypeMix(v);
  return (st && Array.isArray(st.mix)) ? st.mix : [];
}

/** 전환기 필드 중 실제 리뷰 수량이 든 첫 값을 고른다. 빈 배열·빈 JSON은 폴백을 막지 않는다. */
function firstUsableReviewTypeMix(...candidates) {
  return candidates.find(candidate => _mixOf(candidate).length) || [];
}

function reviewMixFromWorkOrder(wo) {
  return _mixOf(wo && wo.review_type_mix);
}

/** 옵션 라벨(lowercase) → 그 옵션의 혼합 수량. mix 없는 옵션은 항목 자체가 없다. */
function optionReviewMixesFromWorkOrder(wo) {
  const map = new Map();
  try {
    const arr = JSON.parse((wo && wo.product_options_json) || '[]');
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const opts = (p && Array.isArray(p.options)) ? p.options : [];
        for (const o of opts) {
          const label = String((o && (o.label != null ? o.label : o)) || '').trim();
          if (!label) continue;
          const mix = _mixOf(o && (o.review_type_mix != null ? o.review_type_mix : o.reviewTypeMix));
          if (mix.length) map.set(label.toLowerCase(), mix);
        }
      }
    }
  } catch (_) { /* 깨진 JSON = 옵션별 mix 없음 */ }
  return map;
}

/** 혼합 수량 합을 목표 줄 수에 맞춘다(비율 유지 · largest remainder). 합이 같으면 무변경. */
function _scaleMix(mix, target) {
  const sum = mix.reduce((a, b) => a + b.quantity, 0);
  if (!mix.length || sum <= 0 || target <= 0) return { mix: [], scaled: false };
  if (sum === target) return { mix, scaled: false };
  const exact = mix.map(m => m.quantity * target / sum);
  const base = exact.map(Math.floor);
  let left = target - base.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const o of order) { if (left <= 0) break; base[o.i]++; left--; }
  return { mix: mix.map((m, i) => ({ type: m.type, quantity: base[i] })).filter(m => m.quantity > 0), scaled: true };
}

/**
 * 한 묶음(행 인덱스 목록)에 혼합 수량을 **날짜별 비율 유지**로 배정한다(사용자 확정).
 * 앞 행부터 몰아 적으면(포토 10행 → 텍스트 20행) 앞 날짜가 전부 포토가 되어
 * "매일 포토 3·텍스트 7" 같은 운영 의도가 깨진다.
 * ★ 같은 날짜 안에서는 mix 순서 블록(포토들 → 텍스트들) — 같은 날이라 순서는 의미가 없고
 *   시트에서 읽기 좋다. 날짜 없는 행(시작일 미정)은 마지막 한 묶음으로 취급.
 * ★ 호출 전 `_scaleMix` 로 합계 == 줄 수를 맞춰 두므로 전 행이 채워진다(캡 보정은 안전망).
 */
function _allocByDateRatio(rowIdxs, dateOf, mix, out, labelOf) {
  /* ★ 라벨 맵 주입 — 리뷰 종류와 배송 혼합이 **같은 배분기**를 쓴다(사본 금지).
     인자를 생략하면 종전 동작 그대로(리뷰 종류 표기). */
  const _label = typeof labelOf === 'function' ? labelOf : (t) => REVIEW_TYPE_SHEET_LABELS[t] || null;
  const groups = [];
  let cur = null;
  for (const i of rowIdxs) {
    const d = dateOf(i) || '';
    if (!cur || cur.date !== d) { cur = { date: d, idxs: [] }; groups.push(cur); }
    cur.idxs.push(i);
  }
  const remaining = mix.map(m => ({ type: m.type, left: m.quantity }));
  let rowsLeft = rowIdxs.length;
  for (const g of groups) {
    const gn = g.idxs.length;
    const exact = remaining.map(r => (rowsLeft > 0 ? r.left * gn / rowsLeft : 0));
    const take = exact.map((v, i) => Math.min(Math.floor(v), remaining[i].left));
    let left = gn - take.reduce((a, b) => a + b, 0);
    const order = exact.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i);
    for (const o of order) {
      if (left <= 0) break;
      if (remaining[o.i].left - take[o.i] > 0) { take[o.i]++; left--; }
    }
    for (let i = 0; left > 0 && i < remaining.length; i++) {   // 안전망(수량이 모자라는 경우)
      const add = Math.min(remaining[i].left - take[i], left);
      if (add > 0) { take[i] += add; left -= add; }
    }
    let p = 0;
    remaining.forEach((r, i) => {
      for (let k = 0; k < take[i]; k++) out[g.idxs[p++]] = _label(r.type);
      r.left -= take[i];
    });
    rowsLeft -= gn;
  }
}

/**
 * 리뷰 종류 배분 — 행마다 리뷰옵션 칸에 적을 표기(`포토리뷰`·`텍스트`·`구매확정`·`별점`)를 정한다.
 *
 * 모드(위에서부터 첫 성립):
 *   ① 옵션별 — 옵션 배분이 있고 **모든** 옵션에 혼합 수량이 실려 오면, 옵션 묶음 안에서
 *      그 옵션의 수량을 날짜별 비율로 배정(합이 다르면 그 묶음 안에서 비율 유지 스케일).
 *   ② 전역   — `work_orders.review_type_mix` 를 전체 행에 날짜별 비율로 배정.
 *   ③ 없음   — 유형이 **2가지 미만이면 행에 적지 않는다**(단일 유형은 공고·탭 리뷰타입이
 *      이미 담당 — 옵션 배분의 "1개 이하 미배분"과 같은 규율).
 */
function distributeReviewTypes({ total, rowDates = [], rowOptions = [], globalMix = [], optionMixes = null } = {}) {
  const n = Math.max(0, parseInt(total, 10) || 0);
  const out = new Array(n).fill(null);
  const none = { rowReviewTypes: out, reviewBuckets: [], mode: 'none', scaled: false };
  if (!n) return none;
  const dateOf = (i) => (rowDates[i] ? rowDates[i].date : null);

  const allOpted = n > 0 && rowOptions.length >= n && rowOptions.slice(0, n).every(Boolean);
  const optKeysInRows = allOpted ? [...new Set(rowOptions.slice(0, n).map(k => String(k).toLowerCase()))] : [];
  const optionMode = allOpted && optionMixes instanceof Map && optKeysInRows.length > 0
    && optKeysInRows.every(k => (optionMixes.get(k) || []).length > 0);

  let scaled = false;
  const bucketCount = new Map();   // 표기 → 최종 배정 수(미리보기 요약용)

  if (optionMode) {
    // 전체적으로 유형이 2가지 미만이면 모드와 무관하게 적지 않는다(③).
    const kinds = new Set();
    optKeysInRows.forEach(k => (optionMixes.get(k) || []).forEach(m => kinds.add(m.type)));
    if (kinds.size < 2) return none;
    for (const k of optKeysInRows) {
      const idxs = [];
      for (let i = 0; i < n; i++) if (String(rowOptions[i]).toLowerCase() === k) idxs.push(i);
      const sc = _scaleMix(optionMixes.get(k) || [], idxs.length);
      if (sc.scaled) scaled = true;
      _allocByDateRatio(idxs, dateOf, sc.mix.map(m => ({ ...m })), out);
    }
  } else {
    const mix = (Array.isArray(globalMix) ? globalMix : []).filter(m => m && REVIEW_TYPE_SHEET_LABELS[m.type] && m.quantity > 0);
    if (mix.length < 2) return none;
    const sc = _scaleMix(mix, n);
    scaled = sc.scaled;
    _allocByDateRatio(Array.from({ length: n }, (_, i) => i), dateOf, sc.mix.map(m => ({ ...m })), out);
  }

  for (const l of out) { if (l) bucketCount.set(l, (bucketCount.get(l) || 0) + 1); }
  const reviewBuckets = [...bucketCount.entries()].map(([label, count]) => ({ label, count }));
  return { rowReviewTypes: out, reviewBuckets, mode: optionMode ? 'option' : 'global', scaled };
}

/* ── 배송 혼합(실배송/빈박스) 배분 ──────────────────────────────────────
   ★★ 리뷰 종류 혼합과 **같은 규율**이다 — 혼합 오더는 "어느 줄이 실배송인가"의 답이
     행에만 있다. 조합만 저장하고 행에 안 적으면 담당자가 표에서 물류를 가를 수 없다.
   ★ 재료 우선순위 = 구조화 컬럼(135 `work_orders.delivery_type_mix`) → **문장 파싱 폴백**
     (`혼합(실배송 20건, 빈박스 80건)`). 폴백이 있어야 구조화 전송 이전의 과거 오더가
     같은 경로로 흘러간다. */
function deliveryMixFromWorkOrder(wo) {
  const st = normalizeDeliveryTypeMix((wo && wo.delivery_type_mix) ?? undefined);
  if (st.provided && Array.isArray(st.mix) && st.mix.length) return st.mix;
  const parsed = parseDeliveryType(wo && wo.delivery_type);
  if (!parsed.mix) return [];
  const fb = normalizeDeliveryTypeMix(parsed.mix);
  return (fb && Array.isArray(fb.mix)) ? fb.mix : [];
}

/** 회수 부속정보 — 구조화 컬럼 우선, 없으면 문장에서 읽는다(과거 오더 구제). */
function recallInfoFromWorkOrder(wo) {
  const o = wo || {};
  const parsed = parseDeliveryType(o.delivery_type);
  if (parsed.base !== '회수') return null;
  const courier = String(o.recall_courier || (parsed.recall && parsed.recall.courier) || '').trim();
  const product = String(o.recall_product || (parsed.recall && parsed.recall.product) || '').trim();
  return { courier, product };
}

/**
 * 배송 혼합 배분 — 행마다 `배송구분` 칸에 적을 표기(`실배송`·`빈박스`)를 정한다.
 * ★ 배분기는 리뷰 종류와 **같은 `_allocByDateRatio`**(날짜별 비율 유지) — 앞 행부터 몰아
 *   적으면 앞 날짜가 전부 실배송이 되어 물류 배분 의도가 깨진다.
 * ★ **유형이 2가지 미만이면 행에 적지 않는다** — 한 종류뿐이면 배송유형 값이 이미 담당한다
 *   (옵션 배분·리뷰 종류 배분의 "1개 이하 미배분"과 같은 규율).
 */
function distributeDeliveryTypes({ total, rowDates = [], globalMix = [] } = {}) {
  const n = Math.max(0, parseInt(total, 10) || 0);
  const out = new Array(n).fill(null);
  const none = { rowDeliveryTypes: out, deliveryBuckets: [], scaled: false };
  if (!n) return none;
  const mix = (Array.isArray(globalMix) ? globalMix : [])
    .filter(m => m && DELIVERY_MIX_SHEET_LABELS[m.type] && m.quantity > 0);
  if (mix.length < 2) return none;
  const sc = _scaleMix(mix, n);
  if (!sc.mix.length) return none;
  _allocByDateRatio(
    Array.from({ length: n }, (_, i) => i),
    (i) => (rowDates[i] ? rowDates[i].date : null),
    sc.mix.map(m => ({ ...m })), out,
    (t) => DELIVERY_MIX_SHEET_LABELS[t] || null,
  );
  const c = new Map();
  for (const l of out) { if (l) c.set(l, (c.get(l) || 0) + 1); }
  return {
    rowDeliveryTypes: out,
    deliveryBuckets: [...c.entries()].map(([label, count]) => ({ label, count })),
    scaled: sc.scaled,
  };
}

/**
 * 옵션 배분 — 지정 수량이 있으면 그대로, 없으면 균등(나머지는 앞 옵션부터 1개씩).
 * ★ 옵션이 1개 이하면 배분하지 않는다(옵션 칸을 비워 둔다 — 선택지가 하나뿐이면 기입 의미가 없다).
 */
function normalizeProductDistributionMode(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'sequential'
    ? 'sequential'
    : 'balanced';
}

function distributeOptions({ total, options = [], includeSingle = false, distributionMode = 'balanced' } = {}) {
  const n = Math.max(0, parseInt(total, 10) || 0);
  const keys = (options || [])
    .map(o => (typeof o === 'string' ? { key: o, count: null } : { key: String((o && o.key) || ''), count: o && o.count }))
    .filter(o => o.key.trim());
  if (!n || (!includeSingle && keys.length < 2) || !keys.length) return { buckets: [], rowOptions: new Array(n).fill(null) };

  const explicit = keys.filter(k => Number.isInteger(parseInt(k.count, 10)) && parseInt(k.count, 10) >= 0);
  let buckets;
  if (explicit.length === keys.length) {
    buckets = keys.map(k => ({ key: k.key, count: parseInt(k.count, 10) }));
  } else {
    const base = Math.floor(n / keys.length), rem = n % keys.length;
    buckets = keys.map((k, i) => ({ key: k.key, count: base + (i < rem ? 1 : 0) }));
  }
  const rowOptions = [];
  if (normalizeProductDistributionMode(distributionMode) === 'sequential') {
    for (const b of buckets) {
      for (let i = 0; i < b.count && rowOptions.length < n; i++) rowOptions.push(b.key);
    }
  } else {
    /* 기본값: 상품·옵션을 입력 순서대로 한 번씩 순환한다. 날짜는 이 행 순서를 그대로
       하루 배정량으로 나누므로, 1번→2번→3번→4번이 날짜 경계에서도 끊기지 않는다. */
    const remaining = buckets.map(bucket => bucket.count);
    while (rowOptions.length < n) {
      let added = false;
      for (let i = 0; i < buckets.length && rowOptions.length < n; i++) {
        if (remaining[i] <= 0) continue;
        rowOptions.push(buckets[i].key);
        remaining[i] -= 1;
        added = true;
      }
      if (!added) break;
    }
  }
  while (rowOptions.length < n) rowOptions.push(null);   // 합계 미달분은 빈 칸(경고로 알린다)
  return { buckets, rowOptions };
}

/* ── 열 구성 ─────────────────────────────────────────────────────────────
   작업표의 열 = **공통 + 그 채널 행 + 켠 작업유형**. 이미 담긴 이름은 건너뛴다(같은 열 2번 방지).

   ★ 순서(와이어프레임 D 확정): `[번호·구매일자 등 자동 열] + [앞쪽 유형] + [나머지 공통] +
     [채널] + [뒤쪽 유형]`. 옵션·리뷰옵션처럼 작업지시 칸은 앞쪽(front), 택배송장번호처럼
     기록용 칸은 뒤쪽(back)에 붙인다.
   ★ **유형을 하나도 안 켜면 종전과 완전히 같은 순서**(공통 → 채널) — 안 쓰면 무변화. */
function buildColumns({ template, channel, workTypes, tabOpts = {} } = {}) {
  const norm = (arr) => (arr || []).map(s => String(s || '').trim()).filter(Boolean);
  const core = norm((template && template.core));
  const chan = norm((((template && template.channels) || {})[channel]));

  /* 켠 작업유형 = 템플릿의 유형 중 `workTypes`(키 배열)에 포함된 것. 순서는 템플릿 순서 그대로. */
  const wantedKeys = new Set((Array.isArray(workTypes) ? workTypes : []).map(k => String(k || '').trim()).filter(Boolean));
  const types = ((template && template.workTypes) || []).filter(t => t && wantedKeys.has(t.key));
  const frontCols = [];
  const backCols = [];
  types.forEach(t => {
    const target = t.position === 'front' ? frontCols : backCols;
    norm(t.columns).forEach(n => target.push({ name: n, typeKey: t.key }));
  });

  /* 공통의 **앞머리 자동 열**(번호·구매일자)을 찾는다 — 앞쪽 유형은 그 뒤에 온다.
     ★ 분류는 매퍼 파생 단일 출처를 그대로 쓴다(여기서 '번호'·'일자' 규칙을 다시 만들지 않는다). */
  const coreCls = classifyHeaders(core, tabOpts);
  let autoPrefix = 0;
  while (autoPrefix < coreCls.length && coreCls[autoPrefix].tier === 'auto') autoPrefix++;

  const seen = new Set();
  const names = [];
  const origin = [];
  const typeKeys = [];
  const push = (n, org, tk) => {
    const k = String(n).toLowerCase();
    if (seen.has(k)) return;                 // 이미 담긴 열 = 작업표에 같은 열 2번 생성 차단
    seen.add(k); names.push(n); origin.push(org); typeKeys.push(tk || null);
  };
  core.slice(0, autoPrefix).forEach(n => push(n, 'common'));
  frontCols.forEach(c => push(c.name, 'worktype', c.typeKey));
  core.slice(autoPrefix).forEach(n => push(n, 'common'));
  chan.forEach(n => push(n, 'channel'));
  backCols.forEach(c => push(c.name, 'worktype', c.typeKey));

  const cls = classifyHeaders(names, tabOpts);
  return cls.map((c, i) => ({
    name: c.header, role: c.role, label: c.label, tier: c.tier, conflict: c.conflict || null,
    origin: origin[i], typeKey: typeKeys[i],
  }));
}

/* 택배발송대행은 선택형 작업유형이 아니라 주문 이행에 필요한 고정 입력값이다.
   관리자가 작업유형 템플릿을 아직 만들지 않았어도 송장 입력 열은 빠지면 안 된다. */
const COURIER_PROXY_TRACKING_HEADER = '택배송장번호';
const V2_COURIER_PROXY_TRACKING_HEADER = '송장번호';

/* 배송 혼합 배분을 적을 칸. 리뷰 종류의 `리뷰옵션` 과 같은 자리·같은 규율(없으면 자동 추가). */
const DELIVERY_KIND_HEADER = '배송구분';

/* 회수 작업의 부속정보 칸 — 업체가 접수하는 회수택배사·회수상품명칭.
   ★ 오더 단위 값이지만 **줄마다 채운다**: 표는 정렬·필터로 흩어지므로 줄이 스스로를 설명해야 한다
     (옵션 값을 줄마다 적는 것과 같은 규율). */
const RECALL_HEADERS = ['회수택배사', '회수상품명칭'];

function isCourierProxyWorkOrder(wo = {}) {
  const courierProxy = wo.courier_proxy;
  return courierProxy === true
    || /^(true|t|y|yes|1|예)$/i.test(String(courierProxy == null ? '' : courierProxy))
    || /택배\s*발송\s*대행/.test(String(wo.delivery_type == null ? '' : wo.delivery_type));
}

function hasCourierTrackingColumn(columns = []) {
  return columns.some((column) => isTrackingHeader(column && column.name));
}

function systemCourierTrackingColumn() {
  const [classified] = classifyHeaders([COURIER_PROXY_TRACKING_HEADER], {});
  return {
    name: classified.header,
    role: classified.role,
    label: classified.label,
    tier: classified.tier,
    conflict: classified.conflict || null,
    origin: 'system',
    typeKey: 'courier_proxy',
  };
}

/* ── 블로그체험단 필수 3열 (127 · 사용자 확정 2026-08-19) ─────────────────
   블로그 작업표에는 **블로그URL·포스팅결과URL·포스팅제출일**이 반드시 있어야 한다:
     · 블로그URL     — 참여(승인) 시점의 블로거 블로그 주소. 매퍼(orderLedger)가 구매양식
                       제출 때 기입한다(헤더에 '블로그'/'blog' 포함 규칙).
     · 포스팅결과URL — 결과물(쓴 글 주소). 리뷰 제출 때 memo 경로(utils/memoColumn)가 기입.
     · 포스팅제출일  — 결과물 제출 시각을 시스템이 자동 기록(사용자 확정 ⑤).
   ★ 택배송장번호(courier_proxy)와 같은 규율: 템플릿에 없어도 시스템이 붙인다(빠지면 결과물이
     들어갈 칸이 없어 조용히 사라진다). 이미 같은 성격의 열이 있으면 중복 생성하지 않는다.
   ★ 존재 판정은 실제 기입 규칙과 같은 규칙을 쓴다 — 매퍼('블로그'/'blog' 포함)·memoColumn
     (isPostDateHeader / 포스팅≠날짜). 규칙이 갈리면 "만든 칸 ≠ 쓰는 칸"이 된다(회귀가드가 대조). */
const BLOG_REQUIRED_HEADERS = ['블로그URL', '포스팅결과URL', '포스팅제출일'];

function _bnorm(v) { return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ''); }
function _blogColKind(name) {
  const k = _bnorm(name);
  if (isPostDateHeader(name)) return 'postDate';                    // 포스팅제출일 계열
  if (k.includes('포스팅')) return 'postUrl';                        // 포스팅결과URL 계열(memo 기입 칸)
  if (k.includes('블로그') || k.includes('blog')) return 'blogUrl';  // 매퍼의 블로그URL 기입 규칙과 동일
  return null;
}
function isBlogWorkOrder(wo = {}) { return isBlogKind(wo.work_kind); }
function systemBlogColumn(header) {
  const [classified] = classifyHeaders([header], {});
  return {
    name: classified.header, role: classified.role, label: classified.label,
    tier: classified.tier, conflict: classified.conflict || null,
    origin: 'system', typeKey: 'blog',
  };
}
/* ── 리뷰제출 칸 보장 (사용자 확정 2026-08-21 · 표준 이름 = `리뷰`) ────────────
   리뷰 제출 시각이 들어갈 칸이 없으면 **리뷰어가 리뷰를 내도 어디에도 기록되지 않는다**
   (관리자 수동 제출은 `submit_column_missing` 으로 막히고, 자동 기록은 조용히 사라진다).
   ★ 택배송장번호·블로그 3열과 같은 규율: 템플릿에 없어도 시스템이 붙인다.
   ★★ 존재 판정은 **읽는 쪽과 같은 함수**(`columnResolver.findSubmitColumnIndex`) —
     인덱스 빌드가 그 함수로 "이 칸이 리뷰제출 칸"이라고 정하므로, 여기서 다른 규칙을 쓰면
     **만든 칸과 읽는 칸이 갈려** 열을 만들고도 기록이 안 되는 상태가 된다.
   ★ 이미 인정되는 칸이 있으면 만들지 않는다(`리뷰제출`·`리뷰완료` 등 기존 이름 그대로 존중). */
const REVIEW_SUBMIT_HEADER = '리뷰';

function systemReviewColumn() {
  const [classified] = classifyHeaders([REVIEW_SUBMIT_HEADER], {});
  return {
    name: classified.header, role: 'submit', label: '리뷰',
    tier: 'status', conflict: classified.conflict || null,
    origin: 'system', typeKey: null,
  };
}
function ensureReviewColumn(columns) {
  /* ★ 열이 하나도 없는 계획(= 표준 열 미설정)에는 넣지 않는다 — 넣으면 "먼저 설정하라"는 잠금이
     풀려 **리뷰 한 칸짜리 작업표**가 만들어진다(회귀가드가 잡았다). 보장은 표가 성립할 때의 일이다. */
  if (!Array.isArray(columns) || !columns.length) return columns;
  const { findSubmitColumnIndex } = require('../services/columnResolver');
  const names = (columns || []).map(c => c && c.name);
  if (findSubmitColumnIndex(names) >= 0) return columns;
  /* ★ 자리는 **공통(core) 열 바로 뒤** — 표준 열 배치에서 리뷰제출은 결제금액·주문번호 다음의
     상태 칸이다. 맨 뒤에 붙이면 채널 열과 시스템 보장 열(택배송장·블로그 3열)보다 뒤로 가
     "back 유형 열이 맨 뒤"라는 열 순서 계약이 깨진다(회귀가드가 잡았다). */
  let at = -1;
  for (let i = 0; i < columns.length; i++) if (columns[i] && columns[i].origin === 'common') at = i;
  if (at >= 0) columns.splice(at + 1, 0, systemReviewColumn());
  else columns.push(systemReviewColumn());
  return columns;
}

function ensureBlogColumns(columns) {
  const have = new Set(columns.map(c => _blogColKind(c.name)).filter(Boolean));
  BLOG_REQUIRED_HEADERS.forEach(h => {
    const kind = _blogColKind(h);
    if (!have.has(kind)) { columns.push(systemBlogColumn(h)); have.add(kind); }
  });
  return columns;
}

function systemVariableColumn(header, typeKey) {
  const [classified] = classifyHeaders([header], {});
  return {
    name: classified.header,
    role: classified.role,
    label: classified.label,
    tier: classified.tier,
    conflict: classified.conflict || null,
    origin: 'system',
    typeKey,
  };
}

function systemStagedColumn(header) {
  const [classified] = classifyHeaders([header], {});
  return {
    name: classified.header, role: classified.role, label: classified.label,
    tier: classified.tier, conflict: classified.conflict || null,
    origin: 'system', typeKey: 'staged_options',
  };
}

function ensureStagedColumns(columns, selections) {
  const has = (role) => columns.some(column => column.role === role);
  if (!has('product')) columns.push(systemStagedColumn('상품'));
  if (selections.some(selection => selection.option1Value) && !has('option_1')) columns.push(systemStagedColumn('1차옵션'));
  if (selections.some(selection => selection.option2Value) && !has('option_2')) columns.push(systemStagedColumn('2차옵션'));
}

function _removeRoles(columns, roles) {
  for (let i = columns.length - 1; i >= 0; i--) {
    if (roles.has(columns[i].role)) columns.splice(i, 1);
  }
}

function _roleIndex(columns, role) {
  return columns.findIndex(column => column.role === role);
}

/**
 * v2 시스템 가변열은 템플릿 작업유형 선택에 의존하지 않는다. 기존 Group 2의
 * 끝 append 결과도 여기서 제거한 뒤, 사용자 확정 앵커 사이에 정확히 재삽입한다.
 */
function ensureV2VariableColumns(columns, { showRound, showTracking } = {}) {
  const blockers = [];
  const required = ['seq', 'dateStr', 'orderNum', 'memo'];
  for (const role of required) {
    if (_roleIndex(columns, role) < 0) {
      blockers.push({ code: 'v2_required_anchor_missing', message: `v2 작업표에 필요한 ${role} 앵커 열이 없습니다.` });
    }
  }
  if (blockers.length) return blockers;

  // v2 상태열도 시스템 계약이다. 예전 템플릿의 리뷰제출/입금 명칭을 남기면
  // 키워드 파서가 다시 다른 열을 고를 수 있으므로 제거 후 정확한 두 열만 재삽입한다.
  _removeRoles(columns, new Set(['round', 'product', 'option_1', 'option_2', 'review_option_instruction', 'tracking_number', 'submit', 'paid']));
  for (let i = columns.length - 1; i >= 0; i--) {
    if (['리뷰제출', '입금', '입금일자'].includes(String(columns[i].name || '').trim())) columns.splice(i, 1);
  }

  if (showRound) {
    columns.splice(_roleIndex(columns, 'seq'), 0, systemVariableColumn('차수', 'round'));
  }

  const dateIndex = _roleIndex(columns, 'dateStr');
  const productColumns = [systemVariableColumn('상품', 'staged_options')];
  // 실제 1·2차 옵션 열의 필요 여부는 caller가 후속으로 빈 값 열을 빼는 것이 아니라
  // 원본 구조에서 결정해야 한다. 이 함수는 이미 필요한 열만 받도록 아래에서 삽입한다.
  columns.splice(dateIndex + 1, 0, ...productColumns);
  const memoIndex = _roleIndex(columns, 'memo');
  columns.splice(memoIndex, 0, systemVariableColumn('리뷰', 'status'), systemVariableColumn('입금일', 'status'));
  return blockers;
}

function placeV2StagedColumns(columns, selections) {
  const productIndex = _roleIndex(columns, 'product');
  if (productIndex < 0) return;
  const extras = [];
  if (selections.some(selection => selection.option1Value)) extras.push(systemVariableColumn('1차옵션', 'staged_options'));
  if (selections.some(selection => selection.option2Value)) extras.push(systemVariableColumn('2차옵션', 'staged_options'));
  extras.push(systemVariableColumn('리뷰옵션', 'review_type'));
  columns.splice(productIndex + 1, 0, ...extras);
}

function placeV2TrackingColumn(columns, enabled) {
  if (!enabled) return;
  const memoIndex = _roleIndex(columns, 'memo');
  if (memoIndex >= 0) columns.splice(memoIndex + 1, 0, systemVariableColumn(V2_COURIER_PROXY_TRACKING_HEADER, 'courier_proxy'));
}

/* ── 작업유형 자동 선택 조건 ─────────────────────────────────────────────
   "작업오더 내용을 보고 그 유형을 켜 둘까?"를 판정한다(사용자 확정 — 쿠팡 작업 + 상품옵션 2가지면
   채널 쿠팡 + 작업유형 상품옵션이 켜진 표가 만들어져야 한다).

   ★★ 판정은 **여기 한 곳**뿐이다 — 조건 목록은 `worktable.service.WORK_TYPE_TRIGGERS`(화면용 라벨),
     판정은 이 함수(동작). 화면에 판정 사본을 두면 "체크는 켜졌는데 서버는 안 켠" 상태가 된다.
   ★ 조건은 전부 `work_orders` 의 **실제 칸**에서 나온다. 모르는 값·판정 실패는 **켜지 않는다**
     (틀린 열을 만드느니 담당자가 직접 켜는 게 낫다 — 이 화면의 fail-soft 원칙).
   ★ `auto`(기본·옛 저장분) = 종전 동작 = 옵션 열을 가진 유형만 옵션 2종 이상일 때. */
/** 이 작업오더가 그 배송 유형(real|empty)을 실제로 포함하는가 — 기본형 + 혼합 조합으로 판정. */
function _deliveryTriggerHas(wo, kind) {
  const base = deliveryBaseType(wo && wo.delivery_type);
  if (base === (kind === 'real' ? '실배송' : '빈박스')) return true;
  if (base !== '혼합') return false;
  const mix = deliveryMixFromWorkOrder(wo);
  if (!mix.length) return true;   // 조합 미상 = 종전 동작 보존(둘 다 켬)
  return mix.some(m => m.type === kind && m.quantity > 0);
}

function evalWorkTypeTrigger(trigger, ctx = {}) {
  const t = String(trigger || 'auto');
  const wo = ctx.workOrder || {};
  const optionCount = Math.max(0, parseInt(ctx.optionCount, 10) || 0);
  const hasOptionColumn = !!ctx.hasOptionColumn;
  const reviewType = String(wo.review_type == null ? '' : wo.review_type).trim();

  switch (t) {
    case 'never': return false;
    case 'always': return true;
    case 'options_2plus': return optionCount >= 2;
    // ★ boolean 컬럼이지만 문자열('true'/'Y')로 올 수 있어 둘 다 인정한다(빈 값·false 는 안 켬).
    case 'courier_proxy': return wo.courier_proxy === true || /^(true|t|y|yes|1|예)$/i.test(String(wo.courier_proxy || ''));
    /* ★★ 배송유형은 **문장**으로 온다(`혼합(실배송 20건, 빈박스 80건)`) — 기본형으로 접어
       판정한다. 종전 정규식은 그 문장에 글자가 들어 있다는 이유로 걸려 우연히 동작했고,
       `혼합(실배송 0건, 빈박스 100건)` 처럼 **0건인 유형의 열까지 만들었다**.
       ★ 조합을 못 읽으면(형식 미상) 종전처럼 둘 다 켠다 — 모른다고 열을 빼면 배분이 갈 곳을 잃는다. */
    case 'delivery_real': return _deliveryTriggerHas(wo, 'real');
    case 'delivery_empty': return _deliveryTriggerHas(wo, 'empty');
    case 'delivery_recall': return deliveryBaseType(wo.delivery_type) === '회수';
    case 'review_type_set': return reviewType.length > 0;
    case 'auto':
    default:
      return hasOptionColumn && optionCount >= 2;   // 종전 동작 보존
  }
}

/** 조건별 "왜 켜졌는지" 한 줄 — 화면이 그대로 보여 준다(근거 없는 자동 체크 금지). */
function workTypeTriggerReason(trigger, ctx = {}) {
  const wo = (ctx.workOrder || {});
  const n = Math.max(0, parseInt(ctx.optionCount, 10) || 0);
  switch (String(trigger || 'auto')) {
    case 'always': return '항상 켜는 유형';
    case 'options_2plus': return `작업오더에 상품옵션 ${n}가지`;
    case 'courier_proxy': return '작업오더 택배대행 = 예';
    case 'delivery_real': return `작업오더 배송유형 = ${String(wo.delivery_type || '실배송')}`;
    case 'delivery_empty': return `작업오더 배송유형 = ${String(wo.delivery_type || '빈박스')}`;
    case 'delivery_recall': return `작업오더 배송유형 = ${String(wo.delivery_type || '회수')}`;
    case 'review_type_set': return `작업오더 리뷰유형 = ${String(wo.review_type || '')}`.trim();
    case 'auto': default: return `작업오더에 상품옵션 ${n}가지`;
  }
}

/**
 * 작업표 계획 산출 — 미리보기와 실제 생성이 **같이 쓰는** 단일 출처.
 *
 * @param {object} workOrder  work_orders 행(그대로)
 * @param {object} template   { core:[names], channels:{key:[names]} }
 * @param {object} [o]        미리보기에서 사람이 조정한 값(전부 선택)
 *        o.total·o.daily·o.startDate·o.skipWeekends·o.holidays·o.options·o.channel
 */
function buildWorktablePlan({ workOrder, template, options: o = {} } = {}) {
  const wo = workOrder || {};
  const channel = (o.channel && String(o.channel)) || channelFromUrl(wo.product_url);
  /* ★★ 작업유형은 **명시적으로 켠 것만** 반영한다(미전송 = 없음).
     제안(`suggestedWorkTypes`)은 화면이 체크를 미리 해 주는 재료일 뿐, 여기서 조용히 적용하면
     "정하지 않았는데 정해진" 표가 만들어진다(설정 프리셋과 같은 규율). */
  const workTypes = (Array.isArray(o.workTypes) ? o.workTypes : []).map(k => String(k || '').trim()).filter(Boolean);
  const columns = buildColumns({ template, channel, workTypes });
  /* ★ 리뷰 제출 시각이 들어갈 칸은 어느 작업표에나 있어야 한다(2026-08-21).
     ★ **택배송장·블로그 보장보다 먼저** 붙인다 — 나중에 붙이면 "back 유형 열이 맨 뒤"라는
       열 순서 계약이 깨진다(회귀가드가 잡았다). 리뷰는 템플릿 열 바로 뒤(상태 칸 자리). */
  ensureReviewColumn(columns);
  const isV2 = Number(wo.workboard_schema_version) === 2;
  if (!isV2 && isCourierProxyWorkOrder(wo) && !hasCourierTrackingColumn(columns)) {
    columns.push(systemCourierTrackingColumn());
  }
  /* ★ 127: 블로그 작업표에는 필수 3열(블로그URL·포스팅결과URL·포스팅제출일)을 시스템이 보장한다. */
  const isBlogPlan = isBlogWorkOrder(wo);
  if (isBlogPlan) ensureBlogColumns(columns);

  const rawTotal = o.total != null ? o.total : wo.recruit_count;
  const total = Math.max(0, Math.min(parseInt(rawTotal, 10) || 0, MAX_ROWS));
  const daily = Math.max(0, parseInt(o.daily != null ? o.daily : wo.daily_count, 10) || 0);
  // ★ 작업오더의 start_date 는 Date 객체일 수 있다 — parseYmd 로 정규화해 Y-M-D 문자열로 통일.
  const rawStart = o.startDate != null ? o.startDate : (wo.start_date || '');
  const parsedStart = parseYmd(rawStart);
  const startDate = parsedStart ? ymdStr(parsedStart) : '';
  /* 주말 제외 — 우선순위 = ① 미리보기 조정값 ② **작업오더 신호**(097) ③ 기본 제외.
     ★ ②는 `false` 와 "안 보냄"(NULL)을 구분해야 한다 — 구버전 인트라넷의 미전송을 `false` 로
       접으면 주말 제외가 조용히 꺼져 토·일에도 구매일이 잡힌다. */
  const skipWeekends = (o.skipWeekends !== undefined && o.skipWeekends !== null)
    ? o.skipWeekends !== false
    : (wo.skip_weekends === false || wo.skip_weekends === 'false' ? false : true);

  /* 제외 날짜(공휴일·업체 휴무) — ① 미리보기에서 담당자가 지정 ② 없으면 **작업오더 신호**(097).
     ★ 형식이 맞는 값만 받는다(잘못된 값은 조용히 무시 — 날짜 분배가 통째로 깨지는 것보다 낫다). */
  let _rawHolidays = Array.isArray(o.holidays) ? o.holidays : null;
  if (!_rawHolidays) {
    try {
      const parsedWo = Array.isArray(wo.holidays) ? wo.holidays
        : (typeof wo.holidays === 'string' && wo.holidays.trim() ? JSON.parse(wo.holidays) : []);
      _rawHolidays = Array.isArray(parsedWo) ? parsedWo : [];
    } catch (_) { _rawHolidays = []; }
  }
  const holidays = [...new Set(_rawHolidays
    .map(h => String(h == null ? '' : h).trim())
    .filter(h => !!parseYmd(h))
    .map(h => ymdStr(parseYmd(h))))].sort();

  const stagedSelections = isV2 ? stagedSelectionsFromWorkOrder(wo) : [];
  const selectionByKey = new Map(stagedSelections.map(selection => [selection.selectionKey, selection]));
  let optKeys = o.options != null ? o.options : (isV2
    ? stagedSelections.map(selection => ({ key: selection.selectionKey, count: selection.count }))
    : optionKeysFromWorkOrder(wo));
  let optionCountFallbackSum = null;
  let rtDist = { rowReviewTypes: new Array(total).fill(null), reviewBuckets: [], scaled: false };
  let dvDist = { rowDeliveryTypes: new Array(total).fill(null), deliveryBuckets: [], scaled: false };
  let recall = null;

  if (!isV2) {
  /* ★ 옵션별 지정 수량(갭 A) — **오더 파생 경로에만** 완충을 둔다: 수량이 일부 옵션에만
     있거나 합계 ≠ 총 건수(미리보기에서 총 건수를 조정한 경우)면 수량을 버리고 균등으로
     폴백 + 경고. 미리보기에는 옵션 수량을 고칠 칸이 없어 잠그면(`option_sum`) 막다른 길이
     된다. 호출자가 명시로 넘긴 `o.options` 는 종전대로 `option_sum` 잠금(의도가 명시라 다르다). */
  if (o.options == null && Array.isArray(optKeys) && optKeys.length >= 2) {
    const withCount = optKeys.filter(k => k && Number.isInteger(k.count) && k.count > 0);
    if (withCount.length) {
      const sum = withCount.reduce((a, b) => a + b.count, 0);
      if (withCount.length !== optKeys.length || sum !== total) {
        optionCountFallbackSum = sum;
        optKeys = optKeys.map(k => ({ key: k.key, count: null }));
      }
    }
  }
  }
  /* 자동 선택 조건이 세는 "옵션 가지 수" — 배분 형태({key,count})로 와도 같은 수를 센다. */
  const optionKindCount = (Array.isArray(optKeys) ? optKeys : [])
    .map(x => (typeof x === 'string' ? x : String((x && x.key) || ''))).filter(v => v.trim()).length;
  const productDistributionMode = normalizeProductDistributionMode(
    o.productDistributionMode != null ? o.productDistributionMode : wo.product_distribution_mode,
  );
  const { buckets, rowOptions } = distributeOptions({
    total, options: optKeys, includeSingle: isV2, distributionMode: productDistributionMode,
  });
  /* ★★ 127: 블로그체험단은 구매일자를 **미리 정할 수 없다**(모집·승인된 블로거가 생기면 그때 구매).
     날짜를 깔면 리뷰 규칙(그날 정원 파생)이 잘못 작동하므로 구매일자 칸을 통째로 비워 둔다 —
     바를참스킨 0804 시트(번호 1~50 + 구매일자 빈 칸)가 곧 블로그 표의 정상 모양이다. */
  const { days, rowDates } = !isV2 && isBlogPlan
    ? { days: [], rowDates: [] }
    : distributeDates({ total, daily, startDate, skipWeekends, holidays });

  if (!isV2) {
  /* ★★ 리뷰 종류(포토/텍스트/구매확정/별점) 행 배분 — 사용자 확정(2026-08-19).
     시트 시절 직원이 `리뷰옵션` 칸에 손으로 적던 ㉯ 작업옵션(리뷰형태) 선기입을 작업표
     생성이 대신한다. 이 값이 행에 있어야 리뷰어 안내(참여상품 팝업 D)와 행 단위 검수
     (`resolveReviewType` ① 행 우선)가 실제로 돈다 — 혼합 오더는 행에만 답이 있다. */
  rtDist = distributeReviewTypes({
    total, rowDates, rowOptions,
    globalMix: reviewMixFromWorkOrder(wo),
    optionMixes: optionReviewMixesFromWorkOrder(wo),
  });
  /* ★ 배분이 성립하면 `리뷰옵션` 칸이 없을 때 **자동으로 덧붙인다**(courier 송장 열과 같은
     규율 — 칸이 없으면 배분이 조용히 사라진다). 자리 = 자동 열(번호·구매일자) 바로 뒤
     (작업지시 칸은 앞쪽 규칙). 분류는 classifyHeaders 단일 출처. */
  if (rtDist.rowReviewTypes.some(Boolean) && !columns.some(c => isReviewOptionHeader(c.name))) {
    const [rc] = classifyHeaders(['리뷰옵션'], {});
    let at = 0;
    while (at < columns.length && columns[at].tier === 'auto') at++;
    columns.splice(at, 0, {
      name: rc.header, role: rc.role, label: rc.label, tier: rc.tier,
      conflict: rc.conflict || null, origin: 'system', typeKey: null,
    });
  }

  /* ★★ 상품옵션 칸도 **없으면 자동으로 덧붙인다**(2026-08-20 · 리뷰옵션과 대칭).
     종전에는 배분만 해 두고 칸이 없으면 `no_option_column` **경고만** 냈다 — 그런데 그 경고는
     발행 미리보기 한 번만 스쳐 지나가고, 만들어진 표에는 옵션이 들어갈 칸이 영영 없어
     **리뷰어가 고른 옵션이 조용히 사라진다**(8/20 실측 사고). 칸이 없으면 배분이 사라진다는
     점에서 리뷰옵션·택배송장번호와 같은 성질이라 같은 규율로 처리한다.
     ★ 자리 = 자동 열(번호·구매일자) 바로 뒤(작업지시 칸은 앞쪽). 분류는 classifyHeaders 단일 출처.
     ★ 리뷰옵션 칸이 있어도 그건 상품옵션 기입처가 아니다 — 따로 만든다(경고 판정과 같은 규칙). */
  if (buckets.length && !columns.some(c => c.role === 'option' && !isReviewOptionHeader(c.name))) {
    const [oc] = classifyHeaders(['옵션'], {});
    let at = 0;
    while (at < columns.length && columns[at].tier === 'auto') at++;
    columns.splice(at, 0, {
      name: oc.header, role: oc.role, label: oc.label, tier: oc.tier,
      conflict: oc.conflict || null, origin: 'system', typeKey: null,
    });
  }

  /* ★★ 138 「상품」 칸 — 복합유형 작업(137)에서 리뷰어가 고른 **상품**을 적는 전용 칸.
     상품이 곧 선택지인 작업(옵션 없는 상품 2개 이상)은 그 값을 옵션 칸에 쓰지 않으므로
     (8/3 상품명이 작업지시 칸을 덮은 사고 규율 — 유지), 칸이 없으면 선택이 통째로 사라진다.
     ★★ 자리 = **상품옵션 칸 바로 앞**(사용자 확정 2026-08-25 좌측 정렬 = 상품 > 옵션 > 리뷰옵션).
       옵션 칸이 없으면 자동 열(번호·구매일자) 바로 뒤.
     ★ 판정은 매퍼 파생 단일 출처(`productWriteColumns`) — 여기서 '상품' 규칙을 다시 만들면
       **만든 칸 ≠ 쓰는 칸** 으로 갈려 빈 열만 하나 늘어난다. */
  const productKeys = productKeysFromWorkOrder(wo);
  if (productKeys.length >= 2) {
    const { productWriteColumns } = require('../services/orderLedger.service');
    const names = columns.map(c => c && c.name);
    if (!productWriteColumns(names).length) {
      const { PRODUCT_HEADER } = require('../services/orderLedger.service');
      const [pc] = classifyHeaders([PRODUCT_HEADER], {});
      let at = columns.findIndex(c => c.role === 'option' && !isReviewOptionHeader(c.name));
      if (at < 0) { at = 0; while (at < columns.length && columns[at].tier === 'auto') at++; }
      columns.splice(at, 0, {
        name: pc.header, role: pc.role, label: pc.label, tier: pc.tier,
        conflict: pc.conflict || null, origin: 'system', typeKey: null,
      });
    }
  }

  /* ★★ 배송 혼합 배분(2026-08-24 사용자 확정) — 리뷰 종류 배분과 같은 자리·같은 규율.
     혼합 오더는 "어느 줄이 실배송인가"의 답이 행에만 있다. */
  dvDist = distributeDeliveryTypes({ total, rowDates, globalMix: deliveryMixFromWorkOrder(wo) });
  if (dvDist.rowDeliveryTypes.some(Boolean) && !columns.some(c => c.name === DELIVERY_KIND_HEADER)) {
    const [dc] = classifyHeaders([DELIVERY_KIND_HEADER], {});
    let at = 0;
    while (at < columns.length && columns[at].tier === 'auto') at++;
    columns.splice(at, 0, {
      name: dc.header, role: dc.role, label: dc.label, tier: dc.tier,
      conflict: dc.conflict || null, origin: 'system', typeKey: null,
    });
  }

  /* ★★ 회수 작업의 부속정보 칸 — 없으면 자동으로 덧붙인다(택배송장번호와 같은 규율).
     칸이 없으면 업체가 알려 준 회수택배사·회수상품명칭이 표에 갈 곳을 잃는다. */
  recall = recallInfoFromWorkOrder(wo);
  if (recall && (recall.courier || recall.product) && columns.length) {
    RECALL_HEADERS.forEach((h) => {
      if (columns.some(c => c.name === h)) return;
      const [rc2] = classifyHeaders([h], {});
      columns.push({
        name: rc2.header, role: rc2.role, label: rc2.label, tier: rc2.tier,
        conflict: rc2.conflict || null, origin: 'system', typeKey: null,
      });
    });
  }

  }

  const rowSelections = [];
  for (let i = 0; i < total; i++) {
    rowSelections.push(rowOptions[i] ? (selectionByKey.get(rowOptions[i]) || {
      productName: '', option1Name: '', option1Value: rowOptions[i], option2Name: '', option2Value: '', selectionKey: rowOptions[i],
    }) : null);
  }

  const round = isV2 ? roundSpec(wo) : { label: '', blocker: null };
  const courier = isV2 ? isCourierProxy(wo) : { enabled: false, blocker: null };
  let reviewOptions = { labels: new Array(total).fill(''), blocker: null };
  let variableColumnBlockers = [];
  if (isV2 && stagedSelections.length) {
    variableColumnBlockers = ensureV2VariableColumns(columns, { showRound: !!round.label, showTracking: courier.enabled });
    if (!variableColumnBlockers.length) {
      placeV2StagedColumns(columns, stagedSelections);
      placeV2TrackingColumn(columns, courier.enabled);
    }
    reviewOptions = reviewOptionAssignments({
      total,
      selections: stagedSelections,
      rowSelections,
      reviewType: wo.review_type,
      reviewTypeMix: wo.review_type_mix,
    });
  }

  const rows = [];
  for (let i = 0; i < total; i++) {
    rows.push({
      seq: i + 1,
      date: rowDates[i] ? rowDates[i].date : null,
      dateLabel: rowDates[i] ? rowDates[i].label : null,
      optionKey: rowOptions[i] || null,
      reviewOption: rtDist.rowReviewTypes[i] || null,
      deliveryKind: dvDist.rowDeliveryTypes[i] || null,   // `실배송`·`빈박스` — 혼합 오더에서만 채워진다
      recallCourier: (recall && recall.courier) || null,
      recallProduct: (recall && recall.product) || null,
      selection: rowSelections[i],
      roundLabel: round.label,
      reviewOptionLabel: reviewOptions.labels[i] || '',
    });
  }

  /* ── 막을 것(blockers) — 그대로 만들면 반드시 잘못된 표가 되는 경우만 ── */
  const blockers = [];
  if (!total) blockers.push({ code: 'no_total', message: '만들 건수가 0입니다. 총 건수를 입력하세요.' });
  if (total >= MAX_ROWS) blockers.push({ code: 'too_many', message: `한 번에 만들 수 있는 최대 행은 ${MAX_ROWS}개입니다.` });
  if (!columns.length) blockers.push({ code: 'no_columns', message: '표준 열이 정해지지 않았습니다. 설정 › 작업표 표준 열에서 먼저 정하세요.' });
  if (isV2 && !stagedSelections.length) {
    blockers.push({ code: 'invalid_staged_options', message: 'v2 작업의 상품·1차옵션·2차옵션 원본이 올바르지 않습니다.' });
  }
  if (round.blocker) blockers.push({ code: round.blocker, message: '차수 원본(work_series_id/work_round)이 올바르지 않습니다.' });
  if (courier.blocker) blockers.push({ code: courier.blocker, message: '배송유형과 택배발송대행 값이 일치하지 않습니다.' });
  if (reviewOptions.blocker) blockers.push({ code: reviewOptions.blocker, message: '리뷰유형 또는 유형별 수량을 행별로 확정할 수 없습니다.' });
  blockers.push(...variableColumnBlockers);
  const optSum = buckets.reduce((a, b) => a + b.count, 0);
  if (buckets.length && optSum !== total) {
    blockers.push({ code: 'option_sum', message: `옵션 배분 합계(${optSum})가 총 건수(${total})와 다릅니다.` });
  }
  /* ★★ 시스템이 이 줄을 **헤더로 인식하지 못하면 그 탭은 통째로 파싱되지 않는다**
     (인덱스가 안 만들어져 리뷰어 검색·제출·행배정이 전부 죽는다). 게다가 헤더 줄을 못 찾으면
     행 번호가 어긋나 작업대 표와 시트가 따로 논다. 그래서 이건 경고가 아니라 **잠금**이다.
     판정은 인덱스 빌더와 **같은 함수**(isSheetHeaderRow) — 사본을 두면 판정이 갈린다. */
  if (columns.length && !isSheetHeaderRow(columns.map(c => c.name))) {
    blockers.push({
      code: 'header_unrecognizable',
      message: '이 열 구성은 시스템이 "열 이름 줄"로 인식하지 못합니다 — 수취인·연락처·주소·결제금액처럼 시스템이 아는 열을 2개 이상 넣어 주세요.',
    });
  }

  const dup = {};
  // ★ 리뷰옵션 칸은 역할이 'option'이어도 중복으로 세지 않는다 — 리뷰형태 전용 칸이라
  //   상품옵션 칸과 기입 대상이 서로 배제된다(planToSheetValues·행배정 매칭이 같은 판정).
  columns.forEach(c => {
    if (!c.role || (c.role === 'option' && isReviewOptionHeader(c.name))) return;
    dup[c.role] = (dup[c.role] || 0) + 1;
  });
  const dupRoles = Object.keys(dup).filter(r => dup[r] > 1);

  /* ── 알릴 것(warnings) — 생성은 되지만 사람이 알아야 하는 것 ── */
  const warnings = [];
  if (isBlogPlan) {
    // 리뷰 규칙의 날짜 경고(no_start_date 등)는 blog 에선 전부 오탐 — 대신 사실을 한 줄로 말한다.
    warnings.push({ code: 'blog_no_dates', message: '블로그체험단 — 구매일자는 미리 깔지 않습니다(승인된 블로거가 구매할 때 채워집니다). 블로그URL·포스팅결과URL·포스팅제출일 열이 자동 포함됩니다.' });
  }
  else if (!startDate) warnings.push({ code: 'no_start_date', message: '시작일이 없어 구매일자 칸을 비워 둡니다. 날짜가 없으면 그날 모집 정원이 시트에서 파생되지 않습니다.' });
  else if (!daily) warnings.push({ code: 'no_daily', message: '일건수가 없어 날짜를 나누지 않았습니다.' });
  else if (rows.some(r => !r.date)) warnings.push({ code: 'date_short', message: '날짜를 다 채우지 못했습니다(기간이 너무 깁니다). 일건수를 확인하세요.' });
  if (channel === 'unknown') warnings.push({ code: 'unknown_channel', message: '상품 URL로 구매채널을 알 수 없어 채널 전용 열(예: 쿠팡ID)을 넣지 않았습니다.' });
  if (dupRoles.length) warnings.push({ code: 'duplicate_role', message: `같은 역할의 열이 둘 이상입니다(${dupRoles.join(', ')}) — 리뷰어 제출이 두 칸에 같은 값을 씁니다.` });
  const conflicts = columns.filter(c => c.conflict);
  if (conflicts.length) warnings.push({ code: 'status_conflict', message: `상태 칸과 제출 기입이 겹치는 열이 있습니다: ${conflicts.map(c => c.name).join(', ')}` });
  /* 진행 기간 밖의 제외 날짜는 아무 영향이 없다 — 오타·잘못 고른 날일 수 있어 알려 준다.
     (기간 안의 제외일은 그날이 빠진 것 = 정상 동작이라 알릴 것이 없다.) */
  if (holidays.length && days.length) {
    const first = days[0].date, last = days[days.length - 1].date;
    const outside = holidays.filter(h => h < first || h > last);
    if (outside.length) warnings.push({ code: 'holiday_outside', message: `제외 날짜 중 진행 기간 밖이라 영향이 없는 날: ${outside.join(', ')}` });
  }
  /* ★ 옵션 칸은 위에서 **자동으로 덧붙였다** — 템플릿에 없어서 시스템이 만든 경우 그 사실을 알린다
     (조용한 자동 추가 금지). 종전 `no_option_column` 경고(칸이 없어 기입 안 됨)는 도달 불가. */
  if (buckets.length && columns.some(c => c.origin === 'system' && c.role === 'option' && !isReviewOptionHeader(c.name))) {
    warnings.push({ code: 'option_column_added', message: '표준 열에 옵션 칸이 없어 시스템이 「옵션」 열을 추가했습니다(리뷰어가 고른 옵션이 이 칸에 기입됩니다).' });
  }
  /* ★ 138 — 상품 칸도 시스템이 만들었으면 **말한다**(조용한 자동 추가 금지 — 옵션 칸과 같은 규율). */
  if (columns.some(c => c.origin === 'system' && c.name === '상품')) {
    warnings.push({ code: 'product_column_added', message: '상품이 여러 개라 시스템이 「상품」 열을 추가했습니다(리뷰어가 고른 상품이 이 칸에 기입됩니다).' });
  }
  if (optionCountFallbackSum != null) {
    warnings.push({ code: 'option_count_mismatch', message: `작업오더의 옵션별 수량 합계(${optionCountFallbackSum}건)가 총 건수(${total}건)와 달라 균등 배분했습니다.` });
  }
  if (rtDist.scaled) {
    warnings.push({ code: 'review_mix_scaled', message: '리뷰 종류별 수량 합계가 총 건수와 달라 비율을 유지해 맞춰 배분했습니다.' });
  }
  /* ★ 배송 조합도 같은 규율 — 조용한 보정 금지(리뷰 조합과 **독립**으로 판정한다). */
  if (dvDist.scaled) {
    warnings.push({ code: 'delivery_mix_scaled', message: '배송 유형별 수량 합계가 총 건수와 달라 비율을 유지해 맞춰 배분했습니다.' });
  }
  /* ★ 날짜를 나눠 놓고 쓸 칸이 없으면 조용히 사라진다 — 게다가 구매일자 칸이 없으면
     시트 일정 자동 인식이 그날 모집 정원을 파생하지 못한다(발행폼 값 경로로 되돌아간다). */
  if (days.length && !columns.some(c => c.role === 'dateStr')) {
    warnings.push({ code: 'no_date_column', message: '날짜를 나눴지만 표에 구매일자 열이 없어 기입되지 않습니다 — 그날 모집 정원도 시트에서 파생되지 않습니다. 공통 열에 구매일자 칸을 추가하세요.' });
  }

  /* ── 작업유형 목록 + 자동 제안 ────────────────────────────────────────
     ★ 제안 근거는 **열 역할에서 파생**한다 — 유형 이름이 자유 문자열이라 이름으로 맞추면
       '상품옵션'을 '옵션종류'로 바꾼 순간 제안이 조용히 죽는다. 옵션 열(role='option')을 가진
       유형은 작업오더 옵션이 2종 이상일 때 제안한다(옵션 1종 이하는 배분 자체를 안 한다).
     ★ 제안은 **체크를 미리 해 주는 것까지** — 확정은 담당자가 한다(학습은 제안까지 규율). */
  const allTypes = ((template && template.workTypes) || []).map(t => {
    const cols = classifyHeaders((t.columns || []).map(s => String(s || '').trim()).filter(Boolean), {});
    const hasOption = cols.some(c => c.role === 'option');
    const trigger = String(t.autoTrigger || 'auto');
    /* ★ 옵션 개수는 **배분 결과(buckets)가 아니라 작업오더가 말한 옵션 종류 수**로 센다 —
       배분은 총 건수가 0이면 비어 있어서, "건수를 아직 안 정한 오더"에서 제안이 조용히 죽는다. */
    const ctx = { workOrder: wo, optionCount: optionKindCount, hasOptionColumn: hasOption };
    const suggested = evalWorkTypeTrigger(trigger, ctx);
    return {
      key: t.key, label: t.label, desc: t.desc || '', position: t.position === 'front' ? 'front' : 'back',
      autoTrigger: trigger,
      columns: cols.map(c => ({ name: c.header, role: c.role, label: c.label, tier: c.tier })),
      suggested,
      suggestReason: suggested ? workTypeTriggerReason(trigger, ctx) : '',
      enabled: workTypes.includes(t.key),
    };
  });
  const suggestedWorkTypes = allTypes.filter(t => t.suggested).map(t => t.key);

  /* 켠 유형인데 그 열이 하나도 안 붙었다면(전부 이미 있는 이름) 조용히 사라진 것처럼 보인다. */
  const emptyTypes = allTypes.filter(t => t.enabled && !columns.some(c => c.typeKey === t.key));
  if (emptyTypes.length) {
    warnings.push({
      code: 'worktype_no_column',
      message: `켠 작업유형에 새로 붙은 열이 없습니다(${emptyTypes.map(t => t.label).join(', ')}) — 이미 공통·채널에 같은 이름의 열이 있습니다.`,
    });
  }

  return {
    channel, channelLabel: channelLabel(channel, template),
    channels: (typeof template === 'object' && template) ? _channelChoices(template) : [],
    columns,
    rows,
    dates: days,
    productDistributionMode,
    optionBuckets: buckets,
    reviewBuckets: rtDist.reviewBuckets,
    deliveryBuckets: dvDist.deliveryBuckets,
    workTypes: allTypes,
    enabledWorkTypes: workTypes,
    suggestedWorkTypes,
    totals: { rows: total, days: days.length, daily, columns: columns.length },
    startDate, skipWeekends, holidays,
    blockers, warnings,
    canCreate: blockers.length === 0,
  };
}

/** 고를 수 있는 채널 목록(기본 4 + 직접 추가) — 미리보기 드롭다운이 그대로 쓴다. */
function _channelChoices(template) {
  const custom = ((template.customChannels) || []).map(c => ({ key: c.key, label: c.label, custom: true }));
  return CASH_RECEIPT_CHANNELS.map(c => ({ key: c.key, label: c.label, custom: false })).concat(custom);
}

module.exports = {
  buildWorktablePlan, buildColumns, distributeDates, distributeOptions, normalizeProductDistributionMode,
  distributeReviewTypes, reviewMixFromWorkOrder, optionReviewMixesFromWorkOrder,
  BLOG_REQUIRED_HEADERS, ensureBlogColumns, isBlogWorkOrder,
  REVIEW_SUBMIT_HEADER, ensureReviewColumn,
  productKeysFromWorkOrder,   // 138 — 상품 축 판정(작업오더 기준)
  DELIVERY_KIND_HEADER, RECALL_HEADERS,
  deliveryMixFromWorkOrder, recallInfoFromWorkOrder, distributeDeliveryTypes,
  optionKeysFromWorkOrder, stagedSelectionsFromWorkOrder, ensureStagedColumns, channelFromUrl, channelLabel, sheetDateStr,
  evalWorkTypeTrigger, workTypeTriggerReason,
  MAX_ROWS,
};
