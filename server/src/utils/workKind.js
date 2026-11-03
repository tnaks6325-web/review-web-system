/**
 * workKind.js — **작업유형(체험단 종류) 판정의 단일 출처**.
 *
 * 리뷰체험단(review) / 블로그체험단(blog) / Q&A체험단(qna) 은 진행 방식 자체가 다르다:
 *   · 리뷰 : 구매일자를 미리 깔아 두고 그 날짜만큼 모집 → 결과물 = 리뷰 캡처
 *   · 블로그: 구매일자를 **미리 정할 수 없다**(모집된 사람이 생기면 그때 구매) → 결과물 = 포스팅URL
 *   · Q&A  : **구매하지 않는다** — 상품 페이지에 문의(공개/비공개)만 남긴다 → 결과물 = 문의 화면 캡처,
 *            입금 = 참여비만. 주문번호·주소·연락처 입력 없음(연락처는 로그인 계정 값만 내부에서 쓴다).
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
];

const WORK_KIND_KEYS = WORK_KINDS.map(k => k.key);
const WORK_KIND_LABELS = WORK_KINDS.map(k => k.label);

/** 기본값 — 미지정·판정 실패는 전부 리뷰체험단(기존 동작). */
const DEFAULT_WORK_KIND = 'review';

/** Q&A 표기 — `Q&A` `Q/A` `QnA` `큐앤에이` `문의등록`(공백 허용). */
const QNA_PATTERN = /q\s*[&\/]\s*a|\bqna\b|큐앤에이|문의\s*등록/i;

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
 *
 * ★ 어느 쪽으로도 안 읽히면 **`'review'`**(기본) — 여기서 null 을 돌려주면 호출부마다
 *   "모를 때 무엇으로 볼지"를 다시 정하게 되고 그 판단이 갈린다.
 * ★ 블로그를 먼저 본다 — 블로그 판정은 Q&A 이전부터 있던 규칙이라 그 답이 바뀌면 안 된다.
 *   Q&A 는 **확실한 표기만** 잡는다(`qa` 처럼 짧은 낱말은 다른 글자에 섞여 오탐한다).
 *
 * @returns {'review'|'blog'|'qna'}
 */
function normalizeWorkKind(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return DEFAULT_WORK_KIND;

  // 이미 key 로 저장된 값은 그대로 통과
  if (WORK_KIND_KEYS.includes(s)) return s;

  if (/블로그|blog/i.test(s)) return 'blog';
  if (QNA_PATTERN.test(s)) return 'qna';
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
 * @returns {'review'|'blog'|'qna'}
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
 * @returns {''|'review'|'blog'|'qna'}
 */
function workKindForStore(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return normalizeWorkKind(s);
}

module.exports = {
  WORK_KINDS, WORK_KIND_KEYS, WORK_KIND_LABELS, DEFAULT_WORK_KIND,
  workKindLabel, normalizeWorkKind, isBlogKind, isQnaKind, resolveWorkKind, workKindForStore,
};
