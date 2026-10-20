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

/**
 * @param {{ baseState:object, camp:object, body:object, campOptions?:object[] }} p
 * @returns {{ mine:object, changed:string[], unmappable:Array<{key,label,want,got}>, keepProductLines:boolean }}
 */
function planCampaignMoneyEdit({ baseState, camp, body, campOptions = [] }) {
  const { projectOrderToCampaign } = require('./orderToCampaignProjection');
  const { distinctAmountsInText } = require('../services/campaignPayAmountSync.service');
  const base = JSON.parse(JSON.stringify(baseState || {}));
  const b = body || {};
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
      const pay = Math.max(0, Math.floor(Number(o.payAmount ?? o.pay_amount) || 0));
      if (CANON.int(pay) === baseRows[k].pay_amount) continue;  // 손대지 않음
      const label = `결제금액(${baseRows[k].name})`;
      const src = srcs[k];
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
  const live = (campOptions || []).filter(r => String(r.status || '') !== 'deleted');
  if (Array.isArray(b.options) && live.length) {
    const now = new Map(live.map(r => [String(r.opt_key || ''), CANON.int(r.pay_amount)]));
    if (b.options.some(o => o && now.has(String(o.optKey ?? o.opt_key ?? '').trim())
        && now.get(String(o.optKey ?? o.opt_key ?? '').trim()) !== CANON.int(o.payAmount ?? o.pay_amount ?? 0))) out.push('결제금액');
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

module.exports = {
  planCampaignSharedEdit, driftFromCampaign, campaignViewOf, campaignRowView, bodyView, replaceReviewSection, norm, landingIsShared,
  planCampaignMoneyEdit, moneyDriftFromCampaign,
  WD_KEYS, TOP_KEYS, LABELS,
};
