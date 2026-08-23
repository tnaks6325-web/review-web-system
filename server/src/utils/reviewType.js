/**
 * reviewType.js — 리뷰타입 판정의 **단일 출처**.
 *
 * "이 행의 리뷰어는 무엇을 캡처해야 하는가"를 정하는 규칙은 여러 화면이 동시에 알아야 한다:
 *   ① 리뷰어가 그릴 캡처 슬롯  ② 제출 완료 판정  ③ AI 검수가 기대하는 화면 종류
 *   ④ 관리자 공고 모달·탭 설정 표시
 * 화면마다 규칙을 만들면 "공고는 구매확정인데 검수는 리뷰"로 갈라진다(리뷰비 구간표와 같은 규율).
 *
 * ★★ 판정 실패는 전부 null — **null = 오늘 동작 그대로**(리뷰형). opt-in 이라
 *   리뷰타입을 한 번도 지정하지 않은 기존 탭·공고는 이 파일이 있든 없든 동작이 같다.
 *
 * ── 어휘 통일(2026-08, 사용자 확정) ──────────────────────────────────
 * 같은 `review_type` 칸을 두 목록이 나눠 쓰고 있었다.
 *   · 인트라넷 발주 폼 : 포토 · 텍스트 · 구매확정 · 별점 · 혼합   ← 리뷰 결과물의 형태
 *   · 탭 설정 팝오버   : 실배송 · 빈박스 · 구매확정 · 믹스        ← 앞 둘은 사실 '배송유형'
 * 겹치는 값이 `구매확정` 하나뿐이라 이 칸을 판정 근거로 쓰면 인트라넷이 넣은 `포토` 가
 * 탭 설정 화면에서 목록 밖 값이 된다. → **인트라넷 목록으로 통일**하고 이름도 '리뷰타입' 하나로.
 *   · 실배송/빈박스 → 배송유형(`tab_configs.delivery_type`, 이미 있고 접수가 자동으로 채운다)
 *   · 믹스 → 혼합
 * ★ 옛 값이 남은 탭은 **판정에서만 빠지고**(null = 오늘 동작) 화면에는 그대로 표시한다.
 *   목록에 없다고 조용히 지우면 관리자가 무엇이 설정돼 있었는지 알 수 없다.
 */

/** 표준 리뷰타입 — key 는 저장·판정용, label 은 화면·시트에 실제로 쓰이는 한국어. */
const REVIEW_TYPES = [
  { key: 'photo',   label: '포토'     },
  { key: 'text',    label: '텍스트'   },
  { key: 'confirm', label: '구매확정' },
  { key: 'star',    label: '별점'     },
  { key: 'mixed',   label: '혼합'     },
];

const REVIEW_TYPE_KEYS = REVIEW_TYPES.map(t => t.key);
const REVIEW_TYPE_LABELS = REVIEW_TYPES.map(t => t.label);

/**
 * ★★ 시트/작업표 **리뷰옵션 칸에 실제로 적는 표기** — ㉯ 작업옵션(리뷰형태) 관행 그대로
 *   (`텍스트`·`포토리뷰`, 7/31·8/3 사고 문서의 어휘). label(`포토`)과 다른 이유:
 *   시트 시절 직원이 손으로 적어 온 값이 이것이고, `normalizeReviewType` 이 정확히
 *   되읽는다(왕복 보장 — 회귀가드가 고정). 혼합(mixed)은 행에 적는 값이 아니라 제외.
 */
const REVIEW_TYPE_SHEET_LABELS = { photo: '포토리뷰', text: '텍스트', confirm: '구매확정', star: '별점' };

/**
 * 이 헤더가 **리뷰옵션 칸**(행별 리뷰형태 지시 전용)인가.
 * ★ 작업표 생성이 리뷰 종류를 적는 열 = 이 판정을 통과하는 열 하나 — 상품옵션 칸과
 *   구분해야 "상품옵션이 리뷰옵션 칸에, 리뷰형태가 상품옵션 칸에" 섞이지 않는다.
 * ★ 소비처 2곳(worktablePlan/planToSheetValues 의 기입 대상 · orderLedger 행배정 매칭 제외)이
 *   같은 판정을 쓴다 — 사본을 두면 "적는 칸과 매칭에서 빼는 칸"이 갈린다.
 */
function isReviewOptionHeader(name) {
  return /리뷰\s*옵션/.test(String(name == null ? '' : name).trim());
}

/**
 * 이 **행**의 작업옵션 칸 값들에서 리뷰타입을 읽는다(순수함수 — 조회는 호출자가).
 *
 * @param {object} rowJson        review_index.row_json (헤더명→값 맵)
 * @param {string[]} optionHeaders 옵션 기입 칸의 헤더명들(`orderLedger.optionWriteColumns` 파생 —
 *                                 여기서 '옵션' 키워드 표를 다시 만들면 `옵션금액`(결제금액)을 오분류한다)
 * @returns {string|null} 표준 key. 판정 불가 = null(= 오늘 동작 그대로).
 *
 * ★ **리뷰옵션 칸을 먼저** 본다 — 상품옵션 칸 값(예 '포토 카드지갑')이 우연히 리뷰타입
 *   키워드에 걸려 행 판정을 가로채면, 혼합 오더의 구매확정 행이 리뷰로 잘못 검수된다.
 */
function rowOptionReviewType(rowJson, optionHeaders = []) {
  if (!rowJson || typeof rowJson !== 'object') return null;
  const list = (optionHeaders || []).filter(h => h != null);
  const ordered = list.filter(h => isReviewOptionHeader(h)).concat(list.filter(h => !isReviewOptionHeader(h)));
  for (const h of ordered) {
    const t = normalizeReviewType(rowJson[h]);
    if (t && t !== 'mixed') return t;
  }
  return null;
}

/**
 * ★★ `자율리뷰` — **리뷰 형태를 리뷰어가 정한다**는 뜻이라 표준 리뷰타입이 아니다.
 *   모집공고 모달의 `자율리뷰` 칩도 `data-val=""`(= 지정하지 않음)이고, 작업오더를 거쳐
 *   `tab_configs.review_type` 에 이 문자열이 그대로 남는 탭이 있다(2026-08-23 운영 실측 4건).
 *
 * ★ **판정은 그대로 null 이다**(= 오늘 동작 그대로 · 리뷰 화면 기대) — 여기서 유형을 만들어
 *   내면 검수·캡처 슬롯이 있지도 않은 기대를 갖는다. 이 값은 **표기 전용**이다:
 *   사람이 그렇게 적어 뒀는데 화면이 "미설정"이라고 말하면 거짓이 된다(혼합과 같은 자리).
 */
const FREE_CHOICE_REVIEW_LABEL = '자율리뷰';
/** 이 값이 '자율리뷰'인가 — 표기 전용(판정에는 쓰지 않는다). */
function isFreeChoiceReviewType(raw) {
  return String(raw == null ? '' : raw).trim() === FREE_CHOICE_REVIEW_LABEL;
}

/**
 * ★ 리뷰타입 칸에 잘못 들어가 있던 **배송유형** 값.
 *   판정에서는 무시(null)하되, 화면 표시와 이관 대상 판별에는 이 목록을 쓴다.
 *   (자동 이관은 `delivery_type` 이 비어 있을 때만 — 접수가 채운 값을 덮으면 안 된다)
 */
const LEGACY_DELIVERY_VALUES = ['실배송', '빈박스', '택배발송대행'];

/** key → label. 모르는 key 는 빈 문자열. */
function reviewTypeLabel(key) {
  const hit = REVIEW_TYPES.find(t => t.key === key);
  return hit ? hit.label : '';
}

/**
 * 자유 문자열 → 표준 key.
 *
 * 받는 값이 제각각이다:
 *   · 인트라넷 단일  : `포토` `구매확정`
 *   · 인트라넷 혼합  : `혼합(포토 10건, 텍스트 20건, 구매확정 0건, 별점 0건)`
 *   · 옛 탭 설정     : `믹스`(=혼합) · `실배송`/`빈박스`(=배송유형, 리뷰타입 아님)
 *   · 시트 작업옵션  : `포토리뷰` `텍스트` `구매확정`
 *   · 이미 표준화됨  : `confirm` 같은 key 자체
 *
 * @returns {string|null} REVIEW_TYPE_KEYS 중 하나, 또는 판정 불가 시 null
 */
function normalizeReviewType(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  // 이미 key 로 저장된 값(공고 컬럼)은 그대로 통과
  if (REVIEW_TYPE_KEYS.includes(s)) return s;

  // ★ 혼합을 **먼저** 본다 — `혼합(포토 10건, …)` 은 '포토'도 함께 포함하므로
  //   단일 유형 검사가 앞서면 포토로 오판한다.
  if (/혼합|믹스|mixed|mix/i.test(s)) return 'mixed';

  // ★ '구매확정'을 '포토'보다 먼저 — 둘 다 든 문자열이면 혼합에서 이미 걸렸고,
  //   여기 오는 값은 단일이라 순서가 결과를 바꾸지 않지만 의도를 고정해 둔다.
  if (/구매\s*확정|purchase_?confirm|confirm/i.test(s)) return 'confirm';
  if (/포토|사진|photo/i.test(s)) return 'photo';
  if (/별점|평점|star/i.test(s)) return 'star';
  if (/텍스트|text/i.test(s)) return 'text';

  // ★ 실배송·빈박스는 배송유형이지 리뷰타입이 아니다 → 판정 불가(null)
  return null;
}

/** 이 값이 리뷰타입 칸에 잘못 들어간 배송유형인가(이관 대상 판별용). */
function isLegacyDeliveryValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return LEGACY_DELIVERY_VALUES.includes(s);
}

const _int = (v) => {
  // ★ `Number('')===0` · `Number(null)===0` 이라 가드 없이 접으면 "값 없음"이 0건으로 둔갑한다
  //   (리뷰비 구간표에서 실제로 밟은 함정).
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * 작업오더의 `review_type` 문자열 파싱.
 * 혼합이면 유형별 건수까지 뽑는다(관리자 화면 안내용 — 판정에는 쓰지 않는다).
 *
 * ★ 건수는 **참고 정보**다. 어느 행이 무슨 유형인지는 건수로 알 수 없고
 *   시트 작업옵션 칸(행별 리뷰형태)만이 답할 수 있다(`resolveReviewType` 참조).
 *
 * @returns {{type:string|null, mixed:boolean, counts:Object<string,number>}}
 */
function parseWorkOrderReviewType(raw) {
  const type = normalizeReviewType(raw);
  const out = { type, mixed: type === 'mixed', counts: {} };
  if (!out.mixed) return out;

  const s = String(raw == null ? '' : raw);
  for (const t of REVIEW_TYPES) {
    if (t.key === 'mixed') continue;
    // `포토 10건` · `구매확정 0건` — 라벨 뒤에 붙은 숫자만 읽는다
    const m = s.match(new RegExp(t.label + '\\s*([0-9,]+)\\s*건'));
    const n = m ? _int(m[1]) : null;
    if (n != null) out.counts[t.key] = n;
  }
  return out;
}

/**
 * 이 **행**의 리뷰타입 — 판정 우선순위 (사용자 확정).
 *
 *   ① 시트 작업옵션 칸(행별 리뷰형태)  ② 공고 리뷰타입  ③ 탭 설정 리뷰타입
 *
 * ★★ ①이 최우선인 이유: 혼합 오더(포토 10 + 구매확정 5)에서 **어느 행이 무슨 유형인지는
 *   시트에만 적혀 있다**. 공고·탭 값으로 판정하면 혼합 오더 전원이 같은 유형이 된다.
 * ★ 공고·탭 값이 `mixed` 면 그 자체로는 행을 결정하지 못한다 → 행 값이 없으면 null
 *   (= 오늘 동작 그대로). "혼합이니까 일단 리뷰"로 접으면 구매확정 행이 리뷰로 잘못 검수된다.
 *
 * @param {object} p
 * @param {string} [p.rowOption]      그 행의 작업옵션 칸 값(예 '구매확정' · '포토리뷰')
 * @param {string} [p.campaignType]   recruit_campaigns.review_type
 * @param {string} [p.tabReviewType]  tab_configs.review_type
 * @returns {string|null}
 */
function resolveReviewType({ rowOption, campaignType, tabReviewType } = {}) {
  const row = normalizeReviewType(rowOption);
  if (row && row !== 'mixed') return row;          // ① 행이 말하면 그것이 답

  const camp = normalizeReviewType(campaignType);
  if (camp && camp !== 'mixed') return camp;       // ② 공고

  const tab = normalizeReviewType(tabReviewType);
  if (tab && tab !== 'mixed') return tab;          // ③ 탭

  return null;                                      // 혼합뿐이거나 미지정 → 판정 없음
}

/** 이 행이 구매확정 작업인가 — 슬롯 치환·AI 검수 분기의 유일한 질문. */
function isPurchaseConfirm(p) {
  return resolveReviewType(p) === 'confirm';
}

module.exports = {
  REVIEW_TYPES, REVIEW_TYPE_KEYS, REVIEW_TYPE_LABELS, REVIEW_TYPE_SHEET_LABELS, LEGACY_DELIVERY_VALUES,
  FREE_CHOICE_REVIEW_LABEL, isFreeChoiceReviewType,
  reviewTypeLabel, normalizeReviewType, isLegacyDeliveryValue, isReviewOptionHeader, rowOptionReviewType,
  parseWorkOrderReviewType, resolveReviewType, isPurchaseConfirm,
};
