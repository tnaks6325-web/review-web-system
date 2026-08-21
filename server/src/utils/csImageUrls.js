/**
 * csImageUrls.js — C/S 메시지 첨부 이미지 URL 화이트리스트의 **단일 출처**.
 *
 * 이 값은 리뷰어·관리자 대화창에 그대로 `<img src>` 로 나가므로, 임의 주소가 실리면
 * 외부 추적·피싱 이미지가 우리 화면에서 로드된다. 그래서 **우리 프록시 주소만** 통과시킨다.
 *
 * ★ 규칙 사본 금지 — 종전엔 `cs.routes`·`reviewer.routes` 두 곳에 같은 정규식이 복사돼 있었다.
 *   한쪽만 넓히면 그 경로로 임의 URL 이 들어온다(같은 표를 두 곳이 쓰던 다른 사고들과 같은 자리).
 * ★ `https?` 둘 다 허용 — `PUBLIC_API_URL` 이 http 인 배포에서 첨부가 조용히 사라지는 것 방지
 *   (작업내용 첨부 이미지 정화와 같은 판단).
 * ★ 상한 5장(리뷰어·관리자 동일).
 */
const MAX = 5;
const RE = /^https?:\/\/[^\s"'<>]+\/api\/order\/guide-image\/[-\w]{20,}$/;

function sanitizeCsImageUrls(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (const raw of arr.slice(0, MAX)) {
    const s = String(raw || '').trim();
    if (!RE.test(s)) continue;
    out.push(s);
  }
  return out;
}

module.exports = { sanitizeCsImageUrls, MAX };
