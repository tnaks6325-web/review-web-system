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
 * @param {string[]} headers  시트/작업표 열 이름 줄
 * @param {{blog?:boolean}} [opts] blog=true 면 포스팅 칸 우선
 * @returns {number} 열 인덱스(못 찾으면 -1)
 */
function pickMemoColumnIndex(headers, { blog = false } = {}) {
  const hs = (Array.isArray(headers) ? headers : []).map(h => String(h == null ? '' : h).trim());
  const order = blog ? [POST_RE, MEMO_RE] : [MEMO_RE, POST_RE];
  for (const re of order) {
    const i = hs.findIndex(h => re.test(h));
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

module.exports = { pickMemoColumnIndex, pickMemoColumnName, MEMO_RE, POST_RE };
