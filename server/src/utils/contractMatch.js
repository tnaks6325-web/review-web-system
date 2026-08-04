'use strict';
/**
 * 작업명 ↔ 인트라넷 계약(sales) 유사도 판정 — ★★ 단일 출처(순수함수).
 *
 * 왜 필요한가: 리뷰웹시스템[3버전] 작업보드의 정산은 "계약 연결"(전체 계약을 자유검색해 아무거나 고름)
 *   이었다. 그래서 ① 타 업체 계약을 남의 탭에 붙이는 오링크가 구조적으로 가능했고 ② 담당자가 매번
 *   C-번호를 찾아 입력해야 했다. → "계약 **매칭**" = 그 작업을 소유한 업체(광고주DB)의 계약 중에서 고르고,
 *   작업명과 가장 닮은 계약을 **추천**한다.
 *
 * 예) 작업명 `7/21파미고_올레샷_블로그 바이럴`
 *      7/21 = 진행일 · 파미고 = 업체(sales.business_name) · 올레샷 = 브랜드/상품(brand_product)
 *      블로그 바이럴 = 작업 내용(contract_detail·product_name)
 *   → 네 조각을 각각 대조해 점수를 낸다.
 *
 * ★★ 추천은 제안까지만, 확정은 사람이 누른다(자동 링크 금지) — 옵션 칸 자동점검·작업표 학습과 같은 규율.
 *    계약을 잘못 붙이면 그 업체 정산(견적·계산서·입금)이 통째로 다른 계약을 가리킨다.
 * ★ 판정 실패·근거 부족은 낮은 점수 = 추천 없음(빈 추천이 틀린 추천보다 낫다).
 * ★ 순수함수 — DB·네트워크·Date.now() 미접근(결정적). 소비처(서비스·테스트)가 같은 결과를 본다.
 */

// 추천 최소 점수. 이 아래면 "추천 없음"으로 두고 사람이 직접 고른다.
const RECOMMEND_MIN_SCORE = 45;
// 근거 문장(reasons)에 올릴 최소 유사도 — 애매한 일치를 근거로 내세우면 오판을 부추긴다.
const REASON_MIN = 0.6;

// 법인격 표기는 업체명 비교에서 잡음이다(‘주식회사 파미고’ ↔ ‘파미고’).
const _CORP_WORDS = /(주식회사|유한책임회사|유한회사|합자회사|합명회사|재단법인|사단법인|\(주\)|\(유\)|㈜|㈜)/g;

/** 비교용 정규화: 법인격 제거 → 소문자 → 공백·기호 제거(한글/영문/숫자만 남김). */
function normalizeKey(s) {
  return String(s == null ? '' : s)
    .replace(_CORP_WORDS, ' ')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, '');
}

function _bigrams(s) {
  const out = new Set();
  if (s.length === 1) { out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function _dice(a, b) {
  const A = _bigrams(a), B = _bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 두 문자열 유사도 0..1. 포함관계(‘올레샷’ ⊂ ‘올레샷 유산균’)를 바이그램보다 우선한다 —
 * 계약은 상품명을 길게 적고 작업명은 짧게 줄여 쓰므로 포함이 가장 흔한 정답 형태다.
 * ★ 1글자 포함은 보지 않는다(‘샷’ 하나로 남의 계약이 걸린다).
 */
function similarity(a, b) {
  const A = normalizeKey(a), B = normalizeKey(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length >= 2 && B.includes(A)) return 0.95;
  if (B.length >= 2 && A.includes(B)) return 0.95;
  return _dice(A, B);
}

// 작업명 앞머리의 날짜 표기. `7/21` · `7.21` · `7-21` · `26.7.21` · `2026/07/21` 를 흡수한다.
const _LEAD_DATE = /^\s*(?:(\d{4}|\d{2})\s*[.\-/]\s*)?(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.)\-_]?\s*/;

/**
 * 작업명 분해 → { year, month, day, rest, tokens }.
 *   rest   = 날짜를 걷어낸 나머지(‘파미고_올레샷_블로그 바이럴’)
 *   tokens = 구분자로 쪼갠 조각들. 순수 숫자 토큰은 버린다(건수·날짜 잔재가 계약 금액/번호에 붙는 오탐 방지).
 */
function parseTabName(tabName) {
  const raw = String(tabName == null ? '' : tabName).trim();
  let year = null, month = null, day = null, rest = raw;
  const m = raw.match(_LEAD_DATE);
  if (m) {
    const mo = parseInt(m[2], 10), dy = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
      month = mo; day = dy; rest = raw.slice(m[0].length);
      if (m[1]) { const y = parseInt(m[1], 10); year = m[1].length === 2 ? 2000 + y : y; }
    }
  }
  const tokens = rest
    .split(/[_\s/,·|+()[\]{}<>~"'`]+/)
    .map(t => t.replace(/^[-–—]+|[-–—]+$/g, '').trim())
    .filter(t => t && normalizeKey(t).length >= 2 && !/^\d+$/.test(normalizeKey(t)));
  return { year, month, day, rest: rest.trim(), tokens };
}

/** 계약 행에서 업체명으로 쓸 수 있는 값들(신형 business_name 우선, 레거시 advertiser_name 폴백). */
function contractAdvertiserNames(sale) {
  return [sale && sale.businessName, sale && sale.advertiserName]
    .map(v => String(v || '').trim()).filter(Boolean);
}

// 계약이 가리키는 '월' 후보(YYYY-MM · YYYY-MM-DD · YYYYMMDD 모두 허용).
function _contractMonths(sale) {
  const out = [];
  for (const v of [sale && sale.contractMonth, sale && sale.registrationDate, sale && sale.attributionMonth]) {
    const s = String(v || '').trim();
    if (!s) continue;
    let mm = null;
    let g = s.match(/^(\d{4})[.\-/]?(\d{1,2})/);
    if (g) mm = parseInt(g[2], 10);
    else { g = s.match(/^(\d{1,2})\s*월/); if (g) mm = parseInt(g[1], 10); }
    if (mm >= 1 && mm <= 12) out.push(mm);
  }
  return out;
}

/**
 * 작업명 ↔ 계약 1건 점수(0..100) + 사람이 읽는 근거.
 *
 * 가중치는 **적용 가능한 항목만으로 정규화**한다 — 계약에 브랜드가 안 적혀 있다고 점수를 깎으면
 * 정보가 부실한 계약이 영영 추천되지 않는다(있는 정보로만 판단).
 */
function scoreContract(tabName, sale, opts = {}) {
  const p = opts.parsed || parseTabName(tabName);
  const s = sale || {};
  const reasons = [];
  const parts = [];

  // ① 업체명 — 가장 강한 신호(작업명 앞머리가 대개 업체명이다).
  const advNames = contractAdvertiserNames(s);
  if (advNames.length) {
    let best = 0, hitTok = '';
    for (const nm of advNames) {
      for (const t of p.tokens) { const v = similarity(t, nm); if (v > best) { best = v; hitTok = t; } }
      const whole = similarity(p.rest, nm); if (whole > best) { best = whole; hitTok = nm; }
    }
    parts.push({ key: 'advertiser', w: 40, val: best });
    if (best >= REASON_MIN) reasons.push(`업체명 '${hitTok || advNames[0]}' 일치`);
  }

  // ② 브랜드·상품(brand_product) — 계약등록 폼의 필수 항목이라 실제로 채워져 있다.
  const brand = String(s.brandProduct || '').trim();
  if (brand) {
    let best = similarity(p.rest, brand), hitTok = '';
    for (const t of p.tokens) { const v = similarity(t, brand); if (v > best) { best = v; hitTok = t; } }
    parts.push({ key: 'brand', w: 30, val: best });
    if (best >= REASON_MIN) reasons.push(`브랜드·상품 '${hitTok || brand}' 일치`);
  }

  // ③ 작업 내용(contract_detail·product_name) — ‘블로그 바이럴’ 같은 진행 형태.
  //    토큰 커버리지로 본다(여러 낱말이 흩어져 적히므로 최고값 하나로는 약하다).
  const workText = [s.contractDetail, s.productName].map(v => String(v || '').trim()).filter(Boolean).join(' ');
  if (workText && p.tokens.length) {
    let hit = 0; const hits = [];
    for (const t of p.tokens) if (similarity(t, workText) >= REASON_MIN) { hit++; hits.push(t); }
    const cov = hit / p.tokens.length;
    parts.push({ key: 'work', w: 20, val: cov });
    if (hits.length) reasons.push(`작업 '${hits.join(' ')}' 일치`);
  }

  // ④ 진행월 — 작업명 앞머리 날짜 ↔ 계약월. 같은 달=1, 앞뒤 달=0.5(월말·월초 걸침).
  const months = _contractMonths(s);
  if (p.month != null && months.length) {
    let best = 0;
    for (const mm of months) {
      if (mm === p.month) { best = Math.max(best, 1); continue; }
      const diff = Math.min(Math.abs(mm - p.month), 12 - Math.abs(mm - p.month));
      if (diff === 1) best = Math.max(best, 0.5);
    }
    parts.push({ key: 'date', w: 10, val: best });
    if (best === 1) reasons.push(`계약월 ${p.month}월 일치`);
  }

  const wSum = parts.reduce((a, x) => a + x.w, 0);
  const score = wSum ? Math.round((parts.reduce((a, x) => a + x.w * x.val, 0) / wSum) * 100) : 0;
  const detail = {};
  for (const x of parts) detail[x.key] = Math.round(x.val * 100);
  return { score, reasons, detail };
}

/**
 * 계약 목록을 작업명 유사도순으로 정렬하고 추천 1건을 고른다.
 *   - 정렬은 결정적(점수 → 계약번호) — 같은 입력에 같은 순서.
 *   - 추천은 `min`(기본 45) 이상일 때만. 미달이면 recommendedSalesId=null(추천 없음).
 *   - 최고점 동점이 있으면 `tie` 로 알린다(어느 쪽인지 정할 수 없다는 사실을 숨기지 않는다).
 */
function rankContracts(tabName, sales, opts = {}) {
  const min = opts.min == null ? RECOMMEND_MIN_SCORE : opts.min;
  const parsed = parseTabName(tabName);
  const items = (sales || []).map((s) => {
    const m = scoreContract(tabName, s, { parsed });
    return Object.assign({}, s, { matchScore: m.score, matchReasons: m.reasons, matchDetail: m.detail });
  });
  items.sort((a, b) => (b.matchScore - a.matchScore)
    || String(a.contractNumber || '').localeCompare(String(b.contractNumber || ''))
    || String(a.salesId || '').localeCompare(String(b.salesId || '')));
  const top = items[0] || null;
  const recommend = !!(top && top.matchScore >= min);
  const tie = !!(recommend && items[1] && items[1].matchScore === top.matchScore);
  if (recommend) items[0].recommended = true;
  return { items, parsed, tie, recommendedSalesId: recommend ? (top.salesId || null) : null };
}

module.exports = {
  RECOMMEND_MIN_SCORE,
  normalizeKey,
  similarity,
  parseTabName,
  contractAdvertiserNames,
  scoreContract,
  rankContracts,
};
