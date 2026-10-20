/**
 * campaignSharedEdit — 모집공고 편집 창에서 고친 **공유 글 칸**을 작업오더 값으로 되돌린다(결정 263 · 4단계-2).
 *
 * 정본은 작업오더 한 벌이고 공고는 그 투영(`projectToCampaignInTx`)이다. 공고 창에서 공유 칸을 고치면
 * "그 공고 값이 나오는 작업오더 값" 을 찾아 공유 저장(`applySharedPatch`)으로 보낸다.
 *
 * ★★ 손댄 칸 판정은 **창을 연 시점(기준 스냅숏)의 공고 모습** 과 비교한다 — 지금 공고 값과 비교하면, 창을 연 뒤
 *    인트라넷이 고친 칸을 관리자가 "옛 값으로 되돌린 것" 으로 읽어 조용히 덮는다(3단계 실측과 같은 함정).
 * ★★ 되돌린 값은 **다시 투영해 관리자가 보낸 값이 그대로 나오는지 확인**한다(왕복 검사). 안 나오면 그 칸은
 *    `unmappable` — 저장하지 않고 사람에게 말한다(추측해 근사값을 쓰지 않는다).
 * ★ 대상 칸(3단계 글 칸과 같은 범위): 리뷰가이드·특이사항·두 사진 묶음·유입방식(work_detail) · 썸네일 · 구매시간 ·
 *   상품 페이지(랜딩) · 구매채널. 5단계부터 리뷰비·결제금액(`planCampaignMoneyEdit`). 옵션 URL·옵션별 유입가이드·인원은 6·7단계.
 * ★ 순수 모듈 — DB·잠금 없음.
 */
'use strict';

const { _woCampaignPrefill, _woStripReviewMeta } = require('./woCampaignPrefill.generated');
const { sanitizeGuideImages } = require('./sanitizeGuideHtml');
const { parsePurchaseTime } = require('./purchaseTimeWindow');
const { CANON } = require('./sharedFields');

const KNOWN_CHANNELS = new Set(['쿠팡', '네이버', '올리브영', '카카오메이커스']);
const GUIDE_LABELS = ['리뷰등록 가이드', '리뷰가이드', '리뷰 가이드'];
const WD_KEYS = ['reviewGuide', 'specialNotes', 'reviewGuideImages', 'specialNotesImages', 'inflowType'];
const TOP_KEYS = ['thumbnail_url', 'time_range', 'landing_url', 'channel'];
const LABELS = {
  reviewGuide: '리뷰가이드', specialNotes: '특이사항', reviewGuideImages: '리뷰가이드 사진', specialNotesImages: '특이사항 사진',
  inflowType: '유입방식', thumbnail_url: '썸네일', time_range: '구매시간', landing_url: '상품 페이지 주소', channel: '구매채널',
};

const _t = v => String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
const _isFree = text => /자유|자율/.test(String(text || ''));
const _hhmm = v => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '').trim()); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };

function _parseImages(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch (_) { return null; }
}

/** 칸마다 같은 뜻이면 같은 글자가 되게. */
function norm(key, v) {
  if (key === 'reviewGuideImages' || key === 'specialNotesImages') return JSON.stringify(sanitizeGuideImages(Array.isArray(v) ? v : []));
  if (key === 'inflowType') return _t(v) === 'guide' ? 'guide' : 'link';
  if (key === 'time_range') return CANON.time(v);
  if (key === 'channel') return _t(v);
  return _t(v);
}

/**
 * 작업오더 공유 상태 → 그 상태를 투영했을 때의 공고 모습(위 대상 칸만). 투영이 "쓰지 않는" 경우(빈 썸네일·빈 구매시간 등)는
 * 지금 공고 값이 남으므로 `camp` 값을 돌려준다 — 실제 `projectToCampaignInTx` 와 같은 규칙.
 */
function campaignViewOf(state, camp) {
  const o = JSON.parse(JSON.stringify(state || {}));
  const p = _woCampaignPrefill(o);
  const c = camp || {};
  const wd = (c.work_detail && typeof c.work_detail === 'object') ? c.work_detail : {};
  const inflowType = (o.inflow_type === 'guide' || o.inflow_type === 'link') ? o.inflow_type : (wd.inflowType || 'link');
  const thumb = _t(o.thumbnail_url) || _t(c.thumbnail_url);
  const time = _t(o.purchase_time);
  const timeOk = time && (_isFree(time) || parsePurchaseTime(time));
  const chSrc = _t(p.channel);
  const [channel, channelCustom] = chSrc ? (KNOWN_CHANNELS.has(chSrc) ? [chSrc, ''] : ['직접입력', chSrc]) : [_t(c.channel), _t(c.channel_custom)];
  return {
    reviewGuide: _t(p.wd_review), specialNotes: _t(p.wd_notes),
    reviewGuideImages: p.wd_review_images || [], specialNotesImages: p.wd_notes_images || [],
    inflowType, thumbnail_url: thumb,
    time_range: timeOk ? time : _t(c.time_range),
    landing_url: _t(p.landing_url) || _t(c.landing_url),
    channel: channel === '직접입력' ? channelCustom : channel,
  };
}

/** 공고 편집 본문 → 대상 칸 값(보내지 않은 칸은 없음). 구매채널은 직접입력이면 그 글자. */
function bodyView(body, { landingShared = true } = {}) {
  const b = body || {};
  const out = {};
  const wd = b.work_detail && typeof b.work_detail === 'object' ? b.work_detail : null;
  if (wd) for (const k of WD_KEYS) if (Object.prototype.hasOwnProperty.call(wd, k)) out[k] = wd[k];
  if (b.thumbnail_url !== undefined && b.thumbnail_url !== null) out.thumbnail_url = b.thumbnail_url;
  if (b.time_range !== undefined && b.time_range !== null) out.time_range = b.time_range;
  // 상품 페이지(랜딩)는 링크유입일 때만 작업오더에서 나온다 — 가이드유입 공고의 랜딩은 공고 전용 값이라 공유 대상이 아니다.
  if (landingShared && b.landing_url !== undefined && b.landing_url !== null) out.landing_url = b.landing_url;
  if (b.channel !== undefined && b.channel !== null) out.channel = _t(b.channel) === '직접입력' ? _t(b.channel_custom) : _t(b.channel);
  return out;
}

/** 지금 공고 행 → 대상 칸 값(옛 화면 판정·대조용). */
function campaignRowView(camp) {
  const c = camp || {};
  const wd = (c.work_detail && typeof c.work_detail === 'object') ? c.work_detail : {};
  return {
    reviewGuide: wd.reviewGuide || '', specialNotes: wd.specialNotes || '',
    reviewGuideImages: wd.reviewGuideImages || [], specialNotesImages: wd.specialNotesImages || [],
    inflowType: wd.inflowType || 'link', thumbnail_url: c.thumbnail_url || '', time_range: c.time_range || '',
    landing_url: c.landing_url || '', channel: _t(c.channel) === '직접입력' ? _t(c.channel_custom) : _t(c.channel),
  };
}

/** 리뷰가이드 글 → 작업오더 review_guide. [리뷰등록 가이드] 구간만 바꾸고 다른 구간·메타 줄은 그대로 둔다. */
function replaceReviewSection(raw, text) {
  const src = String(raw == null ? '' : raw);
  const body = _t(text);
  if (!/\[[^\]]+\]/.test(src)) return body;
  const normL = s => s.replace(/\s/g, '');
  const keep = GUIDE_LABELS.map(normL);
  const lines = src.split(/\r?\n/);
  const out = [];
  let inGuide = false, placed = false, kept = [];
  const flushMeta = () => { if (kept.length) { out.push(...kept); kept = []; } };
  for (const ln of lines) {
    const m = ln.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) {
      const wasGuide = inGuide;
      if (inGuide) flushMeta();
      inGuide = keep.some(k => normL(m[1]).includes(k));
      if (wasGuide && !inGuide) out.push('');   // 구간 사이 빈 줄(원래 모양)
      if (inGuide) {
        if (!placed) { out.push(`[${m[1]}]`); if (body) out.push(body); placed = true; }
        // 같은 줄에 붙은 글·이후 본문은 버리고, 투영이 걷어내는 메타 줄만 남긴다.
        if (m[2] && !_woStripReviewMeta(m[2])) kept.push(m[2]);
        continue;
      }
      out.push(ln);
      continue;
    }
    if (inGuide) { if (ln.trim() && !_woStripReviewMeta(ln)) kept.push(ln); continue; }
    out.push(ln);
  }
  if (inGuide) flushMeta();
  if (!placed) return [`[리뷰등록 가이드]`, body, '', src].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function _setImages(cur, patch) {
  const parsed = _parseImages(cur);
  const obj = Array.isArray(parsed) ? { inflow: parsed } : (parsed && typeof parsed === 'object' ? { ...parsed } : {});
  for (const [k, v] of Object.entries(patch)) obj[k] = sanitizeGuideImages(Array.isArray(v) ? v : []);
  return JSON.stringify(obj);
}

/**
 * @param {{ baseState: object, camp: object, body: object }} p baseState = 창을 연 시점의 작업오더 공유 상태(스냅숏)
 * @returns {{ mine: object, changed: string[], unmappable: Array<{key,label,want,got}>, windowsWritable: boolean }}
 *   mine = 바뀐 칸만(작업오더 칸 이름) — `applySharedPatch` 의 mine 으로 그대로 보낸다.
 */
function planCampaignSharedEdit({ baseState, camp, body }) {
  const base = JSON.parse(JSON.stringify(baseState || {}));
  const baseView = campaignViewOf(base, camp);
  const sent = bodyView(body, { landingShared: landingIsShared(base, body) });
  const changed = Object.keys(sent).filter(k => norm(k, sent[k]) !== norm(k, baseView[k]));
  const mine = {};
  const unmappable = [];
  const imgPatch = {};
  for (const k of changed) {
    const v = sent[k];
    if (k === 'reviewGuide') mine.review_guide = replaceReviewSection(base.review_guide, v);
    else if (k === 'specialNotes') mine.special_notes = _t(v);
    else if (k === 'reviewGuideImages') imgPatch.review = v;
    else if (k === 'specialNotesImages') imgPatch.notes = v;
    else if (k === 'inflowType') mine.inflow_type = norm('inflowType', v);
    else if (k === 'thumbnail_url') mine.thumbnail_url = _t(v);
    else if (k === 'time_range') mine.purchase_time = _t(v);
    else if (k === 'channel') { mine.purchase_channel = _t(v); mine.purchase_channel_custom = !KNOWN_CHANNELS.has(_t(v)); }
    else if (k === 'landing_url') {
      // 랜딩 = (링크유입) 유입가이드 첫 주소 || 상품 주소. 가이드에 주소가 있으면 상품 주소를 바꿔도 랜딩이 안 바뀐다 → 왕복 검사에서 걸린다.
      mine.product_url = _t(v);
    }
  }
  if (Object.keys(imgPatch).length) mine.guide_images = _setImages(base.guide_images, imgPatch);
  // ── 왕복 검사: 되돌린 값을 다시 투영하면 관리자가 보낸 값이 그대로 나와야 한다 ──
  if (changed.length) {
    const after = campaignViewOf({ ...base, ...mine }, camp);
    for (const k of changed) {
      if (norm(k, after[k]) !== norm(k, sent[k])) unmappable.push({ key: k, label: LABELS[k] || k, want: norm(k, sent[k]), got: norm(k, after[k]) });
    }
  }
  // 구매시간 시간창(참여형 공고): 시각은 글자에서 나온다.
  //   ㉮ 관리자가 글자를 고쳤으면 시각은 새 글자에서 — 화면이 보낸 시각이 다르면 남길 수 없다(공유 저장의 투영이 시각을 쓴다).
  //   ㉯ 글자를 안 고쳤으면 화면이 본 글자(기준)에서 나온 시각과 비교 — 다르면 "시각만 바꿈" = 남길 수 없다(조용히 버리지 않고 말한다).
  //      같고, 그 사이 글자도 안 바뀌었으면(지금 = 기준) 화면 시각을 써도 글자와 맞다 → 종전 저장이 쓰게 둔다(windowsWritable)
  //      — 글자는 있는데 시각이 비어 있던 공고가 저장으로 바로잡히던 종전 동작 유지. 그 사이 글자가 바뀌었으면 쓰지 않는다.
  let windowsWritable = false;
  if (camp && camp.participation_mode === true && body) {
    const auto = body.auto_order === true;
    const ws = auto ? '' : body.window_start, we = auto ? '' : body.window_end;
    if (ws !== undefined && ws !== null && we !== undefined && we !== null) {
      const touched = changed.includes('time_range');
      const text = touched ? _t(sent.time_range) : _t(baseView.time_range);
      const win = _isFree(text) ? { start: '', end: '' } : parsePurchaseTime(text);
      const expect = win ? [win.start, win.end] : [_hhmm(camp.window_start), _hhmm(camp.window_end)];
      if (_hhmm(ws) !== expect[0] || _hhmm(we) !== expect[1]) {
        unmappable.push({ key: 'time_range', label: '구매시간(시간창)', want: `${_hhmm(ws)}~${_hhmm(we)}`, got: `${expect[0]}~${expect[1]}` });
      } else if (!touched && win && norm('time_range', camp.time_range) === norm('time_range', baseView.time_range)) {
        windowsWritable = true;
      }
    }
  }
  return { mine, changed: changed.map(k => LABELS[k] || k), unmappable, windowsWritable };
}

/* ── 5단계 — 리뷰비 · 결제금액(결정 263 · 사용자 확정 D2·D3) ─────────────────────────────────────────────
   공고 창의 리뷰비 칸 = 작업오더 review_fee. 옵션표 금액 = 작업오더 상품 구성의 그 줄 금액(옵션 `pay` · 옵션 없는 상품 `base.pay`).
   옵션 없는 공고는 상품 안내 글(productLines)의 `결제금액 N원` 이 리뷰어가 보는 금액이다.
   ★ 손댄 칸 판정은 창을 연 시점(기준 스냅숏)의 투영 값과 비교한다(위 글 칸과 같은 규칙) — 그 사이 리뷰오더에서 바뀐 금액을
     옛 화면 값으로 되돌리지 않는다(옵션표는 `protectOptionLeaves`, 상품 안내 글은 keepProductLines 가 지금 값을 남긴다).
   ★ 되돌린 값은 다시 투영해 화면 값이 그대로 나오는지 본다(왕복 검사) — 안 나오면 unmappable(추측하지 않는다).
   ★ 구매수량 단계를 쓰는 상품의 금액은 리뷰오더에서만 고친다(단계별 금액 계산이 따로 있다). */

const _payAmountsFromWorkOrder = (j) => require('./workOrderPayAmounts').payAmountsFromWorkOrder(j);

function _parseProducts(raw) {
  if (Array.isArray(raw)) return JSON.parse(JSON.stringify(raw));
  try { const v = JSON.parse(String(raw || '')); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

function _hasTiers(p) {
  const t = p && p.qty_tiers;
  if (t == null) return false;
  if (Array.isArray(t)) return t.length > 0;
  return typeof t === 'object' ? Object.keys(t).length > 0 : String(t).trim() !== '';
}

/** 발행 프리필 `_woOptionRows` 와 같은 순서로 "그 줄이 상품 구성의 어느 자리에서 나왔나" 를 적는다(줄 i ↔ 자리 i). */
function _rowSources(products) {
  const out = [];
  products.forEach((prod, i) => {
    if (!prod || typeof prod !== 'object') return;
    const opts = Array.isArray(prod.options) ? prod.options : [];
    if (opts.length) opts.forEach((op, j) => out.push({ i, j }));
    else if (String(prod.name || '').replace(/\|/g, '').trim()) out.push({ i, j: -1 });
  });
  return out;
}

function _setPay(products, src, pay) {
  const prod = products[src.i];
  if (src.j >= 0) prod.options[src.j].pay = pay;
  else prod.base = { ...(prod.base && typeof prod.base === 'object' ? prod.base : {}), pay };
}

/** 공고 창 옵션 한 줄의 비교 열쇠 — 투영(`orderToCampaignProjection.optionShape`)과 같은 규칙. */
function _bodyOptKey(o) {
  const pn = String(o.productName ?? o.product_name ?? '').replace(/\|/g, '').trim();
  const unit = String(o.unitKind ?? o.unit_kind ?? '') === 'product' ? 'product' : 'option';
  const ok = String(o.optKey ?? o.opt_key ?? '').replace(/\|/g, '').trim();
  return `${pn}|${unit === 'product' ? '' : ok}`;
}

/** 그 줄의 가이드가 실제로 읽히는 자리 — 발행 프리필 `_woUnitGuide` 와 같다: 옵션 줄 = 그 옵션(단 "옵션 없음" 류 라벨은 상품),
 *  상품 줄 = 상품(`productUnitSrc` 가 base 를 가리키는 옛 초안이면 base 는 금액·인원 칸이라 여기서 못 고친다 → null). */
function _guideTarget(products, src) {
  const compose = require('./inflowGuideCompose');
  const prod = products[src.i];
  if (!prod) return null;
  if (src.j >= 0) {
    const op = prod.options[src.j];
    const lab = String(op && op.label || '').replace(/\|/g, '').trim();
    const isNone = !lab || /^(옵션\s*없음|없음|단일(상품)?|해당\s*없음)$/.test(lab);
    // "옵션 없음" 류 라벨 줄은 프리필이 상품 자리를 읽는데 인트라넷은 옵션 자리에 싣는다 — 어느 쪽에 써도 다음 저장이 되돌린다(검토 2026-10-20) → 못 고침
    return isNone ? null : { i: src.i, j: src.j };
  }
  return compose.productUnitSrc(prod) === prod ? { i: src.i, j: -1 } : null;
}

function _setGuide(products, t, guide) {
  const node = t.j >= 0 ? products[t.i].options[t.j] : products[t.i];
  // 비운 가이드도 칸은 남긴다({글:'', 사진:[]}) — 칸을 지우면 인트라넷 수신이 "안 실었다" 로 읽어 옛 가이드를 남긴다(검토 2026-10-20)
  node.guide = guide === null ? { text: '', images: [] } : guide;
}

/** 공고 창 한 줄의 가이드 → 오더 가이드(바뀌었을 때만). 인트라넷 화면 규칙과 같게 빈 가이드는 칸을 지운다. */
function _planGuideEdit({ products, src, srcCount, rowCount, o, name, baseRow, dbRow }) {
  const compose = require('./inflowGuideCompose');
  const { canonGuide, imageKey } = require('./guideCanon');
  const imgs = Array.isArray(o.inflowGuideImages) ? o.inflowGuideImages : [];
  const sent = canonGuide(o.inflowGuideHtml, imgs);
  const shapeKey = g => JSON.stringify([g.text, g.images.map(imageKey).join(',')]);
  // 손대지 않음 = 창을 연 시점 오더 투영과 같거나, 창이 불러온 지금 공고 값과 같다(공고에서만 고쳐 둔 옛 가이드를 저장 한 번에 오더로 끌어오지 않는다 · 검토 2026-10-20)
  if (baseRow && shapeKey(sent) === JSON.stringify([baseRow.inflow_guide_html, baseRow.inflow_guide_images])) return {};
  if (dbRow && dbRow.inflow_guide_html !== undefined && shapeKey(sent) === shapeKey(canonGuide(dbRow.inflow_guide_html, Array.isArray(dbRow.inflow_guide_images) ? dbRow.inflow_guide_images : []))) return {};
  if (!products || !src || srcCount !== rowCount) return { unmappable: { label: `유입가이드(${name})`, want: shapeKey(sent), got: '' } };
  const t = _guideTarget(products, src);
  const cur = t ? (t.j >= 0 ? products[t.i].options[t.j] : products[t.i]) : (src.j >= 0 ? products[src.i].options[src.j] : products[src.i]);
  const now = compose.composeUnitGuide(t ? cur : compose.productUnitSrc(products[src.i]));
  const was = canonGuide(now.html, now.images);
  if (shapeKey(was) === shapeKey(sent)) return {};               // 손대지 않음
  if (!t) return { unmappable: { label: `유입가이드(${name}) — 옛 형식 오더`, want: shapeKey(sent), got: shapeKey(was) } };
  const guide = (!sent.text && !sent.images.length) ? null : { text: sent.text, images: sent.images };
  return { guide, target: t, wantKey: shapeKey(sent) };
}

/** 리뷰 혼합 수량 → 저장 모양 배열([{type, quantity}] · 0 은 뺀다). */
function _mixArray(v) {
  const { normalizeReviewTypeMix } = require('./reviewTypeMix');
  let raw = v;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw || '[]'); } catch (_) { raw = []; } }
  const st = normalizeReviewTypeMix(Array.isArray(raw) ? raw : []);
  return (st.mix || []).filter(e => Number(e.quantity) > 0);
}

/**
 * 7단계-② 공고 창 인원 → 오더(사용자 확정 2026-10-20 ③: 오더는 "총모집 = 상품·옵션 인원 합계" — 무제한(0)·합계 다름은 담지 않는다).
 *   옵션 줄 인원·일건수·혼합 수량 → 그 줄의 자리(옵션 count/daily · 상품 줄 base · "옵션 없음" 류 줄의 혼합 수량은 상품 base — 프리필이 읽는 자리).
 *   옵션 줄 없는 공고 → 총모집·일건수·혼합 수량을 단일 선택지(상품 하나 · 옵션 하나 이하)의 자리로. 여럿이면 어느 것인지 정할 근거가 없다.
 *   공고 총모집·일건수는 옵션 합계와 같아야 한다(바꾼 경우). 구매수량 단계 상품은 못 고친다(4단계).
 */
/** 일건수 자리 — 인트라넷은 `daily`, 옛 모양은 `daily_limit`/`dailyLimit`(프리필은 daily_limit 을 먼저 읽는다). 있는 키는 모두 같은 값으로. */
function _setDaily(node, v) {
  node.daily = v;
  if (node.daily_limit !== undefined) node.daily_limit = v;
  if (node.dailyLimit !== undefined) node.dailyLimit = v;
}

function _planQuantityEdit({ base, products, baseRows, liveCampOpts, body, edited, suppressTotals = false }) {
  const out = { mine: {}, changed: [], unmappable: [], edited: null };
  const int = v => Math.max(0, Math.floor(Number(v) || 0));
  const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(base)));
  const sentTop = v => v !== undefined && v !== null && v !== '';
  if (!products || !products.length) {
    // 상품 구성이 없는 오더 — 총모집·일 진행 건수는 오더 칸 그대로(종전에는 계획 없이 돌아가 "저장됨" 인데 아무 데도 안 바뀌었다 · 검토 2026-10-21)
    if (sentTop(body.recruit_total) && CANON.int(body.recruit_total) !== CANON.int(pre.recruit_total)) {
      if (int(body.recruit_total) === 0) out.unmappable.push({ key: 'recruit_total', label: '총모집 0(무제한)은 리뷰오더에 담을 수 없습니다', want: '0', got: CANON.int(pre.recruit_total) });
      else { out.mine.recruit_count = int(body.recruit_total); out.changed.push('총모집'); }
    }
    if (sentTop(body.daily_limit) && CANON.int(body.daily_limit) !== CANON.int(pre.daily_limit)) { out.mine.daily_count = int(body.daily_limit); out.changed.push('일 진행 건수'); }
    if (body.review_type_mix !== undefined && body.review_type_mix !== null
        && CANON.reviewTypeMix(_mixArray(body.review_type_mix)) !== CANON.reviewTypeMix(_mixArray(pre.review_type_mix))) {
      out.mine.review_type_mix = JSON.stringify(_mixArray(body.review_type_mix)); out.changed.push('리뷰타입 혼합 수량');
    }
    return out;
  }
  const srcs = _rowSources(products);
  const ed = edited || JSON.parse(JSON.stringify(products));
  let touched = false;
  const nodeOf = (src, forMix) => {
    const prod = ed[src.i];
    if (src.j >= 0) {
      const op = prod.options[src.j];
      const lab = String(op && op.label || '').replace(/\|/g, '').trim();
      const isNone = !lab || /^(옵션\s*없음|없음|단일(상품)?|해당\s*없음)$/.test(lab);
      if (!(forMix && isNone)) return op;
    }
    if (!prod.base || typeof prod.base !== 'object') prod.base = {};
    return prod.base;
  };
  const hasOptRows = liveCampOpts.length > 0 && baseRows.length > 0;
  if (Array.isArray(body.options) && hasOptRows) {
    const byKey = new Map(baseRows.map((r, k) => [r.key, k]));
    for (const o of body.options) {
      if (!o || typeof o !== 'object') continue;
      const key = _bodyOptKey(o);
      const k = byKey.get(key);
      if (k === undefined) {
        // 오더에 없는 줄 — 이름을 바꾼 줄이면 원래 줄(prevOptKey)의 인원·일건수와 같아야 한다(금액과 같은 막이 · 검토 2026-10-21).
        //   이름과 인원을 함께 바꾸면 오더와 짝을 못 지어, 옵션 저장이 하한 검사·오더 반영 없이 인원을 그대로 쓴다.
        const prev = String(o.prevOptKey ?? o.prev_opt_key ?? '').replace(/\|/g, '').trim();
        const was = prev ? liveCampOpts.find(r => String(r.opt_key || '') === prev) : null;
        const rt0 = o.recruitTotal ?? o.recruit_total, dl0 = o.dailyLimit ?? o.daily_limit;
        if (was && ((rt0 !== undefined && CANON.int(rt0) !== CANON.int(was.recruit_total)) || (dl0 !== undefined && CANON.int(dl0) !== CANON.int(was.daily_limit)))) {
          out.unmappable.push({ key, label: `인원(${prev} → ${String(o.optKey || '').trim()}) — 이름과 인원을 함께 바꿈. 이름을 먼저 바꿔 저장한 뒤 인원을 바꿔 주세요`, want: String(rt0), got: CANON.int(was.recruit_total) });
        }
        continue;
      }
      const br = baseRows[k];
      const rt = int(o.recruitTotal ?? o.recruit_total), dl = int(o.dailyLimit ?? o.daily_limit);
      const mxRaw = o.reviewTypeMix ?? o.review_type_mix;
      // 안 보낸 칸 = 손대지 않음(인원 칸이 없는 화면·호출이 0 으로 읽혀 "무제한으로 바꿨다" 가 되지 않게)
      const sentRt = (o.recruitTotal ?? o.recruit_total) !== undefined, sentDl = (o.dailyLimit ?? o.daily_limit) !== undefined;
      const cntCh = sentRt && CANON.int(rt) !== br.recruit_total, dlCh = sentDl && CANON.int(dl) !== br.daily_limit;
      const mxCh = mxRaw !== undefined && CANON.reviewTypeMix(_mixArray(mxRaw)) !== br.review_type_mix;
      if (!cntCh && !dlCh && !mxCh) continue;
      const label = `인원(${br.name})`;
      const src = srcs[k];
      if (!src || srcs.length !== baseRows.length) { out.unmappable.push({ key, label, want: String(rt), got: br.recruit_total }); continue; }
      if (_hasTiers(products[src.i])) { out.unmappable.push({ key, label: `${label} — 구매수량 단계 상품(구조 단계에서 엽니다)`, want: String(rt), got: br.recruit_total }); continue; }
      if (cntCh && rt === 0) { out.unmappable.push({ key, label: `${label} — 인원 0(무제한)은 리뷰오더에 담을 수 없습니다. 인원을 정해 주세요`, want: '0', got: br.recruit_total }); continue; }
      if (cntCh) nodeOf(src, false).count = rt;
      if (dlCh) _setDaily(nodeOf(src, false), dl);
      if (mxCh) nodeOf(src, true).review_type_mix = _mixArray(mxRaw);
      touched = true;
      out.changed.push(label);
    }
  } else if (!hasOptRows) {
    // 옵션 줄 없는 공고 — 공고 칸 = 단일 선택지
    const one = srcs.length === 1 ? srcs[0] : null;
    const tCh = body.recruit_total !== undefined && body.recruit_total !== null && body.recruit_total !== '' && CANON.int(body.recruit_total) !== CANON.int(pre.recruit_total);
    const dCh = body.daily_limit !== undefined && body.daily_limit !== null && body.daily_limit !== '' && CANON.int(body.daily_limit) !== CANON.int(pre.daily_limit);
    const mCh = body.review_type_mix !== undefined && body.review_type_mix !== null && CANON.reviewTypeMix(_mixArray(body.review_type_mix)) !== CANON.reviewTypeMix(_mixArray(pre.review_type_mix));
    if ((tCh || dCh || mCh) && (!one || _hasTiers(products[one.i]))) {
      out.unmappable.push({ key: 'recruit_total', label: '총모집·일 진행 건수 — 상품이 둘 이상이거나 구매수량 단계 상품이라 어느 상품의 인원인지 정할 수 없습니다', want: String(body.recruit_total), got: CANON.int(pre.recruit_total) });
      return out;
    }
    if (tCh && int(body.recruit_total) === 0) { out.unmappable.push({ key: 'recruit_total', label: '총모집 0(무제한)은 리뷰오더에 담을 수 없습니다', want: '0', got: CANON.int(pre.recruit_total) }); return out; }
    if (tCh) { nodeOf(one, false).count = int(body.recruit_total); touched = true; out.changed.push('총모집'); }
    if (dCh) { _setDaily(nodeOf(one, false), int(body.daily_limit)); touched = true; out.changed.push('일 진행 건수'); }
    if (mCh) { nodeOf(one, true).review_type_mix = _mixArray(body.review_type_mix); touched = true; }
  }
  if (!touched && !(body.review_type_mix !== undefined && body.review_type_mix !== null
      && CANON.reviewTypeMix(_mixArray(body.review_type_mix)) !== CANON.reviewTypeMix(_mixArray(pre.review_type_mix)))) {
    if (suppressTotals) return out;   // 7단계-④ 상품·옵션을 더하거나 지운 저장 — 합계 검사는 구조를 반영한 뒤 한 번 한다
    // 공고 칸만 바꾸고 옵션 줄은 그대로 = 합계와 달라진다(③)
    const tOnly = hasOptRows && body.recruit_total !== undefined && body.recruit_total !== null && body.recruit_total !== '' && CANON.int(body.recruit_total) !== CANON.int(pre.recruit_total);
    if (tOnly) out.unmappable.push({ key: 'recruit_total', label: '총모집 — 옵션별 인원 합계가 총모집이 되도록 맞춰 주세요', want: CANON.int(body.recruit_total), got: CANON.int(pre.recruit_total) });
    // 일 진행 건수만 바꾸고 옵션별 일건수는 그대로 = 공고 칸은 공유 저장이 안 쓰고(_bx) 오더에도 못 담아 "저장됨" 인데 아무 데도 안 바뀐다(검토 2026-10-21)
    const dOnly = hasOptRows && body.daily_limit !== undefined && body.daily_limit !== null && body.daily_limit !== '' && CANON.int(body.daily_limit) !== CANON.int(pre.daily_limit);
    if (dOnly) out.unmappable.push({ key: 'daily_limit', label: '일 진행 건수 — 옵션별 일건수 합계가 일 진행 건수가 되도록 맞춰 주세요', want: CANON.int(body.daily_limit), got: CANON.int(pre.daily_limit) });
    return out;
  }
  // 합계(오더 = 상품·옵션 인원 합계)
  let total = 0, daily = 0;
  for (const p of ed) {
    const opts = Array.isArray(p.options) ? p.options : [];
    const b0 = p.base && typeof p.base === 'object' ? p.base : {};
    if (opts.length) for (const op of opts) { total += int(op.count); daily += int(op.daily ?? op.daily_limit ?? op.dailyLimit); }
    else { total += int(b0.count); daily += int(b0.daily ?? b0.daily_limit ?? b0.dailyLimit); }
  }
  if (touched) {
    out.mine.recruit_count = total;
    if (daily > 0) out.mine.daily_count = daily;
    out.edited = ed;
  }
  // 공고 총모집·일건수를 바꿨으면 합계와 같아야 한다(③) — 상품·옵션을 더하거나 지운 저장은 구조를 반영한 뒤 따로 본다
  if (!suppressTotals && hasOptRows && body.recruit_total !== undefined && body.recruit_total !== null && body.recruit_total !== ''
      && CANON.int(body.recruit_total) !== CANON.int(pre.recruit_total) && int(body.recruit_total) !== total) {
    out.unmappable.push({ key: 'recruit_total', label: `총모집 — 옵션별 인원 합계(${total}명)가 총모집(${int(body.recruit_total)}명)이 되도록 맞춰 주세요`, want: CANON.int(body.recruit_total), got: String(total) });
  }
  if (!suppressTotals && hasOptRows && body.daily_limit !== undefined && body.daily_limit !== null && body.daily_limit !== ''
      && CANON.int(body.daily_limit) !== CANON.int(pre.daily_limit) && daily > 0 && int(body.daily_limit) !== daily) {
    out.unmappable.push({ key: 'daily_limit', label: `일 진행 건수 — 옵션별 일건수 합계(${daily})가 일 진행 건수(${int(body.daily_limit)})가 되도록 맞춰 주세요`, want: CANON.int(body.daily_limit), got: String(daily) });
  }
  // 공고 리뷰타입 혼합 수량(유형 구성은 그대로일 때만 — 공유 저장이 판정)
  if (body.review_type_mix !== undefined && body.review_type_mix !== null
      && CANON.reviewTypeMix(_mixArray(body.review_type_mix)) !== CANON.reviewTypeMix(_mixArray(pre.review_type_mix))) {
    out.mine.review_type_mix = JSON.stringify(_mixArray(body.review_type_mix));
    out.changed.push('리뷰타입 혼합 수량');
  }
  return out;
}

/**
 * 7단계-④ 공고 창 상품·옵션 더하기·지우기·다시 열기 → 오더 상품 구성(사용자 확정 2026-10-21).
 *   판정만 한다(`plan`) — 오더 반영은 `applyStructurePlan` 이 금액·인원 계획을 마친 상품 구성 위에 한다(자리 번호가 밀리지 않게).
 *   지운 줄 = 오더에서 뺀다(참여자가 있으면 공유 저장이 마감으로 되살린다) · 더한 줄 = 오더에 새 옵션(같은 상품) 또는 새 상품 ·
 *   마감 줄을 다시 열기 = 마감 표시를 뗀다(인원은 그 줄 칸).
 * ★ 이름 바꾸기·상품 이름·마감시키기(지우기로 한다)·옵션 없는 공고는 담지 않는다(unmappable).
 */
function _planStructureEdit({ products, baseRows, liveCampOpts, body, guideInflow }) {
  const out = { any: false, removes: [], adds: [], reopens: [], unmappable: [], changed: [] };
  if (!Array.isArray(body.options)) return out;
  if (!products || !(liveCampOpts.length > 0 && baseRows.length > 0)) {
    // 오더 상품 구성과 공고 줄을 짝지을 수 없는 오더(상품 정보 없음 · 옛 형식 · 옵션 줄 없는 공고) — 화면이 공고 줄을 더하거나 지우거나
    //   마감·다시 열기를 하면 오더에 담을 수 없다(종전엔 공고 줄만 바뀌었다 · 검토 2026-10-21). 손대지 않은 저장은 통과.
    const live = new Map(liveCampOpts.map(r => [String(r.opt_key || ''), String(r.status || 'active') === 'closed' ? 'closed' : 'active']));
    const sent = new Map(body.options.filter(o => o && typeof o === 'object')
      .map(o => [String(o.optKey ?? o.opt_key ?? '').replace(/\|/g, '').trim(), o.status === 'closed' ? 'closed' : (o.status === 'active' ? 'active' : null)]));
    const diff = [...sent.keys()].some(k => !live.has(k)) || [...live.keys()].some(k => !sent.has(k))
      || [...sent].some(([k, st]) => st && live.has(k) && live.get(k) !== st);
    if (diff) out.unmappable.push({ key: 'options', label: '상품·옵션 더하기·지우기 — 이 리뷰오더는 상품 구성과 공고 줄을 짝지을 수 없어 공고에서 바꿀 수 없습니다(리뷰오더에서 바꿔 주세요)', want: '', got: '' });
    return out;
  }
  const sentKeys = new Map();
  for (const o of body.options) if (o && typeof o === 'object') sentKeys.set(_bodyOptKey(o), o);
  const baseByKey = new Map(baseRows.map((r, k) => [r.key, k]));
  const srcs = _rowSources(products);
  const hasOptRows = true;
  const prevOf = o => String(o.prevOptKey ?? o.prev_opt_key ?? '').replace(/\|/g, '').trim();
  const renamedFrom = new Set();
  for (const [key, o] of sentKeys) {
    if (baseByKey.has(key)) continue;
    const prev = prevOf(o);
    const wasRow = prev && baseRows.find(r => r.key.split('|')[1] === prev || (r.unit_kind === 'product' && r.key.split('|')[0] === prev));
    if (wasRow && !sentKeys.has(wasRow.key) && prev !== String(o.optKey ?? o.opt_key ?? '').trim()) {
      renamedFrom.add(wasRow.key);
      out.unmappable.push({ key, label: `이름 바꾸기(${prev} → ${String(o.optKey ?? o.opt_key ?? '').trim()}) — 다음 단계에서 엽니다`, want: key, got: wasRow.key });
      continue;
    }
    if (!hasOptRows) { out.unmappable.push({ key, label: '옵션 없는 공고에 상품·옵션 더하기 — 옵션 있음·없음 바꾸기와 함께 엽니다', want: key, got: '' }); continue; }
    const pName = String(o.productName ?? o.product_name ?? '').replace(/\|/g, '').trim();
    const unit = String(o.unitKind ?? o.unit_kind ?? '') === 'product' ? 'product' : 'option';
    const same = products.find(p => p && String(p.name || '').replace(/\|/g, '').trim() === (unit === 'product' ? (pName || String(o.optKey ?? o.opt_key ?? '').trim()) : pName));
    if (same && (unit === 'product' || !(Array.isArray(same.options) && same.options.length))) {
      out.unmappable.push({ key, label: unit === 'product'
        ? `상품 추가(${pName}) — 같은 이름의 상품이 이미 있습니다`
        : `옵션 추가(${pName}) — 옵션 없는 상품에 옵션 더하기는 옵션 있음·없음 바꾸기와 함께 엽니다`, want: key, got: '' });
      continue;
    }
    out.adds.push(o);
  }
  if (hasOptRows) {
    baseRows.forEach((r, k) => {
      if (sentKeys.has(r.key) || renamedFrom.has(r.key)) return;
      out.removes.push({ src: srcs[k], name: r.name, closed: r.status === 'closed' });
    });
    for (const [key, o] of sentKeys) {
      const k = baseByKey.get(key);
      if (k === undefined) continue;
      const st = o.status === 'closed' ? 'closed' : (o.status === 'active' ? 'active' : null);
      if (!st || st === baseRows[k].status) continue;
      if (st === 'active') out.reopens.push({ src: srcs[k], name: baseRows[k].name, o });
      else out.unmappable.push({ key, label: `마감(${baseRows[k].name}) — 참여자가 있는 옵션은 지우면 마감으로 남습니다. 지우기로 해 주세요`, want: 'closed', got: 'active' });
    }
  }
  if (srcs.length !== baseRows.length && (out.removes.length || out.reopens.length)) {
    out.unmappable.push({ key: 'options', label: '상품·옵션 — 리뷰오더 상품 구성과 공고 줄을 짝지을 수 없습니다', want: '', got: '' });
  }
  for (const r of out.removes) if (_hasTiers(products[r.src.i])) out.unmappable.push({ key: r.name, label: `${r.name} — 구매수량 단계 상품은 접수 뒤 더하거나 지울 수 없습니다`, want: '', got: '' });
  out.guideInflow = guideInflow;
  out.any = out.adds.length + out.removes.length + out.reopens.length > 0;
  out.removes.forEach(r => out.changed.push(`삭제(${r.name})`));
  out.adds.forEach(o => out.changed.push(`추가(${String(o.optKey ?? o.opt_key ?? o.productName ?? '').trim()})`));
  out.reopens.forEach(r => out.changed.push(`다시 열기(${r.name})`));
  return out;
}

/** 구조 계획을 상품 구성 사본(금액·인원 계획까지 반영된 것)에 적용한다. 자리(src)는 원래 상품 구성 기준이라 같은 사본의 노드 참조로 옮긴다. */
function applyStructurePlan(ed, st) {
  const int = v => Math.max(0, Math.floor(Number(v) || 0));
  const { canonGuide } = require('./guideCanon');
  const dropNodes = new Set();
  for (const r of st.removes) {
    const prod = r.src && ed[r.src.i];
    if (!prod) continue;
    dropNodes.add(r.src.j >= 0 ? prod.options[r.src.j] : prod);
  }
  for (const r of st.reopens) {
    const prod = r.src && ed[r.src.i];
    if (!prod) continue;
    const node = r.src.j >= 0 ? prod.options[r.src.j] : prod;
    delete node.closed;
    const tgt = r.src.j >= 0 ? node : (prod.base = prod.base && typeof prod.base === 'object' ? prod.base : {});
    const rt = r.o.recruitTotal ?? r.o.recruit_total, dl = r.o.dailyLimit ?? r.o.daily_limit;
    if (rt !== undefined) tgt.count = int(rt);
    if (dl !== undefined) _setDaily(tgt, int(dl));
  }
  let list = ed.filter(p => !dropNodes.has(p)).map(p => {
    if (!Array.isArray(p.options) || !p.options.length) return p;
    const kept = p.options.filter(o => !dropNodes.has(o));
    return kept.length ? { ...p, options: kept } : null;   // 옵션을 다 지운 상품 = 상품째 지움
  }).filter(Boolean);
  const nameOf = p => String(p && p.name || '').replace(/\|/g, '').trim();
  for (const o of st.adds) {
    const pName = String(o.productName ?? o.product_name ?? '').replace(/\|/g, '').trim();
    const unit = String(o.unitKind ?? o.unit_kind ?? '') === 'product' ? 'product' : 'option';
    const optKey = String(o.optKey ?? o.opt_key ?? '').replace(/\|/g, '').trim();
    const pay = int(o.payAmount ?? o.pay_amount), count = int(o.recruitTotal ?? o.recruit_total), daily = int(o.dailyLimit ?? o.daily_limit);
    const mix = _mixArray(o.reviewTypeMix ?? o.review_type_mix);
    const url = String(o.optionUrl ?? o.option_url ?? '').trim();
    const g = canonGuide(o.inflowGuideHtml ?? o.inflow_guide_html ?? '', o.inflowGuideImages ?? o.inflow_guide_images ?? []);
    const guide = st.guideInflow && (g.text || g.images.length) ? { guide: { text: g.text, images: g.images } } : {};
    if (unit === 'product') {
      list.push({ name: pName || optKey, url, option_schema_version: 2, product_mode: 'none', ...guide,
        base: { pay, count, daily, review_type_mix: mix }, options: [] });
      continue;
    }
    const opt = { option_1: { name: '옵션', value: optKey }, label: optKey, url, pay, count, daily, review_type_mix: mix, ...guide };
    const at = list.findIndex(p => nameOf(p) === pName && Array.isArray(p.options) && p.options.length);
    if (at >= 0) list[at] = { ...list[at], options: [...list[at].options, opt] };
    else list.push({ name: pName, url, option_schema_version: 2, product_mode: 'opt', base: { pay: 0, count: 0, daily: 0, review_type_mix: [] }, options: [opt] });
  }
  let total = 0, daily = 0;
  for (const p of list) {
    const opts = Array.isArray(p.options) ? p.options : [];
    const b0 = p.base && typeof p.base === 'object' ? p.base : {};
    if (opts.length) for (const op of opts) { total += int(op.count); daily += int(op.daily ?? op.daily_limit ?? op.dailyLimit); }
    else { total += int(b0.count); daily += int(b0.daily ?? b0.daily_limit ?? b0.dailyLimit); }
  }
  return { products: list, total, daily };
}

/** 마감 줄(참여한 수로 굳은 옵션·상품)의 인원 합 — 공고 창 총모집은 열린 줄만 더한 값이라(진행상품 표 규칙) 오더 총모집과 비교하기 전에 더한다. */
function closedCountSum(products) {
  const int = v => Math.max(0, Math.floor(Number(v) || 0));
  return (Array.isArray(products) ? products : []).reduce((a, p) => {
    if (!p || typeof p !== 'object') return a;
    const opts = Array.isArray(p.options) ? p.options : [];
    if (opts.length) return a + opts.filter(o => o && o.closed === true).reduce((x, o) => x + int(o.count), 0);
    return a + (p.closed === true ? int(p.base && p.base.count) : 0);
  }, 0);
}

/**
 * @param {{ baseState:object, camp:object, body:object, campOptions?:object[] }} p
 * @returns {{ mine:object, changed:string[], unmappable:Array<{key,label,want,got}>, keepProductLines:boolean }}
 */
function planCampaignMoneyEdit({ baseState, camp, body, campOptions = [] }) {
  const { projectOrderToCampaign } = require('./orderToCampaignProjection');
  const { distinctAmountsInText } = require('../services/campaignPayAmountSync.service');
  const base = JSON.parse(JSON.stringify(baseState || {}));
  let b = body || {};
  // 공고 창은 열린 줄 중 하나라도 일건수가 비면(0) 일 진행 건수를 0 으로 보낸다(진행상품 표 규칙 — "모름") — 0 으로 바꿨다고 읽지 않는다(검토 2026-10-21)
  if (Array.isArray(b.options) && Number(b.daily_limit) === 0 && b.daily_limit !== '' && b.daily_limit !== null
      && b.options.some(o => o && o.status !== 'closed' && !(Number(o.dailyLimit ?? o.daily_limit) > 0))) {
    b = { ...b }; delete b.daily_limit;
  }
  const mine = {};
  const changed = [];
  const unmappable = [];
  let keepProductLines = false;

  // ① 리뷰비
  if (b.review_fee !== undefined && b.review_fee !== null) {
    const sent = CANON.int(b.review_fee);
    const was = CANON.int(_woCampaignPrefill(JSON.parse(JSON.stringify(base))).review_fee);
    if (sent !== was) { mine.review_fee = Number(sent) || 0; changed.push('리뷰비'); }
  }

  const products = _parseProducts(base.product_options_json);
  const baseRows = projectOrderToCampaign(base).options;
  const liveCampOpts = (campOptions || []).filter(r => String(r.status || '') !== 'deleted');
  let edited = null;
  const want = new Map();   // 줄 열쇠 → 화면이 보낸 금액
  const guideWant = new Map();   // 줄 열쇠 → 화면이 보낸 가이드(투영 비교 모양)
  const wdIn = b.work_detail && typeof b.work_detail === 'object' && b.work_detail.inflowType !== undefined ? b.work_detail.inflowType : base.inflow_type;
  const guideInflow = String(wdIn || '').trim() === 'guide';

  if (Array.isArray(b.options) && baseRows.length && liveCampOpts.length) {
    // ② 옵션 있는 공고 — 옵션표 금액
    const byKey = new Map(baseRows.map((r, k) => [r.key, k]));
    const srcs = products ? _rowSources(products) : [];
    for (const o of b.options) {
      if (!o || typeof o !== 'object') continue;
      const key = _bodyOptKey(o);
      const k = byKey.get(key);
      if (k === undefined) {
        // 오더에 없는 줄 — 이름을 바꾼 줄이면 원래 줄(prevOptKey)의 금액과 같아야 한다. 이름과 금액을 함께 바꾸면 오더와 짝을 지을 수 없다
        // (옵션 저장이 금액을 그대로 써 오더·공고가 갈라진다 · 검토 2026-10-20). 새로 더한 줄(원래 줄 없음)은 공고 전용이라 그대로 둔다.
        const prev = String(o.prevOptKey ?? o.prev_opt_key ?? '').replace(/\|/g, '').trim();
        const was = prev ? liveCampOpts.find(r => String(r.opt_key || '') === prev) : null;
        const pay = Math.max(0, Math.floor(Number(o.payAmount ?? o.pay_amount) || 0));
        if (was && CANON.int(pay) !== CANON.int(was.pay_amount)) {
          unmappable.push({ key, label: `결제금액(${prev} → ${String(o.optKey || '').trim()}) — 이름과 금액을 함께 바꿈`, want: String(pay), got: CANON.int(was.pay_amount) });
        }
        continue;
      }
      const src = srcs[k];
      // ── 6단계: 선택지 유입가이드(가이드유입 공고만 — 링크유입 공고의 가이드는 오더가 싣지 않는 공고 전용 값) ──
      if (guideInflow && (o.inflowGuideHtml !== undefined || o.inflowGuideImages !== undefined)) {
        const dbRow = liveCampOpts.find(r => String(r.opt_key || '') === String(o.optKey ?? o.opt_key ?? '').trim());
        const gEdit = _planGuideEdit({ products, src, srcCount: srcs.length, rowCount: baseRows.length, o, name: baseRows[k].name, baseRow: baseRows[k], dbRow });
        if (gEdit.unmappable) unmappable.push({ key, ...gEdit.unmappable });
        else if (gEdit.guide !== undefined) {
          if (!edited) edited = JSON.parse(JSON.stringify(products));
          _setGuide(edited, gEdit.target, gEdit.guide);
          guideWant.set(key, gEdit.wantKey);
          changed.push(`유입가이드(${baseRows[k].name})`);
        }
      }
      const pay = Math.max(0, Math.floor(Number(o.payAmount ?? o.pay_amount) || 0));
      if (CANON.int(pay) === baseRows[k].pay_amount) continue;  // 손대지 않음
      const label = `결제금액(${baseRows[k].name})`;
      if (!products || !src || srcs.length !== baseRows.length) { unmappable.push({ key, label, want: String(pay), got: baseRows[k].pay_amount }); continue; }
      if (_hasTiers(products[src.i])) { unmappable.push({ key, label: `${label} — 구매수량 단계 상품`, want: String(pay), got: baseRows[k].pay_amount }); continue; }
      if (!edited) edited = JSON.parse(JSON.stringify(products));
      _setPay(edited, src, pay);
      want.set(key, CANON.int(pay));
      changed.push(label);
    }
    if (edited) {
      const after = new Map(projectOrderToCampaign({ ...base, product_options_json: JSON.stringify(edited) }).options.map(r => [r.key, r]));
      for (const r of baseRows) {
        const got = after.get(r.key);
        const expect = want.has(r.key) ? want.get(r.key) : r.pay_amount;
        if (!got || got.pay_amount !== expect) unmappable.push({ key: r.key, label: `결제금액(${r.name})`, want: expect, got: got ? got.pay_amount : '' });
        // 가이드 왕복 — 되돌린 오더 값을 다시 투영하면 화면이 보낸 {글, 사진} 이 그대로 나와야 한다(안 바꾼 줄은 그대로여야 한다)
        const gotGuide = got ? JSON.stringify([got.inflow_guide_html, got.inflow_guide_images]) : '';
        const expectGuide = guideWant.has(r.key) ? guideWant.get(r.key) : JSON.stringify([r.inflow_guide_html, r.inflow_guide_images]);
        if (gotGuide !== expectGuide) unmappable.push({ key: r.key, label: `유입가이드(${r.name})`, want: expectGuide, got: gotGuide });
      }
    }
  } else if (!liveCampOpts.length && b.work_detail && typeof b.work_detail === 'object'
      && Object.prototype.hasOwnProperty.call(b.work_detail, 'productLines')) {
    // ③ 옵션 없는 공고(공고 옵션 줄 0개 — 단일 상품은 발행 프리필이 줄을 만들어도 공고에는 저장하지 않는다) — 상품 안내 글의 금액
    const wd = (camp && camp.work_detail && typeof camp.work_detail === 'object') ? camp.work_detail : {};
    const sentAmts = distinctAmountsInText(b.work_detail.productLines);
    const nowAmts = distinctAmountsInText(wd.productLines);
    const baseAmts = _payAmountsFromWorkOrder(base.product_options_json).distinct;
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    if (!same(sentAmts, nowAmts)) {
      if (same(sentAmts, baseAmts) && !same(nowAmts, baseAmts)) {
        // 창을 연 뒤 리뷰오더에서 바뀐 금액 — 지금 값 유지. 단 금액 말고 다른 문장까지 고쳤으면 통째 유지가 그 수정을 버리므로 새로고침을 받는다(검토 2026-10-20).
        const stripAmt = t => String(t == null ? '' : t).replace(/결제금액\s*[\d,]+\s*원/g, '결제금액 #원').replace(/\s+/g, ' ').trim();
        if (stripAmt(b.work_detail.productLines) === stripAmt(wd.productLines)) keepProductLines = true;
        else unmappable.push({ key: 'productLines', label: '상품 안내 — 창을 연 뒤 리뷰오더에서 금액이 바뀌었습니다. 새로고침한 뒤 다시 고쳐 주세요', want: sentAmts.join(','), got: nowAmts.join(',') });
      }
      else {
        const units = _payAmountsFromWorkOrder(base.product_options_json).units;
        const label = '결제금액';
        if (sentAmts.length !== 1 || !products || units.length !== 1 || _hasTiers(products.find(p => p && String(p.name || '').replace(/\|/g, '').trim() === units[0].productName))) {
          unmappable.push({ key: 'productLines', label: `${label} — 상품 안내에 금액이 여러 개이거나 상품이 둘 이상`, want: sentAmts.join(','), got: nowAmts.join(',') });
        } else {
          const srcs = _rowSources(products);
          if (srcs.length !== 1) unmappable.push({ key: 'productLines', label, want: String(sentAmts[0]), got: nowAmts.join(',') });
          else {
            edited = JSON.parse(JSON.stringify(products));
            _setPay(edited, srcs[0], sentAmts[0]);
            if (_payAmountsFromWorkOrder(JSON.stringify(edited)).single !== sentAmts[0]) {
              unmappable.push({ key: 'productLines', label, want: String(sentAmts[0]), got: nowAmts.join(',') });
              edited = null;
            } else changed.push(label);
          }
        }
      }
    }
  }
  // ⑤ 7단계-③ 주말 제외 — 참·거짓을 보냈고 기준(창을 연 버전)과 다를 때만(안 보냄 = 손대지 않음)
  //   ★ "바꿨다" = 기준(오더)과도 지금 공고 값과도 다를 때 — 공고 창은 공고 값으로 열린다. 오더·공고가 이미 갈라진 공고에서 손대지 않은 저장이
  //     오더를 공고 값으로 뒤집지 않게(검토 2026-10-21). 오더 값으로 되돌리는 토글은 공유 저장이 쓸 게 없어 공고 칸만 맞춘다(campaign.routes).
  if (typeof b.skip_weekends === 'boolean' && b.skip_weekends !== (CANON.bool(base.skip_weekends) === '1')
      && b.skip_weekends !== ((camp || {}).skip_weekends === true)) {
    mine.skip_weekends = b.skip_weekends;
    changed.push('주말 제외');
  }
  // ⑥ 7단계-④ 상품·옵션 더하기·지우기·다시 열기(판정 — 반영은 금액·인원 계획 뒤)
  const st = _planStructureEdit({ products, baseRows, liveCampOpts, body: b, guideInflow });
  unmappable.push(...st.unmappable);
  // ④ 7단계-② 인원·일건수·리뷰타입 혼합 수량 — 공고 창 총모집(열린 줄만)에 마감 줄 인원을 더해 오더 총모집과 같은 기준으로
  const baseClosed = closedCountSum(products);
  const sentRt = b.recruit_total !== undefined && b.recruit_total !== null && b.recruit_total !== '';
  const bq = baseClosed && sentRt ? { ...b, recruit_total: Math.max(0, Math.floor(Number(b.recruit_total) || 0)) + baseClosed } : b;
  const q = _planQuantityEdit({ base, products, baseRows, liveCampOpts, body: bq, edited, suppressTotals: st.any });
  unmappable.push(...q.unmappable);
  changed.push(...q.changed);
  Object.assign(mine, q.mine);
  if (q.edited) edited = q.edited;
  if (st.any && products) {
    const r = applyStructurePlan(edited || JSON.parse(JSON.stringify(products)), st);
    edited = r.products;
    changed.push(...st.changed);
    mine.recruit_count = r.total;
    if (r.daily > 0) mine.daily_count = r.daily;
    const int = v => Math.max(0, Math.floor(Number(v) || 0));
    const sentTop = v => v !== undefined && v !== null && v !== '';
    // 공고 총모집(열린 줄만) + 마감 줄 인원 = 구조를 반영한 합계여야 한다(지운 줄에 참여자가 있으면 저장 때 그 수만큼 더해진다)
    const openTotal = r.total - closedCountSum(r.products);
    if (sentTop(b.recruit_total) && int(b.recruit_total) !== openTotal) {
      unmappable.push({ key: 'recruit_total', label: `총모집 — 열린 상품·옵션 인원 합계(${openTotal}명)가 총모집(${int(b.recruit_total)}명)이 되도록 맞춰 주세요`, want: CANON.int(b.recruit_total), got: String(openTotal) });
    }
    if (sentTop(b.daily_limit) && r.daily > 0 && int(b.daily_limit) !== r.daily) {
      unmappable.push({ key: 'daily_limit', label: `일 진행 건수 — 상품·옵션 일건수 합계(${r.daily})가 일 진행 건수(${int(b.daily_limit)})가 되도록 맞춰 주세요`, want: CANON.int(b.daily_limit), got: String(r.daily) });
    }
  }
  if (edited && !unmappable.length) mine.product_options_json = JSON.stringify(edited);
  return { mine, changed, unmappable, keepProductLines };
}

/** 옛 화면(기준 버전 없음)의 금액 판정 — 지금 공고 값과 다른 금액 칸 이름(있으면 저장 거부). */
function moneyDriftFromCampaign(camp, body, campOptions = []) {
  const { distinctAmountsInText } = require('../services/campaignPayAmountSync.service');
  const b = body || {};
  const c = camp || {};
  const out = [];
  if (b.review_fee !== undefined && b.review_fee !== null && CANON.int(b.review_fee) !== CANON.int(c.review_fee)) out.push('리뷰비');
  // 7단계-② — 총모집·일 진행 건수·옵션 인원(옛 화면은 기준 버전을 몰라 받지 않는다)
  // 공고 창 총모집은 열린 줄만 — 마감 줄 인원(공고 옵션 줄 status closed)을 더해 공고 총모집과 비교한다(7단계-④)
  const closedRt = (campOptions || []).filter(r => String(r.status || '') === 'closed').reduce((a, r) => a + Math.max(0, Math.floor(Number(r.recruit_total) || 0)), 0);
  if (b.recruit_total !== undefined && b.recruit_total !== null && b.recruit_total !== '' && CANON.int(Number(b.recruit_total) + closedRt) !== CANON.int(c.recruit_total)) out.push('총모집');
  if (b.daily_limit !== undefined && b.daily_limit !== null && b.daily_limit !== '' && CANON.int(b.daily_limit) !== CANON.int(c.daily_limit)) out.push('일 진행 건수');
  // 7단계-③ — 주말 제외(옛 화면은 기준 버전을 몰라 받지 않는다)
  if (typeof b.skip_weekends === 'boolean' && b.skip_weekends !== (c.skip_weekends === true)) out.push('주말 제외');
  const live = (campOptions || []).filter(r => String(r.status || '') !== 'deleted');
  if (Array.isArray(b.options) && live.length) {
    const now = new Map(live.map(r => [String(r.opt_key || ''), CANON.int(r.pay_amount)]));
    if (b.options.some(o => o && now.has(String(o.optKey ?? o.opt_key ?? '').trim())
        && now.get(String(o.optKey ?? o.opt_key ?? '').trim()) !== CANON.int(o.payAmount ?? o.pay_amount ?? 0))) out.push('결제금액');
    // 안 보낸 칸은 비교하지 않는다(인원 칸이 없는 호출이 "0 으로 바꿨다" 로 읽히지 않게)
    const rowOf = new Map(live.map(r => [String(r.opt_key || ''), r]));
    if (b.options.some(o => {
      const r = o && rowOf.get(String(o.optKey ?? o.opt_key ?? '').trim());
      if (!r) return false;
      const rt = o.recruitTotal ?? o.recruit_total, dl = o.dailyLimit ?? o.daily_limit;
      return (rt !== undefined && CANON.int(rt) !== CANON.int(r.recruit_total)) || (dl !== undefined && CANON.int(dl) !== CANON.int(r.daily_limit));
    })) out.push('옵션 인원');
  } else if (!live.length && b.work_detail && typeof b.work_detail === 'object' && Object.prototype.hasOwnProperty.call(b.work_detail, 'productLines')) {
    const wd = c.work_detail && typeof c.work_detail === 'object' ? c.work_detail : {};
    if (distinctAmountsInText(b.work_detail.productLines).join(',') !== distinctAmountsInText(wd.productLines).join(',')) out.push('결제금액');
  }
  return out;
}

/** 랜딩이 공유 칸인가 — 저장 뒤 유입방식이 링크유입이면(화면이 보낸 유입방식 우선). */
function landingIsShared(baseState, body) {
  const wd = body && body.work_detail && typeof body.work_detail === 'object' ? body.work_detail : null;
  const t = wd && wd.inflowType !== undefined ? wd.inflowType : (baseState && baseState.inflow_type);
  return norm('inflowType', t) === 'link';
}

/** 옛 화면(기준 버전 없음) 판정 — 대상 칸 중 지금 공고 값과 다른 것(있으면 저장 거부, 새로고침 안내). */
function driftFromCampaign(camp, body) {
  const now = campaignRowView(camp);
  const sent = bodyView(body, { landingShared: norm('inflowType', (body && body.work_detail && body.work_detail.inflowType) || now.inflowType) === 'link' });
  return Object.keys(sent).filter(k => norm(k, sent[k]) !== norm(k, now[k])).map(k => LABELS[k] || k);
}

/**
 * 7단계-④ — 공고 창 저장이 연결 공고의 **구조**를 바꾸는가(옵션 구성·상품 방식·배송 방식·리뷰타입 종류·체험단 종류).
 * `store` = 라우트가 정규화한 저장 값(undefined/null = 안 보냄 = 유지). 인원·혼합 수량은 7단계-② 공유 저장이 맡아 여기서 보지 않는다.
 * `permanent` = 접수 뒤에는 바꾸지 않는 변경(사용자 확정 2026-10-21 「4.가」 — 체험단 종류 전환·배송 혼합·회수: 작업표 모양이 달라진다 · 운영 0건).
 * ★ 순수 함수 — DB 없음.
 * @returns {Array<{label:string, permanent:boolean}>}
 */
function structureChangesFromCampaign({ camp, campOptions = [], store = {}, normOpts = null } = {}) {
  const { deliveryBaseType } = require('./deliveryType');
  const c = camp || {};
  const s = store || {};
  const out = [];
  const add = (label, permanent = false) => {
    const hit = out.find(x => x.label === label);
    if (hit) hit.permanent = hit.permanent || permanent; else out.push({ label, permanent });
  };
  const sent = v => v !== undefined && v !== null;

  if (sent(s.work_kind) && CANON.workKind(s.work_kind) !== CANON.workKind(c.work_kind)) add('체험단 종류', true);

  // 배송 — 기본형이 바뀌거나 같은 기본형 안에서 글자가 바뀌면 구조. 혼합·회수가 끼면 접수 뒤에는 못 바꾼다.
  //   부속정보(혼합 수량·회수 정보)는 그 기본형일 때만 본다 — 기본형이 아니면 라우트가 빈 값으로 지우므로 남아 있던 옛 값과 비교하면 헛걸린다.
  const SPECIAL = new Set(['혼합', '회수']);
  const curBase = deliveryBaseType(c.delivery_type) || '';
  const nextBase = sent(s.delivery_type) ? (deliveryBaseType(s.delivery_type) || '') : curBase;
  if (nextBase !== curBase) add('배송 방식', SPECIAL.has(nextBase) || SPECIAL.has(curBase));
  else if (sent(s.delivery_type) && _t(s.delivery_type) !== _t(c.delivery_type)) add('배송 방식', SPECIAL.has(curBase));
  if (curBase === '혼합' && nextBase === '혼합' && sent(s.delivery_type_mix)
      && CANON.deliveryMix(s.delivery_type_mix) !== CANON.deliveryMix(c.delivery_type_mix)) add('배송 혼합', true);
  if (curBase === '회수' && nextBase === '회수'
      && ((sent(s.recall_courier) && _t(s.recall_courier) !== _t(c.recall_courier))
        || (sent(s.recall_product) && _t(s.recall_product) !== _t(c.recall_product)))) add('회수 정보', true);

  // 리뷰타입 — 종류만(수량은 7단계-②). 섞어 쓰기 안에서 섞는 종류가 바뀌어도 구조.
  const curRt = CANON.reviewType(c.review_type);
  const nextRt = sent(s.review_type) ? CANON.reviewType(s.review_type) : curRt;
  if (nextRt !== curRt) add('리뷰타입');
  else if (curRt === 'mixed' && sent(s.review_type_mix)) {
    const types = v => [...new Set(_mixArray(v).map(e => String(e.type)))].sort().join(',');
    if (types(s.review_type_mix) !== types(c.review_type_mix)) add('리뷰타입');
  }

  // 옵션·상품 구성 — 지금 공고 옵션 줄(지운 줄 제외)과 화면이 보낸 줄
  if (Array.isArray(normOpts)) {
    const cur = new Map((campOptions || []).filter(r => _t(r.status) !== 'deleted').map(r => [_t(r.opt_key), r]));
    const sentKeys = new Set(normOpts.map(o => o.optKey));
    const renamedFrom = new Set();
    for (const o of normOpts) {
      const r = cur.get(o.optKey);
      if (!r) {
        const prev = o.prevOptKey && o.prevOptKey !== o.optKey ? o.prevOptKey : '';
        if (prev && cur.has(prev) && !sentKeys.has(prev)) { renamedFrom.add(prev); add('옵션·상품 이름'); }
        else add('옵션·상품 추가');
        continue;
      }
      if (_t(o.productName) !== _t(r.product_name)) add('상품 이름');
      if ((o.unitKind === 'product' ? 'product' : 'option') !== (_t(r.unit_kind) === 'product' ? 'product' : 'option')) add('상품 방식(옵션 있음·없음)');
      if (o.status && o.status !== (_t(r.status) === 'closed' ? 'closed' : 'active')) add('옵션 마감·다시 열기');
    }
    for (const k of cur.keys()) if (!sentKeys.has(k) && !renamedFrom.has(k)) add('옵션·상품 삭제');
  }
  return out;
}

module.exports = {
  planCampaignSharedEdit, driftFromCampaign, campaignViewOf, campaignRowView, bodyView, replaceReviewSection, norm, landingIsShared,
  planCampaignMoneyEdit, moneyDriftFromCampaign, structureChangesFromCampaign, applyStructurePlan, closedCountSum,
  WD_KEYS, TOP_KEYS, LABELS,
};
