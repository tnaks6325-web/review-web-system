-- 087: 모집공고 리뷰타입(포토·텍스트·구매확정·별점·혼합)
--
-- 배경: 인트라넷 발주 폼의 **리뷰타입**은 `work_orders.review_type`(019)까지는 도착하지만
--   거기서 끊긴다. 접수가 `tab_configs.review_type` 에 복사할 뿐, **모집공고에는 그 개념이 없다**.
--   그래서 담당자가 공고에서 "이 공고는 구매확정 작업"이라고 지정할 방법이 없고,
--   리뷰어 제출 슬롯·AI 검수도 무엇을 기대해야 하는지 알 수 없다.
--
-- ★ 값은 `utils/reviewType.js` 의 표준 key(photo·text·confirm·star·mixed).
--   판정 규칙(문자열 → key, 행별 우선순위)은 전부 그 파일 하나가 갖는다 — 여기엔 CHECK 를 걸지 않는다.
--   ① 판정을 두 곳(코드 + DB 제약)에 두면 어휘가 늘 때마다 마이그레이션이 따라붙어야 하고
--   ② 제약 위반은 **공고 저장 실패**(500)로 나타나는데, 리뷰타입은 저장을 막을 만큼 중요한 값이 아니다.
--   모르는 값은 판정에서 null 로 떨어져 "오늘 동작 그대로"가 된다(fail-open).
--
-- ★ NULL = 미지정 = **기존 공고 전부 동작 불변**(신규 컬럼 추가만, 백필 없음). opt-in.
-- ★ 타입 TEXT — 082 의 42804 사고(UUID 로 선언해 FK 가 거부되며 파일 전체가 롤백)와 같은 계열의
--   함정을 피하려면 참조·비교 대상과 타입을 맞춰야 한다. `tab_configs.review_type` 도 TEXT 다.
-- ★ 되돌리기: 이 컬럼을 DROP 하면 원복(다른 테이블·데이터 무영향).
--
-- ⚠ 여기서 **하지 않는 것**: `tab_configs.review_type` 에 남아 있는 옛 값(실배송·빈박스·믹스) 정리.
--   그건 기존 행을 건드리는 작업이라 자동 마이그레이션으로 돌리지 않고,
--   미리보기(dryRun) 가 기본인 관리자 엔드포인트 `POST /api/diag/review-type-cleanup` 로 분리했다.

ALTER TABLE recruit_campaigns
  ADD COLUMN IF NOT EXISTS review_type TEXT;

COMMENT ON COLUMN recruit_campaigns.review_type IS
  '리뷰타입 — utils/reviewType.js 의 표준 key(photo|text|confirm|star|mixed). NULL=미지정(기존 동작). 행별 최종 판정은 시트 작업옵션 칸 > 이 값 > tab_configs.review_type 순서.';
