/**
 * 택배송장 열 판정 — **단일 출처**.
 *
 * 이 정규식은 세 곳이 함께 쓴다: ① 광고주 노출 화이트리스트(_ADV_COL_RULES) ② 작업표 생성의
 * 택배발송대행 자동 열(worktablePlan) ③ **광고주 셀 편집 게이트**(trackB.routes). 사본을 두면
 * "업체 화면에는 보이는데 저장은 거부"처럼 화면과 서버가 갈린다.
 *
 * ★ 넓히지 말 것 — `택배`+`송장` 조합만 정확히 허용한다(전체문자열 앵커). 넓히면 '배송비고'
 *   같은 자유텍스트 열까지 업체가 덮어쓸 수 있게 된다(막으려던 것보다 큰 손실).
 */
const TRACKING_HEADER_RE = /^\s*택배\s*송장\s*(?:번호)?\s*(?:\([^()]{1,60}\))?\s*$/;

function isTrackingHeader(header) {
  return TRACKING_HEADER_RE.test(String(header == null ? '' : header));
}

// 그리드 편집 필드는 `col:<시트헤더>` 형태다(물리필드·커스텀열 `ccol:` 은 대상 아님).
function isTrackingField(field) {
  const s = String(field == null ? '' : field);
  return s.indexOf('col:') === 0 && isTrackingHeader(s.slice(4));
}

module.exports = { TRACKING_HEADER_RE, isTrackingHeader, isTrackingField };
