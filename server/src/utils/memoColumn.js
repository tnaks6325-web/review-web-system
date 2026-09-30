// ═══════════════════════════════════════════════════════════════════════════
// 리뷰 제출 memo(비고 / 포스팅URL)가 들어갈 열 고르기 — **판정 단일 출처**
//
// 소비처 셋이 같은 규칙을 써야 한다:
//   ① `POST /api/submit/review` 배경 시트 쓰기   ② 그 실패분을 다시 쓰는 큐(`review_submit`)
//   ③ 무시트 탭의 작업표 칸 기록
// 셋이 갈라지면 **처음 제출은 포스팅 칸에, 재시도는 비고 칸에** 들어가는 식으로 값이 흩어진다.
//
// ★★ 블로그체험단은 우선순위가 **뒤집힌다**: 결과물이 포스팅URL 이므로 `포스팅` 칸이 먼저다.
//   (바를참스킨 기존 시트는 「비고(닉네임)」 열을 결과물 칸으로 대용해 왔으므로 폴백은 유지 —
//    폴백을 없애면 그 탭의 기존 기록 위치가 바뀐다.)
// ★ 리뷰체험단(기본·판정 불가 포함)은 **종전 순서 그대로**(`비고` → `포스팅`) = 무회귀.
// ═══════════════════════════════════════════════════════════════════════════

const MEMO_RE = /비고/;
const POST_RE = /포스팅/;

/**
 * '포스팅제출일' 계열 헤더인가 — **URL 칸과 날짜 칸을 가른다**(127 필수 3열).
 * ★★ 이 판정이 없으면 blog 의 memo(포스팅URL) 열 고르기(/포스팅/ 첫 매칭)가
 *   '포스팅제출일' 이 왼쪽에 있을 때 **URL 을 날짜 칸에 쓴다**. 반대로 날짜 스탬프가
 *   '포스팅결과URL' 칸을 밟으면 결과물이 날짜로 덮인다 — 두 방향 모두 이 함수 하나로 막는다.
 * ★ 'URL'·'링크' 가 든 헤더는 날짜 칸이 아니다(예: '포스팅결과URL').
 */
function isPostDateHeader(h) {
  const s = String(h == null ? '' : h).replace(/\s+/g, '');
  if (/url|링크/i.test(s)) return false;
  return /포스팅/.test(s) && /일/.test(s);
}

/**
 * @param {string[]} headers  시트/작업표 열 이름 줄
 * @param {{blog?:boolean}} [opts] blog=true 면 포스팅 칸 우선
 * @returns {number} 열 인덱스(못 찾으면 -1)
 */
function pickMemoColumnIndex(headers, { blog = false } = {}) {
  const hs = (Array.isArray(headers) ? headers : []).map(h => String(h == null ? '' : h).trim());
  // ★ 포스팅 칸 후보에서 날짜 칸(포스팅제출일)은 제외 — URL 이 날짜 칸에 들어가지 않게.
  const findPost = () => hs.findIndex(h => POST_RE.test(h) && !isPostDateHeader(h));
  const findMemo = () => hs.findIndex(h => MEMO_RE.test(h));
  for (const find of (blog ? [findPost, findMemo] : [findMemo, findPost])) {
    const i = find();
    if (i >= 0) return i;
  }
  return -1;
}

/** 열 이름 자체가 필요할 때(무시트 작업표는 인덱스가 아니라 헤더명으로 쓴다) */
function pickMemoColumnName(headers, opts) {
  const i = pickMemoColumnIndex(headers, opts);
  if (i < 0) return '';
  return String((headers || [])[i] == null ? '' : headers[i]).trim();
}

/** 포스팅제출일 칸(127 — blog 제출 완료 시 시스템이 날짜를 자동 기록). 못 찾으면 -1. */
function pickPostDateColumnIndex(headers) {
  const hs = (Array.isArray(headers) ? headers : []).map(h => String(h == null ? '' : h).trim());
  return hs.findIndex(h => isPostDateHeader(h));
}

function pickPostDateColumnName(headers) {
  const i = pickPostDateColumnIndex(headers);
  if (i < 0) return '';
  return String((headers || [])[i] == null ? '' : headers[i]).trim();
}

module.exports = {
  pickMemoColumnIndex, pickMemoColumnName,
  pickPostDateColumnIndex, pickPostDateColumnName, isPostDateHeader,
  MEMO_RE, POST_RE,
};
