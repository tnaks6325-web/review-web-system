/**
 * reviewTypeContext.service.js — "이 탭의 리뷰타입은 무엇인가"를 DB에서 한 번만 읽는다.
 *
 * 캡처 슬롯 파생(`utils/captureSlots`)과 AI 기대 종류(`captureVerify._expectedKind`)는
 * **소비처가 4곳**(리뷰어 화면 슬롯 · 제출 완료 판정 · 업로드 폴더 라벨 · 교체요청 라벨)이라,
 * 각자 SQL 을 쓰면 넷이 조용히 갈라진다("슬롯은 2개인데 1장에 완료"의 원인).
 * 그래서 조회를 여기 하나로 모은다.
 *
 * ★ 판정 자체는 하지 않는다 — 값만 읽어 `utils/reviewType.resolveReviewType` 에 넘긴다.
 *   규칙의 단일 출처는 끝까지 그 파일이다.
 * ★ 행 단위 값(시트 작업옵션 칸)은 여기서 모른다 → 공고 > 탭 까지만 본다.
 *   혼합 탭은 그래서 null 로 떨어지고, **null = 오늘 동작 그대로**다(혼합건을 임의로
 *   리뷰형으로 접지 않는다 — 구매확정 행이 리뷰로 잘못 검수되는 것을 막는 규율).
 * ★ fail-soft: 조회 실패는 null. 리뷰타입을 몰라서 제출이 막히는 일은 없어야 한다.
 */
const { logger } = require('../utils/logger');
const { resolveReviewType, normalizeReviewType, isFreeChoiceReviewType } = require('../utils/reviewType');

/**
 * ★★ 공고 리뷰타입을 찾는 **SQL 단일 출처**. 세 소비처(단건 조회 · 배치 조회 ·
 *   `reviewInspect.loadTabExpectations`)가 이 문자열 하나를 끼워 쓴다 — 사본을 두면
 *   "공고에 구매확정을 저장했는데 검수는 못 본다"가 화면마다 다르게 난다.
 *
 * 두 가지를 **일부러** 이렇게 한다:
 *   ① **gid 폴백** — 탭을 리네임하면 이름 매칭만으로는 공고를 못 찾아 설정이 조용히 풀린다
 *      (레포 규율 = "gid 우선 재매칭"). ★ **빈 gid 는 키를 만들지 않는다**(만들면 gid 없는
 *      공고가 전부 매칭된다).
 *   ② **값이 있는 최신 공고** — 한 탭에 공고가 여러 개(차수 재발행)일 때, 최신 공고가
 *      리뷰타입 **미지정**이면 종전에는 그 NULL 이 옛 공고의 '구매확정'을 가려 판정이
 *      탭 값으로 내려갔다. '미지정'은 관리자가 **정하지 않은 것**이므로 가리지 않는다.
 *      (최신이 '포토'처럼 **명시**돼 있으면 값이 있으므로 최신이 그대로 이긴다.)
 *      완화 방향이라 안전 — 반대(구매확정 작업을 리뷰로 보는 것)가 이번 사고였다.
 */
const { campaignColLateral } = require('../utils/campaignTabLateral');

// ★★ 조각 자체는 utils/campaignTabLateral 이 소유한다 — 같은 규칙(gid 폴백 · 값이 있는 최신
//   공고)을 체험단 종류(099)도 써야 해서, 사본을 두면 "리뷰타입은 찾는데 종류는 못 찾는" 탭이 생긴다.
const CAMPAIGN_REVIEW_TYPE_LATERAL = campaignColLateral('review_type', 'rt');

let _pool;
function _db() {
  if (!_pool) _pool = require('../db/pool');
  return _pool;
}
function __setPoolForTest(p) { _pool = p || null; _cache.clear(); }

// 탭당 60초 캐시 — 업로드·제출 핫패스에서 같은 탭을 연달아 물으므로 왕복을 상각한다.
const TTL = Number(process.env.REVIEW_TYPE_CACHE_MS || 60 * 1000);
const _cache = new Map();   // `${sheetId}${tabName}` → { v, ts }

/**
 * @param {object} p
 * @param {string} p.sheetId
 * @param {string} p.tabName
 * @param {object} [p.client]  트랜잭션 안에서 부를 때의 잠금 커넥션(없으면 풀)
 * @returns {Promise<string|null>} utils/reviewType 표준 key 또는 null(미지정·판정 실패)
 */
async function reviewTypeForTab({ sheetId, tabName, client } = {}) {
  if (!sheetId || !tabName) return null;
  const key = `${sheetId}${tabName}`;
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < TTL) return hit.v;

  let v = null;
  try {
    // ★ 채널 대조(loadTabExpectations)와 **같은 LATERAL 최신 1행** 방식 — 같은 탭에 공고가
    //   여러 개일 때 서로 다른 공고 값을 보면 화면마다 판정이 갈린다.
    const q = (client || _db()).query.bind(client || _db());
    const { rows } = await q(
      `SELECT c.review_type AS tab_review_type, rt.review_type AS camp_review_type
         FROM tab_configs c${CAMPAIGN_REVIEW_TYPE_LATERAL}
        WHERE c.sheet_id = $1 AND c.tab_name = $2
        LIMIT 1`,
      [sheetId, tabName]
    );
    const r = rows[0];
    if (r) {
      v = resolveReviewType({ campaignType: r.camp_review_type, tabReviewType: r.tab_review_type });
    }
  } catch (e) {
    logger.warn(`[reviewType] 탭 리뷰타입 조회 실패(미적용): ${e.message}`);
    return null;   // ★ 캐시에 넣지 않는다 — 일시 장애를 60초 동안 굳히지 않기 위해
  }
  _cache.set(key, { v, ts: Date.now() });
  return v;
}

/** 여러 탭을 한 번에(리뷰어 검색처럼 행이 여러 탭에 걸칠 때). 실패는 빈 맵. */
async function reviewTypesForTabs(pairs) {
  const out = new Map();
  const uniq = [];
  for (const p of pairs || []) {
    if (!p || !p.sheetId || !p.tabName) continue;
    const k = `${p.sheetId}${p.tabName}`;
    if (!out.has(k)) { out.set(k, null); uniq.push(p); }
  }
  for (const p of uniq) {
    out.set(`${p.sheetId}${p.tabName}`, await reviewTypeForTab(p));
  }
  return out;
}

/**
 * 관리자 화면용 — 판정 결과 **+ 그렇게 판정된 근거값**을 함께 돌려준다.
 *
 * ★★ 왜 필요한가(실사고 2026-08-06): 구매확정 작업인데 리뷰검수가 "리뷰 화면이 아님" 불량을
 *   냈다. 원인은 `tab_configs.review_type` 에 **배송유형('실배송')** 이 들어 있어 리뷰타입
 *   판정이 null(= 리뷰형 기본)이 되고 공고에도 리뷰타입이 없던 것 — 그런데 **화면 어디에도
 *   그 사실이 안 보여** 담당자가 원인을 알 길이 없었다. 그래서 판정과 원본 값을 함께 내보낸다.
 * ★ 여기서도 판정은 하지 않는다 — `resolveReviewType` 한 곳에 맡긴다.
 * ★ 읽기 전용·fail-soft(실패 = 빈 배열). 목록 조회를 죽이지 않는다.
 * ★ N+1 금지 — 여러 탭을 한 쿼리로 본다(목록은 탭이 여러 개 섞인다).
 *
 * @returns {Promise<Array<{sheetId,tabName,type,mixed,free,tabRaw,campRaw}>>}
 */
async function reviewTypeDetailsForTabs(pairs) {
  const uniq = [];
  const seen = new Set();
  for (const p of pairs || []) {
    if (!p || !p.sheetId || !p.tabName) continue;
    const k = `${p.sheetId}${p.tabName}`;
    if (seen.has(k)) continue;
    seen.add(k); uniq.push(p);
  }
  if (!uniq.length) return [];
  try {
    // ★ 위 단건 조회와 **같은 LATERAL 최신 1행** 모양 — 모양이 갈리면 화면과 검수가 다른 공고를 본다.
    const { rows } = await _db().query(
      `SELECT c.sheet_id, c.tab_name, c.review_type AS tab_review_type, rt.review_type AS camp_review_type
         FROM tab_configs c${CAMPAIGN_REVIEW_TYPE_LATERAL}
        WHERE (c.sheet_id, c.tab_name) IN (
              SELECT s, t FROM UNNEST($1::text[], $2::text[]) AS u(s, t))`,
      [uniq.map(p => p.sheetId), uniq.map(p => p.tabName)]
    );
    return rows.map(r => {
      const type = resolveReviewType({ campaignType: r.camp_review_type, tabReviewType: r.tab_review_type });
      /* ★★ 혼합은 판정(type)이 **일부러 null** 이지만 "미지정"이 아니다(2026-08-23) — 화면이 그
         null 을 그대로 "리뷰타입 미지정"으로 말하면, 혼합으로 설정해 둔 담당자에게 거짓이 된다.
         ★ 화면에 판정 사본을 만들지 않도록 **여기서** normalizeReviewType 을 태워 알려준다. */
      const mixed = !type && (normalizeReviewType(r.camp_review_type) === 'mixed'
                           || normalizeReviewType(r.tab_review_type) === 'mixed');
      /* ★ `자율리뷰`도 "미지정"이 아니다 — 적어 둔 값이다(혼합과 같은 자리 · 서로 배타). */
      const free = !type && !mixed && (isFreeChoiceReviewType(r.camp_review_type)
                                    || isFreeChoiceReviewType(r.tab_review_type));
      return {
        sheetId: r.sheet_id, tabName: r.tab_name, type, mixed, free,
        tabRaw: r.tab_review_type || '', campRaw: r.camp_review_type || '',
      };
    });
  } catch (e) {
    logger.warn(`[reviewType] 탭 리뷰타입 상세 조회 실패(표시 생략): ${e.message}`);
    return [];
  }
}

/**
 * 이 **행**의 리뷰타입(작업옵션 칸 값) — `resolveReviewType` ① 행 우선의 재료.
 *
 * ★★ 혼합 오더(포토 10 + 구매확정 20)에서 "어느 행이 무슨 유형인지"는 행에만 적혀 있다
 *   (작업표 생성이 `리뷰옵션` 칸에 배분해 두는 값 · 시트 시절엔 직원이 손으로 적던 값).
 *   탭·공고 값은 mixed 라 null 로 떨어지므로, 이 값을 읽지 않으면 구매확정 행의 정상
 *   제출이 "리뷰 화면이 아님" 불량이 된다.
 * ★ 읽을 칸은 전용 `리뷰옵션` 헤더 + `orderLedger.optionWriteColumns`(상품 옵션 매퍼 파생)이다.
 *   여기서 '옵션' 키워드 표를 다시 만들면 `옵션금액`(결제금액)을 오분류한다. 값 판정은
 *   `utils/reviewType.rowOptionReviewType`(리뷰옵션 칸 우선) 단일 출처.
 * ★ fail-soft: 조회 실패·행 없음·값 없음 = null(= 탭/공고 판정 그대로 = 오늘 동작).
 *   캐시는 두지 않는다 — 행 단위 PK 조회 1회이고, 값이 재배분으로 바뀔 수 있다.
 */
async function reviewTypeForRow({ sheetId, tabName, rowIndex, client, strict = false } = {}) {
  const idx = parseInt(rowIndex, 10);
  if (!sheetId || !tabName || !Number.isInteger(idx) || idx <= 0) return null;
  try {
    const q = (client || _db()).query.bind(client || _db());
    const { rows } = await q(
      `SELECT row_json FROM review_index
        WHERE sheet_id = $1 AND tab_name = $2 AND row_index = $3
        LIMIT 1`,
      [sheetId, tabName, idx]
    );
    const rj = rows[0] && rows[0].row_json;
    if (!rj || typeof rj !== 'object') return null;
    const { optionWriteColumns } = require('./orderLedger.service');
    const { rowOptionReviewType, isReviewOptionHeader } = require('../utils/reviewType');
    const headers = Object.keys(rj);
    const optionHeaders = headers.filter(isReviewOptionHeader)
      .concat(optionWriteColumns(headers).map(i => headers[i]));
    return rowOptionReviewType(rj, [...new Set(optionHeaders)]);
  } catch (e) {
    logger.warn(`[reviewType] 행 리뷰타입 조회 실패(미적용): ${e.message}`);
    // 제출 입구는 종전처럼 허용하고, 후검수만 실패 사실을 별도로 기록한다.
    if (strict) throw e;
    return null;
  }
}

module.exports = {
  reviewTypeForTab, reviewTypesForTabs, reviewTypeDetailsForTabs, reviewTypeForRow,
  CAMPAIGN_REVIEW_TYPE_LATERAL, __setPoolForTest,
};
