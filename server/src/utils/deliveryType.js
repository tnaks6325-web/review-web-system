/**
 * 배송유형 판정 단일 출처.
 *
 * ★★ 어휘는 5종이다 — 실배송 · 빈박스 · 택배발송대행 · 회수 · 혼합.
 *
 * ★★★ 회수·혼합은 "값"이 아니라 **값 + 부속정보**로 온다. 인트라넷 리뷰오더가 배송유형을
 *   `delivery_type` **한 칸에 문장으로 접어** 보내기 때문이다(inadd-webapp
 *   `reviewOrderDeliverySummary`):
 *
 *     회수(회수택배사: CJ대한통운, 회수상품명칭: OO선크림 30ml)
 *     혼합(실배송 20건, 빈박스 80건)
 *
 *   리뷰웹의 판정은 전부 **정확일치**(맵 조회·앵커 정규식·select value)라 문장이 오면
 *   통째로 빗나간다 — 그래서 회수·혼합 오더가 접수는 되면서 작업표 열도 안 켜지고
 *   모집공고 프리필에서 값이 통째로 사라졌다(2026-08-24 조사).
 *
 * ★★ 그래서 **저장은 원문 그대로, 판정만 기본형(base)으로** 접는다.
 *   ① 마이그레이션·데이터 변환 0 ② **이미 저장된 과거 오더에도 소급 적용**
 *   ③ 인트라넷 배포를 기다리지 않아도 즉시 동작(양방향 가산적 = 배포 순서 무관).
 *
 * ★★ 이 목록을 `utils/reviewType.LEGACY_DELIVERY_VALUES` 와 **합치지 말 것**.
 *   그 배열은 어휘 목록이 아니라 **"리뷰타입 칸에 잘못 들어간 배송유형 판별 목록"**이고
 *   (`order.routes` 접수 업서트 `$12`), `혼합` 은 **정상 리뷰타입 값**이다
 *   (`normalizeReviewType('혼합') → 'mixed'`). 합치면 접수 업서트가 멀쩡한 혼합 리뷰 탭을
 *   "오염"으로 보고 **리뷰타입을 갈아치우고 `delivery_type` 으로 이관**한다
 *   (2026-08-06 이노크아든 사고의 거울상).
 */

/** 배송유형 어휘 — 화면 선택지·판정의 단일 출처. */
const DELIVERY_TYPES = ['실배송', '빈박스', '택배발송대행', '회수', '혼합'];

/**
 * 기본형 판정 규칙.
 * ★ **읽을 때 접는다** — 옛 표기(`빈택배`·`회수건`·`믹스`)도 표준 기본형으로 읽되
 *   저장된 값 자체는 건드리지 않는다(정리는 별도 창구가 사람 확인을 거쳐 한다).
 * ★ 순서가 결과를 바꾸지 않도록 전부 **앵커 정확일치**로 둔다 — 부분일치로 넓히면
 *   `옵션금액`·`비고(배송확인)` 같은 이웃 값이 걸린다(옵션 칸 오분류와 같은 함정).
 */
const _BASE_RULES = [
  { base: '택배발송대행', re: /^택배\s*발송\s*대행$/ },
  { base: '실배송',       re: /^실\s*배송$/ },
  { base: '빈박스',       re: /^빈\s*(?:택배|박스)$/ },
  { base: '회수',         re: /^회수\s*건?$/ },
  { base: '혼합',         re: /^(?:혼합|믹스|mix(?:ed)?)$/i },
];

const _str = (v) => String(v == null ? '' : v).trim();

/** 문장에서 부속정보를 떼어낸 앞머리 토큰. `회수(회수택배사: X)` → `회수` */
function _headToken(raw) {
  const s = _str(raw);
  const cut = s.indexOf('(');
  return (cut >= 0 ? s.slice(0, cut) : s).trim();
}

/**
 * 기본형만 돌려준다 — 판정·표시 라벨·화면 선택지가 전부 이 값을 본다.
 * @returns {string} DELIVERY_TYPES 중 하나, 판정 불가면 `''`(추측하지 않는다 — 틀린 값보다 빈 값).
 */
function deliveryBaseType(raw) {
  const head = _headToken(raw);
  if (!head) return '';
  const hit = _BASE_RULES.find((r) => r.re.test(head));
  return hit ? hit.base : '';
}

/** 부속정보가 담긴 괄호 안쪽. 없으면 `''`. */
function _detailPart(raw) {
  const s = _str(raw);
  const open = s.indexOf('(');
  if (open < 0) return '';
  const close = s.lastIndexOf(')');
  return (close > open ? s.slice(open + 1, close) : s.slice(open + 1)).trim();
}

/** `회수(회수택배사: A, 회수상품명칭: B)` → {courier,product}. 못 읽은 칸은 `''`. */
function _parseRecall(detail) {
  if (!detail) return null;
  const pick = (re) => {
    const m = detail.match(re);
    return m ? m[1].trim() : '';
  };
  const courier = pick(/회수\s*택배사\s*[:：]\s*([^,)]+)/);
  const product = pick(/회수\s*상품\s*명칭\s*[:：]\s*([^,)]+)/);
  return (courier || product) ? { courier, product } : null;
}

/** `혼합(실배송 20건, 빈박스 80건)` → {real,empty}. 한 칸도 못 읽으면 null(모른다). */
function _parseMix(detail) {
  if (!detail) return null;
  const num = (re) => {
    const m = detail.match(re);
    return m ? Math.max(0, parseInt(m[1], 10) || 0) : null;
  };
  const real = num(/실\s*배송\s*([0-9]+)\s*건/);
  const empty = num(/빈\s*(?:박스|택배)\s*([0-9]+)\s*건/);
  if (real === null && empty === null) return null;
  return { real: real || 0, empty: empty || 0 };
}

/**
 * 배송유형 문자열 → { base, raw, recall, mix }.
 *
 * ★ `raw` 는 원문 그대로다(작업오더 상세는 원문을 보여줘야 한다 — 담당자가 대조하는 값).
 * ★ `recall`·`mix` 는 **문장에서 읽어낸 폴백**이다. 구조화 필드(135 컬럼)가 있으면
 *   그쪽이 이긴다 — 호출부가 `?? ` 로 접는다(문장 파싱은 과거 오더 구제용).
 */
function parseDeliveryType(raw) {
  const base = deliveryBaseType(raw);
  const detail = _detailPart(raw);
  return {
    base,
    raw: _str(raw),
    recall: base === '회수' ? _parseRecall(detail) : null,
    mix: base === '혼합' ? _parseMix(detail) : null,
  };
}

const isRecallDelivery = (raw) => deliveryBaseType(raw) === '회수';
const isMixedDelivery = (raw) => deliveryBaseType(raw) === '혼합';
const isCourierProxyDelivery = (raw) => deliveryBaseType(raw) === '택배발송대행';

/**
 * 저장할 값을 정한다.
 * ★ **부속정보가 붙어 있으면 원문을 그대로 둔다** — 정규화한답시고 기본형만 남기면
 *   회수택배사·혼합 건수가 그 자리에서 증발한다(구조화 컬럼이 아직 안 채워진 과거·구버전 경로).
 * ★ 부속 없는 맨 토큰만 표준 기본형으로 접는다(`빈택배`→`빈박스`·`회수건`→`회수`).
 * ★ 판정 불가값은 **원문 그대로 통과**(종전 계약 — 모르는 값을 지우지 않는다).
 */
function canonicalDeliveryValue(raw) {
  const s = _str(raw);
  if (!s) return s;
  if (_detailPart(s)) return s;          // 부속정보 보존
  return deliveryBaseType(s) || s;
}

/** 화면 배지·요약에 쓸 짧은 라벨 = 기본형. 판정 불가면 원문(정보를 지우지 않는다). */
function deliveryLabel(raw) {
  return deliveryBaseType(raw) || _str(raw);
}

module.exports = {
  DELIVERY_TYPES,
  deliveryBaseType, parseDeliveryType, canonicalDeliveryValue, deliveryLabel,
  isRecallDelivery, isMixedDelivery, isCourierProxyDelivery,
};
