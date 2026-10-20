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
 *   상품 페이지(랜딩) · 구매채널. 옵션표(옵션 URL·옵션별 유입가이드·금액·인원)는 다음 단계(5·7) — 여기서는 다루지 않는다.
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
  WD_KEYS, TOP_KEYS, LABELS,
};
