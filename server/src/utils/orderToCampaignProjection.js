/**
 * orderToCampaignProjection — 작업오더의 공유 칸이 **모집공고에서는 어떤 값이어야 하는가**(결정 263).
 *
 * ★★ 변환 규칙은 새로 만들지 않는다 — 발행 프리필 `_woCampaignPrefill`(화면 원본을 글자 그대로 옮긴
 *    `woCampaignPrefill.generated.js`)을 그대로 돌린다. 발행할 때 공고가 받는 값 = 동기화가 기대하는 값.
 * ★ 공고 쪽 값은 공고 행·옵션 행에서 같은 모양으로 읽어 칸별로 비교한다.
 *   `fill` = 오더가 비어 있고 공고만 값이 있음(공고 창·상품정보 수집이 채운 것 — 충돌 아님)
 *   `diff` = 둘 다 값이 있는데 다름
 * ★ 비교만 한다 — 아무것도 쓰지 않는다.
 */
'use strict';

const { _woCampaignPrefill } = require('./woCampaignPrefill.generated');
const { CANON } = require('./sharedFields');
const { canonGuide, imageKey } = require('./guideCanon');

function _jsonArr(v) {
  if (v == null || v === '') return [];
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

const _s = (v) => (v == null ? '' : String(v)).trim();

function _mix(v) { return CANON.reviewTypeMix(v); }


function _optionShape(r) {
  const unitKind = _s(r.unitKind) || 'option';
  // ★ 6단계: 선택지 가이드는 글자 모양이 아니라 {글, 사진(파일 id)} 로 비교한다 — 서버 투영(글만 + 사진 목록)과
  //   공고 창 저장(글 + 끝에 <img> + 사진 목록)은 리뷰어에게 똑같이 보인다(`utils/guideCanon`).
  const g = canonGuide(r.inflowGuideHtml, Array.isArray(r.inflowGuideImages) ? r.inflowGuideImages : _jsonArr(r.inflowGuideImages));
  // ★ 상품 단위 줄(옵션 없는 상품)은 공고가 opt_key 에 상품명을 넣어 저장한다(발행 폼 규칙) —
  //   비교 열쇠는 상품명 하나로 맞춘다. 안 맞추면 같은 줄이 "있음/없음" 두 줄로 갈린다(운영 대조 실측).
  const optKey = unitKind === 'product' ? '' : _s(r.optKey);
  return {
    key: `${_s(r.productName)}|${optKey}`,
    name: `${_s(r.productName)}${optKey ? ' / ' + optKey : ''}`,
    unit_kind: unitKind,
    option_url: _s(r.optionUrl),
    pay_amount: CANON.int(r.payAmount),
    recruit_total: CANON.int(r.recruitTotal),
    daily_limit: CANON.int(r.dailyLimit),
    review_type_mix: _mix(r.reviewTypeMix),
    inflow_guide_html: g.text,
    inflow_guide_images: g.images.map(imageKey).join(','),
  };
}

/** 작업오더 → 공고에 기대되는 공유 값. */
function projectOrderToCampaign(order) {
  // ★ 화면은 API 응답(JSON)을 받는다 — DB 행의 Date 등은 같은 직렬화를 거쳐야 같은 입력이 된다.
  const p = _woCampaignPrefill(JSON.parse(JSON.stringify(order || {})));
  return {
    time_range: CANON.time(p.time_range),
    review_fee: CANON.int(p.review_fee),
    recruit_total: CANON.int(p.recruit_total),
    daily_limit: CANON.int(p.daily_limit),
    delivery_type: _s(p.delivery_type),
    delivery_type_mix: CANON.deliveryMix(p.delivery_type_mix),
    recall_courier: _s(p.recall_courier),
    recall_product: _s(p.recall_product),
    review_type: CANON.reviewType(p.review_type),
    review_type_mix: _mix(p.review_type_mix),
    work_kind: CANON.workKind(p.work_kind),
    thumbnail_url: _s(p.thumbnail_url),
    skip_weekends: p.skip_weekends ? '1' : '0',
    channel: _s(p.channel),
    landing_url: _s(p.landing_url),
    options: (p.options || []).map(_optionShape),
  };
}

/** 공고 행 + 옵션 행 → 같은 모양. */
function readCampaignShared(c, optionRows) {
  const camp = c || {};
  const channel = _s(camp.channel) === '직접입력' ? _s(camp.channel_custom) : _s(camp.channel);
  return {
    time_range: CANON.time(camp.time_range),
    review_fee: CANON.int(camp.review_fee),
    recruit_total: CANON.int(camp.recruit_total),
    daily_limit: CANON.int(camp.daily_limit),
    delivery_type: _s(camp.delivery_type),
    delivery_type_mix: CANON.deliveryMix(camp.delivery_type_mix),
    recall_courier: _s(camp.recall_courier),
    recall_product: _s(camp.recall_product),
    review_type: CANON.reviewType(camp.review_type),
    review_type_mix: _mix(camp.review_type_mix),
    work_kind: CANON.workKind(camp.work_kind),
    thumbnail_url: _s(camp.thumbnail_url),
    skip_weekends: camp.skip_weekends ? '1' : '0',
    channel,
    landing_url: _s(camp.landing_url),
    options: (optionRows || [])
      .filter(o => _s(o.status) !== 'deleted')
      .map(o => _optionShape({
        productName: o.product_name, optKey: o.opt_key, unitKind: o.unit_kind, optionUrl: o.option_url,
        payAmount: o.pay_amount, recruitTotal: o.recruit_total, dailyLimit: o.daily_limit,
        reviewTypeMix: o.review_type_mix, inflowGuideHtml: o.inflow_guide_html, inflowGuideImages: o.inflow_guide_images,
      })),
  };
}

const SCALAR_KEYS = ['time_range', 'review_fee', 'recruit_total', 'daily_limit', 'delivery_type', 'delivery_type_mix',
  'recall_courier', 'recall_product', 'review_type', 'review_type_mix', 'work_kind', 'thumbnail_url', 'skip_weekends',
  'channel', 'landing_url'];
const OPTION_KEYS = ['unit_kind', 'option_url', 'pay_amount', 'recruit_total', 'daily_limit', 'review_type_mix',
  'inflow_guide_html', 'inflow_guide_images'];

/**
 * @returns {Array<{field:string, kind:'diff'|'fill', order:string, campaign:string}>}
 * ★ 공고에 옵션 행이 하나도 없으면(옵션 없이 공고 하나로 도는 작업) 옵션 비교를 하지 않는다 — 구조 차이지 값 차이가 아니다.
 */
function compareOrderCampaign(order, campaign, optionRows) {
  const a = projectOrderToCampaign(order);
  const b = readCampaignShared(campaign, optionRows);
  const out = [];
  const push = (field, x, y) => {
    if (x === y) return;
    out.push({ field, kind: (!x && y) ? 'fill' : 'diff', order: x, campaign: y });
  };
  for (const k of SCALAR_KEYS) push(k, a[k], b[k]);
  if (b.options.length && a.options.length) {
    const byKey = new Map(b.options.map(o => [o.key, o]));
    const unmatchedA = [];
    for (const oa of a.options) {
      const ob = byKey.get(oa.key);
      if (!ob) { unmatchedA.push(oa); continue; }
      byKey.delete(oa.key);
      for (const k of OPTION_KEYS) push(`option:${oa.name}.${k}`, oa[k], ob[k]);
    }
    const unmatchedB = [...byKey.values()];
    // ★ 이름이 바뀐 줄 — 남은 줄 수가 같으면 순서대로 짝짓고 "이름이 다름" 한 칸으로 센다
    //   (공고 창에서 "1번 ○○" 처럼 번호를 붙인 경우가 운영에 실제로 있다). 수가 다르면 짝을 추측하지 않는다.
    if (unmatchedA.length && unmatchedA.length === unmatchedB.length) {
      unmatchedA.forEach((oa, i) => {
        const ob = unmatchedB[i];
        push(`option:${oa.name}.name`, oa.name, ob.name);
        for (const k of OPTION_KEYS) push(`option:${oa.name}.${k}`, oa[k], ob[k]);
      });
    } else {
      for (const oa of unmatchedA) out.push({ field: `option:${oa.name}`, kind: 'diff', order: 'present', campaign: 'missing' });
      for (const ob of unmatchedB) out.push({ field: `option:${ob.name}`, kind: 'diff', order: 'missing', campaign: 'present' });
    }
  }
  return out;
}

module.exports = { projectOrderToCampaign, readCampaignShared, compareOrderCampaign, optionShape: _optionShape, SCALAR_KEYS, OPTION_KEYS };
