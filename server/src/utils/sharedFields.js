/**
 * sharedFields — 리뷰오더(인트라넷) ↔ 작업오더·모집공고(리뷰웹) 양방향 동기화의 **칸 목록 단일 출처**(결정 275).
 *
 * ★★ 이 표 하나가 정한다:
 *    ① 어떤 칸이 동기화 대상인가(목록에 없으면 동기화하지 않는다)
 *    ② 그 칸의 주인 — `intranet`(인트라넷만 고친다 · 리뷰웹은 보기 전용) / `shared`(양쪽 다 고친다)
 *    ③ 두 값이 "같은가" 를 판정하는 정규화(`canon`) — 같은 뜻을 다르게 적은 것(거짓 vs 0, 빈 값 vs 기본값)을
 *       차이로 세지 않는다. 2026-10-20 운영 대조에서 걸러낸 표기 차이가 전부 여기 규칙으로 들어 있다.
 * ★★ 정규화는 **판정 전용**이다 — 저장값을 바꾸는 데 쓰지 않는다(저장 정규화는 각 저장 경로의 몫).
 * ★ 판정 규칙은 기존 단일 출처를 태운다(사본 금지): 리뷰타입 `reviewType` · 배송유형 `deliveryType` ·
 *   혼합 조합 `reviewTypeMix`/`deliveryTypeMix` · 구매시간 `purchaseTimeWindow` · 체험단 종류 `workKind`.
 */
'use strict';

const { normalizeReviewType, isFreeChoiceReviewType } = require('./reviewType');
const { canonicalDeliveryValue } = require('./deliveryType');
const { normalizeReviewTypeMix } = require('./reviewTypeMix');
const { normalizeDeliveryTypeMix } = require('./deliveryTypeMix');
const { parsePurchaseTime } = require('./purchaseTimeWindow');
const { workKindForStore } = require('./workKind');

const _str = (v) => (v == null ? '' : String(v));
const _text = (v) => _str(v).replace(/\r\n?/g, '\n').trim();

/** 키 순서와 무관한 JSON 문자열(배열 순서는 의미가 있어 그대로 둔다). */
function stableJson(v) {
  if (v === undefined) return '';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

function _parseJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

const CANON = {
  text: (v) => _text(v),
  /** 정수 칸 — 빈 값과 0 은 **다르다**(0명·0원은 값이다). 숫자 아닌 글자는 원문 그대로(모르는 값을 0 으로 꾸미지 않는다). */
  int: (v) => {
    const s = _text(v);
    if (!s) return '';
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? String(Math.trunc(n)) : s;
  },
  /** 예/아니오 — 인트라넷은 true/false, 리뷰웹은 boolean·'true'·1 이 섞여 온다. 빈 값 = `unset`(정하지 않음). */
  bool: (v) => {
    if (v === true || v === 1) return '1';
    if (v === false || v === 0) return '0';
    const s = _text(v).toLowerCase();
    if (!s) return 'unset';
    if (/^(true|t|y|yes|1|예)$/.test(s)) return '1';
    if (/^(false|f|n|no|0|아니오)$/.test(s)) return '0';
    return s;
  },
  date: (v) => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    const s = _text(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  },
  /** JSON 칸 — 키 순서 무시, 빈 배열·빈 객체·null = 빈 값. 깨진 JSON 은 원문 글자로 비교. */
  json: (v) => {
    const p = _parseJson(v);
    if (p == null) return '';
    if (typeof p === 'string') return _text(p);
    if (Array.isArray(p) && !p.length) return '';
    if (!Array.isArray(p) && typeof p === 'object' && !Object.keys(p).length) return '';
    return stableJson(p);
  },
  /** 리뷰타입 — 표준 key 로(포토=photo). `자율리뷰` = 지정 안 함 = 빈 값. 판정 불가 원문은 그대로. */
  reviewType: (v) => {
    const s = _text(v);
    if (!s || isFreeChoiceReviewType(s)) return '';
    return normalizeReviewType(s) || s;
  },
  reviewTypeMix: (v) => {
    const st = normalizeReviewTypeMix(_parseJson(v));
    if (st.error) return 'invalid:' + CANON.json(v);
    return (st.mix || []).slice().sort((a, b) => String(a.type).localeCompare(String(b.type)))
      .map(e => `${e.type}:${e.quantity}`).join(',');
  },
  delivery: (v) => canonicalDeliveryValue(_text(v)) || '',
  deliveryMix: (v) => {
    const st = normalizeDeliveryTypeMix(_parseJson(v));
    if (st.error) return 'invalid:' + CANON.json(v);
    return (st.mix || []).slice().sort((a, b) => String(a.type).localeCompare(String(b.type)))
      .map(e => `${e.type}:${e.quantity}`).join(',');
  },
  /** 구매시간대 — 해석되면 `HH:MM~HH:MM`, 아니면 공백을 접은 원문("자유시간대" 등). */
  time: (v) => {
    const s = _text(v);
    const w = parsePurchaseTime(s);
    return w ? `${w.start}~${w.end}` : s.replace(/\s+/g, ' ');
  },
  /** 투입방식 — 접수 저장 규칙(`order.routes` `_productDistributionMode`)과 같다: sequential 이 아니면 balanced. */
  distribution: (v) => (_text(v).toLowerCase() === 'sequential' ? 'sequential' : 'balanced'),
  /** 체험단 종류 — 빈 값 = 리뷰(기존 동작). 저장 규칙 `workKindForStore` 를 태운다. */
  workKind: (v) => workKindForStore(v) || 'review',
};

/**
 * 동기화 칸 표. key = 작업오더 칸 이름 = 인트라넷 payload 키(접수 계약상 같은 이름).
 * ★ 인트라넷 고유 칸은 "리뷰웹에서 보기 전용" — 결정 275 · 사용자 확정 2026-10-19(D5) · 블루 설계 「칸 주인」.
 * ★ `product_options_json` 은 통째 비교하지 않는다 — 상품·옵션 단위로 펼쳐 비교한다(`sharedPatchPlan.flattenState`).
 * ★ `pay_amount` 는 옵션 금액·인원에서 파생되는 합계라 `derived` — 직접 고치는 칸이 아니라 비교만 한다.
 */
const SHARED_FIELDS = Object.freeze([
  // ── 인트라넷 고유(리뷰웹 보기 전용) ──
  { key: 'title',            owner: 'intranet', canon: 'text',     label: '작업명' },
  { key: 'start_date',       owner: 'intranet', canon: 'date',     label: '희망 시작일' },   // 결정 279 — 리뷰오더 값은 희망 시작일(공고 실제 시작일과 따로 돈다)
  { key: 'manager_name',     owner: 'intranet', canon: 'text',     label: '담당AE' },
  { key: 'work_manager',     owner: 'intranet', canon: 'text',     label: '작업담당' },
  { key: 'sales_id',         owner: 'intranet', canon: 'text',     label: '계약건' },
  { key: 'quote_id',         owner: 'intranet', canon: 'text',     label: '견적' },
  { key: 'contract_number',  owner: 'intranet', canon: 'text',     label: '계약번호' },
  { key: 'intranet_advertiser_id', owner: 'intranet', canon: 'text', label: '광고주' },
  { key: 'goods_cost_type',  owner: 'intranet', canon: 'text',     label: '물건비 지급' },
  { key: 'holidays',         owner: 'intranet', canon: 'json',     label: '휴무일' },
  { key: 'inflow_keyword',   owner: 'intranet', canon: 'text',     label: '유입 검색어' },
  // ── 공유(양쪽에서 고친다) ──
  { key: 'work_kind',        owner: 'shared',   canon: 'workKind', label: '체험단 종류' },
  { key: 'inflow_type',      owner: 'shared',   canon: 'text',     label: '유입방식' },
  { key: 'review_type',      owner: 'shared',   canon: 'reviewType', label: '리뷰타입' },
  { key: 'review_type_mix',  owner: 'shared',   canon: 'reviewTypeMix', label: '리뷰타입 혼합' },
  { key: 'product_distribution_mode', owner: 'shared', canon: 'distribution', label: '투입방식' },
  { key: 'product_url',      owner: 'shared',   canon: 'text',     label: '상품 주소' },
  { key: 'thumbnail_url',    owner: 'shared',   canon: 'text',     label: '썸네일' },
  { key: 'purchase_channel', owner: 'shared',   canon: 'text',     label: '구매채널' },
  { key: 'purchase_channel_custom', owner: 'shared', canon: 'bool', label: '구매채널 직접입력' },
  { key: 'delivery_type',    owner: 'shared',   canon: 'delivery', label: '배송유형' },
  { key: 'delivery_type_mix', owner: 'shared',  canon: 'deliveryMix', label: '배송 혼합' },
  { key: 'recall_courier',   owner: 'shared',   canon: 'text',     label: '회수 택배사' },
  { key: 'recall_product',   owner: 'shared',   canon: 'text',     label: '회수 상품명' },
  { key: 'purchase_time',    owner: 'shared',   canon: 'time',     label: '구매 시간대' },
  { key: 'required_delivery_memo', owner: 'shared', canon: 'text', label: '필수 배송메세지' },
  { key: 'skip_weekends',    owner: 'shared',   canon: 'bool',     label: '주말 제외' },
  { key: 'inflow_guide',     owner: 'shared',   canon: 'text',     label: '유입가이드' },
  { key: 'review_guide',     owner: 'shared',   canon: 'text',     label: '리뷰가이드' },
  { key: 'special_notes',    owner: 'shared',   canon: 'text',     label: '특이사항' },
  { key: 'guide_images',     owner: 'shared',   canon: 'json',     label: '가이드 사진' },
  { key: 'recruit_count',    owner: 'shared',   canon: 'int',      label: '총 모집인원' },
  { key: 'daily_count',      owner: 'shared',   canon: 'int',      label: '일 진행 건수' },
  { key: 'review_fee',       owner: 'shared',   canon: 'int',      label: '기본 리뷰비' },
  { key: 'pay_amount',       owner: 'derived',  canon: 'int',      label: '결제금액 합계' },
]);

const FIELD_BY_KEY = new Map(SHARED_FIELDS.map(f => [f.key, f]));

/** 칸 하나를 비교용 글자로. 목록에 없는 칸은 던진다(조용히 원문 비교로 접지 않는다). */
function canon(key, value) {
  const f = FIELD_BY_KEY.get(key);
  if (!f) throw new Error(`동기화 칸 목록에 없는 칸: ${key}`);
  return CANON[f.canon](value);
}

function ownerOf(key) {
  const f = FIELD_BY_KEY.get(key);
  return f ? f.owner : null;
}

module.exports = { SHARED_FIELDS, FIELD_BY_KEY, CANON, canon, ownerOf, stableJson };
