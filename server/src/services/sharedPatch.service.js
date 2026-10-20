// ═══════════════════════════════════════════════════════════════════════════
// 양방향 공유 저장 — 연결된 작업오더의 공유 칸을 한 트랜잭션에서 고치고 공고까지 맞춘다 (결정 263 · 3단계)
//
// ★★ 쓰기 단일 출처 — 연결(`bidir_state='on'`)된 오더의 공유 칸은 이 함수로만 바뀐다.
//    판정은 `utils/sharedPatchPlan`(3방향), 공고 반영은 기존 전파 본체(`*InTx`)를 같은 트랜잭션에서 부른다.
// ★★ 부분 반영 금지 — 보기전용·아직 못 고치는 칸(그리고 정책이 block 일 때 충돌)이 하나라도 있으면 아무것도 쓰지 않고 409.
//    인트라넷발(`conflictPolicy:'last_writer'`)은 겹친 칸을 나중 저장 값으로 쓰고 덮인 값을 `overwritten` 으로 돌려준다(사용자 확정 2026-10-20).
//    공고 반영이 거부되면(가이드 없는 가이드유입·읽지 못한 구매시간) 오더 쓰기까지 통째로 되돌린다.
// ★★ 잠금 순서(완화 금지 · 결정 262) — L1(`recruit_campaign_wo:<오더>`) → 오더 행 → 공고 행.
//    3단계 칸은 작업표와 무관해 탭 잠금(L2)을 잡지 않는다. 작업표에 닿는 칸(7단계)이 들어오면
//    L2 를 오더 행 잠금 **앞**에 넣는다(결정 182 「탭 잠금은 첫 잠금」).
// ★ 버전 = HLC `GREATEST(이전+1, 현재 µs)` — DB 복원으로 버전이 되돌아가도 새 쓰기가 옛 버전과 겹치지 않는다.
// ★ 3단계에서 고칠 수 있는 칸(`PHASE3_*`) 밖의 변경은 `field_not_editable` 로 막는다 — 다음 단계가 열 때까지.
// ★ 5단계(금액) — 리뷰비(`review_fee`) 칸 + 상품 구성의 결제금액(옵션 `pay` · 옵션 없는 상품 `base` 중 pay 만)을 연다.
//   금액이 바뀌면 같은 트랜잭션에서 결제합계(`pay_amount`)·상품 요약 문장(`product_option`)을 다시 만들고,
//   공고 금액(옵션 금액 · 옵션 없는 공고의 상품 안내 금액)과 리뷰비(지난 참여 금액 고정 · `campaignFeeChange`)까지 맞춘다.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const getPool = () => require('../db/pool');
const { logger } = require('../utils/logger');
const { SHARED_FIELDS, FIELD_BY_KEY } = require('../utils/sharedFields');
const { planSharedPatch, ABSENT, optionKey } = require('../utils/sharedPatchPlan');
const { projectOrderToCampaign } = require('../utils/orderToCampaignProjection');
const { CANON } = require('../utils/sharedFields');

const NEXT_VERSION_SQL = `GREATEST(sync_version + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint)`;

/** 3단계에 양방향으로 여는 공유 칸 — 글 칸 묶음(설계 3단계). */
const PHASE3_SHARED_FIELDS = Object.freeze([
  'review_guide', 'special_notes', 'guide_images', 'inflow_guide', 'inflow_type', 'thumbnail_url',
  'purchase_time', 'product_url', 'purchase_channel', 'purchase_channel_custom', 'required_delivery_memo',
]);
/** 5단계에 양방향으로 여는 금액 칸 — 상품 구성 안의 결제금액은 칸이 아니라 경로(`writablePath`)로 연다. */
const PHASE5_SHARED_FIELDS = Object.freeze(['review_fee']);
/** 7단계-② 인원·일건수 — 총모집·일 진행 건수·리뷰타입 혼합 수량(유형 구성은 그대로일 때만 · `writablePath`).
 *  상품 구성 안의 인원·일건수·혼합 수량은 경로로 연다. */
const PHASE7Q_SHARED_FIELDS = Object.freeze(['recruit_count', 'daily_count', 'review_type_mix']);
/** 리뷰웹 → 인트라넷으로 보내는 칸(수정 창이 리뷰웹 값으로 덮는 칸과 같다). 상품 구성·합계·요약은 금액이 함께 움직이는 짝. */
const PUSH_VIEW_KEYS = Object.freeze([...PHASE3_SHARED_FIELDS, ...PHASE5_SHARED_FIELDS, ...PHASE7Q_SHARED_FIELDS, 'pay_amount', 'product_options_json', 'product_option']);
/** 인트라넷 고유 칸 중 접수 뒤에도 고칠 수 있는 것 — 종전 원본 수정 허용 목록·계약 후속 매칭과 같은 범위. */
const INTRANET_EDITABLE_AFTER_ACCEPT = Object.freeze([
  'title', 'manager_name', 'inflow_keyword', 'sales_id', 'quote_id', 'contract_number', 'intranet_advertiser_id',
]);
/** 리뷰웹발 수정(관리자 오더 수정)이 쓸 수 있는 칸 — 인트라넷 고유는 제외. */
const WRITABLE_BY_ORIGIN = {
  intranet: new Set([...PHASE3_SHARED_FIELDS, ...PHASE5_SHARED_FIELDS, ...PHASE7Q_SHARED_FIELDS, ...INTRANET_EDITABLE_AFTER_ACCEPT]),
  reconcile: new Set([...PHASE3_SHARED_FIELDS, ...PHASE5_SHARED_FIELDS, ...PHASE7Q_SHARED_FIELDS, ...INTRANET_EDITABLE_AFTER_ACCEPT]),
  rw_admin: new Set([...PHASE3_SHARED_FIELDS, ...PHASE5_SHARED_FIELDS, ...PHASE7Q_SHARED_FIELDS]),
  campaign: new Set([...PHASE3_SHARED_FIELDS, ...PHASE5_SHARED_FIELDS, ...PHASE7Q_SHARED_FIELDS]),   // 4단계-2 공고 편집 창(campaignSharedSave) — 리뷰웹발이라 인트라넷 고유 칸은 제외
};
const KNOWN_CHANNELS = new Set(['쿠팡', '네이버', '올리브영', '카카오메이커스']);
const SNAPSHOT_KEYS = Object.freeze([...SHARED_FIELDS.map(f => f.key), 'product_options_json', 'product_option']);

/** 작업오더 행 → 공유 상태(스냅숏·비교용). 날짜는 'YYYY-MM-DD', 나머지는 저장 형태 그대로. */
function readSharedState(wo) {
  const out = {};
  for (const k of SNAPSHOT_KEYS) {
    if (!wo || !Object.prototype.hasOwnProperty.call(wo, k)) continue;
    let v = wo[k];
    if (v instanceof Date) v = Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    out[k] = v === undefined ? null : v;
  }
  return JSON.parse(JSON.stringify(out));
}

function _jsonObj(v) {
  if (!v || v === ABSENT) return null;
  try { const o = JSON.parse(String(v)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; }
}

/** 옵션 없는 상품의 base 칸 — 결제금액(pay) 말고는 그대로인가(인원·일건수·리뷰 조합은 작업표 칸이라 7단계). */
function _onlyBasePayDiffers(row) {
  const b = _jsonObj(row.base), m = _jsonObj(row.mine);
  if (!b || !m) return false;
  const strip = o => { const c = { ...o }; delete c.pay; return CANON.json(c); };
  return strip(b) === strip(m);
}

/** 리뷰 혼합 수량의 유형 구성(포토·텍스트…) — 수량만 바뀌는지 판정용. 형식이 틀리면 null. */
function _mixTypes(v) {
  if (v === ABSENT) return null;
  let raw = v;
  if (typeof raw === 'string') { const t = raw.trim(); if (!t) return ''; try { raw = JSON.parse(t); } catch (_) { return null; } }
  if (raw == null) return '';
  if (!Array.isArray(raw)) return null;
  return raw.filter(e => e && Number(e.quantity) > 0).map(e => String(e.type)).sort().join(',');
}

/** 7단계-② — 리뷰 혼합 수량은 **유형 구성이 그대로일 때만**(포토 3→5 는 되고, 텍스트를 새로 넣거나 빼는 것은 4단계 구조). */
function _mixQuantityOnly(bv, mv) {
  const b = _mixTypes(bv), m = _mixTypes(mv);
  return b !== null && m !== null && b === m && b !== '';
}

/** 옵션 없는 상품의 base 칸 — 금액·인원·일건수·혼합 수량(유형 그대로)만 바뀌었는가(7단계-②). */
function _baseQuantityOrPayOnly(row) {
  const b = _jsonObj(row.base), m = _jsonObj(row.mine);
  if (!b || !m) return false;
  if (JSON.stringify(b.review_type_mix ?? null) !== JSON.stringify(m.review_type_mix ?? null)
      && !_mixQuantityOnly(JSON.stringify(b.review_type_mix ?? []), JSON.stringify(m.review_type_mix ?? []))) return false;
  const strip = o => { const c = { ...o }; delete c.pay; delete c.count; delete c.daily; delete c.daily_limit; delete c.dailyLimit; delete c.review_type_mix; return CANON.json(c); };
  return strip(b) === strip(m);
}

/** 7단계-② 인원 경로인가(총모집·일건수·혼합 수량 칸 · 옵션 count/daily/review_type_mix · base 의 인원 쪽 차이). */
function _isQuantityPath(w) {
  const m = w.meta || {};
  if (m.kind === 'field') return PHASE7Q_SHARED_FIELDS.includes(m.key);
  if (m.kind !== 'leaf') return false;
  if (['count', 'daily', 'daily_limit', 'dailyLimit', 'review_type_mix'].includes(m.key)) return true;
  return m.key === 'base' && !_onlyBasePayDiffers(w);
}

/** 판정 행(경로 + 경로 종류)이 이 출처에서 쓸 수 있는가.
 *  상품 쪽 = 주소(url · 3단계) + 결제금액(5단계: 옵션 `pay` · 옵션 없는 상품 `base` 의 pay 만). 상품·옵션을 더하거나 지우는 것은 아직 못 한다. */
function writablePath(row, origin) {
  const set = WRITABLE_BY_ORIGIN[origin];
  if (!set) return false;
  const m = row.meta || {};
  if (m.kind === 'field') {
    if (m.key === 'review_type_mix') return set.has(m.key) && _mixQuantityOnly(row.base, row.mine);
    return set.has(m.key);
  }
  if (m.kind !== 'leaf') return false;
  if (m.key === 'url') return true;
  // 6단계 — 선택지별 유입가이드 {글, 사진}(옵션 guide · 옵션 없는 상품 guide). 옵션·상품 자체를 더하고 지우는 것은 여전히 막힘(그 경로가 따로 판정된다).
  if (m.key === 'guide') {
    // "옵션 없음" 류 라벨 옵션의 가이드는 프리필(리뷰어 화면 투영)이 상품 자리를 읽어 공고에 갈 길이 없다 — 막는다(조용히 갈라지지 않게)
    const lab = String(m.parent || '').split('|o:')[1];
    return !(lab !== undefined && /^(옵션\s*없음|없음|단일(상품)?|해당\s*없음)$/.test(String(lab).trim()));
  }
  const isOption = String(m.parent || '').includes('|o:');
  if (m.key === 'pay' && isOption) return row.base !== ABSENT && row.mine !== ABSENT;
  // 7단계-② 인원·일건수(옵션) — 옵션이 원래 있고 지금도 있을 때만(옵션 더하기·지우기는 구조 단계)
  if (['count', 'daily', 'daily_limit', 'dailyLimit'].includes(m.key) && isOption) return row.base !== ABSENT && row.mine !== ABSENT && set.has('recruit_count');
  if (m.key === 'review_type_mix' && isOption) return row.base !== ABSENT && row.mine !== ABSENT && set.has('review_type_mix') && _mixQuantityOnly(row.base, row.mine);
  if (m.key === 'base' && !isOption) return _onlyBasePayDiffers(row) || (set.has('recruit_count') && _baseQuantityOrPayOnly(row));
  return false;
}

/** 쓰기 행의 상품·옵션 이름 — 판정이 붙인 경로 종류(meta.parent)에서 읽는다(이름 속 '.' 을 글자로 추측하지 않게). */
function _leafTarget(w) {
  const m = w.meta || {};
  if (m.kind === 'leaf' && m.parent) {
    const owner = String(m.parent).slice(2);
    const at = owner.indexOf('|o:');
    return { pName: at < 0 ? owner : owner.slice(0, at), oLabel: at < 0 ? '' : owner.slice(at + 3), leaf: m.key };
  }
  const r = /^p:(.+?)(?:\|o:(.+))?\.(url|pay|base|guide|count|daily|daily_limit|dailyLimit|review_type_mix)$/.exec(w.path);
  return r ? { pName: r[1], oLabel: r[2] || '', leaf: r[3] } : null;
}

/** 사람이 읽는 칸 이름 — 내부 경로(`p:상품|o:옵션.key`)를 그대로 보이지 않는다. 상품·옵션은 이름까지만. */
function _label(rowOrPath) {
  const row = typeof rowOrPath === 'string' ? { path: rowOrPath } : rowOrPath;
  const path = row.path;
  if (path.startsWith('f:')) { const f = FIELD_BY_KEY.get(path.slice(2)); return f ? f.label : path.slice(2); }
  if (path.startsWith('p:')) {
    const owner = (row.meta && row.meta.parent) || path;
    const [prod, opt] = owner.slice(2).split('|o:');
    const name = String(prod || '').trim();
    const what = /\.guide$/.test(path) ? '유입가이드' : '상품·옵션';
    return `${what}(${name && name !== '-' ? name : '상품'}${opt ? ' / ' + opt : ''})`;
  }
  if (path.startsWith('products:')) return '상품·옵션';
  return path;
}

/** 알림에 보일 값 — 정규화 값을 사람이 읽는 글로. 사진 목록은 장수, 없음·빈칸은 말로, 길면 자른다. */
function _display(path, v) {
  if (v === ABSENT || v === undefined) return '(없음)';
  if (v === null || v === '') return '(빈칸)';
  if (path === 'f:guide_images') { const l = _parseList(v); if (l) return l.length ? `사진 ${l.length}장` : '(사진 없음)'; }
  if (/\.guide$/.test(path)) {
    try { const g = JSON.parse(String(v)); const t = String(g && g.text || '').trim(); const n = Array.isArray(g && g.images) ? g.images.length : 0;
      return `${t ? (t.length > 200 ? t.slice(0, 200) + '…' : t) : '(글 없음)'}${n ? ` · 사진 ${n}장` : ''}`; } catch (_) { /* 원문 */ }
  }
  const s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/** 인트라넷발 저장 뒤 — 보낸 값(mine)과 저장 결과가 다른 공유 글 칸(인트라넷이 받아 가야 할 칸). 정규화 값으로 비교. */
function _pushBackKeys(mine, saved) {
  const { canon } = require('../utils/sharedFields');
  const keys = [...PHASE3_SHARED_FIELDS, ...PHASE5_SHARED_FIELDS].filter(k => mine && Object.prototype.hasOwnProperty.call(mine, k)
    && canon(k, mine[k]) !== canon(k, saved[k]));
  if (mine && mine.pay_amount !== undefined && mine.pay_amount !== null && mine.pay_amount !== ''
      && canon('pay_amount', mine.pay_amount) !== canon('pay_amount', saved.pay_amount)) keys.push('pay_amount');
  // 상품 구성 — 그 사이 리뷰웹이 고친 금액·주소와 합쳐졌으면 인트라넷 사본이 낡았다(5단계)
  if (mine && Object.prototype.hasOwnProperty.call(mine, 'product_options_json')
      && CANON.json(mine.product_options_json) !== CANON.json(saved.product_options_json)) keys.push('product_options_json');
  return keys;
}

function _parseList(v) {
  if (Array.isArray(v)) return JSON.parse(JSON.stringify(v));
  try { const p = JSON.parse(String(v || '')); return Array.isArray(p) ? p : null; } catch (_) { return null; }
}

/** theirs 에 쓰기 목록을 적용한 다음 상태. 상품 주소·결제금액은 같은 이름의 상품·옵션에만.
 *  ★ 상품·옵션 짝은 판정과 같은 열쇠(`sharedPatchPlan.optionKey`)로 찾는다. 판정이 쓰라고 했는데 짝을 못 찾은 경로는 `missed` —
 *    호출부가 저장 전체를 거부한다(못 쓴 채 버전만 올리면 두 시스템이 조용히 갈라진다 · 검토 2026-10-20).
 *  payProducts = 결제금액(옵션 pay · base.pay)이 바뀐 상품 이름 — 결제합계를 그 상품들의 실제 금액 차이로 고친다. */
function applyWrites(theirs, mine, writes) {
  const next = JSON.parse(JSON.stringify(theirs || {}));
  let productsTouched = false;
  let urlTouched = false;
  let guideTouched = false;
  let quantityTouched = false;
  const payProducts = new Set();
  const qtyProducts = new Set();
  const missed = [];
  const nextProducts = _parseList(next.product_options_json);
  const mineProducts = _parseList(mine && mine.product_options_json) || [];
  for (const w of writes) {
    if (w.path.startsWith('f:')) { next[w.path.slice(2)] = mine[w.path.slice(2)]; continue; }
    const t = _leafTarget(w);
    if (!t || !nextProducts) { missed.push(w.path); continue; }
    const { pName, oLabel, leaf } = t;
    const findP = list => list.find(p => p && String(p.name || '').trim() === pName);
    const findO = p => (Array.isArray(p && p.options) ? p.options : []).find(o => optionKey(o) === oLabel);
    const tp = findP(nextProducts); const mp = findP(mineProducts);
    if (!tp || !mp) { missed.push(w.path); continue; }
    if (oLabel) {
      const to = findO(tp); const mo = findO(mp);
      if (!to || !mo) { missed.push(w.path); continue; }
      if (leaf === 'url') { to.url = mo.url; urlTouched = true; }
      else if (leaf === 'pay') { to.pay = mo.pay; payProducts.add(pName); }
      else if (leaf === 'guide') { if (mo.guide === undefined) delete to.guide; else to.guide = mo.guide; guideTouched = true; }
      else if (['count', 'daily', 'daily_limit', 'dailyLimit', 'review_type_mix'].includes(leaf)) {   // 7단계-② 인원·일건수·혼합 수량
        if (mo[leaf] === undefined) delete to[leaf]; else to[leaf] = mo[leaf];
        quantityTouched = true; qtyProducts.add(pName);
      }
      else { missed.push(w.path); continue; }
    } else if (leaf === 'url') { tp.url = mp.url; urlTouched = true; }
    else if (leaf === 'guide') { if (mp.guide === undefined) delete tp.guide; else tp.guide = mp.guide; guideTouched = true; }
    else if (leaf === 'base') {
      const tb = tp.base && typeof tp.base === 'object' ? tp.base : {};
      const mb = mp.base && typeof mp.base === 'object' ? mp.base : {};
      const nb = { ...tb, pay: mb.pay };
      if (Number(tb.pay || 0) !== Number(mb.pay || 0)) payProducts.add(pName);
      // 7단계-② — 판정이 base 인원 쪽 차이를 허락했으면(쓰기 경로) 인원·일건수·혼합 수량도 옮긴다
      for (const k of ['count', 'daily', 'daily_limit', 'dailyLimit', 'review_type_mix']) {
        if (JSON.stringify(tb[k] ?? null) !== JSON.stringify(mb[k] ?? null)) { if (mb[k] === undefined) delete nb[k]; else nb[k] = mb[k]; quantityTouched = true; qtyProducts.add(pName); }
      }
      tp.base = nb;
    } else { missed.push(w.path); continue; }
    productsTouched = true;
  }
  if (productsTouched) {
    next.product_options_json = JSON.stringify(nextProducts);
    if (mine && mine.product_option !== undefined) next.product_option = mine.product_option;
  }
  // 인원이 바뀐 상품도 결제합계(상품구입비 = 금액 × 인원)가 바뀐다
  return { next, productsTouched, urlTouched, guideTouched, quantityTouched, payTouched: payProducts.size > 0, payProducts, qtyProducts, missed };
}

/** 상품 하나의 상품구입비 — 인트라넷 totals 와 같은 규칙(옵션 금액이 비면 상품 기본 금액 · `workOrderPayAmounts` 와 같다).
 *  구매수량 단계 상품은 단계별 금액 계산이 따로 있어 null(모름). */
function _productCost(p) {
  if (!p || typeof p !== 'object') return 0;
  const t = p.qty_tiers;
  if (t != null && (Array.isArray(t) ? t.length : (typeof t === 'object' ? Object.keys(t).length : String(t).trim()))) return null;
  const num = v => Number(v) || 0;
  const basePay = num(p.base && p.base.pay);
  const opts = Array.isArray(p.options) ? p.options : [];
  if (opts.length) return opts.reduce((s, op) => s + (num(op && op.pay) || basePay) * num(op && op.count), 0);
  return basePay * num(p.base && p.base.count);
}

/**
 * 결제금액이 바뀐 뒤의 파생 칸 — 결제합계(`pay_amount` = 인트라넷 totals.cost)와 상품 요약 문장(`product_option`).
 * ★ 인트라넷발이고 그 사이 리뷰웹이 상품 구성을 안 고쳤으면 인트라넷이 계산해 보낸 값을 그대로 쓴다(구매수량 단계 금액까지 맞다).
 * ★ 그 밖(공고 창발 · 합쳐진 저장)은 리뷰웹이 만든다 — 합계는 "지금 합계 + 바뀐 상품들의 상품구입비 차이"(옵션 금액이 비면 기본 금액 ·
 *   ★ 합계를 1건당 자리에 쓰지 않는다 · 결정 161). 단계 상품이 끼어 차이를 모르면 인트라넷이 보낸 합계, 그것도 없으면 지금 합계 유지(기록).
 *   요약 문장은 옛 구성으로 다시 만든 문장이 지금 문장과 같을 때만(`orderProductSummary`) — 다르면 옛 문장을 두고 기록.
 */
function derivePayFields({ base, theirs, mine, next, payProducts, origin }) {
  const out = {};
  if (!payProducts || !payProducts.size) return out;
  const untouchedByRw = CANON.json(theirs && theirs.product_options_json) === CANON.json(base && base.product_options_json);
  const minePay = mine && mine.pay_amount !== undefined && mine.pay_amount !== null && mine.pay_amount !== '' ? Math.max(0, Math.floor(Number(mine.pay_amount) || 0)) : null;
  if (origin === 'intranet' && untouchedByRw && minePay != null) out.pay_amount = minePay;
  else {
    const before = _parseList(theirs && theirs.product_options_json) || [];
    const after = _parseList(next.product_options_json) || [];
    const byName = (list, n) => list.find(p => p && String(p.name || '').trim() === n);
    let delta = 0, unknown = false;
    for (const n of payProducts) {
      const a = _productCost(byName(after, n)), b = _productCost(byName(before, n));
      if (a == null || b == null) { unknown = true; break; }
      delta += a - b;
    }
    if (!unknown) out.pay_amount = Math.max(0, (Number(theirs && theirs.pay_amount) || 0) + delta);
    else if (minePay != null) { out.pay_amount = minePay; out.payAmountNote = 'tiers_intranet_value'; }
    else { out.pay_amount = Math.max(0, Math.floor(Number(theirs && theirs.pay_amount) || 0)); out.payAmountNote = 'tiers_kept'; }
  }
  if (!(origin === 'intranet' && untouchedByRw && mine && mine.product_option !== undefined)) {
    const { regenerateSummary } = require('../utils/orderProductSummary');
    const r = regenerateSummary({ prevJson: theirs && theirs.product_options_json, prevText: theirs && theirs.product_option, nextJson: next.product_options_json });
    if (r.text != null) out.product_option = r.text;
    else { out.product_option = theirs ? theirs.product_option : next.product_option; out.summaryKept = r.reason; }
  }
  return out;
}

const ORDER_COLUMNS = new Set([...SNAPSHOT_KEYS]);
const EXTRA_COLUMNS = new Set(['source_revision', 'intake_idempotency_key', 'intranet_advertiser_name',
  'intranet_advertiser_contact', 'intranet_advertiser_business_number']);

const PAY_REJECT_TEXT = {
  option_key_mismatch: '결제금액을 저장하지 않았습니다 — 리뷰오더의 상품·옵션과 모집공고의 상품 줄을 짝지을 수 없어 공고 금액을 바꿀 수 없습니다. 모집공고에서 상품 줄 이름을 먼저 맞춰 주세요.',
  multiple_amounts: '결제금액을 저장하지 않았습니다 — 옵션 없는 공고인데 리뷰오더에 금액이 여러 종류라 공고 상품 안내의 어느 금액인지 정할 수 없습니다. 모집공고에서 먼저 정리해 주세요.',
  campaign_multiple_amounts: '결제금액을 저장하지 않았습니다 — 모집공고 상품 안내에 금액이 여러 개 적혀 있어 어느 것을 바꿀지 정할 수 없습니다. 모집공고에서 먼저 정리해 주세요.',
  no_work_detail: '결제금액을 저장하지 않았습니다 — 모집공고에 상품 안내(작업내용)가 아직 없습니다. 모집공고를 먼저 저장해 주세요.',
};

/**
 * 결제금액 → 공고(같은 트랜잭션). ★ fail-closed — 짝을 못 지으면 {reject} 로 오더 쓰기까지 되돌린다
 * (종전 전파는 "오더만 바뀌고 공고는 옛 금액" 으로 넘어갔다 — 연결 오더에서는 그러면 두 값이 갈라진다 · 사용자 확정 2026-10-20).
 *   ㉮ 옵션 있는 공고: 공고 옵션 줄 금액 — 짝짓기는 옵션 주소 반영과 같은 규칙(발행 프리필 투영의 줄 열쇠). 바뀐 줄만 쓰고 금액 이력을 남긴다.
 *   ㉯ 옵션 없는 공고: 상품 안내 글의 `결제금액 N원` + payAmount — 종전 전파(`campaignPayAmountSync`)와 같은 규칙(금액 한 종류일 때만).
 */
async function _projectPayInTx(client, camp, prev, next, actor) {
  const sync = require('./campaignPayAmountSync.service');
  const { recordOptionPriceChangeInTx } = require('./campaignPriceHistory.service');
  const { rows: optRows } = await client.query(
    `SELECT id, opt_key, product_name, unit_kind, pay_amount FROM campaign_options
      WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'deleted' ORDER BY id FOR UPDATE`, [camp.id]);
  if (optRows.length) {
    const before = new Map(projectOrderToCampaign(prev).options.map(o => [o.key, o]));
    const after = projectOrderToCampaign(next).options;
    const rowsFor = (key) => {
      const [pName, optKey] = key.split('|');
      return optRows.filter(r => (String(r.unit_kind || '') === 'product'
        ? optKey === '' && (r.opt_key === pName || String(r.product_name || '').trim() === pName)
        : optKey !== '' && r.opt_key === optKey));
    };
    let changed = 0;
    const targets = after.length
      ? after.filter(o => !before.has(o.key) || before.get(o.key).pay_amount !== o.pay_amount)
          .map(o => ({ name: o.name, pay: Number(o.pay_amount) || 0, rows: rowsFor(o.key) }))
      // 프리필이 옵션 줄을 만들지 않는 옛 오더인데 공고에는 옵션 줄이 있다 — 종전 전파와 같은 옵션명 짝짓기로
      : (() => {
          const { payAmountsFromWorkOrder } = require('../utils/workOrderPayAmounts');
          const was = new Map(payAmountsFromWorkOrder(prev.product_options_json).units.map(u => [`${u.productName}|${u.optKey}`, u.payAmount]));
          return payAmountsFromWorkOrder(next.product_options_json).units
            .filter(u => was.get(`${u.productName}|${u.optKey}`) !== u.payAmount)
            .map(u => ({ name: u.optKey || u.productName, pay: u.payAmount,
              rows: optRows.filter(r => (u.optKey ? r.opt_key === u.optKey : (r.opt_key === u.productName || String(r.product_name || '').trim() === u.productName))) }));
        })();
    for (const t of targets) {
      if (!t.rows.length) return { reject: { kind: 'pay', out: { applied: false, reason: 'option_key_mismatch', detail: { option: t.name } } } };
      for (const r of t.rows) {
        if (Number(r.pay_amount) === t.pay) continue;
        await client.query('UPDATE campaign_options SET pay_amount = $2, updated_at = NOW() WHERE id = $1', [r.id, t.pay]);
        await recordOptionPriceChangeInTx(client, { campaignId: camp.id, optionId: r.id, oldPay: r.pay_amount, newPay: t.pay, actor });
        changed += 1;
      }
    }
    return { applied: changed > 0 };
  }
  const { payAmountsFromWorkOrder } = require('../utils/workOrderPayAmounts');
  const parsed = payAmountsFromWorkOrder(next.product_options_json);
  if (parsed.single == null) return { reject: { kind: 'pay', out: { applied: false, reason: 'multiple_amounts', detail: { amounts: parsed.distinct } } } };
  const { rows } = await client.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.id]);
  let wd = rows[0] && rows[0].work_detail;
  if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
  if (!wd || typeof wd !== 'object' || Array.isArray(wd)) return { reject: { kind: 'pay', out: { applied: false, reason: 'no_work_detail' } } };
  const lines = String(wd.productLines == null ? '' : wd.productLines);
  const inText = sync.distinctAmountsInText(lines);
  if (inText.length > 1) return { reject: { kind: 'pay', out: { applied: false, reason: 'campaign_multiple_amounts', detail: { amounts: inText } } } };
  const nextLines = inText.length === 1 ? sync.replaceAmountInProductLines(lines, parsed.single) : lines;
  if (nextLines === lines && Number(wd.payAmount || 0) === parsed.single) return { applied: false };
  await client.query('UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1',
    [camp.id, JSON.stringify({ ...wd, payAmount: parsed.single, productLines: nextLines })]);
  return { applied: true };
}

/**
 * 선택지 가이드 → 공고 옵션 줄(같은 트랜잭션 · 6단계).
 * ★ 줄 열쇠·가이드는 발행 프리필 투영(`projectOrderToCampaign` = `_woOptionRows`/`_woUnitGuide`)에서 — 같은 이름 옵션이 두 상품에 있으면
 *   프리필이 상품명을 붙인 열쇠를 만든다(공고 opt_key 와 같다). 짝짓기는 금액 투영과 같은 규칙(상품 줄은 상품명까지 · 마감 줄 제외).
 * ★ 바뀐 줄만 쓴다(나머지는 공고 창 저장 모양 그대로). 공고에 살아 있는 옵션 줄이 0개면(옵션 없는 공고) 줄별 가이드를 둘 자리가 없다 — 건너뛴다(기록).
 *   줄은 있는데 그 선택지 줄만 못 찾으면 통째로 거부(오더만 바뀌고 넘어가지 않게). 가이드유입인데 빈 줄이 생기면 거부(`guide_missing`).
 */
async function _projectGuideInTx(client, camp, prev, next) {
  const { canonGuideKey } = require('../utils/guideCanon');
  const rowsOf = st => {
    const pre = require('../utils/woCampaignPrefill.generated')._woCampaignPrefill(JSON.parse(JSON.stringify(st || {})));
    return (pre.options || []).map(o => ({ key: `${String(o.productName || '').trim()}|${o.unitKind === 'product' ? '' : String(o.optKey || '').trim()}`,
      name: o.optKey || o.productName, html: o.inflowGuideHtml || '', images: Array.isArray(o.inflowGuideImages) ? o.inflowGuideImages : [] }));
  };
  const before = new Map(rowsOf(prev).map(r => [r.key, r]));
  const nextRows = rowsOf(next);
  const changed = nextRows.filter(r => { const b = before.get(r.key); return !b || canonGuideKey(b.html, b.images) !== canonGuideKey(r.html, r.images); });
  if (!nextRows.length) {
    // 옛 형식 오더(상품 모드 표시 없음 · 옵션 1개 이하)는 프리필이 선택지 줄을 만들지 않는다 — 공고에 줄이 있으면 짝을 지을 근거가 없다(거부)
    const { rows: anyLive } = await client.query(`SELECT 1 FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'closed' LIMIT 1`, [camp.id]);
    if (anyLive.length) return { reject: { kind: 'inflow', out: { applied: false, reason: 'option_key_mismatch' },
      error: '선택지 가이드를 저장하지 않았습니다 — 옛 형식 리뷰오더라 모집공고의 상품 줄과 짝을 지을 수 없습니다. 모집공고에서 직접 고쳐 주세요.' } };
    return { applied: false };
  }
  if (!changed.length) return { applied: false };
  const { rows: live } = await client.query(
    `SELECT id, opt_key, product_name, unit_kind, inflow_guide_html, inflow_guide_images FROM campaign_options
      WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'closed' ORDER BY id FOR UPDATE`, [camp.id]);
  if (!live.length) {
    logger.info(`[bidir/apply] ${camp.id} 옵션 줄이 없는 공고 — 선택지 가이드는 공고에 둘 자리가 없어 건너뜀: ${changed.map(r => r.name).join(', ')}`);
    return { applied: false };
  }
  let n = 0;
  for (const r of changed) {
    const [pName, optKey] = r.key.split('|');
    const hits = live.filter(x => (String(x.unit_kind || '') === 'product'
      ? optKey === '' && (x.opt_key === pName || String(x.product_name || '').trim() === pName)
      : optKey !== '' && x.opt_key === optKey));
    if (!hits.length) {
      return { reject: { kind: 'inflow', out: { applied: false, reason: 'option_key_mismatch', detail: { unmatched: [r.name] } },
        error: `선택지 가이드를 저장하지 않았습니다 — 모집공고에서 「${r.name}」 줄을 찾지 못했습니다(공고 쪽 상품 줄 이름이 다릅니다). 모집공고의 상품 줄 이름을 리뷰오더와 맞춘 뒤 다시 저장해 주세요.` } };
    }
    for (const h of hits) {
      if (canonGuideKey(h.inflow_guide_html, h.inflow_guide_images) === canonGuideKey(r.html, r.images)) continue;
      await client.query('UPDATE campaign_options SET inflow_guide_html = $2, inflow_guide_images = $3::jsonb, updated_at = NOW() WHERE id = $1',
        [h.id, r.html, JSON.stringify(r.images)]);
      n += 1;
    }
  }
  // 가이드유입 검사(쓴 뒤 상태로)
  const { rows: wdr } = await client.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1', [camp.id]);
  const wd = (wdr[0] && wdr[0].work_detail && typeof wdr[0].work_detail === 'object') ? wdr[0].work_detail : {};
  if (String(wd.inflowType || '') === 'guide') {
    const { rows: after } = await client.query(
      `SELECT opt_key, product_name, inflow_guide_html, inflow_guide_images FROM campaign_options WHERE campaign_id = $1 AND COALESCE(status,'active') <> 'closed'`, [camp.id]);
    const missing = after.filter(o => !String(o.inflow_guide_html || '').trim() && !(Array.isArray(o.inflow_guide_images) && o.inflow_guide_images.length))
      .map(o => o.opt_key || o.product_name || '이름 없는 선택지');
    if (missing.length) return { reject: { kind: 'inflow', out: { applied: false, reason: 'guide_missing', detail: { missing } } } };
  }
  return { applied: n > 0 };
}

const _num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const _mixSum = v => {
  let raw = v; if (typeof raw === 'string') { try { raw = JSON.parse(raw || '[]'); } catch (_) { return null; } }
  return Array.isArray(raw) ? raw.reduce((a, e) => a + Math.max(0, Math.floor(Number(e && e.quantity) || 0)), 0) : 0;
};
function _tiersOn(p) { const t = p && p.qty_tiers; return t != null && (Array.isArray(t) ? t.length > 0 : (typeof t === 'object' ? Object.keys(t).length > 0 : String(t).trim() !== '')); }

/**
 * 7단계-② — 인원이 바뀐 저장의 정합 검사(쓰기 전 · 실패 = 409 쓰기 0). 사용자 확정 2026-10-20:
 *   ③ 오더는 "총모집 = 상품·옵션 인원 합계" — 다른 모양은 담지 않는다 · ④ 배송 혼합·구매수량 단계 작업의 인원 변경은 4단계(구조)까지 막는다 ·
 *   ① 리뷰타입 혼합 작업은 혼합 수량을 인원에 맞춰 같이 바꿨을 때만(합계 = 인원 · 옵션별도 같다).
 */
function validateQuantities(next, qtyProducts) {
  const products = _parseList(next.product_options_json) || [];
  const byName = n => products.find(p => p && String(p.name || '').trim() === n);
  for (const n of qtyProducts || []) {
    if (_tiersOn(byName(n))) return { code: 'quantity_tiers_locked', error: '구매수량 단계를 쓰는 상품은 아직 인원을 바꿀 수 없습니다(구조 단계에서 엽니다). 인원은 그대로 두고 저장해 주세요.' };
  }
  if (CANON.deliveryMix(next.delivery_type_mix)) {
    return { code: 'quantity_delivery_mix_locked', error: '배송 혼합(실배송·빈박스) 작업은 아직 인원을 바꿀 수 없습니다(구조 단계에서 엽니다).' };
  }
  const total = Math.max(0, Math.floor(_num(next.recruit_count)));
  if (products.length) {
    let sum = 0, daily = 0;
    for (const p of products) {
      if (!p || typeof p !== 'object') continue;
      const opts = Array.isArray(p.options) ? p.options : [];
      const base = p.base && typeof p.base === 'object' ? p.base : {};
      if (opts.length) for (const o of opts) { sum += _num(o && o.count); daily += _num(o && (o.daily ?? o.daily_limit ?? o.dailyLimit)); }
      else { sum += _num(base.count); daily += _num(base.daily ?? base.daily_limit ?? base.dailyLimit); }
      // 리뷰 혼합 수량(옵션·상품별)은 그 인원과 같아야 한다
      for (const o of opts) {
        const ms = _mixSum(o && o.review_type_mix);
        if (ms && ms !== _num(o.count)) return { code: 'quantity_mix_mismatch', error: `「${String(p.name || '').trim()} / ${String(o.label || '').trim()}」 리뷰타입 수량 합계(${ms})가 인원(${_num(o.count)})과 다릅니다. 같이 맞춰 주세요.` };
      }
      if (!opts.length) { const ms = _mixSum(base.review_type_mix); if (ms && ms !== _num(base.count)) return { code: 'quantity_mix_mismatch', error: `「${String(p.name || '').trim()}」 리뷰타입 수량 합계(${ms})가 인원(${_num(base.count)})과 다릅니다. 같이 맞춰 주세요.` }; }
    }
    if (sum !== total) return { code: 'quantity_sum_mismatch', error: `총모집(${total}명)과 상품·옵션 인원 합계(${sum}명)가 다릅니다. 합계가 총모집이 되도록 맞춰 주세요.` };
    if (next.daily_count != null && next.daily_count !== '' && daily > 0 && daily !== _num(next.daily_count)) {
      return { code: 'quantity_daily_mismatch', error: `일 진행 건수(${_num(next.daily_count)})와 상품·옵션 일건수 합계(${daily})가 다릅니다. 같이 맞춰 주세요.` };
    }
  }
  if (CANON.reviewType(next.review_type) === 'mixed') {
    const ms = _mixSum(next.review_type_mix);
    if (ms !== total) return { code: 'quantity_mix_mismatch', error: `리뷰타입 혼합 수량 합계(${ms})가 총모집(${total}명)과 다릅니다. 같이 맞춰 주세요.` };
  }
  return null;
}

/**
 * 7단계-② 인원·일건수 → 공고(같은 트랜잭션). 기존 정원 장치를 그대로 쓴다(규칙 사본 0):
 *   총 하한 = 참여·구매·바로 구매(`assertTotalFloorInTx`) · 옵션 하한 = 그 옵션 참여·구매(`usedByOption`) ·
 *   작업표 줄 = 빈 줄만 지우고 새 줄은 빈 줄로(`syncWorktableSlotsInTx` — 채워진 줄보다 적게 못 줄인다).
 * ★ 차수가 있는 공고는 거부(연결 공고는 차수를 막는다 · 사용자 확정 ②) · 날짜 다시 배치는 커밋 뒤(`after.relay`).
 */
async function _projectQuantityInTx(client, camp, prev, next) {
  const lrq = require('./linkedRecruitQuota.service');
  const reject = (reason, error) => ({ reject: { kind: 'quantity', out: { applied: false, reason }, error } });
  // 차수 표가 없는 DB(42P01)는 차수 없음 — SAVEPOINT 로 감싸 실패가 트랜잭션을 깨지 않게(검토 2026-10-21)
  await client.query('SAVEPOINT p7q_rounds');
  try {
    const { rows: rounds } = await client.query('SELECT 1 FROM campaign_rounds WHERE campaign_id = $1 LIMIT 1', [camp.id]);
    await client.query('RELEASE SAVEPOINT p7q_rounds');
    if (rounds.length) return reject('rounds_exist', '차수가 있는 공고는 인원을 차수로 관리합니다 — 연결된 작업에서는 인원 칸으로 바꿀 수 없습니다. 담당자에게 문의해 주세요.');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT p7q_rounds').catch(() => {});
    if (e.code !== '42P01') throw e;
  }
  const prefill = st => require('../utils/woCampaignPrefill.generated')._woCampaignPrefill(JSON.parse(JSON.stringify(st || {})));
  const pp = prefill(prev), pn = prefill(next);
  const prevTotal = Math.max(0, Math.floor(_num(prev.recruit_count))), total = Math.max(0, Math.floor(_num(next.recruit_count)));
  try {
    // 하한 — 오더 총모집이 바뀌었거나 공고 총모집이 줄어드는 경우(공고 값이 오더보다 컸던 공고에서 일건수만 바꿔도 공고 인원이 내려간다 · 검토 2026-10-21)
    const campTotal = Math.max(0, Math.floor(_num(camp.recruit_total)));
    if (total !== prevTotal || total < campTotal) await lrq.assertTotalFloorInTx(client, camp.id, total);
    // 옵션 줄
    const keyOf = o => `${String(o.productName || '').trim()}|${o.unitKind === 'product' ? '' : String(o.optKey || '').trim()}`;
    const before = new Map((pp.options || []).map(o => [keyOf(o), o]));
    const changed = (pn.options || []).filter(o => { const b = before.get(keyOf(o));
      return !b || _num(b.recruitTotal) !== _num(o.recruitTotal) || _num(b.dailyLimit) !== _num(o.dailyLimit) || JSON.stringify(b.reviewTypeMix || []) !== JSON.stringify(o.reviewTypeMix || []); });
    const { rows: optRows } = await client.query(
      `SELECT id, opt_key, product_name, unit_kind, recruit_total, daily_limit FROM campaign_options WHERE campaign_id = $1 ORDER BY id FOR UPDATE`, [camp.id]);
    if (changed.length && optRows.length) {
      const used = await lrq.usedByOption(client, camp.id);
      for (const o of changed) {
        const k = keyOf(o); const [pName, optKey] = k.split('|');
        const hits = optRows.filter(x => (String(x.unit_kind || '') === 'product'
          ? optKey === '' && (x.opt_key === pName || String(x.product_name || '').trim() === pName)
          : optKey !== '' && x.opt_key === optKey));
        if (!hits.length) return reject('option_key_mismatch', `인원을 저장하지 않았습니다 — 모집공고에서 「${o.optKey || o.productName}」 줄을 찾지 못했습니다. 모집공고의 상품 줄 이름을 맞춘 뒤 다시 저장해 주세요.`);
        for (const h of hits) {
          const u = used.get(h.opt_key) || 0;
          if (_num(o.recruitTotal) < u) return reject('option_below_used', `「${o.optKey || o.productName}」은 이미 ${u}명이 참여·구매해 ${_num(o.recruitTotal)}명으로 줄일 수 없습니다.`);
          await client.query('UPDATE campaign_options SET recruit_total = $2, daily_limit = $3, review_type_mix = $4::jsonb, updated_at = NOW() WHERE id = $1',
            [h.id, Math.max(0, Math.floor(_num(o.recruitTotal))), Math.max(0, Math.floor(_num(o.dailyLimit))), JSON.stringify(o.reviewTypeMix || [])]);
        }
      }
    }
    // 공고 칸 — 총모집·일건수·혼합 수량(발행 프리필과 같은 값)
    const sets = []; const params = [camp.id];
    const add = v => { params.push(v); return `$${params.length}`; };
    if (total !== _num(camp.recruit_total)) sets.push(`recruit_total = ${add(total)}`);
    if (_num(pn.daily_limit) !== _num(camp.daily_limit)) sets.push(`daily_limit = ${add(Math.max(0, Math.floor(_num(pn.daily_limit))))}`);
    if (JSON.stringify(pn.review_type_mix || []) !== JSON.stringify(pp.review_type_mix || [])) sets.push(`review_type_mix = ${add(JSON.stringify(pn.review_type_mix || []))}::jsonb`);
    if (sets.length) await client.query(`UPDATE recruit_campaigns SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    // 작업표 줄
    let worktable = null;
    if (total !== prevTotal || total !== campTotal) worktable = await lrq.syncWorktableSlotsInTx(client, camp, total, 'bidir-quota');
    if (total > prevTotal) {
      await require('./campaignHold.service').maybeReopenAfterQuotaIncrease(client, camp.id, prevTotal, { savepoint: true }).catch(() => false);
    }
    return { applied: sets.length > 0 || changed.length > 0 || !!worktable, after: { worktable, relay: total !== prevTotal || total !== campTotal || _num(pn.daily_limit) !== _num(pp.daily_limit) } };
  } catch (e) {
    if (e && /^recruit_quota/.test(String(e.code || ''))) return reject(e.code, e.message);
    throw e;
  }
}

/** 공고 반영 — 쓴 칸만. 거부 사유가 있으면 {reject} 를 돌려 호출부가 통째로 되돌린다.
 *  @param {object} [extra] { prev: 저장 전 상태(금액 비교) · payTouched · actor } */
async function projectToCampaignInTx(client, camp, next, writtenKeys, productsTouched, extra = {}) {
  const sync = require('./campaignPayAmountSync.service');
  const applied = [];
  const has = k => writtenKeys.has(k);
  if (has('review_fee')) {
    const r = await require('./campaignFeeChange.service').applyFeeChangeInTx(client, camp, next.review_fee);
    if (r.reject) return { reject: { kind: 'fee', out: { applied: false, reason: r.reject.reason }, error: r.reject.error } };
    if (r.applied) applied.push('review_fee');
  }
  let after = null;
  if (extra.quantityChanged) {
    const r = await _projectQuantityInTx(client, camp, extra.prev || {}, next);
    if (r.reject) return { reject: r.reject };
    if (r.applied) applied.push('quantity');
    after = r.after || null;
  }
  if (extra.guideTouched) {
    const r = await _projectGuideInTx(client, camp, extra.prev || {}, next);
    if (r.reject) return { reject: r.reject };
    if (r.applied) applied.push('unit_guide');
  }
  if (extra.payTouched) {
    const r = await _projectPayInTx(client, camp, extra.prev || {}, next, extra.actor || '');
    if (r.reject) return { reject: { ...r.reject, error: PAY_REJECT_TEXT[r.reject.out.reason] } };
    if (r.applied) applied.push('pay');
  }
  const proj = projectOrderToCampaign(next);
  const prefill = require('../utils/woCampaignPrefill.generated')._woCampaignPrefill(JSON.parse(JSON.stringify(next)));

  if (has('thumbnail_url') && String(next.thumbnail_url || '').trim()) {
    const r = await sync.syncCampaignThumbnailInTx(client, camp, String(next.thumbnail_url).trim());
    if (r.applied) applied.push('thumbnail');
  }
  if (has('inflow_type') || has('inflow_guide') || has('guide_images')) {
    const guideEdit = has('inflow_guide') || has('guide_images');
    const r = await sync.syncCampaignInflowInTx(client, camp, {
      nextType: has('inflow_type') ? sync.normalizeInflowType(next.inflow_type) : '',
      commonGuide: guideEdit ? { text: next.inflow_guide, images: next.guide_images } : undefined,
      productOptionsJson: undefined, hasGuideEdit: guideEdit, hasUnitEdit: false,
    });
    if (!r.applied && r.reason === 'guide_missing') return { reject: { kind: 'inflow', out: r } };
    if (r.applied) applied.push('inflow');
  }
  if (has('purchase_time')) {
    const r = await sync.syncCampaignPurchaseWindowInTx(client, camp, next.purchase_time, { textOnlyWhenLegacy: true });
    if (!r.applied && r.reason === 'unparsed') return { reject: { kind: 'time', out: r } };
    if (r.applied) applied.push('time');
  }
  if (has('review_guide') || has('special_notes') || has('guide_images')) {
    const { rows } = await client.query('SELECT work_detail FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [camp.id]);
    let wd = rows[0] && rows[0].work_detail;
    if (typeof wd === 'string') { try { wd = JSON.parse(wd); } catch (_) { wd = null; } }
    if (!wd || typeof wd !== 'object' || Array.isArray(wd)) wd = {};
    const want = {
      reviewGuide: String(prefill.wd_review || ''), reviewGuideImages: prefill.wd_review_images || [],
      specialNotes: String(prefill.wd_notes || ''), specialNotesImages: prefill.wd_notes_images || [],
    };
    const nextWd = Object.assign({}, wd);
    let changed = false;
    for (const [k, v] of Object.entries(want)) {
      if (JSON.stringify(wd[k] === undefined ? (Array.isArray(v) ? [] : '') : wd[k]) !== JSON.stringify(v)) { nextWd[k] = v; changed = true; }
    }
    if (changed) {
      await client.query('UPDATE recruit_campaigns SET work_detail = $2::jsonb, updated_at = NOW() WHERE id = $1', [camp.id, JSON.stringify(nextWd)]);
      applied.push('guides');
    }
  }
  // ★ 금액만 바뀐 저장(5단계)은 주소를 다시 쓰지 않는다 — 공고 창에서 따로 고친 옵션 주소·랜딩을 덮지 않게.
  const urlTouched = extra.urlTouched === undefined ? productsTouched : extra.urlTouched === true;
  if (has('product_url') || urlTouched || has('inflow_type') || has('inflow_guide')) {
    if (proj.landing_url) {
      const { rowCount } = await client.query(
        `UPDATE recruit_campaigns SET landing_url = $2, updated_at = NOW() WHERE id = $1 AND COALESCE(landing_url,'') <> $2`,
        [camp.id, proj.landing_url]);
      if (rowCount) applied.push('landing');
    }
    if (urlTouched || has('product_url')) {
      for (const o of proj.options) {
        const [pName, optKey] = o.key.split('|');
        const { rowCount } = await client.query(
          `UPDATE campaign_options SET option_url = $4, updated_at = NOW()
            WHERE campaign_id = $1 AND status <> 'closed'
              AND ((unit_kind = 'product' AND $3 = '' AND (opt_key = $2 OR product_name = $2))
                OR (COALESCE(unit_kind,'option') <> 'product' AND opt_key = $3 AND $3 <> ''))
              AND COALESCE(option_url,'') <> $4`,
          [camp.id, pName, optKey, o.option_url]);
        if (rowCount) applied.push('option_url');
      }
    }
  }
  if (has('purchase_channel') || has('purchase_channel_custom') || has('product_url')) {
    const ch = String(proj.channel || '').trim();
    if (ch) {
      const [channel, custom] = KNOWN_CHANNELS.has(ch) ? [ch, ''] : ['직접입력', ch];
      const { rowCount } = await client.query(
        `UPDATE recruit_campaigns SET channel = $2, channel_custom = $3, updated_at = NOW()
          WHERE id = $1 AND (COALESCE(channel,'') <> $2 OR COALESCE(channel_custom,'') <> $3)`,
        [camp.id, channel, custom]);
      if (rowCount) applied.push('channel');
    }
  }
  return { applied, after };
}

async function _abort(client, status, body) {
  try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
  return { status, body };
}

/**
 * @param {object} p
 * @param {string} p.workOrderId
 * @param {object} p.mine        보낸 공유 상태(저장 형태 · 칸 이름 = 작업오더 칸)
 * @param {number} p.baseVersion 수정 화면을 연 시점의 버전
 * @param {'intranet'|'rw_admin'|'reconcile'|'campaign'} p.origin
 * @param {string} [p.opId] 같은 저장 재전송 판별
 * @param {string} [p.actor]
 * @param {string[]} [p.forceMine] 사람이 "내 값" 을 고른 경로
 * @param {'block'|'last_writer'} [p.conflictPolicy] 겹친 칸 처리 — block(기본, 409 쓰기 0) · last_writer(이번 저장 값으로 쓰고 overwritten 으로 알림)
 * @param {(client, wo) => Promise<null|{status,body}>} [p.preHook] 같은 트랜잭션에서 먼저 검사(원본 번호 등)
 * @param {object} [p.extraSets] 공유 칸이 아닌 같이 쓸 칸(원본 번호·키 등 — EXTRA_COLUMNS 만)
 * @param {boolean} [p.countsCapable] false = 인원을 모르는 옛 인트라넷 저장(인원 칸은 받지 않는다 · 7단계-②)
 * @param {boolean} [p.guideCapable] false = 선택지 가이드를 모르는 옛 인트라넷 저장(가이드 칸은 받지 않는다 · 6단계)
 * @param {boolean} [p.moneyCapable] false = 금액을 모르는 옛 인트라넷 저장(금액 칸은 받지 않는다 · 5단계 배포 순서 안전장치)
 * @param {object} [p.db] 시험용 pool
 */
async function applySharedPatch(p) {
  if (String(process.env.BIDIR_HARD_OFF || '').trim() === '1') return { status: 503, body: { ok: false, code: 'bidir_off', error: '양방향 동기화가 꺼져 있습니다.' } };
  const lrq = require('./linkedRecruitQuota.service');
  const client = await (p.db || getPool()).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '10s'`);
    await lrq.lockWorkOrderCampaigns(client, [p.workOrderId]);                                  // L1
    const { rows: woRows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [p.workOrderId]);
    const wo = woRows[0];
    if (!wo || wo.deleted_at) return await _abort(client, 404, { ok: false, code: 'order_not_found', error: '작업오더를 찾을 수 없습니다.' });
    const peek = await lrq.liveCampaignForWorkOrders(client, [wo.id]);                          // 보관(마감) 공고 제외
    let camp = null;
    if (peek) {
      const { rows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 AND archived_at IS NULL FOR UPDATE', [peek.id]);
      camp = rows[0] || null;
      if (!camp) return await _abort(client, 409, { ok: false, code: 'link_changed_retry', error: '연결 공고가 방금 바뀌었습니다. 다시 시도해 주세요.' });
    }
    if (p.preHook) { const r = await p.preHook(client, wo); if (r) return await _abort(client, r.status, r.body); }
    if (wo.bidir_state !== 'on' && p.origin !== 'reconcile') {
      return await _abort(client, 409, { ok: false, code: 'bidir_not_on', state: wo.bidir_state, error: '이 오더는 양방향 동기화가 연결돼 있지 않습니다.' });
    }
    const curVersion = Number(wo.sync_version || 0);
    if (p.opId) {
      const { rows } = await client.query('SELECT sync_version FROM work_order_shared_snapshots WHERE op_id = $1 LIMIT 1', [String(p.opId)]);
      if (rows.length) return await _abort(client, 200, { ok: true, idempotent: true, sync_version: Number(rows[0].sync_version) });
    }
    const theirs = readSharedState(wo);
    const { rows: baseRows } = await client.query(
      'SELECT state FROM work_order_shared_snapshots WHERE work_order_id = $1 AND sync_version = $2', [wo.id, Number(p.baseVersion)]);
    if (!baseRows.length) {
      return await _abort(client, 409, { ok: false, code: 'edit_base_missing', sync_version: curVersion,
        error: '수정 화면을 연 뒤 기준 정보가 사라졌습니다. 창을 닫고 다시 열어 주세요.' });
    }
    const base = baseRows[0].state;
    const plan = planSharedPatch({ base, mine: p.mine, theirs, origin: p.origin, forceMine: p.forceMine || [] });

    /* ★ 배포 순서 안전장치(5단계 · 검토 2026-10-20) — 금액을 모르는 옛 인트라넷(저장 본문에 `bidir.money` 표시 없음)은 리뷰비·상품 금액을
       인트라넷 사본 값(리뷰웹에서 바뀐 금액을 못 받은 옛 값)으로 늘 다시 보낸다. 그대로 쓰면 저장할 때마다 리뷰웹 금액이 옛 값으로 되돌아간다.
       → 그 저장의 금액 경로는 "안 보낸 칸" 으로 버린다(인원 등 다른 칸이 섞인 base 변경은 그대로 막힘 판정으로 간다). */
    /* ★ 6단계 같은 장치 — 가이드를 모르는 인트라넷(`bidir.guide` 없음)은 옛 사본 가이드를 다시 보낸다 → 가이드 경로는 받지 않는다.
       새 인트라넷도 링크유입이면 가이드를 아예 안 싣는다(인트라넷 화면 규칙) — "없음" 을 "지웠다" 로 읽지 않는다(검토 · 사전 점검 🔴2). */
    if (p.origin === 'intranet') {
      const isGuide = w => w.meta && w.meta.kind === 'leaf' && w.meta.key === 'guide';
      const linkInflow = String((p.mine && p.mine.inflow_type) || '').trim() !== 'guide';
      // ★ 옛 인트라넷의 가이드 차이는 "낡은 사본" 과 "진짜 수정" 을 가를 근거가 없다(옛 화면은 리뷰웹 가이드를 받지 못해 창 자체가 낡은 값으로 열린다).
      //   막으면 리뷰웹이 가이드를 한 번 바꾼 뒤로 그 오더의 옛 화면 저장이 전부 막힌다 → 버린다(기록). 그래서 배포는 인트라넷 먼저(결정 263 5·6단계).
      const dropGuide = w => isGuide(w) && (p.guideCapable === false || (linkInflow && w.mine === ABSENT));
      const dropped = [...plan.writes, ...plan.conflicts].filter(dropGuide).map(w => w.path);
      if (dropped.length) {
        plan.writes = plan.writes.filter(w => !dropGuide(w));
        plan.conflicts = plan.conflicts.filter(w => !dropGuide(w));
        logger.info(`[bidir/apply] ${wo.id} 가이드 칸은 받지 않음(${p.guideCapable === false ? '가이드를 모르는 옛 인트라넷' : '링크유입이라 안 실음'}): ${dropped.join(', ')}`);
      }
    }
    // ★ 7단계-② 같은 장치 — 인원을 모르는 인트라넷(`bidir.counts` 없음)은 잠긴 인원 칸의 옛 사본 값을 다시 보낸다 → 인원 경로는 받지 않는다(기록)
    if (p.origin === 'intranet' && p.countsCapable === false) {
      const dq = [...plan.writes, ...plan.conflicts].filter(_isQuantityPath).map(w => w.path);
      if (dq.length) {
        plan.writes = plan.writes.filter(w => !_isQuantityPath(w));
        plan.conflicts = plan.conflicts.filter(w => !_isQuantityPath(w));
        logger.info(`[bidir/apply] ${wo.id} 인원을 모르는 옛 인트라넷 저장 — 인원 칸은 받지 않음: ${dq.join(', ')}`);
      }
    }
    let droppedMoney = [];
    if (p.moneyCapable === false) {
      const isMoney = w => { const m = w.meta || {};
        return (m.kind === 'field' && m.key === 'review_fee')
          || (m.kind === 'leaf' && m.key === 'pay' && String(m.parent || '').includes('|o:') && w.base !== ABSENT && w.mine !== ABSENT)
          || (m.kind === 'leaf' && m.key === 'base' && !String(m.parent || '').includes('|o:') && _onlyBasePayDiffers(w)); };
      droppedMoney = [...plan.writes, ...plan.conflicts].filter(isMoney).map(w => w.path);
      plan.writes = plan.writes.filter(w => !isMoney(w));
      plan.conflicts = plan.conflicts.filter(w => !isMoney(w));
      if (droppedMoney.length) logger.info(`[bidir/apply] ${wo.id} 금액을 모르는 옛 인트라넷 저장 — 금액 칸은 받지 않음: ${droppedMoney.join(', ')}`);
    }

    const blocked = [...plan.writes, ...plan.conflicts].filter(w => !writablePath(w, p.origin));
    if (blocked.length) {
      return await _abort(client, 409, { ok: false, code: 'field_not_editable', sync_version: curVersion,
        fields: blocked.map(w => ({ path: w.path, label: _label(w) })),
        error: `이 칸은 아직 여기서 바꿀 수 없습니다: ${[...new Set(blocked.map(w => _label(w)))].join(', ')}` });
    }
    // ★ 겹친 칸 = 나중에 저장한 값(사용자 확정 2026-10-20 · 인트라넷발만) — 덮인 리뷰웹 값은 응답 `overwritten` 으로
    //   돌려줘 저장한 사람이 확인하게 하고, 스냅숏 이력에 남는다. 보기전용(readOnly)은 정책과 무관하게 막는다.
    const lastWriter = p.conflictPolicy === 'last_writer';
    if ((plan.conflicts.length && !lastWriter) || plan.readOnly.length) {
      return await _abort(client, 409, { ok: false, code: 'field_conflict', sync_version: curVersion,
        conflicts: plan.conflicts.map(c => ({ ...c, label: _label(c) })),
        readOnly: plan.readOnly.map(c => ({ ...c, label: _label(c) })),
        error: '다른 곳에서 같은 칸이 먼저 바뀌었습니다. 어느 값을 남길지 골라 주세요.' });
    }

    const overwritten = lastWriter ? plan.conflicts.map(c => ({ path: c.path, label: _label(c), before: _display(c.path, c.theirs), after: _display(c.path, c.mine) })) : [];
    if (lastWriter && plan.conflicts.length) plan.writes = [...plan.writes, ...plan.conflicts];
    const extra = Object.entries(p.extraSets || {}).filter(([k]) => EXTRA_COLUMNS.has(k));
    if (!plan.writes.length && !extra.length) {
      await client.query('COMMIT');
      return { status: 200, body: { ok: true, noop: true, sync_version: curVersion } };
    }
    const { next, productsTouched, urlTouched, guideTouched, quantityTouched, payTouched, payProducts, qtyProducts, missed } = applyWrites(theirs, p.mine, plan.writes);
    if (missed.length) {
      return await _abort(client, 409, { ok: false, code: 'write_unmatched', sync_version: curVersion, fields: missed.map(path => ({ path, label: _label(path) })),
        error: `상품·옵션 짝을 찾지 못해 저장하지 않았습니다: ${[...new Set(missed.map(path => _label(path)))].join(', ')}. 창을 닫고 다시 열어 주세요.` });
    }
    const qtyFieldWritten = plan.writes.some(w => w.meta && w.meta.kind === 'field' && PHASE7Q_SHARED_FIELDS.includes(w.meta.key));
    const quantityChanged = quantityTouched || qtyFieldWritten;
    if (quantityChanged) {
      const qErr = validateQuantities(next, qtyProducts);
      if (qErr) return await _abort(client, 409, { ok: false, code: qErr.code, sync_version: curVersion, error: qErr.error });
    }
    // 옛 인트라넷이 금액을 버린 저장인데 상품 주소가 바뀌었으면, 그 저장이 보낸 요약 문장(옛 금액이 적힌)을 쓰지 않는다
    if (droppedMoney.length && productsTouched) {
      const { regenerateSummary } = require('../utils/orderProductSummary');
      const r = regenerateSummary({ prevJson: theirs.product_options_json, prevText: theirs.product_option, nextJson: next.product_options_json });
      next.product_option = r.text != null ? r.text : theirs.product_option;
    }
    const writtenKeys = new Set(plan.writes.filter(w => w.path.startsWith('f:')).map(w => w.path.slice(2)));
    // 인원이 바뀐 상품도 상품구입비(금액 × 인원)가 바뀐다 — 결제합계·요약 문장을 같이 다시 만든다
    const costProducts = new Set([...payProducts, ...qtyProducts]);
    const derived = derivePayFields({ base, theirs, mine: p.mine, next, payProducts: costProducts, origin: p.origin });
    if (derived.payAmountNote) logger.info(`[bidir/apply] ${wo.id} 결제합계: 구매수량 단계 상품이라 차이를 계산하지 않음(${derived.payAmountNote})`);
    if (derived.pay_amount !== undefined) next.pay_amount = derived.pay_amount;
    if (derived.product_option !== undefined) next.product_option = derived.product_option;
    if (derived.summaryKept) logger.info(`[bidir/apply] ${wo.id} 상품 요약 문장은 옛 문장 유지(${derived.summaryKept}) — 결제금액만 바뀜`);

    // ── 오더 쓰기(쓴 칸 + 함께 쓰는 칸) ──
    const sets = []; const params = [wo.id];
    const add = v => { params.push(v); return `$${params.length}`; };
    for (const k of writtenKeys) {
      if (!ORDER_COLUMNS.has(k) || !/^[a-z_]+$/.test(k)) continue;
      // JSON 칸(리뷰 혼합 수량)은 글자로 넘긴다 — 배열을 그대로 넘기면 드라이버가 PG 배열로 바꾼다
      const v = (k === 'review_type_mix' && next[k] != null && typeof next[k] !== 'string') ? JSON.stringify(next[k]) : next[k];
      sets.push(`${k} = ${add(v)}`);
    }
    if (productsTouched) {
      sets.push(`product_options_json = ${add(next.product_options_json)}`);
      if (next.product_option !== undefined) sets.push(`product_option = ${add(next.product_option)}`);
      if (payTouched || quantityTouched) sets.push(`pay_amount = ${add(Math.max(0, Math.floor(Number(next.pay_amount) || 0)))}`);
    }
    for (const [k, v] of extra) sets.push(`${k} = ${add(v)}`);
    if (plan.writes.length) {
      // 새 버전은 한 번만 계산해 두 칸에 같은 값을 쓴다(시각이 들어가 두 번 계산하면 값이 갈린다).
      const { rows: nv } = await client.query(
        `SELECT GREATEST($1::bigint + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint) AS v`, [curVersion]);
      const v = add(String(nv[0].v));
      sets.push(`sync_version = ${v}::bigint`);
      // 인트라넷이 이 버전을 "안다" 고 적는 것은 저장 결과가 보낸 값과 같을 때만 — 합쳐져 달라졌으면
      // 인트라넷 사본은 아직 옛 값이다(받아 간 뒤 송신 처리기가 적는다). 기준 없는 옛 인트라넷 저장이 이 값을 기준으로 쓴다.
      if (p.origin === 'intranet' && !_pushBackKeys(p.mine, next).length) sets.push(`intranet_acked_version = ${v}::bigint`);
    }
    const { rows: upd } = await client.query(
      `UPDATE work_orders SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND sync_version = ${add(curVersion)} RETURNING *`, params);
    if (!upd.length) return await _abort(client, 409, { ok: false, code: 'version_race', error: '같은 오더의 다른 저장이 먼저 처리됐습니다. 다시 시도해 주세요.' });
    const saved = upd[0];
    const newVersion = Number(saved.sync_version);

    // ── 공고 반영(같은 트랜잭션) ──
    let campaign = { applied: [] };
    if (camp && plan.writes.length) {
      campaign = await projectToCampaignInTx(client, camp, next, writtenKeys, productsTouched,
        { prev: theirs, payTouched, urlTouched, guideTouched, quantityChanged, actor: p.actor || p.origin });
      if (campaign.reject) {
        const { campaignSyncNotice } = require('./campaignPayAmountSync.service');
        return await _abort(client, 409, { ok: false, code: 'campaign_rejected', sync_version: curVersion,
          reason: campaign.reject.out.reason, detail: campaign.reject.out.detail || null,
          error: campaign.reject.error || campaignSyncNotice(campaign.reject.kind, campaign.reject.out) || '모집공고에 반영할 수 없어 저장하지 않았습니다.' });
      }
    }
    if (plan.writes.length) {
      await client.query(
        `INSERT INTO work_order_shared_snapshots (work_order_id, sync_version, origin, op_id, state, actor)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [wo.id, newVersion, p.origin, String(p.opId || ''), JSON.stringify(readSharedState(saved)), String(p.actor || '')]);
    }
    // ── 인트라넷으로 보낼 거리(4단계) — 리뷰웹발은 항상, 인트라넷발은 저장 결과가 보낸 값과 다를 때만
    //    (그 사이 리뷰웹이 고친 다른 칸과 합쳐진 경우). 같으면 쌓지 않는다 — 자기가 보낸 것을 되받는 메아리 방지.
    if (p.origin !== 'intranet' ? plan.writes.length > 0 : (plan.writes.length > 0 && _pushBackKeys(p.mine, next).length > 0)) {
      await client.query(
        `INSERT INTO shared_sync_outbox (work_order_id, sync_version) VALUES ($1, $2)
         ON CONFLICT (work_order_id, sync_version) DO UPDATE SET status = 'pending', attempts = 0, next_at = NOW(), last_error = '', updated_at = NOW()
          WHERE shared_sync_outbox.status IN ('delivered', 'superseded')`, [wo.id, newVersion]);
    }
    await client.query('COMMIT');
    // 7단계-② 커밋 뒤 — 작업표 투영 장부 다시 만들기 · 빈 줄 날짜 다시 배치(정원 동기화와 같은 순서 · 탭 잠금은 자기 트랜잭션 · 실패해도 저장은 끝났다)
    if (camp && campaign.after) {
      const lrq = require('./linkedRecruitQuota.service');
      try { if (campaign.after.worktable) campaign.after.rebuilt = await lrq.rebuildWorktableProjection(campaign.after.worktable, 'bidir-quota'); }
      catch (e) { logger.warn(`[bidir/apply] ${wo.id} 작업표 장부 다시 만들기 실패(저장은 끝남): ${e.message}`); }
      if (campaign.after.relay) {
        try { campaign.after.relayResult = await require('./campaignPlan.service').relayCampaignWorktable(camp.id, { by: 'bidir-quota' }); }
        catch (e) { logger.warn(`[bidir/apply] ${wo.id} 작업표 날짜 다시 배치 실패(저장은 끝남): ${e.message}`); }
      }
    }
    if (overwritten.length) logger.info(`[bidir/apply] ${wo.id} 겹친 칸을 나중 저장 값으로(${p.origin}·${p.actor || ''}): ${overwritten.map(o => o.label).join(', ')}`);
    // push_back = 저장 결과가 보낸 값과 달라 인트라넷이 받아 가야 하는가(인트라넷발만 의미 있음). false 면 인트라넷은 이 버전을
    // 자기 사본과 같다고 적는다(remote_sync_version) — 안 적으면 늦게 도착한 옛 송신이 방금 저장한 수정을 되돌린다(검토 2026-10-20).
    const pushBack = p.origin === 'intranet' && _pushBackKeys(p.mine, next).length > 0;   // 쓴 칸이 없어도(번호만) 사본이 다를 수 있다
    return { status: 200, body: { ok: true, data: saved, sync_version: newVersion, push_back: pushBack, applied: plan.writes.map(w => w.path), campaign_applied: campaign.applied, overwritten } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (['40P01', '55P03', '57014'].includes(e && e.code)) {
      logger.warn(`[bidir/apply] ${p.workOrderId} 잠금 대기 초과(${e.code}) — 다시 시도 안내`);
      return { status: 503, body: { ok: false, code: 'busy_retry', error: '같은 작업이 다른 저장으로 바쁩니다. 잠시 뒤 다시 저장해 주세요.' } };
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 오더를 양방향으로 연결한다 — 사용자 확정 D1: **값이 같은 오더만** 바로 연결(on), 다르면 `diverged`(직원이 고를 때까지 대기).
 * ★ 마감(보관) 공고는 대상이 아니다(사용자 확정 2026-10-20) · 공고 없는 오더도 대상 아님.
 * @returns {{ status:number, body:object }}
 */
async function linkSharedOrder({ workOrderId, actor = '', dryRun = false, db } = {}) {
  const { compareOrderCampaign } = require('../utils/orderToCampaignProjection');
  const lrq = require('./linkedRecruitQuota.service');
  const client = await (db || getPool()).connect();
  try {
    await client.query('BEGIN');
    await lrq.lockWorkOrderCampaigns(client, [workOrderId]);
    const { rows: woRows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [workOrderId]);
    const wo = woRows[0];
    if (!wo || wo.deleted_at) return await _abort(client, 404, { ok: false, code: 'order_not_found' });
    if (!String(wo.source_review_order_id || '').trim()) return await _abort(client, 409, { ok: false, code: 'not_intranet_order', error: '인트라넷 리뷰오더로 들어온 오더가 아닙니다.' });
    if (wo.bidir_state === 'on') return await _abort(client, 200, { ok: true, state: 'on', already: true, sync_version: Number(wo.sync_version) });
    const peek = await lrq.liveCampaignForWorkOrders(client, [wo.id]);
    if (!peek) {
      const { rows: arch } = await client.query('SELECT id FROM recruit_campaigns WHERE id = $1 AND archived_at IS NOT NULL', [String(wo.linked_campaign_id || '')]);
      return await _abort(client, 409, arch.length
        ? { ok: false, code: 'campaign_archived', error: '마감(보관)된 공고의 오더는 연결하지 않습니다.' }
        : { ok: false, code: 'no_campaign', error: '연결된 모집공고가 없습니다.' });
    }
    const { rows: cRows } = await client.query('SELECT * FROM recruit_campaigns WHERE id = $1 FOR UPDATE', [peek.id]);
    const { rows: opts } = await client.query('SELECT * FROM campaign_options WHERE campaign_id = $1 ORDER BY sort_order, id', [peek.id]);
    const diffs = compareOrderCampaign(wo, cRows[0], opts).filter(d => d.kind === 'diff');
    if (dryRun) return await _abort(client, 200, { ok: true, dryRun: true, state: diffs.length ? 'diverged' : 'on', diffs });
    if (diffs.length) {
      await client.query(`UPDATE work_orders SET bidir_state = 'diverged', updated_at = NOW() WHERE id = $1`, [wo.id]);
      await client.query('COMMIT');
      return { status: 200, body: { ok: true, state: 'diverged', diffs } };
    }
    const { rows: v } = await client.query(
      `UPDATE work_orders SET bidir_state = 'on', sync_version = ${NEXT_VERSION_SQL}, updated_at = NOW()
        WHERE id = $1 RETURNING *`, [wo.id]);
    const saved = v[0];
    await client.query(
      `INSERT INTO work_order_shared_snapshots (work_order_id, sync_version, origin, op_id, state, actor)
       VALUES ($1, $2, 'link', '', $3::jsonb, $4)`,
      [wo.id, Number(saved.sync_version), JSON.stringify(readSharedState(saved)), String(actor || '')]);
    await client.query('COMMIT');
    return { status: 200, body: { ok: true, state: 'on', sync_version: Number(saved.sync_version) } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  applySharedPatch, linkSharedOrder, readSharedState, applyWrites, writablePath, projectToCampaignInTx, derivePayFields, validateQuantities,
  PHASE3_SHARED_FIELDS, PHASE5_SHARED_FIELDS, PHASE7Q_SHARED_FIELDS, PUSH_VIEW_KEYS, WRITABLE_BY_ORIGIN, INTRANET_EDITABLE_AFTER_ACCEPT, NEXT_VERSION_SQL, _pushBackKeys,
};
