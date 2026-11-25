/**
 * workKind.js — **작업유형(체험단 종류) 판정의 단일 출처**.
 *
 * 리뷰체험단(review) / 블로그체험단(blog) / Q&A체험단(qna) / 네이버예약리뷰(booking) 는 진행 방식 자체가 다르다:
 *   · 리뷰 : 구매일자를 미리 깔아 두고 그 날짜만큼 모집 → 결과물 = 리뷰 캡처
 *   · 블로그: 구매일자를 **미리 정할 수 없다**(모집된 사람이 생기면 그때 구매) → 결과물 = 포스팅URL
 *   · Q&A  : **구매하지 않는다** — 상품 페이지에 문의(공개/비공개)만 남긴다 → 결과물 = 문의 화면 캡처,
 *            입금 = 참여비만. 주문번호·주소·연락처 입력 없음(연락처는 로그인 계정 값만 내부에서 쓴다).
 *   · 네이버예약리뷰(booking, 결정 404): 매장을 **네이버 예약**으로 방문하고 방문 리뷰를 남긴다 — 택배·상품 옵션·
 *            주문번호·주소 없음. 제출 = 예약내역 캡처(구매양식 자리) → 이용 뒤 리뷰 캡처.
 *            ★ 1단계는 **알아보기만** 한다 — 2~5단계(날짜 자리표·리뷰어 화면·검수·입금)가 없는 동안에는 저장 입구가
 *              `isWorkKindReady` 로 거절한다(`NOT_READY_WORK_KINDS` · fail-closed). 그 단계가 생기면 목록에서 뺀다.
 *
 * ★★ 이것은 리뷰타입(포토·텍스트·구매확정·별점·혼합)과 **다른 축**이다(사용자 확정 2026-08-10).
 *   리뷰타입은 "리뷰를 어떤 형태로 쓰는가"이고 여기는 "무슨 체험단인가"다.
 *   블로그 작업에는 리뷰타입이 없다 — `resolveWorkKind` 가 blog 를 돌려주면 리뷰타입 판정은
 *   호출부에서 통째로 건너뛴다(캡처 슬롯·AI 검수가 블로그 작업에 개입하지 않게).
 *
 * ★★ **빈 값 = 리뷰체험단**(`'review'`) — 기존 데이터 전부가 그대로 현행 동작이다(opt-in).
 *   그래서 이 파일은 "판정 불가 → null" 규율(reviewType)이 아니라 **항상 값을 돌려준다**:
 *   블로그는 명시적으로 지정해야만 되고, 모르면 지금까지 하던 대로(리뷰) 간다.
 *
 * ⚠ 작업표 표준 열의 "작업유형"(`worktable.service.WORK_TYPE_TRIGGERS` — 상품옵션·택배대행 등
 *   *열 구성*을 고르는 개념)과는 **별개**다. 화면 표기는 「체험단 종류」로 통일해 혼동을 막는다.
 */

/** 표준 작업유형 — key 는 저장·판정용, label 은 화면·인트라넷 폼에 쓰이는 한국어. */
const WORK_KINDS = [
  { key: 'review', label: '리뷰체험단' },
  { key: 'blog',   label: '블로그체험단' },
  { key: 'qna',    label: 'Q&A체험단' },
  { key: 'booking', label: '네이버예약리뷰' },   // 결정 404 — 영수증리뷰는 나중에 따로(지금 넣지 않는다)
];

const WORK_KIND_KEYS = WORK_KINDS.map(k => k.key);
const WORK_KIND_LABELS = WORK_KINDS.map(k => k.label);

/** 기본값 — 미지정·판정 실패는 전부 리뷰체험단(기존 동작). */
const DEFAULT_WORK_KIND = 'review';

/** Q&A 표기 — `Q&A` `Q/A` `QnA` `큐앤에이` `문의등록`(공백 허용). */
const QNA_PATTERN = /q\s*[&\/]\s*a|\bqna\b|큐앤에이|문의\s*등록/i;

/** 네이버예약리뷰 표기 — `네이버예약리뷰` `네이버 예약 리뷰` `예약자 리뷰` `예약리뷰`(붙여 쓴 것만) `booking`.
 *  ★ 맨 「예약」은 잡지 않는다 — 예약구매·사전예약처럼 상품 리뷰 작업 글에도 흔히 섞인다.
 *    띄어 쓴 `예약 리뷰` 도 잡지 않는다(`사전예약 리뷰체험단` = 예약판매 상품의 리뷰) — 띄어 쓰려면 앞에 「네이버」가 있어야 한다.
 *    영문은 낱말 경계(`rebooking`·`bookings` 는 아님). 인트라넷(6단계)은 코드값 `booking` 만 보낸다 — 규칙을 넓히지 않는다. */
const BOOKING_PATTERN = /네이버\s*예약\s*리뷰|예약자\s*리뷰|예약리뷰|\bbooking\b/i;

/**
 * ★★ 아직 리뷰웹이 끝까지 진행하지 못하는 종류 — **알아보되 저장하지 않는다**(결정 404 · 완화 금지).
 *   판정에서 빼 두면 `normalizeWorkKind` 가 조용히 review 로 접어 상품 리뷰 작업(구매양식·상품 리뷰 검수)이 깔린다.
 *   그래서 판정은 하고, 저장 입구(인트라넷 접수·원본 수정·옛 수정 · 관리자 공고 만들기·고치기)가 쓰기 전에 거절한다.
 *   그 종류의 단계(자리표·리뷰어 화면·검수·입금)가 모두 생기면 여기서 뺀다 — 그 전에 빼지 않는다.
 * ★ 결정 414(2026-11-25) — 네이버예약리뷰(booking)는 2~5단계(407·409·412·411)와 접수 뒤 수정 잠금이 다 생겨 뺐다(개방).
 *   목록·판정(`isWorkKindReady`)·거절 본문은 **다음 새 종류(영수증리뷰 등)를 위해 그대로 둔다** — 빈 목록 = 모두 준비됨.
 *   새 종류를 판정에 넣을 때는 여기에 먼저 넣고 시작한다(결정 404 와 같은 순서).
 */
const NOT_READY_WORK_KINDS = [];

/** key → label. 모르는 key 는 빈 문자열. */
function workKindLabel(key) {
  const hit = WORK_KINDS.find(k => k.key === key);
  return hit ? hit.label : '';
}

/**
 * 자유 문자열 → 표준 key.
 *
 * 받는 값이 제각각이다:
 *   · 인트라넷 폼   : `블로그체험단` `리뷰체험단` `Q&A체험단`
 *   · 코드값        : `blog` `review` `qna`
 *   · 사람이 적은 값: `블로그` `블로그 체험단` `네이버 블로그` / `Q&A` `Q/A 등록` `QnA` `문의등록`
 *                     / `네이버예약리뷰` `예약자 리뷰` `예약리뷰`
 *
 * ★ 어느 쪽으로도 안 읽히면 **`'review'`**(기본) — 여기서 null 을 돌려주면 호출부마다
 *   "모를 때 무엇으로 볼지"를 다시 정하게 되고 그 판단이 갈린다.
 * ★ 블로그를 먼저 본다 — 블로그 판정은 Q&A 이전부터 있던 규칙이라 그 답이 바뀌면 안 된다.
 *   Q&A 는 **확실한 표기만** 잡는다(`qa` 처럼 짧은 낱말은 다른 글자에 섞여 오탐한다).
 *
 * @returns {'review'|'blog'|'qna'|'booking'}
 */
function normalizeWorkKind(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return DEFAULT_WORK_KIND;

  // 이미 key 로 저장된 값은 그대로 통과
  if (WORK_KIND_KEYS.includes(s)) return s;

  if (/블로그|blog/i.test(s)) return 'blog';
  if (QNA_PATTERN.test(s)) return 'qna';
  // ★ 네이버예약리뷰는 맨 뒤(결정 404) — 블로그·Q&A 답은 그대로 두고, 「모르면 리뷰」로 떨어지던 표기에서만 가져온다.
  if (BOOKING_PATTERN.test(s)) return 'booking';
  return DEFAULT_WORK_KIND;
}

/** 명시적으로 블로그로 지정된 값인가 — "빈 값"과 "리뷰 지정"을 구분할 필요가 없는 곳의 지름길. */
function isBlogKind(raw) {
  return normalizeWorkKind(raw) === 'blog';
}

/** Q&A체험단인가 — 구매·배송·리뷰타입이 없는 작업. 모르면 false(= 종전 경로). */
function isQnaKind(raw) {
  return normalizeWorkKind(raw) === 'qna';
}

/** 네이버예약리뷰인가 — 택배·상품 옵션·리뷰타입이 없는 매장 방문 작업(결정 404). 모르면 false(= 종전 경로). */
function isBookingKind(raw) {
  return normalizeWorkKind(raw) === 'booking';
}

/**
 * 이 종류를 지금 저장해도 되나 — 빈 값·리뷰·블로그·Q&A·모르는 값 = true(종전 그대로), `NOT_READY_WORK_KINDS` = false.
 * ★ 저장 입구는 **아무것도 쓰기 전에** 이것을 본다(결정 404 · fail-closed).
 */
function isWorkKindReady(raw) {
  return !NOT_READY_WORK_KINDS.includes(normalizeWorkKind(raw));
}

/**
 * 저장 입구의 거절 응답 본문(409) — 인트라넷은 `error` 를 실패 사유로 그대로 보여 주고 `code` 를 넘긴다
 * (자동 재전송 없음 · 같은 번호로 다시 보낼 수 있다). 문구는 "무엇을 하면 되는지"까지.
 */
function workKindNotReadyBody(raw) {
  const label = workKindLabel(normalizeWorkKind(raw)) || '이 체험단 종류';
  return {
    ok: false, code: 'work_kind_not_ready', blocked_fields: ['work_kind'],
    error: `${label}는 아직 리뷰웹에서 진행할 수 없습니다(준비 중). 아무것도 저장하지 않았습니다 — 다른 체험단 종류로 바꿔 다시 보내 주세요.`,
  };
}

/**
 * 이 **작업(탭)** 의 체험단 종류 — 판정 우선순위.
 *
 *   ① 공고 `recruit_campaigns.work_kind`  ② 탭 `tab_configs.work_kind`
 *
 * ★ 공고가 우선인 이유 = 리뷰타입(`resolveReviewType`)과 같다. 공고는 그 차수의 진행 방식을
 *   가장 최근에 확정한 값이고, 탭 값은 접수 시점(blank-only)에 한 번 채워진 기본값이다.
 * ★ 행 단위 판정은 없다 — 한 탭 안에서 리뷰/블로그가 섞이지 않는다(섞이면 시트 열 구성 자체가
 *   달라진다). 그래서 시트 행 옵션 칸은 보지 않는다.
 *
 * @param {object} p
 * @param {string} [p.campaignKind]  recruit_campaigns.work_kind
 * @param {string} [p.tabKind]       tab_configs.work_kind
 * @returns {'review'|'blog'|'qna'|'booking'}
 */
function resolveWorkKind({ campaignKind, tabKind } = {}) {
  const camp = String(campaignKind == null ? '' : campaignKind).trim();
  if (camp) return normalizeWorkKind(camp);

  const tab = String(tabKind == null ? '' : tabKind).trim();
  if (tab) return normalizeWorkKind(tab);

  return DEFAULT_WORK_KIND;
}

/**
 * 저장용 정규화 — **빈 값은 빈 값으로 둔다**(`''`).
 *
 * ★★ `normalizeWorkKind` 와 다른 이유: 저장 시점에 미전송(구버전 인트라넷·리뷰타입 칸 없는
 *   축약 화면)을 `'review'` 로 굳혀 버리면 "한 번도 정하지 않음"과 "리뷰로 정함"을 구분할 수
 *   없게 되고, blank-only 전파(`COALESCE(NULLIF(...))`)가 통째로 무력화된다.
 *   판정에서는 어차피 빈 값 = review 라 동작은 같고, 원장만 정직해진다.
 *
 * @returns {''|'review'|'blog'|'qna'|'booking'}
 */
function workKindForStore(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return normalizeWorkKind(s);
}

module.exports = {
  WORK_KINDS, WORK_KIND_KEYS, WORK_KIND_LABELS, DEFAULT_WORK_KIND, NOT_READY_WORK_KINDS,
  workKindLabel, normalizeWorkKind, isBlogKind, isQnaKind, isBookingKind, resolveWorkKind, workKindForStore,
  isWorkKindReady, workKindNotReadyBody,
};
