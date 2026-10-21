// ═══════════════════════════════════════════════════════════════════════════
// 오더·공고 맞추기 — 값이 서로 다른(아직 양방향 연결 전) 작업오더 ↔ 모집공고를 직원이 칸마다 쪽을 골라 맞추고 연결한다
// (결정 263 · 사용자 확정 2026-10-21 「C스타일 · 리뷰웹 관리자 · 칸마다 고르기 + 전부 한쪽 · 관리자 이상」)
//
// ★★ 판정·변환을 새로 만들지 않는다 — 단일 출처를 태운다:
//    · 무엇이 다른가 = `compareOrderCampaign`(연결 판정 `linkSharedOrder` · 대조 보고서와 같은 비교)
//    · 공고 값 → 오더 값 = 공고 편집 창 저장이 쓰는 되돌리기 계산(`planCampaignSharedEdit` · `planCampaignMoneyEdit`, 왕복 검사 포함)
//    · 오더 값 → 공고 = 공유 저장(`applySharedPatch`, origin 'reconcile')의 공고 반영 본체
// ★★ 두 단계(한 트랜잭션 — `applySharedPatch` 안에서):
//    ① P = 오더를 지금 공고와 같게(공고 쪽으로 옮길 수 있는 모든 칸) — 오더 행만 바꾸고 기준 스냅숏으로 적는다(공고는 이미 그 값)
//    ② T = P 에서 "오더 쪽" 을 고른 칸만 원래 오더 값으로 — 공유 저장의 보통 길(이름 바꾸기·마감·인원·금액 투영)로 공고에 반영
//    끝에 다시 비교해 한 칸이라도 다르면 통째로 되돌린다(fail-closed · `reconcile_incomplete`).
// ★ 공고 쪽으로 옮길 수 없는 칸(왕복 검사 실패 · 옵션 주소 등)은 "공고 쪽" 을 잠근다(campaignSide.ok=false). 오더 쪽은 공고 반영을 강제로 건다(`force`).
// ★ 접수 뒤 영구 금지 칸(체험단 종류 · 배송 혼합 · 회수)이 다르면 그 작업은 여기서 맞추지 않는다(blocked — 이유를 말한다).
// ★ 화면이 본 차이와 지금 차이가 다르면(그 사이 누가 고침) 409 `reconcile_stale` — 새로고침 안내(지문 fingerprint).
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');
const { compareOrderCampaign, projectOrderToCampaign, readCampaignShared } = require('../utils/orderToCampaignProjection');
const { CANON } = require('../utils/sharedFields');

const PERMANENT = new Set(['work_kind', 'delivery_type_mix', 'recall_courier', 'recall_product']);
const SCALAR_LABEL = {
  time_range: '구매시간', review_fee: '리뷰비', recruit_total: '총모집', daily_limit: '일 진행 건수', delivery_type: '배송 방식',
  delivery_type_mix: '배송 혼합', recall_courier: '회수 택배사', recall_product: '회수 상품', review_type: '리뷰타입',
  review_type_mix: '리뷰타입 혼합 수량', work_kind: '체험단 종류', thumbnail_url: '썸네일', skip_weekends: '주말 제외',
  channel: '구매채널', landing_url: '상품 페이지 주소',
};
const LEAF_LABEL = {
  name: '이름', unit_kind: '옵션 있음·없음', option_url: '주소', pay_amount: '결제금액', recruit_total: '인원', daily_limit: '일건수',
  review_type_mix: '리뷰타입 수량', guide: '유입가이드', status: '마감 여부',
};
/** 공고 쪽 값을 오더로 옮기는 계산이 없는 칸 — 오더 쪽만(공고 반영을 강제로 건다). */
const ORDER_ONLY_LEAVES = new Set(['option_url']);

const _s = v => (v == null ? '' : String(v)).trim();

/** 비교 모양의 리뷰타입 수량(CANON 글자 "photo:3,text:2") → 편집 본문 배열. 읽을 수 없는 값(`invalid:…`)은 던진다 — 부르는 쪽이 그 칸을 잠근다(검토 2026-10-21). */
function _mixArr(v) {
  const s = _s(v);
  if (!s) return [];
  if (s.startsWith('invalid:')) { const e = new Error('mix_invalid'); e.code = 'mix_invalid'; throw e; }
  return s.split(',').filter(Boolean).map(p => { const [type, q] = p.split(':'); return { type, quantity: Number(q) || 0 }; });
}

const _rtName = k => require('../utils/reviewType').reviewTypeLabel(k) || k;   // 이름표 단일 출처
const _won = v => `${Number(v || 0).toLocaleString('ko-KR')}원`;
/** 사람이 읽는 값 — 칸 종류별(화면은 이 글자를 그대로 보여 준다). 빈 값 = "(비어 있음)". */
function _text(key, raw) {
  const v = raw == null ? '' : String(raw);
  if (key === 'presence') return v === 'present' ? '있음' : '없음';
  if (key === 'review_type' && v === '') return '자율리뷰';
  if (v === '') return '(비어 있음)';
  if (key === 'review_fee' || key === 'pay_amount') return _won(v);
  if (key === 'recruit_total') return `${Number(v) || 0}명`;
  if (key === 'daily_limit') return `하루 ${Number(v) || 0}건`;
  if (key === 'skip_weekends') return v === '1' ? '주말 제외' : (v === '0' ? '주말 포함' : '아직 안 정함');
  if (key === 'review_type') return _rtName(v);
  if (key === 'status') return v === 'closed' ? '마감' : '모집 중';
  if (key === 'unit_kind') return v === 'product' ? '옵션 없음' : '옵션 있음';
  if (key === 'review_type_mix') {
    try { const a = _mixArr(v); return a.length ? a.map(e => `${_rtName(e.type)} ${e.quantity}`).join(' · ') : '없음'; } catch (_) { return '(읽을 수 없는 값)'; }
  }
  return v;
}

/** 비교 결과(옵션 줄 짝짓기 포함)를 칸 묶음으로 — 가이드 글·사진은 한 칸("유입가이드")으로 고른다. */
function diffFields(wo, camp, opts) {
  const raw = compareOrderCampaign(wo, camp, opts).filter(d => d.kind === 'diff');
  const out = new Map();
  for (const d of raw) {
    let id = d.field, label, group = 'scalar', key = d.field, leaf = null, row = null;
    const m = /^option:(.+?)(?:\.(\w+))?$/.exec(d.field);
    if (m) {
      row = m[1]; leaf = m[2] || 'presence';
      if (leaf === 'inflow_guide_html' || leaf === 'inflow_guide_images') leaf = 'guide';
      id = `option:${row}.${leaf}`; group = 'option'; key = leaf;
      label = leaf === 'presence' ? `줄 있음·없음 (${row})` : `${LEAF_LABEL[leaf] || leaf} (${row})`;
    } else label = SCALAR_LABEL[d.field] || d.field;
    const cur = out.get(id) || { id, label, group, key, row, leaf, order: [], campaign: [], parts: [], _o: {}, _c: {} };
    cur.parts.push(d.field); cur.order.push(d.order); cur.campaign.push(d.campaign);
    const part = /\.(\w+)$/.exec(d.field); const pk = part ? part[1] : d.field;
    cur._o[pk] = d.order; cur._c[pk] = d.campaign;
    out.set(id, cur);
  }
  const guideText = (o) => {
    const t = String(o.inflow_guide_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const n = String(o.inflow_guide_images || '').split(',').filter(Boolean).length;
    return [t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : '(글 없음)', n ? `사진 ${n}장` : ''].filter(Boolean).join(' · ');
  };
  return [...out.values()].map(f => {
    const orderText = f.leaf === 'guide' ? guideText(f._o) : _text(f.key, f.order[0]);
    const campaignText = f.leaf === 'guide' ? guideText(f._c) : _text(f.key, f.campaign[0]);
    const { _o, _c, ...rest } = f;
    return { ...rest, order: f.order.join(' · '), campaign: f.campaign.join(' · '), orderText, campaignText };
  });
}

function fingerprint(fields) {
  const src = fields.map(f => `${f.id}=${f.order}␟${f.campaign}`).sort().join('\n');
  return crypto.createHash('sha1').update(src).digest('hex').slice(0, 16);
}

/* ── 줄 짝짓기 — compareOrderCampaign 과 같은 규칙(같은 열쇠 → 남은 수가 같으면 순서대로). 칸 id 이름 = 오더 줄 이름(없으면 공고 줄). ── */
function _pairRows(orderRows, campRows) {
  const byKey = new Map(campRows.map(o => [o.key, o]));
  const out = [], onlyOrder = [];
  for (const oa of orderRows) {
    const ob = byKey.get(oa.key);
    if (!ob) { onlyOrder.push(oa); continue; }
    byKey.delete(oa.key);
    out.push({ name: oa.name, o: oa, c: ob, renamed: false });
  }
  const onlyCamp = [...byKey.values()];
  if (onlyOrder.length && onlyOrder.length === onlyCamp.length) {
    onlyOrder.forEach((oa, i) => out.push({ name: oa.name, o: oa, c: onlyCamp[i], renamed: true }));
  } else {
    for (const oa of onlyOrder) out.push({ name: oa.name, o: oa, c: null, renamed: false });
    for (const ob of onlyCamp) out.push({ name: ob.name, o: null, c: ob, renamed: false });
  }
  return out;
}

/** 공고 줄 하나(투영 비교 모양) → 공고 편집 본문 줄. */
function _bodyRow(r, extra = {}) {
  const [pName, optKey] = r.key.split('|');
  return {
    productName: pName, optKey: r.unit_kind === 'product' ? '' : optKey, unitKind: r.unit_kind,
    payAmount: Number(r.pay_amount) || 0, recruitTotal: Number(r.recruit_total) || 0, dailyLimit: Number(r.daily_limit) || 0,
    reviewTypeMix: _mixArr(r.review_type_mix),
    inflowGuideHtml: r.inflow_guide_html, inflowGuideImages: r._images || [],
    status: r.status, ...extra,
  };
}

/** 공고 DB 줄 모양(되돌리기 계산의 liveCampOpts) — 상품 단위 줄은 opt_key 에 상품명(발행 규칙). */
function _dbRow(r) {
  const [pName, optKey] = r.key.split('|');
  return {
    opt_key: r.unit_kind === 'product' ? pName : optKey, product_name: pName, unit_kind: r.unit_kind, status: r.status,
    recruit_total: Number(r.recruit_total) || 0, daily_limit: Number(r.daily_limit) || 0, pay_amount: Number(r.pay_amount) || 0,
    inflow_guide_html: r.inflow_guide_html, inflow_guide_images: r._images || [], review_type_mix: r.review_type_mix,
  };
}

/**
 * 공고 편집 본문을 만든다 — `from`(지금 모습) 에서 시작해, 고른 칸(S)만 `to`(바꿀 모습) 값으로.
 * 줄은 원래 비교의 짝(오더 줄 ↔ 공고 줄)을 따른다. `fromIsOrder` = from 이 오더 쪽이면 true(①), 공고 쪽이면 false(②).
 */
function _mixedBody({ from, to, pairs, S, fromIsOrder, hasRows }) {
  const pick = id => S.has(id);
  const b = {};
  const sc = (k, conv = v => v) => { b[k] = conv(pick(k) ? to[k] : from[k]); };
  sc('review_fee', v => Number(v) || 0);
  sc('time_range'); sc('thumbnail_url'); sc('landing_url');
  { const ch = pick('channel') ? to.channel : from.channel; b.channel = ch; b.channel_custom = ''; }
  sc('skip_weekends', v => v === '1');
  sc('review_type'); sc('delivery_type');
  if (!hasRows) { sc('recruit_total', v => Number(v) || 0); sc('daily_limit', v => Number(v) || 0); sc('review_type_mix', _mixArr); }
  if (!hasRows) return b;
  // 줄 — 짝마다 from 줄에서 시작해 고른 잎만 to 값으로. 이름을 to 로 고르면 이름을 바꾸고 원래 이름(prevOptKey)을 싣는다.
  const opts = [];
  for (const pr of pairs) {
    const f = fromIsOrder ? pr.o : pr.c, t = fromIsOrder ? pr.c : pr.o;
    const L = leaf => pick(`option:${pr.name}.${leaf}`);
    if (!f) { if (t && L('presence')) opts.push(_bodyRow(t)); continue; }      // from 에 없는 줄 — 고르면 더한다
    if (!t) { if (!L('presence')) opts.push(_bodyRow(f)); continue; }           // to 에 없는 줄 — 고르면 뺀다
    const row = _bodyRow(f);
    if (L('pay_amount')) row.payAmount = Number(t.pay_amount) || 0;
    if (L('recruit_total')) row.recruitTotal = Number(t.recruit_total) || 0;
    if (L('daily_limit')) row.dailyLimit = Number(t.daily_limit) || 0;
    if (L('review_type_mix')) row.reviewTypeMix = _mixArr(t.review_type_mix);
    if (L('guide')) { row.inflowGuideHtml = t.inflow_guide_html; row.inflowGuideImages = t._images || []; }
    if (L('status')) row.status = t.status;
    if (L('name') && f.key !== t.key) {
      const [tp, to2] = t.key.split('|');
      const [fp, fo] = f.key.split('|');
      row.productName = tp; row.optKey = t.unit_kind === 'product' ? '' : to2;
      row.prevOptKey = f.unit_kind === 'product' ? fp : fo;
    }
    opts.push(row);
  }
  b.options = opts;
  return b;
}

/** 투영 비교 모양 + 사진 원본(되돌리기 계산은 사진 목록 원본을 받는다). */
function _withImages(rows, srcRows) {
  return rows.map((r, i) => ({ ...r, _images: Array.isArray(srcRows[i] && srcRows[i].inflowGuideImages) ? srcRows[i].inflowGuideImages
    : (srcRows[i] && Array.isArray(srcRows[i].inflow_guide_images) ? srcRows[i].inflow_guide_images : []) }));
}

function _orderView(state) {
  const { _woCampaignPrefill } = require('../utils/woCampaignPrefill.generated');
  const v = projectOrderToCampaign(state);
  const pre = _woCampaignPrefill(JSON.parse(JSON.stringify(state || {})));
  v.options = _withImages(v.options, pre.options || []);
  return v;
}

function _campView(camp, opts) {
  const v = readCampaignShared(camp, opts);
  const live = (opts || []).filter(o => _s(o.status) !== 'deleted');
  v.options = _withImages(v.options, live);
  return v;
}

/** 되돌리기 계산에 넘길 "지금 공고" — 실제 공고 행 위에, 비교하는 칸만 `view` 값으로 덮는다(그 계산은 "지금 공고와 다른 칸" 만 바꿨다고 읽는다). */
function _fakeCamp(camp, view) {
  const ch = _s(view.channel);
  const known = new Set(['쿠팡', '네이버', '올리브영', '카카오메이커스']);
  return { ...camp, review_type: view.review_type, delivery_type: view.delivery_type, skip_weekends: view.skip_weekends === '1',
    time_range: view.time_range, thumbnail_url: view.thumbnail_url, landing_url: view.landing_url,
    channel: ch ? (known.has(ch) ? ch : '직접입력') : camp.channel, channel_custom: ch && !known.has(ch) ? ch : '' };
}

/**
 * base 상태(오더 공유 상태)를 `to` 모습 쪽으로 S 칸만 옮긴 새 상태 — 공고 편집 창 저장의 되돌리기 계산 그대로.
 * @returns {{ state: object, mine: object, unmappable: Array<{label:string}> }}
 */
function _planToward({ baseState, camp, from, to, pairs, S, fromIsOrder, hasRows }) {
  const { planCampaignSharedEdit, planCampaignMoneyEdit } = require('../utils/campaignSharedEdit');
  const body = _mixedBody({ from, to, pairs, S, fromIsOrder, hasRows });
  const fake = _fakeCamp(camp, from);
  const fakeOpts = hasRows ? from.options.map(_dbRow) : [];
  const a = planCampaignSharedEdit({ baseState, camp: fake, body });
  const m = planCampaignMoneyEdit({ baseState, camp: fake, body, campOptions: fakeOpts });
  const mine = { ...a.mine, ...m.mine };
  // 오더 주말 제외가 "아직 안 정함" 이면 되돌리기 계산은 거짓과 같게 읽어 안 바뀐 것으로 본다 → 고른 값을 직접 싣는다(검토 2026-10-21)
  if (S.has('skip_weekends') && (to.skip_weekends === '1' || to.skip_weekends === '0') && !('skip_weekends' in mine)
      && CANON.bool(baseState.skip_weekends) === 'unset') mine.skip_weekends = to.skip_weekends === '1';
  return { state: { ...baseState, ...mine }, mine, unmappable: [...a.unmappable, ...m.unmappable] };
}

/** 상품·옵션 이름 바꾸기 표시(prev_name/prev_label)를 걷어낸 상태 — 기준으로 적을 P 에 남기지 않는다(검토 2026-10-21). */
function _stripRenameMarks(state) {
  const raw = state.product_options_json;
  if (raw == null || raw === '') return state;
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw)); } catch (_) { return state; }
  if (!Array.isArray(list)) return state;
  let changed = false;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    if ('prev_name' in p) { delete p.prev_name; changed = true; }
    for (const o of Array.isArray(p.options) ? p.options : []) if (o && typeof o === 'object' && 'prev_label' in o) { delete o.prev_label; changed = true; }
  }
  if (!changed) return state;
  return { ...state, product_options_json: typeof raw === 'string' ? JSON.stringify(list) : list };
}

/**
 * 한 작업의 맞추기 계획.
 * @param {object} wo  작업오더 행
 * @param {object} camp 살아 있는 공고 행
 * @param {object[]} opts 공고 옵션 행
 * @param {Record<string,'order'|'campaign'>} [picks] 칸 id → 남길 쪽(없으면 고르기 전 — 칸 목록·가능 여부만)
 */
function planReconcile(wo, camp, opts, picks = null) {
  const { readSharedState } = require('./sharedPatch.service');
  const fields = diffFields(wo, camp, opts);
  const fp = fingerprint(fields);
  const O = readSharedState(wo);
  const ov = _orderView(O), cv = _campView(camp, opts);
  const hasRows = cv.options.length > 0 && ov.options.length > 0;
  const pairList = hasRows ? _pairRows(ov.options, cv.options) : [];

  const blocked = fields.filter(f => PERMANENT.has(f.key) && f.group === 'scalar');
  const base = { fields, fingerprint: fp, blocked: blocked.length ? `${blocked.map(f => f.label).join('·')}이(가) 서로 달라 여기서 맞출 수 없습니다 — 접수 뒤에는 바꿀 수 없는 칸입니다. 개발 담당에게 알려 주세요.` : null };
  if (base.blocked || !fields.length) return { ...base, hasRows };

  // 칸마다 "공고 쪽" 을 고를 수 있나 — 그 칸 하나만 옮겨 보고 왕복 검사가 통과하는지
  const tryOne = id => _planToward({ baseState: O, camp, from: ov, to: cv, pairs: pairList, S: new Set([id]), fromIsOrder: true, hasRows });
  for (const f of fields) {
    // 오더 쪽 — 공고는 참·거짓만 담는다. 오더가 "아직 안 정함" 이면 오더 쪽으로 맞출 수 없다
    if (f.group === 'scalar' && f.key === 'skip_weekends' && ov.skip_weekends === 'unset') f.orderSide = { ok: false, reason: '오더에 아직 정하지 않은 값이라 공고 쪽으로만 맞춥니다' };
    if (f.group === 'scalar' && ['recruit_total', 'daily_limit', 'review_type_mix'].includes(f.key) && hasRows) {
      f.derived = true;   // 옵션 줄 있는 공고 — 줄 인원·일건수·수량을 고르면 따라온다(따로 고르지 않는다)
      f.campaignSide = { ok: false, reason: '옵션별 인원·일건수를 고르면 따라 맞춰집니다' };
      continue;
    }
    if (f.group === 'option' && ORDER_ONLY_LEAVES.has(f.leaf)) { f.campaignSide = { ok: false, reason: '공고 쪽 값은 오더로 옮길 수 없는 칸입니다 — 오더 쪽으로만 맞춥니다' }; continue; }
    let r;
    try { r = tryOne(f.id); } catch (e) { f.campaignSide = { ok: false, reason: '공고 쪽 값을 읽을 수 없습니다' }; continue; }
    if (r.unmappable.length) { f.campaignSide = { ok: false, reason: r.unmappable.map(u => u.label).join(' · ') }; continue; }
    // 옮겨 본 뒤 그 칸이 정말 같아지나 — 계산이 조용히 아무것도 안 바꾸면 공고 쪽을 잠근다(검토 2026-10-21)
    let still = true;
    try { still = diffFields({ ...wo, ...r.state }, camp, opts).some(x => x.id === f.id); } catch (_) { still = true; }
    f.campaignSide = still ? { ok: false, reason: '공고 쪽 값으로 옮겨지지 않는 칸입니다 — 오더 쪽으로만 맞춥니다' } : { ok: true };
  }
  if (!picks) return { ...base, hasRows };

  // ── 고른 대로 ──
  const want = new Set(fields.filter(f => !f.derived).map(f => f.id));
  const missing = [...want].filter(id => picks[id] !== 'order' && picks[id] !== 'campaign');
  if (missing.length) return { ...base, hasRows, error: { code: 'reconcile_unpicked', fields: missing } };
  const badCamp = fields.filter(f => picks[f.id] === 'campaign' && !(f.campaignSide && f.campaignSide.ok));
  if (badCamp.length) return { ...base, hasRows, error: { code: 'reconcile_campaign_side_locked', fields: badCamp.map(f => f.id), labels: badCamp.map(f => f.label) } };
  const badOrder = fields.filter(f => picks[f.id] === 'order' && f.orderSide && f.orderSide.ok === false);
  if (badOrder.length) return { ...base, hasRows, error: { code: 'reconcile_order_side_locked', fields: badOrder.map(f => f.id), labels: badOrder.map(f => f.label) } };
  // 옵션 줄 있는 공고의 총모집·일건수·수량(파생)은 줄 고르기를 따라간다 — 줄 인원을 하나라도 공고 쪽으로 고르면 공고 쪽(합계 = 줄 합)
  const derivedIds = fields.filter(f => f.derived).map(f => f.id);

  // ① P = 오더를 공고 쪽으로(공고 쪽으로 옮길 수 있는 모든 칸)
  const allCamp = new Set(fields.filter(f => f.campaignSide && f.campaignSide.ok).map(f => f.id));
  let P1;
  try { P1 = _planToward({ baseState: O, camp, from: ov, to: cv, pairs: pairList, S: allCamp, fromIsOrder: true, hasRows }); }
  catch (e) { return { ...base, hasRows, error: { code: 'reconcile_unmappable', labels: ['읽을 수 없는 값'] } }; }
  if (P1.unmappable.length) return { ...base, hasRows, error: { code: 'reconcile_unmappable', labels: P1.unmappable.map(u => u.label) } };
  const P = _stripRenameMarks(P1.state);
  // ② T = P 에서 오더 쪽으로 고른 칸(공고 쪽으로 옮길 수 있었던 칸만 — 못 옮긴 칸은 P 에 이미 오더 값)
  const toOrder = new Set(fields.filter(f => picks[f.id] === 'order' && allCamp.has(f.id)).map(f => f.id));
  const pv = _orderView(P);
  // ② 의 짝 — P 줄(= 공고 모습) ↔ 오더 줄. P 줄은 공고 줄과 열쇠가 같다(이름까지 옮겼으므로).
  const pByKey = new Map(pv.options.map(r => [r.key, r]));
  // P 에 남은 줄 — 공고 줄 열쇠(이름까지 옮겼으면) 또는 오더 줄 열쇠(공고 쪽으로 못 옮겨 오더 줄이 그대로 남았으면)
  const pairs2 = pairList.map(p => ({ name: p.name, o: p.o, c: (p.c && pByKey.get(p.c.key)) || (p.o && pByKey.get(p.o.key)) || null }));
  let T = P, Tmine = {};
  if (toOrder.size) {
    let T1;
    try { T1 = _planToward({ baseState: P, camp, from: pv, to: ov, pairs: pairs2, S: toOrder, fromIsOrder: false, hasRows }); }
    catch (e) { return { ...base, hasRows, error: { code: 'reconcile_unmappable', labels: ['읽을 수 없는 값'] } }; }
    if (T1.unmappable.length) return { ...base, hasRows, error: { code: 'reconcile_unmappable', labels: T1.unmappable.map(u => u.label) } };
    T = T1.state; Tmine = T1.mine;
  }
  // 공고 쪽으로 못 옮긴 칸(오더 쪽 고정)은 P 에 오더 값이 남아 ② 에 차이가 없다 → 공고 반영을 강제로 건다
  const forced = fields.filter(f => picks[f.id] === 'order' && !allCamp.has(f.id) && !f.derived);
  const force = { urlTouched: forced.some(f => f.leaf === 'option_url') || forced.some(f => f.key === 'landing_url'), keys: [],
    quantity: derivedIds.length > 0 };   // 줄 있는 공고의 총모집·일건수가 줄 합과 어긋남 — 오더(줄 합)로 공고를 다시 맞춘다(검토 2026-10-21)
  const KEYMAP = { review_fee: 'review_fee', time_range: 'purchase_time', thumbnail_url: 'thumbnail_url', channel: 'purchase_channel', skip_weekends: 'skip_weekends', delivery_type: 'delivery_type', landing_url: 'product_url' };
  for (const f of forced) if (f.group === 'scalar' && KEYMAP[f.key]) force.keys.push(KEYMAP[f.key]);
  const forcedUnknown = forced.filter(f => !(f.group === 'option' && f.leaf === 'option_url') && !(f.group === 'scalar' && KEYMAP[f.key]));
  if (forcedUnknown.length) return { ...base, hasRows, error: { code: 'reconcile_unmappable', labels: forcedUnknown.map(f => `${f.label} — ${f.campaignSide.reason}`) } };
  return { ...base, hasRows, derivedIds, P, T, Tmine, force, O };
}

/**
 * 맞추고 연결한다(또는 dryRun = 끝까지 해 보고 되돌린다) — 쓰기는 공유 저장 한 곳(`applySharedPatch`, origin 'reconcile').
 * @returns {Promise<{status:number, body:object}>}
 */
async function reconcileSharedOrder({ workOrderId, picks, fingerprint: fp, dryRun = false, actor = '', opId = '', db } = {}) {
  const { applySharedPatch } = require('./sharedPatch.service');
  return applySharedPatch({ workOrderId, origin: 'reconcile', actor, opId: dryRun ? '' : opId, db,
    mine: {}, baseVersion: 0, reconcile: { picks: picks || {}, fingerprint: fp, dryRun: !!dryRun } });
}

/**
 * 값이 다른 작업 목록 — 인트라넷 리뷰오더로 들어와 살아 있는(보관 아님) 공고가 있고 아직 연결(on) 전인 오더 중 다른 칸이 있는 것.
 * ★ 읽기만 한다.
 */
async function listReconcile(db) {
  const { LINKED_WO_ON } = require('./linkedRecruitQuota.service');
  // 공고 찾기 = liveCampaignForWorkOrders 와 같은 규칙(정방향·역방향 짝 · 보관 제외 · 가장 먼저 만든 것 하나)
  const { rows } = await db.query(`
    SELECT w.*, row_to_json(c.*) AS _campaign,
           (SELECT COALESCE(json_agg(o.* ORDER BY o.sort_order, o.id), '[]'::json) FROM campaign_options o WHERE o.campaign_id = c.id) AS _options
      FROM work_orders w
      JOIN LATERAL (SELECT c.* FROM recruit_campaigns c WHERE c.archived_at IS NULL AND ${LINKED_WO_ON}
                     ORDER BY c.created_at ASC NULLS LAST, c.id ASC LIMIT 1) c ON TRUE
     WHERE w.deleted_at IS NULL AND COALESCE(w.source_review_order_id, '') <> '' AND COALESCE(w.bidir_state, 'off') <> 'on'
     ORDER BY w.created_at DESC`);
  const items = [];
  let usedFor = null;
  try { usedFor = require('./linkedRecruitQuota.service').usedByOption; } catch (_) { usedFor = null; }
  for (const r of rows) {
    const camp = r._campaign, opts = r._options || [];
    let plan;
    try { plan = planReconcile(r, camp, opts); }
    catch (e) {   // 한 작업의 값이 깨져도 목록 전체가 안 열리면 안 된다 — 그 작업만 막힘으로
      items.push({ workOrderId: r.id, sourceReviewOrderId: r.source_review_order_id, title: r.title, workManager: r.work_manager || '',
        campaignId: camp.id, campaignTitle: camp.title, fields: [], fingerprint: '', blocked: '이 작업의 값을 읽지 못해 여기서 맞출 수 없습니다 — 개발 담당에게 알려 주세요.' });
      continue;
    }
    if (!plan.fields.length) continue;
    // 이름·줄 있음·없음 칸 — 이미 참여·구매한 수(안내용 · 못 읽으면 빈 값)
    let used = null;
    if (usedFor && plan.fields.some(f => f.leaf === 'name' || f.leaf === 'presence')) {
      try { used = await usedFor(db, camp.id); } catch (_) { used = null; }
    }
    const cvRows = readCampaignShared(camp, opts).options;
    for (const f of plan.fields) {
      if (!used || !(f.leaf === 'name' || f.leaf === 'presence')) continue;
      const cr = cvRows.find(x => x.name === f.row) || (f.leaf === 'name' ? cvRows.find(x => x.name === f.campaign) : null);
      if (!cr) continue;
      const [pn, ok] = cr.key.split('|');
      const n = used.get(cr.unit_kind === 'product' ? pn : ok) || 0;
      if (n) f.used = n;
    }
    items.push({ workOrderId: r.id, sourceReviewOrderId: r.source_review_order_id, title: r.title, workManager: r.work_manager || '',
      campaignId: camp.id, campaignTitle: camp.title, fields: plan.fields, fingerprint: plan.fingerprint, blocked: plan.blocked });
  }
  return { items, counts: { diverged: items.length } };
}

module.exports = { reconcileSharedOrder, listReconcile, diffFields, _mixArr, _stripRenameMarks, fingerprint, planReconcile, _pairRows, _mixedBody, PERMANENT, SCALAR_LABEL, LEAF_LABEL };
